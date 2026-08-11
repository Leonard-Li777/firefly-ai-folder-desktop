import { AnalysisStats } from '@firefly/types'
import { ConfigOrchestrator } from '@app/electron/config/config-orchestrator'
import { LogCategory, logger, PerformanceTimer } from '@firefly/shared'
import { hardwareDetectionService } from '../system'
import { unifiedModelManager } from '../llama/unified-model-manager'
import { llamaEngineService } from '../llama/llama-engine-service'

/**
 * 分析统计收集器
 * 负责收集分析过程中的硬件、模型和耗时等统计信息
 */
export class AnalysisStatsCollector {
  /**
   * 收集分析统计信息
   */
  async collectAnalysisStats(timer: PerformanceTimer): Promise<AnalysisStats> {
    try {
      const hardware = await hardwareDetectionService.detectSystemResources()
      const mode = ConfigOrchestrator.getInstance().getValue<string>('AI_SERVICE_MODE')
      const modelId = ConfigOrchestrator.getInstance().getValue<string>(
        mode === 'cloud' ? 'AI_CLOUD_SELECTED_MODEL_ID' : 'SELECTED_MODEL_ID'
      )
      // 读取当前引擎实际运行的加速层，优先级：
      // 1. 强制 CPU 模式 → 'cpu'
      // 2. 驱动兼容（Vulkan）模式 → 'vulkan'
      // 3. llamaEngineService 运行时加速层（最准确的实际值）
      // 4. 配置 SELECTED_ACCELERATION
      // 5. 硬件最佳加速层（不硬编码厂商，由 hardwareDetectionService 判断）
      const config = ConfigOrchestrator.getInstance()
      const isForceCpu = config.getValue<boolean>('AI_ENGINE_FORCE_CPU_MODE')
      const isCompatible = config.getValue<boolean>('AI_ENGINE_DRIVER_COMPATIBLE_MODE')
      let accelerator: string
      if (isForceCpu) {
        accelerator = 'cpu'
      } else if (isCompatible) {
        accelerator = 'vulkan'
      } else {
        // 优先取引擎运行时实际值，其次取配置，最后由硬件能力检测决定
        const runtimeAcc = llamaEngineService.getSelectedAcceleration()
        const configAcc = config.getValue<string>('SELECTED_ACCELERATION')
        if (runtimeAcc) {
          accelerator = runtimeAcc
        } else if (configAcc) {
          accelerator = configAcc
        } else {
          accelerator = await hardwareDetectionService.getBestAccelerationTier()
        }
      }

      // 获取模型名称
      const modelName = this.getModelName(modelId || '', mode || 'local')

      // 获取 GPU 名称和显存
      const gpuInfo = hardware.gpus && hardware.gpus.length > 0 ? hardware.gpus[0] : null

      const modelObj = {
        id: modelId || 'unknown',
        name: modelName,
        provider: mode || 'local'
      }

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
      const modelObj = { id: 'unknown', name: 'unknown', provider: 'unknown' }
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
