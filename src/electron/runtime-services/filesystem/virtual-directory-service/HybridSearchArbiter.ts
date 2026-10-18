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
  isTestEnvironment,
  isStopwordOrGenericWord,
  hasValidNameMinLength
} from '@firefly/shared'
import {
  omniClient,
  OmniMatchPassagesItem,
  OmniPassageMatch,
  OmniSearchFsItem
} from '../../../services/omni-client'
import { omniService } from '../../system/omni-service'
import { calculateFzfScore } from './pinyin-fzf'

/** RRF 平滑常量 K（避免 top-rank 分数悬殊、稳定融合放缩） */
export const HYBRID_SEARCH_RRF_K = 60
/** 加权 RRF 四路权重：精确标识符 > 文件名提升 / FTS 字面 / 向量语义（跨媒体量纲统一平权） */
export const HYBRID_SEARCH_WEIGHTS = {
  fts: 2.2,
  vector: 2.0,
  name: 2.4,
  exact: 2.8
} as const
/** 单源候选池大小（FTS / 向量 / FS 各自的上限，也是融合池的上限） */
export const HYBRID_SEARCH_POOL_SIZE = 200
/** BM25 完整 10 列列权（第 0 列为 file_fingerprint UNINDEXED 赋 0.0，随后 9 列对齐 files_fts 架构：name, smart_name, description, content, multimodal_content, ocr, lrc, asr, tags） */
export const HYBRID_BM25_COLUMN_WEIGHTS = [0.0, 4.0, 4.0, 3.0, 3.0, 3.5, 3.5, 3.0, 3.5, 3.5] as const

/** 列权名字典：恪守第一性原理，终结文件名在 BM25 中的超额膨胀，使图片 OCR、音频 ASR、视觉实体与文档正文健康平权 */
export const DEFAULT_COLUMN_WEIGHT_MAP: Record<string, number> = {
  name: 4.0,
  smart_name: 4.0,
  tags: 3.5,
  multimodal_content: 3.5,
  ocr: 3.5,
  asr: 3.5,
  content: 3.0,
  description: 3.0,
  lrc: 3.0
}

/** 已融合的已分析候选 */
export interface HybridRankedCandidate {
  fileFingerprint: string
  /** 1-based FTS5 BM25 排名 */
  ftsRank?: number
  /** 1-based 向量排名（经基础过滤后重排） */
  vecRank?: number
  /** 1-based 精确标识符匹配排名 */
  exactRank?: number
  /** 向量相似度（0~1） */
  vecScore?: number
  /** 文件名提升分（0~1） */
  nameBoost: number
  /** 加权 RRF 融合分数 */
  score: number
  /** 是否存在字面命中（FTS 命中或文件名全子串命中） */
  hasLiteral: boolean
  /** 命中的视频时序切片（若命中条目为视频时序切片向量） */
  matchedChunk?: {
    chunkIndex: number
    startSec: number
    endSec: number
    similarity?: number
  }
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
 * 严格标识符特征探针（Strict Identifier Probe）
 * 依据 Spec §3.3.1：
 * 1. 中英混排纯净抽取：使用 match 直接抽取纯净子串，杜绝中文字串污染捕获；
 * 2. 防日期误判：Hash 规则明确要求包含十六进制字母（[a-fA-F]），严禁将纯数字日期误判为短 Hash；
 * 3. 显式排除公历年份与纯数字。
 */
export class IdentifierProbe {
  // 1. 下划线编程变量与错误码 (支持 handle_auth_token, ERR_403, STATUS_TIMEOUT): 至少包含一个下划线且长度 >= 5
  private static readonly RE_UNDERSCORE_IDENTIFIER = /[A-Za-z0-9]{2,}_[A-Za-z0-9_]{2,}/g

  // 2. 发票号与业务流水单号 (支持多段连字符与后缀，绝不截断 INV-2026-088, PO-99120)
  private static readonly RE_INVOICE_SERIAL = /[A-Za-z]{2,5}-\d{2,}(?:-[A-Za-z0-9]+)*/g

  // 3. 严格小驼峰编程变量/函数 (前缀至少2个小写字母，紧随大写字母，排除 iPhone/iPad): getUserInfo, parseTokens
  private static readonly RE_CAMEL_CASE = /\b[a-z]{2,}(?:[A-Z][a-z0-9]+)+\b/g

  // 4. 标准 UUID 与十六进制短 Hash (要求至少包含一个十六进制字母 a-f，防止 20251016 等纯数字日期误判):
  private static readonly RE_UUID = /[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}/g
  private static readonly RE_HEX_HASH =
    /\b(?=[0-9a-fA-F]{7,40}\b)(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]+\b/g

  /** 判定查询串中是否存在强标识符模式，返回抽取的纯净标识符列表 */
  public static extractIdentifiers(query: string): string[] {
    const trimmed = query.trim()
    if (!trimmed) return []

    // 显式排除公历年份与纯短数字 (如 2024, 2025, 2026)
    if (/^\b(19|20)\d{2}\b$/.test(trimmed) || /^\d+$/.test(trimmed)) {
      return []
    }

    const matches = new Set<string>()

    // 使用 match 全局匹配直接抽取纯净子串，杜绝中英混排污染
    const underscores = query.match(this.RE_UNDERSCORE_IDENTIFIER) || []
    const invoices = query.match(this.RE_INVOICE_SERIAL) || []
    const camelCases = query.match(this.RE_CAMEL_CASE) || []
    const uuids = query.match(this.RE_UUID) || []

    // 剔除已抽取的复合标识符与 UUID，避免将其子串误判为独立 Hash
    let queryForHash = query
    for (const token of [...uuids, ...invoices, ...underscores]) {
      queryForHash = queryForHash.replace(token, ' ')
    }
    const hexHashes = queryForHash.match(this.RE_HEX_HASH) || []

    for (const m of [...underscores, ...invoices, ...camelCases, ...uuids, ...hexHashes]) {
      if (!/^\d+$/.test(m) && !/^(19|20)\d{2}$/.test(m)) {
        matches.add(m)
      }
    }

    return Array.from(matches)
  }
}

/**
 * 包装精确短语查询字符串，转义内部引号并包裹双引号
 */
export function formatExactPhraseQuery(id: string): string {
  const safe = id.replace(/"/g, '""')
  return `"${safe}"`
}

/**
 * 清洗 FTS5 MATCH 查询语法干扰字符，避免 trigram 索引语法异常
 * 若输入为已转义且成对包装的精确短语查询（如 "INV-2026-088"），予以安全保留
 */
export function sanitizeFtsQuery(query: string): string {
  const trimmed = query.trim()
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 2) {
    const inner = trimmed.slice(1, -1)
    const innerQuotes = inner.match(/"/g)?.length ?? 0
    if (innerQuotes === 0 || innerQuotes % 2 === 0) {
      const safeInner = inner.replace(/[*^()]/g, ' ')
      return `"${safeInner}"`
    }
  }
  const cleaned = query
    .replace(/["*^()\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned || query.trim()
}

/**
 * 剥离常见数量词与冠词前缀（如 "一辆", "两只", "三部", "几个", "一张", "一段", "一个", "a ", "the " 等），
 * 提取纯净核心实体概念，避免量词与冠词分散多模态多语言分词器对核心实体的注意力权重。
 */
export function cleanSearchQueryEntities(text: string): string {
  if (!text) return text
  // 1. 中文常见数词+量词前缀剥离
  const quantifierRegex = /^[一两三四五六七八九十几]+[个只辆张部条架顶本套根群首座栋双把台副所顶间支件块面扇道头匹段幅尾]\s*/
  let cleaned = text.replace(quantifierRegex, '').trim()
  // 2. 国际化英文常见冠词/数词前缀剥离 (a, an, the, one)
  cleaned = cleaned.replace(/^(?:a|an|the|one)\s+/i, '').trim()
  return cleaned || text
}

/**
 * RRF 单路得分：rank 不存在或非法时返回 0
 */
export function rrfScore(rank: number | undefined, k: number = HYBRID_SEARCH_RRF_K): number {
  if (rank === undefined || rank === null || !Number.isFinite(rank) || rank <= 0) return 0
  return 1 / (k + rank)
}

/**
 * 加权 RRF 融合得分（纯函数，便于单测）：
 * 恪守第一性原理彻底统一所有检索源的数学度量衡，杜绝裸加分项产生数量级压制：
 * 1. 向量通道注入模型真实语义相似度物理量 vecScore (0.0~1.0)，在保持 RRF 单调性的同时奖励高置信度多模态实体；
 * 2. 文件名提升分经过 (k+1) 归一化对齐到 RRF 标准尺度，杜绝 0.9 裸分对正文、图片与音频产生数十倍暴力碾压；
 * 3. 严格包含防 NaN、防负数安全守卫。
 */
export function weightedRrfScore(
  opts: { ftsRank?: number; vecRank?: number; nameBoost?: number; exactRank?: number; vecScore?: number },
  weights: { fts: number; vector: number; name: number; exact?: number } = HYBRID_SEARCH_WEIGHTS,
  k: number = HYBRID_SEARCH_RRF_K
): number {
  const wExact = weights.exact ?? HYBRID_SEARCH_WEIGHTS.exact
  const baseVec = rrfScore(opts.vecRank, k)
  // 当存在有效向量相似度时，按 (1.0 + clamp(vecScore, 0, 1)) 注入多模态语义置信度
  const scoreMultiplier =
    opts.vecScore !== undefined && Number.isFinite(opts.vecScore)
      ? 1.0 + Math.max(0, Math.min(1, opts.vecScore))
      : 1.0
  const vecContrib = weights.vector * baseVec * scoreMultiplier

  const safeNameBoost = Number.isFinite(opts.nameBoost) ? Math.max(0, opts.nameBoost ?? 0) : 0
  const nameRrf = safeNameBoost / (k + 1)
  const nameContrib = weights.name * nameRrf

  return (
    weights.fts * rrfScore(opts.ftsRank, k) +
    vecContrib +
    nameContrib +
    wExact * rrfScore(opts.exactRank, k)
  )
}

/**
 * 文件名提升分（NameMatch）：
 * - name / smart_name 任意一个含查询全串（不区分大小写）→ 1.0 (强字面置顶)
 * - 否则取核心有效 token 覆盖率并施加平滑阻尼（封顶 0.035），防止无意义单字虚假命中暴打向量与 FTS
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
  if (candidates.length === 0) return 0

  // 1. 全串完全包含 / fzf 边界加权 / 拼音首字母匹配
  let bestFzf = 0
  for (const cand of candidates) {
    const fzfScore = calculateFzfScore(q, cand)
    if (fzfScore > bestFzf) bestFzf = fzfScore
  }

  // 若 fzf / 拼音首字母缩写匹配达到高置信度（>= 0.85，对应完全子串包含、紧凑包含、拼音首字母或缩写命中），直接返回高提升分
  if (bestFzf >= 0.85) {
    return bestFzf
  }

  // 2. 严格 token 抽取：结合标签过滤方案（tag-admissibility SSOT）与国际化最小字数门禁
  // 2.1 依赖 tag-admissibility 体系过滤中英文停用词、通用文件系统泛词（temp/copy/新建等）、元保留字与抽象空洞壳名词
  // 2.2 结合 hasValidNameMinLength（支持 10 种国际化语言最小字数要求：东亚 CJK >= 2，拉丁等纯字母 >= 2，4K 等规格放行）
  const rawTokens = Array.from(new Set(tokenize(q))).filter(isUsefulToken)
  const effectiveTokens = rawTokens.filter(t => {
    // 结合标签准入门禁：过滤停用词、抽象空洞词与通用文件系统占位词
    if (isStopwordOrGenericWord(t).matched) return false
    // 结合 10 语最小字数门禁：仅当查询全串自身满足最小长度要求时，才剔除不满足最小长度的子词片段
    if (hasValidNameMinLength(q) && !hasValidNameMinLength(t)) return false
    return true
  })

  // 若全部有效词均被过滤（如极端停用词检索），平滑退化使用原始 useful tokens
  const tokensToScore = effectiveTokens.length > 0 ? effectiveTokens : rawTokens
  if (tokensToScore.length === 0) {
    return Math.round(bestFzf * 0.035 * 1000) / 1000
  }

  let bestTokenScore = 0
  for (const cand of candidates) {
    const candLower = cand.toLowerCase()
    let hitTokens = 0
    for (const t of tokensToScore) {
      if (candLower.includes(t.toLowerCase())) hitTokens += 1
    }
    const ratio = hitTokens / tokensToScore.length
    // 部分匹配平滑阻尼，上限 0.035（加权后为 0.9 * 0.035 = 0.0315），
    // 确保与高质量向量 Top 1（0.0328）同级良性竞争，绝不暴力碾压纯多模态语义召回
    const score = ratio * 0.035
    if (score > bestTokenScore) bestTokenScore = score
  }

  const dampenedFzf = Math.round(bestFzf * 0.035 * 1000) / 1000
  return Math.round(Math.max(bestTokenScore, dampenedFzf) * 1000) / 1000
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
  matchedChunk?: {
    chunkIndex: number
    startSec: number
    endSec: number
    similarity?: number
  }
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
  /**
   * 内部构建加权 RRF 排序候选
   */
  private buildRankedCandidates(opts: {
    keyword: string
    ftsRankMap: Map<string, number>
    exactRankMap: Map<string, number>
    vecRankMap: Map<string, { rank: number; score: number; matchedChunk?: VectorMatch['matchedChunk'] }>
    existingNameMap?: Map<string, { name?: string; smartName?: string; path?: string }>
  }): {
    candidates: HybridRankedCandidate[]
    nameMap: Map<string, { name?: string; smartName?: string; path?: string }>
  } {
    const { keyword, ftsRankMap, exactRankMap, vecRankMap, existingNameMap } = opts
    const fpSet = new Set<string>()
    for (const fp of ftsRankMap.keys()) fpSet.add(fp)
    for (const fp of vecRankMap.keys()) fpSet.add(fp)
    for (const fp of exactRankMap.keys()) fpSet.add(fp)

    let nameMap: Map<string, { name?: string; smartName?: string; path?: string }>
    if (existingNameMap) {
      nameMap = new Map(existingNameMap)
      const missingFps = Array.from(fpSet).filter(fp => !nameMap.has(fp))
      if (missingFps.length > 0) {
        const deltaMap = this.queryNameMap(missingFps)
        for (const [k, v] of deltaMap) nameMap.set(k, v)
      }
    } else {
      nameMap = this.queryNameMap(Array.from(fpSet))
    }

    const candidates: HybridRankedCandidate[] = []
    for (const fp of fpSet) {
      const ftsRank = ftsRankMap.get(fp)
      const vec = vecRankMap.get(fp)
      const exactRank = exactRankMap.get(fp)
      const { name, smartName } = nameMap.get(fp) ?? {}
      const nameBoost = computeNameBoost(name, smartName, keyword)
      candidates.push({
        fileFingerprint: fp,
        ftsRank,
        vecRank: vec?.rank,
        exactRank,
        vecScore: vec?.score,
        nameBoost,
        score: weightedRrfScore({
          ftsRank,
          vecRank: vec?.rank,
          nameBoost,
          exactRank,
          vecScore: vec?.score
        }),
        hasLiteral: exactRank !== undefined || ftsRank !== undefined || nameBoost >= 0.85,
        matchedChunk: vec?.matchedChunk
      })
    }
    candidates.sort((a, b) => {
      const diff = b.score - a.score
      if (diff !== 0) return diff
      const exactDiff =
        (a.exactRank ?? Number.MAX_SAFE_INTEGER) - (b.exactRank ?? Number.MAX_SAFE_INTEGER)
      if (exactDiff !== 0) return exactDiff
      const nameDiff = b.nameBoost - a.nameBoost
      if (nameDiff !== 0) return nameDiff
      const aMin = Math.min(a.ftsRank ?? Number.MAX_SAFE_INTEGER, a.vecRank ?? Number.MAX_SAFE_INTEGER)
      const bMin = Math.min(b.ftsRank ?? Number.MAX_SAFE_INTEGER, b.vecRank ?? Number.MAX_SAFE_INTEGER)
      if (aMin !== bMin) return aMin - bMin
      return a.fileFingerprint.localeCompare(b.fileFingerprint)
    })
    return { candidates, nameMap }
  }

  /**
   * 内部构建 FS 未分析命中去重列表
   */
  private buildUnanalyzedHits(opts: {
    fsResult: OmniSearchFsItem[] | null
    candidates: HybridRankedCandidate[]
    nameMap: Map<string, { name?: string; smartName?: string; path?: string }>
    poolSize: number
  }): HybridUnanalyzedHit[] {
    const { fsResult, candidates, nameMap, poolSize } = opts
    if (!fsResult || !fsResult.length) return []
    const unanalyzedHits: HybridUnanalyzedHit[] = []
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
    return unanalyzedHits
  }

  /**
   * 执行混合检索并返回融合池（支持 Phase 1 流式快速回调）
   */
  async searchHybrid(
    context: HybridSearchContext,
    onPhase1?: (phase1Pool: HybridRankPool) => Promise<void> | void
  ): Promise<HybridRankPool> {
    const {
      keyword,
      whereClauses,
      queryParams,
      workspaceDirectoryPath,
      poolSize = HYBRID_SEARCH_POOL_SIZE,
      queryEmbedding
    } = context

    const failures: HybridSearchFailures = { fts: false, vector: false, fs: false }
    const attemptedFs = !!workspaceDirectoryPath

    // 1. 并发启动快速字面三路与慢速向量路
    const fsPromise = attemptedFs
      ? this.queryFastFs(workspaceDirectoryPath!, keyword, poolSize)
      : Promise.resolve(null)
    const identifiers = IdentifierProbe.extractIdentifiers(keyword)
    const exactPromise =
      identifiers.length > 0
        ? Promise.resolve(
            this.queryExactPhraseCandidates(identifiers, whereClauses, queryParams, poolSize)
          )
        : Promise.resolve([])
    const ftsPromise = this.queryFtsCandidates(keyword, whereClauses, queryParams, poolSize)
    const vectorPromise = this.queryVectorCandidates(
      keyword,
      queryEmbedding,
      whereClauses,
      queryParams,
      poolSize
    )

    // Phase 1: 等待快速字面三路完成 (通常 10~25ms)
    const [ftsResult, fsResult, exactResult] = await Promise.all([
      ftsPromise,
      fsPromise,
      exactPromise
    ])

    if (ftsResult === null) failures.fts = true
    const ftsRankMap = new Map<string, number>()
    for (const [idx, fp] of (ftsResult ?? []).entries()) ftsRankMap.set(fp, idx + 1)

    const exactRankMap = new Map<string, number>()
    for (const [idx, fp] of (exactResult ?? []).entries()) exactRankMap.set(fp, idx + 1)

    if (attemptedFs && fsResult === null) failures.fs = true

    // 若注册了 Phase 1 回调，立即基于字面三路构建 Phase 1 融合池并向上回调
    let p1NameMap: Map<string, { name?: string; smartName?: string; path?: string }> | undefined
    if (onPhase1) {
      const p1 = this.buildRankedCandidates({
        keyword,
        ftsRankMap,
        exactRankMap,
        vecRankMap: new Map()
      })
      p1NameMap = p1.nameMap
      const p1Unanalyzed = this.buildUnanalyzedHits({
        fsResult,
        candidates: p1.candidates,
        nameMap: p1.nameMap,
        poolSize
      })
      await onPhase1({
        candidates: p1.candidates,
        unanalyzedHits: p1Unanalyzed,
        failures: { ...failures },
        total: p1.candidates.length + p1Unanalyzed.length
      })
    }

    // Phase 2: 等待慢速向量计算完成
    const vectorResult = await vectorPromise
    if (vectorResult === null) failures.vector = true
    const vecRankMap = new Map<
      string,
      { rank: number; score: number; matchedChunk?: VectorMatch['matchedChunk'] }
    >()
    for (const v of vectorResult ?? []) {
      vecRankMap.set(v.fileFingerprint, {
        rank: v.rank,
        score: v.score,
        matchedChunk: v.matchedChunk
      })
    }

    const p2 = this.buildRankedCandidates({
      keyword,
      ftsRankMap,
      exactRankMap,
      vecRankMap,
      existingNameMap: p1NameMap
    })
    const unanalyzedHits = this.buildUnanalyzedHits({
      fsResult,
      candidates: p2.candidates,
      nameMap: p2.nameMap,
      poolSize
    })

    return {
      candidates: p2.candidates,
      unanalyzedHits,
      failures,
      total: p2.candidates.length + unanalyzedHits.length
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

  /** 精确标识符候选（按 FTS5 短语 BM25 + 文件名精确匹配），返回匹配指纹列表 */
  private queryExactPhraseCandidates(
    identifiers: string[],
    whereClauses: string[],
    queryParams: any[],
    poolSize: number
  ): string[] {
    if (identifiers.length === 0) return []
    try {
      const ftsTable = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='files_fts'")
        .get()
      const results: string[] = []
      const seen = new Set<string>()

      const extraWhere = whereClauses.length > 0 ? `AND ${whereClauses.join(' AND ')}` : ''

      for (const id of identifiers) {
        if (ftsTable) {
          const phraseQuery = sanitizeFtsQuery(formatExactPhraseQuery(id))
          const rows = this.db
            .prepare(`
              SELECT f.file_fingerprint AS file_fingerprint
              FROM files_fts
              JOIN files f ON f.rowid = files_fts.rowid
              JOIN workspace_files wf ON wf.file_fingerprint = f.file_fingerprint
              WHERE files_fts MATCH ?
                ${extraWhere}
              ORDER BY bm25(files_fts, ${HYBRID_BM25_COLUMN_WEIGHTS.join(', ')}) ASC
              LIMIT ?
            `)
            .all(phraseQuery, ...queryParams, poolSize) as Array<{ file_fingerprint: string }>
          for (const r of rows) {
            if (!seen.has(r.file_fingerprint)) {
              seen.add(r.file_fingerprint)
              results.push(r.file_fingerprint)
            }
          }
        }

        const escapedId = `%${id.replace(/([%_\\])/g, '\\$1')}%`
        const nameRows = this.db
          .prepare(`
            SELECT wf.file_fingerprint AS file_fingerprint
            FROM workspace_files wf
            LEFT JOIN files f ON f.file_fingerprint = wf.file_fingerprint
            WHERE (wf.name LIKE ? ESCAPE '\\' OR f.smart_name LIKE ? ESCAPE '\\')
              ${extraWhere}
            LIMIT ?
          `)
          .all(escapedId, escapedId, ...queryParams, poolSize) as Array<{ file_fingerprint: string }>
        for (const r of nameRows) {
          if (!seen.has(r.file_fingerprint)) {
            seen.add(r.file_fingerprint)
            results.push(r.file_fingerprint)
          }
        }
      }
      return results.slice(0, poolSize)
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(LogCategory.VIRTUAL_DIRECTORY, '[HybridSearchArbiter] 精确标识符候选查询失败: ', msg)
      return []
    }
  }

  /** FTS5 快速字面候选（按 bm25 权重升序 = 相关度降序），包含短词/多词智能 LIKE 安全降级召回，返回 null 表示该路失败 */
  private queryFtsCandidates(
    keyword: string,
    whereClauses: string[],
    queryParams: any[],
    poolSize: number
  ): string[] | null {
    try {
      const ftsCols = this.db
        .prepare("PRAGMA table_info(files_fts)")
        .all() as Array<{ name: string }>
      if (!ftsCols || ftsCols.length === 0) return []

      const indexedCols = ftsCols.filter(c => c.name !== 'file_fingerprint').map(c => c.name)
      const colSet = new Set(indexedCols)
      const extraWhere = whereClauses.length > 0 ? `AND ${whereClauses.join(' AND ')}` : ''

      const trimmed = (keyword || '').trim()
      if (!trimmed) return []

      let rows: Array<{ file_fingerprint: string }> = []
      const tokens = trimmed.split(/\s+/).filter(Boolean)
      const hasLongToken = tokens.some(t => t.length >= 3)

      // 1. 若存在 >=3 字符的有效 token，优先尝试 FTS5 trigram MATCH
      if (hasLongToken) {
        try {
          const safeQuery = sanitizeFtsQuery(trimmed)
          if (safeQuery) {
            // FTS5 bm25 严格按虚拟表物理声明列顺序（从 0 开始）赋值，包含 UNINDEXED 列
            // 第 0 列 file_fingerprint UNINDEXED 必须赋予 0.0 占位，避免后续列权向左整体错位！
            const weights = ftsCols.map(c =>
              c.name === 'file_fingerprint' ? 0.0 : (DEFAULT_COLUMN_WEIGHT_MAP[c.name] ?? 1.0)
            )
            rows = this.db
              .prepare(`
                SELECT f.file_fingerprint AS file_fingerprint
                FROM files_fts
                JOIN files f ON f.rowid = files_fts.rowid
                JOIN workspace_files wf ON wf.file_fingerprint = f.file_fingerprint
                WHERE files_fts MATCH ?
                  ${extraWhere}
                ORDER BY bm25(files_fts, ${weights.join(', ')}) ASC
                LIMIT ?
              `)
              .all(safeQuery, ...queryParams, poolSize) as Array<{ file_fingerprint: string }>
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.warn(LogCategory.VIRTUAL_DIRECTORY, '[HybridSearchArbiter] FTS MATCH 异常，降级进入多列 LIKE 召回: ', msg)
        }
      }

      // 2. 若 MATCH 未能召回任何候选（短词 <3 字符、空格分隔多词或未命中），执行多列 LIKE 安全降级召回
      if (rows.length === 0 && tokens.length > 0) {
        // 保守防 DoS 截断：最多取前 8 个有效词
        const safeTokens = tokens.slice(0, 8)
        const targetSearchCols = [
          'name',
          'smart_name',
          'description',
          'content',
          'multimodal_content',
          'ocr',
          'asr',
          'lrc',
          'tags'
        ].filter(c => colSet.has(c))

        if (targetSearchCols.length > 0) {
          const likeConditions: string[] = []
          const likeParams: any[] = []
          for (const token of safeTokens) {
            const colLikes = targetSearchCols.map(c => `files_fts.${c} LIKE ? ESCAPE '\\'`).join(' OR ')
            likeConditions.push(`(${colLikes})`)
            const p = `%${token.replace(/([%_\\])/g, '\\$1')}%`
            for (let i = 0; i < targetSearchCols.length; i++) {
              likeParams.push(p)
            }
          }

          const exactNameParam = `%${trimmed.replace(/([%_\\])/g, '\\$1')}%`
          // GROUP BY f.file_fingerprint 防止多工作区/多路径文件重复占用 LIMIT 并干扰 RRF rank
          const fallbackSql = `
            SELECT f.file_fingerprint AS file_fingerprint
            FROM files_fts
            JOIN files f ON f.rowid = files_fts.rowid
            JOIN workspace_files wf ON wf.file_fingerprint = f.file_fingerprint
            WHERE ${likeConditions.join(' AND ')}
              ${extraWhere}
            GROUP BY f.file_fingerprint
            ORDER BY
              MIN(
                CASE
                  WHEN wf.name LIKE ? ESCAPE '\\' THEN 0
                  ${colSet.has('smart_name') ? "WHEN files_fts.smart_name LIKE ? ESCAPE '\\' THEN 0" : ''}
                  ${colSet.has('tags') ? "WHEN files_fts.tags LIKE ? ESCAPE '\\' THEN 1" : ''}
                  ${colSet.has('ocr') ? "WHEN files_fts.ocr LIKE ? ESCAPE '\\' THEN 1" : ''}
                  ${colSet.has('asr') ? "WHEN files_fts.asr LIKE ? ESCAPE '\\' THEN 1" : ''}
                  ${colSet.has('multimodal_content') ? "WHEN files_fts.multimodal_content LIKE ? ESCAPE '\\' THEN 1" : ''}
                  ${colSet.has('content') ? "WHEN files_fts.content LIKE ? ESCAPE '\\' THEN 2" : ''}
                  ${colSet.has('description') ? "WHEN files_fts.description LIKE ? ESCAPE '\\' THEN 2" : ''}
                  ${colSet.has('lrc') ? "WHEN files_fts.lrc LIKE ? ESCAPE '\\' THEN 2" : ''}
                  ELSE 3
                END
              ) ASC,
              wf.id DESC
            LIMIT ?
          `
          const orderParams = [exactNameParam]
          if (colSet.has('smart_name')) orderParams.push(exactNameParam)
          if (colSet.has('tags')) orderParams.push(exactNameParam)
          if (colSet.has('ocr')) orderParams.push(exactNameParam)
          if (colSet.has('asr')) orderParams.push(exactNameParam)
          if (colSet.has('multimodal_content')) orderParams.push(exactNameParam)
          if (colSet.has('content')) orderParams.push(exactNameParam)
          if (colSet.has('description')) orderParams.push(exactNameParam)
          if (colSet.has('lrc')) orderParams.push(exactNameParam)

          rows = this.db.prepare(fallbackSql).all(
            ...likeParams,
            ...queryParams,
            ...orderParams,
            poolSize
          ) as Array<{ file_fingerprint: string }>
        }
      }

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
        const cleanKeyword = cleanSearchQueryEntities(keyword)
        // 剥离中文修饰助词（如 "红色的跑车" -> "红色跑车"），使自然语言描述与视觉向量特征空间紧密对齐；
        // 彻底剔除脱离模型实际输入分布的人工提示词前缀 (如 'task: search result | query: ')，
        // 杜绝 28 字节通用英文 ASCII 提示词暴力稀释核心语义，根除所有车辆查询均千篇一律收敛至同一噪点切片 (如 03:24) 的严重偏置。
        const normalizedQuery = cleanKeyword
          .replace(/(?<=[\u4e00-\u9fa5]{2,})[的之得地](?=[\u4e00-\u9fa5]{2,})/g, '')
          .trim()
        let analysis = await omniService.analyzeText(normalizedQuery)
        if (!analysis?.embedding_dense && normalizedQuery !== cleanKeyword) {
          analysis = await omniService.analyzeText(cleanKeyword)
        }
        if (!analysis?.embedding_dense && cleanKeyword !== keyword) {
          analysis = await omniService.analyzeText(keyword)
        }
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

      // 1. 解析时序切片格式（如 `${parentFp}:c${chunkIndex}`），提取父文件指纹并向基础条件做交集过滤
      const chunkPattern = /^(.+):c(\d+)$/
      const parsedMatches: Array<{
        rawFp: string
        parentFp: string
        chunkIndex?: number
        score: number
      }> = resp.matches.map(m => {
        const match = m.fileFingerprint.match(chunkPattern)
        if (match) {
          return {
            rawFp: m.fileFingerprint,
            parentFp: match[1],
            chunkIndex: parseInt(match[2], 10),
            score: m.score
          }
        }
        return {
          rawFp: m.fileFingerprint,
          parentFp: m.fileFingerprint,
          score: m.score
        }
      })

      const uniqueParentFps = Array.from(new Set(parsedMatches.map(p => p.parentFp)))
      const allowed = this.filterMembersFromBase(
        uniqueParentFps,
        whereClauses,
        queryParams
      )

      // 2. 按 parentFp 聚合并保留最高相似度得分与优选切片索引
      interface ParentAgg {
        parentFp: string
        bestScore: number
        bestChunkIndex?: number
        bestChunkScore?: number
        chunks: Array<{ chunkIndex: number; score: number }>
      }
      const parentAggMap = new Map<string, ParentAgg>()
      for (const m of parsedMatches) {
        if (!allowed.has(m.parentFp)) continue
        let existing = parentAggMap.get(m.parentFp)
        if (!existing) {
          existing = {
            parentFp: m.parentFp,
            bestScore: m.score,
            chunks: []
          }
          parentAggMap.set(m.parentFp, existing)
        }
        if (m.score > existing.bestScore) {
          existing.bestScore = m.score
        }
        if (m.chunkIndex !== undefined) {
          existing.chunks.push({ chunkIndex: m.chunkIndex, score: m.score })
        }
      }

      if (parentAggMap.size === 0) {
        return []
      }

      // 1. 预先批量查询所有命中切片视频的 file_video_chunks 元数据（获取各切片起止时间）
      const parentsWithAnyChunks = Array.from(parentAggMap.values()).filter(p => p.chunks.length > 0)
      const chunkTimingMap = new Map<string, { startSec: number; endSec: number }>()

      if (parentsWithAnyChunks.length > 0) {
        try {
          const placeholders = parentsWithAnyChunks.map(() => '?').join(',')
          const rows = this.db
            .prepare(
              `SELECT file_fingerprint, chunk_index, start_sec, end_sec
               FROM file_video_chunks
               WHERE file_fingerprint IN (${placeholders})`
            )
            .all(...parentsWithAnyChunks.map(p => p.parentFp)) as Array<{
            file_fingerprint: string
            chunk_index: number
            start_sec: number
            end_sec: number
          }>

          for (const r of rows) {
            chunkTimingMap.set(`${r.file_fingerprint}:c${r.chunk_index}`, {
              startSec: r.start_sec,
              endSec: r.end_sec
            })
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          logger.warn(LogCategory.VIRTUAL_DIRECTORY, '[HybridSearchArbiter] 查询 file_video_chunks 失败: ', msg)
        }
      }

      // 2. 优选每个视频的最佳跳轴切片（严格以向量语义相似度最高分为绝对基准）：
      // 恪守第一性原理与 KISS 原则，严禁主观假定片头片尾是空镜头或人为施加黄金中段加权，
      // 杜绝非目标中段切片（如 01:33）通过位置偏置篡改真实最高匹配度切片（如 1:48 红色跑车）
      for (const agg of parentAggMap.values()) {
        if (agg.chunks.length === 0) continue
        agg.chunks.sort((a, b) => b.score - a.score)
        const topChunk = agg.chunks[0]
        agg.bestChunkIndex = topChunk.chunkIndex
        agg.bestChunkScore = topChunk.score
      }

      // 按最高得分降序重排
      const sortedParents = Array.from(parentAggMap.values()).sort(
        (a, b) => b.bestScore - a.bestScore
      )

      // 3. 组装 VectorMatch 输出
      const out: VectorMatch[] = []
      for (const [idx, p] of sortedParents.entries()) {
        let matchedChunk: VectorMatch['matchedChunk']
        if (p.bestChunkIndex !== undefined) {
          const timing = chunkTimingMap.get(`${p.parentFp}:c${p.bestChunkIndex}`)
          if (timing) {
            matchedChunk = {
              chunkIndex: p.bestChunkIndex,
              startSec: timing.startSec,
              endSec: timing.endSec,
              similarity: p.bestChunkScore ?? p.bestScore
            }
          }
        }
        out.push({
          fileFingerprint: p.parentFp,
          score: p.bestScore,
          rank: idx + 1,
          matchedChunk
        })
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
    const extraWhere = whereClauses.length > 0 ? `AND ${whereClauses.join(' AND ')}` : ''
    const sql = `
      SELECT DISTINCT wf.file_fingerprint AS file_fingerprint
      FROM workspace_files wf
      WHERE wf.file_fingerprint IN (${placeholders})
        ${extraWhere}
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