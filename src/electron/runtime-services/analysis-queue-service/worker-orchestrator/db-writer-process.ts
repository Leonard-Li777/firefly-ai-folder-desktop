/**
 * Stage2 S-B 主进程写微事务执行进程宿主（AnalysisDbWriterProcess）
 *
 * 基于 Electron `utilityProcess` 拉起独立 PID 写进程（writer-process-entry.ts）：
 * - 接收 Worker 编排线程产出的 `WRITE_SET` / `VIDEO_SEGMENT_WRITE_SET` 并转发子进程；
 * - 子进程经同一 `WriteSetBatchDispatcher` 实现以 setImmediate 分片执行写盘
 *   （单批写微事务目标 ≤10ms，主线程零阻塞）；
 * - 子进程崩溃 → watchdog 指数退避重启，未确认写集（含崩溃瞬间在途批）在新进程
 *   READY 后原序回灌（WRITE_SET 不丢）；连续崩溃超上限 → 显式上报丢失并降级路由
 *   至主进程本地执行器（严禁静默吞掉）；
 * - 聚合批级耗时指标（p50/p99/max）供工单 05/06 量化验收。
 *
 * 命名防腐说明：主进程本地 `WriteSetBatchDispatcher` 并非死代码——它是
 * `ANALYSIS_USE_DB_WRITER_PROCESS` 关闭或写进程连续崩溃降级时的合法执行路径，
 * 与本宿主共享同一写集实现，不可删除。
 *
 * @doc-anchor: docs/specs/stage2-analysis-pipeline-worker-optimization-spec.md#phase-b写路径收口条件触发
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'
import { LogCategory, logger } from '@firefly/shared'
import type { AnalysisWriteSet, VideoSegmentWriteSet } from './protocol'
import type { WriteAckItem } from './write-set-batch-dispatcher'
import type {
  WriterBatchMetrics,
  WriterInMessage,
  WriterOutMessage,
  WriterTailHookPayload
} from './writer-process-protocol'

/** 子进程 READY 等待超时（超时视为启动失败，kill 后走 watchdog 重启） */
const WRITER_READY_TIMEOUT_MS = 10_000
/** 默认连续崩溃重启上限（与 worker-bridge 一致） */
const MAX_WRITER_RESTARTS = 5
/** 重启退避基值（ms） */
const WRITER_RESTART_BASE_DELAY_MS = 1000
/** dispose 时等待子进程优雅退出超时（ms） */
const WRITER_SHUTDOWN_GRACE_MS = 1500
/** 指标环形缓冲容量（≈最近 500 批） */
const METRICS_RING_CAPACITY = 500

export interface WriterProcessForkOptions {
  /** Electron UtilityProcess 附加环境变量（预留） */
  env?: Record<string, string>
}

/** 可注入 fork 工厂（单测隔离真实 utilityProcess；生产默认 electron.utilityProcess.fork） */
export type WriterProcessForkFn = (
  modulePath: string,
  args?: string[],
  options?: WriterProcessForkOptions
) => UtilityProcess

export interface AnalysisDbWriterProcessDeps {
  /** 主库文件路径（子进程自开独立写连接） */
  getDbPath: () => string
  /** FTS 展示 locale 快照读取（经 INIT 握手显式下发子进程） */
  getDisplayLocale: () => string
  /** 写集回执上抛（调用方接回 workerBridge.sendWriteAck 闭环） */
  onWriteAck?: (ack: WriteAckItem) => void
  /** COMMIT 尾钩子上抛（canonicalMaintenance / cloudSync 驻留主进程） */
  onTailHook?: (payload: WriterTailHookPayload) => void
  /** 批级量化指标上抛（工单 05 ≤10ms 验收采集） */
  onBatchMetrics?: (metrics: WriterBatchMetrics) => void
  /**
   * 降级路由回调：写进程不可用（入口缺失 / 连续崩溃超上限）时触发，
   * 携带全部未确认写集实体——调用方必须逐条转投主进程本地执行器并显式留痕，
   * 严禁静默丢写集（红线：禁止静默降级）。
   */
  onDegradedToLocal?: (reason: string, entries: DegradedWriteEntry[]) => void
  /** 可覆盖子进程入口路径（单测与开发/生产双模式定位） */
  entryScriptPath?: string
  /** 可注入 fork 工厂（单测隔离） */
  forkFn?: WriterProcessForkFn
  maxRestarts?: number
  restartBaseDelayMs?: number
  /** READY 等待超时覆盖（单测用） */
  readyTimeoutMs?: number
}

/** 降级移交的写集实体（kind 区分 8 步文件写集与视频分段独立事务） */
export interface DegradedWriteEntry {
  kind: 'write_set' | 'video_segment'
  writeSet?: AnalysisWriteSet
  videoSeg?: VideoSegmentWriteSet
}

export interface WriterProcessMetricsSnapshot {
  batches: number
  totalFiles: number
  p50Ms: number
  p99Ms: number
  maxMs: number
  /** 最近一次批耗时（ms） */
  lastBatchMs: number
}

/** 定位编译后的 analysis-db-writer-process.js 子进程入口（兼容打包与单测环境） */
export function resolveWriterProcessScriptPath(): string {
  const candidates = [
    path.resolve(__dirname, 'analysis-db-writer-process.js'),
    path.resolve(__dirname, '../../out_build/main/analysis-db-writer-process.js'),
    path.resolve(process.cwd(), 'out_build/main/analysis-db-writer-process.js')
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }
  return candidates[0]
}

type WriterProcessState = 'idle' | 'starting' | 'ready' | 'crashed' | 'exhausted' | 'disposed'

/** 崩溃时在途未确认的写集条目（按产生顺序回灌） */
interface PendingWriteEntry {
  kind: 'write_set' | 'video_segment'
  writeSet?: AnalysisWriteSet
  videoSeg?: VideoSegmentWriteSet
}

export class AnalysisDbWriterProcess {
  private child: UtilityProcess | null = null
  private state: WriterProcessState = 'idle'
  private restartCount = 0
  private restartTimer: ReturnType<typeof setTimeout> | null = null
  private readyTimer: ReturnType<typeof setTimeout> | null = null

  /** 已下发子进程但未收到 WRITE_ACK 的在途写集（崩溃回灌依据） */
  private pendingWriteSets = new Map<number, AnalysisWriteSet>()
  /** 已下发子进程但未收到回执的视频分段写集 */
  private pendingVideoSegs: VideoSegmentWriteSet[] = []
  /** READY 前缓存的出站消息（INIT 之外全部经 outbox 保序投递） */
  private outbox: WriterInMessage[] = []
  /** 崩溃时尚未发出的出站写集（重启后最先回灌） */
  private crashOrphans: PendingWriteEntry[] = []

  private metricsDurations: number[] = []
  private metricsTotalFiles = 0
  private lastBatchMs = 0

  private yielded = false

  constructor(private readonly deps: AnalysisDbWriterProcessDeps) {}

  /** 当前子进程 PID（可观测性） */
  getPid(): number | undefined {
    return this.child?.pid
  }

  getState(): WriterProcessState {
    return this.state
  }

  /** 是否已就绪可接收写集 */
  isReady(): boolean {
    return this.state === 'ready'
  }

  /**
   * 拉起子进程并发送 INIT 握手（幂等；ready/starting/crashed 状态下不重复 fork）。
   * 启动失败（入口脚本缺失等）显式 error 留痕、状态置 exhausted 并降级，严禁静默。
   */
  start(): boolean {
    if (this.state === 'disposed') return false
    if (this.state === 'ready' || this.state === 'starting' || this.state === 'crashed') return true

    const scriptPath = this.deps.entryScriptPath ?? resolveWriterProcessScriptPath()
    if (!fs.existsSync(scriptPath)) {
      logger.error(
        LogCategory.ANALYSIS_QUEUE,
        `[DbWriterProcess] 子进程入口脚本不存在，无法拉起写进程: ${scriptPath}`
      )
      this.state = 'exhausted'
      this.degradePendingToLocal('entry_script_missing')
      return false
    }

    this.state = 'starting'
    const forkFn = this.deps.forkFn ?? ((modulePath: string) => utilityProcess.fork(modulePath))
    const child = forkFn(scriptPath)
    this.child = child

    child.on('message', (msg: WriterOutMessage) => {
      // 身份守卫：仅处理当前子进程的消息，旧子进程迟到的消息/事件一律忽略（防竞态串写状态）
      if (this.child !== child) return
      this.handleChildMessage(msg)
    })

    child.on('exit', (code: number) => {
      // 身份守卫：旧子进程的迟到 exit 不清除新子进程引用、不触发崩溃记账（R1 盲审发现 3）
      if (this.child !== child) return
      this.handleChildExit(code)
    })

    // INIT 握手立即下发（Electron postMessage 在 spawn 前自动排队）
    child.postMessage({
      type: 'INIT',
      dbPath: this.deps.getDbPath(),
      displayLocale: this.deps.getDisplayLocale()
    } satisfies WriterInMessage)

    this.readyTimer = setTimeout(() => {
      this.readyTimer = null
      if (this.state === 'starting' && this.child === child) {
        logger.error(
          LogCategory.ANALYSIS_QUEUE,
          `[DbWriterProcess] 子进程 READY 超时 (${this.deps.readyTimeoutMs ?? WRITER_READY_TIMEOUT_MS}ms)，kill 后 watchdog 重启`
        )
        this.killChild()
        this.handleChildCrash('ready_timeout')
      }
    }, this.deps.readyTimeoutMs ?? WRITER_READY_TIMEOUT_MS)
    this.readyTimer.unref?.()

    return true
  }

  /** 投递单个文件写集（bridge WRITE_SET 数据面唯一入口；不可用时显式降级留痕） */
  enqueue(writeSet: AnalysisWriteSet): void {
    if (this.state === 'disposed') return

    if (this.state === 'exhausted') {
      this.degradePendingToLocal('process_exhausted', [{ kind: 'write_set', writeSet }])
      return
    }

    if (this.state === 'ready' && this.child) {
      this.pendingWriteSets.set(writeSet.queueId, writeSet)
      this.postToChild({ type: 'WRITE_SET', payload: writeSet })
      return
    }

    // starting / crashed：入 outbox 保序，READY 后冲刷（WRITE_SET 不丢，严禁期间抢占 fork）
    this.outbox.push({ type: 'WRITE_SET', payload: writeSet })
    this.pendingWriteSets.set(writeSet.queueId, writeSet)
    if (this.state === 'idle') {
      this.start()
    }
  }

  /**
   * 投递视频分段独立事务写集。
   * 返回 null 表示已转交子进程、回执将经 onWriteAck 异步上抛（bridge 侧不得重复 ACK）；
   * 返回 WriteAckItem 表示已同步降级本地执行并当场闭环。
   */
  commitVideoSegment(seg: VideoSegmentWriteSet): WriteAckItem | null {
    if (this.state === 'disposed') {
      return { queueId: seg.queueId, result: 'error', reason: 'writer_process_disposed' }
    }

    if (this.state === 'exhausted') {
      this.degradePendingToLocal('process_exhausted', [{ kind: 'video_segment', videoSeg: seg }])
      return null
    }

    if (this.state === 'ready' && this.child) {
      this.pendingVideoSegs.push(seg)
      this.postToChild({ type: 'VIDEO_SEGMENT_WRITE_SET', payload: seg })
      return null
    }

    this.outbox.push({ type: 'VIDEO_SEGMENT_WRITE_SET', payload: seg })
    this.pendingVideoSegs.push(seg)
    if (this.state === 'idle') {
      this.start()
    }
    return null
  }

  /** Spec §8.3.2：YIELD_FOR_UI 让路（就绪前入 outbox 保序，READY 后冲刷） */
  yieldForUi(timeoutMs: number): void {
    this.yielded = true
    if (this.state === 'ready' && this.child) {
      this.postToChild({ type: 'YIELD_FOR_UI', timeoutMs })
    } else {
      this.outbox.push({ type: 'YIELD_FOR_UI', timeoutMs })
    }
  }

  /** 恢复双端执行（就绪前入 outbox 保序，READY 后冲刷） */
  resumeFromUi(): void {
    this.yielded = false
    if (this.state === 'ready' && this.child) {
      this.postToChild({ type: 'RESUME' })
    } else {
      this.outbox.push({ type: 'RESUME' })
    }
  }

  isYielded(): boolean {
    return this.yielded
  }

  /** 工单 05 量化指标快照（p50/p99/max） */
  getMetrics(): WriterProcessMetricsSnapshot {
    const durations = [...this.metricsDurations].sort((a, b) => a - b)
    const pick = (ratio: number): number =>
      durations.length === 0
        ? 0
        : durations[Math.min(durations.length - 1, Math.floor(ratio * (durations.length - 1)))]!
    return {
      batches: durations.length,
      totalFiles: this.metricsTotalFiles,
      p50Ms: pick(0.5),
      p99Ms: pick(0.99),
      maxMs: durations.length === 0 ? 0 : durations[durations.length - 1]!,
      lastBatchMs: this.lastBatchMs
    }
  }

  /** 优雅销毁：SHUTDOWN → 等待退出 → 强杀（应用退出前调用） */
  async dispose(): Promise<void> {
    this.state = 'disposed'
    if (this.restartTimer) {
      clearTimeout(this.restartTimer)
      this.restartTimer = null
    }
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }

    const current = this.child
    if (current) {
      try {
        current.postMessage({ type: 'SHUTDOWN' } satisfies WriterInMessage)
      } catch (err) {
        logger.warn(LogCategory.ANALYSIS_QUEUE, '[DbWriterProcess] 下发 SHUTDOWN 失败:', err)
      }
      try {
        await Promise.race([
          new Promise<void>(resolve => current.once('exit', () => resolve())),
          new Promise<void>(resolve => setTimeout(resolve, WRITER_SHUTDOWN_GRACE_MS))
        ])
      } catch (err) {
        logger.warn(LogCategory.ANALYSIS_QUEUE, '[DbWriterProcess] 等待子进程退出异常:', err)
      }
      this.killChild()
    }
    this.child = null
    // 已无子进程且不再重启：剩余未确认写集转投现成降级通路（R1 盲审发现 7）——
    // 调用方 onDegradedToLocal 会把实体转投主进程本地执行器并在其 dispose 前完成冲刷，
    // 严禁静默清空导致队列行滞留 analyzing 产生不必要的重分析。
    const leftoverEntries: DegradedWriteEntry[] = []
    // R2 盲审建议 2：跨容器去重（starting/crashed 双容器态与 handleChildCrash 同源问题）
    const leftoverWriteSetIds = new Set<number>()
    const leftoverSegmentIds = new Set<string>()
    for (const [, ws] of this.pendingWriteSets) {
      if (leftoverWriteSetIds.has(ws.queueId)) continue
      leftoverWriteSetIds.add(ws.queueId)
      leftoverEntries.push({ kind: 'write_set', writeSet: ws })
    }
    for (const seg of this.pendingVideoSegs) {
      if (leftoverSegmentIds.has(seg.segmentId)) continue
      leftoverSegmentIds.add(seg.segmentId)
      leftoverEntries.push({ kind: 'video_segment', videoSeg: seg })
    }
    for (const entry of this.crashOrphans) {
      if (entry.kind === 'write_set' && entry.writeSet) {
        if (leftoverWriteSetIds.has(entry.writeSet.queueId)) continue
        leftoverWriteSetIds.add(entry.writeSet.queueId)
        leftoverEntries.push({ kind: 'write_set', writeSet: entry.writeSet })
      } else if (entry.kind === 'video_segment' && entry.videoSeg) {
        if (leftoverSegmentIds.has(entry.videoSeg.segmentId)) continue
        leftoverSegmentIds.add(entry.videoSeg.segmentId)
        leftoverEntries.push({ kind: 'video_segment', videoSeg: entry.videoSeg })
      }
    }
    for (const msg of this.outbox) {
      if (msg.type === 'WRITE_SET') {
        if (leftoverWriteSetIds.has(msg.payload.queueId)) continue
        leftoverWriteSetIds.add(msg.payload.queueId)
        leftoverEntries.push({ kind: 'write_set', writeSet: msg.payload })
      } else if (msg.type === 'VIDEO_SEGMENT_WRITE_SET') {
        if (leftoverSegmentIds.has(msg.payload.segmentId)) continue
        leftoverSegmentIds.add(msg.payload.segmentId)
        leftoverEntries.push({ kind: 'video_segment', videoSeg: msg.payload })
      }
    }
    if (leftoverEntries.length > 0) {
      logger.error(
        LogCategory.ANALYSIS_QUEUE,
        `[DbWriterProcess] dispose 时仍有 ${leftoverEntries.length} 个未确认写集，转投本地执行器闭环`
      )
      this.deps.onDegradedToLocal?.('dispose_leftover', leftoverEntries)
    }
    this.pendingWriteSets.clear()
    this.pendingVideoSegs = []
    this.crashOrphans = []
    this.outbox = []
  }

  // ==================== 内部实现 ====================

  private postToChild(msg: WriterInMessage): void {
    if (!this.child) return
    try {
      this.child.postMessage(msg)
    } catch (err) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[DbWriterProcess] postMessage 失败:', err)
    }
  }

  private killChild(): void {
    const current = this.child
    if (!current) return
    try {
      current.kill()
    } catch (err) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[DbWriterProcess] kill 子进程失败:', err)
    }
  }

  private handleChildMessage(msg: WriterOutMessage): void {
    switch (msg.type) {
      case 'READY': {
        if (this.readyTimer) {
          clearTimeout(this.readyTimer)
          this.readyTimer = null
        }
        // R1 盲审发现 8 + R2 建议 4：仅 starting 态可接受 READY——
        // disposed / crashed（ready_timeout kill 后迟到 READY）/ exhausted 一律严禁复活状态机
        if (this.state !== 'starting') return
        this.state = 'ready'
        this.restartCount = 0
        logger.info(LogCategory.ANALYSIS_QUEUE, `[DbWriterProcess] 写进程就绪 (pid=${msg.pid})`)
        this.flushCrashOrphansAndOutbox()
        break
      }
      case 'WRITE_ACK': {
        // 优先核销普通写集；未命中则为视频分段独立事务回执
        const hadWriteSet = this.pendingWriteSets.delete(msg.ack.queueId)
        if (!hadWriteSet) {
          const segIdx = this.pendingVideoSegs.findIndex(s => s.queueId === msg.ack.queueId)
          if (segIdx >= 0) this.pendingVideoSegs.splice(segIdx, 1)
        }
        this.deps.onWriteAck?.(msg.ack)
        break
      }
      case 'BATCH_METRICS': {
        this.lastBatchMs = msg.metrics.durationMs
        this.metricsTotalFiles += msg.metrics.batchSize
        this.metricsDurations.push(msg.metrics.durationMs)
        if (this.metricsDurations.length > METRICS_RING_CAPACITY) {
          this.metricsDurations.splice(0, this.metricsDurations.length - METRICS_RING_CAPACITY)
        }
        this.deps.onBatchMetrics?.(msg.metrics)
        break
      }
      case 'TAIL_HOOK': {
        this.deps.onTailHook?.(msg.payload)
        break
      }
      case 'LOG': {
        if (msg.level === 'error') {
          logger.error(LogCategory.ANALYSIS_QUEUE, `[DbWriterProcess][child] ${msg.msg}`, msg.ctx)
        } else if (msg.level === 'warn') {
          logger.warn(LogCategory.ANALYSIS_QUEUE, `[DbWriterProcess][child] ${msg.msg}`, msg.ctx)
        } else if (msg.level === 'info') {
          logger.info(LogCategory.ANALYSIS_QUEUE, `[DbWriterProcess][child] ${msg.msg}`, msg.ctx)
        } else {
          logger.debug(LogCategory.ANALYSIS_QUEUE, `[DbWriterProcess][child] ${msg.msg}`, msg.ctx)
        }
        break
      }
    }
  }

  private handleChildExit(code: number): void {
    const wasDisposed = this.state === 'disposed'
    this.child = null
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    if (wasDisposed || code === 0) return
    // READY 超时路径已先行进入崩溃记账（kill 的异步 exit 事件不可二次记账）
    if (this.state === 'crashed') return

    this.handleChildCrash(`exit_code_${code}`)
  }

  /** 子进程异常退出：在途写集转入崩溃回灌队列 → 指数退避重启 */
  private handleChildCrash(reason: string): void {
    if (this.state === 'disposed') return

    // 崩溃瞬间在途写集全部转为回灌队列（SQLite 事务原子性保证未 COMMIT 批已回滚，
    // 已 COMMIT 未 ACK 批重放幂等：UPSERT + 集合替换 + 队列终态 WHERE status='analyzing'）
    // R1 盲审发现 2：starting/crashed 态 enqueue 会同时落 pending 与 outbox 两个容器，
    // 回灌收集必须按 queueId / segmentId 去重，严禁同一写集双份回灌（双倍写放大 + ACK 计数失真）。
    const orphanWriteSetIds = new Set<number>()
    const orphanSegmentIds = new Set<string>()
    for (const [queueId, ws] of this.pendingWriteSets) {
      if (orphanWriteSetIds.has(queueId)) continue
      orphanWriteSetIds.add(queueId)
      this.crashOrphans.push({ kind: 'write_set', writeSet: ws })
      this.pendingWriteSets.delete(queueId)
    }
    for (const seg of this.pendingVideoSegs) {
      if (orphanSegmentIds.has(seg.segmentId)) continue
      orphanSegmentIds.add(seg.segmentId)
      this.crashOrphans.push({ kind: 'video_segment', videoSeg: seg })
    }
    this.pendingVideoSegs = []

    // outbox 中未投递的写集同样转为回灌队列（与 pending 已收集项按 ID 查重）
    for (const msg of this.outbox) {
      if (msg.type === 'WRITE_SET') {
        if (orphanWriteSetIds.has(msg.payload.queueId)) continue
        orphanWriteSetIds.add(msg.payload.queueId)
        this.crashOrphans.push({ kind: 'write_set', writeSet: msg.payload })
      } else if (msg.type === 'VIDEO_SEGMENT_WRITE_SET') {
        if (orphanSegmentIds.has(msg.payload.segmentId)) continue
        orphanSegmentIds.add(msg.payload.segmentId)
        this.crashOrphans.push({ kind: 'video_segment', videoSeg: msg.payload })
      }
    }
    this.outbox = []
    this.state = 'crashed'

    const maxRestarts = this.deps.maxRestarts ?? MAX_WRITER_RESTARTS
    if (this.restartCount >= maxRestarts) {
      logger.error(
        LogCategory.ANALYSIS_QUEUE,
        `[DbWriterProcess] 写进程连续崩溃超过上限 (${maxRestarts})，停止重启并降级本地执行器 (reason=${reason}, 回灌写集=${this.crashOrphans.length})`
      )
      this.state = 'exhausted'
      this.degradePendingToLocal('crash_restarts_exhausted')
      return
    }

    this.restartCount++
    const delayMs =
      (this.deps.restartBaseDelayMs ?? WRITER_RESTART_BASE_DELAY_MS) *
      Math.pow(2, this.restartCount - 1)
    logger.warn(
      LogCategory.ANALYSIS_QUEUE,
      `[DbWriterProcess] 写进程崩溃 (reason=${reason})，${delayMs}ms 后第 ${this.restartCount} 次 watchdog 重启，回灌写集 ${this.crashOrphans.length} 个`
    )
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (this.state === 'disposed') return
      this.state = 'idle'
      this.start()
    }, delayMs)
    this.restartTimer.unref?.()
  }

  /** READY 后冲刷：崩溃回灌写集优先、outbox 保序随后 */
  private flushCrashOrphansAndOutbox(): void {
    for (const entry of this.crashOrphans) {
      if (entry.kind === 'write_set' && entry.writeSet) {
        this.pendingWriteSets.set(entry.writeSet.queueId, entry.writeSet)
        this.postToChild({ type: 'WRITE_SET', payload: entry.writeSet })
      } else if (entry.kind === 'video_segment' && entry.videoSeg) {
        this.pendingVideoSegs.push(entry.videoSeg)
        this.postToChild({ type: 'VIDEO_SEGMENT_WRITE_SET', payload: entry.videoSeg })
      }
    }
    this.crashOrphans = []

    const buffered = this.outbox
    this.outbox = []
    for (const msg of buffered) {
      if (msg.type === 'WRITE_SET') {
        this.pendingWriteSets.set(msg.payload.queueId, msg.payload)
      } else if (msg.type === 'VIDEO_SEGMENT_WRITE_SET') {
        this.pendingVideoSegs.push(msg.payload)
      } else if (msg.type === 'YIELD_FOR_UI') {
        this.yielded = true
      } else if (msg.type === 'RESUME') {
        this.yielded = false
      }
      this.postToChild(msg)
    }
  }

  /** 显式降级：全部未确认写集实体移交本地执行器并 error 留痕（严禁静默丢写集） */
  private degradePendingToLocal(reason: string, extra: PendingWriteEntry[] = []): void {
    const entries: DegradedWriteEntry[] = []

    for (const entry of this.crashOrphans) {
      entries.push({ kind: entry.kind, writeSet: entry.writeSet, videoSeg: entry.videoSeg })
    }
    for (const [, ws] of this.pendingWriteSets) {
      entries.push({ kind: 'write_set', writeSet: ws })
    }
    for (const seg of this.pendingVideoSegs) {
      entries.push({ kind: 'video_segment', videoSeg: seg })
    }
    for (const msg of this.outbox) {
      if (msg.type === 'WRITE_SET') {
        entries.push({ kind: 'write_set', writeSet: msg.payload })
      } else if (msg.type === 'VIDEO_SEGMENT_WRITE_SET') {
        entries.push({ kind: 'video_segment', videoSeg: msg.payload })
      }
    }
    for (const entry of extra) {
      entries.push({ kind: entry.kind, writeSet: entry.writeSet, videoSeg: entry.videoSeg })
    }

    this.crashOrphans = []
    this.pendingWriteSets.clear()
    this.pendingVideoSegs = []
    this.outbox = []

    if (entries.length > 0) {
      logger.error(
        LogCategory.ANALYSIS_QUEUE,
        `[DbWriterProcess] 写进程不可用 (reason=${reason})，${entries.length} 个写集显式降级至主进程本地执行器`
      )
    }
    this.deps.onDegradedToLocal?.(reason, entries)
  }
}
