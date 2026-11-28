import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { logger } from '@firefly/shared'
import { runTaskkillAsync, setTaskkillSpawnForTest } from '../../../main/process-reaper'
import { DefaultPlatformProcessTreeDriver } from '../process-tree-manager'
import { PluginProcessManager } from '../../system/plugin-process-manager'

function createFakeChild() {
  const child = new EventEmitter() as EventEmitter & { kill: ReturnType<typeof vi.fn> }
  child.kill = vi.fn()
  return child
}

describe('P1-5 taskkill 异步化 (Ticket 11)', () => {
  afterEach(() => {
    setTaskkillSpawnForTest(null)
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('runTaskkillAsync 正确传递 /T 参数与不设默认超时', async () => {
    const child = createFakeChild()
    const spawnSpy = vi.fn().mockReturnValue(child as any)
    setTaskkillSpawnForTest(spawnSpy)

    const promise = runTaskkillAsync(1234, { tree: true })
    expect(spawnSpy).toHaveBeenCalledWith(
      'taskkill',
      ['/F', '/T', '/PID', '1234'],
      expect.objectContaining({ windowsHide: true, stdio: 'ignore' })
    )
    child.emit('close', 0)
    const res = await promise
    expect(res).toEqual({ exitCode: 0, timedOut: false, error: null })
  })

  it('DefaultPlatformProcessTreeDriver.terminateProcess 覆盖 exit 0 / 128 / 失败与超时 warn', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const spawnSpy = vi.fn()
    setTaskkillSpawnForTest(spawnSpy)
    const driver = new DefaultPlatformProcessTreeDriver()
    vi.spyOn(driver, 'isWindows').mockReturnValue(true)

    // 1. exit 0 -> true
    const c1 = createFakeChild()
    spawnSpy.mockReturnValueOnce(c1 as any)
    const p1 = driver.terminateProcess(1001)
    c1.emit('close', 0)
    expect(await p1).toBe(true)

    // 2. exit 128 -> true
    const c2 = createFakeChild()
    spawnSpy.mockReturnValueOnce(c2 as any)
    const p2 = driver.terminateProcess(1002)
    c2.emit('close', 128)
    expect(await p2).toBe(true)

    // 3. exit 1 -> false
    const c3 = createFakeChild()
    spawnSpy.mockReturnValueOnce(c3 as any)
    const p3 = driver.terminateProcess(1003)
    c3.emit('close', 1)
    expect(await p3).toBe(false)

    // 4. error -> false + logger.warn
    const c4 = createFakeChild()
    spawnSpy.mockReturnValueOnce(c4 as any)
    const p4 = driver.terminateProcess(1004)
    c4.emit('error', new Error('EPERM'))
    expect(await p4).toBe(false)
    expect(warnSpy).toHaveBeenCalled()
  })

  it('PluginProcessManager.stopProcess 在强杀失败时仅记 warn 且不阻塞后续 retire', async () => {
    vi.useFakeTimers()
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })

    try {
      const c = createFakeChild()
      const spawnSpy = vi.fn().mockReturnValueOnce(c as any)
      setTaskkillSpawnForTest(spawnSpy)

      const fakeHost = {
        pid: 9876,
        retire: () => new Promise<void>(() => {}) // 永不 resolve，触发 3000ms 超时
      }
      const manager = new PluginProcessManager({
        hostManager: {
          getHost: () => fakeHost as any
        } as any
      })

      const stopPromise = manager.stopProcess('mod-1')
      // 推进 3000ms 触发 retire 超时
      await vi.advanceTimersByTimeAsync(3000)
      // 模拟 taskkill 非 0 失败
      c.emit('close', 1)
      // 推进 200ms 句柄避让
      await vi.advanceTimersByTimeAsync(200)

      await expect(stopPromise).resolves.toBeUndefined()
      expect(spawnSpy).toHaveBeenCalledWith(
        'taskkill',
        ['/F', '/T', '/PID', '9876'],
        expect.anything()
      )
      expect(warnSpy).toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })
})
