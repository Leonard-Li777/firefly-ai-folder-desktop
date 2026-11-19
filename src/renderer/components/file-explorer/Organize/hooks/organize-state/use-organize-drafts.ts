import type { MutableRefObject } from 'react'
import { useCallback, useEffect, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { VirtualDirectory, VirtualDirectoryFileRow, VirtualDirectoryNode } from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import i18nScope from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { toast } from '../../../../common/Toast'
import { useAnalyzedDirectoryStore } from '../../../../../stores/analyzed-directory-store'
import { useOrganizeStore } from '../../../../../stores/organize-store'
import { OrganizeMode } from '../../types'
import {
  countUnclassified,
  extractUnclassifiedFiles,
  extractFilesFromTree,
  parseStrategyToTree,
  recalculateNodeFileCounts,
  getFileUniqueKey,
  isUnclassifiedNodeName
} from '../../utils/helpers'
import { UNCLASSIFIED_NAME } from './constants'

interface UseOrganizeDraftsParams {
  virtualDirectories: VirtualDirectory[]
  setVirtualDirectories: (v: VirtualDirectory[]) => void
  lastRescuedIdsRef: MutableRefObject<Set<string>>
  isSavedRef: MutableRefObject<boolean>
  setCurrentVDir: (v: VirtualDirectory | null) => void
  allWorkspaceFiles: any[]
  setIncrementalVdId: (v: number | null) => void
  setIncrementalFiles: (v: any[]) => void
  setInitialDraftTree: (v: VirtualDirectoryNode[]) => void
  setRegenerateFiles: (v: Array<{ id: number; name: string }> | null) => void
  setIsLoadingFiles: (v: boolean) => void
  setSelectedCandidate: (v: any) => void
  setCandidates: (v: any[]) => void
}

/**
 * 草稿 / 已存虚拟目录域：列表加载、增量整理入场、vdId 参数恢复与继续整理初始化。
 */
export function useOrganizeDrafts({
  virtualDirectories,
  setVirtualDirectories,
  lastRescuedIdsRef,
  isSavedRef,
  setCurrentVDir,
  allWorkspaceFiles,
  setIncrementalVdId,
  setIncrementalFiles,
  setInitialDraftTree,
  setRegenerateFiles,
  setIsLoadingFiles,
  setSelectedCandidate,
  setCandidates
}: UseOrganizeDraftsParams) {
  const { t } = useVoerkaI18n(i18nScope)
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const vdIdParam = searchParams.get('vdId')

  const currentWorkspaceDirectory = useAnalyzedDirectoryStore(
    (s: any) => s.currentWorkspaceDirectory
  )
  const stage = useOrganizeStore(s => s.stage)
  const setStage = useOrganizeStore(s => s.setStage)
  const setOrganizeMode = useOrganizeStore(s => s.setOrganizeMode)
  const setDraft = useOrganizeStore(s => s.setDraft)
  const setDraftTree = useOrganizeStore(s => s.setDraftTree)
  const setFinalTree = useOrganizeStore(s => s.setFinalTree)
  const setUnmatchedCount = useOrganizeStore(s => s.setUnmatchedCount)
  const setHasRescueFailed = useOrganizeStore(s => s.setHasRescueFailed)

  const [initialVDirInfo, setInitialVDirInfo] = useState<{ name: string; strategy: string } | null>(
    null
  )

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

        let unclassifiedNode = tree.find((n: any) => isUnclassifiedNodeName(n.name))
        if (!unclassifiedNode) {
          unclassifiedNode = {
            name: UNCLASSIFIED_NAME,
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

          setStage('custom-tree')
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

          let unclassifiedNode = initialTree.find(n => isUnclassifiedNodeName(n.name))
          if (!unclassifiedNode) {
            unclassifiedNode = {
              name: UNCLASSIFIED_NAME,
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
              if (isUnclassifiedNodeName(node.name)) continue
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
          // 仅「增量整理」模式（isIncrementalMode）才需要通过 incrementalFiles 标记本批待整理文件，
          // 供 DoneView 的 filterPendingFilesOnly 精准过滤展示本批新归类文件；
          // 「继续整理」入场时不应设置 incrementalFiles，让 toOrganizeSet.size === 0 分支生效，
          // 从而在 DoneView 展示全量已归类文件，正确呈现整理进度全貌。
          if (isIncrementalMode) {
            setIncrementalFiles(freshPendingFiles)
          } else {
            setIncrementalFiles([])
          }

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

  // AI Skill API — 接收从后端转发的整理方案，弹出自定义虚拟目录弹窗
  useEffect(() => {
    const state = location.state as Record<string, unknown> | null
    const plan = state?.pendingOrganizePlan as
      | { name: string; strategy: string; perspective?: string }
      | undefined
    if (plan) {
      navigate('/organize', { replace: true, state: null })
      setInitialVDirInfo({ name: plan.name, strategy: plan.strategy })
      setStage('custom-tree')
    }
  }, [location.state])

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
        const targetVDir = await window.electronAPI!.virtualDirectory.get(vdId)
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
            let unclass = treeResult.find(n => isUnclassifiedNodeName(n.name))
            if (!unclass) {
              unclass = {
                name: UNCLASSIFIED_NAME,
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

  return {
    initialVDirInfo,
    setInitialVDirInfo,
    handleSelectIncrementalVd,
    loadVirtualDirectories,
    handleSelectDraftVDir,
    handleDeleteDraftVDir
  }
}
