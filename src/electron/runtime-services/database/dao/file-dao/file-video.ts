import type { Database, Statement } from 'better-sqlite3'
import type { VideoChunkRecord } from '@firefly/types'
import {
  LogCategory,
  logger,
  cleanSmartName,
  isTagProvenanceGroup,
  TAG_PROVENANCE_GROUPS,
  getCanonicalConceptName,
  isTagAdmissible,
  normalizeFileExtension,
  type TagProvenanceGroup
} from '@firefly/shared'
import { t } from '@app/languages'
import * as path from 'path'
import * as fs from 'fs'
import { AccessTimeBatchUpdater } from '../../access-time-batch-updater'
import { ConfigOrchestrator } from '../../../../config/config-orchestrator'
import {
  isAnalyzedForMode,
  normalizeAnalysisMode,
  type AnalysisMode
} from '../../../../config/analysis-mode'
import {
  compressText,
  decompressText,
  compressJson,
  decompressJson
} from '../../../../utils/text-compressor'
import { buildPinyinIndexRow, computePinyinSrcHash } from '../../../utils/pinyin-text'

import { FileQueryMixin } from './file-query'
import { MAX_SEGMENT_ATTEMPTS, type VideoCoverageStats } from './shared'

/**
 * FileDao 视频时序 mixin（Ticket 10 · 大文件模块化拆分）。
 *
 * 承载视频时序切片与视频片段调度：insertVideoChunks、getVideoChunks、deleteVideoChunks、
 * upsertVideoSegment、各片段状态机（processing/failed/completed/rollback）、
 * getVideoSegments、getVideoCoverageStatsBatch、片段锁/解锁与启动续作清理。
 *
 * 全部代码自 `file-dao.ts` 原样搬移，未改动任何逻辑、命名或注释措辞。
 */
export class FileVideoMixin extends FileQueryMixin {
  /**
   * [Issue 04 Step 3] 幂等 upsert 写入视频切片元数据。
   *
   * 旧实现按指纹「整表 DELETE 后重插」，分段续跑时本次仅携带新段 chunks，
   * 整表 DELETE 会把 DB 中幸存的前序段 chunks 一并抹掉（FIN-12 / Spec §3.1.C.3）。
   * 现改为按 (file_fingerprint, chunk_index) 唯一键 upsert：已存在则原地更新，
   * 不存在的段保持不动，彻底杜绝续跑丢前序 chunks。
   */
  insertVideoChunks(chunks: VideoChunkRecord[]): void {
    if (!chunks || chunks.length === 0) return
    const upsertStmt = this.db.prepare(`
      INSERT INTO file_video_chunks (file_fingerprint, chunk_index, start_sec, end_sec, rep_pts_sec, meta, sampling_interval_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_fingerprint, chunk_index) DO UPDATE SET
        start_sec = excluded.start_sec,
        end_sec = excluded.end_sec,
        rep_pts_sec = excluded.rep_pts_sec,
        meta = excluded.meta,
        sampling_interval_seconds = excluded.sampling_interval_seconds
    `)
    this.db.transaction(() => {
      for (const c of chunks) {
        upsertStmt.run(
          c.fileFingerprint,
          c.chunkIndex,
          c.startSec,
          c.endSec,
          c.repPtsSec ?? null,
          typeof c.meta === 'string' ? c.meta : JSON.stringify(c.meta || {}),
          c.samplingIntervalSeconds ?? 1.0
        )
      }
    })()
  }

  /**
   * [Issue 04 Step 3 / FIN-12] 每完成一段，单事务内仅按该段 [startSec, endSec) 区间替换 chunks。
   *
   * 先删除落在该段时间窗内的旧切片，再插入本段最新切片，使「分段续跑」在崩溃重启后
   * 只需重算未完成段，已完成段的 chunks 在 DB 中稳定留存。
   */
  replaceVideoChunksInRange(
    fileFingerprint: string,
    chunks: VideoChunkRecord[],
    startSec: number,
    endSec: number
  ): void {
    if (!fileFingerprint) return
    const deleteStmt = this.db.prepare(
      `DELETE FROM file_video_chunks
       WHERE file_fingerprint = ? AND start_sec >= ? AND start_sec < ?`
    )
    const insertStmt = this.db.prepare(`
      INSERT INTO file_video_chunks (file_fingerprint, chunk_index, start_sec, end_sec, rep_pts_sec, meta, sampling_interval_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_fingerprint, chunk_index) DO UPDATE SET
        start_sec = excluded.start_sec,
        end_sec = excluded.end_sec,
        rep_pts_sec = excluded.rep_pts_sec,
        meta = excluded.meta,
        sampling_interval_seconds = excluded.sampling_interval_seconds
    `)
    this.db.transaction(() => {
      deleteStmt.run(fileFingerprint, startSec, endSec)
      for (const c of chunks) {
        insertStmt.run(
          c.fileFingerprint,
          c.chunkIndex,
          c.startSec,
          c.endSec,
          c.repPtsSec ?? null,
          typeof c.meta === 'string' ? c.meta : JSON.stringify(c.meta || {}),
          c.samplingIntervalSeconds ?? 1.0
        )
      }
    })()
  }

  /**
   * 按文件指纹获取全部时序切片，按切片索引升序排序
   */
  getVideoChunks(fileFingerprint: string): Array<{
    id?: number
    fileFingerprint: string
    chunkIndex: number
    startSec: number
    endSec: number
    repPtsSec: number
    meta: Record<string, any>
    samplingIntervalSeconds: number
    createdAt?: string
  }> {
    if (!fileFingerprint) return []
    const rows = this.db
      .prepare(
        `SELECT id, file_fingerprint as fileFingerprint, chunk_index as chunkIndex, start_sec as startSec, end_sec as endSec, COALESCE(rep_pts_sec, start_sec) as repPtsSec, meta, sampling_interval_seconds as samplingIntervalSeconds, created_at as createdAt
         FROM file_video_chunks
         WHERE file_fingerprint = ?
         ORDER BY chunk_index ASC`
      )
      .all(fileFingerprint) as Array<{
      id?: number
      fileFingerprint: string
      chunkIndex: number
      startSec: number
      endSec: number
      repPtsSec: number
      meta: string | Record<string, any>
      samplingIntervalSeconds: number
      createdAt?: string
    }>
    return rows.map(r => {
      let parsedMeta: Record<string, any> = {}
      if (r.meta) {
        try {
          parsedMeta = typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta
        } catch {
          parsedMeta = {}
        }
      }
      return {
        ...r,
        repPtsSec: Number(r.repPtsSec ?? r.startSec),
        meta: parsedMeta
      }
    })
  }

  /**
   * 按文件指纹删除所有切片记录
   */
  deleteVideoChunks(fileFingerprint: string): void {
    if (!fileFingerprint) return
    this.db.prepare(`DELETE FROM file_video_chunks WHERE file_fingerprint = ?`).run(fileFingerprint)
  }

  /**
   * 记录视频片段调度任务为 pending (Phase 2 流式流水线 / ISS-37)
   */
  upsertVideoSegment(segment: {
    id: string
    fileId: string
    segmentIndex: number
    startPtsSec: number
    endPtsSec: number
    paramsHash: string
    status?: 'pending' | 'processing' | 'completed' | 'failed'
  }): void {
    const now = Date.now()
    const initialStatus = segment.status || 'pending'
    this.db
      .prepare(
        `INSERT INTO file_video_segments (
           id, file_id, segment_index, start_pts_sec, end_pts_sec,
           status, attempt_count, params_hash, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
         ON CONFLICT(file_id, segment_index) DO UPDATE SET
           start_pts_sec = excluded.start_pts_sec,
           end_pts_sec = excluded.end_pts_sec,
           params_hash = excluded.params_hash,
           updated_at = excluded.updated_at`
      )
      .run(
        segment.id,
        segment.fileId,
        segment.segmentIndex,
        segment.startPtsSec,
        segment.endPtsSec,
        initialStatus,
        segment.paramsHash,
        now,
        now
      )
  }

  /**
   * 派发视频片段执行：单条原子 CAS 认领并累加 attempt_count (FIN-02)
   * 仅在状态为 pending 且 attempt_count < MAX_SEGMENT_ATTEMPTS 时成功认领
   */
  markVideoSegmentProcessing(fileId: string, segmentIndex: number): boolean {
    const now = Date.now()
    const result = this.db
      .prepare(
        `UPDATE file_video_segments
         SET status = 'processing',
             attempt_count = attempt_count + 1,
             updated_at = ?
         WHERE file_id = ?
           AND segment_index = ?
           AND status = 'pending'
           AND attempt_count < ${MAX_SEGMENT_ATTEMPTS}`
      )
      .run(now, fileId, segmentIndex)

    if (result.changes > 0) {
      return true
    }

    // 若未更新成功，检查是否由于重试超限触发毒药熔断
    const row = this.db
      .prepare(
        'SELECT status, attempt_count FROM file_video_segments WHERE file_id = ? AND segment_index = ?'
      )
      .get(fileId, segmentIndex) as { status: string; attempt_count: number } | undefined

    if (
      row &&
      row.attempt_count >= MAX_SEGMENT_ATTEMPTS &&
      row.status !== 'completed' &&
      row.status !== 'failed'
    ) {
      this.db
        .prepare(
          `UPDATE file_video_segments
           SET status = 'failed',
               error_message = 'Max retry attempts exceeded (poison pill guard)',
               updated_at = ?
           WHERE file_id = ? AND segment_index = ?`
        )
        .run(now, fileId, segmentIndex)
    }

    return false
  }

  /**
   * 失败回写与毒药熔断闭环 (FIN-02)
   * 异常时若 attempt_count >= 3 置为 failed 并记录错误，否则回退为 pending 供断点续作
   */
  markVideoSegmentFailedOrPending(fileId: string, segmentIndex: number, errorMsg: string): void {
    const now = Date.now()
    this.db
      .prepare(
        `UPDATE file_video_segments
         SET status = CASE WHEN attempt_count >= ${MAX_SEGMENT_ATTEMPTS} THEN 'failed' ELSE 'pending' END,
             error_message = ?,
             updated_at = ?
         WHERE file_id = ? AND segment_index = ? AND status = 'processing'`
      )
      .run(errorMsg, now, fileId, segmentIndex)
  }

  /**
   * 修复历史中毒切片：`completed` 但零帧/零向量产出时重置为 `pending` 以便重新提取。
   * 仅命中空完成态，不影响正常已完成切片，也不消耗毒药重试配额。
   */
  resetEmptyCompletedVideoSegment(fileId: string, segmentIndex: number): boolean {
    const result = this.db
      .prepare(
        `UPDATE file_video_segments
         SET status = 'pending',
             attempt_count = 0,
             error_message = NULL,
             updated_at = ?
         WHERE file_id = ?
           AND segment_index = ?
           AND status = 'completed'
           AND COALESCE(frame_count, 0) <= 0
           AND COALESCE(visual_embedded_count, 0) <= 0`
      )
      .run(Date.now(), fileId, segmentIndex)
    return result.changes > 0
  }

  /**
   * 正常休眠/合盖/优雅退出时的切片安全回滚，不消耗毒药重试配额 (FIN-09)
   */
  rollbackVideoSegmentProcessing(fileId: string, segmentIndex: number): void {
    const now = Date.now()
    this.db
      .prepare(
        `UPDATE file_video_segments
         SET status = 'pending',
             attempt_count = CASE WHEN attempt_count > 0 THEN attempt_count - 1 ELSE 0 END,
             updated_at = ?
         WHERE file_id = ? AND segment_index = ? AND status = 'processing'`
      )
      .run(now, fileId, segmentIndex)
  }

  /**
   * 标记视频片段分析完成 (ISS-37)
   * 若传入 paramsHash，同步回写最新画面提取指纹，防参数升档重提后残留旧指纹。
   */
  markVideoSegmentCompleted(
    fileId: string,
    segmentIndex: number,
    stats: {
      frameCount: number
      visualEmbeddedCount: number
      asrTranscriptChars: number
      paramsHash?: string
    }
  ): void {
    const now = Date.now()
    if (stats.paramsHash) {
      this.db
        .prepare(
          `UPDATE file_video_segments
           SET status = 'completed',
               frame_count = ?,
               visual_embedded_count = ?,
               asr_transcript_chars = ?,
               params_hash = ?,
               error_message = NULL,
               updated_at = ?
           WHERE file_id = ? AND segment_index = ?`
        )
        .run(
          stats.frameCount,
          stats.visualEmbeddedCount,
          stats.asrTranscriptChars,
          stats.paramsHash,
          now,
          fileId,
          segmentIndex
        )
      return
    }
    this.db
      .prepare(
        `UPDATE file_video_segments
         SET status = 'completed',
             frame_count = ?,
             visual_embedded_count = ?,
             asr_transcript_chars = ?,
             error_message = NULL,
             updated_at = ?
         WHERE file_id = ? AND segment_index = ?`
      )
      .run(
        stats.frameCount,
        stats.visualEmbeddedCount,
        stats.asrTranscriptChars,
        now,
        fileId,
        segmentIndex
      )
  }

  /**
   * 获取指定文件的所有切片记录，按序号升序排列 (ISS-49)
   */
  getVideoSegments(fileId: string): Array<{
    id: string
    file_id: string
    segment_index: number
    start_pts_sec: number
    end_pts_sec: number
    frame_count: number
    visual_embedded_count: number
    asr_transcript_chars: number
    status: 'pending' | 'processing' | 'completed' | 'failed'
    attempt_count: number
    params_hash: string
  }> {
    return this.db
      .prepare('SELECT * FROM file_video_segments WHERE file_id = ? ORDER BY segment_index ASC')
      .all(fileId) as any[]
  }

  /**
   * 批量预查视频切片覆盖度，单次消除卡片 N+1 查询性能损耗 (FIN-05 / FIN-06)
   */
  getVideoCoverageStatsBatch(fileIds: string[]): Map<string, VideoCoverageStats> {
    const map = new Map<string, VideoCoverageStats>()
    if (!fileIds || fileIds.length === 0) return map

    const placeholders = fileIds.map(() => '?').join(',')
    const rows = this.db
      .prepare(
        `SELECT 
           file_id,
           COALESCE(MAX(end_pts_sec), 0) AS total_duration_sec,
           COALESCE(SUM(CASE WHEN status = 'completed' THEN (end_pts_sec - start_pts_sec) ELSE 0 END), 0) AS completed_duration_sec,
           MAX(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS has_failed,
           MIN(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS all_completed,
           COUNT(*) AS total_segments
         FROM file_video_segments
         WHERE file_id IN (${placeholders})
         GROUP BY file_id`
      )
      .all(...fileIds) as Array<{
      file_id: string
      total_duration_sec: number
      completed_duration_sec: number
      has_failed: number
      all_completed: number
      total_segments: number
    }>

    for (const r of rows) {
      map.set(r.file_id, {
        file_id: r.file_id,
        fileId: r.file_id,
        total_duration_sec: r.total_duration_sec,
        totalDurationSec: r.total_duration_sec,
        completed_duration_sec: r.completed_duration_sec,
        coveredDurationSec: r.completed_duration_sec,
        has_failed_segments: r.has_failed === 1,
        hasFailedSegments: r.has_failed === 1,
        is_fully_covered: r.total_segments > 0 && r.all_completed === 1,
        isFullyCovered: r.total_segments > 0 && r.all_completed === 1
      })
    }
    return map
  }

  /**
   * 读时派生升维保留接口：已废弃物理 locked 状态迁移 (FIN-01)
   */
  unlockVideoSegments(): number {
    return 0
  }

  /**
   * 读时派生升维保留接口：已废弃物理 locked 状态迁移 (FIN-01)
   */
  lockPendingVideoSegments(_fileId?: string): number {
    return 0
  }

  resetDanglingVideoSegmentsOnStartup(): void {
    const now = Date.now()
    this.db
      .prepare(
        `UPDATE file_video_segments
         SET status = 'failed', error_message = 'Aborted by daemon restart after max attempts', updated_at = ?
         WHERE status = 'processing' AND attempt_count >= ${MAX_SEGMENT_ATTEMPTS}`
      )
      .run(now)

    this.db
      .prepare(
        `UPDATE file_video_segments
         SET status = 'pending', updated_at = ?
         WHERE status = 'processing'`
      )
      .run(now)
  }

  /**
   * 查找存在未完成切片（pending 状态）且在工作区中的视频文件 (ISS-60)
   */
  getIncompleteVideoFiles(): Array<{
    fileFingerprint: string
    workspaceId: string
    path: string
    name: string
    size: number
    extension: string
  }> {
    return this.db
      .prepare(
        `SELECT DISTINCT s.file_id AS fileFingerprint, wf.workspace_id AS workspaceId, wf.path, wf.name, f.size, f.extension
         FROM file_video_segments s
         JOIN workspace_files wf ON s.file_id = wf.file_fingerprint
         JOIN files f ON s.file_id = f.file_fingerprint
         WHERE s.status = 'pending'`
      )
      .all() as any[]
  }

  /**
   * 查询存在 k >= 1 待补切片且 seg_0 已完成的工作区 ID 列表（Spec §2.3 / §3.5）
   */
  getWorkspaceIdsWithPendingVideoSegments(): number[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT wf.workspace_id AS workspaceId
         FROM file_video_segments s
         JOIN workspace_files wf ON s.file_id = wf.file_fingerprint
         WHERE s.segment_index >= 1
           AND s.status = 'pending'
           AND (wf.meta IS NULL OR json_extract(wf.meta, '$.recovery_cleared') IS NOT 1)
           AND EXISTS (
             SELECT 1 FROM file_video_segments s0
             WHERE s0.file_id = s.file_id AND s0.segment_index = 0 AND s0.status = 'completed'
           )
         ORDER BY wf.workspace_id ASC`
      )
      .all() as Array<{ workspaceId: number }>
    return rows.map(r => Number(r.workspaceId)).filter(id => Number.isFinite(id))
  }

  /**
   * 查询指定工作区有效时长上限内的待补视频切片（Spec §3.5）：
   * 强制限定 segment_index >= 1 且 seg_0 已 completed，物理免疫失败 seg_0 误跑与超限尾巴死循环。
   */
  getPendingVideoSegmentsForWorkspace(
    workspaceId: number,
    maxStartPtsSec: number
  ): Array<{
    fileFingerprint: string
    segmentIndex: number
    startPtsSec: number
    endPtsSec: number
    paramsHash: string
    workspaceId: number
    path: string
    name: string
  }> {
    return this.db
      .prepare(
        `SELECT s.file_id AS fileFingerprint,
                s.segment_index AS segmentIndex,
                s.start_pts_sec AS startPtsSec,
                s.end_pts_sec AS endPtsSec,
                s.params_hash AS paramsHash,
                wf.workspace_id AS workspaceId,
                wf.path,
                wf.name
         FROM file_video_segments s
         JOIN workspace_files wf ON s.file_id = wf.file_fingerprint
         WHERE wf.workspace_id = ?
           AND s.segment_index >= 1
           AND s.status = 'pending'
           AND s.start_pts_sec < ?
           AND (wf.meta IS NULL OR json_extract(wf.meta, '$.recovery_cleared') IS NOT 1)
           AND EXISTS (
             SELECT 1 FROM file_video_segments s0
             WHERE s0.file_id = s.file_id AND s0.segment_index = 0 AND s0.status = 'completed'
           )
         ORDER BY s.file_id ASC, s.segment_index ASC`
      )
      .all(workspaceId, maxStartPtsSec) as any[]
  }

  /**
   * 聚合指定工作区有效上限内存在待补/失败切片的视频文件清单（供「待补分析文件」Tab 展示）
   */
  getWorkspacePendingBackfillVideos(
    workspaceId: number,
    effectiveLimitSec: number
  ): Array<{
    workspaceFileId?: number
    fileFingerprint: string
    path: string
    name: string
    completedSlices: number
    targetSlices: number
    totalSlices: number
    completedDurationSec: number
    targetDurationSec: number
    totalDurationSec: number
    failedSlices: number
  }> {
    const rows = this.db
      .prepare(
        `SELECT
           s.file_id AS fileFingerprint,
           wf.id AS workspaceFileId,
           wf.path AS path,
           wf.name AS name,
           SUM(CASE WHEN s.start_pts_sec < ? AND s.status = 'completed' THEN 1 ELSE 0 END) AS completedSlices,
           SUM(CASE WHEN s.start_pts_sec < ? THEN 1 ELSE 0 END) AS targetSlices,
           COUNT(*) AS totalSlices,
           COALESCE(SUM(CASE WHEN s.start_pts_sec < ? AND s.status = 'completed' THEN (MIN(s.end_pts_sec, ?) - s.start_pts_sec) ELSE 0 END), 0) AS completedDurationSec,
           COALESCE(SUM(CASE WHEN s.start_pts_sec < ? THEN (MIN(s.end_pts_sec, ?) - s.start_pts_sec) ELSE 0 END), 0) AS targetDurationSec,
           COALESCE(MAX(s.end_pts_sec), 0) AS totalDurationSec,
           SUM(CASE WHEN s.segment_index >= 1 AND s.start_pts_sec < ? AND s.status = 'failed' THEN 1 ELSE 0 END) AS failedSlices,
           SUM(CASE WHEN s.segment_index >= 1 AND s.start_pts_sec < ? AND s.status IN ('pending', 'failed') THEN 1 ELSE 0 END) AS actionableSlices
         FROM file_video_segments s
         JOIN workspace_files wf ON s.file_id = wf.file_fingerprint
         WHERE wf.workspace_id = ?
           AND (wf.meta IS NULL OR json_extract(wf.meta, '$.recovery_cleared') IS NOT 1)
           AND EXISTS (
             SELECT 1 FROM file_video_segments s0
             WHERE s0.file_id = s.file_id AND s0.segment_index = 0 AND s0.status = 'completed'
           )
         GROUP BY s.file_id, wf.id, wf.path, wf.name
         HAVING actionableSlices > 0
         ORDER BY wf.name ASC`
      )
      .all(
        effectiveLimitSec,
        effectiveLimitSec,
        effectiveLimitSec,
        effectiveLimitSec,
        effectiveLimitSec,
        effectiveLimitSec,
        effectiveLimitSec,
        effectiveLimitSec,
        workspaceId
      ) as any[]

    return rows.map(r => ({
      workspaceFileId: r.workspaceFileId != null ? Number(r.workspaceFileId) : undefined,
      fileFingerprint: r.fileFingerprint,
      path: r.path,
      name: r.name,
      completedSlices: Number(r.completedSlices || 0),
      targetSlices: Number(r.targetSlices || 0),
      totalSlices: Number(r.totalSlices || 0),
      completedDurationSec: Math.max(0, Math.round(Number(r.completedDurationSec || 0))),
      targetDurationSec: Math.max(0, Math.round(Number(r.targetDurationSec || 0))),
      totalDurationSec: Math.max(0, Math.round(Number(r.totalDurationSec || 0))),
      failedSlices: Number(r.failedSlices || 0)
    }))
  }

  /**
   * 复位指定工作区有效上限内失败的 k >= 1 切片为 pending 并清零重试计数
   */
  resetFailedVideoSegmentsForWorkspace(workspaceId: number, effectiveLimitSec: number): number {
    const now = Date.now()
    const info = this.db
      .prepare(
        `UPDATE file_video_segments
         SET status = 'pending', attempt_count = 0, error_message = NULL, updated_at = ?
         WHERE segment_index >= 1
           AND status = 'failed'
           AND start_pts_sec < ?
           AND file_id IN (
             SELECT file_fingerprint FROM workspace_files WHERE workspace_id = ?
           )`
      )
      .run(now, effectiveLimitSec, workspaceId)
    return Number(info?.changes ?? 0)
  }

  /**
   * 抽帧档位升档后，将当前工作区有效上限内指纹失效的 k >= 1 切片重置为 pending 等待重提
   */
  resetUpgradedVideoSegmentsForWorkspace(
    workspaceId: number,
    effectiveLimitSec: number,
    expectedParamsHash: string,
    isReusableFn: (seg: { status?: string; params_hash?: string }, expectedHash: string) => boolean
  ): number {
    const rows = this.db
      .prepare(
        `SELECT s.file_id, s.segment_index, s.status, s.params_hash
         FROM file_video_segments s
         JOIN workspace_files wf ON s.file_id = wf.file_fingerprint
         WHERE wf.workspace_id = ?
           AND s.segment_index >= 1
           AND s.status = 'completed'
           AND s.start_pts_sec < ?`
      )
      .all(workspaceId, effectiveLimitSec) as Array<{
      file_id: string
      segment_index: number
      status: string
      params_hash: string
    }>

    const stale = rows.filter(r => !isReusableFn(r, expectedParamsHash))
    if (stale.length === 0) return 0

    const now = Date.now()
    const stmt = this.db.prepare(
      `UPDATE file_video_segments
       SET status = 'pending', attempt_count = 0, error_message = NULL, updated_at = ?
       WHERE file_id = ? AND segment_index = ?`
    )
    const tx = this.db.transaction(() => {
      for (const s of stale) {
        stmt.run(now, s.file_id, s.segment_index)
      }
    })
    tx()
    return stale.length
  }
}
