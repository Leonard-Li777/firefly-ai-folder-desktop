// @vitest-environment node

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@firefly/shared', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  },
  LogCategory: { SYSTEM: 'SYSTEM' }
}))

import {
  runShutdownSequence,
  runShutdownSequenceWithOverallTimeout,
  type ShutdownCapabilities
} from '../shutdown-coordinator'

/** 构造全部成功的关停能力 */
function makeOkCaps(overrides: Partial<ShutdownCapabilities> = {}): ShutdownCapabilities {
  return {
    checkpointWal: vi.fn().mockResolvedValue({ busy: false }),
    stopOmni: vi.fn().mockResolvedValue(undefined),
    stopLlamaServer: vi.fn().mockResolvedValue(undefined),
    stopLibreOffice: vi.fn().mockResolvedValue(undefined),
    reapProcesses: vi.fn().mockResolvedValue(undefined),
    ...overrides
  }
}

describe('ShutdownCoordinator · 工单 03/07 P0-6 失败语义表', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('全部成功 → canProceed=true，四步按顺序执行', async () => {
    const callOrder: string[] = []
    const caps = makeOkCaps({
      checkpointWal: vi.fn().mockImplementation(async () => {
        callOrder.push('checkpointWal')
        return { busy: false }
      }),
      stopOmni: vi.fn().mockImplementation(async () => {
        callOrder.push('stopOmni')
      }),
      stopLlamaServer: vi.fn().mockImplementation(async () => {
        callOrder.push('stopLlamaServer')
      }),
      reapProcesses: vi.fn().mockImplementation(async () => {
        callOrder.push('reapProcesses')
      })
    })

    const outcome = await runShutdownSequence(caps)
    expect(outcome.canProceed).toBe(true)
    expect(outcome.blockedBy).toEqual([])
    expect(callOrder).toEqual(['checkpointWal', 'stopOmni', 'stopLlamaServer', 'reapProcesses'])
  })

  it('WAL busy → 重试一次成功 → 继续（busy-recovered）', async () => {
    let calls = 0
    const checkpointWal = vi.fn().mockImplementation(async () => {
      calls += 1
      return { busy: calls === 1 } // 第一次 busy，重试成功
    })
    const caps = makeOkCaps({ checkpointWal })

    const outcome = await runShutdownSequence(caps)
    expect(outcome.canProceed).toBe(true)
    expect(checkpointWal).toHaveBeenCalledTimes(2)
    const walResult = outcome.results.find(r => r.step === 'checkpointWal')
    expect(walResult?.ok).toBe(true)
    expect(walResult?.reason).toBe('busy-recovered')
  })

  it('WAL busy → 重试仍 busy → warn 继续（WAL 崩溃安全，不阻断）', async () => {
    const checkpointWal = vi.fn().mockResolvedValue({ busy: true })
    const caps = makeOkCaps({ checkpointWal })

    const outcome = await runShutdownSequence(caps)
    expect(outcome.canProceed).toBe(true) // busy 不阻断
    expect(checkpointWal).toHaveBeenCalledTimes(2)
    const walResult = outcome.results.find(r => r.step === 'checkpointWal')
    expect(walResult?.reason).toBe('busy-after-retry')
  })

  it('WAL 抛异常 → 阻断，不执行后续步骤', async () => {
    const stopOmni = vi.fn().mockResolvedValue(undefined)
    const caps = makeOkCaps({
      checkpointWal: vi.fn().mockRejectedValue(new Error('db locked unexpected')),
      stopOmni
    })

    const outcome = await runShutdownSequence(caps)
    expect(outcome.canProceed).toBe(false)
    expect(outcome.blockedBy).toContain('checkpointWal')
    expect(stopOmni).not.toHaveBeenCalled() // 阻断后不推进
  })

  it('omniService.stop() 失败 → 阻断，不调用后续 reap', async () => {
    const reapProcesses = vi.fn().mockResolvedValue(undefined)
    const caps = makeOkCaps({
      stopOmni: vi.fn().mockRejectedValue(new Error('omni stop timeout')),
      reapProcesses
    })

    const outcome = await runShutdownSequence(caps)
    expect(outcome.canProceed).toBe(false)
    expect(outcome.blockedBy).toContain('stopOmni')
    expect(reapProcesses).not.toHaveBeenCalled()
  })

  it('omniService.stop() 超时 → 阻断', async () => {
    const caps = makeOkCaps({
      stopOmni: vi.fn().mockImplementation(
        () => new Promise<void>(resolve => setTimeout(resolve, 10_000))
      )
    })

    const outcome = await runShutdownSequence(caps, 50) // 极短超时触发
    expect(outcome.canProceed).toBe(false)
    expect(outcome.blockedBy).toContain('stopOmni')
  })

  it('libreoffice 停机失败 → warn 继续（非关键，不阻断）', async () => {
    const caps = makeOkCaps({
      stopLibreOffice: vi.fn().mockRejectedValue(new Error('libreoffice kill failed'))
    })

    const outcome = await runShutdownSequence(caps)
    expect(outcome.canProceed).toBe(true)
    const loResult = outcome.results.find(r => r.step === 'stopLibreOffice')
    expect(loResult?.ok).toBe(true) // 非关键继续
    expect(loResult?.blocking).toBe(false)
  })

  it('ProcessReaper 失败 → warn 继续（安装器查杀兜底）', async () => {
    const caps = makeOkCaps({
      reapProcesses: vi.fn().mockRejectedValue(new Error('reaper partial'))
    })

    const outcome = await runShutdownSequence(caps)
    expect(outcome.canProceed).toBe(true)
    const reapResult = outcome.results.find(r => r.step === 'reapProcesses')
    expect(reapResult?.ok).toBe(true)
  })

  it('整体超时兜底 → 返回阻断结果', async () => {
    const outcome = await runShutdownSequenceWithOverallTimeout(
      makeOkCaps(),
      () => new Promise<ReturnType<typeof runShutdownSequence>>(resolve =>
        setTimeout(() => resolve({ canProceed: true, results: [], blockedBy: [] }), 10_000)
      ),
      50
    )
    expect(outcome.canProceed).toBe(false)
    expect(outcome.blockedBy).toEqual(['reapProcesses'])
  })
})
