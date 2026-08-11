import React, { useMemo } from 'react'
import { HEADER_HEIGHT, SCROLLER_SELECTOR } from '../constants'
import { useDragSelectStore } from '../../../../stores/drag-select-store'

interface SelectionBoxProps {
  viewMode?: string
  scrollOffset: number
  containerRef: React.RefObject<HTMLDivElement | null>
}

export const SelectionBox: React.FC<SelectionBoxProps> = ({
  viewMode,
  scrollOffset,
  containerRef
}) => {
  // 通过 selector 订阅 store，拖拽过程中只有本组件跟随更新，不触发 FileList 重渲染
  const isDragging = useDragSelectStore(s => s.isDragging)
  const dragStart = useDragSelectStore(s => s.dragStart)
  const dragEnd = useDragSelectStore(s => s.dragEnd)

  const box = useMemo(() => {
    if (!isDragging || !dragStart || !dragEnd) return null

    const x1 = Math.min(dragStart.x, dragEnd.x)
    const x2 = Math.max(dragStart.x, dragEnd.x)

    // 转换为相对于视口的坐标进行渲染
    let currentScroll = scrollOffset
    if (containerRef.current) {
      const scrollers = containerRef.current.querySelectorAll(SCROLLER_SELECTOR)
      const scroller = Array.from(scrollers).find(
        s => s.scrollHeight > s.clientHeight
      ) as HTMLElement
      if (scroller && typeof scroller.scrollTop === 'number') {
        currentScroll = scroller.scrollTop
      }
    }

    const viewY1 = Math.min(dragStart.y, dragEnd.y) - currentScroll
    const viewY2 = Math.max(dragStart.y, dragEnd.y) - currentScroll

    // 在列表模式下，如果框选框上方在 Header 区域，裁剪它
    const hHeight = viewMode === 'list' || viewMode === 'table' || !viewMode ? HEADER_HEIGHT : 0
    const finalY1 = Math.max(viewY1, hHeight)
    const finalHeight = Math.max(0, viewY2 - finalY1)

    if (finalHeight <= 0) return null

    return (
      <div
        className="absolute border border-primary bg-primary/20 pointer-events-none z-[100]"
        style={{
          left: x1,
          top: finalY1,
          width: x2 - x1,
          height: finalHeight
        }}
      />
    )
  }, [isDragging, dragStart, dragEnd, viewMode, scrollOffset, containerRef])

  return box
}
