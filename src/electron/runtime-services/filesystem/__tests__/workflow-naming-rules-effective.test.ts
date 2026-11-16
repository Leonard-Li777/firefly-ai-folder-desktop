import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'C:\\tmp'),
    getName: vi.fn(() => 'firefly-ai-folder')
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [])
  }
}))

vi.mock('electron-conf', () => ({
  Conf: class {
    get() {
      return undefined
    }
    set() {}
  }
}))

import Database from 'better-sqlite3'
import { GENESIS_V1_SCHEMA } from '../../database/database'
import { DirectoryContextService } from '../directory-context-service'
import { databaseService } from '../../database/database-service'

describe('DirectoryContextService: 工作流命名规则 (namingPattern & namingTemplate) 有效生效与回退测试', () => {
  let db: Database.Database
  let service: DirectoryContextService

  beforeEach(() => {
    db = new Database(':memory:')
    db.function('decompress_text', val => val)
    db.function('compress_text', val => val)
    db.exec(GENESIS_V1_SCHEMA)

    service = new DirectoryContextService(db)

    // 初始化并注入 databaseService 的 db
    ;(databaseService as any)._db = db
    ;(databaseService as any)._initialized = true

    // 插入测试官方工作流
    db.prepare(
      `
      INSERT INTO local_workflows (
        id, user_id, author, name, version, persona, category, summary, source, status,
        workspace_config, naming_pattern, naming_template, created_at, modified_at
      ) VALUES (
        'builtin.workflow.photography-raw',
        NULL,
        '官方',
        '专业摄影师 RAW 底片流',
        '1.0.0',
        'photographer',
        'creative',
        '摄影工作流',
        'official',
        'published',
        '{"schemaVersion":1,"status":"ready","policyVersion":1}',
        '[拍摄场景]_[主题主体]',
        '[{TAG:设备型号}]{SMART_NAME}_{CRE:YYYYMMDD}',
        '2026-11-16 00:00:00',
        '2026-11-16 00:00:00'
      )
    `
    ).run()

    // 插入绑定该工作流的工作区
    db.prepare(
      `
      INSERT INTO workspaces (
        workspace_id, path, name, type, is_active, auto_watch, workspace_config, bound_workflow_id
      ) VALUES (
        1,
        'D:/workspace/photos',
        '摄影照片库',
        'SPEEDY',
        1,
        0,
        '{"schemaVersion":1,"status":"ready","policyVersion":1}',
        'builtin.workflow.photography-raw'
      )
    `
    ).run()
  })

  afterEach(() => {
    try {
      db.close()
    } catch {}
  })

  it('1. 目录未跑画像 (context_analysis 为 null) 时，自动回退并生效工作流配置的 namingPattern 和 namingTemplate', async () => {
    const dirPath = 'D:/workspace/photos'
    // 目录在 workspace_directories 中，但尚未执行画像分析 (context_analysis is null)
    db.prepare(
      `
      INSERT INTO workspace_directories (
        id, workspace_id, path, name, context_analysis, is_analyzed
      ) VALUES (
        1, 1, ?, 'photos', NULL, 0
      )
    `
    ).run(dirPath)

    const effective = await service.getEffectiveDirectoryConfig(dirPath)
    expect(effective).not.toBeNull()
    expect(effective?.namingPattern).toBe('[拍摄场景]_[主题主体]')
    expect(effective?.namingTemplate).toBe('[{TAG:设备型号}]{SMART_NAME}_{CRE:YYYYMMDD}')
  })

  it('2. 目录已分析但未显式配置 namingPattern 时，自动继承/兜底工作流中的 namingPattern', async () => {
    const dirPath = 'D:/workspace/photos/2026'
    // 插入已分析但 namingPattern 为空的画像
    const initialContext = {
      directoryPath: dirPath,
      fileTypeDistribution: {},
      recommendedTags: {},
      specialFiles: [],
      description: '2026年拍摄照片',
      namingPattern: '', // 未配置
      analysisStrategy: '',
      namingTemplate: '', // 未配置
      inheritMode: {
        analysisStrategy: 'inherit',
        namingPattern: 'inherit',
        namingTemplate: 'inherit'
      },
      confidence: 0.9,
      analyzedAt: new Date().toISOString()
    }

    db.prepare(
      `
      INSERT INTO workspace_directories (
        id, workspace_id, path, name, context_analysis, is_analyzed
      ) VALUES (
        2, 1, ?, '2026', ?, 1
      )
    `
    ).run(dirPath, JSON.stringify(initialContext))

    const effective = await service.getEffectiveDirectoryConfig(dirPath)
    expect(effective).not.toBeNull()
    expect(effective?.namingPattern).toBe('[拍摄场景]_[主题主体]')
    expect(effective?.namingTemplate).toBe('[{TAG:设备型号}]{SMART_NAME}_{CRE:YYYYMMDD}')
  })

  it('3. 目录显式配置了自定义 namingPattern 时，优先使用自定义配置，不被工作流覆盖', async () => {
    const dirPath = 'D:/workspace/photos/special'
    const customPattern = '[活动]内容描述_机位'
    const customContext = {
      directoryPath: dirPath,
      fileTypeDistribution: {},
      recommendedTags: {},
      specialFiles: [],
      description: '特别活动照片',
      namingPattern: customPattern,
      analysisStrategy: '',
      namingTemplate: '{SMART_NAME}_custom',
      inheritMode: {
        analysisStrategy: 'inherit',
        namingPattern: 'current_only',
        namingTemplate: 'current_only'
      },
      customConfigSnapshot: {
        namingPattern: customPattern
      },
      confidence: 1.0,
      analyzedAt: new Date().toISOString()
    }

    db.prepare(
      `
      INSERT INTO workspace_directories (
        id, workspace_id, path, name, context_analysis, is_analyzed
      ) VALUES (
        3, 1, ?, 'special', ?, 1
      )
    `
    ).run(dirPath, JSON.stringify(customContext))

    const effective = await service.getEffectiveDirectoryConfig(dirPath)
    expect(effective).not.toBeNull()
    expect(effective?.namingPattern).toBe(customPattern)
    expect(effective?.namingTemplate).toBe('{SMART_NAME}_custom')
  })

  it('4. Windows 路径大小写容错：小写路径请求依然精准匹配工作流命名规则', async () => {
    const dirPath = 'd:/workspace/photos/sub'
    db.prepare(
      `
      INSERT INTO workspace_directories (
        id, workspace_id, path, name, context_analysis, is_analyzed
      ) VALUES (
        4, 1, ?, 'sub', NULL, 0
      )
    `
    ).run(dirPath)

    const effective = await service.getEffectiveDirectoryConfig(dirPath)
    expect(effective).not.toBeNull()
    expect(effective?.namingPattern).toBe('[拍摄场景]_[主题主体]')
    expect(effective?.namingTemplate).toBe('[{TAG:设备型号}]{SMART_NAME}_{CRE:YYYYMMDD}')
  })
})
