/**
 * 插件运行时沙箱与宿主生命周期核心类型定义
 *
 * 遵循 L3 深度技术规格书：plugin-runtime-sandbox-and-omni-seams-spec.md §2 与 §4.2
 */

/**
 * 宿主显式 7 态生命周期状态
 */
export type PluginHostState =
  | 'STOPPED'
  | 'STARTING'
  | 'READY'
  | 'BUSY'
  | 'TERMINATING'
  | 'CLEANING'
  | 'RETIRING'

/**
 * 进程退出四态分类
 */
export type ExitClassification = 'RETIRING' | 'WATCHDOG' | 'NATIVE_CRASH' | 'PRE_HANDSHAKE'

/**
 * 原生确定性崩溃退出码常量（Windows NTSTATUS）
 * 注意：在 Node/Electron 下 exitCode 可能以有符号 32 位整型呈现，比较时需转换为无符号无符号整型 (code >>> 0)
 */
export const NATIVE_CRASH_CODES = {
  STATUS_ACCESS_VIOLATION: 0xc0000005, // 3221225477 / -1073741819
  STATUS_STACK_OVERFLOW: 0xc00000fd, // 3221225725 / -1073741571
  STATUS_STACK_BUFFER_OVERRUN: 0xc0000409 // 3221226505 / -1073740791
} as const

/**
 * 任务执行状态
 */
export type TaskState =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'crashed'
  | 'timeout'
  | 'degraded'

/**
 * 在途任务上下文
 */
export interface InFlightTask<TResult = any> {
  taskId: string
  processGeneration: number
  filePath: string
  fileSize: number
  fileFingerprint: string
  resolve: (value: TResult) => void
  reject: (reason: any) => void
  startedAt: number
  deadlineTimer?: any
  isRetry?: boolean
  payload?: any
}

/**
 * 插件级健康度与熔断账本
 */
export interface PluginHealth {
  consecutiveCrashes: number
  lastCrashAt: number
  circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN'
  halfOpenTaskInFlight?: boolean
}

/**
 * 退出详情汇总
 */
export interface ExitDetails {
  code: number | null
  signal: string | null
  classification: ExitClassification
  stderrExcerpt: string
  isDegraded: boolean
  shouldRetry: boolean
}

/**
 * 插件清单基础定义
 */
export interface PluginManifest {
  id: string
  name: string
  version: string
  entry: string
  timeoutProfile?: {
    baseSec?: number
    perMbSec?: number
    maxSec?: number
  }
}

/**
 * 抽象 UtilityProcess 接口，解耦 Electron 物理进程便于纯逻辑单元测试 Mock
 */
export interface IPluginUtilityProcess {
  pid?: number
  postMessage(message: any, transfer?: any[]): void
  kill(): boolean
  on(event: 'exit', listener: (code: number) => void): this
  on(event: 'spawn', listener: () => void): this
  on(event: 'error', listener: (err: Error) => void): this
  on(event: string, listener: (...args: any[]) => void): this
  stderr?: NodeJS.ReadableStream | null
  stdout?: NodeJS.ReadableStream | null
}

/**
 * UtilityProcess 孵化工厂函数类型
 */
export type UtilityProcessFactory = (
  entryPath: string,
  args: string[],
  options?: any
) => IPluginUtilityProcess
