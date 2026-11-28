/**
 * OmniService 媒体元数据抽取、封面生成与音视频感知客户端方法
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
 * 提取文件全量信息 (元数据, Magika, Markdown, EXIF, 音视频标签)
 */
export async function omniMediaExtract(
  host: any,
  filePath: string,
  options?: OmniExtractOptions
): Promise<OmniExtractionResponse | null> {
  await host.ensureRunning()
  const tStart = Date.now()
  // 逐请求覆盖字段经 POST /api/extract 下沉至 Rust ExtractRequest，杜绝回退通道丢失工作区参数。
  const reqBody = buildExtractRequestBody(filePath, options)
  logger.debug(
    LogCategory.SYSTEM,
    `[OmniService] >>> POST /api/extract 请求发起:`,
    JSON.stringify(reqBody)
  )

  const doFetch = async () => {
    const res = await host.omniFetch(`${host.baseUrl}/api/extract`, {
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
    if (!host.shouldRestartAfterFetchError(err)) {
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
    const restarted = await host.start()
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
export async function omniMediaExtractMetadataFull(
  host: any,
  filePath: string
): Promise<Record<string, any>> {
  const extResult = await host.extract(filePath)
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
export async function omniMediaReverseGeo(
  host: any,
  pointsOrLat: OmniGeoReversePoint[] | number,
  lonOrLang?: number | string,
  optionalLang?: string
): Promise<OmniGeoReverseResponse | null> {
  await host.ensureRunning()
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
      const res = await host.omniFetch(`${host.baseUrl}/api/geo/reverse`, {
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
      if (host.shouldRestartAfterFetchError(fetchErr)) {
        const restarted = await host.start()
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
export async function omniMediaIdentifyMagika(
  host: any,
  filePath: string
): Promise<MagikaFileCategory | null> {
  const ext = path.extname(filePath).toLowerCase().replace('.', '')
  const extList = ext ? [ext] : []

  const extResult = await host.extract(filePath)
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
export async function omniMediaGetFileCover(
  host: any,
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

  await host.ensureRunning()
  const tStart = Date.now()
  // [V12-E06] Office 封面逐请求透传：false/true 均按请求写入 query，绝不丢失用户显式关闭意图。
  const url = buildCoverUrl(host.baseUrl, filePath, options)
  logger.debug(LogCategory.SYSTEM, `[OmniService] >>> GET /api/cover 请求发起 (${filePath})`)

  const doFetch = async () => {
    // Office 转换 (LibreOffice) 或复杂视频截帧可能需要一定冷启动时间，提供充足的 60 秒等待时间
    const res = await host.omniFetch(url, {
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
    host.lastCoverDurationMs = durationMs
    host.coverDurationMap.set(path.resolve(filePath), durationMs)
    logger.debug(
      LogCategory.SYSTEM,
      `[OmniService] <<< GET /api/cover 响应成功 (${filePath}, 字节大小: ${buffer.length} B, 耗时: ${durationMs}ms)`
    )
    return buffer
  }

  try {
    return await doFetch()
  } catch (err: any) {
    if (!host.shouldRestartAfterFetchError(err)) {
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
    const restarted = await host.start()
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
 * 兼容别名：获取 PDF 封面图
 */
export async function omniMediaGetPdfCover(host: any, filePath: string): Promise<Buffer | null> {
  return host.getFileCover(filePath)
}

/**
 * 原生多模态感知 (单点聚合: 元数据 + NTFS ADS + 频域水印/打码 + CLIP + SenseVoice ASR + 逆地理)
 * POST /api/perceive
 */
export async function omniMediaPerceive(
  host: any,
  filePath: string,
  options?: OmniPerceptionOptions
): Promise<OmniPerceptionResponse | null> {
  await host.ensureRunning()
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
    <T>(key: string) => host.getConfigValue(key)
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
    const res = await host.omniFetch(`${host.baseUrl}/api/perceive`, {
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
      throw await host.parsePerceptionHttpError(res, 'POST /api/perceive', Date.now() - tStart)
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
    if (!host.shouldRestartAfterFetchError(err, options?.signal?.aborted === true)) {
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
    const restarted = await host.start()
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
export async function omniMediaTranscribeAudio(
  host: any,
  filePath: string,
  options?: { language?: string; timeoutMs?: number; signal?: AbortSignal }
): Promise<OmniAudioTranscribeResponse | null> {
  await host.ensureRunning()
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
    const res = await host.omniFetch(`${host.baseUrl}/api/audio/transcribe`, {
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
    if (!host.shouldRestartAfterFetchError(err, options?.signal?.aborted === true)) {
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
 * 单指标：转换标准音频并降噪 (16kHz, mono, pcm_s16le WAV)
 * POST /api/audio/convert
 */
export async function omniMediaConvertToStandardAudio(
  host: any,
  filePath: string,
  durationSeconds?: number,
  timeoutMs: number = 60000
): Promise<OmniAudioConvertResponse | null> {
  await host.ensureRunning()
  const tStart = Date.now()
  const reqBody = {
    file_path: filePath,
    duration_seconds: durationSeconds
  }

  const doFetch = async () => {
    const res = await host.omniFetch(`${host.baseUrl}/api/audio/convert`, {
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
 * 统一解析 Omni 感知/视觉接口非 2xx 响应为强类型 `OmniPerceptionHttpError`
 */
export async function omniMediaParsePerceptionHttpError(
  host: any,
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
