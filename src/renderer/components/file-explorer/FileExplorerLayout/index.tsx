import React, { useState, useMemo, useCallback, useEffect } from 'react'
import { FileItem, DirectoryItem } from '@firefly/types'
import { FileList } from '../FileList'
import { SEARCH_LIST_ROW_HEIGHT } from '../FileList/components/SearchListCard'
import { FileDetailsPanel } from '../FileDetailsPanel'
import { FilePreviewPanel } from '../FilePreviewPanel'
import { SplitPreviewPanel } from '../SplitPreviewPanel'
import { SplitPane } from '../../common/SplitPane'
import { EmptyState } from '../../common/EmptyState'
import { Loading } from '../../common/Loading'
import { PAGE_IDS } from '../../../constants/page-ids'
import { t } from '@app/languages'
import { useSettingsStore } from '../../../stores/settings-store'
import { usePreviewOverlayStore } from '../../../stores/preview-overlay-store'
import { getPreviewRouteType, getExtFromSmartName } from '../../../lib/preview-utils'
import { FileExplorerLayoutProps, ViewMode, FileExplorerLayoutContext } from './types'
import { cn, MaterialIcon } from '../../../lib/utils'
import {
  PANEL_IDS,
  PanelId,
  getLayoutDefinition,
  getPageDefaultLayout,
  resolveEffectiveCollapse,
  resolveLayoutProjection,
  areSetsEqual
} from '../layout-switcher'
import {
  useLayoutSwitcherStore,
  getDirectionalStorageKey
} from '../../../stores/layout-switcher-store'

/**
 * 通用文件浏览器布局容器组件 (FileExplorerLayout)
 * 具备支持受控/非受控 viewMode, 单双击选中状态管理, selectionEnabled 显隐控制, 真实目录导航透传, SplitPane 3 区块拆分 (1: 列表+Toolbar 2: 预览 3: 属性)
 */
export const FileExplorerLayout: React.FC<FileExplorerLayoutProps> = ({
  files,
  directories = [],
  selectionEnabled = true,
  viewMode: externalViewMode,
  onViewModeChange,
  selectedFileIds,
  selectedFiles: externalSelectedFiles,
  activeItem: externalActiveItem = null,
  pageId,
  isDetailsUnavailable = false,
  onFileSelect: externalOnFileSelect,
  onFileDoubleClick,
  onSelectionChange,
  onDirectoryChange,
  onBack,
  onForward,
  onUp,
  workspaceDirectoryPath,
  workspaceDirectoryType,
  currentPath,
  isRealDirectory = false,
  refreshKey,
  onFileDeleted,
  onFileUpdated,
  onCloseDetailsPanel,
  showDetailsPanel = true,
  showPreviewPanel = false,
  defaultViewMode = 'grid',
  renderToolbar,
  renderFooter,
  isLoading = false,
  hasMore,
  onLoadMore,
  sortBy,
  sortOrder,
  disableClientSort,
  onSortChange,
  showsmartName,
  swapFileNameDisplay: propSwapFileNameDisplay,
  showAnalysisStatus,
  getSelectedFiles: externalGetSelectedFiles,
  className,
  id
}) => {
  const showMissingFiles =
    useSettingsStore(s => s.getConfigValue<boolean>('SHOW_MISSING_FILES')) ?? true
  const storeSwap =
    useSettingsStore(s => s.getConfigValue<boolean>('SWAP_FILE_NAME_DISPLAY')) ?? false
  const swapFileNameDisplay = propSwapFileNameDisplay ?? storeSwap
  const gridShowFullFileName =
    useSettingsStore(s => s.getConfigValue<boolean>('GRID_SHOW_FULL_FILE_NAME')) ?? false

  const displayFiles = useMemo(() => {
    if (showMissingFiles) return files
    return files.filter(f => (f as any).status !== 0)
  }, [files, showMissingFiles])

  // 分页面隔离持久化 viewMode 与 gridCardWidth
  const pageViewModeKey = pageId ? `page_view_mode_${pageId}` : 'page_view_mode_default'

  const [internalViewMode, setInternalViewMode] = useState<ViewMode>(() => {
    if (externalViewMode !== undefined) return externalViewMode
    try {
      const saved = localStorage.getItem(pageViewModeKey) as ViewMode
      // search-list 为搜索临时态，不从持久化恢复
      if (saved && ['grid', 'list', 'waterfall', 'table'].includes(saved)) {
        return saved
      }
    } catch (e) {
      // Ignore localStorage errors
    }
    return defaultViewMode
  })

  const [internalActiveItem, setInternalActiveItem] = useState<FileItem | DirectoryItem | null>(
    null
  )
  const [internalSelectedFiles, setInternalSelectedFiles] = useState<FileItem[]>([])

  // 支持受控/非受控 viewMode
  const currentViewMode = externalViewMode !== undefined ? externalViewMode : internalViewMode

  const handleViewModeChange = useCallback(
    (mode: ViewMode) => {
      setInternalViewMode(mode)
      try {
        localStorage.setItem(pageViewModeKey, mode)
      } catch (e) {
        // Ignore localStorage errors
      }
      if (onViewModeChange) {
        onViewModeChange(mode)
      }
    },
    [onViewModeChange, pageViewModeKey]
  )

  // 优先级：优先使用外部传入的 activeItem，若无则使用内部选中的 activeItem
  const activeItem = externalActiveItem !== undefined ? externalActiveItem : internalActiveItem

  // 布局切换引擎核心状态 (SSOT)
  const targetPageId = pageId || PAGE_IDS.REAL_DIRECTORY
  const layoutKey = useLayoutSwitcherStore(
    s => s.pageLayouts[targetPageId] ?? getPageDefaultLayout(targetPageId)
  )
  const customPanels = useLayoutSwitcherStore(s => s.visiblePanels[targetPageId])
  const layoutDef = useMemo(() => getLayoutDefinition(layoutKey), [layoutKey])
  const closePanel = useLayoutSwitcherStore(s => s.closePanel)

  const unavailableSet = useMemo(
    () => (isDetailsUnavailable ? new Set<PanelId>([PANEL_IDS.DETAILS]) : new Set<PanelId>()),
    [isDetailsUnavailable]
  )

  const containerRef = React.useRef<HTMLDivElement>(null)
  const prevCollapsedRef = React.useRef<Set<PanelId>>(new Set())
  const [transientCollapsed, setTransientCollapsed] = useState<Set<PanelId>>(new Set())

  // 宏观切换清空瞬态折叠记忆 (AC-5)
  useEffect(() => {
    prevCollapsedRef.current.clear()
    setTransientCollapsed(new Set())
  }, [targetPageId, layoutKey, customPanels, unavailableSet])

  // 容器尺寸监听与瞬态折叠消赤调度 (AC-4 / AC-6)
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const updateSize = (w: number, h: number) => {
      if (w <= 0 || h <= 0) return
      const storedPanels = useLayoutSwitcherStore.getState().getVisiblePanels(targetPageId)
      const next = resolveEffectiveCollapse(
        w,
        h,
        layoutDef,
        new Set(storedPanels),
        prevCollapsedRef.current,
        16,
        unavailableSet
      )
      if (!areSetsEqual(next, prevCollapsedRef.current)) {
        prevCollapsedRef.current = next
        setTransientCollapsed(new Set(next))
      }
    }

    const rect = el.getBoundingClientRect()
    updateSize(rect.width, rect.height)

    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        updateSize(width, height)
      }
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [targetPageId, layoutDef, customPanels, unavailableSet])

  // 恒定两级树槽位投影推导
  const projection = useMemo(() => {
    const storedPanels = useLayoutSwitcherStore.getState().getVisiblePanels(targetPageId)
    const effectivePanels = storedPanels.filter(
      p => !transientCollapsed.has(p) && !unavailableSet.has(p)
    )
    return resolveLayoutProjection(layoutDef, effectivePanels, unavailableSet)
  }, [targetPageId, layoutDef, transientCollapsed, unavailableSet, customPanels])

  // 优先级：优先使用外部传入的 selectedFiles；若无则根据 selectedFileIds 计算；若均无则使用内部状态
  const selectedFiles = useMemo(() => {
    if (externalSelectedFiles !== undefined) {
      return (externalSelectedFiles || []) as FileItem[]
    }
    if (selectedFileIds !== undefined) {
      if (!selectedFileIds.length) return []
      const idSet = new Set(selectedFileIds)
      const matchedFiles = files.filter(f => idSet.has(f.id) || idSet.has(f.path))
      const matchedDirs = directories.filter(d => d.path && idSet.has(d.path))
      return [...matchedDirs, ...matchedFiles] as FileItem[]
    }
    return internalSelectedFiles
  }, [externalSelectedFiles, selectedFileIds, files, directories, internalSelectedFiles])

  // 受控模式下，外部 activeItem 是权威来源：其变化时同步内部 active 状态
  useEffect(() => {
    if (externalActiveItem !== undefined) {
      setInternalActiveItem(externalActiveItem || null)
    }
  }, [externalActiveItem])

  const handleFileSelect = useCallback(
    (filesOrItem: any, isFromCheckbox?: boolean) => {
      let selectedList: any[] = []
      if (Array.isArray(filesOrItem)) {
        selectedList = filesOrItem
      } else if (filesOrItem) {
        selectedList = [filesOrItem]
      }

      // 非勾选框触发的单选：若该文件已在选中列表中，执行取消选中
      if (!isFromCheckbox && selectedList.length === 1) {
        const clickedItem = selectedList[0]
        const clickedId =
          typeof clickedItem === 'string' ? clickedItem : clickedItem?.path || clickedItem?.id
        const isAlreadySelected = selectedFiles.some(
          f => f.path === clickedId || String(f.id) === clickedId
        )

        if (isAlreadySelected) {
          setInternalSelectedFiles([])
          setInternalActiveItem(null)

          if (onSelectionChange) {
            onSelectionChange([])
          }
          if (externalOnFileSelect) {
            externalOnFileSelect([], isFromCheckbox)
          }
          return
        }
      }

      if (selectedList.length === 1) {
        const item = selectedList[0]
        setInternalActiveItem(typeof item === 'object' ? item : null)
      } else if (selectedList.length === 0) {
        setInternalActiveItem(null)
      }

      // 将 string 转换为实际对象（如果需要）
      const resolvedList: FileItem[] = selectedList.map(item => {
        if (typeof item === 'object') return item as FileItem
        const found = files.find(f => f.path === item || String(f.id) === item)
        if (found) return found
        const foundDir = directories.find(d => d.path === item)
        if (foundDir) return foundDir as any
        return { path: item, name: item.split(/[\\/]/).pop() || item } as any
      })

      setInternalSelectedFiles(resolvedList)

      if (onSelectionChange) {
        onSelectionChange(resolvedList)
      }

      if (externalOnFileSelect) {
        externalOnFileSelect(filesOrItem, isFromCheckbox)
      }
    },
    [externalOnFileSelect, onSelectionChange, selectedFiles, files, directories]
  )

  const currentFile = useMemo(() => {
    const item = activeItem || (selectedFiles.length === 1 ? selectedFiles[0] : null)
    if (item && !('isDirectory' in item && item.isDirectory)) {
      return item as FileItem
    }
    return null
  }, [activeItem, selectedFiles])

  const getSelectedFiles = useCallback((): FileItem[] => {
    if (externalGetSelectedFiles) return externalGetSelectedFiles()
    return selectedFiles
  }, [externalGetSelectedFiles, selectedFiles])

  // 分栏预览同步：仅在明确激活具体单文件时触发预览，避免多选/全选时触发不必要的深度预览加载
  useEffect(() => {
    if (pageId && showPreviewPanel) {
      const splitState = usePreviewOverlayStore.getState()
      const pageMode = splitState.pageStates[pageId]?.mode ?? 'split'
      if (pageMode === 'split') {
        const item = activeItem
        if (
          item &&
          (item.path || (item as any).originalPath) &&
          !('isDirectory' in item && item.isDirectory)
        ) {
          const filePath = (item as any).originalPath || item.path
          const fileName =
            (item as any).smartName || item.name || filePath.split(/[\\/]/).pop() || ''
          const ext =
            (item as any).extension?.replace(/^\./, '') ||
            getExtFromSmartName(fileName) ||
            filePath.split('.').pop() ||
            ''
          const routeType = getPreviewRouteType(ext)
          if (routeType !== 'unsupported') {
            const targetCurrentTime =
              (item as any).currentTime ?? (item as any).matchedChunk?.startSec
            const targetHighlightRange =
              (item as any).highlightRange ??
              ((item as any).matchedChunk
                ? [(item as any).matchedChunk.startSec, (item as any).matchedChunk.endSec]
                : undefined)

            if (
              splitState.filePath !== filePath ||
              splitState.activePageId !== pageId ||
              splitState.currentTime !== targetCurrentTime
            ) {
              splitState.openPreview(filePath, fileName, ext, pageId, {
                currentTime: targetCurrentTime,
                highlightRange: targetHighlightRange
              })
            }
          } else if (splitState.activePageId === pageId && splitState.filePath) {
            splitState.clearPreview(pageId)
          }
        } else if (splitState.activePageId === pageId && splitState.filePath) {
          splitState.clearPreview(pageId)
        }
      }
    }
  }, [pageId, showPreviewPanel, activeItem])

  // 针对每页 & 每种视图模式单独保存卡片尺寸 (如: page_card_width_real-directory_grid)
  const pageCardWidthKey = pageId
    ? `page_card_width_${pageId}_${currentViewMode}`
    : `page_card_width_default_${currentViewMode}`

  const [gridCardWidth, setGridCardWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(pageCardWidthKey)
      if (saved) return Number(saved)
      // 若当前视图未单独配置过，搜索列表专属默认高度为 SEARCH_LIST_ROW_HEIGHT (104px)
      if (currentViewMode === 'search-list') return SEARCH_LIST_ROW_HEIGHT
      // 其它视图尝试使用通用的全局上一次配置
      const globalSaved = localStorage.getItem('file_explorer_grid_card_width')
      return globalSaved ? Number(globalSaved) : 120
    } catch (e) {
      return currentViewMode === 'search-list' ? SEARCH_LIST_ROW_HEIGHT : 120
    }
  })

  // 当切换视图模式或切换页面时，同步刷新读入该页面+该视图对应的卡片大小
  useEffect(() => {
    try {
      const saved = localStorage.getItem(pageCardWidthKey)
      if (saved) {
        setGridCardWidth(Number(saved))
      } else if (currentViewMode === 'search-list') {
        setGridCardWidth(SEARCH_LIST_ROW_HEIGHT)
      } else {
        const globalSaved = localStorage.getItem('file_explorer_grid_card_width')
        setGridCardWidth(globalSaved ? Number(globalSaved) : 120)
      }
    } catch (e) {
      // Ignore
    }
  }, [pageCardWidthKey, currentViewMode])

  const handleGridCardWidthChange = useCallback(
    (newWidth: number) => {
      setGridCardWidth(newWidth)
      try {
        localStorage.setItem(pageCardWidthKey, String(newWidth))
        if (currentViewMode !== 'search-list') {
          localStorage.setItem('file_explorer_grid_card_width', String(newWidth))
        }
      } catch (e) {
        // Ignore localStorage errors
      }
    },
    [pageCardWidthKey, currentViewMode]
  )

  const layoutContext: FileExplorerLayoutContext = useMemo(
    () => ({
      viewMode: currentViewMode,
      setViewMode: handleViewModeChange,
      gridCardWidth,
      setGridCardWidth: handleGridCardWidthChange,
      selectedFiles,
      activeItem,
      totalCount: displayFiles.length + directories.length,
      files: displayFiles,
      directories
    }),
    [
      currentViewMode,
      handleViewModeChange,
      gridCardWidth,
      handleGridCardWidthChange,
      selectedFiles,
      activeItem,
      displayFiles,
      directories
    ]
  )

  return (
    <div
      ref={containerRef}
      id={id}
      className={cn(
        // 列表内容区改用独立表面令牌：亮色为纯白卡片面（比灰面 Toolbar 更亮），暗色沿用原 --background
        'flex flex-col h-full w-full overflow-hidden select-none bg-[var(--surface-list)]',
        className
      )}
    >
      <SplitPane
        direction={projection.primaryDirection}
        rawKey={true}
        storageKey={getDirectionalStorageKey(targetPageId, 'primary', projection.primaryDirection)}
        sections={[
          {
            id: 'file-list-main',
            type: 'flex' as const,
            defaultSize: layoutDef.primaryDefaultSize ?? 2,
            minSize: projection.primaryDirection === 'horizontal' ? 360 : 200,
            content: (
              <div
                data-testid="file-list-main"
                className="flex-1 flex flex-col h-full min-w-0 overflow-hidden relative"
              >
                {/* 1. 工具栏插槽 (renderToolbar) - 仅限定在第一个区块 (FileList 关联宽度) */}
                {renderToolbar && (
                  <div className="flex-shrink-0 border-b border-border bg-card">
                    {renderToolbar(layoutContext)}
                  </div>
                )}

                {/* 文件列表区域 */}
                <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
                  {isLoading && displayFiles.length === 0 && directories.length === 0 ? (
                    <Loading
                      type={
                        currentViewMode === 'search-list' || pageId === PAGE_IDS.SEARCH_OVERLAY
                          ? 'search'
                          : 'file-list'
                      }
                      title={
                        currentViewMode === 'search-list' || pageId === PAGE_IDS.SEARCH_OVERLAY
                          ? t('正在搜索...')
                          : t('正在加载文件...')
                      }
                      description={
                        currentViewMode === 'search-list' || pageId === PAGE_IDS.SEARCH_OVERLAY
                          ? t('正在检索文件名、标签与深度多模态语义内容...')
                          : t('正在读取目录内容与文件元数据...')
                      }
                    />
                  ) : displayFiles.length === 0 &&
                    directories.length === 0 &&
                    (pageId === PAGE_IDS.ANALYZED_DIRECTORY ||
                      pageId === PAGE_IDS.VIRTUAL_DIRECTORY) ? (
                    <EmptyState
                      icon="manage_search"
                      title={t('在此维度中未找到文件')}
                      description={t('当前维度标签下暂无匹配文件，请选择其他维度分类。')}
                    />
                  ) : (
                    <FileList
                      files={displayFiles}
                      directories={directories}
                      loading={isLoading}
                      selectionEnabled={selectionEnabled}
                      selectedFiles={selectedFiles}
                      activeItem={activeItem}
                      viewMode={currentViewMode}
                      onFileSelect={handleFileSelect}
                      onFileDoubleClick={onFileDoubleClick}
                      onDirectoryChange={onDirectoryChange || (() => {})}
                      currentPath={currentPath || ''}
                      isRealDirectory={isRealDirectory}
                      workspaceDirectoryPath={workspaceDirectoryPath}
                      refreshKey={refreshKey}
                      onBack={onBack}
                      onForward={onForward}
                      onUp={onUp}
                      pageId={pageId}
                      gridCardWidth={gridCardWidth}
                      getSelectedFiles={externalGetSelectedFiles || getSelectedFiles}
                      hasMore={hasMore}
                      onLoadMore={onLoadMore}
                      sortBy={sortBy as any}
                      sortOrder={sortOrder}
                      disableClientSort={disableClientSort}
                      onSortChange={onSortChange}
                      showsmartName={showsmartName}
                      swapFileNameDisplay={swapFileNameDisplay}
                      gridShowFullFileName={gridShowFullFileName}
                      showAnalysisStatus={showAnalysisStatus}
                    />
                  )}
                </div>

                {/* 状态栏插槽 (renderFooter) */}
                {renderFooter && (
                  <div className="flex-shrink-0 border-t border-border bg-card text-xs text-muted-foreground">
                    {renderFooter(layoutContext)}
                  </div>
                )}
              </div>
            )
          },
          {
            id: 'companion',
            type: 'flex' as const,
            defaultSize: 1,
            collapsed: projection.collapsed.companion,
            collapsedSize: 0,
            content: (
              <SplitPane
                direction={projection.companionDirection}
                rawKey={true}
                storageKey={getDirectionalStorageKey(
                  targetPageId,
                  'companion',
                  projection.companionDirection
                )}
                sections={[
                  {
                    id: 'preview',
                    type: 'flex' as const,
                    defaultSize: 1,
                    minSize: projection.companionDirection === 'horizontal' ? 280 : 200,
                    collapsed: projection.collapsed.preview,
                    collapsedSize: 0,
                    content: projection.collapsed.preview ? null : (
                      <div
                        data-testid="file-preview-slot"
                        className="h-full w-full relative flex flex-col overflow-hidden"
                      >
                        <SplitPreviewPanel
                          pageId={targetPageId}
                          onClose={() => closePanel(targetPageId, PANEL_IDS.PREVIEW)}
                        />
                      </div>
                    )
                  },
                  {
                    id: 'details',
                    type: 'flex' as const,
                    defaultSize: 1,
                    minSize: projection.companionDirection === 'horizontal' ? 280 : 200,
                    collapsed: projection.collapsed.details,
                    collapsedSize: 0,
                    content: projection.collapsed.details ? null : (
                      <div
                        data-testid="file-details-slot"
                        className="h-full w-full relative flex flex-col overflow-hidden"
                      >
                        <FileDetailsPanel
                          item={activeItem || (selectedFiles.length > 0 ? selectedFiles[0] : undefined)}
                          workspaceDirectoryPath={workspaceDirectoryPath}
                          workspaceDirectoryType={workspaceDirectoryType}
                          currentDirectoryPath={isRealDirectory ? currentPath : workspaceDirectoryPath}
                          onClose={() => {
                            closePanel(targetPageId, PANEL_IDS.DETAILS)
                            onCloseDetailsPanel?.()
                          }}
                          onFileDeleted={onFileDeleted}
                          onFileUpdated={onFileUpdated}
                          showPreview={true}
                        />
                      </div>
                    )
                  }
                ]}
              />
            )
          }
        ]}
      />
    </div>
  )
}
