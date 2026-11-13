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

  ipcMain.handle('deviceBind/createCode', async (_event, payload?: { forceRefresh?: boolean }) => {
    try {
      return await DeviceBindService.getInstance().createDeviceBindCode(!!payload?.forceRefresh)
    } catch (err: any) {
      logger.error(LogCategory.IPC, '[IPC] deviceBind/createCode failed:', err)
      return { success: false, error: err?.message || 'unknown' }
    }
  })

  ipcMain.handle('deviceBind/pollResult', async (_event, { code, pollSecret }) => {
    try {
      return await DeviceBindService.getInstance().pollBindResult(code, pollSecret)
    } catch (err: any) {
      logger.error(LogCategory.IPC, '[IPC] deviceBind/pollResult failed:', err)
      return { success: false, error: err?.message || 'unknown' }
    }
  })

  ipcMain.handle('deviceBind/sendEmailOtp', async (_event, { email }) => {
    try {
      return await DeviceBindService.getInstance().sendEmailOtp(email)
    } catch (err: any) {
      logger.error(LogCategory.IPC, '[IPC] deviceBind/sendEmailOtp failed:', err)
      return { success: false, error: err?.message || 'unknown' }
    }
  })

  ipcMain.handle(
    'deviceBind/completeEmailBinding',
    async (_event, { email, code, invitationCode }) => {
      try {
        return await DeviceBindService.getInstance().completeEmailBinding(
          email,
          code,
          invitationCode
        )
      } catch (err: any) {
        logger.error(LogCategory.IPC, '[IPC] deviceBind/completeEmailBinding failed:', err)
        return { success: false, error: err?.message || 'unknown' }
      }
    }
  )

  ipcMain.handle(
    'deviceBind/completeOaContactBinding',
    async (_event, payload?: { invitationCode?: string }) => {
      try {
        return await DeviceBindService.getInstance().completeOaContactBinding(
          payload?.invitationCode
        )
      } catch (err: any) {
        logger.error(LogCategory.IPC, '[IPC] deviceBind/completeOaContactBinding failed:', err)
        return { success: false, error: err?.message || 'unknown' }
      }
    }
  )

  ipcMain.handle('deviceBind/hasActiveBindSession', async () => {
    try {
      return DeviceBindService.getInstance().hasActiveBindSession()
    } catch (err: any) {
      logger.error(LogCategory.IPC, '[IPC] deviceBind/hasActiveBindSession failed:', err)
      return false
    }
  })

  ipcMain.handle('deviceBind/resetToQr', async () => {
    try {
      await DeviceBindService.getInstance().resetToQr()
      return { success: true }
    } catch (err: any) {
      logger.error(LogCategory.IPC, '[IPC] deviceBind/resetToQr failed:', err)
      return { success: false, error: err?.message || 'unknown' }
    }
  })

  ipcMain.handle('deviceBind/getUnseatedSession', async () => {
    try {
      return await DeviceBindService.getInstance().getUnseatedSession()
    } catch (err: any) {
      logger.error(LogCategory.IPC, '[IPC] deviceBind/getUnseatedSession failed:', err)
      return { unseated: false, error: err?.message || 'unknown' }
    }
  })

  ipcMain.handle('deviceBind/seatDevice', async (_event, { sessionToken, evictDeviceId }) => {
    try {
      return await DeviceBindService.getInstance().seatThisDevice(sessionToken, evictDeviceId)
    } catch (err: any) {
      logger.error(LogCategory.IPC, '[IPC] deviceBind/seatDevice failed:', err)
      return { success: false, error: err?.message || 'unknown' }
    }
  })

  ipcMain.handle('deviceBind/listSeatedDevices', async (_event, { sessionToken } = {}) => {
    try {
      return await DeviceBindService.getInstance().listSeatedDevices(sessionToken)
    } catch (err: any) {
      logger.error(LogCategory.IPC, '[IPC] deviceBind/listSeatedDevices failed:', err)
      return { success: false, error: err?.message || 'unknown' }
    }
  })

  ipcMain.handle('deviceBind/unbindDevice', async (_event, payload?: { deviceId?: string; machineId?: string }) => {
    try {
      return await DeviceBindService.getInstance().unbindDevice(payload)
    } catch (err: any) {
      logger.error(LogCategory.IPC, '[IPC] deviceBind/unbindDevice failed:', err)
      return { success: false, error: err?.message || 'unknown' }
    }
  })

  ipcMain.handle('deviceBind/logout', async () => {
    try {
      return await DeviceBindService.getInstance().logout()
    } catch (err: any) {
      logger.error(LogCategory.IPC, '[IPC] deviceBind/logout failed:', err)
      return { success: false, error: err?.message || 'unknown' }
    }
  })
}
