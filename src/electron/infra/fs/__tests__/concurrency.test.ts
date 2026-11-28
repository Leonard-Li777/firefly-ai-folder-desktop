import { describe, it, expect, vi } from 'vitest'
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

  it('入口已 aborted 的 AbortSignal：零任务启动并直接抛 AbortError', async () => {
    const controller = new AbortController()
    controller.abort('pre-cancelled')
    const mapper = vi.fn(async (item: number) => item * 2)

    await expect(
      mapLimit([1, 2, 3], 2, mapper, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(mapper).not.toHaveBeenCalled()

    await expect(
      mapLimit([], 2, mapper, { signal: controller.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('执行中途 abort 后停止新任务派发，并等全部在途任务落定后再抛 AbortError（无在途泄漏）', async () => {
    const controller = new AbortController()
    const total = 10
    const startedIndices: number[] = []
    const settledIndices: number[] = []
    let activeCount = 0

    const run = mapLimit(
      Array.from({ length: total }, (_, i) => i),
      2,
      async (_item, index) => {
        startedIndices.push(index)
        activeCount += 1
        await sleep(10)
        if (index === 0) {
          controller.abort()
        }
        await sleep(10)
        activeCount -= 1
        settledIndices.push(index)
        return index
      },
      { signal: controller.signal }
    )

    let caughtError: unknown
    try {
      await run
    } catch (error) {
      caughtError = error
    }

    expect(caughtError).toBeInstanceOf(Error)
    expect((caughtError as Error).name).toBe('AbortError')
    // 停止派发新索引
    expect(startedIndices.length).toBeLessThan(total)
    // 抛出时全部在途任务均已收敛，无仍在飞任务
    expect(activeCount).toBe(0)
    expect(settledIndices.sort((a, b) => a - b)).toEqual([...startedIndices].sort((a, b) => a - b))
  })

  it('传入未触发的 AbortSignal 时正常完成全部映射', async () => {
    const controller = new AbortController()
    const results = await mapLimit([10, 20, 30], 2, async item => item + 1, {
      signal: controller.signal
    })
    expect(results).toEqual([11, 21, 31])
  })

  it('mapper 抛出 null 时同样停止派发新任务并原样抛出 null', async () => {
    const startedIndices: number[] = []
    const total = 8

    const run = mapLimit(Array.from({ length: total }, (_, i) => i), 2, async (_item, index) => {
      startedIndices.push(index)
      await sleep(5)
      if (index === 0) throw null
      return index
    })

    await expect(run).rejects.toBeNull()
    expect(startedIndices.length).toBeLessThan(total)
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
