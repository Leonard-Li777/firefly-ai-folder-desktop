/**
 * 多模态图片送入模型的边长预算
 *
 * 背景（2026-10-29 事故）：桌面端过去固定把图片最长边压到 800px 再送引擎。
 * 视觉 token 与像素面积近似成正比，实测一张 800px 图片在该机型上约消耗 0.9K~1.2K tokens；
 * 而引擎侧 `ParamBuilder` 按显存/内存预算可能只加载到 2048 上下文（推荐值 8192 只是目录静态值），
 * 此时单张图片即可吃掉大半窗口，请求被 llama-server 以
 *
 *   request (2469 tokens) exceeds the available context size (2048 tokens)
 *
 * 拒绝（HTTP 400）。因此图片边长不能是常量，必须随引擎**真实**上下文窗口收敛。
 *
 * 档位依据（同机型实测够用性，不是拍脑袋的比例）：
 * - ≥4096：系统提示词（约 1.5K tokens）+ 800px 图片（约 1K）+ 输出，整体约 2.7K，能装下 ⇒ 维持 800px 画质基线；
 * - 2048~4095：窗口已装不下 800px 图，收敛到 384px（视觉 token 约降到 1/4）；
 * - <2048：落到 320px 可辨识下限——再小则 OCR 与主体识别失真，宁可让上层按错误降级。
 *
 * 注意：2048 窗口对多模态本质上过于狭窄（系统提示词本身已占约 3/4），本函数只能避免
 * 「必然溢出」，不能把窄窗口变成可用窗口；根本解法是引擎以 ≥4096 的 ctx 加载视觉模型。
 */

/** 既有画质基线：800px 最长边 */
export const DEFAULT_IMAGE_MAX_EDGE = 800

/** 该窗口及以上维持 800px 基线（实测 4096 窗口可容纳 800px 图 + 系统提示词 + 输出） */
export const FULL_IMAGE_EDGE_CONTEXT = 4096

/** 窄窗口（2048~4095）档位：视觉 token 约降至 1/4 */
export const NARROW_WINDOW_IMAGE_MAX_EDGE = 384

/** 可辨识下限：低于此值 OCR 与主体识别基本失效 */
export const MIN_IMAGE_MAX_EDGE = 320

/**
 * 依据真实上下文窗口挑选图片最长边（像素）
 *
 * @param contextTokens 引擎实际加载的上下文窗口（tokens）；未知时传 null / undefined
 */
export function pickImageMaxEdge(contextTokens: number | null | undefined): number {
  if (
    contextTokens === null ||
    contextTokens === undefined ||
    !Number.isFinite(contextTokens) ||
    contextTokens <= 0
  ) {
    return DEFAULT_IMAGE_MAX_EDGE
  }

  if (contextTokens >= FULL_IMAGE_EDGE_CONTEXT) return DEFAULT_IMAGE_MAX_EDGE
  if (contextTokens >= 2048) return NARROW_WINDOW_IMAGE_MAX_EDGE
  return MIN_IMAGE_MAX_EDGE
}
