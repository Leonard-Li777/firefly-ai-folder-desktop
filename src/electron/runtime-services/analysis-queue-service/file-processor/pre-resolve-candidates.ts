/**
 * 落库前受控候选回源（Fix-14 统一闸口在 AI / 视觉 / 融合 / 事实链路的接线点）
 *
 * 背景：saver 的受控码反查（processControlledTagCode → databaseService.findTagCodeByLemma）是同步 API，
 * 只能查本地 tag_aliases 镜像（数千行）；而受控权威在 semantic.pack（7.8 万受控概念 / 46 万词形）。
 * 同步函数无法 await Omni，因此必须在落库前把本批候选词形批量回源一次（Step A 本地镜像 →
 * Step B 负缓存 → Step C Omni inspectTags → Step D unresolved 暂存）。回源命中后宿主会把受控
 * 别名写进镜像表，紧随其后的同步反查即可命中，避免把已受控的概念误派生为 `_ext.*`。
 *
 * 闸口本身失败绝不阻断主链路：内部已把候选记入 unresolved，saver 侧据此拒绝派生 `_ext.*`。
 */

import { logger, LogCategory } from '@firefly/shared'
import { preResolveControlledCandidates } from '@pro'

type TagCandidateLike =
  | string
  | { tagValue?: string; tagName?: string; name?: string }
  | null
  | undefined

export interface ControlledCandidateSources {
  /** CPU 预检产出的事实标签（含 fused / visual） */
  preflightContext?: { groundTruthTags?: TagCandidateLike[] } | null
  /** GPU 阶段维度标签结果：dimensionTags 为 维度→标签数组，tags 为扁平标签列表 */
  dimResult?: {
    dimensionTags?: Record<string, TagCandidateLike[] | TagCandidateLike>
    tags?: TagCandidateLike[]
  } | null
  /**
   * 作者名。作者同样必须走受控优先：知名作者（真实人物）在语义包中通常已有受控概念码，
   * 只有 Omni 明确未收录时才允许回落 `_ext.*`，不得因「作者是开放集」而跳过回源。
   */
  authors?: TagCandidateLike[]
  /** 文件大类 / 文件组（Magika group 或本地化分类名），映射到 builtin.* 受控码 */
  fileGroup?: TagCandidateLike
  /** 关键词候选（BERT / Omni keywords），与标签同源消费 */
  keywords?: TagCandidateLike[]
}

export interface ControlledPreResolveOptions {
  /** 中止信号：取消时不再派发回源请求，候选留未决 */
  signal?: AbortSignal
}

/** 回源成功/已尝试的本地记忆窗口：避免同一批次内对同一词形重复整包重传 */
const ATTEMPT_TTL_OK_MS = 30_000
const ATTEMPT_TTL_FAIL_MS = 5_000
const attemptMemory = new Map<string, { ok: boolean; at: number }>()

/** 从字符串或标签对象中提取词形；空串与非字符串一律丢弃 */
function extractLemma(entry: TagCandidateLike): string | undefined {
  if (typeof entry === 'string') {
    const trimmed = entry.trim()
    return trimmed || undefined
  }
  if (!entry || typeof entry !== 'object') return undefined
  const raw = entry.tagValue || entry.tagName || entry.name || ''
  if (typeof raw !== 'string') return undefined
  const trimmed = raw.trim()
  return trimmed || undefined
}

/**
 * 汇总本批落库真正会出现的候选词形（去重，保持插入顺序稳定）
 * 仅收集标签容器内的词形，不扫描 viaParentName 等父级描述字段，避免把维度名当标签回源。
 */
export function collectControlledCandidateLemmas(sources: ControlledCandidateSources): string[] {
  const bucket = new Set<string>()
  const push = (value: TagCandidateLike): void => {
    const lemma = extractLemma(value)
    if (lemma) bucket.add(lemma)
  }

  const groundTruth = sources.preflightContext?.groundTruthTags
  if (Array.isArray(groundTruth)) groundTruth.forEach(push)

  const dimensionTags = sources.dimResult?.dimensionTags
  if (dimensionTags && typeof dimensionTags === 'object') {
    for (const value of Object.values(dimensionTags)) {
      if (Array.isArray(value)) value.forEach(push)
      else push(value)
    }
  }

  const flatTags = sources.dimResult?.tags
  if (Array.isArray(flatTags)) flatTags.forEach(push)

  const authors = sources.authors
  if (Array.isArray(authors)) authors.forEach(push)
  if (sources.fileGroup) push(sources.fileGroup)
  const keywords = sources.keywords
  if (Array.isArray(keywords)) keywords.forEach(push)

  return Array.from(bucket)
}

/**
 * 落库前执行一次受控候选回源；locale 必须与 saver 收到的 language 同源，
 * 否则 unresolved 队列键不一致，saver 侧的「禁止派生 _ext」闸会失效。
 *
 * @returns 本次提交回源的候选数量（0 表示无候选或闸口未注册）
 */
export async function preResolveControlledCandidatesBeforePersist(
  sources: ControlledCandidateSources,
  language: string | null | undefined,
  options?: ControlledPreResolveOptions
): Promise<number> {
  const locale = language || 'zh-CN'
  const lemmas = collectControlledCandidateLemmas(sources)
  if (lemmas.length === 0) return 0

  // 已回源成功（或刚失败过）的词形在本窗口内不再重复推送，避免整包放大
  const now = Date.now()
  const fresh = lemmas.filter(lemma => {
    const memo = attemptMemory.get(`${locale}\u0000${lemma}`)
    if (!memo) return true
    const ttl = memo.ok ? ATTEMPT_TTL_OK_MS : ATTEMPT_TTL_FAIL_MS
    return now - memo.at >= ttl
  })
  if (fresh.length === 0) return 0

  // 取消：不派发新请求，直接交给下游未决闸（候选保持未核验状态）
  if (options?.signal?.aborted) {
    logger.warn(
      LogCategory.ANALYSIS_QUEUE,
      `[Fix-14] 落库前受控回源被中止，${fresh.length} 个候选保持未核验（不派生 _ext.*）`
    )
    return 0
  }

  try {
    await preResolveControlledCandidates(fresh, locale, { signal: options?.signal })
    for (const lemma of fresh) {
      attemptMemory.set(`${locale}\u0000${lemma}`, { ok: true, at: Date.now() })
    }
    return fresh.length
  } catch (err) {
    for (const lemma of fresh) {
      attemptMemory.set(`${locale}\u0000${lemma}`, { ok: false, at: Date.now() })
    }
    logger.warn(
      LogCategory.ANALYSIS_QUEUE,
      '[Fix-14] 落库前受控候选回源异常，保留既有降级路径:',
      err
    )
    return 0
  }
}
