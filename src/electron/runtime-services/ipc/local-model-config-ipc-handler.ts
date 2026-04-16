import { ipcMain } from 'electron'
import { logger, LogCategory } from '@yonuc/shared'
import { ModelConfigService } from '../analysis/model-config-service'
import { configService } from '../config'
import { modelService } from '../llama/model-service'

export function registerLocalModelConfigIPCHandlers(): void {
  logger.info(LogCategory.IPC, '注册本地模型配置相关 IPC 处理器...')

  ipcMain.handle('local-model-config/apply-url', async (_event, baseUrl: string) => {
    const trimmed = (baseUrl || '').trim()

    configService.updateValue('MODEL_CONFIG_URL', trimmed)

    const language = configService.getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN'

    const modelConfigService = ModelConfigService.getInstance()
    modelConfigService.clearCache()

    // 重新加载模型配置
    modelConfigService.loadModelConfig(language)

    return modelService.listModels()
  })
}
