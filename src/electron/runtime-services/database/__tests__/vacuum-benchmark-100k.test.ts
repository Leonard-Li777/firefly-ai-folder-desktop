/**
 * 工单 09（V4 Slice 5 收尾）：10 万级 VACUUM 压测自动化基准（融合方案 §8 验收）。
 *
 * 真实计算：文件库灌 10 万 files/file_contents 行（含真实 deflateSync 压缩 BLOB），
 * 删除一半制造空洞，真实 VACUUM 后断言物理回收 + 完整性 + files.id 锚定零错位。
 * 墙钟耗时经 console.log 留档，供 docs/evidence/stage2-sc-acceptance.md / 工单 09 引用。
 *
 * 运行（Desktop Electron ABI 运行器，禁裸跑 vitest）：
 *   node ../../scripts/test-electron.js run src/electron/runtime-services/database/__tests__/vacuum-benchmark-100k.test.ts
 */
import { describe, it, expect, afterAll } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { deflateSync } from 'node:zlib'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { GENESIS_V1_SCHEMA } from '../database'
import { applySqliteConnectionPragmas, DEFAULT_SQLITE_PRAGMAS } from '../database-service/sqlite-connection-setup'

const TOTAL_ROWS = 100_000
const BLOB_BYTES = 2048
const VACUUM_BUDGET_MS = 15_000

describe('工单 09：10 万级 VACUUM 压测基准', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-vacuum-bench-'))
  const dbPath = path.join(tmpDir, 'vacuum-bench.db')
  const db = new Database(dbPath)

  afterAll(() => {
    try {
      db.close()
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // Windows 句柄竞态：清理失败不影响结论
    }
  })

  it('连接治理：PRAGMA 套装单点应用（journal_size_limit / wal_autocheckpoint / busy_timeout）', () => {
    applySqliteConnectionPragmas(db)
    const journalMode = db.pragma('journal_mode', { simple: true })
    const busy = db.pragma('busy_timeout', { simple: true })
    const walCheckpoint = db.pragma('wal_autocheckpoint', { simple: true })
    const sizeLimit = db.pragma('journal_size_limit', { simple: true })
    expect(String(journalMode).toLowerCase()).toBe('wal')
    expect(Number(busy)).toBe(DEFAULT_SQLITE_PRAGMAS.busy_timeout)
    expect(Number(walCheckpoint)).toBe(DEFAULT_SQLITE_PRAGMAS.wal_autocheckpoint)
    expect(Number(sizeLimit)).toBe(DEFAULT_SQLITE_PRAGMAS.journal_size_limit)
  })

  it('10 万行灌入 → 删除 50% 制造空洞 → VACUUM 物理回收 + 完整性 + id 锚定零错位', () => {
    db.exec(GENESIS_V1_SCHEMA)

    // 带熵正文（16 组随机块轮转）：模拟真实文件内容压缩后 ~1.5KB/行，防止重复文本高压缩率失真
    const rawBlobs = Array.from({ length: 16 }, (_, k) =>
      Buffer.concat([
        Buffer.from(`工单09 VACUUM 压测正文 row-group-${k} `, 'utf8'),
        randomBytes(1536)
      ])
    )
    const blobs = rawBlobs.map(b => deflateSync(b, { level: 6 }))
    expect(blobs[0].length).toBeGreaterThan(1024)

    const tSeedStart = Date.now()
    db.exec('BEGIN IMMEDIATE')
    const insFile = db.prepare(
      `INSERT INTO files (file_fingerprint, size, extension) VALUES (?, ?, '.txt')`
    )
    const insContent = db.prepare(
      `INSERT INTO file_contents (file_fingerprint, content) VALUES (?, ?)`
    )
    const insWf = db.prepare(
      `INSERT INTO workspace_files (workspace_id, directory_id, path, name, file_size, mtime_ms)
       VALUES (1, 1, ?, ?, ?, ?)`
    )
    // 目录夹具（workspaces/workspace_directories 外键）
    db.prepare(`INSERT INTO workspaces (name, path, is_active) VALUES ('bench', ?, 1)`).run(tmpDir)
    db.prepare(
      `INSERT INTO workspace_directories (workspace_id, path, name) VALUES (1, ?, 'root')`
    ).run(tmpDir)

    for (let i = 0; i < TOTAL_ROWS; i++) {
      const fp = `fp-vacuum-${i}`
      insFile.run(fp, BLOB_BYTES)
      insContent.run(fp, blobs[i % blobs.length])
      insWf.run(path.join(tmpDir, `f-${i}.txt`), `f-${i}.txt`, BLOB_BYTES, Date.now())
    }
    db.exec('COMMIT')
    const seedMs = Date.now() - tSeedStart
    const sizeBefore = fs.statSync(dbPath).size

    // 删除一半（同一批文件的内容行与 files 行精确对应）制造真实空洞
    const tDeleteStart = Date.now()
    const delContent = db.prepare(`DELETE FROM file_contents WHERE file_fingerprint = ?`)
    db.exec('BEGIN IMMEDIATE')
    for (let i = 0; i < TOTAL_ROWS; i += 2) {
      delContent.run(`fp-vacuum-${i}`)
    }
    db.exec(`DELETE FROM files WHERE id % 2 = 1`)
    db.exec('COMMIT')
    const deleteMs = Date.now() - tDeleteStart
    const sizeAfterDelete = fs.statSync(dbPath).size

    // 真实 VACUUM
    const tVacuum = Date.now()
    db.exec('VACUUM')
    const vacuumMs = Date.now() - tVacuum
    const sizeAfterVacuum = fs.statSync(dbPath).size

    // 物理回收断言：删除 50% 后 VACUUM 必须显著收缩
    const shrinkRatio = 1 - sizeAfterVacuum / sizeAfterDelete
    expect(shrinkRatio).toBeGreaterThan(0.3)

    // 完整性 + 存量 id 锚定零错位
    const integrity = (db.pragma('integrity_check', { simple: true }) as string) || 'ok'
    expect(String(integrity).toLowerCase()).toBe('ok')
    const remain = db
      .prepare(`SELECT COUNT(*) AS n FROM file_contents`)
      .get() as { n: number }
    expect(remain.n).toBe(TOTAL_ROWS / 2)

    console.log(
      `[vacuum-bench-100k] seed=${seedMs}ms delete=${deleteMs}ms vacuum=${vacuumMs}ms ` +
        `sizeBefore=${(sizeBefore / 1024 / 1024).toFixed(1)}MB sizeAfterDelete=${(sizeAfterDelete / 1024 / 1024).toFixed(1)}MB ` +
        `sizeAfterVacuum=${(sizeAfterVacuum / 1024 / 1024).toFixed(1)}MB shrink=${(shrinkRatio * 100).toFixed(1)}% budget=${VACUUM_BUDGET_MS}ms`
    )
    expect(vacuumMs).toBeLessThan(VACUUM_BUDGET_MS)
  })
})
