/**
 * Desktop 视频视觉分析预算降级（visual_skipped_budget）落库与退避重试状态机 (Spec v1.7.3 §2.4.2)
 *
 * 契约：
 * - 识别 Omni Rust 返回的 `degraded: "visual_skipped_budget"` 及细分原因 `degraded_reason`；
 * - 严禁将该类降级结果持久化为「分析完成」(`completed`)；
 * - 仅 `degraded_reason === "pre_elapsed"` 允许最多 2 次退避重试；
 * - `budget_structural`（结构性预算不足）或 `pre_elapsed` 重试超限时，直接标记 `analysis_degraded`，
 *   落库记录 `{ status: 'analysis_degraded', perceive_timeout_sec, asr_est_sec, degraded_reason }`
 *   并输出零工程术语的大白话提示文案。
 */

import { LogCategory, logger } from '@firefly/shared'
import { t } from '@app/languages'
import type { OmniPerceptionResponse } from '../../system/omni-service/types'

export const VIDEO_DEGRADED_MARKER = 'visual_skipped_budget' as const
export type VideoDegradedReason = 'pre_elapsed' | 'budget_structural'

/** `pre_elapsed` 允许的最大退避重试次数（不含首次调用，最多共 3 次尝试） */
export const MAX_PRE_ELAPSED_RETRIES = 2
/** `pre_elapsed` 退避延迟阶梯（毫秒） */
export const PRE_ELAPSED_RETRY_BACKOFF_MS: readonly number[] = [1500, 4000]

export interface VideoDegradedMetadata {
  status: 'analysis_degraded'
  degraded: typeof VIDEO_DEGRADED_MARKER
  perceive_timeout_sec: number | null
  asr_est_sec: number
  degraded_reason: VideoDegradedReason
}

export interface VideoDegradedRecord extends VideoDegradedMetadata {
  userMessage: string
}

export type VideoDegradedDecision =
  | { action: 'retry'; delayMs: number; nextAttempt: number }
  | { action: 'mark_degraded'; status: 'analysis_degraded' }

/**
 * 从 Omni 感知响应中提取视频视觉跳过降级标记。
 * 未知 reason 保守归入 `budget_structural`，防止无意义空耗重试。
 */
export function extractVideoVisualDegradation(
  perception: Pick<OmniPerceptionResponse, 'degraded' | 'degraded_reason'> | null | undefined
): { degraded: typeof VIDEO_DEGRADED_MARKER; degradedReason: VideoDegradedReason } | null {
  if (!perception || perception.degraded !== VIDEO_DEGRADED_MARKER) {
    return null
  }
  const degradedReason: VideoDegradedReason =
    perception.degraded_reason === 'pre_elapsed' ? 'pre_elapsed' : 'budget_structural'
  return {
    degraded: VIDEO_DEGRADED_MARKER,
    degradedReason
  }
}

/**
 * 纯函数决策：收到 `visual_skipped_budget` 后应退避重试还是立即标记 `analysis_degraded`。
 */
export function decideVideoDegradedAction(
  degradedReason: VideoDegradedReason,
  retriesUsed: number
): VideoDegradedDecision {
  if (degradedReason === 'pre_elapsed' && retriesUsed < MAX_PRE_ELAPSED_RETRIES) {
    const delayMs =
      PRE_ELAPSED_RETRY_BACKOFF_MS[retriesUsed] ??
      PRE_ELAPSED_RETRY_BACKOFF_MS[PRE_ELAPSED_RETRY_BACKOFF_MS.length - 1]
    return {
      action: 'retry',
      delayMs,
      nextAttempt: retriesUsed + 1
    }
  }
  return {
    action: 'mark_degraded',
    status: 'analysis_degraded'
  }
}

/**
 * 面向用户的大白话提示文案（严禁包含任何底层工程或算法术语，严格使用静态 t('...') 字面量）。
 */
export function formatVideoDegradedUserMessage(degradedReason: VideoDegradedReason): string {
  if (degradedReason === 'pre_elapsed') {
    return t('本次视频分析前置处理耗时较长，画面识别已暂停，可稍后点击重试')
  }
  return t(
    '当前视频分析时间上限偏短，未能完成画面识别，可在设置中调长分析时间或减少语音识别时长后重试'
  )
}

/**
 * 序列化降级落库元数据（供持久化至 file_video_segments.error_message 与队列诊断载荷）。
 */
export function serializeVideoDegradedMetadata(meta: VideoDegradedMetadata): string {
  return JSON.stringify({
    status: meta.status,
    degraded: meta.degraded,
    perceive_timeout_sec: meta.perceive_timeout_sec,
    asr_est_sec: meta.asr_est_sec,
    degraded_reason: meta.degraded_reason
  })
}

export interface RunVideoPerceiveWithRetryOptions {
  filePath: string
  perceiveTimeoutSec?: number | null
  asrEstSec?: number
  signal?: AbortSignal
  /** 仅用于单测注入自定义等待函数 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export interface RunVideoPerceiveWithRetryResult<T> {
  result: T
  degradedRecord: VideoDegradedRecord | null
  retriesUsed: number
  aborted: boolean
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 带降级判定与有界退避重试的视频感知执行包装器：
 * - `pre_elapsed`：按阶梯退避最多重试 2 次；
 * - `budget_structural`：0 次重试，直接落标 `analysis_degraded`；
 * - 任一尝试恢复正常（无 `visual_skipped_budget`）即直接返回正常结果。
 */
export async function runVideoPerceiveWithDegradedRetry<
  T extends { perception?: OmniPerceptionResponse | null }
>(
  perceiveFn: () => Promise<T>,
  options: RunVideoPerceiveWithRetryOptions
): Promise<RunVideoPerceiveWithRetryResult<T>> {
  const sleep = options.sleep ?? defaultSleep
  let retriesUsed = 0

  while (true) {
    const result = await perceiveFn()
    if (options.signal?.aborted) {
      return { result, degradedRecord: null, retriesUsed, aborted: true }
    }

    const degradation = extractVideoVisualDegradation(result?.perception)
    if (!degradation) {
      return { result, degradedRecord: null, retriesUsed, aborted: false }
    }

    const decision = decideVideoDegradedAction(degradation.degradedReason, retriesUsed)
    if (decision.action === 'retry') {
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        `[分析队列] 视频视觉分析因前置耗时触发临时降级 (degraded_reason=pre_elapsed)，${decision.delayMs}ms 后执行第 ${decision.nextAttempt}/${MAX_PRE_ELAPSED_RETRIES} 次退避重试: ${options.filePath}`
      )
      await sleep(decision.delayMs, options.signal)
      if (options.signal?.aborted) {
        return { result, degradedRecord: null, retriesUsed, aborted: true }
      }
      retriesUsed = decision.nextAttempt
      continue
    }

    const degradedRecord: VideoDegradedRecord = {
      status: 'analysis_degraded',
      degraded: VIDEO_DEGRADED_MARKER,
      perceive_timeout_sec:
        typeof options.perceiveTimeoutSec === 'number' &&
        Number.isFinite(options.perceiveTimeoutSec)
          ? options.perceiveTimeoutSec
          : null,
      asr_est_sec:
        typeof options.asrEstSec === 'number' && Number.isFinite(options.asrEstSec)
          ? options.asrEstSec
          : 0,
      degraded_reason: degradation.degradedReason,
      userMessage: formatVideoDegradedUserMessage(degradation.degradedReason)
    }

    logger.warn(
      LogCategory.ANALYSIS_QUEUE,
      `[分析队列] 视频视觉分析标记为 analysis_degraded（严禁写入完成态）: ${serializeVideoDegradedMetadata(degradedRecord)} (${options.filePath})`
    )

    return {
      result,
      degradedRecord,
      retriesUsed,
      aborted: false
    }
  }
}
