/**
 * 适配器模式架构测试
 * 验证适配器模式的正确实现和依赖注入机制
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { AIServiceAdapter } from '../ai-service-adapter'
import { getAIAdapterFactory } from '../ai-adapter-factory'
import { LlamaIndexAIAdapter, CoreEngineAIAdapter } from '../llama-index-ai-adapter'
import { LlamaIndexAIService } from '@yonuc/electron-llamaIndex-service'

// Mock LlamaIndexAIService for testing
const mockConfigService = {
  getAIConfig: async () => ({
    mode: 'local' as const,
    local: {
      modelPath: '/test/model.gguf',
      mmprojPath: undefined,
      contextSize: 4096,
      gpuLayers: 0,
      port: 8172
    },
    cloud: {
      provider: 'openai' as const,
      apiKey: '',
      baseUrl: '',
      model: 'gpt-3.5-turbo',
      apiVersion: ''
    }
  })
}

const mockLlamaServerService = {
  start: async () => {},
  stop: async () => {},
  getStatus: () => 'stopped' as const,
  isRunning: () => false,
  getPort: () => 8172,
  checkHealth: async () => ({ healthy: true })
}

describe('适配器模式架构测试', () => {
  beforeEach(() => {
    // 重置单例实例
    LlamaIndexAIService.__dangerouslyResetForTests()
  })

  afterEach(() => {
    // 清理测试后的状态
    LlamaIndexAIService.__dangerouslyResetForTests()
  })

  describe('AIServiceAdapter', () => {
    it('应该创建AI服务适配器并获取单例实例', () => {
      const adapter = new AIServiceAdapter()
      const aiService = adapter.getAIService()
      
      expect(aiService).toBeDefined()
      expect(typeof aiService.getInstance).toBe('function')
    })

    it('应该创建统一服务管理器', () => {
      const adapter = new AIServiceAdapter()
      const unifiedManager = adapter.createUnifiedAIServiceManager()
      
      expect(unifiedManager).toBeDefined()
      expect(typeof unifiedManager.chat).toBe('function')
      expect(typeof unifiedManager.getCapabilities).toBe('function')
      expect(typeof unifiedManager.getStatus).toBe('function')
      expect(typeof unifiedManager.healthCheck).toBe('function')
    })
  })

  describe('AIAdapterFactory', () => {
    it('应该是单例模式', () => {
      const factory1 = getAIAdapterFactory()
      const factory2 = getAIAdapterFactory()
      
      expect(factory1).toBe(factory2)
    })

    it('应该创建各种适配器', () => {
      const factory = getAIAdapterFactory()
      
      const serviceAdapter = factory.createServiceAdapter()
      expect(serviceAdapter).toBeDefined()
      
      const unifiedManager = factory.createUnifiedManager()
      expect(unifiedManager).toBeDefined()
      
      const llamaAdapter = factory.createLlamaAdapter()
      expect(llamaAdapter).toBeDefined()
      
      const coreEngineAdapter = factory.createCoreEngineAdapter()
      expect(coreEngineAdapter).toBeDefined()
    })

    it('应该返回同一个AI服务实例', () => {
      const factory = getAIAdapterFactory()
      
      const aiService1 = factory.getAIService()
      const aiService2 = factory.getAIService()
      
      expect(aiService1).toBe(aiService2)
    })
  })

  describe('LlamaIndexAIAdapter', () => {
    it('应该实现IAIAdapter接口', () => {
      // 创建LlamaIndexAIService实例用于测试
      const aiService = LlamaIndexAIService.getInstance(mockConfigService, mockLlamaServerService as any)
      const adapter = new LlamaIndexAIAdapter(aiService)
      
      expect(typeof adapter.inference).toBe('function')
      expect(typeof adapter.checkHealth).toBe('function')
    })

    it('应该处理推理请求', async () => {
      const aiService = LlamaIndexAIService.getInstance(mockConfigService, mockLlamaServerService as any)
      const adapter = new LlamaIndexAIAdapter(aiService)
      
      const request = {
        prompt: 'Test prompt',
        temperature: 0.7,
        maxTokens: 100
      }
      
      // 由于没有实际的AI服务，这里会返回错误，但应该是结构化的错误响应
      const response = await adapter.inference(request)
      
      expect(response).toBeDefined()
      expect(typeof response.success).toBe('boolean')
      expect(response.success).toBe(false) // 预期失败，因为没有实际的AI服务
      expect(typeof response.error).toBe('string')
    })
  })

  describe('CoreEngineAIAdapter', () => {
    it('应该实现依赖注入接口', () => {
      const adapter = new CoreEngineAIAdapter()
      
      expect(typeof adapter.injectAIService).toBe('function')
      expect(typeof adapter.removeAIService).toBe('function')
      expect(typeof adapter.getUnifiedManager).toBe('function')
      expect(typeof adapter.getServiceAdapter).toBe('function')
    })

    it('应该创建统一管理器', () => {
      const adapter = new CoreEngineAIAdapter()
      const serviceAdapter = adapter.getServiceAdapter()
      
      expect(serviceAdapter).toBeDefined()
      expect(typeof serviceAdapter.getAIService).toBe('function')
      expect(typeof serviceAdapter.createUnifiedAIServiceManager).toBe('function')
    })
  })

  describe('适配器模式集成测试', () => {
    it('应该通过工厂创建完整的适配器链', () => {
      const factory = getAIAdapterFactory()
      
      // 创建服务适配器
      const serviceAdapter = factory.createServiceAdapter()
      const aiService = serviceAdapter.getAIService()
      
      // 创建统一管理器
      const unifiedManager = serviceAdapter.createUnifiedAIServiceManager()
      
      // 创建LlamaIndex适配器
      const llamaAdapter = factory.createLlamaAdapter()
      
      // 验证所有组件都正确创建
      expect(aiService).toBeDefined()
      expect(unifiedManager).toBeDefined()
      expect(llamaAdapter).toBeDefined()
      
      // 验证它们都基于同一个AI服务实例
      expect(aiService).toBe(factory.getAIService())
    })

    it('应该支持Core Engine的依赖注入', () => {
      const factory = getAIAdapterFactory()
      const coreEngineAdapter = factory.createCoreEngineAdapter()
      
      // 模拟Core Engine对象
      const mockCoreEngine = {
        setAIAdapter: (adapter: any) => {
          expect(adapter).toBeDefined()
        }
      }
      
      // 测试依赖注入
      expect(() => {
        coreEngineAdapter.injectAIService(mockCoreEngine as any)
      }).not.toThrow()
      
      // 测试依赖移除
      expect(() => {
        coreEngineAdapter.removeAIService(mockCoreEngine as any)
      }).not.toThrow()
    })
  })
})