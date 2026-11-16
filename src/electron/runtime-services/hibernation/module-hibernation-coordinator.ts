/**
 * 统一模块休眠调度协调器 (ModuleHibernationCoordinator)
 * 遵循 L3 规格书: docs/specs/unified-module-hibernation-and-energy-transparency-spec.md §2.1 / §2.2
 */

import { logger, LogCategory } from '@firefly/shared'
import { LeaseRegistry } from './lease-registry'
import { MemoryProbe, memoryProbe } from './memory-probe'
import { IModuleRuntimeStore, moduleRuntimeStore } from './module-runtime-store'
import { AdmissionToken, LifecycleOperation, LifecycleToken, ModuleRuntimeState } from './types'

export interface ModuleHibernationCoordinatorOptions {
  runtimeStore?: IModuleRuntimeStore
  leaseRegistry?: LeaseRegistry
  memoryProbe?: MemoryProbe
  onClusterActivityChanged?: (clusterId: 'analysis_suite' | 'tts_media') => void
}

/** 模块休眠调度协调器核心骨架 */
export class ModuleHibernationCoordinator {
  private readonly runtimeStore: IModuleRuntimeStore
  private leaseRegistryInstance?: LeaseRegistry
  private readonly memoryProbe: MemoryProbe
  private readonly onClusterActivityChangedCb?: (clusterId: 'analysis_suite' | 'tts_media') => void

  /** 各目标当前代际 Fencing 计数器: targetId -> epoch */
  private readonly targetEpochs = new Map<string, number>()
  /** 各目标当前生命周期活动所有者 (SSOT): targetId -> LifecycleToken */
  private readonly activeLifecycleOwner = new Map<string, LifecycleToken>()

  constructor(options?: ModuleHibernationCoordinatorOptions) {
    this.runtimeStore = options?.runtimeStore ?? moduleRuntimeStore
    this.leaseRegistryInstance = options?.leaseRegistry
    this.memoryProbe = options?.memoryProbe ?? memoryProbe
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
      // 3. crash_recovery 守卫：覆盖 resident, loading, draining, error(内存残留) 与 error(load/单飞失败)
      const hasPhysicalResidentResidual = rt.residentBytes > 0 || rt.residentSample !== undefined
      const isLoadFailureError =
        rt.state === 'error' && (rt.lastFailureKind === 'load' || rt.errorPhase === 'load')
      const isRecoverableState =
        rt.state === 'resident' ||
        rt.state === 'loading' ||
        rt.state === 'draining' ||
        (rt.state === 'error' && (hasPhysicalResidentResidual || isLoadFailureError))

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
  }
}

/** 全局单例 */
export const moduleHibernationCoordinator = new ModuleHibernationCoordinator()
