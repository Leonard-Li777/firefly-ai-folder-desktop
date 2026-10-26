/**
 * Omni Native Service - Omni Rust 原生微服务管理器
 * apps/desktop/src/electron/runtime-services/system/omni-service.ts
 *
 * 核心职责：
 * 1. 负责 firefly-omni.exe 原生二进制子进程的拉起、常驻守护与健康探活
 * 2. 进程崩溃自动重启 (带指数退避) 与应用退出时的协同销毁
 * 3. 封装统一的 HTTP Client，对接 /api/extract, /api/cleanup/scan, /api/geo/reverse
 */

import { ChildProcess, spawn } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { app, BrowserWindow } from 'electron'
import { ResourceLocator, logger, LogCategory, APP_PORTS, findAvailablePort } from '@firefly/shared'
import { MagikaFileCategory } from '@firefly/types'
import { resolveAnalysisTimeoutBudget } from './analysis-timeout-policy'

/**
 * 基础AI引擎（Omni）运行状态快照，主动推送至渲染进程（omni:status-changed）
 */
export interface OmniRuntimeStatus {
  /** 进程探活是否成功 */
  running: boolean
  /** 引擎版本号（探活成功时返回） */
  version: string | null
}

/**
 * 向所有渲染窗口广播基础AI引擎（Omni）状态变更
 * 由状态跃迁点（启动就绪/退出/停止）主动调用，渲染进程无需轮询
 */
export function broadcastOmniStatus(status: OmniRuntimeStatus): void {
  try {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('omni:status-changed', status)
      }
    }
  } catch {}
}

export interface OmniBenchmarkResponse {
  total_ms: number
  magika_ms?: number
  metadata_ms?: number
  tag_ms?: number
  text_ms?: number
  document_ms?: number
  ocr_ms?: number
  html_ms?: number
  thumbnail_ms?: number
  clip_ms?: number
  clip_embed_ms?: number
  clip_mutual_ms?: number
  ram_ms?: number
  nsfw_ms?: number
  text_detect_ms?: number
  watermark_ms?: number
  mosaic_ms?: number
  aesthetic_ms?: number
  bw_ms?: number
  doc_parse_ms?: number
  bekko_embed_ms?: number
  keybert_ms?: number
  slot_summary_ms?: number
  fusion_ms?: number
  [subtask_ms: `${string}_ms`]: number | undefined
}

export interface OmniExtractionResponse {
  file_path: string
  mime_type: string
  file_size: number
  markdown_content?: string
  metadata?: Record<string, any>
  phash?: string
  is_corrupted?: boolean
  benchmark?: OmniBenchmarkResponse
}

export type OmniGeoReversePoint =
  | { latitude: number; longitude: number }
  | { lat: number; lon: number }

export interface OmniGeoReverseItem {
  found: boolean
  country?: string
  province?: string
  admin1?: string
  admin2?: string
  city?: string
  distanceKm?: number
  formattedAddress?: string
}

export interface OmniGeoReverseResponse {
  available: boolean
  datasetVersion?: number
  reason?: string
  results?: OmniGeoReverseItem[]
}

export interface OmniPerceptionOptions {
  language?: string
  enableVisualTags?: boolean
  enableAudioTranscript?: boolean
  enableGeoReverse?: boolean
  enableTextAnalysis?: boolean
  maxContentSizeKb?: number
  audioAnalysisDuration?: number
  timeoutMs?: number
  /** 是否需要生成缩略图/封面（若已有则传 false，不要求生成） */
  generateThumbnail?: boolean
  enableCover?: boolean
  /** 视频内容定位精度（抽帧间隔秒数），默认 5.0，精细模式可设为 1.0 */
  videoFrameIntervalSeconds?: number
  /** 视频画面精细度（每帧视觉软 token 预算，140=标准精细，70=精简快速），默认 140 */
  videoSoftTokenBudget?: number
  /** 文件指纹，用于感知完成后在 Omni 内部就地批量落盘向量（Ticket 02 / 04） */
  fileFingerprint?: string
}

export interface OmniPerceptionBenchmarkResponse {
  total_ms: number
  extract_ms?: number
  ads_ms?: number
  vision_ms?: number
  audio_ms?: number
  geo_ms?: number

  // 细分任务独立耗时
  magika_ms?: number
  metadata_ms?: number
  tag_ms?: number
  text_ms?: number
  ocr_ms?: number
  text_detect_ms?: number
  clip_ms?: number
  clip_embed_ms?: number
  clip_mutual_ms?: number
  nsfw_ms?: number
  watermark_ms?: number
  mosaic_ms?: number
  aesthetic_ms?: number
  bw_ms?: number
  ram_ms?: number
  doc_parse_ms?: number
  bekko_embed_ms?: number
  keybert_ms?: number
  slot_summary_ms?: number
  fusion_ms?: number
  [subtask_ms: `${string}_ms`]: number | undefined
}

export interface OmniTagChainItem {
  code: string
  name: string
  confidence: number
  tag?: string
  /** 本次标注实际经由的消歧父级 code（概念 B，ADR-0047） */
  via_parent_code?: string
  viaParentCode?: string
  parent_codes?: string[]
  /** 打标引擎来源 (WP2a): clip | ram | physical | mutual_group | ocr | nsfw | quality | rule | metadata */
  engine?: string
  code_path?: string
  codePath?: string
  name_path?: string
  namePath?: string
  depth?: number
}

export interface OmniResolveParentRequest {
  tag_name: string
  language?: string
  context_hint?: string
}

export interface OmniResolveParentResponse {
  success: boolean
  parent_code: string
  /** 经由父级 code 兼容别名 (ADR-0047) */
  via_parent_code?: string
  viaParentCode?: string
  parent_name: string
  confidence: number
}

export type OmniRamTagItem = OmniTagChainItem

export interface BinaryAnalysisInfo {
  format: string
  architecture: string
  product_name?: string
  company_name?: string
  file_description?: string
  file_version?: string
  legal_copyright?: string
  signer_organization?: string
  detected_framework_code?: string
  capability_codes: string[]
  category_code?: string
  confidence_score: number
}

export interface OmniPerceptionResponse {
  file_path: string
  mime_type: string
  file_size: number
  category?: string
  markdown_content: string
  ocr_text?: string
  metadata: Record<string, any>
  author?: string
  binary_info?: BinaryAnalysisInfo

  // 物理事实特征
  file_source?: string
  file_source_code?: string
  source_url?: string
  workflow_state?: string
  workflow_state_code?: string
  security_level?: string
  security_level_code?: string
  has_watermark?: boolean
  watermark_level?: number
  watermark_status?: string
  has_mosaic?: boolean
  mosaic_level?: number
  mosaic_status?: string
  has_text?: boolean
  aesthetic_score?: number
  quality_score?: number
  photo_type?: string
  quality_issues?: string[]

  // 多模态直出字段与各大引擎标签 (统一走标签链输出)
  visual_tags: OmniTagChainItem[]
  fused_tags?: OmniTagChainItem[]
  /**
   * 原生全文本/ASR标签直出 (Ticket 01/04)：
   * 由 Omni TextTagger 从文档全文或 ASR 语音转录中抽取的两层漏斗受控标签链。
   */
  text_tags?: OmniTagChainItem[]
  /**
   * 原生事实标签直出 (Task 2)：
   * 由 Omni 原生层从 ExifTool/音频/文档/图像元数据 + 下沉物理事实抽取的确定性标签链，
   * 置信度扁平统一 0.90（物理直读与规则推导同级），engine 统一为 "metadata"。
   * Desktop 端作为第一权威物理事实无损落库至 file_tags。
   */
  fact_tags?: OmniTagChainItem[]
  morphology_tags?: string[]
  clip_tags?: string[]
  nsfw_tags?: string[]
  nsfw_text_tags?: string[]
  ram_tags?: string[]
  morphology_high_confidence_tags?: string[]
  clip_high_confidence_tags?: string[]
  nsfw_high_confidence_tags?: string[]
  sensitive_types?: string[]
  content_rating?: string
  /** ASR 语音转录文本（Issue 0046 §1：替代旧 `audio_transcript` 命名） */
  asr?: string
  /** 是否存在有效 ASR 转录文本 */
  has_asr?: boolean
  /** ASR 转录文本字符长度 */
  asr_length?: number
  lrc?: string
  audio_events: string[]
  geo_address?: string

  // 级联提示词合成与语义仲裁终局结果
  candidate_hypotheses?: Array<{
    id: string
    prompt_text: string
    confidence: number
    is_winner: boolean
    slots: Record<string, any>
    bound_tags: OmniTagChainItem[]
  }>
  winning_hypothesis?: {
    prompt_text: string
    confidence: number
  }
  activated_dimension_tags?: OmniTagChainItem[]
  smart_name?: string
  content_description?: string
  pruned_ambiguous_words?: string[]

  // Tier 1 端侧纯 CPU 确定性文本特征与 384 维向量 (支柱 4, Issue #631)
  title?: string | null
  keywords?: string[]
  entities?: Array<Record<string, any>>
  structured_summary?: OmniStructuredSummary
  one_sentence_desc?: string | null
  name_slots?: Record<string, any>
  embedding_dense?: number[]
  /**
   * 主向量 `embedding_dense` 的编码器出处（zvec v3 encoder_id：
   * 0=Unknown/Legacy, 1=Bekko, 2=ChineseCLIP, 3=MobileCLIP, 4=Gemma）。
   * 由 Omni 文本/视觉编码层给出，Desktop 原样透传，禁止按档位或语言猜测。
   */
  embedding_encoder_id?: number

  /** 视频时序切片集合（30 秒窗口切片） */
  video_chunks?: OmniVideoChunkItem[]
  /**
   * 本次视频分析实际生效的采样间隔（秒）
   *
   * 抽帧间隔已不由用户配置，由引擎按 120s 单文件预算自决。落库
   * `file_video_chunks.sampling_interval_seconds` 必须用它，禁止再用配置值代替。
   */
  video_sampling_interval_seconds?: number
  /**
   * 视频实际分析的时长（秒）
   * 未截断时为视频总时长，触发截断/看门狗时为实际分析覆盖的片长。
   */
  video_analysis_duration_sec?: number
  /**
   * 视频分析是否被截断（因超出单文件时间预算或动态看门狗熔断）
   */
  video_truncated?: boolean
  /** 是否已在 Omni 内部就地完成批量向量持久化（Ticket 02 / 04） */
  vector_saved?: boolean
  /** 视频代表帧封面 Base64 编码 WebP 格式（Ticket 03/05） */
  cover_webp_base64?: string | null

  phash?: string
  is_corrupted: boolean
  benchmark?: OmniPerceptionBenchmarkResponse
}

export interface OmniVideoChunkItem {
  chunk_index: number
  start_sec: number
  end_sec: number
  rep_pts_sec?: number
  meta?: Record<string, any>
  vector: number[]
  /** 切片向量的编码器出处（zvec v3 encoder_id），由 Omni 视觉层给出并原样透传 */
  encoder_id?: number
  asr_text?: string
}

export interface OmniAudioTranscribeResponse {
  file_path: string
  transcript?: string
  events: string[]
  language?: string
  duration_ms: number
}

export interface OmniAudioConvertResponse {
  file_path: string
  output_path: string
  duration_seconds: number
  duration_ms: number
}

export interface OmniVisionTagsResponse {
  file_path: string
  tags: string[]
  duration_ms: number
}

export interface OmniVisionInspectResponse {
  file_path: string
  has_watermark: boolean
  watermark_level?: number
  watermark_status: string
  has_mosaic: boolean
  mosaic_level?: number
  mosaic_status: string
  duration_ms: number
}

export interface OmniFsAdsResponse {
  file_path: string
  file_source?: string
  file_source_code?: string
  source_url?: string
  duration_ms: number
}

export interface OmniIndexedDocument {
  fingerprint: string
  embedding: number[]
  searchableText: string
}

export interface OmniIndexResponse {
  success: boolean
  totalIndexed: number
  error?: string
}

export interface OmniFusedResult {
  fingerprint: string
  rrfScore: number
  finalScore: number
  denseRank?: number
  bm25Rank?: number
}

export interface OmniHybridSearchResponse {
  success: boolean
  results: OmniFusedResult[]
  error?: string
}

export interface OmniClusterDocument {
  fingerprint: string
  embedding: number[]
  keywords: string[]
  /** 送嵌入引擎的富文本（智能命名/文件名 + 准入关键词），供 zvec 未命中时 JIT 即时编码 */
  embeddingText?: string
  /** 阶段二固化的 canonical 语义文本（工单 08：JIT 兜底的首选输入源，严禁回写 zvec） */
  canonicalText?: string
  /** 正文不含可见语义文本时，本次聚类改用 embeddingText 编码；JIT 向量仅服务当次 HAC 距离矩阵，严禁回写检索槽位 */
  preferEmbeddingText?: boolean
  /** 受控文件分类（如 'application' | 'media' | 'document' | 'other'），用于跨模态互斥门禁 */
  fileCategory?: string
}

export interface OmniClusterGroup {
  fingerprints: string[]
  folderName: string
  path: string[]
}

export interface OmniClusterTreeResult {
  clusters: OmniClusterGroup[]
  unclassifiedFiles?: string[]
  otherFiles?: string[]
  durationMs: number
}

export interface OmniClusterResponse {
  success: boolean
  result?: OmniClusterTreeResult
  error?: string
}

export interface OmniHowNetSlot {
  role: string
  target: string
  confidence: number
}

export interface OmniHowNetDescribeResult {
  word: string
  found: boolean
  is_aligned: boolean
  alignment_level?: string
  top_concept?: string
  slots: OmniHowNetSlot[]
  synonyms: string[]
  antonyms: string[]
  description: string
}

export interface OmniExtractedEntity {
  entity_type: string
  value: string
  confidence: number
  source: string
  hownet_role?: string
}

export interface OmniStructuredSummary {
  who?: string
  when?: string
  where?: string
  what?: string
  why?: string
  how?: string
}

export interface OmniDocumentChunk {
  chunk_index: number
  text: string
  char_count: number
}

export interface OmniTextAnalysisResult {
  title: string | null
  language: string
  keywords: string[]
  entities: OmniExtractedEntity[]
  structured_summary: OmniStructuredSummary
  one_sentence_desc: string | null
  smart_name: string | null
  name_slots: Record<string, any>
  embedding_dense: number[]
  chunks: OmniDocumentChunk[]
  duration_ms: number
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
          this.stop()
        })
        app.on('before-quit', () => {
          this.stopDevBinaryWatch()
          this.stop()
        })
      }

      // 注册 Node.js 进程级退出事件（针对开发模式下 Ctrl+C 或终端被杀）
      const cleanExit = () => {
        this.stopDevBinaryWatch()
        this.stop()
      }
      process.once('exit', cleanExit)
      process.once('SIGINT', cleanExit)
      process.once('SIGTERM', cleanExit)

      // 开发模式下开机常驻监听 Omni 原生二进制热更新（感知 omni-build-to-desktop.js --watch 的重编译与部署）
      this.startDevBinaryWatch()
      if (process.platform === 'win32') {
        process.once('message', (msg: any) => {
          if (msg === 'shutdown') {
            this.stop()
          }
        })
      }

      // 监听 Desktop 端 OCR 与分析相关的 ConfigKey 变更，实时自动推送到 Omni
      import('../../config/config-orchestrator').then(({ ConfigOrchestrator }) => {
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
      }).catch(() => {})
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

  /**
   * 探活并主动推送当前状态至渲染进程（omni:status-changed）
   * 附带版本号缓存刷新，供 Footer 等展示基础AI引擎的启动/连接状态
   */
  private async pushStatus(): Promise<void> {
    const running = await this.checkHealth()
    let version: string | null = null
    if (running) {
      try {
        const v = await this.getVersion()
        version = v && v !== '0.1.0' ? v : null
      } catch {}
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
      const res = await fetch(`${this.baseUrl}/api/version`, {
        signal: AbortSignal.timeout(2000)
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
   * 同步判定 Omni 服务是否已处于就绪运行态（无异步阻塞开销，供实时交互/快速检索 fast-fail 判定）
   */
  public isReady(): boolean {
    return Boolean(this.process && !this.process.killed && !this.isStarting && this.cachedVersion !== null)
  }

  /**
   * 确保 Omni 服务处于运行与就绪状态（若未运行则自动按需拉起）
   */
  public async ensureRunning(): Promise<boolean> {
    if (await this.checkHealth()) {
      return true
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
  public startDevBinaryWatch(intervalMs: number = OmniService.DEV_BINARY_WATCH_INTERVAL_MS): void {
    const isDev = !app?.isPackaged || process.env.NODE_ENV !== 'production'
    if (this.devBinaryWatchTimer || !isDev) {
      return
    }
    this.devBinaryWatchTimer = setInterval(() => {
      void this.checkBinaryUpdated()
    }, intervalMs)
    this.devBinaryWatchTimer.unref?.()
    logger.info(
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
   * 定位 firefly-omni 可执行文件
   */
  public resolveOmniExecutable(): string | null {
    const isWin = process.platform === 'win32'
    const exeName = isWin ? 'firefly-omni.exe' : 'firefly-omni'
    const isDev = !app?.isPackaged || process.env.NODE_ENV !== 'production'
    const root = process.cwd()

    // 1. 生产或已部署环境：通过 ResourceLocator 检索
    const bin = ResourceLocator.resolveBin('omni/firefly-omni') || ResourceLocator.resolveBin('firefly-omni')
    if (bin && fs.existsSync(bin)) {
      return bin
    }

    // 2. 本地开发环境下，优先检索最新由 cargo 编译的 target/debug 或 target/release 原生二进制
    if (isDev) {
      const devCandidates = [
        path.join(root, 'apps', 'omni', 'target', 'debug', exeName),
        path.join(root, 'apps', 'omni', 'target', 'release', exeName),
      ]
      for (const cand of devCandidates) {
        if (fs.existsSync(cand)) {
          return cand
        }
      }
    }

    // 3. 多候选路径兜底检索
    const candidates = [
      path.join(root, 'apps', 'desktop', 'build', 'extraResources', 'bin', 'omni', exeName),
      path.join(root, 'apps', 'desktop', 'build', 'extraResources', 'bin', exeName),
      path.join(root, 'apps', 'omni', 'target', 'debug', exeName),
      path.join(root, 'apps', 'omni', 'target', 'release', exeName),
      path.join(root, 'build', 'extraResources', 'bin', 'omni', exeName)
    ]

    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        return cand
      }
    }

    return null
  }

  /**
   * 启动并守护 firefly-omni 子进程（支持并发 Promise 合并）
   */
  public async start(): Promise<boolean> {
    if (this.process && !this.process.killed) {
      if (await this.checkHealth()) {
        return true
      }
      if (this.isStarting && this.startPromise) {
        return this.startPromise
      }
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

  private async doStart(): Promise<boolean> {
    this.isStarting = true
    const exePath = this.resolveOmniExecutable()
    if (!exePath) {
      logger.warn(LogCategory.SYSTEM, '[OmniService] 未找到 firefly-omni 可执行二进制文件，跳过子进程托管')
      this.isStarting = false
      return false
    }

    try {
      // 探活检查：优先检查基准端口 38200 上是否已有外部或前序 Omni 服务正常响应，若有直接复用
      this.actualPort = this.basePort
      this.baseUrl = `http://127.0.0.1:${this.basePort}`
      process.env.OMNI_ACTUAL_PORT = String(this.basePort)

      const isAliveBase = await this.checkHealth()
      if (isAliveBase) {
        logger.info(LogCategory.SYSTEM, `[OmniService] 检测到已在 ${this.basePort} 运行的 Omni 服务 (${this.baseUrl})，直接连接复用，并同步最新配置`)
        this.restartAttempts = 0
        this.isStarting = false
        this.spawnedBinarySignature = this.binarySignature(exePath)
        this.lastSpawnedAt = Date.now()
        this.pendingUpdateSignature = null
        this.pendingUpdateSince = 0
        this.startDevBinaryWatch()
        this.syncConfigFromDesktop().catch(() => {})
        this.notifyReady()
        this.pushStatus().catch(() => {})
        return true
      }

      // 若基准端口未通且存在旧的未退出子进程，先执行安全清理（仅终止物理进程，不重置 isStarting 标记）
      if (this.process && !this.process.killed) {
        this.killCurrentProcess()
        await new Promise(r => setTimeout(r, 300))
      }
      this.isStarting = true

      // 寻找可用端口（支持冷门段 38200~38219 自动滑动）
      const port = await findAvailablePort(this.basePort, APP_PORTS.MAX_ATTEMPTS)
      this.actualPort = port
      this.baseUrl = `http://127.0.0.1:${port}`
      // 将实际端口写入环境变量，供 DuplicateDetectionService 等跨服务读取
      process.env.OMNI_ACTUAL_PORT = String(port)

      // 探活检查：如果该端口上已有外部 omni 服务正常响应，则直接复用
      const isAlive = await this.checkHealth()
      if (isAlive) {
        logger.info(LogCategory.SYSTEM, `[OmniService] 检测到已在 ${port} 运行的 Omni 服务 (${this.baseUrl})，直接连接复用，并同步最新配置`)
        this.restartAttempts = 0
        this.isStarting = false
        this.spawnedBinarySignature = this.binarySignature(exePath)
        this.lastSpawnedAt = Date.now()
        this.pendingUpdateSignature = null
        this.pendingUpdateSince = 0
        this.startDevBinaryWatch()
        this.syncConfigFromDesktop().catch(() => {})
        this.notifyReady()
        return true
      }

      logger.info(LogCategory.SYSTEM, `[OmniService] 正在拉起 firefly-omni 守护进程 (Port: ${port}): ${exePath}`)
      const isDevMode = !app?.isPackaged || process.env.NODE_ENV !== 'production'
      const binDir = path.dirname(exePath)
      const existingPath = process.env.PATH || ''
      const injectedPath = [binDir, existingPath].filter(Boolean).join(path.delimiter)

      const env: Record<string, string | undefined> = {
        ...process.env,
        PATH: injectedPath,
        OMNI_PORT: String(port),
        OMNI_DEV_MODE: isDevMode ? '1' : '0',
        RUST_LOG: process.env.RUST_LOG || (isDevMode ? 'info,omni_vision=info,omni_server=info,omni_text=info' : 'warn')
      }

      // 获取业务主库 SQLite 绝对路径与只读语义包路径，以两个独立参数透传给 Omni (ADR-0035 & ADR-0038)
      const { databaseService } = await import('../database/database-service')
      const dbPath = databaseService.getDbPath()

      const candidatePackPaths = [
        ResourceLocator.resolveResourcePath?.('semantic/semantic.pack'),
        ResourceLocator.resolveResourcePath?.('presetResources/semantic/semantic.pack'),
        path.join(process.cwd(), 'apps/desktop/build/extraResources/semantic/semantic.pack'),
        path.join(process.cwd(), 'apps/desktop/build/presetResources/semantic/semantic.pack')
      ]
      let packPath: string | null = null
      for (const cand of candidatePackPaths) {
        if (cand && fs.existsSync(cand)) {
          packPath = cand
          break
        }
      }

      // omni-geo 地理数据集解析（与语义包同构的显式下发）：
      // omni-server 的数据集发现链锚定在 exe 相对 <exe_dir>/../../build/extraResources/geo 与
      // 少数 cwd 候选上，而资源统一装配流水线（consume-preset-resources + desktop
      // setup-extra-resources）只产出 desktop 侧 extraResources/geo。开发态桌面以
      // target/debug/firefly-omni.exe 的相对链落空 ⇒ 地理子系统静默软不可用
      // （历史：geo-20260825 数据包已在本地但发现链够不着）。
      // 此处复刻 --pack-path 模式，经 OMNI_GEO_DATA_PATH 环境变量显式下发（discover.rs
      // 最高优先级即该环境变量）；解析不到则不下发，保持服务端原有发现链行为。
      const candidateGeoPaths = [
        ResourceLocator.resolveResourcePath?.('geo/geonames-compact.json'),
        path.join(process.cwd(), 'apps/desktop/build/extraResources/geo/geonames-compact.json'),
        path.join(process.cwd(), 'apps/omni/build/extraResources/geo/geonames-compact.json'),
        path.join(process.cwd(), 'build/extraResources/geo/geonames-compact.json')
      ]
      let geoPath: string | null = null
      for (const cand of candidateGeoPaths) {
        if (cand && fs.existsSync(cand)) {
          geoPath = cand
          break
        }
      }

      const spawnArgs = ['serve', '-a', `127.0.0.1:${port}`]
      if (dbPath) {
        spawnArgs.push('--db-path', dbPath)
        logger.info(LogCategory.SYSTEM, `[OmniService] 🎯 业务主库路径 (--db-path): ${dbPath}`)
        const vectorsDir = path.join(path.dirname(dbPath), 'vectors')
        spawnArgs.push('--vectors-path', vectorsDir)
        logger.info(LogCategory.SYSTEM, `[OmniService] 🎯 矢量数据隔离路径 (--vectors-path): ${vectorsDir}`)
      }
      if (packPath) {
        spawnArgs.push('--pack-path', packPath)
        logger.info(LogCategory.SYSTEM, `[OmniService] 🎯 语义包路径 (--pack-path): ${packPath}`)
      }
      if (geoPath) {
        env.OMNI_GEO_DATA_PATH = geoPath
        logger.info(LogCategory.SYSTEM, `[OmniService] 🌍 地理数据集路径 (OMNI_GEO_DATA_PATH): ${geoPath}`)
      } else {
        logger.warn(
          LogCategory.SYSTEM,
          '[OmniService] 未解析到 omni-geo 地理数据集（geo/geonames-compact.json），逆地理编码将以 available:false 软降级'
        )
      }
      env.OMNI_WATCH_STDIN = '1'

      // 注入当前激活的多模态嵌入画像档位 (classic_light | gemma_unified) 与 MRL 维度 (Spec §3.4.1)
      try {
        const { ConfigOrchestrator } = await import('../../config/config-orchestrator')
        const configOrch = ConfigOrchestrator?.getInstance?.()
        if (configOrch) {
          const embeddingProfile =
            configOrch.getValue<'classic_light' | 'gemma_unified'>(
              'AI_EMBEDDING_PROFILE'
            ) || 'classic_light'
          spawnArgs.push('--embedding-profile', embeddingProfile)
          logger.info(
            LogCategory.SYSTEM,
            `[OmniService] 🎯 嵌入画像档位 (--embedding-profile): ${embeddingProfile}`
          )

          const mrlDimension = configOrch.getValue<number>('EMBEDDING_MRL_DIMENSION') || 512
          spawnArgs.push('--mrl-dimension', String(mrlDimension))
          logger.info(
            LogCategory.SYSTEM,
            `[OmniService] 🎯 MRL 向量维度 (--mrl-dimension): ${mrlDimension}`
          )
        }
      } catch {}

      const child = spawn(exePath, spawnArgs, {
        cwd: binDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })

      // 立即记录当前拉起的二进制签名与拉起时间戳（启动 15s 冷静期保护，防启动中途被 checkBinaryUpdated 误杀）
      this.lastSpawnedAt = Date.now()
      this.spawnedBinarySignature = this.binarySignature(exePath)
      this.pendingUpdateSignature = null
      this.pendingUpdateSince = 0

      // 登记进全局精准进程回收器
      try {
        const { processReaper } = require('../../main/process-reaper')
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

      child.stdout?.on('data', data => {
        const str = stripAnsi(data).trim()
        if (str && !isCzkawkaDump(str)) {
          // 若子进程输出为 INFO 级别或包含多模态关键业务日志，以 info 输出至控制台；其余以 debug 输出
          const isInfoMsg = str.includes('INFO') || str.includes('[普遍语法造句') || str.includes('[双锚点融合') || str.includes('[OmniServer]') || str.includes('[prune_and_rank_tags]') || str.includes('[落选') || str.includes('[胜出')
          if (isInfoMsg) {
            logger.info(LogCategory.SYSTEM, `[Omni] ${str}`)
          } else {
            logger.debug(LogCategory.SYSTEM, `[Omni] ${str}`)
          }
        }
      })

      child.stderr?.on('data', data => {
        const str = stripAnsi(data).trim()
        if (str && !isCzkawkaDump(str)) {
          logger.warn(LogCategory.SYSTEM, `[Omni:err] ${str}`)
        }
      })

      child.on('error', err => {
        logger.error(LogCategory.SYSTEM, '[OmniService] 子进程启动失败:', err)
      })

      child.on('exit', async (code, signal) => {
        logger.warn(LogCategory.SYSTEM, `[OmniService] 子进程退出 (code=${code}, signal=${signal})`)
        try {
          const { processReaper } = require('../../main/process-reaper')
          processReaper.unregisterChild(child.pid)
        } catch {}
        if (this.process === child) {
          this.process = null
        }
        // 主动推送"未运行"状态至渲染进程（基础AI引擎 Footer 展示）
        this.pushStatus().catch(() => {})
        // 子进程退出后，先检测是否对应端口上已有服务接管，若健康则直接接入，不触发重启
        const aliveAfterExit = await this.checkHealth()
        if (aliveAfterExit) {
          logger.info(LogCategory.SYSTEM, `[OmniService] ${this.actualPort} 端口已有外部服务接管，直接连接`)
          this.restartAttempts = 0
          // 外部服务接管成功，推送"运行中"状态
          this.pushStatus().catch(() => {})
          return
        }
        this.scheduleRestart()
      })

      this.process = child

      // 等待服务就绪探活 (最多 200 次 * 200ms = 40秒，容纳 71.6 万条多语言别名冷启动解密热载与 SenseVoice/MOSS-TTS 模型加载时间)
      for (let i = 0; i < 200; i++) {
        // 关键防御：若子进程在探活期间提前退出或被终止，立即中止等待，拒绝僵尸死等 40s 阻塞系统
        // 物理事实守卫：仅当子进程真正退出 (exitCode !== null) 或被显式 kill 时才判定为退出，杜绝状态位竞争引发的假性误杀
        if (child.exitCode !== null || child.killed) {
          logger.warn(
            LogCategory.SYSTEM,
            `[OmniService] firefly-omni 子进程在就绪前异常退出 (exitCode=${child.exitCode}, killed=${child.killed})，中止启动探活`
          )
          this.isStarting = false
          return false
        }

        await new Promise(r => setTimeout(r, 200))
        if (await this.checkHealth()) {
          logger.info(LogCategory.SYSTEM, `[OmniService] firefly-omni 服务就绪并在 ${this.baseUrl} 正常监听`)
          this.restartAttempts = 0
          this.isStarting = false
          // 探活就绪后，记录二进制签名，并开启开发态热更新监听
          this.spawnedBinarySignature = this.binarySignature(exePath)
          this.lastSpawnedAt = Date.now()
          this.pendingUpdateSignature = null
          this.pendingUpdateSince = 0
          this.startDevBinaryWatch()
          // 探活就绪后，立即同步一次当前配置（ENABLE_IMAGE_OCR, OCR_MODEL_SIZE 等）
          this.syncConfigFromDesktop().catch(() => {})
          // 主动推送"运行中"状态至渲染进程（基础AI引擎 Footer 展示）
          this.pushStatus().catch(() => {})
          this.notifyReady()
          return true
        }
      }

      logger.error(LogCategory.SYSTEM, `[OmniService] firefly-omni 启动探活超时 (40s)，终止当前未就绪子进程`)
      this.stop()
      this.isStarting = false
      // 启动失败（探活超时），推送"未运行"状态
      this.pushStatus().catch(() => {})
      return false
    } catch (err) {
      logger.error(LogCategory.SYSTEM, '[OmniService] 启动服务发生异常:', err)
      this.isStarting = false
      return false
    }
  }

  /**
   * 停止子进程
   */
  /**
   * 物理终止当前持有的 firefly-omni 子进程树（纯净终止，不污染 isStarting 状态机）
   */
  private killCurrentProcess(): void {
    if (this.process) {
      const pid = this.process.pid
      try {
        const { processReaper } = require('../../main/process-reaper')
        processReaper.unregisterChild(pid)
      } catch {}
      try {
        if (process.platform === 'win32' && pid) {
          try {
            const { execSync } = require('node:child_process')
            execSync(`taskkill /pid ${pid} /T /F`, { stdio: 'ignore' })
          } catch {}
        }
        this.process.kill('SIGKILL')
        logger.info(LogCategory.SYSTEM, `[OmniService] 已彻底终止 firefly-omni 进程树 (PID=${pid})`)
      } catch {}
      this.process = null
    }
  }

  public stop(): void {
    this.isStarting = false
    if (this.restartTimeout) {
      clearTimeout(this.restartTimeout)
      this.restartTimeout = null
    }

    this.killCurrentProcess()
    // 主动推送"未运行"状态至渲染进程（基础AI引擎 Footer 展示）
    broadcastOmniStatus({ running: false, version: null })
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
   * 优雅热重启 Omni 服务（档位变更或异常恢复）
   */
  public async restart(): Promise<boolean> {
    logger.info(LogCategory.SYSTEM, '[OmniService] 正在优雅重启 Omni 服务进程...')
    this.stop()
    if (this.startPromise) {
      try {
        await this.startPromise
      } catch {}
    }
    await this.waitForPortReleased(3000)
    return await this.start()
  }

  /**
   * 指数退避自愈重启
   */
  private async scheduleRestart(): Promise<void> {
    if (await this.checkHealth()) {
      logger.info(LogCategory.SYSTEM, '[OmniService] Omni 服务已在运行，跳过重启')
      this.restartAttempts = 0
      return
    }

    if (this.restartAttempts >= this.maxRestartAttempts) {
      logger.error(LogCategory.SYSTEM, `[OmniService] 已达到最大重启重试次数 (${this.maxRestartAttempts})，停止自动重启`)
      return
    }

    const delay = Math.min(1000 * Math.pow(2, this.restartAttempts), 15000)
    this.restartAttempts++
    logger.info(LogCategory.SYSTEM, `[OmniService] 安排在 ${delay}ms 后尝试重启 Omni 服务 (第 ${this.restartAttempts} 次)...`)

    this.restartTimeout = setTimeout(() => {
      this.start().catch(err => {
        logger.error(LogCategory.SYSTEM, '[OmniService] 自动重启失败:', err)
      })
    }, delay)
  }

  /**
   * 服务健康探活
   */
  public async checkHealth(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/health`, { signal: AbortSignal.timeout(1000) })
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
      const { ConfigOrchestrator } = await import('../../config/config-orchestrator')
      const orchestrator = ConfigOrchestrator.getInstance()
      const enableImageOcr = orchestrator.getValue<boolean>('ENABLE_IMAGE_OCR') ?? true
      const enableOfficeCover = orchestrator.getValue<boolean>('ENABLE_OFFICE_COVER') ?? false
      const maxDocOcrItems = orchestrator.getValue<number>('MAX_DOCUMENT_OCR_ITEMS') ?? 0
      const ocrModelSize = (orchestrator.getValue<string>('OCR_MODEL_SIZE') || 'tiny').toLowerCase()
      const maxContentSizeKb = orchestrator.getValue<number>('MAX_CONTENT_SIZE_KB') ?? 30
      const maxFileSizeMb = orchestrator.getValue<number>('MAX_FILE_SIZE') ?? 100
      // 统一走 analysis-mode 模块解析，避免此处 `|| 'full'` 与其它模块 `?? 'quick_name'` 的兜底不一致
      const { resolveAnalysisMode } = await import('../../config/analysis-mode')
      const analysisMode = resolveAnalysisMode()
      const reuseBasic = orchestrator.getValue<boolean>('REUSE_BASIC_ANALYSIS_DATA') ?? true
      // 语音识别时长（基础 AI 引擎口径，参与 120s 单文件预算求解）
      const audioAnalysisDuration = orchestrator.getValue<number>('AUDIO_ANALYSIS_DURATION') ?? 30
      // 当前用户界面语言，同步给 Omni 引擎（供 OCR/元数据提取等按语言处理）
      const currentLanguage = orchestrator.getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN'

      // 提取最新的受保护排除项清单 (来自 IGNORE_RULES 中 isCzkawka 标记)
      let excludedItems: any[] = []
      try {
        const { duplicateDetectionService } = await import('../filesystem/duplicate-detection-service')
        excludedItems = duplicateDetectionService ? duplicateDetectionService.getProtectedExcludedItems() : []
      } catch {
        excludedItems = []
      }

      const embeddingProfile =
        orchestrator.getValue<'classic_light' | 'gemma_unified'>('AI_EMBEDDING_PROFILE') || 'classic_light'
      const mrlDimension = orchestrator.getValue<number>('EMBEDDING_MRL_DIMENSION') || 512

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
        mrl_dimension: mrlDimension
      })

      const res = await fetch(`${this.baseUrl}/api/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(3000)
      })

      if (res.ok) {
        logger.info(
          LogCategory.SYSTEM,
          `[OmniService] 已向 Omni 引擎同步配置: enable_office_cover=${enableOfficeCover}, max_document_ocr_items=${maxDocOcrItems}, enable_image_ocr=${enableImageOcr}, ocr_model_size=${ocrModelSize}, audio_analysis_duration=${audioAnalysisDuration}s, excluded_items_count=${excludedItems.length}, language=${currentLanguage}, embedding_profile=${embeddingProfile}, mrl_dimension=${mrlDimension}`
        )
        return true
      }
      return false
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, '[OmniService] 同步配置到 Omni 引擎失败 (无头环境已容错):', err.message)
      return false
    }
  }

  /**
   * 语言切换后通知 Omni 重载只读 SQLite 连接
   * POST /api/reconnect { dbPath } (ADR-0035 §8.4 双消费者热重连契约)
   */
  public async reconnect(dbPath: string): Promise<boolean> {
    await this.ensureRunning()
    try {
      const res = await fetch(`${this.baseUrl}/api/reconnect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dbPath }),
        signal: AbortSignal.timeout(5000)
      })
      if (!res.ok) {
        logger.warn(LogCategory.SYSTEM, `[OmniService] POST /api/reconnect 失败: status=${res.status}`)
        return false
      }
      const json = await res.json()
      logger.info(LogCategory.SYSTEM, `[OmniService] Omni 热重连结果:`, JSON.stringify(json))
      return json.omwAvailable === true
    } catch (err: any) {
      logger.warn(LogCategory.SYSTEM, `[OmniService] POST /api/reconnect 异常:`, err.message)
      return false
    }
  }

  /**
   * 提取文件全量信息 (元数据, Magika, Markdown, EXIF, 音视频标签)
   */
  public async extract(filePath: string): Promise<OmniExtractionResponse | null> {
    await this.ensureRunning()
    const tStart = Date.now()
    const reqBody = { file_path: filePath }
    logger.debug(
      LogCategory.SYSTEM,
      `[OmniService] >>> POST /api/extract 请求发起:`,
      JSON.stringify(reqBody)
    )

    const doFetch = async () => {
      const res = await fetch(`${this.baseUrl}/api/extract`, {
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
      const causeMsg = err?.cause?.message || err?.cause?.code || (err?.cause ? String(err.cause) : '')
      const fullError = causeMsg ? `${err.message} (cause: ${causeMsg})` : err.message
      logger.warn(
        LogCategory.SYSTEM,
        `[OmniService] <<< POST /api/extract 首次调用异常 (${filePath}): 耗时: ${Date.now() - tStart}ms, 错误: ${fullError}，尝试自愈拉起并重试...`
      )
      // 若出现网络错误（如进程被外部杀死重构中），触发自愈并重试一次
      const restarted = await this.start()
      if (restarted) {
        try {
          return await doFetch()
        } catch (retryErr: any) {
          const retryCause = retryErr?.cause?.message || retryErr?.cause?.code || (retryErr?.cause ? String(retryErr.cause) : '')
          const retryFull = retryCause ? `${retryErr.message} (cause: ${retryCause})` : retryErr.message
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
        const res = await fetch(`${this.baseUrl}/api/geo/reverse`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqBody),
          signal: AbortSignal.timeout(3000)
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
        const restarted = await this.start()
        if (restarted) {
          try {
            return await doFetch()
          } catch {}
        }
        throw fetchErr
      }
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] <<< POST /api/geo/reverse 调用异常 (耗时: ${Date.now() - tStart}ms):`, err.message)
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
        is_text: m.is_text ?? (extResult.mime_type.startsWith('text/') || (extResult.markdown_content ? extResult.markdown_content.length > 0 : false)),
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
    options?: { skipIfExistsPath?: string; skipIfExists?: boolean }
  ): Promise<Buffer | null> {
    if (options?.skipIfExists) {
      return null
    }

    if (options?.skipIfExistsPath) {
      try {
        const fs = await import('node:fs/promises')
        await fs.access(options.skipIfExistsPath)
        logger.info(
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
    const skipQuery = options?.skipIfExists ? `&skip_if_exists=true` : ''
    const url = `${this.baseUrl}/api/cover?path=${encodeURIComponent(filePath)}${skipQuery}`
    logger.debug(LogCategory.SYSTEM, `[OmniService] >>> GET /api/cover 请求发起 (${filePath})`)

    const doFetch = async () => {
      // Office 转换 (LibreOffice) 或复杂视频截帧可能需要一定冷启动时间，提供充足的 60 秒等待时间
      const res = await fetch(url, {
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
      const durationMs = durationHeader ? Number(durationHeader) : (Date.now() - tStart)
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
      logger.debug(LogCategory.SYSTEM, `[OmniService] <<< GET /api/cover 首次调用异常 (${filePath}, 耗时: ${Date.now() - tStart}ms): ${err.message}，尝试自愈重试...`)
      const restarted = await this.start()
      if (restarted) {
        try {
          return await doFetch()
        } catch (retryErr: any) {
          logger.debug(LogCategory.SYSTEM, `[OmniService] <<< GET /api/cover 自愈重试仍异常 (${filePath}):`, retryErr.message)
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
    const reqBody = {
      file_path: filePath,
      file_fingerprint: options?.fileFingerprint,
      language: options?.language,
      enable_visual_tags: options?.enableVisualTags ?? true,
      enable_asr: options?.enableAudioTranscript,
      enable_geo_reverse: options?.enableGeoReverse ?? true,
      enable_text_analysis: options?.enableTextAnalysis,
      max_content_size_kb: options?.maxContentSizeKb,
      audio_analysis_duration: options?.audioAnalysisDuration,
      generate_thumbnail: options?.generateThumbnail ?? options?.enableCover,
      video_frame_interval_seconds: options?.videoFrameIntervalSeconds,
      video_soft_token_budget: options?.videoSoftTokenBudget
    }
    logger.debug(
      LogCategory.SYSTEM,
      `[OmniService] >>> POST /api/perceive 请求发起:`,
      JSON.stringify(reqBody)
    )

    // perceive 超时 = CPU 阶段上限（总预算 − 按类型分配的 AI 保底），见 analysis-timeout-policy。
    // 音视频不再放宽到 10 分钟：那会让单文件真实上限变成「10 分钟 + AI 分析」。
    // 请求里带了音视频专属参数时以之为准，避免无扩展名的媒体文件被误判成文档。
    const isMediaHint =
      options?.enableAudioTranscript === true || options?.audioAnalysisDuration !== undefined
    const timeoutMs =
      options?.timeoutMs ||
      resolveAnalysisTimeoutBudget(filePath, undefined, isMediaHint).cpuCapMs

    const doFetch = async () => {
      const res = await fetch(`${this.baseUrl}/api/perceive`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connection': 'keep-alive'
        },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(timeoutMs)
      })

      if (!res.ok) {
        logger.warn(
          LogCategory.SYSTEM,
          `[OmniService] <<< POST /api/perceive 响应异常: status=${res.status}, 耗时: ${Date.now() - tStart}ms`
        )
        return null
      }

      const json = (await res.json()) as OmniPerceptionResponse

      // 级联仲裁终局结果显式输出至 Desktop 控制台 (debug/开发模式可见)
      if (json.winning_hypothesis || (json.candidate_hypotheses && json.candidate_hypotheses.length > 0)) {
        logger.info(
          LogCategory.SYSTEM,
          `[级联仲裁:Desktop] 终局胜出: "${json.winning_hypothesis?.prompt_text || '无'}" (置信度: ${json.winning_hypothesis?.confidence ?? 'N/A'}) | 建议命名: ${json.smart_name || '无'}`
        )
        if (json.candidate_hypotheses && json.candidate_hypotheses.length > 0) {
          const top100 = json.candidate_hypotheses.slice(0, 100)
          logger.info(
            LogCategory.SYSTEM,
            `[普遍语法造句:Desktop] Top ${top100.length} 候选造句排列表 (总数: ${json.candidate_hypotheses.length}):`
          )
          for (let i = 0; i < top100.length; i++) {
            const cand = top100[i]
            logger.info(
              LogCategory.SYSTEM,
              `  [${String(i + 1).padStart(3, ' ')}] conf=${cand.confidence.toFixed(3)} winner=${cand.is_winner ? '★YES' : ' NO '} prompt="${cand.prompt_text}"`
            )
          }
        }
      }

      // 输出所有融合标签 (fused_tags)
      if (json.fused_tags && json.fused_tags.length > 0) {
        logger.info(
          LogCategory.SYSTEM,
          `[双锚点融合:Desktop] 最终胜出融合标签 (count=${json.fused_tags.length}):`
        )
        for (let i = 0; i < json.fused_tags.length; i++) {
          const t = json.fused_tags[i]
          logger.info(
            LogCategory.SYSTEM,
            `  [${String(i + 1).padStart(2, ' ')}] conf=${t.confidence.toFixed(3)} code=${t.code.padEnd(30, ' ')} name=${t.name.padEnd(10, ' ')} parent=${t.parent_codes?.join(',') ?? 'None'}`
          )
        }
      }

      // 输出原生事实标签 (fact_tags, Task 2)
      if (json.fact_tags && json.fact_tags.length > 0) {
        logger.info(
          LogCategory.SYSTEM,
          `[事实标签:Desktop] 接收 Omni fact_tags (count=${json.fact_tags.length}): [${json.fact_tags.map(t => t.name).join(', ')}]`
        )
        for (let i = 0; i < json.fact_tags.length; i++) {
          const t = json.fact_tags[i]
          logger.info(
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
          ram_tags: json.ram_tags || [],
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
      const causeMsg = err?.cause?.message || err?.cause?.code || (err?.cause ? String(err.cause) : '')
      const fullError = causeMsg ? `${err.message} (cause: ${causeMsg})` : err.message
      logger.warn(
        LogCategory.SYSTEM,
        `[OmniService] <<< POST /api/perceive 首次调用异常 (${filePath}): 耗时: ${Date.now() - tStart}ms, 错误: ${fullError}，尝试自愈拉起并重试...`
      )
      const restarted = await this.start()
      if (restarted) {
        try {
          return await doFetch()
        } catch (retryErr: any) {
          const retryCause = retryErr?.cause?.message || retryErr?.cause?.code || (retryErr?.cause ? String(retryErr.cause) : '')
          const retryFull = retryCause ? `${retryErr.message} (cause: ${retryCause})` : retryErr.message
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
    options?: { language?: string; timeoutMs?: number }
  ): Promise<OmniAudioTranscribeResponse | null> {
    await this.ensureRunning()
    const tStart = Date.now()
    const reqBody = {
      file_path: filePath,
      language: options?.language
    }
    const timeoutMs = options?.timeoutMs || 60000

    const doFetch = async () => {
      const res = await fetch(`${this.baseUrl}/api/audio/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) return null
      return (await res.json()) as OmniAudioTranscribeResponse
    }

    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] transcribeAudio 异常 (${filePath}):`, err.message)
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
      const res = await fetch(`${this.baseUrl}/api/audio/convert`, {
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
      const res = await fetch(`${this.baseUrl}/api/vision/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) return null
      const json = (await res.json()) as OmniVisionTagsResponse
      return json.tags || []
    }

    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] extractVisualTags 异常 (${filePath}):`, err.message)
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
      const res = await fetch(`${this.baseUrl}/api/vision/inspect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) return null
      return (await res.json()) as OmniVisionInspectResponse
    }

    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] inspectVision 异常 (${filePath}):`, err.message)
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
      const res = await fetch(`${this.baseUrl}/api/fs/ads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) return null
      return (await res.json()) as OmniFsAdsResponse
    }

    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] inspectAds 异常 (${filePath}):`, err.message)
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
      const res = await fetch(`${this.baseUrl}/api/search/index`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ documents }),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) return null
      return (await res.json()) as OmniIndexResponse
    }
    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] indexDocuments 异常:`, err.message)
      const restarted = await this.start()
      if (restarted) {
        try { return await doFetch() } catch {}
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
      const res = await fetch(`${this.baseUrl}/api/search/hybrid`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) return null
      return (await res.json()) as OmniHybridSearchResponse
    }
    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] searchHybrid 异常:`, err.message)
      const restarted = await this.start()
      if (restarted) {
        try { return await doFetch() } catch {}
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
    },
    timeoutMs: number = 30000
  ): Promise<OmniClusterResponse | null> {
    await this.ensureRunning()
    const doFetch = async () => {
      const res = await fetch(`${this.baseUrl}/api/search/cluster`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) {
        const errorText = await res.text().catch(() => '')
        logger.warn(LogCategory.SYSTEM, `[OmniService] clusterDocuments 响应错误 HTTP ${res.status}: ${errorText}`)
        return { success: false, error: `HTTP ${res.status}: ${errorText}` }
      }
      return (await res.json()) as OmniClusterResponse
    }
    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] clusterDocuments 异常:`, err.message)
      const restarted = await this.start()
      if (restarted) {
        try { return await doFetch() } catch {}
      }
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
      const res = await fetch(`${this.baseUrl}/api/hownet/describe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) return null
      return (await res.json()) as OmniHowNetDescribeResult
    }

    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] describeHowNet 异常 (${word}):`, err.message)
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
      const { ConfigOrchestrator } = await import('../../config/config-orchestrator')
      const orchestrator = ConfigOrchestrator.getInstance()
      return orchestrator.getValue<'classic_light' | 'gemma_unified'>('AI_EMBEDDING_PROFILE') || 'classic_light'
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
      const res = await fetch(`${this.baseUrl}/api/text/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) return null
      return (await res.json()) as OmniTextAnalysisResult
    }

    try {
      return await doFetch()
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniService] analyzeText 异常:`, err.message)
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
      const res = await fetch(`${this.baseUrl}/api/taxonomy/resolve-parent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: AbortSignal.timeout(timeoutMs)
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
      const res = await fetch(`${this.baseUrl}/api/v1/taxonomy/inspect-tag`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: controller.signal
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
    }
  ): Promise<{
    vectors: number[][]
    count: number
    dim: number
    profile: string
    durationMs: number
  }> {
    await this.ensureRunning()
    const reqBody = {
      texts,
      profile: options?.profile,
      dim: options?.dim
    }

    const timeoutMs = options?.timeoutMs ?? 10000
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const res = await fetch(`${this.baseUrl}/api/v1/vector/batch-embed-text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody),
        signal: controller.signal
      })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`)
      }
      return (await res.json()) as {
        vectors: number[][]
        count: number
        dim: number
        profile: string
        durationMs: number
      }
    } catch (err: any) {
      logger.warn(
        LogCategory.SYSTEM,
        `[OmniService] batchEmbedText 异常或超时: ${err.message}`
      )
      throw err
    } finally {
      clearTimeout(timer)
    }
  }
}

export interface InspectControlledTagItem {
  tagName: string
  targetParentCode: string
}

export interface InspectControlledTagResult {
  tagName: string
  isControlled: boolean
  matchedParent: boolean
  code: string | null
  canonicalName: string | null
  parentCodes: string[]
  ancestryMatchedCode: string | null
}

export interface InspectControlledTagsResponse {
  success: boolean
  results: InspectControlledTagResult[]
}

export const omniService = OmniService.getInstance()


