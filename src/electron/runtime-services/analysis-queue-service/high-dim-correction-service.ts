/**
 * high-dim-correction-service.ts — Stage 5 高维修正流水线（Issue 0046 §4/§5）
 *
 * 职责：
 * 1. 判定高维修正是否启用（统一配置中心 `HIGH_DIMENSION_CORRECTION`）；
 * 2. 工作区缓冲灌库（refill）：普通分析待办清零后，扫描「已分析但尚未高维修正」的文件，
 *    按动态分页（默认 150/批）灌入 `analysis_queue`（task_type = 'high_dim_correction'）；
 * 3. 单文件高维修正（correctOne）：调用 WeMM-Embedding 2B 生成 2048d 向量 → 高维标签二次校准
 *    → 5W 名称/描述二次提纯（人工命名严格跳过）→ 落库 zvec 向量。
 *
 * 设计要点：
 * - 嵌入器（embedder）与向量入库（vectorSink）均可注入，便于单测 Mock（PRD Seam 5）；
 * - 纯逻辑（标签融合 / 命名仲裁）收敛在 `high-dim-correction.ts`，本类只做编排与 IO；
 * - 单文件为最小事务单元，天然满足「单文件事务让权」：一个文件落库完成后即可交还调度权，
 *   由调度层把引擎让给新插入的普通分析任务（见 `releaseEngine` 的契约说明）。
 */

import { LogCategory, logger } from '@firefly/shared'
import { ConfigOrchestrator } from '@app/electron/config/config-orchestrator'
import { databaseService } from '../database/database-service'
import {
  HIGH_DIM_REFILL_BATCH_SIZE,
  HIGH_DIM_CORRECTION_STAGE,
  WEMM_EMBEDDING_DIM,
  HIGH_DIM_PRUNABLE_TAG_GROUPS,
  HIGH_DIM_MIN_TAG_CONFIDENCE
} from '@shared/constants/high-dim-correction'
import {
  applyHighDimCorrection,
  isMachineGeneratedName,
  type HighDimTagCandidate,
  type SmartNameSource
} from './high-dim-correction'
import type { AnalysisQueueItem } from '@firefly/types'

/** 嵌入器契约：给定文本事实，产出 2048d 稠密向量 */
export interface WemmEmbedder {
  embed(text: string, signal?: AbortSignal): Promise<number[]>
}

/** 向量入库契约：把 2048d 向量写入 Omni 托管的 zvec（含 RaBitQ + INT8 量化） */
export interface HighDimVectorSink {
  upsert(fileFingerprint: string, vector: number[]): Promise<void>
}

/** 标签候选打分器契约：给定文本事实与候选标签短语，返回高维相似度候选 */
export interface HighDimTagScorer {
  score(text: string, vector: number[], existingTags: HighDimTagCandidate[]): Promise<HighDimTagCandidate[]>
}

/**
 * 5W 名称/描述二次提纯契约。
 *
 * 由上层 5W 槽位插槽引擎（Omni `/api/text/analyze`）实现：结合高维精修后的标签与事实
 * 重新生成一次智能名称与一句话描述。返回空值表示本次不更新对应字段。
 */
export interface HighDimNameRefiner {
  refine(input: {
    /** 文件事实文本（已解压的正文 / OCR / ASR / 多模态描述拼接） */
    facts: string
    /** 高维精修后的受控标签（含 code 与展示名候选） */
    tags: Array<{ code: string; parentCode: string; confidence: number }>
    /** 文件真实名（供 5W 槽位引擎参考扩展名与原始命名线索） */
    fileName: string
  }): Promise<{ smartName?: string | null; description?: string | null }>
}

export interface HighDimCorrectionDeps {
  embedder?: WemmEmbedder
  vectorSink?: HighDimVectorSink
  tagScorer?: HighDimTagScorer
  /** 5W 名称/描述二次提纯器（人工命名文件不会被调用） */
  nameRefiner?: HighDimNameRefiner
  /**
   * 让权钩子：单文件原子落库后、交还调度权之前调用。
   *
   * **当前的让权效果来自调度层**（回到 `pickNextPending` 后必然优先选中新插入的
   * `analysis` 任务），本钩子只是给上层一个「此刻可回收嵌入上下文」的时机；
   * Tier 2 引擎目前没有卸载嵌入模型的接口，故默认实现只记录日志，不整体停服。
   */
  releaseEngine?: () => Promise<void>
  /**
   * 高维修正任务批量入队（写库 + 入内存队列）。
   * 由 QueueManager 提供，保证调度器读取的内存快照与队列表一致。
   */
  enqueueHighDim?: (
    candidates: Array<{
      item_id: number
      path: string
      name: string
      size: number
      file_fingerprint: string
    }>,
    workspaceId: number
  ) => number
}

/** 单文件高维修正结果（供队列状态更新与单测断言） */
export interface HighDimCorrectionOutcome {
  fileFingerprint: string
  vectorDimension: number
  tagsWritten: number
  smartNameUpdated: boolean
  descriptionUpdated: boolean
  skippedForUserNaming: boolean
}

export { HIGH_DIM_PRUNABLE_TAG_GROUPS, HIGH_DIM_MIN_TAG_CONFIDENCE }

export class HighDimCorrectionService {
  private readonly embedder?: WemmEmbedder
  private readonly vectorSink?: HighDimVectorSink
  private readonly tagScorer?: HighDimTagScorer
  private readonly nameRefiner?: HighDimNameRefiner
  private readonly releaseEngineHook?: () => Promise<void>
  private readonly enqueueHighDim?: HighDimCorrectionDeps['enqueueHighDim']

  /** 让权信号（Issue 0046 §4）：高维修正执行期间有普通分析任务插入时置位 */
  private yieldRequested = false

  constructor(deps: HighDimCorrectionDeps = {}) {
    this.embedder = deps.embedder
    this.vectorSink = deps.vectorSink
    this.tagScorer = deps.tagScorer
    this.nameRefiner = deps.nameRefiner
    this.releaseEngineHook = deps.releaseEngine
    this.enqueueHighDim = deps.enqueueHighDim
  }

  /** 请求让权：新普通分析任务插入队列时由调度器调用 */
  requestYield(): void {
    this.yieldRequested = true
  }

  /** 消费让权信号（读取后复位），供单文件落库后判定是否立即释放引擎 */
  consumeYield(): boolean {
    const pending = this.yieldRequested
    this.yieldRequested = false
    return pending
  }

  /** 释放 WeMM 引擎换载（卸载嵌入模型），保证普通分析可独占推理资源 */
  async releaseEngine(): Promise<void> {
    try {
      await this.releaseEngineHook?.()
    } catch (e) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[高维修正] 让权钩子执行失败（忽略）:', e)
    }
  }

  /** 高维修正开关（统一配置中心，默认 false） */
  isEnabled(): boolean {
    try {
      return ConfigOrchestrator.getInstance().getValue<boolean>('HIGH_DIMENSION_CORRECTION') === true
    } catch {
      return false
    }
  }

  /**
   * 工作区缓冲灌库（Issue 0046 §4）：
   * 扫描当前工作区「已分析但尚未高维修正」的文件，分批灌入 `analysis_queue`。
   *
   * 返回本批实际入队的数量（0 表示已无待修正文件）。
   * 调用方应在「普通分析待办清零」后调用；分批上限由 `HIGH_DIM_REFILL_BATCH_SIZE` 控制。
   */
  async refill(workspaceId: number, batchSize = HIGH_DIM_REFILL_BATCH_SIZE): Promise<number> {
    if (!this.isEnabled()) return 0
    if (!workspaceId) return 0

    try {
      const candidates = databaseService.listHighDimCandidates(workspaceId, batchSize)
      if (!candidates || candidates.length === 0) return 0

      // 经 QueueManager 入队：写库 + 入内存队列，保证调度器快照可见。
      // **不提供**「只写库」的降级路径：调度器读的是内存快照，只写库的任务在本进程内
      // 永远不会被取出，表现为「队列里有一堆 pending 却毫无动静」的静默卡死。
      // 因此未注入入队器时直接放弃本批并报错，让问题显式暴露。
      if (!this.enqueueHighDim) {
        logger.error(
          LogCategory.ANALYSIS_QUEUE,
          '[高维修正] 未注入 enqueueHighDim，无法灌库（避免只写库不进内存队列导致任务静默卡死）'
        )
        return 0
      }

      const enqueued = this.enqueueHighDim(candidates, workspaceId)

      if (enqueued > 0) {
        logger.info(
          LogCategory.ANALYSIS_QUEUE,
          `[高维修正] 工作区 ${workspaceId} 已灌入 ${enqueued} 个高维修正任务（Stage ${HIGH_DIM_CORRECTION_STAGE}）`,
          { batchSize }
        )
      }
      return enqueued
    } catch (e) {
      logger.error(LogCategory.ANALYSIS_QUEUE, '[高维修正] 工作区缓冲灌库失败:', e)
      return 0
    }
  }

  /**
   * 单文件高维修正（Stage 5 最小事务单元）。
   *
   * 流程：读取文件事实 → 生成 2048d 向量 → 高维标签二次打分 → 纯逻辑仲裁
   * → 原子落库（标签 + 名称/描述 + 已修正标记）→ 写入 zvec。
   *
   * 抛错时调用方应将队列项置为 failed，由抢占式重试机制兜底。
   */
  async correctOne(
    item: AnalysisQueueItem,
    signal?: AbortSignal
  ): Promise<HighDimCorrectionOutcome> {
    const fingerprint = this.resolveFingerprint(item)
    if (!fingerprint) {
      throw new Error(`[高维修正] 无法解析文件指纹: ${item.path}`)
    }

    const facts = databaseService.getHighDimCorrectionFacts(fingerprint)
    if (!facts) {
      throw new Error(`[高维修正] 未找到文件事实记录: ${fingerprint}`)
    }

    if (!this.embedder) {
      throw new Error('[高维修正] 未配置 WeMM 嵌入器，无法生成高维向量')
    }

    const vector = await this.embedder.embed(facts.textFacts, signal)
    if (!Array.isArray(vector) || vector.length !== WEMM_EMBEDDING_DIM) {
      throw new Error(
        `[高维修正] WeMM 向量维度异常：期望 ${WEMM_EMBEDDING_DIM}，实际 ${vector?.length ?? 0}`
      )
    }

    const highDimTags = this.tagScorer
      ? await this.tagScorer.score(facts.textFacts, vector, facts.existingTags)
      : []

    // 5W 二次提纯：仅当当前名称非人工命名时，才调用插槽引擎重新生成候选名与描述。
    // 人工命名（namingSource === 'user'）时**不发起请求**，避免任何副作用与资源浪费。
    let refinedSmartName: string | null = null
    let refinedDescription: string | null = null
    if (this.nameRefiner && isMachineGeneratedName(facts.namingSource)) {
      try {
        const refined = await this.nameRefiner.refine({
          facts: facts.textFacts,
          tags: highDimTags.map(t => ({
            code: t.code,
            parentCode: t.parentCode ?? '',
            confidence: t.confidence
          })),
          fileName: item.name || ''
        })
        refinedSmartName = refined.smartName ?? null
        refinedDescription = refined.description ?? null
      } catch (e) {
        // 提纯失败不阻断标签校准与向量入库：降级为「本次不更新名称/描述」
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          `[高维修正] 5W 名称提纯失败，保留原名称: ${item.name}`,
          e
        )
      }
    }

    const refined = applyHighDimCorrection({
      existingTags: facts.existingTags,
      highDimTags,
      minConfidence: HIGH_DIM_MIN_TAG_CONFIDENCE,
      currentSmartName: facts.smartName,
      currentDescription: facts.description,
      namingSource: (facts.namingSource as SmartNameSource | null) ?? null,
      refinedSmartName,
      refinedDescription
    })

    databaseService.applyHighDimCorrectionResult(fingerprint, {
      tags: refined.tags,
      smartName: refined.smartName,
      description: refined.description,
      smartNameUpdated: refined.smartNameUpdated,
      descriptionUpdated: refined.descriptionUpdated,
      // 高维打分器确实产出候选时才允许剔除噪点标签，否则（如 Omni 离线、模型未就绪）
      // 一律保持既有标签不变，避免把「打分失败」误判成「标签是噪点」。
      pruneTagGroups: highDimTags.length > 0 ? HIGH_DIM_PRUNABLE_TAG_GROUPS : undefined
    })

    if (this.vectorSink) {
      await this.vectorSink.upsert(fingerprint, vector)
    }

    return {
      fileFingerprint: fingerprint,
      vectorDimension: vector.length,
      tagsWritten: refined.tags.length,
      smartNameUpdated: refined.smartNameUpdated,
      descriptionUpdated: refined.descriptionUpdated,
      skippedForUserNaming: refined.skippedForUserNaming
    }
  }

  /** 解析文件指纹：优先使用队列项上已解析的指纹，缺失时回退按路径查询（DAO 层） */
  public resolveFingerprint(item: AnalysisQueueItem): string | null {
    const fromItem = (item as any).fileFingerprint || (item as any).file_fingerprint
    if (typeof fromItem === 'string' && fromItem.length > 0) return fromItem
    if (item.path) {
      try {
        return databaseService.getFileFingerprintByPath(item.path) ?? null
      } catch {
        return null
      }
    }
    return null
  }
}
