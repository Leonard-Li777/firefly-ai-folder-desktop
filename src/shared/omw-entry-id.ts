/**
 * OMW 词形主键解析（ADR-0035）
 * 形态: omw.{8位offset}.{pos}.{locale}.{lemma}
 * 例: omw.02084071.n.en-US.dog
 *
 * 词形表仅存 id + meta，其余字段由 id 切割得到（去冗余）。
 */

export interface OmwLexicalEntryIdParts {
  /** 概念 code，如 omw.02084071.n */
  synsetId: string
  /** 词性 n/v/a/s/r */
  pos: string
  /** 语言/locale，如 en-US / zh-CN / cmn */
  language: string
  /** 词形，可含点号 */
  lemma: string
}

/** 从词形 id 解析结构化字段；形态不符返回 null */
export function parseOmwLexicalEntryId(id: string): OmwLexicalEntryIdParts | null {
  if (!id || typeof id !== 'string') return null
  const parts = id.split('.')
  // omw + offset + pos + locale + lemma(至少一段)
  if (parts.length < 5 || parts[0] !== 'omw') return null
  const offset = parts[1]
  const pos = parts[2]
  const language = parts[3]
  const lemma = parts.slice(4).join('.')
  if (!offset || !pos || !language || !lemma) return null
  return {
    synsetId: `omw.${offset}.${pos}`,
    pos,
    language,
    lemma
  }
}

/** 构造词形 id（与 taxonomy 管线 make_entry_code 一致） */
export function makeOmwLexicalEntryId(
  offset: string,
  pos: string,
  language: string,
  lemma: string
): string {
  return `omw.${offset}.${pos}.${language}.${lemma}`
}

/** lemma 匹配：大小写不敏感 */
export function lemmaEquals(a: string, b: string): boolean {
  return String(a).toLowerCase() === String(b).toLowerCase()
}

/** 语言匹配：locale 与基码（zh-CN≈cmn/zh，en-US≈en/eng）均兼容 */
export function languageMatches(entryLang: string, wantLang: string): boolean {
  if (!entryLang || !wantLang) return false
  if (entryLang === wantLang) return true
  const a = String(entryLang).toLowerCase()
  const b = String(wantLang).toLowerCase()
  if (a === b) return true
  const baseA = a.split('-')[0]
  const baseB = b.split('-')[0]
  if (baseA === baseB) return true
  // 历史/词网码对照
  const aliases: Record<string, string[]> = {
    zh: ['cmn', 'zh', 'zh-cn'],
    cmn: ['zh', 'zh-cn', 'cmn'],
    en: ['eng', 'en', 'en-us'],
    eng: ['en', 'en-us', 'eng']
  }
  const listA = aliases[baseA] || aliases[a]
  if (listA && listA.includes(b)) return true
  const listB = aliases[baseB] || aliases[b]
  if (listB && listB.includes(a)) return true
  return false
}
