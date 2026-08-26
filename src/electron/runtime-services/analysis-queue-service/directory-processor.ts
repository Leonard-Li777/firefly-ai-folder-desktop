import { AnalysisQueueItem, DirectoryContextAnalysis, LanguageCode } from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import { ConfigOrchestrator } from '@app/electron/config/config-orchestrator'
import { databaseService } from '../database/database-service'
import { quotaChecker } from '../user-tier/quota-checker-proxy'
import { createCoreEngineAdapters } from '../../adapters'
import {
  QualityScoringService,
  DimensionAnalyzer,
  UnitRecognitionService,
  FileProcessorService
} from '@firefly/core-engine'
import { DirectoryContextService } from '../filesystem/directory-context-service'
import { shouldIgnoreFile } from '../analysis/analysis-ignore-service'
import { EnqueueInput, IErrorRecoveryConfig } from './types'
import { t } from '@app/languages'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 目录处理类
 * 处理目录识别、展开和上下文分析
 */
export class DirectoryProcessor {
  private directoryContextCache: Map<string, DirectoryContextAnalysis> = new Map()

  constructor(
    private getDependencies: () => {
      unitRecognitionService: UnitRecognitionService | undefined
      directoryContextService: DirectoryContextService | undefined
      errorRecoveryConfig: IErrorRecoveryConfig
      ignoreRules: any[]
    },
    private updateItemStatus: (
      itemId: number,
      status: any,
      progress: number,
      error?: string
    ) => void,
    private pause: () => void,
    private addItems: (inputs: EnqueueInput[], forceReanalyze: boolean) => Promise<void>,
    private reinitAdapters: (adapters: any) => void,
    private onDirectoryCompleted?: (directoryPath: string) => void
  ) {}

  /**
   * 清除目录上下文缓存
   */
  clearDirectoryContextCache(directoryPath?: string): void {
    if (directoryPath) {
      const resolvedPath = path.resolve(directoryPath)
      const keysToRemove: string[] = []
      for (const cachedPath of this.directoryContextCache.keys()) {
        const resolvedCachedPath = path.resolve(cachedPath)
        if (
          resolvedCachedPath === resolvedPath ||
          resolvedCachedPath.startsWith(resolvedPath + path.sep)
        ) {
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

  /**
   * 获取缓存的目录上下文
   */
  getCachedContext(directoryPath: string): DirectoryContextAnalysis | undefined {
    return this.directoryContextCache.get(directoryPath)
  }

  /**
   * 处理目录项
   */
  async processDirectory(item: AnalysisQueueItem): Promise<void> {
    const deps = this.getDependencies()
    try {
      // 配额检查：只对私有目录文件进行限制
      const rootWorkspaceDir = await databaseService.findRootWorkspaceDirectory(item.path)
      const isPrivate = rootWorkspaceDir?.type === 'PRIVATE'

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
            `[配额限制] 目录无法分析：${item.path}`,
            error.message
          )
          this.updateItemStatus(item.id, 'failed', 0, error.message)
          this.pause() // 配额超限，立即暂停队列
          return
        }
      }

      if (!deps.unitRecognitionService) {
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          '[分析队列] UnitRecognitionService未初始化，尝试重新初始化适配器...'
        )
        try {
          const adapters = await createCoreEngineAdapters()
          if (adapters) {
            this.reinitAdapters(adapters)
          }
        } catch (reinitError) {
          logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 适配器重新初始化失败:', reinitError)
        }

        const newDeps = this.getDependencies()
        if (!newDeps.unitRecognitionService) {
          this.updateItemStatus(item.id, 'failed', 100, 'UnitRecognitionService未初始化 (重试失败)')
          return
        }
      }

      this.updateItemStatus(item.id, 'analyzing', 10)
      const unitRecognitionService = this.getDependencies().unitRecognitionService!

      // 检查是否启用最小单元识别（控制可选识别器：设计工程/音频专辑/系列文件）
      const enableUnitRecognition =
        ConfigOrchestrator.getInstance().getValue<boolean>('ENABLE_UNIT_RECOGNITION')

      // 始终运行内置识别器（系统目录/软件安装/缓存/虚拟环境/工程项目/游戏包/数据集）
      // 开关关闭时跳过可选识别器（设计工程/音频专辑/系列文件）
      const unitResult = await unitRecognitionService.recognizeDirectory(
        item.path,
        !enableUnitRecognition
      )

      if (unitResult.isUnit) {
        item.isUnit = true
        item.unitType = unitResult.unitType
        item.unitReason = unitResult.reason
        item.unitConfidence = unitResult.confidence

        const parentPath = path.dirname(item.path)
        let workspaceId = await databaseService.getWorkspaceIdByPath(parentPath)
        // 后备：如果父路径查找失败，使用配额检查时已获取的工作区根目录 ID
        if (!workspaceId && rootWorkspaceDir?.id) {
          workspaceId = rootWorkspaceDir.id
        }
        if (!workspaceId) {
          throw new Error(`未找到路径 ${parentPath} 对应的工作区`)
        }
        // 从识别结果生成基础分析数据
        const baseTags: string[] = []
        if (unitResult.unitType) baseTags.push(unitResult.unitType)
        if (unitResult.unitType?.startsWith('project')) baseTags.push('project')
        const baseQuality = unitResult.confidence
          ? Math.round(Math.min(unitResult.confidence * 10, 10))
          : undefined

        const createdUnit = await databaseService.createUnit({
          name: path.basename(item.path),
          type: unitResult.unitType || 'unit',
          path: item.path,
          description: unitResult.reason,
          qualityScore: baseQuality,
          tags: baseTags,
          groupingReason: unitResult.reason,
          groupingConfidence: unitResult.confidence,
          workspaceId: workspaceId
        })

        // 对最小单元进行目录上下文 AI 分析，生成标签、描述等
        this.updateItemStatus(item.id, 'analyzing', 30)
        try {
          const contextAnalysis = await this.analyzeDirectoryContext(
            item.path,
            !!item.forceReanalyze
          )
          if (contextAnalysis && createdUnit) {
            const updateData: any = { updatedAt: new Date().toISOString() }
            // 合并 AI 推荐标签
            const aiTags = [...baseTags]
            if (contextAnalysis.recommendedTags) {
              const allRecommended = new Set<string>()
              for (const tagList of Object.values(contextAnalysis.recommendedTags)) {
                tagList.forEach(t => allRecommended.add(t))
              }
              if (allRecommended.size > 0) {
                aiTags.push(...Array.from(allRecommended))
              }
            }
            if (contextAnalysis.directoryType && !aiTags.includes(contextAnalysis.directoryType)) {
              aiTags.push(contextAnalysis.directoryType)
            }

            const smartName =
              contextAnalysis.namingPattern ||
              contextAnalysis.directoryType ||
              path.basename(item.path)

            updateData.tags = aiTags
            updateData.name = smartName
            updateData.isAnalyzed = true
            updateData.analyzedAt = new Date().toISOString()

            // 如果 contextAnalysis 有 confidence，更新 qualityScore
            if (contextAnalysis.confidence && baseQuality !== undefined) {
              updateData.quality_score = Math.round(
                Math.min(Math.max(baseQuality, contextAnalysis.confidence * 10), 10)
              )
            }

            await databaseService.updateUnit(createdUnit.id, updateData)
            logger.info(
              LogCategory.ANALYSIS_QUEUE,
              `[单元分析] 最小单元 AI 分析完成: ${item.path}`,
              {
                unitType: unitResult.unitType,
                tagsCount: aiTags.length
              }
            )
          }
        } catch (ctxError) {
          logger.warn(
            LogCategory.ANALYSIS_QUEUE,
            `[单元分析] 最小单元上下文分析失败 (跳过): ${item.path}`,
            ctxError
          )
        }
        this.updateItemStatus(item.id, 'completed', 100)
      } else {
        // 如果是非最小单元目录，先进行目录上下文分析
        // 检测是否因关闭最小单元识别而导致状态变化：如果关闭了且之前有单元记录，需强制刷新分析
        let forceContextAnalysis = !!item.forceReanalyze
        if (!enableUnitRecognition) {
          const prevUnit = databaseService.db
            ?.prepare('SELECT id FROM file_units WHERE path = ?')
            .get(item.path) as any
          if (prevUnit) {
            this.directoryContextCache.delete(item.path)
            forceContextAnalysis = true
            // 删除旧的 file_units 记录，避免 read-directory 再次标记为最小单元
            databaseService.db?.prepare('DELETE FROM file_units WHERE id = ?').run(prevUnit.id)
            logger.info(
              LogCategory.ANALYSIS_QUEUE,
              `[分析队列] 最小单元已关闭，目录之前是最小单元，清除单元记录并强制刷新上下文分析: ${item.path}`
            )
          }
        }

        this.updateItemStatus(item.id, 'analyzing', 20)
        try {
          await this.analyzeDirectoryContext(item.path, forceContextAnalysis)
        } catch (ctxError) {
          logger.warn(
            LogCategory.ANALYSIS_QUEUE,
            `[分析队列] 目录上下文分析失败 (跳过并继续展开): ${item.path}`,
            ctxError
          )
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

  /**
   * 分析目录上下文
   * @param cacheOnly 为 true 时仅读取内存缓存，不触发 AI 分析（适用于 simple 模式）
   */
  async analyzeDirectoryContext(
    directoryPath: string,
    force = false,
    cacheOnly = false
  ): Promise<DirectoryContextAnalysis | null> {
    const deps = this.getDependencies()
    if (!force && this.directoryContextCache.has(directoryPath))
      return this.directoryContextCache.get(directoryPath)!
    // cacheOnly 模式：仅读内存缓存，不触发 directoryContextService 分析
    if (cacheOnly) return null
    if (!deps.directoryContextService) return null
    const userLanguage =
      ConfigOrchestrator.getInstance().getValue<LanguageCode>('DEFAULT_LANGUAGE') || 'zh-CN'
    const contextAnalysis = await deps.directoryContextService.analyzeDirectoryContext(
      directoryPath,
      userLanguage as LanguageCode,
      force
    )
    this.directoryContextCache.set(directoryPath, contextAnalysis)
    if (contextAnalysis && this.onDirectoryCompleted) {
      this.onDirectoryCompleted(directoryPath)
    }
    return contextAnalysis
  }

  /**
   * 展开目录内容到队列
   */
  private async expandDirectoryToQueue(
    directoryPath: string,
    forceReanalyze: boolean
  ): Promise<void> {
    const deps = this.getDependencies()
    const entries = fs.readdirSync(directoryPath, { withFileTypes: true })
    const newItems: EnqueueInput[] = []

    // 第一步：确保所有子目录/文件记录存在于数据库中
    for (const entry of entries) {
      const fullPath = path.join(directoryPath, entry.name)
      if (shouldIgnoreFile(fullPath, entry.name, deps.ignoreRules)) continue

      if (entry.isDirectory()) {
        // 确保目录记录存在
        const dir = databaseService.db
          ?.prepare(`SELECT id FROM workspace_directories WHERE path = ?`)
          .get(fullPath) as any
        if (!dir) {
          const ws = await databaseService.findRootWorkspaceDirectory(fullPath)
          if (ws && ws.id) {
            await databaseService.addDirectory(fullPath, ws.id)
          }
        }
        newItems.push({ path: fullPath, name: entry.name, size: 0, type: 'folder' })
      } else {
        const stat = fs.statSync(fullPath)
        // 确保文件记录存在
        const wf = databaseService.db
          ?.prepare(`SELECT id FROM workspace_files WHERE path = ?`)
          .get(fullPath) as any
        if (!wf) {
          const ws = await databaseService.findRootWorkspaceDirectory(directoryPath)
          if (ws && ws.id) {
            await databaseService.addFileFromPath(fullPath, '', ws.id)
          }
        }
        newItems.push({
          path: fullPath,
          name: entry.name,
          size: stat.size,
          type: path.extname(entry.name).toLowerCase() || 'file'
        })
      }
    }

    if (newItems.length > 0) await this.addItems(newItems, forceReanalyze)
  }
}
