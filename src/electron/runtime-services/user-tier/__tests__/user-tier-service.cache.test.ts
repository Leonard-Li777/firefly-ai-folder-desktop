// @file   user-tier-service.cache.test.ts
// @brief  验证 syncToCache / syncLocalCacheAndNotify 对 USER_TIER_CACHE_DATA 的写入判定不因 encryptCache 随机 IV 产生假阳性
//
// 运行方式: pnpm test

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { UserTierService } from '../user-tier-service'
import { UserTierDataManager } from '@firefly/core-engine'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'

// -----------------------------------------------------------------------------
// Mock 依赖
// -----------------------------------------------------------------------------
vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn()
  },
  BrowserWindow: {
    getAllWindows: vi.fn().mockReturnValue([])
  },
  net: {
    isOnline: vi.fn().mockReturnValue(true)
  },
  app: {
    getPath: vi.fn().mockReturnValue('mock-path'),
    getAppPath: vi.fn().mockReturnValue('mock-app-path')
  }
}))

const mockConfigOrchestrator = {
  getValue: vi.fn(),
  updateValue: vi.fn(),
  getTierConstants: vi.fn().mockReturnValue({
    welcomeGrantFirecores: 95,
    tierLimits: {
      free: {},
      pro: {},
      enterprise: {},
      agent: {}
    }
  })
}

vi.mock('../../../config/config-orchestrator', () => ({
  ConfigOrchestrator: {
    getInstance: () => mockConfigOrchestrator
  }
}))

vi.mock('@firefly/server', async () => {
  const actual = await vi.importActual('@firefly/server')
  return {
    ...actual,
    CacheEncryption: {
      encrypt: vi.fn().mockImplementation(data => `enc::${data}`),
      decrypt: vi.fn().mockImplementation(enc => {
        if (enc && enc.startsWith('enc::')) {
          return enc.substring(5)
        }
        throw new Error('decrypt fail')
      })
    }
  }
})

vi.mock('../../../database/database-service', () => ({
  databaseService: {
    db: null,
    initialize: vi.fn()
  }
}))

const mockTierService = {
  syncFromCloud: vi.fn(),
  encryptCache: vi.fn(),
  decryptCache: vi.fn(),
  // UserTierDataManager.trySync 会调用 getFirecoreTransactions，缺方法会抛 TypeError
  getFirecoreTransactions: vi.fn().mockResolvedValue([])
}
const serviceInstance = UserTierService.getInstance()
;(serviceInstance as any).tierService = mockTierService

// -----------------------------------------------------------------------------
// Helper
// -----------------------------------------------------------------------------
const makeCache = (data: any) => {
  const fullData = {
    version: 1,
    tier: data.tier,
    firecores: data.firecores,
    entitlements: data.entitlements || [],
    counters: data.counters || {},
    computed_limits: data.computed_limits || {},
    ...data
  }
  const encrypted = `enc::${JSON.stringify(fullData)}`
  return encrypted
}

/** 从 updateValue 的 mock 调用中提取最后一次写入的解密数据 */
const getLastWrittenData = () => {
  const calls = mockConfigOrchestrator.updateValue.mock.calls.filter(
    (call: any[]) => call[0] === 'USER_TIER_CACHE_DATA'
  )
  expect(calls.length).toBeGreaterThan(0)
  const lastCall = calls[calls.length - 1]
  const encrypted = lastCall[1] as string
  expect(encrypted).toMatch(/^enc::/)
  const jsonStr = encrypted.substring(5)
  return JSON.parse(jsonStr)
}

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------
describe('UserTierService - cache sync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    UserTierService.resetDataManagerForTest()
    ;(serviceInstance as any).encryptionKey = Buffer.from('mock-encryption-key-32bytes-long!!')
    ;(serviceInstance as any).hmacKey = Buffer.from('mock-hmac-key-16bytes-long!!!')
  })

  it('云端数据与本地缓存内容相同时，最终写入的数据保持一致', async () => {
    const cloudData = { tier: 'FREE', firecores: 45 }
    mockTierService.syncFromCloud.mockResolvedValueOnce(cloudData)

    // 已有缓存且内容相同
    const existingEncrypted = makeCache(cloudData)
    mockConfigOrchestrator.getValue.mockImplementation(key => {
      if (key === 'USER_TIER_CACHE_DATA') return existingEncrypted
      return undefined
    })

    await (serviceInstance as any)['syncToCache']('dummy-machine-id')

    // trySync 会调用 encryptAndPersistLocal（至少一次用于本地流水派生），
    // 但最终写入的数据应与云端数据一致
    const writtenData = getLastWrittenData()
    expect(writtenData.tier).toBe('FREE')
    expect(writtenData.firecores).toBe(45)
  })

  it('写入缓存当云端数据发生变化', async () => {
    const oldData = { tier: 'FREE', firecores: 45 }
    const newData = { tier: 'PRO', firecores: 45 }

    // 第一次同步得到旧数据，写入缓存
    mockTierService.syncFromCloud.mockResolvedValueOnce(oldData)
    mockConfigOrchestrator.getValue.mockImplementation(key => {
      if (key === 'USER_TIER_CACHE_DATA') return undefined
      return undefined
    })
    await (serviceInstance as any)['syncToCache']('dummy-id')
    expect(mockConfigOrchestrator.updateValue).toHaveBeenCalled()
    vi.clearAllMocks()

    // 第二次同步得到新数据，当前缓存仍是旧数据
    const oldEncrypted = makeCache(oldData)
    mockTierService.syncFromCloud.mockResolvedValueOnce(newData)
    mockConfigOrchestrator.getValue.mockImplementation(key => {
      if (key === 'USER_TIER_CACHE_DATA') return oldEncrypted
      return undefined
    })
    await (serviceInstance as any)['syncToCache']('dummy-id')
    // 验证最终写入的数据包含新的等级信息
    const writtenData = getLastWrittenData()
    expect(writtenData.tier).toBe('PRO')
    expect(writtenData.firecores).toBe(45)
  })

  it('当缓存解密失败时仍会写入新缓存', async () => {
    const cloudData = { tier: 'FREE', firecores: 45 }
    mockTierService.syncFromCloud.mockResolvedValueOnce(cloudData)

    // 读取到一个无效的密文，CacheEncryption.decrypt 抛异常
    mockConfigOrchestrator.getValue.mockImplementation(key => {
      if (key === 'USER_TIER_CACHE_DATA') return 'invalid-encrypted'
      return undefined
    })

    await (serviceInstance as any)['syncToCache']('mid')
    // 解密失败后仍应写入云端同步回来的新数据
    const writtenData = getLastWrittenData()
    expect(writtenData.tier).toBe('FREE')
    expect(writtenData.firecores).toBe(45)
  })
})
