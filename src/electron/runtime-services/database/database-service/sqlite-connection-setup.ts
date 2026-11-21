/**
 * SQLite 连接 PRAGMA 套装与自定义 SQL 函数注册（纯 Node 模块，零 electron 顶层依赖）
 *
 * 单点收口依据（红线：PRAGMA 套装禁止各模块重复实现；R1 盲审发现 5 纠偏后口径）：
 * - 本模块 `DEFAULT_SQLITE_PRAGMAS` 为主库写连接标准 PRAGMA **值**的单一事实源——
 *   database.ts `getDatabaseConfig` 非 E2E 分支的 pragma 块引用本常量展开（非复制）；
 * - 主进程 database-service/init.ts 保留其应用逻辑（含 fkStatus 校验顺序），
 *   子进程写连接经 `applySqliteConnectionPragmas` 应用同一值源，跨进程治理一致；
 * - Rust 侧对应权威实现在 omni-core/db_sqlite.rs（端云全景 §4 连接治理），两侧语义对齐。
 *
 * `registerAnalysisSqlFunctions`（decompress_text）为 FTS 触发器透明解压 BLOB 的
 * 唯一注册实现：子进程若漏注册，写集 Step 6 FTS 触发器将直接抛
 * `no such function: decompress_text`，故与 PRAGMA 一并单点。
 *
 * @doc-anchor: docs/specs/stage2-analysis-pipeline-worker-optimization-spec.md#2-进程线程三层拓扑唯一基座裁决
 */

import type { Database } from 'better-sqlite3'
import { LogCategory, logger } from '@firefly/shared'
import { decompressText } from '../../../utils/text-compressor'

/** 主库写连接标准 PRAGMA 值（与 database.ts getDatabaseConfig 非 E2E 分支同源） */
export interface SqlitePragmaConfig {
  journal_mode: string
  synchronous: string
  cache_size: number
  mmap_size: number
  temp_store: string
  foreign_keys: boolean
  busy_timeout: number
  /** WAL 自动 checkpoint 页阈值（可选） */
  wal_autocheckpoint?: number
  /** WAL 文件大小上限（可选） */
  journal_size_limit?: number
}

/**
 * 标准主库 PRAGMA 套装（单一事实源：database.ts getDatabaseConfig 与
 * AnalysisDbWriterProcess 子进程连接共同引用，严禁两侧各自硬编码）。
 */
export const DEFAULT_SQLITE_PRAGMAS: SqlitePragmaConfig = {
  journal_mode: 'WAL',
  synchronous: 'NORMAL',
  cache_size: -64000,
  mmap_size: 268435456,
  temp_store: 'MEMORY',
  foreign_keys: true,
  busy_timeout: 5000,
  // [Issue 04 Step 5 / R2-8] WAL 自动 checkpoint（1000 页）+ 文件大小上限（64MB），防主库 WAL 无界增长。
  wal_autocheckpoint: 1000,
  journal_size_limit: 67108864
}

/**
 * 按套装应用 PRAGMA（顺序与主进程 init.ts 一致；foreign_keys 开启失败即抛错，
 * 与主库「外键约束启用失败」强一致，严禁静默降级）。
 */
export function applySqliteConnectionPragmas(db: Database, pragma?: Partial<SqlitePragmaConfig>): void {
  const cfg = { ...DEFAULT_SQLITE_PRAGMAS, ...(pragma ?? {}) }
  db.pragma(`journal_mode = ${cfg.journal_mode}`)
  db.pragma(`synchronous = ${cfg.synchronous}`)
  db.pragma(`cache_size = ${cfg.cache_size}`)
  db.pragma(`mmap_size = ${cfg.mmap_size}`)
  db.pragma(`temp_store = ${cfg.temp_store}`)
  db.pragma(`foreign_keys = ${cfg.foreign_keys ? 'ON' : 'OFF'}`)
  const fkStatus = db.pragma('foreign_keys', { simple: true })
  if (cfg.foreign_keys && Number(fkStatus) !== 1) {
    throw new Error(`SQLite 外键约束启用失败: PRAGMA foreign_keys = ${fkStatus}`)
  }
  db.pragma(`busy_timeout = ${cfg.busy_timeout}`)
  if (typeof cfg.wal_autocheckpoint === 'number') {
    db.pragma(`wal_autocheckpoint = ${cfg.wal_autocheckpoint}`)
  }
  if (typeof cfg.journal_size_limit === 'number') {
    db.pragma(`journal_size_limit = ${cfg.journal_size_limit}`)
  }
}

/**
 * 注册 SQLite 自定义 SQL 函数（FTS 触发器依赖项，主进程与写进程子连接共用）。
 * 当前仅 `decompress_text`：使 FTS 触发器在处理 content/multimodal_content/ocr/lrc 等
 * BLOB 时能透明解压为明文做 trigram 分词。
 */
export function registerAnalysisSqlFunctions(db: Database): void {
  if (!db || typeof (db as unknown as { function?: unknown }).function !== 'function') return

  try {
    db.function('decompress_text', { deterministic: true }, (val: unknown) => {
      return decompressText(val as never)
    })
  } catch (err) {
    // R1 盲审发现 6：注册失败必须留痕（漏注册时 FTS 触发器要到写集 Step 6 才炸
    // `no such function: decompress_text`，严禁零留痕空 catch 掩盖真实故障）
    logger.warn(
      LogCategory.ANALYSIS_QUEUE,
      '[SqliteConnectionSetup] decompress_text SQL 函数注册失败（FTS 触发器将不可用）:',
      err
    )
  }
}
