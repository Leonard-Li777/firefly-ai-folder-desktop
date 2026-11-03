import {
  Check,
  Cpu,
  Gauge,
  HelpCircle,
  Layers,
  Lock,
  RefreshCw,
  Sparkles
} from 'lucide-react'
import React, { useEffect, useState } from 'react'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { Switch } from '../ui/switch'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel
} from '../ui/alert-dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SettingsCategory } from '@firefly/types/settings-types'
import {
  VideoAnalysisProfile,
  VideoCutSensitivity,
  VIDEO_ANALYSIS_PRESETS,
  estimateVideoAnalysisDurationSec
} from '@firefly/shared'
import { ChevronDown, ChevronRight, Sliders, ShieldCheck, Crown } from 'lucide-react'
import { useTierStore } from '../../stores/tier-store'
import { UserTier } from '@firefly/types'
import { UpgradeAccountDialog } from '../tier/UpgradeAccountDialog'
import { captureEvent } from '../../lib/posthog'
import i18nScope from '@app/languages'
import { useSettingsStore } from '../../stores/settings-store'
import { useVoerkaI18n } from '@voerkai18n/react'
import { toast } from '../common/Toast'

/**
 * 辅助悬浮气泡组件
 */
const HelpTooltip: React.FC<{ content: string }> = ({ content }) => {
  const [visible, setVisible] = useState(false)
  const { t } = useVoerkaI18n(i18nScope)
  const tier = useTierStore(s => s.tier)
  const isFreeUser = tier === UserTier.FREE
  const [isUpgradeOpen, setIsUpgradeOpen] = useState(false)
  return (
    <span
      className="relative inline-flex items-center ml-1 cursor-pointer text-muted-foreground hover:text-foreground"
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
    >
      <HelpCircle className="h-3.5 w-3.5" />
      {visible && (
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-64 p-2 text-xs bg-popover text-popover-foreground border rounded-lg shadow-md z-50 pointer-events-none whitespace-normal normal-case leading-normal font-normal">
          {t(content)}
        </span>
      )}
    </span>
  )
}

/**
 * 基础AI引擎配置组件
 */
/**
 * 基于 90s 向量分析硬预算与当前语音识别时长，动态计算给定画面精细度档位下的单视频最长可检索时长（分钟）
 *
 * 计算公式严格与底层核心引擎 perceive.rs 的 solve_video_analysis_budget_with_asr 保持同源：
 * - 向量预算总额：90s，预留固定开销 5s => 可用 85s
 * - ASR 实时率：0.112（分块 ASR 实测值）
 * - 跳帧解码速率：0.01（100x 极速）
 * - 候选间隔上限：60s
 * - 单帧编码成本：48 档为 0.787s，140 档为 1.996s
 */
const estimateMaxVideoDurationMins = (softTokenBudget: number, asrDurationSec: number): number => {
  const available = 85.0 // 90s - 5s
  const safeAsrDuration = Math.max(10, Math.min(300, asrDurationSec || 30))
  // ASR 耗时封顶防御：不超过 90% 可用预算
  const asrCap = Math.min(safeAsrDuration, (available * 0.9) / 0.112)
  const asrCost = asrCap * 0.112
  const visAvailable = Math.max(1.0, available - asrCost)

  const frameCost = softTokenBudget <= 48 ? 0.787 : 1.996
  const maxInterval = 60.0
  const skipDecodeRate = 0.01
  const costPerSec = skipDecodeRate + frameCost / maxInterval

  const maxDurationSec = visAvailable / costPerSec
  return Math.round(maxDurationSec / 60)
}

export const BasicAIEngineConfigSettings: React.FC = () => {
  const config = useSettingsStore(s => s.config)
  const getConfigValue = useSettingsStore(s => s.getConfigValue)
  const updateConfigValue = useSettingsStore(s => s.updateConfigValue)
  const openSettings = useSettingsStore(s => s.openSettings)
  const { t } = useVoerkaI18n(i18nScope)

  // 高级AI引擎（萤核/云端）是否已开启；disabled = 仅基础AI引擎
  const isAdvancedAiEnabled = (config?.aiServiceMode ?? 'local') !== 'disabled'
  // 高级AI引擎关闭时，增强/全面不可选，展示与生效模式统一回落为标准分析
  const analysisMode = isAdvancedAiEnabled
    ? (getConfigValue<string>('ANALYSIS_MODE') ?? 'quick_name')
    : 'simple'

  // 多模态嵌入画像档位（二元档位契约）：classic_light (384d) vs gemma_unified (512d)
  const embeddingProfile =
    getConfigValue<'classic_light' | 'gemma_unified'>('AI_EMBEDDING_PROFILE') ?? 'classic_light'
  const [pendingProfile, setPendingProfile] = useState<'classic_light' | 'gemma_unified' | null>(null)
  const [pendingDimension, setPendingDimension] = useState<256 | 512 | 768 | null>(null)
  // 「应用硬件推荐设置」在档位不一致时需先弹确认框，确认后必须补齐画面精细度，
  // 否则一键应用只改档位、视频档位被静默跳过（与手动点档位卡片的行为区分开）
  const [pendingVideoRecommendation, setPendingVideoRecommendation] = useState(false)

  // MRL 多维度弹性降维 (256 | 512 | 768)
  const mrlDimension =
    getConfigValue<256 | 512 | 768>('EMBEDDING_MRL_DIMENSION') ?? 512

  // 语音识别时长（秒）：作为「向量化 + ASR」90s 预算里的 ASR 上限参与求解
  // （ASR 成本是 min(A, 视频可分析时长)·r，不是 D·r）。默认 30s，与既有行为一致。
  const [localAudioAsrDuration, setLocalAudioAsrDuration] = useState<number>(
    getConfigValue<number>('AUDIO_ANALYSIS_DURATION') ?? 30
  )

  // 视频画面精细度（每帧视觉软 token 预算：140=高清精细，48=流畅极速）
  const [localVideoSoftTokenBudget, setLocalVideoSoftTokenBudget] = useState<number>(
    getConfigValue<number>('VIDEO_SOFT_TOKEN_BUDGET') ?? 140
  )

  // 视频分析预设三档：fast_archive | balanced_search | deep_frame_hunt | custom
  const [videoProfile, setVideoProfile] = useState<VideoAnalysisProfile>(
    (getConfigValue<string>('VIDEO_ANALYSIS_PROFILE' as any) as VideoAnalysisProfile) ?? 'balanced_search'
  )
  const [videoQuotaMax, setVideoQuotaMax] = useState<number>(
    getConfigValue<number>('VIDEO_FRAME_QUOTA_MAX' as any) ?? 60
  )
  const [videoCutSensitivity, setVideoCutSensitivity] = useState<VideoCutSensitivity>(
    (getConfigValue<string>('VIDEO_CUT_SENSITIVITY' as any) as VideoCutSensitivity) ?? 'medium'
  )
  const [videoAsrCap, setVideoAsrCap] = useState<number>(
    getConfigValue<number>('VIDEO_ASR_DURATION') ?? 60
  )
  const [isProPanelOpen, setIsProPanelOpen] = useState(false)
  const tier = useTierStore(s => s.tier)
  const isFreeUser = tier === UserTier.FREE
  const [isUpgradeOpen, setIsUpgradeOpen] = useState(false)

  const handleSelectVideoProfile = async (profile: VideoAnalysisProfile) => {
    if (profile === 'custom') {
      setVideoProfile('custom')
      await updateConfigValue('VIDEO_ANALYSIS_PROFILE' as any, 'custom')
      return
    }
    const preset = VIDEO_ANALYSIS_PRESETS[profile]
    setVideoProfile(profile)
    setVideoQuotaMax(preset.quotaMax)
    setVideoCutSensitivity(preset.cutSensitivity)
    setLocalVideoSoftTokenBudget(preset.softTokenBudget)
    setVideoAsrCap(preset.asrDurationSec)

    await updateConfigValue('VIDEO_ANALYSIS_PROFILE' as any, profile)
    await updateConfigValue('VIDEO_FRAME_QUOTA_MAX' as any, preset.quotaMax)
    await updateConfigValue('VIDEO_CUT_SENSITIVITY' as any, preset.cutSensitivity)
    await updateConfigValue('VIDEO_SOFT_TOKEN_BUDGET', preset.softTokenBudget)
    await updateConfigValue('VIDEO_ASR_DURATION', preset.asrDurationSec)
    captureEvent('切换视频分析预设档位', { profile })
  }

  const handleCustomParamChange = async (params: {
    quotaMax?: number
    cutSensitivity?: VideoCutSensitivity
    tokenBudget?: number
    softTokenBudget?: number
    asrCap?: number
    asrDurationSec?: number
  }) => {
    setVideoProfile('custom')
    await updateConfigValue('VIDEO_ANALYSIS_PROFILE' as any, 'custom')

    if (params.quotaMax !== undefined) {
      setVideoQuotaMax(params.quotaMax)
      await updateConfigValue('VIDEO_FRAME_QUOTA_MAX' as any, params.quotaMax)
    }
    if (params.cutSensitivity !== undefined) {
      setVideoCutSensitivity(params.cutSensitivity)
      await updateConfigValue('VIDEO_CUT_SENSITIVITY' as any, params.cutSensitivity)
    }
    const budget = params.softTokenBudget ?? params.tokenBudget
    if (budget !== undefined) {
      setLocalVideoSoftTokenBudget(budget)
      await updateConfigValue('VIDEO_SOFT_TOKEN_BUDGET', budget)
    }
    const asr = params.asrCap ?? params.asrDurationSec
    if (asr !== undefined) {
      setVideoAsrCap(asr)
      await updateConfigValue('VIDEO_ASR_DURATION', asr)
    }
    captureEvent('自定义视频分析高级参数', params)
  }

  // ── 工单 13：视觉语义搜索开关与语义索引重建状态 ──────────────────────────────
  // 开关默认 true（后端门禁还会校验档位/语言/文本塔可用性，此处只是用户意图）
  const clipTextEnabled = getConfigValue<boolean>('AI_CLIP_TEXT_SEARCH_ENABLED') ?? true
  const [rebuildCounts, setRebuildCounts] = useState<{
    pending: number
    ready: number
    visualOnly: number
    skipped: number
    failed: number
    uncomputed: number
    lastMaintenance: { reason: string; at: number; invalidated: number; requeued: number } | null
  } | null>(null)
  /** 读取失败只在设置页内联提示一次（不弹全局 toast，避免每次进设置页都打扰） */
  const [rebuildError, setRebuildError] = useState<string | null>(null)
  const [isRebuilding, setIsRebuilding] = useState(false)
  const rebuildLoadedRef = React.useRef(false)

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
  const recommendationCheckedRef = React.useRef(false)

  useEffect(() => {
    if (recommendationCheckedRef.current) return
    recommendationCheckedRef.current = true

    window.electronAPI?.getRecommendedEmbeddingSettings?.()
      .then((rec: any) => {
        if (rec) {
          setRecommendedSettings(rec)
          // 若当前尚未配置过 AI_EMBEDDING_PROFILE 且硬件推荐为 gemma_unified，自动对齐
          const currentProfile = getConfigValue<string>('AI_EMBEDDING_PROFILE')
          if (!currentProfile && rec.profile === 'gemma_unified') {
            updateConfigValue('AI_EMBEDDING_PROFILE', 'gemma_unified')
            if (rec.mrlDimension) {
              updateConfigValue('EMBEDDING_MRL_DIMENSION', rec.mrlDimension)
            }
            if (rec.videoSoftTokenBudget) {
              updateConfigValue('VIDEO_SOFT_TOKEN_BUDGET', rec.videoSoftTokenBudget)
              setLocalVideoSoftTokenBudget(rec.videoSoftTokenBudget)
            }
          }
        }
      })
      .catch(() => { })
  }, [])

  const handleConfirmProfileSwitch = async () => {
    if (!pendingProfile) return
    const target = pendingProfile
    setPendingProfile(null)
    await updateConfigValue('AI_EMBEDDING_PROFILE', target)
    if (target === 'gemma_unified' && recommendedSettings?.mrlDimension) {
      await updateConfigValue('EMBEDDING_MRL_DIMENSION', recommendedSettings.mrlDimension)
    }
    // 由「应用硬件推荐设置」触发的档位切换：确认后补齐硬件推荐的画面精细度，
    // 保证一键应用语义完整（手动点档位卡片不触发本分支）；逐字段守卫防推荐数据缺项时写入 undefined
    if (pendingVideoRecommendation && recommendedSettings) {
      const rec = recommendedSettings
      if (rec.videoSoftTokenBudget) {
        await updateConfigValue('VIDEO_SOFT_TOKEN_BUDGET', rec.videoSoftTokenBudget)
        setLocalVideoSoftTokenBudget(rec.videoSoftTokenBudget)
      }
    }
    setPendingVideoRecommendation(false)
    captureEvent('切换嵌入模型档位', { profile: target })
    toast.success(
      t('已切换搜索与理解模式并重启，新导入的文件将使用新模式分析')
    )
  }

  const handleConfirmDimensionSwitch = async () => {
    if (!pendingDimension) return
    const target = pendingDimension
    setPendingDimension(null)
    await updateConfigValue('EMBEDDING_MRL_DIMENSION', target)
    captureEvent('切换特征分析精度', { dimension: target })
    toast.success(
      t('已将特征分析精度切换为 {dim} 维，已分析的文件重新分析后生效', { dim: target })
    )
  }

  const handleApplyHardwareRecommendations = async () => {
    if (!recommendedSettings) return
    if (embeddingProfile !== recommendedSettings.profile) {
      setPendingProfile(recommendedSettings.profile)
      setPendingVideoRecommendation(true)
      return
    }
    const rec = recommendedSettings
    // 逐字段守卫：推荐数据缺项时不把 undefined 写进配置
    if (rec.mrlDimension) {
      await updateConfigValue('EMBEDDING_MRL_DIMENSION', rec.mrlDimension)
    }
    if (rec.videoSoftTokenBudget) {
      await updateConfigValue('VIDEO_SOFT_TOKEN_BUDGET', rec.videoSoftTokenBudget)
      setLocalVideoSoftTokenBudget(rec.videoSoftTokenBudget)
    }
    toast.success(
      t('已同步硬件推荐配置（{profile} · {dim}维 · 画面{detail}）', {
        profile: rec.profile === 'gemma_unified' ? t('全模态标准档') : t('极速轻量档'),
        dim: rec.mrlDimension,
        detail: rec.videoSoftTokenBudget === 48 ? t('流畅极速搜索') : t('高清精细搜索')
      })
    )
  }

  // 语音识别时长防抖同步（挂载快照守卫：只有偏离挂载初值的用户实际改动才写配置，
  // 避免晚到 hydration 或 StrictMode 重挂载造成误写）
  const initialAudioAsrDurationRef = React.useRef(localAudioAsrDuration)
  useEffect(() => {
    if (localAudioAsrDuration === initialAudioAsrDurationRef.current) return
    const handler = setTimeout(() => {
      const currentConfigValue = getConfigValue<number>('AUDIO_ANALYSIS_DURATION') ?? 30
      if (localAudioAsrDuration !== currentConfigValue) {
        updateConfigValue('AUDIO_ANALYSIS_DURATION', localAudioAsrDuration)
        captureEvent('更新语音识别时长', {
          durationSeconds: localAudioAsrDuration
        })
      }
    }, 500)

    return () => clearTimeout(handler)
  }, [localAudioAsrDuration])

  // 视频画面精细度防抖同步（守卫逻辑同上）
  const initialVideoSoftTokenBudgetRef = React.useRef(localVideoSoftTokenBudget)
  useEffect(() => {
    if (localVideoSoftTokenBudget === initialVideoSoftTokenBudgetRef.current) return
    const handler = setTimeout(() => {
      const currentConfigValue = getConfigValue<number>('VIDEO_SOFT_TOKEN_BUDGET') ?? 140
      if (localVideoSoftTokenBudget !== currentConfigValue) {
        updateConfigValue('VIDEO_SOFT_TOKEN_BUDGET', localVideoSoftTokenBudget)
        captureEvent('更新视频画面精细度', {
          softTokenBudget: localVideoSoftTokenBudget
        })
      }
    }, 500)

    return () => clearTimeout(handler)
  }, [localVideoSoftTokenBudget])

  return (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-2">{t('基础AI引擎配置')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('配置分析模式、嵌入模型档位、MRL 向量维度与视频取帧参数')}
        </p>
      </div>

      {/* 选择分析模式 */}
      <Card className="p-5">
        <div className="space-y-4">
          {/* 切换文件分析模式 */}
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <Gauge className="h-4 w-4" />
            </div>
            <div className="flex items-center gap-1.5 flex-1 min-w-0">
              <Label className="text-base font-semibold leading-none">{t('选择分析模式')}</Label>
              <HelpTooltip
                content={t(
                  '根据需求选择不同模式，全面分析耗时最长但精度最高；标准分析最快。增强分析与全面分析需开启高级AI引擎。'
                )}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* 标准分析（原简单分类） */}
            <div
              onClick={() => {
                updateConfigValue('ANALYSIS_MODE', 'simple')
                captureEvent('切换分析模式', { mode: 'simple' })
              }}
              className={`relative overflow-hidden flex flex-col p-4 rounded-lg border-2 cursor-pointer transition-all ${analysisMode === 'simple'
                  ? 'border-primary bg-primary/10 shadow-sm ring-1 ring-primary/20'
                  : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
                }`}
            >
              <div className="absolute top-0 right-0 text-[11px] font-semibold bg-muted text-muted-foreground px-2.5 py-0.5 rounded-bl-md">
                {t('极速')}
              </div>
              {/* 选中勾选标记 */}
              {analysisMode === 'simple' && (
                <div className="absolute bottom-2.5 right-2.5 w-5 h-5 rounded-full bg-primary flex items-center justify-center shadow-sm">
                  <Check className="h-3 w-3 text-primary-foreground stroke-[2.5]" />
                </div>
              )}
              <div className="flex items-center justify-between pr-8">
                <span
                  className={`font-semibold text-sm ${analysisMode === 'simple' ? 'text-primary' : ''}`}
                >
                  {t('标准分析')}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                {t('基于基础AI引擎高速获取文件标签、智能文件名和摘要')}
              </p>
            </div>

            {/* 增强分析（原快速命名）—— 需开启高级AI引擎 */}
            <div
              onClick={() => {
                if (!isAdvancedAiEnabled) return
                updateConfigValue('ANALYSIS_MODE', 'quick_name')
                captureEvent('切换分析模式', { mode: 'quick_name' })
              }}
              className={`relative overflow-hidden flex flex-col p-4 rounded-lg border-2 transition-all ${!isAdvancedAiEnabled
                  ? 'border-border bg-muted/20 opacity-60 cursor-not-allowed'
                  : analysisMode === 'quick_name'
                    ? 'border-primary bg-primary/10 shadow-sm ring-1 ring-primary/20 cursor-pointer'
                    : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30 cursor-pointer'
                }`}
            >
              <div className="absolute top-0 right-0 text-[11px] font-semibold bg-muted text-muted-foreground px-2.5 py-0.5 rounded-bl-md">
                {t('默认')}
              </div>
              {/* 选中勾选标记 */}
              {isAdvancedAiEnabled && analysisMode === 'quick_name' && (
                <div className="absolute bottom-2.5 right-2.5 w-5 h-5 rounded-full bg-primary flex items-center justify-center shadow-sm">
                  <Check className="h-3 w-3 text-primary-foreground stroke-[2.5]" />
                </div>
              )}
              <div className="flex items-center justify-between pr-8">
                <span
                  className={`font-semibold text-sm ${isAdvancedAiEnabled && analysisMode === 'quick_name' ? 'text-primary' : ''
                    }`}
                >
                  {t('增强分析')}
                </span>
                {!isAdvancedAiEnabled && <Lock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
              </div>
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                {t('【标准分析】+ 高级AI引擎润色智能文件名和描述以及补充标签')}
              </p>
              {!isAdvancedAiEnabled && (
                <div className="flex items-center gap-1.5 mt-2.5 text-xs text-amber-600 dark:text-amber-400">
                  <Lock className="h-3 w-3 shrink-0" />
                  <button
                    type="button"
                    className="underline font-medium hover:text-amber-700"
                    onClick={e => {
                      e.stopPropagation()
                      openSettings(SettingsCategory.AI_ENGINE_CONFIG)
                    }}
                  >
                    {t('需开启高级AI引擎')}
                  </button>
                </div>
              )}
            </div>

            {/* 全面分析 —— 需开启高级AI引擎 */}
            <div
              onClick={() => {
                if (!isAdvancedAiEnabled) return
                updateConfigValue('ANALYSIS_MODE', 'full')
                captureEvent('切换分析模式', { mode: 'full' })
              }}
              className={`relative overflow-hidden flex flex-col p-4 rounded-lg border-2 transition-all ${!isAdvancedAiEnabled
                  ? 'border-border bg-muted/20 opacity-60 cursor-not-allowed'
                  : analysisMode === 'full'
                    ? 'border-primary bg-primary/10 shadow-sm ring-1 ring-primary/20 cursor-pointer'
                    : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30 cursor-pointer'
                }`}
            >
              <div className="absolute top-0 right-0 text-[11px] font-semibold bg-green-500 text-white px-2.5 py-0.5 rounded-bl-md shadow-sm dark:bg-green-600">
                {t('推荐')}
              </div>
              {/* 选中勾选标记 */}
              {isAdvancedAiEnabled && analysisMode === 'full' && (
                <div className="absolute bottom-2.5 right-2.5 w-5 h-5 rounded-full bg-primary flex items-center justify-center shadow-sm">
                  <Check className="h-3 w-3 text-primary-foreground stroke-[2.5]" />
                </div>
              )}
              <div className="flex items-center justify-between pr-8">
                <span
                  className={`font-semibold text-sm ${isAdvancedAiEnabled && analysisMode === 'full' ? 'text-primary' : ''
                    }`}
                >
                  {t('全面分析')}
                </span>
                {!isAdvancedAiEnabled && <Lock className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
              </div>
              <p className="text-xs text-muted-foreground mt-2 leading-relaxed">
                {t(
                  '【增强分析】+ 全面AI分析，包含质量评分与详细图片、音频、视频内容描述等'
                )}
              </p>
              {!isAdvancedAiEnabled && (
                <div className="flex items-center gap-1.5 mt-2.5 text-xs text-amber-600 dark:text-amber-400">
                  <Lock className="h-3 w-3 shrink-0" />
                  <button
                    type="button"
                    className="underline font-medium hover:text-amber-700"
                    onClick={e => {
                      e.stopPropagation()
                      openSettings(SettingsCategory.AI_ENGINE_CONFIG)
                    }}
                  >
                    {t('需开启高级AI引擎')}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </Card>

      {/* 多模态语义搜索模式 (二元分级架构) */}
      <Card className="p-5">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <Layers className="h-4 w-4" />
              </div>
              <div className="flex items-center gap-1.5 min-w-0">
                <Label className="text-base font-semibold leading-none">{t('语义搜索与智能理解模式')}</Label>
                <HelpTooltip
                  content={t(
                    '决定文件与音视频的搜索理解深度。全模态标准档支持深层看懂图片与音视频对话；极速轻量档省电省内存、低发热。'
                  )}
                />
              </div>
            </div>

            {recommendedSettings && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs text-primary border-primary/30 hover:bg-primary/10"
                onClick={handleApplyHardwareRecommendations}
              >
                <Sparkles className="h-3.5 w-3.5 mr-1 text-primary" />
                {t('应用硬件推荐设置')}
              </Button>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {/* 极速轻量档 */}
            <div
              onClick={() => {
                if (embeddingProfile !== 'classic_light') {
                  setPendingProfile('classic_light')
                }
              }}
              className={`relative overflow-hidden flex flex-col p-4 rounded-lg border-2 cursor-pointer transition-all ${embeddingProfile === 'classic_light'
                  ? 'border-primary bg-primary/10 shadow-sm ring-1 ring-primary/20'
                  : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
                }`}
            >
              <div className="absolute top-0 right-0 text-[11px] font-semibold bg-muted text-muted-foreground px-2.5 py-0.5 rounded-bl-md">
                {t('超省电 · 极速分析')}
              </div>
              {embeddingProfile === 'classic_light' && (
                <div className="absolute bottom-2.5 right-2.5 w-5 h-5 rounded-full bg-primary flex items-center justify-center shadow-sm">
                  <Check className="h-3 w-3 text-primary-foreground stroke-[2.5]" />
                </div>
              )}
              <div className="flex items-center gap-2 pr-8">
                <span
                  className={`font-semibold text-sm ${embeddingProfile === 'classic_light' ? 'text-primary' : ''
                    }`}
                >
                  {t('极速轻量档')}
                </span>
                {recommendedSettings?.profile === 'classic_light' && (
                  <span className="text-[9px] font-medium px-1 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">
                    {t('硬件推荐')}
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground mt-2 leading-relaxed space-y-1">
                <div>{t('【优势】分析飞快，内存占用极低（< 80MB），省电且机身不发热。')}</div>
                <div>{t('【代价】仅支持文字与基础图片搜索，无法深度理解视频内容与对话。')}</div>
                <div>{t('【适合】8GB 内存轻薄本、日常基础办公或电池供电场景。')}</div>
              </div>
            </div>

            {/* 全模态标准档 */}
            <div
              onClick={() => {
                if (embeddingProfile !== 'gemma_unified') {
                  setPendingProfile('gemma_unified')
                }
              }}
              className={`relative overflow-hidden flex flex-col p-4 rounded-lg border-2 cursor-pointer transition-all ${embeddingProfile === 'gemma_unified'
                  ? 'border-primary bg-primary/10 shadow-sm ring-1 ring-primary/20'
                  : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
                }`}
            >
              <div className="absolute top-0 right-0 text-[11px] font-semibold bg-green-500 text-white px-2.5 py-0.5 rounded-bl-md shadow-sm dark:bg-green-600">
                {t('深度理解 · 音视频全能')}
              </div>
              {embeddingProfile === 'gemma_unified' && (
                <div className="absolute bottom-2.5 right-2.5 w-5 h-5 rounded-full bg-primary flex items-center justify-center shadow-sm">
                  <Check className="h-3 w-3 text-primary-foreground stroke-[2.5]" />
                </div>
              )}
              <div className="flex items-center gap-2 pr-8">
                <span
                  className={`font-semibold text-sm ${embeddingProfile === 'gemma_unified' ? 'text-primary' : ''
                    }`}
                >
                  {t('全模态标准档')}
                </span>
                {recommendedSettings?.profile === 'gemma_unified' && (
                  <span className="text-[9px] font-medium px-1 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20">
                    {t('硬件推荐')}
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground mt-2 leading-relaxed space-y-1">
                <div>{t('【优势】看懂复杂画面细节与音视频对话，搜一句话即可秒级定位到视频片段。')}</div>
                <div>{t('【代价】分析时会占用一定算力与内存（约 300~500MB）。')}</div>
                <div>{t('【适合】16GB 及以上内存电脑，追求极致搜索与智能整理体验。')}</div>
              </div>
            </div>
          </div>

          {/* 全模态标准档下的进阶配置 */}
          {embeddingProfile === 'gemma_unified' && (
            <div className="mt-5 pt-4 border-t border-border/60 space-y-4">
              {/* MRL 分析精度多档配置 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Label className="text-sm font-medium text-foreground">
                      {t('特征分析精度')}
                    </Label>
                    <HelpTooltip
                      content={t(
                        '决定为每个文件提取特征的精细程度。精度越高，模糊词和长句搜索越精准；精度越低，索引文件越省磁盘空间。'
                      )}
                    />
                  </div>
                  {recommendedSettings?.mrlDimension && (
                    <span className="text-[11px] text-muted-foreground">
                      {t('硬件推荐：{level}（{dim}维）', {
                        level:
                          recommendedSettings.mrlDimension === 768
                            ? t('精准档')
                            : recommendedSettings.mrlDimension === 512
                              ? t('标准档')
                              : t('紧凑档'),
                        dim: recommendedSettings.mrlDimension
                      })}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {/* 紧凑档 256 */}
                  <div
                    onClick={() => {
                      if (mrlDimension !== 256) {
                        setPendingDimension(256)
                      }
                    }}
                    className={`relative overflow-hidden flex flex-col p-4 rounded-lg border-2 cursor-pointer transition-all ${mrlDimension === 256
                        ? 'border-primary bg-primary/10 shadow-sm ring-1 ring-primary/20'
                        : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
                      }`}
                  >
                    {recommendedSettings?.mrlDimension === 256 ? (
                      <div className="absolute top-0 right-0 text-[11px] font-semibold bg-green-500 text-white px-2.5 py-0.5 rounded-bl-md shadow-sm dark:bg-green-600">
                        {t('推荐')}
                      </div>
                    ) : (
                      <div className="absolute top-0 right-0 text-[11px] font-semibold bg-muted text-muted-foreground px-2.5 py-0.5 rounded-bl-md">
                        {t('超省磁盘')}
                      </div>
                    )}
                    {mrlDimension === 256 && (
                      <div className="absolute bottom-2.5 right-2.5 w-5 h-5 rounded-full bg-primary flex items-center justify-center shadow-sm">
                        <Check className="h-3 w-3 text-primary-foreground stroke-[2.5]" />
                      </div>
                    )}
                    <div className="flex items-center gap-2 pr-14">
                      <span className={`font-semibold text-sm ${mrlDimension === 256 ? 'text-primary' : ''}`}>
                        {t('紧凑省盘档')}
                      </span>
                      {recommendedSettings?.mrlDimension === 256 && (
                        <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20">
                          {t('硬件推荐')}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-2 leading-relaxed space-y-1">
                      <div>{t('【优势】极省磁盘，每文件仅约 1KB 索引，省 67% 存储空间。')}</div>
                      <div>{t('【代价】对极复杂细微描述的辨识度略有降低（约 95% 准确率）。')}</div>
                      <div>{t('【适合】磁盘空间紧张或 8GB 内存设备。')}</div>
                    </div>
                  </div>

                  {/* 标准档 512 */}
                  <div
                    onClick={() => {
                      if (mrlDimension !== 512) {
                        setPendingDimension(512)
                      }
                    }}
                    className={`relative overflow-hidden flex flex-col p-4 rounded-lg border-2 cursor-pointer transition-all ${mrlDimension === 512
                        ? 'border-primary bg-primary/10 shadow-sm ring-1 ring-primary/20'
                        : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
                      }`}
                  >
                    {recommendedSettings?.mrlDimension === 512 ? (
                      <div className="absolute top-0 right-0 text-[11px] font-semibold bg-green-500 text-white px-2.5 py-0.5 rounded-bl-md shadow-sm dark:bg-green-600">
                        {t('推荐')}
                      </div>
                    ) : (
                      <div className="absolute top-0 right-0 text-[11px] font-semibold bg-muted text-muted-foreground px-2.5 py-0.5 rounded-bl-md">
                        {t('黄金平衡')}
                      </div>
                    )}
                    {mrlDimension === 512 && (
                      <div className="absolute bottom-2.5 right-2.5 w-5 h-5 rounded-full bg-primary flex items-center justify-center shadow-sm">
                        <Check className="h-3 w-3 text-primary-foreground stroke-[2.5]" />
                      </div>
                    )}
                    <div className="flex items-center gap-2 pr-14">
                      <span className={`font-semibold text-sm ${mrlDimension === 512 ? 'text-primary' : ''}`}>
                        {t('标准平衡档')}
                      </span>
                      {recommendedSettings?.mrlDimension === 512 && (
                        <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20">
                          {t('硬件推荐')}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-2 leading-relaxed space-y-1">
                      <div>{t('【优势】速度与精度的黄金平衡，保留 98.5% 以上细节辨识能力。')}</div>
                      <div>{t('【代价】每文件约 2KB 索引空间。')}</div>
                      <div>{t('【适合】8GB ~ 16GB 主流电脑首选推荐。')}</div>
                    </div>
                  </div>

                  {/* 精准档 768 */}
                  <div
                    onClick={() => {
                      if (mrlDimension !== 768) {
                        setPendingDimension(768)
                      }
                    }}
                    className={`relative overflow-hidden flex flex-col p-4 rounded-lg border-2 cursor-pointer transition-all ${mrlDimension === 768
                        ? 'border-primary bg-primary/10 shadow-sm ring-1 ring-primary/20'
                        : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
                      }`}
                  >
                    {recommendedSettings?.mrlDimension === 768 ? (
                      <div className="absolute top-0 right-0 text-[11px] font-semibold bg-green-500 text-white px-2.5 py-0.5 rounded-bl-md shadow-sm dark:bg-green-600">
                        {t('推荐')}
                      </div>
                    ) : (
                      <div className="absolute top-0 right-0 text-[11px] font-semibold bg-muted text-muted-foreground px-2.5 py-0.5 rounded-bl-md">
                        {t('旗舰高精')}
                      </div>
                    )}
                    {mrlDimension === 768 && (
                      <div className="absolute bottom-2.5 right-2.5 w-5 h-5 rounded-full bg-primary flex items-center justify-center shadow-sm">
                        <Check className="h-3 w-3 text-primary-foreground stroke-[2.5]" />
                      </div>
                    )}
                    <div className="flex items-center gap-2 pr-14">
                      <span className={`font-semibold text-sm ${mrlDimension === 768 ? 'text-primary' : ''}`}>
                        {t('旗舰精准档')}
                      </span>
                      {recommendedSettings?.mrlDimension === 768 && (
                        <span className="text-[9px] font-medium px-1.5 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20">
                          {t('硬件推荐')}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-2 leading-relaxed space-y-1">
                      <div>{t('【优势】满血最高精度，对模糊长句和音画视频内容细节匹配最佳。')}</div>
                      <div>{t('【代价】每文件约 3KB 索引空间，分析时需稍多内存。')}</div>
                      <div>{t('【适合】16GB / 32GB 及以上高性能电脑推荐。')}</div>
                    </div>
                  </div>
                </div>
              </div>

              {/* 视频画面分析与检索模式（外层大白话三档预设 + 内层折叠高级面板） */}
              <div className="space-y-4 pt-3 border-t border-border/40">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <Label className="text-sm font-semibold text-foreground">
                      {t('视频画面分析与检索模式')}
                    </Label>
                    <HelpTooltip
                      content={t(
                        '决定文件首次导入整理时的分析速度，以及在搜索栏中能否精确搜到视频中间“一闪而过”的具体画面。搜索响应永远是毫秒级瞬时完成，耗时只发生在文件后台分析建索引阶段。'
                      )}
                    />
                  </div>
                  {videoProfile === 'custom' && (
                    <span className="text-[11px] font-semibold bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 px-2 py-0.5 rounded-full">
                      {t('已自定义')}
                    </span>
                  )}
                </div>

                {/* 价值标尺行：短视频满血支持 vs Pro 长片全片覆盖 */}
                <div className="p-3 rounded-lg border border-primary/20 bg-primary/5 flex items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-2.5">
                    <span className="text-base">⏱️</span>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-foreground">{t('画面深度分析覆盖范围')}</span>
                        <span className="px-2 py-0.2 rounded-full font-medium bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20 text-[10px]">
                          {t('短视频满血支持 (前 5 分钟)')}
                        </span>
                      </div>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        {t('免费版享有高清与防漏检满血能力。超过 5 分钟的超长影视素材优先覆盖精彩前段，升级 Pro 会员可解锁整片全量深度分析。')}
                      </p>
                    </div>
                  </div>
                </div>

                {/* 三档大白话场景卡片 */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  {/* 档位 1: 极速归档 */}
                  <div
                    onClick={() => handleSelectVideoProfile('fast_archive')}
                    className={`relative overflow-hidden flex flex-col justify-between p-3.5 rounded-xl border-2 cursor-pointer transition-all ${
                      videoProfile === 'fast_archive'
                        ? 'border-primary bg-primary/10 shadow-sm ring-1 ring-primary/20'
                        : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
                    }`}
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

                      <div className="text-xs text-foreground font-medium bg-muted/60 p-2.5 rounded-lg border border-border/50 leading-relaxed italic">
                        {t('“我只用它整理归类，别在视频分析上耽误时间！”')}
                      </div>

                      <ul className="text-xs text-muted-foreground space-y-1 pt-1">
                        <li className="flex items-center gap-1.5">
                          <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0 stroke-[2.5]" />
                          <span>{t('提取智能文件名与分类标签')}</span>
                        </li>
                        <li className="flex items-center gap-1.5">
                          <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0 stroke-[2.5]" />
                          <span>{t('仅抓 8 张定格画面，不占算力')}</span>
                        </li>
                        <li className="flex items-center gap-1.5 text-muted-foreground/60">
                          <span className="w-3.5 text-center text-xs">✕</span>
                          <span>{t('不建密集画面搜索时间轴')}</span>
                        </li>
                      </ul>
                    </div>
                  </div>

                  {/* 档位 2: 均衡搜索 (日常推荐) */}
                  <div
                    onClick={() => handleSelectVideoProfile('balanced_search')}
                    className={`relative overflow-hidden flex flex-col justify-between p-3.5 rounded-xl border-2 cursor-pointer transition-all ${
                      videoProfile === 'balanced_search'
                        ? 'border-primary bg-primary/10 shadow-sm ring-1 ring-primary/20'
                        : 'border-border bg-card hover:border-primary/40 hover:bg-muted/30'
                    }`}
                  >
                    <div className="absolute top-0 right-0 text-[10px] font-semibold bg-primary text-primary-foreground px-2 py-0.5 rounded-bl-md shadow-sm">
                      {t('日常推荐')}
                    </div>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between pr-12">
                        <span className="font-bold text-sm text-foreground flex items-center gap-1.5">
                          ⚖️ {t('均衡搜索')}
                        </span>
                      </div>

                      <div className="text-xs text-foreground font-medium bg-muted/60 p-2.5 rounded-lg border border-border/50 leading-relaxed italic">
                        {t('“我偶尔会搜视频画面，整理分析别太慢就行。”')}
                      </div>

                      <ul className="text-xs text-muted-foreground space-y-1 pt-1">
                        <li className="flex items-center gap-1.5">
                          <Check className="h-3.5 w-3.5 text-primary shrink-0 stroke-[2.5]" />
                          <span>{t('可搜常规画面（如海滩、会议室）')}</span>
                        </li>
                        <li className="flex items-center gap-1.5">
                          <Check className="h-3.5 w-3.5 text-primary shrink-0 stroke-[2.5]" />
                          <span>{t('均匀抓取约 60 张关键画面')}</span>
                        </li>
                        <li className="flex items-center gap-1.5">
                          <Check className="h-3.5 w-3.5 text-primary shrink-0 stroke-[2.5]" />
                          <span>{t('识别前 60 秒语音台词标签')}</span>
                        </li>
                      </ul>
                      <div className="pt-0.5 text-[11px] font-mono text-primary font-medium">
                        {t('分析约 15~25 秒/片')}
                      </div>
                    </div>
                  </div>

                  {/* 档位 3: 深度寻帧 */}
                  <div
                    onClick={() => handleSelectVideoProfile('deep_footage')}
                    className={`relative overflow-hidden flex flex-col justify-between p-3.5 rounded-xl border-2 cursor-pointer transition-all ${
                      videoProfile === 'deep_footage'
                        ? 'border-amber-500 bg-amber-500/10 shadow-sm ring-1 ring-amber-500/20'
                        : 'border-border bg-card hover:border-amber-400 hover:bg-muted/30'
                    }`}
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

                      <div className="text-xs text-foreground font-medium bg-muted/60 p-2.5 rounded-lg border border-border/50 leading-relaxed italic">
                        {t('“我是剪辑找素材的，哪怕 1 秒闪过的跑车镜头也别漏！”')}
                      </div>

                      <ul className="text-xs text-muted-foreground space-y-1 pt-1">
                        <li className="flex items-center gap-1.5 font-medium text-amber-600 dark:text-amber-400">
                          <Check className="h-3.5 w-3.5 shrink-0 stroke-[2.5]" />
                          <span>{t('转场防漏检保护 (防画面被吞)')}</span>
                        </li>
                        <li className="flex items-center gap-1.5">
                          <Check className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0 stroke-[2.5]" />
                          <span>{t('逐镜头高清扫描 (150 张代表画面)')}</span>
                        </li>
                        <li className="flex items-center gap-1.5">
                          <Check className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0 stroke-[2.5]" />
                          <span>{t('瞬态特写捕捉 (防转场覆盖吞噬)')}</span>
                        </li>
                      </ul>
                    </div>
                  </div>
                </div>

                {/* 实时整理分析耗时预估图形化卡片（外层常驻可见，以每 5 分钟片段为绝对标尺测算，对齐 ISS-23） */}
                {(() => {
                  const est = estimateVideoAnalysisDurationSec(
                    videoQuotaMax,
                    localVideoSoftTokenBudget,
                    videoAsrCap,
                    false,
                    300
                  )
                  const totalMins = (est.totalSec / 60).toFixed(1)
                  // 以 5 分钟 (300s) 实时线为 100% 绝对量程标尺 (ISS-23: 彻底消除硬编码 200s 与虚假倍率)
                  const fillWidthPct = Math.min(100, Math.max(3, Math.round((est.perChunkSec / 300) * 100)))

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
                              {t('耗时仅在首次整理时发生一次；在全局搜索栏中搜索任意画面均为毫秒级瞬发。')}
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

                      {/* 全局绝对标尺刻度轨道（满格为 300 秒实时线量程，极速模式仅占极小一截） */}
                      <div className="space-y-1.5">
                        <div className="h-3 w-full bg-muted/60 rounded-full overflow-hidden flex relative p-0.5 border border-border/40">
                          {/* 动态填充条：总宽按 (perChunkSec / 300s) * 100% 决定 */}
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
                          <span className="text-primary/80 font-medium">300s ({t('实时线')})</span>
                        </div>

                        {/* 细分耗时图例与百分比 */}
                        <div className="flex items-center justify-between text-[11px] text-muted-foreground pt-0.5 flex-wrap gap-2">
                          <div className="flex items-center gap-3">
                            <span className="flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full bg-primary inline-block" />
                              <span>
                                {t('画面 AI 理解')}: <strong className="text-foreground">~{est.visualSec}s</strong> ({videoQuotaMax}{t('张')})
                              </span>
                            </span>
                            <span className="flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block" />
                              <span>
                                {t('台词识别')}: <strong className="text-foreground">~{est.asrSec}s</strong> ({videoAsrCap}s{t('音轨')})
                              </span>
                            </span>
                            <span className="flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full bg-muted-foreground/40 inline-block" />
                              <span>
                                {t('基础开销')}: <strong className="text-foreground">~{est.fixedSec}s</strong>
                              </span>
                            </span>
                          </div>
                          <span className="text-[10px] text-emerald-600 dark:text-emerald-400 font-semibold">
                            ⚡ {t('搜索时毫秒级瞬发响应')}
                          </span>
                        </div>
                      </div>

                      {/* 纯 CPU 深度档慢于实时播放时的贴心提示 (ISS-50) */}
                      {est.perChunkSec >= 300 && (
                        <div className="p-2.5 rounded-lg bg-purple-500/10 border border-purple-500/20 text-xs text-purple-700 dark:text-purple-300 flex items-center gap-2">
                          <span>💡</span>
                          <span>{t('这个档位在没有独立显卡的电脑上，整理会比视频本身更慢，适合放在后台慢慢整理；配备独立显卡时可获得数倍流畅提速。')}</span>
                        </div>
                      )}

                      {/* 免费会员权益中性说明与 Pro 升级引导 (ISS-01 / ISS-54) */}
                      {isFreeUser && (
                        <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/25 flex items-center justify-between gap-3 flex-wrap transition-all">
                          <div className="flex items-center gap-2.5 min-w-0 flex-1">
                            <Crown className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
                            <div className="text-xs leading-relaxed">
                              <span className="font-bold text-amber-700 dark:text-amber-300">
                                {t('免费版每个视频分析精彩前 5 分钟')}
                              </span>
                              <span className="text-muted-foreground ml-1">
                                {t('（长视频仅分析前 300 秒）。升级 Pro 会员可解锁整部视频全量分析，支持单视频长达 2 小时以上。')}
                              </span>
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

                {/* 折叠的高级微调面板 */}
                <div className="border border-border/60 rounded-xl overflow-hidden bg-card">
                  <div
                    onClick={() => setIsProPanelOpen(!isProPanelOpen)}
                    className="flex items-center justify-between p-3.5 bg-muted/30 cursor-pointer hover:bg-muted/60 transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      {isProPanelOpen ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground transition-transform" />
                      )}
                      <span className="text-xs font-bold text-foreground">
                        {t('高级参数微调')}
                      </span>
                      {videoProfile === 'custom' && (
                        <span className="text-[10px] bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 font-semibold px-2 py-0.2 rounded-full">
                          {t('已自定义')}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground">
                        {t('自由把控分析耗时与抓图敏锐度')}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          handleSelectVideoProfile('balanced_search')
                        }}
                        className="text-xs text-primary hover:underline"
                      >
                        {t('恢复档位默认')}
                      </button>
                    </div>
                  </div>

                  {isProPanelOpen && (
                    <div className="p-4 space-y-4 border-t border-border/40">
                      {/* 控件 1: 单视频最大抓图数量 */}
                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between">
                          <Label className="text-xs font-semibold text-foreground">
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
                          onChange={(e) =>
                            handleCustomParamChange({ quotaMax: parseInt(e.target.value, 10) })
                          }
                          className="w-full accent-primary cursor-pointer"
                        />
                        <p className="text-[11px] text-muted-foreground">
                          {t('单个视频最多提取多少张关键画面送入 AI 理解。抓图越多，长视频里的细碎镜头越不容易漏，但首次整理分析耗时会相应增加。')}
                        </p>
                      </div>

                      {/* 控件 2: 镜头切换捕捉敏锐度 */}
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
                          <button
                            type="button"
                            onClick={() => handleCustomParamChange({ cutSensitivity: 'low' })}
                            className={`p-2 rounded-lg border text-xs font-medium text-left transition-all ${
                              videoCutSensitivity === 'low'
                                ? 'border-primary bg-primary/10'
                                : 'border-border hover:border-primary/40'
                            }`}
                          >
                            <div className="font-bold text-foreground">{t('常规')}</div>
                            <div className="text-[10px] text-muted-foreground mt-0.5">
                              {t('仅抓取全片核心大场景')}
                            </div>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleCustomParamChange({ cutSensitivity: 'medium' })}
                            className={`p-2 rounded-lg border text-xs font-medium text-left transition-all ${
                              videoCutSensitivity === 'medium'
                                ? 'border-primary bg-primary/10'
                                : 'border-border hover:border-primary/40'
                            }`}
                          >
                            <div className="font-bold text-primary">{t('灵敏 (推荐)')}</div>
                            <div className="text-[10px] text-primary/80 mt-0.5">
                              {t('标准分段挑选代表画面')}
                            </div>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleCustomParamChange({ cutSensitivity: 'high' })}
                            className={`p-2 rounded-lg border text-xs font-medium text-left transition-all ${
                              videoCutSensitivity === 'high'
                                ? 'border-amber-500 bg-amber-500/10'
                                : 'border-border hover:border-amber-400'
                            }`}
                          >
                            <div className="font-bold text-amber-600 dark:text-amber-400">{t('极高 (防吞噬)')}</div>
                            <div className="text-[10px] text-amber-600/80 mt-0.5">
                              {t('救回 1.6 秒跑车特写')}
                            </div>
                          </button>
                        </div>
                      </div>

                      {/* 控件 3: 画面识别精细度 */}
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
                            className={`p-2.5 rounded-lg border text-xs font-medium text-left transition-all ${
                              localVideoSoftTokenBudget <= 48
                                ? 'border-primary bg-primary/10'
                                : 'border-border hover:border-primary/40'
                            }`}
                          >
                            <div className="font-bold text-primary">{t('流畅极速')}</div>
                            <div className="text-[10px] text-muted-foreground mt-0.5">
                              {t('整理分析速度翻倍，适合批量整理与轻薄本')}
                            </div>
                          </button>
                          <button
                            type="button"
                            onClick={() => handleCustomParamChange({ softTokenBudget: 140 })}
                            className={`p-2.5 rounded-lg border text-xs font-medium text-left transition-all ${
                              localVideoSoftTokenBudget > 48
                                ? 'border-primary bg-primary/10'
                                : 'border-border hover:border-primary/40'
                            }`}
                          >
                            <div className="font-bold text-foreground">{t('高清精细')}</div>
                            <div className="text-[10px] text-muted-foreground mt-0.5">
                              {t('主体与微小细节识别更准，建议独立显卡开启')}
                            </div>
                          </button>
                        </div>
                      </div>

                      {/* 控件 4: 视频伴音台词识别上限 */}
                      <div className="space-y-1.5 pt-2 border-t border-border/30">
                        <div className="flex items-center justify-between">
                          <Label className="text-xs font-semibold text-foreground">
                            {t('视频伴音台词识别上限')}
                          </Label>
                          <span className="text-xs font-mono font-bold bg-muted px-2 py-0.5 rounded text-primary">
                            {videoAsrCap} {t('秒')}
                          </span>
                        </div>
                        <input
                          type="range"
                          min={15}
                          max={180}
                          step={15}
                          value={videoAsrCap}
                          onChange={(e) =>
                            handleCustomParamChange({ asrCap: parseInt(e.target.value, 10) })
                          }
                          className="w-full accent-primary cursor-pointer"
                        />
                        <p className="text-[11px] text-muted-foreground">
                          {t('仅提取视频开头前 N 秒的音轨台词（不影响纯音频）。识别越长台词标签越全，分析耗时稍长。')}
                        </p>
                      </div>

                      
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/*
        工单 13：视觉语义搜索（Chinese-CLIP / MobileCLIP 文本塔）开关与索引重建入口。
        - 仅在极速轻量档开启时显示，全模态标准档隐藏；
        - 支持中文（Chinese-CLIP）与多语言（MobileCLIP）；
        - 重建计数来自工单 06 的 canonical 维护服务，失败只在设置页提示一次（不弹全局 toast）。
      */}
      {embeddingProfile === 'classic_light' && (
        <Card className="p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-violet-500 flex-shrink-0" />
                <Label className="text-sm font-medium text-foreground">
                  {t('视觉语义搜索')}
                  <HelpTooltip
                    content={t(
                      '用自然语言描述画面（如「红色的跑车」「左边的沙发」）来搜索图片。支持中文与多语言检索；首次使用需要加载视觉模型，可能等待数秒。'
                    )}
                  />
                </Label>
              </div>
              <p className="text-[11px] text-muted-foreground mt-1.5 leading-snug">
                {t('开启后可用画面描述检索图片；低配设备可关闭以节省内存。')}
              </p>
            </div>
            <Switch
              checked={clipTextEnabled}
              onCheckedChange={checked => {
                void updateConfigValue('AI_CLIP_TEXT_SEARCH_ENABLED', checked)
              }}
              aria-label={t('视觉语义搜索')}
            />
          </div>

          <div className="mt-4 pt-4 border-t border-border/60">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <Label className="text-sm font-medium text-foreground">
                  {t('语义索引状态')}
                </Label>
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
                {!rebuildError && rebuildCounts && rebuildCounts.lastMaintenance && (
                  <p className="text-[11px] text-muted-foreground/80 mt-1 leading-snug">
                    {t('最近一次重建：{reason}，失效 {invalidated} 项，重新入队 {requeued} 项', {
                      reason: rebuildCounts.lastMaintenance.reason,
                      invalidated: rebuildCounts.lastMaintenance.invalidated,
                      requeued: rebuildCounts.lastMaintenance.requeued
                    })}
                  </p>
                )}
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
                <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isRebuilding ? 'animate-spin' : ''}`} />
                {isRebuilding ? t('重建中…') : t('重建语义索引')}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* 模式切换确认弹窗 */}
      <AlertDialog open={!!pendingProfile} onOpenChange={open => {
        if (!open) {
          setPendingProfile(null)
          setPendingVideoRecommendation(false)
        }
      }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('确认切换智能理解模式？')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 pt-1 text-sm text-muted-foreground">
                <p>
                  {t(
                    '即将切换为【{profile}】模式。切换后系统将自动重启 AI 引擎。',
                    {
                      profile: pendingProfile === 'gemma_unified' ? t('全模态标准档') : t('极速轻量档')
                    }
                  )}
                </p>
                <div className="p-3 bg-amber-500/10 border border-amber-500/20 rounded-md text-amber-600 dark:text-amber-400 text-xs leading-relaxed space-y-1">
                  <p className="font-semibold">{t('⚠️ 注意事项与生效机制：')}</p>
                  <p>{t('1. 新导入的文件：将立即自动采用新模式进行深度特征分析；')}</p>
                  <p>{t('2. 已经分析过的旧文件：历史数据仍安全保留。如需让旧文件享受新模式的搜索特性，需在文件列表中右键选择「重新分析」。')}</p>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('取消')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmProfileSwitch}>
              {t('立即应用并重启引擎')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <UpgradeAccountDialog open={isUpgradeOpen} onOpenChange={setIsUpgradeOpen} />

      {/* 精度切换确认弹窗 */}
      <AlertDialog open={!!pendingDimension} onOpenChange={open => !open && setPendingDimension(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('确认切换特征分析精度？')}</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 pt-1 text-sm text-muted-foreground">
                <p>
                  {t(
                    '即将把特征分析精度调整为【{level}（{dim} 维）】。',
                    {
                      level:
                        pendingDimension === 768
                          ? t('旗舰精准档')
                          : pendingDimension === 512
                            ? t('标准平衡档')
                            : t('紧凑省盘档'),
                      dim: pendingDimension ?? 512
                    }
                  )}
                </p>
                <div className="p-3 bg-blue-500/10 border border-blue-500/20 rounded-md text-blue-600 dark:text-blue-400 text-xs leading-relaxed space-y-1">
                  <p className="font-semibold">{t('⚠️ 生效机制说明：')}</p>
                  <p>{t('1. 新导入的文件：将直接以 {dim} 维精度生成特征索引；', { dim: pendingDimension ?? 512 })}</p>
                  <p>{t('2. 已分析的旧文件：旧特征索引不受破坏，但若要在搜索时享受当前精度的匹配效果，需在文件列表中执行「重新分析」。')}</p>
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('取消')}</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDimensionSwitch}>
              {t('确认调整精度')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
