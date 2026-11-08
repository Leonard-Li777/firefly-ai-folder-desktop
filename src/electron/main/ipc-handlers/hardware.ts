import { ipcMain } from 'electron'
import { modelService } from '../../runtime-services/llama/model-service'
import { hardwareDetectionService } from '../../runtime-services/system/hardware-detection-service'

// PRD-0044（S5）：模型管理 IPC（list-models / list-models-fast / get-all-models /
// get-builtin-model-id / check-models-status / recommend-models-by-hardware /
// get-model-path / delete-model）已随「模型激活归萤核AI引擎独占」清退，
// 渲染层仅保留硬件信息查询。
export function registerHardwareIPCHandlers() {
  // 硬件信息（Footer 硬件条等展示用途）
  ipcMain.handle('get-hardware-info', async () => {
    return await modelService.getHardwareInfo()
  })

  // 硬件自适应推荐嵌入设置（EmbeddingGemma-2 / Classic Light）
  ipcMain.handle('get-recommended-embedding-settings', async () => {
    return await hardwareDetectionService.getRecommendedEmbeddingSettings?.()
  })

  // 欢迎向导硬件能力探测看板 (RAM, GPU, VRAM, 磁盘可用空间)
  ipcMain.handle('detect-system-resources', async () => {
    try {
      const res = await hardwareDetectionService.detectSystemResources()
      const totalMemMB = res.memory?.total || 0
      const totalMemGB = Math.round((totalMemMB / 1024) * 10) / 10
      const primaryGpu = res.gpus?.[0]
      const gpuName = primaryGpu?.name || ''
      const vramGB = primaryGpu?.memory ? Math.round((primaryGpu.memory / 1024) * 10) / 10 : 0
      const isGpuSupported = Boolean(primaryGpu && !primaryGpu.isIntegrated)
      const storageFreeGB =
        res.storage?.available !== undefined ? Math.round(res.storage.available * 10) / 10 : 10

      return {
        totalMemGB,
        totalMemMB,
        gpuName,
        vramGB,
        isGpuSupported,
        storageFreeGB,
        raw: res
      }
    } catch {
      return {
        totalMemGB: 8,
        totalMemMB: 8192,
        gpuName: 'Generic GPU',
        vramGB: 0,
        isGpuSupported: false,
        storageFreeGB: 50
      }
    }
  })
}
