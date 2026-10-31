import { concept, getCanonicalConceptName, isControlledConcept } from '@firefly/shared'

/**
 * 低区分度泛化通用标签的权威受控概念代码列表（单一事实源，编译期类型约束）：
 * 这些标签大多数文件默认都有（尺度分级、处理/归档状态、公开密级、水印/打码等物理状态），
 * 严格依据 PRD-0058 受控概念规范，使用 concept('中文') 获取权威受控代码，
 * 严禁裸敲 builtin 伪代码或私造局部字典。
 * 在搜索结果列表中默认不显示，避免挤占宝贵的有限排版空间；
 * 仅当用户主动在搜索框中键入对应关键词时，才破例放行至关键词匹配第一梯队。
 */
export const PERVASIVE_CONCEPT_CODES: ReadonlyArray<string> = [
  concept('全年龄'),
  concept('已归档'),
  concept('未归档'),
  concept('公开'),
  concept('无水印'),
  concept('无码')
]

/**
 * 低区分度泛化通用标签集合：
 * 100% 基于 PERVASIVE_CONCEPT_CODES 由单一事实源字典 getCanonicalConceptName 动态派生，
 * 严禁业务层直接裸写手敲 builtin 代码字符串字面量、自然语言中文字符串或自建多语言并列数组。
 */
export const PERVASIVE_GENERIC_TAGS: ReadonlySet<string> = new Set(
  PERVASIVE_CONCEPT_CODES.flatMap(code => {
    const canonicalName = getCanonicalConceptName(code)
    return [
      code.toLowerCase(),
      ...(canonicalName ? [canonicalName.toLowerCase()] : [])
    ]
  })
)

export interface OrganizedTagItem {
  name: string
  tier: 'keyword' | 'fused' | 'other'
  isKeywordMatch: boolean
  isFused: boolean
}

/**
 * 判断标签是否为全系统大多数文件共有的低区分度泛化标签
 */
export function isPervasiveTag(tag: string): boolean {
  if (!tag) return false
  const trimmed = tag.trim()
  const lower = trimmed.toLowerCase()
  if (PERVASIVE_GENERIC_TAGS.has(lower)) {
    return true
  }
  if (isControlledConcept(trimmed)) {
    const code = concept(trimmed)
    if (PERVASIVE_GENERIC_TAGS.has(code.toLowerCase())) {
      return true
    }
  }
  return false
}

/**
 * 字符串转 32 位正整数哈希（作为伪随机数发生器种子）
 */
function stringToSeed(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

/**
 * 确定性线性同余伪随机打乱算法 (Deterministic LCG Fisher-Yates Shuffle)：
 * - 不同文件（种子不同）呈现各不相同的随机排列；
 * - 同一文件（种子相同）在虚拟滚动列表回收复用重绘时，排列顺序绝对恒定，避免视觉重绘抖动。
 */
export function deterministicShuffle<T>(array: T[], seedStr: string): T[] {
  if (array.length <= 1) return [...array]
  const result = [...array]
  let seed = stringToSeed(seedStr) || 123456789
  for (let i = result.length - 1; i > 0; i--) {
    seed = (seed * 9301 + 49297) % 233280
    const j = Math.floor((seed / 233280) * (i + 1))
    const temp = result[i]
    result[i] = result[j]
    result[j] = temp
  }
  return result
}

/**
 * 判断单个标签是否与当前活跃搜索关键词/分词匹配
 */
export function isTagMatchingTokens(tag: string, tokens: string[]): boolean {
  if (!tag || !tokens || tokens.length === 0) return false
  const normTag = tag.trim().toLowerCase()
  if (!normTag) return false

  return tokens.some(tok => {
    const normTok = tok.trim().toLowerCase()
    if (!normTok) return false
    // 1. 完全等值匹配
    if (normTag === normTok) return true
    // 2. 标签包含搜索分词
    if (normTag.includes(normTok)) return true
    // 3. 搜索分词包含标签（如搜索 "日落风景照片" 包含标签 "风景"）
    if (normTok.length >= 2 && normTok.includes(normTag)) return true
    return false
  })
}

/**
 * 关键词匹配度评分（用于关键词匹配梯队内部排序：精确匹配 > 前缀匹配 > 包含匹配）
 */
function getMatchRelevanceScore(tag: string, tokens: string[]): number {
  const normTag = tag.trim().toLowerCase()
  let bestScore = 0
  for (const tok of tokens) {
    const normTok = tok.trim().toLowerCase()
    if (!normTok) continue
    if (normTag === normTok) {
      bestScore = Math.max(bestScore, 100)
    } else if (normTag.startsWith(normTok)) {
      bestScore = Math.max(bestScore, 70)
    } else if (normTag.includes(normTok)) {
      bestScore = Math.max(bestScore, 50)
    } else if (normTok.includes(normTag)) {
      bestScore = Math.max(bestScore, 30)
    }
  }
  return bestScore
}

export interface OrganizeSearchTagsOptions {
  tags?: string[]
  fusedTags?: string[]
  searchTokens?: string[]
  searchKeyword?: string
  seed?: string
}

/**
 * 搜索列表卡片 Row 2 标签序列三级梯队编排与泛化过滤算法：
 * 1. 过滤：剔除“全年龄”、“已归档”等低区分度泛化标签（除非用户主动搜索该词）；
 * 2. 第一梯队：关键词匹配标签（排在最前面，并按匹配度降序）；
 * 3. 第二梯队：多模态融合标签（fused_tags）；
 * 4. 第三梯队：其它标签（基于文件 seed 确定性随机打散）。
 */
export function getOrganizedSearchTags({
  tags,
  fusedTags,
  searchTokens = [],
  searchKeyword = '',
  seed = ''
}: OrganizeSearchTagsOptions): OrganizedTagItem[] {
  const candidateTags = tags && tags.length > 0 ? tags : (fusedTags || [])
  if (candidateTags.length === 0) return []

  // 1. 整理全部有效搜索 Token（包含显式 tokens 与 searchKeyword 拆分词）
  const tokenSet = new Set<string>()
  for (const tok of searchTokens) {
    if (tok && tok.trim()) tokenSet.add(tok.trim().toLowerCase())
  }
  if (searchKeyword && searchKeyword.trim()) {
    const kw = searchKeyword.trim().toLowerCase()
    tokenSet.add(kw)
    for (const part of kw.split(/[\s,，;；|]+/)) {
      if (part.trim()) tokenSet.add(part.trim())
    }
  }
  const activeTokens = Array.from(tokenSet)

  // 2. 预备融合标签集合（大小写与空白归一化）
  const fusedTagSet = new Set<string>((fusedTags || []).map(t => (t ? t.trim().toLowerCase() : '')).filter(Boolean))

  // 3. 标签候选过滤（泛化黑名单过滤，但若命中当前搜索词则豁免放行）
  const admittedTags: string[] = []
  const admittedSet = new Set<string>()

  for (const rawTag of candidateTags) {
    if (!rawTag) continue
    const cleanTag = rawTag.trim()
    if (!cleanTag) continue
    const norm = cleanTag.toLowerCase()
    if (admittedSet.has(norm)) continue // 同名标签去重

    const isMatch = isTagMatchingTokens(cleanTag, activeTokens)
    const isPervasive = isPervasiveTag(cleanTag)

    // 若为大多数文件都有的泛化标签，且未被当前搜索词命中，则严格过滤不显示
    if (isPervasive && !isMatch) {
      continue
    }

    admittedSet.add(norm)
    admittedTags.push(cleanTag)
  }

  if (admittedTags.length === 0) return []

  // 4. 三级梯队归类拆分
  const tier1Keyword: Array<{ tag: string; score: number }> = []
  const tier2Fused: string[] = []
  const tier3Other: string[] = []

  for (const tag of admittedTags) {
    const norm = tag.toLowerCase()
    const isMatch = isTagMatchingTokens(tag, activeTokens)
    if (isMatch) {
      const score = getMatchRelevanceScore(tag, activeTokens)
      tier1Keyword.push({ tag, score })
      continue
    }

    const isFused = fusedTagSet.has(norm)
    if (isFused) {
      tier2Fused.push(tag)
      continue
    }

    tier3Other.push(tag)
  }

  // 5. 梯队内排序
  // 第一梯队：按关键词相关度从高到低排序
  tier1Keyword.sort((a, b) => b.score - a.score)

  // 第三梯队：确定性伪随机打散
  const shuffledTier3 = deterministicShuffle(tier3Other, seed || admittedTags.join('|'))

  // 6. 构造最终结构化条目
  const result: OrganizedTagItem[] = []

  for (const item of tier1Keyword) {
    result.push({
      name: item.tag,
      tier: 'keyword',
      isKeywordMatch: true,
      isFused: fusedTagSet.has(item.tag.toLowerCase())
    })
  }

  for (const tag of tier2Fused) {
    result.push({
      name: tag,
      tier: 'fused',
      isKeywordMatch: false,
      isFused: true
    })
  }

  for (const tag of shuffledTier3) {
    result.push({
      name: tag,
      tier: 'other',
      isKeywordMatch: false,
      isFused: false
    })
  }

  return result
}
