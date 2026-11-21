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
