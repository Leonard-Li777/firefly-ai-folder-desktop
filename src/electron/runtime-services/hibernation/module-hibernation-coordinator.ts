/**
 * 统一模块休眠调度协调器 (ModuleHibernationCoordinator)
 * 遵循 L3 规格书: docs/specs/unified-module-hibernation-and-energy-transparency-spec.md §2.1 / §2.2
 */

import * as os from 'node:os'
import { logger, LogCategory } from '@firefly/shared'
import { LeaseRegistry } from './lease-registry'
import { computeHibernationMemoryThreshold, MemoryProbe, memoryProbe } from './memory-probe'
import { IModuleRuntimeStore, moduleRuntimeStore } from './module-runtime-store'
import { projectMemoryGauges } from './memory-gauges'
import {
  AdmissionToken,
  ANALYSIS_SUITE_IDLE_TIMEOUT_MS,
  AsyncMutex,
  CANCEL_AWAIT_STOP_TIMEOUT_MS,
  CANCEL_INTENT_HARD_TTL_MS,
  CANCEL_INTENT_MIN_TTL_MS,
  CancelSwapResult,
  COLD_START_DEFAULT_TIMEOUT_MS,
  COLD_START_MIN_TIMEOUT_MS,
  CRASH_BREAKER_THRESHOLD,
  CRASH_WINDOW_MS,
  DRAIN_CANCELABLE_WINDOW_MS,
  DrainTransactionContext,
  GateQueueWaiter,
  GateRequest,
  HIBERNATABLE_TARGET_CATALOG,
  HibernationColdStartError,
  HibernationGateAbortedError,
  HibernationLeaseHandle,
  HibernationSnapshot,
  IEngineBridgeService,
  IN_FLIGHT_OP_NO_PROGRESS_HARD_TIMEOUT_MS,
  IN_FLIGHT_OP_STALL_TIMEOUT_MS,
  InFlightPhysicalOp,
  InflightLoad,
  IPowerMonitorService,
  LEASE_SWAP_DRAIN_TIMEOUT_MS,
  LIFECYCLE_OWNER_MAX_TTL_MS,
  LifecycleOperation,
  LifecycleToken,
  MAX_GRACE_PERIOD_MS,
  ModuleRuntimeMetric,
  ModuleRuntimeState,
  ProcessTreeIdentity,
  STABLE_RESIDENT_RESET_MS,
  STOP_COMPLETION_HARD_TIMEOUT_MS,
  STOP_SERVICE_HARD_TIMEOUT_MS,
  StoppingTaskEntry,
  StopServiceResult,
  SuppressedStoppingIdentityEntry,
  SwapCancelContext,
  SwapRollbackSnapshot,
  TargetCancelIntentEntry,
  TTS_IDLE_TIMEOUT_MS
} from './types'

export interface ModuleHibernationCoordinatorOptions {
  runtimeStore?: IModuleRuntimeStore
  leaseRegistry?: LeaseRegistry
  memoryProbe?: MemoryProbe
  engineBridgeService?: IEngineBridgeService
  onClusterActivityChanged?: (clusterId: 'analysis_suite' | 'tts_media') => void
  coldStartTimeoutMsProvider?: (targetId?: string) => number
  powerMonitorService?: IPowerMonitorService
  getSystemIdleTime?: () => number
  getFreeMemory?: () => number
  getTotalMemory?: () => number
}

/** 模块休眠调度协调器核心骨架 */
export class ModuleHibernationCoordinator {
  private readonly runtimeStore: IModuleRuntimeStore
  private leaseRegistryInstance?: LeaseRegistry
  private readonly memoryProbe: MemoryProbe
  private engineBridgeServiceInstance?: IEngineBridgeService
  private readonly onClusterActivityChangedCb?: (clusterId: 'analysis_suite' | 'tts_media') => void
  private readonly coldStartTimeoutMsProvider?: (targetId?: string) => number

  /** 各目标当前代际 Fencing 计数器: targetId -> epoch */
  private readonly targetEpochs = new Map<string, number>()
  /** 各目标当前生命周期活动所有者 (SSOT): targetId -> LifecycleToken */
  private readonly activeLifecycleOwner = new Map<string, LifecycleToken>()

  /** 在途物理操作索引 (SSOT 以 opId 为键): opId -> InFlightPhysicalOp */
  private readonly activeInFlightOps = new Map<string, InFlightPhysicalOp>()
  /** 全局抑制停止条目 (以 targetId_pid_startTime 为键): identityKey -> entry */
  private readonly globalSuppressedStoppingIdentities = new Map<
    string,
    SuppressedStoppingIdentityEntry
  >()
  /** 取消意图条目: targetId -> TargetCancelIntentEntry */
  private readonly targetCancelIntent = new Map<string, TargetCancelIntentEntry>()
  /** 内存门闩快速判定缓存: targetId -> boolean */
  private readonly blockedUnloadCache = new Map<string, boolean>()

  /** 崩溃滑动窗口与稳定驻留计时字典 */
  private readonly lastCrashAtMap = new Map<string, number>()
  private readonly residentSinceMap = new Map<string, number>()

  /** 换型与停机在途上下文跟踪集合与字典 */
  private readonly swapCancelContexts = new Map<string, SwapCancelContext>()
  private readonly targetStoppingIdentity = new Map<string, string>() // targetId -> identityKey
  private readonly pendingSwapDraining = new Set<string>()

  /** 引擎生命周期全局互斥锁 (Ticket 08: 保护换型事务与取消协作) */
  private readonly engineLifecycleMutex = new AsyncMutex()
  /** 换型引用计数持有集: targetId -> count */
  private readonly swapHoldCount = new Map<string, number>()
  /** 处于换型锁定中的目标集合 */
  private readonly swappingTargets = new Set<string>()

  /** per-target 停机串行化互斥锁: targetId -> AsyncMutex */
  private readonly targetStoppingMutex = new Map<string, AsyncMutex>()
  /** 停机在途任务索引: identityKey -> StoppingTaskEntry */
  private readonly activeStoppingTasksByIdentity = new Map<string, StoppingTaskEntry>()
  /** 活跃中的停机任务清理句柄集合 (P2-5 统一防泄漏) */
  private readonly stoppingCleanups = new Set<() => void>()

  /** 单飞加载在途屏障索引 (Ticket 07): targetId -> InflightLoad */
  private readonly inflightLoads = new Map<string, InflightLoad>()
  private nextAttemptId = 0

  /** Gate 阶段 2 分桶等待者队列 (Ticket 09): targetId -> GateQueueWaiter[] */
  private readonly gateWaiters = new Map<string, GateQueueWaiter[]>()
  /** 在途两阶段排空事务上下文 (Ticket 09): targetId -> DrainTransactionContext */
  private readonly activeDrain = new Map<string, DrainTransactionContext>()

  /** 群组空闲倒计时与宽限计时字典 (Ticket 09) */
  private readonly clusterIdleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly clusterGraceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly clusterIdleStartTime = new Map<string, number>()
  private powerMonitorServiceInstance?: IPowerMonitorService
  private readonly getSystemIdleTimeProvider?: () => number
  private readonly getFreeMemoryProvider?: () => number
  private readonly getTotalMemoryProvider?: () => number

  constructor(options?: ModuleHibernationCoordinatorOptions) {
    this.runtimeStore = options?.runtimeStore ?? moduleRuntimeStore
    this.leaseRegistryInstance = options?.leaseRegistry
    this.memoryProbe = options?.memoryProbe ?? memoryProbe
    this.engineBridgeServiceInstance = options?.engineBridgeService
    this.onClusterActivityChangedCb = options?.onClusterActivityChanged
    this.coldStartTimeoutMsProvider = options?.coldStartTimeoutMsProvider
    this.powerMonitorServiceInstance = options?.powerMonitorService
    this.getSystemIdleTimeProvider = options?.getSystemIdleTime
    this.getFreeMemoryProvider = options?.getFreeMemory
    this.getTotalMemoryProvider = options?.getTotalMemory

    if (options?.powerMonitorService) {
      this.setupPowerMonitorIntegration(options.powerMonitorService)
    }
  }

  /** 注入或绑定租约中心引用 */
  setLeaseRegistry(leaseRegistry: LeaseRegistry): void {
    this.leaseRegistryInstance = leaseRegistry
  }

  /** 获取底层租约中心 */
  getLeaseRegistry(): LeaseRegistry | undefined {
    return this.leaseRegistryInstance
  }

  /** 注入或绑定引擎桥接服务引用 */
  setEngineBridgeService(service: IEngineBridgeService): void {
    this.engineBridgeServiceInstance = service
  }

  /** 获取底层引擎桥接服务 */
  getEngineBridgeService(): IEngineBridgeService | undefined {
    return this.engineBridgeServiceInstance
  }

  /** 获取内存探针引用 */
  getMemoryProbe(): MemoryProbe {
    return this.memoryProbe
  }

  /** 获取运行时存储引用 */
  getRuntimeStore(): IModuleRuntimeStore {
    return this.runtimeStore
  }

  /** 获取指定目标当前代际 (Epoch) */
  currentEpoch(targetId: string): number {
    return this.targetEpochs.get(targetId) ?? 0
  }

  /**
   * 递增代际 Fencing 计数器 (Bump Epoch)
   * 原子使旧协程提交与在途排空事务立即失效
   */
  bumpEpoch(targetId: string): number {
    const next = (this.targetEpochs.get(targetId) ?? 0) + 1
    this.targetEpochs.set(targetId, next)
    return next
  }

  /**
   * 目标是否正处于模型换型持有中 (Ticket 08: 引用计数持有 + 属主判定)
   */
  isSwapInProgress(targetId: string): boolean {
    return (
      (this.swapHoldCount.get(targetId) ?? 0) > 0 ||
      this.swappingTargets.has(targetId) ||
      this.activeLifecycleOwner.get(targetId)?.operation === 'model_swap'
    )
  }

  /**
   * 换型前置标记持有 (holdSwap)
   * 在进入互斥锁之前同步执行，清算阶段 2 等待分桶，阻止新请求进入
   */
  holdSwap(targetId: string): void {
    this.bumpEpoch(targetId) // 换型登记前严格推进代际，使在此之前发起的收割回写立即失效
    const cur = this.swapHoldCount.get(targetId) ?? 0
    this.swapHoldCount.set(targetId, cur + 1)
    this.swappingTargets.add(targetId)
  }

  /**
   * 释放换型持有 (releaseSwapHold)
   * 引用计数归零前绝不提前移除标记
   */
  releaseSwapHold(targetId: string): void {
    const cur = this.swapHoldCount.get(targetId) ?? 0
    if (cur <= 1) {
      this.swapHoldCount.delete(targetId)
      this.swappingTargets.delete(targetId)
    } else {
      this.swapHoldCount.set(targetId, cur - 1)
    }
  }

  /** 推进模型代次 (Ticket 08) */
  bumpModelGeneration(targetId: string): number {
    const current = this.runtimeStore.get(targetId)?.modelGeneration ?? 1
    const next = current + 1
    this.runtimeStore.update(targetId, d => {
      d.modelGeneration = next
    })
    return next
  }

  /** 回滚模型代次 (Ticket 08) */
  restoreModelGeneration(
    targetId: string,
    initiatorToken: LifecycleToken,
    expectedGeneration: number,
    previousGeneration: number
  ): boolean {
    const currentOwner = this.activeLifecycleOwner.get(targetId)
    if (
      initiatorToken.tokenId !== 'rollback_stub' &&
      (!currentOwner || currentOwner.tokenId !== initiatorToken.tokenId)
    ) {
      logger.warn(
        LogCategory.SYSTEM,
        `[Coordinator] restoreModelGeneration 属主冲突拒绝: targetId=${targetId}`
      )
      return false
    }
    return this.runtimeStore.update(targetId, d => {
      if (d.modelGeneration === expectedGeneration) {
        d.modelGeneration = previousGeneration
      }
    })
  }

  /** 获取指定目标当前活跃属主 Token */
  getActiveOwner(targetId: string): LifecycleToken | undefined {
    return this.activeLifecycleOwner.get(targetId)
  }

  /**
   * 申请进入生命周期操作事务 (beginLifecycleOperation)
   * 严格状态机前置守卫与 Fencing 抢占机制
   */
  beginLifecycleOperation(
    targetId: string,
    operation: LifecycleOperation
  ): LifecycleToken | undefined {
    const rt = this.runtimeStore.get(targetId)
    if (!rt) {
      logger.warn(LogCategory.SYSTEM, `[Coordinator] 目标未在纳管字典中: ${targetId}`)
      return undefined
    }

    // 1. idle_hibernation 守卫：必须为 resident、无在途租约、无换型事务
    if (operation === 'idle_hibernation') {
      const activeLeases = this.leaseRegistryInstance
        ? this.leaseRegistryInstance.countActiveByTarget(targetId)
        : undefined
      if (activeLeases === undefined) {
        logger.warn(LogCategory.SYSTEM, `[Coordinator] 租约中心尚未就绪，拒绝空闲休眠: ${targetId}`)
        return undefined
      }
      if (rt.state !== 'resident' || activeLeases > 0 || this.isSwapInProgress(targetId)) {
        logger.warn(
          LogCategory.SYSTEM,
          `[Coordinator] 空闲休眠前置条件不满足: targetId=${targetId}, state=${rt.state}, activeLeases=${activeLeases}`
        )
        return undefined
      }
    } else if (operation === 'unload_retry') {
      // 2. unload_retry 守卫：必须为 error + unload 且无换型
      if (
        rt.state !== 'error' ||
        rt.lastFailureKind !== 'unload' ||
        this.isSwapInProgress(targetId)
      ) {
        logger.warn(
          LogCategory.SYSTEM,
          `[Coordinator] 卸载重试前置条件不满足: targetId=${targetId}, state=${rt.state}, failureKind=${rt.lastFailureKind}`
        )
        return undefined
      }
    } else if (operation === 'crash_recovery') {
      // 3. crash_recovery 守卫：覆盖 resident, loading, draining, error (含内存残留、load失败与unload对账自愈)
      const isRecoverableState =
        rt.state === 'resident' ||
        rt.state === 'loading' ||
        rt.state === 'draining' ||
        rt.state === 'error'

      if (!isRecoverableState || this.isSwapInProgress(targetId)) {
        logger.warn(
          LogCategory.SYSTEM,
          `[Coordinator] 崩溃恢复前置条件不满足: targetId=${targetId}, state=${rt.state}, isSwapInProgress=${this.isSwapInProgress(targetId)}`
        )
        return undefined
      }
    }

    // 4. 处理当前活跃所有者抢占与排他 (SSOT 单一决议出口，防代际多跳与代际毒化)
    const current = this.activeLifecycleOwner.get(targetId)
    if (current) {
      if (operation === 'model_swap' && current.operation !== 'model_swap') {
        // 换型事务拥有最高抢占优先级：原子推进代际让前任失效
        this.bumpEpoch(targetId)
      } else if (
        operation === 'crash_recovery' &&
        (current.operation === 'single_flight_load' ||
          current.operation === 'idle_hibernation' ||
          current.operation === 'unload_retry')
      ) {
        // 崩溃恢复抢占低优先级协程
        this.bumpEpoch(targetId)
      } else {
        // 其余并发冲突拒绝，返回 undefined (绝不提前 bumpEpoch 毒化合法在途协程)
        return undefined
      }
    }

    const epoch = this.currentEpoch(targetId)
    const currentGen = rt.modelGeneration
    const token: LifecycleToken = {
      tokenId: `token_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      targetId,
      epoch,
      modelGeneration: currentGen,
      operation,
      grantedAt: Date.now()
    }

    this.activeLifecycleOwner.set(targetId, token)
    return token
  }

  /**
   * 子协程生命周期所有权原子交接入口
   * 严格核验 parentToken 与 generation 吻合，随后 bumpEpoch 并生成新 Token
   */
  handoverLifecycleOwner(
    parentToken: LifecycleToken,
    nextOperation: LifecycleOperation
  ): LifecycleToken | undefined {
    const targetId = parentToken.targetId
    const currentOwner = this.activeLifecycleOwner.get(targetId)
    if (!currentOwner || currentOwner.tokenId !== parentToken.tokenId) {
      logger.warn(
        LogCategory.SYSTEM,
        `[Coordinator] Token 交接被拒：非当前合法属主: targetId=${targetId}`
      )
      return undefined
    }

    const currentRt = this.runtimeStore.get(targetId)
    if (!currentRt || parentToken.modelGeneration !== currentRt.modelGeneration) {
      logger.warn(
        LogCategory.SYSTEM,
        `[Coordinator] Token 交接被拒：模型代次不匹配: targetId=${targetId}`
      )
      return undefined
    }

    const newEpoch = this.bumpEpoch(targetId)
    const nextToken: LifecycleToken = {
      tokenId: `token_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      targetId,
      epoch: newEpoch,
      modelGeneration: currentRt.modelGeneration,
      operation: nextOperation,
      grantedAt: Date.now()
    }

    this.activeLifecycleOwner.set(targetId, nextToken)
    return nextToken
  }

  /**
   * 提交运行时快照变更 (commitRuntimeSnapshot)
   * 严格核验 Token 所有者、Epoch 代际与 ModelGeneration，确保非法/陈旧协程无法污染数据
   */
  commitRuntimeSnapshot(
    token: LifecycleToken,
    apply: (draft: ModuleRuntimeState) => void
  ): boolean {
    const { targetId, epoch, tokenId, modelGeneration } = token
    const currentOwner = this.activeLifecycleOwner.get(targetId)

    if (!currentOwner || currentOwner.tokenId !== tokenId) {
      logger.warn(
        LogCategory.SYSTEM,
        `[Coordinator] 提交被拒：Token 已非在册合法所有者: targetId=${targetId}, token=${tokenId}`
      )
      return false
    }

    if (this.currentEpoch(targetId) !== epoch) {
      logger.warn(
        LogCategory.SYSTEM,
        `[Coordinator] 提交被拒：Epoch 代际已漂移: targetId=${targetId}, tokenEpoch=${epoch}, currentEpoch=${this.currentEpoch(targetId)}`
      )
      return false
    }

    const current = this.runtimeStore.get(targetId)
    if (!current || current.modelGeneration !== modelGeneration) {
      logger.warn(
        LogCategory.SYSTEM,
        `[Coordinator] 提交被拒：ModelGeneration 代次漂移: targetId=${targetId}`
      )
      return false
    }

    const updated = this.runtimeStore.update(targetId, apply)
    if (updated) {
      this.triggerSnapshotBroadcast()
    }
    return updated
  }

  /**
   * 按代际提交运行时快照变更 (commitIfEpoch)
   * 仅当当前代际与采样代际一致时写入并触发广播
   */
  commitIfEpoch(
    targetId: string,
    epoch: number,
    apply: (draft: ModuleRuntimeState) => void
  ): boolean {
    if (this.currentEpoch(targetId) !== epoch) {
      return false
    }
    const updated = this.runtimeStore.update(targetId, apply)
    if (updated) {
      this.triggerSnapshotBroadcast()
    }
    return updated
  }

  /**
   * 结束生命周期事务清理
   * 仅当在册所有者仍然严格为 token.tokenId 时才执行删除，杜绝让权方误删新 owner
   */
  endLifecycleOperation(token?: LifecycleToken): void {
    if (!token) return
    const current = this.activeLifecycleOwner.get(token.targetId)
    if (current && current.tokenId === token.tokenId) {
      this.activeLifecycleOwner.delete(token.targetId)
    }
  }

  // ==========================================
  // 在途物理操作管理 (InFlightPhysicalOp)
  // ==========================================

  registerInFlightOp(op: InFlightPhysicalOp): void {
    this.activeInFlightOps.set(op.opId, op)
  }

  getInFlightOp(opId: string): InFlightPhysicalOp | undefined {
    return this.activeInFlightOps.get(opId)
  }

  finalizeOpAsSettled(op: InFlightPhysicalOp): void {
    op.status = 'settled'
    try {
      op.resolveCompletion?.()
    } catch {}
    this.activeInFlightOps.delete(op.opId)
  }

  finalizeOpAsFailedUnknown(op: InFlightPhysicalOp): void {
    op.status = 'failed_unknown'
    try {
      op.resolveCompletion?.()
    } catch {}
    this.activeInFlightOps.delete(op.opId)
  }

  // ==========================================
  // 门闩状态与持久化闭环 (SSOT SQLite First)
  // ==========================================

  /**
   * 持久化门闩标记至 SQLite (SSOT)
   * 必须在更新内存缓存前调用
   */
  async persistBlockedUnloadGate(
    targetId: string,
    blocked: 0 | 1,
    identity: ProcessTreeIdentity | null
  ): Promise<void> {
    if (typeof this.runtimeStore.persistBlockedUnloadGate === 'function') {
      await this.runtimeStore.persistBlockedUnloadGate(targetId, blocked, identity)
      return
    }
    const success = this.runtimeStore.update(targetId, draft => {
      draft.blockedUnloadNoHandle = blocked
      draft.blockedUnloadIdentity = identity
    })
    if (!success) {
      throw new Error(`Failed to persist blocked unload gate for ${targetId}`)
    }
  }

  updateBlockedUnloadCache(targetId: string, blocked: boolean): void {
    this.blockedUnloadCache.set(targetId, blocked)
  }

  isBlockedUnload(targetId: string): boolean {
    if (this.blockedUnloadCache.has(targetId)) {
      return this.blockedUnloadCache.get(targetId) === true
    }
    const rt = this.runtimeStore.get(targetId)
    const isBlocked = rt?.blockedUnloadNoHandle === 1
    this.blockedUnloadCache.set(targetId, isBlocked)
    return isBlocked
  }

  dispatchRuntimeError(
    targetId: string,
    phase: 'load' | 'unload',
    message: string,
    i18nKey?: string
  ): void {
    this.runtimeStore.update(targetId, draft => {
      draft.state = 'error'
      draft.errorPhase = phase
      draft.lastFailureKind = phase
      draft.errorMessage = message
      if (i18nKey) {
        draft.lastErrorI18nKey = i18nKey
      }
    })
  }

  // ==========================================
  // 抑制条目与取消意图登记
  // ==========================================

  suppressStoppingIdentity(entry: SuppressedStoppingIdentityEntry): void {
    const key = this.getIdentityKey(entry.identity)
    this.globalSuppressedStoppingIdentities.set(key, entry)
  }

  getSuppressedStoppingIdentity(key: string): SuppressedStoppingIdentityEntry | undefined {
    return this.globalSuppressedStoppingIdentities.get(key)
  }

  hasSuppressedStoppingIdentity(key: string): boolean {
    return this.globalSuppressedStoppingIdentities.has(key)
  }

  registerCancelIntent(targetId: string): void {
    this.targetCancelIntent.set(targetId, {
      targetId,
      registeredAt: Date.now()
    })
  }

  hasCancelIntent(targetId: string): boolean {
    return this.targetCancelIntent.has(targetId)
  }

  setSwapCancelContext(targetId: string, active: boolean): void {
    if (active) {
      if (!this.swapCancelContexts.has(targetId)) {
        this.swapCancelContexts.set(targetId, {
          targetId,
          swapTokenId: 'manual_swap_context',
          abortController: new AbortController(),
          cancelRequested: false,
          inFlightOps: new Map(),
          rollbackSnapshot: {
            generation: this.runtimeStore.get(targetId)?.modelGeneration ?? 1,
            residentBytes: this.runtimeStore.get(targetId)?.residentBytes ?? 0
          }
        })
      }
    } else {
      this.swapCancelContexts.delete(targetId)
    }
  }

  hasSwapCancelContext(targetId: string): boolean {
    return this.swapCancelContexts.has(targetId)
  }

  setStoppingIdentity(targetId: string, identityKeyOrActive?: string | boolean): void {
    if (typeof identityKeyOrActive === 'string') {
      this.targetStoppingIdentity.set(targetId, identityKeyOrActive)
    } else if (identityKeyOrActive === true) {
      this.targetStoppingIdentity.set(targetId, 'active')
    } else {
      this.targetStoppingIdentity.delete(targetId)
    }
  }

  hasStoppingIdentity(targetId: string): boolean {
    return this.targetStoppingIdentity.has(targetId)
  }

  getStoppingIdentityKey(targetId: string): string | undefined {
    return this.targetStoppingIdentity.get(targetId)
  }

  setPendingSwapDraining(targetId: string, active: boolean): void {
    if (active) {
      this.pendingSwapDraining.add(targetId)
    } else {
      this.pendingSwapDraining.delete(targetId)
    }
  }

  isPendingSwapDraining(targetId: string): boolean {
    return this.pendingSwapDraining.has(targetId)
  }

  isOwnerStale(targetId: string): boolean {
    const owner = this.activeLifecycleOwner.get(targetId)
    if (!owner) return true
    return Date.now() - owner.grantedAt >= LIFECYCLE_OWNER_MAX_TTL_MS
  }

  // ==========================================
  // 崩溃滑动窗口与断路器 (CRASH_LOOP)
  // ==========================================

  /**
   * 统一原子自增崩溃计数并执行熔断判定
   * 涵盖：加载失败、停机失败、看门狗超时、自愈失败
   */
  incrementCrashStreak(
    targetId: string,
    failureKind: 'load' | 'unload' = 'load',
    error?: { code?: string },
    currentGeneration?: number
  ): number {
    const now = Date.now()
    const rt = this.runtimeStore.get(targetId)
    if (!rt) return 0

    // 1. 稳定驻留拉式单调重置铁律 (ISS-06 / ISS-07)
    const residentSince = this.residentSinceMap.get(targetId)
    if (
      rt.state === 'resident' &&
      residentSince !== undefined &&
      now - residentSince >= STABLE_RESIDENT_RESET_MS
    ) {
      this.runtimeStore.update(targetId, draft => {
        draft.crashStreak = 0
      })
    }

    // 2. 错误码为 SERVICE_UNAVAILABLE 时，严禁计入 crashStreak，杜绝基础设施抖动误熔断
    if (error?.code === 'SERVICE_UNAVAILABLE') {
      return this.runtimeStore.get(targetId)?.crashStreak ?? 0
    }

    // 3. 5 分钟滑动窗口核验
    const lastCrashAt = this.lastCrashAtMap.get(targetId) ?? 0
    let nextStreak = (rt.crashStreak ?? 0) + 1
    if (lastCrashAt > 0 && now - lastCrashAt > CRASH_WINDOW_MS) {
      nextStreak = 1
    }

    this.lastCrashAtMap.set(targetId, now)
    const gen = currentGeneration ?? rt.modelGeneration

    // 4. 原子更新到 Store 并标记崩溃代次
    this.runtimeStore.update(targetId, draft => {
      draft.crashStreak = nextStreak
      draft.lastFailureKind = failureKind
      draft.errorPhase = failureKind
      // 连续崩溃达阈值（>=2 次）且为 load 失败，触发断路器熔断
      if (nextStreak >= CRASH_BREAKER_THRESHOLD && failureKind === 'load') {
        draft.state = 'error'
        draft.errorMessage = 'CRASH_LOOP'
        draft.lastErrorI18nKey = 'CRASH_LOOP'
      }
    })

    logger.warn(
      LogCategory.SYSTEM,
      `[Coordinator] incrementCrashStreak: targetId=${targetId}, streak=${nextStreak}, gen=${gen}, failureKind=${failureKind}`
    )
    return nextStreak
  }

  /**
   * 模块加载成功时严格清零 crashStreak 并记录驻留时间戳
   */
  recordLoadSuccess(targetId: string): void {
    const now = Date.now()
    this.residentSinceMap.set(targetId, now)
    this.runtimeStore.update(targetId, draft => {
      draft.crashStreak = 0
      draft.lastErrorI18nKey = undefined
      draft.errorMessage = undefined
      draft.errorPhase = undefined
      draft.lastFailureKind = undefined
    })
  }

  /**
   * 是否处于 CRASH_LOOP 熔断保护态
   */
  isCrashLoopBlocked(targetId: string): boolean {
    const rt = this.runtimeStore.get(targetId)
    if (!rt) return false
    const now = Date.now()
    const lastCrashAt = this.lastCrashAtMap.get(targetId) ?? 0
    return (
      rt.crashStreak >= CRASH_BREAKER_THRESHOLD &&
      now - lastCrashAt <= CRASH_WINDOW_MS &&
      rt.lastFailureKind !== 'unload'
    )
  }

  // ==========================================
  // 看门狗活性收割 (reapStaleLifecycleOwners)
  // ==========================================

  /**
   * 协调器多维生命体征看门狗
   * 区分“进度停滞(60s)”与“无进度硬超时(120s+60s缓冲，总上限180s)”，实施 180s 异步有界收敛与双轨决议
   */
  reapStaleLifecycleOwners(): Promise<void[]> {
    const now = Date.now()
    const convergencePromises: Promise<void>[] = []

    // 步骤 1：扫描并收割挂起停滞无进展或超硬超时的在途 op（ISS-01 / ISS-02 / ISS-03 / ISS-04 / ISS-05 / ISS-10）
    for (const [opId, op] of Array.from(this.activeInFlightOps.entries())) {
      if (op.status === 'running' || op.spawnState === 'spawning') {
        const isProgressSupported = op.supportsProgress
        const stallElapsed = now - (op.lastProgressAt ?? op.createdAt)
        const totalElapsed = now - op.createdAt
        const isStalled = isProgressSupported && stallElapsed >= IN_FLIGHT_OP_STALL_TIMEOUT_MS

        // ISS-03: 无进度算子硬超时缓冲机制（基础 120s，低配/超大模型允许 1 次 60s 缓冲延展，总上界 180s）
        const maxHardTimeout = op.extendedTimeoutGranted
          ? 180_000
          : IN_FLIGHT_OP_NO_PROGRESS_HARD_TIMEOUT_MS
        const isHardTimeout = !isProgressSupported && totalElapsed >= maxHardTimeout

        if (
          !isProgressSupported &&
          totalElapsed >= IN_FLIGHT_OP_NO_PROGRESS_HARD_TIMEOUT_MS &&
          !op.extendedTimeoutGranted
        ) {
          // 达到 120s 时不盲杀，派发加载缓慢提示并自动延展一次 60s 缓冲
          op.extendedTimeoutGranted = true
          logger.warn(
            LogCategory.SYSTEM,
            `[Coordinator] 在途操作缓慢，授予 60s 延展宽限: targetId=${op.targetId}, opId=${opId}, totalElapsed=${totalElapsed}`
          )
          continue
        }

        if (isStalled || isHardTimeout) {
          logger.error(
            LogCategory.SYSTEM,
            `[Coordinator] 在途物理操作超时触发看门狗强杀: targetId=${op.targetId}, opId=${opId}, gen=${op.generation}, isHardTimeout=${isHardTimeout}, totalElapsed=${totalElapsed}`
          )

          op.abortController?.abort()
          // 立即同步置位标记为收割中，消除重入竞态并不再阻碍步骤 2 孤儿属主回收
          op.status = 'failed_unknown'
          const convergenceTask = (async () => {
            let isConfirmedExited = false
            try {
              if (this.engineBridgeServiceInstance) {
                const killRes = await this.engineBridgeServiceInstance.forceKillOldGeneration(
                  op.targetId,
                  op.generation,
                  op.jobHandle
                )
                if (killRes === 'killed') {
                  isConfirmedExited = true
                } else if (killRes === 'no_handle') {
                  await this.persistBlockedUnloadGate(op.targetId, 1, op.identity ?? null)
                  this.updateBlockedUnloadCache(op.targetId, true)
                  this.dispatchRuntimeError(
                    op.targetId,
                    'unload',
                    '180s 硬超时句柄丢失，已启用持久安全保护'
                  )
                } else if (op.identity) {
                  const exitRes = await this.engineBridgeServiceInstance
                    .awaitProcessTreeExit(op.identity, 3_000)
                    .catch(() => 'unknown' as const)
                  if (exitRes === 'exited') {
                    isConfirmedExited = true
                  } else {
                    await this.persistBlockedUnloadGate(op.targetId, 1, op.identity)
                    this.updateBlockedUnloadCache(op.targetId, true)
                    this.dispatchRuntimeError(
                      op.targetId,
                      'unload',
                      '180s 硬超时强杀后 3 秒内未确认退出，已升级为持久门闩保护'
                    )
                  }
                } else {
                  isConfirmedExited = true
                }
              } else {
                isConfirmedExited = true
              }
            } catch {
              try {
                await this.persistBlockedUnloadGate(op.targetId, 1, op.identity ?? null)
                this.updateBlockedUnloadCache(op.targetId, true)
              } catch {}
            } finally {
              if (isConfirmedExited) {
                const token = this.beginLifecycleOperation(op.targetId, 'crash_recovery')
                if (token) {
                  try {
                    this.commitRuntimeSnapshot(token, draft => {
                      draft.state = 'hibernated'
                      draft.residentBytes = 0
                      draft.residentSample = undefined
                      draft.errorPhase = undefined
                      draft.errorMessage = undefined
                    })
                  } finally {
                    this.endLifecycleOperation(token)
                  }
                }
                this.finalizeOpAsSettled(op)
              } else {
                this.finalizeOpAsFailedUnknown(op)
              }
            }
          })()
          convergencePromises.push(convergenceTask)
        }
      }
    }

    // 步骤 2：扫描并回收超时孤儿属主（ISS-03 破除死锁）
    for (const [targetId, owner] of Array.from(this.activeLifecycleOwner.entries())) {
      const elapsed = now - owner.grantedAt
      if (elapsed < LIFECYCLE_OWNER_MAX_TTL_MS) continue

      const hasActiveInFlightOps = Array.from(this.activeInFlightOps.values()).some(
        op => op.targetId === targetId && (op.status === 'running' || op.spawnState === 'spawning')
      )
      const hasCancelCtx = this.swapCancelContexts.has(targetId)
      const hasStopping = this.targetStoppingIdentity.has(targetId)
      const isPendingSwap = this.pendingSwapDraining.has(targetId)

      if (!hasActiveInFlightOps && !hasCancelCtx && !hasStopping && !isPendingSwap) {
        logger.error(
          LogCategory.SYSTEM,
          `[Coordinator] 超时孤儿属主已被看门狗收割: targetId=${targetId}, tokenId=${owner.tokenId}, elapsed=${elapsed}`
        )
        this.activeLifecycleOwner.delete(targetId)
        this.bumpEpoch(targetId)
      }
    }

    return Promise.all(convergencePromises)
  }

  // ==========================================
  // 抑制条目物理对账器 (reconcileSuppressedIdentities)
  // ==========================================

  /**
   * 抑制条目物理对账器 (对称闭环与 SQLite 先行 SSOT)
   */
  async reconcileSuppressedIdentities(): Promise<void> {
    const now = Date.now()
    for (const [key, entry] of Array.from(this.globalSuppressedStoppingIdentities.entries())) {
      try {
        const isExited = this.engineBridgeServiceInstance
          ? this.engineBridgeServiceInstance.isProcessTreeExited(entry.identity)
          : true

        if (isExited === true) {
          // ISS-02 (v6.10): 严格 SQLite 先行 SSOT 闭环：必须先 SQLite 清除持久门闩成功，再清除内存缓存与抑制条目！
          try {
            await this.persistBlockedUnloadGate(entry.targetId, 0, null)
            // SQLite 成功，同步微任务清除内存缓存与抑制条目
            this.updateBlockedUnloadCache(entry.targetId, false)
            this.globalSuppressedStoppingIdentities.delete(key)

            // 恢复 hibernated 状态
            const token = this.beginLifecycleOperation(entry.targetId, 'crash_recovery')
            if (token) {
              try {
                this.commitRuntimeSnapshot(token, draft => {
                  if (draft.state === 'error' && draft.errorPhase === 'unload') {
                    draft.state = 'hibernated'
                    draft.residentBytes = 0
                    draft.residentSample = undefined
                    draft.errorPhase = undefined
                    draft.errorMessage = undefined
                  }
                })
              } finally {
                this.endLifecycleOperation(token)
              }
            }
          } catch (err) {
            // 若 SQLite 清除持久标记失败（磁盘满/事务锁冲突）：
            // 坚决不得清除内存缓存！保留抑制条目，门闩保持阻断，记录警告等待下次对账重试！
            logger.error(
              LogCategory.SYSTEM,
              `[Coordinator] 清除持久门闩失败，保留抑制条目等待下次对账: targetId=${entry.targetId}, key=${key}`,
              err
            )
          }
        } else {
          // 进程仍存活或探针返回 unknown
          entry.unknownRetryCount = (entry.unknownRetryCount ?? 0) + 1
          entry.lastRetryAt = now
          const totalElapsed = now - entry.suppressedAt

          // ISS-03 (v6.10): 10 次 / 30s 升阶状态机落地（必须先 SQLite 成功，再同步内存缓存，ISS-02）
          if (
            (entry.unknownRetryCount >= 10 || totalElapsed >= 30_000) &&
            !entry.escalatedToPersistentLock
          ) {
            entry.escalatedToPersistentLock = true
            logger.warn(
              LogCategory.SYSTEM,
              `[Coordinator] 抑制条目多次重试未退出，升级为持久安全保护: targetId=${entry.targetId}, retries=${entry.unknownRetryCount}`
            )
            try {
              await this.persistBlockedUnloadGate(entry.targetId, 1, entry.identity)
              this.updateBlockedUnloadCache(entry.targetId, true)
              this.dispatchRuntimeError(
                entry.targetId,
                'unload',
                '底层进程在多次重试后仍未确认退出，已升级为持久安全保护，请尝试强制重置或重启电脑'
              )
            } catch {
              this.dispatchRuntimeError(
                entry.targetId,
                'unload',
                '状态持久化异常，已启用保守门闩保护'
              )
            }
          }

          // 后台主动重试终止旧进程
          if (this.engineBridgeServiceInstance) {
            this.engineBridgeServiceInstance.stopProcessTree(entry.identity).catch(() => {})
            this.engineBridgeServiceInstance
              .forceKillOldGeneration(
                entry.targetId,
                entry.identity.generation,
                entry.identity.treeHandle
              )
              .catch(() => {})
          }
        }
      } catch {
        // 探测异常或权限受限时坚决保留抑制条目，宁可多抑制绝不漏抑制 (ISS-10)
      }
    }

    // 兜底清理持久取消意图 (ISS-04)
    for (const [targetId, entry] of Array.from(this.targetCancelIntent.entries())) {
      const elapsed = now - entry.registeredAt
      const owner = this.activeLifecycleOwner.get(targetId)
      const isModelSwapOwner = owner?.operation === 'model_swap'
      const isOwnerStale = !owner || this.isOwnerStale(targetId)
      const hasContext = this.swapCancelContexts.has(targetId)
      const hasStopping = this.targetStoppingIdentity.has(targetId)
      const normalCleanable =
        elapsed >= CANCEL_INTENT_MIN_TTL_MS && !isModelSwapOwner && !hasContext && !hasStopping
      const hardTimeoutCleanable =
        elapsed >= CANCEL_INTENT_HARD_TTL_MS && isOwnerStale && !hasContext && !hasStopping
      if (normalCleanable || hardTimeoutCleanable) {
        this.targetCancelIntent.delete(targetId)
      }
    }
  }

  // ==========================================
  // 有界停机原语与取消加载 (Ticket 06)
  // ==========================================

  /** 获取指定目标的停机串行排队互斥锁 */
  getTargetStoppingMutex(targetId: string): AsyncMutex {
    let mutex = this.targetStoppingMutex.get(targetId)
    if (!mutex) {
      mutex = new AsyncMutex()
      this.targetStoppingMutex.set(targetId, mutex)
    }
    return mutex
  }

  /** 获取进程树唯一身份标识符键名 */
  getIdentityKey(identity: ProcessTreeIdentity): string {
    return `${identity.pid}_${identity.startTimeMs}`
  }

  /**
   * 有界停机原语 (stopServiceBounded)
   * 遵循 L3 规格书 §2.1 / §2.2
   * 1. per-target 串行化排队；
   * 2. 旧 identity 串行等待与 failed_unknown 阻断；
   * 3. 取消意图与取消上下文自动继承全局抑制；
   * 4. 同 identity 重试执行同步物理探针即刻自愈；
   * 5. 唯一维护与决议 resultPromise；
   * 6. 15s 硬超时立即 resolve(failed_unknown) 并移出互斥锁，启动后台轻量对账。
   */
  async stopServiceBounded(
    targetId: string,
    expectedIdentity: ProcessTreeIdentity
  ): Promise<StopServiceResult> {
    const identityKey = this.getIdentityKey(expectedIdentity)

    // P3-6: 在获取互斥锁之前，若已有同 identity 且处于 running 的在途停机，直接复用其 Promise
    const runningEntry = this.activeStoppingTasksByIdentity.get(identityKey)
    if (runningEntry && runningEntry.status === 'running') {
      logger.info(
        LogCategory.SYSTEM,
        `[Coordinator] 并发复用在途停机任务 Promise: targetId=${targetId}, key=${identityKey}`
      )
      return runningEntry.resultPromise
    }

    const mutex = this.getTargetStoppingMutex(targetId)
    return mutex.runExclusive(async () => {
      // ISS-06: 严格检查并等待旧 identity 退出，若旧任务处于 failed_unknown 坚决阻断新停机
      const oldIdentityKey = this.targetStoppingIdentity.get(targetId)
      if (oldIdentityKey && oldIdentityKey !== identityKey) {
        const oldEntry = this.activeStoppingTasksByIdentity.get(oldIdentityKey)
        if (oldEntry && oldEntry.status !== 'stopped_confirmed') {
          logger.warn(
            LogCategory.SYSTEM,
            `[Coordinator] 检测到旧代次进程正在停机，串行等待退出: targetId=${targetId}, oldKey=${oldIdentityKey}, newKey=${identityKey}`
          )
          const prevRes = await oldEntry.resultPromise
          if (prevRes.status !== 'stopped_confirmed') {
            return {
              status: 'failed_unknown',
              reason: 'previous_identity_failed_to_exit'
            }
          }
        }
      }

      // ISS-04 / ISS-05: 若当前 target 处于持久取消意图集合或活跃取消上下文，新建停机任务自动继承全局抑制
      if (this.targetCancelIntent.has(targetId) || this.swapCancelContexts.has(targetId)) {
        this.globalSuppressedStoppingIdentities.set(identityKey, {
          targetId,
          identity: expectedIdentity,
          suppressedAt: Date.now()
        })
      }

      // ISS-08 (P1-2): 检查当前同 identity 任务；若处于 failed_unknown，先执行同步探针自愈！
      const existing = this.activeStoppingTasksByIdentity.get(identityKey)
      if (existing) {
        if (existing.status === 'failed_unknown') {
          const isExited = this.engineBridgeServiceInstance
            ? this.engineBridgeServiceInstance.isProcessTreeExited(expectedIdentity)
            : true
          if (isExited === true) {
            logger.info(
              LogCategory.SYSTEM,
              `[Coordinator] 同 identity 重试探针确证已退出，即刻自愈: targetId=${targetId}, key=${identityKey}`
            )
            existing.status = 'stopped_confirmed'
            this.activeStoppingTasksByIdentity.delete(identityKey)
            if (this.targetStoppingIdentity.get(targetId) === identityKey) {
              this.targetStoppingIdentity.delete(targetId)
            }
            return { status: 'stopped_confirmed' }
          }
          // P1-2: 探针未确证退出（进程仍存活），坚决不可返回陈旧的 failed_unknown Promise！
          // 移除旧条目，允许重新发起下层停机指令与超时监控
          logger.warn(
            LogCategory.SYSTEM,
            `[Coordinator] 同 identity 重试时探针显示仍未退出，重置旧状态并重新发起停机: targetId=${targetId}, key=${identityKey}`
          )
          this.activeStoppingTasksByIdentity.delete(identityKey)
        } else if (existing.status === 'running') {
          return existing.resultPromise
        }
      }

      let resolveResultFn!: (res: StopServiceResult) => void
      const resultPromise = new Promise<StopServiceResult>(resolve => {
        resolveResultFn = resolve
      })

      let isResolved = false
      let pollTimer: ReturnType<typeof setInterval> | undefined
      let hardTimeoutTimer: ReturnType<typeof setTimeout> | undefined
      let unsubscribeExit: (() => void) | undefined
      let backgroundReconcileTimer: ReturnType<typeof setInterval> | undefined

      const cleanupTimersAndListeners = () => {
        this.stoppingCleanups.delete(cleanupTimersAndListeners)
        if (unsubscribeExit) {
          unsubscribeExit()
          unsubscribeExit = undefined
        }
        if (pollTimer) {
          clearInterval(pollTimer)
          pollTimer = undefined
        }
        if (hardTimeoutTimer) {
          clearTimeout(hardTimeoutTimer)
          hardTimeoutTimer = undefined
        }
        if (backgroundReconcileTimer) {
          clearInterval(backgroundReconcileTimer)
          backgroundReconcileTimer = undefined
        }
      }
      this.stoppingCleanups.add(cleanupTimersAndListeners)

      const onExitConfirmed = () => {
        const isSuppressed =
          this.globalSuppressedStoppingIdentities.has(identityKey) ||
          this.targetCancelIntent.has(targetId) ||
          this.swapCancelContexts.get(targetId)?.cancelRequested === true ||
          this.activeStoppingTasksByIdentity.get(identityKey)?.submissionSuppressed === true

        // ISS-01 / ISS-03 / ISS-09: 退出回调分级处理机制：处于抑制集合的条目严格零写 Store
        if (isSuppressed) {
          logger.info(
            LogCategory.SYSTEM,
            `[Coordinator] 停机确证退出命中全局抑制，零写 Store 并清理内部条目: targetId=${targetId}, key=${identityKey}`
          )
          cleanupTimersAndListeners()
          this.activeStoppingTasksByIdentity.delete(identityKey)
          if (this.targetStoppingIdentity.get(targetId) === identityKey) {
            this.targetStoppingIdentity.delete(targetId)
          }
          this.globalSuppressedStoppingIdentities.delete(identityKey)
          if (!isResolved) {
            isResolved = true
            resolveResultFn({ status: 'stopped_confirmed' })
          }
          return
        }

        const entry = this.activeStoppingTasksByIdentity.get(identityKey)
        if (!entry) {
          cleanupTimersAndListeners()
          // P1-1: 必须决议 Promise 防止 Mutex 死锁
          if (!isResolved) {
            isResolved = true
            resolveResultFn({ status: 'stopped_confirmed' })
          }
          return
        }

        // 状态提交前校验 target 当前在册 owner；非当前在册属主严禁写 Store
        const currentOwner = this.activeLifecycleOwner.get(targetId)
        if (entry.associatedTokenId && currentOwner?.tokenId !== entry.associatedTokenId) {
          logger.warn(
            LogCategory.SYSTEM,
            `[Coordinator] 退出回调属主不匹配，阻止非法提交: targetId=${targetId}, expected=${entry.associatedTokenId}, current=${currentOwner?.tokenId}`
          )
          cleanupTimersAndListeners()
          this.activeStoppingTasksByIdentity.delete(identityKey)
          if (this.targetStoppingIdentity.get(targetId) === identityKey) {
            this.targetStoppingIdentity.delete(targetId)
          }
          // P1-1: 必须明确决议 resultPromise，确保释放排队锁
          if (!isResolved) {
            isResolved = true
            resolveResultFn({
              status: 'failed_unknown',
              reason: 'owner_token_mismatch'
            })
          }
          return
        }

        if (isResolved) {
          // 若已硬超时决议为 failed_unknown，由后台对账收敛清理
          entry.status = 'stopped_confirmed'
          this.activeStoppingTasksByIdentity.delete(identityKey)
          if (this.targetStoppingIdentity.get(targetId) === identityKey) {
            this.targetStoppingIdentity.delete(targetId)
          }
          cleanupTimersAndListeners()
          logger.info(
            LogCategory.SYSTEM,
            `[Coordinator] 硬超时后后台对账确认退出收敛: targetId=${targetId}, key=${identityKey}`
          )
          return
        }

        isResolved = true
        cleanupTimersAndListeners()
        entry.status = 'stopped_confirmed'
        this.activeStoppingTasksByIdentity.delete(identityKey)
        if (this.targetStoppingIdentity.get(targetId) === identityKey) {
          this.targetStoppingIdentity.delete(targetId)
        }
        resolveResultFn({ status: 'stopped_confirmed' })
      }

      const entry: StoppingTaskEntry = {
        identity: expectedIdentity,
        status: 'running',
        resultPromise,
        resolveResult: resolveResultFn
      }
      this.activeStoppingTasksByIdentity.set(identityKey, entry)
      this.targetStoppingIdentity.set(targetId, identityKey)

      // P2-4: 若未注入 engineBridgeServiceInstance，视为无可观测物理进程树，快速决议
      if (!this.engineBridgeServiceInstance) {
        onExitConfirmed()
        return resultPromise
      }

      // 挂接退出事件监听与轮询保底
      if (typeof this.engineBridgeServiceInstance.onProcessTreeExit === 'function') {
        unsubscribeExit = this.engineBridgeServiceInstance.onProcessTreeExit(
          expectedIdentity,
          onExitConfirmed
        )
      }
      if (this.engineBridgeServiceInstance.isProcessTreeExited(expectedIdentity) === true) {
        onExitConfirmed()
        return resultPromise
      }

      pollTimer = setInterval(() => {
        if (this.engineBridgeServiceInstance?.isProcessTreeExited(expectedIdentity) === true) {
          onExitConfirmed()
        }
      }, 500)
      if (pollTimer && typeof pollTimer.unref === 'function') {
        pollTimer.unref()
      }

      // 15s 硬超时处理：唯一 resolveResult(failed_unknown)，释放 mutex，启动后台轻量对账
      hardTimeoutTimer = setTimeout(() => {
        if (!isResolved) {
          isResolved = true
          cleanupTimersAndListeners()
          const ent = this.activeStoppingTasksByIdentity.get(identityKey)
          if (ent) ent.status = 'failed_unknown'
          logger.error(
            LogCategory.SYSTEM,
            `[Coordinator] 停机流程达到 15s 硬超时上限，标记 failed_unknown 并释放排队锁: targetId=${targetId}, key=${identityKey}`
          )
          resolveResultFn({
            status: 'failed_unknown',
            reason: 'process_tree_stuck_timeout'
          })

          // 后台轻量对账轮询 (每 3s 一次，最多 5 次)
          let reconcileCount = 0
          backgroundReconcileTimer = setInterval(() => {
            reconcileCount++
            if (this.engineBridgeServiceInstance?.isProcessTreeExited(expectedIdentity) === true) {
              onExitConfirmed()
            } else if (reconcileCount >= 5) {
              if (backgroundReconcileTimer) clearInterval(backgroundReconcileTimer)
              backgroundReconcileTimer = undefined
              logger.warn(
                LogCategory.SYSTEM,
                `[Coordinator] 后台轻量对账轮询结束仍未退出: targetId=${targetId}, key=${identityKey}`
              )
            }
          }, 3000)
          if (backgroundReconcileTimer && typeof backgroundReconcileTimer.unref === 'function') {
            backgroundReconcileTimer.unref()
          }
        }
      }, STOP_COMPLETION_HARD_TIMEOUT_MS)
      if (hardTimeoutTimer && typeof hardTimeoutTimer.unref === 'function') {
        hardTimeoutTimer.unref()
      }

      // 执行底层停机指令
      ;(async () => {
        let timeoutTimer: ReturnType<typeof setTimeout> | undefined
        try {
          if (this.engineBridgeServiceInstance) {
            await Promise.race([
              this.engineBridgeServiceInstance.stopProcessTree(expectedIdentity).catch(err => {
                logger.warn(
                  LogCategory.SYSTEM,
                  `[Coordinator] 底层 stopProcessTree 异常，继续探针等待: pid=${expectedIdentity.pid}`,
                  err
                )
              }),
              new Promise<void>(resolve => {
                timeoutTimer = setTimeout(resolve, STOP_SERVICE_HARD_TIMEOUT_MS)
                if (timeoutTimer && typeof timeoutTimer.unref === 'function') {
                  timeoutTimer.unref()
                }
              })
            ])
            if (this.engineBridgeServiceInstance.isProcessTreeExited(expectedIdentity) === true) {
              onExitConfirmed()
            }
          }
        } finally {
          if (timeoutTimer) clearTimeout(timeoutTimer)
        }
      })()

      return resultPromise
    })
  }

  /**
   * 取消加载缓慢在途操作 (cancelSlowLoading)
   * 支持三分支收敛：确证消亡 -> hibernated；未确证有 identity -> 抑制登记等待对账；句柄丢失 -> 升级持久门闩
   */
  async cancelSlowLoading(targetId: string): Promise<void> {
    const ops = Array.from(this.activeInFlightOps.values()).filter(
      op => op.targetId === targetId && (op.status === 'running' || op.spawnState === 'spawning')
    )
    if (ops.length === 0) {
      return
    }

    this.registerCancelIntent(targetId)

    for (const op of ops) {
      op.abortController?.abort()
      op.status = 'failed_unknown'

      let isConfirmedExited = false
      let killRes: 'killed' | 'no_handle' | 'unknown' = 'unknown'
      const treeHandle = op.jobHandle ?? op.identity?.treeHandle

      try {
        if (this.engineBridgeServiceInstance) {
          killRes = await this.engineBridgeServiceInstance.forceKillOldGeneration(
            op.targetId,
            op.generation,
            treeHandle
          )
          if (killRes === 'killed') {
            isConfirmedExited = true
          } else if (killRes === 'no_handle') {
            isConfirmedExited = false
          } else if (op.identity) {
            const exitRes = await this.engineBridgeServiceInstance
              .awaitProcessTreeExit(op.identity, 3_000)
              .catch(() => 'unknown' as const)
            if (exitRes === 'exited') {
              isConfirmedExited = true
            }
          }
        } else {
          isConfirmedExited = true
        }
      } catch {
        isConfirmedExited = false
      }

      if (isConfirmedExited) {
        // 分支 1：确证消亡，归位 hibernated 并 settled
        const token = this.beginLifecycleOperation(targetId, 'crash_recovery')
        if (token) {
          try {
            this.commitRuntimeSnapshot(token, draft => {
              draft.state = 'hibernated'
              draft.residentBytes = 0
              draft.residentSample = undefined
              draft.errorPhase = undefined
              draft.errorMessage = undefined
            })
          } finally {
            this.endLifecycleOperation(token)
          }
        }
        this.finalizeOpAsSettled(op)
      } else if (killRes === 'no_handle' || !op.identity) {
        // 分支 3：句柄丢失或 identity 缺失 (no_handle)，立即写入持久门闩并锁定（P2-3 / P3-7）
        await this.persistBlockedUnloadGate(targetId, 1, op.identity ?? null)
        this.updateBlockedUnloadCache(targetId, true)
        this.dispatchRuntimeError(targetId, 'unload', '取消加载后句柄丢失，已启用持久安全保护')
        this.finalizeOpAsFailedUnknown(op)
      } else {
        // 分支 2：未能确证但持有正常 identity，登记全局抑制，压入后台对账循环重试（≤30s 等待，>30s 自动升阶）
        this.suppressStoppingIdentity({
          targetId,
          identity: op.identity,
          suppressedAt: Date.now(),
          unknownRetryCount: 1
        })
        this.dispatchRuntimeError(targetId, 'unload', '用户取消加载，底层进程正在确认退出')
        this.finalizeOpAsFailedUnknown(op)
      }
    }
  }

  // ==========================================
  // 单飞冷启动加载协程与四态屏障 (Ticket 07)
  // ==========================================

  /**
   * 动态读取冷启动超时时长（支持配置化注入与下限 1000ms 钳制，默认 60s）
   */
  coldStartTimeoutMs(targetId?: string): number {
    const configured = this.coldStartTimeoutMsProvider
      ? this.coldStartTimeoutMsProvider(targetId)
      : COLD_START_DEFAULT_TIMEOUT_MS
    return Math.max(COLD_START_MIN_TIMEOUT_MS, configured)
  }

  /**
   * 获取当前目标的在途单飞加载信息
   */
  getInflightLoad(targetId: string): InflightLoad | undefined {
    return this.inflightLoads.get(targetId)
  }

  /**
   * 作废在途单飞加载屏障 (P2-4: 供模型换型与超时协作)
   */
  invalidateInflight(
    targetId: string,
    reason: 'MODEL_SWAPPED' | 'LOAD_TIMEOUT' | 'PREEMPTED' = 'PREEMPTED'
  ): void {
    const inflight = this.inflightLoads.get(targetId)
    if (!inflight) return
    if (inflight.watchdogTimer) {
      clearTimeout(inflight.watchdogTimer)
      inflight.watchdogTimer = undefined
    }
    inflight.abort.abort(reason)
    inflight.rejectWaiters(
      new HibernationGateAbortedError(targetId, reason, `加载已被中断: ${reason}`)
    )
    this.inflightLoads.delete(targetId)
  }

  /**
   * 携带生命周期令牌进入单飞冷启动装载 (startSingleFlightLoadWithToken)
   * 遵循 L3 规格书 §2.1 契约：
   * 1. 令牌交接 handoverLifecycleOwner，代次校验与防抢占；
   * 2. 快照预占 loading 与 reserved；
   * 3. 严格落实 spawnState 四态流转 (not_started -> spawning -> spawned -> failed)；
   * 4. 动态看门狗超时监控与主动 Abort；
   * 5. 跨代隔离原子提交终态 (resident / error)；
   * 6. 双重屏障孤儿进程树安全拔除。
   */
  async startSingleFlightLoadWithToken(
    parentToken: LifecycleToken,
    modelId?: string
  ): Promise<void> {
    const targetId = parentToken.targetId

    // ISS-01 / ISS-04: 单飞子协程经 handoverLifecycleOwner 交接所有权与校验 generation
    const loadToken = this.handoverLifecycleOwner(parentToken, 'single_flight_load')
    if (!loadToken) {
      logger.warn(
        LogCategory.SYSTEM,
        `[Coordinator] startSingleFlightLoadWithToken: 父 Token 已失效，静默让权: targetId=${targetId}, parentTokenId=${parentToken.tokenId}`
      )
      return
    }

    // 同步置 loading 并将快照状态标记为 reserved
    this.commitRuntimeSnapshot(loadToken, d => {
      d.state = 'loading'
      if (d.lastReleased) {
        d.lastReleased = { ...d.lastReleased, state: 'reserved' }
      }
    })

    const attemptId = ++this.nextAttemptId
    const abortCtrl = new AbortController()
    let rejectWaitersFn!: (err: Error) => void
    let resolveWaitersFn!: () => void
    const loadPromise = new Promise<void>((resolve, reject) => {
      resolveWaitersFn = resolve
      rejectWaitersFn = reject
    })
    // 挂载空捕获防无外部等待者时的 Unhandled Rejection
    loadPromise.catch(() => {})

    let resolveCompletionFn!: () => void
    const completionPromise = new Promise<void>(resolve => {
      resolveCompletionFn = resolve
    })

    let spawnedProcessIdentity: ProcessTreeIdentity | undefined

    // 注册物理在途加载操作（初始化 spawnState: 'not_started'）
    const now = Date.now()
    const opId = `load_${attemptId}_${now}`
    const inFlightOp: InFlightPhysicalOp = {
      opId,
      type: 'load',
      targetId,
      generation: loadToken.modelGeneration,
      jobHandle: undefined,
      abortController: abortCtrl,
      completionPromise,
      status: 'running',
      spawnState: 'not_started',
      createdAt: now,
      lastProgressAt: now,
      supportsProgress: true,
      resolveCompletionFn
    }
    this.registerInFlightOp(inFlightOp)

    const timeoutMs = this.coldStartTimeoutMs(targetId)
    const inflightLoad: InflightLoad = {
      attemptId,
      modelId,
      promise: loadPromise,
      abort: abortCtrl,
      rejectWaiters: rejectWaitersFn,
      watchdogTimer: setTimeout(() => {
        // P2-7: 严格核验在途 attemptId，防止失效定时器注入脏信号
        if (this.inflightLoads.get(targetId)?.attemptId !== attemptId) return
        logger.error(
          LogCategory.SYSTEM,
          `[Coordinator] 冷启动加载硬超时 (${timeoutMs}ms)，触发主动 Abort 熔断: targetId=${targetId}, attemptId=${attemptId}`
        )
        abortCtrl.abort('LOAD_TIMEOUT')
      }, timeoutMs)
    }
    if (inflightLoad.watchdogTimer && typeof inflightLoad.watchdogTimer.unref === 'function') {
      inflightLoad.watchdogTimer.unref()
    }
    this.inflightLoads.set(targetId, inflightLoad)

    try {
      // 步骤 1：进入实际进程拉起前显式置为 spawning，并同步刷新活性时基
      inFlightOp.spawnState = 'spawning'
      inFlightOp.lastProgressAt = Date.now()

      if (!this.engineBridgeServiceInstance?.loadModel) {
        throw new Error(`EngineBridgeService 不支持 loadModel: targetId=${targetId}`)
      }

      const createAbortError = () => {
        const reason = (abortCtrl.signal.reason as string) || 'LOAD_ABORTED'
        const message =
          reason === 'LOAD_TIMEOUT'
            ? '加载超时'
            : reason === 'MODEL_SWAPPED'
              ? '加载已被中断: MODEL_SWAPPED'
              : '加载已被取消'
        return new HibernationGateAbortedError(targetId, reason, message)
      }

      const abortPromise = new Promise<never>((_, reject) => {
        if (abortCtrl.signal.aborted) {
          reject(createAbortError())
          return
        }
        abortCtrl.signal.addEventListener(
          'abort',
          () => {
            reject(createAbortError())
          },
          { once: true }
        )
      })

      // P2-8: 对原始 loadModel 挂载后置保护，若超时或抢占后迟到返回，立即拔除游离孤儿
      const rawLoadPromise = this.engineBridgeServiceInstance.loadModel(targetId, modelId, {
        signal: abortCtrl.signal,
        onProgress: () => {
          inFlightOp.lastProgressAt = Date.now()
        }
      })
      rawLoadPromise
        .then(res => {
          if (
            abortCtrl.signal.aborted ||
            this.inflightLoads.get(targetId)?.attemptId !== attemptId
          ) {
            logger.warn(
              LogCategory.SYSTEM,
              `[Coordinator] 迟到返回的底层进程已被作废，立即拔除: targetId=${targetId}, pid=${res.identity.pid}`
            )
            this.engineBridgeServiceInstance?.stopProcessTree(res.identity).catch(() => {})
          }
        })
        .catch(() => {})

      // 步骤 2：挂载 onProgress 进度回调，持续刷新活性时基，与 abort 信号安全竞速
      const loadRes = await Promise.race([rawLoadPromise, abortPromise])

      // 步骤 3：spawn 返回瞬间同一微任务首帧同步记录 identity 并置 spawned
      spawnedProcessIdentity = loadRes.identity
      inFlightOp.identity = loadRes.identity
      inFlightOp.jobHandle = loadRes.jobHandle
      inFlightOp.spawnState = 'spawned'
      inFlightOp.lastProgressAt = Date.now()

      // 屏障一：加载返回瞬间核验 abort 状态
      if (abortCtrl.signal.aborted) {
        throw new HibernationGateAbortedError(targetId, 'LOAD_ABORTED', '加载已被取消')
      }

      // 屏障二：核验当前 Token 所有权是否已被换型抢占
      const currentOwner = this.activeLifecycleOwner.get(targetId)
      if (!currentOwner || currentOwner.tokenId !== loadToken.tokenId) {
        throw new HibernationGateAbortedError(
          targetId,
          'LOAD_PREEMPTED',
          '加载已被新生命周期操作接管'
        )
      }

      // 加载成功彻底消费快照，residentSince 与 crashStreak 跨代原子重置
      const committed = this.commitRuntimeSnapshot(loadToken, d => {
        d.state = 'resident'
        d.modelGeneration = loadToken.modelGeneration
        d.residentSince = Date.now()
        d.crashStreak = 0
        d.unloadFailStreak = 0
        d.lastCrashGeneration = undefined
        d.lastFailureKind = undefined
        d.errorPhase = undefined
        d.errorMessage = undefined
        d.lastErrorI18nKey = undefined
        d.lastReleased = undefined
        // P1-3: 实测采样出来前，初始化为元数据字典预估值，避免透视为 0
        d.residentBytes = HIBERNATABLE_TARGET_CATALOG[targetId]?.estimatedMemoryBytes ?? 0
        d.residentSample = undefined
      })

      if (!committed) {
        throw new HibernationGateAbortedError(targetId, 'LOAD_COMMIT_REJECTED', '加载结果提交被拒')
      }

      this.recordLoadSuccess(targetId)

      // P2-6: 加载成功后广播集群活动变化通知
      const clusterId = HIBERNATABLE_TARGET_CATALOG[targetId]?.clusterId
      if (clusterId) {
        this.onClusterActivityChanged(clusterId)
      }

      resolveWaitersFn()
    } catch (err: any) {
      // 若抛错且未生成物理进程，同步置 spawnState = 'failed'
      if (!spawnedProcessIdentity) {
        inFlightOp.spawnState = 'failed'
      }

      // 异常时恢复快照为 available，原子提交 error(load)，严格按代次累加 crashStreak
      this.commitRuntimeSnapshot(loadToken, d => {
        d.state = 'error'
        d.lastFailureKind = 'load'
        d.errorPhase = 'load'
        d.lastErrorI18nKey = err?.code ?? 'LOAD_FAILED'
        d.errorMessage = err?.message ?? '加载失败'
        // P1-1: 若错误码为 SERVICE_UNAVAILABLE，严禁计入 crashStreak，杜绝基础设施抖动误熔断
        if (
          err?.code !== 'SERVICE_UNAVAILABLE' &&
          d.modelGeneration === loadToken.modelGeneration
        ) {
          d.crashStreak += 1
          d.lastCrashGeneration = loadToken.modelGeneration
        }
        if (d.lastReleased) {
          d.lastReleased = { ...d.lastReleased, state: 'available' }
        }
      })

      rejectWaitersFn(err)
      throw err
    } finally {
      // P1-2: 屏障清理严格收敛至 finally 块，且加严 attemptId 校验
      if (this.inflightLoads.get(targetId)?.attemptId === attemptId) {
        if (inflightLoad.watchdogTimer) {
          clearTimeout(inflightLoad.watchdogTimer)
          inflightLoad.watchdogTimer = undefined
        }
        this.inflightLoads.delete(targetId)
      }

      // 零间隙双重屏障兜底强回收：
      // 若进程已拉起但加载未能成功提交（abort / 换型抢占 / 加载抛错），必须 await 有界整树退出物理确认 (5s)
      const currentOwner = this.activeLifecycleOwner.get(targetId)
      const ownerMismatched = !currentOwner || currentOwner.tokenId !== loadToken.tokenId
      if (
        spawnedProcessIdentity &&
        (ownerMismatched || abortCtrl.signal.aborted || inFlightOp.spawnState !== 'spawned')
      ) {
        logger.warn(
          LogCategory.SYSTEM,
          `[Coordinator] 单飞加载未完成或被抢占，回收孤儿进程树: targetId=${targetId}, pid=${spawnedProcessIdentity.pid}`
        )
        if (this.engineBridgeServiceInstance) {
          await this.engineBridgeServiceInstance
            .stopProcessTree(spawnedProcessIdentity)
            .catch(() => {})
          const exitStatus = await this.engineBridgeServiceInstance
            .awaitProcessTreeExit(spawnedProcessIdentity, 5_000)
            .catch(() => 'unknown' as const)
          if (exitStatus !== 'exited') {
            logger.error(
              LogCategory.SYSTEM,
              `[Coordinator] 孤儿进程树 5s 未能确证退出，沉淀至全局抑制条目移交对账器: targetId=${targetId}, pid=${spawnedProcessIdentity.pid}`
            )
            inFlightOp.status = 'failed_unknown'
            // P2-5: 沉淀至全局抑制条目，交由后台对账器持续强杀与对账
            this.suppressStoppingIdentity({
              targetId,
              identity: spawnedProcessIdentity,
              suppressedAt: Date.now(),
              unknownRetryCount: 1
            })
          } else {
            inFlightOp.status = 'stopped_confirmed'
          }
        } else {
          inFlightOp.status = 'stopped_confirmed'
        }
      } else {
        inFlightOp.status = 'settled'
      }

      resolveCompletionFn()
      this.activeInFlightOps.delete(opId)
      this.endLifecycleOperation(loadToken)
    }
  }

  /**
   * 按需单飞冷启动对外入口 (SingleFlightBarrier 统一屏障)
   * 同 target 的并发加载请求统一复用单一 Inflight Promise，杜绝重复调用底层引擎接口
   */
  async startSingleFlightLoad(targetId: string, modelId?: string): Promise<void> {
    // 1. 若当前目标已有在途单飞加载，直接复用其 Promise
    const existing = this.inflightLoads.get(targetId)
    if (existing) {
      logger.info(
        LogCategory.SYSTEM,
        `[Coordinator] 复用在途单飞加载 Promise: targetId=${targetId}, attemptId=${existing.attemptId}`
      )
      return existing.promise
    }

    // 2. 若模块已处于 resident，且未要求特定模型或模型一致，直接放行
    const rt = this.runtimeStore.get(targetId)
    if (rt?.state === 'resident') {
      return
    }

    // 3. 申领 single_flight_load 生命周期令牌
    const parentToken = this.beginLifecycleOperation(targetId, 'single_flight_load')
    if (!parentToken) {
      // 若已被并发任务申领，二次检查是否已在途
      const inflightAgain = this.inflightLoads.get(targetId)
      if (inflightAgain) {
        return inflightAgain.promise
      }
      throw new HibernationGateAbortedError(
        targetId,
        'OPERATION_LOCKED',
        '无法申领加载令牌，当前有其他生命周期操作在运行'
      )
    }

    // 4. 执行单飞加载
    return this.startSingleFlightLoadWithToken(parentToken, modelId)
  }

  // ==========================================
  // 大模型热切换事务与取消协作上下文 (Ticket 08)
  // ==========================================

  /**
   * 前置收敛目标模块所有在途物理操作 (15s 上限)
   */
  async awaitAllInFlightOpsSettled(
    targetId: string,
    cancelCtx: SwapCancelContext,
    timeoutMs = 15_000
  ): Promise<void> {
    const ops = Array.from(this.activeInFlightOps.values()).filter(o => o.targetId === targetId)
    for (const op of ops) {
      cancelCtx.inFlightOps.set(op.opId, op)
    }

    const settleResults = await Promise.allSettled(
      ops.map(async op => {
        if (op.status === 'settled') return 'settled'
        if (op.status === 'failed_unknown') return 'failed_unknown'

        op.abortController?.abort()
        let timeoutTimer: ReturnType<typeof setTimeout> | undefined
        try {
          const timeoutP = new Promise<'timeout'>(r => {
            timeoutTimer = setTimeout(() => r('timeout'), timeoutMs)
          })
          const raceRes = await Promise.race([
            op.completionPromise?.then(() =>
              (op.status as string) === 'failed_unknown'
                ? ('failed_unknown' as const)
                : ('settled' as const)
            ) ?? Promise.resolve('settled' as const),
            timeoutP
          ])
          if (raceRes === 'timeout' || (op.status as string) === 'failed_unknown') {
            this.finalizeOpAsFailedUnknown(op)
            return 'failed_unknown'
          } else {
            this.finalizeOpAsSettled(op)
            return 'settled'
          }
        } catch {
          this.finalizeOpAsFailedUnknown(op)
          return 'failed_unknown'
        } finally {
          if (timeoutTimer) clearTimeout(timeoutTimer)
        }
      })
    )

    const hasUnsettled = settleResults.some(
      res =>
        res.status === 'rejected' || (res.status === 'fulfilled' && res.value === 'failed_unknown')
    )
    if (hasUnsettled) {
      throw new HibernationGateAbortedError(
        targetId,
        'UNLOAD_ESCALATED',
        '模块部分在途进程释放超时，已启动安全保护'
      )
    }
  }

  /**
   * 中止目标引擎所有在途业务租约
   */
  cancelInFlightEngineLeases(targetId: string, reason: string): void {
    if (!this.leaseRegistryInstance) return
    if (typeof (this.leaseRegistryInstance as any).cancelAllByTarget === 'function') {
      try {
        ;(this.leaseRegistryInstance as any).cancelAllByTarget(targetId, reason)
      } catch {}
    }
    const leases = (this.leaseRegistryInstance as any).leases
    if (leases instanceof Map) {
      for (const lease of leases.values()) {
        if (lease.targetId === targetId && !lease.released) {
          try {
            lease.abortController.abort(reason)
          } catch {}
        }
      }
    }
  }

  /**
   * 等待业务租约排空（带超时上界）
   */
  async waitForLeasesDrained(targetId: string, timeoutMs: number): Promise<boolean> {
    if (!this.leaseRegistryInstance) return true
    if (this.leaseRegistryInstance.countActiveByTarget(targetId) === 0) return true

    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (this.leaseRegistryInstance.countActiveByTarget(targetId) === 0) {
        return true
      }
      await new Promise(r => setTimeout(r, 100))
    }
    return this.leaseRegistryInstance.countActiveByTarget(targetId) === 0
  }

  /**
   * 本地大模型热切换事务 (beginModelSwap)
   * 遵循 L3 规格书 §2.1 契约：
   * 1. 最高调度优先级，由 engineLifecycleMutex 全局互斥锁守护；
   * 2. 进入临界区前同步执行 holdSwap(targetId)，阻止新请求并清算分桶；
   * 3. 推进代次 bumpEpoch 作废在途操作，中止旧在途租约并受 10s 硬上界约束；
   * 4. 构建 SwapCancelContext 协作取消上下文，支持极速协作取消；
   * 5. 严格前置确认旧进程退出（stopped_confirmed），失败坚决阻断新模型启动；
   * 6. 新模型加载成功后原子释放换型锁，向 UI 广播换型完成。
   */
  async beginModelSwap(
    targetId: string,
    nextModelId: string
  ): Promise<{ status: 'swapped'; generation: number }> {
    this.holdSwap(targetId)

    const cancelAbortCtrl = new AbortController()
    const currentRt = this.runtimeStore.get(targetId)
    if (!currentRt) {
      this.releaseSwapHold(targetId)
      throw new Error(`Target not found in runtimeStore: ${targetId}`)
    }

    const cancelCtx: SwapCancelContext = {
      targetId,
      swapTokenId: 'pending_lock',
      abortController: cancelAbortCtrl,
      cancelRequested: false,
      inFlightOps: new Map<string, InFlightPhysicalOp>(),
      inFlightStoppingState: 'none',
      rollbackSnapshot: {
        generation: currentRt.modelGeneration,
        residentBytes: currentRt.residentBytes,
        residentSample: currentRt.residentSample ? { ...currentRt.residentSample } : undefined,
        lastReleased: currentRt.lastReleased ? { ...currentRt.lastReleased } : undefined
      }
    }
    this.swapCancelContexts.set(targetId, cancelCtx)

    let finalGeneration = currentRt.modelGeneration

    try {
      await this.engineLifecycleMutex.runExclusive(async () => {
        if (cancelCtx.cancelRequested) {
          cancelCtx.rollbackHandledByCancel = true
          throw new HibernationGateAbortedError(targetId, 'MODEL_SWAPPED', '本地大模型切换已被取消')
        }

        const rtBefore = this.runtimeStore.get(targetId) ?? currentRt
        const previousGeneration = rtBefore.modelGeneration
        const nextGeneration = this.bumpModelGeneration(targetId)
        finalGeneration = nextGeneration

        let swapToken: LifecycleToken | undefined
        try {
          try {
            swapToken = this.beginLifecycleOperation(targetId, 'model_swap')
          } catch (err) {
            logger.error(
              LogCategory.SYSTEM,
              `[Coordinator] failed_to_begin_lifecycle_operation_model_swap: targetId=${targetId}`,
              err
            )
          }

          if (!swapToken) {
            const stubToken: LifecycleToken = {
              targetId,
              operation: 'model_swap',
              tokenId: 'rollback_stub',
              epoch: this.currentEpoch(targetId),
              modelGeneration: nextGeneration,
              grantedAt: Date.now()
            }
            this.restoreModelGeneration(targetId, stubToken, nextGeneration, previousGeneration)
            throw new HibernationGateAbortedError(
              targetId,
              'OPERATION_LOCKED',
              '无法获取模型换型生命周期属主令牌'
            )
          }

          cancelCtx.swapTokenId = swapToken.tokenId

          const assertSwapActive = () => {
            const ctx = this.swapCancelContexts.get(targetId)
            if (
              ctx?.cancelRequested ||
              !this.isSwapInProgress(targetId) ||
              this.activeLifecycleOwner.get(targetId)?.tokenId !== swapToken!.tokenId
            ) {
              if (ctx?.cancelRequested) {
                ctx.rollbackHandledByCancel = true
              }
              throw new HibernationGateAbortedError(
                targetId,
                'MODEL_SWAPPED',
                '本地大模型切换已被取消或已被其他操作接管'
              )
            }
          }

          const raceCancel = <T>(p: Promise<T>): Promise<T> => {
            p.catch(err => {
              logger.debug(
                LogCategory.SYSTEM,
                `[Coordinator] raceCancel consumed late rejection: targetId=${targetId}`,
                err
              )
            })
            if (cancelAbortCtrl.signal.aborted) {
              assertSwapActive()
            }
            let onAbort: (() => void) | undefined
            const cancelP = new Promise<T>((_, reject) => {
              onAbort = () => {
                try {
                  assertSwapActive()
                } catch (e) {
                  reject(e)
                }
              }
              cancelAbortCtrl.signal.addEventListener('abort', onAbort, { once: true })
            })
            return Promise.race([p, cancelP]).finally(() => {
              if (onAbort) {
                cancelAbortCtrl.signal.removeEventListener('abort', onAbort)
              }
            })
          }

          // 进入换型临界区同步跃迁为 draining 状态
          this.commitRuntimeSnapshot(swapToken, d => {
            d.state = 'draining'
            d.modelGeneration = nextGeneration
            d.lastReleased = undefined
            d.residentSample = undefined
          })

          const residentBytesAtEntry = currentRt.residentBytes
          this.invalidateInflight(targetId, 'MODEL_SWAPPED')

          // 统一收敛目标模块所有在途操作 (15s 上限)
          await raceCancel(this.awaitAllInFlightOpsSettled(targetId, cancelCtx))
          assertSwapActive()

          // 中止在途租约并有界等待排空
          this.cancelInFlightEngineLeases(targetId, 'MODEL_SWAPPED')
          assertSwapActive()

          this.setPendingSwapDraining(targetId, true)
          let drained = false
          try {
            drained = await raceCancel(
              this.waitForLeasesDrained(targetId, LEASE_SWAP_DRAIN_TIMEOUT_MS)
            )
          } finally {
            this.setPendingSwapDraining(targetId, false)
          }
          assertSwapActive()

          // 物理副作用收敛：若旧身份已在途停机，直接复用其停机任务并 await 结果 (P1-03)
          const oldStoppingKey = this.targetStoppingIdentity.get(targetId)
          if (oldStoppingKey) {
            const oldStoppingEntry = this.activeStoppingTasksByIdentity.get(oldStoppingKey)
            if (oldStoppingEntry && oldStoppingEntry.status !== 'stopped_confirmed') {
              logger.info(
                LogCategory.SYSTEM,
                `[Coordinator] 换型前置等待已在途停机任务: targetId=${targetId}, oldStoppingKey=${oldStoppingKey}`
              )
              cancelCtx.inFlightStoppingIdentity = oldStoppingEntry.identity
              cancelCtx.inFlightStoppingState = 'in_flight'
              const prevRes = await raceCancel(oldStoppingEntry.resultPromise)
              cancelCtx.inFlightStoppingState = 'settled'
              cancelCtx.inFlightStoppingResult = prevRes
              assertSwapActive()
              if (prevRes.status !== 'stopped_confirmed') {
                if (
                  this.engineBridgeServiceInstance?.isProcessTreeExited(oldStoppingEntry.identity)
                ) {
                  this.activeStoppingTasksByIdentity.delete(oldStoppingKey)
                  if (this.targetStoppingIdentity.get(targetId) === oldStoppingKey) {
                    this.targetStoppingIdentity.delete(targetId)
                  }
                } else {
                  this.commitRuntimeSnapshot(swapToken, d => {
                    d.state = 'error'
                    d.lastFailureKind = 'unload'
                    d.modelGeneration = previousGeneration
                    d.unloadFailStreak += 1
                  })
                  throw new HibernationGateAbortedError(
                    targetId,
                    'UNLOAD_ESCALATED',
                    '本地大模型切换失败，旧模型进程退出失败，请重启应用'
                  )
                }
              }
            }
          }

          // 采样当前旧进程物理身份
          const oldIdentity = this.engineBridgeServiceInstance?.currentIdentity
            ? this.engineBridgeServiceInstance.currentIdentity(targetId)
            : undefined

          let isRunning = false
          try {
            isRunning =
              oldIdentity !== undefined &&
              (this.engineBridgeServiceInstance?.isServiceRunning
                ? this.engineBridgeServiceInstance.isServiceRunning(targetId)
                : false)
          } catch {
            isRunning = true
          }

          const mustStop = !drained || isRunning || oldIdentity !== undefined

          if (mustStop && oldIdentity !== undefined) {
            let stopped = false
            try {
              cancelCtx.inFlightStoppingIdentity = oldIdentity
              cancelCtx.inFlightStoppingState = 'in_flight'
              const stopResult = await raceCancel(this.stopServiceBounded(targetId, oldIdentity))
              cancelCtx.inFlightStoppingState = 'settled'
              cancelCtx.inFlightStoppingResult = stopResult
              stopped = stopResult.status === 'stopped_confirmed'
            } catch (err) {
              logger.error(
                LogCategory.SYSTEM,
                `[Coordinator] engine_stop_escalate_unexpected: targetId=${targetId}`,
                err
              )
              stopped = false
            }
            assertSwapActive()

            // 无论停机成败，强制收敛租约
            this.leaseRegistryInstance?.forceReleaseByTarget(targetId)
            assertSwapActive()

            if (!stopped) {
              logger.error(
                LogCategory.SYSTEM,
                `[Coordinator] 旧模型停机未确证退出，阻断新模型启动: targetId=${targetId}`
              )
              this.commitRuntimeSnapshot(swapToken, d => {
                d.state = 'error'
                d.lastFailureKind = 'unload'
                d.modelGeneration = previousGeneration
                d.unloadFailStreak += 1
              })
              const clusterId = HIBERNATABLE_TARGET_CATALOG[targetId]?.clusterId
              if (clusterId) {
                this.onClusterActivityChanged(clusterId)
              }
              throw new HibernationGateAbortedError(
                targetId,
                'UNLOAD_ESCALATED',
                '本地大模型切换失败，旧模型进程无法退出，请重启应用'
              )
            }

            // 旧进程确证退出，原子归位 hibernated
            this.commitRuntimeSnapshot(swapToken, d => {
              d.state = 'hibernated'
              d.unloadFailStreak = 0
              if (residentBytesAtEntry > 0) {
                const kind = currentRt.effectiveMemoryKind ?? 'ram'
                d.lastReleasedBytes = residentBytesAtEntry
                d.lastReleased = {
                  bytes: residentBytesAtEntry,
                  releasedAt: Date.now(),
                  modelGeneration: d.modelGeneration,
                  kind,
                  state: 'available'
                }
              }
            })
            const clusterId = HIBERNATABLE_TARGET_CATALOG[targetId]?.clusterId
            if (clusterId) {
              this.onClusterActivityChanged(clusterId)
            }
          } else {
            this.leaseRegistryInstance?.forceReleaseByTarget(targetId)
            assertSwapActive()
            this.commitRuntimeSnapshot(swapToken, d => {
              d.state = 'hibernated'
              d.unloadFailStreak = 0
              if (residentBytesAtEntry > 0) {
                const kind = currentRt.effectiveMemoryKind ?? 'ram'
                d.lastReleasedBytes = residentBytesAtEntry
                d.lastReleased = {
                  bytes: residentBytesAtEntry,
                  releasedAt: Date.now(),
                  modelGeneration: d.modelGeneration,
                  kind,
                  state: 'available'
                }
              }
            })
            const clusterId = HIBERNATABLE_TARGET_CATALOG[targetId]?.clusterId
            if (clusterId) {
              this.onClusterActivityChanged(clusterId)
            }
          }

          assertSwapActive()

          // 携带换型 Token 进入单飞冷启动新模型
          const loadPromise = this.startSingleFlightLoadWithToken(swapToken, nextModelId)
          const loadOp = Array.from(this.activeInFlightOps.values()).find(
            op => op.targetId === targetId && op.type === 'load'
          )
          if (loadOp) {
            cancelCtx.inFlightLoadOpId = loadOp.opId
          }
          await raceCancel(loadPromise)
          cancelCtx.committed = true
        } finally {
          // 仅当未发生协作取消交接时，换型协程才主动终结属主 (P1-01)
          if (
            swapToken &&
            !cancelCtx.rollbackHandledByCancel &&
            this.activeLifecycleOwner.get(targetId)?.tokenId === swapToken.tokenId
          ) {
            this.endLifecycleOperation(swapToken)
          }
        }
      })
      return { status: 'swapped', generation: finalGeneration }
    } finally {
      // 仅当未发生协作取消交接时，换型协程才清理上下文与换型持有 (P1-01)
      if (!cancelCtx.rollbackHandledByCancel) {
        this.swapCancelContexts.delete(targetId)
        this.releaseSwapHold(targetId)
      }
    }
  }

  /**
   * 取消大模型热切换 (cancelModelSwap)
   */
  async cancelModelSwap(targetId: string): Promise<CancelSwapResult> {
    const cancelCtx = this.swapCancelContexts.get(targetId)
    if (!cancelCtx || !this.isSwapInProgress(targetId) || cancelCtx.committed) {
      return { status: cancelCtx?.committed ? 'already_committed' : 'no_swap_in_progress' }
    }

    // 锁外同步设置取消意图与持久标记
    this.registerCancelIntent(targetId)
    cancelCtx.cancelRequested = true

    const stoppingKey = this.targetStoppingIdentity.get(targetId)
    if (stoppingKey) {
      const stoppingEntry = this.activeStoppingTasksByIdentity.get(stoppingKey)
      if (stoppingEntry) {
        this.globalSuppressedStoppingIdentities.set(stoppingKey, {
          targetId,
          identity: stoppingEntry.identity,
          suppressedAt: Date.now()
        })
      }
    }

    cancelCtx.abortController.abort()

    try {
      return await this.engineLifecycleMutex.runExclusive(async (): Promise<CancelSwapResult> => {
        if (cancelCtx.committed) {
          logger.info(
            LogCategory.SYSTEM,
            `[Coordinator] 取消换型到达时换型已完成提交: targetId=${targetId}`
          )
          return { status: 'already_committed' }
        }

        cancelCtx.rollbackHandledByCancel = true

        // 回收在途物理操作
        const allTargetOps = Array.from(this.activeInFlightOps.values()).filter(
          o => o.targetId === targetId
        )
        for (const op of allTargetOps) {
          if (op.status === 'running') {
            op.abortController?.abort()
            const timeoutP = new Promise<void>(r => setTimeout(r, 5_000))
            await Promise.race([op.completionPromise, timeoutP]).catch(() => {})
          }
        }

        // 接管在途停机任务并有界等待
        if (stoppingKey) {
          const stoppingEntry = this.activeStoppingTasksByIdentity.get(stoppingKey)
          if (stoppingEntry && stoppingEntry.status === 'running') {
            stoppingEntry.submissionSuppressed = true
            let cancelTimer: ReturnType<typeof setTimeout> | undefined
            const timeoutP = new Promise<void>(r => {
              cancelTimer = setTimeout(r, CANCEL_AWAIT_STOP_TIMEOUT_MS)
            })
            await Promise.race([stoppingEntry.resultPromise, timeoutP]).catch(() => {})
            if (cancelTimer) clearTimeout(cancelTimer)
          }
        }

        const rollback = cancelCtx.rollbackSnapshot
        const stoppingRes = cancelCtx.inFlightStoppingResult
        const confirmedStopped = stoppingRes?.status === 'stopped_confirmed'
        const stoppingFailed = stoppingRes?.status === 'failed_unknown'
        const stoppingInFlight =
          cancelCtx.inFlightStoppingState === 'in_flight' || stoppingKey !== undefined

        const oldId = this.engineBridgeServiceInstance?.currentIdentity
          ? this.engineBridgeServiceInstance.currentIdentity(targetId)
          : undefined
        const isRunning =
          oldId !== undefined &&
          (this.engineBridgeServiceInstance?.isServiceRunning
            ? this.engineBridgeServiceInstance.isServiceRunning(targetId)
            : false)

        const currentToken = this.activeLifecycleOwner.get(targetId)
        const applyRollback = (draft: ModuleRuntimeState) => {
          if (confirmedStopped) {
            draft.state = 'hibernated'
            draft.modelGeneration = rollback ? rollback.generation : draft.modelGeneration
            draft.residentBytes = 0
            draft.residentSample = undefined
            if (rollback?.lastReleased) {
              draft.lastReleased = { ...rollback.lastReleased, state: 'available' }
            }
          } else if (stoppingFailed || (stoppingInFlight && !confirmedStopped)) {
            draft.state = 'error'
            draft.lastFailureKind = 'unload'
            draft.modelGeneration = rollback ? rollback.generation : draft.modelGeneration
            draft.residentBytes = 0
            draft.residentSample = undefined
          } else if (isRunning) {
            draft.state = 'resident'
            draft.modelGeneration = rollback ? rollback.generation : draft.modelGeneration
            draft.residentSince = Date.now()
            draft.crashStreak = 0
            draft.lastCrashGeneration = undefined
            draft.lastFailureKind = undefined
            draft.errorPhase = undefined
            draft.errorMessage = undefined
            draft.lastErrorI18nKey = undefined
            draft.residentBytes = rollback ? rollback.residentBytes : draft.residentBytes
            draft.residentSample = rollback ? rollback.residentSample : undefined
            draft.lastReleased = undefined
          } else {
            draft.state = 'hibernated'
            draft.modelGeneration = rollback ? rollback.generation : draft.modelGeneration
            draft.residentBytes = 0
            draft.residentSample = undefined
            if (rollback?.lastReleased) {
              draft.lastReleased = { ...rollback.lastReleased, state: 'available' }
            }
          }
        }

        if (currentToken && currentToken.operation === 'model_swap') {
          this.commitRuntimeSnapshot(currentToken, applyRollback)
          this.endLifecycleOperation(currentToken)
        } else {
          this.runtimeStore.update(targetId, applyRollback)
        }

        const clusterId = HIBERNATABLE_TARGET_CATALOG[targetId]?.clusterId
        if (clusterId) {
          this.onClusterActivityChanged(clusterId)
        }
        return { status: 'cancelled' }
      })
    } finally {
      const currentToken = this.activeLifecycleOwner.get(targetId)
      if (!currentToken || currentToken.operation !== 'model_swap') {
        this.swapCancelContexts.delete(targetId)
        this.targetCancelIntent.delete(targetId)
      }
      this.releaseSwapHold(targetId)
    }
  }

  // ==========================================
  // 槽位兼容与通知方法
  // ==========================================

  /** 准入槽位兼容方法 */
  tryAcquireAdmissionSlot(
    targetId: string,
    _epoch?: number,
    operation: LifecycleOperation = 'unload_retry'
  ): AdmissionToken | undefined {
    return this.beginLifecycleOperation(targetId, operation)
  }

  releaseAdmissionSlot(token?: AdmissionToken): void {
    this.endLifecycleOperation(token)
  }

  /**
   * 群组是否安全可排空 (Ticket 09)
   * 仅当群组无活跃业务租约时允许优雅排空
   */
  isClusterDrainSafe(clusterId: 'analysis_suite' | 'tts_media'): boolean {
    if (!this.leaseRegistryInstance) return true
    return this.leaseRegistryInstance.countActive(clusterId) === 0
  }

  // ==========================================
  // Gate 分桶等待队列原语 (Ticket 09)
  // ==========================================

  /**
   * 挂起等待者入目标分桶队列
   */
  enqueueForTarget(req: GateRequest): Promise<HibernationLeaseHandle> {
    let resolveFn!: (h: HibernationLeaseHandle) => void
    let rejectFn!: (err: Error) => void
    const p = new Promise<HibernationLeaseHandle>((resolve, reject) => {
      resolveFn = resolve
      rejectFn = reject
    })
    const waiter: GateQueueWaiter = {
      req,
      resolve: resolveFn,
      reject: rejectFn
    }
    const bucket = this.gateWaiters.get(req.targetId) ?? []
    bucket.push(waiter)
    this.gateWaiters.set(req.targetId, bucket)
    return p
  }

  /**
   * 分桶唤醒等待者并链入单飞加载或直接授予
   */
  dispatchWaitingForTarget(targetId: string, error?: Error): void {
    const bucket = this.gateWaiters.get(targetId)
    if (!bucket || bucket.length === 0) return
    this.gateWaiters.delete(targetId)

    if (error) {
      for (const waiter of bucket) {
        try {
          waiter.reject(error)
        } catch {}
      }
      return
    }

    ;(async () => {
      try {
        const rt = this.runtimeStore.get(targetId)
        if (rt?.state === 'hibernated') {
          await this.startSingleFlightLoad(targetId)
        }
        for (const waiter of bucket) {
          try {
            const handle = this.acquireLeaseForRequest(waiter.req)
            waiter.resolve(handle)
          } catch (e) {
            waiter.reject(e as Error)
          }
        }
      } catch (err) {
        for (const waiter of bucket) {
          try {
            waiter.reject(err as Error)
          } catch {}
        }
      }
    })()
  }

  /**
   * 分桶全量拒绝清算
   */
  rejectAllForTarget(targetId: string, error: HibernationGateAbortedError): number {
    const bucket = this.gateWaiters.get(targetId)
    if (!bucket || bucket.length === 0) return 0
    this.gateWaiters.delete(targetId)
    for (const waiter of bucket) {
      try {
        waiter.reject(error)
      } catch {}
    }
    return bucket.length
  }

  // ==========================================
  // 两阶段排空流水线 (Ticket 09)
  // ==========================================

  /**
   * 清除在途排空事务
   */
  clearDrain(targetId: string, ctx?: DrainTransactionContext): void {
    const cur = this.activeDrain.get(targetId)
    if (!ctx || cur === ctx) {
      if (cur?.cancelWindowTimer) {
        clearTimeout(cur.cancelWindowTimer)
        cur.cancelWindowTimer = undefined
      }
      this.activeDrain.delete(targetId)
    }
  }

  /**
   * 阶段 2 不可逆临界点守卫
   */
  guardBeforeIrreversibleDrain(ctx: DrainTransactionContext): boolean {
    if (ctx.cancelRequested || ctx.irreversible) return false
    if (this.isSwapInProgress(ctx.targetId) || this.currentEpoch(ctx.targetId) !== ctx.epoch) {
      logger.info(
        LogCategory.SYSTEM,
        `[Coordinator] drain_yielded_to_swap: targetId=${ctx.targetId}`
      )
      return false
    }
    ctx.irreversible = true
    if (ctx.cancelWindowTimer) {
      clearTimeout(ctx.cancelWindowTimer)
      ctx.cancelWindowTimer = undefined
    }
    return true
  }

  /**
   * 模块两阶段排空核心原语 (drainModuleTwoStage)
   * 阶段 1: 500ms 可撤销窗口 (新任务入场即时恢复 resident)
   * 阶段 2: 不可逆卸载 (新任务入分桶等待冷启动)
   */
  async drainModuleTwoStage(targetId: string): Promise<boolean> {
    if (this.isSwapInProgress(targetId)) return false

    const meta = HIBERNATABLE_TARGET_CATALOG[targetId]
    const clusterId = meta?.clusterId ?? 'analysis_suite'
    if (!this.isClusterDrainSafe(clusterId)) return false

    const rt = this.runtimeStore.get(targetId)
    if (rt?.state !== 'resident') return false

    let drainToken: LifecycleToken | undefined
    try {
      drainToken = this.beginLifecycleOperation(targetId, 'idle_hibernation')
    } catch (err) {
      logger.warn(
        LogCategory.SYSTEM,
        `[Coordinator] beginLifecycleOperation idle_hibernation 失败: targetId=${targetId}`,
        err
      )
      return false
    }
    if (!drainToken) return false

    const epoch = this.currentEpoch(targetId)
    const residentBytesAtEntry = rt.residentBytes

    this.commitRuntimeSnapshot(drainToken, d => {
      d.state = 'draining'
    })

    let cancelNotifyFn!: () => void
    const cancelPromise = new Promise<void>(resolve => {
      cancelNotifyFn = resolve
    })

    const ctx: DrainTransactionContext = {
      targetId,
      epoch,
      residentBytesAtEntry,
      cancelRequested: false,
      irreversible: false,
      cancelNotify: cancelNotifyFn
    }
    this.activeDrain.set(targetId, ctx)

    try {
      // 阶段 1: 500ms 可撤销窗口挂起
      let windowTimer: ReturnType<typeof setTimeout> | undefined
      const windowPromise = new Promise<void>(resolve => {
        windowTimer = setTimeout(resolve, DRAIN_CANCELABLE_WINDOW_MS)
      })
      ctx.cancelWindowTimer = windowTimer

      await Promise.race([windowPromise, cancelPromise])

      // 阶段 2: 临界点校验
      if (!this.guardBeforeIrreversibleDrain(ctx)) {
        logger.info(
          LogCategory.SYSTEM,
          `[Coordinator] 两阶段排空在不可逆点前被中止/让权: targetId=${targetId}`
        )
        return false
      }

      // 执行不可逆卸载
      if (meta?.type === 'engine_service') {
        const oldId = this.engineBridgeServiceInstance?.currentIdentity?.(targetId)
        if (oldId) {
          const stopRes = await this.stopServiceBounded(targetId, oldId)
          if (stopRes.status !== 'stopped_confirmed') {
            logger.error(
              LogCategory.SYSTEM,
              `[Coordinator] 两阶段排空停机未确证退出: targetId=${targetId}`
            )
            this.commitRuntimeSnapshot(drainToken, d => {
              d.state = 'error'
              d.lastFailureKind = 'unload'
              d.unloadFailStreak += 1
            })
            this.dispatchWaitingForTarget(
              targetId,
              new HibernationGateAbortedError(targetId, 'UNLOAD_ESCALATED', '卸载停机失败')
            )
            return false
          }
        }
      }

      let actualReleasedBytes = residentBytesAtEntry
      if (meta?.type === 'omni_module') {
        try {
          const drainRes = await this.engineBridgeServiceInstance?.drainOmniModule?.(targetId, {
            waitDrainMs: 3000
          })
          if (drainRes && drainRes.releasedBytes > 0) {
            actualReleasedBytes = drainRes.releasedBytes
          }
        } catch (err) {
          logger.warn(
            LogCategory.SYSTEM,
            `[Coordinator] omni_module 卸载调用失败，回落目录估值: targetId=${targetId}`,
            err
          )
        }
      }

      // 卸载成功，原子归位 hibernated
      this.commitRuntimeSnapshot(drainToken, d => {
        d.state = 'hibernated'
        d.residentBytes = 0
        d.residentSample = undefined
        d.unloadFailStreak = 0
        if (actualReleasedBytes > 0) {
          d.lastReleasedBytes = actualReleasedBytes
          d.lastReleased = {
            bytes: actualReleasedBytes,
            releasedAt: Date.now(),
            modelGeneration: d.modelGeneration,
            kind: d.effectiveMemoryKind ?? 'ram',
            state: 'available'
          }
        }
      })

      // 属主优先归位释放，杜绝分桶等待者唤醒链入冷启动时发生属主冲突 (OPERATION_LOCKED)
      if (drainToken && this.activeLifecycleOwner.get(targetId)?.tokenId === drainToken.tokenId) {
        this.endLifecycleOperation(drainToken)
        drainToken = undefined
      }

      this.onClusterActivityChanged(clusterId)
      // 唤醒分桶等待者（属主已释放，等待者可顺畅申领 single_flight_load 令牌）
      this.dispatchWaitingForTarget(targetId)
      return true
    } finally {
      this.clearDrain(targetId, ctx)
      if (drainToken && this.activeLifecycleOwner.get(targetId)?.tokenId === drainToken.tokenId) {
        this.endLifecycleOperation(drainToken)
      }
    }
  }

  // ==========================================
  // 业务入场防护门闩 (withHibernationGate)
  // ==========================================

  /**
   * 业务调用层入场防护门闩 (withHibernationGate)
   * 1. 权威持久门闩拦截
   * 2. 状态机分派与单飞冷启动/排队
   * 3. 租约自动生命周期与 release 兜底
   */
  async withHibernationGate<T>(
    req: GateRequest,
    fn: (lease: HibernationLeaseHandle, signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const targetId = req.targetId

    // 1. 持久门闩阻断前置检查
    const rt = this.runtimeStore.get(targetId)
    if (rt && (rt.blockedUnloadNoHandle === 1 || rt.blockedUnloadIdentity !== null)) {
      throw new HibernationGateAbortedError(
        targetId,
        'UNLOAD_ESCALATED',
        '模块由于进程无法正常终止已进入持久阻断门闩，请重启应用'
      )
    }

    // 2. 状态分派与租约申领
    const lease = await this.enqueueOrGrant(req)

    // 3. 执行任务并在 finally 保证 release
    try {
      return await fn(lease, lease.abortController?.signal as AbortSignal)
    } finally {
      lease.release()
    }
  }

  /**
   * 准入分派核心原语 (enqueueOrGrant)
   */
  private async enqueueOrGrant(req: GateRequest): Promise<HibernationLeaseHandle> {
    const targetId = req.targetId

    if (this.isSwapInProgress(targetId)) {
      throw new HibernationGateAbortedError(
        targetId,
        'MODEL_SWAPPED',
        '本地大模型正在换型中，请稍后重试'
      )
    }

    const rt = this.runtimeStore.get(targetId)
    const state = rt?.state ?? 'hibernated'

    // 1. resident 状态：直接获取租约
    if (state === 'resident') {
      return this.acquireLeaseForRequest(req)
    }

    // 2. loading 状态：链入既有单飞等待
    if (state === 'loading') {
      const inflight = this.inflightLoads.get(targetId)
      if (inflight) {
        await inflight.promise
      }
      return this.acquireLeaseForRequest(req)
    }

    // 3. hibernated 状态：触发单飞冷启动加载
    if (state === 'hibernated') {
      await this.startSingleFlightLoad(targetId)
      return this.acquireLeaseForRequest(req)
    }

    // 4 & 5. draining 状态：区分阶段 1 (可撤销) 与 阶段 2 (不可逆)
    if (state === 'draining') {
      const drainCtx = this.activeDrain.get(targetId)
      if (drainCtx && !drainCtx.irreversible) {
        // 阶段 1 可撤销窗口：同步中止排空并恢复 resident
        drainCtx.cancelRequested = true
        if (drainCtx.cancelWindowTimer) {
          clearTimeout(drainCtx.cancelWindowTimer)
          drainCtx.cancelWindowTimer = undefined
        }
        drainCtx.cancelNotify?.()
        this.clearDrain(targetId, drainCtx)

        const owner = this.activeLifecycleOwner.get(targetId)
        if (owner && owner.operation === 'idle_hibernation') {
          this.commitRuntimeSnapshot(owner, d => {
            d.state = 'resident'
          })
          this.endLifecycleOperation(owner)
        } else {
          this.runtimeStore.update(targetId, d => {
            d.state = 'resident'
          })
        }
        return this.acquireLeaseForRequest(req)
      } else {
        // 阶段 2 不可逆排空：挂入分桶等待队列
        return this.enqueueForTarget(req)
      }
    }

    // 6. error 状态
    if (state === 'error') {
      if (rt?.lastFailureKind === 'unload') {
        throw new HibernationGateAbortedError(
          targetId,
          'UNLOAD_ESCALATED',
          '模块卸载失败处于错误状态，请重启应用'
        )
      }
      if ((rt?.crashStreak ?? 0) >= CRASH_BREAKER_THRESHOLD) {
        throw new HibernationColdStartError(
          targetId,
          'CRASH_LOOP',
          '模块连续崩溃达到熔断上限，已暂停冷启动'
        )
      }
      this.runtimeStore.update(targetId, d => {
        d.lastFailureKind = undefined
        d.errorPhase = undefined
        d.errorMessage = undefined
      })
      await this.startSingleFlightLoad(targetId)
      return this.acquireLeaseForRequest(req)
    }

    return this.acquireLeaseForRequest(req)
  }

  private acquireLeaseForRequest(req: GateRequest): HibernationLeaseHandle {
    if (!this.leaseRegistryInstance) {
      const abortCtrl = new AbortController()
      return {
        leaseId: `stub_lease_${Date.now()}`,
        targetId: req.targetId,
        clusterId: req.clusterId ?? 'analysis_suite',
        abortController: abortCtrl,
        release: () => {}
      } as any
    }
    return this.leaseRegistryInstance.acquireLease({
      targetId: req.targetId,
      clusterId: req.clusterId,
      livenessSourceKey: req.livenessSourceKey
    })
  }

  // ==========================================
  // 群组空闲休眠定时器调度与动态内存判定 (Ticket 09)
  // ==========================================

  /**
   * 启动群组空闲休眠倒计时
   */
  scheduleIdleHibernation(clusterId: 'analysis_suite' | 'tts_media'): void {
    this.cancelIdleHibernation(clusterId)

    const idleTimeout =
      clusterId === 'analysis_suite' ? ANALYSIS_SUITE_IDLE_TIMEOUT_MS : TTS_IDLE_TIMEOUT_MS

    this.clusterIdleStartTime.set(clusterId, Date.now())

    const timer = setTimeout(() => {
      void this.handleClusterIdleTimeout(clusterId)
    }, idleTimeout)

    if (timer && typeof timer.unref === 'function') {
      timer.unref()
    }
    this.clusterIdleTimers.set(clusterId, timer)
  }

  /**
   * 取消群组空闲休眠倒计时
   */
  cancelIdleHibernation(clusterId: 'analysis_suite' | 'tts_media'): void {
    const timer = this.clusterIdleTimers.get(clusterId)
    if (timer) {
      clearTimeout(timer)
      this.clusterIdleTimers.delete(clusterId)
    }
    const graceTimer = this.clusterGraceTimers.get(clusterId)
    if (graceTimer) {
      clearTimeout(graceTimer)
      this.clusterGraceTimers.delete(clusterId)
    }
    this.clusterIdleStartTime.delete(clusterId)
  }

  private async handleClusterIdleTimeout(clusterId: 'analysis_suite' | 'tts_media'): Promise<void> {
    if (!this.isClusterDrainSafe(clusterId)) {
      logger.info(
        LogCategory.SYSTEM,
        `[Coordinator] 群组仍有活跃任务，取消空闲排空: clusterId=${clusterId}`
      )
      return
    }

    const idleStart = this.clusterIdleStartTime.get(clusterId) ?? Date.now()
    const idleDurationMs = Date.now() - idleStart
    const totalMem = this.getTotalMemoryProvider ? this.getTotalMemoryProvider() : os.totalmem()
    const freeMem = this.getFreeMemoryProvider ? this.getFreeMemoryProvider() : os.freemem()

    const idleSec = this.getSystemIdleTimeProvider
      ? this.getSystemIdleTimeProvider()
      : this.powerMonitorServiceInstance
        ? this.powerMonitorServiceInstance.getSystemIdleTime()
        : Math.floor(idleDurationMs / 1000)

    const threshold = computeHibernationMemoryThreshold(totalMem, idleSec * 1000)

    const isMemoryTight = freeMem < threshold
    const isGracePeriodExceeded = idleDurationMs >= MAX_GRACE_PERIOD_MS

    if (isMemoryTight || isGracePeriodExceeded) {
      logger.info(
        LogCategory.SYSTEM,
        `[Coordinator] 触发群组空闲排空: clusterId=${clusterId}, freeMem=${freeMem}, threshold=${threshold}`
      )
      await this.drainClusterResidentTargets(clusterId)
    } else {
      // 内存充裕，进入 60s 宽限重检
      const graceTimer = setTimeout(() => {
        void this.handleClusterIdleTimeout(clusterId)
      }, STABLE_RESIDENT_RESET_MS)
      if (graceTimer && typeof graceTimer.unref === 'function') {
        graceTimer.unref()
      }
      this.clusterGraceTimers.set(clusterId, graceTimer)
    }
  }

  /**
   * 优雅排空群组内所有处于 resident 的模块
   */
  async drainClusterResidentTargets(clusterId: 'analysis_suite' | 'tts_media'): Promise<void> {
    const targets = this.idleDrainTargets(clusterId)
    for (const targetId of targets) {
      await this.drainModuleTwoStage(targetId).catch(err => {
        logger.error(
          LogCategory.SYSTEM,
          `[Coordinator] drainModuleTwoStage failed: targetId=${targetId}`,
          err
        )
      })
    }
  }

  /**
   * 获取指定群组内所有处于 resident 且未在换型中的目标列表
   */
  idleDrainTargets(clusterId: 'analysis_suite' | 'tts_media'): string[] {
    const targets: string[] = []
    for (const [id, meta] of Object.entries(HIBERNATABLE_TARGET_CATALOG)) {
      if (meta.clusterId === clusterId) {
        const rt = this.runtimeStore.get(id)
        if (rt?.state === 'resident' && !this.isSwapInProgress(id)) {
          targets.push(id)
        }
      }
    }
    return targets
  }

  /**
   * 动态内存自适应阈值计算代理 (Ticket 04 / 09)
   */
  computeHibernationMemoryThreshold(
    totalPhysicalMemoryBytes: number,
    idleDurationMs: number = 0,
    userOverrideThresholdMb?: number
  ): number {
    return computeHibernationMemoryThreshold(
      totalPhysicalMemoryBytes,
      idleDurationMs,
      userOverrideThresholdMb
    )
  }

  // ==========================================
  // 系统事件即时节能 (powerMonitor 锁屏与休眠)
  // ==========================================

  /**
   * 绑定 powerMonitor 节能监听
   */
  setupPowerMonitorIntegration(pm?: IPowerMonitorService): void {
    const powerMonitor = pm ?? this.powerMonitorServiceInstance
    if (!powerMonitor) return

    this.powerMonitorServiceInstance = powerMonitor

    powerMonitor.on('lock-screen', () => {
      logger.info(LogCategory.SYSTEM, '[Coordinator] 收到锁屏事件 (lock-screen)，执行即时节能')
      this.handlePowerEventImmediateEviction()
    })

    powerMonitor.on('suspend', () => {
      logger.info(LogCategory.SYSTEM, '[Coordinator] 收到休眠挂起事件 (suspend)，执行即时节能')
      this.handlePowerEventImmediateEviction()
    })

    powerMonitor.on('resume', () => {
      logger.info(LogCategory.SYSTEM, '[Coordinator] 收到系统恢复事件 (resume)，执行对账')
      void this.reconcileSuppressedIdentities()
    })
  }

  private handlePowerEventImmediateEviction(): void {
    for (const [targetId, meta] of Object.entries(HIBERNATABLE_TARGET_CATALOG)) {
      const rt = this.runtimeStore.get(targetId)
      if (
        rt?.state === 'resident' &&
        this.isClusterDrainSafe(meta.clusterId) &&
        !this.isSwapInProgress(targetId)
      ) {
        this.drainModuleTwoStage(targetId).catch(() => {})
      }
    }
  }

  /** 触发集群活动变化通知 */
  onClusterActivityChanged(clusterId: 'analysis_suite' | 'tts_media'): void {
    try {
      this.onClusterActivityChangedCb?.(clusterId)
    } catch {
      // 容错隔离
    }

    const count =
      typeof this.leaseRegistryInstance?.countActive === 'function'
        ? this.leaseRegistryInstance.countActive(clusterId)
        : 0
    if (count === 0) {
      this.scheduleIdleHibernation(clusterId)
    } else {
      this.cancelIdleHibernation(clusterId)
    }
  }

  // ==========================================
  // 快照聚合、全量回收与 IPC 支撑 (Ticket 11)
  // ==========================================

  private readonly snapshotListeners = new Set<(snapshot: HibernationSnapshot) => void>()
  private snapshotBroadcastTimer?: ReturnType<typeof setTimeout>

  /**
   * 注册快照变更监听器（节流广播）
   */
  onSnapshotChanged(callback: (snapshot: HibernationSnapshot) => void): () => void {
    this.snapshotListeners.add(callback)
    return () => {
      this.snapshotListeners.delete(callback)
    }
  }

  /**
   * 触发快照广播（100ms 节流）
   */
  triggerSnapshotBroadcast(): void {
    if (this.snapshotBroadcastTimer) return
    this.snapshotBroadcastTimer = setTimeout(async () => {
      this.snapshotBroadcastTimer = undefined
      try {
        const snap = await this.getSnapshot()
        for (const cb of this.snapshotListeners) {
          try {
            cb(snap)
          } catch (err) {
            logger.warn(LogCategory.SYSTEM, '[Coordinator] snapshotListener 派发失败', err)
          }
        }
      } catch (err) {
        logger.warn(LogCategory.SYSTEM, '[Coordinator] triggerSnapshotBroadcast 失败', err)
      }
    }, 100)
  }

  /**
   * 获取当前模块休眠与能耗全景快照 (spec §3.3.2)
   */
  async getSnapshot(): Promise<HibernationSnapshot> {
    const metrics: ModuleRuntimeMetric[] = []
    for (const [targetId, meta] of Object.entries(HIBERNATABLE_TARGET_CATALOG)) {
      const state = this.runtimeStore.get(targetId)
      const activeTasks = this.leaseRegistryInstance?.countActiveByTarget(targetId) ?? 0
      if (state) {
        metrics.push({
          ...state,
          availability: meta.availability,
          estimatedMemoryBytes: meta.estimatedMemoryBytes,
          activeTasks
        })
      } else {
        metrics.push({
          id: targetId,
          clusterId: meta.clusterId,
          modelGeneration: 0,
          defaultMemoryKind: meta.defaultMemoryKind,
          effectiveMemoryKind: meta.defaultMemoryKind,
          i18nNameKey: meta.i18nNameKey,
          i18nDescKey: meta.i18nDescKey,
          estimatedMemoryBytes: meta.estimatedMemoryBytes,
          availability: meta.availability,
          state: 'hibernated',
          residentBytes: 0,
          lastActiveTimestamp: Date.now(),
          crashStreak: 0,
          unloadFailStreak: 0,
          blockedUnloadNoHandle: 0,
          blockedUnloadIdentity: null,
          activeTasks
        })
      }
    }

    const memoryGauges = projectMemoryGauges(metrics)
    const totalMemoryBytes = this.getTotalMemoryProvider?.() ?? os.totalmem()
    const availableMemoryBytes = this.getFreeMemoryProvider?.() ?? os.freemem()
    const memoryThresholdBytes = computeHibernationMemoryThreshold(totalMemoryBytes, 0)
    const isMemoryPressured = availableMemoryBytes < memoryThresholdBytes
    const totalSaved = memoryGauges.totalSavedRamBytes + memoryGauges.totalSavedVramBytes
    const isEnergySaving = totalSaved > 0 && metrics.some(m => m.state === 'hibernated')

    return {
      enabled: true,
      isEnergySaving,
      ...memoryGauges,
      availableMemoryBytes,
      totalMemoryBytes,
      memoryThresholdBytes,
      isMemoryPressured,
      modules: metrics
    }
  }

  /**
   * 一键释放全量空闲可休眠模块 (spec §3.4.1)
   */
  async reclaimAll(): Promise<{ success: boolean; releasedBytes: number }> {
    let totalReleasedBytes = 0
    for (const [targetId, meta] of Object.entries(HIBERNATABLE_TARGET_CATALOG)) {
      const runtime = this.runtimeStore.get(targetId)
      if (!runtime) continue

      // 逐模块筛选：中间态与换型让权守卫
      if (
        runtime.state === 'hibernated' ||
        runtime.state === 'draining' ||
        runtime.state === 'loading' ||
        (this.leaseRegistryInstance?.countActiveByTarget(targetId) ?? 0) > 0 ||
        this.isSwapInProgress(targetId) ||
        (runtime.state === 'error' && runtime.lastFailureKind !== 'unload')
      ) {
        continue
      }

      if (runtime.state === 'resident') {
        const releasedBefore = runtime.lastReleasedBytes ?? 0
        const drained = await this.drainModuleTwoStage(targetId)
        if (drained) {
          const updated = this.runtimeStore.get(targetId)
          const delta = (updated?.lastReleasedBytes ?? 0) - releasedBefore
          totalReleasedBytes += delta > 0 ? delta : (runtime.residentBytes ?? 0)
        }
      } else if (runtime.state === 'error' && runtime.lastFailureKind === 'unload') {
        // error + unload 状态下的一键释放
        const slotAcquired = this.tryAcquireAdmissionSlot(targetId)
        if (!slotAcquired) continue
        try {
          const epoch = this.currentEpoch(targetId)
          if (meta.type === 'engine_service') {
            const oldId = this.engineBridgeServiceInstance?.currentIdentity?.(targetId)
            if (oldId) {
              await this.stopServiceBounded(targetId, oldId)
            }
          } else if (meta.type === 'omni_module') {
            await this.engineBridgeServiceInstance?.drainOmniModule?.(targetId)
          }

          const committed = this.commitIfEpoch(targetId, epoch, d => {
            d.state = 'hibernated'
            d.unloadFailStreak = 0
            if (runtime.residentBytes > 0) {
              d.lastReleasedBytes = runtime.residentBytes
            }
          })
          if (committed) {
            totalReleasedBytes += runtime.residentBytes ?? 0
            this.onClusterActivityChanged(meta.clusterId)
            this.dispatchWaitingForTarget(targetId)
          }
        } finally {
          this.releaseAdmissionSlot(slotAcquired)
        }
      }
    }

    this.triggerSnapshotBroadcast()
    return { success: true, releasedBytes: totalReleasedBytes }
  }

  /**
   * 手动强制解除模块持久门闩 (forceReset)
   */
  async forceReset(targetId: string): Promise<boolean> {
    const meta = HIBERNATABLE_TARGET_CATALOG[targetId]
    if (!meta) return false

    const identity = this.engineBridgeServiceInstance?.currentIdentity?.(targetId)
    if (identity && !this.engineBridgeServiceInstance?.isProcessTreeExited?.(identity)) {
      await this.engineBridgeServiceInstance?.forceKillOldGeneration?.(
        targetId,
        identity.generation,
        identity.treeHandle
      )
    }

    await this.runtimeStore.persistBlockedUnloadGate(targetId, 0, null)
    this.blockedUnloadCache.set(targetId, false)

    const current = this.runtimeStore.get(targetId)
    if (current && current.state === 'error') {
      const epoch = this.currentEpoch(targetId)
      this.commitIfEpoch(targetId, epoch, d => {
        d.state = 'hibernated'
        d.crashStreak = 0
        d.unloadFailStreak = 0
        d.lastFailureKind = undefined
        d.blockedUnloadNoHandle = 0
        d.blockedUnloadIdentity = null
      })
    }

    this.triggerSnapshotBroadcast()
    return true
  }

  /**
   * 手动重试处于 error 态的模块 (retryModule)
   */
  async retryModule(targetId: string): Promise<boolean> {
    const current = this.runtimeStore.get(targetId)
    if (!current || current.state !== 'error') return false

    const token = this.beginLifecycleOperation(targetId, 'unload_retry')
    if (!token) return false

    this.commitRuntimeSnapshot(token, d => {
      d.state = 'hibernated'
      d.unloadFailStreak = 0
      d.lastFailureKind = undefined
    })
    this.triggerSnapshotBroadcast()
    return true
  }

  /** 测试清理 */
  destroy(): void {
    if (this.snapshotBroadcastTimer) {
      clearTimeout(this.snapshotBroadcastTimer)
      this.snapshotBroadcastTimer = undefined
    }
    this.snapshotListeners.clear()
    for (const cleanup of Array.from(this.stoppingCleanups)) {
      try {
        cleanup()
      } catch {}
    }
    this.stoppingCleanups.clear()

    // 清理群组定时器与排空窗口定时器
    for (const timer of Array.from(this.clusterIdleTimers.values())) {
      clearTimeout(timer)
    }
    this.clusterIdleTimers.clear()

    for (const timer of Array.from(this.clusterGraceTimers.values())) {
      clearTimeout(timer)
    }
    this.clusterGraceTimers.clear()
    this.clusterIdleStartTime.clear()

    for (const ctx of Array.from(this.activeDrain.values())) {
      if (ctx.cancelWindowTimer) {
        clearTimeout(ctx.cancelWindowTimer)
      }
    }
    this.activeDrain.clear()
    this.gateWaiters.clear()

    this.targetEpochs.clear()
    this.activeLifecycleOwner.clear()
    this.activeInFlightOps.clear()
    this.globalSuppressedStoppingIdentities.clear()
    this.targetCancelIntent.clear()
    this.blockedUnloadCache.clear()
    this.lastCrashAtMap.clear()
    this.residentSinceMap.clear()
    this.swapCancelContexts.clear()
    this.targetStoppingIdentity.clear()
    this.pendingSwapDraining.clear()
    this.targetStoppingMutex.clear()
    this.activeStoppingTasksByIdentity.clear()

    for (const load of Array.from(this.inflightLoads.values())) {
      if (load.watchdogTimer) {
        clearTimeout(load.watchdogTimer)
      }
    }
    this.inflightLoads.clear()
  }
}

/** 全局单例 */
export const moduleHibernationCoordinator = new ModuleHibernationCoordinator()
