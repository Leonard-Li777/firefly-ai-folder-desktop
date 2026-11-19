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
  insertVideoChunks(chunks: VideoChunkRecord[]): void {
    if (!chunks || chunks.length === 0) return
    const deleteStmt = this.db.prepare(`DELETE FROM file_video_chunks WHERE file_fingerprint = ?`)
    const insertStmt = this.db.prepare(`
      INSERT INTO file_video_chunks (file_fingerprint, chunk_index, start_sec, end_sec, rep_pts_sec, meta, sampling_interval_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    // 提取所有涉及的文件指纹
    const fingerprints = Array.from(new Set(chunks.map(c => c.fileFingerprint)))
    this.db.transaction(() => {
      for (const fp of fingerprints) {
        deleteStmt.run(fp)
      }
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
   */
  markVideoSegmentCompleted(
    fileId: string,
    segmentIndex: number,
    stats: { frameCount: number; visualEmbeddedCount: number; asrTranscriptChars: number }
  ): void {
    const now = Date.now()
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
}
