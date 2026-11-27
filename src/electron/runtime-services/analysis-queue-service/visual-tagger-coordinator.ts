/**
 * 视觉打标器 409 状态机对账与队列级 N=3 视觉熔断协调器 (Spec v2.12 §3.3 / Ticket 09)
 *
 * 硬不变量：
 * 1. 409 (`ENGINE_NOT_READY`): `(resourceId, expectedFingerprint)` 单飞 + `1m / 10m / 60m` 短退避 + `90m` 兜底，
 *    先本地同源复验（通过则零联网补写 `.ready.json` + `reload`），仅复验失败且未与 catalog 一致才重下载；
 *    `app_update_needed` 或发布契约缺陷立即终态；
 * 2. 500 (`ASSET_MISSING` / `ASSET_CORRUPT`): 同 `generation` 连续 `N = 3` 次触发队列级视觉熔断（422 `INPUT_REJECTED` 绝不计数），
 *    纯文档/音频任务不受影响正常派发，仅视觉项过滤并联动暂停后台视频补全；
 * 3. `non_ok -> ok` 或指纹变更触发 `generation += 1`，立即清零熔断计数、唤醒主队列与恢复视频补全。
 */

import { getFileCategory, LogCategory, logger } from '@firefly/shared'

export const VISUAL_BREAKER_THRESHOLD = 3
export const RECONCILE_BACKOFF_SCHEDULE_MS = [60_000, 600_000, 3_600_000] as const
export const RECONCILE_MAX_ATTEMPTS = RECONCILE_BACKOFF_SCHEDULE_MS.length
export const RECONCILE_FALLBACK_MAX_SPAN_MS = 90 * 60_000

export type VisualReconcileStepOutcome =
  | { outcome: 'recovered' }
  | { outcome: 'pending_reconcile'; nextRetryAt: number }
  | { outcome: 'terminal'; failureCode: 'needs_plugin_update' | 'needs_app_update' }

interface ReconcileEntryState {
  attempts: number
  nextAllowedAt: number
  inFlightPromise: Promise<VisualReconcileStepOutcome> | null
  terminalFailureCode?: 'needs_plugin_update' | 'needs_app_update'
  lastError?: string
}

export function isVisualMediaExtensionOrPath(filePath?: string | null, extension?: string | null): boolean {
  const probe = extension && extension.trim() ? extension.trim() : filePath || ''
  if (!probe) return false
  const cat = getFileCategory(probe)
  return cat === 'image' || cat === 'video'
}

export function resolveActiveVisualEncoderAndResource(opts?: {
  embeddingProfile?: string | null
  language?: string | null
  encoderIdHint?: number
}): { encoderId: number; resourceId: 'chinese-clip' | 'mobile-clip' | 'embeddinggemma-2-onnx' } {
  if (opts?.encoderIdHint === 2) {
    return { encoderId: 2, resourceId: 'chinese-clip' }
  }
  if (opts?.encoderIdHint === 3) {
    return { encoderId: 3, resourceId: 'mobile-clip' }
  }
  if (opts?.encoderIdHint === 4) {
    return { encoderId: 4, resourceId: 'embeddinggemma-2-onnx' }
  }
  if (opts?.embeddingProfile === 'gemma_unified') {
    return { encoderId: 4, resourceId: 'embeddinggemma-2-onnx' }
  }
  const lang = (opts?.language || 'zh-CN').toLowerCase()
  if (lang.startsWith('zh')) {
    return { encoderId: 2, resourceId: 'chinese-clip' }
  }
  return { encoderId: 3, resourceId: 'mobile-clip' }
}

export class VisualTaggerCoordinator {
  private readonly reconcileStates = new Map<string, ReconcileEntryState>()
  private readonly firstSeen409At = new Map<string, number>()
  private readonly healthyEncoders = new Set<number>()
  private breakerState: {
    generation: number
    consecutiveAssetFailures: number
    tripped: boolean
    trippedEncoderId?: number
  } = {
    generation: 0,
    consecutiveAssetFailures: 0,
    tripped: false
  }

  private readonly threshold: number
  private readonly nowFn: () => number
  private breakerTrippedHooks = new Set<(info: { encoderId: number; generation: number }) => void>()
  private recoveryWakeHooks = new Set<
    (info: { encoderId: number; generation: number; includeNeedsAppUpdate?: boolean }) => void
  >()

  constructor(opts?: { threshold?: number; nowFn?: () => number }) {
    this.threshold = Math.max(1, opts?.threshold ?? VISUAL_BREAKER_THRESHOLD)
    this.nowFn = opts?.nowFn ?? (() => Date.now())
  }

  public onBreakerTripped(cb: (info: { encoderId: number; generation: number }) => void): () => void {
    this.breakerTrippedHooks.add(cb)
    return () => this.breakerTrippedHooks.delete(cb)
  }

  public onRecoveryWake(
    cb: (info: { encoderId: number; generation: number; includeNeedsAppUpdate?: boolean }) => void
  ): () => void {
    this.recoveryWakeHooks.add(cb)
    return () => this.recoveryWakeHooks.delete(cb)
  }

  public notifyBreakerTripped(encoderId: number, generation: number): void {
    for (const cb of this.breakerTrippedHooks) {
      try {
        cb({ encoderId, generation })
      } catch {
        // ignore listener errors
      }
    }
  }

  public notifyRecoveryWake(
    encoderId: number,
    generation: number,
    opts?: { includeNeedsAppUpdate?: boolean }
  ): void {
    for (const cb of this.recoveryWakeHooks) {
      try {
        cb({ encoderId, generation, includeNeedsAppUpdate: opts?.includeNeedsAppUpdate })
      } catch {
        // ignore listener errors
      }
    }
  }

  public isVisualBreakerTripped(): boolean {
    return this.breakerState.tripped
  }

  public getBreakerSnapshot() {
    return { ...this.breakerState, threshold: this.threshold }
  }

  /**
   * 仅 `ASSET_MISSING` / `ASSET_CORRUPT` 调用；422 `INPUT_REJECTED` 与网络瞬态异常严禁调用。
   * 返回 `newlyTripped = true` 时，调用方应暂停视频补全并弹出单条全局提示 `t('AI 标签不可用')`。
   */
  public recordAssetFailureForBreaker(
    encoderId: number,
    generation: number
  ): { tripped: boolean; newlyTripped: boolean; consecutiveCount: number } {
    if (generation !== this.breakerState.generation) {
      this.breakerState = {
        generation,
        consecutiveAssetFailures: 0,
        tripped: false
      }
    }

    const wasTripped = this.breakerState.tripped
    this.breakerState.consecutiveAssetFailures += 1
    if (this.breakerState.consecutiveAssetFailures >= this.threshold) {
      this.breakerState.tripped = true
      this.breakerState.trippedEncoderId = encoderId
    }

    return {
      tripped: this.breakerState.tripped,
      newlyTripped: !wasTripped && this.breakerState.tripped,
      consecutiveCount: this.breakerState.consecutiveAssetFailures
    }
  }

  public recordVisualSuccessForGeneration(generation: number): void {
    if (generation !== this.breakerState.generation) {
      this.breakerState = {
        generation,
        consecutiveAssetFailures: 0,
        tripped: false
      }
      return
    }
    this.breakerState.consecutiveAssetFailures = 0
  }

  public resetBreakerForGeneration(nextGeneration: number): { wasTripped: boolean } {
    const wasTripped = this.breakerState.tripped
    this.breakerState = {
      generation: nextGeneration,
      consecutiveAssetFailures: 0,
      tripped: false
    }
    return { wasTripped }
  }

  public clearReconcileCooldown(resourceId?: string): void {
    if (!resourceId) {
      this.reconcileStates.clear()
      this.firstSeen409At.clear()
      return
    }
    for (const key of Array.from(this.reconcileStates.keys())) {
      if (key.startsWith(`${resourceId}::`)) {
        this.reconcileStates.delete(key)
      }
    }
    for (const key of Array.from(this.firstSeen409At.keys())) {
      if (key.startsWith(`${resourceId}::`)) {
        this.firstSeen409At.delete(key)
      }
    }
  }

  /**
   * 标记指定视觉编码器已恢复健康，清理同槽 409 冷却状态与首次出错计时
   */
  public markVisualTaggerHealthy(encoderId: number): void {
    this.healthyEncoders.add(encoderId)
    const resMap: Record<number, string> = {
      2: 'chinese-clip',
      3: 'mobile-clip',
      4: 'embeddinggemma-2-onnx'
    }
    const resourceId = resMap[encoderId]
    if (resourceId) {
      this.clearReconcileCooldown(resourceId)
    }
  }

  /**
   * 获取当前所有未终态且处于 409 退避冷却中的任务最早可重试时间戳（用于队列休眠防热空转）
   */
  public getNextVisualReconcileRetryAt(): number | null {
    const now = this.nowFn()
    let minNext: number | null = null
    for (const st of this.reconcileStates.values()) {
      if (!st.terminalFailureCode && st.attempts > 0 && st.nextAllowedAt > now) {
        if (minNext === null || st.nextAllowedAt < minNext) {
          minNext = st.nextAllowedAt
        }
      }
    }
    return minNext
  }

  public getReconcileState(resourceId: string, expectedFingerprint: string) {
    return this.reconcileStates.get(`${resourceId}::${expectedFingerprint}`) ?? null
  }

  /**
   * 409 `ENGINE_NOT_READY` 本地优先单飞对账与状态机终态裁决
   */
  public async handleEngineNotReady409(opts: {
    resourceId: string
    expectedFingerprint: string
    reason?: string
    firstSeenAtMs?: number
    localVerifyAndHealFn: () => Promise<{ ok: boolean; diskMatchesCatalog?: boolean; error?: string }>
    downloadAndReconcileFn: () => Promise<{ ok: boolean; error?: string }>
    onTerminalOrRecovered?: (outcome: VisualReconcileStepOutcome) => void
  }): Promise<VisualReconcileStepOutcome> {
    if (opts.reason === 'app_update_needed') {
      const terminal: VisualReconcileStepOutcome = {
        outcome: 'terminal',
        failureCode: 'needs_app_update'
      }
      opts.onTerminalOrRecovered?.(terminal)
      return terminal
    }

    const now = this.nowFn()
    const flightKey = `${opts.resourceId}::${opts.expectedFingerprint}`
    const firstSeenAt =
      typeof opts.firstSeenAtMs === 'number'
        ? opts.firstSeenAtMs
        : (this.firstSeen409At.get(flightKey) ?? now)
    if (!this.firstSeen409At.has(flightKey)) {
      this.firstSeen409At.set(flightKey, firstSeenAt)
    }

    if (now - firstSeenAt >= RECONCILE_FALLBACK_MAX_SPAN_MS) {
      const terminal: VisualReconcileStepOutcome = {
        outcome: 'terminal',
        failureCode: 'needs_plugin_update'
      }
      opts.onTerminalOrRecovered?.(terminal)
      return terminal
    }

    let state = this.reconcileStates.get(flightKey)
    if (!state) {
      state = { attempts: 0, nextAllowedAt: 0, inFlightPromise: null }
      this.reconcileStates.set(flightKey, state)
    }

    if (state.terminalFailureCode) {
      return { outcome: 'terminal', failureCode: state.terminalFailureCode }
    }

    if (state.inFlightPromise) {
      return state.inFlightPromise
    }

    if (state.attempts > 0 && now < state.nextAllowedAt) {
      return { outcome: 'pending_reconcile', nextRetryAt: state.nextAllowedAt }
    }

    if (state.attempts >= RECONCILE_MAX_ATTEMPTS) {
      state.terminalFailureCode = 'needs_plugin_update'
      const terminal: VisualReconcileStepOutcome = {
        outcome: 'terminal',
        failureCode: 'needs_plugin_update'
      }
      opts.onTerminalOrRecovered?.(terminal)
      return terminal
    }

    const flight = (async (): Promise<VisualReconcileStepOutcome> => {
      try {
        // 第一步固定：本地同源复验（通过即零联网补写 .ready.json 并 reload）
        let localRes: { ok: boolean; diskMatchesCatalog?: boolean; error?: string }
        try {
          localRes = await opts.localVerifyAndHealFn()
        } catch (localErr: any) {
          localRes = { ok: false, error: localErr?.message || String(localErr) }
        }
        if (localRes.ok) {
          this.reconcileStates.delete(flightKey)
          this.firstSeen409At.delete(flightKey)
          const recovered: VisualReconcileStepOutcome = { outcome: 'recovered' }
          opts.onTerminalOrRecovered?.(recovered)
          return recovered
        }

        // 若磁盘与 catalog 一致但 Omni 仍判不兼容 ➔ 发布契约缺陷，终止对账直落 failed
        if (localRes.diskMatchesCatalog === true) {
          state!.terminalFailureCode = 'needs_plugin_update'
          state!.lastError = localRes.error || '发布契约不匹配（本地与清单一致但引擎拒绝兼容）'
          logger.error(
            LogCategory.SYSTEM,
            `[VisualTaggerCoordinator] 409 发布契约缺陷终止对账: ${opts.resourceId} (${state!.lastError})`
          )
          const terminal: VisualReconcileStepOutcome = {
            outcome: 'terminal',
            failureCode: 'needs_plugin_update'
          }
          opts.onTerminalOrRecovered?.(terminal)
          return terminal
        }

        // 仅在本地复验未通过时执行与 catalog 不符项下载修复（捕获异常以免跳过 attempts/冷却推进）
        let dlRes: { ok: boolean; error?: string }
        try {
          dlRes = await opts.downloadAndReconcileFn()
        } catch (dlErr: any) {
          dlRes = { ok: false, error: dlErr?.message || String(dlErr) }
        }
        if (dlRes.ok) {
          this.reconcileStates.delete(flightKey)
          this.firstSeen409At.delete(flightKey)
          const recovered: VisualReconcileStepOutcome = { outcome: 'recovered' }
          opts.onTerminalOrRecovered?.(recovered)
          return recovered
        }

        state!.attempts += 1
        state!.lastError = dlRes.error || localRes.error
        if (state!.attempts >= RECONCILE_MAX_ATTEMPTS) {
          state!.terminalFailureCode = 'needs_plugin_update'
          const terminal: VisualReconcileStepOutcome = {
            outcome: 'terminal',
            failureCode: 'needs_plugin_update'
          }
          opts.onTerminalOrRecovered?.(terminal)
          return terminal
        }

        const delayMs =
          RECONCILE_BACKOFF_SCHEDULE_MS[
            Math.min(state!.attempts - 1, RECONCILE_BACKOFF_SCHEDULE_MS.length - 1)
          ]
        state!.nextAllowedAt = this.nowFn() + delayMs
        return { outcome: 'pending_reconcile', nextRetryAt: state!.nextAllowedAt }
      } finally {
        if (state) {
          state.inFlightPromise = null
        }
      }
    })()

    state.inFlightPromise = flight
    return flight
  }
}

export const visualTaggerCoordinator = new VisualTaggerCoordinator()
