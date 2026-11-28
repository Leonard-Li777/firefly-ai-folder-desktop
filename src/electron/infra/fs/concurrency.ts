/**
 * 并发限流与批量映射（infra/fs）
 *
 * 用途：把「for 循环里逐个 await 同步调用」换成「受限并发 + 按原索引回填」，
 * 既不让主进程被逐个系统调用串行拖住，也不至于一次性压满句柄。
 *
 * 契约（见 ADR-0075 / spec INV-3）：
 * - `mapLimit` 的输出**永远与输入同序**：乱序完成的任务按原索引回填，禁止让完成顺序泄漏到结果里；
 * - 任务失败时**停止派发新任务**，等在途任务收敛后再抛出首个错误，避免「已经边走边抛、磁盘写还在飞」；
 * - 并发上限在 M0 只有全局限流器，按盘符/卷分池等内容等基准数据证明需要后再做（KISS）。
 */

/** 默认并发上限：与 spec §5.1「单全局限流器默认 32」一致 */
export const DEFAULT_CONCURRENCY = 32

/** 限流器：把任意异步任务投递进固定大小的并发池 */
export type Limiter = <T>(task: () => Promise<T>) => Promise<T>

/** `mapLimit` 可选配置 */
export interface MapLimitOptions {
  /** 取消信号：触发后立即停止派发新索引，待在途任务收敛后抛出标准 AbortError */
  signal?: AbortSignal
}

/** 构造标准 AbortError（保证 `err.name === 'AbortError'` 且为 `Error` 实例） */
function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error && reason.name === 'AbortError') {
    return reason
  }
  const message =
    typeof reason === 'string' && reason.length > 0 ? reason : 'The operation was aborted'
  const error = new Error(message, reason !== undefined ? { cause: reason } : undefined)
  error.name = 'AbortError'
  return error
}

/**
 * 归一化并发上限：非法值（NaN / Infinity / < 1）一律收敛到 1。
 *
 * 之所以不抛错：并发上限常来自配置或 M0 数据，越界时「退化为串行」比「整条链路崩掉」更符合运维预期；
 * 但绝不允许静默变成 0（那会让 `mapLimit` 永远不派发任务而挂死）。
 */
function normalizeLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 1
  const floored = Math.floor(limit)
  return floored >= 1 ? floored : 1
}

/**
 * 按固定并发上限映射数组，结果按**原索引**回填。
 *
 * @param items 输入集合（只读，不会被修改）
 * @param limit 并发上限（非法值收敛为 1）
 * @param mapper 逐项异步映射，入参含原索引，便于调用方自行携带上下文
 * @param options 可选配置（支持 `AbortSignal` 中断派发并等待在途任务收敛）
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
  options?: MapLimitOptions
): Promise<R[]> {
  const signal = options?.signal
  if (signal?.aborted) {
    throw createAbortError(signal.reason)
  }

  const total = items.length
  if (total === 0) return []

  const effectiveLimit = normalizeLimit(limit)
  const results = new Array<R>(total)
  let nextIndex = 0
  let hasError = false
  let firstError: unknown

  const worker = async (): Promise<void> => {
    while (true) {
      if (hasError || signal?.aborted) return
      const index = nextIndex
      if (index >= total) return
      nextIndex = index + 1
      try {
        results[index] = await mapper(items[index], index)
      } catch (error) {
        if (!hasError) {
          hasError = true
          firstError = error
        }
        return
      }
    }
  }

  const workerCount = Math.min(effectiveLimit, total)
  // 等全部 worker 收敛（含失败/取消后仍在途的任务），保证「抛错时磁盘操作已结束」再上浮
  await Promise.all(Array.from({ length: workerCount }, () => worker()))

  if (signal?.aborted) {
    throw createAbortError(signal.reason)
  }
  if (hasError) throw firstError
  return results
}

/**
 * 创建可复用的并发限流器（FIFO）。
 *
 * 与一次性 `mapLimit` 的区别：任务可以持续投递（例如文件监听事件流），限流器自身持有队列与计数。
 */
export function createLimiter(limit: number = DEFAULT_CONCURRENCY): Limiter {
  const effectiveLimit = normalizeLimit(limit)
  let activeCount = 0
  const queue: Array<() => void> = []

  const drain = (): void => {
    if (activeCount >= effectiveLimit) return
    const release = queue.shift()
    if (!release) return
    release()
  }

  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const start = (): void => {
        activeCount += 1
        // 同步异常也要归还配额，否则一次抛错就会永久吃掉一个并发位
        Promise.resolve()
          .then(task)
          .then(
            value => {
              activeCount -= 1
              drain()
              resolve(value)
            },
            error => {
              activeCount -= 1
              drain()
              reject(error)
            }
          )
      }

      if (activeCount < effectiveLimit) {
        start()
      } else {
        queue.push(start)
      }
    })
}
