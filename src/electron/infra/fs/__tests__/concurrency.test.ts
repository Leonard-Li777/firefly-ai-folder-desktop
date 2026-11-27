import { describe, it, expect } from 'vitest'
import { mapLimit, createLimiter, DEFAULT_CONCURRENCY } from '../concurrency'

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

describe('mapLimit', () => {
  it('结果与输入同序（乱序完成也按原索引回填）', async () => {
    const items = Array.from({ length: 12 }, (_, index) => index)

    const results = await mapLimit(items, 4, async (item, index) => {
      // 越靠后的任务越快完成，制造乱序
      await sleep((items.length - index) * 2)
      return `${index}:${item}`
    })

    expect(results).toEqual(items.map((item, index) => `${index}:${item}`))
  })

  it('并发峰值不超过上限且确实并发执行', async () => {
    let active = 0
    let peak = 0

    await mapLimit(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      active += 1
      peak = Math.max(peak, active)
      await sleep(5)
      active -= 1
      return 0
    })

    expect(peak).toBeLessThanOrEqual(4)
    expect(peak).toBeGreaterThan(1)
  })

  it('空数组立即返回空结果（不派发任务）', async () => {
    const mapper = async (): Promise<number> => 1

    await expect(mapLimit([], 4, mapper)).resolves.toEqual([])
  })

  it('非法并发上限（0 / NaN）收敛为串行，不会挂死', async () => {
    let active = 0
    let peak = 0
    const mapper = async (): Promise<number> => {
      active += 1
      peak = Math.max(peak, active)
      await sleep(1)
      active -= 1
      return 1
    }

    await expect(mapLimit([1, 2, 3], 0, mapper)).resolves.toEqual([1, 1, 1])
    expect(peak).toBe(1)

    peak = 0
    await expect(mapLimit([1, 2, 3], Number.NaN, mapper)).resolves.toEqual([1, 1, 1])
    expect(peak).toBe(1)
  })

  it('默认上限与 spec §5.1 一致（32）', () => {
    expect(DEFAULT_CONCURRENCY).toBe(32)
  })

  it('任务失败时停止派发新任务，等在途任务收敛后再抛出首个错误', async () => {
    const startedIndices: number[] = []
    const settledIndices: number[] = []
    const total = 10

    const run = mapLimit(Array.from({ length: total }, (_, i) => i), 2, async (_item, index) => {
      startedIndices.push(index)
      await sleep(5)
      settledIndices.push(index)
      if (index === 1) throw new Error('boom')
      return index
    })

    await expect(run).rejects.toThrow('boom')
    // 失败后不再把全部任务派发出去
    expect(startedIndices.length).toBeLessThan(total)
    // 抛出时在途任务已经收敛：不存在「已抛错但磁盘写还在飞」
    expect(settledIndices.sort((a, b) => a - b)).toEqual([...startedIndices].sort((a, b) => a - b))
  })
})

describe('createLimiter', () => {
  it('并发峰值受限于上限，任务按 FIFO 顺序开始', async () => {
    const limiter = createLimiter(2)
    let active = 0
    let peak = 0
    const startOrder: number[] = []

    const tasks = Array.from({ length: 6 }, (_, index) =>
      limiter(async () => {
        startOrder.push(index)
        active += 1
        peak = Math.max(peak, active)
        await sleep(5)
        active -= 1
        return index
      })
    )

    await expect(Promise.all(tasks)).resolves.toEqual([0, 1, 2, 3, 4, 5])
    expect(peak).toBeLessThanOrEqual(2)
    expect(startOrder).toEqual([0, 1, 2, 3, 4, 5])
  })

  it('单个任务失败不泄漏并发位（后续任务仍能执行）', async () => {
    const limiter = createLimiter(1)

    await expect(limiter(async () => Promise.reject(new Error('first-fails')))).rejects.toThrow(
      'first-fails'
    )
    await expect(limiter(async () => 'ok')).resolves.toBe('ok')
  })

  it('任务同步抛错也归还并发位', async () => {
    const limiter = createLimiter(1)

    await expect(
      limiter(() => {
        throw new Error('sync-throw')
      })
    ).rejects.toThrow('sync-throw')
    await expect(limiter(async () => 'ok')).resolves.toBe('ok')
  })
})
