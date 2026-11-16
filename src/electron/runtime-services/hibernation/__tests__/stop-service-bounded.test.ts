/**
 * 有界停机原语、串行队列与全局停机抑制映射单元测试 (Ticket 06)
 * 遵循 L3 规格书: docs/specs/unified-module-hibernation-and-energy-transparency-spec.md §2.1 / §2.2
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ModuleHibernationCoordinator } from '../module-hibernation-coordinator'
import {
  IEngineBridgeService,
  InFlightPhysicalOp,
  ModuleRuntimeState,
  ProcessTreeIdentity
} from '../types'
import { IModuleRuntimeStore } from '../module-runtime-store'

describe('Ticket 06: 有界停机原语与全局停机抑制映射', () => {
  let coordinator: ModuleHibernationCoordinator
  let mockStore: IModuleRuntimeStore
  let mockEngineBridge: IEngineBridgeService
  let storeMap: Map<string, ModuleRuntimeState>
  let exitCallbackMap: Map<string, () => void>

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

    exitCallbackMap = new Map()

    mockEngineBridge = {
      isProcessTreeExited: vi.fn(() => false),
      stopProcessTree: vi.fn(async () => {}),
      forceKillOldGeneration: vi.fn(async () => 'killed'),
      awaitProcessTreeExit: vi.fn(async () => 'exited'),
      onProcessTreeExit: vi.fn((identity: ProcessTreeIdentity, cb: () => void) => {
        const key = `${identity.pid}_${identity.startTimeMs}`
        exitCallbackMap.set(key, cb)
        return () => {
          exitCallbackMap.delete(key)
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

  const tick = () => new Promise(resolve => setTimeout(resolve, 0))

  describe('stopServiceBounded 基础有界停机契约', () => {
    it('同一 target 串行排队执行，第二请求等待第一请求排队锁', async () => {
      const targetId = 'firefly-ai-engine'
      const identity: ProcessTreeIdentity = {
        pid: 1001,
        startTimeMs: Date.now(),
        generation: 1
      }

      let stopOrder: number[] = []

      // 模拟第一次停机慢调用
      const p1 = coordinator.stopServiceBounded(targetId, identity).then(res => {
        stopOrder.push(1)
        return res
      })

      // 再次调用同一 target 的停机
      const p2 = coordinator.stopServiceBounded(targetId, identity).then(res => {
        stopOrder.push(2)
        return res
      })

      // 等待异步进入临界区
      await tick()

      // 此时底层探针返回 exited，触发退出回调
      const key = `${identity.pid}_${identity.startTimeMs}`
      const cb = exitCallbackMap.get(key)
      expect(cb).toBeDefined()
      vi.mocked(mockEngineBridge.isProcessTreeExited).mockReturnValue(true)
      cb!()

      const [r1, r2] = await Promise.all([p1, p2])
      expect(r1.status).toBe('stopped_confirmed')
      expect(r2.status).toBe('stopped_confirmed')
      expect(stopOrder).toEqual([1, 2])
    })

    it('跨代停机时串行等待旧代次 identity 退出，前任成功则继续放行', async () => {
      const targetId = 'firefly-ai-engine'
      const oldIdentity: ProcessTreeIdentity = {
        pid: 1001,
        startTimeMs: Date.now() - 50_000,
        generation: 1
      }
      const newIdentity: ProcessTreeIdentity = {
        pid: 1002,
        startTimeMs: Date.now(),
        generation: 2
      }

      // 启动旧代次停机
      const pOld = coordinator.stopServiceBounded(targetId, oldIdentity)

      // 随后启动新代次停机（跨代）
      const pNew = coordinator.stopServiceBounded(targetId, newIdentity)

      // 等待异步进入临界区
      await tick()

      // 先让旧代次确认退出
      const oldKey = `${oldIdentity.pid}_${oldIdentity.startTimeMs}`
      const oldCb = exitCallbackMap.get(oldKey)
      expect(oldCb).toBeDefined()
      oldCb!()
      const oldRes = await pOld
      expect(oldRes.status).toBe('stopped_confirmed')

      // 等待 pNew 获取到 Mutex 并挂接新监听
      await tick()

      // 再让新代次确认退出
      const newKey = `${newIdentity.pid}_${newIdentity.startTimeMs}`
      const newCb = exitCallbackMap.get(newKey)
      expect(newCb).toBeDefined()
      newCb!()
      const newRes = await pNew
      expect(newRes.status).toBe('stopped_confirmed')
    })

    it('跨代停机时若前任旧代次停机失败 (failed_unknown)，新停机坚决阻断', async () => {
      const targetId = 'firefly-ai-engine'
      const oldIdentity: ProcessTreeIdentity = {
        pid: 1001,
        startTimeMs: Date.now() - 50_000,
        generation: 1
      }
      const newIdentity: ProcessTreeIdentity = {
        pid: 1002,
        startTimeMs: Date.now(),
        generation: 2
      }

      // 启动旧停机，并手动注入 failed_unknown 决议
      const oldKey = `${oldIdentity.pid}_${oldIdentity.startTimeMs}`
      const pOld = coordinator.stopServiceBounded(targetId, oldIdentity)
      await tick()

      const oldTask = (coordinator as any).activeStoppingTasksByIdentity.get(oldKey)
      expect(oldTask).toBeDefined()
      oldTask.resolveResult({
        status: 'failed_unknown',
        reason: 'timeout'
      })
      oldTask.status = 'failed_unknown'

      await pOld

      // 此时跨代启动新停机，应直接阻断
      const newRes = await coordinator.stopServiceBounded(targetId, newIdentity)
      expect(newRes.status).toBe('failed_unknown')
      expect(newRes.reason).toBe('previous_identity_failed_to_exit')
    })

    it('同 identity 重试自愈：命中 failed_unknown 时同步探针确证已消亡，即刻就地自愈无需二次点击', async () => {
      const targetId = 'firefly-ai-engine'
      const identity: ProcessTreeIdentity = {
        pid: 1001,
        startTimeMs: Date.now() - 20_000,
        generation: 1
      }
      const identityKey = `${identity.pid}_${identity.startTimeMs}`

      // 伪造前一次停机已超时的 failed_unknown 残留条目
      const oldEntry: any = {
        identity,
        status: 'failed_unknown',
        resultPromise: Promise.resolve({ status: 'failed_unknown' as const }),
        resolveResult: vi.fn()
      }
      ;(coordinator as any).activeStoppingTasksByIdentity.set(identityKey, oldEntry)
      ;(coordinator as any).targetStoppingIdentity.set(targetId, identityKey)

      // 模拟底层探针确证进程树已经完全退出
      vi.mocked(mockEngineBridge.isProcessTreeExited).mockReturnValue(true)

      // 用户再次触发停机
      const res = await coordinator.stopServiceBounded(targetId, identity)

      expect(res.status).toBe('stopped_confirmed')
      expect((coordinator as any).activeStoppingTasksByIdentity.has(identityKey)).toBe(false)
      expect(coordinator.hasStoppingIdentity(targetId)).toBe(false)
    })

    it('命中全局取消意图时，新建停机任务自动继承全局抑制，退出回调严格零写 Store', async () => {
      const targetId = 'firefly-ai-engine'
      const identity: ProcessTreeIdentity = {
        pid: 1001,
        startTimeMs: Date.now(),
        generation: 1
      }
      const identityKey = `${identity.pid}_${identity.startTimeMs}`

      // 注册取消意图
      coordinator.registerCancelIntent(targetId)

      // 启动停机
      const p = coordinator.stopServiceBounded(targetId, identity)
      await tick()

      // 验证已自动登记为全局抑制条目
      expect(coordinator.hasSuppressedStoppingIdentity(identityKey)).toBe(true)

      // 触发退出
      const cb = exitCallbackMap.get(identityKey)
      expect(cb).toBeDefined()
      cb!()
      const res = await p

      expect(res.status).toBe('stopped_confirmed')
      // 抑制条目在退出后被安全移除
      expect(coordinator.hasSuppressedStoppingIdentity(identityKey)).toBe(false)
      // 验证没有非法篡改 store
      expect(mockStore.update).not.toHaveBeenCalled()
    })
  })

  describe('cancelSlowLoading 取消加载缓慢操作', () => {
    it('确证消亡分支：底层杀树成功，状态安全归位 hibernated 并 settled', async () => {
      const targetId = 'pocket-cpu-int8-onnx'
      const state = storeMap.get(targetId)!
      state.state = 'loading'

      const op: InFlightPhysicalOp = {
        opId: 'op_loading',
        targetId,
        generation: 1,
        createdAt: Date.now() - 130_000,
        status: 'running',
        supportsProgress: false,
        abortController: new AbortController()
      }
      coordinator.registerInFlightOp(op)

      vi.mocked(mockEngineBridge.forceKillOldGeneration).mockResolvedValue('killed')

      await coordinator.cancelSlowLoading(targetId)

      expect(op.status).toBe('settled')
      expect(op.abortController?.signal.aborted).toBe(true)
      expect(state.state).toBe('hibernated')
      expect(state.residentBytes).toBe(0)
      expect(coordinator.hasCancelIntent(targetId)).toBe(true)
    })

    it('未确证消亡但持有 identity 分支：登记全局抑制并提交 error(unload)，交由后台对账重试', async () => {
      const targetId = 'pocket-cpu-int8-onnx'
      const state = storeMap.get(targetId)!
      state.state = 'loading'

      const identity: ProcessTreeIdentity = {
        pid: 2002,
        startTimeMs: Date.now() - 130_000,
        generation: 1
      }
      const op: InFlightPhysicalOp = {
        opId: 'op_loading_unknown',
        targetId,
        generation: 1,
        createdAt: Date.now() - 130_000,
        status: 'running',
        supportsProgress: false,
        identity
      }
      coordinator.registerInFlightOp(op)

      vi.mocked(mockEngineBridge.forceKillOldGeneration).mockResolvedValue('unknown')
      vi.mocked(mockEngineBridge.awaitProcessTreeExit).mockResolvedValue('unknown')

      await coordinator.cancelSlowLoading(targetId)

      expect(op.status).toBe('failed_unknown')
      const identityKey = `${identity.pid}_${identity.startTimeMs}`
      expect(coordinator.hasSuppressedStoppingIdentity(identityKey)).toBe(true)
      expect(state.state).toBe('error')
      expect(state.errorPhase).toBe('unload')
      expect(state.lastFailureKind).toBe('unload')
      // 不立即打死持久门闩，给后台对账 30s 宽限
      expect(state.blockedUnloadNoHandle).toBe(0)
    })

    it('句柄缺失分支 (no_handle)：立即升级落盘 SQLite 持久门闩并锁定', async () => {
      const targetId = 'pocket-cpu-int8-onnx'
      const state = storeMap.get(targetId)!
      state.state = 'loading'

      // 无 identity 且返回 unknown/no_handle
      const op: InFlightPhysicalOp = {
        opId: 'op_no_id',
        targetId,
        generation: 1,
        createdAt: Date.now() - 130_000,
        status: 'running',
        supportsProgress: false
      }
      coordinator.registerInFlightOp(op)

      vi.mocked(mockEngineBridge.forceKillOldGeneration).mockResolvedValue('no_handle')

      await coordinator.cancelSlowLoading(targetId)

      expect(op.status).toBe('failed_unknown')
      expect(state.blockedUnloadNoHandle).toBe(1)
      expect(coordinator.isBlockedUnload(targetId)).toBe(true)
      expect(state.state).toBe('error')
      expect(state.errorPhase).toBe('unload')
    })

    it('持有 identity 且 forceKill 返回 no_handle 时：坚决立即升级持久门闩并透传 identity (P2-3/P3-7)', async () => {
      const targetId = 'pocket-cpu-int8-onnx'
      const state = storeMap.get(targetId)!
      state.state = 'loading'

      const identity: ProcessTreeIdentity = {
        pid: 3003,
        startTimeMs: Date.now() - 130_000,
        generation: 1
      }
      const op: InFlightPhysicalOp = {
        opId: 'op_id_no_handle',
        targetId,
        generation: 1,
        createdAt: Date.now() - 130_000,
        status: 'running',
        supportsProgress: false,
        identity
      }
      coordinator.registerInFlightOp(op)

      vi.mocked(mockEngineBridge.forceKillOldGeneration).mockResolvedValue('no_handle')

      await coordinator.cancelSlowLoading(targetId)

      expect(op.status).toBe('failed_unknown')
      expect(state.blockedUnloadNoHandle).toBe(1)
      expect(state.blockedUnloadIdentity).toEqual(identity)
      expect(coordinator.isBlockedUnload(targetId)).toBe(true)
    })
  })

  describe('盲审修复回归测试 (P1-1 / P1-2 / P3-6)', () => {
    it('同 identity 重试时探针若显示仍未退出，必须重置旧任务并重新下发停机指令 (P1-2)', async () => {
      const targetId = 'firefly-ai-engine'
      const identity: ProcessTreeIdentity = {
        pid: 1001,
        startTimeMs: Date.now() - 20_000,
        generation: 1
      }
      const identityKey = `${identity.pid}_${identity.startTimeMs}`

      // 伪造前一次停机已超时的 failed_unknown 残留条目
      const oldEntry: any = {
        identity,
        status: 'failed_unknown',
        resultPromise: Promise.resolve({ status: 'failed_unknown' as const, reason: 'timeout' }),
        resolveResult: vi.fn()
      }
      ;(coordinator as any).activeStoppingTasksByIdentity.set(identityKey, oldEntry)
      ;(coordinator as any).targetStoppingIdentity.set(targetId, identityKey)

      // 模拟底层探针返回进程仍在运行 (false)
      vi.mocked(mockEngineBridge.isProcessTreeExited).mockReturnValue(false)

      // 用户再次触发停机：不应直接返回旧的 failed_unknown，而是创建新任务重新等待退出
      const p = coordinator.stopServiceBounded(targetId, identity)
      await tick()

      // 验证旧条目已被重置，新任务已经启动并监听退出事件
      const cb = exitCallbackMap.get(identityKey)
      expect(cb).toBeDefined()
      expect(mockEngineBridge.stopProcessTree).toHaveBeenCalledWith(identity)

      // 触发退出
      vi.mocked(mockEngineBridge.isProcessTreeExited).mockReturnValue(true)
      cb!()

      const res = await p
      expect(res.status).toBe('stopped_confirmed')
    })

    it('退出回调属主不匹配时：正确决议 failed_unknown 并释放 Mutex，杜绝永久死锁 (P1-1)', async () => {
      const targetId = 'firefly-ai-engine'
      const identity: ProcessTreeIdentity = {
        pid: 1001,
        startTimeMs: Date.now(),
        generation: 1
      }
      const identityKey = `${identity.pid}_${identity.startTimeMs}`

      // 启动停机
      const p = coordinator.stopServiceBounded(targetId, identity)
      await tick()

      // 模拟 entry 关联的 owner 与当前协调器在册 owner 不匹配
      const task = (coordinator as any).activeStoppingTasksByIdentity.get(identityKey)
      expect(task).toBeDefined()
      task.associatedTokenId = 'token_old_mismatched'

      const cb = exitCallbackMap.get(identityKey)
      expect(cb).toBeDefined()
      cb!()

      const res = await p
      expect(res.status).toBe('failed_unknown')
      expect((res as any).reason).toBe('owner_token_mismatch')

      // 验证 Mutex 没有死锁，后续新停机可以正常进入并执行
      const pNext = coordinator.stopServiceBounded(targetId, identity)
      await tick()
      const nextCb = exitCallbackMap.get(identityKey)
      expect(nextCb).toBeDefined()
      nextCb!()
      const nextRes = await pNext
      expect(nextRes.status).toBe('stopped_confirmed')
    })
  })
})
