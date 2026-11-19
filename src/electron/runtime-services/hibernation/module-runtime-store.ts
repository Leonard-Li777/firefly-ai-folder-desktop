import type Database from 'better-sqlite3'
import { logger, LogCategory } from '@firefly/shared'
import {
  HIBERNATABLE_TARGET_CATALOG,
  type ModuleHibernationState,
  type ModuleRuntimeState,
  type ProcessTreeIdentity,
  type ModuleRuntimeSnapshotRecord
} from './types'

export interface IModuleRuntimeStore {
  init(db?: Database.Database | null): void
  get(targetId: string): ModuleRuntimeState
  getAll(): ModuleRuntimeState[]
  setState(targetId: string, state: ModuleHibernationState): void
  setError(targetId: string, kind: 'load' | 'unload', message?: string): void
  setUnloadFailStreak(targetId: string, value: number): void
  setResidentBytes(targetId: string, bytes: number): void
  setEffectiveMemoryKind(targetId: string, kind: 'ram' | 'vram'): void
  clearError(targetId: string): void
  setLastReleasedBytes(targetId: string, bytes: number): void
  updateBlockedUnloadCache(targetId: string, blocked: boolean): void
  persistBlockedUnloadGate(
    targetId: string,
    blocked: 0 | 1,
    identity: ProcessTreeIdentity | null
  ): Promise<void>
  persistSnapshot(targetId: string): Promise<void>
  isBlockedUnload(targetId: string): boolean
  update(targetId: string, apply: (draft: ModuleRuntimeState) => void): boolean
  resetForTesting(): void
}

export class ModuleRuntimeStore implements IModuleRuntimeStore {
  private db: Database.Database | null = null
  private readonly states = new Map<string, ModuleRuntimeState>()

  constructor() {
    this.initDefaultStates()
  }

  private initDefaultStates(): void {
    for (const [targetId, meta] of Object.entries(HIBERNATABLE_TARGET_CATALOG)) {
      this.states.set(targetId, {
        id: targetId,
        clusterId: meta.clusterId,
        modelGeneration: 0,
        defaultMemoryKind: meta.defaultMemoryKind,
        effectiveMemoryKind: meta.defaultMemoryKind,
        i18nNameKey: meta.i18nNameKey,
        state: 'hibernated',
        residentBytes: 0,
        lastActiveTimestamp: Date.now(),
        crashStreak: 0,
        unloadFailStreak: 0,
        blockedUnloadNoHandle: 0,
        blockedUnloadIdentity: null
      })
    }
  }

  public init(db?: Database.Database | null): void {
    this.db = db ?? null
    this.initDefaultStates()

    if (!this.db) return

    try {
      const rows = this.db
        .prepare('SELECT * FROM module_runtime_snapshots')
        .all() as ModuleRuntimeSnapshotRecord[]

      for (const row of rows) {
        const state = this.get(row.target_id)
        const validStates: ModuleHibernationState[] = [
          'resident',
          'loading',
          'hibernated',
          'draining',
          'error'
        ]
        state.state = validStates.includes(row.state as ModuleHibernationState)
          ? (row.state as ModuleHibernationState)
          : 'hibernated'
        state.modelGeneration = row.model_generation
        state.residentBytes = row.resident_bytes
        state.lastReleasedBytes = row.last_released_bytes ?? undefined
        state.crashStreak = row.crash_streak
        state.unloadFailStreak = row.unload_fail_streak
        state.blockedUnloadNoHandle = row.blocked_unload_no_handle === 1 ? 1 : 0
        if (row.blocked_unload_identity) {
          try {
            state.blockedUnloadIdentity = JSON.parse(row.blocked_unload_identity)
          } catch {
            state.blockedUnloadIdentity = null
          }
        } else {
          state.blockedUnloadIdentity = null
        }
      }
    } catch (err) {
      logger.error(
        LogCategory.DATABASE_SERVICE,
        'Failed to load module runtime snapshots from SQLite, applying conservative lockdown:',
        err
      )
      // 保守阻断不变量：读取失败时对所有模块施加门闩保护，坚决禁止乐观放行
      for (const state of this.states.values()) {
        state.blockedUnloadNoHandle = 1
      }
    }
  }

  public get(targetId: string): ModuleRuntimeState {
    const state = this.states.get(targetId)
    if (!state) {
      const meta = HIBERNATABLE_TARGET_CATALOG[targetId]
      const freshState: ModuleRuntimeState = {
        id: targetId,
        clusterId: meta?.clusterId ?? 'analysis_suite',
        modelGeneration: 0,
        defaultMemoryKind: meta?.defaultMemoryKind ?? 'ram',
        effectiveMemoryKind: meta?.defaultMemoryKind ?? 'ram',
        i18nNameKey: meta?.i18nNameKey ?? targetId,
        state: 'hibernated',
        residentBytes: 0,
        lastActiveTimestamp: Date.now(),
        crashStreak: 0,
        unloadFailStreak: 0,
        blockedUnloadNoHandle: 0,
        blockedUnloadIdentity: null
      }
      this.states.set(targetId, freshState)
      return freshState
    }
    return state
  }

  public getAll(): ModuleRuntimeState[] {
    return Array.from(this.states.values())
  }

  public setState(targetId: string, state: ModuleHibernationState): void {
    const entry = this.get(targetId)
    entry.state = state
    entry.lastActiveTimestamp = Date.now()
    if (state === 'hibernated') {
      entry.residentBytes = 0
      entry.residentSample = undefined
    }
  }

  public setError(targetId: string, kind: 'load' | 'unload', message?: string): void {
    const entry = this.get(targetId)
    entry.state = 'error'
    entry.lastFailureKind = kind
    entry.errorPhase = kind
    entry.errorMessage = message
    entry.lastActiveTimestamp = Date.now()
  }

  public setUnloadFailStreak(targetId: string, value: number): void {
    const entry = this.get(targetId)
    entry.unloadFailStreak = value
  }

  public setResidentBytes(targetId: string, bytes: number): void {
    const entry = this.get(targetId)
    entry.residentBytes = Math.max(0, bytes)
  }

  public setEffectiveMemoryKind(targetId: string, kind: 'ram' | 'vram'): void {
    const entry = this.get(targetId)
    entry.effectiveMemoryKind = kind
  }

  public clearError(targetId: string): void {
    const entry = this.get(targetId)
    // 严格不变量：仅清除错误辅助字段，严禁修改 state, crashStreak, unloadFailStreak, residentBytes 或 lastReleasedBytes
    entry.lastFailureKind = undefined
    entry.errorPhase = undefined
    entry.errorMessage = undefined
    entry.lastErrorI18nKey = undefined
  }

  public setLastReleasedBytes(targetId: string, bytes: number): void {
    const entry = this.get(targetId)
    entry.lastReleasedBytes = bytes
  }

  public updateBlockedUnloadCache(targetId: string, blocked: boolean): void {
    const entry = this.get(targetId)
    entry.blockedUnloadNoHandle = blocked ? 1 : 0
    if (!blocked) {
      entry.blockedUnloadIdentity = null
    }
  }

  public async persistBlockedUnloadGate(
    targetId: string,
    blocked: 0 | 1,
    identity: ProcessTreeIdentity | null
  ): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized for persistBlockedUnloadGate')
    }

    const nowMs = Date.now()
    const identityJson = identity ? JSON.stringify(identity) : null
    const stmt = this.db.prepare(`
      INSERT INTO module_runtime_snapshots (
        target_id, state, blocked_unload_no_handle, blocked_unload_identity, updated_at_ms
      ) VALUES (?, 'hibernated', ?, ?, ?)
      ON CONFLICT(target_id) DO UPDATE SET
        blocked_unload_no_handle = excluded.blocked_unload_no_handle,
        blocked_unload_identity = excluded.blocked_unload_identity,
        updated_at_ms = excluded.updated_at_ms
    `)
    stmt.run(targetId, blocked, identityJson, nowMs)

    // SQLite 事务成功后，方才同步更新内存缓存（SSOT 对称原则）
    const entry = this.get(targetId)
    entry.blockedUnloadNoHandle = blocked
    entry.blockedUnloadIdentity = identity
  }

  public async persistSnapshot(targetId: string): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized for persistSnapshot')
    }
    const entry = this.get(targetId)
    const identityJson = entry.blockedUnloadIdentity
      ? JSON.stringify(entry.blockedUnloadIdentity)
      : null

    const stmt = this.db.prepare(`
      INSERT INTO module_runtime_snapshots (
        target_id, state, model_generation, resident_bytes, last_released_bytes,
        crash_streak, unload_fail_streak, blocked_unload_no_handle, blocked_unload_identity, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(target_id) DO UPDATE SET
        state = excluded.state,
        model_generation = excluded.model_generation,
        resident_bytes = excluded.resident_bytes,
        last_released_bytes = excluded.last_released_bytes,
        crash_streak = excluded.crash_streak,
        unload_fail_streak = excluded.unload_fail_streak,
        blocked_unload_no_handle = excluded.blocked_unload_no_handle,
        blocked_unload_identity = excluded.blocked_unload_identity,
        updated_at_ms = excluded.updated_at_ms
    `)

    stmt.run(
      targetId,
      entry.state,
      entry.modelGeneration,
      entry.residentBytes,
      entry.lastReleasedBytes ?? null,
      entry.crashStreak,
      entry.unloadFailStreak,
      entry.blockedUnloadNoHandle,
      identityJson,
      Date.now()
    )
  }

  public isBlockedUnload(targetId: string): boolean {
    const entry = this.get(targetId)
    return entry.blockedUnloadNoHandle === 1
  }

  public update(targetId: string, apply: (draft: ModuleRuntimeState) => void): boolean {
    const current = this.states.get(targetId)
    if (!current) return false
    apply(current)
    return true
  }

  public resetForTesting(): void {
    this.states.clear()
    this.initDefaultStates()
    this.db = null
  }
}

/** 单例导出 */
export const moduleRuntimeStore: IModuleRuntimeStore = new ModuleRuntimeStore()

/** 全局自由函数包装 (一等便捷入口) */
export const getModuleRuntime = (id: string): ModuleRuntimeState => moduleRuntimeStore.get(id)
export const persistBlockedUnloadGate = (
  targetId: string,
  blocked: 0 | 1,
  identity: ProcessTreeIdentity | null
): Promise<void> => moduleRuntimeStore.persistBlockedUnloadGate(targetId, blocked, identity)
