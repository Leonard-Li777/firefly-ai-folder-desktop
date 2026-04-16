import { OrganizeProgress } from '@yonuc/types/organize-types'
import { logger, LogCategory } from '@yonuc/shared'
import { t } from '@app/languages'

/**
 * 整理进度追踪器
 * 用于计算和报告文件整理的实时进度
 */
export class OrganizeProgressTracker {
  private startTime: number
  private processedCount: number = 0
  private totalCount: number
  private currentFile: string = ''
  private onProgressUpdate?: (progress: OrganizeProgress) => void

  constructor(totalCount: number, onProgressUpdate?: (progress: OrganizeProgress) => void) {
    this.totalCount = totalCount
    this.startTime = Date.now()
    this.onProgressUpdate = onProgressUpdate
  }

  /**
   * 更新当前处理的文件
   */
  updateCurrentFile(fileName: string): void {
    this.currentFile = fileName
    this.emitProgress()
  }

  /**
   * 增加已处理文件计数
   */
  incrementProcessed(): void {
    this.processedCount++
    this.emitProgress()
  }

  /**
   * 获取当前进度
   */
  getProgress(): OrganizeProgress {
    const percentage = this.totalCount > 0
      ? Math.round((this.processedCount / this.totalCount) * 100)
      : 0

    const estimatedTimeRemaining = this.getEstimatedTimeRemaining()

    return {
      currentFile: this.currentFile,
      processedCount: this.processedCount,
      totalCount: this.totalCount,
      percentage,
      estimatedTimeRemaining,
    }
  }

  /**
   * 获取预计剩余时间（秒）
   */
  private getEstimatedTimeRemaining(): number {
    if (this.processedCount === 0) return 0

    const elapsedTime = Date.now() - this.startTime
    const avgTimePerFile = elapsedTime / this.processedCount
    const remainingFiles = this.totalCount - this.processedCount

    return Math.ceil((avgTimePerFile * remainingFiles) / 1000)
  }

  /**
   * 发送进度更新
   */
  private emitProgress(): void {
    if (this.onProgressUpdate) {
      const progress = this.getProgress()
      this.onProgressUpdate(progress)
      
      // 每10个文件记录一次日志，避免日志过多
      if (this.processedCount % 10 === 0 || this.processedCount === this.totalCount) {
        logger.debug(LogCategory.FILE_ORGANIZATION, '进度更新', {
          processed: this.processedCount,
          total: this.totalCount,
          percentage: progress.percentage,
        })
      }
    }
  }

  /**
   * 重置进度
   */
  reset(totalCount: number): void {
    this.startTime = Date.now()
    this.processedCount = 0
    this.totalCount = totalCount
    this.currentFile = ''
  }

  /**
   * 完成追踪
   */
  complete(): void {
    this.processedCount = this.totalCount
    this.currentFile = t('完成')
    this.emitProgress()
  }
}

