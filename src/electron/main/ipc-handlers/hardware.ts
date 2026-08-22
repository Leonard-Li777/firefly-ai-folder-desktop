import { ipcMain } from 'electron'
import { modelService } from '../../runtime-services/llama/model-service'
import { unifiedModelManager } from '../../runtime-services/llama/unified-model-manager'

export function registerHardwareIPCHandlers() {
  // 模型与硬件
  ipcMain.handle('list-models', async () => {
    return await modelService.listModels()
  })
  ipcMain.handle('list-models-fast', async () => {
    return await modelService.listModelsFast()
  })
  // 获取统一模型管理器中的全部模型（含云端服务商配置）
  ipcMain.handle('get-all-models', async () => {
    unifiedModelManager.ensureLoaded()
    return unifiedModelManager.getAllModels()
  })
  ipcMain.handle('get-builtin-model-id', async () => {
    return modelService.getBuiltinModelId()
  })
  ipcMain.handle('check-models-status', async () => {
    return await modelService.checkModelsStatus()
  })
  ipcMain.handle('get-hardware-info', async () => {
    return await modelService.getHardwareInfo()
  })
  ipcMain.handle(
    'recommend-models-by-hardware',
    async (event, memoryGB: number, hasGPU: boolean, vramGB?: number) => {
      return modelService.recommendModelsByHardware(memoryGB, hasGPU, vramGB)
    }
  )
  ipcMain.handle('get-model-path', async (event, modelId: string) => {
    return modelService.getModelPath(modelId)
  })
  ipcMain.handle('delete-model', async (event, modelId: string) => {
    return await modelService.deleteModel(modelId)
  })
}
