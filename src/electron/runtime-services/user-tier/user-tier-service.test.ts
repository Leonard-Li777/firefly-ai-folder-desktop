import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { UserTierService } from './user-tier-service'
import { databaseService } from '../database/database-service'
import { TierService } from '@firefly/server'
import { INFINITY } from '@firefly/shared'

vi.mock('../database/database-service', () => ({
  databaseService: {
    initialize: vi.fn().mockResolvedValue(undefined),
    ensureInitialized: vi.fn().mockResolvedValue(undefined),
    db: {
      prepare: vi.fn().mockImplementation(() => ({
        run: vi.fn(),
        get: vi.fn(),
        all: vi.fn().mockReturnValue([])
      }))
    }
  }
}))

vi.mock('@firefly/server', () => ({
  TierService: vi.fn().mockImplementation(() => ({
    getFirecoreTransactions: vi.fn(),
    syncFromCloud: vi.fn(),
    processIncomeTransaction: vi.fn().mockResolvedValue({ success: true }),
    spendFirecores: vi.fn().mockResolvedValue({ success: true })
  })),
  UserTierQueries: vi.fn(),
  KMLogic: {
    deriveKeys: vi.fn(),
    encryptKM: vi.fn().mockReturnValue('mock-encrypted-hex'),
    decryptKM: vi.fn().mockReturnValue(Buffer.alloc(48)),
    deriveKMFromLicense: vi.fn().mockReturnValue(Buffer.alloc(48))
  },
  CacheEncryption: {
    encrypt: vi.fn(),
    decrypt: vi.fn()
  },
  WORKSPACE_CONSTANTS: {
    SUPABASE_URL: 'mock-url',
    SUPABASE_ANON_KEY: 'mock-key'
  }
}))

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn().mockReturnValue({})
}))

vi.mock('../../config/config-orchestrator', () => ({
  ConfigOrchestrator: {
    getInstance: vi.fn().mockReturnValue({
      getValue: vi.fn(),
      updateValue: vi.fn(),
      getTierConstants: vi.fn().mockReturnValue({
        analysis_quota_total: 200,
        vdir_slot_limit: 3,
        welcomeGrantFirecores: 95,
        dailyCheckinFirecores: 5,
        maxPendingOperations: 10,
        freeBaseQuota: 200,
        inviteFirecoreReward: 100,
        inviteFirecoreRewardInvitee: 100,
        inviteQuotaBonus: 50,
        prices: {
          spend_unlock_analysis: 300,
          spend_extra_private_dir_slot: 100,
          spend_extra_speedy_dir_slot: 100,
          spend_extra_vdir_slot: 200,
          spend_access_vdir: 50,
          spend_export_vdir: 5,
          spend_export_rdir: 5,
          spend_download_file: 5,
          spend_cloud_decompress: 5,
          spend_get_password: 5,
          spend_regenerate_vdir: 5
        },
        tierLimits: {
          free: {
            analysis_quota_total: 200,
            speedy_dir_slot_limit: 3,
            private_dir_slot_limit: 3,
            vdir_slot_limit: 3,
            vdir_slot_limit_by_workspace: {},
            can_offline: false,
            sync_analysis_to_cloud: false,
            telemetry: false,
            training_data_collection: false
          },
          pro: {
            analysis_quota_total: 999999999,
            speedy_dir_slot_limit: 999999999,
            private_dir_slot_limit: 999999999,
            vdir_slot_limit: 999999999,
            vdir_slot_limit_by_workspace: {},
            can_offline: true,
            sync_analysis_to_cloud: true,
            telemetry: true,
            training_data_collection: true
          },
          enterprise: {},
          agent: {}
        }
      })
    })
  }
}))

vi.mock('../system/system-identity-service', () => ({
  SystemIdentityService: {
    getInstance: vi.fn().mockReturnValue({
      // machine-id 必须是十六进制，否则 encodeMachineIdToRef 内部 BigInt('0x' + hexPart) 会抛 SyntaxError
      getMachineId: vi.fn().mockReturnValue('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'),
      getSignature: vi.fn().mockReturnValue('mock-signature')
    })
  }
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/user/data'),
    getAppPath: vi.fn(() => '/mock/app'),
    isPackaged: false
  },
  ipcMain: {
    handle: vi.fn()
  },
  BrowserWindow: {
    getAllWindows: vi.fn().mockReturnValue([])
  },
  net: {
    isOnline: vi.fn().mockReturnValue(false)
  }
}))

describe('UserTierService', () => {
  let service: UserTierService

  beforeEach(() => {
    vi.clearAllMocks()
    // afterEach 的 mockRestore 会清除顶部工厂的默认实现，这里为每个测试重建完整的 TierService mock，
    // 确保 UserTierDataManager.trySync 调用 getFirecoreTransactions / syncFromCloud 时方法存在
    vi.mocked(TierService).mockImplementation(
      () =>
        ({
          getFirecoreTransactions: vi.fn().mockResolvedValue([]),
          syncFromCloud: vi.fn().mockResolvedValue({
            version: 1,
            tier: 'FREE',
            firecores: 0,
            entitlements: [],
            counters: {},
            computed_limits: {}
          }),
          processIncomeTransaction: vi.fn().mockResolvedValue({ success: true }),
          spendFirecores: vi.fn().mockResolvedValue({ success: true })
        }) as unknown as TierService
    )
    UserTierService.resetDataManagerForTest()
    service = UserTierService.getInstance()
    service.reloadServices()
  })

  afterEach(() => {
    vi.mocked(TierService).mockRestore()
  })

  it('should return 0 firecores when local pending_firecore_operations is empty', async () => {
    // Mock the SUM query to return 0
    const mockGet = vi.fn().mockReturnValue({ total: 0 })
    const mockRun = vi.fn()
    const mockAll = vi.fn().mockReturnValue([])
    ;(databaseService as any).db = {
      prepare: vi.fn().mockReturnValue({ get: mockGet, run: mockRun, all: mockAll })
    }

    // Reset and reinitialize to force loadOrCreate
    UserTierService.resetDataManagerForTest()
    const svc = UserTierService.getInstance()

    const profile = await svc.getProfile()
    expect(profile.firecores).toBe(0)
  })

  it('should calculate firecores from pending + completed only, excluding failed and rolled_back', async () => {
    // Mock the SUM query to return only pending + completed sum
    const mockGet = vi.fn().mockReturnValue({ total: 55 })
    const mockRun = vi.fn()
    const mockAll = vi.fn().mockReturnValue([])
    const mockPrepare = vi.fn().mockReturnValue({ get: mockGet, run: mockRun, all: mockAll })
    ;(databaseService as any).db = { prepare: mockPrepare }

    UserTierService.resetDataManagerForTest()
    const svc = UserTierService.getInstance()

    const profile = await svc.getProfile()

    // Verify the SQL only counts pending + completed
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const sumCall = mockPrepare.mock.calls.find(([sql]: string[]) => sql.includes('COALESCE(SUM'))
    expect(sumCall).toBeDefined()
    const sql: string = sumCall![0]
    expect(sql).toContain("status IN ('pending', 'completed')")
    expect(sql).not.toContain("'failed'")
    expect(sql).not.toContain("'rolled_back'")

    expect(profile.firecores).toBe(55)
  })

  it('should treat income types as positive and spend types as negative in SUM', async () => {
    const mockGet = vi.fn().mockReturnValue({ total: 300 })
    const mockRun = vi.fn()
    const mockAll = vi.fn().mockReturnValue([])
    const mockPrepare = vi.fn().mockReturnValue({ get: mockGet, run: mockRun, all: mockAll })
    ;(databaseService as any).db = { prepare: mockPrepare }

    UserTierService.resetDataManagerForTest()
    const svc = UserTierService.getInstance()

    const profile = await svc.getProfile()

    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const sumCall = mockPrepare.mock.calls.find(([sql]: string[]) => sql.includes('COALESCE(SUM'))
    expect(sumCall).toBeDefined()
    const sql: string = sumCall![0]

    // SQL 应直接 SUM firecores，不再有 CASE WHEN 判断正负
    expect(sql).toContain("json_extract(payload, '$.firecores')")
    expect(sql).not.toContain('CASE WHEN')
    expect(sql).not.toContain('incomeTypes')

    expect(profile.firecores).toBe(300)
  })

  it('should decrease firecores after spending locally', async () => {
    let callCount = 0
    const mockGet = vi.fn().mockImplementation(() => {
      callCount++
      // First call: initial balance, Second call: after spend (SUM includes pending operation)
      return { total: callCount <= 1 ? 100 : 70 }
    })
    const mockRun = vi.fn()
    const mockAll = vi.fn().mockReturnValue([])
    ;(databaseService as any).db = {
      prepare: vi.fn().mockReturnValue({ get: mockGet, run: mockRun, all: mockAll })
    }

    UserTierService.resetDataManagerForTest()
    const svc = UserTierService.getInstance()

    // Initial balance should be 100
    const before = await svc.getProfile()
    expect(before.firecores).toBe(100)

    // Spend 30
    const result = await svc.spendFirecores(30, 'spend_unlock_analysis')
    expect(result.success).toBe(true)

    // Balance should be 70
    const after = await svc.getProfile()
    expect(after.firecores).toBe(70)
  })

  it('should restore firecores after rolling back a spend', async () => {
    // Track the pending operation ID from the run call
    let capturedOpId: string | null = null
    const mockRun = vi.fn().mockImplementation((...args: any[]) => {
      if (!capturedOpId) capturedOpId = args[0] as string
    })
    // Dynamic GET mock:
    // 1st: calculateLocalFirecores in loadOrCreate → { total: 100 }
    // 2nd: hasWelcomeGrantRecord → any truthy value
    // 3rd: calculateLocalFirecores after spend → { total: 70 }
    // 4th+: rollback's SELECT local_state_before → snapshot
    let getCallCount = 0
    const mockGet = vi.fn().mockImplementation(() => {
      getCallCount++
      if (getCallCount === 1) return { total: 100 }
      if (getCallCount === 2) return { total: 1 } // hasWelcomeGrantRecord: truthy
      if (getCallCount === 3) return { total: 70 }
      // 4th+ calls are for rollback's SELECT local_state_before
      return {
        local_state_before: JSON.stringify({
          version: 1,
          tier: 'FREE',
          firecores: 100,
          entitlements: [],
          counters: {},
          computed_limits: {}
        })
      }
    })
    const mockAll = vi.fn().mockReturnValue([])
    ;(databaseService as any).db = {
      prepare: vi.fn().mockReturnValue({ get: mockGet, run: mockRun, all: mockAll })
    }

    UserTierService.resetDataManagerForTest()
    const svc = UserTierService.getInstance()

    // Initial balance
    const before = await svc.getProfile()
    expect(before.firecores).toBe(100)

    // Spend 30
    const spendResult = await svc.spendFirecores(30, 'spend_unlock_analysis')
    expect(spendResult.success).toBe(true)

    // Balance decreased
    const afterSpend = await svc.getProfile()
    expect(afterSpend.firecores).toBe(70)

    // Now rollback the operation
    expect(capturedOpId).not.toBeNull()
    await svc.rollbackLocal(capturedOpId!)

    // Balance should be restored to 100
    const afterRollback = await svc.getProfile()
    expect(afterRollback.firecores).toBe(100)
  })

  it('should sync cloud transactions to local and recalculate balance on trySync', async () => {
    // Mock the TierService to return cloud transactions
    const mockGetFirecoreTransactions = vi.fn().mockResolvedValue([
      {
        id: 'cloud-tx-1',
        transaction_type: 'invitation_earn',
        firecores: 100,
        created_at: '2026-01-01T00:00:00Z',
        metadata: null
      },
      {
        id: 'cloud-tx-2',
        transaction_type: 'invitation_earn',
        firecores: 100,
        created_at: '2026-01-02T00:00:00Z',
        metadata: null
      },
      {
        id: 'cloud-tx-3',
        transaction_type: 'invitation_earn',
        firecores: 100,
        created_at: '2026-01-03T00:00:00Z',
        metadata: null
      }
    ])
    const mockSyncFromCloud = vi.fn().mockResolvedValue({
      version: 1,
      tier: 'FREE',
      firecores: 345,
      entitlements: [],
      counters: {},
      computed_limits: {}
    })
    vi.mocked(TierService).mockImplementation(
      () =>
        ({
          getFirecoreTransactions: mockGetFirecoreTransactions,
          syncFromCloud: mockSyncFromCloud,
          processIncomeTransaction: vi.fn().mockResolvedValue({ success: true }),
          spendFirecores: vi.fn().mockResolvedValue({ success: true })
        }) as unknown as TierService
    )

    // Track INSERT calls to verify cloud transactions are persisted locally
    const insertedOps: string[] = []
    const mockRun = vi.fn().mockImplementation((...args: any[]) => {
      // Return changes: 0 so the UPDATE has no effect, triggering INSERT
      if (args[0] && typeof args[0] === 'string' && args[0].startsWith('cloud-tx-')) {
        insertedOps.push(args[0])
      }
      return { changes: 0 }
    })
    // SUM returns 0 initially, then 345 after sync
    let getCallCount = 0
    const mockGet = vi.fn().mockImplementation(() => {
      getCallCount++
      if (getCallCount <= 2) return { total: 0 }
      return { total: 345 }
    })
    const mockAll = vi.fn().mockReturnValue([])
    ;(databaseService as any).db = {
      prepare: vi.fn().mockReturnValue({ get: mockGet, run: mockRun, all: mockAll })
    }

    // Make isOnline return true
    const { net } = await import('electron')
    vi.mocked(net.isOnline).mockReturnValue(true)

    UserTierService.resetDataManagerForTest()
    const svc = UserTierService.getInstance()
    svc.reloadServices()

    // Debug: verify mock is set up
    const tierSvc = (svc as any).getTierService()
    expect(tierSvc.getFirecoreTransactions).toBeDefined()

    // 手动触发同步（machine-id 须为十六进制，避免 encodeMachineIdToRef 转 BigInt 失败）
    await svc.syncToCache('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')

    // Debug: verify getFirecoreTransactions was called
    expect(mockGetFirecoreTransactions).toHaveBeenCalled()

    // Verify cloud transactions were inserted into local table
    expect(insertedOps.length).toBeGreaterThanOrEqual(3)
    expect(insertedOps).toContain('cloud-tx-1')
    expect(insertedOps).toContain('cloud-tx-2')
    expect(insertedOps).toContain('cloud-tx-3')

    // Verify balance is recalculated
    const profile = await svc.getProfile()
    expect(profile.firecores).toBe(345)
  })

  it('should return default welcome record when local is empty', async () => {
    const result = await service.getConsumptionDetails()
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'welcome_grant',
      firecores: 95,
      balance_after: 95,
      status: 'completed'
    })
  })

  it('should return local pending_firecore_operations when available', async () => {
    const mockData = [
      {
        type: 'spend_unlock_analysis',
        payload: '{"firecores":-300}',
        status: 'pending',
        time: '2023-01-01T00:00:00Z'
      }
    ]
    const mockPrepare = vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue(mockData),
      // UserTierDataManager.trySync/replayOfflineQueue 会调用 db.prepare(...).run / .get
      run: vi.fn(),
      get: vi.fn().mockReturnValue(undefined)
    })
    ;(databaseService as any).db = { prepare: mockPrepare }

    const result = await service.getConsumptionDetails()
    expect(mockPrepare).toHaveBeenCalledWith(
      expect.stringContaining('FROM pending_firecore_operations')
    )
    expect(result).toEqual([
      {
        type: 'spend_unlock_analysis',
        firecores: -300,
        balance_after: -300,
        status: 'pending',
        time: '2023-01-01T00:00:00Z',
        metadata: null
      }
    ])
  })

  it('should return default welcome record when local and cloud both fail', async () => {
    ;(databaseService as any).db = null

    const result = await service.getConsumptionDetails()
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      type: 'welcome_grant',
      firecores: 95
    })
  })

  it('should correctly parse metadata from local pending operations if present', async () => {
    const mockData = [
      {
        type: 'spend_export_rdir',
        payload: JSON.stringify({
          firecores: -5,
          metadata: { reference_type: 'workspace', reference_id: 'w-1', workspaceId: 10 }
        }),
        status: 'pending',
        time: '2023-01-01T00:00:00Z'
      }
    ]
    const mockPrepare = vi.fn().mockReturnValue({
      all: vi.fn().mockReturnValue(mockData),
      // UserTierDataManager.trySync/replayOfflineQueue 会调用 db.prepare(...).run / .get
      run: vi.fn(),
      get: vi.fn().mockReturnValue(undefined)
    })
    ;(databaseService as any).db = { prepare: mockPrepare }

    const result = await service.getConsumptionDetails()
    expect(result).toEqual([
      {
        type: 'spend_export_rdir',
        firecores: -5,
        balance_after: -5,
        status: 'pending',
        time: '2023-01-01T00:00:00Z',
        metadata: { reference_type: 'workspace', reference_id: 'w-1', workspaceId: 10 }
      }
    ])
  })

  it('should encrypt rollback snapshot in CacheEncryption format compatible with decrypt', async () => {
    const mockSnapshot = { tier: 'FREE', firecores: 100 }
    const mockUpdateValue = vi.fn()
    const mockGet = vi.fn().mockReturnValue({ local_state_before: JSON.stringify(mockSnapshot) })
    const mockRun = vi.fn()

    ;(databaseService as any).db = {
      prepare: vi.fn().mockReturnValue({
        get: mockGet,
        run: mockRun
      })
    }

    const { ConfigOrchestrator } = await import('../../config/config-orchestrator')
    const configInstance = ConfigOrchestrator.getInstance()
    ;(configInstance.updateValue as any) = mockUpdateValue

    // 设置 encryptionKey 和 hmacKey
    ;(service as any).encryptionKey = Buffer.from('mock-encryption-key-32bytes-long!!')
    ;(service as any).hmacKey = Buffer.from('mock-hmac-key-16bytes-long!!!')

    const { CacheEncryption } = await import('@firefly/server')
    ;(CacheEncryption.encrypt as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      'mock-iv:mock-data:mock-tag:mock-sig'
    )

    await service.rollbackLocal('mock-op-id')

    expect(CacheEncryption.encrypt).toHaveBeenCalledWith(
      expect.stringContaining('"firecores":100'),
      (service as any).encryptionKey,
      (service as any).hmacKey
    )
    expect(mockUpdateValue).toHaveBeenCalledWith(
      'USER_TIER_CACHE_DATA',
      'mock-iv:mock-data:mock-tag:mock-sig',
      { source: 'runtime' }
    )
    expect(mockRun).toHaveBeenCalledWith('mock-op-id')
  })

  it('should recalculate computed_limits when subscription expires offline', async () => {
    // Mock the DataManager with an expired subscription
    const mockGet = vi.fn().mockImplementation(() => {
      return { total: 0 }
    })
    const mockRun = vi.fn()
    const mockAll = vi.fn().mockReturnValue([])
    ;(databaseService as any).db = {
      prepare: vi.fn().mockReturnValue({ get: mockGet, run: mockRun, all: mockAll })
    }

    UserTierService.resetDataManagerForTest()
    const svc = UserTierService.getInstance()

    // First getProfile() creates the DataManager
    await svc.getProfile()

    // Access the DataManager and set expired PRO data
    const mgr = (svc as any).getDataManager()
    mgr.data = {
      version: 1,
      tier: 'pro',
      firecores: 100,
      subscription: {
        status: 'active',
        plan_id: 'pro',
        expires_at: '2020-01-01T00:00:00Z' // long expired
      },
      entitlements: [{ type: 'unlimited_analysis', scope: null, grantedAt: '', metadata: {} }],
      counters: {},
      computed_limits: {
        analysis_quota_total: INFINITY,
        speedy_dir_slot_limit: INFINITY,
        private_dir_slot_limit: INFINITY,
        vdir_slot_limit: INFINITY,
        vdir_slot_limit_by_workspace: {},
        can_offline: true,
        sync_analysis_to_cloud: true,
        telemetry: true,
        training_data_collection: true
      }
    }

    // Second getProfile() triggers getData() with expiry check
    const profile = await svc.getProfile()

    // Tier should be downgraded to FREE
    expect(profile.tier).toBe('free')
    // Subscription should be expired
    expect(profile.subscription?.status).toBe('expired')

    // computed_limits should be recalculated (not INFINITY for non-entitlement limits)
    // analysis_quota_total is INFINITY because user has unlimited_analysis entitlement
    expect(profile.computed_limits.analysis_quota_total).toBe(INFINITY)
    // private_dir_slot_limit should be finite (no entitlement for it)
    expect(profile.computed_limits.private_dir_slot_limit).toBeLessThan(INFINITY)
    // speedy_dir_slot_limit should also be finite
    expect(profile.computed_limits.speedy_dir_slot_limit).toBeLessThan(INFINITY)
  })

  it('should not double-deduct firecores when spending locally', async () => {
    let insertCount = 0
    let sumAfterSpend = false
    const mockRun = vi.fn().mockImplementation((...args: any[]) => {
      return { changes: 0 }
    })
    const mockPrepare = vi.fn().mockImplementation((sql: string) => {
      // Track INSERT INTO pending_firecore_operations calls
      if (sql.includes('INSERT INTO pending_firecore_operations')) {
        insertCount++
        sumAfterSpend = true // After insert, SUM should include the new -5 pending
      }
      return { get: mockGet, run: mockRun, all: mockAll }
    })
    // SUM returns 100 before spend, 95 after spend (includes -5 pending operation)
    const mockGet = vi.fn().mockImplementation(() => {
      if (sumAfterSpend) return { total: 95 }
      return { total: 100 }
    })
    const mockAll = vi.fn().mockReturnValue([])
    ;(databaseService as any).db = {
      prepare: mockPrepare
    }

    // Make isOnline return true so RPC is called
    const { net } = await import('electron')
    vi.mocked(net.isOnline).mockReturnValue(true)

    UserTierService.resetDataManagerForTest()
    const svc = UserTierService.getInstance()
    svc.reloadServices()

    // Mock TierService.spendFirecores to succeed
    const { TierService } = await import('@firefly/server')
    vi.mocked(TierService).mockImplementation(
      () =>
        ({
          getFirecoreTransactions: vi.fn().mockResolvedValue([]),
          syncFromCloud: vi.fn().mockResolvedValue({
            version: 1,
            tier: 'free',
            firecores: 95,
            entitlements: [],
            counters: {},
            computed_limits: {}
          }),
          processIncomeTransaction: vi.fn().mockResolvedValue({ success: true }),
          spendFirecores: vi.fn().mockResolvedValue({ success: true })
        }) as unknown as TierService
    )

    // First getProfile to initialize
    await svc.getProfile()

    // Spend 5 firecores
    const result = await svc.spendFirecores(5, 'spend_export_vdir')
    expect(result.success).toBe(true)

    // Should only have inserted ONE pending operation
    expect(insertCount).toBe(1)

    // Check balance after spend
    const profile = await svc.getProfile()
    // Balance should be 95 (100 - 5), not 90 (100 - 5 - 5)
    expect(profile.firecores).toBe(95)
  })
})
