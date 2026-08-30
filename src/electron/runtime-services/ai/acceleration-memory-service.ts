import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { LlamaServerService } from '@firefly/electron-llamaIndex-service'
import {
  LogCategory,
  logger,
  shouldUpgradeBestAcceleration,
  extractAccelerationFromBinaryPath
} from '@firefly/shared'

/**
 * 最佳可用硬件加速引擎记忆服务
 *
 * 用于持久化记忆"最佳可用引擎"（BEST_ACCELERATION 配置项）：
 * - 记忆标准：成功发送 hello 校验并收到回应（模型真正可用）时，记录**实际运行**的加速引擎
 * - 等级规则：只能升不能降（假设之前记忆的是 cuda，则不能降级为 vulkan 或 cpu）
 *
 * 说明：当前用户选择的加速引擎（SELECTED_ACCELERATION）是部署期静态选定的值，可能因引擎
 * 失败主动降级或用户手动切换而变更，与真正回应 hello 校验的运行引擎不一致。因此本服务
 * 从实际运行的二进制路径（binaryPath）中提取真实加速类型进行记忆，供 UI（如 Footer）
 * 检测并提示用户切换。
 */
export class AccelerationMemoryService {
  private isListenerSetup = false

  constructor() {
    this.setupServiceStartedListener()
  }

  /**
   * 监听服务启动事件（service-started 在 hello 校验成功、模型真正可用后触发），
   * 从实际运行的二进制路径提取加速引擎并记忆最佳可用引擎。
   */
  private setupServiceStartedListener(): void {
    if (this.isListenerSetup) return

    const attach = () => {
      if (this.isListenerSetup) return
      try {
        const serverService = LlamaServerService.getInstance()
        if (serverService && typeof (serverService as any).on === 'function') {
          this.isListenerSetup = true
          ;(serverService as any).on('service-started', (startedProcess: any) => {
            try {
              const binaryPath = startedProcess?.config?.binaryPath
              if (!binaryPath || binaryPath === 'external') return
              this.recordVerifiedAccelerationFromBinaryPath(binaryPath)
            } catch (err) {
              logger.warn(
                LogCategory.AI_SERVICE,
                '服务启动时记录最佳可用引擎发生异常（不影响主流程）:',
                err
              )
            }
          })
        }
      } catch (err) {
        logger.warn(LogCategory.AI_SERVICE, '注册服务启动事件监听失败:', err)
      }
    }

    // 延迟到事件循环下一刻度执行，避免模块加载时的 TDZ 问题
    if (typeof setImmediate === 'function') {
      setImmediate(attach)
    } else {
      setTimeout(attach, 0)
    }
  }

  /**
   * 记录一次成功的 AI 推理所用的加速引擎
   *
   * 推理成功意味着服务处于运行状态（hello 校验必然已经通过），因此从当前运行进程的
   * 二进制路径提取实际加速引擎进行记忆，而非读取部署期静态选定的引擎。
   * 仅本地 llama.cpp 引擎参与记忆（云端模式 / ollama / llamafile 无硬件加速引擎概念）。
   * 只有当当前引擎等级严格高于已记忆的最佳引擎等级时才升级记忆。
   * 写入失败不影响主流程（AI 推理结果不受影响）。
   *
   * @returns 若成功升级记忆则返回新记忆的引擎名，否则返回 null
   */
  recordSuccessfulInferenceAcceleration(): string | null {
    try {
      const serverService = LlamaServerService.getInstance()
      const binaryPath = serverService.getProcessInfo()?.config?.binaryPath
      if (!binaryPath || binaryPath === 'external') return null
      return this.recordVerifiedAccelerationFromBinaryPath(binaryPath)
    } catch (err) {
      logger.warn(LogCategory.AI_SERVICE, '记录最佳可用引擎时发生异常（不影响主流程）:', err)
      return null
    }
  }

  /**
   * 从实际运行的二进制路径中提取加速引擎并记忆最佳可用引擎
   *
   * @param binaryPath 实际运行的二进制文件路径（来自进程信息或服务启动事件）
   * @returns 若成功升级记忆则返回新记忆的引擎名，否则返回 null
   */
  private recordVerifiedAccelerationFromBinaryPath(binaryPath: string): string | null {
    try {
      const config = ConfigOrchestrator.getInstance()
      const aiServiceMode = config.getValue<string>('AI_SERVICE_MODE')
      const aiEngine = config.getValue<string>('AI_ENGINE')

      // 仅本地 llama.cpp 引擎存在硬件加速引擎概念
      if (aiServiceMode !== 'local' || aiEngine !== 'llama.cpp') return null

      const currentAcc = extractAccelerationFromBinaryPath(binaryPath)
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
        `成功记录最佳可用硬件加速引擎: ${bestAcc} -> ${currentAcc}（实际运行二进制: ${binaryPath}）`
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
