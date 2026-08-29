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

export interface OmniBenchmarkResponse {
  total_ms: number
  magika_ms?: number
  metadata_ms?: number
  text_ms?: number
  document_ms?: number
  ocr_ms?: number
  html_ms?: number
  thumbnail_ms?: number
}

export interface OmniExtractionResponse {
  file_path: string
  mime_type: string
  file_size: number
  markdown_content?: string
  metadata?: Record<string, any>
  phash?: string
  is_corrupted?: boolean
  benchmark?: OmniBenchmarkResponse
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
        app.on('before-quit', () => {
          this.stop()
        })
      }

      // 注册 Node.js 进程级退出事件（针对开发模式下 Ctrl+C 或终端被杀）
      const cleanExit = () => {
        this.stop()
      }
      process.once('exit', cleanExit)
      process.once('SIGINT', cleanExit)
      process.once('SIGTERM', cleanExit)
      if (process.platform === 'win32') {
        process.once('message', (msg: any) => {
          if (msg === 'shutdown') {
            this.stop()
          }
        })
      }

      // 监听 Desktop 端 OCR 与分析相关的 ConfigKey 变更，实时自动推送到 Omni
      import('../../config/config-orchestrator').then(({ ConfigOrchestrator }) => {
        const orchestrator = ConfigOrchestrator.getInstance()
        const ocrKeys = [
          'ENABLE_IMAGE_OCR',
          'ENABLE_DOCUMENT_OCR',
          'OCR_MODEL_SIZE',
          'MAX_DOCUMENT_OCR_FILE_SIZE',
          'MAX_CONTENT_SIZE_KB',
          'MAX_FILE_SIZE',
          'ANALYSIS_MODE',
          'REUSE_BASIC_ANALYSIS_DATA'
        ] as const
        ocrKeys.forEach(key => {
          orchestrator.onValueChange(key as any, () => {
            this.syncConfigFromDesktop().catch(() => {})
          })
        })
      }).catch(() => {})
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
        logger.info(LogCategory.SYSTEM, `[OmniService] 检测到已在 9190 运行的 Omni 服务 (${this.baseUrl})，直接连接复用，并同步最新配置`)
        this.restartAttempts = 0
        this.isStarting = false
        this.syncConfigFromDesktop().catch(() => {})
        return true
      }

      logger.info(LogCategory.SYSTEM, `[OmniService] 正在拉起 firefly-omni 守护进程: ${exePath}`)
      const env = { ...process.env }
      const child = spawn(exePath, ['serve', '-a', '127.0.0.1:9190'], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })

      const isCzkawkaDump = (str: string): boolean => {
        return (
          str.includes('DEBUG PRINT COMMON') ||
          str.includes('DEBUG PRINT MESSAGES') ||
          str.includes('Included paths(before optimization)') ||
          str.includes('Included files(optimized)') ||
          str.includes('Directories { included_directories')
        )
      }

      child.stdout?.on('data', data => {
        const str = data.toString().trim()
        if (str && !isCzkawkaDump(str)) {
          logger.debug(LogCategory.SYSTEM, `[Omni] ${str}`)
        }
      })

      child.stderr?.on('data', data => {
        const str = data.toString().trim()
        if (str && !isCzkawkaDump(str)) {
          logger.debug(LogCategory.SYSTEM, `[Omni:err] ${str}`)
        }
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
          // 探活就绪后，立即同步一次当前配置（ENABLE_IMAGE_OCR, OCR_MODEL_SIZE 等）
          this.syncConfigFromDesktop().catch(() => {})
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
    this.isStarting = false
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout)
      this.restartTimeout = null
    }

    if (this.process) {
      const pid = this.process.pid
      try {
        if (process.platform === 'win32' && pid) {
          try {
            const { execSync } = require('node:child_process')
            execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' })
          } catch {}
        }
        this.process.kill('SIGKILL')
        logger.info(LogCategory.SYSTEM, `[OmniService] 已彻底终止 firefly-omni 进程树 (PID=${pid})`)
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
   * 向 Omni 引擎同步最新配置 (ENABLE_IMAGE_OCR, ENABLE_DOCUMENT_OCR, OCR_MODEL_SIZE 等)
   */
  public async syncConfigFromDesktop(): Promise<boolean> {
    try {
      const { ConfigOrchestrator } = await import('../../config/config-orchestrator')
      const orchestrator = ConfigOrchestrator.getInstance()
      const enableImageOcr = orchestrator.getValue<boolean>('ENABLE_IMAGE_OCR') ?? false
      const enableOfficeCover = orchestrator.getValue<boolean>('ENABLE_OFFICE_COVER') ?? false
      const maxDocOcrItems = orchestrator.getValue<number>('MAX_DOCUMENT_OCR_ITEMS') ?? 0
      const ocrModelSize = (orchestrator.getValue<string>('OCR_MODEL_SIZE') || 'tiny').toLowerCase()
      const maxContentSizeKb = orchestrator.getValue<number>('MAX_CONTENT_SIZE_KB') ?? 30
      const maxFileSizeMb = orchestrator.getValue<number>('MAX_FILE_SIZE') ?? 100
      const analysisMode = (orchestrator.getValue<string>('ANALYSIS_MODE') || 'full').toLowerCase()
      const reuseBasic = orchestrator.getValue<boolean>('REUSE_BASIC_ANALYSIS_DATA') ?? true

      // 提取最新的受保护排除项清单 (来自 IGNORE_RULES 中 isCzkawka 标记)
      const { duplicateDetectionService } = await import('../filesystem')
      const excludedItems = duplicateDetectionService ? duplicateDetectionService.getProtectedExcludedItems() : []

      const payload = JSON.stringify({
        enable_office_cover: enableOfficeCover,
        max_document_ocr_items: maxDocOcrItems,
        enable_image_ocr: enableImageOcr,
        ocr_model_size: ocrModelSize,
        max_content_size_kb: maxContentSizeKb,
        max_file_size_mb: maxFileSizeMb,
        analysis_mode: analysisMode,
        reuse_basic_analysis_data: reuseBasic,
        excluded_items: excludedItems
      })

      const res = await fetch(`${this.baseUrl}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(3000)
      })

      if (res.ok) {
        logger.info(
          LogCategory.SYSTEM,
          `[OmniService] 已向 Omni 引擎同步配置: enable_office_cover=${enableOfficeCover}, max_document_ocr_items=${maxDocOcrItems}, enable_image_ocr=${enableImageOcr}, ocr_model_size=${ocrModelSize}, excluded_items_count=${excludedItems.length}`
        )
        return true
      }
      return false
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, '[OmniService] 同步配置到 Omni 引擎失败:', err.message)
      return false
    }
  }

  /**
   * 提取文件全量信息 (元数据, Magika, Markdown, EXIF, 音视频标签)
   */
  public async extract(filePath: string): Promise<OmniExtractionResponse | null> {
    const tStart = Date.now()
    const reqBody = { file_path: filePath }
    logger.debug(
      LogCategory.SYSTEM,
      `[OmniService] >>> POST /api/extract 请求发起:`,
      JSON.stringify(reqBody)
    )
    try {
      const res = await fetch(`${this.baseUrl}/api/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(120000)
      })

      if (!res.ok) {
        logger.warn(
          LogCategory.SYSTEM,
          `[OmniService] <<< POST /api/extract 响应异常: status=${res.status}, 耗时: ${Date.now() - tStart}ms`
        )
        return null
      }

      const json = (await res.json()) as OmniExtractionResponse
      logger.debug(
        LogCategory.SYSTEM,
        `[OmniService] <<< POST /api/extract 响应成功 (${filePath}, 耗时: ${Date.now() - tStart}ms):`,
        JSON.stringify(json)
      )
      return json
    } catch (err: any) {
      logger.warn(
        LogCategory.SYSTEM,
        `[OmniService] <<< POST /api/extract 调用失败 (${filePath}): 耗时: ${Date.now() - tStart}ms, 错误: ${err.message}`
      )
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
        ...(meta.image?.exif || {}),
        ...(meta.audio || {}),
        ...(meta.video || {}),
        ...(meta.font || {}),
        ...(meta.archive || {}),
        ...(meta.database || {}),
        ...(meta.model || {}),
        ...(meta.text_stats ? { text_stats: meta.text_stats } : {})
      }

      delete combined.exif

      // 仅保留非空业务元数据字段，彻底剔除 basic / text / category / magika / errors 等冗余副本
      delete combined.basic
      delete combined.text
      delete combined.category
      delete combined.magika
      delete combined.errors
      delete combined.exiftool
      delete combined.document
      delete combined.image
      delete combined.audio
      delete combined.video
      delete combined.font
      delete combined.archive
      delete combined.database
      delete combined.model

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
    const tStart = Date.now()
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

      const reqBody = {
        points,
        language,
        maxCityKm: 50,
        maxAnyKm: 500
      }
      logger.debug(
        LogCategory.SYSTEM,
        `[OmniService] >>> POST /api/geo/reverse 请求发起:`,
        JSON.stringify(reqBody)
      )

      const res = await fetch(`${this.baseUrl}/api/geo/reverse`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(3000)
      })

      if (!res.ok) {
        logger.warn(
          LogCategory.SYSTEM,
          `[OmniService] <<< POST /api/geo/reverse 响应异常: status=${res.status}, 耗时: ${Date.now() - tStart}ms`
        )
        return null
      }

      const json = (await res.json()) as OmniGeoReverseResponse
      logger.debug(
        LogCategory.SYSTEM,
        `[OmniService] <<< POST /api/geo/reverse 响应成功 (耗时: ${Date.now() - tStart}ms):`,
        JSON.stringify(json)
      )
      return json
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] <<< POST /api/geo/reverse 调用异常 (耗时: ${Date.now() - tStart}ms):`, err.message)
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
    const tStart = Date.now()
    try {
      const url = `${this.baseUrl}/api/cover?path=${encodeURIComponent(filePath)}`
      logger.debug(LogCategory.SYSTEM, `[OmniService] >>> GET /api/cover 请求发起 (${filePath})`)
      // Office 转换 (LibreOffice) 或复杂视频截帧可能需要一定冷启动时间，提供充足的 60 秒等待时间
      const res = await fetch(url, {
        signal: AbortSignal.timeout(60000)
      })

      // 204 表示不支持的格式或未开启 Office 封面配置，静默平滑降级
      if (res.status === 204 || !res.ok) {
        logger.debug(
          LogCategory.SYSTEM,
          `[OmniService] <<< GET /api/cover 响应 ${res.status} (未开启封面或不支持, 耗时: ${Date.now() - tStart}ms, ${filePath})`
        )
        return null
      }

      const arrayBuffer = await res.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)
      logger.debug(
        LogCategory.SYSTEM,
        `[OmniService] <<< GET /api/cover 响应成功 (${filePath}, 字节大小: ${buffer.length} B, 耗时: ${Date.now() - tStart}ms)`
      )
      return buffer
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] <<< GET /api/cover 调用异常 (${filePath}, 耗时: ${Date.now() - tStart}ms):`, err.message)
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

