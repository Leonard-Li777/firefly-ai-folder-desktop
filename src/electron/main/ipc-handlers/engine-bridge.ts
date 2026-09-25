import { ipcMain } from 'electron'
import { engineBridgeService } from '../../runtime-services/engine-bridge'
import { logger, LogCategory } from '@firefly/shared'

/**
 * 引擎桥接 IPC 处理器（Tier 2 监控面板 / 控制指令）
 */
export function registerEngineBridgeIPCHandlers() {
  ipcMain.handle('engine-bridge/get-status', async () => {
    // PRD-0043：Footer 等渲染层需实时探活结果，而非缓存快照
    // 直接调用 healthCheck() 向外部引擎发起实时状态查询
    const status = await engineBridgeService.healthCheck()
    if (status) {
      // 更新缓存并广播，保持后续 getSnapshot() 一致
      engineBridgeService['lastRawStatus'] = status
      engineBridgeService.broadcastStatus()
      return engineBridgeService.getSnapshot()
    }
    // 探活失败：清空缓存并广播离线
    engineBridgeService['lastRawStatus'] = null
    engineBridgeService.broadcastStatus()
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

  ipcMain.handle(
    'engine-bridge/open-ui',
    async (_event, options?: { panel?: 'error' | 'logs' | 'models' | 'default' }) => {
      logger.info(LogCategory.IPC, '[IPC] 收到打开引擎管理面板请求', options)
      return engineBridgeService.openUI(options)
    }
  )

  ipcMain.handle('engine-bridge/shutdown', async () => {
    logger.info(LogCategory.IPC, '[IPC] 收到关闭 Tier 2 引擎请求')
    const result = await engineBridgeService.shutdown()
    engineBridgeService.broadcastStatus()
    return result
  })

  // PRD-0044：启动/停止引擎侧 AI 推理服务（不退出引擎应用）
  ipcMain.handle('engine-bridge/start-service', async () => {
    logger.info(LogCategory.IPC, '[IPC] 收到启动 AI 服务请求')
    const result = await engineBridgeService.startService()
    engineBridgeService.broadcastStatus()
    return result
  })

  ipcMain.handle('engine-bridge/stop-service', async () => {
    logger.info(LogCategory.IPC, '[IPC] 收到停止 AI 服务请求')
    const result = await engineBridgeService.stopService()
    engineBridgeService.broadcastStatus()
    return result
  })
}