/**
 * OmniService 视觉标签、检索聚类、文本向量化与冒烟测试客户端方法
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
 * 单指标：提取视觉标签 (CLIP 图像特征向量)
 * POST /api/vision/tags
 */
export async function omniAiExtractVisualTags(
  host: any,
  filePath: string,
  options?: { language?: string; topK?: number; timeoutMs?: number }
): Promise<string[] | null> {
  await host.ensureRunning()
  const reqBody = {
    file_path: filePath,
    language: options?.language,
    top_k: options?.topK
  }
  const timeoutMs = options?.timeoutMs || 30000

  const doFetch = async () => {
    const res = await host.omniFetch(`${host.baseUrl}/api/vision/tags`, {
      kind: 'call',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(reqBody),
      timeoutMs
    })
    if (!res.ok) {
      throw await host.parsePerceptionHttpError(res, 'POST /api/vision/tags')
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
    if (!host.shouldRestartAfterFetchError(err)) {
      return null
    }
    const restarted = await host.start()
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
export async function omniAiInspectVision(
  host: any,
  filePath: string,
  timeoutMs: number = 10000
): Promise<OmniVisionInspectResponse | null> {
  await host.ensureRunning()
  const reqBody = { file_path: filePath }

  const doFetch = async () => {
    const res = await host.omniFetch(`${host.baseUrl}/api/vision/inspect`, {
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
    logger.debug(LogCategory.SYSTEM, `[OmniService] inspectVision 异常 (${filePath}):`, err.message)
    if (!host.shouldRestartAfterFetchError(err)) {
      return null
    }
    const restarted = await host.start()
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
export async function omniAiInspectAds(
  host: any,
  filePath: string,
  timeoutMs: number = 5000
): Promise<OmniFsAdsResponse | null> {
  await host.ensureRunning()
  const reqBody = { file_path: filePath }

  const doFetch = async () => {
    const res = await host.omniFetch(`${host.baseUrl}/api/fs/ads`, {
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
    if (!host.shouldRestartAfterFetchError(err)) {
      return null
    }
    const restarted = await host.start()
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
export async function omniAiIndexDocuments(
  host: any,
  documents: OmniIndexedDocument[],
  timeoutMs: number = 30000
): Promise<OmniIndexResponse | null> {
  await host.ensureRunning()
  const doFetch = async () => {
    const res = await host.omniFetch(`${host.baseUrl}/api/search/index`, {
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
    if (!host.shouldRestartAfterFetchError(err)) {
      return null
    }
    const restarted = await host.start()
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
export async function omniAiSearchHybrid(
  host: any,
  options: {
    queryText?: string
    queryEmbedding?: number[]
    topK?: number
  },
  timeoutMs: number = 10000
): Promise<OmniHybridSearchResponse | null> {
  await host.ensureRunning()
  const doFetch = async () => {
    const res = await host.omniFetch(`${host.baseUrl}/api/search/hybrid`, {
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
    if (!host.shouldRestartAfterFetchError(err)) {
      return null
    }
    const restarted = await host.start()
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
export async function omniAiClusterDocuments(
  host: any,
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
    if (!host.isReady()) {
      return null
    }
  } else {
    await host.ensureRunning()
  }
  const doFetch = async () => {
    const res = await host.omniFetch(`${host.baseUrl}/api/search/cluster`, {
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
export async function omniAiDescribeHowNet(
  host: any,
  word: string,
  timeoutMs: number = 5000
): Promise<OmniHowNetDescribeResult | null> {
  await host.ensureRunning()
  const reqBody = { word }

  const doFetch = async () => {
    const res = await host.omniFetch(`${host.baseUrl}/api/hownet/describe`, {
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
    if (!host.shouldRestartAfterFetchError(err)) {
      return null
    }
    const restarted = await host.start()
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
export async function omniAiGetEmbeddingProfile(
  host: any
): Promise<'classic_light' | 'gemma_unified'> {
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
export async function omniAiAnalyzeText(
  host: any,
  text: string,
  options?: { fileName?: string; mtime?: string },
  timeoutMs: number = 10000
): Promise<OmniTextAnalysisResult | null> {
  await host.ensureRunning()
  const reqBody = {
    text,
    fileName: options?.fileName,
    mtime: options?.mtime
  }

  const doFetch = async () => {
    const res = await host.omniFetch(`${host.baseUrl}/api/text/analyze`, {
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
    if (!host.shouldRestartAfterFetchError(err)) {
      return null
    }
    const restarted = await host.start()
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
export async function omniAiAssertNsfw(
  host: any,
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
  await host.ensureRunning()
  try {
    const res = await host.omniFetch(`${host.baseUrl}/api/text/nsfw`, {
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
export async function omniAiResolveTaxonomyParent(
  host: any,
  params: {
    tagName: string
    language?: string
    contextHint?: string
  },
  timeoutMs: number = 300
): Promise<OmniResolveParentResponse | null> {
  await host.ensureRunning()
  const reqBody: OmniResolveParentRequest = {
    tag_name: params.tagName,
    language: params.language,
    context_hint: params.contextHint
  }

  try {
    const res = await host.omniFetch(`${host.baseUrl}/api/taxonomy/resolve-parent`, {
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
export async function omniAiInspectControlledTags(
  host: any,
  items: InspectControlledTagItem[],
  language: string = 'zh-CN',
  timeoutMs: number = 1500
): Promise<InspectControlledTagsResponse> {
  await host.ensureRunning()
  const reqBody = {
    items,
    language
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const res = await host.omniFetch(`${host.baseUrl}/api/v1/taxonomy/inspect-tag`, {
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
export async function omniAiResolveEmbeddingTarget(
  host: any,
  options?: {
    skipAutoStart?: boolean
  }
): Promise<{ profile: 'classic_light' | 'gemma_unified'; dim: number }> {
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
export async function omniAiBatchEmbedText(
  host: any,
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
    if (!host.isReady()) {
      const isHealthy = await host.checkHealth({ timeoutMs: 200, signal: options?.signal })
      if (!isHealthy) {
        throw new Error('engine_not_ready')
      }
    }
  } else {
    await host.ensureRunning()
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
    const res = await host.omniFetch(`${host.baseUrl}/api/v1/vector/batch-embed-text`, {
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
export async function omniAiRunSmokeTest(
  host: any,
  payload: {
    profile: 'classic_light' | 'gemma_unified'
    model_paths?: Record<string, string>
    test_tokens?: string[]
    timeoutMs?: number
  }
): Promise<{ success: boolean; latency_ms?: number; error?: string; errorCode?: string }> {
  try {
    await host.ensureRunning()
    // 端口就绪门禁：ensureRunning() 返回 ≠ HTTP 端口已监听。
    // 刚装完/冷启动时模型可能仍在加载，端口尚未监听；若立即探测会得到
    // fetch failed（连接拒绝）。这里先有界等待端口可达（默认最长 30s），
    // 仍未可达才判失败，给用户明确「引擎还没就绪」的语义而非裸连接错误。
    const portReady = await host.waitForEnginePortReady()
    if (!portReady) {
      // 返回结构化错误码，由前端 formatPluginErrorMessage 按码表转译为大白话，
      // 避免裸字符串里夹杂 API 等英文被全词匹配误判成网络错误。
      return {
        success: false,
        error: '引擎服务尚未就绪（等待引擎启动超时），请点击重试',
        errorCode: 'FAST_READY_TIMEOUT'
      }
    }
    const verify = await host.verifyMountManifestStatus()
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
    const testEmbed = await host.batchEmbedText(tokens, {
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
    logger.warn(LogCategory.SYSTEM, '[OmniService] runSmokeTest 异常:', err?.message || String(err))
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
