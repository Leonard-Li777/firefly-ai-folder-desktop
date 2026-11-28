import type { Database } from 'better-sqlite3'
import type { ModularResourceDao, PluginCapabilitySlot } from '../database/dao/modular-resource-dao'
import type { PendingDeletionItem } from './index'
import type {
  CatalogModuleEntry,
  ModuleDownloadProgressEvent,
  BuiltinModuleView
} from '../system/types'
import type {
  DirRuntimePhase,
  PluginDirErrorCode,
  PluginDirInfo,
  ValidatePluginDirResult
} from '@firefly/types/config-types'

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
    options?: {
      rootPublicKey?: string
      preferredEngineId?: string
      autoActivateModuleIds?: string[]
    }
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

  /** 槽位互斥单锁执行入口 */
  withSlotMutex<T>(slot: string, fn: () => Promise<T>): Promise<T>

  /** 409/stale 本地优先单锁对账入口 */
  reconcileVisualVocabResource(
    resourceId: string,
    opts?: { skipDownload?: boolean; forceDownload?: boolean }
  ): Promise<{ ok: boolean; diskMatchesCatalog?: boolean; error?: string }>
}
