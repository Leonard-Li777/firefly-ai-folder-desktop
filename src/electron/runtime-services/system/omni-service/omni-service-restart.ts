/**
 * OmniService 重启与指数退避调度逻辑
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

/**
 * 优雅热重启 Omni 服务（档位变更、插件拓扑变化或异常恢复）
 */
export async function omniRestartRestart(host: any): Promise<boolean> {
  logger.info(LogCategory.SYSTEM, '[OmniService] 正在优雅重启 Omni 服务进程...')
  const pendingStart = host.startPromise
  await host.stop()
  if (pendingStart) {
    try {
      await pendingStart
    } catch {}
  }
  await host.waitForPortReleased(3000)
  return await host.start()
}

/**
 * 指数退避自愈重启
 */
export async function omniRestartScheduleRestart(host: any): Promise<void> {
  if (host.isIntentionalStopping) {
    return
  }
  if (await host.checkHealth()) {
    logger.info(LogCategory.SYSTEM, '[OmniService] Omni 服务已在运行，跳过重启')
    host.restartAttempts = 0
    return
  }

  if (host.restartAttempts >= host.maxRestartAttempts) {
    logger.error(
      LogCategory.SYSTEM,
      `[OmniService] 已达到最大重启重试次数 (${host.maxRestartAttempts})，停止自动重启`
    )
    return
  }

  const delay = Math.min(1000 * Math.pow(2, host.restartAttempts), 15000)
  host.restartAttempts++
  logger.debug(
    LogCategory.SYSTEM,
    `[OmniService] 安排在 ${delay}ms 后尝试重启 Omni 服务 (第 ${host.restartAttempts} 次)...`
  )

  host.restartTimeout = setTimeout(() => {
    host.start().catch((err: unknown) => {
      logger.error(LogCategory.SYSTEM, '[OmniService] 自动重启失败:', err)
    })
  }, delay)
}

/**
 * 等待当前服务端口彻底释放（避免旧进程尚未完全退出时被误判为已存在而假活）
 */
export async function omniRestartWaitForPortReleased(
  host: any,
  limitMs: number = 3000
): Promise<boolean> {
  const tStart = Date.now()
  while (Date.now() - tStart < limitMs) {
    const alive = await host.checkHealth().catch(() => false)
    if (!alive) {
      return true
    }
    await new Promise(r => setTimeout(r, 100))
  }
  return !(await host.checkHealth().catch(() => false))
}
