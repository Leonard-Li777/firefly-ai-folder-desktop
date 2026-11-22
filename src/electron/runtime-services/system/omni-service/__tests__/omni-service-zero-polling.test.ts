import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockBroadcastOmniStatus, mockPowerMonitor, mockAppState } = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: any[]) => void>>()
  return {
    mockBroadcastOmniStatus: vi.fn(),
    mockPowerMonitor: {
      on: vi.fn((event: string, fn: (...args: any[]) => void) => {
        const list = listeners.get(event) || []
        list.push(fn)
        listeners.set(event, list)
      }),
      emit: (event: string, ...args: any[]) => {
        for (const fn of listeners.get(event) || []) {
          fn(...args)
        }
      }
    },
    mockAppState: {
      userDataDir: ''
    }
  }
})

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
  powerMonitor: mockPowerMonitor,
  shell: {
    openPath: vi.fn()
  }
}))

vi.mock('../helpers', () => ({
  broadcastOmniStatus: mockBroadcastOmniStatus
}))

vi.mock('../../../../main/worktree-env', () => ({
  isLocalDevRuntime: vi.fn(() => false)
}))

vi.mock('../../../../config/config-orchestrator', () => ({
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

vi.mock('../../../database', () => ({
  databaseService: {
    getDbPath: vi.fn(() => null)
  }
}))

import {
  parseFireflyReadyLine,
  parseOmniStatusEvent,
  verifyOmniSameOrigin
} from '../omni-status-contract'
import { OmniService } from '../omni-service'
import { DuplicateDetectionService } from '../../../filesystem/duplicate-detection-service'

/** 构造可控 ReadableStream，用于模拟 SSE 服务端分帧推送 */
function createControllableSseStream() {
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | null = null
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller
    }
  })
  return {
    stream,
    pushText(text: string) {
      controllerRef?.enqueue(encoder.encode(text))
    },
    close() {
      try {
        controllerRef?.close()
      } catch {}
    }
  }
}

function resetOmniSingleton(): OmniService {
  const prev = (OmniService as any).instance as OmniService | undefined
  if (prev) {
    try {
      prev.stopImmediatelySync()
    } catch {}
  }
  ;(OmniService as any).instance = undefined
  return OmniService.getInstance()
}

describe('Ticket 05: OmniStatusEvent 跨语言契约、同源校验与零轮询 SSE 状态机', () => {
  let tmpUserData: string
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-zero-poll-'))
    mockAppState.userDataDir = tmpUserData
    mockBroadcastOmniStatus.mockReset()
  })

  afterEach(async () => {
    vi.useRealTimers()
    globalThis.fetch = originalFetch
    const inst = (OmniService as any).instance as OmniService | undefined
    if (inst) {
      try {
        inst.stopImmediatelySync()
      } catch {}
      ;(OmniService as any).instance = undefined
    }
    try {
      fs.rmSync(tmpUserData, { recursive: true, force: true })
    } catch {}
  })

  it('AC-8: 跨语言 JSON 契约向量与 Rust OmniStatusEvent 100% 一致解析', () => {
    const contractJson = JSON.stringify({
      status: 'ok',
      pid: 42424,
      instanceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      revision: 7,
      port: 38201,
      version: '1.2.3',
      profile: 'gemma_unified',
      mrlDimension: 512,
      userDataDir: 'C:\\Users\\tester\\AppData\\Roaming\\firefly',
      masterDbPath: 'C:\\Users\\tester\\AppData\\Roaming\\firefly\\firefly-ai-folder.db',
      targetVectorsDir: 'C:\\Users\\tester\\AppData\\Roaming\\firefly\\vectors'
    })

    const parsed = parseOmniStatusEvent(contractJson)
    expect(parsed).toEqual({
      status: 'ok',
      pid: 42424,
      instanceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      revision: 7,
      port: 38201,
      version: '1.2.3',
      profile: 'gemma_unified',
      mrlDimension: 512,
      userDataDir: 'C:\\Users\\tester\\AppData\\Roaming\\firefly',
      masterDbPath: 'C:\\Users\\tester\\AppData\\Roaming\\firefly\\firefly-ai-folder.db',
      targetVectorsDir: 'C:\\Users\\tester\\AppData\\Roaming\\firefly\\vectors'
    })

    const ready = parseFireflyReadyLine(
      'FIREFLY_READY:{"port":38201,"pid":42424,"instanceId":"f47ac10b-58cc-4372-a567-0e02b2c3d479"}'
    )
    expect(ready).toEqual({
      port: 38201,
      pid: 42424,
      instanceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    })
    expect(parseFireflyReadyLine('INFO normal log line')).toBeNull()
  })

  it('跨 Worktree 同源校验：同源通过、异 Worktree 严格拒绝、跨盘符迁移二次校验通过并告警', () => {
    const expected = {
      expectedPort: 38200,
      userDataDir: path.join('C:', 'Users', 'dev', 'firefly_worktree_a'),
      masterDbPath: path.join('C:', 'Users', 'dev', 'firefly_worktree_a', 'firefly-ai-folder.db'),
      targetVectorsDir: path.join('C:', 'Users', 'dev', 'firefly_worktree_a', 'vectors')
    }

    // 1. 完全同源
    expect(
      verifyOmniSameOrigin(
        {
          port: 38200,
          pid: 1234,
          userDataDir: expected.userDataDir,
          masterDbPath: expected.masterDbPath,
          targetVectorsDir: expected.targetVectorsDir
        },
        expected
      )
    ).toEqual({ ok: true })

    // 2. 异 Worktree 拒绝采纳
    const diffWt = verifyOmniSameOrigin(
      {
        port: 38200,
        pid: 1234,
        userDataDir: path.join('C:', 'Users', 'dev', 'firefly_worktree_b'),
        masterDbPath: path.join('C:', 'Users', 'dev', 'firefly_worktree_b', 'firefly-ai-folder.db'),
        targetVectorsDir: path.join('C:', 'Users', 'dev', 'firefly_worktree_b', 'vectors')
      },
      expected
    )
    expect(diffWt.ok).toBe(false)

    // 3. 跨盘符整体迁移（同目录名 + 相同相对路径）放行但返回 warning
    const migrated = verifyOmniSameOrigin(
      {
        port: 38200,
        pid: 1234,
        userDataDir: path.join('D:', 'Migrated', 'firefly_worktree_a'),
        masterDbPath: path.join('D:', 'Migrated', 'firefly_worktree_a', 'firefly-ai-folder.db'),
        targetVectorsDir: path.join('D:', 'Migrated', 'firefly_worktree_a', 'vectors')
      },
      expected
    )
    expect(migrated.ok).toBe(true)
    expect(migrated.warning).toContain('跨盘符迁移')
  })

  it('SSE 推送触发 broadcastOmniStatus，严格按 instanceId + revision 保序且拒绝异 Worktree 首帧', async () => {
    const svc = resetOmniSingleton()
    const sse = createControllableSseStream()

    globalThis.fetch = vi.fn(async () => {
      return new Response(sse.stream, {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      })
    }) as any

    svc.ensureEventStream()
    await new Promise(r => setTimeout(r, 20))

    // 推送首帧 revision=2
    sse.pushText(
      `data: ${JSON.stringify({
        status: 'ok',
        pid: process.pid,
        instanceId: 'inst-1',
        revision: 2,
        port: 38200,
        version: '1.5.0',
        profile: 'classic_light',
        mrlDimension: 512,
        userDataDir: tmpUserData,
        masterDbPath: path.join(tmpUserData, 'firefly-ai-folder.db'),
        targetVectorsDir: path.join(tmpUserData, 'vectors')
      })}\n\n`
    )
    await new Promise(r => setTimeout(r, 20))
    expect(mockBroadcastOmniStatus).toHaveBeenCalledWith({ running: true, version: '1.5.0' })
    expect(mockBroadcastOmniStatus).toHaveBeenCalledTimes(1)

    // 发送落后 revision=1（同 instanceId）应被丢弃
    sse.pushText(
      `data: ${JSON.stringify({
        status: 'ok',
        pid: process.pid,
        instanceId: 'inst-1',
        revision: 1,
        port: 38200,
        version: '1.4.0',
        profile: 'classic_light',
        mrlDimension: 512,
        userDataDir: tmpUserData
      })}\n\n`
    )
    await new Promise(r => setTimeout(r, 20))
    expect(mockBroadcastOmniStatus).toHaveBeenCalledTimes(1)

    // 切换新 instanceId 后 revision 重置为 0，revision=1 应被接受
    sse.pushText(
      `data: ${JSON.stringify({
        status: 'ok',
        pid: process.pid,
        instanceId: 'inst-2',
        revision: 1,
        port: 38200,
        version: '1.6.0',
        profile: 'gemma_unified',
        mrlDimension: 512,
        userDataDir: tmpUserData
      })}\n\n`
    )
    await new Promise(r => setTimeout(r, 20))
    expect(mockBroadcastOmniStatus).toHaveBeenLastCalledWith({ running: true, version: '1.6.0' })
    expect(mockBroadcastOmniStatus).toHaveBeenCalledTimes(2)

    // 跨 Worktree 路径不匹配帧必须拒绝采纳，不得再触发 broadcastOmniStatus({ running: true })
    sse.pushText(
      `data: ${JSON.stringify({
        status: 'ok',
        pid: process.pid,
        instanceId: 'inst-other-wt',
        revision: 1,
        port: 38200,
        version: '9.9.9',
        profile: 'classic_light',
        mrlDimension: 512,
        userDataDir: path.join(os.tmpdir(), 'another-worktree-userdata')
      })}\n\n`
    )
    await new Promise(r => setTimeout(r, 20))
    expect(mockBroadcastOmniStatus).not.toHaveBeenCalledWith({ running: true, version: '9.9.9' })
    sse.close()
  })

  it('0 定时器轮询：建连 10s 看门狗超时 + 连续 5 次失败后进入 Dormant 静默态', async () => {
    vi.useFakeTimers()
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')

    // 提前写入一个存活 PID 的发现文件，避免构造后写盘触发 DirWatcher 防抖带来额外 kick
    const runDir = path.join(tmpUserData, 'run')
    fs.mkdirSync(runDir, { recursive: true })
    fs.writeFileSync(
      path.join(runDir, 'omni-config.json'),
      JSON.stringify({
        schemaVersion: 1,
        service: 'firefly-omni-server',
        instanceId: 'inst-hung',
        revision: 1,
        host: '127.0.0.1',
        port: 38200,
        baseUrl: 'http://127.0.0.1:38200',
        pid: process.pid,
        startedAt: new Date().toISOString(),
        userDataDir: tmpUserData,
        capabilities: []
      })
    )

    const svc = resetOmniSingleton()

    let fetchCount = 0
    globalThis.fetch = vi.fn((_url: any, init?: RequestInit) => {
      fetchCount++
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason ?? new Error('Aborted'))
        })
      })
    }) as any

    // 生产模式下构造函数绝不启动任何周期性 setInterval 状态轮询
    expect(setIntervalSpy).not.toHaveBeenCalled()

    svc.ensureEventStream()
    expect(fetchCount).toBe(1)

    // 推进 5 轮（10s connect 超时 + 指数退避 1s/2s/4s/8s + 抖动），第 5 次失败后必须进入 Dormant
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(30_000)
    }

    expect(fetchCount).toBe(5)
    expect(svc.isDormant()).toBe(true)

    // 进入 Dormant 后再推进 120s，0 次新增网络请求
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetchCount).toBe(5)

    setIntervalSpy.mockRestore()
  })

  it('stop() 同步段先捕获 childPid 与 instanceId，停机后撤销 omni-config.json', async () => {
    const svc = resetOmniSingleton()
    const runDir = path.join(tmpUserData, 'run')
    fs.mkdirSync(runDir, { recursive: true })
    const configPath = path.join(runDir, 'omni-config.json')
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        service: 'firefly-omni-server',
        instanceId: 'inst-to-revoke',
        revision: 3,
        host: '127.0.0.1',
        port: 38200,
        baseUrl: 'http://127.0.0.1:38200',
        pid: 55555,
        startedAt: new Date().toISOString(),
        userDataDir: tmpUserData,
        capabilities: []
      })
    )

    const fakeChild = new EventEmitter() as any
    fakeChild.pid = 55555
    fakeChild.exitCode = 0
    fakeChild.signalCode = null
    fakeChild.killed = true
    fakeChild.kill = vi.fn()

    ;(svc as any).process = fakeChild
    ;(svc as any).connectedTarget = {
      baseUrl: 'http://127.0.0.1:38200',
      pid: 55555,
      instanceId: 'inst-to-revoke'
    }
    // 跳过 waitForPortReleased 的实际 HTTP 探活等待
    vi.spyOn(svc, 'waitForPortReleased').mockResolvedValue(true)

    await svc.stop()
    expect(fs.existsSync(configPath)).toBe(false)
  })

  it('DuplicateDetectionService 彻底退役 OMNI_ACTUAL_PORT，统一委托 omniService.getBaseUrl()', () => {
    const svc = resetOmniSingleton()
    ;(svc as any).baseUrl = 'http://127.0.0.1:38209'

    const prevEnv = process.env.OMNI_ACTUAL_PORT
    process.env.OMNI_ACTUAL_PORT = '39999'
    try {
      const dupService = new DuplicateDetectionService()
      expect((dupService as any).omniApiUrl).toBe('http://127.0.0.1:38209')
    } finally {
      if (prevEnv === undefined) {
        delete process.env.OMNI_ACTUAL_PORT
      } else {
        process.env.OMNI_ACTUAL_PORT = prevEnv
      }
    }
  })
})
