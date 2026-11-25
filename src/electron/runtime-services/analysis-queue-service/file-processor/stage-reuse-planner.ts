import path from 'node:path'
import {
  LogCategory,
  logger,
  FileCategory,
  getFileCategory,
  computeVideoVisualParamsHash,
  isVideoSegmentReusable
} from '@firefly/shared'
import type {
  AnalysisQueueItem,
  AppliedAnalysisCapabilities,
  StageReuseDecision
} from '@firefly/types'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'
import { isAiStageEnabled, resolveEffectiveAnalysisMode } from '../../../config/analysis-mode'
import { omniClient } from '../../../services/omni-client'
import { decompressText } from '../../../utils/text-compressor'
import type { EffectiveWorkspaceAIConfigResult } from '../../system/workspace-analysis-context'

const PLAN_CHUNK_SIZE = 256
const MAX_GET_VECTORS_BATCH = 512

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

/** 进程级单调高水位（保证坏 JSON 重置与 ABA 场景下新 epoch 严格大于任意历史代际） */
let processEpochFloor = Date.now()

export function getProcessEpochFloor(): number {
  return processEpochFloor
}

function nextProcessEpochFloor(): number {
  processEpochFloor = Math.max(processEpochFloor + 1, Date.now())
  return processEpochFloor
}

/**
 * 纯 `UPDATE ... RETURNING` 递增 `file_contents.analysis_stats.retag_epoch`（Spec §2.2）。
 *
 * 契约：
 * - 不执行 `INSERT`（新文件在 CPU 段落库前尚未创建 `file_contents` 行，0 行命中返回 `0`，调用方不开启延迟清标）；
 * - 若原列是合法 JSON 对象（`json_valid === 1 && json_type === 'object'`），原地 `json_set` 仅改 `$.retag_epoch`，
 *   100% 保留 `appliedCapabilities` 等其他字段；
 * - 若原列为非空损坏 JSON 或非对象根（如 `'[]'`），先打 `warn` 再重置为 `{ retag_epoch: processEpochFloor }`。
 */
export function bumpRetagEpoch(db: any, fileFingerprint: string): number {
  if (!db || !fileFingerprint) return 0
  const floor = nextProcessEpochFloor()
  try {
    const preRow = db
      .prepare(
        `SELECT analysis_stats,
                json_valid(analysis_stats) AS is_valid,
                json_type(analysis_stats) AS jtype
         FROM file_contents
         WHERE file_fingerprint = ?`
      )
      .get(fileFingerprint) as
      | { analysis_stats?: string | null; is_valid?: number; jtype?: string | null }
      | undefined

    if (!preRow) {
      return 0
    }
    if (
      preRow.analysis_stats !== null &&
      preRow.analysis_stats !== undefined &&
      preRow.analysis_stats !== '' &&
      (preRow.is_valid !== 1 || preRow.jtype !== 'object')
    ) {
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        `[retagEpoch] 检测到异常非对象/损坏 analysis_stats，恢复为仅含 processEpochFloor (${floor}) 的对象: fp=${fileFingerprint}, type=${preRow.jtype ?? 'invalid'}`
      )
    }

    const row = db
      .prepare(
        `UPDATE file_contents
         SET analysis_stats = CASE
           WHEN json_valid(analysis_stats) AND json_type(analysis_stats) = 'object'
             THEN json_set(
               analysis_stats,
               '$.retag_epoch',
               MAX(COALESCE(CAST(json_extract(analysis_stats, '$.retag_epoch') AS INTEGER), 0) + 1, ?)
             )
           ELSE json_object('retag_epoch', ?)
         END
         WHERE file_fingerprint = ?
         RETURNING CAST(json_extract(analysis_stats, '$.retag_epoch') AS INTEGER) AS new_epoch`
      )
      .get(floor, floor, fileFingerprint) as { new_epoch?: number } | undefined

    return typeof row?.new_epoch === 'number' && Number.isFinite(row.new_epoch) ? row.new_epoch : 0
  } catch (err) {
    logger.warn(
      LogCategory.ANALYSIS_QUEUE,
      `[retagEpoch] bumpRetagEpoch 执行失败: fp=${fileFingerprint}`,
      err
    )
    return 0
  }
}

/**
 * 删项/Abort 守卫（双表职责拆分）：仅当 `analysis_queue` 中无其他活跃同指纹任务时递增全局 `retag_epoch`，
 * 避免工作区 A 删项或取消误杀同指纹工作区 B。
 */
export function bumpRetagEpochIfNoActiveTask(db: any, fileFingerprint: string): number {
  if (!db || !fileFingerprint) return 0
  try {
    const activeRow = db
      .prepare(
        `SELECT 1 AS hit
         FROM analysis_queue aq
         JOIN workspace_files wf ON wf.id = aq.item_id
         WHERE aq.item_type = 'file'
           AND wf.file_fingerprint = ?
           AND aq.status IN ('pending', 'analyzing', 'processing')
         LIMIT 1`
      )
      .get(fileFingerprint) as { hit?: number } | undefined
    if (activeRow?.hit === 1) {
      return 0
    }
  } catch (err) {
    logger.warn(
      LogCategory.ANALYSIS_QUEUE,
      `[retagEpoch] 查询同指纹活跃任务失败（保守继续 bump）: fp=${fileFingerprint}`,
      err
    )
  }
  return bumpRetagEpoch(db, fileFingerprint)
}

/** `workspace_files` 存在性检查：确认该指纹文件尚未从全仓彻底删除 */
export function hasAnyWorkspaceFileRef(db: any, fileFingerprint: string): boolean {
  if (!db || !fileFingerprint) return false
  try {
    const row = db
      .prepare('SELECT EXISTS(SELECT 1 FROM workspace_files WHERE file_fingerprint = ?) AS has_ws')
      .get(fileFingerprint) as { has_ws?: number } | undefined
    return row?.has_ws === 1
  } catch {
    return false
  }
}

/** 事务内严格代际与引用双验：`expectedEpoch > 0 && currentEpoch === expectedEpoch && has_ws === 1` */
export function validateRetagEpochStrict(
  db: any,
  fileFingerprint: string,
  expectedEpoch: number
): boolean {
  if (!db || !fileFingerprint || !Number.isFinite(expectedEpoch) || expectedEpoch <= 0) {
    return false
  }
  try {
    const row = db
      .prepare(
        `SELECT
           CAST(json_extract(fc.analysis_stats, '$.retag_epoch') AS INTEGER) AS cur_epoch,
           EXISTS(SELECT 1 FROM workspace_files wf WHERE wf.file_fingerprint = ?) AS has_ws
         FROM file_contents fc
         WHERE fc.file_fingerprint = ?
           AND json_valid(fc.analysis_stats)
           AND json_type(fc.analysis_stats) = 'object'`
      )
      .get(fileFingerprint, fileFingerprint) as
      | { cur_epoch?: number | null; has_ws?: number }
      | undefined
    if (!row || row.has_ws !== 1) return false
    return row.cur_epoch === expectedEpoch
  } catch {
    return false
  }
}

function ocrRank(size?: string): number {
  return size === 'small' ? 2 : size === 'tiny' ? 1 : 0
}

export function resolveTargetProfileAndDim(): { profile: string; targetDim: number } {
  const profile =
    ConfigOrchestrator.getInstance().getValue<string>('AI_EMBEDDING_PROFILE') || 'gemma_unified'
  const targetDim =
    profile === 'gemma_unified' || profile.includes('gemma')
      ? (ConfigOrchestrator.getInstance().getValue<number>('EMBEDDING_MRL_DIMENSION') ?? 512)
      : 384
  return { profile, targetDim }
}

interface ContentCandidateRow {
  file_fingerprint: string
  path: string
  is_analyzed?: number
  thumbnail_path?: string | null
  content?: Buffer | string | null
  ocr?: Buffer | string | null
  lrc?: Buffer | string | null
  asr?: Buffer | string | null
  exif?: Buffer | string | null
  analysis_stats?: string | null
}

function safeDecompress(val: Buffer | string | null | undefined): string {
  if (!val) return ''
  try {
    return decompressText(val as any).trim()
  } catch {
    return ''
  }
}

function parseAnalysisStatsSafe(raw: string | null | undefined): {
  analysisStage: number
  appliedCapabilities?: Partial<AppliedAnalysisCapabilities>
  attemptedEmpty?: {
    fileFingerprint?: string
    ocrModelSize?: 'tiny' | 'small'
    asrDurationSec?: number
    ocrEmpty?: boolean
    asrEmpty?: boolean
  }
} {
  if (!raw) return { analysisStage: 0 }
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { analysisStage: 0 }
    }
    return {
      analysisStage:
        typeof parsed.analysis_stage === 'number' && Number.isFinite(parsed.analysis_stage)
          ? parsed.analysis_stage
          : 0,
      appliedCapabilities:
        parsed.appliedCapabilities && typeof parsed.appliedCapabilities === 'object'
          ? parsed.appliedCapabilities
          : undefined,
      attemptedEmpty:
        parsed.attempted_empty && typeof parsed.attempted_empty === 'object'
          ? parsed.attempted_empty
          : undefined
    }
  } catch {
    return { analysisStage: 0 }
  }
}

function hasVisualOrNsfwCapabilitySatisfied(
  category: FileCategory,
  applied: Partial<AppliedAnalysisCapabilities> | undefined,
  effectiveConfig: EffectiveWorkspaceAIConfigResult,
  hasVisualOrFusedTagRel: boolean,
  hasContentRatingInExif: boolean
): string[] {
  const reasons: string[] = []
  const needsVisualCheck =
    category === FileCategory.IMAGE ||
    (category === FileCategory.VIDEO && effectiveConfig.capabilities.videoVisualAnalysisEnabled)
  if (!needsVisualCheck) return reasons

  if (applied?.visualTagsApplied === false) {
    reasons.push('missing_visual_tags')
  } else if (applied?.visualTagsApplied === undefined && !hasVisualOrFusedTagRel) {
    reasons.push('missing_visual_tags')
  }

  if (effectiveConfig.capabilities.nsfwEffectivelyEnabled) {
    if (applied?.nsfwApplied === false) {
      reasons.push('missing_nsfw_perception')
    } else if (applied?.nsfwApplied === undefined && !hasContentRatingInExif) {
      reasons.push('missing_nsfw_perception')
    }
  }
  return reasons
}

function buildFreshDecision(
  fingerprint: string | undefined,
  missingReasons: string[]
): StageReuseDecision {
  return {
    action: 'fresh_cpu_and_ai',
    skipCpu: false,
    ...(fingerprint ? { fingerprint } : {}),
    missingReasons,
    clearableTagGroups: ['fact', 'fused', 'visual'],
    preservedTagGroups: ['user']
  }
}

function buildReuseDecision(
  fingerprint: string,
  effectiveConfig: EffectiveWorkspaceAIConfigResult
): StageReuseDecision {
  const mode = effectiveConfig.effectiveParams.analysisMode ?? resolveEffectiveAnalysisMode()
  if (isAiStageEnabled(mode)) {
    return {
      action: 'reuse_cpu_refresh_ai',
      skipCpu: true,
      fingerprint,
      missingReasons: [],
      clearableTagGroups: ['ai'],
      preservedTagGroups: ['fact', 'fused', 'visual', 'user']
    }
  }
  return {
    action: 'reuse_cpu_resume_ai',
    skipCpu: true,
    fingerprint,
    missingReasons: [],
    clearableTagGroups: [],
    preservedTagGroups: ['fact', 'fused', 'visual', 'user', 'ai']
  }
}

/**
 * Stage 2/3 增量复用规划器（Spec §2.2 / §3.2）：
 * - `planBatch`：按至多 256 个队列项单次 SQLite 联查 + <=512 key `omniClient.getVectors` 批量探活；
 * - 统一 Stage 2 完备性判据（含 `file_video_segments` `seg_0` `analysis_degraded` 拦截、`[fp, ${fp}:tc0]` 探活、
 *   `appliedCapabilities` 的 `ocrSize` / `embeddingProfile` / `visualTagsApplied` / `nsfwApplied` 校验）。
 */
export class StageReusePlanner {
  static async planBatch(
    db: any,
    workspaceId: number,
    items: ReadonlyArray<AnalysisQueueItem>,
    effectiveConfig: EffectiveWorkspaceAIConfigResult
  ): Promise<Map<number, StageReuseDecision>> {
    const out = new Map<number, StageReuseDecision>()
    if (!db || items.length === 0) return out

    const slice = items.slice(0, PLAN_CHUNK_SIZE)
    const reuseEnabled = effectiveConfig.effectiveParams.reuseBasicAnalysisData
    const paths = slice.map(it => (it as any).file_path || it.path).filter(Boolean)
    if (paths.length === 0) {
      for (const it of slice) out.set(it.id, buildFreshDecision(undefined, ['missing_path']))
      return out
    }

    const rowByPath = new Map<string, ContentCandidateRow>()
    try {
      const placeholders = paths.map(() => '?').join(',')
      const rows = db
        .prepare(
          `SELECT wf.path, wf.file_fingerprint, wf.is_analyzed, wf.thumbnail_path,
                  fc.content, fc.ocr, fc.lrc, fc.asr, fc.exif, fc.analysis_stats
           FROM workspace_files wf
           LEFT JOIN file_contents fc ON fc.file_fingerprint = wf.file_fingerprint
           WHERE wf.workspace_id = ? AND wf.path IN (${placeholders})`
        )
        .all(workspaceId, ...paths) as ContentCandidateRow[]
      for (const r of rows) {
        if (r.path) rowByPath.set(r.path, r)
      }
    } catch (err) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[StageReusePlanner] 批量联查基础数据失败:', err)
    }

    const fps = Array.from(
      new Set(
        Array.from(rowByPath.values())
          .map(r => r.file_fingerprint)
          .filter((fp): fp is string => typeof fp === 'string' && fp.length > 0)
      )
    )

    // 批量查询视频切片/段落与视觉/融合标签历史兜底
    const videoChunksByFp = new Map<string, any[]>()
    const seg0ByFp = new Map<string, any>()
    const visualOrFusedFpSet = new Set<string>()

    if (fps.length > 0) {
      const fpPlaceholders = fps.map(() => '?').join(',')
      try {
        const chunkRows = db
          .prepare(
            `SELECT file_fingerprint, chunk_index, sampling_interval_seconds, start_sec, end_sec
             FROM file_video_chunks
             WHERE file_fingerprint IN (${fpPlaceholders})
             ORDER BY chunk_index ASC`
          )
          .all(...fps) as any[]
        for (const cr of chunkRows) {
          const list = videoChunksByFp.get(cr.file_fingerprint) ?? []
          list.push(cr)
          videoChunksByFp.set(cr.file_fingerprint, list)
        }
      } catch {
        // 兼容最小测试库无表
      }

      try {
        const segRows = db
          .prepare(
            `SELECT file_id, segment_index, start_pts_sec, end_pts_sec, frame_count,
                    visual_embedded_count, status, params_hash, error_message
             FROM file_video_segments
             WHERE file_id IN (${fpPlaceholders}) AND segment_index = 0`
          )
          .all(...fps) as any[]
        for (const sr of segRows) {
          seg0ByFp.set(sr.file_id, sr)
        }
      } catch {
        // 兼容最小测试库无表
      }

      try {
        const relRows = db
          .prepare(
            `SELECT DISTINCT file_fingerprint
             FROM file_tag_relations
             WHERE file_fingerprint IN (${fpPlaceholders})
               AND tag_group IN ('visual', 'fused')`
          )
          .all(...fps) as Array<{ file_fingerprint: string }>
        for (const rr of relRows) {
          visualOrFusedFpSet.add(rr.file_fingerprint)
        }
      } catch {
        // 兼容最小测试库无表
      }
    }

    const { profile, targetDim } = resolveTargetProfileAndDim()
    const probeKeysSet = new Set<string>()
    for (const item of slice) {
      const p = (item as any).file_path || item.path
      const row = rowByPath.get(p)
      const fp = row?.file_fingerprint
      if (!fp) continue
      const category = getFileCategory(p)
      if (category === FileCategory.VIDEO) {
        const chunks = videoChunksByFp.get(fp)
        if (chunks && chunks.length > 0) {
          probeKeysSet.add(`${fp}:c${chunks[0].chunk_index ?? 0}`)
        }
      } else {
        probeKeysSet.add(fp)
        if (
          category === FileCategory.DOCUMENT ||
          category === FileCategory.TEXT ||
          category === FileCategory.CODE
        ) {
          probeKeysSet.add(`${fp}:tc0`)
        }
      }
    }

    const presentVectorKeys = new Set<string>()
    const allProbeKeys = Array.from(probeKeysSet)
    let vectorProbeErrored = false
    for (let i = 0; i < allProbeKeys.length; i += MAX_GET_VECTORS_BATCH) {
      const batchKeys = allProbeKeys.slice(i, i + MAX_GET_VECTORS_BATCH)
      try {
        const res = await omniClient.getVectors(batchKeys, targetDim, 10000)
        if (!res || !Array.isArray(res.vectors)) {
          vectorProbeErrored = true
        } else {
          for (const v of res.vectors) {
            if (v?.fileFingerprint) presentVectorKeys.add(v.fileFingerprint)
          }
        }
      } catch {
        vectorProbeErrored = true
      }
    }

    for (const item of slice) {
      const p = (item as any).file_path || item.path
      const row = p ? rowByPath.get(p) : undefined
      const fp = row?.file_fingerprint
      if (!fp) {
        out.set(item.id, buildFreshDecision(undefined, ['no_fingerprint']))
        continue
      }

      const parsedStats = parseAnalysisStatsSafe(row?.analysis_stats)
      if (parsedStats.analysisStage < 2) {
        out.set(item.id, buildFreshDecision(fp, ['stage_below_2']))
        continue
      }

      if (!reuseEnabled) {
        if (item.forceReanalyze !== true && row?.is_analyzed !== 1) {
          out.set(item.id, buildReuseDecision(fp, effectiveConfig))
        } else {
          out.set(item.id, buildFreshDecision(fp, ['reuse_disabled']))
        }
        continue
      }

      const missingReasons = evaluateRowCompleteness({
        filePath: p,
        fingerprint: fp,
        row,
        parsedStats,
        videoChunks: videoChunksByFp.get(fp),
        seg0: seg0ByFp.get(fp),
        presentVectorKeys,
        vectorProbeErrored,
        hasVisualOrFusedTagRel: visualOrFusedFpSet.has(fp),
        currentProfile: profile,
        effectiveConfig
      })

      if (missingReasons.length > 0) {
        out.set(item.id, buildFreshDecision(fp, missingReasons))
      } else {
        out.set(item.id, buildReuseDecision(fp, effectiveConfig))
      }
    }

    return out
  }

  static async checkSingleCompleteness(
    db: any,
    workspaceId: number,
    filePath: string,
    effectiveConfig: EffectiveWorkspaceAIConfigResult,
    fingerprint?: string
  ): Promise<{ isComplete: boolean; missingReasons: string[] }> {
    if (!fingerprint) {
      return { isComplete: false, missingReasons: ['no_fingerprint'] }
    }
    const fakeItem = {
      id: 0,
      workspaceId,
      path: filePath,
      name: path.basename(filePath)
    } as AnalysisQueueItem
    const row = db
      .prepare(
        `SELECT wf.path, wf.file_fingerprint, wf.is_analyzed, wf.thumbnail_path,
                fc.content, fc.ocr, fc.lrc, fc.asr, fc.exif, fc.analysis_stats
         FROM workspace_files wf
         LEFT JOIN file_contents fc ON fc.file_fingerprint = ?
         WHERE wf.workspace_id = ? AND wf.path = ?`
      )
      .get(fingerprint, workspaceId, filePath) as ContentCandidateRow | undefined

    const effectiveRow: ContentCandidateRow = row
      ? { ...row, file_fingerprint: row.file_fingerprint || fingerprint, path: filePath }
      : { file_fingerprint: fingerprint, path: filePath }

    const parsedStats = parseAnalysisStatsSafe(effectiveRow.analysis_stats)
    const category = getFileCategory(filePath)
    const { profile, targetDim } = resolveTargetProfileAndDim()

    let videoChunks: any[] | undefined
    let seg0: any | undefined
    let hasVisualOrFusedTagRel = false

    if (category === FileCategory.VIDEO) {
      try {
        videoChunks = db
          .prepare(
            'SELECT chunk_index, sampling_interval_seconds, start_sec, end_sec FROM file_video_chunks WHERE file_fingerprint = ? ORDER BY chunk_index ASC'
          )
          .all(fingerprint) as any[]
      } catch {}
      try {
        seg0 = db
          .prepare(
            'SELECT segment_index, start_pts_sec, end_pts_sec, frame_count, visual_embedded_count, status, params_hash, error_message FROM file_video_segments WHERE file_id = ? AND segment_index = 0'
          )
          .get(fingerprint)
      } catch {}
    }

    try {
      const hit = db
        .prepare(
          `SELECT 1 AS hit FROM file_tag_relations WHERE file_fingerprint = ? AND tag_group IN ('visual', 'fused') LIMIT 1`
        )
        .get(fingerprint) as { hit?: number } | undefined
      hasVisualOrFusedTagRel = hit?.hit === 1
    } catch {}

    const probeKeys: string[] = []
    if (category === FileCategory.VIDEO) {
      if (videoChunks && videoChunks.length > 0) {
        probeKeys.push(`${fingerprint}:c${videoChunks[0].chunk_index ?? 0}`)
      }
    } else {
      probeKeys.push(fingerprint)
      if (
        category === FileCategory.DOCUMENT ||
        category === FileCategory.TEXT ||
        category === FileCategory.CODE
      ) {
        probeKeys.push(`${fingerprint}:tc0`)
      }
    }

    const presentVectorKeys = new Set<string>()
    let vectorProbeErrored = false
    if (probeKeys.length > 0) {
      try {
        const res = await omniClient.getVectors(probeKeys, targetDim, 10000)
        if (!res || !Array.isArray(res.vectors)) {
          vectorProbeErrored = true
        } else {
          for (const v of res.vectors) {
            if (v?.fileFingerprint) presentVectorKeys.add(v.fileFingerprint)
          }
        }
      } catch {
        vectorProbeErrored = true
      }
    }

    void fakeItem
    const missingReasons = evaluateRowCompleteness({
      filePath,
      fingerprint,
      row: effectiveRow,
      parsedStats,
      videoChunks,
      seg0,
      presentVectorKeys,
      vectorProbeErrored,
      hasVisualOrFusedTagRel,
      currentProfile: profile,
      effectiveConfig
    })

    return {
      isComplete: missingReasons.length === 0,
      missingReasons
    }
  }
}

function evaluateRowCompleteness(ctx: {
  filePath: string
  fingerprint: string
  row: ContentCandidateRow | undefined
  parsedStats: ReturnType<typeof parseAnalysisStatsSafe>
  videoChunks: any[] | undefined
  seg0: any | undefined
  presentVectorKeys: Set<string>
  vectorProbeErrored: boolean
  hasVisualOrFusedTagRel: boolean
  currentProfile: string
  effectiveConfig: EffectiveWorkspaceAIConfigResult
}): string[] {
  const {
    filePath,
    fingerprint,
    row,
    parsedStats,
    videoChunks,
    seg0,
    presentVectorKeys,
    vectorProbeErrored,
    hasVisualOrFusedTagRel,
    currentProfile,
    effectiveConfig
  } = ctx

  const missingReasons: string[] = []
  const category = getFileCategory(filePath)
  const applied = parsedStats.appliedCapabilities

  // 嵌入档位切换立即判失效，禁止永久继承旧 embeddingProfile 能力
  if (applied?.embeddingProfile && applied.embeddingProfile !== currentProfile) {
    missingReasons.push('embedding_profile_changed')
  }

  // OCR 档位升格 (tiny -> small) 时仅图片触发重跑覆写，不误伤纯文本文档
  if (
    category === FileCategory.IMAGE &&
    effectiveConfig.effectiveParams.enableImageOcr &&
    applied?.ocrSize &&
    ocrRank(effectiveConfig.effectiveParams.ocrModelSize) > ocrRank(applied.ocrSize)
  ) {
    missingReasons.push('ocr_model_upgraded')
  }

  if (category === FileCategory.VIDEO) {
    if (!videoChunks || videoChunks.length === 0) {
      missingReasons.push('missing_video_chunks')
    } else {
      const firstChunk = videoChunks[0]
      const recordedInterval = firstChunk.sampling_interval_seconds ?? 1.0
      const isShotBased = recordedInterval <= 0
      const expectedSpan = Math.min(16, Math.max(4, recordedInterval * 2))
      const firstSpan = (firstChunk.end_sec ?? 0) - (firstChunk.start_sec ?? 0)
      const isSpanOutdated =
        !isShotBased &&
        videoChunks.length > 1 &&
        Math.abs(firstSpan - expectedSpan) >= 0.5 &&
        Math.abs(firstSpan - 4.0) >= 0.5
      if (isSpanOutdated) {
        missingReasons.push(`video_chunk_span_outdated_${firstSpan}_vs_${expectedSpan}`)
      } else {
        const probeFp = `${fingerprint}:c${firstChunk.chunk_index ?? 0}`
        if (vectorProbeErrored && !presentVectorKeys.has(probeFp)) {
          missingReasons.push('video_vector_probe_error')
        } else if (!presentVectorKeys.has(probeFp)) {
          missingReasons.push('missing_video_chunk_vectors')
        }
      }
    }

    if (effectiveConfig.capabilities.videoVisualAnalysisEnabled) {
      const expectedParamsHash = computeVideoVisualParamsHash(
        effectiveConfig.effectiveParams.videoFrameQuotaMax,
        effectiveConfig.effectiveParams.videoSoftTokenBudget ?? 140,
        (effectiveConfig.effectiveParams.videoCutSensitivity as any) || 'medium'
      )
      const seg0Degraded =
        typeof seg0?.error_message === 'string' && seg0.error_message.includes('analysis_degraded')
      if (seg0 && (seg0Degraded || !isVideoSegmentReusable(seg0, expectedParamsHash))) {
        missingReasons.push('incomplete_video_segments')
      }
    }
  } else if (
    category === FileCategory.DOCUMENT ||
    category === FileCategory.TEXT ||
    category === FileCategory.CODE
  ) {
    const hasDocVec =
      presentVectorKeys.has(fingerprint) || presentVectorKeys.has(`${fingerprint}:tc0`)
    if (vectorProbeErrored && !hasDocVec) {
      missingReasons.push('file_vector_probe_error')
    } else if (!hasDocVec) {
      missingReasons.push('missing_file_vector')
    }
  } else {
    if (vectorProbeErrored && !presentVectorKeys.has(fingerprint)) {
      missingReasons.push('file_vector_probe_error')
    } else if (!presentVectorKeys.has(fingerprint)) {
      missingReasons.push('missing_file_vector')
    }
  }

  const hasContent = safeDecompress(row?.content).length > 0
  const hasOcr = safeDecompress(row?.ocr).length > 0
  const hasLrc = safeDecompress(row?.lrc).length > 0
  const hasAsr = safeDecompress(row?.asr).length > 0

  let hasContentRatingInExif = false
  const exifRaw = safeDecompress(row?.exif)
  if (exifRaw) {
    try {
      const exifParsed = JSON.parse(exifRaw)
      if (
        exifParsed &&
        typeof exifParsed.content_rating === 'string' &&
        exifParsed.content_rating
      ) {
        hasContentRatingInExif = true
      }
    } catch {}
  }

  const attemptedEmpty = parsedStats.attemptedEmpty
  const sameFingerprint = attemptedEmpty?.fileFingerprint === fingerprint
  const effectiveOcrValid =
    sameFingerprint &&
    ocrRank(effectiveConfig.effectiveParams.ocrModelSize) <= ocrRank(attemptedEmpty?.ocrModelSize)
  const targetAsrSec =
    category === FileCategory.VIDEO
      ? effectiveConfig.effectiveParams.videoAsrDurationSec
      : effectiveConfig.effectiveParams.audioAnalysisDurationSec
  const effectiveAsrValid =
    sameFingerprint && targetAsrSec <= (attemptedEmpty?.asrDurationSec ?? -1)

  if (
    category === FileCategory.DOCUMENT ||
    category === FileCategory.TEXT ||
    category === FileCategory.CODE
  ) {
    if (!hasContent) {
      missingReasons.push('missing_document_content')
    }
    const ext = path.extname(filePath).toLowerCase()
    if (effectiveConfig.effectiveParams.enableOfficeCover && OFFICE_COVER_EXTS.has(ext)) {
      if (!row?.thumbnail_path) {
        missingReasons.push('missing_office_cover')
      }
    }
  } else if (category === FileCategory.IMAGE) {
    if (!row?.thumbnail_path) {
      missingReasons.push('missing_thumbnail')
    }
    if (
      effectiveConfig.effectiveParams.enableImageOcr &&
      !hasOcr &&
      !hasContent &&
      !(effectiveOcrValid && attemptedEmpty?.ocrEmpty)
    ) {
      missingReasons.push('missing_image_ocr')
    }
  } else if (category === FileCategory.AUDIO || category === FileCategory.VIDEO) {
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

  for (const r of hasVisualOrNsfwCapabilitySatisfied(
    category,
    applied,
    effectiveConfig,
    hasVisualOrFusedTagRel,
    hasContentRatingInExif
  )) {
    if (!missingReasons.includes(r)) missingReasons.push(r)
  }

  return missingReasons
}
