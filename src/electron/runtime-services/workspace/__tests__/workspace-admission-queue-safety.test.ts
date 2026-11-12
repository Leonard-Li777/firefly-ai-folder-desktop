import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'

vi.mock('electron', () => ({
  shell: {
    showItemInFolder: vi.fn()
  },
  app: {
    getPath: vi.fn().mockReturnValue('C:\\test'),
    getName: vi.fn().mockReturnValue('firefly')
  },
  BrowserWindow: {
    getAllWindows: vi.fn().mockReturnValue([])
  },
  powerMonitor: {
    on: vi.fn()
  }
}))

vi.mock('electron-conf', () => ({
  Conf: class {
    get() {
      return {}
    }
    set() {}
  }
}))

import { WorkspaceAdmissionService } from '../workspace-admission-service'
import { fileWatcherService } from '../../filesystem/file-watcher-service'

describe('准入规则变更与分析队列铁律：只允许自动删除，严禁自动添加文件', () => {
  let db: Database.Database
  let service: WorkspaceAdmissionService

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE workspaces (
        workspace_id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        path TEXT NOT NULL,
        workspace_config TEXT,
        bound_workflow_id TEXT,
        meta TEXT
      );
      CREATE TABLE workspace_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        name TEXT NOT NULL
      );
      CREATE TABLE analysis_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_type TEXT NOT NULL,
        item_id INTEGER NOT NULL,
        status TEXT NOT NULL
      );
    `)

    db.prepare(
      `INSERT INTO workspaces (workspace_id, name, path, workspace_config) VALUES (?, ?, ?, ?)`
    ).run(
      1,
      'Desktop',
      'F:/lilun/Desktop',
      JSON.stringify({
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        customExcludeRules: [],
        customIncludeRules: []
      })
    )

    service = new WorkspaceAdmissionService({ db })
  })

  afterEach(() => {
    db.close()
  })

  it('规则变更时：失配文件从 analysis_queue 自动删除，绝不自动增量添加新文件', async () => {
    // 预置两个工作区文件：一个 txt，一个 jpg
    db.prepare(
      `INSERT INTO workspace_files (id, workspace_id, path, name) VALUES (?, ?, ?, ?)`
    ).run(101, 1, 'F:/lilun/Desktop/doc.txt', 'doc.txt')
    db.prepare(
      `INSERT INTO workspace_files (id, workspace_id, path, name) VALUES (?, ?, ?, ?)`
    ).run(102, 1, 'F:/lilun/Desktop/photo.jpg', 'photo.jpg')

    // 预置分析队列：包含这两个文件
    db.prepare(
      `INSERT INTO analysis_queue (id, item_type, item_id, status) VALUES (?, ?, ?, ?)`
    ).run(1, 'file', 101, 'pending')
    db.prepare(
      `INSERT INTO analysis_queue (id, item_type, item_id, status) VALUES (?, ?, ?, ?)`
    ).run(2, 'file', 102, 'pending')

    // 应用修改：包含规则收紧为仅放行 .jpg
    const result = await service.applyPolicyMutation(1, {
      includeExts: ['.jpg']
    })

    // 1. 验证结果：needsRescan 恒为 false（严禁触发补扫）
    expect(result.needsRescan).toBe(false)
    expect(result.admissionChanged).toBe(true)

    // 2. 验证负向修剪：doc.txt 被从 workspace_files 移除
    const remainingFiles = db.prepare('SELECT id, name FROM workspace_files').all() as any[]
    expect(remainingFiles).toHaveLength(1)
    expect(remainingFiles[0].name).toBe('photo.jpg')

    // 3. 验证从 analysis_queue 中自动删除失配任务
    const remainingQueue = db.prepare('SELECT id, item_id FROM analysis_queue').all() as any[]
    expect(remainingQueue).toHaveLength(1)
    expect(remainingQueue[0].item_id).toBe(102) // 仅保留符合规则的 photo.jpg，doc.txt 已被自动剔除
  })

  it('放宽规则时：needsRescan 依然为 false，绝不向 analysis_queue 自动添加文件', async () => {
    // 初始状态：包含规则只有 .cr3
    db.prepare('UPDATE workspaces SET workspace_config = ? WHERE workspace_id = ?').run(
      JSON.stringify({
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 2,
        customExcludeRules: [],
        customIncludeRules: [
          {
            id: 'rule-1',
            type: 'extension',
            value: '.cr3',
            isActive: true,
            isSystem: false
          }
        ]
      }),
      1
    )

    // 放宽规则：新增 .jpg
    const result = await service.applyPolicyMutation(1, {
      includeExts: ['.cr3', '.jpg']
    })

    expect(result.needsRescan).toBe(false)
    // 队列依然保持未被意外自动添加任何项目
    const queueRows = db.prepare('SELECT id FROM analysis_queue').all()
    expect(queueRows).toHaveLength(0)
  })

  it('规则变更时激活 30 秒充裕静默期，静默期内自动监听完全静音，静默期后恢复日常实时监听', () => {
    // 1. 触发规则变更后进入静默期
    fileWatcherService.muteAutoWatch(1, 30000)
    expect(fileWatcherService.isAutoWatchMuted(1)).toBe(true)

    // 2. 模拟静默期已过
    fileWatcherService.muteAutoWatch(1, -1) // 立即过期
    expect(fileWatcherService.isAutoWatchMuted(1)).toBe(false)
  })
})
