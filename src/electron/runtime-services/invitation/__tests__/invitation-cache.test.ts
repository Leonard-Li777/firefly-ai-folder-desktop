import { describe, it, expect, vi, beforeEach } from 'vitest'
import { invitationService } from '../invitation-service'
import { ConfigOrchestrator } from '@app/electron/config/config-orchestrator'

// Mock 依赖
vi.mock('../../config', () => ({
  configService: {
    getSupabaseClient: vi.fn(),
    updateValue: vi.fn(),
    getValue: vi.fn()
  }
}))

vi.mock('node-machine-id', () => ({
  machineId: vi.fn().mockResolvedValue('test-machine-id')
}))

vi.mock('../system/remote-config-service', () => ({
  RemoteConfigService: {
    getInstance: () => ({
      getSupabaseClient: vi.fn()
    })
  }
}))

describe('InvitationService Cache Logic', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('当 Supabase 请求成功时，应该更新本地缓存', async () => {
    const mockData = { invitation_count: 5, is_invited: true }
    const mockSupabase = {
      from: vi.fn().mockReturnThis(),
      upsert: vi.fn().mockResolvedValue({ error: null }),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({ data: mockData, error: null })
    }

    vi.mocked(ConfigOrchestrator.getInstance().getSupabaseClient).mockReturnValue(mockSupabase as any)

    const result = await invitationService.getInvitationQuota()

    expect(result.count).toBe(5)
    expect(result.isInvited).toBe(true)
    // 验证 updateValue 被调用，且参数正确
    expect(ConfigOrchestrator.getInstance().updateValue).toHaveBeenCalledWith('INVITATION_CACHE_DATA', expect.objectContaining({
      invitationCount: 5,
      isInvited: true
    }))
  })

  it('当 Supabase 请求失败时，应该回滚使用本地缓存', async () => {
    // 1. 模拟 Supabase 报错
    vi.mocked(ConfigOrchestrator.getInstance().getSupabaseClient).mockReturnValue({
      from: () => ({
        upsert: () => Promise.resolve({ error: new Error('Network Error') })
      })
    } as any)

    // 2. 模拟本地已有缓存数据
    const mockCache = {
      invitationCount: 3,
      isInvited: false,
      lastUpdatedAt: '2026-03-31T00:00:00.000Z'
    }
    vi.mocked(ConfigOrchestrator.getInstance().getValue).mockReturnValue(mockCache)

    const result = await invitationService.getInvitationQuota()

    // 验证结果来自缓存
    expect(result.count).toBe(3)
    expect(result.isInvited).toBe(false)
    expect(result.isFromCache).toBe(true)
    expect(result.quota).toBe(10) // 基础 10 + 0 * 10
  })
})
