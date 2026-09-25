import { create } from 'zustand'

/**
 * 引擎桥接状态快照（渲染层视图，与主进程 EngineBridgeSnapshot 对齐，宽容解析）
 *
 * PRD-0044：渲染层消费面收窄为 dashboard 等效字段——
 * 显卡名等增项经 raw 透传（引擎 /api/engine/status hardware 字段），
 * 模型计数由桥接层从引擎 /api/models 汇总后经 modelCount 提供。
 */
export interface EngineBridgeSnapshotUI {
  connected?: boolean
  circuitState?: string
  available?: boolean
  exePath?: string | null
  devMode?: boolean
  port?: number
  version?: string | null
  backend?: string | null
  model?: string | null
  vramMb?: number | null
  lastError?: string | null
  updatedAt?: number | null
  /** 引擎已安装模型数量（未连接或引擎未返回时为 null） */
  modelCount?: number | null
  /** 原始引擎状态（hardware 等 dashboard 增项经此透传） */
  raw?: {
    hardware?: { gpu_name?: string; is_integrated?: boolean; [key: string]: any } | null
    [key: string]: any
  } | null
}

interface EngineStoreState {
  /** 最近一次桥接快照（未加载时为 null） */
  snapshot: EngineBridgeSnapshotUI | null
  /** 是否正在拉取快照 */
  loading: boolean
  /** 主动拉取一次实时快照（经主进程 healthCheck） */
  load: () => Promise<void>
  /** 拉取初始快照并订阅主进程广播；返回取消订阅函数 */
  subscribe: () => () => void
}

/**
 * 全局引擎状态 store（PRD-0044 任务 #5）
 *
 * 合并页与 Footer 引导条等全局消费方共用这一份快照与订阅，
 * 避免各组件各自 getStatus + 订阅造成重复 IPC 与状态漂移。
 */
export const useEngineStore = create<EngineStoreState>((set, get) => ({
  snapshot: null,
  loading: false,

  load: async () => {
    if (!window.electronAPI?.engineBridge) {
      return
    }
    set({ loading: true })
    try {
      const snap = await window.electronAPI.engineBridge.getStatus()
      set({ snapshot: snap as EngineBridgeSnapshotUI })
    } catch (e) {
      console.error('加载引擎桥接状态失败:', e)
    } finally {
      set({ loading: false })
    }
  },

  subscribe: () => {
    const bridge = window.electronAPI?.engineBridge
    if (!bridge) {
      return () => {}
    }
    void get().load()
    let unsub: (() => void) | undefined
    try {
      unsub = bridge.onStatusChanged(payload => {
        set({ snapshot: payload as EngineBridgeSnapshotUI, loading: false })
      })
    } catch (e) {
      console.error('订阅引擎桥接状态失败:', e)
    }
    return () => {
      unsub?.()
    }
  }
}))
