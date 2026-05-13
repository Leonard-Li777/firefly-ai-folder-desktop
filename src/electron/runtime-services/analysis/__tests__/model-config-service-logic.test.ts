import { describe, it, expect, vi, beforeEach } from 'vitest'

// 必须在任何服务加载前进行 mock
vi.mock('@app/languages', () => ({
  t: (s: string) => s,
  default: { t: (s: string) => s }
}))

vi.mock('../../../config/config-service', () => ({
  configService: { getValue: vi.fn(() => ({})) }
}))

import { ModelConfigService } from '../model-config-service'

describe('ModelConfigService 逻辑验证', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('应该能够获取单例实例', () => {
    const instance = ModelConfigService.getInstance()
    expect(instance).toBeDefined()
    expect(typeof instance.loadModelConfig).toBe('function')
  })

  it('应该能加载模型配置', () => {
    const instance = ModelConfigService.getInstance()
    const configs = instance.loadModelConfig('en-US')
    expect(Array.isArray(configs)).toBe(true)
  })
})
