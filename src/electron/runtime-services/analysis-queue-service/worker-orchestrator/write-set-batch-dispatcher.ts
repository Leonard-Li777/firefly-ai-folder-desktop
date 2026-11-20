/**
 * 主进程写微事务执行器（AnalysisWriteSetBatchDispatcher）
 *
 * 完整落实 Spec §5（事务外 Pre-step 异步 stat + 事务内 8 步 SAVEPOINT 写集）、
 * §6（两层 FileGuard 过期围栏 + COMMIT 尾钩子与扇出）、
 * §8.3（50ms/32 项攒批 + setImmediate 分片 + YIELD_FOR_UI 双端联动）。
 *
 * @doc-anchor: docs/specs/stage2-analysis-pipeline-worker-optimization-spec.md#5-提交协议事务外前置--事务内-8-步写集
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import type { Database } from 'better-sqlite3'
import { LogCategory, logger, ensureTagPath } from '@firefly/shared'
import { CanonicalDao } from '../../database/dao/canonical-dao'
import { FtsProjectionService } from '../../database/fts-projection'
import { classifyWorkerErrorKind, type AnalysisErrorKind } from './worker-error-classifier'
import type { AnalysisWriteSet, VideoSegmentWriteSet } from './protocol'

/** 攒批窗口（ms，Spec §8.3.1） */
export const COALESCE_WINDOW_MS = 50
/** 单批最大文件数（Spec §9.3） */
export const MAX_WRITE_BATCH_SIZE = 32
/** FAT32 时间戳容差（ms，Spec §6.2） */
export const FILE_GUARD_MTIME_TOLERANCE_MS = 2000
/** COMMIT 尾钩子尾部防抖窗口（ms，Spec §6.3 v2.4：≥ 3000ms） */
export const TAIL_HOOK_DEBOUNCE_MS = 3000

export interface WriteAckItem {
  queueId: number
  result: 'ok' | 'stale' | 'error'
  errorKind?: AnalysisErrorKind
  reason?: string
}

export interface TailHookBatchContext {
  canonicalVectorWakeups: string[]
  workspaceDeletes: number[]
}

export interface WriteSetBatchDispatcherDeps {
  getDb: () => Database | null | undefined
  onWriteAck?: (ack: WriteAckItem) => void
  onWakeCanonicalMaintenance?: (fingerprints: string[]) => void
  onTriggerCloudSync?: (delayMs: number) => void
  onWorkspaceDeletes?: (workspaceFileIds: number[]) => void
  /**
   * 单批写微事务执行完成回调（含 Pre-step stat 全程耗时，工单 05 ≤10ms 量化验收采集点）。
   * 主进程宿主与 utilityProcess 写进程子入口均经此钩子上报 BATCH_METRICS。
   */
  onBatchExecuted?: (batchSize: number, durationMs: number) => void
  /** 可注入自定义 stat（便于单测隔离文件系统） */
  statFile?: (filePath: string) => Promise<{ size: number; mtimeMs: number }>
  coalesceWindowMs?: number
  tailHookDebounceMs?: number
}

export class WriteSetBatchDispatcher {
  private pendingWriteSets: AnalysisWriteSet[] = []
  private coalesceTimer: ReturnType<typeof setTimeout> | null = null
  private flushing = false
  private pausedForUi = false
  private pauseResumeTimer: ReturnType<typeof setTimeout> | null = null
  private disposed = false

  /** COMMIT 尾钩子尾部防抖累积桶（Spec §6.3 v2.4） */
  private pendingCanonicalWakeups = new Set<string>()
  private pendingWorkspaceDeletes = new Set<number>()
  private tailHookTimer: ReturnType<typeof setTimeout> | null = null

  private readonly coalesceWindowMs: number
  private readonly tailHookDebounceMs: number
  private readonly statFile: (filePath: string) => Promise<{ size: number; mtimeMs: number }>

  constructor(private readonly deps: WriteSetBatchDispatcherDeps) {
    this.coalesceWindowMs = deps.coalesceWindowMs ?? COALESCE_WINDOW_MS
    this.tailHookDebounceMs = deps.tailHookDebounceMs ?? TAIL_HOOK_DEBOUNCE_MS
    this.statFile = deps.statFile ?? (p => fs.stat(p))
  }

  /** 将 Worker 产出的写集加入攒批缓冲 */
  enqueue(writeSet: AnalysisWriteSet): void {
    if (this.disposed) return
    this.pendingWriteSets.push(writeSet)
    if (this.pausedForUi) return
    if (this.pendingWriteSets.length >= MAX_WRITE_BATCH_SIZE) {
      this.clearCoalesceTimer()
      void this.flush()
    } else if (!this.coalesceTimer) {
      this.coalesceTimer = setTimeout(() => {
        this.coalesceTimer = null
        void this.flush()
      }, this.coalesceWindowMs)
      this.coalesceTimer.unref?.()
    }
  }

  /** Spec §8.3.2：YIELD_FOR_UI 双端联动 —— 暂停从缓冲开启新事务 */
  pauseForUi(timeoutMs: number): void {
    this.pausedForUi = true
    this.clearCoalesceTimer()
    if (this.pauseResumeTimer) {
      clearTimeout(this.pauseResumeTimer)
      this.pauseResumeTimer = null
    }
    if (timeoutMs > 0) {
      this.pauseResumeTimer = setTimeout(() => {
        this.pauseResumeTimer = null
        this.resumeFromUi()
      }, timeoutMs)
      this.pauseResumeTimer.unref?.()
    }
  }

  /** 恢复写微事务调度 */
  resumeFromUi(): void {
    if (!this.pausedForUi) return
    this.pausedForUi = false
    if (this.pauseResumeTimer) {
      clearTimeout(this.pauseResumeTimer)
      this.pauseResumeTimer = null
    }
    if (this.pendingWriteSets.length > 0 && !this.disposed) {
      setImmediate(() => void this.flush())
    }
  }

  isPausedForUi(): boolean {
    return this.pausedForUi
  }

  getPendingCount(): number {
    return this.pendingWriteSets.length
  }

  /** 立即冲刷当前缓冲（供单测与 dispose 调用） */
  async flush(): Promise<WriteAckItem[]> {
    if (this.flushing || this.pausedForUi || this.pendingWriteSets.length === 0) {
      return []
    }
    this.clearCoalesceTimer()
    this.flushing = true
    const allAcks: WriteAckItem[] = []

    try {
      while (this.pendingWriteSets.length > 0 && !this.pausedForUi) {
        const batch = this.pendingWriteSets.splice(0, MAX_WRITE_BATCH_SIZE)
        const batchStartMs = performance.now()
        const batchAcks = await this.executeBatch(batch)
        try {
          this.deps.onBatchExecuted?.(batch.length, performance.now() - batchStartMs)
        } catch (metricErr) {
          logger.warn(
            LogCategory.ANALYSIS_QUEUE,
            '[WriteSetDispatcher] onBatchExecuted 指标回调异常:',
            metricErr
          )
        }
        allAcks.push(...batchAcks)
        for (const ack of batchAcks) {
          this.deps.onWriteAck?.(ack)
        }
        // Spec §8.3 / §9.3：每批写完让出事件循环一个 tick，确保 UI/IPC/TTS 响应
        if (this.pendingWriteSets.length > 0 && !this.pausedForUi) {
          await new Promise<void>(resolve => setImmediate(resolve))
        }
      }
    } finally {
      this.flushing = false
    }
    return allAcks
  }

  /** 直接同步/异步执行一批写集（Pre-step 异步 stat + 批级 BEGIN IMMEDIATE 8 步 SAVEPOINT 事务） */
  async executeBatch(batch: AnalysisWriteSet[]): Promise<WriteAckItem[]> {
    if (batch.length === 0) return []
    const db = this.deps.getDb()
    if (!db) {
      return batch.map(item => ({
        queueId: item.queueId,
        result: 'error',
        errorKind: 'SQLITE_BUSY',
        reason: 'database_unavailable'
      }))
    }

    // ==================== B2 Pre-step（事务外，并发异步 stat，零 WAL 锁） ====================
    const settled = await Promise.allSettled(batch.map(item => this.statFile(item.physicalPath)))
    const results: WriteAckItem[] = []
    const validBatch: AnalysisWriteSet[] = []
    const stalePreStepItems: Array<{
      queueId: number
      reason: 'file_stat_failed' | 'file_changed'
    }> = []

    for (let i = 0; i < batch.length; i++) {
      const item = batch[i]
      const statRes = settled[i]
      if (statRes.status === 'rejected') {
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          `[WriteSetDispatcher] Pre-step stat 失败 (queueId=${item.queueId}, path=${item.physicalPath}):`,
          statRes.reason
        )
        results.push({ queueId: item.queueId, result: 'stale', reason: 'file_stat_failed' })
        stalePreStepItems.push({ queueId: item.queueId, reason: 'file_stat_failed' })
        continue
      }
      const currentStat = statRes.value
      const sizeChanged = Math.abs(currentStat.size - item.guard.size) > 0
      const mtimeChanged =
        Math.abs(currentStat.mtimeMs - item.guard.mtimeMs) > FILE_GUARD_MTIME_TOLERANCE_MS
      if (sizeChanged || mtimeChanged) {
        results.push({ queueId: item.queueId, result: 'stale', reason: 'file_changed' })
        stalePreStepItems.push({ queueId: item.queueId, reason: 'file_changed' })
        continue
      }
      validBatch.push(item)
    }

    // 对 Pre-step 判 stale 的队列行做状态闭环（防止永久卡在 analyzing）
    if (stalePreStepItems.length > 0) {
      try {
        db.exec('BEGIN IMMEDIATE')
        for (const stale of stalePreStepItems) {
          if (stale.reason === 'file_stat_failed') {
            db.prepare(
              `UPDATE analysis_queue
               SET status = 'failed', error = 'file_stat_failed',
                   end_time = CURRENT_TIMESTAMP, claimed_at = NULL, updated_at = CURRENT_TIMESTAMP
               WHERE id = ? AND status = 'analyzing'`
            ).run(stale.queueId)
          } else {
            db.prepare(
              `UPDATE analysis_queue
               SET status = 'pending', claimed_at = NULL, updated_at = CURRENT_TIMESTAMP
               WHERE id = ? AND status = 'analyzing'`
            ).run(stale.queueId)
          }
        }
        db.exec('COMMIT')
      } catch (e) {
        try {
          if (db.inTransaction) db.exec('ROLLBACK')
        } catch (rbErr) {
          logger.warn(
            LogCategory.ANALYSIS_QUEUE,
            '[WriteSetDispatcher] Pre-step 闭环回滚失败:',
            rbErr
          )
        }
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          '[WriteSetDispatcher] Pre-step stale 队列闭环失败:',
          e
        )
      }
    }

    if (validBatch.length === 0) {
      return results
    }

    // ==================== B3 + B4 事务内 8 步写集（每文件独立 SAVEPOINT） ====================
    const canonicalDao = new CanonicalDao(db)
    const ftsProjection = new FtsProjectionService(db)
    const committedFingerprints: string[] = []
    const wakeupFingerprints: string[] = []
    const workspaceDeletes: number[] = []

    try {
      db.exec('BEGIN IMMEDIATE')

      for (let idx = 0; idx < validBatch.length; idx++) {
        const file = validBatch[idx]
        const spName = `sp_file_${idx}`
        db.exec(`SAVEPOINT ${spName}`)

        try {
          // Step 1: tag_paths 前置（按完整 codePath 去重幂等 ensureTagPath 回填 pathIdMap）
          const pathIdMap = new Map<string, number>()
          if (file.tagRelations && file.tagRelations.length > 0) {
            const distinctPaths = Array.from(new Set(file.tagRelations.map(r => r.codePath)))
            for (const codePath of distinctPaths) {
              try {
                const pathId = ensureTagPath(db, codePath)
                pathIdMap.set(codePath, pathId)
              } catch (tagPathErr) {
                // Spec §5.5：非法标签路径丢弃并警告，不阻断整批
                logger.warn(
                  LogCategory.ANALYSIS_QUEUE,
                  `[WriteSetDispatcher] Step 1 ensureTagPath 跳过非法路径 (${codePath}):`,
                  tagPathErr
                )
              }
            }
          }

          // Step 2: 逻辑层 FileGuard（严格比对入队快照 file.guard，保护 FAT32 2s 容差）
          const guardRes = db
            .prepare(
              `UPDATE workspace_files
               SET is_analyzed = 1, last_analyzed_at = CURRENT_TIMESTAMP
               WHERE id = ? AND file_size = ? AND mtime_ms = ?`
            )
            .run(file.workspaceFileId, file.guard.size, file.guard.mtimeMs)

          if (guardRes.changes === 0) {
            db.exec(`ROLLBACK TO ${spName}`)
            db.exec(`RELEASE ${spName}`)
            const rowExists = db
              .prepare(`SELECT 1 FROM workspace_files WHERE id = ?`)
              .get(file.workspaceFileId)
            if (!rowExists) {
              results.push({
                queueId: file.queueId,
                result: 'stale',
                reason: 'workspace_row_gone'
              })
              workspaceDeletes.push(file.workspaceFileId)
              db.prepare(
                `UPDATE analysis_queue
                 SET status = 'failed', error = 'workspace_row_gone',
                     end_time = CURRENT_TIMESTAMP, claimed_at = NULL, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND status = 'analyzing'`
              ).run(file.queueId)
            } else {
              results.push({
                queueId: file.queueId,
                result: 'stale',
                reason: 'workspace_row_changed'
              })
              db.prepare(
                `UPDATE analysis_queue
                 SET status = 'pending', claimed_at = NULL, updated_at = CURRENT_TIMESTAMP
                 WHERE id = ? AND status = 'analyzing'`
              ).run(file.queueId)
            }
            // 严禁在 FOR EACH 循环内 RETURN；继续处理同批后续文件
            continue
          }

          // Step 3: files UPSERT（仅写 §5.3 白名单字段，严禁覆盖 rating_user_override/sync_status/smart_name*/id）
          const fu = file.filesUpdate
          const fileRow = db
            .prepare(
              `INSERT INTO files (
                 file_fingerprint, description, size, extension, file_group, author, language, meta, modified_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
               ON CONFLICT(file_fingerprint) DO UPDATE SET
                 description = COALESCE(excluded.description, files.description),
                 size = COALESCE(excluded.size, files.size),
                 extension = excluded.extension,
                 file_group = COALESCE(excluded.file_group, files.file_group),
                 author = COALESCE(excluded.author, files.author),
                 language = COALESCE(excluded.language, files.language),
                 meta = COALESCE(excluded.meta, files.meta),
                 modified_at = CURRENT_TIMESTAMP
               RETURNING id, smart_name, description, author`
            )
            .get(
              file.fileFingerprint,
              fu.description ?? null,
              fu.size ?? file.guard.size,
              fu.extension,
              fu.fileGroup ?? null,
              fu.author ?? null,
              fu.language ?? null,
              fu.meta ?? '{}'
            ) as {
            id: number
            smart_name: string | null
            description: string | null
            author: string | null
          }

          // 同步更新 workspace_files.file_fingerprint（若尚未绑定）
          db.prepare(
            `UPDATE workspace_files SET file_fingerprint = ? WHERE id = ? AND (file_fingerprint IS NULL OR file_fingerprint = '')`
          ).run(file.fileFingerprint, file.workspaceFileId)

          // canonical 状态推进：必须走 CanonicalDao 裸执行，绝不嵌套事务
          const hasSemanticChange =
            Boolean(file.canonicalVectorWakeup) ||
            Boolean(file.fileContents) ||
            Boolean(file.tagRelations && file.tagRelations.length > 0)
          if (hasSemanticChange) {
            canonicalDao.updateCanonicalVectorState(file.fileFingerprint, 'pending')
            wakeupFingerprints.push(file.fileFingerprint)
          }

          // Step 4: file_contents UPSERT（BLOB 与 compressText 同源）
          if (file.fileContents) {
            const fc = file.fileContents
            db.prepare(
              `INSERT INTO file_contents (
                 file_fingerprint, content, multimodal_content, ocr, lrc, asr, exif,
                 analysis_stats, quality_score, quality_confidence, quality_criteria,
                 quality_reasoning, grouping_reason, grouping_confidence, meta
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(file_fingerprint) DO UPDATE SET
                 content = COALESCE(excluded.content, file_contents.content),
                 multimodal_content = COALESCE(excluded.multimodal_content, file_contents.multimodal_content),
                 ocr = COALESCE(excluded.ocr, file_contents.ocr),
                 lrc = COALESCE(excluded.lrc, file_contents.lrc),
                 asr = COALESCE(excluded.asr, file_contents.asr),
                 exif = COALESCE(excluded.exif, file_contents.exif),
                 analysis_stats = COALESCE(excluded.analysis_stats, file_contents.analysis_stats),
                 quality_score = COALESCE(excluded.quality_score, file_contents.quality_score),
                 quality_confidence = COALESCE(excluded.quality_confidence, file_contents.quality_confidence),
                 quality_criteria = COALESCE(excluded.quality_criteria, file_contents.quality_criteria),
                 quality_reasoning = COALESCE(excluded.quality_reasoning, file_contents.quality_reasoning),
                 grouping_reason = COALESCE(excluded.grouping_reason, file_contents.grouping_reason),
                 grouping_confidence = COALESCE(excluded.grouping_confidence, file_contents.grouping_confidence),
                 meta = COALESCE(excluded.meta, file_contents.meta)`
            ).run(
              file.fileFingerprint,
              fc.contentBlob ? Buffer.from(fc.contentBlob) : null,
              fc.multimodalContentBlob ? Buffer.from(fc.multimodalContentBlob) : null,
              fc.ocrBlob ? Buffer.from(fc.ocrBlob) : null,
              fc.lrcBlob ? Buffer.from(fc.lrcBlob) : null,
              fc.asrBlob ? Buffer.from(fc.asrBlob) : null,
              fc.exifBlob ? Buffer.from(fc.exifBlob) : null,
              fc.analysisStats ?? null,
              fc.qualityScore ?? null,
              fc.qualityConfidence ?? null,
              fc.qualityCriteria ?? null,
              fc.qualityReasoning ?? null,
              fc.groupingReason ?? null,
              fc.groupingConfidence ?? null,
              fc.meta ?? '{}'
            )
          }

          // Step 5: file_tag_relations 集合替换（按 source 域清除 + 主键三元组排序写入 path_id）
          if (file.tagRelations !== undefined) {
            const replaceSource = file.tagReplaceSource ?? 'ai'
            db.prepare(
              `DELETE FROM file_tag_relations WHERE file_fingerprint = ? AND source = ?`
            ).run(file.fileFingerprint, replaceSource)

            const sortedRels = [...file.tagRelations].sort((a, b) => {
              const cmpTag = a.tagCode.localeCompare(b.tagCode)
              return cmpTag !== 0 ? cmpTag : a.viaParentCode.localeCompare(b.viaParentCode)
            })
            const nowMs = Date.now()
            const insertRelStmt = db.prepare(
              `INSERT OR REPLACE INTO file_tag_relations
                 (file_fingerprint, tag_code, via_parent_code, path_id, tag_group,
                  confidence, source, sync_status, created_at, updated_at, meta)
               VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
            )
            for (const rel of sortedRels) {
              const pathId = pathIdMap.get(rel.codePath)
              if (pathId === undefined) {
                logger.warn(
                  LogCategory.ANALYSIS_QUEUE,
                  `[WriteSetDispatcher] Step 5b 跳过无有效 path_id 的标签 (${rel.tagCode} @ ${rel.codePath})`
                )
                continue
              }
              insertRelStmt.run(
                file.fileFingerprint,
                rel.tagCode,
                rel.viaParentCode,
                pathId,
                rel.tagGroup,
                rel.confidence,
                rel.source,
                nowMs,
                nowMs,
                rel.meta ?? '{}'
              )
            }
          }

          // Step 6: FTS 同步（热元数据 + 冷正文直写明文；syncMetaFts 同事务置 pinyin_state=0 交 P1-D 异步回填）
          ftsProjection.syncMetaFts(fileRow.id, {
            fileFingerprint: file.fileFingerprint,
            name: path.basename(file.fileName, path.extname(file.fileName)),
            smartName: fileRow.smart_name ?? '',
            description: fileRow.description ?? '',
            author: fileRow.author ?? ''
          })
          if (file.fileContents) {
            const fc = file.fileContents
            if (
              fc.plainContent ||
              fc.plainMultimodalContent ||
              fc.plainOcr ||
              fc.plainLrc ||
              fc.plainAsr
            ) {
              ftsProjection.syncBodyFts(fileRow.id, {
                fileFingerprint: file.fileFingerprint,
                content: fc.plainContent,
                multimodalContent: fc.plainMultimodalContent,
                ocr: fc.plainOcr,
                lrc: fc.plainLrc,
                asr: fc.plainAsr
              })
            }
          }

          // Step 7: workspace_files 确认更新（清空历史错误）
          db.prepare(`UPDATE workspace_files SET analysis_error = NULL WHERE id = ?`).run(
            file.workspaceFileId
          )

          // Step 8: analysis_queue 状态更新为 completed
          db.prepare(
            `UPDATE analysis_queue
             SET status = 'completed', end_time = CURRENT_TIMESTAMP, claimed_at = NULL,
                 result = ?, progress = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'analyzing'`
          ).run(file.queueUpdate?.result ?? null, file.queueUpdate?.progress ?? 100, file.queueId)

          db.exec(`RELEASE ${spName}`)
          committedFingerprints.push(file.fileFingerprint)
          if (file.workspaceDeletes && file.workspaceDeletes.length > 0) {
            workspaceDeletes.push(...file.workspaceDeletes)
          }
          results.push({ queueId: file.queueId, result: 'ok' })
        } catch (fileErr) {
          const { kind } = classifyWorkerErrorKind(fileErr)
          // Spec §5.2：仅 SQLITE_FULL / SQLITE_CORRUPT / SQLITE_BUSY 整批回滚，单文件错误只回滚 SAVEPOINT
          if (kind === 'DISK_FULL' || kind === 'SQLITE_BUSY' || kind === 'SQLITE_CORRUPT') {
            throw fileErr
          }
          try {
            db.exec(`ROLLBACK TO ${spName}`)
            db.exec(`RELEASE ${spName}`)
          } catch (rbErr) {
            logger.warn(
              LogCategory.ANALYSIS_QUEUE,
              `[WriteSetDispatcher] SAVEPOINT 回滚失败 (${spName}):`,
              rbErr
            )
          }
          const errReason = fileErr instanceof Error ? fileErr.message : String(fileErr)
          // 状态闭环：单文件 SAVEPOINT 回滚后在批级事务内落库 failed + claimed_at=NULL，防永久卡 analyzing
          db.prepare(
            `UPDATE analysis_queue
             SET status = 'failed', error = ?, end_time = CURRENT_TIMESTAMP,
                 claimed_at = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'analyzing'`
          ).run(errReason, file.queueId)
          logger.warn(
            LogCategory.ANALYSIS_QUEUE,
            `[WriteSetDispatcher] 单文件写集失败已回滚 (queueId=${file.queueId}, kind=${kind}):`,
            fileErr
          )
          results.push({
            queueId: file.queueId,
            result: 'error',
            errorKind: kind,
            reason: errReason
          })
        }
      }

      db.exec('COMMIT')
    } catch (batchErr) {
      try {
        if (db.inTransaction) db.exec('ROLLBACK')
      } catch (rbErr) {
        logger.warn(LogCategory.ANALYSIS_QUEUE, '[WriteSetDispatcher] 批级事务回滚失败:', rbErr)
      }
      const { kind, retryable } = classifyWorkerErrorKind(batchErr)
      const batchReason = batchErr instanceof Error ? batchErr.message : String(batchErr)
      logger.error(
        LogCategory.ANALYSIS_QUEUE,
        `[WriteSetDispatcher] 批级写事务失败已回滚 (kind=${kind}):`,
        batchErr
      )
      // 批级回滚状态闭环：仅针对 validBatch 落库退回 pending(可重试) 或 failed(不可重试)，保留 Pre-step results
      try {
        db.exec('BEGIN IMMEDIATE')
        for (const item of validBatch) {
          if (retryable) {
            db.prepare(
              `UPDATE analysis_queue
               SET status = 'pending', claimed_at = NULL, updated_at = CURRENT_TIMESTAMP
               WHERE id = ? AND status = 'analyzing'`
            ).run(item.queueId)
          } else {
            db.prepare(
              `UPDATE analysis_queue
               SET status = 'failed', error = ?, end_time = CURRENT_TIMESTAMP,
                   claimed_at = NULL, updated_at = CURRENT_TIMESTAMP
               WHERE id = ? AND status = 'analyzing'`
            ).run(batchReason, item.queueId)
          }
        }
        db.exec('COMMIT')
      } catch (closeErr) {
        try {
          if (db.inTransaction) db.exec('ROLLBACK')
        } catch (rbErr2) {
          logger.warn(
            LogCategory.ANALYSIS_QUEUE,
            '[WriteSetDispatcher] 批级失败闭环回滚失败:',
            rbErr2
          )
        }
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          '[WriteSetDispatcher] 批级失败闭环更新队列失败:',
          closeErr
        )
      }
      // 保留 Pre-step 已产出的 stale 回执，仅对 validBatch 追加 error 回执
      const validIds = new Set(validBatch.map(v => v.queueId))
      const preservedPreStepResults = results.filter(r => !validIds.has(r.queueId))
      return [
        ...preservedPreStepResults,
        ...validBatch.map(item => ({
          queueId: item.queueId,
          result: 'error' as const,
          errorKind: kind,
          reason: batchReason
        }))
      ]
    }

    // ==================== B5 COMMIT 后非事务尾钩子（Spec §6.3） ====================
    if (committedFingerprints.length > 0) {
      this.runPostCommitFanOut(db, committedFingerprints)
    }
    this.scheduleTailHooks(wakeupFingerprints, workspaceDeletes)

    return results
  }

  /** Spec §5.6：视频分段独立事务（不参与 8 步文件事务） */
  commitVideoSegment(seg: VideoSegmentWriteSet): WriteAckItem {
    const db = this.deps.getDb()
    if (!db) {
      return {
        queueId: seg.queueId,
        result: 'error',
        errorKind: 'SQLITE_BUSY',
        reason: 'database_unavailable'
      }
    }

    try {
      db.exec('BEGIN IMMEDIATE')
      const chunkIndices = seg.chunks.map(c => c.chunkIndex)
      if (chunkIndices.length > 0) {
        const minIdx = Math.min(...chunkIndices)
        const maxIdx = Math.max(...chunkIndices)
        db.prepare(
          `DELETE FROM file_video_chunks
           WHERE file_fingerprint = ? AND chunk_index BETWEEN ? AND ?`
        ).run(seg.fileFingerprint, minIdx, maxIdx)

        const insertChunk = db.prepare(
          `INSERT INTO file_video_chunks
             (file_fingerprint, chunk_index, start_sec, end_sec, rep_pts_sec, meta, sampling_interval_seconds)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        for (const chunk of seg.chunks) {
          insertChunk.run(
            seg.fileFingerprint,
            chunk.chunkIndex,
            chunk.startSec,
            chunk.endSec,
            chunk.repPtsSec ?? null,
            chunk.meta ?? '{}',
            chunk.samplingIntervalSeconds ?? 1.0
          )
        }
      }
      db.prepare(
        `UPDATE file_video_segments
         SET status = 'completed', updated_at = ?
         WHERE id = ? AND status = 'processing'`
      ).run(Date.now(), seg.segmentId)
      db.exec('COMMIT')
      return { queueId: seg.queueId, result: 'ok' }
    } catch (err) {
      try {
        if (db.inTransaction) db.exec('ROLLBACK')
      } catch (rbErr) {
        logger.warn(LogCategory.ANALYSIS_QUEUE, '[WriteSetDispatcher] 视频段事务回滚失败:', rbErr)
      }
      const { kind } = classifyWorkerErrorKind(err)
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        `[WriteSetDispatcher] 视频段事务失败 (segmentId=${seg.segmentId}, kind=${kind}):`,
        err
      )
      return {
        queueId: seg.queueId,
        result: 'error',
        errorKind: kind,
        reason: err instanceof Error ? err.message : String(err)
      }
    }
  }

  /** Spec §6.3：同指纹多工作区扇出（失败不回滚主事务，仅记录告警） */
  private runPostCommitFanOut(db: Database, fingerprints: string[]): void {
    try {
      const stmt = db.prepare(
        `UPDATE workspace_files
         SET is_analyzed = 1, last_analyzed_at = CURRENT_TIMESTAMP
         WHERE file_fingerprint = ? AND is_analyzed = 0`
      )
      for (const fp of new Set(fingerprints)) {
        stmt.run(fp)
      }
    } catch (err) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[WriteSetDispatcher] 同指纹多工作区扇出失败:', err)
    }
  }

  /** Spec §6.3 v2.4：尾部防抖（≥ 3000ms）批量唤醒 canonicalMaintenance + cloudSyncWorker */
  private scheduleTailHooks(wakeupFingerprints: string[], workspaceDeletes: number[]): void {
    for (const fp of wakeupFingerprints) this.pendingCanonicalWakeups.add(fp)
    for (const id of workspaceDeletes) this.pendingWorkspaceDeletes.add(id)

    if (this.pendingCanonicalWakeups.size === 0 && this.pendingWorkspaceDeletes.size === 0) {
      return
    }
    if (this.tailHookTimer) {
      clearTimeout(this.tailHookTimer)
    }
    this.tailHookTimer = setTimeout(() => {
      this.tailHookTimer = null
      this.flushTailHooks()
    }, this.tailHookDebounceMs)
    this.tailHookTimer.unref?.()
  }

  /** 立即冲刷尾钩子（供退出清理与测试调用） */
  flushTailHooks(): TailHookBatchContext {
    if (this.tailHookTimer) {
      clearTimeout(this.tailHookTimer)
      this.tailHookTimer = null
    }
    const wakeups = Array.from(this.pendingCanonicalWakeups)
    const deletes = Array.from(this.pendingWorkspaceDeletes)
    this.pendingCanonicalWakeups.clear()
    this.pendingWorkspaceDeletes.clear()

    if (wakeups.length > 0) {
      setImmediate(() => {
        try {
          this.deps.onWakeCanonicalMaintenance?.(wakeups)
        } catch (err) {
          logger.warn(
            LogCategory.ANALYSIS_QUEUE,
            '[WriteSetDispatcher] 唤醒 canonicalMaintenance 失败:',
            err
          )
        }
        try {
          this.deps.onTriggerCloudSync?.(2000)
        } catch (err) {
          logger.warn(
            LogCategory.ANALYSIS_QUEUE,
            '[WriteSetDispatcher] 唤醒 cloudSyncWorker 失败:',
            err
          )
        }
      })
    }
    if (deletes.length > 0) {
      setImmediate(() => {
        try {
          this.deps.onWorkspaceDeletes?.(deletes)
        } catch (err) {
          logger.warn(
            LogCategory.ANALYSIS_QUEUE,
            '[WriteSetDispatcher] 处理 workspaceDeletes 尾钩子失败:',
            err
          )
        }
      })
    }
    return { canonicalVectorWakeups: wakeups, workspaceDeletes: deletes }
  }

  dispose(): void {
    this.disposed = true
    this.clearCoalesceTimer()
    if (this.pauseResumeTimer) {
      clearTimeout(this.pauseResumeTimer)
      this.pauseResumeTimer = null
    }
    if (this.tailHookTimer) {
      clearTimeout(this.tailHookTimer)
      this.tailHookTimer = null
    }
    this.pendingWriteSets = []
    this.pendingCanonicalWakeups.clear()
    this.pendingWorkspaceDeletes.clear()
  }

  private clearCoalesceTimer(): void {
    if (this.coalesceTimer) {
      clearTimeout(this.coalesceTimer)
      this.coalesceTimer = null
    }
  }
}
