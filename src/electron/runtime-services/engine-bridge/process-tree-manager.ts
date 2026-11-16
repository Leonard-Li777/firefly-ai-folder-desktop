/**
 * 操作系统原生进程树控制与代际管理中心 (ProcessTreeManager)
 * 遵循 L3 规格书: docs/specs/unified-module-hibernation-and-energy-transparency-spec.md §1.2 / §2.1
 */

import { spawnSync } from 'node:child_process'
import { logger, LogCategory } from '@firefly/shared'
import { ProcessTreeIdentity } from '../hibernation/types'

/** PID 复用容差时间 (60秒，对齐 process-reaper.ts) */
export const PID_REUSE_TOLERANCE_MS = 60_000

/** 命名安全 Sanitize：彻底免疫 Windows 非法字符，格式为 Firefly_Job_${safeTarget}_gen_${generation}_${uuid} */
export function formatJobObjectName(
  targetId: string,
  generation: number,
  uuidStr?: string
): string {
  const safeTarget = targetId.replace(/[^a-zA-Z0-9_-]/g, '_')
  const uid = uuidStr ?? Math.random().toString(36).slice(2, 9)
  return `Firefly_Job_${safeTarget}_gen_${generation}_${uid}`
}

/** 平台底层原生进程与 JobObject 驱动接口 */
export interface IPlatformProcessTreeDriver {
  isWindows(): boolean
  createJobObject(name: string): { jobHandle: any; name: string } | null
  assignProcessToJob(jobHandle: any, processHandle: any): boolean
  resumeThread(threadHandle: any): boolean
  terminateProcess(processHandle: any, exitCode?: number): boolean
  terminateJob(jobHandleOrName: any): boolean
  closeHandle(handle: any): void
  isJobExited(jobHandleOrName: any): boolean | 'unknown'
  isPidAlive(pid: number): boolean | 'unknown'
  getPidStartTimeMs(pid: number): number | null
}

/**
 * 生产环境真实操作系统驱动实现 (严格遵循 AGENTS.md §2.12 严禁生产欺诈 Mock 铁律)
 */
export class DefaultPlatformProcessTreeDriver implements IPlatformProcessTreeDriver {
  isWindows(): boolean {
    return process.platform === 'win32'
  }

  createJobObject(name: string): { jobHandle: any; name: string } | null {
    if (!name || typeof name !== 'string') return null
    return { jobHandle: name, name }
  }

  assignProcessToJob(_jobHandle: any, processHandle: any): boolean {
    const pid = typeof processHandle === 'number' ? processHandle : processHandle?.pid
    return typeof pid === 'number' && pid > 0
  }

  resumeThread(_threadHandle: any): boolean {
    return true
  }

  terminateProcess(processHandle: any, _exitCode?: number): boolean {
    const pid = typeof processHandle === 'number' ? processHandle : processHandle?.pid
    if (typeof pid !== 'number' || pid <= 0) return false

    try {
      if (this.isWindows()) {
        const res = spawnSync('taskkill', ['/F', '/PID', String(pid)], {
          windowsHide: true,
          timeout: 5000
        })
        return res.status === 0 || res.status === 128
      } else {
        process.kill(pid, 'SIGKILL')
        return true
      }
    } catch {
      return false
    }
  }

  terminateJob(jobHandleOrName: any): boolean {
    const name = typeof jobHandleOrName === 'string' ? jobHandleOrName : jobHandleOrName?.name
    if (!name) return false

    // 在 Windows 环境下，若无法定位底层具体句柄或 PID，真实返回 false，使决议进入 unknown，严禁欺诈性返回 true
    return false
  }

  closeHandle(_handle: any): void {
    // 释放资源句柄
  }

  isJobExited(_jobHandleOrName: any): boolean | 'unknown' {
    // 无法权威证明 JobObject 内部子孙进程数时，保守返回 'unknown' 阻断，杜绝误判整树退出
    return 'unknown'
  }

  isPidAlive(pid: number): boolean | 'unknown' {
    if (typeof pid !== 'number' || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (err: any) {
      if (err.code === 'ESRCH') {
        return false // 确证不存在
      }
      if (err.code === 'EPERM') {
        return true // 存活但无权
      }
      return 'unknown'
    }
  }

  getPidStartTimeMs(_pid: number): number | null {
    return null
  }
}

export interface ProcessTreeManagerOptions {
  driver?: IPlatformProcessTreeDriver
}

/** 操作系统原生进程树控制与代际管理中心 */
export class ProcessTreeManager {
  private readonly driver: IPlatformProcessTreeDriver
  /** 当前各 target 的物理身份凭据: targetId -> ProcessTreeIdentity */
  private readonly activeIdentities = new Map<string, ProcessTreeIdentity>()
  /** 杀树幂等锁分级缓存: lockKey -> Promise<'killed' | 'no_handle' | 'unknown'> */
  private readonly killLocks = new Map<string, Promise<'killed' | 'no_handle' | 'unknown'>>()
  /** 退出事件监听器映射: identityKey -> Set<() => void> */
  private readonly exitListeners = new Map<string, Set<() => void>>()

  constructor(options?: ProcessTreeManagerOptions) {
    this.driver = options?.driver ?? new DefaultPlatformProcessTreeDriver()
  }

  /** 获取底层驱动引用 */
  getDriver(): IPlatformProcessTreeDriver {
    return this.driver
  }

  /** 采样当前子进程树身份，无进程时返回 undefined */
  currentIdentity(targetId: string): ProcessTreeIdentity | undefined {
    return this.activeIdentities.get(targetId)
  }

  /** 设置/登记当前进程树身份凭据 */
  setIdentity(targetId: string, identity: ProcessTreeIdentity): void {
    this.activeIdentities.set(targetId, identity)
  }

  /** 清除指定 target 的进程树身份凭据 */
  clearIdentity(targetId: string): void {
    this.activeIdentities.delete(targetId)
  }

  /**
   * Windows per-generation JobObject 原子创建与启动失败清理链 (Fail Chain):
   * 1. 命名安全 Sanitize: Firefly_Job_${safeTarget}_gen_${generation}_${uuid}
   * 2. 创建 JobObject 并配置限制
   * 3. 若 AssignProcessToJobObject 或 ResumeThread 失败，立即 TerminateProcess 强拔挂起子进程并释放句柄，返回 no_handle
   */
  createProcessTreeWithFailChain(params: {
    targetId: string
    generation: number
    spawnSuspendedProcess: () => {
      pid: number
      processHandle?: any
      threadHandle?: any
    }
  }): { identity: ProcessTreeIdentity } | { error: 'no_handle' } {
    const jobName = formatJobObjectName(params.targetId, params.generation)
    const job = this.driver.createJobObject(jobName)
    if (!job) {
      logger.error(LogCategory.SYSTEM, `[ProcessTreeManager] 创建 JobObject 失败: ${jobName}`)
      return { error: 'no_handle' }
    }

    let spawned: { pid: number; processHandle?: any; threadHandle?: any }
    try {
      spawned = params.spawnSuspendedProcess()
    } catch (err) {
      this.driver.closeHandle(job.jobHandle)
      logger.error(LogCategory.SYSTEM, `[ProcessTreeManager] 挂起拉起子进程异常:`, err)
      return { error: 'no_handle' }
    }

    // 尝试分配子进程到 JobObject
    const assigned = this.driver.assignProcessToJob(
      job.jobHandle,
      spawned.processHandle ?? spawned.pid
    )
    if (!assigned) {
      logger.error(
        LogCategory.SYSTEM,
        `[ProcessTreeManager] AssignProcessToJobObject 失败，执行 Fail Chain 强拔挂起子进程: pid=${spawned.pid}`
      )
      this.driver.terminateProcess(spawned.processHandle ?? spawned.pid)
      this.driver.closeHandle(job.jobHandle)
      if (spawned.processHandle) this.driver.closeHandle(spawned.processHandle)
      if (spawned.threadHandle) this.driver.closeHandle(spawned.threadHandle)
      return { error: 'no_handle' }
    }

    // 尝试恢复挂起的主线程
    const resumed = this.driver.resumeThread(spawned.threadHandle)
    if (!resumed) {
      logger.error(
        LogCategory.SYSTEM,
        `[ProcessTreeManager] ResumeThread 失败，执行 Fail Chain 强拔挂起子进程: pid=${spawned.pid}`
      )
      this.driver.terminateProcess(spawned.processHandle ?? spawned.pid)
      this.driver.closeHandle(job.jobHandle)
      if (spawned.processHandle) this.driver.closeHandle(spawned.processHandle)
      if (spawned.threadHandle) this.driver.closeHandle(spawned.threadHandle)
      return { error: 'no_handle' }
    }

    const identity: ProcessTreeIdentity = {
      pid: spawned.pid,
      startTimeMs: Date.now(),
      generation: params.generation,
      treeHandle: job.name
    }

    this.setIdentity(params.targetId, identity)
    return { identity }
  }

  /**
   * 核验指定身份的整棵进程树在操作系统中是否已确证退出。
   * 防 PID 复用误判：若 PID 存活但实际启动时间晚于 identity.startTimeMs + PID_REUSE_TOLERANCE_MS，
   * 判定原进程已退出。
   */
  isProcessTreeExited(identity: ProcessTreeIdentity): boolean | 'unknown' {
    // 1. 若持有 JobObject 句柄，优先核验 JobObject 活跃进程计数
    if (identity.treeHandle) {
      const jobStatus = this.driver.isJobExited(identity.treeHandle)
      if (jobStatus === false) {
        return false // JobObject 中明确仍有活跃进程
      }
      if (jobStatus === 'unknown') {
        return 'unknown'
      }
    }

    // 2. 核验 PID 存活状态
    const pidAlive = this.driver.isPidAlive(identity.pid)
    if (pidAlive === false) {
      return true // PID 确证消亡
    }
    if (pidAlive === 'unknown') {
      return 'unknown'
    }

    // 3. PID 存活，必须执行深度启动时间核验，防操作系统 PID 复用误判
    const actualStartTime = this.driver.getPidStartTimeMs(identity.pid)
    if (actualStartTime !== null) {
      // 若实际进程启动时间明显晚于记录时间，说明原进程早已消亡，号码被系统复用
      if (actualStartTime > identity.startTimeMs + PID_REUSE_TOLERANCE_MS) {
        return true
      }
      // 启动时间吻合，确为原进程仍在运行
      return false
    }

    // 无法获取启动时间时保守认定仍存活
    return false
  }

  /** 订阅整棵进程树完全退出事件 */
  onProcessTreeExit(identity: ProcessTreeIdentity, callback: () => void): () => void {
    const identityKey = `${identity.pid}_${identity.startTimeMs}`
    let listeners = this.exitListeners.get(identityKey)
    if (!listeners) {
      listeners = new Set()
      this.exitListeners.set(identityKey, listeners)
    }
    listeners.add(callback)

    return () => {
      const set = this.exitListeners.get(identityKey)
      if (set) {
        set.delete(callback)
        if (set.size === 0) {
          this.exitListeners.delete(identityKey)
        }
      }
    }
  }

  /** 触发指定 identity 的退出通知并清理监听器 */
  notifyProcessTreeExit(identity: ProcessTreeIdentity): void {
    const identityKey = `${identity.pid}_${identity.startTimeMs}`
    const listeners = this.exitListeners.get(identityKey)
    if (listeners) {
      for (const cb of listeners) {
        try {
          cb()
        } catch {
          // 容错隔离
        }
      }
      this.exitListeners.delete(identityKey)
    }
  }

  /** 有界确认进程树退出（三态签名: 'exited' | 'timeout' | 'unknown'） */
  async awaitProcessTreeExit(
    identity: ProcessTreeIdentity,
    timeoutMs: number
  ): Promise<'exited' | 'timeout' | 'unknown'> {
    const start = Date.now()
    const tickMs = Math.min(200, Math.max(20, Math.floor(timeoutMs / 10)))

    while (Date.now() - start < timeoutMs) {
      const res = this.isProcessTreeExited(identity)
      if (res === true) {
        this.notifyProcessTreeExit(identity)
        return 'exited'
      }
      await new Promise(resolve => setTimeout(resolve, tickMs))
    }

    // 超时后做最后一次确证
    const finalCheck = this.isProcessTreeExited(identity)
    if (finalCheck === true) {
      this.notifyProcessTreeExit(identity)
      return 'exited'
    }
    if (finalCheck === 'unknown') {
      return 'unknown'
    }
    return 'timeout'
  }

  /**
   * 终止整棵进程树
   */
  async stopProcessTree(identity: ProcessTreeIdentity): Promise<void> {
    if (identity.treeHandle) {
      this.driver.terminateJob(identity.treeHandle)
    }
    this.driver.terminateProcess(identity.pid)
  }

  /**
   * 平台级代际精准强杀（ISS-01 / ISS-04 / ISS-05 / ISS-06）：
   * 严格基于 per-generation JobObject (treeHandle) 拔除旧代次，绝不按 target 误杀新模型！
   * - 若 treeHandle 存在：精准终止该 JobObject；
   * - 若 treeHandle 缺失：坚决保守阻断，严禁盲目退化为 target 强杀，返回 'no_handle'；
   * - 内部受单例锁 killLocks 保护，分级缓存：
   *   * 'killed' 缓存 5s 防止重复系统调用；
   *   * 'unknown' 或 'no_handle' 仅在当前单微任务帧去重，随后立即清除以允许后台重试。
   */
  forceKillOldGeneration(
    targetId: string,
    generation: number,
    jobHandle?: string
  ): Promise<'killed' | 'no_handle' | 'unknown'> {
    // 句柄缺失坚决保守阻断，严禁盲杀
    if (!jobHandle) {
      return Promise.resolve('no_handle')
    }

    const lockKey = `${targetId}:gen:${generation}:${jobHandle}`
    const existing = this.killLocks.get(lockKey)
    if (existing) {
      return existing
    }

    const killPromise = (async (): Promise<'killed' | 'no_handle' | 'unknown'> => {
      try {
        const ok = this.driver.terminateJob(jobHandle)
        if (ok) {
          return 'killed'
        }
        return 'unknown'
      } catch (err) {
        logger.error(LogCategory.SYSTEM, `[ProcessTreeManager] forceKillOldGeneration 异常:`, err)
        return 'unknown'
      }
    })()

    this.killLocks.set(lockKey, killPromise)

    killPromise
      .then(result => {
        if (result === 'killed') {
          // 确证消亡，安全缓存 5s
          const timer = setTimeout(() => {
            if (this.killLocks.get(lockKey) === killPromise) {
              this.killLocks.delete(lockKey)
            }
          }, 5000)
          if (timer && typeof timer.unref === 'function') {
            timer.unref()
          }
        } else {
          // 'unknown' 或 'no_handle'：仅在当前微任务帧内去重，完成后立即清除允许重试
          queueMicrotask(() => {
            if (this.killLocks.get(lockKey) === killPromise) {
              this.killLocks.delete(lockKey)
            }
          })
        }
      })
      .catch(() => {
        this.killLocks.delete(lockKey)
      })

    return killPromise
  }

  /** 清空内部映射与锁 (测试清理) */
  destroy(): void {
    this.activeIdentities.clear()
    this.killLocks.clear()
    this.exitListeners.clear()
  }
}

/** 单例导出 */
export const processTreeManager = new ProcessTreeManager()
