import React, { useState, useEffect, useMemo } from 'react'
import { FileType } from '../types'
import { SystemFileIcon } from '../../../common/SystemFileIcon'
import { cn } from '../../../../lib/utils'
import { toSafeFileUrl } from './SearchListCard'
import { useVirtualDirectoryStore } from '../../../../stores/virtual-directory-store'

interface FileRowThumbnailProps {
  fileItem: FileType | null
  workspaceDirectoryPath?: string | null
  refreshKey?: number
  className?: string
  fallbackIconClassName?: string
}

/**
 * 通用缩略图路径解析器：支持绝对物理路径与以工作区为基准的相对路径
 * 对视频代表帧抽帧、PDF封面、PPTX封面及常见格式图片均能精准解析
 */
export function resolveThumbnailUrl(
  thumbnailPath?: string | null,
  filePath?: string | null,
  workspaceDirectoryPath?: string | null
): string {
  if (thumbnailPath && typeof thumbnailPath === 'string') {
    const thumb = thumbnailPath.trim()
    if (thumb) {
      const isAbs =
        /^[a-zA-Z]:[\\/]/.test(thumb) ||
        thumb.startsWith('/') ||
        thumb.startsWith('\\\\')

      if (isAbs) {
        return toSafeFileUrl(thumb)
      }

      let wsDir = workspaceDirectoryPath || ''
      if (!wsDir && filePath) {
        const virtIdx = filePath.indexOf('.VirtualDirectory')
        if (virtIdx > 0) {
          wsDir = filePath.substring(0, virtIdx).replace(/[\\/]+$/, '')
        } else {
          const lastSep = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
          if (lastSep > 0) {
            wsDir = filePath.substring(0, lastSep)
          }
        }
      }
      if (!wsDir) {
        try {
          wsDir = useVirtualDirectoryStore.getState().currentWorkspaceDirectory?.path || ''
        } catch {}
      }
      if (wsDir) {
        const cleanWs = wsDir.replace(/[\\/]+$/, '')
        const cleanThumb = thumb.replace(/^[\\/]+/, '')
        return toSafeFileUrl(`${cleanWs}/${cleanThumb}`)
      }
    }
  }

  // 若无独立生成缩略图，但属于常见网页原生支持渲染的图片格式，直接以原文件路径作为缩略图呈现
  if (filePath && typeof filePath === 'string') {
    const ext = filePath.split('.').pop()?.toLowerCase() || ''
    if (['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'svg', 'ico'].includes(ext)) {
      return toSafeFileUrl(filePath)
    }
  }

  return ''
}

/**
 * 文件列表行缩略图组件：
 * 具备 thumbnail（如视频代表帧、PDF封面、图片等）时优先展示 20×20 微缩图；
 * 缺失或加载失败时平滑回退至原有系统图标与默认文件图标。
 */
export const FileRowThumbnail: React.FC<FileRowThumbnailProps> = React.memo(({
  fileItem,
  workspaceDirectoryPath,
  refreshKey,
  className,
  fallbackIconClassName
}) => {
  const [imgError, setImgError] = useState(false)

  const rawThumb = fileItem?.thumbnailPath || (fileItem as any)?.thumbnail_path
  const url = useMemo(() => {
    if (!fileItem) return ''
    return resolveThumbnailUrl(
      rawThumb,
      fileItem.path,
      workspaceDirectoryPath || (fileItem as any)?.workspaceDirectoryPath
    )
  }, [rawThumb, fileItem?.path, workspaceDirectoryPath, (fileItem as any)?.workspaceDirectoryPath])

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
      className={cn('w-5 h-5 object-contain mr-2 flex-shrink-0', className, fallbackIconClassName)}
      fallback={
        <span className="material-icons text-primary mr-2 text-xl flex-shrink-0">
          description
        </span>
      }
    />
  )
})

FileRowThumbnail.displayName = 'FileRowThumbnail'
