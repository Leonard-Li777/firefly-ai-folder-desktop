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
import {
  logger,
  LogCategory,
  SearchPhase,
  SearchCommit,
  ActiveSearchContext,
  shouldApplySearchCommit,
  createInitialSearchCommit
} from '@firefly/shared'
import { SEARCH_LIST_ROW_HEIGHT } from '../FileList/components/SearchListCard'
import { MiniViewDisplaySettingsPopover } from '../../common/MiniViewDisplaySettingsPopover'

interface GlobalSearchOverlayProps {
  workspaceDirectory: WorkspaceDirectory | null
}

/**
 * 冷态视觉模型加载提示的最长展示时间。
 * 与 desktop 侧 `CLIP_TEXT_TIMEOUT_COLD_MS`（6000ms）对齐 —— 超过这个预算还没等到 phase3，
 * 说明本轮第 5 路已失败/熔断，提示必须静默收掉（搜索界面不弹错误）。
 */
const CLIP_COLD_HINT_TIMEOUT_MS = 6000

/**
 * 语义分析（Phase 2）安全超时熔断阈值。
 */
export const SEMANTIC_SEARCH_TIMEOUT_MS = 6000

export const GlobalSearchOverlay: React.FC<GlobalSearchOverlayProps> = ({ workspaceDirectory }) => {
  useVoerkaI18n(i18nScope)
  const globalSearchKeyword = useSearchStore(s => s.globalSearchKeyword)
  const clearGlobalSearch = useSearchStore(s => s.clearGlobalSearch)
  const isSearchActive = Boolean(globalSearchKeyword.trim())

  const [searchResults, setSearchResults] = useState<FileItem[]>([])
  const [isLoading, setIsLoading] = useState(false)
  /** 已完成终态结算（数据已置换上屏或请求明确结束）的搜索序号 */
  const [settledSeq, setSettledSeq] = useState<number>(-1)
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

  // 5 态 SearchCommit 统一状态机 (Spec §3.3)
  const [searchCommit, setSearchCommit] = useState<SearchCommit>(() =>
    createInitialSearchCommit(1, 0, '')
  )
  const searchCommitRef = useRef<SearchCommit>(searchCommit)
  searchCommitRef.current = searchCommit

  // 记录搜索经历的历史相位（用于 DOM 属性与测试断言回溯）
  const [searchHistory, setSearchHistory] = useState<string[]>(['idle'])
  const applyCommit = useCallback((commit: SearchCommit) => {
    setSearchCommit(commit)
    setSearchHistory(prev =>
      prev[prev.length - 1] === commit.phase ? prev : [...prev, commit.phase]
    )
  }, [])

  /**
   * pointerdown 捕获阶段立即中断流并锁定 cancelled 终态 (Spec §3.3 / TEST-UI-SEARCH-04)
   * 在鼠标按下瞬时冻结列表重排，防止点击时落点漂移
   */
  const handlePointerDownCapture = useCallback(
    (e: React.PointerEvent) => {
      const target = e.target as HTMLElement | null
      const card = target?.closest('[data-path]')
      if (
        card &&
        isSearchActive &&
        searchCommitRef.current.phase !== 'fusion' &&
        searchCommitRef.current.phase !== 'failed' &&
        searchCommitRef.current.phase !== 'cancelled'
      ) {
        const activeCtx: ActiveSearchContext = {
          requestId: searchSeqRef.current,
          epoch: searchCommitRef.current.requestEpoch
        }
        const cancelledCommit: SearchCommit = {
          ...searchCommitRef.current,
          rev: searchCommitRef.current.rev + 1,
          phase: 'cancelled'
        }
        if (shouldApplySearchCommit(activeCtx, searchCommitRef.current, cancelledCommit)) {
          applyCommit(cancelledCommit)
          setIsLoading(false)
        }
      }
    },
    [isSearchActive, applyCommit]
  )

  /**
   * 冷态视觉模型首次加载提示。
   * 只在 phase2 携带 clipPending 时点亮，phase3 到达或超时后熄灭；
   * 它只影响提示条的显隐，不阻塞、不置灰列表。
   */
  const [isClipColdLoading, setIsClipColdLoading] = useState(false)

  const searchSeqRef = useRef(0)
  const handledPhase2SeqRef = useRef<number>(-1)
  /** phase3 独立序号守卫 —— 不得复用 handledPhase2SeqRef */
  const handledPhase3SeqRef = useRef<number>(-1)
  const searchDebounceTimerRef = useRef<NodeJS.Timeout | null>(null)
  const semanticTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const clipHintTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const previousActivePageIdRef = useRef<string | null>(null)
  const overlayContainerRef = useRef<HTMLDivElement>(null)

  const isSearchSettled = settledSeq === searchSeqRef.current
  const isTerminalPhase =
    searchCommit.phase === 'fusion' ||
    searchCommit.phase === 'failed' ||
    searchCommit.phase === 'cancelled'

  /**
   * 核心推导（派生加载态）：
   * 搜索激活且未到达终态结算（!isSearchSettled 或 !isTerminalPhase），或显式标记 isLoading，恒为 loading 态！
   * 彻底杜绝组件初次挂载时的首帧 Render Lag、中间过渡帧或任何客户端超时误关暴露假空态。
   */
  const effectiveIsLoading = isSearchActive
    ? !isSearchSettled || !isTerminalPhase || isLoading
    : false

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
      setSettledSeq(-1)
      setSearchCommit(createInitialSearchCommit(searchCommitRef.current.requestEpoch, 0, ''))
      setSearchHistory(['idle'])
      handledPhase2SeqRef.current = -1
      handledPhase3SeqRef.current = -1
      if (semanticTimeoutRef.current) {
        clearTimeout(semanticTimeoutRef.current)
        semanticTimeoutRef.current = null
      }
      if (clipHintTimeoutRef.current) {
        clearTimeout(clipHintTimeoutRef.current)
        clipHintTimeoutRef.current = null
      }
      setIsClipColdLoading(false)
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
   * Phase 3 只追加 (Spec §3.3)
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

  // 2. 多阶段流式推送监听 (Phase 1 字面先行 -> Phase 2 语义置换/收口 -> Phase 3 冷态追加)
  useEffect(() => {
    if (!window.electronAPI?.onSearchProgress) return

    const unsubscribe = window.electronAPI.onSearchProgress(payload => {
      // 通道守卫：仅消费本全局搜索浮层或未指定通道的推流，隔离其他局部搜索
      if (payload.channel && payload.channel !== 'global-overlay') return
      // 仅当前活跃序号允许写回，丢弃过期旧请求推流
      if (payload.seq !== searchSeqRef.current) return

      const activeCtx: ActiveSearchContext = {
        requestId: searchSeqRef.current,
        epoch: searchCommitRef.current.requestEpoch
      }

      if (payload.phase === 'failed') {
        const incoming: SearchCommit = {
          requestEpoch: payload.requestEpoch ?? activeCtx.epoch,
          requestId: payload.seq,
          rev: searchCommitRef.current.rev + 1,
          query: globalSearchKeyword.trim(),
          phase: 'failed',
          lexicalCount: searchResults.length,
          vectorCount: 0,
          fusedCount: searchResults.length,
          vectorSkipped: false,
          errorCode: payload.errorCode,
          errorMessage: payload.errorMessage
        }
        if (shouldApplySearchCommit(activeCtx, searchCommitRef.current, incoming)) {
          applyCommit(incoming)
          setIsLoading(false)
          setSettledSeq(payload.seq)
        }
        return
      }

      if (payload.phase === 'phase1') {
        // 若 Phase 2 已率先到达或处理，丢弃延迟的 Phase 1
        if (handledPhase2SeqRef.current === payload.seq) return

        const hasItems = (payload.items?.length || 0) > 0
        const incoming: SearchCommit = {
          requestEpoch: payload.requestEpoch ?? activeCtx.epoch,
          requestId: payload.seq,
          rev: searchCommitRef.current.rev + 1,
          query: globalSearchKeyword.trim(),
          phase: 'lexical',
          lexicalCount: payload.items?.length || 0,
          vectorCount: 0,
          fusedCount: payload.items?.length || 0,
          vectorSkipped: false
        }

        if (shouldApplySearchCommit(activeCtx, searchCommitRef.current, incoming)) {
          applyCommit(incoming)
          setSearchResults(payload.items || [])
          setIsLoading(!hasItems)

          if (payload.tokens && payload.tokens.length > 0) {
            useSearchStore.getState().setSearchTokens(payload.tokens)
          }

          if (semanticTimeoutRef.current) {
            clearTimeout(semanticTimeoutRef.current)
          }
          semanticTimeoutRef.current = setTimeout(() => {
            if (
              searchSeqRef.current === payload.seq &&
              searchCommitRef.current.phase === 'lexical'
            ) {
              logger.warn(
                LogCategory.RENDERER,
                `[GlobalSearchOverlay] Phase 2 语义分析呼吸条超时(${SEMANTIC_SEARCH_TIMEOUT_MS}ms)，就地收口为 fusion`
              )
              const fallbackFusion: SearchCommit = {
                ...searchCommitRef.current,
                rev: searchCommitRef.current.rev + 1,
                phase: 'fusion',
                vectorSkipped: true
              }
              if (shouldApplySearchCommit(activeCtx, searchCommitRef.current, fallbackFusion)) {
                applyCommit(fallbackFusion)
                setIsLoading(false)
                setSettledSeq(payload.seq)
              }
            }
          }, SEMANTIC_SEARCH_TIMEOUT_MS)
        }
      } else if (payload.phase === 'phase2') {
        const incomingItemsCount = (payload.items || []).length
        const hasPendingClip = Boolean(payload.clipPending)

        if (semanticTimeoutRef.current) {
          clearTimeout(semanticTimeoutRef.current)
          semanticTimeoutRef.current = null
        }

        // 防死锁确定性映射：热态无 clipPending 时直接跃迁至 fusion 终态！
        const targetPhase: SearchPhase = hasPendingClip ? 'vector' : 'fusion'
        const incoming: SearchCommit = {
          requestEpoch: payload.requestEpoch ?? activeCtx.epoch,
          requestId: payload.seq,
          rev: searchCommitRef.current.rev + 1,
          query: globalSearchKeyword.trim(),
          phase: targetPhase,
          lexicalCount: searchCommitRef.current.lexicalCount,
          vectorCount: incomingItemsCount,
          fusedCount: incomingItemsCount,
          vectorSkipped: false,
          clipPending: hasPendingClip
        }

        if (shouldApplySearchCommit(activeCtx, searchCommitRef.current, incoming)) {
          applyCommit(incoming)

          if (clipHintTimeoutRef.current) {
            clearTimeout(clipHintTimeoutRef.current)
            clipHintTimeoutRef.current = null
          }

          if (hasPendingClip) {
            setIsClipColdLoading(true)
            setIsLoading(true)
            clipHintTimeoutRef.current = setTimeout(() => {
              if (searchSeqRef.current === payload.seq) {
                setIsClipColdLoading(false)
                // 超时后收口为 fusion 终态
                const timeoutFusion: SearchCommit = {
                  ...searchCommitRef.current,
                  rev: searchCommitRef.current.rev + 1,
                  phase: 'fusion',
                  clipPending: false
                }
                if (shouldApplySearchCommit(activeCtx, searchCommitRef.current, timeoutFusion)) {
                  applyCommit(timeoutFusion)
                  setIsLoading(false)
                  setSettledSeq(payload.seq)
                }
              }
            }, CLIP_COLD_HINT_TIMEOUT_MS)
          } else {
            setIsClipColdLoading(false)
            setIsLoading(false)
            setSettledSeq(payload.seq)
          }

          if (handledPhase2SeqRef.current !== payload.seq) {
            handledPhase2SeqRef.current = payload.seq
            handlePhase2Replace(payload.items || [])
          }

          if (payload.tokens && payload.tokens.length > 0) {
            useSearchStore.getState().setSearchTokens(payload.tokens)
          }
        }
      } else if (payload.phase === 'phase3') {
        if (handledPhase3SeqRef.current === payload.seq) return
        handledPhase3SeqRef.current = payload.seq

        if (clipHintTimeoutRef.current) {
          clearTimeout(clipHintTimeoutRef.current)
          clipHintTimeoutRef.current = null
        }
        setIsClipColdLoading(false)

        const incoming: SearchCommit = {
          requestEpoch: payload.requestEpoch ?? activeCtx.epoch,
          requestId: payload.seq,
          rev: searchCommitRef.current.rev + 1,
          query: globalSearchKeyword.trim(),
          phase: 'fusion',
          lexicalCount: searchCommitRef.current.lexicalCount,
          vectorCount: searchCommitRef.current.vectorCount,
          fusedCount: searchResults.length + (payload.items?.length || 0),
          vectorSkipped: false,
          clipPending: false
        }

        if (shouldApplySearchCommit(activeCtx, searchCommitRef.current, incoming)) {
          applyCommit(incoming)
          if (payload.items && payload.items.length > 0) {
            appendPhase3Items(payload.items)
          }
          setIsLoading(false)
          setSettledSeq(payload.seq)
        }
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
  }, [handlePhase2Replace, appendPhase3Items, searchResults.length, globalSearchKeyword])

  // 3. 搜索逻辑：防抖 + 竞态序号锁 + 双阶段全域跨目录检索
  useEffect(() => {
    if (searchDebounceTimerRef.current) {
      clearTimeout(searchDebounceTimerRef.current)
      searchDebounceTimerRef.current = null
    }

    const keyword = globalSearchKeyword.trim()
    if (!keyword) {
      const nextSeq = ++searchSeqRef.current
      setSettledSeq(nextSeq)
      setSearchResults([])
      handledPhase2SeqRef.current = -1
      handledPhase3SeqRef.current = -1
      setIsLoading(false)
      setSearchCommit(createInitialSearchCommit(searchCommitRef.current.requestEpoch, nextSeq, ''))
      setSearchHistory(['idle'])
      if (clipHintTimeoutRef.current) {
        clearTimeout(clipHintTimeoutRef.current)
        clipHintTimeoutRef.current = null
      }
      setIsClipColdLoading(false)
      return
    }

    if (!workspaceDirectory?.path) {
      const nextSeq = ++searchSeqRef.current
      setSettledSeq(nextSeq)
      setSearchResults([])
      setIsLoading(false)
      setSearchCommit(
        createInitialSearchCommit(searchCommitRef.current.requestEpoch, nextSeq, keyword)
      )
      setSearchHistory(['idle'])
      if (clipHintTimeoutRef.current) {
        clearTimeout(clipHintTimeoutRef.current)
        clipHintTimeoutRef.current = null
      }
      setIsClipColdLoading(false)
      return
    }

    setIsLoading(true)
    const currentSeq = ++searchSeqRef.current
    const activeCtx: ActiveSearchContext = {
      requestId: currentSeq,
      epoch: searchCommitRef.current.requestEpoch
    }
    // 重置当前搜索提交为初始态，开启新一轮检索周期
    setSearchCommit(createInitialSearchCommit(activeCtx.epoch, currentSeq, keyword))
    setSearchHistory(['idle'])

    searchDebounceTimerRef.current = setTimeout(async () => {
      let results: any = null
      try {
        results = await window.electronAPI!.searchWorkspaceFiles(keyword, workspaceDirectory.path, {
          stream: true,
          seq: currentSeq,
          channel: 'global-overlay',
          epoch: activeCtx.epoch
        })

        // 仅最新一次请求允许写回 State，防止慢响应覆盖快响应
        if (currentSeq === searchSeqRef.current) {
          const hasPendingClip = Boolean((results as any)?.clipPending)
          const itemsCount = results?.length || 0

          if (semanticTimeoutRef.current) {
            clearTimeout(semanticTimeoutRef.current)
            semanticTimeoutRef.current = null
          }

          if (handledPhase2SeqRef.current !== currentSeq) {
            handledPhase2SeqRef.current = currentSeq
            handlePhase2Replace(results || [])
          }

          const targetPhase: SearchPhase = hasPendingClip ? 'vector' : 'fusion'
          const incoming: SearchCommit = {
            requestEpoch: (results as any)?.requestEpoch ?? activeCtx.epoch,
            requestId: currentSeq,
            rev: searchCommitRef.current.rev + 1,
            query: keyword,
            phase: targetPhase,
            lexicalCount: searchCommitRef.current.lexicalCount,
            vectorCount: itemsCount,
            fusedCount: itemsCount,
            vectorSkipped: false,
            clipPending: hasPendingClip
          }

          if (shouldApplySearchCommit(activeCtx, searchCommitRef.current, incoming)) {
            applyCommit(incoming)
          }

          if (hasPendingClip && itemsCount === 0) {
            setIsLoading(true)
            setIsClipColdLoading(true)
            if (clipHintTimeoutRef.current) {
              clearTimeout(clipHintTimeoutRef.current)
            }
            clipHintTimeoutRef.current = setTimeout(() => {
              if (searchSeqRef.current === currentSeq) {
                setIsClipColdLoading(false)
                const timeoutFusion: SearchCommit = {
                  ...searchCommitRef.current,
                  rev: searchCommitRef.current.rev + 1,
                  phase: 'fusion',
                  clipPending: false
                }
                if (shouldApplySearchCommit(activeCtx, searchCommitRef.current, timeoutFusion)) {
                  applyCommit(timeoutFusion)
                  setIsLoading(false)
                  setSettledSeq(currentSeq)
                }
              }
            }, CLIP_COLD_HINT_TIMEOUT_MS)
          } else if (!hasPendingClip) {
            setIsLoading(false)
            setSettledSeq(currentSeq)
          }

          const tokens = (results as any)?.tokens || []
          if (tokens.length > 0) {
            useSearchStore.getState().setSearchTokens(tokens)
          } else if (window.electronAPI?.tokenizeText) {
            window.electronAPI
              .tokenizeText(keyword)
              .then(t => {
                if (currentSeq === searchSeqRef.current && t && t.length > 0) {
                  useSearchStore.getState().setSearchTokens(t)
                }
              })
              .catch(() => {})
          }
          useSearchStore.getState().addSearchHistory(keyword, 'global')
        }
      } catch (error) {
        logger.error(LogCategory.RENDERER, '全域工作空间搜索失败:', error)
        if (currentSeq === searchSeqRef.current) {
          const incoming: SearchCommit = {
            requestEpoch: activeCtx.epoch,
            requestId: currentSeq,
            rev: searchCommitRef.current.rev + 1,
            query: keyword,
            phase: 'failed',
            lexicalCount: searchResults.length,
            vectorCount: 0,
            fusedCount: searchResults.length,
            vectorSkipped: false,
            errorCode: (error as any)?.code || 'E_SEARCH_FAILED',
            errorMessage: (error as any)?.message || String(error)
          }
          if (shouldApplySearchCommit(activeCtx, searchCommitRef.current, incoming)) {
            applyCommit(incoming)
          }
          setIsLoading(false)
          setSettledSeq(currentSeq)
        }
      } finally {
        if (currentSeq === searchSeqRef.current) {
          if (!(results as any)?.clipPending && searchCommitRef.current.phase === 'fusion') {
            setIsLoading(false)
            setSettledSeq(currentSeq)
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
  }, [globalSearchKeyword, workspaceDirectory?.path, handlePhase2Replace, applyCommit])

  // 4. 键盘事件监听 (Escape 退出)
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

  // 用户交互选中/点击项：中断流并锁定 cancelled 终态 (TEST-UI-SEARCH-04)
  const handleFileSelect = useCallback(
    (filesOrItem: FileItem[] | FileItem | null) => {
      if (
        isSearchActive &&
        searchCommitRef.current.phase !== 'fusion' &&
        searchCommitRef.current.phase !== 'failed' &&
        searchCommitRef.current.phase !== 'cancelled'
      ) {
        const activeCtx: ActiveSearchContext = {
          requestId: searchSeqRef.current,
          epoch: searchCommitRef.current.requestEpoch
        }
        const cancelledCommit: SearchCommit = {
          ...searchCommitRef.current,
          rev: searchCommitRef.current.rev + 1,
          phase: 'cancelled'
        }
        if (shouldApplySearchCommit(activeCtx, searchCommitRef.current, cancelledCommit)) {
          applyCommit(cancelledCommit)
          setIsLoading(false)
        }
      }

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
    },
    [isSearchActive, applyCommit]
  )

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
      data-testid="global-search-overlay"
      data-search-phase={searchCommit.phase}
      data-search-rev={searchCommit.rev}
      data-search-history={searchHistory.join(',')}
      onPointerDownCapture={handlePointerDownCapture}
      className={cn(
        'absolute inset-x-0 bottom-0 z-30 bg-background flex flex-col overflow-hidden',
        'animate-in fade-in duration-200'
      )}
      style={{ top: 'var(--app-header-height, 53px)' }}
    >
      {/* 顶部通栏 Loading 条 */}
      <div
        className={cn(
          'absolute top-0 inset-x-0 h-[2px] z-50 pointer-events-none transition-opacity duration-300 overflow-hidden bg-primary/10',
          effectiveIsLoading || searchCommit.phase === 'lexical' || searchCommit.phase === 'vector'
            ? 'opacity-100'
            : 'opacity-0'
        )}
      >
        <div className="h-full w-full bg-gradient-to-r from-transparent via-primary to-transparent animate-indeterminate-bar" />
      </div>

      {/* 冷态视觉模型首次加载提示 */}
      {isClipColdLoading && (
        <div
          data-testid="clip-cold-hint"
          className="flex-shrink-0 flex items-center justify-center gap-1.5 px-3 py-1 border-b border-border/60 bg-violet-500/5 text-[11px] text-violet-600 dark:text-violet-400"
        >
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-violet-500 animate-ping" />
          {t('正在加载视觉搜索模型，相关图片稍后追加…')}
        </div>
      )}

      {/* 异常降级横幅 (TEST-UI-SEARCH-05) */}
      {searchCommit.phase === 'failed' && (
        <div
          data-testid="search-degraded-banner"
          className="flex-shrink-0 flex items-center justify-between px-3 py-1.5 border-b border-amber-500/30 bg-amber-500/10 text-xs text-amber-700 dark:text-amber-300"
        >
          <div className="flex items-center gap-1.5">
            <MaterialIcon icon="warning" className="text-amber-500 text-sm" />
            <span>{t('深度语义搜索暂时不可用，已为您展示基础字面匹配结果')}</span>
          </div>
          {searchCommit.errorCode && (
            <span className="font-mono text-[10px] opacity-75">[{searchCommit.errorCode}]</span>
          )}
        </div>
      )}

      {/* 核心三栏同构布局: FileList | SplitPreviewPanel | FileDetailsPanel */}
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
            isLoading={effectiveIsLoading}
            workspaceDirectoryPath={workspaceDirectory?.path}
            workspaceDirectoryType={workspaceDirectory?.type}
            renderToolbar={layoutContext => (
              <div className="flex-shrink-0 border-b border-border px-3 py-1.5 flex items-center justify-between bg-card gap-2 min-h-[44px]">
                {/* 左侧：全域搜索状态与统计 */}
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  <MaterialIcon
                    icon="travel_explore"
                    className="text-primary text-base flex-shrink-0"
                  />
                  <span className="text-muted-foreground whitespace-nowrap text-xs">
                    {t('全域搜索:')}
                  </span>
                  <span className="font-semibold text-foreground truncate max-w-[120px] sm:max-w-[200px] md:max-w-[320px]">
                    "{keyword}"
                  </span>
                  <span className="text-muted-foreground/80 text-[11px] whitespace-nowrap hidden sm:inline">
                    {t('（共 {count} 项，包含未分析与已分析文件）', {
                      count: searchResults.length
                    })}
                  </span>
                  <span className="text-muted-foreground/80 text-[11px] whitespace-nowrap sm:hidden">
                    {t('（{count} 项）', { count: searchResults.length })}
                  </span>
                  {(searchCommit.phase === 'lexical' || searchCommit.phase === 'vector') && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-violet-500/10 text-violet-600 dark:text-violet-400 border border-violet-500/20 whitespace-nowrap shrink-0 animate-pulse flex items-center gap-1">
                      <span className="inline-block w-1.5 h-1.5 rounded-full bg-violet-500 animate-ping" />
                      {searchCommit.phase === 'lexical'
                        ? t('字面检索中...')
                        : t('深度语义对齐中...')}
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
                <span>{t('匹配文件: {count} 个', { count: layoutContext.files.length })}</span>
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
