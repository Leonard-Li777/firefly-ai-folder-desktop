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
import { SEARCH_LIST_ROW_HEIGHT } from '../FileList/components/SearchListCard'
import { MiniViewDisplaySettingsPopover } from '../../common/MiniViewDisplaySettingsPopover'

interface GlobalSearchOverlayProps {
  workspaceDirectory: WorkspaceDirectory | null
}

/**
 * 工单 13：冷态视觉模型加载提示的最长展示时间。
 * 与 desktop 侧 `CLIP_TEXT_TIMEOUT_COLD_MS`（6000ms）对齐 —— 超过这个预算还没等到 phase3，
 * 说明本轮第 5 路已失败/熔断，提示必须静默收掉（搜索界面不弹错误）。
 */
const CLIP_COLD_HINT_TIMEOUT_MS = 6000

/**
 * 语义分析（Phase 2）安全超时熔断阈值。
 * 与冷态 CLIP 视觉模型超时（`CLIP_COLD_HINT_TIMEOUT_MS = 6000`）及后端口径对齐：
 * 冷态或热更新后，倒排 Trie 树装配（~650ms）+ 分词 + 768d 语义向量计算 + 段落对齐
 * 总耗时约 1.5s ~ 2.5s。旧值 1500ms 过于激进脆弱，会导致冷态/热更新后首次纯语义搜索
 * 100% 触发超时熔断，过早退出分析态并呈现「没有文件」假空态。
 * 放宽至 6000ms（防死锁兜底），既为冷态预留充足计算窗口，又防止死锁时呼吸条无限挂起。
 */
export const SEMANTIC_SEARCH_TIMEOUT_MS = 6000

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
  const SEARCH_OVERLAY_VIEW_KEY = 'page_view_mode_search_overlay'
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    try {
      const saved = localStorage.getItem(SEARCH_OVERLAY_VIEW_KEY)
      if (saved && ['search-list', 'list', 'grid', 'waterfall'].includes(saved)) {
        return saved === 'list' ? 'search-list' : (saved as ViewMode)
      }
    } catch (e) {}
    return 'search-list'
  })

  const handleViewModeChange = useCallback((mode: ViewMode) => {
    const targetMode = mode === 'list' ? 'search-list' : mode
    setViewMode(targetMode)
    try {
      localStorage.setItem(SEARCH_OVERLAY_VIEW_KEY, targetMode)
    } catch (e) {}
  }, [])

  type SearchPhase = 'idle' | 'phase1_done_analyzing_semantic'
  const [searchPhase, setSearchPhase] = useState<SearchPhase>('idle')
  /**
   * 工单 13：冷态视觉模型首次加载提示。
   * 只在 phase2 携带 clipPending 时点亮，phase3 到达或超时后熄灭；
   * 它只影响提示条的显隐，**不参与** searchPhase 状态机（不阻塞、不置灰列表）。
   */
  const [isClipColdLoading, setIsClipColdLoading] = useState(false)

  const searchSeqRef = useRef(0)
  const handledPhase2SeqRef = useRef<number>(-1)
  /** 工单 13：phase3 独立序号守卫 —— **不得复用** handledPhase2SeqRef，否则两者互相吞并 */
  const handledPhase3SeqRef = useRef<number>(-1)
  /** 标识当前是否在等待冷态 Phase 3 视觉切片（此时当前结果仍为 0，需持续保持 Loading，防假空态闪烁） */
  const isWaitingPhase3Ref = useRef<boolean>(false)
  const searchDebounceTimerRef = useRef<NodeJS.Timeout | null>(null)
  const semanticTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const clipHintTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const previousActivePageIdRef = useRef<string | null>(null)
  const overlayContainerRef = useRef<HTMLDivElement>(null)

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
      setSearchPhase('idle')
      if (semanticTimeoutRef.current) {
        clearTimeout(semanticTimeoutRef.current)
        semanticTimeoutRef.current = null
      }
    }
  }, [isSearchActive])

  // 提取置换前当前可见行首个文件的路径作为滚动锚点 (Scroll Anchor)
  const getFirstVisibleItemPath = useCallback((): string | null => {
    if (!overlayContainerRef.current) return null
    const cardEls = overlayContainerRef.current.querySelectorAll<HTMLElement>('[data-path]')
    if (!cardEls || cardEls.length === 0) return null

    const containerRect = overlayContainerRef.current.getBoundingClientRect()
    for (let i = 0; i < cardEls.length; i++) {
      const rect = cardEls[i].getBoundingClientRect()
      if (rect.bottom > containerRect.top + 50) {
        return cardEls[i].getAttribute('data-path')
      }
    }
    return cardEls[0].getAttribute('data-path')
  }, [])

  // Phase 2 全量置换：保持激活项、多选区重连并防视口跳跃
  const handlePhase2Replace = useCallback(
    (completeItems: FileItem[]) => {
      const anchorPath = getFirstVisibleItemPath()

      // 1. 激活项与多选区重连
      setActiveItem(prevActive => {
        if (!prevActive?.path) return null
        return completeItems.find(item => item.path === prevActive.path) || null
      })

      setSelectedFiles(prevSelected => {
        if (!prevSelected.length) return []
        const pathSet = new Set(prevSelected.map(f => f.path))
        return completeItems.filter(item => pathSet.has(item.path))
      })

      // 2. 全量置换结果集
      setSearchResults(completeItems)

      // 3. 滚动锚定防跳跃：若存在锚点文件，在新结果集定位
      if (anchorPath) {
        const newIndex = completeItems.findIndex(item => item.path === anchorPath)
        if (newIndex >= 0 && overlayContainerRef.current) {
          const scroller = overlayContainerRef.current.querySelector<HTMLElement>(
            '[data-scroll-container="virtual-file-list"] .scrollbar-thin, .scrollbar-thin, .List, .overflow-y-auto'
          )
          if (scroller) {
            const targetScrollTop = newIndex * SEARCH_LIST_ROW_HEIGHT
            if (Math.abs(scroller.scrollTop - targetScrollTop) > SEARCH_LIST_ROW_HEIGHT * 2) {
              scroller.scrollTop = targetScrollTop
            }
          }
        }
      }
    },
    [getFirstVisibleItemPath]
  )

  /**
   * 工单 13：phase3 **只追加**。
   *
   * 三条硬约束（AC11）：
   * 1. 按 `path` 去重，已存在项一律忽略 —— 冷态 CLIP 命中的往往正是用户已看到的高相关项；
   * 2. 不重排、不清空：新项只能出现在尾部，已有项的相对顺序与下标绝对不变（用户已滚动/悬停/点击时无跳变）；
   * 3. 不动 `searchPhase`：phase3 到达不代表语义分析仍在进行，呼吸条/提示条各自独立收尾。
   */
  const appendPhase3Items = useCallback((appendedItems: FileItem[]) => {
    if (!appendedItems.length) return
    setSearchResults(prev => {
      const existingPaths = new Set(prev.map(item => item.path))
      const fresh = appendedItems.filter(item => item && item.path && !existingPaths.has(item.path))
      if (!fresh.length) return prev
      return [...prev, ...fresh]
    })
  }, [])

  // 2. 双阶段流式推送监听 (Phase 1 毫秒先行 -> Phase 2 语义置换 -> Phase 3 冷态 CLIP 追加)
  useEffect(() => {
    if (!window.electronAPI?.onSearchProgress) return

    const unsubscribe = window.electronAPI.onSearchProgress(payload => {
      // 通道守卫：仅消费本全局搜索浮层或未指定通道的推流，隔离其他局部搜索
      if (payload.channel && payload.channel !== 'global-overlay') return
      // 仅当前活跃序号允许写回，丢弃过期旧请求推流
      if (payload.seq !== searchSeqRef.current) return

      if (payload.phase === 'phase1') {
        // 若 Phase 2 已率先到达或处理，丢弃延迟的 Phase 1，防止全量置换被旧首屏覆盖
        if (handledPhase2SeqRef.current === payload.seq) return

        const hasItems = (payload.items?.length || 0) > 0

        // Phase 1: 毫秒级字面先行上屏
        setSearchResults(payload.items || [])
        setSearchPhase('phase1_done_analyzing_semantic')
        // 若 Phase 1 命中字面结果，收回全屏 Loading 呈现先行结果；
        // 若 Phase 1 零命中（如纯语义词、描述短语），保持 isLoading=true，展示深度语义检索 Loading，
        // 绝不可过早退出加载态而呈现「没有找到匹配的文件」虚假空态！
        setIsLoading(!hasItems)

        if (payload.tokens && payload.tokens.length > 0) {
          useSearchStore.getState().setSearchTokens(payload.tokens)
        }

        // 挂载安全超时熔断（与冷态 6000ms 对齐），防止 Omni 死锁导致呼吸条挂起
        if (semanticTimeoutRef.current) {
          clearTimeout(semanticTimeoutRef.current)
        }
        semanticTimeoutRef.current = setTimeout(() => {
          if (searchSeqRef.current === payload.seq) {
            logger.warn(
              LogCategory.RENDERER,
              `[GlobalSearchOverlay] Phase 2 语义分析超时熔断(${SEMANTIC_SEARCH_TIMEOUT_MS}ms)，恢复空闲态`
            )
            setSearchPhase('idle')
            setIsLoading(false)
          }
        }, SEMANTIC_SEARCH_TIMEOUT_MS)
      } else if (payload.phase === 'phase2') {
        // 对称幂等保护：若已处理该序号的 Phase 2（例如 Promise 先行返回），直接短路
        if (handledPhase2SeqRef.current === payload.seq) return
        handledPhase2SeqRef.current = payload.seq
        if (semanticTimeoutRef.current) {
          clearTimeout(semanticTimeoutRef.current)
          semanticTimeoutRef.current = null
        }
        handlePhase2Replace(payload.items || [])
        setSearchPhase('idle')

        const incomingItemsCount = (payload.items || []).length
        const hasPendingClip = Boolean(payload.clipPending)

        // 若当前结果为空且视觉模型仍在后台调度加载中（clipPending），最终结果尚未返回！
        // 必须持续保持 isLoading=true，绝不能提前退出 loading 导致用户看到假空态！
        if (incomingItemsCount === 0 && hasPendingClip) {
          isWaitingPhase3Ref.current = true
          setIsLoading(true)
        } else {
          isWaitingPhase3Ref.current = false
          setIsLoading(false)
        }

        if (payload.tokens && payload.tokens.length > 0) {
          useSearchStore.getState().setSearchTokens(payload.tokens)
        }

        // 工单 13：冷态视觉模型首次加载 → 轻量提示；phase3 到达或超时即收
        if (clipHintTimeoutRef.current) {
          clearTimeout(clipHintTimeoutRef.current)
          clipHintTimeoutRef.current = null
        }
        if (hasPendingClip) {
          setIsClipColdLoading(true)
          clipHintTimeoutRef.current = setTimeout(() => {
            if (searchSeqRef.current === payload.seq) {
              // 超时静默收提示：搜索界面不弹错误，用户只是看不到额外追加项
              setIsClipColdLoading(false)
              if (isWaitingPhase3Ref.current) {
                isWaitingPhase3Ref.current = false
                setIsLoading(false)
              }
            }
          }, CLIP_COLD_HINT_TIMEOUT_MS)
        } else {
          setIsClipColdLoading(false)
        }
      } else if (payload.phase === 'phase3') {
        // 工单 13：冷态 CLIP 追加。**独立序号守卫**（handledPhase3SeqRef），
        // 与 phase2 的幂等标记互不干扰：phase2 已处理不代表 phase3 已处理，反之亦然。
        if (handledPhase3SeqRef.current === payload.seq) return
        handledPhase3SeqRef.current = payload.seq
        if (clipHintTimeoutRef.current) {
          clearTimeout(clipHintTimeoutRef.current)
          clipHintTimeoutRef.current = null
        }
        setIsClipColdLoading(false)
        isWaitingPhase3Ref.current = false
        // Phase 3 视觉切片送达，最终结果已全量就绪，收回加载态！
        setIsLoading(false)
        appendPhase3Items(payload.items || [])
      }
    })

    return () => {
      unsubscribe()
      if (semanticTimeoutRef.current) {
        clearTimeout(semanticTimeoutRef.current)
        semanticTimeoutRef.current = null
      }
      if (clipHintTimeoutRef.current) {
        clearTimeout(clipHintTimeoutRef.current)
        clipHintTimeoutRef.current = null
      }
    }
  }, [handlePhase2Replace, appendPhase3Items])

  // 3. 搜索逻辑：防抖 + 竞态序号锁 + 双阶段全域跨目录检索
  useEffect(() => {
    if (searchDebounceTimerRef.current) {
      clearTimeout(searchDebounceTimerRef.current)
      searchDebounceTimerRef.current = null
    }

    const keyword = globalSearchKeyword.trim()
    if (!keyword) {
      searchSeqRef.current++
      setSearchResults([])
      isWaitingPhase3Ref.current = false
      setIsLoading(false)
      setSearchPhase('idle')
      // 工单 13：清空搜索词时一并收掉冷态提示，避免残留
      if (clipHintTimeoutRef.current) {
        clearTimeout(clipHintTimeoutRef.current)
        clipHintTimeoutRef.current = null
      }
      setIsClipColdLoading(false)
      return
    }

    if (!workspaceDirectory?.path) {
      searchSeqRef.current++
      setSearchResults([])
      isWaitingPhase3Ref.current = false
      setIsLoading(false)
      setSearchPhase('idle')
      if (clipHintTimeoutRef.current) {
        clearTimeout(clipHintTimeoutRef.current)
        clipHintTimeoutRef.current = null
      }
      setIsClipColdLoading(false)
      return
    }

    setIsLoading(true)
    const currentSeq = ++searchSeqRef.current

    searchDebounceTimerRef.current = setTimeout(async () => {
      try {
        const results = await window.electronAPI!.searchWorkspaceFiles(
          keyword,
          workspaceDirectory.path,
          { stream: true, seq: currentSeq, channel: 'global-overlay' }
        )

        // 仅最新一次请求允许写回 State，防止慢响应覆盖快响应
        if (currentSeq === searchSeqRef.current) {
          // 若流式 Phase 2 已先行处理，跳过重复置换与视口抖动
          if (handledPhase2SeqRef.current !== currentSeq) {
            handledPhase2SeqRef.current = currentSeq
            handlePhase2Replace(results || [])
          }
          setSearchPhase('idle')
          // 若仍在等待冷态 Phase 3 追加（当前结果仍为 0），持续保持 loading 直到 Phase 3 或超时
          if (!isWaitingPhase3Ref.current) {
            setIsLoading(false)
          }

          const tokens = (results as any)?.tokens || []
          if (tokens.length > 0) {
            useSearchStore.getState().setSearchTokens(tokens)
          } else if (window.electronAPI?.tokenizeText) {
            window.electronAPI.tokenizeText(keyword).then(t => {
              if (currentSeq === searchSeqRef.current && t && t.length > 0) {
                useSearchStore.getState().setSearchTokens(t)
              }
            }).catch(() => {})
          }
          useSearchStore.getState().addSearchHistory(keyword, 'global')
        }
      } catch (error) {
        logger.error(LogCategory.RENDERER, '全域工作空间搜索失败:', error)
        if (currentSeq === searchSeqRef.current) {
          setSearchResults([])
          setSearchPhase('idle')
          isWaitingPhase3Ref.current = false
          setIsLoading(false)
        }
      } finally {
        if (currentSeq === searchSeqRef.current) {
          if (!isWaitingPhase3Ref.current) {
            setIsLoading(false)
          }
        }
      }
    }, 250)

    return () => {
      searchSeqRef.current++
      if (searchDebounceTimerRef.current) {
        clearTimeout(searchDebounceTimerRef.current)
      }
    }
  }, [globalSearchKeyword, workspaceDirectory?.path, handlePhase2Replace])

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
      ref={overlayContainerRef}
      className={cn(
        'absolute inset-x-0 bottom-0 z-30 bg-background flex flex-col overflow-hidden',
        'animate-in fade-in duration-200'
      )}
      style={{ top: 'var(--app-header-height, 53px)' }}
    >
      {/* 顶部微型语义呼吸条 (Phase 1 -> Phase 2 状态机: 1.5px 紫罗兰色脉冲渐变微条) */}
      <div
        className={cn(
          'absolute top-0 inset-x-0 h-[1.5px] z-50 pointer-events-none transition-opacity duration-300 bg-gradient-to-r from-violet-500 via-fuchsia-500 to-indigo-500',
          searchPhase === 'phase1_done_analyzing_semantic' ? 'opacity-100 animate-pulse' : 'opacity-0'
        )}
      />

      {/* 工单 13：冷态视觉模型首次加载提示（搜索框下方轻量条，不遮挡列表、不弹错误） */}
      {isClipColdLoading && (
        <div
          data-testid="clip-cold-hint"
          className="flex-shrink-0 flex items-center justify-center gap-1.5 px-3 py-1 border-b border-border/60 bg-violet-500/5 text-[11px] text-violet-600 dark:text-violet-400"
        >
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-violet-500 animate-ping" />
          {t('正在加载视觉搜索模型，相关图片稍后追加…')}
        </div>
      )}



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
            onViewModeChange={handleViewModeChange}
            showPreviewPanel={true}
            showDetailsPanel={showDetailsPanel}
            onCloseDetailsPanel={() => setShowDetailsPanel(false)}
            pageId={PAGE_IDS.SEARCH_OVERLAY}
            disableClientSort={true}
            isRealDirectory={true}
            showsmartName={true}
            showAnalysisStatus={true}
            isLoading={isLoading}
            workspaceDirectoryPath={workspaceDirectory?.path}
            workspaceDirectoryType={workspaceDirectory?.type}
            renderToolbar={layoutContext => (
              <div className="flex-shrink-0 border-b border-border px-3 py-1.5 flex items-center justify-between bg-card gap-2 min-h-[44px]">
                {/* 左侧：全域搜索状态与统计 */}
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <MaterialIcon icon="travel_explore" className="text-primary text-base flex-shrink-0" />
                  <span className="text-muted-foreground whitespace-nowrap text-xs">
                    {t('全域搜索:')}
                  </span>
                  <span className="font-semibold text-foreground truncate max-w-[120px] sm:max-w-[200px] md:max-w-[320px]">
                    "{keyword}"
                  </span>
                  <span className="text-muted-foreground/80 text-[11px] whitespace-nowrap hidden sm:inline">
                    {t('（共 {count} 项，包含未分析与已分析文件）', { count: searchResults.length })}
                  </span>
                  <span className="text-muted-foreground/80 text-[11px] whitespace-nowrap sm:hidden">
                    {t('（{count} 项）', { count: searchResults.length })}
                  </span>
                  {searchPhase === 'phase1_done_analyzing_semantic' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600 dark:text-violet-400 border border-violet-500/20 whitespace-nowrap shrink-0 animate-pulse flex items-center gap-1">
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-violet-500 animate-ping" />
                      {t('深度语义对齐中...')}
                    </span>
                  )}
                  {searchResults.length >= 500 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 whitespace-nowrap shrink-0">
                      {t('前 500 项')}
                    </span>
                  )}
                </div>

                {/* 右侧：视图模式与显示设置 Mini 下拉弹窗 */}
                <div className="flex items-center gap-2 text-foreground dark:text-foreground shrink-0">
                  <MiniViewDisplaySettingsPopover
                    viewMode={layoutContext.viewMode}
                    onViewModeChange={newMode => {
                      const effectiveMode = newMode === 'list' ? 'search-list' : newMode
                      layoutContext.setViewMode(effectiveMode)
                      try {
                        localStorage.setItem(SEARCH_OVERLAY_VIEW_KEY, effectiveMode)
                      } catch (e) {}
                    }}
                    gridCardWidth={layoutContext.gridCardWidth}
                    onGridCardWidthChange={layoutContext.setGridCardWidth}
                  />
                </div>
              </div>
            )}
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
