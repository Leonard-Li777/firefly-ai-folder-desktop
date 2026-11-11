/**
 * 离线总包导入导出协调任务数据访问对象 (Offline Package Coordination DAO)
 *
 * @doc-anchor: docs/specs/plugin-center-offline-package-and-environment-visibility-spec.md#333-offline_package_jobs-协调表与崩溃恢复决策矩阵-crash-recovery-matrix
 */

import type { Database } from 'better-sqlite3'
import { logger, LogCategory } from '@firefly/shared'

export type OfflinePackageJobType = 'IMPORT' | 'EXPORT'

export type OfflinePackageJobStatus =
  | 'PREPARED'
  | 'PROMOTING'
  | 'PROMOTED'
  | 'DB_COMMITTED'
  | 'EXPORTING'
  | 'CLEANUP_PENDING'
  | 'FINISHED'
  | 'FAILED'
  | 'RECOVERY_REQUIRED'

export interface OfflinePackageJobRecord {
  job_id: string
  job_type: OfflinePackageJobType
  status: OfflinePackageJobStatus
  archive_path: string
  total_modules: number
  created_resource_ids: string
  reused_resource_ids: string
  superseded_by_job_id?: string | null
  superseded_at?: number | null
  verification_attempts: number
  consecutive_worker_crashes: number
  created_at: number
  updated_at: number
}

export interface CreateOfflineJobParams {
  job_id: string
  job_type: OfflinePackageJobType
  status: OfflinePackageJobStatus
  archive_path: string
  total_modules: number
  created_resource_ids?: string[]
  reused_resource_ids?: string[]
  created_at?: number
  updated_at?: number
}

export interface GroupedAuthoritativeJobs {
  authoritative: OfflinePackageJobRecord
  others: OfflinePackageJobRecord[]
}

export class OfflinePackageDao {
  constructor(private db: Database) {}

  /**
   * 登记新的离线包导入/导出任务
   */
  public createJob(params: CreateOfflineJobParams): OfflinePackageJobRecord {
    const now = Date.now()
    const createdAt = params.created_at ?? now
    const updatedAt = params.updated_at ?? now
    const createdResourceIdsJson = JSON.stringify(params.created_resource_ids ?? [])
    const reusedResourceIdsJson = JSON.stringify(params.reused_resource_ids ?? [])

    const stmt = this.db.prepare(`
      INSERT INTO offline_package_jobs (
        job_id,
        job_type,
        status,
        archive_path,
        total_modules,
        created_resource_ids,
        reused_resource_ids,
        verification_attempts,
        consecutive_worker_crashes,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
    `)

    stmt.run(
      params.job_id,
      params.job_type,
      params.status,
      params.archive_path,
      params.total_modules,
      createdResourceIdsJson,
      reusedResourceIdsJson,
      createdAt,
      updatedAt
    )

    return {
      job_id: params.job_id,
      job_type: params.job_type,
      status: params.status,
      archive_path: params.archive_path,
      total_modules: params.total_modules,
      created_resource_ids: createdResourceIdsJson,
      reused_resource_ids: reusedResourceIdsJson,
      superseded_by_job_id: null,
      superseded_at: null,
      verification_attempts: 0,
      consecutive_worker_crashes: 0,
      created_at: createdAt,
      updated_at: updatedAt
    }
  }

  /**
   * 按 ID 获取任务记录
   */
  public getJob(jobId: string): OfflinePackageJobRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM offline_package_jobs WHERE job_id = ?
    `)
    return (stmt.get(jobId) as OfflinePackageJobRecord) ?? null
  }

  /**
   * 更新任务状态与资源归属集合
   */
  public updateJobStatus(
    jobId: string,
    status: OfflinePackageJobStatus,
    details?: {
      created_resource_ids?: string[]
      reused_resource_ids?: string[]
      nowMs?: number
    }
  ): void {
    const now = details?.nowMs ?? Date.now()
    const sets: string[] = ['status = ?', 'updated_at = ?']
    const bindings: unknown[] = [status, now]

    if (details?.created_resource_ids !== undefined) {
      sets.push('created_resource_ids = ?')
      bindings.push(JSON.stringify(details.created_resource_ids))
    }
    if (details?.reused_resource_ids !== undefined) {
      sets.push('reused_resource_ids = ?')
      bindings.push(JSON.stringify(details.reused_resource_ids))
    }

    bindings.push(jobId)
    const stmt = this.db.prepare(`
      UPDATE offline_package_jobs
      SET ${sets.join(', ')}
      WHERE job_id = ?
    `)
    stmt.run(...bindings)
  }

  /**
   * 同路径活跃导出任务原子 Supersede 铁律：
   * 将相同 archive_path 且处于 CLEANUP_PENDING 的导出任务原子更新为 FAILED，附带 superseded_by_job_id
   */
  public supersedePendingExports(
    archivePath: string,
    newJobId: string,
    nowMs: number = Date.now()
  ): number {
    const stmt = this.db.prepare(`
      UPDATE offline_package_jobs
      SET status = 'FAILED',
          superseded_by_job_id = ?,
          superseded_at = ?,
          updated_at = ?
      WHERE archive_path = ?
        AND job_type = 'EXPORT'
        AND status = 'CLEANUP_PENDING'
    `)
    const result = stmt.run(newJobId, nowMs, nowMs, archivePath)
    return result.changes
  }

  /**
   * 原子 Supersede 与创建新导出任务复合事务（升维设计）
   * 在同一个 SQLite 事务中完成：
   * 1. 原子 Supersede 同路径下旧的 CLEANUP_PENDING 导出任务；
   * 2. 插入新的 EXPORTING 任务。
   */
  public supersedeAndCreateExportJob(
    archivePath: string,
    params: CreateOfflineJobParams,
    nowMs: number = Date.now()
  ): { created: OfflinePackageJobRecord; supersededCount: number } {
    const tx = this.db.transaction(() => {
      const supersededCount = this.supersedePendingExports(archivePath, params.job_id, nowMs)
      const created = this.createJob({
        ...params,
        archive_path: archivePath,
        created_at: params.created_at ?? nowMs,
        updated_at: params.updated_at ?? nowMs
      })
      return { created, supersededCount }
    })
    return tx()
  }

  /**
   * 查询同路径活跃导出任务 (EXPORTING 或 CLEANUP_PENDING)
   */
  public getActiveExport(archivePath: string): OfflinePackageJobRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM offline_package_jobs
      WHERE archive_path = ?
        AND job_type = 'EXPORT'
        AND status IN ('EXPORTING', 'CLEANUP_PENDING')
      LIMIT 1
    `)
    return (stmt.get(archivePath) as OfflinePackageJobRecord) ?? null
  }

  /**
   * 获取冷启动未收敛导出任务
   */
  public getUnconvergedExportJobs(): OfflinePackageJobRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM offline_package_jobs
      WHERE job_type = 'EXPORT'
        AND status IN ('EXPORTING', 'CLEANUP_PENDING')
      ORDER BY updated_at DESC
    `)
    return stmt.all() as OfflinePackageJobRecord[]
  }

  /**
   * 冷启动同目标路径多 job 分组收敛 (Group-by-Path Reconciliation)
   * 每组推选唯一的权威任务：状态优先级 CLEANUP_PENDING > EXPORTING；若状态相同则取 updated_at 最新者。
   */
  public getJobsGroupedByArchivePath(): Map<string, GroupedAuthoritativeJobs> {
    const unconverged = this.getUnconvergedExportJobs()
    const groups = new Map<string, OfflinePackageJobRecord[]>()

    for (const job of unconverged) {
      const list = groups.get(job.archive_path) ?? []
      list.push(job)
      groups.set(job.archive_path, list)
    }

    const result = new Map<string, GroupedAuthoritativeJobs>()

    groups.forEach((list, archivePath) => {
      // 排序规则：CLEANUP_PENDING 优先于 EXPORTING；状态相同时 updated_at 倒序；二级保证确定性（created_at 倒序，job_id 字典序）
      list.sort((a, b) => {
        if (a.status !== b.status) {
          if (a.status === 'CLEANUP_PENDING') return -1
          if (b.status === 'CLEANUP_PENDING') return 1
        }
        if (b.updated_at !== a.updated_at) {
          return b.updated_at - a.updated_at
        }
        if (b.created_at !== a.created_at) {
          return b.created_at - a.created_at
        }
        return b.job_id.localeCompare(a.job_id)
      })

      const authoritative = list[0]
      const others = list.slice(1)
      result.set(archivePath, { authoritative, others })
    })

    return result
  }

  /**
   * 批量将历史滞留任务置为 FAILED（支持分批 Chunking 防超过 SQLite 参数上限）
   */
  public batchMarkFailed(jobIds: string[], nowMs: number = Date.now(), reason?: string): void {
    if (jobIds.length === 0) return

    if (reason) {
      logger.info(
        LogCategory.DATABASE,
        `[OfflinePackageDao] Batch marking ${jobIds.length} jobs as FAILED. Reason: ${reason}`
      )
    }

    const chunkSize = 500
    for (let i = 0; i < jobIds.length; i += chunkSize) {
      const chunk = jobIds.slice(i, i + chunkSize)
      const placeholders = chunk.map(() => '?').join(',')
      const stmt = this.db.prepare(`
        UPDATE offline_package_jobs
        SET status = 'FAILED',
            updated_at = ?
        WHERE job_id IN (${placeholders})
      `)
      stmt.run(nowMs, ...chunk)
    }
  }

  /**
   * 阶段 1 权属恢复：通过结构化字段精确反查被特定新任务 supersede 的历史权威旧任务
   */
  public findSupersededExportJob(
    archivePath: string,
    supersededByJobId: string
  ): OfflinePackageJobRecord | null {
    const stmt = this.db.prepare(`
      SELECT * FROM offline_package_jobs
      WHERE archive_path = ?
        AND superseded_by_job_id = ?
        AND status = 'FAILED'
      LIMIT 1
    `)
    return (stmt.get(archivePath, supersededByJobId) as OfflinePackageJobRecord) ?? null
  }

  /**
   * 恢复被 supersede 的旧任务为 CLEANUP_PENDING，且同事务显式清空元数据生命周期
   */
  public restoreSupersededExportJob(jobId: string, nowMs: number = Date.now()): void {
    const stmt = this.db.prepare(`
      UPDATE offline_package_jobs
      SET status = 'CLEANUP_PENDING',
          superseded_by_job_id = NULL,
          superseded_at = NULL,
          consecutive_worker_crashes = 0,
          updated_at = ?
      WHERE job_id = ?
    `)
    stmt.run(nowMs, jobId)
  }

  /**
   * 递增 Dry-Run 校验调度总尝试计数 (仅增不减，审计统计用)
   */
  public incrementVerificationAttempts(jobId: string, nowMs: number = Date.now()): number {
    const stmt = this.db.prepare(`
      UPDATE offline_package_jobs
      SET verification_attempts = verification_attempts + 1,
          updated_at = ?
      WHERE job_id = ?
    `)
    stmt.run(nowMs, jobId)

    const job = this.getJob(jobId)
    return job?.verification_attempts ?? 0
  }

  /**
   * 记录 Worker 异常崩溃并返回连续崩溃次数与是否触发 3 次熔断
   */
  public recordWorkerCrash(
    jobId: string,
    nowMs: number = Date.now()
  ): { consecutiveCrashes: number; shouldTrip: boolean } {
    const stmt = this.db.prepare(`
      UPDATE offline_package_jobs
      SET consecutive_worker_crashes = consecutive_worker_crashes + 1,
          updated_at = ?
      WHERE job_id = ?
    `)
    stmt.run(nowMs, jobId)

    const job = this.getJob(jobId)
    const crashes = job?.consecutive_worker_crashes ?? 0
    return {
      consecutiveCrashes: crashes,
      shouldTrip: crashes >= 3
    }
  }

  /**
   * Worker 正常退出（code === 0）或主动取消时，同事务立即清零连续崩溃计数
   */
  public resetWorkerCrash(jobId: string, nowMs: number = Date.now()): void {
    const stmt = this.db.prepare(`
      UPDATE offline_package_jobs
      SET consecutive_worker_crashes = 0,
          updated_at = ?
      WHERE job_id = ?
    `)
    stmt.run(nowMs, jobId)
  }

  /**
   * 触发连续 3 次崩溃熔断，将任务置为 FAILED（磁盘 .ffp 永久保留不删）
   */
  public tripCircuitBreaker(jobId: string, nowMs: number = Date.now()): void {
    const stmt = this.db.prepare(`
      UPDATE offline_package_jobs
      SET status = 'FAILED',
          updated_at = ?
      WHERE job_id = ?
    `)
    stmt.run(nowMs, jobId)
  }

  /**
   * 获取所有 CLEANUP_PENDING 任务
   */
  public getCleanupPendingJobs(): OfflinePackageJobRecord[] {
    const stmt = this.db.prepare(`
      SELECT * FROM offline_package_jobs
      WHERE status = 'CLEANUP_PENDING'
      ORDER BY created_at ASC
    `)
    return stmt.all() as OfflinePackageJobRecord[]
  }

  /**
   * 两段式淘汰策略：
   * 第一段 TTL：以 updated_at 起算连续 7 天无法完成且至少尝试过 1 次
   * 第二段 FIFO：待处理队列超过 50 条上限时，按 created_at 升序淘汰最旧非活跃记录
   */
  public evictExpiredOrOverflownJobs(
    nowMs: number = Date.now(),
    ttlDays = 7,
    queueLimit = 50,
    activeJobId: string | null = null
  ): string[] {
    const pending = this.getCleanupPendingJobs()
    const evictedIds: string[] = []
    const ttlMs = ttlDays * 24 * 3600 * 1000

    // 第一段：TTL 超时淘汰 (连续 7 天且至少尝试过 1 次)
    for (const job of pending) {
      if (nowMs - job.updated_at > ttlMs && job.verification_attempts >= 1) {
        evictedIds.push(job.job_id)
      }
    }

    // 第二段：FIFO 超额淘汰
    const remainingPending = pending.filter(j => !evictedIds.includes(j.job_id))
    if (remainingPending.length > queueLimit) {
      // 严格按 created_at 升序（最早创建的优先被淘汰），且必须排除 activeJobId
      const overflownCount = remainingPending.length - queueLimit
      let count = 0
      for (const job of remainingPending) {
        if (job.job_id === activeJobId) continue
        evictedIds.push(job.job_id)
        count++
        if (count >= overflownCount) break
      }
    }

    if (evictedIds.length > 0) {
      this.batchMarkFailed(evictedIds, nowMs, 'stale pending jobs evicted by TTL/FIFO limits')
      logger.warn(
        LogCategory.DATABASE,
        `[OfflinePackageDao] Evicted ${evictedIds.length} stale pending jobs to FAILED (TTL/FIFO limits)`
      )
    }

    return evictedIds
  }
}

let defaultOfflinePackageDao: OfflinePackageDao | null = null

export function getOfflinePackageDao(customDb?: Database): OfflinePackageDao {
  if (customDb) {
    return new OfflinePackageDao(customDb)
  }
  if (!defaultOfflinePackageDao) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { databaseService } = require('../database/database-service')
      if (databaseService?.db) {
        defaultOfflinePackageDao = new OfflinePackageDao(databaseService.db)
      }
    } catch {
      // ignore
    }
  }
  if (!defaultOfflinePackageDao) {
    throw new Error('[OfflinePackageDao] Database has not been initialized yet.')
  }
  return defaultOfflinePackageDao
}
