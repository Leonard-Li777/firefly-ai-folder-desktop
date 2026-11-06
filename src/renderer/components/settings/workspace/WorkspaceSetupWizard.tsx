import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import {
  WorkspaceDirectory,
  WorkspaceConfig,
  WorkspaceConfigIntent,
  parseWorkspaceConfig,
  HardwareInfo,
  UserTier,
  LocalWorkflowRecord,
  WorkflowRecommendation,
  WorkflowCategory,
  TechnicalEngineParameters
} from '@firefly/types'
import {
  PRESET_BUILTIN_WORKFLOWS,
  recommendWorkflowByProfile,
  DirectoryProfileStats,
  mapIntentToParameters
} from '@firefly/shared'
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
  Cpu,
  Camera,
  Code2,
  Shapes,
  Gamepad2,
  BookOpen,
  Tv,
  Music,
  FileSpreadsheet,
  CheckCheck,
  Filter,
  Tag
} from 'lucide-react'

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

/** 角色身份中文显示字典 */
const PERSONA_LABELS: Record<string, string> = {
  photographer: '专业摄影师',
  videographer: '影视剪辑师',
  developer_designer: '开发与设计师',
  digital_artist: '3D与美术设计师',
  gamer: '游戏与数字达人',
  bookworm: '电子书友与网文读者',
  anime_fan: '漫画二次元同好',
  cinephile: '影视剧集藏家',
  audiophile: '无损音乐发烧友',
  financial: '财务法务审计',
  office_clerk: '日常行政办公'
}

/** 分类选项卡定义 */
const WORKFLOW_CATEGORIES: Array<{
  id: WorkflowCategory
  name: string
  icon: string
  count: number
}> = [
  { id: 'entertainment', name: '生活娱乐', icon: 'sports_esports', count: 5 },
  { id: 'creative', name: '创意设计', icon: 'palette', count: 4 },
  { id: 'office', name: '专业办公', icon: 'business_center', count: 2 }
]

/** 工作流与内置矢量图标映射 */
function getWorkflowIconComponent(workflowId: string) {
  switch (workflowId) {
    case 'builtin.workflow.photography-raw':
      return Camera
    case 'builtin.workflow.video-production':
      return Film
    case 'builtin.workflow.design-dev':
      return Code2
    case 'builtin.workflow.creative-assets':
      return Shapes
    case 'builtin.workflow.gaming':
      return Gamepad2
    case 'builtin.workflow.novel':
      return BookOpen
    case 'builtin.workflow.anime-comic':
      return Sparkles
    case 'builtin.workflow.movie-cinema':
      return Tv
    case 'builtin.workflow.music-audio':
      return Music
    case 'builtin.workflow.finance-contract':
      return FileSpreadsheet
    case 'builtin.workflow.office-docs':
    default:
      return FileText
  }
}

/** 工作流向通用场景意图的降级适配（保证旧视图消费兼容） */
function mapWorkflowToIntent(workflowId: string): WorkspaceConfigIntent {
  switch (workflowId) {
    case 'builtin.workflow.photography-raw':
    case 'builtin.workflow.creative-assets':
    case 'builtin.workflow.anime-comic':
      return 'visual_gallery'
    case 'builtin.workflow.video-production':
    case 'builtin.workflow.movie-cinema':
      return 'footage_studio'
    case 'builtin.workflow.design-dev':
    case 'builtin.workflow.novel':
    case 'builtin.workflow.music-audio':
    case 'builtin.workflow.office-docs':
    case 'builtin.workflow.finance-contract':
    case 'builtin.workflow.gaming':
    default:
      return 'fast_archive'
  }
}

/**
 * 工作目录智能配置向导 (WorkspaceSetupWizard)
 *
 * 升级为基于工作流的两段式优雅布局 (Ticket 02)：
 * 1. 顶部高亮「AI 智能推荐」主卡片（门槛：S1 >= 70 且领先 S2 至少 15 分时亮起）；
 * 2. 底部 3-Tab 分类平铺工作流卡片库（生活娱乐 / 创意设计 / 专业办公，11套官方预置矩阵）；
 * 3. 完整保留文件特征扫描画像与扩展名可视化 UI（多色比例条、格式胶囊、诊断横幅）；
 * 4. 接入 @firefly/shared 的 recommendWorkflowByProfile 智能推荐引擎。
 */
export const WorkspaceSetupWizard: React.FC<WorkspaceSetupWizardProps> = ({
  workspace,
  hardwareInfo,
  onFinish
}) => {
  const [profileResult, setProfileResult] = useState<DirectoryProfileResult | null>(null)
  const [isProbing, setIsProbing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [activeCategory, setActiveCategory] = useState<WorkflowCategory>('creative')
  const hasUserInteractedRef = useRef(false)

  // 会员权益中性提示
  const tier = useTierStore(s => s.tier)
  const isFreeTier = (tier ?? UserTier.FREE) === UserTier.FREE

  // 解析当前工作区配置
  const parsedConfig = useMemo<WorkspaceConfig>(() => {
    return parseWorkspaceConfig(workspace.workspace_config)
  }, [workspace.workspace_config])

  // 当前选中的工作流 ID (初始优先继承绑定工作流，否则默认选中推荐工作流)
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>(
    (workspace as any).bound_workflow_id || 'builtin.workflow.photography-raw'
  )

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

  // 基于目录画像推导工作流推荐评分列表
  const workflowRecommendations = useMemo<WorkflowRecommendation[]>(() => {
    if (!profileResult?.stats || profileResult.stats.totalSampled <= 0) {
      return []
    }
    const profileStats: DirectoryProfileStats = {
      totalSampled: profileResult.stats.totalSampled,
      docCount: profileResult.stats.docCount,
      imageCount: profileResult.stats.imageCount,
      videoCount: profileResult.stats.videoCount,
      otherCount: profileResult.stats.otherCount,
      topExtensions: profileResult.stats.topExtensions || []
    }
    return recommendWorkflowByProfile(profileStats, PRESET_BUILTIN_WORKFLOWS)
  }, [profileResult])

  // 推荐分数值映射表
  const scoreMap = useMemo(() => {
    const map = new Map<string, { score: number; matchReason: string; isTop: boolean }>()
    for (const rec of workflowRecommendations) {
      map.set(rec.workflowId, {
        score: rec.score,
        matchReason: rec.matchReason,
        isTop: rec.isTopRecommendation
      })
    }
    return map
  }, [workflowRecommendations])

  // Top 1 最佳推荐工作流实体
  const top1Recommendation = useMemo(() => {
    if (workflowRecommendations.length === 0) return null
    const topRec = workflowRecommendations[0]
    const wf = PRESET_BUILTIN_WORKFLOWS.find(w => w.id === topRec.workflowId)
    return wf ? { ...wf, score: topRec.score, matchReason: topRec.matchReason } : null
  }, [workflowRecommendations])

  // Top 1 智能推荐是否达到高亮门槛 (S1 >= 70 且 S1 - S2 >= 15)
  const isTopRecommendationHighlighted = useMemo(() => {
    if (!workflowRecommendations || workflowRecommendations.length < 2) return false
    const s1 = workflowRecommendations[0].score
    const s2 = workflowRecommendations[1].score
    return s1 >= 70 && s1 - s2 >= 15
  }, [workflowRecommendations])

  // 当 Profiler 分析完成且用户尚未手动干预时，自动预选推荐工作流并定位分类
  useEffect(() => {
    if (top1Recommendation && !hasUserInteractedRef.current) {
      setSelectedWorkflowId(top1Recommendation.id)
      if (top1Recommendation.category) {
        setActiveCategory(top1Recommendation.category)
      }
    }
  }, [top1Recommendation])

  // 当前选中的完整工作流实体
  const selectedWorkflow = useMemo(() => {
    return (
      PRESET_BUILTIN_WORKFLOWS.find(w => w.id === selectedWorkflowId) || PRESET_BUILTIN_WORKFLOWS[0]
    )
  }, [selectedWorkflowId])

  // 计算预期大白话影响 (例如：预计纳入 85% 目标文件，排除 15% 杂质文件)
  const expectedImpactText = useMemo(() => {
    if (!profileResult?.stats || !selectedWorkflow) return null
    const { topExtensions, totalSampled } = profileResult.stats
    if (totalSampled <= 0) return null

    let allowedExts = new Set<string>()
    if (selectedWorkflow.filter_rules) {
      try {
        const rules = JSON.parse(selectedWorkflow.filter_rules)
        if (Array.isArray(rules)) {
          rules.forEach(r => {
            const ext = typeof r === 'string' ? r : r.pattern || r.ext || ''
            if (ext) allowedExts.add(ext.toLowerCase())
          })
        }
      } catch {}
    }

    if (selectedWorkflow.filter_mode === 'whitelist' && allowedExts.size > 0) {
      let matchedCount = 0
      for (const item of topExtensions || []) {
        if (allowedExts.has(item.ext.toLowerCase())) {
          matchedCount += item.count
        }
      }
      const inPct = Math.min(99, Math.max(5, Math.round((matchedCount / totalSampled) * 100)))
      const outPct = Math.max(0, 100 - inPct)
      return t(
        '检测到当前目录下主要为 {extSummary}，应用此工作流预计将纳入 {inPct}% 的目标资产并深度解析，过滤 {outPct}% 的非目标杂质文件。',
        {
          extSummary: (topExtensions || [])
            .slice(0, 3)
            .map(e => e.ext)
            .join('、'),
          inPct,
          outPct
        }
      )
    }

    return t(
      '采用此工作流规范将自动建立「{persona}」标准管理结构，对目标文件执行智能命名与分类归整。',
      {
        persona: PERSONA_LABELS[selectedWorkflow.persona] || selectedWorkflow.name
      }
    )
  }, [profileResult, selectedWorkflow])

  // 统一提交就绪配置并绑定工作流
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

      // 从选中的工作流中解析底层引擎参数快照
      let derivedSnapshot: TechnicalEngineParameters
      if (selectedWorkflow.engine_params_json) {
        try {
          derivedSnapshot = JSON.parse(selectedWorkflow.engine_params_json)
        } catch {
          derivedSnapshot = mapIntentToParameters(
            mapWorkflowToIntent(selectedWorkflow.id),
            actualHw
          )
        }
      } else {
        derivedSnapshot = mapIntentToParameters(mapWorkflowToIntent(selectedWorkflow.id), actualHw)
      }

      // 提取工作流白名单规则集合
      let whitelistPatterns: string[] = []
      if (selectedWorkflow.filter_rules) {
        try {
          const parsed = JSON.parse(selectedWorkflow.filter_rules)
          if (Array.isArray(parsed)) {
            whitelistPatterns = parsed
              .map(r => (typeof r === 'string' ? r : r.pattern || r.ext || ''))
              .filter(Boolean)
          }
        } catch {}
      }

      // 保留原有自定义忽略规则
      const existingCustomIgnoreRules =
        parsedConfig.status === 'ready' ? parsedConfig.customIgnoreRules : undefined

      // 就绪配置对象 (清空旧 overrides 确保新工作流基线 100% 完整生效)
      const readyConfig: WorkspaceConfig = {
        schemaVersion: 1,
        status: 'ready',
        intent: mapWorkflowToIntent(selectedWorkflow.id),
        policyVersion: 1,
        derivedSnapshot,
        overrides: undefined,
        customIgnoreRules: existingCustomIgnoreRules,
        configuredAt: Date.now()
      }

      // 1. 持久化工作区配置
      if (window.electronAPI?.updateWorkspaceConfig) {
        await window.electronAPI.updateWorkspaceConfig(workspace.id, readyConfig)
      }

      // 2. 绑定工作流 ID
      if (window.electronAPI?.updateWorkspaceBoundWorkflow) {
        await window.electronAPI.updateWorkspaceBoundWorkflow(workspace.id, selectedWorkflow.id)
      }

      // 3. 若为白名单模式，同步持久化白名单扩展名
      if (
        selectedWorkflow.filter_mode === 'whitelist' &&
        whitelistPatterns.length > 0 &&
        window.electronAPI?.updateWorkspaceWhitelist
      ) {
        await window.electronAPI.updateWorkspaceWhitelist(workspace.id, whitelistPatterns)
      }

      if (flowMode === 'complete') {
        toast.success(
          t('已绑定「{name}」，AI 分析与工作流已启动！', { name: selectedWorkflow.name })
        )
      } else {
        toast.success(
          t('已选用「{name}」，正在为您打开详细配置页面', { name: selectedWorkflow.name })
        )
      }
      onFinish(flowMode, readyConfig)
    } catch (error: any) {
      toast.error(error?.message || t('保存工作流配置异常'))
    } finally {
      setIsSaving(false)
    }
  }

  // 过滤出当前激活分类下的工作流卡片
  const categoryWorkflows = useMemo(() => {
    return PRESET_BUILTIN_WORKFLOWS.filter(w => w.category === activeCategory)
  }, [activeCategory])

  return (
    <div className="flex flex-col h-full overflow-hidden p-6 space-y-4">
      {/* 头部标题与引导：清晰告知为当前工作目录定制专属工作流 */}
      <div className="space-y-1.5 shrink-0">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="space-y-0.5">
            <h3 className="text-xl font-bold flex items-center gap-2.5 text-foreground">
              <span className="p-1 rounded-lg bg-primary/10 text-primary">
                <Sparkles className="w-5 h-5" />
              </span>
              <span>{t('为当前工作目录定制专属 AI 工作流')}</span>
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

      {/* 核心亮点：文件特征扫描画像展示区 (100% 完整保留扩展名可视化 UI) */}
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

          {/* 常见文件后缀标签 (扩展名胶囊可视化) */}
          {profileResult?.stats.topExtensions && profileResult.stats.topExtensions.length > 0 && (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[11px] text-muted-foreground">{t('主要格式:')}</span>
              {profileResult.stats.topExtensions.slice(0, 5).map((item, idx) => (
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

        {/* 动态四色比例条 (Document / Image / Video / Other) */}
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
        {expectedImpactText && (
          <div className="flex items-start gap-2.5 p-2.5 rounded-lg bg-primary/5 border border-primary/20 text-xs text-foreground/90">
            <Sparkles className="w-4 h-4 text-primary shrink-0 mt-0.5" />
            <div className="leading-relaxed font-normal">
              <span className="font-semibold text-primary mr-1">{t('✨ AI 匹配诊断:')}</span>
              {expectedImpactText}
            </div>
          </div>
        )}
      </div>

      {/* 两段式主内容区 */}
      <div className="flex-1 overflow-y-auto space-y-3.5 pr-1">
        {/* 段落 1: 顶部高亮「AI 智能推荐」主卡片 (触发门槛: S1 >= 70 且领先 S2 至少 15 分) */}
        {isTopRecommendationHighlighted && top1Recommendation && (
          <div className="rounded-xl border-2 border-amber-500/60 bg-gradient-to-r from-amber-500/[0.08] via-primary/[0.04] to-card p-4 shadow-sm relative overflow-hidden space-y-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-xl bg-amber-500/20 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0 shadow-xs border border-amber-500/30">
                  {React.createElement(getWorkflowIconComponent(top1Recommendation.id), {
                    className: 'w-5 h-5'
                  })}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h4 className="font-bold text-base text-foreground leading-snug">
                      {top1Recommendation.name}
                    </h4>
                    <span className="text-[11px] px-2 py-0.5 rounded-full font-bold bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-xs flex items-center gap-1">
                      <span>🔥 {t('匹配度 {score}%', { score: top1Recommendation.score })}</span>
                    </span>
                    <span className="text-[10px] px-2 py-0.5 rounded-md font-semibold bg-muted text-muted-foreground border border-border/60">
                      {PERSONA_LABELS[top1Recommendation.persona] || top1Recommendation.persona}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                    {top1Recommendation.summary}
                  </p>
                </div>
              </div>

              {/* 推荐卡片直接采用主按钮 */}
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  disabled={isSaving}
                  onClick={() => {
                    hasUserInteractedRef.current = true
                    setSelectedWorkflowId(top1Recommendation.id)
                    submitConfig('complete')
                  }}
                  className="bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold px-3.5 shadow-sm h-8"
                >
                  <Sparkles className="w-3.5 h-3.5 mr-1.5 fill-current" />
                  <span>{t('一键采用此推荐并开始分析')}</span>
                </Button>
              </div>
            </div>

            {/* 规则与命名格式预览行 */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2 border-t border-border/40 text-xs">
              <div className="flex items-center gap-2 text-muted-foreground">
                <Filter className="w-3.5 h-3.5 text-primary shrink-0" />
                <span className="font-medium text-foreground">{t('准入模式:')}</span>
                <span className="truncate font-mono text-[11px]">
                  {top1Recommendation.filter_mode === 'whitelist'
                    ? t('白名单放行')
                    : t('黑名单过滤')}
                  {' · '}
                  {top1Recommendation.filter_rules}
                </span>
              </div>
              <div className="flex items-center gap-2 text-muted-foreground">
                <Tag className="w-3.5 h-3.5 text-primary shrink-0" />
                <span className="font-medium text-foreground">{t('智能命名:')}</span>
                <span className="truncate font-mono text-[11px]">
                  {top1Recommendation.naming_template ||
                    top1Recommendation.naming_pattern ||
                    t('标准格式')}
                </span>
              </div>
            </div>
          </div>
        )}

        {/* 段落 2: 底部 3-Tab 分类平铺工作流卡片库 */}
        <div className="space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <Label className="text-xs font-bold text-foreground flex items-center gap-1.5">
              <span>{t('全场景官方工作流矩阵库')}</span>
              <span className="text-muted-foreground font-normal">
                ({t('共 11 套官方内置工作流，支持自由选用')})
              </span>
            </Label>

            {/* 3-Tab 分类切换器 */}
            <div className="flex items-center p-1 bg-muted/60 rounded-lg border border-border/60 gap-1">
              {WORKFLOW_CATEGORIES.map(cat => {
                const isActive = activeCategory === cat.id
                return (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => setActiveCategory(cat.id)}
                    className={cn(
                      'px-3 py-1 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer select-none',
                      isActive
                        ? 'bg-card text-foreground shadow-2xs border border-border'
                        : 'text-muted-foreground hover:text-foreground'
                    )}
                  >
                    <MaterialIcon icon={cat.icon} className="text-sm" />
                    <span>{t(cat.name)}</span>
                    <span
                      className={cn(
                        'text-[10px] px-1.5 py-0.2 rounded-full font-mono',
                        isActive ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
                      )}
                    >
                      {cat.count}
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {/* 工作流平铺卡片网格 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {categoryWorkflows.map(wf => {
              const isSelected = selectedWorkflowId === wf.id
              const rec = scoreMap.get(wf.id)
              const IconComp = getWorkflowIconComponent(wf.id)

              return (
                <div
                  key={wf.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    hasUserInteractedRef.current = true
                    setSelectedWorkflowId(wf.id)
                  }}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      hasUserInteractedRef.current = true
                      setSelectedWorkflowId(wf.id)
                    }
                  }}
                  className={cn(
                    'relative flex flex-col p-4 rounded-xl border text-left cursor-pointer transition-all duration-200 select-none group',
                    isSelected
                      ? 'bg-primary/5 dark:bg-primary/10 border-primary shadow-md shadow-primary/10 ring-2 ring-primary/80'
                      : 'bg-card hover:bg-muted/40 border-border/80 hover:border-border'
                  )}
                >
                  {/* 推荐分数值小胶囊 */}
                  {rec && rec.score >= 60 && (
                    <div className="absolute top-3 right-3 flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                      <Sparkles className="w-2.5 h-2.5 fill-current" />
                      <span>{t('契合度 {score}%', { score: rec.score })}</span>
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
                      <IconComp className="w-4 h-4" />
                    </div>
                    <div className="min-w-0 flex-1 pr-16">
                      <div className="flex items-center gap-1.5">
                        <h5 className="font-bold text-sm leading-snug truncate text-foreground">
                          {wf.name}
                        </h5>
                      </div>
                      <span className="text-[10px] font-medium text-muted-foreground">
                        {PERSONA_LABELS[wf.persona] || wf.persona}
                      </span>
                    </div>
                  </div>

                  <p className="text-xs text-muted-foreground leading-relaxed flex-1 line-clamp-2">
                    {wf.summary}
                  </p>

                  {/* 规则与命名简述 */}
                  <div className="mt-3 pt-2.5 border-t border-border/50 text-[11px] space-y-1">
                    <div className="flex items-center justify-between text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {wf.filter_mode === 'whitelist' ? t('白名单放行') : t('黑名单过滤')}:
                      </span>
                      <span className="font-mono truncate max-w-[170px] text-muted-foreground/80">
                        {wf.filter_rules}
                      </span>
                    </div>
                    {wf.naming_template && (
                      <div className="flex items-center justify-between text-muted-foreground">
                        <span className="font-medium text-foreground">{t('智能命名')}:</span>
                        <span className="font-mono truncate max-w-[170px] text-muted-foreground/80">
                          {wf.naming_template}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* 底部选中反馈 */}
                  <div className="flex items-center justify-between mt-2 pt-2 border-t border-border/40 text-xs">
                    <span className="text-[10px] text-muted-foreground">
                      {wf.category === 'creative'
                        ? t('创意设计类')
                        : wf.category === 'entertainment'
                          ? t('生活娱乐类')
                          : t('专业办公类')}
                    </span>
                    {isSelected ? (
                      <span className="text-primary font-bold flex items-center gap-1 text-xs">
                        <CheckCircle2 className="w-3.5 h-3.5 fill-current" />
                        {t('已选中')}
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
        </div>

        {/* 影视剪辑素材场景 Free/Pro 权益中性告知 */}
        {isFreeTier && selectedWorkflow.id === 'builtin.workflow.video-production' && (
          <div className="flex items-center gap-2 p-3 rounded-xl bg-primary/5 border border-primary/20 text-xs text-muted-foreground mt-1">
            <Sparkles className="w-4 h-4 text-primary shrink-0" />
            <span>{t('当前体验首个 5 分钟切片分析，升级 Pro 可流式续作自动处理全片')}</span>
          </div>
        )}
      </div>

      {/* 底部双通道流转操作栏：主按钮高亮（应用推荐并查看详细配置） + 快捷通道 */}
      <div className="pt-3.5 border-t border-border flex flex-col sm:flex-row items-center justify-between gap-3 shrink-0">
        <div className="text-xs text-muted-foreground flex items-center gap-2 min-w-0">
          <Sliders className="w-3.5 h-3.5 text-primary shrink-0" />
          <span className="truncate">
            {t('当前选定工作流:')}{' '}
            <strong className="text-foreground">{selectedWorkflow.name}</strong>
          </span>
        </div>

        <div className="flex items-center gap-2.5 w-full sm:w-auto justify-end">
          {/* 快捷通道：直接完成并启动分析 (关闭弹窗) */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={isSaving}
            onClick={() => submitConfig('complete')}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            <span>{t('直接启动分析')}</span>
          </Button>

          {/* 主出口：应用所选并查看详细配置（保存并定位到AI引擎配置页面） */}
          <Button
            type="button"
            variant="default"
            size="default"
            disabled={isSaving}
            onClick={() => submitConfig('customize')}
            className="w-full sm:w-auto flex items-center justify-center gap-2 text-xs font-bold px-5 shadow-md shadow-primary/20 bg-primary text-primary-foreground hover:bg-primary/90 h-9 transition-all"
          >
            {isSaving ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Sparkles className="w-3.5 h-3.5 fill-current" />
            )}
            <span>{t('应用所选并查看详细配置')}</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}
