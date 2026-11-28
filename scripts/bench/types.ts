/**
 * Electron ABI 集成性能基准 Harness 统一类型契约（工单 IO-04 / W0-05）
 *
 * 覆盖：
 * - 总路线图 §7.1 测量环境元数据头与统计口径（吞吐中位数 + 原始值，卡顿/锁等待按 Max）
 * - 工单 04 三场景（sync-10k / dup-50k / batch-1k）+ W0-05 双路径入库对比（db-ingest-10k）
 * - 工单 02 同步 I/O 调用点排行与工单 03 事件循环延迟采样输出
 */

import type { SyncIoCallSiteSample, SyncIoReport } from '../../src/electron/infra/fs/instrument'

/** 基准运行模式：pr 仅跑 1 万文件场景；nightly 跑全量场景；custom 按 CLI 指定 */
export type BenchMode = 'pr' | 'nightly' | 'custom'

/** 基准场景标识 */
export type BenchScenarioId = 'sync-10k' | 'dup-50k' | 'batch-1k' | 'db-ingest-10k'

/** 延迟分位数汇总（毫秒） */
export interface LatencySummary {
  p50Ms: number
  p99Ms: number
  maxMs: number
  meanMs: number
  sampleCount: number
}

/** 墙钟耗时汇总（毫秒；严格保留全部原始运行值，按 §7.1 吞吐取中位数） */
export interface DurationSummary {
  medianMs: number
  minMs: number
  maxMs: number
  rawRunsMs: number[]
}

/** SQLite PRAGMA wal_checkpoint(PASSIVE) 返回值 */
export interface WalCheckpointResult {
  busy: number
  log: number
  checkpointed: number
}

/** 单条入库路径采集指标（W0-05 & W4 退出门禁共用口径） */
export interface IngestPathMetrics {
  pathKind: 'batch-scan' | 'single-file-expand'
  fileCount: number
  durationMs: DurationSummary
  commitCount: number
  eventLoop: LatencySummary
  writeLockWaitMs: LatencySummary
  walPeakBytes: number
  checkpointPassive: WalCheckpointResult
}

/** W0-05 双路径入库与写进程微批对照指标 */
export interface DbIngestComparisonMetrics {
  batchPath: IngestPathMetrics
  singlePath: IngestPathMetrics
  writerBatchMetricsDurationMs?: LatencySummary
  throughputRatioSingleOverBatch: number
}

/** 同步 I/O 场景级结构化快照（供工单 06 直接消费） */
export interface BenchSyncIoSummary {
  enabled: boolean
  delayMs: number
  totalCount: number
  totalMs: number
  totalCallMs: number
  maxMs: number
  distinctCallSites: number
  byModule: SyncIoReport['byModule']
  /** 按累计阻塞时长 totalMs 降序排列的调用点排行 */
  topCallSites: SyncIoCallSiteSample[]
  /** 针对 P0-3（file-watcher-service 伴生文件探测）统计的命中调用次数 */
  p03CompanionCallCount?: number
}

/** 单次运行原始测量样本（§7.1 禁止丢弃原始值） */
export interface BenchSingleRunResult {
  runIndex: number
  durationMs: number
  processedCount: number
  eventLoop: LatencySummary
  /** 由 @pro/perf/event-loop-monitor 读取的采样值（验证共用通道有效） */
  sharedMonitorP99Ms: number | null
  syncIo: BenchSyncIoSummary
  walPeakBytes?: number
  checkpointPassive?: WalCheckpointResult
  notes?: Record<string, unknown>
}

/** 单个基准场景汇总结果 */
export interface BenchScenarioResult {
  scenarioId: BenchScenarioId
  name: string
  fixtureScale: number
  runs: BenchSingleRunResult[]
  durationMs: DurationSummary
  /** 多次运行事件循环延迟按最差值（Max）汇总（§7.1 卡顿指标按最差值把关） */
  latency: LatencySummary
  /** 取典型（或末次）运行下的完整同步 I/O 统计与热点排行 */
  syncIo: BenchSyncIoSummary
  /** W0-05 / W4 数据库多条件指标（场景③或 db-ingest-10k 采集） */
  dbIngestComparison?: DbIngestComparisonMetrics
}

/** 总路线图 §7.1 必填环境元数据头 */
export interface BenchEnvironmentMetadata {
  osVersion: string
  platform: string
  arch: string
  cpuModel: string
  cpuCores: number
  totalMemoryMb: number
  powerPlan: string
  buildVariant: string
  gitCommit: string
  nodeVersion: string
  electronVersion: string
  electronModuleAbi: string
  isElectronMainProcess: boolean
  posthogEnabled: boolean
  cacheState: 'cold' | 'warm' | 'isolated-tmp'
  delayMs: number
  runs: number
  dryRun: boolean
  scaleFactor: number
  dbRowCounts: Record<string, number>
}

/** 延迟注入对照结果（验证 5ms 延迟开关真实生效） */
export interface DelayInjectionScenarioDelta {
  scenarioId: BenchScenarioId
  delayOnP99Ms: number
  delayOffP99Ms: number
  deltaP99Ms: number
  delayOnDurationMs: number
  delayOffDurationMs: number
  deltaDurationMs: number
  delayOnSyncIoMs: number
  delayOffSyncIoMs: number
  networkDiskSimulated: boolean
}

export interface DelayInjectionComparison {
  delayMs: number
  passed: boolean
  scenarios: Record<string, DelayInjectionScenarioDelta>
}

/** CI 相对回归门禁配置与结果 */
export interface RegressionGateOptions {
  /** 允许的相对劣化阈值比例，默认 0.10（即 > 10% 判失败） */
  maxRegressionRatio?: number
  /** 校验范围：pr 仅校验 sync-10k；nightly 校验全量；auto 根据 current.mode 推断 */
  scope?: 'pr' | 'nightly' | 'auto'
  /** 基线绝对值低于此地板（毫秒）时不触发百分比噪音误报，默认 5ms */
  minFloorMs?: number
}

export interface RegressionMetricComparison {
  scenarioId: BenchScenarioId
  metric: 'durationMs.medianMs' | 'latency.p99Ms'
  baselineValue: number
  currentValue: number
  regressionRatio: number
  thresholdRatio: number
  passed: boolean
  skippedReason?: string
}

export interface RegressionGateResult {
  passed: boolean
  scope: 'pr' | 'nightly' | 'auto'
  thresholdRatio: number
  checkedScenarios: BenchScenarioId[]
  missingScenarios: BenchScenarioId[]
  comparisons: RegressionMetricComparison[]
  failures: string[]
}

/** 基准完整输出报告（JSON 友好，供工单 06 与 CI 门禁消费） */
export interface BenchReport {
  version: 1
  generatedAt: string
  mode: BenchMode
  environment: BenchEnvironmentMetadata
  scenarios: Partial<Record<BenchScenarioId, BenchScenarioResult>>
  delayComparison?: DelayInjectionComparison
}
