/**
 * ModularResourceService 默认种子、Schema 自愈、绑定对账与视图构建
 * （由 modular-resource-service-core.ts 拆分而来，保持原运行时行为与类型契约）
 */
/**
 * 插件中心与资源下载生命周期协调器 (ModularResourceService)
 *
 * 作为深模块（Deep Module），将 BuiltinModuleDao、ResourceDownloadDao 与底层文件/网络原语
 * （三级探活拓扑、后备预置包直通、固定 4MiB 块网格断点续传、双轨源 AIMD 退避、
 * 启动期自愈与 IN-04 catalog_version 防回退）收拢在统一的高杠杆接口背后。
 *
 * @doc-anchor: docs/specs/plugin-download-multithread-hash-verify-and-preset-fallback-spec.md
 */

import * as fs from 'fs'
import * as path from 'path'
import { AsyncLocalStorage } from 'async_hooks'
import { app as electronApp } from 'electron'
import type { Database } from 'better-sqlite3'
import {
  logger,
  LogCategory,
  ResourceLocator,
  isPathEqual,
  isSubPath,
  BUILTIN_MODULE_CATALOG_META,
  BUILTIN_PLUGIN_CATALOG_META,
  EXCLUSIVE_CAPABILITY_SLOTS,
  OBSOLETE_SHARED_RESOURCE_IDS,
  deriveTargetLocalPath,
  computeModuleTotalBytes,
  buildResourceSpecFromCatalog,
  isExclusiveCapabilitySlot,
  PluginPathResolver,
  READY_MARKER_FILENAME,
  LEGACY_READY_MARKER_PREFIX,
  SecurityViolationError,
  computeDirectoryReadyDigest,
  readReadyMarker,
  writeReadyMarker,
  invalidateReadyMarkers,
  type BuiltinSharedResourceId
} from '@firefly/shared'
import {
  ModularResourceDao,
  type BuiltinModuleRecord,
  type ResourceDownloadRecord,
  type ModuleKind,
  type ModuleCategory,
  type ModuleInstallState,
  type ModuleAuthorCode,
  type ModuleAvailability,
  type PluginCapabilitySlot,
  type SlotPolicy,
  type BackendType,
  type EmbeddingEpochRecord,
  type DownloadState
} from '../database/dao/modular-resource-dao'
import { GENESIS_V1_SCHEMA } from '../database/database'
import {
  cleanupLegacyVocabBinSync,
  commitPluginDirectoryWithTxn,
  computeFileSha256Sync,
  getVisualVocabCatalogMeta,
  getVisualVocabEncoderId,
  hasLocalVisualVocabFiles,
  isVisualVocabPluginResource,
  recoverPendingPluginTxns,
  verifyVisualVocabWithOmniCli,
  writePluginReadyMarkerWithVisualVocab,
  type AssetsReloadResult,
  type ReloadAssetsFn,
  type VerifyVisualVocabFn
} from '../system/visual-vocab-txn'

export type { PluginCapabilitySlot, SlotPolicy, BackendType, EmbeddingEpochRecord }
import { PluginProcessManager, getPluginProcessManager } from '../system/plugin-process-manager'
import {
  TombstoneGCService,
  tombstoneGCService,
  OfflinePackageService,
  offlinePackageService,
  type PendingDeletionItem
} from './'
import {
  FileDownloadService,
  fileDownloadService,
  safeExtractZip,
  safeDeleteDirectory,
  cleanOrphanTombstones,
  streamVerifySha256,
  renameWithRetry,
  reconcileDirSwitchIntents,
  recoverSharedVisualVocabTxns,
  checkDiskSpace,
  cleanOldTrashAndOrphanParts,
  DualTrackSourceRouter,
  type VerifiedDownloadResult,
  type IDownloadTransport
} from '../system/file-download-service'
import {
  validatePluginDirectory,
  probeDirectoryWritableAndSpace,
  getDiskFreeSpace,
  ModularResourceError,
  RESERVED_DEVICE_REG,
  isReservedDeviceName,
  resolvePhysicalPath
} from '../system/plugin-dir-validator'
import {
  dirMigrationCoordinator,
  DirMigrationCoordinator,
  type DirMigrationProgressPayload
} from '../system/dir-migration-coordinator'
import { voiceArchiveService } from '../audio/voice-archive-service'
import { resolveAppRegion } from '../../main/worktree-env'
import type {
  DirRuntimePhase,
  PluginDirErrorCode,
  PluginDirInfo,
  ValidatePluginDirResult
} from '@firefly/types/config-types'

export {
  validatePluginDirectory,
  probeDirectoryWritableAndSpace,
  getDiskFreeSpace,
  ModularResourceError,
  RESERVED_DEVICE_REG,
  isReservedDeviceName,
  resolvePhysicalPath,
  dirMigrationCoordinator,
  DirMigrationCoordinator
}
export type {
  VerifiedDownloadResult,
  DirRuntimePhase,
  PluginDirErrorCode,
  PluginDirInfo,
  ValidatePluginDirResult,
  DirMigrationProgressPayload
}

// ─── 目录种子 / 运行时拓扑协调器 / 共享类型：单一事实源移至独立子文件，本文件复用 ───
import type {
  CatalogResourceSpec,
  CatalogModuleEntry,
  ModuleDownloadProgressEvent,
  BuiltinModuleView,
  FastReadyStatus,
  ResourceValidationEntry,
  FastReadyBarrierResult,
  TopologyChangeNotificationOptions,
  TopologyChangeHandler
} from '../system/types'
import {
  RuntimeTopologyCoordinator,
  runtimeTopologyCoordinator
} from '../system/runtime-topology-coordinator'
import { DEFAULT_CATALOG_SEEDS } from '../system/catalog-seeds'
import { emitRuntimeContextChange } from '../system/workspace-runtime-context-bus'
import {
  ModularResourceService,
  LEGACY_HEAL_MARKER_FILENAME,
  hasAnyReadyMarkerFile,
  resolveSharedSubDir,
  parseExclusiveSlotsFromIndexSql,
  mapTaskStatesToModuleState
} from '../system/modular-resource-service-core'

/**
 * 同步执行目录元数据更新（确保 DEFAULT_CATALOG_SEEDS 全量模块落地）
 *
 * 幂等补灌铁律：严禁以 `existing.length === 0`（空库）为灌库守卫——存量库新增内置模块
 * （如 media_enhance 四个 coming_soon 预占位、file_ai_cover）依赖此处补行，否则插件中心
 * 读库渲染将永久缺失新模块，而目录插件配置 Tab 读静态常量正常显示，两视图漂移。
 * syncCatalogSync 自带 catalog_version 回归保护与 IN-04 铁律（绝不覆盖本地
 * install_state/user_config/config_json），无条件执行安全；服务生命周期内单次执行。
 */
export function mrCatalogEnsureDefaultSeeds(host: any): void {
  if (!host.seeded) {
    try {
      let { failedRows } = host.syncCatalogSync(DEFAULT_CATALOG_SEEDS)
      host.seeded = true
      if (failedRows.length > 0) {
        // 存量库 builtin_modules 表级 CHECK 于建表时固化，创世基线扩充白名单（如
        // media_enhance）后老库单行插入被拒且无法 ALTER —— 先尝试表级自愈重建
        // （备份本地状态 → DROP → 按创世基线重建 → 状态回灌 → 重试补灌）
        const healed = host.rebuildBuiltinModulesTableForGenesisDrift()
        if (healed) {
          failedRows = host.syncCatalogSync(DEFAULT_CATALOG_SEEDS).failedRows
        }
      }
      if (failedRows.length > 0) {
        // 显式上报（禁止静默降级）：自愈后仍被拒绝属真异常，转人工处置
        logger.warn(
          LogCategory.SYSTEM,
          `[catalog_seed_rows_rejected] ${failedRows.length} 行种子被存量表约束拒绝（自愈重建未生效或失败），` +
            '请删除本地数据库文件后重建（应用未上线无迁移兼容，GENESIS_V1_SCHEMA 已更新）:',
          failedRows.map((r: any) => `${r.id}: ${r.error}`).join('; ')
        )
      }
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[ModularResource] 初始化内置目录种子失败:', err)
    }
  }
}

/**
 * 判定 builtin_modules 的 category CHECK 白名单是否落后于当前种子清单
 *
 * 判据必须语义化（检查种子用到的每个 category 是否出现在库表 CHECK 里），
 * **严禁拿 sqlite_master.sql 与 GENESIS 原文做整段文本比对**——SQLite 存储时会
 * 移除 `IF NOT EXISTS` 并规整尾部括号，文本比对恒不相等，会把「检测漂移」退化成
 * 「每次启动无脑重建」（表数据虽回灌，但属高危操作且白做）。
 *
 * @returns true 表示确有 category 被旧 CHECK 挡住，需要表级重建
 */
export function mrCatalogIsBuiltinModulesCategoryGateDrifted(host: any, tableSql: string): boolean {
  const seedCategories = Array.from(
    new Set(DEFAULT_CATALOG_SEEDS.map(entry => entry.category).filter(Boolean))
  )
  return seedCategories.some(category => !tableSql.includes(`'${category}'`))
}

/**
 * 表级自愈重建（创世基线漂移，仅供 ensureDefaultSeeds 失败分支调用，严禁扩作通用迁移路径）
 *
 * SQLite 表级 CHECK 于建表时固化，存量库的 builtin_modules 在 GENESIS 扩充约束白名单
 * （如新增 media_enhance 分类）后无法 ALTER，新种子行会被 CHECK 物理拒绝。
 * builtin_modules 为纯派生表（种子元数据 + 本地安装状态），检测到 category 白名单漂移时：
 * 备份本地状态行 → 临时关闭外键（防 DROP 级联清空 resource_downloads 等引用行）→
 * DROP 后按 GENESIS_V1_SCHEMA 全量重建 + 本地状态行回灌（单事务原子，失败整体回滚）→
 * 外键恢复。应用未上线无迁移兼容，GENESIS_V1_SCHEMA 为唯一创世基线。
 *
 * 幂等性由业务结果保证：重建并重试补灌成功后种子行全部在库，下次启动 upsert 不再被拒，
 * failedRows 为空即不会再次进入本方法，无需额外持久化「已自愈」标记。
 *
 * @returns 是否实际执行了重建（category 白名单已完整时返回 false——失败另有原因，不做无谓重建）
 */
export function mrCatalogRebuildBuiltinModulesTableForGenesisDrift(host: any): boolean {
  const db: Database = host.getDb()
  try {
    const tableSql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'builtin_modules'")
        .get() as { sql?: string } | undefined
    )?.sql
    if (!tableSql || !host.isBuiltinModulesCategoryGateDrifted(tableSql)) {
      return false
    }

    // 1. 备份全部模块行（含本地安装状态与用户配置）
    const backupRows = db.prepare('SELECT * FROM builtin_modules').all() as Record<
      string,
      unknown
    >[]
    // 2. 临时关闭外键：DROP 被引用表不得级联清空 resource_downloads / module_resource_downloads 引用行。
    //    pragma 在事务内无效（必须位于事务外），故手动开关并由 finally 兜底恢复。
    db.pragma('foreign_keys = OFF')
    try {
      // 3. DROP + 重建 + 回灌必须单事务原子完成：SQLite 的 DDL 具备事务性，
      //    回灌中途任一行失败即整体回滚、旧表原样保留，严禁留下「表已重建但只回灌了部分行」的破状态
      const rebuildTx = db.transaction(() => {
        db.exec('DROP TABLE builtin_modules')
        // 按创世基线全量重建（IF NOT EXISTS 幂等：仅 builtin_modules 与其索引新建）
        db.exec(GENESIS_V1_SCHEMA)
        // 本地状态行回灌（旧数据行 category 均在新白名单内，逐行原样恢复）
        const insertRow = db.prepare(
          `INSERT OR REPLACE INTO builtin_modules (
              id, kind, version, catalog_version, category, author_code, author_name,
              availability, delist_reason, firecore_cost, total_bytes, catalog_meta_json,
              config_schema, user_config, install_state, selected_variant, install_path,
              installed_at, last_activated_at, user_consent, error_message, config_json,
              capability_slot, slot_policy, backend_type
            ) VALUES (
              @id, @kind, @version, @catalog_version, @category, @author_code, @author_name,
              @availability, @delist_reason, @firecore_cost, @total_bytes, @catalog_meta_json,
              @config_schema, @user_config, @install_state, @selected_variant, @install_path,
              @installed_at, @last_activated_at, @user_consent, @error_message, @config_json,
              @capability_slot, @slot_policy, @backend_type
            )`
        )
        for (const row of backupRows) insertRow.run(row)
      })
      rebuildTx()
    } finally {
      db.pragma('foreign_keys = ON')
    }
    logger.warn(
      LogCategory.SYSTEM,
      `[builtin_modules_schema_drift_healed] 检测到 builtin_modules 表 DDL 落后于创世基线` +
        `（CHECK 白名单固化），已自愈重建并回灌 ${backupRows.length} 行本地状态；` +
        '请重试此前被拒绝的操作'
    )
    return true
  } catch (err) {
    logger.error(
      LogCategory.SYSTEM,
      '[ModularResource] builtin_modules 表级自愈重建失败，请删除本地数据库文件重建:',
      err
    )
    return false
  }
}

/**
 * 启动期同步绑定与表结构自愈调和 (Spec §2.2.4, §2.6)
 *
 * 必须在 `openDatabase()` 之后、`reconcileOnStartup()` 与 `omniService.start()` 之前同步执行：
 * 1. 单资源粒度原子修复偏离 `deriveTargetLocalPath(id)` 的 `target_local_path`；标注未知资源 `unknown_resource`；
 * 2. 清理 `OBSOLETE_SHARED_RESOURCE_IDS` (`sherpa-onnx-runtime`) 绑定与目录；
 * 3. 补齐 `BUILTIN_MODULE_CATALOG_META` 缺失绑定（含存量 `engine_classic_light` 补绑 `mobile-clip` 并保活）；
 * 4. 校验 `ux_exclusive_active_slot` SQL 白名单与 `EXCLUSIVE_CAPABILITY_SLOTS` 双向一致性。
 */
export function mrCatalogReconcileBuiltinModuleBindingsSync(host: any): {
  repairedPaths: string[]
  failedRepairs: string[]
  removedObsolete: string[]
  backfilledBindings: Array<{ moduleId: string; resourceId: string }>
  schemaIndexDriftDetected: boolean
} {
  const db: Database = host.getDb()
  const dao: ModularResourceDao = host.getDao()
  const pluginsRootDir = host.getPluginsRootDir()

  host.repairPendingResources.clear()
  host.unknownResources.clear()
  host.deferredBackfillResources.clear()
  host.schemaIndexDriftDetected = false

  // 若主表读取即抛出 DB 级致命异常，直接上抛阻断 Omni 启动
  dao.modules.listAllSync()
  host.ensureDefaultSeeds()

  const repairedPaths: string[] = []
  const failedRepairs: string[] = []
  const removedObsolete: string[] = []
  const backfilledBindings: Array<{ moduleId: string; resourceId: string }> = []

  // 1. 单资源粒度修复偏离 canonical 的 target_local_path，隔离未知资源与单点失败
  const allResources = dao.resources.listAllSync()
  for (const res of allResources) {
    const canonicalPath = deriveTargetLocalPath(res.resource_id)
    if (canonicalPath) {
      if (res.target_local_path !== canonicalPath) {
        try {
          logger.debug(LogCategory.SYSTEM, '[ModularResource] 修复偏离 SSOT 的 target_local_path', {
            resourceId: res.resource_id,
            oldTargetLocalPath: res.target_local_path,
            canonicalPath
          })
          const singleTx = db.transaction(() => {
            dao.resources.updateTargetLocalPathSync(res.resource_id, canonicalPath)
          })
          singleTx()
          const verified = dao.resources.findByIdSync(res.resource_id)
          if (!verified || verified.target_local_path !== canonicalPath) {
            throw new Error(`post-write verify failed for ${res.resource_id}`)
          }
          repairedPaths.push(res.resource_id)
        } catch (err: any) {
          const msg = err?.message || String(err)
          logger.error(
            LogCategory.SYSTEM,
            `[ModularResource] 单资源 target_local_path 自愈失败，转入 pending_repair: ${res.resource_id}`,
            err
          )
          host.repairPendingResources.add(res.resource_id)
          host.fastReadySnapshot.set(res.resource_id, {
            resourceId: res.resource_id,
            sharedSubDir: resolveSharedSubDir(res.resource_id),
            physicalDir: null,
            status: 'pending_repair',
            validationLevel: 'full',
            reason: msg,
            checkedAt: Date.now()
          })
          failedRepairs.push(res.resource_id)
        }
      }
    } else {
      host.unknownResources.add(res.resource_id)
      try {
        resolvePhysicalPath(pluginsRootDir, res.target_local_path)
      } catch (err: any) {
        logger.error(
          LogCategory.SYSTEM,
          `[ModularResource] 未知资源存在非法相对路径，标记 pending_repair 并拒绝挂载: ${res.resource_id}`,
          err
        )
        host.repairPendingResources.add(res.resource_id)
        host.fastReadySnapshot.set(res.resource_id, {
          resourceId: res.resource_id,
          sharedSubDir: res.resource_id,
          physicalDir: null,
          status: 'unknown_resource',
          validationLevel: 'full',
          reason: err?.message || 'invalid_unknown_resource_path',
          checkedAt: Date.now()
        })
        failedRepairs.push(res.resource_id)
      }
    }
  }

  // 2. 清理遗留废弃资源绑定与物理目录（例如 sherpa-onnx-runtime）
  for (const obsoleteId of OBSOLETE_SHARED_RESOURCE_IDS) {
    try {
      const refRows = db
        .prepare('SELECT module_id FROM module_resource_downloads WHERE resource_id = ?')
        .all(obsoleteId) as Array<{ module_id: string }>
      const targetModules = new Set([
        'asr_sensevoice_onnx',
        'tts_moss_onnx',
        ...refRows.map((r: any) => r.module_id)
      ])

      const cleanTx = db.transaction(() => {
        for (const modId of targetModules) {
          dao.resources.unbindResourceFromModuleSync(modId, obsoleteId)
          const catMeta = BUILTIN_MODULE_CATALOG_META[modId]
          if (catMeta) {
            const totalBytes = computeModuleTotalBytes(catMeta.resourceIds)
            dao.modules.updateTotalBytesAndMetaSync(modId, totalBytes)
          }
        }
        if (dao.resources.getResourceActiveRefCountSync(obsoleteId) === 0) {
          db.prepare('DELETE FROM resource_downloads WHERE resource_id = ?').run(obsoleteId)
        }
      })
      cleanTx()

      if (refRows.length > 0) {
        removedObsolete.push(obsoleteId)
      }

      // 原子隔离 _shared/<obsoleteId> -> _shared/.deleting-<ts>-sherpa
      const sharedDir = PluginPathResolver.getSharedDirForRoot(pluginsRootDir)
      const legacyPhysical = path.join(sharedDir, obsoleteId)
      if (fs.existsSync(legacyPhysical)) {
        const suffix = obsoleteId.includes('sherpa') ? 'sherpa' : obsoleteId
        const tombstoneDir = path.join(sharedDir, `.deleting-${Date.now()}-${suffix}`)
        try {
          fs.renameSync(legacyPhysical, tombstoneDir)
        } catch (renameErr) {
          logger.warn(
            LogCategory.SYSTEM,
            `[ModularResource] 重命名废弃目录 ${legacyPhysical} 失败:`,
            renameErr
          )
        }
      }
    } catch (err) {
      logger.error(LogCategory.SYSTEM, `[ModularResource] 清理废弃资源 ${obsoleteId} 失败:`, err)
    }
  }

  // 3. 补齐 catalog 已知模块资源绑定（含 engine_classic_light -> mobile-clip）并刷新 total_bytes
  for (const [modId, meta] of Object.entries(BUILTIN_MODULE_CATALOG_META)) {
    const modRow = dao.modules.findByIdSync(modId)
    if (!modRow) continue

    try {
      const expectedTotalBytes = computeModuleTotalBytes(meta.resourceIds)
      const resourceSpecs = meta.resourceIds.map(buildResourceSpecFromCatalog)
      let parsedMeta: Record<string, unknown> = {}
      if (modRow.catalog_meta_json) {
        try {
          parsedMeta = JSON.parse(modRow.catalog_meta_json)
        } catch {
          parsedMeta = {}
        }
      }
      const existingResources = dao.resources.findResourcesByModuleSync(modId)
      const existingIds = new Set(existingResources.map((r: any) => r.resource_id))
      const missingIds = meta.resourceIds.filter(id => !existingIds.has(id))

      // 将存量绑定资源的 Catalog 元数据（如 assetName/expectedBytes/expectedSha256）同步至当前 App 权威清单
      for (const resSpec of resourceSpecs) {
        if (existingIds.has(resSpec.resource_id)) {
          dao.resources.syncCatalogMetadataSync(resSpec)
        }
      }

      if (
        modRow.total_bytes !== expectedTotalBytes ||
        missingIds.length > 0 ||
        !Array.isArray(parsedMeta.resources) ||
        parsedMeta.resources.length !== resourceSpecs.length
      ) {
        const updatedMeta = { ...parsedMeta, resources: resourceSpecs }
        dao.modules.updateTotalBytesAndMetaSync(
          modId,
          expectedTotalBytes,
          JSON.stringify(updatedMeta)
        )
      }

      for (const resId of missingIds) {
        const resMeta = BUILTIN_PLUGIN_CATALOG_META[resId]
        const spec = buildResourceSpecFromCatalog(resId)
        const physicallyReady =
          PluginPathResolver.getReadySharedResourceDirForRoot(
            pluginsRootDir,
            resMeta.sharedSubDir,
            {
              requiredFileGroups: resMeta.requiredFileGroups,
              minPrimaryFileBytes: resMeta.minPrimaryFileBytes
            }
          ) !== null
        const initialState = physicallyReady ? 'completed' : 'pending'

        const bindTx = db.transaction(() => {
          const task = dao.resources.createOrGetTaskSync({
            resource_id: spec.resource_id,
            asset_name: spec.asset_name,
            target_local_path: spec.target_local_path,
            active_source_key: spec.active_source_key,
            active_url: spec.active_url,
            expected_bytes: spec.expected_bytes,
            expected_sha256: spec.expected_sha256,
            download_state: initialState
          })
          if (physicallyReady && task.download_state !== 'completed') {
            host.flushProgress(resId, 'completed', spec.expected_bytes)
            dao.resources.markVerifiedSync(resId, true, spec.expected_sha256)
          }
          dao.resources.bindResourceToModuleSync(modId, resId)
        })
        bindTx()

        backfilledBindings.push({ moduleId: modId, resourceId: resId })

        const currentLang = host.getConfigOrchestrator()?.getValue?.('DEFAULT_LANGUAGE') || 'zh-CN'
        const isZh = String(currentLang).toLowerCase().startsWith('zh')
        if (
          !physicallyReady &&
          modId === 'engine_classic_light' &&
          resId === 'mobile-clip' &&
          !isZh &&
          (modRow.install_state === 'active' || modRow.install_state === 'installed_inactive')
        ) {
          host.deferredBackfillResources.add(resId)
        }
      }
    } catch (err) {
      logger.error(LogCategory.SYSTEM, `[ModularResource] 补齐模块绑定失败: ${modId}`, err)
    }
  }

  // 4. 双向校验 ux_exclusive_active_slot SQL 白名单与 EXCLUSIVE_CAPABILITY_SLOTS ([ISS-01])
  try {
    const activeNonMulti = db
      .prepare(
        "SELECT id, capability_slot, slot_policy FROM builtin_modules WHERE install_state = 'active' AND slot_policy != 'multi_active'"
      )
      .all() as Array<{ id: string; capability_slot: string; slot_policy: string }>

    for (const row of activeNonMulti) {
      if (!isExclusiveCapabilitySlot(row.capability_slot)) {
        logger.error(
          LogCategory.SYSTEM,
          `[ModularResource] 运行态槽位契约违规: 模块 ${row.id} (slot_policy=${row.slot_policy}) 的 capability_slot="${row.capability_slot}" 未在 EXCLUSIVE_CAPABILITY_SLOTS 中注册`
        )
      }
    }

    const idxRow = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'ux_exclusive_active_slot'"
      )
      .get() as { sql?: string } | undefined

    if (idxRow?.sql) {
      const sqlSlots = new Set(parseExclusiveSlotsFromIndexSql(idxRow.sql))
      const missingFromIndex = EXCLUSIVE_CAPABILITY_SLOTS.filter(slot => !sqlSlots.has(slot))
      if (missingFromIndex.length > 0) {
        host.schemaIndexDriftDetected = true
        logger.error(
          LogCategory.SYSTEM,
          `[ModularResource] 检测到创世索引定义过期 (ux_exclusive_active_slot 缺少槽位: ${missingFromIndex.join(', ')})，请删除开发库重建`,
          { missingFromIndex }
        )
      }
    }
  } catch (err) {
    logger.warn(LogCategory.SYSTEM, '[ModularResource] 校验唯一索引白名单失败:', err)
  }

  return {
    repairedPaths,
    failedRepairs,
    removedObsolete,
    backfilledBindings,
    schemaIndexDriftDetected: host.schemaIndexDriftDetected
  }
}

/**
 * 为 engine_classic_light 保活场景判断当前语言核心资产是否就绪
 * 中文环境要求 bekko-a8m + chinese-clip；非中文环境要求 bekko-a8m + mobile-clip
 */
export function mrCatalogIsClassicEngineCoreReady(
  host: any,
  boundResources: ResourceDownloadRecord[]
): boolean {
  const currentLang = host.getConfigOrchestrator()?.getValue?.('DEFAULT_LANGUAGE') || 'zh-CN'
  const isZh = String(currentLang).toLowerCase().startsWith('zh')
  const coreIds = isZh ? ['bekko-a8m', 'chinese-clip'] : ['bekko-a8m', 'mobile-clip']
  return coreIds.every(coreId => {
    const res = boundResources.find((r: any) => r.resource_id === coreId)
    if (!res || res.download_state !== 'completed') return false
    try {
      const abs = host.resolvePhysicalPath(res.target_local_path)
      return fs.existsSync(abs)
    } catch {
      return false
    }
  })
}

/**
 * 后台静默补下载伴随资源（如存量 engine_classic_light 缺失的 mobile-clip），完成后热刷新挂载
 */
export function mrCatalogTriggerCompanionBackfill(
  host: any,
  moduleId: string,
  resourceId: BuiltinSharedResourceId
): void {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    return
  }
  const dao: ModularResourceDao = host.getDao()
  const task = dao.resources.findByIdSync(resourceId)
  if (!task || task.download_state === 'completed') return
  if (host.inFlightResources.has(resourceId)) return

  const spec = buildResourceSpecFromCatalog(resourceId)
  const flight = host
    .downloadAndInstallSingleResource(moduleId, task, spec)
    .then(async () => {
      const mod = dao.modules.findByIdSync(moduleId)
      if (mod?.install_state === 'active') {
        await host.notifyRuntimePluginTopologyChanged({
          moduleId,
          reason: 'companion_backfill',
          restartPolicy: 'restart'
        })
      }
    })
    .catch((err: unknown) => {
      logger.warn(
        LogCategory.SYSTEM,
        `[ModularResource] 伴随资源后台补齐失败 (${moduleId}/${resourceId}):`,
        err
      )
    })
    .finally(() => {
      host.inFlightResources.delete(resourceId)
    })

  host.inFlightResources.set(resourceId, flight)
}

/**
 * 同步执行目录元数据更新（内部复用）
 */
export function mrCatalogSyncCatalogSync(
  host: any,
  entries: CatalogModuleEntry[]
): {
  updated: number
  skippedRegression: number
  /** 行级失败明细（存量库表级 CHECK 固化旧白名单等约束拒绝），显式上报严禁静默丢弃 */
  failedRows: Array<{ id: string; error: string }>
} {
  const db: Database = host.getDb()
  const dao: ModularResourceDao = host.getDao()
  let updated = 0
  let skippedRegression = 0
  const failedRows: Array<{ id: string; error: string }> = []

  const tx = db.transaction((items: CatalogModuleEntry[]) => {
    for (const entry of items) {
      // 行级失败隔离铁律：SQLite 表级 CHECK 于建表时固化（如 category 白名单落后于
      // 创世基线扩充），单行约束失败严禁拖垮整批种子补灌（better-sqlite3 事务内
      // catch 不触发回滚）；失败行显式收集，由调用方输出处置指引，严禁静默丢弃
      try {
        const existing = dao.modules.findByIdSync(entry.id)
        const incomingVersion = entry.catalog_version ?? 1
        if (existing && incomingVersion < (existing.catalog_version ?? 1)) {
          logger.warn(
            LogCategory.SYSTEM,
            `[catalog_version_regression] 忽略低版本目录同步: ${entry.id} (remote=${incomingVersion} < local=${existing.catalog_version})`
          )
          skippedRegression++
          continue
        }

        // 构造市场展示元数据 JSON（保存 name, description, icon, resources 定义）
        let existingMeta: Record<string, unknown> = {}
        if (existing?.catalog_meta_json) {
          try {
            existingMeta = JSON.parse(existing.catalog_meta_json)
          } catch {
            existingMeta = {}
          }
        }

        let incomingMeta: Record<string, unknown> = {}
        if (typeof entry.catalog_meta_json === 'string' && entry.catalog_meta_json.trim()) {
          try {
            incomingMeta = JSON.parse(entry.catalog_meta_json)
          } catch {
            incomingMeta = {}
          }
        } else if (entry.catalog_meta_json && typeof entry.catalog_meta_json === 'object') {
          incomingMeta = { ...(entry.catalog_meta_json as Record<string, unknown>) }
        }

        const mergedMeta: Record<string, unknown> = {
          ...existingMeta,
          ...incomingMeta,
          ...(entry.name ? { name: entry.name } : {}),
          ...(entry.description ? { description: entry.description } : {}),
          ...(entry.icon ? { icon: entry.icon } : {}),
          ...(entry.resources ? { resources: entry.resources } : {})
        }

        const configSchemaStr =
          typeof entry.config_schema === 'string'
            ? entry.config_schema
            : entry.config_schema
              ? JSON.stringify(entry.config_schema)
              : (existing?.config_schema ?? null)

        const didUpsert = dao.modules.upsertModuleSync({
          id: entry.id,
          kind: entry.kind ?? existing?.kind ?? 'builtin-module',
          version: entry.version,
          catalog_version: incomingVersion,
          category: entry.category,
          capability_slot: entry.capability_slot ?? existing?.capability_slot ?? 'general',
          slot_policy: entry.slot_policy ?? existing?.slot_policy ?? 'multi_active',
          backend_type: entry.backend_type ?? existing?.backend_type ?? 'omni_onnx',
          author_code: entry.author_code ?? existing?.author_code ?? 'official',
          author_name:
            entry.author_name !== undefined ? entry.author_name : (existing?.author_name ?? null),
          availability: entry.availability ?? existing?.availability ?? 'approved',
          firecore_cost: entry.firecore_cost ?? existing?.firecore_cost ?? 0,
          total_bytes: entry.total_bytes,
          catalog_meta_json: JSON.stringify(mergedMeta),
          config_schema: configSchemaStr,
          // IN-04 铁律：绝不覆盖已存在的本地 install_state、user_config、config_json
          install_state: existing
            ? existing.install_state
            : (entry.install_state ?? 'not_installed'),
          user_config: existing ? existing.user_config : null,
          config_json: existing ? existing.config_json : null,
          selected_variant: existing ? existing.selected_variant : (entry.selected_variant ?? null),
          install_path: existing ? existing.install_path : (entry.install_path ?? null)
        })

        if (didUpsert) {
          updated++
        } else {
          skippedRegression++
        }
      } catch (rowErr) {
        failedRows.push({
          id: entry.id,
          error: rowErr instanceof Error ? rowErr.message : String(rowErr)
        })
      }
    }
  })

  tx(entries)
  return { updated, skippedRegression, failedRows }
}

/**
 * 将数据库记录与关联资源组装为前端可直接消费的 BuiltinModuleView
 */
export function mrCatalogBuildModuleView(
  host: any,
  record: BuiltinModuleRecord
): BuiltinModuleView {
  const dao: ModularResourceDao = host.getDao()
  const resources = dao.resources.findResourcesByModuleSync(record.id)
  const seed = DEFAULT_CATALOG_SEEDS.find((s: any) => s.id === record.id)

  let meta: Record<string, any> = {}
  if (record.catalog_meta_json) {
    try {
      meta = JSON.parse(record.catalog_meta_json)
    } catch {
      meta = {}
    }
  }

  const name = seed?.name || meta.name || record.id
  const description = seed?.description || meta.description || ''
  const icon = seed?.icon || meta.icon

  const isQueuedInBackground =
    record.install_state !== 'active' && host.backgroundInstallQueue.includes(record.id)
  const effectiveInstallState = isQueuedInBackground ? 'downloading' : record.install_state

  const live = host.liveProgress.get(record.id)
  let downloadProgress = live
  if (!downloadProgress && effectiveInstallState === 'downloading' && resources.length > 0) {
    const totalExpected = resources.reduce(
      (acc: number, r: any) => acc + (r.expected_bytes || 0),
      0
    )
    const totalDownloaded = resources.reduce(
      (acc: number, r: any) => acc + (r.downloaded_bytes || 0),
      0
    )
    const percentage =
      totalExpected > 0 ? Math.min(100, Math.round((totalDownloaded / totalExpected) * 100)) : 0
    downloadProgress = {
      percentage,
      speed_bytes_per_sec: 0,
      is_resumed: false
    }
  }

  const contributes = meta.contributes || seed?.contributes
  const isRunning = host.processManager
    ? host.processManager.isRunning(record.id)
    : record.install_state === 'active'
  const isUsable = host.processManager
    ? host.processManager.isUsable(record.id)
    : record.install_state === 'active'
  const holdReasons = host.processManager ? host.processManager.getHoldReasons(record.id) : []

  const devModeEffective = typeof electronApp !== 'undefined' ? !electronApp.isPackaged : true

  // G-02 安装事实严格门禁算法
  const canInstall =
    effectiveInstallState === 'not_installed' && record.availability !== 'coming_soon'
  const canActivate =
    effectiveInstallState === 'installed_inactive' &&
    record.availability !== 'coming_soon' &&
    !(record.availability === 'draft' && !devModeEffective) &&
    record.delist_reason !== 'security_violation' &&
    !holdReasons.includes('slotPreempted')
  const canUninstall =
    effectiveInstallState !== 'not_installed' &&
    (record.slot_policy !== 'exclusive_required' ||
      host.findReadyBackupModulesSync(record).length > 0)

  let validationStatus: BuiltinModuleView['validation_status']
  let validationMessage: string | undefined
  if (host.rootUnavailable && record.install_state === 'active') {
    validationStatus = 'pending_repair'
    validationMessage = '插件存储目录不可达，请检查磁盘连接'
  } else if (resources.length > 0) {
    const snaps = resources
      .map((r: any) => host.fastReadySnapshot.get(r.resource_id))
      .filter((s): s is ResourceValidationEntry => Boolean(s))
    if (snaps.some(s => s.status === 'pending_repair' || s.status === 'unknown_resource')) {
      validationStatus = 'pending_repair'
      validationMessage = '模型损坏需修复'
    } else if (snaps.some(s => s.status === 'pending_validation')) {
      validationStatus = 'pending_validation'
      validationMessage = '正在校验插件'
    } else if (snaps.some(s => s.status === 'legacy_heal')) {
      validationStatus = 'legacy'
    } else if (snaps.length > 0 && snaps.every((s: any) => s.status === 'ready_fast')) {
      validationStatus = 'ready'
    }
  }

  return {
    ...record,
    install_state: effectiveInstallState,
    name,
    description,
    icon,
    is_running: isRunning,
    is_usable: isUsable,
    can_activate: canActivate,
    can_install: canInstall,
    can_uninstall: canUninstall,
    hold_reasons: holdReasons,
    ...(validationStatus ? { validation_status: validationStatus } : {}),
    ...(validationMessage ? { validation_message: validationMessage } : {}),
    resources,
    ...(contributes ? { contributes } : {}),
    ...(downloadProgress ? { download_progress: downloadProgress } : {})
  }
}

/**
 * 解析模块所需的物理资源定义列表
 */
export function mrCatalogResolveModuleResourceSpecs(
  host: any,
  record: BuiltinModuleRecord
): CatalogResourceSpec[] {
  if (record.catalog_meta_json) {
    try {
      const meta = JSON.parse(record.catalog_meta_json)
      if (Array.isArray(meta.resources) && meta.resources.length > 0) {
        return meta.resources
      }
    } catch {
      // ignore
    }
  }
  const seed = DEFAULT_CATALOG_SEEDS.find((s: any) => s.id === record.id)
  if (seed?.resources && seed.resources.length > 0) {
    return seed.resources
  }
  const bound = (host.getDao() as ModularResourceDao).resources.findResourcesByModuleSync(record.id)
  return bound.map((r: any) => ({
    resource_id: r.resource_id,
    asset_name: r.asset_name,
    target_local_path: r.target_local_path,
    active_source_key: (r.active_source_key as 'auto' | 'cn' | 'global') || 'auto',
    active_url: r.active_url ?? undefined,
    expected_bytes: r.expected_bytes,
    expected_sha256: r.expected_sha256
  }))
}
