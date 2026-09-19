/**
 * 混合检索仲裁器（Hybrid Search Arbiter）
 * apps/desktop/src/electron/runtime-services/filesystem/virtual-directory-service/HybridSearchArbiter.ts
 *
 * 依据 ADR-0039 / PRD #679（Issue #682 分卷，Hybrid Search Everything 融合检索）：
 * 1. 加权 RRF（Reciprocal Rank Fusion）融合打分：
 *    Score(d) = W_FTS * RRF_fts(d) + W_VEC * RRF_vec(d) + W_NAME * NameMatch(d)
 *    RRF_x(d) = 1 / (K + rank_x(d))，rank 从 1 计
 * 2. 三重候选源（并行/近并行）：
 *    - 本地 FTS5 BM25（files_fts，bm25 列权对齐 file-dao.ts）
 *    - Omni 向量检索（omniClient.searchVectors，embedding 来自 omniService.analyzeText）
 *    - 文件名提升（NameMatch：name/smart_name 全子串 = 1.0，否则 token 覆盖率）
 * 3. 真实目录实时 FS 快速文件名检索（searchFastFs）：未分析命中去重后追加至结果尾部
 * 4. 端点级熔断（EndpointCircuitBreaker）：连续失败达到阈值后进入冷却期，平滑降级
 *
 * 权重配置与层级期望：
 *   K = 60, W_FTS = 2.2, W_VEC = 1.6, W_NAME = 0.9
 *   期望层级：双轨命中（name 全子串 + 向量 top1）≈ 0.926 > FTS top1 ≈ 0.036 > 纯向量 top1 ≈ 0.026
 *   （已分析且仅文件名命中的文件分数 = 0.9，会高于纯向量 FTS 未命中的语义召回，属预期取舍）
 */

import Database from 'better-sqlite3'
import {
  LogCategory,
  logger,
  tokenize,
  isUsefulToken,
  normalizeForCache,
  isTestEnvironment
} from '@firefly/shared'
import {
  omniClient,
  OmniMatchPassagesItem,
  OmniPassageMatch,
  OmniSearchFsItem
} from '../../../services/omni-client'
import { omniService } from '../../system/omni-service'

/** RRF 平滑常量 K（避免 top-rank 分数悬殊、稳定融合放缩） */
export const HYBRID_SEARCH_RRF_K = 60
/** 加权 RRF 三路权重：FTS 字面 > 向量语义 > 文件名提升 */
export const HYBRID_SEARCH_WEIGHTS = {
  fts: 2.2,
  vector: 1.6,
  name: 0.9
} as const
/** 单源候选池大小（FTS / 向量 / FS 各自的上限，也是融合池的上限） */
export const HYBRID_SEARCH_POOL_SIZE = 200
/** BM25 列权（对齐 file-dao.ts 现有 bm25(files_fts, 10.0, 5.0, 1.0, 2.0) 调用） */
export const HYBRID_BM25_COLUMN_WEIGHTS = [10.0, 5.0, 1.0, 2.0] as const

/** 已融合的已分析候选 */
export interface HybridRankedCandidate {
  fileFingerprint: string
  /** 1-based FTS5 BM25 排名 */
  ftsRank?: number
  /** 1-based 向量排名（经基础过滤后重排） */
  vecRank?: number
  /** 向量相似度（0~1） */
  vecScore?: number
  /** 文件名提升分（0~1） */
  nameBoost: number
  /** 加权 RRF 融合分数 */
  score: number
  /** 是否存在字面命中（FTS 命中或文件名全子串命中） */
  hasLiteral: boolean
}

/** 真实目录实时 FS 检索到的未分析文件命中 */
export interface HybridUnanalyzedHit {
  path: string
  name: string
  fileFingerprint?: string
}

/** 三路候选源的降级状态（true = 该路失败/被熔断跳过） */
export interface HybridSearchFailures {
  fts: boolean
  vector: boolean
  fs: boolean
}

/** 混合检索融合池结果 */
export interface HybridRankPool {
  /** 已分析候选（按分数降序） */
  candidates: HybridRankedCandidate[]
  /** 真实目录未分析命中（已去重，按 fs 顺序） */
  unanalyzedHits: HybridUnanalyzedHit[]
  failures: HybridSearchFailures
  /** 融合池总数（candidates + unanalyzedHits，供分页 total 近似） */
  total: number
}

/** 混合检索上下文（基础过滤条件由 TagTreeQuery.buildFilterQuery 提供，不含 searchKeyword 自身的 LIKE 条件） */
export interface HybridSearchContext {
  /** 已 trim 且非空的搜索词 */
  keyword: string
  /** 基础过滤条件（可选标签、工作区路径、includeUnanalyzed、状态等） */
  whereClauses: string[]
  queryParams: any[]
  /** 仅真实目录模式提供：触发 FS 实时文件名检索并追加未分析命中 */
  workspaceDirectoryPath?: string
  poolSize?: number
  /** 调用方可直接注入查询向量（测试复用 / 避免重复 analyzeText） */
  queryEmbedding?: number[]
}

/**
 * 清洗 FTS5 MATCH 查询语法干扰字符，避免 trigram 索引语法异常
 */
export function sanitizeFtsQuery(query: string): string {
  const cleaned = query
    .replace(/["*^()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || query.trim()
}

/**
 * RRF 单路得分：rank 不存在或非法时返回 0
 */
export function rrfScore(rank: number | undefined, k: number = HYBRID_SEARCH_RRF_K): number {
  if (rank === undefined || rank === null || !Number.isFinite(rank) || rank <= 0) return 0
  return 1 / (k + rank)
}

/**
 * 加权 RRF 融合得分（纯函数，便于单测）
 */
export function weightedRrfScore(
  opts: { ftsRank?: number; vecRank?: number; nameBoost?: number },
  weights: { fts: number; vector: number; name: number } = HYBRID_SEARCH_WEIGHTS,
  k: number = HYBRID_SEARCH_RRF_K
): number {
  return (
    weights.fts * rrfScore(opts.ftsRank, k) +
    weights.vector * rrfScore(opts.vecRank, k) +
    weights.name * (opts.nameBoost ?? 0)
  )
}

/**
 * 文件名提升分（NameMatch）：
 * - name / smart_name 任意一个含查询全串（不区分大小写）→ 1.0
 * - 否则取 token 覆盖率最大值（分词命中比例）
 */
export function computeNameBoost(
  name: string | undefined,
  smartName: string | undefined,
  query: string
): number {
  const q = (query || '').trim().toLowerCase()
  if (!q) return 0
  const candidates = [name, smartName]
    .filter((s): s is string => !!s && typeof s === 'string')
    .map(s => s.toLowerCase())
  if (candidates.length === 0) return 0
  const tokens = Array.from(new Set(tokenize(q))).filter(isUsefulToken)
  let best = 0
  for (const cand of candidates) {
    if (cand.includes(q)) return 1
    if (tokens.length === 0) continue
    let hitTokens = 0
    for (const t of tokens) {
      if (cand.includes(t.toLowerCase())) hitTokens += 1
    }
    const ratio = hitTokens / tokens.length
    if (ratio > best) best = ratio
  }
  return best
}

/**
 * 统一顺序分页切片（纯函数）：返回当前页条目与全池总数
 */
export function slicePage<T>(pool: T[], limit: number, offset: number): { items: T[]; total: number } {
  const safeLimit = Math.max(0, Number.isFinite(limit) ? Math.floor(limit) : 0)
  const safeOffset = Math.max(0, Number.isFinite(offset) ? Math.floor(offset) : 0)
  return {
    items: pool.slice(safeOffset, safeOffset + safeLimit),
    total: pool.length
  }
}

/** passage 切片选项 */
export interface SplitPassagesOptions {
  maxPassages?: number
  windowChars?: number
}

/**
 * 将正文切分为用于段落级语义对齐的候选片段：
 * 1. 优先按自然段落（空行分隔），
 * 2. 退化为按句子（中英文句号/问号/叹号/分号）切分，
 * 3. 超长段落以滑动窗口截断，总量封顶 maxPassages。
 */
export function splitPassages(text: string, options: SplitPassagesOptions = {}): string[] {
  const maxPassages = Math.max(1, Math.floor(options.maxPassages ?? 15))
  const windowChars = Math.max(50, Math.floor(options.windowChars ?? 200))
  if (!text || typeof text !== 'string') return []
  const cleanText = text
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim()
  if (!cleanText) return []

  // 1. 自然段落优先
  let units = cleanText
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(v => !!v && v.length > 0)
  if (units.length < 2) {
    // 2. 退化按句子切分
    const sentences: string[] = []
    for (const part of cleanText.split(/(?<=[。！？!?；;])\s*/)) {
      const s = part.trim()
      if (s) sentences.push(s)
    }
    units = sentences.length >= 2 ? sentences : [cleanText]
  }

  // 3. 长单元滑窗截断
  const passages: string[] = []
  for (const unit of units) {
    if (passages.length >= maxPassages) break
    if (unit.length <= windowChars) {
      passages.push(unit)
      continue
    }
    let idx = 0
    while (idx < unit.length) {
      if (passages.length >= maxPassages) break
      passages.push(unit.slice(idx, idx + windowChars))
      idx += windowChars
    }
  }
  return passages.slice(0, maxPassages)
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

  constructor(
    private readonly threshold: number = 3,
    private readonly cooldownMs: number = 30_000,
    private readonly now: () => number = () => Date.now()
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
  }

  recordFailure(): void {
    this.consecutiveFailures += 1
    if (this.consecutiveFailures >= this.threshold) {
      this.openUntil = this.now() + this.cooldownMs
    }
  }

  get failureCount(): number {
    return this.consecutiveFailures
  }
}

/** 向量命中（经基础过滤裁剪后的重排结果） */
interface VectorMatch {
  fileFingerprint: string
  score: number
  rank: number
}

/**
 * 混合检索仲裁器：编排 FTS5 / 向量 / 文件名三路信号并按加权 RRF 融合，
 * 真实目录模式下补充 FS 实时未分析命中。构造函数支持注入熔断器便于单测。
 */
export class HybridSearchArbiter {
  private readonly vectorBreaker: EndpointCircuitBreaker
  private readonly fsBreaker: EndpointCircuitBreaker
  private readonly networkSignals: boolean

  constructor(
    private readonly db: Database.Database,
    options?: {
      vectorBreaker?: EndpointCircuitBreaker
      fsBreaker?: EndpointCircuitBreaker
      /** 是否启用 Omni 网络信号（向量/FS/段落对齐）。默认测试环境关闭，避免真实 38200 端口请求拖慢单测 */
      networkSignals?: boolean
    }
  ) {
    this.vectorBreaker = options?.vectorBreaker ?? new EndpointCircuitBreaker()
    this.fsBreaker = options?.fsBreaker ?? new EndpointCircuitBreaker()
    this.networkSignals = options?.networkSignals ?? !isTestEnvironment()
  }

  /**
   * 执行混合检索并返回融合池（不包含分页切片，分页由调用方基于 total/candidates 执行）
   */
  async searchHybrid(context: HybridSearchContext): Promise<HybridRankPool> {
    const {
      keyword,
      whereClauses,
      queryParams,
      workspaceDirectoryPath,
      poolSize = HYBRID_SEARCH_POOL_SIZE,
      queryEmbedding
    } = context

    const failures: HybridSearchFailures = { fts: false, vector: false, fs: false }

    // 1. FTS5 BM25 / Omni 向量 / 真实目录 FS 未分析三路信号并发拉取
    // 注：未提供 workspaceDirectoryPath 时不发起 FS 检索，且不视为 FS 故障
    const attemptedFs = !!workspaceDirectoryPath
    const fsPromise = attemptedFs
      ? this.queryFastFs(workspaceDirectoryPath!, keyword, poolSize)
      : Promise.resolve(null)
    const [ftsResult, vectorResult, fsResult] = await Promise.all([
      this.queryFtsCandidates(keyword, whereClauses, queryParams, poolSize),
      this.queryVectorCandidates(
        keyword,
        queryEmbedding,
        whereClauses,
        queryParams,
        poolSize
      ),
      fsPromise
    ])

    if (ftsResult === null) failures.fts = true
    const ftsRankMap = new Map<string, number>()
    for (const [idx, fp] of (ftsResult ?? []).entries()) ftsRankMap.set(fp, idx + 1)

    if (vectorResult === null) failures.vector = true
    const vecRankMap = new Map<string, { rank: number; score: number }>()
    for (const v of vectorResult ?? []) vecRankMap.set(v.fileFingerprint, { rank: v.rank, score: v.score })

    // 2. 汇聚候选指纹并加载文件名信息
    const fpSet = new Set<string>()
    for (const fp of ftsRankMap.keys()) fpSet.add(fp)
    for (const fp of vecRankMap.keys()) fpSet.add(fp)
    const nameMap = this.queryNameMap(Array.from(fpSet))

    // 3. 加权 RRF 融合 + 降序排序
    const candidates: HybridRankedCandidate[] = []
    for (const fp of fpSet) {
      const ftsRank = ftsRankMap.get(fp)
      const vec = vecRankMap.get(fp)
      const { name, smartName } = nameMap.get(fp) ?? {}
      const nameBoost = computeNameBoost(name, smartName, keyword)
      candidates.push({
        fileFingerprint: fp,
        ftsRank,
        vecRank: vec?.rank,
        vecScore: vec?.score,
        nameBoost,
        score: weightedRrfScore({ ftsRank, vecRank: vec?.rank, nameBoost }),
        hasLiteral: ftsRank !== undefined || nameBoost >= 1
      })
    }
    candidates.sort((a, b) => {
      const diff = b.score - a.score
      if (diff !== 0) return diff
      const nameDiff = b.nameBoost - a.nameBoost
      if (nameDiff !== 0) return nameDiff
      const aMin = Math.min(a.ftsRank ?? Number.MAX_SAFE_INTEGER, a.vecRank ?? Number.MAX_SAFE_INTEGER)
      const bMin = Math.min(b.ftsRank ?? Number.MAX_SAFE_INTEGER, b.vecRank ?? Number.MAX_SAFE_INTEGER)
      if (aMin !== bMin) return aMin - bMin
      return a.fileFingerprint.localeCompare(b.fileFingerprint)
    })

    // 4. 真实目录 FS 未分析命中（去重后追加尾部）
    let unanalyzedHits: HybridUnanalyzedHit[] = []
    if (attemptedFs) {
      if (fsResult === null) {
        failures.fs = true
      } else if (fsResult.length) {
        const seenFp = new Set(candidates.map(c => c.fileFingerprint))
        const seenPath = new Set<string>()
        for (const c of candidates) {
          const p = nameMap.get(c.fileFingerprint)?.path
          if (p) seenPath.add(normalizeForCache(p))
        }
        for (const hit of fsResult) {
          if (!hit || !hit.path || !hit.name) continue
          if (hit.fileFingerprint && seenFp.has(hit.fileFingerprint)) continue
          const key = normalizeForCache(hit.path)
          if (seenPath.has(key)) continue
          seenFp.add(hit.fileFingerprint ?? '')
          seenPath.add(key)
          unanalyzedHits.push({
            path: hit.path,
            name: hit.name,
            fileFingerprint: hit.fileFingerprint ?? undefined
          })
          if (unanalyzedHits.length >= poolSize) break
        }
      }
    }

    return {
      candidates,
      unanalyzedHits,
      failures,
      total: candidates.length + unanalyzedHits.length
    }
  }

  /**
   * 段落级语义对齐（matchPassages）：为无字面命中的候选生成最契合段落摘要。
   * 失败/熔断时返回空映射，由调用方降级为语义首段摘要。
   */
  async alignPassages(
    keyword: string,
    items: OmniMatchPassagesItem[]
  ): Promise<Record<string, OmniPassageMatch>> {
    if (!items.length) return {}
    if (!this.networkSignals) return {}
    try {
      const resp = await omniClient.matchPassages(keyword, items)
      const map: Record<string, OmniPassageMatch> = {}
      if (resp && Array.isArray(resp.matches)) {
        for (const m of resp.matches) {
          if (m && m.fileFingerprint) map[m.fileFingerprint] = m
        }
      }
      return map
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(
        LogCategory.VIRTUAL_DIRECTORY,
        '[HybridSearchArbiter] 段落语义对齐失败，降级为语义首段摘要:',
        msg
      )
      return {}
    }
  }

  get isVectorSearchOpen(): boolean {
    return this.vectorBreaker.isOpen
  }

  get isFastFsSearchOpen(): boolean {
    return this.fsBreaker.isOpen
  }

  /** FTS5 快速字面候选（按 bm25 权重升序 = 相关度降序），返回 null 表示该路失败 */
  private queryFtsCandidates(
    keyword: string,
    whereClauses: string[],
    queryParams: any[],
    poolSize: number
  ): string[] | null {
    try {
      const ftsTable = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='files_fts'")
        .get()
      if (!ftsTable) return []
      const rows = this.db
        .prepare(`
          SELECT f.file_fingerprint AS file_fingerprint
          FROM files_fts
          JOIN files f ON f.rowid = files_fts.rowid
          JOIN workspace_files wf ON wf.file_fingerprint = f.file_fingerprint
          WHERE files_fts MATCH ?
            AND ${whereClauses.join(' AND ')}
          ORDER BY bm25(files_fts, ${HYBRID_BM25_COLUMN_WEIGHTS.join(', ')}) ASC
          LIMIT ?
        `)
        .all(sanitizeFtsQuery(keyword), ...queryParams, poolSize) as Array<{ file_fingerprint: string }>
      return rows.map(r => r.file_fingerprint)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(LogCategory.VIRTUAL_DIRECTORY, '[HybridSearchArbiter] FTS5 检索失败，降级: ', msg)
      return null
    }
  }

  /** 向量候选（分析Text→embedding→searchVectors→基础过滤），返回 null 表示失败或熔断 */
  private async queryVectorCandidates(
    keyword: string,
    queryEmbedding: number[] | undefined,
    whereClauses: string[],
    queryParams: any[],
    poolSize: number
  ): Promise<VectorMatch[] | null> {
    if (this.vectorBreaker.isOpen) return null
    if (!this.networkSignals) return []
    try {
      let embedding = queryEmbedding
      if (!embedding || embedding.length === 0) {
        const analysis = await omniService.analyzeText(keyword)
        embedding = analysis?.embedding_dense
      }
      if (!embedding || embedding.length === 0) {
        this.vectorBreaker.recordFailure()
        return null
      }
      const resp = await omniClient.searchVectors(embedding, poolSize)
      if (!resp || !Array.isArray(resp.matches)) {
        this.vectorBreaker.recordFailure()
        return null
      }
      if (resp.matches.length === 0) {
        // 空结果属于正常意图（如向量库尚无条目），不视为端点故障
        this.vectorBreaker.recordSuccess()
        return []
      }
      this.vectorBreaker.recordSuccess()

      // 与基础过滤条件取交集，并保持服务端相似度降序（即服务端返回顺序）重排 rank
      const allowed = this.filterMembersFromBase(
        resp.matches.map(m => m.fileFingerprint),
        whereClauses,
        queryParams
      )
      const out: VectorMatch[] = []
      for (const [idx, m] of resp.matches.entries()) {
        if (allowed.has(m.fileFingerprint)) {
          out.push({ fileFingerprint: m.fileFingerprint, score: m.score, rank: idx + 1 })
        }
      }
      return out
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(LogCategory.VIRTUAL_DIRECTORY, '[HybridSearchArbiter] 向量检索失败，降级为 FTS+文件名: ', msg)
      return null
    }
  }

  /** 真实目录 FS 快速文件名检索（返回 null 表示失败/熔断/未启用） */
  private async queryFastFs(
    workspaceDirectoryPath: string,
    keyword: string,
    poolSize: number
  ): Promise<OmniSearchFsItem[] | null> {
    if (this.fsBreaker.isOpen) return null
    if (!this.networkSignals) return []
    try {
      const resp = await omniClient.searchFastFs(workspaceDirectoryPath, keyword, poolSize)
      if (!resp || !Array.isArray(resp.items)) {
        this.fsBreaker.recordFailure()
        return null
      }
      this.fsBreaker.recordSuccess()
      return resp.items.slice(0, poolSize)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(LogCategory.VIRTUAL_DIRECTORY, '[HybridSearchArbiter] FS 快速文件名检索失败: ', msg)
      return null
    }
  }

  /** 将指纹列表与基础过滤条件取交集返回允许集合 */
  private filterMembersFromBase(
    fingerprints: string[],
    whereClauses: string[],
    queryParams: any[]
  ): Set<string> {
    if (fingerprints.length === 0) return new Set<string>()
    const placeholders = fingerprints.map(() => '?').join(',')
    const sql = `
      SELECT DISTINCT wf.file_fingerprint AS file_fingerprint
      FROM workspace_files wf
      WHERE wf.file_fingerprint IN (${placeholders})
        AND ${whereClauses.join(' AND ')}
    `
    try {
      const rows = this.db.prepare(sql).all(...fingerprints, ...queryParams) as Array<{
        file_fingerprint: string
      }>
      return new Set(rows.map(r => r.file_fingerprint))
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(LogCategory.VIRTUAL_DIRECTORY, '[HybridSearchArbiter] 向量候选基础过滤失败，放行全部: ', msg)
      // 过滤失败时放行全部，主查询的分页 WHERE 仍会兜底过滤
      return new Set(fingerprints)
    }
  }

  /** 批量加载文件名（name/smart_name/path）用于 NameMatch 提升与 FS 去重 */
  private queryNameMap(
    fileFingerprints: string[]
  ): Map<string, { name?: string; smartName?: string; path?: string }> {
    const map = new Map<string, { name?: string; smartName?: string; path?: string }>()
    if (fileFingerprints.length === 0) return map
    const placeholders = fileFingerprints.map(() => '?').join(',')
    const sql = `
      SELECT wf.file_fingerprint AS file_fingerprint,
             wf.name AS name,
             f.smart_name AS smart_name,
             wf.path AS path
      FROM workspace_files wf
      LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
      WHERE wf.file_fingerprint IN (${placeholders})
    `
    try {
      const rows = this.db.prepare(sql).all(...fileFingerprints) as Array<{
        file_fingerprint: string
        name: string | null
        smart_name: string | null
        path: string | null
      }>
      for (const r of rows) {
        map.set(r.file_fingerprint, {
          name: r.name ?? undefined,
          smartName: r.smart_name ?? undefined,
          path: r.path ?? undefined
        })
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(LogCategory.VIRTUAL_DIRECTORY, '[HybridSearchArbiter] 文件名映射查询失败: ', msg)
    }
    return map
  }
}