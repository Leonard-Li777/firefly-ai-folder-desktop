import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  formatJobObjectName,
  IPlatformProcessTreeDriver,
  PID_REUSE_TOLERANCE_MS,
  ProcessTreeManager
} from '../process-tree-manager'

class MockProcessTreeDriver implements IPlatformProcessTreeDriver {
  isWin = true
  createJobShouldFail = false
  assignJobShouldFail = false
  resumeThreadShouldFail = false
  terminateJobResult = true

  createdJobs: string[] = []
  assignedProcesses: Array<{ jobHandle: any; processHandle: any }> = []
  terminatedProcesses: any[] = []
  terminatedJobs: any[] = []
  closedHandles: any[] = []

  pidAliveMap = new Map<number, boolean | 'unknown'>()
  pidStartTimeMap = new Map<number, number | null>()
  jobExitedMap = new Map<string, boolean | 'unknown'>()

  isWindows(): boolean {
    return this.isWin
  }

  createJobObject(name: string): { jobHandle: any; name: string } | null {
    if (this.createJobShouldFail) return null
    this.createdJobs.push(name)
    return { jobHandle: `handle_${name}`, name }
  }

  assignProcessToJob(jobHandle: any, processHandle: any): boolean {
    if (this.assignJobShouldFail) return false
    this.assignedProcesses.push({ jobHandle, processHandle })
    return true
  }

  resumeThread(_threadHandle: any): boolean {
    return !this.resumeThreadShouldFail
  }

  terminateProcess(processHandle: any, _exitCode?: number): boolean {
    this.terminatedProcesses.push(processHandle)
    return true
  }

  terminateJob(jobHandleOrName: any): boolean {
    this.terminatedJobs.push(jobHandleOrName)
    return this.terminateJobResult
  }

  closeHandle(handle: any): void {
    this.closedHandles.push(handle)
  }

  isJobExited(jobHandleOrName: any): boolean | 'unknown' {
    const name = typeof jobHandleOrName === 'string' ? jobHandleOrName : jobHandleOrName?.name
    return this.jobExitedMap.get(name) ?? true
  }

  isPidAlive(pid: number): boolean | 'unknown' {
    return this.pidAliveMap.get(pid) ?? false
  }

  getPidStartTimeMs(pid: number): number | null {
    return this.pidStartTimeMap.get(pid) ?? null
  }
}

describe('ProcessTreeManager (Ticket 02)', () => {
  let driver: MockProcessTreeDriver
  let manager: ProcessTreeManager

  beforeEach(() => {
    vi.useFakeTimers()
    driver = new MockProcessTreeDriver()
    manager = new ProcessTreeManager({ driver })
  })

  afterEach(() => {
    manager.destroy()
    vi.useRealTimers()
  })

  describe('Windows JobObject 命名与 Sanitize', () => {
    it('正确过滤非法字符并遵循规范命名格式', () => {
      const name = formatJobObjectName('firefly-ai-engine:local', 1, 'uuid123')
      expect(name).toBe('Firefly_Job_firefly-ai-engine_local_gen_1_uuid123')

      const name2 = formatJobObjectName('pocket/cpu/int8', 2, 'abc')
      expect(name2).toBe('Firefly_Job_pocket_cpu_int8_gen_2_abc')
    })
  })

  describe('JobObject 原子创建与完整失败链 (Fail Chain)', () => {
    it('正常流程：成功创建 JobObject、挂载并唤醒子进程', () => {
      const res = manager.createProcessTreeWithFailChain({
        targetId: 'firefly-ai-engine',
        generation: 1,
        spawnSuspendedProcess: () => ({
          pid: 1234,
          processHandle: 'proc_1234',
          threadHandle: 'thread_1234'
        })
      })

      expect('identity' in res).toBe(true)
      if ('identity' in res) {
        expect(res.identity.pid).toBe(1234)
        expect(res.identity.generation).toBe(1)
        expect(res.identity.treeHandle).toContain('Firefly_Job_firefly-ai-engine_gen_1')
      }
      expect(driver.assignedProcesses).toHaveLength(1)
      expect(driver.terminatedProcesses).toHaveLength(0)
    })

    it('Fail Chain：若 assignProcessToJob 失败，立即强拔挂起子进程并释放所有句柄返回 no_handle', () => {
      driver.assignJobShouldFail = true

      const res = manager.createProcessTreeWithFailChain({
        targetId: 'firefly-ai-engine',
        generation: 1,
        spawnSuspendedProcess: () => ({
          pid: 5678,
          processHandle: 'proc_5678',
          threadHandle: 'thread_5678'
        })
      })

      expect(res).toEqual({ error: 'no_handle' })
      expect(driver.terminatedProcesses).toContain('proc_5678')
      // 必须完整关闭 JobObject 句柄、进程句柄与主线程句柄 (防内核句柄泄漏)
      expect(driver.closedHandles).toHaveLength(3)
      expect(driver.closedHandles).toContain('proc_5678')
      expect(driver.closedHandles).toContain('thread_5678')
    })

    it('Fail Chain：若 resumeThread 失败，立即强拔挂起子进程并释放所有句柄返回 no_handle', () => {
      driver.resumeThreadShouldFail = true

      const res = manager.createProcessTreeWithFailChain({
        targetId: 'firefly-ai-engine',
        generation: 1,
        spawnSuspendedProcess: () => ({
          pid: 9999,
          processHandle: 'proc_9999',
          threadHandle: 'thread_9999'
        })
      })

      expect(res).toEqual({ error: 'no_handle' })
      expect(driver.terminatedProcesses).toContain('proc_9999')
      expect(driver.closedHandles).toHaveLength(3)
      expect(driver.closedHandles).toContain('proc_9999')
      expect(driver.closedHandles).toContain('thread_9999')
    })
  })

  describe('平台代际精准强杀与 killLocks 分级缓存', () => {
    it('若 jobHandle 缺失，坚决保守阻断并返回 no_handle，绝不盲杀', async () => {
      const res = await manager.forceKillOldGeneration('firefly-ai-engine', 1, undefined)
      expect(res).toBe('no_handle')
      expect(driver.terminatedJobs).toHaveLength(0)
    })

    it('提供合法 jobHandle 时精准终止旧代次 JobObject', async () => {
      const res = await manager.forceKillOldGeneration(
        'firefly-ai-engine',
        1,
        'Firefly_Job_test_gen_1'
      )
      expect(res).toBe('killed')
      expect(driver.terminatedJobs).toContain('Firefly_Job_test_gen_1')
    })

    it('killLocks 分级缓存：killed 决议缓存 5s 避免重复系统调用', async () => {
      const p1 = manager.forceKillOldGeneration('firefly-ai-engine', 1, 'Firefly_Job_test_gen_1')
      const p2 = manager.forceKillOldGeneration('firefly-ai-engine', 1, 'Firefly_Job_test_gen_1')

      expect(p1).toBe(p2) // 命中并发锁合并
      await p1
      expect(driver.terminatedJobs).toHaveLength(1)

      // 在 5s 缓存期内重复调用，依然复用已 resolve 的 Promise
      const p3 = manager.forceKillOldGeneration('firefly-ai-engine', 1, 'Firefly_Job_test_gen_1')
      expect(p3).toBe(p1)
      expect(driver.terminatedJobs).toHaveLength(1)

      // 超过 5s 缓存过期
      vi.advanceTimersByTime(5_100)
      const p4 = manager.forceKillOldGeneration('firefly-ai-engine', 1, 'Firefly_Job_test_gen_1')
      expect(p4).not.toBe(p1)
      await p4
      expect(driver.terminatedJobs).toHaveLength(2)
    })

    it('killLocks 分级缓存：unknown 或失败决议仅在单微任务帧去重，随后立即清除', async () => {
      driver.terminateJobResult = false // 模拟终止失败

      const p1 = manager.forceKillOldGeneration('firefly-ai-engine', 1, 'Firefly_Job_test_unknown')
      const res1 = await p1
      expect(res1).toBe('unknown')

      // 在微任务执行后立即重试，锁已清除，允许重试
      await Promise.resolve()
      const p2 = manager.forceKillOldGeneration('firefly-ai-engine', 1, 'Firefly_Job_test_unknown')
      expect(p2).not.toBe(p1)
      await p2
      expect(driver.terminatedJobs).toHaveLength(2)
    })
  })

  describe('进程树退出核验与 PID 复用防误判 (isProcessTreeExited)', () => {
    it('PID 确证消亡时判定为 true (已退出)', () => {
      driver.pidAliveMap.set(1234, false)
      const identity = {
        pid: 1234,
        startTimeMs: 100_000,
        generation: 1
      }
      expect(manager.isProcessTreeExited(identity)).toBe(true)
    })

    it('PID 存活且启动时间吻合，判定为 false (未退出)', () => {
      driver.pidAliveMap.set(1234, true)
      driver.pidStartTimeMap.set(1234, 100_500) // 容差 500ms < 60s
      const identity = {
        pid: 1234,
        startTimeMs: 100_000,
        generation: 1
      }
      expect(manager.isProcessTreeExited(identity)).toBe(false)
    })

    it('PID 复用防误判：PID 存活但实际启动时间晚于记录时间 60s，判定为原进程已退出', () => {
      driver.pidAliveMap.set(1234, true)
      // 实际启动时间晚了 10 分钟，说明该 PID 是系统回收后分配给新进程的
      driver.pidStartTimeMap.set(1234, 100_000 + PID_REUSE_TOLERANCE_MS + 600_000)
      const identity = {
        pid: 1234,
        startTimeMs: 100_000,
        generation: 1
      }
      expect(manager.isProcessTreeExited(identity)).toBe(true)
    })
  })

  describe('有界等待进程树退出 (awaitProcessTreeExit)', () => {
    it('进程确认退出时返回 exited 并触发 onProcessTreeExit 监听回调', async () => {
      const identity = {
        pid: 2222,
        startTimeMs: 100_000,
        generation: 1
      }
      driver.pidAliveMap.set(2222, true)
      driver.pidStartTimeMap.set(2222, 100_000)

      let notified = false
      manager.onProcessTreeExit(identity, () => {
        notified = true
      })

      const waitPromise = manager.awaitProcessTreeExit(identity, 3_000)

      // 模拟 100ms 后进程退出
      driver.pidAliveMap.set(2222, false)
      vi.advanceTimersByTime(200)

      const result = await waitPromise
      expect(result).toBe('exited')
      expect(notified).toBe(true)
    })

    it('超时未退出返回 timeout', async () => {
      const identity = {
        pid: 3333,
        startTimeMs: 100_000,
        generation: 1
      }
      driver.pidAliveMap.set(3333, true)
      driver.pidStartTimeMap.set(3333, 100_000)

      const waitPromise = manager.awaitProcessTreeExit(identity, 1_000)
      vi.advanceTimersByTime(1_500)

      const result = await waitPromise
      expect(result).toBe('timeout')
    })
  })
})
