/**
 * 看门狗活性收割、对账器物理清除与崩溃断路器单元测试 (Ticket 05)
 * 遵循 L3 规格书: docs/specs/unified-module-hibernation-and-energy-transparency-spec.md §2.1 / §2.2
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ModuleHibernationCoordinator } from '../module-hibernation-coordinator'
import {
  CRASH_BREAKER_THRESHOLD,
  CRASH_WINDOW_MS,
  IEngineBridgeService,
  IN_FLIGHT_OP_NO_PROGRESS_HARD_TIMEOUT_MS,
  IN_FLIGHT_OP_STALL_TIMEOUT_MS,
  InFlightPhysicalOp,
  LIFECYCLE_OWNER_MAX_TTL_MS,
  ModuleRuntimeState,
  ProcessTreeIdentity,
  STABLE_RESIDENT_RESET_MS
} from '../types'
import { IModuleRuntimeStore } from '../module-runtime-store'

describe('Ticket 05: 看门狗、对账器与崩溃熔断器', () => {
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
    storeMap.set('pocket-cpu-int8-onnx', createInitialState('pocket-cpu-int8-onnx'))
    storeMap.set('firefly-ai-engine', {
      ...createInitialState('firefly-ai-engine'),
      effectiveMemoryKind: 'vram'
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
      persistBlockedUnloadGate: vi.fn(
        async (targetId: string, blocked: 0 | 1, identity: ProcessTreeIdentity | null) => {
          const item = storeMap.get(targetId)
          if (item) {
            item.blockedUnloadNoHandle = blocked
            item.blockedUnloadIdentity = identity
          }
        }
      ),
      commitSnapshot: vi.fn()
    } as unknown as IModuleRuntimeStore

    mockEngineBridge = {
      isProcessTreeExited: vi.fn(() => true),
      stopProcessTree: vi.fn(async () => {}),
      forceKillOldGeneration: vi.fn(async () => 'killed'),
      awaitProcessTreeExit: vi.fn(async () => 'exited')
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

  describe('reapStaleLifecycleOwners 看门狗活性收割', () => {
    it('对 supportsProgress=true 的在途 op：未停滞不收割，停滞超过 60s 触发强杀收敛', async () => {
      const now = Date.now()
      const opNotStalled: InFlightPhysicalOp = {
        opId: 'op_active',
        targetId: 'firefly-ai-engine',
        generation: 1,
        createdAt: now - 30_000,
        lastProgressAt: now - 10_000,
        status: 'running',
        supportsProgress: true
      }
      const opStalled: InFlightPhysicalOp = {
        opId: 'op_stalled',
        targetId: 'firefly-ai-engine',
        generation: 1,
        createdAt: now - 80_000,
        lastProgressAt: now - (IN_FLIGHT_OP_STALL_TIMEOUT_MS + 5_000),
        status: 'running',
        supportsProgress: true,
        abortController: new AbortController()
      }

      coordinator.registerInFlightOp(opNotStalled)
      coordinator.registerInFlightOp(opStalled)

      await coordinator.reapStaleLifecycleOwners()

      // op_active 仍在运行
      expect(coordinator.getInFlightOp('op_active')).toBeDefined()
      // op_stalled 已被收割并不在 activeInFlightOps
      expect(coordinator.getInFlightOp('op_stalled')).toBeUndefined()
      expect(opStalled.abortController?.signal.aborted).toBe(true)
      expect(mockEngineBridge.forceKillOldGeneration).toHaveBeenCalledWith(
        'firefly-ai-engine',
        1,
        undefined
      )
    })

    it('对 supportsProgress=false 的在途 op：120s 授予 1 次 60s 缓冲，180s 触发硬超时收敛', async () => {
      const now = Date.now()
      const op120s: InFlightPhysicalOp = {
        opId: 'op_slow',
        targetId: 'firefly-ai-engine',
        generation: 1,
        createdAt: now - IN_FLIGHT_OP_NO_PROGRESS_HARD_TIMEOUT_MS - 100,
        status: 'running',
        supportsProgress: false
      }

      coordinator.registerInFlightOp(op120s)

      // 首次达到 120s：授予缓冲，不强杀
      await coordinator.reapStaleLifecycleOwners()
      expect(op120s.extendedTimeoutGranted).toBe(true)
      expect(coordinator.getInFlightOp('op_slow')).toBeDefined()
      expect(mockEngineBridge.forceKillOldGeneration).not.toHaveBeenCalled()

      // 达到 180s：触发硬超时强杀
      op120s.createdAt = now - 185_000
      await coordinator.reapStaleLifecycleOwners()
      expect(coordinator.getInFlightOp('op_slow')).toBeUndefined()
      expect(mockEngineBridge.forceKillOldGeneration).toHaveBeenCalled()
    })

    it('180s 双轨分流 - 确证退出分支：forceKill 返回 killed，成功归位 hibernated 并 settled', async () => {
      const targetId = 'firefly-ai-engine'
      const state = storeMap.get(targetId)!
      state.state = 'loading'
      state.residentBytes = 1024

      vi.mocked(mockEngineBridge.forceKillOldGeneration).mockResolvedValue('killed')

      const op: InFlightPhysicalOp = {
        opId: 'op_killed',
        targetId,
        generation: 1,
        createdAt: Date.now() - 200_000,
        status: 'running',
        supportsProgress: false,
        extendedTimeoutGranted: true
      }
      coordinator.registerInFlightOp(op)

      await coordinator.reapStaleLifecycleOwners()

      expect(op.status).toBe('settled')
      const updated = storeMap.get(targetId)!
      expect(updated.state).toBe('hibernated')
      expect(updated.residentBytes).toBe(0)
    })

    it('180s 双轨分流 - 失败分支 1：forceKill 返回 no_handle，写入持久门闩并置 failed_unknown', async () => {
      const targetId = 'firefly-ai-engine'
      const state = storeMap.get(targetId)!
      state.state = 'loading'

      vi.mocked(mockEngineBridge.forceKillOldGeneration).mockResolvedValue('no_handle')

      const op: InFlightPhysicalOp = {
        opId: 'op_no_handle',
        targetId,
        generation: 1,
        createdAt: Date.now() - 200_000,
        status: 'running',
        supportsProgress: false,
        extendedTimeoutGranted: true
      }
      coordinator.registerInFlightOp(op)

      await coordinator.reapStaleLifecycleOwners()

      expect(op.status).toBe('failed_unknown')
      const updated = storeMap.get(targetId)!
      expect(updated.blockedUnloadNoHandle).toBe(1)
      expect(updated.state).toBe('error')
      expect(updated.errorPhase).toBe('unload')
      expect(coordinator.isBlockedUnload(targetId)).toBe(true)
    })

    it('180s 双轨分流 - 失败分支 2：3s 探针未能确证退出，写入持久门闩并置 failed_unknown', async () => {
      const targetId = 'firefly-ai-engine'
      const state = storeMap.get(targetId)!
      state.state = 'loading'

      const identity: ProcessTreeIdentity = {
        pid: 9999,
        startTimeMs: Date.now() - 100_000,
        generation: 1
      }

      vi.mocked(mockEngineBridge.forceKillOldGeneration).mockResolvedValue('unknown')
      vi.mocked(mockEngineBridge.awaitProcessTreeExit).mockResolvedValue('timeout')

      const op: InFlightPhysicalOp = {
        opId: 'op_probe_timeout',
        targetId,
        generation: 1,
        createdAt: Date.now() - 200_000,
        status: 'running',
        supportsProgress: false,
        extendedTimeoutGranted: true,
        identity
      }
      coordinator.registerInFlightOp(op)

      await coordinator.reapStaleLifecycleOwners()

      expect(op.status).toBe('failed_unknown')
      const updated = storeMap.get(targetId)!
      expect(updated.blockedUnloadNoHandle).toBe(1)
      expect(updated.blockedUnloadIdentity).toEqual(identity)
      expect(updated.state).toBe('error')
    })

    it('孤儿属主回收：属主超过 60s 且无在途物理 op/上下文时被看门狗收割并 bumpEpoch', async () => {
      const targetId = 'pocket-cpu-int8-onnx'
      const state = storeMap.get(targetId)!
      state.state = 'resident'

      // 申领 Token 并伪造过期
      const token = coordinator.beginLifecycleOperation(targetId, 'idle_hibernation')!
      expect(token).toBeDefined()
      const initialEpoch = coordinator.currentEpoch(targetId)

      // 将 grantedAt 篡改为 70 秒前
      ;(token as any).grantedAt = Date.now() - (LIFECYCLE_OWNER_MAX_TTL_MS + 10_000)

      await coordinator.reapStaleLifecycleOwners()

      // 属主被清理，代际递增
      expect(coordinator.getActiveOwner(targetId)).toBeUndefined()
      expect(coordinator.currentEpoch(targetId)).toBe(initialEpoch + 1)
    })

    it('孤儿属主保护：若存在未超时的在途物理 op，属主即使超 60s 也不被回收', async () => {
      const targetId = 'pocket-cpu-int8-onnx'
      const state = storeMap.get(targetId)!
      state.state = 'resident'

      const token = coordinator.beginLifecycleOperation(targetId, 'idle_hibernation')!
      ;(token as any).grantedAt = Date.now() - (LIFECYCLE_OWNER_MAX_TTL_MS + 10_000)

      // 注册一个正在运行的活跃 op
      const activeOp: InFlightPhysicalOp = {
        opId: 'op_underway',
        targetId,
        generation: 1,
        createdAt: Date.now() - 10_000,
        status: 'running',
        supportsProgress: true
      }
      coordinator.registerInFlightOp(activeOp)

      await coordinator.reapStaleLifecycleOwners()

      // 属主依然受保护保留
      expect(coordinator.getActiveOwner(targetId)).toBeDefined()
    })
  })

  describe('reconcileSuppressedIdentities 抑制条目物理对账器', () => {
    it('isExited=true 成功分支：严格 SQLite 先行闭环清除持久门闩，恢复 hibernated 并删除条目', async () => {
      const targetId = 'pocket-cpu-int8-onnx'
      const state = storeMap.get(targetId)!
      state.state = 'error'
      state.errorPhase = 'unload'
      state.lastFailureKind = 'unload'
      state.blockedUnloadNoHandle = 1

      const identity: ProcessTreeIdentity = {
        pid: 8888,
        startTimeMs: Date.now() - 50_000,
        generation: 1
      }
      coordinator.suppressStoppingIdentity({
        targetId,
        identity,
        suppressedAt: Date.now() - 10_000
      })
      coordinator.updateBlockedUnloadCache(targetId, true)

      vi.mocked(mockEngineBridge.isProcessTreeExited).mockReturnValue(true)

      await coordinator.reconcileSuppressedIdentities()

      expect(state.blockedUnloadNoHandle).toBe(0)
      expect(state.blockedUnloadIdentity).toBeNull()
      expect(state.state).toBe('hibernated')
      expect(coordinator.isBlockedUnload(targetId)).toBe(false)
      const key = coordinator.getIdentityKey(identity)
      expect(coordinator.hasSuppressedStoppingIdentity(key)).toBe(false)
    })

    it('isExited=true 异常分支：SQLite 清除持久门闩抛错时坚决保留内存缓存与抑制条目', async () => {
      const targetId = 'pocket-cpu-int8-onnx'
      const state = storeMap.get(targetId)!
      state.state = 'error'
      state.errorPhase = 'unload'

      const identity: ProcessTreeIdentity = {
        pid: 8888,
        startTimeMs: Date.now() - 50_000,
        generation: 1
      }
      const key = coordinator.getIdentityKey(identity)
      coordinator.suppressStoppingIdentity({
        targetId,
        identity,
        suppressedAt: Date.now() - 10_000
      })
      coordinator.updateBlockedUnloadCache(targetId, true)

      vi.mocked(mockEngineBridge.isProcessTreeExited).mockReturnValue(true)
      // 模拟 SQLite 物理持久化事务锁或磁盘满抛错
      vi.mocked(mockStore.persistBlockedUnloadGate).mockRejectedValueOnce(
        new Error('Disk I/O Error')
      )

      await coordinator.reconcileSuppressedIdentities()

      // 坚决不得清除内存缓存与抑制条目！
      expect(coordinator.isBlockedUnload(targetId)).toBe(true)
      expect(coordinator.hasSuppressedStoppingIdentity(key)).toBe(true)
    })

    it('isExited=false 分支：重试累计达到 10 次自动升级持久门闩保护并后台重试强杀', async () => {
      const targetId = 'firefly-ai-engine'
      const state = storeMap.get(targetId)!
      state.state = 'resident'

      const identity: ProcessTreeIdentity = {
        pid: 7777,
        startTimeMs: Date.now() - 100_000,
        generation: 1,
        treeHandle: 'JobObject_7777'
      }
      coordinator.suppressStoppingIdentity({
        targetId,
        identity,
        suppressedAt: Date.now() - 5_000,
        unknownRetryCount: 9 // 即将满 10 次
      })

      vi.mocked(mockEngineBridge.isProcessTreeExited).mockReturnValue(false)

      await coordinator.reconcileSuppressedIdentities()

      expect(state.blockedUnloadNoHandle).toBe(1)
      expect(state.blockedUnloadIdentity).toEqual(identity)
      expect(state.state).toBe('error')
      expect(state.errorPhase).toBe('unload')
      expect(coordinator.isBlockedUnload(targetId)).toBe(true)

      // 验证后台重试了停止与强杀，且透传了 treeHandle
      expect(mockEngineBridge.stopProcessTree).toHaveBeenCalledWith(identity)
      expect(mockEngineBridge.forceKillOldGeneration).toHaveBeenCalledWith(
        targetId,
        1,
        identity.treeHandle
      )
    })

    it('取消意图清理：超过 5s 正常防抖窗口且无活跃换型上下文时安全清除', async () => {
      const targetId = 'pocket-cpu-int8-onnx'
      coordinator.registerCancelIntent(targetId)
      expect(coordinator.hasCancelIntent(targetId)).toBe(true)

      // 刚注册 < 5s 不清理
      await coordinator.reconcileSuppressedIdentities()
      expect(coordinator.hasCancelIntent(targetId)).toBe(true)

      // 伪造注册时间超过 5s
      const intent = (coordinator as any).targetCancelIntent.get(targetId)
      intent.registeredAt = Date.now() - 6_000

      await coordinator.reconcileSuppressedIdentities()
      expect(coordinator.hasCancelIntent(targetId)).toBe(false)
    })
  })

  describe('incrementCrashStreak 与 CRASH_LOOP 熔断', () => {
    it('SERVICE_UNAVAILABLE 基础设施抖动严禁计入 crashStreak', () => {
      const targetId = 'pocket-cpu-int8-onnx'
      const count = coordinator.incrementCrashStreak(targetId, 'load', {
        code: 'SERVICE_UNAVAILABLE'
      })
      expect(count).toBe(0)
      expect(storeMap.get(targetId)!.crashStreak).toBe(0)
    })

    it('稳定驻留拉式单调重置 (ISS-06/07)：若模块已稳定驻留超 1 分钟，发生自愈入口直接重置 crashStreak=0', () => {
      const targetId = 'pocket-cpu-int8-onnx'
      const state = storeMap.get(targetId)!
      state.state = 'resident'
      state.crashStreak = 1

      // 记录驻留发生于 70 秒前 (超 60s)
      ;(coordinator as any).residentSinceMap.set(
        targetId,
        Date.now() - (STABLE_RESIDENT_RESET_MS + 10_000)
      )

      const count = coordinator.incrementCrashStreak(targetId, 'load')
      // 重置为 0 后再本次自增为 1
      expect(count).toBe(1)
      expect(state.crashStreak).toBe(1)
    })

    it('5 分钟滑动窗口内连续 2 次 load 失败触发 CRASH_LOOP 熔断', () => {
      const targetId = 'pocket-cpu-int8-onnx'
      const state = storeMap.get(targetId)!

      // 第一次失败
      const c1 = coordinator.incrementCrashStreak(targetId, 'load')
      expect(c1).toBe(1)
      expect(coordinator.isCrashLoopBlocked(targetId)).toBe(false)

      // 第二次失败
      const c2 = coordinator.incrementCrashStreak(targetId, 'load')
      expect(c2).toBe(2)
      expect(coordinator.isCrashLoopBlocked(targetId)).toBe(true)
      expect(state.state).toBe('error')
      expect(state.errorMessage).toBe('CRASH_LOOP')
      expect(state.lastErrorI18nKey).toBe('CRASH_LOOP')
    })

    it('超过 5 分钟滑动窗口自动重置 streak 为 1，不熔断', () => {
      const targetId = 'pocket-cpu-int8-onnx'
      coordinator.incrementCrashStreak(targetId, 'load')

      // 伪造上次崩溃发生于 6 分钟前
      ;(coordinator as any).lastCrashAtMap.set(targetId, Date.now() - (CRASH_WINDOW_MS + 60_000))

      const c2 = coordinator.incrementCrashStreak(targetId, 'load')
      expect(c2).toBe(1)
      expect(coordinator.isCrashLoopBlocked(targetId)).toBe(false)
    })

    it('模块加载成功 recordLoadSuccess 严格清零 crashStreak 与错误标记', () => {
      const targetId = 'pocket-cpu-int8-onnx'
      const state = storeMap.get(targetId)!
      state.crashStreak = 2
      state.errorMessage = 'CRASH_LOOP'
      state.lastErrorI18nKey = 'CRASH_LOOP'

      coordinator.recordLoadSuccess(targetId)

      expect(state.crashStreak).toBe(0)
      expect(state.errorMessage).toBeUndefined()
      expect(state.lastErrorI18nKey).toBeUndefined()
      expect(coordinator.isCrashLoopBlocked(targetId)).toBe(false)
    })
  })
})
