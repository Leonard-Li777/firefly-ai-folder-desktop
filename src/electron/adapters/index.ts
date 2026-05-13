/**
 * 核心引擎适配器导出
 * 将应用服务适配到核心引擎接口
 */

export * from './logger-adapter'
export * from './filesystem-adapter'
export * from './llama-index-ai-adapter'
export * from './database-adapter'
export * from './config-adapter'
export * from './model-capability-adapter'
export * from './event-emitter-adapter'
export * from './ai-adapter-factory'

import { createLoggerAdapter } from './logger-adapter'
import { createFileSystemAdapter } from './filesystem-adapter'
import { createDatabaseAdapter } from './database-adapter'
import { createConfigAdapter } from './config-adapter'
import { createModelCapabilityAdapter } from './model-capability-adapter'
import { createEventEmitterAdapter } from './event-emitter-adapter'
// 导入适配器工厂和相关适配器
import { LlamaIndexAIAdapter } from './llama-index-ai-adapter'
import { LlamaRuntimeBridgeAdapter } from './llama-runtime-bridge-adapter'
import { getAIAdapterFactory } from './ai-adapter-factory'
import { AIHelper } from '@yonuc/core-engine'
import type { ICoreEngineAdapters } from '@yonuc/core-engine'
import type { ILlamaIndexAIService } from '@yonuc/types'

/**
 * 创建所有适配器
 * 使用适配器工厂确保单例模式和依赖注入的正确性
 */
export async function createCoreEngineAdapters(): Promise<ICoreEngineAdapters> {
  const databaseAdapter = await createDatabaseAdapter()
  
  // 使用适配器工厂创建AI适配器（需求10.1, 10.2, 10.3: 适配器模式和架构解耦）
  const aiAdapterFactory = getAIAdapterFactory()
  const aiAdapter = aiAdapterFactory.createLlamaAdapter()

  // 创建运行时桥接适配器
  const llamaRuntimeAdapter = new LlamaRuntimeBridgeAdapter(aiAdapter)

  const modelCapability = createModelCapabilityAdapter()

  return {
    logger: createLoggerAdapter(),
    fileSystem: createFileSystemAdapter(),
    llamaRuntime: llamaRuntimeAdapter,
    database: databaseAdapter,
    config: createConfigAdapter(),
    modelCapability: modelCapability,
    eventEmitter: createEventEmitterAdapter(),
    aiHelper: new AIHelper(modelCapability)
  }
}

/**
 * 创建带有指定AI服务的适配器（用于测试或特殊场景）
 */
export async function createCoreEngineAdaptersWithAIService(aiService: ILlamaIndexAIService): Promise<ICoreEngineAdapters> {
  const databaseAdapter = await createDatabaseAdapter()
  
  // 使用指定的AI服务创建适配器
  const aiAdapter = new LlamaIndexAIAdapter(aiService)
  const llamaRuntimeAdapter = new LlamaRuntimeBridgeAdapter(aiAdapter)

  const modelCapability = createModelCapabilityAdapter()

  return {
    logger: createLoggerAdapter(),
    fileSystem: createFileSystemAdapter(),
    llamaRuntime: llamaRuntimeAdapter,
    database: databaseAdapter,
    config: createConfigAdapter(),
    modelCapability: modelCapability,
    eventEmitter: createEventEmitterAdapter(),
    aiHelper: new AIHelper(modelCapability)
  }
}
