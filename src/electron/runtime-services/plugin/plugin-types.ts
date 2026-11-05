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
  deadlineMs?: number
  remainingDeadlineMs?: number
  pausedAt?: number
  pauseDeadline?: () => void
  resumeDeadline?: () => void
  extendDeadline?: (bonusMs: number) => void
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

// ==================== Issue 02: 产物暂存与提交相关契约 ====================

/**
 * 路径越界/逃逸安全错误
 */
export class ArtifactSecurityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArtifactSecurityError'
  }
}

/**
 * 产物文件魔数或格式校验失败错误
 */
export class ArtifactValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArtifactValidationError'
  }
}

/**
 * 两阶段提交参数
 */
export interface CommitArtifactOptions {
  taskId: string
  attempt?: number
  /** 插件回传的相对路径，如 'iso.webp' 或 'extracted_content.json' */
  relativePath: string
  /** 关联的主文件内容物理指纹 */
  fileFingerprint: string
  /** 插件版本号 */
  pluginVersion: string
  /** 视图或产物标识，如 'iso', 'thumb', 'extracted' */
  viewName: string
  /** 目标扩展名，默认由 relativePath 决定 */
  targetExtension?: string
  /** 预期校验的魔数，'webp' | 'json' | 'none' */
  expectedMagic?: 'webp' | 'json' | 'none'
}

/**
 * 数据库引用判定结果（支持返回数据库记录的最后访问时间戳）
 */
export interface ReferenceCheckResult {
  referenced: boolean
  lastAccessedAt?: number
}

/**
 * 孤儿 GC 参数
 */
export interface OrphanGcOptions {
  /** 判定指定文件名是否在数据库中被有效引用的探针，支持返回布尔值或带访问时间戳的判定结果 */
  isReferenced: (
    filename: string
  ) => boolean | ReferenceCheckResult | Promise<boolean | ReferenceCheckResult>
  /** 当缓存超额淘汰已引用文件时触发的反向解绑回调，防止数据库产生悬空死链引用 */
  onEvicted?: (filename: string) => void | Promise<void>
  /** 全局配额大小（字节），默认 2GB (2 * 1024 * 1024 * 1024) */
  maxTotalBytes?: number
  /** 测试控制时间 */
  now?: number
}

/**
 * 孤儿 GC 执行结果统计
 */
export interface GcResult {
  deletedOrphans: number
  deletedLru: number
  totalFreedBytes: number
  lockedFilesSkipped: number
  errors: Array<{ file: string; error: any }>
}

// ==================== Issue 03: IPC 门禁与逆向凭证相关错误 ====================

/**
 * 响应体超过 50KB UTF-8 字节硬上限错误
 */
export class PayloadTooLargeError extends Error {
  public readonly code = 'response_payload_too_large'
  constructor(
    public readonly byteLength: number,
    public readonly limit: number
  ) {
    super(
      `RPC response payload too large (${byteLength} bytes > limit ${limit} bytes) and missing resultArtifactPath`
    )
    this.name = 'PayloadTooLargeError'
  }
}

/**
 * 凭证查询频次超限错误（单任务最多 5 次）
 */
export class CredentialRateLimitError extends Error {
  public readonly code = 'credential_rate_limit_exceeded'
  constructor(message: string = 'Exceeded maximum 5 credential queries per task') {
    super(message)
    this.name = 'CredentialRateLimitError'
  }
}

/**
 * 未授权物理路径错误
 */
export class UnauthorizedPathError extends Error {
  public readonly code = 'unauthorized_path_access'
  constructor(message: string) {
    super(message)
    this.name = 'UnauthorizedPathError'
  }
}

// ==================== Issue 04: 双看门狗与内存守卫契约 ====================

/**
 * 单文件体积超过 1GB 上限常量
 */
export const MAX_PLUGIN_FILE_SIZE_BYTES = 1024 * 1024 * 1024 // 1GB

/**
 * 正常平滑回收内存阈值常量 (2GB)
 */
export const NORMAL_MEMORY_RECYCLE_THRESHOLD_BYTES = 2 * 1024 * 1024 * 1024 // 2GB

/**
 * 紧急硬杀内存阈值常量 (4GB)
 */
export const EMERGENCY_MEMORY_KILL_THRESHOLD_BYTES = 4 * 1024 * 1024 * 1024 // 4GB

/**
 * 看门狗终止原因
 */
export type WatchdogReason = 'timeout' | 'mem_guard'

/**
 * 超大文件直接跳过错误 (AC 4)
 */
export class FileTooLargeError extends Error {
  public readonly code = 'FILE_TOO_LARGE'
  public readonly isDegraded = true
  constructor(
    public readonly fileSize: number,
    public readonly maxAllowed: number = MAX_PLUGIN_FILE_SIZE_BYTES
  ) {
    super(
      `File size (${fileSize} bytes) exceeds plugin threshold (${maxAllowed} bytes / 1GB). Skipped as too_large to fallback to Omni baseline.`
    )
    this.name = 'FileTooLargeError'
  }
}

/**
 * 内存守卫超限强杀错误 (AC 3)
 */
export class MemoryLimitExceededError extends Error {
  public readonly code = 'MEMORY_LIMIT_EXCEEDED'
  public readonly isDegraded = true
  constructor(
    public readonly workingSetBytes: number,
    public readonly limitBytes: number
  ) {
    super(
      `Plugin process working set memory (${workingSetBytes} bytes) exceeded emergency limit (${limitBytes} bytes). Terminated by mem_guard.`
    )
    this.name = 'MemoryLimitExceededError'
  }
}
