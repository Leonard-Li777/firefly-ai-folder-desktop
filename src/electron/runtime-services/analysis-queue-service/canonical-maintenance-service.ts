import { LogCategory, logger } from '@firefly/shared'
import {
  ENCODER_ID,
  ENCODER_FILTER_CLASSIC_384,
  ENCODER_FILTER_GEMMA,
  omniClient,
  type OmniVectorGetItem,
  type OmniVectorGetResponse
} from '../../services/omni-client'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import {
  CanonicalDao,
  type CanonicalSourceData,
  type CanonicalVectorState
} from '../database/dao/canonical-dao'
import { databaseService } from '../database/database-service'
import { omniService } from '../system/omni-service'
import { isTextlessImage, normalizeGemmaDim, canonicalTextService } from './canonical-text-service'

/**
 * canonical 档位切换维护服务（vector-semantic-text-unified-scheme §3.10 / AC6）。
 *
 * 职责（与 canonical-text-service 的状态机语义严格分离，本服务不改状态机）：
 * 1. **状态失效**：档位/维度变化后，把 `ready`/`visual_only` 行按批置 `pending`
 *    （`skipped` 不动、`canonical_text` 保留），否则回填只扫 NULL/pending/failed，
 *    `ready` 行永不重算 → 切档后文本检索静默为空。
 * 2. **物理向量探活**：按当前档位全部活跃槽位校验 encoder；切换动作另触发一次
 *    512 视觉槽探活。异空间/缺失 → `vector_encoder_mismatch_${actual}` 并入重析队列。
 * 3. **有界回填**：扫描 `NULL/pending/failed`，每批 32、并发 1、分析队列忙碌时暂停，
 *    可断点续跑；只重建 canonical 文本向量。
 *
 * 硬约束：
 * - 所有失败只 warn，**不抛异常、不弹错误、不阻断分析队列**；
 * - 不重析有 OCR/正文的图片（已知缺口），不造成无限重析；
 * - 重建完成前查询只返回匹配项，但计数/日志必须可见（禁止静默空召回）。
 */

/** 批量大小（方案 §3.10：按批 32） */
export const CANONICAL_MAINTENANCE_BATCH_SIZE = 32

/** 回填并发上限（方案 §3.10：并发 1） */
export const CANONICAL_BACKFILL_CONCURRENCY = 1

/** 单次维护任务内探活推进的批数上限（防止长任务独占事件循环） */
const PROBE_MAX_BATCHES_PER_SLOT = 64

/** 重析原因前缀（方案 §3.10 / AC6：异空间必须可观测） */
export const VECTOR_ENCODER_MISMATCH_PREFIX = 'vector_encoder_mismatch_'

/** 单个槽位探活规格 */
export interface SlotProbeSpec {
  /** 探活维度（Omni getVectors 的 dim） */
  dim: number
  /** 允许的 encoder_id 白名单（缺失即异空间） */
  allowedEncoders: ReadonlyArray<number>
  /** 候选指纹来源：canonical=已分析全集（文本槽），image=图片分组（视觉槽） */
  source: 'canonical' | 'image'
  /** 槽位标签，用于日志与 mismatch 归因 */
  label: string
}

/** 单批次探活结果 */
export interface SlotProbeBatchResult {
  label: string
  dim: number
  /** 指纹在白名单内 */
  matched: number
  /** 指纹在槽位但 encoder 不在白名单（异空间） */
  mismatched: number
  /** 指纹在槽位无记录 */
  missing: number
  /** 已知缺口（有 OCR/正文的图片），主动跳过不计入 mismatch */
  knownGap: number
  /** 本轮实际送入重析队列的指纹数 */
  requeued: number
  /** mismatch 原因明细（`vector_encoder_mismatch_${actual}`，无 encoder 时为 `_missing`） */
  reasons: string[]
  /** 续跑游标；null 表示该槽位已推进完 */
  nextCursor: string | null
}

/** 单批次回填结果 */
export interface BackfillBatchResult {
  /** 本批候选指纹数 */
  candidates: number
  /** 本批实际固化成功的指纹数 */
  solidified: number
  /** 因分析队列忙碌而暂停（未处理任何候选） */
  paused: boolean
  /** 续跑游标；null 表示回填已推进完 */
  nextCursor: string | null
}

/** 重建计数（供设置页展示，方案 §3.10「禁止静默空召回」） */
export interface CanonicalRebuildCounts {
  pending: number
  ready: number
  visualOnly: number
  skipped: number
  failed: number
  /** 从未计算（canonical_vector_state IS NULL） */
  uncomputed: number
  /** 最近一次维护任务的摘要 */
  lastMaintenance: {
    reason: string
    at: number
    invalidated: number
    requeued: number
  } | null
}

/** 维护服务依赖（可注入，便于单测隔离 Omni 与 DB） */
export interface CanonicalMaintenanceDeps {
  resolveDao(): CanonicalDao
  resolveProfile(): Promise<'classic_light' | 'gemma_unified'>
  resolveGemmaDim(): number
  /** CLIP 文本/图像通道是否启用（classic 档位下决定是否探活 512 视觉槽） */
  isClipEnabled(): boolean
  /** 批量读取向量（Omni getVectors） */
  getVectors(fileFingerprints: string[], dim: number): Promise<OmniVectorGetResponse | null>
  /** 加载 canonical 源数据（仅用于判定图片是否有字 = 已知缺口） */
  loadSourceData(fileFingerprint: string): CanonicalSourceData
  /** 固化单个指纹（复用 canonical-text-service，禁在本服务内重写状态机） */
  solidify(fileFingerprint: string): Promise<unknown>
  /** 分析队列是否有待处理任务（忙碌则回填暂停） */
  isQueueBusy(): Promise<boolean>
  /** 把指纹送入重析队列（forceReanalyze） */
  enqueueReanalysis(
    inputs: Array<{ path: string; name: string; size: number; type: string }>
  ): Promise<void>
  /** 时钟（测试可注入） */
  now(): number
}

/** 默认依赖：真实 DB DAO + 真实 Omni 通道 + 真实分析队列 */
export function createDefaultMaintenanceDeps(): CanonicalMaintenanceDeps {
  return {
    resolveDao: () => {
      const db = databaseService.db
      if (!db) throw new Error('数据库尚未初始化，无法解析 canonical DAO')
      return new CanonicalDao(db)
    },
    resolveProfile: () => omniService.getEmbeddingProfile(),
    resolveGemmaDim: () => {
      const configured = ConfigOrchestrator.getInstance().getValue<number>('EMBEDDING_MRL_DIMENSION')
      return normalizeGemmaDim(configured)
    },
    // CLIP 开关由工单 12/13 落地为正式 ConfigKey；此处先按既有 `as any` 口径读取，
    // 键缺失时返回 false（classic 档不探活 512 视觉槽），不影响本工单其余 AC。
    isClipEnabled: () => {
      const value = ConfigOrchestrator.getInstance().getValue<string | boolean>(
        'AI_CLIP_TEXT_SEARCH_ENABLED' as any
      )
      return value === true || value === 'true'
    },
    getVectors: (fileFingerprints, dim) => omniClient.getVectors(fileFingerprints, dim),
    loadSourceData: fileFingerprint => {
      const db = databaseService.db
      if (!db) throw new Error('数据库尚未初始化，无法加载 canonical 源数据')
      return new CanonicalDao(db).loadCanonicalSourceData(fileFingerprint)
    },
    solidify: fileFingerprint => canonicalTextService.solidify(fileFingerprint),
    // 动态 import：本模块被 file-processor 引用，而 analysis-queue-service/index.ts
    // 又引用 file-processor，静态 import 会形成模块环。运期解析即可，且天然惰性。
    isQueueBusy: async () => {
      const { analysisQueueService } = await import('./index')
      return analysisQueueService.hasPendingItems()
    },
    enqueueReanalysis: async inputs => {
      if (inputs.length === 0) return
      const { analysisQueueService } = await import('./index')
      await analysisQueueService.addItems(
        inputs.map(i => ({ ...i, forceReanalyze: true })),
        true
      )
    },
    now: () => Date.now()
  }
}

/**
 * 当前档位的全部活跃槽位探活规格（方案 §3.10 / 工单 06 AC3）。
 *
 * - classic_light：384 ∈ [0,1]（UNKNOWN 仅 v2 旧记录过渡）；
 * - classic_light 且启用 CLIP：另查**无文本图片**的 512 ∈ [2]；
 * - gemma_unified：activeDim ∈ [4]（512 与 classic CLIP 共用槽，故严格只放行 GEMMA）。
 */
export function resolveActiveSlotSpecs(
  profile: 'classic_light' | 'gemma_unified',
  gemmaDim: number,
  clipEnabled: boolean
): SlotProbeSpec[] {
  const isGemma = profile === 'gemma_unified'
  const specs: SlotProbeSpec[] = []
  if (isGemma) {
    specs.push({
      dim: gemmaDim,
      allowedEncoders: [...ENCODER_FILTER_GEMMA],
      source: 'canonical',
      label: `gemma-${gemmaDim}`
    })
    return specs
  }
  specs.push({
    dim: 384,
    allowedEncoders: [...ENCODER_FILTER_CLASSIC_384],
    source: 'canonical',
    label: 'classic-384'
  })
  if (clipEnabled) {
    specs.push({
      dim: 512,
      allowedEncoders: [ENCODER_ID.CHINESE_CLIP],
      source: 'image',
      label: 'clip-512'
    })
  }
  return specs
}

/**
 * 切换动作触发的视觉槽探活规格（方案 §3.10 / 工单 06 AC4）。
 *
 * - classic → 512 ∈ [2]（检出 gemma 占用）；
 * - gemma@512 → 512 ∈ [4]（检出 classic CLIP 占用）；
 * - gemma 非 512 维度时不触发（activeDim 槽位已由 resolveActiveSlotSpecs 覆盖）。
 */
export function resolveSwitchSlotSpecs(
  profile: 'classic_light' | 'gemma_unified',
  gemmaDim: number
): SlotProbeSpec[] {
  const isGemma = profile === 'gemma_unified'
  if (isGemma) {
    if (gemmaDim !== 512) return []
    return [{ dim: 512, allowedEncoders: [...ENCODER_FILTER_GEMMA], source: 'image', label: 'switch-gemma-512' }]
  }
  return [{ dim: 512, allowedEncoders: [ENCODER_ID.CHINESE_CLIP], source: 'image', label: 'switch-classic-512' }]
}

export class CanonicalMaintenanceService {
  /** 各槽位探活游标（label → 下一个 afterFingerprint），支持断点续跑 */
  private probeCursors = new Map<string, string | null>()
  /** 回填游标（NULL/pending/failed 的 afterFingerprint） */
  private backfillCursor: string | null = null
  /** 回填是否正在运行（并发 1 的保护闸） */
  private backfillRunning = false
  /**
   * 维护任务是否正在运行（并发 1 的保护闸）。
   *
   * 没有它时两条路径会撞车：① 同一次 `flushAndEmitChanges` 里 profile 与 activeDim
   * 可能同时变更，两个 handler 都立刻返回（handler 内不 await），于是并发起两轮维护；
   * ② 设置页手动重建可能与配置变更同时发生。两轮维护的 `seen` 去重集各自独立，
   * 同一批指纹会被 `requeueForReanalysis` 入队两次。
   */
  private maintenanceRunning = false
  /** 最近一次维护摘要（供设置页与测试观测） */
  private lastMaintenance: CanonicalRebuildCounts['lastMaintenance'] = null

  constructor(private readonly deps: CanonicalMaintenanceDeps) {}

  /**
   * 档位/维度切换后的完整维护任务（工单 06 主入口）。
   *
   * 顺序固定为「状态失效 → 槽位探活 → 启动有界回填」：
   * 状态失效必须先于探活与回填，否则 `ready` 行永不重算，切档后文本检索静默为空。
   */
  async runMaintenance(reason: string): Promise<CanonicalRebuildCounts> {
    // 并发闸（并发 1）：同一次配置 flush 可能同时触发 profile 与 activeDim 两个 handler，
    // 手动重建也可能撞上配置变更。重入会让同一批指纹被入队两次，故直接返回当前计数。
    if (this.maintenanceRunning) {
      logger.info(
        LogCategory.ANALYSIS_QUEUE,
        `[CanonicalMaintenance] 已有维护任务在运行，跳过本次触发: reason=${reason}`
      )
      return this.getRebuildCounts()
    }
    this.maintenanceRunning = true
    try {
      return await this.runMaintenanceInner(reason)
    } finally {
      this.maintenanceRunning = false
    }
  }

  /** 维护任务主体（由 `runMaintenance` 在并发闸内调用，勿直接调用） */
  private async runMaintenanceInner(reason: string): Promise<CanonicalRebuildCounts> {
    let invalidated = 0
    let requeued = 0
    /** 单次维护任务内已入队的指纹：同一文件被多个槽位判异空间时只入队一次 */
    const seen = new Set<string>()
    try {
      // 档位/维度切换后 `/health` 的 `imageEncoder` 结论必然失效：
      // 不清缓存会让门禁在 5 分钟 TTL 内继续按旧档位放行/拒绝第 5 路。
      // 这是纯副作用优化，独立 try：缓存清理失败绝不允许把「状态失效 + 探活 + 回填」
      // 整条维护链一起跳过（那会让切档后文本检索静默为空）。
      try {
        omniClient.clearClipTextHealthCache()
      } catch (cacheErr: any) {
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          `[CanonicalMaintenance] CLIP 文本健康缓存清理失败（忽略，继续维护）: ${cacheErr?.message ?? cacheErr}`
        )
      }
      invalidated = this.invalidateStaleStates()
      const profile = await this.deps.resolveProfile()
      const gemmaDim = this.deps.resolveGemmaDim()
      const specs = [
        ...resolveActiveSlotSpecs(profile, gemmaDim, this.deps.isClipEnabled()),
        ...resolveSwitchSlotSpecs(profile, gemmaDim)
      ]
      for (const spec of specs) {
        requeued += await this.probeSlot(spec, CANONICAL_MAINTENANCE_BATCH_SIZE, seen)
      }
      await this.runBackfill()
    } catch (err: any) {
      // 维护任务整体失败只 warn：绝不影响分析队列与调用方
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        `[CanonicalMaintenance] 维护任务异常（不影响分析队列）: reason=${reason}, 原因=${err?.message ?? err}`
      )
    }
    this.lastMaintenance = { reason, at: this.deps.now(), invalidated, requeued }
    const counts = this.getRebuildCounts()
    logger.info(
      LogCategory.ANALYSIS_QUEUE,
      `[CanonicalMaintenance] 维护任务完成: reason=${reason}, 失效=${invalidated}, 重析入队=${requeued}, ` +
        `待重建=${counts.pending + counts.uncomputed}, 已就绪=${counts.ready}, 失败=${counts.failed}`
    )
    return counts
  }

  /**
   * 状态失效（方案 §3.10「切换第一步」）：按批 32 把 ready/visual_only 置 pending。
   * `skipped` 保持跳过，`canonical_text` 原样保留。循环推进直到没有可失效行。
   */
  invalidateStaleStates(batchSize = CANONICAL_MAINTENANCE_BATCH_SIZE): number {
    let total = 0
    for (let i = 0; i < PROBE_MAX_BATCHES_PER_SLOT; i++) {
      const dao = this.deps.resolveDao()
      const changed = dao.invalidateStaleCanonicalStates(batchSize)
      total += changed
      if (changed < batchSize) break
    }
    if (total > 0) {
      logger.info(
        LogCategory.ANALYSIS_QUEUE,
        `[CanonicalMaintenance] 状态失效：${total} 行 ready/visual_only 已置 pending（skipped 不动，canonical_text 保留）`
      )
    }
    return total
  }

  /**
   * 探活单个槽位：按批 32 调 getVectors，异空间/缺失 → `vector_encoder_mismatch_${actual}` 入重析队列。
   *
   * 判定口径：
   * - encoder ∈ 白名单 → matched，不入队；
   * - encoder ∉ 白名单 → mismatched，入队；
   * - 槽位无记录：
   *   - 图片且有 OCR/正文 → knownGap（已知缺口，跳过，防无限重析）；
   *   - 图片且无字 → missing，入队（本应有视觉向量）；
   *   - 非图片（文本槽候选）→ missing，入队（本应有 canonical 向量）。
   */
  async probeSlot(
    spec: SlotProbeSpec,
    batchSize = CANONICAL_MAINTENANCE_BATCH_SIZE,
    seen?: Set<string>
  ): Promise<number> {
    let requeued = 0
    for (let batch = 0; batch < PROBE_MAX_BATCHES_PER_SLOT; batch++) {
      const dao = this.deps.resolveDao()
      const cursor = this.probeCursors.get(spec.label) ?? null
      const fingerprints =
        spec.source === 'image'
          ? dao.listAnalyzedFingerprintsByFileGroup({
              fileGroups: ['image'],
              batchSize,
              afterFingerprint: cursor
            })
          : dao.listAnalyzedFingerprints({ batchSize, afterFingerprint: cursor })

      if (fingerprints.length === 0) {
        this.probeCursors.set(spec.label, null)
        break
      }

      const res = await this.deps.getVectors(fingerprints, spec.dim)
      // 探活请求失败（引擎未就绪 / 超时 / 传输错误）时 `getVectors` 返回 null，
      // 绝不可当成「全部缺失」：否则一次引擎抖动就会把整批 ready 判成异空间，
      // 进而 requeueForReanalysis(forceReanalyze=true) 对全库发起强制重析。
      if (res === null) {
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          `[CanonicalMaintenance] 槽位探活 ${spec.label}（dim=${spec.dim}）请求失败（引擎未就绪或超时），` +
            `本批放弃：不推进游标、不判缺失、不入队重析`
        )
        break
      }
      // 只有探活成功才推进游标：失败批次必须留待下一轮重试
      this.probeCursors.set(spec.label, fingerprints[fingerprints.length - 1])

      const byFingerprint = new Map<string, OmniVectorGetItem>()
      for (const item of res.vectors) byFingerprint.set(item.fileFingerprint, item)

      const toRequeue: string[] = []
      let matched = 0
      let mismatched = 0
      let missing = 0
      let knownGap = 0
      const reasons: string[] = []

      for (const fp of fingerprints) {
        const item = byFingerprint.get(fp)
        if (item && spec.allowedEncoders.includes(item.encoderId)) {
          matched++
          continue
        }
        if (item) {
          mismatched++
          reasons.push(`${VECTOR_ENCODER_MISMATCH_PREFIX}${item.encoderId}`)
          toRequeue.push(fp)
          continue
        }
        // 槽位无记录：图片先判已知缺口
        if (spec.source === 'image') {
          let hasText = false
          try {
            hasText = !isTextlessImage(this.deps.loadSourceData(fp))
          } catch {
            hasText = false
          }
          if (hasText) {
            knownGap++
            continue
          }
        }
        missing++
        reasons.push(`${VECTOR_ENCODER_MISMATCH_PREFIX}missing`)
        toRequeue.push(fp)
      }

      if (toRequeue.length > 0) {
        // 单次维护任务内去重：同一文件被多个槽位判异空间时只入队一次
        const fresh = seen ? toRequeue.filter(fp => !seen.has(fp)) : toRequeue
        for (const fp of fresh) seen?.add(fp)
        if (fresh.length > 0) {
          requeued += await this.requeueForReanalysis(dao, fresh, spec.label, reasons)
        }
      }
      logger.info(
        LogCategory.ANALYSIS_QUEUE,
        `[CanonicalMaintenance] 槽位探活 ${spec.label}（dim=${spec.dim}）：匹配=${matched}, ` +
          `异空间=${mismatched}, 缺失=${missing}, 已知缺口跳过=${knownGap}, 入队=${toRequeue.length}`
      )
      if (fingerprints.length < batchSize) {
        this.probeCursors.set(spec.label, null)
        break
      }
    }
    return requeued
  }

  /** 把异空间/缺失指纹送入重析队列（forceReanalyze），失败只 warn */
  private async requeueForReanalysis(
    dao: CanonicalDao,
    fingerprints: string[],
    label: string,
    reasons: string[]
  ): Promise<number> {
    try {
      const inputs = dao.listReanalysisInputs(fingerprints)
      if (inputs.length === 0) {
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          `[CanonicalMaintenance] 槽位 ${label} 有 ${fingerprints.length} 个异空间指纹但解析不到物理路径，跳过入队`
        )
        return 0
      }
      await this.deps.enqueueReanalysis(inputs)
      const reasonSummary = Array.from(new Set(reasons)).join(',')
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        `[CanonicalMaintenance] 槽位 ${label} 检出异空间/缺失 ${inputs.length} 个文件（${reasonSummary}），已入重析队列`
      )
      return inputs.length
    } catch (err: any) {
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        `[CanonicalMaintenance] 槽位 ${label} 重析入队失败（不影响分析队列）: 原因=${err?.message ?? err}`
      )
      return 0
    }
  }

  /**
   * 有界回填一批：扫描 `is_analyzed=1 AND canonical_vector_state IN (NULL,pending,failed)`，
   * 并发 1 逐个固化；分析队列忙碌时立即暂停（不处理任何候选）。
   *
   * 只重建 canonical 文本向量：视觉槽的异空间占用由 `probeSlot` 的重析处理。
   */
  async runBackfillBatch(batchSize = CANONICAL_MAINTENANCE_BATCH_SIZE): Promise<BackfillBatchResult> {
    if (this.backfillRunning) {
      return { candidates: 0, solidified: 0, paused: true, nextCursor: this.backfillCursor }
    }
    this.backfillRunning = true
    try {
      if (await this.deps.isQueueBusy()) {
        logger.info(
          LogCategory.ANALYSIS_QUEUE,
          '[CanonicalMaintenance] 分析队列忙碌，canonical 回填暂停（可断点续跑）'
        )
        return { candidates: 0, solidified: 0, paused: true, nextCursor: this.backfillCursor }
      }
      const dao = this.deps.resolveDao()
      const fingerprints = dao.listCanonicalFingerprintsByState({
        states: [null, 'pending', 'failed'],
        batchSize,
        afterFingerprint: this.backfillCursor,
        analyzedOnly: true
      })
      if (fingerprints.length === 0) {
        this.backfillCursor = null
        return { candidates: 0, solidified: 0, paused: false, nextCursor: null }
      }

      // 回填前先探空：向量被删除但 state 仍为 ready 的行不在候选里，
      // 由 probeReadyRowsForMissingVectors 负责把它们打回 pending。
      let solidified = 0
      for (let i = 0; i < fingerprints.length; i++) {
        const fp = fingerprints[i]
        if (await this.deps.isQueueBusy()) {
          // 游标只推进到**已处理**的最后一个指纹：未处理的必须留给下次续跑，
          // 否则会静默跳过整批剩余候选（切档后这部分行永不重算）。
          this.backfillCursor = i > 0 ? fingerprints[i - 1] : this.backfillCursor
          logger.info(
            LogCategory.ANALYSIS_QUEUE,
            `[CanonicalMaintenance] 分析队列转忙，canonical 回填中途暂停（已固化 ${solidified}/${fingerprints.length}，续跑游标=${this.backfillCursor}）`
          )
          return {
            candidates: fingerprints.length,
            solidified,
            paused: true,
            nextCursor: this.backfillCursor
          }
        }
        try {
          await this.deps.solidify(fp)
          solidified++
        } catch (err: any) {
          logger.warn(
            LogCategory.ANALYSIS_QUEUE,
            `[CanonicalMaintenance] 回填固化异常（继续下一个）: fp=${fp}, 原因=${err?.message ?? err}`
          )
        }
      }
      this.backfillCursor = fingerprints[fingerprints.length - 1]
      return {
        candidates: fingerprints.length,
        solidified,
        paused: false,
        nextCursor: fingerprints.length < batchSize ? null : this.backfillCursor
      }
    } finally {
      this.backfillRunning = false
    }
  }

  /** 连续推进回填直到候枯竭或队列忙碌（供启动后与配置变更后调用） */
  async runBackfill(maxBatches = 64): Promise<number> {
    let total = 0
    for (let i = 0; i < maxBatches; i++) {
      const result = await this.runBackfillBatch()
      total += result.solidified
      if (result.paused || result.nextCursor === null) break
    }
    return total
  }

  /**
   * 探空 `ready` 行：向量被删除但 state 仍为 ready 时，回填不会扫到它（永不重算）。
   * 按批 getVectors 探空，空 → 打回 pending，交由回填重嵌。
   */
  async probeReadyRowsForMissingVectors(
    batchSize = CANONICAL_MAINTENANCE_BATCH_SIZE
  ): Promise<number> {
    let reset = 0
    // 指纹游标：`ready` 行被打回 pending 后会离开结果集，若无游标则「本轮无缺失」时
    // 会反复查到同一批，白付 PROBE_MAX_BATCHES_PER_SLOT 次 HTTP 往返。
    let cursor: string | null = null
    for (let i = 0; i < PROBE_MAX_BATCHES_PER_SLOT; i++) {
      const dao = this.deps.resolveDao()
      const profile = await this.deps.resolveProfile()
      const dim = profile === 'gemma_unified' ? this.deps.resolveGemmaDim() : 384
      const fingerprints = dao.listCanonicalFingerprintsByState({
        states: ['ready'],
        batchSize,
        analyzedOnly: true,
        afterFingerprint: cursor ?? undefined
      })
      if (fingerprints.length === 0) break
      const res = await this.deps.getVectors(fingerprints, dim)
      // 同 probeSlot：探活失败必须整体放弃，绝不能把 null 当成「全部无向量」而批量打回 pending
      if (res === null) {
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          `[CanonicalMaintenance] 探空 ready 行失败（dim=${dim}，引擎未就绪或超时），本轮放弃：` +
            `不推进游标、不批量打回 pending`
        )
        break
      }
      cursor = fingerprints[fingerprints.length - 1]
      const present = new Set(res.vectors.map(v => v.fileFingerprint))
      const emptied = fingerprints.filter(fp => !present.has(fp))
      if (emptied.length > 0) {
        reset += dao.markCanonicalPending(emptied)
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          `[CanonicalMaintenance] ${emptied.length} 个 ready 行在 dim=${dim} 槽位已无向量（疑似被删除），` +
            `已打回 pending 交由回填重嵌（不因 state=ready 跳过）`
        )
      }
      if (fingerprints.length < batchSize) break
    }
    return reset
  }

  /** 重建计数（供设置页展示；方案 §3.10「禁止静默空召回」） */
  getRebuildCounts(): CanonicalRebuildCounts {
    try {
      const dao = this.deps.resolveDao()
      const byState = dao.countCanonicalByState(true)
      return {
        pending: byState.pending,
        ready: byState.ready,
        visualOnly: byState.visual_only,
        skipped: byState.skipped,
        failed: byState.failed,
        uncomputed: dao.countCanonicalNullState(true),
        lastMaintenance: this.lastMaintenance
      }
    } catch (err: any) {
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        `[CanonicalMaintenance] 重建计数读取失败: 原因=${err?.message ?? err}`
      )
      return {
        pending: 0,
        ready: 0,
        visualOnly: 0,
        skipped: 0,
        failed: 0,
        uncomputed: 0,
        lastMaintenance: this.lastMaintenance
      }
    }
  }

  /** 重置全部游标（测试与「重建语义索引」入口使用） */
  resetCursors(): void {
    this.probeCursors.clear()
    this.backfillCursor = null
    this.lastMaintenance = null
  }
}

/** 进程级单例（工单 05 五终态接入统一入口） */
export const canonicalMaintenanceService = new CanonicalMaintenanceService(
  createDefaultMaintenanceDeps()
)

/** 供测试/调用方显式构造 */
export function createCanonicalMaintenanceService(
  overrides?: Partial<CanonicalMaintenanceDeps>
): CanonicalMaintenanceService {
  return new CanonicalMaintenanceService({
    ...createDefaultMaintenanceDeps(),
    ...overrides
  })
}

/* ------------------------------------------------------------------ *
 * 工单 06：档位/维度变更监听（复用 ConfigOrchestrator，禁造第二套监听）
 * ------------------------------------------------------------------ */

/** 触发维护的配置键（仅这两个键；无关配置变更不得触发） */
export const CANONICAL_MAINTENANCE_CONFIG_KEYS = [
  'AI_EMBEDDING_PROFILE',
  'EMBEDDING_MRL_DIMENSION'
] as const

/**
 * 注册档位/维度变更监听（工单 06 AC1）。
 *
 * 硬约束：
 * - **只复用** `ConfigOrchestrator.onValueChange`，不新建第二套配置监听体系；
 * - 仅在 `newVal !== oldVal` 且两者都非空时触发（首次启动的初始化写入不触发）；
 * - 与 `omni-service.ts` 已有的热重启订阅**并列注册**，互不影响；
 * - 返回取消订阅函数（供测试清理）。
 */
export function installCanonicalMaintenanceListener(
  service: CanonicalMaintenanceService = canonicalMaintenanceService
): () => void {
  const orchestrator = ConfigOrchestrator.getInstance()
  const unsubscribers: Array<() => void> = []

  for (const key of CANONICAL_MAINTENANCE_CONFIG_KEYS) {
    const unsubscribe = orchestrator.onValueChange(key as any, async (newVal, oldVal) => {
      // 无关配置变更不触发：仅 profile 或 activeDim 的**真实变化**才维护
      if (!newVal || !oldVal || newVal === oldVal) return
      logger.info(
        LogCategory.ANALYSIS_QUEUE,
        `[CanonicalMaintenance] 检测到 ${key} 变更 (${String(oldVal)} -> ${String(newVal)})，启动 canonical 维护任务`
      )
      // 绝不能在 handler 内 await 整轮维护：ConfigOrchestrator 是**串行 await** 每个 handler，
      // 阻塞会让 `updateConfigValue` 的 IPC 等到维护跑完（全量失效 + 多轮探活 + 回填，可达数分钟），
      // 并把同一 key 上的引擎热重启 handler 一起排队。runMaintenance 自带 try/catch，不会外抛。
      // `.catch` 只兜 catch 块之外的意外（如 getRebuildCounts 抛错）：void 化后无人 await，
      // 漏掉会变成 unhandledRejection。
      void service.runMaintenance(`${key}:${String(oldVal)}->${String(newVal)}`).catch((err: unknown) => {
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          `[CanonicalMaintenance] 维护任务未捕获异常: ${err instanceof Error ? err.message : String(err)}`
        )
      })
    })
    unsubscribers.push(unsubscribe)
  }

  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe()
  }
}
