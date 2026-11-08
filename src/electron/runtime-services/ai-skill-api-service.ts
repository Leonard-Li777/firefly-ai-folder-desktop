import { t } from '@app/languages'
import * as http from 'node:http'
import * as fs from 'node:fs/promises'
import * as path from 'path'
import { BrowserWindow } from 'electron'
import { logger, LogCategory, APP_PORTS } from '@firefly/shared'
import * as iconv from 'iconv-lite'
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
  private reconcilePromise: Promise<void> | null = null
  private inFlightAbortControllers: Set<AbortController> = new Set()
  private activeSearchesCount = 0

  constructor(port: number = APP_PORTS.AI_SKILL_API, userDataPath?: string) {
    this.configuredPort = port
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
  }

  getActualPort(): number {
    return this.actualPort
  }

  isRunning(): boolean {
    return this.server !== null
  }

  async reconcile(): Promise<void> {
    if (this.reconcilePromise) {
      return this.reconcilePromise
    }

    this.reconcilePromise = (async () => {
      try {
        const { modularResourceService } = await import('./system/modular-resource-service')
        const modules = modularResourceService.listModules()
        const skillModule = modules.find(m => m.id === 'ai_organize_skill')
        const shouldRun = modularResourceService.processManager
          ? modularResourceService.processManager.isUsable('ai_organize_skill')
          : skillModule?.install_state === 'active'

        if (shouldRun) {
          if (!this.server) {
            try {
              await this.start()
            } catch (startErr: any) {
              logger.error(LogCategory.SYSTEM, '[AISkillApiService] 启动失败:', startErr)
              await modularResourceService.updateModuleState('ai_organize_skill', { active: false })
              throw startErr
            }
          }
        } else {
          if (this.server) {
            await this.stop()
          }
        }
      } catch (err) {
        logger.warn(LogCategory.SYSTEM, '[AISkillApiService] reconcile 异常:', err)
      } finally {
        this.reconcilePromise = null
      }
    })()

    return this.reconcilePromise
  }

  async start(): Promise<void> {
    if (this.server) return

    let currentPort = this.configuredPort
    let attempts = 0
    const maxAttempts = 20

    while (attempts < maxAttempts) {
      try {
        await new Promise<void>((resolve, reject) => {
          const server = http.createServer(async (req, res) => {
            const handled = await this.handleRequest(req, res)
            if (!handled && !res.writableEnded) {
              this.sendError(res, 404, t('接口不存在'))
            }
          })

          const onError = (err: any) => {
            server.off('listening', onListening)
            if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
              logger.warn(
                LogCategory.SYSTEM,
                `[AI Skill API] 端口 ${currentPort} 不可用 (${err.code})，准备尝试下一个端口 ${currentPort + 1}...`
              )
              currentPort++
              server.close()
              resolve()
            } else {
              logger.error(LogCategory.SYSTEM, '[AI Skill API] 服务启动未知错误', err)
              server.close()
              reject(err)
            }
          }

          const onListening = () => {
            server.off('error', onError)
            const addr = server.address()
            if (addr && typeof addr === 'object') {
              currentPort = addr.port
            }
            this.server = server
            this.actualPort = currentPort
            logger.info(
              LogCategory.SYSTEM,
              `[AI Skill API] 服务已独立启动，监听 http://127.0.0.1:${this.actualPort}`
            )
            this.writeConfigFile().catch(err =>
              logger.error(LogCategory.SYSTEM, '[AI Skill API] 写入配置文件失败', err)
            )
            resolve()
          }

          server.once('error', onError)
          server.once('listening', onListening)
          server.listen(currentPort, '127.0.0.1')
        })

        if (this.server) return
      } catch (err) {
        throw err
      }
      attempts++
    }

    // 若 20 个端口全部探测占满，采用 listen(0, '127.0.0.1') 动态随机端口终极兜底
    logger.warn(LogCategory.SYSTEM, '[AI Skill API] 预置端口段均不可用，尝试动态分配端口兜底...')
    await new Promise<void>((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        const handled = await this.handleRequest(req, res)
        if (!handled && !res.writableEnded) {
          this.sendError(res, 404, t('接口不存在'))
        }
      })

      server.once('error', reject)
      server.once('listening', () => {
        const addr = server.address()
        if (addr && typeof addr === 'object') {
          this.actualPort = addr.port
        }
        this.server = server
        logger.info(
          LogCategory.SYSTEM,
          `[AI Skill API] 动态兜底端口分配成功，监听 http://127.0.0.1:${this.actualPort}`
        )
        this.writeConfigFile().catch(err =>
          logger.error(LogCategory.SYSTEM, '[AI Skill API] 写入配置文件失败', err)
        )
        resolve()
      })
      server.listen(0, '127.0.0.1')
    })
  }

  async stop(): Promise<void> {
    await this.removeConfigFile()

    for (const controller of this.inFlightAbortControllers) {
      try {
        controller.abort()
      } catch {
        // ignore
      }
    }
    this.inFlightAbortControllers.clear()

    if (this.server) {
      const serverToClose = this.server
      this.server = null
      await new Promise<void>(resolve => {
        try {
          ;(serverToClose as any).closeAllConnections?.()
        } catch {
          // ignore
        }
        serverToClose.close(() => {
          logger.info(LogCategory.SYSTEM, '[AI Skill API] 服务已停止')
          resolve()
        })
      })
    }
  }

  private async writeConfigFile(): Promise<void> {
    if (!this.configFilePath) return
    const tmpPath = `${this.configFilePath}.tmp.${process.pid}.${Date.now()}`
    const config = {
      host: '127.0.0.1',
      port: this.actualPort,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      apiVersion: '1.2.0',
      capabilities: {
        progressiveSearch: true,
        videoSegments: true,
        organizeTemplates: true
      }
    }
    try {
      await fs.writeFile(tmpPath, JSON.stringify(config, null, 2), 'utf-8')
      await fs.rename(tmpPath, this.configFilePath)
      logger.info(
        LogCategory.SYSTEM,
        `[AI Skill API] 已成功写出端口配置文件 (port: ${this.actualPort}): ${this.configFilePath}`
      )
    } catch (err) {
      logger.error(LogCategory.SYSTEM, '[AI Skill API] 写入配置文件原子失败', err)
      try {
        await fs.unlink(tmpPath)
      } catch {
        // ignore
      }
    }
  }

  private async removeConfigFile(): Promise<void> {
    if (!this.configFilePath) return
    try {
      await fs.unlink(this.configFilePath)
    } catch {
      // 文件不存在则忽略
    }
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

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<boolean> {
    let pathname = ''
    try {
      // 1. Host 校验 (环回访问白名单)
      const hostHeader = (req.headers.host || '').trim()
      const [hostname] = hostHeader.split(':')
      if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
        this.sendError(res, 403, 'Forbidden: loopback access only')
        return true
      }

      // 2. Origin 校验 (防跨站恶意探测)
      const originHeader = req.headers.origin
      if (originHeader) {
        try {
          const u = new URL(originHeader)
          if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
            this.sendError(res, 403, 'Forbidden: cross-origin requests from non-loopback rejected')
            return true
          }
        } catch {
          this.sendError(res, 403, 'Forbidden: invalid origin')
          return true
        }
      }

      const parsedUrl = new URL(req.url || '', 'http://127.0.0.1')
      pathname = parsedUrl.pathname || ''
      const query = Object.fromEntries(parsedUrl.searchParams.entries())
      const method = req.method

      // 3. GET /api/health 纯内存健康检查
      if (method === 'GET' && pathname === '/api/health') {
        this.sendSuccess(res, {
          status: 'ok',
          pid: process.pid,
          apiVersion: '1.2.0',
          uptime: Math.round(process.uptime() * 10) / 10
        })
        return true
      }

      if (method === 'GET' && pathname === '/api/workspaces') {
        const workspaces = await databaseService.getAllWorkspaceDirectories()
        this.sendSuccess(res, workspaces)
        return true
      }

      if (method === 'GET' && pathname === '/api/analysis/queue-status') {
        const status = await analysisQueueService.getQueueStatus()
        this.sendSuccess(res, status)
        return true
      }

      if (method === 'GET' && pathname === '/api/analysis/progress') {
        const progress = await analysisQueueService.getProgress()
        this.sendSuccess(res, progress)
        return true
      }

      if (method === 'GET' && pathname === '/api/files/analysis-data') {
        const fileId = query.fileId ? Number(query.fileId) : undefined
        const fields = query.fields ? (query.fields as string).split(',') : undefined
        const limit = Number(query.limit) || 20
        const offset = Number(query.offset) || 0

        if (fileId) {
          const file = await databaseService.getFileAnalysisData(fileId, fields)
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
          files.map(f => this.filterInfrastructureFields(f))
        )
        return true
      }

      if (method === 'POST' && pathname === '/api/files/analysis-data-smart') {
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
            const channel = new SseChannel(res, () => abortController.abort())
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
                const tagTreeQuery = new TagTreeQuery(databaseService.getDb())
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
                const tagTreeQuery = new TagTreeQuery(databaseService.getDb())
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
                clipPending: Boolean(searchRes.clipPending),
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
        const workspaceId = Number(query.workspaceId)
        if (!workspaceId) throw new Error('Missing workspaceId')

        if (!virtualDirectoryService) throw new Error('Virtual directory service not ready')
        const list = await virtualDirectoryService.list(workspaceId)
        this.sendSuccess(res, list)
        return true
      }

      if (method === 'POST' && pathname === '/api/organize/apply-plan') {
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
