/**
 * 引擎生命周期状态机（零 Electron 依赖）
 * apps/desktop/src/electron/runtime-services/engine-bridge/engine-lifecycle-state-machine.ts
 *
 * 核心职责（Issue 04 / Deepening Spec §3.4）：
 * 1. 收拢原本散落在 EngineBridgeService 中的可变生命周期状态字段：
 *    - lastImplicitStartAt（隐式启动节流时间戳）
 *    - lastSelfKillAt（主动终止时间戳，抑制窗口内退出不触发崩溃自愈）
 *    - autoHealAttempts（当前崩溃窗口内已消耗的自愈次数）
 *    - stopEpoch（停止代际计数，防在途异步探活回写已停止状态）
 *    - deploying（二进制热部署替换阶段标志）
 *    - consecutiveProbeFailures（轮询连续探活失败计数）
 * 2. 内部复用 `service-start-policy.ts` 与 `crash-heal-policy.ts` 纯函数，
 *    保持既有导出函数签名 100% 兼容，同时支持在 Vitest Node 环境中零 Mock 直接对多步状态迁移时序进行测试。
 */

import {
  CRASH_HEAL_MAX_ATTEMPTS,
  decideCrashHeal,
  type CrashHealDecision
} from './crash-heal-policy'
import { isServiceUsableStatus, shouldTriggerServiceStartAt } from './service-start-policy'

export interface ProbeEvaluationResult {
  /** 推理服务是否处于可用状态 (ready / processing / starting) */
  usable: boolean
  /** 是否应触发一次隐式或显式 startService() */
  shouldTriggerStart: boolean
  /** 连续探活成功是否已重置崩溃自愈计数 */
  healCounterReset: boolean
}

export interface EngineLifecycleStateSnapshot {
  lastImplicitStartAt: number
  lastSelfKillAt: number | null
  autoHealAttempts: number
  stopEpoch: number
  deploying: boolean
  consecutiveProbeFailures: number
}

export class EngineLifecycleStateMachine {
  private lastImplicitStartAt = 0
  private lastSelfKillAt: number | null = null
  private autoHealAttempts = 0
  private stopEpoch = 0
  private deploying = false
  private consecutiveProbeFailures = 0

  /**
   * 评估当前引擎状态并决定是否触发 startService（内部维护 lastImplicitStartAt 节流窗口）
   * - stopped：宿主在线但服务未启动 -> 按 30s 节流窗口触发拉起（explicit=true 时直接穿透并刷新窗口）
   * - error：启动失败已落库 -> 仅 explicit=true 时允许重试
   * - ready / processing：服务健康 -> 自动清零 autoHealAttempts
   */
  public evaluateServiceStatus(params: {
    status?: string | null
    now?: number
    explicit?: boolean
  }): ProbeEvaluationResult {
    const now = typeof params.now === 'number' ? params.now : Date.now()
    const status = params.status ?? undefined
    const explicit = params.explicit === true

    this.consecutiveProbeFailures = 0

    const usable = isServiceUsableStatus(status)
    let healCounterReset = false
    if (status === 'ready' || status === 'processing') {
      if (this.autoHealAttempts > 0) {
        this.autoHealAttempts = 0
        healCounterReset = true
      }
    }

    const shouldTriggerStart = shouldTriggerServiceStartAt({
      status,
      now,
      lastImplicitStartAt: this.lastImplicitStartAt,
      explicit
    })

    if (shouldTriggerStart) {
      this.lastImplicitStartAt = now
    }

    return {
      usable,
      shouldTriggerStart,
      healCounterReset
    }
  }

  /**
   * 仅判定是否应触发 startService（不产生更新 lastImplicitStartAt 的副作用，供预检使用）
   */
  public canTriggerServiceStart(params: {
    status?: string | null
    now?: number
    explicit?: boolean
  }): boolean {
    const now = typeof params.now === 'number' ? params.now : Date.now()
    return shouldTriggerServiceStartAt({
      status: params.status ?? undefined,
      now,
      lastImplicitStartAt: this.lastImplicitStartAt,
      explicit: params.explicit === true
    })
  }

  /** 记录一次新的进程启动或显式强制重拉（重置隐式启动冷却） */
  public recordExplicitStart(_now?: number): void {
    this.lastImplicitStartAt = 0
  }

  /** 记录一次隐式或显式服务拉起已发出（刷新节流窗口时间戳） */
  public markServiceStartTriggered(now: number = Date.now()): void {
    this.lastImplicitStartAt = now
  }

  /**
   * 记录我方主动 kill / stop 进程（更新 lastSelfKillAt）：
   * - `restartExpected` 默认取 `options?.restartExpected ?? this.deploying`；
   * - 当 `restartExpected === false` 时递增 `this.stopEpoch++`，返回当前 `stopEpoch`。
   */
  public recordIntentionalStop(
    now: number = Date.now(),
    options?: { restartExpected?: boolean }
  ): number {
    this.lastSelfKillAt = now
    this.autoHealAttempts = 0
    const restartExpected = options?.restartExpected ?? this.deploying
    if (!restartExpected) {
      this.stopEpoch++
    }
    return this.stopEpoch
  }

  /**
   * 校验捕获的异步世代是否仍然有效（capturedEpoch === this.stopEpoch && !this.deploying）
   * 所有跨 await 的异步恢复动作在执行前必须校验此方法，防止主动 stop() 后幽灵拉起。
   */
  public isEpochCurrent(capturedEpoch: number): boolean {
    return capturedEpoch === this.stopEpoch && !this.deploying
  }

  /** 获取当前 stopEpoch */
  public getStopEpoch(): number {
    return this.stopEpoch
  }

  /** 仅记录主动 kill 子进程时间戳（不递增 stopEpoch） */
  public recordSelfKill(now: number = Date.now()): void {
    this.lastSelfKillAt = now
  }

  /** 递增并返回新的 stopEpoch */
  public bumpStopEpoch(): number {
    this.stopEpoch++
    return this.stopEpoch
  }

  /** 设置是否处于二进制热部署替换阶段 */
  public setDeploying(deploying: boolean): void {
    this.deploying = deploying
  }

  /** 记录探活网络失败，返回当前连续失败次数 */
  public recordProbeFailure(): number {
    this.consecutiveProbeFailures++
    return this.consecutiveProbeFailures
  }

  /** 重置连续探活失败计数 */
  public resetProbeFailures(): void {
    this.consecutiveProbeFailures = 0
  }

  /** 重置崩溃自愈尝试计数（如稳定运行满 STABLE_RUN_RESET_MS 或用户主动停止） */
  public resetHealAttempts(): void {
    this.autoHealAttempts = 0
  }

  /** 崩溃自愈配额是否已耗尽 */
  public isHealExhausted(): boolean {
    return this.autoHealAttempts >= CRASH_HEAL_MAX_ATTEMPTS
  }

  /**
   * 进程非预期退出时裁决是否执行崩溃自愈（内部自动计算 msSinceSelfKill 并推进 autoHealAttempts）
   */
  public evaluateProcessExit(params: {
    shouldRun: boolean
    now?: number
    deploying?: boolean
  }): CrashHealDecision {
    const now = typeof params.now === 'number' ? params.now : Date.now()
    const isDeploying = typeof params.deploying === 'boolean' ? params.deploying : this.deploying
    const msSinceSelfKill =
      this.lastSelfKillAt !== null && this.lastSelfKillAt > 0
        ? Math.max(0, now - this.lastSelfKillAt)
        : null

    const decision = decideCrashHeal({
      msSinceSelfKill,
      deploying: isDeploying,
      attempts: this.autoHealAttempts,
      shouldRun: params.shouldRun
    })

    if (decision.heal) {
      this.autoHealAttempts = decision.nextAttempts
    }

    return decision
  }

  /** 获取当前内部状态快照（供调试与单测断言） */
  public getStateSnapshot(): EngineLifecycleStateSnapshot {
    return {
      lastImplicitStartAt: this.lastImplicitStartAt,
      lastSelfKillAt: this.lastSelfKillAt,
      autoHealAttempts: this.autoHealAttempts,
      stopEpoch: this.stopEpoch,
      deploying: this.deploying,
      consecutiveProbeFailures: this.consecutiveProbeFailures
    }
  }
}
