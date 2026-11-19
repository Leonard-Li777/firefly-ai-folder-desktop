/**
 * SC-4 链路测试：设置 IPC「保存排除规则」成功后触发 workspace_files.is_ignored 批刷新
 *
 * 覆盖：
 *  1. saveAnalysisIgnoreRules handler → setImmediate 内以正确的 rules 参数调用
 *     databaseService.refreshWorkspaceFilesIgnoredState(rules) 恰好 1 次。
 *  2. 批刷新 mock reject 时，handler 主流程不崩（返回 { success: true }），走 logger.warn 静默降级。
 *
 * 设计：
 *  - vi.mock('electron') 捕获 ipcMain.handle 注册的 handler 函数后直调。
 *  - vi.mock 替身注入 databaseService / analysisQueueService / fileWatcherService，
 *    只 stub 被调用方法为 vi.fn()；严禁 mock 被测 handler 本身。
 *  - setImmediate 在测试中用 await new Promise(setImmediate) 冲刷，确保异步通知链路已执行。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// —— 捕获 ipcMain.handle 注册表 ——
const { ipcHandlers } = vi.hoisted(() => ({ ipcHandlers: new Map<string, Function>() }))

vi.mock('electron', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  const electronMock = {
    ...(actual as object),
    ipcMain: {
      handle: vi.fn((channel: string, fn: Function) => {
        ipcHandlers.set(channel, fn)
      }),
      on: vi.fn()
    },
    BrowserWindow: {
      getAllWindows: vi.fn(() => [])
    },
    powerMonitor: { on: vi.fn() },
    app: {
      getPath: vi.fn(() => 'C:\\test'),
      getName: vi.fn(() => 'firefly'),
      isPackaged: false,
      on: vi.fn(),
      whenReady: vi.fn(() => Promise.resolve())
    }
  }
  return { ...electronMock, default: electronMock }
})

// —— mock 被通知的下游服务（严禁 mock handler 本身）——
// vi.hoisted：vi.mock 工厂被提升，所有被引用变量同步提升避免 TDZ
const { refreshFn, reloadAnalysis, reloadWatcher } = vi.hoisted(() => ({
  refreshFn: vi.fn(() =>
    Promise.resolve({ totalChecked: 0, updatedToIgnored: 0, updatedToActive: 0 })
  ),
  reloadAnalysis: vi.fn(() => {}),
  reloadWatcher: vi.fn(() => Promise.resolve())
}))

vi.mock('../../database/database-service', () => ({
  databaseService: {
    refreshWorkspaceFilesIgnoredState: refreshFn
  }
}))

vi.mock('../../analysis-queue-service', () => ({
  analysisQueueService: { reloadIgnoreRules: reloadAnalysis }
}))

vi.mock('../../filesystem/file-watcher-service', () => ({
  fileWatcherService: { reloadIgnoreRules: reloadWatcher }
}))

vi.mock('../../services/omni-client', () => ({
  omniClient: {}
}))

// ConfigOrchestrator 依赖 electron-conf，此处仅打断其真实配置读取（不 mock 被测 handler）
vi.mock('electron-conf', () => ({
  Conf: class {
    get() {
      return {}
    }
    set() {}
  }
}))

vi.mock('@app/electron/config/config-orchestrator', () => ({
  ConfigOrchestrator: {
    getInstance: () => ({
      getValue: () => null,
      updateValue: vi.fn(() => Promise.resolve()),
      onValueChange: vi.fn()
    })
  }
}))

// handler 内动态 import('../system') 会触发 ResourceManager 真实初始化链，
// 桩掉 omniService 即可隔离，无需加载真实 system 模块。
vi.mock('../../system', () => ({
  omniService: { syncConfigFromDesktop: vi.fn(() => Promise.resolve()) }
}))

vi.mock('../workspace/workspace-admission-service', () => ({
  workspaceAdmissionService: {}
}))

vi.mock('../workspace/workspace-policy-commit-service', () => ({
  workspacePolicyCommitService: {}
}))

vi.mock('../filesystem/thumbnail-service', () => ({
  thumbnailService: {}
}))

// —— 捕获 logger.warn，验证静默降级路径 ——
// vi.hoisted：vi.mock 工厂被提升到文件顶部，捕获变量必须同步提升避免 TDZ
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }))
// 部分覆盖：仅替换 logger，保留 @firefly/shared 其余真实导出（否则破坏导入链）
vi.mock('@firefly/shared', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    logger: {
      warn: (...args: unknown[]) => warnSpy(...args),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn()
    },
    LogCategory: { ...(actual.LogCategory as object), SETTING: 'SETTING' }
  }
})

import { registerSettingsIPCHandlers } from '../settings-ipc-handler'
import type { IIgnoreRule } from '@firefly/types/settings-types'

function makeRule(): IIgnoreRule {
  return {
    id: 'user-test-rule',
    type: 'wildcard',
    value: '*.zzz',
    isSystem: false,
    isActive: true
  }
}

describe('SC-4 链路：保存排除规则 → 触发 is_ignored 批刷新', () => {
  beforeEach(() => {
    ipcHandlers.clear()
    refreshFn.mockClear()
    reloadAnalysis.mockClear()
    reloadWatcher.mockClear()
    warnSpy.mockClear()
    registerSettingsIPCHandlers()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  /**
   * 冲刷 setImmediate 队列，保证异步通知链路完整执行。
   * 用双层 setImmediate 解耦 handler 内部 await 个数：外层 flush 触发 handler 的 setImmediate CB，
   * 内层 flush 再等 CB 内 await 链（reloadIgnoreRules 等）之后的微任务排空，避免时序耦合生产实现细节。
   */
  function flushSetImmediate(): Promise<void> {
    return new Promise(resolve =>
      setImmediate(() => {
        setImmediate(resolve)
      })
    )
  }

  it('保存规则成功后 refreshWorkspaceFilesIgnoredState(rules) 被调用 1 次、参数正确', async () => {
    const handler = ipcHandlers.get('saveAnalysisIgnoreRules')
    expect(handler).toBeDefined()

    const rules = [makeRule()]
    const result = await handler!({} as Electron.IpcMainInvokeEvent, rules)

    // handler 主流程立即返回成功（不等 setImmediate 异步通知）
    expect(result).toEqual({ success: true })

    // 冲刷 setImmediate → 异步通知链路执行
    await flushSetImmediate()

    // 核心断言：批刷新以保存的 rules 参数异步调用恰好 1 次
    expect(refreshFn).toHaveBeenCalledTimes(1)
    expect(refreshFn).toHaveBeenCalledWith(rules)

    // 同批通知：reloadIgnoreRules 也被触发
    expect(reloadAnalysis).toHaveBeenCalledTimes(1)
  })

  it('批刷新 reject 时主流程仍返回 success，走 logger.warn 静默降级', async () => {
    // 模拟 databaseService.refreshWorkspaceFilesIgnoredState 抛出
    refreshFn.mockImplementationOnce(() => Promise.reject(new Error('DB is locked')))

    const handler = ipcHandlers.get('saveAnalysisIgnoreRules')
    expect(handler).toBeDefined()

    const rules = [makeRule()]
    // .catch 降级：refresh 返回的 promise reject 被原地 catch，不会冒泡到 handler
    const result = await handler!({} as Electron.IpcMainInvokeEvent, rules)

    // handler 主流程不受批刷新失败影响
    expect(result).toEqual({ success: true })

    await flushSetImmediate()

    // 批刷新确实被调用了 1 次
    expect(refreshFn).toHaveBeenCalledTimes(1)

    // 静默降级：logger.warn 被调用，携带失败原因（含 'DB is locked'），而非抛出未捕获异常
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toBe('SETTING')
    // 第二个参数为携带失败原因的对象，其 err 字段应含真实错误信息
    const warnPayload = warnSpy.mock.calls[0][2] as { err?: Error }
    expect(String(warnPayload?.err ?? warnPayload)).toContain('DB is locked')
  })
})
