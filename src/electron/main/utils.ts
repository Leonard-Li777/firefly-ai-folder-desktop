import { BrowserWindow, net } from 'electron'
import {
  logger,
  LogCategory,
  ErrorNormalizer,
  parseSizeToGB,
  getAccelerationTier
} from '@firefly/shared'
import { AIServiceStatus } from '@firefly/types'
import { hardwareDetectionService } from '../runtime-services/system/hardware-detection-service'
import { ConfigOrchestrator } from '../config/config-orchestrator'
import { LlamaModelManager } from '../runtime-services'
import { LicenseService, LicenseStatus } from '../runtime-services/system/license-service'
import { unifiedModelManager } from '../runtime-services/llama/unified-model-manager'
import { llamaEngineService } from '../runtime-services/llama/llama-engine-service'
import * as path from 'path'
import { activeHardwareBackendCache, setActiveHardwareBackendCache } from './state'

// In-memory cache for enrichAIStatus lookup results
interface EnrichCacheEntry {
  timestamp: number
  data: {
    error: any
    modelMode: string | null
    modelName: string | null
    vramRequiredGB?: number
    totalSizeBytes?: number
    provider: string | null
    backend?: string
    bestAcceleration?: string
  }
}

const enrichCache = new Map<string, EnrichCacheEntry>()

/**
 * 显式清空 enrichCache 缓存
 */
export function clearEnrichCache(): void {
  enrichCache.clear()
  setActiveHardwareBackendCache(null)
}

// 配置变更时同时清除 enrichCache 和 activeHardwareBackendCache，确保切换引擎模式后立即生效
try {
  ConfigOrchestrator.getInstance().onConfigChange(() => {
    logger.debug(LogCategory.MAIN, '[enrichAIStatus] 配置变更，清除 AI 状态缓存及硬件后端缓存')
    clearEnrichCache()
  })
} catch (e) {
  logger.warn(LogCategory.MAIN, '[enrichAIStatus] 绑定配置变更监听失败:', e)
}

/**
 * 校验授权状态并通知渲染进程
 */
export async function checkLicenseAndNotify(force = false) {
  const license = await LicenseService.getInstance().checkLicenseStatus(force)
  if (license.status !== LicenseStatus.AUTHORIZED) {
    BrowserWindow.getAllWindows().forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('license:unauthorized', license)
      }
    })
  }
  return license
}

/**
 * 获取当前推荐的"最佳可用加速引擎"参考值
 * 取记忆的最佳引擎（BEST_ACCELERATION，成功验证过）与硬件检测支持的最佳引擎中的较优者，
 * 用于前端警告"当前引擎非最佳可用引擎"。
 */
export async function getBestAvailableAcceleration(): Promise<string> {
  try {
    const remembered = ConfigOrchestrator.getInstance().getValue<string>('BEST_ACCELERATION')
    const hardwareBest = await hardwareDetectionService.getBestAccelerationTier()
    if (getAccelerationTier(hardwareBest) > getAccelerationTier(remembered)) {
      return hardwareBest
    }
    return remembered || 'auto'
  } catch (e) {
    logger.warn(LogCategory.MAIN, '获取最佳可用引擎失败，回退为 auto:', e)
    return 'auto'
  }
}

/**
 * 获取当前活跃的硬件加速后端描述字符串
 */
export async function getActiveHardwareBackend(): Promise<string> {
  // 强制 CPU 模式下直接返回 CPU 描述，不写入缓存（保证下次切换模式能重新计算）
  const isForceCpuMode = ConfigOrchestrator.getInstance().getValue<boolean>(
    'AI_ENGINE_FORCE_CPU_MODE'
  )
  if (isForceCpuMode) {
    const resources = await hardwareDetectionService.detectSystemResources()
    const primaryGPU = resources.gpus[0]
    const vendor = primaryGPU ? primaryGPU.vendor.toUpperCase() : 'CPU'
    return `${vendor}(cpu)`
  }

  if (activeHardwareBackendCache) return activeHardwareBackendCache

  try {
    const orchestrator = ConfigOrchestrator.getInstance()
    const isCompatibleMode = orchestrator.getValue<boolean>('AI_ENGINE_DRIVER_COMPATIBLE_MODE')
    const resources = await hardwareDetectionService.detectSystemResources()

    // 优先从配置决定 tier：引擎未重启时 selectedAcceleration 还是旧值，不可靠
    // 兼容模式 → vulkan；否则从引擎运行时或硬件最佳值取
    let tier: string
    if (isCompatibleMode) {
      tier = 'vulkan'
    } else {
      const selectedAcc = llamaEngineService.getSelectedAcceleration()
      tier = selectedAcc || (await hardwareDetectionService.getBestAccelerationTier())
    }

    if (tier === 'cpu') {
      const primaryGPU = resources.gpus[0]
      const vendor = primaryGPU ? primaryGPU.vendor.toUpperCase() : 'CPU'
      const result = `${vendor}(cpu)`
      setActiveHardwareBackendCache(result)
      return result
    }

    const gpu = resources.gpus.find(g => {
      switch (tier) {
        case 'cuda':
          return g.supportsCUDA
        case 'sycl':
          return g.supportsSycl
        case 'metal':
          return g.supportsMetal
        case 'hip':
          return g.supportsHip
        case 'rocm':
          return g.supportsHip
        case 'vulkan':
          return g.supportsVulkan
        case 'openvino':
          return false // CPU 优化，无对应 GPU
        default:
          return false
      }
    })

    const vendorMap: Record<string, string> = {
      nvidia: 'NVIDIA',
      amd: 'AMD',
      intel: 'INTEL',
      apple: 'APPLE'
    }

    const primaryGpu = resources.gpus[0]
    const matchedVendor = gpu ? gpu.vendor : primaryGpu ? primaryGpu.vendor : 'UNKNOWN'

    const vendor = vendorMap[matchedVendor.toLowerCase()] || matchedVendor.toUpperCase()
    const result = `${vendor}(${tier})`
    setActiveHardwareBackendCache(result)
    return result
  } catch (e) {
    logger.warn(LogCategory.MAIN, '获取硬件后端失败，回退到默认描述:', e)
    return 'UNKNOWN(cpu)'
  }
}

/**
 * 增强 AI 状态信息，将 ID 转换为友好名称
 */
export const enrichAIStatus = async (info: any) => {
  if (!info) {
    return {
      modelName: null,
      modelMode: 'local' as const,
      provider: null,
      loading: false,
      status: 'stopped',
      error: null,
      capabilities: null
    }
  }

  const rawLanguage =
    ConfigOrchestrator.getInstance().getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN'
  const language = rawLanguage.startsWith('zh') ? 'zh-CN' : rawLanguage

  // Create a stable cache key based on model identity AND engine config
  // (exclude status/loading to avoid frequent cache invalidation from health checks
  // and status transitions; include engine config so engine switching invalidates cache)
  const orchestrator = ConfigOrchestrator.getInstance()
  const infoKey = JSON.stringify({
    modelName: info.modelName,
    modelMode: info.modelMode,
    provider: info.provider,
    error: info.error
      ? typeof info.error === 'string'
        ? info.error
        : info.error.message || info.error.code
      : null,
    language,
    // 引擎配置影响 backend 值，切换引擎时需使缓存失效
    aiEngine: orchestrator.getValue<string>('AI_ENGINE'),
    aiEngineForceCpuMode: orchestrator.getValue<boolean>('AI_ENGINE_FORCE_CPU_MODE'),
    aiEngineDriverCompatibleMode: orchestrator.getValue<boolean>('AI_ENGINE_DRIVER_COMPATIBLE_MODE')
  })

  const now = Date.now()
  const cached = enrichCache.get(infoKey)
  if (cached && now - cached.timestamp < 30000) {
    // 30 seconds TTL (覆盖前端15s轮询间隔，避免同频失效)
    // 注意：缓存中 backend 可能因首次获取失败而卡在 undefined，
    // 每次命中缓存时检查是否需要重新获取 backend
    const result = {
      ...info,
      ...cached.data
    }
    if (!result.backend && result.modelMode === 'local' && result.provider !== 'Ollama') {
      try {
        result.backend = await getActiveHardwareBackend()
        // 同步更新缓存，避免后续命中再次重复获取
        cached.data.backend = result.backend
      } catch (e) {
        logger.warn(LogCategory.MAIN, '获取硬件后端失败:', e)
      }
    }
    if (!result.bestAcceleration && result.modelMode === 'local') {
      try {
        result.bestAcceleration = await getBestAvailableAcceleration()
        cached.data.bestAcceleration = result.bestAcceleration
      } catch (e) {
        logger.warn(LogCategory.MAIN, '获取最佳可用引擎失败:', e)
      }
    }
    return result
  }

  const enriched = { ...info }

  if (enriched.error) {
    enriched.error = ErrorNormalizer.normalize(
      enriched.error,
      enriched.error?.code,
      'enrichAIStatus'
    )
  }

  const errorMessage =
    typeof enriched.error === 'string' ? enriched.error : enriched.error?.message || ''

  const isApiKeyError =
    errorMessage &&
    (errorMessage.includes('API密钥不能为空') || errorMessage.includes('API key is missing'))

  if (!enriched.modelMode) {
    if (enriched.provider === 'local') {
      enriched.modelMode = 'local'
    } else if (enriched.provider) {
      enriched.modelMode = 'cloud'
    } else {
      const orchestrator = ConfigOrchestrator.getInstance()
      enriched.modelMode =
        orchestrator && typeof orchestrator.getValue === 'function'
          ? orchestrator.getValue<string>('AI_SERVICE_MODE') || 'local'
          : 'local'
    }
  }

  if (!enriched.modelName && enriched.status === AIServiceStatus.CONNECTING) {
    logger.debug(
      LogCategory.MAIN,
      '[enrichAIStatus] 探测到 CONNECTING 状态且无模型名称，维持当前 provider 显示'
    )
  }

  if (enriched.modelMode === 'cloud' && isApiKeyError) {
    enriched.modelName = null
    if (!enriched.provider) enriched.provider = null
  }

  try {
    if (enriched.modelMode === 'local' && enriched.modelName) {
      // 优化：使用 in-memory config 查找，避免执行 listAllModels 触发的磁盘 I/O 和 Ollama 网络 API
      unifiedModelManager.ensureLoaded()
      const rawModels = unifiedModelManager.getAllModels()
      const model = rawModels.find(m => {
        // 1. 精确匹配 ID 或名称
        if (m.id === enriched.modelName || m.name === enriched.modelName) return true

        // 2. 完整路径匹配：提取文件名（含扩展名）和去掉扩展名的文件名分别尝试
        // 兼容 / 和 \ 分隔符（HuggingFace ID 使用 /，Windows 路径使用 \）
        const hasPathSep = /[/\\]/.test(enriched.modelName)
        if (hasPathSep) {
          const segments = enriched.modelName.split(/[/\\]/)
          const baseName = segments[segments.length - 1] || enriched.modelName
          if (m.id.includes(baseName)) return true

          // 去掉扩展名再匹配（如 Qwen3.5-0.8B-Q4_0.gguf → Qwen3.5-0.8B-Q4_0）
          const ext = path.extname(baseName)
          if (ext) {
            const nameWithoutExt = baseName.slice(0, -ext.length)
            if (m.id.includes(nameWithoutExt)) return true
          }
        }

        return false
      })

      if (model) {
        const vramRequiredGB = Math.ceil(
          (model as any).vramRequiredGB ||
            unifiedModelManager.calculateRequiredVRAM(model.totalSize || '0B')
        )
        const totalSizeBytes = model.totalSize
          ? Math.round(parseSizeToGB(model.totalSize) * 1024 ** 3)
          : 0

        logger.debug(
          LogCategory.MAIN,
          `[enrichAIStatus] 找到匹配模型: ${model.name}, Size: ${totalSizeBytes}`
        )
        enriched.modelName = model.name
        enriched.vramRequiredGB = vramRequiredGB
        enriched.totalSizeBytes = totalSizeBytes

        if (model.source === 'ollama' || (model as any).ollama) {
          enriched.provider = 'Ollama'
        }
      } else {
        logger.warn(
          LogCategory.MAIN,
          `[enrichAIStatus] 未找到匹配的模型元数据: ${enriched.modelName}`
        )
        // 未匹配时保留原始 modelName（不擅自改写），仅打印警告
      }
    } else if (enriched.modelMode === 'cloud') {
      const providerId = String(enriched.provider || '')
        .toLowerCase()
        .trim()
      if (providerId) {
        if (providerId === 'ollama') {
          enriched.provider = 'Ollama'
        }

        const providers =
          ConfigOrchestrator.getInstance().getValue<any[]>('CLOUD_MODEL_CONFIGS') || []
        const providerPreset = providers.find(
          (p: any) => p && p.id && p.id.toLowerCase() === providerId
        )
        if (providerPreset) {
          enriched.provider = providerPreset.name

          if (enriched.modelName && providerPreset.models) {
            const modelPreset = providerPreset.models.find((m: any) => m.id === enriched.modelName)
            if (modelPreset) {
              enriched.modelName = modelPreset.name
            }
          }
        }
      }
    }
  } catch (err) {
    logger.error(LogCategory.MAIN, '增强 AI 状态失败:', err)
  }

  if (enriched.modelMode === 'local' && enriched.provider !== 'Ollama') {
    try {
      enriched.backend = await getActiveHardwareBackend()
    } catch (e) {
      logger.warn(LogCategory.MAIN, '获取硬件后端失败:', e)
    }
  }

  // 本地模式下附带"最佳可用引擎"参考值（融合记忆与硬件检测），供前端警告使用
  if (enriched.modelMode === 'local') {
    try {
      enriched.bestAcceleration = await getBestAvailableAcceleration()
    } catch (e) {
      logger.warn(LogCategory.MAIN, '获取最佳可用引擎失败:', e)
    }
  }

  logger.debug(
    LogCategory.MAIN,
    `[enrichAIStatus] 增强后: mode=${enriched.modelMode}, name=${enriched.modelName}, provider=${enriched.provider}, backend=${enriched.backend}, bestAcceleration=${enriched.bestAcceleration}`
  )

  // Cache the enriched properties
  const enrichData = {
    error: enriched.error,
    modelMode: enriched.modelMode,
    modelName: enriched.modelName,
    vramRequiredGB: enriched.vramRequiredGB,
    totalSizeBytes: enriched.totalSizeBytes,
    provider: enriched.provider,
    backend: enriched.backend,
    bestAcceleration: enriched.bestAcceleration
  }
  enrichCache.set(infoKey, {
    timestamp: now,
    data: enrichData
  })

  return enriched
}
