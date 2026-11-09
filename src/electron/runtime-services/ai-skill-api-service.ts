import { t } from '@app/languages'
import * as http from 'node:http'
import * as fs from 'node:fs/promises'
import * as fsSync from 'node:fs'
import * as crypto from 'node:crypto'
import * as path from 'path'
import { BrowserWindow } from 'electron'
import { logger, LogCategory, APP_PORTS } from '@firefly/shared'
import * as iconv from 'iconv-lite'
import {
  type ExternalApiActivityInfo,
  type ExternalApiTestResultDTO,
  type AiSkillDiscoveryFileV1,
  EXTERNAL_API_CAPABILITIES
} from '@firefly/types'
import { databaseService } from './database/database-service'
import { analysisQueueService } from './analysis-queue-service'
import { organizeRealDirectoryService, virtualDirectoryService } from '../main/state'

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

function detectMediaType(filePath: string, name: string): 'video' | 'image' | 'document' | 'other' {
  const ext = path
    .extname(name || filePath)
    .toLowerCase()
    .replace('.', '')
  const videoExts = new Set(['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv', 'wmv', 'm4v'])
  const imageExts = new Set([
    'jpg',
    'jpeg',
    'png',
    'gif',
    'webp',
    'svg',
    'bmp',
    'ico',
    'tiff',
    'heic'
  ])
  const docExts = new Set([
    'pdf',
    'doc',
    'docx',
    'txt',
    'md',
    'xls',
    'xlsx',
    'ppt',
    'pptx',
    'csv',
    'epub'
  ])
  if (videoExts.has(ext)) return 'video'
  if (imageExts.has(ext)) return 'image'
  if (docExts.has(ext)) return 'document'
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
    const mediaType = detectMediaType(item.path || '', item.name || '')
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
  private inFlightAbortControllers: Set<AbortController> = new Set()
  private activeSearchesCount = 0

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
    if (userDataPath) {
      this.configFilePath = path.join(userDataPath, 'ai-skill-config.json')
    } else {
      try {
        const { app } = require('electron')
        if (app && typeof app.getPath === 'function') {
          this.configFilePath = path.join(app.getPath('userData'), 'ai-skill-config.json')
        }
      } catch {
        // 非 Electron / 单测环境
      }
    }
    // 启动期安全自愈：清理损坏或孤儿发现文件 (TEST-EXT-10 / Spec §2.2)
    this.cleanupOrphanDiscoveryOnStartup()
  }

  /**
   * 启动期安全清理孤儿或损坏发现文件
   */
  private cleanupOrphanDiscoveryOnStartup(): void {
    try {
      if (!this.configFilePath || !fsSync.existsSync(this.configFilePath)) return
      const content = fsSync.readFileSync(this.configFilePath, 'utf8')
      let config: any
      try {
        config = JSON.parse(content)
      } catch {
        // 非法 JSON 损坏文件，直接清理 (TEST-EXT-10)
        logger.warn(LogCategory.SYSTEM, `[AISkillApi] 清理损坏的发现文件: ${this.configFilePath}`)
        fsSync.unlinkSync(this.configFilePath)
        return
      }

      if (config.service !== 'firefly-ai-skill-api') {
        logger.warn(
          LogCategory.SYSTEM,
          `[AISkillApi] 发现文件 service 不匹配 (${config.service})，拒绝覆盖或删除`
        )
        return
      }

      if (config.pid === process.pid) return // 本进程有效

      // D-03: 单实例互斥锁下，属于本服务的旧发现文件必属旧残留
      // isPidAlive 仅用于日志精确分类 (CRASH_RESIDUE vs ZOMBIE_OR_REUSED_PID)，不作为保留死文件的依据
      const isAlive = this.isPidAlive(config.pid)
      const residueType = isAlive ? 'ZOMBIE_OR_REUSED_PID' : 'CRASH_RESIDUE'
      logger.warn(
        LogCategory.SYSTEM,
        `[AISkillApi] 清理孤儿发现文件 (分类: ${residueType}, 原PID: ${config.pid}): ${this.configFilePath}`
      )
      fsSync.unlinkSync(this.configFilePath)
    } catch (err: any) {
      if (err.code !== 'ENOENT') {
        logger.warn(LogCategory.SYSTEM, '[AISkillApi] 启动期检查旧发现文件异常:', err)
      }
    }
  }

  private isPidAlive(pid: number): boolean {
    if (!pid || typeof pid !== 'number') return false
    try {
      process.kill(pid, 0)
      return true
    } catch (e: any) {
      return e.code === 'EPERM'
    }
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

    // 检查是否有粘性端口可复用 (38300 ~ 38319)
    let stickyPort: number | null = null
    try {
      if (this.configFilePath && fsSync.existsSync(this.configFilePath)) {
        const raw = fsSync.readFileSync(this.configFilePath, 'utf-8')
        const parsed = JSON.parse(raw)
        if (
          parsed.service === 'firefly-ai-skill-api' &&
          typeof parsed.port === 'number' &&
          parsed.port >= APP_PORTS.AI_SKILL_API &&
          parsed.port < APP_PORTS.AI_SKILL_API + 20 &&
          !this.isPidAlive(parsed.pid)
        ) {
          stickyPort = parsed.port
        }
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
      try {
        if (this.configFilePath && fsSync.existsSync(this.configFilePath)) {
          const raw = fsSync.readFileSync(this.configFilePath, 'utf-8')
          const parsed = JSON.parse(raw)
          if (parsed.service === 'firefly-ai-skill-api') {
            fsSync.unlinkSync(this.configFilePath)
          }
        }
      } catch {}

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
  }

  /**
   * Windows 文件锁退避原子写 (V1 Schema)
   */
  private async atomicPublishDiscoveryFile(): Promise<void> {
    if (!this.configFilePath) return
    const tmpPath = `${this.configFilePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    const config: AiSkillDiscoveryFileV1 = {
      schemaVersion: 1,
      service: 'firefly-ai-skill-api',
      host: '127.0.0.1',
      port: this.actualPort,
      baseUrl: `http://127.0.0.1:${this.actualPort}`,
      pid: process.pid,
      startedAt: (this.startedAt || new Date()).toISOString(),
      capabilities: EXTERNAL_API_CAPABILITIES
    }
    const payload = JSON.stringify(config, null, 2)
    await fs.writeFile(tmpPath, payload, 'utf-8')

    // Windows 文件锁指数退避重试 (20, 40, 80, 160, 320ms)
    const backoffs = [20, 40, 80, 160, 320]
    let renamed = false
    let lastRenameErr: any = null

    for (const delayMs of backoffs) {
      try {
        await fs.rename(tmpPath, this.configFilePath)
        renamed = true
        break
      } catch (err: any) {
        lastRenameErr = err
        if (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES') {
          await new Promise(r => setTimeout(r, delayMs))
        } else {
          break
        }
      }
    }

    if (!renamed) {
      try {
        await fs.unlink(tmpPath)
      } catch {}
      const err = new Error(
        `写入发现文件失败: ${lastRenameErr?.message || '重试耗尽'}`
      )
      ;(err as any).code = 'DISCOVERY_WRITE_FAILED'
      throw err
    }

    this.discoveryPresent = true
    logger.info(
      LogCategory.SYSTEM,
      `[AI Skill API] 已成功原子写出端口配置文件 (port: ${this.actualPort}): ${this.configFilePath}`
    )
  }

  private async removeConfigFile(): Promise<void> {
    if (!this.configFilePath) return
    try {
      await fs.unlink(this.configFilePath)
    } catch {
      // 文件不存在则忽略
    }
  }

  /**
   * 进程退出时的同步清理兜底 (DoD 10)
   */
  syncCleanupOnExit(): void {
    try {
      if (this.configFilePath && fsSync.existsSync(this.configFilePath)) {
        const raw = fsSync.readFileSync(this.configFilePath, 'utf-8')
        const parsed = JSON.parse(raw)
        if (parsed.service === 'firefly-ai-skill-api' && parsed.pid === process.pid) {
          fsSync.unlinkSync(this.configFilePath)
        }
      }
    } catch {}
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

  private safeDecodeURIComponent(str: string): string {
    const trimmed = str.trim().replace(/^["']|["']$/g, '')
    if (!/%[0-9a-fA-F]{2}/.test(trimmed)) return trimmed
    try {
      return decodeURIComponent(trimmed)
    } catch {
      return trimmed
    }
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

  private readBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      const buffers: Buffer[] = []
      req.on('data', (chunk: Buffer) => {
        buffers.push(chunk)
      })
      req.on('end', () => {
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

        reject(new Error('Invalid JSON body'))
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

      // 6. GET /api/health 纯内存健康检查 (支持自检探针快速放行)
      if (method === 'GET' && pathname === '/api/health') {
        this.sendSuccess(res, {
          status: 'ok',
          service: 'firefly-ai-skill-api',
          schemaVersion: 1,
          pid: process.pid,
          startedAt: this.startedAt?.toISOString() || null,
          apiVersion: '1.2.0',
          uptime: this.getUptimeSec()
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
        const status = await (analysisQueueService as any).getQueueStatus()
        this.sendSuccess(res, status)
        return true
      }

      if (method === 'GET' && pathname === '/api/analysis/progress') {
        this.recordBusinessRequest(req, pathname, res, isProbe)
        const progress = await (analysisQueueService as any).getProgress()
        this.sendSuccess(res, progress)
        return true
      }

      if (method === 'GET' && pathname === '/api/files/analysis-data') {
        this.recordBusinessRequest(req, pathname, res, isProbe)
        const fileId = query.fileId ? Number(query.fileId) : undefined
        const fields = query.fields ? (query.fields as string).split(',') : undefined
        const limit = Number(query.limit) || 20
        const offset = Number(query.offset) || 0

        if (fileId) {
          const file = await (databaseService as any).getFileAnalysisData(fileId, fields)
          if (!file) {
            this.sendError(res, 404, t('文件未找到'))
            return true
          }
          this.sendSuccess(res, this.filterInfrastructureFields(file))
          return true
        }

        const files = await (databaseService as any).getPagedFileAnalysisData(limit, offset, fields)
        this.sendSuccess(
          res,
          files.map((f: any) => this.filterInfrastructureFields(f))
        )
        return true
      }

      if (method === 'POST' && pathname === '/api/files/analysis-data-smart') {
        this.recordBusinessRequest(req, pathname, res, isProbe)
        const body = await this.readBody(req)
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

          const limit = Math.min(50, Math.max(1, Number(query.limit) || 20))
          const offset = Math.max(0, Number(query.offset) || 0)
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
            includeUnanalyzed: true,
            signal: abortController.signal
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
              const dtoItems = mapItemsToDTO(progRes?.items || [])
              if (phase === 'phase1') {
                await channel.sendEvent('phase1', {
                  phase: 1,
                  total: progRes?.total || dtoItems.length,
                  isSettled: false,
                  items: dtoItems
                })
              } else if (phase === 'phase2') {
                await channel.sendEvent('phase2', {
                  phase: 2,
                  total: progRes?.total || dtoItems.length,
                  isSettled: true,
                  clipPending: Boolean(progRes?.clipPending),
                  items: dtoItems
                })
              } else if (phase === 'phase3') {
                await channel.sendEvent('phase3', {
                  phase: 3,
                  total: progRes?.total || dtoItems.length,
                  isSettled: true,
                  items: dtoItems
                })
              }
            }

            try {
              if (virtualDirectoryService) {
                await virtualDirectoryService.getFilteredFilesPaged(params)
              } else {
                const { TagTreeQuery } =
                  await import('./filesystem/virtual-directory-service/TagTreeQuery')
                const tagTreeQuery = new TagTreeQuery((databaseService as any).getDb())
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
                const tagTreeQuery = new TagTreeQuery((databaseService as any).getDb())
                return await tagTreeQuery.getFilteredFilesPaged(params)
              }
            })()

            const raceResult = await Promise.race([searchPromise, timeoutPromise])
            const duration = Math.round(performance.now() - startTime)

            if (raceResult === 'timeout') {
              abortController.abort()
              const fallbackItems = lastProgressResult?.items || []
              this.sendSuccess(res, {
                total: lastProgressResult?.total || fallbackItems.length,
                isSettled: true,
                searchDurationMs: duration,
                degraded: true,
                degradedReasons: ['search_timeout'],
                items: mapItemsToDTO(fallbackItems)
              })
            } else {
              const searchRes = raceResult
              this.sendSuccess(res, {
                total: searchRes.total,
                isSettled: true,
                searchDurationMs: duration,
                degraded: false,
                degradedReasons: [],
                clipPending: Boolean((searchRes as any).clipPending),
                items: mapItemsToDTO(searchRes.items)
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
        const workspaceId = Number(query.workspaceId)
        const userInstruction = (query.userInstruction as string) || ''

        if (!workspaceId) throw new Error('Missing workspaceId')
        const ws = await databaseService.getWorkspaceDirectoryById(workspaceId)
        if (!ws) throw new Error('Workspace not found')

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
        const workspaceId = Number(query.workspaceId)
        if (!workspaceId) throw new Error('Missing workspaceId')

        if (!virtualDirectoryService) throw new Error('Virtual directory service not ready')
        const list = await virtualDirectoryService.list(workspaceId)
        this.sendSuccess(res, list)
        return true
      }

      if (method === 'POST' && pathname === '/api/organize/apply-plan') {
        this.recordBusinessRequest(req, pathname, res, isProbe)
        const body = await this.readBody(req)
        const rawName = body.name
        const rawStrategy = body.strategy

        if (!rawName) throw new Error('缺少必填字段: name')
        if (!rawStrategy) throw new Error('缺少必填字段: strategy')

        const name = this.safeDecodeURIComponent(rawName)
        const strategy = this.safeDecodeURIComponent(rawStrategy)
        const perspective = body.perspective ? this.safeDecodeURIComponent(body.perspective) : ''

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

      return false
    } catch (error: any) {
      logger.error(LogCategory.SYSTEM, `[AI Skill API] 处理请求失败: ${pathname}`, error)
      this.sendError(res, 500, error.message)
      return true
    }
  }

  private sendError(res: http.ServerResponse, statusCode: number, message: string) {
    try {
      res.statusCode = statusCode
      const payload = { success: false, error: message }
      const responseData = JSON.stringify(payload)
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Content-Length', Buffer.byteLength(responseData))
      res.end(responseData)
    } catch (error: any) {
      logger.error(LogCategory.SYSTEM, '[AI Skill API] 发送错误响应失败', error)
      if (!res.writableEnded) {
        res.statusCode = 500
        res.end(JSON.stringify({ success: false, error: t('响应序列化失败') }))
      }
    }
  }

  private sendSuccess(res: http.ServerResponse, data: any) {
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
