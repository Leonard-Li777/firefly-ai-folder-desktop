/**
 * AI服务适配器
 * 实现适配器模式，提供统一的AI服务接口
 * 确保全局只有一个LlamaIndexAIService实例，并提供依赖注入机制
 */

import type { 
  ILlamaIndexAIService, 
  AIServiceStatus, 
  AICapabilities, 
  AIChatMessage, 
  ChatResponse 
} from '@yonuc/types'
import { LlamaIndexAIService } from '@yonuc/electron-llamaIndex-service'
import { logger, LogCategory } from '@yonuc/shared'

/**
 * AI服务适配器接口
 * 提供统一的服务接口，隐藏底层实现差异
 */
export interface IAIServiceAdapter {
  /**
   * 获取AI服务实例
   */
  getAIService(): ILlamaIndexAIService

  /**
   * 创建统一服务管理器
   */
  createUnifiedAIServiceManager(): IUnifiedAIServiceManager
}

/**
 * 统一AI服务管理器接口
 * 提供一致的接口，隐藏底层实现差异
 */
export interface IUnifiedAIServiceManager {
  /**
   * AI对话接口
   */
  chat(messages: AIChatMessage[]): Promise<ChatResponse>

  /**
   * 获取AI能力
   */
  getCapabilities(): Promise<AICapabilities>

  /**
   * 获取服务状态
   */
  getStatus(): AIServiceStatus

  /**
   * 健康检查
   */
  healthCheck(): Promise<boolean>

  /**
   * 初始化服务
   */
  initialize(): Promise<void>

  /**
   * 停止服务
   */
  stop(): Promise<void>

  /**
   * 重启服务
   */
  restart(): Promise<void>

  /**
   * 销毁服务
   */
  destroy(): Promise<void>

  /**
   * 生命周期管理配置
   */
  setHealthCheckInterval(intervalMs: number): void
  setAutoRestartConfig(enabled: boolean, maxAttempts?: number): void

  /**
   * 生命周期状态查询
   */
  getLifecycleStatus(): any
  performHealthCheck(): Promise<any>
}

/**
 * AI服务适配器实现类
 * 确保获取单例实例，实现依赖注入机制
 */
export class AIServiceAdapter implements IAIServiceAdapter {
  private aiService?: ILlamaIndexAIService

  constructor() {
    // 延迟获取单例实例，避免在单例未初始化时调用
    if (logger) {
      logger.debug(LogCategory.AI_SERVICE, '[AIServiceAdapter] AI服务适配器已创建')
    }
  }

  /**
   * 获取AI服务实例（延迟获取，确保单例已初始化）
   */
  getAIService(): ILlamaIndexAIService {
    if (!this.aiService) {
      this.aiService = LlamaIndexAIService.getInstance()
    }
    return this.aiService
  }

  /**
   * 创建统一服务管理器
   */
  createUnifiedAIServiceManager(): IUnifiedAIServiceManager {
    return new UnifiedAIServiceManagerImpl(this.getAIService())
  }
}

/**
 * 统一AI服务管理器实现类
 * 提供一致的接口行为，隐藏底层实现差异
 */
class UnifiedAIServiceManagerImpl implements IUnifiedAIServiceManager {
  constructor(private aiService: ILlamaIndexAIService) {
    if (logger) {
      logger.debug(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] 统一服务管理器已创建')
    }
  }

  /**
   * AI对话接口
   * 统一的聊天接口，隐藏底层实现差异
   */
  async chat(messages: AIChatMessage[]): Promise<ChatResponse> {
    try {
      logger.debug(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] 执行AI对话:', {
        messageCount: messages.length
      })

      // 调用LlamaIndexAIService的chat方法
      const response = await this.aiService.chat(messages, false)

      logger.debug(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] AI对话完成:', {
        success: response.success,
        responseLength: response.message?.length || 0,
        hasError: !!response.error
      })

      return response
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] AI对话异常:', errorMessage)

      return {
        message: '',
        success: false,
        error: errorMessage,
        processingTime: 0
      }
    }
  }

  /**
   * 获取AI能力
   */
  async getCapabilities(): Promise<AICapabilities> {
    try {
      logger.debug(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] 获取AI能力')

      const capabilities = await this.aiService.getCapabilities()

      logger.debug(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] AI能力获取完成:', {
        supportsText: capabilities.supportsText,
        supportsImage: capabilities.supportsImage,
        supportsAudio: capabilities.supportsAudio,
        supportsVideo: capabilities.supportsVideo,
        modelName: capabilities.modelName,
        provider: capabilities.provider
      })

      return capabilities
    } catch (error) {
      logger.error(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] 获取AI能力失败:', error)
      
      // 返回默认能力（至少支持文本）
      return {
        supportsText: true,
        supportsImage: false,
        supportsAudio: false,
        supportsVideo: false,
        maxContextSize: 4096,
        modelName: 'unknown',
        provider: 'unknown'
      }
    }
  }

  /**
   * 获取服务状态
   */
  getStatus(): AIServiceStatus {
    return this.aiService.getServiceStatus()
  }

  /**
   * 健康检查
   */
  async healthCheck(): Promise<boolean> {
    try {
      logger.debug(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] 执行健康检查')

      const healthy = await this.aiService.healthCheck()

      logger.debug(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] 健康检查完成:', { healthy })

      return healthy
    } catch (error) {
      logger.error(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] 健康检查异常:', error)
      return false
    }
  }

  /**
   * 初始化服务
   */
  async initialize(): Promise<void> {
    try {
      logger.info(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] 初始化AI服务')

      await this.aiService.initialize()

      logger.info(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] AI服务初始化完成')
    } catch (error) {
      logger.error(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] AI服务初始化失败:', error)
      throw error
    }
  }

  /**
   * 停止服务
   */
  async stop(): Promise<void> {
    try {
      logger.info(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] 停止AI服务')

      await this.aiService.stop()

      logger.info(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] AI服务已停止')
    } catch (error) {
      logger.error(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] 停止AI服务失败:', error)
      throw error
    }
  }

  /**
   * 重启服务
   */
  async restart(): Promise<void> {
    try {
      logger.info(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] 重启AI服务')

      await this.aiService.restart()

      logger.info(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] AI服务重启完成')
    } catch (error) {
      logger.error(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] 重启AI服务失败:', error)
      throw error
    }
  }

  /**
   * 销毁服务
   */
  async destroy(): Promise<void> {
    try {
      logger.info(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] 销毁AI服务')

      await this.aiService.destroy()

      logger.info(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] AI服务已销毁')
    } catch (error) {
      logger.error(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] 销毁AI服务失败:', error)
      throw error
    }
  }

  /**
   * 配置健康检查间隔
   */
  setHealthCheckInterval(intervalMs: number): void {
    if (this.aiService.setHealthCheckInterval) {
      this.aiService.setHealthCheckInterval(intervalMs)
      logger.debug(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] 健康检查间隔已配置:', { intervalMs })
    }
  }

  /**
   * 配置自动重启
   */
  setAutoRestartConfig(enabled: boolean, maxAttempts?: number): void {
    if (this.aiService.setAutoRestartConfig) {
      this.aiService.setAutoRestartConfig(enabled, maxAttempts)
      logger.debug(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] 自动重启配置已更新:', { enabled, maxAttempts })
    }
  }

  /**
   * 获取生命周期状态
   */
  getLifecycleStatus(): any {
    if (this.aiService.getLifecycleStatus) {
      return this.aiService.getLifecycleStatus()
    }
    return null
  }

  /**
   * 手动执行健康检查
   */
  async performHealthCheck(): Promise<any> {
    if (this.aiService.performHealthCheck) {
      return await this.aiService.performHealthCheck()
    }
    
    // 回退到基本健康检查
    const healthy = await this.healthCheck()
    return {
      healthy,
      timestamp: new Date()
    }
  }
}