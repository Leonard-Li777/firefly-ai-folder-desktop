import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  WorkspaceAdmissionService,
  type WorkspacePolicyMutation
} from '../workspace-admission-service'
import { LAYOUT_KEYS, type WorkspaceConfigReady } from '@firefly/types'

describe('WorkspaceAdmissionService defaultLayout Admission & Strategy Merge Algebra', () => {
  let db: Database.Database
  let service: WorkspaceAdmissionService

  beforeEach(() => {
    db = new Database(':memory:')
    // 创建基础 Schema
    db.exec(`
      CREATE TABLE workspaces (
        workspace_id INTEGER PRIMARY KEY AUTOINCREMENT,
        path TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'SPEEDY',
        is_active BOOLEAN NOT NULL DEFAULT 1,
        auto_watch BOOLEAN NOT NULL DEFAULT 0,
        last_scan_at DATETIME,
        workspace_config TEXT NOT NULL DEFAULT '{"schemaVersion":1,"status":"pending"}',
        meta TEXT NOT NULL DEFAULT '{}',
        bound_workflow_id TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE local_workflows (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        author TEXT,
        name TEXT NOT NULL,
        version TEXT NOT NULL,
        persona TEXT NOT NULL,
        category TEXT NOT NULL,
        summary TEXT,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace_config TEXT NOT NULL,
        naming_pattern TEXT,
        naming_template TEXT,
        preset_directory_tree TEXT,
        preview_tree TEXT,
        icon_svg TEXT
      );

      CREATE TABLE workspace_files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER NOT NULL,
        path TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        name TEXT NOT NULL,
        file_name TEXT,
        extension TEXT NOT NULL,
        size INTEGER NOT NULL,
        status INTEGER NOT NULL DEFAULT 0,
        meta TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE analysis_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workspace_id INTEGER NOT NULL,
        file_id INTEGER,
        file_path TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        priority INTEGER NOT NULL DEFAULT 0,
        retry_count INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `)

    // 播种两个工作流：
    // 1. 摄影流 (继承 PHOTO_GALLERY: 'tri')
    db.prepare(`
      INSERT INTO local_workflows (id, name, version, persona, category, source, status, workspace_config)
      VALUES (
        'builtin.workflow.photography-raw',
        '专业摄影工作流',
        '1.0.0',
        'photographer',
        'creative',
        'official',
        'published',
        '{"schemaVersion":1,"status":"ready","policyVersion":1,"presetVersion":2,"workflowId":"builtin.workflow.photography-raw","defaultLayout":"tri","customExcludeRules":[],"customIncludeRules":[],"baseAIConfig":{}}'
      )
    `).run()

    // 2. 宠物成长相册 (显式重载为 'all-row')
    db.prepare(`
      INSERT INTO local_workflows (id, name, version, persona, category, source, status, workspace_config)
      VALUES (
        'builtin.workflow.pet-care-diary',
        '宠物相册工作流',
        '1.0.0',
        'pet_owner',
        'entertainment',
        'official',
        'published',
        '{"schemaVersion":1,"status":"ready","policyVersion":1,"presetVersion":2,"workflowId":"builtin.workflow.pet-care-diary","defaultLayout":"all-row","customExcludeRules":[],"customIncludeRules":[],"baseAIConfig":{}}'
      )
    `).run()

    // 插入初始工作区 (未绑定状态)
    const initialConfig: WorkspaceConfigReady = {
      schemaVersion: 1,
      status: 'ready',
      policyVersion: 1,
      presetVersion: 2,
      customExcludeRules: [],
      customIncludeRules: [],
      baseAIConfig: {} as any,
      configuredAt: Date.now()
    }
    db.prepare(`
      INSERT INTO workspaces (workspace_id, path, name, workspace_config, bound_workflow_id)
      VALUES (1, '/test/path', '测试工作区', ?, NULL)
    `).run(JSON.stringify(initialConfig))

    service = new WorkspaceAdmissionService({
      db,
      systemRulesProvider: () => []
    })
  })

  afterEach(() => {
    if (db) {
      db.close()
    }
  })

  it('切换到摄影工作流时，defaultLayout 原子更新为 tri', async () => {
    const mutation: WorkspacePolicyMutation = {
      workflowId: 'builtin.workflow.photography-raw'
    }

    const res = await service.applyPolicyMutation(1, mutation)
    expect(res.policyVersion).toBeGreaterThan(0)
    expect(res.appliedConfig?.defaultLayout).toBe(LAYOUT_KEYS.TRI)

    const row = db.prepare('SELECT workspace_config, bound_workflow_id FROM workspaces WHERE workspace_id = 1').get() as any
    expect(row.bound_workflow_id).toBe('builtin.workflow.photography-raw')
    const config = JSON.parse(row.workspace_config) as WorkspaceConfigReady
    expect(config.defaultLayout).toBe(LAYOUT_KEYS.TRI)
  })

  it('切换到手机/宠物相册工作流时，defaultLayout 原子更新为 all-row', async () => {
    const mutation: WorkspacePolicyMutation = {
      workflowId: 'builtin.workflow.pet-care-diary'
    }

    const res = await service.applyPolicyMutation(1, mutation)
    expect(res.policyVersion).toBeGreaterThan(0)
    expect(res.appliedConfig?.defaultLayout).toBe(LAYOUT_KEYS.ALL_ROW)

    const row = db.prepare('SELECT workspace_config, bound_workflow_id FROM workspaces WHERE workspace_id = 1').get() as any
    expect(row.bound_workflow_id).toBe('builtin.workflow.pet-care-diary')
    const config = JSON.parse(row.workspace_config) as WorkspaceConfigReady
    expect(config.defaultLayout).toBe(LAYOUT_KEYS.ALL_ROW)
  })

  it('显式解除绑定 (workflowId: null) 时，defaultLayout 安全归一为 all-row', async () => {
    // 先绑定摄影流
    await service.applyPolicyMutation(1, { workflowId: 'builtin.workflow.photography-raw' })

    // 再显式解绑
    const res = await service.applyPolicyMutation(1, { workflowId: null })
    expect(res.policyVersion).toBeGreaterThan(0)
    expect(res.appliedConfig?.defaultLayout).toBe(LAYOUT_KEYS.ALL_ROW)

    const row = db.prepare('SELECT workspace_config, bound_workflow_id FROM workspaces WHERE workspace_id = 1').get() as any
    expect(row.bound_workflow_id).toBeNull()
    const config = JSON.parse(row.workspace_config) as WorkspaceConfigReady
    expect(config.defaultLayout).toBe(LAYOUT_KEYS.ALL_ROW)
  })

  it('显式传入 mutation.defaultLayout 时，显式覆盖优先级最高', async () => {
    const mutation: WorkspacePolicyMutation = {
      workflowId: 'builtin.workflow.photography-raw',
      defaultLayout: LAYOUT_KEYS.PIN_LIST_TOP
    }

    const res = await service.applyPolicyMutation(1, mutation)
    expect(res.policyVersion).toBeGreaterThan(0)
    expect(res.appliedConfig?.defaultLayout).toBe(LAYOUT_KEYS.PIN_LIST_TOP)

    const row = db.prepare('SELECT workspace_config FROM workspaces WHERE workspace_id = 1').get() as any
    const config = JSON.parse(row.workspace_config) as WorkspaceConfigReady
    expect(config.defaultLayout).toBe(LAYOUT_KEYS.PIN_LIST_TOP)
  })

  it('restoreWorkflowDefault: true 时，defaultLayout 恢复为当前模板值', async () => {
    // 先绑定摄影流并显式覆盖为 pin-list-top
    await service.applyPolicyMutation(1, {
      workflowId: 'builtin.workflow.photography-raw',
      defaultLayout: LAYOUT_KEYS.PIN_LIST_TOP
    })

    // 触发恢复默认
    const res = await service.applyPolicyMutation(1, { restoreWorkflowDefault: true })
    expect(res.policyVersion).toBeGreaterThan(0)
    expect(res.appliedConfig?.defaultLayout).toBe(LAYOUT_KEYS.TRI)

    const row = db.prepare('SELECT workspace_config FROM workspaces WHERE workspace_id = 1').get() as any
    const config = JSON.parse(row.workspace_config) as WorkspaceConfigReady
    expect(config.defaultLayout).toBe(LAYOUT_KEYS.TRI)
  })
})
