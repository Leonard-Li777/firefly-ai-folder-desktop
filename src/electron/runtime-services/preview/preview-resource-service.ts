/**
 * 预览资源服务 (PreviewResourceService)
 * 托管 ff-preview:// 会话流式协议与生命周期挂载
 * 遵循规格书 docs/specs/file-previewer-engine-and-custom-extensions-spec.md (v1.2 §4)
 */

import { net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
import { logger, LogCategory } from '@firefly/shared'

export interface ActiveSessionEntry {
  filePath: string
  abortController: AbortController
  createdAt: number
}

export class PreviewResourceService {
  private static instance: PreviewResourceService | null = null
  private activeSessionMap = new Map<string, ActiveSessionEntry>()
  private isProtocolHandlerRegistered = false

  public static getInstance(): PreviewResourceService {
    if (!PreviewResourceService.instance) {
      PreviewResourceService.instance = new PreviewResourceService()
    }
    return PreviewResourceService.instance
  }

  /**
   * 挂载一个预览会话
   */
  mountSession(sessionId: string, filePath: string): boolean {
    if (!sessionId || !filePath) return false

    // 若旧 Session 存在，先 abort 并清理
    const oldEntry = this.activeSessionMap.get(sessionId)
    if (oldEntry) {
      try {
        oldEntry.abortController.abort()
      } catch {}
    }

    this.activeSessionMap.set(sessionId, {
      filePath,
      abortController: new AbortController(),
      createdAt: Date.now()
    })

    logger.debug(
      LogCategory.MAIN,
      `[PreviewResourceService] 已挂载会话: ${sessionId} -> ${filePath}`
    )
    return true
  }

  /**
   * 卸载一个预览会话并终止对应的数据流
   */
  unmountSession(sessionId: string): boolean {
    const entry = this.activeSessionMap.get(sessionId)
    if (!entry) return false

    try {
      entry.abortController.abort()
    } catch {}

    this.activeSessionMap.delete(sessionId)
    logger.debug(LogCategory.MAIN, `[PreviewResourceService] 已卸载会话: ${sessionId}`)
    return true
  }

  /**
   * 获取指定会话项（用于测试或诊断）
   */
  getSession(sessionId: string): ActiveSessionEntry | undefined {
    return this.activeSessionMap.get(sessionId)
  }

  /**
   * 获取当前全部活跃会话数量
   */
  getActiveSessionCount(): number {
    return this.activeSessionMap.size
  }

  /**
   * 核心请求路由与流式分发
   */
  async handleRequest(request: Request): Promise<Response> {
    try {
      // 处理 CORS OPTIONS 预检请求（沙箱 opaque origin 带 Range 时由 Chromium 发起）
      if (request.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
            'Access-Control-Allow-Headers': 'Range, Content-Type, Accept',
            'Access-Control-Max-Age': '86400'
          }
        })
      }

      const url = new URL(request.url)
      // 格式为: ff-preview://session/${sessionId}/stream
      const pathSegments = url.pathname.replace(/^\/+/, '').split('/')
      const sessionId = url.host === 'session' ? pathSegments[0] : pathSegments[1]

      if (!sessionId) {
        return new Response('Invalid Session URL format', {
          status: 400,
          headers: { 'Access-Control-Allow-Origin': '*' }
        })
      }

      const session = this.activeSessionMap.get(sessionId)
      if (!session) {
        return new Response('Preview Session Not Found or Expired', {
          status: 404,
          headers: { 'Access-Control-Allow-Origin': '*' }
        })
      }

      // 通过 Electron net.fetch 流式读取本地文件并转发 Range 头
      const fileUrl = pathToFileURL(session.filePath).toString()
      const fileResponse = await net.fetch(fileUrl, {
        headers: request.headers,
        signal: session.abortController.signal
      })

      const headers = new Headers(fileResponse.headers)
      // 强制注入 CORS 头，支持 null opaque origin
      headers.set('Access-Control-Allow-Origin', '*')
      headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
      headers.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges')
      headers.set('Accept-Ranges', 'bytes')

      return new Response(fileResponse.body, {
        status: fileResponse.status,
        statusText: fileResponse.statusText,
        headers
      })
    } catch (error: any) {
      logger.warn(LogCategory.MAIN, `[PreviewResourceService] 流式读取失败: ${error?.message}`)
      return new Response(error?.message || 'Internal Preview Stream Error', {
        status: 500,
        headers: { 'Access-Control-Allow-Origin': '*' }
      })
    }
  }

  /**
   * 初始化 ff-preview:// 协议流式处理器
   * 必须在 app.whenReady() 之后调用
   */
  initProtocolHandler(): void {
    if (this.isProtocolHandlerRegistered) return

    try {
      protocol.handle('ff-preview', async request => this.handleRequest(request))
      this.isProtocolHandlerRegistered = true
      logger.info(LogCategory.MAIN, '[PreviewResourceService] ff-preview:// 协议流式处理器注册成功')
    } catch (e: any) {
      logger.error(LogCategory.MAIN, `[PreviewResourceService] 协议处理器注册异常: ${e?.message}`)
    }
  }
}

export const previewResourceService = PreviewResourceService.getInstance()
