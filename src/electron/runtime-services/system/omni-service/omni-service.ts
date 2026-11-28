/**
 * Omni Native Service - Omni Rust 原生微服务管理器
 * （class 主体按职责块原样搬移；types/helpers 已抽至同目录子文件）
 */
import { ChildProcess, spawn } from 'node:child_process'
import * as crypto from 'node:crypto'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { app, BrowserWindow, dialog, powerMonitor, shell } from 'electron'
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
interface LaunchContext {
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

interface VerifyInstanceResult {
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
    if (!this.hasLiveManagedProcess() || this.isIntentionalStopping || this.isStarting) {
      return
    }
    const now = Date.now()
    if (
      this.lastFailureAt !== null &&
      now - this.lastFailureAt > OmniService.UNHEALTHY_FAILURE_GAP_RESET_MS
    ) {
      this.unhealthySince = now
    } else if (this.unhealthySince === null) {
      this.unhealthySince = now
    }
    this.lastFailureAt = now

    const otherInflight = Math.max(0, this.inflightCount - (countSelfInflight ? 1 : 0))
    if (
      now - this.unhealthySince >= OmniService.UNHEALTHY_RESTART_THRESHOLD_MS &&
      otherInflight === 0
    ) {
      void this.restartUnhealthyManaged()
    }
  }

  /**
   * 托管进程持续不健康满 60s 后的单飞自愈恢复终态：
   * 强杀前必经一次新鲜的 `verifyOmniInstance(internal: true)` 失败确证，
   * 确证失败才经 `ctx.intentionalKill = true` 有序重启一次，防误杀与递归风暴。
   */
  public async restartUnhealthyManaged(): Promise<boolean> {
    if (this.restartUnhealthyPromise) {
      return this.restartUnhealthyPromise
    }
    const task = (async () => {
      if (this.isIntentionalStopping || !this.hasLiveManagedProcess()) {
        return false
      }
      const verified = await this.verifyOmniInstance(this.actualPort, this.process?.pid, {
        timeoutMs: OmniService.PROBE_DEFAULT_TIMEOUT_MS,
        internal: true
      })
      if (verified.ok) {
        this.unhealthySince = null
        this.lastFailureAt = null
        this.lastVerifiedAtMs = Date.now()
        logger.info(
          LogCategory.SYSTEM,
          '[OmniService] 自愈重启前二次核验通过，托管进程已恢复响应，取消强杀'
        )
        return false
      }
      logger.warn(
        LogCategory.SYSTEM,
        '[OmniService] 托管进程持续不健康满 60s 且二次核验失败，触发单飞有序重启'
      )
      if (this.isIntentionalStopping || !this.hasLiveManagedProcess()) {
        return false
      }
      this.unhealthySince = null
      this.lastFailureAt = null
      if (this.currentLaunchCtx && this.currentLaunchCtx.child === this.process) {
        this.currentLaunchCtx.intentionalKill = true
      }
      return await this.restart()
    })()

    this.restartUnhealthyPromise = task
    try {
      return await task
    } finally {
      if (this.restartUnhealthyPromise === task) {
        this.restartUnhealthyPromise = null
      }
    }
  }

  /**
   * 针对 Omni 本地进程的统一四级 HTTP 通道封装（注入 omniDispatcher）：
   * ① `probe`(默认3s) / `call`(默认15s) / `long`(调用方控制) / `stream`(不计 inflightCount)
   * ② 仅当请求目标等于当前已采纳 `baseUrl` 时，对 2xx 核验 `X-Omni-Instance-Id` 响应头（匹配刷新 TTL 并清零不健康计数；不匹配立即自失效）
   * ③ 仅对目标等于当前 `baseUrl` 的复用态 `ECONNREFUSED` 执行自失效
   * ④ 非 `internal` 的 `probe`/`call` 遇超时、`ECONNRESET` 或 5xx 且托管进程存活时累计不健康窗口，满 60s 且 `otherInflight === 0` 触发 `restartUnhealthyManaged()`
   */
  public async omniFetch(url: string | URL, init?: OmniFetchOptions): Promise<Response> {
    const kind: OmniFetchKind = init?.kind ?? 'call'
    const internal = init?.internal === true
    const isRequestResponse = kind === 'call' || kind === 'long'
    const isCurrentBase = this.isRequestTargetCurrentBaseUrl(url)

    const {
      kind: _k,
      timeoutMs: explicitTimeoutMs,
      internal: _i,
      signal: callerSignal,
      ...restInit
    } = init ?? {}

    let effectiveSignal: AbortSignal | undefined = callerSignal ?? undefined
    const defaultTimeoutMs =
      kind === 'probe'
        ? OmniService.PROBE_DEFAULT_TIMEOUT_MS
        : kind === 'call'
          ? OmniService.CALL_DEFAULT_TIMEOUT_MS
          : undefined
    const resolvedTimeoutMs =
      typeof explicitTimeoutMs === 'number' && explicitTimeoutMs > 0
        ? explicitTimeoutMs
        : defaultTimeoutMs

    if (resolvedTimeoutMs !== undefined) {
      const timeoutSig = AbortSignal.timeout(resolvedTimeoutMs)
      if (effectiveSignal) {
        effectiveSignal =
          typeof (AbortSignal as any).any === 'function'
            ? (AbortSignal as any).any([effectiveSignal, timeoutSig])
            : effectiveSignal
      } else {
        effectiveSignal = timeoutSig
      }
    }

    if (isRequestResponse) {
      this.inflightCount++
    }

    try {
      const res = await fetch(url, {
        ...restInit,
        ...(effectiveSignal ? { signal: effectiveSignal } : {}),
        dispatcher: this.omniDispatcher
      } as RequestInit)

      if (isCurrentBase) {
        if (res.ok) {
          const headerInstanceId =
            res.headers?.get?.('x-omni-instance-id') ??
            res.headers?.get?.('X-Omni-Instance-Id') ??
            null
          if (headerInstanceId) {
            if (
              this.expectedIdentity?.instanceId &&
              this.expectedIdentity.instanceId !== headerInstanceId
            ) {
              this.invalidateAdoptedIdentity(
                `X-Omni-Instance-Id 不匹配: expected=${this.expectedIdentity.instanceId}, actual=${headerInstanceId}`
              )
            } else {
              this.lastVerifiedAtMs = Date.now()
              this.unhealthySince = null
              this.lastFailureAt = null
            }
          } else {
            // 旧版 Omni 缺失响应头时维持既有 30s TTL，仅首次告警
            if (this.expectedIdentity?.instanceId && !this.missingInstanceIdHeaderWarned) {
              this.missingInstanceIdHeaderWarned = true
              logger.warn(
                LogCategory.SYSTEM,
                '[OmniService] 收到缺少 X-Omni-Instance-Id 响应头的 2xx 响应（疑似旧版 Omni），维持 30s TTL 校验'
              )
            }
            this.unhealthySince = null
            this.lastFailureAt = null
          }
        } else if (res.status >= 500 && !internal && (kind === 'probe' || kind === 'call')) {
          this.recordManagedUnhealthyFailure(isRequestResponse)
        }
      }

      return res
    } catch (err: unknown) {
      if (isCurrentBase) {
        if (this.process === null && isConnectionRefusedError(err)) {
          this.invalidateAdoptedIdentity('ECONNREFUSED')
        }
        if (!internal && (kind === 'probe' || kind === 'call') && !callerSignal?.aborted) {
          const errName = (err as any)?.name
          const isTimeoutOrReset =
            errName === 'TimeoutError' ||
            errName === 'AbortError' ||
            isTransientStatusFetchError(err)
          if (isTimeoutOrReset) {
            this.recordManagedUnhealthyFailure(isRequestResponse)
          }
        }
      }
      throw err
    } finally {
      if (isRequestResponse) {
        this.inflightCount = Math.max(0, this.inflightCount - 1)
      }
    }
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
   * 持久化 DirectML 原生崩溃标记（滑动窗口两击计数），并在本进程内立即生效（后续 `start()` 直接走纯 CPU）。
   * 写入失败不阻断（仅告警）：跨进程兜底失效时，本次进程内重试仍会强制 CPU。
   */
  private persistDmlCrash(marker: string | null, exitCode = 0): void {
    this.forceCpuForNextStarts = true
    if (!marker) return
    try {
      const prevRaw = this.readTextFileSafe(marker)
      const nextMarker = computeNextDmlCrashMarker(prevRaw, Date.now(), exitCode)
      fs.writeFileSync(marker, serializeDmlCrashMarker(nextMarker), 'utf8')
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
    if (typeof expectedTarget.pid === 'number' && this.connectedTarget.pid !== expectedTarget.pid) {
      return false
    }
    if (
      expectedTarget.instanceId &&
      this.connectedTarget.instanceId !== expectedTarget.instanceId
    ) {
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
          const hasManagedChild = Boolean(
            this.process && !this.process.killed && this.process.exitCode === null
          )
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
      const res = await this.omniFetch(`${targetBaseUrl}/api/v1/omni/events`, {
        kind: 'stream',
        internal: true,
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
      const res = await this.omniFetch(`${this.baseUrl}/api/version`, {
        kind: 'probe',
        timeoutMs: 2000
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
   * 同步判定 Omni 服务是否已处于就绪运行态（纯同步布尔谓词，无异步阻塞开销）：
   * ① 托管活体（含 signalCode === null）
   * ② 采纳复用活体（instanceId 有效且 30s TTL 未过期；过期同步返回 false，由 ensureRunning 慢路径单飞刷新）
   */
  public isReady(): boolean {
    if (this.isStarting || this.isIntentionalStopping) {
      return false
    }
    const hasIdentityMark = this.cachedVersion !== null || this.connectedTarget !== null
    if (!hasIdentityMark) {
      return false
    }
    if (this.process !== null) {
      return (
        this.process.exitCode === null && this.process.signalCode === null && !this.process.killed
      )
    }
    return (
      typeof this.expectedIdentity?.instanceId === 'string' &&
      this.expectedIdentity.instanceId.length > 0 &&
      this.lastVerifiedAtMs > 0 &&
      Date.now() - this.lastVerifiedAtMs < OmniService.REUSE_READY_TTL_MS
    )
  }

  /**
   * 检查 Omni 服务是否处于运行状态（isReady 的友好别名）
   */
  public isServiceRunning(): boolean {
    return this.isReady()
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
    const timeoutMs = options?.timeoutMs ?? OmniService.PROBE_DEFAULT_TIMEOUT_MS
    const userDataDir =
      options?.userDataDir !== undefined ? options.userDataDir : this.resolveUserDataDir()
    const masterDbPath =
      options?.masterDbPath !== undefined ? options.masterDbPath : this.expectedMasterDbPath
    const targetVectorsDir =
      options?.targetVectorsDir !== undefined ? options.targetVectorsDir : this.expectedVectorsDir

    try {
      const lang = (this.getConfigValue<string>('DEFAULT_LANGUAGE') || '').trim()
      const qs = lang ? `?lang=${encodeURIComponent(lang)}` : ''
      const res = await this.omniFetch(`http://127.0.0.1:${port}/api/v1/engine/status${qs}`, {
        kind: 'probe',
        timeoutMs,
        internal: options?.internal ?? true
      })
      if (!res.ok) {
        return { ok: false, explicitNonTimeoutFailure: true }
      }
      const headerInstanceId =
        res.headers?.get?.('x-omni-instance-id') ?? res.headers?.get?.('X-Omni-Instance-Id') ?? null
      const data = (await res.json()) as Record<string, any>
      if (!data || data.status !== 'ok') {
        return { ok: false, explicitNonTimeoutFailure: true }
      }

      const originCheck = verifyOmniSameOrigin(
        {
          port: typeof data.port === 'number' ? data.port : port,
          pid: typeof data.pid === 'number' ? data.pid : undefined,
          userDataDir: typeof data.userDataDir === 'string' ? data.userDataDir : null,
          masterDbPath: typeof data.masterDbPath === 'string' ? data.masterDbPath : null,
          targetVectorsDir: typeof data.targetVectorsDir === 'string' ? data.targetVectorsDir : null
        },
        {
          expectedPort: port,
          expectedPid,
          userDataDir,
          masterDbPath: masterDbPath || null,
          targetVectorsDir
        }
      )
      if (!originCheck.ok) {
        logger.warn(
          LogCategory.SYSTEM,
          `[OmniService] 端口 ${port} 上的 Omni 实例同源校验未通过，拒绝盲目复用: ${originCheck.reason}`
        )
        return { ok: false, explicitNonTimeoutFailure: true }
      }
      if (originCheck.warning) {
        logger.warn(LogCategory.SYSTEM, `[OmniService] ${originCheck.warning}`)
      }
      return { ok: true, data, headerInstanceId }
    } catch (err: any) {
      const errName = typeof err?.name === 'string' ? err.name : ''
      const timedOut =
        errName === 'TimeoutError' ||
        errName === 'AbortError' ||
        /timeout|timed out|aborted/i.test(String(err?.message || ''))
      const portRefused = isConnectionRefusedError(err)
      return {
        ok: false,
        timedOut,
        portRefused,
        explicitNonTimeoutFailure: !timedOut
      }
    }
  }

  /**
   * 复用态单飞同源刷新（30s TTL 过期时由 ensureRunning 慢路径调用，杜绝并发探活风暴与裸 /health 跨仓误采纳）
   */
  private async verifyAdoptedReuseOnce(): Promise<boolean> {
    if (this.verifyPromise) {
      return this.verifyPromise
    }
    const targetPort = this.expectedIdentity?.port ?? this.actualPort
    const expectedPid = this.expectedIdentity?.pid
    const task = (async () => {
      const verified = await this.verifyOmniInstance(targetPort, expectedPid, {
        timeoutMs: OmniService.PROBE_DEFAULT_TIMEOUT_MS,
        internal: true
      })
      if (!verified.ok || this.isIntentionalStopping) {
        return false
      }
      const resolvedInstanceId = this.resolveAdoptedInstanceId(
        verified.data,
        verified.headerInstanceId,
        targetPort
      )
      if (
        this.expectedIdentity?.instanceId &&
        resolvedInstanceId !== this.expectedIdentity.instanceId
      ) {
        this.invalidateAdoptedIdentity(
          `复用刷新 instanceId 变更: expected=${this.expectedIdentity.instanceId}, actual=${resolvedInstanceId}`
        )
        return false
      }
      this.actualPort = targetPort
      this.baseUrl = `http://127.0.0.1:${targetPort}`
      this.expectedIdentity = {
        pid: typeof verified.data?.pid === 'number' ? verified.data.pid : expectedPid,
        instanceId: resolvedInstanceId,
        port: targetPort
      }
      if (typeof verified.data?.version === 'string' && verified.data.version) {
        this.cachedVersion = verified.data.version
      }
      this.connectedTarget = {
        baseUrl: this.baseUrl,
        pid: this.expectedIdentity.pid,
        instanceId: resolvedInstanceId
      }
      this.lastVerifiedAtMs = Date.now()
      this.unhealthySince = null
      this.lastFailureAt = null
      return true
    })()

    this.verifyPromise = task
    try {
      return await task
    } finally {
      if (this.verifyPromise === task) {
        this.verifyPromise = null
      }
    }
  }

  /** 原子写入已验证通过的 Omni 实例身份与健康基线（供首次采纳、复用刷新、spawn 落定及 close 外部接管共享） */
  private applyAdoptedInstanceIdentity(params: {
    port: number
    pid?: number
    instanceId: string
    version?: string | null
  }): void {
    this.actualPort = params.port
    this.baseUrl = `http://127.0.0.1:${params.port}`
    this.expectedIdentity = {
      pid: params.pid,
      instanceId: params.instanceId,
      port: params.port
    }
    if (params.version) {
      this.cachedVersion = params.version
    }
    this.connectedTarget = {
      baseUrl: this.baseUrl,
      pid: params.pid,
      instanceId: params.instanceId
    }
    this.lastVerifiedAtMs = Date.now()
    this.unhealthySince = null
    this.lastFailureAt = null
  }

  /** 解析采纳实例的 instanceId：优先响应体 instanceId/instance_id，其次响应头，仅均缺失时退化 port:startTimeMs */
  private resolveAdoptedInstanceId(
    data: Record<string, any> | undefined,
    headerInstanceId: string | null | undefined,
    targetPort: number,
    fallbackInstanceId?: string
  ): string {
    if (typeof data?.instanceId === 'string' && data.instanceId.length > 0) {
      return data.instanceId
    }
    if (typeof data?.instance_id === 'string' && data.instance_id.length > 0) {
      return data.instance_id
    }
    if (typeof headerInstanceId === 'string' && headerInstanceId.length > 0) {
      return headerInstanceId
    }
    if (typeof fallbackInstanceId === 'string' && fallbackInstanceId.length > 0) {
      return fallbackInstanceId
    }
    const startTimeMs =
      typeof data?.startTimeMs === 'number'
        ? data.startTimeMs
        : typeof data?.start_time_ms === 'number'
          ? data.start_time_ms
          : Date.now()
    return `${targetPort}:${startTimeMs}`
  }

  /**
   * 确保 Omni 服务处于运行与就绪状态（停机早退 + O(1) 存活快路径 + 单飞同源刷新 + 按需拉起）
   */
  public async ensureRunning(): Promise<boolean> {
    if (this.isIntentionalStopping) {
      return false
    }
    if (this.isReady()) {
      return true
    }
    if (this.startPromise) {
      return this.startPromise
    }
    if (this.hasLiveManagedProcess()) {
      if (await this.checkHealth()) {
        return true
      }
    } else if (this.expectedIdentity) {
      if (await this.verifyAdoptedReuseOnce()) {
        return true
      }
    }
    if (this.isIntentionalStopping) {
      return false
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
   * 枚举 firefly-omni 可执行文件候选（按优先级排序，已存在的才返回）。
   *
   * 顺序语义：
   * 1. 生产/已部署环境以 ResourceLocator 解析的集成目录为首选（该目录同时携带 DirectML 等
   *    推理动态库，是完整运行时）；
   * 2. 其后是本地 cargo 编译产物，保证开发态即使集成目录被旧构件占位也能落到新构建。
   * 调用方（`resolveContractCompatibleExecutable`）会逐个做 CLI 契约预检后择优。
   */
  private collectOmniExecutableCandidates(): string[] {
    const isWin = process.platform === 'win32'
    const exeName = isWin ? 'firefly-omni.exe' : 'firefly-omni'
    const isDev = isLocalDevRuntime()
    const root = process.cwd()
    const baseResDir = (() => {
      try {
        return ResourceLocator.getBaseResourceDir()
      } catch {
        return ''
      }
    })()
    const omniWorkspaceFromRes = baseResDir
      ? path.resolve(baseResDir, '..', '..', '..', 'omni')
      : ''
    const candidates: string[] = []
    const push = (candidate: string | null | undefined): void => {
      if (!candidate) return
      const resolved = path.resolve(candidate)
      if (candidates.includes(resolved)) return
      candidates.push(resolved)
    }

    // 1. 开发态优先级锁定 (Ticket 06): 本地 cargo target/{release,debug} 优先命中，防止被集成目录旧构建遮蔽
    if (isDev) {
      if (omniWorkspaceFromRes) {
        push(path.join(omniWorkspaceFromRes, 'target', 'release', exeName))
        push(path.join(omniWorkspaceFromRes, 'target', 'debug', exeName))
      }
      push(path.join(root, 'apps', 'omni', 'target', 'release', exeName))
      push(path.join(root, 'apps', 'omni', 'target', 'debug', exeName))
      push(path.join(root, '..', 'omni', 'target', 'release', exeName))
      push(path.join(root, '..', 'omni', 'target', 'debug', exeName))
    }

    // 2. 生产打包或部署态：通过 ResourceLocator 解析随包 bin/omni
    push(
      ResourceLocator.resolveBin('omni/firefly-omni') || ResourceLocator.resolveBin('firefly-omni')
    )

    // 3. 多候选路径兜底检索
    push(path.join(root, 'apps', 'desktop', 'build', 'extraResources', 'bin', 'omni', exeName))
    push(path.join(root, 'apps', 'desktop', 'build', 'extraResources', 'bin', exeName))
    push(path.join(root, 'apps', 'omni', 'target', 'release', exeName))
    push(path.join(root, 'apps', 'omni', 'target', 'debug', exeName))
    push(path.join(root, 'build', 'extraResources', 'bin', 'omni', exeName))

    return candidates.filter(candidate => fs.existsSync(candidate))
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
    const signature = this.binarySignature(exePath) ?? 'nostat'
    const cacheKey = `${exePath}|${signature}`
    const cached = this.serveContractCache.get(cacheKey)
    if (cached) {
      return { result: cached, cached: true }
    }
    const result = await probeServeContract(exePath, {
      timeoutMs: OmniService.BINARY_CONTRACT_PROBE_TIMEOUT_MS
    })
    // 探针无法执行（权限/杀软/受限环境）不具备确定性，不写入缓存，下次重新探测
    if (result.status !== 'probe_failed') {
      this.serveContractCache.set(cacheKey, result)
    }
    return { result, cached: false }
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
    const candidates = this.collectOmniExecutableCandidates()
    let firstMismatchDetail: string | null = null
    let undeterminedCandidate: string | null = null

    for (const candidate of candidates) {
      const { result, cached } = await this.probeCandidateServeContract(candidate)
      if (result.status === 'compatible') {
        this.incompatibleBinaryReported = false
        this.incompatibleBinaryRetryAt = 0
        this.lastMountValidationError = null
        return { exePath: candidate, contractMismatch: null }
      }
      if (result.status === 'incompatible') {
        if (!firstMismatchDetail) {
          firstMismatchDetail = buildServeContractMismatchDetail({
            exePath: candidate,
            missingOptions: result.missingOptions,
            helpText: result.helpText
          })
        }
        logger.warn(
          LogCategory.SYSTEM,
          `[OmniService] 跳过 CLI 契约不兼容的引擎构件（缺失 ${result.missingOptions.join('、')}）: ${candidate}${cached ? '（缓存结论）' : ''}`
        )
        continue
      }
      // probe_failed：显式上报原因（严禁静默吞没），保留为首个可执行候选
      logger.warn(
        LogCategory.SYSTEM,
        `[OmniService] 引擎构件 CLI 契约探针无法执行，本次先放行由拉起试错: ${candidate}，原因: ${result.probeError}`
      )
      if (!undeterminedCandidate) {
        undeterminedCandidate = candidate
      }
    }

    if (firstMismatchDetail) {
      return { exePath: null, contractMismatch: firstMismatchDetail }
    }
    if (undeterminedCandidate) {
      return { exePath: undeterminedCandidate, contractMismatch: null }
    }
    return { exePath: null, contractMismatch: null }
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
    let resolveClose!: () => void
    const closeDeferred = new Promise<void>(resolve => {
      resolveClose = resolve
    })
    return {
      generation,
      child,
      pid: child.pid,
      spawnedWithDml,
      stderrLines: [],
      stderrPartial: '',
      stderrBytes: 0,
      intentionalKill: false,
      closed: false,
      closeDeferred,
      resolveClose
    }
  }

  /** 向 LaunchContext 缓冲追加 stderr 文本（保留无换行尾段 stderrPartial，限 32 行 / 8KB） */
  private appendLaunchStderr(ctx: LaunchContext, rawChunk: string): void {
    if (!rawChunk) return
    const combined = ctx.stderrPartial + rawChunk
    const parts = combined.split(/\r?\n/)
    ctx.stderrPartial = parts.pop() ?? ''
    for (const line of parts) {
      ctx.stderrLines.push(line)
      ctx.stderrBytes += Buffer.byteLength(line, 'utf8') + 1
    }
    while (
      ctx.stderrLines.length > OmniService.STDERR_MAX_LINES ||
      ctx.stderrBytes > OmniService.STDERR_MAX_BYTES
    ) {
      const removed = ctx.stderrLines.shift()
      if (removed === undefined) break
      ctx.stderrBytes = Math.max(0, ctx.stderrBytes - (Buffer.byteLength(removed, 'utf8') + 1))
    }
    // 防止单行无换行超长残段撑爆内存
    if (Buffer.byteLength(ctx.stderrPartial, 'utf8') > OmniService.STDERR_MAX_BYTES) {
      ctx.stderrPartial = ctx.stderrPartial.slice(-2048)
    }
  }

  /** 读取 LaunchContext 合并后的 stderr 尾段（包含无换行尾段 stderrPartial） */
  private getLaunchStderrTail(ctx: LaunchContext): string {
    const lines = ctx.stderrPartial ? [...ctx.stderrLines, ctx.stderrPartial] : [...ctx.stderrLines]
    return lines.join('\n')
  }

  /** 等待上一代托管 LaunchContext 管道排空关闭（有界 2000ms，超时促发 stderr 排空） */
  private async awaitLaunchContextClose(ctx: LaunchContext | null): Promise<void> {
    if (!ctx || ctx.closed) return
    let timedOut = false
    await Promise.race([
      ctx.closeDeferred,
      new Promise<void>(resolve => {
        setTimeout(() => {
          timedOut = true
          resolve()
        }, 2000)
      })
    ])
    if (timedOut && !ctx.closed) {
      try {
        ctx.child.stderr?.destroy()
      } catch {}
    }
  }

  private async doStart(): Promise<boolean> {
    if (this.isIntentionalStopping) {
      return false
    }
    if (this.stopPromise) {
      await this.stopPromise.catch(() => {})
    }
    if (this.isIntentionalStopping) {
      return false
    }
    // 若存在上一代已退出或被强杀但 stderr 尚未排空的托管 LaunchContext，先等待其 closeDeferred（最多 2000ms）
    // 确保崩溃归因与 .omni-dml-crash.json 落盘完成后再决定本次是否需要 OMNI_DISABLE_DML=1
    const prevCtx = this.currentLaunchCtx
    if (
      prevCtx &&
      !prevCtx.closed &&
      (prevCtx.child.exitCode !== null ||
        prevCtx.child.signalCode !== null ||
        prevCtx.intentionalKill)
    ) {
      await this.awaitLaunchContextClose(prevCtx)
    }

    if (this.stopController.signal.aborted) {
      this.stopController = new AbortController()
    }
    this.mountDiscoveryWatcher()
    this.consecutiveFailures = 0
    this.lastAppliedRevision = 0
    this.lastAppliedInstanceId = null
    this.managedLifecycleActive = true
    this.isStarting = true
    this.lastMountValidationError = null

    try {
      // 缺失冷却检查：避免每个文件都触发一次 resolveOmniExecutable 的遍历
      if (this.missingBinaryRetryAt > Date.now()) {
        logger.debug(
          LogCategory.SYSTEM,
          '[OmniService] firefly-omni 二进制仍处于缺失冷却期，跳过本次拉起'
        )
        return false
      }
      // 契约不兼容冷却检查：旧版/错版构件已被确定性拒绝，冷却期内不再重复探测与拉起
      if (this.incompatibleBinaryRetryAt > Date.now()) {
        logger.debug(
          LogCategory.SYSTEM,
          '[OmniService] firefly-omni 构件 CLI 契约不兼容冷却中，跳过本次拉起'
        )
        return false
      }

      // 契约预检后再拉起：旧版二进制（仅 `-a/--addr`）在 clap 解析阶段即以退出码 2 自杀，
      // 盲目 spawn 只会把确定性失败伪装成崩溃并耗尽重试次数（2026-11-26 事故形态）。
      const resolution = await this.resolveContractCompatibleExecutable()
      const exePath = resolution.exePath
      if (!exePath && resolution.contractMismatch) {
        this.incompatibleBinaryRetryAt = Date.now() + OmniService.BINARY_CONTRACT_RETRY_MS
        this.lastMountValidationError = resolution.contractMismatch
        if (!this.incompatibleBinaryReported) {
          this.incompatibleBinaryReported = true
          logger.error(
            LogCategory.SYSTEM,
            `[OmniService] ❌ 检索式引擎组件版本过旧，已阻止拉起（未做无效重启）。\n${resolution.contractMismatch}`
          )
        } else {
          logger.debug(
            LogCategory.SYSTEM,
            '[OmniService] 引擎组件 CLI 契约仍不兼容，冷却期内跳过拉起'
          )
        }
        return false
      }
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
        return false
      }
      // 二进制重新出现（如用户修复安装 / 从杀软隔离区恢复）后复位上报与冷却状态
      this.missingBinaryReported = false
      this.missingBinaryRetryAt = 0
      this.binaryMissingNotified = false
      this.binaryMissingNotifyDeferred = false

      // 获取业务主库 SQLite 绝对路径，用于 Worktree 隔离校验 (ADR-0035 & ADR-0038)
      const { databaseService } = await import('../../database/database-service')
      const dbPath = databaseService.getDbPath()
      const expectedVectorsDir = dbPath ? path.join(path.dirname(dbPath), 'vectors') : null
      const userDataDir = this.resolveUserDataDir()
      this.expectedMasterDbPath = dbPath || null
      this.expectedVectorsDir = expectedVectorsDir

      const verifyOpts = {
        timeoutMs: OmniService.PROBE_DEFAULT_TIMEOUT_MS,
        internal: true,
        userDataDir,
        masterDbPath: dbPath || null,
        targetVectorsDir: expectedVectorsDir
      }

      const completeAdoption = async (
        targetPort: number,
        verifiedData: Record<string, any> | undefined,
        headerInstanceId: string | null | undefined,
        opts: {
          isReuseAdoption: boolean
          matchedFromDiscovery: boolean
          discovered: ServiceDiscoveryFileV1 | null
          df: ServiceDiscoveryFile | null
        }
      ): Promise<boolean> => {
        const prevInstanceId =
          this.expectedIdentity?.instanceId ?? this.connectedTarget?.instanceId ?? null
        const adoptedPid =
          typeof verifiedData?.pid === 'number'
            ? verifiedData.pid
            : opts.isReuseAdoption
              ? opts.discovered?.pid
              : this.process?.pid
        const adoptedInstanceId = this.resolveAdoptedInstanceId(
          verifiedData,
          headerInstanceId,
          targetPort,
          opts.discovered?.instanceId
        )
        const isSameExternalInstance =
          opts.isReuseAdoption && Boolean(prevInstanceId && prevInstanceId === adoptedInstanceId)
        const version =
          typeof verifiedData?.version === 'string' && verifiedData.version
            ? verifiedData.version
            : null
        this.applyAdoptedInstanceIdentity({
          port: targetPort,
          pid: adoptedPid,
          instanceId: adoptedInstanceId,
          version
        })

        // 仅当发现文件缺失且通过验证采纳外部未写盘实例时回填发现文件
        if (
          !opts.matchedFromDiscovery &&
          opts.df &&
          !opts.discovered &&
          adoptedPid &&
          adoptedInstanceId
        ) {
          void opts.df
            .publish({
              instanceId: adoptedInstanceId,
              revision: typeof verifiedData?.revision === 'number' ? verifiedData.revision : 1,
              host: '127.0.0.1',
              port: targetPort,
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
          `[OmniService] 成功匹配并复用当前 Worktree 专属 Omni 服务 (Port: ${targetPort}, ${this.baseUrl})，接入 SSE 状态流`
        )
        this.restartAttempts = 0
        this.spawnedBinarySignature = this.binarySignature(exePath)
        if (!isSameExternalInstance) {
          this.lastSpawnedAt = Date.now()
        }
        this.pendingUpdateSignature = null
        this.pendingUpdateSince = 0
        this.startDevBinaryWatch()
        this.syncConfigFromDesktop().catch(() => {})
        // 复用已运行实例三步串行启动链（Ticket 06）：① .txn.json 恢复 ➔ ② reloadAssets ➔ ③ 非阻断状态核验
        try {
          const { modularResourceService } = await import('../modular-resource-service')
          const rootDir = modularResourceService?.getPluginsRootDir?.() || ''
          if (rootDir) {
            const { recoverSharedVisualVocabTxns } = await import('../file-download-service')
            recoverSharedVisualVocabTxns(PluginPathResolver.getSharedDirForRoot(rootDir))
          }
        } catch {}
        await this.reloadAssets().catch(() => false)
        const reuseVerify = await this.verifyMountManifestStatus().catch(() => null)
        if (reuseVerify && !reuseVerify.ok) {
          this.lastMountValidationError = reuseVerify.error || '挂载清单核验处于降级态'
          logger.warn(
            LogCategory.SYSTEM,
            `[OmniService] 复用实例挂载核验降级（非阻断）: ${this.lastMountValidationError}`
          )
        }
        this.kickEventStreamReconnect({
          expectedTarget: {
            baseUrl: this.baseUrl,
            pid: adoptedPid,
            instanceId: adoptedInstanceId
          },
          resetFailures: true
        })
        if (opts.isReuseAdoption && !isSameExternalInstance) {
          const nextGen = ++this.currentGeneration
          this.emitInstanceChanged(nextGen)
        }
        if (verifiedData?.visualVocab) {
          this.handleStartupVisualVocabStatus({ statusData: verifiedData })
        }
        this.notifyReady()
        return true
      }

      // 优先读取 userData/run/omni-config.json 零扫描复用（通过 PID 存活 + 同源校验）
      let matchedPort: number | null = null
      let matchedData: Record<string, any> | undefined
      let matchedHeaderInstanceId: string | null | undefined
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
          const verified = await this.verifyOmniInstance(
            discovered.port,
            discovered.pid,
            verifyOpts
          )
          if (verified.ok) {
            matchedPort = discovered.port
            matchedData = verified.data
            matchedHeaderInstanceId = verified.headerInstanceId
            matchedFromDiscovery = true
          }
        } else {
          logger.warn(
            LogCategory.SYSTEM,
            `[OmniService] 发现文件同源校验未通过，忽略并跳过复用: ${dfOrigin.reason}`
          )
        }
      }

      // 仅当发现文件未命中时，对 38200..=38219 执行并发单发 3000ms（0 重试）探测（彻底弃用同步端口快照）
      const scanResultByPort = new Map<number, VerifyInstanceResult>()
      if (matchedPort === null) {
        const ports = Array.from(
          { length: APP_PORTS.MAX_ATTEMPTS },
          (_, idx) => this.basePort + idx
        )
        const settled = await Promise.allSettled(
          ports.map(async p => ({
            port: p,
            result: await this.verifyOmniInstance(p, undefined, verifyOpts)
          }))
        )
        for (const item of settled) {
          if (item.status === 'fulfilled') {
            scanResultByPort.set(item.value.port, item.value.result)
            if (matchedPort === null && item.value.result.ok) {
              matchedPort = item.value.port
              matchedData = item.value.result.data
              matchedHeaderInstanceId = item.value.result.headerInstanceId
            }
          }
        }
      }

      if (matchedPort !== null) {
        return completeAdoption(matchedPort, matchedData, matchedHeaderInstanceId, {
          isReuseAdoption: !this.hasLiveManagedProcess(),
          matchedFromDiscovery,
          discovered,
          df
        })
      }

      // —— Anti-Fratricide / PreserveAlive 严格决策闸 ——
      // 严禁 `??` 混选 PID：托管态仅取 this.process.pid，复用态仅取 this.expectedIdentity.pid
      const hasLiveChild = this.hasLiveManagedProcess()
      const probePid = hasLiveChild ? this.process?.pid : this.expectedIdentity?.pid
      const pidAlive = typeof probePid === 'number' && probePid > 0 ? isPidAlive(probePid) : false
      const withinStartupGrace = this.isWithinStartupGrace()
      const targetPort = hasLiveChild
        ? this.actualPort
        : (this.expectedIdentity?.port ?? this.actualPort)
      const prevScan = scanResultByPort.get(targetPort)
      const verifyTimedOut = prevScan?.timedOut === true
      const portRefused = prevScan?.portRefused === true
      const explicitNonTimeoutFailure = prevScan?.explicitNonTimeoutFailure === true

      if (hasLiveChild || pidAlive) {
        const allowForceKill = shouldForceKillBeforeRespawn({
          hasLiveChild,
          pidAlive,
          verifyTimedOut,
          portRefused,
          withinStartupGrace
        })

        if (!allowForceKill) {
          // 1) 启动宽限期内：改为有界轮询等待至宽限期结束
          let reprobed: VerifyInstanceResult | null = null
          if (withinStartupGrace) {
            const graceDeadline = this.lastSpawnedAt + OmniService.STARTUP_GRACE_MS
            while (Date.now() < graceDeadline && !this.isIntentionalStopping) {
              if (hasLiveChild && !this.hasLiveManagedProcess()) {
                break
              }
              const attempt = await this.verifyOmniInstance(targetPort, probePid, verifyOpts)
              if (attempt.ok) {
                reprobed = attempt
                break
              }
              await new Promise(r => setTimeout(r, 300))
            }
          } else if (!explicitNonTimeoutFailure) {
            // 2) 非宽限期且未明确非超时失败：单发复探一次
            reprobed = await this.verifyOmniInstance(targetPort, probePid, verifyOpts)
          }

          if (reprobed?.ok) {
            return completeAdoption(targetPort, reprobed.data, reprobed.headerInstanceId, {
              isReuseAdoption: !hasLiveChild,
              matchedFromDiscovery: false,
              discovered,
              df
            })
          }

          // 3) 核验仍失败：严格区分存活托管子进程（PreserveFailClosed + 60s 恢复终态）与外部陈旧 PID
          if (hasLiveChild && pidAlive) {
            this.recordManagedUnhealthyFailure(false)
            logger.warn(
              LogCategory.SYSTEM,
              `[OmniService] PreserveFailClosed: 托管子进程仍存活 (PID=${probePid}, port=${targetPort}) 但状态核验未通，禁止双开 spawn`
            )
            return false
          }

          // 外部陈旧 PID 无法同源核验：视为陈旧缓存跳过并走新端口 spawn（绝不 taskkill，亦绝不永久拒服）
          logger.warn(
            LogCategory.SYSTEM,
            `[OmniService] 外部复用缓存 PID=${probePid} 无法通过同源核验，清除陈旧身份并在新端口拉起托管实例`
          )
          this.expectedIdentity = null
          this.connectedTarget = null
          this.cachedVersion = null
          this.lastVerifiedAtMs = 0
        } else if (this.process && !this.process.killed) {
          // GuardedKill：若子进程物理上已失活或已退出（如原生崩溃尚未投递 close），
          // 严禁调用 forceKillProcessTree 误置 intentionalKill = true 掩盖真实 OOM/DML 崩溃；
          // 仅对确认存活且无退出码的子进程执行强杀，已死子进程仅等待 close 管道排空归因。
          const killCtx = this.currentLaunchCtx
          const processAlreadyDead =
            !pidAlive || this.process.exitCode !== null || this.process.signalCode !== null
          if (!processAlreadyDead) {
            this.forceKillProcessTree(this.process, 'doStart_guarded_kill')
          }
          await this.awaitLaunchContextClose(killCtx)
        }
      }

      if (this.isIntentionalStopping) {
        return false
      }

      // 寻找可用端口作为建议基准（Rust 侧 bind-first 仍支持 38200..=38219 原子滑动）
      const port = await findAvailablePort(this.basePort, APP_PORTS.MAX_ATTEMPTS)
      this.actualPort = port
      this.baseUrl = `http://127.0.0.1:${port}`
      this.cachedVersion = null
      this.connectedTarget = null
      this.lastVerifiedAtMs = 0

      logger.info(
        LogCategory.SYSTEM,
        `[OmniService] 正在拉起 firefly-omni 守护进程 (Port: ${port}): ${exePath}`
      )
      const isDevMode = isLocalDevRuntime()
      const binDir = path.dirname(exePath)
      const staticResourcesRoot = ResourceLocator.getBaseResourceDir()
      const deployedOnnxDir = path.join(staticResourcesRoot, 'bin', 'omni')
      const runtimeDllDir = fs.existsSync(deployedOnnxDir) ? deployedOnnxDir : binDir
      const existingPath = process.env.PATH || ''
      const injectedPath = [runtimeDllDir, binDir, existingPath]
        .filter(Boolean)
        .join(path.delimiter)

      const isWin = process.platform === 'win32'
      const existingLibPath = process.env.LD_LIBRARY_PATH || ''
      const injectedLibPath = [runtimeDllDir, binDir, existingLibPath]
        .filter(Boolean)
        .join(path.delimiter)

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

      // 净化子进程环境变量：彻底收口 18 个散落环境变量与旧 CLI 参数，改由 omni-bootstrap.json 统一下发
      const env: Record<string, string | undefined> = {
        ...process.env,
        PATH: injectedPath,
        ...(isWin ? {} : { LD_LIBRARY_PATH: injectedLibPath }),
        FIREFLY_OMNI_TOKEN: tokenPayload.token,
        RUST_LOG:
          process.env.RUST_LOG ||
          (isDevMode ? 'info,omni_vision=info,omni_server=info,omni_text=info' : 'warn')
      }
      for (const purgeKey of CHILD_MODEL_ENV_KEYS_TO_PURGE) {
        delete env[purgeKey]
      }
      for (const obsoleteKey of [
        'FIREFLY_ACTIVE_MODEL_MOUNTS_FILE',
        'FIREFLY_STRICT_ACTIVE_PLUGINS',
        'FIREFLY_SHARED_DIR',
        'OMNI_PPOCR_MODEL_PATH',
        'OMNI_PORT',
        'OMNI_DEV_MODE',
        'OMNI_DB_PATH',
        'OMNI_VECTORS_PATH',
        'OMNI_GEO_DATA_PATH',
        'FIREFLY_ONNX_DIR',
        'FIREFLY_RUN_DIR',
        'FIREFLY_USER_DATA_DIR',
        'OMNI_WATCH_STDIN',
        'OMNI_DISABLE_DML',
        'OMNI_TTS_EAGER_WARMUP'
      ]) {
        delete env[obsoleteKey]
      }

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
            const diskReady = !meta.visualVocabMeta ? readReadyMarkerSync(item.physicalDir) : null
            let effectiveVisualVocabMeta = meta.visualVocabMeta
            if (
              !effectiveVisualVocabMeta &&
              diskReady?.visualVocab?.matrixSha256 &&
              diskReady?.visualVocab?.metaSha256
            ) {
              const diskMetaPath = path.join(item.physicalDir, 'vocab_v.meta.json')
              if (fs.existsSync(diskMetaPath)) {
                try {
                  const parsedMeta = JSON.parse(fs.readFileSync(diskMetaPath, 'utf-8')) as Record<
                    string,
                    any
                  >
                  const digest =
                    typeof parsedMeta.encoder_digest === 'string'
                      ? parsedMeta.encoder_digest.trim()
                      : ''
                  const entryCount = Array.isArray(parsedMeta.entries)
                    ? parsedMeta.entries.length
                    : typeof parsedMeta.entry_count === 'number'
                      ? parsedMeta.entry_count
                      : 0
                  if (digest.length >= 16 && entryCount > 0) {
                    effectiveVisualVocabMeta = {
                      matrixFileName: 'vocab_v.f16',
                      metaFileName: 'vocab_v.meta.json',
                      version: diskReady.visualVocab.pluginVersion || parsedMeta.version || '2.0.0',
                      schemaVersion: 2 as const,
                      bakeRevision:
                        diskReady.visualVocab.bakeRevision ?? parsedMeta.bake_revision ?? 1,
                      encoderDigestPrefix: digest.slice(0, 16),
                      matrixSha256: diskReady.visualVocab.matrixSha256,
                      metaSha256: diskReady.visualVocab.metaSha256,
                      entryCount,
                      embedDim: 512 as const
                    }
                  }
                } catch {
                  // 忽略畸形 vocab_v.meta.json，交由后续运行时对账处理
                }
              }
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
              ...(meta.vocabMeta ? { vocabMeta: { ...meta.vocabMeta } } : {}),
              ...(effectiveVisualVocabMeta
                ? { visualVocabMeta: { ...effectiveVisualVocabMeta } }
                : {})
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

      if (sharedDir) {
        const { recoverSharedVisualVocabTxns } = await import('../file-download-service')
        recoverSharedVisualVocabTxns(sharedDir)
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
        this.currentMountManifestPath = manifestAbsPath
        logger.debug(
          LogCategory.SYSTEM,
          `[OmniService] 📦 生成单轨挂载清单 (${expectedMountResourceIds.length} 项): ${expectedMountResourceIds.join(', ') || 'none'}`
        )
      } catch (manifestWriteErr) {
        logger.error(
          LogCategory.SYSTEM,
          '[OmniService] 写入单轨挂载清单失败，强制启用 strict 保护模式:',
          manifestWriteErr
        )
      }

      const expectedMountsSnapshot = {
        manifestPath: mountManifestPath,
        sharedDir: sharedDir || null,
        expectedResourceIds: [...expectedMountResourceIds],
        strict: true
      }
      this.lastExpectedMounts = expectedMountsSnapshot

      // 提取当前激活的多模态嵌入画像档位与 MRL 维度
      let embeddingProfile: 'classic_light' | 'gemma_unified' = 'classic_light'
      let mrlDimension = 512
      try {
        const { ConfigOrchestrator } = await import('../../../config/config-orchestrator')
        const configOrch = ConfigOrchestrator?.getInstance?.()
        if (configOrch) {
          embeddingProfile =
            configOrch.getValue<'classic_light' | 'gemma_unified'>('AI_EMBEDDING_PROFILE') ||
            'classic_light'
          mrlDimension = configOrch.getValue<number>('EMBEDDING_MRL_DIMENSION') || 512
        }
      } catch {}

      // DirectML 原生崩溃守卫
      this.resolveDmlCrashMarker(dbPath)
      const dmlMarkerRaw = this.dmlCrashMarkerPath
        ? this.readTextFileSafe(this.dmlCrashMarkerPath)
        : null
      const shouldDisableDml = Boolean(
        this.forceCpuForNextStarts || shouldForceCpuFromMarker(dmlMarkerRaw, Date.now())
      )
      if (shouldDisableDml) {
        logger.warn(
          LogCategory.SYSTEM,
          '[OmniService] 检测到 DirectML 原生崩溃历史，本次在 bootstrap 中置位 disableDirectMl=true'
        )
      }

      // 写入唯一跨进程启动引导信封 runDir/omni-bootstrap.json 并通过 `--bootstrap <file>` 启动
      fs.mkdirSync(runDir, { recursive: true })
      const bootstrapPath = path.join(runDir, 'omni-bootstrap.json')
      const tmpBootstrapPath = `${bootstrapPath}.tmp`
      const resolvedVectorsDir = dbPath
        ? expectedVectorsDir || path.join(path.dirname(dbPath), 'vectors')
        : null
      const bootstrapConfig = {
        schemaVersion: 1,
        listenAddr: `127.0.0.1:${port}`,
        authTokenFile: null,
        staticResourcesRoot,
        storage: {
          dbPath: dbPath || null,
          vectorsDir: resolvedVectorsDir,
          runDir,
          userDataDir: userDataDir || null
        },
        runtime: {
          embeddingProfile,
          mrlDimension,
          disableDirectMl: shouldDisableDml,
          watchStdin: true,
          devMode: isDevMode,
          eagerTtsWarmup: false
        },
        pluginMountsFile: mountManifestPath
      }
      fs.writeFileSync(tmpBootstrapPath, JSON.stringify(bootstrapConfig, null, 2), 'utf-8')
      fs.renameSync(tmpBootstrapPath, bootstrapPath)
      const spawnArgs = ['serve', '--bootstrap', bootstrapPath]
      logger.debug(
        LogCategory.SYSTEM,
        `[OmniService] ✉️ 已原子写入引导配置并启用单接缝启动 (--bootstrap): ${bootstrapPath} (staticResourcesRoot=${staticResourcesRoot})`
      )

      // 托管 spawn 前预留严格递增代际号并冻结独立 LaunchContext（启动期崩溃仍精准归因当前代）
      const launchGeneration = ++this.currentGeneration
      const spawnedWithDml = !shouldDisableDml

      // J-06 / B5：spawn 前必须等待 reaperDone 门闸落地，并复检退出态
      const { gate, isStartupGatesInitialized } = await import('../../../main/startup-gates')
      if (!isTestEnvironment() || isStartupGatesInitialized()) {
        await gate('reaperDone')
      }
      const { processReaper: omniReaperCheck } = await import('../../../main/process-reaper')
      if (omniReaperCheck.isQuittingState() || (this as any).isStopping) {
        logger.info(LogCategory.SYSTEM, '[OmniService] 进程正在退出，取消拉起 firefly-omni')
        return false
      }

      const child = spawn(exePath, spawnArgs, {
        cwd: binDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
      const launchCtx = this.createLaunchContext(launchGeneration, child, spawnedWithDml)
      this.currentLaunchCtx = launchCtx

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
        const rawText = stripAnsi(data)
        this.appendLaunchStderr(launchCtx, rawText)
        const str = rawText.trim()
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

      child.on('exit', (code, signal) => {
        logger.warn(
          LogCategory.SYSTEM,
          `[OmniService] 子进程退出 (gen=${launchCtx.generation}, pid=${launchCtx.pid}, code=${code}, signal=${signal})`
        )
        try {
          const { processReaper } = require('../../../main/process-reaper')
          processReaper.unregisterChild(child.pid)
        } catch {}
      })

      // 统一延后到 child.on('close')（stderr 管道彻底排空后）做最终四分类崩溃归因与生命周期回调
      child.on('close', async (code, signal) => {
        const stderrTail = this.getLaunchStderrTail(launchCtx)
        const category = classifyOmniCrash({
          managedChild: true,
          dmlEnabled: launchCtx.spawnedWithDml,
          wasIntentionalKill: launchCtx.intentionalKill || this.isIntentionalStopping,
          exitCode: code,
          signal,
          stderrTail
        })

        if (category === 'dml_native_crash') {
          this.persistDmlCrash(this.dmlCrashMarkerPath, typeof code === 'number' ? code : 0)
          logger.warn(
            LogCategory.SYSTEM,
            `[OmniService] 检测到 DirectML 原生崩溃 (gen=${launchCtx.generation}, code=${typeof code === 'number' ? `0x${(code >>> 0).toString(16)}` : code}, signal=${signal})，已按滑动窗口写入保护标记`
          )
        } else if (category === 'rust_oom') {
          logger.error(
            LogCategory.SYSTEM,
            `[OmniService] ❌ 检测到 Omni 内存耗尽崩溃 (rust_oom, gen=${launchCtx.generation}, code=${code})，绝不误封 DirectML 硬件加速`
          )
        } else if (category === 'intentional_kill') {
          logger.debug(
            LogCategory.SYSTEM,
            `[OmniService] 受控终止子进程已关闭 (gen=${launchCtx.generation}, code=${code}, signal=${signal})`
          )
        } else {
          logger.warn(
            LogCategory.SYSTEM,
            `[OmniService] 子进程关闭 (category=${category}, gen=${launchCtx.generation}, dml=${launchCtx.spawnedWithDml}, code=${code}, signal=${signal})，不写入 DirectML 封禁标记`
          )
        }

        launchCtx.closed = true
        launchCtx.resolveClose()

        this.unlinkManifestSafe(expectedMountsSnapshot.manifestPath)
        if (
          expectedMountsSnapshot.manifestPath &&
          this.currentMountManifestPath === expectedMountsSnapshot.manifestPath
        ) {
          this.currentMountManifestPath = null
        }

        // 单调代际归属守卫：过期代延迟 close 仅落归因日志，绝不污染新实例、绝不发回调
        const isCurrentGen =
          launchCtx.generation === this.currentGeneration && this.process === child
        if (!isCurrentGen) {
          return
        }

        this.process = null
        this.expectedIdentity = null
        this.cachedVersion = null
        this.connectedTarget = null
        this.lastVerifiedAtMs = 0
        this.unhealthySince = null
        this.lastFailureAt = null
        if (this.currentLaunchCtx === launchCtx) {
          this.currentLaunchCtx = null
        }

        const nextGen = ++this.currentGeneration
        this.emitLifecycleInactive(nextGen)

        // 主动推送"未运行"状态至渲染进程（基础AI引擎 Footer 展示）
        this.pushStatus().catch(() => {})
        if (this.isIntentionalStopping || launchCtx.intentionalKill) {
          return
        }
        // 子进程异常退出后，仅当同源验证通过才允许外部服务接管，并完整采纳新实例身份与重建 SSE
        const verifiedExternal = await this.verifyOmniInstance(
          this.actualPort,
          undefined,
          verifyOpts
        )
        if (
          this.currentGeneration !== nextGen ||
          this.isIntentionalStopping ||
          this.process !== null ||
          this.isStarting
        ) {
          return
        }
        if (verifiedExternal.ok) {
          const adoptedPid =
            typeof verifiedExternal.data?.pid === 'number' ? verifiedExternal.data.pid : undefined
          const adoptedInstanceId = this.resolveAdoptedInstanceId(
            verifiedExternal.data,
            verifiedExternal.headerInstanceId,
            this.actualPort
          )
          const version =
            typeof verifiedExternal.data?.version === 'string' && verifiedExternal.data.version
              ? verifiedExternal.data.version
              : null
          this.applyAdoptedInstanceIdentity({
            port: this.actualPort,
            pid: adoptedPid,
            instanceId: adoptedInstanceId,
            version
          })
          logger.debug(
            LogCategory.SYSTEM,
            `[OmniService] ${this.actualPort} 端口已有同源外部服务接管，已完成身份采纳与 SSE 重建`
          )
          this.restartAttempts = 0
          this.syncConfigFromDesktop().catch(() => {})
          this.kickEventStreamReconnect({
            expectedTarget: {
              baseUrl: this.baseUrl,
              pid: adoptedPid,
              instanceId: adoptedInstanceId
            },
            resetFailures: true
          })
          const externalGen = ++this.currentGeneration
          this.emitInstanceChanged(externalGen)
          if (verifiedExternal.data?.visualVocab) {
            this.handleStartupVisualVocabStatus({ statusData: verifiedExternal.data })
          }
          this.notifyReady()
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
            // Ticket 06 启动链三态非阻断约束：visualVocab / mount 状态为 stale / missing / corrupt
            // 或瞬时探测异常时，记录降级警告并放行纯文本服务激活，严禁调用 stop() 误杀引擎进程。
            logger.warn(
              LogCategory.SYSTEM,
              `[OmniService] 挂载清单/词表核验处于降级态（非阻断，放行纯文本服务继续运行）: ${this.lastMountValidationError}`
            )
          } else {
            this.handleStartupVisualVocabStatus(verifyRes)
          }
          const statusData = verifyRes.statusData
          const resolvedId = this.resolveAdoptedInstanceId(
            statusData,
            undefined,
            this.actualPort,
            this.expectedIdentity?.instanceId
          )
          this.expectedIdentity = {
            pid: typeof statusData?.pid === 'number' ? statusData.pid : child.pid,
            instanceId: resolvedId,
            port: this.actualPort
          }
          if (typeof statusData?.version === 'string' && statusData.version) {
            this.cachedVersion = statusData.version
          }
          this.connectedTarget = {
            baseUrl: this.baseUrl,
            pid: this.expectedIdentity.pid,
            instanceId: resolvedId
          }
          this.lastVerifiedAtMs = Date.now()
          this.unhealthySince = null
          this.lastFailureAt = null

          logger.info(
            LogCategory.SYSTEM,
            `[OmniService] firefly-omni 服务就绪并在 ${this.baseUrl} 正常监听 (gen=${launchGeneration})`
          )
          this.restartAttempts = 0
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
          this.emitInstanceChanged(launchGeneration)
          this.notifyReady()
          return true
        }
      }

      logger.error(
        LogCategory.SYSTEM,
        `[OmniService] firefly-omni 启动探活超时 (80s)，终止当前未就绪子进程`
      )
      await this.stop()
      // 启动失败（探活超时），推送"未运行"状态
      this.pushStatus().catch(() => {})
      return false
    } catch (err) {
      logger.error(LogCategory.SYSTEM, '[OmniService] 启动服务发生异常:', err)
      return false
    } finally {
      this.isStarting = false
    }
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
    if (!child) return
    const pid = child.pid
    if (this.currentLaunchCtx && this.currentLaunchCtx.child === child) {
      this.currentLaunchCtx.intentionalKill = true
    }
    if (typeof pid !== 'number' || pid <= 0) {
      return
    }
    let killSucceeded = false
    try {
      killProcessTree(pid)
      if (child.exitCode === null && child.signalCode === null) {
        try {
          child.kill('SIGKILL')
        } catch {}
      }
      killSucceeded = true
      logger.info(
        LogCategory.SYSTEM,
        `[OmniService] 已彻底终止 firefly-omni 进程树 (PID=${pid}, reason=${reason})`
      )
    } catch (err) {
      logger.warn(
        LogCategory.SYSTEM,
        `[OmniService] 终止 firefly-omni 进程树失败，保留 processReaper 追踪 (PID=${pid}, reason=${reason}):`,
        err
      )
    }
    if (killSucceeded) {
      try {
        const { processReaper } = require('../../../main/process-reaper')
        processReaper.unregisterChild(pid)
      } catch {}
    }
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
    if (this.currentLaunchCtx && this.currentLaunchCtx.child === child) {
      this.currentLaunchCtx.intentionalKill = true
    }
    ++this.stopEpoch
    ++this.connectionEpoch
    this.stopController.abort()
    this.unmountDiscoveryWatcher()
    this.eventStreamAbortController?.abort()
    this.reconnectAbortController?.abort()
    this.activeLoopEpoch = null
    this.cachedVersion = null
    this.connectedTarget = null
    this.expectedIdentity = null
    this.lastVerifiedAtMs = 0
    this.unhealthySince = null
    this.lastFailureAt = null
    this.lastStatusEvent = null

    const nextGen = ++this.currentGeneration
    this.emitLifecycleInactive(nextGen)

    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout)
      this.restartTimeout = null
    }
    this.process = null
    this.forceKillProcessTree(child, 'stop_immediately_sync')

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
        const res = await this.omniFetch(`${this.baseUrl}/api/v1/engine/status`, {
          kind: 'probe',
          timeoutMs: 1500,
          internal: true
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
   * 通知已运行的 Omni 实例热重载资产与单轨挂载清单（POST /api/v1/assets/reload）
   */
  public async reloadAssets(): Promise<boolean> {
    if (!this.baseUrl) return false
    try {
      const res = await this.omniFetch(`${this.baseUrl}/api/v1/assets/reload`, {
        method: 'POST',
        kind: 'probe',
        timeoutMs: STATUS_VERIFY_TIMEOUT_MS,
        internal: true
      })
      if (!res.ok) {
        logger.warn(
          LogCategory.SYSTEM,
          `[OmniService] POST /api/v1/assets/reload 返回 HTTP ${res.status}`
        )
        return false
      }
      return true
    } catch (err: any) {
      logger.warn(
        LogCategory.SYSTEM,
        `[OmniService] 调用 POST /api/v1/assets/reload 异常: ${err?.message || String(err)}`
      )
      return false
    }
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
    visualVocabStatus?: string
    visualVocab?: VisualVocabStatusTelemetry
  }> {
    const target = expected ?? this.lastExpectedMounts
    try {
      const lang = (this.getConfigValue<string>('DEFAULT_LANGUAGE') || '').trim()
      const qs = lang ? `?lang=${encodeURIComponent(lang)}` : ''
      const res = await this.omniFetch(`${this.baseUrl}/api/v1/engine/status${qs}`, {
        kind: 'probe',
        timeoutMs: STATUS_VERIFY_TIMEOUT_MS,
        internal: true
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

        const visualVocab = data?.visualVocab as VisualVocabStatusTelemetry | undefined
        const visualVocabStatus =
          typeof visualVocab?.activeStatus === 'string' ? visualVocab.activeStatus : undefined
        return {
          ok: true,
          statusData: data,
          visualVocabStatus,
          visualVocab
        }
      }

      const visualVocabEarly = data?.visualVocab as VisualVocabStatusTelemetry | undefined
      const visualVocabStatusEarly =
        typeof visualVocabEarly?.activeStatus === 'string'
          ? visualVocabEarly.activeStatus
          : undefined
      return {
        ok: true,
        statusData: data,
        visualVocabStatus: visualVocabStatusEarly,
        visualVocab: visualVocabEarly
      }
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
    const vv =
      verifyRes.visualVocab ??
      (verifyRes.statusData?.visualVocab as VisualVocabStatusTelemetry | undefined)
    const status = verifyRes.visualVocabStatus ?? vv?.activeStatus
    if (!status || status === 'not_provisioned') {
      return
    }
    const activeEncoderId = typeof vv?.activeEncoderId === 'number' ? vv.activeEncoderId : undefined

    if (status === 'ok') {
      this.visualTaggerAvailable = true
      if (activeEncoderId !== undefined) {
        this.notifyVisualTaggerRecovered(activeEncoderId)
      }
      return
    }

    if (status === 'stale') {
      this.visualTaggerAvailable = false
      logger.warn(
        LogCategory.SYSTEM,
        '[OmniService] 启动核验发现视觉词表处于 stale 状态，保留进程并触发异步对账（纯文本服务不受影响）'
      )
      if (!this.startupVisualReconcileInFlight && activeEncoderId !== undefined) {
        this.startupVisualReconcileInFlight = true
        void this.triggerStartupVisualReconcile(activeEncoderId).finally(() => {
          this.startupVisualReconcileInFlight = false
        })
      }
      return
    }

    if (status === 'missing' || status === 'corrupt') {
      this.visualTaggerAvailable = false
      logger.warn(
        LogCategory.SYSTEM,
        `[OmniService] 启动核验发现视觉词表不可用 (${status})，仅标为视觉不可用，不阻断纯文本检索服务`
      )
    }
  }

  private async triggerStartupVisualReconcile(encoderId: number): Promise<void> {
    const resourceId =
      encoderId === 2
        ? 'chinese-clip'
        : encoderId === 3
          ? 'mobile-clip'
          : encoderId === 4
            ? 'embeddinggemma-2-onnx'
            : null
    if (!resourceId) return
    try {
      const { modularResourceService } = await import('../modular-resource-service')
      if (typeof (modularResourceService as any)?.reconcileVisualVocabResource === 'function') {
        const res = await (modularResourceService as any).reconcileVisualVocabResource(resourceId)
        if (res?.ok) {
          this.visualTaggerAvailable = true
        }
      }
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[OmniService] 启动期视觉词表异步对账异常:', err)
    }
  }

  /**
   * 独立视觉资产热重载入口（POST /api/v1/assets/reload），与 /api/v1/taxonomy/reload-policies 物理隔离
   */
  public async reloadVisualAssets(langOpt?: string): Promise<AssetsReloadResult> {
    try {
      const lang =
        (typeof langOpt === 'string' && langOpt.trim()) ||
        this.getConfigValue<string>('DEFAULT_LANGUAGE') ||
        ''
      const qs = lang.trim() ? `?lang=${encodeURIComponent(lang.trim())}` : ''
      const res = await this.omniFetch(`${this.baseUrl}/api/v1/assets/reload${qs}`, {
        kind: 'call',
        method: 'POST',
        timeoutMs: 15_000,
        internal: true
      })
      const json = (await res.json().catch(() => null)) as Record<string, any> | null
      if (!res.ok || json?.success === false) {
        const errMsg =
          (typeof json?.error?.message === 'string' && json.error.message) || `HTTP ${res.status}`
        return { success: false, error: errMsg }
      }
      const tagger = json?.assets?.tagger as
        | {
            status?: string
            activeStatus?: string
            activeEncoderId?: number
            byEncoder?: Record<string, any>
          }
        | undefined
      const activeEncoderId =
        typeof tagger?.activeEncoderId === 'number' ? tagger.activeEncoderId : undefined
      const resolvedActiveStatus =
        tagger?.activeStatus ??
        (activeEncoderId !== undefined
          ? tagger?.byEncoder?.[String(activeEncoderId)]?.status
          : undefined) ??
        tagger?.status
      if (resolvedActiveStatus === 'ok') {
        this.visualTaggerAvailable = true
      }

      const recoveredIds = new Set<number>()
      if (tagger?.byEncoder && typeof tagger.byEncoder === 'object') {
        for (const [k, slot] of Object.entries(tagger.byEncoder)) {
          if (slot?.status === 'ok') {
            const id = typeof slot?.encoderId === 'number' ? slot.encoderId : Number(k)
            if (Number.isInteger(id) && id > 0) {
              recoveredIds.add(id)
            }
          }
        }
      }
      if (resolvedActiveStatus === 'ok' && activeEncoderId !== undefined) {
        recoveredIds.add(activeEncoderId)
      }
      for (const encId of recoveredIds) {
        this.notifyVisualTaggerRecovered(encId)
      }

      return {
        success: true,
        activeStatus: resolvedActiveStatus,
        byEncoder: tagger?.byEncoder
      }
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) }
    }
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
      const hibernationTargetId = opts.moduleId === 'tts_m5_onnx' ? 'tts-m5-onnx' : 'tts-moss-onnx'

      // 1. 先探活 /api/audio/tts/status 确认挂载路由激活且模型包已安装 (installed)
      const statusDeadline = Date.now() + 5_000
      let lastError = ''
      let installedOrReady = false

      while (Date.now() < statusDeadline) {
        try {
          const statusRes = await this.omniFetch(`${this.baseUrl}/api/audio/tts/status`, {
            kind: 'probe',
            timeoutMs: 2000,
            internal: true
          })
          if (statusRes.ok) {
            const ttsStatus = (await statusRes.json()) as {
              ready?: boolean
              installed?: boolean
              total_voices?: number
              engine?: string
            }
            const engineMatched = ttsStatus.engine === expectedEngine
            const hasCapability =
              ttsStatus.installed === true ||
              ttsStatus.ready === true ||
              (ttsStatus.installed === undefined && (ttsStatus.total_voices ?? 0) > 0)
            if (engineMatched && hasCapability) {
              installedOrReady = true
              break
            }
            lastError = `ready=${Boolean(ttsStatus?.ready)}, installed=${String(ttsStatus?.installed)}, engine=${ttsStatus?.engine || 'none'}`
          } else {
            lastError = `HTTP ${statusRes.status}`
          }
        } catch (err: any) {
          lastError = err?.message || String(err)
        }
        await new Promise(resolve => setTimeout(resolve, 250))
      }

      if (!installedOrReady) {
        throw new Error(
          `TTS 引擎挂载验证未通过 (expected=${expectedEngine}, details: ${lastError})`
        )
      }

      // 2. 冒烟正式接入统一休眠协调器（懒加载模式下经 withHibernationGate 按需激活会话并确认 ready）
      try {
        const [{ moduleHibernationCoordinator }, { engineBridgeService }] = await Promise.all([
          import('../../hibernation/module-hibernation-coordinator'),
          import('../../engine-bridge')
        ])
        moduleHibernationCoordinator.setOmniLifecycleProvider(this)
        if (!moduleHibernationCoordinator.getEngineBridgeService()) {
          moduleHibernationCoordinator.setEngineBridgeService(engineBridgeService)
        }
        moduleHibernationCoordinator.forceResetExternalHibernated(
          hibernationTargetId,
          this.getGeneration()
        )
        await moduleHibernationCoordinator.withHibernationGate(
          {
            targetId: hibernationTargetId,
            clusterId: 'tts_media',
            livenessSourceKey: 'task_progress'
          },
          async () => {
            const statusRes = await this.omniFetch(`${this.baseUrl}/api/audio/tts/status`, {
              kind: 'probe',
              timeoutMs: 3000,
              internal: true
            })
            if (!statusRes.ok) {
              throw new Error(`HTTP ${statusRes.status}`)
            }
            const ttsStatus = (await statusRes.json()) as {
              ready?: boolean
              engine?: string
            }
            if (!ttsStatus?.ready || ttsStatus.engine !== expectedEngine) {
              throw new Error(
                `ready=${Boolean(ttsStatus?.ready)}, engine=${ttsStatus?.engine || 'none'}`
              )
            }
          }
        )
      } catch (smokeErr: any) {
        throw new Error(
          `TTS 引擎协调器冒烟未通过 (expected=${expectedEngine}, details: ${smokeErr?.message || String(smokeErr)})`
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
    if (this.currentLaunchCtx && this.currentLaunchCtx.child === child) {
      this.currentLaunchCtx.intentionalKill = true
    }
    ++this.stopEpoch
    ++this.connectionEpoch
    this.stopController.abort()
    this.unmountDiscoveryWatcher()
    this.eventStreamAbortController?.abort()
    this.reconnectAbortController?.abort()
    this.activeLoopEpoch = null
    this.cachedVersion = null
    this.connectedTarget = null
    this.expectedIdentity = null
    this.lastVerifiedAtMs = 0
    this.unhealthySince = null
    this.lastFailureAt = null
    this.lastStatusEvent = null

    const nextGen = ++this.currentGeneration
    this.emitLifecycleInactive(nextGen)

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
            this.forceKillProcessTree(child, 'stop_graceful_timeout')
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
      const res = await this.omniFetch(`${this.baseUrl}/health`, {
        kind: 'probe',
        timeoutMs,
        signal: options?.signal,
        internal: true
      })
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

      const res = await this.omniFetch(`${this.baseUrl}/api/config`, {
        kind: 'call',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        timeoutMs: 3000,
        internal: true
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
      const res = await this.omniFetch(`${this.baseUrl}/api/reconnect`, {
        kind: 'call',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dbPath }),
        timeoutMs: 5000
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
      const res = await this.omniFetch(`${this.baseUrl}/api/extract`, {
        kind: 'long',
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
      if (!this.shouldRestartAfterFetchError(err)) {
        logger.warn(
          LogCategory.SYSTEM,
          `[OmniService] <<< POST /api/extract 异常 (${filePath}): 耗时: ${Date.now() - tStart}ms, 错误: ${fullError}（进程仍存活，不触发误杀重启）`
        )
        return null
      }
      logger.warn(
        LogCategory.SYSTEM,
        `[OmniService] <<< POST /api/extract 首次调用异常 (${filePath}): 耗时: ${Date.now() - tStart}ms, 错误: ${fullError}，尝试自愈拉起并重试...`
      )
      // 若进程已失活或端口明确拒绝连接（宽限期外），触发自愈并重试一次
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
        const res = await this.omniFetch(`${this.baseUrl}/api/geo/reverse`, {
          kind: 'call',
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqBody),
          timeoutMs: 3000
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
        if (this.shouldRestartAfterFetchError(fetchErr)) {
          const restarted = await this.start()
          if (restarted) {
            try {
              return await doFetch()
            } catch {}
          }
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
      const res = await this.omniFetch(url, {
        kind: 'long',
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
      if (!this.shouldRestartAfterFetchError(err)) {
        logger.debug(
          LogCategory.SYSTEM,
          `[OmniService] <<< GET /api/cover 异常 (${filePath}, 耗时: ${Date.now() - tStart}ms): ${err.message}（进程存活不触发重启）`
        )
        return null
      }
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

    // perceive 超时 = CPU 阶段上限（总预算 − 按类型分配的 AI 保底），见 analysis-timeout-policy。
    // 音视频不再放宽到 10 分钟：那会让单文件真实上限变成「10 分钟 + AI 分析」。
    // 请求里带了音视频专属参数时以之为准，避免无扩展名的媒体文件被误判成文档。
    const videoParams =
      options?.videoFrameQuotaMax !== undefined ||
      options?.videoSoftTokenBudget !== undefined ||
      options?.videoAsrDurationSec !== undefined
        ? {
            videoFrameQuotaMax: options?.videoFrameQuotaMax,
            videoSoftTokenBudget: options?.videoSoftTokenBudget,
            videoAsrDurationSec: options?.videoAsrDurationSec
          }
        : undefined
    const isMediaHint =
      options?.enableAudioTranscript === true ||
      options?.audioAnalysisDuration !== undefined ||
      options?.enableVideoVisualAnalysis === true ||
      videoParams !== undefined
    const budget = resolveAnalysisTimeoutBudget(
      filePath,
      undefined,
      isMediaHint,
      undefined,
      videoParams
    )
    // 视频抽帧与多模态感知具有客观重计算开销（如 200s+ 视频 Route A 需约 80-90s），
    // 为防止压线 100s 触发 AbortSignal 导致整个视频切片与向量全毁，至少预留 totalMs - 20s 给 perceive
    const effectiveCpuCapMs =
      budget.kind === 'video' ? Math.max(budget.cpuCapMs, budget.totalMs - 20000) : budget.cpuCapMs
    const timeoutMs = options?.timeoutMs || effectiveCpuCapMs
    // 单源闭合透传 perceive_timeout_sec（与 Desktop AbortSignal 同源，防止 Rust 看门狗倒挂抢杀）
    const perceiveTimeoutSec = options?.perceiveTimeoutSec ?? timeoutMs / 1000
    const reqBody = buildPerceiveRequestBody(
      filePath,
      { ...options, perceiveTimeoutSec },
      <T>(key: string) => this.getConfigValue<T>(key)
    )
    logger.debug(
      LogCategory.SYSTEM,
      `[OmniService] >>> POST /api/perceive 请求发起:`,
      JSON.stringify(reqBody)
    )

    const doFetch = async () => {
      const timeoutSignal = AbortSignal.timeout(timeoutMs)
      const combinedSignal = options?.signal
        ? AbortSignal.any([timeoutSignal, options.signal])
        : timeoutSignal
      const res = await this.omniFetch(`${this.baseUrl}/api/perceive`, {
        kind: 'long',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Connection: 'keep-alive'
        },
        body: JSON.stringify(reqBody),
        signal: combinedSignal
      })

      if (!res.ok) {
        throw await this.parsePerceptionHttpError(res, 'POST /api/perceive', Date.now() - tStart)
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
      if (err instanceof OmniPerceptionHttpError) {
        throw err
      }
      const causeMsg =
        err?.cause?.message || err?.cause?.code || (err?.cause ? String(err.cause) : '')
      const fullError = causeMsg ? `${err.message} (cause: ${causeMsg})` : err.message
      // 严禁在 perceive catch 中盲调 persistDmlCrash：崩溃归因唯一事实源为 child.on('close') + LaunchContext
      if (!this.shouldRestartAfterFetchError(err, options?.signal?.aborted === true)) {
        logger.warn(
          LogCategory.SYSTEM,
          `[OmniService] <<< POST /api/perceive 异常 (${filePath}): 耗时: ${Date.now() - tStart}ms, 错误: ${fullError}（进程仍存活或主动中止，不触发误杀重启）`
        )
        return null
      }
      logger.warn(
        LogCategory.SYSTEM,
        `[OmniService] <<< POST /api/perceive 首次调用异常 (${filePath}): 耗时: ${Date.now() - tStart}ms, 错误: ${fullError}，尝试自愈拉起并重试...`
      )
      const restarted = await this.start()
      if (restarted) {
        try {
          return await doFetch()
        } catch (retryErr: any) {
          if (retryErr instanceof OmniPerceptionHttpError) {
            throw retryErr
          }
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
      const res = await this.omniFetch(`${this.baseUrl}/api/audio/transcribe`, {
        kind: 'long',
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
      if (!this.shouldRestartAfterFetchError(err, options?.signal?.aborted === true)) {
        return null
      }
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
      const res = await this.omniFetch(`${this.baseUrl}/api/audio/convert`, {
        kind: 'long',
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
      if (!this.shouldRestartAfterFetchError(err)) {
        return null
      }
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
   * 统一解析 Omni 感知/视觉接口非 2xx 响应为强类型 `OmniPerceptionHttpError`
   */
  private async parsePerceptionHttpError(
    res: Response,
    endpointLabel: string,
    elapsedMs?: number
  ): Promise<OmniPerceptionHttpError> {
    const rawText = await res.text().catch(() => '')
    let parsedErr: any = null
    try {
      parsedErr = rawText ? JSON.parse(rawText) : null
    } catch {
      parsedErr = null
    }
    const errBlock =
      parsedErr?.error && typeof parsedErr.error === 'object' ? parsedErr.error : parsedErr
    const code =
      (typeof errBlock?.code === 'string' && errBlock.code) ||
      (typeof parsedErr?.code === 'string' && parsedErr.code) ||
      `HTTP_${res.status}`
    const reason =
      typeof errBlock?.reason === 'string'
        ? errBlock.reason
        : typeof parsedErr?.reason === 'string'
          ? parsedErr.reason
          : undefined
    const encoderId =
      typeof errBlock?.encoder_id === 'number'
        ? errBlock.encoder_id
        : typeof errBlock?.encoderId === 'number'
          ? errBlock.encoderId
          : undefined
    const message =
      typeof errBlock?.message === 'string' && errBlock.message
        ? errBlock.message
        : rawText || `Omni ${endpointLabel} 返回 HTTP ${res.status}`
    const elapsedSuffix = typeof elapsedMs === 'number' ? `, 耗时: ${elapsedMs}ms` : ''
    logger.warn(
      LogCategory.SYSTEM,
      `[OmniService] <<< ${endpointLabel} 响应异常: status=${res.status}, code=${code}, reason=${reason || 'none'}${elapsedSuffix}`
    )
    return new OmniPerceptionHttpError({
      status: res.status,
      code,
      reason,
      encoderId,
      message
    })
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
      const res = await this.omniFetch(`${this.baseUrl}/api/vision/tags`, {
        kind: 'call',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        timeoutMs
      })
      if (!res.ok) {
        throw await this.parsePerceptionHttpError(res, 'POST /api/vision/tags')
      }
      const json = (await res.json()) as OmniVisionTagsResponse
      return json.tags || []
    }

    try {
      return await doFetch()
    } catch (err: any) {
      if (err instanceof OmniPerceptionHttpError) {
        throw err
      }
      logger.debug(
        LogCategory.SYSTEM,
        `[OmniService] extractVisualTags 异常 (${filePath}):`,
        err.message
      )
      if (!this.shouldRestartAfterFetchError(err)) {
        return null
      }
      const restarted = await this.start()
      if (restarted) {
        try {
          return await doFetch()
        } catch (retryErr: any) {
          if (retryErr instanceof OmniPerceptionHttpError) {
            throw retryErr
          }
        }
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
      const res = await this.omniFetch(`${this.baseUrl}/api/vision/inspect`, {
        kind: 'call',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        timeoutMs
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
      if (!this.shouldRestartAfterFetchError(err)) {
        return null
      }
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
      const res = await this.omniFetch(`${this.baseUrl}/api/fs/ads`, {
        kind: 'call',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        timeoutMs
      })
      if (!res.ok) return null
      return (await res.json()) as OmniFsAdsResponse
    }

    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] inspectAds 异常 (${filePath}):`, err.message)
      if (!this.shouldRestartAfterFetchError(err)) {
        return null
      }
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
      const res = await this.omniFetch(`${this.baseUrl}/api/search/index`, {
        kind: 'call',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documents }),
        timeoutMs
      })
      if (!res.ok) return null
      return (await res.json()) as OmniIndexResponse
    }
    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] indexDocuments 异常:`, err.message)
      if (!this.shouldRestartAfterFetchError(err)) {
        return null
      }
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
      const res = await this.omniFetch(`${this.baseUrl}/api/search/hybrid`, {
        kind: 'call',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
        timeoutMs
      })
      if (!res.ok) return null
      return (await res.json()) as OmniHybridSearchResponse
    }
    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] searchHybrid 异常:`, err.message)
      if (!this.shouldRestartAfterFetchError(err)) {
        return null
      }
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
    timeoutMs: number = 30000,
    skipEnsureRunning: boolean = false
  ): Promise<OmniClusterResponse | null> {
    if (skipEnsureRunning) {
      if (!this.isReady()) {
        return null
      }
    } else {
      await this.ensureRunning()
    }
    const doFetch = async () => {
      const res = await this.omniFetch(`${this.baseUrl}/api/search/cluster`, {
        kind: 'long',
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
      logger.debug(LogCategory.SYSTEM, `[OmniService] clusterDocuments 异常:`, err?.message || err)
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
      const res = await this.omniFetch(`${this.baseUrl}/api/hownet/describe`, {
        kind: 'call',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        timeoutMs
      })
      if (!res.ok) return null
      return (await res.json()) as OmniHowNetDescribeResult
    }

    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] describeHowNet 异常 (${word}):`, err.message)
      if (!this.shouldRestartAfterFetchError(err)) {
        return null
      }
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
      const res = await this.omniFetch(`${this.baseUrl}/api/text/analyze`, {
        kind: 'call',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        timeoutMs
      })
      if (!res.ok) return null
      return (await res.json()) as OmniTextAnalysisResult
    }

    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] analyzeText 异常:`, err.message)
      if (!this.shouldRestartAfterFetchError(err)) {
        return null
      }
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
      const res = await this.omniFetch(`${this.baseUrl}/api/text/nsfw`, {
        kind: 'call',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: params.text,
          file_path: params.filePath,
          image_base64: params.imageBase64,
          language: params.language
        }),
        timeoutMs
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
      const res = await this.omniFetch(`${this.baseUrl}/api/taxonomy/resolve-parent`, {
        kind: 'call',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        timeoutMs
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
      const res = await this.omniFetch(`${this.baseUrl}/api/v1/taxonomy/inspect-tag`, {
        kind: 'call',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: controller.signal,
        timeoutMs
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
      const res = await this.omniFetch(`${this.baseUrl}/api/v1/vector/batch-embed-text`, {
        kind: 'call',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: controller.signal,
        timeoutMs
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
    timeoutMs?: number
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
      // 冷启动时 Gemma 加密文本塔首次解密装载通常耗时 ~20s，旧 4000ms 硬编码会导致首次引导/切换底座被误判失败
      const defaultTimeoutMs = payload.profile === 'gemma_unified' ? 30_000 : 15_000
      const smokeTimeoutMs =
        typeof payload.timeoutMs === 'number' && payload.timeoutMs > 0
          ? payload.timeoutMs
          : defaultTimeoutMs
      const testEmbed = await this.batchEmbedText(tokens, {
        profile: payload.profile,
        timeoutMs: smokeTimeoutMs
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
