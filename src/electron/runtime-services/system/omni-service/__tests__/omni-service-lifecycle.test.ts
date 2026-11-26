// @vitest-environment node
/**
 * OmniService 防自杀生命周期、四级 omniFetch、20 端口并发扫描、
 * 60s 自愈恢复终态与 Per-launch LaunchContext 精准归因单测 (Ticket 02 / Spec v1.7.3)
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  mockSpawn,
  mockBroadcastOmniStatus,
  mockAppState,
  mockDbState,
  mockKillProcessTree,
  mockAlivePids
} = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockBroadcastOmniStatus: vi.fn(),
  mockAppState: { userDataDir: '' },
  mockDbState: { dbPath: null as string | null },
  mockKillProcessTree: vi.fn(),
  mockAlivePids: new Set<number>([51000, 51001, 51002])
}))

vi.mock('@firefly/shared', async importOriginal => {
  const actual = await importOriginal<typeof import('@firefly/shared')>()
  return {
    ...actual,
    killProcessTree: (pid: number) => mockKillProcessTree(pid),
    isPidAlive: (pid: number) => mockAlivePids.has(pid)
  }
})

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (...args: any[]) => mockSpawn(...args)
  }
})

vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: (...args: any[]) => mockSpawn(...args)
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
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  dialog: { showErrorBox: vi.fn(), showMessageBox: vi.fn() },
  powerMonitor: { on: vi.fn() },
  shell: { openPath: vi.fn() }
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

vi.mock('../../../database/database-service', () => ({
  databaseService: {
    getDbPath: vi.fn(() => mockDbState.dbPath)
  }
}))

vi.mock('../../modular-resource-service', () => ({
  modularResourceService: {
    getPluginsRootDir: vi.fn(() => ''),
    isRootUnavailable: vi.fn(() => false),
    listModules: vi.fn(() => []),
    getMountableResourcesSnapshot: vi.fn(() => [])
  }
}))

import { OmniService } from '../omni-service'

function createFakeChild(pid: number) {
  const child = new EventEmitter() as any
  child.pid = pid
  child.exitCode = null
  child.signalCode = null
  child.killed = false
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.stderr.destroy = vi.fn()
  child.stdin = new EventEmitter()
  child.kill = vi.fn(() => {
    child.killed = true
    return true
  })
  return child
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

describe('Ticket 02: OmniService 生命周期、四级 omniFetch、20 端口扫描与精准归因', () => {
  let tmpDir: string
  const originalFetch = globalThis.fetch

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-lifecycle-t02-'))
    mockAppState.userDataDir = tmpDir
    mockDbState.dbPath = path.join(tmpDir, 'firefly-ai-folder.db')
    mockSpawn.mockReset()
    mockBroadcastOmniStatus.mockReset()
    mockKillProcessTree.mockReset()
    mockAlivePids.clear()
    mockAlivePids.add(51000)
    mockAlivePids.add(51001)
    mockAlivePids.add(51002)
  })

  afterEach(() => {
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
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {}
  })

  it('停机早退守卫：stopImmediatelySync 清空状态、先递增代际再发 onLifecycleInactive，停机期禁拉起', async () => {
    const svc = resetOmniSingleton()
    const inactiveEvents: number[] = []
    svc.onLifecycleInactive(gen => inactiveEvents.push(gen))

    const initGen = svc.getGeneration()
    ;(svc as any).cachedVersion = '1.8.0'
    ;(svc as any).expectedIdentity = { pid: 51000, instanceId: 'inst-a', port: 38200 }
    ;(svc as any).lastVerifiedAtMs = Date.now()
    expect(svc.isReady()).toBe(true)

    svc.stopImmediatelySync()

    expect(svc.getGeneration()).toBe(initGen + 1)
    expect(inactiveEvents).toEqual([initGen + 1])
    expect(svc.isReady()).toBe(false)
    expect((svc as any).cachedVersion).toBeNull()
    expect((svc as any).expectedIdentity).toBeNull()
    expect((svc as any).lastVerifiedAtMs).toBe(0)

    // 停机期 ensureRunning / doStart 必须立即返回 false，绝不 spawn
    expect(await svc.ensureRunning()).toBe(false)
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('复用态 isReady() 纯同步 30s TTL + X-Omni-Instance-Id 匹配刷新与不匹配自失效 + ECONNREFUSED 自失效', async () => {
    const svc = resetOmniSingleton()
    ;(svc as any).actualPort = 38200
    ;(svc as any).baseUrl = 'http://127.0.0.1:38200'
    ;(svc as any).cachedVersion = '1.8.0'
    ;(svc as any).expectedIdentity = { pid: 51000, instanceId: 'boot-1', port: 38200 }
    ;(svc as any).lastVerifiedAtMs = Date.now() - 29_000
    expect(svc.isReady()).toBe(true)

    // 超 30s 同步返回 false
    ;(svc as any).lastVerifiedAtMs = Date.now() - 31_000
    expect(svc.isReady()).toBe(false)

    // 收到同源 2xx + 匹配 X-Omni-Instance-Id 立即刷新 TTL
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'X-Omni-Instance-Id': 'boot-1' }
      })
    }) as any
    await svc.omniFetch('http://127.0.0.1:38200/api/ping', { kind: 'call' })
    expect(svc.isReady()).toBe(true)

    // 收到不匹配 X-Omni-Instance-Id（即使 internal:true）立即自失效
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'X-Omni-Instance-Id': 'boot-foreign-999' }
      })
    }) as any
    await svc.omniFetch('http://127.0.0.1:38200/api/v1/engine/status', {
      kind: 'probe',
      internal: true
    })
    expect(svc.isReady()).toBe(false)
    expect((svc as any).expectedIdentity).toBeNull()

    // 重新建立复用态后，遇目标 baseUrl ECONNREFUSED 立即自失效
    ;(svc as any).cachedVersion = '1.8.0'
    ;(svc as any).expectedIdentity = { pid: 51000, instanceId: 'boot-2', port: 38200 }
    ;(svc as any).lastVerifiedAtMs = Date.now()
    globalThis.fetch = vi.fn(async () => {
      const err: any = new TypeError('fetch failed')
      err.cause = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' }
      throw err
    }) as any
    await expect(
      svc.omniFetch('http://127.0.0.1:38200/api/v1/engine/status', {
        kind: 'probe',
        internal: true
      })
    ).rejects.toThrow()
    expect(svc.isReady()).toBe(false)
    expect((svc as any).expectedIdentity).toBeNull()
  })

  it('20 端口并发扫描遇 3 个外来不同源实例时，绝不改动已采纳 expectedIdentity', async () => {
    const svc = resetOmniSingleton()
    const myIdentity = { pid: 51000, instanceId: 'my-own-boot', port: 38200 }
    ;(svc as any).actualPort = 38200
    ;(svc as any).baseUrl = 'http://127.0.0.1:38200'
    ;(svc as any).expectedIdentity = { ...myIdentity }
    ;(svc as any).cachedVersion = '1.8.0'
    ;(svc as any).lastVerifiedAtMs = Date.now()

    const probedPorts: number[] = []
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const u = new URL(typeof url === 'string' ? url : url.toString())
      const port = Number(u.port)
      probedPorts.push(port)
      if (port === 38201 || port === 38202 || port === 38203) {
        return new Response(
          JSON.stringify({
            status: 'ok',
            port,
            pid: 99000 + port,
            instanceId: `foreign-${port}`,
            userDataDir: 'D:\\other-worktree\\userData',
            masterDbPath: 'D:\\other-worktree\\firefly-ai-folder.db',
            targetVectorsDir: 'D:\\other-worktree\\vectors'
          }),
          {
            status: 200,
            headers: { 'X-Omni-Instance-Id': `foreign-${port}` }
          }
        )
      }
      const err: any = new TypeError('fetch failed')
      err.cause = { code: 'ECONNREFUSED' }
      throw err
    }) as any

    // 直接对 38201..38203 发起 verifyOmniInstance（模拟 20 端口扫描探测其他端口）
    const results = await Promise.all([
      (svc as any).verifyOmniInstance(38201, undefined, { timeoutMs: 3000, internal: true }),
      (svc as any).verifyOmniInstance(38202, undefined, { timeoutMs: 3000, internal: true }),
      (svc as any).verifyOmniInstance(38203, undefined, { timeoutMs: 3000, internal: true })
    ])

    expect(results.every((r: any) => r.ok === false)).toBe(true)
    expect(probedPorts).toEqual(expect.arrayContaining([38201, 38202, 38203]))
    // 已采纳身份纹丝不动
    expect((svc as any).expectedIdentity).toEqual(myIdentity)
    expect(svc.isReady()).toBe(true)
  })

  it('restartUnhealthyManaged 三项护栏：自失败计数扣除、internal:true 防递归、静默 10 分钟单次失败不重启且强杀前二次核验', async () => {
    vi.useFakeTimers()
    const svc = resetOmniSingleton()
    const fakeChild = createFakeChild(51000)
    ;(svc as any).process = fakeChild
    ;(svc as any).actualPort = 38200
    ;(svc as any).baseUrl = 'http://127.0.0.1:38200'
    ;(svc as any).cachedVersion = '1.8.0'

    const restartSpy = vi.spyOn(svc, 'restart').mockResolvedValue(true)

    // 1) internal:true 失败绝不累计 unhealthySince，也绝不触发重启
    globalThis.fetch = vi.fn(async () => {
      const err: any = new Error('timeout')
      err.name = 'TimeoutError'
      throw err
    }) as any

    await expect(
      svc.omniFetch('http://127.0.0.1:38200/api/v1/engine/status', {
        kind: 'probe',
        internal: true
      })
    ).rejects.toThrow()
    expect((svc as any).unhealthySince).toBeNull()
    expect(restartSpy).not.toHaveBeenCalled()

    // 2) 首次非 internal 失败记录 unhealthySince；静默 10 分钟后再失败一次应重置 unhealthySince，绝不立即重启
    await expect(
      svc.omniFetch('http://127.0.0.1:38200/api/test', { kind: 'call' })
    ).rejects.toThrow()
    const firstUnhealthy = (svc as any).unhealthySince
    expect(typeof firstUnhealthy).toBe('number')

    vi.advanceTimersByTime(10 * 60 * 1000)
    await expect(
      svc.omniFetch('http://127.0.0.1:38200/api/test', { kind: 'call' })
    ).rejects.toThrow()
    expect((svc as any).unhealthySince).toBeGreaterThan(firstUnhealthy)
    expect(restartSpy).not.toHaveBeenCalled()

    // 3) 持续不健康达 60s（中间每 20s 失败一次保持窗口不重置）：
    //    若有另一条在途请求（inflightCount 额外 +1）时不触发；仅本请求自身（otherInflight === 0）时触发
    vi.advanceTimersByTime(20_000)
    await expect(
      svc.omniFetch('http://127.0.0.1:38200/api/test', { kind: 'call' })
    ).rejects.toThrow()
    vi.advanceTimersByTime(20_000)
    await expect(
      svc.omniFetch('http://127.0.0.1:38200/api/test', { kind: 'call' })
    ).rejects.toThrow()

    // 模拟另有一条在途 long 请求：此时满 60s 不得触发重启
    ;(svc as any).inflightCount = 1
    vi.advanceTimersByTime(21_000)
    await expect(
      svc.omniFetch('http://127.0.0.1:38200/api/test', { kind: 'call' })
    ).rejects.toThrow()
    expect(restartSpy).not.toHaveBeenCalled()

    // 清除外部在途请求后，仅本请求自身失败（otherInflight === 0）→ 触发单飞 restartUnhealthyManaged
    // 先验证：若二次核验 verifyOmniInstance(internal:true) 成功，则取消强杀重启
    ;(svc as any).inflightCount = 0
    const verifySpy = vi.spyOn(svc as any, 'verifyOmniInstance').mockResolvedValueOnce({ ok: true })
    await expect(
      svc.omniFetch('http://127.0.0.1:38200/api/test', { kind: 'call' })
    ).rejects.toThrow()
    await vi.runOnlyPendingTimersAsync()
    expect(verifySpy).toHaveBeenCalledTimes(1)
    expect(restartSpy).not.toHaveBeenCalled()

    // 再次持续 60s 且二次核验确证失败 → 恰好触发 1 次有序 restart
    await expect(
      svc.omniFetch('http://127.0.0.1:38200/api/test', { kind: 'call' })
    ).rejects.toThrow()
    vi.advanceTimersByTime(20_000)
    await expect(
      svc.omniFetch('http://127.0.0.1:38200/api/test', { kind: 'call' })
    ).rejects.toThrow()
    vi.advanceTimersByTime(20_000)
    await expect(
      svc.omniFetch('http://127.0.0.1:38200/api/test', { kind: 'call' })
    ).rejects.toThrow()
    vi.advanceTimersByTime(21_000)
    verifySpy.mockResolvedValueOnce({ ok: false, timedOut: true })
    await expect(
      svc.omniFetch('http://127.0.0.1:38200/api/test', { kind: 'call' })
    ).rejects.toThrow()
    await vi.runOnlyPendingTimersAsync()
    expect(restartSpy).toHaveBeenCalledTimes(1)
  })

  it('启动期 Rust OOM 崩溃（无换行 stderr 残段）精准归因 rust_oom 不写 DML 标记，过期代 close 不污染新实例', async () => {
    const svc = resetOmniSingleton()
    const fakeExe = path.join(tmpDir, 'firefly-omni.exe')
    fs.writeFileSync(fakeExe, 'stub')
    // 契约预检后择优：直接固定返回桩路径，避免真实候选遍历与 spawn 探针
    vi.spyOn(svc as any, 'resolveContractCompatibleExecutable').mockResolvedValue({
      exePath: fakeExe,
      contractMismatch: null
    })
    vi.spyOn(svc as any, 'verifyOmniInstance').mockResolvedValue({
      ok: false,
      portRefused: true,
      explicitNonTimeoutFailure: true
    })

    const child1 = createFakeChild(51001)
    let resolveSpawned!: () => void
    const spawnedPromise = new Promise<void>(r => {
      resolveSpawned = r
    })
    mockSpawn.mockImplementationOnce(() => {
      resolveSpawned()
      return child1
    })

    const inactiveGens: number[] = []
    svc.onLifecycleInactive(gen => inactiveGens.push(gen))

    const startPromise = svc.start()
    await spawnedPromise
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    const gen1 = svc.getGeneration()

    // 模拟先 exit 后排空无换行 stderr 尾段（Rust OOM __fastfail 0xC0000409）
    child1.exitCode = 0xc0000409
    child1.emit('exit', 0xc0000409, null)
    child1.stderr.emit('data', Buffer.from('memory allocation of 1073741824 bytes failed'))
    child1.emit('close', 0xc0000409, null)

    const started = await startPromise
    expect(started).toBe(false)
    // 精准归因 rust_oom：绝不写入 .omni-dml-crash.json，且触发了 onLifecycleInactive(gen1 + 1)
    const markerFile = path.join(tmpDir, '.omni-dml-crash.json')
    expect(fs.existsSync(markerFile)).toBe(false)
    expect(inactiveGens).toContain(gen1 + 1)

    // 模拟过期代（旧 child）延迟 close：绝不发回调、绝不污染当前新实例 this.process
    const child2 = createFakeChild(51002)
    ;(svc as any).process = child2
    const currentGenBeforeStaleClose = svc.getGeneration()
    const inactiveCountBefore = inactiveGens.length

    // 再次触发已过期代 child1 的 close（模拟迟到关闭）
    child1.emit('close', 1, null)
    await new Promise(r => setTimeout(r, 20))
    expect((svc as any).process).toBe(child2)
    expect(svc.getGeneration()).toBe(currentGenBeforeStaleClose)
    expect(inactiveGens.length).toBe(inactiveCountBefore)
  })

  it('GuardedKill 防误抹：已死亡子进程在 close 前触发 doStart 时，绝不调用 forceKillProcessTree 抹掉真实 DML 崩溃', async () => {
    const svc = resetOmniSingleton()
    const fakeExe = path.join(tmpDir, 'firefly-omni.exe')
    fs.writeFileSync(fakeExe, 'stub')
    // 契约预检后择优：直接固定返回桩路径，避免真实候选遍历与 spawn 探针
    vi.spyOn(svc as any, 'resolveContractCompatibleExecutable').mockResolvedValue({
      exePath: fakeExe,
      contractMismatch: null
    })

    // 第 1 次启动成功：让 child1 挂载真实 close 监听并就绪
    let scanPhase = true
    const verifySpy = vi.spyOn(svc as any, 'verifyOmniInstance').mockImplementation(async () => ({
      ok: false,
      portRefused: true,
      explicitNonTimeoutFailure: true
    }))
    const healthSpy = vi.spyOn(svc, 'checkHealth').mockImplementation(async () => !scanPhase)
    vi.spyOn(svc, 'verifyMountManifestStatus').mockResolvedValue({
      ok: true,
      statusData: {
        status: 'ok',
        pid: 51001,
        instanceId: 'boot-51001',
        version: '1.8.0'
      }
    })

    const child1 = createFakeChild(51001)
    mockSpawn.mockImplementationOnce(() => {
      // emit FIREFLY_READY on next tick after listeners attach
      queueMicrotask(() => {
        scanPhase = false
        child1.stdout.emit(
          'data',
          Buffer.from('FIREFLY_READY:{"port":38200,"pid":51001,"instanceId":"boot-51001"}\n')
        )
      })
      return child1
    })

    expect(await svc.start()).toBe(true)
    const ctx1 = (svc as any).currentLaunchCtx
    expect(ctx1).toBeTruthy()
    expect(ctx1.spawnedWithDml).toBe(true)

    // 模拟 OS 进程已崩死（!isPidAlive），checkHealth 与 verifyOmniInstance 均失败，但 exit/close 尚未投递
    scanPhase = true
    mockAlivePids.delete(51001)
    verifySpy.mockResolvedValue({
      ok: false,
      portRefused: true,
      explicitNonTimeoutFailure: true
    })
    healthSpy.mockResolvedValue(false)

    const child2 = createFakeChild(51002)
    let resolveSpawn2!: () => void
    const spawn2Promise = new Promise<void>(r => {
      resolveSpawn2 = r
    })
    mockSpawn.mockImplementationOnce(() => {
      resolveSpawn2()
      return child2
    })

    // 在触发第二次 start() 期间投递迟到的 DirectML 原生崩溃 stderr + close
    const restartPromise = svc.start()
    setTimeout(() => {
      child1.exitCode = 0xc0000005
      child1.stderr.emit('data', Buffer.from('DirectML DXGI device removed\n'))
      child1.emit('close', 0xc0000005, null)
    }, 30)

    await spawn2Promise
    expect(mockKillProcessTree).not.toHaveBeenCalled()
    expect(ctx1.intentionalKill).toBe(false)

    // 结束新拉起的 child2 并验证 DML 崩溃标记已真实落盘
    child2.exitCode = 1
    child2.emit('close', 1, null)
    await restartPromise

    const markerFile = path.join(tmpDir, '.omni-dml-crash.json')
    expect(fs.existsSync(markerFile)).toBe(true)
  })

  it('Round1 修复：child close 同源外部接管完整刷新 expectedIdentity 与 isReady，且同 instanceId 复用刷探不假换代', async () => {
    const svc = resetOmniSingleton()
    const fakeExe = path.join(tmpDir, 'firefly-omni.exe')
    fs.writeFileSync(fakeExe, 'stub')
    // 契约预检后择优：直接固定返回桩路径，避免真实候选遍历与 spawn 探针
    vi.spyOn(svc as any, 'resolveContractCompatibleExecutable').mockResolvedValue({
      exePath: fakeExe,
      contractMismatch: null
    })

    const instanceChangedGens: number[] = []
    svc.onInstanceChanged(g => instanceChangedGens.push(g))

    // 模拟 38200 上的活跃 HTTP 端点响应（避免无本地监听端口导致 kickEventStreamReconnect / ensureEventStream 真实 OS ECONNREFUSED 自失效）
    vi.spyOn(svc as any, 'kickEventStreamReconnect').mockImplementation(() => {})
    vi.spyOn(svc as any, 'ensureEventStream').mockImplementation(() => {})
    vi.spyOn(svc as any, 'syncConfigFromDesktop').mockResolvedValue(undefined)

    // 第 1 次走托管 spawn 启动成功（child1）
    let scanPhase = true
    const verifySpy = vi.spyOn(svc as any, 'verifyOmniInstance').mockImplementation(async () => ({
      ok: false,
      portRefused: true,
      explicitNonTimeoutFailure: true
    }))
    vi.spyOn(svc, 'checkHealth').mockImplementation(async () => !scanPhase)
    vi.spyOn(svc, 'verifyMountManifestStatus').mockResolvedValue({
      ok: true,
      statusData: {
        status: 'ok',
        pid: 52001,
        instanceId: 'child-52001',
        version: '1.8.0'
      }
    })
    const child1 = createFakeChild(52001)
    mockSpawn.mockImplementationOnce(() => {
      queueMicrotask(() => {
        scanPhase = false
        child1.stdout.emit(
          'data',
          Buffer.from('FIREFLY_READY:{"port":38200,"pid":52001,"instanceId":"child-52001"}\n')
        )
      })
      return child1
    })

    expect(await svc.start()).toBe(true)
    const genAfterBoot = svc.getGeneration()
    const spawnTsAfterBoot = (svc as any).lastSpawnedAt

    // 模拟托管 child1 关闭，但 38200 端口已有同源外部接管实例 ext-52002
    scanPhase = false
    verifySpy.mockResolvedValue({
      ok: true,
      data: { status: 'ok', pid: 52002, instanceId: 'ext-52002', version: '1.8.1' },
      headerInstanceId: 'ext-52002'
    })
    child1.exitCode = 1
    child1.emit('close', 1, null)
    await vi.waitFor(() => {
      expect((svc as any).expectedIdentity?.instanceId).toBe('ext-52002')
    })

    expect(svc.isReady()).toBe(true)
    expect((svc as any).connectedTarget?.instanceId).toBe('ext-52002')
    expect((svc as any).cachedVersion).toBe('1.8.1')
    const genAfterTakeover = svc.getGeneration()
    expect(genAfterTakeover).toBeGreaterThan(genAfterBoot)
    expect(instanceChangedGens).toContain(genAfterTakeover)

    // 模拟 30s TTL 过期后进入 doStart() 重扫并命中同一个外部实例 ext-52002：绝不假递增 generation 也绝不发射 onInstanceChanged
    const prevChangedCount = instanceChangedGens.length
    const prevLastSpawned = (svc as any).lastSpawnedAt
    await new Promise(r => setTimeout(r, 15))
    expect(await (svc as any).doStart()).toBe(true)
    expect(svc.getGeneration()).toBe(genAfterTakeover)
    expect(instanceChangedGens).toHaveLength(prevChangedCount)
    expect((svc as any).lastSpawnedAt).toBe(prevLastSpawned)
    expect(spawnTsAfterBoot).toBeGreaterThan(0)
  })
})
