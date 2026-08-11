import React, { memo } from 'react'
import { cn, MaterialIcon } from '../../lib/utils'
import { t } from '@app/languages'
import { Checkbox } from '../ui/checkbox'
import { SystemFileIcon } from '../common/SystemFileIcon'
import type { FileItemProps } from '@firefly/types'
import {
  formatFileSize as sharedFormatFileSize,
  FileCategory,
  isCategory,
  formatDateTime
} from '@firefly/shared'

export const getFileIcon = (type: 'file' | 'directory', extension?: string, className?: string) => {
  if (type === 'directory') {
    return <MaterialIcon icon="folder" className={cn('text-6xl text-primary', className)} />
  }

  const iconMap: Record<string, string> = {
    // 文档类型
    txt: 'description',
    md: 'description',
    pdf: 'picture_as_pdf',
    doc: 'description',
    docx: 'description',
    xls: 'table_chart',
    xlsx: 'table_chart',
    ppt: 'slideshow',
    pptx: 'slideshow',

    // 代码类型
    js: 'code',
    ts: 'code',
    jsx: 'code',
    tsx: 'code',
    html: 'html',
    css: 'css',
    scss: 'css',
    json: 'code',
    xml: 'code',
    yaml: 'code',
    yml: 'code',

    // 图片类型
    jpg: 'image',
    jpeg: 'image',
    png: 'image',
    gif: 'image',
    svg: 'image',
    bmp: 'image',
    webp: 'image',

    // 音频类型
    mp3: 'music_note',
    wav: 'music_note',
    flac: 'music_note',
    aac: 'music_note',
    ogg: 'music_note',

    // 视频类型
    mp4: 'videocam',
    avi: 'videocam',
    mkv: 'videocam',
    mov: 'videocam',
    wmv: 'videocam',

    // 压缩类型
    zip: 'archive',
    rar: 'archive',
    '7z': 'archive',
    tar: 'archive',
    gz: 'archive'
  }

  return (
    <MaterialIcon
      icon={iconMap[extension?.toLowerCase() || ''] || 'insert_drive_file'}
      className={cn('text-6xl text-muted-foreground dark:text-muted-foreground', className)}
    />
  )
}

export const formatFileSize = (bytes: number | undefined | null): string => {
  // 处理无效输入：undefined、null、NaN 或负数
  if (bytes === undefined || bytes === null || isNaN(bytes) || bytes < 0) {
    return '-'
  }
  // 0 字节的文件显示 '0 B'
  if (bytes === 0) {
    return '0 B'
  }
  return sharedFormatFileSize(bytes)
}

const formatDate = (date: Date): string => {
  try {
    return formatDateTime(date)
  } catch (e) {
    return '-'
  }
}

const getFileType = (extension?: string): string => {
  const typeMap: Record<string, string> = {
    txt: t('文本文件'),
    md: t('Markdown文档'),
    pdf: t('PDF文档'),
    doc: t('Word文档'),
    docx: t('Word文档'),
    xls: t('Excel表格'),
    xlsx: t('Excel表格'),
    ppt: 'PowerPoint',
    pptx: 'PowerPoint',
    js: t('JavaScript文件'),
    ts: t('TypeScript文件'),
    jsx: t('React组件'),
    tsx: t('React组件'),
    html: t('HTML文件'),
    css: t('CSS样式表'),
    jpg: t('JPEG图片'),
    png: t('PNG图片'),
    gif: t('GIF图片'),
    mp3: t('MP3音频'),
    mp4: t('MP4视频'),
    zip: t('压缩文件')
  }
  return typeMap[extension?.toLowerCase() || ''] || t('文件')
}

const getAnalysisStatusIcon = (status?: string) => {
  switch (status) {
    case 'pending':
      return <MaterialIcon icon="pending" className="text-sm text-yellow-500" />
    case 'analyzing':
      return <MaterialIcon icon="sync" className="text-sm text-blue-500 animate-spin" />
    case 'completed':
      return <MaterialIcon icon="check_circle" className="text-sm text-green-500" />
    case 'failed':
      return <MaterialIcon icon="error" className="text-sm text-red-500" />
    default:
      return null
  }
}

interface ExtendedFileItemProps {
  type: 'file' | 'directory'
  name: string
  path: string
  isSelected: boolean
  onSelect: (path: string, selected: boolean) => void
  onDoubleClick: () => void
  size: number
  modifiedAt: Date
  extension?: string
  viewMode?: 'list' | 'grid' | 'table'
  analysisStatus?: string
  status?: number
  thumbnailPath?: string
  workspaceDirectoryPath?: string
  refreshKey?: number
}

export const FileItem: React.FC<ExtendedFileItemProps> = memo(
  ({
    type,
    name,
    path,
    isSelected,
    onSelect,
    onDoubleClick,
    size,
    modifiedAt,
    extension,
    viewMode = 'table',
    analysisStatus,
    status,
    thumbnailPath,
    workspaceDirectoryPath,
    refreshKey
  }) => {
    const fallbackIcon = getFileIcon(type, extension)
    const icon =
      type === 'file' ? (
        <SystemFileIcon
          path={path}
          extension={extension}
          iconSize="normal"
          className="w-8 h-8 object-contain"
          fallback={fallbackIcon}
        />
      ) : (
        fallbackIcon
      )
    const fileSize = type === 'file' ? formatFileSize(size) : '-'
    const modifiedDate = formatDate(modifiedAt)
    const fileType = type === 'directory' ? t('文件夹') : getFileType(extension)

    const isImageFile = (ext?: string) => {
      if (!ext) return false
      return isCategory(ext, FileCategory.IMAGE)
    }

    const displayUrl = React.useMemo(() => {
      let baseUrl = ''
      const { normalizeForCache } = window.electronAPI!.utils

      if (type === 'file' && isImageFile(extension) && workspaceDirectoryPath && path) {
        const normalizedDirPath = normalizeForCache(workspaceDirectoryPath)
        const normalizedFilePath = normalizeForCache(path)
        baseUrl = `file://${normalizedDirPath}/${normalizedFilePath}`
      } else if (thumbnailPath && workspaceDirectoryPath) {
        const normalizedDirPath = normalizeForCache(workspaceDirectoryPath)
        const normalizedThumbPath = normalizeForCache(thumbnailPath)
        baseUrl = `file://${normalizedDirPath}/${normalizedThumbPath}`
      } else {
        return null
      }

      // 添加 refreshKey 绕过浏览器缓存
      return refreshKey ? `${baseUrl}?t=${refreshKey}` : baseUrl
    }, [thumbnailPath, workspaceDirectoryPath, path, extension, refreshKey])

    if (viewMode === 'table') {
      return (
        <tr
          className={cn(
            'hover:bg-muted/50 transition-colors cursor-pointer file-row border-b border-border/50',
            isSelected && 'bg-accent hover:bg-accent/80',
            status === 0 && 'bg-red-500/10 dark:bg-red-950/30 hover:bg-red-500/20 border-red-500/30'
          )}
          onClick={e => {
            if (!(e.target as HTMLElement).closest('button[role="checkbox"]')) {
              onSelect(path, !isSelected)
            }
          }}
          onDoubleClick={onDoubleClick}
          title={status === 0 ? t('原文件已在磁盘上丢失或被移动') : t('双击打开')}
        >
          <td className="p-3 w-10">
            <Checkbox
              checked={isSelected}
              onCheckedChange={checked => {
                onSelect(path, !!checked)
              }}
              onClick={e => e.stopPropagation()}
              title={isSelected ? t('取消选择') : t('选择此项')}
            />
          </td>
          <td className="p-3 flex items-center">
            <span className="mr-3 text-muted-foreground">{icon}</span>
            <span className="font-medium text-foreground" title={name}>
              {name}
            </span>
            {status === 0 && (
              <span className="ml-2 inline-flex items-center gap-1 text-[10px] font-semibold text-red-600 dark:text-red-400 bg-red-100 dark:bg-red-950/80 px-1.5 py-0.5 rounded border border-red-300 dark:border-red-800">
                {t('已丢失')}
              </span>
            )}
          </td>
          <td className="p-3">
            {analysisStatus && (
              <div
                className="flex items-center space-x-1"
                title={t(
                  `分析状态: ${
                    analysisStatus === 'pending'
                      ? t('等待中')
                      : analysisStatus === 'analyzing'
                        ? t('分析中')
                        : analysisStatus === 'completed'
                          ? t('已完成')
                          : t('失败')
                  }`
                )}
              >
                {getAnalysisStatusIcon(analysisStatus)}
                <span className="text-xs font-medium text-muted-foreground">
                  {analysisStatus === 'pending' && t('等待中')}
                  {analysisStatus === 'analyzing' && t('分析中')}
                  {analysisStatus === 'completed' && t('已完成')}
                  {analysisStatus === 'failed' && t('失败')}
                </span>
              </div>
            )}
          </td>
          <td className="p-3 text-sm text-muted-foreground whitespace-nowrap">{modifiedDate}</td>
          <td className="p-3 text-sm text-muted-foreground whitespace-nowrap">{fileType}</td>
          <td className="p-3 text-sm text-muted-foreground whitespace-nowrap font-mono">
            {fileSize}
          </td>
        </tr>
      )
    }

    if (viewMode === 'list' || viewMode === 'grid') {
      return (
        <div
          className={cn(
            'file-item group relative',
            viewMode === 'list'
              ? 'flex items-center px-3 py-2 border-b border-border/50'
              : 'flex flex-col items-center p-4 rounded-xl border border-border/50',
            'hover:bg-muted/50 cursor-pointer transition-all duration-200',
            isSelected && 'bg-accent border-primary/20 ring-1 ring-primary/10',
            status === 0 && 'bg-red-500/10 dark:bg-red-950/30 border-red-500/30 hover:bg-red-500/20'
          )}
          onClick={e => {
            if (!(e.target as HTMLElement).closest('button[role="checkbox"]')) {
              onSelect(path, !isSelected)
            }
          }}
          onDoubleClick={onDoubleClick}
        >
          <div
            className={cn(
              'absolute z-10',
              viewMode === 'list'
                ? 'left-2'
                : 'top-3 left-3 opacity-0 group-hover:opacity-100 transition-opacity',
              isSelected && 'opacity-100'
            )}
          >
            <Checkbox
              checked={isSelected}
              onCheckedChange={checked => {
                onSelect(path, !!checked)
              }}
              onClick={e => e.stopPropagation()}
            />
          </div>

          <div
            className={cn(
              'flex items-center justify-center overflow-hidden rounded bg-muted/30',
              viewMode === 'list'
                ? 'w-10 h-10 ml-8 mr-3'
                : 'w-24 h-24 mb-3 transition-transform group-hover:scale-105'
            )}
          >
            {displayUrl ? (
              <img
                src={displayUrl}
                alt={name}
                className="w-full h-full object-cover"
                loading="lazy"
                onError={e => {
                  e.currentTarget.style.display = 'none'
                }}
              />
            ) : (
              <div className={viewMode === 'list' ? 'scale-50' : 'scale-100'}>{icon}</div>
            )}
          </div>

          <div
            className={cn(
              'flex flex-col min-w-0',
              viewMode === 'list' ? 'flex-1' : 'items-center w-full'
            )}
          >
            <span
              className={cn(
                'font-medium text-foreground truncate w-full',
                viewMode === 'grid' && 'text-center text-sm'
              )}
              title={name}
            >
              {name}
            </span>
            {viewMode === 'list' && (
              <div className="flex items-center space-x-3 mt-0.5 text-xs text-muted-foreground">
                <span>{fileSize}</span>
                <span>{modifiedDate}</span>
              </div>
            )}
          </div>

          {analysisStatus && (
            <div
              className={cn(
                'flex items-center',
                viewMode === 'list' ? 'ml-auto' : 'absolute top-3 right-3'
              )}
            >
              {getAnalysisStatusIcon(analysisStatus)}
            </div>
          )}
        </div>
      )
    }

    return null
  }
)

FileItem.displayName = 'FileItem'
