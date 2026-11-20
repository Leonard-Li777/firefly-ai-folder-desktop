import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { databaseService } from '../database/database-service'
import { getWorkspaceRuntimeContextEpoch } from './workspace-runtime-context-service'
import type { AnalysisMode } from '../../config/analysis-mode'

/**
 * 工作区运行时有效配置的最小消费契约（Group A `EffectiveWorkspaceAIConfigResult` 的过渡形态）。
 * 合流 Group A 后，`resolveWorkspaceEffectiveConfig` 内部直接改调其导出的
 * `resolveEffectiveAIConfig()` 即可，本文件对外签名保持不变。
 */
export interface EffectiveWorkspaceAIConfigResult {
  effectiveParams: {
    analysisMode: AnalysisMode
    enableImageOcr: boolean
    ocrModelSize: 'tiny' | 'small'
    maxDocumentOcrItems: number
    extractPages: number
    maxContentSizeKb: number
    enableOfficeCover: boolean
    videoAsrDurationSec: number
    audioAnalysisDurationSec: number
    enableVideoVisualAnalysis: boolean
    videoFrameQuotaMax: number
    videoCutSensitivity: string
    videoSoftTokenBudget: number
    clipTextEnabled: boolean
    reuseBasicAnalysisData: boolean
  }
  capabilities: {
    asrEffectivelyEnabled: boolean
    videoVisualAnalysisEnabled: boolean
    nsfwEffectivelyEnabled: boolean
    faceEffectivelyEnabled: boolean
  }
}

/** 单文件 / 多切片共享的锁定快照（OBS-02）：贯穿 Stage 1~4 与全部 0~k 切片，杜绝途中配置漂移。 */
export interface WorkspaceAnalysisContext {
  workspaceId: number | null
  policyVersion: number
  contextEpoch: number
  effectiveConfig: EffectiveWorkspaceAIConfigResult
  capabilityFingerprint: string
}

function readNumber(config: Record<string, unknown>, overrides: Record<string, unknown>, key: string, fallback: number): number {
  const value = overrides[key] ?? config[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function readBool(config: Record<string, unknown>, overrides: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = overrides[key] ?? config[key]
  return typeof value === 'boolean' ? value : fallback
}

/**
 * 基于工作区 `WorkspaceConfigReady` 解析实际生效配置。
 * `hasInstalledAiEngine` 由调用方按当前引擎安装态传入，确保 `simple` 降级时
 * `skip5wSynthesis === false`（CPU 5W 机械名保留）。
 */
export async function resolveWorkspaceEffectiveConfig(
  workspaceId: number | null,
  hasInstalledAiEngine?: boolean | null
): Promise<EffectiveWorkspaceAIConfigResult> {
  const orchestrator = ConfigOrchestrator.getInstance()
  const global = {
    analysisMode: orchestrator.getValue<string>('ANALYSIS_MODE'),
    enableImageOcr: orchestrator.getValue<boolean>('ENABLE_IMAGE_OCR'),
    ocrModelSize: orchestrator.getValue<string>('OCR_MODEL_SIZE'),
    maxDocumentOcrItems: orchestrator.getValue<number>('MAX_DOCUMENT_OCR_ITEMS'),
    extractPages: orchestrator.getValue<number>('EXTRACT_PAGES'),
    maxContentSizeKb: orchestrator.getValue<number>('MAX_CONTENT_SIZE_KB'),
    enableOfficeCover: orchestrator.getValue<boolean>('ENABLE_OFFICE_COVER'),
    videoAsrDurationSec: orchestrator.getValue<number>('VIDEO_ASR_DURATION'),
    audioAnalysisDurationSec: orchestrator.getValue<number>('AUDIO_ANALYSIS_DURATION'),
    videoFrameQuotaMax: orchestrator.getValue<number>('VIDEO_FRAME_QUOTA_MAX' as any),
    videoCutSensitivity: orchestrator.getValue<string>('VIDEO_CUT_SENSITIVITY' as any),
    videoSoftTokenBudget: orchestrator.getValue<number>('VIDEO_SOFT_TOKEN_BUDGET'),
    clipTextEnabled: orchestrator.getValue<boolean>('AI_CLIP_TEXT_SEARCH_ENABLED')
  }

  let overrides: Record<string, unknown> = {}
  let policyVersion = 0
  if (workspaceId !== null && workspaceId !== undefined) {
    try {
      const ready = await databaseService.getWorkspaceConfig(workspaceId)
      if (ready && ready.status === 'ready') {
        policyVersion = ready.policyVersion
        overrides = {
          ...(ready.baseAIConfig || {}),
          ...(ready.overrides || {})
        }
      }
    } catch (error) {
      // 显式上报，严禁静默吞掉工作区配置读取失败（AGENTS.md 禁止静默降级）
      console.warn('[WorkspaceAnalysisContext] 工作区配置读取失败，按全局配置降级:', error)
    }
  }

  const rawMode = (overrides.analysisMode as AnalysisMode) || (global.analysisMode as AnalysisMode) || 'full'
  const configuredMode: AnalysisMode =
    rawMode === 'simple' || rawMode === 'quick_name' || rawMode === 'full' ? rawMode : 'full'
  // 生成式引擎未安装/未就绪时强制 simple（保留 CPU 5W 机械名），绝不传 desired 值
  const analysisMode: AnalysisMode = hasInstalledAiEngine === false ? 'simple' : configuredMode
  const ocrSize = overrides.ocrModelSize ?? global.ocrModelSize
  const embeddingProfile =
    (overrides.embeddingProfile as string) || orchestrator.getValue<string>('EMBEDDING_PROFILE' as any) || 'classic_light'

  const effectiveParams: EffectiveWorkspaceAIConfigResult['effectiveParams'] = {
    analysisMode,
    enableImageOcr: readBool(global, overrides, 'enableImageOcr', false),
    ocrModelSize: ocrSize === 'small' ? 'small' : 'tiny',
    maxDocumentOcrItems: readNumber(global, overrides, 'maxDocumentOcrItems', 3),
    extractPages: readNumber(global, overrides, 'extractPages', -1),
    maxContentSizeKb: readNumber(global, overrides, 'maxContentSizeKb', 30),
    enableOfficeCover: readBool(global, overrides, 'enableOfficeCover', false),
    videoAsrDurationSec: readNumber(global, overrides, 'videoAsrDurationSec', 60),
    audioAnalysisDurationSec: readNumber(global, overrides, 'audioAnalysisDurationSec', 30),
    enableVideoVisualAnalysis: embeddingProfile === 'gemma_unified',
    videoFrameQuotaMax: readNumber(global, overrides, 'videoFrameQuotaMax', 60),
    videoCutSensitivity: String(overrides.videoCutSensitivity ?? global.videoCutSensitivity ?? 'medium'),
    videoSoftTokenBudget: readNumber(global, overrides, 'videoSoftTokenBudget', 140),
    clipTextEnabled: readBool(global, overrides, 'clipTextEnabled', true),
    reuseBasicAnalysisData: readBool(global, overrides, 'reuseBasicAnalysisData', true)
  }

  const asrEffectivelyEnabled =
    effectiveParams.videoAsrDurationSec > 0 || effectiveParams.audioAnalysisDurationSec > 0
  const capabilityFingerprint = [
    effectiveParams.analysisMode,
    effectiveParams.ocrModelSize,
    effectiveParams.enableImageOcr,
    effectiveParams.enableOfficeCover,
    effectiveParams.videoAsrDurationSec,
    effectiveParams.audioAnalysisDurationSec,
    embeddingProfile
  ].join('|')

  return {
    effectiveParams,
    capabilities: {
      asrEffectivelyEnabled,
      videoVisualAnalysisEnabled: effectiveParams.enableVideoVisualAnalysis,
      nsfwEffectivelyEnabled: orchestrator.getValue<boolean>('ENABLE_NSFW_PERCEPTION' as any) ?? false,
      faceEffectivelyEnabled: orchestrator.getValue<boolean>('ENABLE_FACE_PERCEPTION' as any) ?? false
    }
  }
}

/** 在文件入口单次锁定工作区分析上下文（OBS-02）。 */
export async function lockWorkspaceAnalysisContext(
  workspaceId: number | null,
  hasInstalledAiEngine?: boolean | null
): Promise<WorkspaceAnalysisContext> {
  const effectiveConfig = await resolveWorkspaceEffectiveConfig(workspaceId, hasInstalledAiEngine)
  let policyVersion = 0
  if (workspaceId !== null && workspaceId !== undefined) {
    try {
      const ready = await databaseService.getWorkspaceConfig(workspaceId)
      if (ready && ready.status === 'ready') policyVersion = ready.policyVersion
    } catch {
      // 已在 resolveWorkspaceEffectiveConfig 中显式上报，此处仅维持默认版本
    }
  }
  return {
    workspaceId,
    policyVersion,
    contextEpoch: getWorkspaceRuntimeContextEpoch(),
    effectiveConfig,
    capabilityFingerprint: [
      policyVersion,
      effectiveParamsKey(effectiveConfig)
    ].join('|')
  }
}

function effectiveParamsKey(config: EffectiveWorkspaceAIConfigResult): string {
  const p = config.effectiveParams
  return [p.ocrModelSize, p.enableImageOcr, p.videoAsrDurationSec, p.audioAnalysisDurationSec, p.enableVideoVisualAnalysis].join('|')
}
