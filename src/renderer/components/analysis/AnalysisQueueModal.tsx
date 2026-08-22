import React, { useRef, useState } from 'react'
import { useAnalysisQueueStore } from '../../stores/analysis-queue-store'
import { AnalysisQueueContent } from './AnalysisQueueContent'

export function AnalysisQueueModal() {
  const { showModal, setShowModal } = useAnalysisQueueStore()
  const [pos, setPos] = useState({ x: 0, y: 0 })
  const isDraggingRef = useRef(false)
  const startPosRef = useRef({ x: 0, y: 0 })

  if (!showModal) return null

  const handleHeaderMouseDown = (e: React.MouseEvent) => {
    isDraggingRef.current = true
    startPosRef.current = { x: e.clientX - pos.x, y: e.clientY - pos.y }

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!isDraggingRef.current) return
      setPos({
        x: moveEvent.clientX - startPosRef.current.x,
        y: moveEvent.clientY - startPosRef.current.y
      })
    }

    const handleMouseUp = () => {
      isDraggingRef.current = false
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm animate-fade-in pointer-events-auto">
      <div
        className="bg-background w-[900px] h-[550px] max-w-[95vw] max-h-[90vh] rounded-xl shadow-2xl overflow-hidden border border-border flex flex-col animate-scale-in"
        style={{ transform: `translate(${pos.x}px, ${pos.y}px)` }}
      >
        <AnalysisQueueContent
          mode="modal"
          onClose={() => setShowModal(false)}
          onHeaderMouseDown={handleHeaderMouseDown}
        />
      </div>
    </div>
  )
}
