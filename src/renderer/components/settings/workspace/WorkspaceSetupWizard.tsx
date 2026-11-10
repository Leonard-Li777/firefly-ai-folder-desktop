import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import {
  WorkspaceDirectory,
  WorkspaceConfig,
  WorkspaceConfigIntent,
  parseWorkspaceConfig,
  HardwareInfo,
  UserTier,
  WorkflowRecommendation,
  WorkflowCategory,
  TechnicalEngineParameters,
  DirectoryTreeNode,
  IFilterRule
} from '@firefly/types'
import {
  recommendWorkflowByProfile,
  DirectoryProfileStats,
  mapIntentToParameters,
  buildPreviewTree,
  PreviewNode
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
  ArrowLeft,
  Sliders,
  FolderOpen,
  Folder,
  FolderTree,
  FileText,
  Image as ImageIcon,
  Film,
  Package,
  CheckCircle2,
  Camera,
  Code2,
  Shapes,
  Gamepad2,
  BookOpen,
  Tv,
  Music,
  FileSpreadsheet,
  Filter,
  Tag,
  ShieldCheck,
  LayoutGrid,
  Download,
  AlertCircle,
  Copy,
  RefreshCw,
  X
} from 'lucide-react'

export interface WorkspaceSetupWizardProps {
  workspace: WorkspaceDirectory
  hardwareInfo?: HardwareInfo | null
  /**
   * 完成向导后的流转回调
   * @param mode 'complete' 自动完成并进入工作目录；'customize' 切入个性化微调配置
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
 * 结构化持久化提交错误状态
 */
interface PolicyCommitErrorState {
  code: 'STORAGE' | 'PERMISSION' | 'CONFLICT' | 'UNKNOWN'
  message: string
  stack?: string
  payload?: unknown
}

/**
 * 规则集合元素：生产预设 (organize-taxonomy-source.ts) 为 IFilterRule 对象，
 * 历史 filter_rules 兼容字段可能为纯字符串
 */
type WizardRuleEntry = string | IFilterRule

/** 提取规则的可展示标签（对象规则取 value） */
function getRuleLabel(rule: WizardRuleEntry): string {
  if (typeof rule === 'string') return rule
  return rule?.value ?? ''
}

/** 仅提取启用中的扩展名规则值，用于扩展名命中统计 */
function getExtensionValues(rules: WizardRuleEntry[]): string[] {
  const values: string[] = []
  for (const rule of rules) {
    if (typeof rule === 'string') {
      values.push(rule)
    } else if (rule?.isActive && rule.type === 'extension' && rule.value) {
      values.push(rule.value)
    }
  }
  return values
}

/**
 * 角色身份展示字典（函数动态返回，支持多语言切换刷新）
 * 遵循 AGENTS.md "避免静态对象失效"铁律
 */
function getPersonaLabels(): Record<string, string> {
  return {
    photographer: t('专业摄影师'),
    videographer: t('影视剪辑师'),
    developer_designer: t('开发与设计师'),
    designer: t('UI/UX设计师'),
    digital_artist: t('3D与美术设计师'),
    modeler: t('3D建模师'),
    gamer: t('游戏与数字达人'),
    bookworm: t('电子书友与网文读者'),
    anime_fan: t('漫画二次元同好'),
    cinephile: t('影视剧集藏家'),
    audiophile: t('无损音乐发烧友'),
    financial: t('财务法务审计'),
    office_clerk: t('日常行政办公')
  }
}

/**
 * 分类选项卡定义（函数动态返回，支持多语言切换刷新）
 */
function getWorkflowCategories(workflowList?: any[]): Array<{
  id: WorkflowCategory | 'all'
  name: string
  icon: string
  count: number
}> {
  return [
    {
      id: 'all',
      name: t('全部'),
      icon: 'apps',
      count: workflowList && workflowList.length > 0 ? workflowList.length : 70
    },
    {
      id: 'office',
      name: t('专业办公'),
      icon: 'business_center',
      count:
        workflowList && workflowList.length > 0
          ? workflowList.filter(w => w?.category === 'office').length
          : 24
    },
    {
      id: 'creative',
      name: t('创意设计'),
      icon: 'palette',
      count:
        workflowList && workflowList.length > 0
          ? workflowList.filter(w => w?.category === 'creative').length
          : 26
    },
    {
      id: 'entertainment',
      name: t('生活娱乐'),
      icon: 'sports_esports',
      count:
        workflowList && workflowList.length > 0
          ? workflowList.filter(w => w?.category === 'entertainment').length
          : 20
    }
  ]
}

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
    case 'builtin.workflow.desktop-declutter':
      return LayoutGrid
    case 'builtin.workflow.downloads-triage':
      return Download
    case 'builtin.workflow.office-docs':
    default:
      return FileText
  }
}

/** 根据文件名后缀获取对应图标 */
function getPreviewFileIcon(fileName: string) {
  const ext = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
  if (
    [
      '.cr3',
      '.arw',
      '.nef',
      '.jpg',
      '.jpeg',
      '.png',
      '.webp',
      '.svg',
      '.gif',
      '.raw',
      '.dng'
    ].includes(ext)
  ) {
    return ImageIcon
  }
  if (['.mp4', '.mov', '.mkv', '.avi', '.flv', '.webm'].includes(ext)) {
    return Film
  }
  if (['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.lrc'].includes(ext)) {
    return Music
  }
  if (['.blend', '.obj', '.fbx', '.c4d', '.max', '.glb', '.gltf', '.hdr', '.exr'].includes(ext)) {
    return Shapes
  }
  if (
    [
      '.ts',
      '.js',
      '.py',
      '.rs',
      '.go',
      '.cpp',
      '.c',
      '.json',
      '.html',
      '.css',
      '.vue',
      '.tsx'
    ].includes(ext)
  ) {
    return Code2
  }
  if (['.xlsx', '.xls', '.csv'].includes(ext)) {
    return FileSpreadsheet
  }
  if (['.epub', '.mobi', '.azw3', '.pdf', '.txt', '.doc', '.docx'].includes(ext)) {
    return BookOpen
  }
  return FileText
}

/** 工作流向通用场景意图的降级适配 */
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
 * 递归渲染 PreviewNode（支持目录与单点命名原型节点）
 */
const PreviewTreeNodeView: React.FC<{
  node: PreviewNode
  depth?: number
  isRoot?: boolean
}> = ({ node, depth = 0, isRoot = false }) => {
  const isPrototype = node.kind === 'naming-prototype'
  const hasChildren = !isPrototype && Array.isArray(node.children) && node.children.length > 0

  if (isPrototype) {
    const FileIcon = getPreviewFileIcon(node.name)
    return (
      <div
        className={cn(
          'select-none text-xs my-1 pl-2 border-l border-primary/50',
          depth > 0 && 'ml-3'
        )}
      >
        <div
          className="flex items-center gap-1.5 py-1 px-2 rounded-md bg-primary/10 border border-primary/30 text-primary font-mono text-[11px] shadow-2xs group"
          title={node.name}
        >
          <FileIcon className="w-3.5 h-3.5 text-primary shrink-0" />
          <span className="truncate font-semibold">{node.name}</span>
          <span className="ml-auto text-[9px] px-1.5 py-0.2 rounded bg-primary text-primary-foreground font-sans font-bold">
            {t('命名样例')}
          </span>
        </div>
      </div>
    )
  }

  return (
    <div className={cn('select-none text-xs', depth > 0 && 'ml-3 pl-2 border-l border-border/50')}>
      <div className="flex items-center gap-1.5 py-1 text-foreground font-medium group">
        {isRoot ? (
          <FolderTree className="w-4 h-4 text-primary shrink-0" />
        ) : (
          <FolderOpen className="w-3.5 h-3.5 text-amber-500/90 dark:text-amber-400 shrink-0" />
        )}
        <span className={cn('truncate', isRoot && 'font-bold text-primary')}>{node.name}</span>
      </div>

      {hasChildren && (
        <div className="space-y-0.5">
          {node.children!.map((child, idx) => (
            <PreviewTreeNodeView key={`${child.name}-${idx}`} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 工作目录配置与规则确认向导 (WorkspaceSetupWizard)
 *
 * 落地二阶段视图与单点原型预览树：
 * 1. 步骤 1：选择工作流（全局比例条、通栏推荐横幅、分类 Tab、默认 Top 6 / 展开 70 套、纯函数单点原型预览树）
 * 2. 步骤 2：包含与排除规则确认（实测命中数计算、空白名单全量提示、专属排除无则隐藏、系统自动保护、双强主出口）
 * 3. 页内常驻错误条与结构化错误分层
 */
export const WorkspaceSetupWizard: React.FC<WorkspaceSetupWizardProps> = ({
  workspace,
  hardwareInfo,
  onFinish
}) => {
  // 向导步骤状态机：步骤 1 (选择工作流) ➔ 步骤 2 (包含与排除规则确认)
  const [currentStep, setCurrentStep] = useState<1 | 2>(1)
  // 是否展示所有 70 套工作流（默认仅展示 Top 6）
  const [isShowingAllWorkflows, setIsShowingAllWorkflows] = useState<boolean>(false)

  const [profileResult, setProfileResult] = useState<DirectoryProfileResult | null>(null)
  const [isProbing, setIsProbing] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [activeCategory, setActiveCategory] = useState<WorkflowCategory | 'all'>('all')
  const [commitError, setCommitError] = useState<PolicyCommitErrorState | null>(null)
  const hasUserInteractedRef = useRef(false)

  // 会员权益中性提示
  const tier = useTierStore(s => s.tier)
  const isFreeTier = (tier ?? UserTier.FREE) === UserTier.FREE

  // 解析当前工作区配置
  const parsedConfig = useMemo<WorkspaceConfig>(() => {
    return parseWorkspaceConfig(workspace.workspace_config)
  }, [workspace.workspace_config])

  // 当前选中的工作流 ID
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

  // 官方与本地工作流列表
  const [workflows, setWorkflows] = useState<any[]>([])
  const [isWorkflowsLoading, setIsWorkflowsLoading] = useState(true)
  const [workflowsLoadError, setWorkflowsLoadError] = useState<string | null>(null)

  useEffect(() => {
    let isMounted = true
    Promise.resolve()
      .then(() => window.electronAPI?.getLocalWorkflows?.())
      .then((res: any) => {
        if (!isMounted) return
        if (!res?.success || !Array.isArray(res.data)) {
          const reason = res?.error || t('主进程未返回有效的工作流列表')
          console.warn('[WorkspaceSetupWizard] 获取本地工作流列表失败:', reason)
          setWorkflowsLoadError(reason)
          return
        }
        const valid = res.data.filter((w: any) => w && typeof w.id === 'string')
        if (valid.length === 0) {
          const reason = t('未获取到任何官方工作流，请检查配置数据是否完成初始化')
          console.warn('[WorkspaceSetupWizard] 本地工作流列表为空:', reason)
          setWorkflowsLoadError(reason)
          return
        }
        setWorkflows(valid)
        setWorkflowsLoadError(null)
      })
      .catch((err: unknown) => {
        if (!isMounted) return
        const reason = (err as Error)?.message || String(err)
        console.warn('[WorkspaceSetupWizard] 获取本地工作流列表异常:', reason)
        setWorkflowsLoadError(reason)
      })
      .finally(() => {
        if (isMounted) setIsWorkflowsLoading(false)
      })
    return () => {
      isMounted = false
    }
  }, [])

  // 推导工作流推荐评分列表
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
    return recommendWorkflowByProfile(profileStats, workflows)
  }, [profileResult, workflows])

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
    const wf = workflows.find((w: any) => w?.id === topRec.workflowId)
    return wf ? { ...wf, score: topRec.score, matchReason: topRec.matchReason } : null
  }, [workflowRecommendations, workflows])

  // Top 1 智能推荐是否达到高亮门槛
  const isTopRecommendationHighlighted = useMemo(() => {
    if (!workflowRecommendations || workflowRecommendations.length < 2) return false
    const s1 = workflowRecommendations[0].score
    const s2 = workflowRecommendations[1].score
    return s1 >= 70 && s1 - s2 >= 15
  }, [workflowRecommendations])

  // 初始自动预选推荐工作流
  useEffect(() => {
    if (top1Recommendation && !hasUserInteractedRef.current) {
      setSelectedWorkflowId(top1Recommendation.id)
    }
  }, [top1Recommendation])

  // 当前选中的完整工作流实体
  const selectedWorkflow = useMemo(() => {
    const matched = workflows.find((w: any) => w?.id === selectedWorkflowId)
    if (matched) return matched
    const fallback = workflows[0]
    return fallback && typeof fallback.id === 'string' ? fallback : null
  }, [selectedWorkflowId, workflows])

  // 解析模板配置 JSON
  const selectedTemplateConfig = useMemo<any>(() => {
    if (!selectedWorkflow?.workspace_config) return null
    try {
      return typeof selectedWorkflow.workspace_config === 'string'
        ? JSON.parse(selectedWorkflow.workspace_config)
        : selectedWorkflow.workspace_config
    } catch {
      return null
    }
  }, [selectedWorkflow?.workspace_config])

  // 纯函数 buildPreviewTree 动态构建单点原型预览树
  const previewTreeNodes = useMemo<PreviewNode[]>(() => {
    if (!selectedWorkflow) return []
    let treeNodes: readonly DirectoryTreeNode[] = []
    if (selectedWorkflow.preset_directory_tree) {
      try {
        const parsed =
          typeof selectedWorkflow.preset_directory_tree === 'string'
            ? JSON.parse(selectedWorkflow.preset_directory_tree)
            : selectedWorkflow.preset_directory_tree
        if (Array.isArray(parsed)) {
          treeNodes = parsed
        }
      } catch {}
    }

    const namingTemplate =
      selectedWorkflow.naming_template ||
      selectedTemplateConfig?.namingTemplate ||
      selectedWorkflow.naming_pattern ||
      '{YYYYMMDD}_{SceneType}_{FileName}.{ext}'

    // 解析首选常见扩展名
    let commonExt = '.dat'
    let extsObj = selectedWorkflow.extensions
    if (typeof extsObj === 'string') {
      try {
        extsObj = JSON.parse(extsObj)
      } catch {}
    }
    if (Array.isArray(extsObj?.common) && extsObj.common.length > 0) {
      commonExt = extsObj.common[0]
    } else if (Array.isArray(selectedTemplateConfig?.customWhitelistRules)) {
      // 白名单规则为 IFilterRule 对象，取首个启用的扩展名规则值
      const whitelistExts = getExtensionValues(selectedTemplateConfig.customWhitelistRules)
      if (whitelistExts.length > 0) {
        commonExt = whitelistExts[0]
      }
    }
    if (!commonExt.startsWith('.')) {
      commonExt = `.${commonExt}`
    }

    return buildPreviewTree(treeNodes, namingTemplate, commonExt)
  }, [selectedWorkflow, selectedTemplateConfig])

  // 提取当前选定工作流的包含白名单规则（labels 用于展示，extensions 用于扩展名命中统计）
  const currentWhitelist = useMemo(() => {
    let rules: WizardRuleEntry[] = []
    if (Array.isArray(selectedTemplateConfig?.customWhitelistRules)) {
      rules = selectedTemplateConfig.customWhitelistRules
    } else if (selectedWorkflow?.filter_rules && selectedWorkflow?.filter_mode === 'whitelist') {
      try {
        const parsed = JSON.parse(selectedWorkflow.filter_rules)
        if (Array.isArray(parsed)) rules = parsed
      } catch {}
    }
    return {
      labels: rules.map(getRuleLabel),
      extensions: getExtensionValues(rules)
    }
  }, [selectedTemplateConfig, selectedWorkflow])

  // 提取当前选定工作流的专属排除规则（无则返回空数组）
  const currentCustomIgnoreRules = useMemo<string[]>(() => {
    if (Array.isArray(selectedTemplateConfig?.customIgnoreRules)) {
      return selectedTemplateConfig.customIgnoreRules.map(getRuleLabel)
    }
    if (selectedWorkflow?.custom_ignores) {
      try {
        const parsed =
          typeof selectedWorkflow.custom_ignores === 'string'
            ? JSON.parse(selectedWorkflow.custom_ignores)
            : selectedWorkflow.custom_ignores
        if (Array.isArray(parsed)) return parsed.map(getRuleLabel)
      } catch {}
    }
    return []
  }, [selectedTemplateConfig, selectedWorkflow])

  // 实测命中数与大白话透视计算 (Ticket 04 AC-4.3)
  const fileImpactStats = useMemo(() => {
    const totalFiles = profileResult?.stats?.totalSampled ?? 0
    if (totalFiles <= 0) {
      return {
        totalFiles: 0,
        matchedCount: 0,
        hiddenCount: 0,
        isWhitelistActive: currentWhitelist.labels.length > 0,
        description: t('当前工作目录为空或尚未完成扫描')
      }
    }

    if (currentWhitelist.labels.length === 0) {
      return {
        totalFiles,
        matchedCount: totalFiles,
        hiddenCount: 0,
        isWhitelistActive: false,
        description: t(
          '基于当前目录扫描，预计将展示全部 {totalFiles} 个文件（未启用格式过滤，所有受管文件均正常呈现）',
          { totalFiles }
        )
      }
    }

    // 统计白名单命中数
    const allowedExts = new Set(
      currentWhitelist.extensions.map(r =>
        r.startsWith('.') ? r.toLowerCase() : `.${r.toLowerCase()}`
      )
    )
    let matchedCount = 0
    for (const item of profileResult?.stats?.topExtensions || []) {
      const ext = item.ext.startsWith('.') ? item.ext.toLowerCase() : `.${item.ext.toLowerCase()}`
      if (allowedExts.has(ext)) {
        matchedCount += item.count
      }
    }
    const hiddenCount = Math.max(0, totalFiles - matchedCount)

    return {
      totalFiles,
      matchedCount,
      hiddenCount,
      isWhitelistActive: true,
      description: t(
        '基于当前目录扫描，预计将展示 {matchedCount} / {totalFiles} 个文件（其余 {hiddenCount} 个非此类文件将安全隐藏，绝不改动磁盘原文件）',
        {
          matchedCount,
          totalFiles,
          hiddenCount
        }
      )
    }
  }, [profileResult, currentWhitelist])

  // 提交策略与流转主入口
  const submitPolicy = async (flowMode: 'complete' | 'customize') => {
    if (!workspace.id) {
      toast.error(t('工作区 ID 无效'))
      return
    }
    if (!selectedWorkflow) {
      toast.error(t('工作流数据尚未就绪，请稍后重试'))
      return
    }

    setIsSaving(true)
    setCommitError(null)

    try {
      let actualHw = hardwareInfo
      if (!actualHw && window.electronAPI?.getHardwareInfo) {
        try {
          actualHw = await window.electronAPI.getHardwareInfo()
        } catch {}
      }

      // 解析 AI 引擎参数
      let baseAi: TechnicalEngineParameters
      if (selectedTemplateConfig?.baseAIConfig || selectedTemplateConfig?.derivedSnapshot) {
        baseAi = selectedTemplateConfig.baseAIConfig || selectedTemplateConfig.derivedSnapshot
      } else if (selectedWorkflow.engine_params_json) {
        try {
          baseAi = JSON.parse(selectedWorkflow.engine_params_json)
        } catch {
          baseAi = mapIntentToParameters(mapWorkflowToIntent(selectedWorkflow.id), actualHw)
        }
      } else {
        baseAi = mapIntentToParameters(mapWorkflowToIntent(selectedWorkflow.id), actualHw)
      }

      const templateConfig: Partial<WorkspaceConfig> = {
        schemaVersion: 1,
        status: 'ready',
        workflowId: selectedWorkflow.id,
        customIgnoreRules: selectedTemplateConfig?.customIgnoreRules || [],
        customWhitelistRules: selectedTemplateConfig?.customWhitelistRules || [],
        baseAIConfig: baseAi,
        derivedSnapshot: baseAi,
        advancedAIPrompts: selectedTemplateConfig?.advancedAIPrompts || undefined,
        unitRecognition: selectedTemplateConfig?.unitRecognition || undefined,
        namingPattern:
          selectedWorkflow.naming_pattern || selectedTemplateConfig?.namingPattern || undefined,
        namingTemplate:
          selectedWorkflow.naming_template || selectedTemplateConfig?.namingTemplate || undefined,
        configuredAt: Date.now()
      }

      // 优先调用主进程策略原子提交服务 WorkspacePolicyCommitService
      let commitResult: any
      if (window.electronAPI?.commitWorkspacePolicy) {
        commitResult = await window.electronAPI.commitWorkspacePolicy({
          workspaceId: workspace.id,
          templateConfig,
          boundWorkflowId: selectedWorkflow.id
        })
      } else if (window.electronAPI?.updateWorkspaceConfig) {
        // 回退兼容方案
        const nextPolicyVersion =
          parsedConfig.status === 'ready' ? (parsedConfig.policyVersion ?? 0) + 1 : 1
        const readyConfig: WorkspaceConfig = {
          ...templateConfig,
          policyVersion: nextPolicyVersion
        } as WorkspaceConfig
        const res = await window.electronAPI.updateWorkspaceConfig(workspace.id, readyConfig)
        commitResult = {
          success: res.success,
          policyVersion: nextPolicyVersion,
          appliedConfig: readyConfig,
          error: res.error ? { code: 'UNKNOWN', message: res.error } : undefined
        }
      } else {
        throw new Error(t('主进程未提供配置提交接口'))
      }

      if (!commitResult.success) {
        const errObj = commitResult.error || {
          code: 'UNKNOWN',
          message: t('策略提交未成功')
        }
        setCommitError({
          code: errObj.code || 'UNKNOWN',
          message: errObj.message || t('保存配置失败'),
          stack: errObj.stack,
          payload: {
            workspaceId: workspace.id,
            workflowId: selectedWorkflow.id,
            details: errObj.details
          }
        })
        return
      }

      const appliedConfig =
        commitResult.appliedConfig ||
        ({
          ...templateConfig,
          policyVersion: commitResult.policyVersion
        } as WorkspaceConfig)

      if (flowMode === 'complete') {
        toast.success(
          t('已成功装配「{name}」，正在进入工作目录...', { name: selectedWorkflow.name })
        )
      } else {
        toast.success(
          t('已应用「{name}」，正在为您打开详细微调面板...', { name: selectedWorkflow.name })
        )
      }
      onFinish(flowMode, appliedConfig)
    } catch (err: any) {
      console.error('[WorkspaceSetupWizard] 提交异常:', err)
      setCommitError({
        code: 'UNKNOWN',
        message: err?.message || String(err),
        stack: err?.stack,
        payload: { workspaceId: workspace.id, workflowId: selectedWorkflow.id }
      })
    } finally {
      setIsSaving(false)
    }
  }

  // 复制错误详情到剪贴板
  const copyErrorDetails = () => {
    if (!commitError) return
    const errorPayload = JSON.stringify(commitError, null, 2)
    navigator.clipboard.writeText(errorPayload)
    toast.success(t('已将错误诊断信息复制到剪贴板'))
  }

  // 过滤分类卡片
  const categoryWorkflows = useMemo(() => {
    return workflows.filter(
      (w: any) =>
        w &&
        typeof w.id === 'string' &&
        (activeCategory === 'all' || w?.category === activeCategory)
    )
  }, [activeCategory, workflows])

  // 默认展示 Top 6，展开后展示全部
  const displayedWorkflows = useMemo(() => {
    if (isShowingAllWorkflows) {
      return categoryWorkflows
    }
    return categoryWorkflows.slice(0, 6)
  }, [categoryWorkflows, isShowingAllWorkflows])

  // 列表加载中或空保护
  if (!selectedWorkflow) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-3 p-6 text-center">
        {isWorkflowsLoading && <Loader2 className="w-6 h-6 animate-spin text-primary" />}
        <p className="text-sm font-medium text-foreground">
          {isWorkflowsLoading
            ? t('正在加载官方工作流列表...')
            : t('工作流列表不可用，请重启应用后重试')}
        </p>
        {workflowsLoadError && (
          <p className="text-xs text-muted-foreground max-w-md break-words">{workflowsLoadError}</p>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden p-5 sm:p-6 space-y-3.5 select-none">
      {/* 顶部指示导航与步骤进度条 */}
      <div className="flex items-center justify-between flex-wrap gap-2 pb-2 border-b border-border/60 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-primary/10 text-primary flex items-center justify-center font-bold text-xs shadow-2xs">
            FF
          </div>
          <div>
            <h3 className="text-base sm:text-lg font-bold text-foreground flex items-center gap-2">
              <span>{t('工作目录初始化向导')}</span>
            </h3>
            <p className="text-xs text-muted-foreground">
              {t('智能感知目录生态，自动化装配专属虚拟归档管道')}
            </p>
          </div>
        </div>

        {/* 步骤胶囊指示器 */}
        <div className="flex items-center gap-2 text-xs font-semibold">
          <div
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-full transition-all cursor-pointer',
              currentStep === 1
                ? 'bg-primary text-primary-foreground shadow-xs'
                : 'bg-emerald-600 text-white shadow-2xs'
            )}
            onClick={() => setCurrentStep(1)}
          >
            <span className="w-4 h-4 rounded-full bg-white/20 flex items-center justify-center text-[10px]">
              1
            </span>
            <span>{t('选择工作流')}</span>
          </div>
          <div className="w-6 h-0.5 bg-border/80" />
          <div
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-full transition-all',
              currentStep === 2
                ? 'bg-primary text-primary-foreground shadow-xs'
                : 'bg-muted text-muted-foreground'
            )}
          >
            <span className="w-4 h-4 rounded-full bg-black/10 dark:bg-white/10 flex items-center justify-center text-[10px]">
              2
            </span>
            <span>{t('包含与排除规则确认')}</span>
          </div>
        </div>
      </div>

      {/* 页内常驻错误条 (当提交遇到 STORAGE / PERMISSION / CONFLICT / UNKNOWN 故障时触发) */}
      {commitError && (
        <div className="p-3 rounded-xl border border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300 flex items-start justify-between gap-3 shrink-0 shadow-2xs animate-in fade-in">
          <div className="flex items-start gap-2.5 min-w-0">
            <AlertCircle className="w-4 h-4 text-rose-600 dark:text-rose-400 shrink-0 mt-0.5" />
            <div className="space-y-0.5 min-w-0 text-xs">
              <div className="font-bold flex items-center gap-2">
                <span>{t('策略保存失败')}</span>
                <span className="px-1.5 py-0.2 rounded font-mono text-[10px] bg-rose-500/20 text-rose-800 dark:text-rose-200">
                  {commitError.code}
                </span>
              </div>
              <p className="truncate text-rose-600 dark:text-rose-300">{commitError.message}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => submitPolicy('complete')}
              className="h-7 text-xs px-2.5 border-rose-300 text-rose-700 hover:bg-rose-100 dark:border-rose-800 dark:text-rose-300"
            >
              <RefreshCw className="w-3 h-3 mr-1" />
              <span>{t('重试保存')}</span>
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={copyErrorDetails}
              className="h-7 text-xs px-2 text-rose-700 hover:bg-rose-100 dark:text-rose-300"
              title={t('复制错误诊断信息')}
            >
              <Copy className="w-3 h-3" />
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setCommitError(null)}
              className="h-7 w-7 p-0 text-rose-700 hover:bg-rose-100 dark:text-rose-300"
              title={t('留在当前页')}
            >
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* 全局常驻顶部：当前目录文件构成特征 (第 1、2 步全局常驻显示) */}
      <div className="rounded-xl border border-border/80 bg-gradient-to-br from-card via-card to-muted/20 p-3 shadow-xs shrink-0 space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2 text-xs">
          <div className="flex items-center gap-2 font-semibold text-foreground">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span>{t('当前目录文件构成特征')}</span>
            {distribution && (
              <span className="text-muted-foreground font-normal">
                ({t('抽样 {count} 个文件', { count: distribution.totalSampled })}
                {profileResult?.stats.durationMs ? ` · ${profileResult.stats.durationMs}ms` : ''})
              </span>
            )}
          </div>

          <div className="text-[11px] text-emerald-600 dark:text-emerald-400 font-semibold flex items-center gap-1">
            {isProbing ? (
              <>
                <Loader2 className="w-3 h-3 animate-spin text-primary" />
                <span>{t('正在深度扫描目录文件特征...')}</span>
              </>
            ) : profileResult?.stats?.totalSampled === 0 ? (
              <span className="text-muted-foreground font-normal">
                {t('空目录 (未检测到文件)')}
              </span>
            ) : (
              <>
                <Check className="w-3.5 h-3.5" />
                <span>{t('已完成多维画像嗅探')}</span>
              </>
            )}
          </div>
        </div>

        {/* 动态四色比例条 */}
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
        ) : isProbing ? (
          <div className="text-xs text-muted-foreground flex items-center gap-2 py-1">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />
            <span>{t('正在统计文件构成以推断最佳算力模型...')}</span>
          </div>
        ) : (
          <div className="text-xs text-muted-foreground py-1">
            <span>{t('当前目录为空，放入文件后将自动分类整理')}</span>
          </div>
        )}
      </div>

      {/* ================= 步骤 1 专属：推荐首选通栏横幅 (在第 2 步隐藏) ================= */}
      {currentStep === 1 && top1Recommendation && (
        <div className="p-3 rounded-xl border border-primary/30 bg-gradient-to-r from-primary/10 via-primary/5 to-transparent flex items-center justify-between gap-4 shrink-0 shadow-2xs">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-primary text-primary-foreground flex items-center justify-center text-sm font-bold shrink-0 shadow-xs">
              ★
            </div>
            <div className="min-w-0 space-y-0.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-bold px-2 py-0.5 rounded-full bg-primary text-primary-foreground shadow-2xs">
                  🔥 {t('推荐首选 · 实测 {score} 分', { score: top1Recommendation.score })}
                </span>
                <h4 className="text-sm font-bold text-foreground truncate">
                  {top1Recommendation.name}
                </h4>
                <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground font-medium">
                  {getPersonaLabels()[top1Recommendation?.persona] || top1Recommendation?.persona}
                </span>
              </div>
              <p className="text-xs text-muted-foreground truncate">{top1Recommendation.summary}</p>
            </div>
          </div>

          <Button
            type="button"
            size="sm"
            variant="default"
            onClick={() => {
              hasUserInteractedRef.current = true
              setSelectedWorkflowId(top1Recommendation.id)
              setCurrentStep(2)
            }}
            className="px-3.5 py-1.5 text-xs font-bold bg-primary hover:bg-primary/90 text-primary-foreground shrink-0 shadow-xs"
          >
            <span>{t('采纳此推荐')}</span>
            <ArrowRight className="w-3.5 h-3.5 ml-1" />
          </Button>
        </div>
      )}

      {/* ================= 核心视图主体切换 ================= */}
      {currentStep === 1 ? (
        /* ========== 步骤 1 视图：选择工作流 (左右分栏) ========== */
        <div className="flex-1 flex min-h-0 gap-4 overflow-hidden">
          {/* 左侧：工作流分类与卡片列表 */}
          <div className="flex-1 min-w-0 flex flex-col h-full overflow-y-auto pr-1 space-y-3">
            {/* 分类 Tab（首位展示“全部”） */}
            <div className="flex items-center justify-between flex-wrap gap-2 shrink-0">
              <span className="text-xs font-bold text-foreground">
                {t('全场景官方工作流矩阵库')}
              </span>

              <div className="flex items-center p-0.5 bg-muted/60 rounded-lg border border-border/60 gap-1">
                {getWorkflowCategories(workflows).map(cat => {
                  const isActive = activeCategory === cat.id
                  return (
                    <button
                      key={cat.id}
                      type="button"
                      onClick={() => setActiveCategory(cat.id)}
                      className={cn(
                        'px-2.5 py-1 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-all cursor-pointer select-none',
                        isActive
                          ? 'bg-card text-foreground shadow-2xs border border-border'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      <MaterialIcon icon={cat.icon} className="text-xs" />
                      <span>{cat.name}</span>
                      <span
                        className={cn(
                          'text-[10px] px-1 py-0.2 rounded-full font-mono',
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

            {/* 工作流卡片列表 */}
            <div className="grid grid-cols-1 gap-2.5">
              {displayedWorkflows.map(wf => {
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
                      'relative flex flex-col p-3 rounded-xl border text-left cursor-pointer transition-all duration-200 select-none group',
                      isSelected
                        ? 'bg-primary/5 dark:bg-primary/10 border-primary shadow-xs ring-2 ring-primary/80'
                        : 'bg-card hover:bg-muted/40 border-border/80 hover:border-border'
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div
                          className={cn(
                            'w-8 h-8 rounded-lg flex items-center justify-center transition-colors shrink-0',
                            isSelected
                              ? 'bg-primary text-primary-foreground shadow-xs'
                              : 'bg-muted text-muted-foreground group-hover:text-foreground'
                          )}
                        >
                          <IconComp className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <h5 className="font-bold text-xs sm:text-sm leading-snug truncate text-foreground">
                              {wf.name}
                            </h5>
                            <span className="text-[10px] font-medium text-muted-foreground bg-muted px-1.5 py-0.2 rounded">
                              {getPersonaLabels()[wf?.persona] || wf?.persona}
                            </span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {rec && rec.score >= 60 && (
                          <span className="flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20">
                            <Sparkles className="w-2.5 h-2.5 fill-current" />
                            <span>{rec.score}%</span>
                          </span>
                        )}
                        {isSelected ? (
                          <span className="text-primary font-bold flex items-center gap-1 text-xs">
                            <CheckCircle2 className="w-3.5 h-3.5 fill-current" />
                            <span className="hidden sm:inline">{t('已选中')}</span>
                          </span>
                        ) : (
                          <span className="text-muted-foreground/50 group-hover:text-foreground text-[11px] transition-colors">
                            {t('选择')}
                          </span>
                        )}
                      </div>
                    </div>

                    <p className="text-xs text-muted-foreground leading-relaxed mt-1.5 line-clamp-1">
                      {wf.summary}
                    </p>

                    <div className="mt-2 pt-1.5 border-t border-border/40 text-[11px] flex items-center justify-between text-muted-foreground gap-2">
                      <div className="truncate flex items-center gap-1">
                        <Filter className="w-3 h-3 text-primary/70 shrink-0" />
                        <span className="font-mono truncate">{wf.filter_rules}</span>
                      </div>
                      {wf.naming_template && (
                        <div className="truncate flex items-center gap-1 font-mono text-[10px] text-muted-foreground/70 hidden sm:flex">
                          <Tag className="w-3 h-3 text-primary/70 shrink-0" />
                          <span className="truncate">{wf.naming_template}</span>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            {/* 列表底部：展开 70 套工作流切换按钮 (Ticket 04 AC-4.2) */}
            <div className="pt-2 text-center shrink-0">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setIsShowingAllWorkflows(!isShowingAllWorkflows)}
                className="w-full py-2.5 rounded-xl border border-border hover:bg-muted/40 text-xs font-semibold text-foreground flex items-center justify-center gap-2 cursor-pointer shadow-2xs"
              >
                <span>{isShowingAllWorkflows ? '▲' : '▼'}</span>
                <span>
                  {isShowingAllWorkflows
                    ? t('收起工作流列表 (仅展示推荐)')
                    : t('展示所有工作流 (共 {count} 套)', { count: workflows.length || 70 })}
                </span>
              </Button>
            </div>
          </div>

          {/* 右侧：纯函数单点原型目录树预览 (w-[330px]~w-[390px]) */}
          <div className="w-[320px] sm:w-[350px] lg:w-[380px] shrink-0 h-full flex flex-col rounded-xl border border-border/80 bg-muted/20 dark:bg-muted/10 p-3.5 overflow-hidden shadow-xs space-y-3">
            <div className="space-y-1.5 pb-2.5 border-b border-border/60 shrink-0">
              <div className="flex items-center justify-between gap-1.5">
                <div className="flex items-center gap-1.5 text-xs font-bold text-foreground truncate">
                  <FolderTree className="w-4 h-4 text-primary shrink-0" />
                  <span>{t('预期整理目录结构')}</span>
                </div>
                <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 shrink-0">
                  {getPersonaLabels()[selectedWorkflow?.persona] || selectedWorkflow?.persona}
                </span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-tight">
                {t('选用「{name}」将自动为您构建以下标准归档结构：', {
                  name: selectedWorkflow.name
                })}
              </p>
            </div>

            {/* 树状目录预览 (带命名原型) */}
            <div className="flex-1 overflow-y-auto pr-1 min-h-0 bg-card/60 rounded-lg border border-border/60 p-2.5 shadow-2xs">
              {previewTreeNodes.length > 0 ? (
                <div className="space-y-1">
                  {previewTreeNodes.map((rootNode, idx) => (
                    <PreviewTreeNodeView
                      key={`${rootNode.name}-${idx}`}
                      node={rootNode}
                      isRoot={true}
                    />
                  ))}
                </div>
              ) : (
                <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
                  {t('暂无目录结构预览')}
                </div>
              )}
            </div>

            {/* 安全无损提示 */}
            <div className="flex items-start gap-1.5 pt-1 text-[11px] text-muted-foreground shrink-0 leading-normal">
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />
              <span>
                {t('安全无损：通过虚拟标签树进行整理归档，绝不会物理移动或破坏您的原始磁盘文件。')}
              </span>
            </div>
          </div>
        </div>
      ) : (
        /* ========== 步骤 2 视图：包含与排除规则确认 (大白话版) ========== */
        <div className="flex-1 flex flex-col overflow-y-auto pr-1 space-y-4">
          {/* 选定工作流横幅标头 */}
          <div className="bg-card border border-border rounded-xl p-4 flex items-center justify-between shadow-2xs shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
                {React.createElement(getWorkflowIconComponent(selectedWorkflow.id), {
                  className: 'w-5 h-5'
                })}
              </div>
              <div className="min-w-0 space-y-0.5">
                <div className="flex items-center gap-2 flex-wrap">
                  <h4 className="text-base font-bold text-foreground">{selectedWorkflow.name}</h4>
                  <span className="text-xs px-2 py-0.5 rounded bg-primary/10 text-primary font-semibold">
                    {getPersonaLabels()[selectedWorkflow?.persona] || selectedWorkflow?.persona}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground truncate">{selectedWorkflow.summary}</p>
              </div>
            </div>

            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setCurrentStep(1)}
              className="text-xs font-semibold text-primary hover:underline cursor-pointer shrink-0"
            >
              {t('更换其他工作流')}
            </Button>
          </div>

          {/* 核心板块 1：大白话「包含」卡片 (实测命中数计算) */}
          <div className="bg-emerald-500/[0.04] dark:bg-emerald-500/[0.08] border border-emerald-500/30 rounded-xl p-4 space-y-2.5 shrink-0">
            <div className="flex items-center gap-2.5">
              <span className="w-6 h-6 rounded-md bg-emerald-600 text-white flex items-center justify-center text-xs font-bold">
                ✓
              </span>
              <div className="flex items-center gap-2">
                <h4 className="text-sm font-bold text-emerald-700 dark:text-emerald-400">
                  {t('包含')}
                </h4>
                <span className="text-xs font-semibold text-emerald-700/80 dark:text-emerald-300/80">
                  {t('以下文件才会显示在工作（真实）目录中')}
                </span>
              </div>
            </div>

            {/* 实测命中数描述 (Ticket 04 AC-4.3) */}
            <div className="text-xs font-medium text-emerald-800 dark:text-emerald-200 bg-emerald-500/10 p-2 rounded-lg border border-emerald-500/20">
              {fileImpactStats.description}
            </div>

            {/* 纳管扩展名徽章列表 */}
            {currentWhitelist.labels.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {currentWhitelist.labels.map((rule, idx) => (
                  <span
                    key={idx}
                    className="px-2.5 py-1 rounded-md text-xs font-mono font-bold bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/30"
                  >
                    {rule}
                  </span>
                ))}
              </div>
            )}
          </div>

          {/* 核心板块 2：大白话专属「排除」卡片 (无专属排除时整块 DOM 彻底隐藏 toBeNull) */}
          {currentCustomIgnoreRules.length > 0 && (
            <div
              id="section-exclude"
              className="bg-amber-500/[0.04] dark:bg-amber-500/[0.08] border border-amber-500/30 rounded-xl p-4 space-y-2.5 shrink-0"
            >
              <div className="flex items-center gap-2.5">
                <span className="w-6 h-6 rounded-md bg-amber-600 text-white flex items-center justify-center text-xs font-bold">
                  ✕
                </span>
                <div className="flex items-center gap-2">
                  <h4 className="text-sm font-bold text-amber-700 dark:text-amber-400">
                    {t('排除')}
                  </h4>
                  <span className="text-xs font-medium text-amber-700/80 dark:text-amber-300/80">
                    {t('当前工作区专属排除目录与规则')}
                  </span>
                </div>
              </div>

              <div className="flex flex-wrap gap-1.5 pt-1">
                {currentCustomIgnoreRules.map((rule, idx) => (
                  <span
                    key={idx}
                    className="px-2.5 py-1 rounded-md text-xs font-mono font-bold bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30"
                  >
                    {rule}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 核心板块 3：检索式引擎与智能规范化命名格式 (全大白话规范) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5 shrink-0">
            <div className="bg-card border border-border rounded-xl p-3.5 space-y-2">
              <div className="text-xs font-bold text-foreground flex items-center gap-1.5">
                <span>⚡ {t('检索式引擎')}</span>
              </div>
              <div className="text-xs text-muted-foreground space-y-1.5">
                <div className="flex justify-between items-center">
                  <span>{t('处理模式：')}</span>
                  <span className="font-semibold text-foreground">
                    {selectedWorkflow.analysis_mode === 'deep'
                      ? t('全景多模态深度解析')
                      : t('快速智能命名与轻量归档')}
                  </span>
                </div>
                <div className="flex justify-between items-center">
                  <span>{t('索引级别：')}</span>
                  <span className="font-semibold text-foreground">{t('标准轻量级检索底座')}</span>
                </div>
              </div>
            </div>

            <div className="bg-card border border-border rounded-xl p-3.5 space-y-2">
              <div className="text-xs font-bold text-foreground flex items-center gap-1.5">
                <span>🏷️ {t('智能规范化命名格式')}</span>
              </div>
              <div className="bg-muted/60 p-2 rounded-lg font-mono text-xs text-primary font-bold truncate">
                {selectedWorkflow.naming_template ||
                  selectedTemplateConfig?.namingTemplate ||
                  '{YYYYMMDD}_{SceneType}_{FileName}.{ext}'}
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t('整理时自动按此规律展示，原始磁盘文件名绝不受破坏。')}
              </p>
            </div>
          </div>

          {/* 醒目温馨通知：引导按需微调 */}
          <div className="bg-primary/[0.05] border border-primary/20 rounded-xl p-3.5 flex items-start gap-3 shrink-0">
            <span className="text-base">💡</span>
            <div className="space-y-1 text-xs">
              <div className="font-bold text-foreground">{t('随时支持按需微调')}</div>
              <p className="text-muted-foreground leading-relaxed">
                {t(
                  '以上是系统为您预先搭配的推荐配置。启动后，您可随时在「工作目录设置 ➔ 文件准入与包含排除」中任意添加其他文件扩展名、修改排除规则，或在「检索式引擎」中调整分析深度。'
                )}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* ================= 底部操作栏 (双强主出口) ================= */}
      <div className="pt-3 border-t border-border flex flex-col sm:flex-row items-center justify-between gap-3 shrink-0">
        <div>
          {currentStep === 1 ? (
            <span className="text-xs text-muted-foreground">
              {t('已选定工作流:')}{' '}
              <strong className="text-foreground">{selectedWorkflow.name}</strong>
            </span>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setCurrentStep(1)}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg border border-border text-foreground hover:bg-muted/50 cursor-pointer"
            >
              <ArrowLeft className="w-3.5 h-3.5 mr-1" />
              <span>{t('上一步：重选工作流')}</span>
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2.5 w-full sm:w-auto justify-end">
          {currentStep === 1 ? (
            <Button
              type="button"
              variant="default"
              size="default"
              onClick={() => setCurrentStep(2)}
              className="w-full sm:w-auto flex items-center justify-center gap-2 text-xs font-bold px-5 bg-primary text-primary-foreground hover:bg-primary/90 h-9 shadow-xs"
            >
              <span>{t('下一步')}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </Button>
          ) : (
            /* 步骤 2 并行双强主出口 (Ticket 04 AC-4.6) */
            <div className="flex items-center gap-2.5 w-full sm:w-auto">
              {/* 出口 1：个性化微调工作目录配置 (高亮边框强调) */}
              <Button
                type="button"
                variant="outline"
                size="default"
                disabled={isSaving}
                onClick={() => submitPolicy('customize')}
                className="w-full sm:w-auto flex items-center justify-center gap-1.5 text-xs font-bold px-4 border-2 border-primary text-primary hover:bg-primary hover:text-primary-foreground h-9 shadow-xs transition-all"
              >
                {isSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <span>⚙️</span>}
                <span>{t('个性化微调工作目录配置')}</span>
              </Button>

              {/* 出口 2：立即应用并进入工作目录 (主色按钮) */}
              <Button
                type="button"
                variant="default"
                size="default"
                disabled={isSaving}
                onClick={() => submitPolicy('complete')}
                className="w-full sm:w-auto flex items-center justify-center gap-1.5 text-xs font-bold px-5 bg-emerald-600 hover:bg-emerald-700 text-white h-9 shadow-xs transition-all"
              >
                {isSaving ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Check className="w-3.5 h-3.5" />
                )}
                <span>{t('立即应用并进入工作目录')}</span>
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
