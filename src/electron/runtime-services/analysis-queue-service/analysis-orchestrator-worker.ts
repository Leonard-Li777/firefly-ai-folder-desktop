import { AnalysisQueueItem } from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import { StageNotifier, Stage2TimeoutError } from './stage-notifier'
import { AIServiceManager } from './ai-service-manager'
import { QueueManager } from './queue-manager'
import { DirectoryProcessor } from './directory-processor'
import {
  FileProcessor,
  getFileStageFromDB,
  getFileAnalysisStateFromDB,
  checkBasicDataCompleteness
} from './file-processor'
import { databaseService } from '../database/database-service'
import { ConfigOrchestrator } from '@app/electron/config/config-orchestrator'
import { isTimeoutError, isTransientInfraError } from './file-processor/analysis-error-classifier'
import { cloudSyncWorker } from '../ai/cloud-sync-worker'
import { moduleHibernationCoordinator } from '../hibernation/module-hibernation-coordinator'
import { queueFtsSync } from './fts-sync-hooks'
import type { OmniHttpAdapter } from './omni-http-adapter'
import type { AnalysisItemStatusExtra } from './analysis-write-dispatcher'

/**
 * 分析队列流水线调度 Worker：承载并行 CPU/GPU 双通道与串行单项分发。
 *
 * 通过 Getter 延迟读取 QueueManager，避免服务构造阶段未 initialize 导致绑定 `undefined`。
 */
export class AnalysisOrchestratorWorker {
  /** 并行模式双通道正在处理的队列项引用计数（防 OrphanWatchdog 误杀长耗时在跑项） */
  private activeItemCounts = new Map<number, number>()
  /** 当前并行批次所属工作空间 ID（供 pause() 精确中止并行双通道） */
  private activeParallelWorkspaceId: number | null = null

  constructor(
    private getQueueManager: () => QueueManager | undefined,
    private aiServiceManager: AIServiceManager,
    private directoryProcessor: DirectoryProcessor,
    private fileProcessor: FileProcessor,
    private updateItemStatus: (
      itemId: number,
      status: 'pending' | 'analyzing' | 'completed' | 'failed',
      progress: number,
      error?: string,
      extra?: AnalysisItemStatusExtra
    ) => void
  ) {}

  /** 判断指定队列项是否正在并行双通道中运行 */
  isItemActive(itemId: number): boolean {
    return (this.activeItemCounts.get(itemId) ?? 0) > 0
  }

  /** 判断并行双通道是否有活跃任务（可选按 workspaceId 过滤） */
  hasActiveItems(workspaceId?: number): boolean {
    if (this.activeItemCounts.size === 0) return false
    if (workspaceId === undefined) return true
    return this.activeParallelWorkspaceId === workspaceId
  }

  private markActive(itemId: number): void {
    this.activeItemCounts.set(itemId, (this.activeItemCounts.get(itemId) ?? 0) + 1)
  }

  private unmarkActive(itemId: number): void {
    const next = (this.activeItemCounts.get(itemId) ?? 0) - 1
    if (next <= 0) {
      this.activeItemCounts.delete(itemId)
    } else {
      this.activeItemCounts.set(itemId, next)
    }
  }

  async runSerialItem(
    next: AnalysisQueueItem,
    signal: AbortSignal,
    aiStageEnabled: boolean,
    omniAdapter: OmniHttpAdapter,
    logWarning: (message: string, error?: unknown) => void
  ): Promise<void> {
    this.updateItemStatus(next.id, 'analyzing', 0)

    // 普通分析任务：仅在启用 AI 阶段时确保引擎处于主语言模型模式；标准分析模式无需语言模型
    if (aiStageEnabled) {
      const modeRes = await omniAdapter.ensureMode('language')
      if (modeRes && !modeRes.ok) {
        logWarning('[普通分析] 切换主语言模型告警:', modeRes.error)
      }
    }
    if (next.itemType === 'directory') {
      await this.directoryProcessor.processDirectory(next)
    } else {
      await this.fileProcessor.processFile(next, signal)
      cloudSyncWorker.triggerSync(2000)
    }
  }

  async runParallel(
    pendingItems: AnalysisQueueItem[],
    signal: AbortSignal,
    stage2WaitTimeoutMs: number
  ) {
    const notifier = new StageNotifier()
    const cpuSkippedIds = new Set<number>()

    const isAlreadyStage2 = (item: AnalysisQueueItem): boolean => {
      const db = databaseService.db
      if (!db || !item.workspaceId) return false
      const stage = getFileStageFromDB(db, item.workspaceId, item.path)
      return stage >= 2
    }

    const runCPUProducer = async () => {
      for (const item of pendingItems) {
        if (signal.aborted) break
        if (!this.getQueueManager()?.hasItem(item.id)) {
          notifier.notify(item.id)
          continue
        }

        if (item.itemType === 'directory') {
          notifier.notify(item.id)
          continue
        }

        let shouldSkipCpu = false
        try {
          const reuseBasicAnalysisData =
            ConfigOrchestrator.getInstance().getValue<boolean>('REUSE_BASIC_ANALYSIS_DATA') ?? true

          if (isAlreadyStage2(item)) {
            if (!reuseBasicAnalysisData) {
              shouldSkipCpu =
                item.forceReanalyze !== true &&
                !getFileAnalysisStateFromDB(databaseService.db!, item.workspaceId!, item.path)
                  .isAnalyzed
            } else {
              const fileFingerprint =
                databaseService.getFileFingerprintByPath(item.path) ?? undefined
              const completeness = await checkBasicDataCompleteness(
                databaseService.db!,
                item.workspaceId!,
                item.path,
                fileFingerprint
              )
              if (completeness.isComplete) {
                shouldSkipCpu = true
              }
            }
          }
        } catch (preErr) {
          logger.error(
            LogCategory.ANALYSIS_QUEUE,
            `[并行队列:CPU通道] 阶段判定异常: ${item.name}`,
            preErr
          )
        }

        if (shouldSkipCpu) {
          cpuSkippedIds.add(item.id)
          this.updateItemStatus(item.id, 'pending', 50, undefined, { analysisStage: 2 })
          notifier.notify(item.id)
          continue
        }

        this.markActive(item.id)
        try {
          this.updateItemStatus(item.id, 'analyzing', 10, undefined, { analysisStage: 2 })
          await this.fileProcessor.processFile(item, signal, 'cpu')
          notifier.notify(item.id)
        } catch (err: unknown) {
          this.updateItemStatus(
            item.id,
            'failed',
            100,
            err instanceof Error ? err.message : String(err),
            { isTimeout: isTimeoutError(err) }
          )
          notifier.notify(item.id)
        } finally {
          this.unmarkActive(item.id)
        }
      }
    }

    const runGPUConsumer = async () => {
      for (const item of pendingItems) {
        if (signal.aborted) break
        if (!this.getQueueManager()?.hasItem(item.id)) continue

        if (item.itemType === 'directory') {
          this.markActive(item.id)
          try {
            this.updateItemStatus(item.id, 'analyzing', 0)
            await this.directoryProcessor.processDirectory(item)
          } finally {
            this.unmarkActive(item.id)
          }
          continue
        }

        this.markActive(item.id)
        try {
          await notifier.waitForStage2(
            item.id,
            () => cpuSkippedIds.has(item.id),
            signal,
            stage2WaitTimeoutMs
          )

          if (!this.getQueueManager()?.hasItem(item.id)) continue
          if (item.status === 'failed') continue

          this.updateItemStatus(item.id, 'analyzing', 51, undefined, { analysisStage: 3 })
          await this.fileProcessor.processFile(item, signal, 'gpu', cpuSkippedIds.has(item.id))
          // 收口 FTS 同步至防抖 Hook，避免绕过窗口聚合高频写盘
          const fileFingerprint = databaseService.getFileFingerprintByPath(item.path)
          if (fileFingerprint) {
            queueFtsSync(fileFingerprint)
          }
          cloudSyncWorker.triggerSync(2000)
        } catch (err: unknown) {
          const errObj = err as { name?: string; message?: string } | null
          const isAbort = Boolean(
            errObj && (errObj.name === 'AbortError' || errObj.message === 'Aborted')
          )
          const isStage2Timeout =
            err instanceof Stage2TimeoutError || errObj?.name === 'Stage2TimeoutError'

          if (isStage2Timeout || isAbort) {
            this.updateItemStatus(item.id, 'pending', 0)
          } else if (isTransientInfraError(err)) {
            this.updateItemStatus(item.id, 'pending', 0)
            const isReady = await this.aiServiceManager.waitForAIServiceReady()
            if (isReady && !signal.aborted) {
              try {
                await this.fileProcessor.processFile(
                  item,
                  signal,
                  'gpu',
                  cpuSkippedIds.has(item.id)
                )
                const retryFingerprint = databaseService.getFileFingerprintByPath(item.path)
                if (retryFingerprint) {
                  queueFtsSync(retryFingerprint)
                }
                cloudSyncWorker.triggerSync(2000)
              } catch (retryErr: unknown) {
                const retryObj = retryErr as { name?: string; message?: string } | null
                const isRetryAbort = Boolean(
                  retryObj && (retryObj.name === 'AbortError' || retryObj.message === 'Aborted')
                )
                if (isRetryAbort) {
                  this.updateItemStatus(item.id, 'pending', 0)
                } else {
                  this.updateItemStatus(
                    item.id,
                    'failed',
                    100,
                    retryErr instanceof Error ? retryErr.message : String(retryErr),
                    { isTimeout: isTimeoutError(retryErr) }
                  )
                }
              }
            } else if (!signal.aborted) {
              this.updateItemStatus(
                item.id,
                'failed',
                100,
                err instanceof Error ? err.message : String(err),
                { isTimeout: isTimeoutError(err) }
              )
            }
          } else {
            this.updateItemStatus(
              item.id,
              'failed',
              100,
              err instanceof Error ? err.message : String(err),
              { isTimeout: isTimeoutError(err) }
            )
          }
        } finally {
          this.unmarkActive(item.id)
        }
      }
    }

    moduleHibernationCoordinator.notifyModuleResident('firefly-ai-engine')
    this.activeParallelWorkspaceId = pendingItems[0]?.workspaceId ?? null
    try {
      await Promise.all([runCPUProducer(), runGPUConsumer()])
    } finally {
      this.activeParallelWorkspaceId = null
    }
  }
}
