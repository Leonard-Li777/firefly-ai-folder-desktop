import { describe, it, expect, vi } from 'vitest'
import { getFileCategory } from '@firefly/shared'
import { FileCategory } from '@firefly/types'
import {
  SHORTCUT_EXTENSIONS,
  DOCUMENT_EXTENSIONS
} from '../../filesystem/directory-profiler-service'
import { recommendWorkflowByProfile } from '../../workflow/workflow-preset-and-recommender'
import { BLUEPRINT_STATIC_TEMPLATES } from '../../../config/organize-taxonomy-source'

describe('Universal Workflow & Empty Admission Diagnostics & .chm Category Tests', () => {
  it('1. .chm 文件必须归类为 EBOOK，计入 DOCUMENT_EXTENSIONS，绝对禁止归入 SHORTCUT_EXTENSIONS', () => {
    const filename = '1321篇H书籍.chm'
    const category = getFileCategory(filename)
    expect(category).toBe(FileCategory.EBOOK)
    expect(DOCUMENT_EXTENSIONS.has('chm')).toBe(true)
    expect(SHORTCUT_EXTENSIONS.has('chm')).toBe(false)
  })

  it('2. 当目录下所有文件扩展名未匹配任何垂直工作流时，必须强制推荐通用工作流 (zero_extension_match)', () => {
    const stats: any = {
      totalSampled: 3,
      totalFiles: 3,
      docCount: 3,
      imageCount: 0,
      videoCount: 0,
      otherCount: 0,
      countsByExt: { chm: 3 },
      extensionCounts: { chm: 3 },
      topExtensions: [{ ext: 'chm', count: 3 }]
    }

    const recs = recommendWorkflowByProfile(stats, BLUEPRINT_STATIC_TEMPLATES)
    expect(recs.length).toBeGreaterThan(0)
    const top = recs[0]
    expect(top.workflowId).toBe('builtin.workflow.general-inbox')
    expect(top.isTopRecommendation).toBe(true)
    expect(top.reasonCode).toBe('zero_extension_match')
  })

  it('3. 当样本量 >= 5 但所有扩展名均为冷门未收录格式时，必须命中 zero_extension_match 通用兜底', () => {
    const stats: any = {
      totalSampled: 10,
      totalFiles: 10,
      docCount: 10,
      imageCount: 0,
      videoCount: 0,
      otherCount: 0,
      countsByExt: { chm: 10 },
      extensionCounts: { chm: 10 },
      topExtensions: [{ ext: 'chm', count: 10 }]
    }

    const recs = recommendWorkflowByProfile(stats, BLUEPRINT_STATIC_TEMPLATES)
    expect(recs.length).toBeGreaterThan(0)
    const top = recs[0]
    expect(top.workflowId).toBe('builtin.workflow.general-inbox')
    expect(top.reasonCode).toBe('zero_extension_match')
    expect(top.isTopRecommendation).toBe(true)
    expect(top.score).toBe(60)
  })

  it('4. 当工作区绑定 builtin.workflow.general-inbox 且开启 SQLite 外键约束时，策略提交必须成功且杜绝 FOREIGN KEY 异常', async () => {
    const Database = (await import('better-sqlite3')).default
    const { WorkspacePolicyCommitService } = await import('../../workspace/workspace-policy-commit-service')

    const db = new Database(':memory:')
    // 强制开启外键约束检查
    db.pragma('foreign_keys = ON')

    // 建立标准 Genesis V1 local_workflows 表与 workspaces 表
    db.exec(`
      CREATE TABLE local_workflows (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        author TEXT,
        name TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '1.0.0',
        persona TEXT NOT NULL,
        category TEXT NOT NULL,
        summary TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL,
        workspace_config TEXT NOT NULL,
        naming_pattern TEXT,
        naming_template TEXT,
        preset_directory_tree TEXT,
        preview_tree TEXT,
        icon_svg TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        modified_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

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
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (bound_workflow_id) REFERENCES local_workflows(id) ON DELETE SET NULL
      );
    `)

    // 插入待配置的工作区
    db.prepare(`
      INSERT INTO workspaces (workspace_id, path, name, workspace_config)
      VALUES (1, 'G:\\\\person\\\\H\\\\小说\\\\成人小说', '成人小说', '{"schemaVersion":1,"status":"pending"}');
    `).run()

    const commitService = new WorkspacePolicyCommitService({ db })

    // 提交策略：绑定通用文件收纳体系
    const result = await commitService.commitPolicy({
      workspaceId: 1,
      boundWorkflowId: 'builtin.workflow.general-inbox',
      targetConfig: {
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId: 'builtin.workflow.general-inbox',
        customExcludeRules: [],
        customIncludeRules: [],
        baseAIConfig: {
          analysisMode: 'simple',
          embeddingProfile: 'classic_light',
          mrlDimension: 256
        }
      } as any
    })

    expect(result.success).toBe(true)
    expect(result.errorCode).toBeUndefined()

    // 验证外键已物理满足且 workspaces.bound_workflow_id 成功写入
    const row = db.prepare('SELECT bound_workflow_id FROM workspaces WHERE workspace_id = 1').get() as any
    expect(row.bound_workflow_id).toBe('builtin.workflow.general-inbox')

    const wfRow = db.prepare('SELECT id, name FROM local_workflows WHERE id = ?').get('builtin.workflow.general-inbox') as any
    expect(wfRow).toBeDefined()
    expect(wfRow.id).toBe('builtin.workflow.general-inbox')
  })
})
