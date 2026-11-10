import type { Database } from 'better-sqlite3'
import { logger, LogCategory } from '@firefly/shared'

export type ModuleKind = 'builtin-module' | 'third-party-plugin'
export type ModuleCategory =
  | 'ai-engine'
  | 'perception'
  | 'media'
  | 'tool'
  | 'parser'
  | 'vfs-archive'
export type ModuleInstallState =
  | 'not_installed'
  | 'downloading'
  | 'installed_inactive'
  | 'active'
  | 'error'
export type ModuleAuthorCode = 'official' | 'community' | 'third_party'
export type ModuleAvailability = 'coming_soon' | 'draft' | 'approved' | 'delisted'
export type DelistReason = 'general_deprecation' | 'security_violation'

export type PluginCapabilitySlot =
  | 'base_embedding'
  | 'asr'
  | 'tts'
  | 'voice_asr'
  | 'voice_tts'
  | 'perception_nsfw'
  | 'perception_face'
  | 'advanced_ai_engine'
  | 'ai_engine_cpu'
  | 'parser'
  | 'tool'
  | 'general'

export type SlotPolicy = 'exclusive_required' | 'exclusive_optional' | 'multi_active'

export type BackendType = 'omni_onnx' | 'ai_engine' | 'utility_process' | 'builtin'

export interface EmbeddingEpochRecord {
  epoch: number
  module_id: string
  text_dim: number
  image_dim: number
  status: 'building' | 'serving' | 'retired' | 'cancelled'
  created_at: number
  reindex_cursor?: string | null
}

export interface BuiltinModuleRecord {
  id: string
  kind: ModuleKind
  version: string
  catalog_version: number
  category: ModuleCategory
  author_code: ModuleAuthorCode
  author_name?: string | null
  availability: ModuleAvailability
  delist_reason?: DelistReason | null
  firecore_cost?: number
  total_bytes: number
  catalog_meta_json?: string | null
  config_schema?: string | null
  user_config?: string | null
  install_state: ModuleInstallState
  selected_variant?: string | null
  install_path?: string | null
  installed_at?: number | null
  last_activated_at?: number | null
  user_consent: number
  error_message?: string | null
  config_json?: string | null
  capability_slot?: PluginCapabilitySlot
  slot_policy?: SlotPolicy
  backend_type?: BackendType
}

export type DownloadState =
  | 'pending'
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'paused'
  | 'cancelled'
  | 'completed'
  | 'failed'
  | 'pending_delete'

export interface ResourceDownloadRecord {
  resource_id: string
  asset_name: string
  target_local_path: string
  active_source_key: string
  active_url?: string | null
  expected_bytes: number
  downloaded_bytes: number
  expected_sha256: string
  actual_sha256?: string | null
  etag?: string | null
  last_modified?: string | null
  download_state: DownloadState
  error_message?: string | null
  created_at: number
  updated_at: number
}

export interface ModuleResourceDownloadRecord {
  module_id: string
  resource_id: string
  created_at: number
}

export type WorkflowSource = 'official' | 'user' | 'imported' | 'community'
export type WorkflowCategory = 'entertainment' | 'creative' | 'office'
export type WorkflowStatus =
  | 'published'
  | 'draft'
  | 'private'
  | 'reviewing'
  | 'rejected'
  | 'delisted'

export interface LocalWorkflowRecord {
  id: string
  user_id?: string | null
  author?: string | null
  name: string
  version: string
  persona: string
  category: WorkflowCategory
  summary?: string | null
  source: WorkflowSource
  status: WorkflowStatus
  workspace_config: string
  naming_pattern?: string | null
  naming_template?: string | null
  preset_directory_tree?: string | null
  preview_tree?: string | null
  icon_svg?: string | null
  created_at: string | number
  modified_at?: string | number
  /** @deprecated 向后兼容过渡 */
  filter_mode?: 'whitelist' | 'blacklist'
  /** @deprecated 向后兼容过渡 */
  filter_rules?: string
  /** @deprecated 向后兼容过渡 */
  engine_params_json?: string | null
}

export interface ListModulesFilter {
  scope?: 'market' | 'installed'
  category?: string
  includeDraft?: boolean
}

export interface IBuiltinModuleDAO {
  listAll(filter?: ListModulesFilter): Promise<BuiltinModuleRecord[]>
  listAllSync(filter?: ListModulesFilter): BuiltinModuleRecord[]
  findActive(): Promise<BuiltinModuleRecord[]>
  findActiveSync(): BuiltinModuleRecord[]
  findById(id: string): Promise<BuiltinModuleRecord | null>
  findByIdSync(id: string): BuiltinModuleRecord | null
  upsertModule(record: Partial<BuiltinModuleRecord> & { id: string }): Promise<boolean>
  upsertModuleSync(record: Partial<BuiltinModuleRecord> & { id: string }): boolean
  updateInstallState(id: string, state: ModuleInstallState, error?: string): Promise<void>
  updateInstallStateSync(id: string, state: ModuleInstallState, error?: string): void
  updateVariant(id: string, variant: string): Promise<void>
  updateVariantSync(id: string, variant: string): void
  updateUserConfig(id: string, userConfig: string | null): Promise<void>
  updateUserConfigSync(id: string, userConfig: string | null): void
  updateUserConsentSync(id: string, userConsent: number): void
  deleteModule(id: string): Promise<void>
  findActiveBySlotSync(slot: PluginCapabilitySlot): BuiltinModuleRecord | null
  activateExclusiveModuleSync(id: string): void
  deactivateModuleSync(id: string): void
}

export interface IEmbeddingEpochDAO {
  findServingEpochSync(): EmbeddingEpochRecord | null
  findBuildingEpochSync(): EmbeddingEpochRecord | null
  createEpochSync(epoch: Omit<EmbeddingEpochRecord, 'created_at'>): EmbeddingEpochRecord
  flipEpochSync(oldEpoch: number, newEpoch: number): void
  cancelBuildingEpochsSync(): void
  updateCursorSync(epoch: number, cursorJson: string): void
}

export interface IResourceDownloadDAO {
  listAll(): Promise<ResourceDownloadRecord[]>
  listAllSync(): ResourceDownloadRecord[]
  createOrGetTask(
    task: Omit<ResourceDownloadRecord, 'downloaded_bytes' | 'created_at' | 'updated_at'>
  ): Promise<ResourceDownloadRecord>
  createOrGetTaskSync(
    task: Omit<ResourceDownloadRecord, 'downloaded_bytes' | 'created_at' | 'updated_at'>
  ): ResourceDownloadRecord
  bindResourceToModule(moduleId: string, resourceId: string): Promise<void>
  bindResourceToModuleSync(moduleId: string, resourceId: string): void
  unbindResourceFromModule(moduleId: string, resourceId: string): Promise<void>
  unbindResourceFromModuleSync(moduleId: string, resourceId: string): void
  updateProgress(
    resourceId: string,
    downloadedBytes: number,
    state: DownloadState,
    errorMessage?: string
  ): Promise<void>
  updateProgressSync(
    resourceId: string,
    downloadedBytes: number,
    state: DownloadState,
    errorMessage?: string
  ): void
  markVerified(
    resourceId: string,
    success: boolean,
    actualShaOrError?: string | { actualSha256?: string; errorMessage?: string },
    errorMessage?: string
  ): Promise<void>
  markVerifiedSync(
    resourceId: string,
    success: boolean,
    actualShaOrError?: string | { actualSha256?: string; errorMessage?: string },
    errorMessage?: string
  ): void
  updateHeaders(
    resourceId: string,
    etag?: string | null,
    lastModified?: string | null
  ): Promise<void>
  updateHeadersSync(resourceId: string, etag?: string | null, lastModified?: string | null): void
  markPendingDelete(resourceId: string): Promise<void>
  markPendingDeleteSync(resourceId: string): void
  findResourcesByModule(moduleId: string): Promise<ResourceDownloadRecord[]>
  findResourcesByModuleSync(moduleId: string): ResourceDownloadRecord[]
  getReferencingModules(resourceId: string): Promise<string[]>
  getResourceActiveRefCount(resourceId: string): Promise<number>
  getResourceActiveRefCountSync(resourceId: string): number
  findById(resourceId: string): Promise<ResourceDownloadRecord | null>
  findByIdSync(resourceId: string): ResourceDownloadRecord | null
  deleteResource(resourceId: string): Promise<void>
  deleteResourceSync(resourceId: string): void
}

export interface ILocalWorkflowDAO {
  listAll(): Promise<LocalWorkflowRecord[]>
  findById(id: string): Promise<LocalWorkflowRecord | null>
  createWorkflow(record: Omit<LocalWorkflowRecord, 'created_at' | 'modified_at'>): Promise<void>
  updateWorkflow(id: string, updates: Partial<LocalWorkflowRecord>): Promise<void>
  deleteWorkflow(id: string): Promise<void>
  getById?(id: string): LocalWorkflowRecord | undefined
  getAll?(): LocalWorkflowRecord[]
  upsert?(record: Omit<LocalWorkflowRecord, 'created_at' | 'modified_at'>): boolean
  delete?(id: string): boolean
}

/**
 * 内置与可选功能模块 DAO
 */
export class BuiltinModuleDao implements IBuiltinModuleDAO {
  constructor(private db: Database) {}

  listAllSync(filter?: ListModulesFilter): BuiltinModuleRecord[] {
    let sql = 'SELECT * FROM builtin_modules WHERE 1=1'
    const params: unknown[] = []

    if (filter?.scope === 'market') {
      if (filter.includeDraft) {
        sql += " AND availability IN ('approved', 'coming_soon', 'draft')"
      } else {
        sql += " AND availability IN ('approved', 'coming_soon')"
      }
    } else if (filter?.scope === 'installed') {
      sql += " AND install_state != 'not_installed'"
    }

    if (filter?.category) {
      sql += ' AND category = ?'
      params.push(filter.category)
    }

    sql += ' ORDER BY id ASC'
    const rows = this.db.prepare(sql).all(...params) as BuiltinModuleRecord[]
    return rows
  }

  async listAll(filter?: ListModulesFilter): Promise<BuiltinModuleRecord[]> {
    return this.listAllSync(filter)
  }

  findActiveSync(): BuiltinModuleRecord[] {
    return this.db
      .prepare("SELECT * FROM builtin_modules WHERE install_state = 'active' ORDER BY id ASC")
      .all() as BuiltinModuleRecord[]
  }

  async findActive(): Promise<BuiltinModuleRecord[]> {
    return this.findActiveSync()
  }

  findByIdSync(id: string): BuiltinModuleRecord | null {
    const row = this.db.prepare('SELECT * FROM builtin_modules WHERE id = ?').get(id) as
      | BuiltinModuleRecord
      | undefined
    return row ?? null
  }

  async findById(id: string): Promise<BuiltinModuleRecord | null> {
    return this.findByIdSync(id)
  }

  upsertModuleSync(record: Partial<BuiltinModuleRecord> & { id: string }): boolean {
    const existing = this.findByIdSync(record.id)
    const rawAvailability = record.availability ?? existing?.availability ?? 'approved'
    const availability = (
      rawAvailability === ('available' as any) ? 'approved' : rawAvailability
    ) as ModuleAvailability
    const delist_reason =
      availability === 'delisted'
        ? (record.delist_reason ?? existing?.delist_reason ?? 'general_deprecation')
        : null

    if (!existing) {
      const stmt = this.db.prepare(`
        INSERT INTO builtin_modules (
          id, kind, version, catalog_version, category, author_code, author_name,
          availability, delist_reason, firecore_cost, total_bytes, catalog_meta_json, config_schema, user_config,
          install_state, selected_variant, install_path, installed_at,
          last_activated_at, user_consent, error_message, config_json,
          capability_slot, slot_policy, backend_type
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?
        )
      `)
      stmt.run(
        record.id,
        record.kind ?? 'builtin-module',
        record.version ?? '1.0.0',
        record.catalog_version ?? 1,
        record.category ?? 'tool',
        record.author_code ?? 'official',
        record.author_name ?? null,
        availability,
        delist_reason,
        record.firecore_cost ?? 0,
        record.total_bytes ?? 0,
        record.catalog_meta_json ?? null,
        record.config_schema ?? null,
        record.user_config ?? null,
        record.install_state ?? 'not_installed',
        record.selected_variant ?? null,
        record.install_path ?? null,
        record.installed_at ?? null,
        record.last_activated_at ?? null,
        record.user_consent ?? 0,
        record.error_message ?? null,
        record.config_json ?? null,
        record.capability_slot ?? 'general',
        record.slot_policy ?? 'multi_active',
        record.backend_type ?? 'omni_onnx'
      )
      return true
    } else {
      // [IN-04] catalog_version 回退防御与警告机制
      const incomingCatalogVersion = record.catalog_version ?? 1
      const localCatalogVersion = existing.catalog_version ?? 1
      if (incomingCatalogVersion < localCatalogVersion) {
        logger.warn(
          LogCategory.SYSTEM,
          `[catalog_version_regression] 云端下发元数据版本 (${incomingCatalogVersion}) 低于本地版本 (${localCatalogVersion})，忽略本次覆盖: ${record.id}`
        )
        return false
      }

      const merged: BuiltinModuleRecord = {
        ...existing,
        ...record,
        availability,
        delist_reason,
        // 关键防护：保留本地运行态与个性化配置，绝不被云端元数据静默覆盖
        install_state: record.install_state ?? existing.install_state,
        user_config: record.user_config ?? existing.user_config,
        config_json: record.config_json ?? existing.config_json,
        capability_slot: record.capability_slot ?? existing.capability_slot ?? 'general',
        slot_policy: record.slot_policy ?? existing.slot_policy ?? 'multi_active',
        backend_type: record.backend_type ?? existing.backend_type ?? 'omni_onnx'
      }
      const stmt = this.db.prepare(`
        UPDATE builtin_modules SET
          kind = ?,
          version = ?,
          catalog_version = ?,
          category = ?,
          author_code = ?,
          author_name = ?,
          availability = ?,
          delist_reason = ?,
          firecore_cost = ?,
          total_bytes = ?,
          catalog_meta_json = ?,
          config_schema = ?,
          user_config = ?,
          install_state = ?,
          selected_variant = ?,
          install_path = ?,
          installed_at = ?,
          last_activated_at = ?,
          user_consent = ?,
          error_message = ?,
          config_json = ?,
          capability_slot = ?,
          slot_policy = ?,
          backend_type = ?
        WHERE id = ?
      `)
      stmt.run(
        merged.kind,
        merged.version,
        merged.catalog_version ?? 1,
        merged.category,
        merged.author_code ?? 'official',
        merged.author_name ?? null,
        merged.availability,
        merged.delist_reason ?? null,
        merged.firecore_cost ?? 0,
        merged.total_bytes ?? 0,
        merged.catalog_meta_json ?? null,
        merged.config_schema ?? null,
        merged.user_config ?? null,
        merged.install_state,
        merged.selected_variant ?? null,
        merged.install_path ?? null,
        merged.installed_at ?? null,
        merged.last_activated_at ?? null,
        merged.user_consent ?? 0,
        merged.error_message ?? null,
        merged.config_json ?? null,
        merged.capability_slot ?? 'general',
        merged.slot_policy ?? 'multi_active',
        merged.backend_type ?? 'omni_onnx',
        record.id
      )
      return true
    }
  }

  async upsertModule(record: Partial<BuiltinModuleRecord> & { id: string }): Promise<boolean> {
    return this.upsertModuleSync(record)
  }

  updateUserConfigSync(id: string, userConfig: string | null): void {
    this.db.prepare('UPDATE builtin_modules SET user_config = ? WHERE id = ?').run(userConfig, id)
  }

  async updateUserConfig(id: string, userConfig: string | null): Promise<void> {
    this.updateUserConfigSync(id, userConfig)
  }

  updateUserConsentSync(id: string, userConsent: number): void {
    this.db
      .prepare('UPDATE builtin_modules SET user_consent = ? WHERE id = ?')
      .run(userConsent ? 1 : 0, id)
  }

  updateInstallStateSync(id: string, state: ModuleInstallState, error?: string): void {
    const now = Date.now()
    if (state === 'active') {
      this.db
        .prepare(
          `
        UPDATE builtin_modules
        SET install_state = ?, error_message = ?, last_activated_at = ?,
            installed_at = COALESCE(installed_at, ?)
        WHERE id = ?
      `
        )
        .run(state, error ?? null, now, now, id)
    } else if (state === 'installed_inactive') {
      this.db
        .prepare(
          `
        UPDATE builtin_modules
        SET install_state = ?, error_message = ?,
            installed_at = COALESCE(installed_at, ?)
        WHERE id = ?
      `
        )
        .run(state, error ?? null, now, id)
    } else {
      this.db
        .prepare(
          `
        UPDATE builtin_modules
        SET install_state = ?, error_message = ?
        WHERE id = ?
      `
        )
        .run(state, error ?? null, id)
    }
  }

  async updateInstallState(id: string, state: ModuleInstallState, error?: string): Promise<void> {
    this.updateInstallStateSync(id, state, error)
  }

  updateVariantSync(id: string, variant: string): void {
    this.db.prepare('UPDATE builtin_modules SET selected_variant = ? WHERE id = ?').run(variant, id)
  }

  async updateVariant(id: string, variant: string): Promise<void> {
    this.updateVariantSync(id, variant)
  }

  findActiveBySlotSync(slot: PluginCapabilitySlot): BuiltinModuleRecord | null {
    const row = this.db
      .prepare('SELECT * FROM builtin_modules WHERE capability_slot = ? AND install_state = ?')
      .get(slot, 'active') as BuiltinModuleRecord | undefined
    return row ?? null
  }

  activateExclusiveModuleSync(id: string): void {
    const target = this.findByIdSync(id)
    if (!target) {
      throw new Error(`未找到模块: ${id}`)
    }
    const slot = target.capability_slot ?? 'general'
    const policy = target.slot_policy ?? 'multi_active'
    const isExclusive = policy === 'exclusive_required' || policy === 'exclusive_optional'

    const tx = this.db.transaction(() => {
      if (isExclusive) {
        // 先停用同槽位已有 active 模块
        this.db
          .prepare(
            `UPDATE builtin_modules
             SET install_state = 'installed_inactive'
             WHERE capability_slot = ? AND install_state = 'active' AND id != ?`
          )
          .run(slot, id)
      }
      this.updateInstallStateSync(id, 'active')
    })
    tx.immediate()
  }

  deactivateModuleSync(id: string): void {
    const target = this.findByIdSync(id)
    if (!target) {
      throw new Error(`未找到模块: ${id}`)
    }
    if (target.slot_policy === 'exclusive_required' && target.install_state === 'active') {
      throw new Error('SLOT_REQUIRED_EMPTY')
    }
    this.updateInstallStateSync(id, 'installed_inactive')
  }

  async deleteModule(id: string): Promise<void> {
    // 外键级联自动清除 module_resource_downloads
    this.db.prepare('DELETE FROM builtin_modules WHERE id = ?').run(id)
  }
}

/**
 * 物理资源下载实体 DAO (资源中心化 SSOT)
 */
export class ResourceDownloadDao implements IResourceDownloadDAO {
  constructor(private db: Database) {}

  listAllSync(): ResourceDownloadRecord[] {
    return this.db
      .prepare('SELECT * FROM resource_downloads ORDER BY resource_id ASC')
      .all() as ResourceDownloadRecord[]
  }

  async listAll(): Promise<ResourceDownloadRecord[]> {
    return this.listAllSync()
  }

  findByIdSync(resourceId: string): ResourceDownloadRecord | null {
    const row = this.db
      .prepare('SELECT * FROM resource_downloads WHERE resource_id = ?')
      .get(resourceId) as ResourceDownloadRecord | undefined
    return row ?? null
  }

  async findById(resourceId: string): Promise<ResourceDownloadRecord | null> {
    return this.findByIdSync(resourceId)
  }

  createOrGetTaskSync(
    task: Omit<ResourceDownloadRecord, 'downloaded_bytes' | 'created_at' | 'updated_at'>
  ): ResourceDownloadRecord {
    const existing = this.findByIdSync(task.resource_id)
    if (existing) {
      return existing
    }
    const now = Date.now()
    const stmt = this.db.prepare(`
      INSERT INTO resource_downloads (
        resource_id, asset_name, target_local_path, active_source_key,
        active_url, expected_bytes, downloaded_bytes, expected_sha256,
        actual_sha256, etag, last_modified, download_state, error_message, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, 0, ?,
        ?, ?, ?, ?, ?, ?, ?
      )
    `)
    stmt.run(
      task.resource_id,
      task.asset_name,
      task.target_local_path,
      task.active_source_key ?? 'auto',
      task.active_url ?? null,
      task.expected_bytes,
      task.expected_sha256,
      task.actual_sha256 ?? null,
      task.etag ?? null,
      task.last_modified ?? null,
      task.download_state ?? 'pending',
      task.error_message ?? null,
      now,
      now
    )
    return this.findByIdSync(task.resource_id)!
  }

  async createOrGetTask(
    task: Omit<ResourceDownloadRecord, 'downloaded_bytes' | 'created_at' | 'updated_at'>
  ): Promise<ResourceDownloadRecord> {
    return this.createOrGetTaskSync(task)
  }

  bindResourceToModuleSync(moduleId: string, resourceId: string): void {
    const now = Date.now()
    this.db
      .prepare(
        `
      INSERT OR IGNORE INTO module_resource_downloads (module_id, resource_id, created_at)
      VALUES (?, ?, ?)
    `
      )
      .run(moduleId, resourceId, now)
  }

  async bindResourceToModule(moduleId: string, resourceId: string): Promise<void> {
    this.bindResourceToModuleSync(moduleId, resourceId)
  }

  unbindResourceFromModuleSync(moduleId: string, resourceId: string): void {
    this.db
      .prepare(
        `
      DELETE FROM module_resource_downloads
      WHERE module_id = ? AND resource_id = ?
    `
      )
      .run(moduleId, resourceId)
  }

  async unbindResourceFromModule(moduleId: string, resourceId: string): Promise<void> {
    this.unbindResourceFromModuleSync(moduleId, resourceId)
  }

  updateProgressSync(
    resourceId: string,
    downloadedBytes: number,
    state: DownloadState,
    errorMessage?: string
  ): void {
    const now = Date.now()
    this.db
      .prepare(
        `
      UPDATE resource_downloads
      SET downloaded_bytes = ?, download_state = ?, error_message = ?, updated_at = ?
      WHERE resource_id = ?
    `
      )
      .run(downloadedBytes, state, errorMessage ?? null, now, resourceId)
  }

  async updateProgress(
    resourceId: string,
    downloadedBytes: number,
    state: DownloadState,
    errorMessage?: string
  ): Promise<void> {
    this.updateProgressSync(resourceId, downloadedBytes, state, errorMessage)
  }

  markVerifiedSync(
    resourceId: string,
    success: boolean,
    actualShaOrError?: string | { actualSha256?: string; errorMessage?: string },
    errorMessage?: string
  ): void {
    const now = Date.now()
    let actualSha256: string | null = null
    let error: string | null = null

    if (typeof actualShaOrError === 'object' && actualShaOrError !== null) {
      actualSha256 = actualShaOrError.actualSha256 ?? null
      error = actualShaOrError.errorMessage ?? null
    } else if (success) {
      actualSha256 = actualShaOrError ?? null
      error = errorMessage ?? null
    } else {
      if (errorMessage !== undefined) {
        actualSha256 = actualShaOrError ?? null
        error = errorMessage
      } else {
        error = actualShaOrError ?? 'SHA-256 完整性校验失败'
      }
    }

    if (success) {
      this.db
        .prepare(
          `
        UPDATE resource_downloads
        SET download_state = 'completed', actual_sha256 = COALESCE(?, actual_sha256), error_message = NULL, updated_at = ?
        WHERE resource_id = ?
      `
        )
        .run(actualSha256, now, resourceId)
    } else {
      this.db
        .prepare(
          `
        UPDATE resource_downloads
        SET download_state = 'failed', actual_sha256 = COALESCE(?, actual_sha256), error_message = ?, updated_at = ?
        WHERE resource_id = ?
      `
        )
        .run(actualSha256, error ?? 'SHA-256 完整性校验失败', now, resourceId)
    }
  }

  async markVerified(
    resourceId: string,
    success: boolean,
    actualShaOrError?: string | { actualSha256?: string; errorMessage?: string },
    errorMessage?: string
  ): Promise<void> {
    this.markVerifiedSync(resourceId, success, actualShaOrError, errorMessage)
  }

  updateHeadersSync(resourceId: string, etag?: string | null, lastModified?: string | null): void {
    const now = Date.now()
    this.db
      .prepare(
        `
      UPDATE resource_downloads
      SET etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified), updated_at = ?
      WHERE resource_id = ?
    `
      )
      .run(etag ?? null, lastModified ?? null, now, resourceId)
  }

  async updateHeaders(
    resourceId: string,
    etag?: string | null,
    lastModified?: string | null
  ): Promise<void> {
    this.updateHeadersSync(resourceId, etag, lastModified)
  }

  markPendingDeleteSync(resourceId: string): void {
    const now = Date.now()
    this.db
      .prepare(
        `
      UPDATE resource_downloads
      SET download_state = 'pending_delete', updated_at = ?
      WHERE resource_id = ?
    `
      )
      .run(now, resourceId)
  }

  async markPendingDelete(resourceId: string): Promise<void> {
    this.markPendingDeleteSync(resourceId)
  }

  findResourcesByModuleSync(moduleId: string): ResourceDownloadRecord[] {
    const rows = this.db
      .prepare(
        `
      SELECT r.* FROM resource_downloads r
      INNER JOIN module_resource_downloads m ON r.resource_id = m.resource_id
      WHERE m.module_id = ?
      ORDER BY r.resource_id ASC
    `
      )
      .all(moduleId) as ResourceDownloadRecord[]
    return rows
  }

  async findResourcesByModule(moduleId: string): Promise<ResourceDownloadRecord[]> {
    return this.findResourcesByModuleSync(moduleId)
  }

  async getReferencingModules(resourceId: string): Promise<string[]> {
    const rows = this.db
      .prepare(
        `
      SELECT module_id FROM module_resource_downloads
      WHERE resource_id = ?
      ORDER BY module_id ASC
    `
      )
      .all(resourceId) as Array<{ module_id: string }>
    return rows.map(r => r.module_id)
  }

  /**
   * 事务内即时动态引用计数查询 (AC 3)
   */
  getResourceActiveRefCountSync(resourceId: string): number {
    const row = this.db
      .prepare(
        `
      SELECT COUNT(*) as count FROM module_resource_downloads WHERE resource_id = ?
    `
      )
      .get(resourceId) as { count: number } | undefined
    return row?.count ?? 0
  }

  async getResourceActiveRefCount(resourceId: string): Promise<number> {
    return this.getResourceActiveRefCountSync(resourceId)
  }

  deleteResourceSync(resourceId: string): void {
    const refCount = this.getResourceActiveRefCountSync(resourceId)
    if (refCount > 0) {
      throw new Error(`无法物理删除资源 ${resourceId}: 仍有 ${refCount} 个模块引用`)
    }
    this.db.prepare('DELETE FROM resource_downloads WHERE resource_id = ?').run(resourceId)
  }

  async deleteResource(resourceId: string): Promise<void> {
    this.deleteResourceSync(resourceId)
  }

  /**
   * 启动两级原子对账机制 (AC 4)
   * 兼顾快速启动与失败态可观测性，杜绝静默耗流与带病运行
   */
  async reconcileResourceStatus(
    resourceId: string,
    fileInfo: {
      exists: boolean
      hasPart?: boolean
      partSize?: number
      fileSize?: number
      currentBomSha?: string
      computedSha?: string
    }
  ): Promise<{ state: DownloadState; reason?: string }> {
    const record = await this.findById(resourceId)
    if (!record) {
      throw new Error(`找不到资源对账记录: ${resourceId}`)
    }

    const now = Date.now()

    // 1. 如果本地正式文件已完整存在
    if (fileInfo.exists) {
      const isBomShaMatched =
        !fileInfo.currentBomSha || fileInfo.currentBomSha === record.expected_sha256
      const isSizeMatched =
        fileInfo.fileSize === undefined || fileInfo.fileSize === record.expected_bytes

      // Fast Path：大小吻合且 BOM SHA 一致，且没有深度计算出哈希不符
      if (isBomShaMatched && isSizeMatched) {
        if (fileInfo.computedSha) {
          if (fileInfo.computedSha !== record.expected_sha256) {
            // Slow Path 校验出哈希损坏
            const reason = 'BOM版本不匹配或文件损坏'
            await this.markVerified(resourceId, false, reason)
            return { state: 'failed', reason }
          }
        }
        // 保持或更新为 completed
        if (record.download_state !== 'completed') {
          await this.markVerified(resourceId, true)
        }
        return { state: 'completed' }
      } else {
        // 大小或 BOM SHA 不匹配，直接标记 failed 阻断运行
        const reason = 'BOM版本不匹配或文件损坏'
        await this.markVerified(resourceId, false, reason)
        return { state: 'failed', reason }
      }
    }

    // 2. 正式文件不存在，但存在 .part 临时文件
    if (fileInfo.hasPart) {
      const partSize = fileInfo.partSize ?? 0
      // 保持 paused 状态，断点以磁盘实际 size 为准
      this.db
        .prepare(
          `
        UPDATE resource_downloads
        SET downloaded_bytes = ?, download_state = 'paused', error_message = NULL, updated_at = ?
        WHERE resource_id = ?
      `
        )
        .run(partSize, now, resourceId)
      return { state: 'paused', reason: '等待接续断点续传' }
    }

    // 3. 正式文件与临时文件均不存在
    if (record.download_state === 'completed') {
      // 曾经标记已完成但文件丢失，置为 failed
      const reason = '本地物理文件丢失，需重新下载'
      await this.markVerified(resourceId, false, reason)
      return { state: 'failed', reason }
    } else {
      // 未完成且无临时文件，重置为 pending
      this.db
        .prepare(
          `
        UPDATE resource_downloads
        SET downloaded_bytes = 0, download_state = 'pending', error_message = NULL, updated_at = ?
        WHERE resource_id = ?
      `
        )
        .run(now, resourceId)
      return { state: 'pending' }
    }
  }
}

/**
 * 本地与导入工作流定义 DAO
 */
export class LocalWorkflowDao implements ILocalWorkflowDAO {
  constructor(private db: Database) {}

  getById(id: string): LocalWorkflowRecord | undefined {
    return this.db.prepare('SELECT * FROM local_workflows WHERE id = ?').get(id) as
      | LocalWorkflowRecord
      | undefined
  }

  getAll(): LocalWorkflowRecord[] {
    return this.db
      .prepare(
        'SELECT id, user_id, author, name, version, persona, category, summary, source, status, workspace_config, naming_pattern, naming_template, preset_directory_tree, preview_tree, icon_svg, created_at, modified_at FROM local_workflows ORDER BY created_at DESC'
      )
      .all() as LocalWorkflowRecord[]
  }

  upsert(
    record: Omit<LocalWorkflowRecord, 'created_at' | 'modified_at'> & { id?: string }
  ): boolean {
    const category = record.category || 'entertainment'
    const source = record.source || 'official'
    const status = record.status || (source === 'official' ? 'published' : 'draft')
    let author = record.author ?? null
    let userId = record.user_id ?? null

    // 严密对齐权限与作者约束 (ISS-A / ISS-C)
    if (source === 'official') {
      userId = null
      author = author || 'Firefly Official'
    } else if (source === 'user') {
      userId = userId || 'local_user'
      author = author || 'Local User'
    } else if (source === 'imported' || source === 'community') {
      author = author || 'Community Contributor'
    }

    // 自动发证：若未指定 id，按规范自动派发永久逻辑 ID (wf_usr_*)
    const workflowId =
      record.id && record.id.trim()
        ? record.id.trim()
        : source === 'user'
          ? `wf_usr_${Math.random().toString(36).substring(2, 10)}${Date.now().toString(36).slice(-4)}`
          : `wf_${Math.random().toString(36).substring(2, 10)}`

    // 提取统一同构 workspace_config
    let workspaceConfigStr =
      typeof record.workspace_config === 'string'
        ? record.workspace_config
        : record.workspace_config
          ? JSON.stringify(record.workspace_config)
          : ''
    if (!workspaceConfigStr) {
      const rawConfig = (record as any).workspaceConfig || {}
      const baseAi =
        rawConfig.baseAIConfig ||
        rawConfig.derivedSnapshot ||
        (typeof record.engine_params_json === 'string' ? JSON.parse(record.engine_params_json) : {})
      workspaceConfigStr = JSON.stringify({
        schemaVersion: 1,
        status: 'ready',
        policyVersion: 1,
        workflowId,
        customIgnoreRules:
          rawConfig.customIgnoreRules ||
          ((record as any).filter_mode === 'blacklist'
            ? JSON.parse(record.filter_rules || '[]')
            : []),
        customWhitelistRules:
          rawConfig.customWhitelistRules ||
          ((record as any).filter_mode === 'whitelist'
            ? JSON.parse(record.filter_rules || '[]')
            : []),
        baseAIConfig: baseAi,
        derivedSnapshot: baseAi,
        advancedAIPrompts: rawConfig.advancedAIPrompts || undefined,
        unitRecognition: rawConfig.unitRecognition || undefined,
        namingPattern: record.naming_pattern || rawConfig.namingPattern || undefined,
        namingTemplate: record.naming_template || rawConfig.namingTemplate || undefined,
        configuredAt: Date.now()
      })
    }

    const stmt = this.db.prepare(`
      INSERT INTO local_workflows (
        id, user_id, author, name, version, persona, category, summary, source,
        status, workspace_config, naming_pattern, naming_template,
        preset_directory_tree, preview_tree, icon_svg, modified_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(id) DO UPDATE SET
        author = excluded.author,
        name = excluded.name,
        version = excluded.version,
        persona = excluded.persona,
        category = excluded.category,
        summary = excluded.summary,
        status = excluded.status,
        workspace_config = excluded.workspace_config,
        naming_pattern = excluded.naming_pattern,
        naming_template = excluded.naming_template,
        preset_directory_tree = excluded.preset_directory_tree,
        preview_tree = excluded.preview_tree,
        icon_svg = excluded.icon_svg,
        modified_at = CASE
          WHEN (
            local_workflows.name IS NOT excluded.name OR
            local_workflows.version IS NOT excluded.version OR
            local_workflows.persona IS NOT excluded.persona OR
            local_workflows.category IS NOT excluded.category OR
            local_workflows.summary IS NOT excluded.summary OR
            local_workflows.author IS NOT excluded.author OR
            local_workflows.status IS NOT excluded.status OR
            local_workflows.workspace_config IS NOT excluded.workspace_config OR
            local_workflows.naming_pattern IS NOT excluded.naming_pattern OR
            local_workflows.naming_template IS NOT excluded.naming_template OR
            local_workflows.preset_directory_tree IS NOT excluded.preset_directory_tree OR
            local_workflows.preview_tree IS NOT excluded.preview_tree OR
            local_workflows.icon_svg IS NOT excluded.icon_svg
          ) THEN CURRENT_TIMESTAMP
          ELSE local_workflows.modified_at
        END
      WHERE (excluded.source = 'official' AND local_workflows.source = 'official' AND local_workflows.user_id IS NULL)
         OR (excluded.source != 'official')
    `)

    const presetDirectoryTreeStr =
      typeof record.preset_directory_tree === 'string'
        ? record.preset_directory_tree
        : record.preset_directory_tree
          ? JSON.stringify(record.preset_directory_tree)
          : null
    const previewTreeStr =
      typeof record.preview_tree === 'string'
        ? record.preview_tree
        : record.preview_tree
          ? JSON.stringify(record.preview_tree)
          : null

    const result = stmt.run(
      workflowId,
      userId,
      author,
      record.name,
      record.version ?? '1.0.0',
      record.persona,
      category,
      record.summary ?? null,
      source,
      status,
      workspaceConfigStr,
      record.naming_pattern ?? null,
      record.naming_template ?? null,
      presetDirectoryTreeStr,
      previewTreeStr,
      record.icon_svg ?? null
    )

    return result.changes > 0
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM local_workflows WHERE id = ?').run(id)
    return result.changes > 0
  }

  async listAll(): Promise<LocalWorkflowRecord[]> {
    return this.getAll()
  }

  async findById(id: string): Promise<LocalWorkflowRecord | null> {
    return this.getById(id) ?? null
  }

  async createWorkflow(
    record: Omit<LocalWorkflowRecord, 'created_at' | 'modified_at'>
  ): Promise<void> {
    this.upsert(record)
  }

  async updateWorkflow(id: string, updates: Partial<LocalWorkflowRecord>): Promise<void> {
    const existing = await this.findById(id)
    if (!existing) {
      throw new Error(`未找到工作流: ${id}`)
    }
    const merged = { ...existing, ...updates }
    this.upsert({
      id,
      user_id: merged.user_id,
      author: merged.author,
      name: merged.name,
      version: merged.version,
      persona: merged.persona,
      category: merged.category,
      summary: merged.summary,
      source: merged.source,
      status: merged.status,
      workspace_config: merged.workspace_config,
      naming_pattern: merged.naming_pattern,
      naming_template: merged.naming_template,
      preset_directory_tree: merged.preset_directory_tree,
      preview_tree: merged.preview_tree,
      icon_svg: merged.icon_svg
    })
  }

  async deleteWorkflow(id: string): Promise<void> {
    this.delete(id)
  }
}

/**
 * 向量代际管理 DAO
 */
export class EmbeddingEpochDao implements IEmbeddingEpochDAO {
  constructor(private db: Database) {}

  findServingEpochSync(): EmbeddingEpochRecord | null {
    const row = this.db
      .prepare("SELECT * FROM embedding_epochs WHERE status = 'serving' LIMIT 1")
      .get() as EmbeddingEpochRecord | undefined
    return row ?? null
  }

  findBuildingEpochSync(): EmbeddingEpochRecord | null {
    const row = this.db
      .prepare("SELECT * FROM embedding_epochs WHERE status = 'building' LIMIT 1")
      .get() as EmbeddingEpochRecord | undefined
    return row ?? null
  }

  createEpochSync(epoch: Omit<EmbeddingEpochRecord, 'created_at'>): EmbeddingEpochRecord {
    const now = Date.now()
    const stmt = this.db.prepare(`
      INSERT INTO embedding_epochs (epoch, module_id, text_dim, image_dim, status, created_at, reindex_cursor)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    stmt.run(
      epoch.epoch,
      epoch.module_id,
      epoch.text_dim,
      epoch.image_dim,
      epoch.status,
      now,
      epoch.reindex_cursor ?? null
    )
    return {
      ...epoch,
      created_at: now,
      reindex_cursor: epoch.reindex_cursor ?? null
    }
  }

  flipEpochSync(oldEpoch: number, newEpoch: number): void {
    const tx = this.db.transaction(() => {
      if (oldEpoch > 0) {
        this.db
          .prepare("UPDATE embedding_epochs SET status = 'retired' WHERE epoch = ?")
          .run(oldEpoch)
      }
      this.db
        .prepare("UPDATE embedding_epochs SET status = 'serving' WHERE epoch = ?")
        .run(newEpoch)
    })
    tx.immediate()
  }

  cancelBuildingEpochsSync(): void {
    this.db
      .prepare("UPDATE embedding_epochs SET status = 'cancelled' WHERE status = 'building'")
      .run()
  }

  updateCursorSync(epoch: number, cursorJson: string): void {
    this.db
      .prepare('UPDATE embedding_epochs SET reindex_cursor = ? WHERE epoch = ?')
      .run(cursorJson, epoch)
  }
}

/**
 * 模块化资源数据访问聚合门面
 */
export class ModularResourceDao {
  public modules: BuiltinModuleDao
  public resources: ResourceDownloadDao
  public workflows: LocalWorkflowDao
  public epochs: EmbeddingEpochDao

  constructor(private db: Database) {
    this.modules = new BuiltinModuleDao(db)
    this.resources = new ResourceDownloadDao(db)
    this.workflows = new LocalWorkflowDao(db)
    this.epochs = new EmbeddingEpochDao(db)
  }
}

let defaultModularResourceDao: ModularResourceDao | null = null

export function getModularResourceDao(customDb?: Database): ModularResourceDao {
  if (customDb) {
    return new ModularResourceDao(customDb)
  }
  if (!defaultModularResourceDao) {
    try {
      const { databaseService } = require('../database-service')
      if (databaseService?.db) {
        defaultModularResourceDao = new ModularResourceDao(databaseService.db)
      }
    } catch {}
  }
  return defaultModularResourceDao!
}
