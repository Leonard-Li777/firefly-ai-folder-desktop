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
 * 4. 全局并发闸门：不同键的抽帧请求也排队，避免搜索页大量切片同时 spawn ffmpeg。
 * 5. 禁止静默降级：ffmpeg 缺失 / 抽帧失败一律 logger.warn 显式上报并上浮错误。
 * 6. 零新增依赖：复用系统内唯一的 ffmpegService 单例与 path 原生工具。
 * 7. 时间点按片长夹紧（2026-11-25 起，随 ffprobe 随包内置）：渲染层传入的时间点来自
 *    分析切片时间轴，短视频/坏时间轴会落在片长之外，ffmpeg 只会吐出空帧；
 *    先用 ffprobe 取真实 duration 把 -ss 夹到 `[0, duration-0.05]`，并把纯音频/非视频
 *    文件提前判为不可抽帧，避免把「请求越界」误报成「抽帧失败」。
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

/** ffprobe 探测结果缓存：key = filePath；同一文件只探一次 */
const probeCache = new Map<string, Promise<VideoProbeInfo | null>>()
/** 探测缓存上限（文件数），避免长会话无界增长 */
const PROBE_CACHE_MAX = 300
/** ffprobe 探测超时：仅读头部元数据，正常在百毫秒级 */
const PROBE_TIMEOUT_MS = 10_000

interface VideoProbeInfo {
  /** 容器时长（秒）；ffprobe 未给出时为 null */
  durationSec: number | null
  /** 是否存在可解码的视频流（纯音频/损坏文件为 false） */
  hasVideoStream: boolean
}

/** 全局同时运行的 ffmpeg 抽帧进程上限；搜索页多切片场景避免 CPU/内存瞬时打满 */
const FRAME_CONCURRENCY_LIMIT = 3
/**
 * 独立于子进程退出的硬超时（execFile timeout + 5s）。
 * execFile 的 timeout 只发 killSignal，若 ffmpeg 卡在不可中断 I/O，回调可能永不触发；
 * 硬超时保证请求一定 settle、闸门许可一定归还，避免局部故障放大为全局排队瘫痪。
 */
const FRAME_HARD_TIMEOUT_MS = 20_000
let activeFrameJobs = 0
const frameJobQueue: Array<() => void> = []

/** 取得一个抽帧槽位；达到上限时进入 FIFO 等待队列 */
/**
 * 用 ffprobe 读取容器时长与是否存在视频流（按 filePath 缓存，单文件只探一次）。
 * ffprobe 未内置 / 探测失败时返回 null，调用方必须退化为「不夹紧时间点」的历史行为，
 * 严禁把探测失败当成「文件无视频流」。
 */
function probeVideoInfo(filePath: string): Promise<VideoProbeInfo | null> {
  const cached = probeCache.get(filePath)
  if (cached) return cached

  const ffprobePath = ffmpegService.getFfprobePath()
  if (!ffprobePath) {
    // ffprobe 缺失不告警刷屏（dev 精简包可能没有），退化为历史行为
    logger.debug(LogCategory.MAIN, '[视频抽帧] 未检测到 ffprobe，跳过时长夹紧')
    return Promise.resolve(null)
  }

  const task = new Promise<VideoProbeInfo | null>(resolve => {
    execFile(
      ffprobePath,
      [
        '-v',
        'error',
        '-protocol_whitelist',
        'file',
        '-show_entries',
        'format=duration:stream=codec_type',
        '-of',
        'json',
        filePath
      ],
      { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true },
      (error, stdout) => {
        if (error) {
          logger.warn(
            LogCategory.MAIN,
            `[视频抽帧] ffprobe 探测失败，退化为不夹紧时间点: ${String(error.message || error)}`
          )
          resolve(null)
          return
        }
        try {
          const data = JSON.parse(String(stdout ?? ''))
          const streams: any[] = Array.isArray(data?.streams) ? data.streams : []
          const durationNum = Number(data?.format?.duration)
          resolve({
            durationSec: Number.isFinite(durationNum) && durationNum > 0 ? durationNum : null,
            hasVideoStream: streams.some(s => s?.codec_type === 'video')
          })
        } catch (e) {
          logger.warn(LogCategory.MAIN, `[视频抽帧] ffprobe 输出解析失败: ${String(e)}`)
          resolve(null)
        }
      }
    )
  })

  if (probeCache.size >= PROBE_CACHE_MAX) {
    const oldestKey = probeCache.keys().next().value
    if (oldestKey !== undefined) probeCache.delete(oldestKey)
  }
  probeCache.set(filePath, task)
  return task
}

/** 取得一个抽帧槽位；达到上限时进入 FIFO 等待队列 */
function acquireFrameSlot(): Promise<void> {
  if (activeFrameJobs < FRAME_CONCURRENCY_LIMIT) {
    activeFrameJobs += 1
    return Promise.resolve()
  }
  return new Promise(resolve => frameJobQueue.push(resolve))
}

/** 归还抽帧槽位；有等待者时直接交接，不减少活跃计数 */
function releaseFrameSlot(): void {
  const next = frameJobQueue.shift()
  if (next) next()
  else activeFrameJobs -= 1
}

/**
 * 按时间点抽取视频帧，返回 WebP base64 data URL。
 * @param filePath 视频文件绝对路径
 * @param timestampSec 抽帧时间点（秒），内部夹紧为非负有限数，不做片长上限截顶
 */
export async function extractVideoFrameAsWebp(
  filePath: string,
  timestampSec: number
): Promise<ExtractVideoFrameResult> {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    logger.warn(LogCategory.MAIN, '[视频抽帧] 文件路径为空或非字符串，跳过抽帧')
    return { success: false, error: '文件路径为空或非字符串' }
  }

  const ffmpegPath = ffmpegService.getFfmpegPath()
  if (!ffmpegPath) {
    logger.warn(LogCategory.MAIN, '[视频抽帧] 未检测到 FFmpeg，无法为非原生格式抽帧')
    return { success: false, error: 'FFmpeg 未就绪' }
  }

  // 时长/流型探测：把越界时间点夹回片内，并提前拦下纯音频/非视频文件。
  // probe 为 null（未内置 ffprobe 或探测失败）时完全沿用历史行为。
  const probe = await probeVideoInfo(filePath)
  if (probe && !probe.hasVideoStream) {
    logger.warn(LogCategory.MAIN, `[视频抽帧] 文件不含视频流，跳过抽帧: ${filePath}`)
    return { success: false, error: '文件不含视频流' }
  }

  const requestedSec = Number.isFinite(timestampSec) && timestampSec > 0 ? timestampSec : 0
  // 留 50ms 余量：-ss 恰好等于 duration 时多数容器取不到帧
  const maxSeekSec =
    probe?.durationSec != null ? Math.max(0, probe.durationSec - 0.05) : null
  const safeSec = maxSeekSec != null ? Math.min(requestedSec, maxSeekSec) : requestedSec
  // 与 ffmpeg -ss 的 toFixed(3) 对齐，避免 12.001/12.004 命中同一帧缓存
  const cacheKey = `${filePath}|${safeSec.toFixed(3)}`
  const cached = frameCache.get(cacheKey)
  if (cached) return { success: true, dataUrl: cached }

  const inFlight = inFlightFrames.get(cacheKey)
  if (inFlight) return inFlight

  // -ss 置于 -i 前为快速定位（input seeking），对大文件亦为毫秒~百毫秒级；
  // -frames:v 1 只取一帧；-vf scale 限制宽度避免超大帧产生巨型 data URL；
  // -nostdin 防止 execFile 场景下 ffmpeg 监听 stdin 导致挂起；
  // 输出到 pipe:1 直接拿 WebP 二进制，避免临时文件落盘。
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
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

  const queuedAt = Date.now()
  const run = async (): Promise<ExtractVideoFrameResult> => {
    await acquireFrameSlot()
    const startedAt = Date.now()
    let spawnLogged = false
    /** 每次真实 spawn 仅记一行，路径/data URL 均不落日志，仅取扩展名 */
    const logSpawn = (ok: boolean, bytes: number) => {
      if (spawnLogged) return
      spawnLogged = true
      const ext = filePath.includes('.') ? filePath.split('.').pop()!.toLowerCase() : ''
      logger.info(
        LogCategory.MAIN,
        JSON.stringify({
          event: 'video_frame_extract',
          ext,
          elapsedMs: Date.now() - startedAt,
          queueWaitMs: startedAt - queuedAt,
          bytes,
          ok
        })
      )
    }
    try {
      return await new Promise<ExtractVideoFrameResult>(resolve => {
        let settled = false
        let hardTimer: NodeJS.Timeout | undefined
        // 幂等收口：子进程回调与硬超时谁先到谁生效，保证槽位只归还一次
        const finish = (result: ExtractVideoFrameResult) => {
          if (settled) return
          settled = true
          if (hardTimer) clearTimeout(hardTimer)
          resolve(result)
        }
        hardTimer = setTimeout(() => {
          logger.warn(LogCategory.MAIN, `[视频抽帧] 硬超时强制结束: ${filePath} @ ${safeSec}s`)
          logSpawn(false, 0)
          finish({ success: false, error: '抽帧硬超时' })
        }, FRAME_HARD_TIMEOUT_MS)

        execFile(
          ffmpegPath,
          args,
          {
            windowsHide: true,
            encoding: 'buffer',
            maxBuffer: 12 * 1024 * 1024,
            timeout: 15000,
            killSignal: 'SIGKILL'
          },
          (error, stdout, stderr) => {
            if (settled) {
              // 硬超时后的迟到回调：丢弃，不写缓存、不再次归还许可
              logger.warn(
                LogCategory.MAIN,
                `[视频抽帧] 丢弃硬超时后的迟到回调: ${filePath} @ ${safeSec}s`
              )
              return
            }
            if (error) {
              const detail = (stderr?.toString() || error.message || '').trim().slice(0, 400)
              const reason =
                (error as NodeJS.ErrnoException)?.code === 'ETIMEDOUT'
                  ? '抽帧超时'
                  : `抽帧失败: ${detail || error.message}`
              logger.warn(LogCategory.MAIN, `[视频抽帧] ${reason}`)
              logSpawn(false, 0)
              finish({ success: false, error: reason })
              return
            }

            const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '')
            if (bytes.length === 0) {
              logger.warn(LogCategory.MAIN, `[视频抽帧] ffmpeg 返回空帧: ${filePath} @ ${safeSec}s`)
              logSpawn(false, 0)
              finish({ success: false, error: '抽帧结果为空' })
              return
            }

            // 防止把非 WebP 字节或截断输出伪装成 data:image/webp 返回给渲染层
            const isWebpHeader =
              bytes.length >= 12 &&
              bytes.toString('ascii', 0, 4) === 'RIFF' &&
              bytes.toString('ascii', 8, 12) === 'WEBP'
            const riffSize = bytes.length >= 8 ? bytes.readUInt32LE(4) : -1
            if (!isWebpHeader || riffSize !== bytes.length - 8) {
              logger.warn(
                LogCategory.MAIN,
                `[视频抽帧] ffmpeg 返回非完整 WebP: ${filePath} @ ${safeSec}s`
              )
              logSpawn(false, bytes.length)
              finish({ success: false, error: '抽帧结果不是有效 WebP' })
              return
            }

            const dataUrl = `data:image/webp;base64,${bytes.toString('base64')}`
            if (frameCache.size >= FRAME_CACHE_MAX) {
              const oldestKey = frameCache.keys().next().value
              if (oldestKey !== undefined) frameCache.delete(oldestKey)
            }
            // cache.set 先于 Promise settle；inFlight 在外部 .finally 删除，两者之间无空窗
            frameCache.set(cacheKey, dataUrl)
            logSpawn(true, bytes.length)
            finish({ success: true, dataUrl })
          }
        )
      })
    } finally {
      releaseFrameSlot()
    }
  }

  // settle 后无论成功或失败都移除 inFlightFrames，禁止它充当第二缓存层
  const task = run().finally(() => {
    inFlightFrames.delete(cacheKey)
  })
  inFlightFrames.set(cacheKey, task)
  return task
}
