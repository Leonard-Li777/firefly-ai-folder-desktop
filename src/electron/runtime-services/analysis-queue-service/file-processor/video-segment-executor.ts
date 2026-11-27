// @doc-anchor: docs/specs/video-fast-first-slice-and-idle-backfill-spec.md#21-抽离公共原子单切片执行器-executesinglevideosegment
import fs from 'node:fs'
import { t } from '@app/languages'
import { LogCategory, logger } from '@firefly/shared'
import { OmniPerceptionHttpError, type OmniPerceptionOptions } from '../../system/omni-service/types'
import { classifyVisualPerceptionError } from './analysis-error-classifier'
import { visualTaggerCoordinator } from '../visual-tagger-coordinator'
import {
  cleanupOrphanedVideoChunksDiff,
  persistOmniVectors,
  type OmniVectorPersistenceParams
} from './omni-vector-persistence'
import {
  runVideoPerceiveWithDegradedRetry,
  serializeVideoDegradedMetadata,
  type VideoDegradedMetadata
} from './video-degraded-state-machine'

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
    markVideoSegmentTerminalFailed?: (fileId: string, segmentIndex: number, reason: string) => void
    recordVideoSegmentVisualFailureTx?: (params: {
      fileId: string
      segmentIndex: number
      errorMessage: string
      failureCode: string
      encoderId: number
      expectedFingerprint?: string | null
      markStateNonOk?: boolean
    }) => { failureGeneration: number }
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
  /** 异常未携带 encoderId 时动态解析当前激活视觉槽编码器 */
  resolveActiveEncoderId?: (encoderIdHint?: number) => number
  /** 409 `VISUAL_VOCAB_STALE` 对账触发回调（避免仅回滚 pending 而无对账唤醒） */
  onReconcile409?: (encoderId: number) => Promise<void> | void
  /** 仅用于单测注入降级退避等待函数 */
  degradedRetrySleep?: (ms: number, signal?: AbortSignal) => Promise<void>
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
  outcome: 'completed' | 'skipped' | 'missing_file' | 'aborted' | 'failed' | 'degraded'
  frameCount: number
  reason?: string
  degradedMetadata?: VideoDegradedMetadata
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
    // 4. 纯 Stage 2 视觉感知（强制禁 ASR、禁文本分析、禁缩略图、禁 5W），并接入预算降级状态机
    const perceiveOutcome = await runVideoPerceiveWithDegradedRetry(
      () =>
        deps.anydocService.perceive(filePath, {
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
        }),
      {
        filePath,
        perceiveTimeoutSec:
          perceptionParams.perceiveTimeoutSec ??
          (perceptionParams.timeoutMs ? perceptionParams.timeoutMs / 1000 : null),
        asrEstSec: 0,
        signal,
        sleep: deps.degradedRetrySleep
      }
    )

    if (perceiveOutcome.aborted || signal?.aborted) {
      deps.databaseService.rollbackVideoSegmentProcessing(fileFingerprint, segmentIndex)
      return { outcome: 'aborted', frameCount: 0, reason: 'aborted after perceive' }
    }

    if (perceiveOutcome.degradedRecord) {
      const degradedMeta: VideoDegradedMetadata = {
        status: 'analysis_degraded',
        degraded: perceiveOutcome.degradedRecord.degraded,
        perceive_timeout_sec: perceiveOutcome.degradedRecord.perceive_timeout_sec,
        asr_est_sec: perceiveOutcome.degradedRecord.asr_est_sec,
        degraded_reason: perceiveOutcome.degradedRecord.degraded_reason
      }
      const serializedMeta = serializeVideoDegradedMetadata(degradedMeta)
      if (typeof deps.databaseService.markVideoSegmentTerminalFailed === 'function') {
        deps.databaseService.markVideoSegmentTerminalFailed(
          fileFingerprint,
          segmentIndex,
          serializedMeta
        )
      } else {
        deps.databaseService.markVideoSegmentFailedOrPending(
          fileFingerprint,
          segmentIndex,
          serializedMeta
        )
      }
      return {
        outcome: 'degraded',
        frameCount: 0,
        reason: perceiveOutcome.degradedRecord.userMessage,
        degradedMetadata: degradedMeta
      }
    }

    const chunkResult = perceiveOutcome.result

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
    const visualDecision = classifyVisualPerceptionError(err)
    const reason = err?.message || String(err)
    if (visualDecision) {
      const encoderIdHint =
        err instanceof OmniPerceptionHttpError && typeof err.encoderId === 'number'
          ? err.encoderId
          : undefined
      const encoderId = encoderIdHint ?? deps.resolveActiveEncoderId?.(encoderIdHint) ?? 2
      if (visualDecision.kind === 'input_rejected_422') {
        if (typeof deps.databaseService.recordVideoSegmentVisualFailureTx === 'function') {
          deps.databaseService.recordVideoSegmentVisualFailureTx({
            fileId: fileFingerprint,
            segmentIndex,
            errorMessage: reason,
            failureCode: 'INPUT_REJECTED',
            encoderId,
            markStateNonOk: false
          })
        } else {
          deps.databaseService.markVideoSegmentTerminalFailed?.(fileFingerprint, segmentIndex, reason)
        }
        return { outcome: 'failed', frameCount: 0, reason: 'INPUT_REJECTED' }
      }
      if (visualDecision.kind === 'asset_failure_500') {
        let gen = 0
        if (typeof deps.databaseService.recordVideoSegmentVisualFailureTx === 'function') {
          gen = deps.databaseService.recordVideoSegmentVisualFailureTx({
            fileId: fileFingerprint,
            segmentIndex,
            errorMessage: reason,
            failureCode: visualDecision.failureCode,
            encoderId,
            markStateNonOk: true
          }).failureGeneration
        } else {
          deps.databaseService.markVideoSegmentTerminalFailed?.(fileFingerprint, segmentIndex, reason)
        }
        const breakerRes = visualTaggerCoordinator.recordAssetFailureForBreaker(encoderId, gen)
        if (breakerRes.newlyTripped) {
          visualTaggerCoordinator.notifyBreakerTripped(encoderId, gen)
        }
        return { outcome: 'failed', frameCount: 0, reason: visualDecision.failureCode }
      }
      if (visualDecision.kind === 'reconcile_409') {
        if (visualDecision.failureCode === 'needs_app_update') {
          const updateMsg = t('需要更新软件版本后才能继续自动识别视频画面标签')
          if (typeof deps.databaseService.recordVideoSegmentVisualFailureTx === 'function') {
            deps.databaseService.recordVideoSegmentVisualFailureTx({
              fileId: fileFingerprint,
              segmentIndex,
              errorMessage: updateMsg,
              failureCode: 'needs_app_update',
              encoderId,
              markStateNonOk: false
            })
          } else {
            deps.databaseService.markVideoSegmentTerminalFailed?.(fileFingerprint, segmentIndex, updateMsg)
          }
          return { outcome: 'failed', frameCount: 0, reason: 'needs_app_update' }
        }
        deps.databaseService.rollbackVideoSegmentProcessing(fileFingerprint, segmentIndex)
        try {
          await deps.onReconcile409?.(encoderId)
        } catch {
          // 回调异常不阻断回滚结果
        }
        return { outcome: 'skipped', frameCount: 0, reason: 'engine_not_ready_409' }
      }
      if (
        visualDecision.kind === 'transient_retry' ||
        visualDecision.kind === 'inference_bounded_retry'
      ) {
        const plainMsg =
          visualDecision.kind === 'transient_retry'
            ? t('本地识图服务暂时繁忙，稍后将自动重试')
            : t('当前视频片段画面识别遇到临时故障，稍后将自动重试')
        deps.databaseService.markVideoSegmentFailedOrPending(fileFingerprint, segmentIndex, plainMsg)
        return {
          outcome: 'failed',
          frameCount: 0,
          reason:
            visualDecision.kind === 'inference_bounded_retry'
              ? visualDecision.failureCode
              : `HTTP_${visualDecision.status}`
        }
      }
    }
    logger.warn(
      LogCategory.ANALYSIS_QUEUE,
      `[视频补全] 片段 ${segmentIndex} 分析异常: ${reason}`
    )
    deps.databaseService.markVideoSegmentFailedOrPending(fileFingerprint, segmentIndex, reason)
    return { outcome: 'failed', frameCount: 0, reason }
  }
}
