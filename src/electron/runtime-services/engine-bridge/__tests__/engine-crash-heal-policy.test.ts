/**
 * 引擎崩溃自愈策略护栏（2026-10-22 事故）
 *
 * 事故：分析中 firefly-ai-engine.exe 以 0xC0000005 崩溃（Windows 事件 1000 可查），
 * exit 处理器只标记离线，队列 166 个文件全批连接被拒，用户手动点开引擎面板才恢复。
 *
 * 本护栏锁定三条不可回退的口径：
 * 1. 真崩溃必须自愈，且延迟不得为 0（崩溃残留条件需要时间释放）；
 * 2. 同一崩溃窗口只治愈一次，再失败交回队列原有 failed 路径（不阻塞 CPU 阶段）；
 * 3. 主动 kill（停止服务 / 切换引擎 / 退出应用）与二进制热部署不得触发自愈。
 */

import { describe, it, expect } from 'vitest'
import {
  CRASH_HEAL_DELAY_MS,
  CRASH_HEAL_MAX_ATTEMPTS,
  SELF_KILL_SUPPRESS_MS,
  decideCrashHeal
} from '../crash-heal-policy'

const base = {
  msSinceSelfKill: null as number | null,
  deploying: false,
  attempts: 0,
  shouldRun: true
}

describe('decideCrashHeal：真崩溃自愈', () => {
  it('首次非预期退出 → 自愈，且延迟显著大于 0', () => {
    const decision = decideCrashHeal(base)
    expect(decision.heal).toBe(true)
    if (!decision.heal) return
    expect(decision.delayMs).toBe(CRASH_HEAL_DELAY_MS)
    expect(decision.delayMs).toBeGreaterThanOrEqual(5000)
    expect(decision.nextAttempts).toBe(1)
  })

  it('已治愈过一次仍崩溃 → 放弃（交回队列 failed 逻辑，不阻塞 CPU 阶段）', () => {
    const decision = decideCrashHeal({ ...base, attempts: CRASH_HEAL_MAX_ATTEMPTS })
    expect(decision).toEqual({ heal: false, reason: 'exhausted' })
  })
})

describe('decideCrashHeal：主动行为不得触发自愈', () => {
  it('用户点「停止服务」后的退出（抑制窗口内）不自愈', () => {
    expect(decideCrashHeal({ ...base, msSinceSelfKill: 800 })).toEqual({
      heal: false,
      reason: 'self-kill'
    })
  })

  it('抑制窗口边界：刚好等于窗口长度时视为真实崩溃，允许自愈', () => {
    const decision = decideCrashHeal({ ...base, msSinceSelfKill: SELF_KILL_SUPPRESS_MS })
    expect(decision.heal).toBe(true)
  })

  it('二进制热部署导致的退出不自愈（部署流程自己会重启）', () => {
    expect(decideCrashHeal({ ...base, deploying: true })).toEqual({
      heal: false,
      reason: 'deploying'
    })
  })

  it('部署优先级高于其它条件（即使已超抑制窗口也不自愈）', () => {
    expect(
      decideCrashHeal({ ...base, deploying: true, msSinceSelfKill: 60000, attempts: 0 })
    ).toEqual({ heal: false, reason: 'deploying' })
  })
})

describe('decideCrashHeal：配置意图优先于消耗自愈配额', () => {
  it('高级AI引擎已禁用/云端模式 → 不自愈，且不消耗次数', () => {
    expect(decideCrashHeal({ ...base, shouldRun: false })).toEqual({
      heal: false,
      reason: 'engine-disabled'
    })
  })

  it('禁用态 + 已耗尽次数：仍报 engine-disabled（配置意图先判）', () => {
    expect(
      decideCrashHeal({ ...base, shouldRun: false, attempts: CRASH_HEAL_MAX_ATTEMPTS })
    ).toEqual({ heal: false, reason: 'engine-disabled' })
  })
})
