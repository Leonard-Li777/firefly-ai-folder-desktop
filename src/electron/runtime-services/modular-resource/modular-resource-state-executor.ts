/**
 * ModularResourceService 模块状态切换与配置同步执行器
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

export async function mrStateExecuteUpdateModuleState(
  host: any,
  moduleId: string,
  patch: {
    active?: boolean
    userConfig?: Record<string, unknown> | string | null
    selectedVariant?: string
    userConsent?: boolean
  },
  existing: BuiltinModuleRecord
): Promise<BuiltinModuleView> {
  const dao: ModularResourceDao = host.getDao()

  // 1. 处理配置与变体
  if (patch.userConfig !== undefined) {
    let configStr: string | null = null
    if (patch.userConfig === null) {
      configStr = null
    } else if (typeof patch.userConfig === 'string') {
      const trimmed = patch.userConfig.trim()
      if (trimmed) {
        try {
          JSON.parse(trimmed)
        } catch {
          throw new Error('INVALID_USER_CONFIG: userConfig 必须为合法 JSON 字符串')
        }
        configStr = patch.userConfig
      } else {
        configStr = null
      }
    } else {
      configStr = JSON.stringify(patch.userConfig)
    }
    dao.modules.updateUserConfigSync(moduleId, configStr)
  }

  if (patch.selectedVariant !== undefined) {
    dao.modules.updateVariantSync(moduleId, patch.selectedVariant)
  }

  if (patch.userConsent !== undefined) {
    dao.modules.updateUserConsentSync(moduleId, patch.userConsent ? 1 : 0)
  }

  // 2. 处理激活/停用流转（附严格前置门禁与失败回滚保护）
  if (patch.active === true) {
    const slot = existing.capability_slot ?? 'general'
    const policy = existing.slot_policy ?? 'multi_active'
    const isExclusive = policy === 'exclusive_required' || policy === 'exclusive_optional'

    // 前置物理门禁检查（未就绪绝不降级或驱逐前任）
    await host.assertModuleResourcesReadyForActivation(moduleId, existing)

    const prevActive = isExclusive ? dao.modules.findActiveBySlotSync(slot) : null
    const prevServingEpoch = slot === 'base_embedding' ? dao.epochs.findServingEpochSync() : null
    let createdOrFlippedEpochNum: number | null = null

    if (isExclusive && prevActive && prevActive.id !== moduleId) {
      dao.modules.updateInstallStateSync(prevActive.id, 'installed_inactive')
      await host.processManager.stopProcess(prevActive.id)
    }

    const restorePrevActiveRuntime = async (prevId: string, stage: string): Promise<void> => {
      dao.modules.activateExclusiveModuleSync(prevId)
      const rbRes = await host.processManager
        .requestActivate(prevId, 'rollback')
        .catch((rbErr: any) => ({ success: false, error: rbErr?.message || String(rbErr) }))
      if (!rbRes.success) {
        logger.error(
          LogCategory.SYSTEM,
          `[ModularResource] ${stage}回滚重启前任模块 ${prevId} 失败: ${rbRes.error ?? 'unknown'}`
        )
      }
      await host
        .notifyRuntimePluginTopologyChanged({
          moduleId: prevId,
          reason: 'module_state_rollback',
          restartPolicy: 'ensure-running'
        })
        .catch((rbErr: unknown) => {
          logger.warn(LogCategory.SYSTEM, `[ModularResource] ${stage}回滚恢复拓扑告警:`, rbErr)
        })
    }

    const actRes = await host.processManager.requestActivate(moduleId, 'user_toggle')
    if (!actRes.success) {
      dao.modules.updateInstallStateSync(
        moduleId,
        'installed_inactive',
        actRes.error ?? '激活门禁拦截'
      )
      if (isExclusive && prevActive && prevActive.id !== moduleId) {
        await restorePrevActiveRuntime(prevActive.id, '激活门禁')
      }
      throw new Error(actRes.error ?? '激活门禁拦截')
    }

    dao.modules.activateExclusiveModuleSync(moduleId)

    if (slot === 'base_embedding') {
      const isClassic = moduleId.includes('classic')
      const textDim = isClassic ? 384 : 768
      const imageDim = isClassic ? 512 : 768

      if (prevServingEpoch && prevServingEpoch.module_id !== moduleId) {
        const newEpochNum = prevServingEpoch.epoch + 1
        dao.epochs.createEpochSync({
          epoch: newEpochNum,
          module_id: moduleId,
          text_dim: textDim,
          image_dim: imageDim,
          status: 'building',
          reindex_cursor: null
        })
        dao.epochs.flipEpochSync(prevServingEpoch.epoch, newEpochNum)
        createdOrFlippedEpochNum = newEpochNum
      } else if (!prevServingEpoch) {
        dao.epochs.createEpochSync({
          epoch: 1,
          module_id: moduleId,
          text_dim: textDim,
          image_dim: imageDim,
          status: 'serving',
          reindex_cursor: null
        })
        createdOrFlippedEpochNum = 1
      }
    }

    try {
      await host.notifyRuntimePluginTopologyChanged({
        moduleId,
        reason: 'module_state',
        restartPolicy: 'ensure-running'
      })
      if (slot === 'base_embedding') {
        await host.syncEmbeddingProfileToConfig()
      }
      if (slot === 'ai_engine_cpu') {
        await host.syncCpuEngineStateToConfig(true)
      }
    } catch (activateErr: any) {
      const errMsg = activateErr?.message || String(activateErr)
      logger.error(
        LogCategory.SYSTEM,
        `[ModularResource] 模块 ${moduleId} 运行时加载或冒烟失败，执行严格回滚:`,
        activateErr
      )
      // 先停掉已激活的新进程，再释放 DB 状态防 ux_exclusive_active_slot 冲突与进程状态分裂
      await host.processManager.stopProcess(moduleId).catch((stopErr: unknown) => {
        logger.warn(
          LogCategory.SYSTEM,
          `[ModularResource] 回滚停用新模块进程 ${moduleId} 告警:`,
          stopErr
        )
      })
      dao.modules.updateInstallStateSync(moduleId, 'installed_inactive', errMsg)
      if (slot === 'base_embedding' && createdOrFlippedEpochNum !== null) {
        try {
          dao.epochs.rollbackEpochSync(prevServingEpoch?.epoch ?? null, createdOrFlippedEpochNum)
        } catch (epochRbErr) {
          logger.warn(LogCategory.SYSTEM, '[ModularResource] Epoch 回滚告警:', epochRbErr)
        }
      }
      if (isExclusive && prevActive && prevActive.id !== moduleId) {
        await restorePrevActiveRuntime(prevActive.id, '运行时加载')
      }
      if (slot === 'base_embedding') {
        await host.syncEmbeddingProfileToConfig()
      }
      throw activateErr
    }
  } else if (patch.active === false) {
    // 核心不变量：必选槽防空保护 (TC-10)
    if (existing.slot_policy === 'exclusive_required') {
      throw new Error('CANNOT_DEACTIVATE_REQUIRED_SLOT (SLOT_REQUIRED_EMPTY)')
    }

    dao.modules.deactivateModuleSync(moduleId)
    await host.processManager.stopProcess(moduleId)
    await host
      .notifyRuntimePluginTopologyChanged({
        moduleId,
        reason: 'module_deactivate',
        restartPolicy: 'restart'
      })
      .catch((err: unknown) => {
        logger.warn(LogCategory.SYSTEM, '[ModularResource] 停用模块刷新拓扑告警:', err)
      })
    if (existing.capability_slot === 'ai_engine_cpu') {
      await host.syncCpuEngineStateToConfig(false)
    }
  }

  return host.buildModuleView(dao.modules.findByIdSync(moduleId)!)
}

/**
 * 同步活跃底座画像状态到 ConfigOrchestrator（保证 base_embedding 与 AI_EMBEDDING_PROFILE / EMBEDDING_MRL_DIMENSION 唯一事实源全域统一）
 */
export async function mrStateSyncEmbeddingProfileToConfig(host: any): Promise<void> {
  try {
    const activeBase = host.getActiveModuleBySlot('base_embedding')
    if (!activeBase) return

    let configOrch = host.injectedConfigOrchestrator
    if (!configOrch) {
      try {
        const { ConfigOrchestrator } = await import('../../config/config-orchestrator')
        configOrch = ConfigOrchestrator.getInstance()
      } catch {
        return
      }
    }
    if (!configOrch) return

    const targetProfile =
      activeBase.id === 'engine_gemma_unified' ? 'gemma_unified' : 'classic_light'
    const currentProfile = configOrch.getValue?.('AI_EMBEDDING_PROFILE')

    if (currentProfile !== targetProfile) {
      logger.debug(
        LogCategory.SYSTEM,
        `[ModularResource] 同步底座槽位活跃状态到配置: ${currentProfile} -> ${targetProfile}`
      )
      if (typeof configOrch.updateValue === 'function') {
        await configOrch.updateValue('AI_EMBEDDING_PROFILE', targetProfile)
      }
    }
  } catch (err) {
    logger.warn(LogCategory.SYSTEM, '[ModularResource] 同步底座嵌入画像到配置告警:', err)
  }
}

/**
 * 同步 CPU 引擎激活/停用状态到 ConfigOrchestrator、LlmGatewayService 与 EngineBridgeService
 * 实现插件中心与全局设置页面的双向互斥对齐 (TASK-04 / Invariant)
 */
export async function mrStateSyncCpuEngineStateToConfig(host: any, active: boolean): Promise<void> {
  try {
    let configOrch = host.injectedConfigOrchestrator
    if (!configOrch) {
      try {
        const { ConfigOrchestrator } = await import('../../config/config-orchestrator')
        configOrch = ConfigOrchestrator.getInstance()
      } catch {
        // ignore in test
      }
    }

    const { llmGatewayService } = await import('../llm/llm-gateway-service')
    const { engineBridgeService } = await import('../engine-bridge/engine-bridge-service')

    if (active) {
      if (configOrch) {
        if (typeof configOrch.updateValues === 'function') {
          await configOrch.updateValues({
            AI_SERVICE_MODE: 'cpu',
            AI_SERVICE_LAST_ENABLED_MODE: 'cpu'
          })
        } else if (typeof configOrch.setValue === 'function') {
          configOrch.setValue('AI_SERVICE_MODE', 'cpu')
          configOrch.setValue('AI_SERVICE_LAST_ENABLED_MODE', 'cpu')
        }
      }
      await llmGatewayService.setDesiredMode('cpu')
      await engineBridgeService.shutdown()
    } else {
      const currentMode = configOrch?.getValue?.('AI_SERVICE_MODE')
      if (currentMode === 'cpu') {
        if (configOrch) {
          if (typeof configOrch.updateValues === 'function') {
            await configOrch.updateValues({
              AI_SERVICE_MODE: 'local',
              AI_SERVICE_LAST_ENABLED_MODE: 'local'
            })
          } else if (typeof configOrch.setValue === 'function') {
            configOrch.setValue('AI_SERVICE_MODE', 'local')
            configOrch.setValue('AI_SERVICE_LAST_ENABLED_MODE', 'local')
          }
        }
        await llmGatewayService.setDesiredMode('local')
        await llmGatewayService.drain()
      }
    }
  } catch (err) {
    logger.warn(LogCategory.SYSTEM, '[ModularResource] 同步 CPU 引擎状态到全局配置异常:', err)
  }
}
