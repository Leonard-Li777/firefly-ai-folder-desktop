import { AnalysisQueueItem, LanguageCode, FileCategory as MagikaCategory } from '@firefly/types'
import { LogCategory, logger, PerformanceTimer, FileCategory, isCategory } from '@firefly/shared'
import { t } from '@app/languages'
import {
  FileProcessorService,
  DimensionAnalyzer,
  FileDimensionService,
  type FileInfoInput,
  extractPureLyrics
} from '@firefly/core-engine'
import { IErrorRecoveryConfig } from '../types'
import { databaseService } from '../../database/database-service'
import path from 'node:path'

/**
 * 处理本地 AI 分析任务（质量评分 + 维度标签）
 */
export async function processLocalAnalysis(
  item: AnalysisQueueItem,
  fileFingerprint: string,
  fileInfo: FileInfoInput,
  thumbnailRelativePath: string | undefined,
  rootWorkspaceDirPath: string,
  timer: PerformanceTimer,
  deps: {
    fileProcessor: FileProcessorService | undefined
    dimensionAnalyzer: DimensionAnalyzer | undefined
    fileDimensionService: FileDimensionService | undefined
    errorRecoveryConfig: IErrorRecoveryConfig
  },
  options: {
    language: string
    directoryContext: any
    magikaCategory: MagikaCategory | null
    isSpeedy: boolean
    initialStage?: number
    forceReanalyze?: boolean
  },
  updateItemStatus: (
    itemId: number,
    status: any,
    progress: number,
    error?: string,
    extra?: any
  ) => void,
  processNewDimensionSuggestions: (suggestions: any[], fileFingerprint: string) => Promise<void>
): Promise<any> {
  const { language, directoryContext, magikaCategory, isSpeedy } = options

  // ========== 第三阶段：AI 文件质量分析 ==========
  updateItemStatus(item.id, 'analyzing', 12, undefined, { analysisStage: 3 })
  timer.start('qualityScoring')
  let processResult: any
  // AI 质量评分（stage3）与复用开关无关（复用开关只控制 stage1/2 的 CPU 提取数据）：
  // 仅当文件已处于 stage 3 且不是强制重新分析时，复用已有质量数据；否则重新运行 AI 质量评分
  if (options.initialStage === 3 && !options.forceReanalyze) {
    logger.info(
      LogCategory.ANALYSIS_QUEUE,
      `[阶段复用] 已处于 stage 3 且非重新分析，复用已有质量数据，跳过 AI 质量评分: ${item.name}`
    )
    const db = databaseService.db
    let existingQuality: any = {}
    if (db) {
      existingQuality =
        db
          .prepare(
            `
        SELECT quality_score, quality_confidence, quality_reasoning, quality_criteria, content, metadata, multimodal_content, lrc
        FROM file_contents
        WHERE file_fingerprint = ?
      `
          )
          .get(fileFingerprint) || {}
    }
    processResult = {
      content: fileInfo.content || existingQuality.content || '',
      metadata: (() => {
        if (fileInfo.metadata && Object.keys(fileInfo.metadata).length > 0) return fileInfo.metadata
        if (!existingQuality.metadata) return {}
        if (typeof existingQuality.metadata === 'string') {
          try {
            return JSON.parse(existingQuality.metadata)
          } catch {
            return {}
          }
        }
        return existingQuality.metadata
      })(),
      qualityScore: existingQuality.quality_score ?? 3,
      qualityConfidence: existingQuality.quality_confidence ?? 0.5,
      qualityReasoning: existingQuality.quality_reasoning ?? undefined,
      qualityCriteria: (() => {
        if (!existingQuality.quality_criteria) return undefined
        if (typeof existingQuality.quality_criteria === 'string') {
          try {
            return JSON.parse(existingQuality.quality_criteria)
          } catch {
            return undefined
          }
        }
        return existingQuality.quality_criteria
      })(),
      multimodalContent: existingQuality.multimodal_content ?? undefined,
      lrc: existingQuality.lrc ?? undefined
    }
  } else {
    processResult = deps.fileProcessor
      ? await deps.fileProcessor.processFileWithTimeout(
          fileFingerprint,
          fileInfo,
          thumbnailRelativePath
            ? path.join(rootWorkspaceDirPath, thumbnailRelativePath)
            : undefined,
          deps.errorRecoveryConfig.fileProcessingTimeout,
          isSpeedy
        )
      : {
          content: fileInfo.content,
          metadata: fileInfo.metadata,
          qualityScore: 3,
          qualityConfidence: 0.5,
          multimodalContent: undefined,
          lrc: undefined,
          qualityReasoning: undefined,
          qualityCriteria: undefined
        }
  }
  timer.end('qualityScoring')

  // --- 歌词处理增强逻辑 ---
  const filePath = fileInfo.path
  const fileType = fileInfo.type
  const isAudio = fileType === 'audio' || isCategory(filePath || '', FileCategory.AUDIO)
  if (isAudio) {
    const metadataLyrics = getFallbackLyrics(processResult.metadata)
    const aiLyrics = processResult.lrc || ''

    if (metadataLyrics) {
      if (!aiLyrics || aiLyrics.trim().length < metadataLyrics.trim().length) {
        processResult.lrc = metadataLyrics
      }
    }
  }

  // 实时更新并写入 Stage 3 状态与质量分数等结果
  try {
    await databaseService.updateAnalysisStageAndQuality(fileFingerprint, 3, {
      qualityScore: processResult.qualityScore,
      qualityConfidence: processResult.qualityConfidence,
      qualityReasoning: processResult.qualityReasoning,
      qualityCriteria: processResult.qualityCriteria
    })
  } catch (dbError) {
    logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 实时写入 Stage 3 状态失败:', dbError)
  }

  updateItemStatus(item.id, 'analyzing', 15, undefined, { analysisStage: 3 })

  if (!deps.dimensionAnalyzer || !deps.fileDimensionService) throw new Error(t('AI 服务未就绪'))

  // ========== 第四阶段：AI 目录分析 ==========
  // 目录上下文已提前获取，此处直接复用
  updateItemStatus(item.id, 'analyzing', 55, undefined, { analysisStage: 4 })

  const existingDimensions = await deps.fileDimensionService.getDimensionsByLanguage(
    language as LanguageCode
  )

  // ========== 第五阶段：AI 标签维度分析 ==========
  timer.start('dimensionAnalysis')
  const dimResult = await deps.dimensionAnalyzer.analyzeFileWithDimensions(
    filePath,
    item.name,
    fileType,
    fileInfo.size,
    processResult.content || '',
    processResult.multimodalContent,
    processResult.qualityScore || 3,
    processResult.metadata,
    existingDimensions,
    directoryContext,
    magikaCategory,
    isSpeedy
  )

  if (dimResult) {
    const isAudio = fileType === 'audio' || isCategory(filePath || '', FileCategory.AUDIO)
    if (isAudio) {
      const metadataLyrics = getFallbackLyrics(processResult.metadata)
      const aiLyrics = (dimResult.lrc || processResult.lrc || '').trim()

      if (metadataLyrics && (!aiLyrics || aiLyrics.length < metadataLyrics.trim().length)) {
        dimResult.lrc = metadataLyrics
        processResult.lrc = metadataLyrics
      } else if (aiLyrics) {
        processResult.lrc = aiLyrics
        dimResult.lrc = aiLyrics
      }

      if (processResult.lrc && databaseService.db) {
        try {
          databaseService.db
            .prepare(
              `
            INSERT INTO file_contents (file_fingerprint, lrc)
            VALUES (?, ?)
            ON CONFLICT(file_fingerprint) DO UPDATE SET
              lrc = excluded.lrc
            `
            )
            .run(fileFingerprint, processResult.lrc)
        } catch (lrcDbErr) {
          logger.error(
            LogCategory.ANALYSIS_QUEUE,
            '[分析队列] 更新歌词/台词至数据库失败:',
            lrcDbErr
          )
        }
      }
    }

    await deps.dimensionAnalyzer.saveDimensionAnalysisResults(
      fileFingerprint,
      filePath,
      dimResult,
      processResult.metadata,
      magikaCategory
    )
    if (dimResult.newDimensions)
      await processNewDimensionSuggestions(dimResult.newDimensions, fileFingerprint)
  }
  timer.end('dimensionAnalysis')

  return { processResult, dimResult }
}

/**
 * 从元数据中提取候选歌词
 */
function getFallbackLyrics(metadata: any): string | null {
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
