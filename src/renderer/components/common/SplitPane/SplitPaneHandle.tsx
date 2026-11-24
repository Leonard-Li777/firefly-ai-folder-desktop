import React, { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '../../../lib/utils'

export interface SplitPaneHandleProps {
  direction?: 'horizontal' | 'vertical'
  onResize: (delta: number) => void
  onDoubleClick: () => void
  onResizeEnd?: () => void
}

/** 热区默认向左右/上下各扩展的像素（对称 6px，保证舒适拖拽命中且不干扰相邻面板滚动条） */
const HIT_DEFAULT = 6
/** 刚滚动完的瞬间拒绝接管 mousedown/pointerdown 的时间窗 */
const SCROLL_LOCK_MS = 120

/**
 * 判断 (x, y) 是否落在某个「垂直滚动容器的滚动条条带」上。
 */
function isOnVerticalScrollbar(x: number, y: number, exclude: HTMLElement | null): boolean {
  if (typeof document.elementsFromPoint !== 'function') return false

  for (const node of document.elementsFromPoint(x, y)) {
    const el = node as HTMLElement
    if (exclude && exclude.contains(el)) continue
    if (el.scrollHeight <= el.clientHeight + 1) continue

    const cs = getComputedStyle(el)
    const overflowY = cs.overflowY
    if (overflowY !== 'auto' && overflowY !== 'scroll' && overflowY !== 'overlay') continue

    const border = parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth)
    const scrollbarWidth = el.offsetWidth - el.clientWidth - border
    if (scrollbarWidth <= 0) continue

    const rect = el.getBoundingClientRect()
    // 当指针位于滚动条条带内部，但保留分割线中心边界 2px 安全操作区，避免分割线边缘 hover 抢夺或丢失焦点
    if (x >= rect.right - scrollbarWidth && x < rect.right - 2) return true
  }
  return false
}

/**
 * SplitPaneHandle — 可拖拽的分隔手柄
 * 支持水平与垂直双向、Pointer Events 与 Mouse Events 兼容、滚动条防抢夺与双击重置
 */
export const SplitPaneHandle: React.FC<SplitPaneHandleProps> = ({
  direction = 'horizontal',
  onResize,
  onDoubleClick,
  onResizeEnd
}) => {
  const rootRef = useRef<HTMLDivElement>(null)
  const isHorizontal = direction === 'horizontal'

  const startCoordRef = useRef(0)
  const onResizeRef = useRef(onResize)
  onResizeRef.current = onResize
  const onResizeEndRef = useRef(onResizeEnd)
  onResizeEndRef.current = onResizeEnd

  const [isResizing, setIsResizing] = useState(false)
  const isResizingRef = useRef(false)

  // 保存事件监听引用供 cleanup
  const mouseMoveRef = useRef<((e: MouseEvent) => void) | null>(null)
  const mouseUpRef = useRef<((e: MouseEvent) => void) | null>(null)
  const blurHandlerRef = useRef<(() => void) | null>(null)
  const pointerIdRef = useRef<number | null>(null)

  /** 拖拽热区 DOM 引用：hover 到滚动条条带上时动态设为 pointer-events:none，避免抢走原生滚动条的 hover/拖动 */
  const hitAreaRef = useRef<HTMLDivElement>(null)
  /** 滚动条穿透恢复监听：当热区 pointer-events:none 后，靠 document 级 pointermove 检测离开滚动条再恢复 */
  const scrollbarRestoreRef = useRef<((ev: PointerEvent) => void) | null>(null)

  const lastScrollAtRef = useRef(0)

  const disableIframes = useCallback(() => {
    const iframes = document.querySelectorAll('iframe')
    iframes.forEach(iframe => {
      iframe.style.pointerEvents = 'none'
      iframe.dataset.prevPointerEvents = iframe.getAttribute('data-prev-pointer-events') || ''
    })
  }, [])

  const enableIframes = useCallback(() => {
    const iframes = document.querySelectorAll('iframe')
    iframes.forEach(iframe => {
      iframe.style.pointerEvents = ''
    })
  }, [])

  /**
   * 恢复拖拽热区的指针响应（滚动条穿透态复位）。
   * 当热区因 hover 到滚动条被设为 pointer-events:none 后，
   * 移开滚动条时需要还原，让分隔线重新可拖拽。
   */
  const releaseScrollbarPenetration = useCallback(() => {
    if (scrollbarRestoreRef.current) {
      document.removeEventListener('pointermove', scrollbarRestoreRef.current, true)
      scrollbarRestoreRef.current = null
    }
    if (hitAreaRef.current) {
      hitAreaRef.current.style.pointerEvents = ''
    }
  }, [])

  /**
   * 让拖拽热区对指针透明，把 hover/拖动完全交还给原生滚动条。
   * 期间靠 document 级 pointermove 检测何时离开滚动条条带再恢复。
   */
  const applyScrollbarPenetration = useCallback(() => {
    if (!hitAreaRef.current) return
    hitAreaRef.current.style.pointerEvents = 'none'

    if (!scrollbarRestoreRef.current) {
      const onDocPointerMove = (ev: PointerEvent) => {
        // 拖拽进行中不做任何恢复，避免干扰 resize
        if (isResizingRef.current) return
        if (!isOnVerticalScrollbar(ev.clientX, ev.clientY, rootRef.current)) {
          releaseScrollbarPenetration()
        }
      }
      scrollbarRestoreRef.current = onDocPointerMove
      document.addEventListener('pointermove', onDocPointerMove, true)
    }
  }, [releaseScrollbarPenetration])

  const cleanup = useCallback(() => {
    if (pointerIdRef.current !== null && rootRef.current) {
      try {
        if (rootRef.current.hasPointerCapture(pointerIdRef.current)) {
          rootRef.current.releasePointerCapture(pointerIdRef.current)
        }
      } catch {
        // pointer already released
      }
      pointerIdRef.current = null
    }

    if (mouseMoveRef.current) {
      document.removeEventListener('mousemove', mouseMoveRef.current, true)
      mouseMoveRef.current = null
    }
    if (mouseUpRef.current) {
      document.removeEventListener('mouseup', mouseUpRef.current, true)
      mouseUpRef.current = null
    }
    if (blurHandlerRef.current) {
      window.removeEventListener('blur', blurHandlerRef.current)
      blurHandlerRef.current = null
    }

    // 退出时确保滚动条穿透态复位
    releaseScrollbarPenetration()

    if (isResizingRef.current) {
      isResizingRef.current = false
      setIsResizing(false)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      document.body.classList.remove('split-pane-resizing')
      if (rootRef.current) {
        rootRef.current.removeAttribute('data-resizing')
      }
      enableIframes()
      onResizeEndRef.current?.()
    }
  }, [enableIframes, releaseScrollbarPenetration])

  // 滚动锁：scroll 不冒泡，必须 capture 阶段挂在 document 上才能捕获所有后代滚动
  useEffect(() => {
    const onScroll = () => {
      lastScrollAtRef.current = performance.now()
    }
    document.addEventListener('scroll', onScroll, true)
    return () => document.removeEventListener('scroll', onScroll, true)
  }, [])

  const startDrag = useCallback(
    (clientX: number, clientY: number, pointerId?: number) => {
      startCoordRef.current = isHorizontal ? clientX : clientY
      isResizingRef.current = true
      setIsResizing(true)
      // 拖拽开始：确保热区恢复指针响应，避免穿透态残留影响 resize 命中
      releaseScrollbarPenetration()
      document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize'
      document.body.style.userSelect = 'none'
      document.body.classList.add('split-pane-resizing')
      if (rootRef.current) {
        rootRef.current.setAttribute('data-resizing', 'true')
      }

      disableIframes()

      if (pointerId !== undefined && rootRef.current?.setPointerCapture) {
        try {
          rootRef.current.setPointerCapture(pointerId)
          pointerIdRef.current = pointerId
        } catch {
          // pointer capture not supported or failed
        }
      }

      const onMove = (moveEvent: MouseEvent) => {
        if (!isResizingRef.current) return
        const currentCoord = isHorizontal ? moveEvent.clientX : moveEvent.clientY
        const delta = currentCoord - startCoordRef.current
        if (delta !== 0) {
          onResizeRef.current(delta)
        }
        startCoordRef.current = currentCoord
      }

      const onEnd = () => {
        cleanup()
      }

      mouseMoveRef.current = onMove
      mouseUpRef.current = onEnd
      blurHandlerRef.current = onEnd

      document.addEventListener('mousemove', onMove, true)
      document.addEventListener('mouseup', onEnd, true)
      window.addEventListener('blur', onEnd)
    },
    [isHorizontal, disableIframes, cleanup, releaseScrollbarPenetration]
  )

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      // 仅在明确传入了非 0 的 button 时才拦截（兼容单测缺省值）
      if (e.button !== undefined && e.button !== 0) return

      if (isHorizontal) {
        if (isOnVerticalScrollbar(e.clientX - 0.5, e.clientY, rootRef.current)) return
      }
      if (performance.now() - lastScrollAtRef.current < SCROLL_LOCK_MS) return

      e.preventDefault()
      e.stopPropagation()
      startDrag(e.clientX, e.clientY, e.pointerId)
    },
    [isHorizontal, startDrag]
  )

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== undefined && e.button !== 0) return
      // 如果已在拖拽状态，则跳过重复 mousedown
      if (isResizingRef.current) return

      if (isHorizontal) {
        if (isOnVerticalScrollbar(e.clientX - 0.5, e.clientY, rootRef.current)) return
      }
      if (performance.now() - lastScrollAtRef.current < SCROLL_LOCK_MS) return

      e.preventDefault()
      e.stopPropagation()
      startDrag(e.clientX, e.clientY)
    },
    [isHorizontal, startDrag]
  )

  const handlePointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!isResizingRef.current || pointerIdRef.current === null) {
        // 非拖拽态：hover 落在滚动条条带上时，让拖拽热区对指针透明，
        // 把滚动条的 hover/拖动完全交还给原生滚动条，杜绝分隔线抢夺指针
        if (isHorizontal && !isResizingRef.current) {
          if (isOnVerticalScrollbar(e.clientX, e.clientY, rootRef.current)) {
            applyScrollbarPenetration()
          }
        }
        return
      }
      const currentCoord = isHorizontal ? e.clientX : e.clientY
      const delta = currentCoord - startCoordRef.current
      if (delta !== 0) {
        onResizeRef.current(delta)
      }
      startCoordRef.current = currentCoord
    },
    [isHorizontal, applyScrollbarPenetration]
  )

  const handleDoubleClickFn = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      onDoubleClick()
    },
    [onDoubleClick]
  )

  useEffect(() => {
    return () => {
      cleanup()
    }
  }, [cleanup])

  return (
    <div
      ref={rootRef}
      role="separator"
      aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
      className={cn(
        'relative shrink-0 flex items-center justify-center overflow-visible group',
        isHorizontal ? 'w-0 h-full cursor-col-resize' : 'h-0 w-full cursor-row-resize',
        isResizing ? 'z-30' : 'z-20'
      )}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={cleanup}
      onPointerCancel={cleanup}
      onLostPointerCapture={cleanup}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClickFn}
    >
      {/* 可视化分隔线 */}
      <div
        className={cn(
          'absolute transition-all duration-150',
          isHorizontal ? 'top-0 bottom-0' : 'left-0 right-0',
          isHorizontal
            ? cn(
                'w-[1px] bg-border',
                'group-hover:w-[3px] group-hover:bg-primary group-hover:shadow-[0_0_8px_rgba(var(--primary),0.5)]',
                isResizing && 'w-[3px] bg-primary shadow-[0_0_8px_rgba(var(--primary),0.5)]'
              )
            : cn(
                'h-[1px] bg-border',
                'group-hover:h-[3px] group-hover:bg-primary group-hover:shadow-[0_0_8px_rgba(var(--primary),0.5)]',
                isResizing && 'h-[3px] bg-primary shadow-[0_0_8px_rgba(var(--primary),0.5)]'
              )
        )}
        style={
          isHorizontal
            ? { left: '50%', transform: 'translateX(-50%)' }
            : { top: '50%', transform: 'translateY(-50%)' }
        }
      />
      {/* 拖拽热区 */}
      <div
        ref={hitAreaRef}
        className={cn(
          'absolute z-10',
          isHorizontal ? 'top-0 bottom-0 cursor-col-resize' : 'left-0 right-0 cursor-row-resize'
        )}
        style={
          isHorizontal
            ? {
                left: -HIT_DEFAULT,
                right: -HIT_DEFAULT
              }
            : {
                top: -HIT_DEFAULT,
                bottom: -HIT_DEFAULT
              }
        }
      />
    </div>
  )
}
