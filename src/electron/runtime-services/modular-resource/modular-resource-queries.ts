/**
 * ModularResourceService 目录查询、增量同步与槽位启停委托入口
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
import { ModuleSizeCalculator } from './module-size-calculator'
import { calculateDirBytesAsync } from './workers/module-size-worker'
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
  mrStateSyncCpuEngineStateToConfig,
  mrStateSyncEmbeddingProfileToConfig,
  mrStateExecuteUpdateModuleState
} from './modular-resource-state-executor'
import {
  mrInstallerUninstallModule,
  mrInstallerFindReadyBackupModulesSync,
  mrInstallerAssertModuleResourcesReadyForActivation,
  mrInstallerStopOmniProcessForUninstall,
  mrInstallerDownloadAndInstallSingleResource,
  mrInstallerProcessBackgroundInstallQueue,
  mrInstallerEnqueueBackgroundInstalls,
  mrInstallerInstallModule
} from './modular-resource-installer'
import {
  mrCatalogResolveModuleResourceSpecs,
  mrCatalogBuildModuleView,
  mrCatalogSyncCatalogSync,
  mrCatalogTriggerCompanionBackfill,
  mrCatalogIsClassicEngineCoreReady,
  mrCatalogReconcileBuiltinModuleBindingsSync,
  mrCatalogRebuildBuiltinModulesTableForGenesisDrift,
  mrCatalogIsBuiltinModulesCategoryGateDrifted,
  mrCatalogEnsureDefaultSeeds
} from './modular-resource-catalog'
import {
  mrBarrierNotifyRuntimePluginTopologyChanged,
  mrBarrierGetMountableResourcesSnapshot,
  mrBarrierProcessBackgroundVerification,
  mrBarrierScheduleBackgroundFullVerification,
  mrBarrierRunFastReadyBarrier
} from './modular-resource-barrier'
import {
  mrPreflightCheckL2LocalPresetPreflight,
  mrPreflightIsolateCorruptDirectory,
  mrPreflightCheckL1TargetDirPreflight,
  mrPreflightLoadResourceBom,
  mrPreflightLoadBomFilesForResource,
  mrPreflightGetCandidateBomPaths,
  mrPreflightEnsureVerified
} from './modular-resource-preflight'
import {
  mrDirCleanupOldPluginDirectory,
  mrDirCancelDirMigration,
  mrDirApplyInitialPluginDirectory,
  mrDirChangePluginDirectory,
  mrDirGetPluginDirInfo,
  mrDirValidatePluginDir
} from './modular-resource-dir-manager'
import {
  mrReconcileReconcileOnStartup,
  mrReconcileRecordDownloadProgress
} from './modular-resource-reconcile'
import { ModularResourceService } from '../system/modular-resource-service-core'

/**
 * 增量同步插件目录元数据（满足 IN-04：remote.catalog_version < local.catalog_version 时忽略并告警；离线静默兜底）
 */
export async function mrQuerySyncCatalog(
  host: any,
  entries: CatalogModuleEntry[]
): Promise<{
  updated: number
  skippedRegression: number
  failedRows: Array<{ id: string; error: string }>
}> {
  try {
    const targetEntries =
      Array.isArray(entries) && entries.length > 0 ? entries : DEFAULT_CATALOG_SEEDS
    return host.syncCatalogSync(targetEntries)
  } catch (err) {
    logger.warn(LogCategory.SYSTEM, '[ModularResource] 同步目录异常，静默兜底本地内置种子:', err)
    try {
      return host.syncCatalogSync(DEFAULT_CATALOG_SEEDS)
    } catch {
      return { updated: 0, skippedRegression: 0, failedRows: [] }
    }
  }
}

/**
 * 获取模块完整视图列表（支持 scope: 'market' | 'installed' 过滤）
 */
export function mrQueryListModules(
  host: any,
  filter?: {
    scope?: 'market' | 'installed'
    category?: string
    includeDraft?: boolean
  }
): BuiltinModuleView[] {
  host.ensureDefaultSeeds()
  const dao: ModularResourceDao = host.getDao()
  const devModeEffective = typeof electronApp !== 'undefined' ? !electronApp.isPackaged : true
  const includeDraft = filter?.includeDraft ?? devModeEffective

  const records = dao.modules.listAllSync({
    scope: filter?.scope ?? 'market',
    category: filter?.category,
    includeDraft
  })

  // 按照内置种子顺序优先排列，其余按 ID 排序
  const seedOrder = new Map(DEFAULT_CATALOG_SEEDS.map((s, idx) => [s.id, idx]))
  records.sort((a: any, b: any) => {
    const idxA = seedOrder.has(a.id) ? seedOrder.get(a.id)! : 999
    const idxB = seedOrder.has(b.id) ? seedOrder.get(b.id)! : 999
    if (idxA !== idxB) return idxA - idxB
    return a.id.localeCompare(b.id)
  })

  return records.map((r: any) => host.buildModuleView(r))
}

/**
 * 激活指定模块（针对排他槽位自动停用同槽位其他模块）
 */
export async function mrQueryActivateModule(
  host: any,
  moduleId: string
): Promise<BuiltinModuleView> {
  return host.updateModuleState(moduleId, { active: true })
}

/**
 * 停用指定模块（若处于 exclusive_required 且激活状态则拒绝并抛出 SLOT_REQUIRED_EMPTY）
 */
export async function mrQueryDeactivateModule(
  host: any,
  moduleId: string
): Promise<BuiltinModuleView> {
  return host.updateModuleState(moduleId, { active: false })
}

/**
 * 按能力槽位查询当前激活的模块（若无激活返回 null）
 */
export function mrQueryGetActiveModuleBySlot(
  host: any,
  slot: PluginCapabilitySlot
): BuiltinModuleView | null {
  host.ensureDefaultSeeds()
  const dao: ModularResourceDao = host.getDao()
  const row = dao.modules.findActiveBySlotSync(slot)
  if (!row) return null
  return host.buildModuleView(row)
}

export function mrQueryGetModule(host: any, moduleId: string): BuiltinModuleView | null {
  host.ensureDefaultSeeds()
  const dao: ModularResourceDao = host.getDao()
  const row = dao.modules.findByIdSync(moduleId)
  if (!row) return null
  return host.buildModuleView(row)
}
