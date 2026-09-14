/**
 * 分析模式的单一事实来源 (Single Source of Truth)
 *
 * 背景与动机：
 * 此前 ANALYSIS_MODE 的读取与「是否达到完成阶段」的判定散落在多处
 * （analysis-queue-service、file-processor、save-local-cache-result、file-dao），
 * 各自读一次配置并各自实现一套 stage 判定逻辑，导致两类严重问题：
 *
 *   1. 口径漂移：同一文件在不同环节可能读到不同的配置值（例如分析中途切换模式），
 *      造成「队列已完成但 workspace_files.is_analyzed 仍为 0」。
 *   2. 静默兜底：各处均使用 `?? 'quick_name'` 兜底，一旦配置尚未初始化，
 *      真实的 simple（简单分类）模式会被误判为 quick_name，从而要求 stage >= 3，
 *      使仅跑完 CPU 提取（stage 2）的文件永远无法标记为已分析。
 *
 * 本模块集中定义：
 *   - resolveAnalysisMode()       : 统一读取并归一化分析模式
 *   - isAiStageEnabled()          : 该模式是否会执行 AI 阶段（stage 3/4）
 *   - isAnalysisComplete()        : 给定 stage 在该模式下是否算「分析完成」
 *   - isModeCoveredBy()           : completed_mode 的等级是否覆盖所需模式
 *   - isAnalyzedForMode()         : 判定（stage 达标 且 completed_mode 等级覆盖）—— 高级产物可向下兼容
 *   - normalizeAnalysisMode()     : 归一化持久化的模式取值（含历史模式名兼容）
 *   - describeStage()             : stage -> 人类可读的阶段描述
 */

import { ConfigOrchestrator } from './config-orchestrator'
import { logger, LogCategory } from '@firefly/shared'

/** 分析模式（与 @firefly/types 的 ANALYSIS_MODE 保持一致） */
export type AnalysisMode = 'simple' | 'quick_name' | 'full'

/** 兜底模式：配置不可用时的保守取值，与全局默认值一致 */
const FALLBACK_MODE: AnalysisMode = 'quick_name'

/**
 * analysis_stage 的权威语义：
 *
 * - 0: unanalyzed   未分析
 * - 1: 基础身份与元数据提取完成（指纹 / Exif / Magika）
 * - 2: CPU 内容提取完成 —— **这是「简单分类」分析模式的完成标志**
 * - 3: AI 质量评分完成（快速命名的中间阶段）
 * - 4: 维度标签与智能命名完成（快速命名 / 全面分析的终点）
 *
 * 重要：简单分类（simple）模式的完成标志是 stage = 2，而不是 stage = 1。
 * simple 模式同样需要跑完 CPU 内容提取（正文、元数据、缩略图），
 * 只是不进入 AI 阶段（stage 3/4）。若以 stage = 1 作为完成标志，
 * 会导致「正文尚未提取完」的文件被错误标记为已分析。
 *
 * 各模式达成「分析完成」所需的最低 analysis_stage：
 * - simple     : 2（CPU 身份提取 + 内容提取完成，不执行 AI 阶段）
 * - quick_name : 3（AI 质量评分完成）
 * - full       : 4（质量评分与维度标签全部完成）
 */
const REQUIRED_STAGE: Record<AnalysisMode, number> = {
  simple: 2,
  quick_name: 3,
  full: 4
}

/** stage 数值到「该阶段完成的是什么」的中文描述，用于前端精准表达分析进度 */
export const STAGE_DESCRIPTIONS: Record<number, string> = {
  0: '未分析',
  1: '基础身份提取',
  2: '简单分类',
  3: '快速命名',
  4: '全面分析'
}

/**
 * 把 analysis_stage 翻译成「已完成的模式/阶段」描述。
 *
 * 用于前端文案精准表达「文件完成到了哪一步」。
 *
 * @param stage analysis_stage 数值
 * @returns 中文阶段描述，未知阶段返回「未分析」
 */
export function describeStage(stage: number | null | undefined): string {
  const current = typeof stage === 'number' && Number.isFinite(stage) ? stage : 0
  return STAGE_DESCRIPTIONS[current] ?? '未分析'
}

/**
 * 统一读取并归一化分析模式。
 *
 * 注意：
 * - 通过 ConfigOrchestrator.getValue 读取，可自动享受 document -> simple 的规约逻辑；
 * - 读取失败或值非法时记录告警并回退到 FALLBACK_MODE，避免静默降级难以排查。
 *
 * @returns 归一化后的分析模式
 */
export function resolveAnalysisMode(): AnalysisMode {
  let raw: unknown
  try {
    raw = ConfigOrchestrator.getInstance().getValue<string>('ANALYSIS_MODE')
  } catch (error) {
    logger.warn(
      LogCategory.ANALYSIS_QUEUE,
      '[AnalysisMode] 读取 ANALYSIS_MODE 配置失败，回退到默认模式',
      { fallback: FALLBACK_MODE, error }
    )
    return FALLBACK_MODE
  }

  if (raw === 'simple' || raw === 'quick_name' || raw === 'full') {
    return raw
  }

  logger.warn(LogCategory.ANALYSIS_QUEUE, '[AnalysisMode] ANALYSIS_MODE 取值非法，回退到默认模式', {
    received: raw,
    fallback: FALLBACK_MODE
  })
  return FALLBACK_MODE
}

/**
 * 该模式是否需要执行 AI 阶段（stage 3 / stage 4）。
 *
 * 仅 quick_name 与 full 会执行 AI 阶段；simple 模式在 CPU 提取完成后即视为结束。
 */
export function isAiStageEnabled(mode: AnalysisMode = resolveAnalysisMode()): boolean {
  return mode === 'full' || mode === 'quick_name'
}

/**
 * 把任意取值归一化为合法的 AnalysisMode，无法识别时返回 undefined。
 *
 * 主要用于解析数据库中持久化的 `analysis_stats.completed_mode`：
 * 历史数据可能缺失该字段或存有已废弃的模式名（如 sample / document），
 * 此时返回 undefined，由调用方按「未记录完成模式」处理（视为未完成）。
 *
 * @param raw 原始取值
 */
export function normalizeAnalysisMode(raw: unknown): AnalysisMode | undefined {
  if (raw === 'simple' || raw === 'quick_name' || raw === 'full') return raw
  // 历史模式名兼容：document 语义等同于 simple
  if (raw === 'document' || raw === 'sample') return 'simple'
  return undefined
}

/**
 * 分析模式的能力等级。
 *
 * 用于比较「某次分析是否至少覆盖了另一模式的全部工作」。
 * 注意：等级序与 analysis_stage 编号不是一回事 ——
 * quick_name 与 full 都落 stage = 4，但 full 额外执行了质量评分，能力更强。
 */
const MODE_RANK: Record<AnalysisMode, number> = {
  simple: 1,
  quick_name: 2,
  full: 3
}

/**
 * 判定「以 completedMode 模式完成的分析，是否满足 requirement 模式的要求」。
 *
 * 为什么需要它：quick_name 与 full 的终态 stage 都是 4，
 * 仅凭 stage 无法区分「跑过质量评分的 full」与「跳过质量评分的 quick_name」。
 * 因此在 analysis_stats 中额外记录 completed_mode（本次由哪个模式完成），
 * 判定时要求完成模式的等级不低于所需模式。
 *
 * 语义为「向下兼容」：分析是累积过程，高级模式已完成低级模式的全部工作，
 * 故 full 可覆盖 quick_name / simple，quick_name 可覆盖 simple，反之不成立。
 *
 * @param completedMode 该文件实际完成分析所用的模式（缺失时视为未知）
 * @param requirement   当前要求的模式
 */
export function isModeCoveredBy(
  completedMode: AnalysisMode | null | undefined,
  requirement: AnalysisMode
): boolean {
  if (!completedMode) return false
  const done = MODE_RANK[completedMode]
  const need = MODE_RANK[requirement]
  if (done === undefined || need === undefined) return false
  return done >= need
}

/**
 * 判定给定 stage 在该模式下是否算「分析完成」。
 *
 * 这是写入 workspace_files.is_analyzed 的唯一判定依据。
 *
 * ⚠️ 仅凭 stage 无法区分 quick_name 与 full（两者终态均为 4），
 * 因此凡是需要区分这两个模式的场景，请改用 isModeCoveredBy 配合 completed_mode。
 *
 * @param stage 当前 analysis_stage
 * @param mode  分析模式，缺省时自动解析
 */
export function isAnalysisComplete(
  stage: number | null | undefined,
  mode: AnalysisMode = resolveAnalysisMode()
): boolean {
  const current = typeof stage === 'number' && Number.isFinite(stage) ? stage : 0
  return current >= REQUIRED_STAGE[mode]
}

/**
 * 判定「该文件是否已按给定模式完成分析」—— 采用「等级覆盖 + stage 达标」口径。
 *
 * 必须同时满足：
 * 1. analysis_stage 达到该模式所需阶段；
 * 2. `completed_mode` 的等级**不低于**该模式（高级模式的产物可向下兼容低级模式）。
 *
 * 为什么采用等级覆盖而非精确匹配：
 * 分析是「只增不减」的累积过程 —— 高级模式已经做完了低级模式的全部工作，
 * 其产物对低级模式天然有效。若要求精确匹配，用户从 full 切回 simple 时，
 * 已完成全面分析的文件会被判为「未完成」并重新分析，纯属重复劳动。
 *
 * 因此：
 * - full 产物 → 满足 full / quick_name / simple（向下兼容，无需重跑）
 * - quick_name 产物 → 满足 quick_name / simple（缺少质量评分，不满足 full）
 * - simple 产物 → 仅满足 simple（不满足 quick_name / full）
 *
 * 反向仍然严格：用户从低级模式切到高级模式时，仍会判为「未完成」并按新口径重跑，
 * 从而补上缺失的高阶段产物。
 *
 * @param options.stage          analysis_stats.analysis_stage
 * @param options.completedMode  analysis_stats.completed_mode 记录的完成模式
 * @param options.mode           当前要求的分析模式
 */
export function isAnalyzedForMode(options: {
  stage: number | null | undefined
  completedMode: AnalysisMode | null | undefined
  mode?: AnalysisMode
}): boolean {
  const mode = options.mode ?? resolveAnalysisMode()
  return isAnalysisComplete(options.stage, mode) && isModeCoveredBy(options.completedMode, mode)
}

/**
 * 该模式下达成完成所需的最低 stage（供 checkAlreadyAnalyzedFiles 等复用）。
 */
export function getRequiredStage(mode: AnalysisMode = resolveAnalysisMode()): number {
  return REQUIRED_STAGE[mode]
}

/**
 * 判定「以当前模式衡量，existingStage 是否已满足完成条件」。
 *
 * 语义等同于 isAnalysisComplete，单独命名以强调其被用于「校验历史 stage」的场景，
 * 例如在进入 AI 阶段前判断是否需要撤销上一次以其它模式写入的 is_analyzed 标记。
 */
export function isStageSufficientForMode(
  existingStage: number | null | undefined,
  mode: AnalysisMode = resolveAnalysisMode()
): boolean {
  return isAnalysisComplete(existingStage, mode)
}

/**
 * 计算「本次实际达成的阶段」。
 *
 * 分析过程中允许切换 ANALYSIS_MODE，已完成的工作不会被撤销，
 * 因此实际阶段应取「已有阶段」与「本次目标阶段」的较大值，
 * 避免因模式变简单或变更方向不同而把 stage 回退（造成阶段信息失真）。
 *
 * @param targetStage   本次按当前模式计划达成的阶段
 * @param existingStage 数据库中已有的阶段
 */
export function resolveAchievedStage(
  targetStage: number,
  existingStage: number | null | undefined
): number {
  const existing =
    typeof existingStage === 'number' && Number.isFinite(existingStage) ? existingStage : 0
  const target = Number.isFinite(targetStage) ? targetStage : 0
  return Math.max(target, existing)
}

/**
 * CPU 提取阶段的「本次目标阶段」。
 *
 * 所有分析模式都需要跑完 CPU 内容提取（stage 2）：
 * - simple      : 在 stage 2 结束（内容提取完成即该模式完成，不进入 AI 阶段）
 * - quick_name / full : 在 stage 2 完成后进入 AI 阶段（stage 3/4）
 *
 * 因此本函数恒返回 2。之所以保留函数而不写死常量，
 * 是为了保持「阶段目标由分析模式决定」这一语义集中在本模块内，
 * 避免调用方散落魔法数字。
 */
export function getCpuTargetStage(_mode: AnalysisMode = resolveAnalysisMode()): number {
  return 2
}

/**
 * AI 阶段的「本次目标阶段」。
 *
 * - quick_name : 完成维度分析与智能命名（stage 3）
 * - full       : 额外完成质量评分（stage 4）
 *
 * @throws 当模式不启用 AI 阶段时，调用方不应进入 AI 流程
 */
export function getAiTargetStage(mode: AnalysisMode = resolveAnalysisMode()): number {
  return mode === 'quick_name' ? 3 : 4
}

