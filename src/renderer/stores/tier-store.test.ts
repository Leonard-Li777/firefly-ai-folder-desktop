import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useTierStore } from './tier-store'

vi.mock('@app/languages', () => ({
  t: (key: string) => key
}))

describe('TierStore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // 重置 store 到初始状态
    useTierStore.setState({
      tier: 'free',
      firecores: 0,
      entitlements: [],
      computed_limits: {
        analysis_quota_total: 0,
        speedy_dir_slot_limit: 0,
        private_dir_slot_limit: 0,
        vdir_slot_limit: 0,
        vdir_slot_limit_by_workspace: {},
        can_offline: false,
        sync_analysis_to_cloud: true,
        telemetry: true,
        training_data_collection: true
      },
      current_counts: {},
      isLoading: false,
      consumptionDetails: [],
      subscription: undefined
    })
  })

  it('should fetch consumption details', async () => {
    const mockDetails = [
      { type: 'spend_unlock_analysis', payload: '{}', status: 'completed', time: '2023-01-01' }
    ]

    window.electronAPI = {
      userTier: {
        getConsumptionDetails: vi.fn().mockResolvedValue(mockDetails),
        getProfile: vi.fn().mockResolvedValue({
          tier: 'free',
          firecores: 100,
          entitlements: [],
          computed_limits: {}
        }),
        removeFirecoreTransactionsUpdated: vi.fn(),
        onFirecoreTransactionsUpdated: vi.fn()
      }
    } as any

    await useTierStore.getState().fetchConsumptionDetails()
    expect(useTierStore.getState().consumptionDetails).toEqual(mockDetails)
  })

  it('should handle spendFirecores correctly', async () => {
    const mockResult = { success: true }
    window.electronAPI.userTier.spendFirecores = vi.fn().mockResolvedValue(mockResult)
    window.electronAPI.userTier.getProfile = vi.fn().mockResolvedValue({
      tier: 'free',
      firecores: 50,
      entitlements: [],
      computed_limits: {}
    })
    window.electronAPI.userTier.getConsumptionDetails = vi.fn().mockResolvedValue([])

    const result = await useTierStore.getState().spendFirecores(50)
    expect(result).toEqual(mockResult)
    expect(window.electronAPI.userTier.getProfile).toHaveBeenCalled()
    expect(window.electronAPI.userTier.getConsumptionDetails).toHaveBeenCalled()
  })

  describe('computed_limits 类型和门控', () => {
    it('should have correct default computed_limits', () => {
      const state = useTierStore.getState()
      expect(state.computed_limits).toEqual({
        analysis_quota_total: 0,
        speedy_dir_slot_limit: 0,
        private_dir_slot_limit: 0,
        vdir_slot_limit: 0,
        vdir_slot_limit_by_workspace: {},
        can_offline: false,
        sync_analysis_to_cloud: true,
        telemetry: true,
        training_data_collection: true
      })
    })

    it('should correctly read can_offline from computed_limits', async () => {
      window.electronAPI = {
        userTier: {
          getProfile: vi.fn().mockResolvedValue({
            tier: 'enterprise',
            firecores: 1000,
            entitlements: [],
            computed_limits: {
              analysis_quota_total: 9999,
              speedy_dir_slot_limit: 3,
              private_dir_slot_limit: 3,
              vdir_slot_limit: 5,
              vdir_slot_limit_by_workspace: {},
              can_offline: true,
              sync_analysis_to_cloud: false,
              telemetry: false,
              training_data_collection: false
            }
          }),
          removeProfileChanged: vi.fn(),
          onProfileChanged: vi.fn(),
          removeTransactionFailed: vi.fn(),
          onTransactionFailed: vi.fn()
        }
      } as any

      await useTierStore.getState().fetchProfile()

      const state = useTierStore.getState()
      expect(state.computed_limits.can_offline).toBe(true)
      expect(state.computed_limits.telemetry).toBe(false)
      expect(state.computed_limits.sync_analysis_to_cloud).toBe(false)
      expect(state.computed_limits.training_data_collection).toBe(false)
    })

    it('should correctly read telemetry from computed_limits', async () => {
      window.electronAPI = {
        userTier: {
          getProfile: vi.fn().mockResolvedValue({
            tier: 'free',
            firecores: 100,
            entitlements: [],
            computed_limits: {
              analysis_quota_total: 10,
              speedy_dir_slot_limit: 1,
              private_dir_slot_limit: 1,
              vdir_slot_limit: 2,
              vdir_slot_limit_by_workspace: {},
              can_offline: false,
              sync_analysis_to_cloud: true,
              telemetry: true,
              training_data_collection: true
            }
          }),
          removeProfileChanged: vi.fn(),
          onProfileChanged: vi.fn(),
          removeTransactionFailed: vi.fn(),
          onTransactionFailed: vi.fn()
        }
      } as any

      await useTierStore.getState().fetchProfile()

      const state = useTierStore.getState()
      expect(state.computed_limits.telemetry).toBe(true)
      expect(state.computed_limits.can_offline).toBe(false)
    })

    it('getRemaining should work with computed_limits', () => {
      window.electronAPI = {
        userTier: {
          getProfile: vi.fn().mockResolvedValue({
            tier: 'pro',
            firecores: 500,
            entitlements: [],
            computed_limits: {
              analysis_quota_total: 100,
              speedy_dir_slot_limit: 3,
              private_dir_slot_limit: 2,
              vdir_slot_limit: 5,
              vdir_slot_limit_by_workspace: {}
            }
          })
        }
      } as any

      // 设置 current_counts
      useTierStore.setState({
        computed_limits: {
          analysis_quota_total: 100,
          speedy_dir_slot_limit: 3,
          private_dir_slot_limit: 2,
          vdir_slot_limit: 5,
          vdir_slot_limit_by_workspace: {},
          can_offline: false,
          sync_analysis_to_cloud: true,
          telemetry: true,
          training_data_collection: true
        },
        current_counts: {
          analyze_file: 30,
          speedy_dir_slot: 1,
          private_dir_slot: 1
        }
      })

      expect(useTierStore.getState().getRemaining('analyze_file')).toBe(70)
      expect(useTierStore.getState().getRemaining('speedy_dir_slot')).toBe(2)
      expect(useTierStore.getState().getRemaining('private_dir_slot')).toBe(1)
    })
  })
})
