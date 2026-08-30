import React, { useState, useMemo, useCallback, useEffect } from 'react'
import { FileItem, DirectoryItem } from '@firefly/types'
import { FileList } from '../FileList'
import { FileDetailsPanel } from '../FileDetailsPanel'
import { FilePreviewPanel } from '../FilePreviewPanel'
import { SplitPreviewPanel } from '../SplitPreviewPanel'
import { SplitPane } from '../../common/SplitPane'
import { EmptyState } from '../../common/EmptyState'
import { PAGE_IDS } from '../../../constants/page-ids'
import { t } from '@app/languages'
import { useSettingsStore } from '../../../stores/settings-store'
import { usePreviewOverlayStore } from '../../../stores/preview-overlay-store'
import { getPreviewRouteType, getExtFromSmartName } from '../../../lib/preview-utils'
import { FileExplorerLayoutProps, ViewMode, FileExplorerLayoutContext } from './types'
import { cn } from '../../../lib/utils'

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
  selectedFileIds = [],
  activeItem: externalActiveItem = null,
  pageId,
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
  const getConfigValue = useSettingsStore(state => state.getConfigValue)
  const showMissingFiles = getConfigValue<boolean>('SHOW_MISSING_FILES') ?? true
  const swapFileNameDisplay =
    propSwapFileNameDisplay ?? getConfigValue<boolean>('SWAP_FILE_NAME_DISPLAY') ?? false
  const gridShowFullFileName = getConfigValue<boolean>('GRID_SHOW_FULL_FILE_NAME') ?? false

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
  const [selectedIds, setSelectedIds] = useState<string[]>(selectedFileIds)

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

  const resolveIds = useCallback((items: any[]): string[] => {
    if (!Array.isArray(items)) return []
    return items
      .map(item => (typeof item === 'string' ? item : item?.path || item?.id))
      .filter(Boolean)
  }, [])

  useEffect(() => {
    if (selectedFileIds !== undefined) {
      const incomingIds = resolveIds(selectedFileIds)
      const isDifferent =
        incomingIds.length !== selectedIds.length ||
        incomingIds.some((id, idx) => id !== selectedIds[idx])
      if (isDifferent) {
        setSelectedIds(incomingIds)
      }
    }
  }, [selectedFileIds, resolveIds])

  // 优先级：优先使用外部传入的 activeItem，若无则使用内部选中的 activeItem
  const activeItem = externalActiveItem || internalActiveItem

  // 受控模式下，外部 activeItem 是权威来源：其变化时同步内部 active 状态，
  // 确保取消选择（externalActiveItem 置空）时清除残留的内部高亮背景
  useEffect(() => {
    setInternalActiveItem(externalActiveItem || null)
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
        const isAlreadySelected = selectedIds.some(id => id === clickedId)

        if (isAlreadySelected) {
          setSelectedIds([])
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

      if (selectedList.length > 0) {
        const lastItem = selectedList[selectedList.length - 1]
        setInternalActiveItem(typeof lastItem === 'object' ? lastItem : null)
      } else {
        setInternalActiveItem(null)
      }

      const nextIds = resolveIds(selectedList)
      setSelectedIds(nextIds)

      if (onSelectionChange) {
        const idSet = new Set(nextIds)
        onSelectionChange(files.filter(f => idSet.has(f.id) || idSet.has(f.path)))
      }

      if (externalOnFileSelect) {
        externalOnFileSelect(filesOrItem, isFromCheckbox)
      }
    },
    [externalOnFileSelect, onSelectionChange, files, resolveIds, selectedIds]
  )

  const getSelectedFiles = useCallback((): FileItem[] => {
    if (!selectedIds.length) return []
    const idSet = new Set(selectedIds)
    const matchedFiles = files.filter(f => idSet.has(f.id) || idSet.has(f.path))
    const matchedDirs = directories.filter(d => d.path && idSet.has(d.path))
    return [...matchedDirs, ...matchedFiles] as FileItem[]
  }, [files, directories, selectedIds])

  const selectedFiles = useMemo(() => getSelectedFiles(), [getSelectedFiles])

  const currentFile = useMemo(() => {
    const item = activeItem || (selectedFiles.length > 0 ? selectedFiles[0] : null)
    if (item && !('isDirectory' in item && item.isDirectory)) {
      return item as FileItem
    }
    return null
  }, [activeItem, selectedFiles])

  useEffect(() => {
    if (pageId && showPreviewPanel) {
      const splitState = usePreviewOverlayStore.getState()
      const pageMode = splitState.pageStates[pageId]?.mode ?? 'split'
      if (pageMode === 'split') {
        const item = activeItem || (selectedFiles.length > 0 ? selectedFiles[0] : null)
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
            if (splitState.filePath !== filePath || splitState.activePageId !== pageId) {
              splitState.openPreview(filePath, fileName, ext, pageId)
            }
          } else if (splitState.activePageId === pageId && splitState.filePath) {
            splitState.clearPreview(pageId)
          }
        } else if (splitState.activePageId === pageId && splitState.filePath) {
          splitState.clearPreview(pageId)
        }
      }
    }
  }, [pageId, showPreviewPanel, activeItem, selectedFiles])

  // 针对每页 & 每种视图模式单独保存卡片尺寸 (如: page_card_width_real-directory_grid)
  const pageCardWidthKey = pageId
    ? `page_card_width_${pageId}_${currentViewMode}`
    : `page_card_width_default_${currentViewMode}`

  const [gridCardWidth, setGridCardWidth] = useState<number>(() => {
    try {
      const saved = localStorage.getItem(pageCardWidthKey)
      if (saved) return Number(saved)
      // 若当前视图未单独配置过，则尝试使用通用的全局上一次配置
      const globalSaved = localStorage.getItem('file_explorer_grid_card_width')
      return globalSaved ? Number(globalSaved) : 120
    } catch (e) {
      return 120
    }
  })

  // 当切换视图模式或切换页面时，同步刷新读入该页面+该视图对应的卡片大小
  useEffect(() => {
    try {
      const saved = localStorage.getItem(pageCardWidthKey)
      if (saved) {
        setGridCardWidth(Number(saved))
      }
    } catch (e) {
      // Ignore
    }
  }, [pageCardWidthKey])

  const handleGridCardWidthChange = useCallback(
    (newWidth: number) => {
      setGridCardWidth(newWidth)
      try {
        localStorage.setItem(pageCardWidthKey, String(newWidth))
        localStorage.setItem('file_explorer_grid_card_width', String(newWidth))
      } catch (e) {
        // Ignore localStorage errors
      }
    },
    [pageCardWidthKey]
  )

  const layoutContext: FileExplorerLayoutContext = useMemo(
    () => ({
      viewMode: currentViewMode,
      setViewMode: handleViewModeChange,
      gridCardWidth,
      setGridCardWidth: handleGridCardWidthChange,
      selectedFiles,
      activeItem,
      totalCount: files.length + directories.length
    }),
    [
      currentViewMode,
      handleViewModeChange,
      gridCardWidth,
      handleGridCardWidthChange,
      selectedFiles,
      activeItem,
      files.length,
      directories.length
    ]
  )

  return (
    <div
      id={id}
      className={cn(
        'flex flex-col h-full w-full overflow-hidden select-none bg-background',
        className
      )}
    >
      <SplitPane
        direction="horizontal"
        storageKey={
          id ? `file-explorer-${id}` : pageId ? `file-explorer-${pageId}` : 'file-explorer-layout'
        }
        sections={[
          {
            id: 'file-list-main',
            type: 'flex' as const,
            defaultSize: 2,
            minSize: 100,
            content: (
              <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden relative">
                {/* 1. 工具栏插槽 (renderToolbar) - 仅限定在第一个区块 (FileList 关联宽度) */}
                {renderToolbar && (
                  <div className="flex-shrink-0 border-b border-border bg-card">
                    {renderToolbar(layoutContext)}
                  </div>
                )}

                {/* 文件列表区域 */}
                <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden">
                  {isLoading && displayFiles.length === 0 && directories.length === 0 ? (
                    <EmptyState isLoading={true} title={t('加载文件中...')} />
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
          ...(showPreviewPanel
            ? [
                {
                  id: 'preview',
                  type: 'flex' as const,
                  defaultSize: 1,
                  minSize: 300,
                  content: pageId ? (
                    <SplitPreviewPanel pageId={pageId} />
                  ) : currentFile ? (
                    <FilePreviewPanel
                      filePath={currentFile.path}
                      fileName={currentFile.smartName || currentFile.name}
                      extension={currentFile.extension}
                      onBack={() => setInternalActiveItem(null)}
                    />
                  ) : (
                    <div className="h-full border-l border-border bg-card" />
                  )
                }
              ]
            : []),
          ...(showDetailsPanel
            ? [
                {
                  id: 'details',
                  type: 'pixel' as const,
                  defaultSize: 380,
                  minSize: 100,
                  content: (
                    <FileDetailsPanel
                      item={activeItem || (selectedFiles.length > 0 ? selectedFiles[0] : undefined)}
                      workspaceDirectoryPath={workspaceDirectoryPath}
                      workspaceDirectoryType={workspaceDirectoryType}
                      currentDirectoryPath={isRealDirectory ? currentPath : workspaceDirectoryPath}
                      onClose={() => {
                        setInternalActiveItem(null)
                        if (onCloseDetailsPanel) {
                          onCloseDetailsPanel()
                        }
                      }}
                      onFileDeleted={onFileDeleted}
                      onFileUpdated={onFileUpdated}
                      showPreview={true}
                    />
                  )
                }
              ]
            : [])
        ]}
      />
    </div>
  )
}
