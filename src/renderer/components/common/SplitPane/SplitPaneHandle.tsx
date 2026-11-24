import React, { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '../../../lib/utils'

export interface SplitPaneHandleProps {
  direction?: 'horizontal' | 'vertical'
  onResize: (delta: number) => void
  onDoubleClick: () => void
  onResizeEnd?: () => void
}

/** 热区默认向左右/上下各扩展的像素（Tailwind w-4 = 16px 的对称一半） */
const HIT_DEFAULT = 8
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
    if (x >= rect.right - scrollbarWidth && x < rect.right - 1) return true
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
  }, [enableIframes])

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
    [isHorizontal, disableIframes, cleanup]
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
      if (!isResizingRef.current || pointerIdRef.current === null) return
      const currentCoord = isHorizontal ? e.clientX : e.clientY
      const delta = currentCoord - startCoordRef.current
      if (delta !== 0) {
        onResizeRef.current(delta)
      }
      startCoordRef.current = currentCoord
    },
    [isHorizontal]
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
        className={cn('absolute z-10', isHorizontal ? 'top-0 bottom-0 cursor-col-resize' : 'left-0 right-0 cursor-row-resize')}
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
