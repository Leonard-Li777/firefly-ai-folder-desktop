import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

let mockIsPackaged = false

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mockIsPackaged
    },
    getPath: vi.fn(() => 'C:\\test'),
    getName: vi.fn(() => 'firefly'),
    setName: vi.fn(),
    setPath: vi.fn()
  }
}))

import { isLocalDevRuntime } from '../worktree-env'

describe('worktree-env: isLocalDevRuntime', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
    mockIsPackaged = false
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    mockIsPackaged = false
    vi.restoreAllMocks()
  })

  it('当 app.isPackaged 为 true 时，无论环境变量为何均一票否决返回 false', () => {
    mockIsPackaged = true
    process.env.NODE_ENV = 'development'
    delete process.env.VITEST

    expect(isLocalDevRuntime()).toBe(false)
  })

  it('当处于单测态 (NODE_ENV=test 或 VITEST) 时，坚决返回 false 避免定时器泄漏', () => {
    mockIsPackaged = false

    process.env.NODE_ENV = 'test'
    expect(isLocalDevRuntime()).toBe(false)

    process.env.NODE_ENV = 'development'
    process.env.VITEST = 'true'
    expect(isLocalDevRuntime()).toBe(false)
  })

  it('当处于集成测试态 (IS_INTEGRATION_TEST=true) 时，返回 false', () => {
    mockIsPackaged = false
    process.env.NODE_ENV = 'development'
    delete process.env.VITEST
    process.env.IS_INTEGRATION_TEST = 'true'

    expect(isLocalDevRuntime()).toBe(false)
  })

  it('当 NODE_ENV=production 时，返回 false', () => {
    mockIsPackaged = false
    process.env.NODE_ENV = 'production'
    delete process.env.VITEST

    expect(isLocalDevRuntime()).toBe(false)
  })

  it('当未打包、非测试、非生产环境时，允许放行返回 true', () => {
    mockIsPackaged = false
    process.env.NODE_ENV = 'development'
    delete process.env.VITEST
    delete process.env.IS_INTEGRATION_TEST

    expect(isLocalDevRuntime()).toBe(true)
  })
})
