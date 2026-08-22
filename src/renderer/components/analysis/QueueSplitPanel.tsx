import React, { useRef, useCallback } from 'react'
import { useAnalysisQueueStore } from '../../stores/analysis-queue-store'
import { AnalysisQueueContent } from './AnalysisQueueContent'
import { t } from '@app/languages'

export function QueueSplitPanel() {
  const { viewMode, isSplitOpen, splitHeight, setSplitHeight } = useAnalysisQueueStore()
  const isDraggingRef = useRef(false)
  const startYRef = useRef(0)
  const startHeightRef = useRef(0)

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      isDraggingRef.current = true
      startYRef.current = e.clientY
      startHeightRef.current = splitHeight

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!isDraggingRef.current) return
        const deltaY = startYRef.current - moveEvent.clientY
        const newHeight = startHeightRef.current + deltaY
        setSplitHeight(newHeight)
      }

      const handleMouseUp = () => {
        isDraggingRef.current = false
        window.removeEventListener('mousemove', handleMouseMove)
        window.removeEventListener('mouseup', handleMouseUp)
      }

      window.addEventListener('mousemove', handleMouseMove)
      window.addEventListener('mouseup', handleMouseUp)
    },
    [splitHeight, setSplitHeight]
  )
  const isSplitMinimized = useAnalysisQueueStore(s => s.isSplitMinimized)

  if (viewMode !== 'split' || !isSplitOpen) {
    return null
  }

  return (
    <div
      className="w-full flex flex-col border-t border-border bg-background relative z-20 shadow-lg transition-all duration-300"
      style={isSplitMinimized ? {} : { height: `${splitHeight}px` }}
    >
      {/* 拖拽分割线 Handle Bar - 最小化状态下隐藏或禁用拖拽 */}
      {!isSplitMinimized && (
        <div
          className="w-full h-2 cursor-row-resize bg-muted/60 hover:bg-primary/40 active:bg-primary transition-colors flex items-center justify-center shrink-0 select-none group"
          onMouseDown={handleMouseDown}
          title={t('拖拽改变分栏高度')}
        >
          <div className="w-12 h-1 rounded-full bg-border group-hover:bg-primary-foreground/60 transition-colors" />
        </div>
      )}

      {/* 分栏主体内容区 */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <AnalysisQueueContent mode="split" />
      </div>
    </div>
  )
}
