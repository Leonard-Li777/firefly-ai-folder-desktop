import {
  Check,
  Cpu,
  Gauge,
  HelpCircle,
  Layers,
  Mic,
  Lock,
  RefreshCw,
  Sparkles,
  ChevronDown,
  ChevronRight,
  Sliders,
  ShieldCheck,
  Crown,
  Loader2,
  CheckCircle2,
  RotateCcw
} from 'lucide-react'
import React, { useEffect, useState, useMemo, useRef, useCallback } from 'react'
import { Button } from '../../ui/button'
import { Card } from '../../ui/card'
import { Switch } from '../../ui/switch'
import { Label } from '../../ui/label'
import { TriStateFieldFeedback } from './TriStateFieldFeedback'
import { TriStateCustomFieldsTable, type TriStateCustomFieldRow } from './TriStateCustomFieldsTable'
import {
  BaseAIConfig,
  WorkspaceDirectory,
  WorkspaceConfig,
  TechnicalEngineParameters,
  parseWorkspaceConfig,
  HardwareInfo,
  UserTier,
  DEFAULT_UNBOUND_AI_CONFIG
} from '@firefly/types'
import {
  VideoAnalysisProfile,
  VideoCutSensitivity,
  VIDEO_ANALYSIS_PRESETS,
  estimateVideoAnalysisDurationSec,
  isAppleSiliconPlatform,
  isDedicatedGpu,
  mapIntentToParameters
} from '@firefly/shared'
import { useTierStore } from '../../../stores/tier-store'
import { UpgradeAccountDialog } from '../../tier/UpgradeAccountDialog'
import { captureEvent } from '../../../lib/posthog'
import { useSettingsStore } from '../../../stores/settings-store'
import { usePluginCenterStore } from '../../../stores/plugin-center-store'
import { toast } from '../../common/Toast'
import { t } from '@app/languages'
import {
  submitWorkspacePolicyMutation,
  getMutationErrorText
} from '../../../lib/workspace-policy/workspace-ai-client'
import { getIntentDisplayName } from '../WorkspaceConfigPanel'
import { cn } from '../../../lib/utils'

export interface BasicAIEngineTabProps {
  workspace: WorkspaceDirectory
  hardwareInfo?: HardwareInfo | null
  isActive?: boolean
  onConfigSaved?: () => void
  resolvedFields?: Record<
    string,
    import('../../../lib/workspace-policy/workspace-ai-client').ResolvedTriStateField
  >
  hasBoundWorkflow?: boolean
  onFixAction?: (
    action: import('../../../lib/workspace-policy/workspace-ai-client').DegradationFixAction,
    pluginId?: string
  ) => void
}

/** 待提交的补丁累积 */
interface PendingPolicyPatch {
  patch: Partial<TechnicalEngineParameters>
  restore: Set<keyof TechnicalEngineParameters>
}

/**
 * BASIC_AI_KEYS 参数项展示名（渲染期 switch 动态返回静态 t() 以支持语言切换，
 * 严禁置于模块级静态对象字面量——t() 静态对象切换语言后无法刷新）
 */
function getBasicAiFieldLabel(key: string): string {
  switch (key) {
    case 'analysisMode':
      return t('选择分析模式')
    case 'videoQuotaMax':
      return t('单视频最大抓图数量')
    case 'videoCutSensitivity':
      return t('镜头切换捕捉敏锐度')
    case 'videoSoftTokenBudget':
      return t('画面识别精细度')
    case 'videoAnalyzeDurationSec':
      return t('每个视频分析时长上限')
    case 'videoAsrDurationSec':
      return t('视频伴音台词识别上限')
    case 'audioAnalysisDurationSec':
      return t('纯音频听写时长上限')
    case 'clipTextEnabled':
      return t('文字直接找图')
    case 'reuseBasicAnalysisData':
      return t('重新分析时复用数据')
    default:
      return key
  }
}

/** 设置值四态表格各值列的大白话渲染：布尔转「开启/关闭」、枚举转 UI 命名、数值带单位（渲染期动态 t()） */
function formatTriStateCellValue(key: string, v: unknown): string {
  if (typeof v === 'boolean') return v ? t('开启') : t('关闭')
  switch (key) {
    case 'analysisMode':
      return v === 'simple'
        ? t('标准分析')
        : v === 'quick_name'
          ? t('增强分析')
          : v === 'full'
            ? t('全面分析')
            : String(v ?? '')
    case 'videoCutSensitivity':
      return v === 'low'
        ? t('常规')
        : v === 'medium'
          ? t('灵敏 (推荐)')
          : v === 'high'
            ? t('极高 (防吞噬)')
            : String(v ?? '')
    case 'videoSoftTokenBudget': {
      const n = Number(v)
      if (!Number.isFinite(n)) return String(v ?? '')
      return n <= 48 ? t('流畅极速') : t('高清精细')
    }
    case 'videoQuotaMax': {
      const n = Number(v)
      if (!Number.isFinite(n)) return String(v ?? '')
      return `${n} ${t('张')}`
    }
    case 'videoAnalyzeDurationSec': {
      const n = Number(v)
      if (!Number.isFinite(n)) return String(v ?? '')
      return `${Math.round(n / 60)} ${t('分钟')}`
    }
    case 'videoAsrDurationSec':
    case 'audioAnalysisDurationSec': {
      const n = Number(v)
      if (!Number.isFinite(n)) return String(v ?? '')
      return `${n} ${t('秒')}`
    }
    default:
      return String(v ?? '')
  }
}

/** 属于基础AI引擎 Tab 专管的参数键列表 (与文件内容萃取隔离，严格剥离全局向量底座键) */
const BASIC_AI_KEYS: (keyof BaseAIConfig)[] = [
  'analysisMode',
  'videoCutSensitivity',
  'videoSoftTokenBudget',
  'videoQuotaMax',
  'videoAnalyzeDurationSec',
  'videoAsrDurationSec',
  'audioAnalysisDurationSec',
  'clipTextEnabled',
  'reuseBasicAnalysisData'
]

/**
 * 辅助悬浮气泡组件
 */
const HelpTooltip: React.FC<{ content: string }> = ({ content }) => {
  const [visible, setVisible] = useState(false)
  return (
    <span
      className="relative inline-flex items-center ml-1 cursor-pointer text-muted-foreground hover:text-foreground"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      <HelpCircle className="h-3.5 w-3.5" />
      {visible && (
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-2 text-xs bg-popover text-popover-foreground border rounded-lg shadow-md z-50 pointer-events-none whitespace-normal normal-case leading-normal font-normal">
          {content}
        </span>
      )}
    </span>
  )
}

/**
 * 工作区专有：基础AI引擎设置 Tab (原 basic-ai-engine-config-settings 100% 完整原味还原版)
 */
export const BasicAIEngineTab: React.FC<BasicAIEngineTabProps> = ({
  workspace,
  hardwareInfo,
  isActive = true,
  onConfigSaved,
  resolvedFields,
  hasBoundWorkflow = false,
  onFixAction
}) => {
  const config = useSettingsStore(s => s.config)
  const getConfigValue = useSettingsStore(s => s.getConfigValue)
  const isDev = Boolean(
    (import.meta as any)?.env?.DEV ??
    (typeof window !== 'undefined' && window.electronAPI?.isPackaged === false)
  )

  const tier = useTierStore(s => s.tier)
  const isFreeUser = (tier ?? UserTier.FREE) === UserTier.FREE
  const [isUpgradeOpen, setIsUpgradeOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  // 解析当前工作区配置
  const parsedConfig = useMemo<WorkspaceConfig>(() => {
    return parseWorkspaceConfig(workspace.workspace_config)
  }, [workspace.workspace_config])

  const isReady = parsedConfig.status === 'ready'
  const currentIntent = isReady && parsedConfig.intent ? parsedConfig.intent : 'fast_archive'

  // 基线快照与工作目录 overrides
  const baseDerived: BaseAIConfig = useMemo(() => {
    if (isReady && parsedConfig.baseAIConfig) {
      return parsedConfig.baseAIConfig
    }
    return mapIntentToParameters(currentIntent, hardwareInfo) as BaseAIConfig
  }, [isReady, parsedConfig, currentIntent, hardwareInfo])

  const [overrides, setOverrides] = useState<Partial<TechnicalEngineParameters>>(() => {
    if (isReady && parsedConfig.overrides) {
      return { ...parsedConfig.overrides }
    }
    return {}
  })

  useEffect(() => {
    const fresh = parseWorkspaceConfig(workspace.workspace_config)
    if (fresh.status === 'ready' && fresh.overrides) {
      setOverrides({ ...fresh.overrides })
    } else {
      setOverrides({})
    }
  }, [workspace.id, workspace.workspace_config])

  const effectiveParams: BaseAIConfig = useMemo(() => {
    return {
      ...baseDerived,
      ...overrides
    }
  }, [baseDerived, overrides])

  // 待提交的补丁累积（用户触碰字段 / 待恢复字段）与防抖计时器
  const pendingPatchRef = useRef<PendingPolicyPatch | null>(null)
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null)

  /** 通过统一补丁通道提交（严禁整份拼装 WorkspaceConfigReady 直写） */
  const persistMutation = useCallback(
    async (pending: PendingPolicyPatch) => {
      if (!workspace.id) return
      const restoreKeys = Array.from(pending.restore)
      const hasPatch = Object.keys(pending.patch).length > 0
      if (!hasPatch && restoreKeys.length === 0) return
      setIsSaving(true)
      try {
        const res = await submitWorkspacePolicyMutation(workspace.id, {
          ...(hasPatch ? { overridePatch: pending.patch } : {}),
          ...(restoreKeys.length > 0 ? { restoreOverrideFields: restoreKeys } : {})
        })
        if (res.success) {
          onConfigSaved?.()
        } else {
          toast.error(getMutationErrorText(res, t('保存失败')))
        }
      } catch (err: any) {
        console.error('[BasicAIEngineTab] 提交配置补丁异常:', err)
        toast.error(t('保存失败'))
      } finally {
        setIsSaving(false)
      }
    },
    [workspace.id, onConfigSaved]
  )

  const flushPending = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
    const pending = pendingPatchRef.current
    if (pending !== null) {
      pendingPatchRef.current = null
      void persistMutation(pending)
    }
  }, [persistMutation])

  // 切 Tab (isActive 变为 false) 或卸载时立即 flush 未落盘数据，杜绝并发覆盖竞态
  useEffect(() => {
    if (!isActive) flushPending()
  }, [isActive, flushPending])

  useEffect(() => {
    return () => flushPending()
  }, [flushPending])

  // 修改单个参数：等值回退——设值与当前基线（工作流默认/系统默认）一致时精确 delete 覆盖键算回默认态，
  // 仅值 ≠ 基线的显式覆盖写入补丁保留 user_custom，500ms 防抖提交
  const handleParamChange = <K extends keyof TechnicalEngineParameters>(
    key: K,
    val: TechnicalEngineParameters[K]
  ) => {
    const baselineVal = (baseDerived as Partial<TechnicalEngineParameters>)[key]
    if (val === baselineVal) {
      // 等值回退：本地覆盖字典同步删除该键，effectiveParams 自动回落基线（值相同）
      setOverrides(prev => {
        if (prev[key] === undefined) return prev
        const next = { ...prev }
        delete next[key]
        return next
      })
    } else {
      setOverrides(prev => ({ ...prev, [key]: val }))
    }
    const pending = pendingPatchRef.current ?? { patch: {}, restore: new Set() }
    if (val === baselineVal) {
      delete pending.patch[key]
      pending.restore.add(key)
    } else {
      pending.patch = { ...pending.patch, [key]: val }
      pending.restore.delete(key)
    }
    pendingPatchRef.current = pending
    if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current)
    debounceTimerRef.current = setTimeout(flushPending, 500)
  }

  // 检查当前 Tab 是否存在个性化覆盖项
  const hasBasicAiOverrides = useMemo(() => {
    return BASIC_AI_KEYS.some(k => overrides[k] !== undefined)
  }, [overrides])

  // 恢复默认：仅对本 Tab 管辖且已覆盖的键发送 restoreOverrideFields（严禁传 null）
  const handleResetToPreset = () => {
    const pending = pendingPatchRef.current ?? { patch: {}, restore: new Set() }
    for (const k of BASIC_AI_KEYS.filter(k => overrides[k] !== undefined)) {
      pending.restore.add(k)
      delete pending.patch[k]
    }
    pendingPatchRef.current = pending
    const next = { ...overrides }
    for (const k of BASIC_AI_KEYS) delete next[k]
    setOverrides(next)
    flushPending()
    toast.success(t('已恢复当前场景的基础引擎推荐参数'))
  }

  // 高级AI引擎是否开启
  const isAdvancedAiEnabled = (config?.aiServiceMode ?? 'local') !== 'disabled'
  const analysisMode = isAdvancedAiEnabled ? effectiveParams.analysisMode : 'simple'

  // 全局插件中心底座模块与活跃状态（SSOT：优先从插件中心读取当前激活的 base_embedding 模块）
  const pluginModules = usePluginCenterStore(s => s.modules)
  const activeBaseEmbeddingModule = useMemo(() => {
    return (
      pluginModules.find(
        m => m.capability_slot === 'base_embedding' && m.install_state === 'active'
      ) || null
    )
  }, [pluginModules])

  // 当前生效的基础语义检索引擎展示名
  const currentEngineDisplayName = useMemo(() => {
    if (activeBaseEmbeddingModule?.name) {
      return activeBaseEmbeddingModule.name
    }
    const globalProfile = getConfigValue<string>('AI_EMBEDDING_PROFILE')
    if (globalProfile === 'gemma_unified') {
      return t('高精度全能语义搜索')
    }
    return t('经典轻量语义搜索')
  }, [activeBaseEmbeddingModule, getConfigValue])

  // 跳转到插件中心底座分类
  const handleJumpToPlugins = useCallback(() => {
    void useSettingsStore.getState().closeWorkspaceSettings()
    void usePluginCenterStore.getState().openOverlay()
    usePluginCenterStore.getState().setSelectedCategory('ai-engine')
  }, [])

  // 全局向量检索底座（已按 D1 从工作区 BaseAIConfig 彻底剥离，仅只读消费全局槽位）
  const globalProfile = getConfigValue<'classic_light' | 'gemma_unified'>('AI_EMBEDDING_PROFILE')
  const embeddingProfile =
    (activeBaseEmbeddingModule?.id === 'engine_gemma_unified'
      ? 'gemma_unified'
      : activeBaseEmbeddingModule?.id === 'engine_classic_light'
        ? 'classic_light'
        : globalProfile) ?? 'classic_light'

  // 视频分析参数状态
  const [videoProfile, setVideoProfile] = useState<VideoAnalysisProfile>(() => {
    if (effectiveParams.videoQuotaMax <= 8) return 'fast_archive'
    if (effectiveParams.videoQuotaMax >= 80) return 'deep_footage'
    return 'balanced_search'
  })
  const [isProPanelOpen, setIsProPanelOpen] = useState(false)

  // 当外部配置（如向导更新）改变时，自动同步校准 videoProfile 档位。
  // 非等值判据：覆盖键存在但值与基线一致（v1.5 等值回退存量数据）时按基线区间推导，
  // 严禁误显「已自定义」与内核 origin 默认态自相矛盾
  useEffect(() => {
    const overrideQuota = overrides.videoQuotaMax
    const isNonBaselineOverride =
      overrideQuota !== undefined &&
      overrideQuota !== (baseDerived as Partial<TechnicalEngineParameters>).videoQuotaMax
    if (isNonBaselineOverride) {
      const matchedPreset = (['fast_archive', 'balanced_search', 'deep_footage'] as const).find(
        p => VIDEO_ANALYSIS_PRESETS[p].quotaMax === effectiveParams.videoQuotaMax
      )
      setVideoProfile(matchedPreset ?? 'custom')
    } else {
      if (effectiveParams.videoQuotaMax <= 8) setVideoProfile('fast_archive')
      else if (effectiveParams.videoQuotaMax >= 80) setVideoProfile('deep_footage')
      else setVideoProfile('balanced_search')
    }
  }, [effectiveParams.videoQuotaMax, overrides.videoQuotaMax, baseDerived])

  const videoQuotaMax = effectiveParams.videoQuotaMax ?? 32
  const videoCutSensitivity = effectiveParams.videoCutSensitivity ?? 'medium'
  const localVideoSoftTokenBudget = effectiveParams.videoSoftTokenBudget ?? 48
  const analyzeField = resolvedFields?.['videoAnalyzeDurationSec']
  const desiredAnalyzeSec = Number(
    analyzeField?.desiredValue ?? effectiveParams.videoAnalyzeDurationSec ?? 300
  )
  const videoAnalyzeDurationSec = Math.min(
    10800,
    Math.max(300, Math.round(desiredAnalyzeSec / 300) * 300)
  )
  // 用户设置值高于最终结算值（免费 5 分钟 / 硬件保守默认）时，就地提示而非禁止设置
  const analyzeEffectiveSec = Number(
    analyzeField?.effectiveValue ?? effectiveParams.videoAnalyzeDurationSec ?? 300
  )
  const isAnalyzeCapped = videoAnalyzeDurationSec > analyzeEffectiveSec
  const videoAsrCap = effectiveParams.videoAsrDurationSec ?? 30
  const audioAnalysisCap = effectiveParams.audioAnalysisDurationSec ?? 60
  // 耗时预估口径硬件分档：与 workspace-config-policy.ts footage_studio 的 hasGpuPower 判定同源
  // （真实独显或 Apple Silicon），探测缺失或纯核显时保守按纯 CPU 口径估算；
  // 注意 GPU 帧成本常数仅在 Windows DML + RTX 3060 标定，mac CoreML 口径未标定属外推
  const hasGpuPower = useMemo(
    () =>
      Boolean(
        hardwareInfo && (isDedicatedGpu(hardwareInfo) || isAppleSiliconPlatform(hardwareInfo))
      ),
    [hardwareInfo]
  )
  // 语音听写组件是否就绪：同时校验全局插件状态与目录插件开关
  const asrPluginReady = pluginModules.some(
    m => m.id === 'asr_sensevoice_onnx' && m.install_state === 'active'
  )
  const dirPluginOverrides =
    parsedConfig.status === 'ready' ? parsedConfig.pluginOverrides : undefined
  const wfPluginDefaults =
    parsedConfig.status === 'ready' ? parsedConfig.workflowPluginDefaults : undefined
  const isAsrEnabledForDir =
    dirPluginOverrides?.asr_sensevoice_onnx !== undefined
      ? dirPluginOverrides.asr_sensevoice_onnx
      : Boolean(wfPluginDefaults?.includes('asr_sensevoice_onnx'))
  const isAsrCascadedOff = !asrPluginReady || !isAsrEnabledForDir

  // 工作流基线所属档位（与 videoProfile 推导同区间逻辑，但以纯基线 baseDerived 为准、不含用户覆盖）。
  // 三档全局预设 (VIDEO_ANALYSIS_PRESETS) 与工作流个性化基线可能不一致（如基线 quotaMax=16 落在
  // 9~79 区间被推导为「均衡搜索」，但 balanced 预设 quotaMax=60），切回基线档必须恢复工作流基线
  // 而非写入全局预设值，否则会残留「用户自定义」覆盖键（等值回退语义）。
  const baselineVideoProfile = useMemo<VideoAnalysisProfile>(() => {
    const baselineQuota = (baseDerived as Partial<TechnicalEngineParameters>).videoQuotaMax ?? 32
    if (baselineQuota <= 8) return 'fast_archive'
    if (baselineQuota >= 80) return 'deep_footage'
    return 'balanced_search'
  }, [baseDerived])

  const handleSelectVideoProfile = (profile: VideoAnalysisProfile) => {
    if (profile === 'custom') {
      setVideoProfile('custom')
      return
    }
    setVideoProfile(profile)
    if (profile === baselineVideoProfile) {
      // 切回工作流基线所属档位：整组恢复工作流基线值（经等值回退通道自动精确删键归默认态），
      // 严禁写入全局预设值造成「用户自定义」残留
      const baseline = baseDerived as Partial<TechnicalEngineParameters>
      handleParamChange('videoQuotaMax', baseline.videoQuotaMax as number)
      handleParamChange('videoCutSensitivity', baseline.videoCutSensitivity as VideoCutSensitivity)
      handleParamChange('videoSoftTokenBudget', baseline.videoSoftTokenBudget as 48 | 140)
      handleParamChange('videoAnalyzeDurationSec', baseline.videoAnalyzeDurationSec as number)
      handleParamChange('videoAsrDurationSec', baseline.videoAsrDurationSec as number)
      captureEvent('切换视频分析预设档位', { profile, restoredBaseline: true })
      return
    }
    const preset = VIDEO_ANALYSIS_PRESETS[profile]
    handleParamChange('videoQuotaMax', preset.quotaMax)
    handleParamChange('videoCutSensitivity', preset.cutSensitivity)
    handleParamChange('videoSoftTokenBudget', preset.softTokenBudget as 48 | 140)
    handleParamChange('videoAsrDurationSec', preset.asrDurationSec)
    captureEvent('切换视频分析预设档位', { profile })
  }

  const handleCustomParamChange = (params: {
    quotaMax?: number
    cutSensitivity?: VideoCutSensitivity
    softTokenBudget?: 48 | 140
    asrCap?: number
  }) => {
    setVideoProfile('custom')
    if (params.quotaMax !== undefined) handleParamChange('videoQuotaMax', params.quotaMax)
    if (params.cutSensitivity !== undefined)
      handleParamChange('videoCutSensitivity', params.cutSensitivity)
    if (params.softTokenBudget !== undefined)
      handleParamChange('videoSoftTokenBudget', params.softTokenBudget)
    if (params.asrCap !== undefined) handleParamChange('videoAsrDurationSec', params.asrCap)
    captureEvent('自定义视频分析高级参数', params)
  }

  // 视觉语义搜索与索引重建看板
  const clipTextEnabled =
    effectiveParams.clipTextEnabled ??
    getConfigValue<boolean>('AI_CLIP_TEXT_SEARCH_ENABLED') ??
    true
  const [rebuildCounts, setRebuildCounts] = useState<{
    pending: number
    ready: number
    visualOnly: number
    skipped: number
    failed: number
    uncomputed: number
    lastMaintenance: { reason: string; at: number; invalidated: number; requeued: number } | null
  } | null>(null)
  const [rebuildError, setRebuildError] = useState<string | null>(null)
  const [isRebuilding, setIsRebuilding] = useState(false)
  const rebuildLoadedRef = useRef(false)

  useEffect(() => {
    if (rebuildLoadedRef.current) return
    rebuildLoadedRef.current = true
    let cancelled = false
    window.electronAPI
      ?.getCanonicalRebuildCounts?.()
      .then(counts => {
        if (cancelled) return
        if (counts) {
          setRebuildCounts(counts)
          setRebuildError(null)
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setRebuildError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 硬件自适应推荐状态
  const [recommendedSettings, setRecommendedSettings] = useState<{
    profile: 'classic_light' | 'gemma_unified'
    mrlDimension: 256 | 512 | 768
    videoFrameIntervalSeconds: number
    videoSoftTokenBudget: number
  } | null>(null)
  const recommendationCheckedRef = useRef(false)

  useEffect(() => {
    if (recommendationCheckedRef.current) return
    recommendationCheckedRef.current = true

    window.electronAPI
      ?.getRecommendedEmbeddingSettings?.()
      .then((rec: any) => {
        if (rec) {
          setRecommendedSettings(rec)
        }
      })
      .catch(err => {
        console.warn('[BasicAIEngineTab] 获取推荐底座设置失败:', err)
      })
  }, [])

  const handleRestoreSingleField = useCallback(
    async (fieldKey: keyof BaseAIConfig) => {
      if (workspace.id == null) return
      // 防抖竞态防护：先冲刷 500ms 防抖队列（窗口内 pending.patch 同键旧值先落盘），
      // 再发本次 restore（后到 delete 胜出），杜绝 flush 后 patch 静默写回撤销恢复
      flushPending()
      const res = await submitWorkspacePolicyMutation(workspace.id, {
        restoreOverrideFields: [fieldKey]
      })
      if (res.success) {
        setOverrides(prev => {
          const next = { ...prev }
          delete next[fieldKey]
          return next
        })
        onConfigSaved?.()
      } else {
        toast.error(getMutationErrorText(res, t('恢复默认失败')))
      }
    },
    [workspace.id, onConfigSaved, flushPending]
  )

  return (
    <div className="p-6 space-y-6 max-w-4xl mx-auto overflow-y-auto max-h-full">
      {/* 头部标题与场景概览 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-border/60">
        <div>
          <h3 className="text-lg font-bold flex items-center gap-2">
            <Sliders className="w-5 h-5 text-primary" />
            <span>{t('检索式引擎')}</span>
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('当前配置：{name}。配置分析模式、视频取帧与语音听写参数。', {
              name:
                parsedConfig.status === 'ready' && parsedConfig.workflowId
                  ? (parsedConfig as unknown as { workflowName?: string }).workflowName ||
                    getIntentDisplayName(currentIntent)
                  : t('默认配置')
            })}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* 自动保存状态指示 */}
          {isSaving ? (
            <span className="text-xs text-muted-foreground flex items-center gap-1.5 animate-pulse">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
              <span>{t('正在自动保存...')}</span>
            </span>
          ) : (
            <span className="text-xs text-muted-foreground/80 flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
              <span>{t('已自动保存')}</span>
            </span>
          )}

          {/* 恢复默认按钮 (仅在存在本Tab微调项时展示) */}
          {hasBasicAiOverrides && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleResetToPreset}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1.5 h-8"
              title={t('清除所有微调项，恢复为默认值')}
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>
                {parsedConfig.status === 'ready' && parsedConfig.workflowId
                  ? t('恢复工作流默认')
                  : t('恢复全局默认')}
              </span>
            </Button>
          )}
        </div>
      </div>

      {/* SLICE-08 + v1.5：本 Tab 专管 AI 参数的三态反馈
          - 用户自定义 && 正常生效项 → 设置值四态表格（逐行标明参数项 + 全局默认/工作流默认/用户自定义值/最终结算值对照）
          - 环境降级 / 级联关闭等态 → 保持 TriStateFieldFeedback 单项反馈 */}
      {resolvedFields && (
        <div className="space-y-1.5">
          <TriStateCustomFieldsTable
            rows={BASIC_AI_KEYS.reduce<TriStateCustomFieldRow[]>((acc, fieldKey) => {
              const field = resolvedFields[fieldKey]
              if (!field || !field.visible) return acc
              if (field.origin !== 'user_custom' || field.applicability !== 'active') return acc
              acc.push({
                key: String(fieldKey),
                label: getBasicAiFieldLabel(fieldKey),
                globalDefaultText: formatTriStateCellValue(
                  fieldKey,
                  DEFAULT_UNBOUND_AI_CONFIG[fieldKey]
                ),
                workflowDefaultText: hasBoundWorkflow
                  ? formatTriStateCellValue(fieldKey, baseDerived[fieldKey])
                  : undefined,
                customText: formatTriStateCellValue(fieldKey, field.desiredValue),
                finalText: formatTriStateCellValue(fieldKey, field.effectiveValue)
              })
              return acc
            }, [])}
            hasBoundWorkflow={hasBoundWorkflow}
            onRestore={fieldKey => void handleRestoreSingleField(fieldKey as keyof BaseAIConfig)}
          />
          {BASIC_AI_KEYS.map(fieldKey => {
            const field = resolvedFields[fieldKey]
            if (!field || !field.visible) return null
            // 默认正常态零冗余；user_custom && active 已收归上方设置值四态表格；
            // cascaded_off / pending 属具体控件位置语义（如 ASR 双时长同因级联），
            // 由「语音听写与音视频台词提取」卡片内渲染一次，严禁在顶部逐字段重复罗列
            if (field.applicability !== 'degraded') return null
            return (
              <TriStateFieldFeedback
                key={fieldKey}
                field={field}
                effectiveText={formatTriStateCellValue(fieldKey, field.effectiveValue)}
                desiredText={formatTriStateCellValue(fieldKey, field.desiredValue)}
                baselineText={formatTriStateCellValue(fieldKey, baseDerived[fieldKey])}
                hasBoundWorkflow={hasBoundWorkflow}
                onRestore={() => void handleRestoreSingleField(fieldKey)}
                onFixAction={onFixAction}
              />
            )
          })}
        </div>
      )}

      {/* 1. 选择分析模式 */}
      <Card className="p-5">
        <div className="space-y-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Gauge className="h-4 w-4" />
            </div>
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              <Label className="text-base font-semibold leading-none">{t('选择分析模式')}</Label>
              <HelpTooltip
                content={t(
                  '根据需求选择不同模式，全面分析耗时最长但精度最高；标准分析最快。增强分析与全面分析需开启生成式引擎。'
                )}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* 标准分析 */}
            <div
              onClick={() => handleParamChange('analysisMode', 'simple')}
              className={cn(
                'relative overflow-hidden flex flex-col p-4 rounded-xl border-2 cursor-pointer transition-all',
                analysisMode === 'simple'
                  ? 'border-primary bg-primary/10 shadow-xs ring-1 ring-primary/20'
                  : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
              )}
            >
              <div className="absolute top-0 right-0 text-[11px] font-semibold bg-muted text-muted-foreground px-2.5 py-0.5 rounded-bl-md">
                {t('极速')}
              </div>
              {analysisMode === 'simple' && (
                <div className="absolute bottom-2.5 right-2.5 w-5 h-5 rounded-full bg-primary flex items-center justify-center shadow-xs">
                  <Check className="h-3 w-3 text-primary-foreground stroke-[2.5]" />
                </div>
              )}
              <div className="flex items-center justify-between pr-8">
                <span
                  className={cn(
                    'font-semibold text-sm',
                    analysisMode === 'simple' && 'text-primary'
                  )}
                >
                  {t('标准分析')}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                {t('基于检索式引擎高速获取文件标签、智能文件名和摘要')}
              </p>
            </div>

            {/* 增强分析 */}
            <div
              onClick={() => {
                if (!isAdvancedAiEnabled) return
                handleParamChange('analysisMode', 'quick_name')
              }}
              className={cn(
                'relative overflow-hidden flex flex-col p-4 rounded-xl border-2 transition-all',
                !isAdvancedAiEnabled
                  ? 'border-border bg-muted/20 opacity-60 cursor-not-allowed'
                  : analysisMode === 'quick_name'
                    ? 'border-primary bg-primary/10 shadow-xs ring-1 ring-primary/20 cursor-pointer'
                    : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30 cursor-pointer'
              )}
            >
              <div className="absolute top-0 right-0 text-[11px] font-semibold bg-muted text-muted-foreground px-2.5 py-0.5 rounded-bl-md">
                {t('平衡')}
              </div>
              {isAdvancedAiEnabled && analysisMode === 'quick_name' && (
                <div className="absolute bottom-2.5 right-2.5 w-5 h-5 rounded-full bg-primary flex items-center justify-center shadow-xs">
                  <Check className="h-3 w-3 text-primary-foreground stroke-[2.5]" />
                </div>
              )}
              <div className="flex items-center justify-between pr-8">
                <span
                  className={cn(
                    'font-semibold text-sm',
                    isAdvancedAiEnabled && analysisMode === 'quick_name' && 'text-primary'
                  )}
                >
                  {t('增强分析')}
                </span>
                {!isAdvancedAiEnabled && (
                  <Lock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                {t('【标准分析】+ 生成式引擎润色智能文件名和描述以及补充标签')}
              </p>
              {!isAdvancedAiEnabled && (
                <div className="flex items-center gap-1.5 mt-2.5 text-xs text-amber-600 dark:text-amber-400">
                  <Lock className="h-3 w-3 shrink-0" />
                  <span className="font-medium">{t('需在系统设置开启生成式引擎')}</span>
                </div>
              )}
            </div>

            {/* 全面分析 */}
            <div
              onClick={() => {
                if (!isAdvancedAiEnabled) return
                handleParamChange('analysisMode', 'full')
              }}
              className={cn(
                'relative overflow-hidden flex flex-col p-4 rounded-xl border-2 transition-all',
                !isAdvancedAiEnabled
                  ? 'border-border bg-muted/20 opacity-60 cursor-not-allowed'
                  : analysisMode === 'full'
                    ? 'border-primary bg-primary/10 shadow-xs ring-1 ring-primary/20 cursor-pointer'
                    : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30 cursor-pointer'
              )}
            >
              <div className="absolute top-0 right-0 text-[11px] font-semibold bg-green-500 text-white px-2.5 py-0.5 rounded-bl-md shadow-xs dark:bg-green-600">
                {t('推荐')}
              </div>
              {isAdvancedAiEnabled && analysisMode === 'full' && (
                <div className="absolute bottom-2.5 right-2.5 w-5 h-5 rounded-full bg-primary flex items-center justify-center shadow-xs">
                  <Check className="h-3 w-3 text-primary-foreground stroke-[2.5]" />
                </div>
              )}
              <div className="flex items-center justify-between pr-8">
                <span
                  className={cn(
                    'font-semibold text-sm',
                    isAdvancedAiEnabled && analysisMode === 'full' && 'text-primary'
                  )}
                >
                  {t('全面分析')}
                </span>
                {!isAdvancedAiEnabled && (
                  <Lock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                {t('【增强分析】+ 全面AI分析，包含质量评分与详细图片、音频内容描述等以及更多标签')}
              </p>
              {!isAdvancedAiEnabled && (
                <div className="flex items-center gap-1.5 mt-2.5 text-xs text-amber-600 dark:text-amber-400">
                  <Lock className="h-3 w-3 shrink-0" />
                  <span className="font-medium">{t('需在系统设置开启生成式引擎')}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </Card>

      {/* 2. 基础语义检索引擎 */}
      <Card className="p-5 border-border/80 bg-card/60 shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Layers className="h-5 w-5" />
            </div>
            <div className="space-y-0.5 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">
                  {t('当前基础语义检索引擎')}：
                </span>
                <span className="text-sm font-bold text-primary truncate">
                  {currentEngineDisplayName}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                {t('语义索引由全系统统一底座驱动，可在插件中心自由安装或切换其他官方及社区底座。')}
              </p>
            </div>
          </div>

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleJumpToPlugins}
            className="shrink-0 flex items-center gap-1.5 self-start sm:self-auto"
          >
            <span>{t('切换')}</span>
            <ChevronRight className="w-3.5 h-3.5" />
          </Button>
        </div>
      </Card>

      {/* 3. 视频画面分析与检索模式 (仅在 gemma_unified 全模态模式展示，classic_light 极速轻量档隐藏) */}
      {embeddingProfile === 'gemma_unified' && (
        <Card className="p-5">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <Label className="text-sm font-semibold text-foreground">
                  {t('视频画面分析与检索模式')}
                </Label>
                <HelpTooltip
                  content={t(
                    '决定文件首次导入整理时的分析速度，以及在搜索栏中能否精确搜到视频中间“一闪而过”的具体画面。搜索响应永远是毫秒级瞬时完成。'
                  )}
                />
              </div>
              {videoProfile === 'custom' && (
                <span className="text-[11px] font-semibold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded-full">
                  {t('已自定义')}
                </span>
              )}
            </div>

            {/* 价值标尺行 */}
            <div className="p-3 rounded-xl border border-primary/20 bg-primary/5 flex items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-2.5">
                <span className="text-base">⏱️</span>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-foreground">
                      {t('画面深度分析覆盖范围')}
                    </span>
                    <span className="px-2 py-0.2 rounded-full font-medium bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20 text-[10px]">
                      {t('短视频满血支持 (前 5 分钟)')}
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5">
                    {t(
                      '免费版享有高清与防漏检满血能力。超过 5 分钟的长视频优先覆盖前段，升级 Pro 可解锁整片深度分析。'
                    )}
                  </p>
                </div>
              </div>
            </div>

            {/* 三档大白话场景卡片 */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {/* 档位 1: 极速归档 */}
              <div
                onClick={() => handleSelectVideoProfile('fast_archive')}
                className={cn(
                  'relative overflow-hidden flex flex-col justify-between p-3.5 rounded-xl border-2 cursor-pointer transition-all',
                  videoProfile === 'fast_archive'
                    ? 'border-primary bg-primary/10 shadow-xs ring-1 ring-primary/20'
                    : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
                )}
              >
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-sm text-foreground flex items-center gap-1.5">
                      ⚡ {t('极速归档')}
                    </span>
                    <span className="text-[11px] font-mono font-semibold px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-600">
                      {t('分析 3~5 秒/片')}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {t('仅提取智能文件名与分类标签，仅抓 8 张定格画面，不占算力。')}
                  </p>
                </div>
              </div>

              {/* 档位 2: 均衡搜索 */}
              <div
                onClick={() => handleSelectVideoProfile('balanced_search')}
                className={cn(
                  'relative overflow-hidden flex flex-col justify-between p-3.5 rounded-xl border-2 cursor-pointer transition-all',
                  videoProfile === 'balanced_search'
                    ? 'border-primary bg-primary/10 shadow-xs ring-1 ring-primary/20'
                    : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
                )}
              >
                <div className="absolute top-0 right-0 text-[10px] font-semibold bg-primary text-primary-foreground px-2 py-0.5 rounded-bl-md shadow-xs">
                  {t('日常推荐')}
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between pr-12">
                    <span className="font-bold text-sm text-foreground flex items-center gap-1.5">
                      ⚖️ {t('均衡搜索')}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {t('可搜常规画面，均匀抓取关键帧并提取台词，分析约 15~25 秒/片。')}
                  </p>
                </div>
              </div>

              {/* 档位 3: 深度寻帧 */}
              <div
                onClick={() => handleSelectVideoProfile('deep_footage')}
                className={cn(
                  'relative overflow-hidden flex flex-col justify-between p-3.5 rounded-xl border-2 cursor-pointer transition-all',
                  videoProfile === 'deep_footage'
                    ? 'border-amber-500 bg-amber-500/10 shadow-xs ring-1 ring-amber-500/20'
                    : 'border-border bg-card hover:border-amber-400 hover:bg-muted/30'
                )}
              >
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-sm text-foreground flex items-center gap-1.5">
                      🔍 {t('深度寻帧')}
                    </span>
                    <span className="text-[11px] font-mono font-semibold px-2 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400">
                      {t('分析 40~60 秒/片')}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {t('转场防漏检保护，逐镜头高清扫描与特写捕捉，专业剪辑素材必备。')}
                  </p>
                </div>
              </div>
            </div>

            {/* 折叠的高级微调面板 */}
            <div
              className={cn(
                'border rounded-xl overflow-hidden bg-card transition-all duration-200',
                isProPanelOpen
                  ? 'border-primary/40 shadow-xs ring-1 ring-primary/10'
                  : 'border-border/80 hover:border-primary/50 hover:bg-muted/10'
              )}
            >
              <div
                onClick={() => setIsProPanelOpen(!isProPanelOpen)}
                className="group flex items-center justify-between p-4 cursor-pointer select-none transition-colors"
              >
                {/* 左侧：醒目图标 + 标题 + 当前关键值摘要 */}
                <div className="flex items-center gap-3 min-w-0">
                  <div
                    className={cn(
                      'w-8 h-8 rounded-lg flex items-center justify-center shrink-0 transition-colors',
                      isProPanelOpen
                        ? 'bg-primary text-primary-foreground shadow-xs'
                        : 'bg-primary/10 text-primary group-hover:bg-primary/20'
                    )}
                  >
                    <Sliders className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-bold text-foreground group-hover:text-primary transition-colors">
                        {t('高级参数微调')}
                      </span>
                      {videoProfile === 'custom' ? (
                        <span className="text-[10px] bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 font-semibold px-2 py-0.5 rounded-full">
                          {t('已自定义')}
                        </span>
                      ) : (
                        <span className="text-[10px] bg-muted text-muted-foreground border border-border/60 font-medium px-2 py-0.5 rounded-full">
                          {t('跟随档位推荐')}
                        </span>
                      )}
                    </div>
                    {/* 收起时显示当前参数摘要，展开时显示指引说明 */}
                    <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
                      <span>
                        {t('抓图 {quota} 张 · {sens} · 台词 {asr}s', {
                          quota: videoQuotaMax,
                          sens:
                            videoCutSensitivity === 'low'
                              ? t('常规')
                              : videoCutSensitivity === 'medium'
                                ? t('灵敏')
                                : t('极高'),
                          asr: videoAsrCap
                        })}
                      </span>
                      <span className="text-muted-foreground/40 hidden sm:inline">|</span>
                      <span className="text-[11px] text-muted-foreground/80 hidden sm:inline">
                        {t('点击展开自由调优')}
                      </span>
                    </div>
                  </div>
                </div>

                {/* 右侧：操作区与清晰醒目的展开/收起药丸胶囊 */}
                <div className="flex items-center gap-3 shrink-0">
                  {videoProfile === 'custom' && (
                    <button
                      type="button"
                      onClick={e => {
                        e.stopPropagation()
                        // 「恢复默认」= 切回工作流基线所属档位（整组恢复基线值归默认态），
                        // 严禁硬编码 balanced_search 造成基线为其它档位的工作流残留覆盖
                        handleSelectVideoProfile(baselineVideoProfile)
                      }}
                      className="text-xs text-muted-foreground hover:text-primary hover:underline flex items-center gap-1 cursor-pointer transition-colors"
                    >
                      <RotateCcw className="h-3 w-3" />
                      <span>{hasBoundWorkflow ? t('恢复工作流默认') : t('恢复全局默认')}</span>
                    </button>
                  )}
                  {/* 显眼的展开/收起药丸胶囊 */}
                  <div
                    className={cn(
                      'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all shadow-2xs',
                      isProPanelOpen
                        ? 'bg-muted/80 text-foreground border-border'
                        : 'bg-primary/10 text-primary border-primary/20 group-hover:bg-primary group-hover:text-primary-foreground'
                    )}
                  >
                    <span>{isProPanelOpen ? t('收起微调') : t('展开微调')}</span>
                    {isProPanelOpen ? (
                      <ChevronDown className="h-3.5 w-3.5" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5" />
                    )}
                  </div>
                </div>
              </div>

              {isProPanelOpen && (
                <div className="p-4 space-y-4 border-t border-border/40">
                  {/* 单视频最大抓图数量 */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <Label className="font-semibold text-foreground">
                        {t('单视频最大抓图数量')}
                      </Label>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono font-bold bg-muted px-2 py-0.5 rounded text-primary">
                          {videoQuotaMax} {t('张')}
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          {t('(日常推荐 40~60 张，精细找素材可调至 120~240 张)')}
                        </span>
                      </div>
                    </div>
                    <input
                      type="range"
                      min={8}
                      max={240}
                      value={videoQuotaMax}
                      onChange={e =>
                        handleCustomParamChange({ quotaMax: parseInt(e.target.value, 10) })
                      }
                      className="w-full accent-primary cursor-pointer"
                    />
                    <p className="text-[11px] text-muted-foreground">
                      {t(
                        '单个视频最多提取多少张关键画面送入 AI 理解。抓图越多，长视频里的细碎镜头越不容易漏，但首次整理分析耗时会相应增加。'
                      )}
                    </p>
                  </div>

                  {/* 镜头切换敏锐度 */}
                  <div className="space-y-1.5 pt-2 border-t border-border/30">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs font-semibold text-foreground">
                        {t('镜头切换捕捉敏锐度')}
                      </Label>
                      <span className="text-xs font-semibold text-primary">
                        {videoCutSensitivity === 'low' && t('常规')}
                        {videoCutSensitivity === 'medium' && t('灵敏 (推荐)')}
                        {videoCutSensitivity === 'high' && t('极高 (防吞噬)')}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                      {(['low', 'medium', 'high'] as const).map(sens => (
                        <button
                          key={sens}
                          type="button"
                          onClick={() => handleCustomParamChange({ cutSensitivity: sens })}
                          className={cn(
                            'p-2 rounded-lg border text-xs font-medium text-left transition-all cursor-pointer',
                            videoCutSensitivity === sens
                              ? 'border-primary bg-primary/10'
                              : 'border-border hover:border-primary/40'
                          )}
                        >
                          <div className="font-bold">
                            {sens === 'low'
                              ? t('常规')
                              : sens === 'medium'
                                ? t('灵敏 (推荐)')
                                : t('极高 (防吞噬)')}
                          </div>
                          <div className="text-[10px] text-muted-foreground mt-0.5">
                            {sens === 'low'
                              ? t('仅抓取全片核心大场景')
                              : sens === 'medium'
                                ? t('标准分段挑选代表画面')
                                : t('救回 1.6 秒瞬态跑车特写')}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 画面识别精细度 */}
                  <div className="space-y-1.5 pt-2 border-t border-border/30">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs font-semibold text-foreground">
                        {t('画面识别精细度')}
                      </Label>
                      <span className="text-xs font-semibold text-primary">
                        {localVideoSoftTokenBudget <= 48 ? t('流畅极速') : t('高清精细')}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        onClick={() => handleCustomParamChange({ softTokenBudget: 48 })}
                        className={cn(
                          'p-2.5 rounded-lg border text-xs font-medium text-left transition-all cursor-pointer',
                          localVideoSoftTokenBudget <= 48
                            ? 'border-primary bg-primary/10'
                            : 'border-border hover:border-primary/40'
                        )}
                      >
                        <div className="font-bold text-primary">{t('流畅极速')}</div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {t('整理分析速度翻倍，适合批量整理与轻薄本')}
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => handleCustomParamChange({ softTokenBudget: 140 })}
                        className={cn(
                          'p-2.5 rounded-lg border text-xs font-medium text-left transition-all cursor-pointer',
                          localVideoSoftTokenBudget > 48
                            ? 'border-primary bg-primary/10'
                            : 'border-border hover:border-primary/40'
                        )}
                      >
                        <div className="font-bold">{t('高清精细')}</div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {t('主体与微小细节识别更准，建议独立显卡开启')}
                        </div>
                      </button>
                    </div>
                  </div>

                  {/* 语音听写与音视频台词提取（仅受语音组件联动，与引擎档位无关） */}
                  <div className="pt-2 border-t border-border/30 space-y-4">
                    <div className="flex items-center gap-2">
                      <Mic className="h-4 w-4 text-primary shrink-0" />
                      <Label className="text-sm font-medium text-foreground">
                        {t('语音听写与音视频台词提取')}
                      </Label>
                    </div>
                    {(() => {
                      const asrField = resolvedFields?.['videoAsrDurationSec']
                      if (
                        !asrField ||
                        asrField.visible === false ||
                        (asrField.applicability !== 'cascaded_off' &&
                          asrField.applicability !== 'pending')
                      ) {
                        return null
                      }
                      return (
                        <TriStateFieldFeedback
                          field={asrField}
                          effectiveText={formatTriStateCellValue(
                            'videoAsrDurationSec',
                            asrField.effectiveValue
                          )}
                          desiredText={formatTriStateCellValue(
                            'videoAsrDurationSec',
                            asrField.desiredValue
                          )}
                          hasBoundWorkflow={hasBoundWorkflow}
                          onFixAction={onFixAction}
                        />
                      )
                    })()}
                    <div className={cn('space-y-4', isAsrCascadedOff && 'opacity-50')}>
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between text-xs">
                          <Label className="font-semibold text-foreground">
                            {t('视频伴音台词识别上限')}
                          </Label>
                          <span className="font-mono font-bold bg-muted px-2 py-0.5 rounded text-primary">
                            {videoAsrCap} {t('秒')}
                          </span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={180}
                          step={15}
                          value={videoAsrCap}
                          onChange={e =>
                            handleParamChange('videoAsrDurationSec', parseInt(e.target.value, 10))
                          }
                          className="w-full accent-primary cursor-pointer"
                        />
                        <p className="text-[11px] text-muted-foreground">
                          {t(
                            '仅提取视频开头前 N 秒的音轨台词（不影响纯音频）。识别越长台词标签越全，分析耗时稍长。'
                          )}
                        </p>
                      </div>
                      <div className="space-y-1.5 pt-2 border-t border-border/30">
                        <div className="flex items-center justify-between text-xs">
                          <Label className="font-semibold text-foreground">
                            {t('纯音频听写时长上限')}
                          </Label>
                          <span className="font-mono font-bold bg-muted px-2 py-0.5 rounded text-primary">
                            {audioAnalysisCap} {t('秒')}
                          </span>
                        </div>
                        <input
                          type="range"
                          min={0}
                          max={180}
                          step={15}
                          value={audioAnalysisCap}
                          onChange={e =>
                            handleParamChange(
                              'audioAnalysisDurationSec',
                              parseInt(e.target.value, 10)
                            )
                          }
                          className="w-full accent-primary cursor-pointer"
                        />
                        <p className="text-[11px] text-muted-foreground">
                          {t('仅听写音频文件开头前 N 秒的内容，设为 0 则不听写。')}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* 实时整理分析耗时预估图形化卡片（以每 5 分钟片段为绝对标尺测算，紧随参数调优之后呈现反馈） */}
            {(() => {
              const est = estimateVideoAnalysisDurationSec(
                videoQuotaMax,
                localVideoSoftTokenBudget,
                videoAsrCap,
                hasGpuPower,
                300
              )
              const totalMins = (est.totalSec / 60).toFixed(1)
              const fillWidthPct = Math.min(
                100,
                Math.max(3, Math.round((est.perChunkSec / 300) * 100))
              )
              // 整片口径：严格按「每个视频分析时长上限」滑块的 UI 值估算，结算差异由滑块下方提示单独说明
              const fullEst = estimateVideoAnalysisDurationSec(
                videoQuotaMax,
                localVideoSoftTokenBudget,
                videoAsrCap,
                hasGpuPower,
                videoAnalyzeDurationSec
              )
              const fullMins = (fullEst.totalSec / 60).toFixed(1)
              const fullVideoMins = Math.round(videoAnalyzeDurationSec / 60)
              // 固定 3 小时绝对标尺：填充长度随估算耗时变化，避免用「耗时/整片时长」比值导致拖动时恒定
              const fullScaleSec = 10800
              const fullFillPct = Math.min(
                100,
                Math.max(3, Math.round((fullEst.totalSec / fullScaleSec) * 100))
              )
              const fullMarkPct = Math.min(
                100,
                Math.max(0, Math.round((videoAnalyzeDurationSec / fullScaleSec) * 100))
              )

              return (
                <div className="p-4 rounded-xl bg-card border border-border shadow-xs space-y-3">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-base">⚡</span>
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-bold text-foreground">
                            {t('单视频首次整理耗时预估')}
                          </span>
                          <span className="text-[10px] px-2 py-0.2 rounded-full font-medium bg-primary/10 text-primary border border-primary/20">
                            {t('以每 5 分钟视频分析基准测算')}
                          </span>
                        </div>
                        <p className="text-[11px] text-muted-foreground mt-0.5">
                          {t('耗时仅在首次整理时发生一次；搜索时均为毫秒级瞬发。')}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-extrabold font-mono text-primary">
                        {est.minSec} ~ {est.maxSec} {t('秒')}
                      </span>
                      {est.totalSec >= 60 && (
                        <span className="text-[11px] text-muted-foreground font-mono">
                          ({t('约 {min} 分钟', { min: totalMins })})
                        </span>
                      )}
                      {est.speedTier === 'blazing' && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                          ⚡ {t('极速飞快 (约 {speed}x 实时处理)', { speed: est.speedMultiplier })}
                        </span>
                      )}
                      {est.speedTier === 'balanced' && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-sky-500/10 text-sky-600 dark:text-sky-400 border border-sky-500/20">
                          ⚖️ {t('平衡适中 (约 {speed}x 实时处理)', { speed: est.speedMultiplier })}
                        </span>
                      )}
                      {est.speedTier === 'deep' && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20">
                          🔍 {t('深度精细 (约 {speed}x 实时处理)', { speed: est.speedMultiplier })}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* 全局绝对标尺刻度轨道 */}
                  <div className="space-y-1.5">
                    <div className="h-3 w-full bg-muted/60 rounded-full overflow-hidden flex relative p-0.5 border border-border/40">
                      <div
                        style={{ width: `${fillWidthPct}%` }}
                        className="h-full rounded-full overflow-hidden flex gap-0.5 transition-all duration-300"
                      >
                        <div
                          style={{ width: `${est.visualPct}%` }}
                          className="h-full bg-primary rounded-l-full transition-all duration-300"
                          title={t('画面 AI 理解')}
                        />
                        <div
                          style={{ width: `${est.asrPct}%` }}
                          className="h-full bg-emerald-500 transition-all duration-300"
                          title={t('台词语音识别')}
                        />
                        <div
                          style={{ width: `${est.fixedPct}%` }}
                          className="h-full bg-muted-foreground/30 rounded-r-full transition-all duration-300"
                          title={t('基础解包与索引')}
                        />
                      </div>
                    </div>

                    {/* 实时线与刻度标尺 */}
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground/70 px-0.5 font-mono">
                      <span>0s</span>
                      <span>60s</span>
                      <span>150s</span>
                      <span className="text-primary/80 font-medium">{t('5 分钟参考线')}</span>
                    </div>

                    {/* 细分耗时图例与百分比 */}
                    <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-0.5 flex-wrap gap-2">
                      <div className="flex items-center gap-3">
                        <span className="flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-primary inline-block" />
                          <span>
                            {t('画面 AI 理解')}:{' '}
                            <strong className="text-foreground">~{est.visualSec}s</strong> (
                            {videoQuotaMax}
                            {t('张')})
                          </span>
                        </span>
                        <span className="flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
                          <span>
                            {t('台词识别')}:{' '}
                            <strong className="text-foreground">~{est.asrSec}s</strong> (
                            {videoAsrCap}s{t('音轨')})
                          </span>
                        </span>
                        <span className="flex items-center gap-1.5">
                          <span className="w-2 h-2 rounded-full bg-muted-foreground/40 inline-block" />
                          <span>
                            {t('基础开销')}:{' '}
                            <strong className="text-foreground">~{est.fixedSec}s</strong>
                          </span>
                        </span>
                      </div>
                      <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold">
                        ⚡ {t('搜索时毫秒级瞬发响应')}
                      </span>
                    </div>
                  </div>

                  {/* 纯 CPU 口径深度档慢于实时播放时的贴心提示 */}
                  {est.perChunkSec >= 300 && (
                    <div className="p-2.5 rounded-lg bg-purple-500/10 border border-purple-500/20 text-xs text-purple-700 dark:text-purple-300 flex items-center gap-2">
                      <span>💡</span>
                      <span>
                        {t(
                          '这个档位对电脑算力要求高：普通轻薄本整理会比视频播放更慢，建议放后台慢慢整理；有独立显卡的电脑大约能快 2~3 倍，多数情况能比实时播放更快完成（具体快多少因显卡型号而异）。'
                        )}
                      </span>
                    </div>
                  )}

                  {/* 整片口径耗时条：所有用户可见，随「每个视频分析时长上限」动态变化 */}
                  <div className="space-y-1.5 pt-2 border-t border-border/30">
                    <div className="flex items-center justify-between gap-2 flex-wrap text-xs">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] px-2 py-0.2 rounded-full font-medium bg-sky-500/10 text-sky-600 dark:text-sky-400 border border-sky-500/20">
                          {t('按整片时长测算')}
                        </span>
                        <span className="text-muted-foreground">
                          {t('上限 {mins} 分钟', { mins: fullVideoMins })}
                        </span>
                      </div>
                      <span className="text-sm font-extrabold font-mono text-primary">
                        {fullEst.minSec} ~ {fullEst.maxSec} {t('秒')}
                        <span className="ml-1 text-[11px] text-muted-foreground font-mono">
                          ({t('约 {min} 分钟', { min: fullMins })})
                        </span>
                      </span>
                    </div>
                    <div className="relative h-2.5 w-full bg-muted/60 rounded-full flex p-0.5 border border-border/40">
                      <div
                        style={{ width: `${fullFillPct}%` }}
                        className="h-full rounded-full overflow-hidden flex gap-0.5 transition-all duration-300"
                      >
                        <div
                          style={{ width: `${fullEst.visualPct}%` }}
                          className="h-full bg-primary rounded-l-full transition-all duration-300"
                          title={t('画面 AI 理解')}
                        />
                        <div
                          style={{ width: `${fullEst.asrPct}%` }}
                          className="h-full bg-emerald-500 transition-all duration-300"
                          title={t('台词语音识别')}
                        />
                        <div
                          style={{ width: `${fullEst.fixedPct}%` }}
                          className="h-full bg-muted-foreground/30 rounded-r-full transition-all duration-300"
                          title={t('基础解包与索引')}
                        />
                      </div>
                      <span
                        style={{ left: `${fullMarkPct}%` }}
                        className="absolute -top-0.5 h-3.5 w-0.5 bg-sky-500 rounded-full transition-all duration-300"
                        title={t('整片 {mins} 分钟参考线', { mins: fullVideoMins })}
                      />
                    </div>
                    <div className="flex items-center justify-between text-[10px] text-muted-foreground/70 px-0.5 font-mono">
                      <span>0</span>
                      <span>{t('1 小时')}</span>
                      <span>{t('2 小时')}</span>
                      <span className="text-sky-500/80 font-medium">
                        {t('整片 {mins} 分钟参考线', { mins: fullVideoMins })}
                      </span>
                    </div>
                  </div>

                  {/* 每个视频分析时长上限：所有用户可调，免费用户最终按 5 分钟结算 */}
                  <div className="space-y-1.5 pt-2 border-t border-border/30">
                    <div className="flex items-center justify-between text-xs">
                      <Label className="font-semibold text-foreground">
                        {t('每个视频分析时长上限')}
                      </Label>
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono font-bold bg-muted px-2 py-0.5 rounded text-primary">
                          {Math.round(videoAnalyzeDurationSec / 60)} {t('分钟')}
                        </span>
                        {isFreeUser && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-6 px-2 text-[11px] text-amber-600 dark:text-amber-400"
                            onClick={() => setIsUpgradeOpen(true)}
                          >
                            {t('解锁更长')}
                          </Button>
                        )}
                      </div>
                    </div>
                    <input
                      type="range"
                      min={300}
                      max={10800}
                      step={300}
                      value={videoAnalyzeDurationSec}
                      onChange={e =>
                        handleParamChange('videoAnalyzeDurationSec', parseInt(e.target.value, 10))
                      }
                      className="w-full accent-primary cursor-pointer"
                    />
                    {isAnalyzeCapped && isFreeUser && (
                      <p className="text-[11px] text-amber-600 dark:text-amber-400">
                        {t('当前你是免费用户，最终结算值为5分钟，升级后可应用设置值。')}
                      </p>
                    )}
                    <p className="text-[11px] text-muted-foreground">
                      {t(
                        '每个视频最多整理多长时间，5 分钟一档，最长 3 小时；普通电脑建议选短一些，放后台慢慢整理。'
                      )}
                    </p>
                  </div>

                  {/* 免费会员权益说明与 Pro 升级引导 */}
                  {isFreeUser && (
                    <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/25 flex items-center justify-between gap-3 flex-wrap transition-all">
                      <div className="flex items-center gap-2.5 min-w-0 flex-1">
                        <Crown className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                        <div className="text-xs leading-relaxed">
                          <p className="font-bold text-amber-700 dark:text-amber-300">
                            {t('免费版每个视频分析精彩前 5 分钟。')}
                          </p>
                          <p className="text-muted-foreground">
                            {t('升级 Pro 会员可解锁整部视频全量分析，支持单视频长达 3 小时。')}
                          </p>
                        </div>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => setIsUpgradeOpen(true)}
                        className="h-7 px-3 text-xs font-bold bg-gradient-to-r from-amber-500 to-orange-600 text-white hover:opacity-90 transition-opacity shrink-0 shadow-xs"
                      >
                        {t('立即升级 Pro')}
                      </Button>
                    </div>
                  )}
                </div>
              )
            })()}
          </div>
        </Card>
      )}

      {/* 4. 视觉语义搜索 (CLIP 跨模态通道，仅在双塔 classic_light 模式生效) */}
      {embeddingProfile === 'classic_light' && (
        <Card className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-violet-500 shrink-0" />
                <Label className="text-sm font-medium text-foreground">
                  {t('文字直接找图')}
                  <HelpTooltip
                    content={t(
                      '在轻量模式下，用文字描述画面（如「红色的跑车」「左边的沙发」）直接找图片。低配设备关闭可节省内存。'
                    )}
                  />
                </Label>
              </div>
              <p className="text-[11px] text-muted-foreground mt-1.5 leading-snug">
                {t(
                  '开启后可用自然语言画面描述直接检索图片。注意：此通道仅检索纯图片画面，不影响文档、音视频台词与视频切片。'
                )}
              </p>
            </div>
            <Switch
              checked={clipTextEnabled}
              onCheckedChange={checked => handleParamChange('clipTextEnabled', checked)}
              aria-label={t('文字直接找图')}
            />
          </div>
        </Card>
      )}

      {/* 5. 语义索引状态看板与底层维护 (全局常驻) */}
      <Card className="p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <RefreshCw className="h-4 w-4 text-primary shrink-0" />
              <Label className="text-sm font-medium text-foreground">
                {t('语义索引状态与维护')}
              </Label>
            </div>
            <p className="text-[11px] text-muted-foreground mt-1.5 leading-snug">
              {rebuildError
                ? t('索引状态读取失败，可稍后重试或手动重建。')
                : rebuildCounts
                  ? t('待重建 {pending} 项 · 已就绪 {ready} 项 · 失败 {failed} 项', {
                      pending: rebuildCounts.pending + rebuildCounts.uncomputed,
                      ready: rebuildCounts.ready,
                      failed: rebuildCounts.failed
                    })
                  : t('正在读取索引状态…')}
            </p>
            <p className="text-[11px] text-muted-foreground mt-1 leading-snug">
              {t('当切换搜索引擎档位，或发现搜索结果不准确时，可手动触发全库索引重建。')}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={isRebuilding}
            onClick={async () => {
              setIsRebuilding(true)
              try {
                await window.electronAPI?.runCanonicalMaintenance?.('settings_manual')
                const counts = await window.electronAPI?.getCanonicalRebuildCounts?.()
                if (counts) {
                  setRebuildCounts(counts)
                  setRebuildError(null)
                }
              } catch (err) {
                setRebuildError(err instanceof Error ? err.message : String(err))
              } finally {
                setIsRebuilding(false)
              }
            }}
          >
            <RefreshCw className={cn('h-3.5 w-3.5 mr-1.5', isRebuilding && 'animate-spin')} />
            {isRebuilding ? t('重建中…') : t('重建语义索引')}
          </Button>
        </div>
      </Card>

      <UpgradeAccountDialog open={isUpgradeOpen} onOpenChange={setIsUpgradeOpen} />
    </div>
  )
}
