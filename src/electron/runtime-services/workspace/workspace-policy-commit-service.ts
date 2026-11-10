/**
 * 主进程工作区策略提交服务 (WorkspacePolicyCommitService)
 * 遵循 Spec v1.1 §2.2 与 Ticket 03 规范：
 *
 * 核心职责：
 * 1. 接管工作区创建、向导配置应用、工作流切换与高级设置微调的持久化事务；
 * 2. 单条 SQL 原子递增 policyVersion：通过 COALESCE(...) + 1 实现单调递增，主进程为版本单一事实源；
 * 3. 规则合并策略 (Merge Policy)：切换工作流时模板规则 (isSystem: true) 替换，用户规则 (isSystem: false) 强制保留合并；
 * 4. 提交成功后事件驱动快照刷新 (workspace:policy-updated)，严禁使用内存草稿提前缓存；
 * 5. 结构化错误分层：明确区分 STORAGE (磁盘满)、PERMISSION (权限/只读)、CONFLICT (忙锁竞争) 与 UNKNOWN。
 */

import type { Database } from 'better-sqlite3'
import {
  type WorkspaceConfigReady,
  type IFilterRule,
  parseWorkspaceConfig,
  isWorkspaceConfigReady
} from '@firefly/types'
import { invalidateWorkspacePolicyCache, LogCategory, logger } from '@firefly/shared'

export interface CommitWorkspacePolicyParams {
  workspaceId: string | number
  workflowId: string
  targetConfig: WorkspaceConfigReady
  isWorkflowSwitch?: boolean
}

export type PolicyCommitErrorCode = 'STORAGE' | 'PERMISSION' | 'CONFLICT' | 'UNKNOWN'

export interface CommitWorkspacePolicyResult {
  success: boolean
  policyVersion: number
  committedConfig: WorkspaceConfigReady
  errorCode?: PolicyCommitErrorCode
  errorMessage?: string
}

export interface WorkspacePolicyCommitDependencies {
  db?: Database
  getDb?: () => Database | null
  onPolicyCommitted?: (
    workspaceId: number,
    policyVersion: number,
    config: WorkspaceConfigReady
  ) => void | Promise<void>
}

/**
 * 规则去重与合并辅助函数
 * 以 type:value 为键，用户规则覆盖同名模板规则或追加，保留最新激活状态
 */
function mergeRules(
  templateRules: readonly IFilterRule[],
  userRules: readonly IFilterRule[]
): IFilterRule[] {
  const map = new Map<string, IFilterRule>()
  for (const r of templateRules) {
    if (!r || typeof r.value !== 'string') continue
    const key = `${r.type}:${r.value.trim().toLowerCase()}`
    map.set(key, { ...r, isSystem: true })
  }
  for (const r of userRules) {
    if (!r || typeof r.value !== 'string') continue
    const key = `${r.type}:${r.value.trim().toLowerCase()}`
    map.set(key, { ...r, isSystem: false })
  }
  return Array.from(map.values())
}

/**
 * 结构化 SQLite 错误码映射
 */
function mapSqliteErrorCode(err: any): PolicyCommitErrorCode {
  if (!err) return 'UNKNOWN'
  const code = String(err.code || err.message || '')
  if (code.includes('SQLITE_FULL') || code.includes('ENOSPC')) {
    return 'STORAGE'
  }
  if (
    code.includes('SQLITE_AUTH') ||
    code.includes('SQLITE_READONLY') ||
    code.includes('EACCES') ||
    code.includes('EPERM')
  ) {
    return 'PERMISSION'
  }
  if (code.includes('SQLITE_BUSY') || code.includes('SQLITE_LOCKED')) {
    return 'CONFLICT'
  }
  return 'UNKNOWN'
}

export class WorkspacePolicyCommitService {
  private deps: WorkspacePolicyCommitDependencies
  /** 按 workspaceId 维护的串行执行队列锁，防止并发冲突与撕裂 */
  private workspaceQueues = new Map<number, Promise<any>>()

  constructor(deps: WorkspacePolicyCommitDependencies = {}) {
    this.deps = deps
  }

  /**
   * 启动期或测试中注入数据库依赖
   */
  configureDependencies(deps: WorkspacePolicyCommitDependencies): void {
    this.deps = { ...this.deps, ...deps }
  }

  private resolveDb(): Database {
    if (this.deps.db) return this.deps.db
    if (this.deps.getDb) {
      const db = this.deps.getDb()
      if (db) return db
    }
    // 降级尝试获取 DatabaseService 实例
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { databaseService } = require('../database/database-service')
      if (databaseService && databaseService.db) {
        return databaseService.db
      }
    } catch {}
    throw new Error('WorkspacePolicyCommitService: 数据库尚未初始化且未提供 db 依赖')
  }

  /**
   * 原子提交工作区配置与绑定工作流 (主进程单一权威写入口)
   */
  async commitPolicy(params: CommitWorkspacePolicyParams): Promise<CommitWorkspacePolicyResult> {
    const numericWorkspaceId =
      typeof params.workspaceId === 'number' ? params.workspaceId : parseInt(params.workspaceId, 10)

    if (Number.isNaN(numericWorkspaceId) || numericWorkspaceId <= 0) {
      return {
        success: false,
        policyVersion: 0,
        committedConfig: params.targetConfig,
        errorCode: 'UNKNOWN',
        errorMessage: `无效的 workspaceId: ${params.workspaceId}`
      }
    }

    // 按 workspaceId 排队串行执行，确保进程内并发完全序列化
    const previousTask = this.workspaceQueues.get(numericWorkspaceId) || Promise.resolve()
    const currentTask = previousTask.then(
      () => this.executeCommitTransaction(numericWorkspaceId, params),
      () => this.executeCommitTransaction(numericWorkspaceId, params)
    )

    this.workspaceQueues.set(numericWorkspaceId, currentTask)

    try {
      return await currentTask
    } finally {
      if (this.workspaceQueues.get(numericWorkspaceId) === currentTask) {
        this.workspaceQueues.delete(numericWorkspaceId)
      }
    }
  }

  /**
   * 在 SQLite 独占事务内执行单条 SQL 原子递增与规则合并
   */
  private executeCommitTransaction(
    workspaceId: number,
    params: CommitWorkspacePolicyParams
  ): CommitWorkspacePolicyResult {
    let db: Database
    try {
      db = this.resolveDb()
    } catch (err: any) {
      return {
        success: false,
        policyVersion: 0,
        committedConfig: params.targetConfig,
        errorCode: 'PERMISSION',
        errorMessage: err.message
      }
    }

    try {
      let finalCommittedConfig: WorkspaceConfigReady | null = null
      let newPolicyVersion = 0

      const runInTx = db.transaction(() => {
        // 1. 读取当前记录
        const row = db
          .prepare(
            'SELECT workspace_id, workspace_config, bound_workflow_id FROM workspaces WHERE workspace_id = ?'
          )
          .get(workspaceId) as
          | { workspace_id: number; workspace_config: string; bound_workflow_id: string | null }
          | undefined

        if (!row) {
          throw new Error(`工作区 [${workspaceId}] 不存在`)
        }

        let configToPersist: WorkspaceConfigReady = { ...params.targetConfig }

        // 2. 规则合并策略 (Merge Policy)：切换工作流时保留用户自建规则
        if (params.isWorkflowSwitch) {
          const prevConfig = parseWorkspaceConfig(row.workspace_config)
          const prevReady = prevConfig.status === 'ready' ? prevConfig : null

          const userIgnores = (prevReady?.customIgnoreRules || []).filter((r: any) => !r.isSystem)
          const userWhitelists = (prevReady?.customWhitelistRules || []).filter(
            (r: any) => !r.isSystem
          )

          const newTemplateIgnores = (configToPersist.customIgnoreRules || []).filter(
            (r: any) => r.isSystem
          )
          const newTemplateWhitelists = (configToPersist.customWhitelistRules || []).filter(
            (r: any) => r.isSystem
          )

          configToPersist.customIgnoreRules = mergeRules(newTemplateIgnores, userIgnores)
          configToPersist.customWhitelistRules = mergeRules(newTemplateWhitelists, userWhitelists)
        }

        // 确保状态就绪与模式版本对齐
        configToPersist.status = 'ready'
        configToPersist.schemaVersion = 1

        const serializedConfig = JSON.stringify(configToPersist)

        // 3. 单条 SQL 原子更新 bound_workflow_id 与自增 policyVersion
        // 遵循 Genesis V1 列名：workspace_id, bound_workflow_id, workspace_config
        const updateStmt = db.prepare(`
          UPDATE workspaces
          SET
            bound_workflow_id = ?,
            workspace_config = json_set(
              ?,
              '$.policyVersion',
              COALESCE(json_extract(workspace_config, '$.policyVersion'), 0) + 1,
              '$.status',
              'ready'
            )
          WHERE workspace_id = ?;
        `)

        const updateResult = updateStmt.run(params.workflowId, serializedConfig, workspaceId)

        if (updateResult.changes <= 0) {
          throw new Error(`原子更新工作区 [${workspaceId}] 失败，受影响行数为 0`)
        }

        // 4. 事务内立即可读回写成果并提取最新版本号
        const updatedRow = db
          .prepare('SELECT workspace_config FROM workspaces WHERE workspace_id = ?')
          .get(workspaceId) as { workspace_config: string }

        const parsedResult = parseWorkspaceConfig(updatedRow.workspace_config)
        newPolicyVersion = parsedResult.status === 'ready' ? (parsedResult.policyVersion ?? 1) : 1
        finalCommittedConfig = parsedResult.status === 'ready' ? parsedResult : null
      })

      // 执行事务
      runInTx()

      if (!finalCommittedConfig) {
        throw new Error('未能获取已提交的工作区配置快照')
      }

      // 5. 事务提交成功后，使快照缓存失效并触发外部变更通知
      try {
        invalidateWorkspacePolicyCache(workspaceId)
      } catch {}

      if (this.deps.onPolicyCommitted) {
        try {
          this.deps.onPolicyCommitted(workspaceId, newPolicyVersion, finalCommittedConfig)
        } catch (eventErr: any) {
          logger.warn(
            LogCategory.SYSTEM,
            `[WorkspacePolicyCommitService] 策略变更事件触发异常: ${eventErr.message}`
          )
        }
      }

      return {
        success: true,
        policyVersion: newPolicyVersion,
        committedConfig: finalCommittedConfig
      }
    } catch (err: any) {
      const errorCode = mapSqliteErrorCode(err)
      logger.error(
        LogCategory.SYSTEM,
        `[WorkspacePolicyCommitService] 提交策略失败 (${errorCode}): ${err.message}`
      )

      return {
        success: false,
        policyVersion: 0,
        committedConfig: params.targetConfig,
        errorCode,
        errorMessage: err.message
      }
    }
  }
}

/** 默认导出的主进程单例 */
export const workspacePolicyCommitService = new WorkspacePolicyCommitService()
