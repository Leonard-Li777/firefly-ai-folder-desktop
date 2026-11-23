import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  default: {
    app: {
      getPath: vi.fn(() => 'D:/mock-path'),
      getName: vi.fn(() => 'desktop'),
      getVersion: vi.fn(() => '1.0.0')
    },
    ipcMain: { on: vi.fn(), handle: vi.fn() }
  },
  app: {
    getPath: vi.fn(() => 'D:/mock-path'),
    getName: vi.fn(() => 'desktop'),
    getVersion: vi.fn(() => '1.0.0')
  },
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

vi.mock('electron-conf', () => ({
  Conf: class {
    get() {
      return undefined
    }
    set() {}
    onDidChange() {}
  }
}))

vi.mock('@app/languages', () => ({
  t: (s: string) => s
}))

vi.mock('@firefly/shared', async () => {
  const actual = await vi.importActual<any>('@firefly/shared')
  return {
    ...actual,
    shouldSkipAIServiceInTest: vi.fn(() => false)
  }
})

const mockLlmGatewayService = {
  getSnapshot: vi.fn(),
  preheat: vi.fn()
}

vi.mock('../../llm/llm-gateway-service', () => ({
  llmGatewayService: mockLlmGatewayService
}))

const mockOmniServiceInstance = {
  isServiceRunning: vi.fn(() => true),
  isReady: vi.fn(() => true)
}

vi.mock('../../system/omni-service', () => ({
  OmniService: {
    getInstance: vi.fn(() => mockOmniServiceInstance)
  }
}))

import { AIServiceManager } from '../ai-service-manager'
import { AIServiceStatus, type ILlamaIndexAIService } from '@firefly/types'
import {
  engineBridgeService,
  engineSwappingCoordinator,
  type EngineBridgeSnapshot,
  type EnsureReadyResult,
  type EngineTargetMode
} from '../../engine-bridge'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'
import { logger, shouldSkipAIServiceInTest } from '@firefly/shared'

function createBridgeSnapshot(
  overrides: Partial<EngineBridgeSnapshot> & {
    raw?: EngineBridgeSnapshot['raw']
  } = {}
): EngineBridgeSnapshot {
  return {
    connected: true,
    available: true,
    backend: null,
    model: null,
    managed: true,
    circuitState: 'closed',
    exePath: null,
    devMode: false,
    port: 38400,
    version: null,
    backendMatchType: null,
    modelName: null,
    vramMb: null,
    modelCount: null,
    totalModelCount: 33,
    lastError: null,
    updatedAt: Date.now(),
    raw: { status: 'stopped', instance_id: 'inst-1', revision: 1 },
    ...overrides
  }
}

describe('AIServiceManager: 能力租约抽象、分通道冷却与批前非阻塞预热', () => {
  let manager: AIServiceManager
  let mockAIService: Partial<ILlamaIndexAIService>
  let notifyCalls: any[] = []

  let ensureFailedListeners: Set<(mode: EngineTargetMode, res: EnsureReadyResult) => void>
  let bridgeStatusListeners: Set<(snap: EngineBridgeSnapshot) => void>
  let currentSnap: EngineBridgeSnapshot

  const emitEnsureFailed = (mode: EngineTargetMode, res: EnsureReadyResult) => {
    for (const fn of ensureFailedListeners) {
      fn(mode, res)
    }
  }

  const emitBridgeStatus = (snap: EngineBridgeSnapshot) => {
    currentSnap = snap
    for (const fn of bridgeStatusListeners) {
      fn(snap)
    }
  }

  let aiServiceMode = 'local'
  let globalAnalysisMode = 'full'

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    notifyCalls = []
    aiServiceMode = 'local'
    globalAnalysisMode = 'full'
    ensureFailedListeners = new Set()
    bridgeStatusListeners = new Set()
    currentSnap = createBridgeSnapshot({
      connected: true,
      raw: { status: 'stopped', instance_id: 'inst-1', revision: 1 }
    })

    vi.mocked(shouldSkipAIServiceInTest).mockReturnValue(false)

    mockAIService = {
      getServiceStatus: vi.fn().mockReturnValue(AIServiceStatus.STOPPED),
      healthCheck: vi.fn().mockResolvedValue(false),
      restart: vi.fn().mockResolvedValue(undefined)
    }

    vi.spyOn(ConfigOrchestrator.getInstance(), 'getValue').mockImplementation((key: string) => {
      if (key === 'AI_SERVICE_MODE') return aiServiceMode
      if (key === 'ANALYSIS_MODE') return globalAnalysisMode
      return undefined
    })

    engineBridgeService.hasInstalledEngines = true
    vi.spyOn(engineBridgeService, 'getSnapshot').mockImplementation(() => currentSnap)
    vi.spyOn(engineBridgeService, 'isCrashHealExhaustedAndOffline').mockReturnValue(false)
    vi.spyOn(engineBridgeService, 'isAutoHealing').mockReturnValue(false)
    vi.spyOn(engineBridgeService, 'ensureReady').mockResolvedValue({ ok: true })
    vi.spyOn(engineBridgeService, 'onEnsureFailed').mockImplementation(fn => {
      ensureFailedListeners.add(fn)
      return () => {
        ensureFailedListeners.delete(fn)
      }
    })
    vi.spyOn(engineBridgeService, 'subscribe').mockImplementation(fn => {
      bridgeStatusListeners.add(fn)
      return () => {
        bridgeStatusListeners.delete(fn)
      }
    })
    vi.spyOn(engineSwappingCoordinator, 'isInSwapping').mockReturnValue(false)

    mockLlmGatewayService.getSnapshot.mockReset()
    mockLlmGatewayService.preheat.mockReset()
    mockOmniServiceInstance.isServiceRunning.mockReturnValue(true)

    manager = new AIServiceManager(
      () => mockAIService as ILlamaIndexAIService,
      () => true,
      async (...args: any[]) => {
        notifyCalls.push(args)
      }
    )
  })

  afterEach(() => {
    manager.dispose()
    vi.useRealTimers()
  })

  describe('四路径分派：simple / cloud / test / cpu', () => {
    it('simple 模式返回 terminalKind: simple，不触碰本地引擎', async () => {
      const lease = await manager.acquireStage3Capability('simple')
      expect(lease).toEqual({
        granted: false,
        reason: 'mode_simple',
        terminalKind: 'simple'
      })
      expect(engineBridgeService.ensureReady).not.toHaveBeenCalled()
    })

    it('cloud 模式直接返回 granted: true，绝不触碰本地引擎', async () => {
      aiServiceMode = 'cloud'
      engineBridgeService.hasInstalledEngines = false
      const lease = await manager.acquireStage3Capability('full')
      expect(lease).toEqual({ granted: true })
      expect(engineBridgeService.ensureReady).not.toHaveBeenCalled()
    })

    it('测试环境旁路（shouldSkipAIServiceInTest）直接返回 granted: true', async () => {
      vi.mocked(shouldSkipAIServiceInTest).mockReturnValue(true)
      const lease = await manager.acquireStage3Capability('full')
      expect(lease).toEqual({ granted: true })
      expect(engineBridgeService.ensureReady).not.toHaveBeenCalled()
    })

    it('AC-8: cpu 模式下 CRASH_LOOP 直接熔断返回 cpu_llm_crash_loop (tier1_fallback)', async () => {
      aiServiceMode = 'cpu'
      mockLlmGatewayService.getSnapshot.mockReturnValue({
        unavailableReason: 'CRASH_LOOP',
        runtime: { cpu: 'stopped' }
      })

      const lease = await manager.acquireStage3Capability('full')
      expect(lease).toEqual({
        granted: false,
        reason: 'cpu_llm_crash_loop',
        terminalKind: 'tier1_fallback'
      })
      expect(mockLlmGatewayService.preheat).not.toHaveBeenCalled()
      expect(engineBridgeService.ensureReady).not.toHaveBeenCalled()
    })

    it('AC-8: cpu 模式未预热时调用 llmGatewayService.preheat({ wait: true })，成功后授出租约', async () => {
      aiServiceMode = 'cpu'
      mockLlmGatewayService.getSnapshot
        .mockReturnValueOnce({ runtime: { cpu: 'stopped' } })
        .mockReturnValueOnce({ runtime: { cpu: 'ready' } })
      mockLlmGatewayService.preheat.mockResolvedValue(undefined)

      const lease = await manager.acquireStage3Capability('full')
      expect(lease).toEqual({ granted: true })
      expect(mockLlmGatewayService.preheat).toHaveBeenCalledWith({ wait: true })
      expect(engineBridgeService.ensureReady).not.toHaveBeenCalled()
    })

    it('AC-8: cpu 模式预热失败写入独立 cpu 冷却，不污染 local 通道，60s 内同因秒降级', async () => {
      aiServiceMode = 'cpu'
      mockLlmGatewayService.getSnapshot.mockReturnValue({
        runtime: { cpu: 'error' },
        cpuLastError: 'oom_load_failed'
      })
      mockLlmGatewayService.preheat.mockResolvedValue(undefined)

      const lease1 = await manager.acquireStage3Capability('full')
      expect(lease1).toEqual({
        granted: false,
        reason: 'oom_load_failed',
        terminalKind: 'tier1_fallback'
      })
      expect(mockLlmGatewayService.preheat).toHaveBeenCalledTimes(1)
      expect(manager.getActiveCooldown('cpu')).not.toBeNull()
      expect(manager.getActiveCooldown('local')).toBeNull()

      // 第二次在冷却期内直接秒降级，不再调用 preheat
      const lease2 = await manager.acquireStage3Capability('full')
      expect(lease2).toEqual({
        granted: false,
        reason: 'oom_load_failed',
        terminalKind: 'tier1_fallback'
      })
      expect(mockLlmGatewayService.preheat).toHaveBeenCalledTimes(1)
    })

    it('AC-8: cpu 模式预热期间触发 Abort 立即抛出 AbortError 且不写入冷却', async () => {
      aiServiceMode = 'cpu'
      mockLlmGatewayService.getSnapshot.mockReturnValue({ runtime: { cpu: 'stopped' } })
      mockLlmGatewayService.preheat.mockReturnValue(new Promise(() => {}))

      const controller = new AbortController()
      const promise = manager.acquireStage3Capability('full', controller.signal)
      controller.abort()

      await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
      expect(manager.getActiveCooldown('cpu')).toBeNull()
    })
  })

  describe('local 模式仲裁顺序、双驱冷却与边沿 starting 检测', () => {
    it('ready/processing 且匹配 language 时前置清零 local 冷却并直接放行', async () => {
      emitEnsureFailed('language', { ok: false, code: 'kick_ack_timeout' })
      expect(manager.getActiveCooldown('local')).not.toBeNull()

      currentSnap = createBridgeSnapshot({
        connected: true,
        raw: { status: 'ready', current_model: 'qwen3-8b', instance_id: 'inst-1', revision: 5 }
      })

      const lease = await manager.acquireStage3Capability('full')
      expect(lease).toEqual({ granted: true })
      expect(manager.getActiveCooldown('local')).toBeNull()
      expect(engineBridgeService.ensureReady).not.toHaveBeenCalled()
    })

    it('ready 但当前加载的是 embedding 模型时不放行，转为调用 ensureReady(language)', async () => {
      currentSnap = createBridgeSnapshot({
        connected: true,
        raw: {
          status: 'ready',
          current_model: 'wemm-embedding-v1',
          instance_id: 'inst-1',
          revision: 3
        }
      })

      const lease = await manager.acquireStage3Capability('full')
      expect(lease).toEqual({ granted: true })
      expect(engineBridgeService.ensureReady).toHaveBeenCalledWith({
        mode: 'language',
        timeoutMs: 120_000,
        signal: undefined
      })
    })

    it('engineSwappingCoordinator.isInSwapping() 为真时直接返回 granted: true，不重复拉起', async () => {
      vi.spyOn(engineSwappingCoordinator, 'isInSwapping').mockReturnValue(true)

      const lease = await manager.acquireStage3Capability('full')
      expect(lease).toEqual({ granted: true })
      expect(engineBridgeService.ensureReady).not.toHaveBeenCalled()
    })

    it('静态不可用（hasInstalledEngines === false）优先于冷却返回准确根因', async () => {
      emitEnsureFailed('language', { ok: false, code: 'timeout' })
      engineBridgeService.hasInstalledEngines = false

      const lease = await manager.acquireStage3Capability('full')
      expect(lease).toEqual({
        granted: false,
        reason: 'no_installed_engine',
        terminalKind: 'tier1_fallback'
      })
      expect(engineBridgeService.ensureReady).not.toHaveBeenCalled()
    })

    it('崩溃自愈耗尽（isCrashHealExhaustedAndOffline === true）优先于冷却返回 crash_heal_exhausted', async () => {
      emitEnsureFailed('language', { ok: false, code: 'timeout' })
      vi.spyOn(engineBridgeService, 'isCrashHealExhaustedAndOffline').mockReturnValue(true)

      const lease = await manager.acquireStage3Capability('full')
      expect(lease).toEqual({
        granted: false,
        reason: 'crash_heal_exhausted',
        terminalKind: 'tier1_fallback'
      })
      expect(engineBridgeService.ensureReady).not.toHaveBeenCalled()
    })

    it('冷启 stopped 宿主（hasInstalledEngines === null 且 backend/model 为空）不误判未安装，主动拉起', async () => {
      engineBridgeService.hasInstalledEngines = null
      currentSnap = createBridgeSnapshot({
        connected: true,
        backend: null,
        model: null,
        raw: { status: 'stopped', instance_id: 'inst-1', revision: 1 }
      })

      const infoSpy = vi.spyOn(logger, 'info')
      const lease = await manager.acquireStage3Capability('full')
      expect(lease).toEqual({ granted: true })
      expect(engineBridgeService.ensureReady).toHaveBeenCalledWith({
        mode: 'language',
        timeoutMs: 120_000,
        signal: undefined
      })
      expect(infoSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.stringContaining('检测到引擎未运行，因高阶分析意图自动拉起')
      )
    })

    it('持续停留在旧 starting（即使 revision 递增）绝不绕过冷却，命中冷却秒降级', async () => {
      // 先进入 starting 态，再模拟共享体超时失败落盘冷却
      emitBridgeStatus(
        createBridgeSnapshot({
          connected: true,
          raw: { status: 'starting', instance_id: 'inst-1', revision: 10 }
        })
      )
      emitEnsureFailed('language', { ok: false, code: 'timeout' })
      expect(manager.getActiveCooldown('local')).not.toBeNull()

      // 收到携带其他元数据的非状态变更帧：revision 递增但 status 仍为 starting
      emitBridgeStatus(
        createBridgeSnapshot({
          connected: true,
          raw: { status: 'starting', instance_id: 'inst-1', revision: 11 }
        })
      )

      const lease = await manager.acquireStage3Capability('full')
      expect(lease).toEqual({
        granted: false,
        reason: 'timeout',
        terminalKind: 'tier1_fallback'
      })
      expect(engineBridgeService.ensureReady).not.toHaveBeenCalled()
    })

    it('真实边沿迁移进入 starting（stopped -> starting）清零并绕过冷却', async () => {
      emitBridgeStatus(
        createBridgeSnapshot({
          connected: true,
          raw: { status: 'stopped', instance_id: 'inst-1', revision: 10 }
        })
      )
      emitEnsureFailed('language', { ok: false, code: 'kick_ack_timeout' })
      expect(manager.getActiveCooldown('local')).not.toBeNull()

      // 边沿迁移进入 starting
      emitBridgeStatus(
        createBridgeSnapshot({
          connected: true,
          raw: { status: 'starting', instance_id: 'inst-1', revision: 11 }
        })
      )
      expect(manager.getActiveCooldown('local')).toBeNull()

      const lease = await manager.acquireStage3Capability('full')
      expect(lease).toEqual({ granted: true })
      expect(engineBridgeService.ensureReady).toHaveBeenCalledTimes(1)
    })

    it('宿主 instance_id 变更（重启）清零冷却并允许重新等待', async () => {
      emitBridgeStatus(
        createBridgeSnapshot({
          connected: true,
          raw: { status: 'starting', instance_id: 'inst-old', revision: 5 }
        })
      )
      emitEnsureFailed('language', { ok: false, code: 'timeout' })
      expect(manager.getActiveCooldown('local')).not.toBeNull()

      // 新宿主实例启动（即便 status 同样为 starting，instance_id 变更也应清零冷却）
      emitBridgeStatus(
        createBridgeSnapshot({
          connected: true,
          raw: { status: 'starting', instance_id: 'inst-new', revision: 1 }
        })
      )
      expect(manager.getActiveCooldown('local')).toBeNull()

      const lease = await manager.acquireStage3Capability('full')
      expect(lease).toEqual({ granted: true })
      expect(engineBridgeService.ensureReady).toHaveBeenCalledTimes(1)
    })

    it('onEnsureFailed 统一记账，单调用方短超时未触发 onEnsureFailed 时不写入冷却', async () => {
      vi.spyOn(engineBridgeService, 'ensureReady').mockResolvedValueOnce({
        ok: false,
        code: 'caller_timeout'
      })

      const lease = await manager.acquireStage3Capability('full', undefined, { timeoutMs: 5_000 })
      expect(lease).toEqual({
        granted: false,
        reason: 'caller_timeout',
        terminalKind: 'tier1_fallback'
      })
      // 未收到共享体 onEnsureFailed，冷却保持清空
      expect(manager.getActiveCooldown('local')).toBeNull()
    })

    it('冷却 60s 时间兜底自动过期，resetStartupCooldown 可手动清零，同因降级日志去重且批末汇总', async () => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-11-23T08:00:00.000Z'))

      emitEnsureFailed('language', { ok: false, code: 'process_exited_during_startup' })

      const warnSpy = vi.spyOn(logger, 'warn')
      const debugSpy = vi.spyOn(logger, 'debug')

      // 连续 3 次同因降级：首条 warn，后 2 条 debug
      await manager.acquireStage3Capability('full')
      await manager.acquireStage3Capability('full')
      await manager.acquireStage3Capability('full')

      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(debugSpy).toHaveBeenCalledTimes(2)

      // 批末汇总输出 1 条汇总 warn
      manager.flushDegradeLogSummary('local')
      expect(warnSpy).toHaveBeenCalledTimes(2)

      // 推进 60s 后瞬态冷却自动过期
      vi.advanceTimersByTime(60_000)
      expect(manager.getActiveCooldown('local')).toBeNull()

      // 再次写冷却后用 resetStartupCooldown 手动清除
      emitEnsureFailed('language', { ok: false, code: 'timeout' })
      expect(manager.getActiveCooldown('local')).not.toBeNull()
      manager.resetStartupCooldown('local')
      expect(manager.getActiveCooldown('local')).toBeNull()
    })

    it('已取消的 signal 立即抛出 AbortError', async () => {
      const controller = new AbortController()
      controller.abort()
      await expect(manager.acquireStage3Capability('full', controller.signal)).rejects.toMatchObject(
        { name: 'AbortError' }
      )
      expect(engineBridgeService.ensureReady).not.toHaveBeenCalled()
    })
  })

  describe('AC-9: preheatLocalEngineNonBlocking 批前非阻塞预热', () => {
    it('高阶 local 模式 + connected + stopped + 已安装 + 无冷却 ➔ 仅触发 1 次非阻塞拉起', () => {
      currentSnap = createBridgeSnapshot({
        connected: true,
        raw: { status: 'stopped', instance_id: 'inst-1', revision: 1 }
      })

      manager.preheatLocalEngineNonBlocking('full')

      expect(engineBridgeService.ensureReady).toHaveBeenCalledTimes(1)
      expect(engineBridgeService.ensureReady).toHaveBeenCalledWith({
        mode: 'language',
        timeoutMs: 120_000
      })
    })

    it('simple 模式 / 非 local / 未连接 / 未安装 / 冷却期内 / 非 stopped 触发次数恒为 0', () => {
      // 1. simple 模式
      manager.preheatLocalEngineNonBlocking('simple')
      expect(engineBridgeService.ensureReady).not.toHaveBeenCalled()

      // 2. cloud / cpu 模式
      aiServiceMode = 'cloud'
      manager.preheatLocalEngineNonBlocking('full')
      aiServiceMode = 'cpu'
      manager.preheatLocalEngineNonBlocking('full')
      aiServiceMode = 'local'
      expect(engineBridgeService.ensureReady).not.toHaveBeenCalled()

      // 3. 未连接
      currentSnap = createBridgeSnapshot({ connected: false, raw: { status: 'stopped' } })
      manager.preheatLocalEngineNonBlocking('full')
      currentSnap = createBridgeSnapshot({ connected: true, raw: { status: 'stopped' } })
      expect(engineBridgeService.ensureReady).not.toHaveBeenCalled()

      // 4. 未安装引擎
      engineBridgeService.hasInstalledEngines = false
      manager.preheatLocalEngineNonBlocking('full')
      engineBridgeService.hasInstalledEngines = true
      expect(engineBridgeService.ensureReady).not.toHaveBeenCalled()

      // 5. 冷却期内
      emitEnsureFailed('language', { ok: false, code: 'kick_ack_timeout' })
      manager.preheatLocalEngineNonBlocking('full')
      manager.resetStartupCooldown('local')
      expect(engineBridgeService.ensureReady).not.toHaveBeenCalled()

      // 6. 当前已处于 ready / starting
      currentSnap = createBridgeSnapshot({ connected: true, raw: { status: 'ready' } })
      manager.preheatLocalEngineNonBlocking('full')
      currentSnap = createBridgeSnapshot({ connected: true, raw: { status: 'starting' } })
      manager.preheatLocalEngineNonBlocking('full')
      expect(engineBridgeService.ensureReady).not.toHaveBeenCalled()
    })
  })
})
