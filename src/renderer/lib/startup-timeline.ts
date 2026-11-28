/**
 * 渲染端启动时间线打点上报器（W0-02）
 *
 * - 关闭时（`isStartupTimelineEnabled !== true`）立即 return，零性能计算与零 IPC 调用；
 * - 开启时统一以浏览器 `performance.timeOrigin + performance.now()` 计算绝对毫秒时间戳，
 *   经**已有**诊断 IPC 通道（`system:write-diagnostic-log`）上报给主进程统一对齐与单行导出；
 * - 每个点名在整个页面生命周期内仅上报一次（幂等）。
 */

const DIAGNOSTIC_FILENAME = '__startup_timeline_mark__.json'
const reportedMarks = new Set<string>()

export type RendererStartupMarkName =
  | 'renderer:first-paint'
  | 'renderer:first-list-painted'
  | 'renderer:phase:ready'

/** 判断当前窗口是否开启了启动时间线打点 */
export function isRendererStartupTimelineEnabled(): boolean {
  if (typeof window === 'undefined') return false
  return window.electronAPI?.isStartupTimelineEnabled === true
}

/** 立即上报一个渲染端时间点（已关闭或重复上报时零开销跳过） */
export function reportRendererStartupMark(name: RendererStartupMarkName): void {
  if (!isRendererStartupTimelineEnabled()) return
  if (reportedMarks.has(name)) return
  reportedMarks.add(name)

  const writeDiagnosticLog = window.electronAPI?.writeDiagnosticLog
  if (typeof writeDiagnosticLog !== 'function') return

  const absTs = performance.timeOrigin + performance.now()
  void writeDiagnosticLog(
    DIAGNOSTIC_FILENAME,
    JSON.stringify({ name, absTs, process: 'renderer' })
  ).catch(() => {
    // 诊断埋点失败绝不干扰渲染主流程
  })
}

/**
 * 等待浏览器完成当前提交帧的绘制后上报时间点（双 requestAnimationFrame）。
 * 若当前环境无 `requestAnimationFrame`（如 jsdom 单测），同步退化为直接上报。
 */
export function reportRendererStartupMarkAfterPaint(name: RendererStartupMarkName): () => void {
  if (!isRendererStartupTimelineEnabled() || reportedMarks.has(name)) {
    return () => {}
  }
  if (typeof window.requestAnimationFrame !== 'function') {
    reportRendererStartupMark(name)
    return () => {}
  }

  let cancelled = false
  let innerRaf = 0
  const outerRaf = window.requestAnimationFrame(() => {
    if (cancelled) return
    innerRaf = window.requestAnimationFrame(() => {
      if (cancelled) return
      reportRendererStartupMark(name)
    })
  })

  return () => {
    cancelled = true
    window.cancelAnimationFrame?.(outerRaf)
    if (innerRaf) window.cancelAnimationFrame?.(innerRaf)
  }
}

/** 仅供单元测试重置渲染端去重集合 */
export function resetRendererStartupTimelineForTest(): void {
  reportedMarks.clear()
}
