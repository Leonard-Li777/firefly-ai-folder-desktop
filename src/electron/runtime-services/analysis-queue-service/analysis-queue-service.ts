import type {
  AnalysisQueueItem,
  AnalysisQueueSnapshot,
  AnalysisStats,
  IIgnoreRule
} from '@firefly/types'
import { t } from '@app/languages'
import {
  DimensionAnalyzer,
  QualityScoringService,
  UnitRecognitionService,
  FileProcessorService
} from '@firefly/core-engine'
import type { EnqueueInput, IErrorRecoveryConfig } from './types'
import { LogCategory, logger, PerformanceTimer } from '@firefly/shared'
import { loggingService } from '../system/logging-service'
import { systemHealthService } from '../system'
import { loadIgnoreRules } from '../analysis/analysis-ignore-service'
import { LlamaIndexAIService } from '@firefly/electron-llamaIndex-service'
import { AIServiceStatus, ILlamaIndexAIService } from '@firefly/types'
import { BrowserWindow } from 'electron'
import { ConfigOrchestrator } from '@app/electron/config/config-orchestrator'
import {
  resolveAnalysisMode,
  isAiStageEnabled,
  isAnalysisComplete,
  isAnalyzedForMode,
  getRequiredStage,
  normalizeAnalysisMode,
  type AnalysisMode
} from '@app/electron/config/analysis-mode'
import { DirectoryContextService } from '../filesystem/directory-context-service'
import { ErrorHandler } from './error-handler'
import { QueueManager } from './queue-manager'
import { cloudSyncWorker } from '../ai/cloud-sync-worker'
import { createCoreEngineAdapters } from '../../adapters'
import { databaseService } from '../database/database-service'
import { AIServiceManager } from './ai-service-manager'
import { AnalysisStatsCollector } from './analysis-stats-collector'
import { DirectoryProcessor } from './directory-processor'
import { FileProcessor, getFileStageFromDB, getFileAnalysisStateFromDB } from './file-processor'
import path from 'node:path'
import { engineBridgeService } from '../engine-bridge'

class StageNotifier {
  private resolvers = new Map<number, () => void>()
  private completedSet = new Set<number>()

  notify(itemId: number) {
    this.completedSet.add(itemId)
    const resolve = this.resolvers.get(itemId)
    if (resolve) {
      resolve()
      this.resolvers.delete(itemId)
    }
  }

  waitForStage2(itemId: number, checkStage: () => boolean, signal?: AbortSignal): Promise<void> {
    if (this.completedSet.has(itemId) || checkStage()) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        this.resolvers.delete(itemId)
        reject(new Error('Aborted'))
      }
      if (signal?.aborted) {
        return onAbort()
      }
      signal?.addEventListener('abort', onAbort)

      this.resolvers.set(itemId, () => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      })
    })
  }
}

/**
 * 分析队列服务类
 * 整合所有模块,实现完整的文件分析队列处理
 */
export class AnalysisQueueService {
  private queueManager!: QueueManager
  private errorHandler!: ErrorHandler
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
  private currentAbortController: AbortController | null = null

  private wakeUpResolver?: () => void
  private wakeUpPromise?: Promise<void>

  constructor() {
    this.errorHandler = new ErrorHandler()

    // 初始化委托组件
    this.aiServiceManager = new AIServiceManager(
      () => this.aiService,
      () => this.running,
      (type, message, sticky, id, autoClose, action) =>
        this.notifyFrontend(type, message, sticky, id, autoClose, action)
    )

    this.statsCollector = new AnalysisStatsCollector()

    this.directoryProcessor = new DirectoryProcessor(
      () => ({
        unitRecognitionService: this.unitRecognitionService,
        directoryContextService: this.directoryContextService,
        errorRecoveryConfig: this.errorRecoveryConfig,
        ignoreRules: this.ignoreRules
      }),
      (itemId, status, progress, error) => this.updateItemStatus(itemId, status, progress, error),
      () => this.pause(),
      (inputs, forceReanalyze) => this.addItems(inputs, forceReanalyze),
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
        this.updateItemStatus(itemId, status, progress, error, extra),
      () => this.pause(),
      timer => this.statsCollector.collectAnalysisStats(timer),
      (modelId, mode) => this.statsCollector.getModelName(modelId, mode),
      (directoryPath, force?, cacheOnly?) =>
        this.directoryProcessor.analyzeDirectoryContext(directoryPath, force, cacheOnly)
    )

    loggingService.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 服务实例已创建')
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return
    if (this.initializePromise) return this.initializePromise

    this.initializePromise = (async () => {
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

      this.errorHandler = new ErrorHandler(this.errorRecoveryConfig)

      if (adapters) {
        this.reinitFromAdapters(adapters)
      }

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
        this.ignoreRules = []
      }

      this.queueManager = new QueueManager(this.ignoreRules, {
        onUpdate: () => this.emitUpdate(),
        onPersist: () => this.persist(),
        onWakeUp: () => this.wakeUp()
      })

      await this.queueManager.loadFromDB()
      await this.queueManager.validateQueueConsistency()

      this.isInitialized = true
      logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 服务初始化完成')
    })()

    await this.initializePromise
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

  async start(workspaceId?: number): Promise<void> {
    if (workspaceId) {
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

    if (this.isProcessingLoopActive) {
      this.wakeUp()
      this.emitUpdate()
      return
    }

    this.isProcessingLoopActive = true

    systemHealthService.updateMonitoringInterval(30000)
    cloudSyncWorker.updateInterval(30000)

    this.emitUpdate()

    while (this.running && this.runningWorkspaceStack.length > 0) {
      try {
        const activeWorkspaceId = this.runningWorkspaceStack[this.runningWorkspaceStack.length - 1]

        const config = ConfigOrchestrator.getInstance()
        const isForceCpu = config.getValue<boolean>('AI_ENGINE_FORCE_CPU_MODE') ?? false
        const aiServiceMode = config.getValue<string>('AI_SERVICE_MODE') ?? 'local'
        const savedAcc = config.getValue<string>('SELECTED_ACCELERATION')
        // Tier 2 引擎在线时读取其上报的实际运行后端，离线时回退配置值
        const currentEngineAcc = engineBridgeService.getSnapshot().backend
        const selectedAcc = (currentEngineAcc || (savedAcc && savedAcc !== 'auto' ? savedAcc : '') || 'vulkan').toLowerCase()

        // 仅在明确处于 CPU 引擎模式时串行；非 CPU 引擎（GPU/云端/vulkan/cuda 等）均启用并行
        // 引擎可能上报 "CPU (AVX2)" / "cpu-avx2" 等变体，用前缀匹配避免全等漏判
        const isCpuEngine =
          aiServiceMode === 'local' && (isForceCpu || selectedAcc === 'cpu' || selectedAcc.startsWith('cpu'))

        // 统一走 analysis-mode 模块解析，避免与 file-processor / DAO 的口径漂移
        const analysisMode = resolveAnalysisMode()

        const useParallel = !isCpuEngine && isAiStageEnabled(analysisMode)

        if (useParallel) {
          const snapshot = this.queueManager.getSnapshot(undefined, activeWorkspaceId)
          const pendingItems = snapshot.items.filter(i => i.status === 'pending')

          if (pendingItems.length === 0) {
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
              this.emitUpdate()
              continue
            } else {
              this.running = false
              this.current = undefined
              this.isProcessingLoopActive = false
              systemHealthService.updateMonitoringInterval(300000)
              cloudSyncWorker.updateInterval(300000)
              await this.updateVirtualDirectoriesAfterQueueCompletion()
              this.emitUpdate()
              break
            }
          }

          const isReady = await this.aiServiceManager.waitForAIServiceReady()
          if (!isReady) {
            this.running = false
            this.isProcessingLoopActive = false
            break
          }

          const notifier = new StageNotifier()
          this.currentAbortController = new AbortController()
          const signal = this.currentAbortController.signal

          // 记录本次 CPU 阶段被跳过（复用历史提取数据）的队列项 id，
          // GPU 消费者据此透传 cpuSkipped，使 fresh 重建为仅含本次 GPU 指标
          const cpuSkippedIds = new Set<number>()

          const isAlreadyStage2 = (item: AnalysisQueueItem): boolean => {
            const db = databaseService.db
            if (!db || !item.workspaceId) return false
            const stage = getFileStageFromDB(db, item.workspaceId, item.path)
            return stage >= 2
          }

          // 判断“强制重新分析 + 复用关闭 + 之前已分析完成”场景：此时必须重新提取
          // is_analyzed = false 表示文件尚未分析完成（如刚做完 stage1/2 后暂停），
          // 已有提取数据有效，可跳过 CPU 阶段复用
          const isForcedReextract = (item: AnalysisQueueItem): boolean => {
            if (item.forceReanalyze !== true) return false
            const reuseBasicAnalysisData =
              ConfigOrchestrator.getInstance().getValue<boolean>('REUSE_BASIC_ANALYSIS_DATA') ??
              true
            if (reuseBasicAnalysisData) return false
            const db = databaseService.db
            if (!db || !item.workspaceId) return false
            return getFileAnalysisStateFromDB(db, item.workspaceId, item.path).isAnalyzed
          }

          const runCPUProducer = async () => {
            for (const item of pendingItems) {
              if (signal.aborted || !this.running) break
              if (!this.queueManager.hasItem(item.id)) continue

              if (item.itemType === 'directory') {
                notifier.notify(item.id)
                continue
              }

              const reuseBasicAnalysisData =
                ConfigOrchestrator.getInstance().getValue<boolean>('REUSE_BASIC_ANALYSIS_DATA') ??
                true

              // 只要文件已处于 Stage >= 2（CPU 提取已完成），一律跳过 CPU 阶段：
              // - 暂停/恢复：无论是否开启数据复用，都不应重复执行 Stage 2 提取
              // - 强制重新分析 + 复用开启：可跳过、复用已有提取数据
              // - 强制重新分析 + 复用关闭 + 之前已分析完成（is_analyzed=true）：不能跳过，必须重新提取
              // - 强制重新分析 + 复用关闭 + 未完成过（is_analyzed=false，如暂停恢复）：数据有效，可跳过复用
              const shouldSkipCpu = isAlreadyStage2(item) && !isForcedReextract(item)

              if (shouldSkipCpu) {
                logger.debug(
                  LogCategory.ANALYSIS_QUEUE,
                  `[并行队列] 文件已处于 Stage >= 2，CPU 阶段跳过（暂停恢复不重复提取 / 重新分析复用数据）: ${item.name}`
                )
                cpuSkippedIds.add(item.id)
                this.updateItemStatus(item.id, 'pending', 50, undefined, { analysisStage: 2 })
                notifier.notify(item.id)
                continue
              }

              try {
                // 关闭复用时，重置阶段状态为 stage 1 过渡状态
                if (!reuseBasicAnalysisData && item.workspaceId && databaseService.db) {
                  try {
                    const row = databaseService.db
                      .prepare(
                        `
                      SELECT file_fingerprint FROM workspace_files WHERE workspace_id = ? AND path = ?
                    `
                      )
                      .get(item.workspaceId, item.path) as { file_fingerprint?: string } | undefined
                    if (row?.file_fingerprint) {
                      await databaseService.updateAnalysisStage(row.file_fingerprint, 1)
                    }
                  } catch (stageErr) {
                    logger.warn(
                      LogCategory.ANALYSIS_QUEUE,
                      '[并行队列] 重置 Stage 1 状态失败:',
                      stageErr
                    )
                  }
                }

                this.updateItemStatus(item.id, 'analyzing', 10, undefined, { analysisStage: 2 })
                await this.fileProcessor.processFile(item, signal, 'cpu')
                logger.info(LogCategory.ANALYSIS_QUEUE, `[并行队列:CPU通道] CPU 提取完成并发出就绪通知: ${item.name} (id: ${item.id})`)
                notifier.notify(item.id)
              } catch (err) {
                logger.error(
                  LogCategory.ANALYSIS_QUEUE,
                  `[并行队列:CPU通道] CPU 提取异常: ${item.name}`,
                  err
                )
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
            logger.info(
              LogCategory.ANALYSIS_QUEUE,
              `[并行队列:GPU通道] 启动 GPU 消费者循环，待处理文件数: ${pendingItems.length}`
            )
            for (const item of pendingItems) {
              if (signal.aborted || !this.running) {
                logger.info(LogCategory.ANALYSIS_QUEUE, `[并行队列:GPU通道] 收到中止或停止信号，退出 GPU 循环`)
                break
              }
              if (!this.queueManager.hasItem(item.id)) {
                logger.debug(LogCategory.ANALYSIS_QUEUE, `[并行队列:GPU通道] 队列中已无此任务: ${item.name}`)
                continue
              }

              this.current = item

              if (item.itemType === 'directory') {
                this.updateItemStatus(item.id, 'analyzing', 0)
                await this.directoryProcessor.processDirectory(item)
                continue
              }

              try {
                logger.info(
                  LogCategory.ANALYSIS_QUEUE,
                  `[并行队列:GPU通道] 等待 CPU 提取阶段就绪: ${item.name} (id: ${item.id})`
                )
                await notifier.waitForStage2(item.id, () => isAlreadyStage2(item), signal)
                logger.info(
                  LogCategory.ANALYSIS_QUEUE,
                  `[并行队列:GPU通道] CPU 阶段已就绪，进入 GPU AI 分析: ${item.name}`
                )

                if (item.status === 'failed') {
                  logger.warn(
                    LogCategory.ANALYSIS_QUEUE,
                    `[并行队列:GPU通道] CPU 提取失败，跳过 GPU 分析: ${item.name}`
                  )
                  continue
                }

                this.updateItemStatus(item.id, 'analyzing', 51, undefined, { analysisStage: 3 })
                await this.fileProcessor.processFile(
                  item,
                  signal,
                  'gpu',
                  cpuSkippedIds.has(item.id)
                )
                logger.info(
                  LogCategory.ANALYSIS_QUEUE,
                  `[并行队列:GPU通道] GPU AI 分析成功完成: ${item.name}`
                )
                cloudSyncWorker.triggerSync(2000)
              } catch (err: any) {
                const isAbort = err && (err.name === 'AbortError' || err.message === 'Aborted')
                if (isAbort) {
                  logger.info(LogCategory.ANALYSIS_QUEUE, `[并行队列:GPU通道] GPU 任务被中止: ${item.name}`)
                  this.updateItemStatus(item.id, 'pending', 0)
                } else {
                  logger.error(
                    LogCategory.ANALYSIS_QUEUE,
                    `[并行队列:GPU通道] GPU 分析失败: ${item.name}`,
                    err
                  )
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

          try {
            await Promise.all([runCPUProducer(), runGPUConsumer()])
          } catch (error) {
            logger.error(LogCategory.ANALYSIS_QUEUE, '[并行队列] 并行通道执行异常:', error)
          } finally {
            this.currentAbortController = null
            this.current = undefined
            this.emitUpdate()
          }

          const updatedSnapshot = this.queueManager.getSnapshot(undefined, activeWorkspaceId)
          if (updatedSnapshot.items.filter(item => item.status === 'pending').length === 0) {
            await this.updateVirtualDirectoriesAfterQueueCompletion()
          }
        } else {
          // ORIGINAL SERIAL LOOP
          const snapshot = this.queueManager.getSnapshot(undefined, activeWorkspaceId)
          const next = snapshot.items.find(i => i.status === 'pending')

          if (next) {
            const isReady = await this.aiServiceManager.waitForAIServiceReady()
            if (!isReady) {
              this.running = false
              this.isProcessingLoopActive = false
              break
            }
          }

          if (!next) {
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
              this.emitUpdate()
              continue
            } else {
              this.running = false
              this.current = undefined
              this.isProcessingLoopActive = false
              systemHealthService.updateMonitoringInterval(300000)
              cloudSyncWorker.updateInterval(300000)
              await this.updateVirtualDirectoriesAfterQueueCompletion()
              this.emitUpdate()
              break
            }
          }

          // 必须先创建 AbortController 再设置 this.current：
          // pause() 通过 `this.current && this.currentAbortController` 定位要中止的任务，
          // 若先设 current，存在「current 已指向新任务但 controller 仍是上一轮实例」的窗口，
          // 此刻暂停会 abort 到过期对象，导致新任务无法被中止。
          this.currentAbortController = new AbortController()
          const currentSignal = this.currentAbortController.signal
          this.current = next
          this.updateItemStatus(next.id, 'analyzing', 0)

          if (next.itemType === 'directory') {
            await this.directoryProcessor.processDirectory(next)
          } else {
            await this.fileProcessor.processFile(next, currentSignal)
            cloudSyncWorker.triggerSync(2000)
          }

          const updatedSnapshot = this.queueManager.getSnapshot(undefined, activeWorkspaceId)
          if (updatedSnapshot.items.filter(item => item.status === 'pending').length === 0) {
            await this.updateVirtualDirectoriesAfterQueueCompletion()
          }
        }
      } catch (error) {
        await new Promise(resolve => setTimeout(resolve, 2000))
      } finally {
        this.currentAbortController = null
        this.current = undefined
        this.emitUpdate()
      }
    }
    this.isProcessingLoopActive = false
    this.emitUpdate()
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
    if (this.current && (!workspaceId || this.current.workspaceId === workspaceId)) {
      if (this.currentAbortController) {
        this.currentAbortController.abort()
        this.currentAbortController = null
      }
    }

    if (this.runningWorkspaceStack.length === 0) {
      this.running = false
    }

    this.wakeUp()
    this.emitUpdate()
  }

  async addItems(inputs: EnqueueInput[], forceReanalyze = false): Promise<void> {
    await this.ensureInitialized()
    await this.queueManager.addItems(inputs, forceReanalyze)
    // 修复：即使 running 为 true，只要处理循环已退出(isProcessingLoopActive=false)，
    // 也必须重新启动循环，否则新加入的目录项/文件项将永远停留在 pending 不被处理
    if (!this.isProcessingLoopActive && this.isInitialized) {
      void this.start()
    }
  }

  async addItemsResolved(inputs: EnqueueInput[], forceReanalyze = false): Promise<void> {
    await this.ensureInitialized()
    await this.queueManager.addItemsResolved(inputs, forceReanalyze)
    // 修复：同上，处理循环未激活时必须重新启动
    if (!this.isProcessingLoopActive && this.isInitialized) {
      void this.start()
    }
  }

  async deleteItem(id: number): Promise<void> {
    await this.ensureInitialized()
    if (this.current?.id === id && this.currentAbortController) {
      this.currentAbortController.abort()
      this.currentAbortController = null
    }
    this.queueManager.deleteItem(id)
  }

  async deleteItemsByDirectory(directoryPath: string): Promise<void> {
    await this.ensureInitialized()
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

  classifyError(error: Error, context: string): string {
    return this.errorHandler.classifyError(error, context)
  }

  shouldRetry(errorType: string, retryCount: number): boolean {
    return this.errorHandler.shouldRetry(errorType as any, retryCount)
  }

  getMaxRetries(): number {
    return this.errorHandler.getErrorRecoveryConfig().maxRetries
  }

  getErrorStats() {
    return this.errorHandler.getErrorStatistics()
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

    const currentAnalyzingItem = this.current ? { ...this.current } : undefined

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
    void this.notifyFrontend(
      'warning',
      t('当前AI已经在工作中，如：分析队列，请停止后再请求'),
      false,
      'local-model-busy',
      5000
    )
  }

  private emitUpdate(): void {
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

  private persist(): void {}

  private wakeUp(forceStart = false): void {
    if (this.wakeUpResolver) {
      this.wakeUpResolver()
      this.wakeUpResolver = undefined
      this.wakeUpPromise = undefined
    }
  }

  private createWakeUpPromise(timeout: number): Promise<void> {
    const timeoutPromise = new Promise<void>(resolve => setTimeout(resolve, timeout))
    this.wakeUpPromise = new Promise<void>(resolve => {
      this.wakeUpResolver = resolve
    })
    return Promise.race([timeoutPromise, this.wakeUpPromise])
  }

  private updateItemStatus(
    itemId: number,
    status: 'pending' | 'analyzing' | 'completed' | 'failed',
    progress: number,
    error?: string,
    extra?: { analysisStats?: AnalysisStats; fromCache?: boolean; analysisStage?: number }
  ): void {
    const item = this.queueManager.getQueue().find(i => i.id === itemId)
    if (!item) return

    if (status === 'failed') {
      if (error && (error.includes('timeout') || error.includes('超时'))) {
        this.notifyFrontend(
          'warning',
          `${t('分析超时')}: ${item.name}。${t('建议切换低显存需求的AI模型')}`,
          false,
          `timeout-${itemId}`,
          5000,
          // PRD-0044：模型管理 tab 已合并，通知跳链改指「高级AI引擎配置」
          { label: t('前往设置'), category: 'AI_ENGINE_CONFIG' }
        )
      }
    }

    item.status = status
    item.progress = progress
    item.updatedAt = Date.now()
    if (error !== undefined) item.error = error
    if (extra?.analysisStats) item.analysisStats = extra.analysisStats
    if (extra?.fromCache !== undefined) item.fromCache = extra.fromCache
    if (extra?.analysisStage !== undefined) item.analysisStage = extra.analysisStage

    try {
      databaseService.updateAnalysisQueue({ id: itemId, status, progress, error: error || null })
    } catch (e) {
      logger.warn(LogCategory.MAIN, '[AnalysisQueue] 更新分析队列状态到数据库失败:', e)
    }
    this.emitUpdate()
  }

  private async notifyFrontend(
    type: 'info' | 'success' | 'warning' | 'error',
    message: string,
    sticky = false,
    id?: string,
    autoClose?: number,
    action?: any
  ): Promise<void> {
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

  private async updateVirtualDirectoriesAfterQueueCompletion(): Promise<void> {
    try {
      const db = databaseService.db
      if (!db) return
      const directoriesWithVirtualDirs = db
        .prepare(
          `SELECT DISTINCT md.path FROM workspaces md INNER JOIN virtual_directories vd ON vd.workspace_id = md.workspace_id`
        )
        .all() as Array<{ path: string }>
      if (!directoriesWithVirtualDirs || directoriesWithVirtualDirs.length === 0) return
      const { VirtualDirectoryService } =
        await import('../filesystem/virtual-directory-service/index')
      for (const directory of directoriesWithVirtualDirs) {
        try {
          await new VirtualDirectoryService(db).updateAllVirtualDirectories(directory.path)
        } catch (error) {
          logger.warn(
            LogCategory.MAIN,
            '[AnalysisQueue] 更新单个虚拟目录失败:',
            directory.path,
            error
          )
        }
      }
    } catch (error) {
      logger.error(LogCategory.MAIN, '[AnalysisQueue] 队列完成后更新虚拟目录失败:', error)
    }
  }

  /**
   * 检查扩展名不匹配的文件
   * 查询工作区中 file_group.extensions 不包含 files.extension 的文件列表
   */
  async checkExtensionMismatch(workspaceId: number): Promise<
    Array<{
      fileFingerprint: string
      path: string
      name: string
      smartName: string
      extension: string
      extensions: string[]
      workspaceRootPath: string
    }>
  > {
    const db = databaseService.db
    if (!db) return []

    try {
      // 获取工作区根目录路径
      const workspaceDir = db
        .prepare('SELECT path FROM workspace_directories WHERE id = ?')
        .get(workspaceId) as { path: string } | undefined
      const workspaceRootPath = workspaceDir?.path || ''

      // 查询有分组 (file_group) 的文件及其物理路径信息（V4: category→file_group, type→extension）
      const rows = db
        .prepare(
          `
        SELECT f.file_fingerprint, wf.path, wf.name, f.extension, f.file_group, f.smart_name
        FROM files f
        JOIN workspace_files wf ON f.file_fingerprint = wf.file_fingerprint
        WHERE f.file_group IS NOT NULL AND wf.workspace_id = ?
        ORDER BY wf.path ASC
      `
        )
        .all(workspaceId) as Array<{
        file_fingerprint: string
        path: string
        name: string
        extension: string
        file_group: string
        smart_name: string | null
      }>

      const results: Array<{
        fileFingerprint: string
        path: string
        name: string
        smartName: string
        extension: string
        extensions: string[]
        workspaceRootPath: string
      }> = []

      for (const row of rows) {
        try {
          const fileGroup = JSON.parse(row.file_group)

          // 低置信度 Magika 结果（score < 0.8）不进入扩展名校准弹窗，
          // 避免 magika 误判（如带 BOM 的中文 txt 被识别为 powershell，score≈0.58）
          // 字符串类型的 file_group（旧兜底数据）无 score，视为可信，保持原有行为
          const score = fileGroup && typeof fileGroup === 'object' ? (fileGroup.score ?? 1) : 1
          if (score < 0.8) continue

          // 跳过 file_group 解析为 null 的情况（空对象或无效数据）
          const extensions = fileGroup?.extensions || []

          // 跳过 extensions 为空数组的情况
          if (extensions.length === 0) continue

          // 归一化比较：去除开头的点并转小写
          const currentType = row.extension.toLowerCase().replace(/^\./, '')
          const normalizedExtensions = extensions.map((e: string) =>
            e.toLowerCase().replace(/^\./, '')
          )

          // 如果当前 extension 不在 extensions 中，则属于不匹配
          if (!normalizedExtensions.includes(currentType)) {
            results.push({
              fileFingerprint: row.file_fingerprint,
              path: row.path,
              name: row.name,
              smartName: row.smart_name || row.name,
              extension: row.extension,
              extensions: extensions,
              workspaceRootPath
            })
          }
        } catch (parseError) {
          logger.warn(
            LogCategory.ANALYSIS_QUEUE,
            `[扩展名校准] 解析 file_group JSON 失败: ${row.file_fingerprint}`,
            parseError
          )
        }
      }

      return results
    } catch (error) {
      logger.error(LogCategory.ANALYSIS_QUEUE, '[扩展名校准] 查询扩展名不匹配文件失败:', error)
      return []
    }
  }

  /**
   * 批量修正扩展名
   * @param fixes 包含文件指纹和选择的扩展名（null 表示不更名）
   */
  async batchFixExtensions(
    fixes: Array<{ fileFingerprint: string; chosenExtension: string | null }>
  ): Promise<{ success: boolean; count: number }> {
    const db = databaseService.db
    if (!db) return { success: false, count: 0 }

    let count = 0
    try {
      // 使用事务确保原子性
      db.transaction(() => {
        for (const fix of fixes) {
          const { fileFingerprint, chosenExtension } = fix

          if (chosenExtension === null) {
            // "不更名"逻辑：将当前 files.extension 追加到 file_group.extensions
            const row = db
              .prepare('SELECT extension, file_group FROM files WHERE file_fingerprint = ?')
              .get(fileFingerprint) as { extension: string; file_group: string } | undefined

            if (row?.file_group) {
              try {
                const groupObj = JSON.parse(row.file_group)
                const extensions = groupObj.extensions || []
                const currentExt = (row.extension || '').toLowerCase().replace(/^\./, '')

                // 只有当 extensions 中不包含当前 extension 时才追加
                if (
                  !extensions.some(
                    (e: string) => e.toLowerCase().replace(/^\./, '') === currentExt
                  )
                ) {
                  // 保持格式一致：检查原 extensions 第一个元素的格式
                  const hasDot = extensions.length > 0 && extensions[0].startsWith('.')
                  const valueToAdd = hasDot ? `.${currentExt}` : currentExt
                  extensions.push(valueToAdd)
                  groupObj.extensions = extensions

                  db.prepare('UPDATE files SET file_group = ? WHERE file_fingerprint = ?').run(
                    JSON.stringify(groupObj),
                    fileFingerprint
                  )
                  count++
                }
              } catch (e) {
                logger.warn(
                  LogCategory.ANALYSIS_QUEUE,
                  `[扩展名校准] 解析 file_group 失败: ${fix.fileFingerprint}`
                )
              }
            }
          } else {
            // "选扩展名"逻辑：更新 files.extension 和 files.smart_name
            const row = db
              .prepare('SELECT smart_name, extension FROM files WHERE file_fingerprint = ?')
              .get(fileFingerprint) as { smart_name: string; extension: string } | undefined

            if (row) {
              const oldSmartName = row.smart_name || ''
              const newExt = chosenExtension.startsWith('.')
                ? chosenExtension
                : `.${chosenExtension}`

              let newSmartName = oldSmartName
              const currentExt = path.extname(oldSmartName)

              if (currentExt) {
                // 替换扩展名
                newSmartName = oldSmartName.slice(0, -currentExt.length) + newExt
              } else {
                // 追加扩展名
                newSmartName = oldSmartName + newExt
              }

              db.prepare(
                'UPDATE files SET extension = ?, smart_name = ? WHERE file_fingerprint = ?'
              ).run(newExt, newSmartName, fileFingerprint)
              count++
            }
          }
        }
      })()
      return { success: true, count }
    } catch (error) {
      logger.error(LogCategory.ANALYSIS_QUEUE, '[扩展名校准] 批量修正扩展名失败:', error)
      return { success: false, count }
    }
  }

  /**
   * 检查指定文件的分析状态，供前端弹窗提示用户。
   *
   * 按「相对当前模式的完成程度」分为两类，二者判定互斥：
   *
   * 1. `analyzed`（已完成）：`analysis_stage >= 当前模式所需阶段` AND `is_analyzed = 1`
   *    —— 已按当前模式完整分析过，提示用户「可跳过」，默认不重复消耗算力。
   * 2. `insufficient`（分析不完整）：已产生过分析痕迹，但未达到当前模式要求。
   *    涵盖两种子情况：
   *    - `is_analyzed = 1` 但 stage 不达标：此前用较低模式分析过
   *      （例如已完成【简单分析】，而当前是【全面分析】）；
   *    - stage 有值但 `is_analyzed = 0`：CPU 提取完成却未走完 AI 阶段的中间态。
   *    这类文件应当参与分析以补全结果。
   *
   * 两者都不属于的文件（完全没有分析记录）不会被返回，由调用方直接入队。
   *
   * @param filePaths 待检查的文件路径列表
   * @returns 含 `status: 'analyzed' | 'insufficient'` 标记的文件数组
   */
  async checkAlreadyAnalyzedFiles(filePaths: string[]): Promise<any[]> {
    const db = databaseService.db
    if (!db || !filePaths || filePaths.length === 0) return []

    // 统一走 analysis-mode 模块解析
    const analysisMode = resolveAnalysisMode()

    const result: any[] = []
    const chunkSize = 500

    try {
      for (let i = 0; i < filePaths.length; i += chunkSize) {
        const chunk = filePaths.slice(i, i + chunkSize)
        const placeholders = chunk.map(() => '?').join(',')
        const sql = `
          SELECT 
            wf.path, wf.name, wf.is_analyzed,
            fc.quality_score, f.description, f.smart_name, f.author, f.language,
            fc.analysis_stats,
            (
              SELECT GROUP_CONCAT(ft.name, ',')
              FROM file_tag_relations ftr
              JOIN file_tags ft ON ft.code = ftr.tag_code
              WHERE ftr.file_fingerprint = wf.file_fingerprint
            ) as tags_str
          FROM workspace_files wf
          LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
          LEFT JOIN file_contents fc ON wf.file_fingerprint = fc.file_fingerprint
          WHERE wf.path IN (${placeholders})
        `
        const rows = db.prepare(sql).all(...chunk) as Array<{
          path: string
          name: string
          is_analyzed: number
          quality_score: number | null
          description: string | null
          smart_name: string | null
          author: string | null
          language: string | null
          analysis_stats: string | null
          tags_str: string | null
        }>
        for (const row of rows) {
          let stageValue = 0
          let completedMode: AnalysisMode | undefined
          try {
            const stats = row.analysis_stats ? JSON.parse(row.analysis_stats) : null
            stageValue = Number(stats?.analysis_stage ?? 0) || 0
            completedMode = normalizeAnalysisMode(stats?.completed_mode)
          } catch (e) {
            // 解析失败视为未达标
            stageValue = 0
            completedMode = undefined
          }

          // 口径：stage 达标 **且** completed_mode 的等级不低于当前模式（向下兼容）。
          //
          // 必须校验 completed_mode 的原因：quick_name 与 full 的终态 stage 都是 4，
          // 但 quick_name 跳过了质量评分。若只看 stage，会把「用快速命名分析过」的文件
          // 误判为「已完成全面分析」，导致切到全面分析后不补跑质量评分。
          // 反之，高级模式（如 full）的产物对低级模式（quick_name / simple）天然有效，
          // 切回低级模式时无需重跑。
          const analyzed =
            row.is_analyzed === 1 &&
            isAnalyzedForMode({ stage: stageValue, completedMode, mode: analysisMode })

          // 已产生过分析痕迹但未达到当前模式要求
          const insufficient = !analyzed && (row.is_analyzed === 1 || stageValue > 0)

          // 完全无分析记录的文件不返回，由调用方直接入队
          if (!analyzed && !insufficient) continue

          result.push({
            path: row.path,
            name: row.name,
            smartName: row.smart_name || undefined,
            qualityScore: row.quality_score ?? undefined,
            description: row.description || undefined,
            author: row.author || undefined,
            language: row.language || undefined,
            tags: row.tags_str ? row.tags_str.split(',') : undefined,
            isAnalyzed: analyzed,
            /** 相对当前模式的完成程度：analyzed=可跳过；insufficient=需要补全 */
            status: analyzed ? 'analyzed' : 'insufficient',
            /** 该文件已完成的阶段，便于前端展示「已完成阶段 X/Y」 */
            analysisStage: stageValue,
            /** 该文件实际完成分析所用的模式（缺失表示旧数据或未记录） */
            completedMode
          })
        }
      }
    } catch (error) {
      logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 检查已分析文件失败:', error)
    }

    logger.info(
      LogCategory.ANALYSIS_QUEUE,
      `[分析队列] 检查已分析文件 (模式: ${analysisMode}, 目标Stage: ${getRequiredStage(analysisMode)}): 传入 ${filePaths.length} 个, 已完成 ${result.filter(r => r.status === 'analyzed').length} 个, 分析不完整 ${result.filter(r => r.status === 'insufficient').length} 个`
    )

    return result
  }

  // 兼容原有方法名
  async checkStage4Files(filePaths: string[]): Promise<string[]> {
    return this.checkAlreadyAnalyzedFiles(filePaths)
  }
}
