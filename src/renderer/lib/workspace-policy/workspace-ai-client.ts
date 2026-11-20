/**
 * 渲染进程「工作区 AI 策略」隔离客户端 (Group D / SLICE-08)
 *
 * 背景：本模块在 Group A（共享仲裁内核 resolveEffectiveAIConfig）与
 * Group B（Preload 顶层平铺 applyWorkspacePolicyMutation）合流前，为渲染层
 * 提供 100% 对齐 L3 规格书 §2.3 / §5 冻结签名的本地类型与补丁通道封装，
 * 供 8 个前端写端与三态 UI 在独立 Worktree 内做渲染单测隔离校验。
 *
 * 【并行接缝契约】：
 * - 通道名 / 类型名 / 字段结构 100% 冻结对齐 L3 规格书，待上游合流后，
 *   仅需把本文件内的本地类型定义替换为 @firefly/shared 与 @firefly/types 的
 *   权威导出，调用点零改动。
 * - 严禁在本模块伪造「假成功」兜底：当真实 IPC 通道未就绪时，必须显式上报
 *   而非静默返回成功（符合 AGENTS.md「禁止静默降级」红线）。
 */
import type { TechnicalEngineParameters } from '@firefly/types'

/**
 * renderer 侧 window.electronAPI 新通道访问器（并行接缝隔离）
 *
 * Group B 在 preload 顶层平铺暴露 applyWorkspacePolicyMutation /
 * getWorkspaceRuntimeContextSnapshot / onWorkspaceRuntimeContextUpdated。
 * 为避免越界修改共享契约文件（src/shared/types/electron-api.d.ts）以及与
 * global.d.ts 的既有 electronAPI 声明冲突，此处不 declare global，
 * 而是通过局部类型交叉断言读取三个新通道（合流前可能未定义，运行时 typeof 判定）。
 */
type WorkspacePolicyApiWindow = Window & {
  electronAPI?: {
    applyWorkspacePolicyMutation?: (
      workspaceId: number,
      mutation: WorkspacePolicyMutation
    ) => Promise<WorkspacePolicyMutationResult>
    getWorkspaceRuntimeContextSnapshot?: () => Promise<WorkspaceRuntimeContextSnapshot | null>
    onWorkspaceRuntimeContextUpdated?: (
      callback: (snapshot: WorkspaceRuntimeContextSnapshot) => void
    ) => () => void
    triggerWorkspaceIncrementalRecovery?: (
      workspaceId: number
    ) => Promise<{ success: boolean; queued?: number; error?: string }>
  }
}

function getPolicyApiWindow(): WorkspacePolicyApiWindow | undefined {
  if (typeof window === 'undefined') return undefined
  return window as WorkspacePolicyApiWindow
}

/** 配置来源轴 (origin)：声明该字段值来自哪里 */
export type ConfigOriginSource = 'workflow_default' | 'system_default' | 'user_custom'

/**
 * 适用性轴 (applicability)：该字段当前的真实生效状态
 * - active: 正常生效
 * - degraded: 环境受限自动降级（计入降级计数）
 * - cascaded_off: 被父级开关级联关闭（温和灰显，不计降级）
 * - frozen_by_engine: 被当前引擎档位冻结（不可见/不可调）
 * - pending: 组件下载中
 * - unavailable_soon: 即将上线（预告区，不计降级）
 */
export type ConfigApplicability =
  | 'active'
  | 'degraded'
  | 'cascaded_off'
  | 'frozen_by_engine'
  | 'pending'
  | 'unavailable_soon'

/** 环境降级根因码（严格剔除 workspace_plugin_disabled，由目录级开关承载） */
export type DegradationReasonCode =
  | 'generative_ai_disabled'
  | 'gemma_unified_not_active'
  | 'global_plugin_not_installed'
  | 'global_plugin_inactive'
  | 'global_plugin_error'
  | 'libreoffice_missing'
  | 'cpu_hardware_clamp'
  | 'free_tier_video_limit'
  | 'ocr_disabled_cascade'

/** 非降级态的非激活原因码 */
export type InactiveReasonCode =
  | 'parent_plugin_unavailable'
  | 'parent_plugin_off_by_user'
  | 'ocr_disabled_cascade'
  | 'gemma_engine_required'
  | 'classic_engine_only'
  | 'plugin_downloading'
  | 'plugin_coming_soon'

/** 一键修复动作类型（驱动 DegradationCallout 按钮） */
export type DegradationFixAction =
  | 'open_generative_engine'
  | 'switch_to_gemma_unified'
  | 'install_global_plugin'
  | 'enable_global_plugin'
  | 'fix_global_plugin'
  | 'install_libreoffice'
  | 'open_pro_upgrade'
  | 're_enable_parent_plugin'
  | 'none'

/** 单个 AI 参数的三态仲裁结果 */
export interface ResolvedTriStateField<T = unknown> {
  /** 最终生效值（纯运行态） */
  effectiveValue: T
  /** 用户/工作流声明的期望值 */
  desiredValue: T
  /** 来源轴 */
  origin: ConfigOriginSource
  /** 适用性轴 */
  applicability: ConfigApplicability
  /** 是否对用户可见（frozen_by_engine 项 visible=false 不渲染） */
  visible: boolean
  /** 是否计入用户自定义计数 */
  isUserCustom: boolean
  /** 降级根因（applicability === 'degraded' 时存在） */
  degradationReason?: DegradationReasonCode
  /** 一键修复动作 */
  fixAction?: DegradationFixAction
  /** 关联父插件 ID（用于根因去重计数） */
  relatedPluginId?: string
  /** 非激活原因（cascaded_off / pending / unavailable_soon 时存在） */
  inactiveReason?: InactiveReasonCode
}

/** 目录级插件三态仲裁结果 */
export interface ResolvedPluginTriState {
  pluginId: string
  /** 目录级有效开关值 */
  effectiveValue: boolean
  /** 来源轴 */
  origin: ConfigOriginSource
  /** 适用性轴 */
  applicability: ConfigApplicability
  /** 插件目录可用性（来自 BUILTIN_MODULE_CATALOG_META.availability） */
  availability: 'approved' | 'coming_soon' | 'draft' | 'delisted'
  /** 工作流推荐标识：本主题推荐开启 / 本主题默认关闭 / 默认关闭 */
  workflowRecommendation: 'workflow_recommended_on' | 'workflow_default_off' | 'system_default_off'
  /** 关联的能力槽（如 voice_asr / perception_nsfw） */
  capabilitySlot?: string
  /** 降级根因（installed_inactive / error / not_installed 时） */
  degradationReason?: DegradationReasonCode
  /** 非激活原因 */
  inactiveReason?: InactiveReasonCode
}

/**
 * 仲裁结果汇总结构（EffectiveWorkspaceAIConfigResult）
 * 严格满足三桶计数恒等式：totalVisibleCount === defaultCount + userCustomCount + degradedFieldCount
 */
export interface EffectiveWorkspaceAIConfigResult {
  /** 纯运行态生效参数 */
  effectiveParams: TechnicalEngineParameters
  /** 14 个 AI 参数各自的三态字段 */
  fields: Record<string, ResolvedTriStateField>
  /** 6 个目录级插件各自状态 */
  plugins: Record<string, ResolvedPluginTriState>
  /** 8 个执行门面布尔/数值 */
  capabilities: Record<string, boolean | number>
  /** 能力级区块提示条 */
  sectionNotices: Array<{ id: string; message: string; severity: 'info' | 'warning' | 'degraded' }>
  /** 汇总统计 */
  summary: {
    defaultOrigin: ConfigOriginSource
    defaultCount: number
    userCustomCount: number
    degradedFieldCount: number
    /** 按根因去重后的降级计数 */
    degradedCount: number
    totalVisibleCount: number
    boundWorkflowId: string | null
  }
}

/**
 * 工作区策略补丁 Mutation（L3 §2.2.3 冻结契约）
 * 全仓 8 个前端写端统一提交该结构，禁止整份拼装 WorkspaceConfigReady 直写。
 */
export interface WorkspacePolicyMutation {
  /** AI 参数增量补丁：用户手动触碰即写入（哪怕等于默认，保留 user_custom） */
  overridePatch?: Partial<TechnicalEngineParameters>
  /** 恢复默认：精确 delete 覆盖字典中对应键（严禁传 null/undefined） */
  restoreOverrideFields?: Array<keyof TechnicalEngineParameters>
  /** 目录插件开关增量补丁 */
  pluginOverridePatch?: Record<string, boolean>
  /** 恢复默认：精确 delete 插件覆盖对应 id */
  restorePluginOverrideIds?: string[]
  /** AI 意图（仅向导/主面板在未绑定工作流时提交） */
  intent?: string
  /** 白名单扩展名全量替换（传空数组表示清空，恢复标准全量入场） */
  includeExts?: string[]
  /** 工作流绑定变更（切换/解绑），支持 preserveOverrides 保留覆盖 */
  workflowId?: string | null
  preserveOverrides?: boolean
  /** 恢复工作流默认（Step 1：清空 overrides/pluginOverrides） */
  restoreWorkflowDefault?: boolean
  /** 轻量乐观锁：期望的 policyVersion */
  expectedPolicyVersion?: number
  /** 包含/排除规则增量（忽略规则 Tab 使用） */
  customIncludeRules?: unknown[]
  customExcludeRules?: unknown[]
  /** 解绑时保留包含/排除规则安全快照（默认 true） */
  preserveInclusionSnapshot?: boolean
}

/** 补丁提交结果 */
export interface WorkspacePolicyMutationResult {
  success: boolean
  error?: string | { code?: string; message?: string; stack?: string; details?: unknown }
  errorCode?: string
  errorMessage?: string
  appliedConfig?: unknown
  /** 严格单调递增后的策略版本 */
  policyVersion?: number
  /** 是否触发了准入变化（影响文件重扫范围） */
  admissionChanged?: boolean
}

/** 统一从 WorkspacePolicyMutationResult 中提取可读错误文案 */
export function getMutationErrorText(
  result: WorkspacePolicyMutationResult,
  fallback: string
): string {
  if (typeof result.error === 'string' && result.error) return result.error
  if (result.error && typeof result.error === 'object' && result.error.message) {
    return result.error.message
  }
  return result.errorMessage || fallback
}

/**
 * 提交工作区策略补丁（统一平铺通道封装）
 *
 * 调用顶层 window.electronAPI.applyWorkspacePolicyMutation（Group B 平铺暴露，
 * 不存在 window.electronAPI.workspace 命名空间）。通道未就绪时显式上报，
 * 严禁伪造成功。
 */
export async function submitWorkspacePolicyMutation(
  workspaceId: number,
  mutation: WorkspacePolicyMutation
): Promise<WorkspacePolicyMutationResult> {
  const channel = getPolicyApiWindow()?.electronAPI?.applyWorkspacePolicyMutation
  if (typeof channel !== 'function') {
    // 显式失败：上游 preload 平铺通道未就绪，绝不静默假成功
    return {
      success: false,
      error: 'WORKSPACE_POLICY_MUTATION_CHANNEL_UNAVAILABLE'
    }
  }
  return channel(workspaceId, mutation)
}

/** 主进程权威运行时上下文快照（contextEpoch 单调递增） */
export interface WorkspaceRuntimeContextSnapshot {
  contextEpoch: number
  workspaceId: number | null
  libreOfficeInstalled: boolean
  generativeAiEnabled: boolean
  globalEmbeddingProfile: 'classic_light' | 'gemma_unified' | 'unknown'
  videoInferenceBackend: 'cpu' | 'gpu' | 'unknown'
  isProTier: boolean
  /** 模块可用性：pluginId -> availability + install 状态 */
  moduleStates: Record<
    string,
    { availability: string; installed: boolean; active: boolean; error?: string }
  >
  /** 环境能力恢复后可增量补齐的历史文件数（由主进程统计） */
  recoverableCount?: number
}

/** 触发当前工作区环境恢复增量补齐入队（通道未就绪时显式返回失败，严禁假成功） */
export async function triggerWorkspaceIncrementalRecovery(
  workspaceId: number
): Promise<{ success: boolean; queued?: number; error?: string }> {
  const channel = getPolicyApiWindow()?.electronAPI?.triggerWorkspaceIncrementalRecovery
  if (typeof channel !== 'function') {
    return {
      success: false,
      error: 'WORKSPACE_INCREMENTAL_RECOVERY_CHANNEL_UNAVAILABLE'
    }
  }
  return channel(workspaceId)
}

/** 拉取运行时上下文快照 */
export async function fetchWorkspaceRuntimeContext(): Promise<WorkspaceRuntimeContextSnapshot | null> {
  const channel = getPolicyApiWindow()?.electronAPI?.getWorkspaceRuntimeContextSnapshot
  if (typeof channel !== 'function') return null
  return channel()
}

/** 订阅运行时上下文更新（仅 incoming.contextEpoch > local.contextEpoch 时接收） */
export function subscribeWorkspaceRuntimeContext(
  callback: (snapshot: WorkspaceRuntimeContextSnapshot) => void
): () => void {
  const channel = getPolicyApiWindow()?.electronAPI?.onWorkspaceRuntimeContextUpdated
  if (typeof channel !== 'function') return () => {}
  return channel(callback)
}

/**
 * 目录级可配置插件白名单（L3 §1.2 D5：6 项）
 * 严禁渲染 GLOBAL_ONLY_PLUGIN_IDS。
 */
export const WORKSPACE_CONFIGURABLE_PLUGIN_IDS = [
  'asr_sensevoice_onnx',
  'perception_nsfw',
  'archive_vfs_parser',
  'face_recognition_tool',
  'object_detection_pro',
  'password_vault_cracker'
] as const

/** 全局专属插件（6 项，严禁进入目录页） */
export const GLOBAL_ONLY_PLUGIN_IDS = [
  'engine_classic_light',
  'engine_gemma_unified',
  'pocket-cpu-int8-onnx',
  'tts_moss_onnx',
  'tts_m5_onnx',
  'diffusion_studio'
] as const

/** 已上线可用目录插件（主区） */
export const WORKSPACE_AVAILABLE_PLUGIN_IDS = ['asr_sensevoice_onnx', 'perception_nsfw'] as const

/** 即将上线目录插件（预告区，不计降级） */
export const WORKSPACE_COMING_SOON_PLUGIN_IDS = [
  'archive_vfs_parser',
  'face_recognition_tool',
  'object_detection_pro',
  'password_vault_cracker'
] as const

/** 判定是否目录级可配置插件 */
export function isWorkspaceConfigurablePlugin(pluginId: string): boolean {
  return (WORKSPACE_CONFIGURABLE_PLUGIN_IDS as readonly string[]).includes(pluginId)
}

/** 判定是否全局专属插件（目录页必须排除） */
export function isGlobalOnlyPlugin(pluginId: string): boolean {
  return (GLOBAL_ONLY_PLUGIN_IDS as readonly string[]).includes(pluginId)
}

/**
 * 本地隔离版三态仲裁输入（Group A 合流前的过渡形态）
 *
 * Group A 的共享纯函数 resolveEffectiveAIConfig 合流后，本输入与返回值将被
 * @firefly/shared 权威实现取代，调用点零改动。
 */
export interface LocalEffectiveConfigInput {
  /** 已就绪配置（含 baseAIConfig + overrides + workflowId） */
  parsedConfig: {
    status: 'ready' | 'pending'
    workflowId?: string
    baseAIConfig?: object
    overrides?: object
  }
  /** 主进程运行时上下文快照（可为 null，null 时按未降级处理） */
  runtimeSnapshot: WorkspaceRuntimeContextSnapshot | null
  /** 6 个目录插件的三态仲裁结果（由上游 resolver 产出，本地过渡期可传空对象） */
  plugins?: Record<string, ResolvedPluginTriState>
}

/**
 * 本地隔离版三态仲裁（过渡实现）
 *
 * 在 Group A 合流前，提供最小可用的三桶计数：
 * - defaultCount：origin !== 'user_custom' 且 applicability === 'active' 的可见字段数
 * - userCustomCount：origin === 'user_custom' 的字段数
 * - degradedCount：按根因去重后的降级字段数
 *
 * 注意：过渡期 fields 为空时三桶计数均为 0（横幅仅显示「默认配置/工作流默认 0」），
 * 不伪造计数；真实字段级仲裁待 Group A resolver 合流后接入。
 */
export function computeLocalEffectiveConfig(
  input: LocalEffectiveConfigInput
): EffectiveWorkspaceAIConfigResult {
  const { parsedConfig, runtimeSnapshot, plugins = {} } = input

  const fields: Record<string, ResolvedTriStateField> = {}
  let defaultCount = 0
  let userCustomCount = 0
  const degradedRootCauses = new Set<string>()

  const overrides = (parsedConfig.overrides ?? {}) as Record<string, unknown>
  for (const key of Object.keys(overrides)) {
    // 用户手动触碰即计入 user_custom（隔离期最小判定：overrides 里有键即 user_custom）
    fields[key] = {
      effectiveValue: overrides[key],
      desiredValue: overrides[key],
      origin: 'user_custom',
      applicability: 'active',
      visible: true,
      isUserCustom: true
    }
    userCustomCount += 1
  }

  // 降级计数：过渡期依据 runtimeSnapshot 推导最常见的两类根因
  if (runtimeSnapshot) {
    if (!runtimeSnapshot.generativeAiEnabled) {
      degradedRootCauses.add('generative_ai_disabled')
    }
    if (runtimeSnapshot.globalEmbeddingProfile !== 'gemma_unified') {
      degradedRootCauses.add('gemma_unified_not_active')
    }
    if (!runtimeSnapshot.libreOfficeInstalled) {
      degradedRootCauses.add('libreoffice_missing')
    }
  }

  const degradedFieldCount = degradedRootCauses.size

  const capabilities: Record<string, boolean | number> = {
    asrEffectivelyEnabled: plugins['asr_sensevoice_onnx']?.effectiveValue ?? false
  }

  return {
    effectiveParams: (parsedConfig.baseAIConfig ?? {}) as unknown as TechnicalEngineParameters,
    fields,
    plugins,
    capabilities,
    sectionNotices: [],
    summary: {
      defaultOrigin:
        parsedConfig.workflowId != null ? 'workflow_default' : 'system_default',
      defaultCount,
      userCustomCount,
      degradedFieldCount,
      degradedCount: degradedFieldCount,
      totalVisibleCount: defaultCount + userCustomCount + degradedFieldCount,
      boundWorkflowId: parsedConfig.workflowId ?? null
    }
  }
}
