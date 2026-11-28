import { useCallback, useMemo } from 'react'
import { DirectoryItem, WorkspaceDirectory } from '@firefly/types'
import { t } from '@app/languages'
import { useAnalysisQueueStore } from '../../../../stores/analysis-queue-store'
import { GRID_MIN_COLUMN_WIDTH } from '../constants'
import { FileListProps, FileListViewMode, FileType, ListItemData } from '../types'
import { formatDate, isImageFile } from '../utils'
import { formatFileSize, getFileIcon } from '../../FileItem'
import { PageId } from '../../../../constants/page-ids'

export interface WaterfallColumnsData {
  columnCount: number
  calcColumnWidth: number
  columns: Array<{
    colIndex: number
    columnItems: Array<{ item: DirectoryItem | FileType; index: number }>
  }>
}

export interface UseFileListDerivedDataParams {
  files: FileType[]
  directories: DirectoryItem[]
  currentPath: string
  disableClientSort: boolean
  sortBy?: FileListProps['sortBy']
  sortOrder?: FileListProps['sortOrder']
  isRealDirectory: boolean
  workspaceDirectoryPath?: string
  workspaceDirectories: WorkspaceDirectory[]
  currentWorkspaceDirectory: WorkspaceDirectory | null
  containerSize: { width: number; height: number }
  gridCardWidth: number
  viewMode: FileListViewMode
  selectedFiles: FileType[]
  selectionEnabled: boolean
  shouldShowField: (field: string) => boolean
  showAnalysisStatus: boolean
  columnWidths: Record<string, number>
  isPathEqual: (p1?: string | null, p2?: string | null) => boolean
  normalizeForCache: (path: string) => string
  stripTrailingSlash: (path: string) => string
  isSubPath: (parent: string, child: string) => boolean
}

export interface UseFileListDerivedDataResult {
  items: (DirectoryItem | FileType)[]
  searchListItems: (DirectoryItem | FileType)[]
  effectiveItems: (DirectoryItem | FileType)[]
  targetWorkspace: WorkspaceDirectory | null
  hasActiveIncludeRules: boolean
  hasIncludeRulesMismatch: boolean
  columnCount: number
  waterfallColumnsData: WaterfallColumnsData | null
  getAllFilesInDirectory: (dirPath: string) => (FileType | any)[]
  selectedPathsSet: Set<string>
  activeColumns: string[]
  totalWidth: number
  isAllSelected: boolean
}

/**
 * FileList 衍生数据 Hook：抽离列表排序、工作区包含规则判定、网格/瀑布流列计算与列宽聚合，
 * 完整保留各计算块的 useMemo / useCallback 语义。
 */
export function useFileListDerivedData({
  files,
  directories,
  currentPath,
  disableClientSort,
  sortBy,
  sortOrder,
  isRealDirectory,
  workspaceDirectoryPath,
  workspaceDirectories,
  currentWorkspaceDirectory,
  containerSize,
  gridCardWidth,
  viewMode,
  selectedFiles,
  selectionEnabled,
  shouldShowField,
  showAnalysisStatus,
  columnWidths,
  isPathEqual,
  normalizeForCache,
  stripTrailingSlash,
  isSubPath
}: UseFileListDerivedDataParams): UseFileListDerivedDataResult {
  const items: (DirectoryItem | FileType)[] = useMemo(() => {
    const validFiles = Array.isArray(files) ? files : []
    const validDirs = Array.isArray(directories) ? directories : []
    const dirs = isRealDirectory
      ? validDirs.filter(dir => dir.parentPath === currentPath)
      : validDirs
    const allItems: (DirectoryItem | FileType)[] = [...dirs, ...validFiles]
    if (disableClientSort || !sortBy) return allItems

    // 如果按 analysisStatus 排序，先建立状态 Map，避免在 O(N log N) 次比较中反复 find
    let statusMap: Map<string, string> | null = null
    if (sortBy === 'analysisStatus') {
      statusMap = new Map()
      const queueItems = useAnalysisQueueStore.getState().snapshot.items
      for (const item of queueItems) {
        if (item?.path && item?.status) {
          statusMap.set(item.path, item.status)
        }
      }
    }

    const getStatus = (file: FileType): string => {
      if (statusMap) {
        const s = statusMap.get(file.path)
        if (s) return s
      }
      return file.isAnalyzed ? 'completed' : ''
    }

    // 单次复合排序：优先将文件夹置顶，随后按指定字段与排序方向排序
    allItems.sort((a, b) => {
      const isDirA = 'isDirectory' in a && Boolean(a.isDirectory)
      const isDirB = 'isDirectory' in b && Boolean(b.isDirectory)

      // 1. 文件夹始终优先于文件
      if (isDirA !== isDirB) {
        return isDirA ? -1 : 1
      }

      // 2. 同为文件夹或同为文件时，按 sortBy 比较
      let valA: any = 0
      let valB: any = 0

      switch (sortBy) {
        case 'name':
          valA = a.name.toLowerCase()
          valB = b.name.toLowerCase()
          break
        case 'size':
          valA = isDirA ? 0 : (a as FileType).size || 0
          valB = isDirB ? 0 : (b as FileType).size || 0
          break
        case 'modified':
          valA = a.modifiedAt ? new Date(a.modifiedAt).getTime() : 0
          valB = b.modifiedAt ? new Date(b.modifiedAt).getTime() : 0
          break
        case 'type':
          valA = isDirA ? '00_dir' : (a as FileType).extension || ''
          valB = isDirB ? '00_dir' : (b as FileType).extension || ''
          break
        case 'smartName':
          valA = (isDirA ? a.name : (a as FileType).smartName || a.name).toLowerCase()
          valB = (isDirB ? b.name : (b as FileType).smartName || b.name).toLowerCase()
          break
        case 'qualityScore':
          valA = isDirA ? 0 : (a as FileType).qualityScore || 0
          valB = isDirB ? 0 : (b as FileType).qualityScore || 0
          break
        case 'author':
          valA = isDirA ? '' : (a as FileType).author || ''
          valB = isDirB ? '' : (b as FileType).author || ''
          break
        case 'language':
          valA = isDirA ? '' : (a as FileType).language || ''
          valB = isDirB ? '' : (b as FileType).language || ''
          break
        case 'analysisStatus':
          valA = isDirA ? '' : getStatus(a as FileType)
          valB = isDirB ? '' : getStatus(b as FileType)
          break
        default:
          valA = 0
          valB = 0
      }

      if (valA < valB) return sortOrder === 'asc' ? -1 : 1
      if (valA > valB) return sortOrder === 'asc' ? 1 : -1
      return 0
    })

    return allItems
  }, [directories, files, currentPath, disableClientSort, sortBy, sortOrder, isRealDirectory])

  // 搜索列表模式下 1:1 对齐物理文件，无需展平多行，卡片第三行以横向画廊呈现多切片
  const searchListItems: (DirectoryItem | FileType)[] = items
  const effectiveItems: (DirectoryItem | FileType)[] = items

  // 匹配当前真实目录对应的工作区配置
  const targetWorkspace = useMemo(() => {
    if (!isRealDirectory) return null
    const searchPath = workspaceDirectoryPath || currentPath
    if (searchPath) {
      const matched = workspaceDirectories.find(
        w =>
          w.path &&
          (isPathEqual(w.path, searchPath) || (isSubPath && isSubPath(w.path, searchPath)))
      )
      if (matched) return matched
    }
    return currentWorkspaceDirectory
  }, [
    isRealDirectory,
    workspaceDirectoryPath,
    currentPath,
    workspaceDirectories,
    currentWorkspaceDirectory,
    isPathEqual,
    isSubPath
  ])

  // 检查当前工作目录是否配置了非空包含规则 (customIncludeRules 或 whitelist_patterns)
  const hasActiveIncludeRules = useMemo(() => {
    if (!isRealDirectory || !targetWorkspace) return false
    // 1. 优先检查 workspace.whitelist_patterns
    let rawWhitelist = targetWorkspace.whitelist_patterns
    if (typeof rawWhitelist === 'string') {
      try {
        rawWhitelist = JSON.parse(rawWhitelist)
      } catch {
        rawWhitelist = []
      }
    }
    if (Array.isArray(rawWhitelist) && rawWhitelist.length > 0) {
      return true
    }

    // 2. 检查 workspace_config.customIncludeRules (直接解析原始 JSON，防 parseWorkspaceConfig 状态降级抹杀)
    if (targetWorkspace.workspace_config) {
      try {
        let rawCfg = targetWorkspace.workspace_config
        if (typeof rawCfg === 'string') {
          rawCfg = JSON.parse(rawCfg)
        }
        const includeRules = (rawCfg as any)?.customIncludeRules
        if (Array.isArray(includeRules) && includeRules.length > 0) {
          return true
        }
      } catch {
        // 安全忽略 JSON 解析异常
      }
    }
    return false
  }, [isRealDirectory, targetWorkspace])

  const hasIncludeRulesMismatch = isRealDirectory && items.length === 0 && hasActiveIncludeRules

  const columnCount = useMemo(() => {
    // 增加安全边距（约 48px）用于处理滚动条和容器内边距，使布局更宽松
    const availableWidth = Math.max(0, containerSize.width - 48)
    return Math.max(1, Math.floor(availableWidth / (gridCardWidth || GRID_MIN_COLUMN_WIDTH || 160)))
  }, [containerSize.width, gridCardWidth])

  // 瀑布流布局列数、列宽与列分组性能优化计算 (O(N) 映射，解决多余的 filter 和 items.indexOf)
  const waterfallColumnsData = useMemo(() => {
    if (viewMode !== 'waterfall') return null

    const gap = 16
    const padding = 32 // 左右各 p-4 (16px)
    const availableWidth = Math.max(0, containerSize.width - padding)
    const effectiveWidth = Math.max(60, gridCardWidth || 160)

    const wfColumnCount = Math.max(1, Math.floor((availableWidth + gap) / (effectiveWidth + gap)))
    // 列宽固定为滑块值（刻度线性连续，不再弹性填满）；仅当单列放不下时才收缩到可用宽度
    const calcColumnWidth = Math.max(
      0,
      Math.min(effectiveWidth, availableWidth - (wfColumnCount - 1) * gap)
    )

    // 一次性 O(N) 遍历完成分列分组
    const columns: Array<{
      colIndex: number
      columnItems: Array<{ item: DirectoryItem | FileType; index: number }>
    }> = Array.from({ length: wfColumnCount }, (_, i) => ({ colIndex: i, columnItems: [] }))

    items.forEach((item, index) => {
      const targetCol = index % wfColumnCount
      columns[targetCol].columnItems.push({ item, index })
    })

    return { columnCount: wfColumnCount, calcColumnWidth, columns }
  }, [viewMode, containerSize.width, gridCardWidth, items])

  const getAllFilesInDirectory = useCallback(
    (dirPath: string): (FileType | any)[] => {
      const resultSet = new Set<FileType | any>()
      const currentDir = items.find(
        item => 'isDirectory' in item && item.isDirectory && isPathEqual(item.path, dirPath)
      )
      if (currentDir) resultSet.add(currentDir)

      const queue = [dirPath]
      const visited = new Set<string>()

      while (queue.length > 0) {
        const currentDirPath = queue.shift()!
        const normalizedCurrentPath = normalizeForCache(stripTrailingSlash(currentDirPath))
        if (visited.has(normalizedCurrentPath)) continue
        visited.add(normalizedCurrentPath)

        const currentFiles = items.filter(item => {
          if ('isDirectory' in item && item.isDirectory) {
            return isPathEqual(item.parentPath, currentDirPath)
          } else {
            const filePath = (item as FileType).path
            return isSubPath(currentDirPath, filePath) && !isPathEqual(filePath, currentDirPath)
          }
        })

        currentFiles.forEach(file => {
          resultSet.add(file)
          if ('isDirectory' in file && file.isDirectory) {
            queue.push(file.path)
          }
        })
      }

      return Array.from(resultSet)
    },
    [items, isPathEqual, normalizeForCache, stripTrailingSlash, isSubPath]
  )

  const selectedPathsSet = useMemo(() => {
    const set = new Set<string>()
    if (Array.isArray(selectedFiles)) {
      for (let i = 0; i < selectedFiles.length; i++) {
        const f = selectedFiles[i]
        // 仅以 path 作为归一化键：与列表 item.path 的渲染判定口径保持一致，
        // 避免 id / path 混用导致匹配不到而出现「已全选但复选框未勾选」的假阴性
        const p = typeof f === 'string' ? f : f?.path
        const normalized = p ? normalizeForCache(p) : ''
        if (normalized) set.add(normalized)
      }
    }
    return set
  }, [selectedFiles, normalizeForCache])

  const activeColumns = useMemo(() => {
    const cols = []
    if (selectionEnabled !== false) {
      cols.push('checkbox')
    }
    cols.push('name')
    if (shouldShowField('qualityScore')) cols.push('qualityScore')
    if (shouldShowField('description')) cols.push('description')
    if (shouldShowField('tags')) cols.push('tags')
    if (shouldShowField('author')) cols.push('author')
    if (shouldShowField('language')) cols.push('language')
    if (showAnalysisStatus) cols.push('analysisStatus')
    if (shouldShowField('analyzedAt')) cols.push('analyzedAt')
    cols.push('modified', 'type', 'size')
    return cols
  }, [selectionEnabled, shouldShowField, showAnalysisStatus])

  const totalWidth = useMemo(() => {
    return activeColumns.reduce((sum, col) => sum + (columnWidths[col] || 100), 0)
  }, [activeColumns, columnWidths])

  const isAllSelected = useMemo(() => {
    if (items.length === 0) return false
    return items.every(item => item.path && selectedPathsSet.has(normalizeForCache(item.path)))
  }, [items, selectedPathsSet, normalizeForCache])

  return {
    items,
    searchListItems,
    effectiveItems,
    targetWorkspace,
    hasActiveIncludeRules,
    hasIncludeRulesMismatch,
    columnCount,
    waterfallColumnsData,
    getAllFilesInDirectory,
    selectedPathsSet,
    activeColumns,
    totalWidth,
    isAllSelected
  }
}

export interface UseFileListItemDataParams {
  effectiveItems: (DirectoryItem | FileType)[]
  selectedFiles: FileType[]
  selectedPathsSet: Set<string>
  activeItem?: FileType | DirectoryItem | null
  stableOnFileSelect: (
    files: (FileType | DirectoryItem | string)[],
    isFromCheckbox?: boolean
  ) => void
  stableGetSelectedFiles: () => FileType[]
  stableOnDirectoryChange: (path: string) => void
  isPathEqual: (p1?: string | null, p2?: string | null) => boolean
  workspaceDirectoryPath?: string
  normalizeForCache: (path: string) => string
  refreshKey?: number
  showAnalysisStatus: boolean
  showsmartName: boolean
  swapFileNameDisplay: boolean
  gridShowFullFileName: boolean
  getAllFilesInDirectory: (dirPath: string) => (FileType | DirectoryItem)[]
  shouldShowField: (field: string) => boolean
  getFieldLabel: (field: string) => string
  handleContextMenu: (e: React.MouseEvent, item: FileType | DirectoryItem) => void
  handleItemClick: (index: number, e: React.MouseEvent) => void
  selectionEnabled: boolean
  viewMode: FileListViewMode
  columnWidths: Record<string, number>
  totalWidth: number
  pageId?: PageId
  containerWidth: number
  columnCount: number
  gridCardWidth: number
}

export interface UseFileListItemDataResult {
  itemData: ListItemData
  gridData: ListItemData & { columnCount: number; columnWidth: number }
}

/**
 * FileList 列表与网格数据载荷装配 Hook：完整保留 itemData / gridData 的 useMemo 语义，
 * 确保 react-window 行/单元格 Memo Bailout 稳定性。
 */
export function useFileListItemData({
  effectiveItems,
  selectedFiles,
  selectedPathsSet,
  activeItem,
  stableOnFileSelect,
  stableGetSelectedFiles,
  stableOnDirectoryChange,
  isPathEqual,
  workspaceDirectoryPath,
  normalizeForCache,
  refreshKey,
  showAnalysisStatus,
  showsmartName,
  swapFileNameDisplay,
  gridShowFullFileName,
  getAllFilesInDirectory,
  shouldShowField,
  getFieldLabel,
  handleContextMenu,
  handleItemClick,
  selectionEnabled,
  viewMode,
  columnWidths,
  totalWidth,
  pageId,
  containerWidth,
  columnCount,
  gridCardWidth
}: UseFileListItemDataParams): UseFileListItemDataResult {
  const itemData: ListItemData = useMemo(
    () => ({
      items: effectiveItems,
      selectedFiles,
      selectedPathsSet,
      activeItem,
      onFileSelect: stableOnFileSelect,
      getSelectedFiles: stableGetSelectedFiles,
      onDirectoryChange: stableOnDirectoryChange,
      getFileIcon,
      formatFileSize,
      formatDate,
      isPathEqual,
      workspaceDirectoryPath: workspaceDirectoryPath || null,
      normalizeForCache,
      refreshKey: refreshKey || 0,
      showAnalysisStatus,
      showsmartName,
      swapFileNameDisplay,
      gridShowFullFileName,
      isImageFile,
      getAllFilesInDirectory,
      shouldShowField,
      getFieldLabel,
      onContextMenu: handleContextMenu,
      onItemClick: handleItemClick,
      selectionEnabled,
      viewMode,
      t,
      columnWidths,
      totalWidth,
      pageId,
      containerWidth
    }),
    [
      effectiveItems,
      selectedFiles,
      selectedPathsSet,
      activeItem,
      stableOnFileSelect,
      stableGetSelectedFiles,
      stableOnDirectoryChange,
      workspaceDirectoryPath,
      normalizeForCache,
      refreshKey,
      showAnalysisStatus,
      showsmartName,
      swapFileNameDisplay,
      gridShowFullFileName,
      getAllFilesInDirectory,
      shouldShowField,
      getFieldLabel,
      handleContextMenu,
      handleItemClick,
      isPathEqual,
      selectionEnabled,
      viewMode,
      columnWidths,
      totalWidth,
      pageId,
      containerWidth
    ]
  )

  const gridData = useMemo(
    () => ({
      ...itemData,
      columnCount,
      columnWidth:
        containerWidth > 0
          ? Math.min(
              gridCardWidth || GRID_MIN_COLUMN_WIDTH || 160,
              Math.max(0, containerWidth - 24) / Math.max(1, columnCount)
            )
          : gridCardWidth || GRID_MIN_COLUMN_WIDTH || 160
    }),
    [itemData, columnCount, containerWidth, gridCardWidth]
  )

  return { itemData, gridData }
}
