/**
 * 开源社区版存根：主进程 IPC 发送计数 + 定时器唤醒采样（`@pro/perf/ipc-counter`）
 *
 * 闭源 Pro 侧真实实现见 `apps/desktop/pro/src/perf/ipc-counter.ts`。
 * 本存根的**导出签名必须与真实实现逐项一致**（含类型与常量），否则开源构建会出现
 * 「编译过、运行期字段缺失」的静默错位；改签名时两侧必须同步修改。
 *
 * 存根语义：能力不存在（而非能力降级）——安装与采样一律返回 `false`，不强改任何全局定时器，
 * 摘要返回全零结构但保持与真实实现完全相同的字段，调用方与落盘脚本无需分支处理。
 */

/** IPC 计数开关（与真实实现保持一致） */
export const IPC_COUNTER_ENV_SWITCH = 'FF_IPC_COUNTER'
/** 定时器唤醒采样开关（与真实实现保持一致） */
export const TIMER_WAKE_SAMPLER_ENV_SWITCH = 'FF_TIMER_WAKE_SAMPLER'
/** 统计窗口默认 60s（与真实实现保持一致） */
export const DEFAULT_DIAGNOSTICS_WINDOW_MS = 60_000
/** 默认保留最近 30 个窗口（与真实实现保持一致） */
export const MAX_DIAGNOSTICS_WINDOWS = 30
/** 定时器句柄跟踪上限（与真实实现保持一致） */
export const MAX_TRACKED_TIMER_HANDLES = 10_000
/** 单条消息字节估算节点预算（与真实实现保持一致） */
export const MAX_PAYLOAD_ESTIMATE_NODES = 4_096
/** 单条消息字节估算深度上限（与真实实现保持一致） */
export const MAX_PAYLOAD_ESTIMATE_DEPTH = 8
/** Electron 新增窗口事件名（与真实实现保持一致） */
export const WEB_CONTENTS_CREATED_EVENT = 'web-contents-created'

export interface IpcCounterLoggerLike {
  info?: (message: string) => void
  warn?: (message: string, error?: unknown) => void
}

export interface WebContentsLike {
  send: (...args: unknown[]) => unknown
  [key: string]: unknown
}

export interface AppLike {
  isPackaged?: boolean
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown
  off?: (event: string, listener: (...args: unknown[]) => void) => unknown
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => unknown
}

export interface IpcCounterInstallOptions {
  force?: boolean
  logger?: IpcCounterLoggerLike
  windowMs?: number
  maxWindows?: number
  webContents?: WebContentsLike[]
  app?: AppLike
  attachListener?: boolean
}

export interface TimerWakeSamplerOptions {
  force?: boolean
  logger?: IpcCounterLoggerLike
  windowMs?: number
  maxWindows?: number
  captureStack?: boolean
}

export interface IpcDiagnosticsOptions extends IpcCounterInstallOptions, TimerWakeSamplerOptions {
  ipc?: boolean
  timerWakeSampler?: boolean
}

export interface IpcChannelCounters {
  channel: string
  messages: number
  bytes: number
  unmeasuredMessages: number
  truncatedMessages: number
  messagesPerMinute: number
  bytesPerMinute: number
}

export interface IpcTimerSiteSummary {
  kind: 'interval' | 'timeout'
  site: string
  periodMs: number
  registered: number
  fired: number
  active: number
  cleared: number
  firesPerMinute: number
}

export interface IpcTimerSummary {
  sites: number
  registered: number
  fired: number
  active: number
  cleared: number
  droppedHandles: number
  sitesDetail: IpcTimerSiteSummary[]
}

export interface IpcDiagnosticsWindowSummary {
  startedAt: string
  windowMs: number
  elapsedMs: number
  timerFires: number
  timerFiresPerMinute: number
  channels: IpcChannelCounters[]
}

export interface IpcCounterGateSummary {
  ipcCounterSwitch: string | null
  timerWakeSamplerSwitch: string | null
  nodeEnv: string | null
  packaged: boolean | null
}

export interface IpcCounterSummary {
  enabled: { ipcCounter: boolean; timerWakeSampler: boolean }
  gate: IpcCounterGateSummary
  startedAt: string | null
  uptimeMs: number
  windowMs: number
  totals: {
    messages: number
    bytes: number
    unmeasuredMessages: number
    truncatedMessages: number
    messagesPerMinute: number
    bytesPerMinute: number
    channels: IpcChannelCounters[]
  }
  timers: IpcTimerSummary
  window: IpcDiagnosticsWindowSummary | null
  windows: IpcDiagnosticsWindowSummary[]
  notes: string[]
}

export interface IpcDiagnosticsStatus {
  ipcCounter: boolean
  timerWakeSampler: boolean
  windowMs: number
}

export interface IpcCounterStatus {
  ipcCounter: boolean
  timerWakeSampler: boolean
  instrumentedWebContents: number
  trackedTimerSites: number
  windowMs: number
}

/** 社区版不包装 `webContents.send` */
export function instrumentIpcSend(
  _contents: WebContentsLike,
  _logger?: IpcCounterLoggerLike | null
): boolean {
  return false
}

/** 社区版无包装可还原 */
export function uninstrumentIpcSend(_contents: WebContentsLike): boolean {
  return false
}

/** 社区版无 IPC 发送计数能力 */
export function installIpcSendCounter(_options: IpcCounterInstallOptions = {}): boolean {
  return false
}

export function stopIpcSendCounter(): void {
  // 无包装可停止
}

/** 社区版不强改任何全局定时器 */
export function startTimerWakeSampler(_options: TimerWakeSamplerOptions = {}): boolean {
  return false
}

export function stopTimerWakeSampler(): void {
  // 无采样器可停止
}

export function startIpcDiagnostics(_options: IpcDiagnosticsOptions = {}): IpcDiagnosticsStatus {
  return { ipcCounter: false, timerWakeSampler: false, windowMs: DEFAULT_DIAGNOSTICS_WINDOW_MS }
}

export function stopIpcDiagnostics(): void {
  // 无诊断通道可停止
}

export function resetIpcCounterStatistics(): void {
  // 无统计可重置
}

export function getIpcCounterStatus(): IpcCounterStatus {
  return {
    ipcCounter: false,
    timerWakeSampler: false,
    instrumentedWebContents: 0,
    trackedTimerSites: 0,
    windowMs: DEFAULT_DIAGNOSTICS_WINDOW_MS
  }
}

/** 社区版返回全零摘要：字段与真实实现完全一致，落盘脚本无需分支 */
export function getIpcCounterSummary(): IpcCounterSummary {
  return {
    enabled: { ipcCounter: false, timerWakeSampler: false },
    gate: {
      ipcCounterSwitch: null,
      timerWakeSamplerSwitch: null,
      nodeEnv: null,
      packaged: null
    },
    startedAt: null,
    uptimeMs: 0,
    windowMs: DEFAULT_DIAGNOSTICS_WINDOW_MS,
    totals: {
      messages: 0,
      bytes: 0,
      unmeasuredMessages: 0,
      truncatedMessages: 0,
      messagesPerMinute: 0,
      bytesPerMinute: 0,
      channels: []
    },
    timers: {
      sites: 0,
      registered: 0,
      fired: 0,
      active: 0,
      cleared: 0,
      droppedHandles: 0,
      sitesDetail: []
    },
    window: null,
    windows: [],
    notes: ['社区版存根：未启用 IPC 计数与定时器唤醒采样，所有统计恒为 0']
  }
}

export function formatIpcCounterSummaryJson(space = 2): string {
  return JSON.stringify(getIpcCounterSummary(), null, space)
}

export function logIpcCounterSummary(_logger?: IpcCounterLoggerLike | null): void {
  // 社区版不输出诊断摘要
}

export function isTimerWakeSamplerRunning(): boolean {
  return false
}

export function isIpcSendCounterInstalled(): boolean {
  return false
}
