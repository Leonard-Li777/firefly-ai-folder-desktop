/**
 * 统一 AI 引擎置换门闩协调器与多通道执行器 (Ticket 3)
 * apps/desktop/src/electron/runtime-services/engine-bridge/engine-swapping-coordinator.ts
 *
 * 遵循架构规范：
 * 1. 纯 TypeScript 模块，无 Electron 顶层依赖，可直接在 Vitest Node 环境测试；
 * 2. 独立通道分立：/v1/embeddings 独立常驻放行，绝不参与门闩；
 * 3. 门闩双重判定契约 (IN-01)：state === 'ready' && reasonCode !== 'engine_swapping'；
 * 4. 防惊群机制：并发请求在置换期间复用单一 waitPromise，自适应退避后并发放行；
 * 5. 豁免熔断失败计数：置换期间不增加 consecutiveFailures，不错误降级至基础引擎。
 */

import { logger, LogCategory } from '@firefly/shared'

/**
 * 单个 Worker 子进程运行状态
 */
export interface EngineWorkerStatus {
  state: 'ready' | 'starting' | 'processing' | 'stopped'
  vramBytes: number
  modelId?: string
  details?: string
}

/**
 * 引擎显存与 Worker 运行时指标快照（对齐 /v1/engine/metrics 契约）
 */
export interface EngineMetricsSnapshot {
  totalVramBytes: number
  usedVramBytes: number
  freeVramBytes: number
  systemReservedVramBytes: number
  gpuName?: string
  isSharedMemory?: boolean
  workers: {
    llm: EngineWorkerStatus
    embedding: EngineWorkerStatus
    diffusion: EngineWorkerStatus
    audio: EngineWorkerStatus
  }
  swapping: {
    isSwapping: boolean
    etaMs?: number
    reasonCode?: 'engine_swapping' | string
  }
}

/**
 * 引擎能力与健康状态快照（遵循系统不变量 6：四态 starting / ready / processing / stopped）
 */
export interface EngineCapability {
  /** 满足系统不变量 6：四态 starting / ready / processing / stopped */
  state: 'starting' | 'ready' | 'processing' | 'stopped'
  /** 置换等细分子状态原因码，如 'engine_swapping' */
  reasonCode?: string
  metrics?: EngineMetricsSnapshot
  supportedChannels: ('chat' | 'embeddings')[]
}

/**
 * 门闩双重判定契约 (IN-01)
 *
 * 统一引擎处于模型置换时，进程本身处于健康活动态（state === 'ready'），
 * 但携带原因码 reasonCode: 'engine_swapping'。门闩判定必须严格遵循：
 * state === 'ready' && reasonCode !== 'engine_swapping'
 * 严禁仅判定 state === 'ready' 导致门闩穿透。
 */
export function isAvailableForInference(
  cap?: { state?: string; reasonCode?: string } | null
): boolean {
  if (!cap) return false
  return cap.state === 'ready' && cap.reasonCode !== 'engine_swapping'
}

/**
 * 解析 HTTP 响应头中的 Retry-After 或 eta_ms（秒）
 * 预算控制：最少 0.5 秒，上限 120 秒，默认 2.5 秒
 */
export function parseRetryAfter(header?: string | string[] | null, etaMs?: number): number {
  if (etaMs && typeof etaMs === 'number' && etaMs > 0) {
    const fromEta = etaMs / 1000
    return Math.max(0.5, Math.min(120, fromEta))
  }

  if (header) {
    const rawVal = Array.isArray(header) ? header[0] : header
    const parsed = parseFloat(rawVal)
    if (!Number.isNaN(parsed) && parsed > 0) {
      return Math.max(0.5, Math.min(120, parsed))
    }
  }

  return 2.5
}

/**
 * 引擎模型置换调度协调器（单例模式与可测试实例共存）
 */
export class EngineSwappingCoordinator {
  private static instance: EngineSwappingCoordinator | null = null

  private waitPromise: Promise<void> | null = null
  private isSwapping = false
  private swappingTimer: NodeJS.Timeout | null = null
  private swappingCount = 0

  constructor() {}

  static getInstance(): EngineSwappingCoordinator {
    if (!EngineSwappingCoordinator.instance) {
      EngineSwappingCoordinator.instance = new EngineSwappingCoordinator()
    }
    return EngineSwappingCoordinator.instance
  }

  /** 是否处于置换状态 */
  isInSwapping(): boolean {
    return this.isSwapping
  }

  /** 累计置换轮次 */
  getSwappingCount(): number {
    return this.swappingCount
  }

  /**
   * 门闩拦截：若处于置换中，请求排队等待单一 waitPromise，避免惊群
   */
  async executeWithBarrier<T>(action: () => Promise<T>): Promise<T> {
    if (this.waitPromise) {
      await this.waitPromise
    }
    return action()
  }

  /**
   * 进入模型置换状态并开启全局门闩。
   * 并发请求共享同一个 waitPromise，绝不产生多个倒计时计时器。
   */
  enterSwapping(retryAfterSec: number = 2.5): Promise<void> {
    if (this.waitPromise) {
      return this.waitPromise
    }

    this.isSwapping = true
    this.swappingCount++
    const delayMs = Math.round(Math.max(500, Math.min(120_000, retryAfterSec * 1000)))

    logger.info(
      LogCategory.SYSTEM,
      `[EngineSwapping] 进入模型置换门闩，挂起新推理请求，预估等待: ${delayMs}ms`
    )

    this.waitPromise = new Promise<void>(resolve => {
      this.swappingTimer = setTimeout(() => {
        this.exitSwapping()
        resolve()
      }, delayMs)
    })

    return this.waitPromise
  }

  /**
   * 显式解除置换门闩（例如引擎指标提前上报 ready 或超时自然到达）
   */
  exitSwapping(): void {
    if (this.swappingTimer) {
      clearTimeout(this.swappingTimer)
      this.swappingTimer = null
    }
    this.isSwapping = false
    this.waitPromise = null
    logger.info(LogCategory.SYSTEM, `[EngineSwapping] 模型置换门闩已解除，放行排队请求`)
  }

  /**
   * 重置所有状态（供单测使用）
   */
  reset(): void {
    this.exitSwapping()
    this.swappingCount = 0
  }
}

export const engineSwappingCoordinator = EngineSwappingCoordinator.getInstance()

/**
 * 统一引擎多通道高阶门闩执行器
 *
 * @param channel 通道类型：'chat'（受置换门闩保护）或 'embeddings'（独立常驻，零等待放行）
 * @param action 实际执行的推理异步闭包
 * @param coordinator 可选注入的协调器实例（便于单测隔离）
 */
export async function withEngineGate<T>(
  channel: 'chat' | 'embeddings',
  action: () => Promise<T>,
  coordinator: EngineSwappingCoordinator = engineSwappingCoordinator
): Promise<T> {
  // 1. 独立常驻 Embedding 通道：零等待直放，绝不参与语言/生图置换门闩
  if (channel === 'embeddings') {
    return action()
  }

  // 2. 语言/多模态通道：受 EngineSwappingCoordinator 集中门闩调度
  return coordinator.executeWithBarrier(async () => {
    try {
      return await action()
    } catch (err: any) {
      // 检测是否为 503 置换错误：状态码 503 且 code === 'engine_swapping' 或文案包含 swapping models
      const status =
        err?.status ||
        err?.statusCode ||
        (typeof err?.message === 'string' && err.message.includes('503') ? 503 : 0)
      const isSwappingErr =
        status === 503 &&
        (err?.code === 'engine_swapping' ||
          (typeof err?.message === 'string' &&
            (err.message.includes('swapping models') || err.message.includes('engine_swapping'))))

      if (isSwappingErr) {
        const retryAfterSec = parseRetryAfter(err?.headers?.['retry-after'], err?.eta_ms)
        logger.warn(
          LogCategory.SYSTEM,
          `[EngineGate] 捕获 503 置换响应，进入门闩退避 (预算: ${retryAfterSec}s)，免除失败计数`
        )
        await coordinator.enterSwapping(retryAfterSec)
        // 单一 waitPromise 完成后并发重试
        return action()
      }

      throw err
    }
  })
}
