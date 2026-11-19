import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { queueFtsSync, flushFtsSync, getPendingFtsSyncCount } from './fts-sync-hooks'
import { databaseService } from '../database/database-service'
import { logger } from '@firefly/shared'

vi.mock('../database/database-service', () => ({
  databaseService: {
    syncFTSTagsBatch: vi.fn()
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

describe('fts-sync-hooks 窗口聚合批量去抖', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    flushFtsSync()
    vi.clearAllMocks()
  })

  afterEach(() => {
    flushFtsSync()
    vi.useRealTimers()
  })

  it('同指纹短时多次入队应去重并仅触发一次 syncFTSTagsBatch', () => {
    const fingerprint = 'test-fp'

    queueFtsSync(fingerprint)
    queueFtsSync(fingerprint)
    queueFtsSync(fingerprint)

    expect(getPendingFtsSyncCount()).toBe(1)
    expect(databaseService.syncFTSTagsBatch).not.toHaveBeenCalled()

    vi.advanceTimersByTime(2000)

    expect(getPendingFtsSyncCount()).toBe(0)
    expect(databaseService.syncFTSTagsBatch).toHaveBeenCalledTimes(1)
    expect(databaseService.syncFTSTagsBatch).toHaveBeenCalledWith([fingerprint])
  })

  it('多指纹同窗口应合并为单次 syncFTSTagsBatch 批量事务调用', () => {
    queueFtsSync('fp1')
    vi.advanceTimersByTime(500)
    queueFtsSync('fp2')
    queueFtsSync('fp1')

    expect(getPendingFtsSyncCount()).toBe(2)
    // 窗口未到期前不应提前刷盘
    vi.advanceTimersByTime(1500)
    expect(databaseService.syncFTSTagsBatch).not.toHaveBeenCalled()

    vi.advanceTimersByTime(500)
    expect(databaseService.syncFTSTagsBatch).toHaveBeenCalledTimes(1)
    expect(databaseService.syncFTSTagsBatch).toHaveBeenCalledWith(['fp1', 'fp2'])
    expect(getPendingFtsSyncCount()).toBe(0)
  })

  it('flushFtsSync 应立即刷盘且二次调用幂等不重发', () => {
    queueFtsSync('fp-flush-1')
    queueFtsSync('fp-flush-2')
    expect(getPendingFtsSyncCount()).toBe(2)

    flushFtsSync()
    expect(databaseService.syncFTSTagsBatch).toHaveBeenCalledTimes(1)
    expect(databaseService.syncFTSTagsBatch).toHaveBeenCalledWith(['fp-flush-1', 'fp-flush-2'])
    expect(getPendingFtsSyncCount()).toBe(0)

    // 到原定时器时间点也不再重复触发，二次 flush 幂等
    vi.advanceTimersByTime(2500)
    flushFtsSync()
    expect(databaseService.syncFTSTagsBatch).toHaveBeenCalledTimes(1)
  })

  it('syncFTSTagsBatch 异常时应捕获并记 logger.warn，不崩溃且清空待刷集合', () => {
    vi.mocked(databaseService.syncFTSTagsBatch).mockImplementationOnce(() => {
      throw new Error('sqlite busy')
    })

    queueFtsSync('fp-err')
    vi.advanceTimersByTime(2000)

    expect(getPendingFtsSyncCount()).toBe(0)
    expect(logger.warn).toHaveBeenCalled()
  })
})
