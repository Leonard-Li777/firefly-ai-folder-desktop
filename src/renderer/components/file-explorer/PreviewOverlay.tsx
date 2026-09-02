import React, { useEffect, useCallback, useRef } from 'react'
import { t } from '@app/languages'
import { usePreviewOverlayStore } from '../../stores/preview-overlay-store'
import { PreviewToolbar } from './PreviewToolbar'
import { PreviewContent } from './PreviewContent'
import { usePreviewContent } from './hooks/usePreviewContent'
import { useFileMultimodalContent } from './hooks/useFileMultimodalContent'

/**
 * 全局文件预览覆盖层
 * 固定在窗口之上，占满整个窗口。
 * 只在 isOpen 且 activePageId 有值时显示。
 */
export const PreviewOverlay: React.FC = () => {
  const isOpen = usePreviewOverlayStore(s => s.isOpen)
  const filePath = usePreviewOverlayStore(s => s.filePath)
  const fileName = usePreviewOverlayStore(s => s.fileName)
  const extension = usePreviewOverlayStore(s => s.extension)
  const activePageId = usePreviewOverlayStore(s => s.activePageId)
  const closePreview = usePreviewOverlayStore(s => s.closePreview)
  const containerRef = useRef<HTMLDivElement>(null)

  const { showRawText, setShowRawText, rawTextContent, isTextLoading, isTextCapable, showSwitch } =
    usePreviewContent({ filePath, fileName, extension })

  const { multimodalContent } = useFileMultimodalContent(filePath)

  // 处理 ESC 键关闭预览（支持 iframe 内部按 ESC）
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closePreview(activePageId)
      }
    },
    [activePageId, closePreview]
  )

  useEffect(() => {
    if (!isOpen || !activePageId) return
    // 在 capture 阶段监听，确保在 iframe 之前捕获
    window.addEventListener('keydown', handleKeyDown, true)
    return () => window.removeEventListener('keydown', handleKeyDown, true)
  }, [isOpen, activePageId, handleKeyDown])

  // 额外监听 message 事件，处理 iframe 内部发送的 ESC 事件
  useEffect(() => {
    if (!isOpen || !activePageId) return
    const handleMessage = (e: MessageEvent) => {
      if (e.data && e.data.type === 'flyfish-esc' && e.data.key === 'Escape') {
        closePreview(activePageId)
      }
    }
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [isOpen, activePageId, closePreview])

  // Electron 主进程 before-input-event 拦截 ESC（即使焦点在 iframe 内）
  // 同时监听 IPC 和 window 自定义事件，双保险
  useEffect(() => {
    if (!isOpen || !activePageId) return

    const handleClose = () => closePreview(activePageId)

    // 方式1：IPC 事件
    const cleanup = window.electronAPI?.onPreviewForceClose?.(handleClose)

    // 方式2：window 自定义事件（executeJavaScript 触发）
    window.addEventListener('preview:force-close', handleClose)

    return () => {
      if (typeof cleanup === 'function') cleanup()
      window.removeEventListener('preview:force-close', handleClose)
    }
  }, [isOpen, activePageId, closePreview])

  // 打开时自动聚焦容器，防止 iframe 捕获焦点
  useEffect(() => {
    if (isOpen && activePageId && containerRef.current) {
      containerRef.current.focus()
    }
  }, [isOpen, activePageId])

  if (!isOpen || !activePageId) return null

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-500 bg-background flex flex-col overflow-hidden preview-scrollbar outline-none"
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      tabIndex={-1}
      onKeyDown={e => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          closePreview(activePageId)
        }
      }}
    >
      <PreviewToolbar
        pageId={activePageId}
        fileName={fileName}
        showSwitch={showSwitch}
        showRawText={showRawText}
        onToggleRawText={setShowRawText}
        showHint={true}
        hint={t('ESC 返回')}
      />

      <div className="flex-1 relative h-full overflow-hidden">
        <PreviewContent
          filePath={filePath}
          fileName={fileName}
          extension={extension}
          showRawText={showRawText}
          rawTextContent={rawTextContent}
          isTextLoading={isTextLoading}
          isTextCapable={isTextCapable}
          multimodalContent={multimodalContent}
        />
      </div>
    </div>
  )
}
