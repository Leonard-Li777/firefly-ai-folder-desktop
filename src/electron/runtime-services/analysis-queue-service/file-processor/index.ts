import {
  AnalysisQueueItem,
  DimensionExpansion,
  LanguageCode,
  FileCategory as MagikaCategory,
  MarkitdownBenchmark
} from '@firefly/types'
import {
  LogCategory,
  logger,
  PerformanceTimer,
  FileCategory,
  getFileCategory,
  isCategory,
  saveAuthorTagsFromMetadata,
  saveLanguageTagsFromMetadata,
  saveMagikaGroupTag,
  saveExtensionTags,
  saveMagikaIsTextTag,
  getMagikaGroupFromExtension,
  BROWSER_NATIVE_IMAGE_EXTS,
  isTestEnvironment,
  applyMarkitdownBenchmark,
  extractMarkitdownBenchmark,
  calculateFileFingerprint,
  cleanSmartName
} from '@firefly/shared'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'
import { databaseService } from '../../database/database-service'
import { quotaChecker } from '../../user-tier/quota-checker-proxy'
import { magikaService } from '../../system/magika-service'
import {
  fileAnalysisService,
  getMimeType,
  FileProcessorService,
  DimensionAnalyzer,
  FileDimensionService,
  TextFileProcessor,
  MarkitdownProcessor,
  extractPureLyrics,
  metadataExtractionService,
  type FileInfoInput
} from '@firefly/core-engine'
import { thumbnailService } from '../../filesystem/thumbnail-service'
import { markitdownServerManager } from '../../system/markitdown-server-manager'
import { anydocService, AnydocAsset } from '../../system/anydoc-service'
import { cloudAnalysisService } from '@firefly/server'
import { IErrorRecoveryConfig } from '../types'
import { t } from '@app/languages'
import fs from 'node:fs'
import path from 'node:path'

import { saveCloudResult } from './save-cloud-result'
import { handleEmptyFile } from './handle-empty-file'
import { processLocalAnalysis } from './process-local-analysis'
import { saveLocalAnalysisResult } from './save-local-cache-result'

/**
 * @firecrawl/anydoc 支持的文档格式扩展名（小写）
 * 参考 anydoc 文档：Word / PowerPoint / Excel / OpenDocument / RTF / EPUB / CSV / PDF
 * 其它类型（如 .lnk 快捷方式、应用、音视频、压缩包等）anydoc 不支持，
 * 直接跳过 anydoc 提取，避免无效调用与 unsupported 报错
 */
const ANYDOC_SUPPORTED_EXTS = new Set([
  '.doc',
  '.docx',
  '.docm',
  '.ppt',
  '.pps',
  '.pot',
  '.pptx',
  '.pptm',
  '.ppsx',
  '.ppsm',
  '.xls',
  '.xlsx',
  '.xlsm',
  '.xlsb',
  '.odt',
  '.ods',
  '.odp',
  '.rtf',
  '.epub',
  '.csv',
  '.pdf'
])

export function getFileStageFromDB(db: any, workspaceId: number, filePath: string): number {
  try {
    const row = db
      .prepare(
        `
        SELECT fc.analysis_stats
        FROM workspace_files wf
        JOIN files f ON wf.file_fingerprint = f.file_fingerprint
        LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
        WHERE wf.workspace_id = ? AND wf.path = ?
      `
      )
      .get(workspaceId, filePath) as { analysis_stats?: string } | undefined

    if (row?.analysis_stats) {
      const stats = JSON.parse(row.analysis_stats)
      if (stats && typeof stats === 'object' && stats.analysis_stage !== undefined) {
        return Number(stats.analysis_stage)
      }
    }
  } catch (e) {
    logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] 获取 file stage 失败:', e)
  }
  return 0
}

/**
 * 获取文件的分析阶段 stage 以及是否已完成过分析（is_analyzed）
 * 用于判断重新分析时是否真正复用已有提取数据：
 * - is_analyzed = true：文件之前已完成分析，复用关闭时须重新提取
 * - is_analyzed = false：文件尚未分析完成（如刚做完 stage1/2 后暂停），已有数据有效，可复用
 */
export function getFileAnalysisStateFromDB(
  db: any,
  workspaceId: number,
  filePath: string
): { stage: number; isAnalyzed: boolean } {
  try {
    const row = db
      .prepare(
        `
        SELECT wf.is_analyzed, fc.analysis_stats
        FROM workspace_files wf
        JOIN files f ON wf.file_fingerprint = f.file_fingerprint
        LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
        WHERE wf.workspace_id = ? AND wf.path = ?
      `
      )
      .get(workspaceId, filePath) as { is_analyzed?: number; analysis_stats?: string } | undefined

    let stage = 0
    if (row?.analysis_stats) {
      try {
        const stats = JSON.parse(row.analysis_stats)
        if (stats && typeof stats === 'object' && stats.analysis_stage !== undefined) {
          stage = Number(stats.analysis_stage)
        }
      } catch {
        // 忽略解析错误，stage 保持 0
      }
    }
    return { stage, isAnalyzed: row?.is_analyzed === 1 }
  } catch (e) {
    logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] 获取文件分析状态失败:', e)
  }
  return { stage: 0, isAnalyzed: false }
}

/**
 * 文件处理类
 * 处理单个文件的分析、缓存匹配和落库
 */
export class FileProcessor {
  private mockData: any = null
  private selectWorkspaceFileStmt: any = null
  private insertFileStmt: any = null
  private insertWorkspaceFileStmt: any = null
  private deleteTagRelationsStmt: any = null
  /** 已缓存语句所绑定的数据库连接；语言切换会重建数据库，连接变化时必须重新 prepare */
  private currentDb: any = null

  private initStatements(db: any) {
    // 关键修复：仅当连接未变化时才复用缓存语句。语言切换（数据库重建）后
    // databaseService.db 指向新的连接，必须重新 prepare，否则旧连接上的
    // prepared statement 会抛出 "The database connection is not open"
    if (this.currentDb === db) return
    this.currentDb = db
    this.selectWorkspaceFileStmt = db.prepare(`
      SELECT wf.id, wf.file_fingerprint, wf.is_analyzed, wf.modified_at, f.size
      FROM workspace_files wf
      LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
      WHERE wf.workspace_id = ? AND wf.path = ?
    `)
    this.insertFileStmt = db.prepare(`
      INSERT INTO files (
        file_fingerprint, smart_name, size, type, category,
        created_at, modified_at, accessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_fingerprint) DO UPDATE SET
        size = excluded.size,
        type = excluded.type,
        smart_name = excluded.smart_name,
        category = excluded.category,
        modified_at = excluded.modified_at,
        accessed_at = ?
    `)
    this.insertWorkspaceFileStmt = db.prepare(`
      INSERT INTO workspace_files (
        file_fingerprint, workspace_id, directory_id, path, name,
        created_at, modified_at, accessed_at, is_analyzed, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(workspace_id, path) DO UPDATE SET
        file_fingerprint = excluded.file_fingerprint,
        is_analyzed = excluded.is_analyzed,
        modified_at = excluded.modified_at,
        status = 1,
        accessed_at = ?
    `)
    this.deleteTagRelationsStmt = db.prepare(
      'DELETE FROM file_tag_relations WHERE file_fingerprint = ?'
    )
  }

  constructor(
    private getDependencies: () => {
      fileProcessor: FileProcessorService | undefined
      dimensionAnalyzer: DimensionAnalyzer | undefined
      fileDimensionService: FileDimensionService | undefined
      errorRecoveryConfig: IErrorRecoveryConfig
    },
    private updateItemStatus: (
      itemId: number,
      status: any,
      progress: number,
      error?: string,
      extra?: any
    ) => void,
    private pause: () => void,
    private collectAnalysisStats: (timer: PerformanceTimer) => Promise<any>,
    private getModelName: (modelId: string, mode: string) => string,
    private analyzeDirectoryContext: (
      directoryPath: string,
      force?: boolean,
      cacheOnly?: boolean
    ) => Promise<any>,
    private processNewDimensionSuggestions: (
      suggestions: DimensionExpansion[],
      fileFingerprint: string
    ) => Promise<void>
  ) {}

  /**
   * 获取数据库中已存在的基础信息
   */
  private getExistingBasicData(
    db: any,
    fingerprint: string,
    workspaceId: number,
    filePath: string
  ): {
    category?: any
    thumbnailPath?: string
    metadata?: any
    content?: string
  } {
    const result: {
      category?: any
      thumbnailPath?: string
      metadata?: any
      content?: string
    } = {}

    try {
      // 1. 获取 category (files 表)
      const fileRow = db
        .prepare('SELECT category FROM files WHERE file_fingerprint = ?')
        .get(fingerprint) as { category?: string } | undefined

      if (fileRow?.category) {
        try {
          result.category = JSON.parse(fileRow.category)
        } catch (e) {
          logger.warn(
            LogCategory.ANALYSIS_QUEUE,
            `[复用数据] 解析 category JSON 失败: ${fingerprint}`
          )
        }
      }

      // 2. 获取 thumbnailPath (workspace_files 表)
      const wsFileRow = db
        .prepare(
          'SELECT thumbnail_path FROM workspace_files WHERE workspace_id = ? AND path = ? AND file_fingerprint = ?'
        )
        .get(workspaceId, filePath, fingerprint) as { thumbnail_path?: string } | undefined

      if (wsFileRow?.thumbnail_path) {
        result.thumbnailPath = wsFileRow.thumbnail_path
      }

      // 3. 获取 metadata 和 content (file_contents 表)
      const contentRow = db
        .prepare('SELECT metadata, content FROM file_contents WHERE file_fingerprint = ?')
        .get(fingerprint) as { metadata?: string; content?: string } | undefined

      if (contentRow) {
        if (contentRow.metadata) {
          try {
            result.metadata = JSON.parse(contentRow.metadata)
          } catch (e) {
            logger.warn(
              LogCategory.ANALYSIS_QUEUE,
              `[复用数据] 解析 metadata JSON 失败: ${fingerprint}`
            )
          }
        }
        if (contentRow.content) {
          result.content = contentRow.content
        }
      }
    } catch (error) {
      logger.error(LogCategory.ANALYSIS_QUEUE, `[复用数据] 查询数据库失败: ${fingerprint}`, error)
    }

    return result
  }

  /**
   * 复用基础数据时，过滤数据库中已存在的提取指标，只保留确实缺失的指标。
   * 用于让 Markitdown Server 实现按需提取，避免重复提取已有数据。
   *
   * 指标与基础数据的对应关系：
   * - document / text / ocr：内容（OCR 结果落库时已合并进 content 保存）
   * - metadata：元数据（file_contents.metadata）
   * - magika：Magika 分类（files.category 或已恢复的 magikaCategory）
   * - thumbnail：缩略图（workspace_files.thumbnail_path）
   *
   * @param indicators 期望提取的指标列表
   * @param existingBasicData 数据库中已存在的基础数据
   * @param magikaCategory 已恢复的 Magika 分类（可能为 null）
   * @returns 需要请求 Markitdown Server 的缺失指标列表
   */
  private filterMissingIndicators(
    indicators: string[],
    existingBasicData: {
      category?: any
      thumbnailPath?: string
      metadata?: any
      content?: string
    },
    magikaCategory: MagikaCategory | null
  ): string[] {
    return indicators.filter(indicator => {
      switch (indicator) {
        case 'document':
        case 'text':
        case 'ocr':
          // 内容已存在（OCR 结果在落库时已合并进 content）
          return !existingBasicData.content
        case 'metadata':
          return !existingBasicData.metadata
        case 'magika':
          return !magikaCategory && !existingBasicData.category
        case 'thumbnail':
          return !existingBasicData.thumbnailPath
        default:
          return true
      }
    })
  }

  /**
   * 处理文件项
   */
  async processFile(
    item: AnalysisQueueItem,
    signal?: AbortSignal,
    phase: 'cpu' | 'gpu' | 'all' = 'all',
    cpuSkipped = false
  ): Promise<void> {
    const deps = this.getDependencies()
    try {
      // V2.2 架构：优先从 item.path 获取，如果存在则通过 item_id 查询数据库
      let filePath = (item as any).file_path || item.path
      const itemId = (item as any).item_id
      const itemType = (item as any).item_type || 'file'

      // 如果没有 filePath 但有 item_id，根据类型从对应表查询真实路径
      if (!filePath && itemId) {
        const db = databaseService.db
        if (db) {
          let wf: any = null
          if (itemType === 'directory') {
            wf = db
              .prepare(`SELECT path FROM workspace_directories WHERE id = ?`)
              .get(itemId) as any
          } else {
            wf = db.prepare(`SELECT path FROM workspace_files WHERE id = ?`).get(itemId) as any
          }
          if (wf && wf.path) {
            filePath = wf.path
          }
        }
      }

      // 如果仍然没有 filePath，报错
      if (!filePath) {
        logger.error(LogCategory.ANALYSIS_QUEUE, `[分析队列] 无法获取文件路径: ${item.id}`)
        this.updateItemStatus(item.id, 'failed', 0, '文件路径丢失')
        return
      }

      // 1. 获取工作空间归属：优先使用 item 携带的 ID，否则进行路径搜索
      let currentWorkspaceId = item.workspaceId
      if (!currentWorkspaceId) {
        logger.debug(
          LogCategory.ANALYSIS_QUEUE,
          `[分析队列] 队列项未携带 workspaceId，尝试通过路径回捞: ${filePath}`
        )
        const rootDir = await databaseService.findRootWorkspaceDirectory(filePath)
        currentWorkspaceId = rootDir?.id
      }

      if (!currentWorkspaceId) {
        logger.error(LogCategory.ANALYSIS_QUEUE, `[分析队列] 无法确定文件所属工作空间: ${filePath}`)
        this.updateItemStatus(item.id, 'failed', 0, '工作空间归属不明')
        return
      }

      // ========== 测试模式拦截器 ==========
      // 检查特定的 Mock JSON 文件是否存在作为测试环境的唯一标识
      const mockJsonPath = process.env.TEST_MOCK_JSON_PATH
      if (mockJsonPath && fs.existsSync(mockJsonPath)) {
        const handled = await this.applyMockResult(item.id, filePath, currentWorkspaceId)
        if (handled) {
          logger.info(LogCategory.ANALYSIS_QUEUE, `[测试模式] 拦截器已处理完成: ${item.name}`)
          return
        }
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          `[测试模式] 拦截器未能从模拟库找到结果: ${item.name}`
        )
        // 测试模式下未命中 mock 也直接标记为完成，避免因缺少真实 AI 服务导致队列卡死
        const isTest = isTestEnvironment()
        if (isTest) {
          logger.info(
            LogCategory.ANALYSIS_QUEUE,
            `[测试模式] 文件不在 mock 库中，标记为已跳过: ${item.name}`
          )
          this.updateItemStatus(item.id, 'completed', 100)
          return
        }
      }

      const timer = new PerformanceTimer(filePath)
      const db = databaseService.db
      if (!db) {
        logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 数据库连接不可用')
        this.updateItemStatus(item.id, 'failed', 0, '数据库未初始化')
        return
      }
      this.initStatements(db)

      const reuseBasicAnalysisData =
        ConfigOrchestrator.getInstance().getValue<boolean>('REUSE_BASIC_ANALYSIS_DATA') ?? true
      const initialStage = db ? getFileStageFromDB(db, currentWorkspaceId, filePath) : 0

      // 提前读取分析模式配置（带保护，后续 CPU/GPU/AI 分支均需使用）
      let analysisMode = 'full'
      try {
        analysisMode = ConfigOrchestrator.getInstance().getValue<string>('ANALYSIS_MODE') ?? 'full'
      } catch {
        logger.debug(LogCategory.ANALYSIS_QUEUE, '[分析队列] 读取分析模式配置失败')
      }

      if (phase === 'all') {
        // 串行分支与并行分支保持一致：只要文件已处于 Stage >= 2（CPU 提取已完成）即跳过 CPU 阶段，
        // 除非“强制重新分析 + 复用关闭 + 之前已分析完成（is_analyzed=true）”才必须重新提取
        let alreadyAnalyzed = false
        try {
          const wfRow = db
            .prepare(`SELECT is_analyzed FROM workspace_files WHERE workspace_id = ? AND path = ?`)
            .get(currentWorkspaceId, filePath) as { is_analyzed?: number } | undefined
          alreadyAnalyzed = wfRow?.is_analyzed === 1
        } catch {
          // 忽略查询异常，视为未完成过分析
        }
        const forcedReextract =
          item.forceReanalyze === true && !reuseBasicAnalysisData && alreadyAnalyzed
        if (initialStage >= 2 && !forcedReextract) {
          if (analysisMode === 'full') {
            // full 模式：跳过 CPU 提取，直接进入 GPU AI 阶段（stage3/4）
            logger.info(
              LogCategory.ANALYSIS_QUEUE,
              `[串行队列] 文件已处于 Stage ${initialStage} >= 2，跳过 CPU 提取，直接进入 GPU AI 阶段: ${item.name}`
            )
            return this.processFile(item, signal, 'gpu', true)
          }
          // 非 full 模式（simple/document）不执行 AI 阶段（stage3/4），
          // 继续走 CPU 提取流程，复用已有数据后在基础分析分支完成
          logger.info(
            LogCategory.ANALYSIS_QUEUE,
            `[串行队列] 文件已处于 Stage ${initialStage} >= 2，非 full 模式（${analysisMode}）跳过 AI 阶段: ${item.name}`
          )
        }
      }

      let currentStats: fs.Stats | null = null
      try {
        currentStats = fs.statSync(filePath)
      } catch (e) {
        logger.error(LogCategory.ANALYSIS_QUEUE, `[分析队列] 无法读取文件状态: ${filePath}`, e)
        this.updateItemStatus(item.id, 'failed', 0, '文件不可读或已移除')
        return
      }

      const rootWorkspaceDir = await databaseService.getWorkspaceDirectoryById(currentWorkspaceId)
      if (!rootWorkspaceDir) {
        throw new Error(`工作区目录未找到: id=${currentWorkspaceId}`)
      }
      const isPrivate = rootWorkspaceDir.type === 'PRIVATE'
      const isSpeedy = rootWorkspaceDir?.type === 'SPEEDY'

      logger.info(
        LogCategory.ANALYSIS_QUEUE,
        `[配额调试] 文件: ${filePath}, workspaceId: ${currentWorkspaceId}, 目录类型: ${rootWorkspaceDir?.type || 'unknown'}, isPrivate: ${isPrivate}`
      )

      if (isPrivate) {
        try {
          const result = await quotaChecker.check('analyze_file', 1)
          if (!result.allowed) {
            throw new Error(
              t(
                '配额已用尽：已分析 {count} 个私有目录文件，当前配额为 {quota} 个文件。可以通过邀请好友解锁更多额度。',
                { count: result.current, quota: result.limit }
              )
            )
          }
        } catch (error: any) {
          logger.warn(
            LogCategory.ANALYSIS_QUEUE,
            `[配额限制] 文件无法分析：${filePath}`,
            error.message
          )
          this.updateItemStatus(item.id, 'failed', 0, error.message)
          this.pause() // 配额超限，立即暂停队列
          return
        }
      }

      const actualSize = currentStats.size
      if (actualSize === 0) {
        const fileName = item.name || path.basename(filePath) || '未知文件'
        logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 发现空文件，跳过AI分析: ${fileName}`)
        await this.handleEmptyFile(item, currentWorkspaceId)
        this.updateItemStatus(item.id, 'completed', 100)
        return
      }

      const language =
        ConfigOrchestrator.getInstance().getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN'

      if (phase === 'gpu') {
        // simple/document 模式不执行 AI 阶段（stage3/4），
        // 该防御覆盖并行流水线运行中切换分析模式后 GPU 消费者继续处理文件的情况
        if (analysisMode !== 'full') {
          logger.info(
            LogCategory.ANALYSIS_QUEUE,
            `[分析队列] 非 full 模式（${analysisMode}）跳过 GPU AI 阶段: ${item.name}`
          )
          this.updateItemStatus(item.id, 'completed', 100)
          return
        }

        const existingWorkspaceFile = this.selectWorkspaceFileStmt.get(
          currentWorkspaceId,
          filePath
        ) as any
        const fileFingerprint = existingWorkspaceFile?.file_fingerprint
        if (!fileFingerprint) {
          throw new Error('GPU phase started but file has no fingerprint in DB')
        }

        // 重新分析时清空原有标签：GPU 分支可能由串行队列在 initialStage >= 2 时直接进入，
        // 会跳过 CPU 阶段的标签清理（deleteTagRelationsStmt），此处补齐以确保重新分析不残留旧标签
        this.deleteTagRelationsStmt.run(fileFingerprint)

        const existingBasicData = this.getExistingBasicData(
          db,
          fileFingerprint,
          currentWorkspaceId,
          filePath
        )
        const enhancedInfo = this.getEnhancedFileInfo(
          item.name,
          item.type,
          filePath,
          existingBasicData.category || null
        )

        const fileInfo: FileInfoInput = {
          path: filePath,
          name: enhancedInfo.smartName,
          type: enhancedInfo.fileType,
          size: currentStats.size,
          content: existingBasicData.content || '',
          metadata: existingBasicData.metadata || {}
        }

        const thumbnailRelativePath = existingBasicData.thumbnailPath || undefined

        // 现在运行 GPU 本地 AI 质量分析与标签维度
        this.updateItemStatus(item.id, 'analyzing', 51, undefined, { analysisStage: 3 })

        let directoryContext: any = null
        try {
          const parentDir = path.dirname(filePath)
          directoryContext = await this.analyzeDirectoryContext(parentDir, false)
        } catch (dirCtxError) {
          logger.warn(
            LogCategory.ANALYSIS_QUEUE,
            `[目录上下文] GPU阶段预获取目录上下文失败: ${filePath}`,
            dirCtxError
          )
        }

        if (!deps.dimensionAnalyzer || !deps.fileDimensionService) throw new Error('AI 服务未就绪')

        const { processResult, dimResult } = await processLocalAnalysis(
          item,
          fileFingerprint,
          fileInfo,
          thumbnailRelativePath,
          rootWorkspaceDir.path,
          timer,
          deps,
          {
            language,
            directoryContext,
            magikaCategory: existingBasicData.category || null,
            isSpeedy,
            initialStage,
            forceReanalyze: item.forceReanalyze === true
          },
          this.updateItemStatus.bind(this),
          this.processNewDimensionSuggestions.bind(this)
        )

        this.updateItemStatus(item.id, 'analyzing', 98)

        // 保存本地分析结果
        const { workspaceFile } = await saveLocalAnalysisResult(
          item,
          fileFingerprint,
          processResult,
          existingBasicData.category || null,
          dimResult?.smartName || enhancedInfo.smartName,
          enhancedInfo.fileType,
          thumbnailRelativePath,
          currentWorkspaceId,
          timer,
          this.collectAnalysisStats.bind(this),
          false,
          dimResult?.groupingReason,
          dimResult?.groupingConfidence,
          undefined, // markitdownBenchmark
          4,
          cpuSkipped
        )

        this.saveBasicMagikaTags(fileFingerprint, existingBasicData.category || null, filePath, db)
        databaseService.syncFTSTags(fileFingerprint)

        const analysisStats = await this.collectAnalysisStats(timer)
        if (cpuSkipped && analysisStats.performance?.fresh) {
          analysisStats.performance.fresh.cpuSkipped = true
        }
        await databaseService.updateFileAnalysisResult(workspaceFile.id, {
          analysisStats
        })

        // 从数据库捞取合并后的全量 analysisStats（包含 CPU 阶段 1/2 + GPU 阶段 3/4）推送给前端 UI
        let finalMergedStats = analysisStats
        try {
          const dbMergedRow = db
            .prepare('SELECT analysis_stats FROM file_contents WHERE file_fingerprint = ?')
            .get(fileFingerprint) as { analysis_stats?: string } | undefined
          if (dbMergedRow?.analysis_stats) {
            finalMergedStats = JSON.parse(dbMergedRow.analysis_stats)
          }
        } catch (e) {
          logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] 回捞合并后的 analysis_stats 失败:', e)
        }

        timer.printSummary()
        this.updateItemStatus(item.id, 'completed', 100, undefined, {
          analysisStats: finalMergedStats
        })
        return
      }

      // 获取现有物理文件记录 (V2.2 架构：通过 workspace_id + path 查询)
      const existingWorkspaceFile = this.selectWorkspaceFileStmt.get(
        currentWorkspaceId,
        filePath
      ) as any

      let fileFingerprint = existingWorkspaceFile?.file_fingerprint || '0'.repeat(32)
      const isLocallyAnalyzed = existingWorkspaceFile?.is_analyzed === 1

      logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 文件状态检查: ${item.name}`, {
        isLocallyAnalyzed,
        forceReanalyze: item.forceReanalyze,
        fileFingerprint: fileFingerprint.substring(0, 8) + '...'
      })

      const dbMtime = existingWorkspaceFile
        ? new Date(existingWorkspaceFile.modified_at).getTime()
        : 0
      const currentMtime = currentStats.mtime.getTime()
      const dbSize = existingWorkspaceFile?.size || 0
      const currentSize = currentStats.size

      const isTempHash = fileFingerprint.startsWith('temp_') || fileFingerprint === '0'.repeat(32)
      const metadataMismatched = dbMtime !== currentMtime || dbSize !== currentSize
      const needsNewHash = isTempHash || metadataMismatched || !existingWorkspaceFile
      let magikaCategory: MagikaCategory | null = null

      // ========== 第一阶段：特征识别与哈希计算 ==========
      this.updateItemStatus(item.id, 'analyzing', 2, undefined, { analysisStage: 1 })
      timer.start('hashAndTypeIdentification')

      let initialMetadata: any = {}
      let stage1FingerprintMs = 0
      let stage1MagikaMs = 0
      let stage1MetadataMs = 0

      if (needsNewHash) {
        logger.info(
          LogCategory.ANALYSIS_QUEUE,
          `[分析队列] 准备计算真实哈希与并行特征识别: ${item.name}${isTempHash ? ' (替换临时ID)' : ''}${metadataMismatched ? ' (元数据已变动)' : ''}`
        )
        const markitdownProcessor = new MarkitdownProcessor()

        const tFingerprintStart = Date.now()
        fileFingerprint = await calculateFileFingerprint(filePath)
        stage1FingerprintMs = Date.now() - tFingerprintStart

        const tMagikaStart = Date.now()
        magikaCategory = await magikaService.identifyFile(filePath)
        magikaCategory = this.sanitizeMagikaCategory(magikaCategory, filePath)
        stage1MagikaMs = Date.now() - tMagikaStart

        const tExifStart = Date.now()
        initialMetadata = await metadataExtractionService
          .extractMetadataFull(filePath)
          .catch(err => {
            logger.warn(
              LogCategory.ANALYSIS_QUEUE,
              `[分析队列] 并行 ExifTool 提取失败: ${err.message}`
            )
            return {}
          })
        stage1MetadataMs = Date.now() - tExifStart

        const categoryString =
          typeof magikaCategory === 'string' ? magikaCategory : JSON.stringify(magikaCategory)

        const { fileType: initialFileType, smartName: initialSmartName } = this.getEnhancedFileInfo(
          path.basename(filePath),
          item.type,
          filePath,
          magikaCategory
        )

        this.insertFileStmt.run(
          fileFingerprint,
          initialSmartName,
          currentStats.size,
          initialFileType || path.extname(filePath).toLowerCase() || 'unknown',
          categoryString,
          new Date(currentStats.birthtime).toISOString(),
          new Date(currentStats.mtime).toISOString(),
          new Date(currentStats.atime).toISOString(),
          new Date().toISOString()
        )

        // 确保 workspace_files 表已更新指纹
        const dirPath = path.dirname(filePath)
        const directoryId = await databaseService.addDirectory(dirPath, currentWorkspaceId)

        this.insertWorkspaceFileStmt.run(
          fileFingerprint,
          currentWorkspaceId,
          directoryId,
          filePath,
          path.basename(filePath),
          new Date(currentStats.birthtime).toISOString(),
          new Date(currentStats.mtime).toISOString(),
          new Date(currentStats.atime).toISOString(),
          existingWorkspaceFile?.is_analyzed || 0,
          new Date().toISOString()
        )

        // 校验并匹配 status = 0 的关联记录（物理文件移动/更名重绑定）
        const lostRecord = db
          .prepare(
            'SELECT id, path FROM workspace_files WHERE file_fingerprint = ? AND status = 0 LIMIT 1'
          )
          .get(fileFingerprint) as { id: number; path: string } | undefined

        if (lostRecord) {
          logger.info(
            LogCategory.ANALYSIS_QUEUE,
            `[分析队列] 找到同指纹物理失联记录(ID:${lostRecord.id})，更新为新路径并恢复 status=1: ${filePath}`
          )
          db.prepare(
            'UPDATE workspace_files SET path = ?, name = ?, workspace_id = ?, directory_id = ?, status = 1, updated_at = ? WHERE id = ?'
          ).run(
            filePath,
            path.basename(filePath),
            currentWorkspaceId,
            directoryId,
            new Date().toISOString(),
            lostRecord.id
          )
        }

        logger.info(
          LogCategory.ANALYSIS_QUEUE,
          `[分析队列] 已同步真实哈希至数据库: ${item.name}, Hash: ${fileFingerprint}`
        )
      }

      // 文件已确认需要分析，清理旧标签关系以保持一致性
      // 后续 AI 分析（云端/本地）不再执行此删除，以保留基础分析写入的扩展名标签
      this.deleteTagRelationsStmt.run(fileFingerprint)

      let cloudCachedData: any = null
      let isCloudCache = false

      if (!isPrivate) {
        this.updateItemStatus(item.id, 'analyzing', 5)

        const canUseCache = !isLocallyAnalyzed || metadataMismatched
        const shouldSkipCache =
          (item.forceReanalyze === true && isLocallyAnalyzed) || analysisMode !== 'full'

        logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 缓存决策: ${item.name}`, {
          canUseCache,
          shouldSkipCache,
          isLocallyAnalyzed,
          forceReanalyze: item.forceReanalyze
        })

        if (shouldSkipCache) {
          logger.info(
            LogCategory.ANALYSIS_QUEUE,
            `[分析队列] 强制重新分析，跳过缓存检查: ${item.name}`
          )
        } else if (canUseCache) {
          logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 开始检查缓存: ${item.name}`)

          if (
            fileFingerprint &&
            !fileFingerprint.startsWith('temp_') &&
            fileFingerprint !== '0'.repeat(32)
          ) {
            try {
              const localCachedFile =
                await databaseService.getAnalyzedFileByContentHash(fileFingerprint)
              if (localCachedFile) {
                logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 命中本地内容缓存: ${item.name}`)
                const tags = await databaseService.getFileTagsByFileId(fileFingerprint)
                cloudCachedData = { ...localCachedFile, tags }
              }
            } catch (localError) {
              logger.error(
                LogCategory.ANALYSIS_QUEUE,
                `[分析队列] 本地缓存检查失败: ${item.name}`,
                localError
              )
            }

            if (!cloudCachedData) {
              try {
                cloudCachedData = await cloudAnalysisService.checkCloudCache(
                  fileFingerprint,
                  language
                )
                if (cloudCachedData) {
                  logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 命中云端缓存: ${item.name}`)
                  isCloudCache = true
                }
              } catch (cloudError) {
                logger.error(
                  LogCategory.ANALYSIS_QUEUE,
                  `[分析队列] 云端缓存检查失败: ${item.name}`,
                  cloudError
                )
              }
            }
          }
        }
      }

      if (cloudCachedData) {
        logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 应用缓存数据: ${item.name}`)
        this.updateItemStatus(item.id, 'analyzing', 50)

        try {
          await this.saveCloudResultToDB(
            item,
            fileFingerprint,
            cloudCachedData,
            isCloudCache,
            currentWorkspaceId
          )
          this.updateItemStatus(item.id, 'completed', 100, undefined, { fromCache: true })
          logger.info(
            LogCategory.ANALYSIS_QUEUE,
            `[分析队列] 项目分析完成 (缓存命中): ${item.name}`
          )
          timer.end('应用缓存数据')
          return
        } catch (saveError) {
          logger.error(
            LogCategory.ANALYSIS_QUEUE,
            `[分析队列] 保存缓存数据失败，降级为正常分析: ${item.name}`,
            saveError
          )
          cloudCachedData = null
        }
      }

      // 获取现有基础数据
      const existingBasicData = reuseBasicAnalysisData
        ? this.getExistingBasicData(db, fileFingerprint, currentWorkspaceId, filePath)
        : {}

      // 如果不是新哈希，且没有 magikaCategory，尝试从数据库中捞取（或复用）
      if (!magikaCategory) {
        if (existingBasicData.category) {
          magikaCategory = existingBasicData.category
          logger.info(
            LogCategory.ANALYSIS_QUEUE,
            `[复用数据] 已复用文件类型 (Magika): ${item.name}`
          )
        } else if (existingWorkspaceFile) {
          const row = db
            .prepare('SELECT category FROM files WHERE file_fingerprint = ?')
            .get(fileFingerprint) as { category?: string }
          if (row?.category) {
            try {
              magikaCategory = JSON.parse(row.category)
            } catch (e) {
              logger.warn(LogCategory.FILE_ANALYSIS, '[文件处理器] 解析 Magika 分类 JSON 失败:', e)
            }
          }
        }
      }

      // 如果依然没有 magikaCategory，则强制调用本地 Magika 识别完整分类信息（包含 label, description, group, score, extensions, is_text 等 7 项全量数据）
      if (!magikaCategory) {
        try {
          magikaCategory = await magikaService.identifyFile(filePath)
          magikaCategory = this.sanitizeMagikaCategory(magikaCategory, filePath)
        } catch (e) {
          logger.warn(LogCategory.FILE_ANALYSIS, '[文件处理器] 调用 Magika CLI 识别失败:', e)
        }
      }

      // 确保有 initialMetadata 填充，避免缺少 metadata 时被跳过
      if (!initialMetadata || Object.keys(initialMetadata).length === 0) {
        if (existingBasicData.metadata && Object.keys(existingBasicData.metadata).length > 0) {
          initialMetadata = existingBasicData.metadata
        } else {
          const tExifStart = Date.now()
          initialMetadata = await metadataExtractionService
            .extractMetadataFull(filePath)
            .catch(() => ({}))
          if (stage1MetadataMs === 0) {
            stage1MetadataMs = Date.now() - tExifStart
          }
        }
      }

      timer.end('hashAndTypeIdentification')

      let { fileType: enhancedFileType, smartName: enhancedSmartName } = this.getEnhancedFileInfo(
        item.name,
        item.type,
        filePath,
        magikaCategory
      )

      let contentResult: { content: string; metadata: any } = { content: '', metadata: {} }
      let thumbnailRelativePath: string | undefined = undefined
      let directoryContext: any = null
      // MarkitdownServer 提取阶段细分耗时（来自响应 time_ms/benchmark）
      let markitdownBenchmark: MarkitdownBenchmark | undefined = undefined

      const extractPages = ConfigOrchestrator.getInstance().getValue<number>('EXTRACT_PAGES') ?? 2
      const enableDocumentOcr =
        ConfigOrchestrator.getInstance().getValue<boolean>('ENABLE_DOCUMENT_OCR') ?? false
      const enableImageOcr =
        ConfigOrchestrator.getInstance().getValue<boolean>('ENABLE_IMAGE_OCR') ?? false
      const ocrModelSize =
        ConfigOrchestrator.getInstance().getValue<string>('OCR_MODEL_SIZE') ?? 'tiny'
      const maxContentSizeKb =
        ConfigOrchestrator.getInstance().getValue<number>('MAX_CONTENT_SIZE_KB') ?? 30

      const isImage = isCategory(filePath, FileCategory.IMAGE)
      const isNativeImage =
        isImage && BROWSER_NATIVE_IMAGE_EXTS.includes(path.extname(filePath).toLowerCase())

      // ========== 目录上下文预获取 ==========
      // 文件分析依赖目录分析数据；在内容提取前，先检查并获取目录上下文：
      // - simple 模式：仅读取缓存/DB，不触发 AI 分析（避免增加耗时）
      // - document/full 模式：若无缓存则触发目录 AI 分析，确保维度分析有足够上下文
      try {
        const parentDir = path.dirname(filePath)
        if (analysisMode === 'simple') {
          // simple 模式：仅读内存缓存，不触发 AI 分析
          directoryContext = await this.analyzeDirectoryContext(
            parentDir,
            false,
            true /* cacheOnly */
          )
        } else {
          // document/full 模式：允许触发目录 AI 分析
          directoryContext = await this.analyzeDirectoryContext(parentDir, false)
        }
        if (directoryContext) {
          logger.info(LogCategory.ANALYSIS_QUEUE, `[目录上下文] 预获取目录上下文成功: ${parentDir}`)
        } else {
          logger.info(
            LogCategory.ANALYSIS_QUEUE,
            `[目录上下文] 目录上下文暂不可用（将跳过目录维度增强）: ${parentDir}`
          )
        }
      } catch (dirCtxError) {
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          `[目录上下文] 预获取目录上下文失败（不影响文件分析）: ${filePath}`,
          dirCtxError
        )
      }

      // ========== 第二阶段：内容提取与文本转换 ==========
      this.updateItemStatus(item.id, 'analyzing', 10, undefined, { analysisStage: 2 })

      const magikaGroup =
        typeof magikaCategory === 'string' ? magikaCategory : magikaCategory?.group
      const isDocument = magikaGroup === 'document'

      // ========== 并行内容提取与文本转换 ==========
      timer.start('markitdownServerExtraction')

      // 判断是否为纯文本/代码文件（.ts/.json 等非 document 格式）：
      // 这类文件应绕过 anydoc 与 Markitdown Server，直接由 TextFileProcessor 轻量提取
      let extractFileExt = path.extname(filePath).toLowerCase()
      if (!extractFileExt && magikaCategory && typeof magikaCategory !== 'string') {
        const magikaExt = magikaCategory.extensions?.[0] || magikaCategory.label
        if (magikaExt && magikaExt !== 'empty') {
          extractFileExt = magikaExt.startsWith('.')
            ? magikaExt.toLowerCase()
            : `.${magikaExt.toLowerCase()}`
        }
      }
      const extractFileCategory = extractFileExt
        ? getFileCategory(`file${extractFileExt}`)
        : getFileCategory(filePath)
      const isPlainTextOrCode =
        extractFileCategory === FileCategory.TEXT || extractFileCategory === FileCategory.CODE

      // anydoc 仅支持 Word/PPT/Excel/ODF/RTF/EPUB/CSV/PDF 等文档格式，
      // 其它类型（如 .lnk 快捷方式、应用、音视频、压缩包等）直接跳过 anydoc 提取，
      // 避免无效调用与 unsupported 报错刷屏
      const isAnydocSupported = ANYDOC_SUPPORTED_EXTS.has(extractFileExt)

      const [anydocResult, extractResult, dirContext, thumbPath] = await Promise.all([
        // 0. Anydoc 提取 (仅 anydoc 支持的文档格式触发；纯文本/代码及其它类型绕过)
        isPlainTextOrCode || !isAnydocSupported
          ? Promise.resolve({ content: '', assets: [] })
          : anydocService.extract(filePath).catch(err => {
              logger.warn(LogCategory.ANALYSIS_QUEUE, `[anydoc] 提取失败: ${err.message}`)
              return { content: '', assets: [] }
            }),

        // 1. Markitdown Server 提取 (仅在图片/文档开启 OCR 时触发；纯文本/代码文件绕过)
        (async () => {
          if (isPlainTextOrCode) {
            return { serverResult: null, missingIndicators: [] }
          }

          let effectiveExt = path.extname(filePath).toLowerCase()
          if (!effectiveExt && magikaCategory && typeof magikaCategory !== 'string') {
            const magikaExt = magikaCategory.extensions?.[0] || magikaCategory.label
            if (magikaExt && magikaExt !== 'empty') {
              effectiveExt = magikaExt.startsWith('.')
                ? magikaExt.toLowerCase()
                : `.${magikaExt.toLowerCase()}`
            }
          }

          const isOfficeOrPdf =
            isCategory(filePath, FileCategory.OFFICE) || filePath.toLowerCase().endsWith('.pdf')

          const fileCategory = effectiveExt
            ? getFileCategory(`file${effectiveExt}`)
            : getFileCategory(filePath)

          // OCR 仅对图片与文档类生效：
          // - 图片受 ENABLE_IMAGE_OCR 控制
          // - 文档类（DOCUMENT/OFFICE/PDF）受 ENABLE_DOCUMENT_OCR 控制
          // - 其它类型（应用/压缩包/音视频/电子书等）一律不请求 OCR
          const isDocumentLike =
            fileCategory === FileCategory.DOCUMENT ||
            fileCategory === FileCategory.OFFICE ||
            filePath.toLowerCase().endsWith('.pdf')
          const useOcr = isImage ? enableImageOcr : isDocumentLike ? enableDocumentOcr : false

          // 是否触发 markitdownserver 仅取决于 useOcr：未开启 OCR 时直接跳过调用
          // （主 Markdown 由 anydoc 提取、metadata 由 ExifTool 提取，均不依赖 Server）
          if (!useOcr) {
            return { serverResult: null, missingIndicators: [] }
          }

          // 开启 OCR 时只提取 ocr 指标（不附带 metadata）；Office/PDF 且无现成缩略图时顺带请求 thumbnail
          const indicators: string[] = ['ocr']
          if (isOfficeOrPdf && !existingBasicData.thumbnailPath) {
            indicators.push('thumbnail')
          }

          const needsServerThumbnail =
            !isNativeImage && !existingBasicData.thumbnailPath && isOfficeOrPdf

          const serverOptions: any = {}
          if (!isImage && filePath.toLowerCase().endsWith('.pdf')) {
            serverOptions.pages = `1-${extractPages}`
          }
          serverOptions.ocrModelSize = ocrModelSize
          serverOptions.maxContentSizeKb = maxContentSizeKb

          if (needsServerThumbnail && rootWorkspaceDir) {
            const thumbDir = await thumbnailService.ensureThumbnailDirectory(rootWorkspaceDir.path)
            serverOptions.thumbnailOut = path.join(thumbDir, `${fileFingerprint}.webp`)
          }

          const missingIndicators = this.filterMissingIndicators(
            indicators,
            existingBasicData,
            magikaCategory
          )

          if (missingIndicators.length === 0) {
            return { serverResult: null, missingIndicators }
          }

          try {
            const serverResult = await markitdownServerManager.extractAll(
              filePath,
              missingIndicators,
              serverOptions
            )
            return { serverResult, missingIndicators }
          } catch (error: any) {
            logger.warn(
              LogCategory.ANALYSIS_QUEUE,
              `[FileProcessor] Markitdown Server 调用失败或超时，将进行优雅降级: ${item.name}`,
              error
            )
            return { serverResult: null, missingIndicators }
          }
        })(),

        // 2. 目录上下文（已在提取前统一预获取，此处直接复用 directoryContext，无需重复分析）
        Promise.resolve(directoryContext),

        // 3. 缩略图决策
        (async () => {
          if (existingBasicData.thumbnailPath) return existingBasicData.thumbnailPath

          if (isNativeImage) {
            // 浏览器原生格式：直接引用原图
            return path.relative(rootWorkspaceDir.path, filePath)
          }

          if (isImage) {
            // 非原生图片：原尺寸转码 WebP
            const thumbResult = await thumbnailService.getOrGenerateOriginalTranscodedImage(
              filePath,
              fileFingerprint,
              enhancedSmartName,
              rootWorkspaceDir.path
            )
            return thumbResult.success ? thumbResult.relativePath : undefined
          }

          return undefined // PDF/Office 由 Server 处理，见下文
        })()
      ])

      const serverResult = extractResult?.serverResult
      directoryContext = dirContext

      // 提取完成，更新 Magika 分类 (使用 Server 返回的)
      if (serverResult?.magika) {
        magikaCategory = serverResult.magika
      } else if (!magikaCategory) {
        // 如果 Server 没有返回并且本地依然没有，作为 fallback 调用一次本地 Magika CLI
        magikaCategory = await magikaService.identifyFile(filePath)
      }

      // 重新计算最终的 enhancedFileType 和 enhancedSmartName，以防没有后缀的文件被 Magika 识别后类型更新
      const enhancedInfo = this.getEnhancedFileInfo(item.name, item.type, filePath, magikaCategory)
      enhancedFileType = enhancedInfo.fileType
      enhancedSmartName = enhancedInfo.smartName

      // 组装内容：anydocMarkdown + "\n\n" + (ocrText ?? "")
      const anydocMarkdown = anydocResult?.content || ''
      const ocrText = serverResult?.ocr?.content ?? ''
      let combinedContent = anydocMarkdown + '\n\n' + ocrText

      // If anydoc did not extract content and markitdownserver did, fallback to markitdownserver content
      if (!anydocMarkdown && !ocrText && serverResult) {
        if (serverResult.document?.content != null) {
          combinedContent = serverResult.document.content
        }
        if (!combinedContent && serverResult.text?.content != null) {
          combinedContent = serverResult.text.content
        }
      }

      // 复用数据：server 未返回内容时（完全跳过或仅按需请求了缺失指标），回退到已有内容
      if (!combinedContent.trim() && existingBasicData.content && !isImage) {
        combinedContent = existingBasicData.content
        logger.info(
          LogCategory.ANALYSIS_QUEUE,
          `[复用数据] 复用已有文本内容: ${item.name}, 长度: ${combinedContent.length}`
        )
      }

      // 文本文件降级：如果 Markitdown Server 未返回任何内容（例如服务器跳过或异常），
      // 使用 TextFileProcessor 作为兜底
      if (!combinedContent.trim() && !isImage) {
        try {
          const textProcessor = new TextFileProcessor()
          if (textProcessor.canProcess(path.basename(filePath), enhancedFileType)) {
            timer.start('文本提取')
            const textContent = await textProcessor.extractContentSafe(filePath)
            timer.end('文本提取')
            if (textContent) {
              combinedContent = textContent
              logger.info(
                LogCategory.ANALYSIS_QUEUE,
                `[FileProcessor] TextFileProcessor 降级提取文本内容成功: ${item.name}, 长度: ${textContent.length}`
              )
            }
          }
        } catch (fallbackError) {
          logger.warn(
            LogCategory.ANALYSIS_QUEUE,
            `[FileProcessor] TextFileProcessor 降级提取失败: ${item.name}`,
            fallbackError
          )
        }
      }

      // 重新计算与整合完整的 markitdownBenchmark (包含 Stage 1 Magika/Metadata、Anydoc 及 TextFileProcessor 细分耗时)
      const serverBenchmark = extractMarkitdownBenchmark(serverResult ?? undefined)
      const phases = typeof timer?.getPhases === 'function' ? timer.getPhases() : {}
      const hashIdentifyMs =
        phases['hashAndTypeIdentification'] || phases['hashIdentify'] || phases['哈希与类型识别']
      const localTextMs = phases['contentExtraction'] || phases['文本提取']

      const stage2MagikaMs = serverBenchmark?.magikaMs ?? (stage1MagikaMs > 0 ? stage1MagikaMs : 0)
      const stage2MetadataMs =
        serverBenchmark?.metadataMs ?? (stage1MetadataMs > 0 ? stage1MetadataMs : 0)
      const stage2TextMs = serverBenchmark?.textMs ?? (localTextMs || 0)
      const stage2OtherMs =
        (serverBenchmark?.officePrePdfMs || 0) +
        (serverBenchmark?.documentMs || 0) +
        (serverBenchmark?.ocrMs || 0) +
        (serverBenchmark?.htmlMs || 0) +
        (serverBenchmark?.thumbnailMs || 0)
      const calculatedTotalMs =
        serverBenchmark?.totalMs ?? stage2MagikaMs + stage2MetadataMs + stage2TextMs + stage2OtherMs

      markitdownBenchmark = {
        totalMs: calculatedTotalMs,
        officePrePdfMs: serverBenchmark?.officePrePdfMs,
        magikaMs: serverBenchmark?.magikaMs ?? (stage1MagikaMs > 0 ? stage1MagikaMs : undefined),
        metadataMs:
          serverBenchmark?.metadataMs ?? (stage1MetadataMs > 0 ? stage1MetadataMs : undefined),
        textMs: serverBenchmark?.textMs ?? localTextMs,
        documentMs: serverBenchmark?.documentMs,
        ocrMs: serverBenchmark?.ocrMs,
        htmlMs: serverBenchmark?.htmlMs,
        thumbnailMs: serverBenchmark?.thumbnailMs
      }

      // 根据配置的 MAX_TEXT_LENGTH 进行安全截断
      const maxTextLength =
        ConfigOrchestrator.getInstance().getValue<number>('MAX_TEXT_LENGTH' as any) ?? 10000
      if (combinedContent.length > maxTextLength) {
        logger.info(
          LogCategory.ANALYSIS_QUEUE,
          `[FileProcessor] 拼接后文本过长(${combinedContent.length}字符)，根据配置截断至${maxTextLength}字符: ${filePath}`
        )
        combinedContent = combinedContent.substring(0, maxTextLength)
      }

      contentResult = {
        content: combinedContent,
        metadata: serverResult?.metadata || initialMetadata || existingBasicData.metadata || {}
      }

      logger.debug(
        LogCategory.ANALYSIS_QUEUE,
        `[FileProcessor] server提取完成: combinedContentLen=${combinedContent.length} reusedContent=${!!existingBasicData.content} hasDocument=${!!serverResult?.document?.content} hasText=${!!serverResult?.text?.content} hasTextFallback=${combinedContent.length > 0 && !serverResult?.document?.content && !serverResult?.text?.content} hasOcr=${!!serverResult?.ocr?.content} hasMetadata=${!!(serverResult?.metadata || existingBasicData.metadata)}`
      )

      // 处理缩略图路径
      if (thumbPath) {
        thumbnailRelativePath = thumbPath
      } else if (serverResult?.thumbnail) {
        // server 可能返回字符串路径或 { path: string } 对象
        const thumbRaw = serverResult.thumbnail as string | { path?: string }
        const thumbPathStr = typeof thumbRaw === 'string' ? thumbRaw : thumbRaw?.path
        if (rootWorkspaceDir && typeof thumbPathStr === 'string') {
          thumbnailRelativePath = path.relative(rootWorkspaceDir.path, thumbPathStr)
        }
      }

      // 封面降级：当无 markitdownserver 封面时正确降级为 anydoc 最大图片（根据 width * height 选出尺寸最大者）
      if (!thumbnailRelativePath && rootWorkspaceDir) {
        let anydocCover: AnydocAsset | null = null
        if (anydocResult?.assets && anydocResult.assets.length > 0) {
          let maxArea = -1
          for (const asset of anydocResult.assets) {
            const width = asset.width ?? 0
            const height = asset.height ?? 0
            const area = width * height
            if (area > maxArea) {
              maxArea = area
              anydocCover = asset
            }
          }
        }

        if (anydocCover) {
          let absoluteCoverPath = anydocCover.path
          if (!path.isAbsolute(absoluteCoverPath)) {
            const resolvedPath = path.resolve(path.dirname(filePath), anydocCover.path)
            if (fs.existsSync(resolvedPath)) {
              absoluteCoverPath = resolvedPath
            } else {
              absoluteCoverPath = path.resolve(rootWorkspaceDir.path, anydocCover.path)
            }
          }
          thumbnailRelativePath = path.relative(rootWorkspaceDir.path, absoluteCoverPath)
        }
      }

      timer.end('markitdownServerExtraction')

      const fileInfo: FileInfoInput = {
        path: filePath,
        name: enhancedSmartName,
        type: enhancedFileType,
        size:
          contentResult.metadata?.fileSize !== undefined && contentResult.metadata?.fileSize > 0
            ? contentResult.metadata.fileSize
            : item.size || 0,
        content: contentResult.content,
        metadata: contentResult.metadata
      }

      logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 并行提取阶段处理完成: ${item.name}`, {
        hasContent: !!contentResult.content && contentResult.content.length > 0,
        contentLength: contentResult.content?.length || 0,
        fileSize: fileInfo.size,
        mimeType: contentResult.metadata?.mimeType
      })

      this.updateItemStatus(item.id, 'analyzing', 2)

      if (!fileFingerprint || fileFingerprint.startsWith('temp_')) {
        fileFingerprint = await calculateFileFingerprint(filePath)
      }

      // 无论文件是否已存在，都使用 UPSERT 写入/更新 Magika 分类（category）：
      // - simple 模式下 magikaCategory 来自本地 Magika CLI
      // - document/full 模式下 magikaCategory 来自 MarkitdownServer 的 serverResult.magika（或本地兜底）
      // 否则并行 CPU 阶段提前返回时，从 Server 获取的 magika 数据将无法落库，
      // 导致文件属性面板元数据 Tab 的 Magika 字段缺失
      const stats = currentStats || fs.statSync(filePath)
      db.prepare(
        `
        INSERT INTO files (file_fingerprint, smart_name, size, type, category, created_at, modified_at, accessed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_fingerprint) DO UPDATE SET
          category = excluded.category
        `
      ).run(
        fileFingerprint,
        fileInfo.name,
        stats.size,
        enhancedFileType,
        JSON.stringify(magikaCategory || { mime_type: getMimeType(enhancedFileType) }),
        new Date(stats.birthtime).toISOString(),
        new Date(stats.mtime).toISOString(),
        new Date(stats.atime).toISOString()
      )

      // 实时保存 CPU 提取完成阶段状态：写入内容、元数据、歌词及阶段状态
      // 分析模式决定 CPU 完成 stage：Sample 在 1 结束，Document/Full 在 2 结束
      const cpuCompletionStage = analysisMode === 'simple' ? 1 : 2
      try {
        const metadataLyrics = getFallbackLyrics(fileInfo.metadata)
        db.prepare(
          `
          INSERT INTO file_contents (file_fingerprint, content, metadata, lrc)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(file_fingerprint) DO UPDATE SET
            content = COALESCE(excluded.content, content),
            metadata = CASE
              WHEN metadata IS NULL OR metadata = '{}' OR metadata = '' THEN excluded.metadata
              ELSE COALESCE(excluded.metadata, metadata)
            END,
            lrc = COALESCE(excluded.lrc, lrc)
          `
        ).run(
          fileFingerprint,
          contentResult.content ?? null,
          JSON.stringify(fileInfo.metadata),
          metadataLyrics ?? null
        )

        await databaseService.updateAnalysisStage(fileFingerprint, cpuCompletionStage)
      } catch (dbError) {
        logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 实时写入阶段状态失败:', dbError)
      }

      if (phase === 'cpu') {
        try {
          const cpuTimerStats = await this.collectAnalysisStats(timer)
          const cpuStatsWithBenchmark = applyMarkitdownBenchmark(cpuTimerStats, markitdownBenchmark)
          const wsFileRow = db
            .prepare(`SELECT id FROM workspace_files WHERE workspace_id = ? AND path = ?`)
            .get(currentWorkspaceId, filePath) as { id?: number } | undefined
          if (wsFileRow?.id) {
            await databaseService.updateFileAnalysisResult(String(wsFileRow.id), {
              analysisStats: cpuStatsWithBenchmark
            })
          }
        } catch (saveCpuError) {
          logger.warn(
            LogCategory.ANALYSIS_QUEUE,
            '[分析队列] 实时保存 CPU 阶段耗时失败:',
            saveCpuError
          )
        }
        this.updateItemStatus(item.id, 'pending', 50, undefined, { analysisStage: 2 })
        return
      }

      if (!fileInfo.content || fileInfo.content.length === 0) {
        try {
          const dbFile = await databaseService.getFileByPath(filePath)
          if (dbFile && dbFile.content) {
            fileInfo.content = dbFile.content
            if (fileInfo.content) {
              logger.info(
                LogCategory.ANALYSIS_QUEUE,
                `[分析队列] 从数据库回捞内容成功: ${item.name}, 长度: ${fileInfo.content.length}`
              )
            }
          }
        } catch (dbError) {
          logger.warn(
            LogCategory.ANALYSIS_QUEUE,
            `[分析队列] 从数据库回捞内容失败: ${item.name}`,
            dbError
          )
        }
      }

      // ========== 简单分类模式 (simple)：跳过AI分析，完成内容/元数据/Magika标签提取在 Stage 1 结束 ==========
      if (analysisMode !== 'full') {
        // 简单分类模式：跳过AI分析，仅保留内容/元数据/Magika标签
        const processResult = {
          content: contentResult.content,
          metadata: contentResult.metadata,
          qualityScore: null,
          qualityConfidence: null,
          multimodalContent: undefined,
          lrc: undefined,
          qualityReasoning: undefined,
          qualityCriteria: undefined
        }

        this.updateItemStatus(item.id, 'analyzing', 51, undefined, {
          analysisStage: 1
        })

        const { workspaceFile } = await saveLocalAnalysisResult(
          item,
          fileFingerprint,
          processResult,
          magikaCategory,
          enhancedSmartName,
          enhancedFileType,
          thumbnailRelativePath || undefined,
          currentWorkspaceId,
          timer,
          this.collectAnalysisStats.bind(this),
          true,
          undefined,
          undefined,
          markitdownBenchmark,
          1
        )

        logger.info(
          LogCategory.ANALYSIS_QUEUE,
          `[基础分析] 保存 category: ${JSON.stringify(magikaCategory).slice(0, 200)}`
        )

        // 保存 Magika 标签（文件类型 + 扩展名）
        this.saveBasicMagikaTags(fileFingerprint, magikaCategory, filePath, db)

        // 从元数据直接提取作者/语言标签并保存（标签 + 专用字段）
        if (processResult.metadata) {
          await this.saveBasicAuthorTags(fileFingerprint, processResult.metadata, db)
          await this.saveBasicLanguageTags(fileFingerprint, processResult.metadata, db)
        }

        databaseService.syncFTSTags(fileFingerprint)

        // 最终统计收集
        const analysisStats = await this.collectAnalysisStats(timer)
        const analysisStatsWithBenchmark = applyMarkitdownBenchmark(
          analysisStats,
          markitdownBenchmark
        )
        await databaseService.updateFileAnalysisResult(workspaceFile.id, {
          analysisStats: analysisStatsWithBenchmark,
          syncStatus: 4
        })

        timer.printSummary()
        this.updateItemStatus(item.id, 'completed', 100, undefined, {
          analysisStats,
          analysisStage: cpuCompletionStage
        })
        return
      }

      // ========== AI 质量分析与标签维度分析 (封装为 sub-module) ==========
      const { processResult, dimResult } = await processLocalAnalysis(
        item,
        fileFingerprint,
        fileInfo,
        thumbnailRelativePath || undefined,
        rootWorkspaceDir.path,
        timer,
        deps,
        {
          language,
          directoryContext,
          magikaCategory,
          isSpeedy,
          initialStage,
          forceReanalyze: item.forceReanalyze === true
        },
        this.updateItemStatus.bind(this),
        this.processNewDimensionSuggestions.bind(this)
      )

      this.updateItemStatus(item.id, 'analyzing', 98)

      // ========== 保存本地分析结果 ==========
      const { workspaceFile } = await saveLocalAnalysisResult(
        item,
        fileFingerprint,
        processResult,
        magikaCategory,
        dimResult?.smartName || enhancedSmartName,
        enhancedFileType,
        thumbnailRelativePath || undefined,
        currentWorkspaceId,
        timer,
        this.collectAnalysisStats.bind(this),
        false,
        dimResult?.groupingReason,
        dimResult?.groupingConfidence,
        markitdownBenchmark,
        4,
        cpuSkipped
      )

      // ========== 补充写入基础 of Magika 类型与扩展名标签 ==========
      this.saveBasicMagikaTags(fileFingerprint, magikaCategory, filePath, db)

      databaseService.syncFTSTags(fileFingerprint)

      // ========== 最终统计收集 ==========
      const analysisStats = await this.collectAnalysisStats(timer)
      const analysisStatsWithBenchmark = applyMarkitdownBenchmark(
        analysisStats,
        markitdownBenchmark
      )

      await databaseService.updateFileAnalysisResult(workspaceFile.id, {
        analysisStats: analysisStatsWithBenchmark
      })

      // 从数据库捞取合并后的全量 analysisStats（包含 CPU 阶段 1/2 + GPU 阶段 3/4）推送给前端 UI
      let finalMergedStats = analysisStatsWithBenchmark
      try {
        const dbMergedRow = db
          .prepare('SELECT analysis_stats FROM file_contents WHERE file_fingerprint = ?')
          .get(fileFingerprint) as { analysis_stats?: string } | undefined
        if (dbMergedRow?.analysis_stats) {
          finalMergedStats = JSON.parse(dbMergedRow.analysis_stats)
        }
      } catch (e) {
        logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] 回捞合并后的 analysis_stats 失败:', e)
      }

      timer.printSummary()

      this.updateItemStatus(item.id, 'completed', 100, undefined, {
        analysisStats: finalMergedStats,
        analysisStage: 4
      })
    } catch (error: any) {
      const isAbort = error && (error.name === 'AbortError' || error.message === 'Aborted')
      if (isAbort) {
        logger.info(
          LogCategory.ANALYSIS_QUEUE,
          `[分析队列] 分析任务被中止，恢复状态为 pending: ${item.name}`
        )
        this.updateItemStatus(item.id, 'pending', 0)
      } else {
        let errorMsg = error instanceof Error ? error.message : String(error)
        if (errorMsg.includes('timeout') || errorMsg.includes('超时')) {
          if (
            errorMsg.includes('元数据') ||
            errorMsg.includes('Markitdown') ||
            errorMsg.includes('提取') ||
            errorMsg.includes('extract') ||
            errorMsg.includes('fileAnalysisService')
          ) {
            errorMsg += ` ${t('建议减少 PDF 分析页数或关闭 OCR 功能')}`
          } else {
            errorMsg += ` ${t('建议切换低显存需求的AI模型')}`
          }
        }
        logger.error(LogCategory.ANALYSIS_QUEUE, `[分析队列] 文件分析失败: ${item.name}`, error)
        this.updateItemStatus(item.id, 'failed', 100, errorMsg)
      }
    }
  }

  /**
   * 基础分析模式下从元数据提取作者标签（使用共享工具）
   */
  private async saveBasicAuthorTags(
    fileFingerprint: string,
    metadata: any,
    db: any
  ): Promise<void> {
    try {
      const result = saveAuthorTagsFromMetadata(db, fileFingerprint, metadata, 4)
      if (result.authorNames.length > 0) {
        db.prepare('UPDATE files SET author = ? WHERE file_fingerprint = ?').run(
          result.authorValue,
          fileFingerprint
        )
        logger.info(
          LogCategory.ANALYSIS_QUEUE,
          `[基础分析] 已从元数据提取作者标签: ${result.authorNames.join(', ')}`
        )
      }
    } catch (error) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, `[基础分析] 提取作者标签失败: ${error}`)
    }
  }

  /**
   * 基础分析模式下从元数据提取语言标签（使用共享工具）
   */
  private async saveBasicLanguageTags(
    fileFingerprint: string,
    metadata: any,
    db: any
  ): Promise<void> {
    try {
      const result = saveLanguageTagsFromMetadata(db, fileFingerprint, metadata, 4)
      if (result.languageValue) {
        db.prepare('UPDATE files SET language = ? WHERE file_fingerprint = ?').run(
          result.languageValue,
          fileFingerprint
        )
        logger.info(
          LogCategory.ANALYSIS_QUEUE,
          `[基础分析] 已从元数据提取语言标签: ${result.languageValue}`
        )
      }
    } catch (error) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, `[基础分析] 提取语言标签失败: ${error}`)
    }
  }

  /**
   * 低置信度 Magika 结果净化
   * 当 magika 识别分数低于阈值 (0.8) 时，magika 的 extensions 判断不可靠，
   * 将 extensions 修正为磁盘真实扩展名，避免低置信度误判（如带 BOM 的中文 txt
   * 被识别为 powershell）污染 category 并触发扩展名弹窗。
   * 无磁盘扩展名时清空 extensions（无扩展名文件由 getEnhancedFileInfo 按阈值决策）。
   */
  private sanitizeMagikaCategory(
    magikaCategory: MagikaCategory | null,
    filePath: string
  ): MagikaCategory | null {
    if (!magikaCategory || typeof magikaCategory === 'string') return magikaCategory

    const score = magikaCategory.score ?? 0
    if (score >= 0.8) return magikaCategory

    const diskExt = path.extname(filePath).toLowerCase().replace(/^\./, '')
    if (!diskExt) {
      return { ...magikaCategory, extensions: [] }
    }
    return { ...magikaCategory, extensions: [diskExt] }
  }

  /**
   * 基础分析模式下保存 Magika 标签（使用共享工具）
   */
  private saveBasicMagikaTags(
    fileFingerprint: string,
    magikaCategory: MagikaCategory | null,
    filePath: string,
    db: any
  ): void {
    try {
      const isMagikaReliable =
        magikaCategory &&
        typeof magikaCategory !== 'string' &&
        magikaCategory.group &&
        magikaCategory.group !== 'unknown' &&
        (magikaCategory.score ?? 1) >= 0.6

      if (isMagikaReliable) {
        saveMagikaGroupTag(db, fileFingerprint, magikaCategory, 4)
        saveExtensionTags(db, fileFingerprint, magikaCategory, 4)
        saveMagikaIsTextTag(db, fileFingerprint, magikaCategory, 4)
      } else if (filePath) {
        // Magika 不可靠时，使用原始文件扩展名兜底
        const originalExt = path.extname(filePath).toLowerCase().replace(/^\./, '')
        if (originalExt) {
          // 保存扩展名标签
          saveExtensionTags(db, fileFingerprint, { extensions: [originalExt] } as any, 4)
          // 从扩展名反推 group 并保存类型标签
          const group = getMagikaGroupFromExtension(originalExt)
          if (group) {
            saveMagikaGroupTag(db, fileFingerprint, { group } as any, 4)
          }
        }
      }
    } catch (error) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, `[基础分析] 保存 Magika 标签失败: ${error}`)
    }
  }

  /**
   * 保存云端分析结果到数据库
   */
  async saveCloudResultToDB(
    item: AnalysisQueueItem,
    fileFingerprint: string,
    data: any,
    isCloudCache: boolean,
    workspaceId: number
  ): Promise<void> {
    return saveCloudResult(
      item,
      fileFingerprint,
      data,
      isCloudCache,
      workspaceId,
      this.getModelName.bind(this)
    )
  }

  /**
   * 处理空文件
   */
  async handleEmptyFile(item: AnalysisQueueItem, workspaceId: number): Promise<void> {
    return handleEmptyFile(item, workspaceId)
  }

  /**
   * Helper to compute the final file type and smart name based on Magika category
   */
  private getEnhancedFileInfo(
    originalName: string,
    originalType: string,
    filePath: string,
    magikaCategory: MagikaCategory | null
  ): { fileType: string; smartName: string } {
    const diskExt = path.extname(filePath).toLowerCase()
    let fileType = diskExt || originalType || ''
    let smartName = originalName || path.basename(filePath) || '未知文件'

    // 仅当原文件无扩展名时，尝试使用 Magika 结果补全
    if (!diskExt && magikaCategory && typeof magikaCategory !== 'string') {
      // 仅当 Magika 结果可靠时才使用其扩展名
      const isMagikaReliable =
        magikaCategory.group &&
        magikaCategory.group !== 'unknown' &&
        (magikaCategory.score ?? 1) >= 0.6

      if (isMagikaReliable) {
        const magikaExt =
          magikaCategory.extensions && magikaCategory.extensions.length > 0
            ? magikaCategory.extensions[0]
            : magikaCategory.label

        if (magikaExt && magikaExt.trim() !== '') {
          const newExt = magikaExt.startsWith('.') ? magikaExt : `.${magikaExt}`

          // Only update if it's not a generic fallback like "empty"
          if (newExt !== '.empty' && newExt !== '.') {
            fileType = newExt
          }
        }
      }
    }

    // 确保 smartName 的扩展名与最终确定的 fileType 一致，并防止产生重复后缀（如 .pdf.pdf）
    if (fileType) {
      const targetExt = fileType.startsWith('.') ? fileType : `.${fileType}`
      smartName = smartName.trim()
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const match = smartName.match(/\.[a-zA-Z0-9]+$/)
        if (match) {
          smartName = smartName.substring(0, match.index)
        } else {
          break
        }
      }
      smartName = smartName + targetExt
    }

    smartName = cleanSmartName(smartName, originalName || path.basename(filePath))
    return { fileType, smartName }
  }

  async applyMockResult(itemId: number, filePath: string, workspaceId: number): Promise<boolean> {
    const mockJsonPath = process.env.TEST_MOCK_JSON_PATH!
    const fileName = path.basename(filePath)
    try {
      if (!this.mockData) {
        if (!fs.existsSync(mockJsonPath)) return false
        this.mockData = JSON.parse(fs.readFileSync(mockJsonPath, 'utf-8'))
      }

      const mockWorkspaceFile = this.mockData.workspace_files.find(
        (f: any) =>
          f.name &&
          f.name.toLowerCase() === fileName.toLowerCase() &&
          (f.is_analyzed === 1 || f.is_analyzed === true)
      )
      if (!mockWorkspaceFile) return false

      const fingerprint = mockWorkspaceFile.file_fingerprint
      const fileData = this.mockData.files.find((f: any) => f.file_fingerprint === fingerprint)
      if (!fileData) return false

      const db = databaseService.db!
      const directoryId = await databaseService.addDirectory(path.dirname(filePath), workspaceId)

      const now = new Date().toISOString()

      db.prepare(
        `
        INSERT INTO files (file_fingerprint, smart_name, description, size, type, category, author, language, created_at, modified_at, accessed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_fingerprint) DO UPDATE SET
          smart_name = COALESCE(excluded.smart_name, smart_name),
          description = COALESCE(excluded.description, description)
      `
      ).run(
        fingerprint,
        fileData.smart_name || fileName,
        fileData.description || '',
        fileData.size || 0,
        fileData.type || 'unknown',
        fileData.category ? JSON.stringify(fileData.category) : null,
        fileData.author || '',
        fileData.language || 'zh-CN',
        now,
        now,
        now
      )

      db.prepare(
        `
        INSERT INTO file_contents (file_fingerprint, quality_score)
        VALUES (?, ?)
        ON CONFLICT(file_fingerprint) DO UPDATE SET quality_score = COALESCE(excluded.quality_score, quality_score)
      `
      ).run(fingerprint, fileData.quality_score || 5)

      db.prepare(
        `
        INSERT INTO workspace_files (file_fingerprint, workspace_id, directory_id, path, name, is_analyzed, last_analyzed_at, created_at, modified_at, accessed_at)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, path) DO UPDATE SET is_analyzed = 1, file_fingerprint = excluded.file_fingerprint, last_analyzed_at = ?, modified_at = ?
      `
      ).run(fingerprint, workspaceId, directoryId, filePath, fileName, now, now, now, now, now, now)

      if (this.mockData.file_tag_relations && this.mockData.file_tags) {
        // 清理该文件的所有旧标签关联，避免多次 mock 累积过期数据
        db.prepare('DELETE FROM file_tag_relations WHERE file_fingerprint = ?').run(fingerprint)

        const relations = this.mockData.file_tag_relations.filter(
          (r: any) => r.file_fingerprint === fingerprint
        )
        for (const rel of relations) {
          const tag = this.mockData.file_tags.find((t: any) => t.id === rel.tag_id)
          if (tag) {
            db.prepare('INSERT OR IGNORE INTO file_tags (name, dimension_id) VALUES (?, ?)').run(
              tag.name,
              tag.dimension_id
            )
            const localTagRow = db
              .prepare('SELECT id FROM file_tags WHERE name = ? AND dimension_id = ?')
              .get(tag.name, tag.dimension_id) as any
            if (localTagRow) {
              db.prepare(
                `INSERT OR IGNORE INTO file_tag_relations (file_fingerprint, tag_id, sync_status) VALUES (?, ?, 0)`
              ).run(fingerprint, localTagRow.id)
            }
          }
        }
      }

      databaseService.syncFTSTags(fingerprint)

      this.updateItemStatus(itemId, 'completed', 100)
      return true
    } catch (e) {
      return false
    }
  }
}

/**
 * 从元数据中提取候选歌词
 */
export function getFallbackLyrics(metadata: any): string | null {
  if (!metadata) return null
  const lyricsData = metadata.common?.lyrics || metadata.lyrics
  if (!lyricsData) return null
  if (typeof lyricsData === 'string' && lyricsData.trim().length > 0) {
    return extractPureLyrics(lyricsData)
  }
  if (Array.isArray(lyricsData) && lyricsData.length > 0) {
    for (const item of lyricsData) {
      const text = typeof item === 'string' ? item : item?.text
      if (text) return extractPureLyrics(text)
    }
  }
  return null
}
