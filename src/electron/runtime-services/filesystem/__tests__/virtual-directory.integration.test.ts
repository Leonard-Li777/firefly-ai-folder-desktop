/**
 * 虚拟目录集成测试
 * 测试虚拟目录生成和管理的完整流程
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import Database from 'better-sqlite3'
import { VirtualDirectoryService } from '../virtual-directory-service'

describe('虚拟目录集成测试', () => {
  let db: Database.Database
  let dbPath: string
  let workspacePath: string
  let vDirService: VirtualDirectoryService

  beforeAll(() => {
    // 创建临时数据库
    dbPath = path.join(os.tmpdir(), `test-vdir-db-${Date.now()}.db`)
    db = new Database(dbPath)

    // 初始化数据库表
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspaces (
        workspace_id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'SPEEDY'
      );

      CREATE TABLE IF NOT EXISTS workspace_directories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'SPEEDY',
        context_analysis TEXT,
        is_analyzed BOOLEAN NOT NULL DEFAULT 0,
        last_analyzed_at DATETIME
      );

      CREATE TABLE IF NOT EXISTS virtual_directories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        filters TEXT NOT NULL,
        parent_id TEXT,
        workspace_id INTEGER NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (workspace_id) REFERENCES workspace_directories(id) ON DELETE CASCADE,
        FOREIGN KEY (parent_id) REFERENCES virtual_directories(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS files (
        file_fingerprint TEXT PRIMARY KEY,
        smart_name TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        type TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        created_at DATETIME,
        modified_at DATETIME,
        description TEXT,
        author TEXT,
        language TEXT
      );

      CREATE TABLE IF NOT EXISTS workspace_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_fingerprint TEXT,
        workspace_id INTEGER NOT NULL,
        directory_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        is_analyzed BOOLEAN NOT NULL DEFAULT 0,
        thumbnail_path TEXT,
        FOREIGN KEY (file_fingerprint) REFERENCES files(file_fingerprint),
        FOREIGN KEY (workspace_id) REFERENCES workspace_directories(id),
        FOREIGN KEY (directory_id) REFERENCES workspace_directories(id)
      );

      CREATE TABLE IF NOT EXISTS file_tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        dimension_id INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS file_tag_relations (
        file_fingerprint TEXT NOT NULL,
        tag_id INTEGER NOT NULL,
        PRIMARY KEY (file_fingerprint, tag_id)
      );

      CREATE TABLE IF NOT EXISTS file_contents (
        file_fingerprint TEXT PRIMARY KEY,
        quality_score REAL,
        multimodal_content TEXT,
        FOREIGN KEY (file_fingerprint) REFERENCES files(file_fingerprint)
      );

      CREATE TABLE IF NOT EXISTS files_fts (
        file_fingerprint TEXT
      );
    `)

    // 创建临时工作目录
    workspacePath = path.join(os.tmpdir(), `test-vdir-workspace-${Date.now()}`)
    fs.mkdirSync(workspacePath, { recursive: true })

    // 插入测试工作目录
    db.prepare(`
      INSERT INTO workspace_directories (path, name, type)
      VALUES (?, ?, 'SPEEDY')
    `).run(workspacePath, 'Test Workspace')

    // 初始化虚拟目录服务
    vDirService = new VirtualDirectoryService(db)
  })

  afterAll(() => {
    db.close()
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath)
    }
    if (fs.existsSync(workspacePath)) {
      fs.rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  describe('导出虚拟目录', () => {
    it('应该能够根据预览树结构导出虚拟目录', async () => {
      const directoryTree = [
        {
          name: '摄影作品',
          parent: '',
          description: '摄影作品集合',
          dimensionId: 1,
          dimensionName: '素材类型',
          tagValue: '摄影',
          files: [
            { name: 'photo1.jpg', smartName: '商务摄影_01', path: path.join(workspacePath, 'photo1.jpg') },
            { name: 'photo2.jpg', smartName: '商务摄影_02', path: path.join(workspacePath, 'photo2.jpg') }
          ]
        },
        {
          name: 'AI生成',
          parent: '',
          description: 'AI生成内容',
          dimensionId: 1,
          dimensionName: '素材类型',
          tagValue: 'AI生成',
          files: [
            { name: 'ai1.png', smartName: 'AI艺术作品_01', path: path.join(workspacePath, 'ai1.png') }
          ]
        }
      ]

      // 创建测试文件
      const testFiles = [
        path.join(workspacePath, 'photo1.jpg'),
        path.join(workspacePath, 'photo2.jpg'),
        path.join(workspacePath, 'ai1.png')
      ]

      for (const filePath of testFiles) {
        fs.writeFileSync(filePath, 'test content')
        
        const fingerprint = `fp-${path.basename(filePath)}`
        db.prepare(`
          INSERT INTO files (file_fingerprint, smart_name, size, type, mime_type)
          VALUES (?, ?, ?, ?, ?)
        `).run(fingerprint, path.basename(filePath), 100, path.extname(filePath).slice(1), 'image/jpeg')

        const workspaceDir = db.prepare(
          'SELECT id FROM workspace_directories WHERE path = ?'
        ).get(workspacePath) as any

        db.prepare(`
          INSERT INTO workspace_files (file_fingerprint, workspace_id, directory_id, path, name, is_analyzed)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(fingerprint, workspaceDir.id, workspaceDir.id, filePath, path.basename(filePath), 1)
      }

      // 导出虚拟目录
      const result = await vDirService.generateFromPreviewTree(
        workspacePath,
        directoryTree,
        new Map(),
        {
          flattenToRoot: false,
          skipEmptyDirectories: true,
          enableNestedClassification: true
        }
      )

      expect(result.success).toBe(true)
      expect(result.fileCount).toBeGreaterThan(0)

      // 验证 ReadMe 文件已创建
      const virtualDirPath = path.join(workspacePath, '.VirtualDirectory')
      const files = fs.readdirSync(virtualDirPath)
      const readmeFile = files.find(f => f.startsWith('ReadMe_') && f.endsWith('.txt'))
      expect(readmeFile).toBeDefined()

      // 验证虚拟目录已保存到数据库
      const vDirs = db.prepare('SELECT * FROM virtual_directories').all() as any[]
      expect(vDirs.length).toBeGreaterThanOrEqual(2)

      // 验证工作目录 ID 正确
      const workspaceDir = db.prepare(
        'SELECT id FROM workspace_directories WHERE path = ?'
      ).get(workspacePath) as any

      for (const vDir of vDirs) {
        expect(vDir.workspace_id).toBe(workspaceDir.id)
      }
    })

    it('应该能够处理嵌套目录结构', async () => {
      const directoryTree = [
        {
          name: '设计',
          parent: '',
          dimensionId: 1,
          dimensionName: '素材类型',
          tagValue: '设计'
        },
        {
          name: 'UI设计',
          parent: '设计',
          dimensionId: 1,
          dimensionName: '素材类型',
          tagValue: 'UI'
        },
        {
          name: '3D渲染',
          parent: '设计',
          dimensionId: 1,
          dimensionName: '素材类型',
          tagValue: '3D'
        }
      ]

      const result = await vDirService.generateFromPreviewTree(
        workspacePath,
        directoryTree,
        new Map(),
        {
          flattenToRoot: false,
          skipEmptyDirectories: true,
          enableNestedClassification: true
        }
      )

      expect(result.success).toBe(true)

      // 验证父子关系
      const parentDir = db.prepare(
        "SELECT id FROM virtual_directories WHERE name = '设计'"
      ).get() as any

      const childDir = db.prepare(
        "SELECT id, parent_id FROM virtual_directories WHERE name = 'UI设计'"
      ).get() as any

      expect(childDir.parent_id).toBe(parentDir.id)
    })
  })

  describe('保存虚拟目录', () => {
    it('应该能够保存单个虚拟目录', async () => {
      const vDir = {
        id: `test-vdir-single-${Date.now()}`,
        name: '测试虚拟目录',
        filter: {
          selectedTags: [
            { dimensionId: 1, dimensionName: '类型', tagValue: '摄影' }
          ],
          sortBy: 'name' as const,
          sortOrder: 'asc' as const
        },
        parentId: null,
        workspaceId: 0, // 会被覆盖
        createdAt: new Date(),
        updatedAt: new Date()
      }

      const result = await vDirService.saveDirectory(vDir, workspacePath)
      
      expect(result).toBeDefined()
      expect(typeof result).toBe('string')

      // 验证数据库中的记录
      const saved = db.prepare(
        'SELECT * FROM virtual_directories WHERE id = ?'
      ).get(vDir.id) as any

      expect(saved).toBeDefined()
      expect(saved.name).toBe('测试虚拟目录')
    })

    it('应该能够批量保存虚拟目录', async () => {
      const directories = [
        {
          name: '批量测试1',
          filter: {
            selectedTags: [{ dimensionId: 1, dimensionName: '类型', tagValue: '批量1' }],
            sortBy: 'name' as const,
            sortOrder: 'asc' as const
          },
          path: ['批量测试1']
        },
        {
          name: '批量测试2',
          filter: {
            selectedTags: [{ dimensionId: 1, dimensionName: '类型', tagValue: '批量2' }],
            sortBy: 'name' as const,
            sortOrder: 'asc' as const
          },
          path: ['批量测试2']
        }
      ]

      const results = await vDirService.batchSaveDirectories(directories, workspacePath)
      
      expect(results.length).toBe(2)
      expect(results[0].name).toBe('批量测试1')
      expect(results[1].name).toBe('批量测试2')
    })
  })

  describe('查询虚拟目录', () => {
    it('应该能够获取指定工作目录的所有虚拟目录', async () => {
      const directories = await vDirService.getSavedDirectories(workspacePath)
      
      expect(Array.isArray(directories)).toBe(true)
      expect(directories.length).toBeGreaterThan(0)

      // 验证返回的数据结构
      for (const dir of directories) {
        expect(dir).toHaveProperty('id')
        expect(dir).toHaveProperty('name')
        expect(dir).toHaveProperty('filter')
        expect(dir).toHaveProperty('createdAt')
      }
    })

    it('应该能够检查是否是第一个虚拟目录', async () => {
      const isFirst = await vDirService.isFirstVirtualDirectory(workspacePath)
      expect(typeof isFirst).toBe('boolean')
    })
  })

  describe('外键约束', () => {
    it('应该使用正确的外键引用 workspace_directories.id', () => {
      const workspaceDir = db.prepare(
        'SELECT id FROM workspace_directories WHERE path = ?'
      ).get(workspacePath) as any

      expect(workspaceDir).toBeDefined()
      expect(typeof workspaceDir.id).toBe('number')

      // 尝试使用错误的 workspace_id 应该失败
      expect(() => {
        db.prepare(`
          INSERT INTO virtual_directories (id, name, filters, workspace_id)
          VALUES (?, ?, ?, ?)
        `).run(
          'invalid-test',
          'Invalid Test',
          JSON.stringify({ selectedTags: [] }),
          99999 // 不存在的 workspace_id
        )
      }).toThrow()
    })
  })
})
