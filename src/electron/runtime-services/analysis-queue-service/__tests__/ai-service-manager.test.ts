import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  default: {
    app: {
      getPath: vi.fn(() => 'D:/mock-path'),
      getName: vi.fn(() => 'desktop'),
      getVersion: vi.fn(() => '1.0.0')
    },
    ipcMain: { on: vi.fn(), handle: vi.fn() }
  },
  app: {
    getPath: vi.fn(() => 'D:/mock-path'),
    getName: vi.fn(() => 'desktop'),
    getVersion: vi.fn(() => '1.0.0')
  },
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

vi.mock('electron-conf', () => ({
  Conf: class {
    get() {
      return undefined
    }
    set() {}
    onDidChange() {}
  }
}))

vi.mock('@app/languages', () => ({
  t: (s: string) => s
}))

vi.mock('@firefly/shared', async () => {
  const actual = await vi.importActual<any>('@firefly/shared')
  return {
    ...actual,
    shouldSkipAIServiceInTest: vi.fn(() => false)
  }
})

import { AIServiceManager } from '../ai-service-manager'
import { AIServiceStatus, ILlamaIndexAIService } from '@firefly/types'
import { engineBridgeService } from '../../engine-bridge'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'

describe('AIServiceManager: 未安装引擎零盲等优雅放行', () => {
  let manager: AIServiceManager
  let mockAIService: Partial<ILlamaIndexAIService>
  let notifyCalls: any[] = []

  beforeEach(() => {
    vi.restoreAllMocks()
    notifyCalls = []

    mockAIService = {
      getServiceStatus: vi.fn().mockReturnValue(AIServiceStatus.STOPPED),
      healthCheck: vi.fn().mockResolvedValue(false),
      restart: vi.fn().mockResolvedValue(undefined)
    }

    manager = new AIServiceManager(
      () => mockAIService as ILlamaIndexAIService,
      () => true,
      async (...args: any[]) => {
        notifyCalls.push(args)
      }
    )

    vi.spyOn(ConfigOrchestrator.getInstance(), 'getValue').mockImplementation((key: string) => {
      if (key === 'AI_SERVICE_MODE') return 'local'
      if (key === 'ANALYSIS_MODE') return 'full'
      return undefined
    })
  })

  it('当 hasInstalledEngines === false 时，waitForAIServiceReady 立即返回 true，不等待 120s', async () => {
    engineBridgeService.hasInstalledEngines = false
    vi.spyOn(engineBridgeService, 'getSnapshot').mockReturnValue({
      available: true,
      backend: null,
      model: null,
      managed: true,
      circuitState: 'closed',
      exePath: null,
      devMode: false,
      port: 38400,
      version: null,
      backendMatchType: null,
      modelName: null,
      vramMb: null,
      modelCount: null,
      totalModelCount: 33,
      lastError: null,
      updatedAt: Date.now(),
      raw: { status: 'stopped' } as any
    })

    const startTime = Date.now()
    const ready = await manager.waitForAIServiceReady()
    const elapsed = Date.now() - startTime

    expect(ready).toBe(true)
    expect(elapsed).toBeLessThan(100) // 零等待 (<100ms)
    expect(mockAIService.restart).not.toHaveBeenCalled()
  })

  it('当本地引擎状态为 STOPPED 时，立即返回 true 放行队列', async () => {
    engineBridgeService.hasInstalledEngines = null
    vi.spyOn(engineBridgeService, 'getSnapshot').mockReturnValue({
      available: true,
      backend: null,
      model: null,
      managed: true,
      circuitState: 'closed',
      exePath: null,
      devMode: false,
      port: 38400,
      version: null,
      backendMatchType: null,
      modelName: null,
      vramMb: null,
      modelCount: null,
      totalModelCount: 33,
      lastError: null,
      updatedAt: Date.now(),
      raw: { status: 'stopped' } as any
    })
    mockAIService.getServiceStatus = vi.fn().mockReturnValue(AIServiceStatus.STOPPED)

    const startTime = Date.now()
    const ready = await manager.waitForAIServiceReady()
    const elapsed = Date.now() - startTime

    expect(ready).toBe(true)
    expect(elapsed).toBeLessThan(100)
    expect(mockAIService.restart).not.toHaveBeenCalled()
  })
})
