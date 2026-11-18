import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router-dom'
import { VirtualDirectory, VirtualDirectoryNode } from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import i18nScope from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { toast } from '../../../../common/Toast'
import { useAnalyzedDirectoryStore } from '../../../../../stores/analyzed-directory-store'
import { useOrganizeStore } from '../../../../../stores/organize-store'
import { getAllFileKeys, isUnclassifiedNodeName } from '../../utils/helpers'

interface UseOrganizeFilesParams {
  /** 当前会话绑定的虚拟目录（用于判定是否过滤历史已归类文件） */
  currentVDir: VirtualDirectory | null
}

/**
 * 待整理文件域：工作区文件加载、入场勾选解析、增量/重生成文件与待整理集合切片。
 */
export function useOrganizeFiles({ currentVDir }: UseOrganizeFilesParams) {
  const { t, activeLanguage } = useVoerkaI18n(i18nScope)
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const vdIdParam = searchParams.get('vdId')

  const currentWorkspaceDirectory = useAnalyzedDirectoryStore(
    (s: any) => s.currentWorkspaceDirectory
  )
  const stage = useOrganizeStore(s => s.stage)
  const organizeMode = useOrganizeStore(s => s.organizeMode)
  const organizeFileLimitOverride = useOrganizeStore(s => s.organizeFileLimitOverride)
  const bypassCapacityLimit = useOrganizeStore(s => s.bypassCapacityLimit)

  const [incrementalVdId, setIncrementalVdId] = useState<number | null>(null)
  const [incrementalFiles, setIncrementalFiles] = useState<any[]>([])

  const [regenerateFiles, setRegenerateFiles] = useState<Array<{
    id: number
    name: string
  }> | null>(null)

  // 解析从已分析页面传过来的勾选文件ID列表
  const selectedFileIdsFromState = useMemo(() => {
    return (location.state as any)?.selectedFileIds as number[] | undefined
  }, [location.state])

  // 解析从已分析页面传过来的勾选文件路径列表（id 缺失/不匹配时的兜底匹配依据）
  const selectedFilePathsFromState = useMemo(() => {
    return (location.state as any)?.selectedFilePaths as string[] | undefined
  }, [location.state])

  // 当前工作区所有的已分析文件列表
  const [allWorkspaceFiles, setAllWorkspaceFiles] = useState<any[]>([])
  const [isLoadingFiles, setIsLoadingFiles] = useState(false)

  const loadFilesToOrganize = useCallback(async () => {
    // 门禁：仅在当前处于 /organize 页面时才加载待整理文件；避免 KeepAlive 存活时在其它页面被误触发
    if (location.pathname !== '/organize') {
      return
    }
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
      const selectedFileIdsFromState = location.state?.selectedFileIds as number[] | undefined

      // 全量拉取目标轻量文件，保证首页与批量更名/标签/查重工具均可无阻断使用全量数据
      const workspaceTarget = currentWorkspaceDirectory?.id ?? workspace.path
      const result = await window.electronAPI!.organizeRealDirectory.getLightweightFiles(
        workspaceTarget as any,
        selectedFileIdsFromState
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
          is_analyzed: f.is_analyzed ?? 1,
          isAnalyzed: f.isAnalyzed ?? true,
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
  }, [currentWorkspaceDirectory, location.pathname, location.state, t])

  // 草稿或增量整理初始入场树（用于锁定前次已归类文件过滤基线，避免 AI 分批推理过程中左侧文件减少）
  const [initialDraftTree, setInitialDraftTree] = useState<VirtualDirectoryNode[]>([])

  // 计算全量候选待整理文件集合（未做容量切片限制前的基准集合）
  const rawToOrganizeFiles = useMemo(() => {
    // 0. 如果属于增量整理/已有虚拟目录 (incremental-organize)，直接以增量筛选出的待整理列表为准（若为 [] 说明前次已全量归类完毕）
    if (organizeMode === 'incremental-organize' && Array.isArray(incrementalFiles)) {
      return incrementalFiles
    }

    const action = searchParams.get('action')
    // 前置分析门禁 (规格 §5.3)：批量整理只接纳已完成 AI 语义分析的文件，
    // 未分析文件须先走分析队列；此处严禁回退到全量文件，否则会绕过门禁。
    let baseFiles = (allWorkspaceFiles || []).filter(
      f => (f as any).is_analyzed !== 0 && f.isAnalyzed !== false
    )

    // 1. 如果是从已分析页面勾选带入的（按 id 匹配，缺失时回退 path 匹配，兼容两种数据源）
    if (
      (selectedFileIdsFromState && selectedFileIdsFromState.length > 0) ||
      (selectedFilePathsFromState && selectedFilePathsFromState.length > 0)
    ) {
      const selectIds = new Set((selectedFileIdsFromState || []).map(id => String(id)))
      const normalizePath = (p?: string) =>
        p ? p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() : ''
      const selectPaths = new Set(
        (selectedFilePathsFromState || []).map(p => normalizePath(p)).filter(Boolean)
      )

      baseFiles = baseFiles.filter(f => {
        const rawId = f.id ?? (f as any).fileId ?? (f as any).file_id
        if (rawId != null && selectIds.has(String(rawId))) return true
        // id 匹配失败时使用路径兜底，避免因主键字段差异导致待整理列表全空
        const filePath = normalizePath(f.path ?? (f as any).originalPath)
        return !!filePath && selectPaths.has(filePath)
      })
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
          const isUnclass = isUnclassifiedNodeName(node.name)
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
        // 预先按 Key 前缀建立索引集合，使每个文件只需 O(1) 次 Set 查询，
        // 替代原有的 keys.some() 嵌套遍历（O(N×M)，大文件量下会造成进入整理页卡顿）
        const classifiedIdSet = new Set<string>()
        const classifiedFpSet = new Set<string>()
        const classifiedPathSet = new Set<string>()
        const classifiedNameSet = new Set<string>()
        for (const key of classifiedKeys) {
          if (key.startsWith('id:')) classifiedIdSet.add(key.slice(3))
          else if (key.startsWith('fp:')) classifiedFpSet.add(key.slice(3))
          else if (key.startsWith('path:')) classifiedPathSet.add(key.slice(5))
          else if (key.startsWith('name:')) classifiedNameSet.add(key.slice(5))
        }

        return baseFiles.filter(f => {
          const rawId = f.id ?? (f as any).fileId ?? (f as any).file_id
          if (rawId != null && classifiedIdSet.has(String(rawId))) return false
          const fp = f.fileFingerprint ?? (f as any).file_fingerprint
          if (fp && classifiedFpSet.has(String(fp))) return false
          const p = f.path ?? (f as any).originalPath
          if (p && classifiedPathSet.has(String(p))) return false
          const name = f.name || f.smartName
          if (name && classifiedNameSet.has(String(name))) return false
          return true
        })
      }
    }

    return baseFiles
  }, [
    allWorkspaceFiles,
    selectedFileIdsFromState,
    selectedFilePathsFromState,
    regenerateFiles,
    searchParams,
    vdIdParam,
    organizeMode,
    incrementalVdId,
    initialDraftTree,
    currentVDir,
    activeLanguage
  ])

  const rawToOrganizeCount = rawToOrganizeFiles.length

  // 计算当前阶段真正生效的待整理文件列表：
  // 仅在批量整理主流程且设置了前批次限制（organizeFileLimitOverride）且未 bypass 时切片；
  // 首页、批量更名、批量标签、批量查重始终保持全量供给。
  const toOrganizeFiles = useMemo(() => {
    const isMainOrganizeStage =
      stage !== 'root-mode-select' &&
      stage !== 'batch-rename' &&
      stage !== 'batch-tag' &&
      stage !== 'batch-duplicate'

    if (isMainOrganizeStage && organizeFileLimitOverride !== null && !bypassCapacityLimit) {
      return rawToOrganizeFiles.slice(0, organizeFileLimitOverride)
    }
    return rawToOrganizeFiles
  }, [rawToOrganizeFiles, stage, organizeFileLimitOverride, bypassCapacityLimit])

  // 监听全域智能文件名与文件列表更新事件，实时同步刷新待整理文件列表
  useEffect(() => {
    const handleFilesRefresh = () => {
      loadFilesToOrganize()
    }
    window.addEventListener('smartname-updated', handleFilesRefresh)
    window.addEventListener('files-updated', handleFilesRefresh)
    return () => {
      window.removeEventListener('smartname-updated', handleFilesRefresh)
      window.removeEventListener('files-updated', handleFilesRefresh)
    }
  }, [loadFilesToOrganize])

  return {
    selectedFileIdsFromState,
    selectedFilePathsFromState,
    allWorkspaceFiles,
    isLoadingFiles,
    setIsLoadingFiles,
    loadFilesToOrganize,
    initialDraftTree,
    setInitialDraftTree,
    incrementalVdId,
    setIncrementalVdId,
    incrementalFiles,
    setIncrementalFiles,
    regenerateFiles,
    setRegenerateFiles,
    rawToOrganizeFiles,
    rawToOrganizeCount,
    toOrganizeFiles
  }
}
