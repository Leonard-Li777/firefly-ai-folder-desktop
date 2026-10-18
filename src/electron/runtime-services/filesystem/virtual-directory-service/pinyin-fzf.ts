/**
 * 拼音提取与 fzf 动态规划模糊匹配模块 (Pinyin & fzf Dynamic Matching)
 *
 * 核心设计原则：
 * 1. 零外部大型 C++ 运行时依赖：基于 V8/Node.js 内置 Intl zh-CN-u-co-pinyin 拼音排序提取拼音首字母；
 * 2. 内存常驻趋零：内置 charCache 缓存常见中文字符映射，常驻内存 < 50KB；
 * 3. 边界优先与跳跃缩写加权：支持 BonusBoundary（词首、分隔符、驼峰）与 BonusConsecutive（连续匹配）。
 */

import { match } from 'pinyin-pro'

// GB2312 常用一级汉字拼音首字母边界字符
const BOUNDARIES = '啊芭擦搭蛾发噶哈击喀垃妈拿哦啪期然撒塌挖昔压匝'.split('')
const LETTERS = 'abcdefghjklmnopqrstwxyz'.split('')

// 单字符拼音首字母轻量缓存，防止重复比较
const charCache = new Map<string, string>()

/**
 * 提取单个字符的拼音首字母（ASCII 字符保持小写，汉字提取首字母）
 */
export function getPinyinInitial(char: string): string {
  if (!char) return ''
  if (!/[\u4e00-\u9fa5]/.test(char)) return char.toLowerCase()
  const cached = charCache.get(char)
  if (cached !== undefined) return cached

  for (let i = BOUNDARIES.length - 1; i >= 0; i--) {
    if (char.localeCompare(BOUNDARIES[i], 'zh-CN-u-co-pinyin') >= 0) {
      charCache.set(char, LETTERS[i])
      return LETTERS[i]
    }
  }
  const fallback = char.toLowerCase()
  charCache.set(char, fallback)
  return fallback
}

/**
 * 提取字符串全串的拼音首字母序列
 */
export function getPinyinInitials(str: string): string {
  if (!str) return ''
  return Array.from(str).map(getPinyinInitial).join('')
}

const BOUNDARY_DELIM_RE = /[\s_\-\.\/\\\(（\[【{<:：,]/
const LOWER_ALPHA_NUM_RE = /[a-z0-9]/
const UPPER_ALPHA_RE = /[A-Z]/
const CJK_CHAR_RE = /[\u4e00-\u9fa5]/
const ALPHA_NUM_RE = /[a-zA-Z0-9]/

/**
 * 判定目标字符串第 index 个位置是否处于词首/边界
 */
export function isWordBoundary(str: string, index: number): boolean {
  if (index === 0) return true
  const prev = str[index - 1]
  const curr = str[index]

  // 常见分隔符、空白、标点后紧邻位置
  if (BOUNDARY_DELIM_RE.test(prev)) return true
  // 驼峰命名转换边界 (如 VisualStudio 中的 S，或 word2Doc 中的 D)
  if (LOWER_ALPHA_NUM_RE.test(prev) && UPPER_ALPHA_RE.test(curr)) return true
  // 中文字符自身作为语义单元，每个汉字均视作独立边界
  if (CJK_CHAR_RE.test(curr)) return true

  return false
}

/**
 * 提取目标文本的所有词首字符（包含拉丁单词首字母及汉字拼音首字母）
 */
export function getWordInitials(str: string): { initials: string; indices: number[] } {
  const initials: string[] = []
  const indices: number[] = []
  for (let i = 0; i < str.length; i++) {
    if (isWordBoundary(str, i)) {
      const char = str[i]
      if (ALPHA_NUM_RE.test(char)) {
        initials.push(char.toLowerCase())
        indices.push(i)
      } else if (CJK_CHAR_RE.test(char)) {
        initials.push(getPinyinInitial(char))
        indices.push(i)
      }
    }
  }
  return { initials: initials.join(''), indices }
}

/**
 * 计算轻量 fzf 启发式边界与拼音全拼/首字母评分（Pinyin Full Spelling & Subsequence Heuristic Scoring）
 *
 * 得分区间：
 * - 1.0: 全串完全子串包含或紧凑包含
 * - 0.96: 汉字全拼音节或前缀连续匹配 (如 "caiwu" / "caiwubaobiao" 匹配 "财务报表.xlsx")
 * - 0.95: 汉字拼音首字母紧凑包含 (如 "cwbb" 匹配 "财务报表.xlsx")
 * - 0.92: 词首字母直接包含 (如 "vsc" 匹配 "Visual Studio Code.exe")
 * - 0.88: 词首字母序列子序列匹配 (跳跃缩写全中边界)
 * - 0.15 ~ 0.85: 普通子序列模糊匹配（按紧凑度、边界命中比与连续匹配加分）
 * - 0: 未匹配
 */
export function calculateFzfScore(pattern: string, target: string): number {
  const p = (pattern || '').trim().toLowerCase()
  if (!p) return 0
  const rawTarget = (target || '').trim()
  if (!rawTarget) return 0
  const t = rawTarget.toLowerCase()

  // 1. 全串完全包含 (最高等级)
  if (t.includes(p)) return 1.0

  // 紧凑匹配（去除空格，如 "英语 学习" -> "英语学习.pdf"）
  const compactP = p.replace(/\s+/g, '')
  if (compactP.length >= 2 && t.includes(compactP)) return 1.0

  // 2. 汉字全拼音节与拼音首字母匹配 (基于 pinyin-pro match 引擎，具备多音字与连续识别)
  if (CJK_CHAR_RE.test(rawTarget)) {
    const contMatch = match(rawTarget, p, { space: 'ignore', continuous: true })
    if (contMatch && contMatch.length > 0) {
      if (compactP.length >= 2) {
        if (compactP.length > contMatch.length) {
          // 全拼音节或前缀连续命中 (如 "caiwu" 命中 "财务报表" 产生 [0, 1]，长度 5 > 2)
          return 0.96
        }
        // 拼音首字母紧凑命中 (如 "cwbb" 命中 "财务报表" 产生 [0, 1, 2, 3]，长度 4 === 4)
        return 0.95
      } else if (contMatch[0] === 0) {
        return 0.90
      }
    }
  }

  // 兜底拼音首字母紧凑包含
  const tPinyinInitials = getPinyinInitials(rawTarget)
  if (tPinyinInitials.includes(p) || (compactP.length >= 2 && tPinyinInitials.includes(compactP))) {
    return 0.95
  }

  // 3. 词首字母缩写连续包含 (如 "vsc" 命中 "Visual Studio Code" 的 "vsc")
  const { initials } = getWordInitials(rawTarget)
  if (initials.includes(p) || (compactP.length >= 2 && initials.includes(compactP))) {
    return 0.92
  }

  // 4. 词首字母序列子序列匹配 (如 "vsce" 中跳跃匹配 "vse")
  let inIdx = 0
  for (let i = 0; i < initials.length && inIdx < p.length; i++) {
    if (initials[i] === p[inIdx]) inIdx++
  }
  if (inIdx === p.length) {
    return 0.88
  }

  // 5. 跨字符子序列贪心匹配与启发式打分
  let pIdx = 0
  let matchedBoundaries = 0
  let consecutiveMatches = 0
  let currentConsecutive = 0
  let firstMatch = -1
  let lastMatch = -1

  for (let i = 0; i < rawTarget.length && pIdx < p.length; i++) {
    const charTarget = t[i]
    const initialTarget = tPinyinInitials[i]
    const charPattern = p[pIdx]

    if (charTarget === charPattern || initialTarget === charPattern) {
      if (firstMatch === -1) firstMatch = i
      lastMatch = i

      const boundary = isWordBoundary(rawTarget, i)
      if (boundary) matchedBoundaries++

      currentConsecutive++
      if (currentConsecutive > 1) consecutiveMatches++
      pIdx++
    } else {
      currentConsecutive = 0
    }
  }

  // 若模式串字符未全部匹配，判定未命中
  if (pIdx < p.length) return 0

  // 跨度与紧凑度惩罚
  const span = lastMatch - firstMatch + 1
  const spanRatio = p.length / Math.max(p.length, span)
  const boundaryRatio = matchedBoundaries / p.length
  const consecutiveRatio = consecutiveMatches / Math.max(1, p.length - 1)

  const composite = 0.3 * spanRatio + 0.5 * boundaryRatio + 0.2 * consecutiveRatio
  const score = Math.min(0.85, Math.max(0.15, composite))

  return Math.round(score * 1000) / 1000
}
