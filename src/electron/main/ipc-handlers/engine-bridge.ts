import { ipcMain } from 'electron'
import { engineBridgeService } from '../../runtime-services/engine-bridge'
import { logger, LogCategory } from '@firefly/shared'

/**
 * 引擎桥接 IPC 处理器（Tier 2 监控面板 / 控制指令）
 */
export function registerEngineBridgeIPCHandlers() {
  ipcMain.handle('engine-bridge/get-status', async () => {
    return engineBridgeService.getSnapshot()
  })

  ipcMain.handle('engine-bridge/get-exe-info', async () => {
    return engineBridgeService.getExeInfo()
  })

  ipcMain.handle('engine-bridge/start', async () => {
    logger.info(LogCategory.IPC, '[IPC] 收到启动 Tier 2 引擎请求')
    const ok = await engineBridgeService.ensureRunning()
    engineBridgeService.broadcastStatus()
    return ok
  })

  ipcMain.handle('engine-bridge/open-ui', async () => {
    logger.info(LogCategory.IPC, '[IPC] 收到打开引擎管理面板请求')
    return engineBridgeService.openUI()
  })

  ipcMain.handle('engine-bridge/shutdown', async () => {
    logger.info(LogCategory.IPC, '[IPC] 收到关闭 Tier 2 引擎请求')
    const result = await engineBridgeService.shutdown()
    engineBridgeService.broadcastStatus()
    return result
  })
}