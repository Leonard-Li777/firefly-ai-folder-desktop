import { DuplicateDeleteResult } from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import { getCachedStatement } from '@pro/perf/statement-cache'
import { statOrNull } from '../../../infra/fs'
import { databaseService } from '../../database'
import { getTrashPort } from '../trash-port'

const DELETE_WORKSPACE_FILE_SQL = 'DELETE FROM workspace_files WHERE path = ?'

/**
 * 安全清理选中的冗余文件 (移入操作系统回收站)
 *
 * 事务语义约束（D-04 / P0-6）：严禁合并批量事务，必须保持「每个文件移入回收站成功后立即删除该行」，
 * 防止中途崩溃导致文件已进回收站但数据库仍有记录的语义偏移。
 */
export async function trashDuplicateFiles(filePaths: string[]): Promise<DuplicateDeleteResult> {
  let deletedCount = 0
  let freedBytes = 0
  const errors: Array<{ fileId: number; path: string; error: string }> = []

  await databaseService.ensureInitialized()
  const db = databaseService.db

  for (const filePath of filePaths) {
    try {
      const stat = await statOrNull(filePath)
      if (stat) {
        const size = stat.size

        // 核心安全操作：移入操作系统回收站 (通过 TrashPort 抽象隔离)
        await getTrashPort().trash(filePath)
        deletedCount++
        freedBytes += size

        // 从数据库 workspace_files 解绑
        if (db) {
          getCachedStatement(db, DELETE_WORKSPACE_FILE_SQL).run(filePath)
        }
      }
    } catch (err: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, `清理冗余文件失败 [${filePath}]:`, err)
      errors.push({
        fileId: 0,
        path: filePath,
        error: err?.message || '移入回收站失败'
      })
    }
  }

  return {
    deletedCount,
    freedBytes,
    errors: errors.length > 0 ? errors : undefined
  }
}
