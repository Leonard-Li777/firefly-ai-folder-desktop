/**
 * 拼音检索查询规划器 (Pinyin Query Planner)
 *
 * 设计文档：docs/specs/pinyin-forward-index-redesign-spec.md §5.1
 * （取代 10-18「PinyinQueryExpander」逆向展开方案——封闭词表已被正排索引取代）
 *
 * 核心职责（查询侧只做分类与匹配，不做任何拼音→中文翻译）：
 * 1. 判定输入是否走拼音路（四重熔断闸，与词库无关的分类逻辑，从 10-18 继承）；
 * 2. 产出拼音匹配 token 集，供 files_pinyin_fts 直接 MATCH：
 *    - len >= 3 → trigram 子串匹配（全拼与首字母缩写通用）；
 *    - len == 2 → 独立双字词精确匹配（索引侧同词 run 存为首尾补空格的独立 token，
 *      故 " cw " 只命中独立成词的「财务」，句子内部缩写仍受 >=3 约束——已裁决边界）；
 *    - len < 2  → 丢弃（ai/db/js 类双字母无意义匹配）；
 * 3. 纯拼音查询（isPinyin）时调用方跳过向量路：拼音串送入中文 CLIP 无语义。
 *
 * 召回后的候选校验与中文词回填由 HybridSearchArbiter.verifyPinyinCandidates 承担
 * （复用 pinyin-text.ts 同一构造器，音节边界对齐硬约束）。
 */

const CJK_CHAR_RE = /[\u4e00-\u9fa5]/

/**
 * 常见高频英文保留词 / 技术术语白名单
 * 命中此名单的纯字母词严格豁免拼音路，保障英文原生检索体验
 */
export const RESERVED_ENGLISH_WORDS = new Set([
  'song',
  'long',
  'fan',
  'pin',
  'bin',
  'men',
  'can',
  'pan',
  'lan',
  'run',
  'die',
  'app',
  'api',
  'doc',
  'git',
  'hub',
  'dev',
  'src',
  'web',
  'log',
  'tag',
  'key',
  'url',
  'uri',
  'sql',
  'css',
  'npm',
  'mac',
  'win',
  'zip',
  'tar',
  'pdf',
  'png',
  'jpg',
  'wav',
  'mp3',
  'mp4',
  'txt',
  'vue',
  'bot',
  'pro',
  'sub',
  'pub',
  'raw',
  'net',
  'com',
  'org',
  'box',
  'top',
  'fit',
  'tab',
  'set',
  'get',
  'put'
])

/** 拼音检索计划（查询分类产物；不含任何中文候选词——中文词由索引侧召回后校验回填） */
export interface PinyinQueryPlan {
  /** 原始用户输入词（已 trim，如 "khxs" / "ke huan xiao shuo"） */
  rawKeyword: string
  /** 是否判定为拼音查询（过四闸）——是则并入 files_pinyin_fts 召回路 */
  isPinyin: boolean
  /** 拼音匹配 token 集（去重；len>=2；含合并紧凑串与各分段） */
  pinyinTokens: string[]
}

/** 非拼音查询的空计划（汉字短路 / 保留词豁免 / 无有效 token 时返回） */
function nativePlan(rawKeyword: string): PinyinQueryPlan {
  return { rawKeyword, isPinyin: false, pinyinTokens: [] }
}

export class PinyinQueryPlanner {
  private static instance: PinyinQueryPlanner | null = null

  private constructor() {
    // 无内存词库：正排索引取代封闭词表，规划器是无状态纯函数容器
  }

  public static getInstance(): PinyinQueryPlanner {
    if (!PinyinQueryPlanner.instance) {
      PinyinQueryPlanner.instance = new PinyinQueryPlanner()
    }
    return PinyinQueryPlanner.instance
  }

  /**
   * 对检索词执行查询分类与拼音 token 生成（四重熔断闸）：
   * - 闸 1：含汉字 → 即时短路，100% 原生中文检索；
   * - 闸 2：清洗后命中 RESERVED_ENGLISH_WORDS → 豁免，保持英文原生检索；
   * - 闸 3：token 长度门禁——>=3 子串匹配 / ==2 独立词精确匹配 / <2 丢弃；
   * - 闸 4：多词空白 → token 集 = {合并紧凑串} ∪ {各分段}（兼容「ke huan xiao shuo」键入习惯）。
   */
  public plan(rawQuery: string): PinyinQueryPlan {
    const rawKeyword = (rawQuery || '').trim()
    if (!rawKeyword) return nativePlan('')

    // 熔断闸 1：若包含汉字，即时短路退出，100% 保持原生中文检索
    if (CJK_CHAR_RE.test(rawKeyword)) {
      return nativePlan(rawKeyword)
    }

    // 清洗空白与特殊分隔符，生成紧凑小写字母串
    const compactAlpha = rawKeyword.toLowerCase().replace(/[^a-z]/g, '')
    if (!compactAlpha) return nativePlan(rawKeyword)

    // 熔断闸 2：英文保留词/科技词白名单豁免
    if (RESERVED_ENGLISH_WORDS.has(compactAlpha)) {
      return nativePlan(rawKeyword)
    }

    // 熔断闸 4：多词空白自适应——合并紧凑串 + 各分段（OR 语义）
    const segments = rawKeyword
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter(Boolean)
    const tokenSet = new Set<string>([compactAlpha, ...segments])

    // 熔断闸 3：长度门禁（2 字符仅独立词精确匹配，由索引侧首尾补空格约定支撑）
    const pinyinTokens = Array.from(tokenSet).filter(t => t.length >= 2)
    if (pinyinTokens.length === 0) {
      return nativePlan(rawKeyword)
    }

    return { rawKeyword, isPinyin: true, pinyinTokens }
  }
}
