import { BrowserWindow } from 'electron'
import { LogCategory, logger } from '@firefly/shared'
import type { AnalysisQueueSnapshot, AnalysisStats } from '@firefly/types'
import { t } from '@app/languages'
import {
  broadcastToRenderers,
  createBroadcastCoalescer,
  DEFAULT_BROADCAST_WINDOW_MS,
  GLOBAL_BROADCAST_BUCKET,
  type BroadcastCoalescer
} from '@pro/perf/broadcast'
import { databaseService } from '../database/database-service'
import { QueueManager, type QueueUpdateHint } from './queue-manager'

export const ANALYSIS_QUEUE_CHANNEL = 'analysis-queue-updated'
export const ANALYSIS_QUEUE_BUCKET_KIND = 'analysis-queue'
export const MAX_TERMINAL_DELTAS_PER_BUCKET = 500
const OVERFLOW_WARN_THROTTLE_MS = 5000

export interface AnalysisTerminalDelta {
  id: number
  path: string
  workspaceId?: number | string | null
  status: 'completed' | 'failed'
  error?: string
  updatedAt: number
  isDirectory?: boolean
  itemType?: 'file' | 'directory'
}

export interface AnalysisQueueUpdatePayload {
  channel: typeof ANALYSIS_QUEUE_CHANNEL
  wsId: string
  seq: number
  snapshotSeq?: number
  resyncRequired?: boolean
  snapshot: AnalysisQueueSnapshot
  terminalDeltas: AnalysisTerminalDelta[]
}

interface BucketDeltaBuffer {
  pendingTerminalDeltas: AnalysisTerminalDelta[]
  resyncRequired: boolean
  lastWarnAt: number
}

export type FrontendNotifyType = 'info' | 'success' | 'warning' | 'error'

export interface AnalysisItemStatusExtra {
  analysisStats?: AnalysisStats
  fromCache?: boolean
  analysisStage?: number
  /** 结构化超时标记（由 classifyAnalysisError / isTimeoutError 产生，严禁中文文案匹配） */
  isTimeout?: boolean
  /** 视频视觉分析预算降级标记与诊断元数据（Spec v1.7.3 §2.4.2，严禁写入 completed） */
  analysisStatus?: 'analysis_degraded'
  degradedMetadata?: {
    perceive_timeout_sec: number | null
    asr_est_sec: number
    degraded_reason: 'pre_elapsed' | 'budget_structural'
  }
}

export type FrontendNotifyFn = (
  type: FrontendNotifyType,
  message: string,
  sticky?: boolean,
  id?: string,
  autoClose?: number,
  action?: any
) => void | Promise<void>

/**
 * 分析队列状态写回与渲染进程通知分发器。
 *
 * 通过惰性 Getter 读取 QueueManager 与完整 Snapshot，避免构造函数执行期
 * `queueManager` 尚未初始化导致的 `undefined` 绑定漏洞。
 *
 * 双轨协议（B1 / J-01）：
 * - 快照轨（snapshot）：保留全量运行期队列项（严禁自动剔除终态项）兜底展示；
 * - 增量轨（terminalDeltas）：按 (wsId, kind) 分桶缓冲终态事件，随合帧广播向全部
 *   活跃窗口发送完成后按帧一次性清空；崩溃/重载兜底依赖 queue-manager 持久化状态或上层幂等/重试。
 */
export class AnalysisWriteDispatcher {
  private coalescer: BroadcastCoalescer
  private bucketBuffers = new Map<string, BucketDeltaBuffer>()
  private seqByBucket = new Map<string, number>()
  private globalSnapshotSeq = 0

  constructor(
    private getQueueManager: () => QueueManager | undefined,
    private getSnapshot: () => AnalysisQueueSnapshot,
    private customNotifyFrontend?: FrontendNotifyFn,
    windowMs: number = DEFAULT_BROADCAST_WINDOW_MS
  ) {
    this.coalescer = createBroadcastCoalescer({
      windowMs,
      logger: {
        warn: (message, error) => logger.warn(LogCategory.MAIN, message, error)
      },
      send: (_channel, rawPayload) => {
        const payload = rawPayload as AnalysisQueueUpdatePayload
        this.sendAndConsumeBucket(payload.wsId, payload)
      }
    })
  }

  private nextBucketSeq(wsKey: string): number {
    const next = (this.seqByBucket.get(wsKey) ?? 0) + 1
    this.seqByBucket.set(wsKey, next)
    return next
  }

  private buildPayloadForBucket(wsKey: string, seq?: number): AnalysisQueueUpdatePayload {
    const snapshot = this.getSnapshot()
    const buf = this.getOrCreateBucketBuffer(wsKey)
    const bucketSeq = seq ?? this.nextBucketSeq(wsKey)
    this.globalSnapshotSeq += 1
    return {
      channel: ANALYSIS_QUEUE_CHANNEL,
      wsId: wsKey,
      seq: bucketSeq,
      snapshotSeq: this.globalSnapshotSeq,
      ...(buf.resyncRequired ? { resyncRequired: true } : {}),
      snapshot,
      terminalDeltas: buf.pendingTerminalDeltas.slice()
    }
  }

  private getBucketKey(wsId?: string | number | null): string {
    return wsId !== undefined && wsId !== null && wsId !== ''
      ? String(wsId)
      : GLOBAL_BROADCAST_BUCKET
  }

  private getOrCreateBucketBuffer(wsKey: string): BucketDeltaBuffer {
    let buf = this.bucketBuffers.get(wsKey)
    if (!buf) {
      buf = {
        pendingTerminalDeltas: [],
        resyncRequired: false,
        lastWarnAt: 0
      }
      this.bucketBuffers.set(wsKey, buf)
    }
    return buf
  }

  private getAliveWindows(): BrowserWindow[] {
    const windows = BrowserWindow.getAllWindows()
    if (!windows || windows.length === 0) return []
    return windows.filter(win => !win.isDestroyed() && !win.webContents.isDestroyed())
  }

  private recordTerminalDelta(wsKey: string, delta: AnalysisTerminalDelta): void {
    const buf = this.getOrCreateBucketBuffer(wsKey)
    const hasAliveWindow = this.getAliveWindows().length > 0

    // 有存活窗口且缓冲区已达硬上限时，提前同步 flush 当前桶，保证单帧有界且 0 丢弃
    if (hasAliveWindow && buf.pendingTerminalDeltas.length >= MAX_TERMINAL_DELTAS_PER_BUCKET) {
      if (process.env.FF_PUSH_COALESCE !== '0') {
        this.coalescer.flush({ wsId: wsKey, kind: ANALYSIS_QUEUE_BUCKET_KIND })
      }
      // 若无窗口期曾导致 coalescer.dirty === false 而 flush 空转，则直接同步发送一次清空缓冲
      if (buf.pendingTerminalDeltas.length >= MAX_TERMINAL_DELTAS_PER_BUCKET) {
        this.sendAndConsumeBucket(wsKey, this.buildPayloadForBucket(wsKey))
      }
    }

    buf.pendingTerminalDeltas.push(delta)

    if (buf.pendingTerminalDeltas.length > MAX_TERMINAL_DELTAS_PER_BUCKET) {
      while (buf.pendingTerminalDeltas.length > MAX_TERMINAL_DELTAS_PER_BUCKET) {
        buf.pendingTerminalDeltas.shift()
      }
      buf.resyncRequired = true
      const now = Date.now()
      if (now - buf.lastWarnAt >= OVERFLOW_WARN_THROTTLE_MS) {
        buf.lastWarnAt = now
        logger.warn(
          LogCategory.MAIN,
          `[AnalysisQueue] 桶 ${wsKey} terminalDeltas 超过上限 ${MAX_TERMINAL_DELTAS_PER_BUCKET}（aliveWindows=${hasAliveWindow}），已丢弃最老增量并标记 resyncRequired`
        )
      }
    }
  }

  private sendAndConsumeBucket(wsKey: string, payload: AnalysisQueueUpdatePayload): void {
    const windows = this.getAliveWindows()
    if (windows.length === 0) {
      // 无存活窗口时不清空缓冲，留待窗口恢复或超上限触发 resyncRequired
      return
    }
    const sent = broadcastToRenderers(windows, ANALYSIS_QUEUE_CHANNEL, payload)
    const buf = this.bucketBuffers.get(wsKey)
    if (!buf) return
    if (sent === windows.length) {
      // 必须全部存活窗口都发送成功后才按帧一次性清空
      buf.pendingTerminalDeltas.length = 0
      buf.resyncRequired = false
    } else {
      // 部分窗口发送异常：保留缓冲并标记 resyncRequired，防止该窗口永久漏终态
      buf.resyncRequired = true
    }
  }

  updateItemStatus(
    itemId: number,
    status: 'pending' | 'analyzing' | 'completed' | 'failed',
    progress: number,
    error?: string,
    extra?: AnalysisItemStatusExtra
  ): void {
    const queueManager = this.getQueueManager()
    if (!queueManager) return
    const item = queueManager.getQueue().find(i => i.id === itemId)
    if (!item) return

    if (status === 'failed' && extra?.analysisStatus === 'analysis_degraded' && error) {
      void this.notifyFrontend(
        'warning',
        `${item.name}：${error}`,
        false,
        `degraded-${itemId}`,
        6000,
        { label: t('前往设置'), category: 'AI_ENGINE_CONFIG' }
      )
    } else if (status === 'failed' && extra?.isTimeout === true) {
      void this.notifyFrontend(
        'warning',
        `${t('分析时间太长')}: ${item.name}。${t('建议在设置里换一个更轻巧的识别方案')}`,
        false,
        `timeout-${itemId}`,
        5000,
        // PRD-0044：模型管理 tab 已合并，通知跳链改指「高级AI引擎配置」
        { label: t('前往设置'), category: 'AI_ENGINE_CONFIG' }
      )
    }

    item.status = status
    item.progress = progress
    item.updatedAt = Date.now()
    if (error !== undefined) item.error = error
    if (extra?.analysisStats) item.analysisStats = extra.analysisStats
    if (extra?.fromCache !== undefined) item.fromCache = extra.fromCache
    if (extra?.analysisStatus) (item as any).analysisStatus = extra.analysisStatus
    if (extra?.degradedMetadata) (item as any).degradedMetadata = extra.degradedMetadata

    const currentStage =
      extra?.analysisStage ??
      (extra?.analysisStats ? Number(extra.analysisStats.analysis_stage) : undefined)

    if (currentStage !== undefined) {
      item.analysisStage = currentStage
      item.stage = currentStage as any
    } else if (status === 'completed') {
      const statsStage = item.analysisStats ? Number(item.analysisStats.analysis_stage) : undefined
      const finalStage = item.analysisStage ?? statsStage ?? 4
      item.analysisStage = finalStage
      item.stage = finalStage as any
    }

    try {
      databaseService.updateAnalysisQueue({ id: itemId, status, progress, error: error || null })
    } catch (e) {
      logger.warn(LogCategory.MAIN, '[AnalysisQueue] 更新分析队列状态到数据库失败:', e)
    }

    if (status === 'completed' || status === 'failed') {
      const terminalDelta: AnalysisTerminalDelta = {
        id: item.id,
        path: item.path,
        workspaceId: item.workspaceId ?? null,
        status,
        ...(error !== undefined ? { error } : {}),
        updatedAt: item.updatedAt,
        isDirectory: item.itemType === 'directory',
        itemType: item.itemType
      }
      this.emitUpdate({ wsId: item.workspaceId ?? null, terminalDelta })

      try {
        const windows = BrowserWindow.getAllWindows()
        if (windows && windows.length > 0) {
          broadcastToRenderers(windows, 'file-analysis-updated', {
            filePath: item.path,
            fileFingerprint: (item as any).fileFingerprint,
            status,
            ...(extra?.analysisStatus ? { analysisStatus: extra.analysisStatus } : {}),
            ...(extra?.degradedMetadata ? { degradedMetadata: extra.degradedMetadata } : {}),
            source: 'queue'
          })
        }
      } catch (e) {
        logger.warn(LogCategory.MAIN, '[AnalysisQueue] 发送文件分析更新通知失败:', e)
      }
    } else {
      this.emitUpdate({ wsId: item.workspaceId ?? null })
    }
  }

  notifyLatchBrake(workspaceId: number): void {
    const windows = BrowserWindow.getAllWindows()
    if (windows && windows.length > 0) {
      windows.forEach(win => {
        if (!win.webContents.isDestroyed()) {
          try {
            win.webContents.send('analysis-queue/latch-brake', { workspaceId })
          } catch (e) {
            logger.warn(LogCategory.MAIN, '[AnalysisQueue] 发送动态刹车通知失败:', e)
          }
        }
      })
    }
  }

  emitUpdate(hint?: QueueUpdateHint): void {
    const wsKey = this.getBucketKey(hint?.wsId ?? hint?.terminalDelta?.workspaceId)
    if (hint?.terminalDelta) {
      this.recordTerminalDelta(wsKey, hint.terminalDelta as AnalysisTerminalDelta)
    }

    // 回退开关（治理计划 §8.3）：FF_PUSH_COALESCE=0 退回逐次立即发送
    if (process.env.FF_PUSH_COALESCE === '0') {
      this.sendAndConsumeBucket(wsKey, this.buildPayloadForBucket(wsKey))
      return
    }

    this.coalescer.schedule(
      { wsId: wsKey, kind: ANALYSIS_QUEUE_BUCKET_KIND },
      ANALYSIS_QUEUE_CHANNEL,
      () => this.buildPayloadForBucket(wsKey)
    )
  }

  flush(wsId?: string | number | null): void {
    const wsKey = this.getBucketKey(wsId)
    this.coalescer.flush({ wsId: wsKey, kind: ANALYSIS_QUEUE_BUCKET_KIND })
  }

  flushAll(): void {
    this.coalescer.flushAll()
  }

  dispose(): void {
    this.coalescer.dispose()
    this.bucketBuffers.clear()
    this.seqByBucket.clear()
    this.globalSnapshotSeq = 0
  }

  async notifyFrontend(
    type: FrontendNotifyType,
    message: string,
    sticky = false,
    id?: string,
    autoClose?: number,
    action?: any
  ): Promise<void> {
    if (this.customNotifyFrontend) {
      await this.customNotifyFrontend(type, message, sticky, id, autoClose, action)
      return
    }
    try {
      const windows = BrowserWindow.getAllWindows()
      if (windows && windows.length > 0) {
        windows.forEach(win => {
          if (!win.webContents.isDestroyed()) {
            win.webContents.send('system:notification', {
              type,
              message,
              sticky,
              id,
              autoClose,
              action
            })
          }
        })
      }
    } catch (e) {
      logger.warn(LogCategory.MAIN, '[AnalysisQueue] notifyFrontend 发送通知失败:', e)
    }
  }
}
