import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => 'D:\\tmp', getVersion: () => '0.0.0' },
  ipcMain: { handle: vi.fn(), on: vi.fn() }
}))

vi.mock('electron-conf', () => ({
  Conf: class {
    get() {
      return undefined
    }
    set() {}
  }
}))

import type { AnalysisQueueItem, StageReuseDecision } from '@firefly/types'
import type { EffectiveWorkspaceAIConfigResult } from '../../system/workspace-analysis-context'
import {
  AnalysisWarmupBarrier,
  BatchPlanSession,
  DISPATCH_WINDOW_SIZE,
  PLAN_CHUNK_SIZE,
  deriveWindowWarmupPlan,
  resolveWarmupHintCode
} from '../analysis-warmup-barrier'
import { ModuleHibernationCoordinator } from '../../hibernation/module-hibernation-coordinator/module-hibernation-coordinator'

function makeItem(id: number, filePath: string): AnalysisQueueItem {
  return {
    id,
    path: filePath,
    name: filePath.split(/[\\/]/).pop() || `file-${id}`,
    size: 1024,
    type: filePath.includes('.') ? `.${filePath.split('.').pop()}` : '.txt',
    itemType: 'file',
    taskType: 'analysis',
    workspaceId: 1,
    status: 'pending',
    progress: 0,
    addedAt: new Date().toISOString()
  }
}

function makeEffectiveConfig(
  overrides: Partial<EffectiveWorkspaceAIConfigResult['effectiveParams']> = {},
  capOverrides: Partial<EffectiveWorkspaceAIConfigResult['capabilities']> = {}
): EffectiveWorkspaceAIConfigResult {
  return {
    workspaceId: 1,
    rawConfig: null,
    effectiveParams: {
      analysisMode: 'full',
      reuseBasicAnalysisData: true,
      enableImageOcr: true,
      ocrModelSize: 'small',
      maxDocumentOcrItems: 3,
      extractPages: 15,
      maxContentSizeKb: -1,
      audioAnalysisDurationSec: 30,
      videoAsrDurationSec: 30,
      videoSoftTokenBudget: 280,
      videoQuotaMax: 8,
      videoFrameQuotaMax: 8,
      videoCutSensitivity: 0.35,
      videoSamplingIntervalSeconds: 1.0,
      enableOfficeCover: true,
      enableVideoVisualAnalysis: true,
      ...overrides
    },
    capabilities: {
      asrEffectivelyEnabled: true,
      nsfwEffectivelyEnabled: true,
      faceEffectivelyEnabled: false,
      videoVisualAnalysisEnabled: true,
      ...capOverrides
    }
  } as EffectiveWorkspaceAIConfigResult
}

describe('AnalysisWarmupBarrier & BatchPlanSession (Slice 3B)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('BatchPlanSession 按 256 规划并取 <= 64 同源窗口供 deriveWindowWarmupPlan 精确推导', async () => {
    const items = Array.from({ length: 80 }, (_, idx) =>
      makeItem(idx + 1, idx < 64 ? `D:\\ws\\note-${idx}.txt` : `D:\\ws\\pic-${idx}.png`)
    )
    const session = new BatchPlanSession()
    const fakePlanner = vi.fn(async (_db, _ws, slice: ReadonlyArray<AnalysisQueueItem>) => {
      const m = new Map<number, StageReuseDecision>()
      for (const it of slice) {
        m.set(it.id, {
          action: 'fresh_cpu_and_ai',
          skipCpu: false,
          missingReasons: ['missing'],
          clearableTagGroups: ['fact', 'fused', 'visual'],
          preservedTagGroups: ['user']
        })
      }
      return m
    })

    await session.planChunkForWindow(
      {} as any,
      1,
      items,
      makeEffectiveConfig(),
      fakePlanner,
      'sig-v1'
    )
    expect(fakePlanner).toHaveBeenCalledTimes(1)
    expect(fakePlanner.mock.calls[0][2]).toHaveLength(80)
    expect(PLAN_CHUNK_SIZE).toBe(256)

    // 同区切配置签名变化时必须清空旧 decisions 并重新规划
    await session.planChunkForWindow(
      {} as any,
      1,
      items,
      makeEffectiveConfig({ ocrModelSize: 'tiny' }),
      fakePlanner,
      'sig-v2'
    )
    expect(fakePlanner).toHaveBeenCalledTimes(2)

    const win = session.takeWindow(items)
    expect(win).toHaveLength(DISPATCH_WINDOW_SIZE)

    // 前 64 个均为 .txt，绝不提前预热视觉塔 / NSFW / OCR / ASR；且 local 并行下 stage3AiMode 为 null（OD-2）
    const plan = deriveWindowWarmupPlan(win, session.decisions, makeEffectiveConfig(), {
      aiServiceMode: 'local',
      isCpuEngine: false,
      isParallelDispatch: true
    })
    expect(plan).toEqual({
      textAndLexicon: true,
      visionTower: false,
      nsfwDetector: false,
      imageOcr: false,
      asrModule: false,
      stage3AiMode: null
    })

    // 全部跳过 CPU 的图片窗口：绝不拉起 OCR/视觉塔
    const skipDecisions = new Map<number, StageReuseDecision>([
      [
        101,
        {
          action: 'reuse_cpu_refresh_ai',
          skipCpu: true,
          fingerprint: 'fp-101',
          missingReasons: [],
          clearableTagGroups: ['ai'],
          preservedTagGroups: ['fact', 'fused', 'visual', 'user']
        }
      ]
    ])
    const skippedPlan = deriveWindowWarmupPlan(
      [makeItem(101, 'D:\\ws\\cached.jpg')],
      skipDecisions,
      makeEffectiveConfig(),
      { aiServiceMode: 'cpu', isCpuEngine: true, isParallelDispatch: false }
    )
    expect(skippedPlan.visionTower).toBe(false)
    expect(skippedPlan.imageOcr).toBe(false)
    expect(skippedPlan.stage3AiMode).toBe('full')
  })

  it('AnalysisWarmupBarrier 快照未就绪时立即切入 warming_up；已全热驻留时 <300ms 零闪烁跳过；超时 >=300ms 切入且 Fail-Open', async () => {
    const barrier = new AnalysisWarmupBarrier()
    const phaseEvents: Array<{ phase: string; hint?: string }> = []
    const controller = new AbortController()

    const fastPlan = deriveWindowWarmupPlan(
      [makeItem(1, 'D:\\ws\\doc.txt')],
      new Map(),
      makeEffectiveConfig({ enableImageOcr: false }),
      { aiServiceMode: 'local', isCpuEngine: false, isParallelDispatch: true }
    )

    // 第 1 次（lastSnapshot === null 未就绪）：立即进入 warming_up ('preparing')
    await barrier.run(
      fastPlan,
      controller.signal,
      {
        warmupOmniEngine: vi.fn(async () => ({
          ready: true,
          visionReady: false,
          nsfwReady: false,
          ocrReady: false
        })),
        warmupAsrModule: vi.fn(async () => false),
        acquireAsrLease: vi.fn(() => ({ release: vi.fn() })),
        acquireStage3Capability: vi.fn(async () => false),
        getCurrentEmbeddingProfile: () => 'gemma_unified'
      },
      (phase, hintCode) => phaseEvents.push({ phase, hint: hintCode })
    )
    expect(phaseEvents).toEqual([{ phase: 'warming_up', hint: 'preparing' }])

    // 第 2 次（已有同 profile 快照且无需冷重载，耗时 <300ms）：零闪烁不重复触发 warming_up
    phaseEvents.length = 0
    await barrier.run(
      fastPlan,
      controller.signal,
      {
        warmupOmniEngine: vi.fn(async () => ({
          ready: true,
          visionReady: false,
          nsfwReady: false,
          ocrReady: false
        })),
        warmupAsrModule: vi.fn(async () => false),
        acquireAsrLease: vi.fn(() => ({ release: vi.fn() })),
        acquireStage3Capability: vi.fn(async () => false),
        getCurrentEmbeddingProfile: () => 'gemma_unified'
      },
      (phase, hintCode) => phaseEvents.push({ phase, hint: hintCode })
    )
    expect(phaseEvents).toHaveLength(0)

    // 第 3 次（含图片 OCR + 视觉，Fail-Open 报错）：仅依 plan 产出 loading_models 且放行不抛错
    const imgPlan = deriveWindowWarmupPlan(
      [makeItem(2, 'D:\\ws\\photo.png')],
      new Map(),
      makeEffectiveConfig(),
      { aiServiceMode: 'local', isCpuEngine: false, isParallelDispatch: true }
    )
    expect(resolveWarmupHintCode(imgPlan)).toBe('loading_models')

    const slowPromise = barrier.run(
      imgPlan,
      controller.signal,
      {
        warmupOmniEngine: vi.fn(
          () =>
            new Promise((_res, rej) => {
              setTimeout(() => rej(new Error('503 timeout')), 450)
            })
        ),
        warmupAsrModule: vi.fn(async () => false),
        acquireAsrLease: vi.fn(() => ({ release: vi.fn() })),
        acquireStage3Capability: vi.fn(async () => false),
        getCurrentEmbeddingProfile: () => 'gemma_unified'
      },
      (phase, hintCode) => phaseEvents.push({ phase, hint: hintCode })
    )

    expect(phaseEvents).toEqual([{ phase: 'warming_up', hint: 'loading_models' }])

    await vi.advanceTimersByTimeAsync(500)
    await expect(slowPromise).resolves.toMatchObject({
      phaseEnteredWarmingUp: true,
      hintCode: 'loading_models'
    })
  })

  it('AnalysisWarmupBarrier 收到 AbortSignal 立即上抛 AbortError 并释放已申请的 ASR 租约', async () => {
    const barrier = new AnalysisWarmupBarrier()
    const controller = new AbortController()
    const releaseSpy = vi.fn()
    const audioPlan = deriveWindowWarmupPlan(
      [makeItem(3, 'D:\\ws\\clip.mp3')],
      new Map(),
      makeEffectiveConfig(),
      { aiServiceMode: 'local', isCpuEngine: false, isParallelDispatch: true }
    )

    const p = barrier.run(
      audioPlan,
      controller.signal,
      {
        warmupOmniEngine: vi.fn(
          (_plan, sig) =>
            new Promise((_, rej) => {
              sig.addEventListener('abort', () =>
                rej(Object.assign(new Error('Aborted'), { name: 'AbortError' }))
              )
            })
        ),
        warmupAsrModule: vi.fn(async () => true),
        acquireAsrLease: () => ({ release: releaseSpy }),
        acquireStage3Capability: vi.fn(async () => false),
        getCurrentEmbeddingProfile: () => 'classic_light'
      },
      vi.fn()
    )

    controller.abort()
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(releaseSpy).toHaveBeenCalledTimes(1)
  })

  it('ModuleHibernationCoordinator.acquireAsrActiveLease 支持引用计数重叠与 5s 宽限期续期防卸载抖动', async () => {
    const coordinator = new ModuleHibernationCoordinator() as any
    const l1 = coordinator.acquireAsrActiveLease()
    const l2 = coordinator.acquireAsrActiveLease()
    expect(coordinator.asrExpectedActive).toBe(true)

    // 释放 l1 仍有 l2 -> 保持活跃
    l1.release()
    l1.release() // 幂等
    expect(coordinator.asrExpectedActive).toBe(true)

    // 释放 l2 归零 -> 进入 5s 宽限期（未到 5s 仍为 true）
    l2.release()
    await vi.advanceTimersByTimeAsync(3000)
    expect(coordinator.asrExpectedActive).toBe(true)

    // 宽限期内新窗口续租 -> 取消卸载并继续保持 true
    const l3 = coordinator.acquireAsrActiveLease()
    await vi.advanceTimersByTimeAsync(4000)
    expect(coordinator.asrExpectedActive).toBe(true)

    // l3 释放且完整走完 5000ms -> 最终置 false
    l3.release()
    await vi.advanceTimersByTimeAsync(5000)
    expect(coordinator.asrExpectedActive).toBe(false)
  })
})
