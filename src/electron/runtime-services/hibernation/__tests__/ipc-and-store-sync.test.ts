/**
 * IPC 通道集成与渲染层快照响应式订阅单元测试 (Ticket 11)
 * 遵循 L3 规格书: docs/specs/unified-module-hibernation-and-energy-transparency-spec.md §3.3 & §3.4.1
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ipcMain, BrowserWindow } from 'electron'
import { projectMemoryGauges } from '../memory-gauges'
import { HibernationSnapshot, ModuleRuntimeMetric, ModuleRuntimeState } from '../types'
import { registerHibernationIPCHandlers } from '../../ipc/hibernation-ipc-handler'
import { ModuleHibernationCoordinator } from '../module-hibernation-coordinator'
import { IModuleRuntimeStore } from '../module-runtime-store'
import {
  selectHibernationGauges,
  useHibernationStore
} from '../../../../renderer/stores/hibernation-store'

describe('Ticket 11: IPC 通道集成与渲染层快照响应式订阅', () => {
  describe('projectMemoryGauges 纯函数投影', () => {
    it('正常驻留与休眠模块分别正确分流 RAM 与 VRAM', () => {
      const metrics: ModuleRuntimeMetric[] = [
        {
          id: 'pocket-cpu-int8-onnx',
          clusterId: 'analysis_suite',
          modelGeneration: 1,
          defaultMemoryKind: 'ram',
          effectiveMemoryKind: 'ram',
          i18nNameKey: '轻量CPU',
          state: 'resident',
          residentBytes: 300 * 1024 * 1024,
          residentSample: {
            sampleSeq: 1,
            bytes: 320 * 1024 * 1024,
            kind: 'ram',
            modelGeneration: 1,
            sampledAt: Date.now()
          },
          lastActiveTimestamp: Date.now(),
          crashStreak: 0,
          unloadFailStreak: 0,
          blockedUnloadNoHandle: 0,
          blockedUnloadIdentity: null,
          activeTasks: 1
        },
        {
          id: 'firefly-ai-engine',
          clusterId: 'analysis_suite',
          modelGeneration: 2,
          defaultMemoryKind: 'vram',
          effectiveMemoryKind: 'vram',
          i18nNameKey: '本地大模型',
          state: 'hibernated',
          residentBytes: 0,
          lastReleased: {
            releaseId: 'rel-1',
            bytes: 1800 * 1024 * 1024,
            kind: 'vram',
            modelGeneration: 2,
            state: 'available',
            releasedAt: Date.now()
          },
          lastActiveTimestamp: Date.now(),
          crashStreak: 0,
          unloadFailStreak: 0,
          blockedUnloadNoHandle: 0,
          blockedUnloadIdentity: null,
          activeTasks: 0
        }
      ]

      const gauges = projectMemoryGauges(metrics)
      expect(gauges.totalResidentRamBytes).toBe(320 * 1024 * 1024)
      expect(gauges.totalResidentVramBytes).toBe(0)
      expect(gauges.totalSavedVramBytes).toBe(1800 * 1024 * 1024)
      expect(gauges.totalSavedRamBytes).toBe(0)
      expect(gauges.hasUncertainMemoryModules).toBe(false)
      expect(gauges.hasUncertainVramModules).toBe(false)
      expect(gauges.uncertainKinds).toHaveLength(0)
    })

    it('TC-31-T: RAM 模块处于跨代未决状态时，hasUncertainVramModules 严格为 false 但 hasUncertainMemoryModules 为 true', () => {
      const metrics: ModuleRuntimeMetric[] = [
        {
          id: 'pocket-cpu-int8-onnx',
          clusterId: 'analysis_suite',
          modelGeneration: 2, // 当前代次是 2
          defaultMemoryKind: 'ram',
          effectiveMemoryKind: 'ram',
          i18nNameKey: '轻量CPU',
          state: 'resident',
          residentBytes: 300 * 1024 * 1024,
          residentSample: {
            sampleSeq: 1,
            bytes: 300 * 1024 * 1024,
            kind: 'ram',
            modelGeneration: 1, // 残留代次是 1，跨代不匹配！
            sampledAt: Date.now()
          },
          lastActiveTimestamp: Date.now(),
          crashStreak: 0,
          unloadFailStreak: 0,
          blockedUnloadNoHandle: 0,
          blockedUnloadIdentity: null,
          activeTasks: 0
        }
      ]

      const gauges = projectMemoryGauges(metrics)
      expect(gauges.hasUncertainVramModules).toBe(false)
      expect(gauges.hasUncertainMemoryModules).toBe(true)
      expect(gauges.uncertainKinds).toContain('ram')
      expect(gauges.uncertainKinds).not.toContain('vram')
      // 不盲目累加未决跨代采样
      expect(gauges.totalResidentRamBytes).toBe(0)
    })

    it('当模块处于 resident 但物理采样缺失或 <= 0 时，标记占用确认中', () => {
      const metrics: ModuleRuntimeMetric[] = [
        {
          id: 'tts-m5-onnx',
          clusterId: 'tts_media',
          modelGeneration: 1,
          defaultMemoryKind: 'ram',
          effectiveMemoryKind: 'ram',
          i18nNameKey: '语音合成',
          state: 'resident',
          residentBytes: 200 * 1024 * 1024,
          residentSample: undefined, // 采样缺失
          lastActiveTimestamp: Date.now(),
          crashStreak: 0,
          unloadFailStreak: 0,
          blockedUnloadNoHandle: 0,
          blockedUnloadIdentity: null,
          activeTasks: 1
        }
      ]

      const gauges = projectMemoryGauges(metrics)
      expect(gauges.hasUncertainMemoryModules).toBe(true)
      expect(gauges.uncertainKinds).toContain('ram')
    })

    it('当休眠释放快照处于 reserved 预留中时，标记对应介质未决', () => {
      const metrics: ModuleRuntimeMetric[] = [
        {
          id: 'firefly-ai-engine',
          clusterId: 'analysis_suite',
          modelGeneration: 1,
          defaultMemoryKind: 'vram',
          effectiveMemoryKind: 'vram',
          i18nNameKey: '本地大模型',
          state: 'hibernated',
          residentBytes: 0,
          lastReleased: {
            releaseId: 'rel-2',
            bytes: 2000 * 1024 * 1024,
            kind: 'vram',
            modelGeneration: 1,
            state: 'reserved', // 预留中
            releasedAt: Date.now()
          },
          lastActiveTimestamp: Date.now(),
          crashStreak: 0,
          unloadFailStreak: 0,
          blockedUnloadNoHandle: 0,
          blockedUnloadIdentity: null,
          activeTasks: 0
        }
      ]

      const gauges = projectMemoryGauges(metrics)
      expect(gauges.hasUncertainMemoryModules).toBe(true)
      expect(gauges.hasUncertainVramModules).toBe(true)
      expect(gauges.uncertainKinds).toContain('vram')
      expect(gauges.totalSavedVramBytes).toBe(0)
    })
  })

  describe('主进程 IPC Handler 注册与通信契约', () => {
    let mockCoordinator: any
    let registeredHandlers: Map<string, Function>
    let mockIpc: any
    let cleanupIpc: () => void

    beforeEach(() => {
      registeredHandlers = new Map()

      mockIpc = {
        handle: vi.fn((channel: string, handler: Function) => {
          registeredHandlers.set(channel, handler)
        }),
        removeHandler: vi.fn((channel: string) => {
          registeredHandlers.delete(channel)
        })
      }

      mockCoordinator = {
        getSnapshot: vi.fn().mockResolvedValue({
          enabled: true,
          isEnergySaving: true,
          totalResidentRamBytes: 300,
          totalResidentVramBytes: 0,
          totalSavedRamBytes: 0,
          totalSavedVramBytes: 1800,
          availableMemoryBytes: 8000,
          hasUncertainVramModules: false,
          hasUncertainMemoryModules: false,
          uncertainKinds: [],
          modules: []
        }),
        reclaimAll: vi.fn().mockResolvedValue({ success: true, releasedBytes: 500 }),
        forceReset: vi.fn().mockResolvedValue(true),
        retryModule: vi.fn().mockResolvedValue(true),
        onSnapshotChanged: vi.fn(() => () => {})
      }

      cleanupIpc = registerHibernationIPCHandlers(mockCoordinator, mockIpc)
    })

    afterEach(() => {
      cleanupIpc?.()
      vi.restoreAllMocks()
    })

    it('正确注册全量 IPC 通道（含兼容别名）', () => {
      expect(registeredHandlers.has('module-hibernation:get-snapshot')).toBe(true)
      expect(registeredHandlers.has('get-hibernation-snapshot')).toBe(true)
      expect(registeredHandlers.has('module-hibernation:reclaim-all')).toBe(true)
      expect(registeredHandlers.has('reclaim-all-hibernatable-modules')).toBe(true)
      expect(registeredHandlers.has('module-hibernation:force-reset')).toBe(true)
      expect(registeredHandlers.has('module-hibernation:retry-module')).toBe(true)
    })

    it('调用 get-snapshot 通道返回 Coordinator 快照', async () => {
      const handler = registeredHandlers.get('module-hibernation:get-snapshot')!
      const result = await handler()
      expect(mockCoordinator.getSnapshot).toHaveBeenCalled()
      expect(result.totalSavedVramBytes).toBe(1800)
    })

    it('调用 reclaim-all 通道正确触发全量排空', async () => {
      const handler = registeredHandlers.get('module-hibernation:reclaim-all')!
      const result = await handler()
      expect(mockCoordinator.reclaimAll).toHaveBeenCalled()
      expect(result.releasedBytes).toBe(500)
    })

    it('调用 force-reset 与 retry-module 通道传递 targetId', async () => {
      const resetHandler = registeredHandlers.get('module-hibernation:force-reset')!
      await resetHandler(null, 'firefly-ai-engine')
      expect(mockCoordinator.forceReset).toHaveBeenCalledWith('firefly-ai-engine')

      const retryHandler = registeredHandlers.get('module-hibernation:retry-module')!
      await retryHandler(null, 'pocket-cpu-int8-onnx')
      expect(mockCoordinator.retryModule).toHaveBeenCalledWith('pocket-cpu-int8-onnx')
    })
  })

  describe('渲染进程 useHibernationStore 响应式订阅', () => {
    let mockBridge: any
    let listenerCallback: ((snap: any) => void) | null = null

    beforeEach(() => {
      listenerCallback = null
      mockBridge = {
        getSnapshot: vi.fn().mockResolvedValue({
          enabled: true,
          isEnergySaving: false,
          totalResidentRamBytes: 300,
          totalResidentVramBytes: 0,
          totalSavedRamBytes: 0,
          totalSavedVramBytes: 0,
          availableMemoryBytes: 8000,
          hasUncertainVramModules: false,
          hasUncertainMemoryModules: false,
          uncertainKinds: [],
          modules: []
        }),
        reclaimAll: vi.fn().mockResolvedValue({ success: true, releasedBytes: 300 }),
        forceReset: vi.fn().mockResolvedValue(true),
        retryModule: vi.fn().mockResolvedValue(true),
        onSnapshotChanged: vi.fn((cb: any) => {
          listenerCallback = cb
          return () => {
            listenerCallback = null
          }
        })
      }
      ;(globalThis as any).window = {
        hibernation: mockBridge
      }
    })

    afterEach(() => {
      delete (globalThis as any).window
      vi.restoreAllMocks()
    })

    it('fetchSnapshot 成功拉取并更新 store 快照', async () => {
      await useHibernationStore.getState().fetchSnapshot()
      const state = useHibernationStore.getState()
      expect(state.snapshot).not.toBeNull()
      expect(state.snapshot?.totalResidentRamBytes).toBe(300)
      expect(state.loading).toBe(false)
    })

    it('reclaimAll 成功释放后更新 lastReclaimedBytes 并触发重新获取', async () => {
      const res = await useHibernationStore.getState().reclaimAll()
      expect(res.success).toBe(true)
      expect(res.releasedBytes).toBe(300)
      expect(useHibernationStore.getState().lastReclaimedBytes).toBe(300)
      expect(mockBridge.getSnapshot).toHaveBeenCalled()
    })

    it('subscribe 监听广播并在收到快照变更时实时响应更新', () => {
      const unsubscribe = useHibernationStore.getState().subscribe()
      expect(mockBridge.onSnapshotChanged).toHaveBeenCalled()
      expect(useHibernationStore.getState().isSubscribed).toBe(true)

      const updatedSnapshot: HibernationSnapshot = {
        enabled: true,
        isEnergySaving: true,
        totalResidentRamBytes: 0,
        totalResidentVramBytes: 0,
        totalSavedRamBytes: 300,
        totalSavedVramBytes: 0,
        availableMemoryBytes: 8300,
        hasUncertainVramModules: false,
        hasUncertainMemoryModules: false,
        uncertainKinds: [],
        modules: []
      }

      // 模拟主进程推送
      listenerCallback!(updatedSnapshot)
      expect(useHibernationStore.getState().snapshot?.totalSavedRamBytes).toBe(300)

      unsubscribe()
      expect(useHibernationStore.getState().isSubscribed).toBe(false)
    })

    it('selectHibernationGauges 选择器纯函数派生', () => {
      const snapshot: HibernationSnapshot = {
        enabled: true,
        isEnergySaving: true,
        totalResidentRamBytes: 100,
        totalResidentVramBytes: 200,
        totalSavedRamBytes: 300,
        totalSavedVramBytes: 400,
        availableMemoryBytes: 8000,
        hasUncertainVramModules: false,
        hasUncertainMemoryModules: false,
        uncertainKinds: [],
        modules: [
          {
            id: 'pocket-cpu-int8-onnx',
            clusterId: 'analysis_suite',
            modelGeneration: 1,
            defaultMemoryKind: 'ram',
            effectiveMemoryKind: 'ram',
            i18nNameKey: '轻量CPU',
            state: 'hibernated',
            residentBytes: 0,
            lastReleased: {
              releaseId: 'r1',
              bytes: 300,
              kind: 'ram',
              modelGeneration: 1,
              state: 'available',
              releasedAt: Date.now()
            },
            lastActiveTimestamp: Date.now(),
            crashStreak: 0,
            unloadFailStreak: 0,
            blockedUnloadNoHandle: 0,
            blockedUnloadIdentity: null,
            activeTasks: 0
          }
        ]
      }

      const gauges = selectHibernationGauges(snapshot)
      expect(gauges.totalSavedRamBytes).toBe(300)
      expect(gauges.isEnergySaving).toBe(true)
    })
  })
})
