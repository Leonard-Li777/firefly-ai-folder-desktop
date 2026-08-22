import { t } from '@app/languages'
import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { UserTier, ComputedLimits } from '@firefly/types'
import { toast } from '../components/common/Toast'

interface TierState {
  tier: UserTier
  firecores: number
  entitlements: any[]
  counters: Record<string, any>
  computed_limits: ComputedLimits
  current_counts: Record<string, number>
  isLoading: boolean
  consumptionDetails: any[]
  subscription?: {
    status: string
    expires_at?: string
    plan_id: string
  }

  fetchProfile: () => Promise<void>
  fetchConsumptionDetails: () => Promise<void>
  getRemaining: (type: string) => number
  hasEnoughFirecores: (firecores: number) => boolean
  spendFirecores: (
    firecores: number,
    type?: string,
    metadata?: Record<string, any>
  ) => Promise<{ success: boolean; message?: string }>
  checkQuota: (type: string, currentCount: number) => Promise<any>
  updateCurrentCount: (type: string, count: number) => void
  registerProfileListener: () => void
}

export const useTierStore = create<TierState>()(
  subscribeWithSelector((set, get) => ({
    tier: UserTier.FREE,
    firecores: 0,
    entitlements: [],
    counters: {},
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
    subscription: undefined,

    fetchProfile: async () => {
      set({ isLoading: true })
      try {
        const profile = await window.electronAPI.userTier.getProfile()
        set({
          tier: profile.tier as UserTier,
          firecores: profile.firecores,
          entitlements: profile.entitlements,
          counters: profile.counters || {},
          computed_limits: profile.computed_limits,
          subscription: profile.subscription,
          isLoading: false
        })
      } catch (error) {
        console.error('Failed to fetch user profile:', error)
        set({ isLoading: false })
      }
    },

    getRemaining: (type: string) => {
      const { computed_limits, current_counts } = get()
      if (!computed_limits) return 0
      const limitMap: Record<string, keyof ComputedLimits> = {
        analyze_file: 'analysis_quota_total',
        speedy_dir_slot: 'speedy_dir_slot_limit',
        private_dir_slot: 'private_dir_slot_limit',
        vdir_slot: 'vdir_slot_limit'
      }
      const limitKey = limitMap[type]
      if (!limitKey) return 0
      const limit = (computed_limits[limitKey] as number) ?? 0
      const used = current_counts[type] ?? 0
      return Math.max(0, limit - used)
    },
    updateCurrentCount: (type: string, count: number) => {
      set(state => ({ current_counts: { ...state.current_counts, [type]: count } }))
    },

    hasEnoughFirecores: (firecores: number) => {
      return get().firecores >= firecores
    },

    checkQuota: async (type: string, currentCount: number) => {
      return await window.electronAPI.userTier.checkQuota({ type, currentCount })
    },

    spendFirecores: async (firecores: number, type?: string, metadata?: Record<string, any>) => {
      try {
        const result = await window.electronAPI.userTier.spendFirecores(firecores, type, metadata)
        if (result.success) {
          await get().fetchProfile()
          await get().fetchConsumptionDetails()
        }
        return result
      } catch (error) {
        console.error('Failed to spend firecores:', error)
        return { success: false, message: t('未知错误') }
      }
    },

    fetchConsumptionDetails: async () => {
      window.electronAPI.userTier.removeFirecoreTransactionsUpdated?.()
      set({ isLoading: true })
      try {
        const details = await window.electronAPI.userTier.getConsumptionDetails()
        set({ consumptionDetails: details, isLoading: false })

        window.electronAPI.userTier.onFirecoreTransactionsUpdated?.((cloudData: any[]) => {
          set({ consumptionDetails: cloudData, isLoading: false })
        })
      } catch (error) {
        console.error('Failed to fetch consumption details:', error)
        set({ isLoading: false })
      }
    },

    registerProfileListener: () => {
      window.electronAPI.userTier.removeProfileChanged?.()
      window.electronAPI.userTier.onProfileChanged?.(() => {
        get().fetchProfile()
      })
      window.electronAPI.userTier.removeTransactionFailed?.()
      window.electronAPI.userTier.onTransactionFailed?.(data => {
        toast.error(t('交易失败，已归还扣币，原因：{reason}', { reason: data.message }))
      })
    }
  }))
)
