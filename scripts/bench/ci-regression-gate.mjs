#!/usr/bin/env node
/**
 * CI 相对回归门禁与延迟对照评估模块（工单 IO-04 单一事实源）
 *
 * 规则：
 * - 只比相对回归（劣化 > 10% 判失败），不卡绝对值
 * - PR 模式仅检查 `sync-10k`；Nightly 模式检查 `sync-10k` / `dup-50k` / `batch-1k` 全量三场景
 *
 * 用法：
 *   node scripts/bench/ci-regression-gate.mjs --current=<current.json> --baseline=<baseline.json> [--scope=pr|nightly|auto] [--threshold=0.10]
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

function roundMs(value) {
  if (!Number.isFinite(value)) return 0
  return Math.round(value * 1000) / 1000
}

function parseArgs(argv) {
  const kv = new Map()
  for (const token of argv) {
    if (!token.startsWith('--')) continue
    const eq = token.indexOf('=')
    if (eq > 0) {
      kv.set(token.slice(2, eq), token.slice(eq + 1))
    }
  }
  return kv
}

/**
 * 评估相对回归门禁（单一事实源，供 stats.ts 与 CLI 共同复用）
 */
export function evaluateRelativeRegressionReport(current, baseline, options = {}) {
  const thresholdRatio = options.maxRegressionRatio ?? 0.1
  const minFloorMs = options.minFloorMs ?? 5
  const requestedScope = options.scope ?? 'auto'
  const resolvedScope =
    requestedScope !== 'auto'
      ? requestedScope
      : current.mode === 'pr'
        ? 'pr'
        : current.mode === 'custom'
          ? 'auto'
          : 'nightly'

  const requiredScenarios =
    resolvedScope === 'pr'
      ? ['sync-10k']
      : resolvedScope === 'auto'
        ? Object.keys(current.scenarios || {})
        : ['sync-10k', 'dup-50k', 'batch-1k']

  const missingScenarios = []
  const comparisons = []
  const failures = []

  if (requiredScenarios.length === 0) {
    failures.push('当前报告未包含任何可执行门禁校验的场景')
  }

  for (const scenarioId of requiredScenarios) {
    const currScenario = current.scenarios?.[scenarioId]
    const baseScenario = baseline.scenarios?.[scenarioId]

    if (!currScenario) {
      missingScenarios.push(scenarioId)
      failures.push(`当前报告缺少必需场景: ${scenarioId}`)
      continue
    }
    if (!baseScenario) {
      missingScenarios.push(scenarioId)
      failures.push(`基线报告缺少对比场景: ${scenarioId}`)
      continue
    }

    const pairs = [
      {
        metric: 'durationMs.medianMs',
        baseVal: baseScenario.durationMs?.medianMs,
        currVal: currScenario.durationMs?.medianMs
      },
      {
        metric: 'latency.p99Ms',
        baseVal: baseScenario.latency?.p99Ms,
        currVal: currScenario.latency?.p99Ms
      }
    ]

    for (const pair of pairs) {
      if (
        typeof pair.baseVal !== 'number' ||
        !Number.isFinite(pair.baseVal) ||
        pair.baseVal < 0 ||
        typeof pair.currVal !== 'number' ||
        !Number.isFinite(pair.currVal) ||
        pair.currVal < 0
      ) {
        comparisons.push({
          scenarioId,
          metric: pair.metric,
          baselineValue: Number.isFinite(pair.baseVal) ? pair.baseVal : -1,
          currentValue: Number.isFinite(pair.currVal) ? pair.currVal : -1,
          regressionRatio: 0,
          thresholdRatio,
          passed: false
        })
        failures.push(
          `[${scenarioId}] ${pair.metric} 指标数值非法或缺失 (baseline=${String(pair.baseVal)}, current=${String(pair.currVal)})`
        )
        continue
      }

      const absDeltaMs = pair.currVal - pair.baseVal
      // 仅当基线与绝对增长幅度均处于抗噪地板内时才免除百分比抖动误报，防止低基线劣化百倍逃逸
      if (pair.baseVal <= minFloorMs && absDeltaMs <= minFloorMs) {
        comparisons.push({
          scenarioId,
          metric: pair.metric,
          baselineValue: pair.baseVal,
          currentValue: pair.currVal,
          regressionRatio: 0,
          thresholdRatio,
          passed: true,
          skippedReason: `基线 ${pair.baseVal}ms 且绝对增幅 ${roundMs(absDeltaMs)}ms <= 抗噪地板 ${minFloorMs}ms`
        })
        continue
      }

      if (pair.baseVal === 0) {
        const ratioFallback = 999
        comparisons.push({
          scenarioId,
          metric: pair.metric,
          baselineValue: 0,
          currentValue: pair.currVal,
          regressionRatio: ratioFallback,
          thresholdRatio,
          passed: false
        })
        failures.push(
          `[${scenarioId}] ${pair.metric} 基线为 0ms 但当前劣化至 ${pair.currVal}ms (> 抗噪地板 ${minFloorMs}ms)`
        )
        continue
      }

      const ratio = absDeltaMs / pair.baseVal
      const passed = ratio <= thresholdRatio
      comparisons.push({
        scenarioId,
        metric: pair.metric,
        baselineValue: pair.baseVal,
        currentValue: pair.currVal,
        regressionRatio: Math.round(ratio * 10000) / 10000,
        thresholdRatio,
        passed
      })

      if (!passed) {
        const pct = (ratio * 100).toFixed(2)
        const limitPct = (thresholdRatio * 100).toFixed(2)
        failures.push(
          `[${scenarioId}] ${pair.metric} 相对劣化 ${pct}% > 门禁阈值 ${limitPct}% (baseline=${pair.baseVal}ms, current=${pair.currVal}ms)`
        )
      }
    }
  }

  return {
    passed: failures.length === 0,
    scope: resolvedScope,
    thresholdRatio,
    checkedScenarios: requiredScenarios,
    missingScenarios,
    comparisons,
    failures
  }
}

/**
 * 对比开启延迟注入与关闭延迟注入的两组报告（单一事实源，供 stats.ts 与 run-bench.mjs 复用）
 */
export function compareDelayInjectionReports(withDelay, withoutDelay) {
  const scenarios = {}
  const delayOnConfigured = typeof withDelay.environment?.delayMs === 'number' && withDelay.environment.delayMs > 0
  const delayOffConfigured = withoutDelay.environment?.delayMs === 0
  let allPassed = delayOnConfigured && delayOffConfigured
  let matchedAny = false

  for (const key of Object.keys(withDelay.scenarios || {})) {
    const onSc = withDelay.scenarios[key]
    const offSc = withoutDelay.scenarios?.[key]
    if (!onSc || !offSc) continue
    matchedAny = true

    const deltaP99Ms = roundMs(onSc.latency.p99Ms - offSc.latency.p99Ms)
    const deltaDurationMs = roundMs(onSc.durationMs.medianMs - offSc.durationMs.medianMs)
    const syncIoExists = onSc.syncIo.totalCount > 0

    // 同步 I/O 场景中要求关闭延迟后的 p99 与同步阻塞总耗时同时明显更低
    const networkDiskSimulated =
      delayOnConfigured &&
      delayOffConfigured &&
      (syncIoExists
        ? deltaP99Ms > 0 && onSc.syncIo.totalMs > offSc.syncIo.totalMs
        : deltaDurationMs >= 0)

    if (!networkDiskSimulated) {
      allPassed = false
    }

    scenarios[key] = {
      scenarioId: key,
      delayOnP99Ms: onSc.latency.p99Ms,
      delayOffP99Ms: offSc.latency.p99Ms,
      deltaP99Ms,
      delayOnDurationMs: onSc.durationMs.medianMs,
      delayOffDurationMs: offSc.durationMs.medianMs,
      deltaDurationMs,
      delayOnSyncIoMs: onSc.syncIo.totalMs,
      delayOffSyncIoMs: offSc.syncIo.totalMs,
      networkDiskSimulated
    }
  }

  return {
    delayMs: withDelay.environment?.delayMs ?? 0,
    passed: matchedAny && allPassed,
    scenarios
  }
}

function runCli() {
  const args = parseArgs(process.argv.slice(2))
  const currentPath = args.get('current')
  const baselinePath = args.get('baseline')

  if (!currentPath || !baselinePath) {
    console.error(
      '用法: node scripts/bench/ci-regression-gate.mjs --current=<json> --baseline=<json> [--scope=pr|nightly|auto] [--threshold=0.10]'
    )
    process.exit(2)
  }

  const thresholdRaw = args.get('threshold')
  const threshold = thresholdRaw !== undefined ? Number(thresholdRaw) : 0.1
  if (!Number.isFinite(threshold) || threshold < 0) {
    console.error(`[ci-regression-gate] 非法 --threshold 参数: ${thresholdRaw}`)
    process.exit(2)
  }

  const minFloorRaw = args.get('min-floor-ms')
  const minFloorMs = minFloorRaw !== undefined ? Number(minFloorRaw) : 5
  if (!Number.isFinite(minFloorMs) || minFloorMs < 0) {
    console.error(`[ci-regression-gate] 非法 --min-floor-ms 参数: ${minFloorRaw}`)
    process.exit(2)
  }

  const scope = args.get('scope') ?? 'auto'
  if (scope !== 'pr' && scope !== 'nightly' && scope !== 'auto') {
    console.error(`[ci-regression-gate] 非法 --scope 参数: ${scope}`)
    process.exit(2)
  }

  const current = JSON.parse(fs.readFileSync(path.resolve(currentPath), 'utf8'))
  const baseline = JSON.parse(fs.readFileSync(path.resolve(baselinePath), 'utf8'))

  const result = evaluateRelativeRegressionReport(current, baseline, {
    maxRegressionRatio: threshold,
    minFloorMs,
    scope
  })

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exit(result.passed ? 0 : 1)
}

if (
  process.argv[1] &&
  path.basename(process.argv[1]) === 'ci-regression-gate.mjs' &&
  !process.env.VITEST
) {
  runCli()
}
