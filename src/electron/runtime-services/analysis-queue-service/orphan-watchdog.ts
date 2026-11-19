import { LogCategory, logger } from '@firefly/shared'
import { databaseService } from '../database/database-service'

/** 孤儿判定阈值：认领后超过此时长仍 analyzing 且无活动即判孤儿 */
export const ORPHAN_STALE_THRESHOLD_MS = 10 * 60 * 1000
/** watchdog 扫描周期 */
const ORPHAN_SCAN_INTERVAL_MS = 60 * 1000

/**
 * 解析 SQLite `CURRENT_TIMESTAMP`（空格分隔的 UTC 无时区后缀串）或 ISO 8601 时间戳为 UTC 毫秒。
 */
export function parseSqliteTimestampMs(raw: string): number {
  if (!raw || typeof raw !== 'string') return NaN
  const trimmed = raw.trim()
  if (!trimmed) return NaN
  const isoLike = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T')
  const hasZone = /Z$|[+-]\d{2}:?\d{2}$/i.test(isoLike)
  return Date.parse(hasZone ? isoLike : `${isoLike}Z`)
}

/**
 * 工单 B6 · 孤儿分析队列监视器。
 *
 * 主进程定期扫描 `analysis_queue WHERE status='analyzing' AND claimed_at < now()-阈值`，
 * 将跨进程/重启遗留且非本进程活跃项的任务置回 `failed (error='orphaned_reclaimed')` 并复位待重扫。
 */
export class OrphanWatchdog {
  private timer: NodeJS.Timeout | null = null

  constructor(
    private isItemActive: (itemId: number) => boolean,
    private onReclaimed: (orphanedIds: number[]) => void
  ) {}

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      // 让路给事件循环，避免与主分析链路争抢
      setImmediate(() => this.reclaimOrphanedQueueRows())
    }, ORPHAN_SCAN_INTERVAL_MS)
    if (this.timer.unref) this.timer.unref()
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  reclaimOrphanedQueueRows(): void {
    const db = databaseService.db
    if (!db) return
    try {
      const cutoffMs = Date.now() - ORPHAN_STALE_THRESHOLD_MS
      const rawRows = db
        .prepare(
          `SELECT id, item_id, item_type, claimed_at FROM analysis_queue
           WHERE status = 'analyzing'
             AND claimed_at IS NOT NULL`
        )
        .all() as Array<{
        id: number
        item_id: number
        item_type?: string
        claimed_at: string
      }>
      const staleRows = rawRows.filter(r => {
        const claimedMs = parseSqliteTimestampMs(r.claimed_at)
        return Number.isFinite(claimedMs) && claimedMs < cutoffMs
      })

      const orphans = staleRows.filter(r => !this.isItemActive(r.id))
      if (orphans.length === 0) return

      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        `[孤儿 watchdog] 回收 ${orphans.length} 个孤儿 analyzing 行`,
        { ids: orphans.map(r => r.id) }
      )

      const reclaimedIds: number[] = []
      const tx = db.transaction(() => {
        for (const row of orphans) {
          const updateRes = db
            .prepare(
              `UPDATE analysis_queue
               SET status = 'failed', error = 'orphaned_reclaimed',
                   end_time = CURRENT_TIMESTAMP, claimed_at = NULL,
                   updated_at = CURRENT_TIMESTAMP
               WHERE id = ? AND status = 'analyzing'`
            )
            .run(row.id)
          if (updateRes.changes > 0) {
            reclaimedIds.push(row.id)
            // 仅文件项复位 workspace_files，避免 directory item_id 与文件主键 ID 撞号误伤
            if (row.item_type !== 'directory' && row.item_id != null) {
              db.prepare(`UPDATE workspace_files SET is_analyzed = 0 WHERE id = ?`).run(row.item_id)
            }
          }
        }
      })
      tx()
      if (reclaimedIds.length > 0) {
        this.onReclaimed(reclaimedIds)
      }
    } catch (e) {
      // watchdog 失败不阻断主分析链路，显式上报
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[孤儿 watchdog] 扫描回收失败:', e)
    }
  }
}
