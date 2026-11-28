import { create } from 'zustand'
import type { UseBoundStore, StoreApi } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import { AnalysisQueueSnapshot, AnalysisQueueItem, AnalysisStatus } from '@firefly/types/types'
import { captureEvent } from '../lib/posthog'
import { useVirtualDirectoryStore } from './virtual-directory-store'
import { useSettingsStore } from './settings-store'
import { notifyCloudAnalyzeSuccess, notifyCloudAnalyzeFailure } from '../lib/cloud-engine-probe'
import { toast } from '../components/common/Toast'
import { t } from '@app/languages'
import { SettingsCategory } from '@firefly/types'

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
    items: { path: string; name: string; size: number; type: string; expand?: boolean }[],
    forceReanalyze?: boolean
  ) => Promise<any>
  retryFailed: () => Promise<void>
  clearPending: () => Promise<void>
  clearAll: () => Promise<void>
  deleteItem: (id: number) => Promise<void>
  start: () => Promise<void>
  // 传参可显式指定要暂停的工作目录（默认取当前工作目录）；
  // 队列可能跑在别的工作目录上，此时必须按快照里的 activeRunningWorkspaceId 暂停
  pause: (workspaceId?: number) => Promise<void>
  reconciliationFiles: Array<{
    fileFingerprint: string
    path: string
    name: string
    smartName: string
    extension: string
    extensions: string[]
    workspaceRootPath: string
  }>
  showReconciliationDialog: boolean
  isCheckingReconciliation: boolean
  setShowReconciliationDialog: (v: boolean) => void

  // 批量已分析文件入队二次确认弹窗状态
  showConfirmModal: boolean
  /** 已按当前模式完整分析、可安全跳过的文件 */
  confirmModalFiles: any[]
  /** 已产生分析痕迹但未达当前模式要求、需要补全分析的文件（无论选哪个操作都会入队） */
  confirmModalInsufficientFiles: any[]
  /** 完全未分析的文件（不展示在弹窗列表中，但计入总数） */
  confirmModalUntouchedCount: number
  pendingAddItems: any[]
  pendingForceReanalyze: boolean
  setShowConfirmModal: (v: boolean) => void
  handleConfirmSkip: () => Promise<void>
  handleConfirmReanalyze: () => Promise<void>
}

const emptySnapshot: AnalysisQueueSnapshot = { items: [], running: false }

export interface AnalysisTerminalDelta {
  id: number
  path: string
  workspaceId?: number | string | null
  status: 'completed' | 'failed'
  error?: string
  updatedAt: number
  isDirectory?: boolean
  itemType?: 'file' | 'directory'
}

export interface AnalysisQueueUpdatePayload {
  channel?: string
  wsId?: string
  seq?: number
  snapshotSeq?: number
  resyncRequired?: boolean
  snapshot: AnalysisQueueSnapshot
  terminalDeltas?: AnalysisTerminalDelta[]
}

const GLOBAL_BUCKET_WS = 'global'
const DEFAULT_BUCKET_KIND = 'analysis-queue'
const COALESCER_FALLBACK_TIMEOUT_MS = 50
const MAX_SEEN_TERMINAL_KEYS = 5000

interface NormalizedQueuePayload {
  isDualTrack: boolean
  wsId: string
  kind: string
  seq?: number
  snapshotSeq?: number
  resyncRequired: boolean
  snapshot: AnalysisQueueSnapshot
  terminalDeltas: AnalysisTerminalDelta[]
}

interface RendererBucketState {
  key: string
  wsId: string
  kind: string
  latestSeq: number
  pendingSeq?: number
  pendingSnapshotSeq?: number
  pendingResync: boolean
  pendingIsDualTrack: boolean
  pendingMeta: Omit<AnalysisQueueSnapshot, 'items'> | null
  pendingItemsById: Map<number, AnalysisQueueItem>
  latestFullItemIds: Set<number> | null
  pendingDeltas: AnalysisTerminalDelta[]
  rafId: number | null
  timeoutId: ReturnType<typeof setTimeout> | null
}

function normalizeQueuePayload(raw: unknown): NormalizedQueuePayload {
  const obj = (raw ?? {}) as Record<string, any>
  if (obj && typeof obj === 'object' && 'snapshot' in obj && obj.snapshot) {
    const snap = obj.snapshot as AnalysisQueueSnapshot
    return {
      isDualTrack: true,
      wsId:
        obj.wsId !== undefined && obj.wsId !== null && obj.wsId !== ''
          ? String(obj.wsId)
          : GLOBAL_BUCKET_WS,
      kind: DEFAULT_BUCKET_KIND,
      seq: typeof obj.seq === 'number' ? obj.seq : undefined,
      snapshotSeq: typeof obj.snapshotSeq === 'number' ? obj.snapshotSeq : undefined,
      resyncRequired: obj.resyncRequired === true,
      snapshot: snap,
      terminalDeltas: Array.isArray(obj.terminalDeltas) ? obj.terminalDeltas : []
    }
  }
  const legacySnap = (obj as AnalysisQueueSnapshot) || emptySnapshot
  return {
    isDualTrack: false,
    wsId: GLOBAL_BUCKET_WS,
    kind: DEFAULT_BUCKET_KIND,
    seq: undefined,
    snapshotSeq: undefined,
    resyncRequired: false,
    snapshot: legacySnap,
    terminalDeltas: []
  }
}

export function projectSnapshotForWorkspace(
  raw: AnalysisQueueSnapshot,
  wsId?: number | string | null
): AnalysisQueueSnapshot {
  const rawItems = raw.items || []
  const filteredItems =
    wsId !== undefined && wsId !== null && wsId !== ''
      ? rawItems.filter((i: any) => !i.workspaceId || String(i.workspaceId) === String(wsId))
      : rawItems
  return {
    ...raw,
    items: filteredItems
  }
}

let rawSnapshotState: AnalysisQueueSnapshot = emptySnapshot
const rendererBuckets = new Map<string, RendererBucketState>()
const seenTerminalKeys = new Set<string>()
let hasInitialSnapshotLoaded = false
let lastRunningState = false
let latestGlobalSnapshotSeq = 0
let refreshRequestSeq = 0

function makeTerminalKey(delta: AnalysisTerminalDelta): string {
  return `${delta.id}:${delta.status}:${delta.updatedAt}`
}

function rememberTerminalKey(key: string): boolean {
  if (seenTerminalKeys.has(key)) return false
  if (seenTerminalKeys.size >= MAX_SEEN_TERMINAL_KEYS) {
    const oldest = seenTerminalKeys.values().next().value
    if (oldest !== undefined) seenTerminalKeys.delete(oldest)
  }
  seenTerminalKeys.add(key)
  return true
}

function mergeRawSnapshotFromRefresh(
  snap: AnalysisQueueSnapshot,
  wsId?: number | string | null
): AnalysisQueueSnapshot {
  if (!wsId || wsId === 0 || wsId === GLOBAL_BUCKET_WS) {
    rawSnapshotState = { ...snap, items: (snap.items || []).slice() }
    return rawSnapshotState
  }
  const targetWsStr = String(wsId)
  const preservedOtherItems = (rawSnapshotState.items || []).filter(
    (i: any) => i.workspaceId && String(i.workspaceId) !== targetWsStr
  )
  const incomingIds = new Set((snap.items || []).map(i => i.id))
  const mergedOthers = preservedOtherItems.filter(i => !incomingIds.has(i.id))
  rawSnapshotState = {
    ...snap,
    items: [...mergedOthers, ...(snap.items || [])]
  }
  return rawSnapshotState
}

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
    confirmModalInsufficientFiles: [],
    confirmModalUntouchedCount: 0,
    pendingAddItems: [],
    pendingForceReanalyze: false,
    setShowConfirmModal: v => {
      if (!v) {
        set({
          showConfirmModal: false,
          confirmModalFiles: [],
          confirmModalInsufficientFiles: [],
          confirmModalUntouchedCount: 0,
          pendingAddItems: [],
          pendingForceReanalyze: false
        })
      } else {
        set({ showConfirmModal: true })
      }
    },
    /**
     * 跳过已完成的文件：仅剔除「已按当前模式完整分析」的那部分。
     * 「分析不完整」与「完全未分析」的文件一律照常入队，确保结果最终完整。
     *
     * 注意：当 confirmModalFiles 为空时（所选文件全部属于「需要补全」），
     * 本方法等价于「全部入队」，前端会将其表述为「继续分析」而非「跳过已完成」。
     */
    handleConfirmSkip: async () => {
      const { pendingAddItems, confirmModalFiles } = get()
      const analyzedPaths = new Set(confirmModalFiles.map(f => f.path))
      const itemsToAdd = pendingAddItems.filter(i => !analyzedPaths.has(i.path))

      // 重置状态并隐藏弹窗
      set({
        showConfirmModal: false,
        confirmModalFiles: [],
        confirmModalInsufficientFiles: [],
        confirmModalUntouchedCount: 0,
        pendingAddItems: [],
        pendingForceReanalyze: false
      })

      if (itemsToAdd.length > 0) {
        await window.electronAPI!.addToAnalysisQueue(itemsToAdd, false)
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
    /**
     * 全部重新分析：所选文件整体强制重跑（典型场景：更换模型后希望用新模型重新分析）。
     */
    handleConfirmReanalyze: async () => {
      const { pendingAddItems } = get()

      // 重置状态并隐藏弹窗
      set({
        showConfirmModal: false,
        confirmModalFiles: [],
        confirmModalInsufficientFiles: [],
        confirmModalUntouchedCount: 0,
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
      const reqSeq = ++refreshRequestSeq
      const currentWs = useVirtualDirectoryStore.getState().currentWorkspaceDirectory
      const wsId = currentWs?.id ?? 0
      const snap = await window.electronAPI!.getAnalysisQueue(wsId)
      // 若期间发起了更新的 refresh（例如快速切换工作区），丢弃过时响应防覆写
      if (reqSeq !== refreshRequestSeq) return
      const latestWsId = useVirtualDirectoryStore.getState().currentWorkspaceDirectory?.id
      const merged = mergeRawSnapshotFromRefresh(
        (snap as AnalysisQueueSnapshot) || emptySnapshot,
        wsId
      )
      set({ snapshot: projectSnapshotForWorkspace(merged, latestWsId) })
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

            // 按后端返回的 status 分为两组：
            // - analyzed     : 已按当前模式完整分析，可安全跳过
            // - insufficient : 已分析过但未达当前模式要求，必须入队补全
            const analyzedFiles: any[] = []
            const insufficientFiles: any[] = []
            items.forEach(item => {
              const hit = analyzedRes.find((res: any) => {
                const resPath = typeof res === 'string' ? res : res?.path
                return resPath && isPathEqual(resPath, item.path)
              })
              if (!hit) return
              const merged = typeof hit === 'object' ? { ...item, ...hit } : item
              if (typeof hit === 'object' && hit.status === 'insufficient') {
                insufficientFiles.push(merged)
              } else {
                analyzedFiles.push(merged)
              }
            })

            // 完全未分析的文件数量（既不完整也算不上已达标的那些）
            const reportedCount = analyzedFiles.length + insufficientFiles.length
            const untouchedCount = Math.max(0, items.length - reportedCount)

            // 触发条件：只要存在「已有分析痕迹」的文件就弹窗，而不是仅限于
            // 「可跳过」的那部分。
            //
            // 原因：insufficient（已分析但未达当前模式要求）同样需要用户知情 ——
            // 典型场景是已完成【标准分析】的文件在【全面分析】模式下会被重新分析。
            // 若只以 analyzedFiles 为条件，当所选文件全部是 insufficient 时
            // （例如 68 个已完成标准分析 + 77 个中间态，没有一个是"可跳过"的），
            // 弹窗会被整体跳过并静默入队，用户将完全不知道已完成的部分被重跑。
            if (analyzedFiles.length + insufficientFiles.length > 0) {
              set({
                confirmModalFiles: analyzedFiles,
                confirmModalInsufficientFiles: insufficientFiles,
                confirmModalUntouchedCount: untouchedCount,
                pendingAddItems: items,
                pendingForceReanalyze: !!forceReanalyze,
                showConfirmModal: true
              })
              return { addedCount: 0, updatedCount: 0, blockedCount: 0, blockedWorkspaces: [] }
            }
          }
        } catch (err) {
          console.error('🖥️ 检查已分析文件失败:', err)
        }
      }

      const res = await window.electronAPI!.addToAnalysisQueue(items, forceReanalyze)
      await get().refresh()
      return res || { addedCount: 0, updatedCount: 0, blockedCount: 0, blockedWorkspaces: [] }
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

function cancelBucketTimers(bucket: RendererBucketState): void {
  if (bucket.rafId !== null) {
    if (typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(bucket.rafId)
    }
    bucket.rafId = null
  }
  if (bucket.timeoutId !== null) {
    clearTimeout(bucket.timeoutId)
    bucket.timeoutId = null
  }
}

function getOrCreateRendererBucket(wsId: string, kind: string): RendererBucketState {
  const key = `${wsId}::${kind}`
  let bucket = rendererBuckets.get(key)
  if (!bucket) {
    bucket = {
      key,
      wsId,
      kind,
      latestSeq: 0,
      pendingSeq: undefined,
      pendingResync: false,
      pendingIsDualTrack: false,
      pendingMeta: null,
      pendingItemsById: new Map(),
      latestFullItemIds: null,
      pendingDeltas: [],
      rafId: null,
      timeoutId: null
    }
    rendererBuckets.set(key, bucket)
  }
  return bucket
}

function applyTerminalSideEffects(
  deltas: AnalysisTerminalDelta[],
  isDualTrack: boolean,
  prevSnapshot: AnalysisQueueSnapshot,
  currentSnapshot: AnalysisQueueSnapshot,
  filteredItems: AnalysisQueueItem[]
): void {
  const items = currentSnapshot.items || []
  const completedItems = items.filter((i: any) => i.status === 'completed')

  // PRD-0045：分析管线云端成功点亮「已启动」/失败写入引擎异常（仅生效引擎=cloud 时）
  try {
    const mode = useSettingsStore.getState()?.config?.aiServiceMode
    if (mode === 'cloud') {
      if (isDualTrack) {
        for (const delta of deltas) {
          if (delta.status === 'completed') {
            notifyCloudAnalyzeSuccess()
          } else if (delta.status === 'failed') {
            notifyCloudAnalyzeFailure(delta.error || 'failed', {
              provider: '',
              model: '',
              asActiveEngine: true
            })
          }
        }
      } else {
        const prevCompleted = (prevSnapshot?.items || []).filter(
          (i: any) => i.status === 'completed'
        ).length
        if (completedItems.length > prevCompleted) {
          notifyCloudAnalyzeSuccess()
        }
        const prevFailed = (prevSnapshot?.items || []).filter(
          (i: any) => i.status === 'failed'
        ).length
        const failedItems = items.filter((i: any) => i.status === 'failed')
        if (failedItems.length > prevFailed) {
          const last = failedItems[failedItems.length - 1]
          notifyCloudAnalyzeFailure(
            last?.error || (last as any)?.message || String(last?.status || 'failed'),
            {
              provider: '',
              model: '',
              asActiveEngine: true
            }
          )
        }
      }
    }
  } catch {
    // 状态通知失败不影响分析队列本身
  }

  if (lastRunningState && !currentSnapshot.running) {
    const failedCount = items.filter((i: any) => i.status === 'failed').length
    const completedCount = completedItems.length

    captureEvent('分析会话结束', {
      total_items: items.length,
      completed_count: completedCount,
      failed_count: failedCount
    })

    // 触发扩展名校准检查（带并发保护和工作区隔离）
    const currentState = useAnalysisQueueStore.getState()
    if (
      !currentState.isCheckingReconciliation &&
      window.electronAPI?.getCurrentWorkspaceDirectory
    ) {
      useAnalysisQueueStore.setState({ isCheckingReconciliation: true })
      window.electronAPI
        .getCurrentWorkspaceDirectory()
        .then(dir => {
          const workspaceId = dir?.id
          if (workspaceId && window.electronAPI?.checkExtensionMismatch) {
            window.electronAPI
              .checkExtensionMismatch(workspaceId)
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
  // 双轨模式下 terminalDeltas 本身就是增量事件，不受 hasInitialSnapshotLoaded 门控
  if (isDualTrack) {
    const currentWsId = useVirtualDirectoryStore.getState().currentWorkspaceDirectory?.id
    const newlyCompletedItems = deltas.filter(d => {
      if (d.status !== 'completed') return false
      const isFile = d.itemType ? d.itemType === 'file' : !d.isDirectory
      if (!isFile) return false
      if (currentWsId && d.workspaceId && String(d.workspaceId) !== String(currentWsId)) {
        return false
      }
      return true
    })
    if (newlyCompletedItems.length > 0) {
      import('./analyzed-directory-store')
        .then(({ useAnalyzedDirectoryStore }) => {
          useAnalyzedDirectoryStore.getState().incrementNewFilesCount(newlyCompletedItems as any[])
        })
        .catch(err => {
          console.error('🖥️ 无法加载已分析目录Store:', err)
        })
    }
  } else if (hasInitialSnapshotLoaded) {
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

  lastRunningState = Boolean(currentSnapshot.running)
}

function flushBucket(key: string): void {
  const bucket = rendererBuckets.get(key)
  if (!bucket) return
  cancelBucketTimers(bucket)

  const hasPendingSnapshot = bucket.pendingMeta !== null || bucket.latestFullItemIds !== null
  const hasPendingDeltas = bucket.pendingDeltas.length > 0
  if (!hasPendingSnapshot && !hasPendingDeltas) return

  const prevProjectedSnapshot = useAnalysisQueueStore.getState().snapshot
  const pendingDeltas = bucket.pendingDeltas.splice(0, bucket.pendingDeltas.length)
  const isDualTrack = bucket.pendingIsDualTrack
  const incomingSeq = bucket.pendingSeq
  const incomingSnapshotSeq = bucket.pendingSnapshotSeq
  const resyncRequired = bucket.pendingResync
  const hasSeqGap =
    isDualTrack &&
    incomingSeq !== undefined &&
    bucket.latestSeq > 0 &&
    incomingSeq > bucket.latestSeq + 1

  if (incomingSeq !== undefined && incomingSeq > bucket.latestSeq) {
    bucket.latestSeq = incomingSeq
  }
  bucket.pendingSeq = undefined
  bucket.pendingSnapshotSeq = undefined
  bucket.pendingResync = false
  bucket.pendingIsDualTrack = false

  if (hasPendingSnapshot) {
    // 若主进程提供了全局单调 snapshotSeq，则仅接受 >= latestGlobalSnapshotSeq 的全量快照，
    // 防止 'global' 桶与具体 wsId 桶跨帧乱序覆盖或已删跨区条目复活
    const isStaleGlobalSnapshot =
      incomingSnapshotSeq !== undefined && incomingSnapshotSeq < latestGlobalSnapshotSeq

    if (!isStaleGlobalSnapshot) {
      if (incomingSnapshotSeq !== undefined) {
        latestGlobalSnapshotSeq = incomingSnapshotSeq
      }
      const fullIds = bucket.latestFullItemIds
      const nextItems: AnalysisQueueItem[] = []
      if (incomingSnapshotSeq === undefined && bucket.wsId !== GLOBAL_BUCKET_WS) {
        // 兼容单测直接构造的局部快照：保留其他工作区未覆盖项
        for (const existing of rawSnapshotState.items || []) {
          const ws = (existing as any).workspaceId
          if (ws && String(ws) !== bucket.wsId && (!fullIds || !fullIds.has(existing.id))) {
            nextItems.push(existing)
          }
        }
      }
      if (fullIds) {
        for (const id of fullIds) {
          const merged = bucket.pendingItemsById.get(id)
          if (merged) nextItems.push(merged)
        }
      } else {
        for (const merged of bucket.pendingItemsById.values()) {
          nextItems.push(merged)
        }
      }

      rawSnapshotState = {
        ...(bucket.pendingMeta || rawSnapshotState),
        items: nextItems
      }
    }
    bucket.pendingMeta = null
    bucket.pendingItemsById.clear()
    bucket.latestFullItemIds = null
  }

  const currentWsId = useVirtualDirectoryStore.getState().currentWorkspaceDirectory?.id
  const projected = projectSnapshotForWorkspace(rawSnapshotState, currentWsId)
  useAnalysisQueueStore.setState({ snapshot: projected })

  const freshDeltas = pendingDeltas.filter(d => rememberTerminalKey(makeTerminalKey(d)))
  applyTerminalSideEffects(
    freshDeltas,
    isDualTrack,
    prevProjectedSnapshot,
    rawSnapshotState,
    projected.items
  )

  if ((resyncRequired || hasSeqGap) && typeof window.electronAPI?.getAnalysisQueue === 'function') {
    void useAnalysisQueueStore.getState().refresh()
  }
}

export function flushAnalysisQueueUpdates(): void {
  for (const key of Array.from(rendererBuckets.keys())) {
    flushBucket(key)
  }
}

export function getRawAnalysisQueueSnapshot(): AnalysisQueueSnapshot {
  return rawSnapshotState
}

export function resetAnalysisQueueCoalescerForTest(): void {
  for (const bucket of rendererBuckets.values()) {
    cancelBucketTimers(bucket)
  }
  rendererBuckets.clear()
  seenTerminalKeys.clear()
  rawSnapshotState = emptySnapshot
  hasInitialSnapshotLoaded = false
  lastRunningState = false
  latestGlobalSnapshotSeq = 0
  refreshRequestSeq = 0
}

export function enqueueAnalysisQueueUpdate(rawPayload: unknown): void {
  const normalized = normalizeQueuePayload(rawPayload)
  const bucket = getOrCreateRendererBucket(normalized.wsId, normalized.kind)

  // 忽略乱序/过期旧帧的快照覆盖（但保留未见过的 terminalDeltas）
  const isStaleSeq =
    normalized.isDualTrack &&
    normalized.seq !== undefined &&
    bucket.latestSeq > 0 &&
    normalized.seq <= bucket.latestSeq

  if (!isStaleSeq) {
    bucket.pendingIsDualTrack = bucket.pendingIsDualTrack || normalized.isDualTrack
    if (normalized.seq !== undefined) {
      bucket.pendingSeq =
        bucket.pendingSeq !== undefined
          ? Math.max(bucket.pendingSeq, normalized.seq)
          : normalized.seq
    }
    if (normalized.snapshotSeq !== undefined) {
      bucket.pendingSnapshotSeq =
        bucket.pendingSnapshotSeq !== undefined
          ? Math.max(bucket.pendingSnapshotSeq, normalized.snapshotSeq)
          : normalized.snapshotSeq
    }
    if (normalized.resyncRequired) {
      bucket.pendingResync = true
    }

    const { items = [], ...meta } = normalized.snapshot
    bucket.pendingMeta = meta
    const idSet = new Set<number>()
    for (const item of items) {
      if (item && item.id != null) {
        idSet.add(item.id)
        const prev = bucket.pendingItemsById.get(item.id)
        bucket.pendingItemsById.set(item.id, prev ? { ...prev, ...item } : item)
      }
    }
    bucket.latestFullItemIds = idSet
  }

  if (normalized.terminalDeltas.length > 0) {
    for (const delta of normalized.terminalDeltas) {
      bucket.pendingDeltas.push(delta)
    }
  }

  if (bucket.rafId === null && bucket.timeoutId === null) {
    if (typeof requestAnimationFrame === 'function') {
      bucket.rafId = requestAnimationFrame(() => flushBucket(bucket.key))
    }
    bucket.timeoutId = setTimeout(() => flushBucket(bucket.key), COALESCER_FALLBACK_TIMEOUT_MS)
  }
}

// 仅在首次加载的模块实例上注册全局事件订阅，避免模块实例分裂时重复注册监听器
if (!(typeof window !== 'undefined' && (window as any)[GLOBAL_INIT_KEY])) {
  if (typeof window !== 'undefined') {
    ;(window as any)[GLOBAL_INIT_KEY] = true
  }

  // Subscribe to workspace directory changes
  useVirtualDirectoryStore.subscribe((state, prevState) => {
    if (state.currentWorkspaceDirectory?.id !== prevState.currentWorkspaceDirectory?.id) {
      // 切换 wsId 时：flush 旧桶并取消旧定时器，不得无差别丢弃未消费原始状态
      flushAnalysisQueueUpdates()
      hasInitialSnapshotLoaded = false
      const nextWsId = state.currentWorkspaceDirectory?.id
      useAnalysisQueueStore.setState({
        snapshot: projectSnapshotForWorkspace(rawSnapshotState, nextWsId)
      })
      if (typeof window.electronAPI?.getAnalysisQueue === 'function') {
        useAnalysisQueueStore.getState().refresh()
      }
    }
  })

  // 隐藏态双保险与恢复立刷（B1 / J-01）
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        flushAnalysisQueueUpdates()
      } else if (document.visibilityState === 'visible') {
        flushAnalysisQueueUpdates()
        if (typeof window.electronAPI?.getAnalysisQueue === 'function') {
          void useAnalysisQueueStore.getState().refresh()
        }
      }
    })
  }

  // Subscribe to main-process updates once per app
  if (typeof window !== 'undefined' && window.electronAPI) {
    // 监听分析队列动态刹车事件（当工作区处于 pending 时主动提示并引导配置）
    window.electronAPI.onAnalysisQueueLatchBrake?.((payload: { workspaceId: number }) => {
      toast.warning(
        t('当前工作区尚未配置 AI 策略，分析已暂停。请先完成工作区配置。'),
        6000,
        `latch-brake-${payload.workspaceId}`,
        {
          label: t('前往配置'),
          onClick: () => {
            useSettingsStore.getState().openSettings(SettingsCategory.WORKSPACE_CONFIG, {
              workspaceId: payload.workspaceId
            })
          }
        }
      )
    })

    const unsub = window.electronAPI!.onAnalysisQueueUpdated((payload: any) => {
      enqueueAnalysisQueueUpdate(payload)
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
      if (typeof itemIdOrPath === 'string') {
        const normalize =
          window.electronAPI?.utils?.normalizeForCache ||
          ((p: string) => p.toLowerCase().replace(/[\\/]+$/, ''))
        item = pathMap.get(normalize(itemIdOrPath))
      }

      if (!item && numericId !== null) {
        item = idMap.get(numericId)
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
