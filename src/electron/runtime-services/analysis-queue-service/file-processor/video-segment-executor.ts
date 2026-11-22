// @doc-anchor: docs/specs/video-fast-first-slice-and-idle-backfill-spec.md#21-抽离公共原子单切片执行器-executesinglevideosegment
import fs from 'node:fs'
import { LogCategory, logger } from '@firefly/shared'
import type { OmniPerceptionOptions } from '../../system/omni-service/types'
import {
  cleanupOrphanedVideoChunksDiff,
  persistOmniVectors,
  type OmniVectorPersistenceParams
} from './omni-vector-persistence'

export interface VideoSegmentDescriptor {
  fileFingerprint: string
  filePath: string
  segmentIndex: number
  startPtsSec: number
  endPtsSec: number
}

export interface VideoSegmentExecutorDeps {
  db: any
  databaseService: {
    markVideoSegmentProcessing: (fileId: string, segmentIndex: number) => boolean
    markVideoSegmentCompleted: (
      fileId: string,
      segmentIndex: number,
      stats: {
        frameCount: number
        visualEmbeddedCount: number
        asrTranscriptChars: number
        paramsHash?: string
      }
    ) => void
    markVideoSegmentFailedOrPending: (fileId: string, segmentIndex: number, reason: string) => void
    rollbackVideoSegmentProcessing: (fileId: string, segmentIndex: number) => void
    replaceVideoChunksInRange: (
      fileFingerprint: string,
      chunks: Array<{
        fileFingerprint: string
        chunkIndex: number
        startSec: number
        endSec: number
        repPtsSec: number
        meta: Record<string, any>
        samplingIntervalSeconds: number
      }>,
      startSec: number,
      endSec: number
    ) => void
  } & OmniVectorPersistenceParams['databaseService']
  anydocService: {
    perceive: (filePath: string, options?: OmniPerceptionOptions) => Promise<any>
  }
  omniClient: {
    deleteVectors: (fps: string[]) => Promise<any>
  }
  existsSync?: (p: string) => boolean
}

export interface ExecuteSingleVideoSegmentInput {
  segment: VideoSegmentDescriptor
  /** 当前工作区与云端权益取小后的有效上限（秒），用于防尾片 30s 容差越界 */
  effectiveLimitSec: number
  /** 本次提取使用的画面参数指纹，完成后同步回写 file_video_segments.params_hash */
  paramsHash: string
  /** 透传至 anydocService.perceive 的基础画面提取参数（不含起止时间与 ASR/缩略图开关） */
  perceptionParams: Omit<
    OmniPerceptionOptions,
    | 'videoAnalyzeStartSec'
    | 'videoMaxAnalyzeSec'
    | 'enableAudioTranscript'
    | 'videoAsrDurationSec'
    | 'audioAnalysisDuration'
    | 'enableTextAnalysis'
    | 'generateThumbnail'
    | 'fileFingerprint'
    | 'skip5wSynthesis'
    | 'signal'
  >
  signal?: AbortSignal
  deps: VideoSegmentExecutorDeps
}

export interface ExecuteSingleVideoSegmentResult {
  outcome: 'completed' | 'skipped' | 'missing_file' | 'aborted' | 'failed'
  frameCount: number
  reason?: string
}

/**
 * 公共原子单切片执行器（Spec §2.1）：
 * 执行单个 k >= 1 视频切片的纯视觉感知、差集孤儿向量清理、区间幂等落库、
 * 态 2/3 向量回传与状态完成回写。
 */
export async function executeSingleVideoSegment(
  input: ExecuteSingleVideoSegmentInput
): Promise<ExecuteSingleVideoSegmentResult> {
  const { segment, effectiveLimitSec, paramsHash, perceptionParams, signal, deps } = input
  const { fileFingerprint, filePath, segmentIndex, startPtsSec, endPtsSec } = segment
  const existsSync = deps.existsSync ?? fs.existsSync

  if (signal?.aborted) {
    return { outcome: 'aborted', frameCount: 0, reason: 'aborted before claim' }
  }

  // 1. 跨设备原文件存在性预检 (FIN-07)
  if (!existsSync(filePath)) {
    logger.debug(
      LogCategory.ANALYSIS_QUEUE,
      `[视频补全] 跨设备原文件不存在，跳过片段 ${segmentIndex}: ${filePath}`
    )
    return { outcome: 'missing_file', frameCount: 0, reason: 'file_not_found' }
  }

  // 2. 原子 CAS 认领
  const canProceed = deps.databaseService.markVideoSegmentProcessing(fileFingerprint, segmentIndex)
  if (!canProceed) {
    logger.warn(
      LogCategory.ANALYSIS_QUEUE,
      `[视频补全] 片段 ${segmentIndex} 重试超限熔断或已被认领，跳过: ${filePath}`
    )
    return { outcome: 'skipped', frameCount: 0, reason: 'cas_not_claimed' }
  }

  // 3. 强制截断终点，防尾片 30s 容差合并 (FIN-14) 越过有效上限
  const effectiveChunkEnd = Math.min(endPtsSec, effectiveLimitSec)
  if (effectiveChunkEnd <= startPtsSec) {
    deps.databaseService.rollbackVideoSegmentProcessing(fileFingerprint, segmentIndex)
    return { outcome: 'skipped', frameCount: 0, reason: 'beyond_effective_limit' }
  }

  try {
    // 4. 纯 Stage 2 视觉感知（强制禁 ASR、禁文本分析、禁缩略图、禁 5W）
    const chunkResult = await deps.anydocService.perceive(filePath, {
      ...perceptionParams,
      enableAudioTranscript: false,
      videoAsrDurationSec: 0,
      audioAnalysisDuration: 0,
      enableTextAnalysis: false,
      generateThumbnail: false,
      skip5wSynthesis: true,
      videoAnalyzeStartSec: startPtsSec,
      videoMaxAnalyzeSec: effectiveChunkEnd,
      fileFingerprint,
      signal
    })

    if (signal?.aborted) {
      deps.databaseService.rollbackVideoSegmentProcessing(fileFingerprint, segmentIndex)
      return { outcome: 'aborted', frameCount: 0, reason: 'aborted after perceive' }
    }

    const chunkFrames: any[] = chunkResult?.perception?.video_chunks || []
    if (chunkFrames.length === 0) {
      const reason = `perceive returned zero video chunks (seg ${segmentIndex})`
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        `[视频补全] 片段 ${segmentIndex} 未产出任何画面，标记失败等待重提（不写 completed）: ${filePath}`
      )
      deps.databaseService.markVideoSegmentFailedOrPending(fileFingerprint, segmentIndex, reason)
      return { outcome: 'failed', frameCount: 0, reason }
    }

    const segSamplingInterval = chunkResult?.perception?.video_sampling_interval_seconds ?? 1.0
    const newChunkIndices = chunkFrames.map(c => c.chunk_index ?? c.chunkIndex ?? 0)

    // 5a-5b. 写 SQLite 前差集清理旧区间孤儿向量（old \ new），杜绝态 1 误删刚写入的新向量
    await cleanupOrphanedVideoChunksDiff(
      deps.db,
      fileFingerprint,
      deps.omniClient,
      startPtsSec,
      effectiveChunkEnd,
      newChunkIndices
    )

    // 5c. 区间幂等替换 SQLite 切片元数据 (FIN-12)
    deps.databaseService.replaceVideoChunksInRange(
      fileFingerprint,
      chunkFrames.map(c => ({
        fileFingerprint,
        chunkIndex: c.chunk_index ?? c.chunkIndex ?? 0,
        startSec: c.start_sec ?? c.startSec ?? 0,
        endSec: c.end_sec ?? c.endSec ?? 0,
        repPtsSec: c.rep_pts_sec ?? c.repPtsSec ?? c.start_sec ?? c.startSec ?? 0,
        meta: c.meta || {},
        samplingIntervalSeconds: segSamplingInterval
      })),
      startPtsSec,
      effectiveChunkEnd
    )

    // 5d. 态 2 抛错 + 态 3 回传向量（严格模式：失败必抛错，阻断下方写假 completed）
    await persistOmniVectors({
      vectorSaved: chunkResult?.perception?.vector_saved,
      fileFingerprint,
      videoChunks: chunkFrames,
      databaseService: deps.databaseService,
      samplingIntervalSeconds: segSamplingInterval,
      throwOnChunkError: true
    })

    // 5e. 落库完成态并同步回写最新 paramsHash
    deps.databaseService.markVideoSegmentCompleted(fileFingerprint, segmentIndex, {
      frameCount: chunkFrames.length,
      visualEmbeddedCount: chunkFrames.length,
      asrTranscriptChars: 0,
      paramsHash
    })

    return { outcome: 'completed', frameCount: chunkFrames.length }
  } catch (err: any) {
    if (signal?.aborted || err?.name === 'AbortError') {
      deps.databaseService.rollbackVideoSegmentProcessing(fileFingerprint, segmentIndex)
      return { outcome: 'aborted', frameCount: 0, reason: err?.message || 'aborted' }
    }
    const reason = err?.message || String(err)
    logger.warn(
      LogCategory.ANALYSIS_QUEUE,
      `[视频补全] 片段 ${segmentIndex} 分析异常: ${reason}`
    )
    deps.databaseService.markVideoSegmentFailedOrPending(fileFingerprint, segmentIndex, reason)
    return { outcome: 'failed', frameCount: 0, reason }
  }
}
