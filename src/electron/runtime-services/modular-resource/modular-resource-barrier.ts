/**
 * ModularResourceService 启动 FastReady Barrier 与后台核验逻辑
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
  ModularResourceService,
  LEGACY_HEAL_MARKER_FILENAME,
  hasAnyReadyMarkerFile,
  resolveSharedSubDir,
  parseExclusiveSlotsFromIndexSql,
  mapTaskStatesToModuleState
} from '../system/modular-resource-service-core'

/**
 * 冷启动纯异步快路径门禁 Barrier (Spec §2.3.4, §2.6)
 * - 严禁 `fs.*Sync` 阻塞事件循环，并发上限 4，Promise.race 预算默认 200ms
 * - 产出 `ready_fast` / `legacy_heal` / `pending_repair` / `pending_validation` 四态快照
 * - `pending_validation` 与 `pending_repair` 严禁进入挂载清单
 */
export async function mrBarrierRunFastReadyBarrier(
  host: any,
  timeoutMs = 200
): Promise<FastReadyBarrierResult> {
  const startMs = Date.now()
  if (host.rootUnavailable) {
    host.fastReadySnapshot.clear()
    return {
      rootStatus: 'unavailable',
      readyResources: [],
      legacyHealResources: [],
      pendingValidationResources: [],
      pendingRepairResources: [],
      timedOut: false,
      elapsedMs: 0
    }
  }

  const dao: ModularResourceDao = host.getDao()
  const pluginsRootDir = host.getPluginsRootDir()
  const activeModules = dao.modules.findActiveSync()
  const activeResourceMap = new Map<string, ResourceDownloadRecord>()

  for (const mod of activeModules) {
    const bound = dao.resources.findResourcesByModuleSync(mod.id)
    for (const res of bound) {
      if (res.download_state !== 'pending_delete' && !activeResourceMap.has(res.resource_id)) {
        activeResourceMap.set(res.resource_id, res)
      }
    }
  }

  const items = Array.from(activeResourceMap.values())
  const settled = new Map<string, ResourceValidationEntry>()
  const legacyUpgradeTargets = new Set<string>()
  const latePromises: Array<Promise<void>> = []

  const probeSingleResource = async (res: ResourceDownloadRecord): Promise<void> => {
    const sharedSubDir = resolveSharedSubDir(res.resource_id)
    const now = Date.now()

    if (host.repairPendingResources.has(res.resource_id)) {
      const existingDiag = host.fastReadySnapshot.get(res.resource_id)
      settled.set(res.resource_id, {
        resourceId: res.resource_id,
        sharedSubDir,
        physicalDir: null,
        status: existingDiag?.status === 'unknown_resource' ? 'unknown_resource' : 'pending_repair',
        validationLevel: 'full',
        reason: existingDiag?.reason ?? 'repair_pending',
        checkedAt: now
      })
      return
    }

    const catalogMeta = (
      BUILTIN_PLUGIN_CATALOG_META as Record<
        string,
        {
          sharedSubDir: string
          requiredFileGroups: readonly (readonly string[])[]
          minPrimaryFileBytes?: number
        }
      >
    )[res.resource_id]

    // 读层路径防越权校验 (Fail-Closed)
    let targetDir: string
    try {
      targetDir = resolvePhysicalPath(pluginsRootDir, res.target_local_path)
    } catch (err: any) {
      logger.error(
        LogCategory.SYSTEM,
        `[ModularResource] 快路径发现越权或非法 target_local_path，拒绝挂载: ${res.resource_id}`,
        err
      )
      settled.set(res.resource_id, {
        resourceId: res.resource_id,
        sharedSubDir,
        physicalDir: null,
        status: 'pending_repair',
        validationLevel: 'full',
        reason: err?.message || 'invalid_target_local_path',
        checkedAt: now
      })
      return
    }

    if (host.unknownResources.has(res.resource_id)) {
      settled.set(res.resource_id, {
        resourceId: res.resource_id,
        sharedSubDir,
        physicalDir: null,
        status: 'unknown_resource',
        validationLevel: 'full',
        reason: 'unknown_resource',
        checkedAt: now
      })
      return
    }

    try {
      const st = await fs.promises.lstat(targetDir)
      if (st.isSymbolicLink() || !st.isDirectory()) {
        settled.set(res.resource_id, {
          resourceId: res.resource_id,
          sharedSubDir,
          physicalDir: null,
          status: 'pending_repair',
          validationLevel: 'full',
          reason: 'target_not_directory_or_symlink',
          checkedAt: now
        })
        return
      }

      const marker = await readReadyMarker(targetDir)
      const filesOk = await PluginPathResolver.checkRequiredFileGroupsAsync(
        targetDir,
        catalogMeta?.requiredFileGroups,
        catalogMeta?.minPrimaryFileBytes ?? 1
      )

      // 分支 1: ready_fast
      if (
        marker &&
        marker.resourceId === res.resource_id &&
        marker.sharedSubDir === sharedSubDir &&
        filesOk
      ) {
        settled.set(res.resource_id, {
          resourceId: res.resource_id,
          sharedSubDir,
          physicalDir: targetDir,
          status: 'ready_fast',
          validationLevel: 'full',
          checkedAt: Date.now()
        })
        return
      }

      // 分支 2: legacy_heal (.ready.json 缺失但特征文件存在且满足字节阈值 -> 临时 marker + 后台升级正式 .ready.json)
      if (!marker && filesOk) {
        try {
          const tmpPath = path.join(
            targetDir,
            `${LEGACY_HEAL_MARKER_FILENAME}.tmp-${process.pid}-${Date.now()}`
          )
          const legacyPayload = JSON.stringify(
            {
              version: 1,
              validationLevel: 'legacy',
              resourceId: res.resource_id,
              sharedSubDir,
              generatedAt: new Date().toISOString()
            },
            null,
            2
          )
          await fs.promises.writeFile(tmpPath, legacyPayload, 'utf-8')
          await fs.promises.rename(tmpPath, path.join(targetDir, LEGACY_HEAL_MARKER_FILENAME))
        } catch (err) {
          logger.warn(
            LogCategory.SYSTEM,
            `[ModularResource] 写入补位就绪标记失败: ${res.resource_id}`,
            err
          )
        }
        legacyUpgradeTargets.add(res.resource_id)
        settled.set(res.resource_id, {
          resourceId: res.resource_id,
          sharedSubDir,
          physicalDir: targetDir,
          status: 'legacy_heal',
          validationLevel: 'legacy',
          reason: 'missing_ready_marker_legacy_healed',
          checkedAt: Date.now()
        })
        return
      }

      // 分支 3: pending_repair
      settled.set(res.resource_id, {
        resourceId: res.resource_id,
        sharedSubDir,
        physicalDir: null,
        status: 'pending_repair',
        validationLevel: 'full',
        reason: !filesOk ? 'required_files_missing_or_truncated' : 'ready_marker_mismatch',
        checkedAt: Date.now()
      })
    } catch (err: any) {
      settled.set(res.resource_id, {
        resourceId: res.resource_id,
        sharedSubDir,
        physicalDir: null,
        status: 'pending_repair',
        validationLevel: 'full',
        reason: err?.code || err?.message || 'probe_io_error',
        checkedAt: Date.now()
      })
    }
  }

  // 并发上限 4 的异步执行池
  const concurrency = 4
  let cursor = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const idx = cursor++
      const res = items[idx]
      const p = probeSingleResource(res)
      latePromises.push(p)
      await p
    }
  })
  const allWorkPromise = Promise.all(workers).then(() => false)

  let timerHandle: NodeJS.Timeout | null = null
  let timedOut = false
  if (items.length > 0 && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    const timeoutPromise = new Promise<boolean>(resolve => {
      timerHandle = setTimeout(() => resolve(true), timeoutMs)
      timerHandle.unref?.()
    })
    timedOut = await Promise.race([allWorkPromise, timeoutPromise])
    if (timerHandle) {
      clearTimeout(timerHandle)
      timerHandle = null
    }
  } else {
    await allWorkPromise
  }

  const readyResources: ResourceValidationEntry[] = []
  const legacyHealResources: ResourceValidationEntry[] = []
  const pendingValidationResources: ResourceValidationEntry[] = []
  const pendingRepairResources: ResourceValidationEntry[] = []

  const delayedIds: string[] = []

  for (const res of items) {
    const entry = settled.get(res.resource_id)
    if (entry) {
      host.fastReadySnapshot.set(res.resource_id, entry)
      if (entry.status === 'ready_fast') {
        readyResources.push(entry)
      } else if (entry.status === 'legacy_heal') {
        legacyHealResources.push(entry)
      } else if (entry.status === 'pending_repair' || entry.status === 'unknown_resource') {
        pendingRepairResources.push(entry)
      } else {
        pendingValidationResources.push(entry)
      }
    } else {
      // 分支 4: 超出预算落入 pending_validation（绝不写入首轮挂载清单，UI 呈「正在校验插件」）
      const pendingEntry: ResourceValidationEntry = {
        resourceId: res.resource_id,
        sharedSubDir: resolveSharedSubDir(res.resource_id),
        physicalDir: null,
        status: 'pending_validation',
        validationLevel: 'full',
        reason: 'fast_barrier_timeout',
        checkedAt: Date.now()
      }
      host.fastReadySnapshot.set(res.resource_id, pendingEntry)
      pendingValidationResources.push(pendingEntry)
      delayedIds.push(res.resource_id)
    }
  }

  // 对 legacy_heal 或超时转入 pending_validation 的资产，后台无感计算全量校验与热刷新
  if (legacyUpgradeTargets.size > 0 || delayedIds.length > 0) {
    const targets = new Set([...legacyUpgradeTargets, ...delayedIds])
    if (delayedIds.length > 0) {
      allWorkPromise
        .catch(() => {})
        .then(() => {
          host.scheduleBackgroundFullVerification(Array.from(targets), 10)
        })
    } else {
      host.scheduleBackgroundFullVerification(Array.from(targets), 50)
    }
  }

  return {
    rootStatus: 'ready',
    readyResources,
    legacyHealResources,
    pendingValidationResources,
    pendingRepairResources,
    timedOut,
    elapsedMs: Date.now() - startMs
  }
}

/**
 * 后台全量验证与 `.ready.json` 平滑升级调度器：
 * - 校验 BOM 文件 SHA-256 或生成完整目录内容摘要写入正式 `.ready.json`
 * - 发现损坏则隔离为 `pending_repair`
 * - 从 `pending_validation` 转正或状态改变后，自动通过协调器尾沿合并触发 Omni 热刷新
 */
export function mrBarrierScheduleBackgroundFullVerification(
  host: any,
  resourceIds: string[],
  delayMs = 50
): Promise<void> {
  if (resourceIds.length === 0) {
    return Promise.resolve()
  }
  const runTask = async () => {
    await host.processBackgroundVerification(resourceIds)
  }
  if (delayMs <= 0) {
    return runTask()
  }
  return new Promise<void>(resolve => {
    if (host.bgVerificationTimer) {
      clearTimeout(host.bgVerificationTimer)
    }
    host.bgVerificationTimer = setTimeout(() => {
      host.bgVerificationTimer = null
      runTask().finally(resolve)
    }, delayMs)
    host.bgVerificationTimer.unref?.()
  })
}

export async function mrBarrierProcessBackgroundVerification(
  host: any,
  resourceIds: string[]
): Promise<void> {
  if (host.bgVerificationInFlight) {
    await host.bgVerificationInFlight.catch(() => {})
  }

  const work = (async () => {
    try {
      const dao: ModularResourceDao = host.getDao()
      const pluginsRootDir = host.getPluginsRootDir()
      let topologyNeedsRefresh = false

      for (const resourceId of resourceIds) {
        const res = dao.resources.findByIdSync(resourceId)
        if (!res || res.download_state === 'pending_delete') continue

        const sharedSubDir = resolveSharedSubDir(resourceId)
        const catalogMeta = (
          BUILTIN_PLUGIN_CATALOG_META as Record<
            string,
            {
              sharedSubDir: string
              requiredFileGroups: readonly (readonly string[])[]
              minPrimaryFileBytes?: number
            }
          >
        )[resourceId]

        let targetDir: string
        try {
          targetDir = resolvePhysicalPath(pluginsRootDir, res.target_local_path)
        } catch (err: any) {
          host.fastReadySnapshot.set(resourceId, {
            resourceId,
            sharedSubDir,
            physicalDir: null,
            status: 'pending_repair',
            validationLevel: 'full',
            reason: err?.message || 'invalid_path',
            checkedAt: Date.now()
          })
          continue
        }

        const prevStatus = host.fastReadySnapshot.get(resourceId)?.status
        const expectedFiles = host.loadBomFilesForResource(resourceId)
        let valid = false

        try {
          const filesOk = await PluginPathResolver.checkRequiredFileGroupsAsync(
            targetDir,
            catalogMeta?.requiredFileGroups,
            catalogMeta?.minPrimaryFileBytes ?? 1
          )
          if (filesOk) {
            if (expectedFiles.length > 0) {
              valid = true
              for (const ef of expectedFiles) {
                const filePath = path.join(targetDir, ef.name)
                if (!fs.existsSync(filePath)) {
                  valid = false
                  break
                }
                const st = await fs.promises.stat(filePath)
                if (st.size !== ef.size) {
                  valid = false
                  break
                }
                const shaRes = await streamVerifySha256(filePath, ef.sha256)
                if (!shaRes.valid) {
                  valid = false
                  break
                }
              }
            } else {
              valid = true
            }
          }
        } catch {
          valid = false
        }

        if (valid) {
          try {
            const marked = await host.writeReadyMarkerGuardedForVisual(
              targetDir,
              resourceId,
              sharedSubDir
            )
            if (!marked) {
              await invalidateReadyMarkers(targetDir).catch(() => {})
              await host.isolateCorruptDirectory(targetDir)
              continue
            }
            host.fastReadySnapshot.set(resourceId, {
              resourceId,
              sharedSubDir,
              physicalDir: targetDir,
              status: 'ready_fast',
              validationLevel: 'full',
              checkedAt: Date.now()
            })
            if (prevStatus === 'pending_validation') {
              topologyNeedsRefresh = true
            }
          } catch (writeErr: any) {
            logger.warn(
              LogCategory.SYSTEM,
              `[ModularResource] 后台升级 .ready.json 失败: ${resourceId}`,
              writeErr
            )
          }
        } else {
          await invalidateReadyMarkers(targetDir).catch(() => {})
          await host.isolateCorruptDirectory(targetDir)
          host.fastReadySnapshot.set(resourceId, {
            resourceId,
            sharedSubDir,
            physicalDir: null,
            status: 'pending_repair',
            validationLevel: 'full',
            reason: 'background_verification_failed',
            checkedAt: Date.now()
          })
          if (prevStatus === 'legacy_heal' || prevStatus === 'ready_fast') {
            topologyNeedsRefresh = true
          }
        }
      }

      if (topologyNeedsRefresh) {
        await host.notifyRuntimePluginTopologyChanged({
          reason: 'background_verified',
          restartPolicy: 'restart'
        })
      }
    } catch (err: any) {
      logger.warn(LogCategory.SYSTEM, '[ModularResource] 后台全量校验异常:', err)
    }
  })()

  host.bgVerificationInFlight = work
  try {
    await work
  } finally {
    if (host.bgVerificationInFlight === work) {
      host.bgVerificationInFlight = null
    }
  }
}

/**
 * 返回当前可进入 active-mounts-*.json 的已就绪域 B 资源快照
 * （仅允许处于 active 模块且状态为 ready_fast 或 legacy_heal 的非修复资源）
 */
export function mrBarrierGetMountableResourcesSnapshot(host: any): Array<
  ResourceValidationEntry & {
    catalogMeta?: (typeof BUILTIN_PLUGIN_CATALOG_META)[BuiltinSharedResourceId]
  }
> {
  if (host.rootUnavailable) {
    return []
  }
  const dao: ModularResourceDao = host.getDao()
  const pluginsRootDir = host.getPluginsRootDir()
  const activeModules = dao.modules.findActiveSync()
  const activeResourceIds = new Set<string>()
  const resMap = new Map<string, ResourceDownloadRecord>()

  for (const mod of activeModules) {
    for (const res of dao.resources.findResourcesByModuleSync(mod.id)) {
      if (res.download_state !== 'pending_delete') {
        activeResourceIds.add(res.resource_id)
        resMap.set(res.resource_id, res)
      }
    }
  }

  const result: Array<
    ResourceValidationEntry & {
      catalogMeta?: (typeof BUILTIN_PLUGIN_CATALOG_META)[BuiltinSharedResourceId]
    }
  > = []

  for (const resId of activeResourceIds) {
    if (host.repairPendingResources.has(resId) || host.unknownResources.has(resId)) {
      continue
    }
    const res = resMap.get(resId)!
    const catMeta = (
      BUILTIN_PLUGIN_CATALOG_META as Record<
        string,
        (typeof BUILTIN_PLUGIN_CATALOG_META)[BuiltinSharedResourceId]
      >
    )[resId]
    if (!catMeta) continue

    let snap = host.fastReadySnapshot.get(resId)
    if (!snap) {
      // 若冷启动尚未运行过 barrier，按当前磁盘严格 .ready.json 门禁实时核验
      try {
        const resolvedDir = resolvePhysicalPath(pluginsRootDir, res.target_local_path)
        const readyDir = PluginPathResolver.getReadySharedResourceDirForRoot(
          pluginsRootDir,
          catMeta.sharedSubDir,
          {
            requiredFileGroups: catMeta.requiredFileGroups,
            minPrimaryFileBytes: catMeta.minPrimaryFileBytes
          }
        )
        if (readyDir && resolvedDir) {
          snap = {
            resourceId: resId,
            sharedSubDir: catMeta.sharedSubDir,
            physicalDir: readyDir,
            status: 'ready_fast',
            validationLevel: 'full',
            checkedAt: Date.now()
          }
          host.fastReadySnapshot.set(resId, snap)
        }
      } catch (err) {
        logger.error(
          LogCategory.SYSTEM,
          `[ModularResource] 读取挂载资源路径失败 (Fail-Closed): ${resId}`,
          err
        )
        continue
      }
    }

    if (
      snap &&
      (snap.status === 'ready_fast' || snap.status === 'legacy_heal') &&
      snap.physicalDir
    ) {
      if (!fs.existsSync(snap.physicalDir)) {
        logger.warn(
          LogCategory.SYSTEM,
          `[ModularResource] 快照中的物理资源目录不存在，执行 Fail-Closed 隔离: ${resId} (${snap.physicalDir})`
        )
        host.fastReadySnapshot.delete(resId)
        host.repairPendingResources.add(resId)
        continue
      }

      result.push({
        ...snap,
        catalogMeta: catMeta
      })
    }
  }

  return result
}

/**
 * 运行时插件拓扑变更统一通知入口（经过 RuntimeTopologyCoordinator 尾沿去重并发往 Omni/VoiceCache）
 */
export async function mrBarrierNotifyRuntimePluginTopologyChanged(
  host: any,
  reasonOrOpts?: string | TopologyChangeNotificationOptions
): Promise<void> {
  const opts: TopologyChangeNotificationOptions =
    typeof reasonOrOpts === 'string'
      ? { moduleId: reasonOrOpts, reason: 'module_change', restartPolicy: 'ensure-running' }
      : {
          reason: 'module_change',
          restartPolicy: 'restart',
          ...reasonOrOpts
        }

  // 失效语音音色内存缓存，确保 voice_tts 槽位切换或卸载立即生效
  try {
    voiceArchiveService?.invalidatePresetVoicesCache?.()
  } catch (err) {
    logger.warn(LogCategory.SYSTEM, '[ModularResource] 失效语音音色缓存告警:', err)
  }

  const runNotify = async () => {
    if (host.topologyListener) {
      await host.topologyListener(opts)
      return
    }
    try {
      const { omniService } = await import('../system/omni-service')
      if (typeof omniService?.handleTopologyChanged === 'function') {
        await omniService.handleTopologyChanged({
          moduleId: opts.moduleId,
          reason: opts.reason || 'module_change',
          restartPolicy:
            opts.restartPolicy === 'stop-if-unused' ? 'none' : opts.restartPolicy || 'restart'
        })
      }
    } catch (err) {
      if (host.topologyListener) {
        throw err
      }
      // 在纯离线无 Omni 环境的单元测试中忽略模块加载失败，真实已启动环境 error 向上抛出
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('Cannot find module')) {
        throw err
      }
    }
  }

  await host.topologyCoordinator.coalesceTopologyNotify(runNotify)

  // DB 更新与插件拓扑全部落地后再派发稳定态事件，供对外接口协调器刷新动态能力集
  try {
    emitRuntimeContextChange('module_topology_settled')
  } catch (err) {
    logger.warn(LogCategory.SYSTEM, '[ModularResource] 派发 module_topology_settled 告警:', err)
  }
}
