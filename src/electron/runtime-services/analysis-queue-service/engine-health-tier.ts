import { logger, LogCategory } from '@firefly/shared'
import { AIServiceManager } from './ai-service-manager'

/**
 * Manages engine health checks, service readiness, and retry logic.
 */
export class EngineHealthTier {
  constructor(private aiServiceManager: AIServiceManager) {}

  async waitForReady(): Promise<boolean> {
    return await this.aiServiceManager.waitForAIServiceReady()
  }

  logWarning(message: string, error?: any) {
    logger.warn(LogCategory.ANALYSIS_QUEUE, message, error)
  }
}
