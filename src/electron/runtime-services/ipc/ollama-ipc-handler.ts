/**
 * Ollama IPC 处理器
 * 处理渲染进程发来的 Ollama 相关请求
 */

import { ipcMain, shell, BrowserWindow } from 'electron'
import { logger, LogCategory } from '@yonuc/shared'
import { ollamaService, OllamaEvent, OllamaStatus } from '../ai/ollama-service'
import { ConfigOrchestrator } from '../../config/config-orchestrator'

/**
 * 注册 Ollama 相关的 IPC 处理器
 */
export function registerOllamaIPCHandlers() {
  logger.info(LogCategory.IPC, '注册 Ollama IPC 处理器')

  // 监听镜像配置变更并通知前端
  ConfigOrchestrator.getInstance().onValueChange('DOWNLOAD_MIRROR', (newMirror) => {
    logger.info(LogCategory.IPC, `[Mirror] 镜像源配置已变更: ${newMirror}，正在同步至渲染进程`)
    const windows = BrowserWindow.getAllWindows()
    windows.forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('ollama:mirror-sync', newMirror)
      }
    })
  })

  // 获取当前下载镜像
  ipcMain.handle('ollama:get-download-mirror', async () => {
    const mirror = ConfigOrchestrator.getInstance().getValue<'cn' | 'global'>('DOWNLOAD_MIRROR') || 'cn'
    logger.debug(LogCategory.IPC, `[Mirror] 渲染进程请求当前镜像源状态: ${mirror}`)
    return mirror
  })

  // 检查 Ollama 安装状态
  ipcMain.handle('ollama:check-installation', async () => {
    try {
      const result = await ollamaService.checkInstallation()
      return {
        success: true,
        installed: result.installed,
        version: result.version,
        error: result.error
      }
    } catch (error) {
      logger.error(LogCategory.IPC, '检查 Ollama 安装状态失败:', error)
      return {
        success: false,
        installed: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  // 这里的事件监听只需要注册一次，避免 MaxListenersExceededWarning
  // 转发 Ollama 服务事件到渲染进程
  ollamaService.on(OllamaEvent.INSTALL_PROGRESS, (data: any) => {
    const windows = BrowserWindow.getAllWindows()
    windows.forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('ollama:install-progress', data)
      }
    })
  })

  ollamaService.on(OllamaEvent.INSTALL_COMPLETE, () => {
    const windows = BrowserWindow.getAllWindows()
    windows.forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('ollama:install-complete', {})
      }
    })
  })

  ollamaService.on(OllamaEvent.INSTALL_ERROR, (data: any) => {
    const windows = BrowserWindow.getAllWindows()
    windows.forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('ollama:install-error', data)
      }
    })
  })

  ollamaService.on(OllamaEvent.STATUS_CHANGED, (data: any) => {
    const windows = BrowserWindow.getAllWindows()
    windows.forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('ollama:status-changed', data)
      }
    })
  })

  ollamaService.on(OllamaEvent.MODEL_STATUS_CHANGED, (data: any) => {
    const windows = BrowserWindow.getAllWindows()
    windows.forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('ollama:model-status-changed', data)
        
        // 关键修复：当 Ollama 模型下载完成时，发送通用下载完成事件
        // 这将触发 UI 中全局的模型状态重新扫描
        if (data.status === 'downloaded') {
          win.webContents.send('model-download-complete', {
            modelId: data.modelId,
            status: 'completed',
            percent: 100
          })
        }
      }
    })
  })

  ollamaService.on(OllamaEvent.MODEL_PROGRESS, (data: any) => {
    const windows = BrowserWindow.getAllWindows()
    windows.forEach(win => {
      if (!win.isDestroyed()) {
        win.webContents.send('ollama:model-progress', data)
      }
    })
  })

  // 安装 Ollama
  ipcMain.handle('ollama:install', async () => {
    try {
      logger.info(LogCategory.IPC, '收到安装 Ollama 请求')
      
      const success = await ollamaService.install()
      return { success }
    } catch (error) {
      logger.error(LogCategory.IPC, '安装 Ollama 失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  // 取消安装 Ollama
  ipcMain.handle('ollama:cancel-install', async () => {
    try {
      logger.info(LogCategory.IPC, '收到取消安装 Ollama 请求')
      await ollamaService.cancelInstall()
      return { success: true }
    } catch (error) {
      logger.error(LogCategory.IPC, '取消安装 Ollama 失败:', error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  // 获取 Ollama 状态
  ipcMain.handle('ollama:get-status', async () => {
    return {
      status: ollamaService.getStatus(),
      version: ollamaService.getVersion()
    }
  })

  // 检查是否需要 Ollama 设置
  ipcMain.handle('ollama:needs-setup', async () => {
    try {
      const needsSetup = await ollamaService.needsOllamaSetup()
      return { needsSetup }
    } catch (error) {
      return { needsSetup: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // 拉取模型
  ipcMain.handle('ollama:pull-model', async (_, modelId: string) => {
    try {
      logger.info(LogCategory.IPC, `收到拉取模型请求: ${modelId}`)
      
      const result = await ollamaService.pullModel(modelId)
      return result
    } catch (error) {
      logger.error(LogCategory.IPC, `拉取模型 ${modelId} 失败:`, error)
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  // 检查模型是否已安装
  ipcMain.handle('ollama:check-model', async (_, modelId: string) => {
    try {
      const installed = await ollamaService.checkModelInstalled(modelId)
      return { installed }
    } catch (error) {
      return { installed: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  // 获取已安装的模型列表
  ipcMain.handle('ollama:list-models', async () => {
    try {
      const models = await ollamaService.listInstalledModels()
      return { models }
    } catch (error) {
      return { models: [], error: error instanceof Error ? error.message : String(error) }
    }
  })

  // 获取推荐的模型列表
  ipcMain.handle('ollama:get-recommended-models', async () => {
    const models = ollamaService.getRecommendedModels()
    return { models }
  })

  // 打开 Ollama 官网
  ipcMain.handle('ollama:open-website', async () => {
    shell.openExternal('https://ollama.com/')
    return { success: true }
  })

  // 重启应用
  ipcMain.handle('ollama:relaunch', async () => {
    const { app, BrowserWindow } = await import('electron')
    
    logger.info(LogCategory.IPC, '准备重启应用...')
    
    // 获取所有当前窗口
    const windows = BrowserWindow.getAllWindows()
    
    // 在重启前销毁所有窗口，防止残留
    windows.forEach(win => {
      if (!win.isDestroyed()) {
        win.destroy()
      }
    })

    // 执行重启
    app.relaunch()
    
    // 退出当前进程
    app.exit(0)
  })

  // 直接退出应用
  ipcMain.handle('ollama:exit', async () => {
    const { app } = await import('electron')
    logger.info(LogCategory.IPC, '收到退出应用请求...')
    app.exit(0)
  })
}
