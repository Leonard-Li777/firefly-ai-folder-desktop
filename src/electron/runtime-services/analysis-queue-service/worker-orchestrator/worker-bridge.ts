/**
 * 主进程 Analysis Orchestrator Worker 托管桥（WorkerOrchestratorBridge）
 *
 * 负责：
 * 1. 基于 `worker_threads.Worker` + `MessageChannel` 拉起与销毁独立编排线程（B1）
 * 2. 将 `WRITE_SET` / `VIDEO_SEGMENT_WRITE_SET` 路由至 `WriteSetBatchDispatcher` 并回发 `WRITE_ACK`（B2/B3/B4/B5）
 * 3. Worker 崩溃监听（`error`/`exit`）自动回滚在途 `activeQueueIds` 为 `pending` 并按退避重启（B6 验收 1）
 * 4. 用户取消写 `failed + error='canceled_by_user'`（B6 验收 3 / Spec N-1）
 * 5. `YIELD_FOR_UI` / `RESUME` 双端联动（Worker + 主进程写分发器同步暂停，B7 / Spec §8.3.2）
 *
 * @doc-anchor: docs/specs/stage2-analysis-pipeline-worker-optimization-spec.md#2-进程线程三层拓扑唯一基座裁决
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { MessageChannel, Worker, type MessagePort } from 'node:worker_threads'
import type { Database } from 'better-sqlite3'
import { LogCategory, logger } from '@firefly/shared'
import type {
  WorkerConfigSnapshot,
  WorkerInMessage,
  WorkerOutMessage,
  WorkerQueueItem
} from './protocol'
import { WriteSetBatchDispatcher, type WriteAckItem } from './write-set-batch-dispatcher'

const MAX_WORKER_RESTARTS = 5
const WORKER_RESTART_BASE_DELAY_MS = 1000

export interface WorkerOrchestratorBridgeDeps {
  getDb: () => Database | null | undefined
  writeDispatcher: WriteSetBatchDispatcher
  getInitialConfig?: () => WorkerConfigSnapshot
  /** 可覆盖 Worker 入口路径（便于单测与开发/生产双模式定位） */
  workerScriptPath?: string
  onProgress?: (queueId: number, stage: number, pct: number) => void
  onItemFailed?: (queueId: number, errorMessage: string, retryable: boolean) => void
  onHeartbeat?: (hb: {
    queueDepth: number
    activeCount: number
    yielded: boolean
    ts: number
  }) => void
}

/** 定位编译后的 analysis-orchestrator-worker.js 入口（兼容打包后 out_build/main 与单测） */
export function resolveOrchestratorWorkerScriptPath(): string {
  const candidates = [
    path.resolve(__dirname, 'analysis-orchestrator-worker.js'),
    path.resolve(__dirname, '../../out_build/main/analysis-orchestrator-worker.js'),
    path.resolve(process.cwd(), 'out_build/main/analysis-orchestrator-worker.js')
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }
  return candidates[0]
}

export class WorkerOrchestratorBridge {
  private worker: Worker | null = null
  private port: MessagePort | null = null
  private ready = false
  private disposed = false
  private restartCount = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  /** 已下发至 Worker 但尚未收到终态回执的队列 ID（用于崩溃精确回滚） */
  private inflightQueueIds = new Set<number>()
  private lastHeartbeat: {
    queueDepth: number
    activeCount: number
    yielded: boolean
    ts: number
  } | null = null

  constructor(private readonly deps: WorkerOrchestratorBridgeDeps) {}

  isRunning(): boolean {
    return this.worker !== null && !this.disposed
  }

  isReady(): boolean {
    return this.ready
  }

  getInflightQueueIds(): number[] {
    return Array.from(this.inflightQueueIds)
  }

  getLastHeartbeat() {
    return this.lastHeartbeat
  }

  /** 启动 worker_threads 编排线程（幂等） */
  start(): boolean {
    if (this.disposed) return false
    if (this.worker) return true

    const scriptPath = this.deps.workerScriptPath ?? resolveOrchestratorWorkerScriptPath()
    if (!fs.existsSync(scriptPath)) {
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        `[WorkerBridge] Worker 入口脚本不存在，暂跳过线程拉起: ${scriptPath}`
      )
      return false
    }

    const { port1, port2 } = new MessageChannel()
    this.port = port1
    const config = this.deps.getInitialConfig?.() ?? {}

    const worker = new Worker(scriptPath, {
      workerData: { port: port2, config },
      transferList: [port2]
    })
    this.worker = worker

    port1.on('message', (msg: WorkerOutMessage) => {
      this.handleWorkerMessage(msg)
    })

    worker.on('error', err => {
      logger.error(LogCategory.ANALYSIS_QUEUE, '[WorkerBridge] Worker 线程运行异常:', err)
    })

    worker.on('exit', code => {
      const wasDisposed = this.disposed
      this.cleanupHandles()
      if (wasDisposed || code === 0) return

      logger.error(
        LogCategory.ANALYSIS_QUEUE,
        `[WorkerBridge] Worker 异常退出 (code=${code})，回滚 ${this.inflightQueueIds.size} 个在途任务`
      )
      this.rollbackInflightItemsOnCrash()
      this.scheduleRestart()
    })

    return true
  }

  /** 下发任务至 Worker 线程 */
  enqueue(items: WorkerQueueItem[]): boolean {
    if (items.length === 0) return true
    if (!this.worker && !this.start()) {
      return false
    }
    for (const item of items) {
      this.inflightQueueIds.add(item.queueId)
    }
    this.postToWorker({ type: 'ENQUEUE', items })
    return true
  }

  /** 取消单个任务（Spec §10.2 N-1：用户取消落库 failed + error='canceled_by_user'） */
  cancelItem(queueId: number, userInitiated = true): void {
    this.inflightQueueIds.delete(queueId)
    this.postToWorker({ type: 'CANCEL', queueId })

    if (userInitiated) {
      const db = this.deps.getDb()
      if (db) {
        try {
          db.prepare(
            `UPDATE analysis_queue
             SET status = 'failed', error = 'canceled_by_user',
                 end_time = CURRENT_TIMESTAMP, claimed_at = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status IN ('pending', 'analyzing')`
          ).run(queueId)
        } catch (err) {
          logger.warn(
            LogCategory.ANALYSIS_QUEUE,
            `[WorkerBridge] 写入用户取消状态失败 (queueId=${queueId}):`,
            err
          )
        }
      }
    }
  }

  /** Spec §8.3.2：YIELD_FOR_UI 双端联动（Worker + 主进程写分发器同步暂停） */
  yieldForUi(timeoutMs = 2000): void {
    this.deps.writeDispatcher.pauseForUi(timeoutMs)
    this.postToWorker({ type: 'YIELD_FOR_UI', timeoutMs })
  }

  /** 恢复双端执行 */
  resumeFromUi(): void {
    this.deps.writeDispatcher.resumeFromUi()
    this.postToWorker({ type: 'RESUME' })
  }

  /** 增量推送配置补丁给 Worker */
  updateConfig(patch: Partial<WorkerConfigSnapshot>): void {
    this.postToWorker({ type: 'UPDATE_CONFIG', patch })
  }

  /** 向 Worker 回发写集回执 */
  sendWriteAck(ack: WriteAckItem): void {
    this.inflightQueueIds.delete(ack.queueId)
    this.postToWorker({
      type: 'WRITE_ACK',
      queueId: ack.queueId,
      result: ack.result,
      errorKind: ack.errorKind,
      reason: ack.reason
    })
  }

  /** 优雅销毁 Worker 线程（应用退出时由 AnalysisQueueService.dispose() 调用） */
  async dispose(): Promise<void> {
    this.disposed = true
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    const currentWorker = this.worker
    if (currentWorker) {
      this.postToWorker({ type: 'SHUTDOWN' })
      try {
        await Promise.race([
          new Promise<void>(resolve => currentWorker.once('exit', () => resolve())),
          new Promise<void>(resolve => setTimeout(resolve, 1500))
        ])
      } catch (err) {
        logger.warn(LogCategory.ANALYSIS_QUEUE, '[WorkerBridge] 等待 Worker 优雅退出异常:', err)
      }
      if (this.worker === currentWorker) {
        try {
          await currentWorker.terminate()
        } catch (err) {
          logger.warn(LogCategory.ANALYSIS_QUEUE, '[WorkerBridge] 强制终止 Worker 异常:', err)
        }
      }
    }
    this.cleanupHandles()
    this.inflightQueueIds.clear()
  }

  private handleWorkerMessage(msg: WorkerOutMessage): void {
    switch (msg.type) {
      case 'READY': {
        this.ready = true
        this.restartCount = 0
        break
      }
      case 'WRITE_SET': {
        this.deps.writeDispatcher.enqueue(msg.payload)
        break
      }
      case 'VIDEO_SEGMENT_WRITE_SET': {
        const ack = this.deps.writeDispatcher.commitVideoSegment(msg.payload)
        this.sendWriteAck(ack)
        break
      }
      case 'ANALYSIS_FAILED': {
        this.inflightQueueIds.delete(msg.queueId)
        this.handleAnalysisFailed(msg.queueId, msg.errorMessage, msg.retryable)
        break
      }
      case 'PROGRESS': {
        this.deps.onProgress?.(msg.queueId, msg.stage, msg.pct)
        break
      }
      case 'HEARTBEAT': {
        this.lastHeartbeat = {
          queueDepth: msg.queueDepth,
          activeCount: msg.activeCount,
          yielded: msg.yielded,
          ts: msg.ts
        }
        this.deps.onHeartbeat?.(this.lastHeartbeat)
        break
      }
      case 'LOG': {
        const level = msg.level
        if (level === 'error') {
          logger.error(LogCategory.ANALYSIS_QUEUE, msg.msg, msg.ctx)
        } else if (level === 'warn') {
          logger.warn(LogCategory.ANALYSIS_QUEUE, msg.msg, msg.ctx)
        } else if (level === 'info') {
          logger.info(LogCategory.ANALYSIS_QUEUE, msg.msg, msg.ctx)
        } else {
          logger.debug(LogCategory.ANALYSIS_QUEUE, msg.msg, msg.ctx)
        }
        break
      }
    }
  }

  private handleAnalysisFailed(queueId: number, errorMessage: string, retryable: boolean): void {
    const db = this.deps.getDb()
    if (db) {
      try {
        if (retryable) {
          db.prepare(
            `UPDATE analysis_queue
             SET status = 'pending', error = ?, claimed_at = NULL,
                 retry_count = retry_count + 1, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'analyzing'`
          ).run(errorMessage, queueId)
        } else {
          db.prepare(
            `UPDATE analysis_queue
             SET status = 'failed', error = ?, end_time = CURRENT_TIMESTAMP,
                 claimed_at = NULL, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'analyzing'`
          ).run(errorMessage, queueId)
        }
      } catch (err) {
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          `[WorkerBridge] 落库 ANALYSIS_FAILED 失败 (queueId=${queueId}):`,
          err
        )
      }
    }
    this.deps.onItemFailed?.(queueId, errorMessage, retryable)
  }

  /** B6 验收 1：Worker 崩溃退出时将所有在途任务回滚为 pending 可重试 */
  private rollbackInflightItemsOnCrash(): void {
    const ids = Array.from(this.inflightQueueIds)
    this.inflightQueueIds.clear()
    if (ids.length === 0) return

    const db = this.deps.getDb()
    if (!db) return

    try {
      const tx = db.transaction(() => {
        const stmt = db.prepare(
          `UPDATE analysis_queue
           SET status = 'pending', claimed_at = NULL,
               retry_count = retry_count + 1, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'analyzing'`
        )
        for (const id of ids) {
          stmt.run(id)
        }
      })
      tx()
    } catch (err) {
      logger.error(LogCategory.ANALYSIS_QUEUE, '[WorkerBridge] Worker 崩溃回滚在途队列失败:', err)
    }
  }

  private scheduleRestart(): void {
    if (this.disposed) return
    if (this.restartCount >= MAX_WORKER_RESTARTS) {
      logger.error(
        LogCategory.ANALYSIS_QUEUE,
        `[WorkerBridge] Worker 连续崩溃超过上限 (${MAX_WORKER_RESTARTS})，停止自动重启`
      )
      return
    }
    this.restartCount++
    const delayMs = WORKER_RESTART_BASE_DELAY_MS * Math.pow(2, this.restartCount - 1)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.start()
    }, delayMs)
    this.restartTimer.unref?.()
  }

  private postToWorker(msg: WorkerInMessage): void {
    if (!this.port) return
    try {
      this.port.postMessage(msg)
    } catch (err) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[WorkerBridge] postMessage 失败:', err)
    }
  }

  private cleanupHandles(): void {
    this.ready = false
    if (this.port) {
      try {
        this.port.close()
      } catch {
        // 端口已关闭时忽略
      }
      this.port = null
    }
    this.worker = null
  }
}
