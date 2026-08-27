import { ipcMain, BrowserWindow } from 'electron'
import { LlamaIndexAIService, llamaServerService } from '@firefly/electron-llamaIndex-service'
import { AIServiceStatus, StartupPhase } from '@firefly/types'
import { logger, LogCategory, isTestEnvironment } from '@firefly/shared'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { llamaEngineService } from '../../runtime-services/llama/llama-engine-service'
import { gpuDriverComplianceService } from '../../runtime-services/llama/gpu-driver-compliance-service'
import { deploymentIntegrityVerifier } from '../../runtime-services/llama/deployment-integrity-verifier'
import { databaseService } from '../../runtime-services/database/database-service'
import { analysisQueueService } from '../../runtime-services/analysis-queue-service'
import { llamaModelManager } from '../../runtime-services/llama/llama-model-manager'
import { createModelCapabilityAdapter } from '../../adapters/model-capability-adapter'
import { t } from '@app/languages'
import {
  globalLlamaIndexService,
  setGlobalLlamaIndexService,
  setDirectoryContextService
} from '../state'
import { ensureLlamaEngineDeployed } from '../initialization'
import { enrichAIStatus, getActiveHardwareBackend, clearEnrichCache } from '../utils'

export function registerAIServiceIPCHandlers() {
  ipcMain.handle(
    'ai-service/initialize',
    async (_event, options?: { onlyDeploy?: boolean; forceDeploy?: boolean }) => {
      try {
        logger.info(
          LogCategory.MAIN,
          `[IPC] 收到AI服务初始化请求, options: ${JSON.stringify(options)}`
        )

        const initMode = ConfigOrchestrator.getInstance().getValue<string>('AI_SERVICE_MODE')
        const isTestEnv = isTestEnvironment()

        if (isTestEnv) {
          logger.info(LogCategory.MAIN, '[IPC] 测试环境：跳过 AI 引擎部署和初始化')
          const { llamaModelManager } =
            await import('../../runtime-services/llama/llama-model-manager')
          llamaModelManager.clearCache()
          return { success: true, message: '测试模式：AI 服务初始化模拟成功' }
        }

        if (initMode === 'cloud') {
          logger.info(LogCategory.MAIN, '[IPC] 云端模式：跳过本地 AI 引擎部署')
        } else {
          await ensureLlamaEngineDeployed({ forceDeploy: options?.forceDeploy })
          if (options?.forceDeploy) {
            logger.info(LogCategory.MAIN, '[IPC] forceDeploy 模式：强制杀掉旧引擎进程')
            try {
              await llamaServerService.forceKillProcess()
            } catch (e) {
              logger.warn(LogCategory.MAIN, '[IPC] 强制杀掉旧进程失败（可能已退出）:', e)
            }
          }
        }

        if (options?.onlyDeploy) {
          logger.info(LogCategory.MAIN, '[IPC] 检测到 onlyDeploy 标志，仅部署引擎，不启动服务')
          if (!globalLlamaIndexService) {
            const service = LlamaIndexAIService.getInstance(
              ConfigOrchestrator.getInstance(),
              llamaServerService,
              ConfigOrchestrator.getInstance()
            )
            setGlobalLlamaIndexService(service)
          }
          if (globalLlamaIndexService) {
            await globalLlamaIndexService.initialize(StartupPhase.CONFIGURATION)
          }
          const { llamaModelManager } =
            await import('../../runtime-services/llama/llama-model-manager')
          llamaModelManager.clearCache()
          return { success: true, message: t('Llama 引擎部署完成') }
        }

        if (!globalLlamaIndexService) {
          const service = LlamaIndexAIService.getInstance(
            ConfigOrchestrator.getInstance(),
            llamaServerService,
            ConfigOrchestrator.getInstance()
          )
          setGlobalLlamaIndexService(service)
        }

        if (!globalLlamaIndexService) {
          throw new Error(t('AI服务初始化失败：无法创建实例'))
        }

        if (initMode !== 'cloud') {
          const isInitialized = globalLlamaIndexService.isInitialized()
          if (!isInitialized) {
            logger.info(LogCategory.MAIN, '[IPC] 开始完整AI服务初始化...')
          }

          if (globalLlamaIndexService) {
            if (options?.forceDeploy) {
              logger.info(
                LogCategory.MAIN,
                '[IPC] 检测到 forceDeploy，触发 AI 服务配置重载以重启引擎进程'
              )
              await globalLlamaIndexService.reloadConfig()
            } else {
              await globalLlamaIndexService.initialize(StartupPhase.RUNTIME)
            }
          }

          if (!isInitialized) {
            logger.info(LogCategory.MAIN, '[IPC] AI服务初始化完成')
          }
        } else {
          logger.info(
            LogCategory.MAIN,
            '[IPC] 云端模式：跳过本地 AI 服务进程初始化，确保 AI 服务就绪'
          )
          if (!globalLlamaIndexService.isInitialized()) {
            await globalLlamaIndexService.initialize(StartupPhase.RUNTIME)
          }
        }

        if (globalLlamaIndexService && databaseService.db) {
          const { DirectoryContextService } =
            await import('../../runtime-services/filesystem/directory-context-service')
          setDirectoryContextService(new DirectoryContextService(globalLlamaIndexService))
          logger.info(LogCategory.MAIN, '[IPC] 目录上下文服务已成功注册并绑定')
        }

        llamaModelManager.clearCache()

        return { success: true, message: t('LlamaIndex AI服务初始化成功') }
      } catch (error) {
        logger.error(LogCategory.MAIN, '[IPC] AI服务初始化失败:', error)
        const errorMessage = error instanceof Error ? error.message : String(error)
        return { success: false, message: errorMessage }
      }
    }
  )

  ipcMain.handle('ai-service/is-initialized', async () => {
    try {
      if (!globalLlamaIndexService) return false
      return globalLlamaIndexService.isInitialized()
    } catch (error) {
      logger.error(LogCategory.MAIN, '[IPC] 查询AI服务状态失败:', error)
      return false
    }
  })

  ipcMain.handle('ai-service/get-initialization-info', async () => {
    try {
      if (!globalLlamaIndexService) {
        return {
          isInitialized: false,
          isInitializing: false,
          attempts: 0,
          lastError: 'AI服务未创建'
        }
      }
      return globalLlamaIndexService.getInitializationInfo()
    } catch (error) {
      logger.error(LogCategory.MAIN, '[IPC] 获取AI服务初始化信息失败:', error)
      return {
        isInitialized: false,
        isInitializing: false,
        attempts: 0,
        lastError: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle('ai-service/get-status', async () => {
    try {
      if (!globalLlamaIndexService) return AIServiceStatus.UNINITIALIZED
      return globalLlamaIndexService.getServiceStatus()
    } catch (error) {
      logger.error(LogCategory.MAIN, '[IPC] 获取AI服务状态失败:', error)
      return AIServiceStatus.ERROR
    }
  })

  ipcMain.handle('ai-service/get-capabilities', async () => {
    try {
      const adapter = createModelCapabilityAdapter()
      const capabilities = await adapter.getCapabilities()
      return await enrichAIStatus(capabilities)
    } catch (error) {
      logger.error(LogCategory.MAIN, '[IPC] 获取AI能力失败:', error)
      return null
    }
  })

  ipcMain.handle('ai-service/get-current-phase', async () => {
    try {
      if (!globalLlamaIndexService) return 'configuration'
      return globalLlamaIndexService.getCurrentPhaseState().currentPhase
    } catch (error) {
      logger.error(LogCategory.MAIN, '[IPC] 获取AI启动阶段失败:', error)
      return 'configuration'
    }
  })

  ipcMain.handle('ai-service/on-model-changed', async (_event, modelId: string) => {
    try {
      logger.info(LogCategory.MAIN, `[IPC] 收到模型切换通知: ${modelId}`)
      lastGetAIStatusCache = null
      clearEnrichCache()

      if (!globalLlamaIndexService) {
        logger.warn(LogCategory.MAIN, '[IPC] AI服务未创建，无法处理模型切换')
        return { success: false, message: t('AI服务未创建') }
      }
      await globalLlamaIndexService.onModelChanged(modelId)

      // 主动广播最新状态给所有窗口，确保 Footer（useModelStore）能立即同步新模型名称
      try {
        const info = await globalLlamaIndexService.getCurrentModelInfo()
        const adapter = createModelCapabilityAdapter()
        adapter.clearCache()
        const caps = await adapter.getCapabilities()
        info.capabilities = caps
        if (caps.modelName) info.modelName = caps.modelName
        if (caps.provider) info.provider = caps.provider

        const enrichedInfo = await enrichAIStatus(info)
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.send('ai-model-status-changed', enrichedInfo)
          }
        })
      } catch (e) {
        logger.warn(LogCategory.MAIN, '[on-model-changed] 广播状态更新失败:', e)
      }

      logger.info(LogCategory.MAIN, `[IPC] 模型切换通知处理完成: ${modelId}`)
      return { success: true, message: t('模型切换通知已处理') }
    } catch (error) {
      logger.error(LogCategory.MAIN, '[IPC] 处理模型切换失败:', error)
      return { success: false, message: t('处理失败') }
    }
  })

  ipcMain.handle('ai-service/check-driver-compliance', async () => {
    return await gpuDriverComplianceService.checkCompliance()
  })

  ipcMain.handle('ai-service/check-package-integrity', async () => {
    return deploymentIntegrityVerifier.getFailedPackageNames()
  })

  ipcMain.handle('ai-service/get-driver-update-url', async () => {
    return await gpuDriverComplianceService.getDriverUpdateUrl()
  })

  ipcMain.handle('ai-service/switch-to-compatible-mode', async () => {
    return await gpuDriverComplianceService.switchToCompatibleMode()
  })

  ipcMain.handle('ai-service/switch-to-high-performance-mode', async () => {
    return await gpuDriverComplianceService.switchToHighPerformanceMode()
  })

  // 缓存上次的 get-ai-status 结果，避免前端轮询时重复检测
  // 提升到 switch-acceleration-backend 之前，使切换后能清除此缓存
  let lastGetAIStatusCache: {
    result: any
    timestamp: number
    modelKey: string
  } | null = null
  const GET_AI_STATUS_CACHE_TTL = 30000 // 30秒

  // 监听模型配置更新，配置变动时强行失效 lastGetAIStatusCache
  ConfigOrchestrator.getInstance().onConfigChange(changes => {
    if (
      'SELECTED_MODEL_ID' in changes ||
      'SELECTED_MODEL_SOURCE' in changes ||
      'AI_CLOUD_SELECTED_MODEL_ID' in changes ||
      'AI_SERVICE_MODE' in changes ||
      'AI_CLOUD_PROVIDER' in changes
    ) {
      logger.info(LogCategory.MAIN, '[ai-service] 关键模型配置改变，清空 get-ai-status 缓存')
      lastGetAIStatusCache = null
      clearEnrichCache()
    }
  })

  ipcMain.handle('ai-service/switch-acceleration-backend', async (_event, backend: string) => {
    const result = await gpuDriverComplianceService.switchAccelerationBackend(backend)
    // 切换加速后端后清除 get-ai-status 缓存，确保前端下次获取能拿到新 backend 值
    lastGetAIStatusCache = null
    clearEnrichCache()
    // 主动广播最新状态给所有窗口，确保 Footer（useModelStore）能立即更新，
    // 不依赖引擎重启后才触发的 onStatusChanged 事件
    try {
      if (globalLlamaIndexService) {
        const info = await globalLlamaIndexService.getCurrentModelInfo()
        const adapter = createModelCapabilityAdapter()
        const caps = await adapter.getCapabilities()
        info.capabilities = caps
        if (caps.modelName) info.modelName = caps.modelName
        if (caps.provider) info.provider = caps.provider
        const enrichedInfo = await enrichAIStatus(info)
        BrowserWindow.getAllWindows().forEach(win => {
          if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.send('ai-model-status-changed', enrichedInfo)
          }
        })
      }
    } catch (e) {
      logger.warn(LogCategory.MAIN, '[switch-acceleration-backend] 广播状态更新失败:', e)
    }
    return result
  })

  ipcMain.handle('get-ai-status', async () => {
    try {
      if (!globalLlamaIndexService) {
        return {
          modelName: null,
          modelMode: null,
          provider: null,
          loading: false,
          status: AIServiceStatus.UNINITIALIZED
        }
      }
      const info = await globalLlamaIndexService.getCurrentModelInfo()

      // 先通过 ModelCapabilityAdapter 刷新当前能力的最新检测与选中的 modelName / provider
      try {
        const adapter = createModelCapabilityAdapter()
        const caps = await adapter.getCapabilities()
        info.capabilities = caps
        if (caps.modelName) {
          info.modelName = caps.modelName
        }
        if (caps.provider) {
          info.provider = caps.provider
        }
      } catch (err) {
        logger.error(LogCategory.MAIN, '[IPC] Failed to fetch capabilities for model info:', err)
      }

      // 修正：构建模型身份键 + 选中的模型ID + 引擎配置键，确保切换模型后立即使 get-ai-status 缓存失效
      const config = ConfigOrchestrator.getInstance()
      const mode = info.modelMode || config.getValue<string>('AI_SERVICE_MODE') || 'local'
      const activeModelId =
        mode === 'cloud'
          ? config.getValue<string>('AI_CLOUD_SELECTED_MODEL_ID')
          : config.getValue<string>('SELECTED_MODEL_ID')
      const activeSource = config.getValue<string>('SELECTED_MODEL_SOURCE')
      const activeCloudProvider = config.getValue<string>('AI_CLOUD_PROVIDER')

      const modelKey = JSON.stringify({
        rawModelName: info.modelName,
        modelMode: mode,
        provider: info.provider,
        selectedModelId: activeModelId,
        selectedSource: activeSource,
        cloudProvider: activeCloudProvider,
        // 引擎配置影响 backend 值，切换引擎时需使缓存失效
        aiEngine: config.getValue<string>('AI_ENGINE'),
        aiEngineForceCpuMode: config.getValue<boolean>('AI_ENGINE_FORCE_CPU_MODE'),
        aiEngineDriverCompatibleMode: config.getValue<boolean>('AI_ENGINE_DRIVER_COMPATIBLE_MODE')
      })

      // 模型未切换且在缓存有效期内，直接返回缓存（仅更新状态字段）
      if (
        lastGetAIStatusCache &&
        Date.now() - lastGetAIStatusCache.timestamp < GET_AI_STATUS_CACHE_TTL &&
        lastGetAIStatusCache.modelKey === modelKey
      ) {
        // 更新运行时状态字段（status/loading/error 可能变化）
        lastGetAIStatusCache.result.status = info.status
        lastGetAIStatusCache.result.loading = info.loading
        lastGetAIStatusCache.result.error = info.error
        // 同时更新 backend，避免缓存卡在旧值
        if (info.modelMode === 'local' && info.provider !== 'Ollama') {
          lastGetAIStatusCache.result.backend = info.modelName
            ? await getActiveHardwareBackend()
            : lastGetAIStatusCache.result.backend
        }
        return lastGetAIStatusCache.result
      }

      const result = await enrichAIStatus(info)

      // 调试：记录 backend 值
      if (result.modelMode === 'local') {
        logger.info(
          LogCategory.MAIN,
          `[getAIStatus] backend=${result.backend}, provider=${result.provider}`
        )
      }

      // 缓存结果（使用与 result 匹配的最新 modelKey）
      lastGetAIStatusCache = {
        result,
        timestamp: Date.now(),
        modelKey
      }

      return result
    } catch (error) {
      logger.error(LogCategory.MAIN, '[IPC] 获取AI状态失败:', error)
      return {
        modelName: null,
        modelMode: null,
        provider: null,
        loading: false,
        status: AIServiceStatus.ERROR
      }
    }
  })

  ipcMain.handle('initialize-ai-service', async () => {
    try {
      if (!globalLlamaIndexService) {
        const service = LlamaIndexAIService.getInstance(
          ConfigOrchestrator.getInstance(),
          llamaServerService,
          ConfigOrchestrator.getInstance()
        )
        setGlobalLlamaIndexService(service)
      }
      if (globalLlamaIndexService) {
        await globalLlamaIndexService.initialize()
      }
      if (globalLlamaIndexService && databaseService.db) {
        const { DirectoryContextService } =
          await import('../../runtime-services/filesystem/directory-context-service')
        setDirectoryContextService(new DirectoryContextService(globalLlamaIndexService))
        logger.info(
          LogCategory.MAIN,
          '[IPC] initialize-ai-service 自动绑定 directoryContextService 成功'
        )
      }
      return { success: true, status: 'loaded', message: t('AI服务初始化成功') }
    } catch (error) {
      logger.error(LogCategory.MAIN, '[Main] AI服务初始化失败:', error)
      const errorMessage = error instanceof Error ? error.message : String(error)
      return {
        success: false,
        status: 'error',
        message: errorMessage
      }
    }
  })

  ipcMain.handle(
    'llama-server-chat',
    async (
      event,
      options: {
        model: string
        messages: Array<{ role: string; content: string }>
        temperature?: number
        maxTokens?: number
      }
    ) => {
      if (globalLlamaIndexService?.isSwitchingService()) {
        logger.info(LogCategory.MAIN, '[Main] llama-server聊天: 模型正在切换中，拒绝请求')
        return {
          success: false,
          status: 'SERVICE_SWITCHING',
          message: t('模型正在切换中，请等待')
        }
      }
      try {
        logger.info(LogCategory.MAIN, '[Main] llama-server聊天请求:', {
          model: options.model,
          messageCount: options.messages.length
        })
        const response = await llamaServerService.chatCompletion({
          model: options.model,
          messages: options.messages,
          temperature: options.temperature || 0.3,
          maxTokens: options.maxTokens || 500
        } as any)
        logger.info(LogCategory.MAIN, '[Main] llama-server聊天完成')
        return response
      } catch (error) {
        logger.error(LogCategory.MAIN, '[Main] llama-server聊天失败:', error)
        throw error
      }
    }
  )

  ipcMain.handle('llama-server-health', async event => {
    try {
      return await llamaServerService.checkHealth()
    } catch (error) {
      logger.error(LogCategory.MAIN, '[Main] 本地AI服务健康检查失败:', error)
      throw error
    }
  })

  ipcMain.handle('llama-server-port', async () => {
    try {
      const processInfo = llamaServerService.getProcessInfo()
      if (processInfo && processInfo.config?.port) {
        return processInfo.config.port
      }
      const currentConfig = llamaServerService.getCurrentConfig()
      if (currentConfig && currentConfig.port) {
        return currentConfig.port
      }
      return null
    } catch (error) {
      logger.error(LogCategory.MAIN, '[Main] 获取 llama-server 运行端口失败:', error)
      return null
    }
  })

  ipcMain.handle(
    'ai-chat',
    async (
      event,
      options: {
        model: string
        messages: Array<{ role: string; content: string }>
        temperature?: number
        max_tokens?: number
        images?: string[]
        audio?: string[]
      }
    ) => {
      if (globalLlamaIndexService?.isSwitchingService()) {
        logger.info(LogCategory.MAIN, '[Main] ai-chat: 模型正在切换中，拒绝请求')
        return {
          success: false,
          status: 'SERVICE_SWITCHING',
          message: t('模型正在切换中，请等待')
        }
      }
      // 本地模型正忙（如分析队列进行中）时拒绝新请求，避免本地模型无法负载；云端模型不限制
      if (analysisQueueService.isLocalModelBusy()) {
        logger.warn(LogCategory.MAIN, '[Main] ai-chat: 本地模型正忙，丢弃请求')
        analysisQueueService.notifyLocalModelBusy()
        return {
          success: false,
          status: 'LOCAL_MODEL_BUSY',
          message: t('当前AI已经在工作中，如：分析队列，请停止后再请求')
        }
      }
      if (globalLlamaIndexService) {
        try {
          await globalLlamaIndexService.waitForReady(60000)
        } catch (err) {
          logger.warn(LogCategory.MAIN, 'AI Chat: 等待 AI 服务就绪超时或失败:', err)
          return {
            success: false,
            status: 'SERVICE_LOADING',
            message: t('AI 服务正在初始化中，请稍候再试')
          }
        }
      }
      try {
        logger.info(LogCategory.MAIN, '[Main] 收到AI聊天请求:', {
          model: options.model,
          messageCount: options.messages.length
        })
        const response = await llamaServerService.chatCompletion({
          model: options.model,
          messages: options.messages,
          temperature: options.temperature || 0.3,
          maxTokens: options.max_tokens || 4096,
          images: options.images,
          audio: options.audio
        } as any)
        logger.debug(LogCategory.MAIN, 'message: ', JSON.stringify(response, null, 2))
        return response
      } catch (error) {
        logger.error(LogCategory.MAIN, '[Main] AI聊天请求失败:', error)
        throw error
      }
    }
  )

  ipcMain.handle('ai-service/set-config-reload-suspended', async (_event, suspended: boolean) => {
    if (globalLlamaIndexService) globalLlamaIndexService.setConfigReloadSuspended(suspended)
  })

  ipcMain.handle(
    'classify-file-with-llm',
    async (event, modelId: string, prompt: string, filename: string) => {
      logger.warn(
        LogCategory.MAIN,
        '[Main] classify-file-with-llm IPC处理器已废弃，请使用渲染进程中的本地AI分类'
      )
      throw new Error('此IPC处理器已废弃，请使用渲染进程中的本地AI分类')
    }
  )
}
