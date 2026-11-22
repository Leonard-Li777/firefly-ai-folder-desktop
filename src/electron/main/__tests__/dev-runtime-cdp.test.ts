import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => os.tmpdir()),
    getName: vi.fn(() => 'firefly-test'),
    setName: vi.fn(),
    setPath: vi.fn()
  }
}))

import {
  getRendererDevPortSlot,
  selectAvailablePortInSlotSync,
  ServiceDiscoveryFile
} from '@firefly/shared'
import {
  DesktopDevRuntimeController,
  extractDevServerPort,
  readDevToolsActivePort,
  selectCandidateCdpPort
} from '../dev-runtime-cdp'

describe('dev-runtime-cdp: 跨平台 Vite/CDP 有界子槽位、真值核验与镜像生命周期', () => {
  let tempRoot: string
  let userDataDir: string
  let workspaceDir: string

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-dev-cdp-'))
    userDataDir = path.join(tempRoot, 'userData')
    workspaceDir = path.join(tempRoot, 'workspace')
    fs.mkdirSync(userDataDir, { recursive: true })
    fs.mkdirSync(workspaceDir, { recursive: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    fs.rmSync(tempRoot, { recursive: true, force: true })
  })

  it('1. 生产模式 (isLocalDevRuntime === false) 下 0 磁盘副作用，不生成发现文件与工作区镜像', async () => {
    const staleActivePortPath = path.join(userDataDir, 'DevToolsActivePort')
    fs.writeFileSync(staleActivePortPath, '38600\n/devtools/browser/stale-uuid\n', 'utf-8')

    const appendSwitch = vi.fn()
    const relaunch = vi.fn()
    const exit = vi.fn()
    const touchActive = vi.fn()

    const controller = new DesktopDevRuntimeController({
      worktreeName: 'main',
      userDataDir,
      workspaceRootDir: workspaceDir,
      deps: {
        isDevRuntime: () => false,
        appendSwitch,
        relaunch,
        exit,
        argv: ['electron', '.'],
        touchActive
      }
    })

    expect(controller.prepareBeforeReady()).toBeNull()
    expect(appendSwitch).not.toHaveBeenCalled()
    // 生产模式不得触碰已有 DevToolsActivePort
    expect(fs.existsSync(staleActivePortPath)).toBe(true)

    const verifyRes = await controller.verifyAndPublishOnReady()
    expect(verifyRes).toEqual({ relaunched: false, published: false })
    expect(relaunch).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
    expect(touchActive).not.toHaveBeenCalled()

    expect(fs.existsSync(path.join(userDataDir, 'run', 'desktop-dev-config.json'))).toBe(false)
    expect(fs.existsSync(path.join(workspaceDir, '.firefly-dev-runtime'))).toBe(false)
    expect(fs.existsSync(path.join(workspaceDir, '.firefly-dev-runtime.json'))).toBe(false)

    await controller.revokeAsync()
    controller.revokeSync()
  })

  it('2. selectCandidateCdpPort 在子槽位内选空闲端口；子槽位耗尽或 CLI=0 时切入 port=0 兜底', () => {
    const winRes = selectCandidateCdpPort({
      worktreeName: 'main',
      platform: 'win32',
      argv: ['electron', '.'],
      env: {},
      occupiedPorts: new Set([38600, 38601])
    })
    expect(winRes.switchValue).toBe('38602')
    expect(winRes.candidatePort).toBe(38602)
    expect(winRes.isZeroPortFallback).toBe(false)

    // 特性分支 win32 子槽位容量为 3，全部被占时应一步切入 '0'
    const featureSlotBase = selectCandidateCdpPort({
      worktreeName: 'feat-cdp-test',
      platform: 'win32',
      argv: ['electron', '.'],
      env: {},
      occupiedPorts: new Set()
    }).slot!
    const allOccupied = new Set<number>()
    for (let p = featureSlotBase.basePort; p <= featureSlotBase.maxPort; p++) {
      allOccupied.add(p)
    }
    const exhaustedRes = selectCandidateCdpPort({
      worktreeName: 'feat-cdp-test',
      platform: 'win32',
      argv: ['electron', '.'],
      env: {},
      occupiedPorts: allOccupied
    })
    expect(exhaustedRes.switchValue).toBe('0')
    expect(exhaustedRes.candidatePort).toBe(0)
    expect(exhaustedRes.isZeroPortFallback).toBe(true)

    // CLI 显式 --remote-debugging-port=0 直接走 '0'
    const zeroCliRes = selectCandidateCdpPort({
      worktreeName: 'main',
      platform: 'linux',
      argv: ['electron', '.', '--remote-debugging-port=0'],
      env: { REMOTE_DEBUGGING_PORT: '38610' },
      occupiedPorts: new Set()
    })
    expect(zeroCliRes.switchValue).toBe('0')
    expect(zeroCliRes.isZeroPortFallback).toBe(true)
  })

  it('3. 开发模式全闭环：删旧 DevToolsActivePort -> 核验真值 -> 发布发现文件与镜像 -> second-instance 重发布 -> 退出撤销', async () => {
    const activePortPath = path.join(userDataDir, 'DevToolsActivePort')
    fs.writeFileSync(activePortPath, '39999\n/devtools/browser/stale-old\n', 'utf-8')

    const appendSwitch = vi.fn()
    const relaunch = vi.fn()
    const exit = vi.fn()
    const touchActive = vi.fn()

    const controller = new DesktopDevRuntimeController({
      worktreeName: 'main',
      userDataDir,
      workspaceRootDir: workspaceDir,
      deps: {
        isDevRuntime: () => true,
        appendSwitch,
        relaunch,
        exit,
        argv: ['electron', '.'],
        env: {
          ELECTRON_RENDERER_URL: 'http://127.0.0.1:38101',
          FIREFLY_DEV_CDP_PUBLIC_URL: 'http://192.168.50.10:38601'
        },
        platform: 'win32',
        pid: process.pid,
        occupiedPorts: new Set([38600]),
        probeJsonVersion: async port => ({
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fresh-uuid`
        }),
        touchActive,
        maxActivePortAttempts: 3,
        activePortDelayMs: 5
      }
    })

    const candidate = controller.prepareBeforeReady()
    expect(candidate?.candidatePort).toBe(38601)
    expect(appendSwitch).toHaveBeenCalledWith('remote-debugging-port', '38601')
    // 启动前必须已删除陈旧的 DevToolsActivePort
    expect(fs.existsSync(activePortPath)).toBe(false)

    // 模拟 Chromium 启动后写入新鲜的 DevToolsActivePort
    fs.writeFileSync(activePortPath, '38601\n/devtools/browser/fresh-uuid\n', 'utf-8')

    const verifyRes = await controller.verifyAndPublishOnReady()
    expect(verifyRes.relaunched).toBe(false)
    expect(verifyRes.published).toBe(true)
    expect(verifyRes.cdpPort).toBe(38601)
    expect(verifyRes.cdpSource).toBe('DevToolsActivePort')
    expect(verifyRes.cdpWsEndpoint).toBe('ws://127.0.0.1:38601/devtools/browser/fresh-uuid')

    // 校验 userData/run/desktop-dev-config.json
    const discovery = new ServiceDiscoveryFile({
      fileName: 'desktop-dev-config.json',
      serviceId: 'desktop-dev',
      userDataPath: userDataDir
    })
    const doc1 = discovery.read({ verifyPid: true })
    expect(doc1).not.toBeNull()
    expect(doc1?.port).toBe(38601)
    expect(doc1?.revision).toBe(1)
    expect(doc1?.debug?.hostReachableUrl).toBe('http://192.168.50.10:38601')
    expect(doc1?.debug?.devServerPort).toBe(38101)
    expect(doc1?.debug?.cdpSource).toBe('DevToolsActivePort')

    // 校验工作区单写者分片与聚合镜像
    const shardPath = path.join(workspaceDir, '.firefly-dev-runtime', 'win32.json')
    const mirrorPath = path.join(workspaceDir, '.firefly-dev-runtime.json')
    expect(fs.existsSync(shardPath)).toBe(true)
    expect(fs.existsSync(mirrorPath)).toBe(true)
    const mirror = JSON.parse(fs.readFileSync(mirrorPath, 'utf-8'))
    expect(mirror.platforms.win32.cdpPort).toBe(38601)
    expect(mirror.platforms.win32.hostReachableUrl).toBe('http://192.168.50.10:38601')
    expect(mirror.platforms.win32.devServerPort).toBe(38101)

    expect(touchActive).toHaveBeenCalledWith('main', {
      platform: 'win32',
      cdpPort: 38601,
      devServerPort: 38101,
      userDataDir
    })

    // second-instance 重发布应递增 revision
    await controller.republishOnSecondInstance()
    const doc2 = discovery.read({ verifyPid: true })
    expect(doc2?.revision).toBe(2)

    // before-quit 异步撤销应删除发现文件、分片及聚合镜像
    await controller.revokeAsync()
    expect(fs.existsSync(path.join(userDataDir, 'run', 'desktop-dev-config.json'))).toBe(false)
    expect(fs.existsSync(shardPath)).toBe(false)
    expect(fs.existsSync(mirrorPath)).toBe(false)
  })

  it('4. 绑定失败自愈：DevToolsActivePort 未生成且 /json/version 不可达时静默 relaunch 切入 port=0；已在重试态不死循环', async () => {
    const appendSwitch = vi.fn()
    const relaunch = vi.fn()
    const exit = vi.fn()

    const controller = new DesktopDevRuntimeController({
      worktreeName: 'main',
      userDataDir,
      workspaceRootDir: workspaceDir,
      deps: {
        isDevRuntime: () => true,
        appendSwitch,
        relaunch,
        exit,
        argv: ['electron', 'main.js', '--remote-debugging-port=38600', '--foo=bar'],
        platform: 'win32',
        occupiedPorts: new Set(),
        probeJsonVersion: async () => null,
        maxActivePortAttempts: 2,
        activePortDelayMs: 5
      }
    })

    controller.prepareBeforeReady()
    const res1 = await controller.verifyAndPublishOnReady()
    expect(res1).toEqual({ relaunched: true, published: false })
    expect(relaunch).toHaveBeenCalledWith({
      args: ['main.js', '--foo=bar', '--remote-debugging-port=0']
    })
    expect(exit).toHaveBeenCalledWith(0)

    // 已处于 --remote-debugging-port=0 重试态仍失败时，不再 relaunch
    const relaunch2 = vi.fn()
    const exit2 = vi.fn()
    const retryController = new DesktopDevRuntimeController({
      worktreeName: 'main',
      userDataDir,
      workspaceRootDir: workspaceDir,
      deps: {
        isDevRuntime: () => true,
        appendSwitch: vi.fn(),
        relaunch: relaunch2,
        exit: exit2,
        argv: ['electron', 'main.js', '--remote-debugging-port=0'],
        platform: 'win32',
        occupiedPorts: new Set(),
        probeJsonVersion: async () => null,
        maxActivePortAttempts: 2,
        activePortDelayMs: 5
      }
    })
    retryController.prepareBeforeReady()
    const res2 = await retryController.verifyAndPublishOnReady()
    expect(res2).toEqual({ relaunched: false, published: false })
    expect(relaunch2).not.toHaveBeenCalled()
    expect(exit2).not.toHaveBeenCalled()
  })

  it('5. SIGINT/SIGTERM 同步撤销 revokeSync 正确清理发现文件与镜像', async () => {
    const activePortPath = path.join(userDataDir, 'DevToolsActivePort')
    const controller = new DesktopDevRuntimeController({
      worktreeName: 'pay',
      userDataDir,
      workspaceRootDir: workspaceDir,
      deps: {
        isDevRuntime: () => true,
        appendSwitch: vi.fn(),
        relaunch: vi.fn(),
        exit: vi.fn(),
        argv: ['electron', '.'],
        env: { PORT: '38110' },
        platform: 'linux',
        pid: process.pid,
        occupiedPorts: new Set(),
        probeJsonVersion: async port => ({
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/linux-uuid`
        }),
        touchActive: vi.fn(),
        maxActivePortAttempts: 2,
        activePortDelayMs: 5
      }
    })

    const candidate = controller.prepareBeforeReady()
    fs.writeFileSync(
      activePortPath,
      `${candidate!.candidatePort}\n/devtools/browser/linux-uuid\n`,
      'utf-8'
    )
    const verifyRes = await controller.verifyAndPublishOnReady()
    expect(verifyRes.published).toBe(true)

    controller.revokeSync()
    expect(fs.existsSync(path.join(userDataDir, 'run', 'desktop-dev-config.json'))).toBe(false)
    expect(fs.existsSync(path.join(workspaceDir, '.firefly-dev-runtime', 'linux.json'))).toBe(false)
    expect(fs.existsSync(path.join(workspaceDir, '.firefly-dev-runtime.json'))).toBe(false)
  })

  it('6. extractDevServerPort 与 readDevToolsActivePort 边界解析正确', async () => {
    expect(extractDevServerPort({ ELECTRON_RENDERER_URL: 'http://127.0.0.1:38103/index.html', PORT: '38100' })).toBe(38103)
    expect(extractDevServerPort({ PORT: '38116' })).toBe(38116)
    expect(extractDevServerPort({})).toBeUndefined()

    const activePath = path.join(userDataDir, 'DevToolsActivePort')
    fs.writeFileSync(activePath, 'bad-port\n/invalid\n', 'utf-8')
    expect(await readDevToolsActivePort(userDataDir, { maxAttempts: 2, delayMs: 5 })).toBeNull()
  })

  it('7. Vite 三端主仓 (38100) 与 pay (38110) 子槽位严格有界且交集恒为空', () => {
    const platforms: NodeJS.Platform[] = ['win32', 'linux', 'darwin']
    const bases = [38100, 38110]
    const allPorts = new Set<number>()

    for (const base of bases) {
      for (const platform of platforms) {
        const slot = getRendererDevPortSlot(base, platform)
        const selected = selectAvailablePortInSlotSync({ slot, occupiedPorts: new Set() })
        expect(selected).toBe(slot.basePort)
        for (let p = slot.basePort; p <= slot.maxPort; p++) {
          expect(allPorts.has(p)).toBe(false)
          allPorts.add(p)
        }
      }
    }
    expect(allPorts.size).toBe(20)
  })
})
