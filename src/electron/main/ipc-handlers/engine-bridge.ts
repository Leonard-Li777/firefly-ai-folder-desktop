import { ipcMain } from 'electron'
import { engineBridgeService } from '../../runtime-services/engine-bridge'
import { logger, LogCategory } from '@firefly/shared'
import { t } from '@app/languages'

/**
 * 引擎桥接 IPC 处理器（Tier 2 监控面板 / 控制指令）
 */
export function registerEngineBridgeIPCHandlers() {
  ipcMain.handle('engine-bridge/get-status', async () => {
    // 若引擎正处于启动拉起流程中，避免瞬态探活失败清空状态并向前端广播离线，防止界面反复抖动
    if (engineBridgeService.isStartingNow()) {
      return engineBridgeService.getSnapshot()
    }
    // PRD-0043：Footer 等渲染层需实时探活结果，而非缓存快照
    // 直接调用 healthCheck() 向外部引擎发起实时状态查询
    const status = await engineBridgeService.healthCheck()
    if (status) {
      // 统一经 applyStatus 写入状态、刷新缓存并按需广播，消除 lastRawStatus 直写绕过
      engineBridgeService.applyStatus(status)
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
    // force：用户显式点击启动，复位熔断器后放行拉起
    const ok = await engineBridgeService.ensureRunning({ force: true })
    engineBridgeService.broadcastStatus()
    return ok
  })

  ipcMain.handle(
    'engine-bridge/open-ui',
    async (
      _event,
      options?: {
        panel?: 'error' | 'logs' | 'models' | 'default'
        focusModel?: string
        source?: string
      }
    ) => {
      logger.info(LogCategory.IPC, '[IPC] 收到打开引擎管理面板请求', options)
      return engineBridgeService.openUI(options)
    }
  )

  // Issue 0046 §3：探测引擎侧模型安装状态（高维修正开关未安装预警）
  ipcMain.handle('engine-bridge/check-models', async (_event, keywords?: string[]) => {
    return engineBridgeService.checkModelsInstalled(Array.isArray(keywords) ? keywords : [])
  })

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

  // PRD-0049：切换引擎计算后端（引擎激活单一化，错误降级/错误弹窗入口用）
  ipcMain.handle('engine-bridge/switch-backend', async (_event, backend?: string) => {
    if (!backend || typeof backend !== 'string') {
      return { ok: false, error: t('缺少目标后端参数') }
    }
    logger.info(LogCategory.IPC, `[IPC] 收到切换引擎后端请求: ${backend}`)
    const result = await engineBridgeService.switchBackend(backend)
    // 切换后重启推理服务使新后端生效；失败不影响 switch 本身的成功语义（引擎侧偏好已写入）
    if (result.ok) {
      await engineBridgeService.stopService().catch((e: unknown) => {
        logger.warn(LogCategory.IPC, '[IPC] 切换后端后停止旧服务失败（不影响切换结果）:', e)
      })
      await engineBridgeService.startService().catch((e: unknown) => {
        logger.warn(LogCategory.IPC, '[IPC] 切换后端后启动新服务失败（引擎侧偏好已写入）:', e)
      })
    }
    engineBridgeService.broadcastStatus()
    return result
  })
}
