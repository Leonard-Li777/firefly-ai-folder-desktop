/**
 * Electron 基准统计计算、CI 相对回归门禁与延迟注入对照模块（纯逻辑，零 Electron 顶层依赖）
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import {
  compareDelayInjectionReports,
  evaluateRelativeRegressionReport
} from './ci-regression-gate.mjs'
import type {
  BenchMode,
  BenchReport,
  BenchScenarioId,
  BenchScenarioResult,
  BenchSingleRunResult,
  DelayInjectionComparison,
  DurationSummary,
  LatencySummary,
  RegressionGateOptions,
  RegressionGateResult
} from './types'

export const PR_SCENARIOS: readonly BenchScenarioId[] = ['sync-10k']
export const NIGHTLY_SCENARIOS: readonly BenchScenarioId[] = ['sync-10k', 'dup-50k', 'batch-1k']
export const DEFAULT_REGRESSION_THRESHOLD = 0.1
export const DEFAULT_MIN_FLOOR_MS = 5

function roundMs(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 1000) / 1000
}

/** 计算有序数组的分位数（线性最近秩，0 <= percentile <= 100） */
export function computePercentile(sortedValues: readonly number[], percentile: number): number {
  if (sortedValues.length === 0) return 0
  const clamped = Math.min(100, Math.max(0, percentile))
  if (clamped === 0) return roundMs(sortedValues[0])
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((clamped / 100) * sortedValues.length) - 1)
  )
  return roundMs(sortedValues[index])
}

/** 计算中位数（偶数组取中间两项均值） */
export function computeMedian(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) {
    return roundMs(sorted[mid])
  }
  return roundMs((sorted[mid - 1] + sorted[mid]) / 2)
}

/** 从原始延迟样本数组计算 p50 / p99 / max / mean */
export function summarizeLatencies(samples: readonly number[]): LatencySummary {
  const valid = samples.filter(v => Number.isFinite(v) && v >= 0).sort((a, b) => a - b)
  if (valid.length === 0) {
    return { p50Ms: 0, p99Ms: 0, maxMs: 0, meanMs: 0, sampleCount: 0 }
  }
  const sum = valid.reduce((acc, v) => acc + v, 0)
  return {
    p50Ms: computePercentile(valid, 50),
    p99Ms: computePercentile(valid, 99),
    maxMs: roundMs(valid[valid.length - 1]),
    meanMs: roundMs(sum / valid.length),
    sampleCount: valid.length
  }
}

/** 汇总多次墙钟测量（严格保留原始值，中位数为代表值） */
export function summarizeDurations(rawRunsMs: readonly number[]): DurationSummary {
  const clean = rawRunsMs.filter(v => Number.isFinite(v) && v >= 0).map(roundMs)
  if (clean.length === 0) {
    return { medianMs: 0, minMs: 0, maxMs: 0, rawRunsMs: [] }
  }
  const sorted = [...clean].sort((a, b) => a - b)
  return {
    medianMs: computeMedian(clean),
    minMs: sorted[0],
    maxMs: sorted[sorted.length - 1],
    rawRunsMs: clean
  }
}

/**
 * 汇总同一场景的多次运行结果：
 * - 墙钟耗时按 §7.1 取中位数（保留全部原始值）
 * - 卡顿延迟 p99 / max 按 §7.1 取多次运行的最差值（Max）
 * - 同步 I/O 取调用点耗时之和最重的那一次（或首次完整样本）以便稳定归因
 */
export function aggregateScenarioRuns(
  scenarioId: BenchScenarioId,
  name: string,
  fixtureScale: number,
  runs: BenchSingleRunResult[],
  dbIngestComparison?: BenchScenarioResult['dbIngestComparison']
): BenchScenarioResult {
  const durationMs = summarizeDurations(runs.map(r => r.durationMs))

  const worstEventLoop: LatencySummary =
    runs.length === 0
      ? { p50Ms: 0, p99Ms: 0, maxMs: 0, meanMs: 0, sampleCount: 0 }
      : {
          p50Ms: roundMs(Math.max(...runs.map(r => r.eventLoop.p50Ms))),
          p99Ms: roundMs(Math.max(...runs.map(r => r.eventLoop.p99Ms))),
          maxMs: roundMs(Math.max(...runs.map(r => r.eventLoop.maxMs))),
          meanMs: roundMs(Math.max(...runs.map(r => r.eventLoop.meanMs))),
          sampleCount: runs.reduce((acc, r) => acc + r.eventLoop.sampleCount, 0)
        }

  const representativeRun =
    runs.length === 0
      ? undefined
      : [...runs].sort((a, b) => b.syncIo.totalMs - a.syncIo.totalMs)[0]

  return {
    scenarioId,
    name,
    fixtureScale,
    runs,
    durationMs,
    latency: worstEventLoop,
    syncIo: representativeRun
      ? representativeRun.syncIo
      : {
          enabled: false,
          delayMs: 0,
          totalCount: 0,
          totalMs: 0,
          totalCallMs: 0,
          maxMs: 0,
          distinctCallSites: 0,
          byModule: {},
          topCallSites: []
        },
    ...(dbIngestComparison ? { dbIngestComparison } : {})
  }
}

/** 按运行模式解析待执行的场景集合（PR 只跑 1 万文件；nightly 跑全量三场景） */
export function selectScopeScenarios(
  mode: BenchMode,
  requested?: readonly BenchScenarioId[]
): BenchScenarioId[] {
  if (mode === 'pr') {
    return [...PR_SCENARIOS]
  }
  if (mode === 'nightly') {
    return [...NIGHTLY_SCENARIOS]
  }
  if (requested && requested.length > 0) {
    return Array.from(new Set(requested))
  }
  return [...NIGHTLY_SCENARIOS]
}

/**
 * CI 相对回归门禁（单一事实源委托至 ci-regression-gate.mjs）：
 * - 只比相对回归（劣化 > 10% 判失败），不卡绝对值
 * - PR 范围只检验 `sync-10k`；nightly 检验全量三场景
 */
export function evaluateRelativeRegression(
  current: BenchReport,
  baseline: BenchReport,
  options: RegressionGateOptions = {}
): RegressionGateResult {
  return evaluateRelativeRegressionReport(current, baseline, options)
}

/**
 * 对比「开启延迟注入 (delayMs=5)」与「关闭延迟注入 (delayMs=0)」两组报告（单一事实源委托至 ci-regression-gate.mjs），
 * 校验关闭状态下同场景 p99 / 同步阻塞总耗时确实明显更低，输出网络盘模拟标识。
 */
export function compareDelayInjection(
  withDelay: BenchReport,
  withoutDelay: BenchReport
): DelayInjectionComparison {
  return compareDelayInjectionReports(withDelay, withoutDelay)
}

/** 默认报告输出目录（apps/desktop/reports/bench） */
export function resolveBenchReportDir(desktopRoot: string): string {
  return path.join(desktopRoot, 'reports', 'bench')
}

/** 将报告持久化到 JSON 文件（使用调用方指定的 fs 模块或原生 fs） */
export function writeBenchReportToFile(report: BenchReport, outPath: string): string {
  const resolved = path.resolve(outPath)
  const dir = path.dirname(resolved)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  fs.writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return resolved
}
