/**
 * OmniService HTTP 请求传输、非健康自愈重启与认证重连逻辑
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

/** 统一记录托管进程不健康失败并在满足 60s 且无其他在途请求时触发单飞有序重启 */
export function omniFetchHelperRecordManagedUnhealthyFailure(
  host: any,
  countSelfInflight: boolean
): void {
  if (!host.hasLiveManagedProcess() || host.isIntentionalStopping || host.isStarting) {
    return
  }
  const now = Date.now()
  if (
    host.lastFailureAt !== null &&
    now - host.lastFailureAt > (OmniService as any).UNHEALTHY_FAILURE_GAP_RESET_MS
  ) {
    host.unhealthySince = now
  } else if (host.unhealthySince === null) {
    host.unhealthySince = now
  }
  host.lastFailureAt = now

  const otherInflight = Math.max(0, host.inflightCount - (countSelfInflight ? 1 : 0))
  if (
    now - host.unhealthySince >= (OmniService as any).UNHEALTHY_RESTART_THRESHOLD_MS &&
    otherInflight === 0
  ) {
    void host.restartUnhealthyManaged()
  }
}

/**
 * 托管进程持续不健康满 60s 后的单飞自愈恢复终态：
 * 强杀前必经一次新鲜的 `verifyOmniInstance(internal: true)` 失败确证，
 * 确证失败才经 `ctx.intentionalKill = true` 有序重启一次，防误杀与递归风暴。
 */
export async function omniFetchHelperRestartUnhealthyManaged(host: any): Promise<boolean> {
  if (host.restartUnhealthyPromise) {
    return host.restartUnhealthyPromise
  }
  const task = (async () => {
    if (host.isIntentionalStopping || !host.hasLiveManagedProcess()) {
      return false
    }
    const verified = await host.verifyOmniInstance(host.actualPort, host.process?.pid, {
      timeoutMs: (OmniService as any).PROBE_DEFAULT_TIMEOUT_MS,
      internal: true
    })
    if (verified.ok) {
      host.unhealthySince = null
      host.lastFailureAt = null
      host.lastVerifiedAtMs = Date.now()
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
    if (host.isIntentionalStopping || !host.hasLiveManagedProcess()) {
      return false
    }
    host.unhealthySince = null
    host.lastFailureAt = null
    if (host.currentLaunchCtx && host.currentLaunchCtx.child === host.process) {
      host.currentLaunchCtx.intentionalKill = true
    }
    return await host.restart()
  })()

  host.restartUnhealthyPromise = task
  try {
    return await task
  } finally {
    if (host.restartUnhealthyPromise === task) {
      host.restartUnhealthyPromise = null
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
export async function omniFetchHelperOmniFetch(
  host: any,
  url: string | URL,
  init?: OmniFetchOptions
): Promise<Response> {
  const kind: OmniFetchKind = init?.kind ?? 'call'
  const internal = init?.internal === true
  const isRequestResponse = kind === 'call' || kind === 'long'
  const isCurrentBase = host.isRequestTargetCurrentBaseUrl(url)

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
      ? (OmniService as any).PROBE_DEFAULT_TIMEOUT_MS
      : kind === 'call'
        ? (OmniService as any).CALL_DEFAULT_TIMEOUT_MS
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
    host.inflightCount++
  }

  try {
    const res = await fetch(url, {
      ...restInit,
      ...(effectiveSignal ? { signal: effectiveSignal } : {}),
      dispatcher: host.omniDispatcher
    } as RequestInit)

    if (isCurrentBase) {
      if (res.ok) {
        const headerInstanceId =
          res.headers?.get?.('x-omni-instance-id') ??
          res.headers?.get?.('X-Omni-Instance-Id') ??
          null
        if (headerInstanceId) {
          if (
            host.expectedIdentity?.instanceId &&
            host.expectedIdentity.instanceId !== headerInstanceId
          ) {
            host.invalidateAdoptedIdentity(
              `X-Omni-Instance-Id 不匹配: expected=${host.expectedIdentity.instanceId}, actual=${headerInstanceId}`
            )
          } else {
            host.lastVerifiedAtMs = Date.now()
            host.unhealthySince = null
            host.lastFailureAt = null
          }
        } else {
          // 旧版 Omni 缺失响应头时维持既有 30s TTL，仅首次告警
          if (host.expectedIdentity?.instanceId && !host.missingInstanceIdHeaderWarned) {
            host.missingInstanceIdHeaderWarned = true
            logger.warn(
              LogCategory.SYSTEM,
              '[OmniService] 收到缺少 X-Omni-Instance-Id 响应头的 2xx 响应（疑似旧版 Omni），维持 30s TTL 校验'
            )
          }
          host.unhealthySince = null
          host.lastFailureAt = null
        }
      } else if (res.status >= 500 && !internal && (kind === 'probe' || kind === 'call')) {
        host.recordManagedUnhealthyFailure(isRequestResponse)
      }
    }

    return res
  } catch (err: unknown) {
    if (isCurrentBase) {
      if (host.process === null && isConnectionRefusedError(err)) {
        host.invalidateAdoptedIdentity('ECONNREFUSED')
      }
      if (!internal && (kind === 'probe' || kind === 'call') && !callerSignal?.aborted) {
        const errName = (err as any)?.name
        const isTimeoutOrReset =
          errName === 'TimeoutError' || errName === 'AbortError' || isTransientStatusFetchError(err)
        if (isTimeoutOrReset) {
          host.recordManagedUnhealthyFailure(isRequestResponse)
        }
      }
    }
    throw err
  } finally {
    if (isRequestResponse) {
      host.inflightCount = Math.max(0, host.inflightCount - 1)
    }
  }
}
