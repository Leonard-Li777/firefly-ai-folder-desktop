import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ModelService } from './model-service'

// 由于 ModelService 可能在构造函数或静态初始化中调用 Electron API
// 我们需要确保在导入之前已经应用了 Mock (已在 test-setup.ts 中全局应用)

describe('ModelService VRAM Calculation', () => {
  let modelService: ModelService

  beforeEach(() => {
    vi.clearAllMocks()
    modelService = new ModelService()
  })

  it('should calculate VRAM requirements correctly', () => {
    const models = modelService.listModels()
    
    // Check that all models have vramRequiredGB property
    expect(models.every(model => model.vramRequiredGB !== undefined)).toBe(true)
    
    // Check specific models
    const gemmaVLModel = models.find(m => m.id === 'gemma-3-vl-4b-q4_0')
    expect(gemmaVLModel).toBeDefined()
    expect(gemmaVLModel?.vramRequiredGB).toBeCloseTo(3.76, 2)
    
    const qwenModel = models.find(m => m.id === 'qwen3-4b')
    expect(qwenModel).toBeDefined()
    expect(qwenModel?.vramRequiredGB).toBeCloseTo(1.58, 2)
  })

  it('should sort models by VRAM requirements', () => {
    const models = modelService.listModels()
    
    // Check that models are sorted by VRAM requirements (ascending)
    for (let i = 1; i < models.length; i++) {
      expect(models[i-1].vramRequiredGB).toBeLessThanOrEqual(models[i].vramRequiredGB)
    }
  })
})