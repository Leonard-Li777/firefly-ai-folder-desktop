/**
 * 目录上下文分析集成测试
 * 测试目录上下文分析、保存和查询的完整流程
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { Database } from 'better-sqlite3'
import { DirectoryContextService } from '../directory-context-service'

describe('目录上下文分析集成测试', () => {
  let db: Database
  let dbPath: string
  let workspacePath: string
  let contextService: DirectoryContextService

  beforeAll(() => {
    // 创建临时数据库
    dbPath = path.join(os.tmpdir(), `test-context-db-${Date.now()}.db`)
    db = new Database(dbPath)

    // 初始化数据库表
    db.exec(`
      CREATE TABLE IF NOT EXISTS workspace_directories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'SPEEDY',
        context_analysis TEXT,
        is_analyzed BOOLEAN NOT NULL DEFAULT 0,
        last_analyzed_at DATETIME
      );
    `)

    // 创建临时工作目录
    workspacePath = path.join(os.tmpdir(), `test-context-workspace-${Date.now()}`)
    fs.mkdirSync(workspacePath, { recursive: true })

    // 插入测试目录
    db.prepare(`
      INSERT INTO workspace_directories (path, name, type)
      VALUES (?, ?, 'SPEEDY')
    `).run(workspacePath, 'Test Context Workspace')

    // 初始化目录上下文服务
    contextService = new DirectoryContextService(db)
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

  describe('保存和查询目录上下文', () => {
    it('应该能够保存目录上下文分析结果', async () => {
      const analysis = {
        directoryPath: workspacePath,
        directoryType: '设计与视觉素材目录',
        fileTypeDistribution: {
          '摄影': 10,
          'AI生成': 5,
          '设计稿': 3
        },
        namingPatterns: ['日期_类型_描述_序号'],
        languageDetected: ['zh-CN'],
        specialFiles: ['ReadMe.txt'],
        recommendedDimensions: ['素材类型', '创作来源', '使用场景'],
        recommendedTags: {
          '素材类型': ['摄影', 'AI生成', '设计稿'],
          '创作来源': ['影棚拍摄', 'AI生成'],
          '使用场景': ['商务形象', '教学展示']
        },
        analysisStrategy: '根据文件扩展名和文件名关键词进行一级分类，再根据内容特征进行二级分类',
        namingPattern: '来源_素材类型_内容描述_序号',
        confidence: 0.92,
        analyzedAt: new Date()
      }

      // 保存上下文分析
      await contextService.saveContextAnalysis(workspacePath, analysis)

      // 查询上下文分析
      const result = await contextService.getDirectoryContext(workspacePath)

      expect(result).toBeDefined()
      expect(result?.directoryType).toBe('设计与视觉素材目录')
      expect(result?.confidence).toBe(0.92)
      expect(result?.recommendedDimensions).toHaveLength(3)
      expect(result?.fileTypeDistribution).toHaveProperty('摄影', 10)
    })

    it('应该能够更新已有的目录上下文分析', async () => {
      const updatedAnalysis = {
        directoryPath: workspacePath,
        directoryType: '更新后的目录类型',
        fileTypeDistribution: {
          '新类型': 20
        },
        namingPatterns: [],
        languageDetected: [],
        specialFiles: [],
        recommendedDimensions: ['新维度'],
        recommendedTags: {},
        analysisStrategy: '更新后的策略',
        namingPattern: '新模式',
        confidence: 0.95,
        analyzedAt: new Date()
      }

      // 更新上下文分析
      await contextService.saveContextAnalysis(workspacePath, updatedAnalysis)

      // 查询更新后的结果
      const result = await contextService.getDirectoryContext(workspacePath)

      expect(result).toBeDefined()
      expect(result?.directoryType).toBe('更新后的目录类型')
      expect(result?.confidence).toBe(0.95)
    })

    it('应该能够清除目录上下文分析', async () => {
      // 清除上下文分析
      await contextService.clearDirectoryContext(workspacePath)

      // 查询清除后的结果
      const result = await contextService.getDirectoryContext(workspacePath)

      expect(result).toBeNull()
    })

    it('应该能够处理不存在的目录路径', async () => {
      const nonExistentPath = '/non/existent/path'
      
      const result = await contextService.getDirectoryContext(nonExistentPath)
      
      expect(result).toBeNull()
    })
  })

  describe('路径格式兼容性', () => {
    it('应该能够处理 Windows 反斜杠路径', async () => {
      const windowsPath = 'F:\\lilun\\Desktop\\图片'
      const normalizedName = '图片'

      // 插入目录
      db.prepare(`
        INSERT OR IGNORE INTO workspace_directories (path, name, type)
        VALUES (?, ?, 'SPEEDY')
      `).run(windowsPath, normalizedName)

      const analysis = {
        directoryPath: windowsPath,
        directoryType: 'Windows 路径测试',
        fileTypeDistribution: {},
        namingPatterns: [],
        languageDetected: [],
        specialFiles: [],
        recommendedDimensions: [],
        recommendedTags: {},
        analysisStrategy: '测试策略',
        namingPattern: '测试模式',
        confidence: 0.8,
        analyzedAt: new Date()
      }

      // 保存上下文分析
      await contextService.saveContextAnalysis(windowsPath, analysis)

      // 使用相同的路径格式查询
      const result = await contextService.getDirectoryContext(windowsPath)

      expect(result).toBeDefined()
      expect(result?.directoryType).toBe('Windows 路径测试')
    })

    it('应该能够处理正斜杠路径', async () => {
      const posixPath = '/Users/test/Desktop/images'
      const normalizedName = 'images'

      // 插入目录
      db.prepare(`
        INSERT OR IGNORE INTO workspace_directories (path, name, type)
        VALUES (?, ?, 'SPEEDY')
      `).run(posixPath, normalizedName)

      const analysis = {
        directoryPath: posixPath,
        directoryType: 'Posix 路径测试',
        fileTypeDistribution: {},
        namingPatterns: [],
        languageDetected: [],
        specialFiles: [],
        recommendedDimensions: [],
        recommendedTags: {},
        analysisStrategy: '测试策略',
        namingPattern: '测试模式',
        confidence: 0.85,
        analyzedAt: new Date()
      }

      // 保存上下文分析
      await contextService.saveContextAnalysis(posixPath, analysis)

      // 使用相同的路径格式查询
      const result = await contextService.getDirectoryContext(posixPath)

      expect(result).toBeDefined()
      expect(result?.directoryType).toBe('Posix 路径测试')
    })
  })

  describe('数据库字段验证', () => {
    it('应该正确设置 is_analyzed 标志', async () => {
      const testPath = path.join(workspacePath, 'analyzed-test')

      // 插入目录
      db.prepare(`
        INSERT INTO workspace_directories (path, name, type, is_analyzed)
        VALUES (?, ?, 'SPEEDY', ?)
      `).run(testPath, 'Analyzed Test', 0)

      // 保存上下文分析
      const analysis = {
        directoryPath: testPath,
        directoryType: '测试',
        fileTypeDistribution: {},
        namingPatterns: [],
        languageDetected: [],
        specialFiles: [],
        recommendedDimensions: [],
        recommendedTags: {},
        analysisStrategy: '策略',
        namingPattern: '模式',
        confidence: 0.9,
        analyzedAt: new Date()
      }

      await contextService.saveContextAnalysis(testPath, analysis)

      // 验证 is_analyzed 被设置为 1
      const result = db.prepare(
        'SELECT is_analyzed, last_analyzed_at FROM workspace_directories WHERE path = ?'
      ).get(testPath) as any

      expect(result.is_analyzed).toBe(1)
      expect(result.last_analyzed_at).toBeDefined()
    })

    it('应该将 context_analysis 存储为 JSON 字符串', async () => {
      const testPath = path.join(workspacePath, 'json-test')

      // 插入目录
      db.prepare(`
        INSERT INTO workspace_directories (path, name, type)
        VALUES (?, ?, 'SPEEDY')
      `).run(testPath, 'JSON Test')

      const analysis = {
        directoryPath: testPath,
        directoryType: 'JSON 测试',
        fileTypeDistribution: { 'type1': 5, 'type2': 10 },
        namingPatterns: [],
        languageDetected: [],
        specialFiles: [],
        recommendedDimensions: [],
        recommendedTags: {},
        analysisStrategy: '测试策略',
        namingPattern: '测试模式',
        confidence: 0.88,
        analyzedAt: new Date()
      }

      await contextService.saveContextAnalysis(testPath, analysis)

      // 直接查询数据库验证存储格式
      const result = db.prepare(
        'SELECT context_analysis FROM workspace_directories WHERE path = ?'
      ).get(testPath) as any

      expect(result.context_analysis).toBeDefined()
      expect(typeof result.context_analysis).toBe('string')

      // 验证可以正确解析
      const parsed = JSON.parse(result.context_analysis)
      expect(parsed.directoryType).toBe('JSON 测试')
      expect(parsed.fileTypeDistribution).toHaveProperty('type1', 5)
    })
  })
})
