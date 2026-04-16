/**
 * 统一AI服务管理器
 * 基于LlamaIndexAIService单例的统一服务包装器
 * 提供与主进程兼容的接口，确保Core Engine与AI服务的解耦
 */

import { 
  AIServiceStatus 
} from '@yonuc/types'
import type { 
  ILlamaIndexAIService, 
  AICapabilities, 
  AIChatMessage, 
  ChatResponse 
} from '@yonuc/types'
import { LlamaIndexAIService } from '@yonuc/electron-llamaIndex-service'
import { logger, LogCategory } from '@yonuc/shared'

/**
 * 统一AI服务管理器类
 * 基于LlamaIndexAIService单例，提供统一的服务包装
 * 确保Core Engine与AI服务的解耦（需求10.2: 保持core-engine的纯净性）
 */
class UnifiedAIServiceManager {
  private aiService?: ILlamaIndexAIService
  private isInitialized = false
  private isInitializing = false
  
  // 初始化状态跟踪
  private initializationStartTime?: number
  private initializationAttempts = 0
  private lastInitializationError?: Error
  
  // 防止重复初始化的锁
  private initializationPromise?: Promise<void>

  constructor() {
    // 延迟获取LlamaIndexAIService单例实例，避免在单例未初始化时调用
    // 在实际使用时通过 getAIService() 方法获取实例
    if (logger) {
      logger.debug(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] 统一AI服务管理器已创建')
    }
  }

  /**
   * 获取AI服务实例（延迟获取，确保单例已初始化）
   */
  private getAIServiceInstance(): ILlamaIndexAIService {
    if (!this.aiService) {
      this.aiService = LlamaIndexAIService.getInstance()
    }
    return this.aiService!
  }

  /**
   * 初始化AI服务
   */
  async initialize(): Promise<void> {
    // 如果已经初始化，直接返回
    if (this.isInitialized) {
      logger.info(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] AI服务已初始化，跳过重复初始化')
      return
    }

    // 获取AI服务实例
    const aiService = this.getAIServiceInstance()

    // 如果正在初始化，等待现有的初始化完成
    if (this.isInitializing && this.initializationPromise) {
      logger.info(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] AI服务正在初始化中，等待完成...')
      await this.initializationPromise
      return
    }

    // 创建初始化Promise，防止并发初始化
    this.initializationPromise = this.performInitialization()
    await this.initializationPromise
  }

  /**
   * 执行实际的初始化操作
   */
  private async performInitialization(): Promise<void> {
    try {
      this.isInitializing = true
      this.initializationStartTime = Date.now()
      this.initializationAttempts++
      
      logger.info(LogCategory.AI_SERVICE, `[UnifiedAIServiceManager] 开始初始化AI服务... (尝试 ${this.initializationAttempts})`)

      // 直接使用LlamaIndexAIService单例进行初始化
      const aiService = this.getAIServiceInstance()
      logger.debug(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] 初始化LlamaIndexAIService单例...')
      await aiService.initialize()
      logger.debug(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] LlamaIndexAIService单例初始化完成')

      this.isInitialized = true
      this.lastInitializationError = undefined
      
      const initTime = Date.now() - (this.initializationStartTime || 0)
      logger.info(LogCategory.AI_SERVICE, `[UnifiedAIServiceManager] AI服务初始化成功 (耗时: ${initTime}ms, 尝试次数: ${this.initializationAttempts})`)
    } catch (error) {
      this.lastInitializationError = error instanceof Error ? error : new Error(String(error))
      logger.error(LogCategory.AI_SERVICE, `[UnifiedAIServiceManager] AI服务初始化失败 (尝试 ${this.initializationAttempts}):`, error)
      throw error
    } finally {
      this.isInitializing = false
      this.initializationPromise = undefined
    }
  }

  /**
   * 检查服务是否已初始化
   */
  isServiceInitialized(): boolean {
    return this.isInitialized && this.getAIServiceInstance().isInitialized()
  }

  /**
   * 获取AI服务实例（公共方法）
   */
  getAIService(): ILlamaIndexAIService {
    return this.getAIServiceInstance()
  }

  /**
   * 处理模型切换通知（懒加载机制）
   */
  async onModelChanged(modelId: string): Promise<void> {
    if (!this.isInitialized) {
      logger.info(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] AI服务未初始化，尝试进行初始化...')
      await this.initialize()
    }

    try {
      logger.info(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] 处理模型切换通知:', modelId)
      
      // 使用LlamaIndexAIService的模型切换方法
      const aiService = this.getAIServiceInstance()
      if ('onModelChanged' in aiService && typeof aiService.onModelChanged === 'function') {
        await aiService.onModelChanged(modelId)
      } else {
        // 如果没有专门的模型切换方法，重新加载配置
        await aiService.reloadConfig()
      }
      
      logger.info(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] 模型切换处理完成')
    } catch (error) {
      logger.error(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] 处理模型切换失败:', error)
      throw error
    }
  }

  /**
   * 获取服务状态
   */
  getStatus(): AIServiceStatus {
    return this.getAIServiceInstance().getServiceStatus()
  }

  /**
   * 获取AI能力
   */
  async getCapabilities(): Promise<AICapabilities> {
    return await this.getAIServiceInstance().getCapabilities()
  }

  /**
   * AI对话接口
   */
  async chat(messages: AIChatMessage[], stream = false): Promise<ChatResponse> {
    if (!this.isInitialized) {
      logger.info(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] AI服务未初始化，尝试进行初始化...')
      await this.initialize()
    }

    return await this.getAIServiceInstance().chat(messages, stream)
  }

  /**
   * 检查服务健康状态
   */
  async checkHealth(): Promise<{ healthy: boolean; error?: string }> {
    if (!this.isInitialized) {
      return {
        healthy: false,
        error: 'AI服务未初始化'
      }
    }

    try {
      const healthy = await this.getAIServiceInstance().healthCheck()
      return { healthy }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] 健康检查失败:', errorMessage)
      return {
        healthy: false,
        error: errorMessage
      }
    }
  }

  /**
   * 获取初始化状态信息
   */
  getInitializationInfo(): {
    isInitialized: boolean
    isInitializing: boolean
    attempts: number
    lastError?: string
    initTime?: number
  } {
    return {
      isInitialized: this.isInitialized,
      isInitializing: this.isInitializing,
      attempts: this.initializationAttempts,
      lastError: this.lastInitializationError?.message,
      initTime: this.initializationStartTime ? Date.now() - this.initializationStartTime : undefined
    }
  }

  /**
   * 重置初始化状态（用于测试或故障恢复）
   */
  resetInitializationState(): void {
    logger.warn(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] 重置初始化状态')
    this.isInitialized = false
    this.isInitializing = false
    this.initializationAttempts = 0
    this.lastInitializationError = undefined
    this.initializationStartTime = undefined
    this.initializationPromise = undefined
  }

  /**
   * 释放资源
   */
  async dispose(): Promise<void> {
    try {
      logger.info(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] 开始释放AI服务资源...')

      if (this.isInitialized) {
        // 停止AI服务
        await this.getAIServiceInstance().stop()
      }

      // 清理所有状态
      this.resetInitializationState()

      logger.info(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] AI服务资源释放完成')
    } catch (error) {
      logger.error(LogCategory.AI_SERVICE, '[UnifiedAIServiceManager] 释放AI服务资源失败:', error)
      throw error
    }
  }
}

// 导出单例实例
export const unifiedAIService = new UnifiedAIServiceManager()

// 默认导出
export default unifiedAIService