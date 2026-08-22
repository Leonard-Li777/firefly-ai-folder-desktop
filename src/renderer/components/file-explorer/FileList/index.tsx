import {
  DEFAULT_COLUMN_WIDTHS,
  GRID_MIN_COLUMN_WIDTH,
  GRID_ROW_HEIGHT,
  HEADER_HEIGHT,
  ROW_HEIGHT
} from './constants'
import { FileListProps, FileType, ListItemData } from './types'
import { GridCell, GridCellInner } from './components/GridCell'
import { LogCategory, logger } from '@firefly/shared'
import { MaterialIcon, cn } from '../../../lib/utils'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { RowRenderer, renderAnalysisStatus } from './components/RowRenderer'
import { formatDate, isImageFile } from './utils'
import { formatFileSize, getFileIcon } from '../FileItem'

import { AnalysisStatus } from '@firefly/types'
import { Checkbox } from '../../ui/checkbox'
import { ColumnResizer } from './components/ColumnResizer'
import { ContextMenu } from '../../common/ContextMenu'
import { SelectionBox } from './components/SelectionBox'
import { VirtualRowRenderer } from './components/VirtualRowRenderer'
import { EmptyState } from '../../common/EmptyState'
import { t } from '@app/languages'
import { toast } from '../../common/Toast'
import { useAnalysisQueueStore } from '../../../stores/analysis-queue-store'
import { useFileDisplaySettings } from '../../../hooks/useFileDisplaySettings'
import { useFileExplorerStore } from '../../../stores/app-store'
import { useFileListContextMenu } from './hooks/useFileListContextMenu'
import { useFileListScroll } from './hooks/useFileListScroll'
import { useFileListSelection } from './hooks/useFileListSelection'
import { useSearchStore } from '../../../stores/search-store'
import { useDragSelectStore } from '../../../stores/drag-select-store'

// 静态导入 react-window 兼容 CJS/ESM 与 v1/v2 规范
import * as ReactWindowModule from 'react-window'

const ReactWindow: any = (ReactWindowModule as any).default || ReactWindowModule
const isReactWindowV2 = !!(ReactWindow.List || ReactWindowModule.List)

const ListComponent: any = isReactWindowV2
  ? ReactWindow.List || ReactWindowModule.List
  : ReactWindow.FixedSizeList || ReactWindowModule.FixedSizeList || ReactWindow

const GridComponent: any = isReactWindowV2
  ? ReactWindow.Grid || ReactWindowModule.Grid
  : ReactWindow.FixedSizeGrid || ReactWindowModule.FixedSizeGrid || ReactWindow

const isReactWindowLoaded = !!(ListComponent && GridComponent)

export const FileList: React.FC<FileListProps & { onFirstRender?: () => void }> = props => {
  const {
    files,
    directories,
    selectedFiles,
    activeItem,
    onFileSelect,
    getSelectedFiles,
    onDirectoryChange,
    onFileDoubleClick,
    loading = false,
    viewMode = 'list',
    currentPath,
    showAnalysisStatus = true,
    showsmartName = false,
    swapFileNameDisplay = false,
    gridShowFullFileName = false,
    isRealDirectory = false,
    sortBy: propSortBy,
    sortOrder: propSortOrder,
    disableClientSort = false,
    onSortChange,
    workspaceDirectoryPath,
    refreshKey,
    onLoadMore,
    hasMore,
    onBack,
    onForward,
    onUp,
    onFirstRender,
    selectionEnabled = true,
    pageId,
    forceShowAllFields = false,
    gridCardWidth = 200
  } = props

  const [isFirstRenderComplete, setIsFirstRenderComplete] = useState(false)
  const [reactWindowAvailable, setReactWindowAvailable] = useState(true)
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 })
  const [columnWidths, setColumnWidths] = useState<Record<string, number>>(DEFAULT_COLUMN_WIDTHS)
  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<any>(null)
  const headerRef = useRef<HTMLDivElement>(null)
  const activeOuterRef = useRef<HTMLDivElement | null>(null)
  const listWrapperRef = useRef<HTMLDivElement>(null)

  const { isPathEqual, normalizeForCache, stripTrailingSlash, isSubPath } =
    window.electronAPI!.utils
  const { shouldShowField: rawShouldShowField, getFieldLabel } =
    useFileDisplaySettings(isRealDirectory)

  const shouldShowField = useCallback(
    (field: string) => {
      if (
        forceShowAllFields &&
        ['qualityScore', 'description', 'tags', 'author', 'language'].includes(field)
      ) {
        return true
      }
      return rawShouldShowField(field)
    },
    [forceShowAllFields, rawShouldShowField]
  )

  const sortBy = propSortBy || useFileExplorerStore(s => s.sortBy)
  const sortOrder = propSortOrder || useFileExplorerStore(s => s.sortOrder)

  const getFileAnalysisStatusNonReactive = useCallback(
    (file: FileType): AnalysisStatus | undefined => {
      const queueItems = useAnalysisQueueStore.getState().snapshot.items
      const queueItem = queueItems.find(item => isPathEqual(item.path, file.path))
      if (queueItem) return queueItem.status
      if (file.isAnalyzed) return 'completed'
      return undefined
    },
    [isPathEqual]
  )

  const items = useMemo(() => {
    const validFiles = Array.isArray(files) ? files : []
    const validDirs = Array.isArray(directories) ? directories : []
    const dirs = isRealDirectory
      ? validDirs.filter(dir => dir.parentPath === currentPath)
      : validDirs
    const allItems = [...dirs, ...validFiles]
    if (disableClientSort) return allItems

    if (sortBy) {
      allItems.sort((a, b) => {
        let valA: any
        let valB: any

        switch (sortBy) {
          case 'name':
            valA = a.name.toLowerCase()
            valB = b.name.toLowerCase()
            break
          case 'size':
            valA = 'isDirectory' in a ? 0 : (a as FileType).size || 0
            valB = 'isDirectory' in b ? 0 : (b as FileType).size || 0
            break
          case 'modified':
            valA = new Date(a.modifiedAt || 0).getTime()
            valB = new Date(b.modifiedAt || 0).getTime()
            break
          case 'type':
            valA = 'isDirectory' in a ? '00_dir' : (a as FileType).extension || ''
            valB = 'isDirectory' in b ? '00_dir' : (b as FileType).extension || ''
            break
          case 'smartName':
            valA = ('isDirectory' in a ? a.name : (a as FileType).smartName || a.name).toLowerCase()
            valB = ('isDirectory' in b ? b.name : (b as FileType).smartName || b.name).toLowerCase()
            break
          case 'qualityScore':
            valA = 'isDirectory' in a ? 0 : (a as FileType).qualityScore || 0
            valB = 'isDirectory' in b ? 0 : (b as FileType).qualityScore || 0
            break
          case 'author':
            valA = 'isDirectory' in a ? '' : (a as FileType).author || ''
            valB = 'isDirectory' in b ? '' : (b as FileType).author || ''
            break
          case 'language':
            valA = 'isDirectory' in a ? '' : (a as FileType).language || ''
            valB = 'isDirectory' in b ? '' : (b as FileType).language || ''
            break
          case 'analysisStatus':
            valA = 'isDirectory' in a ? '' : getFileAnalysisStatusNonReactive(a as FileType) || ''
            valB = 'isDirectory' in b ? '' : getFileAnalysisStatusNonReactive(b as FileType) || ''
            break
          default:
            valA = 0
            valB = 0
        }

        if (valA < valB) return sortOrder === 'asc' ? -1 : 1
        if (valA > valB) return sortOrder === 'asc' ? 1 : -1
        return 0
      })

      allItems.sort((a, b) => {
        const isDirA = 'isDirectory' in a && a.isDirectory
        const isDirB = 'isDirectory' in b && b.isDirectory
        if (isDirA && !isDirB) return -1
        if (!isDirA && isDirB) return 1
        return 0
      })
    }

    return allItems
  }, [
    directories,
    files,
    currentPath,
    disableClientSort,
    sortBy,
    sortOrder,
    getFileAnalysisStatusNonReactive,
    isRealDirectory
  ])

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
    const columns: Array<{ colIndex: number; columnItems: Array<{ item: any; index: number }> }> =
      Array.from({ length: wfColumnCount }, (_, i) => ({ colIndex: i, columnItems: [] }))

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
        const currentPath = queue.shift()!
        const normalizedCurrentPath = normalizeForCache(stripTrailingSlash(currentPath))
        if (visited.has(normalizedCurrentPath)) continue
        visited.add(normalizedCurrentPath)

        const currentFiles = items.filter(item => {
          if ('isDirectory' in item && item.isDirectory) {
            return isPathEqual(item.parentPath, currentPath)
          } else {
            const filePath = (item as FileType).path
            return isSubPath(currentPath, filePath) && !isPathEqual(filePath, currentPath)
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

  const { scrollOffset, handleScroll, handleGridScroll } = useFileListScroll({
    items,
    hasMore,
    onLoadMore,
    containerSize,
    viewMode,
    currentPath
  })

  // Ref-based selection data to avoid itemData instability
  const selectedFilesRef = useRef(selectedFiles)
  const onFileSelectRef = useRef(onFileSelect)
  const getSelectedFilesRef = useRef(getSelectedFiles)

  useLayoutEffect(() => {
    selectedFilesRef.current = selectedFiles
    onFileSelectRef.current = onFileSelect
    getSelectedFilesRef.current = getSelectedFiles
  }, [selectedFiles, onFileSelect, getSelectedFiles])

  /** 稳定的 getSelectedFiles 回调，始终指向最新数据 */
  const stableGetSelectedFiles = useCallback(() => {
    if (getSelectedFilesRef.current) return getSelectedFilesRef.current()
    return selectedFilesRef.current
  }, [])

  /** 稳定的 onFileSelect 回调 */
  const stableOnFileSelect = useCallback((files: any[], isFromCheckbox?: boolean) => {
    if (onFileSelectRef.current) onFileSelectRef.current(files, isFromCheckbox)
  }, [])

  const onDirectoryChangeRef = useRef(onDirectoryChange)
  onDirectoryChangeRef.current = onDirectoryChange

  /** 稳定的 onDirectoryChange 回调 */
  const stableOnDirectoryChange = useCallback((path: string) => {
    onDirectoryChangeRef.current?.(path)
  }, [])

  const { handleMouseDown, handleItemClick, handleKeyDown, isDraggingRef } = useFileListSelection({
    items,
    selectedFiles,
    getSelectedFiles: stableGetSelectedFiles,
    activeItem,
    onFileSelect: stableOnFileSelect,
    viewMode,
    containerSize,
    scrollOffset,
    containerRef,
    onBack,
    onUp,
    onForward,
    listRef,
    pageId,
    gridCardWidth,
    gridShowFullFileName
  })

  // 拖拽框选高亮路径集合：通过 selector 订阅，仅当集合变化时触发 FileList 重渲染
  const dragSelectionPaths = useDragSelectStore(s => s.dragSelectionPaths)

  const { contextMenu, setContextMenu, handleContextMenu, contextMenuItems } =
    useFileListContextMenu({
      selectedFiles,
      onFileSelect: stableOnFileSelect,
      pageId
    })

  useEffect(() => {
    if (!isFirstRenderComplete && files.length > 0 && !loading && onFirstRender) {
      const timer = setTimeout(() => {
        onFirstRender()
        setIsFirstRenderComplete(true)
      }, 0)
      return () => clearTimeout(timer)
    }
  }, [files, loading, onFirstRender, isFirstRenderComplete])

  useEffect(() => {
    if (loading) setIsFirstRenderComplete(false)
  }, [loading])

  useEffect(() => {
    setReactWindowAvailable(true)
  }, [])

  useEffect(() => {
    if (!containerRef.current) return
    const observer = new ResizeObserver(entries => {
      const entry = entries[0]
      if (!entry) return
      const width = Math.round(entry.contentRect.width)
      const height = Math.round(entry.contentRect.height)
      setContainerSize(prev => {
        if (prev.width === width && prev.height === height) return prev
        return { width, height }
      })
    })
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [viewMode])

  useEffect(() => {
    if (listRef.current) {
      try {
        if (viewMode === 'list') {
          if (typeof listRef.current.scrollToItem === 'function') {
            listRef.current.scrollToItem(0)
          } else if (typeof listRef.current.scrollTo === 'function') {
            listRef.current.scrollTo(0)
          }
        } else if (viewMode === 'grid') {
          if (typeof listRef.current.scrollToItem === 'function') {
            listRef.current.scrollToItem({ columnIndex: 0, rowIndex: 0 })
          } else if (typeof listRef.current.scrollTo === 'function') {
            listRef.current.scrollTo({ scrollLeft: 0, scrollTop: 0 })
          }
        }
      } catch (error) {
        logger.warn(LogCategory.RENDERER, 'Failed to scroll list to top:', error)
      }
    }
  }, [items, viewMode])
  const selectedPathsSet = useMemo(() => {
    return new Set(
      (selectedFiles || []).map(f => (typeof f === 'string' ? f : f?.path || f?.id)).filter(Boolean)
    )
  }, [selectedFiles])

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

  const itemData: ListItemData = useMemo(
    () => ({
      items,
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
      dragSelectionPaths,
      pageId
    }),
    [
      items,
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
      dragSelectionPaths,
      pageId
    ]
  )

  const gridData = useMemo(
    () => ({
      ...itemData,
      columnCount,
      columnWidth:
        containerSize.width > 0
          ? Math.min(
              gridCardWidth || GRID_MIN_COLUMN_WIDTH || 160,
              Math.max(0, containerSize.width - 24) / Math.max(1, columnCount)
            )
          : gridCardWidth || GRID_MIN_COLUMN_WIDTH || 160
    }),
    [itemData, columnCount, containerSize.width, gridCardWidth]
  )

  const handleResize = useCallback((column: string, newWidth: number) => {
    setColumnWidths(prev => ({
      ...prev,
      [column]: newWidth
    }))
  }, [])

  // 同步滚动
  const onListScroll = useCallback(
    (params: any) => {
      handleScroll(params)
    },
    [handleScroll]
  )

  // 双向横向滚动同步：列表容器 ↔ 表头容器
  useEffect(() => {
    const wrapperEl = listWrapperRef.current
    const headerEl = headerRef.current
    if (!wrapperEl || !headerEl || viewMode !== 'list') return

    let isSyncingFromList = false
    let isSyncingFromHeader = false

    const syncFromList = (e: Event) => {
      if (isSyncingFromHeader) return
      const target = e.target as HTMLElement
      // 忽略非列表自身的滚动
      if (!target || target === wrapperEl) return

      isSyncingFromList = true
      headerEl.scrollLeft = target.scrollLeft
      isSyncingFromList = false
    }

    const syncFromHeader = () => {
      if (isSyncingFromList) return
      // 动态获取当前的 react-window 容器
      const targetList = wrapperEl.firstElementChild as HTMLElement
      if (!targetList) return

      isSyncingFromHeader = true
      targetList.scrollLeft = headerEl.scrollLeft
      isSyncingFromHeader = false
    }

    // 初始同步
    const initialList = wrapperEl.firstElementChild as HTMLElement
    if (initialList) {
      headerEl.scrollLeft = initialList.scrollLeft
    }

    // 利用捕获阶段监听内部组件的滚动事件（由于 scroll 不冒泡）
    wrapperEl.addEventListener('scroll', syncFromList, { capture: true, passive: true })
    headerEl.addEventListener('scroll', syncFromHeader, { passive: true })
    return () => {
      wrapperEl.removeEventListener('scroll', syncFromList, {
        capture: true
      } as EventListenerOptions)
      headerEl.removeEventListener('scroll', syncFromHeader)
    }
  }, [viewMode, reactWindowAvailable, totalWidth])

  if (loading) {
    return (
      <div className="file-list-loading">
        <div className="loading-spinner">{t('加载中...')}</div>
      </div>
    )
  }

  const getSortIcon = (column: string) => {
    if (sortBy !== column) return null
    return sortOrder === 'asc' ? (
      <MaterialIcon icon="arrow_upward" className="text-xs ml-1" />
    ) : (
      <MaterialIcon icon="arrow_downward" className="text-xs ml-1" />
    )
  }

  const getHeaderClass = (column: string, baseClass?: string) => {
    return cn(
      baseClass,
      'cursor-pointer hover:bg-accent/50 transition-colors flex items-center relative border-r border-border/50 px-2 h-full',
      sortBy === column ? 'text-primary font-bold' : ''
    )
  }

  const handleHeaderClick = (column: any) => {
    if (onSortChange) {
      const newSortOrder = sortBy === column ? (sortOrder === 'asc' ? 'desc' : 'asc') : 'asc'
      onSortChange(column, newSortOrder)
    } else {
      const { setSortBy, toggleSortOrder } = useFileExplorerStore.getState()
      if (sortBy === column) {
        toggleSortOrder()
      } else {
        setSortBy(column as any)
      }
    }
  }

  const isAllSelected = useMemo(() => {
    if (items.length === 0) return false
    if (selectedFiles.length < items.length) return false
    return items.every(item => item.path && selectedPathsSet.has(item.path))
  }, [items, selectedFiles.length, selectedPathsSet])

  if (viewMode === 'list') {
    const listHeight = containerSize.height > 40 ? containerSize.height - 40 : 0

    return (
      <div
        className={cn(
          'w-full h-full flex flex-col overflow-hidden focus:outline-none relative animate-fade-in dark:bg-muted/70'
        )}
        key="list-view"
        ref={containerRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onMouseDown={handleMouseDown}
        onDragStart={e => e.preventDefault()}
        onClick={e => {
          const target = e.target as HTMLElement
          if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') {
            containerRef.current?.focus()
          }
        }}
      >
        <SelectionBox viewMode={viewMode} scrollOffset={scrollOffset} containerRef={containerRef} />
        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            items={contextMenuItems}
            onClose={() => setContextMenu(null)}
          />
        )}

        {/* 表头行 — 独立横向滚动容器，与列表共享同步 */}
        <div
          ref={headerRef}
          className="overflow-x-auto overflow-y-hidden bg-muted/50 border-b border-border/50 flex-shrink-0 scrollbar-none"
          style={{ scrollbarWidth: 'none' }}
        >
          <div
            className="flex items-center text-xs font-medium text-foreground/70 select-none uppercase tracking-wider h-10"
            style={{ width: totalWidth }}
          >
            {selectionEnabled !== false && (
              <div
                className="flex-shrink-0 flex justify-center items-center border-r border-border/50 h-full relative"
                style={{ width: columnWidths.checkbox }}
              >
                <Checkbox
                  checked={isAllSelected}
                  onCheckedChange={checked => {
                    if (isAllSelected) {
                      const visiblePaths = new Set(items.map(it => it.path))
                      onFileSelect(
                        selectedFiles.filter(f => f && !visiblePaths.has(f.path)),
                        true
                      )
                    } else {
                      onFileSelect(
                        items.filter(it => !!it.path).map(it => it.path!),
                        true
                      )
                    }
                  }}
                />
                <ColumnResizer
                  onResize={w => handleResize('checkbox', w)}
                  currentWidth={columnWidths.checkbox}
                />
              </div>
            )}
            <div
              className={getHeaderClass('name', 'flex-shrink-0')}
              style={{ width: columnWidths.name }}
              onClick={() => handleHeaderClick(swapFileNameDisplay ? 'name' : 'smartName')}
            >
              <span className="truncate">
                {!swapFileNameDisplay && showsmartName ? t('智能文件名') : t('名称')}
              </span>{' '}
              {getSortIcon(swapFileNameDisplay ? 'name' : 'smartName')}
              <ColumnResizer
                onResize={w => handleResize('name', w)}
                currentWidth={columnWidths.name}
              />
            </div>
            {shouldShowField('qualityScore') && (
              <div
                className={getHeaderClass('qualityScore', 'flex-shrink-0')}
                style={{ width: columnWidths.qualityScore }}
                onClick={() => handleHeaderClick('qualityScore')}
              >
                <span className="truncate">{getFieldLabel('qualityScore')}</span>{' '}
                {getSortIcon('qualityScore')}
                <ColumnResizer
                  onResize={w => handleResize('qualityScore', w)}
                  currentWidth={columnWidths.qualityScore}
                />
              </div>
            )}
            {shouldShowField('description') && (
              <div
                className="flex-shrink-0 px-2 flex items-center border-r border-border/50 h-full relative"
                style={{ width: columnWidths.description }}
              >
                <span className="truncate">{getFieldLabel('description')}</span>
                <ColumnResizer
                  onResize={w => handleResize('description', w)}
                  currentWidth={columnWidths.description}
                />
              </div>
            )}
            {shouldShowField('tags') && (
              <div
                className="flex-shrink-0 px-2 flex items-center border-r border-border/50 h-full relative"
                style={{ width: columnWidths.tags }}
              >
                <span className="truncate">{getFieldLabel('tags')}</span>
                <ColumnResizer
                  onResize={w => handleResize('tags', w)}
                  currentWidth={columnWidths.tags}
                />
              </div>
            )}
            {shouldShowField('author') && (
              <div
                className={getHeaderClass('author', 'flex-shrink-0')}
                style={{ width: columnWidths.author }}
                onClick={() => handleHeaderClick('author')}
              >
                <span className="truncate">{getFieldLabel('author')}</span> {getSortIcon('author')}
                <ColumnResizer
                  onResize={w => handleResize('author', w)}
                  currentWidth={columnWidths.author}
                />
              </div>
            )}
            {shouldShowField('language') && (
              <div
                className={getHeaderClass('language', 'flex-shrink-0')}
                style={{ width: columnWidths.language }}
                onClick={() => handleHeaderClick('language')}
              >
                <span className="truncate">{getFieldLabel('language')}</span>{' '}
                {getSortIcon('language')}
                <ColumnResizer
                  onResize={w => handleResize('language', w)}
                  currentWidth={columnWidths.language}
                />
              </div>
            )}
            {showAnalysisStatus && (
              <div
                className={getHeaderClass('analysisStatus', 'flex-shrink-0')}
                style={{ width: columnWidths.analysisStatus }}
                onClick={() => handleHeaderClick('analysisStatus')}
              >
                <span className="truncate">{t('分析状态')}</span> {getSortIcon('analysisStatus')}
                <ColumnResizer
                  onResize={w => handleResize('analysisStatus', w)}
                  currentWidth={columnWidths.analysisStatus}
                />
              </div>
            )}
            {shouldShowField('analyzedAt') && (
              <div
                className={getHeaderClass('analyzedAt', 'flex-shrink-0')}
                style={{ width: columnWidths.analyzedAt }}
                onClick={() => handleHeaderClick('analyzedAt')}
              >
                <span className="truncate">{getFieldLabel('analyzedAt')}</span>{' '}
                {getSortIcon('analyzedAt')}
                <ColumnResizer
                  onResize={w => handleResize('analyzedAt', w)}
                  currentWidth={columnWidths.analyzedAt}
                />
              </div>
            )}
            <div
              className={getHeaderClass('modified', 'flex-shrink-0')}
              style={{ width: columnWidths.modified }}
              onClick={() => handleHeaderClick('modified')}
            >
              <span className="truncate">{t('修改日期')}</span> {getSortIcon('modified')}
              <ColumnResizer
                onResize={w => handleResize('modified', w)}
                currentWidth={columnWidths.modified}
              />
            </div>
            <div
              className={getHeaderClass('type', 'flex-shrink-0')}
              style={{ width: columnWidths.type }}
              onClick={() => handleHeaderClick('type')}
            >
              <span className="truncate">{t('类型')}</span> {getSortIcon('type')}
              <ColumnResizer
                onResize={w => handleResize('type', w)}
                currentWidth={columnWidths.type}
              />
            </div>
            <div
              className={getHeaderClass('size', 'flex-shrink-0 justify-end')}
              style={{ width: columnWidths.size }}
              onClick={() => handleHeaderClick('size')}
            >
              <span className="truncate">{t('大小')}</span> {getSortIcon('size')}
              <ColumnResizer
                onResize={w => handleResize('size', w)}
                currentWidth={columnWidths.size}
              />
            </div>
          </div>
        </div>

        <div
          className="flex-1 overflow-hidden"
          ref={listWrapperRef}
          style={{
            fontSize: `${Math.max(11, Math.min(18, Math.round(11 + ((gridCardWidth - 50) / 350) * 7)))}px`
          }}
        >
          {(() => {
            // 根据 gridCardWidth 动态缩放列表行高（从 50px 时 32px 到 400px 时 80px，默认 200px 时为标准 48px）
            const listRowHeight = Math.max(30, Math.round(32 + ((gridCardWidth - 50) / 350) * 48))
            const listFontSize = Math.max(
              11,
              Math.min(18, Math.round(11 + ((gridCardWidth - 50) / 350) * 7))
            )
            return reactWindowAvailable && ListComponent && listHeight > 0 ? (
              isReactWindowV2 ? (
                <ListComponent
                  height={listHeight}
                  rowCount={items.length}
                  rowHeight={listRowHeight}
                  width={containerSize.width || '100%'}
                  className="scrollbar-thin"
                  listRef={listRef}
                  rowProps={{ data: { ...itemData, listRowHeight, listFontSize } }}
                  rowComponent={VirtualRowRenderer}
                  onScroll={onListScroll}
                />
              ) : (
                <ListComponent
                  height={listHeight}
                  itemCount={items.length}
                  itemSize={listRowHeight}
                  width={containerSize.width || '100%'}
                  className="scrollbar-thin"
                  ref={listRef}
                  outerRef={activeOuterRef}
                  itemData={{ ...itemData, listRowHeight, listFontSize }}
                  onScroll={onListScroll}
                >
                  {VirtualRowRenderer}
                </ListComponent>
              )
            ) : (
              <EmptyState
                icon="folder_off"
                title={items.length === 0 ? t('目录为空') : t('正在准备列表...')}
                isLoading={items.length !== 0}
              />
            )
          })()}
        </div>
      </div>
    )
  }

  if (viewMode === 'waterfall') {
    return (
      <div
        className={cn(
          'flex-1 h-full flex flex-col overflow-hidden dark:bg-muted/70 focus:outline-none relative animate-fade-in'
        )}
        key="waterfall-view"
        ref={containerRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onMouseDown={handleMouseDown}
        onDragStart={e => e.preventDefault()}
        onClick={e => {
          const target = e.target as HTMLElement
          if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') {
            containerRef.current?.focus()
          }
        }}
      >
        <SelectionBox viewMode={viewMode} scrollOffset={scrollOffset} containerRef={containerRef} />

        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            items={contextMenuItems}
            onClose={() => setContextMenu(null)}
          />
        )}

        <div className="flex-1 overflow-y-auto p-4 scrollbar-thin" onScroll={e => handleScroll(e)}>
          {waterfallColumnsData && (
            <div className="flex gap-4 items-start w-full justify-center">
              {waterfallColumnsData.columns.map(({ colIndex, columnItems }) => {
                return (
                  <div
                    key={colIndex}
                    style={{
                      width: waterfallColumnsData.calcColumnWidth,
                      minWidth: waterfallColumnsData.calcColumnWidth,
                      maxWidth: waterfallColumnsData.calcColumnWidth
                    }}
                    className="flex flex-col gap-4 shrink-0 overflow-hidden"
                  >
                    {columnItems.map(({ item, index }) => {
                      const itemPath = item.path || ''
                      // 静态选中由 selectedPathsSet 判断；拖拽框选高亮由 GridCellInner 内部订阅 store 实现
                      const isSelected = selectedPathsSet.has(itemPath)
                      const isActive = !!(
                        activeItem?.path && isPathEqual(itemPath, activeItem.path)
                      )
                      const isDirectory = !!item.isDirectory
                      const fileItem = !isDirectory ? (item as FileType) : null
                      const showThumbnail = !!(fileItem && isImageFile(fileItem.extension))
                      const safeItemName = item.name || t('未知文件')

                      return (
                        <GridCellInner
                          key={itemPath || index}
                          item={item}
                          index={index}
                          isSelected={isSelected}
                          isActive={isActive}
                          isDirectory={isDirectory}
                          fileItem={fileItem}
                          showThumbnail={showThumbnail}
                          safeItemName={safeItemName}
                          showsmartName={showsmartName}
                          swapFileNameDisplay={swapFileNameDisplay}
                          gridShowFullFileName={gridShowFullFileName}
                          refreshKey={refreshKey || 0}
                          workspaceDirectoryPath={workspaceDirectoryPath || null}
                          getFileIcon={getFileIcon}
                          formatFileSize={formatFileSize}
                          normalizeForCache={normalizeForCache}
                          onItemClick={handleItemClick}
                          onContextMenu={handleContextMenu}
                          onDirectoryChange={onDirectoryChange}
                          onFileSelect={onFileSelect}
                          onFileDoubleClick={onFileDoubleClick}
                          getAllFilesInDirectory={getAllFilesInDirectory}
                          selectedFiles={selectedFiles}
                          itemPath={itemPath}
                          isPathEqual={isPathEqual}
                          viewMode="waterfall"
                          pageId={pageId}
                        />
                      )
                    })}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>
    )
  }

  if (viewMode === 'grid') {
    const gridWidth = Math.max(0, containerSize.width - 24)
    // 单元格列宽：弹性填满容器（每列占用宽度含卡片间间隙），无右侧留白、左右对称
    const columnWidth =
      containerSize.width > 0 ? gridWidth / columnCount : GRID_MIN_COLUMN_WIDTH || 160
    // 卡片内容宽度固定为滑块值（刻度线性连续）；超出部分由卡片间水平间隙吸收
    const cardWidth = Math.min(gridCardWidth || GRID_MIN_COLUMN_WIDTH || 160, columnWidth)
    // 如果开启了显示完整文件名，为多行文件名预留足够的高高度基准 (90px) 彻底防溢出
    const extraTextPadding = gridShowFullFileName ? 90 : 50
    // 垂直方向使用独立的小间隙，避免水平间隙被放大时行距同步放大、每行相隔很远
    const rowGap = Math.max(4, Math.round(cardWidth * 0.05))
    const rowHeight = Math.max(50, Math.round(cardWidth + extraTextPadding + rowGap))
    const rowCount = Math.ceil(items.length / columnCount)

    return (
      <div
        className={cn(
          'flex-1 h-full flex flex-col dark:bg-muted/70 overflow-hidden focus:outline-none relative animate-fade-in'
        )}
        key="grid-view"
        ref={containerRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onMouseDown={handleMouseDown}
        onDragStart={e => e.preventDefault()}
        onClick={e => {
          const target = e.target as HTMLElement
          if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') {
            containerRef.current?.focus()
          }
        }}
      >
        {contextMenu && (
          <ContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            items={contextMenuItems}
            onClose={() => setContextMenu(null)}
          />
        )}
        <SelectionBox viewMode={viewMode} scrollOffset={scrollOffset} containerRef={containerRef} />
        {reactWindowAvailable &&
        GridComponent &&
        containerSize.width > 0 &&
        containerSize.height > 0 ? (
          <div className="flex-1 overflow-hidden p-2">
            {isReactWindowV2 ? (
              <GridComponent
                columnCount={columnCount}
                columnWidth={columnWidth}
                height={containerSize.height - 16}
                rowCount={rowCount}
                rowHeight={rowHeight}
                width={gridWidth}
                gridRef={listRef}
                cellProps={{ data: gridData }}
                cellComponent={GridCell}
                style={{ overflowX: 'hidden' }}
                onScroll={handleGridScroll}
              />
            ) : (
              <GridComponent
                columnCount={columnCount}
                columnWidth={columnWidth}
                height={containerSize.height - 16}
                rowCount={rowCount}
                rowHeight={rowHeight}
                width={gridWidth}
                itemData={gridData}
                ref={listRef}
                style={{ overflowX: 'hidden' }}
                onScroll={handleGridScroll}
              >
                {GridCell}
              </GridComponent>
            )}
          </div>
        ) : (
          <EmptyState
            icon="folder_off"
            title={items.length === 0 ? t('目录为空') : t('正在准备网格...')}
            isLoading={items.length !== 0}
          />
        )}
      </div>
    )
  }

  return (
    <div
      className="flex-1 overflow-hidden flex flex-col focus:outline-none relative"
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onMouseDown={handleMouseDown}
      onClick={e => {
        const target = e.target as HTMLElement
        if (target.tagName !== 'INPUT' && target.tagName !== 'TEXTAREA') {
          containerRef.current?.focus()
        }
      }}
    >
      <SelectionBox viewMode={viewMode} scrollOffset={scrollOffset} containerRef={containerRef} />
      <div
        className="flex-1 overflow-x-auto overflow-y-auto scrollbar-thin"
        onScroll={e => handleScroll(e)}
      >
        <table className="text-sm text-left" style={{ width: totalWidth, tableLayout: 'fixed' }}>
          <colgroup>
            <col style={{ width: columnWidths.checkbox }} />
            <col style={{ width: columnWidths.name }} />
            {shouldShowField('qualityScore') && (
              <col style={{ width: columnWidths.qualityScore }} />
            )}
            {shouldShowField('description') && <col style={{ width: columnWidths.description }} />}
            {shouldShowField('tags') && <col style={{ width: columnWidths.tags }} />}
            {shouldShowField('author') && <col style={{ width: columnWidths.author }} />}
            {shouldShowField('language') && <col style={{ width: columnWidths.language }} />}
            {showAnalysisStatus && <col style={{ width: columnWidths.analysisStatus }} />}
            {shouldShowField('analyzedAt') && <col style={{ width: columnWidths.analyzedAt }} />}
            <col style={{ width: columnWidths.modified }} />
            <col style={{ width: columnWidths.type }} />
            <col style={{ width: columnWidths.size }} />
          </colgroup>
          <thead className="bg-muted/30 sticky top-0 z-10 border-b border-border/50">
            <tr className="text-left text-xs font-medium text-muted-foreground uppercase tracking-wider h-10">
              <th className="p-2 border-r border-border/50 relative">
                <Checkbox
                  checked={isAllSelected}
                  onCheckedChange={checked => {
                    if (checked) {
                      onFileSelect(
                        items.map(item => item.path!),
                        true
                      )
                    } else {
                      onFileSelect([], true)
                    }
                  }}
                />
                <ColumnResizer
                  onResize={w => handleResize('checkbox', w)}
                  currentWidth={columnWidths.checkbox}
                />
              </th>
              <th className="p-2 font-medium truncate hover:bg-accent/40 cursor-default transition-colors border-r border-border/50 relative">
                {!swapFileNameDisplay && showsmartName ? t('智能文件名') : t('名称')}
                <ColumnResizer
                  onResize={w => handleResize('name', w)}
                  currentWidth={columnWidths.name}
                />
              </th>
              {shouldShowField('qualityScore') && (
                <th className="p-2 font-medium truncate hover:bg-accent/40 cursor-default transition-colors border-r border-border/50 relative">
                  {getFieldLabel('qualityScore')}{' '}
                  <ColumnResizer
                    onResize={w => handleResize('qualityScore', w)}
                    currentWidth={columnWidths.qualityScore}
                  />
                </th>
              )}
              {shouldShowField('description') && (
                <th className="p-2 font-medium truncate hover:bg-accent/40 cursor-default transition-colors border-r border-border/50 relative">
                  {getFieldLabel('description')}{' '}
                  <ColumnResizer
                    onResize={w => handleResize('description', w)}
                    currentWidth={columnWidths.description}
                  />
                </th>
              )}
              {shouldShowField('tags') && (
                <th className="p-2 font-medium truncate hover:bg-accent/40 cursor-default transition-colors border-r border-border/50 relative">
                  {getFieldLabel('tags')}{' '}
                  <ColumnResizer
                    onResize={w => handleResize('tags', w)}
                    currentWidth={columnWidths.tags}
                  />
                </th>
              )}
              {shouldShowField('author') && (
                <th className="p-2 font-medium truncate hover:bg-accent/40 cursor-default transition-colors border-r border-border/50 relative">
                  {getFieldLabel('author')}{' '}
                  <ColumnResizer
                    onResize={w => handleResize('author', w)}
                    currentWidth={columnWidths.author}
                  />
                </th>
              )}
              {shouldShowField('language') && (
                <th className="p-2 font-medium truncate hover:bg-accent/40 cursor-default transition-colors border-r border-border/50 relative">
                  {getFieldLabel('language')}{' '}
                  <ColumnResizer
                    onResize={w => handleResize('language', w)}
                    currentWidth={columnWidths.language}
                  />
                </th>
              )}
              {showAnalysisStatus && (
                <th className="p-2 font-medium truncate hover:bg-accent/40 cursor-default transition-colors border-r border-border/50 relative">
                  {t('分析状态')}{' '}
                  <ColumnResizer
                    onResize={w => handleResize('analysisStatus', w)}
                    currentWidth={columnWidths.analysisStatus}
                  />
                </th>
              )}
              {shouldShowField('analyzedAt') && (
                <th className="p-2 font-medium truncate hover:bg-accent/40 cursor-default transition-colors border-r border-border/50 relative">
                  {getFieldLabel('analyzedAt')}{' '}
                  <ColumnResizer
                    onResize={w => handleResize('analyzedAt', w)}
                    currentWidth={columnWidths.analyzedAt}
                  />
                </th>
              )}
              <th className="p-2 font-medium truncate hover:bg-accent/40 cursor-default transition-colors border-r border-border/50 relative">
                {t('修改日期')}{' '}
                <ColumnResizer
                  onResize={w => handleResize('modified', w)}
                  currentWidth={columnWidths.modified}
                />
              </th>
              <th className="p-2 font-medium truncate hover:bg-accent/40 cursor-default transition-colors border-r border-border/50 relative">
                {t('类型')}{' '}
                <ColumnResizer
                  onResize={w => handleResize('type', w)}
                  currentWidth={columnWidths.type}
                />
              </th>
              <th className="p-2 font-medium truncate hover:bg-accent/40 cursor-default transition-colors relative">
                {t('大小')}{' '}
                <ColumnResizer
                  onResize={w => handleResize('size', w)}
                  currentWidth={columnWidths.size}
                />
              </th>
            </tr>
          </thead>
          <tbody className="divide-y relative">
            {contextMenu && (
              <ContextMenu
                x={contextMenu.x}
                y={contextMenu.y}
                items={contextMenuItems}
                onClose={() => setContextMenu(null)}
              />
            )}
            {items.map((item, index) => (
              <RowRenderer key={item.path || index} index={index} style={{}} data={itemData} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default FileList
