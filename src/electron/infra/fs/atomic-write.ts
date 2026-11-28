/**
 * 同目录临时文件原子写入原语（infra/fs）
 *
 * 契约（见 docs/specs/desktop-sync-io-optimization-PRD.md INV-5 / ADR-0075）：
 * - 不引入 `write-file-atomic` 等第三方依赖，直接使用 Node 原生文件句柄；
 * - 写入同目录隐藏临时文件 `.${basename}.tmp.${process.pid}.${seq}`（`'wx'` 独占创建）→ `sync`（默认开启）→ `close` → `rename`；
 * - `writeFileAtomic` 内置进程内每路径 Promise 尾链串行互斥（键值走 `normalizeForCache(path.resolve(p))`），
 *   既避免 Windows NTFS 并发覆盖同一目标文件抛 `EPERM`，又防止旧快照反超覆盖新快照；
 * - `win32` 下对 `fsp.rename` 的瞬态 `EPERM` / `EBUSY` / `EACCES` 做有界短退避重试（不吞 `EXDEV` 等永久错误）；
 * - 任何阶段失败均仅在本次已独占创建临时文件时才清理，确保关闭句柄并清理后原样上浮错误，严禁掩盖主错误；
 * - 实际 FS 操作始终使用原生 `targetPath`，严禁做破坏性路径分隔符转换。
 */
import fs, { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { logger, LogCategory, normalizeForCache } from '@firefly/shared'
import { safeUnlink } from './async-fs'

/** 支持写入的数据类型 */
export type AtomicWriteData = string | Uint8Array

/** 原子写入选项 */
export interface AtomicWriteOptions {
  /** 是否在 rename 前刷盘（默认 `true`，满足 INV-5 崩溃安全） */
  fsync?: boolean
  /** 文本写入编码（仅当 `data` 为 `string` 时生效，默认 `'utf8'`） */
  encoding?: BufferEncoding
  /** 新建临时文件的权限位（透传给 `open`） */
  mode?: number
}

/** Windows `MoveFileExW` 遇杀软/索引器短暂占用的瞬态错误码 */
const TRANSIENT_RENAME_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES'])
const WIN32_RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100] as const
const MAX_TEMP_EEXIST_RETRIES = 5

/** 进程内单调递增序号，保证并发原子写同一目标路径时临时文件名不冲突 */
let tempSeq = 0

/** 进程内每路径串行互斥尾链（键仅作内存锁索引，不用于文件系统访问） */
const pathWriteChains = new Map<string, Promise<void>>()

/**
 * 入口路径前置校验：拦截空串、尾分隔符（目录形态）及无文件名根路径，
 * 避免在 `cwd` 或根目录先创建临时文件并触发无效重试后才报错。
 */
function assertValidTargetPath(targetPath: string): void {
  if (!targetPath || !targetPath.trim()) {
    throw Object.assign(new Error('原子写目标路径不能为空'), { code: 'EINVAL' })
  }
  if (targetPath.endsWith('/') || targetPath.endsWith('\\')) {
    throw Object.assign(new Error(`原子写目标路径不能为目录: ${targetPath}`), { code: 'EISDIR' })
  }
  const base = path.basename(targetPath)
  if (!base || base === '.' || base === '..') {
    throw Object.assign(new Error(`原子写目标路径缺少文件名: ${targetPath}`), { code: 'EINVAL' })
  }
}

function buildTempFilePath(targetPath: string): string {
  const dir = path.dirname(targetPath)
  const base = path.basename(targetPath)
  tempSeq += 1
  return path.join(dir, `.${base}.tmp.${process.pid}.${tempSeq}`)
}

async function openTempExclusive(
  targetPath: string,
  mode?: number
): Promise<{ tmpPath: string; handle: fsp.FileHandle }> {
  for (let attempt = 0; attempt <= MAX_TEMP_EEXIST_RETRIES; attempt += 1) {
    const tmpPath = buildTempFilePath(targetPath)
    try {
      const handle = await fsp.open(tmpPath, 'wx', mode)
      return { tmpPath, handle }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST' && attempt < MAX_TEMP_EEXIST_RETRIES) {
        continue
      }
      throw error
    }
  }
  throw new Error('unreachable')
}

function openTempExclusiveSync(
  targetPath: string,
  mode?: number
): { tmpPath: string; fd: number } {
  for (let attempt = 0; attempt <= MAX_TEMP_EEXIST_RETRIES; attempt += 1) {
    const tmpPath = buildTempFilePath(targetPath)
    try {
      const fd = fs.openSync(tmpPath, 'wx', mode)
      return { tmpPath, fd }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'EEXIST' && attempt < MAX_TEMP_EEXIST_RETRIES) {
        continue
      }
      throw error
    }
  }
  throw new Error('unreachable')
}

async function withPathWriteLock<T>(targetPath: string, task: () => Promise<T>): Promise<T> {
  const key = normalizeForCache(path.resolve(targetPath))
  const previous = pathWriteChains.get(key) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>(resolve => {
    release = resolve
  })
  const tail = previous.then(() => current)
  pathWriteChains.set(key, tail)

  await previous
  try {
    return await task()
  } finally {
    release()
    if (pathWriteChains.get(key) === tail) {
      pathWriteChains.delete(key)
    }
  }
}

async function renameWithWin32Retry(tmpPath: string, targetPath: string): Promise<void> {
  let attempt = 0
  while (true) {
    try {
      await fsp.rename(tmpPath, targetPath)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code ?? ''
      if (
        process.platform === 'win32' &&
        TRANSIENT_RENAME_CODES.has(code) &&
        attempt < WIN32_RENAME_RETRY_DELAYS_MS.length
      ) {
        const delayMs = WIN32_RENAME_RETRY_DELAYS_MS[attempt]
        attempt += 1
        await new Promise<void>(resolve => setTimeout(resolve, delayMs))
        continue
      }
      throw error
    }
  }
}

/**
 * 异步同目录原子写文件（进程内同路径串行排队）。
 *
 * 顺序保证：`open('wx')` → `writeFile` →（可选 `handle.sync()`）→ `close()` → `rename()`；
 * 任一步失败均先关闭句柄并仅清理本次创建出的临时文件，再原样上浮错误。
 */
export async function writeFileAtomic(
  targetPath: string,
  data: AtomicWriteData,
  opts?: AtomicWriteOptions
): Promise<void> {
  assertValidTargetPath(targetPath)

  await withPathWriteLock(targetPath, async () => {
    let tmpPath = ''
    let handle: fsp.FileHandle | undefined
    let createdTmp = false

    try {
      const opened = await openTempExclusive(targetPath, opts?.mode)
      tmpPath = opened.tmpPath
      handle = opened.handle
      createdTmp = true

      if (typeof data === 'string') {
        await handle.writeFile(data, { encoding: opts?.encoding ?? 'utf8' })
      } else {
        await handle.writeFile(data)
      }
      if (opts?.fsync !== false) {
        await handle.sync()
      }
      await handle.close()
      handle = undefined
      await renameWithWin32Retry(tmpPath, targetPath)
    } catch (error) {
      if (handle !== undefined) {
        try {
          await handle.close()
        } catch (closeErr) {
          logger.warn(
            LogCategory.SYSTEM,
            `[infra/fs] writeFileAtomic 关闭临时句柄失败: ${tmpPath}`,
            closeErr
          )
        }
      }
      if (createdTmp && tmpPath) {
        try {
          await safeUnlink(tmpPath)
        } catch (unlinkErr) {
          logger.warn(
            LogCategory.SYSTEM,
            `[infra/fs] writeFileAtomic 清理临时文件失败: ${tmpPath}`,
            unlinkErr
          )
        }
      }
      throw error
    }
  })
}

/**
 * 进程退出专用同目录原子写文件（同步版）。
 *
 * @warning 门禁限定：仅允许已在 `sync-allowlist.ts` 登记的进程退出同步路径
 * （例如 `process-reaper` 拆出独立退出函数后的退出写盘）调用；
 * 常规运行期（事件循环热路径、配置/缓存更新、异步启动收尾）严禁使用，必须调用 `writeFileAtomic`。
 */
export function writeFileAtomicSync(
  targetPath: string,
  data: AtomicWriteData,
  opts?: AtomicWriteOptions
): void {
  assertValidTargetPath(targetPath)

  let tmpPath = ''
  let fd: number | undefined
  let createdTmp = false

  try {
    const opened = openTempExclusiveSync(targetPath, opts?.mode)
    tmpPath = opened.tmpPath
    fd = opened.fd
    createdTmp = true

    if (typeof data === 'string') {
      fs.writeFileSync(fd, data, { encoding: opts?.encoding ?? 'utf8' })
    } else {
      fs.writeFileSync(fd, data)
    }
    if (opts?.fsync !== false) {
      fs.fsyncSync(fd)
    }
    fs.closeSync(fd)
    fd = undefined
    fs.renameSync(tmpPath, targetPath)
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd)
      } catch (closeErr) {
        logger.warn(
          LogCategory.SYSTEM,
          `[infra/fs] writeFileAtomicSync 关闭临时描述符失败: ${tmpPath}`,
          closeErr
        )
      }
    }
    if (createdTmp && tmpPath) {
      try {
        fs.unlinkSync(tmpPath)
      } catch (unlinkErr) {
        const err = unlinkErr as NodeJS.ErrnoException
        if (err?.code !== 'ENOENT') {
          logger.warn(
            LogCategory.SYSTEM,
            `[infra/fs] writeFileAtomicSync 清理临时文件失败: ${tmpPath}`,
            unlinkErr
          )
        }
      }
    }
    throw error
  }
}
