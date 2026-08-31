import { create } from 'zustand'
import type { UseBoundStore, StoreApi } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { AnalysisQueueSnapshot, AnalysisQueueItem, AnalysisStatus } from '@firefly/types/types'
import { captureEvent } from '../lib/posthog'
import { useVirtualDirectoryStore } from './virtual-directory-store'

interface AnalysisQueueState {
  snapshot: AnalysisQueueSnapshot
  showModal: boolean
  backgroundMode: boolean
  viewMode: 'split' | 'window'
  splitHeight: number
  isSplitOpen: boolean
  isSplitMinimized: boolean
  setIsSplitMinimized: (minimized: boolean) => void
  setViewMode: (mode: 'split' | 'window') => void
  setSplitHeight: (height: number) => void
  setIsSplitOpen: (open: boolean) => void
  setShowModal: (v: boolean) => void
  toggleQueue: () => void
  refresh: () => Promise<void>
  addItems: (
    items: { path: string; name: string; size: number; type: string }[],
    forceReanalyze?: boolean
  ) => Promise<void>
  retryFailed: () => Promise<void>
  clearPending: () => Promise<void>
  clearAll: () => Promise<void>
  deleteItem: (id: number) => Promise<void>
  start: () => Promise<void>
  pause: () => Promise<void>
  reconciliationFiles: Array<{
    fileFingerprint: string
    path: string
    name: string
    smartName: string
    type: string
    extensions: string[]
    workspaceRootPath: string
  }>
  showReconciliationDialog: boolean
  isCheckingReconciliation: boolean
  setShowReconciliationDialog: (v: boolean) => void

  // 批量已分析文件入队二次确认弹窗状态
  showConfirmModal: boolean
  confirmModalFiles: any[]
  pendingAddItems: any[]
  pendingForceReanalyze: boolean
  setShowConfirmModal: (v: boolean) => void
  handleConfirmSkip: () => Promise<void>
  handleConfirmReanalyze: () => Promise<void>
}

const emptySnapshot: AnalysisQueueSnapshot = { items: [], running: false }

// 全局 Store 单例 Key：防止 Vite dev 模式下同一模块被加载为多个实例
// （例如 import URL 带 ?t= 与不带 ?t= 的模块缓存分裂），导致 zustand store
// 被重复创建、各组件订阅不同实例而互不同步（表现为 Footer 点击切换分析队列面板失效）。
const GLOBAL_STORE_KEY = '__fireflyAnalysisQueueStore__'
const GLOBAL_INIT_KEY = '__fireflyAnalysisQueueStoreInitialized__'

type AnalysisQueueStoreInstance = UseBoundStore<StoreApi<AnalysisQueueState>>

/**
 * 获取已挂在 window 上的全局 store 实例，避免模块实例分裂时重复创建
 */
function getExistingGlobalStore(): AnalysisQueueStoreInstance | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as any)[GLOBAL_STORE_KEY]
}

const getInitialViewMode = (): 'split' | 'window' => {
  const saved = localStorage.getItem('queue_view_mode')
  return saved === 'window' ? 'window' : 'split'
}

const getInitialSplitHeight = (): number => {
  const saved = localStorage.getItem('queue_split_height')
  const parsed = saved ? parseInt(saved, 10) : 300
  return isNaN(parsed) ? 300 : Math.max(150, Math.min(parsed, 800))
}

export const useAnalysisQueueStore: AnalysisQueueStoreInstance =
  getExistingGlobalStore() ||
  create<AnalysisQueueState>((set, get) => ({
    snapshot: emptySnapshot,
    showModal: false,
    backgroundMode: false,
    viewMode: getInitialViewMode(),
    splitHeight: getInitialSplitHeight(),
    isSplitOpen: false,
    reconciliationFiles: [],
    showReconciliationDialog: false,
    isCheckingReconciliation: false,

    // 批量已分析文件入队二次确认弹窗状态
    showConfirmModal: false,
    confirmModalFiles: [],
    pendingAddItems: [],
    pendingForceReanalyze: false,
    setShowConfirmModal: v => {
      if (!v) {
        set({
          showConfirmModal: false,
          confirmModalFiles: [],
          pendingAddItems: [],
          pendingForceReanalyze: false
        })
      } else {
        set({ showConfirmModal: true })
      }
    },
    handleConfirmSkip: async () => {
      const { pendingAddItems, confirmModalFiles } = get()
      const stage4Paths = new Set(confirmModalFiles.map(f => f.path))
      const filteredItems = pendingAddItems.filter(i => !stage4Paths.has(i.path))

      // 重置状态并隐藏弹窗
      set({
        showConfirmModal: false,
        confirmModalFiles: [],
        pendingAddItems: [],
        pendingForceReanalyze: false
      })

      if (filteredItems.length > 0) {
        await window.electronAPI!.addToAnalysisQueue(filteredItems, false)
        await get().refresh()
        await get().start()
        // 强制以 split 面板形式打开队列，确保用户可见进度
        useAnalysisQueueStore.setState({
          viewMode: 'split',
          isSplitOpen: true,
          showModal: false,
          isSplitMinimized: false
        })
        window.electronAPI?.setQueueViewMode?.({ mode: 'split', isSplitOpen: true })
      } else {
        await get().refresh()
      }
    },
    handleConfirmReanalyze: async () => {
      const { pendingAddItems } = get()

      // 重置状态并隐藏弹窗
      set({
        showConfirmModal: false,
        confirmModalFiles: [],
        pendingAddItems: [],
        pendingForceReanalyze: false
      })

      if (pendingAddItems.length > 0) {
        await window.electronAPI!.addToAnalysisQueue(pendingAddItems, true)
        await get().refresh()
        await get().start()
        // 强制以 split 面板形式打开队列，确保用户可见进度
        useAnalysisQueueStore.setState({
          viewMode: 'split',
          isSplitOpen: true,
          showModal: false,
          isSplitMinimized: false
        })
        window.electronAPI?.setQueueViewMode?.({ mode: 'split', isSplitOpen: true })
      }
    },

    isSplitMinimized: localStorage.getItem('queue_split_minimized') === 'true',
    setIsSplitMinimized: minimized => {
      localStorage.setItem('queue_split_minimized', String(minimized))
      set({ isSplitMinimized: minimized })
    },

    setViewMode: mode => {
      localStorage.setItem('queue_view_mode', mode)
      const isSplitOpen = mode === 'split'
      set({ viewMode: mode, isSplitOpen, showModal: false, isSplitMinimized: false })
      window.electronAPI?.setQueueViewMode?.({ mode, isSplitOpen })
    },

    setSplitHeight: height => {
      const validHeight = Math.max(150, Math.min(height, window.innerHeight * 0.7))
      localStorage.setItem('queue_split_height', String(validHeight))
      set({ splitHeight: validHeight })
    },

    setIsSplitOpen: open => set({ isSplitOpen: open }),

    setShowModal: v => set({ showModal: v, backgroundMode: !v }),
    setShowReconciliationDialog: v => set({ showReconciliationDialog: v }),

    toggleQueue: () => {
      const { viewMode, isSplitOpen, showModal } = get()
      if (showModal) {
        set({ showModal: false })
        return
      }
      if (viewMode === 'split') {
        const nextOpen = !isSplitOpen
        set({ isSplitOpen: nextOpen, isSplitMinimized: false })
      } else if (isSplitOpen) {
        // viewMode 为 'window' 但 split 面板被强制打开（如批量分析后），
        // 再次点击应关闭而非继续强制打开，保证「队列 x/x」按钮可正常切换显隐
        set({ isSplitOpen: false, showModal: false, isSplitMinimized: false })
      } else {
        // 从工具栏/Footer 点击时，统一切换到底部分栏面板
        // 避免用户因 viewMode 被持久化为 'window' 而无法正常切换队列面板
        set({ viewMode: 'split', isSplitOpen: true, showModal: false, isSplitMinimized: false })
        window.electronAPI?.setQueueViewMode?.({ mode: 'split', isSplitOpen: true })
      }
    },

    refresh: async () => {
      const currentWs = useVirtualDirectoryStore.getState().currentWorkspaceDirectory
      const wsId = currentWs?.id ?? 0
      const snap = await window.electronAPI!.getAnalysisQueue(wsId)
      set({ snapshot: snap as any })
    },

    addItems: async (items, forceReanalyze) => {
      captureEvent('添加分析项目', {
        count: items.length,
        forceReanalyze,
        first_item_type: items[0]?.type
      })

      const checkFn =
        window.electronAPI?.checkAlreadyAnalyzedFiles || window.electronAPI?.checkStage4Files

      if (!forceReanalyze && items.length > 1 && checkFn) {
        try {
          const analyzedRes = await checkFn(items.map(i => i.path))
          if (analyzedRes && analyzedRes.length > 0) {
            const isPathEqual =
              window.electronAPI?.utils?.isPathEqual || ((a: string, b: string) => a === b)
            const analyzedFiles: any[] = []
            items.forEach(item => {
              const hit = analyzedRes.find((res: any) => {
                const resPath = typeof res === 'string' ? res : res?.path
                return resPath && isPathEqual(resPath, item.path)
              })
              if (hit) {
                if (typeof hit === 'object') {
                  analyzedFiles.push({ ...item, ...hit })
                } else {
                  analyzedFiles.push(item)
                }
              }
            })

            if (analyzedFiles.length > 0) {
              set({
                confirmModalFiles: analyzedFiles,
                pendingAddItems: items,
                pendingForceReanalyze: !!forceReanalyze,
                showConfirmModal: true
              })
              return
            }
          }
        } catch (err) {
          console.error('🖥️ 检查已分析文件失败:', err)
        }
      }

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

    start: async (workspaceId?: number | unknown) => {
      const targetWsId =
        typeof workspaceId === 'number'
          ? workspaceId
          : useVirtualDirectoryStore.getState().currentWorkspaceDirectory?.id
      captureEvent('开始分析')
      await window.electronAPI!.startAnalysis(targetWsId)
      await get().refresh()
    },

    pause: async (workspaceId?: number | unknown) => {
      const targetWsId =
        typeof workspaceId === 'number'
          ? workspaceId
          : useVirtualDirectoryStore.getState().currentWorkspaceDirectory?.id
      captureEvent('暂停分析')
      try {
        set(state => ({ snapshot: { ...state.snapshot, running: false } }))
        await window.electronAPI!.pauseAnalysis(targetWsId)
      } catch (e) {
        console.error('🖥️ Store: pause API call failed', e)
      }
      await get().refresh()
    }
  }))

// 仅在首次加载的模块实例上注册全局事件订阅，避免模块实例分裂时重复注册监听器
if (!(typeof window !== 'undefined' && (window as any)[GLOBAL_INIT_KEY])) {
  if (typeof window !== 'undefined') {
    ;(window as any)[GLOBAL_INIT_KEY] = true
  }

  let hasInitialSnapshotLoaded = false

  // Subscribe to workspace directory changes
  useVirtualDirectoryStore.subscribe((state, prevState) => {
    if (state.currentWorkspaceDirectory?.id !== prevState.currentWorkspaceDirectory?.id) {
      hasInitialSnapshotLoaded = false
      useAnalysisQueueStore.getState().refresh()
    }
  })

  // Subscribe to main-process updates once per app
  if (typeof window !== 'undefined' && window.electronAPI) {
    let lastRunningState = false

    const unsub = window.electronAPI!.onAnalysisQueueUpdated((snap: any) => {
      const currentWs = useVirtualDirectoryStore.getState().currentWorkspaceDirectory
      const wsId = currentWs?.id

      // 在 setState 之前保存旧快照，用于比对新增完成项
      const prevSnapshot = useAnalysisQueueStore.getState().snapshot

      const rawItems = snap.items || []
      const filteredItems = wsId
        ? rawItems.filter((i: any) => !i.workspaceId || String(i.workspaceId) === String(wsId))
        : rawItems

      useAnalysisQueueStore.setState({
        snapshot: {
          ...snap,
          items: filteredItems
        }
      })

      const items = snap.items || []
      const completedItems = items.filter((i: any) => i.status === 'completed')

      if (lastRunningState && !snap.running) {
        const failedCount = items.filter((i: any) => i.status === 'failed').length
        const completedCount = completedItems.length

        captureEvent('分析会话结束', {
          total_items: items.length,
          completed_count: completedCount,
          failed_count: failedCount
        })

        // 触发扩展名校准检查（带并发保护和工作区隔离）
        const currentState = useAnalysisQueueStore.getState()
        if (!currentState.isCheckingReconciliation) {
          useAnalysisQueueStore.setState({ isCheckingReconciliation: true })
          window
            .electronAPI!.getCurrentWorkspaceDirectory()
            .then(dir => {
              const workspaceId = dir?.id
              if (workspaceId) {
                window
                  .electronAPI!.checkExtensionMismatch(workspaceId)
                  .then(files => {
                    if (files && files.length > 0) {
                      useAnalysisQueueStore.setState({
                        reconciliationFiles: files,
                        showReconciliationDialog: true
                      })
                    }
                  })
                  .finally(() => {
                    useAnalysisQueueStore.setState({ isCheckingReconciliation: false })
                  })
              } else {
                useAnalysisQueueStore.setState({ isCheckingReconciliation: false })
              }
            })
            .catch(() => {
              useAnalysisQueueStore.setState({ isCheckingReconciliation: false })
            })
        }
      }

      // 检查是否有新的文件分析完成，触发虚拟目录的小红点/呼吸点提示
      // 逻辑：用旧快照 vs 新快照比对，找出新增完成的文件项
      // 注意：初始加载快照时不触发增量提醒，且比对必须基于工作区隔离后的 filteredItems
      if (hasInitialSnapshotLoaded) {
        const currentCompletedFiles = filteredItems.filter(
          (i: any) => i.status === 'completed' && i.itemType === 'file'
        )
        const prevCompletedIds = new Set(
          (prevSnapshot.items || [])
            .filter((i: any) => i.status === 'completed' && i.itemType === 'file')
            .map((i: any) => i.id)
        )

        const newlyCompletedItems = currentCompletedFiles.filter(
          (i: any) => !prevCompletedIds.has(i.id)
        )

        if (newlyCompletedItems.length > 0) {
          // 动态导入避免模块级循环依赖/打包问题
          import('./analyzed-directory-store')
            .then(({ useAnalyzedDirectoryStore }) => {
              useAnalyzedDirectoryStore.getState().incrementNewFilesCount(newlyCompletedItems)
            })
            .catch(err => {
              console.error('🖥️ 无法加载已分析目录Store:', err)
            })
        }
      } else {
        hasInitialSnapshotLoaded = true
      }

      lastRunningState = snap.running
    })

    window.electronAPI.onQueueViewModeChanged(({ mode, isSplitOpen }) => {
      localStorage.setItem('queue_view_mode', mode)
      useAnalysisQueueStore.setState({ viewMode: mode, isSplitOpen })
    })

    // 在订阅后立即执行一次主动刷新，以确保初始状态同步
    useAnalysisQueueStore.getState().refresh()

    // Note: no cleanup here since this module is singleton
  }
}

if (typeof window !== 'undefined') {
  // 注册/复用全局单例，避免 Vite dev 模块实例分裂导致多个 store 状态不同步
  ;(window as any)[GLOBAL_STORE_KEY] = useAnalysisQueueStore
  ;(window as any).useAnalysisQueueStore = useAnalysisQueueStore
}

// 维护快速 Map 缓存，加速基于 ID 和路径的 O(1) 查找，避免大型队列下的线性查找开销
let cachedSnapshot: AnalysisQueueSnapshot | null = null
let cachedIdMap = new Map<number, AnalysisQueueItem>()
let cachedPathMap = new Map<string, AnalysisQueueItem>()

function getQueueMaps(snapshot: AnalysisQueueSnapshot) {
  if (cachedSnapshot === snapshot) {
    return { idMap: cachedIdMap, pathMap: cachedPathMap }
  }
  cachedSnapshot = snapshot
  cachedIdMap = new Map()
  cachedPathMap = new Map()
  const normalize =
    window.electronAPI?.utils?.normalizeForCache ||
    ((p: string) => p.toLowerCase().replace(/[\\/]+$/, ''))

  for (const item of snapshot.items) {
    if (item.id != null) cachedIdMap.set(item.id, item)
    if (item.path) cachedPathMap.set(normalize(item.path), item)
  }
  return { idMap: cachedIdMap, pathMap: cachedPathMap }
}

export function useFileQueueState(itemIdOrPath: string | number, isAnalyzedOnDisk?: boolean) {
  return useAnalysisQueueStore(
    useShallow(state => {
      if (itemIdOrPath === '' || itemIdOrPath === undefined || itemIdOrPath === null) {
        return { status: undefined, error: undefined }
      }

      const isNumericId =
        typeof itemIdOrPath === 'number' ||
        (!isNaN(Number(itemIdOrPath)) &&
          typeof itemIdOrPath === 'string' &&
          itemIdOrPath.trim() !== '')
      const numericId = isNumericId ? Number(itemIdOrPath) : null

      const { idMap, pathMap } = getQueueMaps(state.snapshot)
      let item: AnalysisQueueItem | undefined

      if (numericId !== null) {
        item = idMap.get(numericId)
      }
      if (!item && typeof itemIdOrPath === 'string') {
        const normalize =
          window.electronAPI?.utils?.normalizeForCache ||
          ((p: string) => p.toLowerCase().replace(/[\\/]+$/, ''))
        item = pathMap.get(normalize(itemIdOrPath))
      }

      let status: AnalysisStatus | undefined = undefined
      let error: string | undefined = undefined

      if (item) {
        status = item.status
        error = item.status === 'failed' ? item.error || undefined : undefined
      } else if (isAnalyzedOnDisk) {
        status = 'completed'
      }

      return { status, error }
    })
  )
}
