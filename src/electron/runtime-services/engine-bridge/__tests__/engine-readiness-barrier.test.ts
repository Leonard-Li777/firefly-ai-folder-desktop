/**
 * 零轮询 SSE 反应式就绪屏障纯函数单元测试（零 Electron 依赖）
 *
 * 覆盖 Spec §2.2、§3.2、§4.1.1 全部真值表与时序边界：
 * - matchesEngineTargetMode 模式匹配
 * - 先 subscribe 后 inspect getSnapshot() 顺序保证
 * - 同实例旧 revision / 旧 error 过滤
 * - 宿主重启切换 instance_id 归零 effectiveBaselineRevision
 * - kick 10s 无应答早败 kick_ack_timeout
 * - sawStarting → stopped/stopping 2s 防抖宽限（恢复取消 vs 超时早败）
 * - error + isAutoHealing() 不误早败 vs 非自愈/自愈耗尽立即早败
 * - AbortSignal 与全部退出路径零定时器/订阅泄漏
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_KICK_ACK_TIMEOUT_MS,
  DEFAULT_STOPPED_DEBOUNCE_MS,
  matchesEngineTargetMode,
  waitForEngineStatusReactive
} from '../engine-readiness-barrier'
import type { EngineBridgeSnapshot, Tier2EngineStatus } from '../engine-bridge-service/types'

function makeSnapshot(
  raw: Tier2EngineStatus | null,
  connected = true
): EngineBridgeSnapshot {
  return {
    connected,
    managed: true,
    circuitState: 'closed',
    available: true,
    exePath: null,
    devMode: false,
    port: 38400,
    version: '1.0.0',
    backend: 'cuda',
    backendMatchType: 'best',
    model: raw?.current_model ?? raw?.model ?? null,
    modelName: null,
    vramMb: null,
    modelCount: 1,
    totalModelCount: 1,
    lastError: null,
    updatedAt: Date.now(),
    raw
  }
}

function createFakeStatusSource(initial: EngineBridgeSnapshot) {
  let current = initial
  const listeners = new Set<(snap: EngineBridgeSnapshot) => void>()
  const events: string[] = []

  return {
    events,
    getListenerCount: () => listeners.size,
    subscribe(fn: (snap: EngineBridgeSnapshot) => void) {
      events.push('subscribe')
      listeners.add(fn)
      return () => {
        events.push('unsubscribe')
        listeners.delete(fn)
      }
    },
    getSnapshot() {
      events.push('getSnapshot')
      return current
    },
    push(next: EngineBridgeSnapshot) {
      current = next
      for (const fn of Array.from(listeners)) {
        fn(next)
      }
    }
  }
}

describe('matchesEngineTargetMode', () => {
  it('language 模式：常规语言模型或空模型名匹配，WeMM/Embedding 不匹配', () => {
    expect(matchesEngineTargetMode({ current_model: 'Qwen3-8B-Q4_K_M.gguf' }, 'language')).toBe(
      true
    )
    expect(matchesEngineTargetMode({ model: 'MiniCPM-V-4.6' }, 'language')).toBe(true)
    expect(matchesEngineTargetMode({}, 'language')).toBe(true)
    expect(matchesEngineTargetMode(null, 'language')).toBe(true)
    expect(matchesEngineTargetMode({ current_model: 'WeMM-7B-Q4.gguf' }, 'language')).toBe(false)
    expect(matchesEngineTargetMode({ model: 'bge-m3-embedding-q8.gguf' }, 'language')).toBe(false)
  })

  it('embedding 模式：仅包含 wemm 或 embedding（大小写无关）时匹配', () => {
    expect(matchesEngineTargetMode({ current_model: 'WeMM-7B-Q4.gguf' }, 'embedding')).toBe(true)
    expect(matchesEngineTargetMode({ model: 'EmbeddingGemma-300M' }, 'embedding')).toBe(true)
    expect(matchesEngineTargetMode({ current_model: 'Qwen3-8B-Q4_K_M.gguf' }, 'embedding')).toBe(
      false
    )
    expect(matchesEngineTargetMode(undefined, 'embedding')).toBe(false)
  })
})

describe('waitForEngineStatusReactive', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('严格先 subscribe 再 inspect getSnapshot，同步快照已 ready 时立即 resolve 且零泄漏', async () => {
    const source = createFakeStatusSource(
      makeSnapshot({
        status: 'ready',
        current_model: 'Qwen3-8B.gguf',
        revision: 3,
        instance_id: 'inst-1'
      })
    )

    const res = await waitForEngineStatusReactive({
      subscribe: fn => source.subscribe(fn),
      getSnapshot: () => source.getSnapshot(),
      isAutoHealing: () => false,
      isCrashHealExhausted: () => false,
      mode: 'language',
      baselineRevision: 3,
      baselineInstanceId: 'inst-1',
      timeoutMs: 120_000
    })

    expect(res).toEqual({ ok: true })
    expect(source.events.slice(0, 3)).toEqual(['subscribe', 'getSnapshot', 'unsubscribe'])
    expect(source.getListenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('同实例内过滤 revision 落后的乱序旧帧与同版本残留 error 帧，等到新 ready 后成功', async () => {
    const source = createFakeStatusSource(
      makeSnapshot({
        status: 'error',
        error: '旧失败',
        revision: 5,
        instance_id: 'inst-1'
      })
    )

    const promise = waitForEngineStatusReactive({
      subscribe: fn => source.subscribe(fn),
      getSnapshot: () => source.getSnapshot(),
      isAutoHealing: () => false,
      isCrashHealExhausted: () => false,
      mode: 'language',
      baselineRevision: 5,
      baselineInstanceId: 'inst-1',
      timeoutMs: 120_000
    })

    // 乱序旧帧 (revision 4 < 5) 携带 ready 与 error 均应被丢弃
    source.push(
      makeSnapshot({
        status: 'ready',
        current_model: 'Qwen3-8B.gguf',
        revision: 4,
        instance_id: 'inst-1'
      })
    )
    source.push(
      makeSnapshot({
        status: 'error',
        error: '同版本残留错误',
        revision: 5,
        instance_id: 'inst-1'
      })
    )

    // 确认仍在等待中
    let settled = false
    void promise.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    // 新版本 starting → ready
    source.push(makeSnapshot({ status: 'starting', revision: 6, instance_id: 'inst-1' }))
    source.push(
      makeSnapshot({
        status: 'processing',
        current_model: 'Qwen3-8B.gguf',
        revision: 7,
        instance_id: 'inst-1'
      })
    )

    expect(await promise).toEqual({ ok: true })
    expect(source.getListenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('宿主重启切换 instance_id 时立即归零 effectiveBaselineRevision，正常接收新宿主低版本号 ready', async () => {
    const source = createFakeStatusSource(
      makeSnapshot({
        status: 'stopped',
        revision: 42,
        instance_id: 'inst-old'
      })
    )

    const promise = waitForEngineStatusReactive({
      subscribe: fn => source.subscribe(fn),
      getSnapshot: () => source.getSnapshot(),
      isAutoHealing: () => false,
      isCrashHealExhausted: () => false,
      mode: 'language',
      baselineRevision: 42,
      baselineInstanceId: 'inst-old',
      timeoutMs: 120_000
    })

    // 新宿主重启，revision 从 1 重新计数
    source.push(makeSnapshot({ status: 'starting', revision: 1, instance_id: 'inst-new' }))
    source.push(
      makeSnapshot({
        status: 'ready',
        current_model: 'Qwen3-8B.gguf',
        revision: 2,
        instance_id: 'inst-new'
      })
    )

    expect(await promise).toEqual({ ok: true })
    expect(source.getListenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('kick 后 10s 内未进入 starting/ready 且停留在 stopped/stopping，早败 kick_ack_timeout', async () => {
    const source = createFakeStatusSource(
      makeSnapshot({
        status: 'stopped',
        revision: 1,
        instance_id: 'inst-1'
      })
    )

    const promise = waitForEngineStatusReactive({
      subscribe: fn => source.subscribe(fn),
      getSnapshot: () => source.getSnapshot(),
      isAutoHealing: () => false,
      isCrashHealExhausted: () => false,
      mode: 'language',
      baselineRevision: 1,
      baselineInstanceId: 'inst-1',
      timeoutMs: 120_000
    })

    await vi.advanceTimersByTimeAsync(DEFAULT_KICK_ACK_TIMEOUT_MS)

    const res = await promise
    expect(res.ok).toBe(false)
    expect(res.code).toBe('kick_ack_timeout')
    expect(source.getListenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sawStarting 后回落 stopped：2s 内恢复 starting 则取消防抖继续等到 ready', async () => {
    const source = createFakeStatusSource(
      makeSnapshot({ status: 'stopped', revision: 1, instance_id: 'inst-1' })
    )

    const promise = waitForEngineStatusReactive({
      subscribe: fn => source.subscribe(fn),
      getSnapshot: () => source.getSnapshot(),
      isAutoHealing: () => false,
      isCrashHealExhausted: () => false,
      mode: 'language',
      baselineRevision: 1,
      baselineInstanceId: 'inst-1',
      timeoutMs: 120_000
    })

    source.push(makeSnapshot({ status: 'starting', revision: 2, instance_id: 'inst-1' }))
    source.push(makeSnapshot({ status: 'stopped', revision: 3, instance_id: 'inst-1' }))

    // 1.5s 仍在宽限期内，切回 starting
    await vi.advanceTimersByTimeAsync(1_500)
    source.push(makeSnapshot({ status: 'starting', revision: 4, instance_id: 'inst-1' }))

    // 再过 5s 确认未被防抖误杀
    await vi.advanceTimersByTimeAsync(5_000)
    source.push(
      makeSnapshot({
        status: 'ready',
        current_model: 'Qwen3-8B.gguf',
        revision: 5,
        instance_id: 'inst-1'
      })
    )

    expect(await promise).toEqual({ ok: true })
    expect(source.getListenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sawStarting 后回落 stopped 超过 2s 未恢复，早败 process_exited_during_startup', async () => {
    const source = createFakeStatusSource(
      makeSnapshot({ status: 'stopped', revision: 1, instance_id: 'inst-1' })
    )

    const promise = waitForEngineStatusReactive({
      subscribe: fn => source.subscribe(fn),
      getSnapshot: () => source.getSnapshot(),
      isAutoHealing: () => false,
      isCrashHealExhausted: () => false,
      mode: 'language',
      baselineRevision: 1,
      baselineInstanceId: 'inst-1',
      timeoutMs: 120_000
    })

    source.push(makeSnapshot({ status: 'starting', revision: 2, instance_id: 'inst-1' }))
    source.push(makeSnapshot({ status: 'stopped', revision: 3, instance_id: 'inst-1' }))

    await vi.advanceTimersByTimeAsync(DEFAULT_STOPPED_DEBOUNCE_MS)

    const res = await promise
    expect(res.ok).toBe(false)
    expect(res.code).toBe('process_exited_during_startup')
    expect(source.getListenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('新版本 error 在 isAutoHealing() === true 时不误早败，自愈至 ready 后成功', async () => {
    let healing = true
    const source = createFakeStatusSource(
      makeSnapshot({ status: 'starting', revision: 2, instance_id: 'inst-1' })
    )

    const promise = waitForEngineStatusReactive({
      subscribe: fn => source.subscribe(fn),
      getSnapshot: () => source.getSnapshot(),
      isAutoHealing: () => healing,
      isCrashHealExhausted: () => false,
      mode: 'language',
      baselineRevision: 2,
      baselineInstanceId: 'inst-1',
      timeoutMs: 120_000
    })

    source.push(
      makeSnapshot({ status: 'error', error: '首次加载异常', revision: 3, instance_id: 'inst-1' })
    )

    let settled = false
    void promise.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    healing = false
    source.push(
      makeSnapshot({
        status: 'ready',
        current_model: 'Qwen3-8B.gguf',
        revision: 4,
        instance_id: 'inst-1'
      })
    )

    expect(await promise).toEqual({ ok: true })
    expect(source.getListenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('非自愈新版本 error 或 isCrashHealExhausted() === true 立即早败 engine_error', async () => {
    const source = createFakeStatusSource(
      makeSnapshot({ status: 'starting', revision: 2, instance_id: 'inst-1' })
    )

    const promise = waitForEngineStatusReactive({
      subscribe: fn => source.subscribe(fn),
      getSnapshot: () => source.getSnapshot(),
      isAutoHealing: () => false,
      isCrashHealExhausted: () => false,
      mode: 'language',
      baselineRevision: 2,
      baselineInstanceId: 'inst-1',
      timeoutMs: 120_000
    })

    source.push(
      makeSnapshot({ status: 'error', error: '显存不足', revision: 3, instance_id: 'inst-1' })
    )

    const res = await promise
    expect(res).toEqual({ ok: false, code: 'engine_error', error: '显存不足' })
    expect(source.getListenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)

    // isCrashHealExhausted() === true 立即早败
    const source2 = createFakeStatusSource(
      makeSnapshot({ status: 'stopped', revision: 1, instance_id: 'inst-1' }, false)
    )
    const res2 = await waitForEngineStatusReactive({
      subscribe: fn => source2.subscribe(fn),
      getSnapshot: () => source2.getSnapshot(),
      isAutoHealing: () => false,
      isCrashHealExhausted: () => true,
      mode: 'language',
      baselineRevision: 1,
      baselineInstanceId: 'inst-1',
      timeoutMs: 120_000
    })
    expect(res2.ok).toBe(false)
    expect(res2.code).toBe('engine_error')
    expect(source2.getListenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('AbortSignal 立即抛出 AbortError 且清理全部定时器、订阅与监听（零泄漏）', async () => {
    const controller = new AbortController()
    const source = createFakeStatusSource(
      makeSnapshot({ status: 'stopped', revision: 1, instance_id: 'inst-1' })
    )

    const promise = waitForEngineStatusReactive({
      subscribe: fn => source.subscribe(fn),
      getSnapshot: () => source.getSnapshot(),
      isAutoHealing: () => false,
      isCrashHealExhausted: () => false,
      mode: 'language',
      baselineRevision: 1,
      baselineInstanceId: 'inst-1',
      timeoutMs: 120_000,
      signal: controller.signal
    })

    expect(source.getListenerCount()).toBe(1)
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    controller.abort()

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(source.getListenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('主超时兜底：持续 starting 超过 timeoutMs 返回 timeout 且零泄漏', async () => {
    const source = createFakeStatusSource(
      makeSnapshot({ status: 'starting', revision: 2, instance_id: 'inst-1' })
    )

    const promise = waitForEngineStatusReactive({
      subscribe: fn => source.subscribe(fn),
      getSnapshot: () => source.getSnapshot(),
      isAutoHealing: () => false,
      isCrashHealExhausted: () => false,
      mode: 'language',
      baselineRevision: 2,
      baselineInstanceId: 'inst-1',
      timeoutMs: 30_000
    })

    await vi.advanceTimersByTimeAsync(30_000)

    const res = await promise
    expect(res.ok).toBe(false)
    expect(res.code).toBe('timeout')
    expect(source.getListenerCount()).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
