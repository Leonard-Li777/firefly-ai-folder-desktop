// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as semver from 'semver'

const registeredHandlers = new Map<string, (info: any) => void>()

vi.mock('electron', () => ({
  app: {
    getVersion: () => '4.0.0',
    getPath: () => '/tmp/userData',
    getAppPath: () => '/tmp/app'
  },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { openPath: vi.fn() }
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    disableWebInstaller: false,
    disableDifferentialDownload: false,
    logger: null,
    on: vi.fn((event: string, handler: any) => {
      registeredHandlers.set(event, handler)
    }),
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn().mockResolvedValue(null),
    downloadUpdate: vi.fn().mockResolvedValue(null)
  },
  UpdateInfo: class {}
}))

vi.mock('@firefly/shared', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  },
  LogCategory: { SYSTEM: 'SYSTEM' },
  isTestEnvironment: () => true
}))

vi.mock('../../main/worktree-env', () => ({
  resolveAppRegion: vi.fn(() => 'cn')
}))

vi.mock('../file-download-service', () => ({
  checkDiskSpace: vi.fn(() => ({ sufficient: true, requiredBytes: 0, availableBytes: 9e9 }))
}))

vi.mock('../shutdown-coordinator', () => ({
  runShutdownSequence: vi.fn(),
  runShutdownSequenceWithOverallTimeout: vi.fn()
}))

import { autoUpdateService } from '../auto-update-service'
import { logger, LogCategory } from '@firefly/shared'

const mockLoggerWarn = logger.warn as unknown as ReturnType<typeof vi.fn>

function fireAvailable(info: { version: string; minVersion?: string }) {
  const handler = registeredHandlers.get('update-available')
  expect(handler).toBeDefined()
  handler!({
    version: info.version,
    minVersion: info.minVersion,
    files: [],
    path: '',
    sha512: '',
    releaseDate: new Date().toISOString()
  })
}

describe('AutoUpdateService · 工单 09 A7 强更三分支红线 / P1-15 minVersion 安全解析', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registeredHandlers.clear()
    ;(autoUpdateService as any).setupUpdaterListeners()
  })

  it('红线正向: phase=update-available + 合法 minVersion + current<minVersion → isMandatory=true', () => {
    fireAvailable({ version: '4.2.0', minVersion: '4.1.0' })
    const state = autoUpdateService.getState()
    expect(state.status).toBe('available')
    expect(state.isMandatory).toBe(true)
    expect(semver.lt('4.0.0', '4.1.0')).toBe(true)
  })

  it('红线边界: current===minVersion → 不强制', () => {
    fireAvailable({ version: '4.0.0', minVersion: '4.0.0' })
    expect(semver.lt('4.0.0', '4.0.0')).toBe(false)
    expect(autoUpdateService.getState().isMandatory).toBe(false)
  })

  it('P1-15: minVersion 缺失 → 不强制', () => {
    fireAvailable({ version: '4.2.0' })
    const state = autoUpdateService.getState()
    expect(state.isMandatory).toBe(false)
    expect(state.minVersion).toBeNull()
  })

  it('P1-15: minVersion 非法 semver → warn + 不强制', () => {
    fireAvailable({ version: '4.2.0', minVersion: 'not-a-semver' })
    const state = autoUpdateService.getState()
    expect(state.isMandatory).toBe(false)
    // logger.warn(LogCategory, message)
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      LogCategory.SYSTEM,
      expect.stringContaining('非法 semver')
    )
  })

  it('P1-15: minVersion prerelease → warn + 不强制', () => {
    fireAvailable({ version: '4.2.0', minVersion: '5.0.0-rc.1' })
    const state = autoUpdateService.getState()
    expect(state.isMandatory).toBe(false)
    expect(semver.prerelease('5.0.0-rc.1')).toBeTruthy()
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      LogCategory.SYSTEM,
      expect.stringContaining('prerelease')
    )
  })

  it('A7: error 事件（无前置强更）绝不设置 isMandatory=true', async () => {
    const errorHandler = registeredHandlers.get('error')
    expect(errorHandler).toBeDefined()
    // 触发 error，此时无强更前置；error 事件绝不应让 isMandatory 变 true
    errorHandler!(new Error('ENETDOWN 网络断开'))
    await new Promise(r => setTimeout(r, 30))
    expect(autoUpdateService.getState().isMandatory).toBe(false)
  })

  it('A7: 强更状态 → error 终端 → isMandatory 复位 false（downloadUpdate/checkForUpdates 均失败）', async () => {
    // 先制造一次强更
    fireAvailable({ version: '4.2.0', minVersion: '4.1.0' })
    expect(autoUpdateService.getState().isMandatory).toBe(true)

    // 让降级路径全挂：downloadUpdate reject + checkForUpdates reject
    const { autoUpdater } = await import('electron-updater')
    const origDownload = (autoUpdater as any).downloadUpdate
    const origCheck = (autoUpdater as any).checkForUpdates
    ;(autoUpdater as any).downloadUpdate = vi.fn().mockRejectedValue(new Error('全量下载也失败'))
    ;(autoUpdater as any).checkForUpdates = vi.fn().mockRejectedValue(new Error('备用源不可达'))

    const errorHandler = registeredHandlers.get('error')
    errorHandler!(new Error('ENETDOWN'))
    // 等 handleUpdateError 异步链收敛
    await new Promise(r => setTimeout(r, 50))

    const state = autoUpdateService.getState()
    expect(state.status).toBe('error')
    // A7 红线核心断言：error 终端绝不残留 isMandatory=true
    expect(state.isMandatory).toBe(false)

    // 还原 mock
    ;(autoUpdater as any).downloadUpdate = origDownload
    ;(autoUpdater as any).checkForUpdates = origCheck
  })
})

describe('AutoUpdateService · 工单 09 A6 inFlightCheck 三路并发复用', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registeredHandlers.clear()
  })

  it('三路并发 checkForUpdates 复用同一在飞 Promise（不叠加）', async () => {
    ;(autoUpdateService as any).setupUpdaterListeners()

    // mock probeEndpoint 避免真实 HTTP
    const svc = autoUpdateService as any
    const origProbe = svc.probeEndpoint
    svc.probeEndpoint = vi.fn().mockResolvedValue('alive')

    // mock autoUpdater.checkForUpdates 为可控 promise
    const { autoUpdater } = await import('electron-updater')
    let resolveCheck: (v: any) => void = () => {}
    const origCheck = (autoUpdater as any).checkForUpdates
    ;(autoUpdater as any).checkForUpdates = vi.fn().mockImplementation(
      () =>
        new Promise(resolve => {
          resolveCheck = resolve
        })
    )

    // 三路并发触发
    const p1 = autoUpdateService.checkForUpdates(false)
    const p2 = autoUpdateService.checkForUpdates(false)
    const p3 = autoUpdateService.checkForUpdates(true)

    // 三路应复用同一在飞 Promise
    const inflight = svc.inFlightCheck
    expect(inflight).toBeInstanceOf(Promise)
    expect(svc.inFlightCheck).toBe(inflight)

    // 让出微任务队列：首路 await probeEndpoint 返回后才会推进到底层 checkForUpdates
    await new Promise(r => setTimeout(r, 0))
    // autoUpdater.checkForUpdates 底层只被驱动一次
    expect((autoUpdater as any).checkForUpdates).toHaveBeenCalledTimes(1)

    resolveCheck(null)
    await Promise.all([p1, p2, p3])

    // 收敛后在飞锁释放
    expect(svc.inFlightCheck).toBeNull()

    // 还原
    svc.probeEndpoint = origProbe
    ;(autoUpdater as any).checkForUpdates = origCheck
  })
})
