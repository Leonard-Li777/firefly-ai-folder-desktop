/**
 * Omni Native Service - Omni Rust 原生微服务管理器
 * （class 主体按职责块原样搬移；types/helpers 已抽至同目录子文件）
 */
import { ChildProcess, spawn } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { app, BrowserWindow, dialog, shell } from 'electron'
import { existsAsync, statOrNull } from '../../../infra/fs'
import { Agent as UndiciAgent, Dispatcher } from 'undici'
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
  readReadyMarkerSync,
  isPidAlive,
  killProcessTree,
  SSE_CONNECT_TIMEOUT_MS,
  SSE_READ_WATCHDOG_MS,
  DORMANT_MAX_ATTEMPTS,
  ConnectedTargetIdentity,
  readWithWatchdog,
  sleepCancellable,
  SseWatchdogTimeoutError,
  isTestEnvironment
} from '@firefly/shared'
import { MagikaFileCategory } from '@firefly/types'
import { resolveAnalysisTimeoutBudget } from '../analysis-timeout-policy'
import {
  isConnectionRefusedError,
  isTransientStatusFetchError,
  isTransientStatusHttpCode,
  shouldForceKillBeforeRespawn,
  shouldTriggerRestartOnFetchError,
  STATUS_VERIFY_BACKOFF_MS,
  STATUS_VERIFY_MAX_ATTEMPTS,
  STATUS_VERIFY_TIMEOUT_MS
} from './mount-verify-classify'
import { isLocalDevRuntime } from '../../../main/worktree-env'
import { OmniInstanceLock, OmniTokenManager } from '../omni-security'
import { OmniPerceptionHttpError, type VisualVocabStatusTelemetry } from './types'
import type { AssetsReloadResult } from '../visual-vocab-txn'
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
  classifyOmniCrash,
  computeNextDmlCrashMarker,
  serializeDmlCrashMarker,
  shouldForceCpuFromMarker
} from './ort-dml-crash-guard'
import {
  ServeContractCache,
  buildServeContractMismatchDetail,
  probeServeContract
} from './omni-binary-contract'
import {
  omniAiRunSmokeTest,
  omniAiBatchEmbedText,
  omniAiResolveEmbeddingTarget,
  omniAiInspectControlledTags,
  omniAiResolveTaxonomyParent,
  omniAiAssertNsfw,
  omniAiAnalyzeText,
  omniAiGetEmbeddingProfile,
  omniAiDescribeHowNet,
  omniAiClusterDocuments,
  omniAiSearchHybrid,
  omniAiIndexDocuments,
  omniAiInspectAds,
  omniAiInspectVision,
  omniAiExtractVisualTags
} from './omni-service-ai-client'
import {
  omniMediaParsePerceptionHttpError,
  omniMediaConvertToStandardAudio,
  omniMediaTranscribeAudio,
  omniMediaPerceive,
  omniMediaGetPdfCover,
  omniMediaGetFileCover,
  omniMediaIdentifyMagika,
  omniMediaReverseGeo,
  omniMediaExtractMetadataFull,
  omniMediaExtract
} from './omni-service-media-client'
import {
  omniLauncherStop,
  omniLauncherHandleTopologyChanged,
  omniLauncherReloadVisualAssets,
  omniLauncherVerifyMountManifestStatusAttempt,
  omniLauncherVerifyMountManifestStatus
} from './omni-service-topology'
import { omniLauncherDoStart } from './omni-service-launcher'
import {
  omniDiscoveryResolveAdoptedInstanceId,
  omniDiscoveryApplyAdoptedInstanceIdentity,
  omniDiscoveryVerifyAdoptedReuseOnce,
  omniDiscoveryVerifyOmniInstance,
  omniDiscoveryPushStatus,
  omniDiscoveryApplyOffline,
  omniDiscoveryApplyStatusEvent,
  omniDiscoveryConnectOnce,
  omniDiscoveryRunStreamLoop,
  omniDiscoveryKickEventStreamReconnect,
  omniDiscoveryEnsureEventStream,
  omniDiscoveryIsCurrentTargetHealthy,
  omniDiscoveryIsCurrentOwner,
  omniDiscoveryHandleDiscoveryFileChanged,
  omniDiscoverySyncFromDiscoveryFileOnce,
  omniDiscoveryRegisterPowerResumeWakeup,
  omniDiscoveryUnmountDiscoveryWatcher,
  omniDiscoveryMountDiscoveryWatcher,
  omniDiscoveryGetDiscoveryFile,
  omniDiscoveryResolveUserDataDir
} from './omni-service-discovery-stream'
import {
  omniProberNotifyBinaryMissing,
  omniProberDescribeBinarySearch,
  omniProberResolveContractCompatibleExecutable,
  omniProberProbeCandidateServeContract,
  omniProberCollectOmniExecutableCandidatesAsync,
  omniProberCollectOmniExecutableCandidates,
  omniProberBuildOmniExecutableCandidatePaths,
  omniProberCheckBinaryUpdated,
  omniProberStopDevBinaryWatch,
  omniProberStartDevBinaryWatch
} from './omni-service-binary-prober'
import {
  omniFetchHelperOmniFetch,
  omniFetchHelperRestartUnhealthyManaged,
  omniFetchHelperRecordManagedUnhealthyFailure
} from './omni-service-fetch'
import {
  omniLifecycleReconnect,
  omniLifecycleUnloadSlot,
  omniLifecycleSyncConfigFromDesktop,
  omniLifecycleCheckHealth,
  omniLifecycleTriggerStartupVisualReconcile,
  omniLifecycleHandleStartupVisualVocabStatus,
  omniLifecycleReloadAssets,
  omniLifecycleWaitForEnginePortReady,
  omniLifecycleStopImmediately
} from './omni-service-lifecycle-ops'
import {
  omniStatusQueryEnsureRunning,
  omniStatusQueryIsServiceRunning,
  omniStatusQueryIsReady,
  omniStatusQueryGetVersion
} from './omni-service-status-queries'
import {
  omniLaunchHelperUnlinkManifestSafe,
  omniLaunchHelperForceKillProcessTree,
  omniLaunchHelperAwaitLaunchContextClose,
  omniLaunchHelperGetLaunchStderrTail,
  omniLaunchHelperAppendLaunchStderr,
  omniLaunchHelperCreateLaunchContext
} from './omni-service-launch-helpers'
import {
  omniRestartScheduleRestart,
  omniRestartRestart,
  omniRestartWaitForPortReleased
} from './omni-service-restart'
import {
  omniDmlHandleKeyEpochMismatch,
  omniDmlPersistDmlCrash,
  omniDmlReadTextFileSafe,
  omniDmlResolveDmlCrashMarker
} from './omni-service-dml-guard'

/** Omni 本地 HTTP 四级通道类型 */
export type OmniFetchKind = 'probe' | 'call' | 'long' | 'stream'

export interface OmniFetchOptions extends RequestInit {
  /** 请求分级：probe(默认3s) / call(默认15s) / long(调用方限时) / stream(长连接不计 inflight) */
  kind?: OmniFetchKind
  /** 覆盖默认超时毫秒数（仅在未传外部 signal 或与外部 signal 合并时生效） */
  timeoutMs?: number
  /** 内部探活/重启流程标记：豁免 unhealthySince 记账与重启触发，仍执行目标同源 ECONNREFUSED/头不匹配自失效 */
  internal?: boolean
}

/** 每次 spawn 冻结的独立代际上下文（彻底取代易受 PID 复用污染的全局 Set） */
export interface LaunchContext {
  readonly generation: number
  readonly child: ChildProcess
  readonly pid: number | undefined
  readonly spawnedWithDml: boolean
  readonly stderrLines: string[]
  stderrPartial: string
  stderrBytes: number
  intentionalKill: boolean
  closed: boolean
  readonly closeDeferred: Promise<void>
  resolveClose: () => void
}

export interface VerifyInstanceResult {
  ok: boolean
  data?: Record<string, any>
  headerInstanceId?: string | null
  timedOut?: boolean
  portRefused?: boolean
  explicitNonTimeoutFailure?: boolean
}

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
  /** 契约不兼容（旧版/错版二进制）错误已上报标记，避免反复刷同一段诊断 */
  private incompatibleBinaryReported = false
  /** 契约不兼容冷却截止时间：冷却期内不再重复探测与拉起 */
  private incompatibleBinaryRetryAt = 0
  /** 二进制 CLI 契约结论缓存（键 = 路径 + mtime:size，二进制被覆盖后自动失效） */
  private readonly serveContractCache = new ServeContractCache()
  /** 可执行文件候选列表进程生命周期缓存 */
  private cachedExecutableCandidates: string[] | null = null
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

  // —— 严格递增代际、复用态 TTL、Per-launch 上下文与 60s 自愈状态 (Spec v1.7.3) ——
  private static readonly REUSE_READY_TTL_MS = 30_000
  private static readonly STARTUP_GRACE_MS = 15_000
  private static readonly UNHEALTHY_FAILURE_GAP_RESET_MS = 30_000
  private static readonly UNHEALTHY_RESTART_THRESHOLD_MS = 60_000
  private static readonly PROBE_DEFAULT_TIMEOUT_MS = 3_000
  private static readonly CALL_DEFAULT_TIMEOUT_MS = 15_000
  private static readonly STDERR_MAX_LINES = 32
  private static readonly STDERR_MAX_BYTES = 8 * 1024
  /** 契约不兼容冷却窗口：期间跳过重复探测与拉起（与二进制缺失冷却同量级） */
  private static readonly BINARY_CONTRACT_RETRY_MS = 60_000
  /** 单次 `serve --help` 契约探针超时（实测新版 149MB 二进制约 60~120ms，留足冷启动余量） */
  private static readonly BINARY_CONTRACT_PROBE_TIMEOUT_MS = 5_000

  private currentGeneration = 0
  private instanceChangedCallbacks = new Set<(nextGeneration: number) => void>()
  private lifecycleInactiveCallbacks = new Set<(nextGeneration: number) => void>()
  private lastVerifiedAtMs = 0
  private verifyPromise: Promise<boolean> | null = null
  private currentLaunchCtx: LaunchContext | null = null
  private inflightCount = 0
  private unhealthySince: number | null = null
  private lastFailureAt: number | null = null
  private restartUnhealthyPromise: Promise<boolean> | null = null
  private missingInstanceIdHeaderWarned = false

  /**
   * Omni 本地微服务专用 HTTP Dispatcher
   * 将 headersTimeout 与 bodyTimeout 设为 0（禁用 undici 内部默认 300s 超时），
   * 确保长耗时视频/音频多模态感知或批量向量计算完全由 AbortSignal 业务超时控制，
   * 杜绝在 300s 时触发 UND_ERR_HEADERS_TIMEOUT 扼杀 CPU 兜底推理。
   */
  private readonly omniDispatcher: Dispatcher = new UndiciAgent({
    headersTimeout: 0,
    bodyTimeout: 0,
    connectTimeout: 10_000,
    keepAliveTimeout: 30_000,
    keepAliveMaxTimeout: 60_000
  })

  /** 获取当前严格递增的 Omni 实例代际号 */
  public getGeneration(): number {
    return this.currentGeneration
  }

  /** 订阅 Omni 新实例就绪/采纳切换事件（传递严格递增的转移后新代际） */
  public onInstanceChanged(callback: (nextGeneration: number) => void): () => void {
    this.instanceChangedCallbacks.add(callback)
    return () => {
      this.instanceChangedCallbacks.delete(callback)
    }
  }

  /** 订阅 Omni 生命周期失活事件（停机或崩溃时先递增代际再发出转移后新代际） */
  public onLifecycleInactive(callback: (nextGeneration: number) => void): () => void {
    this.lifecycleInactiveCallbacks.add(callback)
    return () => {
      this.lifecycleInactiveCallbacks.delete(callback)
    }
  }

  private emitInstanceChanged(nextGeneration: number): void {
    for (const cb of this.instanceChangedCallbacks) {
      try {
        cb(nextGeneration)
      } catch (err) {
        logger.warn(LogCategory.SYSTEM, '[OmniService] onInstanceChanged 回调执行异常:', err)
      }
    }
  }

  private emitLifecycleInactive(nextGeneration: number): void {
    for (const cb of this.lifecycleInactiveCallbacks) {
      try {
        cb(nextGeneration)
      } catch (err) {
        logger.warn(LogCategory.SYSTEM, '[OmniService] onLifecycleInactive 回调执行异常:', err)
      }
    }
  }

  /** 判断当前是否存在存活的托管子进程 */
  private hasLiveManagedProcess(): boolean {
    return Boolean(
      this.process &&
      this.process.exitCode === null &&
      this.process.signalCode === null &&
      !this.process.killed
    )
  }

  /** 判断当前复用态记录的外部 PID 是否仍存活 */
  private isAdoptedPidAlive(): boolean {
    if (this.process !== null) return false
    const pid = this.expectedIdentity?.pid
    return typeof pid === 'number' && pid > 0 && isPidAlive(pid)
  }

  /** 判断是否仍处于最近一次拉起后的启动宽限期内 */
  private isWithinStartupGrace(): boolean {
    return this.lastSpawnedAt > 0 && Date.now() - this.lastSpawnedAt < OmniService.STARTUP_GRACE_MS
  }

  /** 判断请求 URL 的 origin 是否严格等于当前已采纳的 baseUrl */
  private isRequestTargetCurrentBaseUrl(url: string | URL): boolean {
    try {
      const targetOrigin = new URL(typeof url === 'string' ? url : url.toString()).origin
      const currentOrigin = new URL(this.baseUrl).origin
      return targetOrigin === currentOrigin
    } catch {
      return false
    }
  }

  /** 复用态/已采纳身份立即自失效（ECONNREFUSED 或 X-Omni-Instance-Id 不匹配触发） */
  private invalidateAdoptedIdentity(reason: string): void {
    logger.warn(
      LogCategory.SYSTEM,
      `[OmniService] 检测到当前实例身份失效 (${reason})，立即清零采纳状态`
    )
    this.expectedIdentity = null
    this.cachedVersion = null
    this.connectedTarget = null
    this.lastVerifiedAtMs = 0
  }

  /** 统一记录托管进程不健康失败并在满足 60s 且无其他在途请求时触发单飞有序重启 */
  private recordManagedUnhealthyFailure(countSelfInflight: boolean): void {
    omniFetchHelperRecordManagedUnhealthyFailure(this, countSelfInflight)
  }

  /**
   * 托管进程持续不健康满 60s 后的单飞自愈恢复终态：
   * 强杀前必经一次新鲜的 `verifyOmniInstance(internal: true)` 失败确证，
   * 确证失败才经 `ctx.intentionalKill = true` 有序重启一次，防误杀与递归风暴。
   */
  public async restartUnhealthyManaged(): Promise<boolean> {
    return omniFetchHelperRestartUnhealthyManaged(this)
  }

  /**
   * 针对 Omni 本地进程的统一四级 HTTP 通道封装（注入 omniDispatcher）：
   * ① `probe`(默认3s) / `call`(默认15s) / `long`(调用方控制) / `stream`(不计 inflightCount)
   * ② 仅当请求目标等于当前已采纳 `baseUrl` 时，对 2xx 核验 `X-Omni-Instance-Id` 响应头（匹配刷新 TTL 并清零不健康计数；不匹配立即自失效）
   * ③ 仅对目标等于当前 `baseUrl` 的复用态 `ECONNREFUSED` 执行自失效
   * ④ 非 `internal` 的 `probe`/`call` 遇超时、`ECONNRESET` 或 5xx 且托管进程存活时累计不健康窗口，满 60s 且 `otherInflight === 0` 触发 `restartUnhealthyManaged()`
   */
  public async omniFetch(url: string | URL, init?: OmniFetchOptions): Promise<Response> {
    return omniFetchHelperOmniFetch(this, url, init)
  }

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
    return omniDmlResolveDmlCrashMarker(this, dbPath)
  }

  private readTextFileSafe(file: string): string | null {
    return omniDmlReadTextFileSafe(this, file)
  }

  /**
   * 持久化 DirectML 原生崩溃标记（滑动窗口两击计数），并在本进程内立即生效（后续 `start()` 直接走纯 CPU）。
   * 写入失败不阻断（仅告警）：跨进程兜底失效时，本次进程内重试仍会强制 CPU。
   */
  private persistDmlCrash(marker: string | null, exitCode = 0): void {
    omniDmlPersistDmlCrash(this, marker, exitCode)
  }

  /**
   * 拦截处理 Omni KeyEpoch 失配，触发前端大白话 UX 提示与系统通知 (Ticket 07)
   */
  private handleKeyEpochMismatch(detail: string): void {
    omniDmlHandleKeyEpochMismatch(this, detail)
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
    return omniDiscoveryResolveUserDataDir(this)
  }

  /** 惰性获取 `userData/run/omni-config.json` 发现文件管理器 */
  private getDiscoveryFile(): ServiceDiscoveryFile | null {
    return omniDiscoveryGetDiscoveryFile(this)
  }

  /** 挂载 `userData/run/omni-config.json` 单例 DirWatcher 监听 */
  private mountDiscoveryWatcher(): void {
    omniDiscoveryMountDiscoveryWatcher(this)
  }

  /** 卸载 `userData/run/omni-config.json` 目录监听 */
  private unmountDiscoveryWatcher(): void {
    omniDiscoveryUnmountDiscoveryWatcher(this)
  }

  /** 注册系统休眠唤醒（PowerEventHub resume）纯事件唤醒源 */
  private registerPowerResumeWakeup(): void {
    omniDiscoveryRegisterPowerResumeWakeup(this)
  }

  /** 单次重读 `userData/run/omni-config.json` 并按需触发 SSE 重连（供 resume / 焦点刷新等事件源使用） */
  public syncFromDiscoveryFileOnce(options?: { resetFailures?: boolean }): void {
    omniDiscoverySyncFromDiscoveryFileOnce(this, options)
  }

  /** 处理发现文件变更事件：严格按「校验同源 → 先更新端口与预期身份 → 后 kick」顺序执行 */
  private handleDiscoveryFileChanged(
    info: ServiceDiscoveryFileV1 | null,
    resetFailures = true
  ): void {
    omniDiscoveryHandleDiscoveryFileChanged(this, info, resetFailures)
  }

  /** 8 阶段双代际归属校验：彻底阻断旧连接延迟回调覆盖新连接状态 */
  private isCurrentOwner(myEpoch: number, myStopEpoch: number): boolean {
    return omniDiscoveryIsCurrentOwner(this, myEpoch, myStopEpoch)
  }

  /** 判断当前 SSE 连接是否针对当前目标健康在线 */
  private isCurrentTargetHealthy(expectedTarget?: ConnectedTargetIdentity): boolean {
    return omniDiscoveryIsCurrentTargetHealthy(this, expectedTarget)
  }

  /** 确保单循环 SSE 状态流已建立（幂等入口） */
  public ensureEventStream(): void {
    omniDiscoveryEnsureEventStream(this)
  }

  /** 事件驱动抢占重连（支持三元组身份比对与失败计数重置） */
  public kickEventStreamReconnect(options?: {
    expectedTarget?: ConnectedTargetIdentity
    resetFailures?: boolean
  }): void {
    omniDiscoveryKickEventStreamReconnect(this, options)
  }

  /** 单循环 SSE 状态驱动器（10s Connect + 35s Read 双阶看门狗 + DORMANT_MAX_ATTEMPTS=5 有界退避） */
  private async runStreamLoop(myEpoch: number, myStopEpoch: number): Promise<void> {
    return omniDiscoveryRunStreamLoop(this, myEpoch, myStopEpoch)
  }

  /** 执行单次 SSE 建连与流读取（严格落实 10s Connect + 35s Read 看门狗与锁释放顺序） */
  private async connectOnce(
    myEpoch: number,
    myStopEpoch: number
  ): Promise<'stopping' | 'eof' | 'failed'> {
    return omniDiscoveryConnectOnce(this, myEpoch, myStopEpoch)
  }

  /** 应用经同源校验的 SSE 状态帧：按 instanceId + revision 严格保序 */
  private applyStatusEvent(evt: OmniStatusEvent, targetBaseUrl: string): void {
    omniDiscoveryApplyStatusEvent(this, evt, targetBaseUrl)
  }

  /** 标记离线并向渲染进程广播（stop 期间抑制重复闪烁） */
  private applyOffline(): void {
    omniDiscoveryApplyOffline(this)
  }

  /**
   * 基于当前状态快照推送至渲染进程（omni:status-changed），不再主动发起周期轮询探活
   */
  private async pushStatus(): Promise<void> {
    return omniDiscoveryPushStatus(this)
  }

  /**
   * 获取 Omni 引擎版本号
   */
  public async getVersion(): Promise<string> {
    return omniStatusQueryGetVersion(this)
  }

  /**
   * 同步判定 Omni 服务是否已处于就绪运行态（纯同步布尔谓词，无异步阻塞开销）：
   * ① 托管活体（含 signalCode === null）
   * ② 采纳复用活体（instanceId 有效且 30s TTL 未过期；过期同步返回 false，由 ensureRunning 慢路径单飞刷新）
   */
  public isReady(): boolean {
    return omniStatusQueryIsReady(this)
  }

  /**
   * 检查 Omni 服务是否处于运行状态（isReady 的友好别名）
   */
  public isServiceRunning(): boolean {
    return omniStatusQueryIsServiceRunning(this)
  }

  /**
   * 同源校验指定端口上的 Omni 实例（显式单发、0 重试、默认 3000ms 超时）。
   * 注意：默认 `internal: true`，且仅当请求目标等于当前 `baseUrl` 时才受 `omniFetch` 同源校验；
   * 探测其他端口绝不污染当前已采纳的 `expectedIdentity`。
   */
  private async verifyOmniInstance(
    port: number,
    expectedPid?: number,
    options?: {
      timeoutMs?: number
      internal?: boolean
      userDataDir?: string | null
      masterDbPath?: string | null
      targetVectorsDir?: string | null
    }
  ): Promise<VerifyInstanceResult> {
    return omniDiscoveryVerifyOmniInstance(this, port, expectedPid, options)
  }

  /**
   * 复用态单飞同源刷新（30s TTL 过期时由 ensureRunning 慢路径调用，杜绝并发探活风暴与裸 /health 跨仓误采纳）
   */
  private async verifyAdoptedReuseOnce(): Promise<boolean> {
    return omniDiscoveryVerifyAdoptedReuseOnce(this)
  }

  /** 原子写入已验证通过的 Omni 实例身份与健康基线（供首次采纳、复用刷新、spawn 落定及 close 外部接管共享） */
  private applyAdoptedInstanceIdentity(params: {
    port: number
    pid?: number
    instanceId: string
    version?: string | null
  }): void {
    omniDiscoveryApplyAdoptedInstanceIdentity(this, params)
  }

  /** 解析采纳实例的 instanceId：优先响应体 instanceId/instance_id，其次响应头，仅均缺失时退化 port:startTimeMs */
  private resolveAdoptedInstanceId(
    data: Record<string, any> | undefined,
    headerInstanceId: string | null | undefined,
    targetPort: number,
    fallbackInstanceId?: string
  ): string {
    return omniDiscoveryResolveAdoptedInstanceId(
      this,
      data,
      headerInstanceId,
      targetPort,
      fallbackInstanceId
    )
  }

  /**
   * 确保 Omni 服务处于运行与就绪状态（停机早退 + O(1) 存活快路径 + 单飞同源刷新 + 按需拉起）
   */
  public async ensureRunning(): Promise<boolean> {
    return omniStatusQueryEnsureRunning(this)
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

  private async binarySignatureAsync(exePath: string): Promise<string | null> {
    const st = await statOrNull(exePath)
    return st ? `${st.mtimeMs}:${st.size}` : null
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
    omniProberStartDevBinaryWatch(this, intervalMs)
  }

  /** 停止开发态二进制热更新监听 */
  public stopDevBinaryWatch(): void {
    omniProberStopDevBinaryWatch(this)
  }

  /**
   * 比对当前二进制签名与本服务拉起时的签名；变化且稳定后自动重启 Omni 引擎。
   */
  private async checkBinaryUpdated(): Promise<void> {
    return omniProberCheckBinaryUpdated(this)
  }

  /**
   * 枚举 firefly-omni 可执行文件候选（按优先级排序，已存在的才返回）。
   *
   * 顺序语义：
   * 1. 生产/已部署环境以 ResourceLocator 解析的集成目录为首选（该目录同时携带 DirectML 等
   *    推理动态库，是完整运行时）；
   * 2. 其后是本地 cargo 编译产物，保证开发态即使集成目录被旧构件占位也能落到新构建。
   * 调用方（`resolveContractCompatibleExecutable`）会逐个做 CLI 契约预检后择优。
   */
  /**
   * 显式失效可执行文件探测缓存与契约缓存（二进制替换/删除后调用）
   */
  public invalidateExecutableProbeCache(): void {
    this.cachedExecutableCandidates = null
  }

  private buildOmniExecutableCandidatePaths(): string[] {
    return omniProberBuildOmniExecutableCandidatePaths(this)
  }

  private collectOmniExecutableCandidates(): string[] {
    return omniProberCollectOmniExecutableCandidates(this)
  }

  private async collectOmniExecutableCandidatesAsync(forceRefresh = false): Promise<string[]> {
    return omniProberCollectOmniExecutableCandidatesAsync(this, forceRefresh)
  }

  /**
   * 定位 firefly-omni 可执行文件（首个存在的候选，保持既有同步语义供热更新监听使用）。
   * 启动路径请改用 `resolveContractCompatibleExecutable`，避免被旧版构件占位。
   */
  public resolveOmniExecutable(): string | null {
    const candidates = this.collectOmniExecutableCandidates()
    return candidates.length > 0 ? candidates[0] : null
  }

  /**
   * 契约预检单个候选（按「路径 + mtime:size」缓存结论，二进制被覆盖后自动重探）。
   * 探针自身无法执行时不缓存，避免把瞬时失败固化。
   */
  private async probeCandidateServeContract(
    exePath: string
  ): Promise<{ result: Awaited<ReturnType<typeof probeServeContract>>; cached: boolean }> {
    return omniProberProbeCandidateServeContract(this, exePath)
  }

  /**
   * 选出第一个满足宿主 CLI 契约的二进制候选。
   *
   * 设计要点（2026-11-26 事故）：
   * - 集成目录被旧版 v0.1.8（仅支持 `-a/--addr`）占位时，旧实现会直接拉起 ⇒ clap 退出码 2
   *   ⇒ 盲目重启 10 次后静默放弃。这里改为「预检不通过就顺延到下一个候选」，
   *   既不再拿旧构件试错，也不会让旧构件遮蔽本地新构建；
   * - 全部候选都确定性不兼容 ⇒ 返回诊断文案，由调用方显式报错并冷却，绝不 spawn；
   * - 存在探针失败（无法判定）的候选且无兼容候选 ⇒ 放行首个可执行候选，仅显式记录原因，
   *   避免因杀软/权限导致的探针异常反向废掉本来可用的引擎。
   */
  private async resolveContractCompatibleExecutable(): Promise<{
    exePath: string | null
    contractMismatch: string | null
  }> {
    return omniProberResolveContractCompatibleExecutable(this)
  }

  /**
   * 启动并守护 firefly-omni 子进程（支持并发 Promise 合并）
   */

  private describeBinarySearch(): string {
    return omniProberDescribeBinarySearch(this)
  }

  private notifyBinaryMissing(): void {
    omniProberNotifyBinaryMissing(this)
  }

  public async start(): Promise<boolean> {
    if (this.isIntentionalStopping) {
      return false
    }
    if (this.hasLiveManagedProcess()) {
      if (await this.checkHealth()) {
        return true
      }
      if (this.isStarting && this.startPromise) {
        return this.startPromise
      }
    } else if (this.isReady() && (await this.checkHealth())) {
      return true
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

  /** 创建 per-launch 不可变代际上下文 */
  private createLaunchContext(
    generation: number,
    child: ChildProcess,
    spawnedWithDml: boolean
  ): LaunchContext {
    return omniLaunchHelperCreateLaunchContext(this, generation, child, spawnedWithDml)
  }

  /** 向 LaunchContext 缓冲追加 stderr 文本（保留无换行尾段 stderrPartial，限 32 行 / 8KB） */
  private appendLaunchStderr(ctx: LaunchContext, rawChunk: string): void {
    omniLaunchHelperAppendLaunchStderr(this, ctx, rawChunk)
  }

  /** 读取 LaunchContext 合并后的 stderr 尾段（包含无换行尾段 stderrPartial） */
  private getLaunchStderrTail(ctx: LaunchContext): string {
    return omniLaunchHelperGetLaunchStderrTail(this, ctx)
  }

  /** 等待上一代托管 LaunchContext 管道排空关闭（有界 2000ms，超时促发 stderr 排空） */
  private async awaitLaunchContextClose(ctx: LaunchContext | null): Promise<void> {
    return omniLaunchHelperAwaitLaunchContextClose(this, ctx)
  }

  private async doStart(): Promise<boolean> {
    return omniLauncherDoStart(this)
  }

  /**
   * 停止子进程
   */
  /**
   * 物理终止当前持有的 firefly-omni 子进程树（纯净终止，不污染 isStarting 状态机）
   */
  /**
   * 强制终结子进程树辅助方法：
   * 先标记对应 LaunchContext 的 intentionalKill = true，再委托 @firefly/shared::killProcessTree，
   * 仅终止成功后注销 processReaper（失败保留追踪并 warn）。
   */
  private forceKillProcessTree(child: ChildProcess | null, reason = 'force_kill'): void {
    omniLaunchHelperForceKillProcessTree(this, child, reason)
  }

  /**
   * 安全清理单轨挂载清单临时文件
   */
  private unlinkManifestSafe(manifestPath: string | null | undefined): void {
    omniLaunchHelperUnlinkManifestSafe(this, manifestPath)
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
    omniLifecycleStopImmediately(this)
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
    return omniLifecycleWaitForEnginePortReady(this, totalMs, intervalMs)
  }

  /**
   * 通知已运行的 Omni 实例热重载资产与单轨挂载清单（POST /api/v1/assets/reload）
   */
  public async reloadAssets(): Promise<boolean> {
    return omniLifecycleReloadAssets(this)
  }

  /**
   * 双向核验 /api/v1/engine/status 中的 mountManifest 与 visualVocab / mobileClipVocab
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
    visualVocabStatus?: string
    visualVocab?: VisualVocabStatusTelemetry
  }> {
    return omniLauncherVerifyMountManifestStatus(this, expected)
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
    visualVocabStatus?: string
    visualVocab?: VisualVocabStatusTelemetry
  }> {
    return omniLauncherVerifyMountManifestStatusAttempt(this, expected, attempt)
  }

  private sleepStatusVerifyBackoff(attempt: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, STATUS_VERIFY_BACKOFF_MS * attempt))
  }

  private visualTaggerAvailable = true
  private startupVisualReconcileInFlight = false

  public isVisualTaggerAvailable(): boolean {
    return this.visualTaggerAvailable
  }

  /**
   * 视觉槽启动三态非阻断处理（Spec v2.12 §3.3 / Ticket 08）：
   * - ok: 记录视觉可用并推进代际观测；
   * - stale: 保留进程不触发 stop()，异步调度一次本地优先对账（绝不连坐 /batch-embed-text）；
   * - missing / corrupt: 仅标记视觉不可用，绝不终止 Omni。
   */
  private getHostAppVersionSafe(): string | null {
    try {
      const { app } = require('electron')
      const ver = app?.getVersion?.()
      return typeof ver === 'string' && ver.trim() ? ver.trim() : null
    } catch {
      return null
    }
  }

  private notifyVisualTaggerRecovered(
    encoderId: number,
    expectedFingerprint?: string | null
  ): void {
    try {
      const {
        visualTaggerCoordinator
      } = require('../../analysis-queue-service/visual-tagger-coordinator')
      visualTaggerCoordinator?.markVisualTaggerHealthy?.(encoderId)
      const { databaseService } = require('../../database/database-service')
      const appVersion = this.getHostAppVersionSafe()
      const obs = databaseService?.observeTaggerHealthyOrFingerprintChangedTx?.(
        encoderId,
        expectedFingerprint ?? null,
        appVersion
      )
      if (obs?.bumped || obs?.appVersionChanged) {
        visualTaggerCoordinator?.resetBreakerForGeneration?.(obs.currentGeneration)
        visualTaggerCoordinator?.notifyRecoveryWake?.(encoderId, obs.currentGeneration, {
          includeNeedsAppUpdate: Boolean(obs.appVersionChanged || obs.previousGeneration === 0)
        })
      }
    } catch {
      // 单元测试未初始化 DB 时忽略
    }
  }

  public handleStartupVisualVocabStatus(verifyRes: {
    visualVocabStatus?: string
    visualVocab?: VisualVocabStatusTelemetry
    statusData?: Record<string, any>
  }): void {
    omniLifecycleHandleStartupVisualVocabStatus(this, verifyRes)
  }

  private async triggerStartupVisualReconcile(encoderId: number): Promise<void> {
    return omniLifecycleTriggerStartupVisualReconcile(this, encoderId)
  }

  /**
   * 独立视觉资产热重载入口（POST /api/v1/assets/reload），与 /api/v1/taxonomy/reload-policies 物理隔离
   */
  public async reloadVisualAssets(langOpt?: string): Promise<AssetsReloadResult> {
    return omniLauncherReloadVisualAssets(this, langOpt)
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
    return omniLauncherHandleTopologyChanged(this, opts)
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
    return omniLauncherStop(this)
  }

  /**
   * 等待当前服务端口彻底释放（避免旧进程尚未完全退出时被误判为已存在而假活）
   */
  public async waitForPortReleased(limitMs: number = 3000): Promise<boolean> {
    return omniRestartWaitForPortReleased(this, limitMs)
  }

  /**
   * 优雅热重启 Omni 服务（档位变更、插件拓扑变化或异常恢复）
   */
  public async restart(): Promise<boolean> {
    return omniRestartRestart(this)
  }

  /**
   * 指数退避自愈重启
   */
  private async scheduleRestart(): Promise<void> {
    return omniRestartScheduleRestart(this)
  }

  /**
   * 服务健康探活
   */
  public async checkHealth(options?: {
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<boolean> {
    return omniLifecycleCheckHealth(this, options)
  }

  /**
   * 向 Omni 引擎同步最新配置 (ENABLE_IMAGE_OCR, ENABLE_DOCUMENT_OCR, OCR_MODEL_SIZE 等)
   */
  public async syncConfigFromDesktop(): Promise<boolean> {
    return omniLifecycleSyncConfigFromDesktop(this)
  }

  /**
   * 卸载指定插槽的模型（释放 Windows 文件句柄）
   */
  public async unloadSlot(slot: string): Promise<boolean> {
    return omniLifecycleUnloadSlot(this, slot)
  }

  /**
   * 语言切换后通知 Omni 重载只读 SQLite 连接
   * POST /api/reconnect { dbPath } (ADR-0035 §8.4 双消费者热重连契约)
   */
  public async reconnect(dbPath: string): Promise<boolean> {
    return omniLifecycleReconnect(this, dbPath)
  }

  /**
   * 侧通道业务请求异常后的统一自愈判定入口（委托 mount-verify-classify::shouldTriggerRestartOnFetchError）
   */
  private shouldRestartAfterFetchError(
    error: unknown,
    signalAborted = false,
    httpStatus?: number | null
  ): boolean {
    if (this.isIntentionalStopping) {
      return false
    }
    return shouldTriggerRestartOnFetchError({
      error,
      signalAborted,
      httpStatus,
      processAlive: this.hasLiveManagedProcess() || this.isAdoptedPidAlive(),
      withinStartupGrace: this.isWithinStartupGrace()
    })
  }

  /**
   * 提取文件全量信息 (元数据, Magika, Markdown, EXIF, 音视频标签)
   */
  public async extract(
    filePath: string,
    options?: OmniExtractOptions
  ): Promise<OmniExtractionResponse | null> {
    return omniMediaExtract(this, filePath, options)
  }

  /**
   * 统一通过 Omni 引擎提取全量 ExifTool/媒体/文档元数据 (供属性面板与分析流水线使用)
   */
  public async extractMetadataFull(filePath: string): Promise<Record<string, any>> {
    return omniMediaExtractMetadataFull(this, filePath)
  }

  /**
   * GPS 经纬度逆地理编码: POST /api/geo/reverse (对接 omni-geo 微服务)
   */
  public async reverseGeo(
    pointsOrLat: OmniGeoReversePoint[] | number,
    lonOrLang?: number | string,
    optionalLang?: string
  ): Promise<OmniGeoReverseResponse | null> {
    return omniMediaReverseGeo(this, pointsOrLat, lonOrLang, optionalLang)
  }

  /**
   * 获取 Magika 分类信息 (与历史 Node.js Magika 返回格式 100% 对齐)
   */
  public async identifyMagika(filePath: string): Promise<MagikaFileCategory | null> {
    return omniMediaIdentifyMagika(this, filePath)
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
    return omniMediaGetFileCover(this, filePath, options)
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
    return omniMediaGetPdfCover(this, filePath)
  }

  /**
   * 原生多模态感知 (单点聚合: 元数据 + NTFS ADS + 频域水印/打码 + CLIP + SenseVoice ASR + 逆地理)
   * POST /api/perceive
   */
  public async perceive(
    filePath: string,
    options?: OmniPerceptionOptions
  ): Promise<OmniPerceptionResponse | null> {
    return omniMediaPerceive(this, filePath, options)
  }

  /**
   * 单指标：音频转文本 (SenseVoice ASR)
   * POST /api/audio/transcribe
   */
  public async transcribeAudio(
    filePath: string,
    options?: { language?: string; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<OmniAudioTranscribeResponse | null> {
    return omniMediaTranscribeAudio(this, filePath, options)
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
    return omniMediaConvertToStandardAudio(this, filePath, durationSeconds, timeoutMs)
  }

  /**
   * 统一解析 Omni 感知/视觉接口非 2xx 响应为强类型 `OmniPerceptionHttpError`
   */
  private async parsePerceptionHttpError(
    res: Response,
    endpointLabel: string,
    elapsedMs?: number
  ): Promise<OmniPerceptionHttpError> {
    return omniMediaParsePerceptionHttpError(this, res, endpointLabel, elapsedMs)
  }

  /**
   * 单指标：提取视觉标签 (CLIP 图像特征向量)
   * POST /api/vision/tags
   */
  public async extractVisualTags(
    filePath: string,
    options?: { language?: string; topK?: number; timeoutMs?: number }
  ): Promise<string[] | null> {
    return omniAiExtractVisualTags(this, filePath, options)
  }

  /**
   * 单指标：图像水印与打码频域检测
   * POST /api/vision/inspect
   */
  public async inspectVision(
    filePath: string,
    timeoutMs: number = 10000
  ): Promise<OmniVisionInspectResponse | null> {
    return omniAiInspectVision(this, filePath, timeoutMs)
  }

  /**
   * 单指标：文件系统 NTFS ADS 来源追踪 (Zone.Identifier)
   * POST /api/fs/ads
   */
  public async inspectAds(
    filePath: string,
    timeoutMs: number = 5000
  ): Promise<OmniFsAdsResponse | null> {
    return omniAiInspectAds(this, filePath, timeoutMs)
  }

  /**
   * 工业级混合检索：批量写入双轨索引 (USearch 密集向量 + Tantivy BM25)
   * POST /api/search/index
   */
  public async indexDocuments(
    documents: OmniIndexedDocument[],
    timeoutMs: number = 30000
  ): Promise<OmniIndexResponse | null> {
    return omniAiIndexDocuments(this, documents, timeoutMs)
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
    return omniAiSearchHybrid(this, options, timeoutMs)
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
    timeoutMs: number = 30000,
    skipEnsureRunning: boolean = false
  ): Promise<OmniClusterResponse | null> {
    return omniAiClusterDocuments(this, options, timeoutMs, skipEnsureRunning)
  }

  /**
   * OpenHowNet 语义描述查询与自然语言描述句合成 (支柱 3)
   * POST /api/hownet/describe
   */
  public async describeHowNet(
    word: string,
    timeoutMs: number = 5000
  ): Promise<OmniHowNetDescribeResult | null> {
    return omniAiDescribeHowNet(this, word, timeoutMs)
  }

  /**
   * 获取当前生效的嵌入模型档位 (classic_light | gemma_unified)
   */
  public async getEmbeddingProfile(): Promise<'classic_light' | 'gemma_unified'> {
    return omniAiGetEmbeddingProfile(this)
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
    return omniAiAnalyzeText(this, text, options, timeoutMs)
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
    return omniAiAssertNsfw(this, params, timeoutMs)
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
    return omniAiResolveTaxonomyParent(this, params, timeoutMs)
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
    return omniAiInspectControlledTags(this, items, language, timeoutMs)
  }

  /**
   * 解析当前激活的多模态嵌入画像档位与向量维度 (Spec §3.2.1)
   */
  public async resolveEmbeddingTarget(options?: {
    skipAutoStart?: boolean
  }): Promise<{ profile: 'classic_light' | 'gemma_unified'; dim: number }> {
    return omniAiResolveEmbeddingTarget(this, options)
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
    return omniAiBatchEmbedText(this, texts, options)
  }

  /**
   * 基础引擎真实推理探活冒烟自检协议 (Real Inference Smoke Test)
   * 先通过 /api/v1/engine/status 双向核验挂载清单，再直连 POST /api/v1/vector/batch-embed-text 执行真实张量嵌入
   */
  public async runSmokeTest(payload: {
    profile: 'classic_light' | 'gemma_unified'
    model_paths?: Record<string, string>
    test_tokens?: string[]
    timeoutMs?: number
  }): Promise<{ success: boolean; latency_ms?: number; error?: string; errorCode?: string }> {
    return omniAiRunSmokeTest(this, payload)
  }
}

export const omniService: OmniService = new Proxy({} as OmniService, {
  get(_target, prop) {
    const inst = OmniService.getInstance()
    const val = Reflect.get(inst as any, prop, inst)
    return typeof val === 'function' ? val.bind(inst) : val
  },
  set(_target, prop, value) {
    const inst = OmniService.getInstance()
    return Reflect.set(inst as any, prop, value, inst)
  },
  has(_target, prop) {
    return prop in OmniService.getInstance()
  },
  getPrototypeOf() {
    return Reflect.getPrototypeOf(OmniService.getInstance())
  },
  ownKeys() {
    return Reflect.ownKeys(OmniService.getInstance())
  },
  getOwnPropertyDescriptor(_target, prop) {
    const desc = Reflect.getOwnPropertyDescriptor(OmniService.getInstance(), prop)
    return desc ? { ...desc, configurable: true } : undefined
  },
  defineProperty(_target, prop, descriptor) {
    return Reflect.defineProperty(OmniService.getInstance(), prop, descriptor)
  },
  deleteProperty(_target, prop) {
    return Reflect.deleteProperty(OmniService.getInstance(), prop)
  }
})
