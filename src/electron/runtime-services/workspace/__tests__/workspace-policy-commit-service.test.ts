/**
 * 主进程工作区策略提交服务单元测试 (Spec v1.1 §2.2 & Ticket 03)
 *
 * 核心验证目标：
 * 1. AC-3.1: 单事务原子更新 workspace_config 与 bound_workflow_id；
 * 2. AC-3.2: 并发 10 次提交下 policyVersion 严格单调递增 (防撕裂与旧版本覆盖)；
 * 3. AC-3.3: 切换工作流时模板规则 (isSystem: true) 替换，用户规则 (isSystem: false) 100% 保留合并；
 * 4. AC-3.4: 模拟 SQLite 异常 (SQLITE_FULL / SQLITE_BUSY / 权限只读) 结构化错误分层 (STORAGE / CONFLICT / PERMISSION)；
 * 5. AC-3.5: 事务提交成功后触发变更事件并使缓存失效。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'
import {
  WorkspacePolicyCommitService,
  CommitWorkspacePolicyParams
} from '../workspace-policy-commit-service'
import type { WorkspaceConfigReady, IFilterRule } from '@firefly/types'

describe('WorkspacePolicyCommitService (Spec v1.1 §2.2 & Ticket 03)', () => {
  let db: Database.Database
  let service: WorkspacePolicyCommitService

  const initialWorkspaceConfig: WorkspaceConfigReady = {
    schemaVersion: 1,
    status: 'ready',
    policyVersion: 1,
    customIgnoreRules: [
      {
        id: 'sys-rule-1',
        type: 'folder',
        value: 'node_modules',
        isActive: true,
        isSystem: true
      },
      {
        id: 'user-rule-1',
        type: 'folder',
        value: 'my-private-docs',
        isActive: true,
        isSystem: false
      }
    ],
    customWhitelistRules: [
      {
        id: 'sys-wl-1',
        type: 'extension',
        value: '.docx',
        isActive: true,
        isSystem: true
      },
      {
        id: 'user-wl-1',
        type: 'extension',
        value: '.secret',
        isActive: true,
        isSystem: false
      }
    ],
    baseAIConfig: {
      analysisMode: 'simple',
      embeddingProfile: 'classic_light',
      mrlDimension: 256,
      batchSize: 10,
      embeddingBatchSize: 32,
      concurrency: 2,
      audioAnalysisDurationSec: 0,
      enableImageOcr: false,
      ocrModelSize: 'tiny',
      maxContentSizeKb: 1024,
      enableOfficeCover: true,
      reuseBasicAnalysisData: true
    }
  }

  beforeEach(() => {
    // 创建内存 SQLite 数据库并建立 Genesis V1 标准 workspaces 表结构
    db = new Database(':memory:')
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
    `)

    // 插入一条基线测试工作区数据
    db.prepare(
      `
      INSERT INTO workspaces (workspace_id, path, name, workspace_config, bound_workflow_id)
      VALUES (1, '/test/workspace', '测试工作区', ?, 'builtin.workflow.general-inbox');
    `
    ).run(JSON.stringify(initialWorkspaceConfig))

    service = new WorkspacePolicyCommitService({ db })
  })

  afterEach(() => {
    if (db) {
      db.close()
    }
  })

  describe('AC-3.1: 单事务原子更新与基线提交', () => {
    it('成功提交时，应在单条事务内同步更新 bound_workflow_id 与自增 policyVersion', async () => {
      const targetConfig: WorkspaceConfigReady = {
        ...initialWorkspaceConfig,
        policyVersion: 999 // 模拟前端传的错误/乐观版本号 (主进程必须忽略并自增)
      }

      const params: CommitWorkspacePolicyParams = {
        workspaceId: 1,
        workflowId: 'builtin.workflow.photography-raw',
        targetConfig,
        isWorkflowSwitch: false
      }

      const result = await service.commitPolicy(params)
      expect(result.success).toBe(true)
      expect(result.policyVersion).toBe(2) // 1 ➔ 2
      expect(result.committedConfig.policyVersion).toBe(2)
      expect(result.committedConfig.status).toBe('ready')

      // 从数据库中真实读取校验
      const row = db
        .prepare(
          'SELECT workspace_config, bound_workflow_id FROM workspaces WHERE workspace_id = 1'
        )
        .get() as { workspace_config: string; bound_workflow_id: string }

      expect(row.bound_workflow_id).toBe('builtin.workflow.photography-raw')
      const storedConfig = JSON.parse(row.workspace_config)
      expect(storedConfig.policyVersion).toBe(2)
      expect(storedConfig.status).toBe('ready')
    })

    it('当目标工作区不存在时，应优雅返回失败并标明错误信息', async () => {
      const params: CommitWorkspacePolicyParams = {
        workspaceId: 99999,
        workflowId: 'builtin.workflow.photography-raw',
        targetConfig: initialWorkspaceConfig
      }

      const result = await service.commitPolicy(params)
      expect(result.success).toBe(false)
      expect(result.errorMessage).toContain('工作区 [99999] 不存在')
    })
  })

  describe('AC-3.2: 并发 10 次提交下的单调递增与防版本撕裂', () => {
    it('模拟 10 次高并发或狂击保存请求，policyVersion 应严格按 2, 3, ..., 11 串行单调递增', async () => {
      const concurrencyCount = 10
      const promises: Promise<any>[] = []

      for (let i = 0; i < concurrencyCount; i++) {
        const params: CommitWorkspacePolicyParams = {
          workspaceId: 1,
          workflowId: `builtin.workflow.test-${i}`,
          targetConfig: {
            ...initialWorkspaceConfig,
            baseAIConfig: {
              ...initialWorkspaceConfig.baseAIConfig,
              concurrency: i + 1
            }
          }
        }
        promises.push(service.commitPolicy(params))
      }

      const results = await Promise.all(promises)

      // 所有提交均应成功
      for (const res of results) {
        expect(res.success).toBe(true)
      }

      // 获取各次提交生成的 policyVersion，断言严格无重复且最终达到 11
      const versions = results.map(r => r.policyVersion)
      expect(versions).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11])

      // 验证数据库最终落库状态
      const row = db
        .prepare('SELECT workspace_config FROM workspaces WHERE workspace_id = 1')
        .get() as { workspace_config: string }
      const finalConfig = JSON.parse(row.workspace_config)
      expect(finalConfig.policyVersion).toBe(11)
    })
  })

  describe('AC-3.3: 工作流切换时的规则合并策略 (Merge Policy)', () => {
    it('切换工作流 (isWorkflowSwitch: true) 时，模板预设规则替换，用户自建规则强制保留合并', async () => {
      // 构造新工作流的预设模板规则
      const newWorkflowConfig: WorkspaceConfigReady = {
        ...initialWorkspaceConfig,
        customIgnoreRules: [
          // 新模板自带的系统排除规则
          {
            id: 'tpl-rule-cache',
            type: 'folder',
            value: '.cache',
            isActive: true,
            isSystem: true
          }
        ],
        customWhitelistRules: [
          // 新模板自带的系统白名单规则
          {
            id: 'tpl-wl-raw',
            type: 'extension',
            value: '.cr3',
            isActive: true,
            isSystem: true
          }
        ]
      }

      const params: CommitWorkspacePolicyParams = {
        workspaceId: 1,
        workflowId: 'builtin.workflow.photography-raw',
        targetConfig: newWorkflowConfig,
        isWorkflowSwitch: true
      }

      const result = await service.commitPolicy(params)
      expect(result.success).toBe(true)

      const mergedIgnores = result.committedConfig.customIgnoreRules || []
      const mergedWhitelists = result.committedConfig.customWhitelistRules || []

      // 1. 旧模板预设规则 (node_modules, isSystem: true) 应被替换清除
      expect(mergedIgnores.some(r => r.value === 'node_modules')).toBe(false)

      // 2. 新模板预设规则 (.cache, isSystem: true) 应成功合入
      expect(mergedIgnores.some(r => r.value === '.cache' && r.isSystem === true)).toBe(true)

      // 3. 用户之前手动配置的自定义排除规则 (my-private-docs, isSystem: false) 必须完整保留！
      expect(mergedIgnores.some(r => r.value === 'my-private-docs' && r.isSystem === false)).toBe(
        true
      )

      // 4. 白名单同理：旧模板 .docx 被替换，新模板 .cr3 写入，用户自建 .secret 必须保留！
      expect(mergedWhitelists.some(r => r.value === '.docx')).toBe(false)
      expect(mergedWhitelists.some(r => r.value === '.cr3' && r.isSystem === true)).toBe(true)
      expect(mergedWhitelists.some(r => r.value === '.secret' && r.isSystem === false)).toBe(true)
    })
  })

  describe('AC-3.4: SQLite 异常捕获与结构化错误分层', () => {
    it('当磁盘已满 (SQLITE_FULL) 时，映射为 STORAGE 错误码', async () => {
      // 模拟 db.transaction 抛出 SQLITE_FULL
      vi.spyOn(db, 'transaction').mockImplementation(() => () => {
        const err: any = new Error('database or disk is full')
        err.code = 'SQLITE_FULL'
        throw err
      })

      const result = await service.commitPolicy({
        workspaceId: 1,
        workflowId: 'builtin.workflow.photography-raw',
        targetConfig: initialWorkspaceConfig
      })

      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('STORAGE')
      expect(result.committedConfig).toBe(initialWorkspaceConfig) // 内存态草稿完整保留
    })

    it('当数据库忙锁 (SQLITE_BUSY) 时，映射为 CONFLICT 错误码', async () => {
      vi.spyOn(db, 'transaction').mockImplementation(() => () => {
        const err: any = new Error('database is locked')
        err.code = 'SQLITE_BUSY'
        throw err
      })

      const result = await service.commitPolicy({
        workspaceId: 1,
        workflowId: 'builtin.workflow.photography-raw',
        targetConfig: initialWorkspaceConfig
      })

      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('CONFLICT')
    })

    it('当数据库只读或无权限 (SQLITE_READONLY / EACCES) 时，映射为 PERMISSION 错误码', async () => {
      vi.spyOn(db, 'transaction').mockImplementation(() => () => {
        const err: any = new Error('attempt to write a readonly database')
        err.code = 'SQLITE_READONLY'
        throw err
      })

      const result = await service.commitPolicy({
        workspaceId: 1,
        workflowId: 'builtin.workflow.photography-raw',
        targetConfig: initialWorkspaceConfig
      })

      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('PERMISSION')
    })

    it('当数据库未提供且未初始化时，应返回包含 error 结构体与 PERMISSION 错误码的结果', async () => {
      const bareService = new WorkspacePolicyCommitService({})
      const result = await bareService.commitPolicy({
        workspaceId: 1,
        workflowId: 'builtin.workflow.photography-raw',
        targetConfig: initialWorkspaceConfig
      })

      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('PERMISSION')
      expect(result.error).toBeDefined()
      expect(result.error?.code).toBe('PERMISSION')
      expect(result.error?.message).toContain('数据库尚未初始化且未提供 db 依赖')
    })

    it('当 workspaceId 非法时，应返回包含 error 结构体与 UNKNOWN 错误码的结果', async () => {
      const result = await service.commitPolicy({
        workspaceId: 0,
        workflowId: 'builtin.workflow.photography-raw',
        targetConfig: initialWorkspaceConfig
      })

      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('UNKNOWN')
      expect(result.error).toBeDefined()
      expect(result.error?.code).toBe('UNKNOWN')
      expect(result.error?.message).toContain('无效的 workspaceId')
    })

    it('当未提供 workflowId 时，bound_workflow_id 应为 NULL 而非空字符串（杜绝外键破坏）', async () => {
      const result = await service.commitPolicy({
        workspaceId: 1,
        workflowId: '',
        boundWorkflowId: null,
        targetConfig: initialWorkspaceConfig
      })

      expect(result.success).toBe(true)
      const row = db
        .prepare('SELECT bound_workflow_id FROM workspaces WHERE workspace_id = 1')
        .get() as any
      expect(row.bound_workflow_id).toBeNull()
    })
  })

  describe('AC-3.5: 事务提交成功后事件驱动与回调触发', () => {
    it('成功提交后应精准调用 onPolicyCommitted 回调并传递落库快照与新版本号', async () => {
      const onPolicyCommittedMock = vi.fn()
      service.configureDependencies({ onPolicyCommitted: onPolicyCommittedMock })

      const result = await service.commitPolicy({
        workspaceId: 1,
        workflowId: 'builtin.workflow.photography-raw',
        targetConfig: initialWorkspaceConfig
      })

      expect(result.success).toBe(true)
      expect(onPolicyCommittedMock).toHaveBeenCalledTimes(1)
      expect(onPolicyCommittedMock).toHaveBeenCalledWith(
        1,
        2,
        expect.objectContaining({
          policyVersion: 2,
          status: 'ready'
        })
      )
    })
  })
})
