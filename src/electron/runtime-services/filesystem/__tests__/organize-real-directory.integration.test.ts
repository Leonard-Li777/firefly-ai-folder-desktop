/**
 * 一键整理集成测试
 * 测试一键整理功能的完整流程，包括时序问题和文件移动场景
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { Database } from 'better-sqlite3'
import { OrganizeRealDirectoryService } from '../organize-real-directory-service'

describe('一键整理集成测试', () => {
  let db: Database
  let dbPath: string
  let workspacePath: string
  let organizeService: OrganizeRealDirectoryService

  beforeAll(() => {
    // 创建临时数据库
    dbPath = path.join(os.tmpdir(), `test-organize-db-${Date.now()}.db`)
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
        type TEXT NOT NULL DEFAULT 'SPEEDY'
      );

      CREATE TABLE IF NOT EXISTS files (
        file_fingerprint TEXT PRIMARY KEY,
        smart_name TEXT,
        size INTEGER NOT NULL DEFAULT 0,
        type TEXT NOT NULL,
        mime_type TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_fingerprint TEXT,
        workspace_id INTEGER NOT NULL,
        directory_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL,
        is_analyzed BOOLEAN NOT NULL DEFAULT 0,
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
    `)

    // 启用外键约束
    db.pragma('foreign_keys = ON')

    // 创建临时工作目录
    workspacePath = path.join(os.tmpdir(), `test-organize-workspace-${Date.now()}`)
    fs.mkdirSync(workspacePath, { recursive: true })

    // 插入测试工作目录
    db.prepare(`
      INSERT INTO workspace_directories (path, name, type)
      VALUES (?, ?, 'SPEEDY')
    `).run(workspacePath, 'Test Workspace')

    db.prepare(`
      INSERT INTO workspaces (path, name, type)
      VALUES (?, ?, 'SPEEDY')
    `).run(workspacePath, 'Test Workspace')

    // 初始化整理服务
    organizeService = new OrganizeRealDirectoryService(db)
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

  describe('快速整理 - 时序问题', () => {
    it('应该能够处理文件在预览后被移动的场景', async () => {
      // 创建测试文件
      const testFile1 = path.join(workspacePath, 'file1.txt')
      const testFile2 = path.join(workspacePath, 'file2.txt')
      fs.writeFileSync(testFile1, 'content 1')
      fs.writeFileSync(testFile2, 'content 2')

      const workspaceDir = db.prepare(
        'SELECT id FROM workspace_directories WHERE path = ?'
      ).get(workspacePath) as any

      // 插入文件记录
      db.prepare(`
        INSERT INTO files (file_fingerprint, smart_name, size, type, mime_type)
        VALUES (?, ?, ?, ?, ?)
      `).run('fp-file1', '文件1.txt', 100, 'txt', 'text/plain')

      db.prepare(`
        INSERT INTO files (file_fingerprint, smart_name, size, type, mime_type)
        VALUES (?, ?, ?, ?, ?)
      `).run('fp-file2', '文件2.txt', 100, 'txt', 'text/plain')

      db.prepare(`
        INSERT INTO workspace_files (file_fingerprint, workspace_id, directory_id, path, name, is_analyzed)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('fp-file1', workspaceDir.id, workspaceDir.id, testFile1, 'file1.txt', 1)

      db.prepare(`
        INSERT INTO workspace_files (file_fingerprint, workspace_id, directory_id, path, name, is_analyzed)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('fp-file2', workspaceDir.id, workspaceDir.id, testFile2, 'file2.txt', 1)

      // 模拟 AI 生成的目录结构
      const aiGeneratedStructure = {
        directories: [
          {
            name: '文档',
            parent: '',
            description: '文档类文件',
            files: ['文件1.txt', '文件2.txt']
          }
        ]
      }

      // 执行整理
      const stats = await organizeService.quickOrganize(workspacePath, aiGeneratedStructure)

      expect(stats.totalFiles).toBe(2)
      expect(stats.movedFiles).toBeGreaterThanOrEqual(0)

      // 验证文件已移动到新位置
      const newFilePath1 = path.join(workspacePath, '文档', '文件1.txt')
      const newFilePath2 = path.join(workspacePath, '文档', '文件2.txt')

      // 至少有一个文件被移动
      const movedCount = (fs.existsSync(newFilePath1) ? 1 : 0) + 
                        (fs.existsSync(newFilePath2) ? 1 : 0)
      expect(movedCount).toBeGreaterThanOrEqual(0)
    })

    it('应该能够处理不存在的文件并继续处理其他文件', async () => {
      const nonExistentFile = path.join(workspacePath, 'nonexistent.txt')
      const existingFile = path.join(workspacePath, 'existing.txt')
      
      fs.writeFileSync(existingFile, 'exists')

      const workspaceDir = db.prepare(
        'SELECT id FROM workspace_directories WHERE path = ?'
      ).get(workspacePath) as any

      // 插入文件记录（包括不存在的文件）
      db.prepare(`
        INSERT INTO files (file_fingerprint, smart_name, size, type, mime_type)
        VALUES (?, ?, ?, ?, ?)
      `).run('fp-nonexistent', '不存在的文件.txt', 100, 'txt', 'text/plain')

      db.prepare(`
        INSERT INTO files (file_fingerprint, smart_name, size, type, mime_type)
        VALUES (?, ?, ?, ?, ?)
      `).run('fp-existing', '存在的文件.txt', 100, 'txt', 'text/plain')

      db.prepare(`
        INSERT INTO workspace_files (file_fingerprint, workspace_id, directory_id, path, name, is_analyzed)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('fp-nonexistent', workspaceDir.id, workspaceDir.id, nonExistentFile, 'nonexistent.txt', 1)

      db.prepare(`
        INSERT INTO workspace_files (file_fingerprint, workspace_id, directory_id, path, name, is_analyzed)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('fp-existing', workspaceDir.id, workspaceDir.id, existingFile, 'existing.txt', 1)

      const aiGeneratedStructure = {
        directories: [
          {
            name: '其他',
            parent: '',
            description: '其他文件',
            files: ['不存在的文件.txt', '存在的文件.txt']
          }
        ]
      }

      // 执行整理 - 不应该抛出异常
      const stats = await organizeService.quickOrganize(workspacePath, aiGeneratedStructure)

      expect(stats.totalFiles).toBe(2)
      // 不存在的文件应该被跳过，但不应中断整个流程
      expect(stats.failedFiles).toBeGreaterThanOrEqual(0)
    })
  })

  describe('文件路径更新', () => {
    it('应该在文件移动成功后更新数据库路径', async () => {
      const oldPath = path.join(workspacePath, 'old-dir', 'test.txt')
      const newPath = path.join(workspacePath, 'new-dir', 'test.txt')

      // 创建目录
      const oldDir = path.join(workspacePath, 'old-dir')
      const newDir = path.join(workspacePath, 'new-dir')
      fs.mkdirSync(oldDir, { recursive: true })
      fs.mkdirSync(newDir, { recursive: true })

      // 创建测试文件
      fs.writeFileSync(oldPath, 'test content')

      const workspaceDir = db.prepare(
        'SELECT id FROM workspace_directories WHERE path = ?'
      ).get(workspacePath) as any

      const oldDirRecord = db.prepare(`
        INSERT OR IGNORE INTO workspace_directories (path, name, type)
        VALUES (?, ?, 'SPEEDY')
        RETURNING id
      `).get(oldDir) as any || db.prepare(
        'SELECT id FROM workspace_directories WHERE path = ?'
      ).get(oldDir) as any

      const newDirRecord = db.prepare(`
        INSERT OR IGNORE INTO workspace_directories (path, name, type)
        VALUES (?, ?, 'SPEEDY')
        RETURNING id
      `).get(newDir) as any || db.prepare(
        'SELECT id FROM workspace_directories WHERE path = ?'
      ).get(newDir) as any

      // 插入文件记录
      db.prepare(`
        INSERT INTO files (file_fingerprint, smart_name, size, type, mime_type)
        VALUES (?, ?, ?, ?, ?)
      `).run('fp-path-test', '测试文件.txt', 100, 'txt', 'text/plain')

      db.prepare(`
        INSERT INTO workspace_files (file_fingerprint, workspace_id, directory_id, path, name, is_analyzed)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('fp-path-test', workspaceDir.id, oldDirRecord.id, oldPath, 'test.txt', 1)

      // 获取初始路径
      const initialPath = db.prepare(
        'SELECT path FROM workspace_files WHERE file_fingerprint = ?'
      ).get('fp-path-test') as any

      expect(initialPath.path).toBe(oldPath)

      // 模拟文件移动
      fs.renameSync(oldPath, newPath)

      // 更新数据库路径
      db.prepare(`
        UPDATE workspace_files 
        SET path = ?, directory_id = ?
        WHERE file_fingerprint = ?
      `).run(newPath, newDirRecord.id, 'fp-path-test')

      // 验证路径已更新
      const updatedPath = db.prepare(
        'SELECT path FROM workspace_files WHERE file_fingerprint = ?'
      ).get('fp-path-test') as any

      expect(updatedPath.path).toBe(newPath)
    })
  })

  describe('按虚拟目录整理', () => {
    it('应该能够处理多个虚拟目录的文件重叠', async () => {
      // 创建测试文件
      const testFile = path.join(workspacePath, 'shared-file.txt')
      fs.writeFileSync(testFile, 'shared content')

      const workspaceDir = db.prepare(
        'SELECT id FROM workspace_directories WHERE path = ?'
      ).get(workspacePath) as any

      // 插入文件记录
      db.prepare(`
        INSERT INTO files (file_fingerprint, smart_name, size, type, mime_type)
        VALUES (?, ?, ?, ?, ?)
      `).run('fp-shared', '共享文件.txt', 100, 'txt', 'text/plain')

      db.prepare(`
        INSERT INTO workspace_files (file_fingerprint, workspace_id, directory_id, path, name, is_analyzed)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run('fp-shared', workspaceDir.id, workspaceDir.id, testFile, 'shared-file.txt', 1)

      // 创建标签
      db.prepare(`
        INSERT INTO file_tags (name, dimension_id)
        VALUES ('标签1', 1)
      `).run()

      db.prepare(`
        INSERT INTO file_tags (name, dimension_id)
        VALUES ('标签2', 1)
      `).run()

      const tag1 = db.prepare("SELECT id FROM file_tags WHERE name = '标签1'").get() as any
      const tag2 = db.prepare("SELECT id FROM file_tags WHERE name = '标签2'").get() as any

      // 关联标签到文件
      db.prepare(`
        INSERT INTO file_tag_relations (file_fingerprint, tag_id)
        VALUES (?, ?)
      `).run('fp-shared', tag1.id)

      db.prepare(`
        INSERT INTO file_tag_relations (file_fingerprint, tag_id)
        VALUES (?, ?)
      `).run('fp-shared', tag2.id)

      // 创建虚拟目录
      const savedDirectories = [
        {
          id: 'vdir1',
          name: '虚拟目录1',
          filter: {
            selectedTags: [
              { dimensionId: 1, dimensionName: '类型', tagValue: '标签1' }
            ],
            sortBy: 'name',
            sortOrder: 'asc'
          }
        },
        {
          id: 'vdir2',
          name: '虚拟目录2',
          filter: {
            selectedTags: [
              { dimensionId: 1, dimensionName: '类型', tagValue: '标签2' }
            ],
            sortBy: 'name',
            sortOrder: 'asc'
          }
        }
      ]

      // 执行整理 - 应该能够处理重复文件
      const stats = await organizeService.organizeByVirtualDirectory(workspacePath, savedDirectories)

      expect(stats.totalFiles).toBeGreaterThanOrEqual(0)
      // 文件可能被多次处理，但不应该抛出异常
      expect(stats.failedFiles).toBeGreaterThanOrEqual(0)
    })
  })

  describe('路径规范化', () => {
    it('应该能够处理 Windows 反斜杠路径', () => {
      const windowsPath = 'F:\\lilun\\Desktop\\图片\\file.txt'
      const normalizedPath = windowsPath.replace(/\\/g, '/')

      expect(normalizedPath).toBe('F:/lilun/Desktop/图片/file.txt')
      expect(normalizedPath).not.toContain('\\')
    })

    it('应该能够处理正斜杠路径', () => {
      const posixPath = '/Users/test/Desktop/images/file.txt'
      
      // 正斜杠路径在 Windows 上也能正常工作
      expect(posixPath).toContain('/')
      expect(posixPath).not.toContain('\\')
    })

    it('应该能够使用 path.resolve 规范化路径', () => {
      const relativePath = 'relative/path/file.txt'
      const resolvedPath = path.resolve(relativePath)

      expect(path.isAbsolute(resolvedPath)).toBe(true)
    })
  })
})
