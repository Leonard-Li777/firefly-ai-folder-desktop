import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { execSync } from 'child_process'
import fixPath from 'fix-path'
import { logger, LogCategory, toShortPathOnWindows } from '@firefly/shared'
import { EventEmitter } from 'events'

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
 * FFmpeg 服务
 * 优先使用自带 pnpm 包 (@ffmpeg-installer/ffmpeg) 提供的 FFmpeg 可执行文件路径
 */
export class FfmpegService extends EventEmitter {
  private static instance: FfmpegService | null = null
  private ffmpegPath: string | null = null

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
   * 初始化 FFmpeg 服务
   * 在应用启动时检测自带及系统 FFmpeg
   */
  async initialize(): Promise<void> {
    logger.info(LogCategory.SYSTEM, '[FfmpegService] 正在检测自带及系统 FFmpeg...')
    const foundPath = await this.detectFfmpeg()
    if (foundPath) {
      this.ffmpegPath = foundPath
      ;(globalThis as any)._firefly_ffmpeg_path = foundPath
      logger.info(LogCategory.SYSTEM, `[FfmpegService] 检测到可用 FFmpeg: ${foundPath}`)
    } else {
      logger.warn(LogCategory.SYSTEM, '[FfmpegService] 未检测到可用 FFmpeg')
    }
  }

  /**
   * 获取 FFmpeg 可执行文件路径
   */
  getFfmpegPath(): string | null {
    if (!this.ffmpegPath) {
      const foundPath = this.detectFfmpegSync()
      if (foundPath) {
        this.ffmpegPath = foundPath
      }
    }
    return this.ffmpegPath ? toShortPathOnWindows(this.ffmpegPath) : null
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
    return { installed: false, downloading: false }
  }

  /**
   * 同步检测可用 FFmpeg (优先使用自带 @ffmpeg-installer/ffmpeg pnpm 包)
   */
  public detectFfmpegSync(): string | null {
    // 1. 优先检测自带 pnpm 包 (@ffmpeg-installer/ffmpeg)
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg')
      if (ffmpegInstaller && ffmpegInstaller.path && fs.existsSync(ffmpegInstaller.path)) {
        return ffmpegInstaller.path
      }
    } catch (e) {
      // 忽略错误，继续降级查找
    }

    // 2. 检查 PATH 环境变量 (where / which)
    try {
      const command = process.platform === 'win32' ? 'where ffmpeg' : 'which ffmpeg'
      const result = execSync(command).toString().trim().split('\n')[0]
      if (result && fs.existsSync(result)) {
        return result
      }
    } catch (e) {
      // 忽略错误
    }

    // 3. 检查应用数据 bin 目录 (userData/bin/ffmpeg)
    try {
      const userDataPath = app.getPath('userData')
      const binFolder = path.join(userDataPath, 'bin')
      const extension = process.platform === 'win32' ? '.exe' : ''
      const localPath = path.join(binFolder, `ffmpeg${extension}`)
      if (fs.existsSync(localPath)) {
        return localPath
      }
    } catch (e) {
      // 忽略错误
    }

    return null
  }

  /**
   * 异步检测可用 FFmpeg
   */
  public async detectFfmpeg(): Promise<string | null> {
    return this.detectFfmpegSync()
  }
}

export const ffmpegService = FfmpegService.getInstance()
