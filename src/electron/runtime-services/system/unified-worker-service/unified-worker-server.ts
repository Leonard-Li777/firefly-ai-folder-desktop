/**
 * 统一常驻微服务 (Unified Worker Service) - 服务端实现
 * 在独立 Node.js / utilityProcess 子进程中常驻运行 HTTP 服务器
 */

import * as http from 'node:http'
import * as path from 'node:path'
import { WorkerHealthStatus } from './types'

export class UnifiedWorkerServer {
  private server: http.Server | null = null
  private port = 0
  private startTime = Date.now()
  private skillApiHandler:
    | ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>)
    | null = null

  constructor(port: number) {
    this.port = port
  }

  /**
   * 注册来自 AISkillApiService 的技能处理函数
   */
  public registerSkillHandler(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>
  ): void {
    this.skillApiHandler = handler
  }

  /**
   * 启动 HTTP 服务器（具备 EADDRINUSE 自动退避顺延自愈机制）
   */
  public async start(): Promise<number> {
    if (this.server) return this.port

    let currentPort = this.port
    let attempts = 0
    const maxAttempts = 20

    while (attempts < maxAttempts) {
      try {
        await new Promise<void>((resolve, reject) => {
          const server = http.createServer(async (req, res) => {
            await this.handleRequest(req, res)
          })

          const onError = (err: any) => {
            server.off('listening', onListening)
            if (err.code === 'EADDRINUSE') {
              console.warn(
                `[UnifiedWorkerServer] 端口 ${currentPort} 被占用 (EADDRINUSE)，准备尝试下一个端口 ${currentPort + 1}...`
              )
              currentPort++
              server.close()
              resolve()
            } else {
              console.error('[UnifiedWorkerServer] 常驻微服务启动未知错误:', err)
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
            this.port = currentPort
            console.log(
              `[UnifiedWorkerServer] 常驻微服务已启动，监听端口 http://127.0.0.1:${this.port}`
            )
            resolve()
          }

          server.once('error', onError)
          server.once('listening', onListening)
          server.listen(currentPort, '127.0.0.1')
        })

        if (this.server) {
          return this.port
        }
      } catch (err) {
        throw err
      }
      attempts++
    }

    throw new Error(`[UnifiedWorkerServer] 无法在连续 ${maxAttempts} 个端口内启动微服务`)
  }

  /**
   * 停止 HTTP 服务器
   */
  public async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>(resolve => {
        this.server!.close(() => {
          this.server = null
          console.log('[UnifiedWorkerServer] 常驻微服务已关闭')
          resolve()
        })
      })
    }
  }

  /**
   * 安全读取 Request Body
   */
  public readBody<T = any>(req: http.IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
      const buffers: Buffer[] = []
      req.on('data', chunk => buffers.push(chunk))
      req.on('end', () => {
        const raw = Buffer.concat(buffers)
        if (!raw.length) {
          resolve({} as T)
          return
        }
        try {
          resolve(JSON.parse(raw.toString('utf-8')))
        } catch {
          reject(new Error('Invalid JSON body'))
        }
      })
      req.on('error', reject)
    })
  }

  /**
   * 统一请求路由分发
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const parsedUrl = new URL(req.url || '', 'http://127.0.0.1')
    const pathname = parsedUrl.pathname || ''
    const method = (req.method || 'GET').toUpperCase()

    // 跨域 CORS 支持
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8')

    try {
      // 1. 健康检查路由
      if (method === 'GET' && pathname === '/api/health') {
        const healthStatus: WorkerHealthStatus = {
          status: 'ok',
          uptime: Math.floor((Date.now() - this.startTime) / 1000),
          memoryUsage: process.memoryUsage(),
          activeServices: {
            ocr: true,
            magika: true,
            exiftool: true,
            libreoffice: true,
            ffmpeg: true
          }
        }
        return this.sendSuccess(res, healthStatus)
      }

      // 2. OCR 文字识别接口
      if (method === 'POST' && pathname === '/api/extract/ocr') {
        const body = await this.readBody(req)
        const { filePath, imageBufferBase64, modelType } = body
        let input: string | Buffer = filePath
        if (imageBufferBase64) {
          input = Buffer.from(imageBufferBase64, 'base64')
        }
        if (!input)
          return this.sendError(res, 400, 'Missing filePath or imageBufferBase64 parameter')
        console.debug(
          `[UnifiedWorkerServer][debug] 触发 OCR 提取 API (${pathname}) - ${filePath ? 'file: ' + path.basename(filePath) : 'Base64 Buffer'}`
        )
        const { ocrService } = await import('./ocr-service')
        const result = await ocrService.recognize(input, { modelType })
        console.debug(
          `[UnifiedWorkerServer][debug] OCR 提取 API 返回 - textLen: ${result.text?.length || 0}, confidence: ${result.confidence}, duration: ${result.durationMs}ms`
        )
        return this.sendSuccess(res, result)
      }

      // 3. 文件类型识别接口 (Magika)
      if (method === 'POST' && pathname === '/api/extract/identify') {
        const body = await this.readBody(req)
        const { filePath } = body
        if (!filePath) return this.sendError(res, 400, 'Missing filePath parameter')
        console.debug(
          `[UnifiedWorkerServer][debug] 触发文件识别 API (${pathname}) - file: ${path.basename(filePath)}`
        )
        const { magikaWorkerService } = await import('./magika-worker-service')
        const result = await magikaWorkerService.identifyFile(filePath)
        console.debug(
          `[UnifiedWorkerServer][debug] 文件识别 API 返回 - label: ${result.label}, group: ${result.group}, mime: ${result.mime_type}`
        )
        return this.sendSuccess(res, result)
      }

      // 4. 元数据提取接口 (ExifTool)
      if (method === 'POST' && pathname === '/api/extract/metadata') {
        const body = await this.readBody(req)
        const { filePath } = body
        if (!filePath) return this.sendError(res, 400, 'Missing filePath parameter')
        console.debug(
          `[UnifiedWorkerServer][debug] 触发元数据提取 API (${pathname}) - file: ${path.basename(filePath)}`
        )
        const { exiftoolWorkerService } = await import('./exiftool-service')
        const result = await exiftoolWorkerService.extractMetadata(filePath)
        const keyCount = Object.keys(result || {}).length
        console.debug(
          `[UnifiedWorkerServer][debug] 元数据提取 API 返回 - 有效元数据字段数: ${keyCount}`
        )
        return this.sendSuccess(res, result)
      }

      // 5. 封面图片生成接口
      if (method === 'POST' && pathname === '/api/extract/cover-image') {
        const body = await this.readBody(req)
        const { filePath, outputCoverPath, options } = body
        if (!filePath || !outputCoverPath) {
          return this.sendError(res, 400, 'Missing filePath or outputCoverPath')
        }
        console.debug(
          `[UnifiedWorkerServer][debug] 触发封面生成 API (${pathname}) - file: ${path.basename(filePath)}`
        )
        const { mediaConvertService } = await import('./media-convert-service')
        const result = await mediaConvertService.generateDocumentPreview(
          filePath,
          outputCoverPath,
          options
        )
        console.debug(
          `[UnifiedWorkerServer][debug] 封面生成 API 返回 - coverPath: ${result.coverPath || '无'}, duration: ${result.durationMs}ms`
        )
        return this.sendSuccess(res, result)
      }

      // 6. 文档内容提取接口 (Anydoc)
      if (method === 'POST' && pathname === '/api/extract/text') {
        const body = await this.readBody(req)
        const { filePath, options } = body
        if (!filePath) return this.sendError(res, 400, 'Missing filePath parameter')
        console.debug(
          `[UnifiedWorkerServer][debug] 触发内容提取 API (${pathname}) - file: ${path.basename(filePath)}`
        )
        const { anydocService } = await import('../anydoc-service')
        const result = await anydocService.extract(filePath, options?.timeoutMs)
        console.debug(
          `[UnifiedWorkerServer][debug] 内容提取 API 返回 - contentLen: ${result.content?.length || 0}, assets: ${result.assets?.length || 0}`
        )
        return this.sendSuccess(res, result)
      }

      // 7. 尝试走 AI Skill 扩展路由处理器
      if (this.skillApiHandler) {
        const handledBySkill = await this.skillApiHandler(req, res)
        if (handledBySkill) return
      }

      // 404
      return this.sendError(res, 404, 'Endpoint Not Found')
    } catch (err: any) {
      console.error(`[UnifiedWorkerServer] 处理请求失败: ${pathname}`, err)
      return this.sendError(res, 500, err.message || 'Internal Server Error')
    }
  }

  public sendSuccess(res: http.ServerResponse, data: any): void {
    if (res.writableEnded) return
    res.statusCode = 200
    const payload =
      typeof data === 'object' && !Array.isArray(data)
        ? { success: true, ...data }
        : { success: true, data }
    const responseData = JSON.stringify(payload)
    res.setHeader('Content-Length', Buffer.byteLength(responseData))
    res.end(responseData)
  }

  public sendError(res: http.ServerResponse, statusCode: number, message: string): void {
    if (res.writableEnded) return
    res.statusCode = statusCode
    const payload = { success: false, error: message }
    const responseData = JSON.stringify(payload)
    res.setHeader('Content-Length', Buffer.byteLength(responseData))
    res.end(responseData)
  }
}
