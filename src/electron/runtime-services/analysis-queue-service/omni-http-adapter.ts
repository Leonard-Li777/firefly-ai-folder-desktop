import { engineBridgeService } from '../engine-bridge'
import { logger, LogCategory } from '@firefly/shared'

/**
 * 引擎桥接适配器：收口模式切换与快照读取。
 *
 * 严禁静默降级为 `{ ok: true }`，底层桥接缺失或返回异常时必须显式返回失败并记录告警。
 */
export class OmniHttpAdapter {
  async ensureMode(
    mode: 'language' | 'embedding',
    options?: { force?: boolean }
  ): Promise<{ ok: boolean; code?: string; canDegrade?: boolean; error?: string }> {
    if (!engineBridgeService || typeof engineBridgeService.ensureMode !== 'function') {
      const error = 'engineBridgeService.ensureMode 不可用'
      logger.warn(LogCategory.ANALYSIS_QUEUE, `[OmniHttpAdapter] ensureMode(${mode}): ${error}`)
      return { ok: false, error }
    }
    try {
      const modeRes = await engineBridgeService.ensureMode(mode, options)
      if (!modeRes || typeof modeRes.ok !== 'boolean') {
        const error = 'ensureMode 返回空响应或格式异常'
        logger.warn(LogCategory.ANALYSIS_QUEUE, `[OmniHttpAdapter] ensureMode(${mode}): ${error}`)
        return { ok: false, error }
      }
      return modeRes
    } catch (err: any) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, `[OmniHttpAdapter] ensureMode(${mode}) failed:`, err)
      return { ok: false, error: err?.message ?? String(err) }
    }
  }

  getBackendSnapshot() {
    return engineBridgeService.getSnapshot()
  }

  hasInstalledEngines(): boolean {
    return engineBridgeService.hasInstalledEngines !== false
  }
}
