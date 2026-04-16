/**
 * Ollama IPC 处理器
 * 处理渲染进程发来的 Ollama 相关请求
 */

import { ipcMain, shell, BrowserWindow } from 'electron'
import { logger, LogCategory } from '@yonuc/shared'
import { ollamaService, OllamaEvent, OllamaStatus } from '../ai/ollama-service'

/**
 * 注册 Ollama 相关的 IPC 处理器
 */
export function registerOllamaIPCHandlers() {
  logger.info(LogCategory.IPC, '注册 Ollama IPC 处理器')

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
    const { app } = await import('electron')
    app.relaunch()
    app.exit(0)
  })
}
