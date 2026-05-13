/**
 * 文件清理服务
 * 负责删除文件时同步清理所有关联信息
 */

import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { logger, LogCategory } from '@yonuc/shared'
import { t } from '@app/languages'

export class FileCleanupService {
  constructor(private db: Database.Database) {}

  /**
   * 删除文件并清理所有关联信息
   * @param fileId workspace_files 表的自增 ID
   * @returns 清理统计信息
   */
  async deleteFileAndCleanup(fileId: number): Promise<{
    success: boolean
    deletedHardlinks: number
    removedFromAnalysisQueue: boolean
    recalculatedTags: number
  }> {
    try {
      logger.info(LogCategory.DATABASE_SERVICE, `开始删除文件及清理关联信息: ID=${fileId}`)

      // 1. 获取文件路径信息
      const wf = this.db.prepare('SELECT id, path, file_fingerprint FROM workspace_files WHERE id = ?').get(fileId) as any
      if (!wf) {
        throw new Error(t('文件记录 { fileId } 不存在', { fileId }))
      }

      logger.info(LogCategory.DATABASE_SERVICE, `物理文件路径: ${wf.path}`)

      // 获取文件的inode（用于识别硬链接）
      let fileInode: number | null = null
      try {
        if (fs.existsSync(wf.path)) {
          const stats = fs.statSync(wf.path)
          fileInode = stats.ino
          logger.info(LogCategory.DATABASE_SERVICE, `文件inode: ${fileInode}`)
        }
      } catch (error) {
        logger.warn(LogCategory.DATABASE_SERVICE, `无法获取文件inode，文件可能已被移除: ${wf.path}`)
      }

      // 2. 使用事务确保原子性
      const transaction = this.db.transaction(() => {
        // 2.1 删除虚拟目录中的硬链接
        let deletedHardlinks = 0
        if (fileInode !== null) {
          deletedHardlinks = this.cleanupVirtualDirectoryHardlinks(wf.path, fileInode)
        }

        // 2.2 删除数据库记录
        // 注意：tags 通过 file_fingerprint 关联，不会被删除
        this.db.prepare('DELETE FROM workspace_files WHERE id = ?').run(fileId)
        logger.info(LogCategory.DATABASE_SERVICE, `已从 workspace_files 删除记录: ID=${fileId}`)

        // 2.3 清理分析队列（现在通过 item_id 关联）
        const queueResult = this.db
          .prepare('DELETE FROM analysis_queue WHERE item_type = ? AND item_id = ?')
          .run('file', fileId)
        const removedFromAnalysisQueue = queueResult.changes > 0
        if (removedFromAnalysisQueue) {
          logger.info(LogCategory.DATABASE_SERVICE, `已从分析队列删除: ID=${fileId}`)
        }

        // 2.4 清理最小单元关联
        this.db.prepare('DELETE FROM file_unit_relations WHERE file_id = ?').run(fileId)

        return {
          deletedHardlinks,
          removedFromAnalysisQueue,
          recalculatedTags: 0,
        }
      })

      const result = transaction()

      return {
        success: true,
        ...result,
      }
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, `删除文件失败: ID=${fileId}`, error)
      throw error
    }
  }

  /**
   * 清理虚拟目录中的硬链接
   * @param originalPath 原始文件路径
   * @param fileInode 文件inode
   * @returns 删除的硬链接数量
   */
  private cleanupVirtualDirectoryHardlinks(originalPath: string, fileInode: number): number {
    let deletedCount = 0

    try {
      // 获取文件所属的工作目录
      const file = this.db
        .prepare(
          `
        SELECT wd.path as workspace_path
        FROM workspace_files wf
        INNER JOIN workspace_directories wd ON wd.id = wf.directory_id
        WHERE wf.path = ?
      `
        )
        .get(originalPath) as any

      if (!file) {
        logger.warn(LogCategory.DATABASE_SERVICE, `未找到文件的工作目录: ${originalPath}`)
        return 0
      }

      const virtualDirRoot = path.join(file.workspace_path, '.VirtualDirectory')

      // 检查虚拟目录是否存在
      if (!fs.existsSync(virtualDirRoot)) {
        logger.info(LogCategory.DATABASE_SERVICE, `虚拟目录不存在: ${virtualDirRoot}`)
        return 0
      }

      // 递归扫描虚拟目录，查找并删除硬链接
      deletedCount = this.scanAndDeleteHardlinks(virtualDirRoot, fileInode, originalPath)

      logger.info(LogCategory.DATABASE_SERVICE, `清理硬链接完成，删除数量: ${deletedCount}`)
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '清理虚拟目录硬链接失败', error)
    }

    return deletedCount
  }

  /**
   * 递归扫描目录并删除匹配的硬链接
   */
  private scanAndDeleteHardlinks(
    dirPath: string,
    targetInode: number,
    originalPath: string
  ): number {
    let deletedCount = 0

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)

        if (/^ReadMe_[a-zA-Z\-]{5}\.txt$/.test(entry.name)) {
          continue
        }

        if (entry.isDirectory()) {
          deletedCount += this.scanAndDeleteHardlinks(fullPath, targetInode, originalPath)
          try {
            const remainingEntries = fs.readdirSync(fullPath)
            if (remainingEntries.length === 0) {
              fs.rmdirSync(fullPath)
            }
          } catch (error) {}
        } else if (entry.isFile()) {
          try {
            const stats = fs.statSync(fullPath)
            if (stats.ino === targetInode) {
              fs.unlinkSync(fullPath)
              deletedCount++
            }
          } catch (error) {}
        }
      }
    } catch (error) {}

    return deletedCount
  }

  /**
   * 批量删除文件
   */
  async batchDeleteFiles(
    fileIds: number[]
  ): Promise<{
    successCount: number
    failedCount: number
    totalDeletedHardlinks: number
    errors: Array<{ fileId: number; error: string }>
  }> {
    let successCount = 0
    let failedCount = 0
    let totalDeletedHardlinks = 0
    const errors: Array<{ fileId: number; error: string }> = []

    for (const fileId of fileIds) {
      try {
        const result = await this.deleteFileAndCleanup(fileId)
        if (result.success) {
          successCount++
          totalDeletedHardlinks += result.deletedHardlinks
        } else {
          failedCount++
        }
      } catch (error: any) {
        failedCount++
        errors.push({
          fileId: fileId,
          error: error.message || String(error),
        })
      }
    }

    return {
      successCount,
      failedCount,
      totalDeletedHardlinks,
      errors,
    }
  }
}
