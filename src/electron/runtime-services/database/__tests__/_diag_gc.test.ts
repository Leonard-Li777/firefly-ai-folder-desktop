import { describe, it, vi } from 'vitest'
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

import { GENESIS_V1_SCHEMA, registerDatabaseFunctions } from '../database'

describe('DIAG GC 触发器', () => {
  it('DDL + 三触发器行为', () => {
    const db = new Database(':memory:')
    db.exec(GENESIS_V1_SCHEMA)
    registerDatabaseFunctions(db)

    console.log(
      'GC tables:',
      JSON.stringify(
        db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('orphan_gc_queue','vector_delete_outbox')`
          )
          .all()
      )
    )
    console.log(
      'GC triggers:',
      JSON.stringify(
        db
          .prepare(
            `SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_wf_%' ORDER BY name`
          )
          .all()
      )
    )

    db.exec(`INSERT INTO workspaces (workspace_id, name, path) VALUES (1, 'ws', 'C:/root')`)
    db.exec(
      `INSERT INTO workspace_directories (id, workspace_id, path, name) VALUES (10, 1, 'C:/root/dir', 'dir')`
    )
    // NULL 指纹删除 → 不入队
    db.exec(
      `INSERT INTO workspace_files (id, workspace_id, directory_id, path, name, status) VALUES (1, 1, 10, 'C:/root/dir/a.txt', 'a.txt', 1)`
    )
    db.exec(`DELETE FROM workspace_files WHERE id = 1`)
    console.log(
      'NULL-fp delete queue count (expect 0):',
      db.prepare(`SELECT COUNT(*) c FROM orphan_gc_queue`).get().c
    )
    // 指纹非空删除 → 入队
    db.exec(`INSERT INTO files (file_fingerprint, id, extension) VALUES ('fp1', 100, '.txt')`)
    db.exec(
      `INSERT INTO workspace_files (id, workspace_id, directory_id, path, name, file_fingerprint, status) VALUES (2, 1, 10, 'C:/root/dir/b.txt', 'b.txt', 'fp1', 1)`
    )
    db.exec(`DELETE FROM workspace_files WHERE id = 2`)
    console.log(
      'fp1 delete queue (expect fp1):',
      JSON.stringify(db.prepare(`SELECT * FROM orphan_gc_queue`).all())
    )
    // 反向出队：reinsert → 撤回 queue + outbox
    db.exec(`INSERT INTO vector_delete_outbox (file_fingerprint, enqueued_at) VALUES ('fp1', 1)`)
    db.exec(
      `INSERT INTO workspace_files (id, workspace_id, directory_id, path, name, file_fingerprint, status) VALUES (3, 1, 10, 'C:/root/dir/b.txt', 'b.txt', 'fp1', 1)`
    )
    console.log(
      'after reinsert queue count (expect 0):',
      db.prepare(`SELECT COUNT(*) c FROM orphan_gc_queue`).get().c
    )
    console.log(
      'after reinsert outbox count (expect 0):',
      db.prepare(`SELECT COUNT(*) c FROM vector_delete_outbox`).get().c
    )
    db.close()
  })
})
