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

import { ipcMain, BrowserWindow, dialog, app } from 'electron'
import { logger, LogCategory } from '@firefly/shared'
import {
  modularResourceService,
  type IModularResourceService,
  type ModuleDownloadProgressEvent,
  type CatalogModuleEntry
} from '../system/modular-resource-service'
import { safeRestartApp } from '../system/app-lifecycle'
import {
  EnvironmentVisibilityCoordinator,
  type EnvironmentVisibilityEnvelope
} from '../modular-resource/environment-visibility'

export function broadcastEnvironmentVisibility(envelope: EnvironmentVisibilityEnvelope): void {
  try {
    const windows = BrowserWindow.getAllWindows()
    for (const win of windows) {
      if (!win.isDestroyed()) {
        win.webContents.send('modular-resource:environment-visibility-changed', envelope)
      }
    }
  } catch (err) {
    logger.warn(LogCategory.MAIN, '[ModularResourceIPC] 广播环境可见性变更失败:', err)
  }
}

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

  let devModeEnabled = typeof app !== 'undefined' ? !app.isPackaged : true

  ipcMain.handle(
    'modular-resource:list',
    async (
      _event,
      filter?: { scope?: 'market' | 'installed'; category?: string; includeDraft?: boolean }
    ) => {
      try {
        const effectiveDevMode =
          typeof app !== 'undefined' && app.isPackaged ? false : devModeEnabled
        return service.listModules({
          ...filter,
          includeDraft: filter?.includeDraft ?? effectiveDevMode
        })
      } catch (err: any) {
        logger.error(LogCategory.MAIN, '[ModularResourceIPC] list 失败:', err)
        throw err
      }
    }
  )

  ipcMain.handle('modular-resource:get-environment-visibility', async () => {
    const isPackaged = typeof app !== 'undefined' ? app.isPackaged : false
    return EnvironmentVisibilityCoordinator.getInstance().getEnvelope(isPackaged)
  })

  ipcMain.handle(
    'modular-resource:set-developer-mode',
    async (_event, payload: { enabled: boolean }) => {
      const isPackaged = typeof app !== 'undefined' ? app.isPackaged : false
      devModeEnabled = !!payload.enabled
      const envelope = EnvironmentVisibilityCoordinator.getInstance().setDeveloperMode(
        payload.enabled,
        isPackaged
      )
      broadcastEnvironmentVisibility(envelope)
      return envelope
    }
  )

  ipcMain.handle('modular-resource:get-dev-mode', async () => {
    const effective = typeof app !== 'undefined' && app.isPackaged ? false : devModeEnabled
    return { enabled: devModeEnabled, devModeEffective: effective }
  })

  ipcMain.handle('modular-resource:set-dev-mode', async (_event, payload: { enabled: boolean }) => {
    const isPackaged = typeof app !== 'undefined' && app.isPackaged ? false : devModeEnabled
    devModeEnabled = !!payload.enabled
    const envelope = EnvironmentVisibilityCoordinator.getInstance().setDeveloperMode(
      payload.enabled,
      isPackaged
    )
    broadcastEnvironmentVisibility(envelope)
    return { devModeEffective: envelope.visibility.developerModeEnabled }
  })

  ipcMain.handle('modular-resource:install', async (_event, moduleId: string) => {
    try {
      const res = await service.installModule(moduleId, progressEvt => {
        broadcastModularResourceProgress(progressEvt)
      })
      return res
    } catch (err: any) {
      logger.error(LogCategory.MAIN, `[ModularResourceIPC] install(${moduleId}) 失败:`, err)
      throw err
    }
  })

  ipcMain.handle('modular-resource:uninstall', async (_event, moduleId: string) => {
    try {
      const res = await service.uninstallModule(moduleId)
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
        const res = await service.updateModuleState(moduleId, patch)
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
      await safeRestartApp()
      return true
    } catch (err: any) {
      logger.error(LogCategory.MAIN, '[ModularResourceIPC] restart-app 失败:', err)
      return false
    }
  })

  ipcMain.handle('modular-resource:export-offline-bundle', async () => {
    try {
      const res = await dialog.showSaveDialog({
        title: '导出离线插件总包',
        defaultPath: 'firefly-offline-bundle.ffp',
        filters: [{ name: 'Firefly 离线总包 (*.ffp)', extensions: ['ffp', 'zip'] }]
      })
      if (res.canceled || !res.filePath) return null
      return await service.exportOfflinePackage('all', res.filePath)
    } catch (err: unknown) {
      logger.error(LogCategory.MAIN, '[ModularResourceIPC] export-offline-bundle 失败:', err)
      throw err
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

  ipcMain.handle('modular-resource:pick-and-import-local-plugin', async event => {
    try {
      const { PluginImporter } = await import('../plugin/plugin-importer')
      const importer = new PluginImporter()
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined
      const res = await importer.pickAndImportLocalPlugin(win)
      if (res.canceled) {
        return { canceled: true }
      }
      if (res.error) {
        return { canceled: false, error: res.error }
      }
      const view = res.module ? service.getModule(res.module.id) : null
      return { canceled: false, module: view }
    } catch (err: any) {
      logger.error(LogCategory.MAIN, '[ModularResourceIPC] pick-and-import-local-plugin 失败:', err)
      return { canceled: false, error: err?.message || '导入失败' }
    }
  })

  // 获取插件目录详细信息与运行态状态
  ipcMain.handle('modular-resource:get-plugin-dir-info', async () => {
    try {
      return await service.getPluginDirInfo()
    } catch (err: any) {
      logger.error(LogCategory.MAIN, '[ModularResourceIPC] get-plugin-dir-info 失败:', err)
      throw err
    }
  })

  // 校验候选路径合法性（11步管线校验与诊断）
  ipcMain.handle(
    'modular-resource:validate-plugin-dir',
    async (_event, payload: { targetPath: string }) => {
      try {
        return await service.validatePluginDir(payload?.targetPath ?? '')
      } catch (err: any) {
        logger.error(LogCategory.MAIN, '[ModularResourceIPC] validate-plugin-dir 失败:', err)
        return {
          valid: false,
          errorCode: 'PATH_NOT_WRITABLE',
          errorMessage: err?.message || '校验失败'
        }
      }
    }
  )

  // 发起目录迁移
  ipcMain.handle(
    'modular-resource:change-plugin-dir',
    async (_event, payload: { targetPath: string }) => {
      try {
        return await service.changePluginDirectory(payload?.targetPath ?? '')
      } catch (err: any) {
        logger.error(LogCategory.MAIN, '[ModularResourceIPC] change-plugin-dir 失败:', err)
        return {
          success: false,
          errorCode: err?.code ?? 'PATH_NOT_WRITABLE'
        }
      }
    }
  )

  // 取消正在执行的目录迁移 (仅在 PRECHECK/STAGING/VERIFYING 生效)
  ipcMain.handle('modular-resource:cancel-dir-migration', async () => {
    try {
      return await service.cancelDirMigration()
    } catch (err: any) {
      logger.error(LogCategory.MAIN, '[ModularResourceIPC] cancel-dir-migration 失败:', err)
      return {
        cancelled: false,
        errorCode: err?.code
      }
    }
  })

  // 清理历史旧目录残留
  ipcMain.handle('modular-resource:cleanup-old-dir', async () => {
    try {
      return await service.cleanupOldPluginDirectory()
    } catch (err: any) {
      logger.error(LogCategory.MAIN, '[ModularResourceIPC] cleanup-old-dir 失败:', err)
      return {
        success: false,
        freedBytes: 0,
        errorCode: err?.code ?? 'PATH_NOT_WRITABLE'
      }
    }
  })

  // 忽略历史旧目录清理提示
  ipcMain.handle('modular-resource:dismiss-old-dir-cleanup', async () => {
    service.dismissOldDirCleanup()
    return true
  })

  // 检查是否已忽略历史旧目录清理提示
  ipcMain.handle('modular-resource:is-old-dir-cleanup-dismissed', async () => {
    return service.isOldDirCleanupDismissed()
  })
}
