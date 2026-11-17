/**
 * Omni 端侧模型 Session 动态排空与内存释放单元测试 (Ticket 10)
 * 遵循 L3 规格书: docs/specs/unified-module-hibernation-and-energy-transparency-spec.md §3.4.2 & Ticket 10
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('C:\\mock-user-data'),
    isPackaged: false
  }
}))

vi.mock('electron-conf', () => ({
  Conf: vi.fn().mockImplementation(() => ({
    get: vi.fn(),
    set: vi.fn()
  }))
}))

import { ModuleHibernationCoordinator } from '../module-hibernation-coordinator'
import {
  IEngineBridgeService,
  IPowerMonitorService,
  ModuleRuntimeState,
  OmniModuleDrainResult,
  OmniModuleStatusResult
} from '../types'
import { IModuleRuntimeStore } from '../module-runtime-store'
import { EngineBridgeService } from '../../engine-bridge/engine-bridge-service'
import { omniService } from '../../system/omni-service'

describe('Ticket 10: Omni 端侧模型 Session 动态排空与内存释放', () => {
  describe('EngineBridgeService - drainOmniModule & getOmniModuleStatus', () => {
    let bridge: EngineBridgeService
    const originalFetch = globalThis.fetch

    beforeEach(() => {
      bridge = EngineBridgeService.getInstance()
      vi.spyOn(omniService, 'getBaseUrl').mockReturnValue('http://127.0.0.1:38115')
    })

    afterEach(() => {
      globalThis.fetch = originalFetch
      vi.restoreAllMocks()
    })

    it('成功发出 DELETE 请求并正确解析 releasedBytes', async () => {
      const mockResult: OmniModuleDrainResult = {
        success: true,
        releasedBytes: 250 * 1024 * 1024,
        message: 'session_unloaded'
      }

      let capturedUrl = ''
      let capturedMethod = ''

      globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
        capturedUrl = url
        capturedMethod = init?.method || ''
        return {
          ok: true,
          status: 200,
          json: async () => mockResult
        } as Response
      })

      const res = await bridge.drainOmniModule('pocket-cpu-int8-onnx', { waitDrainMs: 3500 })

      expect(capturedUrl).toContain(
        'http://127.0.0.1:38115/v1/modules/pocket-cpu-int8-onnx/session?wait_drain_ms=3500'
      )
      expect(capturedMethod).toBe('DELETE')
      expect(res.success).toBe(true)
      expect(res.releasedBytes).toBe(250 * 1024 * 1024)
    })

    it('当 Omni 返回 400 非白名单错误时，抛出明确异常', async () => {
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        return {
          ok: false,
          status: 400,
          json: async () => ({
            error: 'Module non-whitelisted-model cannot be dynamically hibernated'
          })
        } as Response
      })

      await expect(bridge.drainOmniModule('non-whitelisted-model')).rejects.toThrow(
        'Module non-whitelisted-model cannot be dynamically hibernated'
      )
    })

    it('当 Omni 服务探测端点可用时，成功返回 loaded 状态与 residentBytes', async () => {
      const mockStatus: OmniModuleStatusResult = {
        loaded: true,
        residentBytes: 200 * 1024 * 1024,
        serviceReachable: true
      }

      globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
        expect(url).toContain('/v1/modules/tts-m5-onnx/session/status')
        return {
          ok: true,
          status: 200,
          json: async () => mockStatus
        } as Response
      })

      const status = await bridge.getOmniModuleStatus('tts-m5-onnx')
      expect(status.loaded).toBe(true)
      expect(status.residentBytes).toBe(200 * 1024 * 1024)
      expect(status.serviceReachable).toBe(true)
    })

    it('当 Omni 服务不可达或 500 时，getOmniModuleStatus 安全降级返回 loaded: false', async () => {
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        throw new Error('Connection refused')
      })

      const status = await bridge.getOmniModuleStatus('asr-sensevoice-onnx')
      expect(status.loaded).toBe(false)
      expect(status.residentBytes).toBe(0)
      expect(status.serviceReachable).toBe(false)
    })
  })

  describe('ModuleHibernationCoordinator 与 Omni 排空联动', () => {
    let coordinator: ModuleHibernationCoordinator
    let mockStore: IModuleRuntimeStore
    let mockEngineBridge: IEngineBridgeService
    let mockLeaseRegistry: any
    let mockPowerMonitor: IPowerMonitorService
    let storeMap: Map<string, ModuleRuntimeState>

    const createInitialState = (
      id: string,
      residentBytes = 250 * 1024 * 1024
    ): ModuleRuntimeState => ({
      id,
      clusterId: 'analysis_suite',
      modelGeneration: 1,
      defaultMemoryKind: 'ram',
      effectiveMemoryKind: 'ram',
      i18nNameKey: '测试端侧模型',
      state: 'resident',
      residentBytes,
      lastActiveTimestamp: Date.now(),
      crashStreak: 0,
      unloadFailStreak: 0,
      blockedUnloadNoHandle: 0,
      blockedUnloadIdentity: null
    })

    beforeEach(() => {
      storeMap = new Map<string, ModuleRuntimeState>()
      storeMap.set(
        'pocket-cpu-int8-onnx',
        createInitialState('pocket-cpu-int8-onnx', 300 * 1024 * 1024)
      )
      storeMap.set('firefly-ai-engine', {
        ...createInitialState('firefly-ai-engine', 2 * 1024 * 1024 * 1024),
        effectiveMemoryKind: 'vram'
      })

      mockStore = {
        get: vi.fn((id: string) => storeMap.get(id)),
        getAll: vi.fn(() => Array.from(storeMap.values())),
        update: vi.fn((id: string, apply: (draft: ModuleRuntimeState) => void) => {
          const current = storeMap.get(id)
          if (current) {
            apply(current)
            return true
          }
          return false
        }),
        batchUpdate: vi.fn(),
        clear: vi.fn(() => storeMap.clear())
      } as unknown as IModuleRuntimeStore

      mockLeaseRegistry = {
        countActive: vi.fn(() => 0),
        countActiveByTarget: vi.fn(() => 0)
      }

      mockEngineBridge = {
        currentIdentity: vi.fn(() => null),
        stopServiceBounded: vi.fn().mockResolvedValue({ success: true }),
        isModelLoaded: vi.fn().mockResolvedValue(true),
        onEngineExit: vi.fn(() => () => {}),
        drainOmniModule: vi.fn().mockResolvedValue({
          success: true,
          releasedBytes: 280 * 1024 * 1024,
          message: 'session_unloaded'
        }),
        getOmniModuleStatus: vi.fn().mockResolvedValue({
          loaded: false,
          residentBytes: 0,
          serviceReachable: true
        })
      }

      mockPowerMonitor = {
        on: vi.fn(),
        off: vi.fn(),
        emit: vi.fn()
      }

      coordinator = new ModuleHibernationCoordinator({
        runtimeStore: mockStore,
        leaseRegistry: mockLeaseRegistry,
        engineBridgeService: mockEngineBridge,
        powerMonitor: mockPowerMonitor,
        getFreeMemory: () => 16 * 1024 * 1024 * 1024,
        getTotalMemory: () => 32 * 1024 * 1024 * 1024
      })
    })

    it('排空 Omni 模块时正确调用 drainOmniModule，并记录 lastReleasedBytes', async () => {
      await coordinator.drainModuleTwoStage('pocket-cpu-int8-onnx', 'test_drain_omni')

      expect(mockEngineBridge.drainOmniModule).toHaveBeenCalledWith(
        'pocket-cpu-int8-onnx',
        expect.any(Object)
      )
      const finalState = storeMap.get('pocket-cpu-int8-onnx')
      expect(finalState?.state).toBe('hibernated')
      expect(finalState?.lastReleasedBytes).toBe(280 * 1024 * 1024)
      expect(finalState?.residentBytes).toBe(0)
    })

    it('当 drainOmniModule 抛出异常时，Coordinator 优雅降级回落至原驻留估值完成排空', async () => {
      mockEngineBridge.drainOmniModule = vi
        .fn()
        .mockRejectedValue(new Error('Omni process crashed'))

      const success = await coordinator.drainModuleTwoStage('pocket-cpu-int8-onnx')
      expect(success).toBe(true)

      const finalState = storeMap.get('pocket-cpu-int8-onnx')
      expect(finalState?.state).toBe('hibernated')
      expect(finalState?.lastReleasedBytes).toBe(300 * 1024 * 1024)
      expect(finalState?.residentBytes).toBe(0)
    })
  })
})
