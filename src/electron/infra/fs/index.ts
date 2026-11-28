/**
 * Desktop 主进程异步文件 I/O 与并发基础层统一入口（infra/fs）
 *
 * 定位与契约（ADR-0075）：
 * - 本层是后续所有「同步 → 异步」及同目录原子写改造的唯一依赖入口；
 * - 零业务语义，仅导出文件系统原语、并发限流与同步白名单注册表，禁止擅自扩建成通用杂货层；
 * - 不包含 `instrument.ts`（插桩模块由对应观测接入方单独引入）。
 */
export {
  statOrNull,
  statOrThrow,
  existsAsync,
  readdirTyped,
  mkdirp,
  safeUnlink,
  setDefaultStatErrorReporter
} from './async-fs'
export type { StatErrorHandler } from './async-fs'

export { DEFAULT_CONCURRENCY, mapLimit, createLimiter } from './concurrency'
export type { Limiter, MapLimitOptions } from './concurrency'

export { writeFileAtomic, writeFileAtomicSync } from './atomic-write'
export type { AtomicWriteData, AtomicWriteOptions } from './atomic-write'

export {
  SYNCHRONOUS_ALLOWLIST,
  normalizeRegistryKey,
  findSyncAllowlistEntry,
  validateSyncAllowlist,
  assertSyncAllowlistIntegrity,
  listSyncAllowlistEntries
} from './sync-allowlist'
export type { SyncAllowlistEntry } from './sync-allowlist'
