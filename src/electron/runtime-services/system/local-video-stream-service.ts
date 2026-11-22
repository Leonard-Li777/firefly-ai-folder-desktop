import { createHash, timingSafeEqual } from 'crypto'
import { execFile, spawn, type ChildProcess } from 'child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'

import { FileCategory, getFileCategory, logger, LogCategory } from '@firefly/shared'

import { ffmpegService } from './ffmpeg-service'

export type StreamMode = 'remux' | 'transcode'

/** 媒体探测元数据（跳过 attached_pic 封面流后的首个真实视频流） */
export interface VideoProbeMeta {
  durationSec: number | null
  videoCodec: string | null
  audioCodec: string | null
  hasAudio: boolean
  width: number | null
  height: number | null
  pixFmt: string | null
  bitsPerRawSample: number | null
  videoProfile: string | null
  /** 0/90/180/270 为直角，其他非直角保留原始度数，null 表示解析异常（均强制 transcode） */
  rotationDeg: number | null
  /** ffprobe 绝对 stream.index，跳过封面流后的真实视频流 */
  videoStreamIndex: number | null
}

export interface PrepareStreamResult {
  success: boolean
  streamId?: string
  streamUrl?: string
  durationSec?: number | null
  actualStartSec?: number
  mode?: StreamMode
  error?: string
}

export interface SeekStreamResult {
  success: boolean
  streamUrl?: string
  actualStartSec?: number
  mode?: StreamMode
  error?: string
}

export interface ReleaseStreamResult {
  success: boolean
  error?: string
}

interface PendingSeekPlan {
  sid: number
  targetSec: number
  actualStartSec: number
  mode: StreamMode
}

type SeekPlanDraft = Omit<PendingSeekPlan, 'sid'>

interface ActiveStreamInstance {
  requestId: string
  generation: number
  process: ChildProcess
  res: ServerResponse
  startupTimer?: NodeJS.Timeout
  intentionalKill: boolean
}

interface StreamSession {
  streamId: string
  filePath: string
  fileKey: string
  token: string
  probeMeta: VideoProbeMeta
  baseMode: StreamMode
  pendingSeekPlan: PendingSeekPlan
  seekSeq: number
  streamUrl: string
  createdAt: number
  lastActivityAt: number
  generation: number
  activeInstance?: ActiveStreamInstance
}

const STARTUP_TIMEOUT_MS = 10_000
const PROBE_TIMEOUT_MS = 3_000
const IDLE_TTL_MS = 5 * 60_000
const MAX_SESSION_TTL_MS = 2 * 60 * 60_000
const SWEEP_INTERVAL_MS = 60_000
const MAX_ACTIVE_STREAMS = 2
const PROBE_CACHE_MAX = 200
const KEYFRAME_CACHE_MAX = 500
const STDERR_TAIL_MAX = 4096

function normalizeRotation(raw: unknown): number | null {
  const num = Number(raw)
  if (!Number.isFinite(num)) return null
  let deg = Math.round(num) % 360
  if (deg < 0) deg += 360
  return deg
}

function parseSideDataRotation(stream: any): number | null {
  const side = Array.isArray(stream?.side_data_list)
    ? stream.side_data_list.find((item: any) =>
        /display\s*matrix/i.test(String(item?.side_data_type ?? ''))
      )
    : null
  if (side && Number.isFinite(Number(side.rotation))) {
    // ffprobe 新版 side_data 的 rotation 为顺时针角度，统一取反为逆时针
    return normalizeRotation(-Number(side.rotation))
  }
  if (stream?.tags && stream.tags.rotate !== undefined) return normalizeRotation(stream.tags.rotate)
  return null
}

function isRemuxable(meta: VideoProbeMeta): boolean {
  if (meta.videoStreamIndex === null) return false
  if (meta.rotationDeg !== 0) return false
  if (meta.pixFmt !== 'yuv420p') return false
  if (meta.bitsPerRawSample !== null && meta.bitsPerRawSample !== 8) return false
  if (meta.videoCodec !== 'h264' && meta.videoCodec !== 'avc1') return false
  if (/high\s*10|\b(10|12)\b|4:2:2|4:4:4/i.test(meta.videoProfile ?? '')) return false
  return true
}

function buildVideoFilter(rotation: number | null): string {
  let rot = ''
  if (rotation === 90) rot = 'transpose=1,'
  else if (rotation === 270) rot = 'transpose=2,'
  else if (rotation === 180) rot = 'hflip,vflip,'
  else if (rotation != null && rotation !== 0) rot = `rotate=${rotation}*PI/180,`
  // 先旋转再按长边 <= 1280 缩放；逗号必须转义，因为 argv 不经过 shell
  return `${rot}scale=w=if(gte(iw\\,ih)\\,trunc(min(1280\\,iw)/2)*2\\,-2):h=if(gte(iw\\,ih)\\,-2\\,trunc(min(1280\\,ih)/2)*2),setsar=1`
}

function verifyToken(expected: string, provided: string | null): boolean {
  if (!provided) return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

function resolveQuerySeekSec(raw: string | null, durationSec: number | null): number | null {
  if (raw === null) return 0
  const t = Number(raw)
  if (raw === '' || !Number.isFinite(t) || t < 0) return null
  const dur = durationSec != null && durationSec > 0 ? durationSec : Number.POSITIVE_INFINITY
  return Math.min(t, Math.max(0, dur - 0.5))
}

function clampTargetSec(value: number, durationSec: number | null): number {
  const safe = Number.isFinite(value) && value >= 0 ? value : 0
  const dur = durationSec != null && durationSec > 0 ? durationSec : Number.POSITIVE_INFINITY
  return Math.min(safe, Math.max(0, dur - 0.5))
}

function basenameForLog(filePath: string): string {
  try {
    return path.basename(filePath)
  } catch {
    return '<unknown>'
  }
}

/**
 * 本地 HTTP 智能双路视频流式播放服务（主进程单例）。
 * 仅在 FilePreview 原生 <video> 解码失败后按需启用：快车道 remux（-c:v copy）+ 兼容车道轻量转码，
 * 经 127.0.0.1 随机端口 fMP4 流式直出，零落盘、零 Schema 改动。
 */
export class LocalVideoStreamService {
  private static instance: LocalVideoStreamService | null = null
  /** 仅供单测缩短首字节看门狗；生产恒为 10s */
  private static startupTimeoutMs = STARTUP_TIMEOUT_MS

  private server: Server | null = null
  private serverPort = 0
  private sessions = new Map<string, StreamSession>()
  private probeCache = new Map<string, VideoProbeMeta>()
  private keyframeCache = new Map<string, number | null>()
  private sweepTimer: NodeJS.Timeout | null = null
  private quitHookInstalled = false

  static getInstance(): LocalVideoStreamService {
    if (!LocalVideoStreamService.instance) {
      LocalVideoStreamService.instance = new LocalVideoStreamService()
    }
    return LocalVideoStreamService.instance
  }

  /** 供单测重置单例状态 */
  static resetForTest(): void {
    LocalVideoStreamService.instance = null
    LocalVideoStreamService.startupTimeoutMs = STARTUP_TIMEOUT_MS
  }

  static setStartupTimeoutForTest(ms: number): void {
    LocalVideoStreamService.startupTimeoutMs =
      Number.isFinite(ms) && ms > 0 ? ms : STARTUP_TIMEOUT_MS
  }

  async prepare(filePath: string, startSec = 0): Promise<PrepareStreamResult> {
    if (typeof filePath !== 'string' || filePath.length === 0 || !path.isAbsolute(filePath)) {
      return { success: false, error: '文件路径为空或非绝对路径' }
    }
    if (typeof startSec !== 'number' || !Number.isFinite(startSec) || startSec < 0) {
      return { success: false, error: 'INVALID_SEEK_PARAM' }
    }

    let stat: fs.Stats
    try {
      stat = await fs.promises.stat(filePath)
      if (!stat.isFile()) return { success: false, error: '目标不是常规文件' }
    } catch {
      return { success: false, error: '文件不存在或不可访问' }
    }
    if (getFileCategory(filePath) !== FileCategory.VIDEO) {
      return { success: false, error: '目标不是视频文件' }
    }
    const ffmpegPath = ffmpegService.getFfmpegPath()
    if (!ffmpegPath) return { success: false, error: 'FFmpeg 未就绪' }

    const fileKey = await this.getFileKey(filePath, stat)
    const probeMeta = await this.probe(filePath, fileKey)
    if (!probeMeta) return { success: false, error: '媒体探测失败' }

    const targetSec = clampTargetSec(startSec, probeMeta.durationSec)
    const plan = await this.buildSeekPlan(filePath, fileKey, probeMeta, targetSec)

    // 同文件仅空闲会话可幂等复用；同文件双窗格同时活跃时新建独立会话
    const existing = this.findByFilePath(filePath, true)
    if (existing) {
      existing.lastActivityAt = Date.now()
      this.applySeek(existing, plan)
      return this.toPrepareResult(existing)
    }

    if (this.sessions.size >= MAX_ACTIVE_STREAMS) {
      const idle = this.oldestIdleSession()
      if (!idle) {
        logger.warn(LogCategory.MAIN, '[视频流] 会话已满且无空闲会话可驱逐')
        return { success: false, error: 'STREAM_CAPACITY_EXCEEDED' }
      }
      this.terminateSession(idle)
      this.sessions.delete(idle.streamId)
      logger.warn(
        LogCategory.MAIN,
        `[视频流] 活跃流达上限 ${MAX_ACTIVE_STREAMS}，淘汰空闲会话 ${idle.streamId}`
      )
    }

    await this.ensureServer()

    const streamId = createHash('sha256')
      .update(`${fileKey}|${Date.now()}|${Math.random()}`)
      .digest('hex')
      .slice(0, 24)
    const token = createHash('sha256')
      .update(`${streamId}|${Date.now()}|${Math.random()}`)
      .digest('hex')
    const session: StreamSession = {
      streamId,
      filePath,
      fileKey,
      token,
      probeMeta,
      baseMode: isRemuxable(probeMeta) ? 'remux' : 'transcode',
      pendingSeekPlan: {
        sid: 1,
        targetSec: plan.targetSec,
        actualStartSec: plan.actualStartSec,
        mode: plan.mode
      },
      seekSeq: 1,
      streamUrl: '',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      generation: 0
    }
    session.streamUrl = this.buildStreamUrl(session)
    this.sessions.set(streamId, session)
    this.ensureSweepTimer()

    logger.info(
      LogCategory.MAIN,
      `[视频流] prepare 成功: file=${basenameForLog(filePath)} mode=${plan.mode} actualStart=${plan.actualStartSec.toFixed(3)}s`
    )
    return this.toPrepareResult(session)
  }

  /**
   * Seek 唯一强制入口：只计算计划与拼接新 URL，绝不 spawn 子进程。
   * 新 URL 携带递增的 sid 规避 Chromium 媒体缓存复用旧流。
   */
  async seek(streamId: string, targetSec: number): Promise<SeekStreamResult> {
    const session = this.sessions.get(streamId)
    if (!session) return { success: false, error: '会话不存在或已释放' }
    if (typeof targetSec !== 'number' || !Number.isFinite(targetSec) || targetSec < 0) {
      return { success: false, error: 'INVALID_SEEK_PARAM' }
    }

    const clamped = clampTargetSec(targetSec, session.probeMeta.durationSec)
    const plan = await this.buildSeekPlan(
      session.filePath,
      session.fileKey,
      session.probeMeta,
      clamped
    )
    session.lastActivityAt = Date.now()
    this.applySeek(session, plan)
    logger.info(
      LogCategory.MAIN,
      `[视频流] seek: file=${basenameForLog(session.filePath)} target=${clamped.toFixed(3)}s actualStart=${plan.actualStartSec.toFixed(3)}s mode=${plan.mode}`
    )
    return {
      success: true,
      streamUrl: session.streamUrl,
      actualStartSec: plan.actualStartSec,
      mode: plan.mode
    }
  }

  release(streamId: string): ReleaseStreamResult {
    if (typeof streamId !== 'string' || streamId.length === 0) {
      return { success: false, error: 'streamId 为空' }
    }
    const session = this.sessions.get(streamId)
    if (!session) return { success: true } // 幂等：未知 streamId 亦成功
    this.terminateSession(session)
    this.sessions.delete(streamId)
    return { success: true }
  }

  shutdown(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    for (const session of this.sessions.values()) this.terminateSession(session)
    this.sessions.clear()
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }

  /** 挂载 app.before-quit，幂等 */
  installQuitHook(): void {
    if (this.quitHookInstalled) return
    this.quitHookInstalled = true
    app.on('before-quit', () => this.shutdown())
  }

  // ---------------- 私有实现 ----------------

  private toPrepareResult(session: StreamSession): PrepareStreamResult {
    return {
      success: true,
      streamId: session.streamId,
      streamUrl: session.streamUrl,
      durationSec: session.probeMeta.durationSec,
      actualStartSec: session.pendingSeekPlan.actualStartSec,
      mode: session.pendingSeekPlan.mode
    }
  }

  /** idleOnly=true 时仅复用无活跃连接的同文件会话，支持双窗格同文件同时播放 */
  private findByFilePath(filePath: string, idleOnly = false): StreamSession | null {
    for (const session of this.sessions.values()) {
      if (session.filePath === filePath && (!idleOnly || !session.activeInstance)) return session
    }
    return null
  }

  private applySeek(session: StreamSession, plan: SeekPlanDraft): void {
    session.seekSeq += 1
    session.pendingSeekPlan = {
      sid: session.seekSeq,
      targetSec: plan.targetSec,
      actualStartSec: plan.actualStartSec,
      mode: plan.mode
    }
    session.streamUrl = this.buildStreamUrl(session)
  }

  private buildStreamUrl(session: StreamSession): string {
    const plan = session.pendingSeekPlan
    return `http://127.0.0.1:${this.serverPort}/stream/${session.streamId}?token=${session.token}&t=${plan.actualStartSec.toFixed(3)}&sid=${plan.sid}`
  }

  private async getFileKey(filePath: string, stat: fs.Stats): Promise<string> {
    let real = filePath
    try {
      real = await fs.promises.realpath(filePath)
    } catch {
      // 单测中的虚拟 Windows 路径无法 realpath，退回原路径
    }
    return `${real}|${stat.size ?? ''}|${stat.mtimeMs ?? ''}`
  }

  /** 只在 remux 快车道探测关键帧；探测异常/探空统一降级 transcode，绝不虚报 actualStartSec */
  private async buildSeekPlan(
    filePath: string,
    fileKey: string,
    meta: VideoProbeMeta,
    targetSec: number
  ): Promise<SeekPlanDraft> {
    let mode: StreamMode = isRemuxable(meta) ? 'remux' : 'transcode'
    if (mode === 'remux') {
      const index = meta.videoStreamIndex
      const keyframePts =
        index === null
          ? null
          : await this.findNearestKeyframeBefore(filePath, fileKey, index, targetSec)
      if (keyframePts === null) {
        logger.warn(LogCategory.MAIN, '[视频流] 关键帧探测失败/探空，本次流降级 transcode')
        mode = 'transcode'
      } else {
        return { targetSec, actualStartSec: keyframePts, mode }
      }
    }
    return { targetSec, actualStartSec: targetSec, mode }
  }

  private async ensureServer(): Promise<void> {
    if (this.server) return
    this.server = createServer((req, res) => this.handleHttp(req, res))
    this.server.on('error', err =>
      logger.warn(LogCategory.MAIN, `[视频流] HTTP 服务错误: ${String(err)}`)
    )
    this.server.on('clientError', (_err, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err)
      this.server!.once('error', onError)
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address()
        if (addr && typeof addr === 'object') this.serverPort = addr.port
        this.server!.removeListener('error', onError)
        resolve()
      })
    })
    logger.info(LogCategory.MAIN, `[视频流] 回环 HTTP 服务已启动: 127.0.0.1:${this.serverPort}`)
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    // 显式忽略 Range：Chromium 媒体加载默认带 Range: bytes=0-，恒返 200 流式响应
    void req.headers.range

    const url = new URL(req.url || '', `http://127.0.0.1:${this.serverPort}`)
    const match = /^\/stream\/([a-f0-9]+)$/.exec(url.pathname)
    if (!match) {
      res.writeHead(404).end('Not Found')
      return
    }
    const session = this.sessions.get(match[1])
    if (!session) {
      res.writeHead(404).end('Not Found')
      return
    }
    if (!verifyToken(session.token, url.searchParams.get('token'))) {
      res.writeHead(403).end('Forbidden')
      return
    }

    const querySec = resolveQuerySeekSec(url.searchParams.get('t'), session.probeMeta.durationSec)
    if (querySec === null) {
      this.writeJsonError(res, 400, 'INVALID_SEEK_PARAM')
      return
    }
    const requestedSid = Number(url.searchParams.get('sid') ?? '')
    if (!Number.isFinite(requestedSid) || requestedSid !== session.pendingSeekPlan.sid) {
      this.writeJsonError(res, 409, 'STALE_STREAM_URL')
      return
    }

    session.lastActivityAt = Date.now()
    const myGen = ++session.generation
    const old = session.activeInstance
    if (old) {
      old.intentionalKill = true
      this.terminateInstance(old)
    }

    // 直接消费预计算计划：HTTP 路径绝不再次运行 ffprobe
    const plan = session.pendingSeekPlan
    const ffmpegPath = ffmpegService.getFfmpegPath()
    if (!ffmpegPath) {
      this.writeJsonError(res, 502, 'FFMPEG_NOT_READY')
      return
    }

    const args = this.buildStreamArgs(session, plan)
    let proc: ChildProcess
    try {
      proc = spawn(ffmpegPath, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      logger.warn(LogCategory.MAIN, `[视频流] spawn 失败: ${String(err)}`)
      this.writeJsonError(res, 502, 'SPAWN_FAILED')
      return
    }

    const requestId = createHash('sha256')
      .update(`${session.streamId}|${myGen}|${Date.now()}`)
      .digest('hex')
      .slice(0, 16)
    const instance: ActiveStreamInstance = {
      requestId,
      generation: myGen,
      process: proc,
      res,
      intentionalKill: false
    }

    // 二次校验：spawn 期间若已被更新一代抢占，立即回收孤儿，绝不覆盖新一代 activeInstance
    if (myGen !== session.generation) {
      instance.intentionalKill = true
      this.terminateInstance(instance)
      return
    }
    session.activeInstance = instance

    let stderrTail = ''
    proc.stderr?.on('data', chunk => {
      stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_MAX)
    })

    let gotFirstByte = false
    instance.startupTimer = setTimeout(() => {
      if (!gotFirstByte && !instance.intentionalKill && session.generation === myGen) {
        logger.warn(LogCategory.MAIN, `[视频流] 首字节超时，终止实例 ${requestId}`)
        instance.intentionalKill = true
        // 先写 502 再回收，否则 terminateInstance 的 res.end() 会先冲出空 200
        if (!res.headersSent && !res.writableEnded && !res.destroyed) {
          this.writeJsonError(res, 502, 'STREAM_START_TIMEOUT')
        }
        this.terminateInstance(instance)
      }
    }, LocalVideoStreamService.startupTimeoutMs)

    // 200 响应头延迟到首字节写出：超时时才能合法返回 502，而非已 flush 后再改状态码
    proc.stdout?.on('data', chunk => {
      if (!gotFirstByte) {
        gotFirstByte = true
        this.clearStartupTimer(instance)
      }
      if (session.generation !== myGen || instance.intentionalKill) return
      if (res.writableEnded || res.destroyed) return
      if (!res.headersSent) {
        res.writeHead(200, {
          'Content-Type': 'video/mp4',
          'Cache-Control': 'no-store',
          'Access-Control-Allow-Origin': '*',
          Connection: 'close',
          'X-Stream-Actual-Start-Sec': plan.actualStartSec.toFixed(3)
        })
      }
      res.write(chunk)
    })
    proc.stdout?.on('error', err => {
      this.clearStartupTimer(instance)
      if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET') {
        logger.warn(LogCategory.MAIN, `[视频流] stdout 异常: ${String(err)}`)
      }
    })
    proc.stderr?.on('error', () => {})
    proc.on('error', err => {
      this.clearStartupTimer(instance)
      logger.warn(LogCategory.MAIN, `[视频流] ffmpeg 进程错误: ${String(err)}`)
    })
    proc.on('exit', code => {
      this.clearStartupTimer(instance)
      if (instance.intentionalKill) return
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        this.writeJsonError(res, 502, 'STREAM_EXIT_EARLY')
        this.terminateInstance(instance)
        return
      }
      if (code !== 0 && session.activeInstance?.requestId === instance.requestId) {
        logger.warn(
          LogCategory.MAIN,
          `[视频流] ffmpeg 异常退出 code=${code}: ${stderrTail.slice(-200)}`
        )
        if (!res.writableEnded && !res.destroyed) res.destroy()
      }
    })

    res.on('close', () => {
      this.clearStartupTimer(instance)
      if (
        session.activeInstance?.requestId === instance.requestId &&
        session.generation === myGen
      ) {
        this.terminateInstance(instance)
        session.activeInstance = undefined
      }
    })
  }

  private writeJsonError(res: ServerResponse, status: number, error: string): void {
    if (res.headersSent || res.writableEnded || res.destroyed) return
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ success: false, error }))
  }

  private clearStartupTimer(instance: ActiveStreamInstance): void {
    if (instance.startupTimer) {
      clearTimeout(instance.startupTimer)
      instance.startupTimer = undefined
    }
  }

  private buildStreamArgs(session: StreamSession, plan: PendingSeekPlan): string[] {
    const meta = session.probeMeta
    const index = meta.videoStreamIndex ?? 0
    const common = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-protocol_whitelist',
      'file',
      '-fflags',
      '+genpts'
    ]
    const maps = ['-map', `0:${index}`, ...(meta.hasAudio ? ['-map', '0:a:0'] : []), '-sn', '-dn']
    const audio = meta.hasAudio
      ? [
          '-c:a',
          'aac',
          '-profile:a',
          'aac_low',
          '-ac',
          '2',
          '-ar',
          '44100',
          '-b:a',
          '128k',
          '-af',
          'aresample=async=1:first_pts=0'
        ]
      : ['-an']
    const mux = [
      '-avoid_negative_ts',
      'make_zero',
      '-max_muxing_queue_size',
      '1024',
      '-frag_duration',
      '1000000',
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      '-f',
      'mp4',
      'pipe:1'
    ]

    if (plan.mode === 'remux') {
      return [
        ...common,
        '-ss',
        plan.actualStartSec.toFixed(3),
        '-i',
        session.filePath,
        ...maps,
        '-c:v',
        'copy',
        ...audio,
        ...mux
      ]
    }

    return [
      ...common,
      '-noautorotate',
      '-ss',
      plan.targetSec.toFixed(3),
      '-i',
      session.filePath,
      ...maps,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-tune',
      'zerolatency',
      '-crf',
      '23',
      '-pix_fmt',
      'yuv420p',
      '-vf',
      buildVideoFilter(meta.rotationDeg),
      '-force_key_frames',
      'expr:gte(t,n_forced*2)',
      '-g',
      '600',
      '-keyint_min',
      '48',
      '-sc_threshold',
      '0',
      '-threads',
      '2',
      ...audio,
      ...mux
    ]
  }

  private async probe(filePath: string, fileKey: string): Promise<VideoProbeMeta | null> {
    const cached = this.probeCache.get(fileKey)
    if (cached) return cached
    const ffprobePath = ffmpegService.getFfprobePath()
    if (!ffprobePath) return this.probeViaFfmpeg(filePath, fileKey)

    const args = [
      '-v',
      'error',
      '-protocol_whitelist',
      'file',
      '-show_entries',
      'stream=index,codec_type,codec_name,width,height,pix_fmt,bits_per_raw_sample,profile:stream_tags=rotate:stream_side_data=rotation:format=duration',
      '-of',
      'json',
      filePath
    ]
    try {
      const stdout = await this.execFileText(ffprobePath, args)
      const meta = this.parseProbeJson(stdout)
      this.putProbeCache(fileKey, meta)
      return meta
    } catch (err) {
      logger.warn(LogCategory.MAIN, `[视频流] ffprobe 失败，回退 ffmpeg: ${String(err)}`)
      return this.probeViaFfmpeg(filePath, fileKey)
    }
  }

  private execFileText(bin: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => {
          if (err) reject(err)
          else resolve(String(stdout ?? ''))
        }
      )
    })
  }

  private parseProbeJson(json: string): VideoProbeMeta {
    let data: any
    try {
      data = JSON.parse(json)
    } catch {
      return this.emptyMeta()
    }
    const streams: any[] = Array.isArray(data?.streams) ? data.streams : []
    const video =
      streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic) ??
      streams.find(s => s.codec_name && !s.codec_type) ??
      null
    const audio = streams.find(s => s.codec_type === 'audio') ?? null
    const durationNum = Number(data?.format?.duration ?? video?.duration ?? NaN)
    const bits = Number(video?.bits_per_raw_sample)
    return {
      durationSec: Number.isFinite(durationNum) && durationNum > 0 ? durationNum : null,
      videoCodec: video?.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
      hasAudio: Boolean(audio),
      width: Number.isFinite(video?.width) ? video.width : null,
      height: Number.isFinite(video?.height) ? video.height : null,
      pixFmt: video?.pix_fmt ?? null,
      bitsPerRawSample: Number.isFinite(bits) && bits > 0 ? bits : null,
      videoProfile: video?.profile ?? null,
      rotationDeg: video ? parseSideDataRotation(video) : null,
      videoStreamIndex: video && Number.isFinite(video.index) ? video.index : null
    }
  }

  private async probeViaFfmpeg(filePath: string, fileKey: string): Promise<VideoProbeMeta | null> {
    const ffmpegPath = ffmpegService.getFfmpegPath()
    if (!ffmpegPath) return null
    const text = await new Promise<string>(resolve => {
      execFile(
        ffmpegPath,
        ['-hide_banner', '-i', filePath],
        { windowsHide: true, timeout: PROBE_TIMEOUT_MS },
        err => resolve(String(err?.message ?? ''))
      )
    })
    const codec = /Video:\s*(\w+)/.exec(text)?.[1] ?? null
    const audio = /Audio:\s*(\w+)/.exec(text)?.[1] ?? null
    const dur = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(text)
    const durationSec = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) : null
    const pixFmt = /Video:.*?,\s*(\w*(?:420|422|444|p10|10le)\w*)/.exec(text)?.[1] ?? null
    const rotationMatch = /rotation\s*:\s*(-?\d+)/i.exec(text)
    const meta: VideoProbeMeta = {
      durationSec,
      videoCodec: codec,
      audioCodec: audio,
      hasAudio: Boolean(audio),
      width: null,
      height: null,
      pixFmt,
      bitsPerRawSample: pixFmt && /10|12/.test(pixFmt) ? 10 : pixFmt ? 8 : null,
      videoProfile: null,
      rotationDeg: rotationMatch ? normalizeRotation(rotationMatch[1]) : 0,
      videoStreamIndex: codec ? 0 : null
    }
    this.putProbeCache(fileKey, meta)
    return meta
  }

  private emptyMeta(): VideoProbeMeta {
    return {
      durationSec: null,
      videoCodec: null,
      audioCodec: null,
      hasAudio: false,
      width: null,
      height: null,
      pixFmt: null,
      bitsPerRawSample: null,
      videoProfile: null,
      rotationDeg: null,
      videoStreamIndex: null
    }
  }

  private putProbeCache(fileKey: string, meta: VideoProbeMeta): void {
    if (this.probeCache.size >= PROBE_CACHE_MAX) {
      const oldest = this.probeCache.keys().next().value
      if (oldest !== undefined) this.probeCache.delete(oldest)
    }
    this.probeCache.set(fileKey, meta)
  }

  /** 纯封装层关键帧探测：两轮扩窗，只认 flags 含 K 的 packet，探空返回 null */
  private async findNearestKeyframeBefore(
    filePath: string,
    fileKey: string,
    videoStreamIndex: number,
    targetSec: number
  ): Promise<number | null> {
    const key = `${fileKey}|${videoStreamIndex}|kf@${Math.floor(targetSec)}`
    const cached = this.keyframeCache.get(key)
    // 同秒桶缓存也可能越过更精确的 targetSec，必须二次校验
    if (cached !== undefined && (cached === null || cached <= targetSec)) return cached
    const ffprobePath = ffmpegService.getFfprobePath()
    if (!ffprobePath) return null

    for (const window of [15, 60]) {
      const start = Math.max(0, targetSec - window)
      const args = [
        '-v',
        'error',
        '-protocol_whitelist',
        'file',
        '-select_streams',
        String(videoStreamIndex),
        '-show_entries',
        'packet=pts_time,flags',
        '-of',
        'csv=p=0',
        '-read_intervals',
        `${start.toFixed(3)}%${(targetSec + 0.001).toFixed(3)}`,
        filePath
      ]
      try {
        const stdout = await this.execFileText(ffprobePath, args)
        let nearest = -1
        for (const line of stdout.split(/\r?\n/)) {
          const [ptsRaw, flagsRaw = ''] = line.trim().split(',')
          if (!flagsRaw.includes('K')) continue
          const pts = Number(ptsRaw)
          if (Number.isFinite(pts) && pts <= targetSec && pts > nearest) nearest = pts
        }
        if (nearest >= 0) {
          this.putKeyframeCache(key, nearest)
          return nearest
        }
      } catch (err) {
        logger.warn(LogCategory.MAIN, `[视频流] 关键帧探测失败: ${String(err)}`)
      }
    }
    this.putKeyframeCache(key, null)
    return null
  }

  private putKeyframeCache(key: string, value: number | null): void {
    if (this.keyframeCache.size >= KEYFRAME_CACHE_MAX) {
      const oldest = this.keyframeCache.keys().next().value
      if (oldest !== undefined) this.keyframeCache.delete(oldest)
    }
    this.keyframeCache.set(key, value)
  }

  /** 仅从无活跃连接的空闲会话中挑最早活动的；活跃长片绝不作为驱逐候选 */
  private oldestIdleSession(): StreamSession | null {
    let oldest: StreamSession | null = null
    for (const s of this.sessions.values()) {
      if (s.activeInstance) continue
      if (!oldest || s.lastActivityAt < oldest.lastActivityAt) oldest = s
    }
    return oldest
  }

  private terminateSession(session: StreamSession): void {
    if (session.activeInstance) {
      session.activeInstance.intentionalKill = true
      this.terminateInstance(session.activeInstance)
      session.activeInstance = undefined
    }
  }

  private terminateInstance(instance: ActiveStreamInstance): void {
    const { process: proc, res } = instance
    this.clearStartupTimer(instance)
    try {
      proc.stdout?.unpipe(res)
      proc.stdout?.destroy()
      proc.stderr?.destroy()
    } catch {}
    try {
      if (!res.writableEnded && !res.destroyed) res.end()
    } catch {}
    try {
      if (!proc.killed) proc.kill('SIGKILL')
    } catch {}
  }

  private ensureSweepTimer(): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => this.sweepSessions(), SWEEP_INTERVAL_MS)
    this.sweepTimer.unref()
  }

  private sweepSessions(): void {
    const now = Date.now()
    for (const [id, session] of this.sessions.entries()) {
      // 正在活跃播放的长片不受 2h 上限影响
      if (session.activeInstance) continue
      const idleTooLong = now - session.lastActivityAt > IDLE_TTL_MS
      const totalTooLong = now - session.createdAt > MAX_SESSION_TTL_MS
      if (idleTooLong || totalTooLong) {
        this.terminateSession(session)
        this.sessions.delete(id)
        logger.info(LogCategory.MAIN, `[视频流] TTL 清扫会话: ${id}`)
      }
    }
    if (this.sessions.size === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }
}

export const localVideoStreamService = LocalVideoStreamService.getInstance()
