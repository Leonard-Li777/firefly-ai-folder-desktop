/**
 * 传输门闩跨包 DIP Preflight、端口作用域与 ALS 意图隔离单元测试 (Ticket 04)
 *
 * 验证 engine-swapping-coordinator.ts 纯 TS 零 Electron 依赖可直接在 Vitest Node 环境运行，
 * 覆盖 AC-1a / AC-7 / AC-8 与 Spec §4.1.4 全部场景。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  EngineSwappingCoordinator,
  EngineNotAvailableError,
  registerEngineReadinessChecker,
  __resetEngineReadinessCheckerForTest,
  runWithEngineGateContext,
  resolveEngineGateChannel,
  executeWithEngineTransportGate,
  withEngineGate,
  type EngineReadinessStatus
} from '../engine-swapping-coordinator'

describe('engine-swapping-coordinator Preflight & ALS 意图隔离 (Ticket 04)', () => {
  let coordinator: EngineSwappingCoordinator

  beforeEach(() => {
    __resetEngineReadinessCheckerForTest()
    coordinator = new EngineSwappingCoordinator()
  })

  afterEach(() => {
    coordinator.reset()
    __resetEngineReadinessCheckerForTest()
  })

  describe('globalThis.__fireflyEngineReadinessChecker 注册与未注册 fail-open', () => {
    it('未注册 checker 时默认 fail-open 放行', async () => {
      const action = vi.fn(async () => 'ok')
      const res = await runWithEngineGateContext({ intent: 'batch' }, () =>
        withEngineGate('chat', action, coordinator)
      )
      expect(res).toBe('ok')
      expect(action).toHaveBeenCalledTimes(1)
    })

    it('registerEngineReadinessChecker 同步写入 globalThis 且 disposer 仅注销自身', () => {
      const checkerA = { getStatus: () => 'stopped' as const, isSwapping: () => false }
      const checkerB = { getStatus: () => 'ready' as const, isSwapping: () => false }

      const disposeA = registerEngineReadinessChecker(checkerA)
      expect((globalThis as any).__fireflyEngineReadinessChecker).toBe(checkerA)

      const disposeB = registerEngineReadinessChecker(checkerB)
      expect((globalThis as any).__fireflyEngineReadinessChecker).toBe(checkerB)

      // 旧 disposer 不得误清后注册的 checkerB
      disposeA()
      expect((globalThis as any).__fireflyEngineReadinessChecker).toBe(checkerB)

      disposeB()
      expect((globalThis as any).__fireflyEngineReadinessChecker).toBeUndefined()
    })
  })

  describe('batch 意图 Preflight 物理阻断（零 TCP 发包，AC-1a）', () => {
    it('stopped 态在 batch 上下文中立即抛 EngineNotAvailableError(engine_service_stopped) 且 0 次调用 action', async () => {
      const ensureReady = vi.fn(async () => ({ ok: true }))
      registerEngineReadinessChecker({
        getStatus: () => 'stopped',
        isSwapping: () => false,
        ensureReady
      })

      const action = vi.fn(async () => 'should_not_execute')

      await expect(
        runWithEngineGateContext({ intent: 'batch' }, () =>
          withEngineGate('chat', action, coordinator)
        )
      ).rejects.toMatchObject({
        name: 'EngineNotAvailableError',
        status: 503,
        code: 'engine_service_stopped',
        isTransient: true
      })

      expect(action).not.toHaveBeenCalled()
      expect(ensureReady).not.toHaveBeenCalled()
    })

    it('starting 态在 batch 上下文中立即抛 EngineNotAvailableError(engine_starting) 且 0 次调用 action', async () => {
      registerEngineReadinessChecker({
        getStatus: () => 'starting',
        isSwapping: () => false,
        ensureReady: vi.fn(async () => ({ ok: true }))
      })

      const action = vi.fn(async () => 'should_not_execute')

      await expect(
        runWithEngineGateContext({ intent: 'batch' }, () =>
          withEngineGate('chat', action, coordinator)
        )
      ).rejects.toMatchObject({
        name: 'EngineNotAvailableError',
        status: 503,
        code: 'engine_starting',
        isTransient: true
      })

      expect(action).not.toHaveBeenCalled()
    })
  })

  describe('interactive 意图按需单飞唤醒（默认安全翻转，AC-7）', () => {
    it('未显式包裹 ALS 时默认 interactive：stopped 态自动调用 ensureReady 并在成功后放行', async () => {
      let currentStatus: EngineReadinessStatus = 'stopped'
      const ensureReady = vi.fn(async () => {
        currentStatus = 'ready'
        return { ok: true }
      })

      registerEngineReadinessChecker({
        getStatus: () => currentStatus,
        isSwapping: () => false,
        ensureReady
      })

      const action = vi.fn(async () => 'chat_reply')
      const res = await withEngineGate('chat', action, coordinator)

      expect(ensureReady).toHaveBeenCalledTimes(1)
      expect(action).toHaveBeenCalledTimes(1)
      expect(res).toBe('chat_reply')
    })

    it('interactive 唤醒失败时抛出 EngineNotAvailableError 且不执行 action', async () => {
      const controller = new AbortController()
      const ensureReady = vi.fn(async (sig?: AbortSignal) => {
        expect(sig).toBe(controller.signal)
        return { ok: false, error: 'engine failed to warm up' }
      })

      registerEngineReadinessChecker({
        getStatus: () => 'stopped',
        isSwapping: () => false,
        ensureReady
      })

      const action = vi.fn(async () => 'should_not_run')

      await expect(
        runWithEngineGateContext({ intent: 'interactive', signal: controller.signal }, () =>
          withEngineGate('chat', action, coordinator)
        )
      ).rejects.toSatisfy(
        (err: unknown) =>
          err instanceof EngineNotAvailableError &&
          err.status === 503 &&
          err.code === 'engine_service_stopped' &&
          err.isTransient === true &&
          err.message === 'engine failed to warm up'
      )

      expect(ensureReady).toHaveBeenCalledTimes(1)
      expect(action).not.toHaveBeenCalled()
    })
  })

  describe('豁免状态与通道不误拦', () => {
    it('error / unknown / ready 状态均放行（error 交反代返回真实 500）', async () => {
      for (const status of ['error', 'unknown', 'ready'] as const) {
        registerEngineReadinessChecker({
          getStatus: () => status,
          isSwapping: () => false
        })
        const action = vi.fn(async () => `pass_${status}`)
        const res = await runWithEngineGateContext({ intent: 'batch' }, () =>
          withEngineGate('chat', action, coordinator)
        )
        expect(res).toBe(`pass_${status}`)
        expect(action).toHaveBeenCalledTimes(1)
      }
    })

    it('置换中（checker.isSwapping() === true）不触发 stopped/starting Preflight 拦截', async () => {
      registerEngineReadinessChecker({
        getStatus: () => 'starting',
        isSwapping: () => true
      })

      const action = vi.fn(async () => 'passed_during_swap')
      const res = await runWithEngineGateContext({ intent: 'batch' }, () =>
        withEngineGate('chat', action, coordinator)
      )
      expect(res).toBe('passed_during_swap')
      expect(action).toHaveBeenCalledTimes(1)
    })

    it('embeddings 通道明确豁免零等待放行（即使 stopped + batch）', async () => {
      const ensureReady = vi.fn(async () => ({ ok: true }))
      registerEngineReadinessChecker({
        getStatus: () => 'stopped',
        isSwapping: () => false,
        ensureReady
      })

      const action = vi.fn(async () => 'embedding_ok')
      const res = await runWithEngineGateContext({ intent: 'batch' }, () =>
        withEngineGate('embeddings', action, coordinator)
      )

      expect(res).toBe('embedding_ok')
      expect(action).toHaveBeenCalledTimes(1)
      expect(ensureReady).not.toHaveBeenCalled()
    })
  })

  describe('resolveEngineGateChannel 严格端口作用域（ISS-32 / AC-8）', () => {
    it('未注册 checker 时仅匹配 38400..=38419，排除 38200..=38219（CPU/Omni）及外部云端 URL', () => {
      expect(resolveEngineGateChannel('http://127.0.0.1:38400/v1/chat/completions')).toBe('chat')
      expect(resolveEngineGateChannel('http://127.0.0.1:38419/v1/chat/completions')).toBe('chat')
      expect(resolveEngineGateChannel('http://localhost:38405/v1/embeddings')).toBe('embeddings')

      // AI_SERVICE_MODE === 'cpu' / Omni 端口 38200..=38219 与第三方本地端口必须豁免
      expect(resolveEngineGateChannel('http://127.0.0.1:38200/v1/chat/completions')).toBeNull()
      expect(resolveEngineGateChannel('http://127.0.0.1:38219/v1/chat/completions')).toBeNull()
      expect(resolveEngineGateChannel('http://127.0.0.1:11434/v1/chat/completions')).toBeNull()
      expect(resolveEngineGateChannel('http://127.0.0.1:38420/v1/chat/completions')).toBeNull()

      // 云端 URL 必须豁免
      expect(resolveEngineGateChannel('https://api.openai.com/v1/chat/completions')).toBeNull()
    })

    it('checker.getPort() 返回动态端口时精确匹配该端口，排除其他端口', () => {
      registerEngineReadinessChecker({
        getStatus: () => 'stopped',
        isSwapping: () => false,
        getPort: () => 38407
      })

      expect(resolveEngineGateChannel('http://127.0.0.1:38407/v1/chat/completions')).toBe('chat')
      expect(resolveEngineGateChannel('http://127.0.0.1:38400/v1/chat/completions')).toBeNull()
      expect(resolveEngineGateChannel('http://127.0.0.1:38200/v1/chat/completions')).toBeNull()
      // 相对路径回落到已注册动态端口
      expect(resolveEngineGateChannel('/v1/chat/completions')).toBe('chat')
    })

    it('传入 localBaseUrl 时与目标 URL 端口求交', () => {
      expect(
        resolveEngineGateChannel(
          'http://127.0.0.1:38401/v1/chat/completions',
          'http://127.0.0.1:38400'
        )
      ).toBeNull()
      expect(
        resolveEngineGateChannel(
          'http://127.0.0.1:38400/v1/chat/completions',
          'http://127.0.0.1:38400'
        )
      ).toBe('chat')
    })

    it('AI_SERVICE_MODE === cpu 环回端口（38200）经 executeWithEngineTransportGate 直通，绝不误拦或误拉外置引擎', async () => {
      const ensureReady = vi.fn(async () => ({ ok: true }))
      registerEngineReadinessChecker({
        getStatus: () => 'stopped',
        isSwapping: () => false,
        getPort: () => 38400,
        ensureReady
      })

      const cpuAction = vi.fn(async () => 'cpu_llm_ok')
      const res = await executeWithEngineTransportGate(
        'http://127.0.0.1:38200/v1/chat/completions',
        cpuAction,
        coordinator
      )

      expect(res).toBe('cpu_llm_ok')
      expect(cpuAction).toHaveBeenCalledTimes(1)
      expect(ensureReady).not.toHaveBeenCalled()
    })
  })
})
