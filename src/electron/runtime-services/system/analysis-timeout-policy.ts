import { getFileCategory, FileCategory } from '@firefly/shared'

/**
 * 单文件分析超时预算策略
 * apps/desktop/src/electron/runtime-services/system/analysis-timeout-policy.ts
 *
 * **设计口径：统一基数 + 类型增量**（2026-10-24 裁决）
 *
 * ```
 * 总额 = 基数（120s） + 类型增量（音频 +30s / 视频 +60s / 文档 0）
 * ```
 *
 * 增量加在「该类型文件的总预算」上，而不是只加给某一阶段——因为音视频多出来的时间
 * 本质是「多模态分析比纯文本多出来的工作量」，两个阶段都该按比例受益。切分后：
 *
 * | 类型 | 总额 | CPU 阶段上限 | AI 阶段保底 |
 * | :--- | ---: | -----------: | ----------: |
 * | 文档 | 120s |          75s |         45s |
 * | 音频 | 150s |         100s |         50s |
 * | 视频 | 180s |         100s |         80s |
 *
 * 音视频的 CPU 上限都是 100s = 引擎侧向量预算 90s + 缩略图/水印/写盘 10s，两者对齐；
 * 剩下的增量全部落到 AI 阶段（视频 80s），解决「视频 AI 只剩 20s」的老问题。
 *
 * **此消彼涨**：AI 阶段实际可用 = 总额 − CPU 阶段已用。CPU 提前结束（短片 / 小文档），
 * 省下的时间自动归 AI；上表的 AI 保底只是下限，不是固定分配。
 *
 * 配置读取用延迟 `require`：本模块会被 omni-service 等被单测直接 import 的模块引用，
 * 静态引入 config-orchestrator 会把 `fix-path` / `electron-conf` 拖进测试环境。
 */

/**
 * 统一基数（毫秒）：所有文件共有的 2 分钟，对应配置项 `FILE_ANALYSIS_TOTAL_TIMEOUT`
 *
 * 注意语义变化：该配置项现在表示**基数**，不是最终总超时；音视频会在基数上叠加类型增量。
 */
export const DEFAULT_BASE_ANALYSIS_TIMEOUT_MS = 120000

/** 文件类型：决定在基数上叠加多少增量 */
export type AnalysisFileKind = 'document' | 'audio' | 'video'

/**
 * 类型增量（毫秒）：音视频的 CPU 阶段有真实的解码 / 编码 / ASR 开销
 *
 * - 音频 +30s：纯音频 ASR 预算 425s（约 85s 实际耗时），增量让 AI 阶段仍有 50s 保底
 * - 视频 +60s：向量预算 90s（含缩略图/水印/写盘共 100s），增量让 AI 阶段拿到 80s
 */
export const KIND_EXTRA_TIMEOUT_MS: Record<AnalysisFileKind, number> = {
  document: 0,
  audio: 30000,
  video: 60000
}

/**
 * 各类型的 AI 阶段**保底**时长（毫秒）
 *
 * 与 `总额 − 保底` 共同决定 CPU 阶段上限，两者之和恒等于该类型的总额。
 */
export const AI_STAGE_RESERVE_MS: Record<AnalysisFileKind, number> = {
  document: 45000,
  audio: 50000,
  video: 80000
}

/**
 * 单段最短时长（毫秒）
 *
 * 基数被配置得极小时（如 10s），按保底切会把另一段压成 0 ⇒ 立即超时。
 * 这里保证两段都至少留下 1s，让降级路径还有机会跑完。
 */
const MIN_SEGMENT_MS = 1000

/**
 * 按路径判定文件类型（仅用于**预算分配**）
 *
 * 判定单源化（Ticket 01）：对齐 @firefly/shared 权威 `getFileCategory`（基于 `CATEGORY_EXT_MAP`）。
 * 判定优先级：扩展名 → MIME（magika 结果） → 调用方提示 → 文档。
 *
 * 源码防误判铁律：`.ts` 扩展名在 MPEG-TS 视频容器中存在，但在桌面端归为 TypeScript 源码（CODE 类别），
 * 默认严禁按视频处理，仅当 magika MIME 显式识别为 `video/mp2t` 时才在下方提升为视频档。
 * 是否走多模态管线由引擎侧的 `is_video` / `is_audio` 判定，与本函数无关。
 */
export function detectAnalysisFileKind(
  filePath?: string | null,
  /** 调用方已知是音视频但分不清音/视频时传 `true`，按视频（预算更大）处理 */
  isMediaHint?: boolean,
  /** magika 给出的 mime_type：用于兜底判定无扩展名的媒体文件 */
  mimeType?: string | null
): AnalysisFileKind {
  if (filePath) {
    const lower = filePath.toLowerCase()
    // 硬规则：.ts 刻意排除，保住 TypeScript 源码不被误算为视频
    if (!lower.endsWith('.ts')) {
      const category = getFileCategory(filePath)
      if (category === FileCategory.AUDIO) return 'audio'
      if (category === FileCategory.VIDEO) return 'video'
    }
  }
  const mime = (mimeType ?? '').toLowerCase()
  if (mime.startsWith('audio/')) return 'audio'
  if (mime.startsWith('video/')) return 'video'
  return isMediaHint ? 'video' : 'document'
}

/** 读取统一基数（毫秒）；配置不可用时退回默认值 */
export function readBaseAnalysisTimeoutMs(): number {
  try {
    // 类型用 `typeof import(...)` 引用（编译期擦除），运行时才真正 require
    const mod = require('../../config/config-orchestrator') as typeof import('../../config/config-orchestrator')
    return (
      mod.ConfigOrchestrator.getInstance().getValue<number>('FILE_ANALYSIS_TOTAL_TIMEOUT') ??
      DEFAULT_BASE_ANALYSIS_TIMEOUT_MS
    )
  } catch {
    // 单测 / 初始化未完成时配置服务不可用
    return DEFAULT_BASE_ANALYSIS_TIMEOUT_MS
  }
}

/** 单文件分析的超时预算切分结果 */
export interface AnalysisTimeoutBudget {
  /** 文件类型 */
  kind: AnalysisFileKind
  /** 该类型的总额（基数 + 类型增量） */
  totalMs: number
  /** CPU 阶段（perceive：基本信息 + ASR + 向量化）上限 */
  cpuCapMs: number
  /** AI 阶段保底（毫秒） */
  aiReserveMs: number
}

/**
 * 解出单文件的超时切分
 *
 * 不变式：`cpuCapMs + aiReserveMs === totalMs`。
 * CPU 段按上限截断 ⇒ `totalMs − 已用 ≥ aiReserveMs` 恒成立，两段之和不超过该类型总额。
 */
export function resolveAnalysisTimeoutBudget(
  filePath?: string | null,
  baseMs: number = readBaseAnalysisTimeoutMs(),
  /** 调用方已知是音视频（如请求里带了音视频专属参数）时传入，避免无扩展名媒体被误判 */
  isMediaHint?: boolean,
  /** magika 给出的 mime_type：扩展名无法判定时用它兜底 */
  mimeType?: string | null
): AnalysisTimeoutBudget {
  const kind = detectAnalysisFileKind(filePath, isMediaHint, mimeType)
  const totalMs = Math.max(0, baseMs) + KIND_EXTRA_TIMEOUT_MS[kind]
  const desired = AI_STAGE_RESERVE_MS[kind]
  // 优先满足 AI 保底；预算不够时退到「至少给 CPU 段留 1s」
  const aiReserveMs = Math.max(
    Math.min(MIN_SEGMENT_MS, totalMs),
    Math.min(desired, Math.max(0, totalMs - MIN_SEGMENT_MS))
  )
  const cpuCapMs = Math.max(0, totalMs - aiReserveMs)
  return { kind, totalMs, cpuCapMs, aiReserveMs }
}

/**
 * AI 阶段实际超时（毫秒）：此消彼涨
 *
 * 取「总额 − 已用」，但不低于保底值——保底值同时也是 CPU 段上限所保证的下界，
 * 因此正常情况下两者相等；`max` 只在 CPU 阶段异常超支（如 FFmpeg 卡死）时兜底。
 */
export function resolveAiStageTimeoutMs(budget: AnalysisTimeoutBudget, elapsedMs: number): number {
  return Math.max(budget.aiReserveMs, budget.totalMs - elapsedMs)
}
