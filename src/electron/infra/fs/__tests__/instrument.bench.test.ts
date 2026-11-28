/**
 * 同步 I/O 插桩基准验证（`pnpm --filter desktop test:unit -- instrument` 会连同本文件一起跑）
 *
 * 目的：给出可复现的「插桩开销」与「计数稳定性」数字，供 M0 判断插桩本身是否显著扭曲基线。
 * 断言阈值取宽松上界（CI 机器负载波动大），数字以 `[BENCH]` 前缀 JSON 打印，便于 CI 日志采集。
 */
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  buildSyncIoReport,
  disableSyncIoInstrumentation,
  enableSyncIoInstrumentation,
  resetSyncIoStats
} from '../instrument'

const requireNode = createRequire(import.meta.url)
/** 未插桩基线迭代数 */
const BASELINE_ITERATIONS = 20_000
/** 插桩后迭代数（取栈开销明显，迭代数调小以免拖慢单测） */
const INSTRUMENTED_ITERATIONS = 2_000

let workDir = ''
let fixture = ''

function requireFs(): typeof import('node:fs') {
  return requireNode('node:fs') as typeof import('node:fs')
}

beforeEach(() => {
  disableSyncIoInstrumentation({ resetStats: true, preserveReason: true })
  resetSyncIoStats()
  workDir = mkdtempSync(join(tmpdir(), 'ff-sync-io-bench-'))
  fixture = join(workDir, 'probe.txt')
  writeFileSync(fixture, 'probe', 'utf8')
})

afterEach(() => {
  disableSyncIoInstrumentation({ resetStats: true, preserveReason: true })
  rmSync(workDir, { recursive: true, force: true })
})

it('基准：插桩单次调用开销与计数稳定性', () => {
  const fsApi = requireFs()

  // 预热（避免首次调用的 JIT/缓存效应污染基线）
  for (let index = 0; index < 200; index += 1) fsApi.existsSync(fixture)

  const baselineStartedAt = performance.now()
  for (let index = 0; index < BASELINE_ITERATIONS; index += 1) fsApi.existsSync(fixture)
  const baselineMs = performance.now() - baselineStartedAt
  const baselinePerCallMs = baselineMs / BASELINE_ITERATIONS

  expect(enableSyncIoInstrumentation({ delayMs: 0, countSync: true })).toBe(true)
  resetSyncIoStats()
  for (let index = 0; index < 200; index += 1) fsApi.existsSync(fixture)
  resetSyncIoStats()

  const instrumentedStartedAt = performance.now()
  for (let index = 0; index < INSTRUMENTED_ITERATIONS; index += 1) fsApi.existsSync(fixture)
  const instrumentedMs = performance.now() - instrumentedStartedAt
  const instrumentedPerCallMs = instrumentedMs / INSTRUMENTED_ITERATIONS

  const report = buildSyncIoReport()
  expect(report.totals.count).toBe(INSTRUMENTED_ITERATIONS)
  expect(report.totals.distinctCallSites).toBeGreaterThanOrEqual(1)

  const overheadPerCallMs = instrumentedPerCallMs - baselinePerCallMs
  console.log(
    `[BENCH] ${JSON.stringify({
      scenario: 'sync-io-instrument-overhead',
      iterations: INSTRUMENTED_ITERATIONS,
      baselinePerCallMs: Number(baselinePerCallMs.toFixed(4)),
      instrumentedPerCallMs: Number(instrumentedPerCallMs.toFixed(4)),
      overheadPerCallMs: Number(overheadPerCallMs.toFixed(4)),
      countedCalls: report.totals.count,
      distinctCallSites: report.totals.distinctCallSites
    })}`
  )

  // 放宽到 0.5ms/次：超过该量级说明取栈/聚合本身已扭曲基线，必须重新设计采样策略
  expect(overheadPerCallMs).toBeLessThan(0.5)
})

/** 预热 + 定次调用，返回单次平均耗时（毫秒）；预热用于抹掉 Electron 主进程首次循环的页入抖动 */
function measurePerCallMs(fsApi: ReturnType<typeof requireFs>, target: string, iterations: number): number {
  for (let index = 0; index < 1000; index += 1) fsApi.existsSync(target)
  const startedAt = performance.now()
  for (let index = 0; index < iterations; index += 1) fsApi.existsSync(target)
  return (performance.now() - startedAt) / iterations
}

it('基准：停用后逐次调用耗时回到原生水平（零额外开销）', () => {
  const fsApi = requireFs()

  // 原生基线取两次（插桩前后各一次），用较小值剔除首次测量的页入/调度抖动
  const nativeBeforeMs = measurePerCallMs(fsApi, fixture, BASELINE_ITERATIONS)

  expect(enableSyncIoInstrumentation({ delayMs: 0 })).toBe(true)
  for (let index = 0; index < 200; index += 1) fsApi.existsSync(fixture)
  disableSyncIoInstrumentation()

  const restoredPerCallMs = measurePerCallMs(fsApi, fixture, BASELINE_ITERATIONS)
  const nativeAfterMs = measurePerCallMs(fsApi, fixture, BASELINE_ITERATIONS)
  const baselinePerCallMs = Math.min(nativeBeforeMs, nativeAfterMs)

  console.log(
    `[BENCH] ${JSON.stringify({
      scenario: 'sync-io-instrument-restore',
      iterations: BASELINE_ITERATIONS,
      baselinePerCallMs: Number(baselinePerCallMs.toFixed(4)),
      restoredPerCallMs: Number(restoredPerCallMs.toFixed(4)),
      deltaPerCallMs: Number((restoredPerCallMs - baselinePerCallMs).toFixed(4))
    })}`
  )

  // 身份级还原后跑的是同一个原生函数，差异只应来自调度噪声；给 1.5 倍 + 0.01ms 的噪声余量
  expect(restoredPerCallMs).toBeLessThanOrEqual(baselinePerCallMs * 1.5 + 0.01)
})
