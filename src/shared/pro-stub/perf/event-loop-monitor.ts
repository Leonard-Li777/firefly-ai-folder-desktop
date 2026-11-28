/**
 * 开源社区版存根：主进程事件循环延迟监控（`@pro/perf/event-loop-monitor`）
 *
 * 闭源 Pro 侧真实实现见 `apps/desktop/pro/src/perf/event-loop-monitor.ts`。
 * 本存根的**导出签名必须与真实实现逐项一致**（含类型与常量），否则开源构建会出现
 * 「编译过、运行期字段缺失」的静默错位；改签名时两侧必须同步修改。
 *
 * 存根语义：能力不存在（而非能力降级）——所有查询返回 `null` / `false`，不写日志、不上报，
 * 调用方必须按返回的布尔与 `null` 显式降级，不得假定监控已生效。
 */

/** 采样窗口默认 10s（与真实实现保持一致） */
export const DEFAULT_EVENT_LOOP_WINDOW_MS = 10_000
/** p99 告警阈值默认 50ms（与真实实现保持一致） */
export const DEFAULT_EVENT_LOOP_THRESHOLD_MS = 50
/** 上报事件名（与真实实现保持一致） */
export const EVENT_LOOP_DELAY_EXCEEDED_EVENT = 'perf:event_loop_delay_exceeded'

export interface EventLoopMonitorLoggerLike {
  warn(message: string, error?: unknown): void
}

export type EventLoopDelayReporter = (event: string, properties: Record<string, unknown>) => void

export interface EventLoopDelayHistogramLike {
  enable(): void
  disable(): void
  reset(): void
  percentile(percentile: number): number
  readonly max: number
  readonly mean: number
  readonly count: number
}

export interface EventLoopDelayMonitorOptions {
  windowMs?: number
  thresholdMs?: number
  resolutionMs?: number
  minReportIntervalMs?: number
  logger?: EventLoopMonitorLoggerLike
  reporter?: EventLoopDelayReporter
  force?: boolean
  createHistogram?: (options: { resolution: number }) => EventLoopDelayHistogramLike
}

export interface EventLoopDelaySample {
  at: string
  windowMs: number
  samples: number
  p50Ms: number
  p99Ms: number
  maxMs: number
  meanMs: number
  thresholdMs: number
  exceeded: boolean
}

export interface EventLoopMonitorStatus {
  running: boolean
  reporting: boolean
  windowMs: number
  thresholdMs: number
  lastSample: EventLoopDelaySample | null
}

/** 社区版无事件循环延迟上报监控能力 */
export function startEventLoopDelayMonitor(
  _options: EventLoopDelayMonitorOptions = {}
): boolean {
  return false
}

/** 社区版不提供静默采样器 */
export function ensureEventLoopDelaySampler(
  _options: EventLoopDelayMonitorOptions = {}
): boolean {
  return false
}

export function stopEventLoopDelayMonitor(): void {
  // 无采样器可停止
}

/** 社区版无观测数据：明确返回 null，调用方据此按未知态降级 */
export function getRecentEventLoopP99Ms(): number | null {
  return null
}

export function getRecentEventLoopDelaySample(): EventLoopDelaySample | null {
  return null
}

export function isEventLoopDelayMonitorRunning(): boolean {
  return false
}

export function getEventLoopMonitorStatus(): EventLoopMonitorStatus {
  return {
    running: false,
    reporting: false,
    windowMs: DEFAULT_EVENT_LOOP_WINDOW_MS,
    thresholdMs: DEFAULT_EVENT_LOOP_THRESHOLD_MS,
    lastSample: null
  }
}
