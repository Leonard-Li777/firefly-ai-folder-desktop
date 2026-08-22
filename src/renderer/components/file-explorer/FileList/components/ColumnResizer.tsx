import React, { useState, useCallback } from 'react'
import { cn } from '../../../../lib/utils'

interface ColumnResizerProps {
  onResize: (width: number) => void
  currentWidth: number
  minWidth?: number
}

export const ColumnResizer: React.FC<ColumnResizerProps> = ({
  onResize,
  currentWidth,
  minWidth = 50
}) => {
  const [isResizing, setIsResizing] = useState(false)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation() // 防止触发表头点击事件（排序）

    const startX = e.clientX
    const startWidth = currentWidth

    const onMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX
      onResize(Math.max(minWidth, startWidth + delta))
    }

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      setIsResizing(false)
      document.body.style.cursor = ''
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    setIsResizing(true)
    document.body.style.cursor = 'col-resize'
  }, [currentWidth, minWidth, onResize])

  // 组件卸载时清理全局事件监听
  React.useEffect(() => {
    return () => {
      // 这里的清理比较 trick，因为 onMouseMove/onMouseUp 在 handleMouseDown 闭包里
      // 但实际上 handleMouseDown 每次 render 都会变（依赖 currentWidth），
      // 所以如果正在拖动时组件卸载了，我们无法直接访问到那些 listener 除非把它们存到 ref
    }
  }, [])

  // 改进版：使用 ref 存储 listeners
  const listenersRef = React.useRef<{ move: any, up: any } | null>(null)

  const handleMouseDownFixed = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const startX = e.clientX
    const startWidth = currentWidth

    const onMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX
      onResize(Math.max(minWidth, startWidth + delta))
    }

    const onMouseUp = () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      listenersRef.current = null
      setIsResizing(false)
      document.body.style.cursor = ''
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    listenersRef.current = { move: onMouseMove, up: onMouseUp }
    setIsResizing(true)
    document.body.style.cursor = 'col-resize'
  }, [currentWidth, minWidth, onResize])

  React.useEffect(() => {
    return () => {
      if (listenersRef.current) {
        document.removeEventListener('mousemove', listenersRef.current.move)
        document.removeEventListener('mouseup', listenersRef.current.up)
        document.body.style.cursor = ''
      }
    }
  }, [])

  return (
    <div
      className={cn(
        "absolute -right-2 top-0 h-full w-4 cursor-col-resize z-20 group flex justify-center items-center",
        isResizing && "z-30"
      )}
      onMouseDown={handleMouseDownFixed}
      onClick={(e) => e.stopPropagation()}
    >
      <div className={cn(
        "h-1/2 w-[1px] bg-border/50 group-hover:bg-primary/50 transition-colors",
        isResizing && "bg-primary w-[2px] h-full"
      )} />
    </div>
  )
}
