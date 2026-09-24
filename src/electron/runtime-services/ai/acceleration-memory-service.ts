import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { LlamaServerService } from '@firefly/electron-llamaIndex-service'
import {
  LogCategory,
  logger,
  shouldUpgradeBestAcceleration,
  extractAccelerationFromBackendDisplay
} from '@firefly/shared'

/**
 * 最佳可用硬件加速引擎记忆服务
 *
 * 用于持久化记忆"最佳可用引擎"（BEST_ACCELERATION 配置项）：
 * - 记忆标准：成功发送 hello 校验并收到回应（模型真正可用）时，记录**实际运行**的加速引擎
 * - 等级规则：只能升不能降（假设之前记忆的是 cuda，则不能降级为 vulkan 或 cpu）
 *
 * 说明：本地推理已外置为 Tier 2 独立引擎（firefly-ai-engine），desktop 不再持有推理进程，
 * 实际运行的加速后端由引擎状态端点（/api/engine/status 的 backend 字段）上报。
 * 因此本服务在成功推理时从引擎上报的后端描述中提取真实加速类型进行记忆，
 * 供 UI（如 Footer）检测并提示用户切换。
 */
export class AccelerationMemoryService {
  /**
   * 记录一次成功的 AI 推理所用的加速引擎
   *
   * 推理成功意味着服务处于运行状态（hello 校验必然已经通过），因此从外部 Tier 2 引擎
   * 上报的运行状态中提取实际加速引擎进行记忆，而非读取部署期静态选定的引擎。
   * 仅本地 llama.cpp 引擎参与记忆（云端模式 / ollama / llamafile 无硬件加速引擎概念）。
   * 只有当当前引擎等级严格高于已记忆的最佳引擎等级时才升级记忆。
   * 写入失败不影响主流程（AI 推理结果不受影响）。
   *
   * @returns 若成功升级记忆则返回新记忆的引擎名，否则返回 null
   */
  recordSuccessfulInferenceAcceleration(): string | null {
    try {
      const serverService = LlamaServerService.getInstance()
      const engineStatus = serverService.getExternalEngineStatus?.()
      const backend = engineStatus?.backend || engineStatus?.active_backend
      if (!backend) return null
      return this.recordVerifiedAccelerationFromBackend(backend)
    } catch (err) {
      logger.warn(LogCategory.AI_SERVICE, '记录最佳可用引擎时发生异常（不影响主流程）:', err)
      return null
    }
  }

  /**
   * 从实际运行的加速后端描述中提取加速引擎并记忆最佳可用引擎
   *
   * @param backend 引擎状态上报的运行后端（如 "cuda"、"Vulkan"、"NVIDIA(cpu)"）
   * @returns 若成功升级记忆则返回新记忆的引擎名，否则返回 null
   */
  private recordVerifiedAccelerationFromBackend(backend: string): string | null {
    try {
      const config = ConfigOrchestrator.getInstance()
      const aiServiceMode = config.getValue<string>('AI_SERVICE_MODE')
      const aiEngine = config.getValue<string>('AI_ENGINE')

      // 仅本地 llama.cpp 引擎存在硬件加速引擎概念
      if (aiServiceMode !== 'local' || aiEngine !== 'llama.cpp') return null

      const currentAcc = extractAccelerationFromBackendDisplay(backend)
      if (!currentAcc) return null

      const bestAcc = config.getValue<string>('BEST_ACCELERATION') || 'auto'

      // 等级只能升不能降：当前引擎等级必须严格高于已记忆的最佳引擎等级才升级
      if (!shouldUpgradeBestAcceleration(currentAcc, bestAcc)) return null

      const updatePromise = config.updateValue('BEST_ACCELERATION', currentAcc, {
        source: 'runtime',
        preventAutoReload: true
      })
      if (updatePromise && typeof updatePromise.catch === 'function') {
        updatePromise.catch(err => {
          logger.error(LogCategory.AI_SERVICE, '记录最佳可用引擎失败:', err)
        })
      }

      logger.info(
        LogCategory.AI_SERVICE,
        `成功记录最佳可用硬件加速引擎: ${bestAcc} -> ${currentAcc}（引擎上报后端: ${backend}）`
      )
      return currentAcc
    } catch (err) {
      logger.warn(LogCategory.AI_SERVICE, '记录最佳可用引擎时发生异常（不影响主流程）:', err)
      return null
    }
  }

  /**
   * 获取已记忆的最佳可用硬件加速引擎（auto 或未记忆时返回 null）
   */
  getBestAcceleration(): string | null {
    try {
      const best = ConfigOrchestrator.getInstance().getValue<string>('BEST_ACCELERATION')
      return best && best !== 'auto' ? best : null
    } catch (err) {
      logger.warn(LogCategory.AI_SERVICE, '读取最佳可用引擎失败:', err)
      return null
    }
  }
}

/**
 * 最佳可用引擎记忆服务单例
 */
export const accelerationMemoryService = new AccelerationMemoryService()
