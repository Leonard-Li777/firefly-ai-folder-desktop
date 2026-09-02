import React, { useState } from 'react'
import { t } from '@app/languages'
import { EmptyState } from '../common/EmptyState'
import { PreviewToolbar } from './PreviewToolbar'
import { PreviewContent } from './PreviewContent'
import { usePreviewContent } from './hooks/usePreviewContent'
import { useFileMultimodalContent } from './hooks/useFileMultimodalContent'

interface FilePreviewPanelProps {
  className?: string
  children?: React.ReactNode
  onPreviewChange?: (isPreviewing: boolean, file: Record<string, unknown> | null) => void
  /** External initial/controlled state (optional), mainly for standalone previews */
  filePath?: string
  /** External initial/controlled state (optional), mainly for standalone previews */
  fileName?: string
  /** 文件扩展名（可选），提供时直接用于路由判断，否则从 fileName 中提取 */
  extension?: string
  /** Action on back button (optional), defaults to clearing internal state */
  onBack?: () => void
}

/**
 * 公用预览容器组件 FilePreviewPanel
 * 用于新窗口模式和 VirtualDirectory/AnalyzedDirectory 中统一管理文件预览。
 * 使用公共的 PreviewToolbar 和 PreviewContent 组件。
 */
export const FilePreviewPanel: React.FC<FilePreviewPanelProps> = ({
  className,
  children,
  onPreviewChange,
  filePath: externalFilePath,
  fileName: externalFileName,
  extension: externalExtension,
  onBack
}) => {
  const [previewFile, setPreviewFile] = useState<Record<string, unknown> | null>(null)

  /** 从文件路径提取扩展名 */
  const getExtFromPath = (p: string) => {
    const dot = p.lastIndexOf('.')
    return dot > 0 ? p.slice(dot + 1) : ''
  }

  const isControlled = !!externalFilePath
  /** FileItem 用 path，TreeView 节点用 originalPath */
  const filePath = isControlled
    ? externalFilePath
    : (previewFile?.path as string) || (previewFile?.originalPath as string) || ''
  const fileName = isControlled
    ? externalFileName || ''
    : (previewFile?.smartName as string) || (previewFile?.name as string) || ''
  /**
   * 扩展名获取优先级：
   * 1. 显式传入的 extension 字段
   * 2. 从 fileName（name 或 smartName）中提取
   * 3. 从 filePath 中提取（兜底）
   */
  const extension = isControlled
    ? externalExtension || getExtFromPath(fileName) || getExtFromPath(filePath)
    : (previewFile?.extension as string) || getExtFromPath(fileName) || getExtFromPath(filePath)

  // 使用公共的预览内容 hook
  const { showRawText, setShowRawText, rawTextContent, isTextLoading, isTextCapable, showSwitch } =
    usePreviewContent({ filePath: filePath || '', fileName, extension: extension || '' })

  const { multimodalContent } = useFileMultimodalContent(filePath || '')

  const handleBack = () => {
    onBack?.()
    setPreviewFile(null)
    onPreviewChange?.(false, null)
  }

  const handleFileDoubleClick = (file: Record<string, unknown>) => {
    setPreviewFile(file)
    onPreviewChange?.(true, file)
  }

  const isPreviewing = isControlled || previewFile

  return (
    <div className={`flex flex-col h-full overflow-hidden ${className || ''}`}>
      {/* 子组件（如FileList）容器，当有预览文件时隐藏但不卸载 */}
      {children && (
        <div
          className="flex-1 overflow-hidden flex flex-col"
          style={{ display: isPreviewing ? 'none' : 'flex' }}
        >
          {React.Children.map(children, child => {
            if (React.isValidElement(child)) {
              // Only inject onFileDoubleClick if child is a custom component, not a DOM element
              if (typeof child.type !== 'string') {
                return React.cloneElement(
                  child as React.ReactElement<{
                    onFileDoubleClick?: (file: Record<string, unknown>) => void
                  }>,
                  {
                    onFileDoubleClick: handleFileDoubleClick
                  }
                )
              }
            }
            return child
          })}
        </div>
      )}

      {/* 预览模式下的内容 */}
      {isPreviewing && filePath && (
        <div className="flex flex-col flex-1 h-full bg-background overflow-hidden">
          {/* 使用公共 PreviewToolbar，新窗口模式不显示模式切换按钮 */}
          <PreviewToolbar
            pageId="new-window"
            filePath={filePath}
            fileName={fileName}
            showSwitch={showSwitch}
            showRawText={showRawText}
            onToggleRawText={setShowRawText}
            showHint={!isControlled}
            hint={t('ESC 关闭')}
            showModeToggle={!isControlled}
            onClose={handleBack}
          />

          {/* 预览内容区 - flex-1 自动填满剩余空间，流式排版不限高度 */}
          <div className="flex-1 relative overflow-hidden">
            <PreviewContent
              filePath={filePath}
              fileName={fileName}
              extension={extension || ''}
              showRawText={showRawText}
              rawTextContent={rawTextContent}
              isTextLoading={isTextLoading}
              isTextCapable={isTextCapable}
              multimodalContent={multimodalContent}
            />
          </div>
        </div>
      )}

      {/* 不支持预览时显示空状态（仅用于非受控模式） */}
      {isPreviewing && !filePath && (
        <EmptyState
          icon="visibility_off"
          title={t('请选择文件进行预览')}
          description={t('双击文件即可预览')}
        />
      )}
    </div>
  )
}

export default FilePreviewPanel
