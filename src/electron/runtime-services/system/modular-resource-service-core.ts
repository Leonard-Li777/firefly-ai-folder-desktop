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
} from './visual-vocab-txn'

export type { PluginCapabilitySlot, SlotPolicy, BackendType, EmbeddingEpochRecord }
import { PluginProcessManager, getPluginProcessManager } from './plugin-process-manager'
import {
  TombstoneGCService,
  tombstoneGCService,
  OfflinePackageService,
  offlinePackageService,
  type PendingDeletionItem
} from '../modular-resource'
import { ModuleSizeCalculator } from '../modular-resource/module-size-calculator'
import { calculateDirBytesAsync } from '../modular-resource/workers/module-size-worker'
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
} from './file-download-service'
import {
  validatePluginDirectory,
  probeDirectoryWritableAndSpace,
  getDiskFreeSpace,
  ModularResourceError,
  RESERVED_DEVICE_REG,
  isReservedDeviceName,
  resolvePhysicalPath
} from './plugin-dir-validator'
import {
  dirMigrationCoordinator,
  DirMigrationCoordinator,
  type DirMigrationProgressPayload
} from './dir-migration-coordinator'
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
} from './types'
import {
  RuntimeTopologyCoordinator,
  runtimeTopologyCoordinator
} from './runtime-topology-coordinator'
import { DEFAULT_CATALOG_SEEDS } from './catalog-seeds'
import { emitRuntimeContextChange } from './workspace-runtime-context-bus'
import {
  mrStateSyncCpuEngineStateToConfig,
  mrStateSyncEmbeddingProfileToConfig,
  mrStateExecuteUpdateModuleState
} from '../modular-resource/modular-resource-state-executor'
import {
  mrInstallerUninstallModule,
  mrInstallerFindReadyBackupModulesSync,
  mrInstallerAssertModuleResourcesReadyForActivation,
  mrInstallerStopOmniProcessForUninstall,
  mrInstallerDownloadAndInstallSingleResource,
  mrInstallerProcessBackgroundInstallQueue,
  mrInstallerEnqueueBackgroundInstalls,
  mrInstallerInstallModule
} from '../modular-resource/modular-resource-installer'
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
} from '../modular-resource/modular-resource-catalog'
import {
  mrBarrierNotifyRuntimePluginTopologyChanged,
  mrBarrierGetMountableResourcesSnapshot,
  mrBarrierProcessBackgroundVerification,
  mrBarrierScheduleBackgroundFullVerification,
  mrBarrierRunFastReadyBarrier
} from '../modular-resource/modular-resource-barrier'
import {
  mrPreflightCheckL2LocalPresetPreflight,
  mrPreflightIsolateCorruptDirectory,
  mrPreflightCheckL1TargetDirPreflight,
  mrPreflightLoadResourceBom,
  mrPreflightLoadBomFilesForResource,
  mrPreflightGetCandidateBomPaths,
  mrPreflightEnsureVerified
} from '../modular-resource/modular-resource-preflight'
import {
  mrDirCleanupOldPluginDirectory,
  mrDirCancelDirMigration,
  mrDirApplyInitialPluginDirectory,
  mrDirChangePluginDirectory,
  mrDirGetPluginDirInfo,
  mrDirValidatePluginDir
} from '../modular-resource/modular-resource-dir-manager'
import {
  mrReconcileReconcileOnStartup,
  mrReconcileRecordDownloadProgress
} from '../modular-resource/modular-resource-reconcile'
import {
  mrQueryGetModule,
  mrQueryGetActiveModuleBySlot,
  mrQueryDeactivateModule,
  mrQueryActivateModule,
  mrQueryListModules,
  mrQuerySyncCatalog
} from '../modular-resource/modular-resource-queries'

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

import type { IModularResourceService } from '../modular-resource/modular-resource-types'
import {
  mrOfflineExportOfflineBundle,
  mrOfflineExportOfflinePackage,
  mrOfflineRequestRestart,
  mrOfflineHasPendingTombstones,
  mrOfflineGetPendingTombstones
} from '../modular-resource/modular-resource-offline'
export type { IModularResourceService } from '../modular-resource/modular-resource-types'

export interface ModularResourceServiceOptions {
  db?: Database
  baseDir?: string
  pluginsRootDir?: string
  presetDir?: string
  downloadService?: FileDownloadService
  transport?: IDownloadTransport
  deleteDirectoryFn?: (dirPath: string) => Promise<boolean>
  tombstoneGC?: TombstoneGCService
  offlinePackageService?: OfflinePackageService
  processManager?: PluginProcessManager
  onTopologyChanged?: TopologyChangeHandler
  verifyVisualVocabFn?: VerifyVisualVocabFn
  reloadAssetsFn?: ReloadAssetsFn
}

export class ModularResourceService implements IModularResourceService {
  private static instance: ModularResourceService | null = null

  public readonly processManager: PluginProcessManager
  private customDb: Database | null = null
  private customBaseDir: string | null = null
  private customPluginsRootDir: string | null = null
  private customPresetDir: string | null = null
  private customDbGetter?: () => Database | null
  private downloadService: FileDownloadService
  private transport?: IDownloadTransport
  private deleteDirectoryFn: (dirPath: string) => Promise<boolean>
  private tombstoneGC: TombstoneGCService
  private offlinePackageService: OfflinePackageService
  private customVerifyVisualVocabFn?: VerifyVisualVocabFn
  private customReloadAssetsFn?: ReloadAssetsFn
  private inFlightResources = new Map<string, Promise<void>>()
  private liveProgress = new Map<
    string,
    { percentage: number; speed_bytes_per_sec: number; is_resumed: boolean }
  >()
  /** [Issue 04 收尾] 进度落盘节流间隔：高频回调只更内存，DB 至少间隔 3000ms 才写（状态跃迁不受限） */
  private static readonly PROGRESS_PERSIST_INTERVAL_MS = 3000
  /** 距上次真正落盘的时间戳（按 resourceId） */
  private lastProgressPersistAt = new Map<string, number>()
  /** 最近一次已落盘状态（按 resourceId），用于识别状态跃迁 */
  private lastPersistedDownloadState = new Map<string, DownloadState>()
  /** 最近一次已落盘字节数（按 resourceId），防乱序回调让进度回退 */
  private lastPersistedBytes = new Map<string, number>()
  /** 按 resourceId 记录的历史最大 UI 百分比，防乱序/跨节流窗口进度条回退 */
  private lastLivePercentage = new Map<string, number>()
  /** 尚未落盘的最新进度（按 resourceId），供 flushProgress 强制落盘 */
  private pendingProgressPersist = new Map<
    string,
    { bytes: number; state: DownloadState; errorMessage?: string }
  >()
  private seeded = false
  private corruptedPresetCache = new Map<string, boolean>()
  private resourceBomOverrides = new Map<
    string,
    Array<{ name: string; size: number; sha256: string }>
  >()
  private verificationPromises = new Map<string, Promise<boolean>>()
  public readonly sourceRouter: DualTrackSourceRouter = new DualTrackSourceRouter()

  private effectivePluginsRootDir: string | null = null
  private dirRuntimePhase: DirRuntimePhase = 'STABLE'
  private moduleSizeCalculator = new ModuleSizeCalculator()
  private oldDirCleanupDismissed = false
  private injectedConfigOrchestrator?: any
  private slotLocks = new Map<string, Promise<unknown>>()
  private readonly topologyCoordinator = new RuntimeTopologyCoordinator()
  private topologyListener: TopologyChangeHandler | null = null
  private fastReadySnapshot = new Map<string, ResourceValidationEntry>()
  private repairPendingResources = new Set<string>()
  private unknownResources = new Set<string>()
  private deferredBackfillResources = new Set<string>()
  private rootUnavailable = false
  private schemaIndexDriftDetected = false
  private bgVerificationInFlight: Promise<void> | null = null
  private bgVerificationTimer: NodeJS.Timeout | null = null
  private backgroundInstallQueue: string[] = []
  private isProcessingBackgroundQueue = false
  private activeInstallingModuleId: string | null = null
  private backgroundProgressBroadcaster?: (event: ModuleDownloadProgressEvent) => void

  /**
   * 槽位排他事务单写者互斥锁 (Spec §3.1)
   * 路由至统一 RuntimeTopologyCoordinator 单锁链，防跨槽位拓扑重入死锁并保持 slotLocks 追踪语义
   */
  public async withSlotMutex<T>(slot: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.slotLocks.get(slot) ?? Promise.resolve()
    let resolveCurrent!: () => void
    const current = new Promise<void>(resolve => {
      resolveCurrent = resolve
    })
    const tail = prev
      .catch(() => {})
      .then(() => this.topologyCoordinator.execute(fn))
      .finally(() => {
        resolveCurrent()
        if (this.slotLocks.get(slot) === tail) {
          this.slotLocks.delete(slot)
        }
      })
    this.slotLocks.set(slot, tail)
    return tail
  }

  public setConfigOrchestrator(orchestrator: any): void {
    this.injectedConfigOrchestrator = orchestrator
  }

  private getConfigOrchestrator(): any {
    if (this.injectedConfigOrchestrator) {
      return this.injectedConfigOrchestrator
    }
    try {
      const { ConfigOrchestrator } = require('../../config/config-orchestrator')
      return ConfigOrchestrator.getInstance()
    } catch {
      return null
    }
  }

  constructor(options?: ModularResourceServiceOptions) {
    this.customDb = options?.db ?? null
    this.customBaseDir = options?.baseDir ?? null
    this.customPluginsRootDir = options?.pluginsRootDir
      ? path.resolve(options.pluginsRootDir)
      : null
    this.customPresetDir = options?.presetDir ?? null
    this.downloadService = options?.downloadService ?? fileDownloadService
    this.transport = options?.transport
    this.deleteDirectoryFn = options?.deleteDirectoryFn ?? safeDeleteDirectory
    this.tombstoneGC = options?.tombstoneGC ?? tombstoneGCService
    try {
      const persistenceFile = path.join(this.getBaseDir(), 'modules', '_pending_tombstones.json')
      this.tombstoneGC.setPersistenceFile(persistenceFile)
    } catch {
      // ignore
    }
    this.offlinePackageService = options?.offlinePackageService ?? new OfflinePackageService(this)
    this.topologyListener = options?.onTopologyChanged ?? null
    this.customVerifyVisualVocabFn = options?.verifyVisualVocabFn
    this.customReloadAssetsFn = options?.reloadAssetsFn
    this.processManager =
      options?.processManager ??
      new PluginProcessManager({
        getDao: () => this.getDao()
      })

    // ISS-15: 应用启动后延迟 15 秒后台扫描清理超过 7 天的 .trash-* 与未完成孤儿断点
    const maintenanceTimer = setTimeout(() => {
      try {
        const base = this.getBaseDir()
        cleanOldTrashAndOrphanParts(base).catch(() => {})
      } catch {}
      try {
        const rootDir = this.getPluginsRootDir()
        cleanOldTrashAndOrphanParts(rootDir).catch(() => {})
      } catch {}
    }, 15000)
    maintenanceTimer.unref?.()
  }

  /**
   * 注入或替换运行时拓扑变化监听器（由 OmniService / 集成测试注入）
   */
  public setTopologyChangeHandler(handler: TopologyChangeHandler | null): void {
    this.topologyListener = handler
  }

  private resolveDefaultVerifyVisualVocabFn(): VerifyVisualVocabFn | undefined {
    if (this.customVerifyVisualVocabFn) {
      return this.customVerifyVisualVocabFn
    }
    try {
      const { omniService } = require('./omni-service')
      const exePath = omniService?.resolveOmniExecutable?.()
      if (!exePath) {
        return undefined
      }
      return (dirPath, encoderId) =>
        verifyVisualVocabWithOmniCli(dirPath, encoderId, { executablePath: exePath })
    } catch {
      return undefined
    }
  }

  private resolveDefaultReloadAssetsFn(): ReloadAssetsFn | undefined {
    if (this.customReloadAssetsFn) {
      return this.customReloadAssetsFn
    }
    try {
      const { omniService } = require('./omni-service')
      if (omniService?.isServiceReady?.()) {
        return () => omniService.reloadVisualAssets()
      }
      return undefined
    } catch {
      return undefined
    }
  }

  /**
   * 409/stale 本地优先单锁对账入口（Spec v2.12 §3.3 / Ticket 08-09）：
   * 1. 与安装/切换/卸载共用 `withSlotMutex` 单锁链；
   * 2. 第一步固定执行本地同源复验（通过则零联网补写 `.ready.json` 并 `reload`）；
   * 3. 磁盘与 catalog  hashes 一致却被引擎判不兼容 ➔ 返回 `diskMatchesCatalog: true` 暴露发布契约缺陷。
   */
  private async writeReadyMarkerGuardedForVisual(
    targetDir: string,
    resourceId: string,
    sharedSubDir: string,
    opts?: { skipDigest?: boolean }
  ): Promise<boolean> {
    const isVisual = isVisualVocabPluginResource(resourceId)
    const hasLocalVocab = hasLocalVisualVocabFiles(targetDir)
    const catalogEntry = (BUILTIN_PLUGIN_CATALOG_META as Record<string, any>)[resourceId]
    if (!isVisual && !(catalogEntry?.encoderId && hasLocalVocab)) {
      await writePluginReadyMarkerWithVisualVocab(targetDir, {
        resourceId,
        sharedSubDir,
        skipDigest: opts?.skipDigest
      })
      return true
    }

    const vMeta = getVisualVocabCatalogMeta(resourceId)
    if (vMeta) {
      const matrixPath = path.join(targetDir, vMeta.matrixFileName)
      const metaPath = path.join(targetDir, vMeta.metaFileName)
      if (!fs.existsSync(matrixPath) || !fs.existsSync(metaPath)) {
        logger.warn(
          LogCategory.SYSTEM,
          `[ModularResource] 视觉词表文件缺失，拒绝写 .ready.json: ${resourceId}`
        )
        return false
      }
      try {
        if (
          computeFileSha256Sync(matrixPath).toLowerCase() !== vMeta.matrixSha256.toLowerCase() ||
          computeFileSha256Sync(metaPath).toLowerCase() !== vMeta.metaSha256.toLowerCase()
        ) {
          logger.warn(
            LogCategory.SYSTEM,
            `[ModularResource] 视觉词表 SHA-256 与 catalog 失配，拒绝写 .ready.json: ${resourceId}`
          )
          return false
        }
      } catch {
        return false
      }
    }

    const verifyFn = this.resolveDefaultVerifyVisualVocabFn()
    const targetEncoderId =
      getVisualVocabEncoderId(resourceId) ??
      (typeof catalogEntry?.encoderId === 'number' ? catalogEntry.encoderId : undefined)
    if (verifyFn) {
      const verifyRes = await verifyFn(targetDir, targetEncoderId)
      if (verifyRes.ok) {
        await writePluginReadyMarkerWithVisualVocab(targetDir, {
          resourceId,
          sharedSubDir,
          verifyRes,
          skipDigest: opts?.skipDigest
        })
        return true
      }
      if (verifyRes.code !== 'OMNI_BINARY_UNAVAILABLE') {
        logger.warn(
          LogCategory.SYSTEM,
          `[ModularResource] 视觉词表 CLI 同源校验失败，拒绝写 .ready.json (${resourceId}): ${verifyRes.error || verifyRes.code}`
        )
        return false
      }
    }

    let isPackaged = false
    try {
      isPackaged = Boolean(electronApp?.isPackaged)
    } catch {
      isPackaged = false
    }
    if (isPackaged) {
      logger.warn(
        LogCategory.SYSTEM,
        `[ModularResource] 打包环境缺少视觉校验程序，fail-closed 拒绝写 .ready.json: ${resourceId}`
      )
      return false
    }

    logger.warn(
      LogCategory.SYSTEM,
      `[ModularResource] 非打包环境未运行视觉校验，仅写基础 .ready.json（省略 visualVocab 契约块）: ${resourceId}`
    )
    await invalidateReadyMarkers(targetDir)
    const digestResult = opts?.skipDigest ? undefined : await computeDirectoryReadyDigest(targetDir)
    await writeReadyMarker(targetDir, { resourceId, sharedSubDir, digestResult })
    return true
  }

  public async reconcileVisualVocabResource(
    resourceId: string,
    opts?: { skipDownload?: boolean; forceDownload?: boolean }
  ): Promise<{ ok: boolean; diskMatchesCatalog?: boolean; error?: string }> {
    return this.withSlotMutex(resourceId, async () => {
      const dao = this.getDao()
      const resRecord = dao.resources.findByIdSync(resourceId)
      const sharedSubDir = resolveSharedSubDir(resourceId)
      const relPath = resRecord?.target_local_path || `modules/_shared/${sharedSubDir}`
      const targetDir = this.resolvePhysicalPath(relPath)
      const vMeta = getVisualVocabCatalogMeta(resourceId)
      const catalogEntry = (BUILTIN_PLUGIN_CATALOG_META as Record<string, any>)[resourceId]
      const hasLocalVocab = fs.existsSync(targetDir) && hasLocalVisualVocabFiles(targetDir)
      const needsVisualVerify =
        isVisualVocabPluginResource(resourceId) ||
        (typeof catalogEntry?.encoderId === 'number' && hasLocalVocab)
      const expectedEncoderId =
        getVisualVocabEncoderId(resourceId) ??
        (typeof catalogEntry?.encoderId === 'number' ? catalogEntry.encoderId : undefined)

      let diskMatchesCatalog = false
      if (vMeta && fs.existsSync(targetDir)) {
        const matrixPath = path.join(targetDir, vMeta.matrixFileName)
        const metaPath = path.join(targetDir, vMeta.metaFileName)
        if (fs.existsSync(matrixPath) && fs.existsSync(metaPath)) {
          try {
            diskMatchesCatalog =
              computeFileSha256Sync(matrixPath).toLowerCase() ===
                vMeta.matrixSha256.toLowerCase() &&
              computeFileSha256Sync(metaPath).toLowerCase() === vMeta.metaSha256.toLowerCase()
          } catch {
            diskMatchesCatalog = false
          }
        }
      }

      if (!opts?.forceDownload && fs.existsSync(targetDir)) {
        const verifyFn = this.resolveDefaultVerifyVisualVocabFn()
        const reloadFn = this.resolveDefaultReloadAssetsFn()
        if (needsVisualVerify && !verifyFn) {
          return {
            ok: false,
            diskMatchesCatalog,
            error: '无法定位本地视觉校验程序，暂不能确认视觉词表完整性'
          }
        }
        let verifyRes = { ok: true, dir: targetDir } as Awaited<ReturnType<VerifyVisualVocabFn>>
        if (verifyFn && needsVisualVerify) {
          verifyRes = await verifyFn(targetDir, expectedEncoderId)
        }
        if (verifyRes.ok && (!vMeta || diskMatchesCatalog)) {
          await writePluginReadyMarkerWithVisualVocab(targetDir, {
            resourceId,
            sharedSubDir,
            verifyRes
          })
          if (reloadFn) {
            const reloadRes = await reloadFn()
            const slotStatus =
              expectedEncoderId !== undefined
                ? reloadRes.byEncoder?.[String(expectedEncoderId)]?.status
                : reloadRes.activeStatus
            if (!reloadRes.success || (slotStatus && slotStatus !== 'ok')) {
              return {
                ok: false,
                diskMatchesCatalog,
                error: reloadRes.error || `reload 后视觉槽状态异常 (${slotStatus || 'unknown'})`
              }
            }
          }
          return { ok: true, diskMatchesCatalog }
        }
        if (diskMatchesCatalog) {
          return {
            ok: false,
            diskMatchesCatalog: true,
            error: verifyRes.error || '磁盘视觉资产与目录清单一致但未通过同源验证'
          }
        }
      }

      if (opts?.skipDownload) {
        return { ok: false, diskMatchesCatalog, error: '本地复验未通过且跳过下载' }
      }

      // 本地未通过：触发对应所属模块下载修复
      const moduleRows = dao.modules.listAllSync()
      const owningMod = moduleRows.find(m =>
        dao.resources.findResourcesByModuleSync(m.id).some(r => r.resource_id === resourceId)
      )
      if (!owningMod) {
        return { ok: false, diskMatchesCatalog, error: `未找到视觉资源所属模块: ${resourceId}` }
      }
      const spec = buildResourceSpecFromCatalog(resourceId as BuiltinSharedResourceId)
      let task = dao.resources.findByIdSync(resourceId)
      if (!spec || !task) {
        return { ok: false, diskMatchesCatalog, error: `未找到资源规格或下载任务: ${resourceId}` }
      }
      if (dao.resources.syncCatalogMetadataSync(spec)) {
        task = dao.resources.findByIdSync(resourceId) ?? task
      }
      try {
        await this.downloadAndInstallSingleResource(owningMod.id, task, spec)
      } catch (dlErr: any) {
        return {
          ok: false,
          diskMatchesCatalog,
          error: dlErr?.message || String(dlErr)
        }
      }
      cleanupLegacyVocabBinSync(targetDir)
      return { ok: true }
    })
  }

  public configureRuntimeDependencies(deps: {
    getDb?: () => Database | null
    configOrchestrator?: any
  }): void {
    if (deps.getDb) {
      this.customDbGetter = deps.getDb
    }
    if (deps.configOrchestrator) {
      this.injectedConfigOrchestrator = deps.configOrchestrator
    }
  }

  static getInstance(): ModularResourceService {
    if (!ModularResourceService.instance) {
      ModularResourceService.instance = new ModularResourceService()
    }
    return ModularResourceService.instance
  }

  public getDb(): Database {
    if (this.customDb) return this.customDb
    if (this.customDbGetter) {
      const db = this.customDbGetter()
      if (db) return db
    }
    try {
      // 容错在未通过 configureRuntimeDependencies 显式注入时的动态加载
      const { databaseService } = require('../database/database-service')
      if (databaseService?.db) {
        return databaseService.db
      }
    } catch {}
    throw new Error('ModularResourceService: 数据库尚未初始化')
  }

  public getDao(): ModularResourceDao {
    return new ModularResourceDao(this.getDb())
  }

  /**
   * [Issue 04 收尾] 高频下载进度回调的节流包装（不改底层 SQL）。
   * 内存 liveProgress 始终即时更新，保证 UI 进度平滑；DB 仅在两种情况落盘：
   * ① 状态跃迁（由显式 flushProgress 调用负责，立即写）；
   * ② 距上次落盘 >= 3000ms 且进度字节有实质变化。
   * 并发分块回调可能乱序，取历史最大值防止进度回退。
   */
  private recordDownloadProgress(
    moduleId: string,
    resourceId: string,
    downloadedBytes: number,
    percentage: number,
    speedBytesPerSec: number,
    isResumed: boolean
  ): void {
    mrReconcileRecordDownloadProgress(
      this,
      moduleId,
      resourceId,
      downloadedBytes,
      percentage,
      speedBytesPerSec,
      isResumed
    )
  }

  /**
   * 强制把某资源最新进度立即落盘（暂停/完成/状态跃迁前调用，不节流）。
   * @param resourceId 资源 ID
   * @param state 显式状态；省略时取 pending 中状态（默认 downloading）
   * @param downloadedBytes 显式字节数；省略时取 pending 中最新值
   */
  flushProgress(
    resourceId: string,
    state?: DownloadState,
    downloadedBytes?: number,
    errorMessage?: string
  ): void {
    const pending = this.pendingProgressPersist.get(resourceId)
    const finalState: DownloadState = state ?? pending?.state ?? 'downloading'
    const bytes = downloadedBytes ?? pending?.bytes ?? 0
    this.getDao().resources.updateProgressSync(resourceId, bytes, finalState, errorMessage)
    this.lastProgressPersistAt.set(resourceId, Date.now())
    this.lastPersistedDownloadState.set(resourceId, finalState)
    this.lastPersistedBytes.set(resourceId, bytes)
    this.pendingProgressPersist.delete(resourceId)

    // 终态回收：资源完成后节流状态不再有用途，避免随资源数量长期驻留（对齐 liveProgress 的 delete 纪律）
    const terminal =
      finalState === 'completed' ||
      finalState === 'failed' ||
      finalState === 'cancelled' ||
      finalState === 'pending_delete'
    if (terminal) {
      this.lastProgressPersistAt.delete(resourceId)
      // lastPersistedDownloadState 必须保留为终态哨兵，供 recordDownloadProgress 的终态闸拦截迟到回调；
      // 下次下载开始时显式 flushProgress('downloading') 会自然解除该哨兵。
      this.lastPersistedBytes.delete(resourceId)
      this.lastLivePercentage.delete(resourceId)
    }
  }

  public getBaseDir(): string {
    if (this.customBaseDir) return this.customBaseDir
    try {
      return electronApp.getPath('userData')
    } catch {
      return process.cwd()
    }
  }

  /**
   * 当前进程内存生效插件根目录 (IN-01: 生命周期内恒定不变，直至重启)
   */
  public getPluginsRootDir(): string {
    if (this.effectivePluginsRootDir) {
      return this.effectivePluginsRootDir
    }

    if (this.customPluginsRootDir) {
      this.effectivePluginsRootDir = this.customPluginsRootDir
      process.env.FIREFLY_MODULES_ROOT = this.effectivePluginsRootDir
      return this.effectivePluginsRootDir
    }

    try {
      const ssotRoot = PluginPathResolver.getPluginsRootDir()
      if (ssotRoot) {
        this.effectivePluginsRootDir = ssotRoot
        process.env.FIREFLY_MODULES_ROOT = ssotRoot
        return ssotRoot
      }
    } catch {}

    if (this.customBaseDir) {
      let committedPath: string | undefined
      try {
        committedPath = this.injectedConfigOrchestrator?.getValue?.('PLUGIN_MODULES_PATH')
      } catch {
        // 容错
      }
      this.effectivePluginsRootDir =
        committedPath && typeof committedPath === 'string' && committedPath.trim()
          ? path.resolve(committedPath.trim())
          : path.join(this.customBaseDir, 'modules')
      process.env.FIREFLY_MODULES_ROOT = this.effectivePluginsRootDir
      return this.effectivePluginsRootDir
    }

    const resolved = PluginPathResolver.getPluginsRootDir()
    process.env.FIREFLY_MODULES_ROOT = resolved
    return resolved
  }

  /**
   * 测试接缝：重置或覆盖当前运行态生效根目录
   */
  public setPluginsRootDirForTesting(dir: string | null): void {
    this.effectivePluginsRootDir = dir ? path.resolve(dir) : null
  }

  /**
   * 获取持久化配置中已提交的新根目录
   */
  public getCommittedPluginsRootDir(): string {
    try {
      const val = this.getConfigOrchestrator()?.getValue('PLUGIN_MODULES_PATH')
      if (val && typeof val === 'string' && val.trim()) {
        return path.resolve(val.trim())
      }
    } catch {}
    return this.getPluginsRootDir()
  }

  /**
   * 获取当前运行态相位
   */
  public getDirRuntimePhase(): DirRuntimePhase {
    return this.dirRuntimePhase
  }

  /**
   * 设置运行态相位
   */
  public setDirRuntimePhase(phase: DirRuntimePhase): void {
    this.dirRuntimePhase = phase
  }

  /**
   * 计算当前生效插件目录下已就绪模块的真实磁盘占用（Worker 计算 + 模块级 mtime 缓存）
   */
  public async calculateCurrentDirUsedBytes(forceRefresh = false): Promise<number> {
    return this.moduleSizeCalculator.calculateUsedBytes(this.getPluginsRootDir(), forceRefresh)
  }

  /**
   * 显式失效模块体积缓存
   */
  public invalidateUsedBytesCache(moduleId?: string): void {
    this.moduleSizeCalculator.invalidate(moduleId)
  }

  /**
   * 获取模块体积缓存统计（供观测与测试断言）
   */
  public getModuleSizeCacheStats() {
    return this.moduleSizeCalculator.getStats()
  }

  /**
   * 注入自定义 ModuleSizeCalculator（供单元测试隔离 Worker 失败/命中行为）
   */
  public setModuleSizeCalculatorForTesting(calculator: ModuleSizeCalculator): void {
    this.moduleSizeCalculator = calculator
  }

  /**
   * 校验候选插件存储目录合法性
   */
  public async validatePluginDir(targetPath: string): Promise<ValidatePluginDirResult> {
    return mrDirValidatePluginDir(this, targetPath)
  }

  /**
   * 获取插件目录详细信息与运行态状态
   */
  public async getPluginDirInfo(): Promise<PluginDirInfo> {
    return mrDirGetPluginDirInfo(this)
  }

  /**
   * 测试接缝：获取或注入目录迁移协调器实例
   */
  private migrationCoordinatorInstance: DirMigrationCoordinator = dirMigrationCoordinator

  public setMigrationCoordinator(coordinator: DirMigrationCoordinator): void {
    this.migrationCoordinatorInstance = coordinator
  }

  public getMigrationCoordinator(): DirMigrationCoordinator {
    return this.migrationCoordinatorInstance
  }

  /**
   * 全局写闸门校验 (DIR_CHANGE_GATE_ACTIVE)
   */
  public assertWriteGateAllowed(): void {
    if (this.dirRuntimePhase !== 'STABLE') {
      throw new ModularResourceError(
        'DIR_CHANGE_GATE_ACTIVE',
        'Plugin directory change is pending restart. All write operations are frozen.'
      )
    }
  }

  /**
   * 触发插件目录迁移事务 (两阶段流式复制与崩溃自愈 Journal)
   */
  public async changePluginDirectory(targetPath: string): Promise<{
    success: boolean
    migrationId?: string
    errorCode?: PluginDirErrorCode
  }> {
    return mrDirChangePluginDirectory(this, targetPath)
  }

  /**
   * 首次运行引导期专用：设定插件安装目录（不迁移、不进入 PENDING_RESTART）
   *
   * 与 changePluginDirectory() 的区别（欢迎向导 5 步流程的关键前提）：
   * - changePluginDirectory() 面向「已有资源的运行期换目录」，DirMigrationCoordinator 在
   *   提交成功后必定把相位切到 PENDING_RESTART 并冻结所有写操作（IN-01：内存根目录
   *   生命周期内恒定，需重启才对齐）。若欢迎向导在选完目录后紧接着安装，
   *   installModule() / updateModuleState() 会被 assertWriteGateAllowed() 以
   *   DIR_CHANGE_GATE_ACTIVE 直接拦截。
   * - 本方法只在「相位 STABLE + 当前根目录没有任何已就绪模块」的严格前提下生效：
   *   此刻没有文件需要搬迁，也没有已运行的插件进程或已加载模型绑定旧根目录，
   *   因此复用同一套 11 步校验管线后，持久化配置并一次性对齐本进程内存根目录，
   *   让紧接着的安装直接落到用户选的文件夹，全程无需重启。
   * - 插件中心设置页继续走 changePluginDirectory() 迁移事务，语义完全不变。
   *
   * 下次启动时 main/index.ts 会从 PLUGIN_MODULES_PATH 重新 initialize
   * PluginPathResolver，启动期锁定仍由 SSOT 解析器负责。
   */
  public async applyInitialPluginDirectory(targetPath: string): Promise<{
    success: boolean
    appliedPath?: string
    errorCode?: PluginDirErrorCode
  }> {
    return mrDirApplyInitialPluginDirectory(this, targetPath)
  }

  /**
   * 取消正在进行的目录迁移 (仅在 PRECHECK / STAGING / VERIFYING 生效)
   */
  public async cancelDirMigration(): Promise<{
    cancelled: boolean
    errorCode?: PluginDirErrorCode
  }> {
    return mrDirCancelDirMigration(this)
  }

  /**
   * 清理历史旧目录残留资产 (Issue 04)
   *
   * 两阶段延迟安全清理：
   * 1. 验证目标目录不是系统目录、不是当前生效根目录、未被未决 Journal 引用；
   * 2. 计算将释放的磁盘空间；
   * 3. 重命名为 .deleting-* 隔离；
   * 4. 异步流式安全删除；
   * 5. 持久化清空 PREVIOUS_PLUGIN_MODULES_PATH 配置项。
   */
  public async cleanupOldPluginDirectory(): Promise<{
    success: boolean
    freedBytes: number
    errorCode?: PluginDirErrorCode
  }> {
    return mrDirCleanupOldPluginDirectory(this)
  }

  /**
   * 忽略历史旧目录清理提示
   */
  public dismissOldDirCleanup(): void {
    this.oldDirCleanupDismissed = true
  }

  /**
   * 是否已忽略旧目录清理提示
   */
  public isOldDirCleanupDismissed(): boolean {
    return this.oldDirCleanupDismissed
  }

  /**
   * 测试/自定义目录删除函数注入接缝
   */
  public setDeleteDirectoryFn(fn: (dirPath: string) => Promise<boolean>): void {
    this.deleteDirectoryFn = fn
  }

  /**
   * 将相对路径解析为基于 pluginsRootDir 的绝对物理路径（严禁绝对路径或目录穿越）
   */
  public resolvePhysicalPath(targetLocalPath: string): string {
    return resolvePhysicalPath(this.getPluginsRootDir(), targetLocalPath)
  }

  /**
   * 获取下载归档缓存路径
   */
  public resolveDownloadArchivePath(resourceId: string, assetName: string): string {
    const safeAsset = assetName.replace(/[^a-zA-Z0-9._-]/g, '_')
    return path.join(this.getBaseDir(), 'downloads', 'tmp', `${resourceId}_${safeAsset}`)
  }

  /**
   * 测试接缝：覆盖指定资源的 BOM 散列文件清单
   */
  public setResourceBomOverride(
    resourceId: string,
    files: Array<{ name: string; size: number; sha256: string }>
  ): void {
    this.resourceBomOverrides.set(resourceId, files)
  }

  /**
   * 推理引擎加载门控：等待指定模块完成真实文件 SHA-256 异步校验
   */
  public async ensureVerified(moduleId: string): Promise<boolean> {
    return mrPreflightEnsureVerified(this, moduleId)
  }

  /**
   * 读取资源的 BOM 文件清单定义
   */
  /**
   * 候选 BOM 路径解析（严格适配打包态、开发态与 monorepo 子工作区不同 cwd）
   */
  private getCandidateBomPaths(): string[] {
    return mrPreflightGetCandidateBomPaths(this)
  }

  /**
   * 按资源 ID 获取预期文件清单（优先读取 BOM 文件，用于解压完成后的物理对账）
   */
  private loadBomFilesForResource(
    resourceId: string
  ): Array<{ name: string; size: number; sha256: string }> {
    return mrPreflightLoadBomFilesForResource(this, resourceId)
  }

  /**
   * 读取全部资源的 BOM 文件清单定义
   */
  public loadResourceBom(): Array<{ name: string; size: number; sha256: string }> {
    return mrPreflightLoadResourceBom(this)
  }

  /**
   * L1 物理探活：检查目标解压目录是否健全
   * 返回 'fast_hit' | 'slow_healed' | 'corrupted' | 'not_found'
   */
  private async checkL1TargetDirPreflight(
    targetAbsDir: string,
    spec: CatalogResourceSpec
  ): Promise<'fast_hit' | 'slow_healed' | 'corrupted' | 'not_found'> {
    return mrPreflightCheckL1TargetDirPreflight(this, targetAbsDir, spec)
  }

  /**
   * 将损坏目录原子隔离至同卷 .corrupt-<uuid>
   */
  private async isolateCorruptDirectory(targetAbsDir: string): Promise<void> {
    return mrPreflightIsolateCorruptDirectory(this, targetAbsDir)
  }

  /**
   * L2 物理探活：探测本地预置包并验证（优先匹配 presetResources/<resource_id>/<asset_name>，向下兼容平放）
   */
  private async checkL2LocalPresetPreflight(
    spec: CatalogResourceSpec,
    targetAbsDir: string
  ): Promise<boolean> {
    return mrPreflightCheckL2LocalPresetPreflight(this, spec, targetAbsDir)
  }

  /**
   * 同步执行目录元数据更新（确保 DEFAULT_CATALOG_SEEDS 全量模块落地）
   *
   * 幂等补灌铁律：严禁以 `existing.length === 0`（空库）为灌库守卫——存量库新增内置模块
   * （如 media_enhance 四个 coming_soon 预占位、file_ai_cover）依赖此处补行，否则插件中心
   * 读库渲染将永久缺失新模块，而目录插件配置 Tab 读静态常量正常显示，两视图漂移。
   * syncCatalogSync 自带 catalog_version 回归保护与 IN-04 铁律（绝不覆盖本地
   * install_state/user_config/config_json），无条件执行安全；服务生命周期内单次执行。
   */
  public ensureDefaultSeeds(): void {
    mrCatalogEnsureDefaultSeeds(this)
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
  private isBuiltinModulesCategoryGateDrifted(tableSql: string): boolean {
    return mrCatalogIsBuiltinModulesCategoryGateDrifted(this, tableSql)
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
  private rebuildBuiltinModulesTableForGenesisDrift(): boolean {
    return mrCatalogRebuildBuiltinModulesTableForGenesisDrift(this)
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
  public reconcileBuiltinModuleBindingsSync(): {
    repairedPaths: string[]
    failedRepairs: string[]
    removedObsolete: string[]
    backfilledBindings: Array<{ moduleId: string; resourceId: string }>
    schemaIndexDriftDetected: boolean
  } {
    return mrCatalogReconcileBuiltinModuleBindingsSync(this)
  }

  /**
   * 为 engine_classic_light 保活场景判断当前语言核心资产是否就绪
   * 中文环境要求 bekko-a8m + chinese-clip；非中文环境要求 bekko-a8m + mobile-clip
   */
  private isClassicEngineCoreReady(boundResources: ResourceDownloadRecord[]): boolean {
    return mrCatalogIsClassicEngineCoreReady(this, boundResources)
  }

  /**
   * 后台静默补下载伴随资源（如存量 engine_classic_light 缺失的 mobile-clip），完成后热刷新挂载
   */
  private triggerCompanionBackfill(moduleId: string, resourceId: BuiltinSharedResourceId): void {
    mrCatalogTriggerCompanionBackfill(this, moduleId, resourceId)
  }

  /**
   * 启动期自愈与孤儿清理：
   * 1. 扫描清理遗留的 .tmp-* / .deleting-* / 历史 .tombstone-* 与陈旧 active-mounts-*.json；
   * 2. 清理此前被标记为 pending_delete 且已无模块引用的资源目录与记录；
   * 3. 对账 builtin_modules 与 resource_downloads：保障单资源故障隔离与 engine_classic_light 保活；
   * 4. 执行 OfflinePackage/StartupReconciler 离线自愈。
   */
  async reconcileOnStartup(): Promise<{
    cleanedTombstones: number
    resetModules: string[]
    resetDownloads: string[]
  }> {
    return mrReconcileReconcileOnStartup(this)
  }

  /**
   * 冷启动纯异步快路径门禁 Barrier (Spec §2.3.4, §2.6)
   * - 严禁 `fs.*Sync` 阻塞事件循环，并发上限 4，Promise.race 预算默认 200ms
   * - 产出 `ready_fast` / `legacy_heal` / `pending_repair` / `pending_validation` 四态快照
   * - `pending_validation` 与 `pending_repair` 严禁进入挂载清单
   */
  public async runFastReadyBarrier(timeoutMs = 200): Promise<FastReadyBarrierResult> {
    return mrBarrierRunFastReadyBarrier(this, timeoutMs)
  }

  /**
   * 后台全量验证与 `.ready.json` 平滑升级调度器：
   * - 校验 BOM 文件 SHA-256 或生成完整目录内容摘要写入正式 `.ready.json`
   * - 发现损坏则隔离为 `pending_repair`
   * - 从 `pending_validation` 转正或状态改变后，自动通过协调器尾沿合并触发 Omni 热刷新
   */
  public scheduleBackgroundFullVerification(resourceIds: string[], delayMs = 50): Promise<void> {
    return mrBarrierScheduleBackgroundFullVerification(this, resourceIds, delayMs)
  }

  public cleanupForTesting(): void {
    if (this.bgVerificationTimer) {
      clearTimeout(this.bgVerificationTimer)
      this.bgVerificationTimer = null
    }
  }

  private async processBackgroundVerification(resourceIds: string[]): Promise<void> {
    return mrBarrierProcessBackgroundVerification(this, resourceIds)
  }

  /**
   * 查询指定资源最近一次快路径校验诊断状态
   */
  public getFastReadyStatus(resourceId: string): ResourceValidationEntry | undefined {
    return this.fastReadySnapshot.get(resourceId)
  }

  /**
   * 返回当前可进入 active-mounts-*.json 的已就绪域 B 资源快照
   * （仅允许处于 active 模块且状态为 ready_fast 或 legacy_heal 的非修复资源）
   */
  public getMountableResourcesSnapshot(): Array<
    ResourceValidationEntry & {
      catalogMeta?: (typeof BUILTIN_PLUGIN_CATALOG_META)[BuiltinSharedResourceId]
    }
  > {
    return mrBarrierGetMountableResourcesSnapshot(this)
  }

  public isRootUnavailable(): boolean {
    return this.rootUnavailable
  }

  public getSchemaIndexDriftDetected(): boolean {
    return this.schemaIndexDriftDetected
  }

  /**
   * 运行时插件拓扑变更统一通知入口（经过 RuntimeTopologyCoordinator 尾沿去重并发往 Omni/VoiceCache）
   */
  public async notifyRuntimePluginTopologyChanged(
    reasonOrOpts?: string | TopologyChangeNotificationOptions
  ): Promise<void> {
    return mrBarrierNotifyRuntimePluginTopologyChanged(this, reasonOrOpts)
  }

  /**
   * 同步执行目录元数据更新（内部复用）
   */
  private syncCatalogSync(entries: CatalogModuleEntry[]): {
    updated: number
    skippedRegression: number
    /** 行级失败明细（存量库表级 CHECK 固化旧白名单等约束拒绝），显式上报严禁静默丢弃 */
    failedRows: Array<{ id: string; error: string }>
  } {
    return mrCatalogSyncCatalogSync(this, entries)
  }

  /**
   * 增量同步插件目录元数据（满足 IN-04：remote.catalog_version < local.catalog_version 时忽略并告警；离线静默兜底）
   */
  async syncCatalog(entries: CatalogModuleEntry[]): Promise<{
    updated: number
    skippedRegression: number
    failedRows: Array<{ id: string; error: string }>
  }> {
    return mrQuerySyncCatalog(this, entries)
  }

  /**
   * 将数据库记录与关联资源组装为前端可直接消费的 BuiltinModuleView
   */
  private buildModuleView(record: BuiltinModuleRecord): BuiltinModuleView {
    return mrCatalogBuildModuleView(this, record)
  }

  /**
   * 获取模块完整视图列表（支持 scope: 'market' | 'installed' 过滤）
   */
  listModules(filter?: {
    scope?: 'market' | 'installed'
    category?: string
    includeDraft?: boolean
  }): BuiltinModuleView[] {
    return mrQueryListModules(this, filter)
  }

  /**
   * 解析模块所需的物理资源定义列表
   */
  private resolveModuleResourceSpecs(record: BuiltinModuleRecord): CatalogResourceSpec[] {
    return mrCatalogResolveModuleResourceSpecs(this, record)
  }

  /**
   * 幂等下载并安装模块（引用计数复用 -> Range 206 -> SHA-256 -> Zip Slip 解压 -> 原子 rename）
   */
  async installModule(
    moduleId: string,
    onProgress?: (event: ModuleDownloadProgressEvent) => void,
    options?: { skipLocalPreset?: boolean }
  ): Promise<BuiltinModuleView> {
    return mrInstallerInstallModule(this, moduleId, onProgress, options)
  }

  /**
   * 将选配模块加入后台静默安装队列（单实例串行 Singleflight，支持跨上下文接管）
   */
  async enqueueBackgroundInstalls(moduleIds: string[]): Promise<string[]> {
    return mrInstallerEnqueueBackgroundInstalls(this, moduleIds)
  }

  /**
   * 注册后台安装进度全局广播回调
   */
  public setProgressBroadcaster(broadcaster: (event: ModuleDownloadProgressEvent) => void): void {
    this.backgroundProgressBroadcaster = broadcaster
  }

  /**
   * 顺序处理后台安装队列
   */
  private async processBackgroundInstallQueue(): Promise<void> {
    return mrInstallerProcessBackgroundInstallQueue(this)
  }

  /**
   * 执行单个物理资源的下载、流式 SHA-256 校验、安全解压与状态落库
   */
  private async downloadAndInstallSingleResource(
    moduleId: string,
    task: ResourceDownloadRecord,
    spec: CatalogResourceSpec,
    onProgress?: (event: ModuleDownloadProgressEvent) => void
  ): Promise<void> {
    return mrInstallerDownloadAndInstallSingleResource(this, moduleId, task, spec, onProgress)
  }

  /**
   * 卸载模块并通知安全停机释放文件句柄
   */
  private async stopOmniProcessForUninstall(): Promise<boolean> {
    return mrInstallerStopOmniProcessForUninstall(this)
  }

  /**
   * 激活门禁核验：确认模块绑定物理资产已完整落盘（允许 engine_classic_light 在可选伴随资源 mobile-clip 未到位时保活）
   */
  private async assertModuleResourcesReadyForActivation(
    moduleId: string,
    record: BuiltinModuleRecord
  ): Promise<void> {
    return mrInstallerAssertModuleResourcesReadyForActivation(this, moduleId, record)
  }

  /**
   * 检索指定必选底座同槽位下所有处于健康可服役状态的备选模块 (Ready Backup)
   *
   * @doc-anchor: docs/specs/plugin-center-slots-exclusivity-and-lifecycle-spec.md#25-插件全生命周期管控停用与两阶段卸载回收-lifecycle-management
   */
  private findReadyBackupModulesSync(record: BuiltinModuleRecord): BuiltinModuleRecord[] {
    return mrInstallerFindReadyBackupModulesSync(this, record)
  }

  /**
   * 卸载模块（Windows 两阶段停机解锁 + Tombstone 单步隔离删除协议）：
   * 阶段一（前置防空拦截与事务内接替/解绑）：必选底座无就绪备选时坚决拦截；存在备选时同一事务内原子提升备选并解绑旧项；
   * 阶段二（停机释放句柄 + 原子隔离删除）：先停用关联进程与 Omni 引擎解除 ORT mmap 句柄，再单步重命名为 .deleting-* 并异步回收；
   * 阶段三（重启对齐拓扑）：刷新挂载清单与音色缓存，或拉起接替备选底座。
   */
  async uninstallModule(moduleId: string): Promise<BuiltinModuleView> {
    return mrInstallerUninstallModule(this, moduleId)
  }

  /**
   * 切换模块激活状态或更新 user_config / selected_variant / user_consent
   */
  async updateModuleState(
    moduleId: string,
    patch: {
      active?: boolean
      userConfig?: Record<string, unknown> | string | null
      selectedVariant?: string
      userConsent?: boolean
    }
  ): Promise<BuiltinModuleView> {
    this.assertWriteGateAllowed()
    this.ensureDefaultSeeds()
    // 能力槽位激活/停用是 contextEpoch 的核心触发源：100ms 合并由上下文服务统一处理
    emitRuntimeContextChange('module_state_changed')
    const dao = this.getDao()
    const existing = dao.modules.findByIdSync(moduleId)
    if (!existing) {
      throw new Error(`未找到模块定义: ${moduleId}`)
    }

    const slot = existing.capability_slot ?? 'general'
    const policy = existing.slot_policy ?? 'multi_active'
    const isExclusive = policy === 'exclusive_required' || policy === 'exclusive_optional'

    if (patch.active !== undefined) {
      if (isExclusive) {
        return this.withSlotMutex(slot, () =>
          this.executeUpdateModuleState(moduleId, patch, existing)
        )
      }
      return this.topologyCoordinator.execute(() =>
        this.executeUpdateModuleState(moduleId, patch, existing)
      )
    }
    return this.executeUpdateModuleState(moduleId, patch, existing)
  }

  private async executeUpdateModuleState(
    moduleId: string,
    patch: {
      active?: boolean
      userConfig?: Record<string, unknown> | string | null
      selectedVariant?: string
      userConsent?: boolean
    },
    existing: BuiltinModuleRecord
  ): Promise<BuiltinModuleView> {
    return mrStateExecuteUpdateModuleState(this, moduleId, patch, existing)
  }

  /**
   * 激活指定模块（针对排他槽位自动停用同槽位其他模块）
   */
  async activateModule(moduleId: string): Promise<BuiltinModuleView> {
    return mrQueryActivateModule(this, moduleId)
  }

  /**
   * 停用指定模块（若处于 exclusive_required 且激活状态则拒绝并抛出 SLOT_REQUIRED_EMPTY）
   */
  async deactivateModule(moduleId: string): Promise<BuiltinModuleView> {
    return mrQueryDeactivateModule(this, moduleId)
  }

  /**
   * 按能力槽位查询当前激活的模块（若无激活返回 null）
   */
  getActiveModuleBySlot(slot: PluginCapabilitySlot): BuiltinModuleView | null {
    return mrQueryGetActiveModuleBySlot(this, slot)
  }

  getModule(moduleId: string): BuiltinModuleView | null {
    return mrQueryGetModule(this, moduleId)
  }

  getPendingTombstones(): PendingDeletionItem[] {
    return mrOfflineGetPendingTombstones(this)
  }

  hasPendingTombstones(): boolean {
    return mrOfflineHasPendingTombstones(this)
  }

  requestRestart(): void {
    mrOfflineRequestRestart(this)
  }

  async exportOfflinePackage(
    moduleId: string,
    targetFilePath: string,
    options?: { signerPrivateKey?: string }
  ): Promise<string> {
    return mrOfflineExportOfflinePackage(this, moduleId, targetFilePath, options)
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
  async exportOfflineBundle(
    targetFilePath: string,
    options?: { rootPublicKey?: string; producerAppVersion?: string }
  ): Promise<string> {
    return mrOfflineExportOfflineBundle(this, targetFilePath, options)
  }

  /**
   * 同步活跃底座画像状态到 ConfigOrchestrator（保证 base_embedding 与 AI_EMBEDDING_PROFILE / EMBEDDING_MRL_DIMENSION 唯一事实源全域统一）
   */
  public async syncEmbeddingProfileToConfig(): Promise<void> {
    return mrStateSyncEmbeddingProfileToConfig(this)
  }

  /**
   * 同步 CPU 引擎激活/停用状态到 ConfigOrchestrator、LlmGatewayService 与 EngineBridgeService
   * 实现插件中心与全局设置页面的双向互斥对齐 (TASK-04 / Invariant)
   */
  public async syncCpuEngineStateToConfig(active: boolean): Promise<void> {
    return mrStateSyncCpuEngineStateToConfig(this, active)
  }

  async importOfflinePackage(
    archivePath: string,
    options?: {
      rootPublicKey?: string
      preferredEngineId?: string
      autoActivateModuleIds?: string[]
    }
  ): Promise<BuiltinModuleView> {
    this.ensureDefaultSeeds()
    return this.offlinePackageService.importOfflinePackage(archivePath, options)
  }
}

export const modularResourceService = ModularResourceService.getInstance()
