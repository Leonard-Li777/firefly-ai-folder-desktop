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

import {
  isLocalDevRuntime,
  initWorktreeEnvironment,
  resolveAppRegion,
  checkPeerRegionDataPresence,
  _resetCachedInfoForTesting
} from '../worktree-env'

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

describe('worktree-env: initWorktreeEnvironment 主分支与特性分支统一命名规则', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
    mockIsPackaged = false
    _resetCachedInfoForTesting()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    mockIsPackaged = false
    _resetCachedInfoForTesting()
    vi.restoreAllMocks()
  })

  it('当处于主分支 (WORKTREE_NAME=main 或 master) 时，开发模式 appName 严禁带 _main/_master 后缀', () => {
    mockIsPackaged = false
    process.env.BUILD_REGION = 'cn'
    process.env.APP_ENV = 'development'
    process.env.WORKTREE_NAME = 'main'

    const info = initWorktreeEnvironment()
    expect(info.appName).toBe('firefly-ai-folder_v4_cn_development')
    expect(info.appName).not.toContain('_main')
    expect(process.env.WORKTREE_NAME).toBeUndefined()
  })

  it('当处于 master 分支时，开发模式 appName 同样不带 _master 后缀', () => {
    mockIsPackaged = false
    process.env.BUILD_REGION = 'intl'
    process.env.APP_ENV = 'development'
    process.env.WORKTREE_NAME = 'master'

    const info = initWorktreeEnvironment()
    expect(info.appName).toBe('firefly-ai-folder_v4_intl_development')
    expect(info.appName).not.toContain('_master')
    expect(process.env.WORKTREE_NAME).toBeUndefined()
  })

  it('当处于特性隔离分支 (如 pay) 时，appName 忠实保留特性隔离后缀', () => {
    mockIsPackaged = false
    process.env.BUILD_REGION = 'cn'
    process.env.APP_ENV = 'development'
    process.env.WORKTREE_NAME = 'pay'

    const info = initWorktreeEnvironment()
    expect(info.appName).toBe('firefly-ai-folder_v4_cn_development_pay')
    expect(process.env.WORKTREE_NAME).toBe('pay')
  })
})

describe('worktree-env: resolveAppRegion 决议顺序四级加固 (ISS-03)', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    process.env = { ...originalEnv }
    delete process.env.APP_REGION
    delete process.env.BUILD_REGION
    _resetCachedInfoForTesting()
  })

  afterEach(() => {
    process.env = { ...originalEnv }
    delete (globalThis as any).__BUILD_REGION__
    _resetCachedInfoForTesting()
    vi.restoreAllMocks()
  })

  it('1. 编译期注入常量 __BUILD_REGION__ 具备最高优先级 (免误删、免杀软清理)', () => {
    ;(globalThis as any).__BUILD_REGION__ = 'CN'
    process.env.APP_REGION = 'intl'
    expect(resolveAppRegion()).toBe('cn')
    ;(globalThis as any).__BUILD_REGION__ = 'INTL'
    process.env.APP_REGION = 'cn'
    expect(resolveAppRegion()).toBe('intl')
  })

  it('2. 当 __BUILD_REGION__ 未注入时，正常向下回退至环境变量 APP_REGION / BUILD_REGION', () => {
    delete (globalThis as any).__BUILD_REGION__
    process.env.APP_REGION = 'cn'
    expect(resolveAppRegion()).toBe('cn')

    process.env.APP_REGION = 'intl'
    expect(resolveAppRegion()).toBe('intl')
  })

  it('3. 当所有显式配置均缺失时，严格兜底为国际版 intl', () => {
    delete (globalThis as any).__BUILD_REGION__
    delete process.env.APP_REGION
    delete process.env.BUILD_REGION
    expect(resolveAppRegion()).toBe('intl')
  })

  it('4. 在未声明 __BUILD_REGION__ 的运行时中，typeof 保护绝不抛出 ReferenceError', () => {
    delete (globalThis as any).__BUILD_REGION__
    expect(() => resolveAppRegion()).not.toThrow()
  })
})

describe('worktree-env: checkPeerRegionDataPresence (P1 / ISS-04)', () => {
  it('正确识别对侧区域并根据主库存在性返回感知状态', () => {
    // 当当前为 cn 时，对侧区域必为 intl
    const res1 = checkPeerRegionDataPresence('cn', 'C:\\non-existent-dir')
    expect(res1.peerRegion).toBe('intl')
    expect(res1.hasPeerData).toBe(false)

    // 当当前为 intl 时，对侧区域必为 cn
    const res2 = checkPeerRegionDataPresence('intl', 'C:\\non-existent-dir')
    expect(res2.peerRegion).toBe('cn')
    expect(res2.hasPeerData).toBe(false)
  })
})
