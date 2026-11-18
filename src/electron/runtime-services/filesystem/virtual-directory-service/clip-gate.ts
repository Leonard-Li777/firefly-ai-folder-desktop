/**
 * CLIP 文本通道健康门控（CLIP Text Health Gate）
 * 自 HybridSearchArbiter.ts 按职责拆出：
 * 1. 进程级热态纪元（Omni 进程重启即让所有实例的热态判定同时失效）；
 * 2. `/health.clipText` 五字段快照与探活结果门禁；
 * 3. 端点级熔断器 EndpointCircuitBreaker（FTS / 向量 / FS / CLIP 各路共用）。
 */

import type { OmniClipTextHealth } from '../../../services/omni-client'

/**
 * CLIP 文本热态纪元（**进程内全局**，不是实例状态）。
 *
 * 背景：`HybridSearchArbiter` 在 `src` 内有 3 个长生命周期实例（`VirtualDirectoryService` /
 * `DimensionManager` / `FileFilter` 各自的 `TagTreeQuery`），而 CLIP 文本塔的 session 住在
 * **同一个** `firefly-omni` 进程里。因此「引擎（重）启动 ⇒ 所有实例的热态都失效」这个事实
 * 天然是进程级的，用一个单调递增的纪元表达最直接：一次 bump 对全部实例同时生效，
 * 既不需要跨服务注册表，也不需要枚举实例。
 *
 * 计数器使用 `let`（模块级可变）而不是 `var` 全局挂载到 window：主进程 Node 环境下模块单例即可。
 */
let clipWarmEpoch = 0

/**
 * 让所有 arbiter 实例的 CLIP 文本热态判定同时失效（Omni 进程（重）启动时调用）。
 *
 * 只清「热态」：熔断计数保持不动。重启后的首次编码即便超时也只记 1 次失败，
 * 下一次必然回到冷态 6000ms 预算并成功，随即 `recordSuccess()` 清零——为清一个
 * 「最多 1 次」的计数而引入跨实例注册表属于过度设计（方案 W2 第 2 条）。
 */
export function invalidateClipTextWarmState(): void {
  clipWarmEpoch += 1
}

/** 只读：当前热态纪元（供诊断与单测断言，不改变状态） */
export function getClipTextWarmEpoch(): number {
  return clipWarmEpoch
}
/**
 * `/health.clipText` 五字段快照。
 *
 * **单一事实源**：直接复用 `omni-client` 的 `OmniClipTextHealth`。
 * 此前在此处内联了一份同构定义，注释给的理由（「以免循环依赖」）不成立——
 * 本文件本就从同一模块 import `omniClient`，类型导入不新增依赖边；
 * 两份结构一旦漂移，赋值处因结构兼容不会报错，属静默失配。
 */
export type ClipTextHealthSnapshot = OmniClipTextHealth
/**
 * CLIP 第 5 路**探活结果**门禁（纯函数）。
 *
 * 只有前置已通过才轮到这几条：它们决定「探活已拿到，但文本塔实际不可用」。
 * 支持双语分流：中文要求 chinese_clip 图像塔，非中文要求 mobileclip 图像塔。
 */
export function evaluateClipTextHealthGate(
  health: ClipTextHealthSnapshot | null | undefined,
  lang?: string | null
): { run: boolean; reason?: string } {
  if (!health) return { run: false, reason: 'health_unavailable' }
  if (!health.available) return { run: false, reason: 'health_unavailable' }
  const isZh = (lang || 'zh').toLowerCase().startsWith('zh')
  const expectedEncoder = isZh ? 'chinese_clip' : 'mobileclip'
  if (health.imageEncoder !== expectedEncoder) {
    return { run: false, reason: `image_encoder_not_${expectedEncoder}` }
  }
  if (!health.textModelReady) return { run: false, reason: 'health_unavailable' }
  if (!health.vocabReady) return { run: false, reason: 'health_unavailable' }
  // 三态：null = 尚未验证过，允许尝试（首次成功后会转 true）
  if (health.textOutputVerified === false) return { run: false, reason: 'text_output_unverified' }
  return { run: true }
}
/**
 * 端点级熔断器（Endpoint Circuit Breaker）：
 * - 连续失败达到阈值后进入冷却期（isOpen = true），期间跳过调用方请求；
 * - 冷却期结束自动半开复位（连续失败计数清零）；
 * - 任意成功调用立即关闭熔断。
 */
export class EndpointCircuitBreaker {
  private consecutiveFailures = 0
  private openUntil = 0
  /** 累计「打开」次数（仅用于指数退避；成功一次即清零） */
  private openCount = 0

  constructor(
    private readonly threshold: number = 3,
    private readonly cooldownMs: number = 30_000,
    private readonly now: () => number = () => Date.now(),
    /**
     * 退避倍率：第 n 次打开时冷却 = cooldownMs * factor^(n-1)。
     * 缺省 1 ⇒ `factor^anything === 1`，冷却恒为 cooldownMs，**与引入本参数前的行为逐位一致**，
     * 既有 FTS/向量/FS 三路不受影响（工单 12 要求不得改动四路既有阈值结构）。
     */
    private readonly backoffFactor: number = 1
  ) {}

  /** 是否处于熔断打开状态（打开期间跳过网络请求） */
  get isOpen(): boolean {
    if (this.consecutiveFailures < this.threshold) return false
    if (this.openUntil <= this.now()) {
      // 冷却到期自动复位（半开）
      this.consecutiveFailures = 0
      this.openUntil = 0
      return false
    }
    return true
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0
    this.openUntil = 0
    this.openCount = 0
  }

  recordFailure(): void {
    this.consecutiveFailures += 1
    if (this.consecutiveFailures >= this.threshold) {
      const factor =
        Number.isFinite(this.backoffFactor) && this.backoffFactor > 0 ? this.backoffFactor : 1
      this.openUntil = this.now() + this.cooldownMs * Math.pow(factor, this.openCount)
      this.openCount += 1
    }
  }

  get failureCount(): number {
    return this.consecutiveFailures
  }
}