/**
 * 零依赖的事件总线：让四大单例在状态变更写出口只需 emit 一个通知，
 * 由 `WorkspaceRuntimeContextService` 统一合并递增 `contextEpoch` 并广播。
 * 刻意不 import 任何 service，避免与单例之间形成循环依赖。
 */
type ChangeListener = (reason: string) => void

const listeners = new Set<ChangeListener>()

export function subscribeRuntimeContextChange(listener: ChangeListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitRuntimeContextChange(reason: string): void {
  for (const listener of listeners) {
    try {
      listener(reason)
    } catch (error) {
      console.warn('[WorkspaceRuntimeContext] 监听器执行失败:', error)
    }
  }
}
