/**
 * /api/v1/engine/status 挂载核验的错误分类与重试预算纯逻辑。
 *
 * 背景：引擎加载模型或并发推理时，status 查询可能瞬时超时、连接被重置或返回 5xx，
 * 这并非「挂载清单不一致」这类确定性失败。若把瞬时故障也当作 Fail-Closed 依据去
 * SIGTERM，会误杀正在进行的视频分析（切片与封面一起丢失）。
 *
 * 因此这里只做纯分类，调用方据此决定「重试」还是「立即判定确定性失败」；
 * 不掺杂网络/日志副作用，便于在 Electron ABI 运行器下直接覆盖真值表。
 */

/** 单次核验最多尝试次数（含首次）。 */
export const STATUS_VERIFY_MAX_ATTEMPTS = 3
/** 单次 status 查询超时（毫秒）。引擎忙时给足预算，避免 2.5s 误判。 */
export const STATUS_VERIFY_TIMEOUT_MS = 5000
/** 重试退避基数（毫秒），第 n 次重试等待 base * n。 */
export const STATUS_VERIFY_BACKOFF_MS = 400

const TRANSIENT_ERROR_PATTERNS = [
  'timeout',
  'timed out',
  'aborted',
  'abort',
  'econnreset',
  'econnrefused',
  'econnaborted',
  'etimedout',
  'socket hang up',
  'fetch failed',
  'network',
  'terminated'
]

/**
 * 判断 status 查询异常是否属于可重试的瞬时故障（超时/网络抖动），而非确定性失败。
 *
 * 覆盖：`AbortSignal.timeout` 抛出的 DOMException(TimeoutError/AbortError)、
 * undici 的 `TypeError: fetch failed`（底层 ECONNRESET 封装在 cause 中）。
 */
export function isTransientStatusFetchError(err: unknown): boolean {
  if (!err || typeof err !== 'object') {
    return false
  }
  const e = err as { name?: unknown; code?: unknown; message?: unknown; cause?: unknown }

  const name = typeof e.name === 'string' ? e.name.toLowerCase() : ''
  if (name === 'aborterror' || name === 'timeouterror') {
    return true
  }

  const code = typeof e.code === 'string' ? e.code.toLowerCase() : ''
  if (
    code.startsWith('econn') ||
    code === 'etimedout' ||
    code === 'und_err_connect_timeout' ||
    code === 'und_err_socket'
  ) {
    return true
  }

  const message = typeof e.message === 'string' ? e.message.toLowerCase() : ''
  if (message && TRANSIENT_ERROR_PATTERNS.some(pattern => message.includes(pattern))) {
    return true
  }

  // undici 把底层网络原因包在 cause 里（如 read ECONNRESET）。
  if (e.cause) {
    return isTransientStatusFetchError(e.cause)
  }

  return false
}

/**
 * HTTP 状态码分类：5xx 视为瞬时（引擎忙/重启中），4xx 视为确定性契约失败。
 */
export function isTransientStatusHttpCode(status: number): boolean {
  return status >= 500
}

/**
 * 递归解包 `err.cause` 判定异常是否为连接被拒绝（ECONNREFUSED）。
 * 用于区分「端口未监听/进程已退」与「进程存活但处理慢超时/连接重置」。
 */
export function isConnectionRefusedError(err: unknown, visited = new Set<unknown>()): boolean {
  if (!err || typeof err !== 'object') {
    return false
  }
  if (visited.has(err)) {
    return false
  }
  visited.add(err)

  const e = err as { code?: unknown; message?: unknown; cause?: unknown }
  const code = typeof e.code === 'string' ? e.code.toLowerCase() : ''
  if (code === 'econnrefused') {
    return true
  }
  const message = typeof e.message === 'string' ? e.message.toLowerCase() : ''
  if (message.includes('econnrefused')) {
    return true
  }
  if (e.cause) {
    return isConnectionRefusedError(e.cause, visited)
  }
  return false
}

export interface FetchErrorRestartContext {
  error: unknown
  signalAborted?: boolean
  httpStatus?: number | null
  processAlive: boolean
  withinStartupGrace?: boolean
}

/**
 * 侧通道/业务请求 catch 块是否应触发 Omni 重拉（防瞬态超时误杀健康子进程）：
 * - 主动中止或已收到 HTTP 状态码 → false（服务在线，仅业务/取消异常）
 * - 进程已失活 → true
 * - 进程存活且 ECONNREFUSED：仅宽限期外允许重启（宽限期内端口尚未绑定完成，禁止误杀）
 * - 其余（超时/ECONNRESET 且进程存活）→ false
 */
export function shouldTriggerRestartOnFetchError(ctx: FetchErrorRestartContext): boolean {
  if (ctx.signalAborted === true) {
    return false
  }
  if (typeof ctx.httpStatus === 'number' && Number.isFinite(ctx.httpStatus)) {
    return false
  }
  if (!ctx.processAlive) {
    return true
  }
  if (isConnectionRefusedError(ctx.error)) {
    return !ctx.withinStartupGrace
  }
  return false
}

export interface ForceKillRespawnContext {
  hasLiveChild: boolean
  pidAlive: boolean
  verifyTimedOut: boolean
  portRefused: boolean
  withinStartupGrace: boolean
}

/**
 * `doStart()` 反自杀决策严格优先级真值表：
 * ① 处于启动宽限期 → false（严禁强杀正在热身的实例）
 * ② 托管子进程存活且探活仅超时 → false（引擎正忙，严禁误杀）
 * ③ 目标 PID 已死 → true（允许清理死句柄并重生）
 * ④ 仅当存在托管句柄、端口明确拒绝连接且非超时时 → true（绝不强杀无托管句柄的外部未知 PID）
 */
export function shouldForceKillBeforeRespawn(ctx: ForceKillRespawnContext): boolean {
  if (ctx.withinStartupGrace) {
    return false
  }
  if (ctx.hasLiveChild && ctx.pidAlive && ctx.verifyTimedOut) {
    return false
  }
  if (!ctx.pidAlive) {
    return true
  }
  return ctx.hasLiveChild && ctx.portRefused && !ctx.verifyTimedOut
}
