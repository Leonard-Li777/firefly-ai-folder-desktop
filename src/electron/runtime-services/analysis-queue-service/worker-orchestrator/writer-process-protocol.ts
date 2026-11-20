/**
 * Stage2 S-B AnalysisDbWriterProcess 主进程 ↔ utilityProcess 写进程通信协议
 *
 * 消息方向语义（[VERIFY-12] Electron 45 真机实证，两方向不对称，严禁假设对称）：
 * - 主进程 → 子进程：`child.postMessage(payload)`；子进程 `process.parentPort.on('message')`
 *   收到的是 **MessageEvent 包装**（载荷在 `event.data`），子入口必须解包；
 * - 子进程 → 主进程：子进程 `parentPort.postMessage(payload)`；主进程 `child.on('message')`
 *   收到的是 **裸载荷**（无包装）。
 *
 * 进程拓扑（Spec §2 Phase B / 融合方案 §4.3 批次 S-B）：
 *   worker_threads 编排线程（Stage2OrchestratorRuntime）产出 WRITE_SET
 *     → 主进程 WorkerOrchestratorBridge（worker-bridge.ts）
 *     → 主进程 AnalysisDbWriterProcess 宿主（db-writer-process.ts）
 *     → utilityProcess 写进程（writer-process-entry.ts，独立 PID，持有独立 SQLite 写连接）
 *
 * 子进程边界约束（docs/evidence/stage2-s0-port-discovery.md §2）：
 * - 子进程入口为纯 Node 模块：严禁 import 'electron'（decompress_text 等 SQL 函数
 *   经纯模块 sqlite-connection-setup.ts 注册）；展示 locale 经 INIT 握手显式注入；
 * - BrowserWindow IPC 广播 / canonicalMaintenanceService / cloudSyncWorker 尾钩子
 *   必须驻留主进程，子进程仅经 TAIL_HOOK 消息回传触发请求。
 *
 * @doc-anchor: docs/specs/stage2-analysis-pipeline-worker-optimization-spec.md#phase-b写路径收口条件触发
 */

import type { AnalysisWriteSet, VideoSegmentWriteSet } from './protocol'
import type { AnalysisErrorKind } from './worker-error-classifier'
import type { WriteAckItem } from './write-set-batch-dispatcher'

/** 写集回执（与 write-set-batch-dispatcher 的 WriteAckItem 同型，子进程回执语义别名） */
export type WriterAckItem = WriteAckItem

/** 单批写微事务量化指标（工单 05 验收：单批 ≤10ms） */
export interface WriterBatchMetrics {
  /** 本批文件数 */
  batchSize: number
  /** 批级 BEGIN IMMEDIATE → COMMIT 全程耗时（ms，含 Pre-step stat） */
  durationMs: number
  /** 指标采集时刻（epoch ms） */
  ts: number
}

/** 子进程 COMMIT 尾钩子回传（canonical 维护 / 云同步必须驻留主进程） */
export interface WriterTailHookPayload {
  /** 需唤醒 canonicalMaintenanceService 的指纹集合 */
  canonicalWakeups: string[]
  /** 已失效的工作区文件删除记录 */
  workspaceDeletes: number[]
  /** 云同步触发延迟（ms） */
  cloudSyncDelayMs?: number
}

/** 主进程 → 写进程 控制面消息 */
export type WriterInMessage =
  | {
      type: 'INIT'
      /** 主库文件绝对路径（子进程自开独立写连接，严禁寻址 semantic.raw.db） */
      dbPath: string
      /** FTS 展示名解析 locale（ConfigOrchestrator 快照经握手显式下发） */
      displayLocale: string
      /** 攒批窗口覆盖（单测用，缺省 50ms） */
      coalesceWindowMs?: number
    }
  | { type: 'WRITE_SET'; payload: AnalysisWriteSet }
  | { type: 'VIDEO_SEGMENT_WRITE_SET'; payload: VideoSegmentWriteSet }
  | { type: 'YIELD_FOR_UI'; timeoutMs: number }
  | { type: 'RESUME' }
  | { type: 'SHUTDOWN' }

/** 写进程 → 主进程 数据面消息 */
export type WriterOutMessage =
  | { type: 'READY'; pid: number }
  | { type: 'WRITE_ACK'; ack: WriterAckItem }
  | { type: 'BATCH_METRICS'; metrics: WriterBatchMetrics }
  | { type: 'TAIL_HOOK'; payload: WriterTailHookPayload }
  | { type: 'LOG'; level: 'debug' | 'info' | 'warn' | 'error'; msg: string; ctx?: unknown }
