/**
 * AI适配器工厂
 * 提供统一的适配器创建和管理接口
 * 实现依赖注入机制的工厂模式
 */

import type { ICoreEngine } from '@firefly/core-engine'
import type { ILlamaIndexAIService } from '@firefly/types'
import { LlamaIndexAIService } from '@firefly/electron-llamaIndex-service'
import fixPath from 'fix-path'

// 在 macOS 和 Linux 上修复 PATH 环境变量
if (process.platform !== 'win32') {
  try {
    const fixPathFunc = typeof fixPath === 'function' ? fixPath : (fixPath as any).default
    if (typeof fixPathFunc === 'function') {
      fixPathFunc()
    }
  } catch (e) {
    console.error('Failed to fix PATH in AIAdapterFactory:', e)
  }
}
import {
  LlamaIndexAIAdapter,
  CoreEngineAIAdapter,
  type ILlamaIndexAIAdapter
} from './llama-index-ai-adapter'
import { logger, LogCategory, isTestEnvironment } from '@firefly/shared'
import { t } from '@app/languages'

/**
 * AI适配器工厂接口
 */
export interface IAIAdapterFactory {
  /**
   * 创建AI服务适配器
   */
  createServiceAdapter(): any

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
   * @deprecated 使用 getAIService 直接获取服务
   */
  createServiceAdapter(): any {
    return {
      getAIService: () => this.getAIService()
    }
  }

  /**
   * 创建LlamaIndex AI适配器
   *
   * 【不可回退为 `new LlamaIndexAIAdapter(this.getAIServiceInstance())`】
   * 该写法会在 AI 服务单例尚未创建时**立刻抛错**，进而使整个
   * `createCoreEngineAdapters()` 失败、`AnalysisQueueService` 闭包内
   * 的 `dimensionAnalyzer` / `fileProcessorService` 永久为空，
   * 此后每个文件都会以「AI 服务未就绪」失败（须重启应用才能恢复）。
   * 运行期实证见 app.log 中 `[分析队列] 适配器创建失败` 的调用栈。
   *
   * `LlamaIndexAIAdapter` 的构造签名本就允许 null，且其内部
   * `getService()` 在每次推理时都会重新尝试解析单例 —— 因此这里
   * 传 null 是最小且正确的语义：适配器结构照常组装，AI 调用可用性
   * 推迟到真实推理时判定，不再毒化整条适配器创建链路。
   */
  createLlamaAdapter(): LlamaIndexAIAdapter {
    const instance = LlamaIndexAIService.getInstance()
    if (!instance) {
      logger.warn(
        LogCategory.AI_SERVICE,
        '[AIAdapterFactory] AI服务单例尚未就绪，先组装适配器，延迟到推理时再解析'
      )
    }

    const llamaAdapter = new LlamaIndexAIAdapter(instance ?? undefined)

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
    if (isTestEnvironment()) {
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
