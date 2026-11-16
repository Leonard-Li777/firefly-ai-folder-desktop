/**
 * 引用租约中心 (LeaseRegistry) 与活跃度源注册表 (LivenessSourceRegistry)
 * 遵循 L3 规格书: docs/specs/unified-module-hibernation-and-energy-transparency-spec.md §2.2 / §3.3
 */

import {
  AcquireLeaseOptions,
  HIBERNATABLE_TARGET_CATALOG,
  HibernationLeaseHandle,
  LEASE_ABSOLUTE_MAX_MS,
  LEASE_TTL_MS,
  LeaseRegistryEntry,
  LivenessSnapshot,
  LivenessSourceRegistry
} from './types'

/** 活跃度判定纯函数：无收割标记、90s 窗口内收到有效信号；若为播放器必须同时处于 playing */
export function isFresh(
  lease: LeaseRegistryEntry,
  snap: LivenessSnapshot,
  now: number = Date.now()
): boolean {
  if (lease.reaping || lease.released || snap.lastSignalAt === 0) return false
  if (now - snap.lastSignalAt > LEASE_TTL_MS) return false
  if (snap.sourceKey === 'player_state' && snap.lastPlaybackState !== 'playing') return false
  return true
}

/** 活跃度信号源注册表实现 */
export class LivenessSourceRegistryImpl implements LivenessSourceRegistry {
  private readonly snapshots = new Map<string, LivenessSnapshot>()
  private readonly leaseRegistryGetter: () => LeaseRegistry

  constructor(leaseRegistryGetter: () => LeaseRegistry) {
    this.leaseRegistryGetter = leaseRegistryGetter
  }

  snapshot(leaseId: string): LivenessSnapshot {
    const snap = this.snapshots.get(leaseId)
    if (!snap) {
      return { lastSignalAt: 0, sourceKey: 'task_progress' }
    }
    return snap
  }

  recordSignal(leaseId: string, at: number): void {
    const registry = this.leaseRegistryGetter()
    const lease = registry.get(leaseId)
    if (!lease || lease.released) {
      return
    }
    const current = this.snapshot(leaseId)
    this.snapshots.set(leaseId, {
      ...current,
      lastSignalAt: at,
      sourceKey: lease.livenessSourceKey
    })
  }

  recordPlayback(leaseId: string, state: 'playing' | 'paused' | 'stopped', at: number): void {
    const registry = this.leaseRegistryGetter()
    const lease = registry.get(leaseId)
    if (!lease || lease.released) {
      return
    }
    this.snapshots.set(leaseId, {
      lastSignalAt: at,
      sourceKey: 'player_state',
      lastPlaybackState: state
    })
  }

  evict(leaseId: string): void {
    this.snapshots.delete(leaseId)
  }
}

export interface LeaseRegistryOptions {
  onClusterActivityChanged?: (clusterId: 'analysis_suite' | 'tts_media') => void
  onLeaseExpired?: (lease: LeaseRegistryEntry) => void
  livenessSourceRegistry?: LivenessSourceRegistry
}

/** 引用租约中心 (LeaseRegistry) */
export class LeaseRegistry {
  private readonly leases = new Map<string, LeaseRegistryEntry>()
  readonly livenessSourceRegistry: LivenessSourceRegistry
  private readonly onClusterActivityChangedCb?: (clusterId: 'analysis_suite' | 'tts_media') => void
  private readonly onLeaseExpiredCb?: (lease: LeaseRegistryEntry) => void

  constructor(options?: LeaseRegistryOptions) {
    this.onClusterActivityChangedCb = options?.onClusterActivityChanged
    this.onLeaseExpiredCb = options?.onLeaseExpired
    this.livenessSourceRegistry =
      options?.livenessSourceRegistry ?? new LivenessSourceRegistryImpl(() => this)
  }

  /** 获取单条租约快照条目；不存在时返回 undefined */
  get(leaseId: string): LeaseRegistryEntry | undefined {
    return this.leases.get(leaseId)
  }

  /** 浅拷贝切片，仅含 !released 条目 (reaping 条目仍保留在活跃视图中，直至 release 终态) */
  activeLeases(): LeaseRegistryEntry[] {
    const active: LeaseRegistryEntry[] = []
    for (const lease of this.leases.values()) {
      if (!lease.released) {
        active.push(lease)
      }
    }
    return active
  }

  /** 获取指定集群活跃租约计数 */
  countActive(clusterId: 'analysis_suite' | 'tts_media'): number {
    let count = 0
    for (const lease of this.leases.values()) {
      if (!lease.released && lease.clusterId === clusterId) {
        count++
      }
    }
    return count
  }

  /** 获取指定模块目标活跃租约计数 */
  countActiveByTarget(targetId: string): number {
    let count = 0
    for (const lease of this.leases.values()) {
      if (!lease.released && lease.targetId === targetId) {
        count++
      }
    }
    return count
  }

  /**
   * 申领新在途租约
   */
  acquireLease(req: AcquireLeaseOptions): HibernationLeaseHandle {
    const meta = HIBERNATABLE_TARGET_CATALOG[req.targetId]
    const clusterId: 'analysis_suite' | 'tts_media' =
      req.clusterId ?? meta?.clusterId ?? 'analysis_suite'
    const leaseId = `lease_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
    const now = Date.now()
    const livenessSourceKey = req.livenessSourceKey ?? 'task_progress'

    const prevCount = this.countActive(clusterId)

    const entry: LeaseRegistryEntry = {
      leaseId,
      targetId: req.targetId,
      clusterId,
      grantedAt: now,
      expiresAt: now + LEASE_TTL_MS,
      absoluteDeadlineAt: now + LEASE_ABSOLUTE_MAX_MS,
      rotationCount: 0,
      abortController: new AbortController(),
      livenessSourceKey,
      reaping: false,
      released: false
    }

    this.leases.set(leaseId, entry)
    // 授予时同步 recordSignal 初始化时基锚点，杜绝 lastSignalAt=0 空窗
    this.livenessSourceRegistry.recordSignal(leaseId, now)
    this.armExpiry(leaseId)

    if (prevCount === 0) {
      this.notifyClusterActivity(clusterId)
    }

    return {
      leaseId,
      targetId: req.targetId,
      clusterId,
      release: () => this.release(leaseId)
    }
  }

  /**
   * 长音频与连续任务的无缝租约轮换：
   * 新租约就绪前旧租约绝不提前释放，彻底消除活跃计数归零引发的空闲倒计时误触发空窗
   */
  rotateLease(oldHandle: HibernationLeaseHandle, req: AcquireLeaseOptions): HibernationLeaseHandle {
    const newHandle = this.acquireLease(req)
    oldHandle.release()
    return newHandle
  }

  /**
   * 同步续期（90s 租约心跳窗口更新）
   * 严格锚定末次真实信号 snap.lastSignalAt + LEASE_TTL_MS，禁止加算 now 造成时基漂移
   */
  renew(leaseId: string): boolean {
    const lease = this.leases.get(leaseId)
    if (!lease || lease.released || lease.reaping) {
      return false
    }
    const snap = this.livenessSourceRegistry.snapshot(leaseId)
    // 严格锚定真实信号时基，若无有效信号(0)则保持原始失效时基，杜绝加算 now 漂移
    if (snap.lastSignalAt === 0) {
      return false
    }
    lease.expiresAt = snap.lastSignalAt + LEASE_TTL_MS
    this.armExpiry(leaseId)
    return true
  }

  /**
   * 20 分钟单次租约绝对硬截止轮换 (Deadline Rotation)：
   * 仅当客户端活跃度新鲜时允许 Deadline Rotation（保持 leaseId 不变，rotationCount += 1）；
   * 心跳源陈旧时立即收回，严禁无限续期
   */
  rotateDeadline(leaseId: string, now: number = Date.now()): boolean {
    const lease = this.leases.get(leaseId)
    if (!lease || lease.released || lease.reaping) {
      return false
    }
    const snap = this.livenessSourceRegistry.snapshot(leaseId)
    if (!isFresh(lease, snap, now)) {
      return false
    }

    lease.absoluteDeadlineAt = now + LEASE_ABSOLUTE_MAX_MS
    lease.rotationCount += 1
    const anchor = snap.lastSignalAt > 0 ? snap.lastSignalAt : now
    lease.expiresAt = anchor + LEASE_TTL_MS
    this.armExpiry(leaseId)
    return true
  }

  /**
   * release(leaseId) 同步执行序列（严格顺序，禁止乱序，全系统唯一的正常空闲倒计时武装入口）：
   * 1. 若已 released → 幂等 no-op 返回
   * 2. 置 lease.released = true, terminalized = true, reaping = false
   * 3. 清理定时器：clearTimeout(expiryTimer), clearTimeout(reapRetryTimer) 并置 undefined
   * 4. 重置 lease.reapRetryStreak = undefined
   * 5. 调用 livenessSourceRegistry.evict(leaseId) 清理孤儿快照
   * 6. 同步调用 onClusterActivityChanged(lease.clusterId)
   */
  release(leaseId: string): void {
    const lease = this.leases.get(leaseId)
    if (!lease || lease.released) {
      return
    }

    lease.released = true
    lease.terminalized = true
    lease.reaping = false

    if (lease.expiryTimer) {
      clearTimeout(lease.expiryTimer)
      lease.expiryTimer = undefined
    }
    if (lease.reapRetryTimer) {
      clearTimeout(lease.reapRetryTimer)
      lease.reapRetryTimer = undefined
    }
    lease.reapRetryStreak = undefined

    this.livenessSourceRegistry.evict(leaseId)
    this.notifyClusterActivity(lease.clusterId)
  }

  /**
   * 强制终态收敛原语：执行同上 2~5 步骤，跳过回执确认；
   * opts?.notifyActivity === false 时跳过第 6 步 onClusterActivityChanged；
   * 返回是否实际发生跃迁
   */
  forceRelease(leaseId: string, opts?: { notifyActivity?: boolean }): boolean {
    const lease = this.leases.get(leaseId)
    if (!lease || lease.released) {
      return false
    }

    lease.released = true
    lease.terminalized = true
    lease.reaping = false

    if (lease.expiryTimer) {
      clearTimeout(lease.expiryTimer)
      lease.expiryTimer = undefined
    }
    if (lease.reapRetryTimer) {
      clearTimeout(lease.reapRetryTimer)
      lease.reapRetryTimer = undefined
    }
    lease.reapRetryStreak = undefined

    this.livenessSourceRegistry.evict(leaseId)

    if (opts?.notifyActivity !== false) {
      this.notifyClusterActivity(lease.clusterId)
    }

    return true
  }

  /**
   * 批量强制释放指定引擎下所有 !released 条目（供停机确认后调用）；返回被清理的 leaseId 列表；
   * opts 语义与 forceRelease 完全一致
   */
  forceReleaseByTarget(targetId: string, opts?: { notifyActivity?: boolean }): string[] {
    const affectedClusters = new Set<'analysis_suite' | 'tts_media'>()
    const releasedIds: string[] = []

    for (const lease of this.leases.values()) {
      if (!lease.released && lease.targetId === targetId) {
        lease.released = true
        lease.terminalized = true
        lease.reaping = false

        if (lease.expiryTimer) {
          clearTimeout(lease.expiryTimer)
          lease.expiryTimer = undefined
        }
        if (lease.reapRetryTimer) {
          clearTimeout(lease.reapRetryTimer)
          lease.reapRetryTimer = undefined
        }
        lease.reapRetryStreak = undefined

        this.livenessSourceRegistry.evict(lease.leaseId)
        affectedClusters.add(lease.clusterId)
        releasedIds.push(lease.leaseId)
      }
    }

    if (opts?.notifyActivity !== false) {
      for (const clusterId of affectedClusters) {
        this.notifyClusterActivity(clusterId)
      }
    }

    return releasedIds
  }

  /** 调度过期定时器 */
  armExpiry(leaseId: string): void {
    const lease = this.leases.get(leaseId)
    if (!lease || lease.released || lease.terminalized || lease.reaping) {
      return
    }

    if (lease.expiryTimer) {
      clearTimeout(lease.expiryTimer)
      lease.expiryTimer = undefined
    }

    const now = Date.now()
    const targetExpiry = Math.min(lease.expiresAt, lease.absoluteDeadlineAt)
    const delayMs = Math.max(0, targetExpiry - now)

    lease.expiryTimer = setTimeout(() => {
      lease.expiryTimer = undefined
      this.handleExpiry(leaseId)
    }, delayMs)

    if (lease.expiryTimer && typeof lease.expiryTimer.unref === 'function') {
      lease.expiryTimer.unref()
    }
  }

  private handleExpiry(leaseId: string): void {
    const lease = this.leases.get(leaseId)
    if (!lease || lease.released || lease.terminalized || lease.reaping) {
      return
    }

    const now = Date.now()
    const snap = this.livenessSourceRegistry.snapshot(leaseId)

    // 1. 若触达 20 分钟硬截止：尝试 Deadline Rotation (仅当活跃度新鲜时允许)
    if (now >= lease.absoluteDeadlineAt) {
      if (isFresh(lease, snap, now)) {
        this.rotateDeadline(leaseId, now)
        return
      }
      this.triggerExpiration(lease)
      return
    }

    // 2. 正常过期检查：必须通过 isFresh 判定 (防止 paused 播放器租约因历史信号误复活)
    if (isFresh(lease, snap, now)) {
      lease.expiresAt = snap.lastSignalAt + LEASE_TTL_MS
      if (lease.expiresAt > now) {
        this.armExpiry(leaseId)
        return
      }
    }

    // 3. 确实超时或已非新鲜活跃状态
    this.triggerExpiration(lease)
  }

  private triggerExpiration(lease: LeaseRegistryEntry): void {
    if (this.onLeaseExpiredCb) {
      this.onLeaseExpiredCb(lease)
    } else {
      // 缺省保底兜底：释放租约
      this.release(lease.leaseId)
    }
  }

  private notifyClusterActivity(clusterId: 'analysis_suite' | 'tts_media'): void {
    try {
      this.onClusterActivityChangedCb?.(clusterId)
    } catch {
      // 容错隔离
    }
  }

  /** 清空所有租约条目与定时器 (用于单测或退出清理) */
  destroy(): void {
    for (const lease of this.leases.values()) {
      if (lease.expiryTimer) clearTimeout(lease.expiryTimer)
      if (lease.reapRetryTimer) clearTimeout(lease.reapRetryTimer)
      this.livenessSourceRegistry.evict(lease.leaseId)
    }
    this.leases.clear()
  }
}

/** 是否存在新鲜的有效播放租约：以 isFresh 为唯一事实源，播放器崩溃/心跳中断自动失真 */
export function hasFreshPlayingLease(
  leaseRegistry: LeaseRegistry,
  clusterId: 'analysis_suite' | 'tts_media',
  now: number = Date.now()
): boolean {
  return leaseRegistry.activeLeases().some(lease => {
    if (lease.clusterId !== clusterId || lease.released || lease.reaping) {
      return false
    }
    const snap = leaseRegistry.livenessSourceRegistry.snapshot(lease.leaseId)
    return isFresh(lease, snap, now)
  })
}
