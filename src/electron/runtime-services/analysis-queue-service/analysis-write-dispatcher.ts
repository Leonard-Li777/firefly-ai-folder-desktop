import { BrowserWindow } from 'electron'
import { LogCategory, logger } from '@firefly/shared'
import type { AnalysisQueueSnapshot, AnalysisStats } from '@firefly/types'
import { t } from '@app/languages'
import { databaseService } from '../database/database-service'
import { QueueManager } from './queue-manager'

export type FrontendNotifyType = 'info' | 'success' | 'warning' | 'error'

export interface AnalysisItemStatusExtra {
  analysisStats?: AnalysisStats
  fromCache?: boolean
  analysisStage?: number
  /** 结构化超时标记（由 classifyAnalysisError / isTimeoutError 产生，严禁中文文案匹配） */
  isTimeout?: boolean
}

export type FrontendNotifyFn = (
  type: FrontendNotifyType,
  message: string,
  sticky?: boolean,
  id?: string,
  autoClose?: number,
  action?: any
) => void | Promise<void>

/**
 * 分析队列状态写回与渲染进程通知分发器。
 *
 * 通过惰性 Getter 读取 QueueManager 与完整 Snapshot，避免构造函数执行期
 * `queueManager` 尚未初始化导致的 `undefined` 绑定漏洞。
 */
export class AnalysisWriteDispatcher {
  constructor(
    private getQueueManager: () => QueueManager | undefined,
    private getSnapshot: () => AnalysisQueueSnapshot,
    private customNotifyFrontend?: FrontendNotifyFn
  ) {}

  updateItemStatus(
    itemId: number,
    status: 'pending' | 'analyzing' | 'completed' | 'failed',
    progress: number,
    error?: string,
    extra?: AnalysisItemStatusExtra
  ): void {
    const queueManager = this.getQueueManager()
    if (!queueManager) return
    const item = queueManager.getQueue().find(i => i.id === itemId)
    if (!item) return

    if (status === 'failed' && extra?.isTimeout === true) {
      void this.notifyFrontend(
        'warning',
        `${t('分析超时')}: ${item.name}。${t('建议切换低显存需求的AI模型')}`,
        false,
        `timeout-${itemId}`,
        5000,
        // PRD-0044：模型管理 tab 已合并，通知跳链改指「高级AI引擎配置」
        { label: t('前往设置'), category: 'AI_ENGINE_CONFIG' }
      )
    }

    item.status = status
    item.progress = progress
    item.updatedAt = Date.now()
    if (error !== undefined) item.error = error
    if (extra?.analysisStats) item.analysisStats = extra.analysisStats
    if (extra?.fromCache !== undefined) item.fromCache = extra.fromCache

    const currentStage =
      extra?.analysisStage ??
      (extra?.analysisStats ? Number(extra.analysisStats.analysis_stage) : undefined)

    if (currentStage !== undefined) {
      item.analysisStage = currentStage
      item.stage = currentStage as any
    } else if (status === 'completed') {
      const statsStage = item.analysisStats ? Number(item.analysisStats.analysis_stage) : undefined
      const finalStage = item.analysisStage ?? statsStage ?? 4
      item.analysisStage = finalStage
      item.stage = finalStage as any
    }

    try {
      databaseService.updateAnalysisQueue({ id: itemId, status, progress, error: error || null })
    } catch (e) {
      logger.warn(LogCategory.MAIN, '[AnalysisQueue] 更新分析队列状态到数据库失败:', e)
    }
    this.emitUpdate()

    if (status === 'completed' || status === 'failed') {
      try {
        const windows = BrowserWindow.getAllWindows()
        if (windows && windows.length > 0) {
          windows.forEach(win => {
            if (!win.webContents.isDestroyed()) {
              win.webContents.send('file-analysis-updated', {
                filePath: item.path,
                fileFingerprint: (item as any).fileFingerprint,
                status,
                source: 'queue'
              })
            }
          })
        }
      } catch (e) {
        logger.warn(LogCategory.MAIN, '[AnalysisQueue] 发送文件分析更新通知失败:', e)
      }
    }
  }

  notifyLatchBrake(workspaceId: number): void {
    const windows = BrowserWindow.getAllWindows()
    if (windows && windows.length > 0) {
      windows.forEach(win => {
        if (!win.webContents.isDestroyed()) {
          try {
            win.webContents.send('analysis-queue/latch-brake', { workspaceId })
          } catch (e) {
            logger.warn(LogCategory.MAIN, '[AnalysisQueue] 发送动态刹车通知失败:', e)
          }
        }
      })
    }
  }

  emitUpdate(): void {
    const windows = BrowserWindow.getAllWindows()
    const snapshot = this.getSnapshot()
    if (windows && windows.length > 0) {
      windows.forEach(win => {
        if (!win.webContents.isDestroyed()) {
          try {
            win.webContents.send('analysis-queue-updated', snapshot)
          } catch (e) {
            logger.warn(LogCategory.MAIN, '[AnalysisQueue] 发送更新通知到窗口失败:', e)
          }
        }
      })
    }
  }

  async notifyFrontend(
    type: FrontendNotifyType,
    message: string,
    sticky = false,
    id?: string,
    autoClose?: number,
    action?: any
  ): Promise<void> {
    if (this.customNotifyFrontend) {
      await this.customNotifyFrontend(type, message, sticky, id, autoClose, action)
      return
    }
    try {
      const windows = BrowserWindow.getAllWindows()
      if (windows && windows.length > 0) {
        windows.forEach(win => {
          if (!win.webContents.isDestroyed()) {
            win.webContents.send('system:notification', {
              type,
              message,
              sticky,
              id,
              autoClose,
              action
            })
          }
        })
      }
    } catch (e) {
      logger.warn(LogCategory.MAIN, '[AnalysisQueue] notifyFrontend 发送通知失败:', e)
    }
  }
}
