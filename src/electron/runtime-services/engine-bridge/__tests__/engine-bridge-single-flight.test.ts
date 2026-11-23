/**
 * EngineBridgeService Single-Flight 与调用方预算解耦单元测试
 *
 * 覆盖 Ticket 01 与 Spec §2.2 / §3.2 / §4.1.3 验收准则：
 * - 源码护栏：彻底删除旧 800ms 轮询 waitForServiceReady
 * - N 个并发调用方合并为 1 次 startService
 * - A 取消绝不中断 B，且不触发 onEnsureFailed
 * - force: true 不被在途非 force 吞掉，待在途结束后重发
 * - 短预算 owner（ensureMode 45s）与长预算 joiner（ensureReady 120s）解耦：第 60s ready 时 A 超时、B 成功、onEnsureFailed 0 次
 * - 孤儿共享体终态：全部调用方提前取消/超时后共享体失败仅触发 1 次 onEnsureFailed
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockAppState } = vi.hoisted(() => ({
  mockAppState: { userDataDir: '' }
}))

vi.mock('electron', () => ({
  app: {
    on: vi.fn(),
    isReady: vi.fn(() => true),
    whenReady: vi.fn(() => Promise.resolve()),
    getAppPath: vi.fn(() => process.cwd()),
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return mockAppState.userDataDir
      return os.tmpdir()
    })
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [])
  },
  dialog: {
    showErrorBox: vi.fn(),
    showMessageBox: vi.fn()
  },
  powerMonitor: {
    on: vi.fn()
  },
  shell: {
    openPath: vi.fn()
  }
}))

vi.mock('../../../config/config-orchestrator', () => ({
  ConfigOrchestrator: {
    getInstance: vi.fn(() => ({
      getValue: vi.fn(),
      onValueChange: vi.fn(() => () => {})
    }))
  }
}))

vi.mock('@app/languages', () => ({
  t: (s: string) => s
}))

import { EngineBridgeService } from '../engine-bridge-service/engine-bridge-service'
import type { EngineBridgeSnapshot, Tier2EngineStatus } from '../engine-bridge-service/types'

function makeSnapshot(raw: Tier2EngineStatus | null, connected = true): EngineBridgeSnapshot {
  return {
    connected,
    managed: true,
    circuitState: 'closed',
    available: true,
    exePath: null,
    devMode: false,
    port: 38400,
    version: '1.0.0',
    backend: 'cuda',
    backendMatchType: 'best',
    model: raw?.current_model ?? raw?.model ?? null,
    modelName: null,
    vramMb: null,
    modelCount: 1,
    totalModelCount: 1,
    lastError: null,
    updatedAt: Date.now(),
    raw
  }
}

describe('EngineBridgeService Single-Flight 与零轮询保障', () => {
  let tempUserDataDir: string
  let service: EngineBridgeService
  let currentSnap: EngineBridgeSnapshot
  let listeners: Set<(snap: EngineBridgeSnapshot) => void>

  const pushSnap = (next: EngineBridgeSnapshot) => {
    currentSnap = next
    for (const fn of Array.from(listeners)) {
      fn(next)
    }
  }

  beforeEach(() => {
    vi.useFakeTimers()
    tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firefly-eb-sf-'))
    mockAppState.userDataDir = tempUserDataDir
    listeners = new Set()
    currentSnap = makeSnapshot({ status: 'stopped', revision: 1, instance_id: 'inst-1' })

    service = EngineBridgeService.createForTest({
      userDataPath: tempUserDataDir,
      disableAutoBootstrap: true,
      disableDevBinaryWatch: true,
      disableLifecycleHooks: true
    })

    vi.spyOn(service, 'getSnapshot').mockImplementation(() => currentSnap)
    vi.spyOn(service, 'subscribe').mockImplementation(fn => {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    })
    vi.spyOn(service, 'ensureRunning').mockResolvedValue(true)
  })

  afterEach(async () => {
    vi.useRealTimers()
    if (service) {
      await service.stop()
    }
    vi.restoreAllMocks()
    fs.rmSync(tempUserDataDir, { recursive: true, force: true })
  })

  it('源码护栏：engine-bridge-service.ts 已彻底删除 waitForServiceReady 与 800ms 轮询', () => {
    const srcPath = path.resolve(__dirname, '../engine-bridge-service/engine-bridge-service.ts')
    const source = fs.readFileSync(srcPath, 'utf8')
    expect(source).not.toMatch(/async\s+waitForServiceReady\s*\(/)
    expect(source).not.toMatch(/setTimeout\s*\(\s*resolve\s*,\s*800\s*\)/)
  })

  it('N 个并发 ensureReady 仅触发 1 次 startService，且全部获得 { ok: true }', async () => {
    const startSpy = vi.spyOn(service, 'startService').mockImplementation(async () => {
      pushSnap(makeSnapshot({ status: 'starting', revision: 2, instance_id: 'inst-1' }))
      return { ok: true }
    })
    const onFailed = vi.fn()
    service.onEnsureFailed(onFailed)

    const p1 = service.ensureReady({ mode: 'language', timeoutMs: 120_000 })
    const p2 = service.ensureReady({ mode: 'language', timeoutMs: 120_000 })
    const p3 = service.ensureReady({ mode: 'language', timeoutMs: 120_000 })

    await vi.advanceTimersByTimeAsync(1_000)
    pushSnap(
      makeSnapshot({
        status: 'ready',
        current_model: 'Qwen3-8B.gguf',
        revision: 3,
        instance_id: 'inst-1'
      })
    )

    const results = await Promise.all([p1, p2, p3])
    expect(results).toEqual([{ ok: true }, { ok: true }, { ok: true }])
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(onFailed).not.toHaveBeenCalled()
  })

  it('调用方 A 触发 Abort 不中断调用方 B，且不触发 onEnsureFailed', async () => {
    const startSpy = vi.spyOn(service, 'startService').mockImplementation(async () => {
      pushSnap(makeSnapshot({ status: 'starting', revision: 2, instance_id: 'inst-1' }))
      return { ok: true }
    })
    const onFailed = vi.fn()
    service.onEnsureFailed(onFailed)

    const ctrlA = new AbortController()
    const pA = service.ensureReady({ mode: 'language', timeoutMs: 120_000, signal: ctrlA.signal })
    const pB = service.ensureReady({ mode: 'language', timeoutMs: 120_000 })

    await vi.advanceTimersByTimeAsync(500)
    ctrlA.abort()

    await expect(pA).rejects.toMatchObject({ name: 'AbortError' })

    await vi.advanceTimersByTimeAsync(2_000)
    pushSnap(
      makeSnapshot({
        status: 'ready',
        current_model: 'Qwen3-8B.gguf',
        revision: 3,
        instance_id: 'inst-1'
      })
    )

    expect(await pB).toEqual({ ok: true })
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(onFailed).not.toHaveBeenCalled()
  })

  it('force: true 不合并进在途非 force 调用，待在途结束后重发一次启动', async () => {
    let callCount = 0
    const startSpy = vi.spyOn(service, 'startService').mockImplementation(async () => {
      callCount += 1
      pushSnap(
        makeSnapshot({
          status: 'starting',
          revision: callCount * 10 + 1,
          instance_id: 'inst-1'
        })
      )
      return { ok: true }
    })

    const pNormal = service.ensureReady({ mode: 'language', timeoutMs: 120_000 })
    const pForce = service.ensureReady({ mode: 'language', timeoutMs: 120_000, force: true })

    // 第一次在途完成
    await vi.advanceTimersByTimeAsync(1_000)
    expect(startSpy).toHaveBeenCalledTimes(1)
    pushSnap(
      makeSnapshot({
        status: 'ready',
        current_model: 'Qwen3-8B.gguf',
        revision: 12,
        instance_id: 'inst-1'
      })
    )
    expect(await pNormal).toEqual({ ok: true })

    // 等待 force 重发进入第二次 startService
    await vi.advanceTimersByTimeAsync(100)
    expect(startSpy).toHaveBeenCalledTimes(2)

    pushSnap(
      makeSnapshot({
        status: 'ready',
        current_model: 'Qwen3-8B.gguf',
        revision: 22,
        instance_id: 'inst-1'
      })
    )
    expect(await pForce).toEqual({ ok: true })
  })

  it('ISS-30 短预算 owner(ensureMode 45s) 与长预算 joiner(120s) 解耦：第 60s ready 时 A 超时、B 成功、onEnsureFailed 0 次', async () => {
    const startSpy = vi.spyOn(service, 'startService').mockImplementation(async () => {
      pushSnap(makeSnapshot({ status: 'starting', revision: 2, instance_id: 'inst-1' }))
      return { ok: true }
    })
    const onFailed = vi.fn()
    service.onEnsureFailed(onFailed)

    // A 以存量 ensureMode（默认 45s）发起，B 以 120s 加入
    const pA = service.ensureMode('language')
    const pB = service.ensureReady({ mode: 'language', timeoutMs: 120_000 })

    // 第 45s：A 自身预算超时返回失败，但绝不中止共享体，也不触发 onEnsureFailed
    await vi.advanceTimersByTimeAsync(45_000)
    const resA = await pA
    expect(resA.ok).toBe(false)
    expect(resA.code).toBe('caller_timeout')
    expect(onFailed).not.toHaveBeenCalled()

    // 第 60s：引擎推送 ready，B 获得 { ok: true }，onEnsureFailed 仍为 0 次
    await vi.advanceTimersByTimeAsync(15_000)
    pushSnap(
      makeSnapshot({
        status: 'ready',
        current_model: 'Qwen3-8B.gguf',
        revision: 3,
        instance_id: 'inst-1'
      })
    )

    const resB = await pB
    expect(resB).toEqual({ ok: true })
    expect(startSpy).toHaveBeenCalledTimes(1)
    expect(onFailed).not.toHaveBeenCalled()
  })

  it('孤儿共享体终态：全部调用方提前超时/Abort 后共享体失败，仅触发 1 次 onEnsureFailed', async () => {
    vi.spyOn(service, 'startService').mockImplementation(async () => {
      pushSnap(makeSnapshot({ status: 'starting', revision: 2, instance_id: 'inst-1' }))
      return { ok: true }
    })
    const onFailed = vi.fn()
    service.onEnsureFailed(onFailed)

    const ctrlB = new AbortController()
    const pA = service.ensureReady({ mode: 'language', timeoutMs: 15_000 })
    const pB = service.ensureReady({ mode: 'language', timeoutMs: 120_000, signal: ctrlB.signal })

    // 第 15s A 超时退出
    await vi.advanceTimersByTimeAsync(15_000)
    expect((await pA).ok).toBe(false)
    expect(onFailed).not.toHaveBeenCalled()

    // 第 20s B 取消退出（此时共享体成为孤儿）
    await vi.advanceTimersByTimeAsync(5_000)
    ctrlB.abort()
    await expect(pB).rejects.toMatchObject({ name: 'AbortError' })
    expect(onFailed).not.toHaveBeenCalled()

    // 第 30s 引擎上报新 error 终态：孤儿共享体收敛并精确触发 1 次 onEnsureFailed
    await vi.advanceTimersByTimeAsync(10_000)
    pushSnap(
      makeSnapshot({
        status: 'error',
        error: '模型文件损坏',
        revision: 3,
        instance_id: 'inst-1'
      })
    )
    await Promise.resolve()
    await Promise.resolve()

    expect(onFailed).toHaveBeenCalledTimes(1)
    expect(onFailed).toHaveBeenCalledWith(
      'language',
      expect.objectContaining({
        ok: false,
        code: 'engine_error',
        error: '模型文件损坏'
      })
    )
  })
})
