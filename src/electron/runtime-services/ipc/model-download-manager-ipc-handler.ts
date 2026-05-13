import { ipcMain } from 'electron'
import * as shared from '@yonuc/shared'

// 提取需要的组件，并增加防御性检查
const logger = shared.logger
const LogCategory = shared.LogCategory

/**
 * 模型下载管理IPC处理程序
 */
export class ModelDownloadManagerIPCHandler {
  private static instance: ModelDownloadManagerIPCHandler

  static getInstance(): ModelDownloadManagerIPCHandler {
    if (!ModelDownloadManagerIPCHandler.instance) {
      ModelDownloadManagerIPCHandler.instance = new ModelDownloadManagerIPCHandler()
    }
    return ModelDownloadManagerIPCHandler.instance
  }

  private constructor() {
    this.registerHandlers()
  }

  /**
   * 安全地获取日志记录器
   */
  private getLogger() {
    return logger || {
      debug: console.log,
      info: console.log,
      warn: console.warn,
      error: console.error
    }
  }

  /**
   * 注册所有IPC处理程序
   */
  private async registerHandlers(): Promise<void> {
    const self = this
    const safeLogger = this.getLogger()
    const category = LogCategory?.IPC || 'IPC'

    try {
      // 使用动态导入避免循环依赖和初始化顺序问题
      const { ModelDownloadManager, DownloadStatus } = await import('../ai/model-download-manager')

      // 检查模型下载状态
      ipcMain.handle('model-download-manager:check-status', async (_event, modelId: string) => {
        try {
          safeLogger.debug(category, '[ModelDownloadManagerIPC] 检查模型下载状态:', modelId)
          const status = await ModelDownloadManager.getInstance().checkModelDownloadStatus(modelId)
          return { success: true, data: status }
        } catch (err: any) {
          safeLogger.error(category, '[ModelDownloadManagerIPC] 检查下载状态失败:', err)
          return { success: false, error: err?.message || String(err) }
        }
      })

      // 开始下载模型
      ipcMain.handle('model-download-manager:start-download', async (event, modelId: string, options?: any) => {
        try {
          safeLogger.info(category, '[ModelDownloadManagerIPC] 开始下载模型:', modelId)

          const webContentsId = event?.sender?.id
          const task = await ModelDownloadManager.getInstance().startDownload(modelId, webContentsId, options)

          return { success: true, data: task }
        } catch (err: any) {
          safeLogger.error(category, '[ModelDownloadManagerIPC] 开始下载失败:', err)
          return { success: false, error: err?.message || String(err) }
        }
      })

      // 取消下载
      ipcMain.handle('model-download-manager:cancel-download', async (_event, taskId: string) => {
        try {
          safeLogger.info(category, '[ModelDownloadManagerIPC] 取消下载:', taskId)
          await ModelDownloadManager.getInstance().cancelDownload(taskId)
          return { success: true }
        } catch (err: any) {
          safeLogger.error(category, '[ModelDownloadManagerIPC] 取消下载失败:', err)
          return { success: false, error: err?.message || String(err) }
        }
      })

      // 暂停下载
      ipcMain.handle('model-download-manager:pause-download', async (_event, taskId: string) => {
        try {
          safeLogger.info(category, '[ModelDownloadManagerIPC] 暂停下载:', taskId)
          ModelDownloadManager.getInstance().pauseDownload(taskId)
          return { success: true }
        } catch (err: any) {
          safeLogger.error(category, '[ModelDownloadManagerIPC] 暂停下载失败:', err)
          return { success: false, error: err?.message || String(err) }
        }
      })

      // 恢复下载
      ipcMain.handle('model-download-manager:resume-download', async (_event, taskId: string) => {
        try {
          safeLogger.info(category, '[ModelDownloadManagerIPC] 恢复下载:', taskId)
          ModelDownloadManager.getInstance().resumeDownload(taskId)
          return { success: true }
        } catch (err: any) {
          safeLogger.error(category, '[ModelDownloadManagerIPC] 恢复下载失败:', err)
          return { success: false, error: err?.message || String(err) }
        }
      })

      // 获取任务状态
      ipcMain.handle('model-download-manager:get-task-status', async (_event, taskId: string) => {
        try {
          const task = await ModelDownloadManager.getInstance().getTaskStatus(taskId)
          if (!task) {
            return { success: false, error: '任务不存在' }
          }
          return { success: true, data: self.serializeTask(task, DownloadStatus) }
        } catch (err: any) {
          safeLogger.error(category, '[ModelDownloadManagerIPC] 获取任务状态失败:', err)
          return { success: false, error: err?.message || String(err) }
        }
      })

      // 获取模型的任务状态
      ipcMain.handle('model-download-manager:get-model-task', async (_event, modelId: string) => {
        try {
          const task = await ModelDownloadManager.getInstance().getModelTask(modelId)
          if (!task) {
            return { success: true, data: null }
          }
          return { success: true, data: self.serializeTask(task, DownloadStatus) }
        } catch (err: any) {
          safeLogger.error(category, '[ModelDownloadManagerIPC] 获取模型任务失败:', err)
          return { success: false, error: err?.message || String(err) }
        }
      })

      // 检查模型是否正在下载
      ipcMain.handle('model-download-manager:is-downloading', async (_event, modelId: string) => {
        try {
          const isDownloading = ModelDownloadManager.getInstance().isModelDownloading(modelId)
          return { success: true, data: isDownloading }
        } catch (err: any) {
          safeLogger.error(category, '[ModelDownloadManagerIPC] 检查下载状态失败:', err)
          return { success: false, error: err?.message || String(err) }
        }
      })

      // 获取所有活跃任务
      ipcMain.handle('model-download-manager:get-all-tasks', async () => {
        try {
          const tasks = await ModelDownloadManager.getInstance().getAllTasks() || []
          return {
            success: true,
            data: tasks.map(task => self.serializeTask(task, DownloadStatus))
          }
        } catch (err: any) {
          safeLogger.error(category, '[ModelDownloadManagerIPC] 获取所有任务失败:', err)
          return { success: false, error: err?.message || String(err) }
        }
      })

      self.registerEventListeners(ModelDownloadManager)
    } catch (err: any) {
      if (safeLogger) {
        safeLogger.error(category, '注册模型下载管理IPC处理程序失败:', err)
      } else {
        console.error('注册模型下载管理IPC处理程序失败且logger未定义:', err)
      }
    }
  }

  /**
   * 注册事件监听器 (用于主进程日志记录)
   */
  private registerEventListeners(ModelDownloadManagerClass: any): void {
    if (!ModelDownloadManagerClass) return
    const manager = ModelDownloadManagerClass.getInstance()
    if (!manager) return

    const safeLogger = this.getLogger()
    const category = LogCategory?.IPC || 'IPC'

    // 监听管理器发出的广播事件（用于后端日志）
    manager.on('model-download-progress', (data: any) => {
      if (data.status === 'error') {
        safeLogger.warn(category, '[ModelDownloadManagerIPC] 任务错误事件:', data)
      } else if (data.status === 'canceled') {
        safeLogger.info(category, '[ModelDownloadManagerIPC] 任务取消事件:', data)
      } else {
        // 进度信息较多，仅在 Debug 模式记录
        safeLogger.debug(category, '[ModelDownloadManagerIPC] 任务进度事件:', data)
      }
    })

    manager.on('model-download-complete', (data: any) => {
      safeLogger.info(category, '[ModelDownloadManagerIPC] 任务完成事件:', data)
    })
  }

  /**
   * 序列化任务数据（移除敏感信息）
   */
  private serializeTask(task: any, DownloadStatusEnum: any): any {
    if (!task) return null

    return {
      taskId: task.taskId,
      modelId: task.modelId,
      status: this.mapStatusToString(task.status, DownloadStatusEnum),
      receivedBytes: task.receivedBytes || 0,
      totalBytes: task.totalBytes || 0,
      progress: task.percent || 0, // 直接使用 percent
      speedBps: task.speedBps,
      currentFileName: task.fileName || task.currentFileName,
      error: task.error
    }
  }

  /**
   * 映射状态为字符串
   */
  private mapStatusToString(status: any, DownloadStatusEnum: any): string {
    if (!DownloadStatusEnum) return 'unknown'
    switch (status) {
      case DownloadStatusEnum.PENDING:
        return 'pending'
      case DownloadStatusEnum.DOWNLOADING:
        return 'downloading'
      case DownloadStatusEnum.RETRYING:
        return 'retrying'
      case DownloadStatusEnum.COMPLETED:
        return 'completed'
      case DownloadStatusEnum.ERROR:
        return 'error'
      case DownloadStatusEnum.CANCELLED:
        return 'canceled'
      default:
        return 'unknown'
    }
  }
}
