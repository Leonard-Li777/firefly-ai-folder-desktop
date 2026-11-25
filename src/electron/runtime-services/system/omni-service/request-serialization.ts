import { LogCategory, logger } from '@firefly/shared'
import type { OmniExtractOptions, OmniPerceptionOptions } from './types'

type ConfigGetter = <T>(key: string) => T | undefined

/** 极小感知超时告警阈值（秒）：低于此值时视频视觉预算极易不足，主动 warn 暴露源头配置问题 */
export const MIN_RECOMMENDED_PERCEIVE_TIMEOUT_SEC = 30

/**
 * 构造 POST /api/perceive 请求体。纯函数、零副作用，供运行时与契约单测共用，
 * 确保「逐请求覆盖字段 -> Rust snake_case」映射只有一份事实源。
 */
export function buildPerceiveRequestBody(
  filePath: string,
  options: OmniPerceptionOptions | undefined,
  getConfigValue: ConfigGetter
): Record<string, unknown> {
  const perceiveTimeoutSec =
    typeof options?.perceiveTimeoutSec === 'number' &&
    Number.isFinite(options.perceiveTimeoutSec) &&
    options.perceiveTimeoutSec > 0
      ? options.perceiveTimeoutSec
      : undefined
  if (
    perceiveTimeoutSec !== undefined &&
    perceiveTimeoutSec < MIN_RECOMMENDED_PERCEIVE_TIMEOUT_SEC
  ) {
    logger.warn(
      LogCategory.SYSTEM,
      `[OmniService] 透传的 perceive_timeout_sec=${perceiveTimeoutSec.toFixed(1)}s 偏小（< ${MIN_RECOMMENDED_PERCEIVE_TIMEOUT_SEC}s），视频分析可能因预算不足触发降级 (${filePath})`
    )
  }

  return {
    file_path: filePath,
    file_fingerprint: options?.fileFingerprint,
    language: options?.language,
    enable_visual_tags: options?.enableVisualTags ?? true,
    enable_asr: options?.enableAudioTranscript,
    enable_geo_reverse: options?.enableGeoReverse ?? true,
    enable_text_analysis: options?.enableTextAnalysis,
    max_content_size_kb: options?.maxContentSizeKb,
    enable_image_ocr: options?.enableImageOcr,
    ocr_model_size: options?.ocrModelSize,
    max_document_ocr_items: options?.maxDocumentOcrItems,
    extract_pages: options?.extractPages,
    enable_office_cover: options?.enableOfficeCover ?? options?.enableCover,
    video_asr_duration_sec: options?.videoAsrDurationSec,
    enable_video_visual_analysis: options?.enableVideoVisualAnalysis,
    enable_nsfw_perception: options?.enableNsfwPerception,
    enable_face_perception: options?.enableFacePerception,
    audio_analysis_duration: options?.audioAnalysisDuration,
    generate_thumbnail: options?.generateThumbnail ?? options?.enableCover,
    video_frame_interval_seconds: options?.videoFrameIntervalSeconds,
    video_soft_token_budget: options?.videoSoftTokenBudget,
    video_frame_quota_max:
      options?.videoFrameQuotaMax ?? getConfigValue<number>('VIDEO_FRAME_QUOTA_MAX'),
    video_cut_sensitivity:
      options?.videoCutSensitivity ?? getConfigValue<string>('VIDEO_CUT_SENSITIVITY'),
    video_max_analyze_sec: options?.videoMaxAnalyzeSec,
    video_analyze_start_sec: options?.videoAnalyzeStartSec,
    skip_5w_synthesis: options?.skip5wSynthesis,
    ...(perceiveTimeoutSec !== undefined ? { perceive_timeout_sec: perceiveTimeoutSec } : {})
  }
}

/** 构造 POST /api/extract 请求体（回退通道与 perceive 同源，杜绝工作区参数丢失）。 */
export function buildExtractRequestBody(
  filePath: string,
  options: OmniExtractOptions | undefined
): Record<string, unknown> {
  return {
    file_path: filePath,
    extract_pages: options?.extractPages,
    enable_image_ocr: options?.enableImageOcr,
    ocr_model_size: options?.ocrModelSize,
    max_document_ocr_items: options?.maxDocumentOcrItems,
    max_content_size_kb: options?.maxContentSizeKb,
    enable_office_cover: options?.enableOfficeCover
  }
}

/** 构造 GET /api/cover URL；enable_office_cover 的 false/true 均显式写入 query。 */
export function buildCoverUrl(
  baseUrl: string,
  filePath: string,
  options?: { skipIfExists?: boolean; enableOfficeCover?: boolean }
): string {
  const skipQuery = options?.skipIfExists ? '&skip_if_exists=true' : ''
  const coverQuery =
    options?.enableOfficeCover === undefined
      ? ''
      : `&enable_office_cover=${options.enableOfficeCover ? 'true' : 'false'}`
  return `${baseUrl}/api/cover?path=${encodeURIComponent(filePath)}${skipQuery}${coverQuery}`
}
