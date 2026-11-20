import type { AnalysisQueueItem, AnalysisQueueSnapshot, IIgnoreRule } from '@firefly/types'
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
import {
  canonicalMaintenanceService,
  installCanonicalMaintenanceListener
} from './canonical-maintenance-service'

import { StageNotifier, Stage2TimeoutError, STAGE2_WAIT_TIMEOUT_MS } from './stage-notifier'
export { StageNotifier, Stage2TimeoutError }
import { AnalysisWriteDispatcher } from './analysis-write-dispatcher'
import { AnalysisOrchestratorWorker } from './analysis-orchestrator-worker'
import { OmniHttpAdapter } from './omni-http-adapter'
import { EngineHealthTier } from './engine-health-tier'
import { OrphanWatchdog } from './orphan-watchdog'
import { flushFtsSync } from './fts-sync-hooks'
import {
  WorkerOrchestratorBridge,
  WriteSetBatchDispatcher,
  type WorkerQueueItem
} from './worker-orchestrator'
import {
  checkExtensionMismatchFiles,
  batchFixFileExtensions,
  checkAlreadyAnalyzedFilesByPaths,
  collectIncompleteVideoEnqueueInputs,
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
  private engineHealth: EngineHealthTier
  private orphanWatchdog: OrphanWatchdog
  private writeSetBatchDispatcher: WriteSetBatchDispatcher
  private workerBridge: WorkerOrchestratorBridge
  private currentAbortController: AbortController | null = null

  /** 工单 06：canonical 档位切换维护监听的取消订阅句柄 */
  private canonicalMaintenanceUnsubscribe?: () => void

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
    this.workerBridge = new WorkerOrchestratorBridge({
      getDb: () => databaseService.db,
      writeDispatcher: this.writeSetBatchDispatcher,
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

    this.engineHealth = new EngineHealthTier(this.aiServiceManager)
    this.omniAdapter = new OmniHttpAdapter()

    this.statsCollector = new AnalysisStatsCollector()
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

    loggingService.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 服务实例已创建')
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
      // 指定了工作空间：抢占最高优先级，移至栈顶
      this.runningWorkspaceStack = this.runningWorkspaceStack.filter(id => id !== workspaceId)
      this.runningWorkspaceStack.push(workspaceId)
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

    if (this.isProcessingLoopActive) {
      this.writeDispatcher.emitUpdate()
      return
    }

    this.isProcessingLoopActive = true

    systemHealthService.updateMonitoringInterval(30000)
    cloudSyncWorker.updateInterval(30000)
    this.orphanWatchdog.start()

    this.writeDispatcher.emitUpdate()

    while (this.running && this.runningWorkspaceStack.length > 0) {
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

        // 统一按当前活跃工作区解析有效分析模式（SLICE-04 旁路收口）
        const hasInstalledAiEngine =
          aiServiceMode === 'local'
            ? this.omniAdapter.hasInstalledEngines() &&
              Boolean(backendSnap.backend || backendSnap.model)
            : true
        let analysisMode = resolveEffectiveAnalysisMode(hasInstalledAiEngine)
        if (activeWorkspaceId != null) {
          try {
            const { resolveWorkspaceEffectiveConfig } =
              await import('../system/workspace-analysis-context')
            const wsEff = await resolveWorkspaceEffectiveConfig(
              activeWorkspaceId,
              hasInstalledAiEngine
            )
            analysisMode = wsEff.effectiveParams.analysisMode
          } catch (wsModeErr) {
            logger.warn(
              LogCategory.ANALYSIS_QUEUE,
              `[分析队列] 解析工作区 ${activeWorkspaceId} 有效模式失败，回退全局:`,
              wsModeErr
            )
          }
        }

        const decisionSnapshot = this.queueManager.getSnapshot(undefined, activeWorkspaceId)
        const hasAnalysisPending = decisionSnapshot.items.some(i => i.status === 'pending')
        const useParallel = !isCpuEngine && isAiStageEnabled(analysisMode) && hasAnalysisPending

        if (useParallel) {
          const pendingItems = decisionSnapshot.items.filter(i => i.status === 'pending')

          if (pendingItems.length === 0) {
            if ((await this.advanceOrStopWorkspaceQueue(activeWorkspaceId)) === 'continue') {
              continue
            }
            break
          }

          const isReady = await this.engineHealth.waitForReady()
          if (!isReady) {
            this.running = false
            this.isProcessingLoopActive = false
            break
          }

          // 并行分析模式：在启动并行流水线前，确保底层引擎处于主语言模型模式
          if (isAiStageEnabled(analysisMode)) {
            const modeRes = await this.omniAdapter.ensureMode('language')
            if (modeRes && !modeRes.ok) {
              this.engineHealth.logWarning('[并行分析] 确保主语言模型就绪告警:', modeRes.error)
            }
          }

          this.currentAbortController = new AbortController()
          const signal = this.currentAbortController.signal

          await this.orchestratorWorker.runParallel(pendingItems, signal, this.stage2WaitTimeoutMs)
        } else {
          // SERIAL LOOP
          const snapshot = this.queueManager.getSnapshot(undefined, activeWorkspaceId)
          const next = pickNextPending(snapshot.items)

          if (next) {
            if (next.taskType === 'analysis' && isAiStageEnabled()) {
              const isReady = await this.engineHealth.waitForReady()
              if (!isReady) {
                this.running = false
                this.isProcessingLoopActive = false
                break
              }
            }
          }

          if (!next) {
            if ((await this.advanceOrStopWorkspaceQueue(activeWorkspaceId)) === 'continue') {
              continue
            }
            break
          }

          this.currentAbortController = new AbortController()
          const currentSignal = this.currentAbortController.signal
          this.current = next
          await this.orchestratorWorker.runSerialItem(
            next,
            currentSignal,
            isAiStageEnabled(),
            this.omniAdapter,
            (msg, err) => this.engineHealth.logWarning(msg, err)
          )
        }

        const updatedSnapshot = this.queueManager.getSnapshot(undefined, activeWorkspaceId)
        if (updatedSnapshot.items.filter(item => item.status === 'pending').length === 0) {
          await updateVirtualDirectoriesAfterQueueCompletion()
        }
      } catch (error) {
        logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 调度主循环异常，2秒后重试:', error)
        await new Promise(resolve => setTimeout(resolve, 2000))
      } finally {
        this.currentAbortController = null
        this.current = undefined
        this.writeDispatcher.emitUpdate()
      }
    }
    this.isProcessingLoopActive = false
    this.syncHibernationState(false)
    this.orphanWatchdog.stop()
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
      this.orchestratorWorker.hasActiveItems(workspaceId)
    if (shouldAbortCurrent) {
      if (this.currentAbortController) {
        this.currentAbortController.abort()
        this.currentAbortController = null
      }
    }

    if (this.runningWorkspaceStack.length === 0) {
      this.running = false
      flushFtsSync()
    }

    this.writeDispatcher.emitUpdate()
  }

  async addItems(inputs: EnqueueInput[], forceReanalyze = false): Promise<EnqueueResult> {
    await this.ensureInitialized()
    const result = await this.queueManager.addItems(inputs, forceReanalyze)
    if (!this.isProcessingLoopActive && this.isInitialized) {
      void this.start()
    }
    return result
  }

  async addItemsResolved(inputs: EnqueueInput[], forceReanalyze = false): Promise<EnqueueResult> {
    await this.ensureInitialized()
    const result = await this.queueManager.addItemsResolved(inputs, forceReanalyze)
    if (!this.isProcessingLoopActive && this.isInitialized) {
      void this.start()
    }
    return result
  }

  async deleteItem(id: number): Promise<void> {
    await this.ensureInitialized()
    if (this.current?.id === id && this.currentAbortController) {
      this.currentAbortController.abort()
      this.currentAbortController = null
    }
    this.workerBridge.cancelItem(id, false)
    this.queueManager.deleteItem(id)
  }

  async deleteItemByPath(filePath: string): Promise<void> {
    await this.ensureInitialized()
    if (
      this.current?.path &&
      isPathEqual(this.current.path, filePath) &&
      this.currentAbortController
    ) {
      this.currentAbortController.abort()
      this.currentAbortController = null
    }
    this.queueManager.deleteItemByPath(filePath)
  }

  async deleteItemsByDirectory(directoryPath: string): Promise<void> {
    await this.ensureInitialized()
    this.queueManager.deleteItemsByDirectory(directoryPath)
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

    const belongsToDirectory = (filePath?: string): boolean => {
      if (!filePath) return false
      return isPathEqual(filePath, directoryPath) || isSubPath(directoryPath, filePath)
    }

    const shouldAbortDirectoryTask =
      (this.current && belongsToDirectory(this.current.path)) ||
      this.orchestratorWorker.hasActiveItemMatching(belongsToDirectory)
    if (shouldAbortDirectoryTask) {
      logger.debug(
        LogCategory.ANALYSIS_QUEUE,
        '[分析队列] 删除工作目录前中止在途任务，释放 .VirtualDirectory 句柄:',
        this.current?.path || directoryPath
      )
      if (this.currentAbortController) {
        this.currentAbortController.abort()
        this.currentAbortController = null
      }
    }

    this.queueManager.deleteItemsByDirectory(directoryPath)
  }

  async clearPending(): Promise<void> {
    await this.ensureInitialized()
    if (this.currentAbortController) {
      this.currentAbortController.abort()
      this.currentAbortController = null
    }
    this.queueManager.clearPending()
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
    return this.queueManager.cancelUnmatchedTasks(workspaceId, allowedExtensions, directoryPrefix)
  }

  async clearAll(): Promise<void> {
    await this.ensureInitialized()
    if (this.currentAbortController) {
      this.currentAbortController.abort()
      this.currentAbortController = null
    }
    this.queueManager.clearAll()
    if (!this.running && this.isInitialized) {
      void this.start()
    }
  }

  async retryFailed(): Promise<void> {
    await this.ensureInitialized()
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
    if (this.current?.id === id && this.currentAbortController) {
      this.currentAbortController.abort()
      this.currentAbortController = null
    }
    this.workerBridge.cancelItem(id, true)
    this.writeDispatcher.updateItemStatus(id, 'failed', 0, 'canceled_by_user')
  }

  /** 获取 Stage 2 独立 Worker 托管桥（供调度与可观测性检查） */
  public getWorkerBridge(): WorkerOrchestratorBridge {
    return this.workerBridge
  }

  /** 获取主进程写微事务执行器（供调度与可观测性检查） */
  public getWriteSetBatchDispatcher(): WriteSetBatchDispatcher {
    return this.writeSetBatchDispatcher
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
      await this.workerBridge.dispose()
    } catch (err) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] 退出销毁 WorkerBridge 失败:', err)
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
   * 恢复与重新入队存在未完成切片的视频（例如会员升级为 Pro 后唤醒待续作长视频，ISS-60）
   */
  public async requeueIncompleteVideos(): Promise<number> {
    const inputs = collectIncompleteVideoEnqueueInputs()
    if (inputs.length === 0) return 0
    await this.addItems(inputs, true)
    return inputs.length
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
      status: queueStatus
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
