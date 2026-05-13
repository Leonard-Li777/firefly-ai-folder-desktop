/**
 * 分析队列服务 - 主服务类
 * 整合所有模块,实现完整的文件分析队列处理
 * 使用 @yonuc/core-engine 的服务
 */

import type { AnalysisQueueItem, AnalysisQueueSnapshot, AnalysisStats } from '@yonuc/types'
import {
  DimensionAnalyzer,
  FileDimensionService,
  FileInfoInput,
  QualityScoringService,
  UnitRecognitionService,
  fileAnalysisService,
  getMimeType
} from '@yonuc/core-engine'
import type { DimensionExpansion, DirectoryContextAnalysis } from '@yonuc/types'
import type { EnqueueInput, IErrorRecoveryConfig } from './types'
import { FileCategory, LogCategory, isCategory, logger } from '@yonuc/shared'
import { FileProcessorService, LanguageConfigService } from '@yonuc/core-engine'
import { hardwareDetectionService, systemHealthService } from '../system'
import { loadIgnoreRules, shouldIgnoreFile } from '../analysis/analysis-ignore-service'

import { AIServiceAdapter } from '../ai/ai-service-adapter'
import { AIServiceStatus } from '@yonuc/types'
import { BrowserWindow } from 'electron'
import { ConfigOrchestrator } from '@app/electron/config/config-orchestrator'
import { DirectoryContextService } from '../filesystem/directory-context-service'
import { DocumentFileProcessor } from '@yonuc/core-engine/services/analysis/document-file-processor'
import { ErrorHandler } from './error-handler'
import type { IIgnoreRule } from '@yonuc/types'
import type { LanguageCode } from '@yonuc/types'
import { ModelConfigService } from '../analysis/model-config-service'
import { PerformanceTimer } from '../utils/performance-timer'
import { QueueManager } from './queue-manager'
import { TextFileProcessor } from '@yonuc/core-engine/services/analysis/text-file-processor'
import { calculateFileFingerprint } from '@yonuc/core-engine/utils/file-fingerprint'
import { cloudAnalysisService } from '@yonuc/server'
import { cloudSyncWorker } from '../ai/cloud-sync-worker'
import { createCoreEngineAdapters } from '../../adapters'
import { databaseService } from '../database/database-service'
import fs from 'node:fs'
import { invitationService } from '../invitation/invitation-service'
import path from 'node:path'
import { t } from '@app/languages'
import { thumbnailService } from '../filesystem/thumbnail-service'
import { unifiedModelManager } from '../llama/unified-model-manager'

/**
 * 判断提取的文本内容是否为人类可读
 */
function isHumanReadable(text: string | null | undefined): boolean {
  if (!text || text.length < 50) {
    return true;
  }

  const totalChars = text.length;
  let controlChars = 0;
  let spaceChars = 0;
  let cjkChars = 0;

  for (let i = 0; i < totalChars; i++) {
    const charCode = text.charCodeAt(i);
    if (charCode < 32 && charCode !== 10 && charCode !== 13 && charCode !== 9) {
      controlChars++;
    }
    if (charCode === 32) {
      spaceChars++;
    }
    if (charCode >= 0x4E00 && charCode <= 0x9FFF) {
      cjkChars++;
    }
  }

  const controlCharRatio = controlChars / totalChars;
  if (controlCharRatio > 0.1) {
    return false;
  }

  const cjkRatio = cjkChars / totalChars;
  if (cjkRatio > 0.05) {
    return true;
  }

  const spaceRatio = spaceChars / totalChars;
  if (spaceRatio < 0.07) {
    return false;
  }

  const words = text.trim().split(/\s+/);
  if (words.length < 10) {
    return true;
  }
  const totalWordLength = words.reduce((acc, word) => acc + word.length, 0);
  const avgWordLength = totalWordLength / words.length;

  if (avgWordLength > 20 || avgWordLength < 2.5) {
    return false;
  }

  return true;
}


/**
 * 分析队列服务类
 */
export class AnalysisQueueService {
  private queueManager!: QueueManager
  private errorHandler!: ErrorHandler
  private fileProcessor!: FileProcessorService

  private dimensionAnalyzer!: DimensionAnalyzer
  private qualityScoringService!: QualityScoringService
  private unitRecognitionService!: UnitRecognitionService
  private fileDimensionService?: FileDimensionService
  private directoryContextService?: DirectoryContextService
  private aiServiceAdapter?: AIServiceAdapter

  private running = false
  private isProcessingLoopActive = false
  private current?: AnalysisQueueItem
  private isInitialized = false

  private ignoreRules: IIgnoreRule[] = []
  private errorRecoveryConfig: IErrorRecoveryConfig = {
    maxRetries: 0,
    retryDelay: 0,
    fileProcessingTimeout: 0,
    aiRequestTimeout: 0,
    unitRecognitionTimeout: 0,
  }

  private directoryContextCache: Map<string, DirectoryContextAnalysis> = new Map()

  /**
   * 清除目录上下文缓存
   * @param directoryPath 可选，如果提供则只清除该目录及其子目录的缓存，否则清除所有
   */
  clearDirectoryContextCache(directoryPath?: string): void {
    if (directoryPath) {
      const resolvedPath = path.resolve(directoryPath)
      const keysToRemove: string[] = []
      for (const cachedPath of this.directoryContextCache.keys()) {
        const resolvedCachedPath = path.resolve(cachedPath)
        if (resolvedCachedPath === resolvedPath || resolvedCachedPath.startsWith(resolvedPath + path.sep)) {
          keysToRemove.push(cachedPath)
        }
      }
      keysToRemove.forEach(key => this.directoryContextCache.delete(key))
      logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 已清除目录缓存: ${resolvedPath}`)
    } else {
      this.directoryContextCache.clear()
      logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 已清除所有目录上下文缓存')
    }
  }

  private wakeUpResolver?: () => void
  private wakeUpPromise?: Promise<void>

  constructor() {
    logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 服务实例已创建')
  }

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 开始初始化服务...')

    this.errorRecoveryConfig.maxRetries = ConfigOrchestrator.getInstance().getValue<number>('ERROR_MAX_RETRIES') ?? 0
    this.errorRecoveryConfig.retryDelay = ConfigOrchestrator.getInstance().getValue<number>('ERROR_RETRY_DELAY') ?? 1000
    this.errorRecoveryConfig.fileProcessingTimeout = 60000
    this.errorRecoveryConfig.aiRequestTimeout = ConfigOrchestrator.getInstance().getValue<number>('AI_REQUEST_TIMEOUT') ?? 60000
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
      this.qualityScoringService = new QualityScoringService(
        adapters.logger,
        adapters.llamaRuntime,
        adapters.database,
        adapters.config,
        {
          getQualityScorePrompt: () => ConfigOrchestrator.getInstance().getValue<string>('QUALITY_SCORE_PROMPT'),
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

      this.unitRecognitionService = new UnitRecognitionService(
        adapters.fileSystem,
        adapters.logger
      )

      this.fileProcessor = new FileProcessorService(
        adapters.logger,
        adapters.config,
        adapters.fileSystem,
        this.qualityScoringService,
        this.errorRecoveryConfig,
      )
    }

    // 延迟数据库相关的初始化，等待数据库服务完全初始化后再通过 reloadDatabase 初始化
    // 这样可以避免 "Cannot access 'db' before initialization" 错误
    const db = databaseService.db
    if (db && adapters) {
      try {
        this.aiServiceAdapter = new AIServiceAdapter()
        const languageConfigService = new LanguageConfigService(adapters.logger,
          adapters.fileSystem,
          adapters.llamaRuntime,
          adapters.config
        )

        this.fileDimensionService = new FileDimensionService(
          db,
          this.aiServiceAdapter,
          languageConfigService,
          adapters.modelCapability,
          adapters.aiHelper
        )
        const llamaIndexService = this.aiServiceAdapter.getAIService()
        this.directoryContextService = new DirectoryContextService(llamaIndexService)

        const userLanguage = (ConfigOrchestrator.getInstance().getValue<LanguageCode>('DEFAULT_LANGUAGE') || 'zh-CN') as LanguageCode
        this.fileDimensionService.setCurrentLanguage(userLanguage)

        await this.fileDimensionService.initializeDimensionsForLanguage(userLanguage)
      } catch (error) {
        logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 维度系统初始化失败:', error)
      }
    } else {
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] 数据库未就绪，将延迟初始化维度系统')
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
  }

  /**
   * 重新加载忽略规则
   */
  reloadIgnoreRules(): void {
    try {
      this.ignoreRules = loadIgnoreRules()
      if (this.queueManager) {
        this.queueManager.setIgnoreRules(this.ignoreRules)
      }
      logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 已重新加载 ${this.ignoreRules.length} 条忽略规则`)
    } catch (error) {
      logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 重新加载忽略规则失败:', error)
    }
  }

  async reloadDatabase(): Promise<void> {
    if (!this.isInitialized) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] 服务尚未初始化，无法重新加载数据库')
      return
    }

    logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 正在重新加载数据库依赖...')

    const db = databaseService.db
    if (!db) {
      logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 无法重新加载：数据库未连接')
      return
    }

    // 如果 aiServiceAdapter 尚未初始化，先创建它
    if (!this.aiServiceAdapter) {
      logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 检测到 aiServiceAdapter 未初始化，正在创建...')
      this.aiServiceAdapter = new AIServiceAdapter()
    }

    try {
      // 重新创建依赖于 DB 实例的服务
      // 注意：QualityScoringService 等使用 DatabaseAdapter，而 DatabaseAdapter 已修改为动态获取 DB，所以无需重建

      // LanguageConfigService 依赖 adapters，adapters 应该没问题
      // 但 FileDimensionService 直接接收 db 实例，必须重建

      // 我们需要重新获取 adapter 中的 languageConfigService
      // 由于这里没有保存 languageConfigService 的引用，我们重新创建一个
      // 注意：这假设 LanguageConfigService 构造函数比较轻量
      const adapters = await createCoreEngineAdapters()
      const languageConfigService = new LanguageConfigService(
        adapters.logger,
        adapters.fileSystem,
        adapters.llamaRuntime,
        adapters.config
      )

      this.fileDimensionService = new FileDimensionService(
        db,
        this.aiServiceAdapter,
        languageConfigService,
        adapters.modelCapability,
        adapters.aiHelper
      )

      // DirectoryContextService 也重建一下，尽管它已改为动态获取 DB
      const llamaIndexService = this.aiServiceAdapter.getAIService()
      this.directoryContextService = new DirectoryContextService(llamaIndexService)

      const userLanguage = (ConfigOrchestrator.getInstance().getValue<LanguageCode>('DEFAULT_LANGUAGE') || 'zh-CN') as LanguageCode
      this.fileDimensionService.setCurrentLanguage(userLanguage)

      await this.fileDimensionService.initializeDimensionsForLanguage(userLanguage)

      logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 数据库依赖重新加载完成')
    } catch (error) {
      logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 重新加载数据库依赖失败:', error)
    }
  }

  async start(): Promise<void> {
    logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] start被调用. running=${this.running}`)
    if (this.isProcessingLoopActive) {
      logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 服务循环已在运行中，确保 running=true')
      this.running = true;
      this.wakeUp();
      this.emitUpdate();
      return;
    }
    this.isProcessingLoopActive = true;
    this.running = true;
    logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 启动处理循环')
    
    // 启动时恢复正常检查频率 (30秒)
    systemHealthService.updateMonitoringInterval(30000)
    cloudSyncWorker.updateInterval(30000)
    
    this.emitUpdate();

    while (this.running) {
      try {
        const snapshot = this.queueManager.getSnapshot()
        const next = snapshot.items.find(i => i.status === 'pending')

        if (next) {
          // 在处理具体项目前，确保 AI 服务已就绪
          const isReady = await this.waitForAIServiceReady()
          if (!isReady) {
            logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] AI服务未就绪且等待失败，暂停队列')
            this.running = false
            this.isProcessingLoopActive = false
            break
          }
        }

        if (!next) {
          logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 队列已空，停止处理循环')
          this.running = false
          this.current = undefined
          this.isProcessingLoopActive = false
          
          // 停止时进入低频检查模式 (5分钟)
          systemHealthService.updateMonitoringInterval(300000)
          cloudSyncWorker.updateInterval(300000)
          
          break
        }

        this.current = next
        logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 开始处理项目: ${next.path} (${next.itemType}, ${next.type})`)

        this.updateItemStatus(next.id, 'analyzing', 0)

        if (next.itemType === 'directory') {
          await this.processDirectory(next)
        } else {
          await this.processFile(next)
          // 文件分析完成后，立即触发云端同步 (带短延迟防抖)
          cloudSyncWorker.triggerSync(2000)
        }

        const updatedSnapshot = this.queueManager.getSnapshot()
        if (updatedSnapshot.items.filter(item => item.status === 'pending').length === 0) {
          await this.updateVirtualDirectoriesAfterQueueCompletion()
        }
      } catch (error) {
        logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 处理循环发生异常:', error)
        // 发生错误时暂停一会，避免死循环日志轰炸
        await new Promise(resolve => setTimeout(resolve, 2000))
      } finally {
        this.current = undefined
        this.emitUpdate()
      }
    }
    logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 处理循环已停止')
    this.isProcessingLoopActive = false;
    this.emitUpdate()
  }

  pause(): void {
    logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 暂停被调用', { running: this.running, isLoopActive: this.isProcessingLoopActive })
    this.running = false
    this.wakeUp() // 唤醒以打破等待，使循环退出
    this.emitUpdate()
  }

  async addItems(inputs: EnqueueInput[], forceReanalyze = false): Promise<void> {
    if (!this.queueManager) throw new Error('分析队列服务未初始化')
    await this.queueManager.addItems(inputs, forceReanalyze)
    if (!this.running && this.isInitialized) {
      void this.start()
    }
  }

  async addItemsResolved(inputs: EnqueueInput[], forceReanalyze = false): Promise<void> {
    if (!this.queueManager) throw new Error('分析队列服务未初始化')
    await this.queueManager.addItemsResolved(inputs, forceReanalyze)
    if (!this.running && this.isInitialized) {
      void this.start()
    }
  }

  deleteItem(id: number): void {
    if (!this.queueManager) throw new Error('分析队列服务未初始化')
    this.queueManager.deleteItem(id)
  }

  deleteItemsByDirectory(directoryPath: string): void {
    if (!this.queueManager) throw new Error('分析队列服务未初始化')
    this.queueManager.deleteItemsByDirectory(directoryPath)
  }

  clearPending(): void {
    if (!this.queueManager) throw new Error('分析队列服务未初始化')

    logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 接收到清空待处理请求')
    this.queueManager.clearPending()
    logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 清空待处理完成')

    // 清空后重新启动队列循环
    if (!this.running && this.isInitialized) {
      logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 清空后重新启动队列循环')
      void this.start()
    }
  }

  clearAll(): void {
    if (!this.queueManager) throw new Error('分析队列服务未初始化')

    logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 接收到清空所有队列请求')
    this.queueManager.clearAll()
    logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 清空所有队列完成')

    // 清空后重新启动队列循环
    if (!this.running && this.isInitialized) {
      logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 清空后重新启动队列循环')
      void this.start()
    }
  }

  retryFailed(): void {
    if (!this.queueManager) throw new Error('分析队列服务未初始化')
    this.queueManager.retryFailed()
    if (!this.running && this.isInitialized) {
      void this.start()
    }
  }

  getSnapshot(): AnalysisQueueSnapshot {
    if (!this.queueManager) return { items: [], running: this.running, currentItemId: undefined };
    const snapshot = this.queueManager.getSnapshot(this.current?.id);
    
    // 关键修复：从数据库实时获取文件的 is_hit 和 analysis_stats，因为内存中的 queue 可能在重启后丢失这些字段
    try {
      const dbItems = databaseService.getAnalysisQueue();
      const dbMap = new Map(dbItems.map(i => [i.file_path, i]));

      snapshot.items = snapshot.items.map(item => {
        const dbInfo = dbMap.get(item.path);
        if (dbInfo) {
          return {
            ...item,
            // 优先使用内存中的状态（如果正在分析中），否则使用数据库中的持久化状态
            fromCache: item.fromCache !== undefined ? item.fromCache : !!dbInfo.is_hit,
            analysisStats: item.analysisStats || (dbInfo.analysis_stats ? (typeof dbInfo.analysis_stats === 'string' ? JSON.parse(dbInfo.analysis_stats) : dbInfo.analysis_stats) : undefined)
          };
        }
        return item;
      });
    } catch (e) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] getSnapshot 补全数据失败:', e);
    }

    return { ...snapshot, running: this.running };
  }

  private emitUpdate(): void {
    const windows = BrowserWindow.getAllWindows()
    const snapshot = this.getSnapshot()
    logger.debug(LogCategory.ANALYSIS_QUEUE, '[分析队列] 发送状态更新', { running: snapshot.running, itemCount: snapshot.items.length })
    windows.forEach(win => {
      if (!win.webContents.isDestroyed()) {
        try {
          win.webContents.send('analysis-queue-updated', snapshot)
        } catch (e) {
          logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] 发送更新失败，可能是窗口已销毁', e)
        }
      }
    })
  }

  private persist(): void { }

  private wakeUp(forceStart = false): void {
    logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] wakeUp被调用. running=${this.running}, isInitialized=${this.isInitialized}, forceStart=${forceStart}`)
    
    if (this.wakeUpResolver) {
      logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 触发 wakeUpResolver')
      this.wakeUpResolver()
      this.wakeUpResolver = undefined
      this.wakeUpPromise = undefined
    } else {
      logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] wakeUpResolver 未定义，无法立即唤醒循环 (可能正在运行或等待超时)')
    }
  }

  private createWakeUpPromise(timeout: number): Promise<void> {
    const timeoutPromise = new Promise<void>(resolve => setTimeout(resolve, timeout))
    this.wakeUpPromise = new Promise<void>(resolve => { this.wakeUpResolver = resolve })
    return Promise.race([timeoutPromise, this.wakeUpPromise])
  }

  private updateItemStatus(itemId: number, status: 'pending' | 'analyzing' | 'completed' | 'failed', progress: number, error?: string, extra?: { analysisStats?: AnalysisStats; fromCache?: boolean }): void {
    const item = this.queueManager.getQueue().find(i => i.id === itemId)
    if (!item) return

    if (status === 'failed') {
      logger.error(LogCategory.ANALYSIS_QUEUE, `[分析队列] 项目处理失败: ${itemId} (${item.path}), 错误: ${error}`)
      
      // 特殊处理超时通知：主动弹出 Toast
      if (error && (error.includes('timeout') || error.includes('超时'))) {
        this.notifyFrontend(
          'warning', 
          `${t('分析超时')}: ${item.name}。${t('建议切换低显存需求的AI模型')}`, 
          false, 
          `timeout-${itemId}`,
          5000,
          {
            label: t('前往设置'),
            category: 'AI_MODEL'
          }
        )
      }
    } else if (status !== item.status) {
      logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 项目状态更新: ${itemId}, ${item.status} -> ${status}`)
    }

    item.status = status
    item.progress = progress
    item.updatedAt = Date.now()
    if (error !== undefined) item.error = error
    if (extra?.analysisStats) item.analysisStats = extra.analysisStats
    if (extra?.fromCache !== undefined) item.fromCache = extra.fromCache

    try {
      databaseService.updateAnalysisQueue({ id: itemId, status, progress, error: error || null })
    } catch (e) { }
    this.emitUpdate()
  }

  /**
   * 通用的前端通知方法
   */
  private async notifyFrontend(type: 'info' | 'success' | 'warning' | 'error', message: string, sticky: boolean = false, id?: string, autoClose?: number, action?: any): Promise<void> {
    try {
      const windows = BrowserWindow.getAllWindows()
      windows.forEach(win => {
        if (!win.webContents.isDestroyed()) {
          win.webContents.send('system:notification', { type, message, sticky, id, autoClose, action })
        }
      })
    } catch (e) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] 发送前端通知失败', { error: e, message })
    }
  }

  /**
   * 等待 AI 服务就绪
   */
  private async waitForAIServiceReady(): Promise<boolean> {
    if (!this.aiServiceAdapter) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] AI 适配器未初始化，无法检查状态')
      return true
    }

    const aiService = this.aiServiceAdapter.getAIService()
    let status = aiService.getServiceStatus()

    if (status === AIServiceStatus.IDLE || status === AIServiceStatus.PROCESSING) {
      return true
    }

    logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] AI服务未就绪 (当前状态: ${status}), 开始等待...`)

    // 发送通知给前端
    this.notifyFrontend('info', t('正在等待AI引擎启动，请稍候...'), true, 'waiting-for-ai', 0)

    // 等待状态变化，最多等待 120 秒
    const startTime = Date.now()
    while (Date.now() - startTime < 120000) {
      // 如果在此期间用户手动暂停了队列，停止等待
      if (!this.running) {
        this.notifyFrontend('info', t('分析已暂停'), false, 'waiting-for-ai', 3000)
        return false
      }

      status = aiService.getServiceStatus()
      if (status === AIServiceStatus.IDLE || status === AIServiceStatus.PROCESSING) {
        logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] AI服务已就绪，继续执行')
        this.notifyFrontend('success', t('AI引擎已就绪，开始分析'), false, 'waiting-for-ai', 3000)
        return true
      }

      if (status === AIServiceStatus.ERROR) {
        logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] AI服务处于错误状态，停止等待')
        this.notifyFrontend('error', t('AI引擎启动失败，请检查配置或手动重启服务'), false, 'waiting-for-ai', 5000)
        return false
      }

      // 每秒检查一次
      await new Promise(resolve => setTimeout(resolve, 1000))
    }

    logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 等待AI服务就绪超时')
    this.notifyFrontend('error', t('等待AI引擎启动超时'), false, 'waiting-for-ai', 5000)
    return false
  }

  private async processDirectory(item: AnalysisQueueItem): Promise<void> {
    try {
      // 配额检查：只对私有目录文件进行限制
      const rootWorkspaceDir = await databaseService.findRootWorkspaceDirectory(item.path)
      const isPrivate = rootWorkspaceDir?.type === 'PRIVATE'

      if (isPrivate) {
        try {
          await invitationService.checkQuotaLimit()
        } catch (error: any) {
          logger.warn(LogCategory.ANALYSIS_QUEUE, `[配额限制] 目录无法分析：${item.path}`, error.message)
          this.updateItemStatus(item.id, 'failed', 0, error.message)
          this.pause() // 配额超限，立即暂停队列
          return
        }
      }

      if (!this.unitRecognitionService) {
        logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] UnitRecognitionService未初始化，尝试重新初始化适配器...')
        try {
          const adapters = await createCoreEngineAdapters()
          if (adapters) {
             this.qualityScoringService = new QualityScoringService(
               adapters.logger,
               adapters.llamaRuntime,
               adapters.database,
               adapters.config,
               {
                 getQualityScorePrompt: () => ConfigOrchestrator.getInstance().getValue<string>('QUALITY_SCORE_PROMPT'),
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
              this.unitRecognitionService = new UnitRecognitionService(
                adapters.fileSystem,
                adapters.logger
              )
              this.fileProcessor = new FileProcessorService(
                adapters.logger,
                adapters.config,
                adapters.fileSystem,
                this.qualityScoringService,
                this.errorRecoveryConfig,
              )
              logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 适配器重新初始化成功')
          }
        } catch (reinitError) {
           logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 适配器重新初始化失败:', reinitError)
        }

        if (!this.unitRecognitionService) {
          this.updateItemStatus(item.id, 'failed', 100, 'UnitRecognitionService未初始化 (重试失败)')
          return
        }
      }

      this.updateItemStatus(item.id, 'analyzing', 10)
      const unitResult = await this.unitRecognitionService.recognizeDirectory(item.path)

      if (unitResult.isUnit) {
        item.isUnit = true
        item.unitType = unitResult.unitType
        item.unitReason = unitResult.reason
        item.unitConfidence = unitResult.confidence

        const parentPath = path.dirname(item.path)
        const workspaceId = await databaseService.getWorkspaceIdByPath(parentPath)
        if (!workspaceId) {
          throw new Error(`未找到路径 ${parentPath} 对应的工作区`)
        }
        await databaseService.createUnit({
          name: path.basename(item.path),
          type: unitResult.unitType || 'unit',
          path: item.path,
          groupingReason: unitResult.reason,
          groupingConfidence: unitResult.confidence,
          workspaceId: workspaceId,
        })
        this.updateItemStatus(item.id, 'completed', 100)
      } else {
        // 如果是非最小单元目录，先进行目录上下文分析
        this.updateItemStatus(item.id, 'analyzing', 20)
        try {
          await this.analyzeDirectoryContext(item.path, !!item.forceReanalyze)
        } catch (ctxError) {
          logger.warn(LogCategory.ANALYSIS_QUEUE, `[分析队列] 目录上下文分析失败 (跳过并继续展开): ${item.path}`, ctxError)
        }

        // 展开当前目录的直接子内容（一层）加入队列
        this.updateItemStatus(item.id, 'analyzing', 50)
        await this.expandDirectoryToQueue(item.path, !!item.forceReanalyze)
        this.updateItemStatus(item.id, 'completed', 100)
      }
    } catch (error: any) {
      let errorMsg = error instanceof Error ? error.message : String(error)
      // 处理超时建议
      if (errorMsg.includes('timeout') || errorMsg.includes('超时')) {
        errorMsg += ` ${t('建议切换低显存需求的AI模型')}`
      }
      this.updateItemStatus(item.id, 'failed', 100, errorMsg)
    }
  }

  private async analyzeDirectoryContext(directoryPath: string, force = false): Promise<DirectoryContextAnalysis | null> {
    if (!force && this.directoryContextCache.has(directoryPath)) return this.directoryContextCache.get(directoryPath)!
    if (!this.directoryContextService) return null
    const userLanguage = ConfigOrchestrator.getInstance().getValue<LanguageCode>('DEFAULT_LANGUAGE') || 'zh-CN'
    const contextAnalysis = await this.directoryContextService.analyzeDirectoryContext(directoryPath, userLanguage as LanguageCode, force)
    this.directoryContextCache.set(directoryPath, contextAnalysis)
    return contextAnalysis
  }

  private async expandDirectoryToQueue(directoryPath: string, forceReanalyze: boolean): Promise<void> {
    const entries = fs.readdirSync(directoryPath, { withFileTypes: true })
    const newItems: EnqueueInput[] = []
    
    // 第一步：确保所有子目录/文件记录存在于数据库中
    for (const entry of entries) {
      const fullPath = path.join(directoryPath, entry.name)
      if (shouldIgnoreFile(fullPath, entry.name, this.ignoreRules)) continue
      
      if (entry.isDirectory()) {
        // 确保目录记录存在
        const dir = databaseService.db?.prepare(`SELECT id FROM workspace_directories WHERE path = ?`).get(fullPath) as any;
        if (!dir) {
          const ws = await databaseService.findRootWorkspaceDirectory(fullPath);
          if (ws && ws.id) {
            await databaseService.addDirectory(fullPath, ws.id)
          }
        }
        newItems.push({ path: fullPath, name: entry.name, size: 0, type: 'folder' })
      } else {
        const stat = fs.statSync(fullPath)
        // 确保文件记录存在
        const wf = databaseService.db?.prepare(`SELECT id FROM workspace_files WHERE path = ?`).get(fullPath) as any;
        if (!wf) {
          const ws = await databaseService.findRootWorkspaceDirectory(directoryPath);
          if (ws && ws.id) {
            await databaseService.addFileFromPath(fullPath, '', ws.id)
          }
        }
        newItems.push({ path: fullPath, name: entry.name, size: stat.size, type: path.extname(entry.name).slice(1) || 'file' })
      }
    }
    
    if (newItems.length > 0) this.addItems(newItems, forceReanalyze)
  }

      private async processFile(item: AnalysisQueueItem): Promise<void> {
    try {
      // V2.2 架构：优先从 item.path 获取，如果存在则通过 item_id 查询数据库
      let filePath = (item as any).file_path || item.path;
      const itemId = (item as any).item_id;
      const itemType = (item as any).item_type || 'file';

      // 如果没有 filePath 但有 item_id，根据类型从对应表查询真实路径
      if (!filePath && itemId) {
        const db = databaseService.db;
        if (db) {
          let wf: any = null;
          if (itemType === 'directory') {
            wf = db.prepare(`SELECT path FROM workspace_directories WHERE id = ?`).get(itemId) as any;
          } else {
            wf = db.prepare(`SELECT path FROM workspace_files WHERE id = ?`).get(itemId) as any;
          }
          if (wf && wf.path) {
            filePath = wf.path;
          }
        }
      }

      // 如果仍然没有 filePath，报错
      if (!filePath) {
        logger.error(LogCategory.ANALYSIS_QUEUE, `[分析队列] 无法获取文件路径: ${item.id}`)
        this.updateItemStatus(item.id, 'failed', 0, '文件路径丢失')
        return
      }

      const timer = new PerformanceTimer(filePath)
      const db = databaseService.db
      if (!db) {
        logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 数据库连接不可用')
        this.updateItemStatus(item.id, 'failed', 0, '数据库未初始化')
        return
      }

      let currentStats: fs.Stats | null = null
      try {
        currentStats = fs.statSync(filePath)
      } catch (e) {
        logger.error(LogCategory.ANALYSIS_QUEUE, `[分析队列] 无法读取文件状态: ${filePath}`, e)
        this.updateItemStatus(item.id, 'failed', 0, '文件不可读或已移除')
        return
      }

      // 1. 获取工作空间归属：优先使用 item 携带的 ID，否则进行路径搜索
      let workspaceId = item.workspaceId;
      if (!workspaceId) {
        logger.debug(LogCategory.ANALYSIS_QUEUE, `[分析队列] 队列项未携带 workspaceId，尝试通过路径回捞: ${filePath}`)
        const rootDir = await databaseService.findRootWorkspaceDirectory(filePath);
        workspaceId = rootDir?.id;
      }

      if (!workspaceId) {
        logger.error(LogCategory.ANALYSIS_QUEUE, `[分析队列] 无法确定文件所属工作空间: ${filePath}`)
        this.updateItemStatus(item.id, 'failed', 0, '工作空间归属不明')
        return
      }

      const rootWorkspaceDir = await databaseService.getWorkspaceDirectoryById(workspaceId)
      const isPrivate = rootWorkspaceDir?.type === 'PRIVATE'
      
      logger.info(LogCategory.ANALYSIS_QUEUE, `[配额调试] 文件: ${filePath}, workspaceId: ${workspaceId}, 目录类型: ${rootWorkspaceDir?.type || 'unknown'}, isPrivate: ${isPrivate}`)

      if (isPrivate) {
        try {
          await invitationService.checkQuotaLimit()
        } catch (error: any) {
          logger.warn(LogCategory.ANALYSIS_QUEUE, `[配额限制] 文件无法分析：${filePath}`, error.message)
          this.updateItemStatus(item.id, 'failed', 0, error.message)
          this.pause() // 配额超限，立即暂停队列
          return
        }
      }

      const actualSize = currentStats.size
      if (actualSize === 0) {
        const fileName = item.name || path.basename(filePath) || '未知文件'
        logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 发现空文件，跳过AI分析: ${fileName}`)
        await this.handleEmptyFile(item, workspaceId)
        this.updateItemStatus(item.id, 'completed', 100)
        return
      }

      const language = ConfigOrchestrator.getInstance().getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN'

      // 获取现有物理文件记录 (V2.2 架构：通过 workspace_id + path 查询)
      // 修改：使用 LOWER(path) 增加鲁棒性，应对 Windows 路径大小写
      const existingWorkspaceFile = db.prepare(`
        SELECT wf.id, wf.file_fingerprint, wf.is_analyzed, wf.modified_at, f.size
        FROM workspace_files wf
        LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
        WHERE wf.workspace_id = ? AND wf.path = ?
      `).get(workspaceId, filePath) as any

      let fileFingerprint = existingWorkspaceFile?.file_fingerprint || '0'.repeat(32)
      const isLocallyAnalyzed = existingWorkspaceFile?.is_analyzed === 1

      logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 文件状态检查: ${item.name}`, { 
        isLocallyAnalyzed, 
        forceReanalyze: item.forceReanalyze,
        fileFingerprint: fileFingerprint.substring(0, 8) + '...'
      });

      const dbMtime = existingWorkspaceFile ? new Date(existingWorkspaceFile.modified_at).getTime() : 0
      const currentMtime = currentStats.mtime.getTime()
      const dbSize = existingWorkspaceFile?.size || 0
      const currentSize = currentStats.size

      const isTempHash = fileFingerprint.startsWith('temp_') || fileFingerprint === '0'.repeat(32)
      const metadataMismatched = dbMtime !== currentMtime || dbSize !== currentSize
      const needsNewHash = isTempHash || metadataMismatched || !existingWorkspaceFile

      if (needsNewHash) {
        logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 准备计算真实哈希: ${item.name}${isTempHash ? ' (替换临时ID)' : ''}${metadataMismatched ? ' (元数据已变动)' : ''}`)
        fileFingerprint = await calculateFileFingerprint(filePath)

        // 确保 files 表有记录（V2 架构：files 表只存储内容相关信息，不包含 name）
        db.prepare(`
          INSERT INTO files (
            file_fingerprint, smart_name, size, type, mime_type,
            created_at, modified_at, accessed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(file_fingerprint) DO UPDATE SET
            size = excluded.size,
            modified_at = excluded.modified_at,
            accessed_at = CURRENT_TIMESTAMP
        `).run(
          fileFingerprint, path.basename(filePath), currentStats.size, item.type || 'file',
          getMimeType(item.type || 'file'),
          new Date(currentStats.birthtime).toISOString(),
          new Date(currentStats.mtime).toISOString(),
          new Date(currentStats.atime).toISOString()
        )

        // 确保 workspace_files 表已更新指纹
        const dirPath = path.dirname(filePath);
        const directoryId = await databaseService.addDirectory(dirPath, workspaceId);

        db.prepare(`
          INSERT INTO workspace_files (
            file_fingerprint, workspace_id, directory_id, path, name,
            created_at, modified_at, accessed_at, is_analyzed
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, path) DO UPDATE SET
            file_fingerprint = excluded.file_fingerprint,
            modified_at = excluded.modified_at,
            accessed_at = CURRENT_TIMESTAMP
        `).run(
          fileFingerprint, workspaceId, directoryId, filePath, path.basename(filePath),
          new Date(currentStats.birthtime).toISOString(),
          new Date(currentStats.mtime).toISOString(),
          new Date(currentStats.atime).toISOString(),
          existingWorkspaceFile?.is_analyzed || 0
        )
        logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 已同步真实哈希至数据库: ${item.name}, Hash: ${fileFingerprint}`)
      }

      let cloudCachedData: any = null
      let isCloudCache = false

      if (!isPrivate) {
        this.updateItemStatus(item.id, 'analyzing', 5)

        // 移除跳过检查：允许用户对已分析且未变动的文件重新分析
        // 原逻辑：如果文件已分析且未变动，直接跳过
        // 新逻辑：不跳过，让用户可以对不满意的分析结果重新分析

        const canUseCache = !isLocallyAnalyzed || metadataMismatched
        // 只有文件已被本地分析过时，forceReanalyze 才会跳过缓存检查
        // 如果未分析过（isLocallyAnalyzed = false），即使 forceReanalyze = true，也应先检查云端缓存
        const shouldSkipCache = item.forceReanalyze === true && isLocallyAnalyzed

        logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 缓存决策: ${item.name}`, { 
          canUseCache, 
          shouldSkipCache, 
          isLocallyAnalyzed, 
          forceReanalyze: item.forceReanalyze 
        });

        if (shouldSkipCache) {
          logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 强制重新分析，跳过缓存检查: ${item.name}`)
        } else if (canUseCache) {
          logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 开始检查缓存: ${item.name}`)

          if (fileFingerprint && !fileFingerprint.startsWith('temp_') && fileFingerprint !== '0'.repeat(32)) {
            try {
              const localCachedFile = await databaseService.getAnalyzedFileByContentHash(fileFingerprint)
              if (localCachedFile) {
                logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 命中本地内容缓存: ${item.name}`)
                const tags = await databaseService.getFileTagsByFileId(fileFingerprint)
                cloudCachedData = { ...localCachedFile, tags }
              }
            } catch (localError) {
              logger.error(LogCategory.ANALYSIS_QUEUE, `[分析队列] 本地缓存检查失败: ${item.name}`, localError)
            }

            if (!cloudCachedData) {
              try {
                cloudCachedData = await cloudAnalysisService.checkCloudCache(fileFingerprint, language)
                if (cloudCachedData) {
                  logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 命中云端缓存: ${item.name}`)
                  isCloudCache = true
                }
              } catch (cloudError) {
                logger.error(LogCategory.ANALYSIS_QUEUE, `[分析队列] 云端缓存检查失败: ${item.name}`, cloudError)
              }
            }
          }
        }
      }

      if (cloudCachedData) {
        logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 应用缓存数据: ${item.name}`)
        this.updateItemStatus(item.id, 'analyzing', 50)
        
        try {
          await this.saveCloudResultToDB(item, fileFingerprint, cloudCachedData, isCloudCache, workspaceId)
          this.updateItemStatus(item.id, 'completed', 100, undefined, { fromCache: true })
          logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 项目分析完成 (缓存命中): ${item.name}`)
          timer.end('应用缓存数据')
          return
        } catch (saveError) {
          logger.error(LogCategory.ANALYSIS_QUEUE, `[分析队列] 保存缓存数据失败，降级为正常分析: ${item.name}`, saveError)
          cloudCachedData = null
        }
      }

      // ========== 第一阶段：文本提取 ==========
      timer.start('文本提取')
      // 优先使用 item.type（扩展名），如果为空则从路径提取
      const fileType = item.type || path.extname(filePath).toLowerCase() || ''
      const contentResult = await fileAnalysisService.process(filePath, fileType)
      timer.end('文本提取')

      // 构建更可靠的文件信息输入，确保大小不为0（除非文件确实为空）
      const fileInfo: FileInfoInput = {
        path: filePath,
        name: item.name,
        type: fileType,
        size: (contentResult.metadata?.fileSize !== undefined && contentResult.metadata?.fileSize > 0)
          ? contentResult.metadata.fileSize
          : (item.size || 0),
        content: contentResult.content,
        metadata: contentResult.metadata
      }

      logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 第一阶段处理完成: ${item.name}`, {
        hasContent: !!contentResult.content && contentResult.content.length > 0,
        contentLength: contentResult.content?.length || 0,
        fileSize: fileInfo.size,
        mimeType: contentResult.metadata?.mimeType
      })

      this.updateItemStatus(item.id, 'analyzing', 1)

      // 再次确保获得真实哈希
      if (!fileFingerprint || fileFingerprint.startsWith('temp_')) {
        fileFingerprint = await calculateFileFingerprint(filePath)
      }

      // V2.2 架构：使用 file_fingerprint 作为主键进行匹配
      const existingFile = db.prepare(`
        SELECT file_fingerprint FROM files
        WHERE file_fingerprint = ?
      `).get(fileFingerprint) as { file_fingerprint: string } | undefined
      
      if (!existingFile) {
        const stats = currentStats || fs.statSync(filePath)
        // V2 架构：使用新的表结构
        db.prepare(`INSERT OR IGNORE INTO files (file_fingerprint, smart_name, size, type, mime_type, created_at, modified_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          fileFingerprint, item.name, stats.size, fileType, getMimeType(fileType),
          new Date(stats.birthtime).toISOString(), new Date(stats.mtime).toISOString(), new Date(stats.atime).toISOString()
        )
        db.prepare(`INSERT OR IGNORE INTO file_contents (file_fingerprint, content, metadata) VALUES (?, ?, ?)`).run(
          fileFingerprint, contentResult.content || null, JSON.stringify(fileInfo.metadata)
        )
      }
      // 注意：existingFile 分支不需要在这里更新，后续会统一在所有分析阶段完成后更新

      // 【关键修复】如果 content 为空，尝试从数据库中再次加载（可能 Stage 1 已异步更新或已有旧内容）
      if (!fileInfo.content || fileInfo.content.length === 0) {
        try {
          const dbFile = await databaseService.getFileByPath(filePath);
          if (dbFile && dbFile.content) {
            fileInfo.content = dbFile.content;
            if (fileInfo.content) {
              logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 从数据库回捞内容成功: ${item.name}, 长度: ${fileInfo.content.length}`);
            }
          }
        } catch (dbError) {
          logger.warn(LogCategory.ANALYSIS_QUEUE, `[分析队列] 从数据库回捞内容失败: ${item.name}`, dbError);
        }
      }

      // ========== 第二阶段：缩略图生成 ==========
      timer.start('缩略图生成')
      let thumbnailRelativePath: string | undefined = undefined
      if (rootWorkspaceDir) {
        const thumbResult = await thumbnailService.generateThumbnail({ fileId: fileFingerprint, filePath: filePath, smartName: item.name, workspaceDirectoryPath: rootWorkspaceDir.path })
        if (thumbResult.success) thumbnailRelativePath = thumbResult.relativePath
      }
      timer.end('缩略图生成')
      this.updateItemStatus(item.id, 'analyzing', 2)

      // ========== 第三阶段：AI 文件质量分析 ==========
      timer.start('AI 文件质量分析')
      const processResult = this.fileProcessor
        ? await this.fileProcessor.processFileWithTimeout(
            fileFingerprint,
            fileInfo,
            thumbnailRelativePath ? path.join(rootWorkspaceDir!.path, thumbnailRelativePath) : undefined,
            this.errorRecoveryConfig.fileProcessingTimeout
          )
        : { content: contentResult.content, metadata: contentResult.metadata, qualityScore: 3, qualityConfidence: 0.5, multimodalContent: undefined, lrc: undefined, qualityReasoning: undefined, qualityCriteria: undefined }
      timer.end('AI 文件质量分析')

      // --- 歌词处理增强逻辑 ---
      const isAudio = fileType === 'audio' || isCategory(filePath || '', FileCategory.AUDIO);
      if (isAudio) {
        logger.info(LogCategory.ANALYSIS_QUEUE, `[歌词分析] 进入音频歌词处理流程: ${item.name}`, {
          type: fileType,
          hasMetadata: !!processResult.metadata,
          hasCommon: !!processResult.metadata?.common,
          hasLyrics: !!processResult.metadata?.common?.lyrics
        });

        const metadataLyrics = this.getFallbackLyrics(processResult.metadata);
        const aiLyrics = processResult.lrc || '';
        
        logger.info(LogCategory.ANALYSIS_QUEUE, `[歌词分析] 长度对比: ${item.name}`, {
          fromMetadata: metadataLyrics?.length || 0,
          fromAI: aiLyrics.trim().length
        });

        if (metadataLyrics) {
          if (!aiLyrics || aiLyrics.trim().length < metadataLyrics.trim().length) {
            logger.info(LogCategory.ANALYSIS_QUEUE, `[歌词分析] 匹配成功 -> 使用元数据歌词填充: ${item.name}, 长度: ${metadataLyrics.length}`);
            processResult.lrc = metadataLyrics;
          }
        } else {
          logger.info(LogCategory.ANALYSIS_QUEUE, `[歌词分析] 元数据中未找到任何有效歌词文本: ${item.name}`);
        }
      }

      this.updateItemStatus(item.id, 'analyzing', 51)
      const extractedContent = processResult.content || null
      const isReadable = isHumanReadable(extractedContent)
      const stats = currentStats || fs.statSync(filePath)

      // ========== 收集分析统计信息 ==========
      const initialStats = await this.collectAnalysisStats(timer)

      // 获取或创建 workspace_files 记录
      const dirPath = path.dirname(filePath);
      const directoryId = await databaseService.addDirectory(dirPath, workspaceId);
      
      // 确保 workspace_files 记录存在
      db.prepare(`
        INSERT INTO workspace_files (
          file_fingerprint, workspace_id, directory_id, path, name,
          created_at, modified_at, accessed_at, is_analyzed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, path) DO UPDATE SET
          file_fingerprint = excluded.file_fingerprint,
          modified_at = excluded.modified_at,
          accessed_at = CURRENT_TIMESTAMP
      `).run(
        fileFingerprint, workspaceId, directoryId, filePath, path.basename(filePath),
        new Date(stats.birthtime).toISOString(),
        new Date(stats.mtime).toISOString(),
        new Date(stats.atime).toISOString(),
        0
      )
      
      // 获取 workspace_files 的 id
      const workspaceFile = db.prepare(`
        SELECT id FROM workspace_files WHERE workspace_id = ? AND path = ?
      `).get(workspaceId, filePath) as any
      
      if (!workspaceFile) {
        throw new Error('无法获取文件路径记录')
      }

      // 使用结构化方法保存分析结果
      await databaseService.updateFileAnalysisResult(workspaceFile.id, {
        contentHash: fileFingerprint,
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
        accessedAt: stats.atime.toISOString(),
        content: (new TextFileProcessor().canProcess(item.name, fileType) || new DocumentFileProcessor().canProcess(item.name, fileType)) && isReadable ? extractedContent : null,
        multimodalContent: processResult.multimodalContent || null,
        lrc: processResult.lrc || null,
        // 【关键修复】确保质量评分字段被正确传递，避免被 COALESCE 覆盖
        qualityScore: processResult.qualityScore || null,
        qualityConfidence: processResult.qualityConfidence || null,
        qualityReasoning: processResult.qualityReasoning || null,
        qualityCriteria: processResult.qualityCriteria || null,
        thumbnailPath: thumbnailRelativePath || null,
        metadata: processResult.metadata,
        analysisStats: initialStats,
        isHit: false, // 实时分析，非缓存命中
        syncStatus: 0
      })

      if (!this.aiServiceAdapter || !this.fileDimensionService) throw new Error('AI 服务未就绪')

      // ========== 第四阶段：AI 目录分析 ==========
      timer.start('AI 目录分析')
      const directoryContext = await this.analyzeDirectoryContext(path.dirname(filePath))
      timer.end('AI 目录分析')
      this.updateItemStatus(item.id, 'analyzing', 67)

      const existingDimensions = await this.fileDimensionService.getDimensionsByLanguage(language as LanguageCode)

      // ========== 第五阶段：AI 标签维度分析 ==========
      timer.start('AI 标签维度分析')
      const dimResult = await this.dimensionAnalyzer.analyzeFileWithDimensions(filePath, item.name, fileType, fileInfo.size, extractedContent || '', processResult.multimodalContent, processResult.qualityScore || 3, processResult.metadata, existingDimensions, directoryContext)
      if (!dimResult) throw new Error('维度分析失败')

      await this.dimensionAnalyzer.saveDimensionAnalysisResults(fileFingerprint, filePath, dimResult)
      if (dimResult.newDimensions) await this.processNewDimensionSuggestions(dimResult.newDimensions, fileFingerprint)
      timer.end('AI 标签维度分析')
      this.updateItemStatus(item.id, 'analyzing', 98)

      // ========== 最终统计收集 ==========
      const analysisStats = await this.collectAnalysisStats(timer)
      
      // 更新最终统计信息到数据库
      await databaseService.updateFileAnalysisResult(workspaceFile.id, {
        analysisStats: analysisStats
      })

      // ========== 输出耗时汇总 ==========
      timer.printSummary()

      this.updateItemStatus(item.id, 'completed', 100, undefined, { analysisStats })
    } catch (error: any) {
      let errorMsg = error instanceof Error ? error.message : String(error)
      // 处理超时建议
      if (errorMsg.includes('timeout') || errorMsg.includes('超时')) {
        errorMsg += ` ${t('建议切换低显存需求的AI模型')}`
      }
      this.updateItemStatus(item.id, 'failed', 100, errorMsg)
    }
  }

  /**
   * 保存云端分析结果（或本地缓存结果）到数据库
   */
    private async saveCloudResultToDB(
    item: AnalysisQueueItem,
    fileFingerprint: string,
    data: any,
    isCloudCache: boolean,
    workspaceId: number
  ): Promise<void> {
    const db = databaseService.db
    if (!db) throw new Error('数据库未初始化')

    try {
      const filePath = (item as any).file_path || item.path;
      // 优先使用 item.type（扩展名），如果为空则从路径提取
      const fileType = item.type || path.extname(filePath).toLowerCase() || ''
      const stats = fs.statSync(filePath)

      let thumbnailRelativePath = null
      if (fileType && ['jpg', 'jpeg', 'png', 'webp', 'mp4', 'mov', 'avi', 'mkv', 'webm', 'pdf', 'pdfx'].includes(fileType.toLowerCase())) {
        try {
          const rootDir = await databaseService.findRootWorkspaceDirectory(filePath);
          if (rootDir && rootDir.path) {
            const thumbnailResult = await thumbnailService.generateThumbnail({ 
              fileId: fileFingerprint, 
              filePath: filePath, 
              smartName: item.name, 
              workspaceDirectoryPath: rootDir.path 
            })
            if (thumbnailResult && thumbnailResult.success) thumbnailRelativePath = thumbnailResult.relativePath
          }
        } catch (e) {
          logger.debug(LogCategory.ANALYSIS_QUEUE, '[分析队列] 保存云端结果时生成缩略图失败', e)
        }
      }

      const isHit = isCloudCache ? 1 : 0
      const lastHitAt = isHit ? new Date().toISOString() : null

      const smartName = data.smart_name || data.smartName || item.name
      const description = data.description || data.summary || null
      const content = data.content || data.textContent || null
      const multimodalContent = data.multimodal_content || data.multimodalContent || null
      const qualityScore = data.quality_score || data.qualityScore || null
      let analysisStats = data.analysis_stats || data.analysisStats || null
      
      // 尝试修复统计信息中的模型名称（特别是从云端缓存获取时）
      if (analysisStats) {
        try {
          const statsObj = typeof analysisStats === 'string' ? JSON.parse(analysisStats) : analysisStats
          if (statsObj && statsObj.model?.id && (!statsObj.model.name || statsObj.model.name === statsObj.model.id)) {
            const mode = statsObj.model.provider || 'local'
            statsObj.model.name = this.getModelName(statsObj.model.id, mode)
            analysisStats = statsObj
          }
        } catch (e) {
          // 忽略解析错误
        }
      }

      const tags = data.tags || []

      const fileData = {
        contentHash: fileFingerprint,
        smartName: smartName,
        size: stats.size,
        description: description,
        content: content,
        multimodalContent: multimodalContent,
        lrc: data.lrc || null,
        qualityScore: qualityScore,
        qualityConfidence: data.quality_confidence || data.qualityConfidence || null,
        qualityReasoning: data.quality_reasoning || data.qualityReasoning || null,
        qualityCriteria: typeof (data.quality_criteria || data.qualityCriteria) === 'string' 
          ? (data.quality_criteria || data.qualityCriteria) 
          : JSON.stringify(data.quality_criteria || data.qualityCriteria || {}),
        groupingReason: data.grouping_reason || data.groupingReason || null,
        groupingConfidence: data.grouping_confidence || data.groupingConfidence || null,
        author: data.author || null,
        language: data.language || null,
        analysisStats: typeof analysisStats === 'string' ? analysisStats : JSON.stringify(analysisStats || null),
        metadata: typeof data.metadata === 'string' ? data.metadata : JSON.stringify(data.metadata || {}),
        thumbnailPath: thumbnailRelativePath || null,
        isHit: isHit === 1,
        syncStatus: 2
      }

      // 确保目录记录存在（必须在事务外调用，因为是 async）
      const dirPath = path.dirname(filePath);
      const directoryId = await databaseService.addDirectory(dirPath, workspaceId);

      const runTransaction = db.transaction(() => {
        // 1. 插入或更新 files 基础表
        db.prepare(`
          INSERT INTO files (
            file_fingerprint, smart_name, description, size, type, mime_type,
            author, language, is_hit, last_hit_at, sync_status, 
            created_at, modified_at, accessed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(file_fingerprint) DO UPDATE SET
            smart_name = excluded.smart_name,
            description = excluded.description,
            author = excluded.author,
            language = excluded.language,
            is_hit = excluded.is_hit,
            last_hit_at = excluded.last_hit_at,
            sync_status = excluded.sync_status,
            modified_at = excluded.modified_at
        `).run(
          fileFingerprint, smartName, description, stats.size, fileType, getMimeType(fileType),
          data.author || null, data.language || null, isHit, lastHitAt, fileData.syncStatus,
          new Date(stats.birthtime).toISOString(), new Date(stats.mtime).toISOString(), new Date(stats.atime).toISOString()
        )

        // 2. 插入或更新 file_contents 大字段表
        db.prepare(`
          INSERT INTO file_contents (
            file_fingerprint, content, multimodal_content, lrc, metadata, analysis_stats,
            quality_score, quality_confidence, quality_reasoning, quality_criteria,
            grouping_reason, grouping_confidence
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(file_fingerprint) DO UPDATE SET
            content = excluded.content,
            multimodal_content = excluded.multimodal_content,
            metadata = excluded.metadata,
            quality_score = excluded.quality_score,
            quality_confidence = excluded.quality_confidence,
            quality_reasoning = excluded.quality_reasoning,
            quality_criteria = excluded.quality_criteria,
            grouping_reason = excluded.grouping_reason,
            grouping_confidence = excluded.grouping_confidence
        `).run(
          fileFingerprint, content, multimodalContent, data.lrc || null,
          fileData.metadata, fileData.analysisStats,
          qualityScore, fileData.qualityConfidence, fileData.qualityReasoning, fileData.qualityCriteria,
          fileData.groupingReason, fileData.groupingConfidence
        )

        // 3. 插入或更新 workspace_files 映射表
        db.prepare(`
          INSERT INTO workspace_files (
            file_fingerprint, workspace_id, directory_id,
            path, name, is_analyzed, last_analyzed_at,
            created_at, modified_at, accessed_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(workspace_id, path) DO UPDATE SET
            file_fingerprint = excluded.file_fingerprint,
            is_analyzed = 1,
            last_analyzed_at = CURRENT_TIMESTAMP
        `).run(
          fileFingerprint, workspaceId, directoryId,
          filePath, path.basename(filePath), 1, new Date().toISOString(),
          new Date(stats.birthtime).toISOString(), new Date(stats.mtime).toISOString(), new Date(stats.atime).toISOString()
        )

        if (data.tags && Array.isArray(data.tags)) {
          // 在插入新关系前，先根据最新的 file_fingerprint 清理旧的关系
          db.prepare('DELETE FROM file_tag_relations WHERE file_fingerprint = ?').run(fileFingerprint)

          for (const tag of data.tags) {
            if (tag.name) {
              try {
                // 云端维度ID
                const cloudDimId = tag.dimension_id
                let localDimId = 0

                // 1. 尝试在本地维度表中查找该维度ID（云端与本地维度ID保持一致）
                const dimRow = db.prepare('SELECT id FROM file_dimensions WHERE id = ?').get(cloudDimId) as { id: number } | undefined
                
                if (dimRow) {
                  // 本地存在该维度，直接使用
                  localDimId = dimRow.id
                } else {
                  // 本地维度表中找不到该维度ID，说明来自扩展维度
                  // 回退到内容标签维度ID 28
                  localDimId = 28
                  logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 扩展维度标签回退到内容标签: ${tag.name}, 云端维度ID: ${cloudDimId} -> 本地维度ID: 28`)
                }

                // 2. 检查标签是否已存在于本地
                let tagRow = db.prepare('SELECT id FROM file_tags WHERE name = ? AND dimension_id = ?').get(tag.name, localDimId) as { id: number } | undefined
                
                if (!tagRow) {
                  // 标签不存在，插入新标签
                  db.prepare(`INSERT INTO file_tags (name, dimension_id, sync_status, created_at) VALUES (?, ?, 0, CURRENT_TIMESTAMP)`).run(tag.name, localDimId)
                  tagRow = db.prepare('SELECT id FROM file_tags WHERE name = ? AND dimension_id = ?').get(tag.name, localDimId) as { id: number } | undefined
                  logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 从云端缓存插入新标签: ${tag.name}, 维度ID: ${localDimId}`)
                }
                
                if (tagRow) {
                  // 3. 建立文件-标签关系
                  db.prepare(`INSERT OR IGNORE INTO file_tag_relations (file_fingerprint, tag_id, sync_status) VALUES (?, ?, 0)`).run(fileFingerprint, tagRow.id)
                }
              } catch (tagError) {
                logger.error(LogCategory.ANALYSIS_QUEUE, `[分析队列] 保存单个标签失败: ${tag.name}`, tagError);
              }
            }
          }
        }
      })

      runTransaction()
      
      // 验证保存结果（通过路径查询）
      const verifyFile = db.prepare(`
        SELECT id, is_analyzed FROM workspace_files
        WHERE workspace_id = ? AND path = ?
      `).get(workspaceId, filePath) as { id: number; is_analyzed: number } | undefined
      logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 云端缓存结果保存完成，验证结果', {
        filePath: filePath,
        savedFileId: verifyFile?.id,
        isAnalyzed: verifyFile?.is_analyzed
      })
      
    } catch (error) {
      logger.error(LogCategory.ANALYSIS_QUEUE, '[AI分析] 保存云端结果失败:', error)
      throw error
    }
  }

  /**
   * 处理空文件：直接标记为已分析并跳过AI分析
   * 不同步到云端
   */
      private async handleEmptyFile(item: AnalysisQueueItem, workspaceId: number): Promise<void> {
    const db = databaseService.db
    if (!db) throw new Error('数据库未初始化')

    const filePath = (item as any).file_path || item.path;
    // 优先使用 item.type（扩展名），如果为空则从路径提取
    const fileType = item.type || path.extname(filePath).toLowerCase() || ''
    const fileName = item.name || path.basename(filePath) || '未知文件'
    const stats = fs.statSync(filePath)
    const emptyHash = '0'.repeat(32)

    // 确保目录记录存在
    const dirPath = path.dirname(filePath);
    const directoryId = await databaseService.addDirectory(dirPath, workspaceId);

    // 确保 files 和 workspace_files 表有记录
    db.prepare(`INSERT OR IGNORE INTO files (file_fingerprint, smart_name, size, type, mime_type, created_at, modified_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      emptyHash, fileName, 0, fileType, 'application/octet-stream',
      new Date(stats.birthtime).toISOString(), new Date(stats.mtime).toISOString(), new Date(stats.atime).toISOString()
    )
    db.prepare(`INSERT OR IGNORE INTO workspace_files (file_fingerprint, workspace_id, directory_id, path, name, created_at, modified_at, accessed_at, is_analyzed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      emptyHash, workspaceId, directoryId, filePath, fileName,
      new Date(stats.birthtime).toISOString(), new Date(stats.mtime).toISOString(), new Date(stats.atime).toISOString(), 0
    )

    // 获取插入后的 workspace_files ID
    const wf = db.prepare(`SELECT id FROM workspace_files WHERE workspace_id = ? AND path = ?`).get(workspaceId, filePath) as any;
    await databaseService.updateFileAnalysisResult(wf?.id || 0, {
      contentHash: emptyHash,
      size: 0,
      modifiedAt: stats.mtime.toISOString(),
      accessedAt: stats.atime.toISOString(),
      smartName: fileName,
      description: '空文件',
      content: '',
      multimodalContent: null,
      lrc: null,
      qualityScore: 1,
      qualityConfidence: 1,
      qualityReasoning: '文件大小为0',
      qualityCriteria: {},
      groupingReason: null,
      groupingConfidence: null,
      author: null,
      language: null,
      metadata: {},
      thumbnailPath: null,
      analysisStats: { durationMs: 0 },
      isHit: false,
      syncStatus: 0
    })

    // 额外为它打上空文件标签
    const emptyTagLabel = '空文件'
    try {
      db.transaction(() => {
        let localDimId = 0
        const dimRow = db.prepare("SELECT id FROM file_dimensions WHERE name = '基础属性' OR id = 1").get() as any
        if (dimRow) localDimId = dimRow.id

        if (localDimId) {
          db.prepare(`INSERT OR IGNORE INTO file_tags (name, dimension_id, sync_status, created_at) VALUES (?, ?, 2, CURRENT_TIMESTAMP)`).run(emptyTagLabel, localDimId)
          const tagRow = db.prepare('SELECT id FROM file_tags WHERE name = ? AND dimension_id = ?').get(emptyTagLabel, localDimId) as any
          if (tagRow) {
            db.prepare(`INSERT OR IGNORE INTO file_tag_relations (file_fingerprint, tag_id, sync_status) VALUES (?, ?, 2)`).run(emptyHash, tagRow.id)
          }
        }
      })()
    } catch (e) {
      logger.error(LogCategory.ANALYSIS_QUEUE, `[分析队列] 为空文件添加标签失败: ${emptyTagLabel}`, e)
    }

    logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 空文件处理完成并已打标签: ${item.name}`)
  }

  private async processNewDimensionSuggestions(suggestions: DimensionExpansion[], fileFingerprint: string): Promise<void> {
    if (!this.fileDimensionService) return
    for (const suggestion of suggestions) {
      try {
        const expansionId = await this.fileDimensionService.saveDimensionExpansion({ ...suggestion, triggerFileId: fileFingerprint as any })
        await this.fileDimensionService.approveDimensionExpansion(expansionId)
      } catch (error) { }
    }
  }

  private async updateVirtualDirectoriesAfterQueueCompletion(): Promise<void> {
    try {
      const db = databaseService.db
      if (!db) return
      const directoriesWithVirtualDirs = db.prepare(`SELECT DISTINCT md.path FROM workspaces md INNER JOIN virtual_directories vd ON vd.workspace_id = md.workspace_id`).all() as Array<{ path: string }>
      if (!directoriesWithVirtualDirs || directoriesWithVirtualDirs.length === 0) return
      const { VirtualDirectoryService } = await import('../filesystem/virtual-directory-service')
      for (const directory of directoriesWithVirtualDirs) {
        try {
          await new VirtualDirectoryService(db).updateAllVirtualDirectories(directory.path)
        } catch (error) { }
      }
    } catch (error) { }
  }

  /**
   * 从元数据中提取候选歌词
   */
  private getFallbackLyrics(metadata: any): string | null {
    if (!metadata) {
      logger.info(LogCategory.ANALYSIS_QUEUE, `[歌词分析] getFallbackLyrics: metadata 为空`);
      return null;
    }

    // 探测路径 1: metadata.common.lyrics (music-metadata 标准)
    // 探测路径 2: metadata.lyrics (某些处理器的扁平化输出)
    let lyricsData = metadata.common?.lyrics || metadata.lyrics;

    if (!lyricsData) {
      logger.info(LogCategory.ANALYSIS_QUEUE, `[歌词分析] getFallbackLyrics: 未在 metadata 中找到 lyrics 字段`);
      return null;
    }

    // 处理字符串格式
    if (typeof lyricsData === 'string' && lyricsData.trim().length > 0) {
      logger.info(LogCategory.ANALYSIS_QUEUE, `[歌词分析] 找到字符串格式歌词，准备萃取...`);
      return this.extractPureLyrics(lyricsData);
    }

    // 处理数组格式
    if (Array.isArray(lyricsData) && lyricsData.length > 0) {
      for (const item of lyricsData) {
        // music-metadata 格式是 [{ text: '...' }]
        const text = typeof item === 'string' ? item : item?.text;
        if (text) {
          logger.info(LogCategory.ANALYSIS_QUEUE, `[歌词分析] 从数组中找到原始歌词文本，准备萃取...`);
          return this.extractPureLyrics(text);
        }
      }
    }

    logger.info(LogCategory.ANALYSIS_QUEUE, `[歌词分析] getFallbackLyrics: 歌词字段存在但格式不符合预期`, { 
      type: typeof lyricsData, 
      isArray: Array.isArray(lyricsData) 
    });
    return null;
  }

  /**
   * 萃取纯文本歌词：移除时间轴 [00:00.00] 和 标签 [ti:xxx]
   */
  private extractPureLyrics(text: string): string {
    if (!text) return '';

    logger.info(LogCategory.ANALYSIS_QUEUE, `[歌词分析] 萃取前样例: ${text.substring(0, 50).replace(/\n/g, ' ')}...`);

    const result = text
      // 移除 [00:00.00] 或 [00:00:00] 或 [00:00] 类型的时间轴，支持多个时间轴并列
      .replace(/\[\d{1,2}:\d{2}([:\.]\d{1,3})?\]/g, '')
      // 移除带有标签名的元数据标签，如 [ti:Title], [ar:Artist], [al:Album], [by:Person], [offset:0], [total:0] 等
      // 支持类似 [kuwo:xxxx] 这种非标准标签
      .replace(/\[[a-z0-9]{1,10}:.*\]/gi, '')
      // 移除空的方括号内容（如果前面替换留下了残余）
      .replace(/\[\s*\]/g, '')
      // 移除多余的空行，但保留原有的分行
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n');

    logger.info(LogCategory.ANALYSIS_QUEUE, `[歌词分析] 萃取后样例: ${result.substring(0, 50).replace(/\n/g, ' ')}...`);
    return result;
  }

  /**
   * 收集分析统计信息
   */
  private async collectAnalysisStats(timer: PerformanceTimer): Promise<AnalysisStats> {
    try {
      const hardware = await hardwareDetectionService.detectSystemResources()
      const mode = ConfigOrchestrator.getInstance().getValue<string>('AI_SERVICE_MODE')
      const modelId = ConfigOrchestrator.getInstance().getValue<string>(mode === 'cloud' ? 'AI_CLOUD_SELECTED_MODEL_ID' : 'SELECTED_MODEL_ID')
      
      // 获取模型名称
      const modelName = this.getModelName(modelId || '', mode || 'local')

      // 获取 GPU 名称和显存
      const gpuInfo = hardware.gpus && hardware.gpus.length > 0 ? hardware.gpus[0] : null
      
      return {
        durationMs: timer.getTotalDuration(),
        phases: timer.getPhases(),
        model: {
          id: modelId || 'unknown',
          name: modelName,
          provider: mode || 'local'
        },
        hardware: {
          gpu: gpuInfo?.name,
          vram: gpuInfo?.memory ? Math.round(gpuInfo.memory / 1024 * 100) / 100 : undefined,
          platform: process.platform
        }
      }
    } catch (error) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析统计] 收集统计信息失败:', error)
      return {
        durationMs: timer.getTotalDuration(),
        phases: timer.getPhases(),
        model: { id: 'unknown', name: 'unknown', provider: 'unknown' },
        hardware: { platform: process.platform }
      }
    }
  }

  /**
   * 获取模型的友好显示名称
   */
  private getModelName(modelId: string, mode: string): string {
    if (!modelId || modelId === 'unknown') return 'unknown';

    try {
      // 1. 如果是云端模式，优先查找云端配置
      if (mode === 'cloud') {
        const providers = ConfigOrchestrator.getInstance().getValue<any[]>('CLOUD_MODEL_CONFIGS') || [];
        const provider = providers.find(p => p.id === modelId || p.provider === modelId);
        if (provider) {
          const subModel = provider.model;
          return subModel ? `${subModel} (${provider.name || provider.provider})` : (provider.name || provider.provider);
        }
      }

      // 2. 尝试从本地/Ollama 统一模型管理器中查找友好名称（作为后备或首选）
      unifiedModelManager.ensureLoaded();
      const allModels = unifiedModelManager.getAllModels();
      const model = allModels.find(m => m.id === modelId || m.name === modelId);
      if (model && model.name) return model.name;

    } catch (e) {
      logger.debug(LogCategory.ANALYSIS_QUEUE, '[分析统计] 获取模型名称失败:', e);
    }

    // 3. 最后的兜底逻辑：如果没找到友好名称，尝试对 ID 进行简单处理（移除 HF 组织名前缀等）
    if (modelId.length > 30) {
      // 处理 HuggingFace 格式: org/repo:file
      if (modelId.includes('/') && modelId.includes(':')) {
        const parts = modelId.split(':');
        const repoPath = parts[0];
        const repoName = repoPath.split('/').pop();
        if (repoName && repoName.length > 5) {
          return repoName;
        }
      }
      // 处理 Ollama 格式: repo:tag
      else if (modelId.includes(':')) {
        return modelId.split(':')[0];
      }
    }

    return modelId;
  }
}

export const analysisQueueService = new AnalysisQueueService()
export default analysisQueueService
