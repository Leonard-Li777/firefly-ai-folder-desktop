import React, { useMemo } from 'react'
import { t } from '@app/languages'
import { MaterialIcon, cn } from '../../lib/utils'
import { getPreviewRouteType } from '../../lib/preview-utils'
import { FilePreview } from './FilePreview'
import { FlyfishPreview } from './FlyfishPreview'
import { SupportedFormats } from '../common/SupportedFormats'
import { TTSActionGroup } from '../common/TTSActionGroup'
import { logger, LogCategory } from '@firefly/shared'
import { useIsPrivateFile } from './hooks/useIsPrivateFile'

interface PreviewContentProps {
  filePath: string
  fileName: string
  extension: string
  /** 是否显示原文内容 */
  showRawText: boolean
  /** 原始文本内容 */
  rawTextContent: string | null
  /** 是否正在加载文本 */
  isTextLoading: boolean
  /** 是否支持文本显示 */
  isTextCapable: boolean
  /** 多模态描述内容 */
  multimodalContent?: string | null
  /** 视频播放跳转时间戳（秒） */
  currentTime?: number
  /** 视频高亮时间区间 [startSec, endSec] */
  highlightRange?: [number, number]
  /** 是否为私有工作目录（显式传入），未传入时通过所属工作区自动推断 */
  isPrivate?: boolean
  /** 工作目录类型（可选） */
  workspaceDirectoryType?: 'SPEEDY' | 'PRIVATE' | 'VDIR'
}

/**
 * 公共预览内容组件
 * 用于分栏模式、全屏模式、新窗口模式共享预览内容渲染
 */
export const PreviewContent: React.FC<PreviewContentProps> = ({
  filePath,
  fileName,
  extension,
  showRawText,
  rawTextContent,
  isTextLoading,
  isTextCapable,
  multimodalContent,
  currentTime,
  highlightRange,
  isPrivate: externalIsPrivate,
  workspaceDirectoryType
}) => {
  const isPrivateComputed = useIsPrivateFile({
    filePath,
    workspaceDirectoryType
  })
  const isPrivate = externalIsPrivate !== undefined ? externalIsPrivate : isPrivateComputed

  const routeType = useMemo(() => {
    const res = getPreviewRouteType(extension)
    return res
  }, [extension, filePath, fileName, showRawText, isTextCapable])

  // 显示原文模式
  if (showRawText && isTextCapable) {
    if (isTextLoading) {
      return (
        <div className="flex items-center justify-center h-full">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      )
    }
    if (rawTextContent !== null) {
      return (
        /* 预览内容的正文区 */
        <div className={cn('h-full w-full overflow-auto p-4 bg-muted/20', isPrivate && 'ph-no-capture')}>
          <pre className="text-[15px] whitespace-pre-wrap break-words text-foreground/90 dark:text-foreground/70 leading-8 tracking-wide font-sans selection:bg-primary/20">
            {rawTextContent}
          </pre>
        </div>
      )
    }
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        {t('无法读取文件内容')}
      </div>
    )
  }

  // Flyfish 预览
  if (routeType === 'flyfish') {
    return (
      <div className="w-full h-full flex flex-col overflow-y-auto">
        {/* 预览内容的正文区 */}
        <div className={cn('w-full flex-1 min-h-[300px]', isPrivate && 'ph-no-capture')}>
          <FlyfishPreview
            filePath={filePath}
            fileName={fileName}
            extension={extension}
            isPrivate={isPrivate}
          />
        </div>
        {/* 多模态描述文本区 */}
        {multimodalContent && (
          <div
            className={cn(
              'w-full max-w-2xl mx-auto my-4 px-4 py-3 bg-muted/40 rounded-lg border border-border/50 shrink-0 h-auto',
              isPrivate && 'ph-mask'
            )}
          >
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[11px] text-muted-foreground font-medium">{t('多模态描述')}</p>
              <TTSActionGroup
                text={multimodalContent}
                textId={`flyfish-multimodal-${filePath}`}
                filePath={filePath}
                fieldName="multimodalContent"
                defaultFileName={`${fileName}-description.wav`}
                compact
              />
            </div>
            <p
              className={cn(
                'text-xs text-foreground/80 whitespace-pre-wrap break-words leading-relaxed',
                isPrivate && 'ph-mask'
              )}
            >
              {multimodalContent}
            </p>
          </div>
        )}
      </div>
    )
  }

  // 原生预览
  if (routeType === 'native') {
    return (
      <FilePreview
        filePath={filePath}
        fileName={fileName}
        extension={extension}
        multimodalContent={multimodalContent}
        currentTime={currentTime}
        highlightRange={highlightRange}
        isPrivate={isPrivate}
        workspaceDirectoryType={workspaceDirectoryType}
      />
    )
  }

  // AI 分析标记为文本的文件
  if (isTextCapable) {
    if (isTextLoading) {
      return (
        <div className="flex items-center justify-center h-full">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
        </div>
      )
    }
    if (rawTextContent !== null) {
      return (
        /* 预览内容的正文区 */
        <div className={cn('h-full w-full overflow-auto p-4 bg-muted/20', isPrivate && 'ph-no-capture')}>
          <pre className="text-[15px] whitespace-pre-wrap break-words text-foreground/90 dark:text-foreground/70 leading-8 tracking-wide font-sans selection:bg-primary/20">
            {rawTextContent}
          </pre>
        </div>
      )
    }
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground">
        {t('无法读取文件内容')}
      </div>
    )
  }

  // 不支持的类型
  return (
    <div className="h-full flex flex-col items-center justify-start text-muted-foreground p-6 overflow-y-auto pt-8 select-none">
      <MaterialIcon icon="visibility_off" className="text-5xl mb-3 opacity-20 shrink-0" />
      <p className="text-sm font-medium mb-1 shrink-0">{t('当前文件类型暂不支持预览')}</p>
      <p className="text-xs text-muted-foreground/70 mb-2 shrink-0">
        {t('文件扩展名')}：{extension ? `${extension}` : t('无')}
      </p>

      <p className="text-xs text-muted-foreground/70 mb-5 shrink-0">{t('ESC关闭预览')}</p>

      <SupportedFormats />
    </div>
  )
}

export default PreviewContent
