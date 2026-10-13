import React, { useState, useEffect, useRef, useCallback } from 'react'
import { FileItem, WorkspaceDirectory } from '@firefly/types'
import { FileExplorerLayout } from '../FileExplorerLayout'
import type { ViewMode } from '../FileExplorerLayout/types'
import { EmptyState } from '../../common/EmptyState'
import { PAGE_IDS } from '../../../constants/page-ids'
import { useSearchStore } from '../../../stores/search-store'
import { usePreviewOverlayStore } from '../../../stores/preview-overlay-store'
import { MaterialIcon, cn } from '../../../lib/utils'
import i18nScope, { t } from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import { logger, LogCategory } from '@firefly/shared'

interface GlobalSearchOverlayProps {
  workspaceDirectory: WorkspaceDirectory | null
}

export const GlobalSearchOverlay: React.FC<GlobalSearchOverlayProps> = ({
  workspaceDirectory
}) => {
  useVoerkaI18n(i18nScope)
  const globalSearchKeyword = useSearchStore(s => s.globalSearchKeyword)
  const clearGlobalSearch = useSearchStore(s => s.clearGlobalSearch)
  const isSearchActive = Boolean(globalSearchKeyword.trim())

  const [searchResults, setSearchResults] = useState<FileItem[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [activeItem, setActiveItem] = useState<FileItem | null>(null)
  const [selectedFiles, setSelectedFiles] = useState<FileItem[]>([])
  const [showDetailsPanel, setShowDetailsPanel] = useState(true)
  const [viewMode, setViewMode] = useState<ViewMode>('search-list')

  const searchSeqRef = useRef(0)
  const searchDebounceTimerRef = useRef<NodeJS.Timeout | null>(null)
  const previousActivePageIdRef = useRef<string | null>(null)

  // 1. 浮层激活与退出时的预览单例状态保护 (State Preservation)
  useEffect(() => {
    if (isSearchActive) {
      if (previousActivePageIdRef.current === null) {
        previousActivePageIdRef.current = usePreviewOverlayStore.getState().activePageId || ''
      }
    } else {
      // 1. 先清理属于搜索浮层的预览单例，防止下次打开浮层时串染
      usePreviewOverlayStore.getState().clearPreview(PAGE_IDS.SEARCH_OVERLAY)
      // 2. 浮层关闭：还原底层活跃页面的预览状态与文件上下文
      if (previousActivePageIdRef.current !== null) {
        const prevId = previousActivePageIdRef.current
        previousActivePageIdRef.current = null
        const prevPageFile = prevId
          ? usePreviewOverlayStore.getState().getPagePreviewFile(prevId)
          : null
        usePreviewOverlayStore.setState({
          activePageId: prevId,
          filePath: prevPageFile?.filePath || '',
          fileName: prevPageFile?.fileName || '',
          extension: prevPageFile?.extension || '',
          currentTime: prevPageFile?.currentTime,
          highlightRange: prevPageFile?.highlightRange
        })
      }
      setSearchResults([])
      setActiveItem(null)
      setSelectedFiles([])
      setIsLoading(false)
    }
  }, [isSearchActive])

  // 2. 搜索逻辑：防抖 + 竞态序号锁 + 全域跨目录检索
  useEffect(() => {
    if (searchDebounceTimerRef.current) {
      clearTimeout(searchDebounceTimerRef.current)
      searchDebounceTimerRef.current = null
    }

    const keyword = globalSearchKeyword.trim()
    if (!keyword) {
      searchSeqRef.current++
      setSearchResults([])
      setIsLoading(false)
      return
    }

    if (!workspaceDirectory?.path) {
      searchSeqRef.current++
      setSearchResults([])
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    const currentSeq = ++searchSeqRef.current

    searchDebounceTimerRef.current = setTimeout(async () => {
      try {
        const results = await window.electronAPI!.searchWorkspaceFiles(
          keyword,
          workspaceDirectory.path
        )

        // 仅最新一次请求允许写回 State，防止慢响应覆盖快响应
        if (currentSeq === searchSeqRef.current) {
          setSearchResults(results || [])
          useSearchStore.getState().addSearchHistory(keyword, 'global')
        }
      } catch (error) {
        logger.error(LogCategory.RENDERER, '全域工作空间搜索失败:', error)
        if (currentSeq === searchSeqRef.current) {
          setSearchResults([])
        }
      } finally {
        if (currentSeq === searchSeqRef.current) {
          setIsLoading(false)
        }
      }
    }, 250)

    return () => {
      searchSeqRef.current++
      if (searchDebounceTimerRef.current) {
        clearTimeout(searchDebounceTimerRef.current)
      }
    }
  }, [globalSearchKeyword, workspaceDirectory?.path])

  // 3. 键盘事件监听 (Escape 退出)
  useEffect(() => {
    if (!isSearchActive) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        clearGlobalSearch()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isSearchActive, clearGlobalSearch])

  const handleFileSelect = useCallback((filesOrItem: FileItem[] | FileItem | null) => {
    if (Array.isArray(filesOrItem)) {
      setSelectedFiles(filesOrItem)
      setActiveItem(filesOrItem.length === 1 ? filesOrItem[0] : null)
    } else if (filesOrItem) {
      setSelectedFiles([filesOrItem])
      setActiveItem(filesOrItem)
    } else {
      setSelectedFiles([])
      setActiveItem(null)
    }
  }, [])

  const handleFileDoubleClick = useCallback((file: FileItem) => {
    if (file?.path) {
      window.electronAPI?.utils?.openFileWithDefaultApp?.(file.path)
    }
  }, [])

  if (!isSearchActive) {
    return null
  }

  const keyword = globalSearchKeyword.trim()

  return (
    <div
      className={cn(
        'fixed inset-x-0 bottom-0 z-40 bg-background flex flex-col overflow-hidden',
        'animate-in fade-in duration-200'
      )}
      style={{ top: 'var(--app-header-height, 53px)' }}
    >
      {/* 顶部搜索状态与操作引导条 */}
      <div className="flex-shrink-0 h-9 px-4 flex items-center justify-between border-b border-border/60 bg-muted/30 dark:bg-muted/20 text-xs">
        <div className="flex items-center gap-2 min-w-0">
          <MaterialIcon icon="search" className="text-primary text-base flex-shrink-0" />
          <span className="text-muted-foreground whitespace-nowrap">
            {t('全域搜索结果:')}
          </span>
          <span className="font-semibold text-foreground truncate max-w-[240px]">
            "{keyword}"
          </span>
          <span className="text-muted-foreground/80 text-[11px] whitespace-nowrap">
            {t('（共 {count} 项，包含未分析与已分析文件）', { count: searchResults.length })}
          </span>
          {searchResults.length >= 500 && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 whitespace-nowrap">
              {t('已展示前 500 项')}
            </span>
          )}
        </div>

        <button
          onClick={() => clearGlobalSearch()}
          className="flex items-center gap-1 px-2 py-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent/70 transition-colors cursor-pointer select-none"
          title={t('退出全域搜索 (ESC)')}
        >
          <MaterialIcon icon="close" className="text-sm" />
          <span className="text-xs">{t('退出搜索 (ESC)')}</span>
        </button>
      </div>

      {/* 核心三栏同构布局: FileList | SplitPreviewPanel | FileDetailsPanel，未选择工作空间时渲染 EmptyState */}
      <div className="flex-1 overflow-hidden relative">
        {!workspaceDirectory?.path ? (
          <EmptyState
            icon="folder_off"
            title={t('未选择工作目录')}
            description={t('请先在顶部导航栏选择有效的工作目录，即可开始全域混合搜索')}
          />
        ) : (
          <FileExplorerLayout
            files={searchResults}
            directories={[]}
            selectedFiles={selectedFiles}
            activeItem={activeItem}
            onFileSelect={handleFileSelect}
            onFileDoubleClick={handleFileDoubleClick}
            viewMode={viewMode}
            onViewModeChange={setViewMode}
            showPreviewPanel={true}
            showDetailsPanel={showDetailsPanel}
            onCloseDetailsPanel={() => setShowDetailsPanel(false)}
            pageId={PAGE_IDS.SEARCH_OVERLAY}
            isRealDirectory={true}
            showsmartName={true}
            showAnalysisStatus={true}
            isLoading={isLoading}
            workspaceDirectoryPath={workspaceDirectory?.path}
            workspaceDirectoryType={workspaceDirectory?.type}
            renderFooter={layoutContext => (
              <div className="px-4 py-1.5 flex items-center text-xs text-muted-foreground shrink-0 border-t border-border/40 min-h-[32px]">
                <MaterialIcon icon="insert_drive_file" className="mr-1.5 text-sm" />
                <span>
                  {t('匹配文件: {count} 个', { count: layoutContext.files.length })}
                </span>
                {selectedFiles.length > 0 && (
                  <>
                    <span className="mx-2 text-border">|</span>
                    <span className="text-primary font-medium">
                      {t('已选 {count} 项', { count: selectedFiles.length })}
                    </span>
                  </>
                )}
                {layoutContext.files.length >= 500 && (
                  <>
                    <span className="mx-2 text-border">|</span>
                    <span className="text-muted-foreground/70 text-[11px]">
                      {t('提示: 结果已达到最大单次展示上限（500项）')}
                    </span>
                  </>
                )}
              </div>
            )}
          />
        )}
      </div>
    </div>
  )
}
