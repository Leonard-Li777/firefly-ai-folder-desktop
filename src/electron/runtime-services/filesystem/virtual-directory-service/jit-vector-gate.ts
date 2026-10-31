/**
 * JIT 向量补全 60ms 软熔断门禁 (Ticket 10 / Spec §4.9)
 *
 * 实施边界（铁律）：本门禁专属「智能透视整理与聚类链路」（v4-perspective-driven-batch-organize-spec），
 * 严禁在普通检索链路做无谓跨界调用。
 *
 * 物理痛点：进入智能整理/聚类时，若工作区存在少量未向量化文件，
 * 在单个 HTTP 请求内串行计算 Embedding 会同步阻塞 3~6s，首屏感知顿挫。
 *
 * 软熔断语义（Spec §4.9）：
 * 1. 同步配额：缺失文件数 <= JIT_VECTOR_SYNC_MAX_FILES 且在 60ms 软预算内完成，允许即时补齐；
 * 2. 快速熔断：缺失文件数 > 配额，或补全等待超过 60ms 软预算，即刻中断同步阻塞，
 *    先行基于已有向量完成本轮聚类视图渲染，保证首屏 < 100ms 呈现；
 * 3. 熔断后的缺失文件由调用方通过 analysisQueueService.addItems(missingInputs, false)
 *    排入后台低优先级队列静默消费，补全完毕后触发界面增量更新。
 */

/** 同步 JIT 补全的文件数配额：超过即立即熔断，不做任何同步等待 */
export const JIT_VECTOR_SYNC_MAX_FILES = 2

/** 同步 JIT 补全的软超时预算（ms）：超过即立即熔断，不再等待在途补全 */
export const JIT_VECTOR_SYNC_BUDGET_MS = 60

/** 熔断决策原因 */
export type JitVectorGateReason =
  /** 无缺失向量文件，无需门禁 */
  | 'none-missing'
  /** 缺失文件全部在配额与软预算内同步补全完成 */
  | 'within-budget'
  /** 缺失文件数超过同步配额，未发起任何同步补全即熔断 */
  | 'over-quota'
  /** 同步补全等待超过 60ms 软预算（或补全执行器未确认全部完成），熔断并延迟未完成项 */
  | 'over-budget'

export interface JitVectorGateResult<T> {
  /** 配额与软预算内确认完成同步补全的文件 */
  admitted: T[]
  /** 熔断后转后台低优先级队列异步消费的缺失文件 */
  deferred: T[]
  /** 是否触发熔断（true 时调用方必须将 deferred 入队并显式上报，禁止静默降级） */
  tripped: boolean
  reason: JitVectorGateReason
  /** 同步阶段实际等待耗时（ms，配额熔断为 0） */
  elapsedMs: number
}

export interface JitVectorGateOptions<T> {
  /** 缺失向量的文件清单 */
  missingItems: T[]
  /**
   * 同步补全执行器：接收整批缺失文件，返回「确认完成补全」的文件子集。
   * 执行器内部超时/失败不应抛出阻断异常（返回已确认子集即可），未确认项一律按熔断延迟处理。
   */
  completeBatch: (items: T[]) => Promise<T[]>
  /** 软超时预算（ms），缺省 JIT_VECTOR_SYNC_BUDGET_MS */
  budgetMs?: number
  /** 同步文件数配额，缺省 JIT_VECTOR_SYNC_MAX_FILES */
  maxSyncCount?: number
  /** 时钟注入（单测确定性），缺省 Date.now */
  now?: () => number
  /** 延时注入（单测确定性），缺省 setTimeout */
  delay?: (ms: number) => Promise<void>
}

/**
 * 执行带 60ms 软熔断的 JIT 向量补全：
 * - 空缺失集：直接放行（none-missing）；
 * - 超额（> maxSyncCount）：零等待熔断（over-quota），全部转后台；
 * - 配额内：与 60ms 预算计时器竞速，补全执行器先完成且全量确认则放行（within-budget），
 *   否则立即熔断（over-budget），未确认项全部转后台队列。
 */
export async function runJitVectorCompletionGate<T>(
  options: JitVectorGateOptions<T>
): Promise<JitVectorGateResult<T>> {
  const { missingItems, completeBatch } = options
  const budgetMs = options.budgetMs ?? JIT_VECTOR_SYNC_BUDGET_MS
  const maxSyncCount = options.maxSyncCount ?? JIT_VECTOR_SYNC_MAX_FILES
  const now = options.now ?? (() => Date.now())
  const delay =
    options.delay ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))

  if (!missingItems || missingItems.length === 0) {
    return { admitted: [], deferred: [], tripped: false, reason: 'none-missing', elapsedMs: 0 }
  }

  // 配额熔断：缺失文件数 > 同步配额 → 不发起任何同步补全，即刻转后台队列
  if (missingItems.length > maxSyncCount) {
    return {
      admitted: [],
      deferred: [...missingItems],
      tripped: true,
      reason: 'over-quota',
      elapsedMs: 0
    }
  }

  const start = now()
  let completed: T[] = []
  try {
    completed = await Promise.race([
      completeBatch(missingItems),
      delay(budgetMs).then((): T[] => [])
    ])
  } catch {
    // 补全执行器异常不阻断聚类主链路：按零确认处理，未完成项转后台（调用方显式上报）
    completed = []
  }
  const elapsedMs = now() - start

  const completedSet = new Set(completed)
  const admitted = missingItems.filter(item => completedSet.has(item))
  const deferred = missingItems.filter(item => !completedSet.has(item))

  if (deferred.length > 0) {
    return { admitted, deferred, tripped: true, reason: 'over-budget', elapsedMs }
  }
  return { admitted, deferred: [], tripped: false, reason: 'within-budget', elapsedMs }
}
