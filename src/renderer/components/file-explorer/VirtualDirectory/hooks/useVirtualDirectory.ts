import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useAnalyzedDirectoryStore } from '../../../../stores/analyzed-directory-store'
import { resolveTargetId } from '../../../../lib/virtual-directory-utils'
import {
  VirtualDirectory as VirtualDirectoryType,
  VirtualDirectoryNode,
  WorkspaceDirectory,
  DimensionGroup,
  SelectedTag,
  UnionMode
} from '@firefly/types'
import { useSearchStore } from '../../../../stores/search-store'
import { useTierStore } from '../../../../stores/tier-store'
import { useConfigStore } from '../../../../stores/config-store'
import { useNavigate, useLocation } from 'react-router-dom'
import { useVirtualDirectoryStore } from '../../../../stores/virtual-directory-store'
import { sanitizeDirectoryName, getFileNameFromPath, logger, LogCategory } from '@firefly/shared'
import { toast } from '../../../common/Toast'
import { getSelectedTagsFromSet } from '../../dimension-tree-utils'
import { useNavigationHistory } from './useNavigationHistory'
import { useExportPreview } from './useExportPreview'
import { usePreviewOverlayStore } from '../../../../stores/preview-overlay-store'
import { PAGE_IDS } from '../../../../constants/page-ids'
import { t } from '@app/languages'
import { getUniqueVirtualDirectoryName } from '../utils/vdir-naming-utils'
import { useVirtualNavigation } from './useVirtualNavigation'
import { useSettingsStore } from '../../../../stores/settings-store'

export const useVirtualDirectory = () => {
  const [virtualDirectories, setVirtualDirectories] = useState<VirtualDirectoryType[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [activeItem, setActiveItem] = useState<any | null>(null)
  const [selectedFileListFiles, setSelectedFileListFiles] = useState<any[]>([])
  const lastSelectedFileRef = useRef<any>(null)
  const [viewMode, setViewMode] = useState<'list' | 'grid' | 'waterfall'>('grid')
  const [vdirSidebarTab, setVdirSidebarTab] = useState<'directory' | 'dimensions'>('directory')
  const [dimensionGroups, setDimensionGroups] = useState<DimensionGroup[]>([])
  const [selectedTags, setSelectedTags] = useState<SelectedTag[]>([])
  const [isDimensionLoading, setIsDimensionLoading] = useState(false)
  const [filteredFilesByTags, setFilteredFilesByTags] = useState<any[]>([])
  const [isFilteredFilesLoading, setIsFilteredFilesLoading] = useState(false)
  const [vdirMultiSelectMode, setVdirMultiSelectMode] = useState(false)
  const [unionMode, setUnionMode] = useState<UnionMode>('union')
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())

  const setPreviewFile = useCallback((_file: any) => {
    /* No-op: legacy placeholder */
  }, [])

  const handleSelectionChange = useCallback(
    (
      tagsSet: Set<string>,
      reason: 'toggle' | 'selectAll' | 'invert' | 'clear',
      updatedParentTagMap: Map<string, string[]>
    ) => {
      const selectedList = getSelectedTagsFromSet(tagsSet, dimensionGroups, updatedParentTagMap)
      setSelectedTags(selectedList)
    },
    [dimensionGroups]
  )

  const selectionStack = useMemo(() => {
    return selectedTags.map(t => `${t.dimensionId}::${t.parentTagValue || ''}::${t.tagValue}`)
  }, [selectedTags])

  const handleModeChange = useCallback((mode: UnionMode) => {
    setUnionMode(mode)
  }, [])

  const handleTagClick = useCallback((tag: SelectedTag) => {
    setSelectedTags(prev => {
      const isSame =
        prev.length === 1 &&
        prev[0].dimensionId === tag.dimensionId &&
        prev[0].tagValue === tag.tagValue &&
        prev[0].parentTagValue === tag.parentTagValue
      return isSame ? [] : [tag]
    })
  }, [])

  const navigate = useNavigate()
  const location = useLocation()
  const isExportMode = location.pathname === '/virtual-directory/export'
  const queryId = useMemo(() => {
    const params = new URLSearchParams(location.search)
    const idStr = params.get('id')
    return idStr ? Number(idStr) : null
  }, [location.search])
  const currentWorkspaceDirectory = useAnalyzedDirectoryStore(s => s.currentWorkspaceDirectory)
  const setCurrentWorkspaceDirectory = useAnalyzedDirectoryStore(
    s => s.setCurrentWorkspaceDirectory
  )
  const { virtualDirectoryKeyword, setVirtualDirectoryKeyword, setAnalyzedDirectoryKeyword } =
    useSearchStore()
  const { computed_limits, entitlements } = useTierStore()
  const config = useConfigStore(state => state.config)

  const vdirSlotLimit = useMemo(() => {
    const wsId = currentWorkspaceDirectory?.id
    if (!computed_limits) return 2
    if (wsId !== undefined) {
      return (
        (computed_limits as any).vdir_slot_limit_by_workspace?.[wsId] ??
        computed_limits.vdir_slot_limit ??
        2
      )
    }
    return computed_limits.vdir_slot_limit ?? 2
  }, [computed_limits, currentWorkspaceDirectory?.id])

  const [treeData, setTreeData] = useState<VirtualDirectoryNode[]>([])
  const [selectedNode, setSelectedNode] = useState<VirtualDirectoryNode | null>(null)
  const [rootNode, setRootNode] = useState<VirtualDirectoryNode | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('vdir_sidebar_collapsed') === 'true'
    } catch {
      return false
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem('vdir_sidebar_collapsed', String(sidebarCollapsed))
    } catch {
      // localStorage 不可用时静默失败
    }
  }, [sidebarCollapsed])

  const workspaceDirectories = useVirtualDirectoryStore(s => s.workspaceDirectories)
  const setWorkspaceDirectories = useVirtualDirectoryStore(s => s.setWorkspaceDirectories)

  const [showDirectoryDropdown, setShowDirectoryDropdown] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null!)

  const loadWorkspaceDirectories = useCallback(async () => {
    try {
      const dirs = await window.electronAPI!.getAllWorkspaceDirectories()
      setWorkspaceDirectories(dirs || [])
    } catch (e) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '加载工作区目录失败:', e)
    }
  }, [setWorkspaceDirectories])

  useEffect(() => {
    const initWorkspace = async () => {
      if (!currentWorkspaceDirectory?.id || !currentWorkspaceDirectory?.path) {
        try {
          const currentDir = await window.electronAPI!.getCurrentWorkspaceDirectory()
          if (currentDir) {
            setCurrentWorkspaceDirectory(currentDir)
          }
        } catch (e) {
          logger.error(LogCategory.VIRTUAL_DIRECTORY, '初始化获取工作目录失败:', e)
        }
      }
    }
    initWorkspace()
  }, [currentWorkspaceDirectory?.id, currentWorkspaceDirectory?.path, setCurrentWorkspaceDirectory])

  const loadVDirs = useCallback(async () => {
    if (currentWorkspaceDirectory && currentWorkspaceDirectory.id !== undefined) {
      const list = await window.electronAPI.virtualDirectory.list(currentWorkspaceDirectory.id)
      setVirtualDirectories(list)
      if (list && list.length > 0) {
        setSelectedId(prev => {
          if (queryId && list.some((d: VirtualDirectoryType) => d.id === queryId)) {
            return queryId
          }
          if (prev && list.some((d: VirtualDirectoryType) => d.id === prev)) {
            return prev
          }
          return list[0].id
        })
      } else {
        setSelectedId(null)
      }
    }
  }, [currentWorkspaceDirectory?.id, queryId])

  const loadTree = useCallback(async () => {
    if (selectedId) {
      logger.info(
        LogCategory.VIRTUAL_DIRECTORY,
        `[前端] loadTree 开始请求目录快照, selectedId:`,
        selectedId
      )
      try {
        const res = await window.electronAPI.virtualDirectory.getTreeSnapshotAsTree(selectedId)
        const tree = Array.isArray(res) ? res : res?.tree || []
        setTreeData(tree)
        setRootNode(res?.rootNode || null)
      } catch (e) {
        logger.error(LogCategory.VIRTUAL_DIRECTORY, '[前端] 获取目录树快照失败:', e)
        setTreeData([])
        setRootNode(null)
      }
      setSelectedNode(null)
      setActiveItem(null)
    }
  }, [selectedId])

  const loadVdirDimensions = useCallback(async () => {
    if (!selectedId) return
    setIsDimensionLoading(true)
    try {
      const res = await window.electronAPI.analyzedDirectory.getDimensionGroups({
        virtualDirectoryId: selectedId,
        removeEmptyTags: false
      })
      setDimensionGroups(res.groups)
    } catch (e) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '获取虚拟目录维度组失败:', e)
    } finally {
      setIsDimensionLoading(false)
    }
  }, [selectedId])

  useEffect(() => {
    if (selectedId && vdirSidebarTab === 'dimensions') {
      loadVdirDimensions()
    }
  }, [selectedId, vdirSidebarTab, loadVdirDimensions])

  useEffect(() => {
    const handleVDirUpdate = (e: any) => {
      loadVDirs()
      if (e?.detail?.vdirId) {
        setSelectedId(e.detail.vdirId)
      }
    }
    window.addEventListener('vdir:updated', handleVDirUpdate)
    return () => {
      window.removeEventListener('vdir:updated', handleVDirUpdate)
    }
  }, [loadVDirs])

  useEffect(() => {
    setSelectedTags([])
  }, [selectedId])

  const loadFilteredFilesByTags = useCallback(async () => {
    if (!selectedTags || selectedTags.length === 0) {
      setFilteredFilesByTags([])
      return
    }
    setIsFilteredFilesLoading(true)
    try {
      const result = await window.electronAPI!.analyzedDirectory.getFilteredFiles({
        selectedTags,
        sortBy: 'name',
        sortOrder: 'asc',
        virtualDirectoryId: selectedId || undefined,
        searchKeyword: virtualDirectoryKeyword,
        unionMode
      })
      const mapped = result.map(
        (f: any) =>
          ({
            id: f.id,
            status: f.status,
            path: f.path,
            _rawName: f.name,
            _rawSmartName: f.smartName || f.name,
            name: f.name || f.smartName || getFileNameFromPath(f.path) || 'unknown',
            smartName: f.smartName || f.name,
            size: f.size || 0,
            extension: '.' + (f.path.split('.').pop()?.toLowerCase() || ''),
            isFile: true,
            fileFingerprint: f.fileFingerprint,
            originalPath: f.path,
            qualityScore: f.qualityScore,
            description: f.description,
            tags: f.tags,
            author: f.author,
            language: f.language,
            analyzedAt: f.analyzedAt
          }) as any
      )
      setFilteredFilesByTags(mapped)
    } catch (e) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '按标签加载文件失败:', e)
    } finally {
      setIsFilteredFilesLoading(false)
    }
  }, [selectedId, selectedTags, unionMode, virtualDirectoryKeyword])

  useEffect(() => {
    if (selectedTags.length > 0) {
      const timer = setTimeout(() => {
        loadFilteredFilesByTags()
      }, 150)
      return () => clearTimeout(timer)
    } else {
      setFilteredFilesByTags([])
    }
  }, [selectedTags, unionMode, loadFilteredFilesByTags])

  useEffect(() => {
    loadTree()
  }, [selectedId, loadTree])

  useEffect(() => {
    if (queryId) {
      setSelectedId(queryId)
    }
  }, [queryId])

  useEffect(() => {
    loadVDirs()
  }, [currentWorkspaceDirectory?.id, loadVDirs])

  // 监听增量整理完成事件，自动刷新虚拟目录数据
  useEffect(() => {
    const handleIncrementalUpdated = async () => {
      await loadVDirs()
      // selectedId 在增量整理中未改变（同一虚拟目录），需要显式刷新树快照
      await loadTree()
    }
    window.addEventListener('vdir:incremental-updated', handleIncrementalUpdated)
    return () => {
      window.removeEventListener('vdir:incremental-updated', handleIncrementalUpdated)
    }
  }, [loadVDirs, loadTree])

  const handleRename = useCallback(
    async (id: number, newName: string) => {
      if (!newName.trim()) {
        toast.error(t('名称不能为空'))
        return
      }
      const sanitized = sanitizeDirectoryName(newName)
      if (!sanitized) {
        toast.error(t('名称包含非法字符'))
        return
      }
      const otherNames = virtualDirectories.filter(vd => vd.id !== id).map(vd => vd.name)
      const finalName = getUniqueVirtualDirectoryName(sanitized, otherNames)

      try {
        await window.electronAPI.virtualDirectory.rename(id, finalName)
        toast.success(t('重命名成功'))
        await loadVDirs()
      } catch (e: any) {
        toast.error(e.message || t('重命名失败'))
      }
    },
    [virtualDirectories, loadVDirs]
  )

  const executeDelete = useCallback(
    async (id: number) => {
      try {
        await window.electronAPI.virtualDirectory.delete(id, { deletePhysical: false })
        toast.success(t('删除成功'))
        window.dispatchEvent(new CustomEvent('vdir:deleted', { detail: { id } }))
        if (selectedId === id) {
          setSelectedId(null)
          setTreeData([])
        }
        await loadVDirs()
      } catch (e) {
        toast.error(t('删除失败'))
      }
    },
    [selectedId, loadVDirs]
  )

  const handleRegenerate = useCallback(
    async (vd: VirtualDirectoryType) => {
      toast.info(t('正在跳转到整理页面...'))
      navigate(`/organize?vdId=${vd.id}&action=regenerate`)
    },
    [navigate]
  )

  const currentVD = useMemo(() => {
    return virtualDirectories.find(d => d.id === selectedId)
  }, [virtualDirectories, selectedId])

  const isVdirActive = useMemo(() => {
    if (!selectedId || virtualDirectories.length === 0) return false
    const idx = virtualDirectories.findIndex(v => v.id === selectedId)
    if (idx === -1) return false
    const vd = virtualDirectories[idx]
    const hasVdirAccess = entitlements?.some(
      (e: any) =>
        e.type === 'access_vdir' && String(e.metadata?.virtual_directory_id) === String(vd.id)
    )
    if (hasVdirAccess) return true
    const unprotectedBefore = virtualDirectories
      .slice(0, idx)
      .filter(
        v =>
          !entitlements?.some(
            (e: any) =>
              e.type === 'access_vdir' && String(e.metadata?.virtual_directory_id) === String(v.id)
          )
      ).length
    return unprotectedBefore < vdirSlotLimit
  }, [selectedId, virtualDirectories, vdirSlotLimit, entitlements])

  const totalFiles = useMemo(() => {
    return treeData.reduce((acc, node) => acc + (node.fileCount || 0), 0)
  }, [treeData])

  /**
   * 收集整个虚拟目录树的所有文件（含各级维度子目录与根目录散文件），
   * 搜索时以此作为独立的扁平搜索空间，结果不受当前所在目录影响。
   * 每个文件附加 pathTags（所在维度路径），便于展示文件归属。
   */
  const collectAllVirtualFiles = useCallback((): any[] => {
    const files: any[] = []
    const walk = (nodes: VirtualDirectoryNode[], pathTags: string[]) => {
      for (const node of nodes) {
        const nodeTags = node.name ? [...pathTags, node.name] : pathTags
        for (const f of node.files || []) {
          files.push({ ...f, pathTags: nodeTags })
        }
        walk(node.subdirectories || [], nodeTags)
      }
    }
    walk(treeData, [])
    if (rootNode?.rootFiles && rootNode.rootFiles.length > 0) {
      files.push(...rootNode.rootFiles.map(f => ({ ...f, pathTags: [] })))
    }
    return files
  }, [treeData, rootNode])

  const fileListFiles = useMemo(() => {
    // 搜索模式下从整个虚拟目录树收集文件（扁平搜索空间），不受当前所在目录影响
    const isSearching = !!virtualDirectoryKeyword?.trim()
    const sourceFiles = isSearching
      ? collectAllVirtualFiles()
      : selectedNode
        ? selectedNode.files
        : rootNode?.rootFiles || []
    const mapped = sourceFiles.map(f => {
      let parsedTags: string[] = []
      if (f.tags) {
        try {
          const arr = typeof f.tags === 'string' ? JSON.parse(f.tags) : f.tags
          parsedTags = Array.isArray(arr) ? arr.filter(Boolean) : []
        } catch {
          parsedTags = []
        }
      }
      return {
        id: f.fileId || f.id,
        path: f.originalPath,
        name: f.name || getFileNameFromPath(f.originalPath) || 'unknown',
        size: f.size || 0,
        extension: '.' + (f.originalPath?.split('.').pop()?.toLowerCase() || ''),
        isFile: true,
        fileFingerprint: f.fileFingerprint,
        originalPath: f.originalPath,
        smartName: f.smartName,
        qualityScore: f.qualityScore,
        description: f.description,
        tags: parsedTags,
        author: f.author,
        language: f.language,
        analyzedAt: f.analyzedAt,
        lastAnalyzedAt: f.analyzedAt,
        modifiedAt: f.modifiedAt,
        pathTags: isSearching ? f.pathTags : undefined
      } as any
    })

    if (isSearching) {
      const keyword = virtualDirectoryKeyword.toLowerCase().trim()
      return mapped.filter(f => {
        const name = f.name?.toLowerCase() || ''
        const smartName = f.smartName?.toLowerCase() || ''
        const originalPath = f.originalPath?.toLowerCase() || ''
        const description = f.description?.toLowerCase() || ''
        const tags = (f.tags || []).some((tag: string) => tag.toLowerCase().includes(keyword))
        return (
          name.includes(keyword) ||
          smartName.includes(keyword) ||
          originalPath.includes(keyword) ||
          description.includes(keyword) ||
          tags
        )
      })
    }
    return mapped
  }, [selectedNode, rootNode, treeData, virtualDirectoryKeyword, collectAllVirtualFiles])

  const fileListDirectories = useMemo(() => {
    // 搜索模式下隐藏目录列表，仅展示扁平的搜索结果
    if (virtualDirectoryKeyword?.trim()) {
      return []
    }
    const sourceDirs = selectedNode ? selectedNode.subdirectories : treeData
    const mapped = (sourceDirs || []).map(
      d =>
        ({
          id: `vdir-${d.name}`,
          path: d.name,
          name: d.name,
          parentPath: selectedNode ? selectedNode.name : '',
          isDirectory: true,
          modifiedAt: new Date()
        }) as any
    )

    if (virtualDirectoryKeyword?.trim()) {
      const keyword = virtualDirectoryKeyword.toLowerCase().trim()
      return mapped.filter(d => d.name.toLowerCase().includes(keyword))
    }
    return mapped
  }, [selectedNode, treeData, virtualDirectoryKeyword])

  const allFiles = useMemo(() => {
    const files: any[] = []
    const collect = (nodes: VirtualDirectoryNode[], pathTags: string[] = []) => {
      for (const node of nodes) {
        const nodeTags = node.name ? [...pathTags, node.name] : pathTags
        for (const f of node.files || []) {
          files.push({ ...f, tags: nodeTags })
        }
        if (node.subdirectories && node.subdirectories.length > 0) {
          collect(node.subdirectories, nodeTags)
        }
      }
    }
    collect(treeData)
    if (rootNode?.rootFiles && rootNode.rootFiles.length > 0) {
      files.push(...rootNode.rootFiles.map(f => ({ ...f, tags: [] })))
    }
    return files
  }, [treeData, rootNode])

  const exportFilesToUse = useMemo(() => {
    if (filteredFilesByTags && filteredFilesByTags.length > 0) {
      return filteredFilesByTags
    }
    return allFiles
  }, [filteredFilesByTags, allFiles])

  const {
    options: exportPreviewOptions,
    updateOption,
    previewTree,
    totalFileCount,
    isTooManyTags
  } = useExportPreview(selectedTags, selectionStack, dimensionGroups, exportFilesToUse)

  const [showExportTooltip, setShowExportTooltip] = useState(false)

  useEffect(() => {
    setShowExportTooltip(false)
    const isDismissed =
      localStorage.getItem('tooltip_dismissed_header_export_satisfaction_hint') === 'true'
    if (isDismissed) return

    if (
      isVdirActive &&
      virtualDirectories.length > 0 &&
      selectedId &&
      !isExportMode &&
      vdirSidebarTab === 'dimensions' &&
      selectedTags.length > 0 &&
      previewTree.length > 0
    ) {
      const timer = setTimeout(() => {
        setShowExportTooltip(true)
      }, 800)
      return () => clearTimeout(timer)
    }
  }, [
    isVdirActive,
    virtualDirectories,
    selectedId,
    isExportMode,
    vdirSidebarTab,
    selectedTags,
    previewTree
  ])

  const { virtualBasePath, virtualCurrentPath, handleVirtualNavigate, selectedNodePathChain } =
    useVirtualNavigation({
      currentVD,
      treeData,
      selectedNode,
      setSelectedNode,
      setPreviewFile,
      setActiveItem,
      setSelectedFileListFiles
    })

  useEffect(() => {
    if (!selectedNode || treeData.length === 0) return
    const chain = selectedNodePathChain
    if (chain.length === 0) return
    setExpandedKeys(prev => {
      let changed = false
      const next = new Set(prev)
      for (let i = 0; i < chain.length - 1; i++) {
        const key = `dir-${chain[i].name}`
        if (!next.has(key)) {
          next.add(key)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [selectedNode, selectedNodePathChain, treeData])

  const { currentHistoryIndex, handleBack, handleForward, handleUp, navigationHistory } =
    useNavigationHistory({
      selectedId,
      virtualCurrentPath,
      handleVirtualNavigate
    })

  const handleFileListFileSelect = useCallback(
    (newSelection: any[], isFromCheckbox = false) => {
      const { isPathEqual } = window.electronAPI!.utils

      if (isFromCheckbox) {
        const resolvedSelection = newSelection
          .map(item => {
            const pathStr =
              typeof item === 'string' ? item : (item as any)?.path || (item as any)?.originalPath
            return pathStr
              ? fileListFiles.find(f => f.path && isPathEqual(f.path, pathStr))
              : undefined
          })
          .filter(Boolean)

        setSelectedFileListFiles(resolvedSelection)
        if (resolvedSelection.length > 0) {
          lastSelectedFileRef.current = resolvedSelection[resolvedSelection.length - 1]
          setActiveItem(lastSelectedFileRef.current)
        }
      } else if (newSelection.length > 0) {
        const firstItem = newSelection[0]
        const pathStr =
          typeof firstItem === 'string' ? firstItem : firstItem?.path || firstItem?.originalPath

        const foundFile = pathStr
          ? fileListFiles.find(f => f.path && isPathEqual(f.path, pathStr))
          : undefined
        if (foundFile) {
          if (
            lastSelectedFileRef.current &&
            isPathEqual(lastSelectedFileRef.current.path, foundFile.path)
          ) {
            // 再次点击同一文件 → 取消选中，属性面板回到目录分析模式
            setSelectedFileListFiles([])
            setActiveItem(null)
            lastSelectedFileRef.current = null
          } else {
            setSelectedFileListFiles([foundFile])
            setActiveItem(foundFile)
            lastSelectedFileRef.current = foundFile
          }
          return
        }

        const foundDir = pathStr
          ? fileListDirectories.find(d => (d as any).path && isPathEqual((d as any).path, pathStr))
          : undefined
        if (foundDir) {
          if (
            lastSelectedFileRef.current &&
            isPathEqual((lastSelectedFileRef.current as any).path, (foundDir as any).path)
          ) {
            // 再次点击同一目录 → 取消选中，属性面板回到目录分析模式
            setSelectedFileListFiles([])
            setActiveItem(null)
            lastSelectedFileRef.current = null
          } else {
            const sourceDirs = selectedNode ? selectedNode.subdirectories : treeData
            const originalNode = sourceDirs?.find(d => d.name === pathStr)
            setSelectedFileListFiles([foundDir])
            setActiveItem(originalNode || foundDir)
            lastSelectedFileRef.current = originalNode || foundDir
          }
        }
      } else {
        setSelectedFileListFiles([])
        // 清空选中文件，属性面板显示目录分析数据
        setActiveItem(null)
        lastSelectedFileRef.current = null
      }
    },
    [fileListFiles, fileListDirectories, selectedNode, treeData]
  )

  const handleFileListDirectoryChange = useCallback(
    (path: string) => {
      const sourceDirs = selectedNode ? selectedNode.subdirectories : treeData
      const foundSubdir = sourceDirs?.find(d => d.name === path)
      if (foundSubdir) {
        setSelectedNode(foundSubdir)
        setActiveItem(foundSubdir)
        setSelectedFileListFiles([])
        setExpandedKeys(prev => {
          const next = new Set(prev)
          next.add(`dir-${foundSubdir.name}`)
          return next
        })
      }
    },
    [selectedNode, treeData]
  )

  const isSplitView = usePreviewOverlayStore(
    s => s.pageStates[PAGE_IDS.VIRTUAL_DIRECTORY]?.mode === 'split'
  )
  const currentWorkspaceDirectoryPath = currentWorkspaceDirectory?.path || null

  return {
    virtualDirectories,
    selectedId,
    setSelectedId,
    activeItem,
    setActiveItem,
    selectedFileListFiles,
    setSelectedFileListFiles,
    lastSelectedFileRef,
    viewMode,
    setViewMode,
    vdirSidebarTab,
    setVdirSidebarTab,
    dimensionGroups,
    selectedTags,
    setSelectedTags,
    isDimensionLoading,
    filteredFilesByTags,
    isFilteredFilesLoading,
    vdirMultiSelectMode,
    setVdirMultiSelectMode,
    unionMode,
    expandedKeys,
    setExpandedKeys,
    handleSelectionChange,
    selectionStack,
    handleModeChange,
    handleTagClick,
    navigate,
    location,
    isExportMode,
    queryId,
    currentWorkspaceDirectory,
    setCurrentWorkspaceDirectory,
    virtualDirectoryKeyword,
    setVirtualDirectoryKeyword,
    setAnalyzedDirectoryKeyword,
    computed_limits,
    entitlements,
    config,
    vdirSlotLimit,
    treeData,
    selectedNode,
    setSelectedNode,
    rootNode,
    sidebarCollapsed,
    setSidebarCollapsed,
    workspaceDirectories,
    showDirectoryDropdown,
    setShowDirectoryDropdown,
    dropdownRef,
    loadWorkspaceDirectories,
    loadVDirs,
    loadTree,
    handleRename,
    executeDelete,
    handleRegenerate,
    currentVD,
    isVdirActive,
    totalFiles,
    fileListFiles,
    exportPreviewOptions,
    updateOption,
    previewTree,
    totalFileCount,
    isTooManyTags,
    showExportTooltip,
    setShowExportTooltip,
    handleVirtualNavigate,
    virtualCurrentPath,
    currentHistoryIndex,
    handleBack,
    handleForward,
    handleUp,
    navigationHistory,
    fileListDirectories,
    handleFileListFileSelect,
    handleFileListDirectoryChange,
    isSplitView,
    currentWorkspaceDirectoryPath,
    virtualBasePath
  }
}
