import type { AppConfig } from '@yonuc/types'
import type { ConfigKey, UnifiedAppConfig, UnifiedConfigUpdate, ConfigChangeSource } from '@yonuc/types/config-types'
import type { AIServiceConfig } from '@yonuc/types/ai-config-types'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { logger, LogCategory } from '@yonuc/shared'
import { AIServiceConfigManager } from '@yonuc/electron-llamaIndex-service'

export class ConfigService {
  private readonly orchestrator = ConfigOrchestrator.getInstance()
  private readonly aiConfigManager = new AIServiceConfigManager(this.orchestrator)

  getConfig(): AppConfig {
    const config = this.orchestrator.getRendererConfig()

    // 将 unified-config 中的关键配置项注入到 AppConfig（用于前端回显与兼容）
    const aiServiceMode = this.orchestrator.getValue('AI_SERVICE_MODE') as string
    const modelConfigUrl = this.orchestrator.getValue('MODEL_CONFIG_URL') as string | undefined
    const modelPath = this.orchestrator.getValue('MODEL_STORAGE_PATH') as string
    const databasePath = this.orchestrator.getValue('DATABASE_PATH') as string

    // 注入更多 UI 相关的配置项，确保 ConfigKey 系统与旧的 AppConfig 兼容
    const languageConfirmed = this.orchestrator.getValue('LANGUAGE_CONFIRMED') as boolean
    const isFirstRun = this.orchestrator.getValue('IS_FIRST_RUN') as boolean
    const selectedModelId = this.orchestrator.getValue('SELECTED_MODEL_ID') as string | undefined
    const aiPlatform = this.orchestrator.getValue('AI_PLATFORM') as 'llama.cpp' | 'ollama'
    const aiCloudProvider = this.orchestrator.getValue('AI_CLOUD_PROVIDER') as string
    const aiCloudApiKey = this.orchestrator.getValue('AI_CLOUD_API_KEY') as string
    const aiCloudBaseUrl = this.orchestrator.getValue('AI_CLOUD_BASE_URL') as string | undefined
    const aiCloudApiVersion = this.orchestrator.getValue('AI_CLOUD_API_VERSION') as string | undefined
    const aiCloudSelectedModelId = this.orchestrator.getValue('AI_CLOUD_SELECTED_MODEL_ID') as string | undefined
    const language = this.orchestrator.getValue('DEFAULT_LANGUAGE') as any
    const theme = this.orchestrator.getValue('THEME_MODE') as any
    const defaultView = this.orchestrator.getValue('DEFAULT_VIEW') as any
    const showEmptyTags = this.orchestrator.getValue('SHOW_EMPTY_TAGS') as boolean
    const fileListExtraFields = this.orchestrator.getValue('FILE_LIST_EXTRA_FIELDS') as any
    const latestNews = this.orchestrator.getValue('LATEST_NEWS') as any
    const panDimensionIds = this.orchestrator.getValue('PAN_DIMENSION_IDS') as any
    const nextVersion = this.orchestrator.getValue('NEXT_VERSION') as any
    const audioAnalysisDuration = this.orchestrator.getValue('AUDIO_ANALYSIS_DURATION') as number
    const unitRecognitionPrompt = this.orchestrator.getValue('UNIT_RECOGNITION_PROMPT') as string | undefined
    const qualityScorePrompt = this.orchestrator.getValue('QUALITY_SCORE_PROMPT') as string | undefined
    const tagGenerationPrompt = this.orchestrator.getValue('TAG_GENERATION_PROMPT') as string | undefined
    const supplementalPrompt = this.orchestrator.getValue('SUPPLEMENTAL_PROMPT') as string | undefined

    // 构建兼容的 AppConfig 对象
    return {
      ...config,
      // 覆盖旧值
      language,
      theme,
      defaultView,
      showEmptyTags, // 注入到顶层
      fileListExtraFields: fileListExtraFields || config.fileListExtraFields,
      LATEST_NEWS: latestNews,
      PAN_DIMENSION_IDS: panDimensionIds,
      nextVersion, // 注入 nextVersion 供版本提醒使用
      audioAnalysisDuration, // 注入音频分析时长
      unitRecognitionPrompt,
      qualityScorePrompt,
      tagGenerationPrompt,
      supplementalPrompt,
      // 注入新值
      aiServiceMode,
      modelConfigUrl,
      modelPath,
      databasePath,
      languageConfirmed,
      isFirstRun,
      selectedModelId,
      aiPlatform,
      aiCloudProvider,
      aiCloudApiKey,
      aiCloudBaseUrl,
      aiCloudApiVersion,
      aiCloudSelectedModelId,
      // 特殊处理嵌套对象
      ui: {
        ...(config.ui || {}),
        showEmptyTags
      }
    }
  }

  getUnifiedConfig(): UnifiedAppConfig {
    return this.orchestrator.getConfigSnapshot()
  }

  getValue<T = unknown>(key: ConfigKey): T {
    return this.orchestrator.getValue(key)
  }

  updateConfig(updates: Partial<AppConfig>): void {
    this.orchestrator.updateRendererConfig(updates)
  }

  updateUnifiedConfig(partial: UnifiedConfigUpdate): void {
    this.orchestrator.updateUnifiedConfig(partial)
  }

  updateValue(key: ConfigKey, value: unknown): void {
    this.orchestrator.updateValue(key, value)
  }

  updateValues(updates: Partial<Record<ConfigKey, unknown>>, options?: { source?: ConfigChangeSource }): void {
    this.orchestrator.updateValues(updates, options)
  }

  onConfigChange(callback: (newConfig: AppConfig, oldConfig: AppConfig) => void): () => void {
    // 监听 renderer 配置变更
    const cleanupRenderer = this.orchestrator.onRendererConfigChange(callback)

    // 使用简单的防抖函数处理统一配置变更，避免批量更新时频繁触发广播
    let timeout: NodeJS.Timeout | null = null
    const debouncedBroadcast = (key: string) => {
      if (timeout) clearTimeout(timeout)
      timeout = setTimeout(() => {
        logger.debug(LogCategory.CONFIG, `ConfigService: Debounced broadcasting config change to renderer (Last trigger: ${key})`)
        callback(this.getConfig(), {} as AppConfig)
        timeout = null
      }, 100)
    }

    // 监听统一配置变更或单个值变更（云端同步触发这里）
    const unifiedHandler = (event?: any) => {
      const key = event?.key || 'unknown'
      debouncedBroadcast(key)
    }

    this.orchestrator.on('unified-change', unifiedHandler)
    this.orchestrator.on('value-change', unifiedHandler)

    return () => {
      cleanupRenderer()
      if (timeout) clearTimeout(timeout)
      this.orchestrator.off('unified-change', unifiedHandler)
      this.orchestrator.off('value-change', unifiedHandler)
    }
  }

  onValueChange<T = unknown>(key: ConfigKey, handler: (value: T, previous: T | undefined) => void): () => void {
    return this.orchestrator.onValueChange(key, handler)
  }

  /**
   * 获取AI服务配置
   */
  async getAIConfig(): Promise<AIServiceConfig> {
    const aiConfig = await this.aiConfigManager.getAIServiceConfig()
    
    // 如果是本地模式，需要补充一些动态状态信息（如是否已下载、多模态投影文件路径）
    // 虽然 AIServiceConfigManager 已经处理了路径，但这里保留了特定于桌面端的动态检查逻辑
    if (aiConfig.mode === 'local' && aiConfig.local.modelId) {
      const selectedModelId = aiConfig.local.modelId
      
      try {
        // 动态导入以避免循环依赖
        const { llamaModelManager } = await import('../llama/llama-model-manager')
        const { modelDownloadManager } = await import('../ai/model-download-manager')

        // 检查模型下载状态
        try {
          const status = await modelDownloadManager.checkModelDownloadStatus(selectedModelId)
          ;(aiConfig.local as any).isModelDownloaded = status.isDownloaded
        } catch (e) {
          console.warn(`[ConfigService] 检查模型下载状态失败: ${selectedModelId}`, e)
          ;(aiConfig.local as any).isModelDownloaded = false
        }

        // 如果 AIServiceConfigManager 没有找到 mmprojPath（可能因为它的查找逻辑较简单），
        // 尝试使用 llamaModelManager 查找
        if (!aiConfig.local.mmprojPath) {
          const multiModalConfig = await llamaModelManager.getMultiModalModelConfig(selectedModelId)
          if (multiModalConfig && multiModalConfig.isMultiModal && multiModalConfig.mmprojPath) {
            aiConfig.local.mmprojPath = multiModalConfig.mmprojPath
            console.log(`[ConfigService] 检测到多模态模型，投影文件路径: ${aiConfig.local.mmprojPath}`)
          }
        }
        
        // 确保 modelPath 是有效的（AIServiceConfigManager 已经尝试查找）
        // 如果需要，可以在这里再次验证或覆盖
        if (!aiConfig.local.modelPath || aiConfig.local.modelPath.endsWith(`${selectedModelId}.gguf`)) {
           // 只有当路径看起来像是默认生成的时候才尝试重新查找
           const modelFilePath = await llamaModelManager.getModelPath(selectedModelId)
           if (modelFilePath) {
             aiConfig.local.modelPath = modelFilePath
           }
        }

      } catch (error) {
        console.error('[ConfigService] 增强AI配置时出错:', error)
      }
    }

    return aiConfig
  }

  /**
   * 获取指定模型的配置
   */
  getModelConfig(modelId: string): any | null {
    return this.aiConfigManager.getModelConfig(modelId)
  }
}

export const configService = new ConfigService()
