import {
  DimensionGroupsResponse,
  FileItem,
  FilteredFilesResponse,
  SavedAnalyzedDirectory,
  SelectedTag
} from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'

import Database from 'better-sqlite3'
import { DimensionManager } from './DimensionManager'
import { FileFilter } from './FileFilter'
import { LinkManager } from './LinkManager'
import { PersistenceManager } from './PersistenceManager'
import { databaseService } from '../../database/database-service'
import path from 'node:path'

export class AnalyzedDirectoryService {
  private _db: Database.Database | null = null
  private _dimensionManager: DimensionManager | null = null
  private _fileFilter: FileFilter | null = null
  private _linkManager: LinkManager | null = null
  private _persistenceManager: PersistenceManager | null = null
  private _initialized = false

  private _customDb = false

  constructor(db?: Database.Database) {
    if (db) {
      this._db = db
      this._customDb = true
      this.initDelegates()
      this._initialized = true
    }
  }

  private ensureInitialized() {
    if (this._customDb && this._db) return
    if (this._initialized && this._db === databaseService.db) return
    this._db = databaseService.db
    if (!this._db) throw new Error('[AnalyzedDirectoryService] Database not initialized')
    this.initDelegates()
    this._initialized = true
  }

  private initDelegates() {
    const db = this._db!
    this._dimensionManager = new DimensionManager(db)
    this._fileFilter = new FileFilter(db, tag => this._dimensionManager!.getExtensionsForTag(tag))
    this._linkManager = new LinkManager(
      db,
      params => this._fileFilter!.getFilteredFiles(params),
      async _virtualDirPath => {}
    )
    this._persistenceManager = new PersistenceManager(db)
  }

  private get dimensionManager() {
    this.ensureInitialized()
    return this._dimensionManager!
  }

  private get fileFilter() {
    this.ensureInitialized()
    return this._fileFilter!
  }

  private get linkManager() {
    this.ensureInitialized()
    return this._linkManager!
  }

  private get persistenceManager() {
    this.ensureInitialized()
    return this._persistenceManager!
  }

  private get db(): Database.Database {
    this.ensureInitialized()
    return this._db!
  }

  /**
   * 重置服务状态，在数据库重新初始化后调用（如语言切换）
   */
  reset(): void {
    this._db = null
    this._dimensionManager = null
    this._fileFilter = null
    this._linkManager = null
    this._persistenceManager = null
    this._initialized = false
  }

  // ─── 维度/过滤相关 ──────────────────────────────────────────────

  async getDimensionGroups(
    options?: import('@firefly/types').GetDimensionGroupsOptions | string,
    language?: string
  ): Promise<DimensionGroupsResponse> {
    return this.dimensionManager.getDimensionGroups(options, language)
  }

  async getAnalyzedFilesCount(workspaceDirectoryPath?: string): Promise<number> {
    return this.fileFilter.getAnalyzedFilesCount(workspaceDirectoryPath)
  }

  async getFilteredFilesPaged(params: any): Promise<FilteredFilesResponse> {
    return this.fileFilter.getFilteredFilesPaged(params)
  }

  async getFilteredFiles(params: any): Promise<FileItem[]> {
    return this.fileFilter.getFilteredFiles(params)
  }

  async getSavedDirectories(
    workspaceDirectoryId: number | string
  ): Promise<SavedAnalyzedDirectory[]> {
    try {
      let resolvedId: number
      if (typeof workspaceDirectoryId === 'string') {
        const workspaceResult = this.db
          .prepare('SELECT id FROM workspace_directories WHERE path = ?')
          .get(workspaceDirectoryId) as any
        if (!workspaceResult) return []
        resolvedId = workspaceResult.id
      } else {
        resolvedId = workspaceDirectoryId
      }
      const rows = this.db
        .prepare(
          'SELECT * FROM analyzed_directories WHERE workspace_id = ? ORDER BY sort_order ASC'
        )
        .all(resolvedId)
      return rows.map((r: any) => ({
        ...r,
        filter: JSON.parse(r.filters),
        workspaceId: r.workspace_id,
        parentId: r.parent_id || null,
        createdAt: new Date(r.created_at),
        updatedAt: new Date(r.updated_at)
      })) as any[]
    } catch (error) {
      logger.error(
        LogCategory.VIRTUAL_DIRECTORY,
        'Failed to get saved analyzed directories:',
        error
      )
      return []
    }
  }

  async saveDirectory(
    directory: SavedAnalyzedDirectory,
    workspaceDirectoryPath: string | undefined
  ): Promise<SavedAnalyzedDirectory> {
    const filters = JSON.stringify(directory.filter)
    this.db
      .prepare(
        `
      INSERT INTO analyzed_directories (id, workspace_id, name, filters, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        filters = excluded.filters,
        sort_order = excluded.sort_order,
        updated_at = excluded.updated_at
    `
      )
      .run(
        directory.id,
        directory.workspaceId,
        directory.name,
        filters,
        (directory as any).sort_order || 0,
        new Date().toISOString(),
        new Date().toISOString()
      )
    return directory
  }

  async batchSaveDirectories(directories: any[], workspaceDirectoryPath?: string): Promise<any[]> {
    return this.db.transaction(() => {
      const result: any[] = []
      let resolvedWorkspaceId: number | undefined = undefined
      if (workspaceDirectoryPath) {
        const workspaceResult = this.db
          .prepare('SELECT id FROM workspace_directories WHERE path = ?')
          .get(workspaceDirectoryPath) as any
        if (workspaceResult) {
          resolvedWorkspaceId = workspaceResult.id
        }
      }
      for (const d of directories) {
        if (!d.id) {
          const generatedId = `vdir-${Date.now()}-${Math.random().toString(36).substring(7)}`
          const saved: SavedAnalyzedDirectory = {
            id: generatedId,
            name: d.name,
            filter: d.filter || d.filters || {},
            workspaceId: resolvedWorkspaceId || d.workspaceId || 0,
            createdAt: new Date(),
            updatedAt: new Date()
          }
          this.saveDirectory(saved, workspaceDirectoryPath)
          result.push({ name: d.name, path: d.path ? d.path.join('/') : d.name })
        } else {
          this.saveDirectory(d, workspaceDirectoryPath)
          result.push(d)
        }
      }
      return result
    })()
  }

  async deleteDirectory(directoryId: number | string): Promise<void> {
    this.db.prepare('DELETE FROM analyzed_directories WHERE id = ?').run(directoryId)
  }

  async renameDirectory(directoryId: number | string, newName: string): Promise<void> {
    this.db
      .prepare('UPDATE analyzed_directories SET name = ?, updated_at = ? WHERE id = ?')
      .run(newName, new Date().toISOString(), directoryId)
  }

  async isFirst(workspaceDirectoryPath: string): Promise<boolean> {
    const count = this.db
      .prepare(
        'SELECT COUNT(*) as count FROM analyzed_directories WHERE workspace_id = (SELECT id FROM workspace_directories WHERE path = ? LIMIT 1)'
      )
      .get(workspaceDirectoryPath) as any
    return count.count === 0
  }

  async isFirstVirtualDirectory(workspaceDirectoryPath: string): Promise<boolean> {
    return this.isFirst(workspaceDirectoryPath)
  }

  async cleanup(workspaceDirectoryPath: string): Promise<void> {
    return this.linkManager.cleanupVirtualDirectory(workspaceDirectoryPath)
  }

  async cleanupVirtualDirectory(workspaceDirectoryPath: string): Promise<void> {
    return this.cleanup(workspaceDirectoryPath)
  }

  async getPrivateAnalyzedFilesCount(workspaceDirectoryPath: string): Promise<number> {
    return this.getAnalyzedFilesCount(workspaceDirectoryPath)
  }

  async findFirstHardlink(filePath: string, workspacePath: string): Promise<string | null> {
    return this.linkManager.findFirstHardlink(filePath, workspacePath)
  }
}

export const analyzedDirectoryService = new AnalyzedDirectoryService()
