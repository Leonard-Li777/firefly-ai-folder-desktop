/**
 * ModularResourceService 启动自愈对账 (reconcileOnStartup) 与进度落盘节流逻辑
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
  ModularResourceService,
  LEGACY_HEAL_MARKER_FILENAME,
  hasAnyReadyMarkerFile,
  resolveSharedSubDir,
  parseExclusiveSlotsFromIndexSql,
  mapTaskStatesToModuleState
} from '../system/modular-resource-service-core'

/**
 * 启动期自愈与孤儿清理：
 * 1. 扫描清理遗留的 .tmp-* / .deleting-* / 历史 .tombstone-* 与陈旧 active-mounts-*.json；
 * 2. 清理此前被标记为 pending_delete 且已无模块引用的资源目录与记录；
 * 3. 对账 builtin_modules 与 resource_downloads：保障单资源故障隔离与 engine_classic_light 保活；
 * 4. 执行 OfflinePackage/StartupReconciler 离线自愈。
 */
export async function mrReconcileReconcileOnStartup(host: any): Promise<{
  cleanedTombstones: number
  resetModules: string[]
  resetDownloads: string[]
}> {
  const baseDir = host.getBaseDir()
  const pluginsRootDir = host.getPluginsRootDir()
  const sharedDir = PluginPathResolver.getSharedDirForRoot(pluginsRootDir)

  // 外置慢盘/磁盘不可达时，执行 0ms 保护性短路，严禁破坏性清扫与退档数据库状态
  const parsedRoot = path.parse(pluginsRootDir)
  const rootDriveAvailable = !parsedRoot.root || fs.existsSync(parsedRoot.root)
  if (!rootDriveAvailable) {
    host.rootUnavailable = true
    host.fastReadySnapshot.clear()
    logger.error(
      LogCategory.SYSTEM,
      `[ModularResource] 插件根目录磁盘不可达，保护性跳过清扫并将挂载置空: ${pluginsRootDir}`
    )
    return {
      cleanedTombstones: 0,
      resetModules: [],
      resetDownloads: []
    }
  }
  host.rootUnavailable = false

  let cleanedTombstones = 0
  cleanedTombstones += await cleanOrphanTombstones(baseDir)
  cleanedTombstones += await cleanOrphanTombstones(pluginsRootDir)
  cleanedTombstones += await cleanOrphanTombstones(sharedDir)
  cleanedTombstones += await host.tombstoneGC.reconcileOnStartup([
    baseDir,
    pluginsRootDir,
    sharedDir
  ])

  // 清理应用异常退出残留的 active-mounts-*.json 清单文件（跳过当前进程写入的实时清单，防止并发启动竞态误删触发 os error 2）
  const runDir = path.join(baseDir, 'run')
  const currentPidPrefix = `active-mounts-${process.pid}-`
  if (fs.existsSync(runDir)) {
    try {
      for (const f of fs.readdirSync(runDir)) {
        if (f.startsWith('active-mounts-') && f.endsWith('.json')) {
          if (f.startsWith(currentPidPrefix)) {
            continue
          }
          try {
            fs.unlinkSync(path.join(runDir, f))
            cleanedTombstones++
          } catch {}
        }
      }
    } catch {}
  }

  // B4: 扫描并自愈由于杀软占用或断电未完成的目录切换意图日志、视觉插件事务日志 (.txn.json)
  // 与 _shared/*/.txn.json 共享词表事务日志
  const intentsDir = path.join(baseDir, '.intents')
  await reconcileDirSwitchIntents(intentsDir)
  recoverSharedVisualVocabTxns(path.join(baseDir, '_shared'))
  await host.withSlotMutex('__startup_txn__', () =>
    recoverPendingPluginTxns({
      intentsDir,
      verifyFn: host.resolveDefaultVerifyVisualVocabFn(),
      reloadAssetsFn: host.resolveDefaultReloadAssetsFn()
    })
  )

  // 自愈未完成的插件根目录大迁移意图日志 (Issue 03)
  cleanedTombstones += await host.migrationCoordinatorInstance.reconcileOnStartup(
    baseDir,
    host.getCommittedPluginsRootDir()
  )

  const dao: ModularResourceDao = host.getDao()
  const resetDownloads: string[] = []
  const resetModules: string[] = []

  // 1. 单资源隔离对账物理资源记录
  const allResources = dao.resources.listAllSync()
  for (const res of allResources) {
    if (host.repairPendingResources.has(res.resource_id)) {
      continue
    }

    let targetAbsPath: string
    try {
      targetAbsPath = host.resolvePhysicalPath(res.target_local_path)
    } catch (pathErr: any) {
      logger.error(
        LogCategory.SYSTEM,
        `[ModularResource] 对账阶段检测到非法路径，标为 pending_repair: ${res.resource_id}`,
        pathErr
      )
      host.repairPendingResources.add(res.resource_id)
      host.fastReadySnapshot.set(res.resource_id, {
        resourceId: res.resource_id,
        sharedSubDir: resolveSharedSubDir(res.resource_id),
        physicalDir: null,
        status: 'pending_repair',
        validationLevel: 'full',
        reason: pathErr?.message || 'invalid_target_local_path',
        checkedAt: Date.now()
      })
      continue
    }

    try {
      if (res.download_state === 'pending_delete') {
        const refCount = dao.resources.getResourceActiveRefCountSync(res.resource_id)
        if (refCount === 0) {
          const deleted = await host.deleteDirectoryFn(targetAbsPath)
          if (deleted) {
            dao.resources.deleteResourceSync(res.resource_id)
            cleanedTombstones++
          }
        }
        continue
      }

      if (res.download_state === 'completed' || res.download_state === 'downloading') {
        const exists = fs.existsSync(targetAbsPath)
        if (!exists) {
          const archivePath = host.resolveDownloadArchivePath(res.resource_id, res.asset_name)
          const partPath = `${archivePath}.part`
          if (fs.existsSync(partPath)) {
            const partSize = fs.statSync(partPath).size
            host.flushProgress(res.resource_id, 'paused', partSize)
          } else {
            host.flushProgress(res.resource_id, 'pending', 0)
          }
          resetDownloads.push(res.resource_id)
        }
      } else {
        // 逆向自愈收录：若未标记 completed 但物理目录完整存在（有 .ready 标记或有效文件组），自动逆向收录为 completed
        if (fs.existsSync(targetAbsPath)) {
          const files = fs.readdirSync(targetAbsPath)
          const nonHidden = files.filter(f => !f.startsWith('.'))
          const catalogMeta = (
            BUILTIN_PLUGIN_CATALOG_META as Record<
              string,
              {
                requiredFileGroups?: readonly (readonly string[])[]
                minPrimaryFileBytes?: number
              }
            >
          )[res.resource_id]
          const filesValid = catalogMeta
            ? PluginPathResolver.checkRequiredFileGroupsSync(
                targetAbsPath,
                catalogMeta.requiredFileGroups,
                catalogMeta.minPrimaryFileBytes
              )
            : nonHidden.length > 0
          if (filesValid && (hasAnyReadyMarkerFile(files) || nonHidden.length > 0)) {
            dao.resources.markVerifiedSync(res.resource_id, true, res.expected_sha256 || undefined)
            cleanedTombstones++
          }
        }
      }
    } catch (resErr: any) {
      logger.error(
        LogCategory.SYSTEM,
        `[ModularResource] 单资源启动对账失败，隔离为 pending_repair: ${res.resource_id}`,
        resErr
      )
      host.repairPendingResources.add(res.resource_id)
      host.fastReadySnapshot.set(res.resource_id, {
        resourceId: res.resource_id,
        sharedSubDir: resolveSharedSubDir(res.resource_id),
        physicalDir: null,
        status: 'pending_repair',
        validationLevel: 'full',
        reason: resErr?.message || String(resErr),
        checkedAt: Date.now()
      })
    }
  }

  // 2. 对账模块状态（严守 engine_classic_light 对 mobile-clip 缺失的业务连续性保活）
  const allModules = dao.modules.listAllSync()
  for (const mod of allModules) {
    if (
      mod.install_state === 'active' ||
      mod.install_state === 'installed_inactive' ||
      mod.install_state === 'downloading'
    ) {
      // 关键时序防护：如果模块正处于后台静默安装队列或正在进行安装执行，绝不能在启动对账中重置，保持其生命周期正常完成
      if (
        mod.install_state === 'downloading' &&
        (host.backgroundInstallQueue.includes(mod.id) || host.activeInstallingModuleId === mod.id)
      ) {
        continue
      }

      const boundResources = dao.resources.findResourcesByModuleSync(mod.id)
      let missingPhysical = false
      let needsClassicMobileClipBackfill = false

      if (mod.install_path) {
        try {
          const modAbsPath = host.resolvePhysicalPath(mod.install_path)
          if (!fs.existsSync(modAbsPath)) {
            missingPhysical = true
          }
        } catch {
          missingPhysical = true
        }
      }

      if (boundResources.length > 0) {
        const coreReadyForClassic =
          mod.id === 'engine_classic_light' &&
          (mod.install_state === 'active' || mod.install_state === 'installed_inactive') &&
          host.isClassicEngineCoreReady(boundResources)

        for (const res of boundResources) {
          let resExists = false
          try {
            const resAbsPath = host.resolvePhysicalPath(res.target_local_path)
            resExists = fs.existsSync(resAbsPath)
          } catch {
            resExists = false
          }

          if (res.download_state !== 'completed' || !resExists) {
            const currentLang =
              host.getConfigOrchestrator()?.getValue?.('DEFAULT_LANGUAGE') || 'zh-CN'
            const isZh = String(currentLang).toLowerCase().startsWith('zh')
            // 语言互斥处理：中文环境 mobile-clip 互斥放行；非中文环境 chinese-clip 互斥放行
            if (res.resource_id === 'mobile-clip' && isZh && coreReadyForClassic) {
              continue
            }
            if (res.resource_id === 'chinese-clip' && !isZh && coreReadyForClassic) {
              continue
            }
            if (res.resource_id === 'mobile-clip' && !isZh && coreReadyForClassic) {
              needsClassicMobileClipBackfill = true
              continue
            }
            missingPhysical = true
            break
          }
        }
      } else if (mod.install_state === 'downloading') {
        missingPhysical = true
      }

      if (missingPhysical) {
        dao.modules.updateInstallStateSync(mod.id, 'not_installed')
        resetModules.push(mod.id)
      } else if (needsClassicMobileClipBackfill) {
        host.deferredBackfillResources.add('mobile-clip')
        host.triggerCompanionBackfill('engine_classic_light', 'mobile-clip')
      }
    }
  }

  // 3. 启动期离线总包两阶段对账自愈与后台 Dry-Run 校验队列
  try {
    const { StartupReconciler } = await import('../modular-resource/startup-reconciler')
    const { OfflinePackageDao } = await import('../modular-resource/offline-package-dao')
    const db: Database = host.getDb()
    const offlineDao = new OfflinePackageDao(db)
    const isTestEnv = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST)
    await StartupReconciler.reconcileOnStartup({
      baseDir,
      pluginsRootDir,
      dao: offlineDao,
      db,
      skipDeferredQueue: isTestEnv
    })
  } catch (reconcileErr) {
    logger.warn(LogCategory.SYSTEM, '[ModularResource] 离线总包冷启动对账自愈异常:', reconcileErr)
  }

  // 4. 确保当前激活底座与 ConfigOrchestrator 的 AI_EMBEDDING_PROFILE 强一致
  await host.syncEmbeddingProfileToConfig()

  return {
    cleanedTombstones,
    resetModules,
    resetDownloads
  }
}

/**
 * [Issue 04 收尾] 高频下载进度回调的节流包装（不改底层 SQL）。
 * 内存 liveProgress 始终即时更新，保证 UI 进度平滑；DB 仅在两种情况落盘：
 * ① 状态跃迁（由显式 flushProgress 调用负责，立即写）；
 * ② 距上次落盘 >= 3000ms 且进度字节有实质变化。
 * 并发分块回调可能乱序，取历史最大值防止进度回退。
 */
export function mrReconcileRecordDownloadProgress(
  host: any,
  moduleId: string,
  resourceId: string,
  downloadedBytes: number,
  percentage: number,
  speedBytesPerSec: number,
  isResumed: boolean
): void {
  // 终态闸：资源已进入 completed/failed/cancelled 后，并发分块的迟到回调
  // 不得再把 DB 状态写回 downloading（否则状态跃迁被覆盖、终端节流状态泄漏）。
  const recordedState = host.lastPersistedDownloadState.get(resourceId)
  if (
    recordedState === 'completed' ||
    recordedState === 'failed' ||
    recordedState === 'cancelled' ||
    recordedState === 'pending_delete'
  ) {
    return
  }

  const effectivePercentage = Math.max(percentage, host.lastLivePercentage.get(resourceId) ?? 0)
  host.lastLivePercentage.set(resourceId, effectivePercentage)
  host.liveProgress.set(moduleId, {
    percentage: effectivePercentage,
    speed_bytes_per_sec: speedBytesPerSec,
    is_resumed: isResumed
  })
  const state: DownloadState = 'downloading'
  const prev = host.pendingProgressPersist.get(resourceId)
  const effectiveBytes = Math.max(
    downloadedBytes,
    prev?.bytes ?? 0,
    host.lastPersistedBytes.get(resourceId) ?? 0
  )
  host.pendingProgressPersist.set(resourceId, { bytes: effectiveBytes, state })

  const lastAt = host.lastProgressPersistAt.get(resourceId) ?? 0
  const lastState = host.lastPersistedDownloadState.get(resourceId)
  const intervalElapsed =
    Date.now() - lastAt >= (ModularResourceService as any).PROGRESS_PERSIST_INTERVAL_MS
  // 状态跃迁必须立即落盘，避免崩溃丢状态；稳态进度按 3000ms 节流。
  const stateChanged = lastState !== undefined && lastState !== state
  // 用「已落盘字节」而非 pending 判据：flush 后 pending 被清空，若仅判 prev===undefined，
  // 满 3000ms 但进度未变也会重复写盘，违背「>=3000ms 且字节有实质变化」契约。
  const bytesChanged = host.lastPersistedBytes.get(resourceId) !== effectiveBytes
  if (stateChanged || (intervalElapsed && bytesChanged)) {
    host.flushProgress(resourceId)
  }
}
