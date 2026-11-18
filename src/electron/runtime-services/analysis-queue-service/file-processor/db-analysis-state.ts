import { LogCategory, logger, FileCategory, getFileCategory } from '@firefly/shared'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'
import { omniClient } from '../../../services/omni-client'
import { decompressText } from '../../../utils/text-compressor'

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
 * 基础数据完整性校验结果
 */
export interface BasicDataCompletenessResult {
  isComplete: boolean
  missingReasons: string[]
}

/**
 * 检查文件核心基础数据与向量数据的健全性（用于决定重新分析时是否安全复用并跳过 CPU 阶段）
 * 涵盖：全量/切片向量探活、文本内容/摘要、图片/文档 OCR、音频 ASR/LRC 等
 */
export async function checkBasicDataCompleteness(
  db: any,
  workspaceId: number,
  filePath: string,
  fingerprint?: string
): Promise<BasicDataCompletenessResult> {
  const missingReasons: string[] = []
  if (!fingerprint) {
    return { isComplete: false, missingReasons: ['no_fingerprint'] }
  }

  const category = getFileCategory(filePath)

  // 1. 物理向量探活 (Omni zvec)
  const profile =
    ConfigOrchestrator.getInstance().getValue<string>('AI_EMBEDDING_PROFILE') || 'gemma_unified'
  const targetDim =
    profile === 'gemma_unified' || profile.includes('gemma')
      ? (ConfigOrchestrator.getInstance().getValue<number>('EMBEDDING_MRL_DIMENSION') ?? 512)
      : 384

  if (category === FileCategory.VIDEO) {
    // 视频：检查切片记录与切片向量
    try {
      const chunkRows = db
        .prepare(
          'SELECT chunk_index, sampling_interval_seconds, start_sec, end_sec FROM file_video_chunks WHERE file_fingerprint = ? ORDER BY chunk_index ASC'
        )
        .all(fingerprint) as Array<{
        chunk_index?: number
        sampling_interval_seconds?: number
        start_sec?: number
        end_sec?: number
      }>

      if (!chunkRows || chunkRows.length === 0) {
        missingReasons.push('missing_video_chunks')
      } else {
        // 抽帧间隔已由引擎按预算自决（设置页已移除该项），不再与配置比对；
        // 只保留「切片跨度是否与其自身记录的间隔吻合」的缓存升级防护。
        const firstChunk = chunkRows[0]
        const recordedInterval = firstChunk.sampling_interval_seconds ?? 1.0
        // 真实镜头切片（sampling_interval_seconds <= 0）：起止由自然镜头边界自决，跳过滑动窗口 span 过期判定
        const isShotBased = recordedInterval <= 0
        // 旧 8s 切片缓存自动升级防护（Ticket 04 & Spec §4.3）：
        // 检查首切片跨度是否与新公式 Math.min(16, Math.max(4, interval * 2)) 吻合
        const expectedSpan = Math.min(16, Math.max(4, recordedInterval * 2))
        const firstSpan = (firstChunk.end_sec ?? 0) - (firstChunk.start_sec ?? 0)
        // 兼容 Omni 原生标准 4.0s 切片跨度（stsz选美默认），避免标准切片被误判过期触发无休止重跑
        const isSpanOutdated =
          !isShotBased &&
          chunkRows.length > 1 &&
          Math.abs(firstSpan - expectedSpan) >= 0.5 &&
          Math.abs(firstSpan - 4.0) >= 0.5
        if (isSpanOutdated) {
          missingReasons.push(`video_chunk_span_outdated_${firstSpan}_vs_${expectedSpan}`)
        } else {
          const probeFp = `${fingerprint}:c${firstChunk.chunk_index ?? 0}`
          try {
            const probeRes = await omniClient.getVectors([probeFp], targetDim, 3000)
            if (!probeRes?.vectors || probeRes.vectors.length === 0) {
              missingReasons.push('missing_video_chunk_vectors')
            }
          } catch {
            missingReasons.push('video_vector_probe_error')
          }
        }
      }
    } catch {
      missingReasons.push('query_video_chunks_error')
    }
  } else {
    // 非视频文件（文档、图片、音频、代码等）：探活主文件物理向量
    try {
      const probeRes = await omniClient.getVectors([fingerprint], targetDim, 3000)
      if (!probeRes?.vectors || probeRes.vectors.length === 0) {
        missingReasons.push('missing_file_vector')
      }
    } catch {
      missingReasons.push('file_vector_probe_error')
    }
  }

  // 2. 查询 file_contents 表中的内容提取数据
  let contentRow:
    | {
        content?: Buffer | string
        ocr?: Buffer | string
        lrc?: Buffer | string
        asr?: Buffer | string
        exif?: Buffer | string
      }
    | undefined

  try {
    contentRow = db
      .prepare('SELECT content, ocr, lrc, asr, exif FROM file_contents WHERE file_fingerprint = ?')
      .get(fingerprint)
  } catch {
    missingReasons.push('query_file_contents_error')
  }

  // 解压文本字段安全判定
  const hasContent = contentRow?.content
    ? decompressText(contentRow.content as any).trim().length > 0
    : false
  const hasOcr = contentRow?.ocr ? decompressText(contentRow.ocr as any).trim().length > 0 : false
  const hasLrc = contentRow?.lrc ? decompressText(contentRow.lrc as any).trim().length > 0 : false
  const hasAsr = contentRow?.asr ? decompressText(contentRow.asr as any).trim().length > 0 : false

  // 3. 针对不同类型文件的基础数据健全性检查
  if (
    category === FileCategory.DOCUMENT ||
    category === FileCategory.TEXT ||
    category === FileCategory.CODE
  ) {
    // 文档/代码/纯文本：必须存在内容/摘要
    if (!hasContent) {
      missingReasons.push('missing_document_content')
    }
  } else if (category === FileCategory.IMAGE) {
    // 图片：
    // a) 检查缩略图
    try {
      const wsRow = db
        .prepare('SELECT thumbnail_path FROM workspace_files WHERE workspace_id = ? AND path = ?')
        .get(workspaceId, filePath) as { thumbnail_path?: string } | undefined
      if (!wsRow?.thumbnail_path) {
        missingReasons.push('missing_thumbnail')
      }
    } catch {
      missingReasons.push('thumbnail_check_error')
    }

    // b) 检查 OCR：如果配置启用了图片 OCR (ENABLE_IMAGE_OCR)，且图片未曾提取过 OCR/Content
    const enableImageOcr =
      ConfigOrchestrator.getInstance().getValue<boolean>('ENABLE_IMAGE_OCR') ?? true
    if (enableImageOcr && !hasOcr && !hasContent) {
      missingReasons.push('missing_image_ocr')
    }
  } else if (category === FileCategory.AUDIO) {
    // 音频：应检查是否有歌词 (lrc) 或 ASR 语音转录 (asr) 或内容 (content)
    if (!hasLrc && !hasAsr && !hasContent) {
      missingReasons.push('missing_audio_transcript_or_lyrics')
    }
  }

  return {
    isComplete: missingReasons.length === 0,
    missingReasons
  }
}
