/**
 * Issue 04 Step 1：两阶段孤儿指纹 GC 对账专项单测
 *
 * 覆盖：
 *  1. 阶段一：orphan_gc_queue 中的指纹（无 workspace_files 引用、不在途）→ 单事务删 files + 写 outbox + 移除 queue
 *  2. [R2-2a] 在途分析指纹跳过（保留队列不删）
 *  3. 阶段二：vector_delete_outbox 中 pending 行 → 二次校验 NOT EXISTS files → 调 Omni 成功后删行
 *  4. 阶段二 Omni 离线（deleteVectors 返回 null）→ 保留 outbox 待重启自愈
 *  5. 阶段二二次校验：files 仍存在 → 不调 Omni，保留 outbox
 *
 * 设计：注入真实 GENESIS_V1_SCHEMA + 真实 FileCleanupService（含 SQL 在途判定），
 * mock omni-client 验证阶段二行为；FileCleanupService 构造只依赖 Database.Database。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'

vi.mock('electron', () => {
  const m = {
    app: { getPath: vi.fn(() => 'C:\\test'), getName: vi.fn(() => 'firefly'), isPackaged: false },
    ipcMain: { handle: vi.fn() },
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
    shell: { showItemInFolder: vi.fn() }
  }
  return { ...m, default: m }
})
vi.mock('electron-conf', () => ({
  Conf: class {
    get() {
      return {}
    }
    set() {}
  }
}))
vi.mock('../../config/config-db-manager', () => ({
  ConfigDbManager: class {
    getValue() {
      return null
    }
    setValue() {}
    getDimensionNameBlacklist() {
      return []
    }
  }
}))

// mock omni-client：可控制 deleteVectors 返回值
const mockDeleteVectors = vi.fn()
vi.mock('../../../services/omni-client', () => ({
  omniClient: { deleteVectors: (...args: any[]) => mockDeleteVectors(...args) }
}))

import { GENESIS_V1_SCHEMA, registerDatabaseFunctions } from '../database'
import { FileCleanupService } from '../../filesystem/file-cleanup-service'

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  db.exec(GENESIS_V1_SCHEMA)
  registerDatabaseFunctions(db)
  db.exec(`INSERT INTO workspaces (workspace_id, name, path) VALUES (1, 'ws', 'C:/root')`)
  db.exec(
    `INSERT INTO workspace_directories (id, workspace_id, path, name) VALUES (10, 1, 'C:/root/dir', 'dir')`
  )
  return db
}

/** 直接插 orphan_gc_queue 模拟触发器入队结果 */
function enqueueOrphan(db: Database.Database, fp: string) {
  db.prepare(
    `INSERT OR IGNORE INTO orphan_gc_queue (file_fingerprint, enqueued_at) VALUES (?, ?)`
  ).run(fp, Date.now())
}

/** 插 files + workspace_files（建立有效引用） */
function insertFileWithRef(db: Database.Database, fp: string, wfId: number, path: string) {
  db.prepare(
    `INSERT INTO files (file_fingerprint, id, extension, size) VALUES (?, ?, '.txt', 100)`
  ).run(fp, 9000 + wfId)
  db.prepare(
    `INSERT INTO workspace_files (id, workspace_id, directory_id, path, name, file_fingerprint, status)
              VALUES (?, 1, 10, ?, ?, ?, 1)`
  ).run(wfId, path, path.split('/').pop(), fp)
}

describe('Issue 04 Step 1：两阶段孤儿指纹 GC 对账', () => {
  let db: Database.Database
  let cleanup: FileCleanupService

  beforeEach(() => {
    db = makeDb()
    cleanup = new FileCleanupService(db)
    mockDeleteVectors.mockReset()
    mockDeleteVectors.mockResolvedValue({ success: true, deletedCount: 0 })
  })

  afterEach(() => {
    db.close()
  })

  it('1. 阶段一：零引用非在途指纹 → 删 files + 写 outbox + 移除 queue', async () => {
    // 指纹 fp-orphan：仅存在于 orphan_gc_queue，files 中有对应行（需先建 files 再删 wf 触发）
    db.prepare(
      `INSERT INTO files (file_fingerprint, id, extension) VALUES ('fp-orphan', 1, '.bin')`
    ).run()
    enqueueOrphan(db, 'fp-orphan')

    const res = await cleanup.reconcileOrphanFingerprints({ runVectorPhase: false })
    expect(res.checked).toBe(1)
    expect(res.deletedFiles).toBe(1)

    // files 已删
    const filesLeft = db
      .prepare(`SELECT COUNT(*) c FROM files WHERE file_fingerprint = 'fp-orphan'`)
      .get() as any
    expect(filesLeft.c).toBe(0)
    // queue 已移除
    const queueLeft = db.prepare(`SELECT COUNT(*) c FROM orphan_gc_queue`).get() as any
    expect(queueLeft.c).toBe(0)
    // outbox 已写入
    const outbox = db
      .prepare(`SELECT * FROM vector_delete_outbox WHERE file_fingerprint = 'fp-orphan'`)
      .get() as any
    expect(outbox).toBeTruthy()
    expect(outbox.state).toBe('pending')
  })

  it('2. [R2-2a] 在途分析指纹跳过，保留队列', async () => {
    // 指纹 fp-inflight：files + workspace_files 有效引用，且对应 analysis_queue 项在途
    insertFileWithRef(db, 'fp-inflight', 20, 'C:/root/dir/inflight.bin')
    db.prepare(
      `INSERT INTO analysis_queue (item_id, item_type, status) VALUES (20, 'file', 'analyzing')`
    ).run()
    enqueueOrphan(db, 'fp-inflight')

    const res = await cleanup.reconcileOrphanFingerprints({ runVectorPhase: false })
    expect(res.checked).toBe(1)
    expect(res.skippedInFlight).toBe(1)
    expect(res.deletedFiles).toBe(0)
    // files 未删
    const filesLeft = db
      .prepare(`SELECT COUNT(*) c FROM files WHERE file_fingerprint = 'fp-inflight'`)
      .get() as any
    expect(filesLeft.c).toBe(1)
    // queue 保留
    const queueLeft = db.prepare(`SELECT COUNT(*) c FROM orphan_gc_queue`).get() as any
    expect(queueLeft.c).toBe(1)
  })

  it('3. 阶段二：outbox pending + files 已不存在 → 调 Omni 成功后删行', async () => {
    db.prepare(
      `INSERT INTO vector_delete_outbox (file_fingerprint, state, retry_count, enqueued_at)
                VALUES ('fp-deleted', 'pending', 0, 1)`
    ).run()
    // 不插入 files 行（已删）
    mockDeleteVectors.mockResolvedValue({ success: true, deletedCount: 1 })

    const res = await cleanup.reconcileOrphanFingerprints({ runVectorPhase: true })
    expect(res.vectorsDeleted).toBe(1)
    expect(mockDeleteVectors).toHaveBeenCalledWith(['fp-deleted'])
    const outboxLeft = db.prepare(`SELECT COUNT(*) c FROM vector_delete_outbox`).get() as any
    expect(outboxLeft.c).toBe(0)
  })

  it('4. 阶段二 Omni 离线（deleteVectors 返回 null）→ 保留 outbox', async () => {
    db.prepare(
      `INSERT INTO vector_delete_outbox (file_fingerprint, state, retry_count, enqueued_at)
                VALUES ('fp-offline', 'pending', 0, 1)`
    ).run()
    mockDeleteVectors.mockResolvedValue(null) // Omni 离线

    const res = await cleanup.reconcileOrphanFingerprints({ runVectorPhase: true })
    expect(res.vectorsPending).toBe(1)
    // outbox 保留，retry_count 递增
    const row = db
      .prepare(`SELECT * FROM vector_delete_outbox WHERE file_fingerprint = 'fp-offline'`)
      .get() as any
    expect(row).toBeTruthy()
    expect(row.retry_count).toBe(1)
    expect(row.state).toBe('pending')
  })

  it('5. 阶段二二次校验：files 仍存在 → 不调 Omni，保留 outbox', async () => {
    // files 中仍有 fp-still-exists 对应行
    db.prepare(
      `INSERT INTO files (file_fingerprint, id, extension) VALUES ('fp-still-exists', 3, '.bin')`
    ).run()
    db.prepare(
      `INSERT INTO vector_delete_outbox (file_fingerprint, state, retry_count, enqueued_at)
                VALUES ('fp-still-exists', 'pending', 0, 1)`
    ).run()

    const res = await cleanup.reconcileOrphanFingerprints({ runVectorPhase: true })
    expect(res.vectorsDeleted).toBe(0)
    expect(mockDeleteVectors).not.toHaveBeenCalled()
    // outbox 保留（不递增 retry，因未尝试删除）
    const row = db
      .prepare(
        `SELECT retry_count FROM vector_delete_outbox WHERE file_fingerprint = 'fp-still-exists'`
      )
      .get() as any
    expect(row.retry_count).toBe(0)
  })

  it('6. 触发器集成：删 wf 后触发器入队 + 对账清理 → files 真删 + outbox 写入', async () => {
    // 建完整引用链（helper 内建 files + workspace_files），然后直接删 wf 触发入队
    insertFileWithRef(db, 'fp-integ', 30, 'C:/root/dir/integ.bin')

    db.prepare(`DELETE FROM workspace_files WHERE id = 30`).run()
    // 触发器应已入队
    const queued = db
      .prepare(`SELECT COUNT(*) c FROM orphan_gc_queue WHERE file_fingerprint = 'fp-integ'`)
      .get() as any
    expect(queued.c).toBe(1)

    // 对账阶段一（无在途）
    const res = await cleanup.reconcileOrphanFingerprints({ runVectorPhase: false })
    expect(res.deletedFiles).toBe(1)
    // files 已删
    const filesLeft = db
      .prepare(`SELECT COUNT(*) c FROM files WHERE file_fingerprint = 'fp-integ'`)
      .get() as any
    expect(filesLeft.c).toBe(0)
  })
})
