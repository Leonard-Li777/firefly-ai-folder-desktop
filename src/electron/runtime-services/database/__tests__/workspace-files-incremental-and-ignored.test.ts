/**
 * SC-5：workspace_files 增量扫描与 is_ignored 预计算过滤闭环专项单测
 *
 * 覆盖：
 *  1. 未分析文件（file_fingerprint IS NULL）二次增量扫描 0 误判（根治恒重扫 Bug）
 *  2. EXPLAIN QUERY PLAN 增量扫描查询命中 idx_wf_diff_cover 覆盖索引
 *  3. 排除规则新增/删除批刷新 is_ignored 与 TagTreeQuery 过滤联动一致性
 *
 * 设计：注入真实 DatabaseQueryProxyMixin（生产 query-proxy.ts）+ 真实 GENESIS_V1_SCHEMA，
 * 直调生产方法 getWorkspaceFilesForDiffScan / refreshWorkspaceFilesIgnoredState，测真实接线。
 * mock config-db-manager 打断 query-proxy ↔ config-db-manager 的循环 import 链（否则
 * database-service.ts extends undefined）。registerDatabaseFunctions 注册 schema 触发器
 * 依赖的 compress/decompress_text UDF。
 */
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

// 打断 DAO ↔ database-service 的循环 import 链：
// tag-unit-dao → database-service → query-proxy → (...DAO...)，
// 该环使 QueryProxy 的基类链在模块求值期解析到 undefined。
// 测试只测生产 query-proxy 的方法，故把 database-service Facade 桩掉即可断环。
vi.mock('../database-service', () => ({
  databaseService: {},
  DatabaseService: class {}
}))

// 打断循环 import：config-db-manager → database-service → query-proxy → config-db-manager
// vi.mock 路径相对于本测试文件：__tests__/ → ../database-service/query-proxy.ts 引用的
// '../../config/config-db-manager' 即 runtime-services/config/config-db-manager
vi.mock('../../config/config-db-manager', () => ({
  ConfigDbManager: class {
    constructor() {}
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
import { DatabaseQueryProxyMixin } from '../database-service/query-proxy'
import type { IIgnoreRule } from '@firefly/types/settings-types'

function makeTmpRule(): IIgnoreRule {
  return {
    id: 'test-tmp-rule',
    type: 'wildcard',
    // 注意：不得用 .tmp —— 系统默认规则 system-16（extension .tmp, isActive）会永久命中，
    // 导致「删除用户规则后回退 loadIgnoreRules()」时 b.tmp 仍被系统规则标记忽略，无法验证恢复。
    // 选用系统规则未覆盖的 .zzz 扩展名，纯净验证「用户规则新增→忽略 / 删除→恢复」闭环。
    value: '*.zzz',
    isSystem: false,
    isActive: true
  }
}

function makeProxy(): { proxy: any; db: Database.Database } {
  const proxy = new DatabaseQueryProxyMixin('') as any
  const db = new Database(':memory:')
  db.exec(GENESIS_V1_SCHEMA)
  registerDatabaseFunctions(db)
  proxy._db = db
  return { proxy, db }
}

function insertWf(
  db: Database.Database,
  opts: {
    id: number
    workspaceId: number
    directoryId: number
    path: string
    name: string
    fileFingerprint?: string | null
    fileSize?: number
    mtimeMs?: number
    isIgnored?: number
  }
) {
  db.prepare(
    `INSERT INTO workspace_files (id, workspace_id, directory_id, path, name, file_fingerprint, file_size, mtime_ms, is_ignored, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
  ).run(
    opts.id,
    opts.workspaceId,
    opts.directoryId,
    opts.path,
    opts.name,
    opts.fileFingerprint ?? null,
    opts.fileSize ?? 0,
    opts.mtimeMs ?? 0,
    opts.isIgnored ?? 0
  )
}

describe('SC-5 切片C：workspace_files 增量扫描与 is_ignored 闭环', () => {
  let proxy: any
  let db: Database.Database

  beforeEach(() => {
    const made = makeProxy()
    proxy = made.proxy
    db = made.db
    db.prepare(
      `INSERT INTO workspaces (workspace_id, name, path) VALUES (1, 'ws', 'C:/root')`
    ).run()
    db.prepare(
      `INSERT INTO workspace_directories (id, workspace_id, path, name) VALUES (10, 1, 'C:/root/dir', 'dir')`
    ).run()
  })

  afterEach(() => {
    db.close()
  })

  it('1. 未分析文件（file_fingerprint IS NULL）二次增量扫描 0 误判', async () => {
    const fileSize = 12345
    const mtimeMs = 1700000000000
    insertWf(db, {
      id: 1,
      workspaceId: 1,
      directoryId: 10,
      path: 'C:/root/dir/unanalyzed.bin',
      name: 'unanalyzed.bin',
      fileFingerprint: null,
      fileSize,
      mtimeMs
    })

    // 直调生产方法 getWorkspaceFilesForDiffScan（零 LEFT JOIN files）
    const rows = (await proxy.getWorkspaceFilesForDiffScan(1, 10)) as any[]
    expect(rows.length).toBe(1)
    const dbFile = rows[0]

    // 关键断言：预计算列有物理值，未分析文件不再因 files.size 为 NULL 而恒判变更
    expect(dbFile.file_fingerprint).toBeNull()
    expect(dbFile.file_size).toBe(fileSize)
    expect(dbFile.mtime_ms).toBe(mtimeMs)

    // 磁盘 stat 与库中预计算列一致 → 判定「未变更」（0 重扫）
    const stats = { size: fileSize, mtimeMs, mtime: new Date(mtimeMs) }
    let changed: boolean
    if (dbFile.mtime_ms === 0) {
      const timeDiff = Math.abs(new Date(dbFile.modified_at || 0).getTime() - stats.mtime.getTime())
      changed = timeDiff > 1000 || dbFile.file_size !== stats.size
    } else {
      changed =
        dbFile.file_size !== stats.size ||
        Math.abs(dbFile.mtime_ms - Math.trunc(stats.mtimeMs)) > 1000
    }
    expect(changed).toBe(false)
  })

  it('2. EXPLAIN QUERY PLAN 增量扫描命中 idx_wf_diff_cover 覆盖索引（无全表扫）', () => {
    insertWf(db, {
      id: 1,
      workspaceId: 1,
      directoryId: 10,
      path: 'C:/root/dir/a.txt',
      name: 'a.txt',
      fileSize: 100,
      mtimeMs: 1700000000000
    })

    const plan = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT id, path, name, file_fingerprint, file_size, mtime_ms, is_ignored, is_analyzed, status, modified_at
         FROM workspace_files
         WHERE workspace_id = ? AND directory_id = ? AND status = 1`
      )
      .all(1, 10) as Array<{ detail: string }>

    const detail = plan.map(p => p.detail).join(' | ')
    expect(detail).toMatch(/idx_wf_diff_cover|idx_workspace_files_dir_id/)
    expect(detail).not.toMatch(/SCAN workspace_files(?!\s+USING)/)
  })

  it('3. 排除规则新增/删除批刷新 is_ignored 与 wf.is_ignored=0 过滤联动', async () => {
    insertWf(db, {
      id: 1,
      workspaceId: 1,
      directoryId: 10,
      path: 'C:/root/dir/a.txt',
      name: 'a.txt'
    })
    insertWf(db, {
      id: 2,
      workspaceId: 1,
      directoryId: 10,
      path: 'C:/root/dir/b.zzz',
      name: 'b.zzz'
    })
    insertWf(db, {
      id: 3,
      workspaceId: 1,
      directoryId: 10,
      path: 'C:/root/dir/c.txt',
      name: 'c.txt'
    })

    // 直调生产方法 refreshWorkspaceFilesIgnoredState
    const res = await proxy.refreshWorkspaceFilesIgnoredState([makeTmpRule()])
    expect(res.totalChecked).toBe(3)
    expect(res.updatedToIgnored).toBe(1)
    expect(res.updatedToActive).toBe(0)

    const rowB = db.prepare(`SELECT is_ignored FROM workspace_files WHERE id = 2`).get() as any
    expect(rowB.is_ignored).toBe(1)

    // TagTreeQuery 过滤列（wf.is_ignored = 0）不再返回 b.tmp
    const activeRows = db
      .prepare(
        `SELECT id FROM workspace_files WHERE workspace_id = ? AND directory_id = ? AND is_ignored = 0`
      )
      .all(1, 10) as any[]
    expect(activeRows.map(r => r.id).sort()).toEqual([1, 3])

    // 删除规则后再刷新 → b.tmp 恢复 is_ignored=0
    const res2 = await proxy.refreshWorkspaceFilesIgnoredState([])
    expect(res2.updatedToActive).toBe(1)
    const rowB2 = db.prepare(`SELECT is_ignored FROM workspace_files WHERE id = 2`).get() as any
    expect(rowB2.is_ignored).toBe(0)
  })

  it('4. 批刷新无翻转时 0 写盘（幂等）', async () => {
    insertWf(db, {
      id: 1,
      workspaceId: 1,
      directoryId: 10,
      path: 'C:/root/dir/a.txt',
      name: 'a.txt'
    })
    const res = await proxy.refreshWorkspaceFilesIgnoredState([])
    expect(res.updatedToIgnored).toBe(0)
    expect(res.updatedToActive).toBe(0)
    expect(res.totalChecked).toBe(1)
  })

  it('5. >2000 行跨批边界翻转正确（BATCH_SIZE=2000 无 off-by-one）+ 三计数勾稽', async () => {
    // 让「待忽略」集合本身 > 2000，强制 runBatch 的 slice(i, i+2000) 循环真正执行 2 批，
    // 才能验证跨批边界（第 2000 行=批1末尾 / 第 2001 行=批2开头）而非单批假覆盖。
    // 铺设：id 1..2100 为 '.zzz'（规则 *.zzz 命中 → 待忽略，2100 个 > 2000 触发 2 批）；
    //       id 2101..2500 为 '.txt'（保持 is_ignored=0，400 个）。
    const zzzCount = 2100
    const totalRows = 2500

    const insertMany = db.prepare(
      `INSERT INTO workspace_files (id, workspace_id, directory_id, path, name, file_fingerprint, file_size, mtime_ms, is_ignored, status)
       VALUES (?, ?, 10, ?, ?, NULL, 0, 0, 0, 1)`
    )
    db.transaction(() => {
      for (let id = 1; id <= totalRows; id++) {
        const isZzz = id <= zzzCount
        const name = isZzz ? `f${id}.zzz` : `f${id}.txt`
        insertMany.run(id, 1, `C:/root/dir/${name}`, name)
      }
    })()

    // 全部行初始 is_ignored=0，规则命中 *.zzz → toIgnoreIds 长度 2100 > 2000 → 分 2 批写
    // ★真覆盖关键：spy 事务调用次数。仅断言最终态无法区分「真分 2 批」与「单批全量 UPDATE」——
    // 把 BATCH_SIZE 调成 >=2100 取消分批时旧断言仍全绿（已变异实测）。本断言锁死批次数：
    // 2100 行 / 2000 = 2 批 → transaction 必须恰好调用 2 次，缺批即失败。
    const txSpy = vi.spyOn(db, 'transaction')
    const res = await proxy.refreshWorkspaceFilesIgnoredState([makeTmpRule()])
    expect(txSpy).toHaveBeenCalledTimes(2)

    // 三计数勾稽：totalChecked = 全表行数；updatedToIgnored = 待忽略数(2100)；updatedToActive = 0
    expect(res.totalChecked).toBe(totalRows)
    expect(res.updatedToIgnored).toBe(zzzCount)
    expect(res.updatedToActive).toBe(0)

    // 跨批边界正确性：id=2000（第 1 批末尾，slice(0,2000) 覆盖）与 id=2001（第 2 批开头，
    // slice(2000,4000) 覆盖）都被正确翻转为 is_ignored=1，证明 slice 循环无 off-by-one
    const row2000 = db
      .prepare(`SELECT is_ignored FROM workspace_files WHERE id = 2000`)
      .get() as any
    const row2001 = db
      .prepare(`SELECT is_ignored FROM workspace_files WHERE id = 2001`)
      .get() as any
    expect(row2000.is_ignored).toBe(1)
    expect(row2001.is_ignored).toBe(1)

    // 库中实际 is_ignored=1 的行数 == 2100（无遗漏 / 无误翻转 / 分批完整）
    const ignoredCount = db
      .prepare(`SELECT COUNT(*) AS c FROM workspace_files WHERE is_ignored = 1`)
      .get() as any
    expect(ignoredCount.c).toBe(zzzCount)

    // '.txt' 行（如 id=2101）保持 is_ignored=0
    const row2101 = db
      .prepare(`SELECT is_ignored FROM workspace_files WHERE id = 2101`)
      .get() as any
    expect(row2101.is_ignored).toBe(0)

    // 二次刷新（规则删除 → 回退 loadIgnoreRules；.zzz 非任何系统默认扩展 → 视为空规则）
    // → toActiveIds 长度 2100 > 2000 → 恢复路径同样分 2 批，覆盖双向分批
    txSpy.mockClear()
    const res2 = await proxy.refreshWorkspaceFilesIgnoredState([])
    expect(txSpy).toHaveBeenCalledTimes(2) // 恢复路径也必须 2 批，杜绝单向假覆盖
    expect(res2.updatedToActive).toBe(zzzCount)
    expect(res2.updatedToIgnored).toBe(0)
    const stillIgnored = db
      .prepare(`SELECT COUNT(*) AS c FROM workspace_files WHERE is_ignored = 1`)
      .get() as any
    expect(stillIgnored.c).toBe(0)
    txSpy.mockRestore()
  })
})
