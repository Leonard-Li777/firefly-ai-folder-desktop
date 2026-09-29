import { AnalysisStats } from '@firefly/types'
import { ConfigOrchestrator } from '@app/electron/config/config-orchestrator'
import { LogCategory, logger, PerformanceTimer } from '@firefly/shared'
import { hardwareDetectionService } from '../system'
import { unifiedModelManager } from '../llama/unified-model-manager'
import { engineBridgeService } from '../engine-bridge'
import { isAiStageEnabled, resolveAnalysisMode } from '@app/electron/config/analysis-mode'

/**
 * 分析统计收集器
 * 负责收集分析过程中的硬件、模型和耗时等统计信息
 */
export class AnalysisStatsCollector {
  /**
   * 收集分析统计信息
   */
  async collectAnalysisStats(timer: PerformanceTimer): Promise<AnalysisStats> {
    // 标准分析（simple）模式在 CPU 内容提取完成后即结束，不进入 AI 阶段（stage 3/4），
    // 全程未调用任何 AI 模型。此时不应记录模型信息，否则前端会在「分析耗时」旁
    // 显示一个无意义（甚至错误）的模型标识。门控前置到 try 之外，确保异常兜底分支同样生效。
    const aiStageEnabled = isAiStageEnabled(resolveAnalysisMode())
    try {
      const hardware = await hardwareDetectionService.detectSystemResources()
      const mode = ConfigOrchestrator.getInstance().getValue<string>('AI_SERVICE_MODE')
      // PRD-0044：本地分支模型身份真相 = 萤核AI引擎桥接快照（SELECTED_MODEL_ID 已删除）
      const modelId =
        mode === 'cloud'
          ? ConfigOrchestrator.getInstance().getValue<string>('AI_CLOUD_SELECTED_MODEL_ID')
          : engineBridgeService.getSnapshot().model
      // PRD-0049：当前加速层唯一真相 = 萤核AI引擎桥接快照 backend
      // 不再读取 AI_ENGINE_FORCE_CPU_MODE / AI_ENGINE_DRIVER_COMPATIBLE_MODE / SELECTED_ACCELERATION（残留值会污染判定）
      // 引擎离线（backend 为 null）时为 'unknown'，不回落硬件检测/配置猜路
      const accelerator = engineBridgeService.getSnapshot().backend ?? 'unknown'

      // 仅在启用 AI 阶段（增强/全面分析）时记录模型；标准分析无模型，置为 undefined
      const modelObj = aiStageEnabled
        ? {
            id: modelId || 'unknown',
            name: this.getModelName(modelId || '', mode || 'local'),
            provider: mode || 'local'
          }
        : undefined

      // 获取 GPU 名称和显存
      const gpuInfo = hardware.gpus && hardware.gpus.length > 0 ? hardware.gpus[0] : null

      const durationMs = timer.getTotalDuration()
      const phases = timer.getPhases()

      return {
        hardware: {
          gpu: gpuInfo?.name,
          vram: gpuInfo?.memory ? Math.round((gpuInfo.memory / 1024) * 100) / 100 : undefined,
          platform: process.platform
        },
        performance: {
          fresh: {
            accelerator,
            durationMs,
            phases,
            model: modelObj
          }
        }
      }
    } catch (error) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析统计] 收集统计信息失败:', error)
      const durationMs = timer.getTotalDuration()
      const phases = timer.getPhases()
      const modelObj = aiStageEnabled
        ? { id: 'unknown', name: 'unknown', provider: 'unknown' }
        : undefined
      return {
        hardware: { platform: process.platform },
        performance: {
          fresh: {
            accelerator: 'cpu',
            durationMs,
            phases,
            model: modelObj
          }
        }
      }
    }
  }

  /**
   * 获取模型的友好显示名称
   */
  getModelName(modelId: string, mode: string): string {
    if (!modelId || modelId === 'unknown') return 'unknown'

    try {
      // 1. 如果是云端模式，优先查找云端配置
      if (mode === 'cloud') {
        const providers =
          ConfigOrchestrator.getInstance().getValue<any[]>('CLOUD_MODEL_CONFIGS') || []
        const provider = providers.find(p => p.id === modelId || p.provider === modelId)
        if (provider) {
          const subModel = provider.model
          return subModel
            ? `${subModel} (${provider.name || provider.provider})`
            : provider.name || provider.provider
        }
      }

      // 2. 尝试从本地/Ollama 统一模型管理器中查找友好名称（作为后备或首选）
      unifiedModelManager.ensureLoaded()
      const allModels = unifiedModelManager.getAllModels()
      const model = allModels.find(m => m.id === modelId || m.name === modelId)
      if (model && model.name) return model.name
    } catch (e) {
      logger.debug(LogCategory.ANALYSIS_QUEUE, '[分析统计] 获取模型名称失败:', e)
    }

    // 3. 最后的兜底逻辑：如果没找到友好名称，尝试对 ID 进行简单处理（移除 HF 组织名前缀等）
    if (modelId.length > 30) {
      // 处理 HuggingFace 格式: org/repo:file
      if (modelId.includes('/') && modelId.includes(':')) {
        const parts = modelId.split(':')
        const repoPath = parts[0]
        const repoName = repoPath.split('/').pop()
        if (repoName && repoName.length > 5) {
          return repoName
        }
      }
      // 处理 Ollama 格式: repo:tag
      else if (modelId.includes(':')) {
        return modelId.split(':')[0]
      }
    }

    return modelId
  }
}
