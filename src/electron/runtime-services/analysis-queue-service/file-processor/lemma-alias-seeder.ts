import { LogCategory, logger } from '@firefly/shared'
import { databaseService } from '../../database/database-service'
import { omniClient } from '../../../services/omni-client'

/**
 * 运行时「首见回源」：把本批 lemma 中本地镜像未命中的，批量查 pack 补进 tag_aliases_[lang]。
 * * 对应设计三步：① 查镜像 → ② 未命中查 pack → ③ pack 有则补镜像再用（pack 无才让下游派生 _ext）。
 * 挂载点在 executeProTagReconciliation **之前**：此时 AI 已吐出 groundTruthTags（lemma 已知），
 * 但 resolveControlledCode（同步）尚未执行。在此批量补镜像后，下游同步反查即可命中受控 code，
 * 不再误派生 _ext（如「妈妈→omw.10332385.n」而非 _ext.45f1364f）。
 *
 * 失败安全：回源是优化路径，任何异常都只 warn 不阻断打标主链路（下游仍走镜像→_ext 兜底）。
 * @param lemmas 本批已知 lemma 列表（来自 groundTruthTags.tagName）
 * @param locale 语言，如 zh-CN
 */
export async function ensureLemmaAliasesSeeded(
  lemmas: Array<string | undefined | null>,
  locale?: string,
  aiLemmas?: Array<string | undefined | null>
): Promise<void> {
  // 回源候选必须覆盖 groundTruthTags（CPU 物理事实）与 aiLemmas（AI 推理 lemma）两类来源。
  // 「妈妈」这类词是 AI 推理标签，若只回源 groundTruthTags 会漏掉，导致镜像长期无受控码，
  // 下游 resolveControlledCode 落空 → 派生 _ext.45f1364f（实测 bug）。
  const candidates = [
    ...new Set(
      [...lemmas, ...(aiLemmas ?? [])]
        .map(l => (typeof l === 'string' ? l.trim() : ''))
        .filter(l => l.length > 0)
    )
  ]
  if (candidates.length === 0) return

  const targetLocale = locale || databaseService.getCurrentLanguage?.() || 'zh-CN'

  // ① 镜像已命中的不需要回源
  const missLemmas = candidates.filter(l => !databaseService.findTagCodeByLemma(l, targetLocale))
  if (missLemmas.length === 0) return

  // ② 未命中的批量查 pack（分批防 payload 过大）
  const BATCH = 200
  let seeded = 0
  for (let i = 0; i < missLemmas.length; i += BATCH) {
    const slice = missLemmas.slice(i, i + BATCH)
    try {
      const resp = await omniClient.inspectTags(
        slice.map(tagName => ({ tagName, targetParentCode: '' })),
        targetLocale
      )
      if (!resp?.success || !Array.isArray(resp.results) || resp.results.length === 0) continue

      // ③ pack 命中且 is_controlled → 补进镜像表
      const rows = resp.results
        .filter(r => r.isControlled && r.code)
        .map(r => ({
          tagCode: r.code as string,
          lemma: r.tagName,
          isCanonical: r.tagName === r.canonicalName || !r.canonicalName
        }))
      if (rows.length > 0) {
        seeded += databaseService.seedTagAliasRows(rows, targetLocale)
      }
    } catch (err) {
      logger.warn(
        LogCategory.ANALYSIS_QUEUE,
        '[分析队列] 运行时首见回源 pack 失败（不阻断打标，下游走 _ext 兜底）:',
        err
      )
    }
  }

  if (seeded > 0) {
    logger.debug(
      LogCategory.ANALYSIS_QUEUE,
      `[分析队列] 首见回源补镜像完成：候选=${candidates.length}, 镜像未命中=${missLemmas.length}, 补入=${seeded}, lang=${targetLocale}`
    )
  }
}
