/**
 * AI适配器工厂
 * 提供统一的适配器创建和管理接口
 * 实现依赖注入机制的工厂模式
 */

import type { ICoreEngine } from '@yonuc/core-engine'
import type { ILlamaIndexAIService } from '@yonuc/types'
import { LlamaIndexAIService } from '@yonuc/electron-llamaIndex-service'
import fixPath from 'fix-path'

// 在 macOS 和 Linux 上修复 PATH 环境变量
if (process.platform !== 'win32') {
  try {
    const fixPathFunc = typeof fixPath === 'function' ? fixPath : (fixPath as any).default;
    if (typeof fixPathFunc === 'function') {
      fixPathFunc();
    }
  } catch (e) {
    console.error('Failed to fix PATH in AIAdapterFactory:', e);
  }
}
import { 
  AIServiceAdapter, 
  type IAIServiceAdapter, 
  type IUnifiedAIServiceManager 
} from '../runtime-services/ai/ai-service-adapter'
import { 
  LlamaIndexAIAdapter, 
  CoreEngineAIAdapter, 
  type ILlamaIndexAIAdapter 
} from './llama-index-ai-adapter'
import { logger, LogCategory } from '@yonuc/shared'
import { t } from '@app/languages';

/**
 * AI适配器工厂接口
 */
export interface IAIAdapterFactory {
  /**
   * 创建AI服务适配器
   */
  createServiceAdapter(): IAIServiceAdapter

  /**
   * 创建统一服务管理器
   */
  createUnifiedManager(): IUnifiedAIServiceManager

  /**
   * 创建LlamaIndex AI适配器
   */
  createLlamaAdapter(): LlamaIndexAIAdapter

  /**
   * 创建Core Engine AI适配器
   */
  createCoreEngineAdapter(): ILlamaIndexAIAdapter

  /**
   * 获取AI服务单例
   */
  getAIService(): ILlamaIndexAIService
}

/**
 * AI适配器工厂实现类
 * 确保所有适配器都基于同一个LlamaIndexAIService单例
 */
export class AIAdapterFactory implements IAIAdapterFactory {
  private static instance: AIAdapterFactory | null = null
  private aiService!: ILlamaIndexAIService
  private serviceAdapter: IAIServiceAdapter | null = null
  private coreEngineAdapter: ILlamaIndexAIAdapter | null = null

  private constructor() {
    // 延迟获取LlamaIndexAIService单例实例，避免在单例未初始化时调用
    logger.debug(LogCategory.AI_SERVICE, '[AIAdapterFactory] AI适配器工厂已创建')
  }

  /**
   * 获取AI服务实例（延迟获取，确保单例已初始化）
   */
  private getAIServiceInstance(): ILlamaIndexAIService {
    if (!this.aiService) {
      const instance = LlamaIndexAIService.getInstance()
      if (instance) {
        this.aiService = instance
      } else {
        logger.warn(LogCategory.AI_SERVICE, '[AIAdapterFactory] AI服务单例尚未就绪，将在后续重试')
        // 返回一个提示性错误，避免阻塞其他服务的初始化
        throw new Error(t('AI服务未就绪，请稍后重试'))
      }
    }
    return this.aiService
  }

  /**
   * 获取工厂单例实例
   */
  public static getInstance(): AIAdapterFactory {
    if (!AIAdapterFactory.instance) {
      AIAdapterFactory.instance = new AIAdapterFactory()
    }
    return AIAdapterFactory.instance
  }

  /**
   * 创建AI服务适配器
   */
  createServiceAdapter(): IAIServiceAdapter {
    if (!this.serviceAdapter) {
      this.serviceAdapter = new AIServiceAdapter()
      logger.debug(LogCategory.AI_SERVICE, '[AIAdapterFactory] AI服务适配器已创建')
    }
    return this.serviceAdapter
  }

  /**
   * 创建统一服务管理器
   */
  createUnifiedManager(): IUnifiedAIServiceManager {
    const serviceAdapter = this.createServiceAdapter()
    const unifiedManager = serviceAdapter.createUnifiedAIServiceManager()
    
    logger.debug(LogCategory.AI_SERVICE, '[AIAdapterFactory] 统一服务管理器已创建')
    return unifiedManager
  }

  /**
   * 创建LlamaIndex AI适配器
   */
  createLlamaAdapter(): LlamaIndexAIAdapter {
    const llamaAdapter = new LlamaIndexAIAdapter(this.getAIServiceInstance())
    
    logger.debug(LogCategory.AI_SERVICE, '[AIAdapterFactory] LlamaIndex AI适配器已创建')
    return llamaAdapter
  }

  /**
   * 创建Core Engine AI适配器
   */
  createCoreEngineAdapter(): ILlamaIndexAIAdapter {
    if (!this.coreEngineAdapter) {
      this.coreEngineAdapter = new CoreEngineAIAdapter()
      logger.debug(LogCategory.AI_SERVICE, '[AIAdapterFactory] Core Engine AI适配器已创建')
    }
    return this.coreEngineAdapter
  }

  /**
   * 获取AI服务单例
   */
  getAIService(): ILlamaIndexAIService {
    return this.getAIServiceInstance()
  }

  /**
   * 一键设置Core Engine的AI服务
   * 简化依赖注入过程
   */
  setupCoreEngineAI(coreEngine: ICoreEngine): void {
    try {
      logger.info(LogCategory.AI_SERVICE, '[AIAdapterFactory] 开始设置Core Engine AI服务')

      const coreEngineAdapter = this.createCoreEngineAdapter()
      coreEngineAdapter.injectAIService(coreEngine)

      logger.info(LogCategory.AI_SERVICE, '[AIAdapterFactory] Core Engine AI服务设置完成')
    } catch (error) {
      logger.error(LogCategory.AI_SERVICE, '[AIAdapterFactory] Core Engine AI服务设置失败:', error)
      throw error
    }
  }

  /**
   * 清理Core Engine的AI服务
   */
  cleanupCoreEngineAI(coreEngine: ICoreEngine): void {
    try {
      logger.info(LogCategory.AI_SERVICE, '[AIAdapterFactory] 开始清理Core Engine AI服务')

      if (this.coreEngineAdapter) {
        this.coreEngineAdapter.removeAIService(coreEngine)
      }

      logger.info(LogCategory.AI_SERVICE, '[AIAdapterFactory] Core Engine AI服务清理完成')
    } catch (error) {
      logger.error(LogCategory.AI_SERVICE, '[AIAdapterFactory] Core Engine AI服务清理失败:', error)
      throw error
    }
  }

  /**
   * 重置工厂实例（仅用于测试）
   */
  public static __dangerouslyResetForTests(): void {
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
      AIAdapterFactory.instance = null
    }
  }
}

/**
 * 便捷函数：获取AI适配器工厂实例
 */
export function getAIAdapterFactory(): AIAdapterFactory {
  return AIAdapterFactory.getInstance()
}

/**
 * 便捷函数：快速设置Core Engine AI服务
 */
export function setupCoreEngineAI(coreEngine: ICoreEngine): void {
  const factory = getAIAdapterFactory()
  factory.setupCoreEngineAI(coreEngine)
}

/**
 * 便捷函数：快速清理Core Engine AI服务
 */
export function cleanupCoreEngineAI(coreEngine: ICoreEngine): void {
  const factory = getAIAdapterFactory()
  factory.cleanupCoreEngineAI(coreEngine)
}