import React, { useState, useEffect, useMemo } from 'react'
import { FileType } from '../types'
import { SystemFileIcon } from '../../../common/SystemFileIcon'
import { cn } from '../../../../lib/utils'
import { resolveThumbnailUrl } from './thumbnail-url-utils'

export { toSafeFileUrl, resolveThumbnailUrl } from './thumbnail-url-utils'

interface FileRowThumbnailProps {
  fileItem: FileType | null
  workspaceDirectoryPath?: string | null
  refreshKey?: number
  className?: string
  fallbackIconClassName?: string
}

/**
 * 文件列表行缩略图组件：
 * 具备 thumbnail（如视频代表帧、PDF封面、图片等）时优先展示 20×20 微缩图；
 * 缺失或加载失败时平滑回退至原有系统图标与默认文件图标。
 */
export const FileRowThumbnail: React.FC<FileRowThumbnailProps> = React.memo(
  ({ fileItem, workspaceDirectoryPath, refreshKey, className, fallbackIconClassName }) => {
    const [imgError, setImgError] = useState(false)

    const rawThumb = fileItem?.thumbnailPath || (fileItem as any)?.thumbnail_path
    const url = useMemo(() => {
      if (!fileItem) return ''
      return resolveThumbnailUrl(
        rawThumb,
        fileItem.path,
        workspaceDirectoryPath || (fileItem as any)?.workspaceDirectoryPath
      )
    }, [
      rawThumb,
      fileItem?.path,
      workspaceDirectoryPath,
      (fileItem as any)?.workspaceDirectoryPath
    ])

    useEffect(() => {
      setImgError(false)
    }, [url])

    const finalUrl = url && refreshKey ? `${url}?t=${refreshKey}` : url

    if (finalUrl && !imgError) {
      return (
        <div
          className={cn(
            'w-5 h-5 mr-2 flex-shrink-0 flex items-center justify-center overflow-hidden rounded-[2px] bg-muted/20 border border-border/30',
            className
          )}
        >
          <img
            src={finalUrl}
            alt={fileItem?.name || ''}
            loading="lazy"
            className="w-full h-full object-cover"
            onError={() => setImgError(true)}
          />
        </div>
      )
    }

    return (
      <SystemFileIcon
        path={fileItem?.path}
        extension={fileItem?.extension}
        className={cn(
          'w-5 h-5 object-contain mr-2 flex-shrink-0',
          className,
          fallbackIconClassName
        )}
        fallback={
          <span className="material-icons text-primary mr-2 text-xl flex-shrink-0">
            description
          </span>
        }
      />
    )
  }
)

FileRowThumbnail.displayName = 'FileRowThumbnail'
