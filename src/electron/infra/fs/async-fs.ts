/**
 * 异步文件系统基础层（infra/fs）
 *
 * 定位与契约：
 * - 本层是「同步 → 异步」改造的唯一依赖点，被改动的调用点一律从这里导入，未入榜的存量直连 `fs` 不回改
 *   （范围决断 D-4，见 docs/specs/desktop-sync-io-optimization-PRD.md §4 范围规则）。
 * - 存放于开源核心 `src/electron` 而非 Pro 子模块：开源构建若走 `@pro` 存根会直接失去功能，
 *   故对 AGENTS.md §2「新增代码优先 Pro」作显式例（决断 D-1，ADR-0075）。
 * - 错误契约严格对齐 INV-1：`statOrNull` = `fs.promises.stat`（**跟随符号链接，禁止 lstat**），
 *   任何错误都返回 null（与 `existsSync` 吞掉全部错误的语义一致）。
 *   原代码「exists 为真后 stat 抛错进入 catch」的调用点改用 `statOrThrow`，保留原分支。
 */
import { promises as fsp } from 'node:fs'
import type { Dirent, Stats } from 'node:fs'
import { logger, LogCategory } from '@firefly/shared'

/** 探测未命中（文件不存在 / 路径经过非目录）——属于正常结果，不回调 onError */
const PROBE_MISS_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR'])

/**
 * 非预期探测错误回调。
 *
 * `statOrNull` 本身必须吞掉错误才能与 `existsSync` 等价，但 EACCES / EPERM / EIO / ELOOP
 * 这类现场若被无声吞掉就构成「静默降级」（AGENTS.md §2）。调用方应传入 logger.warn，
 * 既保住 INV-1 的判定等价，又让异常可见。
 */
export type StatErrorHandler = (error: NodeJS.ErrnoException, targetPath: string) => void

/**
 * 模块级默认非未命中错误上报器：经 `@firefly/shared` `logger.warn` 输出错误码、错误信息与目标路径，
 * 确保未传 `onError` 时也不会静默吞掉权限/I/O 故障。
 */
const defaultLoggerStatErrorReporter: StatErrorHandler = (error, targetPath) => {
  logger.warn(
    LogCategory.SYSTEM,
    `[infra/fs] stat 探测异常 (${error?.code ?? 'UNKNOWN'}): ${targetPath} - ${error?.message ?? String(error)}`
  )
}

let defaultStatErrorReporter: StatErrorHandler = defaultLoggerStatErrorReporter

/**
 * 设置或还原模块级默认非未命中错误上报器（供单元测试隔离使用）。
 * 传入 `null` / `undefined` 或无参调用时还原为默认的 `logger.warn` 上报器。
 */
export function setDefaultStatErrorReporter(reporter?: StatErrorHandler | null): void {
  defaultStatErrorReporter =
    typeof reporter === 'function' ? reporter : defaultLoggerStatErrorReporter
}

/**
 * 探测单个路径的状态：存在则返回 `Stats`，不存在/不可用则返回 `null`。
 *
 * 分支契约（INV-1）：存在文件 → Stats；不存在 → null；路径为目录 → 目录 Stats（由调用方按自身语义分流）；
 * 任何 stat 异常 → null（其中非「未命中」类错误优先回调 `onError`，未传函数型 `onError` 时走默认告警上报器）。
 */
export async function statOrNull(
  targetPath: string,
  onError?: StatErrorHandler
): Promise<Stats | null> {
  try {
    return await fsp.stat(targetPath)
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (!PROBE_MISS_CODES.has(err?.code ?? '')) {
      // 必须校验 typeof === 'function'：防止 `mapLimit(paths, 32, statOrNull)` 或 `paths.map(statOrNull)`
      // 自动把第 2 参数字索引 `index` 传入 `onError`，导致遇到非 ENOENT 错误时抛出 TypeError
      const reporter = typeof onError === 'function' ? onError : defaultStatErrorReporter
      try {
        reporter(err, targetPath)
      } catch (reporterError) {
        try {
          logger.warn(
            LogCategory.SYSTEM,
            `[infra/fs] statOrNull 错误上报回调异常: ${targetPath}`,
            reporterError
          )
        } catch {
          // 日志系统自身异常时保底吞掉，确保绝不打破 INV-1「statOrNull 恒返回 null」契约
        }
      }
    }
    return null
  }
}

/**
 * 与 `fsp.stat` 等价的抛错版本。
 *
 * 供「exists 为真后 stat 抛错走 catch/errors」的原调用点使用：改造后仍必须抛出同类错误，
 * 不得为了统一而把异常改写成 null（INV-1 / INV-2）。
 */
export async function statOrThrow(targetPath: string): Promise<Stats> {
  return await fsp.stat(targetPath)
}

/** 异步 `existsSync` 等价体：内部复用 `statOrNull`，不额外多发一次系统调用。 */
export async function existsAsync(
  targetPath: string,
  onError?: StatErrorHandler
): Promise<boolean> {
  const safeOnError = typeof onError === 'function' ? onError : undefined
  return (await statOrNull(targetPath, safeOnError)) !== null
}

/**
 * 带类型信息的目录读取（`Dirent` 数组）。
 *
 * 与「`readdir` 拿名字 + 逐个 `stat`」相比，一次系统调用即可拿到文件/目录类型；
 * 但注意 `Dirent.isFile()` 不跟随符号链接，需要跟随语义的调用点仍要补 `statOrNull`。
 */
export async function readdirTyped(dirPath: string): Promise<Dirent[]> {
  return await fsp.readdir(dirPath, { withFileTypes: true })
}

/** 递归创建目录（幂等）；等价于「先 existsSync 再 mkdirSync」的单次调用版本。 */
export async function mkdirp(dirPath: string): Promise<void> {
  await fsp.mkdir(dirPath, { recursive: true })
}

/**
 * 删除文件：目标不存在视为「已经达成目的」返回 false，其余错误照原样抛出。
 *
 * 与「`existsSync` 再 `unlinkSync`」相比少一次系统调用，且不存在时的结果完全一致；
 * 权限、占用（Windows EBUSY）等失败必须上浮，交由调用方按原逻辑处理。
 */
export async function safeUnlink(targetPath: string): Promise<boolean> {
  try {
    await fsp.unlink(targetPath)
    return true
  } catch (error) {
    const err = error as NodeJS.ErrnoException
    if (err?.code === 'ENOENT') return false
    throw err
  }
}
