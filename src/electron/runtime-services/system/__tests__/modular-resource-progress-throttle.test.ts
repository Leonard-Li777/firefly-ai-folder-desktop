/**
 * Issue 04 收尾：下载进度 WAL 写盘节流专项单测
 *
 * 覆盖：
 *  1. 首次进度立即落盘；3000ms 内高频回调只更新内存 liveProgress，不写 DB
 *  2. 满 3000ms 且字节有变化才再次落盘
 *  3. 状态跃迁（flushProgress）立即落盘，不受节流限制
 *  4. 乱序进度回调取已落盘/待落盘最大值，禁止进度回退
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { ModularResourceService } from '../modular-resource-service'
import { ResourceDownloadDao } from '../../database/dao/modular-resource-dao'

describe('Issue 04 收尾：下载进度 WAL 节流', () => {
  let db: Database.Database
  let service: ModularResourceService
  let persistSpy: ReturnType<typeof vi.spyOn>

  const report = (bytes: number, pct: number) =>
    (service as any).recordDownloadProgress('mod-1', 'res-1', bytes, pct, 100, false)

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-19T10:00:00Z'))
    db = new Database(':memory:')
    service = new ModularResourceService({ db })
    persistSpy = vi
      .spyOn(ResourceDownloadDao.prototype, 'updateProgressSync')
      .mockImplementation(() => {})
  })

  afterEach(() => {
    persistSpy.mockRestore()
    db.close()
    vi.useRealTimers()
  })

  it('1. 首次立即落盘；3000ms 内高频回调只更内存，不写 DB', () => {
    report(100, 1)
    expect(persistSpy).toHaveBeenCalledTimes(1)
    expect(persistSpy).toHaveBeenLastCalledWith('res-1', 100, 'downloading', undefined)

    for (let i = 0; i < 29; i++) {
      vi.advanceTimersByTime(100)
      report(100 + (i + 1) * 10, 2 + i)
    }
    expect(persistSpy).toHaveBeenCalledTimes(1)
    expect((service as any).liveProgress.get('mod-1').percentage).toBe(30)
  })

  it('2. 距上次落盘满 3000ms 且字节有变化才再次落盘', () => {
    report(100, 1)
    vi.advanceTimersByTime(3100)
    report(1200, 12)
    expect(persistSpy).toHaveBeenCalledTimes(2)
    expect(persistSpy).toHaveBeenLastCalledWith('res-1', 1200, 'downloading', undefined)
  })

  it('3. 状态跃迁立即落盘，不受 3000ms 节流限制', () => {
    report(500, 5)
    vi.advanceTimersByTime(50)
    service.flushProgress('res-1', 'paused', 500)
    expect(persistSpy).toHaveBeenCalledTimes(2)
    expect(persistSpy).toHaveBeenLastCalledWith('res-1', 500, 'paused', undefined)
    expect((service as any).lastPersistedDownloadState.get('res-1')).toBe('paused')
  })

  it('4. 乱序回调不回退已落盘字节', () => {
    report(1000, 10)
    vi.advanceTimersByTime(3100)
    report(600, 8)
    expect(persistSpy).toHaveBeenLastCalledWith('res-1', 1000, 'downloading', undefined)
    expect((service as any).liveProgress.get('mod-1').percentage).toBe(10)
  })

  it('5. 满 3000ms 但字节未变不重复写盘', () => {
    report(100, 1)
    vi.advanceTimersByTime(3100)
    report(100, 1)
    expect(persistSpy).toHaveBeenCalledTimes(1)
  })

  it('6. 终态后迟到分块回调不把状态覆盖回 downloading', () => {
    report(500, 5)
    service.flushProgress('res-1', 'failed', 500, 'boom')
    expect(persistSpy).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(4000)
    report(800, 8)
    expect(persistSpy).toHaveBeenCalledTimes(2)
    expect(persistSpy).toHaveBeenLastCalledWith('res-1', 500, 'failed', 'boom')
  })
})
