import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'
import { queueFtsSync } from './fts-sync-hooks'
import { databaseService } from '../database/database-service'

vi.mock('../database/database-service', () => ({
  databaseService: {
    syncFTSTags: vi.fn()
  }
}))

describe('queueFtsSync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('should debounce syncFTSTags calls', () => {
    const fingerprint = 'test-fp'

    queueFtsSync(fingerprint)
    queueFtsSync(fingerprint)
    queueFtsSync(fingerprint)

    vi.advanceTimersByTime(2000)

    expect(databaseService.syncFTSTags).toHaveBeenCalledTimes(1)
    expect(databaseService.syncFTSTags).toHaveBeenCalledWith(fingerprint)
  })

  it('should sync different fingerprints independently', () => {
    queueFtsSync('fp1')
    queueFtsSync('fp2')

    vi.advanceTimersByTime(2000)

    expect(databaseService.syncFTSTags).toHaveBeenCalledTimes(2)
    expect(databaseService.syncFTSTags).toHaveBeenCalledWith('fp1')
    expect(databaseService.syncFTSTags).toHaveBeenCalledWith('fp2')
  })
})
