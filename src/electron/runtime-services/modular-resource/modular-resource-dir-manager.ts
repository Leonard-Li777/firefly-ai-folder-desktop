/**
 * ModularResourceService 插件目录校验、迁移协调与旧目录清理逻辑
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
  ModularResourceService,
  LEGACY_HEAL_MARKER_FILENAME,
  hasAnyReadyMarkerFile,
  resolveSharedSubDir,
  parseExclusiveSlotsFromIndexSql,
  mapTaskStatesToModuleState
} from '../system/modular-resource-service-core'

/**
 * 校验候选插件存储目录合法性
 */
export async function mrDirValidatePluginDir(
  host: any,
  targetPath: string
): Promise<ValidatePluginDirResult> {
  const currentUsedBytes = await host.calculateCurrentDirUsedBytes()
  const sharedDir = path.join(host.getPluginsRootDir(), '_shared')
  let installedIds: string[] = []
  if (fs.existsSync(sharedDir)) {
    try {
      const entries = fs.readdirSync(sharedDir, { withFileTypes: true })
      installedIds = entries
        .filter(e => e.isDirectory())
        .filter(e => {
          const files = fs.readdirSync(path.join(sharedDir, e.name))
          return hasAnyReadyMarkerFile(files)
        })
        .map(e => e.name)
    } catch {}
  }

  return await validatePluginDirectory(targetPath, host.getPluginsRootDir(), {
    totalSourceBytes: currentUsedBytes,
    currentInstalledModuleIds: installedIds
  })
}

/**
 * 获取插件目录详细信息与运行态状态
 */
export async function mrDirGetPluginDirInfo(host: any): Promise<PluginDirInfo> {
  const currentDir = host.getPluginsRootDir()
  const committedDir = host.getCommittedPluginsRootDir()
  const defaultDir = path.join(host.getBaseDir(), 'modules')
  const isDefault = isPathEqual(currentDir, defaultDir)
  const defaultDirNonAscii = /[^\x20-\x7E]/.test(defaultDir)
  const usedBytes = await host.calculateCurrentDirUsedBytes()
  const { freeBytes } = getDiskFreeSpace(currentDir)

  let previousPath: string | null = null
  let previousPathExists = false
  try {
    const prev = host.getConfigOrchestrator()?.getValue('PREVIOUS_PLUGIN_MODULES_PATH')
    if (prev && typeof prev === 'string' && prev.trim()) {
      previousPath = path.resolve(prev.trim())
      previousPathExists = fs.existsSync(previousPath)
    }
  } catch {}

  return {
    currentDir,
    currentPath: currentDir,
    committedDir,
    isDefault,
    defaultDirNonAscii,
    phase: host.dirRuntimePhase,
    usedBytes,
    freeBytes,
    previousPath,
    previousPathExists
  }
}

/**
 * 触发插件目录迁移事务 (两阶段流式复制与崩溃自愈 Journal)
 */
export async function mrDirChangePluginDirectory(
  host: any,
  targetPath: string
): Promise<{
  success: boolean
  migrationId?: string
  errorCode?: PluginDirErrorCode
}> {
  host.assertWriteGateAllowed()

  // 1. 前置 11 步校验管线
  const validation = await host.validatePluginDir(targetPath)
  if (!validation.valid) {
    return {
      success: false,
      errorCode: validation.errorCode ?? 'PATH_NOT_WRITABLE'
    }
  }

  const currentSourceDir = host.getPluginsRootDir()
  const resolvedTarget = path.resolve(targetPath.trim())

  // 2. 收集 BOM 哈希清单（供双端复制对账核验）
  const bomHashes = new Map<string, string>()
  try {
    const bomRecords = host.loadResourceBom()
    for (const item of bomRecords) {
      if (item.name && item.sha256) {
        bomHashes.set(item.name, item.sha256)
      }
    }
  } catch {}

  // 3. 执行流式迁移
  const result = await host.migrationCoordinatorInstance.executeMigration(
    currentSourceDir,
    resolvedTarget,
    {
      userDataDir: host.getBaseDir(),
      bomHashes,
      onPhaseChange: (phase: DirRuntimePhase) => {
        host.setDirRuntimePhase(phase)
      },
      onConfigCommit: async (newPath: string, oldPath: string) => {
        try {
          const orchestrator = host.getConfigOrchestrator()
          orchestrator?.setValue('PREVIOUS_PLUGIN_MODULES_PATH', oldPath)
          orchestrator?.setValue('PLUGIN_MODULES_PATH', newPath)
        } catch (err) {
          logger.warn(LogCategory.MAIN, '[ModularResourceService] 更新配置失败:', err)
        }
      }
    }
  )

  if (result.success) {
    host.oldDirCleanupDismissed = false
    host.moduleSizeCalculator.invalidate()
  }

  return result
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
export async function mrDirApplyInitialPluginDirectory(
  host: any,
  targetPath: string
): Promise<{
  success: boolean
  appliedPath?: string
  errorCode?: PluginDirErrorCode
}> {
  host.assertWriteGateAllowed()

  const resolvedTarget = path.resolve((targetPath ?? '').trim())
  const currentDir = host.getPluginsRootDir()
  // 幂等分支必须先于 11 步校验：校验器对「与当前目录相同」会返回 SAME_AS_CURRENT，
  // 但向导里用户直接选中默认目录是合法操作，等同于「不改」，无需校验也无需写配置。
  if (isPathEqual(currentDir, resolvedTarget)) {
    return { success: true, appliedPath: resolvedTarget }
  }

  // 1. 复用与插件中心完全相同的 11 步校验管线（纯英文路径、禁系统目录、空间门槛等）
  const validation = await host.validatePluginDir(targetPath)
  if (!validation.valid) {
    return {
      success: false,
      errorCode: validation.errorCode ?? 'PATH_NOT_WRITABLE'
    }
  }

  // 2. 严格前置条件：根目录下没有任何已就绪模块，否则必须回到迁移事务 + 重启链路
  const usedBytes = await host.calculateCurrentDirUsedBytes(true)
  if (usedBytes > 0) {
    return { success: false, errorCode: 'DIR_CHANGE_GATE_ACTIVE' }
  }

  // 3. 持久化配置（ConfigOrchestrator 的真实写入 API 是 updateValue，不是 setValue）
  const orchestrator = host.getConfigOrchestrator()
  if (!orchestrator || typeof orchestrator.updateValue !== 'function') {
    return { success: false, errorCode: 'PATH_NOT_WRITABLE' }
  }
  try {
    await orchestrator.updateValue('PLUGIN_MODULES_PATH', resolvedTarget, {
      source: 'user',
      preventAutoReload: true
    })
  } catch (err) {
    logger.warn(LogCategory.MAIN, '[ModularResourceService] 首次运行目录写入失败:', err)
    return { success: false, errorCode: 'PATH_NOT_WRITABLE' }
  }

  // 4. 对齐本进程内存根目录与子进程可见的环境变量。
  //    PluginPathResolver 的启动期锁定保持不变：安装链路全部经由
  //    ModularResourceService.getPluginsRootDir() 取得根目录。
  host.effectivePluginsRootDir = resolvedTarget
  process.env.FIREFLY_MODULES_ROOT = resolvedTarget
  host.moduleSizeCalculator.invalidate()
  host.fastReadySnapshot.clear()
  host.repairPendingResources.clear()

  return { success: true, appliedPath: resolvedTarget }
}

/**
 * 取消正在进行的目录迁移 (仅在 PRECHECK / STAGING / VERIFYING 生效)
 */
export async function mrDirCancelDirMigration(host: any): Promise<{
  cancelled: boolean
  errorCode?: PluginDirErrorCode
}> {
  return await host.migrationCoordinatorInstance.cancelMigration(host.getBaseDir())
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
export async function mrDirCleanupOldPluginDirectory(host: any): Promise<{
  success: boolean
  freedBytes: number
  errorCode?: PluginDirErrorCode
}> {
  host.assertWriteGateAllowed()

  let previousPath: string | undefined
  try {
    previousPath = host.getConfigOrchestrator()?.getValue('PREVIOUS_PLUGIN_MODULES_PATH')
  } catch {}

  if (!previousPath || !previousPath.trim() || !fs.existsSync(previousPath.trim())) {
    // 已经不存在，将配置清空并返回
    try {
      host.getConfigOrchestrator()?.setValue('PREVIOUS_PLUGIN_MODULES_PATH', '')
    } catch {}
    return { success: true, freedBytes: 0 }
  }

  const resolvedOld = path.resolve(previousPath.trim())
  const currentRoot = host.getPluginsRootDir()

  // 安全检查 1: 绝对不能是系统保护目录或盘符根
  const parsed = path.parse(resolvedOld)
  if (parsed.root.toLowerCase() === resolvedOld.toLowerCase()) {
    throw new ModularResourceError('SYSTEM_DIR_FORBIDDEN', 'Cannot cleanup drive root directory.')
  }

  // 安全检查 2: 绝对不能是当前激活根目录或其子目录
  if (isPathEqual(resolvedOld, currentRoot) || isSubPath(currentRoot, resolvedOld)) {
    throw new ModularResourceError(
      'SAME_AS_CURRENT',
      'Cannot cleanup the currently active plugin directory.'
    )
  }

  // 异步统计旧目录体积（lstat 语义）
  const freedBytes = await calculateDirBytesAsync(resolvedOld)

  // 两阶段隔离与异步删除
  const parentDir = path.dirname(resolvedOld)
  const tombstoneDir = path.join(
    parentDir,
    `.deleting-old-modules-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  )

  try {
    fs.renameSync(resolvedOld, tombstoneDir)
  } catch {
    // 若无法重命名，直接对原目录异步清理
  }

  const targetToDelete = fs.existsSync(tombstoneDir) ? tombstoneDir : resolvedOld

  // 异步执行安全删除，不阻塞当前响应
  setTimeout(() => {
    try {
      host.deleteDirectoryFn(targetToDelete).catch((err: unknown) => {
        logger.warn(LogCategory.MAIN, '[ModularResourceService] 异步清理旧目录失败:', err)
      })
    } catch {}
  }, 100)

  // 清空 PREVIOUS_PLUGIN_MODULES_PATH 配置
  try {
    host.getConfigOrchestrator()?.setValue('PREVIOUS_PLUGIN_MODULES_PATH', '')
  } catch {}

  return { success: true, freedBytes }
}
