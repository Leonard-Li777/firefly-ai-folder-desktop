/**
 * 拼音逆向展开引擎 (Pinyin Query Expander)
 *
 * 核心目标与第一性原理：
 * 1. 解决「搜索拼音缩写 (如 khxs) 或全拼 (如 kehuanxiaoshuo) 无法召回正文/标签包含中文的文件」的痛点；
 * 2. 零私造独立大词典：严格复用 @firefly/shared 受控概念、内置高频分类与工作区动态标签；
 * 3. 四重安全熔断闸：
 *    - 汉字即时短路（含 CJK 字符立即返回原词）；
 *    - 英文高频保留词豁免（song, long, fan, bin, run 等 100% 保持英文原生检索）；
 *    - 首字母缩写长度门禁 (len >= 3，严禁 ai, db, js, ts, md 等双字母缩写误展开)；
 *    - 多词空白自适应合并。
 * 4. 极致轻量：内存常驻增量 <= 1.5MB，单次探测延时 < 0.05ms。
 */

import { pinyin } from 'pinyin-pro'
import { CONTROLLED_CONCEPTS, logger, LogCategory } from '@firefly/shared'

const CJK_CHAR_RE = /[\u4e00-\u9fa5]/

/**
 * 常见高频英文保留词 / 技术术语白名单
 * 命中此名单的纯字母词严格豁免拼音逆向展开，保障英文原生检索体验
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

/** 检索词状态展开契约 */
export interface ExpandedSearchQuery {
  /** 原始用户输入词 (如 "khxs") */
  rawKeyword: string
  /** 是否触发了拼音逆向展开 */
  isExpanded: boolean
  /** 逆向展开得到的高置信度中文候选词列表 (最多 2 个) */
  chineseCandidates: string[]
  /** 供 Omni 向量模型提取 embedding 的核心语义文本 (有展开词时使用首选中文词，保障语义向量有效性) */
  semanticTextForVector: string
  /** 供 LIKE 字段覆盖补充源使用的统一模式列表 (包含原词与展开词) */
  likePatterns: string[]
}

/** 词条候选元数据 */
interface LexiconEntry {
  word: string
  priority: number // 优先级：工作区动态实体 (3) > 受控概念基线 (1)
}

export class PinyinQueryExpander {
  private static instance: PinyinQueryExpander | null = null

  // 全拼映射表：'kehuanxiaoshuo' -> LexiconEntry[]
  private fullPinyinMap = new Map<string, LexiconEntry[]>()
  // 首字母缩写映射表：'khxs' -> LexiconEntry[]
  private initialsMap = new Map<string, LexiconEntry[]>()

  // 记录每个词已注册的最高优先级
  private wordPriorityMap = new Map<string, number>()

  private constructor() {
    this.initBaseLexicon()
  }

  public static getInstance(): PinyinQueryExpander {
    if (!PinyinQueryExpander.instance) {
      PinyinQueryExpander.instance = new PinyinQueryExpander()
    }
    return PinyinQueryExpander.instance
  }

  /**
   * 初始化基础静态词库（严格从受控概念基线 SSOT 构建）
   */
  private initBaseLexicon(): void {
    if (typeof CONTROLLED_CONCEPTS === 'object' && CONTROLLED_CONCEPTS !== null) {
      for (const conceptName of Object.keys(CONTROLLED_CONCEPTS)) {
        this.addWord(conceptName, 1)
      }
    }
  }

  /**
   * 注册工作区动态实体（如用户创建的标签名、分类物化路径段）
   * 工作区实体享有最高置信度优先级 (3)
   */
  public registerWorkspaceEntities(names: string[]): void {
    if (!Array.isArray(names) || names.length === 0) return
    for (const raw of names) {
      if (!raw || typeof raw !== 'string') continue
      const cleaned = raw.trim()
      // 过滤纯标点、路径斜杠与过长文本
      if (cleaned.length < 2 || cleaned.length > 20) continue
      // 仅对含中文的实体提取拼音
      if (CJK_CHAR_RE.test(cleaned)) {
        this.addWord(cleaned, 3)
      }
    }
  }

  /**
   * 向倒排索引安全注入单个词（支持优先级平滑升级）
   */
  private addWord(word: string, priority: number): void {
    if (!word || !CJK_CHAR_RE.test(word)) return

    const currentPriority = this.wordPriorityMap.get(word)
    if (currentPriority !== undefined && priority <= currentPriority) {
      return
    }

    try {
      const parts = pinyin(word, { toneType: 'none', type: 'array' })
      if (!Array.isArray(parts) || parts.length === 0) return

      const fullPinyin = parts.join('').toLowerCase().trim()
      const initials = parts.map(p => p[0] || '').join('').toLowerCase().trim()

      this.wordPriorityMap.set(word, priority)
      const entry: LexiconEntry = { word, priority }

      // 1. 注册全拼
      if (fullPinyin) {
        let existing = this.fullPinyinMap.get(fullPinyin)
        if (!existing) {
          existing = []
          this.fullPinyinMap.set(fullPinyin, existing)
        }
        const idx = existing.findIndex(e => e.word === word)
        if (idx >= 0) {
          existing[idx].priority = priority
        } else {
          existing.push(entry)
        }
        existing.sort((a, b) => b.priority - a.priority)
      }

      // 2. 注册首字母缩写
      if (initials) {
        let existingInitials = this.initialsMap.get(initials)
        if (!existingInitials) {
          existingInitials = []
          this.initialsMap.set(initials, existingInitials)
        }
        const idx = existingInitials.findIndex(e => e.word === word)
        if (idx >= 0) {
          existingInitials[idx].priority = priority
        } else {
          existingInitials.push(entry)
        }
        existingInitials.sort((a, b) => b.priority - a.priority)
      }
    } catch (err: unknown) {
      logger.warn(LogCategory.VIRTUAL_DIRECTORY, '[PinyinQueryExpander] 提取拼音失败:', err)
    }
  }

  /**
   * 对检索词执行拼音逆向展开与四重安全熔断检查
   */
  public expand(rawQuery: string): ExpandedSearchQuery {
    const rawKeyword = (rawQuery || '').trim()
    const fallbackResponse: ExpandedSearchQuery = {
      rawKeyword,
      isExpanded: false,
      chineseCandidates: [],
      semanticTextForVector: rawKeyword,
      likePatterns: rawKeyword ? [`%${rawKeyword}%`] : []
    }

    if (!rawKeyword) return fallbackResponse

    // 熔断闸 1：若包含汉字，即时短路退出，100% 保持原生中文检索
    if (CJK_CHAR_RE.test(rawKeyword)) {
      return fallbackResponse
    }

    // 清洗空白与特殊分隔符，生成紧凑小写字母串
    const compactAlpha = rawKeyword.toLowerCase().replace(/[^a-z]/g, '')
    if (!compactAlpha) return fallbackResponse

    // 熔断闸 2：英文保留词/科技词白名单豁免
    if (RESERVED_ENGLISH_WORDS.has(compactAlpha)) {
      return fallbackResponse
    }

    const candidateSet = new Set<string>()

    // 1. 优先探测全拼映射 (无字符长度下限，如 caiwu -> 财务)
    const fullMatches = this.fullPinyinMap.get(compactAlpha)
    if (fullMatches && fullMatches.length > 0) {
      for (const entry of fullMatches) {
        candidateSet.add(entry.word)
        if (candidateSet.size >= 2) break
      }
    }

    // 2. 若全拼未命中，探测首字母缩写
    // 熔断闸 3：缩写必须满足 len >= 3 字符门禁，严格拦截 ai/db/js/ts/md 等双字母缩写
    if (candidateSet.size === 0 && compactAlpha.length >= 3) {
      const initialMatches = this.initialsMap.get(compactAlpha)
      if (initialMatches && initialMatches.length > 0) {
        for (const entry of initialMatches) {
          candidateSet.add(entry.word)
          if (candidateSet.size >= 2) break
        }
      }
    }

    const chineseCandidates = Array.from(candidateSet)
    if (chineseCandidates.length === 0) {
      return fallbackResponse
    }

    const primaryChinese = chineseCandidates[0]
    const likePatterns = Array.from(
      new Set([rawKeyword, ...chineseCandidates].map(w => `%${w}%`))
    )

    return {
      rawKeyword,
      isExpanded: true,
      chineseCandidates,
      // 当存在有效展开词时，用首选中文词替代无意义字母作为向量输入
      semanticTextForVector: primaryChinese,
      likePatterns
    }
  }
}
