/**
 * 工作区文件准入与过滤策略深模块 (WorkspaceAdmissionService)
 *
 * 职责边界：
 * 1. 单一配置源：所有白名单与忽略规则统一持久化在 `workspaces.workspace_config` JSON 与 `bound_workflow_id` 中，
 *    无 `whitelist_patterns` 物理数据库列。
 * 2. 四阶短路决策：系统硬黑名单 > 工作区黑名单 (`customIgnoreRules`) > 工作区白名单 (`customWhitelistRules` + 8 种伴生文件) > 默认放行。
 * 3. 版本单调递增与缓存一致性：唯一写入口 `applyPolicyMutation` 强制递增 `policyVersion = (current.policyVersion || 0) + 1`，
 *    并调用 `invalidateWorkspacePolicyCache(workspaceId)` 精确失效旧缓存。
 * 4. 索引解绑绝不删物理文件 (IN-02 铁律)：策略收紧后仅从 `workspace_files` 与 `analysis_queue` 移除失配索引及待处理任务，
 *    绝对禁止调用 `fs.unlink` / `fs.rm` 删除用户磁盘上的物理文件。
 */

import type { Database } from 'better-sqlite3'
import fs from 'node:fs'
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
  invalidateWorkspacePolicyCache,
  LogCategory,
  logger,
  mapIntentToParameters,
  resolveEffectiveFilterPolicy,
  shouldDescendDirectory,
  shouldIgnoreFileByRules,
  shouldIngressFile,
  type EffectiveFilterPolicy
} from '@firefly/shared'
import { LOCAL_WORKFLOW_CONFIG_SOURCE } from '../../config/local-workflow-source'

export interface WorkspacePolicyMutation {
  workflowId?: string | null
  restoreWorkflowDefault?: boolean
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
  prunedFilesCount: number
  cancelledTasksCount: number
}

export interface IWorkspaceAdmissionService {
  /** 获取编译后的不可变策略快照（内部管理 `${workspaceId}:${policyVersion}` 缓存） */
  getEffectivePolicy(workspaceId: number): EffectiveFilterPolicy

  /** 判定单个文件或目录是否允许准入（封装四阶短路与伴生文件同目录校验） */
  shouldAdmitFile(
    workspaceId: number,
    filePath: string,
    isDir: boolean,
    siblingEntries?: string[]
  ): boolean

  /** 预览策略变更对当前工作区或探测画像的影响（含伴生文件保护计数） */
  previewPolicyImpact(
    workspaceId: number,
    mutation: WorkspacePolicyMutation,
    probeExtensionCounts?: Record<string, number>
  ): Promise<PolicyImpactPreview>

  /**
   * 原子应用策略变更（唯一写入口）：
   * 1. 强制递增 `policyVersion = (current.policyVersion || 0) + 1`；
   * 2. 合并或重置 `bound_workflow_id` 与 `workspace_config` 并持久化至 `workspaces` 表；
   * 3. 精确调用 `invalidateWorkspacePolicyCache(workspaceId)`；
   * 4. 执行伴生文件感知的 `workspace_files` 索引解绑（IN-02：仅从索引表移除记录，严禁删除物理磁盘文件）；
   * 5. 驱动 `queueManager.cancelUnmatchedTasks`（基于完整 `EffectiveFilterPolicy` 取消失配待处理任务）与 `fileWatcherService` 增量重扫。
   */
  applyPolicyMutation(
    workspaceId: number,
    mutation: WorkspacePolicyMutation
  ): Promise<AdmissionReconcileResult>
}

export interface WorkspaceAdmissionDependencies {
  db?: Database
  getDb?: () => Database
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

  constructor(deps: WorkspaceAdmissionDependencies = {}) {
    this.deps = deps
  }

  private resolveDb(): Database {
    if (this.deps.db) return this.deps.db
    if (this.deps.getDb) return this.deps.getDb()
    try {
      const { databaseService } = require('../database/database-service')
      return databaseService.getDb()
    } catch {
      throw new Error('[WorkspaceAdmissionService] 数据库未初始化且未提供 db 依赖')
    }
  }

  private resolveSystemRules(): IFilterRule[] {
    if (this.deps.systemRulesProvider) {
      return this.deps.systemRulesProvider()
    }
    try {
      const { loadIgnoreRules } = require('../analysis/analysis-ignore-service')
      return loadIgnoreRules()
    } catch {
      return []
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
    nextPolicyVersion: number
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
    const nextPolicyVersion = currentPolicyVersion + 1

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

    // 1. 计算白名单规则：显式 customWhitelistExts > 显式 customWhitelistRules > 工作流模板覆盖 > 既有配置
    let nextWhitelistRules: IFilterRule[]
    if (mutation.customWhitelistExts !== undefined) {
      nextWhitelistRules = normalizeExtensionsToFilterRules(mutation.customWhitelistExts)
    } else if (mutation.customWhitelistRules !== undefined) {
      nextWhitelistRules = normalizeRuleList(mutation.customWhitelistRules, 'whitelist')
    } else if (templateOverlay?.customWhitelistRules !== undefined) {
      nextWhitelistRules = templateOverlay.customWhitelistRules
    } else if (mutation.workflowId === null) {
      // 显式解绑工作流且未指定自定义白名单时，保持既有白名单或默认空列表
      nextWhitelistRules = currentReady?.customWhitelistRules || []
    } else {
      nextWhitelistRules = currentReady?.customWhitelistRules || []
    }

    // 2. 计算黑名单规则：显式 customIgnoreRules > restoreWorkflowDefault 模板覆盖 > 既有配置合并模板
    let nextIgnoreRules: IFilterRule[]
    if (mutation.customIgnoreRules !== undefined) {
      nextIgnoreRules = normalizeRuleList(mutation.customIgnoreRules, 'ignore')
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
      policyVersion: nextPolicyVersion,
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
      nextPolicyVersion
    }
  }

  /**
   * 构造同级目录文件名映射表（合并 workspace_files 已入库同目录文件名与物理目录文件名，保证伴生文件精确判定）
   */
  private buildDirectorySiblingsMap(
    rows: Array<{ id: number; path: string; name: string }>
  ): Map<string, string[]> {
    const dirSets = new Map<string, Set<string>>()

    for (const row of rows) {
      const filePath = row.path || row.name || ''
      const dir = path.dirname(filePath)
      const fileName = row.name || path.basename(filePath)
      let set = dirSets.get(dir)
      if (!set) {
        set = new Set<string>()
        // 若磁盘目录存在，合入磁盘同级文件名，防止主文件尚未入库时误杀伴生文件
        if (dir && dir !== '.' && fs.existsSync(dir)) {
          try {
            for (const entry of fs.readdirSync(dir)) {
              set.add(entry)
            }
          } catch {
            // 忽略读取权限或瞬态目录异常
          }
        }
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
   * 预览策略变更对当前工作区或探测画像的影响（含伴生文件保护计数）
   */
  async previewPolicyImpact(
    workspaceId: number,
    mutation: WorkspacePolicyMutation,
    probeExtensionCounts?: Record<string, number>
  ): Promise<PolicyImpactPreview> {
    const db = this.resolveDb()
    const { nextConfig } = this.computeMergedState(db, workspaceId, mutation)
    const systemRules = this.resolveSystemRules()

    // 使用负版本号或独立解析并在解析后清理该临时缓存键，避免污染正式版本缓存
    const previewVersion = -Date.now()
    const candidatePolicy = resolveEffectiveFilterPolicy({
      workspaceId,
      policyVersion: previewVersion,
      systemRules,
      workflow: null,
      customIgnoreRules: nextConfig.customIgnoreRules,
      customWhitelistRules: nextConfig.customWhitelistRules
    })
    invalidateWorkspacePolicyCache(workspaceId)

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

        // 2. 白名单模式检查
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

    // 模式 B：基于已入库 workspace_files 精确计算影响（含同目录伴生文件保护判定）
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

    for (const row of rows) {
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
   * 原子应用策略变更（唯一写入口）
   */
  async applyPolicyMutation(
    workspaceId: number,
    mutation: WorkspacePolicyMutation
  ): Promise<AdmissionReconcileResult> {
    const db = this.resolveDb()
    const { nextConfig, nextBoundWorkflowId, nextPolicyVersion } = this.computeMergedState(
      db,
      workspaceId,
      mutation
    )

    if (!isWorkspaceConfigReady(nextConfig)) {
      throw new Error(
        '[WorkspaceAdmissionService] 拒绝写入非法 ready 配置: 缺少必要基础 AI 配置或过滤规则数组'
      )
    }

    const serializedConfig = serializeWorkspaceConfig(nextConfig)

    // 1. 事务持久化 workspaces.workspace_config 与 bound_workflow_id
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

    // 2. 精确失效旧版策略缓存并编译最新不可变策略快照
    invalidateWorkspacePolicyCache(workspaceId)
    const newPolicy = this.getEffectivePolicy(workspaceId)

    // 3. 驱动队列管理器取消不匹配的新增黑名单或白名单任务（内存队列 + DB 队列）
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
        // 测试环境或服务未初始化时安全降级，由下方 SQL 事务兜底清理 analysis_queue
      }
    }

    // 4. 伴生文件感知的 workspace_files 索引解绑（IN-02 铁律：仅解绑数据库索引，严禁删除磁盘物理文件）
    const rows = db
      .prepare('SELECT id, path, name FROM workspace_files WHERE workspace_id = ?')
      .all(workspaceId) as Array<{ id: number; path: string; name: string }>

    const prunedFileIds: number[] = []
    if (rows.length > 0) {
      const dirSiblingsMap = this.buildDirectorySiblingsMap(rows)
      for (const row of rows) {
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
      db.transaction(() => {
        const batchSize = 500
        for (let i = 0; i < prunedFileIds.length; i += batchSize) {
          const batch = prunedFileIds.slice(i, i + batchSize)
          const placeholders = batch.map(() => '?').join(',')

          // 清理待处理分析队列记录（pending / analyzing）
          const queueDelRes = db
            .prepare(
              `DELETE FROM analysis_queue WHERE item_type = 'file' AND item_id IN (${placeholders})`
            )
            .run(...batch)
          dbQueueCancelledCount += queueDelRes.changes

          // 仅从 workspace_files 索引表解绑记录（IN-02：严禁触碰磁盘物理文件与全局 files 指纹缓存）
          db.prepare(`DELETE FROM workspace_files WHERE id IN (${placeholders})`).run(...batch)
        }
      })()

      logger.info(
        LogCategory.DATABASE_SERVICE,
        `[WorkspaceAdmissionService] 策略更新完成索引解绑 (workspaceId=${workspaceId}, policyVersion=${nextPolicyVersion}, pruned=${prunedFileIds.length})`
      )
    }

    // 5. 通知文件监听服务刷新工作区策略并按需触发增量同步
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

    return {
      policyVersion: nextPolicyVersion,
      prunedFilesCount: prunedFileIds.length,
      cancelledTasksCount: cancelledFromQueueManager + dbQueueCancelledCount
    }
  }
}

export const workspaceAdmissionService = new WorkspaceAdmissionService()
