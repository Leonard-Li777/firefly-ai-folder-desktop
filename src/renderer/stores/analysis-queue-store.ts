import { create } from 'zustand'
import { AnalysisQueueSnapshot, AnalysisQueueItem } from '@yonuc/types/types'
import { captureEvent } from '../lib/posthog'

// 使用全局定义的 AnalysisQueue 类型（来自 electron-api.d.ts）
type AnalysisQueue = {
  items: AnalysisQueueItem[]
  status: import('@yonuc/types').AnalysisQueueStatus
  running: boolean
  currentItem?: AnalysisQueueItem
}

interface AnalysisQueueState {
  snapshot: AnalysisQueueSnapshot
  showModal: boolean
  backgroundMode: boolean
  setShowModal: (v: boolean) => void
  openModal: () => void
  closeModal: () => void
  refresh: () => Promise<void>
  addItems: (items: { path: string; name: string; size: number; type: string }[], forceReanalyze?: boolean) => Promise<void>
  retryFailed: () => Promise<void>
  clearPending: () => Promise<void>
  clearAll: () => Promise<void>
  deleteItem: (id: number) => Promise<void>
  start: () => Promise<void>
  pause: () => Promise<void>
}

const emptySnapshot: AnalysisQueueSnapshot = { items: [], running: false }

export const useAnalysisQueueStore = create<AnalysisQueueState>((set, get) => ({
  snapshot: emptySnapshot,
  showModal: false,
  backgroundMode: false,

  setShowModal: (v) => set({ showModal: v, backgroundMode: !v ? true : false }),
  openModal: () => set({ showModal: true, backgroundMode: false }),
  closeModal: () => set({ showModal: false, backgroundMode: true }),

  refresh: async () => {
    const snap = await window.electronAPI!.getAnalysisQueue()
    set({ snapshot: snap as any })
  },

  addItems: async (items, forceReanalyze) => {
    // 使用 addToAnalysisQueue 而不是 addToAnalysisQueueResolved
    // 这样文件夹会原样加入队列，只在AI分析时才展开子内容
    captureEvent('添加分析项目', {
      count: items.length,
      forceReanalyze,
      first_item_type: items[0]?.type
    })
    await window.electronAPI!.addToAnalysisQueue(items, forceReanalyze)
    await get().refresh()
  },

  retryFailed: async () => {
    captureEvent('点击重试失败分析')
    await window.electronAPI!.retryFailedAnalysis()
    await get().refresh()
  },

  clearPending: async () => {
    captureEvent('点击清除待处理分析')
    await window.electronAPI!.clearPendingAnalysis()
    await get().refresh()
  },

  clearAll: async () => {
    captureEvent('点击清空所有队列')
    await window.electronAPI!.clearAllAnalysis()
    await get().refresh()
  },

  deleteItem: async (id: number) => {
    await window.electronAPI!.deleteAnalysisItem(String(id))
    await get().refresh()
  },

  start: async () => {
    console.log('[Frontend] Store: start called')
    captureEvent('开始分析')
    await window.electronAPI!.startAnalysis()
    await get().refresh()
  },

  pause: async () => {
    console.log('[Frontend] Store: pause called')
    captureEvent('暂停分析')
    try {
      // Optimistic update
      set(state => ({ snapshot: { ...state.snapshot, running: false } }))
      await window.electronAPI!.pauseAnalysis()
      console.log('[Frontend] Store: pause API call success')
    } catch (e) {
      console.error('[Frontend] Store: pause API call failed', e)
    }
    await get().refresh()
  },
}))

// Subscribe to main-process updates once per app
if (typeof window !== 'undefined' && window.electronAPI) {
  let lastRunningState = false;

  const unsub = window.electronAPI!.onAnalysisQueueUpdated((snap: any) => {
    console.log('[Frontend] Store: onAnalysisQueueUpdated', snap)
    
    // 跟踪分析完成
    if (lastRunningState && !snap.running) {
      const items = snap.items || [];
      const failedCount = items.filter((i: any) => i.status === 'failed').length;
      const completedCount = items.filter((i: any) => i.status === 'completed').length;
      
      captureEvent('分析会话结束', {
        total_items: items.length,
        completed_count: completedCount,
        failed_count: failedCount
      });
    }
    
    lastRunningState = snap.running;
    useAnalysisQueueStore.setState({ snapshot: snap })
  })

  // 在订阅后立即执行一次主动刷新，以确保初始状态同步
  useAnalysisQueueStore.getState().refresh();

  // Note: no cleanup here since this module is singleton
}
