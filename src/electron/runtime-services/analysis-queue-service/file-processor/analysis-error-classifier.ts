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

/**
 * Electron `net` 模块连接层失败码白名单。
 *
 * `net.request` / `net.fetch` 的连接失败以 `net::ERR_xxx` 形式出现在 message 中，
 * 与 Node 层 `ECONNREFUSED` / `ECONNRESET` 是**两套互不包含的文案**
 * （`ERR_CONNECTION_REFUSED` 与 `ECONNREFUSED` 没有公共子串），必须分别覆盖。
 *
 * 漏判后果（2026-10-22 事故）：引擎进程退出后端口无监听，队列 166 个文件在 18 秒内
 * 全部以 `文本文件AI分析失败: net::ERR_CONNECTION_REFUSED` 失败并被判为永久 failed ——
 * 既不恢复 pending，也不等待引擎就绪后重试，用户侧只看到「引擎发生错误」。
 * 连接被拒绝/重置/关闭/中止均属「基础设施尚未就绪或正在重启」的瞬态状态，
 * 唯一正确处理是回到 pending 等待引擎恢复。
 */
const ELECTRON_NET_TRANSIENT_CODES = [
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_ABORTED',
  'ERR_CONNECTION_FAILED'
] as const

/** 文本是否命中 Electron net 连接层失败码 */
function matchesElectronNetTransientCode(text: string | undefined): boolean {
  if (!text) return false
  return ELECTRON_NET_TRANSIENT_CODES.some(code => text.includes(code))
}

/**
 * 引擎暖机期文案（HTTP 503 语义，但常在链路上被压成纯文本，status 丢失）。
 *
 * 两类来源（2026-10-26 实测日志）：
 *   - 萤核引擎反代：`{"error":{"message":"AI engine is starting, please try again","code":503}}`
 *   - llama-server 直答：`{"error":{"message":"Loading model","type":"unavailable_error","code":503}}`
 * 两者都是「模型尚未加载完成」的瞬态状态，恢复 pending 等待引擎就绪即可，
 * 严禁判为永久 failed（历史缺陷：被归一化成「缺少choices字段」硬失败，
 * 文件直接失败且渲染层滞留「引擎异常」，与「引擎状态良好」同屏矛盾）。
 */
const ENGINE_WARMUP_MESSAGES = [
  'AI engine is starting',
  'Loading model',
  'model is loading',
  '模型加载中'
] as const

/** 文本是否命中引擎暖机期文案 */
function matchesEngineWarmupMessage(text: string | undefined): boolean {
  if (!text) return false
  return ENGINE_WARMUP_MESSAGES.some(msg => text.includes(msg))
}

/** 是否为基础设施未就绪等瞬态错误（不可静默降级为完成，必须等待就绪或重试） */
export function isTransientInfraError(err: unknown): boolean {
  if (!err) return false
  if (typeof err === 'object') {
    const e = err as { status?: number; statusCode?: number; code?: string; message?: string }
    if (
      e.status === 503 ||
      e.statusCode === 503 ||
      e.code === 'ECONNREFUSED' ||
      e.code === 'ECONNRESET' ||
      matchesElectronNetTransientCode(e.code)
    ) {
      return true
    }
  }
  // 非 Error 实例的对象也可能携带 message（如跨进程 IPC 透传的错误快照），
  // 直接 String(err) 会退化成 "[object Object]" 而丢失判据
  const msg =
    err instanceof Error
      ? err.message
      : typeof (err as { message?: unknown })?.message === 'string'
        ? (err as { message: string }).message
        : String(err)
  return (
    msg.includes('503') ||
    matchesEngineWarmupMessage(msg) ||
    msg.includes('AI 服务未就绪') ||
    msg.includes('AI服务未就绪') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('服务器未运行') ||
    msg.includes('服务尚未初始化') ||
    matchesElectronNetTransientCode(msg)
  )
}

/** 分析错误分类结果 */
export interface AnalysisErrorClassification {
  /** 是否超时（TimeoutError / ETIMEDOUT 标记） */
  isTimeout: boolean
  /** 是否为基础设施未就绪等瞬态错误 */
  isTransient: boolean
  /** 来源阶段（未打标为 undefined） */
  errorPhase: AnalysisErrorPhase | undefined
  /**
   * 是否允许 Tier 1 命名兜底静默降级 —— 仅推理阶段（inference）的**超时类**失败才允许。
   *
   * 口径依据（slice-3 双层仲裁规格，issue-tier2-slice-3）：Tier 1 静默熔断保底仅 sanction
   * 「Tier 2 超时（默认 10s）或崩溃」：
   * - 超时：单文件推理过慢（如超大 PDF），Tier 1 命名仍可交付，降级为 completed (stage 2)；
   * - 崩溃：引擎进程崩溃在传输层表现为连接类瞬态错误，走 isTransientInfraError 的
   *   pending 等待重试路径，不经过本降级。
   *
   * 严禁降级的其余推理阶段失败（必须 surfaced 为 failed + 错误原因）：
   * - AI 接口契约违规：「AI响应格式异常：缺少choices字段」「收到空响应」「响应无效」
   *   「结果解析失败」等 —— 表明 Tier 2 服务端已无法产出有效推理结果，属系统性故障，
   *   逐文件必然复发。若静默降级，用户会在「全部 completed、无任何错误提示」的状态下
   *   丢失整个 AI 阶段产出，正是 AGENTS.md §2.9 禁止的静默降级（2026-10-20 用户报告：
   *   GPU 阶段 AI 接口错误未标记失败、队列无错误原因，反而标记已完成）。
   */
  allowTier1Fallback: boolean
}

/**
 * 对冒泡到 processFile 外层 catch 的错误做结构化分类。
 */
export function classifyAnalysisError(err: unknown): AnalysisErrorClassification {
  const errorPhase = getErrorPhase(err)
  const isTimeout = isTimeoutError(err)
  const isTransient = isTransientInfraError(err)
  return {
    isTimeout,
    isTransient,
    errorPhase,
    // 关键底线 1：瞬态基础设施未就绪（如 503/启动中/网络拒绝等）绝对禁止静默降级为 Stage 2 完成，
    //   必须恢复 pending 等待引擎就绪后重试；
    // 关键底线 2：AI 接口契约违规类错误（响应格式异常/空响应/解析失败等）同上严禁降级，
    //   它们是逐文件复发的系统性故障，必须 surfaced 为 failed + 错误原因；
    // 仅 slice-3 规格 sanction 的「Tier 2 超时」类允许 Tier 1 兜底（崩溃走瞬态重试路径）。
    allowTier1Fallback: errorPhase === 'inference' && isTimeout && !isTransient
  }
}

