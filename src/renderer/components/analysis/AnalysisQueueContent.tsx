import React, { useEffect, useRef, useState } from 'react'
import { AnalysisQueueItem } from '@firefly/types/types'
import { Button } from '../ui/button'
import { SettingsCategory } from '@firefly/types'
import { cn } from '../../lib/utils'
import { formatDuration } from '@firefly/shared'
import { t } from '@app/languages'
import { getUnitTypeLabel } from '../file-explorer/FileList/utils'
import { useAnalysisQueueStore } from '../../stores/analysis-queue-store'
import { useSettingsStore } from '../../stores/settings-store'
import { useVirtualDirectoryStore } from '../../stores/virtual-directory-store'
import {
  ExternalLink,
  PanelBottom,
  RotateCcw,
  Trash2,
  Pause,
  Play,
  X,
  Minus,
  Square
} from 'lucide-react'

const ROW_HEIGHT = 48

interface ColumnWidths {
  index: number
  name: number
  status: number
  history: number
  reason: number
  stats: number
  unit: number
  actions: number
}

const DEFAULT_COL_WIDTHS: ColumnWidths = {
  index: 44,
  name: 240,
  status: 160,
  history: 80,
  reason: 200,
  stats: 90,
  unit: 80,
  actions: 90
}

function HistoryBadge({
  stage,
  status,
  analysisMode
}: {
  stage?: number
  status?: string
  analysisMode: string
}) {
  // 分析模式决定文件完成所需的 stage：Sample->1, Document->2, Full->4
  const completionStage = analysisMode === 'simple' ? 1 : analysisMode === 'document' ? 2 : 4
  const s = stage ?? 0

  // 失败：在状态列展示分析失败
  if (status === 'failed') {
    return (
      <span className="text-xs px-2 py-0.5 rounded bg-destructive/10 text-destructive font-medium">
        {t('分析失败')}
      </span>
    )
  }
  // 处理中：正在 CPU/GPU 线程分析中的文件，强制为处理中
  if (status === 'analyzing') {
    return (
      <span className="text-xs px-2 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 font-medium">
        {t('处理中')}
      </span>
    )
  }
  // 已完成：队列标记完成，或 stage 已达分析模式终态
  if (status === 'completed' || s >= completionStage) {
    return (
      <span className="text-xs px-2 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400 font-medium">
        {t('已完成')}
      </span>
    )
  }
  // 待处理：排队中 / 已暂停但未完成
  return (
    <span className="text-xs px-2 py-0.5 rounded bg-muted text-muted-foreground">
      {t('待处理')}
    </span>
  )
}

function ColumnResizeHandle({
  onResizeStart,
  onResize
}: {
  onResizeStart: () => void
  onResize: (deltaX: number) => void
}) {
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    onResizeStart()

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX
      onResize(deltaX)
    }

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  return (
    <div
      className="absolute right-0 top-0 bottom-0 w-3 -mr-1.5 cursor-col-resize z-20 flex items-center justify-center group/handle"
      onMouseDown={handleMouseDown}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      title={t('拖动调整列宽')}
    >
      {/* 默认显眼的立柱分隔线 (亮色与暗色模式下均清晰可见) */}
      <div className="w-[1.5px] h-3.5 bg-border/80 dark:bg-border/60 group-hover/handle:bg-primary group-hover/handle:w-[2px] transition-all" />
    </div>
  )
}

function VirtualList({
  items,
  colTemplate,
  onScrollX,
  analysisMode
}: {
  items: AnalysisQueueItem[]
  colTemplate: string
  onScrollX?: (scrollLeft: number) => void
  analysisMode: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(300)

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onScroll = () => {
      setScrollTop(el.scrollTop)
      if (onScrollX) onScrollX(el.scrollLeft)
    }
    el.addEventListener('scroll', onScroll)
    const resize = () => setHeight(el.clientHeight)
    resize()
    window.addEventListener('resize', resize)

    const observer = new ResizeObserver(() => {
      if (el) setHeight(el.clientHeight)
    })
    observer.observe(el)

    return () => {
      el.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', resize)
      observer.disconnect()
    }
  }, [onScrollX])

  const total = items.length
  const startIndex = Math.floor(scrollTop / ROW_HEIGHT)
  const visibleCount = Math.ceil(height / ROW_HEIGHT) + 4
  const endIndex = Math.min(total, startIndex + visibleCount)
  const offsetY = startIndex * ROW_HEIGHT
  const visibleItems = items
    .map((item, idx) => ({ item, index: idx + 1 }))
    .slice(startIndex, endIndex)

  return (
    <div ref={containerRef} className="w-full h-full overflow-y-auto overflow-x-hidden">
      <div
        style={{ height: Math.max(total * ROW_HEIGHT, height), minHeight: '100%', width: '100%' }}
      >
        <div style={{ transform: `translateY(${offsetY}px)` }}>
          {visibleItems.map(({ item, index }) => (
            <Row
              key={item.id}
              item={item}
              index={index}
              colTemplate={colTemplate}
              analysisMode={analysisMode}
            />
          ))}
        </div>
      </div>
    </div>
  )
}

export function getStageLabel(status: AnalysisQueueItem['status'], stage?: number): string {
  if (status === 'analyzing') {
    const s = stage ?? 0
    switch (s) {
      case 1:
        return `Stage 1 ${t('特征识别中')}`
      case 2:
        return `Stage 2 ${t('内容提取中')}`
      case 3:
        return `Stage 3 ${t('质量评分中')}`
      case 4:
        return `Stage 4 ${t('维度分析中')}`
      default:
        return `Stage 1 ${t('特征识别中')}`
    }
  }

  // 非正在分析状态：载入队列/恢复时已确定当前 stage，stage 为空显示 '-'
  if (stage === undefined || stage === null) return '-'

  switch (stage) {
    case 1:
      return `Stage 1 ${t('特征识别')}`
    case 2:
      return `Stage 2 ${t('内容提取')}`
    case 3:
      return `Stage 3 ${t('质量评分')}`
    case 4:
      return `Stage 4 ${t('维度分析')}`
    default:
      return t('未分析')
  }
}

function StatusBadge({ item }: { item: AnalysisQueueItem }) {
  const status = item.status
  const stage = item.analysisStage ?? (item.analysisStats as any)?.analysis_stage
  const isAnalyzing = status === 'analyzing'

  const label = getStageLabel(status, stage)

  let colorStyle = 'bg-muted text-muted-foreground'
  if (status === 'failed') {
    colorStyle = 'bg-destructive/10 text-destructive font-medium'
  } else if (isAnalyzing) {
    switch (stage) {
      case 2:
        // CPU 内容提取阶段：青/天蓝色
        colorStyle =
          'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border border-cyan-500/30 animate-pulse font-semibold'
        break
      case 3:
        // GPU AI 质量评分阶段：紫罗兰色
        colorStyle =
          'bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/30 animate-pulse font-semibold'
        break
      case 4:
        // GPU AI 维度分析阶段：主调靛蓝色
        colorStyle =
          'bg-primary/10 text-primary border border-primary/30 animate-pulse font-semibold'
        break
      case 1:
      default:
        colorStyle =
          'bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/30 animate-pulse font-semibold'
        break
    }
  } else if (status === 'completed') {
    colorStyle = 'bg-green-500/10 text-green-600 dark:text-green-400 font-medium'
  } else if (status === 'pending' && stage > 0) {
    colorStyle = 'bg-blue-500/10 text-blue-600 dark:text-blue-400 font-medium'
  }

  return (
    <span className={cn('text-xs px-2 py-0.5 rounded font-medium transition-colors', colorStyle)}>
      {label}
    </span>
  )
}

const Row = React.memo(
  function Row({
    item,
    index,
    colTemplate,
    analysisMode
  }: {
    item: AnalysisQueueItem
    index: number
    colTemplate: string
    analysisMode: string
  }) {
    const { deleteItem, addItems } = useAnalysisQueueStore()
    const retryOne = async () => {
      await addItems([{ path: item.path, name: item.name, size: item.size, type: item.type }], true)
    }

    const failedReason = item.isUnit
      ? t('已经有序，跳过分析，如需强制分析：请创建独立的工作目录')
      : item.status === 'failed'
        ? item.error || t('未知失败原因')
        : undefined

    return (
      <div
        className="w-full items-center px-2 border-b border-border/40 last:border-0 hover:bg-accent/40 transition-colors text-xs select-none"
        style={{
          display: 'grid',
          gridTemplateColumns: colTemplate,
          height: ROW_HEIGHT
        }}
      >
        <div className="text-center font-mono text-muted-foreground/70 px-1 truncate">{index}</div>
        <div className="truncate text-foreground font-medium pr-2" title={item.path}>
          {item.name}
        </div>
        <div className="px-1 truncate">
          <StatusBadge item={item} />
        </div>
        <div className="px-1 truncate text-center">
          <HistoryBadge
            stage={item.analysisStage ?? (item.analysisStats as any)?.analysis_stage}
            status={item.status}
            analysisMode={analysisMode}
          />
        </div>
        <div
          className={cn(
            'truncate font-medium px-1',
            item.isUnit ? 'text-amber-600 dark:text-amber-400' : 'text-destructive/80'
          )}
          title={failedReason || ''}
        >
          {failedReason || <span className="text-muted-foreground/30">—</span>}
        </div>
        <div className="flex justify-center text-xs px-1 truncate">
          {item.fromCache ? (
            <span className="text-green-500 font-bold text-sm" title={t('来自云端缓存')}>
              ✓
            </span>
          ) : item.status === 'completed' &&
            (item.analysisStats?.performance?.fresh?.durationMs !== undefined ||
              item.analysisStats?.durationMs !== undefined) ? (
            <span className="text-muted-foreground font-medium">
              {formatDuration(
                item.analysisStats?.performance?.fresh?.durationMs ?? item.analysisStats?.durationMs
              )}
            </span>
          ) : (
            <span className="text-muted-foreground/20">—</span>
          )}
        </div>
        <div className="text-xs px-1 truncate">
          {item.isUnit ? (
            <span
              title={t(
                '该目录为最小不可分割单元概率为{confidence}%，不对其内容进行单个分析。你可以将它创建为工作目录，才可继续分析。',
                {
                  confidence: Math.round((item.unitConfidence || 0) * 100)
                }
              )}
              className="inline-flex items-center gap-1"
            >
              <span className="px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 font-medium">
                {getUnitTypeLabel(item.unitType)}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground/50">—</span>
          )}
        </div>
        <div className="flex gap-2 justify-end pr-2 shrink-0">
          {item.status === 'failed' && (
            <button className="text-xs text-primary hover:underline font-medium" onClick={retryOne}>
              {t('重试')}
            </button>
          )}
          <button
            className="text-xs text-muted-foreground hover:text-destructive hover:underline transition-colors"
            onClick={() => deleteItem(item.id)}
          >
            {t('删除')}
          </button>
        </div>
      </div>
    )
  },
  (prev, next) => {
    return (
      prev.colTemplate === next.colTemplate &&
      prev.analysisMode === next.analysisMode &&
      prev.item.id === next.item.id &&
      prev.item.status === next.item.status &&
      prev.item.progress === next.item.progress &&
      prev.item.error === next.item.error &&
      prev.item.updatedAt === next.item.updatedAt &&
      prev.item.isUnit === next.item.isUnit &&
      prev.item.fromCache === next.item.fromCache &&
      prev.item.analysisStage === next.item.analysisStage
    )
  }
)

interface AnalysisQueueContentProps {
  mode?: 'split' | 'window' | 'modal'
  onClose?: () => void
  onHeaderMouseDown?: (e: React.MouseEvent) => void
}

const COL_KEYS: (keyof ColumnWidths)[] = [
  'index',
  'name',
  'status',
  'history',
  'reason',
  'stats',
  'unit',
  'actions'
]
const MIN_WIDTHS: Record<keyof ColumnWidths, number> = {
  index: 30,
  name: 80,
  status: 60,
  history: 50,
  reason: 80,
  stats: 60,
  unit: 60,
  actions: 60
}

export function AnalysisQueueContent({
  mode = 'split',
  onClose,
  onHeaderMouseDown
}: AnalysisQueueContentProps) {
  const {
    snapshot,
    start,
    pause,
    retryFailed,
    clearPending,
    clearAll,
    viewMode,
    setViewMode,
    setIsSplitOpen,
    setShowModal
  } = useAnalysisQueueStore()

  const { items, running } = snapshot
  const currentWs = useVirtualDirectoryStore(s => s.currentWorkspaceDirectory)
  const isCurrentWsRunning =
    running &&
    currentWs?.id !== undefined &&
    snapshot.activeRunningWorkspaceId !== undefined &&
    String(snapshot.activeRunningWorkspaceId) === String(currentWs.id)

  // 响应式读取分析模式：用于按分析模式判断文件完成 stage
  const analysisMode = useSettingsStore(
    s => (s.getConfigValue<string>('ANALYSIS_MODE') as string) ?? 'quick_name'
  )

  const [colWidths, setColWidths] = useState<ColumnWidths>(() => {
    const saved = localStorage.getItem('queue_col_widths')
    if (saved) {
      try {
        return { ...DEFAULT_COL_WIDTHS, ...JSON.parse(saved) }
      } catch (e) {}
    }
    return DEFAULT_COL_WIDTHS
  })

  const dragStartWidthsRef = useRef<{
    keyA: keyof ColumnWidths
    keyB: keyof ColumnWidths
    startA: number
    startB: number
  } | null>(null)

  const headerScrollRef = useRef<HTMLDivElement>(null)
  const tableContainerRef = useRef<HTMLDivElement>(null)

  // 容器大小改变时保持列宽和为 100% 容器宽度
  useEffect(() => {
    const el = tableContainerRef.current
    if (!el) return

    const observer = new ResizeObserver(entries => {
      const entry = entries[0]
      if (!entry) return
      const containerWidth = entry.contentRect.width
      if (containerWidth <= 0) return

      setColWidths(prev => {
        const currentSum = Object.values(prev).reduce((a, b) => a + b, 0)
        if (Math.abs(currentSum - containerWidth) < 2) return prev

        const ratio = containerWidth / currentSum
        const updated: ColumnWidths = {
          index: Math.max(MIN_WIDTHS.index, Math.round(prev.index * ratio)),
          name: Math.max(MIN_WIDTHS.name, Math.round(prev.name * ratio)),
          status: Math.max(MIN_WIDTHS.status, Math.round(prev.status * ratio)),
          history: Math.max(MIN_WIDTHS.history, Math.round(prev.history * ratio)),
          reason: Math.max(MIN_WIDTHS.reason, Math.round(prev.reason * ratio)),
          stats: Math.max(MIN_WIDTHS.stats, Math.round(prev.stats * ratio)),
          unit: Math.max(MIN_WIDTHS.unit, Math.round(prev.unit * ratio)),
          actions: Math.max(MIN_WIDTHS.actions, Math.round(prev.actions * ratio))
        }
        return updated
      })
    })

    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const handleResizeStart = (keyA: keyof ColumnWidths) => {
    const idxA = COL_KEYS.indexOf(keyA)
    const keyB = COL_KEYS[idxA + 1]
    if (keyB) {
      dragStartWidthsRef.current = {
        keyA,
        keyB,
        startA: colWidths[keyA],
        startB: colWidths[keyB]
      }
    }
  }

  const handleResize = (keyA: keyof ColumnWidths, deltaX: number) => {
    if (!dragStartWidthsRef.current || dragStartWidthsRef.current.keyA !== keyA) return
    const { keyB, startA, startB } = dragStartWidthsRef.current
    const minA = MIN_WIDTHS[keyA]
    const minB = MIN_WIDTHS[keyB]
    const combined = startA + startB

    let newA = startA + deltaX
    newA = Math.max(minA, Math.min(combined - minB, newA))
    const newB = combined - newA

    setColWidths(prev => {
      const updated = {
        ...prev,
        [keyA]: newA,
        [keyB]: newB
      }
      localStorage.setItem('queue_col_widths', JSON.stringify(updated))
      return updated
    })
  }

  const colTemplate = `${colWidths.index}px ${colWidths.name}px ${colWidths.status}px ${colWidths.history}px ${colWidths.reason}px ${colWidths.stats}px ${colWidths.unit}px 1fr`

  const handleModeSwitch = () => {
    const nextMode = viewMode === 'split' ? 'window' : 'split'
    setViewMode(nextMode)
  }

  const handleClose = () => {
    if (onClose) {
      onClose()
      return
    }
    if (mode === 'window') {
      window.electronAPI?.queueWindowControl?.('close')
    } else if (mode === 'split') {
      setIsSplitOpen(false)
    } else {
      setShowModal(false)
    }
  }

  return (
    <div className="flex flex-col h-full w-full bg-background text-foreground overflow-hidden">
      {/* 顶部控制头 */}
      <div
        className="flex items-center justify-between px-4 py-2 border-b border-border select-none shrink-0 bg-card/60 cursor-default"
        style={mode === 'window' ? ({ WebkitAppRegion: 'drag' } as React.CSSProperties) : undefined}
        onMouseDown={onHeaderMouseDown}
      >
        {/* 左侧标题与统计信息 (允许拖拽) */}
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold flex items-center gap-2">
            <span>{t('文件分析队列')}</span>
            {!isCurrentWsRunning && (
              <span className="text-xs font-normal text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                {snapshot.activeRunningWorkspaceId ? t('【排队中】') : t('【已暂停】')}
              </span>
            )}
          </h2>
          <span className="text-xs text-muted-foreground ml-2">
            {t('{count1} 项 · {count2} 单元', {
              count1: items.length,
              count2: items.filter(i => i.isUnit).length
            })}
          </span>
        </div>

        <div
          className="flex items-center gap-2"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          {/* 操作按钮反向顺序 */}
          {isCurrentWsRunning ? (
            <Button
              variant="destructive"
              size="sm"
              className="h-7 text-xs px-2 font-semibold"
              onClick={() => pause()}
            >
              <Pause className="w-3.5 h-3.5 mr-1" />
              {t('暂停')}
            </Button>
          ) : (
            <Button
              variant="default"
              size="sm"
              className="h-7 text-xs px-2 font-semibold"
              onClick={() => start()}
            >
              <Play className="w-3.5 h-3.5 mr-1" />
              {t('开始')}
            </Button>
          )}
          <Button variant="outline" size="sm" className="h-7 text-xs px-2" onClick={retryFailed}>
            <RotateCcw className="w-3 h-3 mr-1" />
            {t('重试失败')}
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-xs px-2" onClick={clearAll}>
            {t('清空队列')}
          </Button>
          <Button variant="outline" size="sm" className="h-7 text-xs px-2" onClick={clearPending}>
            <Trash2 className="w-3 h-3 mr-1" />
            {t('清空待处理')}
          </Button>

          {/* 分析模式切换提示 */}
          {(() => {
            const currentMode =
              useSettingsStore.getState().getConfigValue<string>('ANALYSIS_MODE') ?? 'quick_name'
            return (
              <span
                className="text-xs text-primary/80 hover:text-primary cursor-pointer transition-colors hidden md:inline-block ml-1"
                onClick={() => useSettingsStore.getState().openSettings(SettingsCategory.ANALYSIS)}
              >
                {currentMode === 'simple' || currentMode === 'document'
                  ? t('结果简陋？切为【快速命名】或【全面分析】')
                  : currentMode === 'quick_name'
                    ? t('需要评分描述？切为【全面分析】')
                    : t('分析太慢？切为【快速命名】或【简单分类】')}
              </span>
            )
          })()}

          {/* 模式切换按钮 (窗口模式 <-> 分栏模式) */}
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs gap-1.5 px-2 text-muted-foreground hover:text-foreground"
            onClick={handleModeSwitch}
            title={viewMode === 'split' ? t('切为独立窗口') : t('切为底部分栏')}
          >
            {viewMode === 'split' ? (
              <>
                <ExternalLink className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{t('独立窗口')}</span>
              </>
            ) : (
              <>
                <PanelBottom className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">{t('底部分栏')}</span>
              </>
            )}
          </Button>

          {/* 窗口独立模式控制按钮 */}
          {mode === 'window' && (
            <div className="flex items-center gap-1">
              <button
                className="p-1 hover:bg-muted rounded text-muted-foreground hover:text-foreground"
                onClick={() => window.electronAPI?.queueWindowControl?.('minimize')}
                title={t('最小化')}
              >
                <Minus className="w-3.5 h-3.5" />
              </button>
              <button
                className="p-1 hover:bg-muted rounded text-muted-foreground hover:text-foreground"
                onClick={() => window.electronAPI?.queueWindowControl?.('maximize')}
                title={t('最大化')}
              >
                <Square className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* 底部分栏模式的最小化/正常状态切换按钮 */}
          {mode === 'split' && (
            <button
              className="p-1 hover:bg-muted rounded text-muted-foreground hover:text-foreground"
              onClick={() =>
                useAnalysisQueueStore
                  .getState()
                  .setIsSplitMinimized(!useAnalysisQueueStore.getState().isSplitMinimized)
              }
              title={useAnalysisQueueStore.getState().isSplitMinimized ? t('展开') : t('最小化')}
            >
              {useAnalysisQueueStore.getState().isSplitMinimized ? (
                <Square className="w-3.5 h-3.5" />
              ) : (
                <Minus className="w-3.5 h-3.5" />
              )}
            </button>
          )}

          {/* 关闭/收起按钮 */}
          <button
            className="p-1 hover:bg-destructive/10 hover:text-destructive rounded text-muted-foreground transition-colors"
            onClick={handleClose}
            title={t('关闭')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 动态列宽表头与虚拟文件列表区 - 最小化状态下隐藏 */}
      {!useAnalysisQueueStore.getState().isSplitMinimized && (
        <div className="flex-1 p-2 min-h-0 overflow-hidden flex flex-col">
          <div
            ref={tableContainerRef}
            className="w-full h-full border border-border/60 rounded-lg bg-card/40 flex flex-col overflow-hidden"
          >
            {/* 列头表头 (支持相邻列宽度拖拽) */}
            <div
              ref={headerScrollRef}
              className="w-full text-xs font-semibold text-muted-foreground border-b border-border/40 shrink-0 bg-muted/20 select-none overflow-hidden"
            >
              <div
                className="w-full"
                style={{
                  display: 'grid',
                  gridTemplateColumns: colTemplate
                }}
              >
                <div className="relative px-2 py-2 text-center group flex items-center justify-center">
                  <span>#</span>
                  <ColumnResizeHandle
                    onResizeStart={() => handleResizeStart('index')}
                    onResize={delta => handleResize('index', delta)}
                  />
                </div>
                <div className="relative px-2 py-2 truncate group flex items-center">
                  <span>{t('文件名')}</span>
                  <ColumnResizeHandle
                    onResizeStart={() => handleResizeStart('name')}
                    onResize={delta => handleResize('name', delta)}
                  />
                </div>
                <div className="relative px-2 py-2 group flex items-center">
                  <span>{t('处理进度')}</span>
                  <ColumnResizeHandle
                    onResizeStart={() => handleResizeStart('status')}
                    onResize={delta => handleResize('status', delta)}
                  />
                </div>
                <div className="relative px-2 py-2 group flex items-center justify-center">
                  <span>{t('状态')}</span>
                  <ColumnResizeHandle
                    onResizeStart={() => handleResizeStart('history')}
                    onResize={delta => handleResize('history', delta)}
                  />
                </div>
                <div className="relative px-2 py-2 truncate group flex items-center">
                  <span>{t('失败/跳过原因')}</span>
                  <ColumnResizeHandle
                    onResizeStart={() => handleResizeStart('reason')}
                    onResize={delta => handleResize('reason', delta)}
                  />
                </div>
                <div className="relative px-2 py-2 text-center group flex items-center justify-center">
                  <span>{t('缓存/耗时')}</span>
                  <ColumnResizeHandle
                    onResizeStart={() => handleResizeStart('stats')}
                    onResize={delta => handleResize('stats', delta)}
                  />
                </div>
                <div className="relative px-2 py-2 group flex items-center">
                  <span>{t('最小单元')}</span>
                  <ColumnResizeHandle
                    onResizeStart={() => handleResizeStart('unit')}
                    onResize={delta => handleResize('unit', delta)}
                  />
                </div>
                <div className="relative px-2 py-2 text-right group flex items-center justify-end pr-3">
                  <span>{t('操作')}</span>
                </div>
              </div>
            </div>

            {/* 虚拟文件列表区 */}
            <div className="flex-1 min-h-0 overflow-hidden">
              <VirtualList
                items={items}
                colTemplate={colTemplate}
                analysisMode={analysisMode}
                onScrollX={scrollLeft => {
                  if (headerScrollRef.current) {
                    headerScrollRef.current.scrollLeft = scrollLeft
                  }
                }}
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
