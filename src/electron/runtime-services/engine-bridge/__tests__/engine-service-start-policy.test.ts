/**
 * Tier 2 推理服务判定策略真值表（2026-10-30 事故）
 *
 * 事故：desktop 重启后宿主进程是新的，`/api/engine/status` 立刻可响应但 status=`stopped`，
 * 推理服务从未启动 ⇒ 引擎侧 `target_port = None` ⇒ 所有 `/v1/*` 被反代 503
 * 「AI engine is starting, please try again」，持续 87 分钟无人拉起。
 *
 * 本护栏锁定两条不可回退的口径：
 * 1. 「宿主 HTTP 可响应」≠「推理服务可用」：`stopped` / `error` 一律不可用；
 * 2. `stopped` 必须被隐式拉起（带节流），`error` 只允许显式重试（不得形成重试风暴）。
 */

import { describe, it, expect } from 'vitest'
import {
  IMPLICIT_START_MIN_INTERVAL_MS,
  isServiceUsableStatus,
  shouldTriggerServiceStartAt
} from '../service-start-policy'

describe('isServiceUsableStatus：可用口径', () => {
  it('ready / processing 可用', () => {
    expect(isServiceUsableStatus('ready')).toBe(true)
    expect(isServiceUsableStatus('processing')).toBe(true)
  })

  it('starting 视为可用（模型加载中，再发启动请求只会排队堆积并虚假成功）', () => {
    expect(isServiceUsableStatus('starting')).toBe(true)
  })

  it('stopped 不可用 —— 这是事故的核心误判点', () => {
    expect(isServiceUsableStatus('stopped')).toBe(false)
  })

  it('error 不可用', () => {
    expect(isServiceUsableStatus('error')).toBe(false)
  })

  it('缺失 / null / 未知字符串一律不可用（不得默认放行）', () => {
    expect(isServiceUsableStatus(undefined)).toBe(false)
    expect(isServiceUsableStatus(null)).toBe(false)
    expect(isServiceUsableStatus('')).toBe(false)
    expect(isServiceUsableStatus('RUNNING')).toBe(false)
  })
})

describe('shouldTriggerServiceStartAt：stopped 必须拉起', () => {
  const base = { status: 'stopped', now: 1_000_000, lastImplicitStartAt: 0, explicit: false }

  it('从未触发过 + 隐式 → 触发', () => {
    expect(shouldTriggerServiceStartAt(base)).toBe(true)
  })

  it('刚触发过 + 隐式 → 节流拦截', () => {
    expect(
      shouldTriggerServiceStartAt({
        ...base,
        lastImplicitStartAt: base.now - 1_000
      })
    ).toBe(false)
  })

  it('节流边界：间隔恰好等于窗口长度时允许触发', () => {
    expect(
      shouldTriggerServiceStartAt({
        ...base,
        lastImplicitStartAt: base.now - IMPLICIT_START_MIN_INTERVAL_MS
      })
    ).toBe(true)
  })

  it('节流边界前 1ms 仍拦截（保证边界判定不漂移）', () => {
    expect(
      shouldTriggerServiceStartAt({
        ...base,
        lastImplicitStartAt: base.now - IMPLICIT_START_MIN_INTERVAL_MS + 1
      })
    ).toBe(false)
  })

  it('显式意图穿透节流（用户点启动必须立即生效）', () => {
    expect(
      shouldTriggerServiceStartAt({
        ...base,
        explicit: true,
        lastImplicitStartAt: base.now - 1
      })
    ).toBe(true)
  })

  it('节流窗口长度不得小于 30s（过短等于探活风暴）', () => {
    expect(IMPLICIT_START_MIN_INTERVAL_MS).toBeGreaterThanOrEqual(30_000)
  })
})

describe('shouldTriggerServiceStartAt：error 只允许显式重试', () => {
  const base = { status: 'error', now: 1_000_000, lastImplicitStartAt: 0, explicit: false }

  it('隐式路径永不重试 error（否则每轮分析都会再启动一次）', () => {
    expect(shouldTriggerServiceStartAt(base)).toBe(false)
  })

  it('即使节流窗口已过，隐式路径仍不重试 error', () => {
    expect(
      shouldTriggerServiceStartAt({
        ...base,
        lastImplicitStartAt: base.now - IMPLICIT_START_MIN_INTERVAL_MS * 10
      })
    ).toBe(false)
  })

  it('显式路径允许对 error 重试（否则「启动」按钮永久失效）', () => {
    expect(shouldTriggerServiceStartAt({ ...base, explicit: true })).toBe(true)
  })
})

describe('shouldTriggerServiceStartAt：可用态与未知态不得触发', () => {
  const base = { now: 1_000_000, lastImplicitStartAt: 0, explicit: false }

  it.each(['ready', 'processing', 'starting'])('%s 下不触发（含显式）', (status) => {
    expect(shouldTriggerServiceStartAt({ ...base, status })).toBe(false)
    expect(shouldTriggerServiceStartAt({ ...base, status, explicit: true })).toBe(false)
  })

  it('status 缺失 / null 不触发', () => {
    expect(shouldTriggerServiceStartAt({ ...base, status: undefined })).toBe(false)
    expect(shouldTriggerServiceStartAt({ ...base, status: null })).toBe(false)
    expect(shouldTriggerServiceStartAt({ ...base, status: undefined, explicit: true })).toBe(false)
  })

  it('未知字符串不触发（不得靠兜底放行）', () => {
    expect(shouldTriggerServiceStartAt({ ...base, status: 'whatever' })).toBe(false)
    expect(shouldTriggerServiceStartAt({ ...base, status: 'whatever', explicit: true })).toBe(
      false
    )
  })
})
