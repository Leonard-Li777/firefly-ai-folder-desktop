import { ipcMain } from 'electron'
import { logger, LogCategory } from '@yonuc/shared'
import { ModelConfigService } from '../analysis/model-config-service'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { modelService } from '../llama/model-service'
import { modelMigrationService } from '../llama/model-migration-service'
import { unifiedModelManager } from '../llama/unified-model-manager'

export function registerLocalModelConfigIPCHandlers(): void {
  logger.info(LogCategory.IPC, '注册本地模型配置相关 IPC 处理器...')

  ipcMain.handle('llama/migrate-builtin-models', async (_event, targetDir?: string) => {
    logger.info(LogCategory.IPC, `[IPC] 收到模型迁移请求, 参数目录: ${targetDir || '未提供'}`)
    
    // 如果未提供目录，从配置中读取
    const finalDir = targetDir || unifiedModelManager.getModelBaseDir()
    
    if (!finalDir) {
      logger.warn(LogCategory.IPC, '模型迁移失败: 未提供目标目录且配置中也未设置 MODEL_STORAGE_PATH')
      return { success: false, error: 'No target directory provided' }
    }

    return await modelMigrationService.migrateModels(finalDir, false, true)
  })

  ipcMain.handle('llama/migrate-from-old-path', async (_event, oldPath: string, newPath: string) => {
    logger.info(LogCategory.IPC, `[IPC] 收到模型迁移请求: ${oldPath} -> ${newPath}`)
    return await modelMigrationService.migrateFromOldPath(oldPath, newPath)
  })

}
