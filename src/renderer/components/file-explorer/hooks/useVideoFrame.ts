import { useEffect, useRef, useState } from 'react'
import { logger, LogCategory } from '@firefly/shared'

/** 时间点归一：非有限数或负值一律回退 0，与规格 §2.1 契约一致 */
export function normalizeSeekSec(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** 降级快照键：绑定进入降级瞬间的「文件|切点」，跨文件或同文件切点变化后快照自动失效 */
export function seekKeyOf(filePath: string, propTime: number | undefined): string {
  // 委托 frameKeyOf，确保降级快照键与抽帧去重键共用同一键归一出口（单一事实源）。
  return frameKeyOf(filePath, normalizeSeekSec(propTime))
}

export interface DegradeSeekSnapshot {
  key: string
  sec: number
}

/**
 * 降级抽帧/外部跳轴时间点。
 * 快照仅在「文件与切点均未变」时有效：跨文件切换或同文件切换命中切片都回退 props，
 * 从而同时避免全局播放进度串位与旧快照锁死新切点。
 */
export function pickFallbackSeekSec(
  snapshot: DegradeSeekSnapshot | null,
  filePath: string,
  propTime: number | undefined
): number {
  if (snapshot && snapshot.key === seekKeyOf(filePath, propTime)) {
    return normalizeSeekSec(snapshot.sec)
  }
  return normalizeSeekSec(propTime)
}

/**
 * 抽帧键归一（共享契约）：`${filePath}|${sec.toFixed(3)}`。
 * 与主进程缓存键、ffmpeg `-ss` 精度严格一致，是渲染层唯一的键构造出口。
 */
export function frameKeyOf(filePath: string, seekSec: number): string {
  return `${filePath}|${normalizeSeekSec(seekSec).toFixed(3)}`
}

export interface UseVideoFrameOptions {
  /** 归一后的抽帧时间点（秒）。调用方须先用 normalizeSeekSec / pickFallbackSeekSec 归一。 */
  seekSec: number
  /**
   * 是否进入抽帧降级态。
   * - FilePreview：`videoDecodeFailed`（原生 <video> 解码失败）
   * - VideoChunkFrame：`hasError`（原生 <video> 解码失败）
   */
  enabled: boolean
  /**
   * 行复用身份键：该值变化时清空旧帧与在途请求。
   * - VideoChunkFrame：虚拟行复用，用 `${repPtsSec}|${startSec}` 区分不同切片行
   * - FilePreview：通常省略（随 filePath 变化整体重建）
   */
  resetKey?: string | number
}

export interface UseVideoFrameResult {
  /** ffmpeg 实时抽帧得到的静态帧 data URL；未抽到或抽帧失败时为 null */
  frameUrl: string | null
  /** 当前已成功抽帧的「文件|时间点」键，供消费方判断是否仍处于有效帧 */
  frameKey: string | null
}

/**
 * 视频抽帧单点化 hook（工单 03 FrameBroker 共享层）。
 *
 * 把原先散落在 FilePreview 与 SearchListCard(VideoChunkFrame) 两处的重复状态机收敛为单点：
 * - 键归一：统一经 frameKeyOf 产出 `${filePath}|${sec.toFixed(3)}`；
 * - 去重：requestedKeyRef 保证同 key 不重复发起（无论 settle 与否）；
 * - 乱序防护：cancelled 标志 + 提交前 key 复核，杜绝旧行/旧切点结果串入；
 * - 切点预清空：同文件换切点先清掉旧帧，避免新帧返回前展示错误时间点画面；
 * - 失败上浮：抽帧失败 / 调用异常一律 logger.warn，frameUrl 保持 null（可见兜底）。
 *
 * 仅承载「单帧渲染 URL」的获取与失效，不形成第二套持久化；缓存事实源仍为主进程
 * video-frame-extractor 的内存 Map（规格 §4.4），本 hook 不重复缓存。
 */
export function useVideoFrame(
  filePath: string,
  { seekSec, enabled, resetKey }: UseVideoFrameOptions
): UseVideoFrameResult {
  const [frameUrl, setFrameUrl] = useState<string | null>(null)
  const [frameKey, setFrameKey] = useState<string | null>(null)
  /**
   * 已发起（在途或已 settle）的请求 key。
   * 重置身份（filePath/resetKey）变化时保留到新 key 被请求为止：
   * 这样在 reset 状态回灌导致的重渲里，effect 重跑仍能凭同 key 跳过，杜绝重复抽帧。
   */
  const requestedKeyRef = useRef<string | null>(null)
  /** 上一次 effect 看到的身份键，用于判定是否需要清空旧帧 */
  const prevIdentityRef = useRef<string | null>(null)

  useEffect(() => {
    const identity = `${filePath}|${resetKey ?? ''}`
    const identityChanged = prevIdentityRef.current !== identity
    prevIdentityRef.current = identity

    if (!enabled || !filePath) {
      // 退出降级态时同步清掉旧帧，保持渲染与状态一致
      if (frameUrl !== null) {
        setFrameUrl(null)
        setFrameKey(null)
      }
      return
    }

    const normalizedSec = normalizeSeekSec(seekSec)
    const nextKey = frameKeyOf(filePath, normalizedSec)

    // 身份变化（跨文件 / 跨行）：清掉旧帧再抽新帧
    if (identityChanged && frameUrl !== null) {
      setFrameUrl(null)
      setFrameKey(null)
    }

    // 同 key 已在途或已抽到帧，无需重复请求
    if (requestedKeyRef.current === nextKey) return
    requestedKeyRef.current = nextKey

    let cancelled = false
    Promise.resolve(window.electronAPI?.utils?.extractVideoFrame?.(filePath, normalizedSec))
      .then(result => {
        if (cancelled) return
        if (!result?.success || !result.dataUrl) {
          logger.warn(LogCategory.RENDERER, '[视频抽帧] ffmpeg 抽帧失败:', result?.error)
          return
        }
        setFrameKey(nextKey)
        setFrameUrl(result.dataUrl)
      })
      .catch(err => {
        if (!cancelled) logger.warn(LogCategory.RENDERER, '[视频抽帧] 抽帧调用异常:', err)
      })
    return () => {
      cancelled = true
    }
    // frameUrl 刻意不入依赖：抽帧成功触发的状态回灌不应重新触发请求；
    // 请求生命周期完全由 requestedKeyRef（按 nextKey）门控。
  }, [filePath, resetKey, enabled, seekSec])

  return { frameUrl, frameKey }
}
