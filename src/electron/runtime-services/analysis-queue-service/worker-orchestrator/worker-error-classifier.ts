/**
 * Stage 2 Worker 零外部依赖结构化错误分类器（Spec §11）
 *
 * 硬约束：严禁 import 任何 `@firefly/*`、`electron` 或 `better-sqlite3`，
 * 确保 `orchestrator-thread.ts` 在生产打包时绝不被 `manualChunks` 卷入含 Electron 依赖的 chunk。
 *
 * @doc-anchor: docs/specs/stage2-analysis-pipeline-worker-optimization-spec.md#11-错误分类与重试策略
 */

/** Worker / 写集结构化错误分类枚举（Spec §11，零 t() / 零中文文案判定） */
export type AnalysisErrorKind =
  | 'SQLITE_BUSY'
  | 'SQLITE_CORRUPT'
  | 'HTTP_TIMEOUT'
  | 'ENGINE_503'
  | 'FILE_LOCKED'
  | 'CONSTRAINT'
  | 'DISK_FULL'
  | 'EXTRACT_ERROR'
  | 'ENGINE_FAILED'
  | 'CANCELED'

const TRANSIENT_NET_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_RESET',
  'ERR_EMPTY_RESPONSE'
])

/** 将运行时异常映射为 Spec §11 结构化错误码及重试策略（纯函数，零外部依赖） */
export function classifyWorkerErrorKind(err: unknown): {
  kind: AnalysisErrorKind
  retryable: boolean
} {
  const e = (err && typeof err === 'object' ? err : {}) as {
    name?: string
    code?: string
    status?: number
    statusCode?: number
    message?: string
    error?: { code?: string }
  }
  const code = e.code ?? e.error?.code ?? ''
  const status = e.status ?? e.statusCode ?? 0
  const msg =
    err instanceof Error
      ? err.message
      : typeof e.message === 'string'
        ? e.message
        : String(err ?? '')

  if (e.name === 'AbortError' || msg === 'Aborted' || code === 'CANCELED_BY_USER') {
    return { kind: 'CANCELED', retryable: false }
  }
  if (
    code === 'SQLITE_CORRUPT' ||
    code === 'SQLITE_NOTADB' ||
    msg.includes('SQLITE_CORRUPT') ||
    msg.includes('database disk image is malformed')
  ) {
    return { kind: 'SQLITE_CORRUPT', retryable: false }
  }
  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED' || msg.includes('SQLITE_BUSY')) {
    return { kind: 'SQLITE_BUSY', retryable: true }
  }
  if (code === 'SQLITE_FULL' || code === 'ENOSPC' || msg.includes('SQLITE_FULL')) {
    return { kind: 'DISK_FULL', retryable: false }
  }
  if (
    code === 'SQLITE_CONSTRAINT' ||
    code.startsWith('SQLITE_CONSTRAINT_') ||
    msg.includes('SQLITE_CONSTRAINT')
  ) {
    return { kind: 'CONSTRAINT', retryable: false }
  }
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || msg.includes('EBUSY')) {
    return { kind: 'FILE_LOCKED', retryable: code === 'EBUSY' || msg.includes('EBUSY') }
  }
  if (
    status === 500 ||
    code === 'engine_failed' ||
    msg.includes('ProcessStatus::Failed') ||
    msg.includes('AI engine failed to start')
  ) {
    return { kind: 'ENGINE_FAILED', retryable: false }
  }
  if (
    e.name === 'TimeoutError' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_HEADERS_TIMEOUT' ||
    code === 'UND_ERR_BODY_TIMEOUT' ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('timed out') ||
    // axios 超时形态：code=ECONNABORTED，message 固定为 'timeout of <n>ms exceeded'。
    // 必须同时校验 message 含 timeout，避免把 axios 的主动取消（同样可能带 ECONNABORTED）
    // 误判为超时重试——取消必须走上方 CANCELED 分支，严禁进入瞬态重试。
    (code === 'ECONNABORTED' && /timeout/i.test(msg))
  ) {
    return { kind: 'HTTP_TIMEOUT', retryable: true }
  }
  if (
    status === 503 ||
    code === 'engine_swapping' ||
    TRANSIENT_NET_CODES.has(code) ||
    msg.includes('503') ||
    msg.includes('engine_swapping') ||
    msg.includes('AI engine is starting') ||
    msg.includes('AI engine is swapping models') ||
    msg.includes('ECONNREFUSED')
  ) {
    return { kind: 'ENGINE_503', retryable: true }
  }
  return { kind: 'EXTRACT_ERROR', retryable: false }
}
