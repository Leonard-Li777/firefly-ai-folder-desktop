/**
 * AI 服务状态与能力租约管理器
 *
 * @doc-anchor: docs/specs/ai-inference-proactive-readiness-gating-spec.md#21-核心升维能力租约抽象-acquirestage3capability-与三模式分派
 *
 * 统一收敛 Stage 3~4 推理能力租约（simple / cloud / cpu / local 四路径分派）、
 * 分通道事件+时间双驱冷却熔断 Latch 与批启动前非阻塞预热。
 */

import type { ILlamaIndexAIService } from '@firefly/types'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { isAiStageEnabled, type AnalysisMode } from '../../config/analysis-mode'
import { LogCategory, logger, shouldSkipAIServiceInTest } from '@firefly/shared'
import { t } from '@app/languages'
import {
  engineBridgeService,
  engineSwappingCoordinator,
  matchesEngineTargetMode,
  createAbortError,
  SHARED_STARTUP_HARD_TIMEOUT_MS,
  type EngineBridgeSnapshot,
  type EnsureReadyResult,
  type Tier2EngineStatus
} from '../engine-bridge'

/** Stage 3~4 推理能力租约（极简二态，Abort 统一抛出 AbortError） */
export type Stage3CapabilityLease =
  | { granted: true }
  | {
      granted: false
      reason: string
      terminalKind: 'simple' | 'tier1_fallback'
    }

/** 冷却熔断通道标识（local 与 cpu 相互隔离） */
export type CooldownChannel = 'local' | 'cpu'

/** 分通道事件+时间双驱冷却 Latch */
export interface CooldownLatch {
  failedAt: number
  reason: string
  permanent: boolean
  instanceId?: string
  warnedCount: number
}

/** `acquireStage3Capability` 可选参数 */
export interface AcquireStage3CapabilityOptions {
  bypassCooldown?: boolean
  timeoutMs?: number
  /** 队列统一预热栅栏下抑制零散 Toast，由队列相位状态统一反馈 */
  silentToast?: boolean
}

/** 永久类失败码集合（需等待配置/模型安装/事件清除，不靠 60s 自动过期） */
const PERMANENT_FAILURE_CODES = new Set<string>([
  'no_installed_engine',
  'model_missing',
  'no_models_installed',
  'crash_heal_exhausted',
  'cpu_llm_crash_loop'
])

/** 判定异常是否为 AbortError（兼容跨包鸭子类型） */
function isAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (!err || typeof err !== 'object') return false
  return (err as { name?: string }).name === 'AbortError'
}

/** 将任意异步任务与 AbortSignal 竞争，取消时立即抛出 AbortError */
function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) {
    return Promise.reject(createAbortError())
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(createAbortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      val => {
        signal.removeEventListener('abort', onAbort)
        resolve(val)
      },
      err => {
        signal.removeEventListener('abort', onAbort)
        reject(err)
      }
    )
  })
}

/**
 * AI 服务状态管理器
 * 处理 AI 引擎的能力租约仲裁、分通道冷却熔断与批前非阻塞预热
 */
export class AIServiceManager {
  private lastHealthCheckOkTime = 0
  private cooldownByChannel = new Map<CooldownChannel, CooldownLatch>()
  private lastObservedLocalStatus: Tier2EngineStatus['status'] | undefined
  private unsubEnsureFailed?: () => void
  private unsubBridgeStatus?: () => void

  private static readonly TRANSIENT_COOLDOWN_MS = 60_000

  constructor(
    private getAIService: () => ILlamaIndexAIService | undefined,
    private isRunning: () => boolean,
    private notifyFrontend: (
      type: 'info' | 'success' | 'warning' | 'error',
      message: string,
      sticky?: boolean,
      id?: string,
      autoClose?: number,
      action?: any
    ) => Promise<void>
  ) {
    // 初始化观测到的本地引擎状态基线
    const initialSnap = engineBridgeService?.getSnapshot?.()
    this.lastObservedLocalStatus = initialSnap?.raw?.status

    // 单向订阅 EngineBridgeService 共享体失败终态：统一写入 local 通道冷却 Latch
    if (typeof engineBridgeService?.onEnsureFailed === 'function') {
      this.unsubEnsureFailed = engineBridgeService.onEnsureFailed(
        (mode, res: EnsureReadyResult) => {
          if (mode !== 'language' || res.ok) return
          const reason = res.code || res.error || 'engine_start_failed'
          const permanent = PERMANENT_FAILURE_CODES.has(reason)
          const snap = engineBridgeService?.getSnapshot?.()
          const instanceId =
            typeof snap?.raw?.instance_id === 'string' && snap.raw.instance_id.length > 0
              ? snap.raw.instance_id
              : undefined
          this.markStartupFailure('local', reason, { permanent, instanceId })
        }
      )
    }

    // 订阅 SSE 状态推送：维护 lastObservedLocalStatus 并实现事件驱动即时清零冷却
    if (typeof engineBridgeService?.subscribe === 'function') {
      this.unsubBridgeStatus = engineBridgeService.subscribe(snap => {
        this.handleBridgeSnapshot(snap)
      })
    }
  }

  /**
   * 释放引擎桥接订阅监听（主要用于销毁或单测隔离）
   */
  dispose(): void {
    if (this.unsubEnsureFailed) {
      this.unsubEnsureFailed()
      this.unsubEnsureFailed = undefined
    }
    if (this.unsubBridgeStatus) {
      this.unsubBridgeStatus()
      this.unsubBridgeStatus = undefined
    }
  }

  /**
   * 获取最近一次健康检查成功的时间戳
   */
  getLastHealthCheckOkTime(): number {
    return this.lastHealthCheckOkTime
  }

  /**
   * 重置健康检查时间戳（用于测试或强制重新检查）
   */
  resetHealthCheckCache(): void {
    this.lastHealthCheckOkTime = 0
  }

  /**
   * 重置指定通道或全部通道的启动冷却
   * （SSE ready/processing、边沿迁移进入 starting、instance_id 变更、配置变更、用户手动启动时调用）
   */
  resetStartupCooldown(channel?: CooldownChannel): void {
    if (channel) {
      this.cooldownByChannel.delete(channel)
    } else {
      this.cooldownByChannel.clear()
    }
  }

  /**
   * 查询指定通道当前生效的冷却 Latch（瞬态冷却超过 60s 时自动过期清除）
   */
  getActiveCooldown(channel: CooldownChannel): CooldownLatch | null {
    const latch = this.cooldownByChannel.get(channel)
    if (!latch) return null
    if (!latch.permanent && Date.now() - latch.failedAt >= AIServiceManager.TRANSIENT_COOLDOWN_MS) {
      this.cooldownByChannel.delete(channel)
      return null
    }
    return latch
  }

  /**
   * 批末输出同因降级汇总告警（若降级计数 > 1 则追加一条汇总 warn，避免批内刷屏）
   */
  flushDegradeLogSummary(channel?: CooldownChannel): void {
    const channels: CooldownChannel[] = channel ? [channel] : ['local', 'cpu']
    for (const ch of channels) {
      const latch = this.cooldownByChannel.get(ch)
      if (latch && latch.warnedCount > 1) {
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          `[分析队列] 批次降级汇总：${ch} 通道共 ${latch.warnedCount} 个文件因 ${latch.reason} 降级至 CPU 基线`
        )
        latch.warnedCount = 0
      }
    }
  }

  /**
   * 记录同因降级日志：首条输出完整 warn，中间文件降为 debug，批末由 flushDegradeLogSummary 汇总
   */
  recordDegradeLog(channel: CooldownChannel, latch: CooldownLatch): void {
    latch.warnedCount += 1
    if (latch.warnedCount === 1) {
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        `[分析队列] ${channel} 推理通道处于冷却降级 (reason=${latch.reason})，后续同因文件将静默降级至 CPU 基线`
      )
    } else {
      logger.debug(
        LogCategory.ANALYSIS_QUEUE,
        `[分析队列] ${channel} 推理通道同因降级 (reason=${latch.reason}, count=${latch.warnedCount})`
      )
    }
  }

  /**
   * 统一获取 Stage 3~4 推理能力租约
   * （Abort 统一抛出 AbortError，严禁返回 granted: false 掩盖取消）
   */
  async acquireStage3Capability(
    effectiveMode?: AnalysisMode,
    signal?: AbortSignal,
    options?: AcquireStage3CapabilityOptions
  ): Promise<Stage3CapabilityLease> {
    if (signal?.aborted) {
      throw createAbortError()
    }

    // 1. 标准分析模式（simple）：无需 AI 模型阶段
    if (!isAiStageEnabled(effectiveMode)) {
      return { granted: false, reason: 'mode_simple', terminalKind: 'simple' }
    }

    // 2. 单元/集成测试环境旁路或云端模式：直接放行，绝不触碰本地引擎
    const isTest = shouldSkipAIServiceInTest()
    const mode = ConfigOrchestrator.getInstance().getValue<string>('AI_SERVICE_MODE') ?? 'local'
    if (isTest || mode === 'cloud') {
      logger.debug(
        LogCategory.ANALYSIS_QUEUE,
        `[分析队列] ${isTest ? '集成测试环境' : '云端模式'}直接授出 Stage 3 能力租约`
      )
      return { granted: true }
    }

    // 3. 轻量 CPU 引擎模式：完整保留旧 llmGatewayService 预热与 CRASH_LOOP 熔断
    if (mode === 'cpu') {
      return this.acquireCpuStage3Capability(signal, options)
    }

    // 4. 本地外置引擎模式（local）
    return this.acquireLocalStage3Capability(signal, options)
  }

  /**
   * 批启动前非阻塞预热（fire-and-forget）：
   * 仅当高阶 local 模式、snap.connected === true、已安装引擎、未处于冷却期且当前为 stopped 时
   * 触发一次 Single-Flight 拉起（不阻塞 Tier 1 CPU 阶段）；共享体失败终态统一经 onEnsureFailed 落冷却 Latch。
   */
  preheatLocalEngineNonBlocking(effectiveMode?: AnalysisMode): void {
    if (!isAiStageEnabled(effectiveMode)) return
    if (shouldSkipAIServiceInTest()) return

    const mode = ConfigOrchestrator.getInstance().getValue<string>('AI_SERVICE_MODE') ?? 'local'
    if (mode !== 'local') return

    if (engineBridgeService?.hasInstalledEngines === false) return
    if (engineBridgeService?.isCrashHealExhaustedAndOffline?.()) return
    if (this.getActiveCooldown('local') !== null) return

    const snap = engineBridgeService?.getSnapshot?.()
    if (snap?.connected !== true) return
    if (snap.raw?.status !== 'stopped') return

    logger.info(
      LogCategory.ANALYSIS_QUEUE,
      '[分析队列] 批次启动前检测到本地引擎处于 stopped，后台非阻塞预热（Single-Flight）'
    )
    void engineBridgeService
      .ensureReady({
        mode: 'language',
        timeoutMs: SHARED_STARTUP_HARD_TIMEOUT_MS
      })
      .catch(() => {
        // 共享体失败终态已由 onEnsureFailed 统一记账，fire-and-forget 不产生未处理 rejection
      })
  }

  /**
   * `AI_SERVICE_MODE === 'cpu'` 路径能力租约仲裁
   */
  private async acquireCpuStage3Capability(
    signal?: AbortSignal,
    options?: AcquireStage3CapabilityOptions
  ): Promise<Stage3CapabilityLease> {
    try {
      const { llmGatewayService } = await import('../llm/llm-gateway-service')
      if (signal?.aborted) {
        throw createAbortError()
      }

      const snapshot = llmGatewayService.getSnapshot()

      if (snapshot.unavailableReason === 'CRASH_LOOP') {
        logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] 轻量CPU引擎处于熔断保护状态')
        this.notifyFrontend(
          'warning',
          t('轻量CPU引擎异常，请在设置中重新自检'),
          false,
          'waiting-for-ai',
          5000
        )
        return { granted: false, reason: 'cpu_llm_crash_loop', terminalKind: 'tier1_fallback' }
      }

      if (snapshot.runtime.cpu === 'ready') {
        this.resetStartupCooldown('cpu')
        this.lastHealthCheckOkTime = Date.now()
        return { granted: true }
      }

      // 检查 cpu 通道独立冷却 Latch
      if (!options?.bypassCooldown) {
        const activeLatch = this.getActiveCooldown('cpu')
        if (activeLatch) {
          this.recordDegradeLog('cpu', activeLatch)
          return { granted: false, reason: activeLatch.reason, terminalKind: 'tier1_fallback' }
        }
      }

      // 检查底层微服务是否在运行，提供准确的大白话提示
      const { OmniService } = await import('../system/omni-service')
      if (signal?.aborted) {
        throw createAbortError()
      }
      const omniInstance = OmniService.getInstance()
      const omniRunning =
        typeof omniInstance.isServiceRunning === 'function'
          ? omniInstance.isServiceRunning()
          : (omniInstance.isReady?.() ?? false)

      if (!omniRunning) {
        logger.debug(
          LogCategory.ANALYSIS_QUEUE,
          '[分析队列] 检测到轻量CPU引擎底座服务未运行，正在自动拉起...'
        )
        if (!options?.silentToast) {
          this.notifyFrontend(
            'info',
            t('正在启动轻量CPU引擎，即将开始分析...'),
            true,
            'waiting-for-ai',
            0
          )
        }
      } else {
        logger.debug(
          LogCategory.ANALYSIS_QUEUE,
          '[分析队列] 检测到轻量CPU引擎尚未预热，正在主动预热模型...'
        )
        if (!options?.silentToast) {
          this.notifyFrontend(
            'info',
            t('正在预热轻量CPU模型，即将开始分析...'),
            true,
            'waiting-for-ai',
            0
          )
        }
      }

      await raceWithAbort(llmGatewayService.preheat({ wait: true }), signal)
      if (signal?.aborted) {
        throw createAbortError()
      }

      const afterSnap = llmGatewayService.getSnapshot()
      if (afterSnap.runtime.cpu === 'ready') {
        logger.debug(LogCategory.ANALYSIS_QUEUE, '[分析队列] 轻量CPU引擎主动预热成功，开始分析')
        if (!options?.silentToast) {
          this.notifyFrontend(
            'success',
            t('轻量CPU引擎已就绪，开始分析'),
            false,
            'waiting-for-ai',
            3000
          )
        }
        this.resetStartupCooldown('cpu')
        this.lastHealthCheckOkTime = Date.now()
        return { granted: true }
      }

      const isCrashLoop = afterSnap.unavailableReason === 'CRASH_LOOP'
      const reason = isCrashLoop
        ? 'cpu_llm_crash_loop'
        : String(
            afterSnap.cpuLastError ||
              afterSnap.unavailableReason ||
              afterSnap.runtime.cpu ||
              'cpu_preheat_failed'
          )
      logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 轻量CPU引擎主动预热失败:', reason)
      this.notifyFrontend('error', t('轻量CPU引擎预热失败，请重试'), false, 'waiting-for-ai', 5000)
      this.markStartupFailure('cpu', reason, { permanent: isCrashLoop })
      return { granted: false, reason, terminalKind: 'tier1_fallback' }
    } catch (err) {
      if (isAbortError(err, signal)) {
        throw err instanceof Error && err.name === 'AbortError' ? err : createAbortError()
      }
      logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 轻量CPU引擎预热异常:', err)
      this.markStartupFailure('cpu', 'cpu_preheat_error', { permanent: false })
      return { granted: false, reason: 'cpu_preheat_error', terminalKind: 'tier1_fallback' }
    }
  }

  /**
   * `AI_SERVICE_MODE === 'local'` 路径能力租约仲裁
   */
  private async acquireLocalStage3Capability(
    signal?: AbortSignal,
    options?: AcquireStage3CapabilityOptions
  ): Promise<Stage3CapabilityLease> {
    const snap = engineBridgeService?.getSnapshot?.()
    const raw = snap?.raw
    const currStatus = raw?.status
    const currInstanceId =
      typeof raw?.instance_id === 'string' && raw.instance_id.length > 0
        ? raw.instance_id
        : undefined

    // ① 已就绪前置：直接清零 local 冷却并放行（优先于冷却）
    if (
      snap?.connected === true &&
      (currStatus === 'ready' || currStatus === 'processing') &&
      matchesEngineTargetMode(raw, 'language')
    ) {
      this.lastObservedLocalStatus = currStatus
      this.resetStartupCooldown('local')
      this.lastHealthCheckOkTime = Date.now()
      return { granted: true }
    }

    // ② 显存换入中：交由传输门闩屏障排队，严禁重复发 ensureReady 对抗换入
    if (engineSwappingCoordinator?.isInSwapping?.()) {
      this.lastObservedLocalStatus = currStatus
      return { granted: true }
    }

    // ③ 静态不可用（优先于冷却，确保根因准确）
    // 仅以 hasInstalledEngines === false 判定未安装（严禁使用 !snap.backend && !snap.model 启发式）
    if (engineBridgeService?.hasInstalledEngines === false) {
      this.lastObservedLocalStatus = currStatus
      logger.debug(
        LogCategory.ANALYSIS_QUEUE,
        '[分析队列] 未安装本地计算引擎 (hasInstalledEngines === false)，降级 CPU 基线'
      )
      return { granted: false, reason: 'no_installed_engine', terminalKind: 'tier1_fallback' }
    }

    const isCrashExhausted = Boolean(engineBridgeService?.isCrashHealExhaustedAndOffline?.())
    if (
      isCrashExhausted ||
      (currStatus === 'error' &&
        !engineBridgeService?.isAutoHealing?.() &&
        Boolean(engineBridgeService?.isCrashHealExhaustedAndOffline?.()))
    ) {
      this.lastObservedLocalStatus = currStatus
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        '[分析队列] 引擎崩溃自愈已耗尽且离线，直接降级 CPU 基线'
      )
      return { granted: false, reason: 'crash_heal_exhausted', terminalKind: 'tier1_fallback' }
    }

    // ④ 边沿迁移进入 starting 或宿主 instance_id 变更：清零并绕过冷却
    // 持续停留在旧 starting（即使 revision 递增）绝不绕过冷却，杜绝 100×120s 雪崩
    const prevStatus = this.lastObservedLocalStatus
    this.lastObservedLocalStatus = currStatus
    const existingLatch = this.cooldownByChannel.get('local')
    if (existingLatch) {
      const isEdgeIntoStarting = prevStatus !== 'starting' && currStatus === 'starting'
      const isNewInstance = Boolean(
        currInstanceId && existingLatch.instanceId && currInstanceId !== existingLatch.instanceId
      )
      if (isEdgeIntoStarting || isNewInstance) {
        this.resetStartupCooldown('local')
      }
    }

    // ⑤ 冷却熔断检查（非 bypassCooldown 命中即秒降级）
    if (!options?.bypassCooldown) {
      const activeLatch = this.getActiveCooldown('local')
      if (activeLatch) {
        this.recordDegradeLog('local', activeLatch)
        return { granted: false, reason: activeLatch.reason, terminalKind: 'tier1_fallback' }
      }
    }

    // ⑥ 主动拉起与零轮询 SSE 反应式等待
    if (currStatus === 'stopped' || currStatus === 'stopping') {
      logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 检测到引擎未运行，因高阶分析意图自动拉起')
    }

    const res = await engineBridgeService.ensureReady({
      mode: 'language',
      timeoutMs: options?.timeoutMs ?? SHARED_STARTUP_HARD_TIMEOUT_MS,
      signal
    })

    if (res.ok) {
      this.resetStartupCooldown('local')
      this.lastHealthCheckOkTime = Date.now()
      return { granted: true }
    }

    // 冷却记账统一由 engineBridgeService.onEnsureFailed 共享体终态事件驱动，此处直接返回降级
    const reason = res.code || res.error || 'engine_start_failed'
    return { granted: false, reason, terminalKind: 'tier1_fallback' }
  }

  /**
   * 写入指定通道冷却 Latch
   */
  private markStartupFailure(
    channel: CooldownChannel,
    reason: string,
    opts: { permanent: boolean; instanceId?: string }
  ): void {
    const prev = this.cooldownByChannel.get(channel)
    this.cooldownByChannel.set(channel, {
      failedAt: Date.now(),
      reason,
      permanent: opts.permanent,
      instanceId: opts.instanceId,
      warnedCount: prev && prev.reason === reason ? prev.warnedCount : 0
    })
  }

  /**
   * 处理 EngineBridgeService SSE 状态推送：维护边沿检测基线并事件驱动清零 local 冷却
   */
  private handleBridgeSnapshot(snap: EngineBridgeSnapshot): void {
    const raw = snap?.raw
    const currStatus = raw?.status
    const prevStatus = this.lastObservedLocalStatus
    this.lastObservedLocalStatus = currStatus

    const latch = this.cooldownByChannel.get('local')
    if (!latch) return

    // 就绪即刻清零冷却
    if (
      snap?.connected === true &&
      (currStatus === 'ready' || currStatus === 'processing') &&
      matchesEngineTargetMode(raw, 'language')
    ) {
      this.resetStartupCooldown('local')
      return
    }

    // 真实边沿迁移进入 starting（非持续旧 starting）清零冷却
    if (prevStatus !== 'starting' && currStatus === 'starting') {
      this.resetStartupCooldown('local')
      return
    }

    // 宿主 instance_id 变更（重启）清零冷却
    const currInstanceId =
      typeof raw?.instance_id === 'string' && raw.instance_id.length > 0
        ? raw.instance_id
        : undefined
    if (currInstanceId && latch.instanceId && currInstanceId !== latch.instanceId) {
      this.resetStartupCooldown('local')
    }
  }
}
