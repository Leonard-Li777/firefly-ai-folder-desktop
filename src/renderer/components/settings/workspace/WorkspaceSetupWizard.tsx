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
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel
} from '../../ui/alert-dialog'
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
  Folder,
  FolderTree,
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
  Tag,
  ShieldCheck,
  ChevronRight,
  Layers
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
  designer: 'UI/UX设计师',
  digital_artist: '3D与美术设计师',
  modeler: '3D建模师',
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

/**
 * 根据文件名后缀获取对应的小图标
 */
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

/** 树节点通用结构 */
interface TreeNode {
  name: string
  children?: TreeNode[]
  previewFiles?: string[]
}

/** 从工作流对象解析预览树数据 */
function parseWorkflowPreviewTree(workflow: {
  name: string
  preview_tree?: string | null
  preset_directory_tree?: string | null
}): TreeNode | null {
  if (workflow.preview_tree) {
    try {
      const parsed = JSON.parse(workflow.preview_tree)
      if (parsed && typeof parsed === 'object') {
        return parsed as TreeNode
      }
    } catch {
      // fallback
    }
  }

  if (workflow.preset_directory_tree) {
    try {
      const parsed = JSON.parse(workflow.preset_directory_tree)
      if (Array.isArray(parsed)) {
        const convertNode = (node: any): TreeNode => ({
          name: node.name || '未命名目录',
          children: node.subdirectories?.map(convertNode)
        })
        return {
          name: workflow.name,
          children: parsed.map(convertNode)
        }
      }
    } catch {
      // fallback
    }
  }

  return {
    name: workflow.name,
    children: [{ name: '01_标准化归整', previewFiles: ['示例归档文件_01.dat'] }]
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

/** 递归目录树展示子组件 */
const DirectoryTreeNodeView: React.FC<{
  node: TreeNode
  depth?: number
  isRoot?: boolean
}> = ({ node, depth = 0, isRoot = false }) => {
  const hasChildren = node.children && node.children.length > 0
  const hasFiles = node.previewFiles && node.previewFiles.length > 0

  return (
    <div className={cn('select-none text-xs', depth > 0 && 'ml-3 pl-2 border-l border-border/50')}>
      {/* 目录节点行 */}
      <div className="flex items-center gap-1.5 py-1 text-foreground font-medium group">
        {isRoot ? (
          <FolderTree className="w-4 h-4 text-primary shrink-0" />
        ) : (
          <FolderOpen className="w-3.5 h-3.5 text-amber-500/90 dark:text-amber-400 shrink-0" />
        )}
        <span className={cn('truncate', isRoot && 'font-bold text-primary')}>{node.name}</span>
        {hasFiles && (
          <span className="text-[10px] text-muted-foreground/70 font-mono ml-auto">
            {node.previewFiles!.length} 项
          </span>
        )}
      </div>

      {/* 示例文件列表 */}
      {hasFiles && (
        <div className="ml-3 pl-2 border-l border-border/40 space-y-1 my-0.5">
          {node.previewFiles!.map((fileName, idx) => {
            const FileIcon = getPreviewFileIcon(fileName)
            return (
              <div
                key={idx}
                className="flex items-center gap-1.5 py-0.5 px-1.5 rounded-md text-[11px] font-mono text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
                title={fileName}
              >
                <FileIcon className="w-3 h-3 text-primary/70 shrink-0" />
                <span className="truncate">{fileName}</span>
              </div>
            )
          })}
        </div>
      )}

      {/* 递归渲染子目录 */}
      {hasChildren && (
        <div className="space-y-0.5">
          {node.children!.map((child, idx) => (
            <DirectoryTreeNodeView key={idx} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 工作目录智能配置向导 (WorkspaceSetupWizard)
 *
 * 升级为基于工作流的两段式优雅布局 + 左右分栏结构：
 * 1. 顶部：文件特征扫描画像与扩展名可视化 UI（多色比例条、主要格式胶囊、AI 匹配诊断横幅）；
 * 2. 左栏：AI 智能推荐大卡片 + 3-Tab 官方工作流矩阵库卡片列表；
 * 3. 右栏：实时联动展示选定工作流的目录树（preview_tree）、示例文件与智能命名规约；
 * 4. 底部：选定反馈与双通道流转（快捷直接启动 / 主出口保存并打开详细配置）。
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

  // 解析当前选中工作流的目录树结构
  const previewTreeData = useMemo<TreeNode | null>(() => {
    if (!selectedWorkflow) return null
    return parseWorkflowPreviewTree(selectedWorkflow)
  }, [selectedWorkflow])

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

  // 切换工作流确认弹窗状态 (方案 B: 参数分层与定案保护)
  const [showSwitchConfirm, setShowSwitchConfirm] = useState(false)
  const [pendingFlowMode, setPendingFlowMode] = useState<'complete' | 'customize'>('complete')

  // 统一提交入口：若检测到曾自定义过高级参数，弹出方案 B 二次确认
  const submitConfig = (flowMode: 'complete' | 'customize') => {
    const hasCustomOverrides =
      parsedConfig.status === 'ready' &&
      ((parsedConfig.overrides && Object.keys(parsedConfig.overrides).length > 0) ||
        (parsedConfig.customIgnoreRules && parsedConfig.customIgnoreRules.length > 0))
    if (hasCustomOverrides) {
      setPendingFlowMode(flowMode)
      setShowSwitchConfirm(true)
    } else {
      doSubmitConfig(flowMode, false)
    }
  }

  const handleConfirmPreserveOverrides = () => {
    setShowSwitchConfirm(false)
    doSubmitConfig(pendingFlowMode, true)
  }

  const handleConfirmResetOverrides = () => {
    setShowSwitchConfirm(false)
    doSubmitConfig(pendingFlowMode, false)
  }

  // 执行就绪配置持久化与工作流绑定
  const doSubmitConfig = async (flowMode: 'complete' | 'customize', preserveOverrides: boolean) => {
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

      // 就绪配置对象 (根据用户二次确认决定是保留自定义 overrides 与规则还是彻底重置为新工作流基线)
      const readyConfig: WorkspaceConfig = {
        schemaVersion: 1,
        status: 'ready',
        intent: mapWorkflowToIntent(selectedWorkflow.id),
        policyVersion: 1,
        derivedSnapshot,
        overrides:
          preserveOverrides && parsedConfig.status === 'ready' && parsedConfig.overrides
            ? parsedConfig.overrides
            : undefined,
        customIgnoreRules:
          preserveOverrides && parsedConfig.status === 'ready'
            ? parsedConfig.customIgnoreRules
            : undefined,
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

      // 3. 过滤规则同步持久化：白名单模式写入扩展名集合，黑名单模式清空白名单恢复全量入场
      if (window.electronAPI?.updateWorkspaceWhitelist) {
        if (selectedWorkflow.filter_mode === 'whitelist' && whitelistPatterns.length > 0) {
          await window.electronAPI.updateWorkspaceWhitelist(workspace.id, whitelistPatterns)
        } else {
          await window.electronAPI.updateWorkspaceWhitelist(workspace.id, [])
        }
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
    <div className="flex flex-col h-full overflow-hidden p-5 sm:p-6 space-y-3.5">
      {/* 头部标题与引导：清晰告知为当前工作目录定制专属工作流 */}
      <div className="space-y-1 shrink-0">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="space-y-0.5">
            <h3 className="text-lg sm:text-xl font-bold flex items-center gap-2.5 text-foreground">
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
              <span className="text-muted-foreground/60 hidden sm:inline">({workspace.path})</span>
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
      <div className="rounded-xl border border-border/80 bg-gradient-to-br from-card via-card to-muted/20 p-3.5 shadow-xs shrink-0 space-y-2.5">
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
          <div className="flex items-start gap-2.5 p-2 rounded-lg bg-primary/5 border border-primary/20 text-xs text-foreground/90">
            <Sparkles className="w-4 h-4 text-primary shrink-0 mt-0.5" />
            <div className="leading-relaxed font-normal">
              <span className="font-semibold text-primary mr-1">{t('✨ AI 匹配诊断:')}</span>
              {expectedImpactText}
            </div>
          </div>
        )}
      </div>

      {/* 左右分栏核心交互区：左侧选工作流，右侧预览结构化目录树 */}
      <div className="flex-1 flex min-h-0 gap-4 overflow-hidden">
        {/* ==================== 左侧：工作流选择与矩阵库 (可纵向滚动) ==================== */}
        <div className="flex-1 min-w-0 flex flex-col h-full overflow-y-auto pr-1 space-y-3">
          {/* 段落 1: 顶部高亮「AI 智能推荐」主卡片 (触发门槛: S1 >= 70 且领先 S2 至少 15 分) */}
          {isTopRecommendationHighlighted && top1Recommendation && (
            <div className="rounded-xl border-2 border-amber-500/60 bg-gradient-to-r from-amber-500/[0.08] via-primary/[0.04] to-card p-3.5 shadow-xs relative overflow-hidden space-y-2.5 shrink-0">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-9 h-9 rounded-xl bg-amber-500/20 text-amber-600 dark:text-amber-400 flex items-center justify-center shrink-0 shadow-xs border border-amber-500/30">
                    {React.createElement(getWorkflowIconComponent(top1Recommendation.id), {
                      className: 'w-4 h-4'
                    })}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <h4 className="font-bold text-sm text-foreground leading-snug">
                        {top1Recommendation.name}
                      </h4>
                      <span className="text-[10px] px-2 py-0.5 rounded-full font-bold bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-xs">
                        🔥 {t('契合度 {score}%', { score: top1Recommendation.score })}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md font-semibold bg-muted text-muted-foreground border border-border/60">
                        {PERSONA_LABELS[top1Recommendation.persona] || top1Recommendation.persona}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed line-clamp-1">
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
                    className="bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold px-3 shadow-xs h-7.5"
                  >
                    <Sparkles className="w-3.5 h-3.5 mr-1 fill-current" />
                    <span>{t('一键采用推荐')}</span>
                  </Button>
                </div>
              </div>

              {/* 规则与命名格式预览行 */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 pt-2 border-t border-border/40 text-[11px]">
                <div className="flex items-center gap-1.5 text-muted-foreground truncate">
                  <Filter className="w-3 h-3 text-primary shrink-0" />
                  <span className="font-medium text-foreground">{t('准入:')}</span>
                  <span className="truncate font-mono">
                    {top1Recommendation.filter_mode === 'whitelist'
                      ? t('白名单放行')
                      : t('黑名单过滤')}
                    {' · '}
                    {top1Recommendation.filter_rules}
                  </span>
                </div>
                <div className="flex items-center gap-1.5 text-muted-foreground truncate">
                  <Tag className="w-3 h-3 text-primary shrink-0" />
                  <span className="font-medium text-foreground">{t('智能命名:')}</span>
                  <span className="truncate font-mono">
                    {top1Recommendation.naming_template ||
                      top1Recommendation.naming_pattern ||
                      t('标准格式')}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* 段落 2: 底部 3-Tab 分类平铺工作流卡片库 */}
          <div className="space-y-2.5">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <Label className="text-xs font-bold text-foreground flex items-center gap-1.5">
                <span>{t('全场景官方工作流矩阵库')}</span>
                <span className="text-muted-foreground font-normal">({t('共 11 套')})</span>
              </Label>

              {/* 3-Tab 分类切换器 */}
              <div className="flex items-center p-0.5 bg-muted/60 rounded-lg border border-border/60 gap-1">
                {WORKFLOW_CATEGORIES.map(cat => {
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
                      <span>{t(cat.name)}</span>
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

            {/* 工作流平铺卡片列表 */}
            <div className="space-y-2">
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
                              {PERSONA_LABELS[wf.persona] || wf.persona}
                            </span>
                          </div>
                        </div>
                      </div>

                      {/* 推荐分数值小胶囊或选中状态 */}
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

                    {/* 准入规则与智能命名小条 */}
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
          </div>

          {/* 影视剪辑素材场景 Free/Pro 权益中性告知 */}
          {isFreeTier && selectedWorkflow.id === 'builtin.workflow.video-production' && (
            <div className="flex items-center gap-2 p-2.5 rounded-xl bg-primary/5 border border-primary/20 text-xs text-muted-foreground">
              <Sparkles className="w-4 h-4 text-primary shrink-0" />
              <span>{t('当前体验首个 5 分钟切片分析，升级 Pro 可流式续作自动处理全片')}</span>
            </div>
          )}
        </div>

        {/* ==================== 右侧：实时预览选中工作流的目录树与整理效果 ==================== */}
        <div className="w-[330px] sm:w-[360px] lg:w-[390px] shrink-0 h-full flex flex-col rounded-xl border border-border/80 bg-muted/20 dark:bg-muted/10 p-3.5 overflow-hidden shadow-xs space-y-3">
          {/* 右侧头部：选定工作流的特征标头 */}
          <div className="space-y-1.5 pb-2.5 border-b border-border/60 shrink-0">
            <div className="flex items-center justify-between gap-1.5">
              <div className="flex items-center gap-1.5 text-xs font-bold text-foreground truncate">
                <FolderTree className="w-4 h-4 text-primary shrink-0" />
                <span>{t('预期整理结构与效果预览')}</span>
              </div>
              <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20 shrink-0">
                {PERSONA_LABELS[selectedWorkflow.persona] || selectedWorkflow.persona}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground leading-tight">
              {t('选用「{name}」将自动为您构建以下标准虚拟归档目录：', {
                name: selectedWorkflow.name
              })}
            </p>
          </div>

          {/* 智能命名与放行规则指示条 */}
          <div className="bg-card/70 border border-border/60 rounded-lg p-2.5 space-y-1.5 shrink-0 text-[11px]">
            <div className="flex items-center justify-between text-muted-foreground">
              <span className="font-medium text-foreground flex items-center gap-1">
                <Filter className="w-3 h-3 text-primary shrink-0" />
                <span>{t('准入放行:')}</span>
              </span>
              <span className="font-mono text-[10px] truncate max-w-[190px] bg-muted/60 px-1 py-0.2 rounded">
                {selectedWorkflow.filter_rules}
              </span>
            </div>
            {selectedWorkflow.naming_template && (
              <div className="flex items-center justify-between text-muted-foreground">
                <span className="font-medium text-foreground flex items-center gap-1">
                  <Tag className="w-3 h-3 text-primary shrink-0" />
                  <span>{t('智能命名:')}</span>
                </span>
                <span className="font-mono text-[10px] truncate max-w-[190px] bg-muted/60 px-1 py-0.2 rounded text-primary">
                  {selectedWorkflow.naming_template}
                </span>
              </div>
            )}
          </div>

          {/* 右侧主体：树状目录预览 (带滚动条) */}
          <div className="flex-1 overflow-y-auto pr-1 min-h-0 bg-card/60 rounded-lg border border-border/60 p-2.5 shadow-2xs">
            {previewTreeData ? (
              <DirectoryTreeNodeView node={previewTreeData} isRoot={true} />
            ) : (
              <div className="h-full flex items-center justify-center text-xs text-muted-foreground">
                {t('暂无目录结构预览')}
              </div>
            )}
          </div>

          {/* 右侧底部：无损虚拟目录机制保障提示 */}
          <div className="flex items-start gap-1.5 pt-1 text-[11px] text-muted-foreground shrink-0 leading-normal">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-500 shrink-0 mt-0.5" />
            <span>
              {t('安全无损：通过虚拟标签树进行整理归档，绝不会物理移动或破坏您的原始磁盘文件。')}
            </span>
          </div>
        </div>
      </div>

      {/* 底部双通道流转操作栏：主按钮高亮（应用推荐并查看详细配置） + 快捷通道 */}
      <div className="pt-3 border-t border-border flex flex-col sm:flex-row items-center justify-between gap-3 shrink-0">
        <div className="text-xs text-muted-foreground flex items-center gap-2 min-w-0">
          <Sliders className="w-3.5 h-3.5 text-primary shrink-0" />
          <span className="truncate">
            {t('已选定工作流:')}{' '}
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

      {/* 切换工作流二次确认定案弹窗 (方案 B: 参数分层与定案保护) */}
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
              onClick={() => setShowSwitchConfirm(false)}
            >
              {t('取消')}
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
