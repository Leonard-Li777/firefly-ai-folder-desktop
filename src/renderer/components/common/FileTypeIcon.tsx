import React from 'react'
import { SystemFileIcon } from './SystemFileIcon'
import { getFileIcon } from '../file-explorer/FileItem'

/** 从路径或文件名中提取小写扩展名（不含点），无法识别时返回空字符串 */
export const extractFileExtension = (source?: string | null): string => {
  if (!source) return ''
  const match = source.match(/\.([A-Za-z0-9]+)$/)
  return match ? match[1].toLowerCase() : ''
}

interface FileTypeIconProps {
  /** 文件完整路径（用于获取系统图标；为空时直接渲染类型图标） */
  path?: string | null
  /** 文件扩展名（不含点，用于扩展名缓存与类型图标映射） */
  extension?: string
  /** 系统图标 img 的 class */
  className?: string
  /** 类型兜底图标的 class（Material 图标） */
  fallbackClassName?: string
}

/**
 * 文件类型图标组件
 * 优先展示系统/文件关联高清原生图标（通过 app.getFileIcon() 获取，large 尺寸保证高清屏清晰度），
 * 获取失败或未提供路径时回退为按扩展名分类的 Material 类型图标。
 */
export const FileTypeIcon: React.FC<FileTypeIconProps> = React.memo(
  ({ path, extension, className, fallbackClassName }) => (
    <SystemFileIcon
      path={path}
      extension={extension}
      iconSize="large"
      className={className}
      fallback={getFileIcon('file', extension, fallbackClassName)}
    />
  )
)

FileTypeIcon.displayName = 'FileTypeIcon'
