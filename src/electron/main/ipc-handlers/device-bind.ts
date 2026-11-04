import { ipcMain } from 'electron'
import { DeviceBindService } from '../../runtime-services/system/device-bind-service'
import { logger, LogCategory } from '@firefly/shared'

export function registerDeviceBindIPCHandlers(): void {
  ipcMain.handle('deviceBind/getStatus', async () => {
    try {
      return await DeviceBindService.getInstance().getDeviceBindStatus()
    } catch (err: any) {
      logger.error(LogCategory.IPC, '[IPC] deviceBind/getStatus failed:', err)
      return { success: false, bound: false, error: err?.message || 'unknown' }
    }
  })

  ipcMain.handle('deviceBind/createCode', async () => {
    try {
      return await DeviceBindService.getInstance().createDeviceBindCode()
    } catch (err: any) {
      logger.error(LogCategory.IPC, '[IPC] deviceBind/createCode failed:', err)
      return { success: false, error: err?.message || 'unknown' }
    }
  })
}
