/**
 * Issue 04 收尾：两阶段整理接入 fs_operation_journal + FileSystemMutationDao 专项单测
 *
 * 覆盖：
 *  1. 成功路径：物理移动 + DAO 单事务路径改写 + journal committed 同事务闭环
 *  2. 失败路径：commitDb 抛错 → 物理逆向补偿 + journal compensated（可崩溃重放）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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
import { TwoPhaseBatchCoordinator } from '../../filesystem/fs-journal-recovery'
import { FileSystemMutationDao } from '../dao/file-system-mutation-dao'

describe('Issue 04 收尾：两阶段整理 journal + DAO 闭环', () => {
  let db: Database.Database
  let tmpDir: string
  let src: string
  let dest: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-two-phase-'))
    src = path.join(tmpDir, 'a.txt')
    dest = path.join(tmpDir, 'organized', 'a.txt')
    fs.writeFileSync(src, 'hello two phase')
    db = new Database(':memory:')
    db.exec(GENESIS_V1_SCHEMA)
    registerDatabaseFunctions(db)
    db.prepare(`INSERT INTO workspaces (workspace_id, name, path) VALUES (1, 'ws', ?)`).run(tmpDir)
    db.prepare(
      `INSERT INTO workspace_directories (id, workspace_id, path, name) VALUES (10, 1, ?, 'root')`
    ).run(tmpDir)
    db.prepare(
      `INSERT INTO files (file_fingerprint, id, extension, size) VALUES ('fp-a', 1, '.txt', 15)`
    ).run()
    db.prepare(
      `INSERT INTO workspace_files (id, workspace_id, directory_id, path, name, file_fingerprint, status)
       VALUES (1, 1, 10, ?, 'a.txt', 'fp-a', 1)`
    ).run(src)
  })

  afterEach(() => {
    db.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('成功：物理移动 + DAO 路径改写 + journal committed 闭环', async () => {
    const coordinator = new TwoPhaseBatchCoordinator(db)
    const dao = new FileSystemMutationDao(db)

    const res = await coordinator.executeTwoPhaseBatch(
      'batch_ok',
      [{ id: 'batch_ok-1', fromPath: src, toPath: dest, fileIdentity: 'sample', op: 'move' }],
      {
        commitDb: item => {
          dao.updateFilePathAtomic(item.fromPath, item.toPath, 12345)
        }
      }
    )

    expect(res.success).toBe(true)
    expect(fs.existsSync(dest)).toBe(true)
    expect(fs.existsSync(src)).toBe(false)

    const wf = db
      .prepare('SELECT path, name, mtime_ms FROM workspace_files WHERE id = 1')
      .get() as any
    expect(wf.path).toBe(dest)
    expect(wf.name).toBe('a.txt')
    expect(wf.mtime_ms).toBe(12345)

    const journal = db
      .prepare(`SELECT id, status FROM fs_operation_journal WHERE batch_id = 'batch_ok'`)
      .get() as any
    expect(journal.id).toBe('batch_ok-1')
    expect(journal.status).toBe('committed')
  })

  it('失败：commitDb 抛错 → 物理逆向补偿 + journal compensated', async () => {
    const coordinator = new TwoPhaseBatchCoordinator(db)

    const res = await coordinator.executeTwoPhaseBatch(
      'batch_fail',
      [{ id: '1', fromPath: src, toPath: dest, fileIdentity: 'sample', op: 'move' }],
      {
        commitDb: () => {
          throw new Error('注入的 DB 提交失败')
        }
      }
    )

    expect(res.success).toBe(false)
    expect(fs.existsSync(src)).toBe(true)
    expect(fs.existsSync(dest)).toBe(false)

    const wf = db.prepare('SELECT path FROM workspace_files WHERE id = 1').get() as any
    expect(wf.path).toBe(src)

    const journal = db
      .prepare(`SELECT status, error_code FROM fs_operation_journal WHERE batch_id = 'batch_fail'`)
      .get() as any
    expect(journal.status).toBe('compensated')
  })

  it('3. 权威路径改写未落库(updated=0) → 抛错触发物理补偿', async () => {
    // 删掉 workspace_files 旧路径行，令 DAO 返回 updated:0（静默降级口）
    db.prepare('DELETE FROM workspace_files WHERE id = 1').run()
    const coordinator = new TwoPhaseBatchCoordinator(db)
    const dao = new FileSystemMutationDao(db)

    const res = await coordinator.executeTwoPhaseBatch(
      'batch_zero',
      [{ id: 'batch_zero-1', fromPath: src, toPath: dest, fileIdentity: 'sample', op: 'move' }],
      {
        commitDb: item => {
          const mutation = dao.updateFilePathAtomic(item.fromPath, item.toPath)
          if (mutation.updated === 0) {
            throw new Error('权威路径改写未落库，拒绝提交 journal')
          }
        }
      }
    )

    expect(res.success).toBe(false)
    expect(fs.existsSync(src)).toBe(true)
    expect(fs.existsSync(dest)).toBe(false)
    const journal = db
      .prepare(`SELECT status FROM fs_operation_journal WHERE batch_id = 'batch_zero'`)
      .get() as any
    expect(journal.status).toBe('compensated')
  })
})
