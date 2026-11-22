import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockAppState } = vi.hoisted(() => ({
  mockAppState: { userDataDir: '' }
}))

vi.mock('electron', () => ({
  app: {
    on: vi.fn(),
    isReady: vi.fn(() => true),
    whenReady: vi.fn(() => Promise.resolve()),
    getAppPath: vi.fn(() => process.cwd()),
    getPath: vi.fn((name: string) => {
      if (name === 'userData') return mockAppState.userDataDir
      return os.tmpdir()
    })
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => [])
  },
  dialog: {
    showErrorBox: vi.fn(),
    showMessageBox: vi.fn()
  },
  powerMonitor: {
    on: vi.fn()
  },
  shell: {
    openPath: vi.fn()
  }
}))

vi.mock('../../../config/config-orchestrator', () => ({
  ConfigOrchestrator: {
    getInstance: vi.fn(() => ({
      getValue: vi.fn(),
      onValueChange: vi.fn(() => () => {})
    }))
  }
}))

vi.mock('@app/languages', () => ({
  t: (s: string) => s
}))
import {
  DORMANT_MAX_ATTEMPTS,
  SSE_CONNECT_TIMEOUT_MS,
  SSE_READ_WATCHDOG_MS,
  ServiceDiscoveryFile
} from '@firefly/shared'
import { EngineBridgeService } from '../engine-bridge-service/engine-bridge-service'
import type { Tier2EngineStatus } from '../engine-bridge-service/types'

/**
 * 辅助：构造可控的 SSE ReadableStream，允许测试按需推送字节块、空注释帧、EOF 或错误
 */
function createControllableSseStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let cancelled = false
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c
    },
    cancel() {
      cancelled = true
    }
  })

  return {
    stream,
    pushSseData(payload: Tier2EngineStatus) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
    },
    pushKeepAliveComment() {
      controller.enqueue(encoder.encode(`:\n\n`))
    },
    close() {
      controller.close()
    },
    error(err: Error) {
      controller.error(err)
    },
    isCancelled() {
      return cancelled
    }
  }
}

/** 刷新微任务队列，确保异步状态机推进到挂起点 */
async function flushMicrotasks(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
  }
}

describe('EngineBridgeService 零轮询单循环状态机与双阶看门狗 (AC-1 ~ AC-10)', () => {
  let tempUserDataDir: string
  let service: EngineBridgeService | null = null
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    tempUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'firefly-eb-zero-poll-'))
    mockAppState.userDataDir = tempUserDataDir
  })

  afterEach(async () => {
    vi.useRealTimers()
    if (service) {
      await service.stop()
      service = null
    }
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
    try {
      fs.rmSync(tempUserDataDir, { recursive: true, force: true })
    } catch {
      // 忽略 Windows 临时目录释放延迟
    }
  })

  it('AC-1: 定时器预算不变量（Dormant=0, STREAMING=1, Reconnecting<=1）且无周期 setInterval', async () => {
    vi.useFakeTimers()
    const sse = createControllableSseStream()
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/api/engine/events')) {
        return Promise.resolve(new Response(sse.stream, { status: 200 }))
      }
      return Promise.resolve(new Response('{}', { status: 404 }))
    })
    globalThis.fetch = fetchMock as any

    service = EngineBridgeService.createForTest({ userDataPath: tempUserDataDir })
    await flushMicrotasks()

    // 1. 无发现文件时处于 Dormant 态：0 定时器、0 网络请求
    expect(service.getStreamState()).toBe('dormant')
    expect(vi.getTimerCount()).toBe(0)
    expect(fetchMock).not.toHaveBeenCalled()

    // 2. 唤醒建连并推送首帧：进入 STREAMING 态；排空首帧附带的一次性元数据拉取（<=5s AbortSignal.timeout）后，活跃 Timer 恒为 1（仅 35s readWithWatchdog）
    service.kickEventStreamReconnect({ resetFailures: true })
    await flushMicrotasks()
    sse.pushSseData({
      status: 'ready',
      pid: process.pid,
      instance_id: 'inst-ac1',
      revision: 1,
      user_data_dir: tempUserDataDir
    })
    await flushMicrotasks()
    await vi.advanceTimersByTimeAsync(5_500)
    await flushMicrotasks()

    expect(service.getStreamState()).toBe('streaming')
    expect(vi.getTimerCount()).toBe(1)

    // 3. 写入同源存活发现文件并断开当前流，进入 Reconnecting 退避态：活跃 Timer <= 1
    const disc = new ServiceDiscoveryFile({
      fileName: 'engine-config.json',
      serviceId: 'firefly-engine-bridge',
      userDataPath: tempUserDataDir
    })
    await disc.publish({
      instanceId: 'inst-ac1',
      pid: process.pid,
      port: 38400,
      host: '127.0.0.1',
      startedAt: new Date().toISOString(),
      revision: 1,
      userDataDir: tempUserDataDir,
      capabilities: []
    })
    fetchMock.mockImplementation(() => Promise.reject(new Error('ECONNREFUSED')))
    sse.close()
    // 推进 150ms 消化 DirWatcher 的 100ms 防抖定时器，进入纯退避态
    await vi.advanceTimersByTimeAsync(150)
    await flushMicrotasks()

    expect(service.getStreamState()).toBe('reconnecting')
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1)
  })

  it('AC-2: 旧连接延迟返回/抛错绝不覆盖新连接的 ready 状态与 connectedTarget', async () => {
    const sseA = createControllableSseStream()
    const sseB = createControllableSseStream()
    let callCount = 0

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (!String(url).includes('/api/engine/events')) {
        return Promise.resolve(new Response('{}', { status: 404 }))
      }
      callCount++
      if (callCount === 1) {
        return Promise.resolve(new Response(sseA.stream, { status: 200 }))
      }
      return Promise.resolve(new Response(sseB.stream, { status: 200 }))
    }) as any

    service = EngineBridgeService.createForTest({ userDataPath: tempUserDataDir })

    // 建立连接 A
    service.kickEventStreamReconnect({
      expectedTarget: { baseUrl: 'http://127.0.0.1:38400', pid: 1001, instanceId: 'inst-a' },
      resetFailures: true
    })
    await flushMicrotasks()
    sseA.pushSseData({
      status: 'starting',
      pid: 1001,
      instance_id: 'inst-a',
      revision: 1,
      user_data_dir: tempUserDataDir
    })
    await flushMicrotasks()
    expect(service.getConnectedTarget()?.instanceId).toBe('inst-a')

    // 同端口重启：instanceId 变化 -> 抢占建立连接 B（绝不误入 no-op）
    service.kickEventStreamReconnect({
      expectedTarget: { baseUrl: 'http://127.0.0.1:38400', pid: 2002, instanceId: 'inst-b' },
      resetFailures: true
    })
    await flushMicrotasks()

    // 连接 B 率先收到 ready 首帧 (revision: 2)
    sseB.pushSseData({
      status: 'ready',
      pid: 2002,
      instance_id: 'inst-b',
      revision: 2,
      user_data_dir: tempUserDataDir
    })
    await flushMicrotasks()

    // 模拟连接 A 延迟结束/抛错
    try {
      sseA.error(new Error('delayed stale connection error'))
    } catch {
      // stream 可能已被 cancel
    }
    await flushMicrotasks(12)

    // 断言连接 B 状态、目标三元组与在线状态完好无损
    expect(service.getConnectedTarget()?.instanceId).toBe('inst-b')
    expect(service.getConnectedTarget()?.pid).toBe(2002)
    expect(service.getEngineStatus()?.status).toBe('ready')
    expect(service.getSnapshot().connected).toBe(true)
    expect(service.getStreamState()).toBe('streaming')
  })

  it('AC-3: 建连 10s 看门狗 + 流内 35s 读看门狗 + 15s KeepAlive 续命 + 零 unhandledRejection', async () => {
    vi.useFakeTimers()
    const unhandledRejections: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandledRejections.push(reason)
    process.on('unhandledRejection', onUnhandled)

    try {
      // 写入同源存活发现文件以保持有界重连流程
      const disc = new ServiceDiscoveryFile({
        fileName: 'engine-config.json',
        serviceId: 'firefly-engine-bridge',
        userDataPath: tempUserDataDir
      })
      await disc.publish({
        instanceId: 'inst-ac3',
        pid: process.pid,
        port: 38400,
        host: '127.0.0.1',
        startedAt: new Date().toISOString(),
        revision: 1,
        userDataDir: tempUserDataDir,
        capabilities: []
      })

      let attempt = 0
      const sse2 = createControllableSseStream()
      const sse3 = createControllableSseStream()

      globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (!String(url).includes('/api/engine/events')) {
          return Promise.resolve(new Response('{}', { status: 404 }))
        }
        attempt++
        if (attempt === 1) {
          // 第 1 次：模拟建连半开挂起（仅在 signal abort 时 reject）
          return new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(init.signal?.reason ?? new Error('aborted'))
            })
          })
        }
        if (attempt === 2) {
          return Promise.resolve(new Response(sse2.stream, { status: 200 }))
        }
        return Promise.resolve(new Response(sse3.stream, { status: 200 }))
      }) as any

      service = EngineBridgeService.createForTest({
        userDataPath: tempUserDataDir,
        disableAutoBootstrap: true
      })

      // 阶段一：建连 10s 看门狗
      service.kickEventStreamReconnect({ resetFailures: true })
      await flushMicrotasks()
      expect(attempt).toBe(1)

      await vi.advanceTimersByTimeAsync(SSE_CONNECT_TIMEOUT_MS)
      await flushMicrotasks()
      // 推进退避（1s + 最大 500ms 抖动）进入第 2 次建连
      await vi.advanceTimersByTimeAsync(1_600)
      await flushMicrotasks()
      expect(attempt).toBe(2)

      // 阶段二：每 15s 收到空注释帧 `:\n\n`，累计 60s（> 35s）连接保持健康且无 Timer 泄漏
      sse2.pushSseData({
        status: 'ready',
        pid: process.pid,
        instance_id: 'inst-ac3',
        revision: 1,
        user_data_dir: tempUserDataDir
      })
      await flushMicrotasks()

      for (let i = 0; i < 4; i++) {
        await vi.advanceTimersByTimeAsync(15_000)
        sse2.pushKeepAliveComment()
        await flushMicrotasks()
        expect(service.getStreamState()).toBe('streaming')
        expect(vi.getTimerCount()).toBe(1)
      }

      // 阶段三：流静默挂起满 35s，读看门狗超时触发 cancel + releaseLock 并自动重连
      await vi.advanceTimersByTimeAsync(SSE_READ_WATCHDOG_MS)
      await flushMicrotasks()
      expect(sse2.isCancelled()).toBe(true)

      await vi.advanceTimersByTimeAsync(1_600)
      await flushMicrotasks()
      expect(attempt).toBe(3)
      expect(unhandledRejections).toHaveLength(0)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('AC-4: 即使发现文件 PID 恒存活，连续 DORMANT_MAX_ATTEMPTS=5 次失败后强制转 Dormant 且可被文件变更唤醒', async () => {
    vi.useFakeTimers()
    const disc = new ServiceDiscoveryFile({
      fileName: 'engine-config.json',
      serviceId: 'firefly-engine-bridge',
      userDataPath: tempUserDataDir
    })
    await disc.publish({
      instanceId: 'inst-deadlock',
      pid: process.pid, // PID 恒存活（模拟死锁或 PID 复用）
      port: 38400,
      host: '127.0.0.1',
      startedAt: new Date().toISOString(),
      revision: 1,
      userDataDir: tempUserDataDir,
      capabilities: []
    })

    let sseAttempts = 0
    let shouldFail = true
    const recoveredSse = createControllableSseStream()

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (!String(url).includes('/api/engine/events')) {
        return Promise.resolve(new Response('{}', { status: 404 }))
      }
      sseAttempts++
      if (shouldFail) {
        return Promise.reject(new Error('ECONNREFUSED'))
      }
      return Promise.resolve(new Response(recoveredSse.stream, { status: 200 }))
    }) as any

    service = EngineBridgeService.createForTest({
      userDataPath: tempUserDataDir,
      disableAutoBootstrap: true
    })

    service.kickEventStreamReconnect({ resetFailures: true })
    await flushMicrotasks()

    // 推进足够覆盖 1s + 2s + 4s + 8s + 16s + 抖动的全部退避预算
    for (const stepMs of [1_600, 2_600, 4_600, 8_600, 16_600]) {
      await vi.advanceTimersByTimeAsync(stepMs)
      await flushMicrotasks()
    }

    expect(sseAttempts).toBe(DORMANT_MAX_ATTEMPTS)
    expect(service.getStreamState()).toBe('dormant')
    expect(vi.getTimerCount()).toBe(0)

    // Dormant 态下再过 120s 依然 0 新增请求
    await vi.advanceTimersByTimeAsync(120_000)
    await flushMicrotasks()
    expect(sseAttempts).toBe(DORMANT_MAX_ATTEMPTS)

    // 发现文件更新事件唤醒 Dormant，重置失败计数并建连成功
    shouldFail = false
    await disc.publish({
      instanceId: 'inst-recovered',
      pid: process.pid,
      port: 38402,
      host: '127.0.0.1',
      startedAt: new Date().toISOString(),
      revision: 2,
      userDataDir: tempUserDataDir,
      capabilities: []
    })
    service.handleDiscoveryFileChange({
      schemaVersion: 1,
      service: 'firefly-engine-bridge',
      instanceId: 'inst-recovered',
      pid: process.pid,
      port: 38402,
      host: '127.0.0.1',
      baseUrl: 'http://127.0.0.1:38402',
      startedAt: new Date().toISOString(),
      revision: 2,
      userDataDir: tempUserDataDir,
      capabilities: []
    })
    await flushMicrotasks()
    recoveredSse.pushSseData({
      status: 'ready',
      pid: process.pid,
      instance_id: 'inst-recovered',
      revision: 1,
      user_data_dir: tempUserDataDir
    })
    await flushMicrotasks()

    expect(sseAttempts).toBe(DORMANT_MAX_ATTEMPTS + 1)
    expect(service.getStreamState()).toBe('streaming')
    expect(service.getSnapshot().port).toBe(38402)
  })

  it('AC-5: stop() -> doStart() 可无限重入，重建 stopController 与 DirWatcher 且恢复 SSE 同步', async () => {
    const sse1 = createControllableSseStream()
    const sse2 = createControllableSseStream()
    let sseCount = 0

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/api/engine/events')) {
        sseCount++
        const targetSse = sseCount === 1 ? sse1 : sse2
        return Promise.resolve(new Response(targetSse.stream, { status: 200 }))
      }
      if (String(url).includes('/api/engine/status')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              status: 'ready',
              pid: process.pid,
              instance_id: `inst-reenter-${sseCount + 1}`,
              revision: 1,
              user_data_dir: tempUserDataDir
            }),
            { status: 200 }
          )
        )
      }
      return Promise.resolve(new Response('{}', { status: 404 }))
    }) as any

    service = EngineBridgeService.createForTest({ userDataPath: tempUserDataDir })
    vi.spyOn(service, 'resolveEngineExecutable').mockReturnValue('mock-engine.exe')

    // 首次建连
    service.kickEventStreamReconnect({ resetFailures: true })
    await flushMicrotasks()
    sse1.pushSseData({
      status: 'ready',
      pid: process.pid,
      instance_id: 'inst-reenter-1',
      revision: 1,
      user_data_dir: tempUserDataDir
    })
    await flushMicrotasks()
    expect(service.getStreamState()).toBe('streaming')

    // 调用异步 stop()
    await service.stop()
    expect(service.getStreamState()).toBe('dormant')
    expect(service.getConnectedTarget()).toBeNull()

    // 重入调用 start() -> doStart()：重建 stopController 与 watcher，重新建连 SSE
    const started = await service.start()
    expect(started).toBe(true)
    await flushMicrotasks()
    sse2.pushSseData({
      status: 'ready',
      pid: process.pid,
      instance_id: 'inst-reenter-2',
      revision: 2,
      user_data_dir: tempUserDataDir
    })
    await flushMicrotasks()

    expect(service.getStreamState()).toBe('streaming')
    expect(service.getEngineStatus()?.instance_id).toBe('inst-reenter-2')
  })

  it('AC-6: 同源 user_data_dir 校验拒绝跨 Worktree 实例 + revision 单调保序 + 熔断器 open-circuit 豁免', async () => {
    let activeSse = createControllableSseStream()
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/api/engine/events')) {
        activeSse = createControllableSseStream()
        return Promise.resolve(new Response(activeSse.stream, { status: 200 }))
      }
      return Promise.resolve(new Response('{}', { status: 404 }))
    }) as any

    service = EngineBridgeService.createForTest({
      userDataPath: tempUserDataDir,
      disableAutoBootstrap: true
    })

    // 1. 异源 user_data_dir 状态被拒绝
    service.applyStatus({
      status: 'ready',
      pid: 9999,
      instance_id: 'foreign-inst',
      revision: 10,
      user_data_dir: path.join(os.tmpdir(), 'some-other-worktree-user-data')
    })
    expect(service.getEngineStatus()).toBeNull()

    // 2. 同源状态按 revision 单调保序：旧帧被丢弃
    service.applyStatus({
      status: 'ready',
      pid: process.pid,
      instance_id: 'local-inst-1',
      revision: 5,
      current_model: 'model-v5',
      user_data_dir: tempUserDataDir
    })
    expect(service.getEngineStatus()?.current_model).toBe('model-v5')

    service.applyStatus({
      status: 'processing',
      pid: process.pid,
      instance_id: 'local-inst-1',
      revision: 3,
      current_model: 'model-v3-stale',
      user_data_dir: tempUserDataDir
    })
    expect(service.getEngineStatus()?.current_model).toBe('model-v5')
    expect(service.getEngineStatus()?.status).toBe('ready')

    // 3. 切换新 instance_id 时重置 lastAppliedRevision = 0，revision=1 可正常采纳
    service.applyStatus({
      status: 'starting',
      pid: process.pid,
      instance_id: 'local-inst-2',
      revision: 1,
      current_model: 'model-new-inst',
      user_data_dir: tempUserDataDir
    })
    expect(service.getEngineStatus()?.current_model).toBe('model-new-inst')

    // 4. 熔断器处于 open 状态时，发现文件唤醒绕过 canExecute()，首帧通过校验后复位熔断器
    for (let i = 0; i < 5; i++) {
      service.circuitBreaker.recordFailure()
    }
    expect(service.circuitBreaker.getState()).toBe('open')

    service.handleDiscoveryFileChange({
      schemaVersion: 1,
      service: 'firefly-engine-bridge',
      instanceId: 'local-inst-3',
      pid: process.pid,
      port: 38400,
      host: '127.0.0.1',
      baseUrl: 'http://127.0.0.1:38400',
      startedAt: new Date().toISOString(),
      revision: 1,
      userDataDir: tempUserDataDir,
      capabilities: []
    })
    await flushMicrotasks()
    activeSse.pushSseData({
      status: 'ready',
      pid: process.pid,
      instance_id: 'local-inst-3',
      revision: 1,
      user_data_dir: tempUserDataDir
    })
    await flushMicrotasks()

    expect(service.circuitBreaker.getState()).toBe('closed')
  })

  it('AC-7: 受管 child.stdout FIREFLY_READY 快路径与发现文件端口漂移立即切换 activePort 建连', async () => {
    const requestedUrls: string[] = []
    const sse1 = createControllableSseStream()
    const sse2 = createControllableSseStream()

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      requestedUrls.push(String(url))
      if (String(url).includes(':38405/api/engine/events')) {
        return Promise.resolve(new Response(sse1.stream, { status: 200 }))
      }
      if (String(url).includes(':38407/api/engine/events')) {
        return Promise.resolve(new Response(sse2.stream, { status: 200 }))
      }
      return Promise.resolve(new Response('{}', { status: 404 }))
    }) as any

    service = EngineBridgeService.createForTest({
      userDataPath: tempUserDataDir,
      disableAutoBootstrap: true
    })

    // 模拟受管子进程 stdout 输出 FIREFLY_READY 快路径
    const fakeChild = new EventEmitter() as any
    fakeChild.pid = 43210
    fakeChild.stdout = new PassThrough()
    ;(service as any).process = fakeChild
    ;(service as any).attachStdoutReadyListener(fakeChild)

    fakeChild.stdout.write(
      `[engine] boot\nFIREFLY_READY:{"port":38405,"pid":43210,"instanceId":"inst-stdout"}\n`
    )
    await flushMicrotasks()

    expect(service.getSnapshot().port).toBe(38405)
    expect(requestedUrls.some(u => u.includes('http://127.0.0.1:38405/api/engine/events'))).toBe(
      true
    )

    // 模拟 userData/run/engine-config.json 端口漂移至 38407
    service.handleDiscoveryFileChange({
      schemaVersion: 1,
      service: 'firefly-engine-bridge',
      instanceId: 'inst-drift',
      pid: process.pid,
      port: 38407,
      host: '127.0.0.1',
      baseUrl: 'http://127.0.0.1:38407',
      startedAt: new Date().toISOString(),
      revision: 3,
      userDataDir: tempUserDataDir,
      capabilities: []
    })
    await flushMicrotasks()

    expect(service.getSnapshot().port).toBe(38407)
    expect(requestedUrls.some(u => u.includes('http://127.0.0.1:38407/api/engine/events'))).toBe(
      true
    )
    // 清理测试伪造的 child 引用，避免 afterEach stop 调 taskkill
    ;(service as any).process = null
  })

  it('AC-8: 收到服务端 stopping 终帧后优雅转离线并进入 Dormant，不盲目重连', async () => {
    const sse = createControllableSseStream()
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/api/engine/events')) {
        return Promise.resolve(new Response(sse.stream, { status: 200 }))
      }
      return Promise.resolve(new Response('{}', { status: 404 }))
    })
    globalThis.fetch = fetchMock as any

    service = EngineBridgeService.createForTest({
      userDataPath: tempUserDataDir,
      disableAutoBootstrap: true
    })
    service.kickEventStreamReconnect({ resetFailures: true })
    await flushMicrotasks()

    sse.pushSseData({
      status: 'ready',
      pid: process.pid,
      instance_id: 'inst-stop',
      revision: 1,
      user_data_dir: tempUserDataDir
    })
    await flushMicrotasks()
    expect(service.getSnapshot().connected).toBe(true)

    sse.pushSseData({
      status: 'stopping',
      pid: process.pid,
      instance_id: 'inst-stop',
      revision: 2,
      user_data_dir: tempUserDataDir
    })
    sse.close()
    await flushMicrotasks(12)

    expect(service.getStreamState()).toBe('dormant')
    expect(service.getSnapshot().connected).toBe(false)
    const sseCalls = fetchMock.mock.calls.filter(c => String(c[0]).includes('/api/engine/events'))
    expect(sseCalls).toHaveLength(1)
  })

  it('AC-9: powerMonitor resume 无闪烁重建连接 + browser-window-focus 单次重读自愈', async () => {
    const disc = new ServiceDiscoveryFile({
      fileName: 'engine-config.json',
      serviceId: 'firefly-engine-bridge',
      userDataPath: tempUserDataDir
    })
    await disc.publish({
      instanceId: 'inst-resume',
      pid: process.pid,
      port: 38400,
      host: '127.0.0.1',
      startedAt: new Date().toISOString(),
      revision: 1,
      userDataDir: tempUserDataDir,
      capabilities: []
    })

    const sse1 = createControllableSseStream()
    const sse2 = createControllableSseStream()
    let sseCount = 0

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/api/engine/events')) {
        sseCount++
        return Promise.resolve(new Response(sseCount === 1 ? sse1.stream : sse2.stream, { status: 200 }))
      }
      return Promise.resolve(new Response('{}', { status: 404 }))
    }) as any

    service = EngineBridgeService.createForTest({ userDataPath: tempUserDataDir })
    await flushMicrotasks()
    sse1.pushSseData({
      status: 'ready',
      pid: process.pid,
      instance_id: 'inst-resume',
      revision: 1,
      user_data_dir: tempUserDataDir
    })
    await flushMicrotasks()

    const broadcastHistory: boolean[] = []
    service.subscribe(snap => broadcastHistory.push(snap.connected))

    // 触发系统休眠唤醒
    service.handleSystemResume()
    await flushMicrotasks()
    sse2.pushSseData({
      status: 'ready',
      pid: process.pid,
      instance_id: 'inst-resume',
      revision: 2,
      user_data_dir: tempUserDataDir
    })
    await flushMicrotasks()

    expect(sseCount).toBe(2)
    // 重建期间未广播任何虚假离线 (false)
    expect(broadcastHistory.includes(false)).toBe(false)
    expect(service.getSnapshot().connected).toBe(true)
    expect(service.getStreamState()).toBe('streaming')
  })

  it('AC-10: 源码契约确认零周期轮询、真实接入 SSE 与 ServiceDiscoveryFile', () => {
    const sourcePath = path.resolve(
      __dirname,
      '..',
      'engine-bridge-service',
      'engine-bridge-service.ts'
    )
    const source = fs.readFileSync(sourcePath, 'utf-8')
    expect(source).not.toMatch(/startPolling\s*\(/)
    expect(source).not.toMatch(/stopPolling\s*\(/)
    expect(source).toContain('/api/engine/events')
    expect(source).toContain('ServiceDiscoveryFile')
    expect(source).toContain('readWithWatchdog')
    expect(source).toContain('sleepCancellable')
  })
})
