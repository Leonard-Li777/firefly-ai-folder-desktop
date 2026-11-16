/**
 * 业务入场防护门闩与动态内存休眠定时器单元测试 (Ticket 09)
 * 遵循 L3 规格书: docs/specs/unified-module-hibernation-and-energy-transparency-spec.md §2.3 & §2.4
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ModuleHibernationCoordinator } from '../module-hibernation-coordinator'
import {
  DRAIN_CANCELABLE_WINDOW_MS,
  GateRequest,
  HibernationColdStartError,
  HibernationGateAbortedError,
  IEngineBridgeService,
  IPowerMonitorService,
  ModuleRuntimeState,
  ProcessTreeIdentity
} from '../types'
import { IModuleRuntimeStore } from '../module-runtime-store'

describe('Ticket 09: 排空反击穿门闩与动态内存休眠定时器', () => {
  let coordinator: ModuleHibernationCoordinator
  let mockStore: IModuleRuntimeStore
  let mockEngineBridge: IEngineBridgeService
  let mockLeaseRegistry: any
  let mockPowerMonitor: IPowerMonitorService
  let powerMonitorEvents: Map<string, () => void>
  let storeMap: Map<string, ModuleRuntimeState>
  let exitCallbackMap: Map<string, () => void>
  let mockFreeMem: number
  let mockTotalMem: number

  const createInitialState = (id: string): ModuleRuntimeState => ({
    id,
    clusterId: 'analysis_suite',
    modelGeneration: 1,
    defaultMemoryKind: 'vram',
    effectiveMemoryKind: 'vram',
    i18nNameKey: '测试大模型引擎',
    state: 'resident',
    residentBytes: 2 * 1024 * 1024 * 1024,
    lastActiveTimestamp: Date.now(),
    crashStreak: 0,
    unloadFailStreak: 0,
    blockedUnloadNoHandle: 0,
    blockedUnloadIdentity: null
  })

  beforeEach(() => {
    storeMap = new Map<string, ModuleRuntimeState>()
    storeMap.set('firefly-ai-engine', createInitialState('firefly-ai-engine'))
    storeMap.set('pocket-cpu-int8-onnx', {
      ...createInitialState('pocket-cpu-int8-onnx'),
      effectiveMemoryKind: 'ram',
      residentBytes: 300 * 1024 * 1024
    })
    storeMap.set('tts-m5-onnx', {
      ...createInitialState('tts-m5-onnx'),
      clusterId: 'tts_media',
      effectiveMemoryKind: 'ram',
      residentBytes: 200 * 1024 * 1024
    })

    mockStore = {
      get: vi.fn((id: string) => storeMap.get(id)),
      listAll: vi.fn(() => Array.from(storeMap.values())),
      update: vi.fn((id: string, apply: (draft: ModuleRuntimeState) => void) => {
        const item = storeMap.get(id)
        if (!item) return false
        apply(item)
        return true
      }),
      persistBlockedUnloadGate: vi.fn(async () => {}),
      commitSnapshot: vi.fn()
    } as unknown as IModuleRuntimeStore

    exitCallbackMap = new Map()
    let currentPid = 8001

    mockEngineBridge = {
      isProcessTreeExited: vi.fn(() => false),
      stopProcessTree: vi.fn(async (identity: ProcessTreeIdentity) => {
        const key = `${identity.pid}_${identity.startTimeMs}`
        const cb = exitCallbackMap.get(key)
        if (cb) {
          vi.mocked(mockEngineBridge.isProcessTreeExited).mockReturnValue(true)
          cb()
        }
      }),
      forceKillOldGeneration: vi.fn(async () => 'killed'),
      awaitProcessTreeExit: vi.fn(async () => 'exited'),
      onProcessTreeExit: vi.fn((identity: ProcessTreeIdentity, cb: () => void) => {
        const key = `${identity.pid}_${identity.startTimeMs}`
        exitCallbackMap.set(key, cb)
        return () => {
          exitCallbackMap.delete(key)
        }
      }),
      currentIdentity: vi.fn(() => ({
        pid: currentPid,
        startTimeMs: 1000,
        generation: 1
      })),
      isServiceRunning: vi.fn(() => true),
      loadModel: vi.fn(async (_targetId, _modelId, _options) => {
        currentPid += 10
        return {
          identity: {
            pid: currentPid,
            startTimeMs: Date.now(),
            generation: 1
          },
          jobHandle: `JobObject_${currentPid}`
        }
      })
    }

    let clusterActiveCount: Record<string, number> = {
      analysis_suite: 0,
      tts_media: 0
    }

    mockLeaseRegistry = {
      countActive: vi.fn((clusterId: string) => clusterActiveCount[clusterId] ?? 0),
      countActiveByTarget: vi.fn(() => 0),
      acquireLease: vi.fn((req: any) => {
        const clusterId = req.clusterId ?? 'analysis_suite'
        clusterActiveCount[clusterId] = (clusterActiveCount[clusterId] ?? 0) + 1
        const abortCtrl = new AbortController()
        return {
          leaseId: `lease_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          targetId: req.targetId,
          clusterId,
          abortController: abortCtrl,
          release: vi.fn(() => {
            clusterActiveCount[clusterId] = Math.max(0, (clusterActiveCount[clusterId] ?? 1) - 1)
          })
        }
      }),
      _setActiveCount: (clusterId: string, count: number) => {
        clusterActiveCount[clusterId] = count
      }
    }

    powerMonitorEvents = new Map()
    mockPowerMonitor = {
      on: vi.fn((event: string, listener: () => void) => {
        powerMonitorEvents.set(event, listener)
        return mockPowerMonitor
      }),
      getSystemIdleTime: vi.fn(() => 600) // 默认空闲 600 秒
    }

    mockFreeMem = 8 * 1024 * 1024 * 1024
    mockTotalMem = 16 * 1024 * 1024 * 1024

    coordinator = new ModuleHibernationCoordinator({
      runtimeStore: mockStore,
      leaseRegistry: mockLeaseRegistry,
      engineBridgeService: mockEngineBridge,
      powerMonitorService: mockPowerMonitor,
      getFreeMemory: () => mockFreeMem,
      getTotalMemory: () => mockTotalMem
    })
  })

  describe('withHibernationGate 权威持久门闩拦截', () => {
    it('当模块处于持久门闩阻断 (blockedUnloadNoHandle === 1) 时，坚决抛出 UNLOAD_ESCALATED', async () => {
      const targetId = 'firefly-ai-engine'
      mockStore.update(targetId, d => {
        d.blockedUnloadNoHandle = 1
      })

      const req: GateRequest = { targetId, clusterId: 'analysis_suite' }
      await expect(coordinator.withHibernationGate(req, async () => 'ok')).rejects.toSatisfy(
        (err: any) => err instanceof HibernationGateAbortedError && err.code === 'UNLOAD_ESCALATED'
      )
    })

    it('当模块处于持久门闩阻断 (blockedUnloadIdentity !== null) 时，坚决抛出 UNLOAD_ESCALATED', async () => {
      const targetId = 'firefly-ai-engine'
      mockStore.update(targetId, d => {
        d.blockedUnloadIdentity = { pid: 9999, startTimeMs: 1234, generation: 1 }
      })

      const req: GateRequest = { targetId, clusterId: 'analysis_suite' }
      await expect(coordinator.withHibernationGate(req, async () => 'ok')).rejects.toSatisfy(
        (err: any) => err instanceof HibernationGateAbortedError && err.code === 'UNLOAD_ESCALATED'
      )
    })
  })

  describe('两阶段排空 Stage 1 可撤销窗口 (500ms)', () => {
    it('在 Stage 1 可撤销窗口内新任务入场：同步撤销排空，状态原子恢复 resident，任务立即执行', async () => {
      const targetId = 'firefly-ai-engine'
      expect(mockStore.get(targetId)?.state).toBe('resident')

      // 启动两阶段排空（Stage 1 窗口 500ms）
      const drainPromise = coordinator.drainModuleTwoStage(targetId)

      // 排空进入 Stage 1，状态跃迁为 draining
      expect(mockStore.get(targetId)?.state).toBe('draining')

      // 在可撤销窗口内（例如 50ms），新业务请求入场
      const req: GateRequest = { targetId, clusterId: 'analysis_suite' }
      const taskResult = await coordinator.withHibernationGate(req, async (lease, _signal) => {
        expect(lease).toBeDefined()
        return 'task_success'
      })

      expect(taskResult).toBe('task_success')
      // 状态恢复为 resident，旧进程未被杀死
      expect(mockStore.get(targetId)?.state).toBe('resident')

      // 排空协程正常退让退出并返回 false
      const drainResult = await drainPromise
      expect(drainResult).toBe(false)
    })
  })

  describe('两阶段排空 Stage 2 不可逆排空与分桶挂起', () => {
    it('跨过 500ms 窗口进入 Stage 2：新任务入桶排队，卸载完成后链入冷启动加载放行', async () => {
      const targetId = 'firefly-ai-engine'
      vi.useFakeTimers()

      try {
        let triggerExit: (() => void) | undefined
        vi.mocked(mockEngineBridge.stopProcessTree).mockImplementationOnce(
          async (identity: ProcessTreeIdentity) => {
            const key = `${identity.pid}_${identity.startTimeMs}`
            const cb = exitCallbackMap.get(key)
            triggerExit = () => {
              vi.mocked(mockEngineBridge.isProcessTreeExited).mockReturnValue(true)
              cb?.()
            }
          }
        )

        // 启动两阶段排空
        const drainPromise = coordinator.drainModuleTwoStage(targetId)

        // 推进时间越过 500ms 可撤销窗口 (到 550ms 进入 Stage 2 卸载停机)
        await vi.advanceTimersByTimeAsync(DRAIN_CANCELABLE_WINDOW_MS + 50)

        // 此时已越过不可逆点，新请求到达挂入分桶排队
        let taskExecuted = false
        const req: GateRequest = { targetId, clusterId: 'analysis_suite' }
        const gateTaskPromise = coordinator.withHibernationGate(req, async lease => {
          taskExecuted = true
          return 'gate_done'
        })

        // 在卸载完成前，任务必须排队等待不可执行
        expect(taskExecuted).toBe(false)
        expect(mockStore.get(targetId)?.state).toBe('draining')

        // 模拟底层进程完成物理退出
        triggerExit?.()

        const drainResult = await drainPromise
        expect(drainResult).toBe(true)

        // 排空完成后自动唤醒分桶并链入冷启动，最终任务成功执行
        const gateResult = await gateTaskPromise
        expect(gateResult).toBe('gate_done')
        expect(taskExecuted).toBe(true)
        expect(mockStore.get(targetId)?.state).toBe('resident')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('群组空闲休眠定时器调度与动态比例内存算法', () => {
    it('活跃租约变更为 0 时启动 5 分钟空闲倒计时；内存吃紧时到点触发优雅排空', async () => {
      const clusterId = 'tts_media'
      const targetId = 'tts-m5-onnx'

      vi.useFakeTimers()
      try {
        // 模拟当前物理可用内存极低 (例如 100MB，远低于 4G/8G 内存下的比例阈值)
        mockFreeMem = 100 * 1024 * 1024
        mockTotalMem = 8 * 1024 * 1024 * 1024

        // 广播租约计数归零
        coordinator.onClusterActivityChanged(clusterId)

        // 分步推进：先推进 5 分钟触发空闲超时，再推进 550ms 越过两阶段排空 Stage 1 窗口
        await vi.advanceTimersByTimeAsync(300_000)
        await vi.advanceTimersByTimeAsync(DRAIN_CANCELABLE_WINDOW_MS + 50)

        // 模块已被优雅排空为 hibernated
        expect(mockStore.get(targetId)?.state).toBe('hibernated')
      } finally {
        vi.useRealTimers()
      }
    })

    it('若倒计时期间有新任务激活 (活跃租约 > 0)，定时器即刻取消，不触发休眠', async () => {
      const clusterId = 'tts_media'
      const targetId = 'tts-m5-onnx'

      vi.useFakeTimers()
      try {
        // 启动倒计时
        coordinator.onClusterActivityChanged(clusterId)

        // 推进 2 分钟
        await vi.advanceTimersByTimeAsync(120_000)

        // 模拟新租约申领
        mockLeaseRegistry._setActiveCount(clusterId, 1)
        coordinator.onClusterActivityChanged(clusterId)

        // 继续推进 10 分钟
        await vi.advanceTimersByTimeAsync(600_000)

        // 状态依然为 resident，绝不误杀！
        expect(mockStore.get(targetId)?.state).toBe('resident')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('系统事件即时节能 (powerMonitor 锁屏与挂起)', () => {
    it('收到 lock-screen 事件：对处于空闲的 resident 模块立即发起两阶段排空 (跳过内存门限)', async () => {
      const targetId = 'pocket-cpu-int8-onnx'
      vi.useFakeTimers()

      try {
        // 触发锁屏事件
        const lockScreenListener = powerMonitorEvents.get('lock-screen')
        expect(lockScreenListener).toBeDefined()
        lockScreenListener!()

        // 推进 550ms 完成两阶段排空
        await vi.advanceTimersByTimeAsync(DRAIN_CANCELABLE_WINDOW_MS + 50)

        expect(mockStore.get(targetId)?.state).toBe('hibernated')
      } finally {
        vi.useRealTimers()
      }
    })

    it('若群组繁忙 (isClusterDrainSafe 为 false)，lock-screen 绝不误杀处于工作中的模块', async () => {
      const targetId = 'pocket-cpu-int8-onnx'
      // 模拟群组有在途活跃任务
      mockLeaseRegistry._setActiveCount('analysis_suite', 1)

      const lockScreenListener = powerMonitorEvents.get('lock-screen')
      lockScreenListener!()

      expect(mockStore.get(targetId)?.state).toBe('resident')
    })
  })
})
