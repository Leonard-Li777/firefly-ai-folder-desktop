import { AnalysisStats } from '@firefly/types'
import { ConfigOrchestrator } from '@app/electron/config/config-orchestrator'
import { LogCategory, logger, PerformanceTimer } from '@firefly/shared'
import { hardwareDetectionService } from '../system'
import { unifiedModelManager } from '../llama/unified-model-manager'
import { engineBridgeService } from '../engine-bridge'
import { isAiStageEnabled, resolveAnalysisMode } from '@app/electron/config/analysis-mode'

/**
 * 判断标识是否为物理文件路径（Windows 盘符路径 / UNC / POSIX 绝对路径 / 模型权重文件）。
 *
 * 物理路径**严禁**作为模型展示名透出（历史缺陷：`D:\models\xxx.gguf` 被当成
 * Ollama 的 `repo:tag` 切割，返回盘符 `D`，前端显示 `分析耗时: 0:07(D)`）。
 */
export function isModelPhysicalPath(identifier: string): boolean {
  if (!identifier) return false
  if (/^[a-zA-Z]:[\\/]/.test(identifier)) return true // D:\... 或 D:/...
  if (/^\\\\/.test(identifier)) return true // \\server\share
  if (identifier.includes('\\')) return true // 含反斜杠
  if (identifier.startsWith('/')) return true // POSIX 绝对路径
  return /\.(gguf|bin|safetensors)$/i.test(identifier)
}

/**
 * 判断候选展示名是否只是「从物理路径派生的文件名主干」（含原样回吐标识本身的情形）。
 *
 * 用于拒绝把路径当模型名展示：模型展示名必须来自**模型配置的 name 字段**，
 * 而不是对路径做 basename / 截断得到的产物。
 */
export function isPathDerivedModelName(identifier: string, candidate: string): boolean {
  if (!identifier || !candidate) return false
  if (candidate === identifier) return true
  const stem = identifier.replace(/\\/g, '/').split('/').pop()?.replace(/\.[^.]+$/, '') ?? ''
  return stem.length > 0 && candidate === stem
}

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
      const engineSnapshot = engineBridgeService.getSnapshot()
      const modelId =
        mode === 'cloud'
          ? ConfigOrchestrator.getInstance().getValue<string>('AI_CLOUD_SELECTED_MODEL_ID')
          : engineSnapshot.model
      // PRD-0049：当前加速层唯一真相 = 萤核AI引擎桥接快照 backend
      // 不再读取 AI_ENGINE_FORCE_CPU_MODE / AI_ENGINE_DRIVER_COMPATIBLE_MODE / SELECTED_ACCELERATION（残留值会污染判定）
      // 引擎离线（backend 为 null）时为 'unknown'，不回落硬件检测/配置猜路
      const accelerator = engineSnapshot.backend ?? 'unknown'

      // 仅在启用 AI 阶段（增强/全面分析）时记录模型；标准分析无模型，置为 undefined。
      //
      // 展示名**只取模型配置的 name 字段**：
      //   1. 引擎桥接快照 modelName —— 引擎按模型配置（model_zh-CN.json）的 name 反查所得；
      //   2. 本地模型配置反查（统一模型配置 / 内置模型目录），见 getModelName。
      // 若两者都拿不到真正的配置名（或拿到的只是从路径派生的文件名主干），
      // 则不记录模型 —— 前端因此不渲染括号，而不是显示盘符/路径等占位内容。
      const engineModelName =
        mode === 'cloud' ||
        !engineSnapshot.modelName ||
        isPathDerivedModelName(engineSnapshot.model || '', engineSnapshot.modelName)
          ? null
          : engineSnapshot.modelName
      const resolvedModelName =
        engineModelName || this.getModelName(modelId || '', mode || 'local')
      const modelObj =
        aiStageEnabled && resolvedModelName && resolvedModelName !== 'unknown'
          ? {
              id: modelId || 'unknown',
              name: resolvedModelName,
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
      // 收集失败时拿不到可信的模型配置名，宁可不记录，也不写 'unknown' 让前端冒出 (unknown) 占位
      return {
        hardware: { platform: process.platform },
        performance: {
          fresh: {
            accelerator: 'cpu',
            durationMs,
            phases,
            model: undefined
          }
        }
      }
    }
  }

  /**
   * 从「模型配置」解析模型的展示名（配置条目的 name 字段）。
   *
   * 数据源优先级：
   *   1. 云端：CLOUD_MODEL_CONFIGS 条目的 model / name；
   *   2. 本地：统一模型配置（统一配置中心）条目的 name；
   *   3. 本地：内置模型目录（模型配置 model_zh-CN.json）按标识/路径反查 name。
   *
   * **绝不从物理路径/文件名派生名称** —— 历史缺陷正是把 `D:\models\xxx.gguf`
   * 当成 Ollama 的 `repo:tag` 切割，返回盘符 `D`。
   * 无法从配置解析时：非路径标识（受控码 / 模型 id）原样返回，物理路径返回 'unknown'，
   * 由调用方据此决定「不渲染」，而非显示占位内容。
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

      // 2. 本地：统一模型配置条目的 name 字段（作为后备或首选）
      unifiedModelManager.ensureLoaded()
      const allModels = unifiedModelManager.getAllModels()
      const model = allModels.find(m => m.id === modelId || m.name === modelId)
      if (model && model.name) return model.name

      // 3. 本地：内置模型目录（模型配置 model_zh-CN.json）按标识/路径反查 name 字段。
      //    仅接受真正的配置名，拒绝引擎桥接退化成「路径文件名主干」的结果。
      const catalogName = engineBridgeService.resolveFriendlyModelName(modelId)
      if (catalogName && !isPathDerivedModelName(modelId, catalogName)) {
        return catalogName
      }
    } catch (e) {
      logger.debug(LogCategory.ANALYSIS_QUEUE, '[分析统计] 获取模型名称失败:', e)
    }

    // 4. 兜底：非路径标识（受控码 / 模型 id）可原样展示；物理路径一律不透出
    return isModelPhysicalPath(modelId) ? 'unknown' : modelId
  }
}
