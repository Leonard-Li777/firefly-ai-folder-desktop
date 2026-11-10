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
import { app as electronApp } from 'electron'
import type { Database } from 'better-sqlite3'
import { logger, LogCategory } from '@firefly/shared'
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

export type { VerifiedDownloadResult }

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
    onProgress?: (event: ModuleDownloadProgressEvent) => void
  ): Promise<BuiltinModuleView>

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

  /** 导入离线插件包 (.ffp / .zip) */
  importOfflinePackage(
    archivePath: string,
    options?: { rootPublicKey?: string }
  ): Promise<BuiltinModuleView>
}

/**
 * 本地离线内置插件目录种子 (IN-04 纯离线兜底 SSOT)
 */
export const DEFAULT_CATALOG_SEEDS: CatalogModuleEntry[] = [
  // 1. 检索式引擎：经典轻量极速档 (二选一必选)
  {
    id: 'engine_classic_light',
    name: '经典轻量检索式引擎 (Classic Light)',
    description:
      '【通过意思找文件与图片】根据你描述的大致意思快速搜索照片和文档。占用极少内存，即使老电脑和低配轻薄本也能流畅运行。',
    icon: 'Feather',
    kind: 'builtin-module',
    version: '1.0.0',
    catalog_version: 1,
    category: 'ai-engine',
    capability_slot: 'base_embedding',
    slot_policy: 'exclusive_required',
    backend_type: 'omni_onnx',
    author_code: 'official',
    total_bytes: 319195255, // 106,269,288 (bekko) + 212,925,967 (chinese-clip) = 304.4 MiB
    install_state: 'not_installed',
    contributes: {
      settings: {
        scope: 'workspace',
        tabTitle: '检索式引擎',
        componentId: 'basic_ai_engine',
        priority: 10
      }
    },
    resources: [
      {
        resource_id: 'bekko-a8m',
        asset_name: 'bekko-a8m-1.0.0.zip',
        target_local_path: 'modules/_shared/bekko-a8m',
        active_source_key: 'auto',
        active_url:
          'https://github.com/Leonard-Li777/firefly-resources/releases/download/resources/bekko-a8m-1.0.0.zip',
        expected_bytes: 106269288,
        expected_sha256: '315c4cba94333207522ae6e12c5de234199d1c4fc11740b05ac32aebd3e82d13'
      },
      {
        resource_id: 'chinese-clip',
        asset_name: 'chinese-clip-int8-v3.zip',
        target_local_path: 'modules/_shared/chinese-clip',
        active_source_key: 'auto',
        active_url:
          'https://github.com/Leonard-Li777/firefly-resources/releases/download/resources/chinese-clip-int8-v3.zip',
        expected_bytes: 212925967,
        expected_sha256: '67a5e4a0d0985085a3ad9e153efa5d4817af3851b6c4c7c8933b5c0a83ca3093'
      }
    ]
  },
  // 2. 检索式引擎：统一全模态档 (二选一必选)
  {
    id: 'engine_gemma_unified',
    name: '统一全模态检索式引擎 (Gemma Unified)',
    description:
      '【更聪明的全能搜索大脑】对复杂句子和图片的理解更深入精准，找东西更懂你的心思。推荐 8GB 或以上内存电脑使用。',
    icon: 'Layers',
    kind: 'builtin-module',
    version: '1.0.0',
    catalog_version: 1,
    category: 'ai-engine',
    capability_slot: 'base_embedding',
    slot_policy: 'exclusive_required',
    backend_type: 'omni_onnx',
    author_code: 'official',
    total_bytes: 254003864, // 242.2 MiB
    install_state: 'not_installed',
    contributes: {
      settings: {
        scope: 'workspace',
        tabTitle: '检索式引擎',
        componentId: 'basic_ai_engine',
        priority: 10
      }
    },
    resources: [
      {
        resource_id: 'embeddinggemma-2-onnx',
        asset_name: 'embeddinggemma-2-onnx-1.0.0.zip',
        target_local_path: 'modules/_shared/embeddinggemma-2-onnx',
        active_source_key: 'auto',
        active_url:
          'https://github.com/Leonard-Li777/firefly-resources/releases/download/resources/embeddinggemma-2-onnx-1.0.0.zip',
        expected_bytes: 254003864,
        expected_sha256: 'f2cfc8643f708702c3abeeb5130df42becb909793d5ade429531daf810314f26'
      }
    ]
  },
  // 3. 生成式引擎：轻量 CPU 引擎 (Pocket CPU)
  {
    id: 'pocket-cpu-int8-onnx',
    name: '轻量CPU生成式引擎 (Pocket CPU)',
    description:
      '【办公轻薄本标配】内存仅占约400MB，0门槛秒级响应，完全离线私密。支持智能文件名深度润色、描述提取与内容深度解析。',
    icon: 'Cpu',
    kind: 'builtin-module',
    version: '1.0.0',
    catalog_version: 1,
    category: 'ai-engine',
    capability_slot: 'ai_engine_cpu',
    slot_policy: 'exclusive_optional',
    backend_type: 'omni_onnx',
    author_code: 'official',
    total_bytes: 380633088, // 363 MiB
    install_state: 'not_installed',
    contributes: {
      settings: {
        scope: 'global',
        tabTitle: '生成式引擎',
        componentId: 'ai_engine_config',
        priority: 15
      }
    },
    resources: [
      {
        resource_id: 'pocket-cpu-int8-onnx',
        asset_name: 'pocket-cpu-int8-onnx-1.0.0.zip',
        target_local_path: 'models/pocket-cpu',
        active_source_key: 'auto',
        active_url:
          'https://github.com/Leonard-Li777/firefly-resources/releases/download/resources/pocket-cpu-int8-onnx-1.0.0.zip',
        expected_bytes: 380633088,
        expected_sha256: '9a9b7367c3ca16bc2605bb1dca2e927cb7801a610f443b8782a69ce45f78c85c'
      }
    ]
  },
  // 4. 感知分析模型：敏感内容与 NSFW 分级识别
  {
    id: 'perception_nsfw',
    name: '敏感内容与 NSFW 分级识别',
    description:
      '【私密与敏感图片标记】自动识别不适合在公开场合打开的图片并加上标记，防止投屏查看时尴尬。所有电脑均可极速运行。',
    icon: 'ShieldAlert',
    kind: 'builtin-module',
    version: '1.0.0',
    catalog_version: 1,
    category: 'perception',
    capability_slot: 'perception_nsfw',
    slot_policy: 'exclusive_optional',
    backend_type: 'omni_onnx',
    author_code: 'official',
    total_bytes: 21966375, // 20.9 MiB
    install_state: 'not_installed',
    contributes: {
      settings: {
        scope: 'workspace',
        tabTitle: '文件内容萃取',
        componentId: 'content_extraction',
        priority: 20
      }
    },
    resources: [
      {
        resource_id: 'nsfw-l3',
        asset_name: 'nsfw-l3-1.0.0.zip',
        target_local_path: 'modules/_shared/nsfw-l3',
        active_source_key: 'auto',
        active_url:
          'https://github.com/Leonard-Li777/firefly-resources/releases/download/resources/nsfw-l3-1.0.0.zip',
        expected_bytes: 21966375,
        expected_sha256: '84383b64d723d31ec3ab940522f866ff1979a24454269cd6336ee2fc98ff2ddf'
      }
    ]
  },
  // 4. 语音识别与字幕提取 ASR (SenseVoice, 纯模型，转码复用系统内置 FFmpeg)
  {
    id: 'asr_sensevoice_onnx',
    name: '语音识别与字幕提取 ASR (SenseVoice)',
    description:
      '【录音与视频自动转文字】听懂视频和录音里的说话内容并提取字幕，可以直接搜索“某句话是谁说的”。较耗算力，推荐 16GB 内存或有显卡。',
    icon: 'Mic',
    kind: 'builtin-module',
    version: '1.0.0',
    catalog_version: 1,
    category: 'perception',
    capability_slot: 'voice_asr',
    slot_policy: 'exclusive_optional',
    backend_type: 'omni_onnx',
    author_code: 'official',
    total_bytes: 168587158, // 8,282,676 (sherpa) + 160,304,482 (sensevoice) = 160.8 MiB
    install_state: 'not_installed',
    contributes: {
      settings: {
        scope: 'workspace',
        tabTitle: '文件内容萃取',
        componentId: 'content_extraction',
        priority: 25
      }
    },
    resources: [
      {
        resource_id: 'sherpa-onnx-runtime',
        asset_name: 'sherpa-onnx-runtime-1.13.8-win32-x64.zip',
        target_local_path: 'modules/_shared/sherpa-onnx-runtime',
        active_source_key: 'auto',
        active_url:
          'https://github.com/Leonard-Li777/firefly-resources/releases/download/resources/sherpa-onnx-runtime-1.13.8-win32-x64.zip',
        expected_bytes: 8282676,
        expected_sha256: '3cb751f7e27d9c0768687487335d67bee3dd9694b6825e50ee439ade7cb6bd04'
      },
      {
        resource_id: 'sensevoice-onnx',
        asset_name: 'sensevoice-onnx-int8.zip',
        target_local_path: 'modules/_shared/sensevoice-onnx',
        active_source_key: 'auto',
        active_url:
          'https://github.com/Leonard-Li777/firefly-resources/releases/download/resources/sensevoice-onnx-int8.zip',
        expected_bytes: 160304482,
        expected_sha256: 'a5cd6e2836c3916e18efb2ee81bd6fd536c92bf957fd29a524b8a7e82c6cdceb'
      }
    ]
  },
  // 5. 离线语音合成 TTS (Moss-TTS)
  {
    id: 'tts_moss_onnx',
    name: '离线语音合成 TTS (Moss-TTS)',
    description:
      '【真人般自然朗读文章】把文档和文章读给你听，支持戴耳机离线听书看材料，完全不消耗网络。普通电脑即可流畅发音。',
    icon: 'Volume2',
    kind: 'builtin-module',
    version: '1.0.0',
    catalog_version: 1,
    category: 'media',
    capability_slot: 'voice_tts',
    slot_policy: 'exclusive_optional',
    backend_type: 'omni_onnx',
    author_code: 'official',
    total_bytes: 249105462, // 8,282,676 (sherpa) + 240,822,786 (moss-tts) = 237.6 MiB
    install_state: 'not_installed',
    contributes: {
      settings: {
        scope: 'global',
        tabTitle: '语音合成 (TTS)',
        componentId: 'tts',
        priority: 30
      }
    },
    resources: [
      {
        resource_id: 'sherpa-onnx-runtime',
        asset_name: 'sherpa-onnx-runtime-1.13.8-win32-x64.zip',
        target_local_path: 'modules/_shared/sherpa-onnx-runtime',
        active_source_key: 'auto',
        active_url:
          'https://github.com/Leonard-Li777/firefly-resources/releases/download/resources/sherpa-onnx-runtime-1.13.8-win32-x64.zip',
        expected_bytes: 8282676,
        expected_sha256: '3cb751f7e27d9c0768687487335d67bee3dd9694b6825e50ee439ade7cb6bd04'
      },
      {
        resource_id: 'moss-tts',
        asset_name: 'moss-tts-1.0.0.zip',
        target_local_path: 'modules/_shared/moss-tts',
        active_source_key: 'auto',
        active_url:
          'https://github.com/Leonard-Li777/firefly-resources/releases/download/resources/moss-tts-1.0.0.zip',
        expected_bytes: 240822786,
        expected_sha256: '4374fe73fd27e9544674037890e773826727b959c6a63313989d787a263b7069'
      }
    ]
  },
  {
    id: 'diffusion_studio',
    name: '本地生图 Studio',
    description: '基于本地硬件加速的图像生成、超分辨率画面修复与视觉扩展',
    icon: 'Sparkles',
    kind: 'builtin-module',
    version: '0.1.0',
    catalog_version: 1,
    category: 'ai-engine',
    capability_slot: 'advanced_ai_engine',
    slot_policy: 'exclusive_optional',
    backend_type: 'ai_engine',
    author_code: 'official',
    author_name: null,
    availability: 'coming_soon',
    firecore_cost: 0,
    total_bytes: 3824100000,
    install_state: 'not_installed'
  },
  {
    id: 'archive_vfs_parser',
    name: '压缩包透视与深度解析器',
    description: '可以透视压缩包中的内容，并生成标签和描述等',
    icon: 'Archive',
    kind: 'builtin-module',
    version: '1.0.0',
    catalog_version: 1,
    category: 'vfs-archive',
    capability_slot: 'parser',
    slot_policy: 'multi_active',
    backend_type: 'utility_process',
    author_code: 'official',
    author_name: null,
    availability: 'coming_soon',
    delist_reason: null,
    firecore_cost: 0,
    total_bytes: 0,
    install_state: 'not_installed'
  }
]

export interface ModularResourceServiceOptions {
  db?: Database
  baseDir?: string
  presetDir?: string
  downloadService?: FileDownloadService
  transport?: IDownloadTransport
  deleteDirectoryFn?: (dirPath: string) => Promise<boolean>
  tombstoneGC?: TombstoneGCService
  offlinePackageService?: OfflinePackageService
  processManager?: PluginProcessManager
}

export class ModularResourceService implements IModularResourceService {
  private static instance: ModularResourceService | null = null

  public readonly processManager: PluginProcessManager
  private customDb: Database | null = null
  private customBaseDir: string | null = null
  private customPresetDir: string | null = null
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

  constructor(options?: ModularResourceServiceOptions) {
    this.customDb = options?.db ?? null
    this.customBaseDir = options?.baseDir ?? null
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
    this.processManager =
      options?.processManager ??
      new PluginProcessManager({
        getDao: () => this.getDao()
      })

    // ISS-15: 应用启动后延迟 15 秒后台扫描清理超过 7 天的 .trash-* 与未完成孤儿断点
    setTimeout(() => {
      try {
        const base = this.getBaseDir()
        cleanOldTrashAndOrphanParts(base).catch(() => {})
      } catch {}
    }, 15000)
  }

  static getInstance(): ModularResourceService {
    if (!ModularResourceService.instance) {
      ModularResourceService.instance = new ModularResourceService()
    }
    return ModularResourceService.instance
  }

  public getDb(): Database {
    if (this.customDb) return this.customDb
    const { databaseService } = require('../database/database-service')
    if (!databaseService?.db) {
      throw new Error('ModularResourceService: 数据库尚未初始化')
    }
    return databaseService.db
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
   * 将相对路径解析为基于 baseDir 的绝对物理路径
   */
  public resolvePhysicalPath(targetLocalPath: string): string {
    if (path.isAbsolute(targetLocalPath)) {
      return targetLocalPath
    }
    return path.join(this.getBaseDir(), targetLocalPath)
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
  private loadBomFilesForResource(
    resourceId: string
  ): Array<{ name: string; size: number; sha256: string }> {
    if (this.resourceBomOverrides.has(resourceId)) {
      return this.resourceBomOverrides.get(resourceId)!
    }

    const candidateBomPaths = [
      path.join(process.cwd(), 'apps/desktop/build/extraResources/configs/resources.bom.json'),
      path.join(this.getBaseDir(), 'configs', 'resources.bom.json')
    ]
    try {
      if (typeof electronApp !== 'undefined' && electronApp.isPackaged) {
        candidateBomPaths.unshift(path.join(process.resourcesPath, 'configs', 'resources.bom.json'))
      }
    } catch {}

    for (const bomPath of candidateBomPaths) {
      if (fs.existsSync(bomPath)) {
        try {
          const content = JSON.parse(fs.readFileSync(bomPath, 'utf-8'))
          const res = content.resources?.[resourceId]
          if (res?.files && Array.isArray(res.files)) {
            return res.files
          }
        } catch {}
      }
    }

    return []
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

    const expectedSha256 = spec.expected_sha256
    const sha8 = expectedSha256.slice(0, 8)
    const readyMarkerPath = path.join(targetAbsDir, `.ready-${sha8}.json`)

    // 1. 快路径：检查 .ready 标记是否存在且内容有效
    if (fs.existsSync(readyMarkerPath)) {
      try {
        const marker = JSON.parse(fs.readFileSync(readyMarkerPath, 'utf-8'))
        if (
          marker.version === 1 &&
          marker.archiveSha256?.toLowerCase() === expectedSha256.toLowerCase() &&
          Array.isArray(marker.coreFiles) &&
          marker.coreFiles.length > 0
        ) {
          let fastOk = true
          for (const core of marker.coreFiles) {
            const p = path.join(targetAbsDir, core.name)
            if (!fs.existsSync(p)) {
              fastOk = false
              break
            }
            const st = fs.statSync(p)
            if (st.size !== core.size) {
              fastOk = false
              break
            }
            if (core.mtimeMs && Math.abs(st.mtimeMs - core.mtimeMs) > 2000) {
              // 容差 2s (FAT/跨平台)
              fastOk = false
              break
            }
          }
          if (fastOk) {
            return 'fast_hit'
          }
        }
      } catch {
        // marker 损坏，回退慢路径
      }
    }

    // 2. 慢路径：逐文件流式计算真实 SHA-256
    const expectedFiles = this.loadBomFilesForResource(spec.resource_id)
    if (expectedFiles.length > 0) {
      let allFilesOk = true
      const verifiedList: Array<{ name: string; size: number; mtimeMs: number; sha256: string }> =
        []

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
        verifiedList.push({
          name: ef.name,
          size: st.size,
          mtimeMs: st.mtimeMs,
          sha256: verifyRes.actualSha256
        })
      }

      if (allFilesOk) {
        // 原子补写 .ready 标记自愈
        try {
          const markerContent = {
            version: 1,
            assetId: spec.resource_id,
            archiveSha256: expectedSha256,
            bomSha256: 'bom_verified',
            createdAt: new Date().toISOString(),
            coreFiles: verifiedList
          }
          const tmpReady = `${readyMarkerPath}.tmp-${Date.now()}`
          fs.writeFileSync(tmpReady, JSON.stringify(markerContent, null, 2), 'utf-8')
          fs.renameSync(tmpReady, readyMarkerPath)
        } catch {}
        return 'slow_healed'
      } else {
        // 发现文件损坏或缺失，执行隔离
        await this.isolateCorruptDirectory(targetAbsDir)
        return 'corrupted'
      }
    } else {
      // 无 BOM 清单的通用/测试资源：若已有 completed 记录且目录非空，补写轻量 .ready 标记放行
      const task = this.getDao().resources.findByIdSync(spec.resource_id)
      if (
        task?.download_state === 'completed' &&
        (!task.expected_sha256 ||
          !task.actual_sha256 ||
          task.actual_sha256.toLowerCase() === task.expected_sha256.toLowerCase())
      ) {
        try {
          const files = fs
            .readdirSync(targetAbsDir)
            .filter(f => !f.startsWith('.'))
            .map(f => {
              const p = path.join(targetAbsDir, f)
              const st = fs.statSync(p)
              return { name: f, size: st.size, mtimeMs: st.mtimeMs, sha256: '' }
            })
          fs.writeFileSync(
            readyMarkerPath,
            JSON.stringify(
              {
                version: 1,
                assetId: spec.resource_id,
                archiveSha256: expectedSha256,
                bomSha256: 'task_completed_fallback',
                createdAt: new Date().toISOString(),
                coreFiles: files
              },
              null,
              2
            ),
            'utf-8'
          )
        } catch {}
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
   * L2 物理探活：探测本地预置包并验证
   */
  private async checkL2LocalPresetPreflight(
    spec: CatalogResourceSpec,
    targetAbsDir: string
  ): Promise<boolean> {
    const candidateDirs = [
      path.join(process.cwd(), 'apps/desktop/build/presetResources'),
      path.join(process.cwd(), 'apps/desktop/build/extraResources/models'),
      path.join(this.getBaseDir(), 'presetResources')
    ]
    if (this.customPresetDir) {
      candidateDirs.unshift(this.customPresetDir)
    }
    try {
      if (typeof electronApp !== 'undefined' && electronApp.isPackaged) {
        candidateDirs.unshift(path.join(process.resourcesPath, 'presetResources'))
        candidateDirs.unshift(path.join(process.resourcesPath, 'models'))
      }
    } catch {}

    for (const pDir of candidateDirs) {
      const zipPath = path.join(pDir, spec.asset_name)
      if (!fs.existsSync(zipPath)) continue

      const cacheKey = `${zipPath}:${spec.expected_sha256}`
      if (this.corruptedPresetCache.has(cacheKey)) {
        continue
      }

      try {
        const verify = await streamVerifySha256(zipPath, spec.expected_sha256)
        if (verify.valid) {
          logger.info(
            LogCategory.SYSTEM,
            `[ModularResource] L2 预置包探活命中: ${zipPath}，直接本地解压`
          )
          const intentsDir = path.join(this.getBaseDir(), '.intents')
          await safeExtractZip(zipPath, targetAbsDir, intentsDir)

          // 写入 .ready 标记
          const sha8 = spec.expected_sha256.slice(0, 8)
          const readyMarkerPath = path.join(targetAbsDir, `.ready-${sha8}.json`)
          try {
            const files = fs
              .readdirSync(targetAbsDir)
              .filter(f => !f.startsWith('.'))
              .map(f => {
                const fp = path.join(targetAbsDir, f)
                const st = fs.statSync(fp)
                return { name: f, size: st.size, mtimeMs: st.mtimeMs, sha256: '' }
              })
            fs.writeFileSync(
              readyMarkerPath,
              JSON.stringify(
                {
                  version: 1,
                  assetId: spec.resource_id,
                  archiveSha256: spec.expected_sha256,
                  bomSha256: 'preset_verified',
                  createdAt: new Date().toISOString(),
                  coreFiles: files
                },
                null,
                2
              ),
              'utf-8'
            )
          } catch {}

          return true
        } else {
          // 仅记录内存缓存，严禁向只读目录调用 unlinkSync
          this.corruptedPresetCache.set(cacheKey, true)
        }
      } catch (err) {
        this.corruptedPresetCache.set(cacheKey, true)
      }
    }

    return false
  }

  /**
   * 确保默认种子已注入数据库
   */
  public ensureDefaultSeeds(): void {
    if (this.seeded) return
    try {
      const dao = this.getDao()
      const existing = dao.modules.listAllSync()
      if (existing.length === 0) {
        this.syncCatalogSync(DEFAULT_CATALOG_SEEDS)
      }
      this.seeded = true
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[ModularResource] 初始化内置目录种子失败:', err)
    }
  }

  /**
   * 启动期自愈与孤儿清理：
   * 1. 扫描清理遗留的 .tmp-* 与 .deleting_* / .deleting-* 孤儿目录；
   * 2. 清理此前被标记为 pending_delete 且已无模块引用的资源目录与记录；
   * 3. 对账 builtin_modules 与 resource_downloads：若标记为已安装/已完成但磁盘目录缺失，自动回退状态。
   */
  async reconcileOnStartup(): Promise<{
    cleanedTombstones: number
    resetModules: string[]
    resetDownloads: string[]
  }> {
    const baseDir = this.getBaseDir()
    const sharedDir = path.join(baseDir, 'modules', '_shared')
    const modulesDir = path.join(baseDir, 'modules')

    let cleanedTombstones = 0
    cleanedTombstones += await cleanOrphanTombstones(baseDir)
    cleanedTombstones += await cleanOrphanTombstones(modulesDir)
    cleanedTombstones += await cleanOrphanTombstones(sharedDir)
    cleanedTombstones += await this.tombstoneGC.reconcileOnStartup([baseDir, modulesDir, sharedDir])

    // B4: 扫描并自愈由于杀软占用或断电未完成的目录切换意图日志
    const intentsDir = path.join(baseDir, '.intents')
    await reconcileDirSwitchIntents(intentsDir)

    const dao = this.getDao()
    const resetDownloads: string[] = []
    const resetModules: string[] = []

    // 1. 对账物理资源记录
    const allResources = dao.resources.listAllSync()
    for (const res of allResources) {
      const targetAbsPath = this.resolvePhysicalPath(res.target_local_path)

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
        // 逆向自愈收录 (AC-3)：若未标记 completed 但物理目标目录完整存在且非空，自动逆向收录为 completed
        if (fs.existsSync(targetAbsPath)) {
          try {
            const files = fs.readdirSync(targetAbsPath)
            if (files.length > 0) {
              dao.resources.markVerifiedSync(
                res.resource_id,
                true,
                res.expected_sha256 || undefined
              )
              cleanedTombstones++
            }
          } catch {}
        }
      }
    }

    // 2. 对账模块状态
    const allModules = dao.modules.listAllSync()
    for (const mod of allModules) {
      if (
        mod.install_state === 'active' ||
        mod.install_state === 'installed_inactive' ||
        mod.install_state === 'downloading'
      ) {
        const boundResources = dao.resources.findResourcesByModuleSync(mod.id)
        let missingPhysical = false

        if (mod.install_path) {
          const modAbsPath = this.resolvePhysicalPath(mod.install_path)
          if (!fs.existsSync(modAbsPath)) {
            missingPhysical = true
          }
        }

        if (boundResources.length > 0) {
          for (const res of boundResources) {
            const resAbsPath = this.resolvePhysicalPath(res.target_local_path)
            if (res.download_state !== 'completed' || !fs.existsSync(resAbsPath)) {
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
        }
      }
    }

    return {
      cleanedTombstones,
      resetModules,
      resetDownloads
    }
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

    const name = meta.name || seed?.name || record.id
    const description = meta.description || seed?.description || ''
    const icon = meta.icon || seed?.icon

    const live = this.liveProgress.get(record.id)
    let downloadProgress = live
    if (!downloadProgress && record.install_state === 'downloading' && resources.length > 0) {
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
      record.install_state === 'not_installed' && record.availability !== 'coming_soon'
    const canActivate =
      record.install_state === 'installed_inactive' &&
      record.availability !== 'coming_soon' &&
      !(record.availability === 'draft' && !devModeEffective) &&
      record.delist_reason !== 'security_violation' &&
      !holdReasons.includes('slotPreempted')
    const canUninstall =
      record.install_state !== 'not_installed' && record.slot_policy !== 'exclusive_required'

    return {
      ...record,
      name,
      description,
      icon,
      is_running: isRunning,
      is_usable: isUsable,
      can_activate: canActivate,
      can_install: canInstall,
      can_uninstall: canUninstall,
      hold_reasons: holdReasons,
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
    onProgress?: (event: ModuleDownloadProgressEvent) => void
  ): Promise<BuiltinModuleView> {
    this.ensureDefaultSeeds()
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
          spec.target_local_path || path.posix.join('modules', '_shared', spec.resource_id)
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

        // L2: 本地后备预置包打捞 (apps/desktop/build/presetResources 等)
        const l2Hit = await this.checkL2LocalPresetPreflight(spec, targetAbsDir)
        if (l2Hit) {
          dao.resources.markVerifiedSync(spec.resource_id, true)
          dao.resources.updateProgressSync(spec.resource_id, spec.expected_bytes, 'completed')

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

        // Singleflight 并发合并保护：同一物理资源同时只允许一个下载流
        let flight = this.inFlightResources.get(spec.resource_id)
        if (!flight) {
          flight = this.downloadAndInstallSingleResource(moduleId, task, spec, onProgress).finally(
            () => {
              this.inFlightResources.delete(spec.resource_id)
            }
          )
          this.inFlightResources.set(spec.resource_id, flight)
        }
        await flight
      }

      // 5. 全部依赖资源就绪，将模块状态流转为 active 或 installed_inactive (若已有同槽位 active)
      const slot = record.capability_slot ?? 'general'
      const policy = record.slot_policy ?? 'multi_active'
      const isExclusive = policy === 'exclusive_required' || policy === 'exclusive_optional'
      if (isExclusive) {
        const currentActive = dao.modules.findActiveBySlotSync(slot)
        if (currentActive && currentActive.id !== moduleId) {
          dao.modules.updateInstallStateSync(moduleId, 'installed_inactive')
        } else {
          dao.modules.activateExclusiveModuleSync(moduleId)
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
      }
      this.liveProgress.delete(moduleId)
      return this.buildModuleView(dao.modules.findByIdSync(moduleId)!)
    } catch (err: any) {
      const errorMsg = err?.message || String(err)
      dao.modules.updateInstallStateSync(moduleId, 'error', errorMsg)
      this.liveProgress.delete(moduleId)
      throw err
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
    const candidateUrls: string[] = []
    if (task.active_url) candidateUrls.push(task.active_url)
    if (spec.active_url && !candidateUrls.includes(spec.active_url))
      candidateUrls.push(spec.active_url)
    if (Array.isArray((spec as any).urls)) {
      for (const u of (spec as any).urls) {
        if (u && !candidateUrls.includes(u)) candidateUrls.push(u)
      }
    }
    if (Array.isArray((task as any).urls)) {
      for (const u of (task as any).urls) {
        if (u && !candidateUrls.includes(u)) candidateUrls.push(u)
      }
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

    const hasMultipleUrls =
      (Array.isArray((spec as any).urls) && (spec as any).urls.length > 1) ||
      (Array.isArray((task as any).urls) && (task as any).urls.length > 1)

    let result: VerifiedDownloadResult
    if (hasMultipleUrls && typeof this.downloadService.downloadWithFixedBlocks === 'function') {
      result = await this.downloadService.downloadWithFixedBlocks({
        taskId: `${moduleId}:${task.resource_id}`,
        assetId: task.resource_id,
        urls: candidateUrls,
        destPath: archivePath,
        expectedBytes: task.expected_bytes,
        expectedSha256: task.expected_sha256,
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
    } else {
      result = await this.downloadService.downloadWithVerification({
        taskId: `${moduleId}:${task.resource_id}`,
        url: candidateUrls[0],
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
    try {
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
        // 解压成功后写入 .ready 标记供后续毫秒级快检复用
        const sha8 = (task.expected_sha256 || '').slice(0, 8)
        if (sha8) {
          try {
            const readyMarkerPath = path.join(targetAbsDir, `.ready-${sha8}.json`)
            const files = fs
              .readdirSync(targetAbsDir)
              .filter(f => !f.startsWith('.'))
              .map(f => {
                const fp = path.join(targetAbsDir, f)
                const st = fs.statSync(fp)
                return { name: f, size: st.size, mtimeMs: st.mtimeMs, sha256: '' }
              })
            fs.writeFileSync(
              readyMarkerPath,
              JSON.stringify(
                {
                  version: 1,
                  assetId: task.resource_id,
                  archiveSha256: task.expected_sha256,
                  bomSha256: 'download_extracted',
                  createdAt: new Date().toISOString(),
                  coreFiles: files
                },
                null,
                2
              ),
              'utf-8'
            )
          } catch {}
        }
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
   * 卸载模块（Windows 两阶段 Tombstone 删除协议）：
   * 阶段一（事务内标记）：解绑 module_resource_downloads，计算剩余有效引用计数；引用归零的资源置为 pending_delete，模块置为 not_installed；
   * 阶段二（事务外 Tombstone 删除）：对 pending_delete 资源调用 safeDeleteDirectory（重命名为 .deleting-<uuid> 并退避重试删除；若被占用则保持 pending_delete 等待下次启动清理）。
   */
  async uninstallModule(moduleId: string): Promise<BuiltinModuleView> {
    this.ensureDefaultSeeds()
    const db = this.getDb()
    const dao = this.getDao()
    const record = dao.modules.findByIdSync(moduleId)
    if (!record) {
      throw new Error(`未找到模块定义: ${moduleId}`)
    }

    const resourcesToDelete: ResourceDownloadRecord[] = []

    // 阶段一：事务内解绑并计算引用计数，绝不在事务内做磁盘 I/O
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
    })

    tx()
    this.liveProgress.delete(moduleId)

    // 阶段二：事务外执行物理 Tombstone 删除与退避重试
    for (const res of resourcesToDelete) {
      const targetAbsDir = this.resolvePhysicalPath(res.target_local_path)
      try {
        const deleted = await this.tombstoneGC.safeDeleteWithTombstone(targetAbsDir, {
          slot: record.capability_slot ?? undefined,
          deleteDirectoryFn: this.deleteDirectoryFn
        })
        if (deleted) {
          // 再次确认引用计数为 0 后删除数据库记录
          const refCount = dao.resources.getResourceActiveRefCountSync(res.resource_id)
          if (refCount === 0) {
            dao.resources.deleteResourceSync(res.resource_id)
          }
        } else {
          // 句柄被占用（EBUSY/EPERM），保持 pending_delete 交由下次启动 reconcileOnStartup 清理
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

    return this.buildModuleView(dao.modules.findByIdSync(moduleId)!)
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
    this.ensureDefaultSeeds()
    const dao = this.getDao()
    const existing = dao.modules.findByIdSync(moduleId)
    if (!existing) {
      throw new Error(`未找到模块定义: ${moduleId}`)
    }

    // 1. 处理配置与变体
    if (patch.userConfig !== undefined) {
      let configStr: string | null = null
      if (patch.userConfig === null) {
        configStr = null
      } else if (typeof patch.userConfig === 'string') {
        const trimmed = patch.userConfig.trim()
        if (trimmed) {
          JSON.parse(trimmed)
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

    // 2. 处理激活/停用流转
    if (patch.active === true) {
      const slot = existing.capability_slot ?? 'general'
      const policy = existing.slot_policy ?? 'multi_active'
      const isExclusive = policy === 'exclusive_required' || policy === 'exclusive_optional'

      if (isExclusive) {
        // 排他逻辑：同槽位前任置为 installed_inactive 并平滑停止
        const currentActive = dao.modules.findActiveBySlotSync(slot)
        if (currentActive && currentActive.id !== moduleId) {
          dao.modules.updateInstallStateSync(currentActive.id, 'installed_inactive')
          await this.processManager.stopProcess(currentActive.id)
        }
      }

      const actRes = await this.processManager.requestActivate(moduleId, 'user_toggle')
      if (actRes.success) {
        dao.modules.updateInstallStateSync(moduleId, 'active')

        // 核心不变量 1：基础向量引擎切换时代际翻转
        if (slot === 'base_embedding') {
          const servingEpoch = dao.epochs.findServingEpochSync()
          const newEpochNum = servingEpoch ? servingEpoch.epoch + 1 : 1
          const isClassic = moduleId.includes('classic')
          const textDim = isClassic ? 384 : 768
          const imageDim = isClassic ? 512 : 768

          if (servingEpoch && servingEpoch.module_id !== moduleId) {
            dao.epochs.createEpochSync({
              epoch: newEpochNum,
              module_id: moduleId,
              text_dim: textDim,
              image_dim: imageDim,
              status: 'building',
              reindex_cursor: null
            })
            dao.epochs.flipEpochSync(servingEpoch.epoch, newEpochNum)
          } else if (!servingEpoch) {
            dao.epochs.createEpochSync({
              epoch: 1,
              module_id: moduleId,
              text_dim: textDim,
              image_dim: imageDim,
              status: 'serving',
              reindex_cursor: null
            })
          }
        }

        // 核心不变量 2：Omni 感知热重载通知
        if (slot === 'perception_nsfw' || slot === 'perception_face') {
          try {
            const { omniService } = require('./omni-service')
            omniService?.syncConfigFromDesktop?.().catch?.(() => {})
          } catch {}
        }
      } else {
        // 门禁拦截：保持 installed_inactive 并记录错误原因
        dao.modules.updateInstallStateSync(
          moduleId,
          'installed_inactive',
          actRes.error ?? '激活门禁拦截'
        )
      }
    } else if (patch.active === false) {
      // 核心不变量 3：必选槽防空保护
      if (existing.slot_policy === 'exclusive_required' && existing.install_state === 'active') {
        throw new Error('SLOT_REQUIRED_EMPTY')
      }

      dao.modules.updateInstallStateSync(moduleId, 'installed_inactive')
      await this.processManager.stopProcess(moduleId)
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

  async importOfflinePackage(
    archivePath: string,
    options?: { rootPublicKey?: string }
  ): Promise<BuiltinModuleView> {
    return this.offlinePackageService.importOfflinePackage(archivePath, options)
  }
}

export const modularResourceService = ModularResourceService.getInstance()
