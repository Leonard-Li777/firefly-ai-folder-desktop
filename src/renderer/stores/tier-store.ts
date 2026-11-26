import { t } from '@app/languages'
import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { UserTier, ComputedLimits, UserSubscription } from '@firefly/types'
import { toast } from '../components/common/Toast'

interface TierState {
  tier: UserTier
  firecores: number
  refCode?: string | null
  entitlements: any[]
  counters: Record<string, any>
  computed_limits: ComputedLimits
  current_counts: Record<string, number>
  /** Profile（等级/余额/权益）刷新中的全局态 */
  isLoading: boolean
  /** 收支流水拉取中的独立态：必须与 isLoading 分离，否则云端等级同步会连带把流水页打断重绘 */
  isConsumptionLoading: boolean
  consumptionDetails: any[]
  subscription?: UserSubscription
  isUpgradeOpen: boolean
  isRulesOpen: boolean
  rulesDefaultTab: string | undefined
  isDeviceBindOpen: boolean

  clearRefCode: () => void
  openUpgradeDialog: () => void
  closeUpgradeDialog: () => void
  openRulesDialog: (tab?: string) => void
  closeRulesDialog: () => void
  openDeviceBindModal: () => void
  closeDeviceBindModal: () => void
  setIsDeviceBindOpen: (open: boolean) => void
  logout: () => Promise<void>
  fetchProfile: () => Promise<void>
  syncFromCloud: () => Promise<void>
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

let isManualLogout = false

/** 流水拉取飞行中句柄：并发的挂载/事件联动复用同一次请求，避免重复 set 造成列表反复重绘 */
let consumptionDetailsInFlight: Promise<void> | null = null

export const useTierStore = create<TierState>()(
  subscribeWithSelector((set, get) => ({
    tier: UserTier.FREE,
    firecores: 0,
    refCode: null,
    entitlements: [],
    counters: {},
    computed_limits: {
      analysis_quota_total: 0,
      video_max_duration_seconds: 300,
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
    isConsumptionLoading: false,
    consumptionDetails: [],
    subscription: undefined,
    isUpgradeOpen: false,
    isDeviceBindOpen: false,
    clearRefCode: () => {
      set({ refCode: null })
    },
    openUpgradeDialog: () => {
      set({ isUpgradeOpen: true })
    },
    closeUpgradeDialog: () => {
      set({ isUpgradeOpen: false })
    },
    isRulesOpen: false,
    rulesDefaultTab: undefined,

    openRulesDialog: (tab?: string) => {
      set({ isRulesOpen: true, rulesDefaultTab: tab })
    },
    closeRulesDialog: () => {
      set({ isRulesOpen: false, rulesDefaultTab: undefined })
    },
    openDeviceBindModal: () => {
      set({ isDeviceBindOpen: true })
    },
    closeDeviceBindModal: () => {
      set({ isDeviceBindOpen: false })
    },
    setIsDeviceBindOpen: (open: boolean) => {
      set({ isDeviceBindOpen: open })
    },

    logout: async () => {
      isManualLogout = true
      set({ isLoading: true })
      try {
        if (window.electronAPI?.deviceBind?.logout) {
          await window.electronAPI.deviceBind.logout()
        } else if (window.electronAPI?.deviceBind?.unbindDevice) {
          await window.electronAPI.deviceBind.unbindDevice()
        }
      } catch (error) {
        console.error('Failed to logout device:', error)
      } finally {
        set({
          tier: UserTier.FREE,
          firecores: 0,
          refCode: null,
          entitlements: [],
          counters: {},
          subscription: undefined,
          isLoading: false,
          isDeviceBindOpen: true
        })
        toast.success(t('已退出登录'))
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('firefly:device-unbound'))
        }
        setTimeout(() => {
          isManualLogout = false
        }, 1500)
      }
    },

    fetchProfile: async () => {
      set({ isLoading: true })
      try {
        const profile = await window.electronAPI.userTier.getProfile()
        set({
          tier: profile.tier as UserTier,
          firecores: profile.firecores,
          refCode: profile.ref_code ?? null,
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

    syncFromCloud: async () => {
      set({ isLoading: true })
      try {
        const profile = await window.electronAPI.userTier.syncFromCloud()
        if (profile) {
          set({
            tier: profile.tier as UserTier,
            firecores: profile.firecores,
            refCode: profile.ref_code ?? null,
            entitlements: profile.entitlements,
            counters: profile.counters || {},
            computed_limits: profile.computed_limits,
            subscription: profile.subscription,
            isLoading: false
          })
        }
      } catch (error) {
        console.error('Failed to sync user tier from cloud:', error)
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
      // 并发去重：同一时刻只允许一条流水请求在飞，避免重复 set 触发列表反复重绘
      if (consumptionDetailsInFlight) return consumptionDetailsInFlight

      window.electronAPI.userTier.removeFirecoreTransactionsUpdated?.()
      // 先注册监听再发起请求：syncFromCloud 触发的云端流水推送可能早于本次请求返回，
      // 若先 remove 后注册会丢掉这一拍更新，导致列表停留在旧数据上
      window.electronAPI.userTier.onFirecoreTransactionsUpdated?.((cloudData: any[]) => {
        set({ consumptionDetails: cloudData, isConsumptionLoading: false })
        // 云端流水更新后联动刷新 Profile，确保萤火余额与最新流水同步
        get().fetchProfile()
      })

      // 只翻动流水自己的加载态，严禁污染全局 isLoading（等级同步也会翻该旗标，是页面闪动的根源）
      set({ isConsumptionLoading: true })

      const task = (async () => {
        try {
          const details = await window.electronAPI.userTier.getConsumptionDetails()
          set({ consumptionDetails: details, isConsumptionLoading: false })
        } catch (error) {
          console.error('Failed to fetch consumption details:', error)
          set({ isConsumptionLoading: false })
        } finally {
          consumptionDetailsInFlight = null
        }
      })()

      consumptionDetailsInFlight = task
      return task
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
      window.electronAPI.userTier.removeDeviceUnbound?.()
      window.electronAPI.userTier.onDeviceUnbound?.(() => {
        set({
          tier: UserTier.FREE,
          refCode: null,
          subscription: undefined,
          isDeviceBindOpen: true
        })
        get().fetchProfile()
        if (!isManualLogout) {
          toast.warning(t('当前设备登录已失效或已被账号解绑，请重新绑定'))
        }
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('firefly:device-unbound'))
        }
      })
    }
  }))
)
