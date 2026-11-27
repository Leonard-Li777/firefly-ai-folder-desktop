import type { Database } from 'better-sqlite3'

export type VisualTaggerLastStatus = 'ok' | 'non_ok'

export interface VisualTaggerStateRow {
  encoder_id: number
  last_status: VisualTaggerLastStatus
  generation: number
  expected_fingerprint: string | null
  last_app_version: string | null
  updated_at: number
}

/** 遇此集合内失败码在 `generation` 递增且目标槽就绪后可自动限速重投；422 `INPUT_REJECTED` 严禁入列 */
export const REQUEUEABLE_VISUAL_FAILURE_CODES = [
  'ASSET_MISSING',
  'ASSET_CORRUPT',
  'needs_plugin_update'
] as const

/**
 * 视觉打标器状态代际 DAO（Spec v2.12 §3.3 / Ticket 09）
 *
 * 硬不变量：
 * 1. 所有视觉失败记录（`analysis_queue` / `file_video_segments`）与 `visual_tagger_state.last_status = 'non_ok'`
 *    必须在**同一个 SQLite 事务**内原子提交，杜绝状态与失败记录撕裂；
 * 2. 使用单调整数 `generation` 判定重投资格，彻底免疫系统时钟回拨/同毫秒并发竞态；
 * 3. `INPUT_REJECTED` (422) 与 `unexpected_http` 绝不修改 `visual_tagger_state`、绝不重投。
 */
export class VisualTaggerStateDao {
  constructor(private readonly db: Database) {}

  public getState(encoderId: number): VisualTaggerStateRow | null {
    const row = this.db
      .prepare(
        `SELECT encoder_id, last_status, generation, expected_fingerprint, last_app_version, updated_at
         FROM visual_tagger_state
         WHERE encoder_id = ?`
      )
      .get(encoderId) as VisualTaggerStateRow | undefined
    return row ?? null
  }

  public getCurrentGeneration(encoderId: number): number {
    return this.getState(encoderId)?.generation ?? 0
  }

  /**
   * 原子记录主队列视觉失败（或确认状态机终态），并在同事务内把 `visual_tagger_state` 置为 `non_ok`
   */
  public recordQueueVisualFailureTx(params: {
    queueId: number
    errorMessage: string
    failureCode: string
    encoderId: number
    expectedFingerprint?: string | null
    markStateNonOk?: boolean
  }): { failureGeneration: number } {
    const now = Date.now()
    const nowIso = new Date(now).toISOString()
    const markNonOk = params.markStateNonOk ?? params.failureCode !== 'INPUT_REJECTED'

    const tx = this.db.transaction(() => {
      const existing = this.getState(params.encoderId)
      const generation = existing?.generation ?? 0

      if (markNonOk) {
        if (existing) {
          this.db
            .prepare(
              `UPDATE visual_tagger_state
               SET last_status = 'non_ok',
                   expected_fingerprint = COALESCE(?, expected_fingerprint),
                   updated_at = ?
               WHERE encoder_id = ?`
            )
            .run(params.expectedFingerprint ?? null, now, params.encoderId)
        } else {
          this.db
            .prepare(
              `INSERT INTO visual_tagger_state (encoder_id, last_status, generation, expected_fingerprint, updated_at)
               VALUES (?, 'non_ok', 0, ?, ?)`
            )
            .run(params.encoderId, params.expectedFingerprint ?? null, now)
        }
      }

      this.db
        .prepare(
          `UPDATE analysis_queue
           SET status = 'failed',
               progress = 100,
               error = ?,
               failure_code = ?,
               failure_encoder_id = ?,
               failure_generation = ?,
               claimed_at = NULL,
               end_time = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(
          params.errorMessage,
          params.failureCode,
          params.encoderId,
          generation,
          nowIso,
          nowIso,
          params.queueId
        )

      return { failureGeneration: generation }
    })

    return tx()
  }

  /**
   * 原子记录视频分段失败（含 k>=1 独立失败与 0 号切片失败）并在同事务更新 `visual_tagger_state`
   */
  public recordVideoSegmentVisualFailureTx(params: {
    fileId: string
    segmentIndex: number
    errorMessage: string
    failureCode: string
    encoderId: number
    expectedFingerprint?: string | null
    markStateNonOk?: boolean
  }): { failureGeneration: number } {
    const now = Date.now()
    const markNonOk = params.markStateNonOk ?? params.failureCode !== 'INPUT_REJECTED'

    const tx = this.db.transaction(() => {
      const existing = this.getState(params.encoderId)
      const generation = existing?.generation ?? 0

      if (markNonOk) {
        if (existing) {
          this.db
            .prepare(
              `UPDATE visual_tagger_state
               SET last_status = 'non_ok',
                   expected_fingerprint = COALESCE(?, expected_fingerprint),
                   updated_at = ?
               WHERE encoder_id = ?`
            )
            .run(params.expectedFingerprint ?? null, now, params.encoderId)
        } else {
          this.db
            .prepare(
              `INSERT INTO visual_tagger_state (encoder_id, last_status, generation, expected_fingerprint, updated_at)
               VALUES (?, 'non_ok', 0, ?, ?)`
            )
            .run(params.encoderId, params.expectedFingerprint ?? null, now)
        }
      }

      this.db
        .prepare(
          `UPDATE file_video_segments
           SET status = 'failed',
               error_message = ?,
               failure_code = ?,
               failure_encoder_id = ?,
               failure_generation = ?,
               attempt_count = attempt_count + 1,
               updated_at = ?
           WHERE file_id = ? AND segment_index = ?`
        )
        .run(
          params.errorMessage,
          params.failureCode,
          params.encoderId,
          generation,
          now,
          params.fileId,
          params.segmentIndex
        )

      return { failureGeneration: generation }
    })

    return tx()
  }

  /**
   * 观测激活视觉槽就绪、预期指纹变更或宿主版本升级：
   * 仅当 `non_ok -> ok`、`expected_fingerprint` 变更或 `last_app_version` 升级时递增单调 `generation`
   */
  public observeTaggerHealthyOrFingerprintChangedTx(
    encoderId: number,
    expectedFingerprint?: string | null,
    currentAppVersion?: string | null
  ): {
    bumped: boolean
    appVersionChanged: boolean
    previousGeneration: number
    currentGeneration: number
  } {
    const now = Date.now()
    const nextFp = expectedFingerprint ?? null
    const nextVer = currentAppVersion?.trim() ? currentAppVersion.trim() : null

    const tx = this.db.transaction(() => {
      const existing = this.getState(encoderId)
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO visual_tagger_state (encoder_id, last_status, generation, expected_fingerprint, last_app_version, updated_at)
             VALUES (?, 'ok', 1, ?, ?, ?)`
          )
          .run(encoderId, nextFp, nextVer, now)
        return {
          bumped: true,
          appVersionChanged: false,
          previousGeneration: 0,
          currentGeneration: 1
        }
      }

      const recoveredFromNonOk = existing.last_status === 'non_ok'
      const fingerprintChanged =
        nextFp !== null && existing.expected_fingerprint !== null && nextFp !== existing.expected_fingerprint
      let appVersionChanged =
        nextVer !== null && existing.last_app_version !== null && nextVer !== existing.last_app_version
      if (!appVersionChanged && existing.last_app_version === null && nextVer !== null) {
        const hasPendingUpgradeQueue = this.db
          .prepare(
            `SELECT 1 FROM analysis_queue
             WHERE status = 'failed' AND failure_encoder_id = ? AND failure_code = 'needs_app_update'
             LIMIT 1`
          )
          .get(encoderId)
        const hasPendingUpgradeSeg = !hasPendingUpgradeQueue
          ? this.db
              .prepare(
                `SELECT 1 FROM file_video_segments
                 WHERE status = 'failed' AND failure_encoder_id = ? AND failure_code = 'needs_app_update'
                 LIMIT 1`
              )
              .get(encoderId)
          : undefined
        if (hasPendingUpgradeQueue || hasPendingUpgradeSeg) {
          appVersionChanged = true
        }
      }

      if (recoveredFromNonOk || fingerprintChanged || appVersionChanged) {
        const nextGen = existing.generation + 1
        this.db
          .prepare(
            `UPDATE visual_tagger_state
             SET last_status = 'ok',
                 generation = ?,
                 expected_fingerprint = COALESCE(?, expected_fingerprint),
                 last_app_version = COALESCE(?, last_app_version),
                 updated_at = ?
             WHERE encoder_id = ?`
          )
          .run(nextGen, nextFp, nextVer, now, encoderId)
        return {
          bumped: true,
          appVersionChanged,
          previousGeneration: existing.generation,
          currentGeneration: nextGen
        }
      }

      this.db
        .prepare(
          `UPDATE visual_tagger_state
           SET last_status = 'ok',
               expected_fingerprint = COALESCE(?, expected_fingerprint),
               last_app_version = COALESCE(?, last_app_version),
               updated_at = ?
           WHERE encoder_id = ?`
        )
        .run(nextFp, nextVer, now, encoderId)

      return {
        bumped: false,
        appVersionChanged: false,
        previousGeneration: existing.generation,
        currentGeneration: existing.generation
      }
    })

    return tx()
  }

  /**
   * 基于代际比较的限速重投：
   * `record.failure_encoder_id == activeEncoderId AND record.failure_generation < currentGeneration`
   * 且 `failure_code` 在可恢复白名单内（含可选因 `appVersionChanged` 解封的 `needs_app_update`）。
   */
  public requeueEligibleFailedItemsTx(params: {
    activeEncoderId: number
    currentGeneration: number
    limit?: number
    includeNeedsAppUpdate?: boolean
  }): { requeuedQueueCount: number; requeuedSegmentCount: number } {
    const limit = Math.max(1, params.limit ?? 50)
    const now = Date.now()
    const nowIso = new Date(now).toISOString()
    const allowedCodes: string[] = [...REQUEUEABLE_VISUAL_FAILURE_CODES]
    if (params.includeNeedsAppUpdate) {
      allowedCodes.push('needs_app_update')
    }
    const placeholders = allowedCodes.map(() => '?').join(', ')

    const tx = this.db.transaction(() => {
      const queueRows = this.db
        .prepare(
          `SELECT id FROM analysis_queue
           WHERE status = 'failed'
             AND failure_encoder_id = ?
             AND failure_generation IS NOT NULL
             AND failure_generation < ?
             AND failure_code IN (${placeholders})
           ORDER BY id ASC
           LIMIT ?`
        )
        .all(params.activeEncoderId, params.currentGeneration, ...allowedCodes, limit) as Array<{
        id: number
      }>

      let requeuedQueueCount = 0
      if (queueRows.length > 0) {
        const updateQueueStmt = this.db.prepare(
          `UPDATE analysis_queue
           SET status = 'pending',
               progress = 0,
               error = NULL,
               failure_code = NULL,
               failure_encoder_id = NULL,
               failure_generation = NULL,
               claimed_at = NULL,
               end_time = NULL,
               retry_count = retry_count + 1,
               updated_at = ?
           WHERE id = ?`
        )
        for (const r of queueRows) {
          requeuedQueueCount += Number(updateQueueStmt.run(nowIso, r.id).changes ?? 0)
        }
      }

      const segRows = this.db
        .prepare(
          `SELECT file_id, segment_index FROM file_video_segments
           WHERE status = 'failed'
             AND failure_encoder_id = ?
             AND failure_generation IS NOT NULL
             AND failure_generation < ?
             AND failure_code IN (${placeholders})
           ORDER BY updated_at ASC
           LIMIT ?`
        )
        .all(params.activeEncoderId, params.currentGeneration, ...allowedCodes, limit) as Array<{
        file_id: string
        segment_index: number
      }>

      let requeuedSegmentCount = 0
      if (segRows.length > 0) {
        const updateSegStmt = this.db.prepare(
          `UPDATE file_video_segments
           SET status = 'pending',
               attempt_count = 0,
               error_message = NULL,
               failure_code = NULL,
               failure_encoder_id = NULL,
               failure_generation = NULL,
               updated_at = ?
           WHERE file_id = ? AND segment_index = ?`
        )
        for (const s of segRows) {
          requeuedSegmentCount += Number(updateSegStmt.run(now, s.file_id, s.segment_index).changes ?? 0)
        }
      }

      return { requeuedQueueCount, requeuedSegmentCount }
    })

    return tx()
  }
}
