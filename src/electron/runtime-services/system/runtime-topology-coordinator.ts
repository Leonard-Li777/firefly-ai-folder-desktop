import { AsyncLocalStorage } from 'async_hooks'
import { logger } from '@firefly/shared'

/**
 * 运行时拓扑单协调器 (`RuntimeTopologyCoordinator`)
 *
 * 将模块安装、状态切换、离线激活与卸载统一收拢至单一异步互斥队列，
 * 借助 AsyncLocalStorage 识别重入调用避免嵌套死锁 (`TC-SSOT-10`)，并对尾部高频拓扑通知做去重合并。
 */
export class RuntimeTopologyCoordinator {
  private mutexChain: Promise<void> = Promise.resolve()
  private readonly als = new AsyncLocalStorage<symbol>()
  private activeToken: symbol | null = null
  private pendingCoalescedNotify: Promise<void> | null = null
  private latestCoalescedTask: (() => Promise<void>) | null = null

  public async execute<T>(
    task: () => Promise<T>,
    options?: {
      restartAfter?: boolean
      onRestart?: () => Promise<void>
    }
  ): Promise<T> {
    const runWithRestart = async (): Promise<T> => {
      const result = await task()
      if (options?.restartAfter && options.onRestart) {
        await options.onRestart()
      }
      return result
    }

    // 同一异步执行链重入时直接复用当前锁持有人上下文，防止自锁
    const currentToken = this.als.getStore()
    if (currentToken && currentToken === this.activeToken) {
      return await runWithRestart()
    }

    const prev = this.mutexChain
    let release!: () => void
    this.mutexChain = new Promise<void>(resolve => {
      release = resolve
    })

    await prev.catch(() => {})
    const token = Symbol('topology-lock')
    this.activeToken = token
    try {
      return await this.als.run(token, runWithRestart)
    } finally {
      if (this.activeToken === token) {
        this.activeToken = null
      }
      release()
    }
  }

  /**
   * 尾沿合并通知：若当前已有外部队列等待通知，仅刷新末次意图并复用同一等待期
   */
  public async coalesceTopologyNotify(run: () => Promise<void>): Promise<void> {
    const currentToken = this.als.getStore()
    if (currentToken && currentToken === this.activeToken) {
      await run()
      return
    }

    this.latestCoalescedTask = run
    if (this.pendingCoalescedNotify) {
      return await this.pendingCoalescedNotify
    }

    this.pendingCoalescedNotify = this.execute(async () => {
      // 微小防抖窗口（5ms）聚合瞬间批量后台校验完成事件
      await new Promise(resolve => setTimeout(resolve, 5))
      const taskToRun = this.latestCoalescedTask
      this.latestCoalescedTask = null
      if (taskToRun) {
        await taskToRun()
      }
    }).finally(() => {
      this.pendingCoalescedNotify = null
    })

    return await this.pendingCoalescedNotify
  }
}

export const runtimeTopologyCoordinator = new RuntimeTopologyCoordinator()
