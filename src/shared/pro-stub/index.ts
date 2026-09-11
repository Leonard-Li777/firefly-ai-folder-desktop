/**
 * Firefly AI Folder - Open-Source Stub for Pro Module
 * This fallback module is resolved by Vite/TypeScript when building the open-source community edition.
 */

export const isProVersion = false

export function getProCapabilities(): string[] {
  return []
}

export function getProConfig(): Record<string, unknown> | null {
  return null
}

export interface ProGroundTruthTag {
  dimensionName: string
  tagName: string
  confidence: number
  dimensionId?: number | string
  tagId?: number
}

export interface ProPreflightParams {
  filePath: string
  fileName: string
  fileSize: number
  fileCategory: string
  mimeType: string
  contentPreview?: string
  metadata?: Record<string, any>
  stats?: any
  omniPerception?: any
  visualTags?: string[]
  textTags?: string[]
}

export interface ProTextTaggingParams {
  filePath: string
  content?: string
  fileName?: string
  mimeType?: string
  language?: string
}

export interface ProPreflightResult {
  groundTruthTags: ProGroundTruthTag[]
  flattenedMetadata: Record<string, any>
  qualityScore?: number
}

export interface ProTagReconciliationParams {
  db: any
  fileFingerprint: string
  preflightContext?: {
    groundTruthTags?: ProGroundTruthTag[]
    [key: string]: any
  } | null
  dimResult?: any
  syncStatus?: number
  authors?: string[]
  language?: string
  fileGroup?: string
  extension?: string
}

export interface ProTagReconciliationResult {
  success: boolean
  tagsWrittenCount: number
}

export interface ProVisualTaggingParams {
  filePath: string
  mimeType?: string
  language?: string
}

/**
 * 开源社区版预检降级：仅透传基础元数据，不执行商业级既定事实推导
 */
export function executeProPreflight(params: ProPreflightParams): ProPreflightResult {
  return {
    groundTruthTags: [],
    flattenedMetadata: params.metadata || {}
  }
}

/**
 * 开源社区版找补裁决降级：安全空操作，不执行商业级物理事实覆盖与多标签入库
 */
export function executeProTagReconciliation(
  _params: ProTagReconciliationParams
): ProTagReconciliationResult {
  return {
    success: true,
    tagsWrittenCount: 0
  }
}

/**
 * 开源社区版轻量视觉打标降级：安全空操作
 */
export async function executeProVisualTagging(
  _params: ProVisualTaggingParams
): Promise<string[]> {
  return []
}

/**
 * 开源社区版轻量文本打标降级：安全空操作
 */
export async function executeProTextTagging(
  _params: ProTextTaggingParams
): Promise<string[]> {
  return []
}

