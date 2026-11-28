/**
 * 启动全链路时间点采集 —— 开源侧 no-op 存根（Startup Timeline Stub）
 *
 * 【存根对称性（D-07）】`electron.vite.config.mts` 的动态 alias 决定：
 *   - 存在 `pro/src` 时 `@pro/*` → `pro/src/*`（Pro 真实实现）；
 *   - 否则 `@pro/*` → `src/shared/pro-stub/*`（本文件，开源 no-op 存根）。
 *   本文件与 `pro/src/perf/startup-timeline.ts` 必须**导出完全相同**的符号集合
 *   与签名，保证两套构建（Pro / 开源）在业务调用点类型完全兼容。
 *
 * 【零开销契约】开源构建中所有函数均为**物理 no-op**（立即 return），不触发任何
 *   IO / 日志 / IPC，保证开源版启动零额外开销。
 *
 * 【D-02 红线】本模块**严禁**新增任何 PostHog 上报。
 */

import { performance } from 'node:perf_hooks'
import type { LogCategory } from '@firefly/shared'

/** 最小日志接口占位（开源侧仅类型占位） */
export interface StartupTimelineLogger {
  info: (category: LogCategory, ...args: any[]) => void
  warn: (category: LogCategory, ...args: any[]) => void
}

/** 渲染端上报 payload（开源侧仅为类型占位，与 Pro 实现保持一致） */
export interface StartupTimelineRendererPayload {
  name: string
  absTs: number
  process?: 'main' | 'renderer'
}

/** 单个启动时间点（开源侧仅类型占位） */
export interface StartupTimelineMark {
  name: string
  absTs: number
  relMs: number
  process: 'main' | 'renderer'
}

/** 启动时间线快照（开源侧仅类型占位） */
export interface StartupTimelineSnapshot {
  mode: string
  isPackaged: boolean
  platform: string
  marks: StartupTimelineMark[]
  complete: boolean
  missing: string[]
}

/** perf-flags.json 的启动打点开关片段（开源侧仅类型占位） */
export interface StartupTimelineFlags {
  enabled: boolean
  flushToFile?: boolean
}

/** 初始化可选覆盖参数（开源侧仅类型占位） */
export interface InitStartupTimelineOptions {
  userDataDir?: string
  isPackaged?: boolean
  mode?: string
}

/** flush 可选参数（开源侧仅类型占位） */
export interface FlushStartupTimelineOptions {
  force?: boolean
}

/** 复用已有诊断日志 IPC 通道（开源侧与 Pro 保持一致） */
export const STARTUP_TIMELINE_IPC_CHANNEL = 'system:write-diagnostic-log'

/** 经诊断日志通道携带启动时间线打点时的固定标识文件名 */
export const STARTUP_TIMELINE_DIAGNOSTIC_FILENAME = '__startup_timeline_mark__.json'

/** 工单 §9 预期点名（开源侧仅为常量占位，与 Pro 实现保持一致） */
export const STARTUP_TIMELINE_EXPECTED_MARKS: readonly string[] = [
  'bootstrap:start',
  'mod:imports:evaluated',
  'mod:eval:end',
  'app:ready',
  'ipc:registered',
  'splash:shown',
  'main:created',
  'main:ready-to-show',
  'hw:detected',
  'cloud:registered',
  'db:journal-recovered',
  'db:ready',
  'license:local',
  'region:done',
  'engine:ready',
  'omni:ready',
  'renderer:first-paint',
  'renderer:first-list-painted',
  'renderer:phase:ready',
  'full:done'
]

/** no-op：开源侧不注入日志器 */
export function setStartupTimelineLogger(_loggerInstance: StartupTimelineLogger | null): void {
  /* no-op */
}

/** 开源侧恒为关闭，所有 mark 物理不记录 */
export function isEnabled(): boolean {
  return false
}

/** no-op：开源侧不采集任何时间点 */
export function initStartupTimeline(
  _absTsBootstrapStart?: number,
  _options?: InitStartupTimelineOptions
): void {
  /* no-op */
}

/** no-op：开源侧不记录时间点 */
export function mark(_name: string): void {
  /* no-op */
}

/** no-op：开源侧不记录时间点 */
export function markAt(
  _name: string,
  _absTs: number,
  _proc: 'main' | 'renderer' = 'main'
): void {
  /* no-op */
}

/** no-op：开源侧不记录渲染端时间点 */
export function recordRendererMark(_payload: StartupTimelineRendererPayload): void {
  /* no-op */
}

/** 取当前进程的绝对时间戳（开源侧仅返回当前值，供调用点类型兼容，不记录） */
export function nowAbs(): number {
  return performance.timeOrigin + performance.now()
}

/** 开源侧返回空快照 */
export function getMarks(): StartupTimelineSnapshot {
  return {
    mode: 'development',
    isPackaged: false,
    platform: process.platform,
    marks: [],
    complete: false,
    missing: [...STARTUP_TIMELINE_EXPECTED_MARKS]
  }
}

/** no-op：开源侧不输出任何日志 / 文件 */
export function flush(_options?: FlushStartupTimelineOptions): StartupTimelineSnapshot | null {
  return null
}

/** no-op：开源侧不输出任何日志 / 文件 */
export function flushIfNeeded(): StartupTimelineSnapshot | null {
  return null
}

/** 仅供单元测试：开源侧 no-op */
export function resetStartupTimelineForTest(): void {
  /* no-op */
}
