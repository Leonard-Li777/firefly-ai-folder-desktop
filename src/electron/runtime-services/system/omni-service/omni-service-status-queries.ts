/**
 * OmniService 版本查询、就绪判定与 ensureRunning 入口逻辑
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
 * 获取 Omni 引擎版本号
 */
export async function omniStatusQueryGetVersion(host: any): Promise<string> {
  if (host.cachedVersion) {
    return host.cachedVersion
  }
  try {
    await host.ensureRunning()
    const res = await host.omniFetch(`${host.baseUrl}/api/version`, {
      kind: 'probe',
      timeoutMs: 2000
    })
    if (res.ok) {
      const data = await res.json()
      if (data && typeof data.version === 'string') {
        host.cachedVersion = data.version
        return data.version
      }
    }
  } catch {}
  return host.cachedVersion || '0.1.0'
}

/**
 * 同步判定 Omni 服务是否已处于就绪运行态（纯同步布尔谓词，无异步阻塞开销）：
 * ① 托管活体（含 signalCode === null）
 * ② 采纳复用活体（instanceId 有效且 30s TTL 未过期；过期同步返回 false，由 ensureRunning 慢路径单飞刷新）
 */
export function omniStatusQueryIsReady(host: any): boolean {
  if (host.isStarting || host.isIntentionalStopping) {
    return false
  }
  const hasIdentityMark = host.cachedVersion !== null || host.connectedTarget !== null
  if (!hasIdentityMark) {
    return false
  }
  if (host.process !== null) {
    return (
      host.process.exitCode === null && host.process.signalCode === null && !host.process.killed
    )
  }
  return (
    typeof host.expectedIdentity?.instanceId === 'string' &&
    host.expectedIdentity.instanceId.length > 0 &&
    host.lastVerifiedAtMs > 0 &&
    Date.now() - host.lastVerifiedAtMs < (OmniService as any).REUSE_READY_TTL_MS
  )
}

/**
 * 检查 Omni 服务是否处于运行状态（isReady 的友好别名）
 */
export function omniStatusQueryIsServiceRunning(host: any): boolean {
  return host.isReady()
}

/**
 * 确保 Omni 服务处于运行与就绪状态（停机早退 + O(1) 存活快路径 + 单飞同源刷新 + 按需拉起）
 */
export async function omniStatusQueryEnsureRunning(host: any): Promise<boolean> {
  if (host.isIntentionalStopping) {
    return false
  }
  if (host.isReady()) {
    return true
  }
  if (host.startPromise) {
    return host.startPromise
  }
  if (host.hasLiveManagedProcess()) {
    if (await host.checkHealth()) {
      return true
    }
  } else if (host.expectedIdentity) {
    if (await host.verifyAdoptedReuseOnce()) {
      return true
    }
  }
  if (host.isIntentionalStopping) {
    return false
  }
  return host.start()
}
