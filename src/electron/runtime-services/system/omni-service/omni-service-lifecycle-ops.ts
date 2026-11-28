/**
 * OmniService 生命周期健康检查、配置同步、视觉词表对账与强制停止逻辑
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

/**
 * 同步立即终结当前持有的 firefly-omni 进程树（仅用于 process.once('exit') / 信号强制退出）
 */
export function omniLifecycleStopImmediately(host: any): void {
  // 同步段第一步：先局部捕获 childPid 与 lastInstanceId，再清空状态
  const child = host.process
  const childPid = child?.pid
  const lastInstanceId =
    host.connectedTarget?.instanceId || host.expectedIdentity?.instanceId || undefined

  host.isIntentionalStopping = true
  host.isStarting = false
  if (host.currentLaunchCtx && host.currentLaunchCtx.child === child) {
    host.currentLaunchCtx.intentionalKill = true
  }
  ++host.stopEpoch
  ++host.connectionEpoch
  host.stopController.abort()
  host.unmountDiscoveryWatcher()
  host.eventStreamAbortController?.abort()
  host.reconnectAbortController?.abort()
  host.activeLoopEpoch = null
  host.cachedVersion = null
  host.connectedTarget = null
  host.expectedIdentity = null
  host.lastVerifiedAtMs = 0
  host.unhealthySince = null
  host.lastFailureAt = null
  host.lastStatusEvent = null

  const nextGen = ++host.currentGeneration
  host.emitLifecycleInactive(nextGen)

  if (host.restartTimeout) {
    clearTimeout(host.restartTimeout)
    host.restartTimeout = null
  }
  host.process = null
  host.forceKillProcessTree(child, 'stop_immediately_sync')

  if (childPid) {
    host.getDiscoveryFile()?.revokeSync({ pid: childPid, instanceId: lastInstanceId })
  }

  if (host.instanceLock) {
    host.instanceLock.release()
    host.instanceLock = null
  }
  if (host.tokenManager) {
    host.tokenManager.removeToken()
    host.tokenManager = null
  }
  const manifestPath = host.currentMountManifestPath
  host.currentMountManifestPath = null
  host.unlinkManifestSafe(manifestPath)
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
export async function omniLifecycleWaitForEnginePortReady(
  host: any,
  totalMs = 30_000,
  intervalMs = 500
): Promise<boolean> {
  const deadline = Date.now() + totalMs
  let lastErr = ''
  while (Date.now() < deadline) {
    try {
      // 用较短的单次超时探测端口是否监听；可达即返回，不等完整 2.5s
      const res = await host.omniFetch(`${host.baseUrl}/api/v1/engine/status`, {
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
export async function omniLifecycleReloadAssets(host: any): Promise<boolean> {
  if (!host.baseUrl) return false
  try {
    const res = await host.omniFetch(`${host.baseUrl}/api/v1/assets/reload`, {
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

export function omniLifecycleHandleStartupVisualVocabStatus(
  host: any,
  verifyRes: {
    visualVocabStatus?: string
    visualVocab?: VisualVocabStatusTelemetry
    statusData?: Record<string, any>
  }
): void {
  const vv =
    verifyRes.visualVocab ??
    (verifyRes.statusData?.visualVocab as VisualVocabStatusTelemetry | undefined)
  const status = verifyRes.visualVocabStatus ?? vv?.activeStatus
  if (!status || status === 'not_provisioned') {
    return
  }
  const activeEncoderId = typeof vv?.activeEncoderId === 'number' ? vv.activeEncoderId : undefined

  if (status === 'ok') {
    host.visualTaggerAvailable = true
    if (activeEncoderId !== undefined) {
      host.notifyVisualTaggerRecovered(activeEncoderId)
    }
    return
  }

  if (status === 'stale') {
    host.visualTaggerAvailable = false
    logger.warn(
      LogCategory.SYSTEM,
      '[OmniService] 启动核验发现视觉词表处于 stale 状态，保留进程并触发异步对账（纯文本服务不受影响）'
    )
    if (!host.startupVisualReconcileInFlight && activeEncoderId !== undefined) {
      host.startupVisualReconcileInFlight = true
      void host.triggerStartupVisualReconcile(activeEncoderId).finally(() => {
        host.startupVisualReconcileInFlight = false
      })
    }
    return
  }

  if (status === 'missing' || status === 'corrupt') {
    host.visualTaggerAvailable = false
    logger.warn(
      LogCategory.SYSTEM,
      `[OmniService] 启动核验发现视觉词表不可用 (${status})，仅标为视觉不可用，不阻断纯文本检索服务`
    )
  }
}

export async function omniLifecycleTriggerStartupVisualReconcile(
  host: any,
  encoderId: number
): Promise<void> {
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
        host.visualTaggerAvailable = true
      }
    }
  } catch (err) {
    logger.warn(LogCategory.SYSTEM, '[OmniService] 启动期视觉词表异步对账异常:', err)
  }
}

/**
 * 服务健康探活
 */
export async function omniLifecycleCheckHealth(
  host: any,
  options?: {
    timeoutMs?: number
    signal?: AbortSignal
  }
): Promise<boolean> {
  try {
    const timeoutMs = options?.timeoutMs ?? 1000
    const res = await host.omniFetch(`${host.baseUrl}/health`, {
      kind: 'probe',
      timeoutMs,
      signal: options?.signal,
      internal: true
    })
    if (res.ok) {
      try {
        const data = await res.json()
        if (data && typeof data.version === 'string') {
          host.cachedVersion = data.version
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
export async function omniLifecycleSyncConfigFromDesktop(host: any): Promise<boolean> {
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

    const res = await host.omniFetch(`${host.baseUrl}/api/config`, {
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
export async function omniLifecycleUnloadSlot(host: any, slot: string): Promise<boolean> {
  logger.debug(LogCategory.SYSTEM, `[OmniService] 触发卸载插槽模型以释放句柄: ${slot}`)
  return host.syncConfigFromDesktop()
}

/**
 * 语言切换后通知 Omni 重载只读 SQLite 连接
 * POST /api/reconnect { dbPath } (ADR-0035 §8.4 双消费者热重连契约)
 */
export async function omniLifecycleReconnect(host: any, dbPath: string): Promise<boolean> {
  await host.ensureRunning()
  try {
    const res = await host.omniFetch(`${host.baseUrl}/api/reconnect`, {
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
