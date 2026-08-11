import { t } from '@app/languages'
import { logger, LogCategory } from '@yonuc/shared'
import type { CloudModelConfig, ILlamaIndexAIService } from '@yonuc/types'
import { LlamaIndexAIService } from '@yonuc/electron-llamaIndex-service'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { cloudModelConfigService } from './cloud-model-config-service'

import { 
  AIServiceStatus,
  AIServiceError as GlobalAIServiceError
} from '@yonuc/types'

export interface AIServiceError {
  code: string
  message: string
  timestamp: number
}

/**
 * AI服务路由决策管理器
 * 根据用户配置在本地和云端服务之间进行路由决策
 */
export class AIServiceRoutingManager {
  private static instance: AIServiceRoutingManager | null = null
  
  private configOrchestrator: ConfigOrchestrator
  private currentService: ILlamaIndexAIService | null = null
  private serviceStatus: AIServiceStatus = AIServiceStatus.UNINITIALIZED
  private serviceError: AIServiceError | null = null
  private currentMode: 'local' | 'cloud' = 'local'
  
  private unsubscribers: Array<() => void> = []

  private constructor() {
    this.configOrchestrator = ConfigOrchestrator.getInstance()
    this.setupConfigListeners()
    if (logger) {
      logger.info(LogCategory.AI_SERVICE, 'AI服务路由决策管理器已初始化')
    }
  }

  static getInstance(): AIServiceRoutingManager {
    if (!AIServiceRoutingManager.instance) {
      AIServiceRoutingManager.instance = new AIServiceRoutingManager()
    }
    return AIServiceRoutingManager.instance
  }

  /**
   * 初始化服务
   */
  async initialize(): Promise<void> {
    try {
      this.serviceStatus = AIServiceStatus.INITIALIZING
      logger.info(LogCategory.AI_SERVICE, '开始初始化AI服务...')
      
      await this.initializeService()
      
      this.serviceStatus = AIServiceStatus.IDLE
      this.serviceError = null
      logger.info(LogCategory.AI_SERVICE, 'AI服务初始化成功')
    } catch (error) {
      this.serviceStatus = AIServiceStatus.ERROR
      const errorMessage = error instanceof Error ? error.message : String(error)
      this.serviceError = {
        code: 'INITIALIZATION_ERROR',
        message: errorMessage,
        timestamp: Date.now(),
      }
      logger.error(LogCategory.AI_SERVICE, 'AI服务初始化失败:', error)
      throw error
    }
  }

  /**
   * 获取当前服务模式
   */
  async getCurrentMode(): Promise<'local' | 'cloud'> {
    const mode = this.configOrchestrator.getValue<'local' | 'cloud'>('AI_SERVICE_MODE')
    return mode === 'cloud' ? 'cloud' : 'local'
  }

  /**
   * 获取当前选中的本地模型ID
   */
  async getSelectedLocalModelId(): Promise<string | null> {
    const modelId = this.configOrchestrator.getValue<string>('SELECTED_MODEL_ID')
    return modelId || null
  }

  /**
   * 获取当前选中的云端配置
   */
  async getSelectedCloudConfig(): Promise<CloudModelConfig | null> {
    try {
      const index = this.configOrchestrator.getValue<number>('SELECTED_CLOUD_CONFIG_INDEX')
      if (index === -1 || index === undefined || index === null) {
        return null
      }
      return await cloudModelConfigService.getConfig(index)
    } catch (error) {
      logger.error(LogCategory.AI_SERVICE, '获取选中的云端配置失败:', error)
      return null
    }
  }

  /**
   * 获取当前AI服务实例
   */
  getCurrentAIService(): ILlamaIndexAIService | null {
    return this.currentService
  }

  /**
   * 获取服务状态
   */
  getServiceStatus(): AIServiceStatus {
    return this.serviceStatus
  }

  /**
   * 获取服务错误信息
   */
  getServiceError(): AIServiceError | null {
    return this.serviceError
  }

  /**
   * 配置变更监听设置
   */
  private setupConfigListeners(): void {
    // 监听服务模式变更
    const unsubscribeMode = this.configOrchestrator.onValueChange<'local' | 'cloud'>(
      'AI_SERVICE_MODE',
      async (mode: 'local' | 'cloud') => {
        logger.info(LogCategory.AI_SERVICE, `AI服务模式变更: ${mode}`)
        this.currentMode = mode
        try {
          await this.initialize()
        } catch (error) {
          logger.error(LogCategory.AI_SERVICE, '处理模式变更失败:', error)
        }
      }
    )
    this.unsubscribers.push(unsubscribeMode)

    // 监听本地模型选择变更
    const unsubscribeLocalModel = this.configOrchestrator.onValueChange<string>(
      'SELECTED_MODEL_ID',
      async (modelId: string) => {
        const mode = await this.getCurrentMode()
        if (mode === 'local') {
          logger.info(LogCategory.AI_SERVICE, `本地模型变更: ${modelId}`)
          try {
            await this.initialize()
          } catch (error) {
            logger.error(LogCategory.AI_SERVICE, '处理本地模型变更失败:', error)
          }
        }
      }
    )
    this.unsubscribers.push(unsubscribeLocalModel)

    // 监听云端配置变更
    const unsubscribeCloudConfig = this.configOrchestrator.onValueChange<number>(
      'SELECTED_CLOUD_CONFIG_INDEX',
      async (index: number) => {
        const mode = await this.getCurrentMode()
        if (mode === 'cloud') {
          logger.info(LogCategory.AI_SERVICE, `云端配置变更: index=${index}`)
          try {
            await this.initialize()
          } catch (error) {
            logger.error(LogCategory.AI_SERVICE, '处理云端配置变更失败:', error)
          }
        }
      }
    )
    this.unsubscribers.push(unsubscribeCloudConfig)
  }

  /**
   * 初始化AI服务
   */
  private async initializeService(): Promise<void> {
    const mode = await this.getCurrentMode()
    
    if (mode === 'local') {
      await this.initializeLocalService()
    } else {
      await this.initializeCloudService()
    }
  }

  /**
   * 初始化本地服务
   */
  private async initializeLocalService(): Promise<void> {
    const modelId = await this.getSelectedLocalModelId()
    if (!modelId) {
      throw new Error(t('未选择本地模型'))
    }

    logger.info(LogCategory.AI_SERVICE, `初始化本地服务: modelId=${modelId}`)
    
    try {
      const aiService = LlamaIndexAIService.getInstance()
      // TODO: 根据需要初始化本地服务
      this.currentService = aiService
    } catch (error) {
      logger.error(LogCategory.AI_SERVICE, '初始化本地服务失败:', error)
      throw error
    }
  }

  /**
   * 初始化云端服务
   */
  private async initializeCloudService(): Promise<void> {
    const cloudConfig = await this.getSelectedCloudConfig()
    if (!cloudConfig) {
      throw new Error(t('未配置云端模型'))
    }

    logger.info(LogCategory.AI_SERVICE, `初始化云端服务: provider=${cloudConfig.provider}`)
    
    try {
      const aiService = LlamaIndexAIService.getInstance()
      // TODO: 根据需要初始化云端服务
      this.currentService = aiService
    } catch (error) {
      logger.error(LogCategory.AI_SERVICE, '初始化云端服务失败:', error)
      throw error
    }
  }

  /**
   * 清理资源
   */
  destroy(): void {
    // 取消所有监听
    this.unsubscribers.forEach(unsubscribe => unsubscribe())
    this.unsubscribers = []
    
    // 清理服务
    this.currentService = null
    this.serviceStatus = AIServiceStatus.STOPPED
    
    logger.info(LogCategory.AI_SERVICE, 'AI服务路由决策管理器已销毁')
  }
}

export const aiServiceRoutingManager = AIServiceRoutingManager.getInstance()

