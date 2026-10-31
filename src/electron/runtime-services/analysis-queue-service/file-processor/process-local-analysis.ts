import { AnalysisQueueItem, MagikaFileCategory as MagikaCategory } from '@firefly/types'
import { LogCategory, logger, PerformanceTimer, FileCategory, isCategory } from '@firefly/shared'
import { t } from '@app/languages'
import {
  FileProcessorService,
  DimensionAnalyzer,
  type FileInfoInput,
  extractPureLyrics
} from '@firefly/core-engine'
import { ConfigDbManager } from '../../config/config-db-manager'
import { IErrorRecoveryConfig } from '../types'
import { databaseService } from '../../database/database-service'
import path from 'node:path'
import { compressText, decompressText, decompressJson } from '../../../utils/text-compressor'
import {
  resolveAnalysisTimeoutBudget,
  resolveAiStageTimeoutMs
} from '../../system/analysis-timeout-policy'

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
    errorRecoveryConfig: IErrorRecoveryConfig
  },
  options: {
    language: string
    directoryContext: any
    magikaCategory: MagikaCategory | null
    isSpeedy: boolean
    initialStage?: number
    forceReanalyze?: boolean
    lrc?: string | null
    /** 并行流水线下 CPU 阶段已用时长（毫秒）：本次 timer 从 GPU 阶段起算，需补上这段 */
    elapsedBeforeAiMs?: number
  },
  updateItemStatus: (
    itemId: number,
    status: any,
    progress: number,
    error?: string,
    extra?: any
  ) => void
): Promise<any> {
  const { language, directoryContext, magikaCategory, isSpeedy } = options

  // AI 阶段超时 = 该类型总额 − 本文件已用时间，但不低于该类型的 AI 保底值。
  // 总额按「统一基数 120s + 类型增量（音频 +30s / 视频 +60s / 文档 0）」求解，
  // 两段共享同一份额度：CPU 提前结束（短片/小文档）省下的时间自动归 AI（此消彼涨）。
  // 保底值：文档 45s / 音频 50s / 视频 80s —— 视频要跑多帧视觉理解，所以增量最大。
  // timer 由 processFile 在本次分析入口创建；并行流水线的 GPU 阶段另起 timer，
  // 由调用方通过 elapsedBeforeAiMs 补上 CPU 阶段耗时。
  // magika 的 mime 只用于兜底无扩展名的媒体文件：否则这类文件在 AI 阶段按文档算总额，
  // 会比 perceive 侧实际给出的 CPU 上限少 60s，两段口径对不上。
  const budget = resolveAnalysisTimeoutBudget(
    fileInfo.path,
    undefined,
    false,
    options.magikaCategory?.mime_type
  )
  const elapsedMs = timer.getTotalDuration() + (options.elapsedBeforeAiMs ?? 0)
  const aiStageTimeoutMs = resolveAiStageTimeoutMs(budget, elapsedMs)
  // 只在前面阶段确实吃掉可观额度时打点（≥10s，基本只有音视频会命中），避免每个文件都刷一行
  if (elapsedMs >= 10000) {
    logger.info(
      LogCategory.ANALYSIS_QUEUE,
      `[分析队列] AI 阶段预算 ${aiStageTimeoutMs}ms（总 ${budget.totalMs}ms − 已用 ${elapsedMs}ms，` +
        `${budget.kind} 保底 ${budget.aiReserveMs}ms）: ${item.name}`
    )
  }

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
        SELECT quality_score, quality_confidence, quality_reasoning, quality_criteria, content, exif, multimodal_content, lrc
        FROM file_contents
        WHERE file_fingerprint = ?
      `
          )
          .get(fileFingerprint) || {}
    }
    processResult = {
      content: fileInfo.content || decompressText(existingQuality.content) || '',
      metadata: (() => {
        if (fileInfo.metadata && Object.keys(fileInfo.metadata).length > 0) return fileInfo.metadata
        if (!existingQuality.exif) return {}
        // exif 列是 BLOB（compressText 压缩），需用 decompressJson 解压
        const parsedExif = decompressJson<Record<string, any>>(existingQuality.exif)
        return parsedExif ?? {}
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
      multimodalContent: existingQuality.multimodal_content
        ? decompressText(existingQuality.multimodal_content) || undefined
        : undefined,
      lrc: existingQuality.lrc
        ? decompressText(existingQuality.lrc) || undefined
        : undefined
    }
  } else {
    processResult = deps.fileProcessor
      ? await deps.fileProcessor.processFileWithTimeout(
          fileFingerprint,
          fileInfo,
          thumbnailRelativePath
            ? path.join(rootWorkspaceDirPath, thumbnailRelativePath)
            : undefined,
          aiStageTimeoutMs,
          isSpeedy
        )
      : {
          content: fileInfo.content,
          metadata: fileInfo.metadata,
          qualityScore: 3,
          qualityConfidence: 0.5,
          multimodalContent: undefined,
          lrc: options.lrc ?? undefined,
          qualityReasoning: undefined,
          qualityCriteria: undefined
        }
  }
  if (!processResult.lrc && options.lrc) {
    processResult.lrc = options.lrc
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

  if (!deps.dimensionAnalyzer) throw new Error(t('AI 服务未就绪'))

  // ========== 第四阶段：AI 目录分析 ==========
  // 目录上下文已提前获取，此处直接复用
  updateItemStatus(item.id, 'analyzing', 55, undefined, { analysisStage: 4 })

  const existingDimensions = ConfigDbManager.getInstance().getFileDimensions()

  // ========== 第五阶段：AI 智能命名与维度标签分析 ==========
  // 增强分析（quick_name）与全面分析（full）共用同一套「快速命名」提示词（QuickNamingSystemPrompt）。
  // 全面分析相对增强分析只多出上方的「质量评分 + 多模态描述」一步：此处把该步产出的多模态描述
  // 并入正文再交给命名模型，避免音频/视频（不传 filePath，无视觉直读）在命名时丢失多模态信息。
  timer.start('dimensionAnalysis')
  const namingContent =
    (processResult.multimodalContent?.trim()
      ? `\n**${t('概要')}**：${processResult.multimodalContent.trim()}\n`
      : '') +
    (processResult.content?.trim() ? `\n**${t('正文')}**：${processResult.content.trim()}\n` : '')

  const dimResult = await deps.dimensionAnalyzer.quickAnalyzeFile(
    filePath,
    item.name,
    fileType,
    fileInfo.size,
    namingContent,
    processResult.metadata,
    existingDimensions,
    directoryContext,
    magikaCategory,
    isSpeedy,
    // 全面分析额外携带质量评分：既是「全面 vs 增强」的判别位（传入即全面），也驱动「文件质量」
    // 维度的确定性映射。沿用历史 `|| 3` 兜底：Stage 3 正常/降级均会给出 1~10 分，此处兜底仅防
    // 极端缺值——若传 undefined 会被下游误判为「增强分析」而整体跳过质量分与 GPS 找补。
    processResult.qualityScore ?? 3
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
            .run(fileFingerprint, compressText(processResult.lrc))
        } catch (lrcDbErr) {
          logger.error(
            LogCategory.ANALYSIS_QUEUE,
            '[分析队列] 更新歌词/台词至数据库失败:',
            lrcDbErr
          )
        }
      }
    }

    // 标签持久化统一由外层 executeProTagReconciliation / TagReconciliationArbiter 权威仲裁并单事务原子持久化
    // 杜绝此处双重写入及以 'fact' 组落库大模型语义标签的违规行为 (DEC-08 / Action-B)
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
