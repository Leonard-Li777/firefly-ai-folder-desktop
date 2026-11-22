import { FileCategory, getFileCategory, logger, LogCategory } from '@firefly/shared'
import React, { useEffect, useRef, useState } from 'react'

import { Button } from '../ui/button'
import { EmptyState } from '../common/EmptyState'
import { toast } from '../common/Toast'
import { MaterialIcon, cn } from '../../lib/utils'
import { t } from '@app/languages'
import {
  formatVideoTimestamp,
  clampVideoTime,
  computeHighlightPercent
} from '../../lib/video-preview-utils'
import { TTSActionGroup } from '../common/TTSActionGroup'
import { useIsPrivateFile } from './hooks/useIsPrivateFile'
import {
  usePreviewOverlayStore,
  setCurrentVideoPlaybackTime,
  getCurrentVideoPlaybackTime
} from '../../stores/preview-overlay-store'

/** 时间点归一：非有限数或负值一律回退 0，与规格 §2.1 契约一致 */
function normalizeSeekSec(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** 降级快照键：绑定进入降级瞬间的「文件|切点」，跨文件或同文件切点变化后快照自动失效 */
function seekKeyOf(filePath: string, propTime: number | undefined): string {
  return `${filePath}|${normalizeSeekSec(propTime).toFixed(3)}`
}

interface DegradeSeekSnapshot {
  key: string
  sec: number
}

/**
 * 降级抽帧/外部跳轴时间点。
 * 快照仅在「文件与切点均未变」时有效：跨文件切换或同文件切换命中切片都回退 props，
 * 从而同时避免全局播放进度串位与旧快照锁死新切点。
 */
function pickFallbackSeekSec(
  snapshot: DegradeSeekSnapshot | null,
  filePath: string,
  propTime: number | undefined
): number {
  if (snapshot && snapshot.key === seekKeyOf(filePath, propTime)) {
    return normalizeSeekSec(snapshot.sec)
  }
  return normalizeSeekSec(propTime)
}

interface FilePreviewProps {
  filePath: string
  fileName: string
  extension?: string
  multimodalContent?: string | null
  /** 视频播放跳转时间戳（秒） */
  currentTime?: number
  /** 视频切片高亮时间区间 [startSec, endSec] */
  highlightRange?: [number, number]
  /** 是否为私有工作目录（显式传入），未传入时通过所属工作区自动推断 */
  isPrivate?: boolean
  /** 工作目录类型（可选） */
  workspaceDirectoryType?: 'SPEEDY' | 'PRIVATE' | 'VDIR'
}

export const FilePreview: React.FC<FilePreviewProps> = ({
  filePath,
  fileName,
  extension,
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
  const category = extension ? getFileCategory('file.' + extension) : getFileCategory(fileName)
  const [textContent, setTextContent] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isTextFile, setIsTextFile] = useState<boolean | null>(null)
  const [isTruncated, setIsTruncated] = useState(false)
  const [fileSize, setFileSize] = useState(0)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [videoDuration, setVideoDuration] = useState<number>(0)
  /** <video> 无法解码该视频格式（如 AVI/MKV）时置 true，改用静态抽帧缩图预览 */
  const [videoDecodeFailed, setVideoDecodeFailed] = useState(false)
  /** ffmpeg 实时抽帧得到的静态预览图 data URL */
  const [staticFrameUrl, setStaticFrameUrl] = useState<string | null>(null)
  /** 当前静态图对应的「文件|时间点」键，用于同一文件不同切片间切换时重新抽帧 */
  const [frameKey, setFrameKey] = useState<string | null>(null)
  /** 已发起抽帧请求的 key，防止切点后旧请求晚到覆盖新帧或重复发起同 key 请求 */
  const requestedFrameKeyRef = useRef<string | null>(null)
  /** 进入降级瞬间从当前 <video> 快照的播放位置，绑定文件+切点键，避免跨文件串位与切点锁死 */
  const degradeSeekSnapshotRef = useRef<DegradeSeekSnapshot | null>(null)

  // 切换文件路径时重置视频时长与抽帧降级状态
  useEffect(() => {
    setVideoDuration(0)
    setVideoDecodeFailed(false)
    setStaticFrameUrl(null)
    setFrameKey(null)
    requestedFrameKeyRef.current = null
    degradeSeekSnapshotRef.current = null
  }, [filePath])

  // 视频解码失败时，实时调用 ffmpeg 在当前时间点抽帧作为静态预览图
  // 时间点变化（点击同一文件不同的命中切片）时以新 key 重新抽帧，避免停留在旧帧
  useEffect(() => {
    if (!videoDecodeFailed || !filePath) return
    const seekSec = pickFallbackSeekSec(degradeSeekSnapshotRef.current, filePath, currentTime)
    const nextKey = `${filePath}|${seekSec.toFixed(3)}`
    if (frameKey === nextKey && staticFrameUrl) return
    if (requestedFrameKeyRef.current === nextKey) return
    requestedFrameKeyRef.current = nextKey
    // 同一文件切换切片时先清掉旧帧，避免新帧返回前展示错误时间点画面
    if (frameKey !== nextKey) setStaticFrameUrl(null)

    let cancelled = false
    Promise.resolve(window.electronAPI?.utils?.extractVideoFrame?.(filePath, seekSec))
      .then(result => {
        if (cancelled) return
        if (!result?.success || !result.dataUrl) {
          logger.warn(LogCategory.RENDERER, '[视频预览] ffmpeg 抽帧失败:', result?.error)
          return
        }
        setFrameKey(nextKey)
        setStaticFrameUrl(result.dataUrl)
      })
      .catch(err => {
        if (!cancelled) logger.warn(LogCategory.RENDERER, '[视频预览] 抽帧调用异常:', err)
      })
    return () => {
      cancelled = true
    }
  }, [videoDecodeFailed, filePath, currentTime, frameKey, staticFrameUrl])

  const jumpToTime = (targetTime: number) => {
    if (!videoRef.current) return
    const duration = videoRef.current.duration
    const safeTime = clampVideoTime(targetTime, duration)
    videoRef.current.currentTime = safeTime
    // 保持系统原声输出
    videoRef.current.muted = false
  }

  const handleCanPlay = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget
    if (typeof currentTime === 'number' && Number.isFinite(currentTime) && currentTime > 0) {
      if (Math.abs(v.currentTime - currentTime) > 0.3) {
        const duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : videoDuration
        v.currentTime = clampVideoTime(currentTime, duration)
      }
    }
  }

  const handleTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget
    setCurrentVideoPlaybackTime(v.currentTime)
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

  // 组件卸载或切文件时，将当前播放进度回写至 Store，确保分栏与全屏无缝接力
  useEffect(() => {
    return () => {
      const liveTime = getCurrentVideoPlaybackTime()
      if (
        category === FileCategory.VIDEO &&
        typeof liveTime === 'number' &&
        Number.isFinite(liveTime) &&
        liveTime > 0
      ) {
        usePreviewOverlayStore.setState(prev => ({
          currentTime: liveTime,
          pageStates: prev.activePageId
            ? {
                ...prev.pageStates,
                [prev.activePageId]: {
                  ...prev.pageStates[prev.activePageId],
                  currentTime: liveTime
                }
              }
            : prev.pageStates
        }))
      }
    }
  }, [filePath, category])

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

  /** 在外部播放器精准跳到当前预览时间点（非原生格式静态预览时使用） */
  const handleExternalSeek = async () => {
    try {
      const outcome = await window.electronAPI?.utils?.launchExternalDeepLink?.({
        filePath,
        category: 'video',
        seekSeconds: pickFallbackSeekSec(degradeSeekSnapshotRef.current, filePath, currentTime)
      })
      if (outcome?.fallbackToDefault) {
        toast.info(t('未检测到支持精准定位的外部应用，已按默认方式打开'))
      }
    } catch (err: unknown) {
      logger.error(LogCategory.RENDERER, '外部播放器跳轴失败:', err)
      toast.error(t('打开文件失败'))
    }
  }

  const handleShowInFolder = () => {
    window.electronAPI.utils.showItemInFolder(filePath)
  }

  const fileUrl = React.useMemo(() => {
    const raw =
      typeof window.electronAPI?.utils?.normalizeForCache === 'function'
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
    const base = `file://${encoded.startsWith('/') ? '' : '/'}${encoded}`
    if (typeof currentTime === 'number' && Number.isFinite(currentTime) && currentTime > 0) {
      return `${base}#t=${currentTime}`
    }
    return base
  }, [filePath, currentTime])

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
        <div className="h-full w-full overflow-y-auto p-4 flex flex-col items-center preview-scrollbar">
          <div className="my-auto flex flex-col items-center gap-4 max-w-full w-full">
            {/* 预览内容的正文区 */}
            <div
              className={cn(
                'flex items-center justify-center max-w-full',
                isPrivate && 'ph-no-capture'
              )}
            >
              <img
                src={fileUrl}
                alt={fileName}
                className="max-w-full max-h-[70vh] object-contain shadow-lg rounded"
              />
            </div>
            {/* 多模态描述文本区 */}
            {multimodalContent && (
              <div
                className={cn(
                  'w-full max-w-2xl px-4 py-3 bg-muted/40 rounded-lg border border-border/50 shrink-0 h-auto',
                  isPrivate && 'ph-mask'
                )}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-[11px] text-muted-foreground font-medium">{t('多模态描述')}</p>
                  <TTSActionGroup
                    text={multimodalContent}
                    textId={`image-multimodal-${filePath}`}
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
        </div>
      )
    case FileCategory.VIDEO: {
      const startSec = highlightRange?.[0] ?? (currentTime !== undefined ? currentTime : undefined)
      const endSec = highlightRange?.[1]
      const hasHighlight = startSec !== undefined && endSec !== undefined && endSec > startSec

      return (
        <div className="h-full w-full overflow-y-auto p-4 flex flex-col items-center preview-scrollbar">
          <div className="my-auto flex flex-col items-center gap-4 max-w-full w-full">
            {/* 预览内容的正文区 */}
            <div
              className={cn(
                'flex flex-col items-center justify-center max-w-full w-full gap-2',
                isPrivate && 'ph-no-capture'
              )}
            >
              {videoDecodeFailed ? (
                /* 浏览器无法解码（AVI/MKV 等）：显示 ffmpeg 静态抽帧 + 外部播放器跳轴引导 */
                <div className="flex flex-col items-center gap-3 max-w-full">
                  {staticFrameUrl ? (
                    <img
                      src={staticFrameUrl}
                      alt={fileName}
                      className="max-w-full max-h-[65vh] shadow-lg rounded object-contain"
                      onError={() => {
                        logger.warn(LogCategory.RENDERER, '[视频预览] 静态帧渲染失败，回退占位图标')
                        setStaticFrameUrl(null)
                      }}
                    />
                  ) : (
                    <div className="w-72 h-40 flex items-center justify-center bg-muted/40 rounded">
                      <MaterialIcon icon="movie" className="text-5xl text-muted-foreground/50" />
                    </div>
                  )}
                  <div className="flex flex-col items-center gap-2 text-center">
                    <p className="text-xs text-muted-foreground">
                      {t('无法在应用内播放此文件，可尝试在外部播放器中打开查看。')}
                    </p>
                    <Button
                      onClick={handleExternalSeek}
                      variant="outline"
                      className="font-bold rounded-xl"
                    >
                      <MaterialIcon icon="play_arrow" className="mr-1.5 text-sm" />
                      {t('在外部播放器播放此片段')}
                    </Button>
                  </div>
                </div>
              ) : (
                <video
                  ref={videoRef}
                  src={fileUrl}
                  controls
                  onLoadedMetadata={handleVideoLoadedMetadata}
                  onCanPlay={handleCanPlay}
                  onTimeUpdate={handleTimeUpdate}
                  onError={e => {
                    // 只读当前 <video> 实例的时间点：切文件后该实例时间会重置，
                    // 不会读到模块级全局单例里上一个文件残留的播放进度（V-01 根因）。
                    // 启动期解码失败时 currentTime 通常为 0，此时不记快照，回退 props 命中点。
                    const videoTime = e.currentTarget.currentTime
                    const liveTime =
                      typeof videoTime === 'number' && Number.isFinite(videoTime) && videoTime > 0
                        ? videoTime
                        : null
                    degradeSeekSnapshotRef.current =
                      liveTime !== null
                        ? { key: seekKeyOf(filePath, currentTime), sec: liveTime }
                        : null
                    logger.warn(
                      LogCategory.RENDERER,
                      `[视频预览] 浏览器无法解码视频，切换静态抽帧: ${filePath} @ ${liveTime ?? currentTime ?? 0}s`
                    )
                    setVideoDecodeFailed(true)
                  }}
                  className="max-w-full max-h-[70vh] shadow-lg rounded"
                >
                  {t('您的浏览器不支持视频播放')}
                </video>
              )}

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
                  {hasHighlight &&
                    videoDuration > 0 &&
                    (() => {
                      const { left, width } = computeHighlightPercent(
                        startSec,
                        endSec,
                        videoDuration
                      )
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

            {/* 多模态描述文本区 */}
            {multimodalContent && (
              <div
                className={cn(
                  'w-full max-w-2xl px-4 py-3 bg-muted/40 rounded-lg border border-border/50 shrink-0 h-auto',
                  isPrivate && 'ph-mask'
                )}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <p className="text-[11px] text-muted-foreground font-medium">{t('多模态描述')}</p>
                  <TTSActionGroup
                    text={multimodalContent}
                    textId={`video-multimodal-${filePath}`}
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
        </div>
      )
    }
    case FileCategory.AUDIO:
      return (
        <div className="h-full w-full overflow-y-auto p-4 flex flex-col items-center preview-scrollbar">
          <div className="my-auto flex flex-col items-center gap-4 max-w-full w-full">
            {/* 预览内容的正文区 */}
            <div
              className={cn(
                'flex flex-col items-center gap-2 max-w-md w-full shrink-0',
                isPrivate && 'ph-no-capture'
              )}
            >
              <MaterialIcon icon="audiotrack" className="text-8xl text-primary mb-2 shrink-0" />
              <audio src={fileUrl} controls className="w-full shrink-0">
                {t('您的浏览器不支持音频播放')}
              </audio>
            </div>
            {/* 多模态描述文本区 */}
            {multimodalContent && (
              <div
                className={cn(
                  'w-full max-w-2xl px-4 py-3 bg-muted/40 rounded-lg border border-border/50 shrink-0 h-auto',
                  isPrivate && 'ph-mask'
                )}
              >
                <p className="text-[11px] text-muted-foreground mb-1 font-medium">
                  {t('多模态描述')}
                </p>
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
        </div>
      )
    case FileCategory.TEXT:
    case FileCategory.EBOOK:
    case FileCategory.CODE:
    default:
      if (textContent !== null) {
        return (
          <div className="h-full flex flex-col overflow-hidden">
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
            <div className="flex items-center justify-between px-4 py-2 border-b border-border/40 bg-muted/10 shrink-0">
              <span className="text-xs text-muted-foreground font-mono truncate max-w-xs">
                {fileName}
              </span>
              <TTSActionGroup
                text={textContent}
                textId={`filepreview-${filePath}`}
                filePath={filePath}
                fieldName="textContent"
                defaultFileName={`${fileName}.wav`}
              />
            </div>
            {/* 预览内容的正文区 */}
            <div
              className={cn('flex-1 overflow-auto p-4 bg-muted/20', isPrivate && 'ph-no-capture')}
            >
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
