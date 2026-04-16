import type { Database } from 'better-sqlite3';
import { WorkspaceDirectory } from '@yonuc/types';
import { LogCategory, logger } from '@yonuc/shared';
import * as path from 'node:path';

export class WorkspaceDao {
  constructor(private db: Database) {}

  /**
   * 规范化路径用于比较 (使用标准平台路径)
   */
  private normalizePathForComparison(dirPath: string): string {
    return path.resolve(dirPath).replace(/\/$/, '').replace(/\\$/, '')
  }

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

  async getById(workspaceId: number): Promise<WorkspaceDirectory | null> {
    const row = this.db.prepare('SELECT * FROM workspaces WHERE workspace_id = ?').get(workspaceId) as any
    if (!row) return null
    return {
      id: row.workspace_id,
      name: row.name,
      path: row.path,
      type: row.type as 'SPEEDY' | 'PRIVATE',
      recursive: true,
      isActive: row.is_active === 1,
      autoWatch: row.auto_watch === 1,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.created_at)
    }
  }

  async add(directory: WorkspaceDirectory): Promise<number> {
    const allDirectories = await this.getAll()
    const newPath = this.normalizePathForComparison(directory.path)
    const newType = directory.type || 'SPEEDY'

    for (const existing of allDirectories) {
      const existingPath = this.normalizePathForComparison(existing.path)
      const existingType = existing.type

      if (newPath === existingPath) {
        if (existingType !== newType) {
          const typeName = existingType === 'SPEEDY' ? '极速目录' : '私有目录'
          throw new Error(`该目录已创建为${typeName}`)
        }
        return existing.id!
      }

      // 使用标准路径前缀检查，确保跨平台一致性
      const isSubDir = newPath.startsWith(existingPath + path.sep)
      const isParentDir = existingPath.startsWith(newPath + path.sep)

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
    const normalizedPath = path.normalize(dirPath);
    const row = this.db.prepare(`
      SELECT * FROM workspace_directories WHERE path = ?
    `).get(normalizedPath) as any
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
    const normalizedPath = path.normalize(dirPath);
    this.db.prepare(`
      UPDATE workspace_directories
      SET context_analysis = ?, is_analyzed = 1, last_analyzed_at = CURRENT_TIMESTAMP, modified_at = CURRENT_TIMESTAMP
      WHERE path = ?
    `).run(JSON.stringify(analysis), normalizedPath)
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
      this.db.prepare(`DELETE FROM workspaces WHERE workspace_id = ?`).run(targetWorkspace.workspace_id)
      
      // 清理孤儿文件记录
      this.db.prepare(`
        DELETE FROM files 
        WHERE file_fingerprint NOT IN (
          SELECT file_fingerprint FROM workspace_files WHERE file_fingerprint IS NOT NULL
        )
      `).run()
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
      const standardPath = path.resolve(filePath)
      
      let bestMatch: WorkspaceDirectory | null = null
      let maxLen = 0
      
      for (const root of roots) {
        const standardRootPath = path.resolve(root.path)
        // 使用标准路径比较
        if (standardPath === standardRootPath || standardPath.startsWith(standardRootPath + path.sep)) {
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
}
