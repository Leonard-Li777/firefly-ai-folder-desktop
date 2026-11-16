/**
 * 大模型热切换事务与取消协作上下文单元测试 (Ticket 08)
 * 遵循 L3 规格书: docs/specs/unified-module-hibernation-and-energy-transparency-spec.md §2.1.2 & §2.2
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

describe('Ticket 08: 大模型热切换事务与取消协作上下文', () => {
  let coordinator: ModuleHibernationCoordinator
  let mockStore: IModuleRuntimeStore
  let mockEngineBridge: IEngineBridgeService
  let mockLeaseRegistry: any
  let storeMap: Map<string, ModuleRuntimeState>
  let exitCallbackMap: Map<string, () => void>

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
    let currentPid = 6001

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
            generation: 2
          },
          jobHandle: `JobObject_${currentPid}`
        }
      })
    }

    let activeLeasesCount = 0
    mockLeaseRegistry = {
      countActiveByTarget: vi.fn(() => activeLeasesCount),
      cancelAllByTarget: vi.fn(() => {
        activeLeasesCount = 0
      }),
      forceReleaseByTarget: vi.fn((_targetId: string) => {
        activeLeasesCount = 0
        return []
      }),
      _setActiveLeases: (count: number) => {
        activeLeasesCount = count
      }
    }

    coordinator = new ModuleHibernationCoordinator({
      runtimeStore: mockStore,
      leaseRegistry: mockLeaseRegistry,
      engineBridgeService: mockEngineBridge
    })
  })

  describe('换型前置标记持有 (holdSwap / releaseSwapHold)', () => {
    it('进入互斥锁之前同步持有换型标记，isSwapInProgress 立即为 true', () => {
      const targetId = 'firefly-ai-engine'
      expect(coordinator.isSwapInProgress(targetId)).toBe(false)

      coordinator.holdSwap(targetId)
      expect(coordinator.isSwapInProgress(targetId)).toBe(true)

      // 多次持有需多次释放 (引用计数)
      coordinator.holdSwap(targetId)
      coordinator.releaseSwapHold(targetId)
      expect(coordinator.isSwapInProgress(targetId)).toBe(true)

      coordinator.releaseSwapHold(targetId)
      expect(coordinator.isSwapInProgress(targetId)).toBe(false)
    })
  })

  describe('大模型热切换完整事务 (beginModelSwap)', () => {
    it('正常流程：中止在途租约 -> 停机旧进程 -> 单飞拉起新模型 -> 推进代次并释放换型锁', async () => {
      const targetId = 'firefly-ai-engine'
      mockLeaseRegistry._setActiveLeases(2)

      const result = await coordinator.beginModelSwap(targetId, 'gemma-2-9b-it')

      expect(result.status).toBe('swapped')
      expect(result.generation).toBe(2)
      // 旧租约被取消与强制收敛
      expect(mockLeaseRegistry.forceReleaseByTarget).toHaveBeenCalledWith(targetId)
      // 换型完成后换型锁定被释放
      expect(coordinator.isSwapInProgress(targetId)).toBe(false)
      // 模块代次更新且状态保持为 resident
      const runtimeState = mockStore.get(targetId)
      expect(runtimeState?.modelGeneration).toBe(2)
      expect(runtimeState?.state).toBe('resident')
      expect(runtimeState?.unloadFailStreak).toBe(0)
    })

    it('旧租约未在上限内归零：受 10s 硬上限保护，超时后强行继续旧停机并不被死锁', async () => {
      const targetId = 'firefly-ai-engine'
      // 租约计数恒不归零
      mockLeaseRegistry._setActiveLeases(3)
      mockLeaseRegistry.countActiveByTarget = vi.fn(() => 3)

      vi.useFakeTimers()
      try {
        const swapPromise = coordinator.beginModelSwap(targetId, 'new-model')

        // 推进时间超过 LEASE_SWAP_DRAIN_TIMEOUT_MS (10s)
        await vi.advanceTimersByTimeAsync(11_000)

        const result = await swapPromise
        expect(result.status).toBe('swapped')
      } finally {
        vi.useRealTimers()
      }
    })

    it('旧进程停机失败 (failed_unknown) 时：坚决阻断新模型启动，代次原子回滚，模块进入 error 终态', async () => {
      const targetId = 'firefly-ai-engine'
      // 模拟 stopServiceBounded 返回 failed_unknown
      vi.spyOn(coordinator, 'stopServiceBounded').mockResolvedValue({
        status: 'failed_unknown',
        reason: 'process_stuck_timeout'
      })

      await expect(coordinator.beginModelSwap(targetId, 'new-model')).rejects.toSatisfy(
        (err: any) => err instanceof HibernationGateAbortedError && err.code === 'UNLOAD_ESCALATED'
      )

      // 底层 loadModel 坚决不可被调用！
      expect(mockEngineBridge.loadModel).not.toHaveBeenCalled()
      // 模块进入 error 终态，代次原子回滚为 1 (P2-01)
      const runtimeState = mockStore.get(targetId)
      expect(runtimeState?.state).toBe('error')
      expect(runtimeState?.lastFailureKind).toBe('unload')
      expect(runtimeState?.modelGeneration).toBe(1)
      // 换型标记被安全清理
      expect(coordinator.isSwapInProgress(targetId)).toBe(false)
    })

    it('换型前置收敛在途停机任务 (P1-03)：若已有旧进程在途停机，必须等待其决议后方可推进', async () => {
      const targetId = 'firefly-ai-engine'
      const oldIdentity: ProcessTreeIdentity = { pid: 7001, startTimeMs: 2000, generation: 1 }
      const oldIdentityKey = `${oldIdentity.pid}_${oldIdentity.startTimeMs}`

      let resolvePrevStop!: (res: any) => void
      const prevStopPromise = new Promise(r => {
        resolvePrevStop = r
      })

      // 模拟先前已有在途停机任务
      ;(coordinator as any).targetStoppingIdentity.set(targetId, oldIdentityKey)
      ;(coordinator as any).activeStoppingTasksByIdentity.set(oldIdentityKey, {
        identity: oldIdentity,
        status: 'running',
        resultPromise: prevStopPromise
      })

      // 让 currentIdentity 为 undefined，模拟桥接层已解绑旧进程
      vi.mocked(mockEngineBridge.currentIdentity!).mockReturnValue(undefined)

      const swapPromise = coordinator.beginModelSwap(targetId, 'new-model')

      // 在途停机未决议前，新模型 loadModel 不应被触发
      expect(mockEngineBridge.loadModel).not.toHaveBeenCalled()

      // 决议先前在途停机
      resolvePrevStop({ status: 'stopped_confirmed' })

      const result = await swapPromise
      expect(result.status).toBe('swapped')
      expect(mockEngineBridge.loadModel).toHaveBeenCalled()
    })
  })

  describe('换型协作取消机制 (cancelModelSwap)', () => {
    it('在停机等待过程中触发 cancelModelSwap：快速响应中断，回滚代次并释放换型锁', async () => {
      const targetId = 'firefly-ai-engine'
      let resolveStop!: (res: any) => void
      const slowStopPromise = new Promise<{ status: 'stopped_confirmed' }>(r => {
        resolveStop = r
      })
      vi.spyOn(coordinator, 'stopServiceBounded').mockReturnValue(slowStopPromise as any)

      // 启动换型事务
      const swapPromise = coordinator.beginModelSwap(targetId, 'slow-swap-model')

      // 等待进入换型事务
      expect(coordinator.isSwapInProgress(targetId)).toBe(true)

      // 发起协作取消
      const cancelPromise = coordinator.cancelModelSwap(targetId)

      // 释放停机等待让协程继续响应 abort
      resolveStop({ status: 'stopped_confirmed' })

      const cancelResult = await cancelPromise
      expect(cancelResult.status).toBe('cancelled')

      await expect(swapPromise).rejects.toThrow(HibernationGateAbortedError)

      // 状态已原子回滚
      expect(coordinator.isSwapInProgress(targetId)).toBe(false)
      const runtimeState = mockStore.get(targetId)
      expect(runtimeState?.modelGeneration).toBe(1)
    })

    it('在新模型单飞加载阶段触发 cancelModelSwap：快速响应中断并原子回滚', async () => {
      const targetId = 'firefly-ai-engine'
      let resolveLoad!: (res: any) => void
      const slowLoadPromise = new Promise(r => {
        resolveLoad = r
      })
      vi.mocked(mockEngineBridge.loadModel!).mockReturnValue(slowLoadPromise as any)

      const swapPromise = coordinator.beginModelSwap(targetId, 'slow-loading-model')

      // 等待旧进程停机完成，进入 loadModel
      await new Promise(r => setTimeout(r, 20))

      const cancelPromise = coordinator.cancelModelSwap(targetId)
      resolveLoad({
        identity: { pid: 9999, startTimeMs: Date.now(), generation: 2 },
        jobHandle: 'Job_9999'
      })

      const cancelResult = await cancelPromise
      expect(cancelResult.status).toBe('cancelled')
      await expect(swapPromise).rejects.toThrow(HibernationGateAbortedError)

      expect(coordinator.isSwapInProgress(targetId)).toBe(false)
      const runtimeState = mockStore.get(targetId)
      expect(runtimeState?.modelGeneration).toBe(1)
    })

    it('并发换型下 holdSwap 具有引用计数保护，取消当前换型不影响后继换型锁定 (P1-01)', async () => {
      const targetId = 'firefly-ai-engine'
      let resolveStop!: (res: any) => void
      const slowStopPromise = new Promise<{ status: 'stopped_confirmed' }>(r => {
        resolveStop = r
      })
      vi.spyOn(coordinator, 'stopServiceBounded').mockReturnValue(slowStopPromise as any)

      // 启动第一个换型
      const swapPromise = coordinator.beginModelSwap(targetId, 'model-1')
      expect(coordinator.isSwapInProgress(targetId)).toBe(true)

      // 模拟后继换型在排队 (holdSwap 额外加 1)
      coordinator.holdSwap(targetId)

      // 取消第一个换型
      const cancelPromise = coordinator.cancelModelSwap(targetId)
      resolveStop({ status: 'stopped_confirmed' })

      await cancelPromise
      await expect(swapPromise).rejects.toThrow(HibernationGateAbortedError)

      // 由于后继换型仍持有 holdSwap，target 仍处于换型锁定中 (P1-01 杜绝双重释放)
      expect(coordinator.isSwapInProgress(targetId)).toBe(true)

      // 后继换型释放持有
      coordinator.releaseSwapHold(targetId)
      expect(coordinator.isSwapInProgress(targetId)).toBe(false)
    })

    it('若无在途换型，cancelModelSwap 返回 no_swap_in_progress', async () => {
      const targetId = 'firefly-ai-engine'
      const cancelResult = await coordinator.cancelModelSwap(targetId)
      expect(cancelResult.status).toBe('no_swap_in_progress')
    })
  })
})
