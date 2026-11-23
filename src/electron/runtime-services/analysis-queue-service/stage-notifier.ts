import { LogCategory, logger } from '@firefly/shared'
import type { CpuPhaseOutcome } from './file-processor'

/**
 * 等待 CPU 提取阶段就绪的上限。
 * 工单 B1/B5：跨模块共享（analysis-queue-service.ts 用于 runParallel 超时控制），
 * 故必须 export，避免 import undefined 导致运行期超时判断失效。
 */
export const STAGE2_WAIT_TIMEOUT_MS = 30 * 60 * 1000

/** 兼容未显式传入 outcome 的旧调用方的默认推进结果 */
const DEFAULT_PROCEED_OUTCOME: CpuPhaseOutcome = {
  outcome: 'proceed',
  fingerprint: '',
  cpuSkipped: false
}

/** CPU 提取阶段等待超时 */
export class Stage2TimeoutError extends Error {
  constructor(
    readonly itemId: number,
    readonly timeoutMs: number
  ) {
    super(`等待 CPU 提取阶段超时（${Math.round(timeoutMs / 60000)} 分钟）: itemId=${itemId}`)
    this.name = 'Stage2TimeoutError'
  }
}

export class StageNotifier {
  private resolvers = new Map<number, (outcome: CpuPhaseOutcome) => void>()
  private completedOutcomes = new Map<number, CpuPhaseOutcome>()

  notify(itemId: number, outcome: CpuPhaseOutcome = DEFAULT_PROCEED_OUTCOME) {
    this.completedOutcomes.set(itemId, outcome)
    const resolve = this.resolvers.get(itemId)
    if (resolve) {
      resolve(outcome)
      this.resolvers.delete(itemId)
    }
  }

  private resolveCheckResult(result: boolean | CpuPhaseOutcome): CpuPhaseOutcome | null {
    if (typeof result === 'object' && result !== null) {
      return result
    }
    return result ? DEFAULT_PROCEED_OUTCOME : null
  }

  waitForStage2(
    itemId: number,
    checkStage: () => boolean | CpuPhaseOutcome,
    signal?: AbortSignal,
    timeoutMs: number = STAGE2_WAIT_TIMEOUT_MS
  ): Promise<CpuPhaseOutcome> {
    const existingOutcome = this.completedOutcomes.get(itemId)
    if (existingOutcome) {
      return Promise.resolve(existingOutcome)
    }
    let readyOutcome: CpuPhaseOutcome | null = null
    try {
      readyOutcome = this.resolveCheckResult(checkStage())
    } catch (e) {
      // 严禁静默降级：checkStage 抛异常须上报，否则就绪判定被吞、GPU 消费者空等至超时
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        `[StageNotifier] checkStage 前置判定异常: itemId=${itemId}`,
        e
      )
      readyOutcome = null
    }
    if (readyOutcome) {
      return Promise.resolve(readyOutcome)
    }
    return new Promise<CpuPhaseOutcome>((resolve, reject) => {
      let settled = false
      let timer: NodeJS.Timeout | null = null

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        this.resolvers.delete(itemId)
        signal?.removeEventListener('abort', onAbort)
      }

      const onAbort = () => {
        if (settled) return
        settled = true
        cleanup()
        const err = new Error('Aborted')
        err.name = 'AbortError'
        reject(err)
      }

      if (signal?.aborted) {
        return onAbort()
      }
      signal?.addEventListener('abort', onAbort)

      timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        let outcomeAtTimeout: CpuPhaseOutcome | null = null
        try {
          outcomeAtTimeout = this.resolveCheckResult(checkStage())
        } catch (e) {
          // 严禁静默降级：超时边界最后一次就绪复核的异常须上报
          logger.warn(
            LogCategory.ANALYSIS_QUEUE,
            `[StageNotifier] 超时复核 checkStage 异常: itemId=${itemId}`,
            e
          )
          outcomeAtTimeout = null
        }
        if (outcomeAtTimeout) {
          resolve(outcomeAtTimeout)
          return
        }
        reject(new Stage2TimeoutError(itemId, timeoutMs))
      }, timeoutMs)
      if (timer.unref) timer.unref()

      this.resolvers.set(itemId, (outcome: CpuPhaseOutcome) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(outcome)
      })
    })
  }
}
