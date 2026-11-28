/**
 * 模块占用字节统计与缓存器 (Module Size Calculator)
 *
 * 契约（Ticket 22 / P1-3）：
 * 1. 按 `(rootDir, moduleId)` 粒度缓存模块目录大小，缓存键包含模块 id 与目录 mtime 指纹；
 * 2. 未命中缓存的模块通过 Worker 线程异步递归统计（lstat 语义）；
 * 3. Worker 不可用或执行异常时，`logger.warn` 记录原因并回退至主进程异步统计（禁止返回 0 冒充）；
 * 4. 安装、卸载、删除任一模块或切换插件目录后必须显式失效对应缓存。
 */
import { promises as fsp } from 'node:fs'
import * as path from 'node:path'
import { Worker } from 'node:worker_threads'
import {
  LEGACY_READY_MARKER_PREFIX,
  READY_MARKER_FILENAME,
  logger,
  LogCategory
} from '@firefly/shared'
import { statOrNull } from '../../infra/fs'

function hasAnyReadyMarkerFile(files: string[]): boolean {
  return files.some(
    f =>
      f === READY_MARKER_FILENAME ||
      (f.startsWith(LEGACY_READY_MARKER_PREFIX) && f.endsWith('.json'))
  )
}
import {
  calculateSharedModulesBytes,
  type ModuleSizeWorkerInMessage,
  type ModuleSizeWorkerOutMessage
} from './workers/module-size-worker'

interface ModuleSizeCacheEntry {
  fingerprint: string
  bytes: number
}

export interface ModuleSizeCacheStats {
  workerDispatchCount: number
  fallbackCount: number
  cacheHitCount: number
  cacheMissCount: number
}

export type WorkerSizeExecutor = (
  sharedDir: string,
  targetModules: string[]
) => Promise<Record<string, number>>

async function resolveModuleSizeWorkerPath(): Promise<string | null> {
  const candidates = [
    path.join(__dirname, 'module-size-worker.js'),
    path.join(__dirname, 'workers', 'module-size-worker.js')
  ]
  if (
    process.env.NODE_ENV === 'test' ||
    process.env.VITEST ||
    process.env.NODE_ENV === 'development'
  ) {
    candidates.push(path.join(__dirname, 'workers', 'module-size-worker.ts'))
  }
  for (const candidate of candidates) {
    try {
      await fsp.access(candidate)
      return candidate
    } catch {
      // 未命中继续探查下一候选入口
    }
  }
  return null
}

/**
 * 默认 Worker 派发器
 */
async function executeInSizeWorker(
  sharedDir: string,
  targetModules: string[],
  timeoutMs = 15000
): Promise<Record<string, number>> {
  const scriptPath = await resolveModuleSizeWorkerPath()
  if (!scriptPath) {
    throw new Error('module-size-worker 脚本不存在')
  }

  const isTs = scriptPath.endsWith('.ts')
  return new Promise<Record<string, number>>((resolve, reject) => {
    let settled = false
    let worker: Worker | null = null
    let timer: NodeJS.Timeout | null = null

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (worker) {
        try {
          void worker.terminate()
        } catch {
          // ignore
        }
        worker = null
      }
    }

    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(err)
    }

    const succeed = (data: Record<string, number>): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve(data)
    }

    try {
      worker = new Worker(scriptPath, {
        execArgv: isTs ? ['--import', 'tsx'] : []
      })
    } catch (err) {
      fail(err instanceof Error ? err : new Error(String(err)))
      return
    }

    timer = setTimeout(() => {
      fail(new Error(`module-size-worker 超时 (${timeoutMs}ms)`))
    }, timeoutMs)

    worker.on('message', (msg: ModuleSizeWorkerOutMessage) => {
      if (msg.type === 'DONE') {
        succeed(msg.moduleBytes)
      } else if (msg.type === 'ERROR') {
        fail(new Error(msg.message))
      }
    })

    worker.on('error', err => {
      fail(err instanceof Error ? err : new Error(String(err)))
    })

    worker.on('exit', code => {
      if (!settled && code !== 0) {
        fail(new Error(`module-size-worker 异常退出 (code=${code})`))
      }
    })

    const payload: ModuleSizeWorkerInMessage = {
      type: 'CALCULATE',
      sharedDir,
      targetModules
    }
    worker.postMessage(payload)
  })
}

export class ModuleSizeCalculator {
  private readonly cache = new Map<string, ModuleSizeCacheEntry>()
  private readonly stats: ModuleSizeCacheStats = {
    workerDispatchCount: 0,
    fallbackCount: 0,
    cacheHitCount: 0,
    cacheMissCount: 0
  }
  private readonly workerExecutor: WorkerSizeExecutor

  constructor(workerExecutor?: WorkerSizeExecutor) {
    this.workerExecutor = workerExecutor ?? (async (dir, mods) => executeInSizeWorker(dir, mods))
  }

  private makeCacheKey(sharedDir: string, moduleId: string): string {
    return `${sharedDir}::${moduleId}`
  }

  /**
   * 构造模块目录轻量指纹（目录 mtimeMs + ready-marker mtime/size + 顶层条目数）
   * 异步非阻塞，不递归遍历子目录。
   */
  private async computeModuleFingerprint(
    moduleDir: string,
    dirStat: import('node:fs').Stats,
    topLevelFiles: string[]
  ): Promise<string> {
    const markerFile = topLevelFiles.find(f => f.startsWith('.ready'))
    let markerSig = 'no-marker'
    if (markerFile) {
      const mst = await statOrNull(path.join(moduleDir, markerFile))
      if (mst) {
        markerSig = `${markerFile}:${mst.mtimeMs}:${mst.size}`
      }
    }
    return `${dirStat.mtimeMs}:${topLevelFiles.length}:${markerSig}`
  }

  /**
   * 计算 `_shared` 下所有已就绪模块的占用字节总数。
   */
  public async calculateUsedBytes(pluginsRootDir: string, forceRefresh = false): Promise<number> {
    const sharedDir = path.join(pluginsRootDir, '_shared')
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fsp.readdir(sharedDir, { withFileTypes: true })
    } catch {
      return 0
    }

    const readyModules: Array<{ id: string; fingerprint: string }> = []
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      const moduleDir = path.join(sharedDir, entry.name)
      try {
        const dirStat = await fsp.lstat(moduleDir)
        if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) continue
        const files = await fsp.readdir(moduleDir)
        if (!hasAnyReadyMarkerFile(files)) continue
        const fingerprint = await this.computeModuleFingerprint(moduleDir, dirStat, files)
        readyModules.push({ id: entry.name, fingerprint })
      } catch {
        // 忽略并发移除或无权限的目录
      }
    }

    if (readyModules.length === 0) {
      this.pruneRemovedModules(sharedDir, new Set())
      return 0
    }

    const activeIds = new Set(readyModules.map(m => m.id))
    this.pruneRemovedModules(sharedDir, activeIds)

    let totalBytes = 0
    const dirtyModules: Array<{ id: string; fingerprint: string }> = []

    for (const mod of readyModules) {
      const key = this.makeCacheKey(sharedDir, mod.id)
      const cached = this.cache.get(key)
      if (!forceRefresh && cached && cached.fingerprint === mod.fingerprint) {
        totalBytes += cached.bytes
        this.stats.cacheHitCount += 1
      } else {
        dirtyModules.push(mod)
        this.stats.cacheMissCount += 1
      }
    }

    if (dirtyModules.length > 0) {
      const targetIds = dirtyModules.map(m => m.id)
      let calculated: Record<string, number>
      try {
        this.stats.workerDispatchCount += 1
        calculated = await this.workerExecutor(sharedDir, targetIds)
      } catch (err) {
        this.stats.fallbackCount += 1
        logger.warn(
          LogCategory.SYSTEM,
          `[ModuleSizeCalculator] Worker 统计模块体积失败，回退主进程异步统计: ${err instanceof Error ? err.message : String(err)}`
        )
        calculated = await calculateSharedModulesBytes(sharedDir, targetIds)
      }

      for (const mod of dirtyModules) {
        const bytes = calculated[mod.id]
        if (typeof bytes === 'number' && Number.isFinite(bytes)) {
          this.cache.set(this.makeCacheKey(sharedDir, mod.id), {
            fingerprint: mod.fingerprint,
            bytes
          })
          totalBytes += bytes
        }
      }
    }

    return totalBytes
  }

  private pruneRemovedModules(sharedDir: string, activeIds: Set<string>): void {
    const prefix = `${sharedDir}::`
    for (const key of this.cache.keys()) {
      if (!key.startsWith(prefix)) continue
      const modId = key.slice(prefix.length)
      if (!activeIds.has(modId)) {
        this.cache.delete(key)
      }
    }
  }

  /**
   * 显式失效缓存（安装、卸载、删除模块或切换目录后调用）。
   */
  public invalidate(moduleId?: string): void {
    if (!moduleId) {
      this.cache.clear()
      return
    }
    const suffix = `::${moduleId}`
    for (const key of this.cache.keys()) {
      if (key.endsWith(suffix)) {
        this.cache.delete(key)
      }
    }
  }

  public getStats(): Readonly<ModuleSizeCacheStats> {
    return { ...this.stats }
  }
}
