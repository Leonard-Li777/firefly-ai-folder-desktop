/**
 * `perf-flags.json` 读写辅助模块（核心层，工单 TM-W2 / B8 闭环 / [V-01]）
 *
 * 契约（启动性能计划 §10.3）：
 * - `Conf` 为唯一事实源；本模块只负责 `<userData>/perf-flags.json` 镜像的容错读取与原子写出。
 *   W3 启动分层接线时由 `ConfigOrchestrator` 初始化后执行一次对账回写（`writePerfFlagsMirror`），
 *   后续配置变更增量刷新镜像；本工单（W2）交付读写工具与窗口注入，不触碰 ConfigOrchestrator。
 * - 读取：仅在 `worktree-bootstrap.ts` 完成 `app.setPath('userData')` 重定向**之后**执行一次
 *   容错同步读（`readPerfFlagsSnapshotSync`，已按 file:function 登记 sync-allowlist）；
 *   文件缺失 / 损坏 / 半写一律回退默认值并 `logger.warn`，**绝不阻断启动**。
 * - 写入：复用 infra/fs `writeFileAtomic`（同目录临时文件 + 原子 rename），写失败仅 warn。
 * - 开发 / canary 下 `process.env.FF_STARTUP_*` 优先覆盖（`allowEnvOverride` 显式控制）。
 * - `EARLY_WINDOW = 0` 主控闭环总闸：强制级联关闭 `LICENSE_LOCAL_FIRST` / `DEFER_ENGINE` / `DEFER_WATCHERS`。
 * - 窗口注入：4 处窗口创建的 `additionalArguments` 经 `getCachedPerfFlagsArguments` 注入快照，
 *   bootstrap 期配置库不可读时渲染进程仍能拿到启动开关。
 *
 * 模块自身不依赖 electron：`userDataDir` 由调用方（window.ts / ipc-handlers）传入，
 * 保证单测可在纯文件系统上确定性覆盖三类异常场景。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { logger, LogCategory } from '@firefly/shared'
import { writeFileAtomic } from '../infra/fs/atomic-write'

/** 镜像文件名（位于隔离后的 `<userData>` 目录） */
export const PERF_FLAGS_FILE_NAME = 'perf-flags.json'

/** 窗口启动参数键（渲染进程经 process.argv 读取；W3 接线消费） */
export const PERF_FLAGS_ARG_PREFIX = '--ff-perf-flags='

const LOG_PREFIX = '[PerfFlags]'

/** 启动开关快照（与启动性能计划 §10.3 回退开关表一一对应，默认全开 = 1） */
export interface StartupPerfFlags {
  /** P0-1 早期 splash */
  earlySplash: boolean
  /** P0-2 主控闭环总闸：0 时级联关闭 licenseLocalFirst / deferEngine / deferWatchers */
  earlyWindow: boolean
  /** P0-3 本地授权先行 */
  licenseLocalFirst: boolean
  /** P0-4 初始化阶段拆分 */
  splitInitPhase: boolean
  /** P1-3 引擎延后 */
  deferEngine: boolean
  /** P1-10 文件监听延后 */
  deferWatchers: boolean
}

export const DEFAULT_STARTUP_PERF_FLAGS: Readonly<StartupPerfFlags> = {
  earlySplash: true,
  earlyWindow: true,
  licenseLocalFirst: true,
  splitInitPhase: true,
  deferEngine: true,
  deferWatchers: true
}

/** 完整快照：startup 为强类型段，raw 保留其余未知段（如 startupTimeline）供写回保真 */
export interface PerfFlagsSnapshot {
  startup: StartupPerfFlags
  raw: Record<string, unknown>
}

/** 环境变量覆盖映射（静态表：键名 → 快照字段；仅 '0' / '1' 生效） */
const ENV_OVERRIDE_KEYS: ReadonlyArray<readonly [string, keyof StartupPerfFlags]> = [
  ['FF_STARTUP_EARLY_SPLASH', 'earlySplash'],
  ['FF_STARTUP_EARLY_WINDOW', 'earlyWindow'],
  ['FF_STARTUP_LICENSE_LOCAL_FIRST', 'licenseLocalFirst'],
  ['FF_STARTUP_SPLIT_INIT_PHASE', 'splitInitPhase'],
  ['FF_STARTUP_DEFER_ENGINE', 'deferEngine'],
  ['FF_STARTUP_DEFER_WATCHERS', 'deferWatchers']
]

/** 逐键布尔校验：非布尔值（坏文件/半写产物）回退默认，绝不把字符串当 truthy */
function resolveStartupFlags(section: unknown): StartupPerfFlags {
  const resolved: StartupPerfFlags = { ...DEFAULT_STARTUP_PERF_FLAGS }
  if (!section || typeof section !== 'object' || Array.isArray(section)) return resolved
  const record = section as Record<string, unknown>
  for (const key of Object.keys(resolved) as Array<keyof StartupPerfFlags>) {
    if (typeof record[key] === 'boolean') {
      resolved[key] = record[key] as boolean
    }
  }
  return resolved
}

/** 开发 / canary 环境变量优先覆盖（仅 '0' / '1'，其余值忽略保持文件/默认值） */
function applyStartupEnvOverrides(
  flags: StartupPerfFlags,
  env: NodeJS.ProcessEnv,
  allowOverride: boolean
): StartupPerfFlags {
  if (!allowOverride) return flags
  const resolved = { ...flags }
  for (const [envKey, field] of ENV_OVERRIDE_KEYS) {
    const raw = (env[envKey] ?? '').trim()
    if (raw === '0') resolved[field] = false
    else if (raw === '1') resolved[field] = true
  }
  return resolved
}

/** EARLY_WINDOW 主控闭环：总闸关闭时强制级联关闭三个依赖子开关 */
function applyEarlyWindowCascade(flags: StartupPerfFlags): StartupPerfFlags {
  if (flags.earlyWindow) return flags
  return { ...flags, licenseLocalFirst: false, deferEngine: false, deferWatchers: false }
}

export interface ReadPerfFlagsOptions {
  /** 环境变量源注入（单测确定性用）；缺省 process.env */
  env?: NodeJS.ProcessEnv
  /** 是否允许 FF_STARTUP_* 覆盖（开发 / canary）；缺省按 NODE_ENV !== 'production' */
  allowEnvOverride?: boolean
}

/**
 * 容错同步读取 `<userData>/perf-flags.json`（启动前唯一同步读取点，已登记 sync-allowlist）。
 *
 * 缺失 / 损坏 / 半写三类异常一律回退默认值 + `logger.warn`，绝不抛错阻断启动。
 * 同步必要性：窗口 `additionalArguments` 在 bootstrap 期配置库尚不可读时必须拿到快照
 * （INV-6 / [V-01]，预算 < 10ms）。
 */
export function readPerfFlagsSnapshotSync(
  userDataDir: string,
  options: ReadPerfFlagsOptions = {}
): PerfFlagsSnapshot {
  let raw: Record<string, unknown> = {}
  const flagsPath = path.join(userDataDir, PERF_FLAGS_FILE_NAME)
  try {
    const text = fs.readFileSync(flagsPath, 'utf8')
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>
    } else {
      logger.warn(LogCategory.MAIN, `${LOG_PREFIX} perf-flags.json 结构非法，回退默认开关: ${flagsPath}`)
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') {
      logger.warn(LogCategory.MAIN, `${LOG_PREFIX} perf-flags.json 缺失（首次启动属预期），回退默认开关`)
    } else {
      logger.warn(
        LogCategory.MAIN,
        `${LOG_PREFIX} perf-flags.json 读取失败（损坏或半写），回退默认开关: ${flagsPath}`,
        error
      )
    }
  }
  const allowEnvOverride =
    options.allowEnvOverride ?? (options.env ?? process.env).NODE_ENV !== 'production'
  const startup = applyEarlyWindowCascade(
    applyStartupEnvOverrides(resolveStartupFlags(raw.startup), options.env ?? process.env, allowEnvOverride)
  )
  return { startup, raw }
}

/** 进程内快照缓存（键为调用方传入的 userDataDir 原样值，仅作内存索引） */
const snapshotCache = new Map<string, PerfFlagsSnapshot>()

/**
 * 缓存包装：同一 userDataDir 仅首次调用触发一次同步读（窗口创建 4 处共用同一快照）。
 * 已登记 sync-allowlist（透传 readPerfFlagsSnapshotSync 的唯一调用点）。
 */
export function getPerfFlagsSnapshot(
  userDataDir: string,
  options: ReadPerfFlagsOptions = {}
): PerfFlagsSnapshot {
  const cached = snapshotCache.get(userDataDir)
  if (cached) return cached
  const snapshot = readPerfFlagsSnapshotSync(userDataDir, options)
  snapshotCache.set(userDataDir, snapshot)
  return snapshot
}

/** 仅供单测：清空快照缓存 */
export function resetPerfFlagsCacheForTesting(): void {
  snapshotCache.clear()
}

/**
 * 原子写出镜像（同目录临时文件 + rename，复用 infra/fs writeFileAtomic）。
 * 保留 raw 中的未知段（如 startupTimeline），写失败仅 `logger.warn` 绝不上抛。
 */
export async function writePerfFlagsMirror(
  userDataDir: string,
  snapshot: PerfFlagsSnapshot
): Promise<void> {
  const flagsPath = path.join(userDataDir, PERF_FLAGS_FILE_NAME)
  try {
    const payload = { ...snapshot.raw, startup: snapshot.startup }
    await writeFileAtomic(flagsPath, `${JSON.stringify(payload, null, 2)}\n`)
  } catch (error) {
    logger.warn(LogCategory.MAIN, `${LOG_PREFIX} perf-flags.json 镜像写出失败（不影响运行）: ${flagsPath}`, error)
  }
}

/** 构建窗口 additionalArguments 注入段（单键 URI 编码 JSON，渲染端 W3 接线消费） */
export function buildPerfFlagsArguments(snapshot: PerfFlagsSnapshot): string[] {
  return [`${PERF_FLAGS_ARG_PREFIX}${encodeURIComponent(JSON.stringify(snapshot.startup))}`]
}

/** 窗口创建统一入口：缓存快照 + 注入段（4 处 additionalArguments 共用） */
export function getCachedPerfFlagsArguments(userDataDir: string): string[] {
  return buildPerfFlagsArguments(getPerfFlagsSnapshot(userDataDir))
}