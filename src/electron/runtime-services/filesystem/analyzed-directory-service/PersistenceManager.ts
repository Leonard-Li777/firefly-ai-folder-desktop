import Database from 'better-sqlite3'
import { SavedVirtualDirectory } from '@firefly/types'
import { logger, LogCategory } from '@firefly/shared'
import { t } from '@app/languages'

export class PersistenceManager {
  constructor(private db: Database.Database) {}

  async saveDirectory(
    directory: SavedVirtualDirectory,
    workspaceDirectoryPath: string
  ): Promise<void> {
    const directoryResult = this.db
      .prepare('SELECT id FROM workspace_directories WHERE path = ?')
      .get(workspaceDirectoryPath) as any
    if (!directoryResult)
      throw new Error(t('工作目录不存在: {workspaceDirectoryPath}', { workspaceDirectoryPath }))

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO analyzed_directories (id, name, description, filters, parent_id, workspace_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      directory.id,
      directory.name,
      directory.description || null,
      JSON.stringify(directory.filter),
      directory.parentId || null,
      directoryResult.id,
      directory.createdAt.toISOString(),
      directory.updatedAt.toISOString()
    )
  }

  async batchSaveDirectories(
    directories: Array<{ name: string; filter: any; path: string[] }>,
    workspaceDirectoryPath: string,
    saveFn: (d: SavedVirtualDirectory) => Promise<any>
  ): Promise<Array<{ name: string; path: string }>> {
    const res: any[] = []
    const workspaceId = (
      this.db
        .prepare('SELECT id FROM workspace_directories WHERE path = ?')
        .get(workspaceDirectoryPath) as any
    )?.id
    if (!workspaceId) return res
    for (const d of directories) {
      const saved: SavedVirtualDirectory = {
        id: `vdir-${Date.now()}-${Math.random().toString(36).substring(7)}`,
        name: d.name,
        filter: d.filter,
        workspaceId,
        parentId: null,
        createdAt: new Date(),
        updatedAt: new Date()
      }
      await saveFn(saved)
      res.push({ name: d.name, path: d.path.join('/') })
    }
    return res
  }

  async getSavedDirectories(workspaceDirectoryPath?: string): Promise<SavedVirtualDirectory[]> {
    let query = `SELECT id, name, description, filters, parent_id, workspace_id, created_at, updated_at FROM analyzed_directories`
    const params: any[] = []
    if (workspaceDirectoryPath) {
      query += ' WHERE workspace_id = (SELECT id FROM workspace_directories WHERE path = ?)'
      params.push(workspaceDirectoryPath)
    }
    query += ' ORDER BY created_at DESC'
    const directories = this.db.prepare(query).all(...params) as any[]
    return directories.map(dir => ({
      id: dir.id,
      name: dir.name,
      description: dir.description || undefined,
      filter: JSON.parse(dir.filters),
      parentId: dir.parent_id || null,
      workspaceId: dir.workspace_id,
      createdAt: new Date(dir.created_at),
      updatedAt: new Date(dir.updated_at)
    }))
  }

  async deleteDirectory(id: string): Promise<any> {
    const dirInfo = this.db
      .prepare('SELECT filters FROM analyzed_directories WHERE id = ?')
      .get(id) as any
    this.db.prepare('DELETE FROM analyzed_directories WHERE id = ?').run(id)
    return dirInfo
  }

  async renameDirectory(id: string, newName: string): Promise<void> {
    this.db
      .prepare('UPDATE analyzed_directories SET name = ?, updated_at = ? WHERE id = ?')
      .run(newName, new Date().toISOString(), id)
  }

  async isFirstVirtualDirectory(workspaceDirectoryPath?: string): Promise<boolean> {
    let query = 'SELECT COUNT(*) as count FROM analyzed_directories'
    const params: any[] = []
    if (workspaceDirectoryPath) {
      query += ' WHERE workspace_id = (SELECT id FROM workspace_directories WHERE path = ?)'
      params.push(workspaceDirectoryPath)
    }
    return (this.db.prepare(query).get(...params) as any).count === 1
  }
}
