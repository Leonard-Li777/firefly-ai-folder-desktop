/**
 * Tier 2 引擎熔断器（Circuit Breaker）
 *
 * 职责：保护桌面主进程不被上层 AI 引擎（firefly-ai-engine）反复探活/请求拖垮。
 * 当引擎频繁失败（崩溃、连接拒绝、超时）时自动断开（open），进入冷却期；
 * 冷却结束后进入半开（half-open）状态放行一次试探请求，成功则恢复关闭（closed）。
 *
 * 语义与 slice-3 双层仲裁一致：Tier 2 故障保持静默（不打扰用户），
 * 分析流水线自动降级到 Tier 1（Omni 端侧）兜底。
 */

export type Tier2CircuitState = 'closed' | 'open' | 'half-open'

export interface Tier2CircuitBreakerOptions {
  /** 在滑动窗口（openTimeoutMs）内累计失败达到该次数即熔断，默认 3 */
  failureThreshold?: number
  /** 熔断后的静默冷却时长（毫秒），默认 30 秒 */
  openTimeoutMs?: number
}

/**
 * Tier 2 引擎熔断器（纯 TypeScript 实现，无外部依赖，可独立单测）
 */
export class Tier2CircuitBreaker {
  private readonly failureThreshold: number
  private readonly openTimeoutMs: number
  private failures: number[] = []
  private openedAt: number | null = null
  private probing = false

  constructor(options: Tier2CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3
    this.openTimeoutMs = options.openTimeoutMs ?? 30_000
  }

  /**
   * 记录一次成功调用，重置熔断状态
   */
  public recordSuccess(): void {
    this.failures = []
    this.openedAt = null
    this.probing = false
  }

  /**
   * 记录一次失败调用。
   * 使用滑动窗口统计：仅在 openTimeoutMs 窗口内的失败才计入阈值，
   * 避免历史失败长期占用熔断位。
   */
  public recordFailure(now: number = Date.now()): void {
    this.pruneOutdated(now)
    this.probing = false
    this.failures.push(now)

    for (const failureTime of this.failures) {
      if (now - failureTime <= this.openTimeoutMs) {
        // 只要窗口内疑似的失败仍是当前失败的近邻即可触发
        if (this.failures.filter(t => now - t <= this.openTimeoutMs).length >= this.failureThreshold) {
          this.openedAt = now
          return
        }
      }
    }

    // 若此前已处于熔断开放状态且冷却尚未结束，刷新冷却起点
    if (this.openedAt !== null && now - this.openedAt < this.openTimeoutMs) {
      this.openedAt = now
    }
  }

  /**
   * 获取当前熔断状态
   * - closed：正常，可放行请求
   * - open：冷却期内，拒绝请求
   * - half-open：冷却结束，等待试探
   */
  public getState(now: number = Date.now()): Tier2CircuitState {
    if (this.openedAt === null) {
      return 'closed'
    }
    if (now - this.openedAt >= this.openTimeoutMs) {
      return 'half-open'
    }
    return 'open'
  }

  /**
   * 是否允许发起新的请求（open 拒绝、half-open 仅放行一次试探）
   */
  public canExecute(now: number = Date.now()): boolean {
    const state = this.getState(now)
    if (state === 'closed') {
      return true
    }
    if (state === 'open') {
      return false
    }
    // half-open：尚未放行的试探机会
    if (!this.probing) {
      this.probing = true
      return true
    }
    return false
  }

  /**
   * 是否处于熔断（open / half-open），供 UI 与日志判断
   */
  public isOpen(now: number = Date.now()): boolean {
    return this.getState(now) !== 'closed'
  }

  /**
   * 完全复位熔断器（配置变更 / 引擎重启时调用）
   */
  public reset(): void {
    this.failures = []
    this.openedAt = null
    this.probing = false
  }

  /**
   * 清理窗口外的历史失败记录，防止窗口膨胀
   */
  private pruneOutdated(now: number): void {
    this.failures = this.failures.filter(t => now - t <= this.openTimeoutMs)
  }
}