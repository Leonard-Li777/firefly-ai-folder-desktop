import { LogCategory, logger } from '@firefly/shared'

/**
 * 等待 CPU 提取阶段就绪的上限。
 * 工单 B1/B5：跨模块共享（analysis-queue-service.ts 用于 runParallel 超时控制），
 * 故必须 export，避免 import undefined 导致运行期超时判断失效。
 */
export const STAGE2_WAIT_TIMEOUT_MS = 30 * 60 * 1000

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
  private resolvers = new Map<number, () => void>()
  private completedSet = new Set<number>()

  notify(itemId: number) {
    this.completedSet.add(itemId)
    const resolve = this.resolvers.get(itemId)
    if (resolve) {
      resolve()
      this.resolvers.delete(itemId)
    }
  }

  waitForStage2(
    itemId: number,
    checkStage: () => boolean,
    signal?: AbortSignal,
    timeoutMs: number = STAGE2_WAIT_TIMEOUT_MS
  ): Promise<void> {
    if (this.completedSet.has(itemId)) {
      return Promise.resolve()
    }
    let readyNow = false
    try {
      readyNow = checkStage()
    } catch (e) {
      // 严禁静默降级：checkStage 抛异常须上报，否则就绪判定被吞、GPU 消费者空等至超时
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        `[StageNotifier] checkStage 前置判定异常: itemId=${itemId}`,
        e
      )
      readyNow = false
    }
    if (readyNow) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
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
        reject(new Error('Aborted'))
      }

      if (signal?.aborted) {
        return onAbort()
      }
      signal?.addEventListener('abort', onAbort)

      timer = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        let ready = false
        try {
          ready = checkStage()
        } catch (e) {
          // 严禁静默降级：超时边界最后一次就绪复核的异常须上报
          logger.warn(
            LogCategory.ANALYSIS_QUEUE,
            `[StageNotifier] 超时复核 checkStage 异常: itemId=${itemId}`,
            e
          )
          ready = false
        }
        if (ready) {
          resolve()
          return
        }
        reject(new Stage2TimeoutError(itemId, timeoutMs))
      }, timeoutMs)
      if (timer.unref) timer.unref()

      this.resolvers.set(itemId, () => {
        if (settled) return
        settled = true
        cleanup()
        resolve()
      })
    })
  }
}
