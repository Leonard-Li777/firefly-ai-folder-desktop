import { FileCategory, getFileCategory } from '@firefly/shared'
import React, { useEffect, useRef, useState } from 'react'

import { Button } from '../ui/button'
import { EmptyState } from '../common/EmptyState'
import { MaterialIcon } from '../../lib/utils'
import { t } from '@app/languages'
import {
  formatVideoTimestamp,
  clampVideoTime,
  computeHighlightPercent
} from '../../lib/video-preview-utils'

interface FilePreviewProps {
  filePath: string
  fileName: string
  extension?: string
  multimodalContent?: string | null
  /** 视频播放跳转时间戳（秒） */
  currentTime?: number
  /** 视频切片高亮时间区间 [startSec, endSec] */
  highlightRange?: [number, number]
}

export const FilePreview: React.FC<FilePreviewProps> = ({
  filePath,
  fileName,
  extension,
  multimodalContent,
  currentTime,
  highlightRange
}) => {
  const category = extension ? getFileCategory('file.' + extension) : getFileCategory(fileName)
  const [textContent, setTextContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isTextFile, setIsTextFile] = useState<boolean | null>(null)
  const [isTruncated, setIsTruncated] = useState(false)
  const [fileSize, setFileSize] = useState(0)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [videoDuration, setVideoDuration] = useState<number>(0)

  // 切换文件路径时重置视频时长
  useEffect(() => {
    setVideoDuration(0)
  }, [filePath])

  const jumpToTime = (targetTime: number) => {
    if (!videoRef.current) return
    const duration = videoRef.current.duration
    const safeTime = clampVideoTime(targetTime, duration)
    videoRef.current.currentTime = safeTime
    // 保持系统原声输出
    videoRef.current.muted = false
  }

  const handleVideoLoadedMetadata = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget
    // 保持系统原声输出
    v.muted = false
    const validDuration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0
    setVideoDuration(validDuration)
    if (typeof currentTime === 'number' && Number.isFinite(currentTime)) {
      const safeTime = clampVideoTime(currentTime, validDuration)
      v.currentTime = safeTime
    }
  }

  // 监听外部跳转时间戳变化（如从搜索列表切换命中切片）
  useEffect(() => {
    if (category === FileCategory.VIDEO && typeof currentTime === 'number' && videoRef.current) {
      jumpToTime(currentTime)
    }
  }, [currentTime, category])

  useEffect(() => {
    if (category !== FileCategory.UNKNOWN) {
      setIsTextFile(null)
      return
    }
    window.electronAPI
      ?.getFileAnalysisResult?.(filePath)
      ?.then(result => setIsTextFile(result?.category?.is_text ?? false))
      ?.catch(() => setIsTextFile(false))
  }, [filePath, category])

  const isTextCapable =
    category === FileCategory.TEXT ||
    category === FileCategory.EBOOK ||
    category === FileCategory.CODE ||
    (category === FileCategory.UNKNOWN && isTextFile === true)

  useEffect(() => {
    if (!isTextCapable) return
    setLoading(true)
    setIsTruncated(false)
    setFileSize(0)

    const loadTextContent = async () => {
      try {
        // 走 preview/read-text-limit IPC：读取上限 100KB 字节，
        // 超过上限时截断并标记 isTruncated，避免对大文件整体读取与解码导致预览卡顿
        const readResult = await window.electronAPI?.preview?.readTextLimit?.(filePath, 100000)
        if (!readResult || !readResult.success) {
          throw new Error(readResult?.error || t('readTextLimit 返回失败'))
        }
        setTextContent(readResult.text)
        setIsTruncated(!!readResult.isTruncated)
        if (readResult.size) setFileSize(readResult.size)
      } catch (err) {
        setError(t('无法读取文件内容'))
        console.error(err)
      } finally {
        setLoading(false)
      }
    }

    loadTextContent()
  }, [filePath, isTextCapable])

  const handleOpenExternal = () => {
    window.electronAPI?.utils?.openFileWithDefaultApp?.(filePath)
  }

  const handleShowInFolder = () => {
    window.electronAPI.utils.showItemInFolder(filePath)
  }

  const fileUrl = React.useMemo(() => {
    const raw = window.electronAPI?.utils
      ? window.electronAPI.utils.normalizeForCache(filePath)
      : filePath
    // 转为 file:// URL，编码非 ASCII 字符
    const normalized = raw.replace(/\\/g, '/')
    const encoded = normalized
      .split('/')
      .map((seg, i) => {
        if (i === 0 && /^[a-zA-Z]:$/.test(seg)) return seg
        // eslint-disable-next-line no-control-regex
        return /^[\x00-\x7F]*$/.test(seg) ? seg : encodeURIComponent(seg)
      })
      .join('/')
    return `file://${encoded.startsWith('/') ? '' : '/'}${encoded}`
  }, [filePath])

  const fileExt = filePath.split('.').pop()?.toUpperCase() || 'UNKNOWN'

  const formatSize = (bytes: number) => {
    if (!bytes) return '0 Bytes'
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
  }

  if (category === FileCategory.UNKNOWN && isTextFile === null) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <MaterialIcon icon="error_outline" className="text-4xl mb-2" />
        <p>{error}</p>
      </div>
    )
  }

  const renderUnsupported = () => (
    <EmptyState
      icon="visibility_off"
      title={t('当前文件类型（.{ext}）暂不支持预览', { ext: fileExt })}
      description={t(
        '该格式暂无内置预览插件，我们将持续拓展支持的类型。建议您使用外部默认关联程序打开查看。'
      )}
    >
      <div className="flex items-center gap-3">
        <Button
          onClick={handleOpenExternal}
          variant="outline"
          className="font-bold rounded-xl shadow-md"
        >
          <MaterialIcon icon="open_in_new" className="mr-1.5 text-sm" />
          {t('用系统默认程序打开')}
        </Button>
        <Button onClick={handleShowInFolder} variant="outline" className="font-bold rounded-xl">
          <MaterialIcon icon="folder_open" className="mr-1.5 text-sm" />
          {t('在文件夹中定位')}
        </Button>
      </div>
    </EmptyState>
  )

  switch (category) {
    case FileCategory.IMAGE:
      return (
        <div className="h-full w-full overflow-y-auto p-4 flex flex-col items-center ph-no-capture preview-scrollbar">
          <div className="my-auto flex flex-col items-center gap-4 max-w-full w-full">
            <div className="flex items-center justify-center max-w-full">
              <img
                src={fileUrl}
                alt={fileName}
                className="max-w-full max-h-[70vh] object-contain shadow-lg rounded"
              />
            </div>
            {multimodalContent && (
              <div className="w-full max-w-2xl px-4 py-3 bg-muted/40 rounded-lg border border-border/50 shrink-0 h-auto">
                <p className="text-[11px] text-muted-foreground mb-1 font-medium">{t('多模态描述')}</p>
                <p className="text-xs text-foreground/80 whitespace-pre-wrap break-words leading-relaxed">
                  {multimodalContent}
                </p>
              </div>
            )}
          </div>
        </div>
      )
    case FileCategory.VIDEO: {
      const startSec = highlightRange?.[0] ?? (currentTime !== undefined ? currentTime : undefined)
      const endSec = highlightRange?.[1]
      const hasHighlight = startSec !== undefined && endSec !== undefined && endSec > startSec

      return (
        <div className="h-full w-full overflow-y-auto p-4 flex flex-col items-center ph-no-capture preview-scrollbar">
          <div className="my-auto flex flex-col items-center gap-4 max-w-full w-full">
            <div className="flex flex-col items-center justify-center max-w-full w-full gap-2">
              <video
                ref={videoRef}
                src={fileUrl}
                controls
                onLoadedMetadata={handleVideoLoadedMetadata}
                className="max-w-full max-h-[70vh] shadow-lg rounded"
              >
                {t('您的浏览器不支持视频播放')}
              </video>

              {/* 命中切片指示条与跳轴胶囊 */}
              {(hasHighlight || typeof currentTime === 'number') && (
                <div className="w-full max-w-2xl px-3 py-2 bg-muted/60 rounded-lg border border-border/60 flex flex-col gap-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-1.5 text-primary font-medium">
                      <span className="material-icons text-[14px]">play_circle</span>
                      <span>{t('已定位至匹配片段')}</span>
                      {startSec !== undefined && endSec !== undefined && (
                        <span className="font-mono text-[11px] bg-primary/10 px-1.5 py-0.5 rounded text-primary">
                          {formatVideoTimestamp(startSec)} - {formatVideoTimestamp(endSec)}
                        </span>
                      )}
                    </div>
                    {startSec !== undefined && (
                      <button
                        type="button"
                        onClick={() => jumpToTime(startSec)}
                        className="text-[11px] text-muted-foreground hover:text-primary transition-colors flex items-center gap-0.5"
                      >
                        <span className="material-icons text-[12px]">replay</span>
                        {t('重新播放片段')}
                      </button>
                    )}
                  </div>

                  {/* 进度条切片高亮指示器 */}
                  {hasHighlight && videoDuration > 0 && (() => {
                    const { left, width } = computeHighlightPercent(startSec, endSec, videoDuration)
                    return (
                      <div className="relative w-full h-1.5 bg-secondary rounded-full overflow-hidden">
                        <div
                          className="absolute top-0 bottom-0 bg-primary/80 rounded-full"
                          style={{
                            left: `${left}%`,
                            width: `${width}%`
                          }}
                        />
                      </div>
                    )
                  })()}
                </div>
              )}
            </div>

            {multimodalContent && (
              <div className="w-full max-w-2xl px-4 py-3 bg-muted/40 rounded-lg border border-border/50 shrink-0 h-auto">
                <p className="text-[11px] text-muted-foreground mb-1 font-medium">{t('多模态描述')}</p>
                <p className="text-xs text-foreground/80 whitespace-pre-wrap break-words leading-relaxed">
                  {multimodalContent}
                </p>
              </div>
            )}
          </div>
        </div>
      )
    }
    case FileCategory.AUDIO:
      return (
        <div className="h-full w-full overflow-y-auto p-4 flex flex-col items-center ph-no-capture preview-scrollbar">
          <div className="my-auto flex flex-col items-center gap-4 max-w-full w-full">
            <MaterialIcon icon="audiotrack" className="text-8xl text-primary mb-2 shrink-0" />
            <audio src={fileUrl} controls className="w-full max-w-md shrink-0">
              {t('您的浏览器不支持音频播放')}
            </audio>
            {multimodalContent && (
              <div className="w-full max-w-2xl px-4 py-3 bg-muted/40 rounded-lg border border-border/50 shrink-0 h-auto">
                <p className="text-[11px] text-muted-foreground mb-1 font-medium">{t('多模态描述')}</p>
                <p className="text-xs text-foreground/80 whitespace-pre-wrap break-words leading-relaxed">
                  {multimodalContent}
                </p>
              </div>
            )}
          </div>
        </div>
      )
    case FileCategory.TEXT:
    case FileCategory.EBOOK:
    case FileCategory.CODE:
    default:
      if (textContent !== null) {
        return (
          <div className="h-full flex flex-col overflow-hidden ph-no-capture">
            {isTruncated && (
              <div className="flex items-center justify-between px-6 py-2.5 bg-amber-500/10 border-b border-amber-500/20 text-[11px] text-amber-700 font-medium shrink-0">
                <div className="flex items-center min-w-0">
                  <MaterialIcon
                    icon="warning"
                    className="mr-2 text-sm text-amber-600 animate-bounce"
                  />
                  <span className="truncate">
                    {t(
                      '当前文本文件体积较大（{size}），为保证流畅度系统已截断展示前 100,000 字。',
                      {
                        size: formatSize(fileSize)
                      }
                    )}
                  </span>
                </div>
                <button
                  onClick={handleOpenExternal}
                  className="px-3 py-1 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors shadow-sm font-bold ml-3 shrink-0"
                >
                  {t('打开完整文件')}
                </button>
              </div>
            )}
            <div className="flex-1 overflow-auto p-4 bg-muted/20">
              <pre className="text-[15px] whitespace-pre-wrap break-words text-foreground/90 dark:text-foreground/70 leading-8 tracking-wide font-sans selection:bg-primary/20">
                {textContent}
              </pre>
            </div>
          </div>
        )
      }
      return renderUnsupported()
  }
}
