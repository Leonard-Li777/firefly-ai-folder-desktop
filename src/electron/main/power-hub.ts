/**
 * 主进程 PowerEventHub 单例桥接器（TM-W6 / TM-05 / TM-06）
 *
 * 收敛全部 6 处 `powerMonitor.on('resume')`（engine-bridge 0ms 首顺位错峰唤醒），
 * 并在所有 BrowserWindow 均最小化或不可见时合成 `hidden` 状态（严禁把失焦 blur 判为隐藏）。
 */
import { app, BrowserWindow, powerMonitor } from 'electron'
import { logger, LogCategory } from '@firefly/shared'
import {
  createPowerEventHub,
  type PowerEventHub,
  type PowerEvent,
  type PowerEventListenerOptions
} from '@pro/perf/power-event-hub'

let hubInstance: PowerEventHub | null = null
let windowHooksInstalled = false

export function initPowerEventHub(): PowerEventHub {
  if (hubInstance) return hubInstance

  hubInstance = createPowerEventHub({
    powerMonitor,
    getWindows: () => BrowserWindow.getAllWindows(),
    logger: {
      warn: (msg, err) => logger.warn(LogCategory.SYSTEM, msg, err)
    }
  })

  if (!windowHooksInstalled) {
    windowHooksInstalled = true
    const attachWindow = (win: BrowserWindow) => {
      const notify = () => hubInstance?.notifyWindowStateChanged()
      win.on('show', notify)
      win.on('hide', notify)
      win.on('minimize', notify)
      win.on('restore', notify)
      win.on('closed', notify)
      notify()
    }
    for (const win of BrowserWindow.getAllWindows()) {
      attachWindow(win)
    }
    app.on('browser-window-created', (_event, win) => {
      attachWindow(win)
    })
  }

  return hubInstance
}

export function getPowerEventHub(): PowerEventHub | null {
  return hubInstance
}

export function subscribePowerEvent(
  event: PowerEvent,
  listener: () => void,
  opts?: PowerEventListenerOptions
): () => void {
  const hub = getPowerEventHub()
  if (hub) {
    return hub.on(event, listener, opts)
  }
  const pm = powerMonitor as unknown as {
    on?: (ev: PowerEvent, fn: () => void) => void
    removeListener?: (ev: PowerEvent, fn: () => void) => void
  }
  if (pm && typeof pm.on === 'function') {
    pm.on(event, listener)
    return () => {
      pm.removeListener?.(event, listener)
    }
  }
  return () => {}
}

export function disposePowerEventHub(): void {
  if (hubInstance) {
    hubInstance.dispose()
    hubInstance = null
  }
}

/**
 * TM-10 / D-10：已核实 src/renderer 零引用的纯内部持久化键白名单（fail-open：未入表的配置键照常广播）
 */
export const SILENT_INTERNAL_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'LAST_RUN_TIME',
  'LAST_RUN_TIME_HMAC',
  'LAST_SERVER_CONNECT_TIME',
  'LAST_SERVER_CONNECT_TIME_HMAC',
  'CACHE_KEY_DATA'
])

/** 判定配置变更是否仅涉及静默内部键；若是则跳过 config:change 广播 */
export function shouldSkipConfigBroadcast(
  nextConfig: Record<string, unknown>,
  prevConfig?: Record<string, unknown>
): boolean {
  if (!prevConfig) return false
  const allKeys = new Set([...Object.keys(nextConfig), ...Object.keys(prevConfig)])
  let hasVisibleChange = false
  for (const key of allKeys) {
    if (SILENT_INTERNAL_CONFIG_KEYS.has(key)) continue
    if (!Object.is(nextConfig[key], prevConfig[key])) {
      hasVisibleChange = true
      break
    }
  }
  return !hasVisibleChange
}

/** 从广播载荷中剔除静默内部键 */
export function filterBroadcastConfigPayload<T extends Record<string, unknown>>(config: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(config)) {
    if (!SILENT_INTERNAL_CONFIG_KEYS.has(key)) {
      out[key] = value
    }
  }
  return out as T
}
