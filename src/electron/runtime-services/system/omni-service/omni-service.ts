/**
 * Omni Native Service - Omni Rust 原生微服务管理器
 * （class 主体按职责块原样搬移；types/helpers 已抽至同目录子文件）
 */
import { ChildProcess, spawn } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { app, BrowserWindow, dialog, powerMonitor, shell } from 'electron'
import {
  ResourceLocator,
  logger,
  LogCategory,
  APP_PORTS,
  findAvailablePort,
  isPathEqual,
  PluginPathResolver,
  resolveActiveModelPaths,
  BUILTIN_PLUGIN_CATALOG_META,
  BuiltinSharedResourceId,
  CHILD_MODEL_ENV_KEYS_TO_PURGE,
  ServiceDiscoveryFile,
  ServiceDiscoveryFileV1,
  isPidAlive,
  SSE_CONNECT_TIMEOUT_MS,
  SSE_READ_WATCHDOG_MS,
  DORMANT_MAX_ATTEMPTS,
  ConnectedTargetIdentity,
  readWithWatchdog,
  sleepCancellable,
  SseWatchdogTimeoutError
} from '@firefly/shared'
import { MagikaFileCategory } from '@firefly/types'
import { resolveAnalysisTimeoutBudget } from '../analysis-timeout-policy'
import {
  isTransientStatusFetchError,
  isTransientStatusHttpCode,
  STATUS_VERIFY_BACKOFF_MS,
  STATUS_VERIFY_MAX_ATTEMPTS,
  STATUS_VERIFY_TIMEOUT_MS
} from './mount-verify-classify'
import { isLocalDevRuntime } from '../../../main/worktree-env'
import { OmniInstanceLock, OmniTokenManager } from '../omni-security'
import type {
  OmniRuntimeStatus,
  OmniBenchmarkResponse,
  PerceptionSlotResult,
  OmniExtractionResponse,
  OmniGeoReversePoint,
  OmniGeoReverseItem,
  OmniGeoReverseResponse,
  OmniPerceptionOptions,
  OmniExtractOptions,
  OmniPerceptionBenchmarkResponse,
  OmniTagChainItem,
  OmniResolveParentRequest,
  OmniResolveParentResponse,
  OmniRamTagItem,
  BinaryAnalysisInfo,
  OmniPerceptionResponse,
  OmniVideoChunkItem,
  OmniAudioTranscribeResponse,
  OmniAudioConvertResponse,
  OmniVisionTagsResponse,
  OmniVisionInspectResponse,
  OmniFsAdsResponse,
  OmniIndexedDocument,
  OmniIndexResponse,
  OmniFusedResult,
  OmniHybridSearchResponse,
  ClusteringMode,
  OmniClusterDocument,
  OmniClusterGroup,
  OmniClusterTreeResult,
  OmniClusterResponse,
  OmniHowNetSlot,
  OmniHowNetDescribeResult,
  OmniExtractedEntity,
  OmniStructuredSummary,
  OmniDocumentChunk,
  OmniTextAnalysisResult,
  InspectControlledTagItem,
  InspectControlledTagResult,
  InspectControlledTagsResponse
} from './types'
import { broadcastOmniStatus } from './helpers'
import {
  OmniStatusEvent,
  FireflyReadyFrame,
  parseOmniStatusEvent,
  parseFireflyReadyLine,
  verifyOmniSameOrigin
} from './omni-status-contract'
import {
  buildCoverUrl,
  buildExtractRequestBody,
  buildPerceiveRequestBody
} from './request-serialization'
import {
  isFatalNativeExitCode,
  serializeDmlCrashMarker,
  shouldForceCpuFromMarker
} from './ort-dml-crash-guard'

export class OmniService {
  private static instance: OmniService
  private process: ChildProcess | null = null
  private basePort: number = APP_PORTS.OMNI_SERVER
  private actualPort: number = APP_PORTS.OMNI_SERVER
  private baseUrl = `http://127.0.0.1:${APP_PORTS.OMNI_SERVER}`
  private isStarting = false
  private startPromise: Promise<boolean> | null = null
  private cachedVersion: string | null = null
  private restartAttempts = 0
  private maxRestartAttempts = 10
  private restartTimeout: NodeJS.Timeout | null = null
  private lastCoverDurationMs?: number
  private coverDurationMap = new Map<string, number>()
  private readyCallbacks: (() => void | Promise<void>)[] = []
  private missingBinaryReported = false
  private missingBinaryRetryAt = 0
  private binaryMissingNotified = false
  private binaryMissingNotifyDeferred = false
  private instanceLock: OmniInstanceLock | null = null
  private tokenManager: OmniTokenManager | null = null
  private isIntentionalStopping = false
  private managedLifecycleActive = false
  private currentMountManifestPath: string | null = null
  private lastExpectedMounts: {
    manifestPath: string | null
    sharedDir: string | null
    expectedResourceIds: string[]
    strict: boolean
  } | null = null
  private lastMountValidationError: string | null = null
  /** DirectML 原生崩溃标记文件路径（与主库同级；dbPath 未知时为 null） */
  private dmlCrashMarkerPath: string | null = null
  /** 是否已判定需强制纯 CPU（进程内即时生效，供自愈重试；跨进程由标记文件承载） */
  private forceCpuForNextStarts = false

  /** 开发态二进制热更新检测周期 (毫秒) */
  private static readonly DEV_BINARY_WATCH_INTERVAL_MS = 3_000
  /** 本服务已拉起二进制的签名 (mtimeMs:size) */
  private spawnedBinarySignature: string | null = null
  /** 最近一次成功拉起子进程的时间戳，用于启动冷静期保护 */
  private lastSpawnedAt = 0
  /** 热更新待确认的候选签名 */
  private pendingUpdateSignature: string | null = null
  /** 候选签名首次被发现的时间戳（用于防抖稳定期判断） */
  private pendingUpdateSince = 0
  /** 开发态二进制热更新轮询定时器 */
  private devBinaryWatchTimer: NodeJS.Timeout | null = null
  /** 密钥代次失配防重复弹窗标志 */
  private isKeyEpochMismatchPrompted = false

  // —— 跨模块服务发现与零轮询 SSE 单循环状态机字段 (Spec v2.3) ——
  private static readonly OFFLINE_CONFIRM_FAILURES = 3
  private discoveryFile: ServiceDiscoveryFile | null = null
  private discoveryWatchDispose: (() => void) | null = null
  private stopController: AbortController = new AbortController()
  private stopEpoch = 0
  private connectionEpoch = 0
  private activeLoopEpoch: number | null = null
  private eventStreamAbortController: AbortController | null = null
  private reconnectAbortController: AbortController | null = null
  private connectedTarget: ConnectedTargetIdentity | null = null
  private expectedIdentity: { pid?: number; instanceId?: string; port?: number } | null = null
  private consecutiveFailures = 0
  private lastAppliedRevision = 0
  private lastAppliedInstanceId: string | null = null
  private lastStatusEvent: OmniStatusEvent | null = null
  private stopPromise: Promise<void> | null = null
  private expectedMasterDbPath: string | null = null
  private expectedVectorsDir: string | null = null
  private powerResumeListener: (() => void) | null = null

  /** 解析并缓存 DirectML 崩溃标记文件路径（与主库同级；dbPath 未知时沿用上次缓存）。 */
  private resolveDmlCrashMarker(dbPath: string | null | undefined): string | null {
    if (dbPath) {
      this.dmlCrashMarkerPath = path.join(path.dirname(dbPath), '.omni-dml-crash.json')
    }
    return this.dmlCrashMarkerPath
  }

  private readTextFileSafe(file: string): string | null {
    try {
      return fs.readFileSync(file, 'utf8')
    } catch {
      return null
    }
  }

  /**
   * 持久化 DirectML 原生崩溃标记，并在本进程内立即生效（后续 `start()` 直接走纯 CPU）。
   * 写入失败不阻断（仅告警）：跨进程兜底失效时，本次进程内重试仍会强制 CPU。
   */
  private persistDmlCrash(marker: string | null): void {
    this.forceCpuForNextStarts = true
    if (!marker) return
    try {
      fs.writeFileSync(marker, serializeDmlCrashMarker(Date.now()), 'utf8')
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[OmniService] 写入 DirectML 崩溃标记失败:', err)
    }
  }

  /**
   * 拦截处理 Omni KeyEpoch 失配，触发前端大白话 UX 提示与系统通知 (Ticket 07)
   */
  private handleKeyEpochMismatch(detail: string): void {
    if (this.isKeyEpochMismatchPrompted) return
    this.isKeyEpochMismatchPrompted = true

    const userMessage = '该功能组件版本与当前软件不匹配，请重新导入最新离线总包或更新客户端。'

    try {
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send('plugin:key-epoch-mismatch', {
            message: userMessage,
            detail
          })
        }
      }
    } catch {}

    try {
      dialog.showErrorBox('功能组件版本不匹配', userMessage)
    } catch {}
  }

  /**
   * 注册 Omni 服务启动/重启就绪回调
   * 用于在 Omni 进程初次就绪或崩溃重启恢复时触发自定义音色重注册等动作
   */
  public onReady(callback: () => void | Promise<void>): void {
    this.readyCallbacks.push(callback)
    if (this.process && !this.process.killed && !this.isStarting) {
      Promise.resolve(callback()).catch(err => {
        logger.warn(LogCategory.SYSTEM, '[OmniService] onReady 回调执行异常:', err)
      })
    }
  }

  private notifyReady(): void {
    for (const cb of this.readyCallbacks) {
      try {
        Promise.resolve(cb()).catch(err => {
          logger.warn(LogCategory.SYSTEM, '[OmniService] onReady 回调执行异常:', err)
        })
      } catch (err) {
        logger.warn(LogCategory.SYSTEM, '[OmniService] onReady 同步调用异常:', err)
      }
    }
  }

  private constructor() {
    try {
      if (app && typeof app.on === 'function') {
        app.on('will-quit', () => {
          this.stopDevBinaryWatch()
          this.stopImmediatelySync()
        })
        app.on('before-quit', () => {
          this.stopDevBinaryWatch()
          // 正常退出走两阶段优雅停机（与 main/index.ts 中的 await omniService.stop() 通过 stopPromise 合并去重），
          // 避免抢跑强杀短路 Rust 侧 stopping 终帧与 omni-config.json 自删
          void this.stop()
        })
      }

      // 注册 Node.js 进程级退出事件（针对开发模式下 Ctrl+C 或终端被杀）
      const cleanExit = () => {
        this.stopDevBinaryWatch()
        this.stopImmediatelySync()
      }
      process.once('exit', cleanExit)
      process.once('SIGINT', cleanExit)
      process.once('SIGTERM', cleanExit)

      // 注册系统休眠唤醒（powerMonitor.resume）与 userData/run/omni-config.json 目录监听
      this.registerPowerResumeWakeup()
      this.mountDiscoveryWatcher()

      // 开发模式下开机常驻监听 Omni 原生二进制热更新（感知 omni-build-to-desktop.js --watch 的重编译与部署）
      if (isLocalDevRuntime()) {
        this.startDevBinaryWatch()
      }
      if (process.platform === 'win32') {
        process.once('message', (msg: any) => {
          if (msg === 'shutdown') {
            this.stopImmediatelySync()
          }
        })
      }

      // 监听 Desktop 端 OCR 与分析相关的 ConfigKey 变更，实时自动推送到 Omni
      import('../../../config/config-orchestrator')
        .then(({ ConfigOrchestrator }) => {
          const orchestrator = ConfigOrchestrator.getInstance()
          // 注意：VIDEO_SOFT_TOKEN_BUDGET 不在此列——它是逐请求参数（随 perceive 请求体透传），不进全局 OmniConfig
          const ocrKeys = [
            'ENABLE_IMAGE_OCR',
            'ENABLE_DOCUMENT_OCR',
            'MAX_DOCUMENT_OCR_ITEMS',
            'ENABLE_OFFICE_COVER',
            'OCR_MODEL_SIZE',
            'MAX_DOCUMENT_OCR_FILE_SIZE',
            'MAX_CONTENT_SIZE_KB',
            'MAX_FILE_SIZE',
            'ANALYSIS_MODE',
            'REUSE_BASIC_ANALYSIS_DATA',
            // 抽帧间隔已由引擎按预算自决，不再进配置监听；语音识别时长仍需同步为引擎默认值
            'AUDIO_ANALYSIS_DURATION'
          ] as const
          ocrKeys.forEach(key => {
            orchestrator.onValueChange(key as any, () => {
              this.syncConfigFromDesktop().catch(() => {})
            })
          })

          // 监听多模态嵌入档位与 MRL 维度变更，执行优雅热重启并切换运行时
          orchestrator.onValueChange('AI_EMBEDDING_PROFILE' as any, async (newVal, oldVal) => {
            if (newVal && oldVal && newVal !== oldVal) {
              logger.info(
                LogCategory.SYSTEM,
                `[OmniService] 检测到 AI_EMBEDDING_PROFILE 变更 (${oldVal} -> ${newVal})，正在优雅重启 Omni 服务...`
              )
              await this.restart()
            }
          })
          orchestrator.onValueChange('EMBEDDING_MRL_DIMENSION' as any, async (newVal, oldVal) => {
            if (newVal && oldVal && newVal !== oldVal) {
              logger.info(
                LogCategory.SYSTEM,
                `[OmniService] 检测到 EMBEDDING_MRL_DIMENSION 变更 (${oldVal} -> ${newVal})，正在优雅重启 Omni 服务...`
              )
              await this.restart()
            }
          })
        })
        .catch(() => {})
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

  /** 获取最近一次经 SSE 采纳的 Omni 状态事件快照 */
  public getLastStatusEvent(): OmniStatusEvent | null {
    return this.lastStatusEvent
  }

  /** 当前是否处于 Dormant 静默挂起态（无活跃 SSE 流循环） */
  public isDormant(): boolean {
    return this.activeLoopEpoch === null && this.connectedTarget === null
  }

  /** 解析 Desktop userData 绝对路径 */
  private resolveUserDataDir(): string | null {
    try {
      if (app && typeof app.getPath === 'function') {
        const dir = app.getPath('userData')
        if (dir) return dir
      }
    } catch {}
    if (process.env.FIREFLY_USER_DATA_DIR?.trim()) {
      return process.env.FIREFLY_USER_DATA_DIR.trim()
    }
    return null
  }

  /** 惰性获取 `userData/run/omni-config.json` 发现文件管理器 */
  private getDiscoveryFile(): ServiceDiscoveryFile | null {
    if (this.discoveryFile) {
      return this.discoveryFile
    }
    const userDataPath = this.resolveUserDataDir()
    if (!userDataPath) {
      return null
    }
    this.discoveryFile = new ServiceDiscoveryFile({
      fileName: 'omni-config.json',
      serviceId: 'firefly-omni-server',
      userDataPath
    })
    return this.discoveryFile
  }

  /** 挂载 `userData/run/omni-config.json` 单例 DirWatcher 监听 */
  private mountDiscoveryWatcher(): void {
    if (this.discoveryWatchDispose) {
      return
    }
    const df = this.getDiscoveryFile()
    if (!df) {
      return
    }
    this.discoveryWatchDispose = df.watch(info => {
      this.handleDiscoveryFileChanged(info)
    })
  }

  /** 卸载 `userData/run/omni-config.json` 目录监听 */
  private unmountDiscoveryWatcher(): void {
    if (this.discoveryWatchDispose) {
      try {
        this.discoveryWatchDispose()
      } catch {}
      this.discoveryWatchDispose = null
    }
  }

  /** 注册系统休眠唤醒（powerMonitor.resume）纯事件唤醒源 */
  private registerPowerResumeWakeup(): void {
    if (this.powerResumeListener) return
    try {
      if (powerMonitor && typeof powerMonitor.on === 'function') {
        const listener = () => {
          logger.info(
            LogCategory.SYSTEM,
            '[OmniService] 检测到系统从休眠唤醒 (powerMonitor.resume)，重读发现文件并唤醒 SSE'
          )
          this.mountDiscoveryWatcher()
          this.syncFromDiscoveryFileOnce({ resetFailures: true })
        }
        this.powerResumeListener = listener
        powerMonitor.on('resume', listener)
      }
    } catch {}
  }

  /** 单次重读 `userData/run/omni-config.json` 并按需触发 SSE 重连（供 resume / 焦点刷新等事件源使用） */
  public syncFromDiscoveryFileOnce(options?: { resetFailures?: boolean }): void {
    if (this.stopController.signal.aborted || this.isIntentionalStopping) {
      return
    }
    const df = this.getDiscoveryFile()
    const info = df?.read({ verifyPid: true }) ?? null
    if (info) {
      this.handleDiscoveryFileChanged(info, options?.resetFailures ?? true)
    } else if (this.process && !this.process.killed) {
      this.kickEventStreamReconnect({ resetFailures: options?.resetFailures ?? true })
    }
  }

  /** 处理发现文件变更事件：严格按「校验同源 → 先更新端口与预期身份 → 后 kick」顺序执行 */
  private handleDiscoveryFileChanged(
    info: ServiceDiscoveryFileV1 | null,
    resetFailures = true
  ): void {
    if (this.stopController.signal.aborted || this.isIntentionalStopping) {
      return
    }

    if (!info) {
      // 文件被删除：若当前 SSE 仍健康在线，不立刻中断健康连接；若已断开且无受管进程则转离线 Dormant
      if (!this.isCurrentTargetHealthy() && (!this.process || this.process.killed)) {
        this.applyOffline()
      }
      return
    }

    const originCheck = verifyOmniSameOrigin(
      {
        port: info.port,
        pid: info.pid,
        userDataDir: info.userDataDir,
        masterDbPath: info.masterDbPath,
        targetVectorsDir: info.targetVectorsDir
      },
      {
        userDataDir: this.resolveUserDataDir(),
        masterDbPath: this.expectedMasterDbPath,
        targetVectorsDir: this.expectedVectorsDir
      }
    )
    if (!originCheck.ok) {
      logger.warn(
        LogCategory.SYSTEM,
        `[OmniService] 发现文件同源校验未通过，拒绝采纳 (port=${info.port}, pid=${info.pid}): ${originCheck.reason}`
      )
      return
    }
    if (originCheck.warning) {
      logger.warn(LogCategory.SYSTEM, `[OmniService] ${originCheck.warning}`)
    }

    // 严禁先 kick 后改端口导致被 no-op 守卫吞掉
    this.actualPort = info.port
    this.baseUrl = info.baseUrl
    this.expectedIdentity = {
      pid: info.pid,
      instanceId: info.instanceId,
      port: info.port
    }
    this.kickEventStreamReconnect({
      expectedTarget: {
        baseUrl: info.baseUrl,
        pid: info.pid,
        instanceId: info.instanceId
      },
      resetFailures
    })
  }

  /** 8 阶段双代际归属校验：彻底阻断旧连接延迟回调覆盖新连接状态 */
  private isCurrentOwner(myEpoch: number, myStopEpoch: number): boolean {
    return (
      myEpoch === this.connectionEpoch &&
      myStopEpoch === this.stopEpoch &&
      !this.stopController.signal.aborted
    )
  }

  /** 判断当前 SSE 连接是否针对当前目标健康在线 */
  private isCurrentTargetHealthy(expectedTarget?: ConnectedTargetIdentity): boolean {
    if (!this.eventStreamAbortController || this.eventStreamAbortController.signal.aborted) {
      return false
    }
    if (!this.connectedTarget) {
      return false
    }
    if (!expectedTarget) {
      return this.connectedTarget.baseUrl === this.baseUrl
    }
    if (this.connectedTarget.baseUrl !== expectedTarget.baseUrl) {
      return false
    }
    if (
      typeof expectedTarget.pid === 'number' &&
      this.connectedTarget.pid !== expectedTarget.pid
    ) {
      return false
    }
    if (expectedTarget.instanceId && this.connectedTarget.instanceId !== expectedTarget.instanceId) {
      return false
    }
    return true
  }

  /** 确保单循环 SSE 状态流已建立（幂等入口） */
  public ensureEventStream(): void {
    if (this.stopController.signal.aborted || this.isIntentionalStopping) {
      return
    }
    if (this.isCurrentTargetHealthy()) {
      return
    }
    if (this.activeLoopEpoch !== null) {
      return
    }
    const myEpoch = ++this.connectionEpoch
    this.activeLoopEpoch = myEpoch
    void this.runStreamLoop(myEpoch, this.stopEpoch)
  }

  /** 事件驱动抢占重连（支持三元组身份比对与失败计数重置） */
  public kickEventStreamReconnect(options?: {
    expectedTarget?: ConnectedTargetIdentity
    resetFailures?: boolean
  }): void {
    if (this.stopController.signal.aborted || this.isIntentionalStopping) {
      return
    }
    if (this.isCurrentTargetHealthy(options?.expectedTarget)) {
      return
    }
    if (options?.resetFailures) {
      this.consecutiveFailures = 0
    }
    this.eventStreamAbortController?.abort()
    this.reconnectAbortController?.abort()
    this.connectedTarget = null
    const myEpoch = ++this.connectionEpoch
    this.activeLoopEpoch = myEpoch
    void this.runStreamLoop(myEpoch, this.stopEpoch)
  }

  /** 单循环 SSE 状态驱动器（10s Connect + 35s Read 双阶看门狗 + DORMANT_MAX_ATTEMPTS=5 有界退避） */
  private async runStreamLoop(myEpoch: number, myStopEpoch: number): Promise<void> {
    try {
      while (this.isCurrentOwner(myEpoch, myStopEpoch)) {
        const outcome = await this.connectOnce(myEpoch, myStopEpoch)
        if (!this.isCurrentOwner(myEpoch, myStopEpoch)) {
          return
        }

        if (outcome === 'stopping') {
          // 收到服务端 stopping 终帧：立即离线并进入 Dormant，不再对正在停机的进程做退避重连
          this.applyOffline()
          return
        }

        if (outcome === 'eof') {
          // 正常 EOF 后：先检查受管进程或发现文件是否仍存活
          const dfInfo = this.getDiscoveryFile()?.read({ verifyPid: true }) ?? null
          const hasManagedChild = Boolean(this.process && !this.process.killed && this.process.exitCode === null)
          if (!hasManagedChild && !dfInfo) {
            this.applyOffline()
            return
          }
        }

        this.consecutiveFailures++

        // Dormant 准入判断 1：无受管子进程且发现文件缺失或 PID 已失活 → 立即转离线 Dormant（0 定时器、0 网络请求）
        const hasManagedChild = Boolean(
          this.process && !this.process.killed && this.process.exitCode === null
        )
        const dfInfo = this.getDiscoveryFile()?.read({ verifyPid: false }) ?? null
        const discoveryPidAlive = dfInfo ? isPidAlive(dfInfo.pid) : false
        if (!hasManagedChild && (!dfInfo || !discoveryPidAlive)) {
          this.applyOffline()
          return
        }

        if (this.consecutiveFailures >= OmniService.OFFLINE_CONFIRM_FAILURES) {
          this.applyOffline()
        }

        // Dormant 准入判断 2：达到 DORMANT_MAX_ATTEMPTS (5) 次有界退避上限 → 强制退出循环转静默 Dormant
        if (this.consecutiveFailures >= DORMANT_MAX_ATTEMPTS) {
          logger.warn(
            LogCategory.SYSTEM,
            `[OmniService] SSE 连续重连失败达上限 (${DORMANT_MAX_ATTEMPTS} 次)，进入 Dormant 静默挂起态等待事件唤醒`
          )
          this.applyOffline()
          return
        }

        const baseDelay = Math.min(1000 * Math.pow(2, this.consecutiveFailures - 1), 16_000)
        const jitter = Math.floor(Math.random() * 500)
        const reconnectAc = new AbortController()
        this.reconnectAbortController = reconnectAc
        const stopSignal = this.stopController.signal
        const onStop = () => reconnectAc.abort()
        stopSignal.addEventListener('abort', onStop, { once: true })

        let wokeNaturally = false
        try {
          wokeNaturally = await sleepCancellable(baseDelay + jitter, reconnectAc.signal)
        } finally {
          stopSignal.removeEventListener('abort', onStop)
          if (this.reconnectAbortController === reconnectAc) {
            this.reconnectAbortController = null
          }
        }

        if (!wokeNaturally || !this.isCurrentOwner(myEpoch, myStopEpoch)) {
          return
        }
      }
    } finally {
      if (this.activeLoopEpoch === myEpoch) {
        this.activeLoopEpoch = null
      }
    }
  }

  /** 执行单次 SSE 建连与流读取（严格落实 10s Connect + 35s Read 看门狗与锁释放顺序） */
  private async connectOnce(
    myEpoch: number,
    myStopEpoch: number
  ): Promise<'stopping' | 'eof' | 'failed'> {
    if (!this.isCurrentOwner(myEpoch, myStopEpoch)) {
      return 'failed'
    }

    const targetBaseUrl = this.baseUrl
    const targetPort = this.actualPort
    const expectedPid = this.expectedIdentity?.pid ?? this.process?.pid
    const myAc = new AbortController()
    this.eventStreamAbortController = myAc

    const stopSignal = this.stopController.signal
    const onStop = () => myAc.abort()
    stopSignal.addEventListener('abort', onStop, { once: true })

    // 阶段一：建连 10s 一次性看门狗（显式 setTimeout 兼容 Vitest fake timers）
    let connectTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      myAc.abort(new SseWatchdogTimeoutError('connect', SSE_CONNECT_TIMEOUT_MS))
    }, SSE_CONNECT_TIMEOUT_MS)

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    let receivedValidFrame = false

    try {
      const res = await fetch(`${targetBaseUrl}/api/v1/omni/events`, {
        headers: { Accept: 'text/event-stream' },
        signal: myAc.signal
      })

      if (connectTimer !== null) {
        clearTimeout(connectTimer)
        connectTimer = null
      }

      if (!this.isCurrentOwner(myEpoch, myStopEpoch)) {
        return 'failed'
      }
      if (!res.ok || !res.body) {
        return 'failed'
      }

      reader = res.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let lineBuffer = ''
      let dataLines: string[] = []

      while (this.isCurrentOwner(myEpoch, myStopEpoch)) {
        // 阶段二：流内每次 reader.read() 独立 35s 看门狗
        const { done, value } = await readWithWatchdog(reader, SSE_READ_WATCHDOG_MS, myAc.signal)
        if (!this.isCurrentOwner(myEpoch, myStopEpoch)) {
          return receivedValidFrame ? 'eof' : 'failed'
        }
        if (done) {
          return receivedValidFrame ? 'eof' : 'failed'
        }
        if (!value || value.byteLength === 0) {
          continue
        }

        lineBuffer += decoder.decode(value, { stream: true })
        const lines = lineBuffer.split(/\r?\n/)
        lineBuffer = lines.pop() ?? ''

        for (const line of lines) {
          if (line === '') {
            if (dataLines.length > 0) {
              const payloadStr = dataLines.join('\n')
              dataLines = []
              const evt = parseOmniStatusEvent(payloadStr)
              if (!evt) {
                continue
              }

              // 同源身份强制校验（防跨 Worktree 串连与 PID 复用）
              const originCheck = verifyOmniSameOrigin(
                {
                  port: evt.port,
                  pid: evt.pid,
                  userDataDir: evt.userDataDir,
                  masterDbPath: evt.masterDbPath,
                  targetVectorsDir: evt.targetVectorsDir
                },
                {
                  expectedPort: targetPort,
                  expectedPid,
                  userDataDir: this.resolveUserDataDir(),
                  masterDbPath: this.expectedMasterDbPath,
                  targetVectorsDir: this.expectedVectorsDir
                }
              )
              if (!originCheck.ok) {
                logger.warn(
                  LogCategory.SYSTEM,
                  `[OmniService] SSE 状态帧同源校验失败，拒绝采纳并断开连接: ${originCheck.reason}`
                )
                return 'failed'
              }
              if (originCheck.warning) {
                logger.warn(LogCategory.SYSTEM, `[OmniService] ${originCheck.warning}`)
              }

              if (!this.isCurrentOwner(myEpoch, myStopEpoch)) {
                return receivedValidFrame ? 'eof' : 'failed'
              }

              receivedValidFrame = true
              this.applyStatusEvent(evt, targetBaseUrl)
              if (evt.status === 'stopping') {
                return 'stopping'
              }
            }
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).trimStart())
          }
          // 以 ':' 开头的空注释帧 (:\n\n) 已通过 byteLength > 0 刷新 35s 读看门狗，无需额外解析
        }
      }

      return receivedValidFrame ? 'eof' : 'failed'
    } catch (err: any) {
      if (this.isCurrentOwner(myEpoch, myStopEpoch)) {
        logger.debug(
          LogCategory.SYSTEM,
          `[OmniService] SSE 连接中断 (${targetBaseUrl}): ${err?.message || err}`
        )
      }
      return receivedValidFrame ? 'eof' : 'failed'
    } finally {
      if (connectTimer !== null) {
        clearTimeout(connectTimer)
        connectTimer = null
      }
      stopSignal.removeEventListener('abort', onStop)
      // 锁死释放顺序：myAc.abort() -> await reader.cancel().catch() -> reader.releaseLock()
      myAc.abort()
      if (reader) {
        await reader.cancel().catch(() => {})
        try {
          reader.releaseLock()
        } catch {}
      }
      if (this.eventStreamAbortController === myAc) {
        this.eventStreamAbortController = null
      }
      if (this.isCurrentOwner(myEpoch, myStopEpoch)) {
        this.connectedTarget = null
      }
    }
  }

  /** 应用经同源校验的 SSE 状态帧：按 instanceId + revision 严格保序 */
  private applyStatusEvent(evt: OmniStatusEvent, targetBaseUrl: string): void {
    if (evt.instanceId !== this.lastAppliedInstanceId) {
      this.lastAppliedInstanceId = evt.instanceId
      this.lastAppliedRevision = 0
    }
    if (evt.revision <= this.lastAppliedRevision) {
      return
    }

    this.lastAppliedRevision = evt.revision
    this.lastStatusEvent = evt
    this.consecutiveFailures = 0
    this.connectedTarget = {
      baseUrl: targetBaseUrl,
      pid: evt.pid,
      instanceId: evt.instanceId
    }

    const running = evt.status === 'ok'
    if (running && evt.version) {
      this.cachedVersion = evt.version
    }
    broadcastOmniStatus({
      running,
      version: running && evt.version && evt.version !== '0.1.0' ? evt.version : null
    })
  }

  /** 标记离线并向渲染进程广播（stop 期间抑制重复闪烁） */
  private applyOffline(): void {
    this.connectedTarget = null
    this.lastStatusEvent = null
    if (!this.isIntentionalStopping) {
      broadcastOmniStatus({ running: false, version: null })
    }
  }

  /**
   * 基于当前状态快照推送至渲染进程（omni:status-changed），不再主动发起周期轮询探活
   */
  private async pushStatus(): Promise<void> {
    if (this.lastStatusEvent && this.lastStatusEvent.status === 'ok') {
      const v = this.lastStatusEvent.version
      broadcastOmniStatus({ running: true, version: v && v !== '0.1.0' ? v : null })
      return
    }
    const running = await this.checkHealth()
    let version: string | null = null
    if (running) {
      const v = this.cachedVersion
      version = v && v !== '0.1.0' ? v : null
    }
    broadcastOmniStatus({ running, version })
  }

  /**
   * 获取 Omni 引擎版本号
   */
  public async getVersion(): Promise<string> {
    if (this.cachedVersion) {
      return this.cachedVersion
    }
    try {
      await this.ensureRunning()
      const res = await fetch(`${this.baseUrl}/api/version`, {
        signal: AbortSignal.timeout(2000)
      })
      if (res.ok) {
        const data = await res.json()
        if (data && typeof data.version === 'string') {
          this.cachedVersion = data.version
          return data.version
        }
      }
    } catch {}
    return this.cachedVersion || '0.1.0'
  }

  /**
   * 同步判定 Omni 服务是否已处于就绪运行态（无异步阻塞开销，供实时交互/快速检索 fast-fail 判定）
   */
  public isReady(): boolean {
    return Boolean(
      this.process && !this.process.killed && !this.isStarting && this.cachedVersion !== null
    )
  }

  /**
   * 检查 Omni 服务是否处于运行状态（isReady 的友好别名）
   */
  public isServiceRunning(): boolean {
    return this.isReady()
  }

  /**
   * 确保 Omni 服务处于运行与就绪状态（若未运行则自动按需拉起）
   */
  public async ensureRunning(): Promise<boolean> {
    if (await this.checkHealth()) {
      return true
    }
    return this.start()
  }

  /**
   * 计算二进制签名（mtimeMs + size）。
   * 集成目录被 `omni:deploy:watch` / `scripts/omni-build-to-desktop.js --watch` 覆盖后签名必然变化，用于判断是否需要重启引擎。
   */
  private binarySignature(exePath: string): string | null {
    try {
      const st = fs.statSync(exePath)
      return `${st.mtimeMs}:${st.size}`
    } catch {
      return null
    }
  }

  /**
   * 启动开发态二进制热更新监听。
   *
   * `pnpm omni:deploy:watch` / `node scripts/omni-build-to-desktop.js --watch`
   * 会在重编译后覆盖集成目录中的 exe。
   * 这里周期比对签名，发现变化且持续稳定后自动重启 Omni 引擎。
   * 生产环境不启动该监听（打包产物不会被就地覆盖）。
   */

  /** 安全惰性获取 ConfigOrchestrator 中的配置值，避免顶层同步导入 electron-conf 破坏单测 */
  private getConfigValue<T>(key: string): T | undefined {
    try {
      const req = typeof require !== 'undefined' ? require : eval('require')
      return req('../../../config/config-orchestrator')
        ?.ConfigOrchestrator?.getInstance?.()
        ?.getValue?.(key)
    } catch {
      return undefined
    }
  }

  public startDevBinaryWatch(intervalMs: number = OmniService.DEV_BINARY_WATCH_INTERVAL_MS): void {
    const isDev = isLocalDevRuntime()
    if (this.devBinaryWatchTimer || !isDev) {
      return
    }
    this.devBinaryWatchTimer = setInterval(() => {
      void this.checkBinaryUpdated()
    }, intervalMs)
    this.devBinaryWatchTimer.unref?.()
    logger.debug(
      LogCategory.SYSTEM,
      `[OmniService] 已开启 Omni 引擎二进制热更新监听（每 ${intervalMs}ms 比对部署产物）`
    )
  }

  /** 停止开发态二进制热更新监听 */
  public stopDevBinaryWatch(): void {
    if (this.devBinaryWatchTimer) {
      clearInterval(this.devBinaryWatchTimer)
      this.devBinaryWatchTimer = null
    }
  }

  /**
   * 比对当前二进制签名与本服务拉起时的签名；变化且稳定后自动重启 Omni 引擎。
   */
  private async checkBinaryUpdated(): Promise<void> {
    if (this.isStarting) {
      return
    }
    // 启动冷静期（15秒）：若子进程存在且刚启动不久，给其足够的稳定初始化时间
    if (this.process && this.lastSpawnedAt > 0 && Date.now() - this.lastSpawnedAt < 15_000) {
      return
    }
    const exePath = this.resolveOmniExecutable()
    if (!exePath) {
      return
    }
    const signature = this.binarySignature(exePath)
    if (!signature) {
      this.pendingUpdateSignature = null
      this.pendingUpdateSince = 0
      return
    }

    // 关键防御：若尚未记录过已拉起的二进制签名，直接以当前二进制签名作为基准，绝不能误判为产物更新去触发 restart()
    if (!this.spawnedBinarySignature) {
      this.spawnedBinarySignature = signature
      this.pendingUpdateSignature = null
      this.pendingUpdateSince = 0
      return
    }

    if (signature === this.spawnedBinarySignature) {
      this.pendingUpdateSignature = null
      this.pendingUpdateSince = 0
      return
    }

    // 首次检测到签名变更：进入待定状态，防抖保护
    if (this.pendingUpdateSignature !== signature) {
      this.pendingUpdateSignature = signature
      this.pendingUpdateSince = Date.now()
      return
    }

    // 连续两次检测到相同新签名，且持续稳定至少 3 秒（确保外部编译与文件复制彻底落盘）
    if (Date.now() - this.pendingUpdateSince < 3_000) {
      return
    }

    const previous = this.spawnedBinarySignature
    this.spawnedBinarySignature = signature
    this.pendingUpdateSignature = null
    this.pendingUpdateSince = 0

    logger.info(
      LogCategory.SYSTEM,
      `[OmniService] 🔄 检测到 Omni 引擎二进制产物更新（${previous ?? '初始'} → ${signature}），正在重新拉起...`
    )
    this.restartAttempts = 0
    await this.restart()
  }

  /**
   * 定位 firefly-omni 可执行文件
   */
  public resolveOmniExecutable(): string | null {
    const isWin = process.platform === 'win32'
    const exeName = isWin ? 'firefly-omni.exe' : 'firefly-omni'
    const isDev = isLocalDevRuntime()
    const root = process.cwd()

    // 1. 生产或已部署环境：通过 ResourceLocator 检索
    const bin =
      ResourceLocator.resolveBin('omni/firefly-omni') || ResourceLocator.resolveBin('firefly-omni')
    if (bin && fs.existsSync(bin)) {
      return bin
    }

    // 2. 本地开发环境下，优先检索最新由 cargo 编译的 target/debug 或 target/release 原生二进制
    if (isDev) {
      const devCandidates = [
        path.join(root, 'apps', 'omni', 'target', 'debug', exeName),
        path.join(root, 'apps', 'omni', 'target', 'release', exeName)
      ]
      for (const cand of devCandidates) {
        if (fs.existsSync(cand)) {
          return cand
        }
      }
    }

    // 3. 多候选路径兜底检索
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
   * 启动并守护 firefly-omni 子进程（支持并发 Promise 合并）
   */

  private describeBinarySearch(): string {
    const isWin = process.platform === 'win32'
    const exeName = isWin ? 'firefly-omni.exe' : 'firefly-omni'
    const lines: string[] = []

    let baseDir = '(未知)'
    try {
      baseDir = ResourceLocator.getBaseResourceDir()
    } catch (err: any) {
      logger.warn(
        LogCategory.SYSTEM,
        `[OmniService] 资源根目录解析失败，无法给出精确的组件路径: ${err?.message || err}`
      )
    }
    lines.push(`资源根目录=${baseDir}`)
    lines.push(`resourcesPath=${(process as any).resourcesPath || '(未知)'}`)
    let appPath = '(未知)'
    try {
      appPath = typeof app.getAppPath === 'function' ? app.getAppPath() : '(不可用)'
    } catch {}
    lines.push(`appPath=${appPath}`)

    if (baseDir === '(未知)') {
      lines.push('资源根目录解析失败，无法枚举 bin 目录（疑似路径解析异常，而非组件缺失）')
    } else {
      try {
        const binDir = path.join(baseDir, 'bin')
        const omniDir = path.join(binDir, 'omni')
        lines.push(`bin目录存在=${fs.existsSync(binDir)}`)
        lines.push(`bin/omni目录存在=${fs.existsSync(omniDir)}`)
        if (fs.existsSync(omniDir)) {
          const siblings = fs.readdirSync(omniDir).slice(0, 20).join(', ')
          lines.push(`bin/omni目录内容=[${siblings || '空'}]`)
        }
      } catch (err: any) {
        lines.push(`目录枚举失败=${err?.message || err}`)
      }
    }

    lines.push(`候选文件=${exeName} 均不存在`)
    lines.push(
      '常见原因：① 杀毒软件把 firefly-omni.exe 隔离/删除；② 安装包不完整或更新中断；③ 安装目录被手动清理。'
    )
    return lines.join(' | ')
  }

  private notifyBinaryMissing(): void {
    if (this.binaryMissingNotified) return
    try {
      if (typeof app.isReady === 'function' && !app.isReady()) {
        if (!this.binaryMissingNotifyDeferred && typeof app.whenReady === 'function') {
          this.binaryMissingNotifyDeferred = true
          void app
            .whenReady()
            .then(() => this.notifyBinaryMissing())
            .catch(() => {})
        }
        return
      }
    } catch {}

    const isWin = process.platform === 'win32'
    const exeName = isWin ? 'firefly-omni.exe' : 'firefly-omni'

    let baseDir = ''
    try {
      baseDir = ResourceLocator.getBaseResourceDir()
    } catch (err: any) {
      logger.warn(
        LogCategory.SYSTEM,
        `[OmniService] 组件缺失提示：资源根目录解析失败: ${err?.message || err}`
      )
    }
    const omniDir = baseDir ? path.join(baseDir, 'bin', 'omni') : ''
    const exePath = omniDir ? path.join(omniDir, exeName) : exeName

    let dirState: 'exists' | 'missing' | 'unknown' = 'unknown'
    if (omniDir) {
      try {
        dirState = fs.existsSync(omniDir) ? 'exists' : 'missing'
      } catch (err: any) {
        logger.warn(
          LogCategory.SYSTEM,
          `[OmniService] 组件缺失提示：无法判断组件目录是否存在: ${err?.message || err}`
        )
      }
    }

    const detail = [
      '检索式引擎组件缺失，文件分析能力受限',
      '',
      '缺失的文件：',
      exePath,
      '',
      '建议按以下顺序处理：',
      '1. 打开杀毒软件的「隔离区 / 恢复区」，找到 firefly-omni.exe 并恢复；',
      '2. 将上面的组件目录加入杀毒软件白名单（信任区）；',
      '3. 若文件已无法恢复，请重新安装或修复安装本应用。',
      '',
      '本应用不会自动下载该组件。修复后无需重启，约 1 分钟内会自动恢复。'
    ].join('\n')

    this.binaryMissingNotified = true
    try {
      const shown = dialog?.showMessageBox({
        type: 'warning',
        title: '检索式引擎组件缺失',
        message: '检索式引擎组件缺失，文件分析能力受限',
        detail,
        buttons: ['打开组件目录', '知道了'],
        defaultId: 0,
        cancelId: 1,
        noLink: true
      })
      void shown
        ?.then?.((result: any) => {
          if (result?.response !== 0) return
          const target = dirState === 'exists' && omniDir ? omniDir : baseDir
          if (!target) return
          void shell?.openPath?.(target)
        })
        ?.catch?.(() => {
          this.binaryMissingNotified = false
        })
    } catch (err: any) {
      this.binaryMissingNotified = false
    }
  }

  public async start(): Promise<boolean> {
    if (this.process && !this.process.killed) {
      if (await this.checkHealth()) {
        return true
      }
      if (this.isStarting && this.startPromise) {
        return this.startPromise
      }
    }

    if (this.startPromise) {
      return this.startPromise
    }

    this.startPromise = this.doStart()
    try {
      return await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  private async doStart(): Promise<boolean> {
    if (this.stopPromise) {
      await this.stopPromise.catch(() => {})
    }
    if (this.stopController.signal.aborted) {
      this.stopController = new AbortController()
    }
    this.mountDiscoveryWatcher()
    this.consecutiveFailures = 0
    this.lastAppliedRevision = 0
    this.lastAppliedInstanceId = null
    this.managedLifecycleActive = true
    this.isIntentionalStopping = false
    this.isStarting = true
    this.lastMountValidationError = null
    // 缺失冷却检查：避免每个文件都触发一次 resolveOmniExecutable 的遍历
    if (this.missingBinaryRetryAt > Date.now()) {
      logger.debug(
        LogCategory.SYSTEM,
        '[OmniService] firefly-omni 二进制仍处于缺失冷却期，跳过本次拉起'
      )
      this.isStarting = false
      return false
    }

    const exePath = this.resolveOmniExecutable()
    if (!exePath) {
      this.missingBinaryRetryAt = Date.now() + 60_000
      if (!this.missingBinaryReported) {
        this.missingBinaryReported = true
        logger.error(
          LogCategory.SYSTEM,
          `[OmniService] ❌ 未找到 firefly-omni 可执行二进制文件，基础AI引擎无法启动，分析能力将降级。${this.describeBinarySearch()}`
        )
      } else {
        logger.debug(LogCategory.SYSTEM, '[OmniService] firefly-omni 二进制仍缺失，跳过本次拉起')
      }
      this.notifyBinaryMissing()
      this.isStarting = false
      return false
    }
    // 二进制重新出现（如用户修复安装 / 从杀软隔离区恢复）后复位上报与冷却状态
    this.missingBinaryReported = false
    this.missingBinaryRetryAt = 0
    this.binaryMissingNotified = false
    this.binaryMissingNotifyDeferred = false

    try {
      // 获取业务主库 SQLite 绝对路径，用于 Worktree 隔离校验 (ADR-0035 & ADR-0038)
      const { databaseService } = await import('../../database/database-service')
      const dbPath = databaseService.getDbPath()
      const expectedVectorsDir = dbPath ? path.join(path.dirname(dbPath), 'vectors') : null
      const userDataDir = this.resolveUserDataDir()
      this.expectedMasterDbPath = dbPath || null
      this.expectedVectorsDir = expectedVectorsDir

      const verifyOmniInstance = async (
        port: number,
        expectedPid?: number
      ): Promise<{ ok: boolean; data?: Record<string, any> }> => {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/api/v1/engine/status`, {
            signal: AbortSignal.timeout(1000)
          })
          if (!res.ok) return { ok: false }
          const data = await res.json()
          if (!data || data.status !== 'ok') return { ok: false }

          const originCheck = verifyOmniSameOrigin(
            {
              port: typeof data.port === 'number' ? data.port : port,
              pid: typeof data.pid === 'number' ? data.pid : undefined,
              userDataDir: typeof data.userDataDir === 'string' ? data.userDataDir : null,
              masterDbPath: typeof data.masterDbPath === 'string' ? data.masterDbPath : null,
              targetVectorsDir:
                typeof data.targetVectorsDir === 'string' ? data.targetVectorsDir : null
            },
            {
              expectedPort: port,
              expectedPid,
              userDataDir,
              masterDbPath: dbPath || null,
              targetVectorsDir: expectedVectorsDir
            }
          )
          if (!originCheck.ok) {
            logger.warn(
              LogCategory.SYSTEM,
              `[OmniService] 端口 ${port} 上的 Omni 实例同源校验未通过，拒绝盲目复用: ${originCheck.reason}`
            )
            return { ok: false }
          }
          if (originCheck.warning) {
            logger.warn(LogCategory.SYSTEM, `[OmniService] ${originCheck.warning}`)
          }
          return { ok: true, data }
        } catch {
          return { ok: false }
        }
      }

      // 优先读取 userData/run/omni-config.json 零扫描复用（通过 PID 存活 + 同源校验）
      let matchedPort: number | null = null
      let matchedData: Record<string, any> | undefined
      let matchedFromDiscovery = false
      const df = this.getDiscoveryFile()
      const discovered = df?.read({ verifyPid: true }) ?? null
      if (discovered) {
        const dfOrigin = verifyOmniSameOrigin(
          {
            port: discovered.port,
            pid: discovered.pid,
            userDataDir: discovered.userDataDir,
            masterDbPath: discovered.masterDbPath,
            targetVectorsDir: discovered.targetVectorsDir
          },
          {
            userDataDir,
            masterDbPath: dbPath || null,
            targetVectorsDir: expectedVectorsDir
          }
        )
        if (dfOrigin.ok) {
          const verified = await verifyOmniInstance(discovered.port, discovered.pid)
          if (verified.ok) {
            matchedPort = discovered.port
            matchedData = verified.data
            matchedFromDiscovery = true
          }
        } else {
          logger.warn(
            LogCategory.SYSTEM,
            `[OmniService] 发现文件同源校验未通过，忽略并跳过复用: ${dfOrigin.reason}`
          )
        }
      }

      // 仅当发现文件未命中时，做 1 次单轮降级扫描 38200~38219 寻找属于当前 Worktree 的运行中 Omni 实例
      if (matchedPort === null) {
        for (let p = this.basePort; p < this.basePort + APP_PORTS.MAX_ATTEMPTS; p++) {
          const verified = await verifyOmniInstance(p)
          if (verified.ok) {
            matchedPort = p
            matchedData = verified.data
            break
          }
        }
      }

      if (matchedPort !== null) {
        this.actualPort = matchedPort
        this.baseUrl = `http://127.0.0.1:${matchedPort}`
        const adoptedPid =
          typeof matchedData?.pid === 'number'
            ? matchedData.pid
            : discovered?.pid
        const adoptedInstanceId =
          typeof matchedData?.instanceId === 'string'
            ? matchedData.instanceId
            : discovered?.instanceId
        this.expectedIdentity = {
          pid: adoptedPid,
          instanceId: adoptedInstanceId,
          port: matchedPort
        }
        // 仅当发现文件缺失且通过验证采纳外部未写盘实例时回填发现文件
        if (!matchedFromDiscovery && df && !discovered && adoptedPid && adoptedInstanceId) {
          void df
            .publish({
              instanceId: adoptedInstanceId,
              revision: typeof matchedData?.revision === 'number' ? matchedData.revision : 1,
              host: '127.0.0.1',
              port: matchedPort,
              pid: adoptedPid,
              startedAt: new Date().toISOString(),
              userDataDir: userDataDir || undefined,
              capabilities: [],
              masterDbPath: dbPath || undefined,
              targetVectorsDir: expectedVectorsDir || undefined
            })
            .catch(() => {})
        }
        logger.info(
          LogCategory.SYSTEM,
          `[OmniService] 成功匹配并复用当前 Worktree 专属 Omni 服务 (Port: ${matchedPort}, ${this.baseUrl})，接入 SSE 状态流`
        )
        this.restartAttempts = 0
        this.isStarting = false
        this.spawnedBinarySignature = this.binarySignature(exePath)
        this.lastSpawnedAt = Date.now()
        this.pendingUpdateSignature = null
        this.pendingUpdateSince = 0
        this.startDevBinaryWatch()
        this.syncConfigFromDesktop().catch(() => {})
        this.kickEventStreamReconnect({
          expectedTarget: {
            baseUrl: this.baseUrl,
            pid: adoptedPid,
            instanceId: adoptedInstanceId
          },
          resetFailures: true
        })
        this.notifyReady()
        return true
      }

      // 若未找到属于当前 Worktree 的运行中实例，且存在旧的未退出子进程，先执行安全清理（仅终止物理进程，不重置 isStarting 标记）
      if (this.process && !this.process.killed) {
        this.forceKillProcessTree(this.process)
        await new Promise(r => setTimeout(r, 300))
      }
      this.isStarting = true

      // 寻找可用端口作为建议基准（Rust 侧 bind-first 仍支持 38200..=38219 原子滑动）
      const port = await findAvailablePort(this.basePort, APP_PORTS.MAX_ATTEMPTS)
      this.actualPort = port
      this.baseUrl = `http://127.0.0.1:${port}`

      logger.info(
        LogCategory.SYSTEM,
        `[OmniService] 正在拉起 firefly-omni 守护进程 (Port: ${port}): ${exePath}`
      )
      const isDevMode = isLocalDevRuntime()
      const binDir = path.dirname(exePath)
      const existingPath = process.env.PATH || ''
      const injectedPath = [binDir, existingPath].filter(Boolean).join(path.delimiter)

      // Linux/WSL 动态链接器不搜索 exe 同目录的 .so（Windows 下 DLL 同目录即可自动加载），
      // 必须经 LD_LIBRARY_PATH 显式下发 binDir，否则 omni 一启动就因找不到
      // libsherpa-onnx-c-api.so / libonnxruntime.so 崩溃，HTTP 端口永不监听 ⇒
      // OmniClient fetch failed ⇒ OmniService 反复重启直至耗尽重试次数。
      // 保留继承的 LD_LIBRARY_PATH（系统库路径），binDir 置于最前优先解析自带库。
      const isWin = process.platform === 'win32'
      const existingLibPath = process.env.LD_LIBRARY_PATH || ''
      const injectedLibPath = [binDir, existingLibPath].filter(Boolean).join(path.delimiter)

      // 绑定操作系统单实例文件咨询锁与安全令牌 (Spec §8)
      const runDir = dbPath
        ? path.join(path.dirname(dbPath), 'run')
        : path.join(process.cwd(), '.run')
      this.instanceLock = new OmniInstanceLock(runDir)
      if (!this.instanceLock.acquire()) {
        logger.warn(LogCategory.SYSTEM, '[OmniService] 操作系统单实例文件锁检测到同用户实例已运行')
      }
      this.tokenManager = new OmniTokenManager(runDir)
      const tokenPayload = this.tokenManager.createToken(port, `omni-boot-${Date.now()}`)

      const env: Record<string, string | undefined> = {
        ...process.env,
        PATH: injectedPath,
        ...(isWin ? {} : { LD_LIBRARY_PATH: injectedLibPath }),
        OMNI_PORT: String(port),
        OMNI_DEV_MODE: isDevMode ? '1' : '0',
        FIREFLY_RUN_DIR: runDir,
        ...(userDataDir ? { FIREFLY_USER_DATA_DIR: userDataDir } : {}),
        FIREFLY_OMNI_TOKEN: tokenPayload.token,
        RUST_LOG:
          process.env.RUST_LOG ||
          (isDevMode ? 'info,omni_vision=info,omni_server=info,omni_text=info' : 'warn')
      }

      const candidatePackPaths = [
        ResourceLocator.resolveResourcePath?.('semantic/semantic.pack'),
        ResourceLocator.resolveResourcePath?.('presetResources/semantic/semantic.pack'),
        path.join(process.cwd(), 'build/extraResources/semantic/semantic.pack'),
        path.join(process.cwd(), 'build/presetResources/semantic/semantic.pack'),
        path.join(process.cwd(), 'apps/desktop/build/extraResources/semantic/semantic.pack'),
        path.join(process.cwd(), 'apps/desktop/build/presetResources/semantic/semantic.pack')
      ]
      let packPath: string | null = null
      for (const cand of candidatePackPaths) {
        if (cand && fs.existsSync(cand)) {
          packPath = cand
          break
        }
      }

      // omni-geo 地理数据集解析（与语义包同构的显式下发）：
      // omni-server 的数据集发现链锚定在 exe 相对 <exe_dir>/../../build/extraResources/geo 与
      // 少数 cwd 候选上，而资源统一装配流水线（consume-preset-resources + desktop
      // setup-extra-resources）只产出 desktop 侧 extraResources/geo。开发态桌面以
      // target/debug/firefly-omni.exe 的相对链落空 ⇒ 地理子系统静默软不可用
      // （历史：geo-20260825 数据包已在本地但发现链够不着）。
      // 此处复刻 --pack-path 模式，经 OMNI_GEO_DATA_PATH 环境变量显式下发（discover.rs
      // 最高优先级即该环境变量）；解析不到则不下发，保持服务端原有发现链行为。
      const candidateGeoPaths = [
        ResourceLocator.resolveResourcePath?.('geo/geonames-compact.json'),
        path.join(process.cwd(), 'apps/desktop/build/extraResources/geo/geonames-compact.json'),
        path.join(process.cwd(), 'apps/omni/build/extraResources/geo/geonames-compact.json'),
        path.join(process.cwd(), 'build/extraResources/geo/geonames-compact.json')
      ]
      let geoPath: string | null = null
      for (const cand of candidateGeoPaths) {
        if (cand && fs.existsSync(cand)) {
          geoPath = cand
          break
        }
      }

      const spawnArgs = ['serve', '-a', `127.0.0.1:${port}`]
      if (dbPath) {
        spawnArgs.push('--db-path', dbPath)
        env.OMNI_DB_PATH = dbPath
        logger.debug(LogCategory.SYSTEM, `[OmniService] 🎯 业务主库路径 (--db-path): ${dbPath}`)
        const vectorsDir = expectedVectorsDir || path.join(path.dirname(dbPath), 'vectors')
        spawnArgs.push('--vectors-path', vectorsDir)
        env.OMNI_VECTORS_PATH = vectorsDir
        logger.debug(
          LogCategory.SYSTEM,
          `[OmniService] 🎯 矢量数据隔离路径 (--vectors-path): ${vectorsDir}`
        )
      }
      if (packPath) {
        spawnArgs.push('--pack-path', packPath)
        logger.debug(LogCategory.SYSTEM, `[OmniService] 🎯 语义包路径 (--pack-path): ${packPath}`)
      }
      if (geoPath) {
        env.OMNI_GEO_DATA_PATH = geoPath
        logger.debug(
          LogCategory.SYSTEM,
          `[OmniService] 🌍 地理数据集路径 (OMNI_GEO_DATA_PATH): ${geoPath}`
        )
      } else {
        logger.warn(
          LogCategory.SYSTEM,
          '[OmniService] 未解析到 omni-geo 地理数据集（geo/geonames-compact.json），逆地理编码将以 available:false 软降级'
        )
      }
      // 原生动态库绝对物理隔离红线 (Issue 05 Spec §6.1)
      // 永久锁定只读安装目录 extraResources/bin/omni，严禁从用户自定义插件目录加载 DLL
      env.FIREFLY_ONNX_DIR = binDir

      // 单轨挂载前强制净化继承环境中的全部域 B 模型路径环境变量，阻断宿主机环境变量静默注入
      for (const purgeKey of CHILD_MODEL_ENV_KEYS_TO_PURGE) {
        delete env[purgeKey]
      }
      delete env.FIREFLY_ACTIVE_MODEL_MOUNTS_FILE
      delete env.FIREFLY_STRICT_ACTIVE_PLUGINS
      delete env.FIREFLY_SHARED_DIR
      delete env.OMNI_PPOCR_MODEL_PATH

      // 生成本次启动专属的唯一单轨挂载清单（域 A 与域 B 严格分界）
      let pluginsRoot = ''
      let sharedDir = ''
      let mountManifestPath: string | null = null
      let expectedMountResourceIds: string[] = []
      const mountsRecord: Record<string, Record<string, unknown>> = {}

      try {
        const { modularResourceService } = await import('../modular-resource-service')
        pluginsRoot = modularResourceService?.getPluginsRootDir?.() || ''
        const rootUnavailable = modularResourceService?.isRootUnavailable?.() === true

        if (pluginsRoot) {
          env.FIREFLY_MODULES_ROOT = pluginsRoot
          sharedDir = PluginPathResolver.getSharedDirForRoot(pluginsRoot)
          // 确保物理目录存在，防止全新启动（或重置用户目录后）Rust 端的 canonicalize 报 os error 3
          try {
            if (!fs.existsSync(sharedDir)) {
              fs.mkdirSync(sharedDir, { recursive: true })
            }
          } catch (mkdirErr) {
            logger.warn(
              LogCategory.SYSTEM,
              `[OmniService] 自动创建 sharedDir 失败 (${sharedDir}):`,
              mkdirErr
            )
          }
          env.FIREFLY_SHARED_DIR = sharedDir
          logger.debug(
            LogCategory.SYSTEM,
            `[OmniService] 🧩 统一插件根目录 (FIREFLY_MODULES_ROOT): ${pluginsRoot}`
          )
        }

        if (!rootUnavailable && modularResourceService) {
          const resourceIdToModuleInfo = new Map<
            string,
            { moduleId: string; capabilitySlot: string }
          >()
          for (const mod of modularResourceService.listModules?.() || []) {
            if (mod.install_state !== 'active') continue
            for (const res of mod.resources || []) {
              resourceIdToModuleInfo.set(res.resource_id, {
                moduleId: mod.id,
                capabilitySlot: mod.capability_slot || 'general'
              })
            }
          }

          const mountable = modularResourceService.getMountableResourcesSnapshot?.() || []
          for (const item of mountable) {
            const meta =
              item.catalogMeta ||
              BUILTIN_PLUGIN_CATALOG_META[item.resourceId as BuiltinSharedResourceId]
            if (!meta || !item.physicalDir || !fs.existsSync(item.physicalDir)) {
              if (item.physicalDir && !fs.existsSync(item.physicalDir)) {
                logger.warn(
                  LogCategory.SYSTEM,
                  `[OmniService] 跳过物理目录不存在的共享资源挂载: ${item.resourceId} (${item.physicalDir})`
                )
              }
              continue
            }

            // 语言场景互斥（chinese-clip vs mobile-clip）：
            // 中文环境优先且仅激活 chinese-clip；海外/非中文环境优先激活 mobile-clip
            const currentLang = this.getConfigValue<string>('DEFAULT_LANGUAGE') || 'zh-CN'
            const isZh = currentLang.toLowerCase().startsWith('zh')
            if (isZh && item.resourceId === 'mobile-clip') {
              const hasChineseClip = mountable.some(m => m.resourceId === 'chinese-clip')
              if (hasChineseClip) {
                logger.debug(
                  LogCategory.SYSTEM,
                  '[OmniService] 中文语言环境下，chinese-clip 优先，跳过 mobile-clip 互斥挂载'
                )
                continue
              }
            } else if (!isZh && item.resourceId === 'chinese-clip') {
              const hasMobileClip = mountable.some(m => m.resourceId === 'mobile-clip')
              if (hasMobileClip) {
                logger.debug(
                  LogCategory.SYSTEM,
                  '[OmniService] 非中文语言环境下，mobile-clip 优先，跳过 chinese-clip 互斥挂载'
                )
                continue
              }
            }

            // 自愈同步：若挂载了 chinese-clip，但物理目录缺失伴随视觉词表与矩阵，自动从随包目录同步补齐
            if (item.resourceId === 'chinese-clip' && fs.existsSync(item.physicalDir)) {
              try {
                const targetBin = path.join(item.physicalDir, 'tags_visual_zh_embeddings.bin')
                const targetTxt = path.join(item.physicalDir, 'tags_visual_zh.txt')
                if (!fs.existsSync(targetBin)) {
                  const srcBin =
                    ResourceLocator.resolveResourcePath(
                      'models/clip/tags_visual_zh_embeddings.bin'
                    ) || ResourceLocator.resolveResourcePath('clip/tags_visual_zh_embeddings.bin')
                  if (srcBin && fs.existsSync(srcBin)) {
                    fs.copyFileSync(srcBin, targetBin)
                    logger.info(
                      LogCategory.SYSTEM,
                      `[OmniService] 已自动为 chinese-clip 补齐缺失的视觉嵌入矩阵: ${targetBin}`
                    )
                  }
                }
                if (!fs.existsSync(targetTxt)) {
                  const srcTxt =
                    ResourceLocator.resolveResourcePath('models/clip/tags_visual_zh.txt') ||
                    ResourceLocator.resolveResourcePath('clip/tags_visual_zh.txt')
                  if (srcTxt && fs.existsSync(srcTxt)) {
                    fs.copyFileSync(srcTxt, targetTxt)
                    logger.info(
                      LogCategory.SYSTEM,
                      `[OmniService] 已自动为 chinese-clip 补齐缺失的视觉词表: ${targetTxt}`
                    )
                  }
                }
              } catch (clipSyncErr) {
                logger.warn(
                  LogCategory.SYSTEM,
                  `[OmniService] 同步 chinese-clip 伴随词表异常:`,
                  clipSyncErr
                )
              }
            }

            let envValue =
              meta.envVarType === 'file' && meta.envFileRelativePath
                ? path.join(item.physicalDir, meta.envFileRelativePath)
                : item.physicalDir

            // 不可变挂载指针契约 (Ticket 07 & Spec §3.2.1):
            // 优先从 current.json 反解真实物理文件路径
            const activePaths = resolveActiveModelPaths(item.physicalDir)
            if (activePaths?.activeFile) {
              envValue = path.join(item.physicalDir, activePaths.activeFile)
            } else if (activePaths?.activeFiles) {
              const allowInjectClipPaths = isZh
                ? item.resourceId === 'chinese-clip' ||
                  !mountable.some(m => m.resourceId === 'chinese-clip')
                : item.resourceId === 'mobile-clip' ||
                  !mountable.some(m => m.resourceId === 'mobile-clip')

              if (allowInjectClipPaths) {
                if (activePaths.activeFiles.visual) {
                  env.VISUAL_MODEL_PATH = path.join(
                    item.physicalDir,
                    activePaths.activeFiles.visual
                  )
                }
                if (activePaths.activeFiles.text) {
                  env.TEXT_MODEL_PATH = path.join(item.physicalDir, activePaths.activeFiles.text)
                }
              }
            }

            if (meta.envVarType === 'file' && !fs.existsSync(envValue)) {
              logger.warn(
                LogCategory.SYSTEM,
                `[OmniService] 跳过缺失目标文件的共享资源挂载: ${item.resourceId} (${envValue})`
              )
              continue
            }

            // 仅向白名单生效资源注入对应 Env（禁止回退 extraResources / ~/.cache）
            env[meta.targetEnvVar] = envValue

            if (meta.optionalFileEnvVar) {
              const optPath = path.join(item.physicalDir, meta.optionalFileEnvVar.relativePath)
              if (fs.existsSync(optPath)) {
                env[meta.optionalFileEnvVar.envVar] = optPath
              }
            }

            const modInfo = resourceIdToModuleInfo.get(item.resourceId) || {
              moduleId: '',
              capabilitySlot: 'general'
            }
            mountsRecord[item.resourceId] = {
              resourceId: item.resourceId,
              moduleId: modInfo.moduleId,
              capabilitySlot: modInfo.capabilitySlot,
              dir: item.physicalDir,
              envVar: meta.targetEnvVar,
              envValue,
              requiredFileGroups: meta.requiredFileGroups.map(g => [...g]),
              minPrimaryFileBytes: meta.minPrimaryFileBytes,
              ...(meta.tower ? { tower: meta.tower } : {}),
              ...(typeof meta.dim === 'number' ? { dim: meta.dim } : {}),
              ...(typeof meta.encoderId === 'number' ? { encoderId: meta.encoderId } : {}),
              ...(meta.vocabMeta ? { vocabMeta: { ...meta.vocabMeta } } : {})
            }
            expectedMountResourceIds.push(item.resourceId)
          }
        } else if (rootUnavailable) {
          logger.warn(
            LogCategory.SYSTEM,
            '[OmniService] 检测到插件根目录不可用，写入空挂载清单仅拉起域 A 基础能力'
          )
        }
      } catch (snapErr) {
        logger.warn(
          LogCategory.SYSTEM,
          '[OmniService] 读取插件挂载快照失败，使用空挂载清单拉起 Omni:',
          snapErr
        )
      }

      try {
        fs.mkdirSync(runDir, { recursive: true })
        const manifestFileName = `active-mounts-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.json`
        const manifestAbsPath = path.join(runDir, manifestFileName)
        const tmpManifestPath = `${manifestAbsPath}.tmp`
        const manifestPayload = {
          version: 1,
          generatedAt: Date.now(),
          pid: process.pid,
          sharedDir,
          strict: true,
          mounts: mountsRecord
        }
        fs.writeFileSync(tmpManifestPath, JSON.stringify(manifestPayload, null, 2), 'utf-8')
        fs.renameSync(tmpManifestPath, manifestAbsPath)

        mountManifestPath = manifestAbsPath
        env.FIREFLY_ACTIVE_MODEL_MOUNTS_FILE = manifestAbsPath
        env.FIREFLY_STRICT_ACTIVE_PLUGINS = '1'
        this.currentMountManifestPath = manifestAbsPath
        logger.debug(
          LogCategory.SYSTEM,
          `[OmniService] 📦 下发单轨挂载清单 (${expectedMountResourceIds.length} 项): ${expectedMountResourceIds.join(', ') || 'none'}`
        )
      } catch (manifestWriteErr) {
        logger.error(
          LogCategory.SYSTEM,
          '[OmniService] 写入单轨挂载清单失败，强制启用 strict 保护模式:',
          manifestWriteErr
        )
        env.FIREFLY_STRICT_ACTIVE_PLUGINS = '1'
      }

      const expectedMountsSnapshot = {
        manifestPath: mountManifestPath,
        sharedDir: sharedDir || null,
        expectedResourceIds: [...expectedMountResourceIds],
        strict: true
      }
      this.lastExpectedMounts = expectedMountsSnapshot

      // PP-OCRv6 属于应用随包只读域 A 模型，严格且仅从 ResourceLocator/models/PP-OCRv6 解析（严禁扫描 _shared）
      const ppocrDir = ResourceLocator.resolveResourcePath?.('models/PP-OCRv6')
      if (ppocrDir && fs.existsSync(ppocrDir)) {
        env.OMNI_PPOCR_MODEL_PATH = ppocrDir
        logger.debug(
          LogCategory.SYSTEM,
          `[OmniService] 🔤 PP-OCRv6 只读底座模型目录 (OMNI_PPOCR_MODEL_PATH): ${ppocrDir}`
        )
      }

      env.OMNI_WATCH_STDIN = '1'

      // 注入当前激活的多模态嵌入画像档位 (classic_light | gemma_unified) 与 MRL 维度 (Spec §3.4.1)
      try {
        const { ConfigOrchestrator } = await import('../../../config/config-orchestrator')
        const configOrch = ConfigOrchestrator?.getInstance?.()
        if (configOrch) {
          const embeddingProfile =
            configOrch.getValue<'classic_light' | 'gemma_unified'>('AI_EMBEDDING_PROFILE') ||
            'classic_light'
          spawnArgs.push('--embedding-profile', embeddingProfile)
          logger.debug(
            LogCategory.SYSTEM,
            `[OmniService] 🎯 嵌入画像档位 (--embedding-profile): ${embeddingProfile}`
          )

          const mrlDimension = configOrch.getValue<number>('EMBEDDING_MRL_DIMENSION') || 512
          spawnArgs.push('--mrl-dimension', String(mrlDimension))
          logger.debug(
            LogCategory.SYSTEM,
            `[OmniService] 🎯 MRL 向量维度 (--mrl-dimension): ${mrlDimension}`
          )
        }
      } catch {}

      // DirectML 原生崩溃守卫：本进程已判定（或持久标记仍在 TTL 内）时，强制 Omni 以纯 CPU 拉起，
      // 避免在同一坏 GPU 路径上反复 abort 导致视频切片永久丢失（OMNI_DISABLE_DML 由 start_server 消费）。
      this.resolveDmlCrashMarker(dbPath)
      const dmlMarkerRaw = this.dmlCrashMarkerPath
        ? this.readTextFileSafe(this.dmlCrashMarkerPath)
        : null
      if (this.forceCpuForNextStarts || shouldForceCpuFromMarker(dmlMarkerRaw, Date.now())) {
        env.OMNI_DISABLE_DML = '1'
        logger.warn(
          LogCategory.SYSTEM,
          '[OmniService] 检测到 DirectML 原生崩溃历史，本次以纯 CPU 兜底拉起 Omni（OMNI_DISABLE_DML=1）'
        )
      }

      const child = spawn(exePath, spawnArgs, {
        cwd: binDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })

      // 立即记录当前拉起的二进制签名与拉起时间戳（启动 15s 冷静期保护，防启动中途被 checkBinaryUpdated 误杀）
      this.lastSpawnedAt = Date.now()
      this.spawnedBinarySignature = this.binarySignature(exePath)
      this.pendingUpdateSignature = null
      this.pendingUpdateSince = 0

      // 登记进全局精准进程回收器
      try {
        const { processReaper } = require('../../../main/process-reaper')
        processReaper.registerChild(child.pid, 'firefly-omni')
      } catch {}

      const isCzkawkaDump = (str: string): boolean => {
        return (
          str.includes('DEBUG PRINT COMMON') ||
          str.includes('DEBUG PRINT MESSAGES') ||
          str.includes('Included paths(before optimization)') ||
          str.includes('Included files(optimized)') ||
          str.includes('Directories { included_directories')
        )
      }

      // 剥离子进程输出中的 ANSI 转义序列（CSI，如 \x1b[2m26:42\x1b[0m \x1b[32m INFO\x1b[0m）。
      // 引擎在强开 ANSI 或原生库（onnxruntime / sherpa C-API）直接着色输出时，这些控制
      // 字符会随日志透传到渲染进程控制台与 app.log，表现为时间戳/级别前缀乱码。
      const stripAnsi = (buf: Buffer): string =>
        buf.toString().replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')

      // 受管子进程 stdout `<1ms` FIREFLY_READY 快路径信号 Promise
      let resolveReadyFrame: ((frame: FireflyReadyFrame) => void) | null = null
      let readyFrameReceived = false
      const readyFramePromise = new Promise<FireflyReadyFrame>(resolve => {
        resolveReadyFrame = resolve
      })
      let stdoutLineBuf = ''

      child.stdout?.on('data', data => {
        const rawChunk = stripAnsi(data)
        // 行缓冲解析 FIREFLY_READY:{"port":...,"pid":...,"instanceId":"..."} 快路径
        stdoutLineBuf += rawChunk
        const splitLines = stdoutLineBuf.split(/\r?\n/)
        stdoutLineBuf = splitLines.pop() ?? ''
        for (const line of splitLines) {
          const readyFrame = parseFireflyReadyLine(line)
          if (readyFrame && this.process === child && !this.isIntentionalStopping) {
            this.actualPort = readyFrame.port
            this.baseUrl = `http://127.0.0.1:${readyFrame.port}`
            this.expectedIdentity = {
              pid: readyFrame.pid,
              instanceId: readyFrame.instanceId,
              port: readyFrame.port
            }
            logger.info(
              LogCategory.SYSTEM,
              `[OmniService] ⚡ 捕获 stdout FIREFLY_READY 快路径 (port=${readyFrame.port}, pid=${readyFrame.pid}, instanceId=${readyFrame.instanceId})`
            )
            this.kickEventStreamReconnect({
              expectedTarget: {
                baseUrl: this.baseUrl,
                pid: readyFrame.pid,
                instanceId: readyFrame.instanceId
              },
              resetFailures: true
            })
            if (!readyFrameReceived) {
              readyFrameReceived = true
              resolveReadyFrame?.(readyFrame)
            }
          }
        }

        const str = rawChunk.trim()
        if (str && !isCzkawkaDump(str)) {
          // 若子进程输出为 INFO 级别或包含多模态关键业务日志，以 info 输出至控制台；其余以 debug 输出
          const isInfoMsg =
            str.includes('INFO') ||
            str.includes('[普遍语法造句') ||
            str.includes('[双锚点融合') ||
            str.includes('[OmniServer]') ||
            str.includes('[prune_and_rank_tags]') ||
            str.includes('[落选') ||
            str.includes('[胜出') ||
            str.includes('[MossTtsPerf]')
          if (isInfoMsg) {
            logger.debug(LogCategory.SYSTEM, `[Omni] ${str}`)
          } else {
            logger.debug(LogCategory.SYSTEM, `[Omni] ${str}`)
          }
        }
      })

      child.stderr?.on('data', data => {
        const str = stripAnsi(data).trim()
        if (str && !isCzkawkaDump(str)) {
          logger.warn(LogCategory.SYSTEM, `[Omni:err] ${str}`)
          if (str.includes('KeyEpochMismatch')) {
            logger.error(
              LogCategory.SYSTEM,
              `[OmniService] ❌ 检测到组件密钥代次不匹配 (KeyEpochMismatch): ${str}`
            )
            this.handleKeyEpochMismatch(str)
          }
        }
      })

      child.on('error', err => {
        try {
          const { handleExecutableSecurityBlock } = require('../antivirus-guard')
          if (handleExecutableSecurityBlock(exePath, err)) {
            return
          }
        } catch {}
        logger.error(LogCategory.SYSTEM, '[OmniService] 子进程启动失败:', err)
      })

      child.on('exit', async (code, signal) => {
        const wasCurrentChild = this.process === child
        logger.warn(LogCategory.SYSTEM, `[OmniService] 子进程退出 (code=${code}, signal=${signal})`)
        // 原生崩溃（abort / 访问越界等）无法被 Rust catch；持久化「禁用 DirectML」结论，
        // 让随后的自愈重试与未来的进程重启都以纯 CPU 兜底，避免视频切片再次全毁。
        if (!this.isIntentionalStopping && isFatalNativeExitCode(code)) {
          this.persistDmlCrash(this.dmlCrashMarkerPath)
          logger.warn(
            LogCategory.SYSTEM,
            `[OmniService] 检测到 Omni 原生崩溃 (code=0x${(code >>> 0).toString(16)})，后续拉起将禁用 DirectML（纯 CPU 兜底）`
          )
        }
        try {
          const { processReaper } = require('../../../main/process-reaper')
          processReaper.unregisterChild(child.pid)
        } catch {}
        if (wasCurrentChild) {
          this.process = null
        }
        this.unlinkManifestSafe(expectedMountsSnapshot.manifestPath)
        if (
          expectedMountsSnapshot.manifestPath &&
          this.currentMountManifestPath === expectedMountsSnapshot.manifestPath
        ) {
          this.currentMountManifestPath = null
        }
        // 主动推送"未运行"状态至渲染进程（基础AI引擎 Footer 展示）
        this.pushStatus().catch(() => {})
        // 若正在主动停机（卸载/切换/退出）或已被新一轮子进程接替，绝不允许触发自愈重启或端口接管
        if (this.isIntentionalStopping || !wasCurrentChild) {
          return
        }
        // 子进程异常退出后，先检测是否对应端口上已有服务接管，若健康则直接接入，不触发重启
        const aliveAfterExit = await this.checkHealth()
        if (aliveAfterExit) {
          logger.debug(
            LogCategory.SYSTEM,
            `[OmniService] ${this.actualPort} 端口已有外部服务接管，直接连接`
          )
          this.restartAttempts = 0
          // 外部服务接管成功，推送"运行中"状态
          this.pushStatus().catch(() => {})
          return
        }
        this.scheduleRestart()
      })

      this.process = child

      // 等待服务就绪（优先由 stdout FIREFLY_READY 快路径 <1ms 唤醒，兜底最多 400 次 * 200ms = 80s 兼容旧二进制）
      for (let i = 0; i < 400; i++) {
        // 关键防御：若子进程在探活期间提前退出或被终止，立即中止等待，拒绝僵尸死等 80s 阻塞系统
        if (
          child.exitCode !== null ||
          child.killed ||
          this.process !== child ||
          this.isIntentionalStopping
        ) {
          logger.warn(
            LogCategory.SYSTEM,
            `[OmniService] firefly-omni 子进程在就绪前退出或中止 (exitCode=${child.exitCode}, killed=${child.killed}, stopping=${this.isIntentionalStopping})`
          )
          this.isStarting = false
          return false
        }

        if (!readyFrameReceived) {
          await Promise.race([readyFramePromise, new Promise(r => setTimeout(r, 200))])
        } else if (i > 0) {
          await new Promise(r => setTimeout(r, 200))
        }
        if (await this.checkHealth()) {
          const verifyRes = await this.verifyMountManifestStatus(expectedMountsSnapshot)
          if (!verifyRes.ok) {
            this.lastMountValidationError = verifyRes.error || '挂载清单双向核验未通过'
            if (verifyRes.transient) {
              // 瞬时超时/网络抖动 ≠ 挂载清单不一致：/health 已通过，禁止据此 SIGTERM 误杀
              // 正在进行的视频分析（切片与封面会一起丢失）。仅显著告警，放行激活，
              // 让后续真实推理与检索自然暴露真正的清单缺陷。
              logger.warn(
                LogCategory.SYSTEM,
                `[OmniService] 挂载清单核验暂时不可达（瞬时故障，已重试 ${STATUS_VERIFY_MAX_ATTEMPTS} 次），放行激活不阻断: ${this.lastMountValidationError}`
              )
            } else {
              logger.error(
                LogCategory.SYSTEM,
                `[OmniService] 挂载清单双向核验失败 (Fail-Closed)，停机阻断激活: ${this.lastMountValidationError}`
              )
              await this.stop()
              this.isStarting = false
              return false
            }
          }
          logger.info(
            LogCategory.SYSTEM,
            `[OmniService] firefly-omni 服务就绪并在 ${this.baseUrl} 正常监听`
          )
          this.restartAttempts = 0
          this.isStarting = false
          // 探活就绪后，记录二进制签名，并开启开发态热更新监听
          this.spawnedBinarySignature = this.binarySignature(exePath)
          this.lastSpawnedAt = Date.now()
          this.pendingUpdateSignature = null
          this.pendingUpdateSince = 0
          this.startDevBinaryWatch()
          // 探活就绪后，立即同步一次当前配置（ENABLE_IMAGE_OCR, OCR_MODEL_SIZE 等）
          this.syncConfigFromDesktop().catch(() => {})
          // 确保单循环 SSE 状态流已建立，实时推送状态至渲染进程
          this.ensureEventStream()
          this.notifyReady()
          return true
        }
      }

      logger.error(
        LogCategory.SYSTEM,
        `[OmniService] firefly-omni 启动探活超时 (80s)，终止当前未就绪子进程`
      )
      await this.stop()
      this.isStarting = false
      // 启动失败（探活超时），推送"未运行"状态
      this.pushStatus().catch(() => {})
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
  /**
   * 物理终止当前持有的 firefly-omni 子进程树（纯净终止，不污染 isStarting 状态机）
   */
  /**
   * 强制终结子进程树辅助方法
   */
  private forceKillProcessTree(child: ChildProcess | null): void {
    if (!child) return
    const pid = child.pid
    try {
      const { processReaper } = require('../../../main/process-reaper')
      processReaper.unregisterChild(pid)
    } catch {}
    try {
      if (process.platform === 'win32' && pid) {
        try {
          const { execSync } = require('node:child_process')
          execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' })
        } catch {}
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }
      logger.info(LogCategory.SYSTEM, `[OmniService] 已彻底终止 firefly-omni 进程树 (PID=${pid})`)
    } catch {}
  }

  /**
   * 安全清理单轨挂载清单临时文件
   */
  private unlinkManifestSafe(manifestPath: string | null | undefined): void {
    if (!manifestPath) return
    try {
      if (fs.existsSync(manifestPath)) {
        fs.unlinkSync(manifestPath)
      }
    } catch {}
  }

  /**
   * 判定 Omni 是否处于受管运行时生命周期内（区分独立 DB 单测与完整运行期）
   */
  public isManagedLifecycleActive(): boolean {
    return this.managedLifecycleActive
  }

  /**
   * 返回最近一次挂载清单双向校验错误信息
   */
  public getLastMountValidationError(): string | null {
    return this.lastMountValidationError
  }

  /**
   * 同步立即终结当前持有的 firefly-omni 进程树（仅用于 process.once('exit') / 信号强制退出）
   */
  public stopImmediatelySync(): void {
    // 同步段第一步：先局部捕获 childPid 与 lastInstanceId，再清空状态
    const child = this.process
    const childPid = child?.pid
    const lastInstanceId =
      this.connectedTarget?.instanceId || this.expectedIdentity?.instanceId || undefined

    this.isIntentionalStopping = true
    this.isStarting = false
    ++this.stopEpoch
    ++this.connectionEpoch
    this.stopController.abort()
    this.unmountDiscoveryWatcher()
    this.eventStreamAbortController?.abort()
    this.reconnectAbortController?.abort()
    this.activeLoopEpoch = null
    this.connectedTarget = null
    this.expectedIdentity = null
    this.lastStatusEvent = null

    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout)
      this.restartTimeout = null
    }
    this.process = null
    this.forceKillProcessTree(child)

    if (childPid) {
      this.getDiscoveryFile()?.revokeSync({ pid: childPid, instanceId: lastInstanceId })
    }

    if (this.instanceLock) {
      this.instanceLock.release()
      this.instanceLock = null
    }
    if (this.tokenManager) {
      this.tokenManager.removeToken()
      this.tokenManager = null
    }
    const manifestPath = this.currentMountManifestPath
    this.currentMountManifestPath = null
    this.unlinkManifestSafe(manifestPath)
    broadcastOmniStatus({ running: false, version: null })
  }

  /**
   * 有界等待引擎 HTTP 端口真正可达。
   *
   * 背景：引擎子进程 `start()` 返回 ≠ HTTP 端口已监听。刚装完/刚拉起时端口可能仍在
   * 初始化，此时直接探测会得到 fetch failed（连接拒绝 / ECONNREFUSED）。
   * 这里按固定间隔轮询 `/api/v1/engine/status`，直到端口可达或总时限耗尽。
   *
   * @param totalMs  总等待上限（默认 30s，覆盖首次冷启动 + 模型加载）
   * @param intervalMs 轮询间隔（默认 500ms）
   * @returns true=端口已可达；false=超时仍未可达
   */
  private async waitForEnginePortReady(totalMs = 30_000, intervalMs = 500): Promise<boolean> {
    const deadline = Date.now() + totalMs
    let lastErr = ''
    while (Date.now() < deadline) {
      try {
        // 用较短的单次超时探测端口是否监听；可达即返回，不等完整 2.5s
        const res = await fetch(`${this.baseUrl}/api/v1/engine/status`, {
          signal: AbortSignal.timeout(1500)
        })
        // 端口已监听并返回（无论业务状态码），说明 HTTP 层已就绪
        if (res) {
          // 主动释放 body，避免连接泄漏
          try {
            await res.arrayBuffer()
          } catch {}
          return true
        }
      } catch (err: any) {
        lastErr = err?.message || String(err)
      }
      await new Promise(r => setTimeout(r, intervalMs))
    }
    logger.warn(
      LogCategory.SYSTEM,
      `[OmniService] waitForEnginePortReady 超时 (${totalMs}ms)，最后错误: ${lastErr}`
    )
    return false
  }

  /**
   * 双向核验 /api/v1/engine/status 中的 mountManifest 与 mobileClipVocab
   */
  public async verifyMountManifestStatus(expected?: {
    manifestPath: string | null
    sharedDir: string | null
    expectedResourceIds: string[]
    strict: boolean
  }): Promise<{
    ok: boolean
    error?: string
    /** true 表示失败源于超时/网络等瞬时故障（重试耗尽），不代表挂载清单不一致 */
    transient?: boolean
    statusData?: Record<string, any>
  }> {
    return this.verifyMountManifestStatusAttempt(expected, 1)
  }

  /**
   * 单次核验实现；瞬时故障（超时/网络/5xx/半截响应）按预算重试，
   * 确定性不一致立即返回，避免把忙碌引擎误判为清单错误。
   */
  private async verifyMountManifestStatusAttempt(
    expected:
      | {
          manifestPath: string | null
          sharedDir: string | null
          expectedResourceIds: string[]
          strict: boolean
        }
      | undefined,
    attempt: number
  ): Promise<{
    ok: boolean
    error?: string
    transient?: boolean
    statusData?: Record<string, any>
  }> {
    const target = expected ?? this.lastExpectedMounts
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/engine/status`, {
        signal: AbortSignal.timeout(STATUS_VERIFY_TIMEOUT_MS)
      })
      if (!res.ok) {
        const transient = isTransientStatusHttpCode(res.status)
        if (transient && attempt < STATUS_VERIFY_MAX_ATTEMPTS) {
          await this.sleepStatusVerifyBackoff(attempt)
          return this.verifyMountManifestStatusAttempt(expected, attempt + 1)
        }
        return {
          ok: false,
          transient,
          error: `/api/v1/engine/status 响应异常: HTTP ${res.status}`
        }
      }
      const data = (await res.json()) as Record<string, any>
      const mm = data?.mountManifest

      if (target?.manifestPath) {
        if (!mm || typeof mm !== 'object') {
          return { ok: false, error: 'Omni 未返回 mountManifest 遥测对象', statusData: data }
        }
        if (mm.strict !== true || mm.mode !== 'manifest_single_track') {
          return {
            ok: false,
            error: `Omni 未以单轨 strict 清单模式运行 (mode=${mm.mode}, strict=${mm.strict}, error=${mm.error || 'none'})`,
            statusData: data
          }
        }
        if (mm.manifestPath && !isPathEqual(mm.manifestPath, target.manifestPath)) {
          return {
            ok: false,
            error: `Omni 挂载清单路径不一致: expected=${target.manifestPath}, actual=${mm.manifestPath}`,
            statusData: data
          }
        }
        if (mm.error) {
          return { ok: false, error: `Omni 挂载清单校验报错: ${mm.error}`, statusData: data }
        }

        const actualActiveSet = new Set<string>(
          Array.isArray(mm.activeResourceIds) ? mm.activeResourceIds : []
        )
        const rejectedList = Array.isArray(mm.rejectedMounts) ? mm.rejectedMounts : []
        for (const reqId of target.expectedResourceIds) {
          const rej = rejectedList.find((r: any) => r?.resourceId === reqId)
          if (rej) {
            return {
              ok: false,
              error: `资源 ${reqId} 被 Rust 运行时门禁拒绝: ${rej.reason || '未知原因'}`,
              statusData: data
            }
          }
          if (!actualActiveSet.has(reqId)) {
            return {
              ok: false,
              error: `预期激活资源 ${reqId} 未出现在 Omni activeResourceIds 中`,
              statusData: data
            }
          }
        }

        // 若本次激活挂载了 mobile-clip，检查英文词表双向核验（仅在非中文且为 Pro 模式下 vocab.valid 必须为 true）
        const lang = this.getConfigValue<string>('DEFAULT_LANGUAGE') || 'zh-CN'
        const isZh = lang.toLowerCase().startsWith('zh')
        if (!isZh && target.expectedResourceIds.includes('mobile-clip')) {
          const vocab = data?.mobileClipVocab
          const isPro = data?.isPro === true
          if (isPro && (!vocab || vocab.valid !== true || vocab.status !== 'ready')) {
            return {
              ok: false,
              error: `MobileCLIP 英文词表校验未就绪 (status=${vocab?.status || 'missing'}, reason=${vocab?.rejectReason || 'unknown'})`,
              statusData: data
            }
          }
        }
      }

      return { ok: true, statusData: data }
    } catch (err: any) {
      // 半截响应导致的 JSON 解析失败同样属于瞬时故障，应重试而非判死。
      const transient = isTransientStatusFetchError(err) || err?.name === 'SyntaxError'
      if (transient && attempt < STATUS_VERIFY_MAX_ATTEMPTS) {
        await this.sleepStatusVerifyBackoff(attempt)
        return this.verifyMountManifestStatusAttempt(expected, attempt + 1)
      }
      return {
        ok: false,
        transient,
        error: `查询 /api/v1/engine/status 异常: ${err?.message || String(err)}`
      }
    }
  }

  private sleepStatusVerifyBackoff(attempt: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, STATUS_VERIFY_BACKOFF_MS * attempt))
  }

  /**
   * 响应插件拓扑变更（激活、切换、卸载、后台修复完成）：
   * 重启 Omni 刷新单轨清单并执行真实能力探活；失败即抛出异常以触发上层状态/Epoch 回滚
   */
  public async handleTopologyChanged(opts: {
    moduleId?: string
    reason: string
    restartPolicy: 'restart' | 'ensure-running' | 'none'
  }): Promise<void> {
    if (!this.managedLifecycleActive || opts.restartPolicy === 'none') {
      return
    }

    let ok = false
    if (opts.restartPolicy === 'ensure-running' && !this.process) {
      const alive = await this.checkHealth().catch(() => false)
      ok = alive ? true : await this.start()
    } else {
      ok = await this.restart()
    }

    if (!ok) {
      throw new Error(this.lastMountValidationError || 'Omni 引擎重启或单轨挂载清单双向校验失败')
    }

    // 针对主动切换/激活的独占能力执行实时健康冒烟验证（防止仅进程存活而推理链断链）
    const isActivationCheck = opts.reason === 'module_change' && Boolean(opts.moduleId)
    if (!isActivationCheck || !opts.moduleId) {
      return
    }

    if (opts.moduleId === 'engine_classic_light' || opts.moduleId === 'engine_gemma_unified') {
      const profile = opts.moduleId === 'engine_gemma_unified' ? 'gemma_unified' : 'classic_light'
      const smoke = await this.runSmokeTest({ profile })
      if (!smoke.success) {
        const err = new Error(smoke.error || `向量底座 ${opts.moduleId} 激活冒烟失败`)
        if (smoke.errorCode) {
          ;(err as any).code = smoke.errorCode
        }
        throw err
      }
    } else if (opts.moduleId === 'tts_moss_onnx' || opts.moduleId === 'tts_m5_onnx') {
      const expectedEngine =
        opts.moduleId === 'tts_m5_onnx' ? 'express-voice-24k' : 'clone-voice-48k'
      // 引擎重启后模型加载需要时间，执行有界轮询（最长 15s，每 500ms 重试），杜绝单次 4s 超时误杀降级
      const deadline = Date.now() + 15_000
      let lastError = ''
      let isReady = false

      while (Date.now() < deadline) {
        try {
          const statusRes = await fetch(`${this.baseUrl}/api/audio/tts/status`, {
            signal: AbortSignal.timeout(2000)
          })
          if (statusRes.ok) {
            const ttsStatus = (await statusRes.json()) as {
              ready?: boolean
              total_voices?: number
              engine?: string
            }
            if (ttsStatus?.ready && ttsStatus.engine === expectedEngine) {
              isReady = true
              break
            }
            lastError = `ready=${Boolean(ttsStatus?.ready)}, engine=${ttsStatus?.engine || 'none'}`
          } else {
            lastError = `HTTP ${statusRes.status}`
          }
        } catch (err: any) {
          lastError = err?.message || String(err)
        }
        await new Promise(resolve => setTimeout(resolve, 500))
      }

      if (!isReady) {
        throw new Error(
          `TTS 引擎挂载验证未通过 (expected=${expectedEngine}, details: ${lastError})`
        )
      }
    }
  }

  /**
   * 获取当前 Omni 进程的安全授权 Token (Spec §8)
   */
  public getOmniToken(): string | null {
    return this.tokenManager?.readToken()?.token || null
  }

  /**
   * 两阶段停机协议：同步段先捕获身份并断开 SSE / watcher -> SIGTERM 优雅落盘（<=1.5s）-> taskkill /T /F + SIGKILL -> 按 pid/instanceId 撤销发现文件
   */
  public async stop(): Promise<void> {
    // 并发重入合并：若已有停机流程在途，直接复用同一 Promise，防止后发空 stop() 覆盖 stopPromise 并提前复位 isIntentionalStopping
    if (this.stopPromise) {
      return this.stopPromise
    }

    // 同步段：先局部捕获 childPid 与 lastInstanceId，再清空连接状态并递增代际
    const child = this.process
    const childPid = child?.pid
    const lastInstanceId =
      this.connectedTarget?.instanceId || this.expectedIdentity?.instanceId || undefined

    this.isIntentionalStopping = true
    this.isStarting = false
    ++this.stopEpoch
    ++this.connectionEpoch
    this.stopController.abort()
    this.unmountDiscoveryWatcher()
    this.eventStreamAbortController?.abort()
    this.reconnectAbortController?.abort()
    this.activeLoopEpoch = null
    this.connectedTarget = null
    this.expectedIdentity = null
    this.lastStatusEvent = null

    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout)
      this.restartTimeout = null
    }
    const manifestToCleanup = this.currentMountManifestPath
    this.currentMountManifestPath = null

    const runAsyncStop = async (): Promise<void> => {
      try {
        if (child) {
          const pid = child.pid
          this.process = null
          try {
            const { processReaper } = require('../../../main/process-reaper')
            processReaper.unregisterChild(pid)
          } catch {}

          const waitChildClose = new Promise<void>(resolve => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve()
              return
            }
            const onDone = () => resolve()
            child.once('close', onDone)
            child.once('exit', onDone)
          })

          try {
            if (child.exitCode === null && child.signalCode === null) {
              child.kill('SIGTERM')
            }
          } catch {}

          await Promise.race([
            waitChildClose,
            new Promise<void>(resolve => setTimeout(resolve, 1500))
          ])

          if (child.exitCode === null && child.signalCode === null) {
            this.forceKillProcessTree(child)
            await Promise.race([
              waitChildClose,
              new Promise<void>(resolve => setTimeout(resolve, 2000))
            ])
          }
        }

        if (childPid) {
          await this.getDiscoveryFile()?.revoke({ pid: childPid, instanceId: lastInstanceId })
        }

        if (this.instanceLock) {
          this.instanceLock.release()
          this.instanceLock = null
        }
        if (this.tokenManager) {
          this.tokenManager.removeToken()
          this.tokenManager = null
        }
        this.unlinkManifestSafe(manifestToCleanup)
        await this.waitForPortReleased(3000)
        // 主动推送"未运行"状态至渲染进程（基础AI引擎 Footer 展示）
        broadcastOmniStatus({ running: false, version: null })
      } finally {
        this.isIntentionalStopping = false
      }
    }

    const p = runAsyncStop()
    this.stopPromise = p
    try {
      await p
    } finally {
      if (this.stopPromise === p) {
        this.stopPromise = null
      }
    }
  }

  /**
   * 等待当前服务端口彻底释放（避免旧进程尚未完全退出时被误判为已存在而假活）
   */
  public async waitForPortReleased(limitMs: number = 3000): Promise<boolean> {
    const tStart = Date.now()
    while (Date.now() - tStart < limitMs) {
      const alive = await this.checkHealth().catch(() => false)
      if (!alive) {
        return true
      }
      await new Promise(r => setTimeout(r, 100))
    }
    return !(await this.checkHealth().catch(() => false))
  }

  /**
   * 优雅热重启 Omni 服务（档位变更、插件拓扑变化或异常恢复）
   */
  public async restart(): Promise<boolean> {
    logger.info(LogCategory.SYSTEM, '[OmniService] 正在优雅重启 Omni 服务进程...')
    const pendingStart = this.startPromise
    await this.stop()
    if (pendingStart) {
      try {
        await pendingStart
      } catch {}
    }
    await this.waitForPortReleased(3000)
    return await this.start()
  }

  /**
   * 指数退避自愈重启
   */
  private async scheduleRestart(): Promise<void> {
    if (this.isIntentionalStopping) {
      return
    }
    if (await this.checkHealth()) {
      logger.info(LogCategory.SYSTEM, '[OmniService] Omni 服务已在运行，跳过重启')
      this.restartAttempts = 0
      return
    }

    if (this.restartAttempts >= this.maxRestartAttempts) {
      logger.error(
        LogCategory.SYSTEM,
        `[OmniService] 已达到最大重启重试次数 (${this.maxRestartAttempts})，停止自动重启`
      )
      return
    }

    const delay = Math.min(1000 * Math.pow(2, this.restartAttempts), 15000)
    this.restartAttempts++
    logger.debug(
      LogCategory.SYSTEM,
      `[OmniService] 安排在 ${delay}ms 后尝试重启 Omni 服务 (第 ${this.restartAttempts} 次)...`
    )

    this.restartTimeout = setTimeout(() => {
      this.start().catch(err => {
        logger.error(LogCategory.SYSTEM, '[OmniService] 自动重启失败:', err)
      })
    }, delay)
  }

  /**
   * 服务健康探活
   */
  public async checkHealth(options?: {
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<boolean> {
    try {
      const timeoutMs = options?.timeoutMs ?? 1000
      let fetchSignal: AbortSignal = AbortSignal.timeout(timeoutMs)
      if (options?.signal) {
        fetchSignal = (AbortSignal as any).any
          ? (AbortSignal as any).any([fetchSignal, options.signal])
          : options.signal
      }
      const res = await fetch(`${this.baseUrl}/health`, { signal: fetchSignal })
      if (res.ok) {
        try {
          const data = await res.json()
          if (data && typeof data.version === 'string') {
            this.cachedVersion = data.version
          }
        } catch {}
        return true
      }
      return false
    } catch {
      return false
    }
  }

  /**
   * 向 Omni 引擎同步最新配置 (ENABLE_IMAGE_OCR, ENABLE_DOCUMENT_OCR, OCR_MODEL_SIZE 等)
   */
  public async syncConfigFromDesktop(): Promise<boolean> {
    try {
      const { ConfigOrchestrator } = await import('../../../config/config-orchestrator')
      const orchestrator = ConfigOrchestrator.getInstance()
      const enableImageOcr = orchestrator.getValue<boolean>('ENABLE_IMAGE_OCR') ?? true
      const enableOfficeCover = orchestrator.getValue<boolean>('ENABLE_OFFICE_COVER') ?? false
      const maxDocOcrItems = orchestrator.getValue<number>('MAX_DOCUMENT_OCR_ITEMS') ?? 3
      const ocrModelSize = (orchestrator.getValue<string>('OCR_MODEL_SIZE') || 'tiny').toLowerCase()
      const maxContentSizeKb = orchestrator.getValue<number>('MAX_CONTENT_SIZE_KB') ?? 30
      const maxFileSizeMb = orchestrator.getValue<number>('MAX_FILE_SIZE') ?? 100
      // 统一走 analysis-mode 模块解析，避免此处 `|| 'full'` 与其它模块 `?? 'quick_name'` 的兜底不一致
      const { resolveAnalysisMode } = await import('../../../config/analysis-mode')
      const analysisMode = resolveAnalysisMode()
      const reuseBasic = orchestrator.getValue<boolean>('REUSE_BASIC_ANALYSIS_DATA') ?? true
      // 语音识别时长（基础 AI 引擎口径，参与 120s 单文件预算求解）
      const audioAnalysisDuration = orchestrator.getValue<number>('AUDIO_ANALYSIS_DURATION') ?? 30
      // 当前用户界面语言，同步给 Omni 引擎（供 OCR/元数据提取等按语言处理）
      const currentLanguage = orchestrator.getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN'

      // 提取最新的受保护排除项清单 (来自 IGNORE_RULES 中 isCzkawka 标记)
      let excludedItems: any[] = []
      try {
        const { duplicateDetectionService } =
          await import('../../filesystem/duplicate-detection-service')
        excludedItems = duplicateDetectionService
          ? duplicateDetectionService.getProtectedExcludedItems()
          : []
      } catch {
        excludedItems = []
      }

      const embeddingProfile =
        orchestrator.getValue<'classic_light' | 'gemma_unified'>('AI_EMBEDDING_PROFILE') ||
        'classic_light'
      const mrlDimension = orchestrator.getValue<number>('EMBEDDING_MRL_DIMENSION') || 512

      let enableNsfwPerception = false
      let enableFacePerception = false
      try {
        const { modularResourceService } = await import('../modular-resource-service')
        enableNsfwPerception = modularResourceService.processManager
          ? modularResourceService.processManager.isUsable('perception_nsfw')
          : modularResourceService.getModule('perception_nsfw')?.install_state === 'active'
        enableFacePerception = modularResourceService.processManager
          ? modularResourceService.processManager.isUsable('perception_face')
          : modularResourceService.getModule('perception_face')?.install_state === 'active'
      } catch {}

      const payload = JSON.stringify({
        enable_office_cover: enableOfficeCover,
        max_document_ocr_items: maxDocOcrItems,
        enable_image_ocr: enableImageOcr,
        ocr_model_size: ocrModelSize,
        max_content_size_kb: maxContentSizeKb,
        max_file_size_mb: maxFileSizeMb,
        analysis_mode: analysisMode,
        reuse_basic_analysis_data: reuseBasic,
        audio_analysis_duration: audioAnalysisDuration,
        excluded_items: excludedItems,
        language: currentLanguage,
        embedding_profile: embeddingProfile,
        mrl_dimension: mrlDimension,
        enable_nsfw_perception: enableNsfwPerception,
        enable_face_perception: enableFacePerception
      })

      const res = await fetch(`${this.baseUrl}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(3000)
      })

      if (res.ok) {
        logger.debug(
          LogCategory.SYSTEM,
          `[OmniService] 已向 Omni 引擎同步配置: enable_office_cover=${enableOfficeCover}, max_document_ocr_items=${maxDocOcrItems}, enable_image_ocr=${enableImageOcr}, ocr_model_size=${ocrModelSize}, audio_analysis_duration=${audioAnalysisDuration}s, excluded_items_count=${excludedItems.length}, language=${currentLanguage}, embedding_profile=${embeddingProfile}, mrl_dimension=${mrlDimension}`
        )
        return true
      }
      return false
    } catch (err: any) {
      logger.debug(
        LogCategory.SYSTEM,
        '[OmniService] 同步配置到 Omni 引擎失败 (无头环境已容错):',
        err.message
      )
      return false
    }
  }

  /**
   * 卸载指定插槽的模型（释放 Windows 文件句柄）
   */
  public async unloadSlot(slot: string): Promise<boolean> {
    logger.debug(LogCategory.SYSTEM, `[OmniService] 触发卸载插槽模型以释放句柄: ${slot}`)
    return this.syncConfigFromDesktop()
  }

  /**
   * 语言切换后通知 Omni 重载只读 SQLite 连接
   * POST /api/reconnect { dbPath } (ADR-0035 §8.4 双消费者热重连契约)
   */
  public async reconnect(dbPath: string): Promise<boolean> {
    await this.ensureRunning()
    try {
      const res = await fetch(`${this.baseUrl}/api/reconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dbPath }),
        signal: AbortSignal.timeout(5000)
      })
      if (!res.ok) {
        logger.warn(
          LogCategory.SYSTEM,
          `[OmniService] POST /api/reconnect 失败: status=${res.status}`
        )
        return false
      }
      const json = await res.json()
      logger.debug(LogCategory.SYSTEM, `[OmniService] Omni 热重连结果:`, JSON.stringify(json))
      return json.omwAvailable === true
    } catch (err: any) {
      logger.warn(LogCategory.SYSTEM, `[OmniService] POST /api/reconnect 异常:`, err.message)
      return false
    }
  }

  /**
   * 提取文件全量信息 (元数据, Magika, Markdown, EXIF, 音视频标签)
   */
  public async extract(
    filePath: string,
    options?: OmniExtractOptions
  ): Promise<OmniExtractionResponse | null> {
    await this.ensureRunning()
    const tStart = Date.now()
    // 逐请求覆盖字段经 POST /api/extract 下沉至 Rust ExtractRequest，杜绝回退通道丢失工作区参数。
    const reqBody = buildExtractRequestBody(filePath, options)
    logger.debug(
      LogCategory.SYSTEM,
      `[OmniService] >>> POST /api/extract 请求发起:`,
      JSON.stringify(reqBody)
    )

    const doFetch = async () => {
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
    }

    try {
      return await doFetch()
    } catch (err: any) {
      const causeMsg =
        err?.cause?.message || err?.cause?.code || (err?.cause ? String(err.cause) : '')
      const fullError = causeMsg ? `${err.message} (cause: ${causeMsg})` : err.message
      logger.warn(
        LogCategory.SYSTEM,
        `[OmniService] <<< POST /api/extract 首次调用异常 (${filePath}): 耗时: ${Date.now() - tStart}ms, 错误: ${fullError}，尝试自愈拉起并重试...`
      )
      // 若出现网络错误（如进程被外部杀死重构中），触发自愈并重试一次
      const restarted = await this.start()
      if (restarted) {
        try {
          return await doFetch()
        } catch (retryErr: any) {
          const retryCause =
            retryErr?.cause?.message ||
            retryErr?.cause?.code ||
            (retryErr?.cause ? String(retryErr.cause) : '')
          const retryFull = retryCause
            ? `${retryErr.message} (cause: ${retryCause})`
            : retryErr.message
          logger.error(
            LogCategory.SYSTEM,
            `[OmniService] <<< POST /api/extract 自愈重试仍失败 (${filePath}): ${retryFull}`
          )
        }
      }
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
    await this.ensureRunning()
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

      const doFetch = async () => {
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
      }

      try {
        return await doFetch()
      } catch (fetchErr: any) {
        const restarted = await this.start()
        if (restarted) {
          try {
            return await doFetch()
          } catch {}
        }
        throw fetchErr
      }
    } catch (err: any) {
      logger.debug(
        LogCategory.SYSTEM,
        `[OmniService] <<< POST /api/geo/reverse 调用异常 (耗时: ${Date.now() - tStart}ms):`,
        err.message
      )
      return null
    }
  }

  /**
   * 获取 Magika 分类信息 (与历史 Node.js Magika 返回格式 100% 对齐)
   */
  public async identifyMagika(filePath: string): Promise<MagikaFileCategory | null> {
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
        is_text:
          m.is_text ??
          (extResult.mime_type.startsWith('text/') ||
            (extResult.markdown_content ? extResult.markdown_content.length > 0 : false)),
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
  public async getFileCover(
    filePath: string,
    options?: {
      skipIfExistsPath?: string
      skipIfExists?: boolean
      enableOfficeCover?: boolean
    }
  ): Promise<Buffer | null> {
    if (options?.skipIfExists) {
      return null
    }

    if (options?.skipIfExistsPath) {
      try {
        const fs = await import('node:fs/promises')
        await fs.access(options.skipIfExistsPath)
        logger.debug(
          LogCategory.SYSTEM,
          `[OmniService] 目标缩略图已存在于磁盘，跳过 Omni /api/cover 封面生成: ${options.skipIfExistsPath}`
        )
        return null
      } catch {
        // 文件不存在，继续执行后续生成
      }
    }

    await this.ensureRunning()
    const tStart = Date.now()
    // [V12-E06] Office 封面逐请求透传：false/true 均按请求写入 query，绝不丢失用户显式关闭意图。
    const url = buildCoverUrl(this.baseUrl, filePath, options)
    logger.debug(LogCategory.SYSTEM, `[OmniService] >>> GET /api/cover 请求发起 (${filePath})`)

    const doFetch = async () => {
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
      const durationHeader = res.headers.get('x-cover-duration-ms')
      const durationMs = durationHeader ? Number(durationHeader) : Date.now() - tStart
      this.lastCoverDurationMs = durationMs
      this.coverDurationMap.set(path.resolve(filePath), durationMs)
      logger.debug(
        LogCategory.SYSTEM,
        `[OmniService] <<< GET /api/cover 响应成功 (${filePath}, 字节大小: ${buffer.length} B, 耗时: ${durationMs}ms)`
      )
      return buffer
    }

    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(
        LogCategory.SYSTEM,
        `[OmniService] <<< GET /api/cover 首次调用异常 (${filePath}, 耗时: ${Date.now() - tStart}ms): ${err.message}，尝试自愈重试...`
      )
      const restarted = await this.start()
      if (restarted) {
        try {
          return await doFetch()
        } catch (retryErr: any) {
          logger.debug(
            LogCategory.SYSTEM,
            `[OmniService] <<< GET /api/cover 自愈重试仍异常 (${filePath}):`,
            retryErr.message
          )
        }
      }
      return null
    }
  }

  /**
   * 获取最近一次由 Omni 引擎执行封面提取的物理耗时 (毫秒)
   * 若指定 forFilePath，则精准返回该文件的耗时并即焚（防止后续未调用封面提取的文件污染），
   * 若未指定，则降级返回全局 lastCoverDurationMs（兼容旧调用）。
   */
  public getLastCoverDurationMs(forFilePath?: string): number | undefined {
    if (forFilePath) {
      const resolved = path.resolve(forFilePath)
      const duration = this.coverDurationMap.get(resolved)
      if (duration !== undefined) {
        this.coverDurationMap.delete(resolved)
        return duration
      }
      return undefined
    }
    return this.lastCoverDurationMs
  }

  /**
   * 兼容别名：获取 PDF 封面图
   */
  public async getPdfCover(filePath: string): Promise<Buffer | null> {
    return this.getFileCover(filePath)
  }

  /**
   * 原生多模态感知 (单点聚合: 元数据 + NTFS ADS + 频域水印/打码 + CLIP + SenseVoice ASR + 逆地理)
   * POST /api/perceive
   */
  public async perceive(
    filePath: string,
    options?: OmniPerceptionOptions
  ): Promise<OmniPerceptionResponse | null> {
    await this.ensureRunning()
    const tStart = Date.now()
    const reqBody = buildPerceiveRequestBody(filePath, options, <T>(key: string) =>
      this.getConfigValue<T>(key)
    )
    logger.debug(
      LogCategory.SYSTEM,
      `[OmniService] >>> POST /api/perceive 请求发起:`,
      JSON.stringify(reqBody)
    )

    // perceive 超时 = CPU 阶段上限（总预算 − 按类型分配的 AI 保底），见 analysis-timeout-policy。
    // 音视频不再放宽到 10 分钟：那会让单文件真实上限变成「10 分钟 + AI 分析」。
    // 请求里带了音视频专属参数时以之为准，避免无扩展名的媒体文件被误判成文档。
    const isMediaHint =
      options?.enableAudioTranscript === true || options?.audioAnalysisDuration !== undefined
    const budget = resolveAnalysisTimeoutBudget(filePath, undefined, isMediaHint)
    // 视频抽帧与多模态感知具有客观重计算开销（如 200s+ 视频 Route A 需约 80-90s），
    // 为防止压线 100s 触发 AbortSignal 导致整个视频切片与向量全毁，至少预留 totalMs - 20s 给 perceive
    const effectiveCpuCapMs =
      budget.kind === 'video' ? Math.max(budget.cpuCapMs, budget.totalMs - 20000) : budget.cpuCapMs
    const timeoutMs = options?.timeoutMs || effectiveCpuCapMs

    const doFetch = async () => {
      const res = await fetch(`${this.baseUrl}/api/perceive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Connection: 'keep-alive'
        },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(timeoutMs)
      })

      if (!res.ok) {
        logger.warn(
          LogCategory.SYSTEM,
          `[OmniService] <<< POST /api/perceive 响应异常: status=${res.status}, 耗时: ${Date.now() - tStart}ms`
        )
        return null
      }

      const json = (await res.json()) as OmniPerceptionResponse

      // 级联仲裁终局结果显式输出至 Desktop 控制台 (debug/开发模式可见)
      if (
        json.winning_hypothesis ||
        (json.candidate_hypotheses && json.candidate_hypotheses.length > 0)
      ) {
        logger.debug(
          LogCategory.SYSTEM,
          `[级联仲裁:Desktop] 终局胜出: "${json.winning_hypothesis?.prompt_text || '无'}" (置信度: ${json.winning_hypothesis?.confidence ?? 'N/A'}) | 建议命名: ${json.smart_name || '无'}`
        )
        if (json.candidate_hypotheses && json.candidate_hypotheses.length > 0) {
          const top100 = json.candidate_hypotheses.slice(0, 100)
          logger.debug(
            LogCategory.SYSTEM,
            `[普遍语法造句:Desktop] Top ${top100.length} 候选造句排列表 (总数: ${json.candidate_hypotheses.length}):`
          )
          for (let i = 0; i < top100.length; i++) {
            const cand = top100[i]
            logger.debug(
              LogCategory.SYSTEM,
              `  [${String(i + 1).padStart(3, ' ')}] conf=${cand.confidence.toFixed(3)} winner=${cand.is_winner ? '★YES' : ' NO '} prompt="${cand.prompt_text}"`
            )
          }
        }
      }

      // 输出所有融合标签 (fused_tags)
      if (json.fused_tags && json.fused_tags.length > 0) {
        logger.debug(
          LogCategory.SYSTEM,
          `[双锚点融合:Desktop] 最终胜出融合标签 (count=${json.fused_tags.length}):`
        )
        for (let i = 0; i < json.fused_tags.length; i++) {
          const t = json.fused_tags[i]
          logger.debug(
            LogCategory.SYSTEM,
            `  [${String(i + 1).padStart(2, ' ')}] conf=${t.confidence.toFixed(3)} code=${t.code.padEnd(30, ' ')} name=${t.name.padEnd(10, ' ')} parent=${t.parent_codes?.join(',') ?? 'None'}`
          )
        }
      }

      // 输出原生事实标签 (fact_tags, Task 2)
      if (json.fact_tags && json.fact_tags.length > 0) {
        logger.debug(
          LogCategory.SYSTEM,
          `[事实标签:Desktop] 接收 Omni fact_tags (count=${json.fact_tags.length}): [${json.fact_tags.map(t => t.name).join(', ')}]`
        )
        for (let i = 0; i < json.fact_tags.length; i++) {
          const t = json.fact_tags[i]
          logger.debug(
            LogCategory.SYSTEM,
            `  [${String(i + 1).padStart(2, ' ')}] conf=${t.confidence.toFixed(3)} code=${t.code.padEnd(30, ' ')} name=${t.name.padEnd(12, ' ')} engine=${t.engine ?? 'metadata'}`
          )
        }
      }

      logger.debug(
        LogCategory.SYSTEM,
        `[OmniService] <<< POST /api/perceive 响应成功 (${filePath}, 耗时: ${Date.now() - tStart}ms):`,
        JSON.stringify({
          file_path: json.file_path,
          file_source: json.file_source,
          workflow_state: json.workflow_state,
          security_level: json.security_level,
          has_watermark: json.has_watermark,
          has_mosaic: json.has_mosaic,
          has_text: json.has_text,
          aesthetic_score: json.aesthetic_score,
          quality_score: json.quality_score,
          photo_type: json.photo_type,
          smart_name: json.smart_name,
          content_description: json.content_description,
          winning_hypothesis: json.winning_hypothesis,
          candidate_hypotheses_count: json.candidate_hypotheses?.length || 0,
          visual_tags: json.visual_tags || [],
          visual_tags_count: json.visual_tags?.length || 0,
          fused_tags: json.fused_tags || [],
          fused_tags_count: json.fused_tags?.length || 0,
          fact_tags: json.fact_tags || [],
          fact_tags_count: json.fact_tags?.length || 0,
          ram_tags: json.ram_tags || [],
          morphology_tags: json.morphology_tags || [],
          clip_tags: json.clip_tags || [],
          nsfw_tags: json.nsfw_tags || [],
          sensitive_types: json.sensitive_types || [],
          content_rating: json.content_rating,
          has_asr: json.has_asr ?? !!json.asr,
          asr_length: json.asr_length ?? json.asr?.length ?? 0,
          asr: json.asr ?? null,
          audio_events: json.audio_events || [],
          ocr_text_length: json.ocr_text?.length || 0,
          markdown_content: json.markdown_content,
          markdown_content_length: json.markdown_content?.length || 0,
          has_metadata: !!json.metadata && Object.keys(json.metadata).length > 0,
          benchmark: json.benchmark,
          geo_address: json.geo_address
        })
      )
      return json
    }

    try {
      return await doFetch()
    } catch (err: any) {
      const causeMsg =
        err?.cause?.message || err?.cause?.code || (err?.cause ? String(err.cause) : '')
      const fullError = causeMsg ? `${err.message} (cause: ${causeMsg})` : err.message
      logger.warn(
        LogCategory.SYSTEM,
        `[OmniService] <<< POST /api/perceive 首次调用异常 (${filePath}): 耗时: ${Date.now() - tStart}ms, 错误: ${fullError}，尝试自愈拉起并重试...`
      )
      // 连接被重置/挂断通常意味着本地 Omni 进程已原生崩溃（如 DirectML abort）。
      // 在拉起前先持久化「纯 CPU 兜底」结论，确保紧随其后的自愈重试不再复用坏 GPU 路径。
      if (/ECONNRESET|ECONNREFUSED|socket hang up/i.test(fullError)) {
        this.persistDmlCrash(this.dmlCrashMarkerPath)
        logger.warn(
          LogCategory.SYSTEM,
          '[OmniService] perceive 传输中断，判定引擎异常退出；自愈重试将以纯 CPU 兜底拉起'
        )
      }
      const restarted = await this.start()
      if (restarted) {
        try {
          return await doFetch()
        } catch (retryErr: any) {
          const retryCause =
            retryErr?.cause?.message ||
            retryErr?.cause?.code ||
            (retryErr?.cause ? String(retryErr.cause) : '')
          const retryFull = retryCause
            ? `${retryErr.message} (cause: ${retryCause})`
            : retryErr.message
          logger.error(
            LogCategory.SYSTEM,
            `[OmniService] <<< POST /api/perceive 自愈重试仍失败 (${filePath}): ${retryFull}`
          )
        }
      }
      return null
    }
  }

  /**
   * 单指标：音频转文本 (SenseVoice ASR)
   * POST /api/audio/transcribe
   */
  public async transcribeAudio(
    filePath: string,
    options?: { language?: string; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<OmniAudioTranscribeResponse | null> {
    await this.ensureRunning()
    const tStart = Date.now()
    const reqBody = {
      file_path: filePath,
      language: options?.language
    }
    const timeoutMs = options?.timeoutMs || 60000

    const doFetch = async () => {
      let fetchSignal: AbortSignal = AbortSignal.timeout(timeoutMs)
      if (options?.signal) {
        if (typeof (AbortSignal as any).any === 'function') {
          fetchSignal = (AbortSignal as any).any([options.signal, fetchSignal])
        } else {
          fetchSignal = options.signal
        }
      }
      const res = await fetch(`${this.baseUrl}/api/audio/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: fetchSignal
      })
      if (!res.ok) return null
      return (await res.json()) as OmniAudioTranscribeResponse
    }

    try {
      return await doFetch()
    } catch (err: any) {
      if (options?.signal?.aborted || err?.name === 'AbortError') {
        return null
      }
      logger.debug(
        LogCategory.SYSTEM,
        `[OmniService] transcribeAudio 异常 (${filePath}):`,
        err.message
      )
      const restarted = await this.start()
      if (restarted) {
        try {
          return await doFetch()
        } catch {}
      }
      return null
    }
  }

  /**
   * 单指标：转换标准音频并降噪 (16kHz, mono, pcm_s16le WAV)
   * POST /api/audio/convert
   */
  public async convertToStandardAudio(
    filePath: string,
    durationSeconds?: number,
    timeoutMs: number = 60000
  ): Promise<OmniAudioConvertResponse | null> {
    await this.ensureRunning()
    const tStart = Date.now()
    const reqBody = {
      file_path: filePath,
      duration_seconds: durationSeconds
    }

    const doFetch = async () => {
      const res = await fetch(`${this.baseUrl}/api/audio/convert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) return null
      return (await res.json()) as OmniAudioConvertResponse
    }

    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(
        LogCategory.SYSTEM,
        `[OmniService] convertToStandardAudio 异常 (${filePath}, 耗时: ${Date.now() - tStart}ms):`,
        err.message
      )
      const restarted = await this.start()
      if (restarted) {
        try {
          return await doFetch()
        } catch {}
      }
      return null
    }
  }

  /**
   * 单指标：提取视觉标签 (CLIP 图像特征向量)
   * POST /api/vision/tags
   */
  public async extractVisualTags(
    filePath: string,
    options?: { language?: string; topK?: number; timeoutMs?: number }
  ): Promise<string[] | null> {
    await this.ensureRunning()
    const reqBody = {
      file_path: filePath,
      language: options?.language,
      top_k: options?.topK
    }
    const timeoutMs = options?.timeoutMs || 30000

    const doFetch = async () => {
      const res = await fetch(`${this.baseUrl}/api/vision/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) return null
      const json = (await res.json()) as OmniVisionTagsResponse
      return json.tags || []
    }

    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(
        LogCategory.SYSTEM,
        `[OmniService] extractVisualTags 异常 (${filePath}):`,
        err.message
      )
      const restarted = await this.start()
      if (restarted) {
        try {
          return await doFetch()
        } catch {}
      }
      return null
    }
  }

  /**
   * 单指标：图像水印与打码频域检测
   * POST /api/vision/inspect
   */
  public async inspectVision(
    filePath: string,
    timeoutMs: number = 10000
  ): Promise<OmniVisionInspectResponse | null> {
    await this.ensureRunning()
    const reqBody = { file_path: filePath }

    const doFetch = async () => {
      const res = await fetch(`${this.baseUrl}/api/vision/inspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) return null
      return (await res.json()) as OmniVisionInspectResponse
    }

    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(
        LogCategory.SYSTEM,
        `[OmniService] inspectVision 异常 (${filePath}):`,
        err.message
      )
      const restarted = await this.start()
      if (restarted) {
        try {
          return await doFetch()
        } catch {}
      }
      return null
    }
  }

  /**
   * 单指标：文件系统 NTFS ADS 来源追踪 (Zone.Identifier)
   * POST /api/fs/ads
   */
  public async inspectAds(
    filePath: string,
    timeoutMs: number = 5000
  ): Promise<OmniFsAdsResponse | null> {
    await this.ensureRunning()
    const reqBody = { file_path: filePath }

    const doFetch = async () => {
      const res = await fetch(`${this.baseUrl}/api/fs/ads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) return null
      return (await res.json()) as OmniFsAdsResponse
    }

    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] inspectAds 异常 (${filePath}):`, err.message)
      const restarted = await this.start()
      if (restarted) {
        try {
          return await doFetch()
        } catch {}
      }
      return null
    }
  }

  /**
   * 工业级混合检索：批量写入双轨索引 (USearch 密集向量 + Tantivy BM25)
   * POST /api/search/index
   */
  public async indexDocuments(
    documents: OmniIndexedDocument[],
    timeoutMs: number = 30000
  ): Promise<OmniIndexResponse | null> {
    await this.ensureRunning()
    const doFetch = async () => {
      const res = await fetch(`${this.baseUrl}/api/search/index`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documents }),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) return null
      return (await res.json()) as OmniIndexResponse
    }
    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] indexDocuments 异常:`, err.message)
      const restarted = await this.start()
      if (restarted) {
        try {
          return await doFetch()
        } catch {}
      }
      return null
    }
  }

  /**
   * 工业级混合检索：双轨混合检索与加权 RRF 融合打分 + 规则重排
   * POST /api/search/hybrid
   */
  public async searchHybrid(
    options: {
      queryText?: string
      queryEmbedding?: number[]
      topK?: number
    },
    timeoutMs: number = 10000
  ): Promise<OmniHybridSearchResponse | null> {
    await this.ensureRunning()
    const doFetch = async () => {
      const res = await fetch(`${this.baseUrl}/api/search/hybrid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) return null
      return (await res.json()) as OmniHybridSearchResponse
    }
    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] searchHybrid 异常:`, err.message)
      const restarted = await this.start()
      if (restarted) {
        try {
          return await doFetch()
        } catch {}
      }
      return null
    }
  }

  /**
   * 约束层次凝聚聚类 (HAC) 与提示词向量引导多级目录自动归档
   * POST /api/search/cluster
   */
  public async clusterDocuments(
    options: {
      documents: OmniClusterDocument[]
      prompt?: string
      promptEmbedding?: number[]
      /** 当前嵌入档位：classic_light (bekko 384d) | gemma_unified (MRL 256/512/768d) */
      embeddingProfile?: string
      /** 当前目标向量维度；缺省时由 Omni 端按档位与服务器配置自适应 */
      embeddingDim?: number
      distanceThreshold?: number
      maxLeafSize?: number
      maxDepth?: number
      maxRootDirectories?: number
      maxSubdirectories?: number
      similarityFloor?: number
      similarityStep?: number
      clusteringMode?: ClusteringMode
    },
    timeoutMs: number = 30000
  ): Promise<OmniClusterResponse | null> {
    await this.ensureRunning()
    const doFetch = async () => {
      const res = await fetch(`${this.baseUrl}/api/search/cluster`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) {
        const errorText = await res.text().catch(() => '')
        logger.warn(
          LogCategory.SYSTEM,
          `[OmniService] clusterDocuments 响应错误 HTTP ${res.status}: ${errorText}`
        )
        return { success: false, error: `HTTP ${res.status}: ${errorText}` }
      }
      return (await res.json()) as OmniClusterResponse
    }
    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] clusterDocuments 异常:`, err.message)
      const restarted = await this.start()
      if (restarted) {
        try {
          return await doFetch()
        } catch {}
      }
      return null
    }
  }

  /**
   * OpenHowNet 语义描述查询与自然语言描述句合成 (支柱 3)
   * POST /api/hownet/describe
   */
  public async describeHowNet(
    word: string,
    timeoutMs: number = 5000
  ): Promise<OmniHowNetDescribeResult | null> {
    await this.ensureRunning()
    const reqBody = { word }

    const doFetch = async () => {
      const res = await fetch(`${this.baseUrl}/api/hownet/describe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) return null
      return (await res.json()) as OmniHowNetDescribeResult
    }

    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] describeHowNet 异常 (${word}):`, err.message)
      const restarted = await this.start()
      if (restarted) {
        try {
          return await doFetch()
        } catch {}
      }
      return null
    }
  }

  /**
   * 获取当前生效的嵌入模型档位 (classic_light | gemma_unified)
   */
  public async getEmbeddingProfile(): Promise<'classic_light' | 'gemma_unified'> {
    try {
      const { ConfigOrchestrator } = await import('../../../config/config-orchestrator')
      const orchestrator = ConfigOrchestrator.getInstance()
      return (
        orchestrator.getValue<'classic_light' | 'gemma_unified'>('AI_EMBEDDING_PROFILE') ||
        'classic_light'
      )
    } catch {
      return 'classic_light'
    }
  }

  /**
   * Tier 1 端侧纯 CPU 文本特征与 384 维向量提取 (支柱 4)
   * POST /api/text/analyze
   */
  public async analyzeText(
    text: string,
    options?: { fileName?: string; mtime?: string },
    timeoutMs: number = 10000
  ): Promise<OmniTextAnalysisResult | null> {
    await this.ensureRunning()
    const reqBody = {
      text,
      fileName: options?.fileName,
      mtime: options?.mtime
    }

    const doFetch = async () => {
      const res = await fetch(`${this.baseUrl}/api/text/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) return null
      return (await res.json()) as OmniTextAnalysisResult
    }

    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] analyzeText 异常:`, err.message)
      const restarted = await this.start()
      if (restarted) {
        try {
          return await doFetch()
        } catch {}
      }
      return null
    }
  }

  /**
   * 原生多模态敏感内容鉴别 (POST /api/text/nsfw)
   * 同时支持纯文本 (FastText + nsfw-l3)、本地文件 (图片/文档) 与 Base64 图片 (nsfw-mobilenetv2)，
   * 覆盖 暴恐 / 涉政 / 违规 / 色情 / 辱骂 / 血腥 等多维鉴别。
   */
  public async assertNsfw(
    params: {
      text?: string
      filePath?: string
      imageBase64?: string
      language?: string
    },
    timeoutMs: number = 30000
  ): Promise<{
    success: boolean
    is_sensitive: boolean
    status: 'clean' | 'flagged' | 'skipped'
    tags: string[]
    sensitive_types: string[]
    content_rating?: string | null
    nsfw_probs?: number[] | null
    supported_dimensions?: string[]
  } | null> {
    await this.ensureRunning()
    try {
      const res = await fetch(`${this.baseUrl}/api/text/nsfw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: params.text,
          file_path: params.filePath,
          image_base64: params.imageBase64,
          language: params.language
        }),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) {
        logger.warn(
          LogCategory.SYSTEM,
          `[OmniService] POST /api/text/nsfw 响应异常: status=${res.status}`
        )
        return null
      }
      return (await res.json()) as any
    } catch (err: any) {
      logger.warn(LogCategory.SYSTEM, '[OmniService] assertNsfw 调用异常:', err?.message || err)
      return null
    }
  }

  /**
   * 语义标签父级推荐与物化路径推导 (POST /api/taxonomy/resolve-parent)
   */
  public async resolveTaxonomyParent(
    params: {
      tagName: string
      language?: string
      contextHint?: string
    },
    timeoutMs: number = 300
  ): Promise<OmniResolveParentResponse | null> {
    await this.ensureRunning()
    const reqBody: OmniResolveParentRequest = {
      tag_name: params.tagName,
      language: params.language,
      context_hint: params.contextHint
    }

    try {
      const res = await fetch(`${this.baseUrl}/api/taxonomy/resolve-parent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) return null
      return (await res.json()) as OmniResolveParentResponse
    } catch (err: any) {
      logger.debug(
        LogCategory.SYSTEM,
        `[OmniService] resolveTaxonomyParent 超时或异常降级:`,
        err.message
      )
      return null
    }
  }

  /**
   * 批量鉴别标签是否属于受控语义本体并检验祖先继承链 (POST /api/v1/taxonomy/inspect-tag)
   * 严格遵循悲观熔断：超时 1500ms 强阻断，严禁静默吞异常
   */
  public async inspectControlledTags(
    items: InspectControlledTagItem[],
    language: string = 'zh-CN',
    timeoutMs: number = 1500
  ): Promise<InspectControlledTagsResponse> {
    await this.ensureRunning()
    const reqBody = {
      items,
      language
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const res = await fetch(`${this.baseUrl}/api/v1/taxonomy/inspect-tag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: controller.signal
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`)
      }
      return (await res.json()) as InspectControlledTagsResponse
    } catch (err: any) {
      logger.warn(
        LogCategory.SYSTEM,
        `[OmniService] inspectControlledTags 异常或超时: ${err.message}`
      )
      throw new Error(`Omni受控标签鉴别失败: ${err.message}`)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 解析当前激活的多模态嵌入画像档位与向量维度 (Spec §3.2.1)
   */
  public async resolveEmbeddingTarget(options?: {
    skipAutoStart?: boolean
  }): Promise<{ profile: 'classic_light' | 'gemma_unified'; dim: number }> {
    try {
      const { ConfigOrchestrator } = await import('../../../config/config-orchestrator')
      const orchestrator = ConfigOrchestrator.getInstance()
      const profile =
        orchestrator.getValue<'classic_light' | 'gemma_unified'>('AI_EMBEDDING_PROFILE') ||
        'classic_light'
      const dim =
        profile === 'gemma_unified'
          ? orchestrator.getValue<number>('EMBEDDING_MRL_DIMENSION') || 512
          : 384
      return { profile, dim }
    } catch {
      return { profile: 'classic_light', dim: 384 }
    }
  }

  /**
   * 批量计算文本特征向量 (POST /api/v1/vector/batch-embed-text)
   * 依据 batch-organize-hybrid-vector-classification-spec.md 规格契约：
   * 支持 classic_light (Bekko 384d) 与 gemma_unified (Gemma 256/512/768d) 双底座动态路由
   */
  public async batchEmbedText(
    texts: string[],
    options?: {
      profile?: string
      dim?: number
      timeoutMs?: number
      skipAutoStart?: boolean
      signal?: AbortSignal
    }
  ): Promise<{
    vectors: number[][]
    count: number
    dim: number
    profile: string
    durationMs: number
  }> {
    if (options?.skipAutoStart) {
      if (!this.isReady()) {
        const isHealthy = await this.checkHealth({ timeoutMs: 200, signal: options?.signal })
        if (!isHealthy) {
          throw new Error('engine_not_ready')
        }
      }
    } else {
      await this.ensureRunning()
    }

    const reqBody = {
      texts,
      profile: options?.profile,
      dim: options?.dim
    }

    const timeoutMs = options?.timeoutMs ?? 10000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    let cleanupAbortListener: (() => void) | undefined
    if (options?.signal) {
      if (options.signal.aborted) {
        controller.abort()
      } else {
        const onAbort = () => controller.abort()
        options.signal.addEventListener('abort', onAbort)
        cleanupAbortListener = () => options.signal!.removeEventListener('abort', onAbort)
      }
    }

    try {
      const res = await fetch(`${this.baseUrl}/api/v1/vector/batch-embed-text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: controller.signal
      })
      if (!res.ok) {
        let detail = ''
        try {
          const body = (await res.json()) as { error?: string }
          detail = body?.error || ''
        } catch {
          // 忽略非 JSON 错误响应解析异常
        }
        if (res.status === 503) {
          const isDecryptFail =
            detail.includes('AEAD') ||
            detail.includes('解密失败') ||
            detail.includes('密钥版本不匹配') ||
            detail.includes('AeadDecryptFailed')
          const err = new Error(
            isDecryptFail
              ? `AEAD_DECRYPT_FAILED: ${detail || 'http_503'}`
              : detail
                ? `http_503: ${detail}`
                : 'http_503'
          )
          ;(err as any).status = 503
          ;(err as any).code = isDecryptFail ? 'AEAD_DECRYPT_FAILED' : 'HTTP_503'
          ;(err as any).detail = detail
          throw err
        }
        throw new Error(`HTTP ${res.status}: ${res.statusText}${detail ? ` - ${detail}` : ''}`)
      }
      return (await res.json()) as {
        vectors: number[][]
        count: number
        dim: number
        profile: string
        durationMs: number
      }
    } catch (err: any) {
      logger.warn(LogCategory.SYSTEM, `[OmniService] batchEmbedText 异常或超时: ${err.message}`)
      throw err
    } finally {
      clearTimeout(timer)
      cleanupAbortListener?.()
    }
  }

  /**
   * 基础引擎真实推理探活冒烟自检协议 (Real Inference Smoke Test)
   * 先通过 /api/v1/engine/status 双向核验挂载清单，再直连 POST /api/v1/vector/batch-embed-text 执行真实张量嵌入
   */
  public async runSmokeTest(payload: {
    profile: 'classic_light' | 'gemma_unified'
    model_paths?: Record<string, string>
    test_tokens?: string[]
  }): Promise<{ success: boolean; latency_ms?: number; error?: string; errorCode?: string }> {
    try {
      await this.ensureRunning()
      // 端口就绪门禁：ensureRunning() 返回 ≠ HTTP 端口已监听。
      // 刚装完/冷启动时模型可能仍在加载，端口尚未监听；若立即探测会得到
      // fetch failed（连接拒绝）。这里先有界等待端口可达（默认最长 30s），
      // 仍未可达才判失败，给用户明确「引擎还没就绪」的语义而非裸连接错误。
      const portReady = await this.waitForEnginePortReady()
      if (!portReady) {
        // 返回结构化错误码，由前端 formatPluginErrorMessage 按码表转译为大白话，
        // 避免裸字符串里夹杂 API 等英文被全词匹配误判成网络错误。
        return {
          success: false,
          error: '引擎服务尚未就绪（等待引擎启动超时），请点击重试',
          errorCode: 'FAST_READY_TIMEOUT'
        }
      }
      const verify = await this.verifyMountManifestStatus()
      if (!verify.ok) {
        return { success: false, error: verify.error || '挂载清单校验未通过' }
      }

      const tokens = payload.test_tokens || ['test', '向量', 'search', '检索', 'firefly']
      const testEmbed = await this.batchEmbedText(tokens, {
        profile: payload.profile,
        timeoutMs: 4000
      })
      if (
        !testEmbed ||
        !Array.isArray(testEmbed.vectors) ||
        testEmbed.vectors.length !== tokens.length
      ) {
        return {
          success: false,
          error: `真实向量推理返回数目异常 (expected=${tokens.length}, actual=${testEmbed?.vectors?.length ?? 0})`
        }
      }
      const firstDim = testEmbed.vectors[0]?.length ?? 0
      if (firstDim === 0) {
        return { success: false, error: '真实向量推理返回 0 维空向量' }
      }
      return {
        success: true,
        latency_ms: testEmbed.durationMs
      }
    } catch (err: any) {
      logger.warn(
        LogCategory.SYSTEM,
        '[OmniService] runSmokeTest 异常:',
        err?.message || String(err)
      )
      const isDecryptFail =
        err?.code === 'AEAD_DECRYPT_FAILED' ||
        err?.message?.includes('AEAD') ||
        err?.message?.includes('解密失败') ||
        err?.message?.includes('密钥版本不匹配') ||
        err?.message?.includes('AeadDecryptFailed') ||
        err?.message?.includes('DECRYPT_FAILED') ||
        err?.detail?.includes('AEAD') ||
        err?.detail?.includes('解密失败')
      if (isDecryptFail) {
        return {
          success: false,
          errorCode: 'AEAD_DECRYPT_FAILED',
          error: '插件文件可能被篡改或密钥版本不匹配，请从官方源下载'
        }
      }
      return { success: false, error: err?.message || String(err), errorCode: err?.code }
    }
  }
}

export const omniService: OmniService = new Proxy({} as OmniService, {
  get(_target, prop, receiver) {
    const inst = OmniService.getInstance()
    const val = Reflect.get(inst as any, prop, receiver)
    return typeof val === 'function' ? val.bind(inst) : val
  },
  set(_target, prop, value, receiver) {
    const inst = OmniService.getInstance()
    return Reflect.set(inst as any, prop, value, receiver)
  }
})
