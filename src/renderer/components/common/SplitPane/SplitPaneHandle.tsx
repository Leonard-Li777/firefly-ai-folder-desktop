import React, { useCallback, useEffect, useRef, useState } from 'react'
import { cn } from '../../../lib/utils'

interface SplitPaneHandleProps {
  onResize: (delta: number) => void
  onDoubleClick: () => void
}

/**
 * SplitPaneHandle — 可拖拽的分隔手柄
 *
 * 事件管理策略（混合模式）：
 * - handleMouseDown 直接调用 document.addEventListener 添加监听器，
 *   保证即时响应（测试中 fireEvent.mouseDown + fireEvent.mouseMove 也能正确工作）。
 * - useEffect cleanup 在组件卸载时移除监听器，兜底清理孤儿监听器。
 * - window.blur 事件兜底处理鼠标在浏览器外释放的场景。
 * - onResize 通过 ref 透传，避免原生监听器的闭包过期（#399）。
 *
 * iframe兼容策略：
 * - 拖拽开始时，给所有iframe添加pointer-events: none，阻止它们捕获鼠标事件
 * - 拖拽结束时，恢复iframe的pointer-events
 * - 使用capture阶段的事件监听器，确保事件能被捕获
 *
 * UI策略：
 * - 分隔线默认不占用布局空间（width: 0），通过overflow-visible显示视觉元素
 * - 鼠标hover时显示细线，按下时高亮加粗
 * - 使用负边距确保拖拽热区覆盖在面板边缘
 */
export const SplitPaneHandle: React.FC<SplitPaneHandleProps> = ({ onResize, onDoubleClick }) => {
  const startXRef = useRef(0)
  // 用 ref 持有最新的 onResize，避免原生 mousemove 监听器的闭包过期（#399）
  const onResizeRef = useRef(onResize)
  onResizeRef.current = onResize

  // 保存当前事件处理函数引用，供 useEffect cleanup 移除
  const mouseMoveRef = useRef<((e: MouseEvent) => void) | null>(null)
  const mouseUpRef = useRef<((e: MouseEvent) => void) | null>(null)
  const blurHandlerRef = useRef<(() => void) | null>(null)
  const [isResizing, setIsResizing] = useState(false)
  const [isHovering, setIsHovering] = useState(false)
  const isResizingRef = useRef(false)

  /**
   * 禁用所有iframe的鼠标事件，防止iframe捕获鼠标导致拖拽失效
   */
  const disableIframes = useCallback(() => {
    const iframes = document.querySelectorAll('iframe')
    iframes.forEach(iframe => {
      iframe.style.pointerEvents = 'none'
      // 存储原始值以便恢复
      iframe.dataset.prevPointerEvents = iframe.getAttribute('data-prev-pointer-events') || ''
    })
  }, [])

  /**
   * 恢复所有iframe的鼠标事件
   */
  const enableIframes = useCallback(() => {
    const iframes = document.querySelectorAll('iframe')
    iframes.forEach(iframe => {
      iframe.style.pointerEvents = ''
    })
  }, [])

  const cleanup = useCallback(() => {
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
    isResizingRef.current = false
    setIsResizing(false)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    document.body.classList.remove('split-pane-resizing')
    enableIframes()
  }, [enableIframes])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      startXRef.current = e.clientX
      isResizingRef.current = true
      setIsResizing(true)
      document.body.style.cursor = 'col-resize'
      document.body.style.userSelect = 'none'
      document.body.classList.add('split-pane-resizing')

      // 禁用iframe鼠标事件，防止iframe捕获导致拖拽失效
      disableIframes()

      const onMouseMove = (moveEvent: MouseEvent) => {
        // 使用ref检查是否仍在拖拽状态，避免释放后继续响应
        if (!isResizingRef.current) return

        const delta = moveEvent.clientX - startXRef.current
        if (delta !== 0) {
          onResizeRef.current(delta)
        }
        startXRef.current = moveEvent.clientX
      }

      const onMouseUp = () => {
        cleanup()
      }

      const onWindowBlur = () => {
        cleanup()
      }

      mouseMoveRef.current = onMouseMove
      mouseUpRef.current = onMouseUp
      blurHandlerRef.current = onWindowBlur

      // 使用capture阶段，确保在iframe之前捕获事件
      document.addEventListener('mousemove', onMouseMove, true)
      document.addEventListener('mouseup', onMouseUp, true)
      window.addEventListener('blur', onWindowBlur)
    },
    [cleanup, disableIframes]
  )

  const handleDoubleClickFn = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      onDoubleClick()
    },
    [onDoubleClick]
  )

  // 组件卸载时清理孤儿监听器
  useEffect(() => {
    return () => {
      cleanup()
    }
  }, [cleanup])

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      className={cn(
        'relative shrink-0',
        'w-0',
        'cursor-col-resize z-20',
        'flex items-center justify-center',
        'overflow-visible',
        'group',
        isResizing && 'z-30'
      )}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClickFn}
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
    >
      {/* 可视化分隔线 - 使用负边距使其居中 */}
      <div
        className={cn(
          'absolute top-0 bottom-0',
          'transition-all duration-150',
          // 默认显示细线
          'w-[1px] bg-border',
          // hover时加粗
          (isHovering || isResizing) && 'w-[2px] bg-border/60',
          // 按下时高亮加粗
          isResizing && 'w-[3px] bg-primary shadow-[0_0_8px_rgba(var(--primary),0.5)]'
        )}
        style={{
          left: '50%',
          transform: 'translateX(-50%)'
        }}
      />
      {/* 拖拽热区 - 增加可点击区域，覆盖在左右面板边缘 */}
      <div
        className={cn('absolute top-0 bottom-0', 'w-4', 'cursor-col-resize')}
        style={{
          left: '50%',
          transform: 'translateX(-50%)'
        }}
      />
    </div>
  )
}
