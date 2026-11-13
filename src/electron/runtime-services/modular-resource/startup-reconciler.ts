/**
 * 应用冷启动两阶段对账与后台自包含 Dry-Run 校验器 (Startup Reconciler)
 *
 * 核心设计与不变量 (System Invariants):
 * 1. 阶段 1：首屏前轻量同步执行 (<5ms, 首屏零阻塞):
 *    - 导入任务三态 ARIES 确定性自愈:
 *      * PREPARED / PROMOTING: 公理“未到终局皆为废品”，坚守原子性，全量物理撤销置 FAILED；
 *      * PROMOTED: 100% 模块逐一验签核验，全量通过时单事务补写 DB 并置 FINISHED，任一损坏全量回滚置 FAILED；
 *      * DB_COMMITTED: 正式版本已生效，清理 .old-<jobId> 残留备份，置 FINISHED；
 *    - 导出任务同路径分组收敛与权属恢复:
 *      * 分组推选唯一权威 job (CLEANUP_PENDING > EXPORTING, 最新 updated_at)，组内其余置 FAILED；
 *      * 崩溃的 EXPORTING 自身置 FAILED；若磁盘存在 .ffp，通过 superseded_by_job_id 反查被取代的旧任务，
 *        同事务清空 superseded 元数据并重置崩溃计数，恢复为 CLEANUP_PENDING 自愈；
 *      * CLEANUP_PENDING 权威 job 物理文件存在则保持，缺失置 FAILED；
 * 2. 阶段 2：后台延迟自包含 Dry-Run 校验队列 (首屏后 5 秒唤醒):
 *    - 独立 Worker 线程单飞串行校验，两段式淘汰 (TTL 7天 + FIFO 50条)，大包永不误删。
 */

import * as fs from 'fs'
import * as path from 'path'
import type { Database } from 'better-sqlite3'
import { logger, LogCategory, deriveTargetLocalPath, PluginPathResolver } from '@firefly/shared'
import type { OfflinePackageDao, OfflinePackageJobRecord } from './offline-package-dao'
import { BundlePromoter, type IncomingModuleMeta } from './bundle-promoter'
import { BackgroundVerificationQueue } from './background-verification-queue'
import { ROOT_ED25519_PK, verifyManifestSignature } from './offline-bundle-exporter'

export interface ReconcileOptions {
  baseDir: string
  pluginsRootDir?: string
  db: Database
  dao: OfflinePackageDao
  /** 自定义公钥 (测试用) */
  customPublicKey?: string
  /** 阶段 2 延迟毫秒数 (默认 5000ms) */
  deferredDelayMs?: number
  /** 测试通道：内联运行后台队列 */
  inlineQueueForTest?: boolean
  /** 单元测试下是否禁止自动开启阶段 2 延迟队列 (默认 false) */
  skipDeferredQueue?: boolean
}

export interface ReconcileResult {
  reconciledImports: {
    rolledBackCount: number
    committedCount: number
    finishedCount: number
  }
  reconciledExports: {
    convergedGroupsCount: number
    supersedeRestoredCount: number
    markedFailedCount: number
  }
  backgroundQueue?: BackgroundVerificationQueue
}

export class StartupReconciler {
  /**
   * 应用冷启动同步轻量对账入口 (<5ms)
   */
  static async reconcileOnStartup(options: ReconcileOptions): Promise<ReconcileResult> {
    const {
      baseDir,
      db,
      dao,
      customPublicKey,
      deferredDelayMs = 5000,
      inlineQueueForTest = false,
      skipDeferredQueue = false
    } = options
    const pluginsRootDir = options.pluginsRootDir ?? path.join(baseDir, 'modules')

    const result: ReconcileResult = {
      reconciledImports: {
        rolledBackCount: 0,
        committedCount: 0,
        finishedCount: 0
      },
      reconciledExports: {
        convergedGroupsCount: 0,
        supersedeRestoredCount: 0,
        markedFailedCount: 0
      }
    }

    const nowMs = Date.now()

    // ------------------------------------------------------------------
    // 阶段 1A: 导入任务三态 ARIES 确定性自愈
    // ------------------------------------------------------------------
    const unconvergedImports = db
      .prepare(
        `
        SELECT * FROM offline_package_jobs
        WHERE job_type = 'IMPORT'
          AND status IN ('PREPARED', 'PROMOTING', 'PROMOTED', 'DB_COMMITTED')
      `
      )
      .all() as OfflinePackageJobRecord[]

    const sharedModulesDir = path.join(pluginsRootDir, '_shared')
    const moduleManifestsDir = path.join(pluginsRootDir, '_module_manifests')

    for (const job of unconvergedImports) {
      if (job.status === 'PREPARED' || job.status === 'PROMOTING') {
        // 公理“未到终局皆为废品”：坚守总包原子性，严禁局部自愈，无条件全量物理回滚
        try {
          const createdResIds: string[] = JSON.parse(job.created_resource_ids || '[]')

          // 自动嗅探匹配属于该任务的所有 .old-<jobId> 备份目录，并从 DB 补全资源目标路径供独占清理
          const affectedModules: IncomingModuleMeta[] = []
          const seenModIds = new Set<string>()
          const collectRollbackModulesFromDir = (dir: string) => {
            if (!fs.existsSync(dir)) return
            const suffix = `.old-${job.job_id}`
            for (const entry of fs.readdirSync(dir)) {
              if (entry.endsWith(suffix)) {
                const modId = entry.replace(suffix, '')
                if (seenModIds.has(modId)) continue
                seenModIds.add(modId)
                affectedModules.push({
                  moduleId: modId,
                  version: '0.0.0',
                  manifestRawBytes: Buffer.alloc(0),
                  resources: []
                })
              }
            }
          }
          collectRollbackModulesFromDir(sharedModulesDir)
          collectRollbackModulesFromDir(moduleManifestsDir)

          if (createdResIds.length > 0) {
            const dbResRows = db
              .prepare(
                `SELECT resource_id, asset_name, target_local_path FROM resource_downloads WHERE resource_id IN (${createdResIds.map(() => '?').join(',')})`
              )
              .all(...createdResIds) as Array<{
              resource_id: string
              asset_name: string
              target_local_path: string
            }>
            const rollbackResources = createdResIds.map(resId => {
              const row = dbResRows.find(r => r.resource_id === resId)
              const derived = deriveTargetLocalPath(resId) || `modules/_shared/${resId}`
              const targetLocalPath = row?.target_local_path ?? derived
              return {
                resource_id: resId,
                asset_name: row?.asset_name ?? path.basename(targetLocalPath),
                target_local_path: targetLocalPath
              }
            })
            if (affectedModules.length > 0) {
              affectedModules[0].resources = rollbackResources
            } else {
              affectedModules.push({
                moduleId: '__orphan_created_resources__',
                version: '0.0.0',
                manifestRawBytes: Buffer.alloc(0),
                resources: rollbackResources
              })
            }
          }

          await BundlePromoter.rollbackPromotion({
            jobId: job.job_id,
            baseDir,
            pluginsRootDir,
            modules: affectedModules,
            createdResourceIds: createdResIds,
            dao
          })
        } catch (err) {
          logger.warn(
            LogCategory.SYSTEM,
            `[StartupReconciler] 回滚未完成导入任务异常: ${job.job_id}`,
            err
          )
        }

        dao.updateJobStatus(job.job_id, 'FAILED', { nowMs })
        result.reconciledImports.rolledBackCount++
      } else if (job.status === 'PROMOTED') {
        // 物理文件已就位，但 DB 尚未提交：检查模块目录下的签名凭据
        let allValid = true
        interface VerifiedModuleInfo {
          moduleId: string
          manifestObj: Record<string, unknown>
        }
        const verifiedModules: VerifiedModuleInfo[] = []

        try {
          // 确定本 job 涉及的目标模块列表
          const candidateModuleIds = new Set<string>()

          // 1. 从 .old-<jobId> 备份目录识别被本 job 影响的模块
          if (fs.existsSync(sharedModulesDir)) {
            const suffix = `.old-${job.job_id}`
            const entries = fs.readdirSync(sharedModulesDir)
            for (const entry of entries) {
              if (entry.endsWith(suffix)) {
                candidateModuleIds.add(entry.replace(suffix, ''))
              }
            }
          }
          if (fs.existsSync(moduleManifestsDir)) {
            const suffix = `.old-${job.job_id}`
            for (const entry of fs.readdirSync(moduleManifestsDir)) {
              if (entry.endsWith(suffix)) {
                candidateModuleIds.add(entry.replace(suffix, ''))
              }
            }
          }

          // 2. 若 candidateModuleIds 为空 (全新安装)，仅扫描携带 manifest.json/manifest.sig 的模块目录（绝不误伤纯权重目录）
          if (candidateModuleIds.size === 0 && fs.existsSync(moduleManifestsDir)) {
            for (const entry of fs.readdirSync(moduleManifestsDir)) {
              if (
                entry.includes('.old-') ||
                entry.includes('.uninstalled-') ||
                entry.startsWith('.')
              ) {
                continue
              }
              const subDir = path.join(moduleManifestsDir, entry)
              if (
                fs.existsSync(path.join(subDir, 'manifest.json')) ||
                fs.existsSync(path.join(subDir, 'manifest.sig'))
              ) {
                candidateModuleIds.add(entry)
              }
            }
          }
          if (candidateModuleIds.size === 0 && fs.existsSync(sharedModulesDir)) {
            const entries = fs.readdirSync(sharedModulesDir)
            for (const entry of entries) {
              if (
                entry.includes('.old-') ||
                entry.includes('.uninstalled-') ||
                entry.startsWith('.')
              ) {
                continue
              }
              const subDir = path.join(sharedModulesDir, entry)
              if (
                fs.existsSync(path.join(subDir, 'manifest.json')) ||
                fs.existsSync(path.join(subDir, 'manifest.sig'))
              ) {
                candidateModuleIds.add(entry)
              }
            }
          }

          if (candidateModuleIds.size === 0) {
            allValid = false
          }

          // 3. 对目标模块逐一核验 Ed25519 签名与清单结构（优先 _module_manifests，兼容旧 _shared/<moduleId>）
          for (const modId of candidateModuleIds) {
            const ssotDir = PluginPathResolver.getModuleManifestDirForRoot(pluginsRootDir, modId)
            const legacyDir = path.join(sharedModulesDir, modId)
            const dirPath =
              fs.existsSync(path.join(ssotDir, 'manifest.json')) ||
              fs.existsSync(path.join(ssotDir, 'manifest.sig'))
                ? ssotDir
                : legacyDir
            const manifestPath = path.join(dirPath, 'manifest.json')
            const sigPath = path.join(dirPath, 'manifest.sig')

            if (!fs.existsSync(manifestPath) || !fs.existsSync(sigPath)) {
              allValid = false
              break
            }

            const raw = fs.readFileSync(manifestPath)
            const sig = fs.readFileSync(sigPath, 'utf-8').trim()
            if (!verifyManifestSignature(raw, sig, customPublicKey || ROOT_ED25519_PK)) {
              allValid = false
              break
            }

            const parsed = JSON.parse(raw.toString('utf-8'))
            verifiedModules.push({
              moduleId: modId,
              manifestObj: parsed
            })
          }
        } catch {
          allValid = false
        }

        if (allValid && verifiedModules.length > 0) {
          // 签名核验 100% 通过：单事务补写 SQLite 业务记录 (builtin_modules / resource_downloads / module_resource_downloads)
          const tx = db.transaction(() => {
            for (const { moduleId, manifestObj } of verifiedModules) {
              const modMeta = (manifestObj.module || manifestObj) as Record<string, unknown>
              const version = (modMeta.version as string) || '1.0.0'
              const category = (modMeta.category as string) || 'tool'
              const capabilitySlot = (modMeta.capability_slot as string) || 'general'
              const totalBytes = (modMeta.total_bytes as number) || 0

              // a. upsert builtin_modules
              const insertMod = db.prepare(`
                INSERT INTO builtin_modules (
                  id, version, category, capability_slot, total_bytes, catalog_meta_json,
                  install_state, installed_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'installed_inactive', ?)
                ON CONFLICT(id) DO UPDATE SET
                  version = excluded.version,
                  category = COALESCE(excluded.category, builtin_modules.category),
                  capability_slot = COALESCE(excluded.capability_slot, builtin_modules.capability_slot),
                  total_bytes = excluded.total_bytes,
                  install_state = 'installed_inactive',
                  installed_at = COALESCE(builtin_modules.installed_at, excluded.installed_at)
              `)
              insertMod.run(
                moduleId,
                version,
                category,
                capabilitySlot,
                totalBytes,
                JSON.stringify(modMeta),
                nowMs
              )

              // b. upsert resource_downloads & module_resource_downloads
              const resources = (modMeta.resources || manifestObj.resources || []) as Array<{
                resource_id?: string
                target_local_path?: string
                expected_sha256?: string
                size_bytes?: number
              }>

              for (const res of resources) {
                if (!res.resource_id) continue
                const targetPath =
                  res.target_local_path ||
                  deriveTargetLocalPath(res.resource_id) ||
                  `modules/_shared/${res.resource_id}`
                const sha = res.expected_sha256 || ''

                const insertRes = db.prepare(`
                  INSERT INTO resource_downloads (
                    resource_id, asset_name, target_local_path, active_source_key,
                    expected_bytes, expected_sha256, actual_sha256, download_state,
                    created_at, updated_at
                  ) VALUES (?, ?, ?, 'auto', ?, ?, ?, 'completed', ?, ?)
                  ON CONFLICT(resource_id) DO UPDATE SET
                    actual_sha256 = COALESCE(excluded.actual_sha256, resource_downloads.actual_sha256),
                    download_state = 'completed',
                    updated_at = excluded.updated_at
                `)
                insertRes.run(
                  res.resource_id,
                  path.basename(targetPath),
                  targetPath,
                  res.size_bytes || 0,
                  sha,
                  sha,
                  nowMs,
                  nowMs
                )

                const insertRel = db.prepare(`
                  INSERT OR IGNORE INTO module_resource_downloads (module_id, resource_id, created_at)
                  VALUES (?, ?, ?)
                `)
                insertRel.run(moduleId, res.resource_id, nowMs)
              }
            }

            // c. 同事务更新协调表状态为 DB_COMMITTED
            dao.updateJobStatus(job.job_id, 'DB_COMMITTED', { nowMs })
          })
          tx()

          // d. 事务提交成功后，物理清理 .old-<jobId> 备份
          if (fs.existsSync(sharedModulesDir)) {
            try {
              const files = fs.readdirSync(sharedModulesDir)
              for (const f of files) {
                if (f.includes(`.old-${job.job_id}`)) {
                  fs.rmSync(path.join(sharedModulesDir, f), { recursive: true, force: true })
                }
              }
            } catch {
              // ignore
            }
          }

          // e. 收敛更新为 FINISHED 终态
          dao.updateJobStatus(job.job_id, 'FINISHED', { nowMs })
          result.reconciledImports.committedCount++
        } else {
          // 任一模块损坏或凭据缺失：触发全量回滚置 FAILED
          const createdResIds: string[] = JSON.parse(job.created_resource_ids || '[]')
          const affectedModules: IncomingModuleMeta[] = []
          if (fs.existsSync(sharedModulesDir)) {
            const suffix = `.old-${job.job_id}`
            const entries = fs.readdirSync(sharedModulesDir)
            for (const entry of entries) {
              if (entry.endsWith(suffix)) {
                const modId = entry.replace(suffix, '')
                affectedModules.push({
                  moduleId: modId,
                  version: '0.0.0',
                  manifestRawBytes: Buffer.alloc(0),
                  resources: []
                })
              }
            }
          }

          await BundlePromoter.rollbackPromotion({
            jobId: job.job_id,
            baseDir,
            pluginsRootDir,
            modules: affectedModules,
            createdResourceIds: createdResIds,
            dao
          })
          dao.updateJobStatus(job.job_id, 'FAILED', { nowMs })
          result.reconciledImports.rolledBackCount++
        }
      } else if (job.status === 'DB_COMMITTED') {
        // 物理与数据库均已就位：清理残留的 .old-<jobId> 备份，置 FINISHED
        if (fs.existsSync(sharedModulesDir)) {
          try {
            const files = fs.readdirSync(sharedModulesDir)
            for (const f of files) {
              if (f.includes(`.old-${job.job_id}`)) {
                fs.rmSync(path.join(sharedModulesDir, f), { recursive: true, force: true })
              }
            }
          } catch {
            // ignore
          }
        }
        dao.updateJobStatus(job.job_id, 'FINISHED', { nowMs })
        result.reconciledImports.finishedCount++
      }
    }

    // ------------------------------------------------------------------
    // 阶段 1B: 导出任务同路径分组收敛与权属恢复
    // ------------------------------------------------------------------
    const groupedExports = dao.getJobsGroupedByArchivePath()
    result.reconciledExports.convergedGroupsCount = groupedExports.size

    groupedExports.forEach(({ authoritative, others }, archivePath) => {
      // 1. 组内其余次级任务统一批量置为 FAILED
      if (others.length > 0) {
        const otherIds = others.map(j => j.job_id)
        dao.batchMarkFailed(otherIds, nowMs, 'converged to authoritative job in same archive_path')
        result.reconciledExports.markedFailedCount += otherIds.length
      }

      // 2. 权威任务收敛与权属恢复判定
      if (authoritative.status === 'EXPORTING') {
        // 权威任务处于 EXPORTING：崩溃未写完，自身置为 FAILED
        dao.updateJobStatus(authoritative.job_id, 'FAILED', { nowMs })
        result.reconciledExports.markedFailedCount++

        // 权属恢复：若同路径磁盘存在旧 .ffp，反查被权威任务 supersede 的历史旧任务
        if (fs.existsSync(archivePath)) {
          const oldJob = dao.findSupersededExportJob(archivePath, authoritative.job_id)
          if (oldJob) {
            // 同事务显式清空 superseded_by_job_id / superseded_at 并重置连续崩溃计数，自愈恢复为 CLEANUP_PENDING
            dao.restoreSupersededExportJob(oldJob.job_id, nowMs)
            result.reconciledExports.supersedeRestoredCount++
            logger.info(
              LogCategory.SYSTEM,
              `[StartupReconciler] 权属恢复成功: 旧任务 ${oldJob.job_id} 恢复为 CLEANUP_PENDING (取代者 ${authoritative.job_id} 崩溃)`
            )
          }
        }
      } else if (authoritative.status === 'CLEANUP_PENDING') {
        // 权威任务处于 CLEANUP_PENDING：若物理文件不存在置为 FAILED，存在则保持
        if (!fs.existsSync(archivePath)) {
          dao.updateJobStatus(authoritative.job_id, 'FAILED', { nowMs })
          result.reconciledExports.markedFailedCount++
        }
      }
    })

    // ------------------------------------------------------------------
    // 阶段 1C: 异步孤儿 staging 目录清理
    // ------------------------------------------------------------------
    const stagingDir = path.join(pluginsRootDir, '_staging')
    if (fs.existsSync(stagingDir)) {
      try {
        fs.rmSync(stagingDir, { recursive: true, force: true })
      } catch (err) {
        logger.warn(
          LogCategory.SYSTEM,
          `[StartupReconciler] 清理孤儿 staging 目录异常: ${stagingDir}`,
          err
        )
      }
    }

    // ------------------------------------------------------------------
    // 阶段 1D: 存量明文旧模型目录与超额历史密文容器冷清扫 (Ticket 09)
    // ------------------------------------------------------------------
    const sharedDir = PluginPathResolver.getSharedDirForRoot(pluginsRootDir)
    try {
      const { PluginCleanupService } = await import('./plugin-cleanup-service')
      await PluginCleanupService.cleanupLegacyPlaintextAssets(sharedDir)
    } catch (cleanupErr) {
      logger.warn(LogCategory.SYSTEM, '[StartupReconciler] 存量旧资产清扫异常:', cleanupErr)
    }

    // ------------------------------------------------------------------
    // 阶段 2: 后台延迟自包含 Dry-Run 校验队列
    // ------------------------------------------------------------------
    if (!skipDeferredQueue) {
      const queue = new BackgroundVerificationQueue({
        dao,
        customPublicKey,
        initialDelayMs: deferredDelayMs,
        inlineForTest: inlineQueueForTest
      })
      queue.start(deferredDelayMs)
      result.backgroundQueue = queue
    }

    return result
  }
}
