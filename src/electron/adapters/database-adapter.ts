/**
 * 数据库适配器实现
 * 将数据库服务 API 适配到核心引擎
 */

import { IDatabaseAdapter } from '@yonuc/core-engine'
import { databaseService } from '../runtime-services/database'
import type { LanguageCode } from '@yonuc/types'
import type Database from 'better-sqlite3'
import { configService } from '../runtime-services/config'

/**
 * 数据库适配器
 */
export class DatabaseAdapter implements IDatabaseAdapter {
  // private db: Database.Database | null = null // 移除缓存的 db 引用
  private language: LanguageCode = 'zh-CN'
  
  /**
   * 获取数据库实例
   * 动态获取当前活动的数据库连接，避免持有已关闭的旧连接
   */
  getDatabase(): Database.Database {
    const currentDb = databaseService.db
    if (!currentDb) {
      throw new Error('数据库未初始化')
    }
    return currentDb
  }

  /**
   * 初始化数据库连接
   */
  async initialize(): Promise<void> {
    // 仅初始化语言配置，不再缓存 db 实例
    this.language = configService.getValue('DEFAULT_LANGUAGE')
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
        const fileContentsFields = ['quality_score', 'quality_confidence', 'quality_criteria', 'quality_reasoning', 'content', 'multimodal_content', 'lrc', 'metadata', 'analysis_stats', 'grouping_reason', 'grouping_confidence']
        const workspaceFilesFields = ['is_analyzed', 'analysis_error', 'last_analyzed_at', 'thumbnail_path', 'parent_archive', 'unit_id']
        
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
          const fields = Object.keys(fileContentsData)
          const values = Object.values(fileContentsData).map(v => {
            // 确保对象类型被正确序列化，但避免对已序列化的字符串再次序列化
            // 只对非字符串的对象进行序列化
            if (typeof v === 'object' && v !== null) {
              return JSON.stringify(v)
            }
            return v
          })
          const setClause = fields.map((field) => `${field} = ?`).join(', ')

          // fileId 就是 file_fingerprint
          const stmt = db.prepare(`UPDATE file_contents SET ${setClause} WHERE file_fingerprint = ?`)
          stmt.run(...values, fileId)
        }

        // 更新 files 表（如果包含相关字段）
        if (Object.keys(filesData).length > 0) {
          const fields = Object.keys(filesData)
          const values = Object.values(filesData)
          const setClause = fields.map((field) => `${field} = ?`).join(', ')
          const extraFields = data.sync_status === undefined ? ', sync_status = 0' : ''
          // fileId 就是 file_fingerprint
          // V2 schema 使用 modified_at 而不是 updated_at
          const stmt = db.prepare(`UPDATE files SET ${setClause}${extraFields}, modified_at = CURRENT_TIMESTAMP WHERE file_fingerprint = ?`)
          stmt.run(...values, fileId)
        }

        // 更新 workspace_files 表（如果包含相关字段）
        if (Object.keys(workspaceFilesData).length > 0) {
          const fields = Object.keys(workspaceFilesData)
          const values = Object.values(workspaceFilesData)
          const setClause = fields.map((field) => `${field} = ?`).join(', ')
          // fileId 就是 file_fingerprint
          // workspace_files 表使用 modified_at
          const stmt = db.prepare(`UPDATE workspace_files SET ${setClause}, modified_at = CURRENT_TIMESTAMP WHERE file_fingerprint = ?`)
          stmt.run(...values, fileId)
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
        // fileIds 是 file_fingerprints
        const stmt = db.prepare(`SELECT * FROM files WHERE file_fingerprint IN (${placeholders})`)
        return stmt.all(...fileIds)
      },
    }

    /**
     * 维度操作
     */
    this.dimensions = {
      getAll: async (): Promise<any[]> => {
        const db = this.getDatabase()
        const stmt = db.prepare('SELECT * FROM file_dimensions ORDER BY level ASC')
        return stmt.all()
      },

      create: async (dimension: any): Promise<void> => {
        const db = this.getDatabase()
        const stmt = db.prepare(`
          INSERT INTO file_dimensions (
            id, level, tags, trigger_conditions,
            is_ai_generated, description, applicable_file_types, context_hints
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)

        stmt.run(
          dimension.id,
          dimension.level,
          JSON.stringify(dimension.tags || []),
          JSON.stringify(dimension.triggerConditions || []),
          dimension.isAIGenerated ? 1 : 0,
          dimension.description || null,
          JSON.stringify(dimension.applicableFileTypes || []),
          JSON.stringify(dimension.contextHints || [])
        )
      },

      update: async (dimensionId: string, data: Partial<any>): Promise<void> => {
        const db = this.getDatabase()
        const fields = Object.keys(data)
        const values = Object.values(data).map((v) =>
          typeof v === 'object' && v !== null ? JSON.stringify(v) : v
        )

        if (fields.length === 0) return

        const setClause = fields.map((field) => `${field} = ?`).join(', ')
        const stmt = db.prepare(`UPDATE file_dimensions SET ${setClause}, sync_status = 0 WHERE id = ?`)
        stmt.run(...values, dimensionId)
      },

      getById: async (dimensionId: string): Promise<any | null> => {
        const db = this.getDatabase()
        const stmt = db.prepare('SELECT * FROM file_dimensions WHERE id = ?')
        return stmt.get(dimensionId) || null
      },
    }

    /**
     * 维度扩展操作
     */
    this.dimensionExpansions = {
      create: async (expansion: any): Promise<void> => {
        const db = this.getDatabase()
        const stmt = db.prepare(`
          INSERT INTO dimension_expansions (
            id, name, level, tags, trigger_conditions, description
          ) VALUES (?, ?, ?, ?, ?, ?)
        `)

        stmt.run(
          expansion.id,
          expansion.name,
          expansion.level || 2,
          JSON.stringify(expansion.tags || []),
          JSON.stringify(expansion.triggerConditions || []),
          expansion.description || null
        )
      },

      getById: async (expansionId: string): Promise<any | null> => {
        const db = this.getDatabase()
        const stmt = db.prepare('SELECT * FROM dimension_expansions WHERE id = ?')
        return stmt.get(expansionId) || null
      },

      approve: async (expansionId: string): Promise<void> => {
        const db = this.getDatabase()
        const expansion = db.prepare('SELECT * FROM dimension_expansions WHERE id = ?').get(expansionId) as any
        if (expansion) {
          db.transaction(() => {
            db.prepare(`
              INSERT OR REPLACE INTO file_dimensions (
                id, level, tags, trigger_conditions, is_ai_generated, description, sync_status
              ) VALUES (?, ?, ?, ?, 1, ?, 0)
            `).run(expansion.id, expansion.level, expansion.tags, expansion.trigger_conditions, expansion.description)
            db.prepare('DELETE FROM dimension_expansions WHERE id = ?').run(expansionId)
          })()
        }
      },

      reject: async (expansionId: string): Promise<void> => {
        const db = this.getDatabase()
        db.prepare('DELETE FROM dimension_expansions WHERE id = ?').run(expansionId)
      },

      getPending: async (): Promise<any[]> => {
        const db = this.getDatabase()
        const stmt = db.prepare(`SELECT * FROM dimension_expansions`)
        return stmt.all()
      },
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
   * 维度扩展操作
   */
  dimensionExpansions: any
}

/**
 * 创建数据库适配器实例
 */
export async function createDatabaseAdapter(): Promise<IDatabaseAdapter> {
  const adapter = new DatabaseAdapter()
  await adapter.initialize()
  return adapter
}
