/**
 * 插件中心与模块化资源生命周期 IPC 处理器
 *
 * 暴露通道：
 * - modular-resource:list -> 获取所有模块完整视图
 * - modular-resource:install -> 幂等下载并安装模块（推送 modular-resource:progress 事件）
 * - modular-resource:uninstall -> 卸载模块与关联资源两阶段 Tombstone 回收
 * - modular-resource:update-state -> 切换模块启用状态、更新 user_config 或变体
 * - modular-resource:sync-catalog -> 增量同步目录元数据（IN-04 版本防回退）
 * - modular-resource:reconcile -> 执行启动期对账与孤儿清理
 */

import { ipcMain, BrowserWindow } from 'electron'
import { logger, LogCategory } from '@firefly/shared'
import {
  modularResourceService,
  type IModularResourceService,
  type ModuleDownloadProgressEvent,
  type CatalogModuleEntry
} from '../system/modular-resource-service'

export function broadcastModularResourceProgress(event: ModuleDownloadProgressEvent): void {
  try {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send('modular-resource:progress', event)
      }
    }
  } catch (err) {
    logger.warn(LogCategory.MAIN, '[ModularResourceIPC] 广播下载进度失败:', err)
  }
}

export function registerModularResourceIpcHandlers(
  service: IModularResourceService = modularResourceService
): void {
  logger.info(LogCategory.MAIN, '正在注册 ModularResource IPC 处理器...')

  ipcMain.handle('modular-resource:list', async () => {
    try {
      return service.listModules()
    } catch (err: any) {
      logger.error(LogCategory.MAIN, '[ModularResourceIPC] list 失败:', err)
      throw err
    }
  })

  ipcMain.handle('modular-resource:install', async (_event, moduleId: string) => {
    try {
      return await service.installModule(moduleId, progressEvt => {
        broadcastModularResourceProgress(progressEvt)
      })
    } catch (err: any) {
      logger.error(LogCategory.MAIN, `[ModularResourceIPC] install(${moduleId}) 失败:`, err)
      throw err
    }
  })

  ipcMain.handle('modular-resource:uninstall', async (_event, moduleId: string) => {
    try {
      return await service.uninstallModule(moduleId)
    } catch (err: any) {
      logger.error(LogCategory.MAIN, `[ModularResourceIPC] uninstall(${moduleId}) 失败:`, err)
      throw err
    }
  })

  ipcMain.handle(
    'modular-resource:update-state',
    async (
      _event,
      moduleId: string,
      patch: {
        active?: boolean
        userConfig?: Record<string, unknown> | string | null
        selectedVariant?: string
        userConsent?: boolean
      }
    ) => {
      try {
        return service.updateModuleState(moduleId, patch)
      } catch (err: any) {
        logger.error(LogCategory.MAIN, `[ModularResourceIPC] update-state(${moduleId}) 失败:`, err)
        throw err
      }
    }
  )

  ipcMain.handle('modular-resource:sync-catalog', async (_event, entries: CatalogModuleEntry[]) => {
    try {
      return await service.syncCatalog(entries)
    } catch (err: any) {
      logger.error(LogCategory.MAIN, '[ModularResourceIPC] sync-catalog 失败:', err)
      throw err
    }
  })

  ipcMain.handle('modular-resource:reconcile', async () => {
    try {
      return await service.reconcileOnStartup()
    } catch (err: any) {
      logger.error(LogCategory.MAIN, '[ModularResourceIPC] reconcile 失败:', err)
      throw err
    }
  })
}
