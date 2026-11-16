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
import {
  runShutdownSequence,
  runShutdownSequenceWithOverallTimeout,
  type ShutdownCapabilities
} from './shutdown-coordinator'

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

  /**
   * 关停前扩展点注册表（工单 07 · P0-6）。
   * 允许其它子系统（如需在退出前 flush 的服务）注册关停钩子，由
   * ShutdownCoordinator 在四步关停握手前统一执行。
   * 钩子失败不阻断（非关键扩展），但必须 logger.warn 显式上报——禁止静默降级。
   */
  private beforeQuitHooks: Array<{ name: string; fn: () => void | Promise<void> }> = []

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
      info: (msg: any) => logger.debug(LogCategory.SYSTEM, `[AutoUpdater] ${msg}`),
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
      logger.debug(LogCategory.SYSTEM, '[AutoUpdater] 触发周期性静默更新检查 (4小时间隔)...')
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
        logger.debug(LogCategory.SYSTEM, `[AutoUpdater] 已切换更新源至 R2: ${this.R2_BASE_URL} (channel=${channel})`)
      } else {
        autoUpdater.setFeedURL({
          provider: 'github',
          owner: this.GITHUB_OWNER,
          repo: this.GITHUB_REPO,
          channel
        })
        logger.debug(
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
      logger.debug(LogCategory.SYSTEM, `[AutoUpdater] 命中本地完整安装包缓存，跳过下载: ${cachedFilePath}`)
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
    logger.debug(LogCategory.SYSTEM, '[AutoUpdater] 用户触发立即重启安装，启动四步优雅关停握手...')
    this.updateState({ status: 'installing' })

    // 非 Windows 平台（macOS DMG 或 Linux DEB/RPM）：打开安装包引导用户覆盖安装
    if (process.platform !== 'win32') {
      if (this.state.downloadedFilePath && fs.existsSync(this.state.downloadedFilePath)) {
        logger.debug(LogCategory.SYSTEM, `[AutoUpdater] 跨平台打开安装包: ${this.state.downloadedFilePath}`)
        await shell.openPath(this.state.downloadedFilePath)
      }
      return
    }

    // Windows 平台：四步关停握手（P0-6 · ShutdownCoordinator 失败语义表）
    // 组合根注入关停能力，逐项落地 §2.7.3 判定表，消除历史空 catch 与 500ms 魔数。
    const caps = this.buildShutdownCapabilities()

    const outcome = await runShutdownSequenceWithOverallTimeout(caps, () =>
      runShutdownSequence(caps)
    )

    if (!outcome.canProceed) {
      // 阻断：不调用 quitAndInstall，置为可重试状态（UI 提示用户重试关停）
      const blocked = outcome.blockedBy.join(', ')
      logger.error(
        LogCategory.SYSTEM,
        `[AutoUpdater] 关停握手被阻断(${blocked})，不执行安装，等待用户重试`
      )
      this.updateState({
        status: 'error',
        error: `关停失败(${blocked})，请重试或手动重启后更新`
      })
      return
    }

    // 第 4 步: 全部阻断步骤通过 → 静默提权覆盖安装（isSilent, isForceRunAfter）
    logger.debug(LogCategory.SYSTEM, '[AutoUpdater] 关停握手通过，执行 autoUpdater.quitAndInstall(true, true)')
    try {
      autoUpdater.quitAndInstall(true, true)
    } catch (quitErr: any) {
      logger.error(LogCategory.SYSTEM, '[AutoUpdater] quitAndInstall 异常，尝试强制退出:', quitErr)
      app.quit()
    }
  }

  /**
   * 组装 ShutdownCoordinator 所需的关停能力（§2.7.2 四步）。
   * 每步独立 require，避免模块加载顺序导致的启动期耦合；失败语义由编排器判定。
   */
  private buildShutdownCapabilities(): ShutdownCapabilities {
    return {
      checkpointWal: async () => {
        const { databaseService } = require('../database/database-service')
        const db = databaseService?.db
        if (!db) {
          // 无活跃 DB（如未初始化）视为无写者，非 busy
          return { busy: false }
        }
        logger.debug(LogCategory.SYSTEM, '[AutoUpdater] Step 1: 执行 SQLite WAL Checkpoint...')
        // pragma('wal_checkpoint(TRUNCATE)') 返回 (busy, log, checkpoint) 三元组
        const row = db.pragma('wal_checkpoint(TRUNCATE)') as unknown as [number, number, number]
        const busy = Array.isArray(row) ? Number(row[0]) === 1 : false
        return { busy }
      },
      stopOmni: async () => {
        const { omniService } = require('./omni-service')
        if (!omniService) return
        logger.debug(LogCategory.SYSTEM, '[AutoUpdater] Step 2: 显式停机 omniService 阻断看门狗...')
        await omniService.stop()
      },
      stopLlamaServer: async () => {
        const { llamaServerService } = require('@firefly/electron-llamaIndex-service')
        // 真实停机方法是 stopServer()（历史误调 stop() 因守卫恒 false 导致引擎从未停机）
        if (llamaServerService && typeof llamaServerService.stopServer === 'function') {
          logger.debug(LogCategory.SYSTEM, '[AutoUpdater] Step 2: 停机 llamaServerService...')
          await llamaServerService.stopServer()
        }
      },
      stopLibreOffice: async () => {
        const { libreOfficeDaemonService } = require('./libreoffice-daemon-service')
        if (libreOfficeDaemonService && typeof libreOfficeDaemonService.stopDaemon === 'function') {
          logger.debug(LogCategory.SYSTEM, '[AutoUpdater] Step 2: 停机 libreoffice 守护进程...')
          libreOfficeDaemonService.stopDaemon()
        }
      },
      reapProcesses: async () => {
        // 先执行已注册关停前钩子（非关键扩展，失败不阻断）
        await this.runBeforeQuitHooks()
        logger.debug(LogCategory.SYSTEM, '[AutoUpdater] Step 3: ProcessReaper 清扫所有子进程...')
        const { ProcessReaper } = require('../../main/process-reaper')
        ProcessReaper.getInstance().cleanup()
      }
    }
  }

  /**
   * 注册关停前扩展钩子（工单 07 · P0-6 验收第 1 条）。
   * 其它子系统在 initialize() 阶段调用，把自己的"退出前收尾逻辑"（如 flush 缓冲、
   * 释放单例句柄）挂到关停编排器上。钩子在四步关停握手的 ProcessReaper 清扫前执行。
   * @param name 钩子名（日志定位用）
   * @param fn 钩子函数；抛错由编排器 warn 上报，不阻断关停
   */
  public registerBeforeQuitHook(name: string, fn: () => void | Promise<void>): void {
    this.beforeQuitHooks.push({ name, fn })
    logger.debug(LogCategory.SYSTEM, `[AutoUpdater] 已注册关停前钩子: ${name}`)
  }

  /**
   * 执行所有已注册的关停前钩子。
   * 每个钩子独立 try/catch 显式上报——禁止空 catch 静默降级（AGENTS.md 系统不变量 3）。
   * 钩子属非关键扩展，失败不阻断关停（与 libreoffice 同级语义）。
   */
  private async runBeforeQuitHooks(): Promise<void> {
    if (this.beforeQuitHooks.length === 0) return
    logger.debug(LogCategory.SYSTEM, `[AutoUpdater] 执行 ${this.beforeQuitHooks.length} 个关停前钩子...`)
    for (const hook of this.beforeQuitHooks) {
      try {
        await hook.fn()
        logger.debug(LogCategory.SYSTEM, `[AutoUpdater] 关停前钩子成功: ${hook.name}`)
      } catch (hookErr: any) {
        // 禁止静默降级：钩子失败显式上报后继续，不阻断关停
        logger.warn(
          LogCategory.SYSTEM,
          `[AutoUpdater] 关停前钩子失败(继续): ${hook.name}:`,
          hookErr?.message
        )
      }
    }
  }

  /**
   * 强制更新遮罩的"退出应用"(P0-11)：走同一 ShutdownCoordinator 关停编排，
   * 但去掉"拉起安装器"步，最终 app.exit(0) 仅整体超时兜底，
   * 不触发 before-quit/will-quit（与安全重启铁律一致）。
   */
  public async exitAppForUpdate(): Promise<void> {
    logger.info(LogCategory.SYSTEM, '[AutoUpdater] update:exit-app 走 ShutdownCoordinator 关停编排(去安装步)...')
    const caps = this.buildShutdownCapabilities()
    const outcome = await runShutdownSequenceWithOverallTimeout(caps, () => runShutdownSequence(caps))

    if (!outcome.canProceed) {
      const blocked = outcome.blockedBy.join(', ')
      logger.error(
        LogCategory.SYSTEM,
        `[AutoUpdater] exit-app 关停被阻断(${blocked})，仍 app.exit(0) 兜底退出`
      )
    }
    // P0-11: 最终 app.exit(0) 直接退出，不触发 before-quit/will-quit
    app.exit(0)
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
      logger.debug(LogCategory.SYSTEM, '[AutoUpdater] L1 -> L2 降级: 差分增量下载失败，切换为同源全量下载重试...')
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
      logger.debug(LogCategory.SYSTEM, `[AutoUpdater] L2 -> L3 降级: 触发双轨 Failover 切换至备用源: ${fallbackTrack}`)
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
      logger.debug(LogCategory.SYSTEM, '[AutoUpdater] 正在检索云端更新清单...')
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
