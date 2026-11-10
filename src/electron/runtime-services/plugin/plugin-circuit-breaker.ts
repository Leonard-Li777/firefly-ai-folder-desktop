/**
 * 插件双层熔断账本（文件级 + 插件级）
 *
 * 遵循规格：plugin-runtime-sandbox-and-omni-seams-spec.md §4.2.2
 */

import { PluginHealth } from './plugin-types'

export interface CircuitBreakerOptions {
  /** 连续崩溃触发插件熔断阈值，默认 3 */
  maxConsecutiveCrashes?: number
  /** 首次熔断冷却时间（毫秒），默认 60,000 (60s) */
  cooldownMs?: number
  /** 半开探活再次崩溃后的延长冷却时间（毫秒），默认 300,000 (5min) */
  extendedCooldownMs?: number
}

export class PluginCircuitBreaker {
  private readonly maxConsecutiveCrashes: number
  private readonly cooldownMs: number
  private readonly extendedCooldownMs: number

  /** 文件级熔断集合：Set<HashKey> */
  private degradedFiles = new Set<string>()

  /** 插件级健康度状态 */
  private health: PluginHealth = {
    consecutiveCrashes: 0,
    lastCrashAt: 0,
    circuitState: 'CLOSED',
    halfOpenTaskInFlight: false
  }

  /** 当前有效的冷却窗口（在半开探活失败后延长） */
  private currentCooldownMs: number

  /**
   * 受控虚拟时钟偏移量（毫秒，仅作用于当前熔断器，绝不全局 patch Date）(Spec §3.4 / §4.7)
   */
  private virtualClockOffsetMs: number = 0

  constructor(options: CircuitBreakerOptions = {}) {
    this.maxConsecutiveCrashes = options.maxConsecutiveCrashes ?? 3
    this.cooldownMs = options.cooldownMs ?? 60_000
    this.extendedCooldownMs = options.extendedCooldownMs ?? 300_000
    this.currentCooldownMs = this.cooldownMs
  }

  /**
   * 推进受控虚拟时钟（毫秒）
   */
  public advanceClock(ms: number): void {
    if (ms > 0) {
      this.virtualClockOffsetMs += ms
    }
  }

  /**
   * 获取当前有效时间戳（结合虚拟时钟偏移）
   */
  public getEffectiveNow(now?: number): number {
    return (now ?? Date.now()) + this.virtualClockOffsetMs
  }

  // ==================== 文件级熔断 ====================

  /**
   * 计算文件级熔断唯一 Key
   * Key = Hash(文件物理内容指纹 + 插件 ID + 插件版本)
   */
  public computeFileKey(fingerprint: string, pluginId: string, version: string): string {
    return `${pluginId}@${version}#${fingerprint}`
  }

  /**
   * 将指定文件标记为降级熔断（文件级）
   */
  public markFileDegraded(fingerprint: string, pluginId: string, version: string): void {
    const key = this.computeFileKey(fingerprint, pluginId, version)
    this.degradedFiles.add(key)
  }

  /**
   * 检查指定文件是否已在当前插件下被熔断
   */
  public isFileDegraded(fingerprint: string, pluginId: string, version: string): boolean {
    const key = this.computeFileKey(fingerprint, pluginId, version)
    return this.degradedFiles.has(key)
  }

  // ==================== 插件级熔断 ====================

  /**
   * 检查当前插件是否允许派发新任务
   */
  public canExecute(now?: number): { allowed: boolean; reason?: string } {
    const effectiveNow = this.getEffectiveNow(now)
    if (this.health.circuitState === 'CLOSED') {
      return { allowed: true }
    }

    if (this.health.circuitState === 'OPEN') {
      const elapsed = effectiveNow - this.health.lastCrashAt
      if (elapsed >= this.currentCooldownMs) {
        // 冷却期结束，允许试探进入 HALF_OPEN
        this.health.circuitState = 'HALF_OPEN'
        this.health.halfOpenTaskInFlight = false
      } else {
        const remainingSec = Math.ceil((this.currentCooldownMs - elapsed) / 1000)
        return {
          allowed: false,
          reason: `Plugin circuit is OPEN (cooling down, ${remainingSec}s remaining)`
        }
      }
    }

    if (this.health.circuitState === 'HALF_OPEN') {
      // 半开状态只允许 1 个试探任务在途
      if (this.health.halfOpenTaskInFlight) {
        return {
          allowed: false,
          reason: 'Plugin circuit is HALF_OPEN (probe task in flight)'
        }
      }
      this.health.halfOpenTaskInFlight = true
      return { allowed: true }
    }

    return { allowed: true }
  }

  /**
   * 记录一次崩溃（由原生崩溃、非零异常退出或握手失败触发）
   */
  public recordCrash(isPreHandshake: boolean = false, now?: number): void {
    const effectiveNow = this.getEffectiveNow(now)
    this.health.consecutiveCrashes += 1
    this.health.lastCrashAt = effectiveNow

    if (isPreHandshake) {
      // 握手前失败直接触发插件级熔断
      this.health.circuitState = 'OPEN'
      this.health.halfOpenTaskInFlight = false
      this.currentCooldownMs = this.cooldownMs
      return
    }

    if (this.health.circuitState === 'HALF_OPEN') {
      // 半开探活任务再次崩溃，直接退回 OPEN 并延长冷却时间至 5 分钟
      this.health.circuitState = 'OPEN'
      this.health.halfOpenTaskInFlight = false
      this.currentCooldownMs = this.extendedCooldownMs
      return
    }

    if (this.health.circuitState === 'CLOSED') {
      if (this.health.consecutiveCrashes >= this.maxConsecutiveCrashes) {
        this.health.circuitState = 'OPEN'
        this.health.halfOpenTaskInFlight = false
        this.currentCooldownMs = this.cooldownMs
      }
    }
  }

  /**
   * 记录一次成功通信或任务完成，重置熔断计数器与状态
   * 即使任务返回业务错误（如文件损坏、未知子格式），只要进程未崩溃通信正常，即证明插件宿主健康
   */
  public recordSuccess(): void {
    this.health.consecutiveCrashes = 0
    this.health.circuitState = 'CLOSED'
    this.health.halfOpenTaskInFlight = false
    this.currentCooldownMs = this.cooldownMs
  }

  /**
   * 释放半开试探在途占位（如任务被取消或派发前异常，防止死锁）
   */
  public releaseHalfOpenProbe(): void {
    if (this.health.circuitState === 'HALF_OPEN') {
      this.health.halfOpenTaskInFlight = false
    }
  }

  /**
   * 获取当前健康快照
   */
  public getHealth(): Readonly<PluginHealth> {
    return { ...this.health }
  }

  /**
   * 获取符合 Spec §3.4 / §4.7 规范的只读探针快照
   */
  public getProbeState(pluginId: string = ''): {
    pluginId: string
    state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'
    consecutiveCrashes: number
    currentCooldownMs: number
    halfOpenTaskInFlight: boolean
  } {
    return {
      pluginId,
      state: this.health.circuitState,
      consecutiveCrashes: this.health.consecutiveCrashes,
      currentCooldownMs: this.currentCooldownMs,
      halfOpenTaskInFlight: !!this.health.halfOpenTaskInFlight
    }
  }

  /**
   * 重置熔断器（测试或人工干预）
   */
  public reset(): void {
    this.degradedFiles.clear()
    this.virtualClockOffsetMs = 0
    this.health = {
      consecutiveCrashes: 0,
      lastCrashAt: 0,
      circuitState: 'CLOSED',
      halfOpenTaskInFlight: false
    }
    this.currentCooldownMs = this.cooldownMs
  }
}
