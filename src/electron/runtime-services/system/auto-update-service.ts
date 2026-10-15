import { app, BrowserWindow, shell } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import * as crypto from 'crypto'
import * as https from 'https'
import * as http from 'http'
import semver from 'semver'
import { autoUpdater, UpdateInfo } from 'electron-updater'
import { logger, LogCategory, isTestEnvironment } from '@firefly/shared'
import { resolveAppRegion } from '../../main/worktree-env'

export type UpdateTrack = 'r2' | 'github'
export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'

export interface UpdateProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  latestVersion: string | null
  minVersion: string | null
  isMandatory: boolean
  progress: UpdateProgress | null
  error: string | null
  currentTrack: UpdateTrack
  downloadedFilePath: string | null
  releaseNotes: string | null
  releaseDate: string | null
}

export class AutoUpdateService {
  private static instance: AutoUpdateService | null = null

  private state: UpdateState = {
    status: 'idle',
    currentVersion: '4.0.0',
    latestVersion: null,
    minVersion: null,
    isMandatory: false,
    progress: null,
    error: null,
    currentTrack: 'r2',
    downloadedFilePath: null,
    releaseNotes: null,
    releaseDate: null
  }

  private isInitialized = false
  private isChecking = false
  private hasTriedFailover = false
  private isFullDownloadFallback = false
  private activeUpdateInfo: (UpdateInfo & { minVersion?: string }) | null = null

  private readonly R2_BASE_URL = 'https://download.iocn.cn/firefly-ai-folder'
  private readonly GITHUB_OWNER = 'Leonard-Li777'
  private readonly GITHUB_REPO = 'firefly-ai-folder-desktop'
  private readonly PROBE_TIMEOUT_MS = 2500

  private pollTimer: NodeJS.Timeout | null = null
  private readonly POLL_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4 小时轮询一次

  private constructor() {
    try {
      this.state.currentVersion = app.getVersion()
    } catch {
      this.state.currentVersion = '4.0.0'
    }

    const region = resolveAppRegion()
    this.state.currentTrack = region === 'intl' ? 'github' : 'r2'
  }

  public static getInstance(): AutoUpdateService {
    if (!AutoUpdateService.instance) {
      AutoUpdateService.instance = new AutoUpdateService()
    }
    return AutoUpdateService.instance
  }

  public static setInstanceForTesting(instance: AutoUpdateService | null): void {
    AutoUpdateService.instance = instance
  }

  /**
   * 初始化自动更新监听器与配置
   */
  public initialize(): void {
    if (this.isInitialized || isTestEnvironment()) {
      return
    }
    this.isInitialized = true

    // 配置 electron-updater 基础选项
    autoUpdater.autoDownload = false // 静默发现后由状态机控制下载
    autoUpdater.autoInstallOnAppQuit = true // 默认允许用户退出应用时自动应用更新
    autoUpdater.disableWebInstaller = true
    autoUpdater.logger = {
      info: (msg: any) => logger.info(LogCategory.SYSTEM, `[AutoUpdater] ${msg}`),
      warn: (msg: any) => logger.warn(LogCategory.SYSTEM, `[AutoUpdater] ${msg}`),
      error: (msg: any) => logger.error(LogCategory.SYSTEM, `[AutoUpdater] ${msg}`)
    }

    this.setupUpdaterListeners()
    this.configureFeedUrl(this.state.currentTrack)

    // 延迟 5 秒后静默触发首次更新检查，避免与应用冷启动抢占网络和 CPU
    setTimeout(() => {
      this.checkForUpdates(false).catch(err => {
        logger.warn(LogCategory.SYSTEM, '[AutoUpdater] 启动时静默检查更新失败:', err)
      })
    }, 5000)

    // 启动 4 小时周期性静默轮询更新 (Spec L74/L218)
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
    }
    this.pollTimer = setInterval(() => {
      logger.info(LogCategory.SYSTEM, '[AutoUpdater] 触发周期性静默更新检查 (4小时间隔)...')
      this.checkForUpdates(false).catch(err => {
        logger.warn(LogCategory.SYSTEM, '[AutoUpdater] 周期性静默检查更新失败:', err)
      })
    }, this.POLL_INTERVAL_MS)
  }

  /**
   * 获取当前更新状态副本
   */
  public getState(): UpdateState {
    return { ...this.state }
  }

  /**
   * 配置下载源 Feed URL
   */
  public configureFeedUrl(track: UpdateTrack): void {
    this.state.currentTrack = track
    const channel = resolveAppRegion()

    try {
      if (track === 'r2') {
        autoUpdater.setFeedURL({
          provider: 'generic',
          url: this.R2_BASE_URL,
          channel
        })
        logger.info(LogCategory.SYSTEM, `[AutoUpdater] 已切换更新源至 R2: ${this.R2_BASE_URL} (channel=${channel})`)
      } else {
        autoUpdater.setFeedURL({
          provider: 'github',
          owner: this.GITHUB_OWNER,
          repo: this.GITHUB_REPO,
          channel
        })
        logger.info(
          LogCategory.SYSTEM,
          `[AutoUpdater] 已切换更新源至 GitHub Releases: ${this.GITHUB_OWNER}/${this.GITHUB_REPO} (channel=${channel})`
        )
      }
    } catch (err: any) {
      logger.error(LogCategory.SYSTEM, `[AutoUpdater] 配置 FeedURL 失败: ${err.message}`)
    }
  }

  /**
   * 检查网络连通性探针（2500ms 硬超时）
   */
  public async probeEndpoint(track: UpdateTrack): Promise<boolean> {
    const channel = resolveAppRegion()
    const probeUrl =
      track === 'r2'
        ? `${this.R2_BASE_URL}/${channel}.yml`
        : `https://github.com/${this.GITHUB_OWNER}/${this.GITHUB_REPO}/releases`

    return new Promise<boolean>(resolve => {
      let isResolved = false
      const client = probeUrl.startsWith('https') ? https : http

      const timer = setTimeout(() => {
        if (!isResolved) {
          isResolved = true
          logger.warn(LogCategory.SYSTEM, `[AutoUpdater] 探针超时 (${this.PROBE_TIMEOUT_MS}ms): ${probeUrl}`)
          resolve(false)
        }
      }, this.PROBE_TIMEOUT_MS)

      try {
        const req = client.request(probeUrl, { method: 'HEAD', timeout: this.PROBE_TIMEOUT_MS }, res => {
          res.resume()
          req.destroy()
          if (!isResolved) {
            isResolved = true
            clearTimeout(timer)
            const statusCode = res.statusCode || 0
            // 2xx 或 3xx 或 404 (说明域已连通) 均视为网络通畅
            resolve(statusCode > 0 && statusCode < 500)
          }
        })

        req.on('error', err => {
          req.destroy()
          if (!isResolved) {
            isResolved = true
            clearTimeout(timer)
            logger.warn(LogCategory.SYSTEM, `[AutoUpdater] 探针网络错误: ${err.message} (${probeUrl})`)
            resolve(false)
          }
        })

        req.on('timeout', () => {
          req.destroy()
        })

        req.end()
      } catch {
        if (!isResolved) {
          isResolved = true
          clearTimeout(timer)
          resolve(false)
        }
      }
    })
  }

  /**
   * 触发更新检查
   * @param manual 是否为用户主动点击触发（手动触发会在界面显示 loading 与明确提示）
   */
  public async checkForUpdates(manual = false): Promise<UpdateState> {
    if (this.isChecking) {
      return this.getState()
    }

    this.isChecking = true
    this.updateState({
      status: 'checking',
      error: null
    })

    try {
      // 探针健康预检：首选源不可达且尚未探查时，静默快速平滑降级
      const isAlive = await this.probeEndpoint(this.state.currentTrack)
      if (!isAlive && !this.hasTriedFailover) {
        const fallbackTrack: UpdateTrack = this.state.currentTrack === 'r2' ? 'github' : 'r2'
        logger.warn(
          LogCategory.SYSTEM,
          `[AutoUpdater] 首选源 ${this.state.currentTrack} 探针不通，平滑降级至备用源 ${fallbackTrack}`
        )
        this.hasTriedFailover = true
        this.configureFeedUrl(fallbackTrack)
      }

      await autoUpdater.checkForUpdates()
    } catch (err: any) {
      logger.error(LogCategory.SYSTEM, '[AutoUpdater] 检查更新异常:', err)
      await this.handleUpdateError(err, 'check', manual)
    } finally {
      this.isChecking = false
    }

    return this.getState()
  }

  /**
   * 开始下载可用更新包
   */
  public async startDownload(): Promise<void> {
    if (this.state.status === 'downloading') {
      return
    }

    if (!this.activeUpdateInfo) {
      logger.warn(LogCategory.SYSTEM, '[AutoUpdater] 没有可下载的更新元数据，重新触发检查')
      await this.checkForUpdates(true)
      return
    }

    // 检查本地缓存中是否已存在有效安装包（复用防重下）
    const cachedFilePath = await this.verifyLocalCachedInstaller(this.activeUpdateInfo)
    if (cachedFilePath) {
      logger.info(LogCategory.SYSTEM, `[AutoUpdater] 命中本地完整安装包缓存，跳过下载: ${cachedFilePath}`)
      this.updateState({
        status: 'downloaded',
        downloadedFilePath: cachedFilePath,
        progress: {
          percent: 100,
          transferred: fs.statSync(cachedFilePath).size,
          total: fs.statSync(cachedFilePath).size,
          bytesPerSecond: 0
        }
      })
      return
    }

    this.updateState({
      status: 'downloading',
      error: null
    })

    try {
      await autoUpdater.downloadUpdate()
    } catch (err: any) {
      logger.error(LogCategory.SYSTEM, '[AutoUpdater] 下载更新异常:', err)
      await this.handleUpdateError(err, 'download')
    }
  }

  /**
   * 退出应用并安装更新（包含四步优雅关停与释放锁机制）
   */
  public async quitAndInstall(): Promise<void> {
    logger.info(LogCategory.SYSTEM, '[AutoUpdater] 用户触发立即重启安装，启动四步优雅关停握手...')
    this.updateState({ status: 'installing' })

    // 非 Windows 平台（macOS DMG 或 Linux DEB/RPM）：打开安装包引导用户覆盖安装
    if (process.platform !== 'win32') {
      if (this.state.downloadedFilePath && fs.existsSync(this.state.downloadedFilePath)) {
        logger.info(LogCategory.SYSTEM, `[AutoUpdater] 跨平台打开安装包: ${this.state.downloadedFilePath}`)
        await shell.openPath(this.state.downloadedFilePath)
      }
      return
    }

    // Windows 平台：四步彻底关停
    try {
      // 步骤 1: SQLite WAL 刷盘并关闭持久连接
      try {
        const { databaseService } = require('../database/database-service')
        const db = databaseService?.db
        if (db) {
          logger.info(LogCategory.SYSTEM, '[AutoUpdater] 优雅停机 Step 1: 正在执行 SQLite WAL Checkpoint...')
          db.pragma('wal_checkpoint(TRUNCATE)')
        }
      } catch (dbErr: any) {
        logger.warn(LogCategory.SYSTEM, '[AutoUpdater] SQLite Checkpoint 警告 (忽略):', dbErr.message)
      }

      // 步骤 2: 显式停止 omniService 与 llamaServerService，阻断自愈看门狗 scheduleRestart
      try {
        const { omniService } = require('./omni-service')
        if (omniService) {
          logger.info(LogCategory.SYSTEM, '[AutoUpdater] 优雅停机 Step 2: 显式停用 omniService 阻断看门狗...')
          omniService.stop()
        }
      } catch {}

      try {
        const { llamaServerService } = require('@firefly/electron-llamaIndex-service')
        if (llamaServerService && typeof llamaServerService.stop === 'function') {
          await llamaServerService.stop()
        }
      } catch {}

      // 步骤 3: 兜底调用 ProcessReaper 清理本 Worktree 实例名下的所有挂载子进程
      try {
        logger.info(LogCategory.SYSTEM, '[AutoUpdater] 优雅停机 Step 3: ProcessReaper 清扫所有子进程...')
        const { ProcessReaper } = require('../../main/process-reaper')
        ProcessReaper.getInstance().cleanup()
      } catch (reaperErr: any) {
        logger.warn(LogCategory.SYSTEM, '[AutoUpdater] ProcessReaper 清扫警告:', reaperErr.message)
      }

      // 步骤 4: 延迟 500ms 保证文件锁完全释放后，执行 NSIS 静默提权覆盖安装
      logger.info(LogCategory.SYSTEM, '[AutoUpdater] 优雅停机 Step 4: 执行 autoUpdater.quitAndInstall(true, true)')
      setTimeout(() => {
        try {
          autoUpdater.quitAndInstall(true, true)
        } catch (quitErr: any) {
          logger.error(LogCategory.SYSTEM, '[AutoUpdater] quitAndInstall 异常，尝试强制退出:', quitErr)
          app.quit()
        }
      }, 500)
    } catch (err: any) {
      logger.error(LogCategory.SYSTEM, '[AutoUpdater] 优雅停机流程发生异常:', err)
      autoUpdater.quitAndInstall(true, true)
    }
  }

  /**
   * 校验本地缓存目录中是否存在可用且未损坏的完整安装包（流式异步计算哈希，杜绝大文件内存溢出）
   */
  public async verifyLocalCachedInstaller(info: UpdateInfo): Promise<string | null> {
    try {
      const helper = (autoUpdater as any).downloadedUpdateHelper
      const cachedFile = helper?.file || helper?.downloadedFileInfo?.filePath
      if (cachedFile && fs.existsSync(cachedFile)) {
        const stat = fs.statSync(cachedFile)
        const primaryFile = info.files?.[0]
        if (primaryFile && primaryFile.size && stat.size === primaryFile.size) {
          // 校验 SHA-512 (流式计算)
          if (primaryFile.sha512) {
            const computedSha512 = await new Promise<string>((resolve, reject) => {
              const hash = crypto.createHash('sha512')
              const stream = fs.createReadStream(cachedFile)
              stream.on('data', chunk => hash.update(chunk))
              stream.on('end', () => resolve(hash.digest('base64')))
              stream.on('error', reject)
            })
            if (computedSha512 === primaryFile.sha512) {
              return cachedFile
            }
          } else {
            return cachedFile
          }
        }
      }
    } catch {
      // 校验失败则返回 null 正常走下载流程
    }
    return null
  }

  /**
   * 处理三级降级与错误闭环
   */
  private async handleUpdateError(error: any, phase: 'check' | 'download', isManual = false): Promise<void> {
    const errorMsg = error?.message || String(error)
    logger.warn(LogCategory.SYSTEM, `[AutoUpdater] 发生更新错误 (阶段=${phase}, 当前源=${this.state.currentTrack}): ${errorMsg}`)

    // L1 -> L2: 差分下载失败自动回退同源全量下载
    if (phase === 'download' && !this.isFullDownloadFallback) {
      logger.info(LogCategory.SYSTEM, '[AutoUpdater] L1 -> L2 降级: 差分增量下载失败，切换为同源全量下载重试...')
      this.isFullDownloadFallback = true
      autoUpdater.disableDifferentialDownload = true
      try {
        await autoUpdater.downloadUpdate()
        return
      } catch (fullErr) {
        logger.error(LogCategory.SYSTEM, '[AutoUpdater] 全量下载重试失败:', fullErr)
      }
    }

    // L2 -> L3: 同源全量失败或网络断流，故障转移至异地双轨备用源
    if (!this.hasTriedFailover) {
      const fallbackTrack: UpdateTrack = this.state.currentTrack === 'r2' ? 'github' : 'r2'
      logger.info(LogCategory.SYSTEM, `[AutoUpdater] L2 -> L3 降级: 触发双轨 Failover 切换至备用源: ${fallbackTrack}`)
      this.hasTriedFailover = true
      this.isFullDownloadFallback = false
      autoUpdater.disableDifferentialDownload = false
      this.configureFeedUrl(fallbackTrack)

      try {
        await autoUpdater.checkForUpdates()
        return
      } catch (failoverErr) {
        logger.error(LogCategory.SYSTEM, '[AutoUpdater] 备用源重试依然失败:', failoverErr)
      }
    }

    // 全部降级路径耗尽，进入 error 终端状态
    this.updateState({
      status: 'error',
      error: errorMsg
    })
  }

  /**
   * 注册 electron-updater 原生事件流
   */
  private setupUpdaterListeners(): void {
    autoUpdater.on('checking-for-update', () => {
      logger.info(LogCategory.SYSTEM, '[AutoUpdater] 正在检索云端更新清单...')
      this.updateState({ status: 'checking', error: null })
    })

    autoUpdater.on('update-available', (info: UpdateInfo & { minVersion?: string }) => {
      logger.info(LogCategory.SYSTEM, `[AutoUpdater] 发现新版本: ${info.version} (当前: ${this.state.currentVersion})`)
      this.activeUpdateInfo = info

      let isMandatory = false
      const minVersion = info.minVersion || null
      if (minVersion && semver.valid(minVersion) && semver.valid(this.state.currentVersion)) {
        if (semver.lt(this.state.currentVersion, minVersion)) {
          isMandatory = true
          logger.warn(
            LogCategory.SYSTEM,
            `[AutoUpdater] 当前版本 ${this.state.currentVersion} 低于最低要求版本 ${minVersion}，触发强制更新！`
          )
        }
      }

      this.updateState({
        status: 'available',
        latestVersion: info.version,
        minVersion,
        isMandatory,
        releaseDate: info.releaseDate || null,
        releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null,
        error: null
      })

      // 无论常规或强制，均在后台静默启动下载
      this.startDownload().catch(err => {
        logger.warn(LogCategory.SYSTEM, '[AutoUpdater] 静默启动下载失败:', err)
      })
    })

    autoUpdater.on('update-not-available', (info: UpdateInfo) => {
      logger.info(LogCategory.SYSTEM, `[AutoUpdater] 已是最新版本: ${info.version}`)
      this.activeUpdateInfo = null
      this.updateState({
        status: 'not-available',
        latestVersion: info.version,
        error: null,
        progress: null
      })
    })

    autoUpdater.on('download-progress', (progressObj: any) => {
      this.updateState({
        status: 'downloading',
        progress: {
          percent: Math.round(progressObj.percent || 0),
          transferred: progressObj.transferred || 0,
          total: progressObj.total || 0,
          bytesPerSecond: progressObj.bytesPerSecond || 0
        }
      })
    })

    autoUpdater.on('update-downloaded', (event: any) => {
      logger.info(LogCategory.SYSTEM, `[AutoUpdater] 更新包已成功下载完毕: ${event?.downloadedFile || ''}`)
      this.updateState({
        status: 'downloaded',
        downloadedFilePath: event?.downloadedFile || null,
        progress: {
          percent: 100,
          transferred: this.state.progress?.total || 0,
          total: this.state.progress?.total || 0,
          bytesPerSecond: 0
        }
      })
    })

    autoUpdater.on('error', (err: any) => {
      logger.error(LogCategory.SYSTEM, '[AutoUpdater] 监听到底层 Updater 错误:', err)
      this.handleUpdateError(err, this.state.status === 'downloading' ? 'download' : 'check').catch(() => {})
    })
  }

  /**
   * 变更状态并向所有渲染窗口广播更新事件
   */
  private updateState(partial: Partial<UpdateState>): void {
    this.state = {
      ...this.state,
      ...partial
    }

    try {
      const wins = BrowserWindow.getAllWindows()
      for (const win of wins) {
        if (!win.isDestroyed()) {
          win.webContents.send('update:status-changed', this.state)
        }
      }
    } catch {
      // 忽略窗口广播异常
    }
  }
}

export const autoUpdateService = AutoUpdateService.getInstance()
