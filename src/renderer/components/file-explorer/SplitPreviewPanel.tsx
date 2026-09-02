import React, { useEffect } from 'react'
import { t } from '@app/languages'
import { MaterialIcon } from '../../lib/utils'
import { usePreviewOverlayStore } from '../../stores/preview-overlay-store'
import { PreviewToolbar } from './PreviewToolbar'
import { PreviewContent } from './PreviewContent'
import { usePreviewContent } from './hooks/usePreviewContent'
import { useFileMultimodalContent } from './hooks/useFileMultimodalContent'
import { SupportedFormats } from '../common/SupportedFormats'
import { PageId } from '../../constants/page-ids'
import { logger, LogCategory } from '@firefly/shared'

interface SplitPreviewPanelProps {
  /** 页面标识，用于隔离预览状态 */
  pageId: PageId
}

/**
 * 分栏预览面板
 * 在分栏模式下，右侧显示文件预览内容。
 * 每个页面通过 pageStates[pageId] 独立保存预览文件信息，切换页面不会导致其他页面的预览丢失。
 */
export const SplitPreviewPanel: React.FC<SplitPreviewPanelProps> = ({ pageId }) => {
  const filePath = usePreviewOverlayStore(s => s.filePath)
  const fileName = usePreviewOverlayStore(s => s.fileName)
  const extension = usePreviewOverlayStore(s => s.extension)
  const activePageId = usePreviewOverlayStore(s => s.activePageId)
  const getPagePreviewFile = usePreviewOverlayStore(s => s.getPagePreviewFile)
  const closePreview = usePreviewOverlayStore(s => s.closePreview)

  const isActive = activePageId === pageId

  // 从页面独立状态中读取文件信息，各页面互不干扰，切换页面不会导致非激活页面丢失预览
  const pageFile = getPagePreviewFile(pageId)
  const previewFilePath = pageFile?.filePath || ''
  const previewFileName = pageFile?.fileName || (isActive ? fileName : '')
  const previewExtension = pageFile?.extension || (isActive ? extension : '')

  const { showRawText, setShowRawText, rawTextContent, isTextLoading, isTextCapable, showSwitch } =
    usePreviewContent({
      filePath: previewFilePath,
      fileName: previewFileName,
      extension: previewExtension
    })

  const { multimodalContent } = useFileMultimodalContent(previewFilePath)

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closePreview(pageId)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [closePreview, pageId])

  if (!previewFilePath) {
    return (
      <div className="h-full flex flex-col items-center justify-start text-muted-foreground p-6 overflow-y-auto pt-8 select-none">
        <MaterialIcon icon="visibility" className="text-5xl mb-3 opacity-20 shrink-0" />
        <p className="text-sm font-medium mb-1 shrink-0">{t('选择一个文件以预览')}</p>
        <p className="text-xs text-muted-foreground/70 mb-2 shrink-0">
          {t('双击文件或单击文件列表中的项')}
        </p>
        <p className="text-xs text-muted-foreground/70 mb-5 shrink-0">{t('ESC关闭预览')}</p>
        <SupportedFormats />
      </div>
    )
  }

  return (
    <div className="h-full w-full flex flex-col overflow-hidden preview-scrollbar">
      <PreviewToolbar
        pageId={pageId}
        filePath={previewFilePath}
        fileName={previewFileName}
        showSwitch={showSwitch}
        showRawText={showRawText}
        onToggleRawText={setShowRawText}
      />

      <div className="flex-1 relative h-full mr-2 overflow-hidden">
        <PreviewContent
          filePath={previewFilePath}
          fileName={previewFileName}
          extension={previewExtension}
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

export default SplitPreviewPanel
