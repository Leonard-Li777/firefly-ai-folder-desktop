/**
 * Stage2 S-C 验收工具入口：将写进程宿主与写集执行器编译为独立 CJS 模块
 * （out_build/main/analysis-db-writer-host.js），供真机验收探针
 * （scripts/stage2-sc-acceptance-probe.cjs）以真实编译产物驱动
 * AnalysisDbWriterProcess + WriteSetBatchDispatcher，严禁探针内伪造宿主逻辑。
 *
 * 本入口仅面向验收/运维工具链，主进程业务路径经 analysis-queue-service.ts 直接引用。
 */

export { AnalysisDbWriterProcess, resolveWriterProcessScriptPath } from './db-writer-process'
export { WriteSetBatchDispatcher } from './write-set-batch-dispatcher'
// R1 盲审发现 10：S-C 探针对照组（主进程本地执行器）必须应用同一 PRAGMA 套装，保证量化对照公平
export { applySqliteConnectionPragmas } from '../../database/database-service/sqlite-connection-setup'
export type {
  WriterBatchMetrics,
  WriterTailHookPayload,
  WriterInMessage,
  WriterOutMessage
} from './writer-process-protocol'
export type { AnalysisWriteSet, VideoSegmentWriteSet } from './protocol'
export type { WriteAckItem } from './write-set-batch-dispatcher'
