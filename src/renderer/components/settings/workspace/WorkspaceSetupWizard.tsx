import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import {
  WorkspaceDirectory,
  WorkspaceConfig,
  WorkspaceConfigIntent,
  parseWorkspaceConfig,
  HardwareInfo,
  UserTier
} from '@firefly/types'
import { mapIntentToParameters } from '@firefly/shared'
import { useTierStore } from '../../../stores/tier-store'
import { Button } from '../../ui/button'
import { Label } from '../../ui/label'
import { MaterialIcon, cn } from '../../../lib/utils'
import { toast } from '../../common/Toast'
import { t } from '@app/languages'
import {
  Sparkles,
  Check,
  Loader2,
  ArrowRight,
  Sliders,
  FolderOpen,
  FileText,
  Image as ImageIcon,
  Film,
  Package,
  CheckCircle2,
  Cpu
} from 'lucide-react'
import { getIntentCards } from '../WorkspaceConfigPanel'

export interface WorkspaceSetupWizardProps {
  workspace: WorkspaceDirectory
  hardwareInfo?: HardwareInfo | null
  /**
   * 完成向导后的流转回调
   * @param mode 'complete' 自动完成并关闭弹窗；'customize' 切入高级 4-Tab 自定义
   */
  onFinish: (mode: 'complete' | 'customize', readyConfig: WorkspaceConfig) => void
}

/** 目录嗅探画像统计结构 */
interface ProfileStats {
  totalSampled: number
  docCount: number
  imageCount: number
  videoCount: number
  otherCount: number
  topExtensions: Array<{ ext: string; count: number }>
  durationMs: number
  hitTimeBudget: boolean
}

interface DirectoryProfileResult {
  detectedIntent: WorkspaceConfigIntent
  confidence: number
  stats: ProfileStats
}

/**
 * 工作目录智能配置向导
 *
 * 核心设计升级：
 * 1. 直白阐明目标：专为当前所选工作目录自动配置 AI 分析策略；
 * 2. 强烈突出目录文件特征扫描画像（分布百分比、扩展名占比、诊断结论），让用户明确知晓“为什么推荐该策略”；
 * 3. 场景卡片强化视觉感知（发光徽章、匹配契合度、专属调优收益）；
 * 4. “深度自定义设置”重构为直观醒目的「我想要更个性化的设置」，双通道分流清晰明朗。
 */
export const WorkspaceSetupWizard: React.FC<WorkspaceSetupWizardProps> = ({
  workspace,
  hardwareInfo,
  onFinish
}) => {
  const [profileResult, setProfileResult] = useState<DirectoryProfileResult | null>(null)
  const [isProbing, setIsProbing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const hasUserInteractedRef = useRef(false)

  // 动态意图卡片列表 (遵循 AGENTS.md §2.6 动态 i18n 避坑)
  const intentCards = useMemo(() => getIntentCards(), [])

  // 会员权益中性提示
  const tier = useTierStore(s => s.tier)
  const isFreeTier = (tier ?? UserTier.FREE) === UserTier.FREE

  // 解析当前工作区配置
  const parsedConfig = useMemo<WorkspaceConfig>(() => {
    return parseWorkspaceConfig(workspace.workspace_config)
  }, [workspace.workspace_config])

  const initialIntent: WorkspaceConfigIntent = useMemo(() => {
    if (parsedConfig.status === 'ready') {
      return parsedConfig.intent
    }
    return parsedConfig.detectedIntent || 'fast_archive'
  }, [parsedConfig])

  const [selectedIntent, setSelectedIntent] = useState<WorkspaceConfigIntent>(initialIntent)

  // 异步探测目录画像
  useEffect(() => {
    let cancelled = false
    const probe = async () => {
      if (!window.electronAPI?.utils?.probeDirectoryProfile || !workspace.path) return
      setIsProbing(true)
      try {
        const result = await window.electronAPI.utils.probeDirectoryProfile(workspace.path)
        if (!cancelled && result) {
          setProfileResult(result as DirectoryProfileResult)
          // 若处于 pending 状态且用户尚未手动交互选中，自动采纳 Profiler 推荐的高置信度意图
          if (
            parsedConfig.status === 'pending' &&
            result.confidence > 0 &&
            !hasUserInteractedRef.current
          ) {
            setSelectedIntent(result.detectedIntent)
          }
        }
      } catch (err) {
        console.warn('[WorkspaceSetupWizard] 嗅探目录画像失败:', err)
      } finally {
        if (!cancelled) setIsProbing(false)
      }
    }

    probe()
    return () => {
      cancelled = true
    }
  }, [workspace.id, workspace.path, parsedConfig.status])

  // 推荐状态判断
  const isRecommended = useCallback(
    (intentId: WorkspaceConfigIntent) => {
      return (
        profileResult && profileResult.detectedIntent === intentId && profileResult.confidence > 0
      )
    },
    [profileResult]
  )

  // 计算文件特征分布百分比
  const distribution = useMemo(() => {
    if (!profileResult?.stats || profileResult.stats.totalSampled <= 0) {
      return null
    }
    const { totalSampled, docCount, imageCount, videoCount } = profileResult.stats
    const docPct = Math.round((docCount / totalSampled) * 100)
    const imgPct = Math.round((imageCount / totalSampled) * 100)
    const videoPct = Math.round((videoCount / totalSampled) * 100)
    const otherPct = Math.max(0, 100 - docPct - imgPct - videoPct)

    return {
      totalSampled,
      docCount,
      imageCount,
      videoCount,
      docPct,
      imgPct,
      videoPct,
      otherPct
    }
  }, [profileResult])

  // 依据画像生成的个性化推荐理由
  const recommendationReason = useMemo(() => {
    if (!profileResult || profileResult.confidence <= 0) return null
    const { detectedIntent } = profileResult
    if (detectedIntent === 'fast_archive') {
      return t(
        '检测到该目录下以文档与代码为主（占比约 {pct}%），已自动预选「极速整理与文档」策略：专注于正文长文本萃取与高精度 OCR，跳过沉重的逐帧视频抽帧，分析速度提升 3-5 倍。',
        { pct: distribution?.docPct || 65 }
      )
    }
    if (detectedIntent === 'visual_gallery') {
      return t(
        '检测到该目录下主要是照片、设计稿或插画（占比约 {pct}%），已自动预选「创意图库与设计」策略：全面启用多模态画面理解与视觉语义打标，捕捉构图与主体。',
        { pct: distribution?.imgPct || 60 }
      )
    }
    if (detectedIntent === 'footage_studio') {
      return t(
        '检测到该目录下包含较多视频与音视频素材（占比约 {pct}%），已自动预选「影视与剪辑素材」策略：启用关键帧敏锐切片与全时长伴音台词提取，释放多媒体硬件算力。',
        { pct: distribution?.videoPct || 40 }
      )
    }
    return t(
      '检测到该目录包含文档、图片等多格式混合文件，已自动预选「桌面与下载混合」策略：采用自适应动态算力模型，均衡解析各类文件。'
    )
  }, [profileResult, distribution])

  // 统一提交就绪配置
  const submitConfig = async (flowMode: 'complete' | 'customize') => {
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

      // 生成派生参数快照
      const derivedSnapshot = mapIntentToParameters(selectedIntent, actualHw)

      // 保留原有自定义忽略规则（如果存在）
      const existingCustomIgnoreRules =
        parsedConfig.status === 'ready' ? parsedConfig.customIgnoreRules : undefined

      const readyConfig: WorkspaceConfig = {
        schemaVersion: 1,
        status: 'ready',
        intent: selectedIntent,
        policyVersion: 1,
        derivedSnapshot,
        overrides: parsedConfig.status === 'ready' ? parsedConfig.overrides : undefined,
        customIgnoreRules: existingCustomIgnoreRules,
        configuredAt: Date.now()
      }

      if (window.electronAPI?.updateWorkspaceConfig) {
        const res = await window.electronAPI.updateWorkspaceConfig(workspace.id, readyConfig)
        if (res.success) {
          if (flowMode === 'complete') {
            toast.success(t('工作区已配置完成，AI 智能分析已启动！'))
          }
          onFinish(flowMode, readyConfig)
        } else {
          toast.error(res.error || t('保存配置失败'))
        }
      } else {
        onFinish(flowMode, readyConfig)
      }
    } catch (error: any) {
      toast.error(error?.message || t('保存配置异常'))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden p-6 space-y-4">
      {/* 头部标题与引导：清晰告知专为当前工作目录定制 */}
      <div className="space-y-1.5 shrink-0">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="space-y-0.5">
            <h3 className="text-xl font-bold flex items-center gap-2.5 text-foreground">
              <span className="p-1 rounded-lg bg-primary/10 text-primary">
                <Sparkles className="w-5 h-5" />
              </span>
              <span>{t('自动为当前工作目录配置 AI 分析策略')}</span>
            </h3>
            <p className="text-xs text-muted-foreground flex items-center gap-1.5">
              <span>{t('当前配置目录:')}</span>
              <span className="font-semibold text-foreground bg-muted px-2 py-0.5 rounded text-[11px] flex items-center gap-1">
                <FolderOpen className="w-3 h-3 text-primary" />
                {workspace.name}
              </span>
              <span className="text-muted-foreground/60">({workspace.path})</span>
            </p>
          </div>

          {/* 探测状态徽标 */}
          {isProbing && (
            <div className="flex items-center gap-1.5 text-xs text-primary bg-primary/10 px-3 py-1 rounded-full animate-pulse border border-primary/20">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>{t('正在深度扫描目录文件特征...')}</span>
            </div>
          )}
        </div>
      </div>

      {/* 核心亮点：文件特征扫描画像展示区 */}
      <div className="rounded-xl border border-border/80 bg-gradient-to-br from-card via-card to-muted/20 p-4 shadow-xs shrink-0 space-y-3">
        <div className="flex items-center justify-between flex-wrap gap-2 text-xs">
          <div className="flex items-center gap-2 font-semibold text-foreground">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span>{t('目录文件特征画像与智能诊断')}</span>
            {distribution && (
              <span className="text-muted-foreground font-normal">
                ({t('共分析 {count} 个样本文件', { count: distribution.totalSampled })}
                {profileResult?.stats.durationMs ? ` · ${profileResult.stats.durationMs}ms` : ''})
              </span>
            )}
          </div>

          {/* 常见文件后缀标签 */}
          {profileResult?.stats.topExtensions && profileResult.stats.topExtensions.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[11px] text-muted-foreground">{t('主要格式:')}</span>
              {profileResult.stats.topExtensions.slice(0, 4).map((item, idx) => (
                <span
                  key={idx}
                  className="px-1.5 py-0.5 rounded bg-muted text-[11px] font-mono text-muted-foreground border border-border/50"
                >
                  {item.ext} ({item.count})
                </span>
              ))}
            </div>
          )}
        </div>

        {/* 动态比例条 (Document / Image / Video / Other) */}
        {distribution ? (
          <div className="space-y-2">
            <div className="h-2 w-full rounded-full overflow-hidden flex bg-muted/60">
              {distribution.docPct > 0 && (
                <div
                  style={{ width: `${distribution.docPct}%` }}
                  className="bg-emerald-500 transition-all duration-500"
                  title={`${t('文档与代码')}: ${distribution.docPct}%`}
                />
              )}
              {distribution.imgPct > 0 && (
                <div
                  style={{ width: `${distribution.imgPct}%` }}
                  className="bg-violet-500 transition-all duration-500"
                  title={`${t('图片与插画')}: ${distribution.imgPct}%`}
                />
              )}
              {distribution.videoPct > 0 && (
                <div
                  style={{ width: `${distribution.videoPct}%` }}
                  className="bg-amber-500 transition-all duration-500"
                  title={`${t('视频与音频')}: ${distribution.videoPct}%`}
                />
              )}
              {distribution.otherPct > 0 && (
                <div
                  style={{ width: `${distribution.otherPct}%` }}
                  className="bg-slate-400 dark:bg-slate-600 transition-all duration-500"
                  title={`${t('其他格式')}: ${distribution.otherPct}%`}
                />
              )}
            </div>

            {/* 图例占比药丸 */}
            <div className="flex items-center gap-3 sm:gap-4 flex-wrap text-[11px]">
              <span className="flex items-center gap-1 text-muted-foreground">
                <span className="w-2 h-2 rounded-full bg-emerald-500" />
                <FileText className="w-3 h-3 text-emerald-600 dark:text-emerald-400" />
                <span>
                  {t('文档与代码')} {distribution.docPct}%
                </span>
              </span>
              <span className="flex items-center gap-1 text-muted-foreground">
                <span className="w-2 h-2 rounded-full bg-violet-500" />
                <ImageIcon className="w-3 h-3 text-violet-600 dark:text-violet-400" />
                <span>
                  {t('图片与插画')} {distribution.imgPct}%
                </span>
              </span>
              <span className="flex items-center gap-1 text-muted-foreground">
                <span className="w-2 h-2 rounded-full bg-amber-500" />
                <Film className="w-3 h-3 text-amber-600 dark:text-amber-400" />
                <span>
                  {t('视频与音频')} {distribution.videoPct}%
                </span>
              </span>
              {distribution.otherPct > 0 && (
                <span className="flex items-center gap-1 text-muted-foreground">
                  <span className="w-2 h-2 rounded-full bg-slate-400 dark:bg-slate-600" />
                  <Package className="w-3 h-3 text-slate-500" />
                  <span>
                    {t('其他')} {distribution.otherPct}%
                  </span>
                </span>
              )}
            </div>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground flex items-center gap-2 py-1">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
            <span>{t('正在统计文件构成以推断最佳算力模型...')}</span>
          </div>
        )}

        {/* 画像推荐结论横幅 */}
        {recommendationReason && (
          <div className="flex items-start gap-2.5 p-2.5 rounded-lg bg-primary/5 border border-primary/20 text-xs text-foreground/90">
            <Sparkles className="w-4 h-4 text-primary shrink-0 mt-0.5" />
            <div className="leading-relaxed font-normal">
              <span className="font-semibold text-primary mr-1">{t('✨ AI 匹配建议:')}</span>
              {recommendationReason}
            </div>
          </div>
        )}
      </div>

      {/* 四大场景意图卡片网格 */}
      <div className="flex-1 overflow-y-auto space-y-2.5 pr-1">
        <div className="flex items-center justify-between">
          <Label className="text-xs font-semibold text-foreground">
            {t('选择适用的场景模式（系统已为您推荐最契合选项，您也可以自主调整）：')}
          </Label>
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
                onClick={() => {
                  hasUserInteractedRef.current = true
                  setSelectedIntent(card.id)
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    hasUserInteractedRef.current = true
                    setSelectedIntent(card.id)
                  }
                }}
                className={cn(
                  'relative flex flex-col p-4 rounded-xl border text-left cursor-pointer transition-all duration-200 select-none group',
                  isSelected
                    ? 'bg-primary/5 dark:bg-primary/10 border-primary shadow-md shadow-primary/10 ring-2 ring-primary/80'
                    : 'bg-card hover:bg-muted/40 border-border/80 hover:border-border',
                  recommended &&
                    !isSelected &&
                    'border-amber-500/50 hover:border-amber-500 bg-amber-500/[0.02]'
                )}
              >
                {/* 强化推荐角标 */}
                {recommended && (
                  <div className="absolute -top-2.5 right-3 flex items-center gap-1 text-[11px] font-bold px-2.5 py-0.5 rounded-full bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-sm">
                    <Sparkles className="w-3 h-3 fill-current" />
                    <span>
                      {t('✨ 智能匹配推荐')}
                      {profileResult?.confidence
                        ? ` (${Math.round(profileResult.confidence * 100)}%)`
                        : ''}
                    </span>
                  </div>
                )}

                <div className="flex items-center gap-3 mb-2">
                  <div
                    className={cn(
                      'w-9 h-9 rounded-lg flex items-center justify-center transition-colors shrink-0',
                      isSelected
                        ? 'bg-primary text-primary-foreground shadow-xs'
                        : 'bg-muted text-muted-foreground group-hover:text-foreground'
                    )}
                  >
                    <MaterialIcon icon={card.icon} className="text-xl" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <h5 className="font-bold text-sm leading-snug truncate">{card.title}</h5>
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-tight truncate mt-0.5">
                      {card.subtitle}
                    </p>
                  </div>
                </div>

                <p className="text-xs text-muted-foreground leading-relaxed flex-1 mt-1">
                  {card.description}
                </p>

                <div className="flex items-center justify-between mt-3 pt-2.5 border-t border-border/50 text-xs">
                  <span className="font-medium text-muted-foreground text-[11px]">
                    {card.badge}
                  </span>
                  {isSelected ? (
                    <span className="text-primary font-bold flex items-center gap-1 text-xs">
                      <CheckCircle2 className="w-3.5 h-3.5 fill-current" />
                      {t('已选中该策略')}
                    </span>
                  ) : (
                    <span className="text-muted-foreground/60 group-hover:text-foreground text-[11px] transition-colors">
                      {t('点击选用')}
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* 影视剪辑素材场景 Free/Pro 权益中性告知 */}
        {isFreeTier && selectedIntent === 'footage_studio' && (
          <div className="flex items-center gap-2 p-3 rounded-xl bg-primary/5 border border-primary/20 text-xs text-muted-foreground mt-1">
            <Sparkles className="w-4 h-4 text-primary shrink-0" />
            <span>{t('当前体验首个 5 分钟切片分析，升级 Pro 可流式续作自动处理全片')}</span>
          </div>
        )}
      </div>

      {/* 底部双通道流转操作栏：主按钮高亮 + 深度自定义清晰可见 */}
      <div className="pt-3.5 border-t border-border flex flex-col sm:flex-row items-center justify-between gap-3 shrink-0">
        {/* 个性化入口：文案更直接，不再隐晦弱化 */}
        <div className="w-full sm:w-auto">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={isSaving}
            onClick={() => submitConfig('customize')}
            className="w-full sm:w-auto flex items-center justify-center gap-2 text-xs font-semibold border-border/80 hover:border-primary/50 hover:bg-muted/60 transition-all py-2"
          >
            <Sliders className="w-3.5 h-3.5 text-primary" />
            <span>{t('我想要更个性化的设置')}</span>
            <ArrowRight className="w-3.5 h-3.5 text-muted-foreground" />
          </Button>
        </div>

        {/* 主出口：完成并开始分析 */}
        <div className="flex items-center gap-3 w-full sm:w-auto justify-end">
          <Button
            type="button"
            variant="default"
            size="default"
            disabled={isSaving}
            onClick={() => submitConfig('complete')}
            className="w-full sm:w-auto flex items-center justify-center gap-2 text-xs font-bold px-6 shadow-md shadow-primary/20 bg-primary text-primary-foreground hover:bg-primary/90 h-9 transition-all"
          >
            {isSaving ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5 fill-current" />
            )}
            <span>{t('应用推荐设置并开始分析')}</span>
          </Button>
        </div>
      </div>
    </div>
  )
}
