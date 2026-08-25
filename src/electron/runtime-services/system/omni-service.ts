/**
 * Omni Native Service - Omni Rust 原生微服务管理器
 * apps/desktop/src/electron/runtime-services/system/omni-service.ts
 *
 * 核心职责：
 * 1. 负责 firefly-omni.exe 原生二进制子进程的拉起、常驻守护与健康探活
 * 2. 进程崩溃自动重启 (带指数退避) 与应用退出时的协同销毁
 * 3. 封装统一的 HTTP Client，对接 /api/extract, /api/cleanup/scan, /api/geo/reverse
 */

import { ChildProcess, spawn } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { app } from 'electron'
import { ResourceLocator, logger, LogCategory } from '@firefly/shared'
import { FileCategory } from '@firefly/types'

export interface OmniExtractionResponse {
  file_path: string
  mime_type: string
  file_size: number
  markdown_content?: string
  metadata?: Record<string, any>
  phash?: string
  is_corrupted?: boolean
}

export interface OmniGeoReversePoint {
  lat: number
  lon: number
}

export interface OmniGeoReverseResponse {
  results: Array<{
    country?: string
    admin1?: string
    admin2?: string
    city?: string
    distanceKm?: number
    formattedAddress?: string
  }>
}

export class OmniService {
  private static instance: OmniService
  private process: ChildProcess | null = null
  private baseUrl = 'http://127.0.0.1:9190'
  private isStarting = false
  private restartAttempts = 0
  private maxRestartAttempts = 10
  private restartTimeout: NodeJS.Timeout | null = null

  private constructor() {
    try {
      if (app && typeof app.on === 'function') {
        app.on('will-quit', () => {
          this.stop()
        })
      }
    } catch {}
  }

  public static getInstance(): OmniService {
    if (!OmniService.instance) {
      OmniService.instance = new OmniService()
    }
    return OmniService.instance
  }

  public getBaseUrl(): string {
    return this.baseUrl
  }

  /**
   * 定位 firefly-omni 可执行文件
   */
  public resolveOmniExecutable(): string | null {
    const isWin = process.platform === 'win32'
    const exeName = isWin ? 'firefly-omni.exe' : 'firefly-omni'

    // 1. 优先通过 ResourceLocator 检索
    const bin = ResourceLocator.resolveBin('omni/firefly-omni') || ResourceLocator.resolveBin('firefly-omni')
    if (bin && fs.existsSync(bin)) {
      return bin
    }

    // 2. 多候选路径兜底检索
    const root = process.cwd()
    const candidates = [
      path.join(root, 'apps', 'desktop', 'build', 'extraResources', 'bin', 'omni', exeName),
      path.join(root, 'apps', 'desktop', 'build', 'extraResources', 'bin', exeName),
      path.join(root, 'apps', 'omni', 'target', 'debug', exeName),
      path.join(root, 'apps', 'omni', 'target', 'release', exeName),
      path.join(root, 'build', 'extraResources', 'bin', 'omni', exeName)
    ]

    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        return cand
      }
    }

    return null
  }

  /**
   * 启动并守护 firefly-omni 子进程
   */
  public async start(): Promise<boolean> {
    if (this.process && !this.process.killed) {
      return true
    }

    if (this.isStarting) {
      return false
    }

    this.isStarting = true
    const exePath = this.resolveOmniExecutable()
    if (!exePath) {
      logger.warn(LogCategory.SYSTEM, '[OmniService] 未找到 firefly-omni 可执行二进制文件，跳过子进程托管')
      this.isStarting = false
      return false
    }

    try {
      // 探活检查：如果 9190 端口上已有外部 omni 服务正常响应，则直接复用
      const isAlive = await this.checkHealth()
      if (isAlive) {
        logger.info(LogCategory.SYSTEM, `[OmniService] 检测到外部已就绪的 Omni 服务 (${this.baseUrl})，直接连接`)
        this.isStarting = false
        return true
      }

      logger.info(LogCategory.SYSTEM, `[OmniService] 正在拉起 firefly-omni 守护进程: ${exePath}`)
      const env = { ...process.env }
      const child = spawn(exePath, ['serve', '-a', '127.0.0.1:9190'], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      })

      child.stdout?.on('data', data => {
        logger.debug(LogCategory.SYSTEM, `[Omni] ${data.toString().trim()}`)
      })

      child.stderr?.on('data', data => {
        logger.debug(LogCategory.SYSTEM, `[Omni:err] ${data.toString().trim()}`)
      })

      child.on('error', err => {
        logger.error(LogCategory.SYSTEM, '[OmniService] 子进程启动失败:', err)
      })

      child.on('exit', (code, signal) => {
        logger.warn(LogCategory.SYSTEM, `[OmniService] 子进程退出 (code=${code}, signal=${signal})`)
        this.process = null
        this.scheduleRestart()
      })

      this.process = child

      // 等待服务就绪探活
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 200))
        if (await this.checkHealth()) {
          logger.info(LogCategory.SYSTEM, `[OmniService] firefly-omni 服务已成功就绪 (${this.baseUrl})`)
          this.restartAttempts = 0
          this.isStarting = false
          return true
        }
      }

      this.isStarting = false
      return false
    } catch (err) {
      logger.error(LogCategory.SYSTEM, '[OmniService] 启动服务发生异常:', err)
      this.isStarting = false
      return false
    }
  }

  /**
   * 停止子进程
   */
  public stop(): void {
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout)
      this.restartTimeout = null
    }

    if (this.process) {
      try {
        this.process.kill()
        logger.info(LogCategory.SYSTEM, '[OmniService] 已终止 firefly-omni 子进程')
      } catch {}
      this.process = null
    }
  }

  /**
   * 指数退避自愈重启
   */
  private scheduleRestart(): void {
    if (this.restartAttempts >= this.maxRestartAttempts) {
      logger.error(LogCategory.SYSTEM, `[OmniService] 已达到最大重启重试次数 (${this.maxRestartAttempts})，停止自动重启`)
      return
    }

    const delay = Math.min(1000 * Math.pow(2, this.restartAttempts), 15000)
    this.restartAttempts++
    logger.info(LogCategory.SYSTEM, `[OmniService] 安排在 ${delay}ms 后尝试重启 Omni 服务 (第 ${this.restartAttempts} 次)...`)

    this.restartTimeout = setTimeout(() => {
      this.start().catch(err => {
        logger.error(LogCategory.SYSTEM, '[OmniService] 自动重启失败:', err)
      })
    }, delay)
  }

  /**
   * 服务健康探活
   */
  public async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1000) })
      return res.ok
    } catch {
      return false
    }
  }

  /**
   * 提取文件全量信息 (元数据, Magika, Markdown, EXIF, 音视频标签)
   */
  public async extract(filePath: string): Promise<OmniExtractionResponse | null> {
    try {
      const res = await fetch(`${this.baseUrl}/api/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file_path: filePath }),
        signal: AbortSignal.timeout(15000)
      })

      if (!res.ok) {
        return null
      }

      return (await res.json()) as OmniExtractionResponse
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] extract 调用异常 (${filePath}):`, err.message)
      return null
    }
  }

  /**
   * 获取 Magika 分类信息 (与历史 Node.js Magika 返回格式 100% 对齐)
   */
  public async identifyMagika(filePath: string): Promise<FileCategory | null> {
    const ext = path.extname(filePath).toLowerCase().replace('.', '')
    const extList = ext ? [ext] : []

    const extResult = await this.extract(filePath)
    if (extResult && extResult.metadata && extResult.metadata.magika) {
      const m = extResult.metadata.magika
      return {
        label: m.label || ext || 'bin',
        mime_type: m.mime_type || extResult.mime_type || 'application/octet-stream',
        group: m.group || (extResult.mime_type.startsWith('image/') ? 'image' : 'document'),
        description: m.description || m.name || '',
        extensions: Array.isArray(m.extensions) && m.extensions.length > 0 ? m.extensions : extList,
        is_text: m.is_text ?? (extResult.mime_type.startsWith('text/') || (extResult.markdown_content ? extResult.markdown_content.length > 0 : false)),
        score: typeof m.score === 'number' ? m.score : 0.99
      }
    }

    return null
  }

  /**
   * GPS 经纬度逆地理编码: POST /api/geo/reverse
   */
  public async reverseGeo(points: OmniGeoReversePoint[], language: string = 'zh-CN'): Promise<OmniGeoReverseResponse | null> {
    try {
      const res = await fetch(`${this.baseUrl}/api/geo/reverse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points, language }),
        signal: AbortSignal.timeout(5000)
      })

      if (!res.ok) {
        return null
      }

      return (await res.json()) as OmniGeoReverseResponse
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, '[OmniService] reverseGeo 调用异常:', err.message)
      return null
    }
  }

  /**
   * 获取文件首页高清封面图 (PNG Buffer)
   * 接口: GET /api/cover?path=...
   * 不支持的格式（非 PDF）服务端返回 204，此处直接返回 null
   */
  public async getPdfCover(filePath: string): Promise<Buffer | null> {
    try {
      const url = `${this.baseUrl}/api/cover?path=${encodeURIComponent(filePath)}`
      const res = await fetch(url, {
        signal: AbortSignal.timeout(10000)
      })

      // 204 表示不支持的格式或 pdftoppm 不可用，静默降级
      if (res.status === 204 || !res.ok) {
        return null
      }

      const arrayBuffer = await res.arrayBuffer()
      return Buffer.from(arrayBuffer)
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] getPdfCover 调用异常 (${filePath}):`, err.message)
      return null
    }
  }
}

export const omniService = OmniService.getInstance()

