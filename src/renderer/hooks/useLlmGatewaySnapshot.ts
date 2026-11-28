/**
 * 大模型统一网关快照共享订阅 Hook（TM-W2 / J-02）
 *
 * Footer（原 3s 轮询）与引擎设置页（原 5s 轮询）共享同一份模块级快照、
 * 同一条主进程 push 订阅与同一个受控退避兜底控制器：
 * - push 优先：订阅 `llm-gateway/snapshot-changed`，状态变更实时上屏；
 * - 启动未就绪 / 推通道不可用 / 极端断连窗口：经 `createPushFirstFallback`
 *   受控退避兜底拉取，就绪后立即停表（push 可用时 0 常驻定时器）；
 * - `visibilitychange` 切回可见时一次性重同步（事件驱动，非周期轮询）；
 * - 引用计数保护：最后一个消费者卸载时释放订阅与定时器并清空缓存，
 *   下次挂载重新握手，避免跨测试 / 跨会话陈旧快照滞留。
 */
import { useEffect, useSyncExternalStore } from 'react'
import type { GenerativeEngineSnapshot } from '@firefly/shared'
import { createPushFirstFallback, type PushFirstFallbackHandle } from '../lib/push-first-fallback'

let sharedSnapshot: GenerativeEngineSnapshot | null = null
const listeners = new Set<() => void>()
let refCount = 0
let unsubscribePush: (() => void) | null = null
let fallback: PushFirstFallbackHandle | null = null
let visibilityHandler: (() => void) | null = null
/** 拉取代次：push 到达或更新的拉取发起时递增，陈旧 pull 响应一律丢弃（防状态覆盖） */
let pullSeq = 0

function emitChange(): void {
  for (const listener of listeners) listener()
}

function subscribeStore(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getLlmGatewayApi() {
  if (typeof window === 'undefined') return undefined
  return window.electronAPI?.llmGateway
}

/** 兜底 / 重同步拉取：返回 true 表示快照已就绪（可停表） */
async function pullOnce(): Promise<boolean> {
  const api = getLlmGatewayApi()
  if (typeof api?.getSnapshot !== 'function') return false
  const seq = ++pullSeq
  try {
    const snap = (await api.getSnapshot()) as GenerativeEngineSnapshot | null
    // 竞态守卫：期间已有 push 或更新的拉取接管，丢弃陈旧响应
    if (seq !== pullSeq) return true
    if (snap) {
      sharedSnapshot = snap
      emitChange()
      return true
    }
    return false
  } catch (err) {
    console.warn('[LlmGatewaySnapshot] 拉取网关快照失败:', err)
    return false
  }
}

/** 手动刷新入口（设置页 CPU 仪表盘 onRefresh 等显式交互用） */
async function refreshLlmGatewaySnapshot(): Promise<void> {
  const ready = await pullOnce()
  if (ready) {
    fallback?.notifyReady()
  } else {
    // 拉取失败视为极端断连窗口：push 可用时重新进入受控退避兜底
    fallback?.notifyDisconnected()
  }
}

function acquire(): void {
  refCount += 1
  if (refCount > 1) return

  const api = getLlmGatewayApi()
  const pushAvailable = typeof api?.onSnapshotChanged === 'function'
  if (pushAvailable) {
    try {
      unsubscribePush = api!.onSnapshotChanged!(snap => {
        if (!snap) return
        // push 为权威最新态：作废在途 pull 响应，防止旧拉取覆盖新推送
        pullSeq += 1
        sharedSnapshot = snap
        emitChange()
        fallback?.notifyReady()
      })
    } catch (err) {
      console.warn('[LlmGatewaySnapshot] 订阅网关快照推送失败:', err)
    }
  }

  fallback = createPushFirstFallback({ pull: pullOnce, pushAvailable })
  fallback.start()

  // 断连窗口重同步：切回可见时一次性拉取对齐（事件驱动，无周期定时器）
  visibilityHandler = () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
    void pullOnce().then(ready => {
      if (ready) {
        fallback?.notifyReady()
      } else {
        fallback?.notifyDisconnected()
      }
    })
  }
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', visibilityHandler)
  }
}

function release(): void {
  refCount = Math.max(0, refCount - 1)
  if (refCount > 0) return
  unsubscribePush?.()
  unsubscribePush = null
  fallback?.dispose()
  fallback = null
  if (visibilityHandler && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', visibilityHandler)
  }
  visibilityHandler = null
  pullSeq += 1
  sharedSnapshot = null
  emitChange()
}

export interface UseLlmGatewaySnapshotResult {
  snapshot: GenerativeEngineSnapshot | null
  /** 显式刷新（用户交互触发，非轮询） */
  refresh: () => Promise<void>
}

/**
 * 共享网关快照订阅：多消费者共用一条 push 订阅与一个兜底控制器。
 * 返回的 snapshot 与主进程 `LlmGatewayService.getSnapshot()` 结构一致。
 */
export function useLlmGatewaySnapshot(): UseLlmGatewaySnapshotResult {
  const snapshot = useSyncExternalStore(
    subscribeStore,
    () => sharedSnapshot,
    () => null
  )

  useEffect(() => {
    acquire()
    return () => {
      release()
    }
  }, [])

  return { snapshot, refresh: refreshLlmGatewaySnapshot }
}
