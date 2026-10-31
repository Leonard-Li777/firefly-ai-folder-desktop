import { ipcMain } from 'electron'
import { analysisQueueService } from '../../runtime-services/analysis-queue-service'
import { logger, LogCategory } from '@firefly/shared'

/**
 * 渲染进程可声明的 canonical 重建来源白名单。
 *
 * `reason` 会进入 `logger.info` 与设置页「最近一次重建：{reason}」文案，
 * 属渲染进程可控字符串，必须先收敛再落日志/上屏（防换行注入与任意文案）。
 * 服务内部的自动来源（`startup` / `AI_EMBEDDING_PROFILE:...`）不经此 IPC，不受此限。
 */
const CANONICAL_MAINTENANCE_REASONS = new Set(['settings_manual', 'manual'])

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

  /**
   * 工单 13：canonical 语义索引重建计数。
   * 工单 06 只暴露了服务方法（`getCanonicalRebuildCounts`），设置页需要的读数出口在此补齐。
   */
  ipcMain.handle('analysis-queue/canonical-rebuild-counts', async () => {
    try {
      return analysisQueueService.getCanonicalRebuildCounts()
    } catch (error) {
      logger.error(LogCategory.MAIN, '[IPC] 获取 canonical 重建计数失败:', error)
      throw error
    }
  })

  /** 工单 13：手动触发 canonical 语义索引重建（设置页「重建语义索引」入口） */
  ipcMain.handle('analysis-queue/run-canonical-maintenance', async (_event, reason?: unknown) => {
    try {
      // reason 会进入日志行与设置页「最近一次重建：{reason}」文案，
      // 渲染进程可控字符串必须先收敛到白名单，避免换行注入与任意文案上屏。
      const safeReason =
        typeof reason === 'string' && CANONICAL_MAINTENANCE_REASONS.has(reason)
          ? reason
          : 'settings_manual'
      await analysisQueueService.runCanonicalMaintenance(safeReason)
      return { success: true }
    } catch (error) {
      logger.error(LogCategory.MAIN, '[IPC] 触发 canonical 重建失败:', error)
      throw error
    }
  })
}
