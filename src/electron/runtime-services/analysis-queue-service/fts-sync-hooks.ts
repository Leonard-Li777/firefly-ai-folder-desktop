import { databaseService } from '../database/database-service'
import { logger, LogCategory } from '@firefly/shared'

const syncMap = new Map<string, ReturnType<typeof setTimeout>>()
const DELAY_MS = 2000

/**
 * 批量去抖同步 FTS 标签，避免同一指纹在短时间内触发多次数据库操作。
 */
export function queueFtsSync(fingerprint: string) {
  if (syncMap.has(fingerprint)) {
    clearTimeout(syncMap.get(fingerprint)!)
  }
  const timer = setTimeout(() => {
    syncMap.delete(fingerprint)
    try {
      databaseService.syncFTSTags(fingerprint)
    } catch (err) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] 同步 FTS 标签失败:', err)
    }
  }, DELAY_MS)
  syncMap.set(fingerprint, timer)
}
