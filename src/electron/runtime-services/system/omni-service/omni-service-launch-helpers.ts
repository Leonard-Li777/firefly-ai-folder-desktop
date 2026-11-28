/**
 * OmniService 启动上下文、stderr 缓冲与强杀清理辅助函数
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

/** 创建 per-launch 不可变代际上下文 */
export function omniLaunchHelperCreateLaunchContext(
  host: any,
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
export function omniLaunchHelperAppendLaunchStderr(
  host: any,
  ctx: LaunchContext,
  rawChunk: string
): void {
  if (!rawChunk) return
  const combined = ctx.stderrPartial + rawChunk
  const parts = combined.split(/\r?\n/)
  ctx.stderrPartial = parts.pop() ?? ''
  for (const line of parts) {
    ctx.stderrLines.push(line)
    ctx.stderrBytes += Buffer.byteLength(line, 'utf8') + 1
  }
  while (
    ctx.stderrLines.length > (OmniService as any).STDERR_MAX_LINES ||
    ctx.stderrBytes > (OmniService as any).STDERR_MAX_BYTES
  ) {
    const removed = ctx.stderrLines.shift()
    if (removed === undefined) break
    ctx.stderrBytes = Math.max(0, ctx.stderrBytes - (Buffer.byteLength(removed, 'utf8') + 1))
  }
  // 防止单行无换行超长残段撑爆内存
  if (Buffer.byteLength(ctx.stderrPartial, 'utf8') > (OmniService as any).STDERR_MAX_BYTES) {
    ctx.stderrPartial = ctx.stderrPartial.slice(-2048)
  }
}

/** 读取 LaunchContext 合并后的 stderr 尾段（包含无换行尾段 stderrPartial） */
export function omniLaunchHelperGetLaunchStderrTail(host: any, ctx: LaunchContext): string {
  const lines = ctx.stderrPartial ? [...ctx.stderrLines, ctx.stderrPartial] : [...ctx.stderrLines]
  return lines.join('\n')
}

/** 等待上一代托管 LaunchContext 管道排空关闭（有界 2000ms，超时促发 stderr 排空） */
export async function omniLaunchHelperAwaitLaunchContextClose(
  host: any,
  ctx: LaunchContext | null
): Promise<void> {
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
export function omniLaunchHelperForceKillProcessTree(
  host: any,
  child: ChildProcess | null,
  reason = 'force_kill'
): void {
  if (!child) return
  const pid = child.pid
  if (host.currentLaunchCtx && host.currentLaunchCtx.child === child) {
    host.currentLaunchCtx.intentionalKill = true
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
export function omniLaunchHelperUnlinkManifestSafe(
  host: any,
  manifestPath: string | null | undefined
): void {
  if (!manifestPath) return
  try {
    if (fs.existsSync(manifestPath)) {
      fs.unlinkSync(manifestPath)
    }
  } catch {}
}
