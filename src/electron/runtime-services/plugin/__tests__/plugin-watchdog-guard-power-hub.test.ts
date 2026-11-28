/**
 * Ticket TM-W6: PluginWatchdogGuard PowerEventHub 退订与失败告警回归测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../../main/power-hub', () => ({
  subscribePowerEvent: vi.fn()
}))

import { PluginWatchdogGuard } from '../plugin-watchdog-guard'
import { subscribePowerEvent } from '../../../main/power-hub'

describe('PluginWatchdogGuard PowerEventHub lifecycle (TM-W6)', () => {
  const guards: PluginWatchdogGuard[] = []

  beforeEach(() => {
    vi.mocked(subscribePowerEvent).mockReset()
  })

  afterEach(() => {
    for (const g of guards.splice(0)) {
      g.dispose()
    }
    vi.restoreAllMocks()
  })

  it('无自定义 powerMonitor 时订阅 PowerEventHub，dispose() 正确退订且不泄漏', () => {
    const unsubSpy = vi.fn()
    vi.mocked(subscribePowerEvent).mockReturnValue(unsubSpy)
    const warnSpy = vi.fn()

    const guard = new PluginWatchdogGuard({
      logger: { info: vi.fn(), warn: warnSpy, error: vi.fn() }
    })
    guards.push(guard)

    expect(subscribePowerEvent).toHaveBeenCalledWith(
      'resume',
      expect.any(Function),
      expect.objectContaining({ id: 'plugin-watchdog-guard', resumeOffsetMs: 1200 })
    )
    expect(warnSpy).not.toHaveBeenCalled()

    guard.dispose()
    expect(unsubSpy).toHaveBeenCalledTimes(1)

    // 重复 dispose 幂等，不重复调用退订
    guard.dispose()
    expect(unsubSpy).toHaveBeenCalledTimes(1)
  })

  it('bindPowerMonitor 切换事件源时先退订旧的 PowerEventHub 监听', () => {
    const unsubSpy = vi.fn()
    vi.mocked(subscribePowerEvent).mockReturnValue(unsubSpy)

    const guard = new PluginWatchdogGuard({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    })
    guards.push(guard)

    const customMonitor = {
      on: vi.fn(),
      removeListener: vi.fn()
    }
    guard.bindPowerMonitor(customMonitor)

    expect(unsubSpy).toHaveBeenCalledTimes(1)
    expect(customMonitor.on).toHaveBeenCalledWith('resume', expect.any(Function))

    guard.dispose()
    expect(customMonitor.removeListener).toHaveBeenCalledWith('resume', expect.any(Function))
  })

  it('PowerEventHub 订阅失败时通过 logger.warn 显式上报而非静默吞错', () => {
    vi.mocked(subscribePowerEvent).mockImplementation(() => {
      throw new Error('mock power hub unavailable')
    })
    const warnSpy = vi.fn()

    const guard = new PluginWatchdogGuard({
      logger: { info: vi.fn(), warn: warnSpy, error: vi.fn() }
    })
    guards.push(guard)

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('PowerEventHub'),
      expect.any(Error)
    )
  })

  it('PowerEventHub 退订抛错时显式告警且不中断 dispose', () => {
    vi.mocked(subscribePowerEvent).mockReturnValue(() => {
      throw new Error('mock unsubscribe failure')
    })
    const warnSpy = vi.fn()

    const guard = new PluginWatchdogGuard({
      logger: { info: vi.fn(), warn: warnSpy, error: vi.fn() }
    })
    guards.push(guard)

    expect(() => guard.dispose()).not.toThrow()
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('退订 PowerEventHub'),
      expect.any(Error)
    )
  })
})
