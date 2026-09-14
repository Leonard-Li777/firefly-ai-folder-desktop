import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { SelectedTag, FileItem as FileType, UnionMode } from '@firefly/types'
import { FileList } from './FileList'
import { SearchBar } from '../common/SearchBar'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { MaterialIcon, cn } from '../../lib/utils'
import { t } from '@app/languages'
import { FileExplorerLayout } from './FileExplorerLayout'
import { PageId, PAGE_IDS } from '../../constants/page-ids'
import { EmptyState } from '../common/EmptyState'
import { CardSizePopover } from '../common/CardSizePopover'
import { MiniViewDisplaySettingsPopover } from '../common/MiniViewDisplaySettingsPopover'
import { LogCategory, logger } from '@firefly/shared'
import { toast } from '../common/Toast'
import { useConfigStore } from '../../stores/config-store'

interface DimensionFileListPanelProps {
  // Data source config
  workspaceDirectoryPath?: string
  virtualDirectoryId?: number

  // Selected tags & callbacks
  selectedTags: SelectedTag[]
  isMultiSelectMode: boolean
  removeSelectedTag: (dimensionId: number, tagValue?: string, parentTagValue?: string) => void
  toggleTagSelection: (dimensionId: number, tagValue: string, parentTagValue?: string) => void
  clearSelectedTags: () => void

  // File selection & active preview item callbacks
  activeItem: any | null
  setActiveItem: (item: any | null) => void
  selectedFiles: any[]
  setSelectedFiles: (files: any[]) => void

  // Optional: show organize button (only in AnalyzedDirectory)
  showOrganizeButton?: boolean
  onStartOrganize?: () => void
  isOrganizeMode?: boolean
  onOrganizeSelected?: () => void

  // 刷新触发器：当父级检测到新的分析完成时递增，触发文件列表重新加载
  refreshKey?: number

  // 当前路由路径，用于 keepalive 场景下检测页面重新可见
  currentPath?: string

  // 标签筛选模式：并集或交集
  unionMode?: UnionMode

  // FileExplorerLayout 三分栏相关属性
  showDetailsPanel?: boolean
  showPreviewPanel?: boolean
  onCloseDetailsPanel?: () => void
  onFileDeleted?: () => void
  onFileUpdated?: () => void
  workspaceDirectoryType?: 'SPEEDY' | 'PRIVATE'
  pageId?: PageId
}

const PAGE_SIZE = 100

export const DimensionFileListPanel: React.FC<DimensionFileListPanelProps> = ({
  workspaceDirectoryPath,
  virtualDirectoryId,
  selectedTags,
  isMultiSelectMode,
  removeSelectedTag,
  toggleTagSelection,
  clearSelectedTags,
  activeItem,
  setActiveItem,
  selectedFiles,
  setSelectedFiles,
  showOrganizeButton = false,
  onStartOrganize,
  isOrganizeMode = false,
  onOrganizeSelected,
  refreshKey = 0,
  currentPath,
  unionMode = 'union',
  showDetailsPanel = true,
  showPreviewPanel = false,
  onCloseDetailsPanel,
  onFileDeleted,
  onFileUpdated,
  workspaceDirectoryType,
  pageId = PAGE_IDS.ANALYZED_DIRECTORY
}) => {
  const [filteredFiles, setFilteredFiles] = useState<FileType[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)
  const [searchKeyword, setSearchKeyword] = useState('')
  const [sortBy, setSortBy] = useState<'name' | 'size' | 'modified' | 'qualityScore'>('modified')
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')
  const [totalFilesCount, setTotalFilesCount] = useState(0)
  const [viewMode, setViewMode] = useState<'list' | 'grid' | 'waterfall'>('grid')

  const loadingRef = useRef(false)
  const filteredFilesRef = useRef<FileType[]>([])
  filteredFilesRef.current = filteredFiles

  const updateConfigValue = useConfigStore(state => state.updateConfigValue)
  const config = useConfigStore(state => state.config)

  useEffect(() => {
    if (config?.DEFAULT_VIEW) {
      setViewMode(config.DEFAULT_VIEW as any)
    }
  }, [config?.DEFAULT_VIEW])

  const loadFilteredFiles = useCallback(
    async (isLoadMore = false) => {
      if (loadingRef.current) return
      loadingRef.current = true

      try {
        const currentCount = filteredFilesRef.current.length
        if (isLoadMore) {
          setIsLoadingMore(true)
        } else {
          setIsLoading(true)
        }

        const currentOffset = isLoadMore ? currentCount : 0

        const result = await window.electronAPI!.analyzedDirectory.getFilteredFilesPaged({
          selectedTags,
          sortBy: sortBy === 'modified' ? 'modifiedAt' : sortBy,
          sortOrder,
          workspaceDirectoryPath,
          virtualDirectoryId,
          searchKeyword,
          limit: PAGE_SIZE,
          offset: currentOffset,
          unionMode
        })

        if (isLoadMore) {
          setFilteredFiles(prev => [...prev, ...(result.items || [])])
        } else {
          setFilteredFiles(result.items || [])
        }
        setTotalFilesCount(result.total || 0)
      } catch (error) {
        logger.error(LogCategory.VIRTUAL_DIRECTORY, '加载已过滤文件失败:', error)
      } finally {
        loadingRef.current = false
        setIsLoading(false)
        setIsLoadingMore(false)
      }
    },
    [
      selectedTags,
      sortBy,
      sortOrder,
      workspaceDirectoryPath,
      virtualDirectoryId,
      searchKeyword,
      unionMode
    ]
  )

  useEffect(() => {
    if (
      !currentPath ||
      currentPath === '/analyzed-directory' ||
      currentPath === '/virtual-directory' ||
      currentPath === '/organize'
    ) {
      loadFilteredFiles(false)
    }
  }, [
    selectedTags,
    sortBy,
    sortOrder,
    workspaceDirectoryPath,
    virtualDirectoryId,
    searchKeyword,
    refreshKey,
    currentPath,
    unionMode,
    loadFilteredFiles
  ])

  useEffect(() => {
    if (
      !currentPath ||
      currentPath === '/analyzed-directory' ||
      currentPath === '/virtual-directory' ||
      currentPath === '/organize'
    ) {
      loadFilteredFiles(false)
    }
  }, [currentPath, loadFilteredFiles])

  // 监听全局标签/智能文件名/文件变动事件，自动刷新列表
  useEffect(() => {
    const handleGlobalUpdate = () => {
      loadFilteredFiles(false)
    }
    window.addEventListener('tags-updated', handleGlobalUpdate)
    window.addEventListener('tags:updated', handleGlobalUpdate)
    window.addEventListener('smartname-updated', handleGlobalUpdate)
    window.addEventListener('files-updated', handleGlobalUpdate)
    return () => {
      window.removeEventListener('tags-updated', handleGlobalUpdate)
      window.removeEventListener('tags:updated', handleGlobalUpdate)
      window.removeEventListener('smartname-updated', handleGlobalUpdate)
      window.removeEventListener('files-updated', handleGlobalUpdate)
    }
  }, [loadFilteredFiles])

  const handleLoadMore = useCallback(() => {
    if (!loadingRef.current && filteredFilesRef.current.length < totalFilesCount) {
      loadFilteredFiles(true)
    }
  }, [totalFilesCount, loadFilteredFiles])

  const handleSortChange = useCallback((newSortBy: string, newSortOrder: 'asc' | 'desc') => {
    setSortBy(newSortBy === 'modified' ? 'modified' : (newSortBy as any))
    setSortOrder(newSortOrder)
  }, [])

  const lastSelectedItemRef = useRef<any>(null)

  const handleFileSelect = useCallback(
    (newSelection: any[], isFromCheckbox = false) => {
      const normalize =
        window.electronAPI?.utils?.normalizeForCache ||
        ((p: string) => p.toLowerCase().replace(/[\\/]+$/, ''))

      // 建立 O(1) 查找 Map，避免 O(N^2) 嵌套查找
      const fileMap = new Map<string, FileType>()
      filteredFiles.forEach(f => {
        if (f?.path) fileMap.set(normalize(f.path), f)
      })

      if (isFromCheckbox) {
        // 当前页数据查找表（用于把路径/字符串还原为完整文件对象）
        const pageMap = new Map<string, FileType>()
        filteredFiles.forEach(f => {
          if (f?.path) pageMap.set(normalize(f.path), f)
        })
        // 全量选中项查找表：勾选事件只携带当前页受影响项，需与既有多页选中项合并而非整体覆盖
        const selectedMap = new Map<string, FileType>()
        selectedFiles.forEach(f => {
          const p = typeof f === 'string' ? f : f?.path
          if (p) selectedMap.set(normalize(p), f as FileType)
        })

        const resolvedSelection: FileType[] = []
        for (const item of newSelection) {
          if (item && typeof item === 'object' && 'path' in item) {
            resolvedSelection.push(item as FileType)
            continue
          }
          const pathStr = typeof item === 'string' ? item : item?.path
          if (!pathStr) continue
          const found = fileMap.get(normalize(pathStr)) || pageMap.get(normalize(pathStr))
          if (found) resolvedSelection.push(found)
        }

        // 以「当前页最新勾选结果」为基准，合并保留其它页已选中的文件
        const resolvedPaths = new Set(resolvedSelection.map(f => normalize(f?.path)))
        const pagePaths = new Set(filteredFiles.map(f => normalize(f?.path)))
        const mergedSelection = [...resolvedSelection]
        selectedMap.forEach((file, key) => {
          if (!pagePaths.has(key) && !resolvedPaths.has(key)) {
            mergedSelection.push(file)
          }
        })

        setSelectedFiles(mergedSelection)
        // 多选/全选时不强行修改 activeItem 触发单文件深度预览
        if (newSelection.length === 1) {
          const single = mergedSelection.find(f => resolvedPaths.has(normalize(f?.path)))
          lastSelectedItemRef.current = single || mergedSelection[0]
          setActiveItem(single || mergedSelection[0])
        } else if (newSelection.length === 0) {
          lastSelectedItemRef.current = null
          setActiveItem(null)
        }
      } else if (newSelection.length > 0) {
        const first = newSelection[0]
        const pathStr = typeof first === 'string' ? first : first?.path
        const found =
          first && typeof first === 'object' && 'path' in first
            ? (first as FileType)
            : pathStr
              ? fileMap.get(normalize(pathStr))
              : undefined
        if (found) {
          const { isPathEqual } = window.electronAPI!.utils
          if (
            lastSelectedItemRef.current &&
            isPathEqual(lastSelectedItemRef.current.path, found.path)
          ) {
            setSelectedFiles([])
            setActiveItem(null)
            lastSelectedItemRef.current = null
          } else {
            setSelectedFiles([found])
            setActiveItem(found)
            lastSelectedItemRef.current = found
          }
        }
      } else {
        setSelectedFiles([])
        setActiveItem(null)
        lastSelectedItemRef.current = null
      }
    },
    [filteredFiles, setSelectedFiles, setActiveItem]
  )

  const getSelectedFiles = useCallback(() => selectedFiles, [selectedFiles])

  /** 统一路径归一化：Windows 大小写不敏感 + 去除尾部斜杠，保证选中态匹配口径一致 */
  const normalizePathForCompare = useCallback((p?: string | null) => {
    if (!p) return ''
    const normalize =
      window.electronAPI?.utils?.normalizeForCache ||
      ((v: string) => v.toLowerCase().replace(/[\\/]+$/, ''))
    return normalize(p)
  }, [])

  /** 已选中文件的路径集合（用于列表渲染层判断勾选态，避免与分页子集口径不一致） */
  const selectedPathsSet = useMemo(() => {
    const set = new Set<string>()
    for (const f of selectedFiles) {
      const p = typeof f === 'string' ? f : f?.path
      const normalized = normalizePathForCompare(p)
      if (normalized) set.add(normalized)
    }
    return set
  }, [selectedFiles, normalizePathForCompare])

  // 全选状态判断：仅以「当前已加载页」为基准判定，与复选框实际可见范围保持一致
  const isAllVisibleItemsSelected = useMemo(() => {
    if (filteredFiles.length === 0) return false
    return filteredFiles.every(f => f?.path && selectedPathsSet.has(normalizePathForCompare(f.path)))
  }, [filteredFiles, selectedPathsSet, normalizePathForCompare])

  /**
   * 分页状态：供底部状态栏展示「第几页 / 共几页」。
   *
   * 背景：列表采用虚拟滚动 + 分页加载，全文「全选」只作用于已加载的页，
   * 而 footer 原先只显示文件总数，导致用户误以为已全选全部文件。
   * 同时展示总页数与当前页，让「全选的实际覆盖范围」一目了然。
   */
  const paginationInfo = useMemo(() => {
    const totalPages = Math.max(1, Math.ceil(totalFilesCount / PAGE_SIZE))
    const loadedPages = Math.max(0, Math.ceil(filteredFiles.length / PAGE_SIZE))
    // 已加载页数不应超过总页数（加载过程中的瞬时状态可能略大）
    const currentPage = Math.min(Math.max(1, loadedPages), totalPages)
    return {
      totalPages,
      currentPage,
      /** 是否仍有未加载的数据（决定是否提示「已加载 x / 共 y」） */
      hasUnloaded: filteredFiles.length < totalFilesCount
    }
  }, [totalFilesCount, filteredFiles.length])

  /**
   * 全选/取消全选（作用于当前已加载页）
   * - 取消：从全量选中项中剔除当前页文件，保留其它页已选中的文件
   * - 全选：将当前页文件并入全量选中项，避免覆盖掉其它页已选中的文件
   */
  const handleToggleSelectAll = useCallback(() => {
    if (isAllVisibleItemsSelected) {
      const pagePaths = new Set(filteredFiles.map(f => normalizePathForCompare(f?.path)))
      setSelectedFiles(
        selectedFiles.filter(
          f => !pagePaths.has(normalizePathForCompare(typeof f === 'string' ? f : f?.path))
        )
      )
    } else {
      const merged = [...selectedFiles]
      const existing = new Set(
        selectedFiles.map(f => normalizePathForCompare(typeof f === 'string' ? f : f?.path))
      )
      for (const f of filteredFiles) {
        const normalized = normalizePathForCompare(f?.path)
        if (normalized && !existing.has(normalized)) {
          merged.push(f)
          existing.add(normalized)
        }
      }
      setSelectedFiles(merged)
    }
  }, [
    isAllVisibleItemsSelected,
    filteredFiles,
    selectedFiles,
    setSelectedFiles,
    normalizePathForCompare
  ])

  return (
    <div className="flex-1 h-full relative overflow-hidden flex flex-col bg-background">
      <FileExplorerLayout
        files={filteredFiles}
        directories={[]}
        isLoading={isLoading}
        selectionEnabled={isOrganizeMode}
        viewMode={viewMode}
        onViewModeChange={async newMode => {
          setViewMode(newMode as any)
          await updateConfigValue('DEFAULT_VIEW', newMode)
        }}
        selectedFiles={selectedFiles}
        activeItem={activeItem}
        onFileSelect={(filesOrItem, isFromCheckbox) =>
          handleFileSelect(Array.isArray(filesOrItem) ? filesOrItem : [filesOrItem], isFromCheckbox)
        }
        getSelectedFiles={getSelectedFiles}
        hasMore={filteredFiles.length < totalFilesCount}
        onLoadMore={handleLoadMore}
        sortBy={sortBy === 'modified' ? 'modified' : sortBy}
        sortOrder={sortOrder}
        disableClientSort={true}
        onSortChange={handleSortChange}
        showsmartName={true}
        showAnalysisStatus={false}
        showDetailsPanel={showDetailsPanel}
        showPreviewPanel={showPreviewPanel}
        onCloseDetailsPanel={onCloseDetailsPanel}
        onFileDeleted={onFileDeleted}
        onFileUpdated={onFileUpdated}
        workspaceDirectoryPath={workspaceDirectoryPath}
        workspaceDirectoryType={workspaceDirectoryType}
        currentPath={currentPath}
        pageId={pageId}
        refreshKey={refreshKey}
        renderToolbar={layoutContext => (
          <div className="px-3 py-1.5 border-b border-border bg-card flex items-center flex-wrap gap-y-1.5 flex-shrink-0 min-h-[44px]">
            <div className="flex items-center space-x-2 text-foreground font-semibold text-sm min-w-[180px] overflow-hidden mr-2">
              <div
                className={cn(
                  'flex items-center space-x-2 overflow-x-auto custom-scrollbar-hide pb-0.5'
                )}
              >
                {!isMultiSelectMode ? (
                  selectedTags.length === 0 ? (
                    <span className="text-muted-foreground">{t('所有已分析文件')}</span>
                  ) : (
                    <span className="bg-primary/10 border border-primary rounded-2xl px-2 py-0.5 flex items-center flex-shrink-0 text-primary font-medium text-xs">
                      {selectedTags[0].tagValue}
                      <button
                        className="ml-2 hover:bg-primary/20 rounded-full p-0.5 cursor-pointer"
                        onClick={() =>
                          removeSelectedTag(
                            selectedTags[0].dimensionId,
                            selectedTags[0].tagValue,
                            selectedTags[0].parentTagValue
                          )
                        }
                      >
                        <MaterialIcon icon="close" className="text-xs" />
                      </button>
                    </span>
                  )
                ) : selectedTags.length === 0 ? (
                  <span className="text-muted-foreground italic flex items-center text-xs">
                    <MaterialIcon icon="drag_indicator" className="text-xs mr-1 animate-pulse" />
                    {t('请在左侧勾选标签...')}
                  </span>
                ) : (
                  <div className="flex items-center space-x-1.5 overflow-x-auto no-scrollbar">
                    {selectedTags.slice(0, 15).map(tag => (
                      <span
                        key={`${tag.dimensionId}::${tag.parentTagValue || ''}::${tag.tagValue}`}
                        className="bg-primary/10 border border-primary/30 rounded-md px-2 py-0.5 flex items-center flex-shrink-0 text-primary text-xs font-medium"
                      >
                        <span className="text-[10px] opacity-60 mr-1">{tag.dimensionName}:</span>
                        {tag.tagValue}
                        <button
                          className="ml-1.5 opacity-40 hover:opacity-100 cursor-pointer"
                          onClick={() =>
                            toggleTagSelection(tag.dimensionId, tag.tagValue, tag.parentTagValue)
                          }
                        >
                          <MaterialIcon icon="close" className="text-[12px]" />
                        </button>
                      </span>
                    ))}
                    {selectedTags.length > 15 && (
                      <span className="bg-primary/15 text-primary text-xs font-bold px-2 py-0.5 rounded-md flex-shrink-0">
                        +{selectedTags.length - 15}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div className="flex items-center space-x-2 text-foreground ml-auto flex-shrink-0">
              <div className="flex-shrink-0 relative z-10 h-8 flex items-center mr-1">
                <SearchBar
                  type="virtual-directory"
                  placeholder={t('搜索...')}
                  onSearch={kw => {
                    if (selectedTags.length > 0) clearSelectedTags()
                    setSearchKeyword(kw)
                  }}
                  className="w-30 focus-within:w-60 transition-all duration-300"
                />
              </div>
              {/* 视图模式与显示设置 Mini 下拉弹窗 */}
              <MiniViewDisplaySettingsPopover
                viewMode={layoutContext.viewMode}
                onViewModeChange={layoutContext.setViewMode}
                gridCardWidth={layoutContext.gridCardWidth}
                onGridCardWidthChange={layoutContext.setGridCardWidth}
              />

              {isOrganizeMode ? (
                <>
                  <label className="flex items-center gap-2 px-2 py-1 rounded hover:bg-accent/20 cursor-pointer transition-colors">
                    <Checkbox
                      checked={isAllVisibleItemsSelected}
                      onCheckedChange={handleToggleSelectAll}
                    />
                    <span className="text-sm font-medium select-none">{t('全选')}</span>
                  </label>
                  <Button
                    variant="default"
                    size="sm"
                    className="ml-2 cursor-pointer text-xs h-8 gap-1 font-bold shadow-xs"
                    onClick={onOrganizeSelected}
                  >
                    <MaterialIcon icon="auto_fix_normal" className="text-sm" />
                    <span>
                      {selectedFiles.length > 0
                        ? t('批量整理 ({count})', { count: selectedFiles.length })
                        : t('批量整理')}
                    </span>
                  </Button>
                </>
              ) : (
                showOrganizeButton &&
                onStartOrganize && (
                  <Button
                    variant="default"
                    size="sm"
                    className="ml-2 cursor-pointer gap-1"
                    onClick={onStartOrganize}
                  >
                    <MaterialIcon icon="auto_fix_high" className="text-sm mr-0.5" />
                    {t('批量整理')}
                  </Button>
                )
              )}
            </div>
          </div>
        )}
        renderFooter={() => (
          <div className="px-4 py-1.5 flex items-center text-xs text-muted-foreground shrink-0 border-t border-border/40 min-h-[32px] gap-x-3">
            <span className="flex items-center">
              <MaterialIcon icon="insert_drive_file" className="mr-1.5 text-sm" />
              {/* 已加载数 / 总数：虚拟滚动下「全选」只作用于已加载页，
                  必须让总数与已加载数同时可见，否则用户会误以为全选了全部文件 */}
              {paginationInfo.hasUnloaded
                ? t('已加载 {loaded} / 共 {total} 个文件', {
                    loaded: filteredFiles.length,
                    total: totalFilesCount
                  })
                : t('{count} 个文件', { count: totalFilesCount })}
            </span>

            {/* 当前页数：明确「全选」实际覆盖的范围 */}
            {totalFilesCount > PAGE_SIZE && (
              <span className="flex items-center">
                <MaterialIcon icon="description" className="mr-1.5 text-sm" />
                <span className="font-mono">
                  {t('第 {current} / {total} 页', {
                    current: paginationInfo.currentPage,
                    total: paginationInfo.totalPages
                  })}
                </span>
              </span>
            )}

            {/* 已选中数量：仅在勾选能力开启且确有选中项时展示，避免长期占用底部空间。
                勾选能力与 FileExplorerLayout 的 selectionEnabled 保持一致
                （多选模式与整理模式均需开启复选框列） */}
            {(isOrganizeMode || isMultiSelectMode) && selectedFiles.length > 0 && (
              <span className="flex items-center text-primary font-medium">
                <MaterialIcon icon="check_circle" className="mr-1.5 text-sm" />
                {t('已选中 {count} 个文件', { count: selectedFiles.length })}
              </span>
            )}

            {isLoadingMore && (
              <span className="inline-block animate-spin rounded-full h-3 w-3 border-t-2 border-primary"></span>
            )}
          </div>
        )}
      />
    </div>
  )
}
