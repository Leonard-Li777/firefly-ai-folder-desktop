/**
 * 工作区文件准入与过滤策略深模块 (WorkspaceAdmissionService)
 *
 * 职责边界：
 * 1. 单一配置源：所有包含（白名单）与排除（黑名单）规则统一持久化在 `workspaces.workspace_config` JSON 与 `bound_workflow_id` 中，
 *    无 `whitelist_patterns` 物理数据库列。
 * 2. 四阶单层短路决策：系统硬排除 > 用户自定义排除规则 (excludeRules) > 排他包含规则 (includeRules + 8 种伴生文件特权) > 默认准入放行。
 * 3. 版本单调递增与指纹短路 (M01/M02)：主进程唯一版本权威。当修改 AI 温度/并发/Prompt/命名模板等非准入字段时，
 *    准入指纹完全一致且元数据已对齐，直接短路返回零 I/O；指纹变化时原子自增 policyVersion。
 * 4. 索引解绑绝不删物理文件 (IN-02 铁律)：策略收紧后仅从 `workspace_files` 与 `analysis_queue` 移除失配索引及待处理任务，
 *    绝对禁止调用 `fs.unlink` / `fs.rm` 删除用户磁盘上的物理文件。
 * 5. 准入对账后置回写与非阻塞自愈 (Y-02/Y-07)：workspaces.meta.admittedPolicyHash 仅在解绑、裁剪与重扫全部成功后回写；
 *    启动时由 reconcileAllWorkspacesOnStartup 异步非阻塞对账自愈。
 */

import type { Database } from 'better-sqlite3'
import path from 'node:path'
import {
  isWorkspaceConfigReady,
  parseWorkspaceConfig,
  serializeWorkspaceConfig,
  type IFilterRule,
  type LocalWorkflowRecord,
  type TechnicalEngineParameters,
  type WorkspaceConfig,
  type WorkspaceConfigIntent,
  type WorkspaceConfigReady
} from '@firefly/types'
import {
  compileFilterPolicy,
  computeAdmissionFingerprint,
  invalidateWorkspacePolicyCache,
  isPolicyRelaxed,
  LogCategory,
  logger,
  mapIntentToParameters,
  resolveEffectiveFilterPolicy,
  shouldDescendDirectory,
  shouldIgnoreFileByRules,
  shouldIngressFile,
  type EffectiveFilterPolicy
} from '@firefly/shared'
import { LOCAL_WORKFLOW_CONFIG_SOURCE } from '../../config/organize-taxonomy-source'

export interface WorkspacePolicyMutation {
  workflowId?: string | null
  restoreWorkflowDefault?: boolean
  /** 排他包含扩展名列表 (规范对称命名，如 ['.cr3', '.jpg']) */
  includeExts?: string[]
  /** 包含规则对象列表 (白名单模式) */
  includeRules?: IFilterRule[]
  /** 用户自定义排除规则列表 (黑名单) */
  excludeRules?: IFilterRule[]
  /** 兼容旧别名 (服务层自动解包归一) */
  customWhitelistExts?: string[]
  customWhitelistRules?: IFilterRule[]
  customIgnoreRules?: IFilterRule[]
  baseAIConfig?: WorkspaceConfig['baseAIConfig']
  derivedSnapshot?: TechnicalEngineParameters
  intent?: WorkspaceConfigIntent
  overrides?: Partial<TechnicalEngineParameters>
  advancedAIPrompts?: WorkspaceConfigReady['advancedAIPrompts']
  unitRecognition?: WorkspaceConfigReady['unitRecognition']
  namingPattern?: string
  namingTemplate?: string
}

export interface PolicyImpactPreview {
  totalFiles: number
  includedFiles: number
  excludedFiles: number
  companionFilesProtected: number
}

export interface AdmissionReconcileResult {
  policyVersion: number
  /** 编译后准入指纹是否发生变化（仅修改 AI 温度/并发/Prompt/命名模板时为 false，短路零 I/O） */
  admissionChanged: boolean
  /** 是否放宽了准入范围而触发了增量补扫（仅收紧规则或未变化时为 false） */
  needsRescan: boolean
  prunedFilesCount: number
  cancelledTasksCount: number
  cancelledTaskDetails?: {
    pendingCount: number
    analyzingCount: number
  }
}

export interface IWorkspaceAdmissionService {
  /** 获取编译后的不可变策略快照（内部管理 `${workspaceId}:${policyVersion}` 缓存） */
  getEffectivePolicy(workspaceId: number): EffectiveFilterPolicy

  /**
   * 判定单个文件或目录是否允许准入（封装四阶单层短路与伴生主文件同目录校验）
   */
  shouldAdmitFile(
    workspaceId: number,
    filePath: string,
    isDir: boolean,
    siblingEntries?: string[]
  ): boolean

  /**
   * 预览策略变更对当前工作区或探测画像的影响（含伴生文件保护计数，零污染生产策略缓存）
   */
  previewPolicyImpact(
    workspaceId: number,
    mutation: WorkspacePolicyMutation,
    probeExtensionCounts?: Record<string, number>
  ): Promise<PolicyImpactPreview>

  /**
   * 原子应用策略变更（唯一写入口，按 workspaceId 串行队列执行）：
   * 1. 忽略前端传入的旧版本，主进程为单一权威；
   * 2. 准入指纹比对：若指纹未变且 meta.admittedPolicyHash 匹配，短路返回零 I/O；
   * 3. 若指纹变化：自增 policyVersion，第一阶段微事务写入配置；
   * 4. 第二阶段非阻塞批量解绑失配文件（零磁盘 I/O）并取消队列任务；
   * 5. 若规则放宽则通知重扫；全流程成功后后置回写 workspaces.meta.admittedPolicyHash。
   */
  applyPolicyMutation(
    workspaceId: number,
    mutation: WorkspacePolicyMutation
  ): Promise<AdmissionReconcileResult>

  /**
   * 启动期电平触发自愈对账 (ALT-1 / Y-02 / Y-07)
   */
  reconcileAllWorkspacesOnStartup?(): Promise<number>
}

export interface WorkspaceAdmissionDependencies {
  db?: Database
  /** 运行期数据库提供者；返回 null 表示数据库尚未初始化，由 resolveDb 给出明确错误 */
  getDb?: () => Database | null
  systemRulesProvider?: () => IFilterRule[]
  queueCancelUnmatched?: (
    workspaceId: number,
    policy: EffectiveFilterPolicy
  ) => { cancelledCount: number } | Promise<{ cancelledCount: number }>
  onPolicyApplied?: (workspaceId: number, policy: EffectiveFilterPolicy) => void | Promise<void>
}

/**
 * 将扩展名字符串数组转换为标准 IFilterRule 数组
 */
export function normalizeExtensionsToFilterRules(exts: string[]): IFilterRule[] {
  const seen = new Set<string>()
  const rules: IFilterRule[] = []
  for (let i = 0; i < exts.length; i++) {
    const raw = typeof exts[i] === 'string' ? exts[i].trim().toLowerCase() : ''
    if (!raw) continue
    const normalized = raw.startsWith('.') ? raw : `.${raw}`
    if (seen.has(normalized)) continue
    seen.add(normalized)
    rules.push({
      id: `whitelist-${rules.length + 1}-${normalized.slice(1)}`,
      type: 'extension',
      value: normalized,
      isActive: true,
      isSystem: false
    })
  }
  return rules
}

/**
 * 归一化规则列表（兼容纯字符串与 IFilterRule 对象）
 */
function normalizeRuleList(
  rules: Array<IFilterRule | string> | undefined | null,
  prefix = 'rule'
): IFilterRule[] {
  if (!Array.isArray(rules)) return []
  const result: IFilterRule[] = []
  for (let i = 0; i < rules.length; i++) {
    const item = rules[i]
    if (typeof item === 'string') {
      const trimmed = item.trim().toLowerCase()
      if (!trimmed) continue
      const normalized = trimmed.startsWith('.') ? trimmed : `.${trimmed}`
      result.push({
        id: `${prefix}-${i + 1}-${normalized.slice(1)}`,
        type: 'extension',
        value: normalized,
        isActive: true,
        isSystem: false
      })
    } else if (item && typeof item === 'object' && typeof item.value === 'string') {
      const trimmed = item.value.trim()
      if (!trimmed) continue
      const value =
        item.type === 'extension'
          ? trimmed.toLowerCase().startsWith('.')
            ? trimmed.toLowerCase()
            : `.${trimmed.toLowerCase()}`
          : trimmed
      result.push({
        ...item,
        id: item.id || `${prefix}-${i + 1}`,
        value,
        isActive: item.isActive !== undefined ? Boolean(item.isActive) : true,
        isSystem: Boolean(item.isSystem)
      })
    }
  }
  return result
}

export class WorkspaceAdmissionService implements IWorkspaceAdmissionService {
  private deps: WorkspaceAdmissionDependencies
  /** 按 workspaceId 维护的串行执行队列锁，防止并发冲突 (M02) */
  private workspaceQueues = new Map<number, Promise<any>>()

  constructor(deps: WorkspaceAdmissionDependencies = {}) {
    this.deps = deps
  }

  /**
   * 启动期注入运行时依赖（生产单例为无参构造，由 initialization 在数据库就绪后调用）。
   *
   * 历史实现在这里用 `require('../database/database-service')` 兜底，但 electron-vite 会把
   * 主进程源码整体打进 main.js，产物中并不存在该相对路径，require 必然 MODULE_NOT_FOUND；
   * 且 DatabaseService 暴露的是 `db` getter 而非 `getDb()`。空 catch 把两种真实异常统一
   * 伪装成「数据库未初始化且未提供 db 依赖」，使「更新工作区配置」恒定失败且无法排障。
   * 因此改由启动链路注入静态 import 的实例，彻底绕开打包后的模块解析问题。
   */
  configureRuntimeDependencies(deps: {
    getDb: () => Database | null
    systemRulesProvider: () => IFilterRule[]
  }): void {
    this.deps.getDb = deps.getDb
    this.deps.systemRulesProvider = deps.systemRulesProvider
  }

  private resolveDb(): Database {
    if (this.deps.db) return this.deps.db
    if (this.deps.getDb) {
      const db = this.deps.getDb()
      if (db) return db
      throw new Error(
        '[WorkspaceAdmissionService] 数据库尚未初始化 (databaseService.db 为 null)，请确认 databaseService.initialize() 已完成'
      )
    }
    throw new Error(
      '[WorkspaceAdmissionService] 未提供 db 依赖：构造时传入 { db }，或在启动期调用 configureRuntimeDependencies() 注入'
    )
  }

  private resolveSystemRules(): IFilterRule[] {
    if (this.deps.systemRulesProvider) {
      return this.deps.systemRulesProvider()
    }
    try {
      // 仅保留给单测 / 未打包环境；生产路径必须由 configureRuntimeDependencies 注入，
      // 因为打包产物里不存在该相对模块路径。
      const { loadIgnoreRules } = require('../analysis/analysis-exclusion-service')
      return loadIgnoreRules()
    } catch (error) {
      // 禁止静默降级：系统硬排除规则为空会让准入四阶判定的第一阶整段失效。
      logger.warn(
        LogCategory.MAIN,
        '[WorkspaceAdmissionService] 系统排除规则加载失败，请在启动期注入 systemRulesProvider:',
        error
      )
      return []
    }
  }

  /**
   * 串行包装执行器 (M02)
   */
  private async runSerialized<T>(workspaceId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.workspaceQueues.get(workspaceId) || Promise.resolve()
    const next = (async () => {
      try {
        await prev
      } catch {
        // 忽略前一个任务的异常，不阻断后续任务排队
      }
      return await fn()
    })()
    this.workspaceQueues.set(workspaceId, next)
    try {
      return await next
    } finally {
      if (this.workspaceQueues.get(workspaceId) === next) {
        this.workspaceQueues.delete(workspaceId)
      }
    }
  }

  /**
   * 从数据库或内置配置源加载工作流记录
   */
  private findWorkflowTemplate(
    db: Database,
    workflowId: string | null | undefined
  ): Partial<LocalWorkflowRecord> | null {
    if (!workflowId) return null
    try {
      const row = db.prepare('SELECT * FROM local_workflows WHERE id = ?').get(workflowId) as
        | Partial<LocalWorkflowRecord>
        | undefined
      if (row) return row
    } catch {
      // 表未就绪或查询异常时回退内置源
    }

    try {
      const builtins = LOCAL_WORKFLOW_CONFIG_SOURCE()
      const found = builtins.find(w => w.id === workflowId)
      if (found) {
        return found as unknown as Partial<LocalWorkflowRecord>
      }
    } catch {
      // 忽略内置源读取异常
    }
    return null
  }

  /**
   * 提取工作流模板中的预设 WorkspaceConfigReady
   */
  private extractWorkflowTemplateConfig(
    workflow: Partial<LocalWorkflowRecord> | null
  ): Partial<WorkspaceConfigReady> | null {
    if (!workflow) return null
    const result: Partial<WorkspaceConfigReady> = {}

    if (workflow.workspace_config) {
      try {
        const parsed =
          typeof workflow.workspace_config === 'string'
            ? JSON.parse(workflow.workspace_config)
            : workflow.workspace_config
        if (parsed && typeof parsed === 'object') {
          if (Array.isArray(parsed.customWhitelistRules)) {
            result.customWhitelistRules = normalizeRuleList(
              parsed.customWhitelistRules,
              'wf-whitelist'
            )
          }
          if (Array.isArray(parsed.customIgnoreRules)) {
            result.customIgnoreRules = normalizeRuleList(parsed.customIgnoreRules, 'wf-ignore')
          }
          if (parsed.baseAIConfig) {
            result.baseAIConfig = parsed.baseAIConfig
          }
          if (parsed.derivedSnapshot) {
            result.derivedSnapshot = parsed.derivedSnapshot
          }
          if (parsed.namingPattern) {
            result.namingPattern = parsed.namingPattern
          }
          if (parsed.namingTemplate) {
            result.namingTemplate = parsed.namingTemplate
          }
        }
      } catch {
        // 忽略损坏的模板 JSON
      }
    }

    // 向下兼容旧版 filter_rules + filter_mode
    if (workflow.filter_rules) {
      try {
        const rawRules =
          typeof workflow.filter_rules === 'string'
            ? JSON.parse(workflow.filter_rules)
            : workflow.filter_rules
        if (Array.isArray(rawRules)) {
          const normalized = normalizeRuleList(rawRules, 'wf-legacy')
          if (workflow.filter_mode === 'whitelist') {
            result.customWhitelistRules = [...(result.customWhitelistRules || []), ...normalized]
          } else {
            result.customIgnoreRules = [...(result.customIgnoreRules || []), ...normalized]
          }
        }
      } catch {}
    }

    if (workflow.naming_pattern && !result.namingPattern) {
      result.namingPattern = workflow.naming_pattern
    }
    if (workflow.naming_template && !result.namingTemplate) {
      result.namingTemplate = workflow.naming_template
    }

    return result
  }

  /**
   * 获取指定工作区编译后的不可变过滤策略快照
   */
  getEffectivePolicy(workspaceId: number): EffectiveFilterPolicy {
    const db = this.resolveDb()
    const row = db
      .prepare(
        'SELECT workspace_id, workspace_config, bound_workflow_id FROM workspaces WHERE workspace_id = ?'
      )
      .get(workspaceId) as
      | {
          workspace_id: number
          workspace_config: string | null
          bound_workflow_id: string | null
        }
      | undefined

    const parsedConfig = parseWorkspaceConfig(row?.workspace_config)
    const isReady = parsedConfig.status === 'ready'
    const policyVersion = isReady ? parsedConfig.policyVersion || 1 : 0
    const systemRules = this.resolveSystemRules()

    // 若工作区配置已就绪，workspaces.workspace_config 即为唯一权威事实源；
    // 仅当工作区尚未物化就绪且绑定了 workflow 时，才回退读取 workflow 模板规则
    const boundWorkflowId =
      row?.bound_workflow_id ?? (isReady ? (parsedConfig.workflowId ?? null) : null)
    const workflowForFallback =
      !isReady && boundWorkflowId ? this.findWorkflowTemplate(db, boundWorkflowId) : null

    return resolveEffectiveFilterPolicy({
      workspaceId,
      policyVersion,
      systemRules,
      workflow: workflowForFallback,
      customIgnoreRules: isReady ? parsedConfig.customIgnoreRules : [],
      customWhitelistRules: isReady ? parsedConfig.customWhitelistRules : []
    })
  }

  /**
   * 判定单个文件或目录是否允许准入（封装四阶短路与伴生文件同目录校验）
   */
  shouldAdmitFile(
    workspaceId: number,
    filePath: string,
    isDir: boolean,
    siblingEntries?: string[]
  ): boolean {
    const policy = this.getEffectivePolicy(workspaceId)
    if (isDir) {
      return shouldDescendDirectory(filePath, policy)
    }
    return shouldIngressFile(filePath, false, policy, siblingEntries)
  }

  /**
   * 根据当前工作区状态与变更请求，构造合并后的目标配置与绑定工作流
   */
  private computeMergedState(
    db: Database,
    workspaceId: number,
    mutation: WorkspacePolicyMutation
  ): {
    nextConfig: WorkspaceConfigReady
    nextBoundWorkflowId: string | null
    currentPolicyVersion: number
  } {
    const row = db
      .prepare(
        'SELECT workspace_id, workspace_config, bound_workflow_id FROM workspaces WHERE workspace_id = ?'
      )
      .get(workspaceId) as
      | {
          workspace_id: number
          workspace_config: string | null
          bound_workflow_id: string | null
        }
      | undefined

    if (!row) {
      throw new Error(`WORKSPACE_NOT_FOUND: ${workspaceId}`)
    }

    const currentConfig = parseWorkspaceConfig(row.workspace_config)
    const currentReady = currentConfig.status === 'ready' ? currentConfig : null
    const currentPolicyVersion = currentReady ? currentReady.policyVersion || 0 : 0

    let nextBoundWorkflowId: string | null =
      row.bound_workflow_id ?? currentReady?.workflowId ?? null
    let templateOverlay: Partial<WorkspaceConfigReady> | null = null

    if (mutation.restoreWorkflowDefault) {
      const targetWfId =
        mutation.workflowId !== undefined ? mutation.workflowId : nextBoundWorkflowId
      if (!targetWfId) {
        throw new Error('BOUND_WORKFLOW_NOT_FOUND')
      }
      const wfRecord = this.findWorkflowTemplate(db, targetWfId)
      if (!wfRecord) {
        throw new Error(`WORKFLOW_TEMPLATE_NOT_FOUND: ${targetWfId}`)
      }
      nextBoundWorkflowId = targetWfId
      templateOverlay = this.extractWorkflowTemplateConfig(wfRecord)
    } else if (mutation.workflowId !== undefined) {
      nextBoundWorkflowId = mutation.workflowId || null
      if (nextBoundWorkflowId) {
        const wfRecord = this.findWorkflowTemplate(db, nextBoundWorkflowId)
        if (wfRecord) {
          templateOverlay = this.extractWorkflowTemplateConfig(wfRecord)
        }
      }
    }

    // 1. 包含规则解包：includeExts/customWhitelistExts > includeRules/customWhitelistRules > 模板覆盖 > 既有
    const incomingExts = mutation.includeExts ?? mutation.customWhitelistExts
    const incomingIncludeRules = mutation.includeRules ?? mutation.customWhitelistRules
    let nextWhitelistRules: IFilterRule[]
    if (incomingExts !== undefined) {
      nextWhitelistRules = normalizeExtensionsToFilterRules(incomingExts)
    } else if (incomingIncludeRules !== undefined) {
      nextWhitelistRules = normalizeRuleList(incomingIncludeRules, 'whitelist')
    } else if (templateOverlay?.customWhitelistRules !== undefined) {
      nextWhitelistRules = templateOverlay.customWhitelistRules
    } else if (mutation.workflowId === null) {
      // 显式解绑工作流且未指定自定义包含规则时，保持既有规则
      nextWhitelistRules = currentReady?.customWhitelistRules || []
    } else {
      nextWhitelistRules = currentReady?.customWhitelistRules || []
    }

    // 2. 排除规则解包：excludeRules/customIgnoreRules > restoreWorkflowDefault 模板覆盖 > 既有配置合并模板
    const incomingExcludeRules = mutation.excludeRules ?? mutation.customIgnoreRules
    let nextIgnoreRules: IFilterRule[]
    if (incomingExcludeRules !== undefined) {
      nextIgnoreRules = normalizeRuleList(incomingExcludeRules, 'ignore')
    } else if (mutation.restoreWorkflowDefault) {
      nextIgnoreRules = templateOverlay?.customIgnoreRules || []
    } else if (templateOverlay?.customIgnoreRules && templateOverlay.customIgnoreRules.length > 0) {
      const existing = currentReady?.customIgnoreRules || []
      nextIgnoreRules = normalizeRuleList(
        [...existing, ...templateOverlay.customIgnoreRules],
        'ignore'
      )
    } else {
      nextIgnoreRules = currentReady?.customIgnoreRules || []
    }

    // 3. 计算 AI 分析基础参数
    const defaultBaseAi = mapIntentToParameters(
      mutation.intent || currentReady?.intent || 'fast_archive',
      mutation.overrides || currentReady?.overrides
    )
    const nextBaseAi: TechnicalEngineParameters =
      mutation.baseAIConfig ||
      (mutation.restoreWorkflowDefault ? templateOverlay?.baseAIConfig : undefined) ||
      templateOverlay?.baseAIConfig ||
      currentReady?.baseAIConfig ||
      defaultBaseAi

    const nextDerivedSnapshot: TechnicalEngineParameters =
      mutation.derivedSnapshot ||
      mutation.baseAIConfig ||
      (mutation.restoreWorkflowDefault ? templateOverlay?.derivedSnapshot : undefined) ||
      templateOverlay?.derivedSnapshot ||
      currentReady?.derivedSnapshot ||
      nextBaseAi

    const nextConfig: WorkspaceConfigReady = {
      schemaVersion: 1,
      status: 'ready',
      policyVersion: currentPolicyVersion, // 初始保持当前版本，若指纹改变由主写入口递增
      workflowId: nextBoundWorkflowId,
      intent: mutation.intent ?? currentReady?.intent,
      overrides: mutation.overrides ?? currentReady?.overrides,
      customIgnoreRules: nextIgnoreRules,
      customWhitelistRules: nextWhitelistRules,
      baseAIConfig: nextBaseAi,
      advancedAIPrompts: mutation.advancedAIPrompts ?? currentReady?.advancedAIPrompts,
      unitRecognition: mutation.unitRecognition ?? currentReady?.unitRecognition,
      namingPattern:
        mutation.namingPattern ?? templateOverlay?.namingPattern ?? currentReady?.namingPattern,
      namingTemplate:
        mutation.namingTemplate ?? templateOverlay?.namingTemplate ?? currentReady?.namingTemplate,
      derivedSnapshot: nextDerivedSnapshot,
      configuredAt: Date.now()
    }

    return {
      nextConfig,
      nextBoundWorkflowId,
      currentPolicyVersion
    }
  }

  /**
   * 纯内存构造同级目录文件名映射表（基于已查出的 workspace_files，零同步磁盘 fs.readdirSync [M06/ALT-4]）
   */
  private buildDirectorySiblingsMap(
    rows: Array<{ id: number; path: string; name: string }>
  ): Map<string, string[]> {
    const dirSets = new Map<string, Set<string>>()

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const filePath = row.path || row.name || ''
      const dir = path.dirname(filePath)
      const fileName = row.name || path.basename(filePath)
      let set = dirSets.get(dir)
      if (!set) {
        set = new Set<string>()
        dirSets.set(dir, set)
      }
      if (fileName) {
        set.add(fileName)
      }
    }

    const result = new Map<string, string[]>()
    for (const [dir, set] of dirSets.entries()) {
      result.set(dir, Array.from(set))
    }
    return result
  }

  /**
   * 预览策略变更对当前工作区或探测画像的影响（含伴生文件保护计数，零污染生产策略缓存 [M03]）
   */
  async previewPolicyImpact(
    workspaceId: number,
    mutation: WorkspacePolicyMutation,
    probeExtensionCounts?: Record<string, number>
  ): Promise<PolicyImpactPreview> {
    const db = this.resolveDb()
    const { nextConfig } = this.computeMergedState(db, workspaceId, mutation)
    const systemRules = this.resolveSystemRules()

    // 调用纯函数 compileFilterPolicy 编译候选策略，彻底杜绝污染生产 policyCache
    const candidatePolicy = compileFilterPolicy({
      workspaceId,
      policyVersion: -1,
      systemRules,
      workflow: null,
      customIgnoreRules: nextConfig.customIgnoreRules,
      customWhitelistRules: nextConfig.customWhitelistRules
    })

    // 模式 A：基于冷启动探测画像 (probeExtensionCounts) 估算影响
    if (probeExtensionCounts && Object.keys(probeExtensionCounts).length > 0) {
      let totalFiles = 0
      let includedFiles = 0
      let companionFilesProtected = 0

      // 先判定画像中是否存在任何可通过准入的非伴生主文件格式
      let hasAdmittedPrimaryInProbe = false
      for (const [rawExt, count] of Object.entries(probeExtensionCounts)) {
        if (!count || count <= 0) continue
        if (rawExt === 'no_ext') continue
        const ext = rawExt.startsWith('.') ? rawExt.toLowerCase() : `.${rawExt.toLowerCase()}`
        if (candidatePolicy.companionExtensions.has(ext)) continue
        const virtualName = `probe_sample${ext}`
        if (shouldIngressFile(virtualName, false, candidatePolicy, [virtualName])) {
          hasAdmittedPrimaryInProbe = true
          break
        }
      }

      for (const [rawExt, count] of Object.entries(probeExtensionCounts)) {
        if (!count || count <= 0) continue
        totalFiles += count
        const ext =
          rawExt === 'no_ext'
            ? ''
            : rawExt.startsWith('.')
              ? rawExt.toLowerCase()
              : `.${rawExt.toLowerCase()}`
        const virtualName = ext ? `probe_sample${ext}` : 'probe_sample'

        // 1. 黑名单拦截检查
        if (
          (candidatePolicy.systemDenyRules.length > 0 &&
            shouldIgnoreFileByRules(virtualName, virtualName, candidatePolicy.systemDenyRules)) ||
          (candidatePolicy.userDenyRules.length > 0 &&
            shouldIgnoreFileByRules(virtualName, virtualName, candidatePolicy.userDenyRules))
        ) {
          continue
        }

        // 2. 包含模式检查
        if (candidatePolicy.whitelistRules.length > 0) {
          if (shouldIgnoreFileByRules(virtualName, virtualName, candidatePolicy.whitelistRules)) {
            includedFiles += count
          } else if (
            ext &&
            candidatePolicy.companionExtensions.has(ext) &&
            hasAdmittedPrimaryInProbe
          ) {
            includedFiles += count
            companionFilesProtected += count
          }
        } else {
          // 3. 默认放行模式
          includedFiles += count
        }
      }

      return {
        totalFiles,
        includedFiles,
        excludedFiles: Math.max(0, totalFiles - includedFiles),
        companionFilesProtected
      }
    }

    // 模式 B：基于已入库 workspace_files 精确计算影响（纯内存伴生文件保护判定）
    const rows = db
      .prepare('SELECT id, path, name FROM workspace_files WHERE workspace_id = ?')
      .all(workspaceId) as Array<{ id: number; path: string; name: string }>

    const totalFiles = rows.length
    if (totalFiles === 0) {
      return {
        totalFiles: 0,
        includedFiles: 0,
        excludedFiles: 0,
        companionFilesProtected: 0
      }
    }

    const dirSiblingsMap = this.buildDirectorySiblingsMap(rows)
    let includedFiles = 0
    let companionFilesProtected = 0

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      const filePath = row.path || row.name || ''
      const fileName = row.name || path.basename(filePath)
      const dir = path.dirname(filePath)
      const siblings = dirSiblingsMap.get(dir) || [fileName]

      if (shouldIngressFile(filePath, false, candidatePolicy, siblings)) {
        includedFiles++
        if (
          candidatePolicy.whitelistRules.length > 0 &&
          !shouldIgnoreFileByRules(filePath, fileName, candidatePolicy.whitelistRules)
        ) {
          companionFilesProtected++
        }
      }
    }

    return {
      totalFiles,
      includedFiles,
      excludedFiles: totalFiles - includedFiles,
      companionFilesProtected
    }
  }

  /**
   * 原子应用策略变更（唯一写入口，按 workspaceId 串行执行 [M01/M02/M03/M04/M05/M07/Y-01/Y-02/Y-07]）
   */
  async applyPolicyMutation(
    workspaceId: number,
    mutation: WorkspacePolicyMutation
  ): Promise<AdmissionReconcileResult> {
    return this.runSerialized(workspaceId, async () => {
      const db = this.resolveDb()

      // 读取当前工作区物理元数据与配置
      const row = db
        .prepare(
          'SELECT workspace_id, workspace_config, bound_workflow_id, meta FROM workspaces WHERE workspace_id = ?'
        )
        .get(workspaceId) as
        | {
            workspace_id: number
            workspace_config: string | null
            bound_workflow_id: string | null
            meta: string | null
          }
        | undefined

      if (!row) {
        throw new Error(`WORKSPACE_NOT_FOUND: ${workspaceId}`)
      }

      let parsedMeta: Record<string, any> = {}
      try {
        parsedMeta = JSON.parse(row.meta || '{}')
      } catch {
        parsedMeta = {}
      }

      const admittedPolicyHash =
        typeof parsedMeta.admittedPolicyHash === 'string' ? parsedMeta.admittedPolicyHash : null

      const { nextConfig, nextBoundWorkflowId, currentPolicyVersion } = this.computeMergedState(
        db,
        workspaceId,
        mutation
      )

      if (!isWorkspaceConfigReady(nextConfig)) {
        throw new Error(
          '[WorkspaceAdmissionService] 拒绝写入非法 ready 配置: 缺少必要基础 AI 配置或过滤规则数组'
        )
      }

      const systemRules = this.resolveSystemRules()

      // 编译当前已有有效策略并计算指纹
      const currentConfig = parseWorkspaceConfig(row.workspace_config)
      const isReady = currentConfig.status === 'ready'
      const currentEffectivePolicy = compileFilterPolicy({
        workspaceId,
        policyVersion: currentPolicyVersion,
        systemRules,
        workflow:
          !isReady && row.bound_workflow_id
            ? this.findWorkflowTemplate(db, row.bound_workflow_id)
            : null,
        customIgnoreRules: isReady ? currentConfig.customIgnoreRules : [],
        customWhitelistRules: isReady ? currentConfig.customWhitelistRules : []
      })
      const currentFingerprint = computeAdmissionFingerprint(currentEffectivePolicy)

      // 编译候选策略并计算新指纹
      const candidatePolicy = compileFilterPolicy({
        workspaceId,
        policyVersion: currentPolicyVersion + 1,
        systemRules,
        workflow: null,
        customIgnoreRules: nextConfig.customIgnoreRules,
        customWhitelistRules: nextConfig.customWhitelistRules
      })
      const candidateFingerprint = computeAdmissionFingerprint(candidatePolicy)

      // 判定准入指纹是否发生变化
      const isFingerprintIdentical = candidateFingerprint === currentFingerprint
      const isReconciled = admittedPolicyHash === candidateFingerprint

      // 短路分支：若准入指纹未变且历史对账一致，仅保存非准入配置，版本不递增，零 I/O (M01)
      if (isFingerprintIdentical && isReconciled) {
        nextConfig.policyVersion = currentPolicyVersion
        const serializedConfig = serializeWorkspaceConfig(nextConfig)
        db.transaction(() => {
          db.prepare(
            'UPDATE workspaces SET workspace_config = ?, bound_workflow_id = ? WHERE workspace_id = ?'
          ).run(serializedConfig, nextBoundWorkflowId, workspaceId)
        })()

        return {
          policyVersion: currentPolicyVersion,
          admissionChanged: false,
          needsRescan: false,
          prunedFilesCount: 0,
          cancelledTasksCount: 0
        }
      }

      // 指纹发生变化或历史对账未完成：递增版本号并启动两阶段执行
      const nextPolicyVersion = currentPolicyVersion + 1
      nextConfig.policyVersion = nextPolicyVersion
      const serializedConfig = serializeWorkspaceConfig(nextConfig)

      // 阶段 1：微事务原子持久化配置（先不回写 admittedPolicyHash，保持后置回写）
      db.transaction(() => {
        db.prepare(
          'UPDATE workspaces SET workspace_config = ?, bound_workflow_id = ? WHERE workspace_id = ?'
        ).run(serializedConfig, nextBoundWorkflowId, workspaceId)

        try {
          db.prepare(
            'UPDATE workspace_directories SET bound_workflow_id = ? WHERE workspace_id = ?'
          ).run(nextBoundWorkflowId, workspaceId)
        } catch {
          // 忽略子目录表同步异常
        }
      })()

      // 作废旧缓存并编译新策略
      invalidateWorkspacePolicyCache(workspaceId)
      const newPolicy = this.getEffectivePolicy(workspaceId)

      // 驱动队列管理器取消失配任务（内存队列 + DB 队列）
      let cancelledFromQueueManager = 0
      if (this.deps.queueCancelUnmatched) {
        const res = await this.deps.queueCancelUnmatched(workspaceId, newPolicy)
        cancelledFromQueueManager = res?.cancelledCount || 0
      } else {
        try {
          const { analysisQueueService } = await import('../analysis-queue-service')
          const res = await analysisQueueService.cancelUnmatchedTasks(workspaceId, newPolicy as any)
          cancelledFromQueueManager = res?.cancelledCount || 0
        } catch {
          // 测试环境或服务未初始化时安全降级
        }
      }

      // 阶段 2：伴生文件感知索引解绑（IN-02 铁律：纯内存构建 Set<lowerStem>，零 fs.readdirSync，零删物理文件）
      const rows = db
        .prepare('SELECT id, path, name FROM workspace_files WHERE workspace_id = ?')
        .all(workspaceId) as Array<{ id: number; path: string; name: string }>

      const prunedFileIds: number[] = []
      if (rows.length > 0) {
        const dirSiblingsMap = this.buildDirectorySiblingsMap(rows)
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]
          const filePath = row.path || row.name || ''
          const fileName = row.name || path.basename(filePath)
          const dir = path.dirname(filePath)
          const siblings = dirSiblingsMap.get(dir) || [fileName]

          if (!shouldIngressFile(filePath, false, newPolicy, siblings)) {
            prunedFileIds.push(row.id)
          }
        }
      }

      let dbQueueCancelledCount = 0
      if (prunedFileIds.length > 0) {
        const batchSize = 1000
        for (let i = 0; i < prunedFileIds.length; i += batchSize) {
          const batch = prunedFileIds.slice(i, i + batchSize)
          const placeholders = batch.map(() => '?').join(',')

          db.transaction(() => {
            // 清理待处理分析队列记录
            const queueDelRes = db
              .prepare(
                `DELETE FROM analysis_queue WHERE item_type = 'file' AND item_id IN (${placeholders})`
              )
              .run(...batch)
            dbQueueCancelledCount += queueDelRes.changes

            // 仅从 workspace_files 索引表解绑记录（IN-02：严禁触碰物理文件与全局 files 缓存）
            db.prepare(`DELETE FROM workspace_files WHERE id IN (${placeholders})`).run(...batch)
          })()

          // 批次间出让事件循环，防止阻塞渲染进程通信 (Y-02)
          if (i + batchSize < prunedFileIds.length) {
            await new Promise(r => setImmediate(r))
          }
        }

        logger.info(
          LogCategory.DATABASE_SERVICE,
          `[WorkspaceAdmissionService] 策略更新完成索引解绑 (workspaceId=${workspaceId}, policyVersion=${nextPolicyVersion}, pruned=${prunedFileIds.length})`
        )
      }

      // 判定是否放宽策略需要补扫 (M04)
      const needsRescan = isPolicyRelaxed(currentEffectivePolicy, newPolicy)

      // 通知文件监听服务刷新策略并按需触发增量补扫
      if (needsRescan) {
        if (this.deps.onPolicyApplied) {
          await this.deps.onPolicyApplied(workspaceId, newPolicy)
        } else {
          try {
            const { fileWatcherService } = await import('../filesystem/file-watcher-service')
            await fileWatcherService.onWorkspacePolicyUpdated(workspaceId, newPolicy)
          } catch {
            // 监听服务未启动或处于纯单测环境时忽略
          }
        }
      }

      // 后置回写：仅当解绑、裁剪、重扫通知全部成功后，才回写 admittedPolicyHash (Y-07)
      try {
        const nextMeta = { ...parsedMeta, admittedPolicyHash: candidateFingerprint }
        db.prepare('UPDATE workspaces SET meta = ? WHERE workspace_id = ?').run(
          JSON.stringify(nextMeta),
          workspaceId
        )
      } catch (err) {
        logger.warn(
          LogCategory.DATABASE_SERVICE,
          `[WorkspaceAdmissionService] 回写 admittedPolicyHash 失败: ${String(err)}`
        )
      }

      return {
        policyVersion: nextPolicyVersion,
        admissionChanged: true,
        needsRescan,
        prunedFilesCount: prunedFileIds.length,
        cancelledTasksCount: cancelledFromQueueManager + dbQueueCancelledCount
      }
    })
  }

  /**
   * 启动期电平触发自愈对账 (ALT-1 / Y-02 / Y-07)
   * 遍历所有已就绪工作区，比对编译指纹与 meta.admittedPolicyHash。
   * 若不一致，按批次 500 行出让事件循环执行幂等修剪，全部成功后回写 admittedPolicyHash。
   */
  async reconcileAllWorkspacesOnStartup(): Promise<number> {
    const db = this.resolveDb()
    let rows: Array<{
      workspace_id: number
      workspace_config: string | null
      meta: string | null
    }> = []
    try {
      rows = db.prepare('SELECT workspace_id, workspace_config, meta FROM workspaces').all() as any
    } catch {
      return 0
    }

    let reconciledCount = 0

    for (let w = 0; w < rows.length; w++) {
      const row = rows[w]
      const workspaceId = row.workspace_id
      const config = parseWorkspaceConfig(row.workspace_config)
      if (config.status !== 'ready') continue

      let meta: Record<string, any> = {}
      try {
        meta = JSON.parse(row.meta || '{}')
      } catch {
        meta = {}
      }

      const policy = this.getEffectivePolicy(workspaceId)
      const currentFingerprint = computeAdmissionFingerprint(policy)

      if (meta.admittedPolicyHash === currentFingerprint) {
        continue
      }

      // 指纹失配，启动修剪自愈
      logger.info(
        LogCategory.DATABASE_SERVICE,
        `[WorkspaceAdmissionService] 工作区 ${workspaceId} 启动指纹失配，执行自愈对账...`
      )

      const fileRows = db
        .prepare('SELECT id, path, name FROM workspace_files WHERE workspace_id = ?')
        .all(workspaceId) as Array<{ id: number; path: string; name: string }>

      const prunedIds: number[] = []
      if (fileRows.length > 0) {
        const dirSiblingsMap = this.buildDirectorySiblingsMap(fileRows)
        for (let i = 0; i < fileRows.length; i++) {
          const f = fileRows[i]
          const filePath = f.path || f.name || ''
          const fileName = f.name || path.basename(filePath)
          const dir = path.dirname(filePath)
          const siblings = dirSiblingsMap.get(dir) || [fileName]

          if (!shouldIngressFile(filePath, false, policy, siblings)) {
            prunedIds.push(f.id)
          }
        }
      }

      if (prunedIds.length > 0) {
        const batchSize = 500
        for (let i = 0; i < prunedIds.length; i += batchSize) {
          const batch = prunedIds.slice(i, i + batchSize)
          const placeholders = batch.map(() => '?').join(',')
          db.transaction(() => {
            db.prepare(
              `DELETE FROM analysis_queue WHERE item_type = 'file' AND item_id IN (${placeholders})`
            ).run(...batch)
            db.prepare(`DELETE FROM workspace_files WHERE id IN (${placeholders})`).run(...batch)
          })()
          await new Promise(r => setImmediate(r))
        }
      }

      // 修剪完成，回写 admittedPolicyHash
      meta.admittedPolicyHash = currentFingerprint
      db.prepare('UPDATE workspaces SET meta = ? WHERE workspace_id = ?').run(
        JSON.stringify(meta),
        workspaceId
      )

      reconciledCount++
      await new Promise(r => setImmediate(r))
    }

    return reconciledCount
  }
}

export const workspaceAdmissionService = new WorkspaceAdmissionService()
