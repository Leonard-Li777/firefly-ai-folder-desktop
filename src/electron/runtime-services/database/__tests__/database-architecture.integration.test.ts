/**
 * 数据库架构集成测试
 * 测试 V2.2 架构下的关键场景，确保各组件协同工作正常
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { DatabaseService } from '../database-service'

describe('数据库架构集成测试', () => {
  let dbService: DatabaseService
  let tempDbPath: string
  let tempWorkspacePath: string

  beforeAll(async () => {
    // 创建临时数据库文件
    tempDbPath = path.join(os.tmpdir(), `test-db-${Date.now()}.db`)
    dbService = new DatabaseService(tempDbPath)
    await dbService.initialize('zh-CN')

    // 创建临时工作目录
    tempWorkspacePath = path.join(os.tmpdir(), `test-workspace-${Date.now()}`)
    fs.mkdirSync(tempWorkspacePath, { recursive: true })
  })

  afterAll(async () => {
    // 清理临时文件
    if (fs.existsSync(tempDbPath)) {
      fs.unlinkSync(tempDbPath)
    }
    if (fs.existsSync(tempWorkspacePath)) {
      fs.rmSync(tempWorkspacePath, { recursive: true, force: true })
    }
  })

  describe('虚拟目录表存在性', () => {
    it('应该存在 virtual_directories 表', () => {
      const db = dbService.db
      expect(db).toBeDefined()

      const tableExists = db!.prepare(`
        SELECT count(*) as count FROM sqlite_master 
        WHERE type='table' AND name='virtual_directories'
      `).get() as any

      expect(tableExists.count).toBeGreaterThan(0)
    })

    it('应该能够插入和查询虚拟目录', () => {
      const db = dbService.db!

      // 先插入一个工作区
      db.prepare(`
        INSERT OR IGNORE INTO workspaces (path, name, type)
        VALUES (?, ?, 'SPEEDY')
      `).run(tempWorkspacePath, 'Test Workspace')

      const workspace = db.prepare(
        'SELECT workspace_id FROM workspaces WHERE path = ?'
      ).get(tempWorkspacePath) as any

      expect(workspace).toBeDefined()

      // 插入一个目录
      db.prepare(`
        INSERT OR IGNORE INTO workspace_directories (workspace_id, path, name)
        VALUES (?, ?, ?)
      `).run(workspace.workspace_id, tempWorkspacePath, 'Test Workspace Dir')

      const workspaceDir = db.prepare(
        'SELECT id FROM workspace_directories WHERE path = ?'
      ).get(tempWorkspacePath) as any

      expect(workspaceDir).toBeDefined()

      // 插入虚拟目录
      const virtualDirId = `test-vdir-${Date.now()}`
      db.prepare(`
        INSERT INTO virtual_directories (id, name, filters, parent_id, workspace_id)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        virtualDirId,
        'Test Virtual Dir',
        JSON.stringify({ selectedTags: [], sortBy: 'name', sortOrder: 'asc' }),
        null,
        workspaceDir.id
      )

      // 查询虚拟目录
      const virtualDir = db.prepare(
        'SELECT * FROM virtual_directories WHERE id = ?'
      ).get(virtualDirId) as any

      expect(virtualDir).toBeDefined()
      expect(virtualDir.name).toBe('Test Virtual Dir')
      expect(virtualDir.workspace_id).toBe(workspaceDir.id)
    })
  })

  describe('文件路径兼容性', () => {
    it('应该能够处理 Windows 反斜杠路径', () => {
      const db = dbService.db!
      const windowsPath = 'F:\\lilun\\Desktop\\图片'
      const normalizedName = '图片'

      // 先插入一个工作区
      db.prepare(`
        INSERT OR IGNORE INTO workspaces (path, name, type)
        VALUES (?, ?, 'SPEEDY')
      `).run('F:\\lilun\\Desktop', 'Test Root')

      const workspace = db.prepare(
        'SELECT workspace_id FROM workspaces WHERE path = ?'
      ).get('F:\\lilun\\Desktop') as any

      // 插入目录
      db.prepare(`
        INSERT OR IGNORE INTO workspace_directories (workspace_id, path, name)
        VALUES (?, ?, ?)
      `).run(workspace.workspace_id, windowsPath, normalizedName)

      // 查询目录分析结果
      const result = db.prepare(
        'SELECT * FROM workspace_directories WHERE path = ?'
      ).get(windowsPath) as any

      expect(result).toBeDefined()
      expect(result.name).toBe(normalizedName)
    })

    it('应该能够处理正斜杠路径', () => {
      const db = dbService.db!
      const posixPath = '/Users/test/Desktop/images'
      const normalizedName = 'images'

      // 先插入一个工作区
      db.prepare(`
        INSERT OR IGNORE INTO workspaces (path, name, type)
        VALUES (?, ?, 'SPEEDY')
      `).run('/Users/test/Desktop', 'Test Root')

      const workspace = db.prepare(
        'SELECT workspace_id FROM workspaces WHERE path = ?'
      ).get('/Users/test/Desktop') as any

      // 插入目录
      db.prepare(`
        INSERT OR IGNORE INTO workspace_directories (workspace_id, path, name)
        VALUES (?, ?, ?)
      `).run(workspace.workspace_id, posixPath, normalizedName)

      // 查询目录分析结果
      const result = db.prepare(
        'SELECT * FROM workspace_directories WHERE path = ?'
      ).get(posixPath) as any

      expect(result).toBeDefined()
      expect(result.name).toBe(normalizedName)
    })
  })

  describe('三表架构字段路由', () => {
    it('应该正确路由 file_contents 表字段', () => {
      const db = dbService.db!

      // 创建测试文件和相关内容
      const fingerprint = `test-fingerprint-${Date.now()}`

      db.prepare(`
        INSERT INTO files (file_fingerprint, smart_name, size, type, mime_type, created_at, modified_at, accessed_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(fingerprint, 'test.txt', 100, 'txt', 'text/plain')

      db.prepare(`
        INSERT INTO file_contents (file_fingerprint, content, quality_score, quality_confidence)
        VALUES (?, ?, ?, ?)
      `).run(fingerprint, 'Test content', 8.5, 0.9)

      // 查询 file_contents 表
      const contentResult = db.prepare(
        'SELECT * FROM file_contents WHERE file_fingerprint = ?'
      ).get(fingerprint) as any

      expect(contentResult).toBeDefined()
      expect(contentResult.quality_score).toBe(8.5)
      expect(contentResult.quality_confidence).toBe(0.9)
      expect(contentResult.content).toBe('Test content')
    })

    it('应该正确路由 workspace_files 表字段', () => {
      const db = dbService.db!

      // 创建测试工作文件
      const fingerprint = `test-fingerprint-wf-${Date.now()}`
      const filePath = path.join(tempWorkspacePath, 'test-file.txt')

      // 确保工作区存在
      db.prepare(`
        INSERT OR IGNORE INTO workspaces (path, name, type)
        VALUES (?, ?, 'SPEEDY')
      `).run(tempWorkspacePath, 'Test Workspace')

      const workspace = db.prepare(
        'SELECT workspace_id FROM workspaces WHERE path = ?'
      ).get(tempWorkspacePath) as any

      // 确保工作目录存在
      db.prepare(`
        INSERT OR IGNORE INTO workspace_directories (workspace_id, path, name)
        VALUES (?, ?, ?)
      `).run(workspace.workspace_id, tempWorkspacePath, 'Test Workspace')

      const workspaceDir = db.prepare(
        'SELECT id FROM workspace_directories WHERE path = ?'
      ).get(tempWorkspacePath) as any

      db.prepare(`
        INSERT INTO files (file_fingerprint, smart_name, size, type, mime_type, created_at, modified_at, accessed_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(fingerprint, 'test-file.txt', 100, 'txt', 'text/plain')

      db.prepare(`
        INSERT INTO workspace_files (file_fingerprint, workspace_id, directory_id, path, name, is_analyzed)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(fingerprint, workspace.workspace_id, workspaceDir.id, filePath, 'test-file.txt', 1)

      // 查询 workspace_files 表
      const wfResult = db.prepare(
        'SELECT * FROM workspace_files WHERE file_fingerprint = ?'
      ).get(fingerprint) as any

      expect(wfResult).toBeDefined()
      expect(wfResult.is_analyzed).toBe(1)
      expect(wfResult.path).toBe(filePath)
    })
  })

  describe('目录上下文分析', () => {
    it('应该能够保存和查询目录上下文分析', () => {
      const db = dbService.db!
      const dirPath = path.join(tempWorkspacePath, 'context-test')

      // 确保工作区存在
      db.prepare(`
        INSERT OR IGNORE INTO workspaces (path, name, type)
        VALUES (?, ?, 'SPEEDY')
      `).run(tempWorkspacePath, 'Test Workspace')

      const workspace = db.prepare(
        'SELECT workspace_id FROM workspaces WHERE path = ?'
      ).get(tempWorkspacePath) as any

      // 插入目录
      db.prepare(`
        INSERT OR IGNORE INTO workspace_directories (workspace_id, path, name)
        VALUES (?, ?, ?)
      `).run(workspace.workspace_id, dirPath, 'Context Test')

      // 保存上下文分析
      const analysisData = {
        directoryType: '测试目录',
        fileTypeDistribution: { 'txt': 10, 'jpg': 5 },
        analysisStrategy: '测试策略',
        confidence: 0.95
      }

      db.prepare(`
        UPDATE workspace_directories
        SET context_analysis = ?, is_analyzed = 1, last_analyzed_at = CURRENT_TIMESTAMP
        WHERE path = ?
      `).run(JSON.stringify(analysisData), dirPath)

      // 查询上下文分析
      const result = db.prepare(
        'SELECT context_analysis, is_analyzed FROM workspace_directories WHERE path = ?'
      ).get(dirPath) as any

      expect(result).toBeDefined()
      expect(result.is_analyzed).toBe(1)
      
      const contextAnalysis = JSON.parse(result.context_analysis)
      expect(contextAnalysis.directoryType).toBe('测试目录')
      expect(contextAnalysis.confidence).toBe(0.95)
    })
  })

  describe('文件操作时序', () => {
    it('应该在文件移动后正确更新路径', () => {
      const db = dbService.db!
      const oldPath = path.join(tempWorkspacePath, 'old-location', 'file.txt')
      const newPath = path.join(tempWorkspacePath, 'new-location', 'file.txt')
      const fingerprint = `test-fingerprint-move-${Date.now()}`

      // 确保工作区存在
      db.prepare(`
        INSERT OR IGNORE INTO workspaces (path, name, type)
        VALUES (?, ?, 'SPEEDY')
      `).run(tempWorkspacePath, 'Test Workspace')

      const workspace = db.prepare(
        'SELECT workspace_id FROM workspaces WHERE path = ?'
      ).get(tempWorkspacePath) as any

      // 创建目录
      const oldDir = path.join(tempWorkspacePath, 'old-location')
      const newDir = path.join(tempWorkspacePath, 'new-location')
      fs.mkdirSync(oldDir, { recursive: true })
      fs.mkdirSync(newDir, { recursive: true })

      db.prepare(`
        INSERT OR IGNORE INTO workspace_directories (workspace_id, path, name)
        VALUES (?, ?, ?)
      `).run(workspace.workspace_id, oldDir, 'Old Location')

      db.prepare(`
        INSERT OR IGNORE INTO workspace_directories (workspace_id, path, name)
        VALUES (?, ?, ?)
      `).run(workspace.workspace_id, newDir, 'New Location')

      const oldDirRecord = db.prepare(
        'SELECT id FROM workspace_directories WHERE path = ?'
      ).get(oldDir) as any

      const newDirRecord = db.prepare(
        'SELECT id FROM workspace_directories WHERE path = ?'
      ).get(newDir) as any

      // 创建文件记录
      db.prepare(`
        INSERT INTO files (file_fingerprint, smart_name, size, type, mime_type, created_at, modified_at, accessed_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `).run(fingerprint, 'file.txt', 100, 'txt', 'text/plain')

      db.prepare(`
        INSERT INTO workspace_files (file_fingerprint, workspace_id, directory_id, path, name, is_analyzed)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(fingerprint, workspace.workspace_id, oldDirRecord.id, oldPath, 'file.txt', 1)

      // 模拟文件移动：更新路径
      db.prepare(`
        UPDATE workspace_files 
        SET path = ?, directory_id = ?, modified_at = CURRENT_TIMESTAMP
        WHERE file_fingerprint = ?
      `).run(newPath, newDirRecord.id, fingerprint)

      // 验证路径已更新
      const result = db.prepare(
        'SELECT path, directory_id FROM workspace_files WHERE file_fingerprint = ?'
      ).get(fingerprint) as any

      expect(result.path).toBe(newPath)
      expect(result.directory_id).toBe(newDirRecord.id)
    })
  })
})
