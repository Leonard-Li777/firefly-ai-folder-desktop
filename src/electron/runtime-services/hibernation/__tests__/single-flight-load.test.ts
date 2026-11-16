/**
 * 单飞冷启动加载协程与四态屏障单元测试 (Ticket 07)
 * 遵循 L3 规格书: docs/specs/unified-module-hibernation-and-energy-transparency-spec.md §2.1
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ModuleHibernationCoordinator } from '../module-hibernation-coordinator'
import {
  HibernationGateAbortedError,
  IEngineBridgeService,
  ModuleRuntimeState,
  ProcessTreeIdentity
} from '../types'
import { IModuleRuntimeStore } from '../module-runtime-store'

describe('Ticket 07: 单飞冷启动加载协程与四态屏障', () => {
  let coordinator: ModuleHibernationCoordinator
  let mockStore: IModuleRuntimeStore
  let mockEngineBridge: IEngineBridgeService
  let storeMap: Map<string, ModuleRuntimeState>

  const createInitialState = (id: string): ModuleRuntimeState => ({
    id,
    clusterId: 'analysis_suite',
    modelGeneration: 1,
    defaultMemoryKind: 'ram',
    effectiveMemoryKind: 'ram',
    i18nNameKey: '测试模块',
    state: 'hibernated',
    residentBytes: 0,
    lastActiveTimestamp: Date.now(),
    crashStreak: 0,
    unloadFailStreak: 0,
    blockedUnloadNoHandle: 0,
    blockedUnloadIdentity: null
  })

  beforeEach(() => {
    storeMap = new Map<string, ModuleRuntimeState>()
    storeMap.set('firefly-ai-engine', {
      ...createInitialState('firefly-ai-engine'),
      effectiveMemoryKind: 'vram'
    })
    storeMap.set('pocket-cpu-int8-onnx', createInitialState('pocket-cpu-int8-onnx'))

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

    mockEngineBridge = {
      isProcessTreeExited: vi.fn(() => false),
      stopProcessTree: vi.fn(async () => {}),
      forceKillOldGeneration: vi.fn(async () => 'killed'),
      awaitProcessTreeExit: vi.fn(async () => 'exited'),
      loadModel: vi.fn(async (_targetId, _modelId, _options) => {
        return {
          identity: {
            pid: 5001,
            startTimeMs: Date.now(),
            generation: 1
          },
          jobHandle: 'JobObject_5001'
        }
      })
    }

    const mockLeaseRegistry = {
      countActiveByTarget: vi.fn(() => 0)
    } as any

    coordinator = new ModuleHibernationCoordinator({
      runtimeStore: mockStore,
      leaseRegistry: mockLeaseRegistry,
      engineBridgeService: mockEngineBridge
    })
  })

  describe('SingleFlightBarrier 并发防惊群', () => {
    it('并发多个加载请求复用同一在途 Promise，底层 loadModel 仅调用一次', async () => {
      const targetId = 'firefly-ai-engine'
      let resolveLoad!: (res: any) => void
      const slowLoadPromise = new Promise<{ identity: ProcessTreeIdentity; jobHandle: string }>(
        resolve => {
          resolveLoad = resolve
        }
      )
      vi.mocked(mockEngineBridge.loadModel!).mockReturnValue(slowLoadPromise)

      // 并发触发两个加载请求
      const p1 = coordinator.startSingleFlightLoad(targetId)
      const p2 = coordinator.startSingleFlightLoad(targetId)

      // 在途核查：应当处于同一 attemptId 的 inflight 屏障
      const inflight = coordinator.getInflightLoad(targetId)
      expect(inflight).toBeDefined()
      expect(mockEngineBridge.loadModel).toHaveBeenCalledTimes(1)

      // 模拟底层加载完成
      const identity: ProcessTreeIdentity = {
        pid: 6001,
        startTimeMs: Date.now(),
        generation: 1
      }
      resolveLoad({ identity, jobHandle: 'Job_6001' })

      await Promise.all([p1, p2])

      // 加载完成后屏障安全移除
      expect(coordinator.getInflightLoad(targetId)).toBeUndefined()
      const state = storeMap.get(targetId)!
      expect(state.state).toBe('resident')
    })

    it('模块已处于 resident 状态时，直接放行不再触发底层 loadModel', async () => {
      const targetId = 'firefly-ai-engine'
      storeMap.get(targetId)!.state = 'resident'

      await coordinator.startSingleFlightLoad(targetId)
      expect(mockEngineBridge.loadModel).not.toHaveBeenCalled()
    })
  })

  describe('四态屏障 (spawnState) 与加载进度更新', () => {
    it('正常流程流转：not_started -> spawning -> spawned 并持续更新 lastProgressAt', async () => {
      const targetId = 'pocket-cpu-int8-onnx'
      let capturedOnProgress: (() => void) | undefined
      let resolveLoad!: (res: any) => void

      vi.mocked(mockEngineBridge.loadModel!).mockImplementation(async (_t, _m, options) => {
        capturedOnProgress = options?.onProgress
        return new Promise(resolve => {
          resolveLoad = resolve
        })
      })

      const p = coordinator.startSingleFlightLoad(targetId)
      await new Promise(r => setTimeout(r, 10))

      // 正在加载中：spawnState 跃迁为 spawning
      const inFlightOps = Array.from((coordinator as any).activeInFlightOps.values())
      const op: any = inFlightOps.find((o: any) => o.targetId === targetId)
      expect(op).toBeDefined()
      expect(op.spawnState).toBe('spawning')
      const progress1 = op.lastProgressAt

      // 模拟下载进度触发回调
      await new Promise(r => setTimeout(r, 20))
      capturedOnProgress?.()
      expect(op.lastProgressAt).toBeGreaterThanOrEqual(progress1)

      // 进程返回
      resolveLoad({
        identity: { pid: 7001, startTimeMs: Date.now(), generation: 1 },
        jobHandle: 'Job_7001'
      })

      await p
      expect(op.status).toBe('settled')
      const state = storeMap.get(targetId)!
      expect(state.state).toBe('resident')
      expect(state.crashStreak).toBe(0)
    })

    it('底层直接抛错未生成进程时，spawnState 同步置为 failed', async () => {
      const targetId = 'pocket-cpu-int8-onnx'
      vi.mocked(mockEngineBridge.loadModel!).mockRejectedValue(new Error('CUDA out of memory'))

      await expect(coordinator.startSingleFlightLoad(targetId)).rejects.toThrow(
        'CUDA out of memory'
      )

      const state = storeMap.get(targetId)!
      expect(state.state).toBe('error')
      expect(state.lastFailureKind).toBe('load')
      expect(state.crashStreak).toBe(1)
    })
  })

  describe('冷启动看门狗超时与主动 Abort 熔断', () => {
    it('超时看门狗触发时主动 abort 信号，提交 error(load) 并自增 crashStreak', async () => {
      const targetId = 'firefly-ai-engine'
      vi.spyOn(coordinator, 'coldStartTimeoutMs').mockReturnValue(50)

      let abortSignal: AbortSignal | undefined
      vi.mocked(mockEngineBridge.loadModel!).mockImplementation(async (_t, _m, options) => {
        abortSignal = options?.signal
        return new Promise(() => {}) // 挂死不返回
      })

      const p = coordinator.startSingleFlightLoad(targetId)

      await expect(p).rejects.toThrow('加载超时')
      expect(abortSignal?.aborted).toBe(true)

      const state = storeMap.get(targetId)!
      expect(state.state).toBe('error')
      expect(state.errorPhase).toBe('load')
      expect(state.lastFailureKind).toBe('load')
      expect(state.lastErrorI18nKey).toBe('LOAD_TIMEOUT')
      expect(state.crashStreak).toBe(1)
      expect(coordinator.getInflightLoad(targetId)).toBeUndefined()
    })
  })

  describe('终局状态原子提交与孤儿进程回收', () => {
    it('加载成功彻底清零 crashStreak，刷新 residentSince 为当前时基', async () => {
      const targetId = 'firefly-ai-engine'
      const state = storeMap.get(targetId)!
      state.crashStreak = 1
      state.unloadFailStreak = 2

      await coordinator.startSingleFlightLoad(targetId)

      expect(state.state).toBe('resident')
      expect(state.crashStreak).toBe(0)
      expect(state.unloadFailStreak).toBe(0)
      expect(state.residentSince).toBeGreaterThan(0)
      expect(state.lastReleased).toBeUndefined()
      // P1-3: residentBytes 应当初始化为预估值，避免透视失真为 0
      expect(state.residentBytes).toBeGreaterThan(0)
    })

    it('底层发生 SERVICE_UNAVAILABLE 抖动时，严禁计入 crashStreak (P1-1)', async () => {
      const targetId = 'pocket-cpu-int8-onnx'
      const state = storeMap.get(targetId)!
      state.crashStreak = 0

      const err: any = new Error('Omni engine offline')
      err.code = 'SERVICE_UNAVAILABLE'
      vi.mocked(mockEngineBridge.loadModel!).mockRejectedValue(err)

      await expect(coordinator.startSingleFlightLoad(targetId)).rejects.toThrow(
        'Omni engine offline'
      )

      expect(state.state).toBe('error')
      expect(state.lastFailureKind).toBe('load')
      expect(state.crashStreak).toBe(0) // 严格豁免，不自增！
    })

    it('invalidateInflight 主动中断在途单飞并安全唤醒所有等待者 (P2-4)', async () => {
      const targetId = 'firefly-ai-engine'
      vi.mocked(mockEngineBridge.loadModel!).mockImplementation(async () => new Promise(() => {}))

      const p1 = coordinator.startSingleFlightLoad(targetId)
      const p2 = coordinator.startSingleFlightLoad(targetId)

      await new Promise(r => setTimeout(r, 10))
      expect(coordinator.getInflightLoad(targetId)).toBeDefined()

      // 外部换型主动作废
      coordinator.invalidateInflight(targetId, 'MODEL_SWAPPED')

      await expect(p1).rejects.toThrow('加载已被中断: MODEL_SWAPPED')
      await expect(p2).rejects.toThrow('加载已被中断: MODEL_SWAPPED')
      expect(coordinator.getInflightLoad(targetId)).toBeUndefined()
    })

    it('孤儿进程 5s 未能确证退出时，沉淀至全局抑制条目交由对账器追踪 (P2-5)', async () => {
      const targetId = 'firefly-ai-engine'
      const spawnedIdentity: ProcessTreeIdentity = {
        pid: 9001,
        startTimeMs: Date.now(),
        generation: 1
      }

      vi.mocked(mockEngineBridge.loadModel!).mockImplementation(async () => {
        // 模拟换型抢占
        coordinator.bumpEpoch(targetId)
        ;(coordinator as any).activeLifecycleOwner.set(targetId, {
          tokenId: 'preempting_token_2',
          targetId,
          epoch: 2,
          modelGeneration: 2,
          operation: 'model_swap',
          grantedAt: Date.now()
        })
        return { identity: spawnedIdentity, jobHandle: 'Job_9001' }
      })

      // 模拟底层 5s 超时未能确证退出 (unknown)
      vi.mocked(mockEngineBridge.awaitProcessTreeExit).mockResolvedValue('unknown')

      const parentToken = coordinator.beginLifecycleOperation(targetId, 'single_flight_load')!

      await expect(coordinator.startSingleFlightLoadWithToken(parentToken)).rejects.toThrow(
        '加载已被新生命周期操作接管'
      )

      // 验证已沉淀到全局抑制字典
      const key = coordinator.getIdentityKey(spawnedIdentity)
      expect(coordinator.hasSuppressedStoppingIdentity(key)).toBe(true)
    })

    it('加载返回后若被换型抢占，中止提交并自动拔除孤儿进程树', async () => {
      const targetId = 'firefly-ai-engine'
      const spawnedIdentity: ProcessTreeIdentity = {
        pid: 8001,
        startTimeMs: Date.now(),
        generation: 1
      }

      vi.mocked(mockEngineBridge.loadModel!).mockImplementation(async () => {
        // 在加载返回前，模拟外部换型操作抢占所有权
        coordinator.bumpEpoch(targetId)
        ;(coordinator as any).activeLifecycleOwner.set(targetId, {
          tokenId: 'preempting_token',
          targetId,
          epoch: 2,
          modelGeneration: 2,
          operation: 'model_swap',
          grantedAt: Date.now()
        })
        return { identity: spawnedIdentity, jobHandle: 'Job_8001' }
      })

      const parentToken = coordinator.beginLifecycleOperation(targetId, 'single_flight_load')!
      expect(parentToken).toBeDefined()

      await expect(coordinator.startSingleFlightLoadWithToken(parentToken)).rejects.toThrow(
        '加载已被新生命周期操作接管'
      )

      // 验证孤儿进程被底层 stopProcessTree 回收
      expect(mockEngineBridge.stopProcessTree).toHaveBeenCalledWith(spawnedIdentity)
      expect(mockEngineBridge.awaitProcessTreeExit).toHaveBeenCalledWith(spawnedIdentity, 5_000)
    })
  })
})
