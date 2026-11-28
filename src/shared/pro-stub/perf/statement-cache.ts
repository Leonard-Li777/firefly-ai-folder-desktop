/**
 * Prepared Statement 缓存 —— 开源侧直通存根（Statement Cache Stub）
 *
 * 【存根对称性（D-07）】`electron.vite.config.mts` 的动态 alias 决定：
 *   - 存在 `pro/src` 时 `@pro/*` → `pro/src/*`（Pro 真实实现）；
 *   - 否则 `@pro/*` → `src/shared/pro-stub/*`（本文件，开源直通存根）。
 *   本文件与 `pro/src/perf/statement-cache.ts` 必须导出**完全相同**的运行时符号集合与签名
 *   （含 `STATEMENT_CACHE_IMPL` 标识），保证两套构建在业务调用点类型与行为契约完全兼容。
 *
 * 【直通契约（D-07 铁律）】开源侧**不做任何缓存**：`getCachedStatement` 每次直接调用
 *   `db.prepare(sql)`，行为与改造前（未引入 StatementCache）**逐位一致**；
 *   严禁以空实现返回伪造语句，也严禁在存根内偷偷另建缓存（否则开源 / Pro 行为分裂）。
 *
 * 【禁止静默降级】Pro 模块不可用时（即本存根生效时）在**首次**取语句时 `warn` 一次，
 *   显式说明「当前走直通路径、未启用语句缓存」，绝不静默吞掉能力差异。
 */

/** 日志前缀（与 Pro 实现保持同一字面量） */
export const STATEMENT_CACHE_LOG_PREFIX = '[StatementCache]'

/** 实现标识：开源直通存根为 `'stub'`（供解析单测与运行期观测） */
export const STATEMENT_CACHE_IMPL = 'stub' as const

/** 单连接缓存默认容量上限（存根不下发缓存，仅保持常量对称） */
export const DEFAULT_STATEMENT_CACHE_MAX_ENTRIES = 128

/** 缓存容量上限的硬夹取区间（与 Pro 实现同源常量） */
export const STATEMENT_CACHE_MAX_ENTRIES_BOUNDS = { min: 1, max: 4096 } as const

/** 最小语句句柄契约（与 Pro 实现结构一致） */
export interface StatementLike {
  run: (...params: any[]) => any
  get: (...params: any[]) => any
  all: (...params: any[]) => any
}

/** 最小连接契约：只需 `prepare` */
export interface StatementCacheConnection<TStatement extends StatementLike = StatementLike> {
  prepare: (sql: string) => TStatement
  /** `better-sqlite3` 的 `Database#open`：false 表示连接已关闭 */
  open?: boolean
}

/** 可注入的最小日志接口（存根的「直通路径提示」经此上报） */
export interface StatementCacheLogger {
  warn: (message: string, ...args: any[]) => void
}

/** 缓存运行统计（存根恒为零值，仅保持结构对称） */
export interface StatementCacheStats {
  enabled: boolean
  size: number
  hits: number
  misses: number
  evictions: number
  bypasses: number
  prepares: number
}

/** 缓存配置项（存根接受同一入参，但不改变直通行为） */
export interface StatementCacheOptions {
  enabled?: boolean
  maxEntries?: number
  logger?: StatementCacheLogger | null
}

/** 注入的日志接口（缺省回落 `console.warn`，保证告警不丢失） */
let injectedLogger: StatementCacheLogger | null = null

/** 直通路径提示是否已上报（进程级仅一次，避免刷屏） */
let directPathWarned = false

/** 与 Pro 实现同源的例外判定（纯函数，不含状态） */
const PRAGMA_PATTERN = /^\s*PRAGMA\b/i
const TRANSACTION_PATTERN = /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i
const TEMP_DDL_PATTERN = /\b(CREATE|DROP|ALTER)\s+(TEMP|TEMPORARY)\b/i
const TEMP_SCHEMA_PATTERN = /\btemp\s*\./i
const DYNAMIC_IN_PATTERN = /\bIN\s*\([^)]*\?[^)]*\)/i

/** 判定该 SQL 是否属于「不进缓存」的例外项（存根恒直通，此函数仅保持语义对称） */
export function shouldBypassStatementCache(sql: string): boolean {
  if (typeof sql !== 'string' || sql.trim() === '') return true
  return (
    PRAGMA_PATTERN.test(sql) ||
    TRANSACTION_PATTERN.test(sql) ||
    TEMP_DDL_PATTERN.test(sql) ||
    TEMP_SCHEMA_PATTERN.test(sql) ||
    DYNAMIC_IN_PATTERN.test(sql)
  )
}

/** 开源侧恒为关闭（不存在可用的缓存实现） */
export function isStatementCacheEnabled(): boolean {
  return false
}

/** no-op：开源侧无缓存可开关（保持签名对称） */
export function setStatementCacheEnabled(_enabled: boolean): void {
  /* no-op */
}

/** 注入日志接口（`null` 解除注入） */
export function setStatementCacheLogger(logger: StatementCacheLogger | null): void {
  injectedLogger = logger
}

/** no-op：开源侧不接受容量配置（保持签名对称） */
export function configureStatementCache(_options: StatementCacheOptions = {}): void {
  /* no-op */
}

/** 开源侧无可分配容量，恒为 0（保持签名对称） */
export function getStatementCacheMaxEntries(): number {
  return 0
}

/** 首次取语句时上报一次直通路径提示（禁止静默降级） */
function warnDirectPathOnce(): void {
  if (directPathWarned) return
  directPathWarned = true
  const message = `${STATEMENT_CACHE_LOG_PREFIX} Pro 语句缓存不可用，当前走开源直通路径：每次调用直接 db.prepare，不启用语句缓存`
  if (injectedLogger) {
    injectedLogger.warn(message)
  } else {
    console.warn(message)
  }
}

/**
 * 取语句句柄（开源直通）：每次直接 `db.prepare(sql)`，与改造前逐位等价。
 *
 * @throws TypeError 入参未提供 `prepare` 方法（防伪造连接冒充实跑）
 * @throws 任意 `better-sqlite3` 原生错误（SQL 非法 / 连接关闭），与直通路径一致
 */
export function getCachedStatement<TStatement extends StatementLike = StatementLike>(
  db: StatementCacheConnection<TStatement>,
  sql: string
): TStatement {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError(
      `${STATEMENT_CACHE_LOG_PREFIX} db 必须提供 prepare(sql) 方法，严禁以空实现或伪造语句冒充连接`
    )
  }
  warnDirectPathOnce()
  return db.prepare(sql) as TStatement
}

/** 恒为零值统计（开源侧无缓存，不伪造命中率） */
export function getStatementCacheStats(
  _db?: StatementCacheConnection<StatementLike> | object
): StatementCacheStats {
  return {
    enabled: false,
    size: 0,
    hits: 0,
    misses: 0,
    evictions: 0,
    bypasses: 0,
    prepares: 0
  }
}

/** no-op：开源侧无缓存句柄可释放（保持签名对称） */
export function releaseStatementCache(_db: StatementCacheConnection<StatementLike> | object): void {
  /* no-op */
}

/** no-op：开源侧无缓存条目可清空（保持签名对称） */
export function clearStatementCache(_db: StatementCacheConnection<StatementLike> | object): void {
  /* no-op */
}

/** 仅供单元测试：复位「直通提示已上报」标志与注入日志 */
export function resetStatementCacheForTest(): void {
  directPathWarned = false
  injectedLogger = null
}
