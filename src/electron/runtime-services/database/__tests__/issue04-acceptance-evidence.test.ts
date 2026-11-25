/**
 * Ticket 14（C5 + C8）：Issue 04 退出时序 R2-8 与视频分段/逻辑单元索引 EXPLAIN 验收单测
 *
 * 覆盖：
 *  - C5：退出时序 R2-8 严格按 4 步执行：
 *        busy_timeout = 1500 → PRAGMA optimize → wal_checkpoint(PASSIVE) → close()；
 *        同时校验 main/index.ts 中 window-all-closed 不提前关库、before-quit 先停 Omni 再 checkpoint 再 close。
 *  - C8-1：HybridSearchArbiter 视频分段检索 SQL（WHERE file_fingerprint IN (...) AND start_sec < ?）
 *          EXPLAIN QUERY PLAN 命中 idx_fvc_fp_start Index Scan（零全表扫），且边界过滤结果正确。
 *  - C8-2：TagUnitDao 逻辑单元正向关联查询（JOIN file_unit_relations r ON r.unit_id = u.id WHERE r.file_id = ?）
 *          EXPLAIN QUERY PLAN 两表均走索引（主键覆盖索引 + INTEGER PRIMARY KEY），零全表扫。
 *  - C8-3（Ticket 17）：GENESIS_V1_SCHEMA 建库后 sqlite_master 含 idx_file_units_ws / idx_file_units_path /
 *          idx_fur_unit_id，且反向关联查询（WHERE r.unit_id = ?）、按 path / workspace_id 查 file_units
 *          的 EXPLAIN QUERY PLAN 均走 SEARCH ... USING INDEX，零全表扫。
 */
import * as fs from 'fs'
import * as path from 'path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'

vi.mock('electron', () => {
  const electronMock = {
    app: {
      getPath: vi.fn(() => 'C:\\test'),
      getName: vi.fn(() => 'firefly'),
      isPackaged: false
    },
    ipcMain: { handle: vi.fn() },
    BrowserWindow: { getAllWindows: vi.fn(() => []) },
    shell: { showItemInFolder: vi.fn() }
  }
  return { ...electronMock, default: electronMock }
})

vi.mock('electron-conf', () => ({
  Conf: class {
    get() {
      return {}
    }
    set() {}
  }
}))

// 打断 DAO ↔ database-service 的循环 import 链（使用 @runtime 标准别名，遵循 testing-guide.md §4）
vi.mock('@runtime/database/database-service', () => ({
  databaseService: {},
  DatabaseService: class {}
}))

// 打断 config-db-manager ↔ database-service ↔ query-proxy 循环 import
vi.mock('@runtime/config/config-db-manager', () => ({
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

import { GENESIS_V1_SCHEMA, registerDatabaseFunctions } from '@runtime/database/database'
import { DatabaseQueryProxyMixin } from '@runtime/database/database-service/query-proxy'
import { TagUnitDao } from '@runtime/database/dao/tag-unit-dao'

describe('Ticket 14 · C5：Issue 04 退出时序 R2-8 显式验证', () => {
  let proxy: any
  let db: Database.Database

  beforeEach(() => {
    proxy = new DatabaseQueryProxyMixin('') as any
    db = new Database(':memory:')
    db.exec(GENESIS_V1_SCHEMA)
    registerDatabaseFunctions(db)
    proxy._db = db
  })

  afterEach(() => {
    if (db && db.open) {
      db.close()
    }
  })

  it('C5-1. checkpointBeforeClose + close 严格按 4 步顺序执行：busy_timeout=1500 → optimize → wal_checkpoint(PASSIVE) → close', async () => {
    // 真实接线：直调生产 DatabaseQueryProxyMixin.checkpointBeforeClose() 与 close()
    const sequence: string[] = []
    const origPragma = db.pragma.bind(db)
    const origClose = db.close.bind(db)

    const pragmaSpy = vi.spyOn(db, 'pragma').mockImplementation(((sql: string, options?: any) => {
      sequence.push(`pragma:${sql}`)
      return origPragma(sql, options)
    }) as any)

    const closeSpy = vi.spyOn(db, 'close').mockImplementation((() => {
      sequence.push('close')
      return origClose()
    }) as any)

    await proxy.checkpointBeforeClose()
    await proxy.close()

    expect(sequence).toEqual([
      'pragma:busy_timeout = 1500',
      'pragma:optimize',
      'pragma:wal_checkpoint(PASSIVE)',
      'close'
    ])
    expect(proxy._db).toBeNull()
    expect(db.open).toBe(false)

    pragmaSpy.mockRestore()
    closeSpy.mockRestore()
  })

  it('C5-2. checkpointBeforeClose 遇到 PRAGMA 异常时非致命放行，不阻断后续关库', async () => {
    const sequence: string[] = []
    const origClose = db.close.bind(db)

    const pragmaSpy = vi.spyOn(db, 'pragma').mockImplementation(((sql: string) => {
      sequence.push(`pragma:${sql}`)
      if (sql === 'wal_checkpoint(PASSIVE)') {
        throw new Error('SQLITE_BUSY: database is locked')
      }
      return []
    }) as any)

    const closeSpy = vi.spyOn(db, 'close').mockImplementation((() => {
      sequence.push('close')
      return origClose()
    }) as any)

    await expect(proxy.checkpointBeforeClose()).resolves.toBeUndefined()
    await proxy.close()

    expect(sequence).toEqual([
      'pragma:busy_timeout = 1500',
      'pragma:optimize',
      'pragma:wal_checkpoint(PASSIVE)',
      'close'
    ])
    expect(db.open).toBe(false)

    pragmaSpy.mockRestore()
    closeSpy.mockRestore()
  })

  it('C5-3. main/index.ts 退出编排接线：window-all-closed 禁提前关库，before-quit 严格先停 Omni → checkpointBeforeClose → close → app.exit', () => {
    const mainIndexPath = path.resolve(__dirname, '../../../main/index.ts')
    const source = fs.readFileSync(mainIndexPath, 'utf-8')
    const stripLineComments = (block: string) => block.replace(/\/\/.*$/gm, '')

    // 提取 window-all-closed 块（剥离行注释后断言无 databaseService.close()）
    const wacMatch = source.match(/app\.on\('window-all-closed'[\s\S]*?\r?\n\}\)/)
    expect(wacMatch).not.toBeNull()
    expect(stripLineComments(wacMatch![0])).not.toContain('databaseService.close()')

    // 提取完整 before-quit 块（剥离行注释，避免魔法长度截断与注释串误匹配）
    const bqMatch = source.match(/app\.on\('before-quit'[\s\S]*?\r?\n\}\)/)
    expect(bqMatch).not.toBeNull()
    const bqBlock = stripLineComments(bqMatch![0])

    const preventIdx = bqBlock.indexOf('event.preventDefault()')
    const omniStopIdx = bqBlock.indexOf('await omniService.stop()')
    const checkpointIdx = bqBlock.indexOf('await databaseService.checkpointBeforeClose()')
    const closeIdx = bqBlock.indexOf('databaseService.close()')
    const exitAfterCloseIdx = bqBlock.indexOf('app.exit(', closeIdx)

    expect(preventIdx).toBeGreaterThan(-1)
    expect(omniStopIdx).toBeGreaterThan(preventIdx)
    expect(checkpointIdx).toBeGreaterThan(omniStopIdx)
    expect(closeIdx).toBeGreaterThan(checkpointIdx)
    expect(exitAfterCloseIdx).toBeGreaterThan(closeIdx)
  })
})

describe('Ticket 14 · C8：video 分段检索 idx_fvc_fp_start 与 file_unit_relations 索引 EXPLAIN 验证', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(GENESIS_V1_SCHEMA)
    registerDatabaseFunctions(db)

    // 铺设基础外键依赖：files / workspaces / workspace_directories / workspace_files
    db.prepare(
      `INSERT INTO files (file_fingerprint, extension, file_group) VALUES ('fp_vid_1', '.mp4', 'video')`
    ).run()
    db.prepare(
      `INSERT INTO files (file_fingerprint, extension, file_group) VALUES ('fp_vid_2', '.mp4', 'video')`
    ).run()
    db.prepare(
      `INSERT INTO workspaces (workspace_id, name, path) VALUES (1, 'ws', 'C:/root')`
    ).run()
    db.prepare(
      `INSERT INTO workspace_directories (id, workspace_id, path, name) VALUES (10, 1, 'C:/root/vids', 'vids')`
    ).run()
    db.prepare(
      `INSERT INTO workspace_files (id, workspace_id, directory_id, path, name, file_fingerprint, status)
       VALUES (100, 1, 10, 'C:/root/vids/demo.mp4', 'demo.mp4', 'fp_vid_1', 1)`
    ).run()

    // 插入多段视频切片（含超出 300s 权益上限的切片，验证 start_sec < videoLimitSec 下推）
    const insertChunk = db.prepare(
      `INSERT INTO file_video_chunks (file_fingerprint, chunk_index, start_sec, end_sec, rep_pts_sec, meta)
       VALUES (?, ?, ?, ?, ?, '{}')`
    )
    insertChunk.run('fp_vid_1', 0, 0, 10, 5)
    insertChunk.run('fp_vid_1', 1, 120, 130, 125)
    insertChunk.run('fp_vid_1', 2, 360, 370, 365)
    insertChunk.run('fp_vid_2', 0, 30, 40, 35)
    insertChunk.run('fp_vid_2', 1, 400, 410, 405)
  })

  afterEach(() => {
    if (db && db.open) {
      db.close()
    }
  })

  it('C8-1. HybridSearchArbiter 视频分段检索 SQL EXPLAIN 命中 idx_fvc_fp_start Covering Index 且权益截断生效', () => {
    // 复刻 HybridSearchArbiter.ts 生产 SQL（去 meta 零回表）
    const sql = `
      SELECT file_fingerprint, chunk_index, start_sec, end_sec, COALESCE(rep_pts_sec, start_sec) AS rep_pts_sec
      FROM file_video_chunks
      WHERE file_fingerprint IN (?, ?) AND start_sec < ?
    `

    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('fp_vid_1', 'fp_vid_2', 300) as Array<{
      detail: string
    }>
    const detail = plan.map(p => p.detail).join(' | ')

    // 关键断言：命中 idx_fvc_fp_start 5 列覆盖索引，严禁回表或全表 SCAN
    expect(detail).toContain('idx_fvc_fp_start')
    expect(detail).toMatch(/SEARCH\s+file_video_chunks\s+USING\s+COVERING\s+INDEX\s+idx_fvc_fp_start/)
    expect(detail).not.toMatch(/SCAN\s+file_video_chunks/)

    // 行为断言：仅返回 start_sec < 300 的切片（共 3 条，剔除 360s 与 400s）
    const rows = db.prepare(sql).all('fp_vid_1', 'fp_vid_2', 300) as Array<{
      file_fingerprint: string
      chunk_index: number
      start_sec: number
    }>
    expect(rows).toHaveLength(3)
    expect(rows.every(r => r.start_sec < 300)).toBe(true)
  })

  it('C8-2. TagUnitDao r.unit_id = u.id 关联查询 EXPLAIN 全部走索引（零全表扫）且返回正确逻辑单元', async () => {
    const dao = new TagUnitDao(db)
    const unit = await dao.createUnit({
      name: 'demo-unit',
      type: 'folder',
      path: 'C:/root/vids',
      workspaceId: 1
    })
    await dao.createFileUnitRelation(100, unit.id)

    // 正向查询（TagUnitDao.getUnitsForFile:118-120 生产 SQL）：r.unit_id = u.id 关联
    const forwardSql = `
      SELECT u.* FROM file_units u
      JOIN file_unit_relations r ON r.unit_id = u.id
      WHERE r.file_id = ?
    `
    const forwardPlan = db.prepare(`EXPLAIN QUERY PLAN ${forwardSql}`).all(100) as Array<{
      detail: string
    }>
    const forwardDetail = forwardPlan.map(p => p.detail).join(' | ')

    // 关键断言：两表均为 SEARCH（r 走主键覆盖索引、u 走 INTEGER PRIMARY KEY），零全表 SCAN
    expect(forwardDetail).toMatch(/SEARCH\s+r\s+USING\s+(?:COVERING\s+)?INDEX/)
    expect(forwardDetail).toMatch(/SEARCH\s+u\s+USING\s+INTEGER\s+PRIMARY\s+KEY/)
    expect(forwardDetail).not.toMatch(/\bSCAN\b/)

    // 直调生产方法 TagUnitDao.getUnitsForFile 验证返回结果正确
    const units = await dao.getUnitsForFile(100)
    expect(units).toHaveLength(1)
    expect(units[0].id).toBe(unit.id)
    expect(units[0].name).toBe('demo-unit')
  })

  it('C8-3（Ticket 17）. GENESIS_V1_SCHEMA 包含 3 个逻辑单元治理索引且反向关联 / path / workspace_id 查询均走索引', async () => {
    // 1. 校验 sqlite_master 存在 3 个索引
    const idxRows = db
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name IN ('idx_file_units_ws', 'idx_file_units_path', 'idx_fur_unit_id')`
      )
      .all() as Array<{ name: string }>
    const idxNames = idxRows.map(r => r.name).sort()
    expect(idxNames).toEqual(['idx_file_units_path', 'idx_file_units_ws', 'idx_fur_unit_id'])

    const dao = new TagUnitDao(db)
    const unit = await dao.createUnit({
      name: 'demo-unit',
      type: 'folder',
      path: 'C:/root/vids',
      workspaceId: 1
    })
    await dao.createFileUnitRelation(100, unit.id)

    // 2. 反向关联查询（WHERE r.unit_id = ?）命中 idx_fur_unit_id，零全表 SCAN
    const reverseSql = `
      SELECT wf.id FROM workspace_files wf
      JOIN file_unit_relations r ON r.file_id = wf.id
      WHERE r.unit_id = ?
    `
    const reversePlan = db.prepare(`EXPLAIN QUERY PLAN ${reverseSql}`).all(unit.id) as Array<{
      detail: string
    }>
    const reverseDetail = reversePlan.map(p => p.detail).join(' | ')
    expect(reverseDetail).toMatch(/SEARCH\s+r\s+USING\s+(?:COVERING\s+)?INDEX\s+idx_fur_unit_id/)
    expect(reverseDetail).toMatch(/SEARCH\s+wf\s+USING\s+INTEGER\s+PRIMARY\s+KEY/)
    expect(reverseDetail).not.toMatch(/\bSCAN\b/)

    const reverseRows = db.prepare(reverseSql).all(unit.id) as Array<{ id: number }>
    expect(reverseRows).toEqual([{ id: 100 }])

    // 3. 按 path 查询 file_units（TagUnitDao.getUnitsForPath:159 生产 SQL）命中 idx_file_units_path
    const byPathSql = `SELECT * FROM file_units WHERE path = ?`
    const byPathPlan = db.prepare(`EXPLAIN QUERY PLAN ${byPathSql}`).all('C:/root/vids') as Array<{
      detail: string
    }>
    const byPathDetail = byPathPlan.map(p => p.detail).join(' | ')
    expect(byPathDetail).toMatch(/SEARCH\s+file_units\s+USING\s+INDEX\s+idx_file_units_path/)
    expect(byPathDetail).not.toMatch(/\bSCAN\b/)

    const unitsByPath = await dao.getUnitsForPath('C:/root/vids/new-file.mp4')
    expect(unitsByPath).toHaveLength(1)
    expect(unitsByPath[0].id).toBe(unit.id)

    // 4. 按 workspace_id 查询 file_units 命中 idx_file_units_ws
    const byWsSql = `SELECT * FROM file_units WHERE workspace_id = ?`
    const byWsPlan = db.prepare(`EXPLAIN QUERY PLAN ${byWsSql}`).all(1) as Array<{ detail: string }>
    const byWsDetail = byWsPlan.map(p => p.detail).join(' | ')
    expect(byWsDetail).toMatch(/SEARCH\s+file_units\s+USING\s+INDEX\s+idx_file_units_ws/)
    expect(byWsDetail).not.toMatch(/\bSCAN\b/)

    const unitsByWs = db.prepare(byWsSql).all(1) as Array<{ id: number }>
    expect(unitsByWs).toHaveLength(1)
    expect(unitsByWs[0].id).toBe(unit.id)
  })
})
