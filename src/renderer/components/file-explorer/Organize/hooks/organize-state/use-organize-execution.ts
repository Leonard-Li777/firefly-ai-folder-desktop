import type { MutableRefObject } from 'react'
import { useCallback, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { VirtualDirectory, VirtualDirectoryNode } from '@firefly/types'
import { LogCategory, logger, concept } from '@firefly/shared'
import i18nScope from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { toast } from '../../../../common/Toast'
import { useAnalyzedDirectoryStore } from '../../../../../stores/analyzed-directory-store'
import { useOrganizeStore } from '../../../../../stores/organize-store'
import { useSettingsStore } from '../../../../../stores/settings-store'
import { OrganizeMode } from '../../types'
import {
  collectAllFiles,
  convertTreeForBackend,
  countUnclassified,
  extractCandidatePathsFromTree,
  filterEmptyDirectoryNodes,
  flattenDirectoriesToRoot,
  isUnclassifiedNodeName,
  mergeTreesWithDraft,
  resetTreeToOutline
} from '../../utils/helpers'
import { reshapeDirectoryTree } from '../../utils/reshape-directory-tree'

interface UseOrganizeExecutionParams {
  allWorkspaceFiles: any[]
  dimensionGroups: any[]
  regenerateFiles: Array<{ id: number; name: string }> | null
  toOrganizeFiles: any[]
  organizeMode: OrganizeMode
  options: any
  isGeneratingTree: boolean
  organizeCapacityLimit: number
  bypassCapacityLimit: boolean
  displayTree: VirtualDirectoryNode[]
  currentVDir: VirtualDirectory | null
  isSavedRef: MutableRefObject<boolean>
  loadFilesToOrganize: () => Promise<void>
  loadVirtualDirectories: () => Promise<void>
  resetOrganizeState: () => void
  isRegenerate: boolean
  isRegenerateFree: boolean
  setShowRegenerateFirecoreConfirm: (v: boolean) => void
  setCurrentVDir: (v: VirtualDirectory | null) => void
}

/**
 * 整理执行域：开始/暂停/恢复/结束整理、重新整理、批量重命名/打标/查重、保存虚拟目录。
 */
export function useOrganizeExecution({
  allWorkspaceFiles,
  dimensionGroups,
  regenerateFiles,
  toOrganizeFiles,
  organizeMode,
  options,
  isGeneratingTree,
  organizeCapacityLimit,
  bypassCapacityLimit,
  displayTree,
  currentVDir,
  isSavedRef,
  loadFilesToOrganize,
  loadVirtualDirectories,
  resetOrganizeState,
  isRegenerate,
  isRegenerateFree,
  setShowRegenerateFirecoreConfirm,
  setCurrentVDir
}: UseOrganizeExecutionParams) {
  const { t } = useVoerkaI18n(i18nScope)
  const navigate = useNavigate()

  const currentWorkspaceDirectory = useAnalyzedDirectoryStore(
    (s: any) => s.currentWorkspaceDirectory
  )
  const draft = useOrganizeStore(s => s.draft)
  const draftTree = useOrganizeStore(s => s.draftTree)
  const setDraftTree = useOrganizeStore(s => s.setDraftTree)
  const setFinalTree = useOrganizeStore(s => s.setFinalTree)
  const setStage = useOrganizeStore(s => s.setStage)
  const setProgressInfo = useOrganizeStore(s => s.setProgressInfo)
  const setIsPaused = useOrganizeStore(s => s.setIsPaused)
  const setHasRescueFailed = useOrganizeStore(s => s.setHasRescueFailed)
  const setUnmatchedCount = useOrganizeStore(s => s.setUnmatchedCount)

  const reorganizeTaskRef = useRef<Promise<any> | null>(null)
  const isForceReorganizeRef = useRef(false)

  const [showBatchLimitConfirm, setShowBatchLimitConfirm] = useState(false)

  // 真正的执行整理逻辑
  const executeStartOrganize = useCallback(async () => {
    if (!currentWorkspaceDirectory || !draft) return

    setHasRescueFailed(false)

    let vdirId: number = currentVDir?.id || 0

    const unsubProgress = window.electronAPI!.virtualDirectory.onReorganizeProgress(
      (progress: any) => {
        setProgressInfo({
          current: progress.currentStep || 0,
          total: progress.totalSteps || 1,
          message: progress.message || ''
        })

        // 找补（Rescue）发出的进度广播仅用于刷新进度条，绝对禁止修改全量 finalTree 或误触 replaceFiles 擦除数据库文件
        if (progress?.isRescue) {
          return
        }

        if (progress.currentTreePreview) {
          // 只要有基础大纲树或虚拟目录/草稿 ID，需与初始 draftTree 合并得到全量最新结构
          const hasBaseDraftTree = Boolean(currentVDir?.id || (draftTree && draftTree.length > 0))
          const mergedPreview = hasBaseDraftTree
            ? mergeTreesWithDraft(progress.currentTreePreview, draftTree)
            : progress.currentTreePreview

          setFinalTree(mergedPreview)

          // 无论何种整理模式，只要带有草稿/虚拟目录 ID (vdirId)，每完成一个批次的归类结果均实时落盘写入 SQLite
          if (vdirId) {
            window
              .electronAPI!.virtualDirectory.syncIncrementalDirectoryTree(vdirId, mergedPreview)
              .then(() => {
                window.dispatchEvent(new CustomEvent('vdir:updated', { detail: { vdirId } }))
                window.dispatchEvent(
                  new CustomEvent('vdir:incremental-updated', { detail: { vdirId } })
                )
              })
              .catch(err => {
                logger.warn(LogCategory.FILE_ORGANIZATION, '实时保存整理批次结果失败:', err)
              })
          }
        }
      }
    )

    setStage('organizing')
    setIsPaused(false)
    setFinalTree(draftTree)

    try {
      if (currentVDir?.id) {
        try {
          await window.electronAPI!.virtualDirectory.updateMeta(currentVDir.id, {
            name: draft.name,
            strategy: draft.strategy,
            perspective: (draft as any)?.perspective || undefined,
            rationale: (draft as any)?.rationale || undefined
          })
          vdirId = currentVDir.id
        } catch {
          // 虚拟目录可能已被删除，重新创建
          if (!currentWorkspaceDirectory?.id) {
            toast.error(t('未选择工作区文件夹，无法开始整理'))
            return
          }
          const created = await window.electronAPI!.virtualDirectory.createFromStrategy(
            currentWorkspaceDirectory.id,
            draft.name,
            draft.strategy,
            'draft',
            undefined,
            (draft as any)?.perspective || undefined,
            (draft as any)?.rationale || undefined
          )
          vdirId = created.id
          setCurrentVDir(created)
        }
      } else {
        if (!currentWorkspaceDirectory?.id) {
          toast.error(t('未选择工作区文件夹，无法开始整理'))
          return
        }
        const created = await window.electronAPI!.virtualDirectory.createFromStrategy(
          currentWorkspaceDirectory.id,
          draft.name,
          draft.strategy,
          'draft',
          undefined,
          (draft as any)?.perspective || undefined,
          (draft as any)?.rationale || undefined
        )
        vdirId = created.id
        setCurrentVDir(created)
      }

      // 点击开始整理时将已包含用户最新调整的结构树落盘 SQLite
      if (vdirId && draftTree && draftTree.length > 0) {
        try {
          await window.electronAPI!.virtualDirectory.syncIncrementalDirectoryTree(vdirId, draftTree)
          window.dispatchEvent(new CustomEvent('vdir:updated', { detail: { vdirId } }))
        } catch (e) {
          logger.warn(LogCategory.FILE_ORGANIZATION, '同步草稿结构树到 SQLite 失败:', e)
        }
      }

      let filesToOrganize = collectAllFiles(dimensionGroups, regenerateFiles)
      if (
        (!Array.isArray(filesToOrganize) || filesToOrganize.length === 0) &&
        Array.isArray(toOrganizeFiles) &&
        toOrganizeFiles.length > 0
      ) {
        filesToOrganize = toOrganizeFiles
      }
      if (!Array.isArray(filesToOrganize) || filesToOrganize.length === 0) {
        if (Array.isArray(allWorkspaceFiles) && allWorkspaceFiles.length > 0) {
          filesToOrganize = allWorkspaceFiles
        }
      }

      // ─── 统一归类底座：身份蓝图、工作流预置模式、精细整理、自定义目录树、外部AI均走端侧离线向量余弦打分与内存重塑 ──
      const shouldUseCosineMatching =
        organizeMode === 'identity-blueprint' ||
        organizeMode === 'workflow-preset' ||
        organizeMode === 'fine-organize' ||
        organizeMode === 'custom-tree' ||
        (draft as any)?.source === 'identity-blueprint' ||
        (draft as any)?.source === 'workflow-preset' ||
        (draft as any)?.source === 'external-ai' ||
        (draft as any)?.source === 'custom-tree' ||
        (draft as any)?.source === 'draft' ||
        (draft as any)?.source === 'user-defined'
      if (shouldUseCosineMatching) {
        const candidatePaths = extractCandidatePathsFromTree(draftTree)
        const fileIds = filesToOrganize.map((f: any) => f.id || f.fileId).filter(Boolean)
        // 以文件总数为分母初始化进度（IPC 侧 batchEmbedText 每批次会推送实时进度覆盖此值）
        setProgressInfo({
          current: 0,
          total: Math.max(fileIds.length, 1),
          message: t('正在计算路径余弦打分...')
        })
        const filesMap: Record<number | string, any> = {}
        for (const f of filesToOrganize) {
          const fid = f.id != null ? f.id : (f as any).fileId
          if (fid != null) filesMap[fid] = f
        }

        const cosineRes = await window.electronAPI!.organizeRealDirectory.calculateFilePathsCosine({
          workspaceId: currentWorkspaceDirectory.id,
          fileIds,
          candidatePaths,
          floorThreshold: 0.05, // 支持用户将及格线降低至 5%，后端绝对底限与前端 slider min 同步
          force: useOrganizeStore.getState().bypassCapacityLimit
        })

        let rawMatches = cosineRes?.matches
        if (!rawMatches && cosineRes?.results) {
          rawMatches = {}
          for (const [fIdStr, res] of Object.entries(cosineRes.results)) {
            rawMatches[Number(fIdStr)] = (res as any).candidates || []
          }
        }
        rawMatches = rawMatches || {}
        useOrganizeStore.getState().setRawMatches(rawMatches)
        useOrganizeStore.getState().setFilesMap(filesMap)

        setProgressInfo({
          current: fileIds.length,
          total: Math.max(fileIds.length, 1),
          message: t('正在生成重塑目录树...')
        })

        const thresholdScore = useOrganizeStore.getState().thresholdScore ?? 0.4
        const maxCandidatesPerFile = useOrganizeStore.getState().maxCandidatesPerFile || 1
        const userPinnedFileMap = useOrganizeStore.getState().userPinnedFileMap

        const reshaped = reshapeDirectoryTree({
          baseTreeOutline: draftTree,
          rawMatches,
          filesMap,
          y: thresholdScore,
          n: maxCandidatesPerFile,
          fallbackToTop1IfEmpty: false,
          userPinnedFileMap
        })

        setFinalTree(reshaped.tree)
        setDraftTree(reshaped.tree)
        setUnmatchedCount(reshaped.unclassifiedCount)

        if (vdirId) {
          const treeToSync = options.skipEmptyDirs
            ? filterEmptyDirectoryNodes(reshaped.tree)
            : reshaped.tree
          try {
            await window.electronAPI!.virtualDirectory.syncIncrementalDirectoryTree(
              vdirId,
              treeToSync
            )
          } catch (err) {
            logger.warn(LogCategory.FILE_ORGANIZATION, '整理终局结果落库失败:', err)
          }
          window.dispatchEvent(new CustomEvent('vdir:updated', { detail: { vdirId } }))
        }

        unsubProgress()
        setStage('done')
        return
      }

      const isForceReorganize = isForceReorganizeRef.current
      isForceReorganizeRef.current = false

      const backendTagsTree = convertTreeForBackend(draftTree)

      const task = window.electronAPI!.virtualDirectory.reorganize(vdirId, {
        workspaceDirectoryPath: currentWorkspaceDirectory.path,
        mode: organizeMode,
        selectedFileIds: toOrganizeFiles.map(f => f.id),
        selectedTagsTree: backendTagsTree,
        files: isForceReorganize ? toOrganizeFiles : filesToOrganize,
        userInstruction: draft.strategy,
        allowCreateNew: options.allowCreateNew,
        batchSize: useSettingsStore.getState().getConfigValue<number>('QUEUE_BATCH_SIZE') ?? 50,
        dimensionInfo: dimensionGroups,
        isForceReorganize
      })
      reorganizeTaskRef.current = task

      const result = await task

      // 先取消订阅进度事件，防止后续事件覆盖最终合并结果
      unsubProgress()

      if (result?.success === false) {
        logger.warn(LogCategory.FILE_ORGANIZATION, '整理被拒绝:', result)
        toast.error(result.message || t('整理失败，请重试'))
        setStage('done')
        return
      }

      // 将 AI 整理结果与用户在草稿阶段手动添加的目录结构合并
      // 确保用户添加的空目录（当 skipEmptyDirs=false 时）在完成阶段可见
      let targetFinalTree = draftTree
      if (result?.tree) {
        const mergedFinal = mergeTreesWithDraft(result.tree, draftTree)
        targetFinalTree = mergedFinal
        setFinalTree(mergedFinal)
        setDraftTree(mergedFinal)
        const remainingUnmatched = countUnclassified(mergedFinal)
        setUnmatchedCount(remainingUnmatched)
      } else if (draftTree.length > 0) {
        // 整理结果无树时，至少保留草稿树作为兜底
        setFinalTree(draftTree)
      }

      // 无论何种整理模式，只要带有草稿/虚拟目录 ID (vdirId)，均将最新整理合并出的 targetFinalTree 完整写入 SQLite 数据库落盘
      if (vdirId) {
        isSavedRef.current = true

        const treeToSync = options.skipEmptyDirs
          ? filterEmptyDirectoryNodes(targetFinalTree)
          : targetFinalTree
        try {
          await window.electronAPI!.virtualDirectory.syncIncrementalDirectoryTree(
            vdirId,
            treeToSync
          )
        } catch (err) {
          logger.warn(LogCategory.FILE_ORGANIZATION, '整理树写盘失败:', err)
        }

        window
          .electronAPI!.virtualDirectory.syncPhysicalHardlinks(
            vdirId,
            currentWorkspaceDirectory.path
          )
          .catch(err => {
            logger.warn(LogCategory.FILE_ORGANIZATION, '整理物理硬链接同步失败:', err)
          })

        // 通知虚拟目录列表及主界面即时刷新最新的目录与文件数据
        window.dispatchEvent(new CustomEvent('vdir:updated', { detail: { vdirId } }))
        window.dispatchEvent(new CustomEvent('vdir:incremental-updated', { detail: { vdirId } }))
      }

      setStage('done')
    } catch (e: any) {
      unsubProgress()
      if (e?.message?.includes('abort') || e?.message?.includes('cancel')) {
        setStage('done')
      } else {
        logger.error(LogCategory.FILE_ORGANIZATION, '整理失败:', e)
        toast.error(t('整理过程出错: {message}', { message: e?.message || e }))
        setStage('done')
      }
    }
  }, [
    currentWorkspaceDirectory,
    draft,
    currentVDir?.id,
    dimensionGroups,
    regenerateFiles,
    draftTree,
    organizeMode,
    toOrganizeFiles,
    options.allowCreateNew,
    setCurrentVDir
  ])

  // ─── State 2 → State 3：点击“开始整理” ─────────────────────────────────────────
  const handleStartOrganize = useCallback(async () => {
    if (!currentWorkspaceDirectory || !draft) return

    if (isGeneratingTree) {
      toast.warning(t('目录树预览正在生成中，请稍候...'))
      return
    }
    if (draftTree.length === 0) {
      toast.warning(t('目录树预览还没生成，无法开始整理'))
      return
    }

    const batchSize = useSettingsStore.getState().getConfigValue<number>('QUEUE_BATCH_SIZE') ?? 50
    const maxBatchWarnLimit =
      useSettingsStore.getState().getConfigValue<number>('ORGANIZE_MAX_BATCH_WARN_LIMIT') ?? 20

    // 优先使用后端估算的批次数（与实际整理上报的 totalSteps 保持一致）。
    // 此前按全部文件数估算会导致与实际批次数不一致（例如快速整理的骨架直出会先按已有标签预分配文件）。
    let batchCount = Math.ceil(toOrganizeFiles.map(f => f.id).length / batchSize)
    const isBlueprintOrPreset =
      organizeMode === 'identity-blueprint' ||
      organizeMode === 'workflow-preset' ||
      organizeMode === 'custom-tree' ||
      (draft as any)?.source === 'identity-blueprint' ||
      (draft as any)?.source === 'workflow-preset' ||
      (draft as any)?.source === 'custom-tree' ||
      (draft as any)?.source === 'external-ai'
    if (!isBlueprintOrPreset) {
      try {
        const backendTagsTree = convertTreeForBackend(draftTree)
        const allFiles = collectAllFiles(dimensionGroups, regenerateFiles)
        const estimated = await window.electronAPI!.virtualDirectory.estimateReorganizeBatches(
          currentVDir?.id || 0,
          {
            workspaceDirectoryPath: currentWorkspaceDirectory.path,
            mode: organizeMode,
            selectedFileIds: toOrganizeFiles.map(f => f.id),
            selectedTagsTree: backendTagsTree,
            files: allFiles,
            userInstruction: draft.strategy,
            allowCreateNew: options.allowCreateNew,
            batchSize,
            dimensionInfo: dimensionGroups
          }
        )
        if (typeof estimated === 'number' && estimated > 0) {
          batchCount = estimated
        }
      } catch (e) {
        logger.error(LogCategory.FILE_ORGANIZATION, '估算整理批次失败，使用本地估算:', e)
      }
    }

    if (toOrganizeFiles.length > organizeCapacityLimit) {
      logger.warn(
        LogCategory.FILE_ORGANIZATION,
        `[开始整理] 待整理文件数 (${toOrganizeFiles.length}) 超出推荐上限 (${organizeCapacityLimit})，遵从用户选择继续执行整理`
      )
    }

    if (batchCount > maxBatchWarnLimit) {
      setShowBatchLimitConfirm(true)
      return
    }

    await executeStartOrganize()
  }, [
    currentWorkspaceDirectory,
    currentVDir?.id,
    draft,
    isGeneratingTree,
    draftTree.length,
    toOrganizeFiles,
    options.allowCreateNew,
    organizeMode,
    dimensionGroups,
    regenerateFiles,
    executeStartOrganize,
    bypassCapacityLimit,
    organizeCapacityLimit
  ])

  const handleSelectFilesToOrganize = useCallback(() => {
    setShowBatchLimitConfirm(false)
    navigate('/analyzed-directory', { state: { startInOrganizeMode: true } })
  }, [navigate])

  // ─── 暂停 ─────────────────────────────────────────────────────────────────
  const handlePause = useCallback(async () => {
    if (!currentVDir?.id) return
    setIsPaused(true)
    try {
      await window.electronAPI!.virtualDirectory.pauseReorganize(currentVDir.id)
    } catch (e) {
      logger.error(LogCategory.FILE_ORGANIZATION, '暂停失败:', e)
    }
  }, [currentVDir?.id])

  // ─── 恢复 ─────────────────────────────────────────────────────────────────
  const handleResume = useCallback(async () => {
    if (!currentVDir?.id) return
    setIsPaused(false)
    try {
      await window.electronAPI!.virtualDirectory.resumeReorganize(currentVDir.id)
    } catch (e) {
      logger.error(LogCategory.FILE_ORGANIZATION, '恢复失败:', e)
    }
  }, [currentVDir?.id])

  // ─── 结束整理 ─────────────────────────────────────────────────────────────
  const handleEnd = useCallback(async () => {
    if (!currentVDir?.id) return
    try {
      await window.electronAPI!.virtualDirectory.endReorganize(currentVDir.id)
    } catch (e) {
      logger.error(LogCategory.FILE_ORGANIZATION, '结束整理失败:', e)
    }
    setStage('done')
  }, [currentVDir?.id])

  // ─── 中途重新整理（用于正在整理中） ─────────────────────────────────────────
  const handleReorganizeFromOrganizing = useCallback(async () => {
    setHasRescueFailed(false)
    if (currentVDir?.id) {
      try {
        await window.electronAPI!.virtualDirectory.endReorganize(currentVDir.id)
      } catch (e) {
        logger.error(LogCategory.FILE_ORGANIZATION, '结束整理失败:', e)
      }
    }
    setFinalTree([])
    setProgressInfo({ current: 0, total: 0, message: '' })
    setStage('structure')
  }, [currentVDir?.id])

  // 根据当前选项（平铺到根目录 / 不生成空目录）构造落盘树
  const buildTreeToSave = useCallback(
    (sourceTree: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
      if (options?.flattenToRoot) {
        const flatDirs = flattenDirectoriesToRoot(sourceTree, Boolean(options?.skipEmptyDirs))
        const unclassifiedNode = sourceTree.find(
          n => isUnclassifiedNodeName(n.name) && Array.isArray(n.files) && n.files.length > 0
        )
        return unclassifiedNode ? [...flatDirs, unclassifiedNode] : flatDirs
      }
      return options?.skipEmptyDirs ? filterEmptyDirectoryNodes(sourceTree) : sourceTree
    },
    [options?.flattenToRoot, options?.skipEmptyDirs]
  )

  // ─── 保存虚拟目录 ─────────────────────────────────────────────────────────
  const handleSave = useCallback(async () => {
    if (!currentVDir?.id || displayTree.length === 0) {
      toast.error(t('请先完成整理后再保存'))
      return
    }
    if (isRegenerate && !isRegenerateFree) {
      setShowRegenerateFirecoreConfirm(true)
      return
    }
    try {
      // 单一事实源原子落库：由 syncIncrementalDirectoryTree 统一提取全量文件与空目录 .keep 占位，杜绝双写竞态冲刷
      const treeToSave = buildTreeToSave(displayTree)
      await window.electronAPI!.virtualDirectory.syncIncrementalDirectoryTree(
        currentVDir.id,
        treeToSave
      )
      const targetSource =
        draft?.source && draft.source !== 'draft' ? draft.source : 'ai-reorganized'
      await window.electronAPI!.virtualDirectory.updateMeta(currentVDir.id, {
        name: draft?.name || currentVDir.name,
        strategy: draft?.strategy || currentVDir.strategy,
        source: targetSource,
        perspective: (draft as any)?.perspective || undefined,
        rationale: (draft as any)?.rationale || undefined
      })
      window.dispatchEvent(new CustomEvent('vdir:updated', { detail: { vdirId: currentVDir.id } }))
      isSavedRef.current = true
      toast.success(t('虚拟目录保存成功'))
      await loadVirtualDirectories()
      resetOrganizeState()
      navigate(`/virtual-directory?id=${currentVDir.id}`)
    } catch (e: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, '保存虚拟目录失败:', e)
      toast.error(t('保存失败：') + (e?.message || ''))
    }
  }, [
    currentVDir?.id,
    displayTree,
    buildTreeToSave,
    toOrganizeFiles,
    navigate,
    loadVirtualDirectories,
    resetOrganizeState,
    isRegenerate,
    isRegenerateFree,
    draft?.source
  ])

  // ─── 重新生成保存萤火确认后实际执行保存 ──────────────────────────────────
  const handleRegenerateSaveAfterFirecoreConfirm = useCallback(async () => {
    if (!currentVDir?.id || displayTree.length === 0) return
    try {
      // 单一事实源原子落库：由 syncIncrementalDirectoryTree 统一提取全量文件与空目录 .keep 占位，杜绝双写竞态冲刷
      const treeToSave = buildTreeToSave(displayTree)
      await window.electronAPI!.virtualDirectory.syncIncrementalDirectoryTree(
        currentVDir.id,
        treeToSave
      )
      const targetSource =
        draft?.source && draft.source !== 'draft' ? draft.source : 'ai-reorganized'
      await window.electronAPI!.virtualDirectory.updateMeta(currentVDir.id, {
        name: draft?.name || currentVDir.name,
        strategy: draft?.strategy || currentVDir.strategy,
        source: targetSource,
        perspective: (draft as any)?.perspective || undefined,
        rationale: (draft as any)?.rationale || undefined
      })
      window.dispatchEvent(new CustomEvent('vdir:updated', { detail: { vdirId: currentVDir.id } }))
      isSavedRef.current = true
      toast.success(t('虚拟目录保存成功'))
      await loadVirtualDirectories()
      resetOrganizeState()
      navigate(`/virtual-directory?id=${currentVDir.id}`)
    } catch (e: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, '保存虚拟目录失败:', e)
      toast.error(t('保存失败：') + (e?.message || ''))
    }
  }, [
    currentVDir?.id,
    displayTree,
    buildTreeToSave,
    toOrganizeFiles,
    navigate,
    loadVirtualDirectories,
    resetOrganizeState,
    draft?.source
  ])

  // ─── 重新整理 ─────────────────────────────────────────────────────────────
  const handleReorganize = useCallback(async () => {
    isForceReorganizeRef.current = true
    setHasRescueFailed(false)
    setFinalTree([])
    setProgressInfo({ current: 0, total: 0, message: '' })

    // 重置草稿树结构，将文件归还放到未归类中，以 100% 的待整理文件重新进行 AI 推理
    if (draftTree && draftTree.length > 0) {
      const resetTree = resetTreeToOutline(draftTree, toOrganizeFiles)
      setDraftTree(resetTree)
    }

    await handleStartOrganize()
  }, [handleStartOrganize, draftTree, toOrganizeFiles])

  // ─── 批量重命名执行 ─────────────────────────────────────────────────────────
  const [isExecutingRename, setIsExecutingRename] = useState(false)
  const executeBatchRename = useCallback(
    async (template: string) => {
      if (!toOrganizeFiles || toOrganizeFiles.length === 0) {
        toast.warning(t('暂无待重命名文件'))
        return
      }
      setIsExecutingRename(true)
      try {
        if (window.electronAPI?.organizeBatch?.executeRename) {
          const res = await window.electronAPI.organizeBatch.executeRename(
            template,
            toOrganizeFiles
          )
          if (res && res.successCount > 0) {
            toast.success(t('成功更新 {count} 个文件智能名称', { count: res.successCount }))
            if (res.failedCount > 0) {
              toast.warning(t('{count} 个文件更新失败', { count: res.failedCount }))
            }
            // 刷新当前整理界面的待处理文件列表
            await loadFilesToOrganize()

            // 触发全应用各页面事件监听，更新智能文件名显示
            window.dispatchEvent(new CustomEvent('smartname-updated'))
            window.dispatchEvent(new CustomEvent('files-updated'))
            window.dispatchEvent(new CustomEvent('tags-updated'))
            window.dispatchEvent(new CustomEvent('tags:updated'))
          } else {
            toast.error(t('重命名失败'))
          }
        }
      } catch (err: any) {
        toast.error(err?.message || t('执行重命名异常'))
      } finally {
        setIsExecutingRename(false)
      }
    },
    [toOrganizeFiles]
  )

  // ─── 批量保存打标 ─────────────────────────────────────────────────────────
  const [isSavingTags, setIsSavingTags] = useState(false)
  const saveBatchTags = useCallback(
    async (
      changes: import('@firefly/types').BatchTagOperation
    ): Promise<import('@firefly/types').BatchTagResult | void> => {
      const fileIds =
        changes.fileIds && changes.fileIds.length > 0
          ? changes.fileIds
          : toOrganizeFiles.map(f => f.id).filter(Boolean)
      if (fileIds.length === 0) {
        toast.warning(t('暂无目标文件'))
        return
      }
      setIsSavingTags(true)
      try {
        if (window.electronAPI?.organizeBatch?.applyTags) {
          const res = await window.electronAPI.organizeBatch.applyTags({
            ...changes,
            fileIds
          })
          if (res) {
            // 如果移除的标签属于泛维度（如作者 4、内容标签 28 等），同步清理 file_tags 库表定义
            if (
              changes.removeTags &&
              changes.removeTags.length > 0 &&
              window.electronAPI?.organizeBatch?.deleteTagGlobally
            ) {
              for (const rt of changes.removeTags) {
                const dimIdentifier = rt.dimensionCode || (rt as any).dimensionId
                if (
                  dimIdentifier === 4 ||
                  dimIdentifier === 28 ||
                  dimIdentifier === concept('作者') ||
                  dimIdentifier === concept('内容标签')
                ) {
                  try {
                    await window.electronAPI.organizeBatch.deleteTagGlobally(
                      dimIdentifier,
                      rt.tagName
                    )
                  } catch {
                    /* ignore */
                  }
                }
              }
            }

            toast.success(t('成功为 {count} 个文件更新标签', { count: res.successCount }))

            // S3 规格 §5.5：把结果透传给调用方（BatchTagView 的 onSaveTags）。
            // §5.4 的「共覆盖 N 处单选冲突标签」提示由调用方依据 overriddenCount 发出
            // （保存反馈的出口统一在视图层），这里只负责不吞结果、不吞异常。
            await loadFilesToOrganize()
            if (currentWorkspaceDirectory?.path) {
              try {
                const groupsRes = await window.electronAPI!.analyzedDirectory.getDimensionGroups({
                  workspaceDirectoryPath: currentWorkspaceDirectory.path,
                  includeAllPresetTags: true,
                  excludeExtensionDimension: true
                })
                if (groupsRes?.groups) {
                  useAnalyzedDirectoryStore.getState().setDimensionGroups(groupsRes.groups)
                }
              } catch {
                /* ignore */
              }
            }
            window.dispatchEvent(new CustomEvent('tags-updated'))
            window.dispatchEvent(new CustomEvent('tags:updated'))
            return res
          }
        }
      } catch (err: any) {
        toast.error(err?.message || t('批量打标失败'))
        // S3 规格 §5.5：保留 toast 后必须重抛。
        // 原来这里吞掉异常并 resolve，调用方（BatchTagView.handleSave）的 try/catch
        // 永远不触发 ⇒ 「保存失败不重置工作台」不可实现。
        throw err
      } finally {
        setIsSavingTags(false)
      }
    },
    [toOrganizeFiles, currentWorkspaceDirectory, loadFilesToOrganize]
  )

  // ─── 全局删除标签 ─────────────────────────────────────────────────────────
  const deleteTagGlobally = useCallback(
    async (dimensionId: number, tagName: string): Promise<boolean> => {
      try {
        if (window.electronAPI?.organizeBatch?.deleteTagGlobally) {
          const success = await window.electronAPI.organizeBatch.deleteTagGlobally(
            dimensionId,
            tagName
          )
          if (success) {
            await loadFilesToOrganize()
            if (currentWorkspaceDirectory?.path) {
              try {
                const groupsRes = await window.electronAPI!.analyzedDirectory.getDimensionGroups({
                  workspaceDirectoryPath: currentWorkspaceDirectory.path,
                  includeAllPresetTags: true,
                  excludeExtensionDimension: true
                })
                if (groupsRes?.groups) {
                  useAnalyzedDirectoryStore.getState().setDimensionGroups(groupsRes.groups)
                }
              } catch {
                /* ignore */
              }
            }
            window.dispatchEvent(new CustomEvent('tags-updated'))
            window.dispatchEvent(new CustomEvent('tags:updated'))
            return true
          }
        }
        return false
      } catch (err: any) {
        toast.error(err?.message || t('删除标签失败'))
        return false
      }
    },
    [currentWorkspaceDirectory, loadFilesToOrganize]
  )

  // ─── 查重清理文件 (移入回收站) ─────────────────────────────────────────────
  const [isTrashingDuplicates, setIsTrashingDuplicates] = useState(false)
  const trashDuplicateFiles = useCallback(async (filePaths: string[]) => {
    if (!filePaths || filePaths.length === 0) {
      toast.warning(t('未选择要清理的冗余文件'))
      return
    }
    setIsTrashingDuplicates(true)
    try {
      if (window.electronAPI?.organizeBatch?.trashDuplicates) {
        const res = await window.electronAPI.organizeBatch.trashDuplicates(filePaths)
        if (res) {
          toast.success(t('已安全移入系统回收站 {count} 个文件', { count: res.deletedCount }))
          await loadFilesToOrganize()
        }
      }
    } catch (err: any) {
      toast.error(err?.message || t('清理冗余文件失败'))
    } finally {
      setIsTrashingDuplicates(false)
    }
  }, [])

  return {
    showBatchLimitConfirm,
    setShowBatchLimitConfirm,
    isExecutingRename,
    isSavingTags,
    isTrashingDuplicates,
    executeStartOrganize,
    handleStartOrganize,
    handleSelectFilesToOrganize,
    handlePause,
    handleResume,
    handleEnd,
    handleReorganizeFromOrganizing,
    handleSave,
    handleRegenerateSaveAfterFirecoreConfirm,
    handleReorganize,
    executeBatchRename,
    saveBatchTags,
    deleteTagGlobally,
    trashDuplicateFiles
  }
}
