/**
 * ModularResourceService 模块安装、后台下载队列与卸载逻辑
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
 * 幂等下载并安装模块（引用计数复用 -> Range 206 -> SHA-256 -> Zip Slip 解压 -> 原子 rename）
 */
export async function mrInstallerInstallModule(
  host: any,
  moduleId: string,
  onProgress?: (event: ModuleDownloadProgressEvent) => void,
  options?: { skipLocalPreset?: boolean }
): Promise<BuiltinModuleView> {
  host.assertWriteGateAllowed()
  host.ensureDefaultSeeds()
  emitRuntimeContextChange('module_installing')

  return await host.topologyCoordinator.execute(async () => {
    const dao: ModularResourceDao = host.getDao()
    const record = dao.modules.findByIdSync(moduleId)
    if (!record) {
      throw new Error(`未找到模块定义: ${moduleId}`)
    }

    // 1. 将模块置为 downloading
    dao.modules.updateInstallStateSync(moduleId, 'downloading')

    const resourceSpecs = host.resolveModuleResourceSpecs(record)
    if (resourceSpecs.length === 0) {
      // 无外部物理资产依赖的模块，按排他规则标记为 active 或 installed_inactive
      const slot = record.capability_slot ?? 'general'
      const policy = record.slot_policy ?? 'multi_active'
      const isExclusive = policy === 'exclusive_required' || policy === 'exclusive_optional'
      if (isExclusive) {
        const currentActive = dao.modules.findActiveBySlotSync(slot)
        if (currentActive && currentActive.id !== moduleId) {
          dao.modules.updateInstallStateSync(moduleId, 'installed_inactive')
        } else {
          dao.modules.activateExclusiveModuleSync(moduleId)
        }
      } else {
        dao.modules.updateInstallStateSync(moduleId, 'active')
      }
      host.liveProgress.delete(moduleId)
      host.invalidateUsedBytesCache(moduleId)
      return host.buildModuleView(dao.modules.findByIdSync(moduleId)!)
    }

    try {
      for (const spec of resourceSpecs) {
        const targetLocalPath =
          spec.target_local_path ||
          deriveTargetLocalPath(spec.resource_id) ||
          path.posix.join('modules', '_shared', spec.resource_id)
        const existingTask = dao.resources.findByIdSync(spec.resource_id)

        const task = existingTask
          ? existingTask
          : dao.resources.createOrGetTaskSync({
              resource_id: spec.resource_id,
              asset_name: spec.asset_name,
              target_local_path: targetLocalPath,
              active_source_key: spec.active_source_key ?? 'auto',
              active_url: spec.active_url ?? null,
              expected_bytes: spec.expected_bytes,
              expected_sha256: spec.expected_sha256,
              download_state: 'pending'
            })

        // 建立模块与物理资源的引用绑定
        dao.resources.bindResourceToModuleSync(moduleId, spec.resource_id)

        const targetAbsDir = host.resolvePhysicalPath(task.target_local_path)

        // 2. 确定性三级物理探活拓扑 (L1 目标解压目录 -> L2 本地预置包 -> L3 网络下载)
        // L1: 目标解压目录探活 (快路径毫秒放行 + 慢路径自愈补标记)
        const l1Result = await host.checkL1TargetDirPreflight(targetAbsDir, spec)
        if (l1Result === 'fast_hit' || l1Result === 'slow_healed') {
          dao.resources.markVerifiedSync(spec.resource_id, true)
          host.flushProgress(spec.resource_id, 'completed', spec.expected_bytes)
          host.repairPendingResources.delete(spec.resource_id)
          host.fastReadySnapshot.set(spec.resource_id, {
            resourceId: spec.resource_id,
            sharedSubDir: resolveSharedSubDir(spec.resource_id),
            physicalDir: targetAbsDir,
            status: 'ready_fast',
            validationLevel: 'full',
            checkedAt: Date.now()
          })

          if (l1Result === 'fast_hit') {
            // 后台异步低优先级流式 SHA-256 核验兜底
            const asyncVerifyPromise = (async () => {
              const expectedFiles = host.loadBomFilesForResource(spec.resource_id)
              for (const ef of expectedFiles) {
                const p = path.join(targetAbsDir, ef.name)
                if (!fs.existsSync(p)) return false
                const v = await streamVerifySha256(p, ef.sha256)
                if (!v.valid) {
                  await host.isolateCorruptDirectory(targetAbsDir)
                  host.fastReadySnapshot.set(spec.resource_id, {
                    resourceId: spec.resource_id,
                    sharedSubDir: resolveSharedSubDir(spec.resource_id),
                    physicalDir: null,
                    status: 'pending_repair',
                    validationLevel: 'full',
                    reason: 'background_bom_mismatch',
                    checkedAt: Date.now()
                  })
                  await host
                    .notifyRuntimePluginTopologyChanged({
                      moduleId,
                      reason: 'background_verified',
                      restartPolicy: 'restart'
                    })
                    .catch(() => {})
                  return false
                }
              }
              return true
            })()
            host.verificationPromises.set(moduleId, asyncVerifyPromise)
          }

          const completedEvt: ModuleDownloadProgressEvent = {
            moduleId,
            resourceId: spec.resource_id,
            downloadedBytes: spec.expected_bytes,
            expectedBytes: spec.expected_bytes,
            percentage: 100,
            speedBytesPerSec: 0,
            isResumed: false,
            state: 'completed'
          }
          host.liveProgress.set(moduleId, {
            percentage: 100,
            speed_bytes_per_sec: 0,
            is_resumed: false
          })
          onProgress?.(completedEvt)
          continue
        }

        // L2: 本地后备预置包打捞 (apps/desktop/build/presetResources 等)；
        // 当显式传入 skipLocalPreset 或全局开发环境变量 FIREFLY_SKIP_LOCAL_PRESET=1 时跳过，强制走真实网络下载测试
        const envSkipRaw = process.env.FIREFLY_SKIP_LOCAL_PRESET?.trim().toLowerCase()
        const envSkipLocalPreset =
          envSkipRaw === '1' || envSkipRaw === 'true' || envSkipRaw === 'yes' || envSkipRaw === 'on'
        const l2Hit =
          options?.skipLocalPreset || envSkipLocalPreset
            ? false
            : await host.checkL2LocalPresetPreflight(spec, targetAbsDir)
        if (l2Hit) {
          dao.resources.markVerifiedSync(spec.resource_id, true)
          host.flushProgress(spec.resource_id, 'completed', spec.expected_bytes)
          host.repairPendingResources.delete(spec.resource_id)
          host.fastReadySnapshot.set(spec.resource_id, {
            resourceId: spec.resource_id,
            sharedSubDir: resolveSharedSubDir(spec.resource_id),
            physicalDir: targetAbsDir,
            status: 'ready_fast',
            validationLevel: 'full',
            checkedAt: Date.now()
          })

          const completedEvt: ModuleDownloadProgressEvent = {
            moduleId,
            resourceId: spec.resource_id,
            downloadedBytes: spec.expected_bytes,
            expectedBytes: spec.expected_bytes,
            percentage: 100,
            speedBytesPerSec: 0,
            isResumed: false,
            state: 'completed'
          }
          host.liveProgress.set(moduleId, {
            percentage: 100,
            speed_bytes_per_sec: 0,
            is_resumed: false
          })
          onProgress?.(completedEvt)
          continue
        }

        // L3: 网络分块并发断点下载与 Singleflight 保护
        let flight = host.inFlightResources.get(spec.resource_id)
        if (!flight) {
          flight = host
            .downloadAndInstallSingleResource(moduleId, task, spec, onProgress)
            .finally(() => {
              host.inFlightResources.delete(spec.resource_id)
            })
          host.inFlightResources.set(spec.resource_id, flight)
        }
        await flight
      }

      // 5. 全部依赖资源就绪，将模块状态流转为 active 或 installed_inactive (若已有同槽位 active)
      const slot = record.capability_slot ?? 'general'
      const policy = record.slot_policy ?? 'multi_active'
      const isExclusive = policy === 'exclusive_required' || policy === 'exclusive_optional'
      let becameActive = false

      if (isExclusive) {
        const currentActive = dao.modules.findActiveBySlotSync(slot)
        if (currentActive && currentActive.id !== moduleId) {
          dao.modules.updateInstallStateSync(moduleId, 'installed_inactive')
        } else {
          dao.modules.activateExclusiveModuleSync(moduleId)
          becameActive = true
          if (slot === 'base_embedding') {
            const serving = dao.epochs.findServingEpochSync()
            if (!serving) {
              const isClassic = moduleId.includes('classic')
              dao.epochs.createEpochSync({
                epoch: 1,
                module_id: moduleId,
                text_dim: isClassic ? 384 : 768,
                image_dim: isClassic ? 512 : 768,
                status: 'serving',
                reindex_cursor: null
              })
            }
          }
        }
      } else {
        dao.modules.updateInstallStateSync(moduleId, 'active')
        becameActive = true
      }

      if (becameActive) {
        await host.notifyRuntimePluginTopologyChanged({
          moduleId,
          reason: 'module_install',
          restartPolicy: 'restart'
        })
        if (slot === 'base_embedding') {
          await host.syncEmbeddingProfileToConfig()
        }
      }

      host.liveProgress.delete(moduleId)
      host.invalidateUsedBytesCache(moduleId)
      return host.buildModuleView(dao.modules.findByIdSync(moduleId)!)
    } catch (err: any) {
      const errorMsg = err?.message || String(err)
      const latest = dao.modules.findByIdSync(moduleId)
      // 若所有资源实际上已下载完毕、仅在通知激活阶段出错，保留 installed_inactive 以免丢失已下载权重
      const bound = dao.resources.findResourcesByModuleSync(moduleId)
      const allResourcesCompleted =
        bound.length > 0 && bound.every((r: any) => r.download_state === 'completed')
      dao.modules.updateInstallStateSync(
        moduleId,
        allResourcesCompleted && latest?.install_state !== 'downloading'
          ? 'installed_inactive'
          : 'error',
        errorMsg
      )
      host.liveProgress.delete(moduleId)
      throw err
    }
  })
}

/**
 * 将选配模块加入后台静默安装队列（单实例串行 Singleflight，支持跨上下文接管）
 */
export async function mrInstallerEnqueueBackgroundInstalls(
  host: any,
  moduleIds: string[]
): Promise<string[]> {
  host.assertWriteGateAllowed()
  host.ensureDefaultSeeds()
  const dao: ModularResourceDao = host.getDao()
  const validIds: string[] = []

  for (const id of moduleIds) {
    if (!id || typeof id !== 'string') continue
    const rec = dao.modules.findByIdSync(id)
    if (rec && rec.install_state === 'active') {
      continue // 已激活的无需重复安装
    }
    if (!host.backgroundInstallQueue.includes(id)) {
      host.backgroundInstallQueue.push(id)
      validIds.push(id)
      if (!rec || rec.install_state !== 'downloading') {
        dao.modules.updateInstallStateSync(id, 'downloading')
      }
      if (!host.liveProgress.has(id)) {
        host.liveProgress.set(id, {
          percentage: 0,
          speed_bytes_per_sec: 0,
          is_resumed: false
        })
      }
      host.backgroundProgressBroadcaster?.({
        moduleId: id,
        resourceId: '',
        downloadedBytes: 0,
        expectedBytes: 0,
        percentage: 0,
        speedBytesPerSec: 0,
        isResumed: false,
        state: 'downloading'
      })
    }
  }

  if (!host.isProcessingBackgroundQueue && host.backgroundInstallQueue.length > 0) {
    void host.processBackgroundInstallQueue()
  }

  return validIds
}

/**
 * 顺序处理后台安装队列
 */
export async function mrInstallerProcessBackgroundInstallQueue(host: any): Promise<void> {
  if (host.isProcessingBackgroundQueue) return
  host.isProcessingBackgroundQueue = true

  try {
    while (host.backgroundInstallQueue.length > 0) {
      const nextId = host.backgroundInstallQueue.shift()!
      host.activeInstallingModuleId = nextId
      try {
        logger.debug(
          LogCategory.SYSTEM,
          `[ModularResource] 开始执行后台选配插件静默安装: ${nextId}`
        )
        await host.installModule(nextId, (progressEvt: ModuleDownloadProgressEvent) => {
          host.backgroundProgressBroadcaster?.(progressEvt)
        })
        // installModule 返回代表激活与底座挂载已彻底完成，再补发一次最终态同步事件，确保前端立刻从「下载/激活中」切为已激活
        host.backgroundProgressBroadcaster?.({
          moduleId: nextId,
          resourceId: '',
          downloadedBytes: 0,
          expectedBytes: 0,
          percentage: 100,
          speedBytesPerSec: 0,
          isResumed: false,
          state: 'completed'
        })
        logger.debug(LogCategory.SYSTEM, `[ModularResource] 后台选配插件安装就绪并激活: ${nextId}`)
      } catch (err: any) {
        // 后台选配安装失败必须显式上浮（禁止静默降级）：
        // 用户在向导里看不到任何提示，只有事后到插件中心才发现插件根本没装上。
        // 这里以 error 级别记录，并依赖 installModule 已写入的 install_state='error'
        // + error_message，让插件中心直接展示失败原因与「重新下载安装」入口。
        logger.error(LogCategory.SYSTEM, `[ModularResource] 后台选配插件安装失败 (${nextId}):`, err)
        host.backgroundProgressBroadcaster?.({
          moduleId: nextId,
          resourceId: '',
          downloadedBytes: 0,
          expectedBytes: 0,
          percentage: 0,
          speedBytesPerSec: 0,
          isResumed: false,
          state: 'failed',
          errorMessage: err?.message || String(err)
        })
      } finally {
        host.activeInstallingModuleId = null
      }
    }
  } finally {
    host.activeInstallingModuleId = null
    host.isProcessingBackgroundQueue = false
  }
}

/**
 * 执行单个物理资源的下载、流式 SHA-256 校验、安全解压与状态落库
 */
export async function mrInstallerDownloadAndInstallSingleResource(
  host: any,
  moduleId: string,
  task: ResourceDownloadRecord,
  spec: CatalogResourceSpec,
  onProgress?: (event: ModuleDownloadProgressEvent) => void
): Promise<void> {
  const dao: ModularResourceDao = host.getDao()
  const isIntl = resolveAppRegion() === 'intl'
  const candidateUrls: string[] = []

  const builtinMeta =
    BUILTIN_PLUGIN_CATALOG_META[spec.resource_id as BuiltinSharedResourceId] ||
    BUILTIN_PLUGIN_CATALOG_META[task.resource_id as BuiltinSharedResourceId]

  const isOfficialPreset =
    Boolean(builtinMeta) &&
    (!spec.active_url || spec.active_url === builtinMeta.defaultActiveUrl) &&
    (!task.active_url || task.active_url === builtinMeta.defaultActiveUrl)

  if (isOfficialPreset && builtinMeta) {
    const assetName = builtinMeta.assetName || task.asset_name || spec.asset_name
    const shaTag = (task.expected_sha256 || spec.expected_sha256 || '').trim().slice(0, 8)
    const githubUrl =
      builtinMeta.defaultActiveUrl ||
      (assetName
        ? `https://github.com/Leonard-Li777/firefly-resources/releases/download/resources/${assetName}`
        : null)
    // R2 文件名以发布源（defaultActiveUrl）的文件名为准，避免 sensevoice-onnx / moss-tts 等沿用旧 assetName 导致 404
    let r2AssetName = assetName
    if (githubUrl) {
      try {
        const base = path.posix.basename(new URL(githubUrl).pathname)
        if (base.endsWith('.zip') || base.endsWith('.ffp')) {
          r2AssetName = base
        }
      } catch {}
    }
    const r2Url = r2AssetName
      ? `https://download.iocn.cn/firefly-resources/${r2AssetName}${shaTag ? `?v=${shaTag}` : ''}`
      : null

    // 双轨下载调度策略（对齐 engine 资源下载）：
    // - 国际版 (intl): 海外网络环境优先直连 GitHub Releases，若失败/超时平滑回退 R2 CDN；
    // - 国内版 (cn): 国内优先腾讯云 EdgeOne CDN 加速的 R2 镜像，若失败平滑回退 GitHub Releases。
    if (isIntl) {
      if (githubUrl) candidateUrls.push(githubUrl)
      if (r2Url && !candidateUrls.includes(r2Url)) candidateUrls.push(r2Url)
    } else {
      if (r2Url) candidateUrls.push(r2Url)
      if (githubUrl && !candidateUrls.includes(githubUrl)) candidateUrls.push(githubUrl)
    }
  } else {
    if (spec.active_url) candidateUrls.push(spec.active_url)
    if (task.active_url && !candidateUrls.includes(task.active_url)) {
      candidateUrls.push(task.active_url)
    }
  }

  // 收集额外的备选 URL（如有）
  const rawUrls: string[] = []
  if (task.active_url && !candidateUrls.includes(task.active_url)) rawUrls.push(task.active_url)
  if (spec.active_url && !candidateUrls.includes(spec.active_url)) rawUrls.push(spec.active_url)
  if (Array.isArray((spec as any).urls)) {
    for (const u of (spec as any).urls) {
      if (u && !rawUrls.includes(u) && !candidateUrls.includes(u)) rawUrls.push(u)
    }
  }
  if (Array.isArray((task as any).urls)) {
    for (const u of (task as any).urls) {
      if (u && !rawUrls.includes(u) && !candidateUrls.includes(u)) rawUrls.push(u)
    }
  }
  for (const u of rawUrls) {
    candidateUrls.push(u)
  }

  if (candidateUrls.length === 0) {
    dao.resources.markVerifiedSync(
      task.resource_id,
      false,
      undefined,
      'MISSING_ACTIVE_DOWNLOAD_URL'
    )
    throw new Error(`MISSING_ACTIVE_DOWNLOAD_URL: ${task.resource_id}`)
  }

  const archivePath = host.resolveDownloadArchivePath(task.resource_id, task.asset_name)
  const partPath = `${archivePath}.part`
  const hadPartBefore = fs.existsSync(partPath) && fs.statSync(partPath).size > 0
  const targetAbsDir = host.resolvePhysicalPath(task.target_local_path)

  // ISS-12: 动态磁盘门禁扣减检查
  const partDiskBytes = fs.existsSync(partPath) ? fs.statSync(partPath).size : 0
  const diskCheck = checkDiskSpace(targetAbsDir, {
    archiveBytes: task.expected_bytes,
    existingPartDiskBytes: partDiskBytes,
    maxUncompressedBytes: Math.round(task.expected_bytes * 1.5),
    isLocalPreset: false
  })
  if (!diskCheck.sufficient) {
    const errMsg = `ENOSPC: 磁盘剩余空间不足 (需要 ${(diskCheck.requiredBytes / 1024 / 1024).toFixed(1)}MB, 可用 ${(diskCheck.availableBytes / 1024 / 1024).toFixed(1)}MB)`
    dao.resources.markVerifiedSync(task.resource_id, false, undefined, errMsg)
    throw new Error(errMsg)
  }

  host.flushProgress(task.resource_id, 'downloading', task.downloaded_bytes || 0)

  // 大文件（>4MiB）且存在可用 URL 时，默认优先启用固定 4MiB 块网格并发断点续传下载器
  const canUseFixedBlocks =
    typeof host.downloadService.downloadWithFixedBlocks === 'function' &&
    candidateUrls.length > 0 &&
    task.expected_bytes > 4 * 1024 * 1024

  let result: VerifiedDownloadResult | null = null

  if (canUseFixedBlocks) {
    logger.debug(
      LogCategory.SYSTEM,
      `[Download] 启用固定 4MiB 块网格并发断点续传下载器 (${task.resource_id}, expected: ${(task.expected_bytes / 1024 / 1024).toFixed(1)}MB, 候选源: ${candidateUrls.length})`
    )
    try {
      result = await host.downloadService.downloadWithFixedBlocks({
        taskId: `${moduleId}:${task.resource_id}`,
        assetId: task.resource_id,
        urls: candidateUrls,
        destPath: archivePath,
        expectedBytes: task.expected_bytes,
        expectedSha256: task.expected_sha256,
        maxConcurrency: 8,
        maxInflightBlocks: 8,
        router: host.sourceRouter,
        transport: host.transport,
        onProgress: (prog: { receivedBytes: number; totalBytes?: number; speed: number }) => {
          // ISS-13: 字节加权下载阶段 0 ~ 92%
          const total = prog.totalBytes || task.expected_bytes || 1
          const pct = Math.min(92, Math.round((prog.receivedBytes / total) * 92))
          host.recordDownloadProgress(
            moduleId,
            task.resource_id,
            prog.receivedBytes,
            pct,
            prog.speed,
            hadPartBefore
          )
          onProgress?.({
            moduleId,
            resourceId: task.resource_id,
            downloadedBytes: prog.receivedBytes,
            expectedBytes: total,
            percentage: pct,
            speedBytesPerSec: prog.speed,
            isResumed: hadPartBefore,
            state: 'downloading'
          })
        }
      })
      if (!result || !result.success) {
        logger.warn(
          LogCategory.SYSTEM,
          `[Download] 并发分块下载未成功 (${task.resource_id}): ${result?.errorMessage || result?.errorCode}，平滑降级至单流重试下载...`
        )
        result = null
      }
    } catch (blockErr: any) {
      logger.warn(
        LogCategory.SYSTEM,
        `[Download] 并发分块下载异常 (${task.resource_id}): ${blockErr.message}，平滑降级至单流重试下载...`
      )
      result = null
    }
  }

  if (!result) {
    let lastDownloadError: any = null
    let successfulResult: VerifiedDownloadResult | null = null

    for (let i = 0; i < candidateUrls.length; i++) {
      const currentUrl = candidateUrls[i]
      logger.debug(
        LogCategory.SYSTEM,
        `[Download] 尝试下载源 [${i + 1}/${candidateUrls.length}] (${task.resource_id}): ${currentUrl}`
      )
      try {
        const attempt = await host.downloadService.downloadWithVerification({
          taskId: `${moduleId}:${task.resource_id}`,
          url: currentUrl,
          destPath: archivePath,
          expectedBytes: task.expected_bytes,
          expectedSha256: task.expected_sha256,
          etag: task.etag ?? undefined,
          transport: host.transport,
          onProgress: (prog: { receivedBytes: number; totalBytes?: number; speed: number }) => {
            const total = prog.totalBytes || task.expected_bytes || 1
            const pct = Math.min(92, Math.round((prog.receivedBytes / total) * 92))
            host.recordDownloadProgress(
              moduleId,
              task.resource_id,
              prog.receivedBytes,
              pct,
              prog.speed,
              hadPartBefore
            )
            onProgress?.({
              moduleId,
              resourceId: task.resource_id,
              downloadedBytes: prog.receivedBytes,
              expectedBytes: total,
              percentage: pct,
              speedBytesPerSec: prog.speed,
              isResumed: hadPartBefore,
              state: 'downloading'
            })
          }
        })

        if (attempt && attempt.success) {
          successfulResult = attempt
          break
        } else {
          const failReason = attempt?.errorMessage || attempt?.errorCode || '校验未通过'
          lastDownloadError = new Error(failReason)
          logger.warn(
            LogCategory.SYSTEM,
            `[Download] 源未成功 (${currentUrl}): ${failReason}${i < candidateUrls.length - 1 ? '，平滑回退下一个备用源...' : ''}`
          )
        }
      } catch (downloadErr: any) {
        lastDownloadError = downloadErr
        logger.warn(
          LogCategory.SYSTEM,
          `[Download] 源异常 (${currentUrl}): ${downloadErr.message}${i < candidateUrls.length - 1 ? '，平滑回退下一个备用源...' : ''}`
        )
      }
    }

    if (!successfulResult) {
      throw lastDownloadError || new Error(`所有可用下载源均失败: ${task.resource_id}`)
    }
    result = successfulResult
  }

  if (result.etag || result.lastModified) {
    dao.resources.updateHeadersSync(task.resource_id, result.etag, result.lastModified)
  }

  if (!result.success) {
    const errMsg = result.errorMessage || result.errorCode || '资源下载或校验失败'
    // 失败即状态跃迁：必须先经节流镜像立即落盘 failed 并树终态哨兵，
    // 否则 in-flight 迟到回调会把 DB 状态覆盖回 downloading。
    host.flushProgress(task.resource_id, 'failed', result.finalBytes, errMsg)
    dao.resources.markVerifiedSync(
      task.resource_id,
      false,
      result.actualSha256 || undefined,
      errMsg
    )
    onProgress?.({
      moduleId,
      resourceId: task.resource_id,
      downloadedBytes: result.finalBytes,
      expectedBytes: task.expected_bytes,
      percentage: 0,
      speedBytesPerSec: 0,
      isResumed: Boolean(result.isResumed),
      state: 'failed',
      errorMessage: errMsg
    })
    throw new Error(errMsg)
  }

  // 4. 若为 .zip 或 .ffp 归档，调用 safeExtractZip（视觉插件走暂存 .txn.json 事务与 Omni 同源校验+回滚闭环）
  const lowerAsset = task.asset_name.toLowerCase()
  const intentsDir = path.join(host.getBaseDir(), '.intents')
  const sharedSubDir = resolveSharedSubDir(task.resource_id)
  try {
    const useVisualTxn = isVisualVocabPluginResource(task.resource_id)
    const stagingDir = useVisualTxn
      ? path.join(
          host.getPluginsRootDir(),
          '_staging',
          `install-${task.resource_id}-${process.pid}-${Date.now()}`
        )
      : targetAbsDir

    if (useVisualTxn) {
      if (fs.existsSync(stagingDir)) {
        fs.rmSync(stagingDir, { recursive: true, force: true })
      }
      fs.mkdirSync(stagingDir, { recursive: true })
    } else {
      // 物化写入前先使目标目录既有 .ready* 标记失效，严防 TOCTOU 读取半成品
      await invalidateReadyMarkers(targetAbsDir)
    }

    if (lowerAsset.endsWith('.zip') || lowerAsset.endsWith('.ffp')) {
      onProgress?.({
        moduleId,
        resourceId: task.resource_id,
        downloadedBytes: result.finalBytes,
        expectedBytes: task.expected_bytes,
        percentage: 95,
        speedBytesPerSec: 0,
        isResumed: Boolean(result.isResumed),
        state: 'extracting'
      })
      await safeExtractZip(archivePath, stagingDir, intentsDir)
      // 解压成功后清理归档包临时文件
      if (fs.existsSync(archivePath)) {
        try {
          fs.unlinkSync(archivePath)
        } catch {
          // ignore
        }
      }
    } else {
      // 非压缩包单文件资源：直接移入目标/暂存目录 (使用 renameWithRetry 防止杀软冲突)
      if (!fs.existsSync(stagingDir)) {
        fs.mkdirSync(stagingDir, { recursive: true })
      }
      const destFile = path.join(stagingDir, task.asset_name)
      if (fs.existsSync(destFile)) {
        fs.unlinkSync(destFile)
      }
      await renameWithRetry(archivePath, destFile)
    }

    if (useVisualTxn) {
      const txnRes = await commitPluginDirectoryWithTxn({
        intentsDir,
        resourceId: task.resource_id,
        sharedSubDir,
        stagingDir,
        destDir: targetAbsDir,
        targetMode: 'install',
        verifyFn: host.resolveDefaultVerifyVisualVocabFn(),
        reloadAssetsFn: host.resolveDefaultReloadAssetsFn()
      })
      if (!txnRes.ok) {
        throw new Error(txnRes.error || `视觉插件原子安装事务失败: ${task.resource_id}`)
      }
    } else {
      // 解压或单文件物化成功后，统一计算确定性 SHA-256 摘要并原子写入标准 .ready.json
      await writePluginReadyMarkerWithVisualVocab(targetAbsDir, {
        resourceId: task.resource_id,
        sharedSubDir
      })
    }
    host.repairPendingResources.delete(task.resource_id)
    host.fastReadySnapshot.set(task.resource_id, {
      resourceId: task.resource_id,
      sharedSubDir,
      physicalDir: targetAbsDir,
      status: 'ready_fast',
      validationLevel: 'full',
      checkedAt: Date.now()
    })
  } catch (extractErr: any) {
    const errMsg = extractErr?.message || String(extractErr)
    host.flushProgress(task.resource_id, 'failed', result.finalBytes, errMsg)
    dao.resources.markVerifiedSync(task.resource_id, false, result.actualSha256, errMsg)
    if (fs.existsSync(archivePath)) {
      try {
        fs.unlinkSync(archivePath)
      } catch {
        // ignore
      }
    }
    throw extractErr
  }

  // 5. 标记资源已完成验证并落库 actual_sha256
  let finalSha256 = result.actualSha256
  if (!finalSha256 && task.expected_sha256) {
    finalSha256 = task.expected_sha256
  }
  host.flushProgress(task.resource_id, 'completed', result.finalBytes)
  dao.resources.markVerifiedSync(task.resource_id, true, finalSha256)

  onProgress?.({
    moduleId,
    resourceId: task.resource_id,
    downloadedBytes: result.finalBytes,
    expectedBytes: task.expected_bytes,
    percentage: 100,
    speedBytesPerSec: 0,
    isResumed: Boolean(result.isResumed),
    state: 'completed'
  })
}

/**
 * 卸载模块并通知安全停机释放文件句柄
 */
export async function mrInstallerStopOmniProcessForUninstall(host: any): Promise<boolean> {
  try {
    const { omniService } = await import('../system/omni-service')
    if (omniService?.isManagedLifecycleActive?.()) {
      await omniService.stop()
      return true
    }
  } catch (err) {
    logger.warn(LogCategory.SYSTEM, '[ModularResource] 卸载前停机 Omni 服务告警:', err)
  }
  return false
}

/**
 * 激活门禁核验：确认模块绑定物理资产已完整落盘（允许 engine_classic_light 在可选伴随资源 mobile-clip 未到位时保活）
 */
export async function mrInstallerAssertModuleResourcesReadyForActivation(
  host: any,
  moduleId: string,
  record: BuiltinModuleRecord
): Promise<void> {
  const dao: ModularResourceDao = host.getDao()
  const boundResources = dao.resources.findResourcesByModuleSync(moduleId)
  const specs = host.resolveModuleResourceSpecs(record)
  if (boundResources.length === 0 && specs.length === 0) {
    return
  }

  const pluginsRootDir = host.getPluginsRootDir()
  const coreReadyForClassic =
    moduleId === 'engine_classic_light' && host.isClassicEngineCoreReady(boundResources)

  for (const res of boundResources) {
    if (host.repairPendingResources.has(res.resource_id)) {
      throw new Error(`模块资源处于待修复状态，禁止激活: ${moduleId}/${res.resource_id}`)
    }
    if (res.download_state !== 'completed') {
      const currentLang = host.getConfigOrchestrator()?.getValue?.('DEFAULT_LANGUAGE') || 'zh-CN'
      const isZh = String(currentLang).toLowerCase().startsWith('zh')
      if (
        moduleId === 'engine_classic_light' &&
        ((res.resource_id === 'mobile-clip' && isZh) ||
          (res.resource_id === 'chinese-clip' && !isZh)) &&
        coreReadyForClassic
      ) {
        continue
      }
      throw new Error(`模块资源尚未下载完成 (${res.download_state}): ${res.resource_id}`)
    }

    const targetDir = resolvePhysicalPath(pluginsRootDir, res.target_local_path)
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

    const filesOk = await PluginPathResolver.checkRequiredFileGroupsAsync(
      targetDir,
      catalogMeta?.requiredFileGroups,
      catalogMeta?.minPrimaryFileBytes ?? 1
    )
    if (!filesOk) {
      throw new Error(`模块权重文件缺失或被截断，无法激活: ${res.resource_id}`)
    }

    const sharedSubDir = resolveSharedSubDir(res.resource_id)
    const marker = await readReadyMarker(targetDir)
    if (!marker || marker.resourceId !== res.resource_id) {
      // 若特征文件组有效但尚未补齐 .ready.json，记录为 legacy_heal 放行并触发后台升级
      host.fastReadySnapshot.set(res.resource_id, {
        resourceId: res.resource_id,
        sharedSubDir,
        physicalDir: targetDir,
        status: 'legacy_heal',
        validationLevel: 'legacy',
        checkedAt: Date.now()
      })
      host.scheduleBackgroundFullVerification([res.resource_id], 50)
    } else {
      host.fastReadySnapshot.set(res.resource_id, {
        resourceId: res.resource_id,
        sharedSubDir,
        physicalDir: targetDir,
        status: 'ready_fast',
        validationLevel: 'full',
        checkedAt: Date.now()
      })
    }
  }
}

/**
 * 检索指定必选底座同槽位下所有处于健康可服役状态的备选模块 (Ready Backup)
 *
 * @doc-anchor: docs/specs/plugin-center-slots-exclusivity-and-lifecycle-spec.md#25-插件全生命周期管控停用与两阶段卸载回收-lifecycle-management
 */
export function mrInstallerFindReadyBackupModulesSync(
  host: any,
  record: BuiltinModuleRecord
): BuiltinModuleRecord[] {
  const dao: ModularResourceDao = host.getDao()
  const slot = record.capability_slot
  if (!slot) return []

  const siblings = dao.modules
    .listAllSync({ includeDraft: true })
    .filter(m => m.capability_slot === slot && m.id !== record.id)

  return siblings.filter(candidate => {
    // 仅处于已安装就绪态或已激活态才具接替资格；crashed 置错或未安装/下载中严禁接替
    if (candidate.install_state !== 'installed_inactive' && candidate.install_state !== 'active') {
      return false
    }
    if (
      candidate.availability === 'coming_soon' ||
      candidate.availability === 'delisted' ||
      candidate.delist_reason === 'security_violation'
    ) {
      return false
    }
    if (candidate.error_message) {
      return false
    }
    const holds = host.processManager ? host.processManager.getHoldReasons(candidate.id) : []
    if (holds.length > 0) {
      return false
    }
    const resList = dao.resources.findResourcesByModuleSync(candidate.id)
    for (const res of resList) {
      if (res.download_state !== 'completed') {
        return false
      }
      const snap = host.fastReadySnapshot.get(res.resource_id)
      if (snap && (snap.status === 'pending_repair' || snap.status === 'unknown_resource')) {
        return false
      }
    }
    return true
  })
}

/**
 * 卸载模块（Windows 两阶段停机解锁 + Tombstone 单步隔离删除协议）：
 * 阶段一（前置防空拦截与事务内接替/解绑）：必选底座无就绪备选时坚决拦截；存在备选时同一事务内原子提升备选并解绑旧项；
 * 阶段二（停机释放句柄 + 原子隔离删除）：先停用关联进程与 Omni 引擎解除 ORT mmap 句柄，再单步重命名为 .deleting-* 并异步回收；
 * 阶段三（重启对齐拓扑）：刷新挂载清单与音色缓存，或拉起接替备选底座。
 */
export async function mrInstallerUninstallModule(
  host: any,
  moduleId: string
): Promise<BuiltinModuleView> {
  host.assertWriteGateAllowed()
  host.ensureDefaultSeeds()
  emitRuntimeContextChange('module_uninstalling')

  return await host.topologyCoordinator.execute(async () => {
    const db: Database = host.getDb()
    const dao: ModularResourceDao = host.getDao()
    const record = dao.modules.findByIdSync(moduleId)
    if (!record) {
      throw new Error(`未找到模块定义: ${moduleId}`)
    }

    // 核心底座物理防空拦截：必选槽位必须先检验是否存在健康就绪备选（Ready Backup）
    let backupToActivate: BuiltinModuleRecord | null = null
    if (record.slot_policy === 'exclusive_required') {
      const readyBackups = host.findReadyBackupModulesSync(record)
      if (readyBackups.length === 0) {
        logger.warn(
          LogCategory.SYSTEM,
          `[ModularResource] 拒绝卸载唯一或无健康就绪备选的必选底座: ${moduleId}`
        )
        throw new Error('CANNOT_UNINSTALL_LAST_REQUIRED_SLOT')
      }
      const hasOtherActive = readyBackups.some((b: any) => b.install_state === 'active')
      if (!hasOtherActive) {
        backupToActivate = readyBackups[0]
      }
    }

    const wasActive = record.install_state === 'active'
    const resourcesToDelete: ResourceDownloadRecord[] = []

    // 阶段一：事务内解绑并计算引用计数（含就绪备选同事务原子提升），绝不在事务内做磁盘 I/O
    const tx = db.transaction(() => {
      const boundResources = dao.resources.findResourcesByModuleSync(moduleId)
      for (const res of boundResources) {
        dao.resources.unbindResourceFromModuleSync(moduleId, res.resource_id)
        const remainingRefs = dao.resources.getResourceActiveRefCountSync(res.resource_id)
        if (remainingRefs === 0) {
          dao.resources.markPendingDeleteSync(res.resource_id)
          const updatedRes = dao.resources.findByIdSync(res.resource_id)
          if (updatedRes) {
            resourcesToDelete.push(updatedRes)
          }
        }
      }
      dao.modules.updateInstallStateSync(moduleId, 'not_installed')

      // 若需由健康就绪备选接替，在同一事务内完成状态晋升与 Epoch 翻转
      if (backupToActivate) {
        dao.modules.updateInstallStateSync(backupToActivate.id, 'active')
        if (backupToActivate.capability_slot === 'base_embedding') {
          const prevServingEpoch = dao.epochs.findServingEpochSync()
          const isClassic = backupToActivate.id.includes('classic')
          const textDim = isClassic ? 384 : 768
          const imageDim = isClassic ? 512 : 768

          if (prevServingEpoch && prevServingEpoch.module_id !== backupToActivate.id) {
            const newEpochNum = prevServingEpoch.epoch + 1
            dao.epochs.createEpochSync({
              epoch: newEpochNum,
              module_id: backupToActivate.id,
              text_dim: textDim,
              image_dim: imageDim,
              status: 'building',
              reindex_cursor: null
            })
            dao.epochs.flipEpochSync(prevServingEpoch.epoch, newEpochNum)
          } else if (!prevServingEpoch) {
            dao.epochs.createEpochSync({
              epoch: 1,
              module_id: backupToActivate.id,
              text_dim: textDim,
              image_dim: imageDim,
              status: 'serving',
              reindex_cursor: null
            })
          }
        }
      }
    })

    tx()
    host.liveProgress.delete(moduleId)

    // 阶段二：停机释放 Windows mmap 文件句柄后再物理清理
    if (wasActive || host.processManager.isRunning(moduleId)) {
      await host.processManager.stopProcess(moduleId)
    }
    let omniStopped = false
    if (resourcesToDelete.length > 0 && record.backend_type !== 'utility_process') {
      omniStopped = await host.stopOmniProcessForUninstall()
    }

    for (const res of resourcesToDelete) {
      host.fastReadySnapshot.delete(res.resource_id)
      let targetAbsDir: string
      try {
        targetAbsDir = host.resolvePhysicalPath(res.target_local_path)
      } catch (pathErr) {
        logger.error(
          LogCategory.SYSTEM,
          `[ModularResource] 卸载阶段检测到非法路径，跳过磁盘删除: ${res.resource_id}`,
          pathErr
        )
        continue
      }

      try {
        await invalidateReadyMarkers(targetAbsDir).catch(() => {})
        const deleted = await host.tombstoneGC.safeDeleteWithTombstone(targetAbsDir, {
          slot: record.capability_slot ?? undefined,
          deleteDirectoryFn: host.deleteDirectoryFn
        })
        if (deleted) {
          const refCount = dao.resources.getResourceActiveRefCountSync(res.resource_id)
          if (refCount === 0) {
            dao.resources.deleteResourceSync(res.resource_id)
          }
        } else {
          logger.warn(
            LogCategory.SYSTEM,
            `[ModularResource] 资源目录仍被占用，保持 pending_delete 等待下次启动 GC: ${res.resource_id}`
          )
        }
      } catch (err: any) {
        if (err?.code === 'EBUSY' || err?.code === 'EPERM') {
          logger.warn(
            LogCategory.SYSTEM,
            `[ModularResource] 卸载删除捕获句柄占用 (${err.code})，保持 pending_delete: ${res.resource_id}`
          )
        } else {
          logger.warn(
            LogCategory.SYSTEM,
            `[ModularResource] 卸载删除资源目录异常，保持 pending_delete: ${res.resource_id}`,
            err
          )
        }
      }
    }

    // 阶段三：失效缓存并在需要时恢复干净的 Omni 底座运行或激活接替底座
    if (backupToActivate) {
      const failoverRes = await host.processManager
        .requestActivate(backupToActivate.id, 'slot_release')
        .catch((err: any) => ({ success: false, error: err?.message || String(err) }))
      if (!failoverRes.success) {
        logger.error(
          LogCategory.SYSTEM,
          `[ModularResource] 接替底座 ${backupToActivate.id} 拉起失败: ${failoverRes.error ?? 'unknown'}`
        )
      }
      await host
        .notifyRuntimePluginTopologyChanged({
          moduleId: backupToActivate.id,
          reason: 'module_uninstall_failover',
          restartPolicy: 'ensure-running'
        })
        .catch((err: unknown) => {
          logger.warn(LogCategory.SYSTEM, '[ModularResource] 卸载接替后刷新拓扑告警:', err)
        })
      if (backupToActivate.capability_slot === 'base_embedding') {
        await host.syncEmbeddingProfileToConfig()
      }
    } else if (wasActive || omniStopped) {
      await host
        .notifyRuntimePluginTopologyChanged({
          moduleId,
          reason: 'module_uninstall',
          restartPolicy: omniStopped ? 'ensure-running' : 'restart'
        })
        .catch((err: unknown) => {
          logger.warn(LogCategory.SYSTEM, '[ModularResource] 卸载后刷新拓扑告警:', err)
        })
    }

    host.invalidateUsedBytesCache(moduleId)
    return host.buildModuleView(dao.modules.findByIdSync(moduleId)!)
  })
}
