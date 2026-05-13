import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { WorkspaceDao } from '../workspace-dao'

describe('WorkspaceDao', () => {
  let db: Database.Database
  let dao: WorkspaceDao

  beforeEach(() => {
    db = new Database(':memory:')

    // Create the workspaces table
    db.exec(`
      CREATE TABLE workspaces (
        workspace_id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        is_active INTEGER DEFAULT 0,
        auto_watch INTEGER DEFAULT 0,
        last_scan_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `)

    dao = new WorkspaceDao(db)
  })

  afterEach(() => {
    db.close()
  })

  describe('getById', () => {
    it('should return null if the workspace does not exist', async () => {
      const result = await dao.getById(999)
      expect(result).toBeNull()
    })

    it('should return the correct workspace if it exists', async () => {
      // Insert a test workspace
      const info = db.prepare(`
        INSERT INTO workspaces (path, name, type, is_active, auto_watch, created_at)
        VALUES ('/test/path', 'Test Workspace', 'SPEEDY', 1, 0, '2023-01-01 00:00:00')
      `).run()

      const workspaceId = info.lastInsertRowid as number

      const result = await dao.getById(workspaceId)

      expect(result).not.toBeNull()
      expect(result?.id).toBe(workspaceId)
      expect(result?.path).toBe('/test/path')
      expect(result?.name).toBe('Test Workspace')
      expect(result?.type).toBe('SPEEDY')
      expect(result?.isActive).toBe(true)
      expect(result?.autoWatch).toBe(false)
    })
  })
})
