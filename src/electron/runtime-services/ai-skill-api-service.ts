import { t } from '@app/languages'
import * as http from 'node:http'
import { parse as parseUrl } from 'node:url'
import * as fs from 'node:fs/promises'
import * as path from 'path'
import { BrowserWindow } from 'electron'
import { logger, LogCategory, findAvailablePort } from '@firefly/shared'
import * as iconv from 'iconv-lite'
import { databaseService } from './database/database-service'
import { analysisQueueService } from './analysis-queue-service'
import { organizeRealDirectoryService, virtualDirectoryService } from '../main/state'

export class AISkillApiService {
  private server: http.Server | null = null
  private configuredPort = 28686
  private actualPort = 0
  private configFilePath = ''

  constructor(port = 28686, userDataPath?: string) {
    this.configuredPort = port
    if (userDataPath) {
      this.configFilePath = path.join(userDataPath, 'ai-skill-config.json')
    }
  }

  getActualPort(): number {
    return this.actualPort
  }

  async start(): Promise<void> {
    if (this.server) return

    const port = await findAvailablePort(this.configuredPort)
    this.actualPort = port

    if (port !== this.configuredPort) {
      logger.warn(
        LogCategory.SYSTEM,
        `[AI Skill API] 配置端口 ${this.configuredPort} 被占用，实际使用端口 ${port}`
      )
    }

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res)
      })

      this.server.listen(port, '127.0.0.1', () => {
        // 当 configuredPort 为 0 时，操作系统会分配随机端口，需要更新 actualPort
        const addr = this.server?.address()
        if (addr && typeof addr === 'object') {
          this.actualPort = addr.port
        }
        logger.info(
          LogCategory.SYSTEM,
          `[AI Skill API] 服务已启动，监听 http://127.0.0.1:${this.actualPort}`
        )
        this.writeConfigFile().catch(err =>
          logger.error(LogCategory.SYSTEM, '[AI Skill API] 写入配置文件失败', err)
        )
        resolve()
      })

      this.server.on('error', err => {
        logger.error(LogCategory.SYSTEM, '[AI Skill API] 服务启动失败', err)
        reject(err)
      })
    })
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>(resolve => {
        this.server!.close(() => {
          this.server = null
          logger.info(LogCategory.SYSTEM, '[AI Skill API] 服务已停止')
          resolve()
        })
      })
    }
    await this.removeConfigFile()
  }

  private async writeConfigFile(): Promise<void> {
    if (!this.configFilePath) return
    const config = {
      port: this.actualPort,
      host: '127.0.0.1',
      startedAt: new Date().toISOString()
    }
    await fs.writeFile(this.configFilePath, JSON.stringify(config, null, 2), 'utf-8')
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
    // 去掉外层空格和引号（兼容一些客户端会在 encodeURIComponent 结果外加引号）
    const trimmed = str.trim().replace(/^["']|["']$/g, '')
    // 检测是否包含合法的百分号编码序列
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
        const hexDump = raw.length > 0 ? raw.subarray(0, 500).toString('hex') : '(empty)'
        logger.info(
          LogCategory.SYSTEM,
          `[AI Skill API] readBody 原始字节 (hex, 前500字节): ${hexDump} (总字节数: ${raw.length})`
        )
        const contentType = (req.headers['content-type'] || '').toLowerCase()
        const contentLength = req.headers['content-length'] || '(none)'
        logger.info(
          LogCategory.SYSTEM,
          `[AI Skill API] readBody Content-Type: ${contentType}, Content-Length: ${contentLength}`
        )

        if (!raw.length) {
          resolve({})
          return
        }

        let body: string
        // 如果 Content-Type 显式指定了 gbk / gb2312，优先使用 GBK 解码
        if (contentType.includes('gbk') || contentType.includes('gb2312')) {
          try {
            body = iconv.decode(raw, 'gbk')
            resolve(JSON.parse(body))
            return
          } catch {
            // 忽略，继续尝试 utf-8
          }
        }

        // 默认优先尝试 UTF-8 解码并解析 JSON
        try {
          body = raw.toString('utf-8')
          resolve(JSON.parse(body))
          return
        } catch {
          // UTF-8 解析失败时尝试 GBK
        }

        try {
          body = iconv.decode(raw, 'gbk')
          resolve(JSON.parse(body))
          return
        } catch {
          // GBK 解析也失败
        }

        reject(new Error('Invalid JSON body'))
      })
      req.on('error', reject)
    })
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    let pathname = ''
    try {
      const parsedUrl = parseUrl(req.url || '', true)
      pathname = parsedUrl.pathname || ''
      const query = parsedUrl.query
      logger.debug(LogCategory.SYSTEM, `[AI Skill API] 收到请求: ${req.method} ${pathname}`)
      const method = req.method

      // CORS 头（允许 OpenClaw Canvas 面板跨域访问）
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

      // 预检请求直接返回
      if (method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      res.setHeader('Content-Type', 'application/json; charset=utf-8')

      // API 路由
      if (method === 'GET' && pathname === '/api/workspaces') {
        logger.debug(LogCategory.SYSTEM, '[AI Skill API] 正在获取所有工作空间...')
        const list = await databaseService.getAllWorkspaceDirectories()
        logger.debug(LogCategory.SYSTEM, `[AI Skill API] 找到 ${list.length} 个工作空间`)
        return this.sendSuccess(res, { data: list })
      }

      if (method === 'GET' && pathname === '/api/analysis/queue-status') {
        const snapshot = analysisQueueService.getSnapshot()
        const currentItem = snapshot.items.find(i => i.id === snapshot.currentItemId)
        return this.sendSuccess(res, {
          systemIdle:
            !snapshot.running &&
            snapshot.items.every(i => i.status !== 'analyzing' && i.status !== 'pending'),
          queueLength: snapshot.items.filter(i => i.status === 'pending').length,
          currentProcessingFile: currentItem?.path
        })
      }

      if (method === 'GET' && pathname === '/api/analysis/progress') {
        const snapshot = analysisQueueService.getSnapshot()
        const analyzed = snapshot.items.filter(i => i.status === 'completed').length
        const total = snapshot.items.length
        const percentage = total > 0 ? (analyzed / total) * 100 : 0

        return this.sendSuccess(res, {
          isIdle: !snapshot.running,
          analysis: {
            status: snapshot.running ? 'processing' : 'idle',
            progressPercentage: percentage
          },
          organizePage: {
            status: 'idle', // 暂时不支持查询整理页面进度
            progressPercentage: 0
          }
        })
      }

      if (method === 'GET' && pathname === '/api/files/analysis-data') {
        const fileId = query.fileId as string
        const fieldsParam = query.fields as string
        const limit = Number(query.limit) || 10
        const offset = Number(query.offset) || 0

        const applyFilters = (item: any) => {
          let filtered = this.filterInfrastructureFields(item)
          if (fieldsParam) {
            const requestedFields = fieldsParam.split(',')
            const result: any = {}
            const fieldMap: Record<string, string> = {
              description: 'description',
              smartName: 'smartName',
              tags: 'dimensionTags',
              metadata: 'metadata',
              qualityScore: 'qualityScore',
              content: 'content'
            }
            requestedFields.forEach(f => {
              const fieldName = f.trim()
              const targetKey = fieldMap[fieldName]
              if (targetKey && filtered[targetKey] !== undefined) {
                result[fieldName] = filtered[targetKey]
              }
            })
            return result
          }
          return filtered
        }

        if (fileId) {
          const result = await databaseService.getFileAnalysisResult(fileId)
          if (!result) return this.sendError(res, 404, t('文件未找到'))
          return this.sendSuccess(res, applyFilters(result))
        } else {
          const files = await databaseService.getAllFiles(limit, offset)
          return this.sendSuccess(
            res,
            files.map(f => applyFilters(f))
          )
        }
      }

      if (method === 'GET' && pathname === '/api/files/search') {
        const keyword = query.keyword as string
        const workspaceId = query.workspaceId ? Number(query.workspaceId) : undefined
        const scope = (query.scope as string) || 'real'
        const virtualDirectoryId = query.virtualDirectoryId
          ? Number(query.virtualDirectoryId)
          : undefined
        const limit = Number(query.limit) || 20
        const offset = Number(query.offset) || 0

        const results: any[] = []

        if (scope === 'real' || scope === 'all') {
          const realResults = await databaseService.searchFilesFTS(keyword, workspaceId)
          results.push(...realResults.map(r => ({ ...r, scope: 'real' })))
        }

        if (scope === 'virtual' || scope === 'all') {
          const virtualResults = await databaseService.searchVirtualDirectoryFiles(
            keyword,
            virtualDirectoryId
          )
          results.push(...virtualResults.map(r => ({ ...r, scope: 'virtual' })))
        }

        return this.sendSuccess(res, results.slice(offset, offset + limit))
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

        return this.sendSuccess(res, {
          workspaceId,
          workspacePath: ws.path,
          fileCount,
          systemPrompt,
          userPrompt
        })
      }

      if (method === 'GET' && pathname === '/api/virtual-directories') {
        const workspaceId = Number(query.workspaceId)
        if (!workspaceId) throw new Error('Missing workspaceId')

        if (!virtualDirectoryService) throw new Error('Virtual directory service not ready')
        const list = await virtualDirectoryService.list(workspaceId)
        return this.sendSuccess(res, list)
      }

      if (method === 'POST' && pathname === '/api/organize/apply-plan') {
        const body = await this.readBody(req)
        const rawName = body.name
        const rawStrategy = body.strategy

        if (!rawName) throw new Error('缺少必填字段: name')
        if (!rawStrategy) throw new Error('缺少必填字段: strategy')

        // 安全解码 URI 编码的字段（兼容中文字段）
        const name = this.safeDecodeURIComponent(rawName)
        const strategy = this.safeDecodeURIComponent(rawStrategy)
        const perspective = body.perspective ? this.safeDecodeURIComponent(body.perspective) : ''

        const windows = BrowserWindow.getAllWindows()
        windows.forEach(w => {
          w.webContents.send('organize:apply-plan', { name, strategy, perspective })
        })

        logger.info(LogCategory.SYSTEM, `[AI Skill API] 整理方案已转发到渲染进程: ${name}`)

        return this.sendSuccess(res, {
          message: '整理方案已发送到整理页面'
        })
      }

      // 404
      return this.sendError(res, 404, t('未找到'))
    } catch (error: any) {
      logger.error(LogCategory.SYSTEM, `[AI Skill API] 处理请求失败: ${pathname}`, error)
      return this.sendError(res, 500, error.message)
    }
  }

  private sendError(res: http.ServerResponse, statusCode: number, message: string) {
    try {
      res.statusCode = statusCode
      const payload = { success: false, error: message }
      const responseData = JSON.stringify(payload)
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
