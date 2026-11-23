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
import { DEFAULT_UNBOUND_AI_CONFIG, CURRENT_WORKFLOW_PRESET_VERSION } from '../../config/local-workflow-source'
import { workspaceAdmissionService, type WorkspacePolicyMutation } from './workspace-admission-service'

export interface CommitWorkspacePolicyParams {
  workspaceId: string | number
  workflowId?: string
  boundWorkflowId?: string | null
  targetConfig?: WorkspaceConfigReady
  templateConfig?: Partial<WorkspaceConfigReady>
  isWorkflowSwitch?: boolean
  /** 轻量乐观锁透传 [SLICE-07]：防止双端并发写覆写 */
  expectedPolicyVersion?: number
}

export type PolicyCommitErrorCode = 'STORAGE' | 'PERMISSION' | 'CONFLICT' | 'UNKNOWN'

export interface CommitWorkspacePolicyResult {
  success: boolean
  policyVersion: number
  committedConfig?: WorkspaceConfigReady
  appliedConfig?: WorkspaceConfigReady
  errorCode?: PolicyCommitErrorCode
  errorMessage?: string
  error?: {
    code: PolicyCommitErrorCode
    message: string
    stack?: string
    details?: unknown
  }
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

const UNIVERSAL_WORKFLOW_SEED = {
  id: 'builtin.workflow.general-inbox',
  user_id: null,
  author: 'Firefly Official',
  name: '通用文件收纳与分类体系',
  version: '1.0.0',
  persona: 'general',
  category: 'office',
  summary: '适用于日常杂项文件、通用资料与冷门未分类文件的综合整理体系，全格式放行不设限',
  source: 'official',
  status: 'published',
  naming_pattern: '[创建日期]_[业务分类]_[文件名称]',
  naming_template: '[{TAG:属性}]{SMART_NAME}_{CRE:YYYYMMDD}',
  preset_directory_tree: JSON.stringify([
    {
      name: '01-收件整理',
      children: [{ name: '待处理与临时中转' }, { name: '近期常用' }]
    },
    {
      name: '02-分类存放',
      children: [{ name: '文档与资料' }, { name: '媒体与图片' }, { name: '应用与软件' }]
    },
    {
      name: '03-长期归档',
      children: [{ name: '已完结归档' }, { name: '重要备份' }]
    }
  ]),
  preview_tree: null,
  icon_svg:
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>',
  workspace_config: JSON.stringify({
    schemaVersion: 1,
    status: 'ready',
    policyVersion: 1,
    presetVersion: CURRENT_WORKFLOW_PRESET_VERSION,
    workflowId: 'builtin.workflow.general-inbox',
    extensionWeights: {},
    customExcludeRules: [],
    customIncludeRules: [],
    // 【窄边界适配】通用流补种基线统一直接消费 DEFAULT_UNBOUND_AI_CONFIG（§2.1 唯一事实源统一替换点 3）
    baseAIConfig: DEFAULT_UNBOUND_AI_CONFIG,
    workflowPluginDefaults: [],
    configuredAt: 1762425600000
  })
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
   * 原子提交工作区配置与绑定工作流（兼容薄代理 [SLICE-07]）：
   * 写盘全部委托 WorkspaceAdmissionService.applyPolicyMutation 单事务内核执行，
   * 本方法仅保留 workspaceId 校验、通用流自动补种与结构化错误分层。
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
        errorMessage: `无效的 workspaceId: ${params.workspaceId}`,
        error: {
          code: 'UNKNOWN',
          message: `无效的 workspaceId: ${params.workspaceId}`
        }
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
   * 在 SQLite 独占事务内执行通用流补种，随后委托 WorkspaceAdmissionService.applyPolicyMutation
   * 单事务写盘并回填 CommitWorkspacePolicyResult 结构
   */
  private async executeCommitTransaction(
    workspaceId: number,
    params: CommitWorkspacePolicyParams
  ): Promise<CommitWorkspacePolicyResult> {
    let db: Database
    try {
      db = this.resolveDb()
    } catch (err: any) {
      return {
        success: false,
        policyVersion: 0,
        committedConfig: params.targetConfig,
        errorCode: 'PERMISSION',
        errorMessage: err.message,
        error: {
          code: 'PERMISSION',
          message: err.message,
          stack: err.stack
        }
      }
    }

    try {
      // 1. 解析入站绑定意图：boundWorkflowId > workflowId > 保持现状（undefined 不透传）
      let effectiveWorkflowId: string | null | undefined
      if (params.boundWorkflowId !== undefined) {
        effectiveWorkflowId = params.boundWorkflowId || null
      } else if (params.workflowId !== undefined) {
        effectiveWorkflowId = params.workflowId || null
      }

      // 2. 校验目标工作流在 local_workflows 表中的物理存在性，自动补种官方通用工作流，消除外键约束冲突
      let seedWorkflowId: string | null = null
      {
        const row = db
          .prepare(
            'SELECT bound_workflow_id FROM workspaces WHERE workspace_id = ?'
          )
          .get(workspaceId) as { bound_workflow_id: string | null } | undefined
        if (!row) {
          throw new Error(`工作区 [${workspaceId}] 不存在`)
        }
        const candidate =
          effectiveWorkflowId !== undefined ? effectiveWorkflowId : (row.bound_workflow_id ?? null)

        if (candidate) {
          let hasLocalWorkflowsTable = false
          try {
            const tableCheck = db
              .prepare(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'local_workflows'"
              )
              .get()
            hasLocalWorkflowsTable = Boolean(tableCheck)
          } catch {}

          if (hasLocalWorkflowsTable) {
            let exists = db
              .prepare('SELECT 1 FROM local_workflows WHERE id = ?')
              .get(candidate)

            if (!exists && candidate === 'builtin.workflow.general-inbox') {
              // 自动补种官方通用文件工作流，消除外键约束冲突
              try {
                db.prepare(
                  `
                  INSERT OR REPLACE INTO local_workflows (
                    id, user_id, author, name, version, persona, category, summary,
                    source, status, workspace_config, naming_pattern, naming_template,
                    preset_directory_tree, preview_tree, icon_svg
                  ) VALUES (
                    @id, @user_id, @author, @name, @version, @persona, @category, @summary,
                    @source, @status, @workspace_config, @naming_pattern, @naming_template,
                    @preset_directory_tree, @preview_tree, @icon_svg
                  )
                `
                ).run(UNIVERSAL_WORKFLOW_SEED)
                exists = db
                  .prepare('SELECT 1 FROM local_workflows WHERE id = ?')
                  .get(candidate)
              } catch (seedErr: any) {
                logger.warn(
                  LogCategory.SYSTEM,
                  `[WorkspacePolicyCommitService] 补种通用工作流异常: ${seedErr.message}`
                )
              }
            }

            if (!exists) {
              logger.warn(
                LogCategory.SYSTEM,
                `[WorkspacePolicyCommitService] 绑定的工作流 [${candidate}] 不存在于 local_workflows 表中，置空以避免外键约束冲突`
              )
              if (effectiveWorkflowId !== undefined) {
                effectiveWorkflowId = null
                seedWorkflowId = null
              }
            } else if (effectiveWorkflowId === undefined) {
              seedWorkflowId = candidate
            }
          }
        }
      }

      // 3. 组装补丁化 mutation 委托 WorkspaceAdmissionService.applyPolicyMutation 单事务写盘 [SLICE-07]
      const rawTarget = (params.targetConfig || {}) as any
      const mutation: WorkspacePolicyMutation = {
        // 兼容薄代理：向导传入完整 targetConfig，不清空既有 overrides
        preserveOverrides: true,
        defaultLayout: rawTarget.defaultLayout,
        customIncludeRules: rawTarget.customIncludeRules,
        customExcludeRules: rawTarget.customExcludeRules,
        extensionWeights: rawTarget.extensionWeights,
        baseAIConfig: rawTarget.baseAIConfig,
        workflowPluginDefaults: rawTarget.workflowPluginDefaults,
        overrides: rawTarget.overrides,
        advancedAIPrompts: rawTarget.advancedAIPrompts,
        unitRecognition: rawTarget.unitRecognition,
        intent: rawTarget.intent
      }
      if (effectiveWorkflowId !== undefined) {
        mutation.workflowId = effectiveWorkflowId
      } else if (seedWorkflowId) {
        mutation.workflowId = seedWorkflowId
      }
      if (params.expectedPolicyVersion !== undefined) {
        mutation.expectedPolicyVersion = params.expectedPolicyVersion
      }

      const applied = await workspaceAdmissionService.applyPolicyMutation(
        workspaceId,
        mutation
      )

      const committedConfig =
        applied.appliedConfig ??
        (parseWorkspaceConfig(
          (
            db
              .prepare('SELECT workspace_config FROM workspaces WHERE workspace_id = ?')
              .get(workspaceId) as { workspace_config?: string } | undefined
          )?.workspace_config ?? ''
        ) as WorkspaceConfigReady)

      // 4. 使快照缓存失效并触发外部变更通知
      try {
        invalidateWorkspacePolicyCache(workspaceId)
      } catch (cacheErr) {
        logger.warn(
          LogCategory.SYSTEM,
          `[WorkspacePolicyCommitService] 作废工作区 ${workspaceId} 策略缓存失败:`,
          cacheErr
        )
      }

      if (this.deps.onPolicyCommitted && committedConfig) {
        try {
          this.deps.onPolicyCommitted(workspaceId, applied.policyVersion, committedConfig)
        } catch (eventErr: any) {
          logger.warn(
            LogCategory.SYSTEM,
            `[WorkspacePolicyCommitService] 策略变更事件触发异常: ${eventErr.message}`
          )
        }
      }

      return {
        success: true,
        policyVersion: applied.policyVersion,
        committedConfig,
        appliedConfig: committedConfig
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
        errorMessage: err.message,
        error: {
          code: errorCode,
          message: err.message,
          stack: err.stack
        }
      }
    }
  }
}

/** 默认导出的主进程单例 */
export const workspacePolicyCommitService = new WorkspacePolicyCommitService()
