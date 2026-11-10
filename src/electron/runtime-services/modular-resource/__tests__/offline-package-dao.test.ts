import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { GENESIS_V1_SCHEMA } from '../../database/database'
import { OfflinePackageDao } from '../offline-package-dao'

describe('OfflinePackageDao (Genesis V1 SQLite)', () => {
  let db: Database.Database
  let dao: OfflinePackageDao

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(GENESIS_V1_SCHEMA)
    dao = new OfflinePackageDao(db)
  })

  afterEach(() => {
    db.close()
  })

  it('should create an offline package job with default values', () => {
    const job = dao.createJob({
      job_id: 'job-1',
      job_type: 'EXPORT',
      status: 'EXPORTING',
      archive_path: 'C:/exports/bundle.ffp',
      total_modules: 3,
      created_resource_ids: ['res-1'],
      reused_resource_ids: ['res-2']
    })

    expect(job.job_id).toBe('job-1')
    expect(job.job_type).toBe('EXPORT')
    expect(job.status).toBe('EXPORTING')
    expect(job.archive_path).toBe('C:/exports/bundle.ffp')
    expect(job.total_modules).toBe(3)
    expect(JSON.parse(job.created_resource_ids)).toEqual(['res-1'])
    expect(JSON.parse(job.reused_resource_ids)).toEqual(['res-2'])
    expect(job.superseded_by_job_id).toBeNull()
    expect(job.verification_attempts).toBe(0)
    expect(job.consecutive_worker_crashes).toBe(0)

    const fetched = dao.getJob('job-1')
    expect(fetched).not.toBeNull()
    expect(fetched?.status).toBe('EXPORTING')
  })

  it('should enforce CHECK constraints on job status including RECOVERY_REQUIRED', () => {
    const validStatuses = [
      'PREPARED',
      'PROMOTING',
      'PROMOTED',
      'DB_COMMITTED',
      'EXPORTING',
      'CLEANUP_PENDING',
      'FINISHED',
      'FAILED',
      'RECOVERY_REQUIRED'
    ] as const

    for (let i = 0; i < validStatuses.length; i++) {
      const status = validStatuses[i]
      dao.createJob({
        job_id: `valid-${i}`,
        job_type: 'IMPORT',
        status,
        archive_path: `path-${i}`,
        total_modules: 1
      })
      const record = dao.getJob(`valid-${i}`)
      expect(record?.status).toBe(status)
    }

    // 非法状态应该被 CHECK 约束拦截
    expect(() => {
      dao.createJob({
        job_id: 'invalid-status',
        job_type: 'IMPORT',
        status: 'UNKNOWN_STATUS' as any,
        archive_path: 'invalid-path',
        total_modules: 1
      })
    }).toThrow(/CHECK constraint failed/)
  })

  it('should enforce unique index on active export archive_path', () => {
    dao.createJob({
      job_id: 'active-1',
      job_type: 'EXPORT',
      status: 'EXPORTING',
      archive_path: 'C:/exports/same.ffp',
      total_modules: 1
    })

    // 再次向同一路径插入 EXPORTING 任务应被唯一索引阻断
    expect(() => {
      dao.createJob({
        job_id: 'active-2',
        job_type: 'EXPORT',
        status: 'EXPORTING',
        archive_path: 'C:/exports/same.ffp',
        total_modules: 1
      })
    }).toThrow(/UNIQUE constraint failed/)

    // 插入已处于 FAILED 的同路径任务应放行（局部索引过滤）
    dao.createJob({
      job_id: 'failed-1',
      job_type: 'EXPORT',
      status: 'FAILED',
      archive_path: 'C:/exports/same.ffp',
      total_modules: 1
    })
    expect(dao.getJob('failed-1')).not.toBeNull()
  })

  it('should supersede pending export jobs atomically', () => {
    dao.createJob({
      job_id: 'old-export',
      job_type: 'EXPORT',
      status: 'CLEANUP_PENDING',
      archive_path: 'C:/target.ffp',
      total_modules: 2
    })

    const supersededCount = dao.supersedePendingExports('C:/target.ffp', 'new-export-job', 1000)
    expect(supersededCount).toBe(1)

    const updated = dao.getJob('old-export')
    expect(updated?.status).toBe('FAILED')
    expect(updated?.superseded_by_job_id).toBe('new-export-job')
    expect(updated?.superseded_at).toBe(1000)
    expect(updated?.updated_at).toBe(1000)
  })

  it('should group unconverged export jobs by archive_path and elect authoritative job', () => {
    // 临时移除唯一索引以模拟历史脏数据/极端残留场景下的权威推选算法
    db.exec(`DROP INDEX IF EXISTS idx_offline_package_jobs_active_export`)

    // 路径 A: 2 个任务，一个 CLEANUP_PENDING，一个较新的 EXPORTING
    dao.createJob({
      job_id: 'a-pending',
      job_type: 'EXPORT',
      status: 'CLEANUP_PENDING',
      archive_path: 'C:/path-a.ffp',
      total_modules: 1,
      created_at: 100,
      updated_at: 100
    })
    dao.createJob({
      job_id: 'a-exporting',
      job_type: 'EXPORT',
      status: 'EXPORTING',
      archive_path: 'C:/path-a.ffp',
      total_modules: 1,
      created_at: 200,
      updated_at: 200
    })

    // 路径 B: 1 个 EXPORTING 任务
    dao.createJob({
      job_id: 'b-exporting',
      job_type: 'EXPORT',
      status: 'EXPORTING',
      archive_path: 'C:/path-b.ffp',
      total_modules: 1,
      created_at: 300,
      updated_at: 300
    })

    const grouped = dao.getJobsGroupedByArchivePath()
    expect(grouped.has('C:/path-a.ffp')).toBe(true)
    expect(grouped.has('C:/path-b.ffp')).toBe(true)

    const groupA = grouped.get('C:/path-a.ffp')!
    // CLEANUP_PENDING 优先级高于 EXPORTING
    expect(groupA.authoritative.job_id).toBe('a-pending')
    expect(groupA.others.length).toBe(1)
    expect(groupA.others[0].job_id).toBe('a-exporting')

    const groupB = grouped.get('C:/path-b.ffp')!
    expect(groupB.authoritative.job_id).toBe('b-exporting')
    expect(groupB.others.length).toBe(0)

    // 清理脏数据并恢复索引
    db.exec(
      `DELETE FROM offline_package_jobs WHERE archive_path IN ('C:/path-a.ffp', 'C:/path-b.ffp')`
    )
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_offline_package_jobs_active_export
      ON offline_package_jobs (archive_path)
      WHERE job_type = 'EXPORT' AND status IN ('EXPORTING', 'CLEANUP_PENDING');
    `)
  })

  it('should find superseded export job and restore it with cleared metadata', () => {
    dao.createJob({
      job_id: 'old-job',
      job_type: 'EXPORT',
      status: 'CLEANUP_PENDING',
      archive_path: 'C:/target.ffp',
      total_modules: 2
    })
    dao.supersedePendingExports('C:/target.ffp', 'new-crashed-job', 2000)

    const found = dao.findSupersededExportJob('C:/target.ffp', 'new-crashed-job')
    expect(found).not.toBeNull()
    expect(found?.job_id).toBe('old-job')

    // 恢复旧任务
    dao.restoreSupersededExportJob('old-job', 3000)
    const restored = dao.getJob('old-job')
    expect(restored?.status).toBe('CLEANUP_PENDING')
    expect(restored?.superseded_by_job_id).toBeNull()
    expect(restored?.superseded_at).toBeNull()
    expect(restored?.consecutive_worker_crashes).toBe(0)
    expect(restored?.updated_at).toBe(3000)
  })

  it('should accurately maintain verification attempts and consecutive worker crashes', () => {
    dao.createJob({
      job_id: 'dryrun-job',
      job_type: 'EXPORT',
      status: 'CLEANUP_PENDING',
      archive_path: 'C:/dryrun.ffp',
      total_modules: 1
    })

    // 调度尝试累加（仅增不减）
    expect(dao.incrementVerificationAttempts('dryrun-job')).toBe(1)
    expect(dao.incrementVerificationAttempts('dryrun-job')).toBe(2)

    // 连续崩溃记录
    const crash1 = dao.recordWorkerCrash('dryrun-job')
    expect(crash1.consecutiveCrashes).toBe(1)
    expect(crash1.shouldTrip).toBe(false)

    // 模拟正常退出时重置
    dao.resetWorkerCrash('dryrun-job')
    expect(dao.getJob('dryrun-job')?.consecutive_worker_crashes).toBe(0)
    // 尝试次数仍为 2
    expect(dao.getJob('dryrun-job')?.verification_attempts).toBe(2)

    // 连续 3 次崩溃触发熔断
    dao.recordWorkerCrash('dryrun-job')
    dao.recordWorkerCrash('dryrun-job')
    const crash3 = dao.recordWorkerCrash('dryrun-job')
    expect(crash3.consecutiveCrashes).toBe(3)
    expect(crash3.shouldTrip).toBe(true)

    dao.tripCircuitBreaker('dryrun-job')
    expect(dao.getJob('dryrun-job')?.status).toBe('FAILED')
  })

  it('should evict stale pending jobs by TTL and FIFO limit', () => {
    const now = 1000000000
    const eightDaysAgo = now - 8 * 24 * 3600 * 1000

    // 1. 超期 8 天但尝试过 1 次 ➔ 应当被淘汰
    dao.createJob({
      job_id: 'stale-1',
      job_type: 'EXPORT',
      status: 'CLEANUP_PENDING',
      archive_path: 'C:/stale-1.ffp',
      total_modules: 1,
      created_at: eightDaysAgo,
      updated_at: eightDaysAgo
    })
    dao.incrementVerificationAttempts('stale-1', eightDaysAgo)

    // 2. 超期 8 天但未尝试过 (verification_attempts = 0) ➔ 应当保留（防排队积压误杀）
    dao.createJob({
      job_id: 'stale-unattempted',
      job_type: 'EXPORT',
      status: 'CLEANUP_PENDING',
      archive_path: 'C:/stale-unattempted.ffp',
      total_modules: 1,
      created_at: eightDaysAgo,
      updated_at: eightDaysAgo
    })

    // 3. 当前活跃的 job ➔ 绝对不被淘汰
    dao.createJob({
      job_id: 'active-job',
      job_type: 'EXPORT',
      status: 'CLEANUP_PENDING',
      archive_path: 'C:/active.ffp',
      total_modules: 1,
      created_at: now,
      updated_at: now
    })

    const evicted = dao.evictExpiredOrOverflownJobs(now, 7, 50, 'active-job')
    expect(evicted).toContain('stale-1')
    expect(evicted).not.toContain('stale-unattempted')
    expect(evicted).not.toContain('active-job')

    expect(dao.getJob('stale-1')?.status).toBe('FAILED')
    expect(dao.getJob('stale-unattempted')?.status).toBe('CLEANUP_PENDING')

    // 4. 验证第二段 FIFO 超额截断分支 (queueLimit = 2)
    // 放入 4 个未过期的 CLEANUP_PENDING 任务
    for (let i = 1; i <= 4; i++) {
      dao.createJob({
        job_id: `fifo-${i}`,
        job_type: 'EXPORT',
        status: 'CLEANUP_PENDING',
        archive_path: `C:/fifo-${i}.ffp`,
        total_modules: 1,
        created_at: now + i * 10,
        updated_at: now + i * 10
      })
    }

    // 传入 limit: 2 ➔ 队列中有 4 个任务，最早创建的 fifo-1 与 fifo-2 必须被淘汰
    const fifoEvicted = dao.evictExpiredOrOverflownJobs(now + 100, 7, 2)
    expect(fifoEvicted).toContain('fifo-1')
    expect(fifoEvicted).toContain('fifo-2')
    expect(fifoEvicted).not.toContain('fifo-3')
    expect(fifoEvicted).not.toContain('fifo-4')

    expect(dao.getJob('fifo-1')?.status).toBe('FAILED')
    expect(dao.getJob('fifo-2')?.status).toBe('FAILED')
    expect(dao.getJob('fifo-3')?.status).toBe('CLEANUP_PENDING')
    expect(dao.getJob('fifo-4')?.status).toBe('CLEANUP_PENDING')
  })

  it('should atomically supersede and create new export job in one transaction', () => {
    dao.createJob({
      job_id: 'old-export-1',
      job_type: 'EXPORT',
      status: 'CLEANUP_PENDING',
      archive_path: 'C:/supersede-tx.ffp',
      total_modules: 1,
      created_at: 100,
      updated_at: 100
    })

    const { created, supersededCount } = dao.supersedeAndCreateExportJob(
      'C:/supersede-tx.ffp',
      {
        job_id: 'new-export-1',
        job_type: 'EXPORT',
        status: 'EXPORTING',
        archive_path: 'C:/supersede-tx.ffp',
        total_modules: 2
      },
      500
    )

    expect(supersededCount).toBe(1)
    expect(created.job_id).toBe('new-export-1')
    expect(created.status).toBe('EXPORTING')

    const oldJob = dao.getJob('old-export-1')
    expect(oldJob?.status).toBe('FAILED')
    expect(oldJob?.superseded_by_job_id).toBe('new-export-1')
    expect(oldJob?.superseded_at).toBe(500)
  })

  it('should flexibly update created_resource_ids and reused_resource_ids independently', () => {
    dao.createJob({
      job_id: 'flexible-update-job',
      job_type: 'IMPORT',
      status: 'PREPARED',
      archive_path: 'C:/test.ffp',
      total_modules: 1
    })

    // 仅更新 created_resource_ids
    dao.updateJobStatus('flexible-update-job', 'PROMOTING', {
      created_resource_ids: ['res-1', 'res-2']
    })
    const job1 = dao.getJob('flexible-update-job')
    expect(job1?.status).toBe('PROMOTING')
    expect(JSON.parse(job1?.created_resource_ids || '[]')).toEqual(['res-1', 'res-2'])
    expect(JSON.parse(job1?.reused_resource_ids || '[]')).toEqual([])

    // 仅更新 reused_resource_ids
    dao.updateJobStatus('flexible-update-job', 'PROMOTED', {
      reused_resource_ids: ['res-3']
    })
    const job2 = dao.getJob('flexible-update-job')
    expect(job2?.status).toBe('PROMOTED')
    expect(JSON.parse(job2?.created_resource_ids || '[]')).toEqual(['res-1', 'res-2'])
    expect(JSON.parse(job2?.reused_resource_ids || '[]')).toEqual(['res-3'])
  })
})
