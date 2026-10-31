import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 源码契约护栏：宿主重启后必须主动拉起推理服务（2026-10-30 事故）
 *
 * 事故链路（交叉 desktop / engine / llama-server 三份日志还原）：
 * 11:22:48 宿主被 taskkill → 11:22:53 新宿主启动并监听 38400 → 之后 **87 分钟零次**
 * `start_engine_service`，每 5 分钟一次 503「AI engine is starting」→ 12:50:16 用户
 * 手动打开引擎面板才恢复。
 *
 * 判定逻辑已抽到 `service-start-policy.ts`（真值表见 `engine-service-start-policy.test.ts`），
 * 本文件只锁「判定是否真的被接进了启动路径」——判定对但没接线，事故照样复现。
 *
 * 三个盲区导致旧代码「探活成功就 return true」：
 * ① `ensureRunning` 探活命中即返回 true；
 * ② `doStart` 的 `waitForReady` 只要 `/api/engine/status` 可响应就 true（`stopped` 也算）；
 * ③ `checkBinaryUpdated` 先 `killOwnProcess()` 会命中 `'self-kill'` 抑制 crash-heal，无法补位。
 */
const servicePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'engine-bridge-service.ts'
)

const source = readFileSync(servicePath, 'utf-8')

/** 取 `start = 某个方法签名` 到下一个同级 `\n  }` 之间的方法体（粗略但足够做顺序断言） */
function methodBody(signature: string): string {
  const start = source.indexOf(signature)
  expect(start, `未找到方法签名：${signature}`).toBeGreaterThan(-1)
  const end = source.indexOf('\n  }\n', start)
  expect(end, `未找到方法体结尾：${signature}`).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('判定逻辑必须委托纯模块（不得内联分叉）', () => {
  it('服务文件必须 import 纯模块的判定函数', () => {
    expect(source).toMatch(
      /import\s*\{\s*isServiceUsableStatus,\s*shouldTriggerServiceStartAt\s*\}\s*from\s*'\.\/service-start-policy'/
    )
  })

  it('不得把状态集合 / 节流常量搬回服务文件（搬回即脱离真值表覆盖）', () => {
    expect(source).not.toMatch(/const SERVICE_USABLE_STATUSES/)
    expect(source).not.toMatch(/const SERVICE_TRIGGERABLE_STATUS/)
    expect(source).not.toMatch(/const IMPLICIT_START_MIN_INTERVAL_MS/)
  })

  it('isServiceUsable 必须走纯函数，不得内联状态字面量比较', () => {
    const body = methodBody('private isServiceUsable(')
    expect(body).toMatch(/return isServiceUsableStatus\(status\?\.status\)/)
    expect(body).not.toMatch(/===\s*'ready'/)
  })
})

describe('收口点覆盖：三处启动路径都必须触发推理服务启动', () => {
  it('triggerServiceStartIfNeeded 的调用点不得少于 4 处（ensureRunning / start / doStart 探活命中 / doStart spawn 后）', () => {
    // 只数 `this.` 前缀，天然排除方法自身定义那一处
    const calls = source.match(/this\.triggerServiceStartIfNeeded\(/g) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(4)
  })

  it('【核心】doStart 必须在 armStableReset 之后收口（新宿主的推理服务是 stopped）', () => {
    const armIndex = source.indexOf('this.armStableReset()')
    const triggerIndex = source.indexOf('this.triggerServiceStartIfNeeded(true)', armIndex)
    expect(armIndex).toBeGreaterThan(-1)
    expect(triggerIndex).toBeGreaterThan(armIndex)
    // 两者必须同在 `finalAlive || alreadyUp` 分支内，且早于 return
    const guardIndex = source.lastIndexOf('if (finalAlive || alreadyUp)', armIndex)
    expect(guardIndex).toBeGreaterThan(-1)
    expect(guardIndex).toBeLessThan(armIndex)
    const returnIndex = source.indexOf('return finalAlive || alreadyUp', triggerIndex)
    expect(returnIndex).toBeGreaterThan(triggerIndex)
  })

  it('start() 复用在世宿主时，不可用必须补触发（不得直接 return true）', () => {
    const body = methodBody('public async start(): Promise<boolean>')
    // 必须把刚探到的 status 传进收口方法，不得让收口方法去读可能已被 applyOffline 置空的缓存
    expect(body).toMatch(
      /if \(!this\.isServiceUsable\(status\)\) \{\s*this\.triggerServiceStartIfNeeded\(true, status\)/
    )
  })

  it('doStart 探活命中复用时，不可用必须补触发', () => {
    const body = methodBody('private async doStart(): Promise<boolean>')
    expect(body).toMatch(
      /if \(!this\.isServiceUsable\(alive\)\) \{\s*this\.triggerServiceStartIfNeeded\(true, alive\)/
    )
  })

  it('收口方法必须接受调用方传入的 status（不得只读 lastRawStatus 判定）', () => {
    const body = methodBody('private triggerServiceStartIfNeeded(')
    expect(body).toMatch(/status\?: Tier2EngineStatus \| null/)
    expect(body).toMatch(/const effective = status \?\? this\.lastRawStatus/)
    expect(body).toMatch(/shouldTriggerServiceStart\(effective, \{ explicit \}\)/)
  })

  it('ensureRunning 命中分支必须按 status 分层，不得「可响应即可用」', () => {
    const body = methodBody('public async ensureRunning(')
    const usableIndex = body.indexOf('this.isServiceUsable(status)')
    const triggerIndex = body.indexOf('this.shouldTriggerServiceStart(status, { explicit })')
    expect(usableIndex).toBeGreaterThan(-1)
    expect(triggerIndex).toBeGreaterThan(usableIndex)
  })
})

describe('ensureRunning 状态分层：error 必须诚实降级', () => {
  it('error 态返回 false（不得谎报引擎在线，交由 Tier 1 兜底）', () => {
    const body = methodBody('public async ensureRunning(')
    const errorIndex = body.indexOf("if (status.status === 'error')")
    expect(errorIndex).toBeGreaterThan(-1)
    const falseIndex = body.indexOf('return false', errorIndex)
    expect(falseIndex).toBeGreaterThan(errorIndex)
    // 该分支内不得出现 return true
    const nextClose = body.indexOf('return true', errorIndex)
    expect(nextClose === -1 || nextClose > falseIndex).toBe(true)
  })

  it('force 必须清零隐式节流窗口（否则用户点启动被挡住且表现为「没反应」）', () => {
    const body = methodBody('public async ensureRunning(')
    const forceIndex = body.indexOf('if (options?.force)')
    const resetIndex = body.indexOf('this.lastImplicitStartAt = 0', forceIndex)
    expect(forceIndex).toBeGreaterThan(-1)
    expect(resetIndex).toBeGreaterThan(forceIndex)
  })
})

describe('startService 并发语义：同意图合并 + 跨意图串行', () => {
  it('单飞 key 必须同时包含 mode 与 modelId（否则 embedding 会拿到 language 的 Promise）', () => {
    const body = methodBody('public async startService(')
    expect(body).toMatch(/const key = `\$\{options\?\.mode \?\? 'auto'\}\|\$\{options\?\.modelId \?\? ''\}`/)
    expect(body).toMatch(/this\.startServiceInFlight\.get\(key\)/)
  })

  it('不同意图必须挂在串行链上（并发会让引擎 Starting 态虚假成功）', () => {
    const body = methodBody('public async startService(')
    expect(body).toMatch(/const task = this\.startServiceChain\.then\(\(\) => this\.doStartService\(options\)\)/)
  })

  it('串行链必须吞掉 Reject（一次失败不得毒化后续所有启动）', () => {
    const body = methodBody('public async startService(')
    expect(body).toMatch(/this\.startServiceChain = task\.then\(/)
    expect(body).toMatch(/\(\) => undefined,\s*\(\) => undefined/)
  })

  it('在途表清理必须做身份校验（旧 Promise 晚 settle 不得误删新条目）', () => {
    const body = methodBody('public async startService(')
    expect(body).toMatch(/if \(this\.startServiceInFlight\.get\(key\) === task\) \{/)
  })
})

describe('宿主消失时必须清空在途启动表', () => {
  it('killOwnProcess 清空 inFlight，且不重置串行链引用', () => {
    const body = methodBody('private killOwnProcess(): void')
    expect(body).toMatch(/this\.startServiceInFlight\.clear\(\)/)
    expect(body).not.toMatch(/this\.startServiceChain\s*=/)
  })

  it('exit 处理器清空 inFlight（宿主已死，在途请求必然失败）', () => {
    // exit 处理器内的 clear 与 killOwnProcess 内的 clear 合计 ≥ 2 处
    const clears = source.match(/this\.startServiceInFlight\.clear\(\)/g) ?? []
    expect(clears.length).toBeGreaterThanOrEqual(2)
  })
})

describe('新宿主拉起前必须复位隐式节流窗口', () => {
  it('doStart spawn 之前清零 lastImplicitStartAt（新进程 ⇒ 新窗口）', () => {
    const body = methodBody('private async doStart(): Promise<boolean>')
    const spawnIndex = body.indexOf('const child = spawn(')
    const resetIndex = body.indexOf('this.lastImplicitStartAt = 0')
    expect(spawnIndex).toBeGreaterThan(-1)
    expect(resetIndex).toBeGreaterThan(-1)
    expect(resetIndex).toBeLessThan(spawnIndex)
  })
})
