/**
 * 模块目录占用字节统计工作线程 (Module Size Worker)
 *
 * 契约（见 docs/issues/desktop-sync-io-async-upgrade/22-p1-3-module-size-cache-worker.md）：
 * 1. 全链路异步遍历，严格使用 `lstat` 语义（符号链接不跟随、不重复统计），与旧同步实现语义一致；
 * 2. 跳过 `.deleting-*` / `.migrating-*` 隔离目录与 `.part` / `.deleting-*` / `.migrating-*` 临时文件；
 * 3. 同时导出纯异步计算函数，供 Worker 不可用时的主进程异步回退路径复用（INV-2）。
 */
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { isMainThread, parentPort } from 'node:worker_threads'
import { LEGACY_READY_MARKER_PREFIX, READY_MARKER_FILENAME } from '@firefly/shared'

function hasAnyReadyMarkerFile(files: string[]): boolean {
  return files.some(
    f =>
      f === READY_MARKER_FILENAME ||
      (f.startsWith(LEGACY_READY_MARKER_PREFIX) && f.endsWith('.json'))
  )
}

export interface ModuleSizeWorkerInMessage {
  type: 'CALCULATE'
  sharedDir: string
  targetModules?: string[]
}

export type ModuleSizeWorkerOutMessage =
  | { type: 'DONE'; moduleBytes: Record<string, number> }
  | { type: 'ERROR'; message: string }

/**
 * 异步递归统计任意目录（含全部子文件）的总字节数。
 * 严格使用 `lstat` 语义：忽略符号链接（`isSymbolicLink()`），避免循环引用或倍数统计。
 */
export async function calculateDirBytesAsync(
  rootDir: string,
  options?: { skipTempEntries?: boolean }
): Promise<number> {
  const skipTemp = options?.skipTempEntries ?? false
  let totalBytes = 0
  const stack: string[] = [rootDir]

  while (stack.length > 0) {
    const currentDir = stack.pop()!
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsp.readdir(currentDir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (skipTemp) {
        if (entry.name.startsWith('.deleting-') || entry.name.startsWith('.migrating-')) {
          continue
        }
        if (entry.isFile() && entry.name.endsWith('.part')) {
          continue
        }
      }

      if (entry.isSymbolicLink()) {
        continue
      }

      const fullPath = path.join(currentDir, entry.name)
      try {
        const st = await fsp.lstat(fullPath)
        if (st.isSymbolicLink()) {
          continue
        }
        if (st.isDirectory()) {
          stack.push(fullPath)
        } else if (st.isFile()) {
          totalBytes += st.size
        }
      } catch {
        // 单个条目并发删除或权限受限时忽略，保持与旧实现 try/catch 一致
      }
    }
  }

  return totalBytes
}

/**
 * 计算单个已就绪模块目录的占用字节数。
 */
export async function calculateModuleBytes(moduleDir: string): Promise<number> {
  return calculateDirBytesAsync(moduleDir, { skipTempEntries: true })
}

/**
 * 批量统计 `_shared` 目录下指定（或全部）已就绪模块的占用字节数。
 */
export async function calculateSharedModulesBytes(
  sharedDir: string,
  targetModules?: string[]
): Promise<Record<string, number>> {
  const result: Record<string, number> = {}

  let entries: import('node:fs').Dirent[]
  try {
    entries = await fsp.readdir(sharedDir, { withFileTypes: true })
  } catch {
    return result
  }

  const targetSet = targetModules ? new Set(targetModules) : null

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue
    if (targetSet && !targetSet.has(entry.name)) continue

    const moduleDir = path.join(sharedDir, entry.name)
    try {
      const dirStat = await fsp.lstat(moduleDir)
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue

      const files = await fsp.readdir(moduleDir)
      if (!hasAnyReadyMarkerFile(files)) continue

      result[entry.name] = await calculateModuleBytes(moduleDir)
    } catch {
      // 忽略单个不可读或并发删除中的模块目录
    }
  }

  return result
}

// Worker 线程入口
if (!isMainThread && parentPort) {
  const port = parentPort
  port.on('message', async (msg: ModuleSizeWorkerInMessage) => {
    if (!msg || msg.type !== 'CALCULATE') return
    try {
      const moduleBytes = await calculateSharedModulesBytes(msg.sharedDir, msg.targetModules)
      const out: ModuleSizeWorkerOutMessage = { type: 'DONE', moduleBytes }
      port.postMessage(out)
    } catch (err) {
      const out: ModuleSizeWorkerOutMessage = {
        type: 'ERROR',
        message: err instanceof Error ? err.message : String(err)
      }
      port.postMessage(out)
    }
  })
}
