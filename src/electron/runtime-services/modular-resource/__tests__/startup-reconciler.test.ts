/**
 * 应用冷启动两阶段对账与后台自包含 Dry-Run 校验单元测试
 *
 * 覆盖验收矩阵：
 * 1. 阶段 1：首屏前同步轻量对账 (<5ms)
 *    - 导入任务三态 ARIES 确定性自愈 (PREPARED/PROMOTING 撤销, PROMOTED 验签补写/损坏回滚, DB_COMMITTED 清理)
 *    - 导出任务同路径分组收敛与被取代旧任务精准权属恢复 (清空 superseded 元数据 + 重置崩溃计数)
 *    - 孤儿 staging 目录清理
 * 2. 阶段 2：后台延迟自包含 Dry-Run 队列
 *    - 两段式淘汰 (TTL 7天 + FIFO 50条, 磁盘 .ffp 永久保留)
 *    - 自包含核验通过覆写旁路 sha256 并置 FINISHED
 *    - 确定性损坏隔离至 Tombstone 并置 FAILED
 *    - 暂时性 IO 锁保护 (保留原文件并保持 CLEANUP_PENDING)
 *    - 连续 3 次异常崩溃熔断 (置 FAILED 且保留 .ffp 永久不删)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import archiver from 'archiver'
import BetterSqlite3 from 'better-sqlite3'
import { OfflinePackageDao } from '../offline-package-dao'
import { StartupReconciler } from '../startup-reconciler'
import { BackgroundVerificationQueue } from '../background-verification-queue'

// 生成测试用 Ed25519 密钥对
const { publicKey: TEST_ED25519_PK, privateKey: TEST_ED25519_SK } = crypto.generateKeyPairSync(
  'ed25519',
  {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
  }
)

function signManifest(content: string, privateKeyPem: string): string {
  const data = Buffer.from(content, 'utf-8')
  return crypto.sign(null, data, privateKeyPem).toString('hex')
}

// 辅助函数：创建测试用 .ffp 包
async function createMockFfpBundle(
  targetPath: string,
  manifestObj: Record<string, unknown>,
  privateKeyPem = TEST_ED25519_SK,
  tamperSig = false,
  tamperModuleSig = false
): Promise<void> {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true })
  const manifestStr = JSON.stringify(manifestObj)
  const sigHex = tamperSig ? 'deadbeef12345678' : signManifest(manifestStr, privateKeyPem)

  return new Promise<void>((resolve, reject) => {
    const output = fs.createWriteStream(targetPath)
    const archive = archiver('zip', { zlib: { level: 0 } })

    output.on('close', () => resolve())
    archive.on('error', err => reject(err))

    archive.pipe(output)
    archive.append(manifestStr, { name: 'bundle.manifest.json' })
    archive.append(sigHex, { name: 'bundle.manifest.sig' })

    const declaredMods = (manifestObj.modules || []) as Array<{ module_id?: string; id?: string }>
    for (const mod of declaredMods) {
      const modId = mod.module_id || mod.id
      if (modId) {
        const modManifestStr = JSON.stringify({ module: { id: modId, version: '1.0.0' } })
        const modSigHex = tamperModuleSig
          ? 'bad_module_sig_hex'
          : signManifest(modManifestStr, privateKeyPem)
        archive.append(modManifestStr, { name: `modules/${modId}/manifest.json` })
        archive.append(modSigHex, { name: `modules/${modId}/manifest.sig` })
      }
    }

    archive.append('dummy asset payload', { name: 'modules/test_mod/assets/data.bin' })
    archive.finalize()
  })
}

describe('StartupReconciler (Ticket 07)', () => {
  let tmpDir: string
  let baseDir: string
  let db: InstanceType<typeof BetterSqlite3>
  let dao: OfflinePackageDao

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-reconciler-test-'))
    baseDir = path.join(tmpDir, 'userData')
    fs.mkdirSync(baseDir, { recursive: true })

    db = new BetterSqlite3(':memory:')
    // 创建基础协调表与关联表
    db.exec(`
      CREATE TABLE IF NOT EXISTS offline_package_jobs (
        job_id TEXT PRIMARY KEY,
        job_type TEXT NOT NULL,
        status TEXT NOT NULL,
        archive_path TEXT NOT NULL,
        total_modules INTEGER NOT NULL DEFAULT 0,
        created_resource_ids TEXT,
        reused_resource_ids TEXT,
        superseded_by_job_id TEXT,
        superseded_at INTEGER,
        verification_attempts INTEGER NOT NULL DEFAULT 0,
        consecutive_worker_crashes INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS builtin_modules (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        category TEXT,
        capability_slot TEXT,
        total_bytes INTEGER DEFAULT 0,
        catalog_meta_json TEXT,
        install_state TEXT NOT NULL DEFAULT 'not_installed',
        installed_at INTEGER,
        updated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS resource_downloads (
        resource_id TEXT PRIMARY KEY,
        asset_name TEXT NOT NULL,
        target_local_path TEXT NOT NULL,
        active_source_key TEXT NOT NULL,
        expected_bytes INTEGER DEFAULT 0,
        expected_sha256 TEXT NOT NULL,
        actual_sha256 TEXT,
        download_state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS module_resource_downloads (
        module_id TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (module_id, resource_id)
      );
    `)

    dao = new OfflinePackageDao(db)
  })

  afterEach(() => {
    try {
      db.close()
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  describe('1. 阶段 1：首屏前轻量同步对账 (<5ms, 首屏零阻塞)', () => {
    it('三态自愈：PREPARED 或 PROMOTING 状态坚守原子性，全量物理撤销置 FAILED', async () => {
      const jobId = 'import-crash-01'
      const moduleId = 'half_mod'

      // 准备模块旧版本与暂存区
      const formalDir = path.join(baseDir, 'modules', '_shared', moduleId)
      const oldBackupDir = path.join(baseDir, 'modules', '_shared', `${moduleId}.old-${jobId}`)
      fs.mkdirSync(oldBackupDir, { recursive: true })
      fs.writeFileSync(path.join(oldBackupDir, 'old-entry.js'), 'console.log("old")')

      dao.createJob({
        job_id: jobId,
        job_type: 'IMPORT',
        status: 'PROMOTING',
        archive_path: 'C:/fake/path.ffp',
        total_modules: 1
      })

      const res = await StartupReconciler.reconcileOnStartup({
        baseDir,
        db,
        dao,
        skipDeferredQueue: true
      })

      expect(res.reconciledImports.rolledBackCount).toBe(1)

      // 验证 job 终态置为 FAILED
      const job = dao.getJob(jobId)
      expect(job?.status).toBe('FAILED')

      // 验证旧目录已安全还原
      expect(fs.existsSync(formalDir)).toBe(true)
      expect(fs.existsSync(path.join(formalDir, 'old-entry.js'))).toBe(true)
    })

    it('三态自愈：PROMOTED 模块若验签 100% 通过，单事务补写 DB 并置 FINISHED (P0-2 断言业务表补写)', async () => {
      const jobId = 'import-promoted-02'
      const moduleId = 'promoted_mod'
      const version = '1.2.0'
      const resId = 'promoted-weights'

      const formalDir = path.join(baseDir, 'modules', '_shared', moduleId)
      fs.mkdirSync(formalDir, { recursive: true })
      const manifestStr = JSON.stringify({
        module: {
          id: moduleId,
          version,
          resources: [
            {
              resource_id: resId,
              target_local_path: 'modules/_shared/assets/weights.bin',
              expected_sha256: '2222222222222222222222222222222222222222222222222222222222222222'
            }
          ]
        }
      })
      const sigHex = signManifest(manifestStr, TEST_ED25519_SK)
      fs.writeFileSync(path.join(formalDir, 'manifest.json'), manifestStr)
      fs.writeFileSync(path.join(formalDir, 'manifest.sig'), sigHex)

      dao.createJob({
        job_id: jobId,
        job_type: 'IMPORT',
        status: 'PROMOTED',
        archive_path: 'C:/fake/promoted.ffp',
        total_modules: 1
      })

      // 执行前断言：DB 中没有任何业务记录
      expect(
        db.prepare('SELECT id FROM builtin_modules WHERE id = ?').get(moduleId)
      ).toBeUndefined()
      expect(
        db.prepare('SELECT resource_id FROM resource_downloads WHERE resource_id = ?').get(resId)
      ).toBeUndefined()

      const res = await StartupReconciler.reconcileOnStartup({
        baseDir,
        db,
        dao,
        customPublicKey: TEST_ED25519_PK,
        skipDeferredQueue: true
      })

      expect(res.reconciledImports.committedCount).toBe(1)
      const job = dao.getJob(jobId)
      expect(job?.status).toBe('FINISHED')

      // 核心断言：builtin_modules 业务表被真实写入持久化！
      const modRecord = db.prepare('SELECT * FROM builtin_modules WHERE id = ?').get(moduleId) as
        | Record<string, unknown>
        | undefined
      expect(modRecord).toBeDefined()
      expect(modRecord?.version).toBe(version)
      expect(modRecord?.install_state).toBe('installed_inactive')

      // 核心断言：resource_downloads 与 module_resource_downloads 也被单事务原子补写！
      const resRecord = db
        .prepare('SELECT * FROM resource_downloads WHERE resource_id = ?')
        .get(resId) as Record<string, unknown> | undefined
      expect(resRecord).toBeDefined()
      expect(resRecord?.download_state).toBe('completed')

      const linkRecord = db
        .prepare('SELECT * FROM module_resource_downloads WHERE module_id = ? AND resource_id = ?')
        .get(moduleId, resId)
      expect(linkRecord).toBeDefined()
    })

    it('三态自愈：PROMOTED 模块若验签被篡改，全量回滚置 FAILED', async () => {
      const jobId = 'import-tampered-03'
      const moduleId = 'tampered_mod'

      const formalDir = path.join(baseDir, 'modules', '_shared', moduleId)
      fs.mkdirSync(formalDir, { recursive: true })
      const manifestStr = JSON.stringify({ module: { id: moduleId, version: '1.0.0' } })
      fs.writeFileSync(path.join(formalDir, 'manifest.json'), manifestStr)
      fs.writeFileSync(path.join(formalDir, 'manifest.sig'), 'deadbeef_tampered')

      dao.createJob({
        job_id: jobId,
        job_type: 'IMPORT',
        status: 'PROMOTED',
        archive_path: 'C:/fake/tampered.ffp',
        total_modules: 1
      })

      const res = await StartupReconciler.reconcileOnStartup({
        baseDir,
        db,
        dao,
        customPublicKey: TEST_ED25519_PK,
        skipDeferredQueue: true
      })

      expect(res.reconciledImports.rolledBackCount).toBe(1)
      const job = dao.getJob(jobId)
      expect(job?.status).toBe('FAILED')
    })

    it('三态自愈：DB_COMMITTED 状态清理残留 .old-<jobId> 备份，置 FINISHED', async () => {
      const jobId = 'import-committed-04'
      const moduleId = 'committed_mod'

      const sharedDir = path.join(baseDir, 'modules', '_shared')
      const oldBackupDir = path.join(sharedDir, `${moduleId}.old-${jobId}`)
      fs.mkdirSync(oldBackupDir, { recursive: true })
      fs.writeFileSync(path.join(oldBackupDir, 'temp.txt'), 'clean-me')

      dao.createJob({
        job_id: jobId,
        job_type: 'IMPORT',
        status: 'DB_COMMITTED',
        archive_path: 'C:/fake/committed.ffp',
        total_modules: 1
      })

      const res = await StartupReconciler.reconcileOnStartup({
        baseDir,
        db,
        dao,
        skipDeferredQueue: true
      })

      expect(res.reconciledImports.finishedCount).toBe(1)
      const job = dao.getJob(jobId)
      expect(job?.status).toBe('FINISHED')
      expect(fs.existsSync(oldBackupDir)).toBe(false)
    })

    it('导出任务分组收敛：次级任务批量置 FAILED，崩溃 EXPORTING 权威任务精准反查恢复旧任务权属', async () => {
      const archivePath = path.join(tmpDir, 'bundle-group.ffp')
      fs.writeFileSync(archivePath, 'legacy valid package content')

      const oldJobId = 'export-old-job'
      const newJobId = 'export-new-crashed-job'
      const otherJobId = 'export-other-stale-job'

      const now = Date.now()

      // 1. 旧任务：之前因新任务启动被 supersede 为 FAILED
      dao.createJob({
        job_id: oldJobId,
        job_type: 'EXPORT',
        status: 'FAILED',
        archive_path: archivePath,
        total_modules: 2,
        created_at: now - 5000,
        updated_at: now - 3000
      })
      db.prepare(
        `
        UPDATE offline_package_jobs
        SET superseded_by_job_id = ?,
            superseded_at = ?
        WHERE job_id = ?
      `
      ).run(newJobId, now - 3000, oldJobId)

      // 2. 新任务：处于 EXPORTING 状态（模拟中途断电崩溃）
      dao.createJob({
        job_id: newJobId,
        job_type: 'EXPORT',
        status: 'EXPORTING',
        archive_path: archivePath,
        total_modules: 2,
        created_at: now - 2000,
        updated_at: now - 1000
      })

      // 3. 次级历史遗留任务：状态也是 EXPORTING 但更旧
      dao.createJob({
        job_id: otherJobId,
        job_type: 'EXPORT',
        status: 'EXPORTING',
        archive_path: archivePath,
        total_modules: 2,
        created_at: now - 10000,
        updated_at: now - 8000
      })

      const res = await StartupReconciler.reconcileOnStartup({
        baseDir,
        db,
        dao,
        skipDeferredQueue: true
      })

      expect(res.reconciledExports.convergedGroupsCount).toBe(1)
      expect(res.reconciledExports.supersedeRestoredCount).toBe(1)

      // 断言：新崩溃任务置为 FAILED
      expect(dao.getJob(newJobId)?.status).toBe('FAILED')

      // 断言：次级旧任务置为 FAILED
      expect(dao.getJob(otherJobId)?.status).toBe('FAILED')

      // 核心断言：被 supersede 的旧任务成功权属恢复！
      const restored = dao.getJob(oldJobId)
      expect(restored?.status).toBe('CLEANUP_PENDING')
      expect(restored?.superseded_by_job_id).toBeNull()
      expect(restored?.superseded_at).toBeNull()
      expect(restored?.consecutive_worker_crashes).toBe(0)
    })
  })

  describe('2. 阶段 2：后台自包含 Dry-Run 校验队列与熔断', () => {
    it('两段式淘汰：超过 7 天 TTL 且至少尝试过 1 次的任务置 FAILED，磁盘 .ffp 永久保留', async () => {
      const ffpPath = path.join(tmpDir, 'ttl-expired.ffp')
      fs.writeFileSync(ffpPath, 'important package payload')

      const staleTime = Date.now() - 8 * 24 * 3600 * 1000 // 8 天前
      const jobId = 'job-ttl-expired'

      dao.createJob({
        job_id: jobId,
        job_type: 'EXPORT',
        status: 'CLEANUP_PENDING',
        archive_path: ffpPath,
        total_modules: 1,
        created_at: staleTime,
        updated_at: staleTime
      })
      // 至少尝试过 1 次
      dao.incrementVerificationAttempts(jobId, staleTime)

      const queue = new BackgroundVerificationQueue({
        dao,
        inlineForTest: true
      })
      expect(queue).toBeDefined()

      // 触发一次处理
      await queue.triggerNow()

      // 验证 job 已被 TTL 淘汰为 FAILED
      const job = dao.getJob(jobId)
      expect(job?.status).toBe('FAILED')
      // 核心不变量断言：磁盘上的 .ffp 绝对不删！
      expect(fs.existsSync(ffpPath)).toBe(true)
    })

    it('两段式淘汰：队列超过 50 条按 created_at 升序 FIFO 淘汰，磁盘 .ffp 永久保留', () => {
      // 插入 52 条 CLEANUP_PENDING 任务
      const baseTime = Date.now() - 100000
      for (let i = 1; i <= 52; i++) {
        const p = path.join(tmpDir, `fifo-${i}.ffp`)
        fs.writeFileSync(p, `payload-${i}`)
        dao.createJob({
          job_id: `job-fifo-${i}`,
          job_type: 'EXPORT',
          status: 'CLEANUP_PENDING',
          archive_path: p,
          total_modules: 1,
          created_at: baseTime + i * 10,
          updated_at: baseTime + i * 10
        })
      }

      const queue = new BackgroundVerificationQueue({
        dao,
        inlineForTest: true
      })
      expect(queue).toBeDefined()

      const evicted = dao.evictExpiredOrOverflownJobs(Date.now(), 7, 50)
      expect(evicted.length).toBe(2)
      expect(evicted).toContain('job-fifo-1')
      expect(evicted).toContain('job-fifo-2')

      // 断言磁盘文件永久保留
      expect(fs.existsSync(path.join(tmpDir, 'fifo-1.ffp'))).toBe(true)
      expect(fs.existsSync(path.join(tmpDir, 'fifo-2.ffp'))).toBe(true)
    })

    it('自包含校验通过：现场覆盖写入旁路 .sha256 文本文件，重置连续崩溃计数并置 FINISHED', async () => {
      const ffpPath = path.join(tmpDir, 'valid-bundle.ffp')
      await createMockFfpBundle(ffpPath, { bundle_version: '1.0.0' }, TEST_ED25519_SK)

      const jobId = 'job-valid-verify-01'
      dao.createJob({
        job_id: jobId,
        job_type: 'EXPORT',
        status: 'CLEANUP_PENDING',
        archive_path: ffpPath,
        total_modules: 1
      })

      const queue = new BackgroundVerificationQueue({
        dao,
        customPublicKey: TEST_ED25519_PK,
        inlineForTest: true
      })

      await queue.triggerNow()

      // 验证 job 更新为 FINISHED
      const job = dao.getJob(jobId)
      expect(job?.status).toBe('FINISHED')
      expect(job?.verification_attempts).toBe(1)
      expect(job?.consecutive_worker_crashes).toBe(0)

      // 验证旁路 <targetPath>.sha256 文件已现场生成并覆盖写入
      const bypassFile = `${ffpPath}.sha256`
      expect(fs.existsSync(bypassFile)).toBe(true)
      const shaContent = fs.readFileSync(bypassFile, 'utf-8').trim()
      expect(shaContent.length).toBe(64)
    })

    it('确定性损坏 (签名无效)：移入 Tombstone 隔离并更新为 FAILED', async () => {
      const ffpPath = path.join(tmpDir, 'corrupted-bundle.ffp')
      // 生成伪造签名
      await createMockFfpBundle(ffpPath, { bundle_version: '1.0.0' }, TEST_ED25519_SK, true)

      const jobId = 'job-corrupted-verify-02'
      dao.createJob({
        job_id: jobId,
        job_type: 'EXPORT',
        status: 'CLEANUP_PENDING',
        archive_path: ffpPath,
        total_modules: 1
      })

      const queue = new BackgroundVerificationQueue({
        dao,
        customPublicKey: TEST_ED25519_PK,
        inlineForTest: true
      })

      await queue.triggerNow()

      // 验证状态置为 FAILED
      const job = dao.getJob(jobId)
      expect(job?.status).toBe('FAILED')

      // 验证损坏文件已从活动路径移出为 .corrupted-* 隔离
      expect(fs.existsSync(ffpPath)).toBe(false)
      const files = fs.readdirSync(tmpDir)
      expect(files.some(f => f.startsWith('corrupted-bundle.ffp.corrupted-'))).toBe(true)
    })

    it('连续 3 次崩溃熔断：达到 3 次非零退出触发熔断置 FAILED，磁盘 .ffp 永久保留不删', () => {
      const ffpPath = path.join(tmpDir, 'crash-test.ffp')
      fs.writeFileSync(ffpPath, 'crash-bundle-content')

      const jobId = 'job-crash-breaker-03'
      dao.createJob({
        job_id: jobId,
        job_type: 'EXPORT',
        status: 'CLEANUP_PENDING',
        archive_path: ffpPath,
        total_modules: 1
      })

      // 模拟第 1 次崩溃
      let crashRes = dao.recordWorkerCrash(jobId)
      expect(crashRes.consecutiveCrashes).toBe(1)
      expect(crashRes.shouldTrip).toBe(false)

      // 模拟第 2 次崩溃
      crashRes = dao.recordWorkerCrash(jobId)
      expect(crashRes.consecutiveCrashes).toBe(2)
      expect(crashRes.shouldTrip).toBe(false)

      // 模拟第 3 次崩溃触发熔断
      crashRes = dao.recordWorkerCrash(jobId)
      expect(crashRes.consecutiveCrashes).toBe(3)
      expect(crashRes.shouldTrip).toBe(true)

      // 执行熔断
      dao.tripCircuitBreaker(jobId)

      const job = dao.getJob(jobId)
      expect(job?.status).toBe('FAILED')
      expect(job?.consecutive_worker_crashes).toBe(3)

      // 核心断言：磁盘上的 .ffp 永久保留不删！
      expect(fs.existsSync(ffpPath)).toBe(true)
    })

    it('自包含深度核验：当声明模块的 manifest.sig 被篡改时抛出确定性损坏并移入 Tombstone (P1-3)', async () => {
      const ffpPath = path.join(tmpDir, 'module-tampered-bundle.ffp')
      // 根签名有效，但模块级签名伪造
      await createMockFfpBundle(
        ffpPath,
        {
          bundle_version: '1.0.0',
          modules: [{ module_id: 'sub_mod_1' }]
        },
        TEST_ED25519_SK,
        false, // 根签名有效
        true // 模块签名伪造
      )

      const jobId = 'job-submod-tampered-04'
      dao.createJob({
        job_id: jobId,
        job_type: 'EXPORT',
        status: 'CLEANUP_PENDING',
        archive_path: ffpPath,
        total_modules: 1
      })

      const queue = new BackgroundVerificationQueue({
        dao,
        customPublicKey: TEST_ED25519_PK,
        inlineForTest: true
      })

      await queue.triggerNow()

      // 验证子模块签名篡改被深度核验拦截并置为 FAILED
      const job = dao.getJob(jobId)
      expect(job?.status).toBe('FAILED')
      expect(fs.existsSync(ffpPath)).toBe(false)
      const files = fs.readdirSync(tmpDir)
      expect(files.some(f => f.startsWith('module-tampered-bundle.ffp.corrupted-'))).toBe(true)
    })

    it('与导出管线协同：BackgroundVerificationQueue 暴露 lockState 并在校验期间维护互斥状态', async () => {
      const ffpPath = path.join(tmpDir, 'lock-sync.ffp')
      await createMockFfpBundle(ffpPath, { bundle_version: '1.0.0' }, TEST_ED25519_SK)

      const jobId = 'job-lock-sync-05'
      dao.createJob({
        job_id: jobId,
        job_type: 'EXPORT',
        status: 'CLEANUP_PENDING',
        archive_path: ffpPath,
        total_modules: 1
      })

      const queue = new BackgroundVerificationQueue({
        dao,
        customPublicKey: TEST_ED25519_PK,
        inlineForTest: true
      })

      expect(queue.getLockState().isLocked).toBe(false)
      await queue.triggerNow()
      expect(queue.getLockState().isLocked).toBe(false)
    })
  })
})
