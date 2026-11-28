/**
 * ModularResourceService 离线包导出、Tombstone 查询与重启请求入口
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
import {
  mrQueryGetModule,
  mrQueryGetActiveModuleBySlot,
  mrQueryDeactivateModule,
  mrQueryActivateModule,
  mrQueryListModules,
  mrQuerySyncCatalog
} from './modular-resource-queries'

/**
 * 依据资源下载任务状态列表映射上层模块安装状态 (ISS-09 / Ticket 04)
 */
export function mapTaskStatesToModuleState(
  tasks: readonly ResourceDownloadRecord[]
): ModuleInstallState {
  if (tasks.length === 0) return 'not_installed'

  // 1. 若所有关联资源任务均处于 completed，模块确立为 active
  if (tasks.every(t => t.download_state === 'completed')) {
    return 'active'
  }

  // 2. 若存在任何任务正在进行中，模块呈现 downloading
  if (
    tasks.some(t =>
      ['downloading', 'verifying', 'extracting', 'pending'].includes(t.download_state)
    )
  ) {
    return 'downloading'
  }

  // 3. 若存在失败且无在途任务，呈现 error
  if (tasks.some(t => t.download_state === 'failed')) {
    return 'error'
  }

  // 4. paused / cancelled 映射为 not_installed (保留本地断点进度)
  return 'not_installed'
}

export const LEGACY_HEAL_MARKER_FILENAME = `${LEGACY_READY_MARKER_PREFIX}legacy.json`

export function hasAnyReadyMarkerFile(files: string[]): boolean {
  return files.some(
    f =>
      f === READY_MARKER_FILENAME ||
      (f.startsWith(LEGACY_READY_MARKER_PREFIX) && f.endsWith('.json'))
  )
}

export function resolveSharedSubDir(resourceId: string): string {
  const meta = (BUILTIN_PLUGIN_CATALOG_META as Record<string, { sharedSubDir?: string }>)[
    resourceId
  ]
  return meta?.sharedSubDir ?? resourceId
}

/**
 * 解析 `ux_exclusive_active_slot` SQL 索引中的 `IN (...)` 白名单槽位
 */
export function parseExclusiveSlotsFromIndexSql(sql: string | undefined | null): string[] {
  if (!sql) return []
  const match = sql.match(/capability_slot\s+IN\s*\(([^)]+)\)/i)
  if (!match || !match[1]) return []
  return match[1]
    .split(',')
    .map(part => part.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
}

import type { IModularResourceService } from './modular-resource-types'
import { ModularResourceService } from '../system/modular-resource-service-core'

export async function mrOfflineExportOfflinePackage(
  host: any,
  moduleId: string,
  targetFilePath: string,
  options?: { signerPrivateKey?: string }
): Promise<string> {
  return host.offlinePackageService.exportOfflinePackage(moduleId, targetFilePath, options)
}

/**
 * 导出全量离线插件总包 (.ffbundle)
 * 对接 OfflineBundleExporter（官方公钥强校验 + 流式 SHA-256 + 原子刷盘）。
 *
 * ⚠️ 设计边界（详见 docs/specs/plugin-center-offline-package-and-environment-visibility-spec.md §2.1.1）：
 * 本方法是「构建期/开发者模式(isDev)专用」能力，生产环境 UI 已物理隐藏导出入口。
 * 仅通过「离线包导入」落地的官方签名模块可被导出；「插件中心在线装」模块因 CDN 散装下载
 * 不携带官方 manifest.sig，会在 getExportableModules 的签名铁律处被跳过，从而返回 EMPTY_SOURCE
 * （提示文案「请先在插件中心下载所需插件」在在线装场景下具误导性，属已知现象，非缺陷）。
 * 客户端永不持有官方私钥，无法为在线装资源补签——在线导出不作为面向终端用户的功能提供。
 */
export async function mrOfflineExportOfflineBundle(
  host: any,
  targetFilePath: string,
  options?: { rootPublicKey?: string; producerAppVersion?: string }
): Promise<string> {
  host.ensureDefaultSeeds()
  const db: Database = host.getDb()
  const dao: ModularResourceDao = host.getDao()
  const pluginsRootDir = host.getPluginsRootDir()

  const { OfflinePackageDao } = await import('../modular-resource/offline-package-dao')
  const { OfflineBundleExporter } = await import('../modular-resource/offline-bundle-exporter')
  const offlineDao = new OfflinePackageDao(db)

  const exporter = new OfflineBundleExporter({
    dao: offlineDao,
    modulesSharedDir: path.join(pluginsRootDir, '_shared'),
    getExportableModules: async () => {
      const allModules = dao.modules.listAllSync({ includeDraft: false })
      const exportable = []
      for (const mod of allModules) {
        if (mod.install_state !== 'active' && mod.install_state !== 'installed_inactive') {
          continue
        }
        const bound = dao.resources.findResourcesByModuleSync(mod.id)
        if (bound.length === 0 || bound.some((r: any) => r.download_state !== 'completed')) {
          continue
        }
        const ssotManifestDir = PluginPathResolver.getModuleManifestDirForRoot(
          pluginsRootDir,
          mod.id
        )
        const legacyManifestDir = path.join(pluginsRootDir, '_shared', mod.id)
        const manifestDir = fs.existsSync(path.join(ssotManifestDir, 'manifest.sig'))
          ? ssotManifestDir
          : legacyManifestDir
        const manifestPath = path.join(manifestDir, 'manifest.json')
        const sigPath = path.join(manifestDir, 'manifest.sig')

        // 在线散装下载模块若不具备官方原签清单，优雅跳过并记录日志，严禁伪造签名或中断其他已签名官方模块导出
        if (!fs.existsSync(manifestPath) || !fs.existsSync(sigPath)) {
          logger.debug(
            LogCategory.SYSTEM,
            `[ModularResource] 模块 ${mod.id} 缺少官方清单/签名凭证 (${manifestDir})，已跳过离线总包打包`
          )
          continue
        }

        // 读取签名清单内的 resource 元数据，避免误拿在线 .zip 归档哈希比对已解压目录哈希
        const manifestResourceMap = new Map<
          string,
          { asset_name?: string; expected_sha256?: string }
        >()
        try {
          const parsedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
            resources?: Array<{
              resource_id?: string
              asset_name?: string
              expected_sha256?: string
            }>
          }
          if (Array.isArray(parsedManifest.resources)) {
            for (const mr of parsedManifest.resources) {
              if (mr.resource_id) {
                manifestResourceMap.set(mr.resource_id, mr)
              }
            }
          }
        } catch (parseErr) {
          logger.warn(
            LogCategory.SYSTEM,
            `[ModularResource] 读取模块 ${mod.id} 清单 JSON 失败，交由导出验签器终裁:`,
            parseErr
          )
        }

        exportable.push({
          id: mod.id,
          version: mod.version,
          install_state: mod.install_state,
          manifestPath,
          sigPath,
          resources: bound.map(res => {
            const signedRes = manifestResourceMap.get(res.resource_id)
            return {
              resource_id: res.resource_id,
              asset_name: signedRes?.asset_name || res.asset_name,
              // 统一基于 pluginsRootDir 解析规范物理路径，杜绝非 _shared/ 相对路径在 Exporter 内分叉错拼
              target_local_path: host.resolvePhysicalPath(res.target_local_path),
              expected_sha256: signedRes?.expected_sha256 || undefined,
              size: res.expected_bytes ?? undefined
            }
          })
        })
      }
      return exportable
    }
  })

  const res = await exporter.exportOfflineBundle({
    targetPath: targetFilePath,
    producerAppVersion: options?.producerAppVersion,
    rootPublicKey: options?.rootPublicKey
  })
  return res.filePath
}

export function mrOfflineGetPendingTombstones(host: any): PendingDeletionItem[] {
  return host.tombstoneGC.getPendingDeletions()
}

export function mrOfflineHasPendingTombstones(host: any): boolean {
  return host.tombstoneGC.hasPendingDeletions()
}

export function mrOfflineRequestRestart(host: any): void {
  host.tombstoneGC.requestAppRestart()
}
