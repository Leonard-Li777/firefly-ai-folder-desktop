/**
 * Electron ABI 集成基准核心场景执行器（工单 IO-04 / W0-05）
 *
 * 注意：本模块必须在 `electron-bench-bootstrap.ts` 完成
 *   1) Electron 主进程 ABI 断言
 *   2) `app.setPath('userData', sandbox.userDataDir)` 隔离
 *   3) `enableSyncIoInstrumentation(...)` 最早期插桩
 * 之后才被动态 `require()` 加载，确保所有业务服务在模块求值期捕获到的 `node:fs`
 * 均指向已插桩导出对象。
 */

import { app } from 'electron'
import * as crypto from 'node:crypto'
import * as os from 'node:os'
import * as path from 'node:path'
import { execSync } from 'node:child_process'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import type { Database } from 'better-sqlite3'
import type {
  buildSyncIoReport,
  getSyncIoInstrumentationStatus,
  resetSyncIoStats
} from '../../src/electron/infra/fs/instrument'
import { ConfigOrchestrator } from '../../src/electron/config/config-orchestrator'
import { databaseService } from '../../src/electron/runtime-services/database/database-service'
import { fileWatcherService } from '../../src/electron/runtime-services/filesystem/file-watcher-service'
import { duplicateDetectionService } from '../../src/electron/runtime-services/filesystem/duplicate-detection-service'
import { DirectoryProcessor } from '../../src/electron/runtime-services/analysis-queue-service/directory-processor'
import { WriteSetBatchDispatcher } from '../../src/electron/runtime-services/analysis-queue-service/worker-orchestrator/write-set-batch-dispatcher'
import type { AnalysisWriteSet } from '../../src/electron/runtime-services/analysis-queue-service/worker-orchestrator/protocol'
import { loadIgnoreRules } from '../../src/electron/runtime-services/analysis/analysis-ignore-service'
import { workspaceAdmissionService } from '../../src/electron/runtime-services/workspace/workspace-admission-service'
import { omniService } from '../../src/electron/runtime-services/system/omni-service'
import { DEFAULT_UNBOUND_AI_CONFIG } from '@firefly/types'
import { invalidateWorkspacePolicyCache } from '@firefly/shared'
import {
  buildBatch1kFixture,
  buildDbIngestFixture,
  buildDup50kFixture,
  buildSync10kFixture,
  type BenchSandbox,
  type RawFsApi
} from './fixtures'
import {
  aggregateScenarioRuns,
  selectScopeScenarios,
  summarizeDurations,
  summarizeLatencies
} from './stats'
import type {
  BenchEnvironmentMetadata,
  BenchMode,
  BenchReport,
  BenchScenarioId,
  BenchScenarioResult,
  BenchSingleRunResult,
  BenchSyncIoSummary,
  DbIngestComparisonMetrics,
  IngestPathMetrics,
  LatencySummary,
  WalCheckpointResult
} from './types'

export interface BenchExecutionContext {
  sandbox: BenchSandbox
  rawFs: RawFsApi
  mode: BenchMode
  scenarios: BenchScenarioId[]
  delayMs: number
  runs: number
  dryRun: boolean
  scaleFactor: number
  includeDbIngest: boolean
  repoRoot: string
  scaleOverrides: Partial<Record<BenchScenarioId, number>>
  instrumentation: {
    buildSyncIoReport: typeof buildSyncIoReport
    resetSyncIoStats: typeof resetSyncIoStats
    getSyncIoInstrumentationStatus: typeof getSyncIoInstrumentationStatus
  }
  eventLoopMonitor: {
    getRecentEventLoopP99Ms: () => number | null
  }
}

function clampMs(nanoseconds: number): number {
  const ms = nanoseconds / 1e6
  if (!Number.isFinite(ms) || ms < 0) return 0
  return Math.round(ms * 1000) / 1000
}

/** 单场景高分辨率事件循环延迟探针（与 03 同源的 monitorEventLoopDelay API） */
class ScenarioLoopDelayProbe {
  private readonly histogram = monitorEventLoopDelay({ resolution: 10 })

  async start(): Promise<void> {
    this.histogram.enable()
    this.histogram.reset()
    // 跨过一次 libuv timer/poll 周期，确保建立起始事件循环帧基准
    await new Promise<void>(resolve => setTimeout(resolve, 10))
  }

  async stop(): Promise<LatencySummary> {
    // 跨过一次 libuv timer/poll 周期，确保前面同步阻塞耗时结算进直方图
    await new Promise<void>(resolve => setTimeout(resolve, 10))
    const samples = this.histogram.count
    const summary: LatencySummary =
      samples > 0
        ? {
            p50Ms: clampMs(this.histogram.percentile(50)),
            p99Ms: clampMs(this.histogram.percentile(99)),
            maxMs: clampMs(this.histogram.max),
            meanMs: clampMs(this.histogram.mean),
            sampleCount: samples
          }
        : { p50Ms: 0, p99Ms: 0, maxMs: 0, meanMs: 0, sampleCount: 0 }
    try {
      this.histogram.disable()
    } catch (err) {
      console.warn('[BenchHarness] disable monitorEventLoopDelay 失败:', err)
    }
    return summary
  }
}

function extractLineNumber(callSite: string): number {
  const match = /:(\d+)$/.exec(callSite)
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER
}

function captureSyncIoSummary(
  ctx: BenchExecutionContext,
  filterP03Companion = false
): BenchSyncIoSummary {
  const status = ctx.instrumentation.getSyncIoInstrumentationStatus()
  const report = ctx.instrumentation.buildSyncIoReport()
  let p03Count: number | undefined
  if (filterP03Companion) {
    // 区分 handleFileAdded 入口常规 fs.existsSync 与后续伴生扩展循环探测，避免把常规入口存在检查混入伴生口径
    const watcherExistsSites = report.callSites
      .filter(site => site.callSite.includes('file-watcher-service'))
      .map(site => ({
        line: extractLineNumber(site.callSite),
        count: site.methods
          .filter(m => m.module === 'fs' && m.method === 'existsSync')
          .reduce((acc, m) => acc + m.count, 0)
      }))
      .filter(item => item.count > 0)
      .sort((a, b) => a.line - b.line)

    if (watcherExistsSites.length >= 2) {
      p03Count = watcherExistsSites.slice(1).reduce((acc, item) => acc + item.count, 0)
    } else {
      p03Count = watcherExistsSites.reduce((acc, item) => acc + item.count, 0)
    }
  }
  return {
    enabled: status.enabled,
    delayMs: status.delayMs,
    totalCount: report.totals.count,
    totalMs: report.totals.totalMs,
    totalCallMs: report.totals.totalCallMs,
    maxMs: report.totals.maxMs,
    distinctCallSites: report.totals.distinctCallSites,
    byModule: report.byModule,
    topCallSites: report.callSites,
    ...(p03Count !== undefined ? { p03CompanionCallCount: p03Count } : {})
  }
}

function sampleWalBytes(dbPath: string, rawFs: RawFsApi): number {
  const walPath = `${dbPath}-wal`
  try {
    if (!rawFs.existsSync(walPath)) return 0
    return rawFs.statSync(walPath).size
  } catch (err) {
    console.warn('[BenchHarness] 采样 WAL 文件大小失败:', err)
    return 0
  }
}

function runPassiveCheckpoint(db: Database): WalCheckpointResult {
  const rows = db.pragma('wal_checkpoint(PASSIVE)') as Array<{
    busy?: number
    log?: number
    checkpointed?: number
  }>
  const first = rows[0] ?? {}
  return {
    busy: Number(first.busy ?? 0),
    log: Number(first.log ?? 0),
    checkpointed: Number(first.checkpointed ?? 0)
  }
}

/** 获取已初始化的基准数据库实例，避免分散非空断言 */
function requireDb(): Database {
  if (!databaseService.db) {
    throw new Error('[bench] 数据库尚未初始化，无法执行基准场景')
  }
  return databaseService.db
}

/** 每轮基准前重建纯净 Genesis V1 数据库，杜绝跨轮行残留与扫描放大 */
async function resetGenesisDatabase(ctx: BenchExecutionContext): Promise<Database> {
  const prevPath = databaseService.getDbPath()
  try {
    await fileWatcherService.cleanup()
  } catch (err) {
    console.warn('[BenchHarness] 重置前清理 FileWatcherService 失败:', err)
  }
  try {
    await databaseService.close()
  } catch (err) {
    console.warn('[BenchHarness] 重置前关闭 DatabaseService 失败:', err)
  }
  if (prevPath) {
    for (const suffix of ['', '-wal', '-shm']) {
      const target = `${prevPath}${suffix}`
      if (ctx.rawFs.existsSync(target)) {
        ctx.rawFs.rmSync(target, { force: true, maxRetries: 5, retryDelay: 50 })
      }
    }
  }
  await databaseService.initialize('zh-CN')
  const freshDb = requireDb()
  workspaceAdmissionService.configureRuntimeDependencies({
    getDb: () => databaseService.db,
    systemRulesProvider: () => loadIgnoreRules()
  })
  return freshDb
}

/** 等待 FileWatcherService 下挂载的 chokidar 监听器进入 ready 状态 */
async function waitForWatcherReady(workspaceId: number, timeoutMs = 15_000): Promise<void> {
  type ChokidarLikeWatcher = {
    _readyEmitted?: boolean
    once?: (event: 'ready' | 'error', cb: (err?: unknown) => void) => void
  }
  const watchersMap = (fileWatcherService as unknown as { watchers?: Map<number, ChokidarLikeWatcher> }).watchers
  const watcher = watchersMap?.get(workspaceId)
  if (!watcher || watcher._readyEmitted) {
    return
  }

  await new Promise<void>((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      reject(new Error(`[BenchHarness] chokidar ready 等待超时 (${timeoutMs}ms), workspaceId=${workspaceId}`))
    }, timeoutMs)

    if (typeof watcher.once === 'function') {
      watcher.once('ready', () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve()
      })
      watcher.once('error', err => {
        if (done) return
        done = true
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      })
    } else {
      clearTimeout(timer)
      resolve()
    }
  })
}

/** 对沙箱连接临时安装事务提交与写锁等待观测包装（覆盖 db.transaction / .immediate() / db.exec('BEGIN IMMEDIATE')） */
function installDbTransactionProbe(db: Database): {
  reset: () => void
  snapshot: () => { commitCount: number; lockWaitsMs: number[] }
  restore: () => void
} {
  let commitCount = 0
  let transactionDepth = 0
  let execTxActive = false
  const lockWaitsMs: number[] = []
  const origTransaction = db.transaction.bind(db)
  const origPrepare = db.prepare.bind(db)
  const origExec = db.exec.bind(db)
  const writeSqlRe = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i
  const beginImmediateRe = /^\s*BEGIN\s+(IMMEDIATE|EXCLUSIVE)\b/i
  const beginGenericRe = /^\s*BEGIN\b/i
  const commitRe = /^\s*(COMMIT|END)\b/i
  const rollbackTopRe = /^\s*ROLLBACK\b(?!\s+TO\b)/i
  const mutableDb = db as unknown as {
    prepare: typeof db.prepare
    transaction: typeof db.transaction
    exec: typeof db.exec
  }

  mutableDb.exec = ((sql: string) => {
    const isBeginImmediate = beginImmediateRe.test(sql)
    const isBegin = isBeginImmediate || beginGenericRe.test(sql)
    const requestedAt = isBeginImmediate ? performance.now() : 0
    const res = origExec(sql)
    if (isBeginImmediate) {
      lockWaitsMs.push(Math.round((performance.now() - requestedAt) * 1000) / 1000)
    }
    if (isBegin) {
      execTxActive = true
      transactionDepth += 1
    } else if (commitRe.test(sql) && execTxActive) {
      execTxActive = false
      transactionDepth = Math.max(0, transactionDepth - 1)
      if (transactionDepth === 0) {
        commitCount += 1
      }
    } else if (rollbackTopRe.test(sql) && execTxActive) {
      execTxActive = false
      transactionDepth = Math.max(0, transactionDepth - 1)
    }
    return res
  }) as typeof db.exec

  mutableDb.prepare = ((sql: string) => {
    const stmt = origPrepare(sql)
    if (writeSqlRe.test(sql) && typeof stmt.run === 'function') {
      const origRun = stmt.run.bind(stmt)
      const mutableStmt = stmt as unknown as { run: typeof stmt.run }
      mutableStmt.run = ((...args: unknown[]) => {
        const res = origRun(...(args as []))
        // 仅在无外层事务时计入隐式 autocommit 次数
        if (transactionDepth === 0) {
          commitCount += 1
        }
        return res
      }) as typeof stmt.run
    }
    return stmt
  }) as typeof db.prepare

  mutableDb.transaction = ((fn: (...args: unknown[]) => unknown) => {
    const wrappedTx = origTransaction((...args: unknown[]) => {
      transactionDepth += 1
      try {
        const result = fn(...args)
        if (transactionDepth === 1) commitCount += 1
        return result
      } finally {
        transactionDepth -= 1
      }
    })

    const wrappedCallable = ((...args: unknown[]) => wrappedTx(...args)) as typeof wrappedTx
    Object.assign(wrappedCallable, wrappedTx)
    wrappedCallable.immediate = ((...args: unknown[]) => {
      const requestedAt = performance.now()
      let waitRecorded = false
      const immediateTx = origTransaction((...innerArgs: unknown[]) => {
        if (!waitRecorded) {
          lockWaitsMs.push(Math.round((performance.now() - requestedAt) * 1000) / 1000)
          waitRecorded = true
        }
        transactionDepth += 1
        try {
          const result = fn(...innerArgs)
          if (transactionDepth === 1) commitCount += 1
          return result
        } finally {
          transactionDepth -= 1
        }
      })
      return immediateTx.immediate(...args)
    }) as typeof wrappedTx.immediate

    return wrappedCallable
  }) as typeof db.transaction

  return {
    reset: () => {
      commitCount = 0
      transactionDepth = 0
      execTxActive = false
      lockWaitsMs.length = 0
    },
    snapshot: () => ({
      commitCount,
      lockWaitsMs: [...lockWaitsMs]
    }),
    restore: () => {
      mutableDb.prepare = origPrepare
      mutableDb.transaction = origTransaction
      mutableDb.exec = origExec
    }
  }
}

function snapshotTableRowCounts(db: Database): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const table of ['workspaces', 'workspace_directories', 'files', 'workspace_files', 'analysis_queue']) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt: number }
      counts[table] = Number(row?.cnt ?? 0)
    } catch (err) {
      console.warn(`[BenchHarness] 统计表 ${table} 行数失败:`, err)
      counts[table] = 0
    }
  }
  return counts
}

function readEnvironmentMetadata(
  ctx: BenchExecutionContext,
  dbRowCounts: Record<string, number>
): BenchEnvironmentMetadata {
  let gitCommit = 'unknown'
  try {
    gitCommit = execSync('git rev-parse --short HEAD', {
      cwd: ctx.repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch (err) {
    console.warn('[BenchHarness] 读取 gitCommit 失败:', err)
  }

  let powerPlan = 'unknown'
  if (process.platform === 'win32') {
    try {
      powerPlan = execSync('powercfg /getactivescheme', {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim()
    } catch (err) {
      console.warn('[BenchHarness] 读取 Windows 电源计划失败:', err)
      powerPlan = 'windows-default'
    }
  }

  const cpus = os.cpus()
  return {
    osVersion: `${os.type()} ${os.release()}`,
    platform: process.platform,
    arch: process.arch,
    cpuModel: cpus[0]?.model ?? 'unknown',
    cpuCores: cpus.length,
    totalMemoryMb: Math.round(os.totalmem() / (1024 * 1024)),
    powerPlan,
    buildVariant: 'electron-dev-harness',
    gitCommit,
    nodeVersion: process.version,
    electronVersion: process.versions.electron ?? 'unknown',
    electronModuleAbi: process.versions.modules ?? 'unknown',
    isElectronMainProcess: Boolean(process.versions.electron) && process.env.ELECTRON_RUN_AS_NODE !== '1',
    posthogEnabled: process.env.ENABLE_POSTHOG === 'true',
    cacheState: 'isolated-tmp',
    delayMs: ctx.delayMs,
    runs: ctx.runs,
    dryRun: ctx.dryRun,
    scaleFactor: ctx.scaleFactor,
    dbRowCounts
  }
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  description: string
): Promise<void> {
  const deadline = performance.now() + timeoutMs
  while (performance.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`[BenchHarness] 等待超时 (${timeoutMs}ms): ${description}`)
}

function insertBenchmarkWorkspace(
  db: Database,
  dirPath: string,
  includeExtensions: string[] = []
): number {
  const nowIso = new Date().toISOString()
  const config = {
    schemaVersion: 1,
    status: 'ready',
    baseAIConfig: DEFAULT_UNBOUND_AI_CONFIG,
    customIncludeRules: includeExtensions.map((ext, idx) => ({
      id: `bench-inc-${idx}`,
      type: 'extension',
      value: ext,
      isActive: true
    }))
  }
  const res = db
    .prepare(
      `INSERT INTO workspaces (path, name, type, is_active, auto_watch, workspace_config, created_at)
       VALUES (?, ?, 'SPEEDY', 1, 0, ?, ?)`
    )
    .run(dirPath, path.basename(dirPath), JSON.stringify(config), nowIso)
  const wsId = Number(res.lastInsertRowid)
  invalidateWorkspacePolicyCache(wsId)
  return wsId
}

function mergeWorstLatency(runs: readonly LatencySummary[]): LatencySummary {
  if (runs.length === 0) {
    return { p50Ms: 0, p99Ms: 0, maxMs: 0, meanMs: 0, sampleCount: 0 }
  }
  return {
    p50Ms: Math.max(...runs.map(r => r.p50Ms)),
    p99Ms: Math.max(...runs.map(r => r.p99Ms)),
    maxMs: Math.max(...runs.map(r => r.maxMs)),
    meanMs: Math.max(...runs.map(r => r.meanMs)),
    sampleCount: runs.reduce((acc, r) => acc + r.sampleCount, 0)
  }
}

/** 场景①：1 万文件单层目录同步（真实 FileWatcherService.syncDirectory + 每轮独立干净 Genesis DB） */
async function runSync10kScenario(
  ctx: BenchExecutionContext,
  targetScale: number
): Promise<{ result: BenchScenarioResult; dbRowCounts: Record<string, number> }> {
  const runs: BenchSingleRunResult[] = []
  let lastDbRowCounts: Record<string, number> = {}

  for (let runIdx = 0; runIdx < ctx.runs; runIdx += 1) {
    const db = await resetGenesisDatabase(ctx)
    const dbPath = databaseService.getDbPath()
    const runDir = path.join(ctx.sandbox.workspacesDir, `sync-10k-run-${runIdx}`)

    try {
      const fixture = buildSync10kFixture(runDir, targetScale, ctx.rawFs)
      const wsId = insertBenchmarkWorkspace(db, fixture.workspaceDir)
      fileWatcherService.updateWorkspaceWhitelist(wsId, null)

      ctx.instrumentation.resetSyncIoStats()
      const loopProbe = new ScenarioLoopDelayProbe()
      let walPeakBytes = sampleWalBytes(dbPath, ctx.rawFs)
      const walTimer = setInterval(() => {
        walPeakBytes = Math.max(walPeakBytes, sampleWalBytes(dbPath, ctx.rawFs))
      }, 20)
      walTimer.unref?.()

      await loopProbe.start()
      const startedAt = performance.now()
      try {
        await fileWatcherService.syncDirectory(fixture.workspaceDir, false)
      } finally {
        clearInterval(walTimer)
      }
      const durationMs = performance.now() - startedAt
      const eventLoop = await loopProbe.stop()
      walPeakBytes = Math.max(walPeakBytes, sampleWalBytes(dbPath, ctx.rawFs))

      const syncCountRow = db
        .prepare('SELECT COUNT(*) AS cnt FROM workspace_files WHERE workspace_id = ?')
        .get(wsId) as { cnt: number }
      lastDbRowCounts = snapshotTableRowCounts(db)

      runs.push({
        runIndex: runIdx,
        durationMs: Math.round(durationMs * 1000) / 1000,
        processedCount: Number(syncCountRow?.cnt ?? 0),
        eventLoop,
        sharedMonitorP99Ms: ctx.eventLoopMonitor.getRecentEventLoopP99Ms(),
        syncIo: captureSyncIoSummary(ctx, false),
        walPeakBytes,
        checkpointPassive: runPassiveCheckpoint(db),
        notes: { dbRowCounts: lastDbRowCounts }
      })
    } finally {
      ctx.rawFs.rmSync(runDir, { recursive: true, force: true })
    }
  }

  return {
    result: aggregateScenarioRuns('sync-10k', '1万文件单层目录同步 (FileWatcherService)', targetScale, runs),
    dbRowCounts: lastDbRowCounts
  }
}

/** 场景②：5 万文件查重预处理（真实 DuplicateDetectionService.scanDuplicates，隔离外部 Omni 端口） */
async function runDup50kScenario(
  ctx: BenchExecutionContext,
  targetScale: number
): Promise<{ result: BenchScenarioResult; dbRowCounts: Record<string, number> }> {
  const runs: BenchSingleRunResult[] = []
  let lastDbRowCounts: Record<string, number> = {}
  const mutableOmni = omniService as unknown as { baseUrl?: string }
  const prevOmniBaseUrl = mutableOmni.baseUrl
  // 强制断连外部可能正在运行的开发态 Omni 端口，保证 100% 走沙箱内本地查重流水线
  mutableOmni.baseUrl = 'http://127.0.0.1:9'

  try {
    for (let runIdx = 0; runIdx < ctx.runs; runIdx += 1) {
      const db = await resetGenesisDatabase(ctx)
      const dupRoot = path.join(ctx.sandbox.workspacesDir, `dup-50k-run-${runIdx}`)

      try {
        const fixture = buildDup50kFixture(db, dupRoot, targetScale, ctx.rawFs)
        lastDbRowCounts = snapshotTableRowCounts(db)

        ctx.instrumentation.resetSyncIoStats()
        const loopProbe = new ScenarioLoopDelayProbe()
        await loopProbe.start()
        const startedAt = performance.now()

        const groups = await duplicateDetectionService.scanDuplicates({
          workspaceDirectoryPath: fixture.workspaceDir,
          strategies: ['exact_hash', 'filename_heuristic'],
          minSimilarity: 80
        })

        const durationMs = performance.now() - startedAt
        const eventLoop = await loopProbe.stop()

        runs.push({
          runIndex: runIdx,
          durationMs: Math.round(durationMs * 1000) / 1000,
          processedCount: fixture.fileCount,
          eventLoop,
          sharedMonitorP99Ms: ctx.eventLoopMonitor.getRecentEventLoopP99Ms(),
          syncIo: captureSyncIoSummary(ctx, false),
          notes: { groupCount: groups.length, dbRowCounts: lastDbRowCounts }
        })
      } finally {
        ctx.rawFs.rmSync(dupRoot, { recursive: true, force: true })
      }
    }
  } finally {
    if (prevOmniBaseUrl !== undefined) {
      mutableOmni.baseUrl = prevOmniBaseUrl
    }
  }

  return {
    result: aggregateScenarioRuns('dup-50k', '5万文件查重预处理 (DuplicateDetectionService)', targetScale, runs),
    dbRowCounts: lastDbRowCounts
  }
}

/** 场景③：批量导入 1000 文件（真实 chokidar ready 等待 + FileWatcherService + 白名单伴生探测 P0-3） */
async function runBatch1kScenario(
  ctx: BenchExecutionContext,
  targetScale: number,
  dbIngestComparison?: DbIngestComparisonMetrics
): Promise<{ result: BenchScenarioResult; dbRowCounts: Record<string, number> }> {
  const runs: BenchSingleRunResult[] = []
  let lastDbRowCounts: Record<string, number> = {}

  for (let runIdx = 0; runIdx < ctx.runs; runIdx += 1) {
    const db = await resetGenesisDatabase(ctx)
    const dbPath = databaseService.getDbPath()
    const runRoot = path.join(ctx.sandbox.workspacesDir, `batch-1k-run-${runIdx}`)

    try {
      const fixture = buildBatch1kFixture(runRoot, targetScale, ctx.rawFs)
      const wsId = insertBenchmarkWorkspace(db, fixture.watchDir, ['.jpg'])

      // 静默自动入队分析队列，聚焦观测 FileWatcherService 新增文件落库 + P0-3 伴生探测
      fileWatcherService.muteAutoWatch(wsId, 600_000)
      await fileWatcherService.startWatching(wsId, fixture.watchDir)
      await waitForWatcherReady(wsId, 15_000)

      ctx.instrumentation.resetSyncIoStats()
      const loopProbe = new ScenarioLoopDelayProbe()
      let walPeakBytes = sampleWalBytes(dbPath, ctx.rawFs)
      const walTimer = setInterval(() => {
        walPeakBytes = Math.max(walPeakBytes, sampleWalBytes(dbPath, ctx.rawFs))
      }, 20)
      walTimer.unref?.()

      await loopProbe.start()
      const startedAt = performance.now()
      try {
        // 走原生 rawFs 批量写入 watchDir，触发真实 chokidar 'add' -> FileWatcherService.handleFileAdded
        for (const item of fixture.sourceFiles) {
          ctx.rawFs.copyFileSync(item.sourcePath, item.targetPath)
        }

        const countStmt = db.prepare('SELECT COUNT(*) AS cnt FROM workspace_files WHERE workspace_id = ?')
        const maxWaitMs = Math.max(30_000, targetScale * (ctx.delayMs * 12 + 80))
        await waitUntil(() => {
          const row = countStmt.get(wsId) as { cnt: number } | undefined
          return Number(row?.cnt ?? 0) >= targetScale
        }, maxWaitMs, `batch-1k chokidar 入库 (${targetScale} 文件)`)
      } finally {
        clearInterval(walTimer)
        await fileWatcherService.stopWatching(wsId)
      }

      const durationMs = performance.now() - startedAt
      const eventLoop = await loopProbe.stop()
      walPeakBytes = Math.max(walPeakBytes, sampleWalBytes(dbPath, ctx.rawFs))
      lastDbRowCounts = snapshotTableRowCounts(db)

      runs.push({
        runIndex: runIdx,
        durationMs: Math.round(durationMs * 1000) / 1000,
        processedCount: targetScale,
        eventLoop,
        sharedMonitorP99Ms: ctx.eventLoopMonitor.getRecentEventLoopP99Ms(),
        syncIo: captureSyncIoSummary(ctx, true),
        walPeakBytes,
        checkpointPassive: runPassiveCheckpoint(db),
        notes: { dbRowCounts: lastDbRowCounts }
      })
    } finally {
      ctx.rawFs.rmSync(runRoot, { recursive: true, force: true })
    }
  }

  return {
    result: aggregateScenarioRuns(
      'batch-1k',
      '批量导入1000文件 (chokidar + FileWatcherService + P0-3伴生)',
      targetScale,
      runs,
      dbIngestComparison
    ),
    dbRowCounts: lastDbRowCounts
  }
}

/** W0-05 & W4 双路径入库与微批对照测量 */
async function runDbIngestComparison(
  ctx: BenchExecutionContext,
  targetScale: number
): Promise<{
  comparison: DbIngestComparisonMetrics
  scenarioRuns: BenchSingleRunResult[]
  dbRowCounts: Record<string, number>
}> {
  const batchRawRuns: number[] = []
  const singleRawRuns: number[] = []
  const batchCommitCounts: number[] = []
  const singleCommitCounts: number[] = []
  const batchLoopRuns: LatencySummary[] = []
  const singleLoopRuns: LatencySummary[] = []
  const batchLockWaits: number[] = []
  const singleLockWaits: number[] = []
  let batchWalPeak = 0
  let singleWalPeak = 0
  let batchCheckpoint: WalCheckpointResult = { busy: 0, log: 0, checkpointed: 0 }
  let singleCheckpoint: WalCheckpointResult = { busy: 0, log: 0, checkpointed: 0 }
  const writerBatchDurations: number[] = []
  const scenarioRuns: BenchSingleRunResult[] = []
  let lastDbRowCounts: Record<string, number> = {}

  for (let runIdx = 0; runIdx < ctx.runs; runIdx += 1) {
    const db = await resetGenesisDatabase(ctx)
    const dbPath = databaseService.getDbPath()
    const probe = installDbTransactionProbe(db)
    const ingestRoot = path.join(ctx.sandbox.workspacesDir, `db-ingest-run-${runIdx}`)

    try {
      const fixture = buildDbIngestFixture(ingestRoot, targetScale, ctx.rawFs)

      // 1. 路径 A：addFilesFromPathsBatch 批量差异扫描入库
      const wsBatchId = insertBenchmarkWorkspace(db, fixture.batchRootDir)
      const batchInfos = fixture.batchFilePaths.map(filePath => ({
        filePath,
        stats: ctx.rawFs.statSync(filePath)
      }))
      probe.reset()
      ctx.instrumentation.resetSyncIoStats()
      const batchLoop = new ScenarioLoopDelayProbe()
      let localBatchWalPeak = sampleWalBytes(dbPath, ctx.rawFs)
      const batchWalTimer = setInterval(() => {
        localBatchWalPeak = Math.max(localBatchWalPeak, sampleWalBytes(dbPath, ctx.rawFs))
      }, 15)
      batchWalTimer.unref?.()

      await batchLoop.start()
      const bStart = performance.now()
      try {
        await databaseService.addFilesFromPathsBatch(batchInfos, wsBatchId)
      } finally {
        clearInterval(batchWalTimer)
      }
      const bElapsed = Math.round((performance.now() - bStart) * 1000) / 1000
      const bLoopSummary = await batchLoop.stop()
      const bSyncIo = captureSyncIoSummary(ctx, false)

      const bSnap = probe.snapshot()
      batchRawRuns.push(bElapsed)
      batchCommitCounts.push(bSnap.commitCount)
      batchLockWaits.push(...bSnap.lockWaitsMs)
      batchWalPeak = Math.max(batchWalPeak, localBatchWalPeak, sampleWalBytes(dbPath, ctx.rawFs))
      batchCheckpoint = runPassiveCheckpoint(db)
      batchLoopRuns.push(bLoopSummary)

      // 2. 路径 B：DirectoryProcessor.expandDirectoryToQueue (逐文件 addFileFromPath，使用独立干净库)
      probe.restore()
      const dbSingle = await resetGenesisDatabase(ctx)
      const dbSinglePath = databaseService.getDbPath()
      const singleProbe = installDbTransactionProbe(dbSingle)
      let singleSyncIo: BenchSyncIoSummary
      let sElapsed = 0
      let sLoopSummary: LatencySummary
      let sSnap: { commitCount: number; lockWaitsMs: number[] }
      let localSingleWalPeak = sampleWalBytes(dbSinglePath, ctx.rawFs)

      try {
        const wsSingleId = insertBenchmarkWorkspace(dbSingle, fixture.singleRootDir)
        await databaseService.addDirectory(fixture.singleRootDir, wsSingleId)
        const processor = new DirectoryProcessor(
          () => ({
            unitRecognitionService: undefined,
            directoryContextService: undefined,
            errorRecoveryConfig: { maxRetries: 0, retryDelayMs: 0 } as never,
            ignoreRules: loadIgnoreRules()
          }),
          () => undefined,
          () => undefined,
          async () => undefined,
          () => undefined
        )

        singleProbe.reset()
        ctx.instrumentation.resetSyncIoStats()
        const singleLoop = new ScenarioLoopDelayProbe()
        const singleWalTimer = setInterval(() => {
          localSingleWalPeak = Math.max(localSingleWalPeak, sampleWalBytes(dbSinglePath, ctx.rawFs))
        }, 15)
        singleWalTimer.unref?.()

        await singleLoop.start()
        const sStart = performance.now()
        try {
          await (processor as unknown as {
            expandDirectoryToQueue: (dir: string, force: boolean) => Promise<void>
          }).expandDirectoryToQueue(fixture.singleRootDir, false)
        } finally {
          clearInterval(singleWalTimer)
        }
        sElapsed = Math.round((performance.now() - sStart) * 1000) / 1000
        sLoopSummary = await singleLoop.stop()
        singleSyncIo = captureSyncIoSummary(ctx, false)

        sSnap = singleProbe.snapshot()
        singleRawRuns.push(sElapsed)
        singleCommitCounts.push(sSnap.commitCount)
        singleLockWaits.push(...sSnap.lockWaitsMs)
        singleWalPeak = Math.max(singleWalPeak, localSingleWalPeak, sampleWalBytes(dbSinglePath, ctx.rawFs))
        singleCheckpoint = runPassiveCheckpoint(dbSingle)
        singleLoopRuns.push(sLoopSummary)

        // 3. 写微批执行器（32 文件微批 BATCH_METRICS.durationMs + 真实 BEGIN IMMEDIATE 事务锁等待探测）
        if (runIdx === ctx.runs - 1) {
          const sampleCount = Math.min(64, targetScale)
          const wfRows = dbSingle
            .prepare('SELECT id, path, name, file_size, mtime_ms FROM workspace_files WHERE workspace_id = ? LIMIT ?')
            .all(wsSingleId, sampleCount) as Array<{
            id: number
            path: string
            name: string
            file_size: number
            mtime_ms: number
          }>

          if (wfRows.length > 0) {
            // 先创建真实 analysis_queue 行，使 WriteSetBatchDispatcher Step 8 状态回写闭环真实生效
            const insertQueueStmt = dbSingle.prepare(
              `INSERT INTO analysis_queue (item_id, item_type, priority, status, task_type, progress)
               VALUES (?, 'file', 5, 'pending', 'analysis', 0)`
            )
            const queueIds = dbSingle.transaction(() =>
              wfRows.map(r => Number(insertQueueStmt.run(r.id).lastInsertRowid))
            )()

            let acked = 0
            singleProbe.reset()
            const dispatcher = new WriteSetBatchDispatcher({
              getDb: () => dbSingle,
              coalesceWindowMs: 5,
              onWriteAck: () => {
                acked += 1
              },
              onBatchExecuted: (_size, dMs) => {
                writerBatchDurations.push(dMs)
              }
            })

            try {
              for (let idx = 0; idx < wfRows.length; idx += 1) {
                const r = wfRows[idx]
                const writeSet: AnalysisWriteSet = {
                  queueId: queueIds[idx],
                  guard: {
                    workspaceFileId: r.id,
                    workspaceId: wsSingleId,
                    size: r.file_size,
                    mtimeMs: r.mtime_ms
                  },
                  fileFingerprint: `bench_ws_${crypto.createHash('sha1').update(r.path).digest('hex').slice(0, 20)}`,
                  workspaceFileId: r.id,
                  physicalPath: r.path,
                  fileName: r.name,
                  filesUpdate: { extension: '.txt', description: `bench write set ${idx}` },
                  fileContents: { plainContent: `bench body ${idx}` },
                  queueUpdate: { status: 'completed', endTime: new Date().toISOString(), progress: 100 },
                  canonicalVectorWakeup: false
                }
                dispatcher.enqueue(writeSet)
              }
              await dispatcher.flush()
              await waitUntil(() => acked >= wfRows.length, 15_000, 'WriteSetBatchDispatcher micro-batch')
              const writerSnap = singleProbe.snapshot()
              singleLockWaits.push(...writerSnap.lockWaitsMs)
            } finally {
              dispatcher.dispose()
            }
          }
        }

        lastDbRowCounts = snapshotTableRowCounts(dbSingle)
      } finally {
        singleProbe.restore()
      }

      scenarioRuns.push({
        runIndex: runIdx,
        durationMs: sElapsed,
        processedCount: targetScale,
        eventLoop: sLoopSummary,
        sharedMonitorP99Ms: ctx.eventLoopMonitor.getRecentEventLoopP99Ms(),
        syncIo: singleSyncIo,
        walPeakBytes: localSingleWalPeak,
        checkpointPassive: singleCheckpoint,
        notes: {
          batchDurationMs: bElapsed,
          batchCommitCount: bSnap.commitCount,
          singleCommitCount: sSnap.commitCount,
          batchSyncIoTotalCount: bSyncIo.totalCount,
          dbRowCounts: lastDbRowCounts
        }
      })
    } finally {
      probe.restore()
      ctx.rawFs.rmSync(ingestRoot, { recursive: true, force: true })
    }
  }

  const batchSummary = summarizeDurations(batchRawRuns)
  const singleSummary = summarizeDurations(singleRawRuns)

  const batchMetrics: IngestPathMetrics = {
    pathKind: 'batch-scan',
    fileCount: targetScale,
    durationMs: batchSummary,
    commitCount: batchCommitCounts.length > 0 ? Math.max(...batchCommitCounts) : 0,
    eventLoop: mergeWorstLatency(batchLoopRuns),
    writeLockWaitMs: summarizeLatencies(batchLockWaits),
    walPeakBytes: batchWalPeak,
    checkpointPassive: batchCheckpoint
  }

  const singleMetrics: IngestPathMetrics = {
    pathKind: 'single-file-expand',
    fileCount: targetScale,
    durationMs: singleSummary,
    commitCount: singleCommitCounts.length > 0 ? Math.max(...singleCommitCounts) : 0,
    eventLoop: mergeWorstLatency(singleLoopRuns),
    writeLockWaitMs: summarizeLatencies(singleLockWaits),
    walPeakBytes: singleWalPeak,
    checkpointPassive: singleCheckpoint
  }

  const ratio =
    batchSummary.medianMs > 0
      ? Math.round((singleSummary.medianMs / batchSummary.medianMs) * 100) / 100
      : 0

  return {
    comparison: {
      batchPath: batchMetrics,
      singlePath: singleMetrics,
      writerBatchMetricsDurationMs: summarizeLatencies(writerBatchDurations),
      throughputRatioSingleOverBatch: ratio
    },
    scenarioRuns,
    dbRowCounts: lastDbRowCounts
  }
}

/** 根据 dryRun / scaleFactor / 显式覆盖解析各场景夹具规模 */
export function resolveScenarioScale(
  scenarioId: BenchScenarioId,
  ctx: BenchExecutionContext
): number {
  const override = ctx.scaleOverrides[scenarioId]
  if (typeof override === 'number' && override > 0) {
    return Math.round(override)
  }
  const defaults: Record<BenchScenarioId, number> = ctx.dryRun
    ? {
        'sync-10k': 80,
        'dup-50k': 120,
        'batch-1k': 25,
        'db-ingest-10k': 60
      }
    : {
        'sync-10k': 10_000,
        'dup-50k': 50_000,
        'batch-1k': 1_000,
        'db-ingest-10k': 10_000
      }
  return Math.max(1, Math.round(defaults[scenarioId] * ctx.scaleFactor))
}

/** 在真实 Electron 主进程中执行完整基准测试套件 */
export async function executeBenchSuite(ctx: BenchExecutionContext): Promise<BenchReport> {
  await app.whenReady()

  const orchestrator = ConfigOrchestrator.getInstance()
  await orchestrator.updateValue('LANGUAGE_CONFIRMED', true)
  await orchestrator.updateValue('DEFAULT_LANGUAGE', 'zh-CN')

  await databaseService.initialize('zh-CN')
  if (!databaseService.db) {
    throw new Error('[BenchHarness] 真实 DatabaseService 初始化后 db 为空')
  }

  // 与 initialization.ts:311 同源注入运行时依赖，保证 FileWatcherService / WorkspaceAdmissionService 完整工作
  workspaceAdmissionService.configureRuntimeDependencies({
    getDb: () => databaseService.db,
    systemRulesProvider: () => loadIgnoreRules()
  })

  const targetScenarios = selectScopeScenarios(ctx.mode, ctx.scenarios)
  const scenarioResults: Partial<Record<BenchScenarioId, BenchScenarioResult>> = {}
  let primaryDbRowCounts: Record<string, number> = {}

  try {
    let dbIngestBundle:
      | {
          comparison: DbIngestComparisonMetrics
          scenarioRuns: BenchSingleRunResult[]
          dbRowCounts: Record<string, number>
        }
      | undefined
    if (ctx.includeDbIngest || targetScenarios.includes('db-ingest-10k')) {
      const ingestScale = resolveScenarioScale('db-ingest-10k', ctx)
      dbIngestBundle = await runDbIngestComparison(ctx, ingestScale)
      primaryDbRowCounts = dbIngestBundle.dbRowCounts
    }

    for (const scenarioId of targetScenarios) {
      const scale = resolveScenarioScale(scenarioId, ctx)
      if (scenarioId === 'sync-10k') {
        const out = await runSync10kScenario(ctx, scale)
        scenarioResults['sync-10k'] = out.result
        primaryDbRowCounts = out.dbRowCounts
      } else if (scenarioId === 'dup-50k') {
        const out = await runDup50kScenario(ctx, scale)
        scenarioResults['dup-50k'] = out.result
        primaryDbRowCounts = out.dbRowCounts
      } else if (scenarioId === 'batch-1k') {
        const out = await runBatch1kScenario(ctx, scale, dbIngestBundle?.comparison)
        scenarioResults['batch-1k'] = out.result
        primaryDbRowCounts = out.dbRowCounts
      } else if (scenarioId === 'db-ingest-10k' && dbIngestBundle) {
        scenarioResults['db-ingest-10k'] = aggregateScenarioRuns(
          'db-ingest-10k',
          'W0-05 双路径入库对比 (addFilesFromPathsBatch vs DirectoryProcessor)',
          scale,
          dbIngestBundle.scenarioRuns,
          dbIngestBundle.comparison
        )
        primaryDbRowCounts = dbIngestBundle.dbRowCounts
      }
    }

    const environment = readEnvironmentMetadata(ctx, primaryDbRowCounts)

    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      mode: ctx.mode,
      environment,
      scenarios: scenarioResults
    }
  } finally {
    try {
      await fileWatcherService.cleanup()
    } catch (cleanupErr) {
      console.warn('[BenchHarness] 退出清理 FileWatcherService 失败:', cleanupErr)
    }
    try {
      await databaseService.close()
    } catch (closeErr) {
      console.warn('[BenchHarness] 退出关闭 DatabaseService 失败:', closeErr)
    }
  }
}
