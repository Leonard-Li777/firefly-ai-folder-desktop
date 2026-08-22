/**
 * 文件清理服务
 * 负责删除文件时同步清理所有关联信息
 */

import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { logger, LogCategory } from '@firefly/shared'
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
      const wf = this.db
        .prepare('SELECT id, path, file_fingerprint FROM workspace_files WHERE id = ?')
        .get(fileId) as any
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
          recalculatedTags: 0
        }
      })

      const result = transaction()

      return {
        success: true,
        ...result
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
          } catch (error) {
            logger.warn(LogCategory.FILE_WATCHER, '清理硬链接扫描空目录失败:', error)
          }
        } else if (entry.isFile()) {
          try {
            const stats = fs.statSync(fullPath)
            if (stats.ino === targetInode) {
              fs.unlinkSync(fullPath)
              deletedCount++
            }
          } catch (error) {
            logger.warn(LogCategory.FILE_WATCHER, '清理硬链接删除文件失败:', fullPath, error)
          }
        }
      }
    } catch (error) {
      logger.warn(LogCategory.FILE_WATCHER, '扫描并删除硬链接失败:', error)
    }

    return deletedCount
  }

  /**
   * 批量删除文件
   */
  async batchDeleteFiles(fileIds: number[]): Promise<{
    successCount: number
    failedCount: number
    totalDeletedHardlinks: number
    errors: Array<{ fileId: number; error: string }>
  }> {
    if (!fileIds || fileIds.length === 0) {
      return { successCount: 0, failedCount: 0, totalDeletedHardlinks: 0, errors: [] }
    }

    let successCount = 0
    let failedCount = 0
    let totalDeletedHardlinks = 0
    const errors: Array<{ fileId: number; error: string }> = []

    try {
      // 1. 批量获取文件元数据及工作区信息 (考虑 SQLite 999 变量限制)
      const MAX_BATCH_SIZE = 900
      const fileMetadatas: Array<{ id: number; path: string; workspace_path: string }> = []

      for (let i = 0; i < fileIds.length; i += MAX_BATCH_SIZE) {
        const chunk = fileIds.slice(i, i + MAX_BATCH_SIZE)
        const placeholders = chunk.map(() => '?').join(',')
        const rows = this.db
          .prepare(
            `
          SELECT wf.id, wf.path, wd.path as workspace_path
          FROM workspace_files wf
          INNER JOIN workspace_directories wd ON wd.id = wf.directory_id
          WHERE wf.id IN (${placeholders})
        `
          )
          .all(...chunk) as Array<{ id: number; path: string; workspace_path: string }>
        fileMetadatas.push(...rows)
      }

      const metadataMap = new Map(fileMetadatas.map(m => [m.id, m]))

      // 2. 统计未找到的文件
      for (const id of fileIds) {
        if (!metadataMap.has(id)) {
          failedCount++
          errors.push({ fileId: id, error: t('文件记录 { fileId } 不存在', { fileId: id }) })
        }
      }

      // 3. 获取 inode 并按工作区分组
      const workspaceGroups = new Map<
        string,
        Array<{ id: number; path: string; inode: number | null }>
      >()

      for (const meta of fileMetadatas) {
        let inode: number | null = null
        try {
          if (fs.existsSync(meta.path)) {
            inode = fs.statSync(meta.path).ino
          }
        } catch (e) {
          logger.warn(LogCategory.FILE_WATCHER, '获取文件 inode 失败:', meta.path, e)
        }

        if (!workspaceGroups.has(meta.workspace_path)) {
          workspaceGroups.set(meta.workspace_path, [])
        }
        workspaceGroups.get(meta.workspace_path)!.push({ id: meta.id, path: meta.path, inode })
      }

      // 4. 按工作区执行批量清理
      for (const [workspacePath, files] of workspaceGroups.entries()) {
        try {
          const virtualDirRoot = path.join(workspacePath, '.VirtualDirectory')
          let deletedHardlinks = 0

          // 4.1 批量清理硬链接 (每个工作区只扫描一次虚拟目录)
          if (fs.existsSync(virtualDirRoot)) {
            const inodesSet = new Set<number>()
            for (const f of files) {
              if (f.inode !== null) inodesSet.add(f.inode)
            }

            if (inodesSet.size > 0) {
              deletedHardlinks = this.batchScanAndDeleteHardlinks(virtualDirRoot, inodesSet)
              totalDeletedHardlinks += deletedHardlinks
            }
          }

          // 4.2 批量删除数据库记录 (按工作区分批次执行)
          const fileIdsInWorkspace = files.map(f => f.id)

          this.db.transaction(() => {
            for (let i = 0; i < fileIdsInWorkspace.length; i += MAX_BATCH_SIZE) {
              const chunk = fileIdsInWorkspace.slice(i, i + MAX_BATCH_SIZE)
              const placeholders = chunk.map(() => '?').join(',')

              // 删除 workspace_files
              this.db
                .prepare(`DELETE FROM workspace_files WHERE id IN (${placeholders})`)
                .run(...chunk)

              // 清理分析队列
              this.db
                .prepare(
                  `DELETE FROM analysis_queue WHERE item_type = 'file' AND item_id IN (${placeholders})`
                )
                .run(...chunk)

              // 清理最小单元关联
              this.db
                .prepare(`DELETE FROM file_unit_relations WHERE file_id IN (${placeholders})`)
                .run(...chunk)
            }
          })()

          successCount += files.length
        } catch (error: any) {
          logger.error(LogCategory.DATABASE_SERVICE, `批量清理工作区失败: ${workspacePath}`, error)
          for (const f of files) {
            failedCount++
            errors.push({ fileId: f.id, error: error.message || String(error) })
          }
        }
      }
    } catch (error: any) {
      logger.error(LogCategory.DATABASE_SERVICE, '批量删除文件发生全局错误', error)
      return {
        successCount: 0,
        failedCount: fileIds.length,
        totalDeletedHardlinks: 0,
        errors: fileIds.map(id => ({ fileId: id, error: error.message || String(error) }))
      }
    }

    return {
      successCount,
      failedCount,
      totalDeletedHardlinks,
      errors
    }
  }

  /**
   * 批量扫描并删除硬链接
   */
  private batchScanAndDeleteHardlinks(dirPath: string, targetInodes: Set<number>): number {
    let deletedCount = 0

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)

        if (/^ReadMe_[a-zA-Z\-]{2,10}\.txt$/.test(entry.name)) {
          continue
        }

        if (entry.isDirectory()) {
          deletedCount += this.batchScanAndDeleteHardlinks(fullPath, targetInodes)
          try {
            const remainingEntries = fs.readdirSync(fullPath)
            if (remainingEntries.length === 0) {
              fs.rmdirSync(fullPath)
            }
          } catch (error) {
            logger.warn(LogCategory.FILE_WATCHER, '批量清理空目录失败:', fullPath, error)
          }
        } else if (entry.isFile()) {
          try {
            const stats = fs.statSync(fullPath)
            if (targetInodes.has(stats.ino)) {
              fs.unlinkSync(fullPath)
              deletedCount++
            }
          } catch (error) {
            logger.warn(LogCategory.FILE_WATCHER, '批量清理硬链接删除文件失败:', fullPath, error)
          }
        }
      }
    } catch (error) {
      logger.warn(LogCategory.FILE_WATCHER, '批量扫描并删除硬链接失败:', error)
    }

    return deletedCount
  }
}
