/**
 * 基础AI引擎（Omni）运行状态快照，主动推送至渲染进程（omni:status-changed）
 */
export interface OmniRuntimeStatus {
  /** 进程探活是否成功 */
  running: boolean
  /** 引擎版本号（探活成功时返回） */
  version: string | null
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

/**
 * 原生感知插槽分析状态与命中标签 (Ticket 03)
 */
export interface PerceptionSlotResult {
  status: 'skipped' | 'clean' | 'flagged'
  tags: string[]
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
  /** 图片 OCR 开关（false 时 Rust 全链路 OCR/DBNet 在模型初始化前短路） */
  enableImageOcr?: boolean
  /** OCR 模型尺寸（仅 'tiny' | 'small' 生效，复用双常驻槽位零卸载） */
  ocrModelSize?: 'tiny' | 'small'
  /** 文档 OCR 项数（0 关闭，-1 不限，正值限数） */
  maxDocumentOcrItems?: number
  /** PDF 预提取页数（<= 0 / -1 全本，> 0 仅抽前 N 页） */
  extractPages?: number
  /** 视频伴音 ASR 时长（秒，仅视频 0 号切片读取，0 表跳过） */
  videoAsrDurationSec?: number
  /** 视频逐帧视觉分析开关（false 时彻底跳过抽帧，不受引擎内部下限覆盖） */
  enableVideoVisualAnalysis?: boolean
  /** 敏感内容感知开关（仅可向下收窄，绝不卸载全局会话） */
  enableNsfwPerception?: boolean
  /** 人脸感知开关 */
  enableFacePerception?: boolean
  audioAnalysisDuration?: number
  timeoutMs?: number
  /** 是否需要生成缩略图/封面（若已有则传 false，不要求生成） */
  generateThumbnail?: boolean
  /** Office 完整封面截图开关（perceive 统一读此字段，缺失时回退 enableCover） */
  enableOfficeCover?: boolean
  enableCover?: boolean
  /** 视频内容定位精度（抽帧间隔秒数），默认 5.0，精细模式可设为 1.0 */
  videoFrameIntervalSeconds?: number
  /** 视频画面精细度（每帧视觉软 token 预算，140=标准精细，70=精简快速），默认 140 */
  videoSoftTokenBudget?: number
  /** 单视频最大抓图数量配额（8~240 帧，默认 60） */
  videoFrameQuotaMax?: number
  /** 镜头切换捕捉敏锐度 ('low' | 'medium' | 'high'，默认 'medium') */
  videoCutSensitivity?: string
  /** 视频分析视界上限（秒，例如免费用户前 300 秒，缺省为 undefined 全片分析）(ISS-01 / ISS-32) */
  videoMaxAnalyzeSec?: number
  /** 视频分析起始时间（秒，用于长视频按 300s 切片独立派发，缺省为 undefined 从头分析）(ISS-48) */
  videoAnalyzeStartSec?: number
  /** 文件指纹，用于感知完成后在 Omni 内部就地批量落盘向量（Ticket 02 / 04） */
  fileFingerprint?: string
  /** 是否跳过 CPU 阶段 5W 造句（当后续由生成式 AI 接管时置为 true） */
  skip5wSynthesis?: boolean
  /** 可选外部中止信号，与内部超时信号合并以支持删除目录/暂停时立即中断在途请求 */
  signal?: AbortSignal
}

/** POST /api/extract 逐请求覆盖字段（`extract` 回退通道必须与 perceive 同源，杜绝参数丢失） */
export type OmniExtractOptions = Pick<
  OmniPerceptionOptions,
  | 'extractPages'
  | 'enableImageOcr'
  | 'ocrModelSize'
  | 'maxDocumentOcrItems'
  | 'maxContentSizeKb'
  | 'enableOfficeCover'
  | 'timeoutMs'
>

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
  /** 原生感知插槽: 敏感内容合规识别 (perception_nsfw, Ticket 03) */
  nsfw_perception?: PerceptionSlotResult
  /** 原生感知插槽: 人脸特征分析 (perception_face, Ticket 03) */
  face_perception?: PerceptionSlotResult
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

/**
 * 智能聚类策略模式 (Spec v2.0):
 * - precise: 【🎯 精准严谨】单轮严格阈值聚类，不触发任何降级，未达到阈值的文件全量归入「未归类」
 * - balanced: 【⭐ 平衡推荐】多轮阶梯降级且车门焊死，降级文件绝不掺入已有目录，仅自行抱团；同名同路径自然汇入
 * - complete: 【📦 全量收纳】阶梯降级双引擎（种子内向吸收 + 剩余抱团），最大化收敛消灭未归类文件
 */
export type ClusteringMode = 'precise' | 'balanced' | 'complete'

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
