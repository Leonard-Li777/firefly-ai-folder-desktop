import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { LogCategory, logger } from '@firefly/shared'
import { useAnalyzedDirectoryStore } from '../../../../stores/analyzed-directory-store'
import { useOrganizeStore } from '../../../../stores/organize-store'
import { useTierStore } from '../../../../stores/tier-store'
import { useOrganizeWorkdir } from './organize-state/use-organize-workdir'
import { useOrganizeFiles } from './organize-state/use-organize-files'
import { useOrganizeDialogs } from './organize-state/use-organize-dialogs'
import { useOrganizeCapacity } from './organize-state/use-organize-capacity'
import { useOrganizeEntryReset } from './organize-state/use-organize-entry-reset'
import { useOrganizeCandidates } from './organize-state/use-organize-candidates'
import { useOrganizeDrafts } from './organize-state/use-organize-drafts'
import { useOrganizeTree } from './organize-state/use-organize-tree'
import { useOrganizeExecution } from './organize-state/use-organize-execution'
import { useOrganizeRescue } from './organize-state/use-organize-rescue'
import { useOrganizePhase } from './organize-state/use-organize-phase'

export function useOrganizeState() {
  const location = useLocation()
  const prevPathRef = useRef(location.pathname)
  const currentWorkspaceDirectory = useAnalyzedDirectoryStore(
    (s: any) => s.currentWorkspaceDirectory
  )
  const dimensionGroups = useAnalyzedDirectoryStore((s: any) => s.dimensionGroups)

  const highFrequencyTags = useMemo(() => {
    const set = new Set<string>()
    if (!dimensionGroups || !Array.isArray(dimensionGroups)) return set
    for (const group of dimensionGroups) {
      if (group.tags && Array.isArray(group.tags)) {
        for (const tag of group.tags) {
          if (tag.tagValue) {
            set.add(tag.tagValue.trim().toLowerCase())
            set.add(tag.tagValue.trim())
          }
        }
      }
    }
    return set
  }, [dimensionGroups])

  const { computed_limits, fetchProfile } = useTierStore()

  // ─── 阶段 & 模式 (绑定 Zustand store 实现 Keep-Alive) ────────────────────
  const stage = useOrganizeStore(s => s.stage)
  const setStage = useOrganizeStore(s => s.setStage)
  const organizeMode = useOrganizeStore(s => s.organizeMode)
  const setOrganizeMode = useOrganizeStore(s => s.setOrganizeMode)

  const draftTree = useOrganizeStore(s => s.draftTree)
  const setDraftTree = useOrganizeStore(s => s.setDraftTree)
  const draft = useOrganizeStore(s => s.draft)
  const setDraft = useOrganizeStore(s => s.setDraft)

  const progressInfo = useOrganizeStore(s => s.progressInfo)
  const setProgressInfo = useOrganizeStore(s => s.setProgressInfo)
  const isPaused = useOrganizeStore(s => s.isPaused)
  const setIsPaused = useOrganizeStore(s => s.setIsPaused)
  const finalTree = useOrganizeStore(s => s.finalTree)
  const setFinalTree = useOrganizeStore(s => s.setFinalTree)

  const unmatchedCount = useOrganizeStore(s => s.unmatchedCount)
  const setUnmatchedCount = useOrganizeStore(s => s.setUnmatchedCount)
  const hasRescueFailed = useOrganizeStore(s => s.hasRescueFailed)
  const setHasRescueFailed = useOrganizeStore(s => s.setHasRescueFailed)
  const options = useOrganizeStore(s => s.options)
  const setOptions = useOrganizeStore(s => s.setOptions)

  const [currentVDir, setCurrentVDir] = useState<any>(null)
  const isSavedRef = useRef(false)
  const currentVDirRef = useRef<any>(null)

  useEffect(() => {
    currentVDirRef.current = currentVDir
  }, [currentVDir])

  // 修正：当处于初始 mode-select 阶段时，确保 skipEmptyDirs 为 false
  // 防止旧版本代码遗留的 skipEmptyDirs:true 影响新整理流程的空目录显示
  // 注意：只在 mode-select（尚未开始整理）时重置，不影响整理中/完成阶段的用户设置
  useEffect(() => {
    if (
      useOrganizeStore.getState().stage === 'mode-select' &&
      useOrganizeStore.getState().options.skipEmptyDirs === true
    ) {
      useOrganizeStore
        .getState()
        .setOptions({ ...useOrganizeStore.getState().options, skipEmptyDirs: false })
    }
  }, [])

  const [viewMode, setViewMode] = useState<'list' | 'grid' | 'waterfall'>('grid')
  const [isLimitPredict, setIsLimitPredict] = useState(false)
  const lastRescuedIdsRef = useRef<Set<string>>(new Set())
  const [virtualDirectories, setVirtualDirectories] = useState<any[]>([])
  const [isGeneratingTree, setIsGeneratingTree] = useState(false)

  const workdir = useOrganizeWorkdir()
  const files = useOrganizeFiles({ currentVDir })
  const dialogs = useOrganizeDialogs()
  const capacity = useOrganizeCapacity({ rawToOrganizeCount: files.rawToOrganizeCount })

  useOrganizeEntryReset({
    organizeCapacityLimit: capacity.organizeCapacityLimit,
    setIsCapacityExceeded: capacity.setIsCapacityExceeded,
    setCapacityExceededCount: capacity.setCapacityExceededCount,
    setShowCapacityLimitDialog: capacity.setShowCapacityLimitDialog,
    setIncrementalVdId: files.setIncrementalVdId,
    setIncrementalFiles: files.setIncrementalFiles,
    setInitialDraftTree: files.setInitialDraftTree,
    setCurrentVDir,
    loadFilesToOrganize: files.loadFilesToOrganize,
    isSavedRef
  })

  const candidatesHook = useOrganizeCandidates({
    toOrganizeFiles: files.toOrganizeFiles,
    isLoadingFiles: files.isLoadingFiles,
    virtualDirectories,
    currentVDir,
    setCurrentVDir,
    guidancePrompt: dialogs.guidancePrompt,
    setShowGuidanceDialog: dialogs.setShowGuidanceDialog,
    setIsGeneratingTree
  })

  const drafts = useOrganizeDrafts({
    virtualDirectories,
    setVirtualDirectories,
    lastRescuedIdsRef,
    isSavedRef,
    setCurrentVDir,
    allWorkspaceFiles: files.allWorkspaceFiles,
    setIncrementalVdId: files.setIncrementalVdId,
    setIncrementalFiles: files.setIncrementalFiles,
    setInitialDraftTree: files.setInitialDraftTree,
    setRegenerateFiles: files.setRegenerateFiles,
    setIsLoadingFiles: files.setIsLoadingFiles,
    setSelectedCandidate: candidatesHook.setSelectedCandidate,
    setCandidates: candidatesHook.setCandidates
  })

  const resetOrganizeState = useMemo(() => {
    return () => {
      // 注意：禁止自动删除 draft 整理任务！
      // 未保存的草稿将妥善保留在数据库中，仅允许主用户在模式选择 stage (ModeSelectView) 手动触发删除。

      setStage('mode-select')
      setViewMode('grid')
      setOrganizeMode(undefined)
      files.setIncrementalVdId(null)
      files.setIncrementalFiles([])
      setIsLimitPredict(false)
      files.setRegenerateFiles(null)
      drafts.setInitialVDirInfo(null)
      candidatesHook.setCandidates([])
      candidatesHook.setIsGeneratingCandidates(false)
      candidatesHook.setSelectedCandidate(null)
      candidatesHook.hasAttemptedCandidatesRef.current = false
      setDraftTree([])
      files.setInitialDraftTree([])
      setDraft(null)
      setProgressInfo({ current: 0, total: 0, message: '' })
      setIsPaused(false)
      setFinalTree([])
      setUnmatchedCount(0)
      setHasRescueFailed(false)
      setCurrentVDir(null)
      setOptions({
        allowCreateNew: true,
        skipEmptyDirs: false,
        deduplicateFiles: true,
        flattenToRoot: false
      })
      setIsGeneratingTree(false)
      dialogs.setShowBackConfirm(false)
      dialogs.setShowGuidanceDialog(false)
      dialogs.setGuidancePrompt('')
      dialogs.setShowStartDropdown(false)
      dialogs.setShowSaveDropdown(false)
      dialogs.setShowEditStrategy(false)
    }
  }, [])

  const tree = useOrganizeTree({
    allWorkspaceFiles: files.allWorkspaceFiles,
    incrementalVdId: files.incrementalVdId,
    setIncrementalVdId: files.setIncrementalVdId,
    currentVDir,
    setCurrentVDir,
    setIncrementalFiles: files.setIncrementalFiles
  })

  // 展示层树：优先使用最终树，否则回退草稿树
  const displayTree = useMemo(() => {
    return finalTree.length > 0 ? finalTree : draftTree
  }, [finalTree, draftTree])

  const execution = useOrganizeExecution({
    allWorkspaceFiles: files.allWorkspaceFiles,
    dimensionGroups,
    regenerateFiles: files.regenerateFiles,
    toOrganizeFiles: files.toOrganizeFiles,
    organizeMode: organizeMode as any,
    options,
    isGeneratingTree,
    organizeCapacityLimit: capacity.organizeCapacityLimit,
    bypassCapacityLimit: capacity.bypassCapacityLimit,
    displayTree,
    currentVDir,
    isSavedRef,
    loadFilesToOrganize: files.loadFilesToOrganize,
    loadVirtualDirectories: drafts.loadVirtualDirectories,
    resetOrganizeState,
    isRegenerate: dialogs.isRegenerate,
    isRegenerateFree: dialogs.isRegenerateFree,
    setShowRegenerateFirecoreConfirm: dialogs.setShowRegenerateFirecoreConfirm,
    setCurrentVDir
  })

  const rescue = useOrganizeRescue({
    currentVDir,
    incrementalVdId: files.incrementalVdId,
    lastRescuedIdsRef
  })

  const phase = useOrganizePhase({
    candidates: candidatesHook.candidates,
    selectedCandidate: candidatesHook.selectedCandidate,
    isCapacityExceeded: capacity.isCapacityExceeded,
    currentVDir,
    setCurrentVDir,
    draft,
    isSavedRef,
    setActiveGuidancePrompt: candidatesHook.setActiveGuidancePrompt,
    setShowBackConfirm: dialogs.setShowBackConfirm,
    setCandidates: candidatesHook.setCandidates,
    setSelectedCandidate: candidatesHook.setSelectedCandidate,
    setDraft,
    setDraftTree,
    setFinalTree,
    setIncrementalVdId: files.setIncrementalVdId,
    setIncrementalFiles: files.setIncrementalFiles,
    setInitialDraftTree: files.setInitialDraftTree
  })

  // 监听路由变化：仅记录上一路径，不自动重置状态（Keep-Alive 设计）
  // 整理流程状态由 Zustand store 跨页面保持，用户主动退出时才重置
  useEffect(() => {
    prevPathRef.current = location.pathname
  }, [location.pathname])

  // ─── 自动恢复维度标签组 ───────────────────────────────────────────────────
  useEffect(() => {
    const fetchDimensionGroups = async () => {
      if (currentWorkspaceDirectory?.path && dimensionGroups.length === 0) {
        try {
          const res = await window.electronAPI!.analyzedDirectory.getDimensionGroups({
            workspaceDirectoryPath: currentWorkspaceDirectory.path,
            removeEmptyTags: true
          })
          if (res?.groups) {
            useAnalyzedDirectoryStore.getState().setDimensionGroups(res.groups)
          }
        } catch (e) {
          logger.error(LogCategory.FILE_ORGANIZATION, '初始化获取维度标签组失败:', e)
        }
      }
    }
    fetchDimensionGroups()
  }, [currentWorkspaceDirectory?.path, dimensionGroups.length])

  // 检查是否为限制预测模式
  useEffect(() => {
    const checkLimit = async () => {
      try {
        if (window.electronAPI?.virtualDirectory?.checkIsLimitPredict) {
          const res = await window.electronAPI.virtualDirectory.checkIsLimitPredict()
          setIsLimitPredict(res)
        }
      } catch (e) {
        logger.error(LogCategory.FILE_ORGANIZATION, 'Failed to check isLimitPredict:', e)
      }
    }
    checkLimit()
  }, [])

  return {
    currentWorkspaceDirectory,
    dimensionGroups,
    workspaceDirectories: workdir.workspaceDirectories,
    loadWorkspaceDirectories: workdir.loadWorkspaceDirectories,
    showDirectoryDropdown: workdir.showDirectoryDropdown,
    setShowDirectoryDropdown: workdir.setShowDirectoryDropdown,
    isWorkspaceActive: workdir.isWorkspaceActive,
    viewMode,
    setViewMode,
    stage,
    setStage,
    organizeMode,
    setOrganizeMode,
    incrementalVdId: files.incrementalVdId,
    handleSelectIncrementalVd: drafts.handleSelectIncrementalVd,
    isLimitPredict,

    isLoadingFiles: files.isLoadingFiles,
    toOrganizeFiles: files.toOrganizeFiles,
    candidates: candidatesHook.candidates,
    isGeneratingCandidates: candidatesHook.isGeneratingCandidates,
    generateCandidates: candidatesHook.generateCandidates,
    selectedCandidate: candidatesHook.selectedCandidate,
    setSelectedCandidate: candidatesHook.setSelectedCandidate,
    draftTree,
    setDraftTree,
    draft,
    setDraft,
    progressInfo,
    isPaused,
    finalTree,
    displayTree,
    unmatchedCount,
    hasRescueFailed,
    currentVDir,
    virtualDirectories,
    options,
    setOptions,
    showBackConfirm: dialogs.showBackConfirm,
    setShowBackConfirm: dialogs.setShowBackConfirm,
    showGuidanceDialog: dialogs.showGuidanceDialog,
    setShowGuidanceDialog: dialogs.setShowGuidanceDialog,
    guidancePrompt: dialogs.guidancePrompt,
    setGuidancePrompt: dialogs.saveGuidancePrompt,
    resetGuidancePrompt: dialogs.resetGuidancePrompt,
    showEditStrategy: dialogs.showEditStrategy,
    setShowEditStrategy: dialogs.setShowEditStrategy,
    showBatchLimitConfirm: execution.showBatchLimitConfirm,
    setShowBatchLimitConfirm: execution.setShowBatchLimitConfirm,
    executeStartOrganize: execution.executeStartOrganize,
    handleSelectFilesToOrganize: execution.handleSelectFilesToOrganize,
    showStartDropdown: dialogs.showStartDropdown,
    setShowStartDropdown: dialogs.setShowStartDropdown,
    showSaveDropdown: dialogs.showSaveDropdown,
    setShowSaveDropdown: dialogs.setShowSaveDropdown,
    isRegenerate: dialogs.isRegenerate,
    isRegenerateFree: dialogs.isRegenerateFree,
    showRegenerateFirecoreConfirm: dialogs.showRegenerateFirecoreConfirm,
    setShowRegenerateFirecoreConfirm: dialogs.setShowRegenerateFirecoreConfirm,
    isGeneratingTree,
    handleModeSelect: phase.handleModeSelect,
    handleSwitchToExternalAi: phase.handleSwitchToExternalAi,
    handleGuideGeneration: candidatesHook.handleGuideGeneration,
    handleSelectCandidate: candidatesHook.handleSelectCandidate,
    handleCustomSubmit: candidatesHook.handleCustomSubmit,
    handleStartOrganize: execution.handleStartOrganize,
    handlePause: execution.handlePause,
    handleResume: execution.handleResume,
    handleEnd: execution.handleEnd,
    handleReorganizeFromOrganizing: execution.handleReorganizeFromOrganizing,
    handleSave: execution.handleSave,
    handleRegenerateSaveAfterFirecoreConfirm: execution.handleRegenerateSaveAfterFirecoreConfirm,
    handleReorganize: execution.handleReorganize,
    canGoBack: phase.canGoBack,
    handleBack: phase.handleBack,
    canForward: phase.canForward,
    handleForward: phase.handleForward,
    handleBackConfirm: phase.handleBackConfirm,
    handleRescue: rescue.handleRescue,
    isAutoRescuing: rescue.isAutoRescuing,
    isRescuing: rescue.isRescuing,
    handleAutoRescue: rescue.handleAutoRescue,
    initialVDirInfo: drafts.initialVDirInfo,
    fetchProfile,
    computed_limits,
    handleDeleteTreeNode: tree.requestDeleteTreeNode,
    deleteConfirmNodeKey: tree.deleteConfirmNodeKey,
    deleteConfirmNodeName: tree.deleteConfirmNodeName,
    cancelDeleteTreeNode: tree.cancelDeleteTreeNode,
    confirmDeleteTreeNode: tree.confirmDeleteTreeNode,
    handleRenameTreeNode: tree.handleRenameTreeNode,
    handleAddSubdirTreeNode: tree.handleAddSubdirTreeNode,
    handleMoveNodeOrFile: tree.handleMoveNodeOrFile,
    handleSelectDraftVDir: drafts.handleSelectDraftVDir,
    handleDeleteDraftVDir: drafts.handleDeleteDraftVDir,
    resetOrganizeState,
    loadVirtualDirectories: drafts.loadVirtualDirectories,
    highFrequencyTags,

    // 批量预处理工作台操作
    executeBatchRename: execution.executeBatchRename,
    isExecutingRename: execution.isExecutingRename,
    saveBatchTags: execution.saveBatchTags,
    isSavingTags: execution.isSavingTags,
    deleteTagGlobally: execution.deleteTagGlobally,
    trashDuplicateFiles: execution.trashDuplicateFiles,
    isTrashingDuplicates: execution.isTrashingDuplicates,
    loadFilesToOrganize: files.loadFilesToOrganize,

    // 容量守卫与门禁穿透
    organizeCapacityLimit: capacity.organizeCapacityLimit,
    isCapacityExceeded: capacity.isCapacityExceeded,
    capacityExceededCount: capacity.capacityExceededCount,
    showCapacityLimitDialog: capacity.showCapacityLimitDialog,
    setShowCapacityLimitDialog: capacity.setShowCapacityLimitDialog,
    handleGoToAnalyzedPage: capacity.handleGoToAnalyzedPage,
    handleLimitToFirst3000Files: capacity.handleLimitToFirst3000Files,
    handleBypassLimitAndOrganizeAll: capacity.handleBypassLimitAndOrganizeAll,
    handleAttemptEnterModeSelect: capacity.handleAttemptEnterModeSelect,
    bypassCapacityLimit: capacity.bypassCapacityLimit,
    organizeFileLimitOverride: capacity.organizeFileLimitOverride,
    rawToOrganizeCount: files.rawToOrganizeCount
  }
}
