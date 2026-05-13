import type { Database } from 'better-sqlite3';
import { WorkspaceDirectory } from '@yonuc/types';
import { LogCategory, logger } from '@yonuc/shared';
import * as path from 'node:path';

export class WorkspaceDao {
  constructor(private db: Database) {}
  async getAll(): Promise<WorkspaceDirectory[]> {
    const rows = this.db.prepare('SELECT * FROM workspaces ORDER BY created_at DESC').all() as any[]
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
      const existingPathPrefix = existingPath.endsWith(sep) ? existingPath : existingPath + sep

      if (newPath === existingPath) {
        if (existingType !== newType) {
          const typeName = existingType === 'SPEEDY' ? '极速目录' : '私有目录'
          throw new Error(`该目录已创建为${typeName}`)
        }
        return existing.id!
      }

      // 使用标准路径前缀检查，确保跨平台一致性，且不进行归一化
      const isSubDir = newPath.startsWith(existingPathPrefix)
      const isParentDir = existingPath.startsWith(newPathPrefix)

      if (isSubDir || isParentDir) {
        if (newType !== existingType) {
          const newTypeName = newType === 'SPEEDY' ? '极速目录' : '私有目录'
          const existingTypeName = existingType === 'SPEEDY' ? '极速目录' : '私有目录'
          
          if (isSubDir) {
            throw new Error(`添加失败：${newTypeName}不能包含在已有的${existingTypeName} "${existing.name}" 中`)
          } else {
            throw new Error(`添加失败：${newTypeName}包含了已有的${existingTypeName} "${existing.name}"`)
          }
        }
      }
    }

    const result = this.db.prepare(`
      INSERT OR REPLACE INTO workspaces 
      (path, name, type, is_active, auto_watch, created_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      directory.path,
      directory.name,
      newType,
      directory.isActive ? 1 : 0,
      directory.autoWatch ? 1 : 0
    )
    return result.lastInsertRowid as number
  }

  /**
   * 获取目录分析结果
   */
  async getDirectoryAnalysisResult(dirPath: string): Promise<any | null> {
    const row = this.db.prepare(`
      SELECT * FROM workspace_directories WHERE path = ?
    `).get(dirPath) as any
    if (!row) return null

    // 聚合统计信息
    const stats = this.db.prepare(`
      SELECT COUNT(*) as total, SUM(is_analyzed) as analyzed
      FROM workspace_files
      WHERE directory_id = ?
    `).get(row.id) as { total: number, analyzed: number }

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
    this.db.prepare(`
      UPDATE workspace_directories
      SET context_analysis = ?, is_analyzed = 1, last_analyzed_at = CURRENT_TIMESTAMP, modified_at = CURRENT_TIMESTAMP
      WHERE path = ?
    `).run(JSON.stringify(analysis), dirPath)
  }

  async setCurrent(dirPath: string): Promise<void> {
    this.db.transaction(() => {
      this.db.prepare('UPDATE workspaces SET is_active = 0').run()
      this.db.prepare(`
        UPDATE workspaces 
        SET is_active = 1 
        WHERE path = ?`).run(dirPath)
    })()
  }

  async delete(directoryPath: string): Promise<void> {
    const targetWorkspace = this.db.prepare(`
      SELECT workspace_id FROM workspaces 
      WHERE path = ?
    `).get(directoryPath) as { workspace_id: number } | undefined

    if (!targetWorkspace) {
      logger.warn(LogCategory.DATABASE_SERVICE, '工作目录不存在，无需删除', { path: directoryPath })
      return
    }

    logger.info(LogCategory.DATABASE_SERVICE, '开始删除工作目录 (依赖数据库级联删除)', { 
      path: directoryPath, 
      workspaceId: targetWorkspace.workspace_id
    })
    
    this.db.transaction(() => {
      // 1. 彻底清理分析队列中所有涉及该工作区的文件记录
      // 这里的逻辑必须非常精确：我们删除那些关联到 workspace_files 或 workspace_directories 记录的队列项
      // 而这些记录正是属于 targetWorkspace 的
      this.db.prepare(`
        DELETE FROM analysis_queue 
        WHERE id IN (
          SELECT q.id FROM analysis_queue q
          LEFT JOIN workspace_files wf ON (q.item_type = 'file' AND q.item_id = wf.id)
          LEFT JOIN workspace_directories wd ON (q.item_type = 'directory' AND q.item_id = wd.id)
          WHERE wf.workspace_id = ? OR wd.workspace_id = ?
        )
      `).run(targetWorkspace.workspace_id, targetWorkspace.workspace_id)

      // 2. 删除工作区记录
      // 注意：这会自动触发级联删除：
      // - workspace_files (ON DELETE CASCADE)
      // - workspace_directories (ON DELETE CASCADE)
      // - file_units (ON DELETE CASCADE)
      // - virtual_directories (ON DELETE CASCADE)
      this.db.prepare(`DELETE FROM workspaces WHERE workspace_id = ?`).run(targetWorkspace.workspace_id)
      
      // 3. 深度清理：清理孤儿内容记录 (Files & Contents)
      // 我们删除那些不再被任何工作区引用的内容指纹记录
      this.db.prepare(`
        DELETE FROM files 
        WHERE file_fingerprint NOT IN (
          SELECT DISTINCT file_fingerprint FROM workspace_files WHERE file_fingerprint IS NOT NULL
        )
      `).run()

      // 💡 提示：由于 file_contents 和 file_tag_relations 在定义时使用了 
      // FOREIGN KEY (file_fingerprint) REFERENCES files(file_fingerprint) ON DELETE CASCADE
      // 所以当对应的 files 记录被删除时，这些表中的大字段和标签关联也会被自动清理。

      // 4. 清理无效的目录记录（如果有任何残留）
      this.db.prepare(`
        DELETE FROM workspace_directories 
        WHERE workspace_id NOT IN (SELECT workspace_id FROM workspaces)
      `).run()

      logger.info(LogCategory.DATABASE_SERVICE, `工作区及其关联文件已彻底清空`, { workspaceId: targetWorkspace.workspace_id, path: directoryPath })
    })()
    
    logger.info(LogCategory.DATABASE_SERVICE, '工作目录删除完成', { path: directoryPath })
  }

  async updateAutoWatch(workspaceId: number, autoWatch: boolean): Promise<void> {
    this.db.prepare('UPDATE workspaces SET auto_watch = ? WHERE workspace_id = ?').run(autoWatch ? 1 : 0, workspaceId)
  }

  /**
   * 更新目录的最后扫描时间
   */
  async updateLastScan(workspaceId: number): Promise<void> {
    this.db.prepare('UPDATE workspaces SET last_scan_at = CURRENT_TIMESTAMP WHERE workspace_id = ?').run(workspaceId)
  }

  async findRoot(filePath: string): Promise<WorkspaceDirectory | null> {
    try {
      const roots = await this.getAll()
      const sep = path.sep
      
      let bestMatch: WorkspaceDirectory | null = null
      let maxLen = -1
      
      for (const root of roots) {
        const rootPath = root.path
        // 确保前缀以分隔符结尾，以便正确匹配子项，同时避免 E:\ 变成 E:\\
        const prefix = rootPath.endsWith(sep) ? rootPath : rootPath + sep
        
        // 1. 完全相等或者是其子路径
        if (filePath === rootPath || filePath.startsWith(prefix)) {
          if (rootPath.length > maxLen) {
            maxLen = rootPath.length
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
}
