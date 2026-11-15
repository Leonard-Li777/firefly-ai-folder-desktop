#!/usr/bin/env node
/**
 * 分析队列阻塞维度树 API —— 事件循环阻塞量化基准（方案 C：已知批次 + 并发探针）
 *
 * 测量目标：
 *   一段同步 CPU 工作流（模拟分析队列 CPU 提取的指纹/压缩计算）在主进程单线程
 *   事件循环上执行时，同进程内一次「API 探针调用」从提交到被执行要等多久。
 *   这段等待时间即维度树 API 在 CPU 提取期间无法被调度而增加的延迟。
 *
 * 干净设计：
 *   - baseline：CPU 连续执行 TOTAL_BATCH 次哈希，期间【绝不】让出事件循环。
 *               探针任务在 CPU 启动瞬间 setImmediate 排队；其 t1-t0 即被堵时长。
 *   - yield   ：把 TOTAL_BATCH 拆成 UNIT 个单元，每单元后 setImmediate 让出。
 *               探针可趁机被调度，t1-t0 显著缩短。
 *
 * 两种模式跑【完全相同】的 CPU 总量，唯一差异是让渡频率，因此延迟差异全部来自让渡。
 *
 * 产出：P50/P95/P99/max 探针延迟、阻塞帧占比、改善幅度（重复 TRIALS 次取分布）。
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

function parseArgs(argv) {
  const out = {}
  for (const a of argv) {
    const m = /^--([\w-]+)(?:=(.*))?$/.exec(a)
    if (!m) continue
    out[m[1]] = m[2] === undefined ? true : m[2]
  }
  return out
}
const args = parseArgs(process.argv.slice(2))

const TOTAL_BATCH  = Number(args['total-batch']  ?? 240000)  // 单次 CPU 总量（哈希次数）
const YIELD_UNITS  = Number(args['yield-units']  ?? 48)       // 让渡模式拆成多少单元
const PLAN_A_EVERY = Number(args['plan-a-every'] ?? 4)        // 方案A：每 N 单元让渡一次
const TRIALS       = Number(args['trials'] ?? 20)             // 每模式重复次数
const WARMUP       = Number(args['warmup'] ?? 5000)           // JIT 预热哈希次数
const FRAME_MS     = 16.7                                     // 一帧/一次 IPC 往返阈值

function cpuHashes(n) {
  let acc = 0
  for (let i = 0; i < n; i++) {
    const h = createHash('sha256')
    h.update(`analysis-queue-cpu-extract-${i}`)
    acc ^= h.digest()[0]
  }
  return acc
}

// 预热
cpuHashes(WARMUP)

function pct(sorted, p) {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}

function summarize(arr, label) {
  const s = [...arr].sort((a, b) => a - b)
  const n = s.length
  const sum = s.reduce((a, b) => a + b, 0)
  let blocked = 0
  for (const v of s) if (v > FRAME_MS) blocked++
  return {
    label,
    trials: n,
    p50:  +pct(s, 50).toFixed(2),
    p95:  +pct(s, 95).toFixed(2),
    p99:  +pct(s, 99).toFixed(2),
    max:  +(s[n - 1] ?? 0).toFixed(2),
    mean: +(n > 0 ? sum / n : 0).toFixed(2),
    blockedOverFrame: blocked,
    blockedOverFrameRatio: n > 0 ? +(blocked / n).toFixed(4) : 0
  }
}

// —— baseline：一整段同步 CPU，期间不让出事件循环，探针被堵到 CPU 结束 ——
async function measureBaselineOnce() {
  const t0 = performance.now()
  let probeDone = false
  // 探针：setImmediate 排队，执行时记录 t1
  const probe = new Promise(resolve => {
    setImmediate(() => {
      const t1 = performance.now()
      resolve(t1 - t0)
      probeDone = true
    })
  })
  // CPU：同步跑完，期间事件循环被完全占据
  cpuHashes(TOTAL_BATCH)
  await new Promise(r => setImmediate(r)) // 确保探针回调有机会执行
  const d = await probe
  return d
}

// —— plan_c：CPU 拆成 UNIT 段，每段后让出，探针可被调度（方案 C 每单元让渡） ——
async function measureYieldOnce() {
  const t0 = performance.now()
  let probeDelay = null
  const probe = new Promise(resolve => {
    setImmediate(() => {
      const t1 = performance.now()
      probeDelay = t1 - t0
      resolve(probeDelay)
    })
  })
  const per = Math.ceil(TOTAL_BATCH / YIELD_UNITS)
  for (let u = 0; u < YIELD_UNITS; u++) {
    cpuHashes(per)
    await new Promise(r => setImmediate(r)) // 每单元后让出，探针得以插队
  }
  const d = await probe
  return d
}

// —— plan_a：CPU 拆成 UNIT 段，每 PLAN_A_EVERY 段才让一次（方案 A 分片让渡） ——
async function measurePlanAOnce() {
  const t0 = performance.now()
  let probeDelay = null
  const probe = new Promise(resolve => {
    setImmediate(() => {
      const t1 = performance.now()
      probeDelay = t1 - t0
      resolve(probeDelay)
    })
  })
  const per = Math.ceil(TOTAL_BATCH / YIELD_UNITS)
  for (let u = 0; u < YIELD_UNITS; u++) {
    cpuHashes(per)
    if (u % PLAN_A_EVERY === 0) await new Promise(r => setImmediate(r)) // 每 N 单元让渡
  }
  const d = await probe
  return d
}

/**
 * 场景：测量"让渡点自身成本"—— setImmediate 让渡在有 / 无竞争两种情况下的开销。
 *
 * - idle-yield-cost：事件循环完全空闲时，一次 await setImmediate 让渡的耗时。
 *   若趋近于 0，说明"没有其他任务时让渡几乎免费"，即方案 A 能"全功率运行"。
 * - contended-yield-cost：有高频竞争任务排队时，让渡点的耗时（反映让出给了竞争者）。
 *   该值越高说明让出得越充分——正是"有活就让"的体现。
 */
async function measureIdleYieldCost(trials) {
  const costs = []
  for (let i = 0; i < trials; i++) {
    const t0 = performance.now()
    await new Promise(r => setImmediate(r))
    costs.push(performance.now() - t0)
  }
  return costs
}

// 制造持续竞争：一个 busy loop 不断 setImmediate 自我重排，模拟"队列 CPU 提取在跑"
async function measureContendedYieldCost(trials) {
  const costs = []
  let contending = true
  const contender = (async () => {
    while (contending) {
      cpuHashes(2000)                      // 占据一小段事件循环
      await new Promise(r => setImmediate(r)) // 再自我重排，持续竞争
    }
  })()
  // 给竞争者一点时间先跑起来
  await new Promise(r => setTimeout(r, 20))
  for (let i = 0; i < trials; i++) {
    const t0 = performance.now()
    await new Promise(r => setImmediate(r))
    costs.push(performance.now() - t0)
  }
  contending = false
  await contender
  return costs
}

async function main() {
  // 空闲对照：无 CPU 队列时探针延迟
  const idleDelays = []
  for (let i = 0; i < Math.min(TRIALS, 10); i++) {
    const t0 = performance.now()
    await new Promise(r => setImmediate(r))
    idleDelays.push(performance.now() - t0)
  }

  console.error(`[bench] baseline：${TRIALS} 次单段同步 CPU（${TOTAL_BATCH} 哈希/次），并发探针测堵时...`)
  const baselineDelays = []
  for (let i = 0; i < TRIALS; i++) {
    baselineDelays.push(await measureBaselineOnce())
  }

  console.error(`[bench] plan_c：${TRIALS} 次（${YIELD_UNITS} 单元/次，每单元 setImmediate 让渡）...`)
  const planCDelays = []
  for (let i = 0; i < TRIALS; i++) {
    planCDelays.push(await measureYieldOnce())
  }

  console.error(`[bench] plan_a：${TRIALS} 次（${YIELD_UNITS} 单元/次，每 ${PLAN_A_EVERY} 单元 setImmediate 让渡）...`)
  const planADelays = []
  for (let i = 0; i < TRIALS; i++) {
    planADelays.push(await measurePlanAOnce())
  }

  const si = summarize(idleDelays, 'idle-no-queue')
  const sb = summarize(baselineDelays, 'baseline-continuous-cpu')
  const sc = summarize(planCDelays, 'yield-every-unit-plan-c')
  const sa = summarize(planADelays, 'yield-every-n-units-plan-a')
  const improveCP99 = sb.p99 > 0 ? ((sb.p99 - sc.p99) / sb.p99) * 100 : 0
  const improveCMax = sb.max > 0 ? ((sb.max - sc.max) / sb.max) * 100 : 0
  const improveAP99 = sb.p99 > 0 ? ((sb.p99 - sa.p99) / sb.p99) * 100 : 0
  const improveAMax = sb.max > 0 ? ((sb.max - sa.max) / sb.max) * 100 : 0

  // 让渡点自身成本：验证"无竞争时几乎免费 / 有竞争时确实让出"
  const IDLE_TRIALS = 500
  const idleYieldCosts = await measureIdleYieldCost(IDLE_TRIALS)
  const contendedYieldCosts = await measureContendedYieldCost(200)
  const idleYield = summarize(idleYieldCosts, 'idle-yield-cost-no-contention')
  const contendedYield = summarize(contendedYieldCosts, 'contended-yield-cost-with-contention')

  const result = {
    yieldPointOverhead: {
      idleNoContention: idleYield,
      contendedWithContention: contendedYield,
      note: 'idle=事件循环空闲时一次 setImmediate 让渡的耗时(反映全功率运行成本); contended=有竞争任务排队时的耗时(反映让出幅度)'
    },
    meta: {
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      method: '并发探针：CPU 流占事件循环；探针在 CPU 启动瞬间 setImmediate 排队，测 t1-t0 即被堵时长。baseline=绝不让渡 / plan-c=每单元让渡 / plan-a=每N单元让渡',
      params: { totalBatch: TOTAL_BATCH, yieldUnits: YIELD_UNITS, planAEvery: PLAN_A_EVERY, trials: TRIALS, warmup: WARMUP, frameThresholdMs: FRAME_MS }
    },
    idle: si,
    baseline: sb,
    planC: sc,
    planA: sa,
    improvement: {
      planC: { p99ReductionPercent: +improveCP99.toFixed(2), maxReductionPercent: +improveCMax.toFixed(2) },
      planA: { p99ReductionPercent: +improveAP99.toFixed(2), maxReductionPercent: +improveAMax.toFixed(2) }
    }
  }

  if (typeof args.json === 'string') {
    const outPath = path.resolve(args.json)
    const dir = path.dirname(outPath)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2))
    console.error(`[bench] JSON 已写出: ${outPath}`)
  } else {
    process.stdout.write(JSON.stringify(result, null, 2))
  }
}

main().catch(err => {
  console.error('[bench] 失败:', err)
  process.exit(1)
})
