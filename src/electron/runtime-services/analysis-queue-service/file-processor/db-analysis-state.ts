import path from 'node:path'
import { LogCategory, logger, FileCategory, getFileCategory } from '@firefly/shared'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'
import { omniClient } from '../../../services/omni-client'
import { decompressText } from '../../../utils/text-compressor'
import type { EffectiveWorkspaceAIConfigResult } from '../../system/workspace-analysis-context'

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
  effectiveConfig: EffectiveWorkspaceAIConfigResult,
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
        analysis_stats?: string
      }
    | undefined

  try {
    contentRow = db
      .prepare(
        'SELECT content, ocr, lrc, asr, exif, analysis_stats FROM file_contents WHERE file_fingerprint = ?'
      )
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

  // [V11-06] attempted_empty 二元组指纹：仅同一文件指纹且当前能力档位 <= 已试探档位时采纳短路，
  // 文件内容变化或能力升格（tiny->small / ASR 时长变长）立即失效重跑，杜绝永久漏提取与死循环。
  let attemptedEmpty:
    | {
        fileFingerprint?: string
        ocrModelSize?: 'tiny' | 'small'
        asrDurationSec?: number
        ocrEmpty?: boolean
        asrEmpty?: boolean
      }
    | undefined
  try {
    if (contentRow?.analysis_stats) {
      const stats = JSON.parse(contentRow.analysis_stats)
      if (stats && typeof stats.attempted_empty === 'object' && stats.attempted_empty) {
        attemptedEmpty = stats.attempted_empty
      }
    }
  } catch {
    // 解析失败视为无历史记录（保守重跑），静默忽略是安全的：不会导致漏提取
  }
  const ocrRank = (size?: string): number => (size === 'small' ? 2 : size === 'tiny' ? 1 : 0)
  const sameFingerprint = attemptedEmpty?.fileFingerprint === fingerprint
  const effectiveOcrValid =
    sameFingerprint && ocrRank(effectiveConfig.effectiveParams.ocrModelSize) <= ocrRank(attemptedEmpty?.ocrModelSize)
  const targetAsrSec =
    category === FileCategory.VIDEO
      ? effectiveConfig.effectiveParams.videoAsrDurationSec
      : effectiveConfig.effectiveParams.audioAnalysisDurationSec
  const effectiveAsrValid =
    sameFingerprint && targetAsrSec <= (attemptedEmpty?.asrDurationSec ?? -1)
  const OFFICE_COVER_EXTS = new Set([
    '.doc',
    '.docx',
    '.xls',
    '.xlsx',
    '.ppt',
    '.pptx',
    '.odt',
    '.ods',
    '.odp',
    '.wps',
    '.et',
    '.dps'
  ])

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
    // Office 文档封面缺口：仅当工作区生效 enableOfficeCover === true 且缺失缩略图时判缺口
    const ext = path.extname(filePath).toLowerCase()
    if (effectiveConfig.effectiveParams.enableOfficeCover && OFFICE_COVER_EXTS.has(ext)) {
      try {
        const wsRow = db
          .prepare('SELECT thumbnail_path FROM workspace_files WHERE workspace_id = ? AND path = ?')
          .get(workspaceId, filePath) as { thumbnail_path?: string } | undefined
        if (!wsRow?.thumbnail_path) {
          missingReasons.push('missing_office_cover')
        }
      } catch (thumbErr) {
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          `[分析队列] 检查 Office 封面缩略图失败 (${filePath}):`,
          thumbErr
        )
        missingReasons.push('missing_office_cover')
      }
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

    // b) 仅当工作区 effectiveConfig 开启图片 OCR 且图片确无 OCR/Content 时才判缺口；
    // 命中有效 attempted_empty.ocrEmpty 则短路，避免降级态反复重跑（防死循环）
    if (
      effectiveConfig.effectiveParams.enableImageOcr &&
      !hasOcr &&
      !hasContent &&
      !(effectiveOcrValid && attemptedEmpty?.ocrEmpty)
    ) {
      missingReasons.push('missing_image_ocr')
    }
  } else if (category === FileCategory.AUDIO || category === FileCategory.VIDEO) {
    // 音频 / 视频：仅当 ASR 生效且对应媒介时长 > 0 且无歌词/转录/内容时判缺口；attempted_empty.asrEmpty 有效则短路
    if (
      effectiveConfig.capabilities.asrEffectivelyEnabled &&
      targetAsrSec > 0 &&
      !hasLrc &&
      !hasAsr &&
      !hasContent &&
      !(effectiveAsrValid && attemptedEmpty?.asrEmpty)
    ) {
      missingReasons.push('missing_audio_transcript')
    }
  }

  return {
    isComplete: missingReasons.length === 0,
    missingReasons
  }
}

/**
 * 统计待增量补齐的可恢复文件数（contextEpoch 提升时轻量扫描）。
 * Free -> Pro 长视频续跑直接复用既有 file_video_segments 外键同源事实：
 * `file_video_segments.file_id TEXT NOT NULL` 直指 `files(file_fingerprint)`（database.ts:481/495），
 * 零新表零新索引、零 ALTER TABLE。
 */
export function countRecoverableFiles(db: any, workspaceId: number): number {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM workspace_files wf
         WHERE wf.workspace_id = ?
           AND EXISTS (
             SELECT 1 FROM file_video_segments fvs
             WHERE fvs.file_id = wf.file_fingerprint AND fvs.status = 'pending'
           )`
      )
      .get(workspaceId) as { n?: number } | undefined
    return Number(row?.n ?? 0)
  } catch (error) {
    logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] 可恢复文件统计失败:', error)
    return 0
  }
}
