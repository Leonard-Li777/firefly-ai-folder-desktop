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
import type { BaseAIConfig, TechnicalEngineParameters, WorkspaceConfigReady } from '@firefly/types'
import {
  WORKSPACE_CONFIGURABLE_PLUGIN_IDS as SHARED_WORKSPACE_CONFIGURABLE_PLUGIN_IDS,
  GLOBAL_ONLY_PLUGIN_IDS as SHARED_GLOBAL_ONLY_PLUGIN_IDS
} from '@firefly/types'
import {
  resolveEffectiveAIConfig,
  type GlobalPluginRuntimeState,
  type WorkspaceRuntimeContext,
  type DegradationFixAction as SharedDegradationFixAction
} from '@firefly/shared'

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
    getWorkspaceRuntimeContextSnapshot?: (workspaceId?: number | null) => Promise<unknown>
    onWorkspaceRuntimeContextUpdated?: (callback: (snapshot: unknown) => void) => () => void
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
  /** 工作流推荐标识：本工作流推荐开启 / 本主题默认关闭 / 默认关闭 */
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
  /** AI 参数整字典替换或清空（撤销解绑恢复用，传 null 表清空） */
  overrides?: Partial<BaseAIConfig> | null
  /** 目录插件开关整字典替换或清空（撤销解绑恢复用，传 null 表清空） */
  pluginOverrides?: Partial<Record<string, boolean>> | null
  /** AI 参数增量补丁：仅写入值 ≠ 当前基线的显式覆盖（等值回退算默认态，须改走 restoreOverrideFields） */
  overridePatch?: Partial<TechnicalEngineParameters>
  /** 恢复默认：精确 delete 覆盖字典中对应键（严禁传 null/undefined）；等值回退与显式恢复共用该通道 */
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
  /** 环境能力恢复后可增量补齐的历史文件数（由主进程统计，横幅 24h 静默时为 0） */
  recoverableCount?: number
  /** 待补非视频缺口文件数（OCR/封面/缩略图/内容/向量/ASR） */
  recoverableNonVideoCount?: number
  /** 待续跑长视频切片文件数 */
  recoverablePendingVideoCount?: number
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

/** 待补清单单项（设置页用） */
export interface RecoverableFileItem {
  workspaceFileId: number
  fileFingerprint: string | null
  path: string
  name: string
  fileSize: number
  missingReasons: string[]
  isPendingVideo: boolean
}

export interface RecoveryQueueResult {
  success: boolean
  items: RecoverableFileItem[]
  error?: string
}

function getRecoveryApi() {
  return getPolicyApiWindow()?.electronAPI as
    | {
        getWorkspaceRecoveryQueue?: (wsId: number) => Promise<RecoveryQueueResult>
        clearWorkspaceRecoveryItems?: (
          wsId: number,
          ids?: number[]
        ) => Promise<{ success: boolean; cleared?: number; error?: string }>
        dismissWorkspaceRecoveryBanner?: (
          wsId: number
        ) => Promise<{ success: boolean; error?: string }>
        enqueueWorkspaceRecoveryItems?: (
          wsId: number,
          ids?: number[]
        ) => Promise<{ success: boolean; queued?: number; error?: string }>
        listWorkspacePendingBackfillVideos?: (
          wsId: number
        ) => Promise<import('@firefly/types').WorkspaceBackfillListResult>
        startVideoBackfill?: (wsId?: number) => Promise<{ started: boolean }>
        pauseVideoBackfill?: () => Promise<{ paused: boolean }>
        prioritizeVideoBackfill?: (
          wsId: number,
          fileFingerprint: string
        ) => Promise<{ ok: boolean }>
        retryFailedVideoBackfill?: (wsId: number) => Promise<{ resetCount: number }>
      }
    | undefined
}

/** 拉取待补文件清单（设置页用，含每个文件的具体待补项） */
export async function fetchWorkspaceRecoveryQueue(
  workspaceId: number
): Promise<RecoveryQueueResult> {
  const api = getRecoveryApi()
  if (typeof api?.getWorkspaceRecoveryQueue !== 'function') {
    return { success: false, items: [], error: 'WORKSPACE_RECOVERY_QUEUE_CHANNEL_UNAVAILABLE' }
  }
  return api.getWorkspaceRecoveryQueue(workspaceId)
}

/** 清除待补文件（清除后不再计数、不再被补全捞回） */
export async function clearWorkspaceRecoveryItems(
  workspaceId: number,
  workspaceFileIds?: number[]
): Promise<{ success: boolean; cleared?: number; error?: string }> {
  const api = getRecoveryApi()
  if (typeof api?.clearWorkspaceRecoveryItems !== 'function') {
    return { success: false, error: 'WORKSPACE_RECOVERY_CLEAR_CHANNEL_UNAVAILABLE' }
  }
  return api.clearWorkspaceRecoveryItems(workspaceId, workspaceFileIds)
}

/** 记录横幅关闭（24h 内不再弹，即使有新文件） */
export async function dismissWorkspaceRecoveryBanner(
  workspaceId: number
): Promise<{ success: boolean; error?: string }> {
  const api = getRecoveryApi()
  if (typeof api?.dismissWorkspaceRecoveryBanner !== 'function') {
    return { success: false, error: 'WORKSPACE_RECOVERY_DISMISS_CHANNEL_UNAVAILABLE' }
  }
  return api.dismissWorkspaceRecoveryBanner(workspaceId)
}

/** 触发补全入队（不传 ids = 全部待补；传 ids = 仅指定文件） */
export async function enqueueWorkspaceRecoveryItems(
  workspaceId: number,
  workspaceFileIds?: number[]
): Promise<{ success: boolean; queued?: number; error?: string }> {
  const api = getRecoveryApi()
  if (typeof api?.enqueueWorkspaceRecoveryItems !== 'function') {
    return { success: false, error: 'WORKSPACE_RECOVERY_ENQUEUE_CHANNEL_UNAVAILABLE' }
  }
  return api.enqueueWorkspaceRecoveryItems(workspaceId, workspaceFileIds)
}

/** 拉取指定工作区的长视频空闲补全清单（Spec §3.5） */
export async function fetchWorkspacePendingBackfillVideos(
  workspaceId: number
): Promise<import('@firefly/types').WorkspaceBackfillListResult> {
  const api = getRecoveryApi()
  if (typeof api?.listWorkspacePendingBackfillVideos !== 'function') {
    return {
      success: false,
      workspaceId,
      effectiveLimitSec: 300,
      items: [],
      snapshot: { running: false, userPaused: false, pendingVideoCount: 0, pendingSliceCount: 0 },
      error: 'VIDEO_BACKFILL_CHANNEL_UNAVAILABLE'
    }
  }
  return api.listWorkspacePendingBackfillVideos(workspaceId)
}

export async function startVideoBackfill(workspaceId?: number): Promise<{ started: boolean }> {
  const api = getRecoveryApi()
  if (typeof api?.startVideoBackfill !== 'function') return { started: false }
  return api.startVideoBackfill(workspaceId)
}

export async function pauseVideoBackfill(): Promise<{ paused: boolean }> {
  const api = getRecoveryApi()
  if (typeof api?.pauseVideoBackfill !== 'function') return { paused: false }
  return api.pauseVideoBackfill()
}

export async function prioritizeVideoBackfill(
  workspaceId: number,
  fileFingerprint: string
): Promise<{ ok: boolean }> {
  const api = getRecoveryApi()
  if (typeof api?.prioritizeVideoBackfill !== 'function') return { ok: false }
  return api.prioritizeVideoBackfill(workspaceId, fileFingerprint)
}

export async function retryFailedVideoBackfill(
  workspaceId: number
): Promise<{ resetCount: number }> {
  const api = getRecoveryApi()
  if (typeof api?.retryFailedVideoBackfill !== 'function') return { resetCount: 0 }
  return api.retryFailedVideoBackfill(workspaceId)
}

/** 将主进程标准信封 `{ contextEpoch, snapshot: WorkspaceRuntimeContext }`（或测试扁平对象）统一归一化 */
function normalizeRuntimeSnapshot(raw: unknown): WorkspaceRuntimeContextSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const nested =
    obj.snapshot && typeof obj.snapshot === 'object'
      ? (obj.snapshot as WorkspaceRuntimeContext)
      : null

  if (nested) {
    const pluginStates = nested.globalPluginStates ?? {}
    const moduleStates: WorkspaceRuntimeContextSnapshot['moduleStates'] = {}
    for (const [id, st] of Object.entries(pluginStates)) {
      moduleStates[id] = {
        availability: 'approved',
        installed: st === 'active' || st === 'installed_inactive' || st === 'error',
        active: st === 'active',
        error: st === 'error' ? 'MODULE_ERROR' : undefined
      }
    }
    const tierStr = String(nested.userTier ?? '')
      .trim()
      .toLowerCase()
    return {
      contextEpoch: Number(obj.contextEpoch ?? 0),
      workspaceId: (obj.workspaceId as number | null | undefined) ?? null,
      libreOfficeInstalled: Boolean(nested.libreOfficeInstalled),
      generativeAiEnabled: Boolean(nested.isGenerativeAiEnabled),
      globalEmbeddingProfile: nested.globalEmbeddingProfile ?? 'classic_light',
      videoInferenceBackend: nested.videoInferenceBackend ?? 'unknown',
      isProTier:
        tierStr === 'pro' || tierStr === 'enterprise' || tierStr === 'agent' || tierStr === 'max',
      moduleStates,
      recoverableCount: typeof obj.recoverableCount === 'number' ? obj.recoverableCount : undefined,
      recoverableNonVideoCount:
        typeof obj.recoverableNonVideoCount === 'number' ? obj.recoverableNonVideoCount : undefined,
      recoverablePendingVideoCount:
        typeof obj.recoverablePendingVideoCount === 'number'
          ? obj.recoverablePendingVideoCount
          : undefined
    }
  }

  return obj as unknown as WorkspaceRuntimeContextSnapshot
}

/** 拉取运行时上下文快照（自动解包主进程 `{ contextEpoch, snapshot }` 信封） */
export async function fetchWorkspaceRuntimeContext(
  workspaceId?: number | null
): Promise<WorkspaceRuntimeContextSnapshot | null> {
  const channel = getPolicyApiWindow()?.electronAPI?.getWorkspaceRuntimeContextSnapshot
  if (typeof channel !== 'function') return null
  const raw = await channel(workspaceId)
  return normalizeRuntimeSnapshot(raw)
}

/** 订阅运行时上下文更新（仅 incoming.contextEpoch > local.contextEpoch 时接收） */
export function subscribeWorkspaceRuntimeContext(
  callback: (snapshot: WorkspaceRuntimeContextSnapshot) => void
): () => void {
  const channel = getPolicyApiWindow()?.electronAPI?.onWorkspaceRuntimeContextUpdated
  if (typeof channel !== 'function') return () => {}
  return channel((raw: unknown) => {
    const normalized = normalizeRuntimeSnapshot(raw)
    if (normalized) callback(normalized)
  })
}

/**
 * 目录级可配置插件白名单（直接转出 `@firefly/types` 唯一事实源，L3 §1.2 D5：10 项）
 */
export const WORKSPACE_CONFIGURABLE_PLUGIN_IDS = SHARED_WORKSPACE_CONFIGURABLE_PLUGIN_IDS

/** 全局专属插件（直接转出 `@firefly/types` 唯一事实源，6 项，严禁进入目录页） */
export const GLOBAL_ONLY_PLUGIN_IDS = SHARED_GLOBAL_ONLY_PLUGIN_IDS

/** 已上线可用目录插件（主区） */
export const WORKSPACE_AVAILABLE_PLUGIN_IDS = ['asr_sensevoice_onnx', 'perception_nsfw'] as const

/** 即将上线目录插件（预告区，不计降级） */
export const WORKSPACE_COMING_SOON_PLUGIN_IDS = [
  'archive_vfs_parser',
  'face_recognition_tool',
  'object_detection_pro',
  'password_vault_cracker',
  'image_video_enhance',
  'image_video_deobfuscate',
  'image_video_dewatermark',
  'file_ai_cover',
  'design_file_parser'
] as const

/** 判定是否目录级可配置插件 */
export function isWorkspaceConfigurablePlugin(pluginId: string): boolean {
  return (WORKSPACE_CONFIGURABLE_PLUGIN_IDS as readonly string[]).includes(pluginId)
}

/** 判定是否全局专属插件（目录页必须排除） */
export function isGlobalOnlyPlugin(pluginId: string): boolean {
  return (GLOBAL_ONLY_PLUGIN_IDS as readonly string[]).includes(pluginId)
}

function mapSharedFixAction(action?: SharedDegradationFixAction): DegradationFixAction {
  switch (action) {
    case 'enable_generative_ai':
    case 'select_simple_mode':
      return 'open_generative_engine'
    case 'switch_gemma_engine':
      return 'switch_to_gemma_unified'
    case 'install_or_activate_global_plugin':
      return 'install_global_plugin'
    case 'repair_global_plugin':
      return 'fix_global_plugin'
    case 'enable_workspace_plugin':
      return 're_enable_parent_plugin'
    case 'install_libreoffice':
      return 'install_libreoffice'
    case 'upgrade_pro':
      return 'open_pro_upgrade'
    default:
      return 'none'
  }
}

function buildSharedRuntimeContext(
  runtimeSnapshot: WorkspaceRuntimeContextSnapshot | null
): WorkspaceRuntimeContext {
  const globalPluginStates: Record<string, GlobalPluginRuntimeState> = {}
  const rawStates = runtimeSnapshot?.moduleStates ?? {}
  for (const [id, st] of Object.entries(rawStates)) {
    if (st.error) {
      globalPluginStates[id] = 'error'
    } else if (st.installed && st.active) {
      globalPluginStates[id] = 'active'
    } else if (st.installed) {
      globalPluginStates[id] = 'installed_inactive'
    } else {
      globalPluginStates[id] = 'not_installed'
    }
  }
  const embeddingProfile =
    runtimeSnapshot?.globalEmbeddingProfile === 'gemma_unified' ? 'gemma_unified' : 'classic_light'
  if (!globalPluginStates['engine_gemma_unified'] && embeddingProfile === 'gemma_unified') {
    globalPluginStates['engine_gemma_unified'] = 'active'
  }
  return {
    isGenerativeAiEnabled: runtimeSnapshot ? runtimeSnapshot.generativeAiEnabled : true,
    globalEmbeddingProfile: embeddingProfile,
    globalPluginStates,
    libreOfficeInstalled: runtimeSnapshot ? runtimeSnapshot.libreOfficeInstalled : true,
    userTier: runtimeSnapshot?.isProTier ? 'pro' : 'free',
    tierReady: runtimeSnapshot !== null,
    videoInferenceBackend: runtimeSnapshot?.videoInferenceBackend ?? 'unknown',
    hardwareInfo: null
  }
}

export interface LocalEffectiveConfigInput {
  /** 已就绪配置（含 baseAIConfig + overrides + workflowId + workflowPluginDefaults + pluginOverrides） */
  parsedConfig: {
    status: 'ready' | 'pending'
    workflowId?: string
    baseAIConfig?: object
    overrides?: object
    workflowPluginDefaults?: readonly string[]
    pluginOverrides?: Partial<Record<string, boolean>>
  }
  /** 主进程运行时上下文快照（可为 null） */
  runtimeSnapshot: WorkspaceRuntimeContextSnapshot | null
  /** 可选外部覆写插件态（测试兼容用） */
  plugins?: Record<string, ResolvedPluginTriState>
}

/**
 * 渲染端三态仲裁入口：
 * 直接委托 `@firefly/shared` 唯一权威纯函数 `resolveEffectiveAIConfig()`，
 * 保证 14 字段 + 6 插件三态与主进程计算结果 100% 字节级一致。
 */
export function computeLocalEffectiveConfig(
  input: LocalEffectiveConfigInput
): EffectiveWorkspaceAIConfigResult {
  const { parsedConfig, runtimeSnapshot, plugins: externalPlugins } = input
  const runtimeContext = buildSharedRuntimeContext(runtimeSnapshot)

  const resolved = resolveEffectiveAIConfig(
    parsedConfig.status === 'ready'
      ? (parsedConfig as unknown as Pick<
          WorkspaceConfigReady,
          'workflowId' | 'baseAIConfig' | 'overrides' | 'workflowPluginDefaults' | 'pluginOverrides'
        >)
      : null,
    runtimeContext
  )

  const fields: Record<string, ResolvedTriStateField> = {}
  for (const [key, field] of Object.entries(resolved.fields)) {
    fields[key] = {
      effectiveValue: field.effectiveValue,
      desiredValue: field.desiredValue,
      origin: field.origin,
      applicability: field.applicability,
      visible: field.visible,
      isUserCustom: field.origin === 'user_custom',
      degradationReason: field.degradationReason as DegradationReasonCode | undefined,
      fixAction: mapSharedFixAction(field.fixAction),
      relatedPluginId: field.relatedPluginId,
      inactiveReason: field.inactiveReason as InactiveReasonCode | undefined
    }
  }

  const isBoundWorkflow = parsedConfig.status === 'ready' && Boolean(parsedConfig.workflowId)
  const plugins: Record<string, ResolvedPluginTriState> = {}
  for (const [pluginId, pluginField] of Object.entries(resolved.plugins)) {
    const isComingSoon = (WORKSPACE_COMING_SOON_PLUGIN_IDS as readonly string[]).includes(pluginId)
    plugins[pluginId] = {
      pluginId,
      effectiveValue: pluginField.effectiveValue,
      origin: pluginField.origin,
      applicability: pluginField.applicability,
      availability: isComingSoon ? 'coming_soon' : 'approved',
      workflowRecommendation: isBoundWorkflow
        ? pluginField.baselineValue
          ? 'workflow_recommended_on'
          : 'workflow_default_off'
        : 'system_default_off',
      degradationReason: pluginField.degradationReason as DegradationReasonCode | undefined,
      inactiveReason: pluginField.inactiveReason as InactiveReasonCode | undefined
    }
  }
  if (externalPlugins) {
    Object.assign(plugins, externalPlugins)
  }

  return {
    effectiveParams: resolved.effectiveParams as unknown as TechnicalEngineParameters,
    fields,
    plugins,
    capabilities: {
      videoVisualAnalysisEnabled: resolved.capabilities.videoVisualAnalysisEnabled,
      asrEffectivelyEnabled: resolved.capabilities.asrEffectivelyEnabled,
      nsfwEffectivelyEnabled: resolved.capabilities.nsfwEffectivelyEnabled,
      faceEffectivelyEnabled: resolved.capabilities.faceEffectivelyEnabled,
      objectDetectionEffectivelyEnabled: resolved.capabilities.objectDetectionEffectivelyEnabled,
      archiveVfsEffectivelyEnabled: resolved.capabilities.archiveVfsEffectivelyEnabled,
      passwordVaultEffectivelyEnabled: resolved.capabilities.passwordVaultEffectivelyEnabled,
      isCpuOnlyFallback: resolved.capabilities.isCpuOnlyFallback
    },
    sectionNotices: resolved.sectionNotices.map(n => ({
      id: `${n.scope}:${n.reasonCode}`,
      message: n.plainText,
      severity: 'degraded' as const
    })),
    summary: {
      defaultOrigin: resolved.summary.defaultOrigin,
      defaultCount: resolved.summary.defaultCount,
      userCustomCount: resolved.summary.userCustomCount,
      degradedFieldCount: resolved.summary.degradedFieldCount,
      degradedCount: resolved.summary.degradedCount,
      totalVisibleCount: resolved.summary.totalVisibleCount,
      boundWorkflowId: resolved.summary.boundWorkflowId ?? null
    }
  }
}
