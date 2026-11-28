/**
 * DirectoryHeader 共享时钟（J-03 / R-22）
 *
 * 模块级单例 Ticker：同周期的多个 KeepAlive Header 实例共享一个定时器；
 * 引用计数——有订阅者才启动，归零即停（视图卸载后 0 唤醒）；
 * 页面隐藏（document.hidden）时暂停，可见时恢复。
 * 全应用 Header 常驻定时器上限 2 个（5000ms 新闻轮播 / 3600ms 占位符轮播）。
 */
type TickerCallback = () => void

interface TickerEntry {
  callbacks: Set<TickerCallback>
  timer: ReturnType<typeof setInterval> | null
}

const tickers = new Map<number, TickerEntry>()
let visibilityBound = false

function startTimer(intervalMs: number, entry: TickerEntry): void {
  if (entry.timer !== null) return
  entry.timer = setInterval(() => {
    for (const cb of entry.callbacks) cb()
  }, intervalMs)
}

function stopTimer(entry: TickerEntry): void {
  if (entry.timer !== null) {
    clearInterval(entry.timer)
    entry.timer = null
  }
}

/** 全局仅绑定一次 visibilitychange：隐藏暂停全部活跃 Ticker，可见恢复 */
function bindVisibility(): void {
  if (visibilityBound || typeof document === 'undefined') return
  visibilityBound = true
  document.addEventListener('visibilitychange', () => {
    for (const [ms, entry] of tickers) {
      if (entry.callbacks.size === 0) continue
      if (document.hidden) stopTimer(entry)
      else startTimer(ms, entry)
    }
  })
}

/**
 * 订阅共享 Ticker；返回幂等退订函数。
 * 首个订阅者启动定时器，末个退订者停止定时器（StrictMode 双调用安全）。
 */
export function subscribeSharedTicker(intervalMs: number, cb: TickerCallback): () => void {
  let entry = tickers.get(intervalMs)
  if (!entry) {
    entry = { callbacks: new Set(), timer: null }
    tickers.set(intervalMs, entry)
  }
  entry.callbacks.add(cb)
  bindVisibility()
  if (typeof document === 'undefined' || !document.hidden) {
    startTimer(intervalMs, entry)
  }

  let unsubscribed = false
  return () => {
    if (unsubscribed) return
    unsubscribed = true
    entry!.callbacks.delete(cb)
    if (entry!.callbacks.size === 0) {
      stopTimer(entry!)
      tickers.delete(intervalMs)
    }
  }
}

/** 测试辅助：当前活跃的共享定时器数量（验收「全局 ≤2 定时器」） */
export function getActiveSharedTickerCount(): number {
  let count = 0
  for (const entry of tickers.values()) {
    if (entry.timer !== null) count++
  }
  return count
}
