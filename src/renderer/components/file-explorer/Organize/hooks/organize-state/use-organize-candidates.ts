import { useCallback, useEffect, useRef, useState } from 'react'
import { VirtualDirectory, VirtualDirectoryNode } from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import i18nScope from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { toast } from '../../../../common/Toast'
import { useAnalyzedDirectoryStore } from '../../../../../stores/analyzed-directory-store'
import { useOrganizeStore } from '../../../../../stores/organize-store'
import { OrganizeMode } from '../../types'
import { buildSkeletonTree, sanitizeTree, parseStrategyToTree } from '../../utils/helpers'
import { getUniqueVirtualDirectoryName } from '../../../VirtualDirectory/utils/vdir-naming-utils'
import { calculateDirectoryLimits as calcDirectoryLimits } from '../../utils/directory-limits'
import { getDefaultGuidancePrompt } from './guidance-prompt'

interface UseOrganizeCandidatesParams {
  toOrganizeFiles: any[]
  isLoadingFiles: boolean
  virtualDirectories: VirtualDirectory[]
  currentVDir: VirtualDirectory | null
  setCurrentVDir: (v: VirtualDirectory | null) => void
  guidancePrompt: string
  setShowGuidanceDialog: (v: boolean) => void
  setIsGeneratingTree: (v: boolean) => void
}

/**
 * 候选方案域：AI 候选生成、指导方案生成、候选选择与自定义方案解析。
 */
export function useOrganizeCandidates({
  toOrganizeFiles,
  isLoadingFiles,
  virtualDirectories,
  currentVDir,
  setCurrentVDir,
  guidancePrompt,
  setShowGuidanceDialog,
  setIsGeneratingTree
}: UseOrganizeCandidatesParams) {
  const { t } = useVoerkaI18n(i18nScope)
  const currentWorkspaceDirectory = useAnalyzedDirectoryStore(
    (s: any) => s.currentWorkspaceDirectory
  )
  const dimensionGroups = useAnalyzedDirectoryStore((s: any) => s.dimensionGroups)
  const stage = useOrganizeStore(s => s.stage)
  const organizeMode = useOrganizeStore(s => s.organizeMode)
  const setOrganizeMode = useOrganizeStore(s => s.setOrganizeMode)
  const setDraft = useOrganizeStore(s => s.setDraft)
  const setDraftTree = useOrganizeStore(s => s.setDraftTree)
  const setStage = useOrganizeStore(s => s.setStage)

  // ─── 候选方案 (State 1) ───────────────────────────────────────────────────
  const [candidates, setCandidates] = useState<any[]>([])
  const [isGeneratingCandidates, setIsGeneratingCandidates] = useState(false)
  const [selectedCandidate, setSelectedCandidate] = useState<any>(null)
  const hasAttemptedCandidatesRef = useRef(false)

  const [activeGuidancePrompt, setActiveGuidancePrompt] = useState<string>('')

  // ─── State 1: 生成 AI 候选方案 ────────────────────────────────────────────
  const generateCandidates = useCallback(async () => {
    if (!currentWorkspaceDirectory?.id) {
      return
    }
    // 门禁：仅精细整理模式才需要调用高级 AI 语言模型生成目录方案，身份蓝图等模式严禁调用
    if (organizeMode !== 'fine-organize') {
      return
    }
    setIsGeneratingCandidates(true)
    setCandidates([])
    try {
      const result = await window.electronAPI!.virtualDirectory.generateNameAndStrategyCandidates(
        currentWorkspaceDirectory.id,
        3,
        activeGuidancePrompt.trim() || undefined,
        organizeMode,
        toOrganizeFiles.map(f => f.id)
      )
      if (result && (result as any).success === false) {
        if (
          (result as any).status === 'SERVICE_SWITCHING' ||
          (result as any).message?.includes('切换中')
        ) {
          toast.warning((result as any).message || t('模型正在切换中，请等待'))
        } else {
          toast.error((result as any).message || t('生成候选方案失败，请重试'))
        }
        return
      }
      const candidatesList = result?.candidates || result || []
      setCandidates(Array.isArray(candidatesList) ? candidatesList : [])
    } catch (e) {
      logger.error(LogCategory.FILE_ORGANIZATION, '生成候选方案失败:', e)
      toast.error(t('生成候选方案失败，请重试'))
    } finally {
      setIsGeneratingCandidates(false)
    }
  }, [currentWorkspaceDirectory?.id, organizeMode, toOrganizeFiles, activeGuidancePrompt])

  // 当进入 candidates 阶段且为精细整理模式无候选方案时，自动生成
  useEffect(() => {
    if (stage !== 'candidates' || organizeMode !== 'fine-organize') {
      hasAttemptedCandidatesRef.current = false
      return
    }
    if (candidates.length === 0 && !isGeneratingCandidates && !hasAttemptedCandidatesRef.current) {
      if (isLoadingFiles && toOrganizeFiles.length === 0) {
        return
      }
      hasAttemptedCandidatesRef.current = true
      generateCandidates()
    }
  }, [
    stage,
    organizeMode,
    candidates.length,
    isGeneratingCandidates,
    generateCandidates,
    isLoadingFiles,
    toOrganizeFiles
  ])

  // ─── 指导方案生成 ───────────────────────────────────────────────────────
  const handleGuideGeneration = useCallback(async () => {
    const prompt = guidancePrompt.trim() || getDefaultGuidancePrompt()
    if (!currentWorkspaceDirectory?.id) return
    setShowGuidanceDialog(false)
    setIsGeneratingCandidates(true)
    setCandidates([])
    try {
      setActiveGuidancePrompt(prompt)
      const result = await window.electronAPI!.virtualDirectory.generateNameAndStrategyCandidates(
        currentWorkspaceDirectory.id,
        3,
        prompt,
        organizeMode,
        toOrganizeFiles.map(f => f.id)
      )
      if (result && (result as any).success === false) {
        if (
          (result as any).status === 'SERVICE_SWITCHING' ||
          (result as any).message?.includes('切换中')
        ) {
          toast.warning((result as any).message || t('模型正在切换中，请等待'))
        } else {
          toast.error((result as any).message || t('生成失败，请重试'))
        }
        return
      }
      const candidatesList = result?.candidates || result || []
      setCandidates(Array.isArray(candidatesList) ? candidatesList : [])
    } catch (e) {
      logger.error(LogCategory.FILE_ORGANIZATION, '指导方案生成失败:', e)
      toast.error(t('生成失败，请重试'))
    } finally {
      setIsGeneratingCandidates(false)
    }
  }, [guidancePrompt, currentWorkspaceDirectory?.id, organizeMode, toOrganizeFiles])

  // 计算目录数限制 n 和 x（逻辑委托给可测试的纯函数 calculateDirectoryLimits）
  const calculateDirectoryLimits = useCallback((totalFiles: number) => calcDirectoryLimits(totalFiles), [])

  const handleSelectCandidate = useCallback(
    async (candidate: any) => {
      setOrganizeMode('fine-organize')
      setSelectedCandidate(candidate)
      const existingNames = (virtualDirectories || []).map(vd => vd.name)
      const rawName = candidate.name || t('新虚拟目录')
      const uniqueName = getUniqueVirtualDirectoryName(rawName, existingNames)

      // 在同一个整理 Session 内部，死死锁定当前 Session 绑定的 currentVDir 句柄（无论属于已恢复的草稿，还是当次 Session 建立的临时草稿）；
      // 原位更新当前 Session 的方案元数据，绝对不重新解绑置 null，从源头上防范 Session 内部因【换一个】或方案重选而衍生派生出多余垃圾草稿；
      // 只有当跨 Session 重新开启新整理任务时，由 resetOrganizeState 统一复位 currentVDir。
      if (currentVDir?.id) {
        window
          .electronAPI!.virtualDirectory.updateMeta(currentVDir.id, {
            name: uniqueName,
            strategy: candidate.strategy || '',
            perspective: candidate.perspective || '',
            rationale: candidate.rationale || candidate.description || ''
          })
          .catch(err => {
            logger.warn(LogCategory.FILE_ORGANIZATION, '更新当前 Session 草稿元数据失败:', err)
          })
      }

      setDraft({
        name: uniqueName,
        strategy: candidate.strategy || '',
        perspective: candidate.perspective || '',
        rationale: candidate.rationale || candidate.description || '',
        source: 'draft'
      })

      setStage('structure')

      // 核心体验提升：精细整理大模型直接生成了完整的层级目录树（Markdown 格式），
      // 优先直接解析进入目录树调整与预览，消除长达数十秒的二次模型推理等待
      const directParsedTree = candidate.strategy ? parseStrategyToTree(candidate.strategy) : null
      if (directParsedTree && directParsedTree.length > 0) {
        setDraftTree(directParsedTree)
        setIsGeneratingTree(false)
        return
      }

      setIsGeneratingTree(true)
      setDraftTree([])

      try {
        const totalFiles = toOrganizeFiles.length
        const { maxDirectoryCount, freeDirectoryReserve } = calculateDirectoryLimits(totalFiles)

        const selectedFileTagSet = new Set<string>()
        const tagFileCountMap = new Map<string, number>()
        toOrganizeFiles.forEach((f: any) => {
          const fileTags: string[] =
            f.dimensionTags && Array.isArray(f.dimensionTags) && f.dimensionTags.length > 0
              ? f.dimensionTags.map((dt: any) => dt.tag)
              : Array.isArray(f.tags)
                ? f.tags
                : []
          fileTags.forEach((t: string) => {
            selectedFileTagSet.add(t)
            tagFileCountMap.set(t, (tagFileCountMap.get(t) || 0) + 1)
          })
        })

        const filterDimensionByTags = (groups: any[]) =>
          groups
            .map((g: any) => ({
              ...g,
              tags: (g.tags || [])
                .filter((t: any) => selectedFileTagSet.has(t.tagValue))
                .map((t: any) => ({
                  ...t,
                  fileCount: tagFileCountMap.get(t.tagValue) || 0
                }))
            }))
            .filter((g: any) => g.tags.length > 0)

        const scopedDimensionGroups = filterDimensionByTags(dimensionGroups)

        const result = await window.electronAPI!.virtualDirectory.reorganize(0, {
          workspaceDirectoryPath: currentWorkspaceDirectory?.path || '',
          mode: organizeMode,
          selectedFileIds: toOrganizeFiles.map(f => f.id),
          selectedTagsTree: scopedDimensionGroups.map(g => ({
            id: String(g.id),
            name: g.name,
            subdirectories: (g.tags || []).map((t: any) => ({
              id: t.tagValue,
              name: t.tagValue,
              fileCount: t.fileCount || 0,
              files: [],
              subdirectories: []
            })),
            files: []
          })),
          includeFileList: organizeMode === 'fine-organize',
          dimensionInfo: dimensionGroups,
          userInstruction: candidate.strategy,
          isPreview: true,
          maxDirectoryCount,
          freeDirectoryReserve
        })

        if (result?.success === false) {
          logger.warn(LogCategory.FILE_ORGANIZATION, 'AI生成目录树预览被拒绝或失败:', result)
          if (result.message) {
            toast.error(result.message)
          }
        }

        let finalOutlineTree: VirtualDirectoryNode[] = []
        if (result?.tree && result.tree.length > 0) {
          finalOutlineTree = sanitizeTree(result.tree, true)
        } else {
          finalOutlineTree = buildSkeletonTree(dimensionGroups, organizeMode)
        }

        setDraftTree(finalOutlineTree)
      } catch (e: any) {
        logger.error(LogCategory.FILE_ORGANIZATION, 'AI生成目录树预览失败:', e)
        toast.error(t('AI生成目录树预览失败: {message}', { message: e?.message || e }))
        const fallbackTree = buildSkeletonTree(dimensionGroups, organizeMode)
        setDraftTree(fallbackTree)
      } finally {
        setIsGeneratingTree(false)
      }
    },
    [
      dimensionGroups,
      organizeMode,
      currentWorkspaceDirectory?.path,
      calculateDirectoryLimits,
      toOrganizeFiles,
      virtualDirectories,
      currentVDir,
      setCurrentVDir
    ]
  )

  // ─── 自定义方案提交 → 直接解析目录树 → 进入 State 2 ──────────────────────
  const handleCustomSubmit = useCallback(
    async (
      name: string,
      strategy: string,
      treeOrMode?: VirtualDirectoryNode[] | OrganizeMode
    ) => {
      const isFromExternalAi =
        treeOrMode === 'external-ai' || organizeMode === 'external-ai'
      const targetMode = typeof treeOrMode === 'string' ? treeOrMode : undefined
      const activeMode: OrganizeMode = isFromExternalAi
        ? 'fine-organize'
        : targetMode || organizeMode || 'custom-tree'
      setOrganizeMode(activeMode)

      const candidate = { name, strategy }
      setSelectedCandidate(candidate)
      setCurrentVDir(null)
      setDraft({
        name,
        strategy,
        source: isFromExternalAi ? 'external-ai' : 'custom-tree'
      })
      setStage('structure')

      setIsGeneratingTree(true)
      setDraftTree([])

      try {
        let finalCustomTree: VirtualDirectoryNode[] | null = null
        if (Array.isArray(treeOrMode) && treeOrMode.length > 0) {
          finalCustomTree = treeOrMode
        } else {
          const parsedTree = parseStrategyToTree(strategy, name.trim())
          finalCustomTree =
            parsedTree && parsedTree.length > 0
              ? parsedTree
              : buildSkeletonTree(dimensionGroups, activeMode)
        }

        setDraftTree(finalCustomTree)
      } catch (e) {
        logger.error(LogCategory.FILE_ORGANIZATION, '解析目录树失败:', e)
        const fallbackTree = buildSkeletonTree(dimensionGroups, activeMode)
        setDraftTree(fallbackTree)
        toast.error(t('目录树解析出错，已使用默认骨架树'))
      } finally {
        setIsGeneratingTree(false)
      }
    },
    [dimensionGroups, organizeMode, setCurrentVDir]
  )

  return {
    candidates,
    setCandidates,
    isGeneratingCandidates,
    setIsGeneratingCandidates,
    selectedCandidate,
    setSelectedCandidate,
    hasAttemptedCandidatesRef,
    activeGuidancePrompt,
    setActiveGuidancePrompt,
    generateCandidates,
    handleGuideGeneration,
    handleSelectCandidate,
    handleCustomSubmit,
    calculateDirectoryLimits
  }
}
