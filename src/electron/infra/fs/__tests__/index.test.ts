import { describe, it, expect } from 'vitest'
import * as infraFs from '../index'

describe('infra/fs index 统一导出', () => {
  it('导出 async-fs、concurrency、atomic-write 与 sync-allowlist 全部公共算子', () => {
    expect(typeof infraFs.statOrNull).toBe('function')
    expect(typeof infraFs.statOrThrow).toBe('function')
    expect(typeof infraFs.existsAsync).toBe('function')
    expect(typeof infraFs.readdirTyped).toBe('function')
    expect(typeof infraFs.mkdirp).toBe('function')
    expect(typeof infraFs.safeUnlink).toBe('function')
    expect(typeof infraFs.setDefaultStatErrorReporter).toBe('function')

    expect(infraFs.DEFAULT_CONCURRENCY).toBe(32)
    expect(typeof infraFs.mapLimit).toBe('function')
    expect(typeof infraFs.createLimiter).toBe('function')

    expect(typeof infraFs.writeFileAtomic).toBe('function')
    expect(typeof infraFs.writeFileAtomicSync).toBe('function')

    expect(Array.isArray(infraFs.SYNCHRONOUS_ALLOWLIST)).toBe(true)
    expect(typeof infraFs.normalizeRegistryKey).toBe('function')
    expect(typeof infraFs.findSyncAllowlistEntry).toBe('function')
    expect(typeof infraFs.validateSyncAllowlist).toBe('function')
    expect(typeof infraFs.assertSyncAllowlistIntegrity).toBe('function')
    expect(typeof infraFs.listSyncAllowlistEntries).toBe('function')
  })
})
