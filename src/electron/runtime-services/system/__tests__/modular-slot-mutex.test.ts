import { describe, it, expect } from 'vitest'
import { ModularResourceService } from '../modular-resource-service'

describe('ModularResourceService withSlotMutex 并发锁与防内存泄漏测试 (Spec §3.1)', () => {
  it('并发 100 次切换严格串行执行且执行完毕后 slotLocks 完全清空 (size === 0)', async () => {
    const service = new ModularResourceService()
    const executionOrder: number[] = []

    // 并发派发 100 个互斥任务
    const promises = Array.from({ length: 100 }, (_, i) =>
      service.withSlotMutex('voice_tts', async () => {
        // 微小异步延迟，模拟数据库写事务与平滑进程关停
        await new Promise(resolve => setTimeout(resolve, 2))
        executionOrder.push(i)
        return i
      })
    )

    const results = await Promise.all(promises)

    // 验证结果数量与严格串行顺序
    expect(results.length).toBe(100)
    expect(executionOrder.length).toBe(100)
    for (let i = 0; i < 100; i++) {
      expect(executionOrder[i]).toBe(i)
      expect(results[i]).toBe(i)
    }

    // 关键断言 (Spec 验收契约): 执行完毕后 Map 清空，零内存泄漏
    const slotLocksMap = (service as any).slotLocks as Map<string, unknown>
    expect(slotLocksMap.size).toBe(0)
  })

  it('任务中途抛错不阻塞后续任务执行，且锁正常释放', async () => {
    const service = new ModularResourceService()
    const executionOrder: string[] = []

    const p1 = service.withSlotMutex('voice_tts', async () => {
      await new Promise(resolve => setTimeout(resolve, 2))
      executionOrder.push('task1')
      throw new Error('TASK1_FAILED')
    })

    const p2 = service.withSlotMutex('voice_tts', async () => {
      await new Promise(resolve => setTimeout(resolve, 2))
      executionOrder.push('task2')
      return 'task2_success'
    })

    await expect(p1).rejects.toThrow('TASK1_FAILED')
    const res2 = await p2

    expect(res2).toBe('task2_success')
    expect(executionOrder).toEqual(['task1', 'task2'])

    const slotLocksMap = (service as any).slotLocks as Map<string, unknown>
    expect(slotLocksMap.size).toBe(0)
  })
})
