/**
 * OmniService DirectML 崩溃标记与密钥代际不匹配处理
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
  OmniService,
  type VerifyInstanceResult,
  type OmniFetchOptions,
  type OmniFetchKind,
  type LaunchContext
} from './omni-service'

/** 解析并缓存 DirectML 崩溃标记文件路径（与主库同级；dbPath 未知时沿用上次缓存）。 */
export function omniDmlResolveDmlCrashMarker(
  host: any,
  dbPath: string | null | undefined
): string | null {
  if (dbPath) {
    host.dmlCrashMarkerPath = path.join(path.dirname(dbPath), '.omni-dml-crash.json')
  }
  return host.dmlCrashMarkerPath
}

export function omniDmlReadTextFileSafe(host: any, file: string): string | null {
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
export function omniDmlPersistDmlCrash(host: any, marker: string | null, exitCode = 0): void {
  host.forceCpuForNextStarts = true
  if (!marker) return
  try {
    const prevRaw = host.readTextFileSafe(marker)
    const nextMarker = computeNextDmlCrashMarker(prevRaw, Date.now(), exitCode)
    fs.writeFileSync(marker, serializeDmlCrashMarker(nextMarker), 'utf8')
  } catch (err) {
    logger.warn(LogCategory.SYSTEM, '[OmniService] 写入 DirectML 崩溃标记失败:', err)
  }
}

/**
 * 拦截处理 Omni KeyEpoch 失配，触发前端大白话 UX 提示与系统通知 (Ticket 07)
 */
export function omniDmlHandleKeyEpochMismatch(host: any, detail: string): void {
  if (host.isKeyEpochMismatchPrompted) return
  host.isKeyEpochMismatchPrompted = true

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
