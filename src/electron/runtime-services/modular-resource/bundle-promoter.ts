/**
 * 离线总包物理目录提升、事务协调与回滚自愈器 (Bundle Promoter)
 *
 * 核心不变量与准则 (System Invariants):
 * 1. 准入规则严格优先级判定：
 *    幂等跳过与 DB 自愈 (SKIPPED_SAME) > 同版本异哈希硬冲突 (VERSION_CONFLICT) >
 *    物理替换 active 保护 (MODULE_ACTIVE_CONFLICT) > 降级拦截 (DOWNGRADE_REJECTED) > 正常升级/新装 (PROCEED)；
 * 2. Phase 1 物理提升与共享资产所有权持久化：
 *    移动前先将 created_resource_ids / reused_resource_ids 持久化写入 SQLite 并 fsync；
 *    旧目录原子重命名为 .old-<jobId>，新目录重命名就位，5 次指数退避 (100ms~1600ms)；
 * 3. Phase 2 数据库单事务提交：
 *    开启 SQLite BEGIN IMMEDIATE 事务，upsert builtin_modules / resource_downloads / module_resource_downloads；
 * 4. Windows 安全失败回滚 (先清后移防 EEXIST 铁律)：
 *    若新正式目录已生成且伴随 .old 备份，先强制 rmSync 删除新目录，再原子重命名还原 .old，杜绝 EEXIST 瘫痪；
 *    依据 created_resource_ids 仅清理独占创建资产，reused_resource_ids 绝不误删；
 * 5. 卸载物理保留与回滚自愈：
 *    卸载时重命名保留为 .uninstalled-<timestamp> (7天)，回滚时按时间倒序验签后自愈恢复。
 */

import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { valid, lt } from 'semver'
import type { Database } from 'better-sqlite3'
import {
  logger,
  LogCategory,
  PluginPathResolver,
  SecurityViolationError,
  deriveTargetLocalPath,
  computeDirectoryReadyDigest,
  writeReadyMarker,
  invalidateReadyMarkers
} from '@firefly/shared'
import type { OfflinePackageDao } from './offline-package-dao'
import {
  partitionResourcesByDiskState,
  ResourceConflictError,
  type ResourceDecl
} from './deterministic-hasher'
import { ROOT_ED25519_PK, verifyManifestSignature } from './offline-bundle-exporter'

export type BundlePromoterErrorCode =
  | 'VERSION_CONFLICT'
  | 'MODULE_ACTIVE_CONFLICT'
  | 'DOWNGRADE_REJECTED'
  | 'RESOURCE_CONFLICT'
  | 'RECOVERY_REQUIRED'
  | 'IO_FAILURE'

export class BundlePromoterError extends Error {
  readonly code: BundlePromoterErrorCode
  readonly details?: string

  constructor(code: BundlePromoterErrorCode, message: string, details?: string) {
    super(message)
    this.name = 'BundlePromoterError'
    this.code = code
    this.details = details
  }
}

export interface IncomingModuleMeta {
  moduleId: string
  name?: string
  version: string
  category?: string
  capability_slot?: string
  total_bytes?: number
  manifestRawBytes?: Buffer | string
  catalog_meta_json?: string
  resources: Array<{
    resource_id: string
    asset_name: string
    target_local_path: string
    expected_bytes?: number
    expected_sha256?: string
  }>
}

export type AdmissionDecision =
  | { decision: 'SKIPPED_SAME'; moduleId: string; version: string; reason: string }
  | { decision: 'PROCEED'; moduleId: string; version: string; isUpgrade: boolean }

export interface PromotionOptions {
  jobId: string
  stagingDir: string
  baseDir: string
  pluginsRootDir?: string
  incomingModules: IncomingModuleMeta[]
  dao: OfflinePackageDao
  db: Database
  maxRetries?: number
}

export interface PromotionResult {
  ok: true
  promotedModuleIds: string[]
  skippedModuleIds: string[]
  createdResourceIds: string[]
  reusedResourceIds: string[]
}

/**
 * 指数退避辅助函数
 */
async function retryWithBackoff<T>(action: () => T, maxRetries = 5, baseDelayMs = 100): Promise<T> {
  let attempt = 0
  while (attempt <= maxRetries) {
    try {
      return action()
    } catch (err) {
      attempt++
      if (attempt > maxRetries) {
        throw err
      }
      const delay = baseDelayMs * Math.pow(2, attempt - 1) // 100, 200, 400, 800, 1600
      logger.warn(
        LogCategory.SYSTEM,
        `[BundlePromoter] 操作失败，进行第 ${attempt}/${maxRetries} 次指数退避 (${delay}ms):`,
        (err as Error)?.message
      )
      await new Promise(resolve => setTimeout(resolve, delay))
    }
  }
  throw new Error('超出重试上限')
}

/**
 * 离线总包物理提升、事务协调与安全回滚执行器
 */
export class BundlePromoter {
  /**
   * 1. 准入规则严格优先级判定算法 (Admission Evaluation)
   *
   * 顺序：
   * 1. 幂等跳过与 DB 自愈 (SKIPPED_SAME)
   * 2. 同版本异哈希硬冲突拦截 (VERSION_CONFLICT) - 先于 active 判定，根除二段式报错
   * 3. 物理替换时的 active 冲突保护 (MODULE_ACTIVE_CONFLICT)
   * 4. 降级拦截 (DOWNGRADE_REJECTED)
   * 5. 正常升级/新装 (PROCEED)
   */
  static evaluateAdmission(
    incoming: IncomingModuleMeta,
    baseDir: string,
    db: Database,
    options?: { pluginsRootDir?: string }
  ): AdmissionDecision {
    const { moduleId, version: incomingVersion, manifestRawBytes } = incoming
    const pluginsRootDir = options?.pluginsRootDir ?? path.join(baseDir, 'modules')

    // 计算传入清单的 SHA-256
    const incomingBuffer = Buffer.isBuffer(manifestRawBytes)
      ? manifestRawBytes
      : Buffer.from(manifestRawBytes || '', 'utf-8')
    const incomingSha256 = crypto
      .createHash('sha256')
      .update(incomingBuffer)
      .digest('hex')
      .toLowerCase()

    // 检索本地数据库中的模块记录
    const stmt = db.prepare('SELECT id, version, install_state FROM builtin_modules WHERE id = ?')
    const existingDbRecord = stmt.get(moduleId) as
      | { id: string; version: string; install_state: string }
      | undefined

    // 优先检查 SSOT 清单目录 `_module_manifests/<moduleId>`，兼容回退旧 `_shared/<moduleId>`
    const ssotManifestDir = PluginPathResolver.getModuleManifestDirForRoot(pluginsRootDir, moduleId)
    const legacyManifestDir = path.join(pluginsRootDir, '_shared', moduleId)
    const formalModuleDir = fs.existsSync(path.join(ssotManifestDir, 'manifest.json'))
      ? ssotManifestDir
      : legacyManifestDir
    const formalManifestPath = path.join(formalModuleDir, 'manifest.json')
    const formalSigPath = path.join(formalModuleDir, 'manifest.sig')

    let existingVersion: string | null = null
    let existingManifestSha256: string | null = null

    if (fs.existsSync(formalManifestPath)) {
      try {
        const rawContent = fs.readFileSync(formalManifestPath)
        // 若存在签名，需验证签名合法性作为权威基准
        if (fs.existsSync(formalSigPath)) {
          const sig = fs.readFileSync(formalSigPath, 'utf-8').trim()
          if (verifyManifestSignature(rawContent, sig, ROOT_ED25519_PK)) {
            existingManifestSha256 = crypto
              .createHash('sha256')
              .update(rawContent)
              .digest('hex')
              .toLowerCase()
            const parsed = JSON.parse(rawContent.toString('utf-8'))
            existingVersion = parsed.module?.version ?? parsed.version ?? null
          }
        } else {
          existingManifestSha256 = crypto
            .createHash('sha256')
            .update(rawContent)
            .digest('hex')
            .toLowerCase()
          const parsed = JSON.parse(rawContent.toString('utf-8'))
          existingVersion = parsed.module?.version ?? parsed.version ?? null
        }
      } catch (readErr) {
        logger.warn(
          LogCategory.SYSTEM,
          `[BundlePromoter] 读取现有正式清单失败: ${formalManifestPath}`,
          readErr
        )
      }
    }

    // 若物理不存在但 DB 有记录，以 DB 版本为准；反之亦然
    const currentVersion = existingVersion ?? existingDbRecord?.version
    const currentInstallState = existingDbRecord?.install_state ?? 'not_installed'

    // 规则 1：幂等跳过与 DB 自愈 (最高优先级，绝不报 active 冲突)
    if (
      currentVersion &&
      incomingVersion === currentVersion &&
      existingManifestSha256 &&
      incomingSha256 === existingManifestSha256
    ) {
      return {
        decision: 'SKIPPED_SAME',
        moduleId,
        version: incomingVersion,
        reason: '版本与清单哈希完全一致，执行幂等复用与 DB 状态自愈'
      }
    }

    // 规则 2：同版本异哈希硬冲突拦截 (先于 active 运行检查)
    if (
      currentVersion &&
      incomingVersion === currentVersion &&
      existingManifestSha256 &&
      incomingSha256 !== existingManifestSha256
    ) {
      throw new BundlePromoterError(
        'VERSION_CONFLICT',
        `插件 ${moduleId} 存在同版本异构构建硬冲突: 已有清单哈希 (${existingManifestSha256}) 与导入清单哈希 (${incomingSha256}) 不匹配`,
        `existingSha256=${existingManifestSha256}, incomingSha256=${incomingSha256}`
      )
    }

    // 规则 3：物理替换时的 active 冲突保护
    if (currentInstallState === 'active') {
      throw new BundlePromoterError(
        'MODULE_ACTIVE_CONFLICT',
        `插件 ${moduleId} 当前处于运行中 (active)，禁止原地物理覆写替换。请先在插件中心停用或卸载后再导入更新。`
      )
    }

    // 规则 4：降级拦截
    if (currentVersion && valid(incomingVersion) && valid(currentVersion)) {
      if (lt(incomingVersion, currentVersion)) {
        throw new BundlePromoterError(
          'DOWNGRADE_REJECTED',
          `检测到插件 ${moduleId} 本地已存在更高版本 (${currentVersion} > ${incomingVersion})，拒绝降级覆盖。如确需降级请先手动卸载高版本。`
        )
      }
    }

    // 规则 5：正常升级 / 新装
    return {
      decision: 'PROCEED',
      moduleId,
      version: incomingVersion,
      isUpgrade: Boolean(currentVersion)
    }
  }

  /**
   * 2. 执行完整的两阶段物理提升与事务协调
   */
  static async executePromotion(options: PromotionOptions): Promise<PromotionResult> {
    const { jobId, stagingDir, baseDir, incomingModules, dao, db, maxRetries = 5 } = options
    const pluginsRootDir = options.pluginsRootDir ?? path.join(baseDir, 'modules')

    const promotedModuleIds: string[] = []
    const skippedModuleIds: string[] = []
    const modulesToPhysicallyPromote: IncomingModuleMeta[] = []

    // 步骤 0：全量准入评估与前置校验
    for (const mod of incomingModules) {
      const decision = this.evaluateAdmission(mod, baseDir, db, { pluginsRootDir })
      if (decision.decision === 'SKIPPED_SAME') {
        skippedModuleIds.push(mod.moduleId)
      } else {
        modulesToPhysicallyPromote.push(mod)
      }
    }

    // 收集所有待提升及同版本跳过模块涉及的共享物理资产声明 (全量覆盖以保证 DB 缺失/损坏时自愈资产绑定关系)
    const declaredResourcesMap = new Map<string, ResourceDecl>()
    for (const mod of incomingModules) {
      for (const res of mod.resources) {
        if (!declaredResourcesMap.has(res.resource_id)) {
          declaredResourcesMap.set(res.resource_id, {
            resource_id: res.resource_id,
            target_local_path: res.target_local_path,
            expected_sha256: res.expected_sha256
          })
        }
      }
    }
    const declaredResources = Array.from(declaredResourcesMap.values())
    const sharedModulesDir = path.join(pluginsRootDir, '_shared')
    fs.mkdirSync(sharedModulesDir, { recursive: true })

    // 步骤 1：静态所有权划分与前置持久化 (Crash-Window Ownership Guard)
    let createdResourceIds: string[] = []
    let reusedResourceIds: string[] = []
    try {
      const partitioned = await partitionResourcesByDiskState(declaredResources, sharedModulesDir)
      createdResourceIds = partitioned.createdResourceIds
      reusedResourceIds = partitioned.reusedResourceIds
    } catch (partitionErr) {
      if (partitionErr instanceof ResourceConflictError) {
        throw new BundlePromoterError(
          'RESOURCE_CONFLICT',
          `共享资产 ${partitionErr.resourceId} 内容哈希冲突: 期望 ${partitionErr.expectedSha256}, 实际 ${partitionErr.actualSha256}`
        )
      }
      throw partitionErr
    }

    // 在进入物理操作前，一次性原子更新协调表状态为 PROMOTING 并锁定资源归属集合
    dao.updateJobStatus(jobId, 'PROMOTING', {
      created_resource_ids: createdResourceIds,
      reused_resource_ids: reusedResourceIds
    })

    try {
      // ------------------------------------------------------------------
      // Phase 1: 物理目录单版本提升协议 (.old-<jobId> 隔离与退避)
      // ------------------------------------------------------------------

      // A. 提升模块目录
      for (const mod of modulesToPhysicallyPromote) {
        const formalDir = path.join(sharedModulesDir, mod.moduleId)
        const oldBackupDir = path.join(sharedModulesDir, `${mod.moduleId}.old-${jobId}`)
        const stagedModuleDir = path.join(stagingDir, mod.moduleId)

        // 若 formalDir 存在，先原子重命名为 .old-<jobId> 备份
        if (fs.existsSync(formalDir)) {
          await retryWithBackoff(() => {
            fs.renameSync(formalDir, oldBackupDir)
          }, maxRetries)
        }

        // 将暂存目录原子重命名就位 (若暂存目录不存在直接显式报警阻断)
        if (!fs.existsSync(stagedModuleDir)) {
          throw new BundlePromoterError('IO_FAILURE', `暂存区缺少模块物理目录: ${stagedModuleDir}`)
        }
        await retryWithBackoff(() => {
          fs.renameSync(stagedModuleDir, formalDir)
        }, maxRetries)

        promotedModuleIds.push(mod.moduleId)
      }

      // B. 提升共享物理资产 (Shared Resource Identity Guard)
      for (const res of declaredResources) {
        const relPath =
          res.target_local_path ||
          deriveTargetLocalPath(res.resource_id) ||
          `modules/_shared/${res.resource_id}`
        let formalAssetPath: string
        try {
          formalAssetPath = PluginPathResolver.resolvePhysicalPathForRoot(pluginsRootDir, relPath)
        } catch (secErr) {
          throw new BundlePromoterError(
            'IO_FAILURE',
            secErr instanceof SecurityViolationError
              ? secErr.message
              : `非法资产目标路径逃逸: ${relPath}`
          )
        }
        const stagedAssetPath = path.resolve(stagingDir, relPath)

        if (createdResourceIds.includes(res.resource_id)) {
          // 独占新创建资产：从暂存区移动到正式目录
          if (fs.existsSync(stagedAssetPath)) {
            fs.mkdirSync(path.dirname(formalAssetPath), { recursive: true })
            // 先清后移防 Windows EEXIST，并于物化前后维护统一 `.ready.json` 标记
            if (fs.existsSync(formalAssetPath)) {
              await invalidateReadyMarkers(formalAssetPath)
              await retryWithBackoff(() => {
                fs.rmSync(formalAssetPath, { recursive: true, force: true })
              }, maxRetries)
            }
            await retryWithBackoff(() => {
              fs.renameSync(stagedAssetPath, formalAssetPath)
            }, maxRetries)
            if (fs.existsSync(formalAssetPath) && fs.statSync(formalAssetPath).isDirectory()) {
              await invalidateReadyMarkers(formalAssetPath)
              const digestResult = await computeDirectoryReadyDigest(formalAssetPath)
              await writeReadyMarker(formalAssetPath, {
                resourceId: res.resource_id,
                sharedSubDir: path.basename(formalAssetPath),
                digestResult
              })
            }
          }
        }
      }

      // 物理提升 100% 完毕，更新协调表状态为 PROMOTED
      dao.updateJobStatus(jobId, 'PROMOTED')

      // ------------------------------------------------------------------
      // Phase 2: 数据库单事务持久化 (BEGIN IMMEDIATE)
      // ------------------------------------------------------------------
      const nowMs = Date.now()
      const tx = db.transaction(() => {
        // 1. 处理所有已提升模块的 DB upsert
        for (const mod of modulesToPhysicallyPromote) {
          const insertOrUpdateModule = db.prepare(`
            INSERT INTO builtin_modules (
              id, version, category, capability_slot, total_bytes, catalog_meta_json,
              install_state, installed_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'installed_inactive', ?)
            ON CONFLICT(id) DO UPDATE SET
              version = excluded.version,
              category = COALESCE(excluded.category, builtin_modules.category),
              capability_slot = COALESCE(excluded.capability_slot, builtin_modules.capability_slot),
              total_bytes = excluded.total_bytes,
              catalog_meta_json = COALESCE(excluded.catalog_meta_json, builtin_modules.catalog_meta_json),
              install_state = 'installed_inactive',
              installed_at = COALESCE(builtin_modules.installed_at, excluded.installed_at)
          `)

          insertOrUpdateModule.run(
            mod.moduleId,
            mod.version,
            mod.category ?? 'tool',
            mod.capability_slot ?? 'general',
            mod.total_bytes ?? 0,
            mod.catalog_meta_json ?? null,
            nowMs
          )
        }

        // 2. 处理 SKIPPED_SAME 模块的 DB 状态自愈 (支持 DB 缺失时重建记录或异常状态自愈为 installed_inactive)
        const incomingMap = new Map(incomingModules.map(m => [m.moduleId, m]))
        for (const modId of skippedModuleIds) {
          const mod = incomingMap.get(modId)
          if (!mod) continue
          const healStmt = db.prepare(`
            INSERT INTO builtin_modules (
              id, version, category, capability_slot, total_bytes, catalog_meta_json,
              install_state, installed_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'installed_inactive', ?)
            ON CONFLICT(id) DO UPDATE SET
              install_state = CASE
                WHEN builtin_modules.install_state IN ('not_installed', 'error') THEN 'installed_inactive'
                ELSE builtin_modules.install_state
              END,
              version = excluded.version
          `)
          healStmt.run(
            mod.moduleId,
            mod.version,
            mod.category ?? 'tool',
            mod.capability_slot ?? 'general',
            mod.total_bytes ?? 0,
            mod.catalog_meta_json ?? null,
            nowMs
          )
        }

        // 3. 处理所有声明资源的 resource_downloads 表 upsert
        // 恪守不可动摇防篡改铁律：严禁改写 target_local_path 与 expected_sha256
        for (const res of declaredResources) {
          const insertOrUpdateResource = db.prepare(`
            INSERT INTO resource_downloads (
              resource_id, asset_name, target_local_path, active_source_key,
              expected_bytes, expected_sha256, actual_sha256, download_state,
              created_at, updated_at
            ) VALUES (?, ?, ?, 'auto', 0, ?, ?, 'completed', ?, ?)
            ON CONFLICT(resource_id) DO UPDATE SET
              actual_sha256 = COALESCE(excluded.actual_sha256, resource_downloads.actual_sha256),
              download_state = 'completed',
              updated_at = excluded.updated_at
          `)

          const targetSha = res.expected_sha256 ?? ''
          const relPath =
            res.target_local_path ||
            deriveTargetLocalPath(res.resource_id) ||
            `modules/_shared/${res.resource_id}`
          insertOrUpdateResource.run(
            res.resource_id,
            res.asset_name || path.basename(relPath),
            relPath,
            targetSha,
            targetSha,
            nowMs,
            nowMs
          )
        }

        // 4. 建立 module_resource_downloads 关联绑定
        const insertRelation = db.prepare(`
          INSERT OR IGNORE INTO module_resource_downloads (module_id, resource_id, created_at)
          VALUES (?, ?, ?)
        `)
        for (const mod of incomingModules) {
          for (const res of mod.resources) {
            insertRelation.run(mod.moduleId, res.resource_id, nowMs)
          }
        }

        // 5. 同事务更新协调表为 DB_COMMITTED
        dao.updateJobStatus(jobId, 'DB_COMMITTED', { nowMs })
      })

      // 执行事务提交
      tx()

      // 异步清理 .old-<jobId> 备份目录
      for (const mod of modulesToPhysicallyPromote) {
        const oldBackupDir = path.join(sharedModulesDir, `${mod.moduleId}.old-${jobId}`)
        try {
          if (fs.existsSync(oldBackupDir)) {
            fs.rmSync(oldBackupDir, { recursive: true, force: true })
          }
        } catch (cleanErr) {
          logger.warn(
            LogCategory.SYSTEM,
            `[BundlePromoter] 异步清理旧备份目录失败: ${oldBackupDir}`,
            cleanErr
          )
        }
      }

      return {
        ok: true,
        promotedModuleIds,
        skippedModuleIds,
        createdResourceIds,
        reusedResourceIds
      }
    } catch (promotionError) {
      logger.error(
        LogCategory.SYSTEM,
        '[BundlePromoter] 物理提升或事务持久化异常，启动 Windows 安全回滚:',
        promotionError
      )

      // 触发 Windows 先清后移安全回滚
      await this.rollbackPromotion({
        jobId,
        baseDir,
        pluginsRootDir,
        modules: modulesToPhysicallyPromote,
        createdResourceIds,
        dao,
        maxRetries
      })

      throw promotionError
    }
  }

  /**
   * 3. Windows 安全失败回滚 (先清后移防 EEXIST 铁律)
   */
  static async rollbackPromotion(options: {
    jobId: string
    baseDir: string
    pluginsRootDir?: string
    modules: IncomingModuleMeta[]
    createdResourceIds: string[]
    dao: OfflinePackageDao
    maxRetries?: number
  }): Promise<void> {
    const { jobId, baseDir, modules, createdResourceIds, dao, maxRetries = 5 } = options
    const pluginsRootDir = options.pluginsRootDir ?? path.join(baseDir, 'modules')
    const sharedModulesDir = path.join(pluginsRootDir, '_shared')

    let rollbackLocked = false

    // A. 模块目录反向安全恢复 (以 oldBackupDir 存在性为首要判断依据，先清后移防 EEXIST)
    for (const mod of modules) {
      const formalDir = path.join(sharedModulesDir, mod.moduleId)
      const oldBackupDir = path.join(sharedModulesDir, `${mod.moduleId}.old-${jobId}`)

      try {
        if (fs.existsSync(oldBackupDir)) {
          // 只要存在旧备份目录，无论 formalDir 当前是否存在，均须先清 formalDir 再还原 oldBackupDir
          if (fs.existsSync(formalDir)) {
            // 步骤 1：先强制删除未完成的新正式目录 (彻底杜绝 Windows 目标目录已存在导致 EEXIST/EPERM 瘫痪)
            await retryWithBackoff(() => {
              fs.rmSync(formalDir, { recursive: true, force: true })
            }, maxRetries)
          }

          // 步骤 2：再原子重命名还原 .old 备份目录
          await retryWithBackoff(() => {
            fs.renameSync(oldBackupDir, formalDir)
          }, maxRetries)
        } else if (fs.existsSync(formalDir)) {
          // 全新模块导入中途失败（无 old 备份）：直接强制删除新生成的正式目录
          await retryWithBackoff(() => {
            fs.rmSync(formalDir, { recursive: true, force: true })
          }, maxRetries)
        }
      } catch (restoreErr) {
        logger.error(
          LogCategory.SYSTEM,
          `[BundlePromoter] 回滚还原模块目录遭遇持续锁定: ${mod.moduleId}`,
          restoreErr
        )
        rollbackLocked = true
      }
    }

    // B. 仅删除本 job 独占创建的物理资产，存量复用资产绝不误删 (去重与路径穿越纵深校验)
    const uniqueCreatedResIds = Array.from(new Set(createdResourceIds))
    const resourceDeclMap = new Map<string, string>()
    for (const mod of modules) {
      for (const res of mod.resources) {
        if (!resourceDeclMap.has(res.resource_id)) {
          resourceDeclMap.set(res.resource_id, res.target_local_path)
        }
      }
    }

    for (const resId of uniqueCreatedResIds) {
      const targetLocalPath = resourceDeclMap.get(resId)
      if (!targetLocalPath) continue
      let formalAssetPath: string
      try {
        formalAssetPath = PluginPathResolver.resolvePhysicalPathForRoot(
          pluginsRootDir,
          targetLocalPath
        )
      } catch (secErr) {
        logger.warn(
          LogCategory.SYSTEM,
          `[BundlePromoter] 回滚跳过非法资产路径: ${resId} (${targetLocalPath})`,
          secErr
        )
        continue
      }

      try {
        if (fs.existsSync(formalAssetPath)) {
          await retryWithBackoff(() => {
            fs.rmSync(formalAssetPath, { recursive: true, force: true })
          }, maxRetries)
        }
      } catch (rmResErr) {
        logger.warn(
          LogCategory.SYSTEM,
          `[BundlePromoter] 清理独占创建资产失败: ${formalAssetPath}`,
          rmResErr
        )
      }
    }

    // C. 更新协调表终态：若被锁死标记为 RECOVERY_REQUIRED，否则收敛为 FAILED
    const finalStatus = rollbackLocked ? 'RECOVERY_REQUIRED' : 'FAILED'
    dao.updateJobStatus(jobId, finalStatus)
  }

  /**
   * 4. 卸载保留 7 天机制 (Retention on Uninstall)
   */
  static async uninstallWithRetention(
    moduleId: string,
    baseDir: string,
    db: Database,
    maxRetries = 5,
    pluginsRootDir?: string
  ): Promise<{ ok: true; retentionDir: string }> {
    const resolvedPluginsRoot = pluginsRootDir ?? path.join(baseDir, 'modules')
    const formalDir = path.join(resolvedPluginsRoot, '_shared', moduleId)
    const timestamp = Date.now()
    const retentionDir = path.join(
      resolvedPluginsRoot,
      '_shared',
      `${moduleId}.uninstalled-${timestamp}`
    )

    if (fs.existsSync(formalDir)) {
      await retryWithBackoff(() => {
        fs.renameSync(formalDir, retentionDir)
      }, maxRetries)
    }

    const stmt = db.prepare(`
      UPDATE builtin_modules
      SET install_state = 'not_installed'
      WHERE id = ?
    `)
    stmt.run(moduleId)

    return { ok: true, retentionDir }
  }

  /**
   * 5. 从保留目录回滚自愈恢复 (Rollback from Retention)
   */
  static async rollbackFromRetention(
    moduleId: string,
    baseDir: string,
    db: Database,
    maxRetries = 5,
    pluginsRootDir?: string
  ): Promise<{ ok: true; restoredVersion: string }> {
    const resolvedPluginsRoot = pluginsRootDir ?? path.join(baseDir, 'modules')
    const sharedDir = path.join(resolvedPluginsRoot, '_shared')
    const prefix = `${moduleId}.uninstalled-`

    if (!fs.existsSync(sharedDir)) {
      throw new BundlePromoterError('RECOVERY_REQUIRED', `共享目录不存在: ${sharedDir}`)
    }

    // 扫描匹配最新的 .uninstalled-* 候选目录
    const candidates = fs
      .readdirSync(sharedDir)
      .filter(name => name.startsWith(prefix))
      .sort((a, b) => {
        const timeA = parseInt(a.replace(prefix, ''), 10) || 0
        const timeB = parseInt(b.replace(prefix, ''), 10) || 0
        return timeB - timeA // 降序取最新
      })

    if (candidates.length === 0) {
      throw new BundlePromoterError(
        'RECOVERY_REQUIRED',
        `未找到模块 ${moduleId} 的任何卸载备份目录`
      )
    }

    const latestCandidateDir = path.join(sharedDir, candidates[0])
    const manifestPath = path.join(latestCandidateDir, 'manifest.json')
    const sigPath = path.join(latestCandidateDir, 'manifest.sig')

    if (!fs.existsSync(manifestPath) || !fs.existsSync(sigPath)) {
      throw new BundlePromoterError(
        'RECOVERY_REQUIRED',
        `备份目录 ${candidates[0]} 缺少 manifest.json 或 manifest.sig，无法安全自愈恢复`
      )
    }

    const rawManifest = fs.readFileSync(manifestPath)
    const sigHex = fs.readFileSync(sigPath, 'utf-8').trim()

    // 权威 Ed25519 验签防篡改
    if (!verifyManifestSignature(rawManifest, sigHex, ROOT_ED25519_PK)) {
      throw new BundlePromoterError(
        'RECOVERY_REQUIRED',
        `备份目录 ${candidates[0]} 官方验签失败，已被非法篡改，严禁自愈恢复！`
      )
    }

    const parsed = JSON.parse(rawManifest.toString('utf-8'))
    const restoredVersion = parsed.module?.version ?? parsed.version ?? '1.0.0'
    const formalDir = path.join(sharedDir, moduleId)

    // 若正式目录已存在残存，先清理再还原
    if (fs.existsSync(formalDir)) {
      await retryWithBackoff(() => {
        fs.rmSync(formalDir, { recursive: true, force: true })
      }, maxRetries)
    }
    await retryWithBackoff(() => {
      fs.renameSync(latestCandidateDir, formalDir)
    }, maxRetries)

    // 数据库事务恢复为 installed_inactive 并重新建立资源关联
    const nowMs = Date.now()
    const tx = db.transaction(() => {
      const stmt = db.prepare(`
        INSERT INTO builtin_modules (id, version, install_state, installed_at)
        VALUES (?, ?, 'installed_inactive', ?)
        ON CONFLICT(id) DO UPDATE SET
          install_state = 'installed_inactive',
          version = excluded.version
      `)
      stmt.run(moduleId, restoredVersion, nowMs)

      // 若 manifest 中包含 resources 声明，恢复关联
      const resources = parsed.resources || parsed.module?.resources
      if (Array.isArray(resources)) {
        const linkStmt = db.prepare(`
          INSERT OR IGNORE INTO module_resource_downloads (module_id, resource_id, created_at)
          VALUES (?, ?, ?)
        `)
        for (const res of resources) {
          if (res?.resource_id) {
            linkStmt.run(moduleId, res.resource_id, nowMs)
          }
        }
      }
    })
    tx()

    return { ok: true, restoredVersion }
  }
}
