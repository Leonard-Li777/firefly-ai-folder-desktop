import React, { useState, useEffect, useMemo, useRef } from 'react'
import {
  WorkspaceDirectory,
  WorkspaceConfig,
  HardwareInfo,
  UserTier,
  WorkflowRecommendation,
  WorkflowCategory,
  parseWorkspaceConfig,
  IFilterRule,
  RecommendReasonCode,
  TechnicalEngineParameters,
  WorkflowSemanticsScoreRequest,
  DirectoryTreeNode
} from '@firefly/types'
import {
  recommendWorkflowByProfile,
  DirectoryProfileStats,
  buildPreviewTree,
  PreviewNode
} from '@firefly/shared'
import { useTierStore } from '../../../stores/tier-store'
import { useSettingsStore } from '../../../stores/settings-store'
import { Button } from '../../ui/button'
import {
  Loader2,
  Package,
  Archive,
  Link2,
  Code2,
  FileText,
  Image as ImageIcon,
  Film,
  Music,
  HelpCircle
} from 'lucide-react'
import { toast } from '../../common/Toast'
import { t } from '@app/languages'
import { submitWorkspacePolicyMutation } from '../../../lib/workspace-policy/workspace-ai-client'

import type {
  WorkspaceSetupWizardProps,
  DirectoryProfileResult,
  PolicyCommitErrorState,
  WizardRuleEntry
} from './workspace-setup-wizard/types'
export type { WorkspaceSetupWizardProps } from './workspace-setup-wizard/types'

import {
  PROFILE_INSTALLER_EXTS,
  PROFILE_ARCHIVE_EXTS,
  PROFILE_SHORTCUT_EXTS,
  PROFILE_AUDIO_EXTS
} from './workspace-setup-wizard/constants'
import {
  extractWorkflowIncludedExtensions,
  filterWorkspaceUniqueIgnoreEntries,
  getExtensionValues,
  getRuleLabel,
  getWorkflowReasonDisplay,
  mapWorkflowToIntent,
  resolveWorkflowNamingTemplate
} from './workspace-setup-wizard/helpers'
import {
  WizardHeader,
  CommitErrorBanner,
  DirectoryDistributionPanel,
  WizardFooter
} from './workspace-setup-wizard/wizard-chrome'
import { WorkflowSelectionStep } from './workspace-setup-wizard/workflow-selection-step'
import { RuleConfirmationStep } from './workspace-setup-wizard/rule-confirmation-step'

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
  onFinish,
  onSkip
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

  // 当前选中的工作流 ID (初始为空，由已有绑定或高置信度推荐决策，杜绝低分推荐盲目默认预选)
  const [selectedWorkflowId, setSelectedWorkflowId] = useState<string>(
    (workspace as any).bound_workflow_id || ''
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

    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const runStageB = (req: WorkflowSemanticsScoreRequest, allowRetry: boolean) => {
      const scoreFn = window.electronAPI?.utils?.scoreWorkflowSemantics
      if (!scoreFn) return
      // 渲染端全异步外层超时 5000ms 熔断保护 (Promise.race，不阻塞 Stage A 首屏)
      const timeoutPromise = new Promise<{ status: 'degraded'; reason: 'timeout' }>(resolve =>
        setTimeout(() => resolve({ status: 'degraded', reason: 'timeout' }), 5000)
      )

      Promise.race([scoreFn(req), timeoutPromise])
        .then(bRes => {
          if (cancelled || epoch !== probeSeqRef.current || boundKeyRef.current !== boundKey) {
            return
          }
          if (bRes?.status === 'ok') {
            setSemanticScores(bRes.semanticScoresByWorkflowId || {})
            setUnlockedWorkflowIds([...(bRes.unlockedWorkflowIds || [])])
          } else if (
            allowRetry &&
            (bRes?.reason === 'timeout' || bRes?.reason === 'engine_not_ready')
          ) {
            // 首次冷启动预热或引擎拉起尚未完成时，延迟 2.5s 静默重试 1 次（此时后台官方向量多已落缓存）
            retryTimer = setTimeout(() => {
              if (!cancelled && epoch === probeSeqRef.current && boundKeyRef.current === boundKey) {
                runStageB(req, false)
              }
            }, 2500)
          }
        })
        .catch(err => {
          console.warn('[WorkspaceSetupWizard] Stage B 语义打分异常:', err)
        })
    }

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

          // Stage B: 触发异步端侧语义向量打分 (放宽至 >= 1 单样本冷启动)
          const sampled = (result as any).stats?.totalSampled ?? 0
          if (
            sampled >= 1 &&
            typeof window.electronAPI?.utils?.scoreWorkflowSemantics === 'function'
          ) {
            const req: WorkflowSemanticsScoreRequest = {
              probeSeq: epoch,
              dirPath: workspace.path,
              countsByExt: (result as any).stats?.countsByExt || {},
              totalFiles: sampled,
              sampledFileNames: (result as any).stats?.sampledFileNames || [],
              sampledSubDirNames: (result as any).stats?.sampledSubDirNames || []
            }
            runStageB(req, true)
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
      if (retryTimer) clearTimeout(retryTimer)
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
    let shortcutCount = cat?.shortcut ?? stats.shortcutCount ?? 0
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
        label: t('快捷方式与链接'),
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

  // 初始自动预选推荐工作流 (置信度守卫：仅当推荐分 >= 70 时自动预选，避免低分弱推荐被强加默认选中引发困惑)
  useEffect(() => {
    if (top1Recommendation && !hasUserInteractedRef.current) {
      if (top1Recommendation.score >= 70) {
        setSelectedWorkflowId(top1Recommendation.id)
      }
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
    if (Array.isArray(selectedTemplateConfig?.customIncludeRules)) {
      rules = selectedTemplateConfig.customIncludeRules
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
  const filteredCustomExcludeEntries = useMemo<WizardRuleEntry[]>(() => {
    let rawEntries: WizardRuleEntry[] = []
    if (Array.isArray(selectedTemplateConfig?.customExcludeRules)) {
      rawEntries = selectedTemplateConfig.customExcludeRules
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

  const currentCustomExcludeRules = useMemo<string[]>(() => {
    return filteredCustomExcludeEntries.map(getRuleLabel).filter(Boolean)
  }, [filteredCustomExcludeEntries])

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
        '基于当前目录扫描，预计将展示 {matchedCount} / {totalFiles} 个文件（其余 {hiddenCount} 个非此类文件将在本软件中隐藏，绝不改动磁盘原文件）',
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
      // 工作流 AI 基线由主进程仲裁内核按 workflowId 派生；渲染层不再本地拼装 baseAIConfig /
      // engine_params_json，统一通过平铺补丁通道提交工作流绑定与包含/排除规则。
      const excludeRules = Array.isArray(selectedTemplateConfig?.customExcludeRules)
        ? filterWorkspaceUniqueIgnoreEntries(
            globalIgnoreRules,
            selectedTemplateConfig.customExcludeRules
          ).filter((r): r is IFilterRule => typeof r !== 'string')
        : []
      const mutationRes = await submitWorkspacePolicyMutation(workspace.id, {
        workflowId: selectedWorkflow.id,
        preserveOverrides: false,
        customExcludeRules: excludeRules,
        customIncludeRules: selectedTemplateConfig?.customIncludeRules || []
      })
      const commitResult: any = {
        success: mutationRes.success,
        policyVersion: mutationRes.policyVersion,
        appliedConfig: mutationRes.appliedConfig,
        admissionChanged: mutationRes.admissionChanged,
        errorCode: mutationRes.errorCode,
        errorMessage: mutationRes.errorMessage,
        error:
          typeof mutationRes.error === 'string'
            ? { code: mutationRes.errorCode || 'UNKNOWN', message: mutationRes.error }
            : mutationRes.error
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
          ...selectedTemplateConfig,
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
        {onSkip && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onSkip}
            data-testid="skip-wizard-btn"
            className="mt-2 text-xs"
          >
            <span>{t('跳过向导，直接进入设置')}</span>
          </Button>
        )}
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden p-5 sm:p-6 space-y-3.5 select-none">
      <WizardHeader currentStep={currentStep} setCurrentStep={setCurrentStep} />

      <CommitErrorBanner
        commitError={commitError}
        submitPolicy={submitPolicy}
        copyErrorDetails={copyErrorDetails}
        setCommitError={setCommitError}
      />

      <DirectoryDistributionPanel
        distribution={distribution}
        profileResult={profileResult}
        isProbing={isProbing}
      />

      {/* ================= 核心视图主体切换 ================= */}
      {currentStep === 1 ? (
        <WorkflowSelectionStep
          currentStep={currentStep}
          top1Recommendation={top1Recommendation}
          isTopRecommendationHighlighted={isTopRecommendationHighlighted}
          workflows={workflows}
          displayedWorkflows={displayedWorkflows}
          activeCategory={activeCategory}
          setActiveCategory={setActiveCategory}
          selectedWorkflowId={selectedWorkflowId}
          setSelectedWorkflowId={setSelectedWorkflowId}
          hasUserInteractedRef={hasUserInteractedRef}
          scoreMap={scoreMap}
          previewTreeNodes={previewTreeNodes}
          selectedNamingTemplate={selectedNamingTemplate}
          selectedWorkflow={selectedWorkflow}
          isShowingAllWorkflows={isShowingAllWorkflows}
          setIsShowingAllWorkflows={setIsShowingAllWorkflows}
          setCurrentStep={setCurrentStep}
        />
      ) : (
        <RuleConfirmationStep
          selectedWorkflow={selectedWorkflow}
          selectedTemplateConfig={selectedTemplateConfig}
          currentWhitelist={currentWhitelist}
          fileImpactStats={fileImpactStats}
          currentCustomExcludeRules={currentCustomExcludeRules}
          setCurrentStep={setCurrentStep}
        />
      )}

      <WizardFooter
        currentStep={currentStep}
        selectedWorkflow={selectedWorkflow}
        selectedWorkflowId={selectedWorkflowId}
        top1Recommendation={top1Recommendation}
        isSaving={isSaving}
        onSkip={onSkip}
        submitPolicy={submitPolicy}
        setSelectedWorkflowId={setSelectedWorkflowId}
        setCurrentStep={setCurrentStep}
      />
    </div>
  )
}
