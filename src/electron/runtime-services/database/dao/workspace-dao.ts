import type { Database } from 'better-sqlite3'
import { WorkspaceDirectory } from '@firefly/types'
import { LogCategory, logger, isSubPath, isPathEqual, stripTrailingSlash } from '@firefly/shared'
import { t } from '@app/languages'
import * as path from 'node:path'

export class WorkspaceDao {
  constructor(private db: Database) {}
  async getAll(): Promise<WorkspaceDirectory[]> {
    const rows = this.db.prepare('SELECT * FROM workspaces ORDER BY created_at ASC').all() as any[]
    return rows.map(row => ({
      id: row.workspace_id,
      path: row.path,
      name: row.name,
      type: row.type as 'SPEEDY' | 'PRIVATE',
      recursive: true, // 为了兼容前端旧版类型
      isActive: Boolean(row.is_active),
      autoWatch: Boolean(row.auto_watch),
      lastScanAt: null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.created_at)
    }))
  }

  async getAllWithStats(): Promise<
    Array<
      WorkspaceDirectory & {
        pendingCount: number
        totalCount: number
        analyzedCount: number
      }
    >
  > {
    const rows = this.db.prepare('SELECT * FROM workspaces ORDER BY created_at ASC').all() as any[]
    const stmt = this.db.prepare(`
      SELECT 
        COUNT(*) as total,
        SUM(CASE WHEN is_analyzed = 1 THEN 1 ELSE 0 END) as analyzed
      FROM workspace_files
      WHERE workspace_id = ?
    `)

    return rows.map(row => {
      const stats = stmt.get(row.workspace_id) as
        | { total: number; analyzed: number | null }
        | undefined
      const totalCount = stats?.total || 0
      const analyzedCount = stats?.analyzed || 0
      const pendingCount = totalCount - analyzedCount

      return {
        id: row.workspace_id,
        path: row.path,
        name: row.name,
        type: row.type as 'SPEEDY' | 'PRIVATE',
        recursive: true,
        isActive: Boolean(row.is_active),
        autoWatch: Boolean(row.auto_watch),
        lastScanAt: null,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.created_at),
        totalCount,
        analyzedCount,
        pendingCount
      }
    })
  }

  async getCurrent(): Promise<WorkspaceDirectory | null> {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE is_active = 1 LIMIT 1').get() as any
    if (!row) return null
    return {
      id: row.workspace_id,
      path: row.path,
      name: row.name,
      type: row.type as 'SPEEDY' | 'PRIVATE',
      recursive: true,
      isActive: Boolean(row.is_active),
      autoWatch: Boolean(row.auto_watch),
      lastScanAt: null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.created_at)
    }
  }

  async getById(id: number): Promise<WorkspaceDirectory | null> {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE workspace_id = ?').get(id) as any
    if (!row) return null
    return {
      id: row.workspace_id,
      path: row.path,
      name: row.name,
      type: row.type as 'SPEEDY' | 'PRIVATE',
      recursive: true,
      isActive: Boolean(row.is_active),
      autoWatch: Boolean(row.auto_watch),
      lastScanAt: null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.created_at)
    }
  }

  async getByPath(dirPath: string): Promise<WorkspaceDirectory | null> {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE path = ?').get(dirPath) as any
    if (row) {
      return {
        id: row.workspace_id,
        path: row.path,
        name: row.name,
        type: row.type as 'SPEEDY' | 'PRIVATE',
        recursive: true,
        isActive: Boolean(row.is_active),
        autoWatch: Boolean(row.auto_watch),
        lastScanAt: null,
        createdAt: new Date(row.created_at),
        updatedAt: new Date(row.created_at)
      }
    }
    const all = await this.getAll()
    const matched = all.find(w => isPathEqual(w.path, dirPath))
    return matched || null
  }

  async add(directory: WorkspaceDirectory): Promise<number> {
    const allDirectories = await this.getAll()
    const sep = path.sep
    const newPath = directory.path
    const newType = directory.type || 'SPEEDY'
    // 用于子路径匹配的前缀：确保以斜杠结尾
    const newPathPrefix = newPath.endsWith(sep) ? newPath : newPath + sep

    for (const existing of allDirectories) {
      const existingPath = existing.path
      const existingType = existing.type

      if (isPathEqual(newPath, existingPath)) {
        if (existingType !== newType) {
          const typeName = existingType === 'SPEEDY' ? '极速目录' : '私有目录'
          throw new Error(t('该目录已创建为{typeName}', { typeName }))
        }
        return existing.id!
      }

      const isSubDir = isSubPath(existingPath, newPath)
      const isParentDir = isSubPath(newPath, existingPath)

      if (isSubDir || isParentDir) {
        if (newType !== existingType) {
          const newTypeName = newType === 'SPEEDY' ? '极速目录' : '私有目录'
          const existingTypeName = existingType === 'SPEEDY' ? '极速目录' : '私有目录'

          if (isSubDir) {
            throw new Error(
              `添加失败：${newTypeName}不能包含在已有的${existingTypeName} "${existing.name}" 中`
            )
          } else {
            throw new Error(
              `添加失败：${newTypeName}包含了已有的${existingTypeName} "${existing.name}"`
            )
          }
        }
      }
    }

    const result = this.db
      .prepare(
        `
      INSERT OR REPLACE INTO workspaces 
      (path, name, type, is_active, auto_watch, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        directory.path,
        directory.name,
        newType,
        directory.isActive ? 1 : 0,
        directory.autoWatch ? 1 : 0,
        new Date().toISOString()
      )
    return result.lastInsertRowid as number
  }

  /**
   * 获取目录分析结果
   */
  async getDirectoryAnalysisResult(dirPath: string): Promise<any | null> {
    const row = this.db
      .prepare(
        `
      SELECT * FROM workspace_directories WHERE path = ?
    `
      )
      .get(dirPath) as any
    if (!row) return null

    // 聚合统计信息
    const stats = this.db
      .prepare(
        `
      SELECT COUNT(*) as total, SUM(is_analyzed) as analyzed
      FROM workspace_files
      WHERE directory_id = ?
    `
      )
      .get(row.id) as { total: number; analyzed: number }

    return {
      id: row.id,
      path: row.path,
      name: row.name,
      contextAnalysis: row.context_analysis ? JSON.parse(row.context_analysis) : null,
      isAnalyzed: row.is_analyzed === 1,
      lastAnalyzedAt: row.last_analyzed_at,
      createdAt: row.created_at,
      updatedAt: row.modified_at,
      fileCount: stats.total,
      analyzedFileCount: stats.analyzed || 0
    }
  }

  /**
   * 更新目录分析结果
   */
  async updateDirectoryAnalysisResult(dirPath: string, analysis: any): Promise<void> {
    this.db
      .prepare(
        `
      UPDATE workspace_directories
      SET context_analysis = ?, is_analyzed = 1, last_analyzed_at = ?, modified_at = ?
      WHERE path = ?
    `
      )
      .run(JSON.stringify(analysis), new Date().toISOString(), new Date().toISOString(), dirPath)
  }

  async setCurrent(dirPath: string): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare('UPDATE workspaces SET is_active = 0').run()
      // 优先精确匹配；未命中时忽略大小写/尾斜杠兜底匹配（与 getByPath/findRoot 行为一致）
      let target = this.db
        .prepare('SELECT workspace_id FROM workspaces WHERE path = ?')
        .get(dirPath) as { workspace_id: number } | undefined
      if (!target) {
        const all = this.db.prepare('SELECT workspace_id, path FROM workspaces').all() as {
          workspace_id: number
          path: string
        }[]
        const matched = all.find(ws =>
          isPathEqual(stripTrailingSlash(ws.path), stripTrailingSlash(dirPath))
        )
        if (matched) target = { workspace_id: matched.workspace_id }
      }
      if (target) {
        this.db
          .prepare('UPDATE workspaces SET is_active = 1 WHERE workspace_id = ?')
          .run(target.workspace_id)
      }
    })()
  }

  async delete(directoryPath: string): Promise<void> {
    // 优先精确匹配；未命中时忽略大小写/尾斜杠兜底匹配（与 getByPath/findRoot 行为一致）
    let targetWorkspace = this.db
      .prepare(
        `
      SELECT workspace_id FROM workspaces
      WHERE path = ?
    `
      )
      .get(directoryPath) as { workspace_id: number } | undefined

    if (!targetWorkspace) {
      const allWorkspaces = this.db.prepare(`SELECT workspace_id, path FROM workspaces`).all() as {
        workspace_id: number
        path: string
      }[]
      const matched = allWorkspaces.find(ws =>
        isPathEqual(stripTrailingSlash(ws.path), stripTrailingSlash(directoryPath))
      )
      if (matched) {
        targetWorkspace = { workspace_id: matched.workspace_id }
        logger.info(
          LogCategory.DATABASE_SERVICE,
          '删除工作目录：精确路径未匹配，已忽略大小写/尾斜杠差异匹配',
          { path: directoryPath, matchedPath: matched.path }
        )
      }
    }

    if (!targetWorkspace) {
      logger.warn(LogCategory.DATABASE_SERVICE, '工作目录不存在，无需删除', { path: directoryPath })
      return
    }

    const workspaceId = targetWorkspace.workspace_id

    logger.info(LogCategory.DATABASE_SERVICE, '开始删除工作目录', {
      path: directoryPath,
      workspaceId
    })

    this.db.transaction(() => {
      // 1. 获取该工作区下的所有 workspace_files ID（用于后续清理孤儿文件）
      const workspaceFileIds = this.db
        .prepare(`SELECT id FROM workspace_files WHERE workspace_id = ?`)
        .all(workspaceId)
        .map((r: any) => r.id)

      // 2. 获取该工作区下的所有 workspace_files 的 file_fingerprint
      const fingerprints = this.db
        .prepare(
          `SELECT DISTINCT file_fingerprint FROM workspace_files WHERE workspace_id = ? AND file_fingerprint IS NOT NULL`
        )
        .all(workspaceId)
        .map((r: any) => r.file_fingerprint)

      // 3. 清理分析队列（使用索引优化的 IN 查询）
      if (workspaceFileIds.length > 0) {
        // 分批删除，避免 IN 子句过长
        const batchSize = 500
        for (let i = 0; i < workspaceFileIds.length; i += batchSize) {
          const batch = workspaceFileIds.slice(i, i + batchSize)
          const placeholders = batch.map(() => '?').join(',')
          this.db
            .prepare(
              `DELETE FROM analysis_queue WHERE item_type = 'file' AND item_id IN (${placeholders})`
            )
            .run(...batch)
        }
      }

      // 4. 删除该工作区的 workspace_files
      this.db.prepare(`DELETE FROM workspace_files WHERE workspace_id = ?`).run(workspaceId)

      // 5. 删除该工作区的 workspace_directories
      this.db.prepare(`DELETE FROM workspace_directories WHERE workspace_id = ?`).run(workspaceId)

      // 6. 删除该工作区的 virtual_directories
      this.db.prepare(`DELETE FROM virtual_directories WHERE workspace_id = ?`).run(workspaceId)

      // 7. 删除工作区记录
      this.db.prepare(`DELETE FROM workspaces WHERE workspace_id = ?`).run(workspaceId)

      // 8. 清理孤儿文件记录（只清理当前工作区涉及的指纹）
      if (fingerprints.length > 0) {
        const batchSize = 500
        for (let i = 0; i < fingerprints.length; i += batchSize) {
          const batch = fingerprints.slice(i, i + batchSize)
          const placeholders = batch.map(() => '?').join(',')
          // 检查这些指纹是否还被其他工作区引用
          const stillReferenced = this.db
            .prepare(
              `SELECT DISTINCT file_fingerprint FROM workspace_files WHERE file_fingerprint IN (${placeholders})`
            )
            .all(...batch)
            .map((r: any) => r.file_fingerprint)
          const orphans = batch.filter(fp => !stillReferenced.includes(fp))
          if (orphans.length > 0) {
            const orphanPlaceholders = orphans.map(() => '?').join(',')
            // file_contents 和 file_tag_relations 会通过外键级联删除
            this.db
              .prepare(`DELETE FROM files WHERE file_fingerprint IN (${orphanPlaceholders})`)
              .run(...orphans)
          }
        }
      }

      logger.info(LogCategory.DATABASE_SERVICE, `工作区及其关联文件已彻底清空`, {
        workspaceId,
        path: directoryPath
      })
    })()

    logger.info(LogCategory.DATABASE_SERVICE, '工作目录删除完成', { path: directoryPath })
  }

  async updateAutoWatch(workspaceId: number, autoWatch: boolean): Promise<void> {
    this.db
      .prepare('UPDATE workspaces SET auto_watch = ? WHERE workspace_id = ?')
      .run(autoWatch ? 1 : 0, workspaceId)
  }

  /**
   * 更新目录的最后扫描时间
   */
  async updateLastScan(workspaceId: number): Promise<void> {
    this.db
      .prepare('UPDATE workspaces SET last_scan_at = ? WHERE workspace_id = ?')
      .run(new Date().toISOString(), workspaceId)
  }

  async findRoot(filePath: string): Promise<WorkspaceDirectory | null> {
    try {
      const roots = await this.getAll()

      let bestMatch: WorkspaceDirectory | null = null
      let maxLen = -1

      for (const root of roots) {
        if (isSubPath(root.path, filePath)) {
          if (root.path.length > maxLen) {
            maxLen = root.path.length
            bestMatch = root
          }
        }
      }
      return bestMatch
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '查找根工作目录失败', { error, filePath })
      return null
    }
  }

  /**
   * 根据 ID 更新 workspace_files 的 status 状态
   */
  async updateFileStatus(fileId: number, status: number): Promise<void> {
    try {
      this.db
        .prepare('UPDATE workspace_files SET status = ?, modified_at = ? WHERE id = ?')
        .run(status, new Date().toISOString(), fileId)
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '更新文件状态失败', { error, fileId, status })
    }
  }

  /**
   * 根据路径更新 workspace_files 的 status 状态
   */
  async updateFileStatusByPath(filePath: string, status: number): Promise<void> {
    try {
      this.db
        .prepare('UPDATE workspace_files SET status = ?, modified_at = ? WHERE path = ?')
        .run(status, new Date().toISOString(), filePath)
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '根据路径更新文件状态失败', {
        error,
        filePath,
        status
      })
    }
  }
}
