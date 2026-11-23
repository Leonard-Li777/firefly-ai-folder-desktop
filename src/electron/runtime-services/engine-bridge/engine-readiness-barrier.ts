/**
 * Tier 2 引擎零轮询 SSE 反应式就绪屏障（纯 TS 模块，零 Electron 依赖）
 *
 * @doc-anchor: docs/specs/ai-inference-proactive-readiness-gating-spec.md#22-零轮询-sse-反应式屏障与-single-flight-统一拉起-enginebridgeservice
 *
 * 单独成文件的原因：`engine-bridge-service.ts` 顶层导入 Electron，
 * 将纯函数状态机与模式判定隔离在本模块，可在 Vitest Node 环境直接用假时钟完成全真值表与时序覆盖。
 */

import type { EngineBridgeSnapshot, Tier2EngineStatus } from './engine-bridge-service/types'

/** 引擎推理目标意图模式 */
export type EngineTargetMode = 'language' | 'embedding'

/** `EngineBridgeService.ensureReady` 入参 */
export interface EnsureReadyOptions {
  mode: EngineTargetMode
  timeoutMs?: number
  signal?: AbortSignal
  force?: boolean
}

/** `EngineBridgeService.ensureReady` / `ensureMode` 统一返回契约 */
export interface EnsureReadyResult {
  ok: boolean
  code?: string
  canDegrade?: boolean
  error?: string
}

/** Single-Flight 共享启动体统一硬超时上限（毫秒），与调用方预算解耦 */
export const SHARED_STARTUP_HARD_TIMEOUT_MS = 120_000

/** 存量 `ensureMode` 向下兼容默认超时（毫秒） */
export const DEFAULT_ENSURE_MODE_TIMEOUT_MS = 45_000

/** kick 后等待进入 starting/ready 的默认应答超时（毫秒） */
export const DEFAULT_KICK_ACK_TIMEOUT_MS = 10_000

/** 观测到 starting 后回落 stopped/stopping 的默认防抖宽限（毫秒） */
export const DEFAULT_STOPPED_DEBOUNCE_MS = 2_000

/**
 * 构造标准 `AbortError`（与 DOMException AbortError 同名，兼容跨包鸭子类型检测）
 */
export function createAbortError(message = 'The operation was aborted'): Error {
  const err = new Error(message)
  err.name = 'AbortError'
  return err
}

/**
 * 判定引擎当前加载的模型是否匹配目标意图模式（'language' | 'embedding'）。
 *
 * 抽取自原 `engine-bridge-service.ts` 内联逻辑：
 * 判断 `(raw.current_model || raw.model || '').toLowerCase()` 是否包含 `wemm` 或 `embedding`。
 */
export function matchesEngineTargetMode(
  raw: Tier2EngineStatus | null | undefined,
  mode: EngineTargetMode
): boolean {
  const currentModel = (raw?.current_model || raw?.model || '').toLowerCase()
  const isCurrentlyEmbedding =
    currentModel.includes('wemm') || currentModel.includes('embedding')
  return mode === 'embedding' ? isCurrentlyEmbedding : !isCurrentlyEmbedding
}

/** `waitForEngineStatusReactive` 参数契约 */
export interface WaitForEngineStatusReactiveParams {
  subscribe: (fn: (snap: EngineBridgeSnapshot) => void) => () => void
  getSnapshot: () => EngineBridgeSnapshot
  isAutoHealing: () => boolean
  isCrashHealExhausted: () => boolean
  mode: EngineTargetMode
  baselineRevision: number
  baselineInstanceId?: string
  timeoutMs: number
  /** 默认 10_000ms：kick 后未进入 starting/ready 且仍 stopped/stopping 时早败 */
  kickAckTimeoutMs?: number
  /** 默认 2_000ms：sawStarting 后回落 stopped/stopping 的防抖宽限 */
  stoppedDebounceMs?: number
  signal?: AbortSignal
}

/** 判断快照是否已满足目标模式就绪条件 */
function isSnapshotReadyForMode(snap: EngineBridgeSnapshot, mode: EngineTargetMode): boolean {
  const status = snap.raw?.status
  return (
    snap.connected === true &&
    (status === 'ready' || status === 'processing') &&
    matchesEngineTargetMode(snap.raw, mode)
  )
}

/**
 * 零轮询 SSE 反应式就绪等待屏障。
 *
 * 实现铁律：
 * 1. 严格先 `subscribe`，后同步检查 `getSnapshot()`，消除检查与订阅间隙丢帧竞态；
 * 2. 宿主重启切换 `instance_id` 时将 `effectiveBaselineRevision` 归零，仅丢弃同实例内 `revision < effectiveBaselineRevision` 的乱序旧帧；
 * 3. `connected && (ready | processing) && matchesEngineTargetMode` 立即 `resolve({ ok: true })`；
 * 4. 追踪 `sawStarting`：
 *    - `kickAckTimeoutMs`（默认 10s）内未进 `starting`/`ready` 且仍 `stopped`/`stopping` 早败 `kick_ack_timeout`；
 *    - `sawStarting` 后回落 `stopped`/`stopping` 启动 `stoppedDebounceMs`（默认 2s）防抖宽限，超时仍未恢复则早败 `process_exited_during_startup`；
 * 5. `(revision > effectiveBaselineRevision && status === 'error' && !isAutoHealing()) || isCrashHealExhausted()` 立即早败 `engine_error`；
 * 6. `signal.aborted` 立即经统一 `cleanup()` 清理并 `reject(AbortError)`；
 * 7. 所有退出路径经单一 `cleanup()` 清理全部定时器、退订回调与 `abort` 监听，零泄漏。
 */
export function waitForEngineStatusReactive(
  params: WaitForEngineStatusReactiveParams
): Promise<EnsureReadyResult> {
  const {
    subscribe,
    getSnapshot,
    isAutoHealing,
    isCrashHealExhausted,
    mode,
    baselineRevision,
    baselineInstanceId,
    timeoutMs,
    kickAckTimeoutMs = DEFAULT_KICK_ACK_TIMEOUT_MS,
    stoppedDebounceMs = DEFAULT_STOPPED_DEBOUNCE_MS,
    signal
  } = params

  if (signal?.aborted) {
    return Promise.reject(createAbortError())
  }

  return new Promise<EnsureReadyResult>((resolve, reject) => {
    let settled = false
    let effectiveBaselineRevision = baselineRevision
    let sawStarting = false

    let mainTimer: ReturnType<typeof setTimeout> | null = null
    let kickAckTimer: ReturnType<typeof setTimeout> | null = null
    let stoppedDebounceTimer: ReturnType<typeof setTimeout> | null = null
    let unsubscribe: (() => void) | null = null

    const clearKickAckTimer = () => {
      if (kickAckTimer !== null) {
        clearTimeout(kickAckTimer)
        kickAckTimer = null
      }
    }

    const clearStoppedDebounceTimer = () => {
      if (stoppedDebounceTimer !== null) {
        clearTimeout(stoppedDebounceTimer)
        stoppedDebounceTimer = null
      }
    }

    const cleanup = () => {
      if (mainTimer !== null) {
        clearTimeout(mainTimer)
        mainTimer = null
      }
      clearKickAckTimer()
      clearStoppedDebounceTimer()
      if (unsubscribe) {
        const unsub = unsubscribe
        unsubscribe = null
        try {
          unsub()
        } catch {
          // 忽略退订回调内部异常，保证清理幂等完成
        }
      }
      if (signal) {
        signal.removeEventListener('abort', onAbort)
      }
    }

    const finishResolve = (result: EnsureReadyResult) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }

    const finishReject = (err: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }

    const onAbort = () => {
      finishReject(createAbortError())
    }

    const evaluate = (snap: EngineBridgeSnapshot) => {
      if (settled) return

      // 崩溃自愈配额已耗尽：直接早败
      if (isCrashHealExhausted()) {
        finishResolve({
          ok: false,
          code: 'engine_error',
          error: '引擎崩溃自愈次数已耗尽'
        })
        return
      }

      const raw = snap.raw
      const currentInstanceId =
        typeof raw?.instance_id === 'string' && raw.instance_id.length > 0
          ? raw.instance_id
          : undefined

      // 宿主重启切换新实例时归零有效基线版本（对齐 EngineBridgeService 重启归零语义）
      if (currentInstanceId && baselineInstanceId && currentInstanceId !== baselineInstanceId) {
        effectiveBaselineRevision = 0
      }

      const rev =
        typeof raw?.revision === 'number' && Number.isFinite(raw.revision) ? raw.revision : 0

      // 仅丢弃同实例内严格落后于有效基线的乱序陈旧帧
      if (rev > 0 && rev < effectiveBaselineRevision) {
        return
      }

      // 就绪判定
      if (isSnapshotReadyForMode(snap, mode)) {
        finishResolve({ ok: true })
        return
      }

      const status = raw?.status

      // 观测到进入 starting：记录标志并撤销挂起的 kick 应答与 stopped 防抖定时器
      if (status === 'starting') {
        sawStarting = true
        clearKickAckTimer()
        clearStoppedDebounceTimer()
        return
      }

      // 新版本 error 且非自愈进行中：立即早败
      if (status === 'error' && rev > effectiveBaselineRevision && !isAutoHealing()) {
        const errMsg = raw?.last_error || raw?.error || '引擎服务运行报错'
        finishResolve({
          ok: false,
          code: 'engine_error',
          error: errMsg
        })
        return
      }

      // 已观测到 starting 后回落 stopped/stopping：启动 2s 防抖宽限，避免误杀宿主内部重试序列
      if (sawStarting && (status === 'stopped' || status === 'stopping')) {
        if (stoppedDebounceTimer === null) {
          stoppedDebounceTimer = setTimeout(() => {
            stoppedDebounceTimer = null
            if (settled) return
            const latest = getSnapshot()
            if (isSnapshotReadyForMode(latest, mode)) {
              finishResolve({ ok: true })
              return
            }
            if (latest.raw?.status === 'starting') {
              return
            }
            finishResolve({
              ok: false,
              code: 'process_exited_during_startup',
              error: '引擎推理子进程在启动过程中退出'
            })
          }, Math.max(0, stoppedDebounceMs))
        }
      }
    }

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true })
    }

    // 铁律：先 subscribe，再立即 inspect getSnapshot()
    unsubscribe = subscribe(evaluate)
    if (settled) {
      cleanup()
      return
    }
    evaluate(getSnapshot())
    if (settled) {
      cleanup()
      return
    }

    // kick 应答超时：未观测到 starting/ready 且仍停留在 stopped/stopping 时早败
    if (!sawStarting && kickAckTimeoutMs > 0) {
      kickAckTimer = setTimeout(() => {
        kickAckTimer = null
        if (settled || sawStarting) return
        const latest = getSnapshot()
        if (isSnapshotReadyForMode(latest, mode)) {
          finishResolve({ ok: true })
          return
        }
        const latestStatus = latest.raw?.status
        if (latestStatus === 'starting') {
          sawStarting = true
          return
        }
        if (latestStatus === 'stopped' || latestStatus === 'stopping' || !latestStatus) {
          finishResolve({
            ok: false,
            code: 'kick_ack_timeout',
            error: `引擎未在 ${Math.round(kickAckTimeoutMs / 1000)}s 内响应启动指令`
          })
        }
      }, kickAckTimeoutMs)
    }

    // 主超时兜底
    const safeTimeoutMs = Math.max(0, timeoutMs)
    mainTimer = setTimeout(() => {
      mainTimer = null
      if (settled) return
      const timeoutMsg = `等待引擎切换至 ${
        mode === 'embedding' ? 'WeMM 嵌入' : '主语言'
      } 模型就绪超时（${Math.round(safeTimeoutMs / 1000)}s）`
      finishResolve({
        ok: false,
        code: 'timeout',
        error: timeoutMsg
      })
    }, safeTimeoutMs)
  })
}
