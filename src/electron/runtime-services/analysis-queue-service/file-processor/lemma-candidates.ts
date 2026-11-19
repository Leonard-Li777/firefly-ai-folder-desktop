/**
 * 运行时首见回源辅助：从 AI 推理结果中提取候选 lemma（纯函数，无副作用）。
 *
 * 抽取为独立模块的目的：使「回源候选是否覆盖 AI 推理 lemma」这一关键逻辑可被
 * 单元测试独立验证，无需拉起 file-processor 的重量级依赖链（Omni/Magika/DB 等）。
 *
 * 背景（实测 bug：妈妈 → _ext.45f1364f）：
 * 回源候选若只取 groundTruthTags（CPU 物理事实标签），会漏掉 AI 推理 lemma。
 * 「妈妈」是 AI 推理标签，镜像 tag_aliases 长期缺受控码 omw.10332385.n，
 * 下游 resolveControlledCode('妈妈') 落空 → saver.ts 兜底派生 _ext.45f1364f。
 * 故回源前必须把 AI 推理 lemma 一并纳入候选。
 */

/**
 * 从 AI 推理结果 dimResult 中提取全量候选 lemma。
 *
 * 口径与 pro executeProTagReconciliation 收集 aiInferenceTags 一致：
 * - 遍历 dimensionTags / dimensions 各维度的值（数组或单值）；
 * - 每项可为纯字符串，或对象（取 tagValue / tagName / name）；
 * - 顶层 tags 数组同样纳入。
 *
 * @param dimResult AI 推理结果（dimensionTags / dimensions / tags）
 * @returns 去空白后的 lemma 字符串数组（保持原顺序，不做去重——去重由调用方合并候选时统一做）
 */
export function extractAiLemmasFromDimResult(dimResult: any): string[] {
  const out: string[] = []
  const push = (v: unknown) => {
    if (typeof v === 'string' && v.trim()) out.push(v.trim())
    else if (v && typeof v === 'object') {
      const name = ((v as any).tagValue || (v as any).tagName || (v as any).name || '').trim()
      if (name) out.push(name)
    }
  }
  const dims = dimResult?.dimensionTags || dimResult?.dimensions
  if (dims && typeof dims === 'object') {
    for (const tags of Object.values(dims)) {
      if (Array.isArray(tags)) tags.forEach(push)
      else push(tags)
    }
  }
  if (Array.isArray(dimResult?.tags)) dimResult.tags.forEach(push)
  return out
}
