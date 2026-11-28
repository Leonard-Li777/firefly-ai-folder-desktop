/**
 * 统一周期任务与空闲任务调度器 —— 开源侧直通存根（`@pro/perf/scheduler`）
 *
 * 【存根对称性（D-07）】`electron.vite.config.mts` / vitest 的动态 alias 决定：
 *   - 存在 `pro/src` 时 `@pro/*` → `pro/src/*`（Pro 真实实现）；
 *   - 否则 `@pro/*` → `src/shared/pro-stub/*`（本文件，开源直通存根）。
 *   本文件与 `pro/src/perf/scheduler.ts` 必须导出**完全相同**的运行时符号集合与签名。
 *
 * 【直通契约（D-07 铁律）】开源侧不做任何调度治理：
 *   - `register` 直通 `setInterval`（visibility / power / jitter / backoff / overlap 全部忽略，
 *     与迁移前原生 `setInterval` 行为逐位一致）；
 *   - `runWhenIdle` 直通 `setImmediate`（无优先级队列、无饥饿保底、无时间片预算）；
 *   严禁空实现返回伪造句柄，也严禁在存根内偷偷另建调度器（否则开源 / Pro 行为分裂）。
 *
 * 【禁止静默降级】存根生效时在首次注册任务时 `warn` 一次，显式说明当前走直通路径。
 */

/** 实现标识：开源直通存根为 `'stub'`（供解析单测与运行期观测） */
export const SCHEDULER_IMPL = 'stub' as const

/** 空闲任务饥饿上限默认 30s（存根不启用空闲治理，仅保持常量对称） */
export const DEFAULT_IDLE_DEADLINE_MS = 30_000
/** 单次空闲片预算默认 50ms（存根不启用，仅保持常量对称） */
export const DEFAULT_IDLE_SLICE_BUDGET_MS = 50
/** 降频倍数默认值（存根不降频，仅保持常量对称） */
export const DEFAULT_SLOW_FACTOR = 5
/** 空闲队列重判间隔（存根不启用，仅保持常量对称） */
export const IDLE_RECHECK_INTERVAL_MS = 100
/** jitterRatio 硬上限（存根不加抖动，仅保持常量对称） */
export const MAX_JITTER_RATIO = 0.2

const LOG_PREFIX = '[Scheduler]'

export type SchedulerVisibility = 'always' | 'visible-only' | 'slow-when-hidden'
export type SchedulerPowerPolicy = 'ignore' | 'pause-on-suspend' | 'slow-on-battery'
export type IdlePriority = 'startup-deferred' | 'normal'

export interface ScheduledTaskSpec {
  id: string
  intervalMs: number
  run: () => void | Promise<void>
  runImmediately?: boolean
  visibility?: SchedulerVisibility
  hiddenFactor?: number
  power?: SchedulerPowerPolicy
  jitterRatio?: number
  backoff?: { factor: number; maxMs: number }
  overlap?: 'skip' | 'queue'
  unref?: boolean
}

export interface IdleTaskOptions {
  priority?: IdlePriority
  deadlineMs?: number
  sliceBudgetMs?: number
  repeatUntilDone?: boolean
}

export interface ScheduledTaskHandle {
  dispose(): void
  trigger(): void
  updateInterval(ms: number): void
}

export interface IdleTaskHandle {
  cancel(): void
}

export interface SchedulerTaskSnapshot {
  id: string
  intervalMs: number
  effectiveMs: number
  lastRunAt?: number
  lastDurationMs?: number
  runs: number
  errors: number
}

export interface SchedulerLoggerLike {
  warn(message: string, error?: unknown): void
  debug?(message: string): void
}

export interface SchedulerServiceOptions {
  logger?: SchedulerLoggerLike
  isIdle?: () => boolean
  now?: () => number
}

export interface ISchedulerService {
  register(spec: ScheduledTaskSpec): ScheduledTaskHandle
  runWhenIdle(id: string, fn: () => void | Promise<void> | boolean | Promise<boolean>, opts?: IdleTaskOptions): IdleTaskHandle
  snapshot(): SchedulerTaskSnapshot[]
  disposeAll(): void
  setVisibilityState(visible: boolean): void
  setPowerState(state: { suspended: boolean; onBattery: boolean }): void
}

interface DirectTask {
  spec: ScheduledTaskSpec
  timer: ReturnType<typeof setInterval> | null
  disposed: boolean
  runs: number
  errors: number
  lastRunAt?: number
  lastDurationMs?: number
}

const fallbackLogger: SchedulerLoggerLike = {
  warn: (message, error) => {
    console.warn(message, error)
  }
}

export class SchedulerService implements ISchedulerService {
  private readonly logger: SchedulerLoggerLike
  private readonly now: () => number
  private readonly tasks = new Map<string, DirectTask>()
  private readonly idleHandles = new Set<ReturnType<typeof setImmediate>>()
  private disposed = false
  private directPathWarned = false

  constructor(options: SchedulerServiceOptions = {}) {
    this.logger = options.logger ?? fallbackLogger
    this.now = options.now ?? (() => Date.now())
  }

  private warnDirectPathOnce(): void {
    if (this.directPathWarned) return
    this.directPathWarned = true
    this.logger.warn(`${LOG_PREFIX} 当前走直通路径（setInterval / setImmediate），未启用调度治理`)
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  register(spec: ScheduledTaskSpec): ScheduledTaskHandle {
    if (this.disposed) {
      this.logger.debug?.(`${LOG_PREFIX} 已关停，拒绝注册周期任务: ${spec.id}`)
      return { dispose: () => undefined, trigger: () => undefined, updateInterval: () => undefined }
    }
    if (!spec.id || this.tasks.has(spec.id)) {
      throw new Error(`${LOG_PREFIX} 周期任务 id 非法或重复: ${spec.id}`)
    }
    if (!Number.isFinite(spec.intervalMs) || spec.intervalMs <= 0) {
      throw new Error(`${LOG_PREFIX} 周期任务 intervalMs 必须为正数: ${spec.id}`)
    }
    this.warnDirectPathOnce()
    const task: DirectTask = { spec: { ...spec }, timer: null, disposed: false, runs: 0, errors: 0 }
    this.tasks.set(spec.id, task)
    if (spec.runImmediately) this.executeRun(task)
    this.startInterval(task)
    return {
      dispose: () => {
        task.disposed = true
        if (task.timer !== null) clearInterval(task.timer)
        task.timer = null
        this.tasks.delete(spec.id)
      },
      trigger: () => {
        if (task.disposed || this.disposed) return
        this.executeRun(task)
      },
      updateInterval: (ms: number) => {
        if (task.disposed || this.disposed) return
        if (!Number.isFinite(ms) || ms <= 0) {
          throw new Error(`${LOG_PREFIX} updateInterval 必须为正数: ${spec.id}`)
        }
        task.spec.intervalMs = ms
        if (task.timer !== null) clearInterval(task.timer)
        this.startInterval(task)
      }
    }
  }

  runWhenIdle(
    id: string,
    fn: () => void | Promise<void> | boolean | Promise<boolean>,
    _opts: IdleTaskOptions = {}
  ): IdleTaskHandle {
    if (this.disposed) {
      this.logger.debug?.(`${LOG_PREFIX} 已关停，拒绝注册空闲任务: ${id}`)
      return { cancel: () => undefined }
    }
    this.warnDirectPathOnce()
    // 直通 setImmediate：无优先级 / 无饥饿保底 / 无续片（迁移前行为）
    const handle = setImmediate(() => {
      this.idleHandles.delete(handle)
      if (this.disposed) return
      try {
        const result = fn()
        if (result instanceof Promise) {
          result.catch(error => {
            this.logger.warn(`${LOG_PREFIX} 空闲任务执行失败: ${id}`, error)
          })
        }
      } catch (error) {
        this.logger.warn(`${LOG_PREFIX} 空闲任务执行失败: ${id}`, error)
      }
    })
    this.idleHandles.add(handle)
    return {
      cancel: () => {
        this.idleHandles.delete(handle)
        clearImmediate(handle)
      }
    }
  }

  snapshot(): SchedulerTaskSnapshot[] {
    return Array.from(this.tasks.values()).map(task => ({
      id: task.spec.id,
      intervalMs: task.spec.intervalMs,
      effectiveMs: task.spec.intervalMs,
      lastRunAt: task.lastRunAt,
      lastDurationMs: task.lastDurationMs,
      runs: task.runs,
      errors: task.errors
    }))
  }

  disposeAll(): void {
    if (this.disposed) return
    this.disposed = true
    for (const task of this.tasks.values()) {
      task.disposed = true
      if (task.timer !== null) clearInterval(task.timer)
      task.timer = null
    }
    this.tasks.clear()
    for (const handle of this.idleHandles) clearImmediate(handle)
    this.idleHandles.clear()
  }

  setVisibilityState(_visible: boolean): void {
    // 直通存根不感知可见性：任务始终按基础周期运行（迁移前行为）
  }

  setPowerState(_state: { suspended: boolean; onBattery: boolean }): void {
    // 直通存根不感知电源状态：任务始终按基础周期运行（迁移前行为）
  }

  private startInterval(task: DirectTask): void {
    task.timer = setInterval(() => this.executeRun(task), task.spec.intervalMs)
    if (task.spec.unref !== false) {
      const timer = task.timer as unknown as { unref?: () => void }
      timer.unref?.()
    }
  }

  private executeRun(task: DirectTask): void {
    if (task.disposed || this.disposed) return
    task.runs += 1
    task.lastRunAt = this.now()
    const startedAt = this.now()
    const finish = (error?: unknown) => {
      task.lastDurationMs = this.now() - startedAt
      if (error !== undefined) {
        task.errors += 1
        this.logger.warn(`${LOG_PREFIX} 周期任务执行失败: ${task.spec.id}`, error)
      }
    }
    try {
      const result = task.spec.run()
      if (result instanceof Promise) {
        result.then(
          () => finish(),
          error => finish(error ?? new Error('unknown rejection'))
        )
      } else {
        finish()
      }
    } catch (error) {
      finish(error ?? new Error('unknown error'))
    }
  }
}

let defaultInstance: SchedulerService | null = null

/** 进程级默认调度器单例（与 Pro 实现同签名；开源侧内部为直通实现） */
export function getSchedulerService(): SchedulerService {
  if (!defaultInstance || defaultInstance.isDisposed) {
    defaultInstance = new SchedulerService()
  }
  return defaultInstance
}

/** 仅供单测：释放并重置默认单例 */
export function _resetSchedulerServiceForTesting(): void {
  defaultInstance?.disposeAll()
  defaultInstance = null
}