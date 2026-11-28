import { ipcMain } from 'electron'
import { logger, LogCategory } from '@firefly/shared'

async function getAutoUpdateService() {
  const { autoUpdateService } = await import('../../runtime-services/system/auto-update-service')
  return autoUpdateService
}

export function registerUpdateIPCHandlers(): void {
  ipcMain.handle('update:check', async (_, manual = true) => {
    try {
      logger.info(LogCategory.SYSTEM, `[IPC:update:check] 收到更新检查请求 (manual=${manual})`)
      const autoUpdateService = await getAutoUpdateService()
      return await autoUpdateService.checkForUpdates(manual)
    } catch (err: any) {
      logger.error(LogCategory.SYSTEM, '[IPC:update:check] 检查更新失败:', err)
      throw err
    }
  })

  ipcMain.handle('update:get-state', async () => {
    const autoUpdateService = await getAutoUpdateService()
    return autoUpdateService.getState()
  })

  // 正典下载通道（工单 09 · P1-1/A9）：统一下载入口为 update:download，preload 暴露名 download。
  // 旧 update:start-download 别名通道已删除（@deprecated）。
  ipcMain.handle('update:download', async () => {
    logger.info(LogCategory.SYSTEM, '[IPC:update:download] 收到开始下载更新包请求')
    const autoUpdateService = await getAutoUpdateService()
    await autoUpdateService.startDownload()
    return true
  })

  ipcMain.handle('update:quit-and-install', async () => {
    logger.info(LogCategory.SYSTEM, '[IPC:update:quit-and-install] 收到退出并安装请求')
    const autoUpdateService = await getAutoUpdateService()
    await autoUpdateService.quitAndInstall()
    return true
  })

  ipcMain.handle('update:exit-app', async () => {
    logger.info(LogCategory.SYSTEM, '[IPC:update:exit-app] 用户在强制更新遮罩点击退出应用')
    // P0-11: 走同一 ShutdownCoordinator 关停编排(去安装步)，app.exit(0) 仅整体超时兜底
    const autoUpdateService = await getAutoUpdateService()
    await autoUpdateService.exitAppForUpdate()
    return true
  })
}
