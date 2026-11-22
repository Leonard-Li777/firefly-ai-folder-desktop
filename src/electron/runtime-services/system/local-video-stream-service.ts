import { createHash, randomBytes, timingSafeEqual } from 'crypto'
import { execFile, spawn, type ChildProcess } from 'child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import fs from 'fs'
import path from 'path'
import { app } from 'electron'

import { FileCategory, getFileCategory, logger, LogCategory } from '@firefly/shared'

import { ffmpegService } from './ffmpeg-service'
import {
  buildVideoFilter,
  extractRawStartPtsByStreamIndex,
  formatSecToFixed6,
  hasStartTimeOriginMismatch,
  isRemuxable,
  maskPathsInStderr,
  normalizeRotation,
  parsePositiveRatio,
  parseSideDataRotation,
  selectKeyframeFromCsv,
  type RationalTime,
  type StreamMode,
  type VideoProbeMeta
} from './video-stream-media-utils'
import {
  attachProcessLifecycleListeners,
  terminateInstanceAndWait,
  type ManagedStreamInstance,
  type TerminateTimeouts
} from './video-stream-process-reaper'

export type { RationalTime, StreamMode, VideoProbeMeta }
export type ShutdownResult = 'CLEAN' | 'CLEANUP_FAILED'

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
  /** 直接传给 FFmpeg -ss 的 6 位小数定点数字符串（绝不二次扣除起点） */
  inputSeekSecStr: string
  mode: StreamMode
}

type SeekPlanDraft = Omit<PendingSeekPlan, 'sid'>

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
  closed: boolean
  /** 支持同 sid 受控双实例只读并发（单会话上限 2），按 requestId 索引 */
  activeInstances: Map<string, ManagedStreamInstance>
  /** 同 sid 满载（2 实例）时的单槽位等待唤醒回调 */
  slotWaiter?: () => void
}

const STARTUP_TIMEOUT_MS = 10_000
const PROBE_TIMEOUT_MS = 3_000
const IDLE_TTL_MS = 15 * 60_000
const MAX_SESSION_TTL_MS = 2 * 60 * 60_000
const SWEEP_INTERVAL_MS = 60_000
const MAX_ACTIVE_SESSIONS = 2
const MAX_INSTANCES_PER_SESSION = 2
const MAX_GLOBAL_STREAM_PROCESSES = 4
const COALESCING_WAIT_MS = 200
const SLOT_WAIT_TIMEOUT_MS = 3_000
const PROBE_CACHE_MAX = 200
const KEYFRAME_CACHE_MAX = 500
const STDERR_TAIL_MAX = 4096
const RESERVED_PORT_MIN = 38100
const RESERVED_PORT_MAX = 38859

function verifyToken(expected: string, provided: unknown): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false
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

function isVideoPathAllowed(filePath: string): boolean {
  if (getFileCategory(filePath) === FileCategory.VIDEO) return true
  // .ts 在部分共享配置中可能被归类为 TypeScript，门禁层对 .ts 扩展名放行交由 ffprobe 核验
  return /\.ts$/i.test(filePath)
}

/**
 * 本地 HTTP 智能双路视频流式播放服务（主进程单例，Frozen v1.7 Approved）。
 * 仅在 FilePreview 原生 <video> 解码失败后按需启用：快车道 remux（-c:v copy）+ 兼容车道轻量转码，
 * 经 127.0.0.1 随机端口 fMP4 流式直出，零落盘、零 Schema 改动。
 */
export class LocalVideoStreamService {
  private static instance: LocalVideoStreamService | null = null
  /** 仅供单测缩短首字节看门狗；生产恒为 10s */
  private static startupTimeoutMs = STARTUP_TIMEOUT_MS
  /** 仅供单测缩短合并/排队/终止超时；生产使用默认契约值 */
  private static testTimingOverrides: {
    coalescingMs?: number
    slotWaitMs?: number
    terminate?: TerminateTimeouts
  } = {}

  private server: Server | null = null
  private serverStarting: Promise<void> | null = null
  private serverPort = 0
  private sessions = new Map<string, StreamSession>()
  private probeCache = new Map<string, VideoProbeMeta>()
  private keyframeCache = new Map<
    string,
    { inputSeekSecStr: string; actualStartSec: number } | null
  >()
  private sweepTimer: NodeJS.Timeout | null = null
  private quitHookInstalled = false
  private isShuttingDown = false
  private shutdownComplete = false
  /** 全局并发 FFmpeg 推流进程原子计数（上限 MAX_GLOBAL_STREAM_PROCESSES = 4） */
  private reservedGlobalSlots = 0

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
    LocalVideoStreamService.testTimingOverrides = {}
  }

  static setStartupTimeoutForTest(ms: number): void {
    LocalVideoStreamService.startupTimeoutMs =
      Number.isFinite(ms) && ms > 0 ? ms : STARTUP_TIMEOUT_MS
  }

  static setTestTimings(overrides: {
    coalescingMs?: number
    slotWaitMs?: number
    terminate?: TerminateTimeouts
  }): void {
    LocalVideoStreamService.testTimingOverrides = overrides
  }

  /** 供单测/诊断观测当前全局预留槽位数 */
  getReservedGlobalSlots(): number {
    return this.reservedGlobalSlots
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
    if (!isVideoPathAllowed(filePath)) {
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

    if (this.sessions.size >= MAX_ACTIVE_SESSIONS) {
      const idle = this.oldestIdleSession()
      if (!idle) {
        logger.warn(LogCategory.MAIN, '[视频流] 会话已满且无空闲会话可驱逐')
        return { success: false, error: 'STREAM_CAPACITY_EXCEEDED' }
      }
      idle.closed = true
      this.sessions.delete(idle.streamId)
      logger.warn(
        LogCategory.MAIN,
        `[视频流] 活跃流达上限 ${MAX_ACTIVE_SESSIONS}，淘汰空闲会话 ${idle.streamId}`
      )
    }

    await this.ensureServer()

    const streamId = randomBytes(12).toString('hex')
    const token = randomBytes(16).toString('hex')
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
        inputSeekSecStr: plan.inputSeekSecStr,
        mode: plan.mode
      },
      seekSeq: 1,
      streamUrl: '',
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      generation: 0,
      closed: false,
      activeInstances: new Map()
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
   * 细分为三错误码：SESSION_CLOSED / SESSION_REPLACED / SEEK_REQUEST_SUPERSEDED。
   */
  async seek(streamId: string, targetSec: number): Promise<SeekStreamResult> {
    const session = this.sessions.get(streamId)
    if (!session) return { success: false, error: 'SESSION_CLOSED' }
    if (session.closed) return { success: false, error: 'SESSION_CLOSED' }
    if (typeof targetSec !== 'number' || !Number.isFinite(targetSec) || targetSec < 0) {
      return { success: false, error: 'INVALID_SEEK_PARAM' }
    }

    const requestSeq = ++session.seekSeq
    const clamped = clampTargetSec(targetSec, session.probeMeta.durationSec)
    const plan = await this.buildSeekPlan(
      session.filePath,
      session.fileKey,
      session.probeMeta,
      clamped
    )

    // 三条件对象身份守卫（R11-04：精准区分会话失效与请求过期）
    if (session.closed) {
      return { success: false, error: 'SESSION_CLOSED' }
    }
    if (this.sessions.get(streamId) !== session) {
      return { success: false, error: 'SESSION_REPLACED' }
    }
    if (session.seekSeq !== requestSeq) {
      return { success: false, error: 'SEEK_REQUEST_SUPERSEDED' }
    }

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
    if (!session) return { success: true } // 幂等
    session.closed = true
    this.sessions.delete(streamId)
    this.wakeSlotWaiter(session)
    void this.terminateSessionInstances(session)
    return { success: true }
  }

  /**
   * 文件占用释放确权契约：文件管理器执行重命名/移动/删除前必须 await 本方法；
   * 仅当所有匹配会话的受管 FFmpeg 直接子进程全部确认退出且 stdio 关闭后才返回 true。
   */
  async releaseByFilePath(filePath: string): Promise<boolean> {
    if (typeof filePath !== 'string' || filePath.length === 0) return true
    const matched: StreamSession[] = []
    for (const session of this.sessions.values()) {
      if (session.filePath === filePath) matched.push(session)
    }
    if (matched.length === 0) return true

    const results = await Promise.all(
      matched.map(async session => {
        session.closed = true
        this.sessions.delete(session.streamId)
        this.wakeSlotWaiter(session)
        return await this.terminateSessionInstances(session)
      })
    )
    return results.every(Boolean)
  }

  /**
   * 应用退出清理契约（公开终态仅 'CLEAN' | 'CLEANUP_FAILED'）：
   * 异步等待所有受管直接子进程确权关闭 + HTTP Server 关闭。
   */
  async shutdown(): Promise<ShutdownResult> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    const allSessions = Array.from(this.sessions.values())
    this.sessions.clear()

    const sessionResults = await Promise.all(
      allSessions.map(async session => {
        session.closed = true
        this.wakeSlotWaiter(session)
        return await this.terminateSessionInstances(session)
      })
    )

    let serverClosed = true
    if (this.server) {
      const srv = this.server
      this.server = null
      this.serverPort = 0
      serverClosed = await new Promise<boolean>(resolve => {
        const timer = setTimeout(() => resolve(false), 1500)
        try {
          srv.close(err => {
            clearTimeout(timer)
            resolve(!err)
          })
        } catch {
          clearTimeout(timer)
          resolve(false)
        }
      })
    }

    return sessionResults.every(Boolean) && serverClosed ? 'CLEAN' : 'CLEANUP_FAILED'
  }

  /** 挂载两段式防重入 app.before-quit（幂等；仅当外部未统一接管时兜底） */
  installQuitHook(): void {
    if (this.quitHookInstalled) return
    this.quitHookInstalled = true
    app.on('before-quit', (e: Electron.Event) => {
      if (this.shutdownComplete) return
      e.preventDefault()
      if (this.isShuttingDown) return
      this.isShuttingDown = true

      void (async () => {
        try {
          const result = await this.shutdown()
          if (result === 'CLEAN') {
            this.shutdownComplete = true
            app.quit()
          } else {
            // app.exit(1) 是宿主防死锁的异常失败终止路径，严禁伪装为 CLEAN
            logger.error(
              LogCategory.MAIN,
              '[视频流] 退出清理未确权 (CLEANUP_FAILED)，以异常退出码 1 终止宿主'
            )
            app.exit(1)
          }
        } catch (err) {
          logger.error(LogCategory.MAIN, '[视频流] 退出清理致命异常:', err)
          app.exit(1)
        }
      })()
    })
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

  private findByFilePath(filePath: string, idleOnly = false): StreamSession | null {
    for (const session of this.sessions.values()) {
      if (
        session.filePath === filePath &&
        (!idleOnly || (session.activeInstances.size === 0 && !session.slotWaiter))
      ) {
        return session
      }
    }
    return null
  }

  private applySeek(session: StreamSession, plan: SeekPlanDraft): void {
    const nextSid = session.pendingSeekPlan.sid + 1
    session.pendingSeekPlan = {
      sid: nextSid,
      targetSec: plan.targetSec,
      actualStartSec: plan.actualStartSec,
      inputSeekSecStr: plan.inputSeekSecStr,
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

  /** 只在 remux 快车道探测关键帧；探测异常/探空/负偏移/pts!==dts 统一降级 transcode */
  private async buildSeekPlan(
    filePath: string,
    fileKey: string,
    meta: VideoProbeMeta,
    targetSec: number
  ): Promise<SeekPlanDraft> {
    let mode: StreamMode = isRemuxable(meta) ? 'remux' : 'transcode'
    if (mode === 'remux' && meta.videoStreamIndex !== null && meta.timeBase && meta.startPts !== null) {
      const kf = await this.findNearestKeyframeBefore(
        filePath,
        fileKey,
        meta.videoStreamIndex,
        meta.startPts,
        meta.timeBase,
        meta.startTimeSec,
        targetSec
      )
      if (!kf) {
        logger.warn(LogCategory.MAIN, '[视频流] 关键帧探测失败/探空/不满足锚点约束，降级 transcode')
        mode = 'transcode'
      } else {
        return {
          targetSec,
          actualStartSec: kf.actualStartSec,
          inputSeekSecStr: kf.inputSeekSecStr,
          mode
        }
      }
    }
    return {
      targetSec,
      actualStartSec: targetSec,
      inputSeekSecStr: formatSecToFixed6(targetSec),
      mode
    }
  }

  private async ensureServer(): Promise<void> {
    if (this.server) return
    if (this.serverStarting) return this.serverStarting

    this.serverStarting = (async () => {
      const maxAttempts = 5
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const srv = createServer((req, res) => {
          void this.handleHttp(req, res)
        })
        srv.on('error', err =>
          logger.warn(LogCategory.MAIN, `[视频流] HTTP 服务错误: ${String(err)}`)
        )
        srv.on('clientError', (_err, socket) => {
          if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
        })

        const port = await new Promise<number>((resolve, reject) => {
          const onError = (err: Error) => reject(err)
          srv.once('error', onError)
          srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address()
            srv.removeListener('error', onError)
            resolve(addr && typeof addr === 'object' ? addr.port : 0)
          })
        })

        // 规避 38100~38859 开发保留端口段
        if (port >= RESERVED_PORT_MIN && port <= RESERVED_PORT_MAX && attempt < maxAttempts - 1) {
          await new Promise<void>(r => srv.close(() => r()))
          continue
        }

        this.server = srv
        this.serverPort = port
        logger.info(LogCategory.MAIN, `[视频流] 回环 HTTP 服务已启动: 127.0.0.1:${this.serverPort}`)
        return
      }
    })().finally(() => {
      this.serverStarting = null
    })

    return this.serverStarting
  }

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // 显式忽略 Range：实时 fMP4 流无总字节长，恒返 200 流式响应，严禁返 416
    void req.headers.range

    const url = new URL(req.url || '', `http://127.0.0.1:${this.serverPort}`)
    const match = /^\/stream\/([a-f0-9]+)$/.exec(url.pathname)
    if (!match) {
      res.writeHead(404).end('Not Found')
      return
    }
    const session = this.sessions.get(match[1])
    if (!session || session.closed) {
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

    // 入口同步拦截过期/迟到 sid（R12-03：绝不在 spawn 后才检查）
    const requestedSid = Number(url.searchParams.get('sid') ?? '')
    if (!Number.isFinite(requestedSid) || requestedSid !== session.pendingSeekPlan.sid) {
      this.writeJsonError(res, 409, 'STALE_STREAM_URL')
      return
    }

    const plan = session.pendingSeekPlan

    // HEAD 请求：直接读取预计算 pendingSeekPlan 返回与 GET 一致的 200 头，不 spawn
    if (req.method === 'HEAD') {
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        Connection: 'close',
        'X-Stream-Actual-Start-Sec': plan.actualStartSec.toFixed(3)
      })
      res.end()
      return
    }

    if (req.method !== 'GET') {
      res.writeHead(405).end('Method Not Allowed')
      return
    }

    session.lastActivityAt = Date.now()

    // 跨 sid 换流清扫：仅限定同一 session.streamId 且 inst.sid < requestedSid（R12-03）
    const staleOldInstances: ManagedStreamInstance[] = []
    for (const inst of session.activeInstances.values()) {
      if (inst.streamId === session.streamId && inst.sid < requestedSid) {
        inst.intentionalKill = true
        staleOldInstances.push(inst)
      }
    }
    const staleCleanupPromises = staleOldInstances.map(old => {
      session.activeInstances.delete(old.requestId)
      return terminateInstanceAndWait(old, LocalVideoStreamService.testTimingOverrides.terminate)
    })

    // 清理同 sid 下已断开的残留实例
    for (const [reqId, inst] of Array.from(session.activeInstances.entries())) {
      if (inst.res.destroyed || inst.res.writableEnded || inst.closed) {
        session.activeInstances.delete(reqId)
        void terminateInstanceAndWait(inst, LocalVideoStreamService.testTimingOverrides.terminate)
      }
    }

    // 情形 B：同 sid 已有 1 个健康在途实例，执行 200ms 启发式断连合并等待
    if (session.activeInstances.size === 1) {
      const existing = session.activeInstances.values().next().value as ManagedStreamInstance
      const coalescingMs =
        LocalVideoStreamService.testTimingOverrides.coalescingMs ?? COALESCING_WAIT_MS
      if (coalescingMs > 0 && !existing.res.destroyed && !existing.res.writableEnded) {
        await this.waitForResponseClose(existing.res, res, coalescingMs)
        if (res.destroyed || res.writableEnded || session.closed) return
        if (existing.res.destroyed || existing.res.writableEnded || existing.closed) {
          session.activeInstances.delete(existing.requestId)
          await terminateInstanceAndWait(
            existing,
            LocalVideoStreamService.testTimingOverrides.terminate
          )
        }
      }
    }

    // 情形 C：同 sid 已有 2 个健康在途实例满载 -> 绝不驱逐健康流，第 3 请求单槽位排队等待至多 3000ms
    if (session.activeInstances.size >= MAX_INSTANCES_PER_SESSION) {
      if (session.slotWaiter) {
        this.writeJsonError(res, 503, 'STREAM_INSTANCE_CAPACITY_LIMIT')
        return
      }
      const slotWaitMs =
        LocalVideoStreamService.testTimingOverrides.slotWaitMs ?? SLOT_WAIT_TIMEOUT_MS
      const acquired = await this.waitForSessionSlot(session, res, slotWaitMs)
      if (!acquired) {
        if (!res.destroyed && !res.writableEnded) {
          this.writeJsonError(res, 503, 'STREAM_INSTANCE_CAPACITY_LIMIT')
        }
        return
      }
    }

    // 二次同步校验（await 期间会话可能关闭或推进了新 sid）
    if (session.closed || this.sessions.get(session.streamId) !== session) {
      this.writeJsonError(res, 404, 'SESSION_CLOSED')
      return
    }
    if (requestedSid !== session.pendingSeekPlan.sid) {
      this.writeJsonError(res, 409, 'STALE_STREAM_URL')
      return
    }
    if (res.destroyed || res.writableEnded) return

    // 全局并发槽位原子预留：若因旧实例正在异步回收导致暂满，先 await 旧实例释放槽位
    if (
      this.reservedGlobalSlots >= MAX_GLOBAL_STREAM_PROCESSES &&
      staleCleanupPromises.length > 0
    ) {
      await Promise.all(staleCleanupPromises)
      if (session.closed || res.destroyed || res.writableEnded) return
      if (requestedSid !== session.pendingSeekPlan.sid) {
        this.writeJsonError(res, 409, 'STALE_STREAM_URL')
        return
      }
    }

    // 同步无 await 原子预留槽位，防并发 Seek 突破全局 4 进程上限
    if (this.reservedGlobalSlots >= MAX_GLOBAL_STREAM_PROCESSES) {
      this.writeJsonError(res, 503, 'GLOBAL_STREAM_CAPACITY_LIMIT')
      return
    }
    this.reservedGlobalSlots += 1
    let slotReleased = false
    const releaseSlotOnce = () => {
      if (slotReleased) return
      slotReleased = true
      this.reservedGlobalSlots = Math.max(0, this.reservedGlobalSlots - 1)
    }

    const ffmpegPath = ffmpegService.getFfmpegPath()
    if (!ffmpegPath) {
      releaseSlotOnce()
      this.writeJsonError(res, 502, 'FFMPEG_NOT_READY')
      return
    }

    const myGen = ++session.generation
    const requestId = createHash('sha256')
      .update(`${session.streamId}|${requestedSid}|${myGen}|${Date.now()}|${Math.random()}`)
      .digest('hex')
      .slice(0, 16)

    const args = this.buildStreamArgs(session, plan)
    let proc: ChildProcess
    try {
      proc = spawn(ffmpegPath, args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (err) {
      releaseSlotOnce()
      logger.warn(LogCategory.MAIN, `[视频流] spawn 失败: ${String(err)}`)
      this.writeJsonError(res, 502, 'SPAWN_FAILED')
      return
    }

    const instance: ManagedStreamInstance = {
      requestId,
      streamId: session.streamId,
      sid: requestedSid,
      generation: myGen,
      process: proc,
      res,
      intentionalKill: false,
      spawnFailed: false,
      exited: false,
      closed: false,
      slotReleased: false,
      releaseSlot: () => {
        instance.slotReleased = true
        releaseSlotOnce()
      }
    }
    attachProcessLifecycleListeners(instance)
    session.activeInstances.set(requestId, instance)

    let stderrTail = ''
    proc.stderr?.on('data', chunk => {
      stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_MAX)
    })

    let gotFirstByte = false
    instance.startupTimer = setTimeout(() => {
      if (!gotFirstByte && !instance.intentionalKill && session.activeInstances.has(requestId)) {
        logger.warn(LogCategory.MAIN, `[视频流] 首字节超时，终止实例 ${requestId}`)
        instance.intentionalKill = true
        if (!res.headersSent && !res.writableEnded && !res.destroyed) {
          this.writeJsonError(res, 502, 'STREAM_START_TIMEOUT')
        }
        session.activeInstances.delete(requestId)
        void terminateInstanceAndWait(
          instance,
          LocalVideoStreamService.testTimingOverrides.terminate
        ).finally(() => this.wakeSlotWaiter(session))
      }
    }, LocalVideoStreamService.startupTimeoutMs)

    proc.stdout?.on('data', chunk => {
      if (!gotFirstByte) {
        gotFirstByte = true
        this.clearStartupTimer(instance)
      }
      if (instance.intentionalKill || !session.activeInstances.has(requestId)) return
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
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        this.writeJsonError(res, 502, 'SPAWN_ERROR')
      }
      session.activeInstances.delete(requestId)
      instance.releaseSlot()
      this.wakeSlotWaiter(session)
    })
    proc.on('close', code => {
      this.clearStartupTimer(instance)
      session.activeInstances.delete(requestId)
      instance.releaseSlot()
      this.wakeSlotWaiter(session)

      if (instance.intentionalKill) return
      if (!res.headersSent && !res.writableEnded && !res.destroyed) {
        this.writeJsonError(res, 502, 'STREAM_EXIT_EARLY')
        return
      }
      if (code !== 0) {
        const masked = maskPathsInStderr(stderrTail.slice(-200), session.filePath)
        logger.warn(LogCategory.MAIN, `[视频流] ffmpeg 异常退出 code=${code}: ${masked}`)
        if (!res.writableEnded && !res.destroyed) res.destroy()
      } else if (!res.writableEnded && !res.destroyed) {
        res.end()
      }
    })

    res.on('close', () => {
      this.clearStartupTimer(instance)
      if (session.activeInstances.has(requestId)) {
        session.activeInstances.delete(requestId)
        void terminateInstanceAndWait(
          instance,
          LocalVideoStreamService.testTimingOverrides.terminate
        ).finally(() => this.wakeSlotWaiter(session))
      }
    })
  }

  private waitForResponseClose(
    targetRes: ServerResponse,
    incomingRes: ServerResponse,
    timeoutMs: number
  ): Promise<void> {
    return new Promise(resolve => {
      if (
        targetRes.destroyed ||
        targetRes.writableEnded ||
        incomingRes.destroyed ||
        incomingRes.writableEnded
      ) {
        resolve()
        return
      }
      const done = () => {
        clearTimeout(timer)
        targetRes.removeListener('close', done)
        incomingRes.removeListener('close', done)
        resolve()
      }
      const timer = setTimeout(done, timeoutMs)
      targetRes.once('close', done)
      incomingRes.once('close', done)
    })
  }

  private waitForSessionSlot(
    session: StreamSession,
    incomingRes: ServerResponse,
    timeoutMs: number
  ): Promise<boolean> {
    return new Promise(resolve => {
      if (session.activeInstances.size < MAX_INSTANCES_PER_SESSION) {
        resolve(true)
        return
      }
      let settled = false
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (session.slotWaiter === onWake) session.slotWaiter = undefined
        incomingRes.removeListener('close', onClientAbort)
        resolve(ok)
      }
      const onWake = () => {
        finish(
          !session.closed &&
            !incomingRes.destroyed &&
            !incomingRes.writableEnded &&
            session.activeInstances.size < MAX_INSTANCES_PER_SESSION
        )
      }
      const onClientAbort = () => finish(false)
      const timer = setTimeout(() => finish(false), timeoutMs)
      session.slotWaiter = onWake
      incomingRes.once('close', onClientAbort)
    })
  }

  private wakeSlotWaiter(session: StreamSession): void {
    const waiter = session.slotWaiter
    if (waiter) {
      session.slotWaiter = undefined
      waiter()
    }
  }

  private async terminateSessionInstances(session: StreamSession): Promise<boolean> {
    const instances = Array.from(session.activeInstances.values())
    session.activeInstances.clear()
    if (instances.length === 0) return true
    const results = await Promise.all(
      instances.map(inst =>
        terminateInstanceAndWait(inst, LocalVideoStreamService.testTimingOverrides.terminate)
      )
    )
    return results.every(Boolean)
  }

  private writeJsonError(res: ServerResponse, status: number, error: string): void {
    if (res.headersSent || res.writableEnded || res.destroyed) return
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ success: false, error }))
  }

  private clearStartupTimer(instance: ManagedStreamInstance): void {
    if (instance.startupTimer) {
      clearTimeout(instance.startupTimer)
      instance.startupTimer = undefined
    }
  }

  private buildStreamArgs(session: StreamSession, plan: PendingSeekPlan): string[] {
    const meta = session.probeMeta
    const videoMap = meta.videoStreamIndex !== null ? `0:${meta.videoStreamIndex}` : '0:V:0'
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
    const maps = ['-map', videoMap, ...(meta.hasAudio ? ['-map', '0:a:0?'] : []), '-sn', '-dn']
    // 移除 first_pts=0，保留 -af aresample=async=1 以保全源流 A/V 相对偏移
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
          'aresample=async=1'
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
        plan.inputSeekSecStr,
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
      plan.inputSeekSecStr,
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
      buildVideoFilter(meta),
      '-metadata:s:v:0',
      'rotate=0',
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
      'stream=index,codec_type,codec_name,width,height,pix_fmt,bits_per_raw_sample,profile,time_base,start_pts,start_time,sample_aspect_ratio,display_aspect_ratio:stream_disposition=attached_pic:stream_tags=rotate:stream_side_data=rotation:format=duration,start_time',
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
    const videoIndex = video && Number.isFinite(video.index) ? Number(video.index) : null

    const timeBase = video ? parsePositiveRatio(video.time_base) : null
    // 优先从原始 JSON 文本提取 start_pts 防大整数精度丢失；缺失则置 null（严禁从 start_time=0 乐观推导 0n）
    const startPts =
      videoIndex !== null ? extractRawStartPtsByStreamIndex(json, videoIndex) : null
    const rawStartTime = Number(video?.start_time ?? data?.format?.start_time ?? 0)
    const startTimeSec = Number.isFinite(rawStartTime) ? rawStartTime : 0
    const startTimeOriginMismatch = hasStartTimeOriginMismatch(
      data?.format?.start_time,
      video?.start_time
    )

    return {
      startPts,
      timeBase,
      startTimeSec,
      startTimeOriginMismatch,
      durationSec: Number.isFinite(durationNum) && durationNum > 0 ? durationNum : null,
      videoCodec: video?.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
      hasAudio: Boolean(audio),
      width: Number.isFinite(video?.width) ? Number(video.width) : null,
      height: Number.isFinite(video?.height) ? Number(video.height) : null,
      pixFmt: video?.pix_fmt ?? null,
      bitsPerRawSample: Number.isFinite(bits) && bits > 0 ? bits : null,
      videoProfile: video?.profile ?? null,
      sampleAspectRatio:
        typeof video?.sample_aspect_ratio === 'string' ? video.sample_aspect_ratio : null,
      displayAspectRatio:
        typeof video?.display_aspect_ratio === 'string' ? video.display_aspect_ratio : null,
      rotationDeg: video ? parseSideDataRotation(video) : null,
      videoStreamIndex: videoIndex
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
      startPts: null,
      timeBase: null,
      startTimeSec: 0,
      startTimeOriginMismatch: false,
      durationSec,
      videoCodec: codec,
      audioCodec: audio,
      hasAudio: Boolean(audio),
      width: null,
      height: null,
      pixFmt,
      bitsPerRawSample: pixFmt && /10|12/.test(pixFmt) ? 10 : pixFmt ? 8 : null,
      videoProfile: null,
      sampleAspectRatio: null,
      displayAspectRatio: null,
      rotationDeg: rotationMatch ? normalizeRotation(rotationMatch[1]) : 0,
      videoStreamIndex: codec ? 0 : null
    }
    this.putProbeCache(fileKey, meta)
    return meta
  }

  private emptyMeta(): VideoProbeMeta {
    return {
      startPts: null,
      timeBase: null,
      startTimeSec: 0,
      startTimeOriginMismatch: false,
      durationSec: null,
      videoCodec: null,
      audioCodec: null,
      hasAudio: false,
      width: null,
      height: null,
      pixFmt: null,
      bitsPerRawSample: null,
      videoProfile: null,
      sampleAspectRatio: null,
      displayAspectRatio: null,
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

  /** 纯封装层关键帧探测：CSV 3 列 [pts,dts,flags] 直转 BigInt，探空/异常/负偏移返回 null */
  private async findNearestKeyframeBefore(
    filePath: string,
    fileKey: string,
    videoStreamIndex: number,
    streamStartPts: bigint,
    timeBase: RationalTime,
    startTimeSec: number,
    targetSec: number
  ): Promise<{ inputSeekSecStr: string; actualStartSec: number } | null> {
    const key = `${fileKey}|${videoStreamIndex}|${streamStartPts.toString()}|${timeBase.num}/${timeBase.den}|kf@${Math.floor(targetSec)}`
    const cached = this.keyframeCache.get(key)
    if (cached !== undefined && (cached === null || cached.actualStartSec <= targetSec)) {
      return cached
    }
    const ffprobePath = ffmpegService.getFfprobePath()
    if (!ffprobePath) return null

    const targetMicros = BigInt(Math.round(targetSec * 1_000_000))
    for (const window of [15, 60]) {
      const readStart = Math.max(0, startTimeSec + Math.max(0, targetSec - window))
      const readEnd = Math.max(readStart + 0.001, startTimeSec + targetSec + 0.001)
      const args = [
        '-v',
        'error',
        '-protocol_whitelist',
        'file',
        '-select_streams',
        String(videoStreamIndex),
        '-show_entries',
        'packet=pts,dts,flags',
        '-of',
        'csv=p=0',
        '-read_intervals',
        `${readStart.toFixed(6)}%${readEnd.toFixed(6)}`,
        filePath
      ]
      try {
        const stdout = await this.execFileText(ffprobePath, args)
        const selected = selectKeyframeFromCsv(stdout, streamStartPts, timeBase, targetMicros)
        if (selected) {
          const entry = {
            inputSeekSecStr: selected.inputSeekSecStr,
            actualStartSec: selected.actualStartSec
          }
          this.putKeyframeCache(key, entry)
          return entry
        }
      } catch (err) {
        logger.warn(LogCategory.MAIN, `[视频流] 关键帧探测失败: ${String(err)}`)
        // 非零退出或超时：整次探测失败，绝不采信残缺输出
        return null
      }
    }
    this.putKeyframeCache(key, null)
    return null
  }

  private putKeyframeCache(
    key: string,
    value: { inputSeekSecStr: string; actualStartSec: number } | null
  ): void {
    if (this.keyframeCache.size >= KEYFRAME_CACHE_MAX) {
      const oldest = this.keyframeCache.keys().next().value
      if (oldest !== undefined) this.keyframeCache.delete(oldest)
    }
    this.keyframeCache.set(key, value)
  }

  private oldestIdleSession(): StreamSession | null {
    let oldest: StreamSession | null = null
    for (const s of this.sessions.values()) {
      if (s.activeInstances.size > 0 || s.slotWaiter) continue
      if (!oldest || s.lastActivityAt < oldest.lastActivityAt) oldest = s
    }
    return oldest
  }

  private ensureSweepTimer(): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => this.sweepSessions(), SWEEP_INTERVAL_MS)
    this.sweepTimer.unref()
  }

  private sweepSessions(): void {
    const now = Date.now()
    for (const [id, session] of this.sessions.entries()) {
      if (session.activeInstances.size > 0 || session.slotWaiter) continue
      const idleTooLong = now - session.lastActivityAt > IDLE_TTL_MS
      const totalTooLong = now - session.createdAt > MAX_SESSION_TTL_MS
      if (idleTooLong || totalTooLong) {
        session.closed = true
        this.sessions.delete(id)
        logger.info(LogCategory.MAIN, `[视频流] TTL 清扫空闲会话: ${id}`)
      }
    }
    if (this.sessions.size === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }
}

export const localVideoStreamService = LocalVideoStreamService.getInstance()
