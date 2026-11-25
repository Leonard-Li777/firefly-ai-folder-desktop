import { app } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { execSync } from 'child_process'
import fixPath from 'fix-path'
import {
  logger,
  LogCategory,
  toShortPathOnWindows,
  getFfmpegPath,
  getFfprobePath
} from '@firefly/shared'
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
 * 统一使用 @firefly/shared 的 ResourceLocator 定位安装包内置的 extraResources/bin/ffmpeg，
 * 未命中时降级检索系统 PATH；不再依赖 @ffmpeg-installer/ffmpeg npm 包（已移除，避免装包体积翻倍）
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
   * 同步检测可用 FFmpeg (优先使用 extraResources/bin/ffmpeg 部署的二进制文件，与 Omni 共享统一资产)
   */
  public detectFfmpegSync(): string | null {
    // 1. 优先使用 @firefly/shared 导出的统一路径解析 (ResourceLocator 与 系统 PATH 探测)
    const resolved = getFfmpegPath()
    if (resolved) {
      return resolved
    }

    // 2. 检查应用数据 bin 目录 (userData/bin/ffmpeg)
    try {
      const isWin = process.platform === 'win32'
      const exeName = isWin ? 'ffmpeg.exe' : 'ffmpeg'
      const userDataPath = app.getPath('userData')
      const localPath = path.join(userDataPath, 'bin', exeName)
      if (fs.existsSync(localPath)) {
        return toShortPathOnWindows(localPath)
      }
    } catch {}

    return null
  }

  /**
   * 获取 FFprobe 可执行文件路径
   *
   * 2026-11-25 起 ffprobe 随包内置（lock.resources.ffprobe → extraResources/bin/ffprobe），
   * 与 ffmpeg 同源发布；此处的 userData 回退仅覆盖「精简/裁剪包」等非标准装配形态。
   */
  getFfprobePath(): string | null {
    // 1. 优先使用 @firefly/shared 导出的统一路径解析
    const resolved = getFfprobePath()
    if (resolved) {
      return resolved
    }

    // 2. 检查应用数据 bin 目录 (userData/bin/ffprobe)
    try {
      const isWin = process.platform === 'win32'
      const exeName = isWin ? 'ffprobe.exe' : 'ffprobe'
      const userDataPath = app.getPath('userData')
      const localPath = path.join(userDataPath, 'bin', exeName)
      if (fs.existsSync(localPath)) {
        return toShortPathOnWindows(localPath)
      }
    } catch {}

    return null
  }

  /**
   * 异步检测可用 FFmpeg
   */
  public async detectFfmpeg(): Promise<string | null> {
    return this.detectFfmpegSync()
  }

  /**
   * 异步检测 FFprobe 是否可用
   * 内置资产随包提供（lock.resources.ffprobe），返回可执行文件路径；被裁剪的环境返回 null，
   * 调用方（深度清理中心 ffprobe 门禁）据此置灰依赖 ffprobe 的能力，杜绝静默 0 结果。
   */
  public async detectFfprobe(): Promise<string | null> {
    return this.getFfprobePath()
  }
}

export const ffmpegService = FfmpegService.getInstance()
