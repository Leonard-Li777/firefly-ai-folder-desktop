import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AsyncLocalStorage } from 'node:async_hooks'

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

const {
  mockResolveWorkspaceEffectiveConfig,
  mockDatabaseService,
  mockSolidifyCanonicalForTerminal,
  mockQueueFtsSync,
  mockCloudSyncTrigger
} = vi.hoisted(() => ({
  mockResolveWorkspaceEffectiveConfig: vi.fn(),
  mockDatabaseService: {
    db: null as any,
    getFileFingerprintByPath: vi.fn<(p: string) => string | null>(() => null),
    markFileAnalyzed: vi.fn<(wsId: number, p: string) => Promise<void>>(async () => {}),
    findRootWorkspaceDirectory: vi.fn(async () => ({ id: 1 }))
  },
  mockSolidifyCanonicalForTerminal: vi.fn(async () => {}),
  mockQueueFtsSync: vi.fn(),
  mockCloudSyncTrigger: vi.fn()
}))

vi.mock('../../system/workspace-analysis-context', () => ({
  resolveWorkspaceEffectiveConfig: (...args: any[]) => mockResolveWorkspaceEffectiveConfig(...args),
  lockWorkspaceAnalysisContext: vi.fn()
}))

vi.mock('../../database/database-service', () => ({
  databaseService: mockDatabaseService
}))

vi.mock('../canonical-text-service', () => ({
  solidifyCanonicalForTerminal: (...args: any[]) => mockSolidifyCanonicalForTerminal(...args)
}))

vi.mock('../fts-sync-hooks', () => ({
  queueFtsSync: (...args: any[]) => mockQueueFtsSync(...args)
}))

vi.mock('../../ai/cloud-sync-worker', () => ({
  cloudSyncWorker: {
    triggerSync: (...args: any[]) => mockCloudSyncTrigger(...args)
  }
}))

vi.mock('../../hibernation/module-hibernation-coordinator', () => ({
  moduleHibernationCoordinator: {
    notifyModuleResident: vi.fn(),
    cancelIdleHibernation: vi.fn(),
    setAsrExpectedActive: vi.fn(),
    acquireAsrActiveLease: vi.fn(() => ({ release: vi.fn() }))
  }
}))

import type { AnalysisQueueItem } from '@firefly/types'
import { AnalysisOrchestratorWorker } from '../analysis-orchestrator-worker'
import { FileProcessor, type CpuPhaseOutcome } from '../file-processor'
import { StageNotifier } from '../stage-notifier'
import {
  EngineNotAvailableError,
  type EngineGateContext
} from '../../engine-bridge/engine-swapping-coordinator'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'

function readCurrentEngineGateContext(): EngineGateContext | undefined {
  const storage = (globalThis as Record<string, unknown>).__fireflyEngineGateContextStorage as
    | AsyncLocalStorage<EngineGateContext>
    | undefined
  return storage?.getStore()
}

function createItem(id: number, overrides: Partial<AnalysisQueueItem> = {}): AnalysisQueueItem {
  return {
    id,
    path: `D:\\workspace\\file-${id}.txt`,
    name: `file-${id}.txt`,
    size: 1024,
    type: '.txt',
    itemType: 'file',
    taskType: 'analysis',
    workspaceId: 1,
    status: 'pending',
    progress: 0,
    addedAt: new Date().toISOString(),
    ...overrides
  } as AnalysisQueueItem
}

describe('AnalysisOrchestratorWorker 全通道统一门控与 FileProcessor 收口', () => {
  let statusHistory: Array<{
    itemId: number
    status: string
    progress: number
    error?: string
    extra?: any
  }>
  let itemMap: Map<number, AnalysisQueueItem>
  let updateItemStatus: ReturnType<typeof vi.fn>
  let queueManagerMock: { hasItem: ReturnType<typeof vi.fn> }
  let aiServiceManagerMock: { acquireStage3Capability: ReturnType<typeof vi.fn> }
  let directoryProcessorMock: { processDirectory: ReturnType<typeof vi.fn> }
  let fileProcessorMock: {
    processFile: ReturnType<typeof vi.fn>
    completeAsCpuOnly: ReturnType<typeof vi.fn>
  }
  let worker: AnalysisOrchestratorWorker

  beforeEach(() => {
    vi.clearAllMocks()
    statusHistory = []
    itemMap = new Map()

    vi.spyOn(ConfigOrchestrator.getInstance(), 'getValue').mockImplementation((key: string) => {
      if (key === 'AI_SERVICE_MODE') return 'local'
      return undefined
    })

    mockResolveWorkspaceEffectiveConfig.mockResolvedValue({
      effectiveParams: {
        analysisMode: 'full',
        reuseBasicAnalysisData: false
      }
    })

    updateItemStatus = vi.fn(
      (itemId: number, status: any, progress: number, error?: string, extra?: any) => {
        statusHistory.push({ itemId, status, progress, error, extra })
        const target = itemMap.get(itemId)
        if (target) {
          target.status = status
          target.progress = progress
        }
      }
    )

    queueManagerMock = {
      hasItem: vi.fn((id: number) => itemMap.has(id))
    }

    aiServiceManagerMock = {
      acquireStage3Capability: vi.fn()
    }

    directoryProcessorMock = {
      processDirectory: vi.fn(async () => {})
    }

    fileProcessorMock = {
      processFile: vi.fn(),
      completeAsCpuOnly: vi.fn(
        async (
          item: AnalysisQueueItem,
          _reason: string,
          _terminalKind: 'simple' | 'tier1_fallback',
          signal?: AbortSignal
        ) => {
          if (signal?.aborted) {
            updateItemStatus(item.id, 'pending', 0)
            return 'aborted'
          }
          if (item.status === 'completed' || item.status === 'failed') {
            return 'already_terminal'
          }
          updateItemStatus(item.id, 'completed', 100, undefined, { analysisStage: 2 })
          return 'completed'
        }
      )
    }

    worker = new AnalysisOrchestratorWorker(
      () => queueManagerMock as any,
      aiServiceManagerMock as any,
      directoryProcessorMock as any,
      fileProcessorMock as any,
      updateItemStatus as any
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('并行 10 文件 tier1_fallback 零 GPU 与 continue 收口 (AC-1a / AC-3)', () => {
    it('10 文件全部降级 completed(100, stage: 2)，processFile(gpu) 调用次数为 0，且工作区配置按批次缓存', async () => {
      const items = Array.from({ length: 10 }, (_, idx) => createItem(idx + 1))
      for (const it of items) itemMap.set(it.id, it)

      fileProcessorMock.processFile.mockImplementation(
        async (item: AnalysisQueueItem, _signal: AbortSignal, phase: string) => {
          if (phase === 'cpu') {
            return {
              outcome: 'proceed',
              fingerprint: `fp-${item.id}`,
              cpuSkipped: false
            } satisfies CpuPhaseOutcome
          }
          throw new Error('不应进入 GPU 推理阶段')
        }
      )

      aiServiceManagerMock.acquireStage3Capability.mockResolvedValue({
        granted: false,
        reason: 'engine_start_failed',
        terminalKind: 'tier1_fallback'
      })

      const controller = new AbortController()
      await worker.runParallel(items, controller.signal, 30_000)

      // 断言 GPU 阶段调用次数为 0
      const gpuCalls = fileProcessorMock.processFile.mock.calls.filter(c => c[2] === 'gpu')
      expect(gpuCalls).toHaveLength(0)

      // 断言 10 个文件全部走 completeAsCpuOnly 且全部 completed(100, stage: 2)
      expect(fileProcessorMock.completeAsCpuOnly).toHaveBeenCalledTimes(10)
      for (const it of items) {
        expect(it.status).toBe('completed')
        expect(it.progress).toBe(100)
        const completedEntry = statusHistory.find(
          s => s.itemId === it.id && s.status === 'completed'
        )
        expect(completedEntry?.extra).toEqual({ analysisStage: 2 })
      }

      // 断言 resolveWorkspaceEffectiveConfig 按 (batchId, workspaceId) 缓存，仅调用 1 次
      expect(mockResolveWorkspaceEffectiveConfig).toHaveBeenCalledTimes(1)
    })
  })

  describe('串行与并行早退 CpuPhaseOutcome 不覆盖既有终态', () => {
    it.each(['cache_hit', 'empty', 'simple', 'failed', 'skipped'] as const)(
      'runSerialItem 收到 CPU 终态 %s 时直接收口，不调 AI 租约/GPU/completeAsCpuOnly，且不调 omniAdapter.ensureMode',
      async terminalKind => {
        const item = createItem(101)
        itemMap.set(item.id, item)

        const omniAdapterMock = { ensureMode: vi.fn() }
        fileProcessorMock.processFile.mockImplementation(async () => {
          item.status = terminalKind === 'failed' ? 'failed' : 'completed'
          return { outcome: 'terminal', terminalKind } satisfies CpuPhaseOutcome
        })

        const controller = new AbortController()
        await worker.runSerialItem(item, controller.signal, true, omniAdapterMock as any, vi.fn())

        expect(omniAdapterMock.ensureMode).not.toHaveBeenCalled()
        expect(aiServiceManagerMock.acquireStage3Capability).not.toHaveBeenCalled()
        expect(fileProcessorMock.completeAsCpuOnly).not.toHaveBeenCalled()
        expect(fileProcessorMock.processFile).toHaveBeenCalledTimes(1)
        expect(fileProcessorMock.processFile).toHaveBeenCalledWith(item, controller.signal, 'cpu')
      }
    )

    it('runParallel 中 cache_hit / empty / failed 项跳过 AI 与 completeAsCpuOnly，仅 proceed 项继续 GPU', async () => {
      const items = [
        createItem(1), // cache_hit
        createItem(2), // empty
        createItem(3), // failed
        createItem(4) // proceed
      ]
      for (const it of items) itemMap.set(it.id, it)

      fileProcessorMock.processFile.mockImplementation(
        async (item: AnalysisQueueItem, _signal: AbortSignal, phase: string) => {
          if (phase === 'cpu') {
            if (item.id === 1) {
              item.status = 'completed'
              return { outcome: 'terminal', terminalKind: 'cache_hit' }
            }
            if (item.id === 2) {
              item.status = 'completed'
              return { outcome: 'terminal', terminalKind: 'empty' }
            }
            if (item.id === 3) {
              item.status = 'failed'
              return { outcome: 'terminal', terminalKind: 'failed' }
            }
            return { outcome: 'proceed', fingerprint: 'fp-4', cpuSkipped: false }
          }
          // GPU 阶段仅允许 item 4 进入
          item.status = 'completed'
        }
      )

      aiServiceManagerMock.acquireStage3Capability.mockResolvedValue({ granted: true })

      const controller = new AbortController()
      await worker.runParallel(items, controller.signal, 30_000)

      expect(aiServiceManagerMock.acquireStage3Capability).toHaveBeenCalledTimes(1)
      expect(fileProcessorMock.completeAsCpuOnly).not.toHaveBeenCalled()
      const gpuCalls = fileProcessorMock.processFile.mock.calls.filter(c => c[2] === 'gpu')
      expect(gpuCalls).toHaveLength(1)
      expect(gpuCalls[0][0].id).toBe(4)
      expect(items[2].status).toBe('failed')
    })
  })

  describe('Abort 取消 100% 回滚 pending(0) 且绝不标 completed (AC-4)', () => {
    it('acquireStage3Capability 等待期触发 Abort，当前项与未处理已提取项全部回滚 pending(0)', async () => {
      const items = [createItem(1), createItem(2), createItem(3)]
      for (const it of items) itemMap.set(it.id, it)

      const controller = new AbortController()

      fileProcessorMock.processFile.mockImplementation(
        async (item: AnalysisQueueItem, _signal: AbortSignal, phase: string) => {
          if (phase === 'cpu') {
            return { outcome: 'proceed', fingerprint: `fp-${item.id}`, cpuSkipped: false }
          }
        }
      )

      aiServiceManagerMock.acquireStage3Capability.mockImplementation(
        async (_mode: string, signal: AbortSignal) => {
          // 模拟等待期收到 Abort
          controller.abort()
          const err = new Error('Aborted')
          err.name = 'AbortError'
          if (signal.aborted) throw err
          return { granted: true }
        }
      )

      await worker.runParallel(items, controller.signal, 30_000)

      expect(fileProcessorMock.completeAsCpuOnly).not.toHaveBeenCalled()
      for (const it of items) {
        expect(it.status).toBe('pending')
        expect(it.progress).toBe(0)
      }
      expect(statusHistory.some(s => s.status === 'completed')).toBe(false)
    })

    it('FileProcessor.completeAsCpuOnly 在入口与异步中置阶段 Abort 均回滚 pending(0)，并严格执行 CAS 非终态守卫', async () => {
      const realFp = new FileProcessor(
        () => ({
          fileProcessor: undefined,
          dimensionAnalyzer: undefined,
          errorRecoveryConfig: {} as any
        }),
        updateItemStatus as any,
        vi.fn(),
        vi.fn(async () => ({})),
        vi.fn(() => 'mock'),
        vi.fn(async () => null)
      )

      // 1. 入口已 Abort
      const item1 = createItem(201, { status: 'analyzing' })
      itemMap.set(item1.id, item1)
      const c1 = new AbortController()
      c1.abort()
      const res1 = await realFp.completeAsCpuOnly(
        item1,
        'test',
        'tier1_fallback',
        c1.signal,
        'fp-201'
      )
      expect(res1).toBe('aborted')
      expect(item1.status).toBe('pending')
      expect(mockDatabaseService.markFileAnalyzed).not.toHaveBeenCalled()

      // 2. CAS 非终态守卫：已 completed / failed 幂等返回 already_terminal
      const itemDone = createItem(202, { status: 'completed' })
      itemMap.set(itemDone.id, itemDone)
      const res2 = await realFp.completeAsCpuOnly(
        itemDone,
        'test',
        'tier1_fallback',
        undefined,
        'fp-202'
      )
      expect(res2).toBe('already_terminal')
      expect(mockSolidifyCanonicalForTerminal).not.toHaveBeenCalled()

      // 3. markFileAnalyzed 异步执行期间触发 Abort -> 回滚 pending(0)，不调 solidifyCanonicalForTerminal
      const item3 = createItem(203, { status: 'analyzing' })
      itemMap.set(item3.id, item3)
      const c3 = new AbortController()
      mockDatabaseService.markFileAnalyzed.mockImplementationOnce(async () => {
        c3.abort()
      })
      const res3 = await realFp.completeAsCpuOnly(
        item3,
        'test',
        'tier1_fallback',
        c3.signal,
        'fp-203'
      )
      expect(res3).toBe('aborted')
      expect(item3.status).toBe('pending')
      expect(mockSolidifyCanonicalForTerminal).not.toHaveBeenCalled()

      // 4. 正常路径：严格按 terminalKind 固化 + queueFtsSync + completed(100, stage: 2) + cloudSync
      const item4 = createItem(204, { status: 'analyzing' })
      itemMap.set(item4.id, item4)
      const res4 = await realFp.completeAsCpuOnly(
        item4,
        'engine_unavailable',
        'tier1_fallback',
        undefined,
        'fp-204'
      )
      expect(res4).toBe('completed')
      expect(mockSolidifyCanonicalForTerminal).toHaveBeenCalledWith('tier1_fallback', 'fp-204')
      expect(mockQueueFtsSync).toHaveBeenCalledWith('fp-204')
      expect(mockCloudSyncTrigger).toHaveBeenCalledWith(2000)
      expect(item4.status).toBe('completed')
      expect(item4.progress).toBe(100)
    })
  })

  describe('首次 GPU 推理与 Catch 瞬态重试双路径 batch ALS 上下文 & 重试期不提前置 pending', () => {
    it('首次与瞬态重试均运行在 batch ALS 上下文，重试期间状态保持 analyzing 不提前置 pending', async () => {
      const item = createItem(301)
      itemMap.set(item.id, item)

      const observedContexts: Array<EngineGateContext | undefined> = []
      const statusBeforeRetryAcquire: string[] = []
      let gpuAttempt = 0

      fileProcessorMock.processFile.mockImplementation(
        async (_it: AnalysisQueueItem, _signal: AbortSignal, phase: string) => {
          if (phase === 'cpu') {
            return { outcome: 'proceed', fingerprint: 'fp-301', cpuSkipped: false }
          }
          observedContexts.push(readCurrentEngineGateContext())
          gpuAttempt += 1
          if (gpuAttempt === 1) {
            throw new EngineNotAvailableError('engine_service_stopped')
          }
          // 第 2 次重试成功
          item.status = 'completed'
        }
      )

      aiServiceManagerMock.acquireStage3Capability.mockImplementation(async () => {
        if (gpuAttempt === 1) {
          // 断言瞬态 Catch 原地重仲裁期间，item 状态仍保持 analyzing，未提前置 pending(0)
          statusBeforeRetryAcquire.push(item.status)
        }
        return { granted: true }
      })

      const controller = new AbortController()
      await worker.runParallel([item], controller.signal, 30_000)

      expect(gpuAttempt).toBe(2)
      expect(observedContexts).toHaveLength(2)
      expect(observedContexts[0]?.intent).toBe('batch')
      expect(observedContexts[0]?.signal).toBe(controller.signal)
      expect(observedContexts[1]?.intent).toBe('batch')
      expect(observedContexts[1]?.signal).toBe(controller.signal)

      expect(statusBeforeRetryAcquire).toEqual(['analyzing'])
      // 全程不应出现 pending(0) 状态回写
      expect(statusHistory.some(s => s.status === 'pending' && s.progress === 0)).toBe(false)
      expect(mockQueueFtsSync).toHaveBeenCalledWith('fp-301')
    })

    it('瞬态重试再次失败时，优雅降级 completeAsCpuOnly(tier1_fallback) 且不标 failed', async () => {
      const item = createItem(302)
      itemMap.set(item.id, item)

      fileProcessorMock.processFile.mockImplementation(
        async (_it: AnalysisQueueItem, _signal: AbortSignal, phase: string) => {
          if (phase === 'cpu') {
            return { outcome: 'proceed', fingerprint: 'fp-302', cpuSkipped: false }
          }
          throw new EngineNotAvailableError('engine_service_stopped')
        }
      )

      aiServiceManagerMock.acquireStage3Capability.mockResolvedValue({ granted: true })

      const controller = new AbortController()
      await worker.runSerialItem(item, controller.signal)

      expect(fileProcessorMock.completeAsCpuOnly).toHaveBeenCalledWith(
        item,
        'retry_inference_failed',
        'tier1_fallback',
        controller.signal,
        'fp-302'
      )
      expect(item.status).toBe('completed')
    })
  })

  describe('StageNotifier 承载 CpuPhaseOutcome', () => {
    it('先 notify 后 waitForStage2 与先 waitForStage2 后 notify 均准确返回 CpuPhaseOutcome', async () => {
      const notifier = new StageNotifier()
      const outcome1: CpuPhaseOutcome = { outcome: 'terminal', terminalKind: 'cache_hit' }
      notifier.notify(1, outcome1)
      await expect(notifier.waitForStage2(1, () => false)).resolves.toEqual(outcome1)

      const outcome2: CpuPhaseOutcome = {
        outcome: 'proceed',
        fingerprint: 'fp-2',
        cpuSkipped: true
      }
      const p = notifier.waitForStage2(2, () => false)
      notifier.notify(2, outcome2)
      await expect(p).resolves.toEqual(outcome2)
    })
  })
})
