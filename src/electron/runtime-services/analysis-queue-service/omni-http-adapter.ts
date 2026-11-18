import { engineBridgeService } from '../engine-bridge'
import { logger, LogCategory } from '@firefly/shared'

/**
 * Omni HTTP adapter to abstract engine-bridge and HTTP related operations.
 */
export class OmniHttpAdapter {
  async ensureMode(mode: 'language' | 'standard'): Promise<{ ok: boolean; error?: string }> {
    try {
      const modeRes = await engineBridgeService?.ensureMode?.(mode)
      return { ok: modeRes?.ok ?? true, error: modeRes?.error }
    } catch (err: any) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, `[OmniHttpAdapter] ensureMode(${mode}) failed:`, err)
      return { ok: false, error: err?.message }
    }
  }

  getBackendSnapshot() {
    return engineBridgeService.getSnapshot()
  }
}
