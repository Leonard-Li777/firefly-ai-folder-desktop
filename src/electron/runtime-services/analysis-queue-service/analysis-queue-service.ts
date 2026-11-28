import type {
  AnalysisQueueItem,
  AnalysisQueueSnapshot,
  IIgnoreRule,
  QueueLifecyclePhase,
  WarmupAbortReason,
  WarmupHintCode
} from '@firefly/types'
import { t } from '@app/languages'
import {
  DimensionAnalyzer,
  QualityScoringService,
  UnitRecognitionService,
  FileProcessorService
} from '@firefly/core-engine'
import type { EnqueueInput, IErrorRecoveryConfig } from './types'
import { LogCategory, logger, isCpuBackend, isPathEqual, isSubPath } from '@firefly/shared'
import { loggingService } from '../system/logging-service'
import { systemHealthService } from '../system'
import { loadIgnoreRules } from '../analysis/analysis-ignore-service'
import { LlamaIndexAIService } from '@firefly/electron-llamaIndex-service'
import { AIServiceStatus, ILlamaIndexAIService } from '@firefly/types'
import { ConfigOrchestrator } from '@app/electron/config/config-orchestrator'
import { resolveEffectiveAnalysisMode, isAiStageEnabled } from '@app/electron/config/analysis-mode'
import { DirectoryContextService } from '../filesystem/directory-context-service'
import { QueueManager, pickNextPending, type EnqueueResult } from './queue-manager'
export type { EnqueueResult }
import { cloudSyncWorker } from '../ai/cloud-sync-worker'
import { createCoreEngineAdapters } from '../../adapters'
import { databaseService } from '../database/database-service'
import { moduleHibernationCoordinator } from '../hibernation/module-hibernation-coordinator'
import { AIServiceManager } from './ai-service-manager'
import { AnalysisStatsCollector } from './analysis-stats-collector'
import { DirectoryProcessor } from './directory-processor'
import { FileProcessor } from './file-processor'
import { resolveWorkspaceVideoDurationLimits } from './file-processor/db-analysis-state'
import {
  bumpRetagEpochIfNoActiveTask,
  resolveTargetProfileAndDim
} from './file-processor/stage-reuse-planner'
import {
  AnalysisWarmupBarrier,
  BatchPlanSession,
  deriveWindowWarmupPlan,
  isWarmupAbortError
} from './analysis-warmup-barrier'
import {
  canonicalMaintenanceService,
  installCanonicalMaintenanceListener
} from './canonical-maintenance-service'
import {
  VideoSegmentBackfillWorker,
  computeVideoVisualParamsHash
} from './video-segment-backfill-worker'
import { visualTaggerCoordinator, isVisualMediaExtensionOrPath } from './visual-tagger-coordinator'
import { anydocService } from '../system/anydoc-service'
import { omniClient } from '../../services/omni-client'
import { ProbeBridgeService } from '../e2e/probe-bridge'
import { getE2EConfig } from '../e2e/e2e-gate'
import { resolveWorkspaceEffectiveConfig } from '../system/workspace-analysis-context'
import { userTierService } from '../user-tier/user-tier-service'

import { StageNotifier, Stage2TimeoutError, STAGE2_WAIT_TIMEOUT_MS } from './stage-notifier'
export { StageNotifier, Stage2TimeoutError }
import { AnalysisWriteDispatcher } from './analysis-write-dispatcher'
import { AnalysisOrchestratorWorker } from './analysis-orchestrator-worker'
import { OmniHttpAdapter } from './omni-http-adapter'
import { OrphanWatchdog } from './orphan-watchdog'
import { flushFtsSync, queueFtsSync } from './fts-sync-hooks'
import {
  WorkerOrchestratorBridge,
  WriteSetBatchDispatcher,
  AnalysisDbWriterProcess,
  type WorkerQueueItem,
  type WorkerWriteSink,
  type WriterTailHookPayload
} from './worker-orchestrator'
import {
  createWriterProcessStack,
  type WriterProcessStack
} from './worker-orchestrator/writer-process-wiring'
import {
  checkExtensionMismatchFiles,
  batchFixFileExtensions,
  checkAlreadyAnalyzedFilesByPaths,
  updateVirtualDirectoriesAfterQueueCompletion,
  type ExtensionMismatchItem
} from './extension-and-precheck-helpers'

/**
 * 分析队列服务类
 * 整合所有模块,实现完整的文件分析队列处理
 */
export class AnalysisQueueService {
  private queueManager!: QueueManager
  private fileProcessorService!: FileProcessorService

  private dimensionAnalyzer!: DimensionAnalyzer
  private qualityScoringService!: QualityScoringService
  private unitRecognitionService!: UnitRecognitionService
  private directoryContextService?: DirectoryContextService
  private aiService?: ILlamaIndexAIService

  private running = false
  private runningWorkspaceStack: number[] = []
  private isProcessingLoopActive = false
  private current?: AnalysisQueueItem
  private isInitialized = false
  private initializePromise?: Promise<void>
  /**
   * GPU 通道等待 CPU 提取的就绪超时。默认 30 分钟，单测会把它改小以覆盖超时分支。
   */
  private stage2WaitTimeoutMs: number = STAGE2_WAIT_TIMEOUT_MS

  private ignoreRules: IIgnoreRule[] = []
  private errorRecoveryConfig: IErrorRecoveryConfig = {
    maxRetries: 0,
    retryDelay: 0,
    fileProcessingTimeout: 0,
    aiRequestTimeout: 0,
    unitRecognitionTimeout: 0
  }

  // 委托组件
  private aiServiceManager: AIServiceManager
  private statsCollector: AnalysisStatsCollector
  private directoryProcessor: DirectoryProcessor
  private fileProcessor: FileProcessor
  private writeDispatcher: AnalysisWriteDispatcher
  private orchestratorWorker: AnalysisOrchestratorWorker
  private omniAdapter: OmniHttpAdapter
  private orphanWatchdog: OrphanWatchdog
  private writeSetBatchDispatcher: WriteSetBatchDispatcher
  private dbWriterProcess: AnalysisDbWriterProcess
  /** Stage2 S-B 数据面装配（宿主/本地执行器路由，见 writer-process-wiring.ts） */
  private writerProcessStack: WriterProcessStack
  /** Stage2 S-B 数据面路由：按 ANALYSIS_USE_DB_WRITER_PROCESS 特性开关在写进程与本地执行器间分派 */
  private writerSink: WorkerWriteSink
  private workerBridge: WorkerOrchestratorBridge
  private videoSegmentBackfillWorker: VideoSegmentBackfillWorker
  private currentAbortController: AbortController | null = null
  private abortGeneration = 0
  private currentAbortReason: WarmupAbortReason | null = null
  private warmingUpWorkspaceId: number | null = null
  private lifecyclePhase: QueueLifecyclePhase = 'idle'
  private warmupHintCode: WarmupHintCode | undefined = undefined
  private backoffMs = 50
  private readonly batchPlanSession = new BatchPlanSession()
  private readonly warmupBarrier = new AnalysisWarmupBarrier()

  /** 工单 06：canonical 档位切换维护监听的取消订阅句柄 */
  private canonicalMaintenanceUnsubscribe?: () => void

  private triggerAbort(reason: WarmupAbortReason): void {
    this.currentAbortReason = reason
    this.abortGeneration += 1
    if (this.currentAbortController) {
      this.currentAbortController.abort(reason)
      this.currentAbortController = null
    }
  }

  constructor() {
    // 初始化委托组件
    this.writeDispatcher = new AnalysisWriteDispatcher(
      () => this.queueManager,
      () => this.getSnapshot()
    )

    // Stage 2 Worker 写微事务执行器 + 独立 worker_threads 托管桥（B1~B7 全链路接线）
    this.writeSetBatchDispatcher = new WriteSetBatchDispatcher({
      getDb: () => databaseService.db,
      onWriteAck: ack => this.workerBridge.sendWriteAck(ack),
      onWakeCanonicalMaintenance: () => {
        void canonicalMaintenanceService.runMaintenance('stage2_write_set')
      },
      onTriggerCloudSync: delayMs => {
        cloudSyncWorker.triggerSync(delayMs)
      }
    })

    // Stage2 S-B（工单 05）：utilityProcess 独立写进程宿主。
    // 写连接移至子进程独立 PID（Spec Phase B），子进程复用同一 WriteSetBatchDispatcher
    // 实现；崩溃由 watchdog 指数退避重启并在 READY 后原序回灌未确认写集（WRITE_SET 不丢），
    // 连续崩溃超上限时经 onDegradedToLocal 显式降级回本地执行器（严禁静默丢写集）。
    // 路由装配细节见 writer-process-wiring.ts（保持本文件 <1000 行红线）。
    this.dbWriterProcess = new AnalysisDbWriterProcess({
      getDbPath: () => databaseService.getDbPath(),
      getDisplayLocale: () =>
        ConfigOrchestrator.getInstance().getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN',
      onWriteAck: ack => this.workerBridge.sendWriteAck(ack),
      onTailHook: (payload: WriterTailHookPayload) => {
        if (payload.canonicalWakeups.length > 0) {
          void canonicalMaintenanceService.runMaintenance('stage2_write_set')
        }
        if (payload.workspaceDeletes.length > 0) {
          logger.warn(
            LogCategory.ANALYSIS_QUEUE,
            `[分析队列] 写进程回传 ${payload.workspaceDeletes.length} 条失效工作区文件删除记录（由 canonical 维护周期兜底收敛）`
          )
        }
        if (payload.cloudSyncDelayMs !== undefined) {
          cloudSyncWorker.triggerSync(payload.cloudSyncDelayMs)
        }
      },
      onDegradedToLocal: (reason, entries) => {
        logger.error(
          LogCategory.ANALYSIS_QUEUE,
          `[分析队列] 写进程不可用 (reason=${reason})，${entries.length} 个写集显式降级至主进程本地执行器`
        )
        this.writerProcessStack.handleDegraded(reason, entries)
      }
    })

    // 特性开关热切换：true=写进程（Spec Phase B 绞杀者目标态）；false=主进程本地执行器。
    const useDbWriterProcess = (): boolean =>
      ConfigOrchestrator.getInstance().getValue<boolean>('ANALYSIS_USE_DB_WRITER_PROCESS') === true
    this.writerProcessStack = createWriterProcessStack({
      dbWriterProcess: this.dbWriterProcess,
      localDispatcher: this.writeSetBatchDispatcher,
      useDbWriterProcess,
      onDegradedAck: ack => this.workerBridge.sendWriteAck(ack)
    })
    this.writerSink = this.writerProcessStack.sink

    this.workerBridge = new WorkerOrchestratorBridge({
      getDb: () => databaseService.db,
      writeDispatcher: this.writerSink,
      onProgress: (queueId, stage, pct) => {
        this.writeDispatcher.updateItemStatus(queueId, 'analyzing', pct, undefined, {
          analysisStage: stage
        })
      },
      onItemFailed: (queueId, errorMessage, retryable) => {
        this.writeDispatcher.updateItemStatus(
          queueId,
          retryable ? 'pending' : 'failed',
          retryable ? 0 : 100,
          errorMessage
        )
      }
    })

    this.aiServiceManager = new AIServiceManager(
      () => this.aiService,
      () => this.running,
      (type, message, sticky, id, autoClose, action) =>
        this.writeDispatcher.notifyFrontend(type, message, sticky, id, autoClose, action)
    )

    this.omniAdapter = new OmniHttpAdapter()

    this.statsCollector = new AnalysisStatsCollector()
    this.videoSegmentBackfillWorker = new VideoSegmentBackfillWorker({
      hasMainQueuePendingOrRunning: () => {
        if (this.running || this.isProcessingLoopActive || this.runningWorkspaceStack.length > 0) {
          return true
        }
        const snap = this.queueManager?.getSnapshot()
        return Boolean(snap?.items?.some(i => i.status === 'pending' || i.status === 'analyzing'))
      },
      emitSnapshotUpdate: () => {
        this.writeDispatcher.emitUpdate()
      },
      onHibernationChange: active => {
        this.syncHibernationState(active)
      },
      resolveWorkspaceContext: async workspaceId => {
        const effectiveConfig = await resolveWorkspaceEffectiveConfig(workspaceId)
        const cachedTierData = userTierService.getCachedData?.()
        const { configuredLimitSec, effectiveLimitSec } = resolveWorkspaceVideoDurationLimits(
          effectiveConfig,
          cachedTierData?.computed_limits
        )
        const videoFrameQuotaMax = effectiveConfig.effectiveParams.videoFrameQuotaMax ?? 60
        const videoSoftTokenBudget = effectiveConfig.effectiveParams.videoSoftTokenBudget ?? 140
        const videoCutSensitivity =
          (effectiveConfig.effectiveParams.videoCutSensitivity as any) || 'medium'
        const paramsHash = computeVideoVisualParamsHash(
          videoFrameQuotaMax,
          videoSoftTokenBudget,
          videoCutSensitivity
        )
        const allWs = (await databaseService.getAllWorkspaceDirectories?.()) ?? []
        const ws = allWs.find((w: any) => Number(w.id) === Number(workspaceId))
        return {
          effectiveLimitSec,
          configuredLimitSec,
          videoVisualAnalysisEnabled: effectiveConfig.capabilities.videoVisualAnalysisEnabled,
          workspaceName: ws?.name,
          paramsHash,
          perceptionParams: {
            language:
              ConfigOrchestrator.getInstance().getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN',
            enableImageOcr: effectiveConfig.effectiveParams.enableImageOcr,
            ocrModelSize: effectiveConfig.effectiveParams.ocrModelSize,
            maxDocumentOcrItems: effectiveConfig.effectiveParams.maxDocumentOcrItems,
            extractPages: effectiveConfig.effectiveParams.extractPages,
            maxContentSizeKb: effectiveConfig.effectiveParams.maxContentSizeKb,
            enableOfficeCover: effectiveConfig.effectiveParams.enableOfficeCover,
            enableVideoVisualAnalysis: effectiveConfig.capabilities.videoVisualAnalysisEnabled,
            enableNsfwPerception: effectiveConfig.capabilities.nsfwEffectivelyEnabled,
            enableFacePerception: effectiveConfig.capabilities.faceEffectivelyEnabled,
            videoFrameQuotaMax,
            videoCutSensitivity,
            videoSoftTokenBudget
          }
        }
      },
      getWorkspaceIdsWithPendingVideoSegments: () =>
        databaseService.getWorkspaceIdsWithPendingVideoSegments(),
      getPendingVideoSegmentsForWorkspace: (wsId, maxStartPtsSec) =>
        databaseService.getPendingVideoSegmentsForWorkspace(wsId, maxStartPtsSec),
      getWorkspacePendingBackfillVideos: (wsId, effectiveLimitSec) =>
        databaseService.getWorkspacePendingBackfillVideos(wsId, effectiveLimitSec),
      resetFailedVideoSegmentsForWorkspace: (wsId, effectiveLimitSec) =>
        databaseService.resetFailedVideoSegmentsForWorkspace(wsId, effectiveLimitSec),
      resetUpgradedVideoSegmentsForWorkspace: (
        wsId,
        effectiveLimitSec,
        expectedHash,
        isReusableFn
      ) =>
        databaseService.resetUpgradedVideoSegmentsForWorkspace(
          wsId,
          effectiveLimitSec,
          expectedHash,
          isReusableFn
        ),
      getVideoSegments: fileId => databaseService.getVideoSegments(fileId),
      executorDeps: {
        get db() {
          return databaseService.db
        },
        databaseService,
        anydocService,
        omniClient,
        queueFtsSync,
        get language() {
          return ConfigOrchestrator.getInstance().getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN'
        },
        resolveActiveEncoderId: (hint?: number) => {
          try {
            const { resolveActiveVisualEncoderAndResource } = require('./visual-tagger-coordinator')
            const cfg = ConfigOrchestrator.getInstance()
            const { profile } = resolveTargetProfileAndDim()
            return resolveActiveVisualEncoderAndResource({
              embeddingProfile: profile,
              language: cfg.getValue<string>('DEFAULT_LANGUAGE'),
              encoderIdHint: hint
            }).encoderId
          } catch {
            return hint ?? 2
          }
        },
        onReconcile409: async (encoderId: number) => {
          try {
            const {
              visualTaggerCoordinator,
              resolveActiveVisualEncoderAndResource
            } = require('./visual-tagger-coordinator')
            const { modularResourceService } = require('../system/modular-resource-service')
            const { BUILTIN_PLUGIN_CATALOG_META } = require('@firefly/shared')
            const cfg = ConfigOrchestrator.getInstance()
            const { profile } = resolveTargetProfileAndDim()
            const { resourceId } = resolveActiveVisualEncoderAndResource({
              embeddingProfile: profile,
              language: cfg.getValue<string>('DEFAULT_LANGUAGE'),
              encoderIdHint: encoderId
            })
            const catalogMeta = BUILTIN_PLUGIN_CATALOG_META[resourceId]
            const expectedFingerprint =
              catalogMeta?.visualVocabMeta?.matrixSha256 ||
              catalogMeta?.expectedSha256 ||
              resourceId
            const res = await visualTaggerCoordinator.handleEngineNotReady409({
              resourceId,
              expectedFingerprint,
              localVerifyAndHealFn: async () =>
                modularResourceService.reconcileVisualVocabResource(resourceId, {
                  skipDownload: true
                }),
              downloadAndReconcileFn: async () =>
                modularResourceService.reconcileVisualVocabResource(resourceId, {
                  skipDownload: false,
                  forceDownload: true
                })
            })
            if (res.outcome === 'recovered') {
              let appVersion: string | null = null
              try {
                appVersion = require('electron')?.app?.getVersion?.() || null
              } catch {
                appVersion = null
              }
              const obs = databaseService.observeTaggerHealthyOrFingerprintChangedTx(
                encoderId,
                expectedFingerprint,
                appVersion
              )
              visualTaggerCoordinator.resetBreakerForGeneration(obs.currentGeneration)
              visualTaggerCoordinator.notifyRecoveryWake(encoderId, obs.currentGeneration, {
                includeNeedsAppUpdate: Boolean(
                  obs.appVersionChanged || obs.previousGeneration === 0
                )
              })
              setTimeout(() => {
                this.videoSegmentBackfillWorker.scheduleStart('visual_409_recovered')
              }, 0)
              return
            }
            if (res.outcome === 'pending_reconcile') {
              const nextAt = visualTaggerCoordinator.getNextVisualReconcileRetryAt()
              const waitMs = Math.max(1000, (nextAt ?? Date.now() + 60_000) - Date.now())
              setTimeout(
                () => {
                  this.wakeVisualBreakerWaiter()
                  this.videoSegmentBackfillWorker.scheduleStart('visual_409_cooldown_elapsed')
                },
                Math.min(waitMs, 30 * 60_000)
              )
              return
            }
            // 终态阻断（如 needs_plugin_update）：使用非阻塞立标暂停以免在 runLoop 内自等待 activeLoopPromise 死锁
            this.videoSegmentBackfillWorker.requestPauseByVisualBreakerNonBlocking()
          } catch (err) {
            logger.warn(LogCategory.ANALYSIS_QUEUE, '[视频补全] 409 对账联动异常:', err)
          }
        }
      }
    })
    this.orphanWatchdog = new OrphanWatchdog(
      itemId =>
        this.current?.id === itemId ||
        this.orchestratorWorker.isItemActive(itemId) ||
        this.workerBridge.getInflightQueueIds().includes(itemId),
      reclaimedIds => {
        // 同步 queueManager 内存态，避免前端快照残留 analyzing 状态
        const idSet = new Set(reclaimedIds)
        const now = Date.now()
        for (const item of this.queueManager?.getQueue() ?? []) {
          if (idSet.has(item.id) && item.status === 'analyzing') {
            item.status = 'failed'
            item.error = 'orphaned_reclaimed'
            item.updatedAt = now
          }
        }
        this.writeDispatcher.emitUpdate()
      }
    )

    this.directoryProcessor = new DirectoryProcessor(
      () => ({
        unitRecognitionService: this.unitRecognitionService,
        directoryContextService: this.directoryContextService,
        errorRecoveryConfig: this.errorRecoveryConfig,
        ignoreRules: this.ignoreRules
      }),
      (itemId, status, progress, error) =>
        this.writeDispatcher.updateItemStatus(itemId, status, progress, error),
      () => this.pause(),
      async (inputs, forceReanalyze) => {
        await this.addItems(inputs, forceReanalyze)
      },
      adapters => this.reinitFromAdapters(adapters),
      dirPath => this.queueManager?.markDirectoryCompleted(dirPath)
    )

    this.fileProcessor = new FileProcessor(
      () => ({
        fileProcessor: this.fileProcessorService,
        dimensionAnalyzer: this.dimensionAnalyzer,
        errorRecoveryConfig: this.errorRecoveryConfig
      }),
      (itemId, status, progress, error, extra) =>
        this.writeDispatcher.updateItemStatus(itemId, status, progress, error, extra),
      () => this.pause(),
      timer => this.statsCollector.collectAnalysisStats(timer),
      (modelId, mode) => this.statsCollector.getModelName(modelId, mode),
      (directoryPath, force?, cacheOnly?) =>
        this.directoryProcessor.analyzeDirectoryContext(directoryPath, force, cacheOnly)
    )

    this.orchestratorWorker = new AnalysisOrchestratorWorker(
      () => this.queueManager,
      this.aiServiceManager,
      this.directoryProcessor,
      this.fileProcessor,
      (itemId, status, progress, error, extra) =>
        this.writeDispatcher.updateItemStatus(itemId, status, progress, error, extra)
    )

    visualTaggerCoordinator.onBreakerTripped(() => {
      void this.videoSegmentBackfillWorker.pauseByVisualBreaker()
      this.writeDispatcher.notifyFrontend(
        'warning',
        t('AI 标签不可用'),
        true,
        'visual-tagger-unavailable'
      )
      this.writeDispatcher.emitUpdate()
    })

    visualTaggerCoordinator.onRecoveryWake(({ encoderId, generation, includeNeedsAppUpdate }) => {
      this.applyVisualTaggerGenerationRecovery(encoderId, generation, { includeNeedsAppUpdate })
    })

    loggingService.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 服务实例已创建')
  }

  private visualBreakerWaitResolve: (() => void) | null = null

  public wakeVisualBreakerWaiter(): void {
    if (this.visualBreakerWaitResolve) {
      const resolve = this.visualBreakerWaitResolve
      this.visualBreakerWaitResolve = null
      resolve()
    }
  }

  /**
   * 视觉槽恢复（generation 递增）后执行解封、限速重投、恢复视频补全并唤醒挂起主循环
   */
  public applyVisualTaggerGenerationRecovery(
    encoderId: number,
    generation: number,
    opts?: { includeNeedsAppUpdate?: boolean; limit?: number }
  ): { requeuedQueueCount: number; requeuedSegmentCount: number } {
    visualTaggerCoordinator.resetBreakerForGeneration(generation)
    const requeued = databaseService.requeueEligibleFailedItemsTx({
      activeEncoderId: encoderId,
      currentGeneration: generation,
      limit: opts?.limit ?? 50,
      includeNeedsAppUpdate: opts?.includeNeedsAppUpdate
    })
    if (requeued.requeuedQueueCount > 0 && this.queueManager) {
      // 确保 DB 重投状态先刷入内存队列快照后再恢复后台补全与唤醒主循环，防读取陈旧 pendingItems
      void Promise.resolve(this.queueManager.loadFromDB()).finally(() => {
        this.videoSegmentBackfillWorker.resumeFromVisualBreaker()
        this.wakeVisualBreakerWaiter()
        this.writeDispatcher.emitUpdate()
      })
      return requeued
    }
    this.videoSegmentBackfillWorker.resumeFromVisualBreaker()
    this.wakeVisualBreakerWaiter()
    this.writeDispatcher.emitUpdate()
    return requeued
  }

  /**
   * 视觉打标可观测状态（只读）：E2E 探针与单测共用同一取值面。
   * 每个字段都来自既有 API / SQL，严禁新建平行状态（Ticket 11 §3）。
   */
  public getVisualTaggerProbeState(): {
    breaker: {
      tripped: boolean
      generation: number
      consecutiveAssetFailures: number
      trippedEncoderId: number | null
      threshold: number
    }
    queue: { pendingAnalysisCount: number; analyzingCount: number; totalRetryCount: number }
    reconcile: { nextRetryAt: number | null }
    lastFailure: { code: string; encoderId: number | null; generation: number | null } | null
  } {
    const snapshot = visualTaggerCoordinator.getBreakerSnapshot()
    const breaker = {
      tripped: snapshot.tripped,
      generation: snapshot.generation,
      consecutiveAssetFailures: snapshot.consecutiveAssetFailures,
      trippedEncoderId: snapshot.trippedEncoderId ?? null,
      threshold: snapshot.threshold
    }

    let queue = { pendingAnalysisCount: 0, analyzingCount: 0, totalRetryCount: 0 }
    let lastFailure: { code: string; encoderId: number | null; generation: number | null } | null =
      null

    const db = databaseService.db
    if (db) {
      try {
        const aggregate = db
          .prepare(
            `SELECT
               SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pendingCount,
               SUM(CASE WHEN status = 'analyzing' THEN 1 ELSE 0 END) AS analyzingCount,
               COALESCE(SUM(retry_count), 0) AS totalRetryCount
             FROM analysis_queue`
          )
          .get() as {
          pendingCount: number | null
          analyzingCount: number | null
          totalRetryCount: number | null
        }
        queue = {
          pendingAnalysisCount: aggregate?.pendingCount ?? 0,
          analyzingCount: aggregate?.analyzingCount ?? 0,
          totalRetryCount: aggregate?.totalRetryCount ?? 0
        }

        const failure = db
          .prepare(
            `SELECT failure_code AS code,
                    failure_encoder_id AS encoderId,
                    failure_generation AS generation
             FROM analysis_queue
             WHERE failure_code IS NOT NULL
             ORDER BY updated_at DESC
             LIMIT 1`
          )
          .get() as
          | { code: string; encoderId: number | null; generation: number | null }
          | undefined
        lastFailure = failure ?? null
      } catch (error) {
        // 探针不得静默降级：失败必须显式上报，字段回落零值由调用方判定
        logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] 视觉探针读取队列快照失败:', error)
      }
    }

    return {
      breaker,
      queue,
      reconcile: { nextRetryAt: visualTaggerCoordinator.getNextVisualReconcileRetryAt() },
      lastFailure
    }
  }

  /**
   * 注册 `visual-tagger` 探针作用域（仅 FF_E2E_MODE=1 生效）。
   * 注册点收敛在服务自身，因为探针字段只由本服务持有；IPC 层仅透传。
   */
  private registerVisualTaggerProbe(): void {
    if (!getE2EConfig().isE2EMode) return
    ProbeBridgeService.registerScopeHandler('visual-tagger', async () =>
      this.getVisualTaggerProbeState()
    )
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return
    // 并发入口共享同一个在途 Promise；失败清理只由发起者负责，避免并发重跑与监听泄漏
    if (this.initializePromise) return this.initializePromise

    const initPromise = (async () => {
      logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 开始初始化服务...')

      this.errorRecoveryConfig.maxRetries =
        ConfigOrchestrator.getInstance().getValue<number>('ERROR_MAX_RETRIES') ?? 0
      this.errorRecoveryConfig.retryDelay =
        ConfigOrchestrator.getInstance().getValue<number>('ERROR_RETRY_DELAY') ?? 1000
      this.errorRecoveryConfig.fileProcessingTimeout =
        ConfigOrchestrator.getInstance().getValue<number>('FILE_ANALYSIS_TOTAL_TIMEOUT') ?? 120000
      this.errorRecoveryConfig.aiRequestTimeout =
        ConfigOrchestrator.getInstance().getValue<number>('AI_REQUEST_TIMEOUT') ?? 60000
      this.errorRecoveryConfig.unitRecognitionTimeout = 10000

      this.errorRecoveryConfig.enableFallbackProcessing = false
      this.errorRecoveryConfig.fallbackToBasicAnalysis = false

      let adapters
      try {
        adapters = await createCoreEngineAdapters()
      } catch (error) {
        logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 适配器创建失败:', error)
        adapters = null
      }

      if (adapters) {
        this.reinitFromAdapters(adapters)
      }
      // 适配器创建失败时，dimensionAnalyzer / fileProcessorService 会保持为空，
      // 导致后续所有文件在 GPU 阶段以「AI 服务未就绪」失败且**永不重试**
      // （initialize() 被 isInitialized 短路，须重启应用才能恢复）。
      // 因此失败时不标记已初始化，允许 ensureInitialized() 在后续入口重入重试。
      const adaptersReady = adapters !== null

      const db = databaseService.db
      if (db && adapters) {
        try {
          this.aiService = LlamaIndexAIService.getInstance()!
          this.directoryContextService = new DirectoryContextService(this.aiService)
        } catch (error) {
          logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 上下文服务初始化失败:', error)
        }
      }

      try {
        this.ignoreRules = loadIgnoreRules()
      } catch (error) {
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          '[分析队列] 加载忽略规则失败，降级为空规则集:',
          error
        )
        this.ignoreRules = []
      }

      this.queueManager = new QueueManager(this.ignoreRules, {
        onUpdate: () => this.writeDispatcher.emitUpdate()
      })

      await this.queueManager.loadFromDB()
      await this.queueManager.validateQueueConsistency()
      // 启动时清理残留的 processing 状态，保护崩溃后任务安全恢复 (ISS-25 / ISS-37)
      if (db) {
        try {
          databaseService.resetDanglingVideoSegmentsOnStartup()
        } catch (error) {
          logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] 启动重置视频切片状态失败:', error)
        }
      }

      // 仅当适配器就绪时才视为完成初始化；否则保留未初始化态，
      // 让后续 ensureInitialized() 能重新走一遍装配（引擎后续拉起时即可恢复）。
      this.isInitialized = adaptersReady
      if (adaptersReady) {
        logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 服务初始化完成')
        this.installCanonicalMaintenance()
        // 视觉打标探针（仅 E2E 模式注册；Ticket 11 §3）
        this.registerVisualTaggerProbe()
      } else {
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          '[分析队列] 适配器未就绪，跳过标记初始化完成（后续入口将重试装配）'
        )
      }
    })()
    this.initializePromise = initPromise

    try {
      await initPromise
    } finally {
      // 未成功初始化（适配器未就绪或装配抛错）时清空，允许后续入口重新装配
      if (!this.isInitialized && this.initializePromise === initPromise) {
        this.initializePromise = undefined
      }
    }
  }

  /**
   * 工单 06：注册档位/维度变更监听，并启动一次「启动后有界回填」。
   *
   * - 监听只复用 `ConfigOrchestrator.onValueChange`（与 omni-service 热重启并列），不造第二套；
   * - 启动后回填只扫 `NULL/pending/failed`，队列忙碌即暂停，可断点续跑；
   * - 全部失败只 warn，绝不阻断分析队列初始化。
   */
  private installCanonicalMaintenance(): void {
    try {
      this.canonicalMaintenanceUnsubscribe = installCanonicalMaintenanceListener(
        canonicalMaintenanceService
      )
    } catch (err: any) {
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        `[CanonicalMaintenance] 监听注册失败（不影响分析队列）: ${err?.message ?? err}`
      )
    }
    // 启动后回填：先探空 ready 行（向量被删除但 state 未失效的场景），再有界回填
    void (async () => {
      try {
        await canonicalMaintenanceService.probeReadyRowsForMissingVectors()
        const solidified = await canonicalMaintenanceService.runBackfill()
        if (solidified > 0) {
          logger.info(
            LogCategory.ANALYSIS_QUEUE,
            `[CanonicalMaintenance] 启动后有界回填完成：固化 ${solidified} 个 canonical 向量`
          )
        }
      } catch (err: any) {
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          `[CanonicalMaintenance] 启动后回填异常（不影响分析队列）: ${err?.message ?? err}`
        )
      }
    })()
  }

  private reinitFromAdapters(adapters: any): void {
    this.qualityScoringService = new QualityScoringService(
      adapters.logger,
      adapters.llamaRuntime,
      adapters.database,
      adapters.config,
      {
        getQualityScorePrompt: () =>
          ConfigOrchestrator.getInstance().getValue<string>('QUALITY_SCORE_PROMPT'),
        defaultScore: 3,
        defaultConfidence: 0.6
      },
      adapters.modelCapability,
      adapters.aiHelper
    )
    this.dimensionAnalyzer = new DimensionAnalyzer(
      adapters.logger,
      adapters.llamaRuntime,
      adapters.database,
      adapters.config,
      adapters.modelCapability,
      adapters.aiHelper
    )
    this.unitRecognitionService = new UnitRecognitionService(adapters.fileSystem, adapters.logger)
    this.fileProcessorService = new FileProcessorService(
      adapters.logger,
      adapters.config,
      adapters.fileSystem,
      this.qualityScoringService,
      this.errorRecoveryConfig
    )
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.isInitialized) {
      await this.initialize()
    }
  }

  clearDirectoryContextCache(directoryPath?: string): void {
    this.directoryProcessor.clearDirectoryContextCache(directoryPath)
  }

  reloadIgnoreRules(): void {
    try {
      this.ignoreRules = loadIgnoreRules()
      if (this.queueManager) {
        this.queueManager.setIgnoreRules(this.ignoreRules)
      }
    } catch (error) {
      logger.warn(LogCategory.MAIN, '[AnalysisQueue] 重新加载忽略规则失败:', error)
    }
  }

  async reloadDatabase(): Promise<void> {
    if (!this.isInitialized) return
    const db = databaseService.db
    if (!db) return

    if (!this.aiService) {
      this.aiService = LlamaIndexAIService.getInstance()!
    }

    try {
      // 创世 Baseline V1 起，维度/标签体系已统一由 file_tags 树承载，
      // 不再存在 FileDimensionService 与 file_dimensions 表的运行时初始化流程。
      this.directoryContextService = new DirectoryContextService(this.aiService)
    } catch (error) {
      logger.error(LogCategory.MAIN, '[AnalysisQueue] 重新加载数据库相关的维度服务失败:', error)
    }
  }

  private async ensureWorkspaceConfigReadyOrBrake(
    workspaceId: number,
    inLoop: boolean
  ): Promise<boolean> {
    let isReady = await databaseService.isWorkspaceConfigReady(workspaceId)
    if (!isReady) {
      await databaseService.ensureWorkspaceConfigReady(workspaceId)
      isReady = await databaseService.isWorkspaceConfigReady(workspaceId)
    }
    if (!isReady) {
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        inLoop
          ? `[分析队列动态刹车] 工作区 ${workspaceId} 尚未就绪 (status: pending)，挂起调度并弹出运行栈`
          : `[分析队列动态刹车] 启动工作区 ${workspaceId} 尚未就绪 (status: pending)，立即拦截并通知`
      )
      if (inLoop) {
        this.runningWorkspaceStack.pop()
        this.writeDispatcher.emitUpdate()
      }
      this.writeDispatcher.notifyLatchBrake(workspaceId)
      return false
    }
    return true
  }

  async start(workspaceId?: number): Promise<void> {
    if (workspaceId) {
      if (!(await this.ensureWorkspaceConfigReadyOrBrake(workspaceId, false))) return
      // 步骤 1：指定了工作空间，先置顶运行栈
      this.runningWorkspaceStack = this.runningWorkspaceStack.filter(id => id !== workspaceId)
      this.runningWorkspaceStack.push(workspaceId)
      // 步骤 2（必须在 isProcessingLoopActive 早退之前）：跨工作区预热抢占立即中止当前等待
      if (this.warmingUpWorkspaceId !== null && this.warmingUpWorkspaceId !== workspaceId) {
        this.triggerAbort('preempt')
      }
    } else {
      // 未指定工作空间：将所有活跃工作空间推入处理栈（确保不重复）
      const allWorkspaces = await databaseService.getAllWorkspaceDirectories()
      for (const ws of allWorkspaces) {
        if (ws.id && !this.runningWorkspaceStack.includes(ws.id)) {
          this.runningWorkspaceStack.push(ws.id)
        }
      }
    }

    this.running = true
    this.syncHibernationState(true)
    // 启动/预热独立 Stage 2 worker_threads 编排线程（幂等）
    this.workerBridge.start()

    // 步骤 3：若主循环已在跑则直接刷新状态并返回（抢占信号已在步骤 2 送达）
    if (this.isProcessingLoopActive) {
      this.writeDispatcher.emitUpdate()
      return
    }

    this.isProcessingLoopActive = true
    let loopAbortGen = this.abortGeneration

    systemHealthService.updateMonitoringInterval(30000)
    cloudSyncWorker.updateInterval(30000)
    this.orphanWatchdog.start()

    this.writeDispatcher.emitUpdate()

    while (this.running && this.runningWorkspaceStack.length > 0) {
      const localController = new AbortController()
      this.currentAbortController = localController
      let windowAsrLease: { release: () => void } | null = null

      try {
        const activeWorkspaceId = this.runningWorkspaceStack[this.runningWorkspaceStack.length - 1]

        // TASK-01 动态刹车：若当前工作区尚未确认配置 (pending)，尝试自适应就绪默认配置
        if (
          activeWorkspaceId != null &&
          !(await this.ensureWorkspaceConfigReadyOrBrake(activeWorkspaceId, true))
        ) {
          continue
        }

        const config = ConfigOrchestrator.getInstance()
        const aiServiceMode = config.getValue<string>('AI_SERVICE_MODE') ?? 'local'
        // PRD-0049：当前引擎唯一真相 = 萤核AI引擎桥接快照 backend
        const backendSnap = this.omniAdapter.getBackendSnapshot()
        const currentEngineAcc = backendSnap.backend

        // 仅在明确处于 CPU 引擎模式时串行；非 CPU 引擎均启用并行
        const isCpuEngine =
          aiServiceMode === 'cpu' || (aiServiceMode === 'local' && isCpuBackend(currentEngineAcc))

        // 统一按当前活跃工作区解析有效分析模式（SLICE-04 旁路收口；仅信 hasInstalledEngines，移除 backend/model 启发式防止冷启 stopped 被误降 simple）
        const hasInstalledAiEngine =
          aiServiceMode === 'local' ? this.omniAdapter.hasInstalledEngines() : true
        const effectiveConfig = await resolveWorkspaceEffectiveConfig(
          activeWorkspaceId ?? null,
          hasInstalledAiEngine
        )
        const analysisMode = effectiveConfig.effectiveParams.analysisMode

        const decisionSnapshot = this.queueManager.getSnapshot(undefined, activeWorkspaceId)
        const pendingItems = decisionSnapshot.items.filter(i => i.status === 'pending')

        if (pendingItems.length === 0) {
          if ((await this.advanceOrStopWorkspaceQueue(activeWorkspaceId)) === 'continue') {
            continue
          }
          break
        }

        const breakerTripped = visualTaggerCoordinator.isVisualBreakerTripped()
        const next409RetryAt = visualTaggerCoordinator.getNextVisualReconcileRetryAt()
        const in409Cooldown = next409RetryAt !== null && next409RetryAt > Date.now()
        const dispatchablePendingItems =
          breakerTripped || in409Cooldown
            ? pendingItems.filter(i => !isVisualMediaExtensionOrPath(i.path, (i as any).fileType))
            : pendingItems

        if (dispatchablePendingItems.length === 0) {
          // 所有 pending 均为被视觉熔断或 409 退避冷却暂停的视觉文件：挂起休眠直到恢复/冷却到期/取消/新非视觉入队
          await new Promise<void>(resolve => {
            let cooldownTimer: ReturnType<typeof setTimeout> | null = null
            const cleanupAndResolve = () => {
              if (cooldownTimer) {
                clearTimeout(cooldownTimer)
                cooldownTimer = null
              }
              resolve()
            }
            this.visualBreakerWaitResolve = cleanupAndResolve
            const onAbort = () => {
              this.wakeVisualBreakerWaiter()
            }
            if (localController.signal.aborted) {
              this.wakeVisualBreakerWaiter()
              return
            }
            localController.signal.addEventListener('abort', onAbort, { once: true })
            if (!breakerTripped && in409Cooldown && next409RetryAt !== null) {
              const waitMs = Math.max(500, next409RetryAt - Date.now())
              cooldownTimer = setTimeout(() => {
                this.wakeVisualBreakerWaiter()
              }, waitMs)
            }
          })
          continue
        }

        // 256 切片规划 + 同源 K<=64 执行窗口（Spec §2.1 / §3.1）
        if (activeWorkspaceId != null) {
          await this.batchPlanSession.planChunkForWindow(
            databaseService.db,
            activeWorkspaceId,
            dispatchablePendingItems,
            effectiveConfig
          )
        }
        const windowItems = this.batchPlanSession.takeWindow(dispatchablePendingItems)
        const isParallel = !isCpuEngine && isAiStageEnabled(analysisMode)

        // 基于同一 windowItems 推导本窗口精准预热计划
        const warmupPlan = deriveWindowWarmupPlan(
          windowItems,
          this.batchPlanSession.decisions,
          effectiveConfig,
          { aiServiceMode, isCpuEngine, isParallelDispatch: isParallel }
        )

        // OD-2 正交兼容：local 并行模式下不阻塞 Stage 1/2 栅栏，后台与冷启/CPU 预热并发推进
        if (isParallel && aiServiceMode === 'local') {
          this.aiServiceManager.preheatLocalEngineNonBlocking(analysisMode)
        }

        // 批前统一预热栅栏（300ms 延迟切换 warming_up；非 Abort 失败一律 Fail-Open）
        this.warmingUpWorkspaceId = activeWorkspaceId ?? null
        const barrierResult = await this.warmupBarrier.run(
          warmupPlan,
          localController.signal,
          {
            warmupOmniEngine: async (plan, sig) =>
              omniClient.warmupEngine(
                {
                  textAndLexicon: plan.textAndLexicon,
                  visionTower: plan.visionTower,
                  nsfwDetector: plan.nsfwDetector,
                  imageOcr: plan.imageOcr,
                  ocrModelSize: plan.ocrModelSize
                },
                { signal: sig }
              ),
            warmupAsrModule: async sig => {
              if (sig.aborted) {
                throw Object.assign(new Error('Aborted'), { name: 'AbortError' })
              }
              try {
                await moduleHibernationCoordinator.withHibernationGate(
                  { targetId: 'asr-sensevoice-onnx', clusterId: 'analysis_suite' },
                  async () => true
                )
                return true
              } catch (asrErr: any) {
                if (isWarmupAbortError(asrErr, sig)) throw asrErr
                logger.warn(
                  LogCategory.ANALYSIS_QUEUE,
                  '[WarmupBarrier] ASR 按需预加载异常（Fail-Open 放行）:',
                  asrErr
                )
                return false
              }
            },
            acquireAsrLease: () => moduleHibernationCoordinator.acquireAsrActiveLease(),
            acquireStage3Capability: async (mode, sig) => {
              const lease = await this.aiServiceManager.acquireStage3Capability(mode, sig, {
                silentToast: true
              })
              return lease.granted
            },
            getCurrentEmbeddingProfile: () => resolveTargetProfileAndDim().profile
          },
          (phase, hintCode) => {
            this.lifecyclePhase = phase
            this.warmupHintCode = hintCode
            this.writeDispatcher.emitUpdate()
          }
        )
        windowAsrLease = barrierResult.asrLease
        this.warmingUpWorkspaceId = null
        this.lifecyclePhase = 'analyzing'
        this.warmupHintCode = undefined
        this.writeDispatcher.emitUpdate()

        if (isParallel) {
          await this.orchestratorWorker.runParallel(
            windowItems,
            localController.signal,
            this.stage2WaitTimeoutMs,
            this.batchPlanSession.decisions
          )
          this.aiServiceManager.flushDegradeLogSummary()
        } else {
          // SERIAL LOOP（同样仅派发与 warmupPlan 同源的 windowItems[0]）
          const next = pickNextPending(windowItems)
          if (!next) {
            if ((await this.advanceOrStopWorkspaceQueue(activeWorkspaceId)) === 'continue') {
              continue
            }
            break
          }

          this.current = next
          await this.orchestratorWorker.runSerialItem(
            next,
            localController.signal,
            isAiStageEnabled(),
            this.omniAdapter,
            (msg, err) => logger.warn(LogCategory.ANALYSIS_QUEUE, msg, err)
          )
        }

        this.backoffMs = 50

        const updatedSnapshot = this.queueManager.getSnapshot(undefined, activeWorkspaceId)
        if (updatedSnapshot.items.filter(item => item.status === 'pending').length === 0) {
          await updateVirtualDirectoriesAfterQueueCompletion()
        }
      } catch (error) {
        const isCurrentCycleAborted =
          localController.signal.aborted && loopAbortGen !== this.abortGeneration
        if (isCurrentCycleAborted) {
          const signalReason = (localController.signal as { reason?: unknown }).reason
          const reason = typeof signalReason === 'string' ? signalReason : this.currentAbortReason
          loopAbortGen = this.abortGeneration
          this.currentAbortReason = null
          if (reason === 'preempt') {
            this.backoffMs = 50
            continue
          }
          if (reason === 'pause') {
            if (!this.running || this.runningWorkspaceStack.length === 0) {
              break
            }
            continue
          }
          if (reason === 'drain') {
            this.backoffMs = 50
            continue
          }
        }
        if (isWarmupAbortError(error, localController.signal)) {
          continue
        }
        const waitMs = this.backoffMs
        this.backoffMs = Math.min(2000, this.backoffMs * 2)
        logger.error(
          LogCategory.ANALYSIS_QUEUE,
          `[分析队列] 调度主循环异常，${waitMs}ms 后重试:`,
          error
        )
        await new Promise(resolve => setTimeout(resolve, waitMs))
      } finally {
        windowAsrLease?.release()
        windowAsrLease = null
        this.warmingUpWorkspaceId = null
        if (this.currentAbortController === localController) {
          this.currentAbortController = null
        }
        this.current = undefined
        if (!this.running || this.runningWorkspaceStack.length === 0) {
          this.lifecyclePhase = 'idle'
          this.warmupHintCode = undefined
        }
        this.writeDispatcher.emitUpdate()
      }
    }
    this.isProcessingLoopActive = false
    this.lifecyclePhase = 'idle'
    this.warmupHintCode = undefined
    if (!this.videoSegmentBackfillWorker.getSnapshot().running) {
      this.syncHibernationState(false)
    }
    this.orphanWatchdog.stop()
    this.aiServiceManager.flushDegradeLogSummary()
    flushFtsSync()
    this.writeDispatcher.emitUpdate()
  }

  private async advanceOrStopWorkspaceQueue(
    activeWorkspaceId: number
  ): Promise<'continue' | 'break'> {
    logger.info(
      LogCategory.ANALYSIS_QUEUE,
      `[分析队列] 工作空间 ${activeWorkspaceId} 的队列已分析完毕，从运行栈中弹出`
    )
    this.runningWorkspaceStack.pop()

    if (this.runningWorkspaceStack.length > 0) {
      const nextWsId = this.runningWorkspaceStack[this.runningWorkspaceStack.length - 1]
      logger.info(
        LogCategory.ANALYSIS_QUEUE,
        `[分析队列] 自动恢复运行栈顶工作空间 ${nextWsId} 的分析队列`
      )
      this.writeDispatcher.emitUpdate()
      return 'continue'
    }

    this.running = false
    this.current = undefined
    this.isProcessingLoopActive = false
    systemHealthService.updateMonitoringInterval(300000)
    cloudSyncWorker.updateInterval(300000)
    await updateVirtualDirectoriesAfterQueueCompletion()
    // Spec §2.3：仅在全部工作区自然排空时唤醒独立单切片视频后台回填器
    this.videoSegmentBackfillWorker.scheduleStart('queue_drained')
    this.writeDispatcher.emitUpdate()
    return 'break'
  }

  /**
   * 同步分析队列活跃状态至休眠协调器
   * 彻底杜绝分析队列正在运行而 UI 却显示已休眠的状态撒谎
   */
  private syncHibernationState(active: boolean): void {
    try {
      if (active) {
        moduleHibernationCoordinator.notifyModuleResident('firefly-ai-engine')
        moduleHibernationCoordinator.cancelIdleHibernation('analysis_suite')
      } else {
        moduleHibernationCoordinator.scheduleIdleHibernation('analysis_suite')
      }
    } catch (error) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] 同步休眠协调器状态失败:', error)
    }
  }

  async pause(workspaceId?: number): Promise<void> {
    let targetWsId = workspaceId
    if (!targetWsId) {
      const currentWs = await databaseService.getCurrentWorkspaceDirectory()
      if (currentWs?.id) {
        targetWsId = currentWs.id
      }
    }

    if (targetWsId) {
      this.runningWorkspaceStack = this.runningWorkspaceStack.filter(id => id !== targetWsId)
    } else {
      this.runningWorkspaceStack = []
    }

    // 中止当前正在执行的任务。
    //
    // 注意：这里只按「是否指定了 workspaceId」判断，而不再要求
    // `this.current.workspaceId === targetWsId`。原因：targetWsId 取自
    // 「当前打开的工作目录」，而 this.current 可能是运行栈中另一个工作空间的
    // 任务。若二者不一致，旧逻辑会跳过 abort，但下方仍把 running 置为 false，
    // 导致「界面显示已暂停，任务却在后台继续跑」。
    const shouldAbortCurrent =
      (this.current && (!workspaceId || this.current.workspaceId === workspaceId)) ||
      this.orchestratorWorker.hasActiveItems(workspaceId) ||
      (this.warmingUpWorkspaceId !== null &&
        (!workspaceId || this.warmingUpWorkspaceId === workspaceId))
    if (shouldAbortCurrent) {
      this.triggerAbort('pause')
    }

    if (this.runningWorkspaceStack.length === 0) {
      this.running = false
      this.lifecyclePhase = 'idle'
      this.warmupHintCode = undefined
      flushFtsSync()
    }

    // Spec §2.3：用户暂停队列时同步中止在途视频后台补全，绝不误触发补全
    this.videoSegmentBackfillWorker.abortCurrent()
    this.wakeVisualBreakerWaiter()

    this.writeDispatcher.emitUpdate()
  }

  async addItems(inputs: EnqueueInput[], forceReanalyze = false): Promise<EnqueueResult> {
    await this.ensureInitialized()
    const result = await this.queueManager.addItems(inputs, forceReanalyze)
    if (result.addedCount > 0 || result.updatedCount > 0) {
      this.batchPlanSession.clear()
      this.videoSegmentBackfillWorker.requestYield()
      this.wakeVisualBreakerWaiter()
    }
    if (!this.isProcessingLoopActive && this.isInitialized) {
      void this.start()
    }
    return result
  }

  async addItemsResolved(inputs: EnqueueInput[], forceReanalyze = false): Promise<EnqueueResult> {
    await this.ensureInitialized()
    const result = await this.queueManager.addItemsResolved(inputs, forceReanalyze)
    if (result.addedCount > 0 || result.updatedCount > 0) {
      this.batchPlanSession.clear()
      this.videoSegmentBackfillWorker.requestYield()
    }
    if (!this.isProcessingLoopActive && this.isInitialized) {
      void this.start()
    }
    return result
  }

  private collectQueuedFingerprintsByItemId(id: number): string[] {
    const db = databaseService.db
    if (!db) return []
    try {
      const rows = db
        .prepare(
          `SELECT DISTINCT wf.file_fingerprint AS fp
           FROM analysis_queue aq
           JOIN workspace_files wf ON wf.id = aq.item_id
           WHERE aq.id = ? AND aq.item_type = 'file' AND wf.file_fingerprint IS NOT NULL`
        )
        .all(id) as Array<{ fp?: string }>
      return rows.map(r => r.fp).filter((fp): fp is string => Boolean(fp))
    } catch {
      return []
    }
  }

  private collectQueuedFingerprintsByPath(filePath: string): string[] {
    const db = databaseService.db
    if (!db) return []
    try {
      const rows = db
        .prepare(
          `SELECT DISTINCT file_fingerprint AS fp FROM workspace_files WHERE path = ? AND file_fingerprint IS NOT NULL`
        )
        .all(filePath) as Array<{ fp?: string }>
      return rows.map(r => r.fp).filter((fp): fp is string => Boolean(fp))
    } catch {
      return []
    }
  }

  private collectQueuedFingerprintsByDirectory(directoryPath: string): string[] {
    const db = databaseService.db
    if (!db) return []
    try {
      const prefixForward = directoryPath.replace(/[\\/]+$/, '')
      const rows = db
        .prepare(
          `SELECT DISTINCT wf.file_fingerprint AS fp
           FROM analysis_queue aq
           JOIN workspace_files wf ON wf.id = aq.item_id
           WHERE aq.item_type = 'file'
             AND wf.file_fingerprint IS NOT NULL
             AND (wf.path = ? OR wf.path LIKE ? OR wf.path LIKE ?)`
        )
        .all(directoryPath, `${prefixForward}/%`, `${prefixForward}\\%`) as Array<{ fp?: string }>
      return rows.map(r => r.fp).filter((fp): fp is string => Boolean(fp))
    } catch {
      return []
    }
  }

  private bumpRetagEpochsIfIdle(fingerprints: ReadonlyArray<string>): void {
    const db = databaseService.db
    if (!db || fingerprints.length === 0) return
    for (const fp of new Set(fingerprints)) {
      bumpRetagEpochIfNoActiveTask(db, fp)
    }
  }

  async deleteItem(id: number): Promise<void> {
    await this.ensureInitialized()
    const affectedFps = this.collectQueuedFingerprintsByItemId(id)
    const targetItem = this.queueManager.getSnapshot().items.find(i => i.id === id)
    const targetWsId = targetItem?.workspaceId
    this.batchPlanSession.invalidateItem(id)
    const isWarmupHit =
      this.warmingUpWorkspaceId !== null &&
      targetWsId != null &&
      this.warmingUpWorkspaceId === targetWsId
    if (this.current?.id === id || isWarmupHit) {
      this.triggerAbort('drain')
    }
    this.workerBridge.cancelItem(id, false)
    this.queueManager.deleteItem(id)
    this.bumpRetagEpochsIfIdle(affectedFps)
  }

  async deleteItemByPath(filePath: string): Promise<void> {
    await this.ensureInitialized()
    const affectedFps = this.collectQueuedFingerprintsByPath(filePath)
    const matchedItems = this.queueManager
      .getSnapshot()
      .items.filter(i => i.path && isPathEqual(i.path, filePath))
    for (const m of matchedItems) {
      this.batchPlanSession.invalidateItem(m.id)
    }
    const isWarmupHit =
      this.warmingUpWorkspaceId !== null &&
      matchedItems.some(m => m.workspaceId === this.warmingUpWorkspaceId)
    if ((this.current?.path && isPathEqual(this.current.path, filePath)) || isWarmupHit) {
      this.triggerAbort('drain')
    }
    await this.videoSegmentBackfillWorker.abortAndWaitCurrent(filePath)
    this.queueManager.deleteItemByPath(filePath)
    this.bumpRetagEpochsIfIdle(affectedFps)
  }

  async deleteItemsByDirectory(directoryPath: string): Promise<void> {
    await this.ensureInitialized()
    const affectedFps = this.collectQueuedFingerprintsByDirectory(directoryPath)
    const matchedItems = this.queueManager
      .getSnapshot()
      .items.filter(
        i => i.path && (isPathEqual(i.path, directoryPath) || isSubPath(directoryPath, i.path))
      )
    this.batchPlanSession.invalidateItems(matchedItems.map(m => m.id))
    const isWarmupHit =
      this.warmingUpWorkspaceId !== null &&
      matchedItems.some(m => m.workspaceId === this.warmingUpWorkspaceId)
    if (
      (this.current?.path &&
        (isPathEqual(this.current.path, directoryPath) ||
          isSubPath(directoryPath, this.current.path))) ||
      isWarmupHit
    ) {
      this.triggerAbort('drain')
    }
    // Spec §2.3：删除工作目录前中止并等待在途视频补全切片释放文件句柄，防 Windows EBUSY
    await this.videoSegmentBackfillWorker.abortAndWaitCurrent(directoryPath)

    this.queueManager.deleteItemsByDirectory(directoryPath)
    this.bumpRetagEpochsIfIdle(affectedFps)
  }

  /**
   * 中止并移除属于指定工作目录的全部队列任务（含正在处理的当前任务）。
   *
   * 与 `deleteItemsByDirectory` 的区别：后者只摘掉排队中的条目，对「正在处理」的
   * 任务不发声，而这个任务往往正握着 `.VirtualDirectory/.thumbnail` 的写入句柄。
   * 删除工作目录前必须先调用本方法，否则随后的 `fs.rm` 会撞 EBUSY，
   * 或者刚删掉就被在途的缩略图任务重新创建出来。
   */
  async abortAndDeleteItemsByDirectory(directoryPath: string): Promise<void> {
    await this.ensureInitialized()
    const affectedFps = this.collectQueuedFingerprintsByDirectory(directoryPath)

    const belongsToDirectory = (filePath?: string): boolean => {
      if (!filePath) return false
      return isPathEqual(filePath, directoryPath) || isSubPath(directoryPath, filePath)
    }

    const matchedItems = this.queueManager
      .getSnapshot()
      .items.filter(i => belongsToDirectory(i.path))
    this.batchPlanSession.invalidateItems(matchedItems.map(m => m.id))
    const isWarmupHit =
      this.warmingUpWorkspaceId !== null &&
      matchedItems.some(m => m.workspaceId === this.warmingUpWorkspaceId)

    const shouldAbortDirectoryTask =
      (this.current && belongsToDirectory(this.current.path)) ||
      this.orchestratorWorker.hasActiveItemMatching(belongsToDirectory) ||
      isWarmupHit
    if (shouldAbortDirectoryTask) {
      logger.debug(
        LogCategory.ANALYSIS_QUEUE,
        '[分析队列] 删除工作目录前中止在途任务，释放 .VirtualDirectory 句柄:',
        this.current?.path || directoryPath
      )
      this.triggerAbort('drain')
    }

    // Spec §2.3：删除工作目录前中止并等待在途视频补全切片释放文件句柄，防 Windows EBUSY
    await this.videoSegmentBackfillWorker.abortAndWaitCurrent(directoryPath)

    this.queueManager.deleteItemsByDirectory(directoryPath)
    this.bumpRetagEpochsIfIdle(affectedFps)
  }

  async clearPending(): Promise<void> {
    await this.ensureInitialized()
    const db = databaseService.db
    let pendingFps: string[] = []
    if (db) {
      try {
        const rows = db
          .prepare(
            `SELECT DISTINCT wf.file_fingerprint AS fp
             FROM analysis_queue aq
             JOIN workspace_files wf ON wf.id = aq.item_id
             WHERE aq.item_type = 'file'
               AND aq.status = 'pending'
               AND wf.file_fingerprint IS NOT NULL`
          )
          .all() as Array<{ fp?: string }>
        pendingFps = rows.map(r => r.fp).filter((fp): fp is string => Boolean(fp))
      } catch {}
    }
    this.batchPlanSession.clear()
    if (this.currentAbortController || this.warmingUpWorkspaceId !== null) {
      this.triggerAbort('drain')
    }
    this.queueManager.clearPending()
    this.bumpRetagEpochsIfIdle(pendingFps)
    if (!this.running && this.isInitialized) {
      void this.start()
    }
  }

  async cancelUnmatchedTasks(
    workspaceId: number,
    allowedExtensions: string[] | null | undefined,
    directoryPrefix?: string
  ): Promise<{ cancelledCount: number }> {
    await this.ensureInitialized()
    const beforeItems = this.queueManager.getSnapshot(undefined, workspaceId).items
    const result = this.queueManager.cancelUnmatchedTasks(
      workspaceId,
      allowedExtensions,
      directoryPrefix
    )
    if (result.cancelledCount > 0) {
      const afterIds = new Set(
        this.queueManager.getSnapshot(undefined, workspaceId).items.map(i => i.id)
      )
      const removedIds: number[] = []
      const removedFps: string[] = []
      const db = databaseService.db
      for (const item of beforeItems) {
        if (!afterIds.has(item.id)) {
          removedIds.push(item.id)
          if (db && item.path) {
            const fp = databaseService.getFileFingerprintByPath(item.path)
            if (fp) removedFps.push(fp)
          }
        }
      }
      this.batchPlanSession.invalidateItems(removedIds)
      const activeHit =
        (this.current && removedIds.includes(this.current.id)) ||
        this.warmingUpWorkspaceId === workspaceId
      if (activeHit) {
        this.triggerAbort('drain')
      }
      this.bumpRetagEpochsIfIdle(removedFps)
    }
    return result
  }

  async clearAll(): Promise<void> {
    await this.ensureInitialized()
    const db = databaseService.db
    let allFps: string[] = []
    if (db) {
      try {
        const rows = db
          .prepare(
            `SELECT DISTINCT wf.file_fingerprint AS fp
             FROM analysis_queue aq
             JOIN workspace_files wf ON wf.id = aq.item_id
             WHERE aq.item_type = 'file'
               AND wf.file_fingerprint IS NOT NULL`
          )
          .all() as Array<{ fp?: string }>
        allFps = rows.map(r => r.fp).filter((fp): fp is string => Boolean(fp))
      } catch {}
    }
    this.batchPlanSession.clear()
    if (this.currentAbortController || this.warmingUpWorkspaceId !== null) {
      this.triggerAbort('drain')
    }
    this.queueManager.clearAll()
    this.bumpRetagEpochsIfIdle(allFps)
    if (!this.running && this.isInitialized) {
      void this.start()
    }
  }

  async retryFailed(): Promise<void> {
    await this.ensureInitialized()
    this.batchPlanSession.clear()
    this.queueManager.retryFailed()
    if (!this.running && this.isInitialized) {
      void this.start()
    }
  }

  /** Spec §8.3.2 / B7：前端交互优先让路（Worker + 主进程写分发器双端联动暂停） */
  public yieldForUi(timeoutMs = 2000): void {
    this.workerBridge.yieldForUi(timeoutMs)
  }

  /** 恢复双端让路状态 */
  public resumeFromUi(): void {
    this.workerBridge.resumeFromUi()
  }

  /** Spec §10.2 (N-1) / B6：用户主动取消任务，状态落库 failed + error='canceled_by_user' */
  public async cancelItemByUser(id: number): Promise<void> {
    await this.ensureInitialized()
    const affectedFps = this.collectQueuedFingerprintsByItemId(id)
    const targetWsId = this.queueManager.getSnapshot().items.find(i => i.id === id)?.workspaceId
    this.batchPlanSession.invalidateItem(id)
    const isWarmupHit =
      this.warmingUpWorkspaceId !== null &&
      targetWsId != null &&
      this.warmingUpWorkspaceId === targetWsId
    if (this.current?.id === id || isWarmupHit) {
      this.triggerAbort('drain')
    }
    this.workerBridge.cancelItem(id, true)
    this.writeDispatcher.updateItemStatus(id, 'failed', 0, 'canceled_by_user')
    this.bumpRetagEpochsIfIdle(affectedFps)
  }

  /** 获取 Stage 2 独立 Worker 托管桥（供调度与可观测性检查） */
  public getWorkerBridge(): WorkerOrchestratorBridge {
    return this.workerBridge
  }

  /** 获取主进程写微事务执行器（供调度与可观测性检查） */
  public getWriteSetBatchDispatcher(): WriteSetBatchDispatcher {
    return this.writeSetBatchDispatcher
  }

  /** Stage2 S-B：获取 utilityProcess 写进程宿主（供量化验收与可观测性检查） */
  public getDbWriterProcess(): AnalysisDbWriterProcess {
    return this.dbWriterProcess
  }

  /** 将文件任务投递至独立 Stage 2 worker_threads 编排线程（B1 生产入口） */
  public enqueueToWorkerOrchestrator(items: WorkerQueueItem[]): boolean {
    return this.workerBridge.enqueue(items)
  }

  /**
   * 优雅销毁分析队列服务（应用退出前由 main/index.ts 调用，必须在关库前完成）。
   * 闭环停止循环、孤儿 watchdog、Worker 线程，同步冲刷待写微批与 FTS 并解绑配置监听。
   * 注意：退出阶段严禁通过 setImmediate 异步触发后台维护/云同步尾钩子，避免撞上已关闭 DB。
   */
  public async dispose(): Promise<void> {
    this.running = false
    this.runningWorkspaceStack = []
    if (this.currentAbortController) {
      this.currentAbortController.abort()
      this.currentAbortController = null
    }
    this.orphanWatchdog.stop()
    try {
      await this.videoSegmentBackfillWorker.abortAndWaitCurrent()
    } catch (err) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] 退出中止视频后台回填器失败:', err)
    }
    try {
      await this.workerBridge.dispose()
    } catch (err) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] 退出销毁 WorkerBridge 失败:', err)
    }
    try {
      // Stage2 S-B：写进程随主服务退出优雅关停（SHUTDOWN → 冲刷在途写集 → 等待退出）
      await this.dbWriterProcess.dispose()
    } catch (err) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] 退出销毁 DbWriterProcess 失败:', err)
    }
    try {
      this.writeSetBatchDispatcher.resumeFromUi()
      await this.writeSetBatchDispatcher.flush()
    } catch (err) {
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        '[分析队列] 退出冲刷 WriteSetBatchDispatcher 失败:',
        err
      )
    } finally {
      this.writeSetBatchDispatcher.dispose()
    }
    flushFtsSync()
    this.aiServiceManager.dispose()
    if (this.canonicalMaintenanceUnsubscribe) {
      try {
        this.canonicalMaintenanceUnsubscribe()
      } catch (err) {
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          '[分析队列] 取消 canonicalMaintenance 监听失败:',
          err
        )
      }
      this.canonicalMaintenanceUnsubscribe = undefined
    }
  }

  /**
   * 工单 06：canonical 重建计数（供设置页展示，方案 §3.10「禁止静默空召回」）。
   * UI 接入属工单 13，此处只暴露数据出口。
   */
  public getCanonicalRebuildCounts(): ReturnType<
    typeof canonicalMaintenanceService.getRebuildCounts
  > {
    return canonicalMaintenanceService.getRebuildCounts()
  }

  /**
   * 工单 06：手动触发一次 canonical 维护（「重建语义索引」入口，UI 由工单 13 接入）。
   */
  public async runCanonicalMaintenance(reason = 'manual'): Promise<void> {
    await canonicalMaintenanceService.runMaintenance(reason)
  }

  /**
   * 恢复并唤醒存在未完成 k >= 1 切片的长视频后台补全（ISS-60 / ISS-66 / Spec §2.3）：
   * 废弃原 addItems(inputs, true) 整文件回灌主队列，改为纯 Stage 2 独立单切片后台回填，0 次多余 LLM。
   */
  public async requeueIncompleteVideos(): Promise<number> {
    databaseService.resetDanglingVideoSegmentsOnStartup()
    const next = await this.videoSegmentBackfillWorker.pickNextEligibleSegment()
    const count = next?.pendingVideoCount ?? 0
    if (count > 0) {
      this.videoSegmentBackfillWorker.scheduleStart('requeue_api')
    }
    return count
  }

  public startVideoBackfill(reason = 'manual'): boolean {
    return (
      this.videoSegmentBackfillWorker.resumeByUser() ||
      this.videoSegmentBackfillWorker.scheduleStart(reason)
    )
  }

  public async pauseVideoBackfill(): Promise<void> {
    await this.videoSegmentBackfillWorker.pauseByUser()
  }

  public prioritizeVideoBackfill(workspaceId: number, fileFingerprint: string): boolean {
    return this.videoSegmentBackfillWorker.prioritizeFile(workspaceId, fileFingerprint)
  }

  public async retryFailedVideoBackfill(workspaceId: number): Promise<number> {
    return this.videoSegmentBackfillWorker.retryFailedForWorkspace(workspaceId)
  }

  public async listWorkspacePendingBackfillVideos(workspaceId: number) {
    return this.videoSegmentBackfillWorker.listWorkspacePendingVideos(workspaceId)
  }

  public async notifyWorkspaceConfigChangedForBackfill(workspaceId: number): Promise<void> {
    await this.videoSegmentBackfillWorker.onWorkspaceConfigChanged(workspaceId)
  }

  getSnapshot(workspaceId?: number): AnalysisQueueSnapshot {
    if (!this.queueManager) {
      return {
        items: [],
        running: false,
        currentItemId: undefined,
        activeRunningWorkspaceId: undefined,
        runningWorkspaceStack: []
      }
    }
    const activeRunningWorkspaceId =
      this.runningWorkspaceStack.length > 0
        ? this.runningWorkspaceStack[this.runningWorkspaceStack.length - 1]
        : undefined

    const currentAnalyzingItem =
      this.current && this.current.status === 'analyzing' ? { ...this.current } : undefined

    const snapshot = this.queueManager.getSnapshot(this.current?.id, workspaceId)
    const isWorkspaceRunning =
      workspaceId !== undefined && workspaceId !== null
        ? String(activeRunningWorkspaceId) === String(workspaceId)
        : this.running

    // 全局队列状态：运行中 / 已暂停（未运行但有排队任务）/ 空闲
    const hasQueuedWork = snapshot.items.some(
      i => i.status === 'pending' || i.status === 'analyzing'
    )
    const queueStatus: 'idle' | 'running' | 'paused' =
      this.running || this.runningWorkspaceStack.length > 0
        ? 'running'
        : hasQueuedWork
          ? 'paused'
          : 'idle'

    return {
      ...snapshot,
      items: snapshot.items,
      running: isWorkspaceRunning,
      activeRunningWorkspaceId,
      runningWorkspaceStack: this.runningWorkspaceStack.slice(),
      currentAnalyzingItem,
      status: queueStatus,
      lifecyclePhase: this.lifecyclePhase,
      ...(this.lifecyclePhase === 'warming_up' && this.warmupHintCode
        ? { warmupHintCode: this.warmupHintCode }
        : {}),
      videoBackfill: this.videoSegmentBackfillWorker.getSnapshot()
    }
  }

  /**
   * 获取分析队列简要状态（供对外 HTTP API 及状态监测使用）
   */
  public getQueueStatus(workspaceId?: number): {
    systemIdle: boolean
    queueLength: number
    currentProcessingFile: string | null
    total: number
    pending: number
    processing: number
    completed: number
    failed: number
  } {
    const snapshot = this.getSnapshot(workspaceId)
    const items = snapshot.items || []
    const pendingItems = items.filter(i => i.status === 'pending')
    const analyzingItem = snapshot.currentAnalyzingItem || items.find(i => i.status === 'analyzing')
    const completedItems = items.filter(i => i.status === 'completed')
    const failedItems = items.filter(i => i.status === 'failed')

    const queueLength = pendingItems.length + (analyzingItem ? 1 : 0)
    const systemIdle = !snapshot.running && queueLength === 0

    return {
      systemIdle,
      queueLength,
      currentProcessingFile: analyzingItem?.path || null,
      total: items.length,
      pending: pendingItems.length,
      processing: analyzingItem ? 1 : 0,
      completed: completedItems.length,
      failed: failedItems.length
    }
  }

  /**
   * 获取分析总体进度（供对外 HTTP API 及状态监测使用）
   */
  public getProgress(workspaceId?: number): {
    isIdle: boolean
    percentage: number
    analysis: {
      status: 'idle' | 'processing' | 'paused'
      progressPercentage: number
    }
    organizePage: {
      status: 'idle' | 'processing'
      progressPercentage: number
    }
  } {
    const queueStatus = this.getQueueStatus(workspaceId)
    const snapshot = this.getSnapshot(workspaceId)
    const items = snapshot.items || []
    const total = items.length

    let progressPercentage = 100
    if (total > 0) {
      const analyzingItem =
        snapshot.currentAnalyzingItem || items.find(i => i.status === 'analyzing')
      const doneCount = queueStatus.completed + queueStatus.failed
      const partial = analyzingItem ? (analyzingItem.progress || 0) / 100 : 0
      progressPercentage = Number(
        Math.min(100, Math.max(0, ((doneCount + partial) / total) * 100)).toFixed(1)
      )
    }

    const analysisStatus: 'idle' | 'processing' | 'paused' =
      snapshot.status === 'running' || queueStatus.processing > 0
        ? 'processing'
        : snapshot.status === 'paused'
          ? 'paused'
          : 'idle'

    return {
      isIdle: queueStatus.systemIdle,
      percentage: progressPercentage,
      analysis: {
        status: analysisStatus,
        progressPercentage
      },
      organizePage: {
        status: 'idle',
        progressPercentage: 0
      }
    }
  }

  /**
   * 推导当前队列意图模式：
   * - 队列中有待办任务时，按 pickNextPending 判定首选任务模式：
   *   - 若首选为普通分析且启用 AI 阶段（quick_name/full），返回 'language'；标准分析模式无需语言模型，返回 null
   * - 队列为空时：
   *   - 仅在启用 AI 阶段时预置 'language'，标准分析模式返回 null
   */
  public determineIntentMode(): 'language' | null {
    if (!this.queueManager) {
      return isAiStageEnabled() ? 'language' : null
    }
    const snapshot = this.queueManager.getSnapshot()
    const next = snapshot?.items ? pickNextPending(snapshot.items) : undefined
    if (next?.taskType === 'analysis') {
      return isAiStageEnabled() ? 'language' : null
    }
    return isAiStageEnabled() ? 'language' : null
  }

  /**
   * 检测队列中是否存在待处理的任务（pending / analyzing）。
   *
   * `analyzing` 必须计入：canonical 回填以此判断「队列忙碌即暂停」，
   * 若只认 pending，正在跑的分析（且恰好暂无 pending）期间回填会与本地模型抢同一路嵌入。
   */
  public hasPendingItems(): boolean {
    if (!this.queueManager) {
      return false
    }
    const snapshot = this.queueManager.getSnapshot()
    return (
      Array.isArray(snapshot?.items) &&
      snapshot.items.some(i => i.status === 'pending' || i.status === 'analyzing')
    )
  }

  /**
   * 检测本地模型当前是否正忙（已有请求在进行中）
   * 云端模型不限制并发；本地模型无法同时负载多个请求，需拒绝新的 AI 请求
   * @returns true 表示本地模型正忙，应拒绝本次请求
   */
  isLocalModelBusy(): boolean {
    try {
      // 云端模型不限制
      const mode = ConfigOrchestrator.getInstance().getValue<string>('AI_SERVICE_MODE')
      if (mode === 'cloud') return false

      // 分析队列正在运行（本地模型正被队列占用）
      if (this.running || this.isProcessingLoopActive) return true

      // AI 服务正在处理请求
      if (this.aiService && this.aiService.getServiceStatus() === AIServiceStatus.PROCESSING) {
        return true
      }

      return false
    } catch (error) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] 检测本地模型忙碌状态失败:', error)
      return false
    }
  }

  /**
   * 通知前端：本地模型正忙，请停止当前 AI 工作后再请求
   */
  notifyLocalModelBusy(): void {
    void this.writeDispatcher.notifyFrontend(
      'warning',
      t('当前AI已经在工作中，如：分析队列，请停止后再请求'),
      false,
      'local-model-busy',
      5000
    )
  }

  /**
   * 检查扩展名不匹配的文件
   * 查询工作区中 file_group.extensions 不包含 files.extension 的文件列表
   */
  async checkExtensionMismatch(workspaceId: number): Promise<ExtensionMismatchItem[]> {
    return checkExtensionMismatchFiles(workspaceId)
  }

  /**
   * 批量修正扩展名
   * @param fixes 包含文件指纹和选择的扩展名（null 表示不更名）
   */
  async batchFixExtensions(
    fixes: Array<{ fileFingerprint: string; chosenExtension: string | null }>
  ): Promise<{ success: boolean; count: number }> {
    return batchFixFileExtensions(fixes)
  }

  /**
   * 检查指定文件的分析状态，供前端弹窗提示用户。
   * 按「相对当前模式的完成程度」分为 `analyzed` | `insufficient`。
   */
  async checkAlreadyAnalyzedFiles(filePaths: string[]): Promise<any[]> {
    return checkAlreadyAnalyzedFilesByPaths(filePaths)
  }

  // 兼容原有方法名
  async checkStage4Files(filePaths: string[]): Promise<string[]> {
    return this.checkAlreadyAnalyzedFiles(filePaths)
  }
}
