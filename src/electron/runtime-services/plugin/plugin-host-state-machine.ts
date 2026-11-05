/**
 * 插件宿主 7 态生命周期状态机与代际管理器
 *
 * 遵循规格：plugin-runtime-sandbox-and-omni-seams-spec.md §2.2
 */

import { InFlightTask, PluginHostState, TaskState } from './plugin-types'

export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly from: PluginHostState,
    public readonly to: PluginHostState,
    reason?: string
  ) {
    super(`Invalid PluginHost state transition: ${from} -> ${to}${reason ? ` (${reason})` : ''}`)
    this.name = 'InvalidStateTransitionError'
  }
}

/**
 * 7 态合法跃迁映射表
 */
const VALID_TRANSITIONS: Record<PluginHostState, readonly PluginHostState[]> = {
  STOPPED: ['STARTING'],
  STARTING: ['READY', 'TERMINATING', 'CLEANING', 'STOPPED'],
  READY: ['BUSY', 'RETIRING', 'TERMINATING', 'CLEANING', 'STOPPED'],
  BUSY: ['READY', 'TERMINATING', 'CLEANING', 'STOPPED'],
  TERMINATING: ['CLEANING', 'STOPPED'],
  RETIRING: ['CLEANING', 'STOPPED'],
  CLEANING: ['STOPPED']
}

export class PluginHostStateMachine {
  private _state: PluginHostState = 'STOPPED'
  private _processGeneration: number = 0
  private _currentTask: InFlightTask | null = null

  /**
   * 当前状态
   */
  public get state(): PluginHostState {
    return this._state
  }

  /**
   * 当前代际编号
   */
  public get processGeneration(): number {
    return this._processGeneration
  }

  /**
   * 当前执行中的任务
   */
  public get currentTask(): InFlightTask | null {
    return this._currentTask
  }

  /**
   * 判断是否可以跃迁至目标状态
   */
  public canTransitionTo(target: PluginHostState): boolean {
    if (this._state === target) return true
    const allowed = VALID_TRANSITIONS[this._state]
    return allowed ? allowed.includes(target) : false
  }

  /**
   * 执行状态跃迁
   */
  public transitionTo(target: PluginHostState, reason?: string): void {
    if (this._state === target) return

    if (!this.canTransitionTo(target)) {
      throw new InvalidStateTransitionError(this._state, target, reason)
    }

    this._state = target
  }

  /**
   * 生成下一代代际编号（每次 spawn 进程时递增）
   */
  public bumpGeneration(): number {
    this._processGeneration += 1
    return this._processGeneration
  }

  /**
   * 校验消息代际是否匹配当前活跃进程代际
   */
  public isCurrentGeneration(generation: number): boolean {
    return this._processGeneration > 0 && this._processGeneration === generation
  }

  /**
   * 关联当前在途任务
   */
  public assignTask(task: InFlightTask): void {
    if (this._currentTask !== null) {
      throw new Error(
        `Cannot assign task ${task.taskId}: another task ${this._currentTask.taskId} is already in flight`
      )
    }
    this._currentTask = task
  }

  /**
   * 幂等结算当前在途任务
   * 无论是正常完成、失败、超时、崩溃还是降级，均保证只结算一次，并排空当前任务槽位
   */
  public settleTask(outcome: TaskState, error?: any, result?: any): boolean {
    const task = this._currentTask
    if (!task) {
      return false
    }

    // 清理任务槽位与定时器
    this._currentTask = null
    if (task.deadlineTimer) {
      clearTimeout(task.deadlineTimer)
      task.deadlineTimer = undefined
    }

    if (outcome === 'completed') {
      task.resolve(result)
    } else {
      const err =
        error instanceof Error
          ? error
          : new Error(
              typeof error === 'string'
                ? error
                : `Task ${task.taskId} finished with outcome: ${outcome}`
            )
      ;(err as any).taskOutcome = outcome
      ;(err as any).taskId = task.taskId
      task.reject(err)
    }

    return true
  }

  /**
   * 强制重置状态为 STOPPED（如测试初始化或紧急重置）
   */
  public forceReset(): void {
    if (this._currentTask) {
      this.settleTask('failed', new Error('StateMachine force reset'))
    }
    this._state = 'STOPPED'
  }
}
