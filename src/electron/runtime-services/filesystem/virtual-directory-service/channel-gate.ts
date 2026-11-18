/**
 * CLIP 文本通道门控（CLIP Text Channel Gate）
 * 自 HybridSearchArbiter.ts 按职责拆出：零成本前置门禁、门禁全集（前置 + 探活）、CLIP query 清洗。
 * 全部为纯函数：不编码、不检索、不产生网络往返。
 */

import { CLIP_TEXT_STRIP_PARTICLES } from './hybrid-search-constants'
import { evaluateClipTextHealthGate, type ClipTextHealthSnapshot } from './clip-gate'

export function evaluateClipChannelPrecondition(input: {
  profile: string | null | undefined
  enabled: boolean
  lang: string | null | undefined
}): { run: boolean; reason?: string } {
  if ((input.profile || '') !== 'classic_light')
    return { run: false, reason: 'profile_not_classic_light' }
  if (!input.enabled) return { run: false, reason: 'disabled_by_config' }
  // classic_light 现已支持双模态文本检索：zh 走 Chinese-CLIP，非 zh 走 MobileCLIP
  return { run: true }
}
/**
 * CLIP 第 5 路门禁全集（纯函数，便于穷举不满足场景）。
 *
 * 本函数是**门禁语义的唯一权威定义**；热路径为了省掉探活会分两段调用
 * （precondition → 探活 → healthGate），但两段之并必须与本函数逐项等价。
 *
 * 任一不满足都**零请求**：不编码、不检索，既有四路结果与延迟完全不变。
 */
export function evaluateClipChannelGate(input: {
  profile: string | null | undefined
  enabled: boolean
  lang: string | null | undefined
  health: ClipTextHealthSnapshot | null
}): { run: boolean; reason?: string } {
  const pre = evaluateClipChannelPrecondition(input)
  if (!pre.run) return pre
  return evaluateClipTextHealthGate(input.health, input.lang)
}
/**
 * CLIP 文本 query 清洗（**独立于 Bekko 向量路**，工单 12 AC2）。
 *
 * 与 `queryVectorCandidates` 的清洗差异（刻意不同，不可合并）：
 * - **保留自然短语与方位/色彩修饰词**：CLIP 文本塔就是吃自然语言训练的，
 *   「红色的跑车」「左边的沙发」这类修饰正是它的强项，剥离反而降低召回；
 * - **纯拼音/字母 query 不做语义替代**：正排索引架构下纯拼音查询在路由层即跳过 CLIP 路
 *   （拼音串送入中文 RoBERTa-wwm 只会切成碎片 token），本函数不再承接展开词替换；
 * - 基础清洗只剔除非法符号与规整空白；助词剥离由 `CLIP_TEXT_STRIP_PARTICLES` 控制。
 */
export function cleanClipTextQuery(keyword: string): string {
  const raw = (keyword || '').trim()
  if (!raw) return ''
  // 基础清洗：只剔除控制字符与常见代码符号，规整空白；不剥助词、不去修饰词
  let cleaned = raw
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[\\/{}<>|`"^~*\[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (CLIP_TEXT_STRIP_PARTICLES) {
    cleaned = cleaned
      .replace(/(?<=[\u4e00-\u9fa5]{2,})[的之得地](?=[\u4e00-\u9fa5]{2,})/g, '')
      .trim()
  }
  return cleaned
}