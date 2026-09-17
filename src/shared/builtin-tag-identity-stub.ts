/**
 * Builtin Tag Identity 开源存根（Pro 不存在时的降级实现）
 * Spec issue-omni-i18n-tag-identity-spec：开源构建可编译、可导入
 *
 * - 算法与 @firefly/core-engine 方案 B 对齐：builtin.{en_slug}
 * - 开源场景优先消费 taxonomy step0 产物；无产物时用本 stub 构建
 */

import { createHash } from 'node:crypto'

export interface FileDimensionDocument {
  file_dimensions: Array<{
    id: number
    name: string
    tags: string[]
  }>
}

export interface BuiltinTagIdentity {
  code: string
  dimId: number
  tagIndex: number
  en: string
  aliases: Record<string, string>
}

export class BuiltinIdentityError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'BuiltinIdentityError'
    this.code = code
  }
}

const CJK_RE = /[一-鿿]/

function contentHash8(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 8)
}

function sanitizeEnSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
}

/** 方案 B：builtin.{en_slug}，无 hash */
export function enBuiltinCode(enName: string): string {
  const trimmed = enName.trim()
  if (CJK_RE.test(trimmed)) {
    return `builtin.h_${contentHash8(trimmed).slice(0, 10)}`
  }
  const slug = sanitizeEnSlug(trimmed)
  if (!slug) return `builtin.h_${contentHash8(trimmed).slice(0, 10)}`
  return `builtin.${slug}`
}

export function normalizeLemma(lemma: string): string {
  return lemma.normalize('NFKC').trim().toLowerCase()
}

export function buildBuiltinTagIdentity(input: {
  enDoc: FileDimensionDocument
  localeDocs: Record<string, FileDimensionDocument>
  canonicalLocale?: string
}): BuiltinTagIdentity[] {
  const canonicalLocale = input.canonicalLocale ?? 'en-US'
  const enDims = input.enDoc.file_dimensions || []
  const items: BuiltinTagIdentity[] = []
  const slugToEn = new Map<string, string>()

  for (const dim of enDims) {
    const enTags = dim.tags || []
    enTags.forEach((enName, tagIndex) => {
      const en = String(enName ?? '').trim()
      if (!en) {
        throw new BuiltinIdentityError('EMPTY_EN_NAME', `empty en tag dim=${dim.id} idx=${tagIndex}`)
      }
      const code = enBuiltinCode(en)
      const slugKey = CJK_RE.test(en)
        ? `cjk:${contentHash8(en)}`
        : sanitizeEnSlug(en) || `h_${contentHash8(en).slice(0, 10)}`
      const prior = slugToEn.get(slugKey)
      if (prior !== undefined) {
        if (prior.toLowerCase() === en.toLowerCase()) return
        throw new BuiltinIdentityError(
          'SLUG_COLLISION',
          `slug collision: "${prior}" vs "${en}" -> ${slugKey}`
        )
      }
      slugToEn.set(slugKey, en)

      const aliases: Record<string, string> = { [canonicalLocale]: en }
      for (const [locale, doc] of Object.entries(input.localeDocs)) {
        const localDim = (doc.file_dimensions || []).find(d => d.id === dim.id)
        const lemma = localDim?.tags?.[tagIndex]
        if (typeof lemma === 'string' && lemma.trim()) aliases[locale] = lemma.trim()
      }
      items.push({ code, dimId: dim.id, tagIndex, en, aliases })
    })
  }
  return items
}

export interface TagAliasImportRow {
  tag_code: string
  locale: string
  lemma: string
  is_canonical: 0 | 1
}

export interface FileTagImportRow {
  code: string
  name: string
  parent_codes: string[]
  depth: number
  source: 'builtin'
  dimId: number
  tagIndex: number
  meta: Record<string, unknown>
}

export function buildBuiltinImportPlan(input: {
  items: BuiltinTagIdentity[]
  displayLocale: string
  dimensionNames: Record<number, string>
  dimensionRootCode?: (dimId: number) => string
}): {
  tags: FileTagImportRow[]
  aliases: TagAliasImportRow[]
  dimensionRoots: Array<{ code: string; name: string; dimId: number }>
} {
  const dimCode = input.dimensionRootCode ?? ((id: number) => `dim.${id}`)
  const tags: FileTagImportRow[] = []
  const aliases: TagAliasImportRow[] = []
  for (const item of input.items) {
    const displayName = item.aliases[input.displayLocale] ?? item.en
    tags.push({
      code: item.code,
      name: displayName,
      parent_codes: [dimCode(item.dimId)],
      depth: 1,
      source: 'builtin',
      dimId: item.dimId,
      tagIndex: item.tagIndex,
      meta: { isDimension: false, sortOrder: item.tagIndex, enCanonicalName: item.en }
    })
    for (const [locale, lemma] of Object.entries(item.aliases)) {
      aliases.push({
        tag_code: item.code,
        locale,
        lemma,
        is_canonical: locale === 'en-US' ? 1 : 0
      })
    }
  }
  const dimensionRoots = Object.entries(input.dimensionNames).map(([id, name]) => ({
    code: dimCode(Number(id)),
    name,
    dimId: Number(id)
  }))
  return { tags, aliases, dimensionRoots }
}

export function remapTagCodesWithHistoricalMap<T extends { tag_code: string }>(
  relations: T[],
  historicalMap: Record<string, string>
): { relations: T[]; updatedCount: number } {
  let updatedCount = 0
  const next = relations.map(row => {
    const modern = historicalMap[row.tag_code]
    if (!modern || modern === row.tag_code) return { ...row }
    updatedCount += 1
    return { ...row, tag_code: modern }
  })
  return { relations: next, updatedCount }
}
