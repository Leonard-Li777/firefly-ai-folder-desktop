import {
  LogCategory,
  logger,
  resolveEffectiveAIConfig,
  type EffectiveWorkspaceAIConfigResult as SharedEffectiveWorkspaceAIConfigResult,
  type WorkspaceRuntimeContext
} from '@firefly/shared'
import { DEFAULT_UNBOUND_AI_CONFIG } from '@firefly/types'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { databaseService } from '../database/database-service'
import {
  getWorkspaceRuntimeContextEpoch,
  workspaceRuntimeContextService
} from './workspace-runtime-context-service'
import type { AnalysisMode } from '../../config/analysis-mode'

/**
 * 主进程工作区运行时有效配置契约：
 * 直接基于 `@firefly/shared` 权威 `resolveEffectiveAIConfig()` 输出，
 * 并附带 `videoFrameQuotaMax` / `enableVideoVisualAnalysis` 兼容别名供既有 `file-processor` 无缝消费。
 */
export interface EffectiveWorkspaceAIConfigResult extends SharedEffectiveWorkspaceAIConfigResult {
  effectiveParams: SharedEffectiveWorkspaceAIConfigResult['effectiveParams'] & {
    analysisMode: AnalysisMode
    /** 与 `videoQuotaMax` 同源，兼容既有 `file-processor` 读取 */
    videoFrameQuotaMax: number
    /** 与 `capabilities.videoVisualAnalysisEnabled` 同源，兼容既有 `file-processor` 读取 */
    enableVideoVisualAnalysis: boolean
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

/** 无工作区配置时的回退构造（仅在无 ready 工作区时尊重全局 REUSE_BASIC_ANALYSIS_DATA 兼容单测与无区场景） */
function buildUnboundFallbackInput() {
  const reuse = ConfigOrchestrator.getInstance().getValue<boolean>('REUSE_BASIC_ANALYSIS_DATA')
  return {
    baseAIConfig: {
      ...DEFAULT_UNBOUND_AI_CONFIG,
      ...(typeof reuse === 'boolean' ? { reuseBasicAnalysisData: reuse } : {})
    }
  }
}

/**
 * 基于工作区 `WorkspaceConfigReady` 与主进程权威 `WorkspaceRuntimeContext`
 * 调用 `@firefly/shared::resolveEffectiveAIConfig()` 实时计算生效配置。
 * `hasInstalledAiEngine` 若由调用方显式传入 `false`，覆盖 `isGenerativeAiEnabled = false`
 * 确保 `simple` 降级时 `skip5wSynthesis === false`（保留 CPU 5W 机械命名）。
 */
export async function resolveWorkspaceEffectiveConfig(
  workspaceId: number | null,
  hasInstalledAiEngine?: boolean | null
): Promise<EffectiveWorkspaceAIConfigResult> {
  let readyConfig = null
  if (workspaceId !== null && workspaceId !== undefined) {
    try {
      const cfg = await databaseService.getWorkspaceConfig(workspaceId)
      if (cfg && cfg.status === 'ready') {
        readyConfig = cfg
      }
    } catch (error) {
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        '[WorkspaceAnalysisContext] 工作区配置读取失败，按未绑定系统默认基线解析:',
        error
      )
    }
  }

  const baseRuntime: WorkspaceRuntimeContext = workspaceRuntimeContextService.getRuntimeContext()
  const runtimeContext: WorkspaceRuntimeContext =
    hasInstalledAiEngine === false
      ? { ...baseRuntime, isGenerativeAiEnabled: false }
      : hasInstalledAiEngine === true
        ? { ...baseRuntime, isGenerativeAiEnabled: true }
        : baseRuntime

  const resolved = resolveEffectiveAIConfig(
    readyConfig ?? buildUnboundFallbackInput(),
    runtimeContext
  )
  return {
    ...resolved,
    effectiveParams: {
      ...resolved.effectiveParams,
      analysisMode: resolved.effectiveParams.analysisMode as AnalysisMode,
      videoFrameQuotaMax: resolved.capabilities.videoVisualAnalysisEnabled
        ? resolved.effectiveParams.videoQuotaMax
        : 0,
      enableVideoVisualAnalysis: resolved.capabilities.videoVisualAnalysisEnabled
    }
  }
}

/** 在文件入口单次锁定工作区分析上下文（OBS-02）：消费已同步升级 `presetVersion: 2` 的最新 `policyVersion`。 */
export async function lockWorkspaceAnalysisContext(
  workspaceId: number | null,
  hasInstalledAiEngine?: boolean | null
): Promise<WorkspaceAnalysisContext> {
  let readyConfig = null
  let policyVersion = 0
  if (workspaceId !== null && workspaceId !== undefined) {
    try {
      const cfg = await databaseService.getWorkspaceConfig(workspaceId)
      if (cfg && cfg.status === 'ready') {
        readyConfig = cfg
        policyVersion = cfg.policyVersion
      }
    } catch (error) {
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        '[WorkspaceAnalysisContext] 锁定快照读取工作区配置失败:',
        error
      )
    }
  }

  const baseRuntime: WorkspaceRuntimeContext = workspaceRuntimeContextService.getRuntimeContext()
  const runtimeContext: WorkspaceRuntimeContext =
    hasInstalledAiEngine === false
      ? { ...baseRuntime, isGenerativeAiEnabled: false }
      : hasInstalledAiEngine === true
        ? { ...baseRuntime, isGenerativeAiEnabled: true }
        : baseRuntime

  const resolved = resolveEffectiveAIConfig(
    readyConfig ?? buildUnboundFallbackInput(),
    runtimeContext
  )
  const effectiveConfig: EffectiveWorkspaceAIConfigResult = {
    ...resolved,
    effectiveParams: {
      ...resolved.effectiveParams,
      analysisMode: resolved.effectiveParams.analysisMode as AnalysisMode,
      videoFrameQuotaMax: resolved.capabilities.videoVisualAnalysisEnabled
        ? resolved.effectiveParams.videoQuotaMax
        : 0,
      enableVideoVisualAnalysis: resolved.capabilities.videoVisualAnalysisEnabled
    }
  }

  const ep = effectiveConfig.effectiveParams
  const capabilityFingerprint = [
    ep.analysisMode,
    ep.ocrModelSize,
    ep.enableImageOcr,
    ep.enableOfficeCover,
    ep.videoAsrDurationSec,
    ep.audioAnalysisDurationSec,
    effectiveConfig.capabilities.asrEffectivelyEnabled,
    effectiveConfig.capabilities.videoVisualAnalysisEnabled,
    runtimeContext.globalEmbeddingProfile
  ].join('|')

  return {
    workspaceId,
    policyVersion,
    contextEpoch: getWorkspaceRuntimeContextEpoch(),
    effectiveConfig,
    capabilityFingerprint
  }
}
