import { AnalysisQueueItem, AnalysisStats } from '@firefly/types'
import { LogCategory, logger, FileCategory, getFileCategory } from '@firefly/shared'
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
import { engineBridgeService } from '../engine-bridge'
import { isTransientInfraError } from './file-processor/analysis-error-classifier'
import { cloudSyncWorker } from '../ai/cloud-sync-worker'
import { moduleHibernationCoordinator } from '../hibernation/module-hibernation-coordinator'
import { FtsProjectionService } from '../database/fts-projection'

export class AnalysisOrchestratorWorker {
  constructor(
    private queueManager: QueueManager,
    private aiServiceManager: AIServiceManager,
    private directoryProcessor: DirectoryProcessor,
    private fileProcessor: FileProcessor,
    private ftsProjectionService: FtsProjectionService,
    private updateItemStatus: (
      itemId: number,
      status: 'pending' | 'analyzing' | 'completed' | 'failed',
      progress: number,
      error?: string,
      extra?: any
    ) => void
  ) {}

  async runParallel(
    pendingItems: AnalysisQueueItem[],
    signal: AbortSignal,
    stage2WaitTimeoutMs: number
  ) {
    const notifier = new StageNotifier()
    const cpuSkippedIds = new Set<number>()

    const isVideoFile = (filePath: string): boolean => {
      return getFileCategory(filePath) === FileCategory.VIDEO
    }

    const isAlreadyStage2 = (item: AnalysisQueueItem): boolean => {
      const db = databaseService.db
      if (!db || !item.workspaceId) return false
      const stage = getFileStageFromDB(db, item.workspaceId, item.path)
      return stage >= 2
    }

    const runCPUProducer = async () => {
      for (const item of pendingItems) {
        if (signal.aborted) break
        if (!this.queueManager.hasItem(item.id)) {
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
              const wf = databaseService
                .db!.prepare(
                  'SELECT file_fingerprint FROM workspace_files WHERE workspace_id = ? AND path = ?'
                )
                .get(item.workspaceId!, item.path) as { file_fingerprint?: string } | undefined
              const completeness = await checkBasicDataCompleteness(
                databaseService.db!,
                item.workspaceId!,
                item.path,
                wf?.file_fingerprint
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

        try {
          this.updateItemStatus(item.id, 'analyzing', 10, undefined, { analysisStage: 2 })
          await this.fileProcessor.processFile(item, signal, 'cpu')
          notifier.notify(item.id)
        } catch (err) {
          this.updateItemStatus(
            item.id,
            'failed',
            100,
            err instanceof Error ? err.message : String(err)
          )
          notifier.notify(item.id)
        }
      }
    }

    const runGPUConsumer = async () => {
      for (const item of pendingItems) {
        if (signal.aborted) break
        if (!this.queueManager.hasItem(item.id)) continue

        if (item.itemType === 'directory') {
          this.updateItemStatus(item.id, 'analyzing', 0)
          await this.directoryProcessor.processDirectory(item)
          continue
        }

        try {
          await notifier.waitForStage2(
            item.id,
            () => cpuSkippedIds.has(item.id),
            signal,
            stage2WaitTimeoutMs
          )

          if (!this.queueManager.hasItem(item.id)) continue
          if (item.status === 'failed') continue

          this.updateItemStatus(item.id, 'analyzing', 51, undefined, { analysisStage: 3 })
          await this.fileProcessor.processFile(item, signal, 'gpu', cpuSkippedIds.has(item.id))
          // 强制接入同步逻辑：确保 rowid 在 files_fts 和 files_pinyin_fts 同步
          // 修正：syncFTSTags 接收的是 fingerprint
          const wf = databaseService
            .db!.prepare(
              'SELECT file_fingerprint FROM workspace_files WHERE workspace_id = ? AND path = ?'
            )
            .get(item.workspaceId!, item.path) as { file_fingerprint?: string } | undefined
          if (wf?.file_fingerprint) {
            await this.ftsProjectionService.syncFTSTags(wf.file_fingerprint)
          }
          cloudSyncWorker.triggerSync(2000)
        } catch (err: any) {
          const isAbort = err && (err.name === 'AbortError' || err.message === 'Aborted')
          const isStage2Timeout =
            err instanceof Stage2TimeoutError || err?.name === 'Stage2TimeoutError'

          if (isStage2Timeout || isAbort) {
            this.updateItemStatus(item.id, 'pending', 0)
          } else if (isTransientInfraError(err)) {
            this.updateItemStatus(item.id, 'pending', 0)
            const isReady = await this.aiServiceManager.waitForAIServiceReady()
            if (isReady && !signal.aborted) {
              // Retry logic...
              await this.fileProcessor.processFile(item, signal, 'gpu', cpuSkippedIds.has(item.id))
            } else {
              this.updateItemStatus(
                item.id,
                'failed',
                100,
                err instanceof Error ? err.message : String(err)
              )
            }
          } else {
            this.updateItemStatus(
              item.id,
              'failed',
              100,
              err instanceof Error ? err.message : String(err)
            )
          }
        }
      }
    }

    moduleHibernationCoordinator.notifyModuleResident('firefly-ai-engine')
    await Promise.all([runCPUProducer(), runGPUConsumer()])
  }
}
