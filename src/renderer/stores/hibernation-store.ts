/**
 * 模块休眠与能耗透明响应式状态中心 (useHibernationStore)
 * 遵循 L3 规格书: docs/specs/unified-module-hibernation-and-energy-transparency-spec.md §3.3 & §3.4.1
 */

import { create } from 'zustand'
import type {
  HibernationSnapshot,
  ModuleRuntimeMetric
} from '../../electron/runtime-services/hibernation/types'
import { projectMemoryGauges } from '../../electron/runtime-services/hibernation/memory-gauges'
import { t } from '@app/languages'

export interface HibernationStoreState {
  snapshot: HibernationSnapshot | null
  loading: boolean
  isReclaiming: boolean
  lastReclaimedBytes: number | null
  error: string | null
  isSubscribed: boolean

  // Actions
  fetchSnapshot: () => Promise<void>
  reclaimAll: () => Promise<{ success: boolean; releasedBytes: number }>
  forceReset: (targetId: string) => Promise<boolean>
  retryModule: (targetId: string) => Promise<boolean>
  setSnapshot: (snapshot: HibernationSnapshot) => void
  subscribe: () => () => void
}

const getBridge = () => {
  if (typeof window === 'undefined') return undefined
  return (window as any).hibernation || (window as any).electronAPI?.hibernation
}

export const useHibernationStore = create<HibernationStoreState>((set, get) => ({
  snapshot: null,
  loading: false,
  isReclaiming: false,
  lastReclaimedBytes: null,
  error: null,
  isSubscribed: false,

  fetchSnapshot: async () => {
    const bridge = getBridge()
    if (!bridge?.getSnapshot) return
    set({ loading: true, error: null })
    try {
      const snap: HibernationSnapshot = await bridge.getSnapshot()
      set({ snapshot: snap, loading: false })
    } catch (err: any) {
      set({ error: err?.message || t('获取休眠快照失败'), loading: false })
    }
  },

  reclaimAll: async () => {
    const bridge = getBridge()
    if (!bridge?.reclaimAll) return { success: false, releasedBytes: 0 }
    set({ isReclaiming: true, error: null })
    try {
      const res = await bridge.reclaimAll()
      set({
        isReclaiming: false,
        lastReclaimedBytes: res.releasedBytes
      })
      // 成功释放后主动刷新快照
      await get().fetchSnapshot()
      return res
    } catch (err: any) {
      set({
        isReclaiming: false,
        error: err?.message || t('释放模块内存失败')
      })
      return { success: false, releasedBytes: 0 }
    }
  },

  forceReset: async (targetId: string) => {
    const bridge = getBridge()
    if (!bridge?.forceReset) return false
    try {
      const res = await bridge.forceReset(targetId)
      await get().fetchSnapshot()
      return res
    } catch (err: any) {
      set({ error: err?.message || t('重置模块 {{targetId}} 失败', { targetId }) })
      return false
    }
  },

  retryModule: async (targetId: string) => {
    const bridge = getBridge()
    if (!bridge?.retryModule) return false
    try {
      const res = await bridge.retryModule(targetId)
      await get().fetchSnapshot()
      return res
    } catch (err: any) {
      set({ error: err?.message || t('重试模块 {{targetId}} 失败', { targetId }) })
      return false
    }
  },

  setSnapshot: (snapshot: HibernationSnapshot) => {
    set({ snapshot, error: null })
  },

  subscribe: () => {
    const bridge = getBridge()
    if (!bridge?.onSnapshotChanged) return () => {}

    const unsubscribe = bridge.onSnapshotChanged((newSnapshot: HibernationSnapshot) => {
      set({ snapshot: newSnapshot })
    })

    set({ isSubscribed: true })

    // 订阅时主动获取一次初始快照
    get().fetchSnapshot()

    return () => {
      unsubscribe()
      set({ isSubscribed: false })
    }
  }
}))

/**
 * 纯函数选择器：派生内存仪表盘展示数据
 */
export function selectHibernationGauges(snapshot: HibernationSnapshot | null) {
  if (!snapshot || !snapshot.modules) {
    return {
      totalResidentRamBytes: 0,
      totalResidentVramBytes: 0,
      totalSavedRamBytes: 0,
      totalSavedVramBytes: 0,
      hasUncertainMemoryModules: false,
      hasUncertainVramModules: false,
      uncertainKinds: [] as readonly ('ram' | 'vram')[],
      isEnergySaving: false
    }
  }
  const gauges = projectMemoryGauges(snapshot.modules)
  const totalSaved = gauges.totalSavedRamBytes + gauges.totalSavedVramBytes
  const isEnergySaving = totalSaved > 0 && snapshot.modules.some(m => m.state === 'hibernated')

  return {
    ...gauges,
    isEnergySaving
  }
}
