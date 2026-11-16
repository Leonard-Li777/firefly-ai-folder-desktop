/**
 * 统一模块休眠调度协调器 (ModuleHibernationCoordinator)
 * 遵循 L3 规格书: docs/specs/unified-module-hibernation-and-energy-transparency-spec.md §2.1 / §2.2
 */

import { logger, LogCategory } from '@firefly/shared'
import { LeaseRegistry } from './lease-registry'
import { MemoryProbe, memoryProbe } from './memory-probe'
import { IModuleRuntimeStore, moduleRuntimeStore } from './module-runtime-store'
import {
  AdmissionToken,
  CANCEL_INTENT_HARD_TTL_MS,
  CANCEL_INTENT_MIN_TTL_MS,
  CRASH_BREAKER_THRESHOLD,
  CRASH_WINDOW_MS,
  IEngineBridgeService,
  IN_FLIGHT_OP_NO_PROGRESS_HARD_TIMEOUT_MS,
  IN_FLIGHT_OP_STALL_TIMEOUT_MS,
  InFlightPhysicalOp,
  LIFECYCLE_OWNER_MAX_TTL_MS,
  LifecycleOperation,
  LifecycleToken,
  ModuleRuntimeState,
  ProcessTreeIdentity,
  STABLE_RESIDENT_RESET_MS,
  SuppressedStoppingIdentityEntry,
  TargetCancelIntentEntry
} from './types'

export interface ModuleHibernationCoordinatorOptions {
  runtimeStore?: IModuleRuntimeStore
  leaseRegistry?: LeaseRegistry
  memoryProbe?: MemoryProbe
  engineBridgeService?: IEngineBridgeService
  onClusterActivityChanged?: (clusterId: 'analysis_suite' | 'tts_media') => void
}

/** 模块休眠调度协调器核心骨架 */
export class ModuleHibernationCoordinator {
  private readonly runtimeStore: IModuleRuntimeStore
  private leaseRegistryInstance?: LeaseRegistry
  private readonly memoryProbe: MemoryProbe
  private engineBridgeServiceInstance?: IEngineBridgeService
  private readonly onClusterActivityChangedCb?: (clusterId: 'analysis_suite' | 'tts_media') => void

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

  /** 换型与停机在途上下文跟踪集合 (targetId) */
  private readonly swapCancelContexts = new Set<string>()
  private readonly targetStoppingIdentity = new Set<string>()
  private readonly pendingSwapDraining = new Set<string>()

  constructor(options?: ModuleHibernationCoordinatorOptions) {
    this.runtimeStore = options?.runtimeStore ?? moduleRuntimeStore
    this.leaseRegistryInstance = options?.leaseRegistry
    this.memoryProbe = options?.memoryProbe ?? memoryProbe
    this.engineBridgeServiceInstance = options?.engineBridgeService
    this.onClusterActivityChangedCb = options?.onClusterActivityChanged
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
   * 目标是否正处于模型换型持有中
   */
  isSwapInProgress(targetId: string): boolean {
    const owner = this.activeLifecycleOwner.get(targetId)
    return owner?.operation === 'model_swap'
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

    return this.runtimeStore.update(targetId, apply)
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
    const key = `${entry.targetId}_${entry.identity.pid}_${entry.identity.startTimeMs}`
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
      this.swapCancelContexts.add(targetId)
    } else {
      this.swapCancelContexts.delete(targetId)
    }
  }

  hasSwapCancelContext(targetId: string): boolean {
    return this.swapCancelContexts.has(targetId)
  }

  setStoppingIdentity(targetId: string, active: boolean): void {
    if (active) {
      this.targetStoppingIdentity.add(targetId)
    } else {
      this.targetStoppingIdentity.delete(targetId)
    }
  }

  hasStoppingIdentity(targetId: string): boolean {
    return this.targetStoppingIdentity.has(targetId)
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

  /** 触发集群活动变化通知 */
  onClusterActivityChanged(clusterId: 'analysis_suite' | 'tts_media'): void {
    try {
      this.onClusterActivityChangedCb?.(clusterId)
    } catch {
      // 容错隔离
    }
  }

  /** 测试清理 */
  destroy(): void {
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
  }
}

/** 全局单例 */
export const moduleHibernationCoordinator = new ModuleHibernationCoordinator()
