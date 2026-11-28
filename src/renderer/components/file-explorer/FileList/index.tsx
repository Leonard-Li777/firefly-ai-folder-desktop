import { DEFAULT_COLUMN_WIDTHS, GRID_MIN_COLUMN_WIDTH } from './constants'
import { FileListProps, FileType } from './types'
import { GridCell, GridCellInner } from './components/GridCell'
import { SEARCH_LIST_ROW_HEIGHT } from './components/SearchListCard'
import { LogCategory, logger } from '@firefly/shared'
import { cn } from '../../../lib/utils'
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { isImageFile } from './utils'
import { formatFileSize, getFileIcon } from '../FileItem'

import { Button } from '../../ui/button'
import { Sliders } from 'lucide-react'
import { ContextMenu } from '../../common/ContextMenu'
import { SelectionBox } from './components/SelectionBox'
import { VirtualRowRenderer } from './components/VirtualRowRenderer'
import {
  FileAdmissionNoticeBar,
  readFileAdmissionNoticeDismissed
} from './components/FileAdmissionNoticeBar'
import { FileListListHeader } from './components/FileListListHeader'
import { FileListTableView } from './components/FileListTableView'
import { EmptyState } from '../../common/EmptyState'
import { Loading } from '../../common/Loading'
import { t } from '@app/languages'
import { useFileDisplaySettings } from '../../../hooks/useFileDisplaySettings'
import { useFileExplorerStore } from '../../../stores/app-store'
import { useFileListContextMenu } from './hooks/useFileListContextMenu'
import { useFileListDerivedData, useFileListItemData } from './hooks/useFileListDerivedData'
import { useFileListScroll } from './hooks/useFileListScroll'
import { useFileListSelection } from './hooks/useFileListSelection'
import { useSettingsStore } from '../../../stores/settings-store'
import { useVirtualDirectoryStore } from '../../../stores/virtual-directory-store'

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
  // 提示条关闭状态提升至此：提示条为 absolute 吸底，需让滚动区预留等高 padding，
  // 否则会压住底部横向滚动条；关闭后 padding 自动撤销，恢复满高。
  const [noticeDismissed, setNoticeDismissed] = useState<boolean>(() =>
    readFileAdmissionNoticeDismissed()
  )
  /** 提示条是否实际显示（真实物理目录且用户未关闭）——决定滚动区是否避让 */
  const showNoticeBar = isRealDirectory && !noticeDismissed
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

  // Hooks 顺序铁律：zustand selector 必须无条件调用。
  // 严禁写成 `propSortBy || useFileExplorerStore(...)` 的短路形式——propSortBy 由「空」变「有值」
  // 时 selector 少调用一次，会抛 "Rendered fewer hooks than expected"，整棵 FileList 被 ErrorBoundary 重建。
  const storeSortBy = useFileExplorerStore(s => s.sortBy)
  const storeSortOrder = useFileExplorerStore(s => s.sortOrder)
  const sortBy = propSortBy || storeSortBy
  const sortOrder = propSortOrder || storeSortOrder

  // 订阅工作目录信息用于真实目录排障
  const workspaceDirectories = useVirtualDirectoryStore(s => s.workspaceDirectories)
  const currentWorkspaceDirectory = useVirtualDirectoryStore(s => s.currentWorkspaceDirectory)

  const {
    items,
    searchListItems,
    effectiveItems,
    targetWorkspace,
    hasIncludeRulesMismatch,
    columnCount,
    waterfallColumnsData,
    getAllFilesInDirectory,
    selectedPathsSet,
    totalWidth,
    isAllSelected
  } = useFileListDerivedData({
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
  })

  const handleOpenAdmissionRules = useCallback(() => {
    const wsId = targetWorkspace?.id ?? currentWorkspaceDirectory?.id
    if (wsId != null) {
      useSettingsStore.getState().openWorkspaceSettings({
        workspaceId: wsId,
        targetTab: 'ignore_rules'
      })
    }
  }, [targetWorkspace?.id, currentWorkspaceDirectory?.id])

  const renderEmptyState = useCallback(
    (loadingText: string) => {
      if (items.length !== 0) {
        return <EmptyState icon="folder_off" title={loadingText} isLoading={true} />
      }

      if (hasIncludeRulesMismatch) {
        return (
          <EmptyState
            icon="filter_alt"
            title={t('当前没有可显示文件，是否错误设置了文件包含规则？')}
            description={t('当前工作目录已启用文件包含白名单，非白名单内的文件已被自动隐藏。')}
          >
            <Button
              variant="outline"
              size="sm"
              onClick={handleOpenAdmissionRules}
              className="mt-3 gap-2 text-primary border-primary/30 hover:bg-primary/10 shadow-sm font-medium"
            >
              <Sliders className="w-4 h-4 text-primary" />
              {t('立即查看文件准入与包含排除配置')}
            </Button>
          </EmptyState>
        )
      }

      return <EmptyState icon="folder_off" title={t('目录为空')} isLoading={false} />
    },
    [items.length, hasIncludeRulesMismatch, handleOpenAdmissionRules]
  )

  const { scrollOffset, handleScroll, handleGridScroll } = useFileListScroll({
    items: effectiveItems,
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

  const { handleMouseDown, handleItemClick, handleKeyDown } = useFileListSelection({
    items: effectiveItems,
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

  const { contextMenu, setContextMenu, handleContextMenu, contextMenuItems } =
    useFileListContextMenu({
      selectedFiles,
      onFileSelect: stableOnFileSelect,
      currentPath
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

  // 依赖必须包含 loading：loading 早返回分支会卸载带 ref 的测量容器，
  // 若不随 loading 重新执行，ResizeObserver 将永久观测已脱离文档的旧节点（尺寸 0×0），
  // 导致 containerSize 卡死为 0 → 有结果仍渲染「没有找到匹配的文件」空态。
  useLayoutEffect(() => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        setContainerSize(prev => {
          const w = Math.round(rect.width)
          const h = Math.round(rect.height)
          if (prev.width === w && prev.height === h) return prev
          return { width: w, height: h }
        })
      }
    }
  }, [viewMode, loading])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
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
    observer.observe(el)
    return () => observer.disconnect()
  }, [viewMode, loading])

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
  }, [effectiveItems, viewMode])

  const { itemData, gridData } = useFileListItemData({
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
    containerWidth: containerSize.width,
    columnCount,
    gridCardWidth
  })

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

  // 加载态提前返回必须放在本组件最后一个 Hook（isAllSelected）之后：
  // 任何 return 之前的 Hook 若随 loading 增减调用次数，会触发 "Rendered fewer hooks than expected"。
  if (loading && items.length === 0) {
    return (
      <div
        className="w-full h-full flex flex-col items-center justify-center relative file-list-loading animate-fade-in"
        ref={containerRef}
        key="loading-view"
      >
        <Loading
          type={viewMode === 'search-list' ? 'search' : 'file-list'}
          title={viewMode === 'search-list' ? t('正在搜索...') : t('正在加载文件...')}
          description={
            viewMode === 'search-list'
              ? t('正在检索文件名、标签与深度多模态语义内容...')
              : t('正在读取目录内容与文件元数据...')
          }
        />
      </div>
    )
  }

  // 搜索列表模式：专属搜索卡片视图，挂载于 VirtualRowRenderer 之下，支持万级结果虚拟滚动与触底翻页
  if (viewMode === 'search-list') {
    const listHeight = containerSize.height > 0 ? containerSize.height : 0
    // 搜索列表宽度：预留 6px (mr-1.5) 安全呼吸边距，彻底杜绝右侧滚动条与 SplitPaneHandle 拖拽边线重叠抢占 hover
    const effectiveSearchListWidth =
      containerSize.width > 6 ? containerSize.width - 6 : containerSize.width
    // 搜索列表动态行高：由 gridCardWidth 控制（88~220px），缺省 104px
    const effectiveSearchListRowHeight = Math.round(
      Math.max(88, Math.min(220, gridCardWidth || SEARCH_LIST_ROW_HEIGHT))
    )

    return (
      <div
        className={cn(
          'w-full h-full flex flex-col overflow-hidden focus:outline-none relative animate-fade-in dark:bg-muted/70'
        )}
        key="search-list-view"
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

        <div className="flex-1 overflow-hidden mr-1.5" ref={listWrapperRef}>
          {reactWindowAvailable && ListComponent && listHeight > 0 && searchListItems.length > 0 ? (
            isReactWindowV2 ? (
              // 注意：react-window v2 的 List 没有 rowKey（v1 的 itemKey 在 v2 也无等价物），
              // 其 ListProps = Omit<HTMLAttributes<HTMLDivElement>> & {...} 且带 ...rest 展开，
              // 任何多余 prop 都会漏到根 div 上并触发 "React does not recognize the `rowKey` prop"。
              // v2 的行 key 由内部按 index 决定，行组件须保持无状态依赖（VirtualRowRenderer 已满足）。
              <ListComponent
                height={listHeight}
                rowCount={searchListItems.length}
                rowHeight={effectiveSearchListRowHeight}
                width={effectiveSearchListWidth || '100%'}
                className="scrollbar-thin overflow-x-hidden"
                listRef={listRef}
                rowProps={{
                  data: {
                    ...itemData,
                    items: searchListItems,
                    viewMode: 'search-list',
                    containerWidth: effectiveSearchListWidth,
                    searchListRowHeight: effectiveSearchListRowHeight
                  }
                }}
                rowComponent={VirtualRowRenderer}
                onScroll={onListScroll}
              />
            ) : (
              <ListComponent
                height={listHeight}
                itemCount={searchListItems.length}
                itemSize={effectiveSearchListRowHeight}
                width={effectiveSearchListWidth || '100%'}
                className="scrollbar-thin overflow-x-hidden"
                ref={listRef}
                outerRef={activeOuterRef}
                itemKey={(index: number) =>
                  (searchListItems[index] as any)?.virtualRowKey ||
                  searchListItems[index]?.path ||
                  index
                }
                itemData={{
                  ...itemData,
                  items: searchListItems,
                  viewMode: 'search-list',
                  containerWidth: effectiveSearchListWidth,
                  searchListRowHeight: effectiveSearchListRowHeight
                }}
                onScroll={onListScroll}
              >
                {VirtualRowRenderer}
              </ListComponent>
            )
          ) : loading && searchListItems.length === 0 ? (
            <div className="w-full h-full flex flex-col items-center justify-center relative file-list-loading animate-fade-in">
              <Loading
                type="search"
                title={t('正在搜索...')}
                description={t('正在检索文件名、标签与深度多模态语义内容...')}
              />
            </div>
          ) : searchListItems.length === 0 ? (
            <EmptyState
              icon="search_off"
              title={t('没有找到匹配的文件')}
              description={t('未检索到符合条件的文件，请尝试更换关键词')}
            />
          ) : (
            <EmptyState icon="search" title={t('正在准备搜索列表...')} isLoading={true} />
          )}
        </div>
      </div>
    )
  }

  if (viewMode === 'list') {
    const listHeight = containerSize.height > 40 ? containerSize.height - 40 : 0

    return (
      <div
        className={cn(
          'w-full h-full flex flex-col overflow-hidden focus:outline-none relative animate-fade-in dark:bg-muted/70',
          // 提示条吸底时预留等高空间，避免压住底部横向滚动条
          showNoticeBar && 'pb-[38px]'
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
        <FileListListHeader
          headerRef={headerRef}
          totalWidth={totalWidth}
          selectionEnabled={selectionEnabled}
          columnWidths={columnWidths}
          isAllSelected={isAllSelected}
          items={items}
          selectedFiles={selectedFiles}
          normalizeForCache={normalizeForCache}
          onFileSelect={onFileSelect}
          onResize={handleResize}
          swapFileNameDisplay={swapFileNameDisplay}
          showsmartName={showsmartName}
          shouldShowField={shouldShowField}
          getFieldLabel={getFieldLabel}
          showAnalysisStatus={showAnalysisStatus}
          sortBy={sortBy}
          sortOrder={sortOrder}
          onHeaderClick={handleHeaderClick}
        />

        <div
          className="flex-1 overflow-hidden"
          ref={listWrapperRef}
          data-scroll-container="virtual-file-list"
          style={{
            fontSize: `${Math.max(11, Math.min(18, Math.round(11 + ((gridCardWidth - 50) / 350) * 7)))}px`
          }}
        >
          {items.length === 0
            ? renderEmptyState(t('正在准备列表...'))
            : (() => {
                // 根据 gridCardWidth 动态缩放列表行高（从 50px 时 32px 到 400px 时 80px，默认 200px 时为标准 48px）
                const listRowHeight = Math.max(
                  30,
                  Math.round(32 + ((gridCardWidth - 50) / 350) * 48)
                )
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
                  renderEmptyState(t('正在准备列表...'))
                )
              })()}
        </div>

        <FileAdmissionNoticeBar
          visible={isRealDirectory}
          workspaceId={targetWorkspace?.id ?? currentWorkspaceDirectory?.id}
          onOpenAdmissionRules={handleOpenAdmissionRules}
          dismissed={noticeDismissed}
          onDismissedChange={setNoticeDismissed}
        />
      </div>
    )
  }

  if (viewMode === 'waterfall') {
    return (
      <div
        className={cn(
          'flex-1 h-full flex flex-col overflow-hidden dark:bg-muted/70 focus:outline-none relative animate-fade-in',
          showNoticeBar && 'pb-[38px]'
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
          {items.length === 0 ? (
            renderEmptyState(t('正在准备瀑布流...'))
          ) : waterfallColumnsData ? (
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
                      // 静态选中由 selectedPathsSet 判断（键为归一化路径）；拖拽框选高亮由 GridCellInner 内部订阅 store 实现
                      const isSelected = selectedPathsSet.has(normalizeForCache(itemPath))
                      const isActive = !!(
                        activeItem?.path && isPathEqual(itemPath, activeItem.path)
                      )
                      const isDirectory = !!item.isDirectory
                      const fileItem = !isDirectory ? (item as FileType) : null
                      const showThumbnail = !!(
                        fileItem &&
                        (Boolean(fileItem.thumbnailPath) ||
                          (typeof isImageFile === 'function' &&
                            (isImageFile(fileItem.extension) ||
                              isImageFile(fileItem.path) ||
                              isImageFile(fileItem.name))))
                      )
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
          ) : null}
        </div>

        <FileAdmissionNoticeBar
          visible={isRealDirectory}
          workspaceId={targetWorkspace?.id ?? currentWorkspaceDirectory?.id}
          onOpenAdmissionRules={handleOpenAdmissionRules}
          dismissed={noticeDismissed}
          onDismissedChange={setNoticeDismissed}
        />
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
          'flex-1 h-full flex flex-col dark:bg-muted/70 overflow-hidden focus:outline-none relative animate-fade-in',
          showNoticeBar && 'pb-[38px]'
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
        {items.length === 0 ? (
          renderEmptyState(t('正在准备网格...'))
        ) : reactWindowAvailable &&
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
          renderEmptyState(t('正在准备网格...'))
        )}

        <FileAdmissionNoticeBar
          visible={isRealDirectory}
          workspaceId={targetWorkspace?.id ?? currentWorkspaceDirectory?.id}
          onOpenAdmissionRules={handleOpenAdmissionRules}
          dismissed={noticeDismissed}
          onDismissedChange={setNoticeDismissed}
        />
      </div>
    )
  }

  return (
    <FileListTableView
      showNoticeBar={showNoticeBar}
      containerRef={containerRef}
      handleKeyDown={handleKeyDown}
      handleMouseDown={handleMouseDown}
      viewMode={viewMode}
      scrollOffset={scrollOffset}
      items={items}
      renderEmptyState={renderEmptyState}
      handleScroll={handleScroll}
      totalWidth={totalWidth}
      columnWidths={columnWidths}
      shouldShowField={shouldShowField}
      showAnalysisStatus={showAnalysisStatus}
      isAllSelected={isAllSelected}
      onFileSelect={onFileSelect}
      selectedFiles={selectedFiles}
      normalizeForCache={normalizeForCache}
      onResize={handleResize}
      swapFileNameDisplay={swapFileNameDisplay}
      showsmartName={showsmartName}
      getFieldLabel={getFieldLabel}
      contextMenu={contextMenu}
      contextMenuItems={contextMenuItems}
      onCloseContextMenu={() => setContextMenu(null)}
      itemData={itemData}
      isRealDirectory={isRealDirectory}
      workspaceId={targetWorkspace?.id ?? currentWorkspaceDirectory?.id}
      onOpenAdmissionRules={handleOpenAdmissionRules}
      noticeDismissed={noticeDismissed}
      onDismissedChange={setNoticeDismissed}
    />
  )
}

export default FileList
