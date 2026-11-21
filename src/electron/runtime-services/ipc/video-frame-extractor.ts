/**
 * 视频切片抽帧服务
 *
 * 目标：对浏览器 <video> 无法原生解码的格式（AVI/MKV/WMV/FLV 等），
 * 复用已内置的 ffmpeg 按指定时间点抽取单帧，转为 WebP base64 data URL 返回渲染进程。
 *
 * 设计约束：
 * 1. 抽单帧（非转码整片）：-ss 定位 + -frames:v 1，毫秒到百毫秒级，与片长无关。
 * 2. 不落库、不落盘：结果以 data URL 内存缓存，进程内复用，避免重复抽帧。
 * 3. 同键并发去重：首帧未返回前复用同一个 Promise，避免多个组件重复起 ffmpeg。
 * 4. 禁止静默降级：ffmpeg 缺失 / 抽帧失败一律 logger.warn 显式上报并上浮错误。
 * 5. 零新增依赖：复用系统内唯一的 ffmpegService 单例与 path 原生工具。
 */

import { execFile } from 'child_process'
import { ffmpegService } from '../system/ffmpeg-service'
import { logger, LogCategory } from '@firefly/shared'

export interface ExtractVideoFrameResult {
  success: boolean
  /** WebP base64 data URL，可直接作为 <img src> */
  dataUrl?: string
  error?: string
}

/** 抽帧结果内存缓存：key = <filePath>|timestampSec(3位)，value = WebP data URL */
const frameCache = new Map<string, string>()
/** 同键并发去重：首帧返回前共享同一个 Promise，避免重复起 ffmpeg 进程 */
const inFlightFrames = new Map<string, Promise<ExtractVideoFrameResult>>()
/** 缓存条目上限，超出时淘汰最早插入项，防止长会话内存无界增长 */
const FRAME_CACHE_MAX = 300

/**
 * 按时间点抽取视频帧，返回 WebP base64 data URL。
 * @param filePath 视频文件绝对路径
 * @param timestampSec 抽帧时间点（秒），内部夹紧为非负有限数
 */
export async function extractVideoFrameAsWebp(
  filePath: string,
  timestampSec: number
): Promise<ExtractVideoFrameResult> {
  if (!filePath) {
    logger.warn(LogCategory.MAIN, '[视频抽帧] 文件路径为空，跳过抽帧')
    return { success: false, error: '文件路径为空' }
  }

  const safeSec = Number.isFinite(timestampSec) && timestampSec > 0 ? timestampSec : 0
  // 与 ffmpeg -ss 的 toFixed(3) 对齐，避免 12.001/12.004 命中同一帧缓存
  const cacheKey = `${filePath}|${safeSec.toFixed(3)}`
  const cached = frameCache.get(cacheKey)
  if (cached) return { success: true, dataUrl: cached }

  const inFlight = inFlightFrames.get(cacheKey)
  if (inFlight) return inFlight

  const ffmpegPath = ffmpegService.getFfmpegPath()
  if (!ffmpegPath) {
    logger.warn(LogCategory.MAIN, '[视频抽帧] 未检测到 FFmpeg，无法为非原生格式抽帧')
    return { success: false, error: 'FFmpeg 未就绪' }
  }

  // -ss 置于 -i 前为快速定位（input seeking），对大文件亦为毫秒~百毫秒级；
  // -frames:v 1 只取一帧；-vf scale 限制宽度避免超大帧产生巨型 data URL；
  // 输出到 pipe:1 直接拿 WebP 二进制，避免临时文件落盘。
  const args = [
    '-ss',
    safeSec.toFixed(3),
    '-i',
    filePath,
    '-frames:v',
    '1',
    '-vf',
    'scale=640:-2',
    '-f',
    'image2pipe',
    '-vcodec',
    'webp',
    'pipe:1'
  ]

  const task = new Promise<ExtractVideoFrameResult>(resolve => {
    execFile(
      ffmpegPath,
      args,
      { windowsHide: true, encoding: 'buffer', maxBuffer: 12 * 1024 * 1024, timeout: 15000 },
      (error, stdout, stderr) => {
        if (error) {
          const detail = (stderr?.toString() || error.message || '').trim().slice(0, 400)
          logger.warn(LogCategory.MAIN, `[视频抽帧] ffmpeg 抽帧失败: ${detail}`)
          resolve({ success: false, error: `抽帧失败: ${detail || error.message}` })
          return
        }
        const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '')
        if (bytes.length === 0) {
          logger.warn(LogCategory.MAIN, `[视频抽帧] ffmpeg 返回空帧: ${filePath} @ ${safeSec}s`)
          resolve({ success: false, error: '抽帧结果为空' })
          return
        }
        // 防止把非 WebP 字节伪装成 data:image/webp 返回给渲染层
        if (
          bytes.length < 12 ||
          bytes.toString('ascii', 0, 4) !== 'RIFF' ||
          bytes.toString('ascii', 8, 12) !== 'WEBP'
        ) {
          logger.warn(
            LogCategory.MAIN,
            `[视频抽帧] ffmpeg 返回非 WebP 数据: ${filePath} @ ${safeSec}s`
          )
          resolve({ success: false, error: '抽帧结果不是有效 WebP' })
          return
        }

        const dataUrl = `data:image/webp;base64,${bytes.toString('base64')}`
        if (frameCache.size >= FRAME_CACHE_MAX) {
          const oldestKey = frameCache.keys().next().value
          if (oldestKey !== undefined) frameCache.delete(oldestKey)
        }
        frameCache.set(cacheKey, dataUrl)
        resolve({ success: true, dataUrl })
      }
    )
  }).finally(() => {
    inFlightFrames.delete(cacheKey)
  })

  inFlightFrames.set(cacheKey, task)
  return task
}
