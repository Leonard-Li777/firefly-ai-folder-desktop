import { create } from 'zustand'
import { AIServiceStatus } from '@firefly/types'
import { useAIServiceStore } from './ai-service-store'
import { useModelStore } from './model-store'

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
  /**
   * 当前激活引擎在引擎列表中的适配类型：
   * 'best' | 'compatible' | 'fallback' | null
   * Footer 仅在 'compatible' 时展示「兼容模式」
   */
  backendMatchType?: 'best' | 'compatible' | 'fallback' | null
  /** 当前加载模型（原始路径/id） */
  model?: string | null
  /** 当前加载模型的展示名称（来自 /api/models 的 name 字段；未匹配时为 null） */
  modelName?: string | null
  vramMb?: number | null
  lastError?: string | null
  updatedAt?: number | null
  /** 引擎已安装模型数量（未连接或引擎未返回时为 null） */
  modelCount?: number | null
  /** 支持的可用模型总数（默认 32） */
  totalModelCount?: number | null
  /** 原始引擎状态（hardware 等 dashboard 增项经此透传） */
  raw?: {
    hardware?: { gpu_name?: string; is_integrated?: boolean; [key: string]: any } | null
    status?: string
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

/** 辅助：当底层推理引擎进入 ready 态时，自愈清除陈旧的历史错误并恢复就绪 */
function healStaleAiServiceErrors(snap: EngineBridgeSnapshotUI | null | undefined): void {
  if (snap?.raw?.status === 'ready') {
    const aiStore = useAIServiceStore.getState()
    if (aiStore.status === AIServiceStatus.ERROR) {
      aiStore.clearError()
      aiStore.updateStatus(AIServiceStatus.IDLE)
    }
    const modelStore = useModelStore.getState()
    if (modelStore.serviceStatus === AIServiceStatus.ERROR && modelStore.modelMode !== 'cloud') {
      useModelStore.setState({
        serviceStatus: AIServiceStatus.IDLE,
        lastError: null,
        modelName: snap.modelName || modelStore.modelName
      })
    }
  }
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
      const snap = (await window.electronAPI.engineBridge.getStatus()) as EngineBridgeSnapshotUI
      set({ snapshot: snap })
      healStaleAiServiceErrors(snap)
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
        const snap = payload as EngineBridgeSnapshotUI
        set({ snapshot: snap, loading: false })
        healStaleAiServiceErrors(snap)
      })
    } catch (e) {
      console.error('订阅引擎桥接状态失败:', e)
    }
    return () => {
      unsub?.()
    }
  }
}))
