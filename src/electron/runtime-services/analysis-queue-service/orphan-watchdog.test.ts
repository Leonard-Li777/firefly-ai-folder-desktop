import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  OrphanWatchdog,
  ORPHAN_STALE_THRESHOLD_MS,
  parseSqliteTimestampMs
} from './orphan-watchdog'
import { databaseService } from '../database/database-service'

vi.mock('../database/database-service', () => ({
  databaseService: {
    db: null as any
  }
}))

vi.mock('@firefly/shared', async importOriginal => {
  const actual = await importOriginal<typeof import('@firefly/shared')>()
  return {
    ...actual,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn()
    }
  }
})

/** 将时间戳格式化为 SQLite CURRENT_TIMESTAMP 同构的 UTC 字符串（无时区后缀、空格分隔） */
function toSqliteUtcTimestamp(ms: number): string {
  const iso = new Date(ms).toISOString()
  return iso.slice(0, 19).replace('T', ' ')
}

describe('parseSqliteTimestampMs', () => {
  it('SQLite CURRENT_TIMESTAMP 格式（无时区后缀）应按 UTC 解析，不受本地时区偏移影响', () => {
    const ms = parseSqliteTimestampMs('2026-11-19 02:00:00')
    expect(ms).toBe(Date.UTC(2026, 10, 19, 2, 0, 0))
  })

  it('带 Z 或显式时区偏移的 ISO 字符串应保持原时区语义', () => {
    expect(parseSqliteTimestampMs('2026-11-19T02:00:00.000Z')).toBe(Date.UTC(2026, 10, 19, 2, 0, 0))
    expect(parseSqliteTimestampMs('2026-11-19T10:00:00+08:00')).toBe(
      Date.UTC(2026, 10, 19, 2, 0, 0)
    )
  })

  it('空串或非法时间返回 NaN', () => {
    expect(Number.isNaN(parseSqliteTimestampMs(''))).toBe(true)
    expect(Number.isNaN(parseSqliteTimestampMs('not-a-date'))).toBe(true)
  })
})

describe('OrphanWatchdog.reclaimOrphanedQueueRows', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(databaseService as any).db = null
  })

  it('刚认领（1 分钟前）的 SQLite UTC 时间戳不应被误杀，仅回收超阈值且非活跃的孤儿行，且目录项不误伤 workspace_files', () => {
    const now = Date.now()
    const freshRow = {
      id: 1,
      item_id: 101,
      item_type: 'file',
      claimed_at: toSqliteUtcTimestamp(now - 60 * 1000)
    }
    const staleActiveRow = {
      id: 2,
      item_id: 102,
      item_type: 'file',
      claimed_at: toSqliteUtcTimestamp(now - ORPHAN_STALE_THRESHOLD_MS - 5 * 60 * 1000)
    }
    const staleOrphanFileRow = {
      id: 3,
      item_id: 103,
      item_type: 'file',
      claimed_at: toSqliteUtcTimestamp(now - ORPHAN_STALE_THRESHOLD_MS - 5 * 60 * 1000)
    }
    const staleOrphanDirRow = {
      id: 4,
      item_id: 103,
      item_type: 'directory',
      claimed_at: toSqliteUtcTimestamp(now - ORPHAN_STALE_THRESHOLD_MS - 5 * 60 * 1000)
    }

    const runCalls: Array<{ sql: string; args: unknown[] }> = []
    const fakeDb = {
      prepare: (sql: string) => ({
        all: () => {
          if (sql.includes('PRAGMA table_info')) {
            return [{ name: 'id' }, { name: 'claimed_at' }]
          }
          return [freshRow, staleActiveRow, staleOrphanFileRow, staleOrphanDirRow]
        },
        run: (...args: unknown[]) => {
          runCalls.push({ sql, args })
          return { changes: 1 }
        }
      }),
      transaction: (fn: () => void) => () => fn()
    }
    ;(databaseService as any).db = fakeDb

    const onReclaimed = vi.fn()
    const watchdog = new OrphanWatchdog(itemId => itemId === staleActiveRow.id, onReclaimed)
    watchdog.reclaimOrphanedQueueRows()

    expect(onReclaimed).toHaveBeenCalledTimes(1)
    expect(onReclaimed).toHaveBeenCalledWith([staleOrphanFileRow.id, staleOrphanDirRow.id])
    const queueUpdates = runCalls.filter(c => c.sql.includes('UPDATE analysis_queue'))
    const wsUpdates = runCalls.filter(c => c.sql.includes('UPDATE workspace_files'))
    expect(queueUpdates).toHaveLength(2)
    expect(queueUpdates.map(c => c.args[0])).toEqual([staleOrphanFileRow.id, staleOrphanDirRow.id])
    // 仅文件项复位 workspace_files，目录项不误写同 ID 文件
    expect(wsUpdates).toHaveLength(1)
    expect(wsUpdates[0].args).toEqual([staleOrphanFileRow.item_id])
  })

  it('竞态下 UPDATE changes === 0（行已离开 analyzing）时不得复位 workspace_files 或触发 onReclaimed', () => {
    const now = Date.now()
    const racedRow = {
      id: 9,
      item_id: 909,
      item_type: 'file',
      claimed_at: toSqliteUtcTimestamp(now - ORPHAN_STALE_THRESHOLD_MS - 5 * 60 * 1000)
    }

    const runCalls: Array<{ sql: string; args: unknown[] }> = []
    const fakeDb = {
      prepare: (sql: string) => ({
        all: () => {
          if (sql.includes('PRAGMA table_info')) {
            return [{ name: 'id' }, { name: 'claimed_at' }]
          }
          return [racedRow]
        },
        run: (...args: unknown[]) => {
          runCalls.push({ sql, args })
          return { changes: 0 }
        }
      }),
      transaction: (fn: () => void) => () => fn()
    }
    ;(databaseService as any).db = fakeDb

    const onReclaimed = vi.fn()
    const watchdog = new OrphanWatchdog(() => false, onReclaimed)
    watchdog.reclaimOrphanedQueueRows()

    expect(onReclaimed).not.toHaveBeenCalled()
    expect(runCalls.filter(c => c.sql.includes('UPDATE workspace_files'))).toHaveLength(0)
  })
})
