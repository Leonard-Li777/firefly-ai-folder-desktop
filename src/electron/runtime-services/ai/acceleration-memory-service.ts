import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { llamaEngineService } from '../llama/llama-engine-service'
import { LogCategory, logger, shouldUpgradeBestAcceleration } from '@firefly/shared'

/**
 * 最佳可用硬件加速引擎记忆服务
 *
 * 用于持久化记忆"最佳可用引擎"（BEST_ACCELERATION 配置项）：
 * - 记忆标准：成功以该引擎调用了 AI 并正确返回了结果
 * - 等级规则：只能升不能降（假设之前记忆的是 cuda，则不能降级为 vulkan 或 cpu）
 *
 * 说明：当前用户选择的加速引擎（SELECTED_ACCELERATION）可能会因引擎失败主动降级
 * 或用户手动切换而变更，导致启动的可能不是最佳可用引擎。通过本服务在每次 AI
 * 推理成功后自动记录最高等级的可用引擎，供 UI（如 Footer）检测并提示用户切换。
 */
export class AccelerationMemoryService {
  /**
   * 记录一次成功的 AI 推理所用的加速引擎
   *
   * 仅本地 llama.cpp 引擎参与记忆（云端模式 / ollama / llamafile 无硬件加速引擎概念）。
   * 只有当当前引擎等级严格高于已记忆的最佳引擎等级时才升级记忆。
   * 写入失败不影响主流程（AI 推理结果不受影响）。
   *
   * @returns 若成功升级记忆则返回新记忆的引擎名，否则返回 null
   */
  recordSuccessfulInferenceAcceleration(): string | null {
    try {
      const config = ConfigOrchestrator.getInstance()
      const aiServiceMode = config.getValue<string>('AI_SERVICE_MODE')
      const aiEngine = config.getValue<string>('AI_ENGINE')

      // 仅本地 llama.cpp 引擎存在硬件加速引擎概念
      if (aiServiceMode !== 'local' || aiEngine !== 'llama.cpp') return null

      const currentAcc = llamaEngineService.getSelectedAcceleration()
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
        `成功记录最佳可用硬件加速引擎: ${bestAcc} -> ${currentAcc}`
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
