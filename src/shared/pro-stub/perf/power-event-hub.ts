/**
 * 电源与窗口可见性事件分发中枢 —— 开源侧直通存根（`@pro/perf/power-event-hub`）
 *
 * 【存根对称性（D-07）】本文件与 `pro/src/perf/power-event-hub.ts` 必须导出**完全相同**的
 *   运行时符号集合与签名（含 `POWER_EVENT_HUB_IMPL` 标识）。
 *
 * 【直通契约（D-07 铁律）】开源侧 `on()` 直通 `powerMonitor.on(event, listener)`：
 *   四类电源事件全部同步立即执行（无 resume 错峰，与迁移前各模块直挂 powerMonitor 行为一致），
 *   严禁 no-op 吞掉事件。窗口可见性合成（全窗口最小化/不可见才 hidden）是正确性契约而非
 *   Pro 优化，两侧保持同一规则，防止开源 / Pro 行为分裂。
 *
 * 【禁止静默降级】存根生效时在首次订阅时 `warn` 一次，显式说明当前走直通路径（无错峰）。
 */

/** 实现标识：开源直通存根为 `'stub'`（供解析单测与运行期观测） */
export const POWER_EVENT_HUB_IMPL = 'stub' as const

const LOG_PREFIX = '[PowerEventHub]'

export type PowerEvent = 'suspend' | 'resume' | 'lock-screen' | 'unlock-screen'
export type WindowVisibilityState = 'visible' | 'hidden'

export interface PowerMonitorLike {
  on(event: PowerEvent, listener: () => void): void
  removeListener?(event: PowerEvent, listener: () => void): void
}

export interface PowerHubWindowLike {
  isDestroyed(): boolean
  isVisible(): boolean
  isMinimized(): boolean
}

export interface PowerEventHubLoggerLike {
  warn(message: string, error?: unknown): void
}

export interface PowerEventListenerOptions {
  id?: string
  resumeOffsetMs?: number
}

export interface PowerEventHubOptions {
  powerMonitor: PowerMonitorLike
  getWindows?: () => Iterable<PowerHubWindowLike>
  logger?: PowerEventHubLoggerLike
}

export interface PowerEventHub {
  on(event: PowerEvent, listener: () => void, opts?: PowerEventListenerOptions): () => void
  onVisibilityChange(listener: (state: WindowVisibilityState) => void): () => void
  getVisibilityState(): WindowVisibilityState
  notifyWindowStateChanged(): void
  dispose(): void
}

const fallbackLogger: PowerEventHubLoggerLike = {
  warn: (message, error) => {
    console.warn(message, error)
  }
}

export function createPowerEventHub(options: PowerEventHubOptions): PowerEventHub {
  const logger = options.logger ?? fallbackLogger
  const visibilityListeners = new Set<(state: WindowVisibilityState) => void>()
  const directBindings: Array<{ event: PowerEvent; wrapped: () => void }> = []
  let visibility: WindowVisibilityState = 'hidden'
  let disposed = false
  let directPathWarned = false

  const computeVisibility = (): WindowVisibilityState => {
    const windows = options.getWindows?.() ?? []
    for (const win of windows) {
      try {
        if (!win.isDestroyed() && win.isVisible() && !win.isMinimized()) return 'visible'
      } catch (error) {
        logger.warn(`${LOG_PREFIX} 窗口可见性查询失败（按不可见处理）`, error)
      }
    }
    return 'hidden'
  }

  const refreshVisibility = (): void => {
    if (disposed) return
    const next = computeVisibility()
    if (next === visibility) return
    visibility = next
    for (const listener of visibilityListeners) {
      try {
        listener(next)
      } catch (error) {
        logger.warn(`${LOG_PREFIX} 可见性订阅方执行失败`, error)
      }
    }
  }

  visibility = computeVisibility()

  return {
    on(event, listener, _opts = {}) {
      if (disposed) return () => undefined
      if (!directPathWarned) {
        directPathWarned = true
        logger.warn(`${LOG_PREFIX} 当前走直通路径（powerMonitor 直挂，无 resume 错峰）`)
      }
      // 直通 powerMonitor：同步立即执行，忽略 resumeOffsetMs（迁移前行为）
      const wrapped = () => {
        if (disposed) return
        try {
          listener()
        } catch (error) {
          logger.warn(`${LOG_PREFIX} 事件订阅方执行失败: ${event}`, error)
        }
        refreshVisibility()
      }
      options.powerMonitor.on(event, wrapped)
      directBindings.push({ event, wrapped })
      return () => {
        const index = directBindings.findIndex(b => b.wrapped === wrapped)
        if (index >= 0) directBindings.splice(index, 1)
        options.powerMonitor.removeListener?.(event, wrapped)
      }
    },
    onVisibilityChange(listener) {
      if (disposed) return () => undefined
      visibilityListeners.add(listener)
      return () => {
        visibilityListeners.delete(listener)
      }
    },
    getVisibilityState() {
      return visibility
    },
    notifyWindowStateChanged() {
      refreshVisibility()
    },
    dispose() {
      if (disposed) return
      disposed = true
      for (const { event, wrapped } of directBindings) {
        options.powerMonitor.removeListener?.(event, wrapped)
      }
      directBindings.length = 0
      visibilityListeners.clear()
    }
  }
}