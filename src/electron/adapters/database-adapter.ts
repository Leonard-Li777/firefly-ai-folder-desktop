/**
 * 数据库适配器实现
 * 将数据库服务 API 适配到核心引擎
 */

import { IDatabaseAdapter, DeterministicCodeGenerator } from '@firefly/core-engine'
import { databaseService } from '../runtime-services/database'
import type { LanguageCode } from '@firefly/types'
import type Database from 'better-sqlite3'
import { ConfigOrchestrator } from '@app/electron/config/config-orchestrator'
import { t } from '@app/languages'
import { getRootGroupsWithChildren } from './tag-tree-view-adapter'

/**
 * 数据库适配器
 */
export class DatabaseAdapter implements IDatabaseAdapter {
  private language: LanguageCode = 'zh-CN'

  /**
   * 获取数据库实例
   * 动态获取当前活动的数据库连接，避免持有已关闭的旧连接
   */
  getDatabase(): Database.Database {
    const currentDb = databaseService.db
    if (!currentDb) {
      throw new Error(t('数据库未初始化'))
    }
    return currentDb
  }

  /**
   * 初始化数据库连接
   */
  async initialize(): Promise<void> {
    // 仅初始化语言配置，不再缓存 db 实例
    this.language = ConfigOrchestrator.getInstance().getValue('DEFAULT_LANGUAGE')
  }

  constructor() {
    /**
     * 文件记录操作
     */
    this.files = {
      get: async (fileId: string): Promise<any | null> => {
        const db = this.getDatabase()
        // fileId 实际上是 file_fingerprint
        const stmt = db.prepare('SELECT * FROM files WHERE file_fingerprint = ?')
        return stmt.get(fileId) || null
      },

      update: async (fileId: string, data: Partial<any>): Promise<void> => {
        const db = this.getDatabase()

        // 分离不同表的字段
        const fileContentsFields = [
          'quality_score',
          'quality_confidence',
          'quality_criteria',
          'quality_reasoning',
          'content',
          'multimodal_content',
          'lrc',
          'metadata',
          'analysis_stats',
          'grouping_reason',
          'grouping_confidence'
        ]
        const workspaceFilesFields = [
          'is_analyzed',
          'analysis_error',
          'last_analyzed_at',
          'thumbnail_path',
          'parent_archive',
          'unit_id'
        ]

        const fileContentsData: Partial<any> = {}
        const filesData: Partial<any> = {}
        const workspaceFilesData: Partial<any> = {}

        Object.keys(data).forEach(key => {
          if (fileContentsFields.includes(key)) {
            fileContentsData[key] = data[key]
          } else if (workspaceFilesFields.includes(key)) {
            workspaceFilesData[key] = data[key]
          } else {
            filesData[key] = data[key]
          }
        })

        // 更新 file_contents 表（如果包含相关字段）
        if (Object.keys(fileContentsData).length > 0) {
          // 应用层字段 metadata 统一映射到 file_contents.exif 列
          const columnOf = (field: string) => (field === 'metadata' ? 'exif' : field)
          const fields = Object.keys(fileContentsData)
          const values = Object.values(fileContentsData).map(v => {
            if (typeof v === 'object' && v !== null) {
              return JSON.stringify(v)
            }
            return v
          })
          const setClause = fields.map(field => `${columnOf(field)} = ?`).join(', ')
          const stmt = db.prepare(
            `UPDATE file_contents SET ${setClause} WHERE file_fingerprint = ?`
          )
          stmt.run(...values, fileId)
        }

        // 更新 files 表（如果包含相关字段）
        if (Object.keys(filesData).length > 0) {
          const fields = Object.keys(filesData)
          const values = Object.values(filesData)
          const setClause = fields.map(field => `${field} = ?`).join(', ')
          const extraFields = data.sync_status === undefined ? ', sync_status = 0' : ''
          const stmt = db.prepare(
            `UPDATE files SET ${setClause}${extraFields}, modified_at = ? WHERE file_fingerprint = ?`
          )
          stmt.run(...values, new Date().toISOString(), fileId)
        }

        // 更新 workspace_files 表（如果包含相关字段）
        if (Object.keys(workspaceFilesData).length > 0) {
          const fields = Object.keys(workspaceFilesData)
          const values = Object.values(workspaceFilesData)
          const setClause = fields.map(field => `${field} = ?`).join(', ')
          const stmt = db.prepare(
            `UPDATE workspace_files SET ${setClause}, modified_at = ? WHERE file_fingerprint = ?`
          )
          stmt.run(...values, new Date().toISOString(), fileId)
        }
      },

      getByPath: async (filePath: string): Promise<any | null> => {
        const db = this.getDatabase()
        const stmt = db.prepare('SELECT * FROM files WHERE path = ?')
        return stmt.get(filePath) || null
      },

      getBatch: async (fileIds: string[]): Promise<any[]> => {
        if (fileIds.length === 0) return []
        const db = this.getDatabase()
        const placeholders = fileIds.map(() => '?').join(',')
        const stmt = db.prepare(`SELECT * FROM files WHERE file_fingerprint IN (${placeholders})`)
        return stmt.all(...fileIds)
      }
    }

    /**
     * 维度操作
     *
     * 创世 Baseline V1：维度由 file_tags 标签树的根节点（parent_codes 为空）表达，
     * 其直属子节点即该维度的标签集。此处对外保持「维度」语义的读写接口。
     */
    this.dimensions = {
      getAll: async (): Promise<any[]> => {
        const db = this.getDatabase()
        // 视图分组统一收口 TagTreeViewAdapter：根=parent_codes 为空，子节点多父全挂（禁 parent_codes[0] 首父推导）
        return getRootGroupsWithChildren(db).map(r => ({
          id: r.code,
          name: r.name,
          level: r.depth,
          tags: JSON.stringify(r.children.map(c => c.name)),
          description: r.description,
          metadata: r.meta
        }))
      },

      create: async (dimension: any): Promise<void> => {
        const db = this.getDatabase()
        const code = dimension.id || dimension.code
        if (!code) return
        db.prepare(
          `
          INSERT OR IGNORE INTO file_tags_private (
            code, name, parent_codes, file_groups, source, meta, description
          ) VALUES (?, ?, '[]', ?, ?, ?, ?)
        `
        ).run(
          code,
          dimension.name || code,
          JSON.stringify(dimension.applicableFileTypes || []),
          dimension.isAIGenerated ? 'expanded' : 'user',
          JSON.stringify({
            isLeaf: false,
            isSystem: !dimension.isAIGenerated,
            isMultiSelect: true,
            ...(dimension.metadata || {})
          }),
          dimension.description || null
        )
      },

      update: async (dimensionId: string, data: Partial<any>): Promise<void> => {
        const db = this.getDatabase()
        // 仅允许更新标签树真实存在的列，避免动态 SQL 注入不存在的列名
        const setClauses: string[] = []
        const values: any[] = []
        if (data.name !== undefined) {
          setClauses.push('name = ?')
          values.push(data.name)
        }
        if (data.description !== undefined) {
          setClauses.push('description = ?')
          values.push(data.description)
        }
        if (data.metadata !== undefined || data.level !== undefined) {
          const baseMeta =
            typeof data.metadata === 'object' && data.metadata !== null
              ? { ...data.metadata }
              : typeof data.metadata === 'string'
                ? (() => {
                    try {
                      return JSON.parse(data.metadata)
                    } catch {
                      return {}
                    }
                  })()
                : {}
          if (data.level !== undefined) {
            baseMeta.level = data.level
          }
          setClauses.push('meta = ?')
          values.push(JSON.stringify(baseMeta))
        }
        if (data.applicableFileTypes !== undefined) {
          setClauses.push('file_groups = ?')
          values.push(JSON.stringify(data.applicableFileTypes))
        }
        if (setClauses.length === 0) return
        db.prepare(`UPDATE file_tags_private SET ${setClauses.join(', ')} WHERE code = ?`).run(
          ...values,
          dimensionId
        )
      },

      getById: async (dimensionId: string): Promise<any | null> => {
        const db = this.getDatabase()
        const row = db.prepare('SELECT * FROM file_tags_private WHERE code = ?').get(dimensionId) as any
        return row || null
      }
    }
  }

  /**
   * 文件记录操作
   */
  files: any

  /**
   * 维度操作
   */
  dimensions: any

  /**
   * 按工作区 ID 获取文件
   */
  async getFilesByWorkspaceId(workspaceId: number): Promise<any[]> {
    const db = this.getDatabase()
    return db.prepare('SELECT * FROM workspace_files WHERE workspace_id = ?').all(workspaceId)
  }
}

/**
 * 创建数据库适配器实例
 */
export async function createDatabaseAdapter(): Promise<IDatabaseAdapter> {
  const adapter = new DatabaseAdapter()
  await adapter.initialize()
  return adapter
}
