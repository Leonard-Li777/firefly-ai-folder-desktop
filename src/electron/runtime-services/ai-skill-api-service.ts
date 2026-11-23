import { t } from '@app/languages'
import * as http from 'node:http'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as crypto from 'node:crypto'
import * as path from 'path'
import { BrowserWindow } from 'electron'
import {
  logger,
  LogCategory,
  APP_PORTS,
  ServiceDiscoveryFile,
  isPidAlive,
  VIDEO_EXTENSIONS,
  isDecodableImage,
  CATEGORY_EXT_MAP,
  FileCategory
} from '@firefly/shared'
import * as iconv from 'iconv-lite'
import {
  type ExternalApiActivityInfo,
  type ExternalApiTestResultDTO,
  type ExternalApiCapabilityId,
  type ExternalApiCapabilityDescriptor,
  EXTERNAL_API_CAPABILITIES
} from '@firefly/types'
import { databaseService } from './database/database-service'
import { analysisQueueService } from './analysis-queue-service'
import { organizeRealDirectoryService, virtualDirectoryService } from '../main/state'
import { VoiceSeamDispatcher, VoiceSeamError } from './ai/voice-seam-dispatcher'
import { ConfigOrchestrator } from '../config/config-orchestrator'
import { modularResourceService } from './system/modular-resource-service'
import { omniService } from './system/omni-service'
import {
  SKILL_API_CONSTRAINTS,
  countCodePoints,
  requireObjectBody,
  parseStrictInt,
  parseQueryFloat,
  validateOcrFilePath,
  validateTranscribeFilePath,
  validateAbsoluteLocalPath,
  validateSynthesizePreFlight,
  validateApplyPlanBody,
  hasKnownImageMagic,
  hasKnownNonAudioMagic,
  assertSearchDtosMinScore
} from './ai-skill-api-validators'
import {
  statRegularFile,
  readBoundedUtf8File,
  VOICE_SEAM_HTTP_ERROR_MAP
} from './ai-skill-api-fs'

export interface VideoSegmentItem {
  chunkIndices: number[]
  startSec: number
  endSec: number
  repPtsSec: number
  seekSec: number
  score: number
  textSnippet?: string
}

export interface SearchResultItemDTO {
  id: string
  name: string
  path: string
  score: number
  matchType: 'exact' | 'fuzzy' | 'semantic' | 'unanalyzed' | 'video_chunk'
  mediaType: 'video' | 'image' | 'document' | 'other'
  hasVideoSegments: boolean
  snippet?: string
  videoSegments: VideoSegmentItem[]
  videoSegmentsTotal: number
  videoSegmentsTruncated: boolean
}

export class SseChannel {
  private res: http.ServerResponse
  private ended = false

  constructor(res: http.ServerResponse, onAbort?: () => void) {
    this.res = res
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    res.flushHeaders?.()

    const cleanup = () => {
      if (!this.ended) {
        this.ended = true
        onAbort?.()
      }
    }
    res.once('close', cleanup)
    res.once('error', cleanup)
  }

  isClosed(): boolean {
    return this.ended || this.res.writableEnded || this.res.destroyed
  }

  async sendEvent(event: string, data: any): Promise<boolean> {
    if (this.isClosed()) return false
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    const canWrite = this.res.write(payload)
    if (!canWrite && !this.isClosed()) {
      await new Promise<void>(resolve => {
        this.res.once('drain', resolve)
        this.res.once('close', resolve)
      })
    }
    return !this.isClosed()
  }

  close(): void {
    if (this.isClosed()) return
    this.ended = true
    try {
      this.res.end()
    } catch {
      // ignore
    }
  }
}

const SHARED_DOC_EXT_SET: ReadonlySet<string> = new Set([
  ...(CATEGORY_EXT_MAP[FileCategory.DOCUMENT] || []),
  ...(CATEGORY_EXT_MAP[FileCategory.TEXT] || [])
])

function resolveSearchMediaType(
  filePath: string,
  name: string
): 'video' | 'image' | 'document' | 'other' {
  const target = name || filePath
  const ext = path.extname(target).toLowerCase()
  if (VIDEO_EXTENSIONS.has(ext)) return 'video'
  if (isDecodableImage(target)) return 'image'
  if (SHARED_DOC_EXT_SET.has(ext)) return 'document'
  return 'other'
}

function mapItemsToDTO(items: any[]): SearchResultItemDTO[] {
  if (!Array.isArray(items)) return []
  return items.map(item => {
    const rawChunks: any[] =
      item.matchedChunks || item.videoSegments || (item.matchedChunk ? [item.matchedChunk] : [])
    const videoSegmentsTotal = rawChunks.length
    const topChunks = rawChunks.slice(0, 3)
    const videoSegmentsTruncated = videoSegmentsTotal > topChunks.length

    const videoSegments: VideoSegmentItem[] = topChunks.map(c => {
      let indices: number[] = []
      if (Array.isArray(c.chunkIndices)) {
        indices = c.chunkIndices
      } else if (c.chunkIndex !== undefined && Number.isFinite(c.chunkIndex)) {
        indices = [c.chunkIndex]
      }
      return {
        chunkIndices: indices,
        startSec: typeof c.startSec === 'number' ? c.startSec : 0,
        endSec: typeof c.endSec === 'number' ? c.endSec : 0,
        repPtsSec: typeof c.repPtsSec === 'number' ? c.repPtsSec : c.startSec || 0,
        seekSec: typeof c.seekSec === 'number' ? c.seekSec : c.startSec || 0,
        score: typeof c.score === 'number' ? c.score : c.similarity || 0.8,
        textSnippet: item.snippet ? item.snippet.slice(0, 150) : undefined
      }
    })

    const hasVideoSegments = videoSegments.length > 0
    const mediaType = resolveSearchMediaType(item.path || '', item.name || '')
    const snippet = item.snippet
      ? item.snippet.slice(0, 200)
      : item.description
        ? item.description.slice(0, 200)
        : undefined

    let score = 1.0
    if (typeof item.similarity === 'number') {
      score = item.similarity
    } else if (videoSegments.length > 0 && typeof videoSegments[0].score === 'number') {
      score = videoSegments[0].score
    }

    let matchType: 'exact' | 'fuzzy' | 'semantic' | 'unanalyzed' | 'video_chunk' = 'exact'
    if (hasVideoSegments) {
      matchType = 'video_chunk'
    } else if (
      item.matchType === 'fuzzy' ||
      item.matchType === 'semantic' ||
      item.matchType === 'unanalyzed'
    ) {
      matchType = item.matchType
    }

    return {
      id: String(item.id ?? item.path ?? ''),
      name: item.name || path.basename(item.path || ''),
      path: item.path || '',
      score: Math.round(score * 1000) / 1000,
      matchType,
      mediaType,
      hasVideoSegments,
      snippet,
      videoSegments,
      videoSegmentsTotal,
      videoSegmentsTruncated
    }
  })
}

export class AISkillApiService {
  private server: http.Server | null = null
  private configuredPort: number = APP_PORTS.AI_SKILL_API
  private actualPort = 0
  private configFilePath = ''
  private discoveryFile: ServiceDiscoveryFile | null = null
  private readonly instanceId: string = crypto.randomUUID()
  private discoveryRevision = 0
  private inFlightAbortControllers: Set<AbortController> = new Set()
  private activeSearchesCount = 0
  private activeMultimodalCount = 0
  private activeTtsCount = 0
  private readonly maxBodyBytes = 1024 * 1024 // 普通接口 1MB
  private readonly maxMultimodalBodyBytes = 20 * 1024 * 1024 // 多模态 Base64 接口 20MB
  private readonly ttsTempDir = path.join(os.tmpdir(), 'firefly-skill-tts')
  private readonly tmpInputDir = path.join(os.tmpdir(), 'firefly-skill-tmp')
  private discoveryOpChain: Promise<void> = Promise.resolve()
  private getActiveCapabilitiesProvider: () => ExternalApiCapabilityId[] = () => [
    ...EXTERNAL_API_CAPABILITIES
  ]

  // 生命周期、安全与探针状态
  private acceptingRequests = false
  private probeNonce: string = crypto.randomUUID()
  private inFlightRequests = 0
  private activeSseChannels: Set<SseChannel> = new Set()
  private currentEpoch = 0
  private startedAt: Date | null = null
  private discoveryPresent = false
  private crashListeners: Set<(err: Error) => void> = new Set()

  // 外部调用活动统计
  private totalRequests = 0
  private lastCallTimestamp: number | null = null
  private lastCaller: string | null = null
  private lastEndpoint: string | null = null
  private lastStatusCode: number | null = null

  // 时间常量注入接缝 (REV-ISS-10.1 DoD)
  private readonly drainBudgetMs: number
  private readonly stopBudgetMs: number

  constructor(
    port: number = APP_PORTS.AI_SKILL_API,
    userDataPath?: string,
    options?: { drainBudgetMs?: number; stopBudgetMs?: number }
  ) {
    this.configuredPort = port
    // 默认排空预算 800ms + 强制关闭 1000ms = 1800ms，严格受控于 before-quit 2500ms 守护时限内
    this.drainBudgetMs = options?.drainBudgetMs ?? 800
    this.stopBudgetMs = options?.stopBudgetMs ?? 1000
    let resolvedUserDataPath = userDataPath
    if (!resolvedUserDataPath) {
      try {
        const { app } = require('electron')
        if (app && typeof app.getPath === 'function') {
          resolvedUserDataPath = app.getPath('userData')
        }
      } catch {
        // 非 Electron / 单测环境
      }
    }
    if (resolvedUserDataPath) {
      this.discoveryFile = new ServiceDiscoveryFile({
        fileName: 'ai-skill-config.json',
        serviceId: 'firefly-ai-skill-api',
        userDataPath: resolvedUserDataPath,
        legacyFallbackRead: true
      })
      this.configFilePath = this.discoveryFile.getFilePath()
    }
    // 启动期安全自愈：清理损坏或孤儿发现文件 (TEST-EXT-10 / Spec §2.2)
    this.discoveryFile?.cleanupOrphanOnStartup({ preserveAliveExternalPid: false })
  }

  getActualPort(): number {
    return this.actualPort
  }

  isRunning(): boolean {
    return this.server !== null && this.acceptingRequests
  }

  getUptimeSec(): number | null {
    if (!this.startedAt) return null
    return Math.max(0, Math.floor((Date.now() - this.startedAt.getTime()) / 1000))
  }

  getActivitySnapshot(): ExternalApiActivityInfo {
    return {
      totalRequests: this.totalRequests,
      lastCallTimestamp: this.lastCallTimestamp,
      lastCaller: this.lastCaller,
      lastEndpoint: this.lastEndpoint,
      lastStatusCode: this.lastStatusCode
    }
  }

  isDiscoveryPresent(): boolean {
    return this.discoveryPresent
  }

  getConfigFilePath(): string {
    return this.configFilePath
  }

  getProbeNonce(): string {
    return this.probeNonce
  }

  onCrash(listener: (err: Error) => void): () => void {
    this.crashListeners.add(listener)
    return () => {
      this.crashListeners.delete(listener)
    }
  }

  private handleUnexpectedError(err: any): void {
    logger.error(LogCategory.SYSTEM, '[AISkillApiService] 服务器非预期错误:', err)
    for (const listener of this.crashListeners) {
      try {
        listener(err instanceof Error ? err : new Error(String(err)))
      } catch {}
    }
  }

  private handleUnexpectedClose(): void {
    logger.warn(LogCategory.SYSTEM, '[AISkillApiService] 服务器在接受请求期间非预期关闭')
    this.acceptingRequests = false
    const err = new Error('服务器非预期意外关闭')
    ;(err as any).code = 'CRASH'
    for (const listener of this.crashListeners) {
      try {
        listener(err)
      } catch {}
    }
  }

  /**
   * 启动发布事务 (Spec §2.3)
   * 1. listen(exclusive: true) 绑定端口
   * 2. 原子发布发现文件 (若失败立即回滚关服)
   * 3. 宣告 acceptingRequests = true
   */
  async start(): Promise<void> {
    if (this.server) return

    // 检查是否有粘性端口可复用 (38300 ~ 38319)，兼容旧路径 legacyFallbackRead 迁移
    let stickyPort: number | null = null
    try {
      const parsed = this.discoveryFile?.read({ verifyPid: false })
      if (
        parsed &&
        parsed.port >= APP_PORTS.AI_SKILL_API &&
        parsed.port < APP_PORTS.AI_SKILL_API + 20 &&
        !isPidAlive(parsed.pid)
      ) {
        stickyPort = parsed.port
      }
    } catch {}

    const candidatePorts: number[] = []
    if (stickyPort !== null) {
      candidatePorts.push(stickyPort)
    }
    const basePort = this.configuredPort
    for (let p = basePort; p < basePort + 20; p++) {
      if (!candidatePorts.includes(p)) {
        candidatePorts.push(p)
      }
    }

    let hasAccessError = false

    for (const port of candidatePorts) {
      try {
        const server = http.createServer(async (req, res) => {
          const handled = await this.handleRequest(req, res)
          if (!handled && !res.writableEnded) {
            this.sendError(res, 404, t('接口不存在'))
          }
        })

        await new Promise<void>((resolve, reject) => {
          const onError = (err: any) => {
            server.off('listening', onListening)
            server.close()
            reject(err)
          }

          const onListening = () => {
            server.off('error', onError)
            const addr = server.address()
            if (addr && typeof addr === 'object') {
              this.actualPort = addr.port
            } else {
              this.actualPort = port
            }
            this.server = server
            resolve()
          }

          server.once('error', onError)
          server.once('listening', onListening)
          // 环回独占监听
          server.listen({ port, host: '127.0.0.1', exclusive: true })
        })

        // 绑定成功
        break
      } catch (err: any) {
        const code = err.code || ''
        if (code === 'EADDRNOTAVAIL') {
          // 本地环回栈异常，不作递增，快速失败归因 BIND_FAILED
          const fatalErr = new Error(`本地环回栈异常 (${code}): ${err.message}`)
          ;(fatalErr as any).code = 'BIND_FAILED'
          throw fatalErr
        }

        if (code === 'EACCES' || code === 'EPERM' || code === 'WSAEACCES') {
          hasAccessError = true
          logger.warn(
            LogCategory.SYSTEM,
            `[AI Skill API] 端口 ${port} 遇到端口特异性权限占用 (${code})，尝试下一个端口...`
          )
        } else if (code === 'EADDRINUSE') {
          logger.warn(
            LogCategory.SYSTEM,
            `[AI Skill API] 端口 ${port} 已被占用 (${code})，尝试下一个端口...`
          )
        } else {
          const fatalErr = new Error(`绑定端口发生未知错误 (${code}): ${err.message}`)
          ;(fatalErr as any).code = 'BIND_FAILED'
          throw fatalErr
        }
      }
    }

    const runningServer = this.server as http.Server | null
    if (!runningServer) {
      if (hasAccessError) {
        const err = new Error('绑定端口失败: 端口特异性权限不足且可用端口耗尽')
        ;(err as any).code = 'BIND_FAILED'
        throw err
      } else {
        const err = new Error('所有 20 个候选端口均已被占用')
        ;(err as any).code = 'PORT_EXHAUSTED'
        throw err
      }
    }

    runningServer.on('error', (err: any) => {
      this.handleUnexpectedError(err)
    })
    runningServer.on('close', () => {
      if (this.acceptingRequests) {
        this.handleUnexpectedClose()
      }
    })

    this.startedAt = new Date()

    // 事务性发布发现文件
    try {
      await this.atomicPublishDiscoveryFile()
    } catch (publishErr) {
      logger.error(
        LogCategory.SYSTEM,
        '[AI Skill API] 发布发现文件事务失败，执行回滚并关闭端口:',
        publishErr
      )
      this.acceptingRequests = false
      const serverToClose = runningServer
      this.server = null
      this.actualPort = 0
      this.startedAt = null
      this.discoveryPresent = false

      // D-05: 发布失败回滚时，确保不保留任何指向已关闭服务的死发现文件
      this.discoveryFile?.revokeSync({ pid: process.pid, instanceId: this.instanceId })

      await new Promise<void>(r => {
        try {
          serverToClose.closeAllConnections?.()
        } catch {}
        serverToClose.close(() => r())
      })
      throw publishErr
    }

    // 发布成功后才宣告就绪接客
    this.acceptingRequests = true
    logger.info(
      LogCategory.SYSTEM,
      `[AI Skill API] 服务启动成功并原子发布发现文件，监听 http://127.0.0.1:${this.actualPort}`
    )
  }

  /**
   * 两阶段排空停止协议 (Spec §2.3)
   * 阶段一：acceptingRequests=false ➔ 撤销发现文件 ➔ SSE 广播 stopping ➔ 排空在途请求 (预算 1500ms)
   * 阶段二：强制回收连接 ➔ closeAllConnections ➔ 释放端口 (总预算 2000ms)
   */
  async stop(): Promise<void> {
    // 阶段一：排空与撤销
    this.acceptingRequests = false
    await this.removeConfigFile()
    this.discoveryPresent = false

    // 向所有存量 SSE 客户端广播 stopping 事件
    for (const channel of this.activeSseChannels) {
      try {
        await channel.sendEvent('service-stopping', { reason: 'graceful-shutdown' })
      } catch {}
    }

    // 排空在途请求 (drainBudgetMs 预算)
    const drainStartTime = Date.now()
    while (this.inFlightRequests > 0 && Date.now() - drainStartTime < this.drainBudgetMs) {
      await new Promise(r => setTimeout(r, Math.min(50, this.drainBudgetMs)))
    }

    // 阶段二：强制回收连接与端口
    if (this.server) {
      const serverToClose = this.server
      this.server = null
      this.actualPort = 0
      this.startedAt = null
      this.currentEpoch++

      for (const controller of this.inFlightAbortControllers) {
        try {
          controller.abort()
        } catch {}
      }
      this.inFlightAbortControllers.clear()

      for (const channel of this.activeSseChannels) {
        try {
          channel.close()
        } catch {}
      }
      this.activeSseChannels.clear()

      await Promise.race([
        new Promise<void>(resolve => {
          try {
            serverToClose.closeAllConnections?.()
          } catch {}
          serverToClose.close(() => {
            logger.info(LogCategory.SYSTEM, '[AI Skill API] 服务已正常停止')
            resolve()
          })
        }),
        new Promise<void>(resolve => setTimeout(resolve, this.stopBudgetMs))
      ])
    }

    // 停机时清理 TTS 临时音频目录，杜绝磁盘残留
    await this.cleanupTtsTempDir('all').catch(() => {})
  }

  /**
   * 注入动态激活能力提供者（由 AISkillApiReconciler 注入，start() 与 refresh() 共用同一 SSOT）
   */
  setActiveCapabilitiesProvider(provider: () => ExternalApiCapabilityId[]): void {
    this.getActiveCapabilitiesProvider = provider
  }

  /**
   * 获取当前激活的能力列表
   */
  getActiveCapabilities(): ExternalApiCapabilityId[] {
    try {
      const caps = this.getActiveCapabilitiesProvider()
      return Array.isArray(caps) ? [...caps] : [...EXTERNAL_API_CAPABILITIES]
    } catch {
      return [...EXTERNAL_API_CAPABILITIES]
    }
  }

  /**
   * 发现文件写/删统一串行排队，杜绝同 PID 临时文件 (.tmp.<pid>) 并发踩踏
   */
  private enqueueDiscoveryOp<T>(op: () => Promise<T>): Promise<T> {
    const next = this.discoveryOpChain.then(op, op)
    this.discoveryOpChain = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  /**
   * 运行期安全刷新发现文件中的 capabilities（仅 running 态生效，严禁停机后死文件复活）
   */
  async refreshDiscoveryCapabilities(): Promise<void> {
    return this.enqueueDiscoveryOp(async () => {
      if (!this.acceptingRequests || !this.server || !this.discoveryFile) return
      const epoch = this.currentEpoch
      await this.publishDiscoveryFileUnlocked()
      // 若写盘期间并发发生了 stop() 且服务已非接收状态，立即撤销刚落盘的文件；
      // 若发生了 stop() -> start()（新一代已 running），严禁误删新一代，由后续排队写盘覆盖
      if (!this.acceptingRequests) {
        await this.revokeDiscoveryFileUnlocked()
        this.discoveryPresent = false
      } else if (epoch !== this.currentEpoch) {
        logger.debug(
          LogCategory.SYSTEM,
          '[AI Skill API] refreshDiscoveryCapabilities 检测到代际切换且新服务已运行，跳过撤销交由新一代覆盖'
        )
      }
    })
  }

  /**
   * Windows 文件锁退避原子写 (V1 Schema，复用 @firefly/shared ServiceDiscoveryFile)
   */
  private async atomicPublishDiscoveryFile(): Promise<void> {
    return this.enqueueDiscoveryOp(() => this.publishDiscoveryFileUnlocked())
  }

  private async publishDiscoveryFileUnlocked(): Promise<void> {
    if (!this.discoveryFile) return
    await this.discoveryFile.publish({
      instanceId: this.instanceId,
      revision: ++this.discoveryRevision,
      host: '127.0.0.1',
      port: this.actualPort,
      pid: process.pid,
      startedAt: (this.startedAt || new Date()).toISOString(),
      userDataDir: this.discoveryFile.getUserDataPath(),
      capabilities: this.getActiveCapabilities()
    })

    this.discoveryPresent = true
    logger.info(
      LogCategory.SYSTEM,
      `[AI Skill API] 已成功原子写出端口配置文件 (port: ${this.actualPort}): ${this.configFilePath}`
    )
  }

  private async removeConfigFile(): Promise<void> {
    return this.enqueueDiscoveryOp(() => this.revokeDiscoveryFileUnlocked())
  }

  private async revokeDiscoveryFileUnlocked(): Promise<void> {
    if (!this.discoveryFile) return
    await this.discoveryFile.revoke({ pid: process.pid, instanceId: this.instanceId })
  }

  /**
   * 清理 TTS 临时目录：prune 模式淘汰超时(>30m)或超量(>50)旧文件；all 模式清空全部临时 WAV
   */
  private async cleanupTtsTempDir(mode: 'prune' | 'all'): Promise<void> {
    try {
      await fs.mkdir(this.ttsTempDir, { recursive: true })
      const entries = await fs.readdir(this.ttsTempDir)
      if (entries.length === 0) return

      const now = Date.now()
      const maxAgeMs = 30 * 60 * 1000
      const maxFiles = 50
      const stats: Array<{ fullPath: string; mtimeMs: number }> = []

      for (const name of entries) {
        if (!name.endsWith('.wav')) continue
        const fullPath = path.join(this.ttsTempDir, name)
        if (mode === 'all') {
          await fs.unlink(fullPath).catch(() => {})
          continue
        }
        try {
          const st = await fs.stat(fullPath)
          if (now - st.mtimeMs > maxAgeMs) {
            await fs.unlink(fullPath).catch(() => {})
          } else {
            stats.push({ fullPath, mtimeMs: st.mtimeMs })
          }
        } catch {
          // 忽略已被并发清理的文件
        }
      }

      if (mode === 'prune' && stats.length >= maxFiles) {
        stats.sort((a, b) => a.mtimeMs - b.mtimeMs)
        const toRemove = stats.slice(0, stats.length - maxFiles + 1)
        for (const item of toRemove) {
          await fs.unlink(item.fullPath).catch(() => {})
        }
      }
    } catch {
      // 临时目录清理不阻断主流程
    }
  }

  /**
   * 进程退出时的同步清理兜底 (DoD 10)
   */
  syncCleanupOnExit(): void {
    this.discoveryFile?.revokeSync({ pid: process.pid, instanceId: this.instanceId })
  }

  /**
   * 真实环回 HTTP 探针探活 (带 Nonce)
   */
  async testSelfLoopback(): Promise<ExternalApiTestResultDTO> {
    if (!this.server || this.actualPort === 0) {
      return {
        success: false,
        latencyMs: null,
        error: { code: 'NOT_RUNNING', message: '服务未启动' }
      }
    }
    const startTime = Date.now()
    return new Promise<ExternalApiTestResultDTO>(resolve => {
      const req = http.get(
        {
          host: '127.0.0.1',
          port: this.actualPort,
          path: '/api/health',
          headers: {
            'X-Firefly-Probe': this.probeNonce
          },
          timeout: 2000
        },
        res => {
          const latencyMs = Math.max(0, Date.now() - startTime)
          const statusCode = res.statusCode
          res.resume()
          if (statusCode === 200) {
            resolve({
              success: true,
              latencyMs,
              statusCode
            })
          } else {
            resolve({
              success: false,
              latencyMs,
              statusCode,
              error: { code: 'INTERNAL', message: `HTTP状态码异常: ${statusCode}` }
            })
          }
        }
      )
      req.on('timeout', () => {
        req.destroy()
        resolve({
          success: false,
          latencyMs: null,
          error: { code: 'PROBE_TIMEOUT', message: '本地环回探针响应超时' }
        })
      })
      req.on('error', err => {
        resolve({
          success: false,
          latencyMs: null,
          error: { code: 'INTERNAL', message: err.message || '环回连接失败' }
        })
      })
    })
  }

  private filterInfrastructureFields(data: any): any {
    if (!data || typeof data !== 'object') return data

    const infraFields = [
      'isAnalyzed',
      'is_analyzed',
      'isHit',
      'is_hit',
      'lastHitAt',
      'syncStatus',
      'sync_status',
      'createdAt',
      'created_at',
      'modifiedAt',
      'modified_at',
      'accessedAt',
      'accessed_at',
      'analysisError',
      'analysis_error'
    ]

    const result = { ...data }
    infraFields.forEach(field => {
      delete result[field]
    })
    return result
  }

  private readBody(req: http.IncomingMessage, maxBytes: number = this.maxBodyBytes): Promise<any> {
    return new Promise((resolve, reject) => {
      const buffers: Buffer[] = []
      let totalBytes = 0
      let tooLarge = false

      req.on('data', (chunk: Buffer) => {
        if (tooLarge) return
        totalBytes += chunk.byteLength
        if (totalBytes > maxBytes) {
          tooLarge = true
          buffers.length = 0
          req.pause()
          const maxMb = Math.round(maxBytes / (1024 * 1024))
          const err: any = new Error(`Payload Too Large: request body exceeds ${maxMb}MB limit`)
          err.statusCode = 413
          reject(err)
          return
        }
        buffers.push(chunk)
      })
      req.on('end', () => {
        if (tooLarge) return
        const raw = Buffer.concat(buffers)
        if (!raw.length) {
          resolve({})
          return
        }

        const contentType = (req.headers['content-type'] || '').toLowerCase()
        let body: string
        if (contentType.includes('gbk') || contentType.includes('gb2312')) {
          try {
            body = iconv.decode(raw, 'gbk')
            resolve(JSON.parse(body))
            return
          } catch {
            // ignore
          }
        }

        try {
          body = raw.toString('utf-8')
          resolve(JSON.parse(body))
          return
        } catch {
          // ignore
        }

        try {
          body = iconv.decode(raw, 'gbk')
          resolve(JSON.parse(body))
          return
        } catch {
          // ignore
        }

        const err: any = new Error('Invalid JSON body')
        err.statusCode = 400
        reject(err)
      })
      req.on('error', reject)
    })
  }

  private recordBusinessRequest(
    req: http.IncomingMessage,
    pathname: string,
    res: http.ServerResponse,
    isProbe: boolean
  ): void {
    if (isProbe) return

    const epoch = this.currentEpoch
    this.inFlightRequests++
    this.totalRequests++

    const rawUa = (req.headers['user-agent'] as string) || 'unknown'
    const cleanedUa = Array.from(
      rawUa.replace(/[\x00-\x1F\x7F-\x9F\u200E\u200F\u202A-\u202E]/g, '')
    )
      .slice(0, 128)
      .join('')

    this.lastCaller = cleanedUa || 'unknown'
    this.lastEndpoint = pathname
    this.lastCallTimestamp = Date.now()

    res.once('close', () => {
      this.inFlightRequests = Math.max(0, this.inFlightRequests - 1)
      if (this.currentEpoch === epoch && this.server) {
        this.lastStatusCode = res.statusCode
      }
    })
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<boolean> {
    let pathname = ''
    try {
      // 0. 安全响应头与跨域 OPTIONS 强阻断 (REV-ISS-08.1 DoD)
      res.setHeader('X-Content-Type-Options', 'nosniff')
      if (req.method === 'OPTIONS') {
        this.sendError(res, 405, 'Method Not Allowed')
        return true
      }

      const isProbe = req.headers['x-firefly-probe'] === this.probeNonce

      // 1. 服务未就绪且非内部自检探针，返回 503
      if (!this.acceptingRequests && !isProbe) {
        this.sendError(res, 503, 'Service Unavailable: Not accepting requests')
        return true
      }

      // 2. 精确端口 Host 校验 (正则严格匹配 127.0.0.1:port 必带端口且与 actualPort 完全一致)
      const hostHeader = (req.headers.host || '').trim()
      const hostMatch = hostHeader.match(/^127\.0\.0\.1:(\d{1,5})$/)
      if (!hostMatch) {
        this.sendError(res, 403, 'Forbidden: Invalid Host header')
        return true
      }
      const hostPort = Number(hostMatch[1])
      if (this.actualPort > 0 && hostPort !== this.actualPort) {
        this.sendError(res, 403, 'Forbidden: Invalid Host header')
        return true
      }

      // 3. 跨站 Origin 强阻断 (浏览器发起跨站请求必带 Origin)
      if (req.headers.origin) {
        this.sendError(res, 403, 'Forbidden: Cross-origin requests not allowed')
        return true
      }

      // 4. Sec-Fetch-Site 校验 (仅允许 same-origin 与 none)
      const secFetchSite = req.headers['sec-fetch-site']
      if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
        this.sendError(res, 403, 'Forbidden: Sec-Fetch-Site rejected')
        return true
      }

      // 5. 非 GET/HEAD 请求强制 application/json (物理绝杀 Simple CSRF)
      const method = (req.method || 'GET').toUpperCase()
      if (method !== 'GET' && method !== 'HEAD') {
        const contentType = (req.headers['content-type'] || '').toLowerCase()
        if (!contentType.includes('application/json')) {
          this.sendError(res, 415, 'Unsupported Media Type: application/json required')
          return true
        }
      }

      const parsedUrl = new URL(req.url || '', 'http://127.0.0.1')
      pathname = parsedUrl.pathname || ''
      const query = Object.fromEntries(parsedUrl.searchParams.entries())

      // 6. GET /api/health 纯内存健康检查 (支持自检探针快速放行，并顺带广播最新能力集)
      if (method === 'GET' && pathname === '/api/health') {
        this.sendSuccess(res, {
          status: 'ok',
          service: 'firefly-ai-skill-api',
          schemaVersion: 1,
          pid: process.pid,
          startedAt: this.startedAt?.toISOString() || null,
          apiVersion: '1.2.0',
          uptime: this.getUptimeSec(),
          capabilities: this.getActiveCapabilities()
        })
        return true
      }

      // 7. GET /api/capabilities 纯内存自描述能力热发现端点（供外部 Agent 一次复制长期免重配）
      if (method === 'GET' && pathname === '/api/capabilities') {
        this.recordBusinessRequest(req, pathname, res, isProbe)
        this.sendSuccess(res, {
          capabilities: this.buildCapabilityDescriptors()
        })
        return true
      }

      if (method === 'GET' && pathname === '/api/workspaces') {
        this.recordBusinessRequest(req, pathname, res, isProbe)
        const workspaces = await databaseService.getAllWorkspaceDirectories()
        this.sendSuccess(res, workspaces)
        return true
      }

      if (method === 'GET' && pathname === '/api/analysis/queue-status') {
        this.recordBusinessRequest(req, pathname, res, isProbe)
        const workspaceId = query.workspaceId ? Number(query.workspaceId) : undefined
        const status = analysisQueueService.getQueueStatus(workspaceId)
        this.sendSuccess(res, status)
        return true
      }

      if (method === 'GET' && pathname === '/api/analysis/progress') {
        this.recordBusinessRequest(req, pathname, res, isProbe)
        const workspaceId = query.workspaceId ? Number(query.workspaceId) : undefined
        const progress = analysisQueueService.getProgress(workspaceId)
        this.sendSuccess(res, progress)
        return true
      }

      if (method === 'GET' && pathname === '/api/files/analysis-data') {
        this.recordBusinessRequest(req, pathname, res, isProbe)
        const fileId = query.fileId ? Number(query.fileId) : undefined
        const filePath = query.filePath ? String(query.filePath) : undefined
        const fields = query.fields ? (query.fields as string).split(',') : undefined
        const limit = Number(query.limit) || 20
        const offset = Number(query.offset) || 0

        const target = filePath || fileId
        if (target) {
          const file = await databaseService.getFileAnalysisData(target, fields)
          if (!file) {
            this.sendError(res, 404, t('文件未找到'))
            return true
          }
          this.sendSuccess(res, this.filterInfrastructureFields(file))
          return true
        }

        const files = await databaseService.getPagedFileAnalysisData(limit, offset, fields)
        this.sendSuccess(
          res,
          files.map((f: any) => this.filterInfrastructureFields(f))
        )
        return true
      }

      if (method === 'POST' && pathname === '/api/files/analysis-data-smart') {
        this.recordBusinessRequest(req, pathname, res, isProbe)
        const rawBody = await this.readBody(req)
        const bodyRes = requireObjectBody(rawBody)
        if (!bodyRes.ok) {
          this.sendStructuredError(res, bodyRes.statusCode, {
            error: bodyRes.error,
            message: bodyRes.message
          })
          return true
        }
        const body = bodyRes.value
        const filePath = body.filePath as string
        const autoQueue = body.autoQueue !== false
        const priority = typeof body.priority === 'number' ? body.priority : 100

        if (!filePath) {
          this.sendError(res, 400, t('缺少必填字段: filePath'))
          return true
        }

        const { getFileAnalysisData } = await import('./file-analysis-service')
        const result = await getFileAnalysisData(filePath, autoQueue, priority)
        this.sendSuccess(res, result)
        return true
      }

      if (method === 'GET' && pathname === '/api/files/search') {
        this.recordBusinessRequest(req, pathname, res, isProbe)
        // 4. 并发守卫：在途搜索请求上限 4
        if (this.activeSearchesCount >= 4) {
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': '2'
          })
          res.end(
            JSON.stringify({
              success: false,
              error: 'Too many search requests, please retry shortly'
            })
          )
          return true
        }
        this.activeSearchesCount++

        try {
          const keyword = typeof query.keyword === 'string' ? query.keyword.trim() : ''
          if (!keyword) {
            this.sendError(res, 400, t('搜索关键词不能为空'))
            return true
          }

          const mode = (query.mode as string) || 'final'
          if (mode !== 'final' && mode !== 'stream') {
            this.sendError(res, 400, t('无效的搜索模式，仅支持 final 或 stream'))
            return true
          }

          const scope = (query.scope as string) || 'real'
          if (scope !== 'real' && scope !== 'virtual' && scope !== 'all') {
            this.sendError(res, 400, t('无效的搜索范围，仅支持 real、virtual 或 all'))
            return true
          }

          const limitRes = parseStrictInt(query.limit, {
            name: 'limit',
            min: 1,
            max: SKILL_API_CONSTRAINTS.search.maxLimit,
            defaultValue: SKILL_API_CONSTRAINTS.search.defaultLimit
          })
          if (!limitRes.ok) {
            this.sendStructuredError(res, 400, { error: limitRes.error, message: limitRes.message })
            return true
          }
          const offsetRes = parseStrictInt(query.offset, {
            name: 'offset',
            min: 0,
            defaultValue: 0
          })
          if (!offsetRes.ok) {
            this.sendStructuredError(res, 400, {
              error: offsetRes.error,
              message: offsetRes.message
            })
            return true
          }
          const minScoreRes = parseQueryFloat(query.minScore, {
            name: 'minScore',
            min: SKILL_API_CONSTRAINTS.search.minScoreRange[0],
            max: SKILL_API_CONSTRAINTS.search.minScoreRange[1],
            defaultValue: SKILL_API_CONSTRAINTS.search.defaultMinScore
          })
          if (!minScoreRes.ok) {
            this.sendStructuredError(res, 400, {
              error: minScoreRes.error,
              message: minScoreRes.message
            })
            return true
          }
          const limit = limitRes.value
          const offset = offsetRes.value
          const minScore = minScoreRes.value
          const virtualDirectoryId = query.virtualDirectoryId
            ? Number(query.virtualDirectoryId)
            : undefined
          const workspaceId = query.workspaceId ? Number(query.workspaceId) : undefined

          let workspaceDirectoryPath: string | undefined = undefined
          if (workspaceId !== undefined) {
            const ws = await databaseService.getWorkspaceDirectoryById(workspaceId)
            if (!ws) {
              this.sendError(res, 400, t('工作区不存在'))
              return true
            }
            workspaceDirectoryPath = ws.path
          }

          const abortController = new AbortController()
          this.inFlightAbortControllers.add(abortController)

          const params: any = {
            searchKeyword: keyword,
            workspaceDirectoryPath: scope === 'virtual' ? undefined : workspaceDirectoryPath,
            virtualDirectoryId: scope === 'virtual' ? virtualDirectoryId : undefined,
            limit,
            offset,
            similarityThreshold: minScore,
            exactMinScore: true,
            includeUnanalyzed: true,
            signal: abortController.signal
          }

          const buildSearchMeta = (
            rawItems: any[],
            rawTotal: number | undefined,
            baseDegraded: boolean,
            baseReasons: string[]
          ) => {
            const mapped = mapItemsToDTO(rawItems)
            const checked = assertSearchDtosMinScore(mapped, minScore)
            let degraded = baseDegraded
            const degradedReasons = [...baseReasons]
            if (checked.driftedCount > 0) {
              degraded = true
              if (!degradedReasons.includes('threshold_drift')) {
                degradedReasons.push('threshold_drift')
              }
              logger.warn(
                LogCategory.SYSTEM,
                `[AISkillApiService] 检索精确下推发生漂移，兜底剔除 ${checked.driftedCount} 条低分语义项 (minScore=${minScore})`
              )
            }
            const total = rawTotal ?? checked.items.length
            const poolTruncated = total >= SKILL_API_CONSTRAINTS.search.maxResultWindow
            const relaxable =
              minScore > SKILL_API_CONSTRAINTS.search.wideRecallMinScore &&
              checked.items.length < limit
            return {
              total,
              items: checked.items,
              degraded,
              degradedReasons,
              appliedMinScore: minScore,
              poolTruncated,
              relaxable,
              ...(relaxable
                ? {
                    hint: `未找到足够高相关结果。如需弱相关候选可传 minScore=${SKILL_API_CONSTRAINTS.search.wideRecallMinScore}，结果可能包含不相关项。`
                  }
                : {})
            }
          }

          if (mode === 'stream') {
            const channel = new SseChannel(res, () => {
              this.activeSseChannels.delete(channel)
              abortController.abort()
            })
            this.activeSseChannels.add(channel)
            res.once('close', () => {
              this.activeSseChannels.delete(channel)
            })
            params.onProgress = async (phase: 'phase1' | 'phase2' | 'phase3', progRes: any) => {
              if (channel.isClosed()) return
              const meta = buildSearchMeta(progRes?.items || [], progRes?.total, false, [])
              if (phase === 'phase1') {
                await channel.sendEvent('phase1', {
                  phase: 1,
                  total: meta.total,
                  isSettled: false,
                  appliedMinScore: meta.appliedMinScore,
                  poolTruncated: meta.poolTruncated,
                  items: meta.items
                })
              } else if (phase === 'phase2') {
                await channel.sendEvent('phase2', {
                  phase: 2,
                  total: meta.total,
                  isSettled: true,
                  clipPending: Boolean(progRes?.clipPending),
                  appliedMinScore: meta.appliedMinScore,
                  poolTruncated: meta.poolTruncated,
                  relaxable: meta.relaxable,
                  ...(meta.hint ? { hint: meta.hint } : {}),
                  items: meta.items
                })
              } else if (phase === 'phase3') {
                await channel.sendEvent('phase3', {
                  phase: 3,
                  total: meta.total,
                  isSettled: true,
                  appliedMinScore: meta.appliedMinScore,
                  poolTruncated: meta.poolTruncated,
                  relaxable: meta.relaxable,
                  ...(meta.hint ? { hint: meta.hint } : {}),
                  items: meta.items
                })
              }
            }

            try {
              if (virtualDirectoryService) {
                await virtualDirectoryService.getFilteredFilesPaged(params)
              } else {
                const { TagTreeQuery } =
                  await import('./filesystem/virtual-directory-service/TagTreeQuery')
                const db = databaseService.db
                if (!db) throw new Error('[AISkillAPI] 数据库未初始化，无法执行标签树查询')
                const tagTreeQuery = new TagTreeQuery(db)
                await tagTreeQuery.getFilteredFilesPaged(params)
              }
              await channel.sendEvent('done', { isSettled: true })
            } catch (err: any) {
              if (!channel.isClosed()) {
                await channel.sendEvent('error', { error: err?.message || String(err) })
              }
            } finally {
              channel.close()
              this.inFlightAbortControllers.delete(abortController)
            }
            return true
          }

          // mode === 'final'
          const startTime = performance.now()
          let lastProgressResult: any = null
          params.onProgress = (_phase: string, progRes: any) => {
            lastProgressResult = progRes
          }

          try {
            const timeoutPromise = new Promise<'timeout'>(resolve => {
              setTimeout(() => resolve('timeout'), 8000)
            })

            const searchPromise = (async () => {
              if (virtualDirectoryService) {
                return await virtualDirectoryService.getFilteredFilesPaged(params)
              } else {
                const { TagTreeQuery } =
                  await import('./filesystem/virtual-directory-service/TagTreeQuery')
                const db = databaseService.db
                if (!db) throw new Error('[AISkillAPI] 数据库未初始化，无法执行标签树查询')
                const tagTreeQuery = new TagTreeQuery(db)
                return await tagTreeQuery.getFilteredFilesPaged(params)
              }
            })()

            const raceResult = await Promise.race([searchPromise, timeoutPromise])
            const duration = Math.round(performance.now() - startTime)

            if (raceResult === 'timeout') {
              abortController.abort()
              const meta = buildSearchMeta(
                lastProgressResult?.items || [],
                lastProgressResult?.total,
                true,
                ['search_timeout']
              )
              this.sendSuccess(res, {
                total: meta.total,
                isSettled: true,
                searchDurationMs: duration,
                degraded: meta.degraded,
                degradedReasons: meta.degradedReasons,
                appliedMinScore: meta.appliedMinScore,
                poolTruncated: meta.poolTruncated,
                relaxable: meta.relaxable,
                ...(meta.hint ? { hint: meta.hint } : {}),
                items: meta.items
              })
            } else {
              const searchRes = raceResult
              const meta = buildSearchMeta(searchRes.items, searchRes.total, false, [])
              this.sendSuccess(res, {
                total: meta.total,
                isSettled: true,
                searchDurationMs: duration,
                degraded: meta.degraded,
                degradedReasons: meta.degradedReasons,
                clipPending: Boolean((searchRes as any).clipPending),
                appliedMinScore: meta.appliedMinScore,
                poolTruncated: meta.poolTruncated,
                relaxable: meta.relaxable,
                ...(meta.hint ? { hint: meta.hint } : {}),
                items: meta.items
              })
            }
          } catch (err: any) {
            this.sendError(res, 500, err?.message || String(err))
          } finally {
            this.inFlightAbortControllers.delete(abortController)
          }
          return true
        } finally {
          this.activeSearchesCount--
        }
      }

      if (method === 'GET' && pathname === '/api/organize/templates') {
        this.recordBusinessRequest(req, pathname, res, isProbe)
        const wsIdRes = parseStrictInt(query.workspaceId, {
          name: 'workspaceId',
          min: 1,
          required: true
        })
        if (!wsIdRes.ok) {
          this.sendStructuredError(res, 400, { error: wsIdRes.error, message: wsIdRes.message })
          return true
        }
        const workspaceId = wsIdRes.value
        const userInstruction = (query.userInstruction as string) || ''

        const ws = await databaseService.getWorkspaceDirectoryById(workspaceId)
        if (!ws) {
          this.sendStructuredError(res, 400, {
            error: 'INVALID_ARGUMENT',
            message: '目标工作区不存在'
          })
          return true
        }

        if (!organizeRealDirectoryService) throw new Error('Organize service not ready')

        const { systemPrompt, userPrompt } =
          await organizeRealDirectoryService.buildOrganizePrompts(ws.path, userInstruction)

        const fileCount = await databaseService.countAnalyzedFilesByWorkspace(workspaceId)

        this.sendSuccess(res, {
          workspaceId,
          workspacePath: ws.path,
          fileCount,
          systemPrompt,
          userPrompt
        })
        return true
      }

      if (method === 'GET' && pathname === '/api/virtual-directories') {
        this.recordBusinessRequest(req, pathname, res, isProbe)
        const wsIdRes = parseStrictInt(query.workspaceId, {
          name: 'workspaceId',
          min: 1,
          required: true
        })
        if (!wsIdRes.ok) {
          this.sendStructuredError(res, 400, { error: wsIdRes.error, message: wsIdRes.message })
          return true
        }
        const workspaceId = wsIdRes.value
        const ws = await databaseService.getWorkspaceDirectoryById(workspaceId)
        if (!ws) {
          this.sendStructuredError(res, 400, {
            error: 'INVALID_ARGUMENT',
            message: '目标工作区不存在'
          })
          return true
        }

        if (!virtualDirectoryService) throw new Error('Virtual directory service not ready')
        const list = await virtualDirectoryService.list(workspaceId)
        this.sendSuccess(res, list)
        return true
      }

      if (method === 'POST' && pathname === '/api/organize/apply-plan') {
        this.recordBusinessRequest(req, pathname, res, isProbe)
        const body = await this.readBody(req)
        const planRes = validateApplyPlanBody(body)
        if (!planRes.ok) {
          this.sendStructuredError(res, 400, { error: planRes.error, message: planRes.message })
          return true
        }
        const { name, strategy, perspective } = planRes.value

        const windows = BrowserWindow.getAllWindows()
        windows.forEach(w => {
          w.webContents.send('organize:apply-plan', { name, strategy, perspective })
        })

        logger.info(LogCategory.SYSTEM, `[AI Skill API] 整理方案已转发到渲染进程: ${name}`)

        this.sendSuccess(res, {
          message: '整理方案已发送到整理页面'
        })
        return true
      }

      // 8. 多模态扩展能力端点 (/api/ai/ocr, /api/ai/transcribe, /api/ai/synthesize, /api/ai/assert-sensitive)
      if (
        method === 'POST' &&
        (pathname === '/api/ai/ocr' ||
          pathname === '/api/ai/transcribe' ||
          pathname === '/api/ai/synthesize' ||
          pathname === '/api/ai/assert-sensitive')
      ) {
        this.recordBusinessRequest(req, pathname, res, isProbe)
        return await this.handleMultimodalRequest(pathname, req, res)
      }

      return false
    } catch (error: any) {
      if (res.writableEnded || res.destroyed) {
        logger.debug(LogCategory.SYSTEM, `[AI Skill API] 客户端已提前断开: ${pathname}`)
        return true
      }
      logger.error(LogCategory.SYSTEM, `[AI Skill API] 处理请求失败: ${pathname}`, error)
      const statusCode =
        typeof error?.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 600
          ? error.statusCode
          : 500
      if (statusCode === 413) {
        res.setHeader('Connection', 'close')
      }
      this.sendError(res, statusCode, error?.message || t('内部服务异常'))
      return true
    }
  }

  /**
   * 构造当前已激活能力的自描述清单（供 GET /api/capabilities 返回）
   */
  private buildCapabilityDescriptors(): ExternalApiCapabilityDescriptor[] {
    const activeSet = new Set(this.getActiveCapabilities())
    const allDescriptors: ExternalApiCapabilityDescriptor[] = [
      {
        id: 'search',
        method: 'GET',
        path: '/api/files/search',
        description:
          '按关键词、模糊语义或音视频对白检索本地文件（单次查询最多可翻看前 200 条最相关结果）',
        inputSchema: {
          keyword: 'string (required)',
          limit: 'number (optional, 1-50, default 20)',
          offset: 'number (optional, >= 0, default 0)',
          minScore: 'number (optional, 0-1, default 0.55; pass 0.35 for broader recall)',
          scope: 'string (optional: real | virtual | all)'
        },
        constraints: {
          defaultMinScore: SKILL_API_CONSTRAINTS.search.defaultMinScore,
          wideRecallMinScore: SKILL_API_CONSTRAINTS.search.wideRecallMinScore,
          minScoreRange: [...SKILL_API_CONSTRAINTS.search.minScoreRange],
          maxLimit: SKILL_API_CONSTRAINTS.search.maxLimit,
          maxResultWindow: SKILL_API_CONSTRAINTS.search.maxResultWindow
        }
      },
      {
        id: 'timeline',
        method: 'GET',
        path: '/api/files/search',
        description: '在视频检索结果中返回精确的镜头片段与起止秒数 (videoSegments)',
        inputSchema: {
          keyword: 'string (required)',
          limit: 'number (optional, 1-50)'
        }
      },
      {
        id: 'progress',
        method: 'GET',
        path: '/api/analysis/progress',
        description: '查询当前电脑后台文件分析与索引进度',
        inputSchema: {}
      },
      {
        id: 'virtual-folder-draft',
        method: 'POST',
        path: '/api/organize/apply-plan',
        description: '向桌面端推送多维文件分类整理草案（需用户人工确认后生效）',
        inputSchema: {
          name: 'string (required, 1-128 chars)',
          strategy: 'string (required, 1-2500 chars)',
          perspective: 'string (optional, <= 500 chars)'
        },
        constraints: {
          maxNameChars: SKILL_API_CONSTRAINTS.organize.maxNameChars,
          maxStrategyChars: SKILL_API_CONSTRAINTS.organize.maxStrategyChars,
          maxPerspectiveChars: SKILL_API_CONSTRAINTS.organize.maxPerspectiveChars
        }
      },
      {
        id: 'ocr',
        method: 'POST',
        path: '/api/ai/ocr',
        description: '从本地图片、文档或 Base64 图片中识别并提取文字内容（也兼容直接传入 text）',
        inputSchema: {
          filePath: 'string (optional, absolute local image/document path)',
          imageBase64: 'string (optional, base64 image or data URI)',
          mimeType: 'string (optional, e.g. image/png)',
          text: 'string (optional, passthrough text)'
        },
        constraints: {
          maxDocumentBytes: SKILL_API_CONSTRAINTS.ocr.maxDocumentBytes
        }
      },
      {
        id: 'asr',
        method: 'POST',
        path: '/api/ai/transcribe',
        description:
          '将本地音视频文件或 Base64 音频中的说话内容转写为文字与整段覆盖时长（不提供逐词时间戳，超长音频按引擎分析窗口截取前段）',
        inputSchema: {
          filePath: 'string (optional, absolute local audio/video path)',
          audioBase64: 'string (optional, base64 audio or data URI)',
          language: 'string (optional)'
        },
        constraints: {
          maxFileBytes: SKILL_API_CONSTRAINTS.asr.maxFileBytes,
          timestamps: SKILL_API_CONSTRAINTS.asr.timestamps
        }
      },
      {
        id: 'tts',
        method: 'POST',
        path: '/api/ai/synthesize',
        description:
          '将短文本或本地 UTF-8 文本文件内容合成为自然流畅的 WAV 语音（单次最多 150 字，长文请分句串行调用）',
        inputSchema: {
          text: 'string (optional, 1-150 chars, mutually exclusive with filePath)',
          filePath: 'string (optional, local UTF-8 text file <= 64KB)',
          voiceId: 'string (optional)',
          speed: 'number (optional, 0.5-2.0)',
          responseFormat: 'string (optional: file | base64, default file)'
        },
        constraints: {
          maxTextChars: SKILL_API_CONSTRAINTS.tts.maxTextChars,
          maxFileBytes: SKILL_API_CONSTRAINTS.tts.maxFileBytes,
          maxChunkChars: SKILL_API_CONSTRAINTS.tts.maxChunkChars,
          chunkTimeoutMs: SKILL_API_CONSTRAINTS.tts.chunkTimeoutMs,
          firstChunkTimeoutMs: SKILL_API_CONSTRAINTS.tts.firstChunkTimeoutMs,
          requestTimeoutMs: SKILL_API_CONSTRAINTS.tts.requestTimeoutMs,
          maxConcurrent: SKILL_API_CONSTRAINTS.tts.maxConcurrent
        }
      },
      {
        id: 'sensitive',
        method: 'POST',
        path: '/api/ai/assert-sensitive',
        description:
          '检测本地图片/文档、Base64 图片或纯文本是否包含暴恐、涉政、违规、色情、辱骂、血腥等敏感内容并返回合规分级结果',
        inputSchema: {
          text: 'string (optional, plain text)',
          filePath: 'string (optional, local image/document path <= 50MB)',
          imageBase64: 'string (optional, base64 image)',
          language: 'string (optional)'
        },
        constraints: {
          maxFileBytes: SKILL_API_CONSTRAINTS.sensitive.maxFileBytes
        }
      }
    ]
    return allDescriptors.filter(d => activeSet.has(d.id))
  }

  /**
   * 统一处理多模态扩展能力路由：先 readBody + 零 I/O 参数校验，再原子占槽(429) + AbortController 联动
   */
  private async handleMultimodalRequest(
    pathname: string,
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<boolean> {
    const rawBody = await this.readBody(req, this.maxMultimodalBodyBytes)
    const objRes = requireObjectBody(rawBody)
    if (!objRes.ok) {
      this.sendStructuredError(res, 400, { error: objRes.error, message: objRes.message })
      return true
    }
    const body = objRes.value

    // 零 I/O 前置校验（在抢占并发槽之前完成，确保繁忙态非法入参亦稳定返 400）
    let ttsPreFlight: ReturnType<typeof validateSynthesizePreFlight> | null = null
    let ocrFileRoute: 'image' | 'document' | null = null

    if (pathname === '/api/ai/synthesize') {
      ttsPreFlight = validateSynthesizePreFlight(body)
      if (!ttsPreFlight.ok) {
        this.sendStructuredError(res, 400, {
          error: ttsPreFlight.error,
          message: ttsPreFlight.message
        })
        return true
      }
    } else if (pathname === '/api/ai/ocr') {
      const ocrEnabled =
        ConfigOrchestrator.getInstance().getValue<boolean>('ENABLE_IMAGE_OCR') ?? true
      if (!ocrEnabled) {
        this.sendStructuredError(res, 400, {
          error: 'FEATURE_DISABLED',
          message: '图片文字识别功能未开启',
          requiredSetting: 'ENABLE_IMAGE_OCR'
        })
        return true
      }
      if (body.filePath !== undefined && body.filePath !== null && String(body.filePath).trim()) {
        const ocrCheck = validateOcrFilePath(body.filePath)
        if (!ocrCheck.ok) {
          this.sendStructuredError(res, 400, { error: ocrCheck.error, message: ocrCheck.message })
          return true
        }
        ocrFileRoute = ocrCheck.value.route
      }
    } else if (pathname === '/api/ai/transcribe') {
      if (body.filePath !== undefined && body.filePath !== null && String(body.filePath).trim()) {
        const asrCheck = validateTranscribeFilePath(body.filePath)
        if (!asrCheck.ok) {
          this.sendStructuredError(res, 400, { error: asrCheck.error, message: asrCheck.message })
          return true
        }
      }
    } else if (pathname === '/api/ai/assert-sensitive') {
      if (body.filePath !== undefined && body.filePath !== null && String(body.filePath).trim()) {
        const pathCheck = validateAbsoluteLocalPath(body.filePath)
        if (!pathCheck.ok) {
          this.sendStructuredError(res, 400, {
            error: pathCheck.error,
            message: pathCheck.message
          })
          return true
        }
      }
    }

    // 同步原子检查并发槽：先查 TTS 单飞槽（429 TTS_BUSY + Retry-After: 10），再查多模态总槽（429 + Retry-After: 2）
    const isTts = pathname === '/api/ai/synthesize'
    if (isTts && this.activeTtsCount >= SKILL_API_CONSTRAINTS.tts.maxConcurrent) {
      this.sendStructuredError(
        res,
        429,
        {
          error: 'TTS_BUSY',
          message: '语音合成通道正忙，请稍后重试',
          retryable: true
        },
        { 'Retry-After': '10' }
      )
      return true
    }
    if (this.activeMultimodalCount >= 2) {
      this.sendStructuredError(
        res,
        429,
        {
          error: 'TOO_MANY_REQUESTS',
          message: 'Too many multimodal inference requests, please retry shortly',
          retryable: true
        },
        { 'Retry-After': '2' }
      )
      return true
    }

    if (isTts) this.activeTtsCount++
    this.activeMultimodalCount++
    const abortController = new AbortController()
    this.inFlightAbortControllers.add(abortController)
    const onResClose = () => {
      if (!res.writableEnded) {
        abortController.abort()
      }
    }
    res.once('close', onResClose)

    const raceWithAbort = <T>(promise: Promise<T>): Promise<T> => {
      if (abortController.signal.aborted) {
        return Promise.reject(Object.assign(new Error('Request aborted'), { statusCode: 503 }))
      }
      return new Promise<T>((resolve, reject) => {
        const onAbort = () => {
          reject(Object.assign(new Error('Request aborted'), { statusCode: 503 }))
        }
        abortController.signal.addEventListener('abort', onAbort, { once: true })
        promise.then(
          val => {
            abortController.signal.removeEventListener('abort', onAbort)
            resolve(val)
          },
          err => {
            abortController.signal.removeEventListener('abort', onAbort)
            reject(err)
          }
        )
      })
    }

    const decodeBase64Payload = (raw: string): { buffer: Buffer; ext: string } => {
      const trimmed = raw.trim()
      let ext = 'bin'
      let b64 = trimmed
      const dataUriMatch = trimmed.match(/^data:([^;]+);base64,(.*)$/s)
      if (dataUriMatch) {
        const mime = dataUriMatch[1].toLowerCase()
        b64 = dataUriMatch[2]
        if (mime.includes('png')) ext = 'png'
        else if (mime.includes('jpeg') || mime.includes('jpg')) ext = 'jpg'
        else if (mime.includes('webp')) ext = 'webp'
        else if (mime.includes('bmp')) ext = 'bmp'
        else if (mime.includes('gif')) ext = 'gif'
        else if (mime.includes('wav')) ext = 'wav'
        else if (mime.includes('mpeg') || mime.includes('mp3')) ext = 'mp3'
      }
      return { buffer: Buffer.from(b64, 'base64'), ext }
    }

    try {
      if (pathname === '/api/ai/ocr') {
        const filePath = typeof body.filePath === 'string' ? body.filePath.trim() : ''
        const imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64.trim() : ''
        const rawText = typeof body.text === 'string' ? body.text.trim() : ''

        if (!filePath && !imageBase64 && !rawText) {
          this.sendStructuredError(res, 400, {
            error: 'INVALID_ARGUMENT',
            message: '至少需要提供 filePath、imageBase64 或 text 之一'
          })
          return true
        }

        if (rawText && !filePath && !imageBase64) {
          this.sendSuccess(res, { text: rawText, source: 'text_passthrough' })
          return true
        }

        if (imageBase64) {
          const { buffer, ext: inferredExt } = decodeBase64Payload(imageBase64)
          if (buffer.byteLength === 0) {
            this.sendStructuredError(res, 400, {
              error: 'INVALID_ARGUMENT',
              message: '无效的 imageBase64 数据'
            })
            return true
          }
          if (!hasKnownImageMagic(buffer)) {
            this.sendStructuredError(res, 400, {
              error: 'UNSUPPORTED_FILE_TYPE',
              message: 'imageBase64 内容不是有效的图像格式（仅支持 PNG/JPEG/WEBP/GIF/BMP/TIFF）'
            })
            return true
          }
          const mimeHint = typeof body.mimeType === 'string' ? body.mimeType.toLowerCase() : ''
          const ext =
            inferredExt !== 'bin'
              ? inferredExt
              : mimeHint.includes('jpeg') || mimeHint.includes('jpg')
                ? 'jpg'
                : mimeHint.includes('webp')
                  ? 'webp'
                  : 'png'
          await fs.mkdir(this.tmpInputDir, { recursive: true })
          const tmpImgPath = path.join(this.tmpInputDir, `${crypto.randomUUID()}.${ext}`)
          try {
            await fs.writeFile(tmpImgPath, buffer)
            const perceived = await raceWithAbort(
              omniService.perceive(tmpImgPath, { enableImageOcr: true })
            )
            this.sendSuccess(res, {
              text: perceived?.ocr_text || '',
              source: 'image_ocr_base64'
            })
          } finally {
            await fs.unlink(tmpImgPath).catch(() => {})
          }
          return true
        }

        const statRes = await statRegularFile(
          filePath,
          ocrFileRoute === 'document' ? SKILL_API_CONSTRAINTS.ocr.maxDocumentBytes : undefined
        )
        if (!statRes.ok) {
          this.sendStructuredError(res, 400, { error: statRes.error, message: statRes.message })
          return true
        }

        if (ocrFileRoute === 'image') {
          const perceived = await raceWithAbort(
            omniService.perceive(filePath, { enableImageOcr: true })
          )
          this.sendSuccess(res, {
            text: perceived?.ocr_text || '',
            source: 'image_ocr'
          })
        } else {
          const extracted = await raceWithAbort(omniService.extract(filePath))
          this.sendSuccess(res, {
            text: extracted?.markdown_content || '',
            source: 'document_extract'
          })
        }
        return true
      }

      if (pathname === '/api/ai/transcribe') {
        const filePath = typeof body.filePath === 'string' ? body.filePath.trim() : ''
        const audioBase64 = typeof body.audioBase64 === 'string' ? body.audioBase64.trim() : ''
        if (!filePath && !audioBase64) {
          this.sendStructuredError(res, 400, {
            error: 'INVALID_ARGUMENT',
            message: '至少需要提供 filePath 或 audioBase64 之一'
          })
          return true
        }

        let audioInput: string | Buffer
        if (audioBase64) {
          const { buffer } = decodeBase64Payload(audioBase64)
          if (buffer.byteLength === 0) {
            this.sendStructuredError(res, 400, {
              error: 'INVALID_ARGUMENT',
              message: '无效的 audioBase64 数据'
            })
            return true
          }
          if (hasKnownNonAudioMagic(buffer)) {
            this.sendStructuredError(res, 400, {
              error: 'UNSUPPORTED_FILE_TYPE',
              message: 'audioBase64 内容不是有效的音频或视频数据'
            })
            return true
          }
          audioInput = buffer
        } else {
          const statRes = await statRegularFile(filePath, SKILL_API_CONSTRAINTS.asr.maxFileBytes)
          if (!statRes.ok) {
            this.sendStructuredError(res, 400, { error: statRes.error, message: statRes.message })
            return true
          }
          audioInput = filePath
        }

        const language = typeof body.language === 'string' ? body.language.trim() : undefined
        try {
          const result = await VoiceSeamDispatcher.getInstance().transcribe(audioInput, {
            language,
            signal: abortController.signal
          })
          if (result.decodeFailed) {
            this.sendStructuredError(res, 400, {
              error: 'UNSUPPORTED_FILE_TYPE',
              message: '无法解码为有效音频或视频不含音轨'
            })
            return true
          }
          const segments = Array.isArray(result.segments)
            ? result.segments.map(seg => ({
                start: Number((seg.startMs / 1000).toFixed(3)),
                end: Number((seg.endMs / 1000).toFixed(3)),
                text: seg.text
              }))
            : []
          this.sendSuccess(res, {
            text: result.text || '',
            segments,
            timestamps: segments.length > 0 ? 'span_only' : 'none'
          })
        } catch (err: any) {
          if (err instanceof VoiceSeamError) {
            const mapping = VOICE_SEAM_HTTP_ERROR_MAP[err.code]
            if (err.code === 'ABORTED' && (res.writableEnded || res.destroyed)) {
              logger.debug(LogCategory.SYSTEM, '[AI Skill API] ASR 客户端已断连，跳过响应写回')
              return true
            }
            const extra =
              err.code === 'NO_ACTIVE_PLUGIN' ? { requiredSlot: 'voice_asr' } : undefined
            const headers = mapping.retryAfterSec
              ? { 'Retry-After': String(mapping.retryAfterSec) }
              : undefined
            this.sendStructuredError(
              res,
              mapping.statusCode,
              {
                error: mapping.error,
                message: err.message || mapping.defaultMessage,
                retryable: mapping.retryable,
                ...extra
              },
              headers
            )
            return true
          }
          throw err
        }
        return true
      }

      if (pathname === '/api/ai/synthesize' && ttsPreFlight && ttsPreFlight.ok) {
        const pre = ttsPreFlight.value
        let text = pre.text || ''
        if (pre.mode === 'filePath' && pre.filePath) {
          const readRes = await readBoundedUtf8File(
            pre.filePath,
            SKILL_API_CONSTRAINTS.tts.maxFileBytes
          )
          if (!readRes.ok) {
            this.sendStructuredError(res, 400, { error: readRes.error, message: readRes.message })
            return true
          }
          text = readRes.value.trim()
          if (!text || countCodePoints(text) > SKILL_API_CONSTRAINTS.tts.maxTextChars) {
            this.sendStructuredError(res, 400, {
              error: 'INVALID_ARGUMENT',
              message: text
                ? `单次语音合成文本不得超过 ${SKILL_API_CONSTRAINTS.tts.maxTextChars} 字，请按句切分后串行调用`
                : '目标文本文件内容为空'
            })
            return true
          }
        }

        const totalBudgetSignal = AbortSignal.timeout(SKILL_API_CONSTRAINTS.tts.requestTimeoutMs)
        const combinedSignal = AbortSignal.any([abortController.signal, totalBudgetSignal])
        let writtenAudioPath: string | null = null

        try {
          const wavBuf = await VoiceSeamDispatcher.getInstance().synthesizeToWav(text, {
            voiceId: pre.voiceId,
            speed: pre.speed,
            signal: combinedSignal,
            chunkTimeoutMs: SKILL_API_CONSTRAINTS.tts.chunkTimeoutMs,
            firstChunkTimeoutMs: SKILL_API_CONSTRAINTS.tts.firstChunkTimeoutMs,
            totalBudgetMs: SKILL_API_CONSTRAINTS.tts.requestTimeoutMs,
            maxChunkChars: SKILL_API_CONSTRAINTS.tts.maxChunkChars
          })
          if (combinedSignal.aborted) {
            const code =
              (combinedSignal.reason as any)?.name === 'TimeoutError' ? 'TIMEOUT' : 'ABORTED'
            throw new VoiceSeamError(code)
          }
          await this.cleanupTtsTempDir('prune')
          await fs.mkdir(this.ttsTempDir, { recursive: true })
          const audioPath = path.join(this.ttsTempDir, `${crypto.randomUUID()}.wav`)
          const wavNodeBuf = Buffer.from(wavBuf)
          await fs.writeFile(audioPath, wavNodeBuf)
          writtenAudioPath = audioPath
          const pcmBytes = Math.max(0, wavBuf.byteLength - 44)
          const durationSec = Number((pcmBytes / (48000 * 2)).toFixed(2))
          this.sendSuccess(res, {
            audioPath,
            durationSec,
            ...(pre.responseFormat === 'base64'
              ? { audioBase64: wavNodeBuf.toString('base64'), mimeType: 'audio/wav' }
              : {})
          })
        } catch (err: any) {
          if (writtenAudioPath) {
            await fs.unlink(writtenAudioPath).catch(unlinkErr => {
              logger.warn(
                LogCategory.SYSTEM,
                '[AI Skill API] TTS 失败临时文件清理异常:',
                unlinkErr
              )
            })
          }
          if (err instanceof VoiceSeamError) {
            const mapping = VOICE_SEAM_HTTP_ERROR_MAP[err.code]
            if (err.code === 'ABORTED' && (res.writableEnded || res.destroyed)) {
              logger.debug(LogCategory.SYSTEM, '[AI Skill API] TTS 客户端已断连，跳过响应写回')
              return true
            }
            const extra =
              err.code === 'NO_ACTIVE_PLUGIN' ? { requiredSlot: 'voice_tts' } : undefined
            const headers = mapping.retryAfterSec
              ? { 'Retry-After': String(mapping.retryAfterSec) }
              : undefined
            this.sendStructuredError(
              res,
              mapping.statusCode,
              {
                error: mapping.error,
                message:
                  err.code === 'TIMEOUT'
                    ? mapping.defaultMessage
                    : err.message || mapping.defaultMessage,
                retryable: mapping.retryable,
                ...extra
              },
              headers
            )
            return true
          }
          throw err
        }
        return true
      }

      if (pathname === '/api/ai/assert-sensitive') {
        const activeMod = modularResourceService.getActiveModuleBySlot('perception_nsfw')
        const isReady = Boolean(
          activeMod && modularResourceService.processManager.isUsable(activeMod.id)
        )
        if (!isReady) {
          this.sendStructuredError(res, 400, {
            error: 'PLUGIN_NOT_ACTIVE',
            message: '内容安全检测需安装并启用对应插件',
            requiredSlot: 'perception_nsfw'
          })
          return true
        }

        const text = typeof body.text === 'string' ? body.text.trim() : ''
        const filePath = typeof body.filePath === 'string' ? body.filePath.trim() : ''
        const imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64.trim() : ''
        const language = typeof body.language === 'string' ? body.language.trim() : undefined

        if (!text && !filePath && !imageBase64) {
          this.sendStructuredError(res, 400, {
            error: 'INVALID_ARGUMENT',
            message: '至少需要提供 text、filePath 或 imageBase64 之一'
          })
          return true
        }

        if (filePath) {
          const statRes = await statRegularFile(
            filePath,
            SKILL_API_CONSTRAINTS.sensitive.maxFileBytes
          )
          if (!statRes.ok) {
            this.sendStructuredError(res, 400, { error: statRes.error, message: statRes.message })
            return true
          }
        }

        const nsfwRes = await raceWithAbort(
          omniService.assertNsfw({
            text: text || undefined,
            filePath: filePath || undefined,
            imageBase64: imageBase64 || undefined,
            language
          })
        )
        if (!nsfwRes) {
          this.sendError(res, 500, '敏感内容鉴别引擎响应异常')
          return true
        }

        this.sendSuccess(res, {
          isSensitive: Boolean(nsfwRes.is_sensitive),
          status: nsfwRes.status || 'skipped',
          tags: Array.isArray(nsfwRes.tags) ? nsfwRes.tags : [],
          sensitiveTypes: Array.isArray(nsfwRes.sensitive_types) ? nsfwRes.sensitive_types : [],
          contentRating: nsfwRes.content_rating ?? undefined,
          ...(Array.isArray(nsfwRes.nsfw_probs) ? { nsfwProbs: nsfwRes.nsfw_probs } : {}),
          supportedDimensions: nsfwRes.supported_dimensions || [
            '暴恐',
            '涉政',
            '违规',
            '色情',
            '辱骂',
            '血腥'
          ]
        })
        return true
      }

      return false
    } finally {
      res.off('close', onResClose)
      this.inFlightAbortControllers.delete(abortController)
      this.activeMultimodalCount = Math.max(0, this.activeMultimodalCount - 1)
      if (isTts) {
        this.activeTtsCount = Math.max(0, this.activeTtsCount - 1)
      }
    }
  }

  private sendStructuredError(
    res: http.ServerResponse,
    statusCode: number,
    payload: { error: string; message: string; [key: string]: any },
    headers?: Record<string, string>
  ) {
    if (res.writableEnded || res.destroyed) return
    try {
      res.statusCode = statusCode
      const responseData = JSON.stringify({ success: false, ...payload })
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Content-Length', Buffer.byteLength(responseData))
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          res.setHeader(k, v)
        }
      }
      res.end(responseData)
    } catch (error: any) {
      logger.error(LogCategory.SYSTEM, '[AI Skill API] 发送结构化错误响应失败', error)
      if (!res.writableEnded && !res.destroyed) {
        res.statusCode = 500
        res.end(JSON.stringify({ success: false, error: t('响应序列化失败') }))
      }
    }
  }

  private sendError(res: http.ServerResponse, statusCode: number, message: string) {
    if (res.writableEnded || res.destroyed) return
    try {
      res.statusCode = statusCode
      const payload = { success: false, error: message }
      const responseData = JSON.stringify(payload)
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Content-Length', Buffer.byteLength(responseData))
      res.end(responseData)
    } catch (error: any) {
      logger.error(LogCategory.SYSTEM, '[AI Skill API] 发送错误响应失败', error)
      if (!res.writableEnded && !res.destroyed) {
        res.statusCode = 500
        res.end(JSON.stringify({ success: false, error: t('响应序列化失败') }))
      }
    }
  }

  private sendSuccess(res: http.ServerResponse, data: any) {
    if (res.writableEnded || res.destroyed) return
    try {
      res.statusCode = 200
      const payload: any = { success: true }
      if (typeof data === 'object' && !Array.isArray(data)) {
        Object.assign(payload, data)
      } else {
        payload.data = data
      }
      const responseData = JSON.stringify(payload)
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Content-Length', Buffer.byteLength(responseData))
      res.end(responseData)
    } catch (error: any) {
      logger.error(LogCategory.SYSTEM, '[AI Skill API] 发送成功响应失败', error)
      if (!res.writableEnded) {
        res.statusCode = 500
        res.end(JSON.stringify({ success: false, error: t('响应序列化失败') }))
      }
    }
  }
}

export const aiSkillApiService = new AISkillApiService()
