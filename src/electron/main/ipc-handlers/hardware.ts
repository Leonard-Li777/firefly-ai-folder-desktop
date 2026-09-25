import { ipcMain } from 'electron'
import { modelService } from '../../runtime-services/llama/model-service'

// PRD-0044（S5）：模型管理 IPC（list-models / list-models-fast / get-all-models /
// get-builtin-model-id / check-models-status / recommend-models-by-hardware /
// get-model-path / delete-model）已随「模型激活归萤核AI引擎独占」清退，
// 渲染层仅保留硬件信息查询。
export function registerHardwareIPCHandlers() {
  // 硬件信息（Footer 硬件条等展示用途）
  ipcMain.handle('get-hardware-info', async () => {
    return await modelService.getHardwareInfo()
  })
}
