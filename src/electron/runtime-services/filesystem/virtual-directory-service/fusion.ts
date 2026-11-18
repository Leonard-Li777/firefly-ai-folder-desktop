/**
 * RRF 融合打分（Hybrid Search Fusion）
 * 自 HybridSearchArbiter.ts 按职责拆出：单路 RRF、加权融合、文件名提升分与顺序分页切片。
 * 全部为纯函数，便于单测。
 */

import { HYBRID_SEARCH_RRF_K, HYBRID_SEARCH_WEIGHTS } from './hybrid-search-constants'
import { tokenize, isUsefulToken, isStopwordOrGenericWord, hasValidNameMinLength } from '@firefly/shared'
import { calculateFzfScore } from './pinyin-fzf'

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
  opts: {
    ftsRank?: number
    vecRank?: number
    nameBoost?: number
    exactRank?: number
    vecScore?: number
    vectorDamping?: number
    ftsDamping?: number
    maxScoreCap?: number
    /** 工单 12：CLIP 文本第 5 路的 rank（缺失即该路不参与，完全退化为四路行为） */
    clipRank?: number
    /** 拼音正排索引第 6 路的 rank（缺失即该路不参与，完全退化为五路行为） */
    pinyinRank?: number
  },
  weights: {
    fts: number
    vector: number
    name: number
    exact?: number
    clip?: number
    pinyin?: number
  } = HYBRID_SEARCH_WEIGHTS,
  k: number = HYBRID_SEARCH_RRF_K
): number {
  const wExact = weights.exact ?? HYBRID_SEARCH_WEIGHTS.exact
  // 工单 12：第 5 路权重缺省 0 —— 默认完全退化，只有显式配置才生效
  const wClip = weights.clip ?? 0
  // 拼音第 6 路同样缺省 0：未传 weights.pinyin 时行为与旧版完全一致
  const wPinyin = weights.pinyin ?? 0
  const baseVec = rrfScore(opts.vecRank, k)
  // 当存在有效向量相似度时，按 (1.0 + clamp(vecScore, 0, 1)) 注入多模态语义置信度
  const scoreMultiplier =
    opts.vecScore !== undefined && Number.isFinite(opts.vecScore)
      ? 1.0 + Math.max(0, Math.min(1, opts.vecScore))
      : 1.0
  const vecDamping = Number.isFinite(opts.vectorDamping) ? Math.max(0, opts.vectorDamping!) : 1.0
  const vecContrib = weights.vector * baseVec * scoreMultiplier * vecDamping

  const ftsDamping = Number.isFinite(opts.ftsDamping) ? Math.max(0, opts.ftsDamping!) : 1.0
  const ftsContrib = weights.fts * rrfScore(opts.ftsRank, k) * ftsDamping

  const safeNameBoost = Number.isFinite(opts.nameBoost) ? Math.max(0, opts.nameBoost ?? 0) : 0
  const nameRrf = safeNameBoost / (k + 1)
  const nameContrib = weights.name * nameRrf

  // CLIP 第 5 路：**不注入 clipScore 作为乘子**——AC 明确 clipScore 只用于准入，
  // 一旦进打分就会与 vecScore 的量纲混算（两者是不同嵌入空间的余弦）。
  const clipContrib = wClip * rrfScore(opts.clipRank, k)

  const rawScore =
    ftsContrib +
    vecContrib +
    nameContrib +
    clipContrib +
    wPinyin * rrfScore(opts.pinyinRank, k) +
    wExact * rrfScore(opts.exactRank, k)

  if (opts.maxScoreCap !== undefined && Number.isFinite(opts.maxScoreCap)) {
    return Math.min(rawScore, opts.maxScoreCap)
  }
  return rawScore
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
  const candidates = [name, smartName].filter((s): s is string => !!s && typeof s === 'string')
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
export function slicePage<T>(
  pool: T[],
  limit: number,
  offset: number
): { items: T[]; total: number } {
  const safeLimit = Math.max(0, Number.isFinite(limit) ? Math.floor(limit) : 0)
  const safeOffset = Math.max(0, Number.isFinite(offset) ? Math.floor(offset) : 0)
  return {
    items: pool.slice(safeOffset, safeOffset + safeLimit),
    total: pool.length
  }
}