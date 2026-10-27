import { createHash } from 'node:crypto'
import {
  LogCategory,
  logger,
  buildSemanticText,
  SEMANTIC_TEXT_VERSION,
  type SemanticTagInput
} from '@firefly/shared'
import { ENCODER_ID } from '../../services/omni-client'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import {
  CanonicalDao,
  type CanonicalSourceData,
  type CanonicalVectorState
} from '../database/dao/canonical-dao'
import { databaseService } from '../database/database-service'
import { omniService } from '../system/omni-service'

/**
 * canonical 语义文本固化服务（vector-semantic-text-unified-scheme §3.3）。
 *
 * 职责：组装语义文本 → 算 hash → 维护状态机 → 单飞嵌入 → 写 zvec。
 * 只做「文本 + canonical 向量」一件事：阶段一视觉向量、聚类、整理归类、搜索白名单
 * 都不在本服务内实现（分别归属工单 05/06/07/08）。
 *
 * 硬约束：
 * - classic 档位 canonical 一律 384 + encoder=Bekko(1)，**绝不写 512 视觉槽**；
 * - gemma 无字图片只固化文本（visual_only），不嵌入、不 upsert，保留阶段一视觉向量；
 * - 任何失败只把状态置 failed 并 warn，**不向上抛异常**、不阻断调用方（分析终态照常 completed）；
 * - 同一指纹并发调用只发生一次嵌入（single-flight）。
 */

/** 固化结果（供调用方与测试观测，不参与业务判定之外的逻辑） */
export type CanonicalSolidifyOutcome =
  | 'missing' // files 行不存在（指纹未登记），无需固化
  | 'skipped' // 文本为空/仅机器流水号，无有效语义
  | 'unchanged' // hash 相同且已终态，幂等跳过
  | 'visual_only' // gemma 无字图片：仅固化文本
  | 'ready' // canonical 向量已写入
  | 'failed' // 嵌入或 upsert 失败（状态已置 failed）

/** classic_light 档位 canonical 文本向量维度（Bekko 384） */
const CLASSIC_CANONICAL_DIM = 384

/**
 * 阶段二 canonical 嵌入的单次预算（毫秒）。
 *
 * 来源：方案 §3.3 步骤 7 明确写 `timeoutMs: 5000`。
 * 不沿用 `batchEmbedText` 的 10000ms 缺省值——本调用串行挂在文件分析终态之前，
 * 缺省值会把单文件完成时间放大一倍，直接侵蚀 AC13「阶段二额外耗时 P95 ≤ 300ms」。
 */
const CANONICAL_EMBED_TIMEOUT_MS = 5000

/** gemma_unified 合法 MRL 维度白名单（方案 §3.4；1024 不是合法槽位） */
const GEMMA_MRL_DIMS: ReadonlySet<number> = new Set([256, 512, 768])

/** gemma 档位默认 MRL 维度（配置缺失或非法时回退） */
const GEMMA_DEFAULT_MRL_DIM = 512

/** 已终态集合：hash 相同即幂等跳过，不再重嵌 */
const TERMINAL_STATES: ReadonlySet<CanonicalVectorState> = new Set([
  'ready',
  'visual_only',
  'skipped'
])

/** canonical 服务依赖（可注入，便于单测隔离 Omni 与 DB） */
export interface CanonicalTextServiceDeps {
  /**
   * 解析 canonical DAO。每次固化时解析一次：数据库可能尚未初始化（启动早期调用），
   * 此时抛出即被外层收敛为 failed + warn，不阻断调用方。
   */
  resolveDao(): CanonicalDao
  /** 当前生效嵌入档位 */
  resolveProfile(): Promise<'classic_light' | 'gemma_unified'>
  /** gemma 档位实际生效 MRL 维度（已归一化为 256/512/768） */
  resolveGemmaDim(): number
  /** 文本嵌入（由 omniService.batchEmbedText 承担） */
  embedTexts(texts: string[], profile: string, dim: number): Promise<number[][]>
  /** canonical 向量写入 Omni zvec（encoderId 由本服务按档位给出，禁止调用方猜测） */
  upsertVector(fileFingerprint: string, vector: number[], encoderId: number): Promise<boolean>
}

/** 默认依赖：真实 DB DAO + 真实 Omni 通道 */
function createDefaultDeps(): CanonicalTextServiceDeps {
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
    embedTexts: async (texts, profile, dim) => {
      // 方案 §3.3 步骤 7 明确要求 5s 预算；`batchEmbedText` 缺省是 10s，
      // 而本调用串行挂在文件分析终态上，缺省值会让单文件完成时间被放大一倍。
      const res = await omniService.batchEmbedText(texts, {
        profile,
        dim,
        timeoutMs: CANONICAL_EMBED_TIMEOUT_MS
      })
      return res.vectors
    },
    upsertVector: (fileFingerprint, vector, encoderId) =>
      databaseService.upsertFileVectorToOmni(fileFingerprint, vector, encoderId)
  }
}

/** 归一化 MRL 维度：仅 256/512/768 合法，其余（含历史遗留 1024）回退 512 */
export function normalizeGemmaDim(dim: number | null | undefined): number {
  return typeof dim === 'number' && GEMMA_MRL_DIMS.has(dim) ? dim : GEMMA_DEFAULT_MRL_DIM
}

/** canonical hash：profile|dim|ver|text（方案 §3.3） */
export function computeCanonicalHash(
  profile: string,
  dim: number,
  text: string
): string {
  return createHash('sha256')
    .update(`${profile}|${dim}|${SEMANTIC_TEXT_VERSION}|${text}`, 'utf8')
    .digest('hex')
}

/**
 * 判定 gemma 档位下的「无字图片」：图片且 content/ocr/asr/lrc 全空。
 * 此类文件不写 canonical 向量（保留阶段一 CLIP 视觉向量，避免文本塔对无字图片产出垃圾向量）。
 */
export function isTextlessImage(source: CanonicalSourceData): boolean {
  if (source.fileGroup !== 'image') return false
  const { content, ocr, asr, lrc } = source.contents
  const hasText = [content, ocr, asr, lrc].some(t => typeof t === 'string' && t.trim().length > 0)
  return !hasText
}

export class CanonicalTextService {
  /** 单指纹 single-flight：并发调用同一指纹只发生一次嵌入 */
  private inFlight = new Map<string, Promise<CanonicalSolidifyOutcome>>()

  constructor(private readonly deps: CanonicalTextServiceDeps) {}

  /**
   * 固化单个文件的 canonical 语义文本与向量。
   * 任何异常都在内部收敛为 'failed' + warn，绝不向调用方抛出。
   */
  async solidify(fileFingerprint: string): Promise<CanonicalSolidifyOutcome> {
    if (!fileFingerprint) {
      // 与下方 `record === null` 的 missing 分支保持同等可观测性：
      // Tier-1 兜底按路径反查指纹失败时会传空串，静默 return 会让「本应固化却没固化」查不出原因。
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        '[Canonical] 固化为空指纹（调用方未能解析 file_fingerprint），跳过固化'
      )
      return 'missing'
    }

    const existing = this.inFlight.get(fileFingerprint)
    if (existing) return existing

    const task = this.runSolidify(fileFingerprint).finally(() => {
      this.inFlight.delete(fileFingerprint)
    })
    this.inFlight.set(fileFingerprint, task)
    return task
  }

  private async runSolidify(fileFingerprint: string): Promise<CanonicalSolidifyOutcome> {
    let dao: CanonicalDao
    try {
      dao = this.deps.resolveDao()
    } catch (err: any) {
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        `[Canonical] DAO 解析失败，跳过固化: fp=${fileFingerprint}, 原因=${err?.message ?? err}`
      )
      return 'failed'
    }
    try {
      const record = dao.getCanonicalRecord(fileFingerprint)
      if (!record) {
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          `[Canonical] files 行不存在，跳过固化: fp=${fileFingerprint}`
        )
        return 'missing'
      }

      const source = dao.loadCanonicalSourceData(fileFingerprint)
      const text = buildSemanticText({
        displayName: source.smartName ?? undefined,
        rawName: source.rawName ?? undefined,
        description: source.description ?? undefined,
        tags: source.tags as SemanticTagInput[],
        contents: source.contents,
        createdYear: source.createdYear,
        author: source.author,
        language: source.language,
        qualityLevel: source.qualityLevel
      })

      if (!text) {
        // 空串短路保护：若当前已是 skipped 且新文本仍为空，直接短路返回，消除无意义的 SQLite UPDATE
        if (record.canonicalVectorState === 'skipped' && !record.canonicalText) {
          return 'skipped'
        }
        // 空串或仅机器流水号：无有效语义，不嵌入
        dao.writeCanonicalRecord(fileFingerprint, {
          text: '',
          hash: null,
          state: 'skipped'
        })
        return 'skipped'
      }

      const profile = await this.deps.resolveProfile()
      const isGemma = profile === 'gemma_unified'
      const dim = isGemma ? this.deps.resolveGemmaDim() : CLASSIC_CANONICAL_DIM
      const hash = computeCanonicalHash(profile, dim, text)

      // 幂等：hash 相同且已终态 → 直接返回（pending/failed 仍走重试）
      if (
        record.canonicalTextHash === hash &&
        record.canonicalVectorState !== null &&
        TERMINAL_STATES.has(record.canonicalVectorState)
      ) {
        return 'unchanged'
      }

      // 崩溃可恢复：先落 pending 再嵌入
      dao.writeCanonicalRecord(fileFingerprint, {
        text,
        hash,
        state: 'pending'
      })

      if (isGemma && isTextlessImage(source)) {
        // gemma 无字图片：只固化文本，保留阶段一视觉向量，不嵌入、不 upsert
        dao.updateCanonicalVectorState(fileFingerprint, 'visual_only')
        return 'visual_only'
      }

      const encoderId = isGemma ? ENCODER_ID.GEMMA : ENCODER_ID.BEKKO
      let vectors: number[][]
      try {
        vectors = await this.deps.embedTexts([text], profile, dim)
      } catch (embedErr: any) {
        dao.updateCanonicalVectorState(fileFingerprint, 'failed')
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          `[Canonical] 文本嵌入失败，状态置 failed: fp=${fileFingerprint}, 原因=${embedErr?.message ?? embedErr}`
        )
        return 'failed'
      }

      const vector = Array.isArray(vectors) ? vectors[0] : undefined
      if (!vector || vector.length === 0) {
        dao.updateCanonicalVectorState(fileFingerprint, 'failed')
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          `[Canonical] 嵌入返回空向量，状态置 failed: fp=${fileFingerprint}`
        )
        return 'failed'
      }

      let ok = false
      try {
        ok = await this.deps.upsertVector(fileFingerprint, vector, encoderId)
      } catch (upsertErr: any) {
        ok = false
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          `[Canonical] 向量 upsert 抛错，状态置 failed: fp=${fileFingerprint}, 原因=${upsertErr?.message ?? upsertErr}`
        )
      }

      if (!ok) {
        dao.updateCanonicalVectorState(fileFingerprint, 'failed')
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          `[Canonical] 向量 upsert 未成功，状态置 failed: fp=${fileFingerprint}`
        )
        return 'failed'
      }

      dao.updateCanonicalVectorState(fileFingerprint, 'ready')
      return 'ready'
    } catch (err: any) {
      // 兜底：读取/组装阶段异常同样不阻断调用方
      try {
        dao.updateCanonicalVectorState(fileFingerprint, 'failed')
      } catch {
        /* 状态位写失败时只能放弃，交由 warn 暴露 */
      }
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        `[Canonical] 固化异常，状态置 failed: fp=${fileFingerprint}, 原因=${err?.message ?? err}`
      )
      return 'failed'
    }
  }

  /** 当前 in-flight 任务数（测试与观测用） */
  get inFlightCount(): number {
    return this.inFlight.size
  }
}

/** 进程级单例（工单 05 五终态接入统一入口） */
export const canonicalTextService = new CanonicalTextService(createDefaultDeps())

/**
 * 供测试/调用方显式构造：DAO 由调用方给出（真实 better-sqlite3 或临时库）。
 */
export function createCanonicalTextService(
  dao: CanonicalDao,
  overrides?: Partial<CanonicalTextServiceDeps>
): CanonicalTextService {
  const deps: CanonicalTextServiceDeps = {
    ...createDefaultDeps(),
    resolveDao: () => dao,
    ...overrides
  }
  return new CanonicalTextService(deps)
}

/* ------------------------------------------------------------------ *
 * 工单 05：五条 completed 终态统一接入 canonical 固化
 * ------------------------------------------------------------------ */

/**
 * 五条 completed 终态的显式清单（工单 05 完整性测试锚点）。
 *
 * 任何一条 completed 出口都必须在「标签落库 + syncFTSTags 之后」调用
 * `solidifyCanonicalForTerminal`，否则会出现「分析完成但语义文本/向量缺失」
 * 的静默缺口（聚类/整理归类/双轨索引随后全部退化）。
 */
export const CANONICAL_TERMINALS = [
  'gpu_reuse', // A：GPU 复用分支（模板套用路径）
  'simple', // B：simple 模式
  'main_flow', // C：主流程（AI/full）
  'cache_hit', // D：本地缓存 + 云端缓存命中（同一终态）
  'tier1_fallback' // E：Tier-1 命名兜底（Tier 2 失败仍 completed）
] as const

export type CanonicalTerminal = (typeof CANONICAL_TERMINALS)[number]

/**
 * 终态接入点登记表（单一事实源，完整性测试据此校验源码接线）。
 * 新增 completed 出口时必须同步登记，否则 `canonical-terminal-wiring` 测试失败。
 */
export const CANONICAL_TERMINAL_WIRING: Readonly<
  Record<CanonicalTerminal, { file: string; anchor: string }>
> = {
  gpu_reuse: {
    file: 'file-processor/index.ts',
    anchor: 'solidifyCanonicalForTerminal(\'gpu_reuse\''
  },
  simple: {
    file: 'file-processor/index.ts',
    anchor: 'solidifyCanonicalForTerminal(\'simple\''
  },
  main_flow: {
    file: 'file-processor/index.ts',
    anchor: 'solidifyCanonicalForTerminal(\'main_flow\''
  },
  cache_hit: {
    file: 'file-processor/save-cloud-result.ts',
    anchor: 'solidifyCanonicalForTerminal(\'cache_hit\''
  },
  tier1_fallback: {
    file: 'file-processor/index.ts',
    anchor: 'solidifyCanonicalForTerminal(\'tier1_fallback\''
  }
}

/**
 * 在 completed 终态调用 canonical 固化。
 *
 * 硬约束：**绝不向调用方抛异常**——canonical 失败只由服务自身写 failed + warn，
 * 分析终态照常 completed（工单 05 AC：任何终态的 canonical 失败都不阻断 completed）。
 */
export async function solidifyCanonicalForTerminal(
  terminal: CanonicalTerminal,
  fileFingerprint: string
): Promise<void> {
  try {
    await canonicalTextService.solidify(fileFingerprint)
  } catch (err: any) {
    logger.warn(
      LogCategory.ANALYSIS_QUEUE,
      `[Canonical] 终态 ${terminal} 固化调用异常（不影响 completed）: fp=${fileFingerprint}, 原因=${err?.message ?? err}`
    )
  }
}
