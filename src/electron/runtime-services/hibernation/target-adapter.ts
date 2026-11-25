/**
 * HibernationTargetAdapter — 策略模式隔离 `engine_service`（OS 进程树）与 `omni_module`（Omni 进程内 HTTP 会话）
 * 遵循 L3 规格书: docs/specs/omni-lifecycle-stability-and-video-pipeline-opt-spec.md §2.2 & §3.2
 */

import { logger, LogCategory } from '@firefly/shared'
import {
  HIBERNATABLE_TARGET_CATALOG,
  HibernationColdStartError,
  HibernationGateAbortedError,
  HibernationTargetType,
  IEngineBridgeService,
  OmniModuleLoadResult,
  ProcessTreeIdentity
} from './types'

/** 纯函数：将 `/v1/modules/:id/session` 的 HTTP 响应映射为标准 OmniModuleLoadResult（供单测与适配器共用） */
export function classifyOmniModuleLoadHttpResponse(
  targetId: string,
  status: number,
  body?: Record<string, unknown> | null
): OmniModuleLoadResult {
  const errMsg = typeof body?.error === 'string' ? body.error : undefined
  if (status >= 200 && status < 300) {
    const est = HIBERNATABLE_TARGET_CATALOG[targetId]?.estimatedMemoryBytes ?? 0
    const rawBytes = Number(body?.residentBytes)
    return {
      outcome: 'ok',
      residentBytes: Number.isFinite(rawBytes) && rawBytes > 0 ? rawBytes : est,
      httpStatus: status
    }
  }
  if (status === 503 && errMsg === 'MODULE_NOT_INSTALLED') {
    return {
      outcome: 'not_installed',
      residentBytes: 0,
      httpStatus: status,
      error: errMsg
    }
  }
  if (status === 409) {
    return {
      outcome: 'aborted',
      residentBytes: 0,
      httpStatus: status,
      error: errMsg || 'LOAD_SUPERSEDED'
    }
  }
  if (status === 404 || status === 405) {
    return {
      outcome: 'unreachable',
      residentBytes: 0,
      httpStatus: status,
      error: errMsg || `HTTP_${status}`
    }
  }
  if (status >= 500) {
    return {
      outcome: 'failed',
      residentBytes: 0,
      httpStatus: status,
      error: errMsg || `HTTP_${status}`
    }
  }
  return {
    outcome: 'unreachable',
    residentBytes: 0,
    httpStatus: status,
    error: errMsg || `HTTP_${status}`
  }
}

export interface ProcessTargetLoadOutcome {
  readonly kind: 'process'
  readonly identity: ProcessTreeIdentity
  readonly jobHandle?: string
}

export interface HttpModuleTargetLoadOutcome {
  readonly kind: 'http_module'
  readonly residentBytes: number
  readonly capturedGeneration?: number
}

export type AdapterLoadOutcome = ProcessTargetLoadOutcome | HttpModuleTargetLoadOutcome

export interface AdapterLoadContext {
  readonly targetId: string
  readonly modelId?: string
  readonly signal: AbortSignal
  readonly onProgress: () => void
  readonly bridge: IEngineBridgeService
  readonly onCapturedGeneration?: (gen: number) => void
  readonly getOmniGeneration?: () => number | undefined
}

export interface AdapterDrainContext {
  readonly targetId: string
  readonly residentBytesAtEntry: number
  readonly bridge?: IEngineBridgeService
}

export interface IHibernationTargetAdapter {
  readonly targetType: HibernationTargetType
  load(ctx: AdapterLoadContext): Promise<AdapterLoadOutcome>
  drainHttp?(ctx: AdapterDrainContext): Promise<{ ok: boolean; releasedBytes: number }>
  probeStatus(
    targetId: string,
    bridge?: IEngineBridgeService
  ): Promise<'resident' | 'hibernated' | 'unknown'>
}

export class EngineServiceAdapter implements IHibernationTargetAdapter {
  readonly targetType: HibernationTargetType = 'engine_service'

  async load(ctx: AdapterLoadContext): Promise<AdapterLoadOutcome> {
    if (!ctx.bridge.loadModel) {
      throw new Error(`EngineBridgeService 不支持 loadModel: targetId=${ctx.targetId}`)
    }
    const res = await ctx.bridge.loadModel(ctx.targetId, ctx.modelId, {
      signal: ctx.signal,
      onProgress: ctx.onProgress
    })
    return {
      kind: 'process',
      identity: res.identity,
      jobHandle: res.jobHandle
    }
  }

  async probeStatus(
    targetId: string,
    bridge?: IEngineBridgeService
  ): Promise<'resident' | 'hibernated' | 'unknown'> {
    if (!bridge) return 'unknown'
    if (typeof bridge.isServiceRunning === 'function') {
      return bridge.isServiceRunning(targetId) ? 'resident' : 'hibernated'
    }
    return 'unknown'
  }
}

export class OmniModuleAdapter implements IHibernationTargetAdapter {
  readonly targetType: HibernationTargetType = 'omni_module'

  async load(ctx: AdapterLoadContext): Promise<AdapterLoadOutcome> {
    if (!ctx.bridge.loadOmniModule) {
      throw new HibernationGateAbortedError(
        ctx.targetId,
        'SERVICE_UNAVAILABLE',
        `EngineBridgeService 不支持 loadOmniModule: targetId=${ctx.targetId}`
      )
    }

    // 必须在 POST /v1/modules/:id/session 发出前捕获当前 Omni 实例代际
    const capturedGeneration = ctx.getOmniGeneration?.()
    if (typeof capturedGeneration === 'number') {
      ctx.onCapturedGeneration?.(capturedGeneration)
    }

    const res = await ctx.bridge.loadOmniModule(ctx.targetId, { signal: ctx.signal })

    if (res.outcome === 'ok') {
      // 若加载耗时期间 Omni 实例发生过重建/换代，按 aborted 处置，严禁写入 resident
      const afterGen = ctx.getOmniGeneration?.()
      if (
        typeof capturedGeneration === 'number' &&
        typeof afterGen === 'number' &&
        afterGen !== capturedGeneration
      ) {
        throw new HibernationGateAbortedError(
          ctx.targetId,
          'LOAD_ABORTED',
          `Omni 实例代际在模块加载期间发生变化 (${capturedGeneration} -> ${afterGen})`
        )
      }
      ctx.onProgress()
      return {
        kind: 'http_module',
        residentBytes:
          res.residentBytes > 0
            ? res.residentBytes
            : (HIBERNATABLE_TARGET_CATALOG[ctx.targetId]?.estimatedMemoryBytes ?? 0),
        capturedGeneration
      }
    }

    if (res.outcome === 'not_installed') {
      throw new HibernationGateAbortedError(
        ctx.targetId,
        'MODULE_NOT_INSTALLED',
        res.error || `Omni 模块未安装: ${ctx.targetId}`
      )
    }

    if (res.outcome === 'aborted') {
      throw new HibernationGateAbortedError(
        ctx.targetId,
        'LOAD_ABORTED',
        res.error || `Omni 模块加载被中断或被取代: ${ctx.targetId}`
      )
    }

    if (res.outcome === 'unreachable') {
      logger.warn(
        LogCategory.SYSTEM,
        `[OmniModuleAdapter] 加载通道暂不可达 (不计入崩溃熔断): targetId=${ctx.targetId}, status=${res.httpStatus ?? 'network'}, error=${res.error ?? 'unknown'}`
      )
      throw new HibernationGateAbortedError(
        ctx.targetId,
        'SERVICE_UNAVAILABLE',
        res.error || `Omni 服务暂不可达: ${ctx.targetId}`
      )
    }

    // 仅可达 Omni 返回的非预期 5xx（或显式 failed/drain_timeout）允许计入 crashStreak
    throw new HibernationColdStartError(
      ctx.targetId,
      'LOAD_FAILED',
      res.error || `Omni 模块冷启动失败 (HTTP ${res.httpStatus ?? 500}): ${ctx.targetId}`
    )
  }

  async drainHttp(ctx: AdapterDrainContext): Promise<{ ok: boolean; releasedBytes: number }> {
    let actualReleasedBytes = ctx.residentBytesAtEntry
    try {
      const drainRes = await ctx.bridge?.drainOmniModule?.(ctx.targetId, {
        waitDrainMs: 3000
      })
      if (drainRes && drainRes.releasedBytes > 0) {
        actualReleasedBytes = drainRes.releasedBytes
      }
    } catch (err) {
      logger.warn(
        LogCategory.SYSTEM,
        `[Coordinator] omni_module 卸载调用失败，回落目录估值: targetId=${ctx.targetId}`,
        err
      )
    }
    return { ok: true, releasedBytes: actualReleasedBytes }
  }

  async probeStatus(
    targetId: string,
    bridge?: IEngineBridgeService
  ): Promise<'resident' | 'hibernated' | 'unknown'> {
    if (!bridge?.getOmniModuleStatus) {
      return 'unknown'
    }
    const status = await bridge.getOmniModuleStatus(targetId)
    if (status.probeStatus === 'timeout') {
      logger.warn(
        LogCategory.SYSTEM,
        `[OmniModuleAdapter] 状态探测超时，保持现有快照不变: targetId=${targetId}`
      )
      return 'unknown'
    }
    if (!status.serviceReachable) {
      return 'unknown'
    }
    return status.loaded ? 'resident' : 'hibernated'
  }
}

const engineServiceAdapter = new EngineServiceAdapter()
const omniModuleAdapter = new OmniModuleAdapter()

export function resolveHibernationTargetAdapter(targetId: string): IHibernationTargetAdapter {
  const meta = HIBERNATABLE_TARGET_CATALOG[targetId]
  return meta?.type === 'omni_module' ? omniModuleAdapter : engineServiceAdapter
}
