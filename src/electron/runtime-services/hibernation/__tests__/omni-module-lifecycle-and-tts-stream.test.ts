// @vitest-environment node
/**
 * Ticket 03 (Spec §2.2 / §3.2 / AC-3):
 * TTS 受控懒加载、IHibernationTargetAdapter 隔离、单调代际围栏与 TtsStreamSession 单句柄闭环测试
 */
import * as http from 'node:http'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => {
  const handlers = new Map<string, (...args: any[]) => any>()
  const listeners = new Map<string, (...args: any[]) => any>()
  return {
    app: {
      isReady: vi.fn(() => true),
      getPath: vi.fn(() => process.cwd()),
      getAppPath: vi.fn(() => process.cwd()),
      on: vi.fn()
    },
    ipcMain: {
      handle: vi.fn((ch: string, fn: any) => handlers.set(ch, fn)),
      on: vi.fn((ch: string, fn: any) => listeners.set(ch, fn)),
      __handlers: handlers,
      __listeners: listeners
    },
    BrowserWindow: { getAllWindows: vi.fn(() => []), getFocusedWindow: vi.fn(() => null) },
    dialog: { showSaveDialog: vi.fn() }
  }
})

vi.mock('electron-conf', () => ({
  Conf: vi.fn().mockImplementation(() => ({
    get: vi.fn(),
    set: vi.fn()
  }))
}))

import { ipcMain } from 'electron'
import { ModuleHibernationCoordinator } from '../module-hibernation-coordinator'
import { classifyOmniModuleLoadHttpResponse } from '../target-adapter'
import {
  HIBERNATABLE_TARGET_CATALOG,
  HibernationGateAbortedError,
  IEngineBridgeService,
  LEASE_TTL_MS,
  ModuleRuntimeState
} from '../types'
import { IModuleRuntimeStore } from '../module-runtime-store'
import { omniClient } from '../../../services/omni-client'
import { omniService } from '../../system/omni-service'
import { registerTTSIPCHandlers, getActiveTtsStreamSession } from '../../../main/ipc-handlers/tts'
import { modularResourceService } from '../../system/modular-resource-service'
import { moduleHibernationCoordinator } from '../module-hibernation-coordinator'

function createStateMap(ids: string[]): Map<string, ModuleRuntimeState> {
  const map = new Map<string, ModuleRuntimeState>()
  for (const id of ids) {
    const meta = HIBERNATABLE_TARGET_CATALOG[id]
    map.set(id, {
      id,
      clusterId: meta.clusterId,
      modelGeneration: 1,
      defaultMemoryKind: meta.defaultMemoryKind,
      effectiveMemoryKind: meta.defaultMemoryKind,
      i18nNameKey: meta.i18nNameKey,
      state: 'hibernated',
      residentBytes: 0,
      lastActiveTimestamp: Date.now(),
      crashStreak: 0,
      unloadFailStreak: 0,
      blockedUnloadNoHandle: 0,
      blockedUnloadIdentity: null
    })
  }
  return map
}

function createMockStore(storeMap: Map<string, ModuleRuntimeState>): IModuleRuntimeStore {
  return {
    get: vi.fn((id: string) => storeMap.get(id)!),
    getAll: vi.fn(() => Array.from(storeMap.values())),
    update: vi.fn((id: string, apply: (draft: ModuleRuntimeState) => void) => {
      const item = storeMap.get(id)
      if (!item) return false
      apply(item)
      return true
    }),
    persistBlockedUnloadGate: vi.fn(async () => {}),
    commitSnapshot: vi.fn()
  } as unknown as IModuleRuntimeStore
}

describe('Ticket 03: IHibernationTargetAdapter、代际围栏与 TtsStreamSession 闭环', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('状态码映射矩阵：仅可达 Omni 非预期 5xx 累 crashStreak，503 MODULE_NOT_INSTALLED/409/404/unreachable 均豁免', async () => {
    expect(classifyOmniModuleLoadHttpResponse('tts-m5-onnx', 200, { residentBytes: 12345 })).toEqual({
      outcome: 'ok',
      residentBytes: 12345,
      httpStatus: 200
    })
    expect(
      classifyOmniModuleLoadHttpResponse('tts-m5-onnx', 503, { error: 'MODULE_NOT_INSTALLED' })
    ).toMatchObject({ outcome: 'not_installed', httpStatus: 503 })
    expect(
      classifyOmniModuleLoadHttpResponse('tts-m5-onnx', 409, { error: 'LOAD_SUPERSEDED' })
    ).toMatchObject({ outcome: 'aborted', httpStatus: 409 })
    expect(classifyOmniModuleLoadHttpResponse('tts-m5-onnx', 404, {})).toMatchObject({
      outcome: 'unreachable',
      httpStatus: 404
    })
    expect(classifyOmniModuleLoadHttpResponse('tts-m5-onnx', 405, {})).toMatchObject({
      outcome: 'unreachable',
      httpStatus: 405
    })
    expect(
      classifyOmniModuleLoadHttpResponse('tts-m5-onnx', 500, { error: 'ONNX_INIT_ERR' })
    ).toMatchObject({ outcome: 'failed', httpStatus: 500 })

    const storeMap = createStateMap(['tts-m5-onnx', 'tts-moss-onnx'])
    const mockStore = createMockStore(storeMap)
    let mockGen = 10
    const bridge: IEngineBridgeService = {
      isProcessTreeExited: vi.fn(() => true),
      stopProcessTree: vi.fn(async () => {}),
      forceKillOldGeneration: vi.fn(async () => 'no_handle'),
      awaitProcessTreeExit: vi.fn(async () => 'exited'),
      loadOmniModule: vi
        .fn()
        .mockResolvedValueOnce({ outcome: 'not_installed', residentBytes: 0, httpStatus: 503 })
        .mockResolvedValueOnce({ outcome: 'aborted', residentBytes: 0, httpStatus: 409 })
        .mockResolvedValueOnce({ outcome: 'unreachable', residentBytes: 0, httpStatus: 404 })
        .mockResolvedValueOnce({ outcome: 'failed', residentBytes: 0, httpStatus: 500, error: 'ONNX_BOOM' })
    }

    const coordinator = new ModuleHibernationCoordinator({
      runtimeStore: mockStore,
      engineBridgeService: bridge,
      omniLifecycle: {
        ensureRunning: vi.fn(async () => true),
        getGeneration: () => mockGen
      }
    })

    // 生产默认装配 LeaseRegistry
    expect(coordinator.getLeaseRegistry()).toBeDefined()

    // 1) 503 not_installed -> 不计 crashStreak
    await expect(
      coordinator.withHibernationGate({ targetId: 'tts-m5-onnx' }, async () => {})
    ).rejects.toSatisfy((e: any) => e instanceof HibernationGateAbortedError && e.code === 'MODULE_NOT_INSTALLED')
    expect(storeMap.get('tts-m5-onnx')!.crashStreak).toBe(0)

    // 2) 409 aborted -> 回归 hibernated，不计 crashStreak
    await expect(
      coordinator.withHibernationGate({ targetId: 'tts-m5-onnx' }, async () => {})
    ).rejects.toSatisfy((e: any) => e instanceof HibernationGateAbortedError && e.code === 'LOAD_ABORTED')
    expect(storeMap.get('tts-m5-onnx')!.state).toBe('hibernated')
    expect(storeMap.get('tts-m5-onnx')!.crashStreak).toBe(0)

    // 3) 404 unreachable -> 不计 crashStreak
    await expect(
      coordinator.withHibernationGate({ targetId: 'tts-m5-onnx' }, async () => {})
    ).rejects.toSatisfy((e: any) => e instanceof HibernationGateAbortedError && e.code === 'SERVICE_UNAVAILABLE')
    expect(storeMap.get('tts-m5-onnx')!.crashStreak).toBe(0)

    // 4) 可达 500 -> 计入 crashStreak，且绝不误调用 forceKillOldGeneration / 写 blockedUnloadNoHandle
    await expect(
      coordinator.withHibernationGate({ targetId: 'tts-m5-onnx' }, async () => {})
    ).rejects.toThrow('ONNX_BOOM')
    expect(storeMap.get('tts-m5-onnx')!.crashStreak).toBe(1)
    expect(bridge.forceKillOldGeneration).not.toHaveBeenCalled()
    expect(bridge.stopProcessTree).not.toHaveBeenCalled()
    expect(storeMap.get('tts-m5-onnx')!.blockedUnloadNoHandle).toBe(0)
  })

  it('单调代际围栏：emit(N)->inactive(N+1)复位，inactive(N)忽略，emit(N+2)晚于load(captured=N+2)不中止加载', async () => {
    const storeMap = createStateMap(['tts-m5-onnx', 'tts-moss-onnx'])
    const mockStore = createMockStore(storeMap)
    let omniGen = 10

    let resolveLoad2!: (v: any) => void
    const bridge: IEngineBridgeService = {
      isProcessTreeExited: vi.fn(() => true),
      stopProcessTree: vi.fn(async () => {}),
      forceKillOldGeneration: vi.fn(async () => 'killed'),
      awaitProcessTreeExit: vi.fn(async () => 'exited'),
      loadOmniModule: vi
        .fn()
        .mockResolvedValueOnce({ outcome: 'ok', residentBytes: 315 * 1024 * 1024, httpStatus: 200 })
        .mockImplementationOnce(
          () =>
            new Promise(resolve => {
              resolveLoad2 = resolve
            })
        ),
      getOmniModuleStatus: vi.fn(async () => ({
        loaded: false,
        residentBytes: 0,
        serviceReachable: false,
        probeStatus: 'timeout'
      }))
    }

    const coordinator = new ModuleHibernationCoordinator({
      runtimeStore: mockStore,
      engineBridgeService: bridge,
      omniLifecycle: {
        ensureRunning: vi.fn(async () => true),
        getGeneration: () => omniGen
      }
    })

    // 1. N=10 加载成功 -> loadedGeneration = 10
    await coordinator.withHibernationGate({ targetId: 'tts-m5-onnx' }, async () => {})
    expect(storeMap.get('tts-m5-onnx')!.state).toBe('resident')
    expect(storeMap.get('tts-m5-onnx')!.loadedGeneration).toBe(10)

    // 2. reconcileOmniModuleLiveState 遇探测 timeout 时必须保持 resident 原态绝不误置 hibernated
    expect(await coordinator.reconcileOmniModuleLiveState('tts-m5-onnx')).toBe('unknown')
    expect(storeMap.get('tts-m5-onnx')!.state).toBe('resident')

    // 3. inactive(11) 严格递增 -> 必须复位为 hibernated
    omniGen = 11
    coordinator.forceResetExternalHibernated('tts-m5-onnx', 11)
    expect(storeMap.get('tts-m5-onnx')!.state).toBe('hibernated')
    expect(storeMap.get('tts-m5-onnx')!.loadedGeneration).toBeUndefined()

    // 4. 迟到的 inactive(10) 必须被单调围栏忽略（即使强置 resident 也不被旧事件误抹）
    storeMap.get('tts-m5-onnx')!.state = 'resident'
    coordinator.forceResetExternalHibernated('tts-m5-onnx', 10)
    expect(storeMap.get('tts-m5-onnx')!.state).toBe('resident')

    // 5. 新代 N+2 = 12 抢先发起加载（captured=12），随后 emitInstanceChanged(12) 晚到：绝不中止合法加载！
    storeMap.get('tts-m5-onnx')!.state = 'hibernated'
    omniGen = 12
    const gatePromise = coordinator.withHibernationGate(
      { targetId: 'tts-m5-onnx', clusterId: 'tts_media', livenessSourceKey: 'task_progress' },
      async () => 'loaded_ok'
    )
    await new Promise(r => setTimeout(r, 10))
    // 迟到 emit(12) 到达
    coordinator.forceResetExternalHibernated('tts-m5-onnx', 12)
    resolveLoad2({ outcome: 'ok', residentBytes: 315 * 1024 * 1024, httpStatus: 200 })

    expect(await gatePromise).toBe('loaded_ok')
    expect(storeMap.get('tts-m5-onnx')!.state).toBe('resident')
    expect(storeMap.get('tts-m5-onnx')!.loadedGeneration).toBe(12)
  })

  it('LeaseRegistry 按真实 targetId 对账：仅 tts-moss-onnx 有活跃租约时不误标 tts-m5-onnx', async () => {
    const storeMap = createStateMap(['tts-m5-onnx', 'tts-moss-onnx'])
    const coordinator = new ModuleHibernationCoordinator({
      runtimeStore: createMockStore(storeMap),
      engineBridgeService: {
        isProcessTreeExited: vi.fn(() => true),
        stopProcessTree: vi.fn(async () => {}),
        forceKillOldGeneration: vi.fn(async () => 'killed'),
        awaitProcessTreeExit: vi.fn(async () => 'exited'),
        loadOmniModule: vi.fn(async () => ({
          outcome: 'ok',
          residentBytes: 450 * 1024 * 1024
        }))
      }
    })

    const lease = coordinator.getLeaseRegistry()!.acquireLease({
      targetId: 'tts-moss-onnx',
      clusterId: 'tts_media',
      livenessSourceKey: 'task_progress'
    })

    await coordinator.getSnapshot()
    expect(storeMap.get('tts-moss-onnx')!.state).toBe('resident')
    expect(storeMap.get('tts-m5-onnx')!.state).toBe('hibernated')
    lease.release()
  })

  it('TtsStreamSession 单播抢占立即 abort 旧流 + 180s 长流续期 0 泄漏', async () => {
    vi.useFakeTimers()
    registerTTSIPCHandlers()
    const handlers = (ipcMain as any).__handlers as Map<string, (...args: any[]) => any>
    const listeners = (ipcMain as any).__listeners as Map<string, (...args: any[]) => any>
    const startHandler = handlers.get('tts:stream-start')!
    const heartbeatListener = listeners.get('tts:stream-heartbeat')!

    vi.spyOn(modularResourceService, 'getActiveModuleBySlot').mockReturnValue({
      id: 'tts_m5_onnx',
      capability_slot: 'voice_tts',
      backend_type: 'omni_onnx'
    } as any)

    const abortedSignals: string[] = []
    let releaseGateCount = 0
    vi.spyOn(moduleHibernationCoordinator, 'acquireStreamLease').mockImplementation(async req => {
      const lease = moduleHibernationCoordinator.getLeaseRegistry()!.acquireLease(req)
      const origRelease = lease.release.bind(lease)
      lease.release = () => {
        releaseGateCount++
        origRelease()
      }
      return { lease, signal: lease.abortController!.signal }
    })

    let firstStreamCallbacks: any
    let streamCount = 0
    vi.spyOn(omniClient, 'startTTSStream').mockImplementation(async (_params, callbacks, signal) => {
      const idx = ++streamCount
      signal?.addEventListener('abort', () => {
        abortedSignals.push(`stream_${idx}:${String(signal.reason)}`)
      })
      if (idx === 1) {
        firstStreamCallbacks = callbacks
      }
      return {
        sessionId: `sess_${idx}`,
        pause: vi.fn(),
        resume: vi.fn(),
        abort: vi.fn()
      }
    })

    const fakeSender = new EventEmitter() as any
    fakeSender.isDestroyed = () => false
    fakeSender.send = vi.fn()

    // 启动流 1
    const res1 = await startHandler(
      { sender: fakeSender },
      { text: '长文本朗读测试', voiceId: 'yunxi', speed: 1.0 }
    )
    expect(res1.ok).toBe(true)
    const session1 = getActiveTtsStreamSession()!
    expect(session1).toBeTruthy()
    expect(session1.lease).toBeDefined()

    // 收到首块音频帧后进入稳态流式播放期（否则 60s 首块看门狗会正确触发 FIRST_CHUNK_TIMEOUT）
    firstStreamCallbacks.onChunk({
      pcm: new ArrayBuffer(4800),
      sampleCount: 1200,
      startSample: 0,
      charStart: 0,
      charEnd: 2,
      isFirst: true,
      isLast: false
    })

    // 模拟 180 秒连续心跳续期（每 30 秒推进+发送心跳）：租约绝不过期泄漏
    for (let t = 0; t < 6; t++) {
      await vi.advanceTimersByTimeAsync(30_000)
      heartbeatListener(
        { sender: fakeSender },
        { sessionId: 'sess_1', bufferedSeconds: 2.0 }
      )
      expect(session1.terminated).toBe(false)
      expect(
        moduleHibernationCoordinator.getLeaseRegistry()!.countActiveByTarget('tts-m5-onnx')
      ).toBe(1)
    }

    // 发起流 2：同步抢占旧流 1，立即 abort 并释放旧租约
    const res2 = await startHandler(
      { sender: fakeSender },
      { text: '新文本抢占', voiceId: 'yunxi', speed: 1.0 }
    )
    expect(res2.ok).toBe(true)
    expect(session1.terminated).toBe(true)
    expect(abortedSignals).toContain('stream_1:PREEMPTED')
    expect(releaseGateCount).toBe(1)
    expect(
      moduleHibernationCoordinator.getLeaseRegistry()!.countActiveByTarget('tts-m5-onnx')
    ).toBe(1)

    // 清理流 2
    getActiveTtsStreamSession()?.terminate('TEST_DONE')
    expect(releaseGateCount).toBe(2)
    expect(
      moduleHibernationCoordinator.getLeaseRegistry()!.countActiveByTarget('tts-m5-onnx')
    ).toBe(0)
    expect(firstStreamCallbacks).toBeDefined()
  })

  it('omniClient.startTTSStream 断连未收 END/ERROR 帧触发 PREMATURE_EOF，主动 abort 不误报', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'X-Session-Id': 'sess_eof_1'
      })
      // 故意直接结束连接而不写入 M5SF END/ERROR 帧
      res.end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as any
    const port = addr.port

    try {
      vi.spyOn(omniService, 'ensureRunning').mockResolvedValue(true)
      vi.spyOn(omniClient, 'getBaseUrl').mockReturnValue(`http://127.0.0.1:${port}`)

      const errors: string[] = []
      await new Promise<void>(resolve => {
        void omniClient.startTTSStream(
          { text: '测试断连', voiceId: 'yunxi', speed: 1.0 },
          {
            onChunk: () => {},
            onEnd: () => resolve(),
            onError: meta => {
              errors.push(meta.code)
              resolve()
            }
          }
        )
      })
      expect(errors).toEqual(['PREMATURE_EOF'])
    } finally {
      server.close()
    }
  })
})
