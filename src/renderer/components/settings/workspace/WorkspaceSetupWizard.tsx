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
  IFilterRule,
  IIgnoreRule,
  RecommendReasonCode,
  WorkflowSemanticsScoreRequest
} from '@firefly/types'
import {
  recommendWorkflowByProfile,
  DirectoryProfileStats,
  mapIntentToParameters,
  buildPreviewTree,
  PreviewNode,
  filterOutGlobalExclusionRules,
  getExclusionRuleKey
} from '@firefly/shared'
import { useTierStore } from '../../../stores/tier-store'
import { useSettingsStore } from '../../../stores/settings-store'
import { Button } from '../../ui/button'
import { Label } from '../../ui/label'
import { MaterialIcon, cn } from '../../../lib/utils'
import { FileTypeIcon, extractFileExtension } from '../../common/FileTypeIcon'
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
  Archive,
  Link2,
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
  HelpCircle,
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
  installerCount?: number
  archiveCount?: number
  shortcutCount?: number
  audioCount?: number
  countsByExt?: Record<string, number>
  extensionCounts?: Record<string, number>
  categoryCounts?: Record<string, number>
  topExtensions: Array<{ ext: string; count: number }>
  durationMs: number
  hitTimeBudget: boolean
}

const PROFILE_INSTALLER_EXTS = new Set([
  'exe',
  'msi',
  'dmg',
  'pkg',
  'deb',
  'rpm',
  'apk',
  'appx',
  'msix'
])
const PROFILE_ARCHIVE_EXTS = new Set([
  'zip',
  'rar',
  '7z',
  'tar',
  'gz',
  'bz2',
  'xz',
  'zst',
  'tgz',
  'iso',
  'cab'
])
const PROFILE_SHORTCUT_EXTS = new Set(['lnk', 'url', 'webloc', 'desktop'])
const PROFILE_AUDIO_EXTS = new Set([
  'mp3',
  'wav',
  'flac',
  'aac',
  'ogg',
  'm4a',
  'ape',
  'wma',
  'opus',
  'dsf',
  'dff'
])

/** 统一从工作流记录中提取纳管包含扩展名列表（兼容 workspace_config.customWhitelistRules、extensions、filter_rules） */
function extractWorkflowIncludedExtensions(wf: any): string[] {
  if (!wf) return []
  const seen = new Set<string>()
  const result: string[] = []
  const pushExt = (raw: string) => {
    const trimmed = (raw || '').trim().toLowerCase()
    if (!trimmed) return
    const normalized = trimmed.startsWith('.') ? trimmed : `.${trimmed}`
    if (!seen.has(normalized)) {
      seen.add(normalized)
      result.push(normalized)
    }
  }

  let tplCfg: any = wf.workspace_config
  if (typeof tplCfg === 'string') {
    try {
      tplCfg = JSON.parse(tplCfg)
    } catch {
      tplCfg = null
    }
  }
  if (Array.isArray(tplCfg?.customWhitelistRules)) {
    for (const ext of getExtensionValues(tplCfg.customWhitelistRules)) {
      pushExt(ext)
    }
  }

  if (result.length === 0 && wf.extensions) {
    let extsObj = wf.extensions
    if (typeof extsObj === 'string') {
      try {
        extsObj = JSON.parse(extsObj)
      } catch {
        extsObj = null
      }
    }
    if (Array.isArray(extsObj?.exclusive)) {
      for (const ext of extsObj.exclusive) pushExt(ext)
    }
    if (Array.isArray(extsObj?.common)) {
      for (const ext of extsObj.common) pushExt(ext)
    }
  }

  if (result.length === 0 && wf.filter_rules) {
    try {
      const parsed =
        typeof wf.filter_rules === 'string' ? JSON.parse(wf.filter_rules) : wf.filter_rules
      if (Array.isArray(parsed) && wf.filter_mode !== 'blacklist') {
        for (const ext of getExtensionValues(parsed)) pushExt(ext)
      }
    } catch {}
  }

  return result
}

/** 统一解析工作流关联的文件命名模板 */
function resolveWorkflowNamingTemplate(wf: any, templateConfig?: any): string {
  return (
    wf?.naming_template ||
    templateConfig?.namingTemplate ||
    wf?.naming_pattern ||
    '{YYYYMMDD}_{SceneType}_{FileName}.{ext}'
  )
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

/**
 * 过滤掉已包含在全局生效排除规则中的项，确保仅保留当前工作区独有排除规则
 * 复用 @firefly/shared 的 filterOutGlobalExclusionRules 与 getExclusionRuleKey，并兼容字符串及 file/extension 跨类型同名文件（如 .DS_Store）
 */
function filterWorkspaceUniqueIgnoreEntries(
  globalRules: readonly IIgnoreRule[],
  entries: readonly WizardRuleEntry[]
): WizardRuleEntry[] {
  if (entries.length === 0) return []
  const activeGlobalRules = globalRules.filter(rule => rule && rule.isActive !== false)
  if (activeGlobalRules.length === 0) return [...entries]

  const activeGlobalKeys = new Set(activeGlobalRules.map(rule => getExclusionRuleKey(rule)))
  const activeGlobalFileOrExtValues = new Set<string>()
  const activeGlobalAllValues = new Set<string>()

  for (const rule of activeGlobalRules) {
    const valLower = (rule.value || '').trim().toLowerCase()
    if (!valLower) continue
    activeGlobalAllValues.add(valLower)
    if (rule.type === 'file') {
      activeGlobalFileOrExtValues.add(valLower)
    } else if (rule.type === 'extension') {
      activeGlobalFileOrExtValues.add(valLower.startsWith('.') ? valLower : `.${valLower}`)
    }
  }

  return entries.filter(entry => {
    if (typeof entry === 'string') {
      const rawVal = entry.trim()
      if (!rawVal) return false
      const lowerVal = rawVal.toLowerCase()
      if (activeGlobalAllValues.has(lowerVal)) return false
      if (
        activeGlobalKeys.has(getExclusionRuleKey({ type: 'extension', value: rawVal })) ||
        activeGlobalKeys.has(getExclusionRuleKey({ type: 'file', value: rawVal })) ||
        activeGlobalKeys.has(getExclusionRuleKey({ type: 'directory', value: rawVal }))
      ) {
        return false
      }
      return true
    }

    if (!entry) return false
    const remaining = filterOutGlobalExclusionRules(activeGlobalRules, [
      entry as unknown as IIgnoreRule
    ])
    if (remaining.length === 0) return false

    if (entry.type === 'file' || entry.type === 'extension') {
      const valLower = (entry.value || '').trim().toLowerCase()
      const normalizedFileOrExt =
        entry.type === 'extension' && valLower && !valLower.startsWith('.')
          ? `.${valLower}`
          : valLower
      if (normalizedFileOrExt && activeGlobalFileOrExtValues.has(normalizedFileOrExt)) {
        return false
      }
    }

    return true
  })
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
 * 递归渲染 PreviewNode（支持目录与单点命名原型节点，对齐系统文件/目录预览图标样式）
 */
const PreviewTreeNodeView: React.FC<{
  node: PreviewNode
  depth?: number
  isRoot?: boolean
  namingTemplate?: string
}> = ({ node, depth = 0, isRoot = false, namingTemplate }) => {
  const isPrototype = node.kind === 'naming-prototype'
  const hasChildren = !isPrototype && Array.isArray(node.children) && node.children.length > 0

  if (isPrototype) {
    const ext = extractFileExtension(node.name)
    return (
      <div
        className={cn(
          'select-none text-xs my-1 pl-2 border-l border-primary/50 space-y-1',
          depth > 0 && 'ml-3'
        )}
      >
        <div
          className="flex items-center gap-1.5 py-1.5 px-2 rounded-md bg-primary/10 border border-primary/30 text-primary font-mono text-[11px] shadow-2xs group"
          title={node.name}
        >
          <FileTypeIcon
            extension={ext}
            className="w-4 h-4 object-contain shrink-0"
            fallbackClassName="text-[16px] text-primary shrink-0 leading-none"
          />
          <span className="truncate font-semibold">{node.name}</span>
          <span className="ml-auto text-[9px] px-1.5 py-0.2 rounded bg-primary text-primary-foreground font-sans font-bold shrink-0">
            {t('命名样例')}
          </span>
        </div>
        {namingTemplate && (
          <div className="flex items-center gap-1.5 px-1 text-[10px] text-muted-foreground">
            <span className="px-1 py-0.2 rounded bg-muted text-foreground/80 font-sans font-medium shrink-0">
              {t('命名模板')}
            </span>
            <span className="font-mono truncate" title={namingTemplate}>
              {namingTemplate}
            </span>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={cn('select-none text-xs', depth > 0 && 'ml-3 pl-2 border-l border-border/50')}>
      <div className="flex items-center gap-1.5 py-1 text-foreground font-medium group">
        {isRoot ? (
          <Folder className="w-4 h-4 text-primary fill-primary/20 shrink-0" />
        ) : (
          <Folder className="w-3.5 h-3.5 text-amber-500 fill-amber-500/20 dark:text-amber-400 dark:fill-amber-400/20 shrink-0" />
        )}
        <span className={cn('truncate', isRoot && 'font-bold text-primary')}>{node.name}</span>
      </div>

      {hasChildren && (
        <div className="space-y-0.5">
          {node.children!.map((child, idx) => (
            <PreviewTreeNodeView
              key={`${child.name}-${idx}`}
              node={child}
              depth={depth + 1}
              namingTemplate={namingTemplate}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** 22 项封闭推荐理由大白话映射函数 (符合 AGENTS.md §2.6 / Zero Jargon 铁律) */
function getWorkflowReasonDisplay(reasonCode?: RecommendReasonCode, fallbackText?: string): string {
  switch (reasonCode) {
    case 'photography_raw':
      return t('检测到高价值相机原片，适合专业摄影底片管理')
    case '3d_assets':
      return t('检测到核心三维模型与工程资产，适合建模与游戏资产管理')
    case 'uiux_design':
      return t('检测到视觉设计源文件，适合UI/UX与视觉设计文件整理')
    case 'lossless_audio':
      return t('检测到高保真无损音乐与音频工程，适合音乐制作与收藏')
    case 'video_post':
      return t('检测到专业剪辑与后期工程文件，适合视频创作资产管理')
    case 'comic_manga':
      return t('检测到漫画与画集专属阅读包，适合二次元与数字漫画收纳')
    case 'ebook_novel':
      return t('检测到电子书与文学阅读文件，适合书籍与个人书库整理')
    case 'desktop_declutter':
      return t('检测到多种桌面散杂与快捷方式，适合一键桌面应急急救')
    case 'downloads_triage':
      return t('检测到密集安装包与压缩归档，适合下载暂存区自动分流')
    case 'office_finance':
      return t('检测到高频财务报表与对账表格，适合合同与财务数据归档')
    case 'office_daily':
      return t('检测到高比例日常办公文档，适合行政与综合办公文件管理')
    case 'code_assets':
      return t('检测到高频源码与工程配置，适合技术开发与代码资产收纳')
    case 'general_audio':
      return t('检测到大量音乐与音频录音，适合音频剪辑与素材库管理')
    case 'plain_images':
      return t('检测到大量常用格式图片，适合相册备份与截图管理')
    case 'template_extension_match':
      return t('文件格式与当前工作流预设高度契合')
    case 'empty_directory':
      return t('当前目录为空，放入文件后将自动分类整理')
    case 'insufficient_samples':
      return t('样本文件较少，放入更多文件后将提供更精准推荐')
    case 'high_entropy':
      return t('文件类型较分散，推荐先使用通用收件箱整理')
    case 'executable_programs':
      return t('检测到程序与安装包，适合软件与安装包专区归档')
    case 'extension_weight_fit':
      return t('文件构成比例与该场景理想标准高度相符')
    case 'semantic_filename_boost':
      return t('结合目录特征与文件名深度理解，推荐此专属场景')
    case 'default_fallback':
      return t('文件类型较丰富，推荐采用通用归档方案')
    default:
      return fallbackText || t('文件格式与当前工作流预设高度契合')
  }
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

  // 全局排除规则（用于过滤当前工作区专属排除规则，仅展示工作目录独有配置项）
  const globalIgnoreRules = useSettingsStore(s => s.ignoreRules)
  const loadGlobalIgnoreRules = useSettingsStore(s => s.loadIgnoreRules)

  useEffect(() => {
    if (typeof window.electronAPI?.database?.getAnalysisIgnoreRules === 'function') {
      loadGlobalIgnoreRules()
    }
  }, [loadGlobalIgnoreRules])

  // 解析当前工作区配置
  const parsedConfig = useMemo<WorkspaceConfig>(() => {
    return parseWorkspaceConfig(workspace.workspace_config)
  }, [workspace.workspace_config])

  // 当前选中的工作流 ID
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>(
    (workspace as any).bound_workflow_id || 'builtin.workflow.photography-raw'
  )

  // Stage B 语义分与解锁集合 (单代际 epoch 绑定)
  const probeSeqRef = useRef<number>(0)
  const boundKeyRef = useRef<string>('')
  const [semanticScores, setSemanticScores] = useState<Record<string, number>>({})
  const [unlockedWorkflowIds, setUnlockedWorkflowIds] = useState<string[]>([])

  // 异步探测目录画像 (Stage A 极速首屏 + Stage B 异步端侧语义打分协同流转)
  useEffect(() => {
    let cancelled = false
    const epoch = ++probeSeqRef.current
    const boundKey = `${workspace.id}:${workspace.path}`
    boundKeyRef.current = boundKey
    hasUserInteractedRef.current = false
    setSemanticScores({})
    setUnlockedWorkflowIds([])

    const probe = async () => {
      if (!window.electronAPI?.utils?.probeDirectoryProfile || !workspace.path) return
      setIsProbing(true)
      try {
        const result = await window.electronAPI.utils.probeDirectoryProfile(workspace.path)
        if (cancelled || epoch !== probeSeqRef.current || boundKeyRef.current !== boundKey) {
          return
        }
        if (result) {
          setProfileResult(result as DirectoryProfileResult)

          // Stage B: 触发异步端侧语义向量打分 (仅在 totalSampled >= 5 且有接口时触发)
          const sampled = (result as any).stats?.totalSampled ?? 0
          if (sampled >= 5 && window.electronAPI?.utils?.scoreWorkflowSemantics) {
            const req: WorkflowSemanticsScoreRequest = {
              probeSeq: epoch,
              dirPath: workspace.path,
              countsByExt: (result as any).stats?.countsByExt || {},
              totalFiles: sampled,
              sampledFileNames: (result as any).stats?.sampledFileNames || []
            }

            // 渲染端外层超时 1500ms 熔断保护 (Promise.race)
            const timeoutPromise = new Promise<{ status: 'degraded'; reason: 'timeout' }>(resolve =>
              setTimeout(() => resolve({ status: 'degraded', reason: 'timeout' }), 1500)
            )

            Promise.race([window.electronAPI.utils.scoreWorkflowSemantics(req), timeoutPromise])
              .then(bRes => {
                if (
                  cancelled ||
                  epoch !== probeSeqRef.current ||
                  boundKeyRef.current !== boundKey
                ) {
                  return
                }
                if (bRes?.status === 'ok') {
                  setSemanticScores(bRes.semanticScoresByWorkflowId || {})
                  setUnlockedWorkflowIds([...(bRes.unlockedWorkflowIds || [])])
                }
              })
              .catch(err => {
                console.warn('[WorkspaceSetupWizard] Stage B 语义打分异常:', err)
              })
          }
        }
      } catch (err) {
        console.warn('[WorkspaceSetupWizard] 嗅探目录画像失败:', err)
      } finally {
        if (!cancelled && epoch === probeSeqRef.current) {
          setIsProbing(false)
        }
      }
    }

    probe()
    return () => {
      cancelled = true
    }
  }, [workspace.id, workspace.path, parsedConfig.status])

  // 计算文件特征细分分布百分比（全面覆盖程序、归档、快捷方式、代码、文档、图片、视频、音频与其他）
  const distribution = useMemo(() => {
    const stats = profileResult?.stats
    if (!stats || stats.totalSampled <= 0) {
      return null
    }

    const { totalSampled, docCount, imageCount, videoCount, otherCount } = stats
    const cat = stats.categoryCounts

    let executableCount = cat?.executable ?? cat?.installer ?? stats.installerCount ?? 0
    let archiveCount = cat?.archive ?? stats.archiveCount ?? 0
    let shortcutCount = cat?.application ?? cat?.shortcut ?? stats.shortcutCount ?? 0
    let codeCount = cat?.code ?? 0
    let effectiveDocCount = cat?.doc ?? (cat ? (cat.doc ?? 0) : docCount)
    let effectiveImageCount = cat?.image ?? imageCount
    let effectiveVideoCount = cat?.video ?? videoCount
    let audioCount = cat?.audio ?? stats.audioCount ?? 0
    let otherRemainingCount = cat?.other ?? otherCount

    if (
      cat === undefined &&
      stats.installerCount === undefined &&
      stats.archiveCount === undefined &&
      stats.shortcutCount === undefined
    ) {
      const extEntries: Array<[string, number]> = []
      const mapObj = stats.countsByExt ?? stats.extensionCounts
      if (mapObj && typeof mapObj === 'object') {
        for (const [k, v] of Object.entries(mapObj)) {
          if (typeof v === 'number' && v > 0) extEntries.push([k, v])
        }
      } else if (Array.isArray(stats.topExtensions)) {
        for (const item of stats.topExtensions) {
          if (item && typeof item.count === 'number' && item.count > 0) {
            extEntries.push([item.ext, item.count])
          }
        }
      }

      for (const [rawExt, count] of extEntries) {
        const cleanExt = rawExt.trim().toLowerCase().replace(/^\./, '')
        if (PROFILE_INSTALLER_EXTS.has(cleanExt)) {
          executableCount += count
        } else if (PROFILE_ARCHIVE_EXTS.has(cleanExt)) {
          archiveCount += count
        } else if (PROFILE_SHORTCUT_EXTS.has(cleanExt)) {
          shortcutCount += count
        } else if (PROFILE_AUDIO_EXTS.has(cleanExt)) {
          audioCount += count
        }
      }
      otherRemainingCount = Math.max(
        0,
        (otherCount ?? Math.max(0, totalSampled - docCount - imageCount - videoCount)) -
          (executableCount + archiveCount + shortcutCount + audioCount)
      )
    }

    const rawBuckets = [
      {
        key: 'executable',
        label: t('程序与安装包'),
        count: executableCount,
        colorClass: 'bg-blue-500',
        textClass: 'text-blue-600 dark:text-blue-400',
        Icon: Package
      },
      {
        key: 'archive',
        label: t('压缩归档 (.zip/.7z)'),
        count: archiveCount,
        colorClass: 'bg-amber-500',
        textClass: 'text-amber-600 dark:text-amber-400',
        Icon: Archive
      },
      {
        key: 'shortcut',
        label: t('快捷方式与应用'),
        count: shortcutCount,
        colorClass: 'bg-cyan-500',
        textClass: 'text-cyan-600 dark:text-cyan-400',
        Icon: Link2
      },
      {
        key: 'code',
        label: t('源码与脚本'),
        count: codeCount,
        colorClass: 'bg-indigo-500',
        textClass: 'text-indigo-600 dark:text-indigo-400',
        Icon: Code2
      },
      {
        key: 'doc',
        label: t('文档与表格'),
        count: effectiveDocCount,
        colorClass: 'bg-emerald-500',
        textClass: 'text-emerald-600 dark:text-emerald-400',
        Icon: FileText
      },
      {
        key: 'image',
        label: t('图片与插画'),
        count: effectiveImageCount,
        colorClass: 'bg-violet-500',
        textClass: 'text-violet-600 dark:text-violet-400',
        Icon: ImageIcon
      },
      {
        key: 'video',
        label: t('视频与影视'),
        count: effectiveVideoCount,
        colorClass: 'bg-orange-500',
        textClass: 'text-orange-600 dark:text-orange-400',
        Icon: Film
      },
      {
        key: 'audio',
        label: t('音乐与音频'),
        count: audioCount,
        colorClass: 'bg-pink-500',
        textClass: 'text-pink-600 dark:text-pink-400',
        Icon: Music
      },
      {
        key: 'other',
        label: t('其他格式'),
        count: otherRemainingCount,
        colorClass: 'bg-slate-400 dark:bg-slate-600',
        textClass: 'text-slate-500',
        Icon: HelpCircle
      }
    ].filter(item => item.count > 0)

    const sumCounts = rawBuckets.reduce((acc, b) => acc + b.count, 0)
    const denom = Math.max(totalSampled, sumCounts, 1)

    const segments = rawBuckets.map(item => ({
      ...item,
      pct: Math.max(1, Math.round((item.count / denom) * 100)),
      widthPct: (item.count / denom) * 100
    }))

    return {
      totalSampled,
      segments
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

  // 推导工作流推荐评分列表（传入目录路径先验与全量扩展名映射，确保首推与文件构成严格匹配）
  const workflowRecommendations = useMemo<WorkflowRecommendation[]>(() => {
    if (!profileResult?.stats || profileResult.stats.totalSampled <= 0 || workflows.length === 0) {
      return []
    }
    const pathNorm = (workspace.path || '').trim()
    const isDesktopPath = /(?:^|[\\/])(?:desktop|桌面)(?:[\\/]|$)/i.test(pathNorm)
    const isDownloadsPath = /(?:^|[\\/])(?:downloads?|下载)(?:[\\/]|$)/i.test(pathNorm)

    const profileStats: DirectoryProfileStats = {
      totalFiles: profileResult.stats.totalSampled,
      totalSampled: profileResult.stats.totalSampled,
      docCount: profileResult.stats.docCount,
      imageCount: profileResult.stats.imageCount,
      videoCount: profileResult.stats.videoCount,
      otherCount: profileResult.stats.otherCount,
      countsByExt: profileResult.stats.countsByExt,
      extensionCounts: profileResult.stats.extensionCounts,
      categoryCounts: profileResult.stats.categoryCounts,
      topExtensions: profileResult.stats.topExtensions || [],
      semanticScoresByWorkflowId: semanticScores,
      unlockedWorkflowIds,
      isDesktopPath,
      isDownloadsPath
    }
    return recommendWorkflowByProfile(profileStats, workflows)
  }, [profileResult, workflows, workspace.path, semanticScores, unlockedWorkflowIds])

  // 推荐分数值映射表
  const scoreMap = useMemo(() => {
    const map = new Map<
      string,
      { score: number; matchReason: string; isTop: boolean; reasonCode?: RecommendReasonCode }
    >()
    for (const rec of workflowRecommendations) {
      map.set(rec.workflowId, {
        score: rec.score,
        matchReason: getWorkflowReasonDisplay(rec.reasonCode, rec.matchReason),
        isTop: rec.isTopRecommendation,
        reasonCode: rec.reasonCode
      })
    }
    return map
  }, [workflowRecommendations])

  // Top 1 最佳推荐工作流实体
  const top1Recommendation = useMemo(() => {
    if (workflowRecommendations.length === 0) return null
    const topRec = workflowRecommendations[0]
    const wf = workflows.find((w: any) => w?.id === topRec.workflowId)
    return wf
      ? {
          ...wf,
          score: topRec.score,
          matchReason: getWorkflowReasonDisplay(topRec.reasonCode, topRec.matchReason)
        }
      : null
  }, [workflowRecommendations, workflows])

  // Top 1 智能推荐是否达到高亮门槛 (首选分 >= 70 且领先第二名 >= 15 分，无第二名视为 0 分)
  const isTopRecommendationHighlighted = useMemo(() => {
    if (!workflowRecommendations || workflowRecommendations.length === 0) return false
    const s1 = workflowRecommendations[0].score
    const s2 = workflowRecommendations.length > 1 ? workflowRecommendations[1].score : 0
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

  // 当前工作流的规范命名模板（用于预览树与样例生成）
  const selectedNamingTemplate = useMemo<string>(() => {
    if (!selectedWorkflow) return '{YYYYMMDD}_{SceneType}_{FileName}.{ext}'
    return resolveWorkflowNamingTemplate(selectedWorkflow, selectedTemplateConfig)
  }, [selectedWorkflow, selectedTemplateConfig])

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

    // 解析首选常见扩展名：exclusive > common > workspace_config 白名单 > .dat
    const includedExts = extractWorkflowIncludedExtensions(selectedWorkflow)
    const commonExt = includedExts[0] || '.dat'

    return buildPreviewTree(treeNodes, selectedNamingTemplate, commonExt)
  }, [selectedWorkflow, selectedNamingTemplate])

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

  // 提取当前选定工作流的专属排除规则（剔除全局生效排除规则，无则返回空数组）
  const filteredCustomIgnoreEntries = useMemo<WizardRuleEntry[]>(() => {
    let rawEntries: WizardRuleEntry[] = []
    if (Array.isArray(selectedTemplateConfig?.customIgnoreRules)) {
      rawEntries = selectedTemplateConfig.customIgnoreRules
    } else if (selectedWorkflow?.custom_ignores) {
      try {
        const parsed =
          typeof selectedWorkflow.custom_ignores === 'string'
            ? JSON.parse(selectedWorkflow.custom_ignores)
            : selectedWorkflow.custom_ignores
        if (Array.isArray(parsed)) rawEntries = parsed
      } catch {}
    }
    return filterWorkspaceUniqueIgnoreEntries(globalIgnoreRules, rawEntries)
  }, [selectedTemplateConfig, selectedWorkflow, globalIgnoreRules])

  const currentCustomIgnoreRules = useMemo<string[]>(() => {
    return filteredCustomIgnoreEntries.map(getRuleLabel).filter(Boolean)
  }, [filteredCustomIgnoreEntries])

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

    // 统计白名单命中数（优先全量扩展名映射，其次回退 topExtensions）
    const allowedExts = new Set(
      currentWhitelist.extensions.map(r =>
        r.startsWith('.') ? r.toLowerCase() : `.${r.toLowerCase()}`
      )
    )
    let matchedCount = 0
    const extMap = profileResult?.stats?.countsByExt ?? profileResult?.stats?.extensionCounts
    if (extMap && typeof extMap === 'object') {
      for (const [rawExt, count] of Object.entries(extMap)) {
        const ext = rawExt.startsWith('.') ? rawExt.toLowerCase() : `.${rawExt.toLowerCase()}`
        if (allowedExts.has(ext) && typeof count === 'number') {
          matchedCount += count
        }
      }
    } else {
      for (const item of profileResult?.stats?.topExtensions || []) {
        const ext = item.ext.startsWith('.') ? item.ext.toLowerCase() : `.${item.ext.toLowerCase()}`
        if (allowedExts.has(ext)) {
          matchedCount += item.count
        }
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
        extensionWeights:
          selectedTemplateConfig?.extensionWeights ||
          selectedWorkflow.extensionWeights ||
          undefined,
        customIgnoreRules: Array.isArray(selectedTemplateConfig?.customIgnoreRules)
          ? filterWorkspaceUniqueIgnoreEntries(
              globalIgnoreRules,
              selectedTemplateConfig.customIgnoreRules
            ).filter((r): r is IFilterRule => typeof r !== 'string')
          : [],
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
        const rawErr = commitResult.error
        const fallbackCode = commitResult.errorCode || 'UNKNOWN'
        const fallbackMsg = commitResult.errorMessage || t('策略提交未成功')
        const errObj = {
          code: rawErr?.code || fallbackCode,
          message: rawErr?.message || fallbackMsg,
          stack: rawErr?.stack,
          details: rawErr?.details
        }
        setCommitError({
          code: errObj.code,
          message: errObj.message,
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

  // 过滤分类卡片并按推荐契合度降序排列，保证最匹配的工作流始终排在列表前列
  const categoryWorkflows = useMemo(() => {
    const filtered = workflows.filter(
      (w: any) =>
        w &&
        typeof w.id === 'string' &&
        (activeCategory === 'all' || w?.category === activeCategory)
    )
    if (scoreMap.size === 0) return filtered
    return [...filtered].sort((a, b) => {
      const sa = scoreMap.get(a.id)?.score ?? -1
      const sb = scoreMap.get(b.id)?.score ?? -1
      return sb - sa
    })
  }, [activeCategory, workflows, scoreMap])

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
              <span>{t('工作目录工作流向导')}</span>
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

        {/* 动态多维细分比例条 */}
        {distribution ? (
          <div className="space-y-2">
            <div className="h-2 w-full rounded-full overflow-hidden flex bg-muted/60">
              {distribution.segments.map(seg => (
                <div
                  key={seg.key}
                  style={{ width: `${seg.widthPct}%` }}
                  className={cn(seg.colorClass, 'transition-all duration-500')}
                  title={`${seg.label}: ${seg.pct}%`}
                />
              ))}
            </div>

            {/* 细分类图例占比药丸 */}
            <div className="flex items-center gap-3 sm:gap-4 flex-wrap text-[11px]">
              {distribution.segments.map(seg => {
                const SegIcon = seg.Icon
                return (
                  <span key={seg.key} className="flex items-center gap-1 text-muted-foreground">
                    <span className={cn('w-2 h-2 rounded-full', seg.colorClass)} />
                    <SegIcon className={cn('w-3 h-3', seg.textClass)} />
                    <span className="font-medium text-foreground/90">{seg.label}</span>
                    <span>{seg.pct}%</span>
                  </span>
                )
              })}
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
        <div
          className={cn(
            'p-3 rounded-xl border flex items-center justify-between gap-4 shrink-0 shadow-2xs transition-colors',
            isTopRecommendationHighlighted
              ? 'border-primary/40 bg-gradient-to-r from-primary/15 via-primary/10 to-transparent ring-1 ring-primary/20'
              : 'border-border/50 bg-muted/30'
          )}
        >
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={cn(
                'w-9 h-9 rounded-xl flex items-center justify-center text-sm font-bold shrink-0 shadow-xs',
                isTopRecommendationHighlighted
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground'
              )}
            >
              ★
            </div>
            <div className="min-w-0 space-y-0.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span
                  className={cn(
                    'text-xs font-bold px-2 py-0.5 rounded-full shadow-2xs',
                    isTopRecommendationHighlighted
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground'
                  )}
                >
                  {`${isTopRecommendationHighlighted ? '🔥 ' : '★ '}${t('推荐首选 · 实测 {score} 分', { score: top1Recommendation.score })}`}
                </span>
                <h4 className="text-sm font-bold text-foreground truncate">
                  {top1Recommendation.name}
                </h4>
                <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground font-medium">
                  {getPersonaLabels()[top1Recommendation?.persona] || top1Recommendation?.persona}
                </span>
              </div>
              <p className="text-xs text-muted-foreground truncate">
                {top1Recommendation.matchReason || top1Recommendation.summary}
              </p>
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
                      {rec?.matchReason || wf.summary}
                    </p>

                    {(() => {
                      const includedExts = extractWorkflowIncludedExtensions(wf)
                      const wfNamingTemplate = wf.naming_template || wf.naming_pattern
                      return (
                        <div className="mt-2 pt-1.5 border-t border-border/40 text-[11px] flex items-center justify-between text-muted-foreground gap-2">
                          <div className="min-w-0 flex items-center gap-1.5 flex-wrap">
                            <span className="font-semibold text-emerald-600 dark:text-emerald-400 shrink-0 flex items-center gap-1">
                              <Filter className="w-3 h-3 shrink-0" />
                              {t('包含扩展名:')}
                            </span>
                            {includedExts.length > 0 ? (
                              <div className="flex items-center gap-1 flex-wrap">
                                {includedExts.slice(0, 5).map(ext => (
                                  <span
                                    key={ext}
                                    className="px-1.5 py-0.2 rounded bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border border-emerald-500/20 font-mono text-[10px]"
                                  >
                                    {ext}
                                  </span>
                                ))}
                                {includedExts.length > 5 && (
                                  <span className="text-[10px] font-mono text-muted-foreground">
                                    +{includedExts.length - 5}
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="text-[11px] text-muted-foreground">
                                {t('全部受管格式')}
                              </span>
                            )}
                          </div>
                          {wfNamingTemplate && (
                            <div
                              className="truncate max-w-[140px] flex items-center gap-1 font-mono text-[10px] text-muted-foreground/70 hidden sm:flex shrink-0"
                              title={wfNamingTemplate}
                            >
                              <Tag className="w-3 h-3 text-primary/70 shrink-0" />
                              <span className="truncate">{wfNamingTemplate}</span>
                            </div>
                          )}
                        </div>
                      )
                    })()}
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
                      namingTemplate={selectedNamingTemplate}
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
              {/* 出口 1：个性化微调工作目录配置 (高亮边框强调；悬停沿用主题主色文字与浅底，规避暗色模式下 --primary-foreground 深黑对比度失真) */}
              <Button
                type="button"
                variant="outline"
                size="default"
                disabled={isSaving}
                onClick={() => submitPolicy('customize')}
                className="w-full sm:w-auto flex items-center justify-center gap-1.5 text-xs font-bold px-4 border-2 border-primary text-primary hover:bg-primary/10 hover:text-primary hover:border-primary dark:hover:bg-primary/20 dark:hover:text-primary dark:hover:border-primary h-9 shadow-xs transition-all"
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
