import { FileCategory, getFileCategory, logger, LogCategory } from '@firefly/shared'
import React, { useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '../ui/button'
import { StreamVideoControls } from './StreamVideoControls'
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
  useVideoFrame,
  seekKeyOf,
  pickFallbackSeekSec,
  type DegradeSeekSnapshot
} from './hooks/useVideoFrame'
import {
  usePreviewOverlayStore,
  setCurrentVideoPlaybackTime,
  getCurrentVideoPlaybackTime,
  type MediaFitMode
} from '../../stores/preview-overlay-store'

interface MediaLayoutClasses {
  outer: string
  inner: string
  body: string
  streamWrapper: string
  decodeFailedWrapper: string
  mediaElement: string
  multimodalBox: string
}

export interface ComputeSideBySideParams {
  containerWidth: number
  containerHeight: number
  naturalWidth?: number | null
  naturalHeight?: number | null
  mediaFitMode: MediaFitMode
  hasMultimodalContent: boolean
}

/**
 * 计算多媒体（图片/视频）预览区块是否应当与多模态描述左右分栏
 *
 * 判定原则：
 * 1. 结合外层容器宽高与多媒体本身原始尺寸/宽高比；
 * 2. 在 contain（等比全显）模式下，若图片缩放后水平宽度较窄（如竖图或小图），
 *    右侧留白空间充足（>= 200px~230px），即使容器总宽度未达 600px（如 460px~580px），亦果断切换为左右分栏；
 * 3. 若图片为横屏宽图（横向充满容器），为防止横图被左右分栏挤成细条，保持上下排布；
 * 4. 容器超宽（>= 720px）时始终左右分栏；容器极窄（< 440px）时始终上下排布；
 * 5. 尺寸尚未获取（SSR / 初始挂载阶段）返回 null，由 CSS 容器查询兜底。
 */
export function computeMediaMultimodalSideBySide({
  containerWidth,
  containerHeight,
  naturalWidth,
  naturalHeight,
  mediaFitMode,
  hasMultimodalContent
}: ComputeSideBySideParams): boolean | null {
  if (!hasMultimodalContent) return false
  if (containerWidth <= 0 || containerHeight <= 0) return null

  if (mediaFitMode === 'fit-width') {
    return containerWidth >= 720
  }

  if (mediaFitMode === 'original') {
    return false
  }

  // contain 模式
  if (!naturalWidth || !naturalHeight) {
    return containerWidth >= 600
  }

  const effectiveWidth = Math.max(80, containerWidth - 32)
  const effectiveHeight = Math.max(80, containerHeight - 32)
  // CSS: max-w-full max-h-full w-auto h-auto object-contain
  // 遵循只缩小不拉伸放大的渲染物理规律，真实还原图片在视口中所占宽度
  const scale = Math.min(1, effectiveWidth / naturalWidth, effectiveHeight / naturalHeight)
  const fittedImageWidth = Math.round(naturalWidth * scale)
  const remainingWidth = containerWidth - fittedImageWidth
  const aspectRatio = naturalWidth / naturalHeight

  // 1. 容器总宽度极窄 (< 440px)，左右并排会导致两边都极度拥挤，保持上下
  if (containerWidth < 440) {
    return false
  }

  // 2. 容器极宽 (>= 720px)，空间充裕，左右并排
  if (containerWidth >= 720) {
    return true
  }

  // 3. 竖图/窄图 (aspectRatio <= 0.85)：在容器高度下图片很窄，右侧空余空间充裕
  // 只要右侧富余空间 >= 200px 且容器 >= 460px，果断开启左右分栏
  if (aspectRatio <= 0.85 && containerWidth >= 460 && remainingWidth >= 200) {
    return true
  }

  // 4. 图片实际占用宽度较小 (fittedImageWidth <= containerWidth * 0.52 且 remainingWidth >= 230px)
  // 常见于小图或较窄图片，右侧留白充足，允许左右分栏
  if (fittedImageWidth <= containerWidth * 0.52 && remainingWidth >= 230) {
    return true
  }

  // 5. 横图/宽图 (aspectRatio >= 1.15)：横向占用较大
  // 若强行分栏会导致横图缩成细条，因此除非总宽度 >= 660px 且右侧有 >= 250px，否则保持上下
  if (aspectRatio >= 1.15) {
    return containerWidth >= 660 && remainingWidth >= 250
  }

  // 6. 普通方图/中等比例图：容器达到 600px 且剩余空间 >= 220px 时左右分栏
  return containerWidth >= 600 && remainingWidth >= 220
}

const MEDIA_LAYOUT_BY_MODE: Record<MediaFitMode, MediaLayoutClasses> = {
  contain: {
    outer:
      'h-full w-full overflow-hidden p-3 flex flex-col items-center justify-center gap-3 preview-scrollbar min-w-0 min-h-0 @container/preview',
    inner:
      'my-auto max-h-full min-h-0 min-w-0 w-full flex flex-col @[600px]/preview:flex-1 @[600px]/preview:flex-row items-center justify-center @[600px]/preview:items-stretch gap-3 @[600px]/preview:gap-4',
    body: 'min-h-0 max-h-full max-w-full flex flex-col items-center justify-center gap-2 shrink @[600px]/preview:flex-1 @[600px]/preview:h-full',
    streamWrapper:
      'min-h-0 max-h-full max-w-full flex flex-col items-center justify-center gap-2 shrink @[600px]/preview:flex-1 @[600px]/preview:h-full',
    decodeFailedWrapper:
      'min-h-0 max-h-full max-w-full flex flex-col items-center justify-center gap-3 shrink @[600px]/preview:flex-1 @[600px]/preview:h-full',
    mediaElement:
      'min-h-0 max-w-full max-h-full w-auto h-auto object-contain shadow-lg rounded transition-all duration-150',
    multimodalBox:
      'w-full max-w-2xl px-4 py-3 bg-muted/40 rounded-lg border border-border/50 shrink-0 @[600px]/preview:max-h-full @[600px]/preview:w-80 @[600px]/preview:max-w-[40%] @[600px]/preview:h-full flex flex-col overflow-hidden'
  },
  original: {
    outer:
      'h-full w-full overflow-auto p-4 flex preview-scrollbar min-w-0 min-h-0 @container/preview',
    inner: 'm-auto flex flex-col items-center gap-4 shrink-0',
    body: 'flex flex-col items-center justify-center shrink-0 gap-2',
    streamWrapper: 'flex flex-col items-center gap-2 shrink-0',
    decodeFailedWrapper: 'flex flex-col items-center gap-3 shrink-0',
    mediaElement: 'max-w-none max-h-none w-auto h-auto shadow-lg rounded shrink-0',
    multimodalBox:
      'w-full max-w-2xl px-4 py-3 bg-muted/40 rounded-lg border border-border/50 shrink-0 h-auto'
  },
  'fit-width': {
    outer:
      'h-full w-full overflow-y-auto overflow-x-hidden p-4 flex flex-col items-center preview-scrollbar min-w-0 min-h-0 @container/preview',
    inner:
      'my-auto flex flex-col @[720px]/preview:flex-row items-center @[720px]/preview:items-start gap-4 max-w-full w-full min-w-0',
    body: 'flex flex-col items-center justify-center max-w-full w-full @[720px]/preview:flex-1 gap-2 min-w-0',
    streamWrapper:
      'flex flex-col items-center gap-2 max-w-full w-full @[720px]/preview:flex-1 min-w-0',
    decodeFailedWrapper:
      'flex flex-col items-center gap-3 max-w-full w-full @[720px]/preview:flex-1 min-w-0',
    mediaElement:
      'w-full max-w-full h-auto object-contain shadow-lg rounded transition-all duration-150',
    multimodalBox:
      'w-full max-w-2xl @[720px]/preview:w-80 @[720px]/preview:max-w-[36%] px-4 py-3 bg-muted/40 rounded-lg border border-border/50 shrink-0 h-auto @[720px]/preview:sticky @[720px]/preview:top-0'
  }
}

interface StreamPlaybackSession {
  streamId: string
  streamUrl: string
  durationSec: number | null
  actualStartSec: number
  mode: 'remux' | 'transcode'
}

const STREAM_STALL_TIMEOUT_MS = 8_000
const STREAM_STARTUP_PLAYABLE_TIMEOUT_MS = 12_000

type WatchdogState =
  | 'BACKGROUND_HIDDEN'
  | 'PAUSED'
  | 'SEEKING'
  | 'BUFFERING_WAITING'
  | 'PLAYING_HEALTHY'

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
  /** 进入降级瞬间从当前 <video> 快照的播放位置，绑定文件+切点键，避免跨文件串位与切点锁死 */
  const degradeSeekSnapshotRef = useRef<DegradeSeekSnapshot | null>(null)
  /** 降级抽帧时间点：仅在降级态生效，由共享 hook 统一发起请求 */
  const fallbackSeekSec = pickFallbackSeekSec(degradeSeekSnapshotRef.current, filePath, currentTime)
  /** 共享抽帧层：键归一、去重、取消与乱序防护统一收口（工单 03 FrameBroker） */
  const { frameUrl: staticFrameUrl } = useVideoFrame(filePath, {
    seekSec: fallbackSeekSec,
    enabled: videoDecodeFailed
  })
  /** 静态帧渲染失败时本地降级（不重试同一坏 data URL） */
  const [staticFrameBroken, setStaticFrameBroken] = useState(false)

  // Level 2：本地 HTTP 双路流式播放会话
  const [streamSession, setStreamSession] = useState<StreamPlaybackSession | null>(null)
  const streamSessionRef = useRef<StreamPlaybackSession | null>(null)
  const actualStartSecRef = useRef(0)
  const logicalTimeRef = useRef(0)
  const [streamLogicalTime, setStreamLogicalTime] = useState(0)
  const [streamPlaying, setStreamPlaying] = useState(false)
  const isVideoMuted = usePreviewOverlayStore(s => s.isVideoMuted)
  const setVideoMuted = usePreviewOverlayStore(s => s.setVideoMuted)
  const videoVolume = usePreviewOverlayStore(s => s.videoVolume)
  const setVideoVolume = usePreviewOverlayStore(s => s.setVideoVolume)
  const mediaFitMode = usePreviewOverlayStore(s => s.mediaFitMode)
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerSize, setContainerSize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0
  })
  const [imageNaturalSize, setImageNaturalSize] = useState<{
    width: number
    height: number
  } | null>(null)
  const [videoNaturalSize, setVideoNaturalSize] = useState<{
    width: number
    height: number
  } | null>(null)

  // 观测多媒体容器尺寸变化
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    if (el.clientWidth > 0 && el.clientHeight > 0) {
      setContainerSize({ width: el.clientWidth, height: el.clientHeight })
    }
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        if (width > 0 && height > 0) {
          setContainerSize({ width, height })
        }
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const lastStreamActivityRef = useRef(Date.now())
  const pendingSeekRef = useRef(false)
  /** 8s 停滞看门狗仅在 loadeddata 后启用，避免冷启动与后端 10s 看门狗竞态 */
  const streamLoadedRef = useRef(false)
  const [streamLoaded, setStreamLoaded] = useState(false)
  const seekDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const seekOpGenRef = useRef(0)
  const watchdogGenRef = useRef(0)
  const nativeErrorHandledRef = useRef(false)
  /** 流式播放中触发 Seek 时记录播放意图，新流就绪后自动恢复播放（换 src 会被 HTML5 <video> 重置为 paused） */
  const resumePlayAfterSeekRef = useRef(false)

  // 切换文件路径时重置视频时长、流式会话与抽帧降级状态
  useEffect(() => {
    seekOpGenRef.current += 1
    watchdogGenRef.current += 1
    const previous = streamSessionRef.current
    if (previous) {
      Promise.resolve(window.electronAPI?.utils?.releaseVideoStream?.(previous.streamId)).catch(
        () => undefined
      )
    }
    streamSessionRef.current = null
    setStreamSession(null)
    setStreamPlaying(false)
    setStreamLogicalTime(0)
    pendingSeekRef.current = false
    streamLoadedRef.current = false
    setStreamLoaded(false)
    resumePlayAfterSeekRef.current = false
    if (seekDebounceRef.current) clearTimeout(seekDebounceRef.current)
    nativeErrorHandledRef.current = false
    setVideoDuration(0)
    setVideoDecodeFailed(false)
    setStaticFrameBroken(false)
    setImageNaturalSize(null)
    setVideoNaturalSize(null)
    degradeSeekSnapshotRef.current = null
  }, [filePath])

  // 保持当前视频音量大小与静音状态与全局视频偏好一致（仅限视频，TTS/音乐不限，办公场景防打扰）
  useEffect(() => {
    if (category === FileCategory.VIDEO && videoRef.current) {
      videoRef.current.volume = videoVolume
      videoRef.current.muted = isVideoMuted
    }
  }, [videoVolume, isVideoMuted, category])

  const markStreamActivity = () => {
    lastStreamActivityRef.current = Date.now()
  }

  /** Level 2 失败统一回落 Level 3：先释放会话，再复用 v1.7 静态帧 + 外部跳轴 */
  const fallbackToStatic = () => {
    seekOpGenRef.current += 1
    watchdogGenRef.current += 1
    const session = streamSessionRef.current
    if (session) {
      Promise.resolve(window.electronAPI?.utils?.releaseVideoStream?.(session.streamId)).catch(
        () => undefined
      )
    }
    const hadStreamSession = Boolean(session)
    streamSessionRef.current = null
    setStreamSession(null)
    setStreamPlaying(false)
    pendingSeekRef.current = false
    streamLoadedRef.current = false
    setStreamLoaded(false)
    resumePlayAfterSeekRef.current = false
    // 原生 error 已写入的快照必须保留；只有 Stream 模式才用逻辑时间覆盖
    if (hadStreamSession && logicalTimeRef.current > 0) {
      degradeSeekSnapshotRef.current = {
        key: seekKeyOf(filePath, currentTime),
        sec: logicalTimeRef.current
      }
    }
    setVideoDecodeFailed(true)
  }

  /** 原生解码失败后进入 Level 2；任一失败都直接回落 Level 3 */
  const startStreamPlayback = async (startSec: number) => {
    if (nativeErrorHandledRef.current) return
    nativeErrorHandledRef.current = true
    const myOpGen = ++seekOpGenRef.current
    try {
      const result = await window.electronAPI?.utils?.prepareVideoStream?.(filePath, startSec)
      if (myOpGen !== seekOpGenRef.current) return
      if (!result?.success || !result.streamId || !result.streamUrl) {
        logger.warn(LogCategory.RENDERER, '[视频预览] 流式播放准备失败:', result?.error)
        fallbackToStatic()
        return
      }
      const session: StreamPlaybackSession = {
        streamId: result.streamId,
        streamUrl: result.streamUrl,
        durationSec: result.durationSec ?? null,
        actualStartSec: result.actualStartSec ?? startSec,
        mode: result.mode ?? 'transcode'
      }
      actualStartSecRef.current = session.actualStartSec
      logicalTimeRef.current = session.actualStartSec
      setStreamLogicalTime(session.actualStartSec)
      lastStreamActivityRef.current = Date.now()
      pendingSeekRef.current = true
      streamLoadedRef.current = false
      setStreamLoaded(false)
      // 切换视频/首播启动时自动起播
      resumePlayAfterSeekRef.current = true
      streamSessionRef.current = session
      setVideoDuration(session.durationSec ?? 0)
      setStreamSession(session)
    } catch (err: unknown) {
      if (myOpGen !== seekOpGenRef.current) return
      logger.warn(LogCategory.RENDERER, '[视频预览] 流式播放准备异常:', err)
      fallbackToStatic()
    }
  }

  /** Seek 唯一入口：200ms 防抖，代际守卫 + 三错误码细分收敛 */
  const handleStreamSeek = (targetSec: number) => {
    if (!streamSessionRef.current) return
    // 记录 Seek 发起前的播放意图：连续快速拖动时沿用已置位的 resumePlayAfterSeekRef，避免被换 src 后的瞬态 paused 冲掉
    const wasPlaying =
      Boolean(videoRef.current && !videoRef.current.paused) ||
      streamPlaying ||
      resumePlayAfterSeekRef.current
    if (wasPlaying) {
      resumePlayAfterSeekRef.current = true
    }
    setStreamLogicalTime(targetSec)
    pendingSeekRef.current = true
    streamLoadedRef.current = false
    setStreamLoaded(false)
    if (seekDebounceRef.current) clearTimeout(seekDebounceRef.current)
    const mySeekGen = ++seekOpGenRef.current
    seekDebounceRef.current = setTimeout(() => {
      void (async () => {
        if (mySeekGen !== seekOpGenRef.current) return
        const current = streamSessionRef.current
        if (!current) {
          if (mySeekGen === seekOpGenRef.current) pendingSeekRef.current = false
          return
        }
        try {
          const result = await window.electronAPI?.utils?.seekVideoStream?.(
            current.streamId,
            targetSec
          )
          // 仅旧代际或显式 SEEK_REQUEST_SUPERSEDED 静默忽略，且绝不清理新代际 pendingSeekRef
          if (mySeekGen !== seekOpGenRef.current || result?.error === 'SEEK_REQUEST_SUPERSEDED') {
            return
          }
          if (!result?.success || !result.streamUrl) {
            logger.warn(LogCategory.RENDERER, '[视频预览] 流式 Seek 失败，收敛降级:', result?.error)
            pendingSeekRef.current = false
            fallbackToStatic()
            return
          }
          const actualStartSec = result.actualStartSec ?? targetSec
          actualStartSecRef.current = actualStartSec
          logicalTimeRef.current = actualStartSec
          setStreamLogicalTime(actualStartSec)
          pendingSeekRef.current = true
          streamLoadedRef.current = false
          setStreamLoaded(false)
          lastStreamActivityRef.current = Date.now()
          const next: StreamPlaybackSession = {
            ...current,
            streamUrl: result.streamUrl,
            actualStartSec,
            mode: result.mode ?? current.mode
          }
          streamSessionRef.current = next
          setStreamSession(next)
        } catch (err: unknown) {
          if (mySeekGen !== seekOpGenRef.current) return
          logger.warn(LogCategory.RENDERER, '[视频预览] 流式 Seek 异常:', err)
          pendingSeekRef.current = false
          fallbackToStatic()
        }
      })()
    }, 200)
  }

  // 门槛 A：独立 12s 起播看门狗（从 <video key="stream-video"> 挂载且 src 赋值开始计时，代际绑定）
  useEffect(() => {
    if (!streamSession || streamLoaded) return
    const myGen = ++watchdogGenRef.current
    const startupTimer = setTimeout(() => {
      if (watchdogGenRef.current !== myGen || streamLoadedRef.current) return
      logger.warn(LogCategory.RENDERER, '[视频预览] 12s 内未触发 loadeddata，起播超时降级 Level 3')
      fallbackToStatic()
    }, STREAM_STARTUP_PLAYABLE_TIMEOUT_MS)
    return () => {
      clearTimeout(startupTimer)
    }
  }, [streamSession?.streamId, streamSession?.streamUrl, streamLoaded])

  // 门槛 B：rVFC 链式自重注册 + 1s 独立定时器实时读五态 Watchdog（Frozen v1.7 Approved / R12-01）
  useEffect(() => {
    const video = videoRef.current
    if (!video || !streamSession || !streamLoaded) return

    const myGen = ++watchdogGenRef.current
    let disposed = false
    let degraded = false
    let rvfcHandle: number | null = null
    let lastPresentedFrames = -1
    let lastPlayheadTime = video.currentTime
    let lastAdvanceAt = performance.now()
    let isWaitingOrStalled = false
    let rvfcActive = typeof (video as any).requestVideoFrameCallback === 'function'

    const cancelRvfcSafe = () => {
      if (rvfcHandle !== null && typeof (video as any).cancelVideoFrameCallback === 'function') {
        try {
          ;(video as any).cancelVideoFrameCallback(rvfcHandle)
        } catch {}
      }
      rvfcHandle = null
    }

    const scheduleNextFrameCallback = () => {
      if (disposed || degraded || watchdogGenRef.current !== myGen || !rvfcActive) return
      try {
        rvfcHandle = (video as any).requestVideoFrameCallback(
          (_now: number, meta: { presentedFrames: number }) => {
            if (disposed || degraded || watchdogGenRef.current !== myGen) return
            if (meta.presentedFrames > lastPresentedFrames) {
              lastPresentedFrames = meta.presentedFrames
              lastAdvanceAt = performance.now()
            }
            scheduleNextFrameCallback()
          }
        )
      } catch (err) {
        rvfcActive = false
        rvfcHandle = null
        logger.warn(
          LogCategory.RENDERER,
          `[视频预览] rVFC 注册失败，回退 currentTime 停滞检测: ${String(err)}`
        )
      }
    }
    if (rvfcActive) scheduleNextFrameCallback()

    const resetBaseline = () => {
      lastAdvanceAt = performance.now()
      lastPlayheadTime = video.currentTime
    }
    const onWaiting = () => {
      isWaitingOrStalled = true
    }
    const onPlayingOrCanPlay = () => {
      isWaitingOrStalled = false
      resetBaseline()
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') resetBaseline()
    }

    video.addEventListener('waiting', onWaiting)
    video.addEventListener('stalled', onWaiting)
    video.addEventListener('playing', onPlayingOrCanPlay)
    video.addEventListener('canplay', onPlayingOrCanPlay)
    video.addEventListener('play', resetBaseline)
    document.addEventListener('visibilitychange', onVisibilityChange)

    const resolveWatchdogState = (): WatchdogState => {
      if (document.visibilityState !== 'visible') return 'BACKGROUND_HIDDEN'
      if (video.paused || video.ended) return 'PAUSED'
      if (video.seeking || pendingSeekRef.current) return 'SEEKING'
      if (isWaitingOrStalled || video.readyState < 3) return 'BUFFERING_WAITING'
      return 'PLAYING_HEALTHY'
    }

    let intervalId: ReturnType<typeof setInterval> | null = null
    const degradeOnce = (reason: string) => {
      if (disposed || degraded || watchdogGenRef.current !== myGen) return
      degraded = true
      if (intervalId !== null) {
        clearInterval(intervalId)
        intervalId = null
      }
      cancelRvfcSafe()
      logger.warn(LogCategory.RENDERER, reason)
      fallbackToStatic()
    }

    intervalId = setInterval(() => {
      if (disposed || degraded || watchdogGenRef.current !== myGen) return
      if (resolveWatchdogState() !== 'PLAYING_HEALTHY') {
        resetBaseline()
        return
      }
      if (rvfcActive) {
        if (performance.now() - lastAdvanceAt >= STREAM_STALL_TIMEOUT_MS) {
          degradeOnce(
            `[视频预览] rVFC 8s 无新帧呈现，降级 Level 3 (frames=${lastPresentedFrames}, diagTime=${video.currentTime.toFixed(3)})`
          )
        }
      } else {
        if (video.currentTime !== lastPlayheadTime) {
          lastPlayheadTime = video.currentTime
          lastAdvanceAt = performance.now()
        } else if (performance.now() - lastAdvanceAt >= STREAM_STALL_TIMEOUT_MS) {
          degradeOnce(
            `[视频预览] currentTime 8s 无推进(回退模式)，降级 Level 3 (time=${video.currentTime.toFixed(3)})`
          )
        }
      }
    }, 1000)

    return () => {
      disposed = true
      if (intervalId !== null) clearInterval(intervalId)
      cancelRvfcSafe()
      video.removeEventListener('waiting', onWaiting)
      video.removeEventListener('stalled', onWaiting)
      video.removeEventListener('playing', onPlayingOrCanPlay)
      video.removeEventListener('canplay', onPlayingOrCanPlay)
      video.removeEventListener('play', resetBaseline)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [streamSession?.streamId, streamSession?.streamUrl, streamLoaded])

  /** 原生视频自动播放防御性尝试（静默忽略策略阻断与快切打断） */
  const tryPlayNative = (v: HTMLVideoElement) => {
    if (!v.paused || v.ended) return
    try {
      const playPromise = v.play()
      if (playPromise && typeof playPromise.then === 'function') {
        void playPromise.catch(err => {
          // 自动播放被策略阻止（NotAllowedError）或切换/更新被打断（AbortError）属预期行为
          if (err?.name === 'AbortError' || err?.name === 'NotAllowedError') return
          logger.warn(LogCategory.RENDERER, '[视频预览] 原生自动播放受阻:', err)
        })
      }
    } catch {
      // 兼容无原生多媒体实现的测试或特殊环境
    }
  }

  const jumpToTime = (targetTime: number) => {
    const session = streamSessionRef.current
    if (session) {
      // 流式视频跳转切片：无论此前是否暂停，明确标记恢复播放
      resumePlayAfterSeekRef.current = true
      const dur = session.durationSec ?? Number.POSITIVE_INFINITY
      handleStreamSeek(clampVideoTime(targetTime, dur))
      return
    }
    if (!videoRef.current) return
    const duration = videoRef.current.duration
    const safeTime = clampVideoTime(targetTime, duration)
    videoRef.current.currentTime = safeTime
    // 对齐全局视频音量与静音偏好（仅限视频，办公防打扰）
    videoRef.current.volume = videoVolume
    videoRef.current.muted = isVideoMuted
    tryPlayNative(videoRef.current)
  }

  /** Seek 切换新流就绪后自动恢复播放（仅消费一次，避免与 loadeddata/canplay 双触发） */
  const tryResumeStreamPlay = (v: HTMLVideoElement) => {
    if (!resumePlayAfterSeekRef.current) return
    resumePlayAfterSeekRef.current = false
    try {
      const playPromise = v.play()
      if (playPromise && typeof playPromise.then === 'function') {
        void playPromise.then(
          () => setStreamPlaying(true),
          err => {
            // 连续快拖切流触发的 AbortError 属正常打断，绝不误降级 Level 3
            if ((err as { name?: string })?.name === 'AbortError') return
            setStreamPlaying(false)
            logger.warn(LogCategory.RENDERER, '[视频预览] Seek 后自动恢复播放失败:', err)
          }
        )
      } else {
        setStreamPlaying(true)
      }
    } catch {
      // 兼容无原生多媒体实现的测试或特殊环境
    }
  }

  const handleCanPlay = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget
    markStreamActivity()
    if (streamSessionRef.current) {
      pendingSeekRef.current = false
      tryResumeStreamPlay(v)
      return
    }
    if (typeof currentTime === 'number' && Number.isFinite(currentTime) && currentTime > 0) {
      if (Math.abs(v.currentTime - currentTime) > 0.3) {
        const duration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : videoDuration
        v.currentTime = clampVideoTime(currentTime, duration)
      }
    }
    // 对齐全局视频音量与静音偏好
    v.volume = videoVolume
    v.muted = isVideoMuted
    tryPlayNative(v)
  }

  const handleTimeUpdate = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget
    markStreamActivity()
    if (streamSessionRef.current) {
      // 新流 loadeddata 到达前的 timeupdate 属于旧流，必须忽略
      if (pendingSeekRef.current) return
      const logicalTime = actualStartSecRef.current + v.currentTime
      logicalTimeRef.current = logicalTime
      setStreamLogicalTime(logicalTime)
      setCurrentVideoPlaybackTime(logicalTime)
      return
    }
    setCurrentVideoPlaybackTime(v.currentTime)
  }

  const handleVideoLoadedMetadata = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const v = e.currentTarget
    markStreamActivity()
    if (streamSessionRef.current) {
      pendingSeekRef.current = false
      if (!resumePlayAfterSeekRef.current) {
        setStreamPlaying(!v.paused)
      }
      v.muted = isVideoMuted
      v.volume = videoVolume
      return
    }
    // 对齐全局视频音量与静音偏好
    v.volume = videoVolume
    v.muted = isVideoMuted
    const validDuration = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 0
    setVideoDuration(validDuration)
    if (v.videoWidth && v.videoHeight) {
      setVideoNaturalSize({ width: v.videoWidth, height: v.videoHeight })
    }
    if (typeof currentTime === 'number' && Number.isFinite(currentTime)) {
      const safeTime = clampVideoTime(currentTime, validDuration)
      v.currentTime = safeTime
    }
    tryPlayNative(v)
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
      const activeSession = streamSessionRef.current
      if (activeSession) {
        Promise.resolve(
          window.electronAPI?.utils?.releaseVideoStream?.(activeSession.streamId)
        ).catch(() => undefined)
      }
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
        seekSeconds: streamSessionRef.current
          ? logicalTimeRef.current
          : pickFallbackSeekSec(degradeSeekSnapshotRef.current, filePath, currentTime)
      })
      if (outcome?.fallbackToDefault) {
        toast.info(t('未检测到支持精准定位的外部应用，已按默认方式打开'))
      }
    } catch (err: unknown) {
      logger.error(LogCategory.RENDERER, '外部播放器跳轴失败:', err)
      toast.error(t('打开文件失败'))
    }
  }

  const handleStreamError = () => {
    logger.warn(LogCategory.RENDERER, '[视频预览] 流媒体解码失败，回落静态预览')
    fallbackToStatic()
  }

  const handleStreamEnded = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const duration = streamSessionRef.current?.durationSec ?? null
    const logicalTime = actualStartSecRef.current + e.currentTarget.currentTime
    if (duration !== null && duration > 0 && logicalTime < duration - 2) {
      logger.warn(LogCategory.RENDERER, '[视频预览] 流媒体异常提前结束，回落静态预览')
      fallbackToStatic()
    }
  }

  const toggleStreamPlay = () => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      void video.play().then(
        () => setStreamPlaying(true),
        () => fallbackToStatic()
      )
    } else {
      resumePlayAfterSeekRef.current = false
      video.pause()
      setStreamPlaying(false)
    }
  }

  const toggleStreamMute = () => {
    const next = !isVideoMuted
    setVideoMuted(next)
    if (videoRef.current) {
      videoRef.current.muted = next
      if (!next && videoVolume === 0) {
        setVideoVolume(0.5)
        videoRef.current.volume = 0.5
      }
    }
  }

  const handleStreamVolumeChange = (value: number) => {
    const safe = Math.min(1, Math.max(0, value))
    setVideoVolume(safe)
    const nextMuted = safe === 0
    if (nextMuted !== isVideoMuted) {
      setVideoMuted(nextMuted)
    }
    if (videoRef.current) {
      videoRef.current.volume = safe
      videoRef.current.muted = nextMuted
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

  // 竖排模式下，多模态卡片最大高度动态感知容器尺寸（占用 ~48%，上限 360px，下限 160px），
  // 杜绝使用内部高度百分比循环导致卡片被挤压成狭缝或过早触发滚动条
  const verticalMultimodalMaxHeight = useMemo(() => {
    if (containerSize.height <= 0) return 300
    return Math.min(360, Math.max(160, Math.round(containerSize.height * 0.48)))
  }, [containerSize.height])

  // 竖排模式下，为媒体展示预留安全最大高度，避免超高图片挤压多模态描述卡片导致溢出
  const maxVerticalMediaHeight = useMemo(() => {
    if (containerSize.height <= 0 || !multimodalContent) return undefined
    const reservedForCard = Math.min(260, Math.max(140, Math.round(containerSize.height * 0.35)))
    return Math.max(80, containerSize.height - reservedForCard - 36)
  }, [containerSize.height, multimodalContent])

  switch (category) {
    case FileCategory.IMAGE: {
      const mediaLayout = MEDIA_LAYOUT_BY_MODE[mediaFitMode]
      const isSideBySide = computeMediaMultimodalSideBySide({
        containerWidth: containerSize.width,
        containerHeight: containerSize.height,
        naturalWidth: imageNaturalSize?.width,
        naturalHeight: imageNaturalSize?.height,
        mediaFitMode,
        hasMultimodalContent: Boolean(multimodalContent)
      })

      const innerClasses =
        isSideBySide === true
          ? 'flex-1 min-h-0 min-w-0 w-full flex flex-row items-stretch justify-center gap-4'
          : isSideBySide === false
            ? 'my-auto max-h-full min-h-0 min-w-0 w-full flex flex-col items-center justify-center gap-3'
            : mediaLayout.inner

      const bodyClasses =
        isSideBySide === true
          ? 'flex-1 min-h-0 min-w-0 w-full h-full flex flex-col items-center justify-center overflow-hidden gap-2'
          : isSideBySide === false
            ? 'min-h-0 max-h-full max-w-full flex flex-col items-center justify-center gap-2 shrink'
            : mediaLayout.body

      const multimodalBoxClasses =
        isSideBySide === true
          ? 'w-72 sm:w-80 max-w-[42%] h-full flex flex-col overflow-hidden px-4 py-3 bg-muted/40 rounded-lg border border-border/50 shrink-0'
          : isSideBySide === false
            ? 'w-full max-w-2xl px-4 py-3 bg-muted/40 rounded-lg border border-border/50 shrink-0 flex flex-col overflow-hidden'
            : mediaLayout.multimodalBox

      return (
        <div ref={containerRef} className={mediaLayout.outer}>
          <div
            data-testid="preview-media-inner"
            data-layout-direction={
              isSideBySide === true ? 'row' : isSideBySide === false ? 'col' : 'auto'
            }
            className={innerClasses}
          >
            {/* 预览内容的正文区 */}
            <div className={cn(bodyClasses, isPrivate && 'ph-no-capture')}>
              <img
                src={fileUrl}
                alt={fileName}
                className={mediaLayout.mediaElement}
                style={
                  !isSideBySide && maxVerticalMediaHeight
                    ? { maxHeight: `${maxVerticalMediaHeight}px` }
                    : undefined
                }
                onLoad={e => {
                  const { naturalWidth, naturalHeight } = e.currentTarget
                  if (naturalWidth && naturalHeight) {
                    setImageNaturalSize({ width: naturalWidth, height: naturalHeight })
                  }
                }}
              />
            </div>
            {/* 多模态描述文本区 */}
            {multimodalContent && (
              <div
                data-testid="preview-multimodal-box"
                className={cn(multimodalBoxClasses, isPrivate && 'ph-mask')}
                style={
                  !isSideBySide ? { maxHeight: `${verticalMultimodalMaxHeight}px` } : undefined
                }
              >
                <div className="flex items-center justify-between flex-wrap gap-1.5 mb-1.5 shrink-0">
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
                    'text-xs text-foreground/80 whitespace-pre-wrap break-words leading-relaxed flex-1 min-h-0 overflow-y-auto preview-scrollbar pr-1',
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
    case FileCategory.VIDEO: {
      const startSec = highlightRange?.[0] ?? (currentTime !== undefined ? currentTime : undefined)
      const endSec = highlightRange?.[1]
      const hasHighlight = startSec !== undefined && endSec !== undefined && endSec > startSec
      const mediaLayout = MEDIA_LAYOUT_BY_MODE[mediaFitMode]
      const isSideBySide = computeMediaMultimodalSideBySide({
        containerWidth: containerSize.width,
        containerHeight: containerSize.height,
        naturalWidth: videoNaturalSize?.width,
        naturalHeight: videoNaturalSize?.height,
        mediaFitMode,
        hasMultimodalContent: Boolean(multimodalContent)
      })

      const innerClasses =
        isSideBySide === true
          ? 'flex-1 min-h-0 min-w-0 w-full flex flex-row items-stretch justify-center gap-4'
          : isSideBySide === false
            ? 'my-auto max-h-full min-h-0 min-w-0 w-full flex flex-col items-center justify-center gap-3'
            : mediaLayout.inner

      const bodyClasses =
        isSideBySide === true
          ? 'flex-1 min-h-0 min-w-0 w-full h-full flex flex-col items-center justify-center overflow-hidden gap-2'
          : isSideBySide === false
            ? 'min-h-0 max-h-full max-w-full flex flex-col items-center justify-center gap-2 shrink'
            : mediaLayout.body

      const multimodalBoxClasses =
        isSideBySide === true
          ? 'w-72 sm:w-80 max-w-[42%] h-full flex flex-col overflow-hidden px-4 py-3 bg-muted/40 rounded-lg border border-border/50 shrink-0'
          : isSideBySide === false
            ? 'w-full max-w-2xl px-4 py-3 bg-muted/40 rounded-lg border border-border/50 shrink-0 flex flex-col overflow-hidden'
            : mediaLayout.multimodalBox

      return (
        <div ref={containerRef} className={mediaLayout.outer}>
          <div
            data-testid="preview-media-inner"
            data-layout-direction={
              isSideBySide === true ? 'row' : isSideBySide === false ? 'col' : 'auto'
            }
            className={innerClasses}
          >
            {/* 预览内容的正文区 */}
            <div className={cn(bodyClasses, isPrivate && 'ph-no-capture')}>
              {videoDecodeFailed ? (
                /* 浏览器无法解码（AVI/MKV 等）：显示 ffmpeg 静态抽帧 + 外部播放器跳轴引导 */
                <div className={mediaLayout.decodeFailedWrapper}>
                  {staticFrameUrl && !staticFrameBroken ? (
                    <img
                      src={staticFrameUrl}
                      alt={fileName}
                      className={mediaLayout.mediaElement}
                      style={
                        !isSideBySide && maxVerticalMediaHeight
                          ? { maxHeight: `${maxVerticalMediaHeight}px` }
                          : undefined
                      }
                      onError={() => {
                        // WebP 头合法不代表整帧完整；渲染失败时回退占位图标且不立即重试同一坏帧
                        logger.warn(LogCategory.RENDERER, '[视频预览] 静态帧渲染失败，回退占位图标')
                        setStaticFrameBroken(true)
                      }}
                    />
                  ) : (
                    <div className="w-72 h-40 flex items-center justify-center bg-muted/40 rounded shrink-0">
                      <MaterialIcon icon="movie" className="text-5xl text-muted-foreground/50" />
                    </div>
                  )}
                  <div className="flex flex-col items-center gap-2 text-center shrink-0">
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
              ) : streamSession ? (
                /* 浏览器无法解码原生文件：本地 HTTP 双路流式播放 + 受控播放条 */
                <div className={mediaLayout.streamWrapper}>
                  <video
                    key="stream-video"
                    ref={videoRef}
                    src={streamSession.streamUrl}
                    controls={false}
                    autoPlay
                    muted={isVideoMuted}
                    style={
                      !isSideBySide && maxVerticalMediaHeight
                        ? { maxHeight: `${maxVerticalMediaHeight}px` }
                        : undefined
                    }
                    onLoadedMetadata={handleVideoLoadedMetadata}
                    onCanPlay={handleCanPlay}
                    onTimeUpdate={handleTimeUpdate}
                    onVolumeChange={e => {
                      const v = e.currentTarget
                      const safeVol = Math.min(1, Math.max(0, v.volume))
                      const muted = v.muted || safeVol === 0
                      if (Math.abs(safeVol - videoVolume) > 0.01) {
                        setVideoVolume(safeVol)
                      }
                      if (muted !== isVideoMuted) {
                        setVideoMuted(muted)
                      }
                    }}
                    onProgress={markStreamActivity}
                    onLoadedData={e => {
                      markStreamActivity()
                      pendingSeekRef.current = false
                      streamLoadedRef.current = true
                      setStreamLoaded(true)
                      tryResumeStreamPlay(e.currentTarget)
                    }}
                    onPlay={() => setStreamPlaying(true)}
                    onPause={() => setStreamPlaying(false)}
                    onError={handleStreamError}
                    onEnded={handleStreamEnded}
                    className={mediaLayout.mediaElement}
                  >
                    {t('您的浏览器不支持视频播放')}
                  </video>
                  <StreamVideoControls
                    currentSec={streamLogicalTime}
                    durationSec={streamSession.durationSec}
                    playing={streamPlaying}
                    muted={isVideoMuted}
                    volume={videoVolume}
                    highlightRange={highlightRange}
                    onTogglePlay={toggleStreamPlay}
                    onSeek={handleStreamSeek}
                    onToggleMute={toggleStreamMute}
                    onVolumeChange={handleStreamVolumeChange}
                    onOpenExternal={handleExternalSeek}
                  />
                </div>
              ) : (
                <video
                  key="native-video"
                  ref={videoRef}
                  src={fileUrl}
                  controls
                  autoPlay
                  muted={isVideoMuted}
                  style={
                    !isSideBySide && maxVerticalMediaHeight
                      ? { maxHeight: `${maxVerticalMediaHeight}px` }
                      : undefined
                  }
                  onLoadedMetadata={handleVideoLoadedMetadata}
                  onCanPlay={handleCanPlay}
                  onTimeUpdate={handleTimeUpdate}
                  onVolumeChange={e => {
                    const v = e.currentTarget
                    const safeVol = Math.min(1, Math.max(0, v.volume))
                    const muted = v.muted || safeVol === 0
                    if (Math.abs(safeVol - videoVolume) > 0.01) {
                      setVideoVolume(safeVol)
                    }
                    if (muted !== isVideoMuted) {
                      setVideoMuted(muted)
                    }
                  }}
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
                    const startSec = pickFallbackSeekSec(
                      degradeSeekSnapshotRef.current,
                      filePath,
                      currentTime
                    )
                    logger.warn(
                      LogCategory.RENDERER,
                      `[视频预览] 浏览器无法解码视频，尝试流式播放: ${filePath} @ ${startSec}s`
                    )
                    void startStreamPlayback(startSec)
                  }}
                  className={mediaLayout.mediaElement}
                >
                  {t('您的浏览器不支持视频播放')}
                </video>
              )}

              {/* 命中切片指示条与跳轴胶囊 */}
              {(hasHighlight || typeof currentTime === 'number') && (
                <div className="w-full max-w-2xl shrink-0 px-3 py-2 bg-muted/60 rounded-lg border border-border/60 flex flex-col gap-1.5">
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
                data-testid="preview-multimodal-box"
                className={cn(multimodalBoxClasses, isPrivate && 'ph-mask')}
                style={
                  !isSideBySide ? { maxHeight: `${verticalMultimodalMaxHeight}px` } : undefined
                }
              >
                <div className="flex items-center justify-between flex-wrap gap-1.5 mb-1.5 shrink-0">
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
                    'text-xs text-foreground/80 whitespace-pre-wrap break-words leading-relaxed flex-1 min-h-0 overflow-y-auto preview-scrollbar pr-1',
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
