import { ipcMain } from 'electron'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { engineBridgeService } from '../../runtime-services/engine-bridge'
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
    // Tier 2 引擎（firefly-ai-engine）为独立应用：启动早期 snapshot.connected 依赖 lastRawStatus，
    // 此时尚未轮询，必须先做一次端口探活，再叠加「本地已部署（可执行文件存在）」判断；
    // 否则引擎已在 38400 运行但 exe 路径解析失败时会误判未部署并强制进入配置阶段。
    if (engineBridgeService.getSnapshot().circuitState !== 'open') {
      await engineBridgeService.healthCheck().catch(() => null)
    }
    const snapshot = engineBridgeService.getSnapshot()
    const isEngineReady = snapshot.connected || snapshot.available
    const orchestrator = ConfigOrchestrator.getInstance()
    // 残留 AI_ENGINE=ollama 配置强制回落本地 Tier 2（PRD-0042 清退内置 Ollama 推理）
    const configuredEngine = orchestrator.getValue<string>('AI_ENGINE')
    if (configuredEngine === 'ollama') {
      await orchestrator.updateValue('AI_ENGINE', 'llama.cpp', { preventAutoReload: true }).catch(() => undefined)
      logger.warn(LogCategory.MAIN, '检测到残留 AI_ENGINE=ollama，已回落为 llama.cpp（Tier 2 桥接）')
    }
    const aiServiceMode = orchestrator.getValue<string>('AI_SERVICE_MODE')
    const needsEngineForce = aiServiceMode === 'local' && !isEngineReady

    if (needsEngineForce) {
      logger.info(LogCategory.MAIN, '检测到 Tier 2 AI 引擎未部署，强制进入配置阶段')
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

