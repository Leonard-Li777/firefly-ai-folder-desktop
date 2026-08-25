import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import {
  VirtualDirectory,
  VirtualDirectoryFileRow,
  VirtualDirectoryNode,
  WorkspaceDirectory
} from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import { t } from '@app/languages'
import { toast } from '../../../common/Toast'
import { useAnalyzedDirectoryStore } from '../../../../stores/analyzed-directory-store'
import { useVirtualDirectoryStore } from '../../../../stores/virtual-directory-store'
import { useTierStore } from '../../../../stores/tier-store'
import { useSettingsStore } from '../../../../stores/settings-store'
import { useOrganizeStore } from '../../../../stores/organize-store'

import { Stage, OrganizeMode, OrganizeOptions, ProgressInfo } from '../types'
import {
  convertTreeForBackend,
  buildSkeletonTree,
  sanitizeTree,
  collectAllFiles,
  countUnclassified,
  extractUnclassifiedFiles,
  resetTreeToOutline,
  mergeRescueResult,
  parseStrategyToTree,
  enrichTreeFileNames,
  mergeTreesWithDraft,
  extractFilesFromTree,
  recalculateNodeFileCounts,
  getFileUniqueKey,
  countRealFiles,
  getAllFileKeys
} from '../utils/helpers'

import { exportTreeToFiles } from '../utils/exportTreeToFiles'
import { getUniqueVirtualDirectoryName } from '../../VirtualDirectory/utils/vdir-naming-utils'
import { sanitizeDirectoryName } from '../utils/helpers'

const DEFAULT_GUIDANCE_PROMPT = `以设计师视角，按以下目录结构整理素材文件：

- 设计素材库
  - UI设计
    - 组件库
    - 页面模板
    - 图标素材
  - 插画素材
    - 扁平插画
    - 3D插画
    - 手绘风格
  - 字体资源
    - 中文字体
    - 英文字体
    - 特殊字体
  - 图片素材
    - 背景图片
    - 照片素材
    - 纹理贴图
  - 动效资源
    - Lottie动画
    - GIF动图
    - 视频素材`

export function useOrganizeState() {
  const navigate = useNavigate()
  const location = useLocation()
  const prevPathRef = useRef(location.pathname)
  const [searchParams] = useSearchParams()
  const vdIdParam = searchParams.get('vdId')
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

  // ─── 工作目录 ─────────────────────────────────────────────────────────────
  const workspaceDirectories = useVirtualDirectoryStore((s: any) => s.workspaceDirectories)
  const [showDirectoryDropdown, setShowDirectoryDropdown] = useState(false)

  const isWorkspaceActive = useMemo(() => {
    if (!currentWorkspaceDirectory || !workspaceDirectories.length) return true
    const type = currentWorkspaceDirectory.type
    if (type !== 'SPEEDY' && type !== 'PRIVATE') return true

    const sameTypeDirs = workspaceDirectories.filter((d: WorkspaceDirectory) => d.type === type)
    const { isPathEqual } = window.electronAPI!.utils
    const index = sameTypeDirs.findIndex(
      (d: WorkspaceDirectory) =>
        d.path &&
        currentWorkspaceDirectory.path &&
        isPathEqual(d.path, currentWorkspaceDirectory.path)
    )
    if (index === -1) return true

    const limit =
      type === 'SPEEDY'
        ? ((computed_limits as any)?.speedy_dir_slot_limit ?? 1)
        : ((computed_limits as any)?.private_dir_slot_limit ?? 1)

    if (index < limit) return true

    return false
  }, [currentWorkspaceDirectory, workspaceDirectories, computed_limits])

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

  const [currentVDir, setCurrentVDir] = useState<VirtualDirectory | null>(null)
  const isSavedRef = useRef(false)
  const currentVDirRef = useRef<VirtualDirectory | null>(null)

  useEffect(() => {
    currentVDirRef.current = currentVDir
  }, [currentVDir])

  // 修正：当处于初始 mode-select 阶段时，确保 skipEmptyDirs 为 false
  // 防止旧版本代码遗留的 skipEmptyDirs:true 影响新整理流程的空目录显示
  // 注意：只在 mode-select（尚未开始整理）时重置，不影响整理中/完成阶段的用户设置
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
  const [isAutoRescuing, setIsAutoRescuing] = useState(false)
  const [isRescuing, setIsRescuing] = useState(false)
  const [incrementalVdId, setIncrementalVdId] = useState<number | null>(null)
  const [incrementalFiles, setIncrementalFiles] = useState<any[]>([])

  const [regenerateFiles, setRegenerateFiles] = useState<Array<{
    id: number
    name: string
  }> | null>(null)
  const [initialVDirInfo, setInitialVDirInfo] = useState<{ name: string; strategy: string } | null>(
    null
  )

  // 解析从已分析页面传过来的勾选文件ID列表
  const selectedFileIdsFromState = useMemo(() => {
    return (location.state as any)?.selectedFileIds as number[] | undefined
  }, [location.state])

  // 当前工作区所有的已分析文件列表
  const [allWorkspaceFiles, setAllWorkspaceFiles] = useState<any[]>([])
  const [isLoadingFiles, setIsLoadingFiles] = useState(false)

  const loadFilesToOrganize = useCallback(async () => {
    // 如果工作目录尚未恢复，先尝试从后端获取
    let workspace = currentWorkspaceDirectory
    if (!workspace?.id || !workspace?.path) {
      try {
        const currentDir = await window.electronAPI!.getCurrentWorkspaceDirectory()
        if (currentDir) {
          useAnalyzedDirectoryStore.getState().setCurrentWorkspaceDirectory(currentDir)
          workspace = currentDir
        }
      } catch (e) {
        logger.error(LogCategory.FILE_ORGANIZATION, '初始化获取工作目录失败:', e)
      }
    }

    if (!workspace?.path) {
      setAllWorkspaceFiles([])
      return
    }

    setIsLoadingFiles(true)
    try {
      const result = await window.electronAPI!.organizeRealDirectory.getAnalyzedFiles(
        workspace.path
      )
      const formatted = (result || []).map((f: any) => {
        let ext = f.extension
        if (!ext && f.path) {
          const parts = f.path.split(/[\\/]/).pop()?.split('.')
          if (parts && parts.length > 1) {
            ext = parts.pop()?.toLowerCase()
          }
        }
        return {
          ...f,
          extension: ext || ''
        }
      })
      setAllWorkspaceFiles(formatted)
    } catch (err) {
      logger.error(LogCategory.FILE_ORGANIZATION, '获取工作区文件列表失败:', err)
      toast.error(t('获取待整理文件列表失败，请查看日志确认'))
    } finally {
      setIsLoadingFiles(false)
    }
  }, [currentWorkspaceDirectory])

  // 挂载时自动恢复工作目录并拉取已分析文件；工作区变化时重新拉取
  useEffect(() => {
    loadFilesToOrganize()

    // 如果有勾选状态带入（从已分析页面跳转过来），彻底清除 Keep-Alive 旧状态并复位到选择整理模式
    const selectedFileIdsFromState = location.state?.selectedFileIds
    if (
      selectedFileIdsFromState &&
      Array.isArray(selectedFileIdsFromState) &&
      selectedFileIdsFromState.length > 0
    ) {
      console.log(
        '[Organize State] 从已分析页面带入 selectedFileIds，重置 Keep-Alive 状态，文件数:',
        selectedFileIdsFromState.length
      )
      setStage(location.state?.initialStage || 'root-mode-select')
      setIncrementalVdId(null)
      setIncrementalFiles([])
      setCurrentVDir(null)
      setFinalTree([])
      setDraftTree([])
      isSavedRef.current = false
      window.history.replaceState({}, '')
    }
  }, [
    currentWorkspaceDirectory?.id,
    currentWorkspaceDirectory?.path,
    location.pathname,
    location.state
  ])

  // 草稿或增量整理初始入场树（用于锁定前次已归类文件过滤基线，避免 AI 分批推理过程中左侧文件减少）
  const [initialDraftTree, setInitialDraftTree] = useState<VirtualDirectoryNode[]>([])

  // 计算当前要整理的待整理文件列表（锁定本次任务需要整理的文件全集）
  const toOrganizeFiles = useMemo(() => {
    // 0. 如果属于增量整理/已有虚拟目录 (incremental-organize)，直接以增量筛选出的待整理列表为准（若为 [] 说明前次已全量归类完毕）
    if (organizeMode === 'incremental-organize' && Array.isArray(incrementalFiles)) {
      return incrementalFiles
    }

    const action = searchParams.get('action')
    let baseFiles = allWorkspaceFiles || []

    // 1. 如果是从已分析页面勾选带入的
    if (selectedFileIdsFromState && selectedFileIdsFromState.length > 0) {
      const selectIds = new Set(selectedFileIdsFromState.map(id => String(id)))
      baseFiles = baseFiles.filter(f => selectIds.has(String(f.id)))
    } else if (vdIdParam && action === 'regenerate' && regenerateFiles) {
      // 2. 如果是重新生成虚拟目录
      const regenIds = new Set(regenerateFiles.map(rf => String(rf.id)))
      baseFiles = baseFiles.filter(f => regenIds.has(String(f.id)))
    }

    // 仅在已有草稿恢复 (currentVDir.id > 0) 或增量整理 (incremental-organize) 的初始入场阶段过滤历史已归类文件。
    // 在从零发起新建整理时，待整理列表保持本次任务需要整理的文件全集。
    const isExistingDraftOrVDir = Boolean(
      organizeMode === 'incremental-organize' || (currentVDir && currentVDir.id > 0)
    )

    if (isExistingDraftOrVDir && Array.isArray(initialDraftTree) && initialDraftTree.length > 0) {
      const classifiedKeys = new Set<string>()
      const collectClassified = (nodes: VirtualDirectoryNode[]) => {
        for (const node of nodes) {
          const isUnclass =
            node.name === '未归类' || node.name === t('未归类') || node.name === 'Unclassified'
          if (!isUnclass && Array.isArray(node.files)) {
            for (const f of node.files) {
              const keys = getAllFileKeys(f)
              keys.forEach(k => classifiedKeys.add(k))
            }
          }
          if (Array.isArray(node.subdirectories)) {
            collectClassified(node.subdirectories)
          }
        }
      }
      collectClassified(initialDraftTree)

      if (classifiedKeys.size > 0) {
        return baseFiles.filter(f => {
          const keys = getAllFileKeys(f)
          return !keys.some(k => classifiedKeys.has(k))
        })
      }
    }

    return baseFiles
  }, [
    allWorkspaceFiles,
    selectedFileIdsFromState,
    regenerateFiles,
    searchParams,
    vdIdParam,
    organizeMode,
    incrementalVdId,
    initialDraftTree,
    currentVDir
  ])

  // 处理在模式选择卡片点击选择已保存虚拟目录（增量整理）
  const handleSelectIncrementalVd = useCallback(
    async (vdId: number) => {
      if (!currentWorkspaceDirectory?.path) return
      try {
        setIsLoadingFiles(true)
        setIncrementalVdId(vdId)
        setOrganizeMode('incremental-organize' as OrganizeMode)
        setHasRescueFailed(false)
        lastRescuedIdsRef.current.clear()

        // 1. 调后端 IPC 提取需要增量整理的文件（排除了之前在归类子目录里的文件）
        const files = await window.electronAPI!.virtualDirectory.getIncrementalFilesToOrganize(
          currentWorkspaceDirectory.path,
          vdId,
          currentWorkspaceDirectory.id
        )
        const formattedIncremental = (files || []).map((f: any) => {
          let ext = f.extension
          if (!ext && f.path) {
            const parts = f.path.split(/[\\/]/).pop()?.split('.')
            if (parts && parts.length > 1) {
              ext = parts.pop()?.toLowerCase()
            }
          }
          return {
            ...f,
            extension: ext || ''
          }
        })
        setIncrementalFiles(formattedIncremental)

        // 2. 拉取已存虚拟目录元数据并填充
        const vdList = await window.electronAPI!.virtualDirectory.list(
          currentWorkspaceDirectory.id || 0
        )
        const targetVDir = vdList?.find((d: VirtualDirectory) => d.id === vdId)
        if (targetVDir) {
          setCurrentVDir(targetVDir)
          setDraft({
            name: targetVDir.name,
            strategy: targetVDir.strategy || '',
            perspective: (targetVDir as any).perspective || '',
            rationale: (targetVDir as any).rationale || (targetVDir as any).description || '',
            source: (targetVDir as any).source || null
          })
          setSelectedCandidate({
            title: targetVDir.name,
            name: targetVDir.name,
            description: (targetVDir as any).description || '',
            perspective: (targetVDir as any).perspective || '',
            rationale: (targetVDir as any).rationale || (targetVDir as any).description || '',
            structure: targetVDir.strategy || '',
            strategy: targetVDir.strategy || ''
          })
        }

        // 3. 拉取该虚拟目录当前的树结构快照并同步未归类节点
        const res = await window.electronAPI!.virtualDirectory.getTreeSnapshotAsTree(vdId)
        let tree = Array.isArray(res) ? res : res?.tree || []

        let unclassifiedNode = tree.find(
          (n: any) => n.name === '未归类' || n.name === t('未归类') || n.name === 'Unclassified'
        )
        if (!unclassifiedNode) {
          unclassifiedNode = {
            name: t('未归类'),
            parent: null,
            subdirectories: [],
            files: [],
            fileCount: 0,
            totalSize: 0
          }
          tree.push(unclassifiedNode)
        }

        const formattedUnclassified = formattedIncremental.map((f: any) => ({
          ...f,
          fileId: f.id ?? f.fileId,
          id: f.id ?? f.fileId,
          name: f.name || f.smartName || String(f.id),
          smartName: f.smartName || f.name,
          isUnclassified: true
        }))

        unclassifiedNode.files = formattedUnclassified
        unclassifiedNode.fileCount = formattedUnclassified.length
        tree = recalculateNodeFileCounts(tree)

        setInitialDraftTree(tree)
        setDraftTree(tree)
        setFinalTree(tree)

        // 增量/继续整理初始化：自动实时落盘写库并触发全局同步事件
        try {
          await window.electronAPI!.virtualDirectory.syncIncrementalDirectoryTree(vdId, tree)
          window.dispatchEvent(
            new CustomEvent('vdir:incremental-updated', { detail: { vdirId: vdId } })
          )
        } catch (syncErr) {
          logger.warn(LogCategory.FILE_ORGANIZATION, '增量整理初始化写库失败:', syncErr)
        }

        // 4. 增量/继续整理直达 done / structure 阶段
        if (formattedIncremental.length === 0) {
          setStage('done')
          toast.success(t('已加载已有虚拟目录完整文件结构'))
        } else {
          setStage('structure')
          toast.success(t('已加载增量整理待处理文件与现有分类结构'))
        }
      } catch (err) {
        logger.error(LogCategory.FILE_ORGANIZATION, '加载增量整理失败:', err)
        toast.error(t('加载增量整理文件失败'))
      } finally {
        setIsLoadingFiles(false)
      }
    },
    [currentWorkspaceDirectory]
  )

  useEffect(() => {
    const loadVDirParamData = async () => {
      if (!vdIdParam) return
      const action = searchParams.get('action')

      if (action === 'regenerate') {
        try {
          let targetVDir = await window.electronAPI!.virtualDirectory.get(Number(vdIdParam))
          if (!targetVDir) {
            const list = await window.electronAPI!.virtualDirectory.list(
              currentWorkspaceDirectory?.id || 0
            )
            targetVDir =
              list?.find((d: VirtualDirectory) => String(d.id) === String(vdIdParam)) || null
          }
          if (targetVDir) {
            setInitialVDirInfo({
              name: targetVDir.name,
              strategy: targetVDir.strategy || ''
            })
            setCurrentVDir(targetVDir)
            isSavedRef.current = true
          }

          const rawFiles = await window.electronAPI!.virtualDirectory.listFiles(Number(vdIdParam))
          if (rawFiles) {
            const files = rawFiles.map((f: VirtualDirectoryFileRow) => {
              const fileName = f.smartName || f.originalPath?.split(/[\\/]/).pop() || ''
              return { id: f.fileId, name: fileName }
            })
            setRegenerateFiles(files)
          }

          setShowCustomForm(true)
        } catch (e) {
          logger.error(LogCategory.FILE_ORGANIZATION, 'Failed to load regenerate data:', e)
        }
      } else {
        const modeParam = searchParams.get('mode')
        const isIncrementalMode = modeParam === 'incremental-organize'
        const vdId = Number(vdIdParam)

        setIncrementalVdId(vdId)
        setOrganizeMode('incremental-organize')

        setCandidates([])
        setSelectedCandidate(null)
        setDraftTree([])
        setDraft(null)

        if (isIncrementalMode) {
          setStage('structure')
        } else {
          setStage('done')
        }

        try {
          let targetVDir = await window.electronAPI!.virtualDirectory.get(vdId)
          if (!targetVDir) {
            const list = await window.electronAPI!.virtualDirectory.list(
              currentWorkspaceDirectory?.id || 0
            )
            targetVDir =
              list?.find((d: VirtualDirectory) => String(d.id) === String(vdIdParam)) || null
          }
          if (targetVDir) {
            setCurrentVDir(targetVDir)
            isSavedRef.current = true
            setDraft({
              name: targetVDir.name,
              strategy: targetVDir.strategy || '',
              source: targetVDir.source || 'vdir'
            })
          }

          const snapshotRes = await window.electronAPI!.virtualDirectory.getTreeSnapshotAsTree(vdId)

          const rawSnapshotTree = Array.isArray(snapshotRes)
            ? snapshotRes
            : (snapshotRes as any)?.tree || []

          let initialTree: VirtualDirectoryNode[] = []
          if (Array.isArray(rawSnapshotTree) && rawSnapshotTree.length > 0) {
            initialTree = rawSnapshotTree
          } else if (targetVDir?.strategy) {
            const parsed = parseStrategyToTree(targetVDir.strategy)
            if (Array.isArray(parsed) && parsed.length > 0) {
              initialTree = parsed
            }
          }

          let unclassifiedNode = initialTree.find(n => n.name === t('未归类'))
          if (!unclassifiedNode) {
            unclassifiedNode = {
              name: t('未归类'),
              parent: null,
              subdirectories: [],
              files: [],
              fileCount: 0,
              totalSize: 0
            }
            initialTree.push(unclassifiedNode)
          }

          let unclassifiedFiles = extractUnclassifiedFiles(initialTree)
          const totalFilesInTree = extractFilesFromTree(initialTree).length
          if (
            totalFilesInTree === 0 &&
            Array.isArray(allWorkspaceFiles) &&
            allWorkspaceFiles.length > 0
          ) {
            const formattedUnclassified = allWorkspaceFiles.map(f => ({
              ...f,
              fileId: f.id,
              id: f.id,
              name: f.name || f.smartName || String(f.id),
              smartName: f.smartName || f.name,
              isUnclassified: true
            }))
            unclassifiedNode.files = formattedUnclassified
            unclassifiedNode.fileCount = formattedUnclassified.length
            initialTree = recalculateNodeFileCounts(initialTree)
            unclassifiedFiles = formattedUnclassified
          }

          // 收集初始树 initialTree 中所有已经在实体分类目录中被分配归类的文件 Key 集合
          const alreadyClassifiedKeys = new Set<string>()
          const collectClassifiedKeys = (nodes: VirtualDirectoryNode[]) => {
            for (const node of nodes) {
              if (node.name === t('未归类')) continue
              if (Array.isArray(node.files)) {
                for (const f of node.files) {
                  const key = getFileUniqueKey(f)
                  if (key) alreadyClassifiedKeys.add(key)
                }
              }
              if (Array.isArray(node.subdirectories)) {
                collectClassifiedKeys(node.subdirectories)
              }
            }
          }
          collectClassifiedKeys(initialTree)

          // 从全量工作区文件中剥离掉已经在当前虚拟目录中归类的文件
          const freshPendingFiles = (allWorkspaceFiles || []).filter(f => {
            const key = getFileUniqueKey(f)
            return !alreadyClassifiedKeys.has(key)
          })

          const formattedPendingFiles = freshPendingFiles.map(f => ({
            ...f,
            fileId: f.id ?? f.fileId,
            id: f.id ?? f.fileId,
            name: f.name || f.smartName || String(f.id),
            smartName: f.smartName || f.name,
            isUnclassified: true
          }))

          unclassifiedNode.files = formattedPendingFiles
          unclassifiedNode.fileCount = formattedPendingFiles.length
          initialTree = recalculateNodeFileCounts(initialTree)

          setDraftTree(initialTree)
          setFinalTree(initialTree)
          setIncrementalFiles(freshPendingFiles)

          // 增量/继续整理初始化：自动实时落盘写库并触发全局同步事件
          try {
            await window.electronAPI!.virtualDirectory.syncIncrementalDirectoryTree(
              vdId,
              initialTree
            )
            window.dispatchEvent(
              new CustomEvent('vdir:incremental-updated', { detail: { vdirId: vdId } })
            )
          } catch (syncErr) {
            logger.warn(LogCategory.FILE_ORGANIZATION, '继续整理初始化写库失败:', syncErr)
          }
        } catch (e) {
          logger.error(LogCategory.FILE_ORGANIZATION, 'Failed to init continue organize data:', e)
        }
      }
    }

    loadVDirParamData()
  }, [currentWorkspaceDirectory?.id, vdIdParam, searchParams])

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

  // AI Skill API — 接收从后端转发的整理方案，弹出自定义虚拟目录弹窗
  useEffect(() => {
    const state = location.state as Record<string, unknown> | null
    const plan = state?.pendingOrganizePlan as
      | { name: string; strategy: string; perspective?: string }
      | undefined
    if (plan) {
      navigate('/organize', { replace: true, state: null })
      setInitialVDirInfo({ name: plan.name, strategy: plan.strategy })
      setStage('candidates')
      setShowCustomForm(true)
    }
  }, [location.state])

  // ─── 候选方案 (State 1) ───────────────────────────────────────────────────
  const [candidates, setCandidates] = useState<any[]>([])
  const [isGeneratingCandidates, setIsGeneratingCandidates] = useState(false)
  const [selectedCandidate, setSelectedCandidate] = useState<any>(null)
  const [showCustomForm, setShowCustomForm] = useState(false)
  const hasAttemptedCandidatesRef = useRef(false)

  // ─── 目录树草稿 & 整理进度 (由 store 统一托管持久化) ────────────────────────────────
  const reorganizeTaskRef = useRef<Promise<any> | null>(null)
  const isForceReorganizeRef = useRef(false)

  // ─── 完成 & 保存 (State 4) ─────────────────────────────────────────────────
  const lastRescuedIdsRef = useRef<Set<string>>(new Set())
  const [virtualDirectories, setVirtualDirectories] = useState<VirtualDirectory[]>([])

  useEffect(() => {
    const fetchVirtualDirs = async () => {
      const target = currentWorkspaceDirectory?.id || currentWorkspaceDirectory?.path
      try {
        const list = await window.electronAPI!.virtualDirectory.list(target)
        setVirtualDirectories(list || [])
      } catch (err) {
        logger.error(LogCategory.FILE_ORGANIZATION, '获取已保存虚拟目录列表失败:', err)
      }
    }
    fetchVirtualDirs()
  }, [currentWorkspaceDirectory?.id, currentWorkspaceDirectory?.path, stage])

  // ─── 返回拦截弹窗 ─────────────────────────────────────────────────────────
  const [showBackConfirm, setShowBackConfirm] = useState(false)

  // ─── 指导方案生成弹窗 ─────────────────────────────────────────────────────
  const [showGuidanceDialog, setShowGuidanceDialog] = useState(false)
  const [guidancePrompt, setGuidancePrompt] = useState(() => {
    // 从 localStorage 读取当前工作空间的指导提示词
    const workspacePath = currentWorkspaceDirectory?.path
    if (workspacePath) {
      const saved = localStorage.getItem(`organize_guidance_${workspacePath}`)
      return saved || ''
    }
    return ''
  })

  // 保存指导提示词到 localStorage
  const saveGuidancePrompt = useCallback(
    (prompt: string) => {
      setGuidancePrompt(prompt)
      const workspacePath = currentWorkspaceDirectory?.path
      if (workspacePath) {
        if (prompt) {
          localStorage.setItem(`organize_guidance_${workspacePath}`, prompt)
        } else {
          localStorage.removeItem(`organize_guidance_${workspacePath}`)
        }
      }
    },
    [currentWorkspaceDirectory?.path]
  )

  // 当工作空间变化时，重新读取 localStorage 中的指导提示词
  useEffect(() => {
    const workspacePath = currentWorkspaceDirectory?.path
    if (workspacePath) {
      const saved = localStorage.getItem(`organize_guidance_${workspacePath}`)
      setGuidancePrompt(saved || '')
    } else {
      setGuidancePrompt('')
    }
  }, [currentWorkspaceDirectory?.path])

  // 重置指导提示词为默认值
  const resetGuidancePrompt = useCallback(() => {
    saveGuidancePrompt(DEFAULT_GUIDANCE_PROMPT)
  }, [saveGuidancePrompt])

  // ─── 策略编辑 ─────────────────────────────────────────────────────────────
  const [showEditStrategy, setShowEditStrategy] = useState(false)

  // ─── 开始整理下拉 ───────────────────────────────────────────────────────────
  const [showStartDropdown, setShowStartDropdown] = useState(false)

  // ─── 保存虚拟目录下拉 ────────────────────────────────────────────────────────
  const [showSaveDropdown, setShowSaveDropdown] = useState(false)

  // ─── 重新生成虚拟目录萤火确认弹层 ──────────────────────────────────────────
  const isRegenerate = !!(vdIdParam && searchParams.get('action') === 'regenerate')
  const isRegenerateFree =
    isRegenerate && ((computed_limits as any)?.regenerate_vdir_cost as number) === 0
  const [showRegenerateFirecoreConfirm, setShowRegenerateFirecoreConfirm] = useState(false)

  const [isGeneratingTree, setIsGeneratingTree] = useState(false)

  // ─── 重置整理页面状态 ──────────────────────────────────────────────────────
  const resetOrganizeState = useCallback(() => {
    // 注意：禁止自动删除 draft 整理任务！
    // 未保存的草稿将妥善保留在数据库中，仅允许主用户在模式选择 stage (ModeSelectView) 手动触发删除。

    setStage('mode-select')
    setViewMode('grid')
    setOrganizeMode('fast-organize')
    setIncrementalVdId(null)
    setIncrementalFiles([])
    setIsLimitPredict(false)
    setRegenerateFiles(null)
    setInitialVDirInfo(null)
    setCandidates([])
    setIsGeneratingCandidates(false)
    setSelectedCandidate(null)
    setShowCustomForm(false)
    hasAttemptedCandidatesRef.current = false
    setDraftTree([])
    setInitialDraftTree([])
    setDraft(null)
    setProgressInfo({ current: 0, total: 0, message: '' })
    setIsPaused(false)
    setFinalTree([])
    setUnmatchedCount(0)
    setHasRescueFailed(false)
    setCurrentVDir(null)
    setOptions({
      allowCreateNew: false,
      skipEmptyDirs: false,
      deduplicateFiles: true,
      flattenToRoot: false
    })
    setIsGeneratingTree(false)
    setShowBackConfirm(false)
    setShowGuidanceDialog(false)
    setGuidancePrompt('')
    setShowStartDropdown(false)
    setShowSaveDropdown(false)
    setShowEditStrategy(false)
  }, [])

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

  // ─── 加载虚拟目录列表 ─────────────────────────────────────────────────────
  const loadVirtualDirectories = useCallback(async () => {
    if (!currentWorkspaceDirectory?.id) return
    try {
      const list = await window.electronAPI!.virtualDirectory.list(currentWorkspaceDirectory.id, {
        includeDrafts: true
      })
      const validList = list || []
      setVirtualDirectories(validList)

      if (vdIdParam) {
        const targetVDir = validList.find(
          (d: VirtualDirectory) => String(d.id) === String(vdIdParam)
        )
        if (targetVDir) {
          setCurrentVDir(targetVDir)
        }
      }
    } catch (e) {
      logger.error(LogCategory.FILE_ORGANIZATION, '加载虚拟目录列表失败:', e)
    }
  }, [currentWorkspaceDirectory?.id, vdIdParam])

  // ─── 选择未保存草稿并直达完成 stage ──────────────────────────────────────────
  const handleSelectDraftVDir = useCallback(
    async (vdId: number) => {
      try {
        let targetVDir = await window.electronAPI!.virtualDirectory.get(vdId)
        if (!targetVDir) return
        setCurrentVDir(targetVDir)
        isSavedRef.current = false
        const draftInfo = {
          name: targetVDir.name,
          strategy: targetVDir.strategy || '',
          perspective: (targetVDir as any).perspective || '',
          rationale: (targetVDir as any).rationale || (targetVDir as any).description || '',
          source: targetVDir.source || 'draft'
        }
        setDraft(draftInfo)

        const snapshotRes = await window.electronAPI!.virtualDirectory.getTreeSnapshotAsTree(vdId)
        let treeResult: VirtualDirectoryNode[] = []

        if (Array.isArray(snapshotRes)) {
          treeResult = snapshotRes
        } else if (snapshotRes && typeof snapshotRes === 'object') {
          treeResult = Array.isArray(snapshotRes.tree) ? [...snapshotRes.tree] : []
          if (snapshotRes.rootNode?.rootFiles && snapshotRes.rootNode.rootFiles.length > 0) {
            let unclass = treeResult.find(n => n.name === t('未归类'))
            if (!unclass) {
              unclass = {
                name: t('未归类'),
                parent: null,
                subdirectories: [],
                files: [],
                fileCount: 0,
                totalSize: 0
              }
              treeResult.push(unclass)
            }
            const existingKeys = new Set(unclass.files.map(f => getFileUniqueKey(f)))
            for (const rf of snapshotRes.rootNode.rootFiles) {
              const key = getFileUniqueKey(rf)
              if (!existingKeys.has(key)) {
                unclass.files.push(rf)
                existingKeys.add(key)
              }
            }
            unclass.fileCount = unclass.files.length
          }
        }

        setInitialDraftTree(treeResult)
        setFinalTree(treeResult)
        setDraftTree(treeResult)
        setUnmatchedCount(countUnclassified(treeResult))
        setSelectedCandidate({
          title: targetVDir.name,
          name: targetVDir.name,
          description: (targetVDir as any).description || '',
          perspective: (targetVDir as any).perspective || '',
          rationale: (targetVDir as any).rationale || (targetVDir as any).description || '',
          structure: targetVDir.strategy || '',
          strategy: targetVDir.strategy || ''
        })
        setStage('structure')
      } catch (e) {
        logger.error(LogCategory.FILE_ORGANIZATION, '加载草稿快照树失败:', e)
        toast.error(t('加载草稿失败，请重试'))
      }
    },
    [setCurrentVDir]
  )

  // ─── 删除未保存的草稿 ────────────────────────────────────────────────────────
  const handleDeleteDraftVDir = useCallback(
    async (vdId: number) => {
      try {
        await window.electronAPI!.virtualDirectory.delete(vdId, { deletePhysical: false })
        toast.success(t('已删除未保存的草稿'))
        await loadVirtualDirectories()
      } catch (e: any) {
        logger.error(LogCategory.FILE_ORGANIZATION, '删除草稿失败:', e)
        toast.error(t('删除草稿失败'))
      }
    },
    [loadVirtualDirectories]
  )

  // 当处于模式选择阶段或工作区变更时，自动拉取最新的虚拟目录列表
  useEffect(() => {
    loadVirtualDirectories()
  }, [currentWorkspaceDirectory?.id, stage, loadVirtualDirectories])

  // 监听全域虚拟目录更新/删除/创建事件，实时同步刷新列表
  useEffect(() => {
    const handleRefresh = () => {
      loadVirtualDirectories()
    }
    window.addEventListener('vdir:updated', handleRefresh)
    window.addEventListener('vdir:deleted', handleRefresh)
    window.addEventListener('vdir:incremental-updated', handleRefresh)
    return () => {
      window.removeEventListener('vdir:updated', handleRefresh)
      window.removeEventListener('vdir:deleted', handleRefresh)
      window.removeEventListener('vdir:incremental-updated', handleRefresh)
    }
  }, [loadVirtualDirectories])

  const [activeGuidancePrompt, setActiveGuidancePrompt] = useState<string>('')

  // ─── State 1: 生成 AI 候选方案 ────────────────────────────────────────────
  const generateCandidates = useCallback(async () => {
    if (!currentWorkspaceDirectory?.id) {
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

  // 当进入 candidates 阶段且无候选方案时，自动生成
  useEffect(() => {
    if (stage !== 'candidates') {
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
    candidates.length,
    isGeneratingCandidates,
    generateCandidates,
    isLoadingFiles,
    toOrganizeFiles
  ])

  // ─── 选择模式后进入候选方案 ────────────────────────────────────────────────
  const handleModeSelect = useCallback(
    (mode: OrganizeMode) => {
      setOrganizeMode(mode)
      setActiveGuidancePrompt('') // 切换模式时清空指导提示词
      if (mode === 'incremental-organize') {
        return
      }
      // 点击快速/精细整理开启全新任务时，彻底重置旧任务残留的草稿与树状态
      setCurrentVDir(null)
      setDraft(null)
      setIncrementalVdId(null)
      setIncrementalFiles([])
      setDraftTree([])
      setInitialDraftTree([])
      setFinalTree([])
      setCandidates([]) // 清空候选方案，触发重新生成
      setSelectedCandidate(null)
      isSavedRef.current = false
      setStage('candidates')
    },
    [setCurrentVDir]
  )

  // ─── 指导方案生成 ───────────────────────────────────────────────────────
  const handleGuideGeneration = useCallback(async () => {
    const prompt = guidancePrompt.trim() || DEFAULT_GUIDANCE_PROMPT
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

  // 计算目录数限制 n 和 x
  const calculateDirectoryLimits = useCallback((totalFiles: number) => {
    // n 算法：基于 sqrt(N)，1000 左右封顶 30
    let n = Math.round(Math.sqrt(totalFiles))
    if (totalFiles <= 15) n = 2
    n = Math.min(30, Math.max(2, n))

    // x 算法：n 的 25%，最少 1 个
    const x = Math.max(1, Math.round(n * 0.25))

    return { maxDirectoryCount: n, freeDirectoryReserve: x }
  }, [])

  const handleSelectCandidate = useCallback(
    async (candidate: any) => {
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

        let finalOutlineTree: VirtualDirectoryNode[] = []
        if (result?.tree && result.tree.length > 0) {
          finalOutlineTree = sanitizeTree(result.tree, true)
        } else {
          finalOutlineTree = buildSkeletonTree(dimensionGroups, organizeMode)
        }

        setDraftTree(finalOutlineTree)
      } catch (e) {
        logger.error(LogCategory.FILE_ORGANIZATION, 'AI生成目录树预览失败:', e)
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
    async (name: string, strategy: string) => {
      const candidate = { name, strategy }
      setSelectedCandidate(candidate)
      setCurrentVDir(null)
      setDraft({ name, strategy, source: 'user-defined' })
      setShowCustomForm(false)
      setStage('structure')

      setIsGeneratingTree(true)
      setDraftTree([])

      try {
        const parsedTree = parseStrategyToTree(strategy)
        const finalCustomTree =
          parsedTree && parsedTree.length > 0
            ? parsedTree
            : buildSkeletonTree(dimensionGroups, organizeMode)

        setDraftTree(finalCustomTree)
      } catch (e) {
        logger.error(LogCategory.FILE_ORGANIZATION, '解析目录树失败:', e)
        const fallbackTree = buildSkeletonTree(dimensionGroups, organizeMode)
        setDraftTree(fallbackTree)
        toast.error(t('目录树解析出错，已使用默认骨架树'))
      } finally {
        setIsGeneratingTree(false)
      }
    },
    [dimensionGroups, organizeMode, setCurrentVDir]
  )

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
            const files = extractFilesFromTree(mergedPreview)
            if (files.length > 0) {
              window
                .electronAPI!.virtualDirectory.syncIncrementalDirectoryTree(vdirId, mergedPreview)
                .catch(() => {})
              window
                .electronAPI!.virtualDirectory.replaceFiles(vdirId, files)
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

        try {
          await window.electronAPI!.virtualDirectory.syncIncrementalDirectoryTree(
            vdirId,
            targetFinalTree
          )
        } catch (err) {
          logger.warn(LogCategory.FILE_ORGANIZATION, '整理树写盘失败:', err)
        }

        const finalFiles = extractFilesFromTree(targetFinalTree)
        if (finalFiles.length > 0) {
          try {
            await window.electronAPI!.virtualDirectory.replaceFiles(vdirId, finalFiles)
          } catch (err) {
            logger.warn(LogCategory.FILE_ORGANIZATION, '整理终局结果落库失败:', err)
          }
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
    executeStartOrganize
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

  // ─── 计算当前显示的树 ─────────────────────────────────────────────────────
  const displayTree = useMemo(() => {
    let processedTree = stage === 'structure' ? draftTree : finalTree

    // 富化文件对象：从 allWorkspaceFiles 中查找原始文件名（name）
    // 后端返回的树只带了 smartName，缺少原始 name 字段
    processedTree = enrichTreeFileNames(processedTree, allWorkspaceFiles)

    if (options.deduplicateFiles) {
      const seenFileIds = new Set<string | number>()
      const deduplicateNodeFiles = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
        return nodes.map(node => {
          const cleanFiles = (node.files || []).filter(f => {
            const key = f.fileId !== undefined ? String(f.fileId) : String((f as any).id)
            if (seenFileIds.has(key)) return false
            seenFileIds.add(key)
            return true
          })
          return {
            ...node,
            files: cleanFiles,
            subdirectories: deduplicateNodeFiles(node.subdirectories || [])
          }
        })
      }
      processedTree = deduplicateNodeFiles(processedTree)
    }

    if (options.flattenToRoot) {
      const flattenTree = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
        const result: VirtualDirectoryNode[] = []
        const walk = (ns: VirtualDirectoryNode[], depth: number) => {
          for (const n of ns) {
            const flatNode = { ...n, subdirectories: [] as VirtualDirectoryNode[] }
            const count = n.files ? n.files.length : 0
            flatNode.fileCount = count
            result.push(flatNode)
            if (n.subdirectories) walk(n.subdirectories, depth + 1)
          }
        }
        walk(nodes, 0)
        return result
      }
      processedTree = flattenTree(processedTree)
    }

    // 在目录结构预览阶段（stage === 'structure'），树节点仅为层级大纲且未挂载文件，绝不能应用 skipEmptyDirs 过滤
    if (options.skipEmptyDirs && stage !== 'structure') {
      const filterEmpty = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
        const result: VirtualDirectoryNode[] = []
        for (const node of nodes) {
          const filteredSubs = filterEmpty(node.subdirectories || [])
          const hasFiles = node.files && node.files.length > 0
          const hasSubs = filteredSubs.length > 0
          if (hasFiles || hasSubs) {
            let count = node.files ? node.files.length : 0
            for (const sub of filteredSubs) {
              count += sub.fileCount
            }
            result.push({
              ...node,
              subdirectories: filteredSubs,
              fileCount: count
            })
          }
        }
        return result
      }
      processedTree = filterEmpty(processedTree)
    } else {
      const updateCounts = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
        return nodes.map(node => {
          const updatedSubs = updateCounts(node.subdirectories || [])
          let count = node.files ? node.files.length : 0
          for (const sub of updatedSubs) {
            count += sub.fileCount
          }
          return {
            ...node,
            subdirectories: updatedSubs,
            fileCount: count
          }
        })
      }
      processedTree = updateCounts(processedTree)
    }

    return processedTree
  }, [
    stage,
    draftTree,
    finalTree,
    allWorkspaceFiles,
    options.skipEmptyDirs,
    options.deduplicateFiles,
    options.flattenToRoot
  ])

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
      const fallbackFile = toOrganizeFiles[0]
        ? {
            fileId: Number(toOrganizeFiles[0].id ?? toOrganizeFiles[0].fileId),
            fileFingerprint: toOrganizeFiles[0].fileFingerprint
          }
        : undefined
      const files = exportTreeToFiles(displayTree, fallbackFile)
      await window.electronAPI!.virtualDirectory.replaceFiles(currentVDir.id, files)
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
      const fallbackFile = toOrganizeFiles[0]
        ? {
            fileId: Number(toOrganizeFiles[0].id ?? toOrganizeFiles[0].fileId),
            fileFingerprint: toOrganizeFiles[0].fileFingerprint
          }
        : undefined
      const files = exportTreeToFiles(displayTree, fallbackFile)
      await window.electronAPI!.virtualDirectory.replaceFiles(currentVDir.id, files)
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
    toOrganizeFiles,
    navigate,
    loadVirtualDirectories,
    resetOrganizeState,
    draft?.source
  ])

  // ─── 重命名目录节点 ──────────────────────────────────────────────────────────
  const handleRenameTreeNode = useCallback((nodeKey: string, newName: string) => {
    const trimmedName = sanitizeDirectoryName(newName.trim())
    if (!trimmedName) return
    const pathParts = nodeKey.split('/')

    const renameByPath = (
      nodes: VirtualDirectoryNode[],
      pathSegments: string[]
    ): VirtualDirectoryNode[] => {
      if (pathSegments.length === 0) return nodes
      const [targetName, ...remainingSegments] = pathSegments

      return nodes.map(node => {
        const nodeName = sanitizeDirectoryName(node.name)
        if (nodeName !== targetName) return node
        if (remainingSegments.length === 0) {
          return { ...node, name: trimmedName }
        }
        return {
          ...node,
          subdirectories: renameByPath(node.subdirectories || [], remainingSegments)
        }
      })
    }

    setDraftTree(prev => renameByPath(prev, pathParts))
    setFinalTree(prev => renameByPath(prev, pathParts))
    toast.success(t('重命名目录成功'))
  }, [])

  // ─── 插入子目录节点 ──────────────────────────────────────────────────────────
  const handleAddSubdirTreeNode = useCallback((parentKey: string, subdirName: string) => {
    const trimmedName = sanitizeDirectoryName(subdirName.trim())
    if (!trimmedName) return

    const newChildNode: VirtualDirectoryNode = {
      name: trimmedName,
      files: [],
      subdirectories: [],
      fileCount: 0,
      parent: parentKey || null,
      totalSize: 0
    }

    if (!parentKey) {
      // 插入顶层根目录
      setDraftTree(prev => [...prev, newChildNode])
      setFinalTree(prev => [...prev, newChildNode])
      toast.success(t('创建根目录成功'))
      return
    }

    const pathParts = parentKey.split('/')
    const addByPath = (
      nodes: VirtualDirectoryNode[],
      pathSegments: string[]
    ): VirtualDirectoryNode[] => {
      if (pathSegments.length === 0) return nodes
      const [targetName, ...remainingSegments] = pathSegments

      return nodes.map(node => {
        const nodeName = sanitizeDirectoryName(node.name)
        if (nodeName !== targetName) return node
        if (remainingSegments.length === 0) {
          const subs = node.subdirectories || []
          if (subs.some(s => sanitizeDirectoryName(s.name) === trimmedName)) {
            toast.error(t('子目录名称已存在'))
            return node
          }
          return {
            ...node,
            subdirectories: [...subs, newChildNode]
          }
        }
        return {
          ...node,
          subdirectories: addByPath(node.subdirectories || [], remainingSegments)
        }
      })
    }

    setDraftTree(prev => addByPath(prev, pathParts))
    setFinalTree(prev => addByPath(prev, pathParts))
    toast.success(t('新增子目录成功'))
  }, [])

  // ─── 删除目录节点 ──────────────────────────────────────────────────────────
  const [deleteConfirmNodeKey, setDeleteConfirmNodeKey] = useState<string | null>(null)
  const [deleteConfirmNodeName, setDeleteConfirmNodeName] = useState<string>('')

  const extractSubtreeFiles = useCallback((node: VirtualDirectoryNode): any[] => {
    let files: any[] = []
    if (Array.isArray(node.files)) {
      files = [...node.files]
    }
    if (Array.isArray(node.subdirectories)) {
      for (const sub of node.subdirectories) {
        files = [...files, ...extractSubtreeFiles(sub)]
      }
    }
    return files
  }, [])

  const executeDeleteTreeNode = useCallback(
    async (nodeKey: string, dirName: string) => {
      const pathParts = nodeKey.split('/')

      // 1. 显式在活动树中定位要删除的节点，并提取该节点及其所有子树下的关联文件
      const currentTree = stage === 'structure' ? draftTree : finalTree
      let targetNodeToDelete: VirtualDirectoryNode | null = null

      const findTargetNode = (nodes: VirtualDirectoryNode[], segments: string[]) => {
        if (segments.length === 0 || !Array.isArray(nodes)) return
        const [targetName, ...remaining] = segments
        for (const node of nodes) {
          const nodeName = sanitizeDirectoryName(node.name)
          if (nodeName === targetName) {
            if (remaining.length === 0) {
              targetNodeToDelete = node
              return
            }
            findTargetNode(node.subdirectories || [], remaining)
          }
        }
      }
      findTargetNode(currentTree, pathParts)

      const rawExtractedFiles = targetNodeToDelete ? extractSubtreeFiles(targetNodeToDelete) : []

      const allWorkspaceMap = new Map((allWorkspaceFiles || []).map(f => [String(f.id), f]))
      const formattedDeletedFiles = rawExtractedFiles.map(f => {
        const rawId = f.fileId ?? f.id
        const matched = rawId != null ? allWorkspaceMap.get(String(rawId)) : null
        const ext =
          f.extension ||
          matched?.extension ||
          (f.path || f.originalPath || matched?.path)?.split('.').pop()?.toLowerCase() ||
          ''
        return {
          ...(matched || {}),
          ...f,
          id: rawId != null ? Number(rawId) : f.id,
          fileId: rawId != null ? Number(rawId) : f.fileId,
          path: f.path || f.originalPath || matched?.path || '',
          originalPath: f.originalPath || f.path || matched?.path || '',
          extension: ext,
          isUnclassified: true
        }
      })

      // 2. 物理从树结构中移除该节点，并将被删除的文件移动至未归类节点
      const removeAndMoveToUnclassified = (
        treeNodes: VirtualDirectoryNode[]
      ): VirtualDirectoryNode[] => {
        const removeByPath = (
          nodes: VirtualDirectoryNode[],
          pathSegments: string[]
        ): VirtualDirectoryNode[] => {
          if (pathSegments.length === 0 || !Array.isArray(nodes)) return nodes
          const [targetName, ...remainingSegments] = pathSegments

          return nodes
            .filter(node => {
              const nodeName = sanitizeDirectoryName(node.name)
              if (nodeName !== targetName) return true
              if (remainingSegments.length === 0) return false
              return true
            })
            .map(node => {
              const nodeName = sanitizeDirectoryName(node.name)
              if (nodeName !== targetName) return node
              return {
                ...node,
                subdirectories: removeByPath(node.subdirectories || [], remainingSegments)
              }
            })
        }

        const newTree = removeByPath(treeNodes, pathParts)

        if (formattedDeletedFiles.length > 0) {
          let unclassifiedNode = newTree.find(
            n => n.name === '未归类' || n.name === t('未归类') || n.name === 'Unclassified'
          )
          if (!unclassifiedNode) {
            unclassifiedNode = {
              name: t('未归类'),
              parent: null,
              subdirectories: [],
              files: [],
              fileCount: 0,
              totalSize: 0
            }
            newTree.push(unclassifiedNode)
          }

          const existingKeys = new Set((unclassifiedNode.files || []).map(f => getFileUniqueKey(f)))
          const toAppend = formattedDeletedFiles.filter(f => !existingKeys.has(getFileUniqueKey(f)))
          unclassifiedNode.files = [...(unclassifiedNode.files || []), ...toAppend]
          unclassifiedNode.fileCount = unclassifiedNode.files.length
        }

        return recalculateNodeFileCounts(newTree)
      }

      let updatedTree: VirtualDirectoryNode[] = []
      setDraftTree(prev => {
        const res = removeAndMoveToUnclassified(prev)
        updatedTree = res
        return res
      })
      setFinalTree(prev => removeAndMoveToUnclassified(prev))

      // 3. 在增量整理模式下，将已被删除目录中的文件全量推入 incrementalFiles，保证未归类文件列表中包含这些文件
      if (formattedDeletedFiles.length > 0) {
        setIncrementalFiles(prev => {
          const prevKeys = new Set((prev || []).map(f => getFileUniqueKey(f)))
          const toAdd = formattedDeletedFiles.filter(f => !prevKeys.has(getFileUniqueKey(f)))
          return [...(prev || []), ...toAdd]
        })

        const targetVDirId = incrementalVdId || currentVDir?.id
        if (targetVDirId && updatedTree.length > 0) {
          try {
            await window.electronAPI!.virtualDirectory.syncIncrementalDirectoryTree(
              targetVDirId,
              updatedTree
            )
            window.dispatchEvent(
              new CustomEvent('vdir:incremental-updated', { detail: { vdirId: targetVDirId } })
            )
          } catch (err: any) {
            logger.warn(LogCategory.FILE_ORGANIZATION, '删除目录同步写盘失败:', err)
            if (err?.message?.includes('does not exist')) {
              setIncrementalVdId(null)
              setCurrentVDir(null)
            }
          }
        }

        toast.success(
          t('已删除目录「{name}」，包含的文件已移至未归类', { name: dirName || nodeKey })
        )
      } else {
        const targetVDirId = incrementalVdId || currentVDir?.id
        if (targetVDirId && updatedTree.length > 0) {
          try {
            await window.electronAPI!.virtualDirectory.syncIncrementalDirectoryTree(
              targetVDirId,
              updatedTree
            )
            window.dispatchEvent(
              new CustomEvent('vdir:incremental-updated', { detail: { vdirId: targetVDirId } })
            )
          } catch (err: any) {
            logger.warn(LogCategory.FILE_ORGANIZATION, '删除空目录同步写盘失败:', err)
            if (err?.message?.includes('does not exist')) {
              setIncrementalVdId(null)
              setCurrentVDir(null)
            }
          }
        }
        toast.success(t('已删除空目录「{name}」', { name: dirName || nodeKey }))
      }
    },
    [
      stage,
      draftTree,
      finalTree,
      allWorkspaceFiles,
      extractSubtreeFiles,
      incrementalVdId,
      currentVDir?.id
    ]
  )

  const requestDeleteTreeNode = useCallback(
    (nodeKey: string) => {
      if (!nodeKey) return
      const parts = nodeKey.split('/')
      const dirName = parts[parts.length - 1] || nodeKey

      const checkContainsFiles = (
        nodes: VirtualDirectoryNode[],
        pathSegments: string[]
      ): boolean => {
        if (pathSegments.length === 0) return false
        const [targetName, ...remainingSegments] = pathSegments
        for (const node of nodes) {
          const nodeName = sanitizeDirectoryName(node.name)
          if (nodeName === targetName) {
            if (remainingSegments.length === 0) {
              return extractSubtreeFiles(node).length > 0
            }
            return checkContainsFiles(node.subdirectories || [], remainingSegments)
          }
        }
        return false
      }

      const currentActiveTree = stage === 'structure' ? draftTree : finalTree
      const containsFiles = checkContainsFiles(currentActiveTree, parts)

      if (!containsFiles) {
        // 空目录：直接删除，不弹出 confirm 对话框
        executeDeleteTreeNode(nodeKey, dirName)
      } else {
        // 包含文件：弹出二次确认 confirm 对话框
        setDeleteConfirmNodeKey(nodeKey)
        setDeleteConfirmNodeName(dirName)
      }
    },
    [draftTree, finalTree, stage, extractSubtreeFiles, executeDeleteTreeNode]
  )

  const cancelDeleteTreeNode = useCallback(() => {
    setDeleteConfirmNodeKey(null)
    setDeleteConfirmNodeName('')
  }, [])

  const confirmDeleteTreeNode = useCallback(async () => {
    if (!deleteConfirmNodeKey) return
    const nodeKey = deleteConfirmNodeKey
    const dirName = deleteConfirmNodeName
    setDeleteConfirmNodeKey(null)
    setDeleteConfirmNodeName('')
    await executeDeleteTreeNode(nodeKey, dirName)
  }, [deleteConfirmNodeKey, deleteConfirmNodeName, executeDeleteTreeNode])

  // ─── 拖拽移动节点或文件 ──────────────────────────────────────────────────────────
  const handleMoveNodeOrFile = useCallback(
    async (draggedData: any, targetNodeKey: string) => {
      if (!draggedData || !targetNodeKey) return
      const targetPathParts = targetNodeKey.split('/')

      // 1. 拖拽的是物理文件 (type === 'file')
      if (draggedData.type === 'file' || draggedData.file) {
        const fileObj = draggedData.file || draggedData
        const fileKey = getFileUniqueKey(fileObj)
        if (!fileKey) return

        const moveFileInTree = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
          let extractedFile: any = null

          const removeFile = (list: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
            return list.map(node => {
              let files = node.files || []
              const matched = files.find(f => getFileUniqueKey(f) === fileKey)
              if (matched) {
                extractedFile = matched
                files = files.filter(f => getFileUniqueKey(f) !== fileKey)
              }
              return {
                ...node,
                files,
                fileCount: files.length,
                subdirectories: removeFile(node.subdirectories || [])
              }
            })
          }

          const cleanedTree = removeFile(nodes)
          const targetFile = extractedFile || fileObj

          const appendFileToTarget = (
            list: VirtualDirectoryNode[],
            segments: string[]
          ): VirtualDirectoryNode[] => {
            if (segments.length === 0) return list
            const [tName, ...rest] = segments

            return list.map(node => {
              const nName = sanitizeDirectoryName(node.name)
              if (nName !== tName) return node
              if (rest.length === 0) {
                const currentFiles = node.files || []
                const exists = currentFiles.some(f => getFileUniqueKey(f) === fileKey)
                const updatedFiles = exists
                  ? currentFiles
                  : [...currentFiles, { ...targetFile, isUnclassified: false }]
                return {
                  ...node,
                  files: updatedFiles,
                  fileCount: updatedFiles.length
                }
              }
              return {
                ...node,
                subdirectories: appendFileToTarget(node.subdirectories || [], rest)
              }
            })
          }

          const resTree = appendFileToTarget(cleanedTree, targetPathParts)
          return recalculateNodeFileCounts(resTree)
        }

        let updatedTree: VirtualDirectoryNode[] = []
        setDraftTree(prev => {
          const res = moveFileInTree(prev)
          updatedTree = res
          return res
        })
        setFinalTree(prev => moveFileInTree(prev))

        const targetVDirId = incrementalVdId || currentVDir?.id
        if (targetVDirId && updatedTree.length > 0) {
          try {
            await window.electronAPI!.virtualDirectory.syncIncrementalDirectoryTree(
              targetVDirId,
              updatedTree
            )
            window.dispatchEvent(
              new CustomEvent('vdir:incremental-updated', { detail: { vdirId: targetVDirId } })
            )
          } catch (err: any) {
            logger.warn(LogCategory.FILE_ORGANIZATION, '文件拖拽同步写盘失败:', err)
            if (err?.message?.includes('does not exist')) {
              setIncrementalVdId(null)
              setCurrentVDir(null)
            }
          }
        }

        toast.success(
          t('已移动文件至「{target}」', {
            target: targetPathParts[targetPathParts.length - 1] || targetNodeKey
          })
        )
        return
      }

      // 2. 拖拽的是目录节点 (type === 'dir' 或包含 nodeKey)
      const sourceNodeKey = draggedData.nodeKey || draggedData.key
      if (!sourceNodeKey || sourceNodeKey === targetNodeKey) return
      if (targetNodeKey.startsWith(`${sourceNodeKey}/`)) {
        toast.warning(t('不能将父目录拖放到其子目录中'))
        return
      }

      const sourcePathParts = sourceNodeKey.split('/')
      let movedDirectoryNode: VirtualDirectoryNode | null = null

      const moveDirInTree = (nodes: VirtualDirectoryNode[]): VirtualDirectoryNode[] => {
        const removeDir = (
          list: VirtualDirectoryNode[],
          segments: string[]
        ): VirtualDirectoryNode[] => {
          if (segments.length === 0) return list
          const [sName, ...rest] = segments
          return list
            .filter(node => {
              const nName = sanitizeDirectoryName(node.name)
              if (nName !== sName) return true
              if (rest.length === 0) {
                movedDirectoryNode = node
                return false
              }
              return true
            })
            .map(node => {
              const nName = sanitizeDirectoryName(node.name)
              if (nName !== sName) return node
              return {
                ...node,
                subdirectories: removeDir(node.subdirectories || [], rest)
              }
            })
        }

        const cleanedTree = removeDir(nodes, sourcePathParts)
        if (!movedDirectoryNode) return nodes

        const appendDirToTarget = (
          list: VirtualDirectoryNode[],
          segments: string[]
        ): VirtualDirectoryNode[] => {
          if (segments.length === 0) return list
          const [tName, ...rest] = segments
          return list.map(node => {
            const nName = sanitizeDirectoryName(node.name)
            if (nName !== tName) return node
            if (rest.length === 0) {
              const currentSubdirs = node.subdirectories || []
              const exists = currentSubdirs.some(
                s =>
                  sanitizeDirectoryName(s.name) ===
                  sanitizeDirectoryName((movedDirectoryNode as any).name)
              )
              const updatedSubdirs = exists
                ? currentSubdirs
                : [...currentSubdirs, movedDirectoryNode!]
              return {
                ...node,
                subdirectories: updatedSubdirs
              }
            }
            return {
              ...node,
              subdirectories: appendDirToTarget(node.subdirectories || [], rest)
            }
          })
        }

        const resTree = appendDirToTarget(cleanedTree, targetPathParts)
        return recalculateNodeFileCounts(resTree)
      }

      let updatedTree: VirtualDirectoryNode[] = []
      setDraftTree(prev => {
        const res = moveDirInTree(prev)
        updatedTree = res
        return res
      })
      setFinalTree(prev => moveDirInTree(prev))

      const targetVDirId = incrementalVdId || currentVDir?.id
      if (targetVDirId && updatedTree.length > 0) {
        try {
          await window.electronAPI!.virtualDirectory.syncIncrementalDirectoryTree(
            targetVDirId,
            updatedTree
          )
          window.dispatchEvent(
            new CustomEvent('vdir:incremental-updated', { detail: { vdirId: targetVDirId } })
          )
        } catch (err: any) {
          logger.warn(LogCategory.FILE_ORGANIZATION, '目录拖拽同步写盘失败:', err)
          if (err?.message?.includes('does not exist')) {
            setIncrementalVdId(null)
            setCurrentVDir(null)
          }
        }
      }

      toast.success(
        t('已将目录「{source}」放入「{target}」', {
          source: sourcePathParts[sourcePathParts.length - 1],
          target: targetPathParts[targetPathParts.length - 1]
        })
      )
    },
    [incrementalVdId, currentVDir?.id]
  )

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

  const canGoBack = useMemo(() => {
    if (stage === 'mode-select') return false

    const actionParam = searchParams.get('action')
    const modeParam = searchParams.get('mode')
    const isDirectDone = Boolean(
      stage === 'done' &&
      ((vdIdParam && actionParam !== 'regenerate' && modeParam !== 'incremental-organize') ||
        (currentVDir &&
          currentVDir.source !== 'draft' &&
          organizeMode !== 'fast-organize' &&
          organizeMode !== 'fine-organize'))
    )

    const result = !isDirectDone && stage !== 'root-mode-select'

    return result
  }, [stage, vdIdParam, searchParams, currentVDir, organizeMode])

  // ─── 返回处理 ─────────────────────────────────────────────────────────────
  const handleBack = useCallback(() => {
    if (!canGoBack) return
    if (stage === 'organizing') {
      setShowBackConfirm(true)
      return
    }
    if (
      stage === 'batch-rename' ||
      stage === 'batch-tag' ||
      stage === 'batch-duplicate' ||
      stage === 'mode-select'
    ) {
      setStage('root-mode-select')
      return
    }
    if (stage === 'candidates') {
      setStage('mode-select')
      return
    }

    const isVDirOrDraft = Boolean(currentVDir?.id || organizeMode === 'incremental-organize')

    if (stage === 'structure') {
      if (isVDirOrDraft) {
        setIncrementalVdId(null)
        setIncrementalFiles([])
        setStage('mode-select')
      } else {
        setStage('candidates')
      }
      return
    }

    if (stage === 'done') {
      if (isVDirOrDraft) {
        setIncrementalVdId(null)
        setIncrementalFiles([])
        setStage('mode-select')
      } else {
        setStage('structure')
      }
      return
    }
  }, [canGoBack, stage, organizeMode, searchParams, vdIdParam, currentVDir, draft])

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
          const res = await window.electronAPI.organizeBatch.executeRename(template, toOrganizeFiles)
          if (res && res.successCount > 0) {
            toast.success(t('成功重命名 {count} 个文件', { count: res.successCount }))
            if (res.failedCount > 0) {
              toast.warning(t('{count} 个文件重命名失败', { count: res.failedCount }))
            }
            // 刷新文件列表
            await loadFilesToOrganize()
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
    async (changes: import('@firefly/types').BatchTagOperation) => {
      const fileIds = changes.fileIds && changes.fileIds.length > 0
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
            if (changes.removeTags && changes.removeTags.length > 0 && window.electronAPI?.organizeBatch?.deleteTagGlobally) {
              for (const rt of changes.removeTags) {
                if (rt.dimensionId === 4 || rt.dimensionId === 28) {
                  try {
                    await window.electronAPI.organizeBatch.deleteTagGlobally(rt.dimensionId, rt.tagName)
                  } catch {
                    /* ignore */
                  }
                }
              }
            }

            toast.success(t('成功为 {count} 个文件更新标签', { count: res.successCount }))
            await loadFilesToOrganize()
            if (currentWorkspaceDirectory?.path && window.electronAPI?.analyzedDirectory?.getDimensionGroups) {
              try {
                const groupsRes = await window.electronAPI.analyzedDirectory.getDimensionGroups(currentWorkspaceDirectory.path)
                if (groupsRes?.groups) {
                  useAnalyzedDirectoryStore.getState().setDimensionGroups(groupsRes.groups)
                }
              } catch {
                /* ignore */
              }
            }
            window.dispatchEvent(new CustomEvent('tags-updated'))
            window.dispatchEvent(new CustomEvent('tags:updated'))
          }
        }
      } catch (err: any) {
        toast.error(err?.message || t('批量打标失败'))
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
            if (currentWorkspaceDirectory?.path && window.electronAPI?.analyzedDirectory?.getDimensionGroups) {
              try {
                const groupsRes = await window.electronAPI.analyzedDirectory.getDimensionGroups(currentWorkspaceDirectory.path)
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
  const trashDuplicateFiles = useCallback(
    async (filePaths: string[]) => {
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
    },
    []
  )

  const canForward = useMemo(() => {
    if (stage === 'mode-select') {
      if (organizeMode === 'fine-organize') {
        return candidates.length > 0
      } else {
        return draftTree.length > 0
      }
    }
    if (stage === 'candidates') {
      return draftTree.length > 0 && !!selectedCandidate
    }
    if (stage === 'structure') {
      return finalTree.length > 0
    }
    return false
  }, [stage, organizeMode, candidates, draftTree, selectedCandidate, finalTree])

  const handleForward = useCallback(() => {
    if (!canForward) return
    if (stage === 'mode-select') {
      if (organizeMode === 'fine-organize') {
        setStage('candidates')
      } else {
        setStage('structure')
      }
      return
    }
    if (stage === 'candidates') {
      setStage('structure')
      return
    }
    if (stage === 'structure') {
      setStage('done')
      return
    }
  }, [stage, canForward, organizeMode])

  const handleBackConfirm = useCallback(async () => {
    setShowBackConfirm(false)
    if (currentVDir?.id) {
      try {
        await window.electronAPI!.virtualDirectory.endReorganize(currentVDir.id)
      } catch (_) {
        /* ignore error */
      }
    }
    setStage('structure')
  }, [currentVDir?.id])

  // ─── 再次整理补救批次（找补未归类文件） ───────────────────────────────────
  const handleRescue = useCallback(
    async (force = false) => {
      const targetVDirId = currentVDir?.id || incrementalVdId || 0
      const unclassifiedFiles = extractUnclassifiedFiles(finalTree)
      if (unclassifiedFiles.length === 0) {
        setIsAutoRescuing(false)
        setStage('done')
        return
      }

      if (force) {
        setHasRescueFailed(false)
        lastRescuedIdsRef.current.clear()
      }

      const currentIds = new Set(unclassifiedFiles.map(f => String(f.id)))
      lastRescuedIdsRef.current = currentIds
      setIsRescuing(true) // 局部 Loading，不切全局 stage，避免界面来回跳跃与目录树被反复清空

      // 锁定当前全量树基线快照
      const baseTreeSnapshot = JSON.parse(JSON.stringify(finalTree))

      const unsubProgress = window.electronAPI!.virtualDirectory.onReorganizeProgress(
        (progress: any) => {
          setProgressInfo({
            current: progress.currentStep || 0,
            total: progress.totalSteps || 1,
            message: progress.message || ''
          })
        }
      )

      try {
        const activeTagsTree = finalTree.length > 0 ? finalTree : draftTree
        const result = await window.electronAPI!.virtualDirectory.reorganize(targetVDirId, {
          workspaceDirectoryPath: currentWorkspaceDirectory?.path,
          mode: organizeMode,
          selectedTagsTree: convertTreeForBackend(activeTagsTree),
          files: unclassifiedFiles,
          userInstruction: draft?.strategy,
          allowCreateNew: options.allowCreateNew,
          batchSize: useSettingsStore.getState().getConfigValue<number>('QUEUE_BATCH_SIZE') ?? 50,
          isRescue: true
        })

        unsubProgress()

        if (result?.success === false) {
          logger.warn(LogCategory.FILE_ORGANIZATION, '补救整理被拒绝:', result)
          toast.error(result.message || t('补救整理失败，请重试'))
          setIsAutoRescuing(false)
          setHasRescueFailed(true)
          setStage('done')
          return
        }

        if (result?.tree) {
          // 将找补出来的结果点对点追加合并到基线快照中，确保已有归类文件一律不受影响
          const merged = mergeRescueResult(baseTreeSnapshot, sanitizeTree(result.tree))
          setFinalTree(merged)
          setDraftTree(merged)
          const stillUnmatched = countUnclassified(merged)
          setUnmatchedCount(stillUnmatched)

          const newUnclassified = extractUnclassifiedFiles(merged)
          const newIds = new Set(newUnclassified.map(f => String(f.id)))

          // 如果找补后未归类文件数未变少，说明 AI 无法对这批顽固文件进一步分类，立即停止自动找补死循环
          if (newIds.size >= currentIds.size) {
            setHasRescueFailed(true)
            setIsAutoRescuing(false)
            toast.info(t('AI 无法将剩余的顽固文件分配到现有目录，请创建匹配的目录'))
          }

          if (targetVDirId) {
            try {
              await window.electronAPI!.virtualDirectory.syncIncrementalDirectoryTree(
                targetVDirId,
                merged
              )
              const rescueFiles = extractFilesFromTree(merged)
              if (rescueFiles.length > 0) {
                await window.electronAPI!.virtualDirectory.replaceFiles(targetVDirId, rescueFiles)
              }
              window.dispatchEvent(
                new CustomEvent('vdir:updated', { detail: { vdirId: targetVDirId } })
              )
              window.dispatchEvent(
                new CustomEvent('vdir:incremental-updated', { detail: { vdirId: targetVDirId } })
              )
            } catch (e) {
              logger.warn(LogCategory.FILE_ORGANIZATION, '同步增量找补数据库失败:', e)
            }
          }
        }
        setStage('done')
      } catch (e) {
        unsubProgress()
        logger.error(LogCategory.FILE_ORGANIZATION, '补救整理失败:', e)
        setIsAutoRescuing(false)
        setHasRescueFailed(true)
        setStage('done')
      } finally {
        setIsRescuing(false)
      }
    },
    [
      currentVDir?.id,
      incrementalVdId,
      finalTree,
      hasRescueFailed,
      currentWorkspaceDirectory?.path,
      organizeMode,
      draftTree,
      draft?.strategy,
      options.allowCreateNew
    ]
  )

  // ─── 自动找补循环监听 ─────────────────────────────────────────────────────
  useEffect(() => {
    if (isAutoRescuing && stage === 'done') {
      const unclassifiedFiles = extractUnclassifiedFiles(finalTree)
      if (unclassifiedFiles.length > 0 && !hasRescueFailed) {
        handleRescue()
      } else {
        setIsAutoRescuing(false)
        if (unclassifiedFiles.length === 0) {
          toast.success(t('自动找补完成，所有文件均已归类！'))
        }
      }
    }
  }, [isAutoRescuing, stage, finalTree, hasRescueFailed, handleRescue])

  const handleAutoRescue = useCallback(async () => {
    setIsAutoRescuing(true)
    await handleRescue(true)
  }, [handleRescue])

  const loadWorkspaceDirectories = useCallback(async () => {
    try {
      if (typeof window.electronAPI?.getAllWorkspaceDirectories === 'function') {
        const dirs = await window.electronAPI.getAllWorkspaceDirectories()
        useVirtualDirectoryStore.getState().setWorkspaceDirectories(dirs || [])
      }
    } catch (e) {
      logger.error(LogCategory.FILE_ORGANIZATION, '加载工作目录失败:', e)
    }
  }, [])

  return {
    currentWorkspaceDirectory,
    dimensionGroups,
    workspaceDirectories,
    loadWorkspaceDirectories,
    showDirectoryDropdown,
    setShowDirectoryDropdown,
    isWorkspaceActive,
    viewMode,
    setViewMode,
    stage,
    setStage,
    organizeMode,
    setOrganizeMode,
    incrementalVdId,
    handleSelectIncrementalVd,
    isLimitPredict,

    isLoadingFiles,
    toOrganizeFiles,
    candidates,
    isGeneratingCandidates,
    generateCandidates,
    selectedCandidate,
    setSelectedCandidate,
    showCustomForm,
    setShowCustomForm,
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
    showBackConfirm,
    setShowBackConfirm,
    showGuidanceDialog,
    setShowGuidanceDialog,
    guidancePrompt,
    setGuidancePrompt: saveGuidancePrompt,
    resetGuidancePrompt,
    showEditStrategy,
    setShowEditStrategy,
    showBatchLimitConfirm,
    setShowBatchLimitConfirm,
    executeStartOrganize,
    handleSelectFilesToOrganize,
    showStartDropdown,
    setShowStartDropdown,
    showSaveDropdown,
    setShowSaveDropdown,
    isRegenerate,
    isRegenerateFree,
    showRegenerateFirecoreConfirm,
    setShowRegenerateFirecoreConfirm,
    isGeneratingTree,
    handleModeSelect,
    handleGuideGeneration,
    handleSelectCandidate,
    handleCustomSubmit,
    handleStartOrganize,
    handlePause,
    handleResume,
    handleEnd,
    handleReorganizeFromOrganizing,
    handleSave,
    handleRegenerateSaveAfterFirecoreConfirm,
    handleReorganize,
    canGoBack,
    handleBack,
    canForward,
    handleForward,
    handleBackConfirm,
    handleRescue,
    isAutoRescuing,
    isRescuing,
    handleAutoRescue,
    initialVDirInfo,
    fetchProfile,
    computed_limits,
    handleDeleteTreeNode: requestDeleteTreeNode,
    deleteConfirmNodeKey,
    deleteConfirmNodeName,
    cancelDeleteTreeNode,
    confirmDeleteTreeNode,
    handleRenameTreeNode,
    handleAddSubdirTreeNode,
    handleMoveNodeOrFile,
    handleSelectDraftVDir,
    handleDeleteDraftVDir,
    resetOrganizeState,
    highFrequencyTags,

    // 批量预处理工作台操作
    executeBatchRename,
    isExecutingRename,
    saveBatchTags,
    isSavingTags,
    deleteTagGlobally,
    trashDuplicateFiles,
    isTrashingDuplicates
  }
}
