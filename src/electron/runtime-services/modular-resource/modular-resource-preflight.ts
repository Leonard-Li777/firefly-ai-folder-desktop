/**
 * ModularResourceService BOM 核验与 L1/L2 预检逻辑
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
 * 推理引擎加载门控：等待指定模块完成真实文件 SHA-256 异步校验
 */
export async function mrPreflightEnsureVerified(host: any, moduleId: string): Promise<boolean> {
  const promise = host.verificationPromises.get(moduleId)
  if (promise) {
    return await promise
  }
  return true
}

/**
 * 读取资源的 BOM 文件清单定义
 */
/**
 * 候选 BOM 路径解析（严格适配打包态、开发态与 monorepo 子工作区不同 cwd）
 */
export function mrPreflightGetCandidateBomPaths(host: any): string[] {
  const rawPaths: string[] = []
  try {
    if (typeof electronApp !== 'undefined' && electronApp.isPackaged) {
      rawPaths.push(path.join(process.resourcesPath, 'configs', 'resources.bom.json'))
      rawPaths.push(
        path.join(process.resourcesPath, 'extraResources', 'configs', 'resources.bom.json')
      )
    }
  } catch {}
  try {
    const resolvedBom = ResourceLocator.resolveResourcePath('configs/resources.bom.json')
    if (resolvedBom) rawPaths.push(resolvedBom)
  } catch {}
  rawPaths.push(
    path.join(process.cwd(), 'build', 'extraResources', 'configs', 'resources.bom.json'),
    path.join(
      process.cwd(),
      'apps',
      'desktop',
      'build',
      'extraResources',
      'configs',
      'resources.bom.json'
    ),
    path.join(host.getBaseDir(), 'configs', 'resources.bom.json')
  )
  return Array.from(new Set(rawPaths.filter(Boolean)))
}

/**
 * 按资源 ID 获取预期文件清单（优先读取 BOM 文件，用于解压完成后的物理对账）
 */
export function mrPreflightLoadBomFilesForResource(
  host: any,
  resourceId: string
): Array<{ name: string; size: number; sha256: string }> {
  if (host.resourceBomOverrides.has(resourceId)) {
    return host.resourceBomOverrides.get(resourceId)!
  }

  const candidateBomPaths = host.getCandidateBomPaths()

  for (const bomPath of candidateBomPaths) {
    if (fs.existsSync(bomPath)) {
      try {
        const content = JSON.parse(fs.readFileSync(bomPath, 'utf-8'))
        const res = content.resources?.[resourceId]
        if (res?.files && Array.isArray(res.files)) {
          return res.files
        }
      } catch (err) {
        logger.warn(LogCategory.SYSTEM, `[ModularResource] 解析 BOM 文件失败: ${bomPath}`, err)
      }
    }
  }

  return []
}

/**
 * 读取全部资源的 BOM 文件清单定义
 */
export function mrPreflightLoadResourceBom(
  host: any
): Array<{ name: string; size: number; sha256: string }> {
  const candidateBomPaths = host.getCandidateBomPaths()

  const results: Array<{ name: string; size: number; sha256: string }> = []
  for (const bomPath of candidateBomPaths) {
    if (fs.existsSync(bomPath)) {
      try {
        const content = JSON.parse(fs.readFileSync(bomPath, 'utf-8'))
        const resources = content.resources || {}
        for (const resKey of Object.keys(resources)) {
          const files = resources[resKey]?.files
          if (Array.isArray(files)) {
            results.push(...files)
          }
        }
        if (results.length > 0) return results
      } catch (err) {
        logger.warn(LogCategory.SYSTEM, `[ModularResource] 加载全量 BOM 失败: ${bomPath}`, err)
      }
    }
  }

  return results
}

/**
 * L1 物理探活：检查目标解压目录是否健全
 * 返回 'fast_hit' | 'slow_healed' | 'corrupted' | 'not_found'
 */
export async function mrPreflightCheckL1TargetDirPreflight(
  host: any,
  targetAbsDir: string,
  spec: CatalogResourceSpec
): Promise<'fast_hit' | 'slow_healed' | 'corrupted' | 'not_found'> {
  if (!fs.existsSync(targetAbsDir)) {
    return 'not_found'
  }

  const filesInDir = fs.readdirSync(targetAbsDir).filter(f => !f.startsWith('.'))
  if (filesInDir.length === 0) {
    return 'not_found'
  }

  const sharedSubDir = resolveSharedSubDir(spec.resource_id)
  const catalogMeta = (
    BUILTIN_PLUGIN_CATALOG_META as Record<
      string,
      {
        sharedSubDir?: string
        requiredFileGroups?: readonly (readonly string[])[]
        minPrimaryFileBytes?: number
      }
    >
  )[spec.resource_id]

  // 1. 快路径：校验标准 .ready.json 与特征文件组
  const marker = await readReadyMarker(targetAbsDir)
  if (marker && marker.resourceId === spec.resource_id && marker.sharedSubDir === sharedSubDir) {
    const filesOk = await PluginPathResolver.checkRequiredFileGroupsAsync(
      targetAbsDir,
      catalogMeta?.requiredFileGroups,
      catalogMeta?.minPrimaryFileBytes
    )
    if (filesOk) {
      return 'fast_hit'
    }
  }

  // 2. 慢路径：逐文件流式计算真实 SHA-256 并自愈补写标准 .ready.json
  const expectedFiles = host.loadBomFilesForResource(spec.resource_id)
  if (expectedFiles.length > 0) {
    let allFilesOk = true

    for (const ef of expectedFiles) {
      const p = path.join(targetAbsDir, ef.name)
      if (!fs.existsSync(p)) {
        allFilesOk = false
        break
      }
      const st = fs.statSync(p)
      if (st.size !== ef.size) {
        allFilesOk = false
        break
      }
      const verifyRes = await streamVerifySha256(p, ef.sha256)
      if (!verifyRes.valid) {
        allFilesOk = false
        break
      }
    }

    if (allFilesOk) {
      try {
        const ok = await host.writeReadyMarkerGuardedForVisual(
          targetAbsDir,
          spec.resource_id,
          sharedSubDir,
          {
            skipDigest: false
          }
        )
        if (!ok) {
          await host.isolateCorruptDirectory(targetAbsDir)
          return 'corrupted'
        }
      } catch (err) {
        logger.warn(
          LogCategory.SYSTEM,
          `[ModularResource] BOM 慢路径写入就绪标记失败: ${spec.resource_id}`,
          err
        )
      }
      return 'slow_healed'
    } else {
      await host.isolateCorruptDirectory(targetAbsDir)
      return 'corrupted'
    }
  } else {
    // 无 BOM 清单的通用/测试资源：若已有 completed 记录且特征文件存在，补写标准 .ready.json 放行
    const task = (host.getDao() as ModularResourceDao).resources.findByIdSync(spec.resource_id)
    const filesOk = await PluginPathResolver.checkRequiredFileGroupsAsync(
      targetAbsDir,
      catalogMeta?.requiredFileGroups,
      catalogMeta?.minPrimaryFileBytes
    )
    if (
      filesOk &&
      task?.download_state === 'completed' &&
      (!task.expected_sha256 ||
        !task.actual_sha256 ||
        task.actual_sha256.toLowerCase() === task.expected_sha256.toLowerCase())
    ) {
      try {
        const ok = await host.writeReadyMarkerGuardedForVisual(
          targetAbsDir,
          spec.resource_id,
          sharedSubDir
        )
        if (!ok) {
          return 'not_found'
        }
      } catch (err) {
        logger.warn(
          LogCategory.SYSTEM,
          `[ModularResource] BOM 慢路径写入就绪标记失败: ${spec.resource_id}`,
          err
        )
      }
      return 'slow_healed'
    }
  }

  return 'not_found'
}

/**
 * 将损坏目录原子隔离至同卷 .corrupt-<uuid>
 */
export async function mrPreflightIsolateCorruptDirectory(
  host: any,
  targetAbsDir: string
): Promise<void> {
  const parentDir = path.dirname(targetAbsDir)
  const baseName = path.basename(targetAbsDir)
  const corruptTarget = path.join(parentDir, `${baseName}.corrupt-${Date.now()}`)
  try {
    if (fs.existsSync(targetAbsDir)) {
      fs.renameSync(targetAbsDir, corruptTarget)
    }
  } catch (err) {
    logger.warn(LogCategory.SYSTEM, `[ModularResource] 隔离破损目录失败: ${targetAbsDir}`, err)
  }
}

/**
 * L2 物理探活：探测本地预置包并验证（优先匹配 presetResources/<resource_id>/<asset_name>，向下兼容平放）
 */
export async function mrPreflightCheckL2LocalPresetPreflight(
  host: any,
  spec: CatalogResourceSpec,
  targetAbsDir: string
): Promise<boolean> {
  const rawCandidateDirs: string[] = []
  if (host.customPresetDir) {
    rawCandidateDirs.push(host.customPresetDir)
  }
  try {
    if (typeof electronApp !== 'undefined' && electronApp.isPackaged) {
      rawCandidateDirs.push(path.join(process.resourcesPath, 'presetResources'))
    }
  } catch {}
  try {
    const extraBase = ResourceLocator.getBaseResourceDir()
    if (extraBase) {
      rawCandidateDirs.push(path.join(path.dirname(extraBase), 'presetResources'))
    }
  } catch {}
  rawCandidateDirs.push(
    path.join(process.cwd(), 'build', 'presetResources'),
    path.join(process.cwd(), 'apps', 'desktop', 'build', 'presetResources'),
    path.join(host.getBaseDir(), 'presetResources')
  )

  const candidateDirs = Array.from(new Set(rawCandidateDirs.filter(Boolean)))

  const sharedSubDir = resolveSharedSubDir(spec.resource_id)

  for (const pDir of candidateDirs) {
    const candidatePaths = [
      path.join(pDir, spec.resource_id, spec.asset_name),
      path.join(pDir, spec.asset_name)
    ]
    for (const presetPath of candidatePaths) {
      if (!fs.existsSync(presetPath)) continue

      const cacheKey = `${presetPath}:${spec.expected_sha256}`
      if (host.corruptedPresetCache.has(cacheKey)) {
        continue
      }

      try {
        const verify = await streamVerifySha256(presetPath, spec.expected_sha256)
        if (verify.valid) {
          logger.debug(
            LogCategory.SYSTEM,
            `[ModularResource] L2 预置包探活命中: ${presetPath}，本地物化至 ${targetAbsDir}`
          )
          // 物化前先清理目标目录旧 .ready* 标记，防 TOCTOU
          await invalidateReadyMarkers(targetAbsDir)

          const lowerAsset = spec.asset_name.toLowerCase()
          if (lowerAsset.endsWith('.zip') || lowerAsset.endsWith('.ffp')) {
            const intentsDir = path.join(host.getBaseDir(), '.intents')
            await safeExtractZip(presetPath, targetAbsDir, intentsDir)
          } else {
            await fs.promises.mkdir(targetAbsDir, { recursive: true })
            const destFile = path.join(targetAbsDir, spec.asset_name)
            const tmpFile = `${destFile}.tmp-${Date.now()}`
            await fs.promises.copyFile(presetPath, tmpFile)
            await renameWithRetry(tmpFile, destFile)
          }

          // 解压/物化完成后仅向 targetAbsDir (_shared/<sharedSubDir>) 写入经视觉门控校验的标准 .ready.json
          const marked = await host.writeReadyMarkerGuardedForVisual(
            targetAbsDir,
            spec.resource_id,
            sharedSubDir
          )
          if (!marked) {
            throw new Error(`L2 预置视觉校验未通过: ${spec.resource_id}`)
          }

          return true
        } else {
          // 仅记录内存缓存，严禁向只读目录调用 unlinkSync
          host.corruptedPresetCache.set(cacheKey, true)
        }
      } catch {
        host.corruptedPresetCache.set(cacheKey, true)
      }
    }
  }

  return false
}
