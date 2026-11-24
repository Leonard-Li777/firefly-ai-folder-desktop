/**
 * 工作区设置「同构滑块」共享工具包
 *
 * 统一承载：
 * 1. 刻度标尺 ScaleTicksBar（绝对百分比定位、可选点击跳转）；
 * 2. 无闪回平滑滑动状态机 useSmoothSlider（拖拽期间锁死外部回写，松手/键盘变更才进入父级防抖提交通道）；
 * 3. 停靠点滑块行 PolicySliderRow（与「每个视频分析时长上限」完全同构的四行视觉：标题行 / 轨道行 / 刻度行 / 图例行）；
 * 4. 历史非标值保真的 useStickyStops。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '../../../lib/utils'

/** 时长上限/容量上限正向能量渐变（浅天蓝 → 品牌靛紫，越长代表覆盖范围越完整） */
export const VIDEO_COVERAGE_GRADIENT =
  'linear-gradient(90deg, #38bdf8 0%, #6366f1 55%, #8b5cf6 100%)'

export interface ScaleTickItem {
  /** 刻度对应的业务值（秒数 / 停靠点取值等） */
  value: number
  /** 刻度在标尺上的绝对位置百分比 [0..100] */
  pct: number
  label: string
  clickable?: boolean
}

export interface ScaleTicksBarProps {
  ticks: ReadonlyArray<ScaleTickItem>
  /** 可选：点击刻度跳转 */
  onSelect?: (value: number) => void
  /** 可选：当前选中值，用于高亮命中刻度 */
  activeValue?: number
}

/** 统一分段/等距刻度标尺（支持绝对百分比定位、像素级垂直对齐与可选点击跳转） */
export const ScaleTicksBar: React.FC<ScaleTicksBarProps> = ({ ticks, onSelect, activeValue }) => (
  <div className="relative h-4 text-[10px] text-muted-foreground/70 font-mono select-none">
    {ticks.map(tick => {
      const isFirst = tick.pct === 0
      const isLast = tick.pct === 100
      const isActive = activeValue !== undefined && activeValue === tick.value
      const posStyle = !isFirst && !isLast ? { left: `${tick.pct}%` } : undefined
      const alignClass = isFirst ? 'left-0' : isLast ? 'right-0' : '-translate-x-1/2'

      if (onSelect && tick.clickable !== false) {
        return (
          <button
            key={tick.pct}
            type="button"
            onClick={() => onSelect(tick.value)}
            style={posStyle}
            className={cn(
              'absolute top-0 leading-none transition-colors hover:text-primary cursor-pointer',
              alignClass,
              isActive && 'text-primary font-bold'
            )}
          >
            {tick.label}
          </button>
        )
      }

      return (
        <span
          key={tick.pct}
          style={posStyle}
          className={cn(
            'absolute top-0 leading-none',
            alignClass,
            isActive && 'text-primary font-semibold'
          )}
        >
          {tick.label}
        </span>
      )
    })}
  </div>
)

export function releaseCaptureQuietly(target: HTMLDivElement, pointerId: number) {
  try {
    if (target.hasPointerCapture?.(pointerId)) {
      target.releasePointerCapture?.(pointerId)
    }
  } catch {
    // 某些测试环境可能不支持 pointer capture
  }
}

export interface UseSmoothSliderOptions {
  value: number
  min: number
  max: number
  fallbackValue: number
  pctToValue: (pct: number) => number
  onCommit: (val: number) => void
}

/**
 * 共享无闪回平滑滑动状态机：
 * - 指针拖拽期间仅更新局部值（60fps），并锁死外部 value 回写，杜绝异步旧快照把滑块拉回旧位置；
 * - 松手才提交父级；键盘/辅助技术变更立即进入父级 500ms 防抖补丁通道（本 Hook 不再自带任何计时器，
 *   因而不存在卸载冲刷、跨工作区迟到提交、Tab 误保存等隐患）；
 * - pointerCancel 仅复位，绝不读取失效坐标、不提交；非主键点击不生效。
 */
export function useSmoothSlider({
  value,
  min,
  max,
  fallbackValue,
  pctToValue,
  onCommit
}: UseSmoothSliderOptions) {
  const [localValue, setLocalValue] = useState(value)
  const [isDragging, setIsDragging] = useState(false)
  const isDraggingRef = useRef(false)
  const lastDraggedRef = useRef<number | null>(null)
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit
  const pctToValueRef = useRef(pctToValue)
  pctToValueRef.current = pctToValue
  const valueRef = useRef(value)
  valueRef.current = value
  const trackRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!isDraggingRef.current) {
      setLocalValue(value)
    }
  }, [value])

  const safeValue =
    typeof localValue === 'number' && Number.isFinite(localValue) && localValue >= min
      ? Math.min(max, localValue)
      : fallbackValue

  const commitValue = useCallback((val: number) => {
    lastDraggedRef.current = null
    isDraggingRef.current = false
    setIsDragging(false)
    onCommitRef.current(val)
  }, [])

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const parsed = parseInt(e.target.value, 10)
    if (!Number.isFinite(parsed)) return
    const next = Math.min(max, Math.max(min, parsed))
    setLocalValue(next)
    onCommitRef.current(next)
  }

  const calcValueFromClientX = useCallback((clientX: number): number | null => {
    if (!Number.isFinite(clientX)) return null
    const el = trackRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0) return null
    const pct = ((clientX - rect.left) / rect.width) * 100
    return pctToValueRef.current(pct)
  }, [])

  const applyQuickSelect = useCallback(
    (val: number) => {
      const clamped = Math.min(max, Math.max(min, val))
      setLocalValue(clamped)
      commitValue(clamped)
    },
    [commitValue, min, max]
  )

  const handleTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // 拦截非主键点击（右键、中键不修改配置）
    if (typeof e.button === 'number' && e.button !== 0) return
    isDraggingRef.current = true
    setIsDragging(true)
    inputRef.current?.focus({ preventScroll: true })
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId)
    } catch {
      // 某些测试环境可能不支持 pointer capture
    }
    const next = calcValueFromClientX(e.clientX)
    if (next !== null) {
      lastDraggedRef.current = next
      setLocalValue(next)
    }
  }

  const handleTrackPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return
    const next = calcValueFromClientX(e.clientX)
    if (next !== null) {
      lastDraggedRef.current = next
      setLocalValue(next)
    }
  }

  const handleTrackPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return
    releaseCaptureQuietly(e.currentTarget, e.pointerId)
    const next = calcValueFromClientX(e.clientX)
    const finalValue = next ?? lastDraggedRef.current ?? safeValue
    setLocalValue(finalValue)
    commitValue(finalValue)
  }

  const handleTrackPointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return
    releaseCaptureQuietly(e.currentTarget, e.pointerId)
    isDraggingRef.current = false
    setIsDragging(false)
    lastDraggedRef.current = null
    setLocalValue(valueRef.current)
  }

  return {
    safeValue,
    isDragging,
    trackRef,
    inputRef,
    handleSliderChange,
    applyQuickSelect,
    handleTrackPointerDown,
    handleTrackPointerMove,
    handleTrackPointerUp,
    handleTrackPointerCancel
  }
}

/** 停靠点排序：正数（含 0）升序，-1（不限）恒为末位 */
function compareStops(a: number, b: number): number {
  if (a === -1) return b === -1 ? 0 : 1
  if (b === -1) return -1
  return a - b
}

/**
 * 历史非标值保真的停靠点：当前值不在标准停靠点内（如历史遗留 100 KB）时按实际值插入并保真展示；
 * 已出现过的非标值在组件生命周期内只增不减，避免用户拖离历史值后刻度下标漂移。
 */
export function useStickyStops(standard: ReadonlyArray<number>, current: number): number[] {
  const extraRef = useRef<Set<number>>(new Set())
  if (Number.isFinite(current) && current >= 0 && !standard.includes(current)) {
    extraRef.current.add(current)
  }
  const extraKey = Array.from(extraRef.current)
    .sort((a, b) => a - b)
    .join(',')
  return useMemo(
    () => [...standard, ...Array.from(extraRef.current)].sort(compareStops),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [standard, extraKey]
  )
}

function nearestStopIndex(stops: ReadonlyArray<number>, value: number): number {
  if (stops.length === 0) return 0
  let best = 0
  let bestDiff = Number.POSITIVE_INFINITY
  stops.forEach((s, i) => {
    const diff = Math.abs(s - value)
    if (diff < bestDiff) {
      best = i
      bestDiff = diff
    }
  })
  return best
}

export interface PolicySliderTick {
  value: number
  label: string
}

export interface PolicySliderRowProps {
  /** testid 前缀：派生 `${prefix}-track` / `-fill` / `-slider` / `-legend` */
  testIdPrefix: string
  title: string
  /** 标题旁附加节点（如帮助气泡） */
  titleExtra?: React.ReactNode
  /** 口径胶囊文案 */
  capsuleText: string
  /** 标题行右侧主数值渲染（入参为拖拽中的实时取值，保证数值与轨道同步） */
  renderValue: (liveValue: number) => React.ReactNode
  /** 停靠点取值列表（滑块在其下标上等距滑动） */
  stops: ReadonlyArray<number>
  /** 当前取值（必须来自 stops，找不到则取最近停靠点） */
  value: number
  onChange: (val: number) => void
  /** 刻度（取值必须存在于 stops） */
  ticks: ReadonlyArray<PolicySliderTick>
  /** 图例行渲染（入参为拖拽中的实时取值） */
  renderLegend: (liveValue: number) => {
    left: React.ReactNode
    badge: { paused: boolean; text: string }
  }
  className?: string
}

/**
 * 停靠点滑块行：与「每个视频分析时长上限」同构的四行视觉
 * Row1 标题行（主标题 + 口径胶囊 | 等宽主数值）/ Row2 h-3 蓝紫渐变轨道 / Row3 刻度行 / Row4 覆盖收益图例行
 */
export const PolicySliderRow: React.FC<PolicySliderRowProps> = React.memo(
  ({
    testIdPrefix,
    title,
    titleExtra,
    capsuleText,
    renderValue,
    stops,
    value,
    onChange,
    ticks,
    renderLegend,
    className
  }) => {
    const lastIdx = Math.max(0, stops.length - 1)
    const rawIdx = stops.indexOf(value)
    const currentIdx = rawIdx >= 0 ? rawIdx : nearestStopIndex(stops, value)

    const pctToIdx = useCallback(
      (pct: number) =>
        lastIdx === 0 ? 0 : Math.min(lastIdx, Math.max(0, Math.round((pct / 100) * lastIdx))),
      [lastIdx]
    )
    const commitIdx = useCallback(
      (idx: number) => {
        const next = stops[idx]
        if (next !== undefined) onChange(next)
      },
      [stops, onChange]
    )

    const {
      safeValue: safeIdx,
      isDragging,
      trackRef,
      inputRef,
      handleSliderChange,
      applyQuickSelect,
      handleTrackPointerDown,
      handleTrackPointerMove,
      handleTrackPointerUp,
      handleTrackPointerCancel
    } = useSmoothSlider({
      value: currentIdx,
      min: 0,
      max: lastIdx,
      fallbackValue: 0,
      pctToValue: pctToIdx,
      onCommit: commitIdx
    })

    const fillPct = lastIdx === 0 ? 0 : Number(((safeIdx / lastIdx) * 100).toFixed(2))
    const liveValue = stops[safeIdx] ?? value
    const activeValue = liveValue
    const legend = renderLegend(liveValue)
    const scaleTicks: ScaleTickItem[] = []
    for (const tick of ticks) {
      const idx = stops.indexOf(tick.value)
      if (idx < 0) continue
      scaleTicks.push({
        value: tick.value,
        pct: lastIdx === 0 ? 0 : Number(((idx / lastIdx) * 100).toFixed(2)),
        label: tick.label,
        clickable: true
      })
    }

    return (
      <div className={cn('space-y-2', className)}>
        {/* Row 1: 标题行（主标题 + 口径胶囊 | 大号等宽主数值） */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold text-foreground">{title}</span>
            {titleExtra}
            <span className="text-[10px] px-2 py-0.5 rounded-full font-medium bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-500/20">
              {capsuleText}
            </span>
          </div>
          <div className="flex items-baseline gap-1">{renderValue(liveValue)}</div>
        </div>

        {/* Row 2: 轨道行（h-3 同高圆角轨道 + 蓝紫正向能量渐变 + 滑块把手） */}
        <div
          ref={trackRef}
          data-testid={`${testIdPrefix}-track`}
          onPointerDown={handleTrackPointerDown}
          onPointerMove={handleTrackPointerMove}
          onPointerUp={handleTrackPointerUp}
          onPointerCancel={handleTrackPointerCancel}
          className="relative h-3 w-full bg-muted/60 rounded-full flex p-0.5 border border-border/40 cursor-pointer touch-none select-none focus-within:ring-2 focus-within:ring-primary/40"
        >
          <div
            data-testid={`${testIdPrefix}-fill`}
            style={{ width: `${fillPct}%`, backgroundImage: VIDEO_COVERAGE_GRADIENT }}
            className={cn('h-full rounded-full', !isDragging && 'transition-all duration-300')}
          />
          <span
            style={{ left: `${fillPct}%` }}
            className={cn(
              'pointer-events-none absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-4 w-4 rounded-full bg-background border-2 border-indigo-500 shadow-sm',
              !isDragging && 'transition-all duration-300'
            )}
          />
          <input
            ref={inputRef}
            type="range"
            data-testid={`${testIdPrefix}-slider`}
            aria-label={title}
            min={0}
            max={lastIdx}
            step={1}
            value={safeIdx}
            onChange={handleSliderChange}
            className="sr-only"
          />
        </div>

        {/* Row 3: 刻度行（支持点击快捷跳转） */}
        <ScaleTicksBar
          ticks={scaleTicks}
          onSelect={val => applyQuickSelect(stops.indexOf(val))}
          activeValue={activeValue}
        />

        {/* Row 4: 覆盖收益与大白话说明行 */}
        <div
          data-testid={`${testIdPrefix}-legend`}
          className="flex items-center justify-between text-[11px] text-muted-foreground pt-0.5 flex-wrap gap-2"
        >
          <span>🎯 {legend.left}</span>
          <span
            className={cn(
              'text-[10px] font-semibold font-mono',
              legend.badge.paused ? 'text-muted-foreground' : 'text-indigo-600 dark:text-indigo-400'
            )}
          >
            {legend.badge.paused ? '⏸️' : '✨'} {legend.badge.text}
          </span>
        </div>
      </div>
    )
  }
)
PolicySliderRow.displayName = 'PolicySliderRow'
