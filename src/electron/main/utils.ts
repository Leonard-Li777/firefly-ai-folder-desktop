import { BrowserWindow, net } from 'electron'
import { logger, LogCategory, ErrorNormalizer, parseSizeToGB } from '@firefly/shared'
import { AIServiceStatus } from '@firefly/types'
import { hardwareDetectionService } from '../runtime-services/system/hardware-detection-service'
import { ConfigOrchestrator } from '../config/config-orchestrator'
import { LlamaModelManager } from '../runtime-services'
import { LicenseService, LicenseStatus } from '../runtime-services/system/license-service'
import { engineBridgeService } from '../runtime-services/engine-bridge'
import * as path from 'path'
import { activeHardwareBackendCache, setActiveHardwareBackendCache } from './state'

// In-memory cache for enrichAIStatus lookup results
interface EnrichCacheEntry {
  timestamp: number
  data: {
    targetModelId?: string
    error: any
    modelMode: string | null
    modelName: string | null
    vramRequiredGB?: number
    totalSizeBytes?: number
    provider: string | null
    backend?: string
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

// Tier 2 引擎上报 backend 变化（上线/切换 vulkan/cpu 等）时失效硬件后端缓存，
// 避免 Footer/`getActiveHardwareBackend` 在下次配置变更前一直显示离线时的旧值。
try {
  let lastTier2Backend: string | null = null
  engineBridgeService.subscribe(snapshot => {
    if (snapshot.backend !== lastTier2Backend) {
      lastTier2Backend = snapshot.backend
      setActiveHardwareBackendCache(null)
      logger.debug(
        LogCategory.MAIN,
        `[enrichAIStatus] Tier2 backend 变化为 ${snapshot.backend ?? 'null'}，清除硬件后端缓存`
      )
    }
  })
} catch (e) {
  logger.warn(LogCategory.MAIN, '[enrichAIStatus] 订阅 Tier2 状态失败:', e)
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
 * PRD-0049：getBestAvailableAcceleration 已清退（BEST_ACCELERATION 配置键删除）
 * 引擎激活/加速后端唯一真相 = 萤核AI引擎桥接快照
 */

/**
 * 获取当前活跃的硬件加速后端描述字符串
 * PRD-0049：tier 一律取萤核AI引擎桥接快照 backend（引擎激活单一真相源）
 */
export async function getActiveHardwareBackend(): Promise<string> {
  if (activeHardwareBackendCache) return activeHardwareBackendCache

  try {
    const resources = await hardwareDetectionService.detectSystemResources()

    // PRD-0049：当前引擎唯一真相 = 桥接快照 backend
    // 不再读取 AI_ENGINE_FORCE_CPU_MODE / AI_ENGINE_DRIVER_COMPATIBLE_MODE / SELECTED_ACCELERATION
    // 引擎离线（backend 为 null）时回落硬件最佳层级：仅作描述性展示，不构成"当前引擎"真相
    const selectedAcc = engineBridgeService.getSnapshot().backend
    const tier: string = selectedAcc || (await hardwareDetectionService.getBestAccelerationTier())

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

  const orchestrator = ConfigOrchestrator.getInstance()
  const currentMode = info.modelMode || orchestrator.getValue<string>('AI_SERVICE_MODE') || 'local'
  // PRD-0044：本地分支模型身份唯一真相 = 萤核AI引擎侧当前加载模型（桥接快照），SELECTED_MODEL_ID/SOURCE 已删除
  const currentSelectedModelId =
    currentMode === 'cloud'
      ? orchestrator.getValue<string>('AI_CLOUD_SELECTED_MODEL_ID')
      : (await import('../runtime-services/engine-bridge')).engineBridgeService.getSnapshot().model
  const currentCloudProvider = orchestrator.getValue<string>('AI_CLOUD_PROVIDER')

  // Create a stable cache key based on model identity AND engine config AND selected model in orchestrator
  const infoKey = JSON.stringify({
    rawModelName: info.modelName,
    modelMode: currentMode,
    provider: info.provider,
    selectedModelId: currentSelectedModelId,
    cloudProvider: currentCloudProvider,
    error: info.error
      ? typeof info.error === 'string'
        ? info.error
        : info.error.message || info.error.code
      : null,
    language,
    // 引擎配置影响 backend 值，切换引擎时需使缓存失效
    // PRD-0049：不再以 AI_ENGINE_FORCE_CPU_MODE / AI_ENGINE_DRIVER_COMPATIBLE_MODE 参与缓存键
    aiEngine: orchestrator.getValue<string>('AI_ENGINE')
  })

  const now = Date.now()
  const cached = enrichCache.get(infoKey)
  if (
    cached &&
    now - cached.timestamp < 30000 &&
    cached.data?.targetModelId === currentSelectedModelId
  ) {
    // 30 seconds TTL (覆盖前端15s轮询间隔，避免同频失效)
    const result = {
      ...info,
      ...cached.data
    }
    if (!result.backend && result.modelMode === 'local') {
      try {
        result.backend = await getActiveHardwareBackend()
        cached.data.backend = result.backend
      } catch (e) {
        logger.warn(LogCategory.MAIN, '获取硬件后端失败:', e)
      }
    }
    return result
  }

  const enriched = { ...info }
  enriched.modelMode = currentMode

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

  // 兜底补全：如果 modelName 为空或为 generic 标识，取引擎桥接快照中当前加载的模型名
  if (enriched.modelMode === 'local') {
    if (
      !enriched.modelName ||
      enriched.modelName === 'unknown' ||
      enriched.modelName === 'llama.cpp'
    ) {
      const fallbackModelId = currentSelectedModelId
      if (fallbackModelId) {
        enriched.modelName = fallbackModelId
      }
    }
  } else if (enriched.modelMode === 'cloud') {
    if (!enriched.modelName || enriched.modelName === 'unknown') {
      const fallbackCloudModelId = ConfigOrchestrator.getInstance().getValue<string>(
        'AI_CLOUD_SELECTED_MODEL_ID'
      )
      if (fallbackCloudModelId) {
        enriched.modelName = fallbackCloudModelId
      }
    }
    if (!enriched.provider) {
      const fallbackCloudProvider =
        ConfigOrchestrator.getInstance().getValue<string>('AI_CLOUD_PROVIDER')
      if (fallbackCloudProvider) {
        enriched.provider = fallbackCloudProvider
      }
    }
  }

  try {
    if (enriched.modelMode === 'local') {
      // 模型元数据唯一权威来源 = 萤核AI引擎（/api/models/meta），desktop 不再读取本地 model_*.json
      const rawModels = await engineBridgeService.fetchModelMeta()

      // 1. 优先用引擎桥接快照的当前模型名反查元数据（PRD-0044：id 或 name 匹配任一即可）
      let model = currentSelectedModelId
        ? rawModels.find(
            m => m.id === currentSelectedModelId || m.name === currentSelectedModelId
          )
        : undefined

      // 2. 回退：如果根据配置没查到，再根据传入的 enriched.modelName 精确匹配
      if (!model && enriched.modelName) {
        model = rawModels.find(m => {
          if (m.id === enriched.modelName || m.name === enriched.modelName) return true

          const hasPathSep = /[/\\]/.test(enriched.modelName)
          if (hasPathSep) {
            const segments = enriched.modelName.split(/[/\\]/)
            const baseName = segments[segments.length - 1] || enriched.modelName
            if (m.id === baseName) return true

            const ext = path.extname(baseName)
            if (ext) {
              const nameWithoutExt = baseName.slice(0, -ext.length)
              if (m.id === nameWithoutExt) return true
            }
          }
          return false
        })
      }

      if (model) {
        const vramRequiredGB = Math.ceil(
          (model as any).vramRequiredGB ||
            (model as any).vramNeededGB ||
            parseSizeToGB(model.totalSize || model.size || '0B') * 1.15 + 0.5
        )
        const totalSizeBytes = model.totalSize || model.size
          ? Math.round(parseSizeToGB(model.totalSize || model.size) * 1024 ** 3)
          : 0

        logger.debug(
          LogCategory.MAIN,
          `[enrichAIStatus] 找到匹配模型: ${model.name}, Size: ${totalSizeBytes}`
        )
        enriched.modelName = model.name
        enriched.vramRequiredGB = vramRequiredGB
        enriched.totalSizeBytes = totalSizeBytes
      } else {
        // 引擎 /api/models 的 name 映射兜底（扫描到的物理模型可能不在推荐目录中）
        const friendly = engineBridgeService.resolveFriendlyModelName(enriched.modelName)
        if (friendly && friendly !== enriched.modelName) {
          enriched.modelName = friendly
        }
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

  if (enriched.modelMode === 'local') {
    try {
      enriched.backend = await getActiveHardwareBackend()
    } catch (e) {
      logger.warn(LogCategory.MAIN, '获取硬件后端失败:', e)
    }
  }

  // PRD-0049：bestAcceleration 输出链已清退

  logger.debug(
    LogCategory.MAIN,
    `[enrichAIStatus] 增强后: mode=${enriched.modelMode}, name=${enriched.modelName}, provider=${enriched.provider}, backend=${enriched.backend}`
  )

  // Cache the enriched properties
  const enrichData = {
    targetModelId: currentSelectedModelId ?? undefined,
    error: enriched.error,
    modelMode: enriched.modelMode,
    modelName: enriched.modelName,
    vramRequiredGB: enriched.vramRequiredGB,
    totalSizeBytes: enriched.totalSizeBytes,
    provider: enriched.provider,
    backend: enriched.backend
  }
  enrichCache.set(infoKey, {
    timestamp: now,
    data: enrichData
  })

  return enriched
}
