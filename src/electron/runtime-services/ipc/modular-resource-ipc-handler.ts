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

import { ipcMain, BrowserWindow, dialog } from 'electron'
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
      const res = await service.installModule(moduleId, progressEvt => {
        broadcastModularResourceProgress(progressEvt)
      })
      if (moduleId === 'ai_organize_skill') {
        const { aiSkillApiService } = await import('../ai-skill-api-service')
        await aiSkillApiService.reconcile()
      }
      return res
    } catch (err: any) {
      logger.error(LogCategory.MAIN, `[ModularResourceIPC] install(${moduleId}) 失败:`, err)
      throw err
    }
  })

  ipcMain.handle('modular-resource:uninstall', async (_event, moduleId: string) => {
    try {
      const res = await service.uninstallModule(moduleId)
      if (moduleId === 'ai_organize_skill') {
        const { aiSkillApiService } = await import('../ai-skill-api-service')
        await aiSkillApiService.reconcile()
      }
      return res
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
        const res = service.updateModuleState(moduleId, patch)
        if (moduleId === 'ai_organize_skill') {
          const { aiSkillApiService } = await import('../ai-skill-api-service')
          await aiSkillApiService.reconcile()
        }
        return res
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

  ipcMain.handle('modular-resource:abort-all', async () => {
    try {
      const { fileDownloadService } = await import('../system/file-download-service')
      fileDownloadService.abortAll()
      return true
    } catch (err: any) {
      logger.error(LogCategory.MAIN, '[ModularResourceIPC] abort-all 失败:', err)
      return false
    }
  })

  ipcMain.handle(
    'modular-resource:smoke-test',
    async (
      _event,
      payload: {
        profile: 'classic_light' | 'gemma_unified'
        model_paths?: Record<string, string>
        test_tokens?: string[]
      }
    ) => {
      try {
        const { omniService } = await import('../system/omni-service')
        return await omniService.runSmokeTest({
          profile: payload.profile,
          model_paths: payload.model_paths || {},
          test_tokens: payload.test_tokens
        })
      } catch (err: any) {
        logger.error(LogCategory.MAIN, '[ModularResourceIPC] smoke-test 失败:', err)
        return { success: false, error: err?.message || String(err) }
      }
    }
  )

  ipcMain.handle('modular-resource:get-pending-tombstones', async () => {
    try {
      return service.getPendingTombstones()
    } catch (err: any) {
      logger.error(LogCategory.MAIN, '[ModularResourceIPC] get-pending-tombstones 失败:', err)
      return []
    }
  })

  ipcMain.handle('modular-resource:has-pending-tombstones', async () => {
    try {
      return service.hasPendingTombstones()
    } catch (err: any) {
      logger.error(LogCategory.MAIN, '[ModularResourceIPC] has-pending-tombstones 失败:', err)
      return false
    }
  })

  ipcMain.handle('modular-resource:restart-app', async () => {
    try {
      service.requestRestart()
      return true
    } catch (err: any) {
      logger.error(LogCategory.MAIN, '[ModularResourceIPC] restart-app 失败:', err)
      return false
    }
  })

  ipcMain.handle(
    'modular-resource:export-offline-package',
    async (_event, payload: { moduleId: string; targetFilePath?: string }) => {
      try {
        let dest = payload.targetFilePath
        if (!dest) {
          const res = await dialog.showSaveDialog({
            title: '导出离线插件包',
            defaultPath: `${payload.moduleId}.ffp`,
            filters: [{ name: 'Firefly 离线插件包 (*.ffp)', extensions: ['ffp', 'zip'] }]
          })
          if (res.canceled || !res.filePath) return null
          dest = res.filePath
        }
        return await service.exportOfflinePackage(payload.moduleId, dest)
      } catch (err: any) {
        logger.error(
          LogCategory.MAIN,
          `[ModularResourceIPC] export-offline-package(${payload.moduleId}) 失败:`,
          err
        )
        throw err
      }
    }
  )

  ipcMain.handle(
    'modular-resource:import-offline-package',
    async (_event, payload?: { archivePath?: string }) => {
      try {
        let src = payload?.archivePath
        if (!src) {
          const res = await dialog.showOpenDialog({
            title: '导入离线插件包',
            properties: ['openFile'],
            filters: [{ name: 'Firefly 离线插件包 (*.ffp, *.zip)', extensions: ['ffp', 'zip'] }]
          })
          if (res.canceled || !res.filePaths || res.filePaths.length === 0) return null
          src = res.filePaths[0]
        }
        return await service.importOfflinePackage(src)
      } catch (err: any) {
        logger.error(LogCategory.MAIN, '[ModularResourceIPC] import-offline-package 失败:', err)
        throw err
      }
    }
  )
}
