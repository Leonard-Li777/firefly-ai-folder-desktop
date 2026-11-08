import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import {
  WorkspaceDirectory,
  WorkspaceConfig,
  WorkspaceConfigIntent,
  TechnicalEngineParameters,
  parseWorkspaceConfig,
  isWorkspaceConfigReady,
  HardwareInfo,
  UserTier
} from '@firefly/types'
import { mapIntentToParameters } from '@firefly/shared'
import { useTierStore } from '../../stores/tier-store'
import { Card } from '../ui/card'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel
} from '../ui/alert-dialog'
import { MaterialIcon, cn } from '../../lib/utils'
import { toast } from '../common/Toast'
import { t } from '@app/languages'
import {
  Sparkles,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  Save,
  Sliders,
  Check,
  FileText,
  Image as ImageIcon,
  Film,
  FolderArchive,
  Layers,
  Cpu,
  Loader2,
  AlertCircle
} from 'lucide-react'

interface WorkspaceConfigPanelProps {
  workspace: WorkspaceDirectory
  hardwareInfo?: HardwareInfo | null
  onConfigSaved?: () => void
  onResetRequested?: () => void
}

/** 四大意图卡片动态获取函数 (遵从 AGENTS.md §2.6 避坑铁律，支持运行时国际化动态切换) */
export function getIntentCards(): Array<{
  id: WorkspaceConfigIntent
  icon: string
  title: string
  subtitle: string
  description: string
  badge: string
}> {
  return [
    {
      id: 'fast_archive',
      icon: 'description',
      title: t('极速整理与文档'),
      subtitle: t('文档 / 文献 / 电子书 / 代码'),
      description: t('高精度 OCR、深度长文本提取、零星视频极速索引，极致轻量省电。'),
      badge: t('⚡ 极速整理')
    },
    {
      id: 'visual_gallery',
      icon: 'photo_library',
      title: t('创意图库与设计'),
      subtitle: t('照片 / 插画 / 设计稿 / 素材'),
      description: t('多模态视觉打标、高频图片 OCR、略过长伴音转录，专注于画面理解。'),
      badge: t('🎨 创意图库')
    },
    {
      id: 'footage_studio',
      icon: 'movie',
      title: t('影视与剪辑素材'),
      subtitle: t('长视频 / 寻帧 / 分镜 / 音频'),
      description: t('关键帧敏锐切片、全时长伴音台词提取，释放 GPU 多媒体算力。'),
      badge: t('🎬 影视素材')
    },
    {
      id: 'chaotic_inbox',
      icon: 'inventory_2',
      title: t('桌面与下载混合'),
      subtitle: t('多类型杂乱 / 收集箱 / 临时下载'),
      description: t('均衡多模态提炼、自适应硬件算力方程，快速规整杂乱目录。'),
      badge: t('🌪️ 桌面杂乱')
    }
  ]
}

/**
 * 获取场景意图的本地化友好展示名 (严格遵守 AGENTS.md §2.3 Egress 阶段反查展示名铁律)
 */
export function getIntentDisplayName(intent?: WorkspaceConfigIntent | string | null): string {
  switch (intent) {
    case 'fast_archive':
      return t('极速整理与文档')
    case 'visual_gallery':
      return t('创意图库与设计')
    case 'footage_studio':
      return t('影视与剪辑素材')
    case 'chaotic_inbox':
      return t('桌面与下载混合')
    case 'custom':
      return t('深度自定义')
    default:
      return t('未指定')
  }
}

export const WorkspaceConfigPanel: React.FC<WorkspaceConfigPanelProps> = ({
  workspace,
  hardwareInfo,
  onConfigSaved,
  onResetRequested
}) => {
  // 1. 本地状态与嗅探数据
  const [profileResult, setProfileResult] = useState<any | null>(null)
  const [isProbing, setIsProbing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const hasUserInteractedRef = useRef(false)

  // 动态意图卡片列表
  const intentCards = useMemo(() => getIntentCards(), [])

  // RV-04: 用户会员层级检测（中性告知长视频体验范围与续作机制，带冷启动默认 FREE 兜底）
  const tier = useTierStore(s => s.tier)
  const isFreeTier = (tier ?? UserTier.FREE) === UserTier.FREE

  // 当前激活配置解析
  const parsedConfig = useMemo<WorkspaceConfig>(() => {
    return parseWorkspaceConfig(workspace.workspace_config)
  }, [workspace.workspace_config])

  const initialIntent: WorkspaceConfigIntent = useMemo(() => {
    if (parsedConfig.status === 'ready') {
      return parsedConfig.intent || 'fast_archive'
    }
    return 'fast_archive'
  }, [parsedConfig])

  const [selectedIntent, setSelectedIntent] = useState<WorkspaceConfigIntent>(initialIntent)
  const [overrides, setOverrides] = useState<Partial<TechnicalEngineParameters>>(() => {
    if (parsedConfig.status === 'ready' && parsedConfig.overrides) {
      return { ...parsedConfig.overrides }
    }
    return {}
  })

  // 切换场景/工作流意图二次确认弹窗状态 (方案 B: 参数分层与定案保护)
  const [showSwitchConfirm, setShowSwitchConfirm] = useState(false)
  const [pendingIntent, setPendingIntent] = useState<WorkspaceConfigIntent | null>(null)

  const handleIntentCardSelect = (targetIntent: WorkspaceConfigIntent) => {
    hasUserInteractedRef.current = true
    if (targetIntent === selectedIntent) return
    const hasCustomOverrides =
      Object.keys(overrides).length > 0 ||
      Boolean(parsedConfig.status === 'ready' && parsedConfig.customIgnoreRules?.length)
    if (hasCustomOverrides) {
      setPendingIntent(targetIntent)
      setShowSwitchConfirm(true)
    } else {
      setSelectedIntent(targetIntent)
      setOverrides({})
    }
  }

  const handleConfirmPreserveOverrides = () => {
    if (pendingIntent) {
      setSelectedIntent(pendingIntent)
      toast.success(t('已切换场景，已保留您的自定义高级参数'))
    }
    setShowSwitchConfirm(false)
    setPendingIntent(null)
  }

  const handleConfirmResetOverrides = () => {
    if (pendingIntent) {
      setSelectedIntent(pendingIntent)
      setOverrides({})
      toast.success(t('已切换场景，高级参数已重置为默认值'))
    }
    setShowSwitchConfirm(false)
    setPendingIntent(null)
  }

  // 同步外部 workspace 变化
  useEffect(() => {
    const fresh = parseWorkspaceConfig(workspace.workspace_config)
    if (fresh.status === 'ready') {
      setSelectedIntent(fresh.intent || 'fast_archive')
      setOverrides(fresh.overrides ? { ...fresh.overrides } : {})
    } else {
      setSelectedIntent('fast_archive')
      setOverrides({})
    }
    hasUserInteractedRef.current = false
  }, [workspace.id, workspace.workspace_config])

  // 2. 异步探测目录画像
  useEffect(() => {
    let cancelled = false
    const probe = async () => {
      if (!window.electronAPI?.utils?.probeDirectoryProfile || !workspace.path) return
      setIsProbing(true)
      try {
        const result = await window.electronAPI.utils.probeDirectoryProfile(workspace.path)
        if (!cancelled && result) {
          setProfileResult(result)
          // 若当前工作区仍处于 pending 状态且用户尚未手动交互选中，自动采纳 Profiler 推荐的高置信度意图
          if (
            parsedConfig.status === 'pending' &&
            result.confidence > 0 &&
            !hasUserInteractedRef.current
          ) {
            setSelectedIntent(result.detectedIntent)
          }
        }
      } catch (err) {
        console.warn('嗅探目录画像失败:', err)
      } finally {
        if (!cancelled) setIsProbing(false)
      }
    }

    probe()
    return () => {
      cancelled = true
    }
  }, [workspace.id, workspace.path, parsedConfig.status])

  // 3. 计算当前意图与硬件推导的有效参数
  const effectiveParams = useMemo(() => {
    return mapIntentToParameters(selectedIntent, hardwareInfo, overrides)
  }, [selectedIntent, hardwareInfo, overrides])

  // 推荐信息提示
  const isRecommended = useCallback(
    (intentId: WorkspaceConfigIntent) => {
      return (
        profileResult && profileResult.detectedIntent === intentId && profileResult.confidence > 0
      )
    },
    [profileResult]
  )

  // 4. 保存配置并解除调度门闩
  const handleSaveConfig = async () => {
    if (!workspace.id) {
      toast.error(t('工作区 ID 无效'))
      return
    }
    setIsSaving(true)
    try {
      let actualHw = hardwareInfo
      if (!actualHw && window.electronAPI?.getHardwareInfo) {
        try {
          actualHw = await window.electronAPI.getHardwareInfo()
        } catch {
          // fallback
        }
      }

      const derivedSnapshot = mapIntentToParameters(selectedIntent, actualHw)
      const hasOverrides = Object.keys(overrides).length > 0

      const readyConfig: WorkspaceConfig = {
        schemaVersion: 1,
        status: 'ready',
        intent: selectedIntent,
        policyVersion: parsedConfig.status === 'ready' ? parsedConfig.policyVersion || 1 : 1,
        baseAIConfig: derivedSnapshot,
        derivedSnapshot,
        overrides: hasOverrides ? overrides : undefined,
        customIgnoreRules:
          parsedConfig.status === 'ready' && parsedConfig.customIgnoreRules
            ? parsedConfig.customIgnoreRules
            : [],
        customWhitelistRules:
          parsedConfig.status === 'ready' && parsedConfig.customWhitelistRules
            ? parsedConfig.customWhitelistRules
            : [],
        configuredAt: Date.now()
      }

      if (window.electronAPI?.updateWorkspaceConfig) {
        const res = await window.electronAPI.updateWorkspaceConfig(workspace.id, readyConfig)
        if (res.success) {
          toast.success(t('工作区配置已保存，AI 分析队列已就绪'))
          onConfigSaved?.()
        } else {
          toast.error(res.error || t('保存失败'))
        }
      }
    } catch (error: any) {
      toast.error(error?.message || t('保存工作区配置异常'))
    } finally {
      setIsSaving(false)
    }
  }

  // 参数微调修改助手
  const handleOverrideChange = <K extends keyof TechnicalEngineParameters>(
    key: K,
    value: TechnicalEngineParameters[K]
  ) => {
    setOverrides(prev => {
      const next = { ...prev, [key]: value }
      return next
    })
  }

  return (
    <div className="space-y-5">
      {/* 头部与画像嗅探摘要 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-xl bg-muted/40 border border-border/60">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
            <MaterialIcon icon="tune" className="text-xl" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h4 className="font-bold text-base truncate">{workspace.name}</h4>
              {parsedConfig.status === 'ready' ? (
                <span className="text-xs px-2 py-0.5 rounded-full bg-green-500/15 text-green-600 dark:text-green-400 font-medium shrink-0">
                  {t('已就绪')}
                </span>
              ) : (
                <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 font-medium shrink-0">
                  {t('待配置 (队列挂起)')}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground truncate mt-0.5">{workspace.path}</p>
          </div>
        </div>

        {/* 嗅探状态与扩展名徽标 */}
        <div className="flex items-center gap-2 text-xs shrink-0">
          {isProbing ? (
            <div className="flex items-center gap-1.5 text-muted-foreground bg-background/60 px-2.5 py-1 rounded-lg border border-border/40">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
              <span>{t('嗅探目录事实中...')}</span>
            </div>
          ) : profileResult?.stats ? (
            <div className="flex items-center gap-1.5 text-muted-foreground bg-background/80 px-2.5 py-1 rounded-lg border border-border/40 shadow-xs">
              <Sparkles className="w-3.5 h-3.5 text-amber-500" />
              <span>{t('已采样 {count} 文件', { count: profileResult.stats.totalSampled })}</span>
              {profileResult.stats.topExtensions?.length > 0 && (
                <span className="text-primary font-medium">
                  (
                  {profileResult.stats.topExtensions
                    .slice(0, 3)
                    .map((e: any) => `${e.ext} ${e.count}`)
                    .join(', ')}
                  )
                </span>
              )}
            </div>
          ) : null}
        </div>
      </div>

      {/* 四大意图卡片网格 */}
      <div className="space-y-2.5">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-semibold flex items-center gap-1.5">
            <span>{t('选择场景模式')}</span>
            <span className="text-xs font-normal text-muted-foreground">
              {t('(根据文件类型自动自适应)')}
            </span>
          </Label>
          {profileResult && profileResult.confidence > 0 && (
            <span className="text-xs text-primary font-medium flex items-center gap-1">
              <Sparkles className="w-3 h-3" />
              {t('推荐: {name} (置信度 {pct}%)', {
                name: intentCards.find(c => c.id === profileResult.detectedIntent)?.title || '',
                pct: Math.round(profileResult.confidence * 100)
              })}
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {intentCards.map(card => {
            const isSelected = selectedIntent === card.id
            const recommended = isRecommended(card.id)

            return (
              <div
                key={card.id}
                role="button"
                tabIndex={0}
                onClick={() => handleIntentCardSelect(card.id)}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    handleIntentCardSelect(card.id)
                  }
                }}
                className={cn(
                  'relative flex flex-col p-3.5 rounded-xl border text-left cursor-pointer transition-all duration-200 select-none group',
                  isSelected
                    ? 'bg-primary/5 dark:bg-primary/10 border-primary shadow-sm shadow-primary/10 ring-1 ring-primary/40'
                    : 'bg-card hover:bg-muted/30 border-border/70 hover:border-border'
                )}
              >
                {/* 推荐角标 */}
                {recommended && (
                  <div className="absolute top-2.5 right-2.5 flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400">
                    <Sparkles className="w-2.5 h-2.5" />
                    <span>{t('推荐')}</span>
                  </div>
                )}

                <div className="flex items-center gap-2.5 mb-1.5">
                  <div
                    className={cn(
                      'w-7 h-7 rounded-lg flex items-center justify-center transition-colors',
                      isSelected
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-muted-foreground group-hover:text-foreground'
                    )}
                  >
                    <MaterialIcon icon={card.icon} className="text-base" />
                  </div>
                  <div>
                    <h5 className="font-bold text-sm leading-snug">{card.title}</h5>
                    <p className="text-[11px] text-muted-foreground leading-tight">
                      {card.subtitle}
                    </p>
                  </div>
                </div>

                <p className="text-xs text-muted-foreground/90 leading-relaxed mt-1 flex-1">
                  {card.description}
                </p>

                <div className="flex items-center justify-between mt-3 pt-2 border-t border-border/40 text-[11px]">
                  <span className="font-medium text-muted-foreground">{card.badge}</span>
                  {isSelected && (
                    <span className="text-primary font-bold flex items-center gap-0.5">
                      <Check className="w-3.5 h-3.5" />
                      {t('已选用')}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* RV-04: 影视剪辑素材场景 Free/Pro 权益中性告知 */}
        {isFreeTier && selectedIntent === 'footage_studio' && (
          <div className="flex items-center gap-2 p-2.5 rounded-lg bg-primary/5 border border-primary/20 text-xs text-muted-foreground mt-2">
            <Sparkles className="w-3.5 h-3.5 text-primary shrink-0" />
            <span>{t('当前体验首个 5 分钟切片分析，升级 Pro 可流式续作自动处理全片')}</span>
          </div>
        )}
      </div>

      {/* 高级专家微调 (折叠面板) */}
      <div className="border border-border/60 rounded-xl overflow-hidden bg-card">
        <button
          type="button"
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="w-full flex items-center justify-between p-3.5 text-left text-sm font-semibold hover:bg-muted/30 transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-2">
            <Sliders className="w-4 h-4 text-primary" />
            <span>{t('高级专家微调')}</span>
            <span className="text-xs font-normal text-muted-foreground">
              {Object.keys(overrides).length > 0
                ? t('(已覆盖 {count} 项参数)', { count: Object.keys(overrides).length })
                : t('(默认继承策略推荐，无需改动)')}
            </span>
          </div>
          {showAdvanced ? (
            <ChevronUp className="w-4 h-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          )}
        </button>

        {showAdvanced && (
          <div className="p-4 pt-2 border-t border-border/40 space-y-4 text-xs bg-muted/10">
            {/* 分析模式选择 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <Label className="text-xs font-medium mb-1.5 block">
                  {t('分析模式 (Analysis Mode)')}
                </Label>
                <select
                  value={effectiveParams.analysisMode}
                  onChange={e =>
                    handleOverrideChange(
                      'analysisMode',
                      e.target.value as 'simple' | 'quick_name' | 'full'
                    )
                  }
                  className="w-full p-2 rounded-lg border border-border bg-background text-foreground text-xs"
                >
                  <option value="simple">{t('极速标准 (simple) - 基础标签与智能名')}</option>
                  <option value="quick_name">
                    {t('增强润色 (quick_name) - 推荐，平衡速度与深度')}
                  </option>
                  <option value="full">{t('全面深度 (full) - 全多模态深度理解')}</option>
                </select>
              </div>

              {/* 图像 OCR 开关与精度 */}
              <div>
                <Label className="text-xs font-medium mb-1.5 block">{t('图片 OCR 识别')}</Label>
                <div className="flex items-center gap-3 p-1.5 bg-background rounded-lg border border-border">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={effectiveParams.enableImageOcr}
                      onChange={e => handleOverrideChange('enableImageOcr', e.target.checked)}
                      className="rounded border-border"
                    />
                    <span>{t('开启 OCR')}</span>
                  </label>
                  {effectiveParams.enableImageOcr && (
                    <select
                      value={effectiveParams.ocrModelSize}
                      onChange={e =>
                        handleOverrideChange('ocrModelSize', e.target.value as 'tiny' | 'small')
                      }
                      className="ml-auto p-1 rounded border border-border bg-muted/30 text-xs"
                    >
                      <option value="tiny">{t('极速微型 (tiny)')}</option>
                      <option value="small">{t('标准高精 (small)')}</option>
                    </select>
                  )}
                </div>
              </div>
            </div>

            {/* 视频分析算力控制 */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <Label className="text-xs font-medium mb-1 block">
                  {t('视频软预算 (Soft Tokens)')}
                </Label>
                <select
                  value={effectiveParams.videoSoftTokenBudget}
                  onChange={e =>
                    handleOverrideChange('videoSoftTokenBudget', Number(e.target.value) as 48 | 140)
                  }
                  className="w-full p-1.5 rounded-lg border border-border bg-background text-xs"
                >
                  <option value={48}>{t('48 tokens (流畅低负载)')}</option>
                  <option value={140}>{t('140 tokens (超清精细)')}</option>
                </select>
              </div>

              <div>
                <Label className="text-xs font-medium mb-1 block">
                  {t('台词转录秒数 (ASR Cap)')}
                </Label>
                <input
                  type="number"
                  min={0}
                  max={90}
                  value={effectiveParams.videoAsrDurationSec}
                  onChange={e => {
                    const val = Number(e.target.value)
                    if (Number.isFinite(val)) {
                      handleOverrideChange(
                        'videoAsrDurationSec',
                        Math.min(90, Math.max(0, Math.round(val)))
                      )
                    }
                  }}
                  className="w-full p-1.5 rounded-lg border border-border bg-background text-xs"
                />
              </div>

              <div>
                <Label className="text-xs font-medium mb-1 block">{t('镜头切片敏锐度')}</Label>
                <select
                  value={effectiveParams.videoCutSensitivity}
                  onChange={e =>
                    handleOverrideChange(
                      'videoCutSensitivity',
                      e.target.value as 'low' | 'medium' | 'high'
                    )
                  }
                  className="w-full p-1.5 rounded-lg border border-border bg-background text-xs"
                >
                  <option value="low">{t('平缓长镜头 (low)')}</option>
                  <option value="medium">{t('常规灵敏 (medium)')}</option>
                  <option value="high">{t('高密多镜头 (high)')}</option>
                </select>
              </div>
            </div>

            {/* 纯音频与文本提取算力控制 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs font-medium mb-1 block">
                  {t('纯音频分析时长 (Audio Duration)')}
                </Label>
                <select
                  value={effectiveParams.audioAnalysisDurationSec}
                  onChange={e =>
                    handleOverrideChange(
                      'audioAnalysisDurationSec',
                      Number(e.target.value) as 15 | 30 | 60 | 120 | 180
                    )
                  }
                  className="w-full p-1.5 rounded-lg border border-border bg-background text-xs"
                >
                  <option value={15}>{t('15秒 (快速摘要)')}</option>
                  <option value={30}>{t('30秒 (常规)')}</option>
                  <option value={60}>{t('60秒 (均衡深入)')}</option>
                  <option value={120}>{t('120秒 (高精理解)')}</option>
                  <option value={180}>{t('180秒 (超长解析)')}</option>
                </select>
              </div>

              <div>
                <Label className="text-xs font-medium mb-1 block">
                  {t('长文本提取上限 (Max Content Size)')}
                </Label>
                <select
                  value={effectiveParams.maxContentSizeKb}
                  onChange={e =>
                    handleOverrideChange(
                      'maxContentSizeKb',
                      Number(e.target.value) as 15 | 30 | 60 | 120
                    )
                  }
                  className="w-full p-1.5 rounded-lg border border-border bg-background text-xs"
                >
                  <option value={15}>{t('15 KB (轻量速览)')}</option>
                  <option value={30}>{t('30 KB (标准文档)')}</option>
                  <option value={60}>{t('60 KB (大篇幅文本)')}</option>
                  <option value={120}>{t('120 KB (超长专业文献)')}</option>
                </select>
              </div>
            </div>

            {/* 向量空间与硬件只读信息 */}
            <div className="p-2.5 rounded-lg bg-background/80 border border-border/40 flex items-center justify-between text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5 text-primary" />
                <span>
                  {t('当前工作区向量空间: {profile} ({dim}维)', {
                    profile: effectiveParams.embeddingProfile,
                    dim: effectiveParams.mrlDimension
                  })}
                </span>
              </div>
              <span className="text-[11px] opacity-75">{t('根据全机硬件自动锁定')}</span>
            </div>
          </div>
        )}
      </div>

      {/* 底部操作工具栏 */}
      <div className="flex items-center justify-between pt-2">
        {onResetRequested && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onResetRequested}
            className="text-destructive hover:bg-destructive/10 border-destructive/30"
          >
            <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
            <span>{t('重置分析数据...')}</span>
          </Button>
        )}

        <div className="flex items-center gap-2 ml-auto">
          <Button
            type="button"
            size="sm"
            onClick={handleSaveConfig}
            disabled={isSaving}
            className="px-4"
          >
            {isSaving ? (
              <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
            ) : (
              <Save className="w-3.5 h-3.5 mr-1.5" />
            )}
            <span>{t('保存并应用策略')}</span>
          </Button>
        </div>
      </div>

      {/* 切换工作流/场景二次确认定案弹窗 (方案 B: 参数分层与定案保护) */}
      <AlertDialog open={showSwitchConfirm} onOpenChange={setShowSwitchConfirm}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              <span>{t('切换工作流与技术参数确认')}</span>
            </AlertDialogTitle>
            <AlertDialogDescription className="text-xs leading-relaxed text-muted-foreground pt-1">
              {t(
                '切换工作流将更新底层模板规则与技术参数。检测到您曾自定义过【高级参数】，是否重置？'
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex flex-col sm:flex-col gap-2 pt-2">
            <Button
              type="button"
              variant="default"
              size="sm"
              className="w-full text-xs font-semibold justify-center h-9"
              onClick={handleConfirmPreserveOverrides}
            >
              {t('仅更新工作流模板，保留我的自定义设置(推荐)')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full text-xs font-semibold justify-center h-9 border-destructive/40 text-destructive hover:bg-destructive/10"
              onClick={handleConfirmResetOverrides}
            >
              {t('彻底重置为新工作流默认值')}
            </Button>
            <AlertDialogCancel
              className="w-full text-xs h-8 mt-1"
              onClick={() => {
                setShowSwitchConfirm(false)
                setPendingIntent(null)
              }}
            >
              {t('取消')}
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
