/**
 * Stage2 S-B 数据面装配工厂（工单 05 · 保持 analysis-queue-service.ts <1000 行红线）
 *
 * 职责：构造 utilityProcess 写进程宿主 + 主进程本地执行器 + WorkerWriteSink 路由，
 * 供 AnalysisQueueService 构造函数一行接入。降级链全程显式留痕，严禁静默丢写集。
 */

import type { AnalysisDbWriterProcess, DegradedWriteEntry } from './db-writer-process'
import type { WorkerWriteSink } from './worker-bridge'
import type { WriteSetBatchDispatcher } from './write-set-batch-dispatcher'

export interface WriterProcessStackDeps {
  /** utilityProcess 写进程宿主（已构造，仅负责路由与降级移交） */
  dbWriterProcess: AnalysisDbWriterProcess
  /** 主进程本地写集执行器（关态/降级合法路径） */
  localDispatcher: WriteSetBatchDispatcher
  /** 降级移交回调宿主：写集实体转投本地执行器（视频段同步 ACK 闭环） */
  onDegradedAck: (ack: { queueId: number; result: 'ok' | 'stale' | 'error'; reason?: string }) => void
  /** 特性开关热切换读取（ANALYSIS_USE_DB_WRITER_PROCESS） */
  useDbWriterProcess: () => boolean
}

export interface WriterProcessStack {
  sink: WorkerWriteSink
  /** 降级移交入口（宿主 onDegradedToLocal 回调绑定） */
  handleDegraded: (reason: string, entries: DegradedWriteEntry[]) => void
}

/**
 * 构造写进程 ↔ 本地执行器双路路由。
 * 降级链：开关关 → 本地执行器；开关开但写进程不可用 → 宿主 onDegradedToLocal → 本地执行器。
 */
export function createWriterProcessStack(deps: WriterProcessStackDeps): WriterProcessStack {
  const { dbWriterProcess, localDispatcher, useDbWriterProcess } = deps

  const handleDegraded = (reason: string, entries: DegradedWriteEntry[]): void => {
    for (const entry of entries) {
      if (entry.kind === 'write_set' && entry.writeSet) {
        localDispatcher.enqueue(entry.writeSet)
      } else if (entry.kind === 'video_segment' && entry.videoSeg) {
        const ack = localDispatcher.commitVideoSegment(entry.videoSeg)
        if (ack) deps.onDegradedAck(ack)
      }
    }
  }

  const sink: WorkerWriteSink = {
    enqueue: writeSet => {
      if (useDbWriterProcess()) {
        dbWriterProcess.enqueue(writeSet)
      } else {
        localDispatcher.enqueue(writeSet)
      }
    },
    commitVideoSegment: seg => {
      if (useDbWriterProcess()) {
        return dbWriterProcess.commitVideoSegment(seg)
      }
      return localDispatcher.commitVideoSegment(seg)
    },
    pauseForUi: timeoutMs => {
      dbWriterProcess.yieldForUi(timeoutMs)
      localDispatcher.pauseForUi(timeoutMs)
    },
    resumeFromUi: () => {
      dbWriterProcess.resumeFromUi()
      localDispatcher.resumeFromUi()
    }
  }

  return { sink, handleDegraded }
}
