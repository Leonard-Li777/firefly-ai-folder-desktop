/**
 * OmniService 发现文件监听、SSE 事件流重连与实例校验逻辑
 * （由 omni-service.ts 拆分而来，保持原运行时行为与类型契约）
 */
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
import { subscribePowerEvent } from '../../../main/power-hub'
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
  OmniService,
  type VerifyInstanceResult,
  type OmniFetchOptions,
  type OmniFetchKind,
  type LaunchContext
} from './omni-service'

/** 解析 Desktop userData 绝对路径 */
export function omniDiscoveryResolveUserDataDir(host: any): string | null {
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
export function omniDiscoveryGetDiscoveryFile(host: any): ServiceDiscoveryFile | null {
  if (host.discoveryFile) {
    return host.discoveryFile
  }
  const userDataPath = host.resolveUserDataDir()
  if (!userDataPath) {
    return null
  }
  host.discoveryFile = new ServiceDiscoveryFile({
    fileName: 'omni-config.json',
    serviceId: 'firefly-omni-server',
    userDataPath
  })
  return host.discoveryFile
}

/** 挂载 `userData/run/omni-config.json` 单例 DirWatcher 监听 */
export function omniDiscoveryMountDiscoveryWatcher(host: any): void {
  if (host.discoveryWatchDispose) {
    return
  }
  const df = host.getDiscoveryFile()
  if (!df) {
    return
  }
  host.discoveryWatchDispose = df.watch((info: any) => {
    host.handleDiscoveryFileChanged(info)
  })
}

/** 卸载 `userData/run/omni-config.json` 目录监听 */
export function omniDiscoveryUnmountDiscoveryWatcher(host: any): void {
  if (host.discoveryWatchDispose) {
    try {
      host.discoveryWatchDispose()
    } catch {}
    host.discoveryWatchDispose = null
  }
}

/** 注册系统休眠唤醒（PowerEventHub resume）纯事件唤醒源 */
export function omniDiscoveryRegisterPowerResumeWakeup(host: any): void {
  if (host.powerResumeListener) return
  try {
    const listener = () => {
      logger.info(
        LogCategory.SYSTEM,
        '[OmniService] 检测到系统从休眠唤醒 (PowerEventHub.resume)，重读发现文件并唤醒 SSE'
      )
      host.mountDiscoveryWatcher()
      host.syncFromDiscoveryFileOnce({ resetFailures: true })
    }
    host.powerResumeListener = listener
    subscribePowerEvent('resume', listener, { id: 'omni-service', resumeOffsetMs: 150 })
  } catch {}
}

/** 单次重读 `userData/run/omni-config.json` 并按需触发 SSE 重连（供 resume / 焦点刷新等事件源使用） */
export function omniDiscoverySyncFromDiscoveryFileOnce(
  host: any,
  options?: { resetFailures?: boolean }
): void {
  if (host.stopController.signal.aborted || host.isIntentionalStopping) {
    return
  }
  const df = host.getDiscoveryFile()
  const info = df?.read({ verifyPid: true }) ?? null
  if (info) {
    host.handleDiscoveryFileChanged(info, options?.resetFailures ?? true)
  } else if (host.process && !host.process.killed) {
    host.kickEventStreamReconnect({ resetFailures: options?.resetFailures ?? true })
  }
}

/** 处理发现文件变更事件：严格按「校验同源 → 先更新端口与预期身份 → 后 kick」顺序执行 */
export function omniDiscoveryHandleDiscoveryFileChanged(
  host: any,
  info: ServiceDiscoveryFileV1 | null,
  resetFailures = true
): void {
  if (host.stopController.signal.aborted || host.isIntentionalStopping) {
    return
  }

  if (!info) {
    // 文件被删除：若当前 SSE 仍健康在线，不立刻中断健康连接；若已断开且无受管进程则转离线 Dormant
    if (!host.isCurrentTargetHealthy() && (!host.process || host.process.killed)) {
      host.applyOffline()
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
      userDataDir: host.resolveUserDataDir(),
      masterDbPath: host.expectedMasterDbPath,
      targetVectorsDir: host.expectedVectorsDir
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
  host.actualPort = info.port
  host.baseUrl = info.baseUrl
  host.expectedIdentity = {
    pid: info.pid,
    instanceId: info.instanceId,
    port: info.port
  }
  host.kickEventStreamReconnect({
    expectedTarget: {
      baseUrl: info.baseUrl,
      pid: info.pid,
      instanceId: info.instanceId
    },
    resetFailures
  })
}

/** 8 阶段双代际归属校验：彻底阻断旧连接延迟回调覆盖新连接状态 */
export function omniDiscoveryIsCurrentOwner(
  host: any,
  myEpoch: number,
  myStopEpoch: number
): boolean {
  return (
    myEpoch === host.connectionEpoch &&
    myStopEpoch === host.stopEpoch &&
    !host.stopController.signal.aborted
  )
}

/** 判断当前 SSE 连接是否针对当前目标健康在线 */
export function omniDiscoveryIsCurrentTargetHealthy(
  host: any,
  expectedTarget?: ConnectedTargetIdentity
): boolean {
  if (!host.eventStreamAbortController || host.eventStreamAbortController.signal.aborted) {
    return false
  }
  if (!host.connectedTarget) {
    return false
  }
  if (!expectedTarget) {
    return host.connectedTarget.baseUrl === host.baseUrl
  }
  if (host.connectedTarget.baseUrl !== expectedTarget.baseUrl) {
    return false
  }
  if (typeof expectedTarget.pid === 'number' && host.connectedTarget.pid !== expectedTarget.pid) {
    return false
  }
  if (expectedTarget.instanceId && host.connectedTarget.instanceId !== expectedTarget.instanceId) {
    return false
  }
  return true
}

/** 确保单循环 SSE 状态流已建立（幂等入口） */
export function omniDiscoveryEnsureEventStream(host: any): void {
  if (host.stopController.signal.aborted || host.isIntentionalStopping) {
    return
  }
  if (host.isCurrentTargetHealthy()) {
    return
  }
  if (host.activeLoopEpoch !== null) {
    return
  }
  const myEpoch = ++host.connectionEpoch
  host.activeLoopEpoch = myEpoch
  void host.runStreamLoop(myEpoch, host.stopEpoch)
}

/** 事件驱动抢占重连（支持三元组身份比对与失败计数重置） */
export function omniDiscoveryKickEventStreamReconnect(
  host: any,
  options?: {
    expectedTarget?: ConnectedTargetIdentity
    resetFailures?: boolean
  }
): void {
  if (host.stopController.signal.aborted || host.isIntentionalStopping) {
    return
  }
  if (host.isCurrentTargetHealthy(options?.expectedTarget)) {
    return
  }
  if (options?.resetFailures) {
    host.consecutiveFailures = 0
  }
  host.eventStreamAbortController?.abort()
  host.reconnectAbortController?.abort()
  host.connectedTarget = null
  const myEpoch = ++host.connectionEpoch
  host.activeLoopEpoch = myEpoch
  void host.runStreamLoop(myEpoch, host.stopEpoch)
}

/** 单循环 SSE 状态驱动器（10s Connect + 35s Read 双阶看门狗 + DORMANT_MAX_ATTEMPTS=5 有界退避） */
export async function omniDiscoveryRunStreamLoop(
  host: any,
  myEpoch: number,
  myStopEpoch: number
): Promise<void> {
  try {
    while (host.isCurrentOwner(myEpoch, myStopEpoch)) {
      const outcome = await host.connectOnce(myEpoch, myStopEpoch)
      if (!host.isCurrentOwner(myEpoch, myStopEpoch)) {
        return
      }

      if (outcome === 'stopping') {
        // 收到服务端 stopping 终帧：立即离线并进入 Dormant，不再对正在停机的进程做退避重连
        host.applyOffline()
        return
      }

      if (outcome === 'eof') {
        // 正常 EOF 后：先检查受管进程或发现文件是否仍存活
        const dfInfo = host.getDiscoveryFile()?.read({ verifyPid: true }) ?? null
        const hasManagedChild = Boolean(
          host.process && !host.process.killed && host.process.exitCode === null
        )
        if (!hasManagedChild && !dfInfo) {
          host.applyOffline()
          return
        }
      }

      host.consecutiveFailures++

      // Dormant 准入判断 1：无受管子进程且发现文件缺失或 PID 已失活 → 立即转离线 Dormant（0 定时器、0 网络请求）
      const hasManagedChild = Boolean(
        host.process && !host.process.killed && host.process.exitCode === null
      )
      const dfInfo = host.getDiscoveryFile()?.read({ verifyPid: false }) ?? null
      const discoveryPidAlive = dfInfo ? isPidAlive(dfInfo.pid) : false
      if (!hasManagedChild && (!dfInfo || !discoveryPidAlive)) {
        host.applyOffline()
        return
      }

      if (host.consecutiveFailures >= (OmniService as any).OFFLINE_CONFIRM_FAILURES) {
        host.applyOffline()
      }

      // Dormant 准入判断 2：达到 DORMANT_MAX_ATTEMPTS (5) 次有界退避上限 → 强制退出循环转静默 Dormant
      if (host.consecutiveFailures >= DORMANT_MAX_ATTEMPTS) {
        logger.warn(
          LogCategory.SYSTEM,
          `[OmniService] SSE 连续重连失败达上限 (${DORMANT_MAX_ATTEMPTS} 次)，进入 Dormant 静默挂起态等待事件唤醒`
        )
        host.applyOffline()
        return
      }

      const baseDelay = Math.min(1000 * Math.pow(2, host.consecutiveFailures - 1), 16_000)
      const jitter = Math.floor(Math.random() * 500)
      const reconnectAc = new AbortController()
      host.reconnectAbortController = reconnectAc
      const stopSignal = host.stopController.signal
      const onStop = () => reconnectAc.abort()
      stopSignal.addEventListener('abort', onStop, { once: true })

      let wokeNaturally = false
      try {
        wokeNaturally = await sleepCancellable(baseDelay + jitter, reconnectAc.signal)
      } finally {
        stopSignal.removeEventListener('abort', onStop)
        if (host.reconnectAbortController === reconnectAc) {
          host.reconnectAbortController = null
        }
      }

      if (!wokeNaturally || !host.isCurrentOwner(myEpoch, myStopEpoch)) {
        return
      }
    }
  } finally {
    if (host.activeLoopEpoch === myEpoch) {
      host.activeLoopEpoch = null
    }
  }
}

/** 执行单次 SSE 建连与流读取（严格落实 10s Connect + 35s Read 看门狗与锁释放顺序） */
export async function omniDiscoveryConnectOnce(
  host: any,
  myEpoch: number,
  myStopEpoch: number
): Promise<'stopping' | 'eof' | 'failed'> {
  if (!host.isCurrentOwner(myEpoch, myStopEpoch)) {
    return 'failed'
  }

  const targetBaseUrl = host.baseUrl
  const targetPort = host.actualPort
  const expectedPid = host.expectedIdentity?.pid ?? host.process?.pid
  const myAc = new AbortController()
  host.eventStreamAbortController = myAc

  const stopSignal = host.stopController.signal
  const onStop = () => myAc.abort()
  stopSignal.addEventListener('abort', onStop, { once: true })

  // 阶段一：建连 10s 一次性看门狗（显式 setTimeout 兼容 Vitest fake timers）
  let connectTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    myAc.abort(new SseWatchdogTimeoutError('connect', SSE_CONNECT_TIMEOUT_MS))
  }, SSE_CONNECT_TIMEOUT_MS)

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  let receivedValidFrame = false

  try {
    const res = await host.omniFetch(`${targetBaseUrl}/api/v1/omni/events`, {
      kind: 'stream',
      internal: true,
      headers: { Accept: 'text/event-stream' },
      signal: myAc.signal
    })

    if (connectTimer !== null) {
      clearTimeout(connectTimer)
      connectTimer = null
    }

    if (!host.isCurrentOwner(myEpoch, myStopEpoch)) {
      return 'failed'
    }
    if (!res.ok || !res.body) {
      return 'failed'
    }

    reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let lineBuffer = ''
    let dataLines: string[] = []

    while (host.isCurrentOwner(myEpoch, myStopEpoch)) {
      // 阶段二：流内每次 reader.read() 独立 35s 看门狗
      const { done, value } = await readWithWatchdog(reader!, SSE_READ_WATCHDOG_MS, myAc.signal)
      if (!host.isCurrentOwner(myEpoch, myStopEpoch)) {
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
                userDataDir: host.resolveUserDataDir(),
                masterDbPath: host.expectedMasterDbPath,
                targetVectorsDir: host.expectedVectorsDir
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

            if (!host.isCurrentOwner(myEpoch, myStopEpoch)) {
              return receivedValidFrame ? 'eof' : 'failed'
            }

            receivedValidFrame = true
            host.applyStatusEvent(evt, targetBaseUrl)
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
    if (host.isCurrentOwner(myEpoch, myStopEpoch)) {
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
    if (host.eventStreamAbortController === myAc) {
      host.eventStreamAbortController = null
    }
    if (host.isCurrentOwner(myEpoch, myStopEpoch)) {
      host.connectedTarget = null
    }
  }
}

/** 应用经同源校验的 SSE 状态帧：按 instanceId + revision 严格保序 */
export function omniDiscoveryApplyStatusEvent(
  host: any,
  evt: OmniStatusEvent,
  targetBaseUrl: string
): void {
  if (evt.instanceId !== host.lastAppliedInstanceId) {
    host.lastAppliedInstanceId = evt.instanceId
    host.lastAppliedRevision = 0
  }
  if (evt.revision <= host.lastAppliedRevision) {
    return
  }

  host.lastAppliedRevision = evt.revision
  host.lastStatusEvent = evt
  host.consecutiveFailures = 0
  host.connectedTarget = {
    baseUrl: targetBaseUrl,
    pid: evt.pid,
    instanceId: evt.instanceId
  }

  const running = evt.status === 'ok'
  if (running && evt.version) {
    host.cachedVersion = evt.version
  }
  broadcastOmniStatus({
    running,
    version: running && evt.version && evt.version !== '0.1.0' ? evt.version : null
  })
}

/** 标记离线并向渲染进程广播（stop 期间抑制重复闪烁） */
export function omniDiscoveryApplyOffline(host: any): void {
  host.connectedTarget = null
  host.lastStatusEvent = null
  if (!host.isIntentionalStopping) {
    broadcastOmniStatus({ running: false, version: null })
  }
}

/**
 * 基于当前状态快照推送至渲染进程（omni:status-changed），不再主动发起周期轮询探活
 */
export async function omniDiscoveryPushStatus(host: any): Promise<void> {
  if (host.lastStatusEvent && host.lastStatusEvent.status === 'ok') {
    const v = host.lastStatusEvent.version
    broadcastOmniStatus({ running: true, version: v && v !== '0.1.0' ? v : null })
    return
  }
  const running = await host.checkHealth()
  let version: string | null = null
  if (running) {
    const v = host.cachedVersion
    version = v && v !== '0.1.0' ? v : null
  }
  broadcastOmniStatus({ running, version })
}

/**
 * 同源校验指定端口上的 Omni 实例（显式单发、0 重试、默认 3000ms 超时）。
 * 注意：默认 `internal: true`，且仅当请求目标等于当前 `baseUrl` 时才受 `omniFetch` 同源校验；
 * 探测其他端口绝不污染当前已采纳的 `expectedIdentity`。
 */
export async function omniDiscoveryVerifyOmniInstance(
  host: any,
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
  const timeoutMs = options?.timeoutMs ?? (OmniService as any).PROBE_DEFAULT_TIMEOUT_MS
  const userDataDir =
    options?.userDataDir !== undefined ? options.userDataDir : host.resolveUserDataDir()
  const masterDbPath =
    options?.masterDbPath !== undefined ? options.masterDbPath : host.expectedMasterDbPath
  const targetVectorsDir =
    options?.targetVectorsDir !== undefined ? options.targetVectorsDir : host.expectedVectorsDir

  try {
    const lang = (host.getConfigValue('DEFAULT_LANGUAGE') || '').trim()
    const qs = lang ? `?lang=${encodeURIComponent(lang)}` : ''
    const res = await host.omniFetch(`http://127.0.0.1:${port}/api/v1/engine/status${qs}`, {
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
export async function omniDiscoveryVerifyAdoptedReuseOnce(host: any): Promise<boolean> {
  if (host.verifyPromise) {
    return host.verifyPromise
  }
  const targetPort = host.expectedIdentity?.port ?? host.actualPort
  const expectedPid = host.expectedIdentity?.pid
  const task = (async () => {
    const verified = await host.verifyOmniInstance(targetPort, expectedPid, {
      timeoutMs: (OmniService as any).PROBE_DEFAULT_TIMEOUT_MS,
      internal: true
    })
    if (!verified.ok || host.isIntentionalStopping) {
      return false
    }
    const resolvedInstanceId = host.resolveAdoptedInstanceId(
      verified.data,
      verified.headerInstanceId,
      targetPort
    )
    if (
      host.expectedIdentity?.instanceId &&
      resolvedInstanceId !== host.expectedIdentity.instanceId
    ) {
      host.invalidateAdoptedIdentity(
        `复用刷新 instanceId 变更: expected=${host.expectedIdentity.instanceId}, actual=${resolvedInstanceId}`
      )
      return false
    }
    host.actualPort = targetPort
    host.baseUrl = `http://127.0.0.1:${targetPort}`
    host.expectedIdentity = {
      pid: typeof verified.data?.pid === 'number' ? verified.data.pid : expectedPid,
      instanceId: resolvedInstanceId,
      port: targetPort
    }
    if (typeof verified.data?.version === 'string' && verified.data.version) {
      host.cachedVersion = verified.data.version
    }
    host.connectedTarget = {
      baseUrl: host.baseUrl,
      pid: host.expectedIdentity.pid,
      instanceId: resolvedInstanceId
    }
    host.lastVerifiedAtMs = Date.now()
    host.unhealthySince = null
    host.lastFailureAt = null
    return true
  })()

  host.verifyPromise = task
  try {
    return await task
  } finally {
    if (host.verifyPromise === task) {
      host.verifyPromise = null
    }
  }
}

/** 原子写入已验证通过的 Omni 实例身份与健康基线（供首次采纳、复用刷新、spawn 落定及 close 外部接管共享） */
export function omniDiscoveryApplyAdoptedInstanceIdentity(
  host: any,
  params: {
    port: number
    pid?: number
    instanceId: string
    version?: string | null
  }
): void {
  host.actualPort = params.port
  host.baseUrl = `http://127.0.0.1:${params.port}`
  host.expectedIdentity = {
    pid: params.pid,
    instanceId: params.instanceId,
    port: params.port
  }
  if (params.version) {
    host.cachedVersion = params.version
  }
  host.connectedTarget = {
    baseUrl: host.baseUrl,
    pid: params.pid,
    instanceId: params.instanceId
  }
  host.lastVerifiedAtMs = Date.now()
  host.unhealthySince = null
  host.lastFailureAt = null
}

/** 解析采纳实例的 instanceId：优先响应体 instanceId/instance_id，其次响应头，仅均缺失时退化 port:startTimeMs */
export function omniDiscoveryResolveAdoptedInstanceId(
  host: any,
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
