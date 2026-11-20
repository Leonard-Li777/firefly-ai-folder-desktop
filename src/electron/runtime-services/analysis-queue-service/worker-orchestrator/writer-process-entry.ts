/**
 * Stage2 S-B AnalysisDbWriterProcess 子进程入口（Electron utilityProcess，独立 PID）
 *
 * 职责白名单（Spec §2 Phase B / 工单 05）：
 * - 仅持有独立 SQLite 写连接并执行写微事务（复用 WriteSetBatchDispatcher 同一实现，
 *   严禁在子进程内另起炉灶重写 8 步写集）；
 * - 以 setImmediate 分片逐批让出事件循环，单批写微事务目标 ≤10ms；
 * - 崩溃即整体退出（非零 exit code），由主进程宿主 watchdog 回滚在途写集并重启。
 *
 * 硬性边界（docs/evidence/stage2-s0-port-discovery.md §2 边界表）：
 * - 严禁 import 'electron'（本文件为纯 Node 模块，PRAGMA 套装与 decompress_text
 *   SQL 函数经 database-service/sqlite-connection-setup.ts 纯模块注册）；
 * - 严禁持有 BrowserWindow / 调用 canonicalMaintenanceService / cloudSyncWorker——
 *   尾钩子以 TAIL_HOOK 消息回传主进程执行；
 * - FTS 展示 locale 由 INIT 握手显式注入（setDisplayLocaleReader），不读 electron-conf。
 *
 * @doc-anchor: docs/specs/stage2-analysis-pipeline-worker-optimization-spec.md#phase-b写路径收口条件触发
 */

import Database from 'better-sqlite3'
import {
  applySqliteConnectionPragmas,
  registerAnalysisSqlFunctions
} from '../../database/database-service/sqlite-connection-setup'
import { setDisplayLocaleReader } from '../../database/database-service/display-locale-seam'
import { WriteSetBatchDispatcher, type WriteAckItem } from './write-set-batch-dispatcher'
import type { WriterInMessage, WriterOutMessage, WriterTailHookPayload } from './writer-process-protocol'

type WriterLogLevel = Extract<WriterOutMessage, { type: 'LOG' }>['level']

/** utilityProcess 子进程侧双向消息端口（Electron 注入；'message' 监听器收到 MessageEvent 包装） */
const parentPort: {
  postMessage: (msg: WriterOutMessage) => void
  on: (event: 'message', listener: (event: unknown) => void) => void
  start?: () => void
} | null = (process as unknown as { parentPort?: typeof parentPort }).parentPort ?? null

let db: Database.Database | null = null
let dispatcher: WriteSetBatchDispatcher | null = null

/** 汇总尾钩子累积桶（防抖在主进程宿主侧执行，子进程只做短暂聚合回传） */
const tailHookAccumulator: WriterTailHookPayload = {
  canonicalWakeups: [],
  workspaceDeletes: []
}
let tailHookTimer: ReturnType<typeof setTimeout> | null = null
const TAIL_HOOK_FLUSH_MS = 500

function log(level: WriterLogLevel, msg: string, ctx?: unknown): void {
  parentPort?.postMessage({ type: 'LOG', level, msg, ctx })
}

/** 短暂聚合回传尾钩子（避免高频刷 IPC） */
function scheduleTailHookFlush(): void {
  if (tailHookTimer) return
  tailHookTimer = setTimeout(() => {
    tailHookTimer = null
    if (
      tailHookAccumulator.canonicalWakeups.length === 0 &&
      tailHookAccumulator.workspaceDeletes.length === 0
    ) {
      return
    }
    const payload: WriterTailHookPayload = {
      canonicalWakeups: Array.from(new Set(tailHookAccumulator.canonicalWakeups)),
      workspaceDeletes: Array.from(new Set(tailHookAccumulator.workspaceDeletes)),
      cloudSyncDelayMs: 2000
    }
    tailHookAccumulator.canonicalWakeups = []
    tailHookAccumulator.workspaceDeletes = []
    parentPort?.postMessage({ type: 'TAIL_HOOK', payload })
  }, TAIL_HOOK_FLUSH_MS)
  tailHookTimer.unref?.()
}

function handleInit(msg: Extract<WriterInMessage, { type: 'INIT' }>): void {
  // INIT 可重入（宿主 watchdog 重启场景复用同一入口约定）：先关旧连接防句柄泄漏
  if (db) {
    try {
      db.close()
    } catch (closeErr) {
      log('warn', '[DbWriterProcess] INIT 重入关闭旧连接失败:', closeErr)
    }
    db = null
    dispatcher = null
  }

  // FTS 展示 locale 经握手显式注入（S0 边界裁决：子进程严禁读 electron-conf）
  setDisplayLocaleReader(() => msg.displayLocale)

  db = new Database(msg.dbPath)
  registerAnalysisSqlFunctions(db)
  applySqliteConnectionPragmas(db)

  dispatcher = new WriteSetBatchDispatcher({
    getDb: () => db,
    coalesceWindowMs: msg.coalesceWindowMs,
    onWriteAck: (ack: WriteAckItem) => {
      parentPort?.postMessage({ type: 'WRITE_ACK', ack })
    },
    onBatchExecuted: (batchSize, durationMs) => {
      parentPort?.postMessage({
        type: 'BATCH_METRICS',
        metrics: { batchSize, durationMs, ts: Date.now() }
      })
    },
    onWakeCanonicalMaintenance: fingerprints => {
      tailHookAccumulator.canonicalWakeups.push(...fingerprints)
      scheduleTailHookFlush()
    },
    onTriggerCloudSync: () => {
      // 云同步延迟由主进程宿主统一裁定；子进程只负责回传触发请求
      scheduleTailHookFlush()
    },
    onWorkspaceDeletes: ids => {
      tailHookAccumulator.workspaceDeletes.push(...ids)
      scheduleTailHookFlush()
    }
  })

  parentPort?.postMessage({ type: 'READY', pid: process.pid })
}

function handleMessage(msg: WriterInMessage): void {
  switch (msg.type) {
    case 'INIT': {
      handleInit(msg)
      break
    }
    case 'WRITE_SET': {
      dispatcher?.enqueue(msg.payload)
      break
    }
    case 'VIDEO_SEGMENT_WRITE_SET': {
      // 视频分段独立事务：子进程同步执行并即时回执（与主进程本地路径语义一致）
      if (dispatcher) {
        const ack = dispatcher.commitVideoSegment(msg.payload)
        parentPort?.postMessage({ type: 'WRITE_ACK', ack })
      } else {
        parentPort?.postMessage({
          type: 'WRITE_ACK',
          ack: {
            queueId: msg.payload.queueId,
            result: 'error',
            errorKind: 'SQLITE_BUSY',
            reason: 'writer_process_not_initialized'
          }
        })
      }
      break
    }
    case 'YIELD_FOR_UI': {
      dispatcher?.pauseForUi(msg.timeoutMs)
      break
    }
    case 'RESUME': {
      dispatcher?.resumeFromUi()
      break
    }
    case 'SHUTDOWN': {
      shutdown()
      break
    }
  }
}

function shutdown(): void {
  try {
    // 退出前冲刷待写微批与尾钩子（WRITE_SET 不丢）
    if (dispatcher) {
      dispatcher.resumeFromUi()
      void dispatcher
        .flush()
        .then(() => {
          dispatcher?.flushTailHooks()
        })
        .catch(err => {
          log('warn', '[DbWriterProcess] SHUTDOWN 冲刷写集失败:', err)
        })
    }
  } finally {
    // 冲刷为异步短窗；主进程宿主 dispose 会等待退出，超时则强杀。
    // vitest 环境（子入口真实链路单测）下仅关库不退出进程，避免杀掉测试 worker。
    setTimeout(() => {
      try {
        db?.close()
        db = null
      } catch {
        // 已关闭时忽略
      }
      if (process.env.VITEST === undefined) {
        process.exit(0)
      }
    }, 200).unref?.()
  }
}

if (!parentPort) {
  // 防御：脱离 utilityProcess 环境直接 node 运行时显式失败，严禁伪装成功（反欺诈红线）
  process.stderr.write(
    '[DbWriterProcess] process.parentPort 不存在：本入口仅可由 Electron utilityProcess 拉起\n'
  )
  process.exit(1)
} else {
  // Electron utilityProcess 语义（[VERIFY-12] 实证）：parentPort 'message' 事件为
  // MessageEvent 包装（载荷在 event.data），主进程 child.on('message') 侧为裸载荷；
  // 此处解包后分发，兼容两种形态防 API 演进回归。
  parentPort.on('message', event => {
    const msg =
      event && typeof event === 'object' && 'data' in (event as Record<string, unknown>)
        ? ((event as { data: WriterInMessage }).data)
        : (event as unknown as WriterInMessage)
    handleMessage(msg)
  })
  parentPort.start?.()
}
