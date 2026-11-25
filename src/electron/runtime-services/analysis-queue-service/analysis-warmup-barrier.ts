import path from 'node:path'
import { FileCategory, LogCategory, getFileCategory, logger } from '@firefly/shared'
import type {
  AnalysisMode,
  AnalysisQueueItem,
  BatchWarmupPlan,
  QueueLifecyclePhase,
  ServerCapabilitySnapshot,
  StageReuseDecision,
  WarmupHintCode
} from '@firefly/types'
import { isAiStageEnabled } from '@app/electron/config/analysis-mode'
import type { EffectiveWorkspaceAIConfigResult } from '../system/workspace-analysis-context'
import { StageReusePlanner, resolveTargetProfileAndDim } from './file-processor/stage-reuse-planner'

export const PLAN_CHUNK_SIZE = 256
export const DISPATCH_WINDOW_SIZE = 64

const OFFICE_EXTS = new Set([
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  '.wps',
  '.et',
  '.dps',
  '.pdf'
])

function createAbortError(): Error {
  const err = new Error('Aborted')
  err.name = 'AbortError'
  return err
}

export function isWarmupAbortError(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string; code?: string; message?: string }
  return e.name === 'AbortError' || e.code === 'ABORT_ERR' || e.message === 'Aborted'
}

/**
 * 批次规划会话状态（Spec §2.1 / §3.1）
 * - 维护单一权威复用规划映射 `decisions`（按 256 项增量 SQL+向量批量探活填充）
 * - 保证派发给 `deriveWindowWarmupPlan` 与 `runParallel` 的 `windowItems` (K<=64) 100% 同源
 */
export function buildWarmupConfigSignature(
  effectiveConfig: EffectiveWorkspaceAIConfigResult,
  profileInfo = resolveTargetProfileAndDim()
): string {
  const p = effectiveConfig.effectiveParams
  const c = effectiveConfig.capabilities
  return [
    profileInfo.profile,
    profileInfo.targetDim,
    p.analysisMode,
    p.reuseBasicAnalysisData ? '1' : '0',
    p.enableImageOcr ? '1' : '0',
    p.ocrModelSize,
    p.maxDocumentOcrItems,
    p.enableOfficeCover ? '1' : '0',
    c.videoVisualAnalysisEnabled ? '1' : '0',
    c.nsfwEffectivelyEnabled ? '1' : '0',
    c.asrEffectivelyEnabled ? '1' : '0',
    p.videoAsrDurationSec,
    p.audioAnalysisDurationSec
  ].join('|')
}

export class BatchPlanSession {
  readonly decisions = new Map<number, StageReuseDecision>()
  private plannedWorkspaceId: number | null = null
  private plannedConfigSignature: string | null = null
  private plannedRevision = 0

  invalidateItem(itemId: number): void {
    this.decisions.delete(itemId)
  }

  invalidateItems(itemIds: ReadonlyArray<number>): void {
    for (const id of itemIds) {
      this.decisions.delete(id)
    }
  }

  clear(): void {
    this.decisions.clear()
    this.plannedWorkspaceId = null
    this.plannedConfigSignature = null
    this.plannedRevision += 1
  }

  getDecision(itemId: number): StageReuseDecision | undefined {
    return this.decisions.get(itemId)
  }

  /**
   * 为窗口前端切片 (`<= 256` 项) 补齐规划决策；若工作区或配置签名变化则先清空旧决策。
   */
  async planChunkForWindow(
    db: any,
    workspaceId: number,
    pendingItems: ReadonlyArray<AnalysisQueueItem>,
    effectiveConfig: EffectiveWorkspaceAIConfigResult,
    plannerFn: typeof StageReusePlanner.planBatch = StageReusePlanner.planBatch,
    configSignature: string = buildWarmupConfigSignature(effectiveConfig)
  ): Promise<void> {
    if (
      (this.plannedWorkspaceId !== null && this.plannedWorkspaceId !== workspaceId) ||
      (this.plannedConfigSignature !== null && this.plannedConfigSignature !== configSignature)
    ) {
      this.decisions.clear()
    }
    this.plannedWorkspaceId = workspaceId
    this.plannedConfigSignature = configSignature

    const unplanned = pendingItems
      .filter(item => item.itemType !== 'directory' && !this.decisions.has(item.id))
      .slice(0, PLAN_CHUNK_SIZE)

    if (unplanned.length === 0 || !db) return

    try {
      const planned = await plannerFn(db, workspaceId, unplanned, effectiveConfig)
      for (const [id, decision] of planned.entries()) {
        this.decisions.set(id, decision)
      }
    } catch (err) {
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        '[BatchPlanSession] 批量复用规划异常，回退逐项未规划路径:',
        err
      )
    }
  }

  /**
   * 抽取下一个同源执行窗口（K <= 64）：严格保持排队顺序，共享给 `deriveWindowWarmupPlan` 与 `runParallel`。
   */
  takeWindow(
    pendingItems: ReadonlyArray<AnalysisQueueItem>,
    limit = DISPATCH_WINDOW_SIZE
  ): AnalysisQueueItem[] {
    if (pendingItems.length === 0) return []
    return pendingItems.slice(0, Math.max(1, limit))
  }
}

/**
 * 基于当前 K<=64 执行窗口内「实际需要进入 CPU/AI 的文件」推导精确预热能力向量（Spec §2.1 / §3.1）。
 * 跳过项（`skipCpu === true`）绝不拉起多余 OCR/视觉/ASR 塔。
 */
export function deriveWindowWarmupPlan(
  windowItems: ReadonlyArray<AnalysisQueueItem>,
  decisions: ReadonlyMap<number, StageReuseDecision>,
  effectiveConfig: EffectiveWorkspaceAIConfigResult,
  options: {
    aiServiceMode: string
    isCpuEngine: boolean
    isParallelDispatch: boolean
  }
): BatchWarmupPlan {
  let needsVisionTower = false
  let needsNsfw = false
  let needsImageOcr = false
  let needsAsr = false
  let needsStage3Ai = false

  const analysisMode = effectiveConfig.effectiveParams.analysisMode
  const aiStageEnabled = isAiStageEnabled(analysisMode)

  for (const item of windowItems) {
    if (item.itemType === 'directory') continue
    if (aiStageEnabled) {
      needsStage3Ai = true
    }

    const decision = decisions.get(item.id)
    if (decision?.skipCpu) continue

    const filePath = (item as any).file_path || item.path || item.name || ''
    const cat = getFileCategory(filePath)
    const ext = path.extname(filePath).toLowerCase()

    if (cat === FileCategory.IMAGE) {
      needsVisionTower = true
      if (effectiveConfig.capabilities.nsfwEffectivelyEnabled) {
        needsNsfw = true
      }
      if (effectiveConfig.effectiveParams.enableImageOcr) {
        needsImageOcr = true
      }
    } else if (cat === FileCategory.VIDEO) {
      if (effectiveConfig.capabilities.videoVisualAnalysisEnabled) {
        needsVisionTower = true
        if (effectiveConfig.capabilities.nsfwEffectivelyEnabled) {
          needsNsfw = true
        }
        if (effectiveConfig.effectiveParams.enableImageOcr) {
          needsImageOcr = true
        }
      }
      if (
        effectiveConfig.capabilities.asrEffectivelyEnabled &&
        effectiveConfig.effectiveParams.videoAsrDurationSec > 0
      ) {
        needsAsr = true
      }
    } else if (cat === FileCategory.AUDIO) {
      if (
        effectiveConfig.capabilities.asrEffectivelyEnabled &&
        effectiveConfig.effectiveParams.audioAnalysisDurationSec > 0
      ) {
        needsAsr = true
      }
    } else if (
      (cat === FileCategory.DOCUMENT || OFFICE_EXTS.has(ext)) &&
      effectiveConfig.effectiveParams.enableImageOcr &&
      effectiveConfig.effectiveParams.maxDocumentOcrItems !== 0
    ) {
      needsImageOcr = true
    }
  }

  const ocrSizeRaw = effectiveConfig.effectiveParams.ocrModelSize
  const ocrModelSize: 'tiny' | 'small' | undefined = needsImageOcr
    ? ocrSizeRaw === 'small'
      ? 'small'
      : 'tiny'
    : undefined

  // OD-2 正交兼容：`local` 并行模式下 stage3AiMode 为 null（保持非阻塞与 Stage 1/2 并发预热），
  // 仅 cpu / 串行单轨非 simple 模式下同步预热 Stage 3
  const stage3AiMode: AnalysisMode | null =
    needsStage3Ai &&
    (!options.isParallelDispatch || options.isCpuEngine || options.aiServiceMode === 'cpu')
      ? analysisMode
      : null

  return {
    textAndLexicon: true,
    visionTower: needsVisionTower,
    nsfwDetector: needsNsfw,
    imageOcr: needsImageOcr,
    ...(ocrModelSize ? { ocrModelSize } : {}),
    asrModule: needsAsr,
    stage3AiMode
  }
}

/**
 * Spec §2.1 #1：`hintCode` 完全由本次 `BatchWarmupPlan` 决定，不随缓存快照摆动。
 */
export function resolveWarmupHintCode(plan: BatchWarmupPlan): WarmupHintCode {
  const requestsHeavyModel =
    plan.visionTower ||
    plan.nsfwDetector ||
    plan.imageOcr ||
    plan.asrModule ||
    plan.stage3AiMode !== null

  return requestsHeavyModel ? 'loading_models' : 'preparing'
}

export function hasUnreadyRequestedCapability(
  plan: BatchWarmupPlan,
  snapshot: ServerCapabilitySnapshot | null,
  embeddingProfile: string
): boolean {
  return (
    !snapshot ||
    snapshot.embeddingProfile !== embeddingProfile ||
    (plan.visionTower && !snapshot.visionReady) ||
    (plan.nsfwDetector && !snapshot.nsfwReady) ||
    (plan.imageOcr && plan.ocrModelSize !== snapshot.lastOcrSize) ||
    (plan.asrModule && !snapshot.asrReady) ||
    (plan.stage3AiMode !== null && !snapshot.cpuStage3Ready)
  )
}

export interface WarmupBarrierDeps {
  warmupOmniEngine: (
    plan: BatchWarmupPlan,
    signal: AbortSignal
  ) => Promise<{
    ready: boolean
    visionReady: boolean
    nsfwReady: boolean
    ocrReady: boolean
  } | null>
  warmupAsrModule: (signal: AbortSignal) => Promise<boolean>
  acquireAsrLease: () => { release: () => void }
  acquireStage3Capability: (mode: AnalysisMode, signal: AbortSignal) => Promise<boolean>
  getCurrentEmbeddingProfile: () => string
  delayedUiThresholdMs?: number
}

export interface WarmupBarrierResult {
  asrLease: { release: () => void } | null
  phaseEnteredWarmingUp: boolean
  hintCode: WarmupHintCode
}

/**
 * 批量分析预热栅栏（Spec §2.1 / §3.1）：
 * - 300ms 延迟触发 `warming_up` UI 相位（热驻留零闪烁直通 `'analyzing'`）
 * - Omni / ASR / Stage 3 Fail-Open 放行，绝不因模型缺失卡死队列；Abort 立即上抛抢占
 * - 含 ASR 窗口在全窗口期持有 `asrLease`，窗口结束后由调用方释放并进入 coordinator 5s 宽限期
 */
export class AnalysisWarmupBarrier {
  private lastSnapshot: ServerCapabilitySnapshot | null = null

  getSnapshot(): ServerCapabilitySnapshot | null {
    return this.lastSnapshot
  }

  resetSnapshot(): void {
    this.lastSnapshot = null
  }

  async run(
    plan: BatchWarmupPlan,
    signal: AbortSignal,
    deps: WarmupBarrierDeps,
    onPhaseChange: (phase: QueueLifecyclePhase, hintCode?: WarmupHintCode) => void
  ): Promise<WarmupBarrierResult> {
    if (signal.aborted) {
      throw createAbortError()
    }

    const embeddingProfile = deps.getCurrentEmbeddingProfile()
    const hintCode = resolveWarmupHintCode(plan)
    const needsImmediateWarmupUi = hasUnreadyRequestedCapability(
      plan,
      this.lastSnapshot,
      embeddingProfile
    )
    const delayMs = deps.delayedUiThresholdMs ?? 300

    let phaseEnteredWarmingUp = false
    let settled = false
    let asrLease: { release: () => void } | null = null
    let timer: ReturnType<typeof setTimeout> | null = null

    if (needsImmediateWarmupUi) {
      phaseEnteredWarmingUp = true
      onPhaseChange('warming_up', hintCode)
    } else {
      timer = setTimeout(() => {
        if (!settled && !signal.aborted) {
          phaseEnteredWarmingUp = true
          onPhaseChange('warming_up', hintCode)
        }
      }, delayMs)
      timer.unref?.()
    }

    try {
      let nextVisionReady = this.lastSnapshot?.visionReady ?? false
      let nextNsfwReady = this.lastSnapshot?.nsfwReady ?? false
      let nextLastOcrSize = this.lastSnapshot?.lastOcrSize
      let nextAsrReady = this.lastSnapshot?.asrReady ?? false
      let nextCpuStage3Ready = this.lastSnapshot?.cpuStage3Ready ?? false

      const tasks: Promise<void>[] = []

      // 1. Omni /api/v1/engine/warmup（Fail-Open；失败或非 2xx 时将所请求能力复位为未就绪）
      const resetRequestedOmniCaps = () => {
        if (plan.visionTower) nextVisionReady = false
        if (plan.nsfwDetector) nextNsfwReady = false
        if (plan.imageOcr) nextLastOcrSize = undefined
      }
      tasks.push(
        (async () => {
          try {
            const res = await deps.warmupOmniEngine(plan, signal)
            if (res) {
              if (plan.visionTower) nextVisionReady = res.visionReady
              if (plan.nsfwDetector) nextNsfwReady = res.nsfwReady
              if (plan.imageOcr) {
                nextLastOcrSize = res.ocrReady ? plan.ocrModelSize : undefined
              }
            } else {
              resetRequestedOmniCaps()
            }
          } catch (err) {
            if (isWarmupAbortError(err, signal)) throw err
            resetRequestedOmniCaps()
            logger.warn(
              LogCategory.ANALYSIS_QUEUE,
              '[WarmupBarrier] Omni 预热失败，Fail-Open 放行:',
              err
            )
          }
        })()
      )

      // 2. 跨窗口 ASR 租约与模块预拉起（Fail-Open）
      if (plan.asrModule) {
        asrLease = deps.acquireAsrLease()
        tasks.push(
          (async () => {
            try {
              const ok = await deps.warmupAsrModule(signal)
              nextAsrReady = ok
            } catch (err) {
              if (isWarmupAbortError(err, signal)) throw err
              nextAsrReady = false
              logger.warn(
                LogCategory.ANALYSIS_QUEUE,
                '[WarmupBarrier] ASR 模块预热失败，Fail-Open 放行:',
                err
              )
            }
          })()
        )
      }

      // 3. 仅 cpu / 串行非 simple 模式同步预热 Stage 3（local 并行下 stage3AiMode === null）
      if (plan.stage3AiMode !== null) {
        const mode = plan.stage3AiMode
        tasks.push(
          (async () => {
            try {
              nextCpuStage3Ready = await deps.acquireStage3Capability(mode, signal)
            } catch (err) {
              if (isWarmupAbortError(err, signal)) throw err
              nextCpuStage3Ready = false
              logger.warn(
                LogCategory.ANALYSIS_QUEUE,
                '[WarmupBarrier] Stage 3 预热失败，Fail-Open 放行:',
                err
              )
            }
          })()
        )
      }

      await Promise.all(tasks)

      if (signal.aborted) {
        throw createAbortError()
      }

      this.lastSnapshot = {
        embeddingProfile,
        ...(nextLastOcrSize ? { lastOcrSize: nextLastOcrSize } : {}),
        visionReady: nextVisionReady,
        nsfwReady: nextNsfwReady,
        asrReady: nextAsrReady,
        cpuStage3Ready: nextCpuStage3Ready
      }

      return {
        asrLease,
        phaseEnteredWarmingUp,
        hintCode
      }
    } catch (err) {
      asrLease?.release()
      asrLease = null
      throw err
    } finally {
      settled = true
      if (timer) clearTimeout(timer)
    }
  }
}
