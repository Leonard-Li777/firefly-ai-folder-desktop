/**
 * Stage 2 Analysis Orchestrator Worker 独立线程实现（worker_threads）
 *
 * 严格遵守 Spec §2 / §3 / §7 / §8 / §9 职责白名单：
 * - 严禁加载 better-sqlite3 / electron / BrowserWindow
 * - 严禁调用 os.setPriority(process.pid)（§9.2 Phase A 禁令）
 * - 仅执行：队列优先级调度、本地 CPU 预处理（流式 SHA-256 / 文本提取 / 同步 deflateSync）、
 *   外部引擎 HTTP 编排（Omni 硬串行 MAX_OMNI_CONCURRENT=1）、写集序列化 + 安全 transferable 回传
 *
 * @doc-anchor: docs/specs/stage2-analysis-pipeline-worker-optimization-spec.md#3-analysis-orchestrator-worker-职责白名单
 */

import * as fs from 'node:fs'
import * as crypto from 'node:crypto'
import * as os from 'node:os'
import * as zlib from 'node:zlib'
import { isMainThread, parentPort, workerData, type MessagePort } from 'node:worker_threads'
import { classifyWorkerErrorKind, type AnalysisErrorKind } from './worker-error-classifier'
import {
  prepareWriteSetTransfer,
  type AnalysisWriteSet,
  type WorkerConfigSnapshot,
  type WorkerInMessage,
  type WorkerOutMessage,
  type WorkerQueueItem
} from './protocol'

/** Spec §9.1：本地提取并发上限（双核 1、四核+ 2） */
export function computeDefaultMaxConcurrent(cpuCount = os.cpus().length): number {
  return Math.max(1, Math.min(2, cpuCount - 2))
}

/** Spec §9.1 硬约束：Omni Rust HTTP 并发上限恒为 1（为分类维度树留足线程池余量） */
export const MAX_OMNI_CONCURRENT = 1

/** 心跳周期（Spec §7.2：每 5s） */
export const WORKER_HEARTBEAT_INTERVAL_MS = 5000

/** 默认文本提取字节上限（256KB） */
const DEFAULT_MAX_TEXT_EXTRACT_BYTES = 256 * 1024

/** 支持直接读取纯文本的常见扩展名 */
const PLAIN_TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.json',
  '.yaml',
  '.yml',
  '.xml',
  '.csv',
  '.tsv',
  '.log',
  '.ini',
  '.toml',
  '.conf',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.rb',
  '.php',
  '.sh',
  '.ps1',
  '.sql',
  '.html',
  '.css',
  '.scss',
  '.vue',
  '.svelte'
])

/**
 * 与 apps/desktop/src/electron/runtime-services/utils/text-compressor.ts 同源的同步压缩：
 * 带 zlib 头 `deflateSync(level: 6)`（[VERIFY-03] 锁定，严禁改用 deflateRawSync 或异步 zlib.deflate）。
 */
export function compressFieldSync(text: string | null | undefined): Uint8Array | null {
  if (!text) return null
  const buf = zlib.deflateSync(Buffer.from(text, 'utf8'), { level: 6 })
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

/** 流式计算文件 SHA-256 指纹（支持 AbortSignal 中断） */
export async function computeFileSha256(filePath: string, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (signal.aborted) {
      const abortErr = new Error('Aborted')
      abortErr.name = 'AbortError'
      reject(abortErr)
      return
    }
    const hash = crypto.createHash('sha256')
    const stream = fs.createReadStream(filePath, { highWaterMark: 64 * 1024 })
    const onAbort = () => {
      stream.destroy()
      const abortErr = new Error('Aborted')
      abortErr.name = 'AbortError'
      reject(abortErr)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    stream.on('data', chunk => {
      hash.update(chunk)
    })
    stream.on('error', err => {
      signal.removeEventListener('abort', onAbort)
      reject(err)
    })
    stream.on('end', () => {
      signal.removeEventListener('abort', onAbort)
      resolve(hash.digest('hex'))
    })
  })
}

/** 有界读取纯文本内容（支持 AbortSignal） */
export async function readBoundedPlainText(
  filePath: string,
  maxBytes: number,
  signal: AbortSignal
): Promise<string | undefined> {
  if (signal.aborted) return undefined
  const handle = await fs.promises.open(filePath, 'r')
  try {
    const stat = await handle.stat()
    const readLen = Math.min(stat.size, maxBytes)
    if (readLen <= 0) return undefined
    const buf = Buffer.allocUnsafe(readLen)
    const { bytesRead } = await handle.read(buf, 0, readLen, 0)
    if (bytesRead <= 0) return undefined
    // 跳过含 NUL 字节的二进制伪装文本，防 PostgreSQL 22P05 与乱码污染
    const slice = buf.subarray(0, bytesRead)
    if (slice.includes(0)) return undefined
    return slice.toString('utf8')
  } finally {
    await handle.close()
  }
}

/** 串行水闸（用于强制 Omni HTTP 并发 ≤ 1，Spec §9.1） */
export class SerialGate {
  private active = 0
  private waiters: Array<() => void> = []

  constructor(private readonly maxConcurrent = MAX_OMNI_CONCURRENT) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) {
      await new Promise<void>(resolve => this.waiters.push(resolve))
    }
    this.active++
    try {
      return await task()
    } finally {
      this.active--
      const next = this.waiters.shift()
      if (next) next()
    }
  }
}

export interface OrchestratorRuntimeDeps {
  postMessage: (msg: WorkerOutMessage, transferList?: ArrayBuffer[]) => void
  initialConfig?: WorkerConfigSnapshot
  /** 可注入自定义 HTTP fetch（便于单测隔离外部引擎） */
  fetchFn?: typeof fetch
  heartbeatIntervalMs?: number
}

/**
 * Stage 2 Worker 编排运行时（可独立单测，也可由 worker_threads 入口直接驱动）
 */
export class Stage2OrchestratorRuntime {
  private config: WorkerConfigSnapshot
  private maxConcurrent: number
  private queue: WorkerQueueItem[] = []
  private activeTasks = new Map<number, AbortController>()
  private canceledIds = new Set<number>()
  private yielded = false
  private yieldAutoResumeTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private shuttingDown = false
  private readonly omniGate = new SerialGate(MAX_OMNI_CONCURRENT)
  private readonly fetchFn: typeof fetch

  constructor(private readonly deps: OrchestratorRuntimeDeps) {
    this.config = { ...(deps.initialConfig ?? {}) }
    this.maxConcurrent = this.config.maxConcurrent ?? computeDefaultMaxConcurrent()
    this.fetchFn = deps.fetchFn ?? globalThis.fetch
  }

  startHeartbeat(): void {
    if (this.heartbeatTimer) return
    const intervalMs = this.deps.heartbeatIntervalMs ?? WORKER_HEARTBEAT_INTERVAL_MS
    this.heartbeatTimer = setInterval(() => {
      this.deps.postMessage({
        type: 'HEARTBEAT',
        queueDepth: this.queue.length,
        activeCount: this.activeTasks.size,
        yielded: this.yielded,
        ts: Date.now()
      })
    }, intervalMs)
    this.heartbeatTimer.unref?.()
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
  }

  getState(): { queueDepth: number; activeCount: number; yielded: boolean; maxConcurrent: number } {
    return {
      queueDepth: this.queue.length,
      activeCount: this.activeTasks.size,
      yielded: this.yielded,
      maxConcurrent: this.maxConcurrent
    }
  }

  handleMessage(msg: WorkerInMessage): void {
    switch (msg.type) {
      case 'ENQUEUE': {
        if (this.shuttingDown) return
        for (const item of msg.items) {
          this.canceledIds.delete(item.queueId)
          if (
            this.activeTasks.has(item.queueId) ||
            this.queue.some(q => q.queueId === item.queueId)
          ) {
            continue
          }
          this.queue.push(item)
        }
        // 按 priority DESC, queueId ASC 维护优先级序
        this.queue.sort((a, b) => b.priority - a.priority || a.queueId - b.queueId)
        this.pump()
        break
      }
      case 'CANCEL': {
        this.canceledIds.add(msg.queueId)
        this.queue = this.queue.filter(q => q.queueId !== msg.queueId)
        const controller = this.activeTasks.get(msg.queueId)
        if (controller) {
          controller.abort()
        }
        break
      }
      case 'YIELD_FOR_UI': {
        this.enterYield(msg.timeoutMs)
        break
      }
      case 'RESUME': {
        this.exitYield()
        break
      }
      case 'UPDATE_CONFIG': {
        this.config = { ...this.config, ...msg.patch }
        if (msg.patch.maxConcurrent !== undefined && msg.patch.maxConcurrent > 0) {
          this.maxConcurrent = msg.patch.maxConcurrent
          this.pump()
        }
        break
      }
      case 'WRITE_ACK': {
        // WRITE_ACK 确认后继续泵送后续任务
        this.pump()
        break
      }
      case 'SHUTDOWN': {
        this.shutdown()
        break
      }
    }
  }

  private enterYield(timeoutMs: number): void {
    this.yielded = true
    if (this.yieldAutoResumeTimer) {
      clearTimeout(this.yieldAutoResumeTimer)
      this.yieldAutoResumeTimer = null
    }
    // Spec §8.2：等待 RESUME，或 timeoutMs * 3 超时自动恢复兜底
    const autoResumeMs = Math.max(1000, timeoutMs * 3)
    this.yieldAutoResumeTimer = setTimeout(() => {
      this.yieldAutoResumeTimer = null
      this.exitYield()
    }, autoResumeMs)
    this.yieldAutoResumeTimer.unref?.()
  }

  private exitYield(): void {
    if (!this.yielded) return
    this.yielded = false
    if (this.yieldAutoResumeTimer) {
      clearTimeout(this.yieldAutoResumeTimer)
      this.yieldAutoResumeTimer = null
    }
    this.pump()
  }

  shutdown(): void {
    this.shuttingDown = true
    this.stopHeartbeat()
    if (this.yieldAutoResumeTimer) {
      clearTimeout(this.yieldAutoResumeTimer)
      this.yieldAutoResumeTimer = null
    }
    this.queue = []
    for (const controller of this.activeTasks.values()) {
      controller.abort()
    }
    this.activeTasks.clear()
  }

  private pump(): void {
    if (this.shuttingDown || this.yielded) return
    while (this.activeTasks.size < this.maxConcurrent && this.queue.length > 0 && !this.yielded) {
      const next = this.queue.shift()!
      if (this.canceledIds.has(next.queueId)) {
        this.canceledIds.delete(next.queueId)
        continue
      }
      const controller = new AbortController()
      this.activeTasks.set(next.queueId, controller)
      void this.processItem(next, controller.signal).finally(() => {
        this.activeTasks.delete(next.queueId)
        this.canceledIds.delete(next.queueId)
        setImmediate(() => this.pump())
      })
    }
  }

  private async processItem(item: WorkerQueueItem, signal: AbortSignal): Promise<void> {
    try {
      this.deps.postMessage({ type: 'PROGRESS', queueId: item.queueId, stage: 2, pct: 10 })

      // 1. 流式计算文件指纹（或复用已有指纹）
      const fingerprint =
        item.existingFingerprint && item.existingFingerprint.trim().length > 0
          ? item.existingFingerprint
          : await computeFileSha256(item.physicalPath, signal)

      if (signal.aborted) return
      this.deps.postMessage({ type: 'PROGRESS', queueId: item.queueId, stage: 2, pct: 35 })

      // 2. 本地 CPU 预处理：有界文本提取（仅非跳过正文且属纯文本扩展名）
      let plainContent: string | undefined
      const extLower = (item.extension || '').toLowerCase()
      if (item.extractText !== false && PLAIN_TEXT_EXTENSIONS.has(extLower)) {
        plainContent = await readBoundedPlainText(
          item.physicalPath,
          this.config.maxTextExtractBytes ?? DEFAULT_MAX_TEXT_EXTRACT_BYTES,
          signal
        )
      }
      if (signal.aborted) return

      // 3. 外部 Omni HTTP 编排（受 MAX_OMNI_CONCURRENT=1 硬串行水闸约束，Spec §9.1）
      let tagRelations: AnalysisWriteSet['tagRelations']
      let description: string | null = null
      if (this.config.omniBaseUrl && plainContent && plainContent.trim().length > 0) {
        const omniResult = await this.omniGate.run(() =>
          this.requestOmniAnalyze(item, plainContent!, signal)
        )
        if (omniResult) {
          tagRelations = omniResult.tagRelations
          description = omniResult.description ?? null
        }
      }
      if (signal.aborted) return

      this.deps.postMessage({ type: 'PROGRESS', queueId: item.queueId, stage: 2, pct: 75 })

      // 4. Worker 内同步 Zlib 压缩（Spec §3：deflateSync 不走 libuv 线程池，字段间让出 tick）
      const contentBlob = compressFieldSync(plainContent)
      await new Promise<void>(resolve => setImmediate(resolve))
      if (signal.aborted) return

      const writeSet: AnalysisWriteSet = {
        queueId: item.queueId,
        guard: item.guard,
        fileFingerprint: fingerprint,
        workspaceFileId: item.workspaceFileId,
        physicalPath: item.physicalPath,
        fileName: item.fileName,
        filesUpdate: {
          description,
          size: item.guard.size,
          extension: item.extension,
          fileGroup: item.fileGroup ?? null
        },
        fileContents: plainContent
          ? {
              contentBlob,
              plainContent
            }
          : undefined,
        tagRelations,
        queueUpdate: {
          status: 'completed',
          endTime: new Date().toISOString(),
          progress: 100
        },
        canonicalVectorWakeup: Boolean(plainContent || (tagRelations && tagRelations.length > 0))
      }

      const { payload, transferList } = prepareWriteSetTransfer(writeSet)
      this.deps.postMessage({ type: 'WRITE_SET', payload }, transferList)
    } catch (err) {
      if (signal.aborted || this.canceledIds.has(item.queueId)) {
        return
      }
      const { kind, retryable } = classifyWorkerErrorKind(err)
      const errorMessage = err instanceof Error ? err.message : String(err)
      this.deps.postMessage({
        type: 'LOG',
        level: 'warn',
        msg: `[OrchestratorWorker] 任务处理失败 (queueId=${item.queueId}, kind=${kind}): ${errorMessage}`
      })
      this.deps.postMessage({
        type: 'ANALYSIS_FAILED',
        queueId: item.queueId,
        errorKind: kind as AnalysisErrorKind,
        errorMessage,
        retryable
      })
    }
  }

  private async requestOmniAnalyze(
    item: WorkerQueueItem,
    text: string,
    signal: AbortSignal
  ): Promise<{
    description?: string
    tagRelations?: AnalysisWriteSet['tagRelations']
  } | null> {
    const baseUrl = this.config.omniBaseUrl?.replace(/\/+$/, '')
    if (!baseUrl || typeof this.fetchFn !== 'function') return null

    const timeoutMs = this.config.httpTimeoutMs ?? 30_000
    const reqController = new AbortController()
    const onParentAbort = () => reqController.abort()
    signal.addEventListener('abort', onParentAbort, { once: true })
    const timeoutTimer = setTimeout(() => reqController.abort(), timeoutMs)

    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (this.config.omniToken) {
        headers['Authorization'] = `Bearer ${this.config.omniToken}`
      }
      const resp = await this.fetchFn(`${baseUrl}/api/text/extract-tags`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          file_name: item.fileName,
          extension: item.extension,
          text: text.slice(0, 16 * 1024)
        }),
        signal: reqController.signal
      })
      if (!resp.ok) {
        const httpErr = Object.assign(new Error(`Omni HTTP ${resp.status}`), {
          status: resp.status
        })
        throw httpErr
      }
      const data = (await resp.json()) as {
        description?: string
        tagRelations?: AnalysisWriteSet['tagRelations']
      }
      return data
    } catch (err) {
      if (signal.aborted) throw err
      // 外部接口非瞬态 404（老版本 Omni 未提供该路由）降级为纯本地预处理并显式打日志
      const status = (err as { status?: number })?.status
      if (status === 404) {
        this.deps.postMessage({
          type: 'LOG',
          level: 'warn',
          msg: `[OrchestratorWorker] Omni /api/text/extract-tags 返回 404，回退为本地预处理 (queueId=${item.queueId})`
        })
        return null
      }
      throw err
    } finally {
      clearTimeout(timeoutTimer)
      signal.removeEventListener('abort', onParentAbort)
    }
  }
}

// ==================== worker_threads 独立线程入口 ====================
if (!isMainThread && parentPort) {
  const data = (workerData ?? {}) as {
    port?: MessagePort
    config?: WorkerConfigSnapshot
  }
  const channel: MessagePort = data.port ?? parentPort

  const runtime = new Stage2OrchestratorRuntime({
    initialConfig: data.config,
    postMessage: (msg, transferList) => {
      if (transferList && transferList.length > 0) {
        channel.postMessage(msg, transferList)
      } else {
        channel.postMessage(msg)
      }
    }
  })

  channel.on('message', (msg: WorkerInMessage) => {
    runtime.handleMessage(msg)
    if (msg.type === 'SHUTDOWN') {
      channel.close()
    }
  })

  runtime.startHeartbeat()
  channel.postMessage({ type: 'READY' } satisfies WorkerOutMessage)
}
