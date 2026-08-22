import { ipcMain } from 'electron'
import { analysisQueueService } from '../../runtime-services/analysis-queue-service'
import { logger, LogCategory } from '@firefly/shared'

export function registerAnalysisQueueIPCHandlers() {
  ipcMain.handle('analysis-queue/get', async (event, workspaceId?: number) => {
    return analysisQueueService.getSnapshot(workspaceId)
  })
  ipcMain.handle(
    'analysis-queue/add',
    async (
      event,
      items: { path: string; name: string; size: number; type: string }[],
      forceReanalyze?: boolean
    ) => {
      try {
        await analysisQueueService.addItems(items, !!forceReanalyze)
      } catch (error) {
        logger.error(LogCategory.MAIN, '[IPC] 添加分析队列项目失败:', error)
        throw error
      }
    }
  )
  ipcMain.handle(
    'analysis-queue/add-resolve',
    async (
      event,
      items: { path: string; name: string; size: number; type: string }[],
      forceReanalyze?: boolean
    ) => {
      try {
        await analysisQueueService.addItemsResolved(items, !!forceReanalyze)
      } catch (error) {
        logger.error(LogCategory.MAIN, '[IPC] 添加解析分析队列项目失败:', error)
        throw error
      }
    }
  )
  ipcMain.handle('analysis-queue/retry-failed', async () => {
    try {
      await analysisQueueService.retryFailed()
    } catch (error) {
      logger.error(LogCategory.MAIN, '[IPC] 重试失败队列项目失败:', error)
      throw error
    }
  })
  ipcMain.handle('analysis-queue/clear-pending', async () => {
    try {
      await analysisQueueService.clearPending()
    } catch (error) {
      logger.error(LogCategory.MAIN, '[IPC] 清空待处理队列失败:', error)
      throw error
    }
  })
  ipcMain.handle('analysis-queue/clear-all', async () => {
    try {
      await analysisQueueService.clearAll()
    } catch (error) {
      logger.error(LogCategory.MAIN, '[IPC] 清空全部队列失败:', error)
      throw error
    }
  })
  ipcMain.handle('analysis-queue/delete-item', async (event, id: number) => {
    try {
      await analysisQueueService.deleteItem(id)
    } catch (error) {
      logger.error(LogCategory.MAIN, `[IPC] 删除队列项目失败: ${id}`, error)
      throw error
    }
  })
  ipcMain.handle('analysis-queue/start', async (event, workspaceId?: number) => {
    try {
      await analysisQueueService.start(workspaceId)
    } catch (error) {
      logger.error(LogCategory.MAIN, '[IPC] 启动分析队列失败:', error)
      throw error
    }
  })
  ipcMain.handle('analysis-queue/pause', async (event, workspaceId?: number) => {
    try {
      await analysisQueueService.pause(workspaceId)
    } catch (error) {
      logger.error(LogCategory.MAIN, '[IPC] 暂停分析队列失败:', error)
      throw error
    }
  })

  ipcMain.handle('analysis-queue/check-extension-mismatch', async (event, workspaceId: number) => {
    try {
      return await analysisQueueService.checkExtensionMismatch(workspaceId)
    } catch (error) {
      logger.error(LogCategory.MAIN, '[IPC] 检查扩展名不匹配失败:', error)
      throw error
    }
  })

  ipcMain.handle(
    'analysis-queue/batch-fix-extensions',
    async (event, fixes: Array<{ fileFingerprint: string; chosenExtension: string | null }>) => {
      try {
        return await analysisQueueService.batchFixExtensions(fixes)
      } catch (error) {
        logger.error(LogCategory.MAIN, '[IPC] 批量修正扩展名失败:', error)
        throw error
      }
    }
  )

  ipcMain.handle('analysis-queue/check-stage4-files', async (event, filePaths: string[]) => {
    try {
      return await analysisQueueService.checkAlreadyAnalyzedFiles(filePaths)
    } catch (error) {
      logger.error(LogCategory.MAIN, '[IPC] 检查已分析文件失败:', error)
      throw error
    }
  })

  ipcMain.handle(
    'analysis-queue/check-already-analyzed-files',
    async (event, filePaths: string[]) => {
      try {
        return await analysisQueueService.checkAlreadyAnalyzedFiles(filePaths)
      } catch (error) {
        logger.error(LogCategory.MAIN, '[IPC] 检查已分析文件失败:', error)
        throw error
      }
    }
  )
}
