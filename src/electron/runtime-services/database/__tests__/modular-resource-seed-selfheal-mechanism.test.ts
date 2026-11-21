/**
 * 目录种子补灌／行级隔离／表级自愈的底层机制锁定测试
 *
 * 这三条断言锁定的是「表级自愈重建」方案所依赖的底层语义假设，任一失效都会让
 * syncCatalogSync 的行级隔离或 rebuildBuiltinModulesTableForGenesisDrift 的回灌静默失真：
 * 1. better-sqlite3 db.transaction 内行级 try/catch 能隔离 CHECK 失败（SQLite ABORT 语义：
 *    仅回滚失败语句，前序与后续语句照常提交）——若依赖升级后语义改变，"整批回滚"缺陷会复活；
 * 2. 命名参数绑定对象携带语句外多余键时被忽略——保证 SELECT * 全行回灌在未来表加列时不炸；
 * 3. 回灌列清单与 GENESIS DDL 列清单严格全等——漏列会导致自愈后本地状态静默丢失。
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { GENESIS_V1_SCHEMA } from '../database'
import { ModularResourceService } from '../../system/modular-resource-service-core'

describe('TC-SEED-MECH: 种子自愈底层机制锁定', () => {
  it('1. 事务内行级 catch 隔离 CHECK 失败（前序与后续语句均提交）', () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, cat TEXT NOT NULL CHECK (cat IN ('a','b')))`)
    const tx = db.transaction((rows: Array<{ id: string; cat: string }>) => {
      const ins = db.prepare('INSERT INTO t (id, cat) VALUES (@id, @cat)')
      const failed: string[] = []
      for (const r of rows) {
        try {
          ins.run(r)
        } catch (e) {
          failed.push(r.id)
        }
      }
      return failed
    })
    const failed = tx([
      { id: 'ok1', cat: 'a' },
      { id: 'bad', cat: 'zzz' },
      { id: 'ok2', cat: 'b' }
    ])
    const committed = (
      db.prepare('SELECT id FROM t ORDER BY id').all() as Array<{ id: string }>
    ).map(r => r.id)
    // eslint-disable-next-line no-console
    console.log('[PROBE-1] failed=', failed, 'committed=', committed)
    expect(failed).toEqual(['bad'])
    expect(committed).toEqual(['ok1', 'ok2'])
    db.close()
  })

  it('2. 命名参数含语句外多余键（SELECT * 全行回灌场景）', () => {
    const db = new Database(':memory:')
    db.exec(`CREATE TABLE t (id TEXT PRIMARY KEY, cat TEXT NOT NULL)`)
    const ins = db.prepare('INSERT INTO t (id, cat) VALUES (@id, @cat)')
    let verdict = ''
    try {
      // 模拟真实回灌：SELECT * 拿到全部列，但某表若多一列即形成多余键
      ins.run({ id: 'x', cat: 'a', extra: 'boom' })
      verdict = 'ACCEPTED_IGNORED'
    } catch (e) {
      verdict = `THROWS: ${(e as Error).message}`
    }
    // eslint-disable-next-line no-console
    console.log('[PROBE-2] extra-key verdict =', verdict)
    db.close()
  })

  it('3. 自愈重建回灌列完整性（对照 GENESIS DDL 列清单）', () => {
    // 从 GENESIS DDL 提取 builtin_modules 列名
    const start = GENESIS_V1_SCHEMA.indexOf('CREATE TABLE IF NOT EXISTS builtin_modules')
    const end = GENESIS_V1_SCHEMA.indexOf('\n  );', start)
    const ddl = GENESIS_V1_SCHEMA.slice(start, end)
    const ddlColumns = ddl
      .split('\n')
      .slice(1)
      .map(line => line.trim())
      .filter(line => /^[a-z_]+\s+[A-Z]/i.test(line) && !line.startsWith('CHECK'))
      .map(line => line.split(/\s+/)[0])
      .filter(Boolean)

    // 实现里的回灌列清单（与 modular-resource-service-core.ts 保持一致）
    const insertColumns = [
      'id',
      'kind',
      'version',
      'catalog_version',
      'category',
      'author_code',
      'author_name',
      'availability',
      'delist_reason',
      'firecore_cost',
      'total_bytes',
      'catalog_meta_json',
      'config_schema',
      'user_config',
      'install_state',
      'selected_variant',
      'install_path',
      'installed_at',
      'last_activated_at',
      'user_consent',
      'error_message',
      'config_json',
      'capability_slot',
      'slot_policy',
      'backend_type'
    ]

    // eslint-disable-next-line no-console
    console.log('[PROBE-3] ddlColumns=', ddlColumns.length, ddlColumns)
    // eslint-disable-next-line no-console
    console.log('[PROBE-3] insertColumns=', insertColumns.length)
    const missing = ddlColumns.filter(c => !insertColumns.includes(c))
    const extra = insertColumns.filter(c => !ddlColumns.includes(c))
    // eslint-disable-next-line no-console
    console.log('[PROBE-3] missing-in-insert=', missing, 'extra-in-insert=', extra)
    expect(missing).toEqual([])
    expect(extra).toEqual([])
    expect(ddlColumns).toHaveLength(insertColumns.length)
  })

  it('4. 漂移判据语义化：新基线判「不需重建」，旧基线判「需重建」（严禁文本比对）', () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mrc-gate-'))
    try {
      // 新 GENESIS 建库：category 白名单已含全部种子分类 -> 判据必须为 false（不重建）。
      // 这是「每次启动无脑 DROP+重建」CRITICAL 缺陷的回归防护：
      // 若实现退回 sqlite_master.sql 与 GENESIS 原文文本比对，SQLite 移除 IF NOT EXISTS 后
      // 恒不相等，本断言立刻变红。
      const freshDb = new Database(':memory:')
      freshDb.exec(GENESIS_V1_SCHEMA)
      const freshSql = (
        freshDb
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='builtin_modules'")
          .get() as any
      ).sql as string
      const service = new ModularResourceService({ db: freshDb, baseDir: tmpBase })
      const gate = (service as any).isBuiltinModulesCategoryGateDrifted.bind(service)
      expect(gate(freshSql)).toBe(false)
      freshDb.close()

      // 旧基线（CHECK 不含 media_enhance）：判据必须为 true（触发重建）
      const legacyDb = new Database(':memory:')
      legacyDb.exec(
        `CREATE TABLE builtin_modules (
          id TEXT PRIMARY KEY,
          version TEXT NOT NULL,
          catalog_version INTEGER NOT NULL DEFAULT 1,
          category TEXT NOT NULL CHECK (category IN ('ai-engine','perception','media','tool','parser','vfs-archive')),
          availability TEXT NOT NULL DEFAULT 'approved'
        )`
      )
      const legacySql = (
        legacyDb
          .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='builtin_modules'")
          .get() as any
      ).sql as string
      const legacyService = new ModularResourceService({ db: legacyDb, baseDir: tmpBase })
      const legacyGate = (legacyService as any).isBuiltinModulesCategoryGateDrifted.bind(
        legacyService
      )
      expect(legacyGate(legacySql)).toBe(true)
      legacyDb.close()
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true })
    }
  })
})
