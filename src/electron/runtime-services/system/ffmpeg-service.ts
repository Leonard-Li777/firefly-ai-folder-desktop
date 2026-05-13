import { app, dialog, shell } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { execSync } from 'child_process'
import fixPath from 'fix-path'
import { logger, LogCategory } from '@yonuc/shared'
import { t } from '@app/languages'
import * as unzipper from 'unzipper'
import { fileDownloadService } from './file-download-service'
import { nativeFetch } from '../utils/native-network'
import EventEmitter from 'events'

// 在 macOS 和 Linux 上修复 PATH 环境变量
if (process.platform !== 'win32') {
  try {
    const fixPathFunc = typeof fixPath === 'function' ? fixPath : (fixPath as any).default
    if (typeof fixPathFunc === 'function') {
      fixPathFunc()
    }
  } catch (e) {
    console.error('Failed to fix PATH in FfmpegService:', e)
  }
}

/**
 * FFmpeg 事件类型
 */
export enum FfmpegEvent {
  STATUS_CHANGED = 'ffmpeg:status-changed',
  INSTALL_PROGRESS = 'ffmpeg:install-progress',
  INSTALL_COMPLETE = 'ffmpeg:install-complete',
  INSTALL_ERROR = 'ffmpeg:install-error'
}

/**
 * FFmpeg 服务
 * 负责 FFmpeg 的检测、下载和路径管理
 */
export class FfmpegService extends EventEmitter {
  private static instance: FfmpegService | null = null
  private ffmpegPath: string | null = null
  private isDownloading: boolean = false

  private constructor() {
    super()
  }

  static getInstance(): FfmpegService {
    if (!FfmpegService.instance) {
      FfmpegService.instance = new FfmpegService()
    }
    return FfmpegService.instance
  }

  /**
   * 初始化 FFmpeg
   * 在应用启动时调用，检测或自动下载 FFmpeg
   */
  async initialize(): Promise<void> {
    logger.info(LogCategory.SYSTEM, '[FfmpegService] 正在初始化 FFmpeg...')

    // 1. 尝试查找已存在的 FFmpeg
    const foundPath = await this.detectFfmpeg()
    if (foundPath) {
      this.ffmpegPath = foundPath
      ;(globalThis as any)._yonuc_ffmpeg_path = foundPath // 同步到全局
      logger.info(LogCategory.SYSTEM, `[FfmpegService] 检测到 FFmpeg: ${foundPath}`)
      return
    }

    // 2. 如果未找到，启动自动静默下载
    logger.info(LogCategory.SYSTEM, '[FfmpegService] 未检测到 FFmpeg，准备开始自动下载...')
    this.install().catch(err => {
      logger.error(LogCategory.SYSTEM, '[FfmpegService] 自动下载任务启动失败:', err)
    })
  }

  /**
   * 获取 FFmpeg 可执行文件路径
   */
  getFfmpegPath(): string | null {
    return this.ffmpegPath
  }

  /**
   * 检测系统中是否存在 FFmpeg (公共接口)
   */
  async detectFfmpegStatus(): Promise<{ installed: boolean; path?: string; downloading: boolean }> {
    const foundPath = await this.detectFfmpeg()
    if (foundPath) {
      this.ffmpegPath = foundPath
      return { installed: true, path: foundPath, downloading: false }
    }
    return { installed: false, downloading: this.isDownloading }
  }

  /**
   * 检测系统中是否存在 FFmpeg
   */
  public async detectFfmpeg(): Promise<string | null> {
    // 1. 检查环境变量
    try {
      const command = process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg'
      const result = execSync(command).toString().trim().split('\n')[0]
      if (result && fs.existsSync(result)) {
        return result
      }
    } catch (e) {
      // 忽略错误，继续查找
    }

    // 2. 检查应用数据目录
    const localPath = this.getLocalFfmpegPath()
    if (fs.existsSync(localPath)) {
      return localPath
    }

    return null
  }

  /**
   * 获取本地存储 FFmpeg 的路径
   */
  private getLocalFfmpegPath(): string {
    const userDataPath = app.getPath('userData')
    const binFolder = path.join(userDataPath, 'bin')
    const extension = process.platform === 'win32' ? '.exe' : ''
    return path.join(binFolder, `ffmpeg${extension}`)
  }

  /**
   * 判定当前平台的 ffbinaries 标识
   */
  private getPlatformKey(): string {
    const platform = process.platform
    const arch = process.arch

    if (platform === 'win32') return arch === 'x64' ? 'windows-64' : 'windows-32'
    if (platform === 'darwin') return 'osx-64'
    if (platform === 'linux') return arch === 'arm64' ? 'linux-arm64' : 'linux-64'
    return 'windows-64'
  }

  /**
   * 下载并安装 FFmpeg
   */
  async install(): Promise<boolean> {
    if (this.isDownloading) return true
    this.isDownloading = true
    this.emit(FfmpegEvent.STATUS_CHANGED, { downloading: true })

    const localPath = this.getLocalFfmpegPath()
    const destFolder = path.dirname(localPath)
    const zipPath = localPath + '.zip'

    // 确保目录存在
    if (!fs.existsSync(destFolder)) {
      fs.mkdirSync(destFolder, { recursive: true })
    }

    try {
      const platformKey = this.getPlatformKey()
      const apiUrl = `https://ffbinaries.com/api/v1/version/latest`
      logger.info(LogCategory.SYSTEM, `[FfmpegService] 正在获取下载地址: ${apiUrl}`)
      
      const response = await nativeFetch(apiUrl)
      const data = response.data
      const downloadUrl = data.bin[platformKey]?.ffmpeg

      if (!downloadUrl) {
        throw new Error(`未找到平台 ${platformKey} 的下载地址`)
      }

      logger.info(LogCategory.SYSTEM, `[FfmpegService] 开始下载 FFmpeg: ${downloadUrl}`)

      const success = await fileDownloadService.download({
        url: downloadUrl,
        destPath: zipPath,
        onProgress: (p) => {
          this.emit(FfmpegEvent.INSTALL_PROGRESS, { 
            message: `正在下载 FFmpeg: ${p.percent}%`,
            percent: p.percent
          })
          if (Math.floor(p.percent) % 20 === 0) {
            logger.debug(LogCategory.SYSTEM, `[FfmpegService] 下载进度: ${p.percent}%`)
          }
        }
      })

      if (!success) {
        throw new Error(t('FFmpeg 文件下载失败或不完整'))
      }

      logger.info(LogCategory.SYSTEM, '[FfmpegService] 下载完成，正在解压...')

      await this.extractZip(zipPath, destFolder)

      if (fs.existsSync(localPath)) {
        this.ffmpegPath = localPath
        ;(globalThis as any)._yonuc_ffmpeg_path = localPath
        if (process.platform !== 'win32') {
          try {
            fs.chmodSync(this.ffmpegPath, '755')
          } catch (chmodErr) {
            logger.error(LogCategory.SYSTEM, '[FfmpegService] 设置执行权限失败:', chmodErr)
          }
        }
        logger.info(LogCategory.SYSTEM, `[FfmpegService] FFmpeg 安装成功: ${this.ffmpegPath}`)
        this.emit(FfmpegEvent.INSTALL_COMPLETE, { path: this.ffmpegPath })
        return true
      } else {
        throw new Error('解压后未找到 ffmpeg 二进制文件')
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err)
      logger.error(LogCategory.SYSTEM, '[FfmpegService] FFmpeg 安装失败:', err)
      this.emit(FfmpegEvent.INSTALL_ERROR, { error: errorMsg })
      return false
    } finally {
      // 始终清理 zip 文件
      if (fs.existsSync(zipPath)) {
        try {
          fs.unlinkSync(zipPath)
        } catch (e) {}
      }
      this.isDownloading = false
      this.emit(FfmpegEvent.STATUS_CHANGED, { downloading: false })
    }
  }

  private async extractZip(zipPath: string, destFolder: string): Promise<void> {
    return new Promise((resolve, reject) => {
      logger.info(LogCategory.SYSTEM, `[FfmpegService] 正在使用 unzipper 流式解压: ${zipPath}`)
      fs.createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: destFolder }))
        .on('close', resolve)
        .on('error', (e) => {
          logger.error(LogCategory.SYSTEM, '[FfmpegService] 解压失败:', e)
          reject(e)
        })
    })
  }
}

export const ffmpegService = FfmpegService.getInstance()
