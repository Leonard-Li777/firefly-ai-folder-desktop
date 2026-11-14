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
  type EmbeddingEpochRecord
} from '../database/dao/modular-resource-dao'

export type { PluginCapabilitySlot, SlotPolicy, BackendType, EmbeddingEpochRecord }
import { PluginProcessManager, getPluginProcessManager } from './plugin-process-manager'
import {
  TombstoneGCService,
  tombstoneGCService,
  OfflinePackageService,
  offlinePackageService,
  type PendingDeletionItem
} from '../modular-resource'
import {
  FileDownloadService,
  fileDownloadService,
  safeExtractZip,
  safeDeleteDirectory,
  cleanOrphanTombstones,
  streamVerifySha256,
  renameWithRetry,
  reconcileDirSwitchIntents,
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

export interface CatalogResourceSpec {
  resource_id: string
  asset_name: string
  target_local_path?: string
  active_source_key?: 'auto' | 'cn' | 'global'
  active_url?: string
  expected_bytes: number
  expected_sha256: string
}

export interface CatalogModuleEntry {
  id: string
  name?: string
  description?: string
  icon?: string
  kind?: ModuleKind
  version: string
  catalog_version: number
  category: ModuleCategory
  capability_slot?: PluginCapabilitySlot
  slot_policy?: SlotPolicy
  backend_type?: BackendType
  author_code?: ModuleAuthorCode
  author_name?: string | null
  availability?: ModuleAvailability
  delist_reason?: 'general_deprecation' | 'security_violation' | null
  firecore_cost?: number
  total_bytes: number
  catalog_meta_json?: string | Record<string, unknown> | null
  config_schema?: string | Record<string, unknown> | null
  install_state?: ModuleInstallState
  selected_variant?: string | null
  install_path?: string | null
  resources?: CatalogResourceSpec[]
  contributes?: {
    settings?: import('@firefly/types').PluginSettingsContribution
  }
}

export interface ModuleDownloadProgressEvent {
  moduleId: string
  resourceId: string
  downloadedBytes: number
  expectedBytes: number
  percentage: number
  speedBytesPerSec: number
  isResumed: boolean
  state: 'downloading' | 'verifying' | 'extracting' | 'completed' | 'failed'
  errorMessage?: string
}

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

export interface BuiltinModuleView extends BuiltinModuleRecord {
  name: string
  description: string
  icon?: string
  is_running?: boolean
  is_usable?: boolean
  can_activate?: boolean
  can_install?: boolean
  can_uninstall?: boolean
  hold_reasons?: string[]
  validation_status?: 'ready' | 'pending_validation' | 'pending_repair' | 'legacy'
  validation_message?: string
  resources: ResourceDownloadRecord[]
  download_progress?: {
    percentage: number
    speed_bytes_per_sec: number
    is_resumed: boolean
  }
  contributes?: {
    settings?: import('@firefly/types').PluginSettingsContribution
  }
}

export type FastReadyStatus = 'ready_fast' | 'legacy_heal' | 'pending_repair' | 'pending_validation'

export interface ResourceValidationEntry {
  resourceId: string
  sharedSubDir: string
  physicalDir: string | null
  status: FastReadyStatus | 'unknown_resource'
  validationLevel: 'full' | 'legacy'
  reason?: string
  checkedAt: number
}

export interface FastReadyBarrierResult {
  rootStatus: 'ready' | 'unavailable'
  readyResources: ResourceValidationEntry[]
  legacyHealResources: ResourceValidationEntry[]
  pendingValidationResources: ResourceValidationEntry[]
  pendingRepairResources: ResourceValidationEntry[]
  timedOut: boolean
  elapsedMs: number
}

export interface TopologyChangeNotificationOptions {
  moduleId?: string
  reason?: string
  restartPolicy?: 'restart' | 'ensure-running' | 'stop-if-unused'
}

export type TopologyChangeHandler = (
  opts: TopologyChangeNotificationOptions
) => Promise<void> | void

const LEGACY_HEAL_MARKER_FILENAME = `${LEGACY_READY_MARKER_PREFIX}legacy.json`

function hasAnyReadyMarkerFile(files: string[]): boolean {
  return files.some(
    f =>
      f === READY_MARKER_FILENAME ||
      (f.startsWith(LEGACY_READY_MARKER_PREFIX) && f.endsWith('.json'))
  )
}

function resolveSharedSubDir(resourceId: string): string {
  const meta = (BUILTIN_PLUGIN_CATALOG_META as Record<string, { sharedSubDir?: string }>)[
    resourceId
  ]
  return meta?.sharedSubDir ?? resourceId
}

/**
 * 解析 `ux_exclusive_active_slot` SQL 索引中的 `IN (...)` 白名单槽位
 */
function parseExclusiveSlotsFromIndexSql(sql: string | undefined | null): string[] {
  if (!sql) return []
  const match = sql.match(/capability_slot\s+IN\s*\(([^)]+)\)/i)
  if (!match || !match[1]) return []
  return match[1]
    .split(',')
    .map(part => part.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean)
}

/**
 * 运行时拓扑单协调器 (`RuntimeTopologyCoordinator`)
 *
 * 将模块安装、状态切换、离线激活与卸载统一收拢至单一异步互斥队列，
 * 借助 AsyncLocalStorage 识别重入调用避免嵌套死锁 (`TC-SSOT-10`)，并对尾部高频拓扑通知做去重合并。
 */
export class RuntimeTopologyCoordinator {
  private mutexChain: Promise<void> = Promise.resolve()
  private readonly als = new AsyncLocalStorage<symbol>()
  private activeToken: symbol | null = null
  private pendingCoalescedNotify: Promise<void> | null = null
  private latestCoalescedTask: (() => Promise<void>) | null = null

  public async execute<T>(
    task: () => Promise<T>,
    options?: {
      restartAfter?: boolean
      onRestart?: () => Promise<void>
    }
  ): Promise<T> {
    const runWithRestart = async (): Promise<T> => {
      const result = await task()
      if (options?.restartAfter && options.onRestart) {
        await options.onRestart()
      }
      return result
    }

    // 同一异步执行链重入时直接复用当前锁持有人上下文，防止自锁
    const currentToken = this.als.getStore()
    if (currentToken && currentToken === this.activeToken) {
      return await runWithRestart()
    }

    const prev = this.mutexChain
    let release!: () => void
    this.mutexChain = new Promise<void>(resolve => {
      release = resolve
    })

    await prev.catch(() => {})
    const token = Symbol('topology-lock')
    this.activeToken = token
    try {
      return await this.als.run(token, runWithRestart)
    } finally {
      if (this.activeToken === token) {
        this.activeToken = null
      }
      release()
    }
  }

  /**
   * 尾沿合并通知：若当前已有外部队列等待通知，仅刷新末次意图并复用同一等待期
   */
  public async coalesceTopologyNotify(run: () => Promise<void>): Promise<void> {
    const currentToken = this.als.getStore()
    if (currentToken && currentToken === this.activeToken) {
      await run()
      return
    }

    this.latestCoalescedTask = run
    if (this.pendingCoalescedNotify) {
      return await this.pendingCoalescedNotify
    }

    this.pendingCoalescedNotify = this.execute(async () => {
      // 微小防抖窗口（5ms）聚合瞬间批量后台校验完成事件
      await new Promise(resolve => setTimeout(resolve, 5))
      const taskToRun = this.latestCoalescedTask
      this.latestCoalescedTask = null
      if (taskToRun) {
        await taskToRun()
      }
    }).finally(() => {
      this.pendingCoalescedNotify = null
    })

    return await this.pendingCoalescedNotify
  }
}

export const runtimeTopologyCoordinator = new RuntimeTopologyCoordinator()

export interface IModularResourceService {
  /** 启动期自愈：清理 .tmp-* 与 .deleting_* 孤儿目录 + 对账 DB 与磁盘实际安装目录 */
  reconcileOnStartup(): Promise<{
    cleanedTombstones: number
    resetModules: string[]
    resetDownloads: string[]
  }>

  /** 增量同步插件目录元数据（满足 IN-04：remote.catalog_version < local.catalog_version 时忽略并告警；离线静默兜底） */
  syncCatalog(entries: CatalogModuleEntry[]): Promise<{
    updated: number
    skippedRegression: number
  }>

  /** 获取所有模块完整视图（合并 builtin_modules 状态与关联 resource_downloads 进度，支持 scope 过滤） */
  listModules(filter?: {
    scope?: 'market' | 'installed'
    category?: string
    includeDraft?: boolean
  }): BuiltinModuleView[]

  /** 幂等下载并安装模块（引用计数复用 -> Range 206 -> SHA-256 -> Zip Slip 解压 -> 原子 rename） */
  installModule(
    moduleId: string,
    onProgress?: (event: ModuleDownloadProgressEvent) => void,
    options?: { skipLocalPreset?: boolean }
  ): Promise<BuiltinModuleView>

  /** 将选配模块加入后台静默安装队列（单实例串行 Singleflight，支持跨上下文接管） */
  enqueueBackgroundInstalls(moduleIds: string[]): Promise<string[]>

  /** 设置后台安装进度全局广播回调 */
  setProgressBroadcaster(broadcaster: (event: ModuleDownloadProgressEvent) => void): void

  /** 卸载模块（事务内解绑并计算引用计数 -> 归零标记 pending_delete -> 事务外 Tombstone 重命名与退避删除） */
  uninstallModule(moduleId: string): Promise<BuiltinModuleView>

  /** 切换模块激活状态或更新 user_config / selected_variant */
  updateModuleState(
    moduleId: string,
    patch: {
      active?: boolean
      userConfig?: Record<string, unknown> | string | null
      selectedVariant?: string
      userConsent?: boolean
    }
  ): Promise<BuiltinModuleView>

  /** 激活指定模块（针对排他槽位自动停用同槽位其他模块） */
  activateModule(moduleId: string): Promise<BuiltinModuleView>

  /** 停用指定模块（若处于 exclusive_required 且激活状态则拒绝并抛出 SLOT_REQUIRED_EMPTY） */
  deactivateModule(moduleId: string): Promise<BuiltinModuleView>

  /** 按能力槽位查询当前激活的模块（若无激活返回 null） */
  getActiveModuleBySlot(slot: PluginCapabilitySlot): BuiltinModuleView | null

  /** 获取单个模块的视图（若不存在返回 null） */
  getModule(moduleId: string): BuiltinModuleView | null

  /** 获取被 Windows 句柄占用的待清理路径清单 */
  getPendingTombstones(): PendingDeletionItem[]

  /** 是否存在待重启清理的 Tombstone 目录 */
  hasPendingTombstones(): boolean

  /** 请求重启桌面端应用以释放磁盘句柄 */
  requestRestart(): void

  /** 获取底层数据库实例 */
  getDb(): Database

  /** 获取底层模块化资源 DAO */
  getDao(): ModularResourceDao

  /** 获取模块根存储目录 */
  getBaseDir(): string

  /** 导出离线插件包 (.ffp / .zip) */
  exportOfflinePackage(
    moduleId: string,
    targetFilePath: string,
    options?: { signerPrivateKey?: string }
  ): Promise<string>

  /** 导出全量离线插件总包 (.ffbundle) */
  exportOfflineBundle(
    targetFilePath: string,
    options?: { rootPublicKey?: string; producerAppVersion?: string }
  ): Promise<string>

  /** 导入离线插件包 / 离线总包 (.ffp / .zip) */
  importOfflinePackage(
    archivePath: string,
    options?: { rootPublicKey?: string; preferredEngineId?: string }
  ): Promise<BuiltinModuleView>

  /** 获取当前进程内存生效的插件根目录 (IN-01) */
  getPluginsRootDir(): string

  /** 获取持久化配置中已提交生效的插件根目录 */
  getCommittedPluginsRootDir(): string

  /** 获取当前目录运行态相位 */
  getDirRuntimePhase(): DirRuntimePhase

  /** 校验候选插件存储目录合法性 */
  validatePluginDir(targetPath: string): Promise<ValidatePluginDirResult>

  /** 获取插件目录运行态信息与诊断 */
  getPluginDirInfo(): Promise<PluginDirInfo>

  /** 触发插件目录迁移事务 */
  changePluginDirectory(targetPath: string): Promise<{
    success: boolean
    migrationId?: string
    errorCode?: PluginDirErrorCode
  }>

  /**
   * 首次运行引导期专用：无资产可迁移时直接设定安装目录。
   * 不调用 DirMigrationCoordinator、不进入 PENDING_RESTART 写冻结，设定后即可立即安装。
   */
  applyInitialPluginDirectory(targetPath: string): Promise<{
    success: boolean
    appliedPath?: string
    errorCode?: PluginDirErrorCode
  }>

  /** 取消在途的插件目录迁移 (仅在 PRECHECK / STAGING / VERIFYING 有效) */
  cancelDirMigration(): Promise<{
    cancelled: boolean
    errorCode?: PluginDirErrorCode
  }>

  /** 清理历史旧目录残留资产 (Issue 04) */
  cleanupOldPluginDirectory(): Promise<{
    success: boolean
    freedBytes: number
    errorCode?: PluginDirErrorCode
  }>

  /** 忽略历史旧目录清理提示 */
  dismissOldDirCleanup(): void

  /** 是否已忽略旧目录清理提示 */
  isOldDirCleanupDismissed(): boolean
}

/**
 * 本地离线内置插件目录种子 (IN-04 纯离线兜底 SSOT)
 * 所有模块资源规格、字节数与 `_shared` 相对路径严格派生自 `@firefly/shared` 单一事实源。
 */
export const DEFAULT_CATALOG_SEEDS: CatalogModuleEntry[] = [
  // 1. 检索式引擎：经典轻量极速档 (二选一必选)
  {
    id: BUILTIN_MODULE_CATALOG_META.engine_classic_light.id,
    name: '经典轻量语义搜索',
    description:
      '【通过意思找文件与图片】根据你描述的大致意思快速搜索照片和文档。占用极少内存，即使老电脑和低配轻薄本也能流畅运行。',
    icon: 'Feather',
    kind: 'builtin-module',
    version: BUILTIN_MODULE_CATALOG_META.engine_classic_light.version,
    catalog_version: BUILTIN_MODULE_CATALOG_META.engine_classic_light.catalogVersion,
    category: BUILTIN_MODULE_CATALOG_META.engine_classic_light.category,
    capability_slot: BUILTIN_MODULE_CATALOG_META.engine_classic_light.capabilitySlot,
    slot_policy: BUILTIN_MODULE_CATALOG_META.engine_classic_light.slotPolicy,
    backend_type: BUILTIN_MODULE_CATALOG_META.engine_classic_light.backendType,
    author_code: 'official',
    total_bytes: BUILTIN_MODULE_CATALOG_META.engine_classic_light.totalBytes,
    install_state: 'not_installed',
    contributes: {
      settings: {
        scope: 'workspace',
        tabTitle: '基础 AI 引擎',
        componentId: 'basic_ai_engine',
        priority: 10
      }
    },
    resources: BUILTIN_MODULE_CATALOG_META.engine_classic_light.resourceIds.map(
      buildResourceSpecFromCatalog
    )
  },
  // 2. 检索式引擎：统一全模态档 (二选一必选)
  {
    id: BUILTIN_MODULE_CATALOG_META.engine_gemma_unified.id,
    name: '高精度全能语义搜索',
    description:
      '【更聪明的全能搜索大脑】对复杂句子和图片的理解更深入精准，找东西更懂你的心思。推荐 8GB 或以上内存电脑使用。',
    icon: 'Layers',
    kind: 'builtin-module',
    version: BUILTIN_MODULE_CATALOG_META.engine_gemma_unified.version,
    catalog_version: BUILTIN_MODULE_CATALOG_META.engine_gemma_unified.catalogVersion,
    category: BUILTIN_MODULE_CATALOG_META.engine_gemma_unified.category,
    capability_slot: BUILTIN_MODULE_CATALOG_META.engine_gemma_unified.capabilitySlot,
    slot_policy: BUILTIN_MODULE_CATALOG_META.engine_gemma_unified.slotPolicy,
    backend_type: BUILTIN_MODULE_CATALOG_META.engine_gemma_unified.backendType,
    author_code: 'official',
    total_bytes: BUILTIN_MODULE_CATALOG_META.engine_gemma_unified.totalBytes,
    install_state: 'not_installed',
    contributes: {
      settings: {
        scope: 'workspace',
        tabTitle: '基础 AI 引擎',
        componentId: 'basic_ai_engine',
        priority: 10
      }
    },
    resources: BUILTIN_MODULE_CATALOG_META.engine_gemma_unified.resourceIds.map(
      buildResourceSpecFromCatalog
    )
  },
  // 3. 生成式引擎：轻量 CPU 引擎 (Pocket CPU)
  {
    id: BUILTIN_MODULE_CATALOG_META['pocket-cpu-int8-onnx'].id,
    name: '离线轻量智能引擎',
    description:
      '【办公轻薄本标配】内存仅占约400MB，0门槛秒级响应，完全离线私密。支持智能文件名深度润色、描述提取与内容深度解析。',
    icon: 'Cpu',
    kind: 'builtin-module',
    version: BUILTIN_MODULE_CATALOG_META['pocket-cpu-int8-onnx'].version,
    catalog_version: BUILTIN_MODULE_CATALOG_META['pocket-cpu-int8-onnx'].catalogVersion,
    category: BUILTIN_MODULE_CATALOG_META['pocket-cpu-int8-onnx'].category,
    capability_slot: BUILTIN_MODULE_CATALOG_META['pocket-cpu-int8-onnx'].capabilitySlot,
    slot_policy: BUILTIN_MODULE_CATALOG_META['pocket-cpu-int8-onnx'].slotPolicy,
    backend_type: BUILTIN_MODULE_CATALOG_META['pocket-cpu-int8-onnx'].backendType,
    author_code: 'official',
    total_bytes: BUILTIN_MODULE_CATALOG_META['pocket-cpu-int8-onnx'].totalBytes,
    install_state: 'not_installed',
    contributes: {
      settings: {
        scope: 'global',
        tabTitle: '生成式引擎',
        componentId: 'ai_engine_config',
        priority: 15
      }
    },
    resources: BUILTIN_MODULE_CATALOG_META['pocket-cpu-int8-onnx'].resourceIds.map(
      buildResourceSpecFromCatalog
    )
  },
  // 4. 感知分析模型：敏感内容与安全识别
  {
    id: BUILTIN_MODULE_CATALOG_META.perception_nsfw.id,
    name: '敏感内容过滤与安全识别',
    description:
      '【私密与敏感图文标记】自动识别私密敏感图片与包含露骨敏感描述的文档/AIGC文本并打上标记，防止投屏查看时尴尬。所有电脑均可极速运行。',
    icon: 'ShieldAlert',
    kind: 'builtin-module',
    version: BUILTIN_MODULE_CATALOG_META.perception_nsfw.version,
    catalog_version: BUILTIN_MODULE_CATALOG_META.perception_nsfw.catalogVersion,
    category: BUILTIN_MODULE_CATALOG_META.perception_nsfw.category,
    capability_slot: BUILTIN_MODULE_CATALOG_META.perception_nsfw.capabilitySlot,
    slot_policy: BUILTIN_MODULE_CATALOG_META.perception_nsfw.slotPolicy,
    backend_type: BUILTIN_MODULE_CATALOG_META.perception_nsfw.backendType,
    author_code: 'official',
    total_bytes: BUILTIN_MODULE_CATALOG_META.perception_nsfw.totalBytes,
    install_state: 'not_installed',
    contributes: {
      settings: {
        scope: 'workspace',
        tabTitle: '文件内容萃取',
        componentId: 'content_extraction',
        priority: 20
      }
    },
    resources: BUILTIN_MODULE_CATALOG_META.perception_nsfw.resourceIds.map(
      buildResourceSpecFromCatalog
    )
  },
  // 5. 语音识别与字幕提取 ASR (SenseVoice, 纯模型，转码复用系统内置 FFmpeg，运行时锁定域 A sherpa)
  {
    id: BUILTIN_MODULE_CATALOG_META.asr_sensevoice_onnx.id,
    name: '语音识别与字幕提取',
    description:
      '【录音与视频自动转文字】听懂视频和录音里的说话内容并提取字幕，可以直接搜索“某句话是谁说的”。较耗算力，推荐 16GB 内存或有显卡。',
    icon: 'Mic',
    kind: 'builtin-module',
    version: BUILTIN_MODULE_CATALOG_META.asr_sensevoice_onnx.version,
    catalog_version: BUILTIN_MODULE_CATALOG_META.asr_sensevoice_onnx.catalogVersion,
    category: BUILTIN_MODULE_CATALOG_META.asr_sensevoice_onnx.category,
    capability_slot: BUILTIN_MODULE_CATALOG_META.asr_sensevoice_onnx.capabilitySlot,
    slot_policy: BUILTIN_MODULE_CATALOG_META.asr_sensevoice_onnx.slotPolicy,
    backend_type: BUILTIN_MODULE_CATALOG_META.asr_sensevoice_onnx.backendType,
    author_code: 'official',
    total_bytes: BUILTIN_MODULE_CATALOG_META.asr_sensevoice_onnx.totalBytes,
    install_state: 'not_installed',
    contributes: {
      settings: {
        scope: 'workspace',
        tabTitle: '文件内容萃取',
        componentId: 'content_extraction',
        priority: 25
      }
    },
    resources: BUILTIN_MODULE_CATALOG_META.asr_sensevoice_onnx.resourceIds.map(
      buildResourceSpecFromCatalog
    )
  },
  // 6. 离线语音合成 TTS (Moss-TTS 与 M5-TTS)
  {
    id: BUILTIN_MODULE_CATALOG_META.tts_moss_onnx.id,
    name: '个性化声音克隆与朗读',
    description:
      '【支持克隆专属声音】内置声音提取器，上传一段录音即可克隆专属声音朗读文章。支持 50+ 款精选音色与自定义克隆。',
    icon: 'Volume2',
    kind: 'builtin-module',
    version: BUILTIN_MODULE_CATALOG_META.tts_moss_onnx.version,
    catalog_version: BUILTIN_MODULE_CATALOG_META.tts_moss_onnx.catalogVersion,
    category: BUILTIN_MODULE_CATALOG_META.tts_moss_onnx.category,
    capability_slot: BUILTIN_MODULE_CATALOG_META.tts_moss_onnx.capabilitySlot,
    slot_policy: BUILTIN_MODULE_CATALOG_META.tts_moss_onnx.slotPolicy,
    backend_type: BUILTIN_MODULE_CATALOG_META.tts_moss_onnx.backendType,
    author_code: 'official',
    total_bytes: BUILTIN_MODULE_CATALOG_META.tts_moss_onnx.totalBytes,
    install_state: 'not_installed',
    contributes: {
      settings: {
        scope: 'global',
        tabTitle: '个性化声音克隆',
        componentId: 'tts',
        priority: 30
      }
    },
    resources: BUILTIN_MODULE_CATALOG_META.tts_moss_onnx.resourceIds.map(
      buildResourceSpecFromCatalog
    )
  },
  {
    id: BUILTIN_MODULE_CATALOG_META.tts_m5_onnx.id,
    name: '极速语音合成与朗读',
    description:
      '【极速省电朗读】按下播放毫秒级即刻发声，内置 50+ 丰富高品质声线，长篇文档朗读流畅不卡顿。普通轻薄本流畅运行。',
    icon: 'Zap',
    kind: 'builtin-module',
    version: BUILTIN_MODULE_CATALOG_META.tts_m5_onnx.version,
    catalog_version: BUILTIN_MODULE_CATALOG_META.tts_m5_onnx.catalogVersion,
    category: BUILTIN_MODULE_CATALOG_META.tts_m5_onnx.category,
    capability_slot: BUILTIN_MODULE_CATALOG_META.tts_m5_onnx.capabilitySlot,
    slot_policy: BUILTIN_MODULE_CATALOG_META.tts_m5_onnx.slotPolicy,
    backend_type: BUILTIN_MODULE_CATALOG_META.tts_m5_onnx.backendType,
    author_code: 'official',
    author_name: null,
    availability: BUILTIN_MODULE_CATALOG_META.tts_m5_onnx.availability,
    firecore_cost: 0,
    total_bytes: BUILTIN_MODULE_CATALOG_META.tts_m5_onnx.totalBytes,
    install_state: 'not_installed',
    contributes: {
      settings: {
        scope: 'global',
        tabTitle: '极速语音朗读',
        componentId: 'tts',
        priority: 30
      }
    },
    resources: BUILTIN_MODULE_CATALOG_META.tts_m5_onnx.resourceIds.map(buildResourceSpecFromCatalog)
  },
  {
    id: BUILTIN_MODULE_CATALOG_META.diffusion_studio.id,
    name: '本地生图 Studio',
    description:
      '【电脑本地自己画图】输入一句话即可在本地画出精美图片，不花一分钱。需要较好的独立显卡。',
    icon: 'Sparkles',
    kind: 'builtin-module',
    version: BUILTIN_MODULE_CATALOG_META.diffusion_studio.version,
    catalog_version: BUILTIN_MODULE_CATALOG_META.diffusion_studio.catalogVersion,
    category: BUILTIN_MODULE_CATALOG_META.diffusion_studio.category,
    capability_slot: BUILTIN_MODULE_CATALOG_META.diffusion_studio.capabilitySlot,
    slot_policy: BUILTIN_MODULE_CATALOG_META.diffusion_studio.slotPolicy,
    backend_type: BUILTIN_MODULE_CATALOG_META.diffusion_studio.backendType,
    author_code: 'official',
    author_name: null,
    availability: 'coming_soon',
    firecore_cost: 0,
    total_bytes: BUILTIN_MODULE_CATALOG_META.diffusion_studio.totalBytes,
    install_state: 'not_installed'
  },
  {
    id: BUILTIN_MODULE_CATALOG_META.archive_vfs_parser.id,
    name: '压缩包透视与深度解析器',
    description:
      '【不用解压直接搜压缩包】不用解压 zip/rar 就能直接查看和搜索里面的文件内容，无额外电脑负担。',
    icon: 'Archive',
    kind: 'builtin-module',
    version: BUILTIN_MODULE_CATALOG_META.archive_vfs_parser.version,
    catalog_version: BUILTIN_MODULE_CATALOG_META.archive_vfs_parser.catalogVersion,
    category: BUILTIN_MODULE_CATALOG_META.archive_vfs_parser.category,
    capability_slot: BUILTIN_MODULE_CATALOG_META.archive_vfs_parser.capabilitySlot,
    slot_policy: BUILTIN_MODULE_CATALOG_META.archive_vfs_parser.slotPolicy,
    backend_type: BUILTIN_MODULE_CATALOG_META.archive_vfs_parser.backendType,
    author_code: 'official',
    author_name: null,
    availability: 'coming_soon',
    delist_reason: null,
    firecore_cost: 0,
    total_bytes: BUILTIN_MODULE_CATALOG_META.archive_vfs_parser.totalBytes,
    install_state: 'not_installed'
  }
]

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
  private inFlightResources = new Map<string, Promise<void>>()
  private liveProgress = new Map<
    string,
    { percentage: number; speed_bytes_per_sec: number; is_resumed: boolean }
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
  private cachedUsedBytes: number | null = null
  private lastUsedBytesCalculatedAt = 0
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
   * 计算当前生效插件目录下已就绪模块的真实磁盘占用
   */
  public async calculateCurrentDirUsedBytes(forceRefresh = false): Promise<number> {
    const now = Date.now()
    if (
      !forceRefresh &&
      this.cachedUsedBytes !== null &&
      now - this.lastUsedBytesCalculatedAt < 10000
    ) {
      return this.cachedUsedBytes
    }

    let totalBytes = 0
    const sharedDir = path.join(this.getPluginsRootDir(), '_shared')
    if (fs.existsSync(sharedDir)) {
      try {
        const entries = fs.readdirSync(sharedDir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const moduleDir = path.join(sharedDir, entry.name)
          const files = fs.readdirSync(moduleDir)
          const hasReady = hasAnyReadyMarkerFile(files)
          if (!hasReady) continue

          const calculateDir = (dir: string): void => {
            const list = fs.readdirSync(dir, { withFileTypes: true })
            for (const item of list) {
              const full = path.join(dir, item.name)
              if (item.isDirectory()) {
                if (item.name.startsWith('.deleting-') || item.name.startsWith('.migrating-'))
                  continue
                calculateDir(full)
              } else if (item.isFile()) {
                if (
                  item.name.endsWith('.part') ||
                  item.name.startsWith('.deleting-') ||
                  item.name.startsWith('.migrating-')
                )
                  continue
                try {
                  totalBytes += fs.statSync(full).size
                } catch {}
              }
            }
          }
          calculateDir(moduleDir)
        }
      } catch {}
    }

    this.cachedUsedBytes = totalBytes
    this.lastUsedBytesCalculatedAt = now
    return totalBytes
  }

  /**
   * 校验候选插件存储目录合法性
   */
  public async validatePluginDir(targetPath: string): Promise<ValidatePluginDirResult> {
    const currentUsedBytes = await this.calculateCurrentDirUsedBytes()
    const sharedDir = path.join(this.getPluginsRootDir(), '_shared')
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

    return await validatePluginDirectory(targetPath, this.getPluginsRootDir(), {
      totalSourceBytes: currentUsedBytes,
      currentInstalledModuleIds: installedIds
    })
  }

  /**
   * 获取插件目录详细信息与运行态状态
   */
  public async getPluginDirInfo(): Promise<PluginDirInfo> {
    const currentDir = this.getPluginsRootDir()
    const committedDir = this.getCommittedPluginsRootDir()
    const defaultDir = path.join(this.getBaseDir(), 'modules')
    const isDefault = isPathEqual(currentDir, defaultDir)
    const defaultDirNonAscii = /[^\x20-\x7E]/.test(defaultDir)
    const usedBytes = await this.calculateCurrentDirUsedBytes()
    const { freeBytes } = getDiskFreeSpace(currentDir)

    let previousPath: string | null = null
    let previousPathExists = false
    try {
      const prev = this.getConfigOrchestrator()?.getValue('PREVIOUS_PLUGIN_MODULES_PATH')
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
      phase: this.dirRuntimePhase,
      usedBytes,
      freeBytes,
      previousPath,
      previousPathExists
    }
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
    this.assertWriteGateAllowed()

    // 1. 前置 11 步校验管线
    const validation = await this.validatePluginDir(targetPath)
    if (!validation.valid) {
      return {
        success: false,
        errorCode: validation.errorCode ?? 'PATH_NOT_WRITABLE'
      }
    }

    const currentSourceDir = this.getPluginsRootDir()
    const resolvedTarget = path.resolve(targetPath.trim())

    // 2. 收集 BOM 哈希清单（供双端复制对账核验）
    const bomHashes = new Map<string, string>()
    try {
      const bomRecords = this.loadResourceBom()
      for (const item of bomRecords) {
        if (item.name && item.sha256) {
          bomHashes.set(item.name, item.sha256)
        }
      }
    } catch {}

    // 3. 执行流式迁移
    const result = await this.migrationCoordinatorInstance.executeMigration(
      currentSourceDir,
      resolvedTarget,
      {
        userDataDir: this.getBaseDir(),
        bomHashes,
        onPhaseChange: (phase: DirRuntimePhase) => {
          this.setDirRuntimePhase(phase)
        },
        onConfigCommit: async (newPath: string, oldPath: string) => {
          try {
            const orchestrator = this.getConfigOrchestrator()
            orchestrator?.setValue('PREVIOUS_PLUGIN_MODULES_PATH', oldPath)
            orchestrator?.setValue('PLUGIN_MODULES_PATH', newPath)
          } catch (err) {
            logger.warn(LogCategory.MAIN, '[ModularResourceService] 更新配置失败:', err)
          }
        }
      }
    )

    if (result.success) {
      this.oldDirCleanupDismissed = false
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
  public async applyInitialPluginDirectory(targetPath: string): Promise<{
    success: boolean
    appliedPath?: string
    errorCode?: PluginDirErrorCode
  }> {
    this.assertWriteGateAllowed()

    const resolvedTarget = path.resolve((targetPath ?? '').trim())
    const currentDir = this.getPluginsRootDir()
    // 幂等分支必须先于 11 步校验：校验器对「与当前目录相同」会返回 SAME_AS_CURRENT，
    // 但向导里用户直接选中默认目录是合法操作，等同于「不改」，无需校验也无需写配置。
    if (isPathEqual(currentDir, resolvedTarget)) {
      return { success: true, appliedPath: resolvedTarget }
    }

    // 1. 复用与插件中心完全相同的 11 步校验管线（纯英文路径、禁系统目录、空间门槛等）
    const validation = await this.validatePluginDir(targetPath)
    if (!validation.valid) {
      return {
        success: false,
        errorCode: validation.errorCode ?? 'PATH_NOT_WRITABLE'
      }
    }

    // 2. 严格前置条件：根目录下没有任何已就绪模块，否则必须回到迁移事务 + 重启链路
    const usedBytes = await this.calculateCurrentDirUsedBytes(true)
    if (usedBytes > 0) {
      return { success: false, errorCode: 'DIR_CHANGE_GATE_ACTIVE' }
    }

    // 3. 持久化配置（ConfigOrchestrator 的真实写入 API 是 updateValue，不是 setValue）
    const orchestrator = this.getConfigOrchestrator()
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
    this.effectivePluginsRootDir = resolvedTarget
    process.env.FIREFLY_MODULES_ROOT = resolvedTarget
    this.cachedUsedBytes = 0
    this.lastUsedBytesCalculatedAt = 0
    this.fastReadySnapshot.clear()
    this.repairPendingResources.clear()

    return { success: true, appliedPath: resolvedTarget }
  }

  /**
   * 取消正在进行的目录迁移 (仅在 PRECHECK / STAGING / VERIFYING 生效)
   */
  public async cancelDirMigration(): Promise<{
    cancelled: boolean
    errorCode?: PluginDirErrorCode
  }> {
    return await this.migrationCoordinatorInstance.cancelMigration(this.getBaseDir())
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
    this.assertWriteGateAllowed()

    let previousPath: string | undefined
    try {
      previousPath = this.getConfigOrchestrator()?.getValue('PREVIOUS_PLUGIN_MODULES_PATH')
    } catch {}

    if (!previousPath || !previousPath.trim() || !fs.existsSync(previousPath.trim())) {
      // 已经不存在，将配置清空并返回
      try {
        this.getConfigOrchestrator()?.setValue('PREVIOUS_PLUGIN_MODULES_PATH', '')
      } catch {}
      return { success: true, freedBytes: 0 }
    }

    const resolvedOld = path.resolve(previousPath.trim())
    const currentRoot = this.getPluginsRootDir()

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

    // 统计旧目录体积
    let freedBytes = 0
    const calculateDirBytes = (dir: string): void => {
      try {
        const list = fs.readdirSync(dir, { withFileTypes: true })
        for (const item of list) {
          const full = path.join(dir, item.name)
          if (item.isDirectory()) {
            calculateDirBytes(full)
          } else if (item.isFile()) {
            try {
              freedBytes += fs.statSync(full).size
            } catch {}
          }
        }
      } catch {}
    }
    calculateDirBytes(resolvedOld)

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
        this.deleteDirectoryFn(targetToDelete).catch(err => {
          logger.warn(LogCategory.MAIN, '[ModularResourceService] 异步清理旧目录失败:', err)
        })
      } catch {}
    }, 100)

    // 清空 PREVIOUS_PLUGIN_MODULES_PATH 配置
    try {
      this.getConfigOrchestrator()?.setValue('PREVIOUS_PLUGIN_MODULES_PATH', '')
    } catch {}

    return { success: true, freedBytes }
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
    const promise = this.verificationPromises.get(moduleId)
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
  private getCandidateBomPaths(): string[] {
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
      path.join(this.getBaseDir(), 'configs', 'resources.bom.json')
    )
    return Array.from(new Set(rawPaths.filter(Boolean)))
  }

  /**
   * 按资源 ID 获取预期文件清单（优先读取 BOM 文件，用于解压完成后的物理对账）
   */
  private loadBomFilesForResource(
    resourceId: string
  ): Array<{ name: string; size: number; sha256: string }> {
    if (this.resourceBomOverrides.has(resourceId)) {
      return this.resourceBomOverrides.get(resourceId)!
    }

    const candidateBomPaths = this.getCandidateBomPaths()

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
  public loadResourceBom(): Array<{ name: string; size: number; sha256: string }> {
    const candidateBomPaths = this.getCandidateBomPaths()

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
  private async checkL1TargetDirPreflight(
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
    const expectedFiles = this.loadBomFilesForResource(spec.resource_id)
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
          await invalidateReadyMarkers(targetAbsDir)
          await writeReadyMarker(targetAbsDir, {
            resourceId: spec.resource_id,
            sharedSubDir
          })
        } catch (err) {
          logger.warn(
            LogCategory.SYSTEM,
            `[ModularResource] BOM 慢路径写入就绪标记失败: ${spec.resource_id}`,
            err
          )
        }
        return 'slow_healed'
      } else {
        await this.isolateCorruptDirectory(targetAbsDir)
        return 'corrupted'
      }
    } else {
      // 无 BOM 清单的通用/测试资源：若已有 completed 记录且特征文件存在，补写标准 .ready.json 放行
      const task = this.getDao().resources.findByIdSync(spec.resource_id)
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
          await invalidateReadyMarkers(targetAbsDir)
          await writeReadyMarker(targetAbsDir, {
            resourceId: spec.resource_id,
            sharedSubDir
          })
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
  private async isolateCorruptDirectory(targetAbsDir: string): Promise<void> {
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
  private async checkL2LocalPresetPreflight(
    spec: CatalogResourceSpec,
    targetAbsDir: string
  ): Promise<boolean> {
    const rawCandidateDirs: string[] = []
    if (this.customPresetDir) {
      rawCandidateDirs.push(this.customPresetDir)
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
      path.join(this.getBaseDir(), 'presetResources')
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
        if (this.corruptedPresetCache.has(cacheKey)) {
          continue
        }

        try {
          const verify = await streamVerifySha256(presetPath, spec.expected_sha256)
          if (verify.valid) {
            logger.info(
              LogCategory.SYSTEM,
              `[ModularResource] L2 预置包探活命中: ${presetPath}，本地物化至 ${targetAbsDir}`
            )
            // 物化前先清理目标目录旧 .ready* 标记，防 TOCTOU
            await invalidateReadyMarkers(targetAbsDir)

            const lowerAsset = spec.asset_name.toLowerCase()
            if (lowerAsset.endsWith('.zip') || lowerAsset.endsWith('.ffp')) {
              const intentsDir = path.join(this.getBaseDir(), '.intents')
              await safeExtractZip(presetPath, targetAbsDir, intentsDir)
            } else {
              await fs.promises.mkdir(targetAbsDir, { recursive: true })
              const destFile = path.join(targetAbsDir, spec.asset_name)
              const tmpFile = `${destFile}.tmp-${Date.now()}`
              await fs.promises.copyFile(presetPath, tmpFile)
              await renameWithRetry(tmpFile, destFile)
            }

            // 解压/物化完成后仅向 targetAbsDir (_shared/<sharedSubDir>) 写入标准 .ready.json
            await writeReadyMarker(targetAbsDir, {
              resourceId: spec.resource_id,
              sharedSubDir
            })

            return true
          } else {
            // 仅记录内存缓存，严禁向只读目录调用 unlinkSync
            this.corruptedPresetCache.set(cacheKey, true)
          }
        } catch {
          this.corruptedPresetCache.set(cacheKey, true)
        }
      }
    }

    return false
  }

  /**
   * 同步执行目录元数据更新（确保 DEFAULT_CATALOG_SEEDS 新增模块落地）
   */
  public ensureDefaultSeeds(): void {
    const dao = this.getDao()
    const existing = dao.modules.listAllSync()
    if (!this.seeded || existing.length === 0) {
      try {
        this.syncCatalogSync(DEFAULT_CATALOG_SEEDS)
        this.seeded = true
      } catch (err) {
        logger.warn(LogCategory.SYSTEM, '[ModularResource] 初始化内置目录种子失败:', err)
      }
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
  public reconcileBuiltinModuleBindingsSync(): {
    repairedPaths: string[]
    failedRepairs: string[]
    removedObsolete: string[]
    backfilledBindings: Array<{ moduleId: string; resourceId: string }>
    schemaIndexDriftDetected: boolean
  } {
    const db = this.getDb()
    const dao = this.getDao()
    const pluginsRootDir = this.getPluginsRootDir()

    this.repairPendingResources.clear()
    this.unknownResources.clear()
    this.deferredBackfillResources.clear()
    this.schemaIndexDriftDetected = false

    // 若主表读取即抛出 DB 级致命异常，直接上抛阻断 Omni 启动
    dao.modules.listAllSync()
    this.ensureDefaultSeeds()

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
            logger.info(
              LogCategory.SYSTEM,
              '[ModularResource] 修复偏离 SSOT 的 target_local_path',
              {
                resourceId: res.resource_id,
                oldTargetLocalPath: res.target_local_path,
                canonicalPath
              }
            )
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
            this.repairPendingResources.add(res.resource_id)
            this.fastReadySnapshot.set(res.resource_id, {
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
        this.unknownResources.add(res.resource_id)
        try {
          resolvePhysicalPath(pluginsRootDir, res.target_local_path)
        } catch (err: any) {
          logger.error(
            LogCategory.SYSTEM,
            `[ModularResource] 未知资源存在非法相对路径，标记 pending_repair 并拒绝挂载: ${res.resource_id}`,
            err
          )
          this.repairPendingResources.add(res.resource_id)
          this.fastReadySnapshot.set(res.resource_id, {
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
          ...refRows.map(r => r.module_id)
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
        const existingIds = new Set(existingResources.map(r => r.resource_id))
        const missingIds = meta.resourceIds.filter(id => !existingIds.has(id))

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
              dao.resources.updateProgressSync(resId, spec.expected_bytes, 'completed')
              dao.resources.markVerifiedSync(resId, true, spec.expected_sha256)
            }
            dao.resources.bindResourceToModuleSync(modId, resId)
          })
          bindTx()

          backfilledBindings.push({ moduleId: modId, resourceId: resId })

          if (
            !physicallyReady &&
            modId === 'engine_classic_light' &&
            resId === 'mobile-clip' &&
            (modRow.install_state === 'active' || modRow.install_state === 'installed_inactive')
          ) {
            this.deferredBackfillResources.add(resId)
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
          this.schemaIndexDriftDetected = true
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
      schemaIndexDriftDetected: this.schemaIndexDriftDetected
    }
  }

  /**
   * 为 engine_classic_light 保活场景判断除可选同伴 mobile-clip 外其余核心资产是否就绪
   */
  private isClassicEngineCoreReady(boundResources: ResourceDownloadRecord[]): boolean {
    const coreIds = ['bekko-a8m', 'chinese-clip']
    return coreIds.every(coreId => {
      const res = boundResources.find(r => r.resource_id === coreId)
      if (!res || res.download_state !== 'completed') return false
      try {
        const abs = this.resolvePhysicalPath(res.target_local_path)
        return fs.existsSync(abs)
      } catch {
        return false
      }
    })
  }

  /**
   * 后台静默补下载伴随资源（如存量 engine_classic_light 缺失的 mobile-clip），完成后热刷新挂载
   */
  private triggerCompanionBackfill(moduleId: string, resourceId: BuiltinSharedResourceId): void {
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
      return
    }
    const dao = this.getDao()
    const task = dao.resources.findByIdSync(resourceId)
    if (!task || task.download_state === 'completed') return
    if (this.inFlightResources.has(resourceId)) return

    const spec = buildResourceSpecFromCatalog(resourceId)
    const flight = this.downloadAndInstallSingleResource(moduleId, task, spec)
      .then(async () => {
        const mod = dao.modules.findByIdSync(moduleId)
        if (mod?.install_state === 'active') {
          await this.notifyRuntimePluginTopologyChanged({
            moduleId,
            reason: 'companion_backfill',
            restartPolicy: 'restart'
          })
        }
      })
      .catch(err => {
        logger.warn(
          LogCategory.SYSTEM,
          `[ModularResource] 伴随资源后台补齐失败 (${moduleId}/${resourceId}):`,
          err
        )
      })
      .finally(() => {
        this.inFlightResources.delete(resourceId)
      })

    this.inFlightResources.set(resourceId, flight)
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
    const baseDir = this.getBaseDir()
    const pluginsRootDir = this.getPluginsRootDir()
    const sharedDir = PluginPathResolver.getSharedDirForRoot(pluginsRootDir)

    // 外置慢盘/磁盘不可达时，执行 0ms 保护性短路，严禁破坏性清扫与退档数据库状态
    const parsedRoot = path.parse(pluginsRootDir)
    const rootDriveAvailable = !parsedRoot.root || fs.existsSync(parsedRoot.root)
    if (!rootDriveAvailable) {
      this.rootUnavailable = true
      this.fastReadySnapshot.clear()
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
    this.rootUnavailable = false

    let cleanedTombstones = 0
    cleanedTombstones += await cleanOrphanTombstones(baseDir)
    cleanedTombstones += await cleanOrphanTombstones(pluginsRootDir)
    cleanedTombstones += await cleanOrphanTombstones(sharedDir)
    cleanedTombstones += await this.tombstoneGC.reconcileOnStartup([
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

    // B4: 扫描并自愈由于杀软占用或断电未完成的目录切换意图日志
    const intentsDir = path.join(baseDir, '.intents')
    await reconcileDirSwitchIntents(intentsDir)

    // 自愈未完成的插件根目录大迁移意图日志 (Issue 03)
    cleanedTombstones += await this.migrationCoordinatorInstance.reconcileOnStartup(
      baseDir,
      this.getCommittedPluginsRootDir()
    )

    const dao = this.getDao()
    const resetDownloads: string[] = []
    const resetModules: string[] = []

    // 1. 单资源隔离对账物理资源记录
    const allResources = dao.resources.listAllSync()
    for (const res of allResources) {
      if (this.repairPendingResources.has(res.resource_id)) {
        continue
      }

      let targetAbsPath: string
      try {
        targetAbsPath = this.resolvePhysicalPath(res.target_local_path)
      } catch (pathErr: any) {
        logger.error(
          LogCategory.SYSTEM,
          `[ModularResource] 对账阶段检测到非法路径，标为 pending_repair: ${res.resource_id}`,
          pathErr
        )
        this.repairPendingResources.add(res.resource_id)
        this.fastReadySnapshot.set(res.resource_id, {
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
            const deleted = await this.deleteDirectoryFn(targetAbsPath)
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
            const archivePath = this.resolveDownloadArchivePath(res.resource_id, res.asset_name)
            const partPath = `${archivePath}.part`
            if (fs.existsSync(partPath)) {
              const partSize = fs.statSync(partPath).size
              dao.resources.updateProgressSync(res.resource_id, partSize, 'paused')
            } else {
              dao.resources.updateProgressSync(res.resource_id, 0, 'pending')
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
              dao.resources.markVerifiedSync(
                res.resource_id,
                true,
                res.expected_sha256 || undefined
              )
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
        this.repairPendingResources.add(res.resource_id)
        this.fastReadySnapshot.set(res.resource_id, {
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
        const boundResources = dao.resources.findResourcesByModuleSync(mod.id)
        let missingPhysical = false
        let needsClassicMobileClipBackfill = false

        if (mod.install_path) {
          try {
            const modAbsPath = this.resolvePhysicalPath(mod.install_path)
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
            this.isClassicEngineCoreReady(boundResources)

          for (const res of boundResources) {
            let resExists = false
            try {
              const resAbsPath = this.resolvePhysicalPath(res.target_local_path)
              resExists = fs.existsSync(resAbsPath)
            } catch {
              resExists = false
            }

            if (res.download_state !== 'completed' || !resExists) {
              if (res.resource_id === 'mobile-clip' && coreReadyForClassic) {
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
          this.deferredBackfillResources.add('mobile-clip')
          this.triggerCompanionBackfill('engine_classic_light', 'mobile-clip')
        }
      }
    }

    // 3. 启动期离线总包两阶段对账自愈与后台 Dry-Run 校验队列
    try {
      const { StartupReconciler } = await import('../modular-resource/startup-reconciler')
      const { OfflinePackageDao } = await import('../modular-resource/offline-package-dao')
      const db = this.getDb()
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
    await this.syncEmbeddingProfileToConfig()

    return {
      cleanedTombstones,
      resetModules,
      resetDownloads
    }
  }

  /**
   * 冷启动纯异步快路径门禁 Barrier (Spec §2.3.4, §2.6)
   * - 严禁 `fs.*Sync` 阻塞事件循环，并发上限 4，Promise.race 预算默认 200ms
   * - 产出 `ready_fast` / `legacy_heal` / `pending_repair` / `pending_validation` 四态快照
   * - `pending_validation` 与 `pending_repair` 严禁进入挂载清单
   */
  public async runFastReadyBarrier(timeoutMs = 200): Promise<FastReadyBarrierResult> {
    const startMs = Date.now()
    if (this.rootUnavailable) {
      this.fastReadySnapshot.clear()
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

    const dao = this.getDao()
    const pluginsRootDir = this.getPluginsRootDir()
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

      if (this.repairPendingResources.has(res.resource_id)) {
        const existingDiag = this.fastReadySnapshot.get(res.resource_id)
        settled.set(res.resource_id, {
          resourceId: res.resource_id,
          sharedSubDir,
          physicalDir: null,
          status:
            existingDiag?.status === 'unknown_resource' ? 'unknown_resource' : 'pending_repair',
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

      if (this.unknownResources.has(res.resource_id)) {
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
        this.fastReadySnapshot.set(res.resource_id, entry)
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
        this.fastReadySnapshot.set(res.resource_id, pendingEntry)
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
            this.scheduleBackgroundFullVerification(Array.from(targets), 10)
          })
      } else {
        this.scheduleBackgroundFullVerification(Array.from(targets), 50)
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
  public scheduleBackgroundFullVerification(resourceIds: string[], delayMs = 50): Promise<void> {
    if (resourceIds.length === 0) {
      return Promise.resolve()
    }
    const runTask = async () => {
      await this.processBackgroundVerification(resourceIds)
    }
    if (delayMs <= 0) {
      return runTask()
    }
    return new Promise<void>(resolve => {
      if (this.bgVerificationTimer) {
        clearTimeout(this.bgVerificationTimer)
      }
      this.bgVerificationTimer = setTimeout(() => {
        this.bgVerificationTimer = null
        runTask().finally(resolve)
      }, delayMs)
      this.bgVerificationTimer.unref?.()
    })
  }

  public cleanupForTesting(): void {
    if (this.bgVerificationTimer) {
      clearTimeout(this.bgVerificationTimer)
      this.bgVerificationTimer = null
    }
  }

  private async processBackgroundVerification(resourceIds: string[]): Promise<void> {
    if (this.bgVerificationInFlight) {
      await this.bgVerificationInFlight.catch(() => {})
    }

    const work = (async () => {
      try {
        const dao = this.getDao()
        const pluginsRootDir = this.getPluginsRootDir()
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
            this.fastReadySnapshot.set(resourceId, {
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

          const prevStatus = this.fastReadySnapshot.get(resourceId)?.status
          const expectedFiles = this.loadBomFilesForResource(resourceId)
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
              await invalidateReadyMarkers(targetDir)
              const digestResult = await computeDirectoryReadyDigest(targetDir)
              await writeReadyMarker(targetDir, {
                resourceId,
                sharedSubDir,
                digestResult
              })
              this.fastReadySnapshot.set(resourceId, {
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
            await this.isolateCorruptDirectory(targetDir)
            this.fastReadySnapshot.set(resourceId, {
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
          await this.notifyRuntimePluginTopologyChanged({
            reason: 'background_verified',
            restartPolicy: 'restart'
          })
        }
      } catch (err: any) {
        logger.warn(LogCategory.SYSTEM, '[ModularResource] 后台全量校验异常:', err)
      }
    })()

    this.bgVerificationInFlight = work
    try {
      await work
    } finally {
      if (this.bgVerificationInFlight === work) {
        this.bgVerificationInFlight = null
      }
    }
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
    if (this.rootUnavailable) {
      return []
    }
    const dao = this.getDao()
    const pluginsRootDir = this.getPluginsRootDir()
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
      if (this.repairPendingResources.has(resId) || this.unknownResources.has(resId)) {
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

      let snap = this.fastReadySnapshot.get(resId)
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
            this.fastReadySnapshot.set(resId, snap)
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
          this.fastReadySnapshot.delete(resId)
          this.repairPendingResources.add(resId)
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
      if (this.topologyListener) {
        await this.topologyListener(opts)
        return
      }
      try {
        const { omniService } = await import('./omni-service')
        if (typeof omniService?.handleTopologyChanged === 'function') {
          await omniService.handleTopologyChanged(opts)
        }
      } catch (err) {
        if (this.topologyListener) {
          throw err
        }
        // 在纯离线无 Omni 环境的单元测试中忽略模块加载失败，真实已启动环境 error 向上抛出
        const msg = err instanceof Error ? err.message : String(err)
        if (!msg.includes('Cannot find module')) {
          throw err
        }
      }
    }

    await this.topologyCoordinator.coalesceTopologyNotify(runNotify)
  }

  /**
   * 同步执行目录元数据更新（内部复用）
   */
  private syncCatalogSync(entries: CatalogModuleEntry[]): {
    updated: number
    skippedRegression: number
  } {
    const db = this.getDb()
    const dao = this.getDao()
    let updated = 0
    let skippedRegression = 0

    const tx = db.transaction((items: CatalogModuleEntry[]) => {
      for (const entry of items) {
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
      }
    })

    tx(entries)
    return { updated, skippedRegression }
  }

  /**
   * 增量同步插件目录元数据（满足 IN-04：remote.catalog_version < local.catalog_version 时忽略并告警；离线静默兜底）
   */
  async syncCatalog(entries: CatalogModuleEntry[]): Promise<{
    updated: number
    skippedRegression: number
  }> {
    try {
      const targetEntries =
        Array.isArray(entries) && entries.length > 0 ? entries : DEFAULT_CATALOG_SEEDS
      return this.syncCatalogSync(targetEntries)
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[ModularResource] 同步目录异常，静默兜底本地内置种子:', err)
      try {
        return this.syncCatalogSync(DEFAULT_CATALOG_SEEDS)
      } catch {
        return { updated: 0, skippedRegression: 0 }
      }
    }
  }

  /**
   * 将数据库记录与关联资源组装为前端可直接消费的 BuiltinModuleView
   */
  private buildModuleView(record: BuiltinModuleRecord): BuiltinModuleView {
    const dao = this.getDao()
    const resources = dao.resources.findResourcesByModuleSync(record.id)
    const seed = DEFAULT_CATALOG_SEEDS.find(s => s.id === record.id)

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
      record.install_state !== 'active' && this.backgroundInstallQueue.includes(record.id)
    const effectiveInstallState = isQueuedInBackground ? 'downloading' : record.install_state

    const live = this.liveProgress.get(record.id)
    let downloadProgress = live
    if (!downloadProgress && effectiveInstallState === 'downloading' && resources.length > 0) {
      const totalExpected = resources.reduce((acc, r) => acc + (r.expected_bytes || 0), 0)
      const totalDownloaded = resources.reduce((acc, r) => acc + (r.downloaded_bytes || 0), 0)
      const percentage =
        totalExpected > 0 ? Math.min(100, Math.round((totalDownloaded / totalExpected) * 100)) : 0
      downloadProgress = {
        percentage,
        speed_bytes_per_sec: 0,
        is_resumed: false
      }
    }

    const contributes = meta.contributes || seed?.contributes
    const isRunning = this.processManager
      ? this.processManager.isRunning(record.id)
      : record.install_state === 'active'
    const isUsable = this.processManager
      ? this.processManager.isUsable(record.id)
      : record.install_state === 'active'
    const holdReasons = this.processManager ? this.processManager.getHoldReasons(record.id) : []

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
        this.findReadyBackupModulesSync(record).length > 0)

    let validationStatus: BuiltinModuleView['validation_status']
    let validationMessage: string | undefined
    if (this.rootUnavailable && record.install_state === 'active') {
      validationStatus = 'pending_repair'
      validationMessage = '插件存储目录不可达，请检查磁盘连接'
    } else if (resources.length > 0) {
      const snaps = resources
        .map(r => this.fastReadySnapshot.get(r.resource_id))
        .filter((s): s is ResourceValidationEntry => Boolean(s))
      if (snaps.some(s => s.status === 'pending_repair' || s.status === 'unknown_resource')) {
        validationStatus = 'pending_repair'
        validationMessage = '模型损坏需修复'
      } else if (snaps.some(s => s.status === 'pending_validation')) {
        validationStatus = 'pending_validation'
        validationMessage = '正在校验插件'
      } else if (snaps.some(s => s.status === 'legacy_heal')) {
        validationStatus = 'legacy'
      } else if (snaps.length > 0 && snaps.every(s => s.status === 'ready_fast')) {
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
   * 获取模块完整视图列表（支持 scope: 'market' | 'installed' 过滤）
   */
  listModules(filter?: {
    scope?: 'market' | 'installed'
    category?: string
    includeDraft?: boolean
  }): BuiltinModuleView[] {
    this.ensureDefaultSeeds()
    const dao = this.getDao()
    const devModeEffective = typeof electronApp !== 'undefined' ? !electronApp.isPackaged : true
    const includeDraft = filter?.includeDraft ?? devModeEffective

    const records = dao.modules.listAllSync({
      scope: filter?.scope ?? 'market',
      category: filter?.category,
      includeDraft
    })

    // 按照内置种子顺序优先排列，其余按 ID 排序
    const seedOrder = new Map(DEFAULT_CATALOG_SEEDS.map((s, idx) => [s.id, idx]))
    records.sort((a, b) => {
      const idxA = seedOrder.has(a.id) ? seedOrder.get(a.id)! : 999
      const idxB = seedOrder.has(b.id) ? seedOrder.get(b.id)! : 999
      if (idxA !== idxB) return idxA - idxB
      return a.id.localeCompare(b.id)
    })

    return records.map(r => this.buildModuleView(r))
  }

  /**
   * 解析模块所需的物理资源定义列表
   */
  private resolveModuleResourceSpecs(record: BuiltinModuleRecord): CatalogResourceSpec[] {
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
    const seed = DEFAULT_CATALOG_SEEDS.find(s => s.id === record.id)
    if (seed?.resources && seed.resources.length > 0) {
      return seed.resources
    }
    const bound = this.getDao().resources.findResourcesByModuleSync(record.id)
    return bound.map(r => ({
      resource_id: r.resource_id,
      asset_name: r.asset_name,
      target_local_path: r.target_local_path,
      active_source_key: (r.active_source_key as 'auto' | 'cn' | 'global') || 'auto',
      active_url: r.active_url ?? undefined,
      expected_bytes: r.expected_bytes,
      expected_sha256: r.expected_sha256
    }))
  }

  /**
   * 幂等下载并安装模块（引用计数复用 -> Range 206 -> SHA-256 -> Zip Slip 解压 -> 原子 rename）
   */
  async installModule(
    moduleId: string,
    onProgress?: (event: ModuleDownloadProgressEvent) => void,
    options?: { skipLocalPreset?: boolean }
  ): Promise<BuiltinModuleView> {
    this.assertWriteGateAllowed()
    this.ensureDefaultSeeds()

    return await this.topologyCoordinator.execute(async () => {
      const dao = this.getDao()
      const record = dao.modules.findByIdSync(moduleId)
      if (!record) {
        throw new Error(`未找到模块定义: ${moduleId}`)
      }

      // 1. 将模块置为 downloading
      dao.modules.updateInstallStateSync(moduleId, 'downloading')

      const resourceSpecs = this.resolveModuleResourceSpecs(record)
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
        this.liveProgress.delete(moduleId)
        return this.buildModuleView(dao.modules.findByIdSync(moduleId)!)
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

          const targetAbsDir = this.resolvePhysicalPath(task.target_local_path)

          // 2. 确定性三级物理探活拓扑 (L1 目标解压目录 -> L2 本地预置包 -> L3 网络下载)
          // L1: 目标解压目录探活 (快路径毫秒放行 + 慢路径自愈补标记)
          const l1Result = await this.checkL1TargetDirPreflight(targetAbsDir, spec)
          if (l1Result === 'fast_hit' || l1Result === 'slow_healed') {
            dao.resources.markVerifiedSync(spec.resource_id, true)
            dao.resources.updateProgressSync(spec.resource_id, spec.expected_bytes, 'completed')
            this.repairPendingResources.delete(spec.resource_id)
            this.fastReadySnapshot.set(spec.resource_id, {
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
                const expectedFiles = this.loadBomFilesForResource(spec.resource_id)
                for (const ef of expectedFiles) {
                  const p = path.join(targetAbsDir, ef.name)
                  if (!fs.existsSync(p)) return false
                  const v = await streamVerifySha256(p, ef.sha256)
                  if (!v.valid) {
                    await this.isolateCorruptDirectory(targetAbsDir)
                    this.fastReadySnapshot.set(spec.resource_id, {
                      resourceId: spec.resource_id,
                      sharedSubDir: resolveSharedSubDir(spec.resource_id),
                      physicalDir: null,
                      status: 'pending_repair',
                      validationLevel: 'full',
                      reason: 'background_bom_mismatch',
                      checkedAt: Date.now()
                    })
                    await this.notifyRuntimePluginTopologyChanged({
                      moduleId,
                      reason: 'background_verified',
                      restartPolicy: 'restart'
                    }).catch(() => {})
                    return false
                  }
                }
                return true
              })()
              this.verificationPromises.set(moduleId, asyncVerifyPromise)
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
            this.liveProgress.set(moduleId, {
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
            envSkipRaw === '1' ||
            envSkipRaw === 'true' ||
            envSkipRaw === 'yes' ||
            envSkipRaw === 'on'
          const l2Hit =
            options?.skipLocalPreset || envSkipLocalPreset
              ? false
              : await this.checkL2LocalPresetPreflight(spec, targetAbsDir)
          if (l2Hit) {
            dao.resources.markVerifiedSync(spec.resource_id, true)
            dao.resources.updateProgressSync(spec.resource_id, spec.expected_bytes, 'completed')
            this.repairPendingResources.delete(spec.resource_id)
            this.fastReadySnapshot.set(spec.resource_id, {
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
            this.liveProgress.set(moduleId, {
              percentage: 100,
              speed_bytes_per_sec: 0,
              is_resumed: false
            })
            onProgress?.(completedEvt)
            continue
          }

          // L3: 网络分块并发断点下载与 Singleflight 保护
          let flight = this.inFlightResources.get(spec.resource_id)
          if (!flight) {
            flight = this.downloadAndInstallSingleResource(
              moduleId,
              task,
              spec,
              onProgress
            ).finally(() => {
              this.inFlightResources.delete(spec.resource_id)
            })
            this.inFlightResources.set(spec.resource_id, flight)
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
          await this.notifyRuntimePluginTopologyChanged({
            moduleId,
            reason: 'module_install',
            restartPolicy: 'restart'
          })
          if (slot === 'base_embedding') {
            await this.syncEmbeddingProfileToConfig()
          }
        }

        this.liveProgress.delete(moduleId)
        return this.buildModuleView(dao.modules.findByIdSync(moduleId)!)
      } catch (err: any) {
        const errorMsg = err?.message || String(err)
        const latest = dao.modules.findByIdSync(moduleId)
        // 若所有资源实际上已下载完毕、仅在通知激活阶段出错，保留 installed_inactive 以免丢失已下载权重
        const bound = dao.resources.findResourcesByModuleSync(moduleId)
        const allResourcesCompleted =
          bound.length > 0 && bound.every(r => r.download_state === 'completed')
        dao.modules.updateInstallStateSync(
          moduleId,
          allResourcesCompleted && latest?.install_state !== 'downloading'
            ? 'installed_inactive'
            : 'error',
          errorMsg
        )
        this.liveProgress.delete(moduleId)
        throw err
      }
    })
  }

  /**
   * 将选配模块加入后台静默安装队列（单实例串行 Singleflight，支持跨上下文接管）
   */
  async enqueueBackgroundInstalls(moduleIds: string[]): Promise<string[]> {
    this.assertWriteGateAllowed()
    this.ensureDefaultSeeds()
    const dao = this.getDao()
    const validIds: string[] = []

    for (const id of moduleIds) {
      if (!id || typeof id !== 'string') continue
      const rec = dao.modules.findByIdSync(id)
      if (rec && rec.install_state === 'active') {
        continue // 已激活的无需重复安装
      }
      if (!this.backgroundInstallQueue.includes(id)) {
        this.backgroundInstallQueue.push(id)
        validIds.push(id)
        if (!rec || rec.install_state !== 'downloading') {
          dao.modules.updateInstallStateSync(id, 'downloading')
        }
        if (!this.liveProgress.has(id)) {
          this.liveProgress.set(id, {
            percentage: 0,
            speed_bytes_per_sec: 0,
            is_resumed: false
          })
        }
        this.backgroundProgressBroadcaster?.({
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

    if (!this.isProcessingBackgroundQueue && this.backgroundInstallQueue.length > 0) {
      void this.processBackgroundInstallQueue()
    }

    return validIds
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
    if (this.isProcessingBackgroundQueue) return
    this.isProcessingBackgroundQueue = true

    try {
      while (this.backgroundInstallQueue.length > 0) {
        const nextId = this.backgroundInstallQueue.shift()!
        try {
          logger.info(
            LogCategory.SYSTEM,
            `[ModularResource] 开始执行后台选配插件静默安装: ${nextId}`
          )
          await this.installModule(nextId, progressEvt => {
            this.backgroundProgressBroadcaster?.(progressEvt)
          })
          // installModule 返回代表激活与底座挂载已彻底完成，再补发一次最终态同步事件，确保前端立刻从「下载/激活中」切为已激活
          this.backgroundProgressBroadcaster?.({
            moduleId: nextId,
            resourceId: '',
            downloadedBytes: 0,
            expectedBytes: 0,
            percentage: 100,
            speedBytesPerSec: 0,
            isResumed: false,
            state: 'completed'
          })
          logger.info(LogCategory.SYSTEM, `[ModularResource] 后台选配插件安装就绪并激活: ${nextId}`)
        } catch (err: any) {
          logger.warn(
            LogCategory.SYSTEM,
            `[ModularResource] 后台选配插件安装异常 (${nextId}):`,
            err
          )
          this.backgroundProgressBroadcaster?.({
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
        }
      }
    } finally {
      this.isProcessingBackgroundQueue = false
    }
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
    const dao = this.getDao()
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

    const archivePath = this.resolveDownloadArchivePath(task.resource_id, task.asset_name)
    const partPath = `${archivePath}.part`
    const hadPartBefore = fs.existsSync(partPath) && fs.statSync(partPath).size > 0
    const targetAbsDir = this.resolvePhysicalPath(task.target_local_path)

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

    dao.resources.updateProgressSync(task.resource_id, task.downloaded_bytes || 0, 'downloading')

    // 大文件（>4MiB）且存在可用 URL 时，默认优先启用固定 4MiB 块网格并发断点续传下载器
    const canUseFixedBlocks =
      typeof this.downloadService.downloadWithFixedBlocks === 'function' &&
      candidateUrls.length > 0 &&
      task.expected_bytes > 4 * 1024 * 1024

    let result: VerifiedDownloadResult | null = null

    if (canUseFixedBlocks) {
      logger.info(
        LogCategory.SYSTEM,
        `[Download] 启用固定 4MiB 块网格并发断点续传下载器 (${task.resource_id}, expected: ${(task.expected_bytes / 1024 / 1024).toFixed(1)}MB, 候选源: ${candidateUrls.length})`
      )
      try {
        result = await this.downloadService.downloadWithFixedBlocks({
          taskId: `${moduleId}:${task.resource_id}`,
          assetId: task.resource_id,
          urls: candidateUrls,
          destPath: archivePath,
          expectedBytes: task.expected_bytes,
          expectedSha256: task.expected_sha256,
          maxConcurrency: 8,
          maxInflightBlocks: 8,
          router: this.sourceRouter,
          transport: this.transport,
          onProgress: prog => {
            // ISS-13: 字节加权下载阶段 0 ~ 92%
            const total = prog.totalBytes || task.expected_bytes || 1
            const pct = Math.min(92, Math.round((prog.receivedBytes / total) * 92))
            dao.resources.updateProgressSync(task.resource_id, prog.receivedBytes, 'downloading')
            this.liveProgress.set(moduleId, {
              percentage: pct,
              speed_bytes_per_sec: prog.speed,
              is_resumed: hadPartBefore
            })
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
        if (!result.success) {
          logger.warn(
            LogCategory.SYSTEM,
            `[Download] 并发分块下载未成功 (${task.resource_id}): ${result.errorMessage || result.errorCode}，平滑降级至单流重试下载...`
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
        logger.info(
          LogCategory.SYSTEM,
          `[Download] 尝试下载源 [${i + 1}/${candidateUrls.length}] (${task.resource_id}): ${currentUrl}`
        )
        try {
          const attempt = await this.downloadService.downloadWithVerification({
            taskId: `${moduleId}:${task.resource_id}`,
            url: currentUrl,
            destPath: archivePath,
            expectedBytes: task.expected_bytes,
            expectedSha256: task.expected_sha256,
            etag: task.etag ?? undefined,
            transport: this.transport,
            onProgress: prog => {
              const total = prog.totalBytes || task.expected_bytes || 1
              const pct = Math.min(92, Math.round((prog.receivedBytes / total) * 92))
              dao.resources.updateProgressSync(task.resource_id, prog.receivedBytes, 'downloading')
              this.liveProgress.set(moduleId, {
                percentage: pct,
                speed_bytes_per_sec: prog.speed,
                is_resumed: hadPartBefore
              })
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

    // 4. 若为 .zip 或 .ffp 归档，调用 safeExtractZip（带意图日志与 renameWithRetry）
    const lowerAsset = task.asset_name.toLowerCase()
    const intentsDir = path.join(this.getBaseDir(), '.intents')
    const sharedSubDir = resolveSharedSubDir(task.resource_id)
    try {
      // 物化写入前先使目标目录既有 .ready* 标记失效，严防 TOCTOU 读取半成品
      await invalidateReadyMarkers(targetAbsDir)

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
        await safeExtractZip(archivePath, targetAbsDir, intentsDir)
        // 解压成功后清理归档包临时文件
        if (fs.existsSync(archivePath)) {
          try {
            fs.unlinkSync(archivePath)
          } catch {
            // ignore
          }
        }
      } else {
        // 非压缩包单文件资源：直接移入目标目录 (使用 renameWithRetry 防止杀软冲突)
        if (!fs.existsSync(targetAbsDir)) {
          fs.mkdirSync(targetAbsDir, { recursive: true })
        }
        const destFile = path.join(targetAbsDir, task.asset_name)
        if (fs.existsSync(destFile)) {
          fs.unlinkSync(destFile)
        }
        await renameWithRetry(archivePath, destFile)
      }

      // 解压或单文件物化成功后，统一计算确定性 SHA-256 摘要并原子写入标准 .ready.json
      await writeReadyMarker(targetAbsDir, {
        resourceId: task.resource_id,
        sharedSubDir
      })
      this.repairPendingResources.delete(task.resource_id)
      this.fastReadySnapshot.set(task.resource_id, {
        resourceId: task.resource_id,
        sharedSubDir,
        physicalDir: targetAbsDir,
        status: 'ready_fast',
        validationLevel: 'full',
        checkedAt: Date.now()
      })
    } catch (extractErr: any) {
      const errMsg = extractErr?.message || String(extractErr)
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
    dao.resources.updateProgressSync(task.resource_id, result.finalBytes, 'completed')
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
  private async stopOmniProcessForUninstall(): Promise<boolean> {
    try {
      const { omniService } = await import('./omni-service')
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
  private async assertModuleResourcesReadyForActivation(
    moduleId: string,
    record: BuiltinModuleRecord
  ): Promise<void> {
    const dao = this.getDao()
    const boundResources = dao.resources.findResourcesByModuleSync(moduleId)
    const specs = this.resolveModuleResourceSpecs(record)
    if (boundResources.length === 0 && specs.length === 0) {
      return
    }

    const pluginsRootDir = this.getPluginsRootDir()
    const coreReadyForClassic =
      moduleId === 'engine_classic_light' && this.isClassicEngineCoreReady(boundResources)

    for (const res of boundResources) {
      if (this.repairPendingResources.has(res.resource_id)) {
        throw new Error(`模块资源处于待修复状态，禁止激活: ${moduleId}/${res.resource_id}`)
      }
      if (res.download_state !== 'completed') {
        if (
          moduleId === 'engine_classic_light' &&
          res.resource_id === 'mobile-clip' &&
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
        this.fastReadySnapshot.set(res.resource_id, {
          resourceId: res.resource_id,
          sharedSubDir,
          physicalDir: targetDir,
          status: 'legacy_heal',
          validationLevel: 'legacy',
          checkedAt: Date.now()
        })
        this.scheduleBackgroundFullVerification([res.resource_id], 50)
      } else {
        this.fastReadySnapshot.set(res.resource_id, {
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
  private findReadyBackupModulesSync(record: BuiltinModuleRecord): BuiltinModuleRecord[] {
    const dao = this.getDao()
    const slot = record.capability_slot
    if (!slot) return []

    const siblings = dao.modules
      .listAllSync({ includeDraft: true })
      .filter(m => m.capability_slot === slot && m.id !== record.id)

    return siblings.filter(candidate => {
      // 仅处于已安装就绪态或已激活态才具接替资格；crashed 置错或未安装/下载中严禁接替
      if (
        candidate.install_state !== 'installed_inactive' &&
        candidate.install_state !== 'active'
      ) {
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
      const holds = this.processManager ? this.processManager.getHoldReasons(candidate.id) : []
      if (holds.length > 0) {
        return false
      }
      const resList = dao.resources.findResourcesByModuleSync(candidate.id)
      for (const res of resList) {
        if (res.download_state !== 'completed') {
          return false
        }
        const snap = this.fastReadySnapshot.get(res.resource_id)
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
  async uninstallModule(moduleId: string): Promise<BuiltinModuleView> {
    this.assertWriteGateAllowed()
    this.ensureDefaultSeeds()

    return await this.topologyCoordinator.execute(async () => {
      const db = this.getDb()
      const dao = this.getDao()
      const record = dao.modules.findByIdSync(moduleId)
      if (!record) {
        throw new Error(`未找到模块定义: ${moduleId}`)
      }

      // 核心底座物理防空拦截：必选槽位必须先检验是否存在健康就绪备选（Ready Backup）
      let backupToActivate: BuiltinModuleRecord | null = null
      if (record.slot_policy === 'exclusive_required') {
        const readyBackups = this.findReadyBackupModulesSync(record)
        if (readyBackups.length === 0) {
          logger.warn(
            LogCategory.SYSTEM,
            `[ModularResource] 拒绝卸载唯一或无健康就绪备选的必选底座: ${moduleId}`
          )
          throw new Error('CANNOT_UNINSTALL_LAST_REQUIRED_SLOT')
        }
        const hasOtherActive = readyBackups.some(b => b.install_state === 'active')
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
      this.liveProgress.delete(moduleId)

      // 阶段二：停机释放 Windows mmap 文件句柄后再物理清理
      if (wasActive || this.processManager.isRunning(moduleId)) {
        await this.processManager.stopProcess(moduleId)
      }
      let omniStopped = false
      if (resourcesToDelete.length > 0 && record.backend_type !== 'utility_process') {
        omniStopped = await this.stopOmniProcessForUninstall()
      }

      for (const res of resourcesToDelete) {
        this.fastReadySnapshot.delete(res.resource_id)
        let targetAbsDir: string
        try {
          targetAbsDir = this.resolvePhysicalPath(res.target_local_path)
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
          const deleted = await this.tombstoneGC.safeDeleteWithTombstone(targetAbsDir, {
            slot: record.capability_slot ?? undefined,
            deleteDirectoryFn: this.deleteDirectoryFn
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
        const failoverRes = await this.processManager
          .requestActivate(backupToActivate.id, 'slot_release')
          .catch(err => ({ success: false, error: err?.message || String(err) }))
        if (!failoverRes.success) {
          logger.error(
            LogCategory.SYSTEM,
            `[ModularResource] 接替底座 ${backupToActivate.id} 拉起失败: ${failoverRes.error ?? 'unknown'}`
          )
        }
        await this.notifyRuntimePluginTopologyChanged({
          moduleId: backupToActivate.id,
          reason: 'module_uninstall_failover',
          restartPolicy: 'ensure-running'
        }).catch(err => {
          logger.warn(LogCategory.SYSTEM, '[ModularResource] 卸载接替后刷新拓扑告警:', err)
        })
        if (backupToActivate.capability_slot === 'base_embedding') {
          await this.syncEmbeddingProfileToConfig()
        }
      } else if (wasActive || omniStopped) {
        await this.notifyRuntimePluginTopologyChanged({
          moduleId,
          reason: 'module_uninstall',
          restartPolicy: omniStopped ? 'ensure-running' : 'restart'
        }).catch(err => {
          logger.warn(LogCategory.SYSTEM, '[ModularResource] 卸载后刷新拓扑告警:', err)
        })
      }

      return this.buildModuleView(dao.modules.findByIdSync(moduleId)!)
    })
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
    const dao = this.getDao()

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
      await this.assertModuleResourcesReadyForActivation(moduleId, existing)

      const prevActive = isExclusive ? dao.modules.findActiveBySlotSync(slot) : null
      const prevServingEpoch = slot === 'base_embedding' ? dao.epochs.findServingEpochSync() : null
      let createdOrFlippedEpochNum: number | null = null

      if (isExclusive && prevActive && prevActive.id !== moduleId) {
        dao.modules.updateInstallStateSync(prevActive.id, 'installed_inactive')
        await this.processManager.stopProcess(prevActive.id)
      }

      const restorePrevActiveRuntime = async (prevId: string, stage: string): Promise<void> => {
        dao.modules.activateExclusiveModuleSync(prevId)
        const rbRes = await this.processManager
          .requestActivate(prevId, 'rollback')
          .catch(rbErr => ({ success: false, error: rbErr?.message || String(rbErr) }))
        if (!rbRes.success) {
          logger.error(
            LogCategory.SYSTEM,
            `[ModularResource] ${stage}回滚重启前任模块 ${prevId} 失败: ${rbRes.error ?? 'unknown'}`
          )
        }
        await this.notifyRuntimePluginTopologyChanged({
          moduleId: prevId,
          reason: 'module_state_rollback',
          restartPolicy: 'ensure-running'
        }).catch(rbErr => {
          logger.warn(LogCategory.SYSTEM, `[ModularResource] ${stage}回滚恢复拓扑告警:`, rbErr)
        })
      }

      const actRes = await this.processManager.requestActivate(moduleId, 'user_toggle')
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
        await this.notifyRuntimePluginTopologyChanged({
          moduleId,
          reason: 'module_state',
          restartPolicy: 'ensure-running'
        })
        if (slot === 'base_embedding') {
          await this.syncEmbeddingProfileToConfig()
        }
      } catch (activateErr: any) {
        const errMsg = activateErr?.message || String(activateErr)
        logger.error(
          LogCategory.SYSTEM,
          `[ModularResource] 模块 ${moduleId} 运行时加载或冒烟失败，执行严格回滚:`,
          activateErr
        )
        // 先停掉已激活的新进程，再释放 DB 状态防 ux_exclusive_active_slot 冲突与进程状态分裂
        await this.processManager.stopProcess(moduleId).catch(stopErr => {
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
          await this.syncEmbeddingProfileToConfig()
        }
        throw activateErr
      }
    } else if (patch.active === false) {
      // 核心不变量：必选槽防空保护 (TC-10)
      if (existing.slot_policy === 'exclusive_required') {
        throw new Error('CANNOT_DEACTIVATE_REQUIRED_SLOT (SLOT_REQUIRED_EMPTY)')
      }

      dao.modules.deactivateModuleSync(moduleId)
      await this.processManager.stopProcess(moduleId)
      await this.notifyRuntimePluginTopologyChanged({
        moduleId,
        reason: 'module_deactivate',
        restartPolicy: 'restart'
      }).catch(err => {
        logger.warn(LogCategory.SYSTEM, '[ModularResource] 停用模块刷新拓扑告警:', err)
      })
    }

    return this.buildModuleView(dao.modules.findByIdSync(moduleId)!)
  }

  /**
   * 激活指定模块（针对排他槽位自动停用同槽位其他模块）
   */
  async activateModule(moduleId: string): Promise<BuiltinModuleView> {
    return this.updateModuleState(moduleId, { active: true })
  }

  /**
   * 停用指定模块（若处于 exclusive_required 且激活状态则拒绝并抛出 SLOT_REQUIRED_EMPTY）
   */
  async deactivateModule(moduleId: string): Promise<BuiltinModuleView> {
    return this.updateModuleState(moduleId, { active: false })
  }

  /**
   * 按能力槽位查询当前激活的模块（若无激活返回 null）
   */
  getActiveModuleBySlot(slot: PluginCapabilitySlot): BuiltinModuleView | null {
    this.ensureDefaultSeeds()
    const dao = this.getDao()
    const row = dao.modules.findActiveBySlotSync(slot)
    if (!row) return null
    return this.buildModuleView(row)
  }

  getModule(moduleId: string): BuiltinModuleView | null {
    this.ensureDefaultSeeds()
    const dao = this.getDao()
    const row = dao.modules.findByIdSync(moduleId)
    if (!row) return null
    return this.buildModuleView(row)
  }

  getPendingTombstones(): PendingDeletionItem[] {
    return this.tombstoneGC.getPendingDeletions()
  }

  hasPendingTombstones(): boolean {
    return this.tombstoneGC.hasPendingDeletions()
  }

  requestRestart(): void {
    this.tombstoneGC.requestAppRestart()
  }

  async exportOfflinePackage(
    moduleId: string,
    targetFilePath: string,
    options?: { signerPrivateKey?: string }
  ): Promise<string> {
    return this.offlinePackageService.exportOfflinePackage(moduleId, targetFilePath, options)
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
    this.ensureDefaultSeeds()
    const db = this.getDb()
    const dao = this.getDao()
    const pluginsRootDir = this.getPluginsRootDir()

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
          if (bound.length === 0 || bound.some(r => r.download_state !== 'completed')) {
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
            logger.info(
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
                target_local_path: this.resolvePhysicalPath(res.target_local_path),
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

  /**
   * 同步活跃底座画像状态到 ConfigOrchestrator（保证 base_embedding 与 AI_EMBEDDING_PROFILE / EMBEDDING_MRL_DIMENSION 唯一事实源全域统一）
   */
  public async syncEmbeddingProfileToConfig(): Promise<void> {
    try {
      const activeBase = this.getActiveModuleBySlot('base_embedding')
      if (!activeBase) return

      let configOrch = this.injectedConfigOrchestrator
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
        logger.info(
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

  async importOfflinePackage(
    archivePath: string,
    options?: { rootPublicKey?: string; preferredEngineId?: string }
  ): Promise<BuiltinModuleView> {
    this.ensureDefaultSeeds()
    return this.offlinePackageService.importOfflinePackage(archivePath, options)
  }
}

export const modularResourceService = ModularResourceService.getInstance()
