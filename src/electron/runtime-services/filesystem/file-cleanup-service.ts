/**
 * 文件清理服务
 * 负责删除文件时同步清理所有关联信息
 */

import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { logger, LogCategory } from '@firefly/shared'
import { t } from '@app/languages'

/** 两阶段孤儿对账结果（Issue 04 Step 1） */
export interface ReconcileOrphanResult {
  checked: number // 本轮从 orphan_gc_queue 取出的候选指纹数
  skippedInFlight: number // R2-2a 在途分析跳过数（保留队列）
  deletedFiles: number // 阶段一实际删除的 files 行数
  vectorsDeleted: number // 阶段二成功删除的向量数
  vectorsPending: number // 阶段二待删/失败保留在 outbox 的数（Omni 离线自愈）
}

/** vector_delete_outbox 阶段二重试上限（连续 ≥5 次置 failed 并告警） */
const VECTOR_DELETE_MAX_RETRY = 5
/** 阶段一批处理大小 */
const GC_BATCH_SIZE = 500

export class FileCleanupService {
  constructor(private db: Database.Database) {}

  /**
   * [R2-2a] 判定某指纹是否正在分析队列中（pending/analyzing）。
   * 用 SQL 判定（非内存单例依赖）：analysis_queue.item_type='file' 经 workspace_files 关联指纹，
   * 避免跨单例脆弱引用；被删除文件已无 workspace_files 行，其残留在途队列项自然不参与判定。
   */
  private isFingerprintInFlight(fp: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1
           FROM analysis_queue q
           JOIN workspace_files wf ON q.item_type = 'file' AND q.item_id = wf.id
          WHERE wf.file_fingerprint = ?
            AND q.status IN ('pending', 'analyzing')
          LIMIT 1`
      )
      .get(fp)
    return !!row
  }

  /**
   * Issue 04 Step 1：两阶段孤儿指纹对账（SQLite ↔ FTS5 ↔ zvec 真自愈）。
   *
   * 阶段一（单事务原子）：取 orphan_gc_queue 批次 → 前置跳过在途分析（R2-2a，保留队列）
   *   → SQL 守卫 NOT EXISTS workspace_files（触发器已保证，防御性二次校验）
   *   → DELETE FROM files（外键级联清 file_contents/file_tag_relations/file_video_*；
   *     trg_files_fts_delete 清三张 FTS 虚表）
   *   → 写 vector_delete_outbox + 移除 orphan_gc_queue。
   * 阶段二（异步）：扫 vector_delete_outbox(pending) → 二次校验 NOT EXISTS files
   *   → omniClient.deleteVectors(fps) 成功后删行；失败递增 retry_count，≥5 置 failed；
   *   Omni 离线（返回 null / 抛错）保留待下次自愈。
   *
   * @param options.runVectorPhase 是否执行阶段二（默认 true；启动自愈/测试可关）
   */
  async reconcileOrphanFingerprints(
    options: { runVectorPhase?: boolean } = {}
  ): Promise<ReconcileOrphanResult> {
    const runVectorPhase = options.runVectorPhase !== false
    const result: ReconcileOrphanResult = {
      checked: 0,
      skippedInFlight: 0,
      deletedFiles: 0,
      vectorsDeleted: 0,
      vectorsPending: 0
    }

    // ===== 阶段一：单事务原子删 files + 写 outbox + 移除 queue =====
    const candidates = this.db
      .prepare(`SELECT file_fingerprint FROM orphan_gc_queue LIMIT ?`)
      .all(GC_BATCH_SIZE) as Array<{ file_fingerprint: string }>

    if (candidates.length > 0) {
      const toVector: string[] = []
      this.db.transaction(() => {
        const deleteFilesStmt = this.db.prepare(
          'DELETE FROM files WHERE file_fingerprint = ? AND NOT EXISTS (SELECT 1 FROM workspace_files WHERE file_fingerprint = files.file_fingerprint)'
        )
        const insertOutboxStmt = this.db.prepare(
          `INSERT OR IGNORE INTO vector_delete_outbox (file_fingerprint, state, retry_count, enqueued_at)
           VALUES (?, 'pending', 0, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER))`
        )
        const removeQueueStmt = this.db.prepare(
          'DELETE FROM orphan_gc_queue WHERE file_fingerprint = ?'
        )

        for (const { file_fingerprint: fp } of candidates) {
          result.checked++
          // [R2-2a] 在途分析直接跳过并保留队列，等分析完成后再对账
          if (this.isFingerprintInFlight(fp)) {
            result.skippedInFlight++
            continue
          }
          const changes = deleteFilesStmt.run(fp).changes
          if (changes > 0) {
            // 删除成功 → 标记待删向量 + 移出待回收队列
            insertOutboxStmt.run(fp)
            result.deletedFiles++
          }
          // 无论是否真删（触发器守卫已保证零引用，此处 deletes>0 必然成立），
          // 只要 files 已不存在即可移出队列；若仍被引用（防御分支）保留队列下次再查。
          const stillReferenced = this.db
            .prepare('SELECT 1 FROM workspace_files WHERE file_fingerprint = ? LIMIT 1')
            .get(fp)
          if (!stillReferenced) {
            removeQueueStmt.run(fp)
            if (changes > 0) toVector.push(fp)
          }
        }
      })()
    }

    // ===== 阶段二：异步删向量（Omni 离线保留待自愈） =====
    if (runVectorPhase) {
      await this.processVectorDeleteOutbox(result)
    }

    if (result.checked > 0 || result.vectorsDeleted > 0) {
      logger.info(LogCategory.DATABASE_SERVICE, '[GC] 两阶段孤儿对账完成', { ...result })
    }
    return result
  }

  /**
   * 阶段二：处理 vector_delete_outbox —— 二次校验 NOT EXISTS files 后调 Omni 删向量。
   * Omni 离线（返回 null）或失败：递增 retry_count，连续 ≥5 次置 failed 并告警，保留待重启自愈。
   */
  private async processVectorDeleteOutbox(result: ReconcileOrphanResult): Promise<void> {
    const pending = this.db
      .prepare(
        `SELECT file_fingerprint, retry_count FROM vector_delete_outbox WHERE state = 'pending' LIMIT ?`
      )
      .all(GC_BATCH_SIZE) as Array<{ file_fingerprint: string; retry_count: number }>

    if (pending.length === 0) return

    // 二次校验：仅删当前 files 中已不存在的指纹（防延迟 outbox 误删重建向量）
    const stillExists = new Set(
      (
        this.db
          .prepare(
            `SELECT file_fingerprint FROM files WHERE file_fingerprint IN (${pending
              .map(() => '?')
              .join(',')})`
          )
          .all(...pending.map(p => p.file_fingerprint)) as Array<{ file_fingerprint: string }>
      ).map(r => r.file_fingerprint)
    )
    const toDelete = pending.filter(p => !stillExists.has(p.file_fingerprint))
    if (toDelete.length === 0) return

    const fps = toDelete.map(p => p.file_fingerprint)
    const deleteOutboxStmt = this.db.prepare(
      'DELETE FROM vector_delete_outbox WHERE file_fingerprint = ?'
    )
    const bumpRetryStmt = this.db.prepare(
      `UPDATE vector_delete_outbox
         SET retry_count = retry_count + 1,
             state = CASE WHEN retry_count + 1 >= ? THEN 'failed' ELSE 'pending' END
       WHERE file_fingerprint = ?`
    )

    try {
      // 动态 import 打断 FileCleanupService ↔ omni-client 的静态环（与 WorkspaceDao 一致）
      const { omniClient } = await import('../../services/omni-client')
      const resp = await omniClient.deleteVectors(fps)
      if (resp && resp.success) {
        for (const fp of fps) deleteOutboxStmt.run(fp)
        result.vectorsDeleted += fps.length
      } else {
        // Omni 返回 null（离线）或 success=false：保留待自愈，递增重试
        for (const p of toDelete) bumpRetryStmt.run(VECTOR_DELETE_MAX_RETRY, p.file_fingerprint)
        result.vectorsPending += toDelete.length
        logger.warn(LogCategory.DATABASE_SERVICE, '[GC] Omni 删向量未成功，保留 outbox 待自愈', {
          count: toDelete.length
        })
      }
    } catch (err) {
      for (const p of toDelete) bumpRetryStmt.run(VECTOR_DELETE_MAX_RETRY, p.file_fingerprint)
      result.vectorsPending += toDelete.length
      logger.warn(LogCategory.DATABASE_SERVICE, '[GC] 调用 Omni 删向量异常，保留 outbox 待自愈', {
        count: toDelete.length,
        err
      })
    }
  }

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
