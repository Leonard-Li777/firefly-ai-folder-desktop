import { app, BrowserWindow, shell, powerMonitor } from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import * as crypto from 'crypto'
import * as https from 'https'
import * as http from 'http'
import semver from 'semver'
import type { AppUpdater, UpdateInfo } from 'electron-updater'
import { logger, LogCategory, isTestEnvironment } from '@firefly/shared'
import { resolveAppRegion } from '../../main/worktree-env'
import {
  runShutdownSequence,
  runShutdownSequenceWithOverallTimeout,
  type ShutdownCapabilities
} from './shutdown-coordinator'
import { checkDiskSpace } from './file-download-service'

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
  private cachedAutoUpdater: AppUpdater | null = null
  private autoUpdaterPromise: Promise<AppUpdater> | null = null
  private initPromise: Promise<void> | null = null
  private hasExplicitFeedConfig = false
  private isChecking = false
  // A6 · 并发复用锁：在飞的更新检查 Promise，三路并发（5s 首检/4h 轮询/手动）复用同一任务
  private inFlightCheck: Promise<UpdateState> | null = null
  private hasTriedFailover = false
  private isFullDownloadFallback = false
  private activeUpdateInfo: (UpdateInfo & { minVersion?: string }) | null = null

  private readonly R2_BASE_URL = 'https://download.iocn.cn/firefly-ai-folder'
  private readonly GITHUB_OWNER = 'Leonard-Li777'
  private readonly GITHUB_REPO = 'firefly-ai-folder-desktop'
  private readonly PROBE_TIMEOUT_MS = 2500

  private pollTimer: NodeJS.Timeout | null = null
  private readonly POLL_INTERVAL_MS = 4 * 60 * 60 * 1000 // 4 小时轮询一次

  // P2-5：系统唤醒补检的 resume 监听句柄（用于注销）
  private resumeHandler: (() => void) | null = null

  // 停滞看门狗（工单 08 · P1）：下载长时间无字节进展时触发降级
  private stallWatchdogTimer: NodeJS.Timeout | null = null
  private readonly DOWNLOAD_STALL_TIMEOUT_MS = 120 * 1000 // 2 分钟零进展视为停滞

  // 进度推流节流（工单 09 · P1-2）：downloading 进度 300ms 节流，终态立即 flush
  private progressThrottleTimer: NodeJS.Timeout | null = null
  private readonly PROGRESS_THROTTLE_MS = 300

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

  private async getAutoUpdater(): Promise<AppUpdater> {
    if (this.cachedAutoUpdater) {
      return this.cachedAutoUpdater
    }
    if (!this.autoUpdaterPromise) {
      this.autoUpdaterPromise = import('electron-updater')
        .then(mod => {
          this.cachedAutoUpdater = mod.autoUpdater
          return mod.autoUpdater
        })
        .catch(err => {
          this.autoUpdaterPromise = null
          throw err
        })
    }
    return this.autoUpdaterPromise
  }

  /**
   * 同步方法兼容读取：生产链路均先经 getAutoUpdater() 异步加载；
   * 若尚未加载则返回 null，由调用方触发异步预热。
   */
  private getLoadedAutoUpdater(): AppUpdater | null {
    return this.cachedAutoUpdater
  }

  /**
   * 初始化自动更新监听器与配置（工单 11 · P1-17）。
   * 测试环境短路仍置 isInitialized=true + logger.info，保证状态机可观测。
   */
  public initialize(): void {
    if (isTestEnvironment()) {
      // P1-17：测试环境短路——仍标记已初始化并显式上报，使测试侧能观测到状态机存在
      this.isInitialized = true
      logger.info(
        LogCategory.SYSTEM,
        '[AutoUpdater] 测试环境短路：已标记 isInitialized=true（跳过真实初始化）'
      )
      return
    }
    if (this.isInitialized) {
      return
    }
    this.isInitialized = true

    this.initPromise = this.initializeUpdaterAsync().catch(err => {
      logger.warn(LogCategory.SYSTEM, '[AutoUpdater] 异步初始化失败:', err)
    })

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

    // P2-5：系统从休眠/待机恢复后 30s 静默补检，捕获长待机期间错过的更新窗口
    if (powerMonitor) {
      this.resumeHandler = () => {
        logger.debug(LogCategory.SYSTEM, '[AutoUpdater] 系统唤醒，30s 后静默补检更新 (P2-5)...')
        setTimeout(() => {
          this.checkForUpdates(false).catch(err => {
            logger.warn(LogCategory.SYSTEM, '[AutoUpdater] 唤醒后补检更新失败:', err)
          })
        }, 30 * 1000)
      }
      powerMonitor.on('resume', this.resumeHandler)
    }
  }

  private async initializeUpdaterAsync(): Promise<void> {
    const updater = await this.getAutoUpdater()
    // 配置 electron-updater 基础选项
    updater.autoDownload = false // 静默发现后由状态机控制下载
    updater.autoInstallOnAppQuit = true // 默认允许用户退出应用时自动应用更新
    updater.disableWebInstaller = true
    updater.allowPrerelease = false // 路线 B 硬门禁：严禁正式/测试客户端跨通道消费 -dev 预发布包
    updater.logger = {
      info: (msg: any) => logger.debug(LogCategory.SYSTEM, `[AutoUpdater] ${msg}`),
      warn: (msg: any) => logger.warn(LogCategory.SYSTEM, `[AutoUpdater] ${msg}`),
      error: (msg: any) => logger.error(LogCategory.SYSTEM, `[AutoUpdater] ${msg}`)
    }

    this.setupUpdaterListeners()
    if (!this.hasExplicitFeedConfig) {
      this.configureFeedUrl(this.state.currentTrack)
    }
  }

  /**
   * 获取当前更新状态副本
   */
  public getState(): UpdateState {
    return { ...this.state }
  }

  /**
   * 当前更新频道（AC2.1 · 工单 02）：cn | intl
   */
  public getChannel(): 'cn' | 'intl' {
    return resolveAppRegion()
  }

  /**
   * 当前下载提供方（AC2.1 · 工单 02）：r2 | github
   */
  public getCurrentProvider(): 'r2' | 'github' {
    return this.state.currentTrack
  }

  private static readonly SAFE_FEED_SEGMENT_RE = /^[a-zA-Z0-9._-]+$/
  private static readonly POINTER_MAX_BYTES = 64 * 1024

  /**
   * 校验 R2 单对象指针中的 feedBasePath 是否为安全相对路径（支持单段 4.0.0 与多段 candidates/4.0.0/run-123）
   */
  public static isSafeFeedBasePath(feedBasePath: unknown): feedBasePath is string {
    if (typeof feedBasePath !== 'string' || !feedBasePath) return false
    const segments = feedBasePath.split('/')
    return (
      segments.length > 0 &&
      segments.every(
        seg => seg !== '.' && seg !== '..' && AutoUpdateService.SAFE_FEED_SEGMENT_RE.test(seg)
      )
    )
  }

  /**
   * 配置下载源 Feed URL（第二参数可选，保持与既有调用及单测向后兼容）
   */
  public configureFeedUrl(track: UpdateTrack, feedBasePath?: string): void {
    this.hasExplicitFeedConfig = true
    this.state.currentTrack = track
    const channel = resolveAppRegion()

    try {
      const updater = this.getLoadedAutoUpdater()
      if (!updater) {
        void this.getAutoUpdater()
          .then(() => this.configureFeedUrl(track, feedBasePath))
          .catch(err => {
            logger.error(LogCategory.SYSTEM, '[AutoUpdater] 延迟配置 FeedURL 失败:', err)
          })
        return
      }
      if (track === 'r2') {
        const targetUrl =
          feedBasePath && AutoUpdateService.isSafeFeedBasePath(feedBasePath)
            ? `${this.R2_BASE_URL}/${feedBasePath}`
            : this.R2_BASE_URL
        updater.setFeedURL({
          provider: 'generic',
          url: targetUrl,
          channel,
          // 工单 08 · P0-2：R2 generic provider 关闭多范围并行下载。
          // Electron-Builder 多范围请求在 CDN/对象存储偶发返回 416 Range Not Satisfiable，
          // 导致差分下载失败退化为全量；关闭后单范围下载稳定。
          useMultipleRangeRequest: false
        })
        logger.debug(
          LogCategory.SYSTEM,
          `[AutoUpdater] 已切换更新源至 R2: ${targetUrl} (channel=${channel})`
        )
      } else {
        updater.setFeedURL({
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
   * 路线 B：当 track === 'r2' 时单次 GET 单对象指针（latest.json / staging.json），
   * 解析合法 feedBasePath 后即时调用 configureFeedUrl('r2', feedBasePath)，避免双倍请求并保持既有单测 Mock 兼容。
   * 返回 'alive'（域可达且指针合法）/ 'missing'（404/410 暂无可用版本）/ 'down'（不可达或指针损坏）。
   */
  public async probeEndpoint(track: UpdateTrack): Promise<'alive' | 'missing' | 'down'> {
    await this.getAutoUpdater().catch(err => {
      logger.warn(LogCategory.SYSTEM, '[AutoUpdater] 探针预热 electron-updater 失败:', err)
    })
    const pointerFile =
      process.env.FIREFLY_UPDATE_CHANNEL === 'staging' ? 'staging.json' : 'latest.json'
    const probeUrl =
      track === 'r2'
        ? `${this.R2_BASE_URL}/${pointerFile}`
        : `https://github.com/${this.GITHUB_OWNER}/${this.GITHUB_REPO}/releases`

    return new Promise<'alive' | 'missing' | 'down'>(resolve => {
      let isResolved = false
      const client = probeUrl.startsWith('https') ? https : http

      const finish = (result: 'alive' | 'missing' | 'down') => {
        if (isResolved) return
        isResolved = true
        clearTimeout(timer)
        resolve(result)
      }

      const timer = setTimeout(() => {
        logger.warn(
          LogCategory.SYSTEM,
          `[AutoUpdater] 探针超时 (${this.PROBE_TIMEOUT_MS}ms): ${probeUrl}`
        )
        finish('down')
      }, this.PROBE_TIMEOUT_MS)

      try {
        const req = client.request(
          probeUrl,
          {
            method: track === 'r2' ? 'GET' : 'HEAD',
            timeout: this.PROBE_TIMEOUT_MS,
            headers: track === 'r2' ? { 'Cache-Control': 'no-cache' } : undefined
          },
          res => {
            const statusCode = res.statusCode || 0
            // 404/410 表示域名可达但指针尚不存在（暂无可用版本），视为 missing 而非源故障
            if (statusCode === 404 || statusCode === 410) {
              res.resume()
              req.destroy()
              logger.debug(
                LogCategory.SYSTEM,
                `[AutoUpdater] 探针指针不存在 (${statusCode}): ${probeUrl}`
              )
              finish('missing')
              return
            }

            if (track !== 'r2') {
              res.resume()
              req.destroy()
              if (statusCode > 0 && statusCode < 500) {
                finish('alive')
                return
              }
              logger.warn(
                LogCategory.SYSTEM,
                `[AutoUpdater] 探针服务端异常 (${statusCode}): ${probeUrl}`
              )
              finish('down')
              return
            }

            if (statusCode < 200 || statusCode >= 300) {
              res.resume()
              req.destroy()
              logger.warn(
                LogCategory.SYSTEM,
                `[AutoUpdater] R2 指针请求异常 (${statusCode}): ${probeUrl}`
              )
              finish('down')
              return
            }

            const chunks: Buffer[] = []
            let totalBytes = 0
            res.on('data', (chunk: Buffer | string) => {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
              totalBytes += buf.length
              if (totalBytes > AutoUpdateService.POINTER_MAX_BYTES) {
                req.destroy()
                logger.warn(
                  LogCategory.SYSTEM,
                  `[AutoUpdater] R2 指针响应体超过 64KB 上限: ${probeUrl}`
                )
                finish('down')
                return
              }
              chunks.push(buf)
            })

            res.on('end', () => {
              if (isResolved) return
              try {
                const raw = Buffer.concat(chunks).toString('utf8')
                const parsed = JSON.parse(raw)
                const rawFeedPath = parsed?.feedBasePath || parsed?.version
                if (!AutoUpdateService.isSafeFeedBasePath(rawFeedPath)) {
                  logger.warn(
                    LogCategory.SYSTEM,
                    `[AutoUpdater] R2 指针 feedBasePath/version 非法: ${String(rawFeedPath)} (${probeUrl})`
                  )
                  finish('down')
                  return
                }
                this.configureFeedUrl('r2', rawFeedPath)
                finish('alive')
              } catch (parseErr: any) {
                logger.warn(
                  LogCategory.SYSTEM,
                  `[AutoUpdater] R2 指针 JSON 解析失败: ${parseErr?.message ?? parseErr} (${probeUrl})`
                )
                finish('down')
              }
            })
          }
        )

        req.on('error', err => {
          req.destroy()
          logger.warn(
            LogCategory.SYSTEM,
            `[AutoUpdater] 探针网络错误: ${err.message} (${probeUrl})`
          )
          finish('down')
        })

        req.on('timeout', () => {
          req.destroy()
        })

        req.end()
      } catch (err: any) {
        logger.warn(
          LogCategory.SYSTEM,
          `[AutoUpdater] 探针构造请求异常: ${err?.message ?? err} (${probeUrl})`
        )
        finish('down')
      }
    })
  }

  /**
   * 触发更新检查
   * @param manual 是否为用户主动点击触发（手动触发会在界面显示 loading 与明确提示）
   */
  public async checkForUpdates(manual = false): Promise<UpdateState> {
    // A6 · 并发复用锁：5s 首检 / 4h 轮询 / 手动检查三路并发时复用进行中任务，避免状态机跳变
    if (this.inFlightCheck) {
      return this.inFlightCheck
    }

    this.inFlightCheck = this.runCheckForUpdates(manual)
    try {
      return await this.inFlightCheck
    } finally {
      this.inFlightCheck = null
    }
  }

  /**
   * 执行一次完整的更新检查流程（供 checkForUpdates 串接，见 A6 并发复用锁）
   */
  private async runCheckForUpdates(manual: boolean): Promise<UpdateState> {
    this.isChecking = true
    this.updateState({
      status: 'checking',
      error: null
    })

    try {
      if (this.initPromise) {
        await this.initPromise
      }
      const updater = await this.getAutoUpdater()
      // 手动触发视为显式重试意愿：复位降级旗标，允许重新评估首选源与差分下载，
      // 避免一次网络抖动将客户端永久钉在全量+备用源（修复 P0-5）。
      if (manual) {
        this.hasTriedFailover = false
        this.isFullDownloadFallback = false
        updater.disableDifferentialDownload = false
      }

      // 探针健康预检：仅当首选源「真不可达」且本轮尚未探查时，静默平滑降级。
      // missing（指针不存在/暂无可用版本）不算源故障，避免无谓切源（修复 P0-7 / R2-04）。
      const probeResult = await this.probeEndpoint(this.state.currentTrack)
      if (probeResult === 'down' && !this.hasTriedFailover) {
        const fallbackTrack: UpdateTrack = this.state.currentTrack === 'r2' ? 'github' : 'r2'
        logger.warn(
          LogCategory.SYSTEM,
          `[AutoUpdater] 首选源 ${this.state.currentTrack} 探针不可达，平滑降级至备用源 ${fallbackTrack}`
        )
        this.hasTriedFailover = true
        if (fallbackTrack === 'r2') {
          // R2-03：INTL 降级至 R2 前必须先异步解析单对象指针
          const fallbackProbe = await this.probeEndpoint('r2')
          if (fallbackProbe === 'missing') {
            this.updateState({ status: 'not-available', isMandatory: false, error: null })
            return this.getState()
          }
          if (fallbackProbe === 'down') {
            throw new Error('备用源 R2 单对象指针不可达或解析失败')
          }
        } else {
          this.configureFeedUrl(fallbackTrack)
        }
      } else if (probeResult === 'missing') {
        logger.debug(
          LogCategory.SYSTEM,
          `[AutoUpdater] 首选源 ${this.state.currentTrack} 指针不存在（暂无可用版本），保持当前源`
        )
        if (this.state.currentTrack === 'r2') {
          // R2-04：路线 B 下 R2 指针 404 时提前返回 not-available，严禁继续请求已废除的根路径 yml
          this.updateState({ status: 'not-available', isMandatory: false, error: null })
          return this.getState()
        }
      }

      await (await this.getAutoUpdater()).checkForUpdates()
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
      logger.debug(
        LogCategory.SYSTEM,
        `[AutoUpdater] 命中本地完整安装包缓存，跳过下载: ${cachedFilePath}`
      )
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

    // 磁盘空间预检（工单 08 · P1）：全量包 600MB~800MB，空间不足提前失败避免半成品污染缓存
    const approxBytes = this.activeUpdateInfo?.files?.[0]?.size || 800 * 1024 * 1024
    const hasSpace = this.preflightDiskSpace(approxBytes)
    if (!hasSpace) {
      return
    }

    // 启动停滞看门狗（首字节到达前也受保护）
    this.resetDownloadStallWatchdog(true)

    try {
      if (this.initPromise) {
        await this.initPromise
      }
      const updater = await this.getAutoUpdater()
      await updater.downloadUpdate()
    } catch (err: any) {
      this.stopDownloadStallWatchdog()
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
        logger.debug(
          LogCategory.SYSTEM,
          `[AutoUpdater] 跨平台打开安装包: ${this.state.downloadedFilePath}`
        )
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
        error: `关停失败(${blocked})，请重试或手动重启后更新`,
        isMandatory: false // A7 红线：error 状态绝不进入强更分支
      })
      return
    }

    // 第 4 步: 全部阻断步骤通过 → 静默提权覆盖安装（isSilent, isForceRunAfter）
    logger.debug(
      LogCategory.SYSTEM,
      '[AutoUpdater] 关停握手通过，执行 autoUpdater.quitAndInstall(true, true)'
    )
    try {
      if (this.initPromise) {
        await this.initPromise
      }
      const updater = await this.getAutoUpdater()
      updater.quitAndInstall(true, true)
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
    logger.debug(
      LogCategory.SYSTEM,
      `[AutoUpdater] 执行 ${this.beforeQuitHooks.length} 个关停前钩子...`
    )
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
    logger.info(
      LogCategory.SYSTEM,
      '[AutoUpdater] update:exit-app 走 ShutdownCoordinator 关停编排(去安装步)...'
    )
    const caps = this.buildShutdownCapabilities()
    const outcome = await runShutdownSequenceWithOverallTimeout(caps, () =>
      runShutdownSequence(caps)
    )

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
      if (this.initPromise) {
        await this.initPromise
      }
      const updater = await this.getAutoUpdater()
      const helper = (updater as any).downloadedUpdateHelper
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
   * 评估是否触发强制更新（工单 09 · A7 三分支红线 + P1-15 minVersion 安全解析）。
   * 仅允许在 phase==='update-available' 事件内调用；error 事件绝不进入本分支。
   * minVersion 缺失 / 非法 semver / prerelease 一律 logger.warn 并按"不强制"处理。
   */
  private evaluateMandatoryUpdate(minVersion?: string): boolean {
    const currentVersion = this.state.currentVersion

    // 分支 1：minVersion 缺失 → 不强制
    if (!minVersion) {
      logger.debug(LogCategory.SYSTEM, '[AutoUpdater] 无 minVersion 门禁，按常规更新处理')
      return false
    }

    // 分支 2：非法 semver → warn + 不强制（严禁漏阻断/误阻断）
    if (!semver.valid(minVersion)) {
      logger.warn(
        LogCategory.SYSTEM,
        `[AutoUpdater] minVersion 非法 semver ("${minVersion}")，安全降级为不强制更新`
      )
      return false
    }

    // 分支 3：prerelease 版本 → warn + 不强制（避免预发布标签干扰门禁判定）
    if (semver.prerelease(minVersion)) {
      logger.warn(
        LogCategory.SYSTEM,
        `[AutoUpdater] minVersion 为 prerelease ("${minVersion}")，安全降级为不强制更新`
      )
      return false
    }

    // 分支 4：当前版本非法 → 不强制（防御性，正常不应发生）
    if (!semver.valid(currentVersion)) {
      logger.warn(
        LogCategory.SYSTEM,
        `[AutoUpdater] 当前版本 "${currentVersion}" 非法 semver，无法判定强更门禁，按不强制处理`
      )
      return false
    }

    // 分支 5：三者齐备 → 比对版本
    if (semver.lt(currentVersion, minVersion)) {
      logger.warn(
        LogCategory.SYSTEM,
        `[AutoUpdater] 当前版本 ${currentVersion} 低于最低要求版本 ${minVersion}，触发强制更新！`
      )
      return true
    }

    return false
  }

  /**
   * 处理三级降级与错误闭环
   */
  private async handleUpdateError(
    error: any,
    phase: 'check' | 'download',
    isManual = false
  ): Promise<void> {
    const errorMsg = error?.message || String(error)
    logger.warn(
      LogCategory.SYSTEM,
      `[AutoUpdater] 发生更新错误 (阶段=${phase}, 当前源=${this.state.currentTrack}): ${errorMsg}`
    )

    const updater = await this.getAutoUpdater()

    // L1 -> L2: 差分下载失败自动回退同源全量下载
    if (phase === 'download' && !this.isFullDownloadFallback) {
      logger.debug(
        LogCategory.SYSTEM,
        '[AutoUpdater] L1 -> L2 降级: 差分增量下载失败，切换为同源全量下载重试...'
      )
      this.isFullDownloadFallback = true
      updater.disableDifferentialDownload = true
      try {
        await updater.downloadUpdate()
        return
      } catch (fullErr) {
        logger.error(LogCategory.SYSTEM, '[AutoUpdater] 全量下载重试失败:', fullErr)
      }
    }

    // L2 -> L3: 同源全量失败或网络断流，故障转移至异地双轨备用源
    if (!this.hasTriedFailover) {
      const fallbackTrack: UpdateTrack = this.state.currentTrack === 'r2' ? 'github' : 'r2'
      logger.debug(
        LogCategory.SYSTEM,
        `[AutoUpdater] L2 -> L3 降级: 触发双轨 Failover 切换至备用源: ${fallbackTrack}`
      )
      this.hasTriedFailover = true
      this.isFullDownloadFallback = false
      updater.disableDifferentialDownload = false

      if (fallbackTrack === 'r2') {
        // R2-03：错误降级切换至 R2 前必须先异步解析单对象指针
        const fallbackProbe = await this.probeEndpoint('r2')
        if (fallbackProbe === 'missing') {
          this.updateState({ status: 'not-available', isMandatory: false, error: null })
          return
        }
        if (fallbackProbe === 'alive') {
          try {
            await updater.checkForUpdates()
            return
          } catch (failoverErr) {
            logger.error(LogCategory.SYSTEM, '[AutoUpdater] 备用源 R2 重试依然失败:', failoverErr)
          }
        }
      } else {
        this.configureFeedUrl(fallbackTrack)
        try {
          await updater.checkForUpdates()
          return
        } catch (failoverErr) {
          logger.error(LogCategory.SYSTEM, '[AutoUpdater] 备用源重试依然失败:', failoverErr)
        }
      }
    }

    // 全部降级路径耗尽，进入 error 终端状态
    this.updateState({
      status: 'error',
      error: errorMsg,
      isMandatory: false // A7 红线：error 事件（check/download 网络失败）绝不进入强更分支
    })
  }

  /**
   * 注册 electron-updater 原生事件流
   */
  /**
   * 重置下载停滞看门狗（工单 08 · P1）。
   * @param progressed 本次进度回调是否观测到字节净进展；有进展则重置计时，无进展则保留原计时。
   */
  private resetDownloadStallWatchdog(progressed: boolean): void {
    if (!progressed) {
      return
    }
    if (this.stallWatchdogTimer) {
      clearTimeout(this.stallWatchdogTimer)
    }
    this.stallWatchdogTimer = setTimeout(() => {
      this.stallWatchdogTimer = null
      if (this.state.status !== 'downloading') {
        return
      }
      logger.warn(
        LogCategory.SYSTEM,
        `[AutoUpdater] 下载停滞超时 (${this.DOWNLOAD_STALL_TIMEOUT_MS}ms 零字节进展)，触发降级重试`
      )
      // 视为下载阶段错误，进入 L1->L2->L3 降级链
      this.handleUpdateError(new Error('下载停滞：连接长时间无字节进展'), 'download').catch(
        () => {}
      )
    }, this.DOWNLOAD_STALL_TIMEOUT_MS)
  }

  /**
   * 停止下载停滞看门狗（下载完成/失败/取消时调用）
   */
  private stopDownloadStallWatchdog(): void {
    if (this.stallWatchdogTimer) {
      clearTimeout(this.stallWatchdogTimer)
      this.stallWatchdogTimer = null
    }
  }

  /**
   * 磁盘空间预检（工单 08 · P1）。
   * 下载前校验缓存卷剩余空间是否满足全量安装包所需，避免 ENOSPC 导致的
   * 半成品 pending 恢复包污染缓存与后续差分组装。
   * 复用 file-download-service 的 checkDiskSpace（防重复造轮子），512MB 缓冲。
   * @returns true 表示空间充足（或预检不可用）可继续；false 表示空间不足已置 error 状态。
   */
  private preflightDiskSpace(totalBytes: number): boolean {
    try {
      const cacheDir = path.dirname(app.getPath('userData'))
      const result = checkDiskSpace(cacheDir, {
        archiveBytes: totalBytes,
        maxUncompressedBytes: 0,
        extraBufferBytes: 512 * 1024 * 1024
      })
      if (!result.sufficient) {
        const availMB = Math.floor(result.availableBytes / (1024 * 1024))
        const needMB = Math.floor(result.requiredBytes / (1024 * 1024))
        logger.error(
          LogCategory.SYSTEM,
          `[AutoUpdater] 磁盘空间不足: 可用 ${availMB}MB < 所需 ${needMB}MB (含 512MB 缓冲)`
        )
        this.updateState({
          status: 'error',
          error: `磁盘空间不足：需约 ${needMB}MB，当前可用 ${availMB}MB，请清理后重试`,
          isMandatory: false // A7 红线：error 状态不进入强更分支
        })
        return false
      }
      logger.debug(
        LogCategory.SYSTEM,
        `[AutoUpdater] 磁盘空间预检通过: 可用 ${Math.floor(result.availableBytes / (1024 * 1024))}MB`
      )
      return true
    } catch (err: any) {
      // 预检自身失败（如 statfs 不可用）不应阻断下载，显式 warn 后放行
      logger.warn(LogCategory.SYSTEM, `[AutoUpdater] 磁盘空间预检跳过: ${err?.message ?? err}`)
      return true
    }
  }

  private setupUpdaterListeners(): void {
    const updater = this.getLoadedAutoUpdater()
    if (!updater) return
    updater.on('checking-for-update', () => {
      logger.debug(LogCategory.SYSTEM, '[AutoUpdater] 正在检索云端更新清单...')
      this.updateState({ status: 'checking', error: null })
    })

    updater.on('update-available', (info: UpdateInfo & { minVersion?: string }) => {
      logger.info(
        LogCategory.SYSTEM,
        `[AutoUpdater] 发现新版本: ${info.version} (当前: ${this.state.currentVersion})`
      )
      this.activeUpdateInfo = info

      // A7 · 强更三分支红线：仅当 phase==='update-available' && semver.valid(minVersion) && current<minVersion
      // 三者齐备时才触发；error 事件（check/download 网络失败）绝不进入此分支，避免离线误锁死。
      // error 事件在下方 handleUpdateError 中仅置 error 状态、isMandatory 永不被置 true。
      const isMandatory = this.evaluateMandatoryUpdate(info.minVersion)

      this.updateState({
        status: 'available',
        latestVersion: info.version,
        minVersion: info.minVersion || null,
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

    updater.on('update-not-available', (info: UpdateInfo) => {
      logger.info(LogCategory.SYSTEM, `[AutoUpdater] 已是最新版本: ${info.version}`)
      this.activeUpdateInfo = null
      this.updateState({
        status: 'not-available',
        latestVersion: info.version,
        error: null,
        progress: null,
        isMandatory: false // A7 红线：非 available 状态显式复位强更，防残留 true 误弹遮罩
      })
    })

    updater.on('download-progress', (progressObj: any) => {
      const transferred = progressObj.transferred || 0
      const lastTransferred = this.state.progress?.transferred || 0
      this.updateState({
        status: 'downloading',
        progress: {
          percent: Math.round(progressObj.percent || 0),
          transferred,
          total: progressObj.total || 0,
          bytesPerSecond: progressObj.bytesPerSecond || 0
        }
      })
      // 停滞看门狗喂狗（工单 08 · P1）：只要字节数有净进展即重置计时；
      // 捕获长时间零进展的僵死连接，触发 L1->L2/L3 降级而非无限挂起。
      this.resetDownloadStallWatchdog(transferred > lastTransferred)
    })

    updater.on('update-downloaded', (event: any) => {
      logger.info(
        LogCategory.SYSTEM,
        `[AutoUpdater] 更新包已成功下载完毕: ${event?.downloadedFile || ''}`
      )
      this.stopDownloadStallWatchdog()
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

    updater.on('error', (err: any) => {
      logger.error(LogCategory.SYSTEM, '[AutoUpdater] 监听到底层 Updater 错误:', err)
      this.stopDownloadStallWatchdog()
      this.handleUpdateError(err, this.state.status === 'downloading' ? 'download' : 'check').catch(
        () => {}
      )
    })
  }

  /**
   * 变更状态并向所有渲染窗口广播更新事件（工单 09 · P1-2 推流加固）。
   * - downloading 进度事件做 300ms 节流，避免高频 download-progress 淹没渲染进程；
   * - 终态（downloaded/error/not-available/available/installing/checking 等）立即 flush；
   * - 推送前 `webContents.isDestroyed()` 守卫，防销毁窗口崩溃。
   */
  private updateState(partial: Partial<UpdateState>): void {
    this.state = {
      ...this.state,
      ...partial
    }

    // 终态或非进度态立即 flush；仅 downloading 持续进度做节流
    const isProgressTick = this.state.status === 'downloading'
    if (!isProgressTick) {
      this.flushStateToWindows()
      return
    }

    if (this.progressThrottleTimer) {
      return // 节流窗口内，丢弃本次高频进度
    }
    this.progressThrottleTimer = setTimeout(() => {
      this.progressThrottleTimer = null
      // 节流到期时可能已切到终态，终态由自身 flush；此处仅当仍在 downloading 才补发
      if (this.state.status === 'downloading') {
        this.flushStateToWindows()
      }
    }, this.PROGRESS_THROTTLE_MS)
  }

  /**
   * 将当前状态立即广播至所有存活窗口（工单 09 · P1-2 isDestroyed 守卫 + P1-3 DTO 拆分）。
   * downloadedFilePath 仅留在 Main 进程使用，不下发渲染层（避免泄漏本地文件系统路径）。
   */
  private flushStateToWindows(): void {
    const { downloadedFilePath: _omitted, ...stateDTO } = this.state
    try {
      const wins = BrowserWindow.getAllWindows()
      for (const win of wins) {
        if (!win.isDestroyed()) {
          win.webContents.send('update:status-changed', stateDTO)
        }
      }
    } catch (err: any) {
      // 广播异常显式上报，禁止静默降级
      logger.warn(LogCategory.SYSTEM, `[AutoUpdater] 状态广播异常: ${err?.message ?? err}`)
    }
    if (this.progressThrottleTimer) {
      clearTimeout(this.progressThrottleTimer)
      this.progressThrottleTimer = null
    }
  }
}

export const autoUpdateService = AutoUpdateService.getInstance()
