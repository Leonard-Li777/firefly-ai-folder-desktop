import { ipcMain } from 'electron'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { llamaEngineService } from '../../runtime-services/llama/llama-engine-service'
import { logger, LogCategory, isTestEnvironment } from '@firefly/shared'
import { initializeFullServices } from '../initialization'
import { StartupPhase } from '@firefly/types'
import { globalLlamaIndexService } from '../state'
import type { AppConfig, ConfigKey } from '@firefly/types'
import {
  registerCloudModelConfigIPCHandlers,
  registerLocalModelConfigIPCHandlers,
  registerSettingsIPCHandlers
} from '../../runtime-services/ipc'

export function registerConfigIPCHandlers() {
  ipcMain.handle('get-config', async () => {
    return ConfigOrchestrator.getInstance().getConfig()
  })

  ipcMain.handle('update-config', async (event, updates: Partial<AppConfig>) => {
    await ConfigOrchestrator.getInstance().updateConfig(updates)
  })

  ipcMain.handle('startup/get-flags', async () => {
    const isEngineReady = await llamaEngineService.isEngineReady()
    const orchestrator = ConfigOrchestrator.getInstance()
    const aiServiceMode = orchestrator.getValue<string>('AI_SERVICE_MODE')
    const needsEngineForce = aiServiceMode === 'local' && !isEngineReady

    if (needsEngineForce) {
      logger.info(LogCategory.MAIN, '检测到 AI 引擎未部署，强制进入配置阶段')
    }

    const cliForceConfigStage =
      process.argv.includes('--force-config-stage') ||
      process.env.FORCE_CONFIG_STAGE === '1' ||
      process.env.FORCE_CONFIG_STAGE?.toLowerCase() === 'true'

    if (isTestEnvironment()) {
      return { forceConfigStage: false }
    }

    return {
      forceConfigStage: cliForceConfigStage || needsEngineForce
    }
  })

  ipcMain.handle('startup/initialize-phase', async () => {
    await initializeFullServices()
  })

  ipcMain.handle(
    'config/update-value',
    async (_event, key: ConfigKey, value: unknown, options?: any) => {
      await ConfigOrchestrator.getInstance().updateValue(key, value, options)

      if (key === 'IS_FIRST_RUN' && value === false && globalLlamaIndexService) {
        const currentPhase = globalLlamaIndexService.getCurrentPhaseState()
        if (currentPhase.currentPhase === StartupPhase.CONFIGURATION && !currentPhase.isCompleted) {
          logger.info(LogCategory.MAIN, '检测到首次运行结束，标记 AI 服务配置阶段为已完成')
          globalLlamaIndexService.completeCurrentPhase()
        }
      }
    }
  )

  ipcMain.handle('config/get-value', async (_event, key: ConfigKey) => {
    return ConfigOrchestrator.getInstance().getValue(key)
  })

  registerSettingsIPCHandlers()
  registerCloudModelConfigIPCHandlers()
  registerLocalModelConfigIPCHandlers()
}
