/**
 * 工作区运行时上下文 Zustand Store (Group D / SLICE-08)
 *
 * 职责：
 * - 拉取并缓存主进程权威运行时上下文快照（WorkspaceRuntimeContextSnapshot）
 * - 订阅 onWorkspaceRuntimeContextUpdated 推送，按 contextEpoch 单调递增去重
 * - 弹窗打开时 initialize(workspaceId) 握手快照并建订阅，关闭时 dispose 释放
 * - 三态 UI 顶栏横幅与 DegradationCallout 共享此单一事实源
 *
 * 【并行接缝契约】：数据结构 100% 冻结于 L3 规格书 §2.3。
 * Group B 合流后，仅把 workspace-ai-client.ts 内的本地类型替换为 @firefly/shared
 * 权威导出，本 store 调用点零改动。
 *
 * 【反静默降级铁律】：fetchWorkspaceRuntimeContext 返回 null 时必须写入
 * fetchError，严禁静默吞掉并伪装成「无降级」。
 */
import { create } from 'zustand'

import {
  fetchWorkspaceRuntimeContext,
  subscribeWorkspaceRuntimeContext,
  type WorkspaceRuntimeContextSnapshot
} from '../lib/workspace-policy/workspace-ai-client'

const EMPTY_MODULE_STATES: WorkspaceRuntimeContextSnapshot['moduleStates'] = Object.freeze({})

let _refreshSeq = 0

interface WorkspaceRuntimeContextState {
  /** 当前快照（null 表示尚未拉取或主进程返回空） */
  snapshot: WorkspaceRuntimeContextSnapshot | null
  /** 是否正在拉取首次快照 */
  loading: boolean
  /** 拉取失败原因（null 表示无错误） */
  fetchError: string | null
  /** 是否已成功建立订阅 */
  subscribed: boolean
  /** 活跃订阅者引用计数（避免单个弹窗关闭时错杀 Footer 等常驻消费者） */
  subscriberRefCount: number
  /** 当前绑定的工作区 ID（用于 initialize 幂等判定） */
  activeWorkspaceId: number | null
  /** 内部：订阅退订函数（非响应式，不参与渲染） */
  _unsubscribe: (() => void) | null
}

interface WorkspaceRuntimeContextActions {
  /**
   * 消费者挂载握手：递增引用计数、拉取快照并建立订阅（幂等）。
   * 多个消费者共享同一推送订阅，避免单个弹窗关闭时错杀其他消费者。
   */
  initialize: (workspaceId: number | null) => Promise<void>
  /** 拉取最新快照（幂等，带代次防并发竞态，重复调用会覆盖 fetchError） */
  refresh: () => Promise<void>
  /** 递减引用计数；仅当所有消费者均卸载时才断开订阅并清空快照 */
  dispose: () => void
  /** 强制重置 store 到初始态（供测试隔离或全局登出使用） */
  reset: () => void
}

export type WorkspaceRuntimeContextStore = WorkspaceRuntimeContextState &
  WorkspaceRuntimeContextActions

const initialState: WorkspaceRuntimeContextState = {
  snapshot: null,
  loading: false,
  fetchError: null,
  subscribed: false,
  subscriberRefCount: 0,
  activeWorkspaceId: null,
  _unsubscribe: null
}

export const useWorkspaceRuntimeContext = create<
  WorkspaceRuntimeContextState & WorkspaceRuntimeContextActions
>((set, get) => ({
  ...initialState,

  initialize: async (workspaceId) => {
    const prevId = get().activeWorkspaceId
    const alreadySubscribed = get().subscribed
    const nextRefCount = get().subscriberRefCount + 1

    // 幂等：已订阅且同一工作区时不重复注册底层监听，仅递增引用计数并刷新快照
    if (alreadySubscribed && prevId === workspaceId) {
      set({ subscriberRefCount: nextRefCount })
      await get().refresh()
      return
    }

    // 切换工作区或首次建立订阅：先断开旧订阅再重新握手
    const oldUnsub = get()._unsubscribe
    if (typeof oldUnsub === 'function') oldUnsub()

    set({
      activeWorkspaceId: workspaceId,
      subscribed: false,
      subscriberRefCount: nextRefCount,
      _unsubscribe: null
    })

    // 建立订阅（仅接收 contextEpoch 更大的推送）
    const unsubscribe = subscribeWorkspaceRuntimeContext((incoming) => {
      const prev = get().snapshot
      if (prev && incoming.contextEpoch <= prev.contextEpoch) return
      set({ snapshot: incoming, fetchError: null })
    })
    set({ subscribed: true, _unsubscribe: unsubscribe })

    // 首次拉取快照
    await get().refresh()
  },

  refresh: async () => {
    const seq = ++_refreshSeq
    set({ loading: true, fetchError: null })
    try {
      const next = await fetchWorkspaceRuntimeContext(get().activeWorkspaceId)
      // 竞态守卫：若期间发生更新的 refresh、dispose 或 reset（均已递增 _refreshSeq），则丢弃陈旧响应
      if (seq !== _refreshSeq) {
        return
      }
      if (next === null) {
        // 主进程通道未就绪或主动返回空：显式记录，绝不静默清空旧快照
        set({
          loading: false,
          fetchError: 'WORKSPACE_RUNTIME_CONTEXT_SNAPSHOT_UNAVAILABLE'
        })
        return
      }
      const prev = get().snapshot
      // contextEpoch 单调递增保护：旧推送晚到时不覆盖新状态
      if (prev && prev.contextEpoch > next.contextEpoch) {
        set({ loading: false })
        return
      }
      set({ snapshot: next, loading: false, fetchError: null })
    } catch (err) {
      if (seq !== _refreshSeq) return
      // 任何异常必须显式上浮，禁止吞异常
      const message = err instanceof Error ? err.message : String(err)
      set({ loading: false, fetchError: message })
    }
  },

  dispose: () => {
    const nextRefCount = Math.max(0, get().subscriberRefCount - 1)
    if (nextRefCount > 0) {
      set({ subscriberRefCount: nextRefCount })
      return
    }
    _refreshSeq += 1
    const unsub = get()._unsubscribe
    if (typeof unsub === 'function') {
      unsub()
    }
    set({
      snapshot: null,
      loading: false,
      fetchError: null,
      subscribed: false,
      subscriberRefCount: 0,
      activeWorkspaceId: null,
      _unsubscribe: null
    })
  },

  reset: () => {
    _refreshSeq += 1
    const unsub = get()._unsubscribe
    if (typeof unsub === 'function') {
      unsub()
    }
    set({ ...initialState })
  }
}))

/** 派生 selector：当前工作区是否已安装 LibreOffice（影响文档类解析降级提示） */
export const selectLibreOfficeInstalled = (s: WorkspaceRuntimeContextStore): boolean =>
  s.snapshot?.libreOfficeInstalled ?? false

/** 派生 selector：生成式 AI 总开关是否启用 */
export const selectGenerativeAiEnabled = (s: WorkspaceRuntimeContextStore): boolean =>
  s.snapshot?.generativeAiEnabled ?? false

/** 派生 selector：全局向量编码档位（classic_light / gemma_unified / unknown） */
export const selectGlobalEmbeddingProfile = (
  s: WorkspaceRuntimeContextStore
): WorkspaceRuntimeContextSnapshot['globalEmbeddingProfile'] =>
  s.snapshot?.globalEmbeddingProfile ?? 'unknown'

/** 派生 selector：视频推理后端（cpu / gpu / unknown） */
export const selectVideoInferenceBackend = (
  s: WorkspaceRuntimeContextStore
): WorkspaceRuntimeContextSnapshot['videoInferenceBackend'] =>
  s.snapshot?.videoInferenceBackend ?? 'unknown'

/** 派生 selector：是否 Pro 档（影响 free_tier_video_limit 降级提示） */
export const selectIsProTier = (s: WorkspaceRuntimeContextStore): boolean =>
  s.snapshot?.isProTier ?? false

/** 派生 selector：模块可用性字典（pluginId -> availability/installed/active/error） */
export const selectModuleStates = (
  s: WorkspaceRuntimeContextStore
): WorkspaceRuntimeContextSnapshot['moduleStates'] =>
  s.snapshot?.moduleStates ?? EMPTY_MODULE_STATES

/** 派生 selector：是否正在加载首次快照 */
export const selectRuntimeContextLoading = (s: WorkspaceRuntimeContextStore): boolean =>
  s.loading

/** 派生 selector：拉取失败原因（null 表示无错误） */
export const selectRuntimeContextError = (
  s: WorkspaceRuntimeContextStore
): string | null => s.fetchError
