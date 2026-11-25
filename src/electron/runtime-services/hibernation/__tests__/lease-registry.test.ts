import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hasFreshPlayingLease, isFresh, LeaseRegistry } from '../lease-registry'
import { LEASE_ABSOLUTE_MAX_MS, LEASE_TTL_MS, LeaseRegistryEntry } from '../types'

describe('LeaseRegistry', () => {
  let registry: LeaseRegistry
  let activityChanges: string[]
  let expiredLeases: LeaseRegistryEntry[]

  beforeEach(() => {
    vi.useFakeTimers()
    activityChanges = []
    expiredLeases = []
    registry = new LeaseRegistry({
      onClusterActivityChanged: clusterId => {
        activityChanges.push(clusterId)
      },
      onLeaseExpired: lease => {
        expiredLeases.push(lease)
      }
    })
  })

  afterEach(() => {
    registry.destroy()
    vi.useRealTimers()
  })

  describe('获取、计数与释放生命周期', () => {
    it('正常获取租约并触发 0 -> 1 活跃跃迁通知', () => {
      const handle = registry.acquireLease({
        targetId: 'pocket-cpu-int8-onnx',
        clusterId: 'analysis_suite'
      })

      expect(handle.leaseId).toBeDefined()
      expect(handle.targetId).toBe('pocket-cpu-int8-onnx')
      expect(handle.clusterId).toBe('analysis_suite')

      expect(registry.countActive('analysis_suite')).toBe(1)
      expect(registry.countActive('tts_media')).toBe(0)
      expect(registry.countActiveByTarget('pocket-cpu-int8-onnx')).toBe(1)
      expect(registry.activeLeases()).toHaveLength(1)

      // 验证 0 -> 1 跃迁触发了回调
      expect(activityChanges).toEqual(['analysis_suite'])

      // 同一集群再次获取，不应再次触发 0 -> 1 跃迁
      const handle2 = registry.acquireLease({
        targetId: 'pocket-cpu-int8-onnx',
        clusterId: 'analysis_suite'
      })
      expect(registry.countActive('analysis_suite')).toBe(2)
      expect(activityChanges).toEqual(['analysis_suite'])

      handle.release()
      handle2.release()
    })

    it('根据 HIBERNATABLE_TARGET_CATALOG 自动推导 clusterId', () => {
      const handle = registry.acquireLease({
        targetId: 'tts-m5-onnx'
      })
      expect(handle.clusterId).toBe('tts_media')
      expect(registry.countActive('tts_media')).toBe(1)
      expect(activityChanges).toEqual(['tts_media'])
      handle.release()
    })

    it('释放租约应幂等，且在计数归零时通知集群变动', () => {
      const handle = registry.acquireLease({
        targetId: 'pocket-cpu-int8-onnx',
        clusterId: 'analysis_suite'
      })
      activityChanges = []

      // 第一次释放
      handle.release()
      expect(registry.countActive('analysis_suite')).toBe(0)
      expect(registry.countActiveByTarget('pocket-cpu-int8-onnx')).toBe(0)
      expect(activityChanges).toEqual(['analysis_suite'])

      // 验证释放终态属性完整性
      const entry = registry.get(handle.leaseId)!
      expect(entry.released).toBe(true)
      expect(entry.terminalized).toBe(true)
      expect(entry.reaping).toBe(false)
      expect(entry.reapRetryStreak).toBeUndefined()
      expect(entry.expiryTimer).toBeUndefined()
      expect(entry.reapRetryTimer).toBeUndefined()

      // 快照被彻底清理 (evict)
      const snap = registry.livenessSourceRegistry.snapshot(handle.leaseId)
      expect(snap.lastSignalAt).toBe(0)

      // 再次释放（幂等 no-op，不再通知）
      handle.release()
      expect(activityChanges).toEqual(['analysis_suite'])
    })

    it('处于 reaping 状态的租约依然计入 activeLeases 与活跃计数', () => {
      const handle = registry.acquireLease({
        targetId: 'pocket-cpu-int8-onnx',
        clusterId: 'analysis_suite'
      })
      const entry = registry.get(handle.leaseId)!

      // 模拟进入异步收割状态
      entry.reaping = true

      // reaping 状态下依然为 !released，必须计入活跃视图
      expect(registry.countActive('analysis_suite')).toBe(1)
      expect(registry.countActiveByTarget('pocket-cpu-int8-onnx')).toBe(1)
      expect(registry.activeLeases()).toContain(entry)

      // reaping 状态下严禁续期或轮换硬截止
      expect(registry.renew(handle.leaseId)).toBe(false)
      expect(registry.rotateDeadline(handle.leaseId, Date.now())).toBe(false)

      handle.release()
      expect(registry.countActive('analysis_suite')).toBe(0)
    })

    it('多模块与群组活跃计数严格隔离', () => {
      const h1 = registry.acquireLease({
        targetId: 'pocket-cpu-int8-onnx',
        clusterId: 'analysis_suite'
      })
      const h2 = registry.acquireLease({
        targetId: 'firefly-ai-engine',
        clusterId: 'analysis_suite'
      })
      const h3 = registry.acquireLease({
        targetId: 'tts-moss-onnx',
        clusterId: 'tts_media'
      })

      expect(registry.countActive('analysis_suite')).toBe(2)
      expect(registry.countActive('tts_media')).toBe(1)
      expect(registry.countActiveByTarget('pocket-cpu-int8-onnx')).toBe(1)
      expect(registry.countActiveByTarget('firefly-ai-engine')).toBe(1)
      expect(registry.countActiveByTarget('tts-moss-onnx')).toBe(1)

      h1.release()
      expect(registry.countActive('analysis_suite')).toBe(1)
      expect(registry.countActive('tts_media')).toBe(1)

      h2.release()
      expect(registry.countActive('analysis_suite')).toBe(0)
      expect(registry.countActive('tts_media')).toBe(1)

      h3.release()
      expect(registry.countActive('tts_media')).toBe(0)
    })
  })

  describe('续期与时基单调性', () => {
    it('renew 必须锚定 livenessSourceRegistry 中真实信号时间戳', () => {
      const handle = registry.acquireLease({
        targetId: 'pocket-cpu-int8-onnx'
      })
      const entry = registry.get(handle.leaseId)!
      const originalExpiresAt = entry.expiresAt

      // 前进 20 秒并上报信号
      vi.advanceTimersByTime(20_000)
      const signalTime = Date.now()
      registry.livenessSourceRegistry.recordSignal(handle.leaseId, signalTime)

      const renewed = registry.renew(handle.leaseId)
      expect(renewed).toBe(true)
      expect(entry.expiresAt).toBe(signalTime + LEASE_TTL_MS)
      expect(entry.expiresAt).toBeGreaterThan(originalExpiresAt)

      handle.release()
      // 已释放租约不能续期
      expect(registry.renew(handle.leaseId)).toBe(false)
    })

    it('已释放租约调用 recordSignal 或 recordPlayback 应静默忽略', () => {
      const handle = registry.acquireLease({
        targetId: 'tts-m5-onnx',
        livenessSourceKey: 'player_state'
      })
      handle.release()

      registry.livenessSourceRegistry.recordSignal(handle.leaseId, Date.now())
      registry.livenessSourceRegistry.recordPlayback(handle.leaseId, 'playing', Date.now())

      const snap = registry.livenessSourceRegistry.snapshot(handle.leaseId)
      expect(snap.lastSignalAt).toBe(0)
    })
  })

  describe('无缝轮换 (Seamless Rotate Lease)', () => {
    it('rotateLease 过程中活跃计数绝不归零，消除空闲倒计时误触发空窗', () => {
      const oldHandle = registry.acquireLease({
        targetId: 'tts-m5-onnx',
        clusterId: 'tts_media'
      })
      expect(registry.countActive('tts_media')).toBe(1)
      activityChanges = []

      // 执行轮换
      const newHandle = registry.rotateLease(oldHandle, {
        targetId: 'tts-m5-onnx',
        clusterId: 'tts_media'
      })

      expect(newHandle.leaseId).not.toBe(oldHandle.leaseId)
      expect(registry.countActive('tts_media')).toBe(1)
      // 在整个轮换过程中，计数由 1 -> 2 -> 1，从未降至 0
      // 验证未触发释放导致的活动变动通知
      expect(registry.get(oldHandle.leaseId)?.released).toBe(true)
      expect(registry.get(newHandle.leaseId)?.released).toBe(false)

      newHandle.release()
      expect(registry.countActive('tts_media')).toBe(0)
    })
  })

  describe('绝对硬截止与 Deadline Rotation', () => {
    it('超过 20 分钟绝对硬截止且活跃度新鲜时，允许 Deadline Rotation', () => {
      const handle = registry.acquireLease({
        targetId: 'pocket-cpu-int8-onnx'
      })
      const entry = registry.get(handle.leaseId)!
      expect(entry.rotationCount).toBe(0)

      // 模拟每 30 秒上报一次心跳并续期，维持租约存活并持续推移至 20 分钟硬截止前夕
      const step = 30_000
      const totalSteps = LEASE_ABSOLUTE_MAX_MS / step
      for (let i = 0; i < totalSteps - 1; i++) {
        vi.advanceTimersByTime(step)
        registry.livenessSourceRegistry.recordSignal(handle.leaseId, Date.now())
        registry.renew(handle.leaseId)
      }

      // 最后步进剩余 30 秒到达 20 分钟硬截止点
      const nowBeforeRotation = Date.now()
      registry.livenessSourceRegistry.recordSignal(handle.leaseId, nowBeforeRotation)
      vi.advanceTimersByTime(step)

      // 定时器触发 handleExpiry，且活跃度新鲜，应自动触发 rotateDeadline
      expect(entry.rotationCount).toBe(1)
      expect(entry.absoluteDeadlineAt).toBeGreaterThan(nowBeforeRotation)
      expect(expiredLeases).toHaveLength(0)

      handle.release()
    })

    it('超过 20 分钟绝对硬截止但心跳源陈旧时，禁止续期并触发过期收回收割', () => {
      const handle = registry.acquireLease({
        targetId: 'pocket-cpu-int8-onnx'
      })
      const entry = registry.get(handle.leaseId)!

      // 模拟心跳在前 18 分钟维持存活
      const step = 30_000
      for (let i = 0; i < 36; i++) {
        // 18 分钟
        vi.advanceTimersByTime(step)
        registry.livenessSourceRegistry.recordSignal(handle.leaseId, Date.now())
        registry.renew(handle.leaseId)
      }

      // 强行把 expiresAt 延长到硬截止点之后，模拟触达硬截止时心跳已停止（超过 90s 无新心跳）
      entry.expiresAt = entry.absoluteDeadlineAt + 10_000
      registry.armExpiry(handle.leaseId)

      // 推进时间跨过 20 分钟硬截止点（此时距离上次心跳已有 2 分钟 > 90s，已陈旧）
      vi.advanceTimersByTime(2 * 60_000 + 10_000)

      // 定时器触发，因陈旧拒绝轮换，直接触发过期回调
      expect(entry.rotationCount).toBe(0)
      expect(expiredLeases).toHaveLength(1)
      expect(expiredLeases[0].leaseId).toBe(handle.leaseId)
    })
  })

  describe('强制释放 (forceRelease & forceReleaseByTarget)', () => {
    it('forceReleaseByTarget 批量释放并返回已释放的 leaseId 列表', () => {
      const h1 = registry.acquireLease({
        targetId: 'firefly-ai-engine',
        clusterId: 'analysis_suite'
      })
      const h2 = registry.acquireLease({
        targetId: 'firefly-ai-engine',
        clusterId: 'analysis_suite'
      })
      const h3 = registry.acquireLease({
        targetId: 'tts-m5-onnx',
        clusterId: 'tts_media'
      })

      const released = registry.forceReleaseByTarget('firefly-ai-engine')
      expect(released).toContain(h1.leaseId)
      expect(released).toContain(h2.leaseId)
      expect(released).not.toContain(h3.leaseId)

      expect(registry.countActiveByTarget('firefly-ai-engine')).toBe(0)
      expect(registry.countActive('analysis_suite')).toBe(0)
      expect(registry.countActive('tts_media')).toBe(1)

      h3.release()
    })

    it('forceRelease 支持 opts.notifyActivity = false 静默释放', () => {
      const handle = registry.acquireLease({
        targetId: 'pocket-cpu-int8-onnx',
        clusterId: 'analysis_suite'
      })
      activityChanges = []

      const ok = registry.forceRelease(handle.leaseId, {
        notifyActivity: false
      })
      expect(ok).toBe(true)
      expect(registry.countActive('analysis_suite')).toBe(0)
      expect(activityChanges).toHaveLength(0) // 静默未通知
    })
  })

  describe('活跃度判定函数 isFresh & hasFreshPlayingLease', () => {
    it('task_progress 信号在 90s 内判定为 fresh，超过 90s 判定为 stale', () => {
      const handle = registry.acquireLease({
        targetId: 'pocket-cpu-int8-onnx',
        livenessSourceKey: 'task_progress'
      })
      const entry = registry.get(handle.leaseId)!

      const now = Date.now()
      const freshSnap = {
        lastSignalAt: now - 30_000,
        sourceKey: 'task_progress' as const
      }
      expect(isFresh(entry, freshSnap, now)).toBe(true)

      const staleSnap = {
        lastSignalAt: now - 95_000,
        sourceKey: 'task_progress' as const
      }
      expect(isFresh(entry, staleSnap, now)).toBe(false)

      handle.release()
    })

    it('player_state 必须处于 playing 且在 90s 内才判定为 fresh', () => {
      const handle = registry.acquireLease({
        targetId: 'tts-m5-onnx',
        clusterId: 'tts_media',
        livenessSourceKey: 'player_state'
      })
      const entry = registry.get(handle.leaseId)!
      const now = Date.now()

      // playing 状态且新鲜
      const playingSnap = {
        lastSignalAt: now - 10_000,
        sourceKey: 'player_state' as const,
        lastPlaybackState: 'playing' as const
      }
      expect(isFresh(entry, playingSnap, now)).toBe(true)

      // paused 状态不是 fresh
      const pausedSnap = {
        lastSignalAt: now - 10_000,
        sourceKey: 'player_state' as const,
        lastPlaybackState: 'paused' as const
      }
      expect(isFresh(entry, pausedSnap, now)).toBe(false)

      // stopped 状态不是 fresh
      const stoppedSnap = {
        lastSignalAt: now - 10_000,
        sourceKey: 'player_state' as const,
        lastPlaybackState: 'stopped' as const
      }
      expect(isFresh(entry, stoppedSnap, now)).toBe(false)

      // 获取 player_state 租约瞬间即视为处于 playing 态（消除首帧到达前误判）
      expect(hasFreshPlayingLease(registry, 'tts_media', now)).toBe(true)

      // hasFreshPlayingLease 辅助函数验证
      registry.livenessSourceRegistry.recordPlayback(handle.leaseId, 'playing', now)
      expect(hasFreshPlayingLease(registry, 'tts_media', now)).toBe(true)

      registry.livenessSourceRegistry.recordPlayback(handle.leaseId, 'paused', now)
      expect(hasFreshPlayingLease(registry, 'tts_media', now)).toBe(false)

      handle.release()
    })

    it('播放器 paused 状态在 90s 到期后应自然触发过期收割，不得因历史信号误复活', () => {
      const handle = registry.acquireLease({
        targetId: 'tts-m5-onnx',
        clusterId: 'tts_media',
        livenessSourceKey: 'player_state'
      })

      // 模拟在第 10 秒暂停播放
      vi.advanceTimersByTime(10_000)
      registry.livenessSourceRegistry.recordPlayback(handle.leaseId, 'paused', Date.now())

      // 推进时间跨过 90s TTL
      vi.advanceTimersByTime(LEASE_TTL_MS + 1_000)

      // 定时器触发后，由于处于 paused 状态非 fresh，直接触发过期收割
      expect(expiredLeases).toHaveLength(1)
      expect(expiredLeases[0].leaseId).toBe(handle.leaseId)

      handle.release()
    })
  })
})
