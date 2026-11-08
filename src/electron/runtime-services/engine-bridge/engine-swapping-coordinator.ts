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
  state: 'ready' | 'starting' | 'processing' | 'error' | 'stopped'
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
 * 中止模型置换等待的原因描述
 */
export interface AbortSwappingReason {
  kind: 'permanent' | 'retryable' | 'cancelled'
  code: string
  message: string
}

/**
 * 模型置换等待被强行中止时抛出的错误异常
 */
export class EngineSwappingAbortError extends Error {
  readonly status: number
  readonly code: string
  readonly kind: 'permanent' | 'retryable' | 'cancelled'

  constructor(public readonly reason: AbortSwappingReason) {
    super(reason.message)
    this.name = 'EngineSwappingAbortError'
    this.kind = reason.kind
    this.code = reason.code
    // permanent 映射 500, retryable 映射 503, cancelled 映射 499
    this.status = reason.kind === 'permanent' ? 500 : reason.kind === 'retryable' ? 503 : 499
  }
}

/**
 * 引擎能力与健康状态快照（遵循 AGENTS.md §2.12：五态 starting / ready / processing / error / stopped）
 */
export interface EngineCapability {
  /** 满足 AGENTS.md §2.12：五态 starting / ready / processing / error / stopped */
  state: 'starting' | 'ready' | 'processing' | 'error' | 'stopped'
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
  private waitResolve: (() => void) | null = null
  private waitReject: ((reason?: any) => void) | null = null
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
  executeWithBarrier<T>(action: () => Promise<T>): Promise<T> {
    if (this.waitPromise) {
      return this.waitPromise.then(() => action())
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

    this.waitPromise = new Promise<void>((resolve, reject) => {
      this.waitResolve = resolve
      this.waitReject = reject
      this.swappingTimer = setTimeout(() => {
        this.exitSwapping()
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
    const resolve = this.waitResolve
    this.waitResolve = null
    this.waitReject = null
    this.isSwapping = false
    this.waitPromise = null
    if (resolve) {
      resolve()
    }
    logger.info(LogCategory.SYSTEM, `[EngineSwapping] 模型置换门闩已解除，放行排队请求`)
  }

  /**
   * 中止置换等待，向所有正在排队的请求抛出 Abort 错误（支持 permanent 500、retryable 503 与 cancelled 499）
   */
  abortSwapping(reason: AbortSwappingReason): void {
    if (this.swappingTimer) {
      clearTimeout(this.swappingTimer)
      this.swappingTimer = null
    }
    const reject = this.waitReject
    this.waitResolve = null
    this.waitReject = null
    this.isSwapping = false
    this.waitPromise = null

    if (reject) {
      reject(new EngineSwappingAbortError(reason))
    }
    logger.warn(
      LogCategory.SYSTEM,
      `[EngineSwapping] 模型置换门闩因外部事件中止 (${reason.kind}): ${reason.code} - ${reason.message}`
    )
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
 * 唯一权威的 503 模型置换错误判定原语
 * 严守系统不变量 (AGENTS.md §2.12)：HTTP 500 (ProcessStatus::Failed) 属于确定性永久错误，绝不匹配此函数！
 */
export function isEngineSwappingError(errOrResp: unknown): boolean {
  if (!errOrResp) return false

  if (typeof errOrResp === 'string') {
    if (errOrResp.includes('500') || errOrResp.includes('ProcessStatus::Failed')) {
      return false
    }
    return (
      errOrResp.includes('engine_swapping') ||
      errOrResp.includes('AI engine is swapping models') ||
      errOrResp.includes('swapping models')
    )
  }

  if (typeof errOrResp !== 'object') return false

  const obj = errOrResp as Record<string, any>
  const body = obj.data && typeof obj.data === 'object' ? obj.data : obj

  const rawStatus =
    typeof obj.status === 'number'
      ? obj.status
      : typeof obj.statusCode === 'number'
        ? obj.statusCode
        : typeof body?.error?.code === 'number'
          ? body.error.code
          : 0

  // 严守 AGENTS.md §2.12：确定性失败 HTTP 500 (ProcessStatus::Failed) 一律上浮为永久错误，绝不混入 503 置换等待
  if (rawStatus >= 500 && rawStatus !== 503) {
    return false
  }

  const errCode = body?.error?.code ?? obj.error?.code ?? body?.code ?? obj.code
  const errType = body?.error?.type ?? obj.error?.type ?? body?.type ?? obj.type
  const errMsg = [
    typeof body?.error?.message === 'string' ? body.error.message : '',
    typeof obj?.error?.message === 'string' ? obj.error.message : '',
    typeof body?.message === 'string' ? body.message : '',
    typeof obj?.message === 'string' ? obj.message : ''
  ]
    .filter(Boolean)
    .join(' ')

  if (
    errCode === 'engine_failed' ||
    errMsg.includes('ProcessStatus::Failed') ||
    errMsg.includes('AI engine failed to start')
  ) {
    return false
  }

  const hasSwappingIndicator =
    errCode === 'engine_swapping' ||
    errType === 'engine_swapping' ||
    errMsg.includes('engine_swapping') ||
    errMsg.includes('AI engine is swapping models') ||
    errMsg.includes('swapping models')

  if (!hasSwappingIndicator) {
    return false
  }

  // 若明确携带了非 503 的 HTTP 状态码（如 400/404/500），不匹配置换
  if (rawStatus > 0 && rawStatus !== 503) {
    return false
  }

  return true
}

/**
 * 将引擎端 /v1/engine/metrics 原始载荷（兼容驼峰 EngineMetricsSnapshot 与蛇形 arbiter/workers 格式）
 * 归一化为标准 EngineMetricsSnapshot
 */
export function normalizeEngineMetricsPayload(rawPayload: unknown): EngineMetricsSnapshot | null {
  if (!rawPayload || typeof rawPayload !== 'object') {
    return null
  }

  const raw = rawPayload as Record<string, any>

  const normalizeWorkerState = (
    st: unknown
  ): 'ready' | 'starting' | 'processing' | 'error' | 'stopped' => {
    if (
      st === 'ready' ||
      st === 'starting' ||
      st === 'processing' ||
      st === 'error' ||
      st === 'stopped'
    ) {
      return st
    }
    if (st === 'serving' || st === 'running' || st === 'busy') return 'processing'
    if (st === 'idle' || st === 'online') return 'ready'
    if (st === 'failed') return 'error'
    return 'stopped'
  }

  let snapshot: EngineMetricsSnapshot

  // 分支 1：已经是驼峰 EngineMetricsSnapshot 格式
  if (typeof raw.totalVramBytes === 'number' && raw.swapping && typeof raw.swapping === 'object') {
    const totalVramBytes = Math.max(0, Number(raw.totalVramBytes) || 0)
    const usedVramBytes = Math.max(0, Number(raw.usedVramBytes) || 0)
    const systemReservedVramBytes =
      typeof raw.systemReservedVramBytes === 'number'
        ? Math.max(0, raw.systemReservedVramBytes)
        : totalVramBytes > 0
          ? Math.max(1.5 * 1024 ** 3, totalVramBytes * 0.15)
          : 0
    const freeVramBytes =
      typeof raw.freeVramBytes === 'number'
        ? Math.max(0, raw.freeVramBytes)
        : Math.max(0, totalVramBytes - usedVramBytes - systemReservedVramBytes)

    const w = raw.workers && typeof raw.workers === 'object' ? raw.workers : {}
    const isSwapping =
      Boolean(raw.swapping.isSwapping) || raw.swapping.reasonCode === 'engine_swapping'

    snapshot = {
      totalVramBytes,
      usedVramBytes,
      freeVramBytes,
      systemReservedVramBytes,
      gpuName: typeof raw.gpuName === 'string' ? raw.gpuName : undefined,
      isSharedMemory:
        typeof raw.isSharedMemory === 'boolean' ? raw.isSharedMemory : totalVramBytes === 0,
      workers: {
        llm: {
          state: normalizeWorkerState(w.llm?.state ?? 'ready'),
          vramBytes: Math.max(0, Number(w.llm?.vramBytes ?? usedVramBytes) || 0),
          modelId: w.llm?.modelId,
          details: w.llm?.details
        },
        embedding: {
          state: normalizeWorkerState(w.embedding?.state ?? 'ready'),
          vramBytes: Math.max(0, Number(w.embedding?.vramBytes ?? 0) || 0),
          modelId: w.embedding?.modelId,
          details: w.embedding?.details
        },
        diffusion: {
          state: normalizeWorkerState(w.diffusion?.state ?? 'stopped'),
          vramBytes: Math.max(0, Number(w.diffusion?.vramBytes ?? 0) || 0),
          modelId: w.diffusion?.modelId,
          details: w.diffusion?.details
        },
        audio: {
          state: normalizeWorkerState(w.audio?.state ?? 'stopped'),
          vramBytes: Math.max(0, Number(w.audio?.vramBytes ?? 0) || 0),
          modelId: w.audio?.modelId,
          details: w.audio?.details
        }
      },
      swapping: {
        isSwapping,
        etaMs: typeof raw.swapping.etaMs === 'number' ? raw.swapping.etaMs : undefined,
        reasonCode: isSwapping ? 'engine_swapping' : raw.swapping.reasonCode
      }
    }
  } else {
    // 分支 2：蛇形格式（含 arbiter / hardware / 数组或对象结构 workers）
    const arb = raw.arbiter && typeof raw.arbiter === 'object' ? raw.arbiter : raw
    const hw = raw.hardware && typeof raw.hardware === 'object' ? raw.hardware : {}

    if (
      arb === raw &&
      typeof arb.vram_budget_mb !== 'number' &&
      typeof arb.vram_used_mb !== 'number' &&
      typeof arb.phase !== 'string' &&
      typeof hw.total_vram_gb !== 'number'
    ) {
      return null
    }

    const totalVramBytes =
      typeof arb.vram_budget_mb === 'number' && arb.vram_budget_mb > 0
        ? Math.round(arb.vram_budget_mb * 1024 * 1024)
        : typeof hw.total_vram_gb === 'number' && hw.total_vram_gb > 0
          ? Math.round(hw.total_vram_gb * 1024 ** 3)
          : 0

    const usedVramBytes =
      typeof arb.vram_used_mb === 'number' && arb.vram_used_mb >= 0
        ? Math.round(arb.vram_used_mb * 1024 * 1024)
        : typeof hw.used_vram_gb === 'number' && hw.used_vram_gb >= 0
          ? Math.round(hw.used_vram_gb * 1024 ** 3)
          : 0

    const systemReservedVramBytes =
      totalVramBytes > 0 ? Math.round(Math.max(1.5 * 1024 ** 3, totalVramBytes * 0.15)) : 0
    const freeVramBytes = Math.max(0, totalVramBytes - usedVramBytes - systemReservedVramBytes)

    const isSwapping =
      arb.phase === 'swapping' ||
      raw.reasonCode === 'engine_swapping' ||
      arb.reason_code === 'engine_swapping'

    const rawWorkers = arb.workers ?? raw.workers
    const defaultWorkers: EngineMetricsSnapshot['workers'] = {
      llm: {
        state:
          arb.phase === 'serving' || raw.status === 'processing'
            ? 'processing'
            : raw.status === 'starting'
              ? 'starting'
              : raw.status === 'error'
                ? 'error'
                : 'ready',
        vramBytes: usedVramBytes
      },
      embedding: { state: 'ready', vramBytes: 0 },
      diffusion: { state: 'stopped', vramBytes: 0 },
      audio: { state: 'stopped', vramBytes: 0 }
    }

    if (Array.isArray(rawWorkers)) {
      for (const item of rawWorkers) {
        if (!item || typeof item !== 'object') continue
        const slot = String(item.slot_id || item.slot || item.kind || item.id || '').toLowerCase()
        const vram =
          typeof item.vram_bytes === 'number'
            ? item.vram_bytes
            : typeof item.vram_mb === 'number'
              ? Math.round(item.vram_mb * 1024 * 1024)
              : 0
        const statusObj: EngineWorkerStatus = {
          state: normalizeWorkerState(item.state ?? item.status),
          vramBytes: Math.max(0, vram),
          modelId: item.model_id ?? item.modelId,
          details: item.details
        }
        if (slot.includes('llm') || slot.includes('chat') || slot.includes('language')) {
          defaultWorkers.llm = statusObj
        } else if (slot.includes('embed') || slot.includes('vector')) {
          defaultWorkers.embedding = statusObj
        } else if (slot.includes('diffus') || slot.includes('image')) {
          defaultWorkers.diffusion = statusObj
        } else if (slot.includes('audio') || slot.includes('tts') || slot.includes('asr')) {
          defaultWorkers.audio = statusObj
        }
      }
    } else if (rawWorkers && typeof rawWorkers === 'object') {
      for (const key of ['llm', 'embedding', 'diffusion', 'audio'] as const) {
        if (rawWorkers[key] && typeof rawWorkers[key] === 'object') {
          const item = rawWorkers[key]
          defaultWorkers[key] = {
            state: normalizeWorkerState(item.state ?? item.status),
            vramBytes: Math.max(
              0,
              Number(
                item.vramBytes ?? item.vram_bytes ?? (item.vram_mb ? item.vram_mb * 1024 * 1024 : 0)
              ) || 0
            ),
            modelId: item.modelId ?? item.model_id,
            details: item.details
          }
        }
      }
    }

    const gpuName =
      typeof hw.gpu_name === 'string' && hw.gpu_name.trim()
        ? hw.gpu_name.trim()
        : typeof raw.gpu_name === 'string' && raw.gpu_name.trim()
          ? raw.gpu_name.trim()
          : undefined
    const isSharedMemory =
      Boolean(hw.is_integrated) ||
      Boolean(raw.is_shared_memory) ||
      totalVramBytes === 0 ||
      totalVramBytes <= 0.5 * 1024 ** 3

    const etaMs =
      typeof arb.eta_ms === 'number'
        ? arb.eta_ms
        : typeof raw.eta_ms === 'number'
          ? raw.eta_ms
          : undefined

    snapshot = {
      totalVramBytes,
      usedVramBytes,
      freeVramBytes,
      systemReservedVramBytes,
      gpuName,
      isSharedMemory,
      workers: defaultWorkers,
      swapping: {
        isSwapping,
        etaMs,
        reasonCode: isSwapping ? 'engine_swapping' : undefined
      }
    }
  }

  // 联动全局置换协调器：当检测到 swapping.isSwapping === false 且处于置换中时，提前解除门闩放行排队请求
  if (snapshot.swapping.isSwapping) {
    const retryAfter = parseRetryAfter(null, snapshot.swapping.etaMs)
    engineSwappingCoordinator.enterSwapping(retryAfter)
  } else if (engineSwappingCoordinator.isInSwapping()) {
    engineSwappingCoordinator.exitSwapping()
  }

  return snapshot
}

/**
 * 根据请求 URL 路径与 Origin 自动判定引擎门闩通道：
 * - 外部云端请求（非 localhost / 127.0.0.1）-> null（完全放行，免除本地引擎置换门闩）
 * - 包含 '/v1/embeddings' 或 '/api/v1/vector' -> 'embeddings'（独立常驻，零等待直放）
 * - '/v1/engine/metrics' -> null（探活与指标读取端点直通）
 * - 其余 '/v1/*' 推理端点 -> 'chat'（受 EngineSwappingCoordinator 门闩保护）
 */
export function resolveEngineGateChannel(
  urlOrPath: string,
  localBaseUrl?: string
): 'chat' | 'embeddings' | null {
  if (!urlOrPath || typeof urlOrPath !== 'string') {
    return null
  }

  let pathname = urlOrPath.toLowerCase()

  // 1. 尝试 URL 解析做 Origin 校验，防止云端自定义 API 被本地置换门闩误拦截
  try {
    const parsed = new URL(urlOrPath, localBaseUrl || 'http://127.0.0.1:38400')
    const hostname = parsed.hostname.toLowerCase()
    const isLocal =
      hostname === '127.0.0.1' ||
      hostname === 'localhost' ||
      hostname === '::1' ||
      hostname === '[::1]'

    // 非本机回环地址（如 api.openai.com 等外部云端提供商），直接放行
    if (!isLocal) {
      return null
    }

    pathname = parsed.pathname.toLowerCase()
  } catch {
    // URL 解析失败时降级走原始路径字串匹配
  }

  if (pathname.includes('/v1/embeddings') || pathname.includes('/api/v1/vector')) {
    return 'embeddings'
  }
  if (pathname.includes('/v1/engine/metrics')) {
    return null
  }
  if (pathname.includes('/v1/')) {
    return 'chat'
  }
  return null
}

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

  // 2. 语言/多模态通道：受 EngineSwappingCoordinator 集中门闩调度（支持 120s 预算内循环等待屏障）
  const deadline = Date.now() + 120_000
  while (true) {
    try {
      return await coordinator.executeWithBarrier(action)
    } catch (err: any) {
      if (isEngineSwappingError(err) && Date.now() < deadline) {
        const etaMs = err?.error?.eta_ms ?? err?.data?.error?.eta_ms ?? err?.eta_ms
        const retryAfterSec = parseRetryAfter(err?.headers?.['retry-after'], etaMs)
        logger.warn(
          LogCategory.SYSTEM,
          `[EngineGate] 捕获 503 置换响应，进入门闩退避 (预算: ${retryAfterSec}s)，免除失败计数`
        )
        await coordinator.enterSwapping(retryAfterSec)
        // 单一 waitPromise 完成后进入下一轮屏障重试
        continue
      }

      throw err
    }
  }
}

/**
 * 统一引擎传输层门闩自动分发器（按 URL 自动识别通道：/v1/embeddings 零等待直放，其余 /v1/* 进入 chat 门闩）
 */
export async function executeWithEngineTransportGate<T>(
  urlOrPath: string,
  action: () => Promise<T>,
  coordinator: EngineSwappingCoordinator = engineSwappingCoordinator,
  localBaseUrl?: string
): Promise<T> {
  const channel = resolveEngineGateChannel(urlOrPath, localBaseUrl)
  if (!channel) {
    return action()
  }
  return withEngineGate(channel, action, coordinator)
}

// 挂载至全局对象，供跨包传输层 (如 @firefly/electron-llamaIndex-service 的 HttpClient) 零循环依赖共享同一门闩协调器
if (typeof globalThis !== 'undefined') {
  ;(globalThis as any).__fireflyEngineTransportGateRunner = executeWithEngineTransportGate
}
