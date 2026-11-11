/**
 * 单版本物理提升、两阶段事务与安全回滚单元测试 (Bundle Promoter Tests)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'
import DatabaseConstructor from 'better-sqlite3'
import type { Database } from 'better-sqlite3'
import { BundlePromoter, type IncomingModuleMeta } from '../bundle-promoter'
import { OfflinePackageDao } from '../offline-package-dao'
import { signManifest, TEST_ED25519_SK } from '../offline-package-service'

describe('BundlePromoter (Admission, Promotion & Rollback)', () => {
  let tempDir: string
  let baseDir: string
  let stagingDir: string
  let db: Database
  let dao: OfflinePackageDao

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-promoter-test-'))
    baseDir = path.join(tempDir, 'userData')
    stagingDir = path.join(baseDir, 'modules', '_staging', 'job-test-01')

    fs.mkdirSync(path.join(baseDir, 'modules', '_shared'), { recursive: true })
    fs.mkdirSync(stagingDir, { recursive: true })

    // 创建测试 SQLite 内存库并初始化创世表结构
    db = new DatabaseConstructor(':memory:')
    db.exec(`
      CREATE TABLE IF NOT EXISTS offline_package_jobs (
        job_id                TEXT PRIMARY KEY,
        job_type              TEXT NOT NULL CHECK (job_type IN ('IMPORT', 'EXPORT')),
        status                TEXT NOT NULL CHECK (status IN ('PREPARED', 'PROMOTING', 'PROMOTED', 'DB_COMMITTED', 'EXPORTING', 'CLEANUP_PENDING', 'FINISHED', 'FAILED', 'RECOVERY_REQUIRED')),
        archive_path          TEXT NOT NULL,
        total_modules         INTEGER NOT NULL,
        created_resource_ids  TEXT NOT NULL DEFAULT '[]',
        reused_resource_ids   TEXT NOT NULL DEFAULT '[]',
        superseded_by_job_id  TEXT,
        superseded_at         INTEGER,
        verification_attempts      INTEGER NOT NULL DEFAULT 0,
        consecutive_worker_crashes INTEGER NOT NULL DEFAULT 0,
        created_at            INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS builtin_modules (
        id                TEXT PRIMARY KEY,
        version           TEXT NOT NULL,
        category          TEXT NOT NULL DEFAULT 'tool',
        capability_slot   TEXT NOT NULL DEFAULT 'general',
        total_bytes       INTEGER NOT NULL DEFAULT 0,
        catalog_meta_json TEXT,
        install_state     TEXT NOT NULL DEFAULT 'not_installed',
        installed_at      INTEGER
      );

      CREATE TABLE IF NOT EXISTS resource_downloads (
        resource_id       TEXT PRIMARY KEY,
        asset_name        TEXT NOT NULL,
        target_local_path TEXT NOT NULL,
        active_source_key TEXT NOT NULL DEFAULT 'auto',
        expected_bytes    INTEGER NOT NULL DEFAULT 0,
        expected_sha256   TEXT NOT NULL,
        actual_sha256     TEXT,
        download_state    TEXT NOT NULL DEFAULT 'pending',
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS module_resource_downloads (
        module_id         TEXT NOT NULL,
        resource_id       TEXT NOT NULL,
        created_at        INTEGER NOT NULL,
        PRIMARY KEY (module_id, resource_id)
      );
    `)

    dao = new OfflinePackageDao(db)
  })

  afterEach(() => {
    try {
      db.close()
    } catch {
      // 忽略关闭异常
    }
    try {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true })
      }
    } catch {
      // 忽略清理异常
    }
  })

  function sha256(data: string | Buffer): string {
    return crypto.createHash('sha256').update(data).digest('hex').toLowerCase()
  }

  describe('1. 准入规则严格优先级判定算法 (Admission Priority)', () => {
    it('规则 1 (最高优先级)：版本与清单哈希一致时，裁决为 SKIPPED_SAME 并放行自愈', () => {
      const moduleId = 'asr_engine'
      const version = '1.2.0'
      const manifestJson = JSON.stringify({ module: { id: moduleId, version } })
      const formalDir = path.join(baseDir, 'modules', '_shared', moduleId)
      fs.mkdirSync(formalDir, { recursive: true })
      fs.writeFileSync(path.join(formalDir, 'manifest.json'), manifestJson, 'utf-8')

      // 在 DB 中记录为 error 状态
      db.prepare(
        `
        INSERT INTO builtin_modules (id, version, install_state)
        VALUES (?, ?, 'error')
      `
      ).run(moduleId, version)

      const decision = BundlePromoter.evaluateAdmission(
        {
          moduleId,
          version,
          manifestRawBytes: Buffer.from(manifestJson, 'utf-8'),
          resources: []
        },
        baseDir,
        db
      )

      expect(decision.decision).toBe('SKIPPED_SAME')
      expect(decision.moduleId).toBe(moduleId)
    })

    it('规则 2：同版本异哈希硬冲突拦截 (VERSION_CONFLICT) 优先于 active 状态判定', () => {
      const moduleId = 'vision_model'
      const version = '2.0.0'
      const existingManifest = JSON.stringify({
        module: { id: moduleId, version, build: 'official-a' }
      })
      const incomingManifest = JSON.stringify({
        module: { id: moduleId, version, build: 'unofficial-b' }
      })

      const formalDir = path.join(baseDir, 'modules', '_shared', moduleId)
      fs.mkdirSync(formalDir, { recursive: true })
      fs.writeFileSync(path.join(formalDir, 'manifest.json'), existingManifest, 'utf-8')

      // 现有模块处于 active 运行态
      db.prepare(
        `
        INSERT INTO builtin_modules (id, version, install_state)
        VALUES (?, ?, 'active')
      `
      ).run(moduleId, version)

      // 坚决抛出 VERSION_CONFLICT 而非 MODULE_ACTIVE_CONFLICT，消除二段式报错
      expect(() =>
        BundlePromoter.evaluateAdmission(
          {
            moduleId,
            version,
            manifestRawBytes: Buffer.from(incomingManifest, 'utf-8'),
            resources: []
          },
          baseDir,
          db
        )
      ).toThrowError(
        expect.objectContaining({
          code: 'VERSION_CONFLICT'
        })
      )
    })

    it('规则 3：版本不同且处于 active 状态时，抛出 MODULE_ACTIVE_CONFLICT 保护活跃实例', () => {
      const moduleId = 'tts_engine'
      const existingVersion = '1.0.0'
      const incomingVersion = '1.1.0'

      const formalDir = path.join(baseDir, 'modules', '_shared', moduleId)
      fs.mkdirSync(formalDir, { recursive: true })
      fs.writeFileSync(
        path.join(formalDir, 'manifest.json'),
        JSON.stringify({ module: { id: moduleId, version: existingVersion } }),
        'utf-8'
      )

      db.prepare(
        `
        INSERT INTO builtin_modules (id, version, install_state)
        VALUES (?, ?, 'active')
      `
      ).run(moduleId, existingVersion)

      expect(() =>
        BundlePromoter.evaluateAdmission(
          {
            moduleId,
            version: incomingVersion,
            manifestRawBytes: JSON.stringify({
              module: { id: moduleId, version: incomingVersion }
            }),
            resources: []
          },
          baseDir,
          db
        )
      ).toThrowError(
        expect.objectContaining({
          code: 'MODULE_ACTIVE_CONFLICT'
        })
      )
    })

    it('规则 4：降级拦截，现有版本高于传入版本且处于非 active 时抛出 DOWNGRADE_REJECTED', () => {
      const moduleId = 'ocr_parser'
      const existingVersion = '2.1.0'
      const incomingVersion = '1.9.0'

      const formalDir = path.join(baseDir, 'modules', '_shared', moduleId)
      fs.mkdirSync(formalDir, { recursive: true })
      fs.writeFileSync(
        path.join(formalDir, 'manifest.json'),
        JSON.stringify({ module: { id: moduleId, version: existingVersion } }),
        'utf-8'
      )

      db.prepare(
        `
        INSERT INTO builtin_modules (id, version, install_state)
        VALUES (?, ?, 'installed_inactive')
      `
      ).run(moduleId, existingVersion)

      expect(() =>
        BundlePromoter.evaluateAdmission(
          {
            moduleId,
            version: incomingVersion,
            manifestRawBytes: JSON.stringify({
              module: { id: moduleId, version: incomingVersion }
            }),
            resources: []
          },
          baseDir,
          db
        )
      ).toThrowError(
        expect.objectContaining({
          code: 'DOWNGRADE_REJECTED'
        })
      )
    })

    it('规则 5：正常升级或新模块导入放行 (PROCEED)', () => {
      const moduleId = 'new_plugin'
      const incomingVersion = '1.0.0'

      const decision = BundlePromoter.evaluateAdmission(
        {
          moduleId,
          version: incomingVersion,
          manifestRawBytes: JSON.stringify({ module: { id: moduleId, version: incomingVersion } }),
          resources: []
        },
        baseDir,
        db
      )

      expect(decision.decision).toBe('PROCEED')
    })
  })

  describe('2. Phase 1 物理提升与 Phase 2 事务提交', () => {
    it('成功执行原子目录替换与单事务入库，并在完成后异步清理 .old 备份', async () => {
      const jobId = 'job-promo-01'
      const moduleId = 'calc_plugin'
      const version = '1.0.0'

      // 登记 job
      dao.createJob({
        job_id: jobId,
        job_type: 'IMPORT',
        status: 'PREPARED',
        archive_path: 'C:/packages/bundle.ffp',
        total_modules: 1
      })

      // 准备暂存区模块目录
      const stagedModDir = path.join(stagingDir, moduleId)
      fs.mkdirSync(stagedModDir, { recursive: true })
      fs.writeFileSync(path.join(stagedModDir, 'manifest.json'), JSON.stringify({ version }))
      fs.writeFileSync(path.join(stagedModDir, 'entry.js'), 'console.log("calc")')

      // 准备暂存区共享资产
      const assetRelPath = 'modules/_shared/calc-weights/weights.bin'
      const stagedAssetPath = path.resolve(stagingDir, assetRelPath)
      fs.mkdirSync(path.dirname(stagedAssetPath), { recursive: true })
      fs.writeFileSync(stagedAssetPath, 'binary-weights-data')

      const incomingModule: IncomingModuleMeta = {
        moduleId,
        version,
        manifestRawBytes: JSON.stringify({ version }),
        resources: [
          {
            resource_id: 'calc-weights',
            asset_name: 'weights.bin',
            target_local_path: assetRelPath,
            expected_sha256: sha256('binary-weights-data')
          }
        ]
      }

      const res = await BundlePromoter.executePromotion({
        jobId,
        stagingDir,
        baseDir,
        incomingModules: [incomingModule],
        dao,
        db
      })

      expect(res.ok).toBe(true)
      expect(res.promotedModuleIds).toEqual([moduleId])
      expect(res.createdResourceIds).toEqual(['calc-weights'])

      // 验证正式模块目录已就位
      const formalModDir = path.join(baseDir, 'modules', '_shared', moduleId)
      expect(fs.existsSync(formalModDir)).toBe(true)
      expect(fs.readFileSync(path.join(formalModDir, 'entry.js'), 'utf-8')).toBe(
        'console.log("calc")'
      )

      // 验证共享资产已就位
      const formalAssetPath = path.resolve(baseDir, assetRelPath)
      expect(fs.existsSync(formalAssetPath)).toBe(true)

      // 验证数据库已事务持久化
      const modRecord = db.prepare('SELECT * FROM builtin_modules WHERE id = ?').get(moduleId) as
        | Record<string, unknown>
        | undefined
      expect(modRecord).toBeDefined()
      expect(modRecord?.version).toBe('1.0.0')
      expect(modRecord?.install_state).toBe('installed_inactive')

      const resRecord = db
        .prepare('SELECT * FROM resource_downloads WHERE resource_id = ?')
        .get('calc-weights') as Record<string, unknown> | undefined
      expect(resRecord).toBeDefined()
      expect(resRecord?.download_state).toBe('completed')

      // 验证协调表终态
      const jobRecord = dao.getJob(jobId)
      expect(jobRecord?.status).toBe('DB_COMMITTED')
    })

    it('对 SKIPPED_SAME 模块执行 DB 状态自愈 (error -> installed_inactive)', async () => {
      const jobId = 'job-promo-02'
      const moduleId = 'healed_mod'
      const version = '1.0.0'
      const manifestStr = JSON.stringify({ module: { id: moduleId, version } })

      dao.createJob({
        job_id: jobId,
        job_type: 'IMPORT',
        status: 'PREPARED',
        archive_path: 'C:/packages/bundle.ffp',
        total_modules: 1
      })

      // 正式目录完全完备
      const formalDir = path.join(baseDir, 'modules', '_shared', moduleId)
      fs.mkdirSync(formalDir, { recursive: true })
      fs.writeFileSync(path.join(formalDir, 'manifest.json'), manifestStr, 'utf-8')

      // DB 中为 error 状态
      db.prepare(
        `
        INSERT INTO builtin_modules (id, version, install_state)
        VALUES (?, ?, 'error')
      `
      ).run(moduleId, version)

      const res = await BundlePromoter.executePromotion({
        jobId,
        stagingDir,
        baseDir,
        incomingModules: [
          {
            moduleId,
            version,
            manifestRawBytes: manifestStr,
            resources: []
          }
        ],
        dao,
        db
      })

      expect(res.skippedModuleIds).toEqual([moduleId])

      // 验证 DB 状态自愈为 installed_inactive
      const modRecord = db
        .prepare('SELECT install_state FROM builtin_modules WHERE id = ?')
        .get(moduleId) as Record<string, unknown> | undefined
      expect(modRecord?.install_state).toBe('installed_inactive')
    })

    it('当 SKIPPED_SAME 且本地 DB 记录完全缺失时，自愈重建 DB 记录与资产绑定 (P0-2)', async () => {
      const jobId = 'job-skipped-db-heal-02'
      const moduleId = 'heal_db_mod'
      const version = '1.0.0'
      const resId = 'heal-res-01'

      dao.createJob({
        job_id: jobId,
        job_type: 'IMPORT',
        status: 'PREPARED',
        archive_path: 'C:/packages/bundle.ffp',
        total_modules: 1
      })

      // 物理正式目录完备，哈希匹配
      const formalDir = path.join(baseDir, 'modules', '_shared', moduleId)
      fs.mkdirSync(formalDir, { recursive: true })
      fs.writeFileSync(path.join(formalDir, 'entry.js'), 'console.log("heal")')
      const manifestBytes = JSON.stringify({ version, entry: 'entry.js' })
      fs.writeFileSync(path.join(formalDir, 'manifest.json'), manifestBytes)

      // 共享资产在磁盘上也已存在
      const assetRelPath = 'modules/_shared/assets/heal-asset.bin'
      const formalAssetPath = path.resolve(baseDir, assetRelPath)
      fs.mkdirSync(path.dirname(formalAssetPath), { recursive: true })
      fs.writeFileSync(formalAssetPath, 'asset-bytes')
      const assetSha = crypto.createHash('sha256').update('asset-bytes').digest('hex')

      // 关键前提：DB 中完全没有该模块与资产记录！
      expect(
        db.prepare('SELECT id FROM builtin_modules WHERE id = ?').get(moduleId)
      ).toBeUndefined()
      expect(
        db.prepare('SELECT resource_id FROM resource_downloads WHERE resource_id = ?').get(resId)
      ).toBeUndefined()

      const res = await BundlePromoter.executePromotion({
        jobId,
        stagingDir,
        baseDir,
        incomingModules: [
          {
            moduleId,
            version,
            manifestRawBytes: manifestBytes,
            resources: [
              {
                resource_id: resId,
                asset_name: 'heal-asset.bin',
                target_local_path: assetRelPath,
                expected_sha256: assetSha
              }
            ]
          }
        ],
        dao,
        db
      })

      expect(res.skippedModuleIds).toEqual([moduleId])

      // 验证 DB 记录被全新插入重建，且状态为 installed_inactive
      const modRecord = db.prepare('SELECT * FROM builtin_modules WHERE id = ?').get(moduleId) as
        | Record<string, unknown>
        | undefined
      expect(modRecord).toBeDefined()
      expect(modRecord?.version).toBe(version)
      expect(modRecord?.install_state).toBe('installed_inactive')

      // 验证 resource_downloads 与 module_resource_downloads 也成功自愈写入
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

    it('resource_downloads upsert 恪守防改写铁律：绝不改写已有的 expected_sha256 与 target_local_path (P0-3)', async () => {
      const jobId = 'job-res-immutable-03'
      const moduleId = 'res_immutable_mod'
      const resId = 'existing-shared-res'
      const originalPath = 'modules/_shared/existing/file.bin'
      const originalSha = '1111111111111111111111111111111111111111111111111111111111111111'

      // 事先在 DB 插入一条既有资产记录
      db.prepare(
        `
        INSERT INTO resource_downloads (
          resource_id, asset_name, target_local_path, active_source_key,
          expected_bytes, expected_sha256, actual_sha256, download_state, created_at, updated_at
        ) VALUES (?, 'file.bin', ?, 'auto', 100, ?, ?, 'completed', 1000, 1000)
      `
      ).run(resId, originalPath, originalSha, originalSha)

      dao.createJob({
        job_id: jobId,
        job_type: 'IMPORT',
        status: 'PREPARED',
        archive_path: 'C:/packages/bundle.ffp',
        total_modules: 1
      })

      const stagedModDir = path.join(stagingDir, moduleId)
      fs.mkdirSync(stagedModDir, { recursive: true })
      fs.writeFileSync(
        path.join(stagedModDir, 'manifest.json'),
        JSON.stringify({ version: '1.0.0' })
      )

      // 准备对应的物理文件以避免 hash 冲突检查
      const formalAssetPath = path.resolve(baseDir, originalPath)
      fs.mkdirSync(path.dirname(formalAssetPath), { recursive: true })
      fs.writeFileSync(formalAssetPath, 'existing-content')

      await BundlePromoter.executePromotion({
        jobId,
        stagingDir,
        baseDir,
        incomingModules: [
          {
            moduleId,
            version: '1.0.0',
            manifestRawBytes: JSON.stringify({ version: '1.0.0' }),
            resources: [
              {
                resource_id: resId,
                asset_name: 'new-name.bin',
                target_local_path: 'tampered/path/file.bin', // 故意传入不同路径
                expected_sha256: originalSha
              }
            ]
          }
        ],
        dao,
        db
      })

      // 核心断言：target_local_path 和 expected_sha256 绝对未被改写覆盖！
      const resRow = db
        .prepare(
          'SELECT target_local_path, expected_sha256 FROM resource_downloads WHERE resource_id = ?'
        )
        .get(resId) as Record<string, unknown> | undefined
      expect(resRow?.target_local_path).toBe(originalPath)
      expect(resRow?.expected_sha256).toBe(originalSha)
    })
  })

  describe('3. Windows 安全失败回滚 (先清后移防 EEXIST 铁律)', () => {
    it('当提升过程中途发生异常，先删除未完成的新目录，再原子恢复 .old 备份', async () => {
      const jobId = 'job-rollback-01'
      const moduleId = 'rollback_mod'
      const oldVersion = '1.0.0'
      const newVersion = '2.0.0'

      dao.createJob({
        job_id: jobId,
        job_type: 'IMPORT',
        status: 'PREPARED',
        archive_path: 'C:/packages/bundle.ffp',
        total_modules: 1
      })

      // 现有旧版本物理目录
      const formalDir = path.join(baseDir, 'modules', '_shared', moduleId)
      fs.mkdirSync(formalDir, { recursive: true })
      fs.writeFileSync(path.join(formalDir, 'old-file.txt'), 'old-content')
      fs.writeFileSync(
        path.join(formalDir, 'manifest.json'),
        JSON.stringify({ version: oldVersion })
      )

      // 准备暂存区新版本目录
      const stagedModDir = path.join(stagingDir, moduleId)
      fs.mkdirSync(stagedModDir, { recursive: true })
      fs.writeFileSync(path.join(stagedModDir, 'new-file.txt'), 'new-content')

      // 构造两个待提升模块：mod1 正常就位，mod2 故意损坏引发异常触发全量回滚
      const mod1: IncomingModuleMeta = {
        moduleId,
        version: newVersion,
        manifestRawBytes: JSON.stringify({ version: newVersion }),
        resources: []
      }

      const mod2: IncomingModuleMeta = {
        moduleId: 'broken_mod',
        version: '1.0.0',
        manifestRawBytes: JSON.stringify({ version: '1.0.0' }),
        resources: [
          {
            resource_id: 'non-existent-staged-res',
            asset_name: 'test.bin',
            target_local_path: 'modules/_shared/broken/test.bin'
          }
        ]
      }

      // 注意：broken_mod 在 stagingDir 下没有物理目录，在重命名提升时必然抛出 ENOENT
      await expect(
        BundlePromoter.executePromotion({
          jobId,
          stagingDir,
          baseDir,
          incomingModules: [mod1, mod2],
          dao,
          db
        })
      ).rejects.toThrow()

      // 核心断言：Windows 先清后移成功还原
      // 1. formalDir 必须恢复为原旧版本内容
      expect(fs.existsSync(formalDir)).toBe(true)
      expect(fs.existsSync(path.join(formalDir, 'old-file.txt'))).toBe(true)
      expect(fs.readFileSync(path.join(formalDir, 'old-file.txt'), 'utf-8')).toBe('old-content')

      // 2. 新版本未完成目录不存在
      expect(fs.existsSync(path.join(formalDir, 'new-file.txt'))).toBe(false)

      // 3. 协调表更新为 FAILED
      const job = dao.getJob(jobId)
      expect(job?.status).toBe('FAILED')
    })

    it('当重命名备份已完成但新正式目录尚未就位时发生异常，rollbackPromotion 仍能安全还原旧目录 (P0-1 防孤儿丢弃漏洞)', async () => {
      const jobId = 'job-orphan-rollback-02'
      const moduleId = 'orphan_mod'
      const oldBackupDir = path.join(baseDir, 'modules', '_shared', `${moduleId}.old-${jobId}`)
      const formalDir = path.join(baseDir, 'modules', '_shared', moduleId)

      dao.createJob({
        job_id: jobId,
        job_type: 'IMPORT',
        status: 'PROMOTING',
        archive_path: 'C:/packages/bundle.ffp',
        total_modules: 1
      })

      // 模拟事故现场：formalDir 已被重命名为 oldBackupDir，但新目录因异常未就位（formalDir 不存在）
      fs.mkdirSync(oldBackupDir, { recursive: true })
      fs.writeFileSync(path.join(oldBackupDir, 'legacy.txt'), 'legacy-payload')
      expect(fs.existsSync(formalDir)).toBe(false)
      expect(fs.existsSync(oldBackupDir)).toBe(true)

      const mod: IncomingModuleMeta = {
        moduleId,
        version: '2.0.0',
        manifestRawBytes: JSON.stringify({ version: '2.0.0' }),
        resources: []
      }

      // 执行回滚
      await BundlePromoter.rollbackPromotion({
        jobId,
        baseDir,
        modules: [mod],
        createdResourceIds: [],
        dao
      })

      // 断言：即使 formalDir 原本不存在，oldBackupDir 依然被 100% 成功还原为 formalDir！
      expect(fs.existsSync(formalDir)).toBe(true)
      expect(fs.existsSync(path.join(formalDir, 'legacy.txt'))).toBe(true)
      expect(fs.readFileSync(path.join(formalDir, 'legacy.txt'), 'utf-8')).toBe('legacy-payload')
      expect(fs.existsSync(oldBackupDir)).toBe(false)
    })
  })

  describe('4. 卸载物理保留与验签回滚自愈', () => {
    it('卸载插件时将其原子重命名为 .uninstalled-<timestamp> 并置为 not_installed', async () => {
      const moduleId = 'uninstall_mod'
      const formalDir = path.join(baseDir, 'modules', '_shared', moduleId)
      fs.mkdirSync(formalDir, { recursive: true })
      fs.writeFileSync(path.join(formalDir, 'manifest.json'), JSON.stringify({ version: '1.0.0' }))

      db.prepare(
        `
        INSERT INTO builtin_modules (id, version, install_state)
        VALUES (?, '1.0.0', 'active')
      `
      ).run(moduleId)

      const result = await BundlePromoter.uninstallWithRetention(moduleId, baseDir, db)
      expect(result.ok).toBe(true)
      expect(fs.existsSync(formalDir)).toBe(false)
      expect(fs.existsSync(result.retentionDir)).toBe(true)

      const record = db
        .prepare('SELECT install_state FROM builtin_modules WHERE id = ?')
        .get(moduleId) as Record<string, unknown> | undefined
      expect(record?.install_state).toBe('not_installed')
    })

    it('从合法官方签名的 .uninstalled-* 目录中安全自愈恢复', async () => {
      const moduleId = 'restored_mod'
      const version = '1.5.0'
      const manifestStr = JSON.stringify({
        module: {
          id: moduleId,
          version,
          resources: [{ resource_id: 'restored-res-1' }]
        }
      })
      const sigHex = signManifest(manifestStr, TEST_ED25519_SK)

      const timestamp = Date.now() - 1000
      const backupDir = path.join(
        baseDir,
        'modules',
        '_shared',
        `${moduleId}.uninstalled-${timestamp}`
      )
      fs.mkdirSync(backupDir, { recursive: true })
      fs.writeFileSync(path.join(backupDir, 'manifest.json'), manifestStr, 'utf-8')
      fs.writeFileSync(path.join(backupDir, 'manifest.sig'), sigHex, 'utf-8')

      db.prepare(
        `
        INSERT INTO builtin_modules (id, version, install_state)
        VALUES (?, '0.9.0', 'not_installed')
      `
      ).run(moduleId)

      const res = await BundlePromoter.rollbackFromRetention(moduleId, baseDir, db)
      expect(res.ok).toBe(true)
      expect(res.restoredVersion).toBe(version)

      const formalDir = path.join(baseDir, 'modules', '_shared', moduleId)
      expect(fs.existsSync(formalDir)).toBe(true)

      const record = db
        .prepare('SELECT version, install_state FROM builtin_modules WHERE id = ?')
        .get(moduleId) as Record<string, unknown> | undefined
      expect(record?.version).toBe(version)
      expect(record?.install_state).toBe('installed_inactive')

      // 验证资源绑定关系同步恢复
      const linkRecord = db
        .prepare('SELECT * FROM module_resource_downloads WHERE module_id = ? AND resource_id = ?')
        .get(moduleId, 'restored-res-1')
      expect(linkRecord).toBeDefined()
    })

    it('若备份目录签名被篡改，严禁自愈恢复并抛出 RECOVERY_REQUIRED', async () => {
      const moduleId = 'tampered_mod'
      const version = '1.0.0'
      const manifestStr = JSON.stringify({ module: { id: moduleId, version } })

      const timestamp = Date.now()
      const backupDir = path.join(
        baseDir,
        'modules',
        '_shared',
        `${moduleId}.uninstalled-${timestamp}`
      )
      fs.mkdirSync(backupDir, { recursive: true })
      fs.writeFileSync(path.join(backupDir, 'manifest.json'), manifestStr, 'utf-8')
      fs.writeFileSync(path.join(backupDir, 'manifest.sig'), 'deadbeef1234', 'utf-8') // 伪造签名

      await expect(
        BundlePromoter.rollbackFromRetention(moduleId, baseDir, db)
      ).rejects.toThrowError(
        expect.objectContaining({
          code: 'RECOVERY_REQUIRED'
        })
      )
    })
  })
})
