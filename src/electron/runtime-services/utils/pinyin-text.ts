/**
 * 拼音串构造器（Pinyin Text Builder）
 *
 * 设计文档：docs/specs/pinyin-forward-index-redesign-spec.md §4.2 / §5.3
 *
 * 核心职责（索引侧写入与查询侧校验回填共用同一实现，保证两端拼音严格同源）：
 * 1. CJK 连续段切分：拼音天然以「字/音节」为单位，非 CJK 段（英文/数字/符号）不入拼音列；
 * 2. 多音字全变体：按字单调取全部读音（pinyin-pro 单字 + multiple:true），交叉乘积封顶 16 防组合爆炸；
 * 3. 每变体产两个 token：全拼串（音节拼接）+ 首字母串（每音节首字母拼接）；
 * 4. 字段级拼音串：全部 token 小写去重、空格连接、**首尾各补一个空格**（trigram 对文本末尾
 *    token 无尾随空格，不补则 " token " 式精确匹配漏掉末位 token，实测结论）；
 * 5. 校验回填：音节边界对齐的精确/前缀匹配才判定命中——跨音节截断（如 anxiao 对
 *    kehuanxiaoshuo）一律判假阳性，从机制上杜绝 <mark>幻小</mark> 式错误高亮。
 */

import { pinyin } from 'pinyin-pro'
import { createHash } from 'crypto'

/** CJK 连续段（与受控概念/渲染规范同款边界：基本区 \u4e00-\u9fa5） */
const CJK_RUN_RE = /[\u4e00-\u9fa5]+/g

/** 多音字变体交叉乘积上限：防长段组合爆炸（如 20 字长名） */
export const MAX_PINYIN_VARIANTS = 16

/** buildRunVariants LRU 缓存容量上限（条） */
export const RUN_VARIANTS_CACHE_MAX = 512

/** 超过该长度的 CJK 段不进入缓存（防单条超大键占用内存） */
const RUN_VARIANTS_CACHE_MAX_RUN_LEN = 200

/**
 * buildRunVariants 有界 LRU 缓存（Map 保持插入序，最旧键在首位）。
 * 仅缓存「纯查表」结果，无失效逻辑——pinyin-pro 词表为进程内常量。
 */
const runVariantsCache = new Map<string, RunVariant[]>()

/** 单个 CJK 段的一种读音变体 */
export interface RunVariant {
  /** 逐字音节数组（多音字变体下的读音序列） */
  syllables: string[]
  /** 全拼串（音节拼接，如 kehuanxiaoshuo） */
  full: string
  /** 首字母串（每音节首字母拼接，如 khxs） */
  initials: string
}

/** 校验回填命中类型（优先级：full > full-slice > initials） */
export type PinyinMatchType = 'full' | 'full-slice' | 'initials'

/** 单个 CJK 段的命中结果 */
export interface RunMatchResult {
  /** 命中类型 */
  type: PinyinMatchType
  /** 命中中文片段在 run 中的字符区间 [start, end)（音节与字 1:1，直接切片） */
  start: number
  end: number
}

/** 校验回填命中结果 */
export interface TextPinyinHit {
  /** 命中的精确中文片段（<mark> 高亮与 matchedPinyinCandidate 回填目标） */
  matchedText: string
  /** 命中类型 */
  type: PinyinMatchType
}

/** 拼音索引行载荷（file-dao 写入 files_pinyin_fts 用） */
export interface PinyinIndexRow {
  namePy: string
  smartNamePy: string
  descriptionPy: string
  tagsPy: string
  /** sha256(name|smartName|description|tags)，reconciler 陈旧检测用 */
  srcHash: string
}

const MATCH_TYPE_RANK: Record<PinyinMatchType, number> = {
  full: 3,
  'full-slice': 2,
  initials: 1
}

/**
 * 切出文本中的全部 CJK 连续段
 * 示例：「[文档]启示路_科幻小说.epub」→ ['文档', '启示路', '科幻小说']
 */
export function extractCjkRuns(text: string): string[] {
  if (!text || typeof text !== 'string') return []
  return text.match(CJK_RUN_RE) ?? []
}

/**
 * 取单字全部读音（无声调）。
 * 注意：pinyin-pro 的 type:'array' + multiple:true 仅对**单字**生效（多字串只给主读音），
 * 故必须按字单调（2026-10-24 API 实测结论）。
 */
function charPinyins(ch: string): string[] {
  try {
    const arr = pinyin(ch, { toneType: 'none', type: 'array', multiple: true }) as string[]
    if (Array.isArray(arr)) {
      const cleaned = arr.filter(v => typeof v === 'string' && v.length > 0)
      if (cleaned.length > 0) return cleaned
    }
  } catch {
    // 单字取音失败走降级：返回空让调用方跳过该变体
  }
  return []
}

/**
 * 构建单个 CJK 段的读音变体（多音字全组合，封顶 MAX_PINYIN_VARIANTS）。
 * 超限时保留前 cap 种组合（主读音优先——交叉乘积按首字读音顺序展开）。
 *
 * **有界 LRU 缓存（人工裁定项④）**：pinyin-pro 按字取音是纯查表，同一 CJK 段会在
 * 校验回填（Top-30 候选 × 多字段 × 多轮检索）与索引写入中被反复计算。缓存以
 * `cap\u0000run` 为键（cap 必须入键，否则不同 cap 的结果会互相污染），
 * 容量 RUN_VARIANTS_CACHE_MAX，超出淘汰最久未用；超长段不缓存（防单条超大键占内存）。
 * **返回值为共享只读对象，调用方不得修改**（现有全部调用点均只读）。
 */
export function buildRunVariants(run: string, cap: number = MAX_PINYIN_VARIANTS): RunVariant[] {
  if (!run) return []
  const cacheable = run.length <= RUN_VARIANTS_CACHE_MAX_RUN_LEN
  const key = cacheable ? `${cap}\u0000${run}` : ''
  if (cacheable) {
    const hit = runVariantsCache.get(key)
    if (hit) {
      // LRU 刷新：删除后重插即移到最新端
      runVariantsCache.delete(key)
      runVariantsCache.set(key, hit)
      return hit
    }
  }

  const chars = Array.from(run)
  const perChar: string[][] = []
  for (const ch of chars) {
    const pys = charPinyins(ch)
    // 非中文字符（理论上不会出现，CJK 段已过滤）降级跳过
    if (pys.length === 0) return []
    perChar.push(pys)
  }

  const variants: RunVariant[] = []
  const walk = (idx: number, acc: string[]): void => {
    if (variants.length >= cap) return
    if (idx === perChar.length) {
      const syllables = acc
      variants.push({
        syllables,
        full: syllables.join(''),
        initials: syllables.map(s => s[0] ?? '').join('')
      })
      return
    }
    for (const py of perChar[idx]) {
      walk(idx + 1, [...acc, py])
      if (variants.length >= cap) return
    }
  }
  walk(0, [])

  if (cacheable) {
    runVariantsCache.set(key, variants)
    if (runVariantsCache.size > RUN_VARIANTS_CACHE_MAX) {
      const oldest = runVariantsCache.keys().next().value
      if (oldest !== undefined) runVariantsCache.delete(oldest)
    }
  }
  return variants
}

/**
 * 构建字段级拼音串：全部 CJK 段的全部变体 token，小写去重、空格连接、首尾补空格。
 * 无中文时返回空串（调用方应跳过该列写入空值而非写入空格）。
 */
export function buildFieldPinyinText(text: string): string {
  const runs = extractCjkRuns(text)
  if (runs.length === 0) return ''
  const tokens = new Set<string>()
  for (const run of runs) {
    for (const v of buildRunVariants(run)) {
      if (v.full) tokens.add(v.full)
      if (v.initials) tokens.add(v.initials)
    }
  }
  if (tokens.size === 0) return ''
  // 首尾补空格：trigram 末尾 token 无尾随空格，" token " 精确匹配会漏（实测结论）
  return ` ${Array.from(tokens).join(' ')} `
}

/**
 * 校验单个 CJK 段是否命中查询 token，返回命中类型与精确字符区间。
 *
 * 音节边界对齐硬约束（二轮 review 采纳）——匹配的**起点与终点都必须落在完整音节边界**上：
 * - full：某变体全拼串与 token 完全相等（整段命中，最强）；
 * - full-slice：token 等于某变体**音节对齐的连续切片**（含前缀与中段）——
 *   如 `kehuanxiaoshuo` 对「科幻小说史」（前缀）或对「首部科幻小说」（中段，散文场景）；
 * - initials：token 等于某变体首字母串或其切片（缩写级，最弱）；
 * - 跨音节截断一律返回 null：如 `anxiao`/`huanxiao` 对 `kehuanxiaoshuo`（起点落在
 *   `huan` 音节中间）、`xiaoshuosh` 对「科幻小说史」（终点不在边界）。
 *
 * 注意：2 字符缩写（如段内 `cw`）在**查询分类层**已被闸 3（缩写 ≥3）拦截，到不了本函数；
 * 本函数只负责音节对齐判定，不承担长度门禁。
 */
export function matchRun(run: string, token: string): RunMatchResult | null {
  if (!run || !token) return null
  const t = token.toLowerCase()
  const variants = buildRunVariants(run)
  let best: RunMatchResult | null = null

  const consider = (r: RunMatchResult): void => {
    if (!best || MATCH_TYPE_RANK[r.type] > MATCH_TYPE_RANK[best.type]) best = r
  }

  for (const v of variants) {
    // 1. 整段全拼精确（最高级，直接返回）
    if (v.full === t) return { type: 'full', start: 0, end: run.length }

    // 2. 全拼音节对齐切片（含前缀/中段）：变体按字构建，音节下标即字符下标
    const n = v.syllables.length
    for (let i = 0; i < n; i++) {
      let acc = ''
      for (let j = i; j < n; j++) {
        acc += v.syllables[j]
        if (acc === t) {
          consider({ type: 'full-slice', start: i, end: j + 1 })
          break
        }
        if (acc.length > t.length) break // 已超长，本起点不可能再命中
      }
    }

    // 3. 首字母切片（每个首字母对应一个字，任意子串均天然对齐）
    //    切片长度必须等于 token 长度才可能相等 ⇒ 每个起点只需一次定长切片比较（O(m)）；
    //    原内层循环对每个起点枚举全部长度属冗余（R1 盲审 A-M1：400 字段实测 22-33ms/次）
    const m = v.initials.length
    for (let i = 0; i + t.length <= m; i++) {
      if (v.initials.slice(i, i + t.length) === t) {
        consider({ type: 'initials', start: i, end: i + t.length })
        break
      }
    }
  }
  return best
}

/**
 * 校验一段文本（单个字段）是否命中查询 token，返回最优命中（full > full-slice > initials）
 * 及精确中文片段（供 <mark> 高亮与 matchedPinyinCandidate 回填）。
 */
export function verifyTextPinyin(text: string, token: string): TextPinyinHit | null {
  if (!text || !token) return null
  const runs = extractCjkRuns(text)
  let best: (RunMatchResult & { run: string }) | null = null
  for (const run of runs) {
    const m = matchRun(run, token)
    if (m && (!best || MATCH_TYPE_RANK[m.type] > MATCH_TYPE_RANK[best.type])) {
      best = { ...m, run }
      if (m.type === 'full') break
    }
  }
  if (!best) return null
  return { matchedText: best.run.slice(best.start, best.end), type: best.type }
}

/**
 * 计算拼音索引陈旧检测哈希：sha256(name|smartName|description|tags)。
 * 字段间用 NUL 分隔防跨字段拼接碰撞（与 Supabase 同步 sanitize 的 NUL 规避无关，此处仅作分隔哨兵）。
 */
export function computePinyinSrcHash(parts: {
  name?: string
  smartName?: string
  description?: string
  tags?: string
}): string {
  const src = [parts.name ?? '', parts.smartName ?? '', parts.description ?? '', parts.tags ?? ''].join(
    '\u0000'
  )
  return createHash('sha256').update(src, 'utf8').digest('hex')
}

/**
 * 构建一行拼音索引载荷（file-dao 同事务写入 files_pinyin_fts 用）。
 * 四列均无中文时返回 null（调用方跳过写入，避免写入全空行）。
 */
export function buildPinyinIndexRow(input: {
  name: string
  smartName: string
  description: string
  tags: string
}): PinyinIndexRow | null {
  const namePy = buildFieldPinyinText(input.name)
  const smartNamePy = buildFieldPinyinText(input.smartName)
  const descriptionPy = buildFieldPinyinText(input.description)
  const tagsPy = buildFieldPinyinText(input.tags)
  if (!namePy && !smartNamePy && !descriptionPy && !tagsPy) return null
  return {
    namePy,
    smartNamePy,
    descriptionPy,
    tagsPy,
    srcHash: computePinyinSrcHash(input)
  }
}
