/**
 * 插件中心与资源下载生命周期协调器 (ModularResourceService)
 *
 * 作为深模块（Deep Module），将 BuiltinModuleDao、ResourceDownloadDao 与底层文件/网络原语
 * （Range 206 断点续传、流式 SHA-256 校验、两层 Zip Slip 安全解压、Windows Tombstone 两阶段删除、
 * 启动期自愈与 IN-04 catalog_version 防回退）收拢在 6 个高杠杆接口背后。
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
  type ModuleAvailability
} from '../database/dao/modular-resource-dao'
import {
  FileDownloadService,
  fileDownloadService,
  safeExtractZip,
  safeDeleteDirectory,
  cleanOrphanTombstones,
  streamVerifySha256,
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
  author_code?: ModuleAuthorCode
  author_name?: string | null
  availability?: ModuleAvailability
  firecore_cost?: number
  total_bytes: number
  catalog_meta_json?: string | Record<string, unknown> | null
  config_schema?: string | Record<string, unknown> | null
  install_state?: ModuleInstallState
  selected_variant?: string | null
  install_path?: string | null
  resources?: CatalogResourceSpec[]
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

export interface BuiltinModuleView extends BuiltinModuleRecord {
  name: string
  description: string
  icon?: string
  resources: ResourceDownloadRecord[]
  download_progress?: {
    percentage: number
    speed_bytes_per_sec: number
    is_resumed: boolean
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

  /** 获取所有模块完整视图（合并 builtin_modules 状态与关联 resource_downloads 进度） */
  listModules(): BuiltinModuleView[]

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
  ): BuiltinModuleView
}

/**
 * 本地离线内置插件目录种子 (IN-04 纯离线兜底 SSOT)
 */
export const DEFAULT_CATALOG_SEEDS: CatalogModuleEntry[] = [
  {
    id: 'advanced_ai_engine',
    name: '高级本地 AI 推理引擎',
    description: '深度语义理解、智能重命名与多模态分析的大语言模型推理引擎',
    icon: 'Brain',
    kind: 'builtin-module',
    version: '1.0.0',
    catalog_version: 1,
    category: 'ai-engine',
    author_code: 'official',
    author_name: null,
    availability: 'available',
    firecore_cost: 0,
    total_bytes: 2314200000,
    install_state: 'active'
  },
  {
    id: 'offline_tts',
    name: '离线语音合成 TTS',
    description: '高质量离线自然语音朗读、伴音生成与多语种音色克隆引擎',
    icon: 'Volume2',
    kind: 'builtin-module',
    version: '1.0.0',
    catalog_version: 1,
    category: 'media',
    author_code: 'official',
    author_name: null,
    availability: 'available',
    firecore_cost: 0,
    total_bytes: 216426086,
    install_state: 'active',
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
    id: 'asr_engine',
    name: '语音识别与字幕提取 ASR',
    description: 'SenseVoice 极速高精音频转录、富文本标点对齐与多语言语音识别',
    icon: 'Mic',
    kind: 'builtin-module',
    version: '0.9.2',
    catalog_version: 1,
    category: 'perception',
    author_code: 'official',
    author_name: null,
    availability: 'available',
    firecore_cost: 0,
    total_bytes: 185597132,
    install_state: 'not_installed',
    resources: [
      {
        resource_id: 'ffmpeg',
        asset_name: 'ffmpeg-master-20260827-win32-x64.zip',
        target_local_path: 'modules/_shared/ffmpeg',
        active_source_key: 'auto',
        active_url:
          'https://github.com/Leonard-Li777/firefly-resources/releases/download/resources/ffmpeg-master-20260827-win32-x64.zip',
        expected_bytes: 56096345,
        expected_sha256: 'e39f97014143737827de6f9f91c3cfc283cea620f75c3fdef5d1f505c79171ff'
      },
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
  {
    id: 'diffusion_studio',
    name: '本地生图 Studio',
    description: '基于本地硬件加速的图像生成、超分辨率画面修复与视觉扩展',
    icon: 'Sparkles',
    kind: 'builtin-module',
    version: '0.1.0',
    catalog_version: 1,
    category: 'ai-engine',
    author_code: 'official',
    author_name: null,
    availability: 'coming_soon',
    firecore_cost: 0,
    total_bytes: 3824100000,
    install_state: 'not_installed'
  },
  {
    id: 'cad_3d_parser',
    name: 'CAD / 3D 图纸模型解析器',
    description: 'DWG/DXF 工程图纸与 OBJ/GLTF 三维模型离线轻量解析与缩略图渲染',
    icon: 'Box',
    kind: 'builtin-module',
    version: '1.2.0',
    catalog_version: 1,
    category: 'parser',
    author_code: 'official',
    author_name: null,
    availability: 'available',
    firecore_cost: 0,
    total_bytes: 94500000,
    install_state: 'not_installed'
  }
]

export interface ModularResourceServiceOptions {
  db?: Database
  baseDir?: string
  downloadService?: FileDownloadService
  transport?: IDownloadTransport
  deleteDirectoryFn?: (dirPath: string) => Promise<boolean>
}

export class ModularResourceService implements IModularResourceService {
  private static instance: ModularResourceService | null = null

  private customDb: Database | null = null
  private customBaseDir: string | null = null
  private downloadService: FileDownloadService
  private transport?: IDownloadTransport
  private deleteDirectoryFn: (dirPath: string) => Promise<boolean>
  private inFlightResources = new Map<string, Promise<void>>()
  private liveProgress = new Map<
    string,
    { percentage: number; speed_bytes_per_sec: number; is_resumed: boolean }
  >()
  private seeded = false

  constructor(options?: ModularResourceServiceOptions) {
    this.customDb = options?.db ?? null
    this.customBaseDir = options?.baseDir ?? null
    this.downloadService = options?.downloadService ?? fileDownloadService
    this.transport = options?.transport
    this.deleteDirectoryFn = options?.deleteDirectoryFn ?? safeDeleteDirectory
  }

  static getInstance(): ModularResourceService {
    if (!ModularResourceService.instance) {
      ModularResourceService.instance = new ModularResourceService()
    }
    return ModularResourceService.instance
  }

  private getDb(): Database {
    if (this.customDb) return this.customDb
    const { databaseService } = require('../database/database-service')
    if (!databaseService?.db) {
      throw new Error('ModularResourceService: 数据库尚未初始化')
    }
    return databaseService.db
  }

  private getDao(): ModularResourceDao {
    return new ModularResourceDao(this.getDb())
  }

  private getBaseDir(): string {
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
          author_code: entry.author_code ?? existing?.author_code ?? 'official',
          author_name:
            entry.author_name !== undefined ? entry.author_name : (existing?.author_name ?? null),
          availability: entry.availability ?? existing?.availability ?? 'available',
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

    return {
      ...record,
      name,
      description,
      icon,
      resources,
      ...(downloadProgress ? { download_progress: downloadProgress } : {})
    }
  }

  /**
   * 获取所有模块完整视图（合并 builtin_modules 状态与关联 resource_downloads 进度）
   */
  listModules(): BuiltinModuleView[] {
    this.ensureDefaultSeeds()
    const dao = this.getDao()
    const records = dao.modules.listAllSync()

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
      // 无外部物理资产依赖的模块，直接标记为 active
      dao.modules.updateInstallStateSync(moduleId, 'active')
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

        // 2. 引用计数复用检查：若资源已处于 completed 且物理目录存在、哈希吻合，直接跳过重复下载
        if (
          task.download_state === 'completed' &&
          fs.existsSync(targetAbsDir) &&
          (!task.expected_sha256 ||
            !task.actual_sha256 ||
            task.actual_sha256.toLowerCase() === task.expected_sha256.toLowerCase())
        ) {
          const completedEvt: ModuleDownloadProgressEvent = {
            moduleId,
            resourceId: spec.resource_id,
            downloadedBytes: task.expected_bytes,
            expectedBytes: task.expected_bytes,
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

      // 5. 全部依赖资源就绪，将模块状态流转为 active
      dao.modules.updateInstallStateSync(moduleId, 'active')
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
    const downloadUrl = task.active_url || spec.active_url
    if (!downloadUrl) {
      dao.resources.markVerifiedSync(task.resource_id, false, 'MISSING_ACTIVE_DOWNLOAD_URL')
      throw new Error(`MISSING_ACTIVE_DOWNLOAD_URL: ${task.resource_id}`)
    }

    const archivePath = this.resolveDownloadArchivePath(task.resource_id, task.asset_name)
    const partPath = `${archivePath}.part`
    const hadPartBefore = fs.existsSync(partPath) && fs.statSync(partPath).size > 0

    dao.resources.updateProgressSync(task.resource_id, task.downloaded_bytes || 0, 'downloading')

    const result = await this.downloadService.downloadWithVerification({
      taskId: `${moduleId}:${task.resource_id}`,
      url: downloadUrl,
      destPath: archivePath,
      expectedBytes: task.expected_bytes,
      expectedSha256: task.expected_sha256,
      etag: task.etag ?? undefined,
      transport: this.transport,
      onProgress: prog => {
        const pct = Math.min(100, Math.round(prog.percent))
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
          expectedBytes: prog.totalBytes || task.expected_bytes,
          percentage: pct,
          speedBytesPerSec: prog.speed,
          isResumed: hadPartBefore,
          state: 'downloading'
        })
      }
    })

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

    // 4. 若为 .zip 或 .ffp 归档，调用 safeExtractZip（内置两层 Zip Slip 防御）解压至 .tmp-<uuid> 并原子 rename
    const targetAbsDir = this.resolvePhysicalPath(task.target_local_path)
    const lowerAsset = task.asset_name.toLowerCase()
    try {
      if (lowerAsset.endsWith('.zip') || lowerAsset.endsWith('.ffp')) {
        onProgress?.({
          moduleId,
          resourceId: task.resource_id,
          downloadedBytes: result.finalBytes,
          expectedBytes: task.expected_bytes,
          percentage: 99,
          speedBytesPerSec: 0,
          isResumed: Boolean(result.isResumed),
          state: 'extracting'
        })
        await safeExtractZip(archivePath, targetAbsDir)
        // 解压成功后清理归档包临时文件
        if (fs.existsSync(archivePath)) {
          try {
            fs.unlinkSync(archivePath)
          } catch {
            // ignore
          }
        }
      } else {
        // 非压缩包单文件资源：直接移入目标目录
        if (!fs.existsSync(targetAbsDir)) {
          fs.mkdirSync(targetAbsDir, { recursive: true })
        }
        const destFile = path.join(targetAbsDir, task.asset_name)
        if (fs.existsSync(destFile)) {
          fs.unlinkSync(destFile)
        }
        fs.renameSync(archivePath, destFile)
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
        const deleted = await this.deleteDirectoryFn(targetAbsDir)
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
  updateModuleState(
    moduleId: string,
    patch: {
      active?: boolean
      userConfig?: Record<string, unknown> | string | null
      selectedVariant?: string
      userConsent?: boolean
    }
  ): BuiltinModuleView {
    this.ensureDefaultSeeds()
    const db = this.getDb()
    const dao = this.getDao()
    const existing = dao.modules.findByIdSync(moduleId)
    if (!existing) {
      throw new Error(`未找到模块定义: ${moduleId}`)
    }

    const tx = db.transaction(() => {
      if (patch.active !== undefined) {
        const nextState: ModuleInstallState = patch.active ? 'active' : 'installed_inactive'
        dao.modules.updateInstallStateSync(moduleId, nextState)
      }

      if (patch.userConfig !== undefined) {
        let configStr: string | null = null
        if (patch.userConfig === null) {
          configStr = null
        } else if (typeof patch.userConfig === 'string') {
          const trimmed = patch.userConfig.trim()
          if (trimmed) {
            // 校验 JSON 合法性
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
    })

    tx()
    return this.buildModuleView(dao.modules.findByIdSync(moduleId)!)
  }
}

export const modularResourceService = ModularResourceService.getInstance()
