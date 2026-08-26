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

export type OmniGeoReversePoint =
  | { latitude: number; longitude: number }
  | { lat: number; lon: number }

export interface OmniGeoReverseItem {
  found: boolean
  country?: string
  province?: string
  admin1?: string
  admin2?: string
  city?: string
  distanceKm?: number
  formattedAddress?: string
}

export interface OmniGeoReverseResponse {
  available: boolean
  datasetVersion?: number
  reason?: string
  results?: OmniGeoReverseItem[]
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
      // 探活检查：如果 9190 端口上已有外部 omni 服务正常响应（例如开发模式独立运行的 omni:serve 或 omni:ui），则直接复用
      const isAlive = await this.checkHealth()
      if (isAlive) {
        logger.info(LogCategory.SYSTEM, `[OmniService] 检测到已在 9190 运行的 Omni 服务 (${this.baseUrl})，直接连接复用，避免重复启动冲突`)
        this.restartAttempts = 0
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

      child.on('exit', async (code, signal) => {
        logger.warn(LogCategory.SYSTEM, `[OmniService] 子进程退出 (code=${code}, signal=${signal})`)
        this.process = null
        // 子进程退出后，先检测是否 9190 上已有服务接管（如外部重启），若健康则直接接入，不触发重启
        const aliveAfterExit = await this.checkHealth()
        if (aliveAfterExit) {
          logger.info(LogCategory.SYSTEM, '[OmniService] 9190 端口已有外部服务接管，直接连接')
          this.restartAttempts = 0
          return
        }
        this.scheduleRestart()
      })

      this.process = child

      // 等待服务就绪探活
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 200))
        if (await this.checkHealth()) {
          logger.info(LogCategory.SYSTEM, `[OmniService] firefly-omni 服务就绪并在 ${this.baseUrl} 正常监听`)
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
  private async scheduleRestart(): Promise<void> {
    if (await this.checkHealth()) {
      logger.info(LogCategory.SYSTEM, '[OmniService] Omni 服务已在运行，跳过重启')
      this.restartAttempts = 0
      return
    }

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
   * 统一通过 Omni 引擎提取全量 ExifTool/媒体/文档元数据 (供属性面板与分析流水线使用)
   */
  public async extractMetadataFull(filePath: string): Promise<Record<string, any>> {
    const extResult = await this.extract(filePath)
    if (extResult && extResult.metadata && typeof extResult.metadata === 'object') {
      const meta = extResult.metadata
      const combined: Record<string, any> = {
        ...(meta.exiftool || {}),
        ...(meta.document || {}),
        ...(meta.image || {}),
        ...(meta.audio || {}),
        ...(meta.video || {}),
        ...(meta.basic || {}),
        ...meta
      }
      return combined
    }

    // 基础属性保底
    try {
      const stat = fs.statSync(filePath)
      return {
        FileSize: stat.size,
        FileCreateDate: stat.birthtime?.toISOString(),
        FileModifyDate: stat.mtime?.toISOString(),
        FileAccessDate: stat.atime?.toISOString(),
        FileTypeExtension: path.extname(filePath).replace(/^\./, '').toUpperCase()
      }
    } catch {
      return {}
    }
  }

  /**
   * GPS 经纬度逆地理编码: POST /api/geo/reverse (对接 omni-geo 微服务)
   */
  public async reverseGeo(
    pointsOrLat: OmniGeoReversePoint[] | number,
    lonOrLang?: number | string,
    optionalLang?: string
  ): Promise<OmniGeoReverseResponse | null> {
    try {
      let points: Array<{ latitude: number; longitude: number }> = []
      let language = 'zh-CN'

      if (typeof pointsOrLat === 'number') {
        const lat = pointsOrLat
        const lon = typeof lonOrLang === 'number' ? lonOrLang : 0
        language = typeof optionalLang === 'string' ? optionalLang : 'zh-CN'
        points = [{ latitude: lat, longitude: lon }]
      } else if (Array.isArray(pointsOrLat)) {
        language = typeof lonOrLang === 'string' ? lonOrLang : 'zh-CN'
        points = pointsOrLat.map(p => ({
          latitude: 'latitude' in p ? p.latitude : (p as any).lat,
          longitude: 'longitude' in p ? p.longitude : (p as any).lon
        }))
      }

      if (points.length === 0) return null

      const res = await fetch(`${this.baseUrl}/api/geo/reverse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          points,
          language,
          maxCityKm: 50,
          maxAnyKm: 500
        }),
        signal: AbortSignal.timeout(3000)
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
   * 获取多模态文件首页/关键帧高清封面图 (WebP/Image Buffer)
   * 接口: GET /api/cover?path=...
   * 支持 PDF, PSD, 视频 (MP4/MKV/MOV/AVI/WEBM), SVG, EPUB 等格式由 Omni Rust 引擎直接零拷贝渲染为 WebP
   * 不支持的格式服务端返回 204，此处直接返回 null 并平滑降级
   */
  public async getFileCover(filePath: string): Promise<Buffer | null> {
    try {
      const url = `${this.baseUrl}/api/cover?path=${encodeURIComponent(filePath)}`
      const res = await fetch(url, {
        signal: AbortSignal.timeout(10000)
      })

      // 204 表示不支持的格式或渲染不可用，静默降级
      if (res.status === 204 || !res.ok) {
        return null
      }

      const arrayBuffer = await res.arrayBuffer()
      return Buffer.from(arrayBuffer)
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] getFileCover 调用异常 (${filePath}):`, err.message)
      return null
    }
  }

  /**
   * 兼容别名：获取 PDF 封面图
   */
  public async getPdfCover(filePath: string): Promise<Buffer | null> {
    return this.getFileCover(filePath)
  }
}

export const omniService = OmniService.getInstance()

