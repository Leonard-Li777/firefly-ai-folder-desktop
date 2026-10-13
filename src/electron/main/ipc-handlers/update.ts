import { ipcMain } from 'electron'
import { autoUpdateService } from '../../runtime-services/system/auto-update-service'
import { logger, LogCategory } from '@firefly/shared'

export function registerUpdateIPCHandlers(): void {
  ipcMain.handle('update:check', async (_, manual = true) => {
    try {
      logger.info(LogCategory.SYSTEM, `[IPC:update:check] 收到更新检查请求 (manual=${manual})`)
      return await autoUpdateService.checkForUpdates(manual)
    } catch (err: any) {
      logger.error(LogCategory.SYSTEM, '[IPC:update:check] 检查更新失败:', err)
      throw err
    }
  })

  ipcMain.handle('update:get-state', async () => {
    return autoUpdateService.getState()
  })

  ipcMain.handle('update:start-download', async () => {
    logger.info(LogCategory.SYSTEM, '[IPC:update:start-download] 收到开始下载更新包请求')
    await autoUpdateService.startDownload()
    return true
  })

  // Spec L242 对齐别名
  ipcMain.handle('update:download', async () => {
    logger.info(LogCategory.SYSTEM, '[IPC:update:download] 收到开始下载更新包请求')
    await autoUpdateService.startDownload()
    return true
  })

  ipcMain.handle('update:quit-and-install', async () => {
    logger.info(LogCategory.SYSTEM, '[IPC:update:quit-and-install] 收到退出并安装请求')
    await autoUpdateService.quitAndInstall()
    return true
  })

  ipcMain.handle('update:exit-app', async () => {
    logger.info(LogCategory.SYSTEM, '[IPC:update:exit-app] 用户在强制更新遮罩点击退出应用')
    const { app } = await import('electron')
    app.exit(0)
    return true
  })
}
