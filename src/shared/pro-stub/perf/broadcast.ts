/**
 * 主进程 → 渲染进程统一广播与合帧调度 —— 开源侧直通存根（`@pro/perf/broadcast`）
 *
 * 【存根对称性（D-07）】本文件与 `pro/src/perf/broadcast.ts` 必须导出**完全相同**的
 *   运行时符号集合与签名（含 `BROADCAST_IMPL` 标识）。
 *
 * 【直通契约（D-07 铁律）】开源侧不做任何合帧治理：
 *   - `broadcastToRenderers` 直通逐窗 `send`（统一存活校验与 Pro 逐位一致，这是安全契约不是优化）；
 *   - `createBroadcastCoalescer.schedule` 直通「每次入队立即发送」（迁移前逐事件推送行为），
 *     无 leading/trailing 窗口、无合并；`flush` / `flushAll` 无待发帧可冲刷。
 *   严禁空实现吞掉推送（no-op 会让开源版界面永不更新）。
 *
 * 【禁止静默降级】存根生效时在首次入队时 `warn` 一次，显式说明当前走直通路径。
 */

/** 实现标识：开源直通存根为 `'stub'`（供解析单测与运行期观测） */
export const BROADCAST_IMPL = 'stub' as const

/** 合帧窗口默认 150ms（存根不合帧，仅保持常量对称） */
export const DEFAULT_BROADCAST_WINDOW_MS = 150

/** 无工作区目录项统一归入 'global' 桶（与 Pro 实现同源常量） */
export const GLOBAL_BROADCAST_BUCKET = 'global'

const LOG_PREFIX = '[Broadcast]'

export interface BroadcastWindowLike {
  isDestroyed(): boolean
  webContents: {
    isDestroyed(): boolean
    send(channel: string, ...args: unknown[]): void
  }
}

export interface BroadcastLoggerLike {
  warn(message: string, error?: unknown): void
}

const fallbackLogger: BroadcastLoggerLike = {
  warn: (message, error) => {
    console.warn(message, error)
  }
}

/**
 * 统一广播入口（与 Pro 实现逐位一致的直通逐窗 send）：
 * 存活校验 + 单窗异常 warn 后继续，返回实际发送成功的窗口数。
 */
export function broadcastToRenderers(
  windows: Iterable<BroadcastWindowLike>,
  channel: string,
  ...args: unknown[]
): number {
  let sent = 0
  for (const win of windows) {
    try {
      if (win.isDestroyed() || win.webContents.isDestroyed()) continue
      win.webContents.send(channel, ...args)
      sent += 1
    } catch (error) {
      fallbackLogger.warn(`${LOG_PREFIX} 窗口发送失败（跳过该窗口）: ${channel}`, error)
    }
  }
  return sent
}

export interface BroadcastBucket {
  wsId?: string | null
  kind: string
}

export interface BroadcastCoalescerOptions {
  send: (channel: string, payload: unknown) => void
  windowMs?: number
  logger?: BroadcastLoggerLike
}

export interface BroadcastCoalescer {
  schedule(bucket: BroadcastBucket, channel: string, buildPayload: (seq: number) => unknown): void
  flush(bucket: BroadcastBucket): void
  flushAll(): void
  pendingCount(): number
  dispose(): void
}

function bucketKey(bucket: BroadcastBucket): string {
  return `${bucket.wsId ?? GLOBAL_BROADCAST_BUCKET}::${bucket.kind}`
}

export function createBroadcastCoalescer(options: BroadcastCoalescerOptions): BroadcastCoalescer {
  const logger = options.logger ?? fallbackLogger
  const seqByBucket = new Map<string, number>()
  let disposed = false
  let directPathWarned = false

  return {
    schedule(bucket, channel, buildPayload) {
      if (disposed) return
      if (!directPathWarned) {
        directPathWarned = true
        logger.warn(`${LOG_PREFIX} 当前走直通路径（逐事件立即发送），未启用合帧调度`)
      }
      const key = bucketKey(bucket)
      const seq = (seqByBucket.get(key) ?? 0) + 1
      seqByBucket.set(key, seq)
      try {
        // 直通：入队即发送，载荷构建一次（与 Pro 发送时刻单次构建契约一致）
        options.send(channel, buildPayload(seq))
      } catch (error) {
        logger.warn(`${LOG_PREFIX} 合帧广播发送失败: ${channel}`, error)
      }
    },
    flush(_bucket) {
      // 直通路径无待发帧
    },
    flushAll() {
      // 直通路径无待发帧
    },
    pendingCount() {
      return 0
    },
    dispose() {
      disposed = true
      seqByBucket.clear()
    }
  }
}