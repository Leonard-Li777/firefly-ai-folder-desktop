/**
 * 分析管道错误结构化分类（Fix-07）
 *
 * 背景：旧实现以 `errorMsg.includes('元数据'/'提取'/'Markitdown'…)` 等中文文案子串
 * 匹配做错误分类，文案或翻译一变即失效。本模块改为结构化依据：
 * - 阶段标记（errorPhase）：由推理阶段调用点边界（processLocalAnalysis / quick-name）
 *   对向上冒泡的错误显式打标；未打标错误保守视为「非推理失败」——不允许 Tier 1
 *   静默降级兜底，防止落库/未知异常被伪装成 AI 推理失败而吞掉；
 * - 超时标记：依赖超时抛出点设置的 `name === 'TimeoutError'`（或 Node 网络层
 *   `code === 'ETIMEDOUT'`），不再匹配「超时」文案。
 */

/** 分析管道错误来源阶段 */
export type AnalysisErrorPhase = 'extraction' | 'inference'

/**
 * 结构化超时错误工厂（与 electron-llamaIndex-service 的 runtime/utils/timeout-error.ts 对齐）：
 * 跨包无法共享实现，故 Desktop 侧保留同构工厂；标记契约一致（name/errorType）。
 */
export function createTimeoutError(message: string): Error {
  const error = new Error(message)
  error.name = 'TimeoutError'
  // 对齐 @firefly/types AIErrorType.REQUEST_TIMEOUT 的既有分类词汇（以字符串赋值避免跨包依赖）
  ;(error as Error & { errorType?: string }).errorType = 'REQUEST_TIMEOUT'
  return error
}

/** 可承载阶段标记的错误对象形状 */
interface TaggableError {
  errorPhase?: AnalysisErrorPhase
}

/**
 * 给错误对象打阶段标记并原样返回（供 `.catch(err => { throw tagErrorPhase(err, 'inference') })` 使用）。
 * 冻结对象无法打标时静默跳过，不改变原错误传播。
 */
export function tagErrorPhase<E>(err: E, phase: AnalysisErrorPhase): E {
  if (err && typeof err === 'object') {
    try {
      ;(err as unknown as Error & TaggableError).errorPhase = phase
    } catch {
      // 冻结/只读错误对象：降级标记丢失属可容忍，分类回退到保守默认（非推理失败）
    }
  }
  return err
}

/** 读取错误对象的阶段标记（未打标返回 undefined） */
export function getErrorPhase(err: unknown): AnalysisErrorPhase | undefined {
  return err && typeof err === 'object' ? (err as TaggableError).errorPhase : undefined
}

/** 是否为超时错误（结构化标记，不匹配文案；errorType 对齐 AIErrorType.REQUEST_TIMEOUT） */
export function isTimeoutError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string; code?: string; errorType?: string }
  return (
    e.name === 'TimeoutError' || e.code === 'ETIMEDOUT' || e.errorType === 'REQUEST_TIMEOUT'
  )
}

/** 分析错误分类结果 */
export interface AnalysisErrorClassification {
  /** 是否超时（TimeoutError / ETIMEDOUT 标记） */
  isTimeout: boolean
  /** 来源阶段（未打标为 undefined） */
  errorPhase: AnalysisErrorPhase | undefined
  /** 是否允许 Tier 1 命名兜底静默降级 —— 仅推理阶段（inference）失败允许 */
  allowTier1Fallback: boolean
}

/**
 * 对冒泡到 processFile 外层 catch 的错误做结构化分类。
 */
export function classifyAnalysisError(err: unknown): AnalysisErrorClassification {
  const errorPhase = getErrorPhase(err)
  return {
    isTimeout: isTimeoutError(err),
    errorPhase,
    allowTier1Fallback: errorPhase === 'inference'
  }
}
