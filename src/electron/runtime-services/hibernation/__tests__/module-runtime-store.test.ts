import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { GENESIS_V1_SCHEMA } from '../../database/database'
import {
  ModuleRuntimeStore,
  moduleRuntimeStore,
  getModuleRuntime,
  persistBlockedUnloadGate
} from '../module-runtime-store'
import { HIBERNATABLE_TARGET_CATALOG } from '../types'

describe('ModuleRuntimeStore (Ticket 01)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    // 执行 GENESIS_V1_SCHEMA 创世脚本
    db.exec(GENESIS_V1_SCHEMA)
    moduleRuntimeStore.resetForTesting()
  })

  it('应该能正确初始化目录中声明的 5 个纳管模块默认状态', () => {
    const store = new ModuleRuntimeStore()
    store.init(db)

    const all = store.getAll()
    expect(all).toHaveLength(Object.keys(HIBERNATABLE_TARGET_CATALOG).length)

    const pocketCpu = store.get('pocket-cpu-int8-onnx')
    expect(pocketCpu.state).toBe('hibernated')
    expect(pocketCpu.residentBytes).toBe(0)
    expect(pocketCpu.crashStreak).toBe(0)
    expect(pocketCpu.blockedUnloadNoHandle).toBe(0)
    expect(pocketCpu.blockedUnloadIdentity).toBeNull()

    const llm = store.get('firefly-ai-engine')
    expect(llm.clusterId).toBe('analysis_suite')
    expect(llm.defaultMemoryKind).toBe('vram')
  })

  it('状态变更为 hibernated 时物理驻留必须归零 (SSOT 不变量)', () => {
    const store = new ModuleRuntimeStore()
    store.init(db)

    store.setState('tts-m5-onnx', 'resident')
    store.setResidentBytes('tts-m5-onnx', 315 * 1024 * 1024)
    expect(store.get('tts-m5-onnx').residentBytes).toBe(315 * 1024 * 1024)

    store.setState('tts-m5-onnx', 'hibernated')
    expect(store.get('tts-m5-onnx').residentBytes).toBe(0)
    expect(store.get('tts-m5-onnx').residentSample).toBeUndefined()
  })

  it('clearError 仅清除错误辅助字段，严禁修改 state 或统计指标', () => {
    const store = new ModuleRuntimeStore()
    store.init(db)

    store.setError('asr-sensevoice-onnx', 'load', '模型加载超时')
    store.setUnloadFailStreak('asr-sensevoice-onnx', 2)
    store.setResidentBytes('asr-sensevoice-onnx', 100)

    const entryBefore = store.get('asr-sensevoice-onnx')
    expect(entryBefore.state).toBe('error')
    expect(entryBefore.lastFailureKind).toBe('load')
    expect(entryBefore.errorMessage).toBe('模型加载超时')

    store.clearError('asr-sensevoice-onnx')
    const entryAfter = store.get('asr-sensevoice-onnx')
    expect(entryAfter.state).toBe('error') // state 保持不变
    expect(entryAfter.lastFailureKind).toBeUndefined()
    expect(entryAfter.errorMessage).toBeUndefined()
    expect(entryAfter.unloadFailStreak).toBe(2)
    expect(entryAfter.residentBytes).toBe(100)
  })

  it('persistBlockedUnloadGate 应该先持久化至 SQLite，再同步内存缓存', async () => {
    const store = new ModuleRuntimeStore()
    store.init(db)

    const identity = {
      pid: 1234,
      startTimeMs: 1700000000000,
      generation: 1,
      treeHandle: 'Job_1234'
    }

    await store.persistBlockedUnloadGate('firefly-ai-engine', 1, identity)

    // 验证内存缓存已同步
    expect(store.get('firefly-ai-engine').blockedUnloadNoHandle).toBe(1)
    expect(store.get('firefly-ai-engine').blockedUnloadIdentity).toEqual(identity)
    expect(store.isBlockedUnload('firefly-ai-engine')).toBe(true)

    // 验证 SQLite 数据已原子写入
    const row = db
      .prepare('SELECT * FROM module_runtime_snapshots WHERE target_id = ?')
      .get('firefly-ai-engine') as any

    expect(row).toBeDefined()
    expect(row.blocked_unload_no_handle).toBe(1)
    expect(JSON.parse(row.blocked_unload_identity)).toEqual(identity)

    // 清除门闩
    await store.persistBlockedUnloadGate('firefly-ai-engine', 0, null)
    expect(store.get('firefly-ai-engine').blockedUnloadNoHandle).toBe(0)
    expect(store.get('firefly-ai-engine').blockedUnloadIdentity).toBeNull()

    const clearedRow = db
      .prepare('SELECT * FROM module_runtime_snapshots WHERE target_id = ?')
      .get('firefly-ai-engine') as any
    expect(clearedRow.blocked_unload_no_handle).toBe(0)
    expect(clearedRow.blocked_unload_identity).toBeNull()
  })

  it('SQLite 写入失败时，persistBlockedUnloadGate 拒绝更新内存缓存并抛出异常', async () => {
    const store = new ModuleRuntimeStore()
    store.init(db)

    // 破坏表结构模拟 SQLite 错误
    db.exec('DROP TABLE module_runtime_snapshots')

    const identity = {
      pid: 5678,
      startTimeMs: 1700000000000,
      generation: 2
    }

    await expect(store.persistBlockedUnloadGate('firefly-ai-engine', 1, identity)).rejects.toThrow()

    // 内存缓存必须保持不变
    expect(store.get('firefly-ai-engine').blockedUnloadNoHandle).toBe(0)
    expect(store.get('firefly-ai-engine').blockedUnloadIdentity).toBeNull()
  })

  it('应用冷启动时应从 SQLite 准确恢复快照状态与持久门闩', () => {
    // 先在数据库中预置一条已崩溃且带有持久门闩的记录
    const identity = {
      pid: 9999,
      startTimeMs: 1700000005000,
      generation: 3,
      treeHandle: 'Job_9999'
    }

    db.prepare(
      `
      INSERT INTO module_runtime_snapshots (
        target_id, state, model_generation, resident_bytes, crash_streak,
        unload_fail_streak, blocked_unload_no_handle, blocked_unload_identity
      ) VALUES (?, 'error', 3, 2048, 2, 3, 1, ?)
    `
    ).run('firefly-ai-engine', JSON.stringify(identity))

    const store = new ModuleRuntimeStore()
    store.init(db)

    const state = store.get('firefly-ai-engine')
    expect(state.state).toBe('error')
    expect(state.modelGeneration).toBe(3)
    expect(state.residentBytes).toBe(2048)
    expect(state.crashStreak).toBe(2)
    expect(state.unloadFailStreak).toBe(3)
    expect(state.blockedUnloadNoHandle).toBe(1)
    expect(state.blockedUnloadIdentity).toEqual(identity)
  })

  it('SQLite 读取抛错时必须启用保守阻断保护 (全部模块施加门闩)', () => {
    // 创建一个损坏的数据库环境（无目标表）
    const brokenDb = new Database(':memory:')

    const store = new ModuleRuntimeStore()
    store.init(brokenDb)

    // 保守阻断生效：所有模块均被标记为 blockedUnloadNoHandle = 1
    for (const mod of store.getAll()) {
      expect(mod.blockedUnloadNoHandle).toBe(1)
      expect(store.isBlockedUnload(mod.id)).toBe(true)
    }
  })

  it('persistSnapshot 应该能完整持久化快照至 SQLite 并在无 db 时报错', async () => {
    const store = new ModuleRuntimeStore()

    // 无 DB 时抛错防静默降级
    await expect(store.persistSnapshot('firefly-ai-engine')).rejects.toThrow(
      'Database not initialized'
    )

    store.init(db)
    store.setState('firefly-ai-engine', 'resident')
    store.setResidentBytes('firefly-ai-engine', 1800 * 1024 * 1024)
    store.setLastReleasedBytes('firefly-ai-engine', 1500 * 1024 * 1024)

    await store.persistSnapshot('firefly-ai-engine')

    const row = db
      .prepare('SELECT * FROM module_runtime_snapshots WHERE target_id = ?')
      .get('firefly-ai-engine') as any

    expect(row).toBeDefined()
    expect(row.state).toBe('resident')
    expect(row.resident_bytes).toBe(1800 * 1024 * 1024)
    expect(row.last_released_bytes).toBe(1500 * 1024 * 1024)
  })

  it('冷启动遇到非合法状态枚举时回落为 hibernated，遇到非 Catalog 模块也能恢复', () => {
    db.prepare(
      `
      INSERT INTO module_runtime_snapshots (
        target_id, state, model_generation, resident_bytes, crash_streak,
        unload_fail_streak, blocked_unload_no_handle, blocked_unload_identity
      ) VALUES (?, 'corrupted_state', 1, 0, 0, 0, 1, NULL)
    `
    ).run('custom-plugin-target')

    const store = new ModuleRuntimeStore()
    store.init(db)

    const customState = store.get('custom-plugin-target')
    expect(customState).toBeDefined()
    expect(customState.state).toBe('hibernated') // 回落为 hibernated
    expect(customState.blockedUnloadNoHandle).toBe(1) // 持久门闩正确恢复
  })

  it('全局自由函数包装单例正常生效', () => {
    moduleRuntimeStore.init(db)
    const runtime = getModuleRuntime('pocket-cpu-int8-onnx')
    expect(runtime.id).toBe('pocket-cpu-int8-onnx')
    expect(runtime.state).toBe('hibernated')
  })
})
