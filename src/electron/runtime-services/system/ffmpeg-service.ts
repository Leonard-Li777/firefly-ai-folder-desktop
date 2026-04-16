import { app, dialog, shell } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { execSync } from 'child_process'
import fixPath from 'fix-path'

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
import { logger, LogCategory } from '@yonuc/shared'
import * as https from 'https'
import { t } from '@app/languages'
import { ProxyAgent } from 'undici'
import * as unzipper from 'unzipper'

/**
 * 全局代理状态管理 (利用 globalThis 跨模块共享)
 */
const getGlobalProxyState = () => {
  const g = globalThis as any;
  if (!g._yonuc_proxy_state) {
    g._yonuc_proxy_state = {
      useProxy: false,
      lastSwitchTime: 0,
      consecutiveErrors: 0
    };
  }
  return g._yonuc_proxy_state;
};

const SWITCH_COOLDOWN = 15000; // 15秒内不重复切换
const ERROR_THRESHOLD = 1;    // 1次网络错误即尝试切换

/**
 * 判断是否为网络连接相关的错误
 */
function isNetworkError(error: any): boolean {
  if (!error) return false;
  const msg = (error.message || '').toLowerCase();
  const code = error.code || '';
  
  return (
    msg.includes('timeout') ||
    msg.includes('fetch failed') ||
    msg.includes('und_err_connect_timeout') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('enotfound') ||
    msg.includes('etimedout') ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND'
  );
}

/**
 * FFmpeg 服务
 * 负责 FFmpeg 的检测、下载和路径管理
 */
export class FfmpegService {
  private static instance: FfmpegService | null = null
  private ffmpegPath: string | null = null
  private isDownloading: boolean = false

  private constructor() {}

  static getInstance(): FfmpegService {
    if (!FfmpegService.instance) {
      FfmpegService.instance = new FfmpegService()
    }
    return FfmpegService.instance
  }

  /**
   * 初始化 FFmpeg
   * 在应用启动时调用，检测或下载 FFmpeg
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

    // 2. 如果未找到，尝试静默下载
    logger.info(LogCategory.SYSTEM, '[FfmpegService] 未检测到 FFmpeg，准备开始静默下载...')
    this.downloadFfmpeg().catch(err => {
      logger.error(LogCategory.SYSTEM, '[FfmpegService] 下载任务启动失败:', err)
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
   * 下载 FFmpeg
   */
  private async downloadFfmpeg(): Promise<void> {
    if (this.isDownloading) return
    this.isDownloading = true

    const localPath = this.getLocalFfmpegPath()
    const destFolder = path.dirname(localPath)

    // 确保目录存在
    if (!fs.existsSync(destFolder)) {
      fs.mkdirSync(destFolder, { recursive: true })
    }

    try {
      const platformKey = this.getPlatformKey()
      const apiUrl = `https://ffbinaries.com/api/v1/version/latest`

      logger.info(LogCategory.SYSTEM, `[FfmpegService] 正在从 API 获取下载地址: ${apiUrl}`)

      const apiResponse = await this.httpGet(apiUrl)
      const data = JSON.parse(apiResponse)
      const downloadUrl = data.bin[platformKey]?.ffmpeg

      if (!downloadUrl) {
        throw new Error(`未找到平台 ${platformKey} 的下载地址`)
      }

      logger.info(LogCategory.SYSTEM, `[FfmpegService] 开始下载 FFmpeg: ${downloadUrl}`)

      const zipPath = localPath + '.zip'
      await this.downloadFile(downloadUrl, zipPath)

      logger.info(LogCategory.SYSTEM, '[FfmpegService] 下载完成，正在解压...')

      await this.extractZip(zipPath, destFolder)

      if (fs.existsSync(localPath)) {
        this.ffmpegPath = localPath
        ;(globalThis as any)._yonuc_ffmpeg_path = localPath // 同步到全局
        // 设置执行权限 (非 Windows)
        if (process.platform !== 'win32') {
          try {
            fs.chmodSync(this.ffmpegPath, '755')
          } catch (chmodErr) {
            logger.error(LogCategory.SYSTEM, '[FfmpegService] 设置执行权限失败:', chmodErr)
          }
        }
        logger.info(LogCategory.SYSTEM, `[FfmpegService] FFmpeg 安装成功: ${this.ffmpegPath}`)
      } else {
        throw new Error('解压后未找到 ffmpeg 二进制文件')
      }

      // 清理 zip
      if (fs.existsSync(zipPath)) {
        fs.unlinkSync(zipPath)
      }
    } catch (err) {
      logger.error(LogCategory.SYSTEM, '[FfmpegService] FFmpeg 自动安装失败:', err)
      this.showDownloadErrorDialog()
    } finally {
      this.isDownloading = false
    }
  }

  private async httpGet(url: string): Promise<string> {
    const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
    const agent = proxy ? new ProxyAgent(proxy) : undefined;
    const state = getGlobalProxyState();

    const execute = async (useProxy: boolean): Promise<string> => {
      const response = await fetch(url, {
        dispatcher: useProxy ? agent : undefined,
        redirect: 'follow'
      });
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return await response.text();
    };

    try {
      return await execute(state.useProxy);
    } catch (err: any) {
      if (isNetworkError(err) && agent) {
        const now = Date.now();
        if (now - state.lastSwitchTime > SWITCH_COOLDOWN) {
          state.useProxy = !state.useProxy;
          state.lastSwitchTime = now;
          logger.warn(LogCategory.SYSTEM, `[FfmpegService] HTTP GET 网络异常，切换连接模式至: ${state.useProxy ? '代理' : '直连'}`, { error: err.message });
          return await execute(state.useProxy);
        }
      }
      throw err;
    }
  }

  private async downloadFile(url: string, dest: string): Promise<void> {
    const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;
    const agent = proxy ? new ProxyAgent(proxy) : undefined;
    const state = getGlobalProxyState();

    const execute = async (useProxy: boolean): Promise<void> => {
      const response = await fetch(url, {
        dispatcher: useProxy ? agent : undefined,
        redirect: 'follow'
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      if (!response.body) {
        throw new Error('Response body is empty');
      }

      const fileStream = fs.createWriteStream(dest);
      const reader = response.body.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          fileStream.write(Buffer.from(value));
        }
      } finally {
        fileStream.end();
      }

      return new Promise((resolve, reject) => {
        fileStream.on('finish', resolve);
        fileStream.on('error', reject);
      });
    };

    try {
      await execute(state.useProxy);
    } catch (err: any) {
      if (isNetworkError(err) && agent) {
        const now = Date.now();
        if (now - state.lastSwitchTime > SWITCH_COOLDOWN) {
          state.useProxy = !state.useProxy;
          state.lastSwitchTime = now;
          logger.warn(LogCategory.SYSTEM, `[FfmpegService] 文件下载网络异常，切换连接模式至: ${state.useProxy ? '代理' : '直连'}`, { error: err.message });
          return await execute(state.useProxy);
        }
      }
      throw err;
    }
  }

  private async extractZip(zipPath: string, destFolder: string): Promise<void> {
    try {
      logger.info(LogCategory.SYSTEM, `[FfmpegService] 正在使用 unzipper 解压: ${zipPath}`)
      const directory = await unzipper.Open.file(zipPath)
      await directory.extract({ path: destFolder })
    } catch (e) {
      logger.error(LogCategory.SYSTEM, '[FfmpegService] 解压失败:', e)
      throw e
    }
  }

  /**
   * 显示下载失败的提示框
   */
  private showDownloadErrorDialog(): void {
    dialog
      .showMessageBox({
        type: 'error',
        title: t('FFmpeg 安装失败'),
        message: t('无法自动安装音频处理组件 FFmpeg，这将导致无法进行音频文件分析。'),
        detail: t(
          '建议您手动安装 FFmpeg 并将其添加到系统环境变量中，或访问 https://ffbinaries.com 下载。'
        ),
        buttons: [t('了解'), t('前往下载页面')],
        defaultId: 1
      })
      .then(({ response }) => {
        if (response === 1) {
          shell.openExternal('https://ffbinaries.com/downloads')
        }
      })
  }
}

export const ffmpegService = FfmpegService.getInstance()
