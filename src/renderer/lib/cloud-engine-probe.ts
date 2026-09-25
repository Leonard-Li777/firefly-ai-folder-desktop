/**
 * 云端连通性探针（PRD-0045）
 *
 * 统一复用 CloudModelConfigAPI.testConfig（模型列表优先、极简对话兜底），
 * 不新写轻量请求。成功点亮已启动，失败按生效链路写入错误/引擎异常。
 */
import { logger, LogCategory } from '@firefly/shared'
import { CloudModelConfigAPI } from '../api/cloud-model-config-api'
import type { CloudModelConfig } from '@firefly/types'
import {
  useCloudEngineStatusStore,
  type CloudErrorStage
} from '../stores/cloud-engine-status-store'

export interface ProbeContext {
  /** 当前是否生效引擎=云端；仅 true 时失败会置引擎异常 */
  asActiveEngine: boolean
  /** 失败阶段标注（自动探针/重测默认 chat-probe，拉列表流程可标 fetch-models） */
  stage?: CloudErrorStage
}

/**
 * 执行云端探针并更新引擎状态。
 * @returns 是否探针成功
 */
export async function runCloudProbe(
  config: CloudModelConfig,
  ctx: ProbeContext
): Promise<boolean> {
  const store = useCloudEngineStatusStore.getState()
  store.beginProbe()
  try {
    await CloudModelConfigAPI.testConfig(config)
    // 探针成功仅点亮已启动；「已拉取模型列表」只在真正拿到在线列表时计入（slice-2 严格条件）
    useCloudEngineStatusStore.getState().markStarted()
    try {
      const models = await CloudModelConfigAPI.getProviderModels(
        config.provider,
        config.apiKey,
        config.baseUrl,
        false
      )
      if (models.length > 0) {
        useCloudEngineStatusStore.getState().markModelsFetched()
      }
    } catch {
      // 列表拉取失败不影响已启动；已连接保持严格条件
    }
    return true
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(LogCategory.RENDERER, '[CloudProbe] 失败:', message)
    useCloudEngineStatusStore.getState().markFailed(
      {
        provider: config.provider || '',
        model: config.model || '',
        stage: ctx.stage || 'chat-probe',
        message
      },
      { asActiveEngine: ctx.asActiveEngine }
    )
    return false
  }
}

/** 分析管线云端调用成功：点亮已启动（PRD-0045 user story #10） */
export function notifyCloudAnalyzeSuccess(): void {
  useCloudEngineStatusStore.getState().markStarted()
}

/** 分析管线云端调用失败：生效时置引擎异常 */
export function notifyCloudAnalyzeFailure(message: string, meta: { provider: string; model: string; asActiveEngine: boolean }): void {
  useCloudEngineStatusStore.getState().markFailed(
    { provider: meta.provider, model: meta.model, stage: 'analyze', message },
    { asActiveEngine: meta.asActiveEngine }
  )
}
