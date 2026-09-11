/**
 * Omni Native Service - Omni Rust 原生微服务管理器
 * apps/desktop/src/electron/runtime-services/system/omni-service.ts
 *
 * 核心职责：
 * 1. 负责 firefly-omni.exe 原生二进制子进程的拉起、常驻守护与健康探活
 * 2. 进程崩溃自动重启 (带指数退避) 与应用退出时的协同销毁
 * 3. 封装统一的 HTTP Client，对接 /api/extract, /api/cleanup/scan, /api/geo/reverse
 */
import { FileCategory } from '@firefly/types';
export interface OmniBenchmarkResponse {
    total_ms: number;
    magika_ms?: number;
    metadata_ms?: number;
    tag_ms?: number;
    text_ms?: number;
    document_ms?: number;
    ocr_ms?: number;
    html_ms?: number;
    thumbnail_ms?: number;
}
export interface OmniExtractionResponse {
    file_path: string;
    mime_type: string;
    file_size: number;
    markdown_content?: string;
    metadata?: Record<string, any>;
    phash?: string;
    is_corrupted?: boolean;
    benchmark?: OmniBenchmarkResponse;
}
export type OmniGeoReversePoint = {
    latitude: number;
    longitude: number;
} | {
    lat: number;
    lon: number;
};
export interface OmniGeoReverseItem {
    found: boolean;
    country?: string;
    province?: string;
    admin1?: string;
    admin2?: string;
    city?: string;
    distanceKm?: number;
    formattedAddress?: string;
}
export interface OmniGeoReverseResponse {
    available: boolean;
    datasetVersion?: number;
    reason?: string;
    results?: OmniGeoReverseItem[];
}
export interface OmniPerceptionOptions {
    language?: string;
    enableVisualTags?: boolean;
    enableAudioTranscript?: boolean;
    enableGeoReverse?: boolean;
    maxContentSizeKb?: number;
    audioAnalysisDuration?: number;
    timeoutMs?: number;
}
export interface OmniPerceptionBenchmarkResponse {
    total_ms: number;
    extract_ms?: number;
    ads_ms?: number;
    vision_ms?: number;
    audio_ms?: number;
    geo_ms?: number;
    magika_ms?: number;
    metadata_ms?: number;
    tag_ms?: number;
    text_ms?: number;
    ocr_ms?: number;
    text_detect_ms?: number;
    clip_ms?: number;
    nsfw_ms?: number;
    watermark_ms?: number;
    mosaic_ms?: number;
    aesthetic_ms?: number;
    bw_ms?: number;
    ram_ms?: number;
}
export interface OmniTagChainItem {
    tag: string;
    confidence: number;
    dimension_id: number;
    dimension_name: string;
    logic_pan_dimension: string;
}
export type OmniRamTagItem = OmniTagChainItem;
export interface OmniPerceptionResponse {
    file_path: string;
    mime_type: string;
    file_size: number;
    category?: string;
    markdown_content: string;
    ocr_text?: string;
    metadata: Record<string, any>;
    file_source?: string;
    file_source_code?: string;
    source_url?: string;
    workflow_state?: string;
    workflow_state_code?: string;
    security_level?: string;
    security_level_code?: string;
    has_watermark?: boolean;
    watermark_level?: number;
    watermark_status?: string;
    has_mosaic?: boolean;
    mosaic_level?: number;
    mosaic_status?: string;
    has_text?: boolean;
    aesthetic_score?: number;
    quality_score?: number;
    photo_type?: string;
    quality_issues?: string[];
    visual_tags: OmniTagChainItem[];
    mobilenet_tags?: string[];
    clip_tags?: string[];
    nsfw_tags?: string[];
    ram_tags?: string[];
    mobilenet_high_confidence_tags?: string[];
    clip_high_confidence_tags?: string[];
    nsfw_high_confidence_tags?: string[];
    sensitive_types?: string[];
    content_rating?: string;
    audio_transcript?: string;
    audio_events: string[];
    geo_address?: string;
    candidate_hypotheses?: Array<{
        id: string;
        prompt_text: string;
        confidence: number;
        is_winner: boolean;
        slots: Record<string, any>;
        bound_tags: OmniTagChainItem[];
    }>;
    winning_hypothesis?: {
        prompt_text: string;
        confidence: number;
    };
    activated_dimension_tags?: OmniTagChainItem[];
    smart_name?: string;
    content_description?: string;
    pruned_ambiguous_words?: string[];
    phash?: string;
    is_corrupted: boolean;
    benchmark?: OmniPerceptionBenchmarkResponse;
}
export interface OmniAudioTranscribeResponse {
    file_path: string;
    transcript?: string;
    events: string[];
    language?: string;
    duration_ms: number;
}
export interface OmniAudioConvertResponse {
    file_path: string;
    output_path: string;
    duration_seconds: number;
    duration_ms: number;
}
export interface OmniVisionTagsResponse {
    file_path: string;
    tags: string[];
    duration_ms: number;
}
export interface OmniVisionInspectResponse {
    file_path: string;
    has_watermark: boolean;
    watermark_level?: number;
    watermark_status: string;
    has_mosaic: boolean;
    mosaic_level?: number;
    mosaic_status: string;
    duration_ms: number;
}
export interface OmniFsAdsResponse {
    file_path: string;
    file_source?: string;
    file_source_code?: string;
    source_url?: string;
    duration_ms: number;
}
export interface OmniIndexedDocument {
    fingerprint: string;
    embedding: number[];
    searchableText: string;
}
export interface OmniIndexResponse {
    success: boolean;
    totalIndexed: number;
    error?: string;
}
export interface OmniFusedResult {
    fingerprint: string;
    rrfScore: number;
    finalScore: number;
    denseRank?: number;
    bm25Rank?: number;
}
export interface OmniHybridSearchResponse {
    success: boolean;
    results: OmniFusedResult[];
    error?: string;
}
export interface OmniClusterDocument {
    fingerprint: string;
    embedding: number[];
    keywords: string[];
}
export interface OmniClusterGroup {
    fingerprints: string[];
    folderName: string;
    path: string[];
}
export interface OmniClusterTreeResult {
    clusters: OmniClusterGroup[];
    otherFiles: string[];
    durationMs: number;
}
export interface OmniClusterResponse {
    success: boolean;
    result?: OmniClusterTreeResult;
    error?: string;
}
export declare class OmniService {
    private static instance;
    private process;
    private basePort;
    private actualPort;
    private baseUrl;
    private isStarting;
    private startPromise;
    private cachedVersion;
    private restartAttempts;
    private maxRestartAttempts;
    private restartTimeout;
    private constructor();
    static getInstance(): OmniService;
    getBaseUrl(): string;
    /**
     * 获取 Omni 引擎版本号
     */
    getVersion(): Promise<string>;
    /**
     * 确保 Omni 服务处于运行与就绪状态（若未运行则自动按需拉起）
     */
    ensureRunning(): Promise<boolean>;
    /**
     * 定位 firefly-omni 可执行文件
     */
    resolveOmniExecutable(): string | null;
    /**
     * 启动并守护 firefly-omni 子进程（支持并发 Promise 合并）
     */
    start(): Promise<boolean>;
    private doStart;
    /**
     * 停止子进程
     */
    stop(): void;
    /**
     * 指数退避自愈重启
     */
    private scheduleRestart;
    /**
     * 服务健康探活
     */
    checkHealth(): Promise<boolean>;
    /**
     * 向 Omni 引擎同步最新配置 (ENABLE_IMAGE_OCR, ENABLE_DOCUMENT_OCR, OCR_MODEL_SIZE 等)
     */
    syncConfigFromDesktop(): Promise<boolean>;
    /**
     * 提取文件全量信息 (元数据, Magika, Markdown, EXIF, 音视频标签)
     */
    extract(filePath: string): Promise<OmniExtractionResponse | null>;
    /**
     * 统一通过 Omni 引擎提取全量 ExifTool/媒体/文档元数据 (供属性面板与分析流水线使用)
     */
    extractMetadataFull(filePath: string): Promise<Record<string, any>>;
    /**
     * GPS 经纬度逆地理编码: POST /api/geo/reverse (对接 omni-geo 微服务)
     */
    reverseGeo(pointsOrLat: OmniGeoReversePoint[] | number, lonOrLang?: number | string, optionalLang?: string): Promise<OmniGeoReverseResponse | null>;
    /**
     * 获取 Magika 分类信息 (与历史 Node.js Magika 返回格式 100% 对齐)
     */
    identifyMagika(filePath: string): Promise<FileCategory | null>;
    /**
     * 获取多模态文件首页/关键帧高清封面图 (WebP/Image Buffer)
     * 接口: GET /api/cover?path=...
     * 支持 PDF, PSD, 视频 (MP4/MKV/MOV/AVI/WEBM), SVG, EPUB 等格式由 Omni Rust 引擎直接零拷贝渲染为 WebP
     * 不支持的格式服务端返回 204，此处直接返回 null 并平滑降级
     */
    getFileCover(filePath: string): Promise<Buffer | null>;
    /**
     * 兼容别名：获取 PDF 封面图
     */
    getPdfCover(filePath: string): Promise<Buffer | null>;
    /**
     * 原生多模态感知 (单点聚合: 元数据 + NTFS ADS + 频域水印/打码 + CLIP + SenseVoice ASR + 逆地理)
     * POST /api/perceive
     */
    perceive(filePath: string, options?: OmniPerceptionOptions): Promise<OmniPerceptionResponse | null>;
    /**
     * 单指标：音频转文本 (SenseVoice ASR)
     * POST /api/audio/transcribe
     */
    transcribeAudio(filePath: string, options?: {
        language?: string;
        timeoutMs?: number;
    }): Promise<OmniAudioTranscribeResponse | null>;
    /**
     * 单指标：转换标准音频并降噪 (16kHz, mono, pcm_s16le WAV)
     * POST /api/audio/convert
     */
    convertToStandardAudio(filePath: string, durationSeconds?: number, timeoutMs?: number): Promise<OmniAudioConvertResponse | null>;
    /**
     * 单指标：提取视觉标签 (CLIP 图像特征向量)
     * POST /api/vision/tags
     */
    extractVisualTags(filePath: string, options?: {
        language?: string;
        topK?: number;
        timeoutMs?: number;
    }): Promise<string[] | null>;
    /**
     * 单指标：图像水印与打码频域检测
     * POST /api/vision/inspect
     */
    inspectVision(filePath: string, timeoutMs?: number): Promise<OmniVisionInspectResponse | null>;
    /**
     * 单指标：文件系统 NTFS ADS 来源追踪 (Zone.Identifier)
     * POST /api/fs/ads
     */
    inspectAds(filePath: string, timeoutMs?: number): Promise<OmniFsAdsResponse | null>;
    /**
     * 工业级混合检索：批量写入双轨索引 (USearch 密集向量 + Tantivy BM25)
     * POST /api/search/index
     */
    indexDocuments(documents: OmniIndexedDocument[], timeoutMs?: number): Promise<OmniIndexResponse | null>;
    /**
     * 工业级混合检索：双轨混合检索与加权 RRF 融合打分 + 规则重排
     * POST /api/search/hybrid
     */
    searchHybrid(options: {
        queryText?: string;
        queryEmbedding?: number[];
        topK?: number;
    }, timeoutMs?: number): Promise<OmniHybridSearchResponse | null>;
    /**
     * 约束层次凝聚聚类 (HAC) 与提示词向量引导多级目录自动归档
     * POST /api/search/cluster
     */
    clusterDocuments(options: {
        documents: OmniClusterDocument[];
        promptEmbedding?: number[];
        distanceThreshold?: number;
        maxLeafSize?: number;
    }, timeoutMs?: number): Promise<OmniClusterResponse | null>;
}
export declare const omniService: OmniService;
//# sourceMappingURL=omni-service.d.ts.map