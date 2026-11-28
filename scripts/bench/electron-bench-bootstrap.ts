/**
 * Electron ABI 基准自举入口（工单 IO-04）
 *
 * 职责与执行序（顺序严禁颠倒）：
 * 1. 强校验 Electron 主进程 ABI（严禁裸 Node 或 `ELECTRON_RUN_AS_NODE=1` 回落）；
 * 2. 开启 `process.setSourceMapsEnabled?.(true)` 使 `instrument.ts` 取栈还原真实 `.ts:line`；
 * 3. 先快照原生未插桩 `rawFs`，创建沙箱并提前 `app.setPath('userData' | 'appData' | 'temp' | 'logs', ...)`；
 * 4. 在加载任何业务模块前启用 `enableSyncIoInstrumentation`（默认 5ms 延迟模拟网络盘，支持 `--delay-ms=0` 关闭）
 *    与 `ensureEventLoopDelaySampler`（复用 03 统一采样通道）；
 * 5. 动态加载编译后的 `bench-scenarios.cjs`，执行基准、写出报告 JSON、彻底清理沙箱并退出。
 */

import { app } from 'electron'
import * as path from 'node:path'
import {
  DEFAULT_INJECTED_DELAY_MS,
  buildSyncIoReport,
  disableSyncIoInstrumentation,
  enableSyncIoInstrumentation,
  getSyncIoInstrumentationStatus,
  resetSyncIoStats
} from '../../src/electron/infra/fs/instrument'
import {
  ensureEventLoopDelaySampler,
  getRecentEventLoopP99Ms,
  stopEventLoopDelayMonitor
} from '@pro/perf/event-loop-monitor'
import { captureRawFs, createBenchSandbox } from './fixtures'
import { writeBenchReportToFile } from './stats'
import type { BenchMode, BenchReport, BenchScenarioId } from './types'

/** 在最早期断言真实 Electron 主进程环境（ABI 硬门禁，禁止静默降级为裸 Node） */
export function assertElectronMainProcessAbi(): void {
  if (!process.versions.electron) {
    throw new Error(
      '[ABI_ASSERTION_FAILED] 检测到非 Electron 运行时 (process.versions.electron 缺失)，严禁回落到裸 Node 运行基准测试。'
    )
  }
  if (process.env.ELECTRON_RUN_AS_NODE === '1') {
    throw new Error(
      '[ABI_ASSERTION_FAILED] 检测到 ELECTRON_RUN_AS_NODE=1，基准 harness 必须在真实 Electron 主进程下运行。'
    )
  }
}

interface ParsedCliOptions {
  mode: BenchMode
  scenarios: BenchScenarioId[]
  delayMs: number
  runs: number
  dryRun: boolean
  scaleFactor: number
  includeDbIngest: boolean
  outPath?: string
  sandboxRoot?: string
  repoRoot: string
  scaleOverrides: Partial<Record<BenchScenarioId, number>>
}

function parseCliArgs(argv: string[]): ParsedCliOptions {
  const args = new Map<string, string>()
  const flags = new Set<string>()
  for (const token of argv) {
    if (!token.startsWith('--')) continue
    const eqIdx = token.indexOf('=')
    if (eqIdx > 0) {
      args.set(token.slice(2, eqIdx), token.slice(eqIdx + 1))
    } else {
      flags.add(token.slice(2))
    }
  }

  const rawMode = args.get('mode') ?? 'pr'
  if (rawMode !== 'pr' && rawMode !== 'nightly' && rawMode !== 'custom') {
    throw new Error(`[BenchBootstrap] 非法的 --mode 参数: ${rawMode}（仅支持 pr | nightly | custom）`)
  }
  const mode: BenchMode = rawMode

  const validScenarioIds = new Set<BenchScenarioId>(['sync-10k', 'dup-50k', 'batch-1k', 'db-ingest-10k'])
  const rawScenarios = args.get('scenarios')
  const scenarios = rawScenarios
    ? rawScenarios
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(id => {
          if (!validScenarioIds.has(id as BenchScenarioId)) {
            throw new Error(`[BenchBootstrap] 未知场景 ID: ${id}`)
          }
          return id as BenchScenarioId
        })
    : []

  const parseNonNegativeNumber = (flag: string, fallback: number, minVal = 0): number => {
    const raw = args.get(flag)
    if (raw === undefined) return fallback
    const n = Number(raw)
    if (!Number.isFinite(n) || n < minVal) {
      throw new Error(`[BenchBootstrap] 非法的 --${flag} 参数: ${raw}`)
    }
    return n
  }

  const delayMs = parseNonNegativeNumber('delay-ms', DEFAULT_INJECTED_DELAY_MS, 0)
  const runs = Math.round(parseNonNegativeNumber('runs', 1, 1))
  const dryRun = flags.has('dry-run') || process.env.FF_BENCH_DRY_RUN === '1'
  const scaleFactor = parseNonNegativeNumber('scale-factor', 1, 0.0001)

  const scaleOverrides: Partial<Record<BenchScenarioId, number>> = {}
  if (args.has('scale-10k')) scaleOverrides['sync-10k'] = parseNonNegativeNumber('scale-10k', 1, 1)
  if (args.has('scale-50k')) scaleOverrides['dup-50k'] = parseNonNegativeNumber('scale-50k', 1, 1)
  if (args.has('scale-1k')) scaleOverrides['batch-1k'] = parseNonNegativeNumber('scale-1k', 1, 1)
  if (args.has('scale-ingest')) scaleOverrides['db-ingest-10k'] = parseNonNegativeNumber('scale-ingest', 1, 1)

  return {
    mode,
    scenarios,
    delayMs,
    runs,
    dryRun,
    scaleFactor,
    includeDbIngest: flags.has('with-db-ingest'),
    outPath: args.get('out'),
    sandboxRoot: args.get('sandbox-root'),
    repoRoot: args.get('repo-root') ?? path.resolve(__dirname, '../../../..'),
    scaleOverrides
  }
}

async function bootstrapAndRun(): Promise<void> {
  assertElectronMainProcessAbi()

  // 开启原生 SourceMap 还原，使 instrument.ts 的调用点归属精确到源码 .ts:line
  const procWithSourceMaps = process as unknown as {
    setSourceMapsEnabled?: (enabled: boolean) => void
  }
  if (typeof procWithSourceMaps.setSourceMapsEnabled === 'function') {
    procWithSourceMaps.setSourceMapsEnabled(true)
  }

  const cli = parseCliArgs(process.argv.slice(1))
  // 先快照未插桩原生 fs，供夹具创建、清理与结果落盘，绝不污染业务插桩计数
  const rawFs = captureRawFs()
  const sandbox = createBenchSandbox({
    baseTempDir: cli.sandboxRoot ? path.dirname(cli.sandboxRoot) : undefined,
    runId: cli.sandboxRoot ? path.basename(cli.sandboxRoot).replace(/^ff-bench-/, '') : undefined,
    rawFs
  })

  let exitCode = 0
  try {
    // 严格在加载业务服务之前隔离全部 Electron 运行时路径，防止污染用户目录
    app.setPath('userData', sandbox.userDataDir)
    app.setPath('appData', sandbox.appDataDir)
    app.setPath('temp', sandbox.tempDir)
    app.setPath('logs', sandbox.logsDir)
    process.env.FIREFLY_USER_DATA_DIR = sandbox.userDataDir
    process.env.FF_SYNC_IO_INSTRUMENT = '1'

    const instrOk = enableSyncIoInstrumentation({
      delayMs: cli.delayMs,
      countSync: true,
      countAsync: false,
      force: true
    })
    if (!instrOk) {
      throw new Error('[BenchBootstrap] enableSyncIoInstrumentation 启用失败，中止基准运行')
    }

    const monitorOk = ensureEventLoopDelaySampler({
      windowMs: 600_000,
      resolutionMs: 10,
      force: true
    })
    if (!monitorOk) {
      console.warn('[BenchBootstrap] @pro/perf/event-loop-monitor 采样器未启用，将回退局部直方图')
    }

    // 动态加载已编译的业务场景模块：此时所有模块顶层的 node:fs 均命中已插桩对象
    const scenariosEntry = path.join(__dirname, 'bench-scenarios.cjs')
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const scenariosMod = require(scenariosEntry) as {
      executeBenchSuite: (ctx: unknown) => Promise<BenchReport>
    }

    const report = await scenariosMod.executeBenchSuite({
      sandbox,
      rawFs,
      mode: cli.mode,
      scenarios: cli.scenarios,
      delayMs: cli.delayMs,
      runs: cli.runs,
      dryRun: cli.dryRun,
      scaleFactor: cli.scaleFactor,
      includeDbIngest: cli.includeDbIngest,
      repoRoot: cli.repoRoot,
      scaleOverrides: cli.scaleOverrides,
      instrumentation: {
        buildSyncIoReport,
        resetSyncIoStats,
        getSyncIoInstrumentationStatus
      },
      eventLoopMonitor: {
        getRecentEventLoopP99Ms
      }
    })

    disableSyncIoInstrumentation()
    stopEventLoopDelayMonitor()

    if (cli.outPath) {
      writeBenchReportToFile(report, cli.outPath)
    } else {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    }
  } catch (error) {
    exitCode = 1
    console.error('[BenchBootstrap] 基准执行失败:', error)
  } finally {
    try {
      disableSyncIoInstrumentation()
      stopEventLoopDelayMonitor()
    } catch (stopErr) {
      console.warn('[BenchBootstrap] 停止观测探针失败:', stopErr)
    }
    try {
      sandbox.cleanup()
    } catch (cleanupErr) {
      // 若外部句柄尚未随子进程退出释放，将由外层 CLI orchestrator 在进程退出后完成兜底清理
      if (!cli.sandboxRoot) {
        console.warn('[BenchBootstrap] 清理沙箱夹具失败:', cleanupErr)
      }
    }
    app.exit(exitCode)
  }
}

void bootstrapAndRun()
