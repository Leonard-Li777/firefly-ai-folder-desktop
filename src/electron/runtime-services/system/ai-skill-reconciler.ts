/**
 * AISkillApiReconciler — 期望状态协调器 (Desired-State Reconciler)
 *
 * 采用单协程状态收敛循环（Single-Coroutine Convergence Loop），
 * 彻底消除所有 FIFO/LWW 竞态与未决 Promise，保证期望状态与物理生命周期确定性收敛。
 * 
 * 对应技术规格说明书: docs/specs/external-api-settings-tab-and-plugin-delist-spec.md §2.3
 */

import { logger, LogCategory } from '@firefly/shared'
import type {
  ExternalApiPhase,
  ExternalApiStatusDTO,
  ExternalApiPresence,
  ExternalApiDegradationReason,
  ExternalApiErrorDTO,
  ExternalApiTestResultDTO
} from '@firefly/types'
import { aiSkillApiService } from '../ai-skill-api-service'

export class AISkillApiReconciler {
  private static instance: AISkillApiReconciler | null = null

  private desired = false
  private phase: ExternalApiPhase = 'stopped'
  private reconciling: Promise<void> | null = null
  private shutdownRequested = false
  private currentEpoch = 0
  private rev = 0
  private degradationReason: ExternalApiDegradationReason = null
  private lastError: ExternalApiErrorDTO | null = null
  private previousSession: {
    lastCallTimestamp: number | null
    lastCaller: string | null
    lastEndpoint: string | null
  } | undefined = undefined
  private listeners = new Set<(status: ExternalApiStatusDTO) => void>()

  static getInstance(): AISkillApiReconciler {
    if (!AISkillApiReconciler.instance) {
      AISkillApiReconciler.instance = new AISkillApiReconciler()
    }
    return AISkillApiReconciler.instance
  }

  constructor() {
    // 监听底层意外崩溃事件
    aiSkillApiService.onCrash((err: Error) => {
      this.handleServerCrash(err)
    })
  }

  /**
   * 启动期初始化意图
   * 自启失败时不篡改持久化配置，保持 desired=true 与 phase=degraded
   */
  async initialize(desiredEnabled: boolean): Promise<ExternalApiStatusDTO> {
    this.desired = desiredEnabled
    if (this.desired) {
      this.reconciling ??= this.reconcile()
      await this.reconciling
    }
    return this.snapshot()
  }

  /**
   * 订阅状态变更推送（主进程内部派发，供 IPC 广播）
   */
  onStatusChanged(listener: (status: ExternalApiStatusDTO) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private broadcast(): void {
    this.rev++
    const snapshot = this.snapshot()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch (err) {
        logger.warn(LogCategory.SYSTEM, '[AISkillApiReconciler] 监听器通知异常:', err)
      }
    }
  }

  /**
   * 设置用户期望开关
   * @param v 期望启闭值
   */
  async setDesired(v: boolean): Promise<ExternalApiStatusDTO> {
    if (this.shutdownRequested && v) {
      const err: any = new Error('应用正在退出')
      err.code = 'SHUTDOWN_IN_PROGRESS'
      throw err
    }
    if (v === this.desired && this.phase !== 'degraded') {
      return this.snapshot()
    }
    this.desired = v
    // 若从 degraded 重试开启，将状态重置为 stopped 以便重新触发收敛循环，并自增代际
    if (this.phase === 'degraded' && v) {
      this.phase = 'stopped'
      this.currentEpoch++
      this.degradationReason = null
      this.lastError = null
    }

    this.reconciling ??= this.reconcile()
    await this.reconciling
    return this.snapshot()
  }

  /**
   * 重试启动（从 degraded 状态恢复）
   */
  async retry(): Promise<ExternalApiStatusDTO> {
    return this.setDesired(true)
  }

  /**
   * 应用退出前彻底停止并关闭拉起通道
   */
  async shutdown(): Promise<void> {
    this.shutdownRequested = true
    this.desired = false
    this.reconciling ??= this.reconcile()
    await this.reconciling
  }

  private needsWork(): boolean {
    if (this.shutdownRequested) {
      return this.phase !== 'stopped'
    }
    if (this.phase === 'degraded') {
      return !this.desired // 若期望关闭则退出 degraded 走向 stopped
    }
    return this.desired ? this.phase !== 'running' : this.phase !== 'stopped'
  }

  private async forceCleanupPartialState(): Promise<void> {
    try {
      await aiSkillApiService.stop()
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[AISkillApiReconciler] forceCleanupPartialState 警告:', err)
    }
  }

  /**
   * 单协程收敛循环：零 await 间隙保证并发折叠安全 (REV-ISS-01.1 闭环)
   */
  private async reconcile(): Promise<void> {
    try {
      while (this.needsWork()) {
        try {
          if (this.desired && !this.shutdownRequested) {
            if (this.phase === 'degraded') {
              this.degradationReason = null
              this.lastError = null
              this.currentEpoch++
            }
            await this.startOnce()
            if (this.phase === 'degraded') break
          } else {
            await this.stopOnce()
          }
        } catch (err: any) {
          logger.error(LogCategory.SYSTEM, '[AISkillApiReconciler] 收敛异常:', err)
          await this.forceCleanupPartialState()
          this.phase = 'degraded'
          this.degradationReason = 'CRASH'
          this.lastError = { code: 'INTERNAL', message: String(err?.message || err) }
          this.broadcast()
          break
        }
      }
    } finally {
      // 零 await 间隙：清空 Promise 句柄前完成最后收尾
      this.reconciling = null
    }
  }

  private async startOnce(): Promise<void> {
    this.phase = 'starting'
    this.broadcast()

    try {
      await aiSkillApiService.start()
      this.phase = 'running'
      this.previousSession = undefined
      this.degradationReason = null
      this.lastError = null
      this.broadcast()
    } catch (err: any) {
      // 执行二次状态清理防逃逸 (D-02 DoD)
      try {
        await aiSkillApiService.stop()
      } catch (cleanupErr) {
        logger.warn(LogCategory.SYSTEM, '[AISkillApiReconciler] 二次状态清理警告:', cleanupErr)
      } finally {
        const errCode = err.code || 'BIND_FAILED'
        this.phase = 'degraded'
        if (errCode === 'PORT_EXHAUSTED') {
          this.degradationReason = 'PORT_EXHAUSTED'
        } else if (errCode === 'DISCOVERY_WRITE_FAILED') {
          this.degradationReason = 'DISCOVERY_WRITE_FAILED'
        } else {
          this.degradationReason = 'BIND_FAILED'
        }

        this.lastError = {
          code: this.degradationReason,
          message: err.message || '服务启动失败'
        }
        logger.error(
          LogCategory.SYSTEM,
          `[AISkillApiReconciler] 启动失败，确定性进入 degraded (${this.degradationReason}):`,
          err
        )
        this.broadcast()
      }
    }
  }

  private async stopOnce(): Promise<void> {
    this.phase = 'stopping'
    this.broadcast()

    // NEW-03: 进入 stopped 前将当前活动迁移至 previousSession
    const activity = aiSkillApiService.getActivitySnapshot()
    if (activity.totalRequests > 0 || activity.lastCallTimestamp !== null) {
      this.previousSession = {
        lastCallTimestamp: activity.lastCallTimestamp,
        lastCaller: activity.lastCaller,
        lastEndpoint: activity.lastEndpoint
      }
    }

    try {
      await aiSkillApiService.stop()
      this.phase = 'stopped'
      this.degradationReason = null
      this.lastError = null
      this.broadcast()
    } catch (err: any) {
      logger.error(LogCategory.SYSTEM, '[AISkillApiReconciler] 停止服务异常:', err)
      this.phase = 'stopped'
      this.broadcast()
    }
  }

  private handleServerCrash(err: Error): void {
    logger.error(LogCategory.SYSTEM, '[AISkillApiReconciler] 检测到底层服务非预期崩溃:', err)
    this.phase = 'degraded'
    this.degradationReason = 'CRASH'
    this.lastError = {
      code: 'INTERNAL',
      message: err.message || '服务非预期崩溃'
    }
    this.broadcast()
  }

  /**
   * 纯内存 O(1) 获取状态快照，严禁读盘
   */
  snapshot(): ExternalApiStatusDTO {
    const isRunning = this.phase === 'running'
    const actualPort = aiSkillApiService.getActualPort()
    const activity = aiSkillApiService.getActivitySnapshot()

    // 墙钟与 Presence 判定
    let presence: ExternalApiPresence
    if (!isRunning) {
      presence = { kind: 'stopped' }
    } else if (activity.lastCallTimestamp === null) {
      presence = { kind: 'standby' }
    } else {
      const ageMs = Math.max(0, Date.now() - activity.lastCallTimestamp)
      if (ageMs <= 300_000) {
        presence = { kind: 'active', ageMs }
      } else {
        presence = { kind: 'idle', ageMs }
      }
    }

    return {
      rev: this.rev,
      phase: this.phase,
      desiredEnabled: this.desired,
      host: '127.0.0.1',
      port: isRunning ? actualPort : null,
      baseUrl: isRunning ? `http://127.0.0.1:${actualPort}` : null,
      uptimeSec: isRunning ? aiSkillApiService.getUptimeSec() : null,
      discoveryPath: aiSkillApiService.getConfigFilePath() || '',
      discoveryPresent: aiSkillApiService.isDiscoveryPresent(),
      degradationReason: this.degradationReason,
      activity,
      presence,
      lastError: this.lastError,
      previousSession: this.previousSession
    }
  }

  /**
   * 真实环回 HTTP 探活自检（Node 原生 http.get，携带探针 Nonce，不污染统计）
   */
  async testConnection(): Promise<ExternalApiTestResultDTO> {
    if (this.phase !== 'running') {
      return {
        success: false,
        latencyMs: null,
        error: {
          code: 'NOT_RUNNING',
          message: '对外接口服务未处于运行状态'
        }
      }
    }
    return aiSkillApiService.testSelfLoopback()
  }
}

export const aiSkillApiReconciler = AISkillApiReconciler.getInstance()
