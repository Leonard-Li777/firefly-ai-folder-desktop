/**
 * 解析最终落库的 `files.description` —— 单一事实源。
 *
 * 背景（两个描述来源）：
 * - **Omni 侧**（CPU 阶段先落库）：多模态融合轨 / 文本 5W 轨产出 `content_description`，
 *   经 `anydocResult.perception.content_description`（或预检平铺的 `one_sentence_desc` /
 *   `description`）写入 `files.description`；
 * - **AI 侧**（AI 阶段后落库）：语言模型推理产出 `dimResult.description`。
 *
 * 优先级（契约：docs/developer/architecture/v4-end-to-end-architecture.md §5.4
 * 「AI 阶段产出 smartName / description，**覆盖** Omni 预置结果」）：
 *
 * 1. **AI 未直读画面**（图片 + 非多模态模型，`aiLacksVisualGrounding`）→ 此时 AI 看不到画面，
 *    只能按提示词如实写「信息不足」，属无依据推测：保留 Omni 视觉描述（用户诉求
 *    「保留视觉描述」）；Omni 亦无描述时返回 `null`，交由 SQL `COALESCE(?, description)`
 *    保留库中既有值，**绝不**把推测串落库。
 * 2. **其余情形**（含文档 / 音频 / 快捷方式等非图片文件）→ AI 描述优先，覆盖 Omni；
 *    AI 未产出（推理降级）时回退 Omni；两者皆无返回 `null` 交由 SQL 兜底。
 *
 * 为什么抽成独立函数：主流程 AI 分支与并行流水线 GPU 复用分支各需一份判定。
 * 此前内联两份判定时，其中一处漏做「AI 描述 → processResult」回填，
 * 导致 AI 描述被 `COALESCE` 静默吞掉（表现为「AI 描述未覆盖 5W 描述」）。
 * 判定逻辑集中于此，两处调用不再可能漂移。
 */
export function resolveFileDescription(params: {
  /** AI 阶段产出的描述（`dimResult.description`） */
  aiDescription?: string | null
  /**
   * AI 的 description 是否属于「无视觉依据的推测」
   * （`dimResult.lacksVisualGrounding`：图片 + 模型未直读画面）
   */
  aiLacksVisualGrounding?: boolean
  /**
   * Omni 侧描述（`anydocResult.perception.content_description` 等）。
   * GPU 复用分支不传 —— 该分支的 Omni 描述已由 CPU 阶段落库，返回 `null` 时由 SQL 兜底。
   */
  omniDescription?: string | null
}): string | null {
  const ai = params.aiDescription?.trim() || ''
  const omni = params.omniDescription?.trim() || ''

  // 1. AI 无视觉依据（图片 + 非多模态模型）→ 保留 Omni 视觉描述；无则不动库中既有值
  if (params.aiLacksVisualGrounding === true) return omni || null

  // 2. 其余情形：AI 描述优先（契约 §5.4），AI 未产出时回退 Omni，皆无则交由 SQL COALESCE 兜底
  return ai || omni || null
}
