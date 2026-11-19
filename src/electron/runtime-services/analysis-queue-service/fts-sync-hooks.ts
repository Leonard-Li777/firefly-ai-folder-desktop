import { databaseService } from '../database/database-service'
import { logger, LogCategory } from '@firefly/shared'

const pendingFingerprints = new Set<string>()
let debounceTimer: ReturnType<typeof setTimeout> | null = null
const DELAY_MS = 2000

/**
 * 立即将当前待同步指纹集合批量刷盘到 FTS 倒排与拼音正排索引。
 * 可由定时器到期自动触发，也可由退出钩子或测试主动调用。
 */
export function flushFtsSync(): void {
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer)
    debounceTimer = null
  }
  if (pendingFingerprints.size === 0) return

  const batch = Array.from(pendingFingerprints)
  pendingFingerprints.clear()

  try {
    databaseService.syncFTSTagsBatch(batch)
  } catch (err) {
    logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] 批量同步 FTS 标签失败:', err)
  }
}

/**
 * 返回当前防抖队列中待刷盘的去重指纹数量（供测试与可观测性检查）。
 */
export function getPendingFtsSyncCount(): number {
  return pendingFingerprints.size
}

/**
 * 窗口聚合批量去抖同步 FTS 标签，将短时间内同一批文件的重复同步去重合并为单次事务。
 */
export function queueFtsSync(fingerprint: string): void {
  if (!fingerprint) return
  pendingFingerprints.add(fingerprint)
  if (debounceTimer !== null) {
    clearTimeout(debounceTimer)
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    flushFtsSync()
  }, DELAY_MS)
  if (typeof (debounceTimer as any).unref === 'function') {
    ;(debounceTimer as any).unref()
  }
}
