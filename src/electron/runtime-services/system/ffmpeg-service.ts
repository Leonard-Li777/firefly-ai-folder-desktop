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
   * 同步检测可用 FFmpeg (优先使用 extraResources/bin/ffmpeg 部署的二进制文件，与 Omni 共享统一资产)
   */
  public detectFfmpegSync(): string | null {
    const isWin = process.platform === 'win32'
    const exeName = isWin ? 'ffmpeg.exe' : 'ffmpeg'

    // 1. 优先通过 ResourceLocator 检索 extraResources/bin/ffmpeg 目录
    try {
      const { ResourceLocator } = require('../filesystem/virtual-directory-service/utils')
      const bin = ResourceLocator.resolveBin(`ffmpeg/${exeName}`) || ResourceLocator.resolveBin(exeName)
      if (bin && fs.existsSync(bin)) {
        return bin
      }
    } catch {}

    // 2. 多候选标准部署路径兜底检索 (开发环境与打包环境)
    const root = process.cwd()
    const candidates = [
      path.join(root, 'apps', 'desktop', 'build', 'extraResources', 'bin', 'ffmpeg', exeName),
      path.join(root, 'build', 'extraResources', 'bin', 'ffmpeg', exeName),
      path.join(root, 'apps', 'omni', 'build', 'extraResources', 'bin', 'ffmpeg', exeName),
      path.join(root, 'extraResources', 'bin', 'ffmpeg', exeName)
    ]

    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        return cand
      }
    }

    // 3. 检查应用数据 bin 目录 (userData/bin/ffmpeg)
    try {
      const userDataPath = app.getPath('userData')
      const localPath = path.join(userDataPath, 'bin', exeName)
      if (fs.existsSync(localPath)) {
        return localPath
      }
    } catch {}

    // 4. 检查系统 PATH 环境变量 (where / which)
    try {
      const command = isWin ? 'where ffmpeg' : 'which ffmpeg'
      const result = execSync(command).toString().trim().split('\n')[0]
      if (result && fs.existsSync(result)) {
        return result
      }
    } catch {}

    return null
  }

  /**
   * 获取 FFprobe 可执行文件路径
   */
  getFfprobePath(): string | null {
    const isWin = process.platform === 'win32'
    const exeName = isWin ? 'ffprobe.exe' : 'ffprobe'

    try {
      const { ResourceLocator } = require('../filesystem/virtual-directory-service/utils')
      const bin = ResourceLocator.resolveBin(`ffprobe/${exeName}`) || ResourceLocator.resolveBin(exeName)
      if (bin && fs.existsSync(bin)) {
        return toShortPathOnWindows(bin)
      }
    } catch {}

    const root = process.cwd()
    const candidates = [
      path.join(root, 'apps', 'desktop', 'build', 'extraResources', 'bin', 'ffprobe', exeName),
      path.join(root, 'build', 'extraResources', 'bin', 'ffprobe', exeName),
      path.join(root, 'apps', 'omni', 'build', 'extraResources', 'bin', 'ffprobe', exeName),
      path.join(root, 'extraResources', 'bin', 'ffprobe', exeName)
    ]

    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        return toShortPathOnWindows(cand)
      }
    }

    try {
      const userDataPath = app.getPath('userData')
      const localPath = path.join(userDataPath, 'bin', exeName)
      if (fs.existsSync(localPath)) {
        return toShortPathOnWindows(localPath)
      }
    } catch {}

    try {
      const command = isWin ? 'where ffprobe' : 'which ffprobe'
      const result = execSync(command).toString().trim().split('\n')[0]
      if (result && fs.existsSync(result)) {
        return toShortPathOnWindows(result)
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
}

export const ffmpegService = FfmpegService.getInstance()
