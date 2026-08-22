import React, { useEffect, useState } from 'react'
import { FileIconSize, getFileIconDataUrl } from '../../lib/file-icon-provider'

interface SystemFileIconProps {
  /** 文件完整路径（不存在路径时将直接渲染兜底图标） */
  path?: string | null
  /** 文件扩展名（用于扩展名缓存） */
  extension?: string | null
  /** 系统图标尺寸（Electron 枚举，决定图标原始分辨率） */
  iconSize?: FileIconSize
  /** img 元素 class */
  className?: string
  /** img 元素宽高样式（缺省时由 className 控制） */
  width?: number | string
  height?: number | string
  /** 系统图标获取失败/未就绪时的兜底内容 */
  fallback: React.ReactNode
}

/**
 * 系统/文件关联图标组件
 * 异步通过主进程 app.getFileIcon() 获取系统图标并以 DataURL 展示，
 * 获取失败时回退渲染 fallback（通常为 Material 图标）。
 */
export const SystemFileIcon: React.FC<SystemFileIconProps> = React.memo(
  ({ path, extension, iconSize = 'small', className, width, height, fallback }) => {
    const [dataUrl, setDataUrl] = useState<string | null>(null)

    useEffect(() => {
      let cancelled = false
      setDataUrl(null)
      if (!path) return
      getFileIconDataUrl(path, extension || undefined, iconSize).then(url => {
        if (!cancelled) setDataUrl(url)
      })
      return () => {
        cancelled = true
      }
    }, [path, extension, iconSize])

    if (!dataUrl) return <>{fallback}</>

    return (
      <img
        src={dataUrl}
        alt=""
        className={className}
        width={width}
        height={height}
        onError={() => setDataUrl(null)}
      />
    )
  }
)

SystemFileIcon.displayName = 'SystemFileIcon'
