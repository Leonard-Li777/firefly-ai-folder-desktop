/**
 * Desktop 视频视觉分析预算降级落库状态机单测 (Ticket 02 / Spec v1.7.3 §2.4.2)
 *
 * 覆盖验收准则：
 * 1. `budget_structural`：0 次重试，直接标记 `analysis_degraded`，记录诊断元数据，严禁写完成态；
 * 2. `pre_elapsed`：允许最多 2 次退避重试；重试恢复则正常完成；重试耗尽则标记 `analysis_degraded` 且严禁写完成态；
 * 3. `executeSingleVideoSegment` 集成：收到降级标记时严禁调用 `markVideoSegmentCompleted`，回写结构化降级 JSON 与大白话提示。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@app/languages', () => ({
  t: (s: string) => s
}))

import {
  decideVideoDegradedAction,
  extractVideoVisualDegradation,
  formatVideoDegradedUserMessage,
  MAX_PRE_ELAPSED_RETRIES,
  runVideoPerceiveWithDegradedRetry
} from '../file-processor/video-degraded-state-machine'
import { executeSingleVideoSegment } from '../file-processor/video-segment-executor'

function createMockDb() {
  return {
    prepare: vi.fn(() => ({
      all: vi.fn(() => []),
      run: vi.fn()
    }))
  }
}

describe('Ticket 02: 视频视觉预算降级落库状态机', () => {
  it('纯函数识别与退避策略：仅 pre_elapsed 允许 <=2 次重试，budget_structural 直接标 analysis_degraded', () => {
    expect(
      extractVideoVisualDegradation({
        degraded: 'visual_skipped_budget',
        degraded_reason: 'pre_elapsed'
      })
    ).toEqual({
      degraded: 'visual_skipped_budget',
      degradedReason: 'pre_elapsed'
    })

    expect(
      extractVideoVisualDegradation({
        degraded: 'visual_skipped_budget',
        degraded_reason: 'budget_structural'
      })
    ).toEqual({
      degraded: 'visual_skipped_budget',
      degradedReason: 'budget_structural'
    })

    expect(extractVideoVisualDegradation({ degraded: undefined })).toBeNull()

    expect(decideVideoDegradedAction('pre_elapsed', 0)).toMatchObject({
      action: 'retry',
      nextAttempt: 1
    })
    expect(decideVideoDegradedAction('pre_elapsed', 1)).toMatchObject({
      action: 'retry',
      nextAttempt: 2
    })
    expect(decideVideoDegradedAction('pre_elapsed', MAX_PRE_ELAPSED_RETRIES)).toEqual({
      action: 'mark_degraded',
      status: 'analysis_degraded'
    })
    expect(decideVideoDegradedAction('budget_structural', 0)).toEqual({
      action: 'mark_degraded',
      status: 'analysis_degraded'
    })
  })

  it('大白话用户提示零工程黑话（AGENTS.md §2.16）', () => {
    const msg1 = formatVideoDegradedUserMessage('budget_structural')
    const msg2 = formatVideoDegradedUserMessage('pre_elapsed')
    for (const msg of [msg1, msg2]) {
      expect(msg.length).toBeGreaterThan(10)
      expect(msg).not.toMatch(/perceive|budget|asr|watchdog|timeout|pre_elapsed|onnx|token/i)
    }
  })

  it('budget_structural 0 次重试直接标 analysis_degraded 并携带诊断三元组', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)
    const perceive = vi.fn().mockResolvedValue({
      perception: {
        degraded: 'visual_skipped_budget',
        degraded_reason: 'budget_structural',
        video_chunks: []
      }
    })

    const out = await runVideoPerceiveWithDegradedRetry(perceive, {
      filePath: 'D:\\videos\\short_cap.mp4',
      perceiveTimeoutSec: 35,
      asrEstSec: 20,
      sleep
    })

    expect(perceive).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(out.retriesUsed).toBe(0)
    expect(out.degradedRecord).toMatchObject({
      status: 'analysis_degraded',
      degraded: 'visual_skipped_budget',
      perceive_timeout_sec: 35,
      asr_est_sec: 20,
      degraded_reason: 'budget_structural'
    })
  })

  it('pre_elapsed 最多重试 2 次：第 2 次恢复正常则不降级；持续降级则标 analysis_degraded', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined)

    // 场景 A：第 2 次重试恢复正常
    const recoverPerceive = vi
      .fn()
      .mockResolvedValueOnce({
        perception: { degraded: 'visual_skipped_budget', degraded_reason: 'pre_elapsed' }
      })
      .mockResolvedValueOnce({
        perception: { degraded: 'visual_skipped_budget', degraded_reason: 'pre_elapsed' }
      })
      .mockResolvedValueOnce({
        perception: {
          video_chunks: [{ chunk_index: 0, start_sec: 0, end_sec: 10 }]
        }
      })

    const recovered = await runVideoPerceiveWithDegradedRetry(recoverPerceive, {
      filePath: 'D:\\videos\\recover.mp4',
      perceiveTimeoutSec: 180,
      asrEstSec: 30,
      sleep
    })
    expect(recoverPerceive).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(recovered.degradedRecord).toBeNull()
    expect(recovered.retriesUsed).toBe(2)

    // 场景 B：连续 3 次均 pre_elapsed → 重试超限标 analysis_degraded
    sleep.mockClear()
    const alwaysDegraded = vi.fn().mockResolvedValue({
      perception: { degraded: 'visual_skipped_budget', degraded_reason: 'pre_elapsed' }
    })
    const exhausted = await runVideoPerceiveWithDegradedRetry(alwaysDegraded, {
      filePath: 'D:\\videos\\exhausted.mp4',
      perceiveTimeoutSec: 120,
      asrEstSec: 15,
      sleep
    })
    expect(alwaysDegraded).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(exhausted.degradedRecord).toMatchObject({
      status: 'analysis_degraded',
      perceive_timeout_sec: 120,
      asr_est_sec: 15,
      degraded_reason: 'pre_elapsed'
    })
  })

  it('executeSingleVideoSegment 收到 visual_skipped_budget 严禁写 completed，直落 terminal failed 且写 analysis_degraded 元数据', async () => {
    const markVideoSegmentCompleted = vi.fn()
    const markVideoSegmentFailedOrPending = vi.fn()
    const markVideoSegmentTerminalFailed = vi.fn()
    const perceive = vi.fn().mockResolvedValue({
      perception: {
        degraded: 'visual_skipped_budget',
        degraded_reason: 'budget_structural',
        video_chunks: []
      }
    })

    const res = await executeSingleVideoSegment({
      segment: {
        fileFingerprint: 'fp_degraded_1',
        filePath: 'D:\\videos\\degraded.mp4',
        segmentIndex: 1,
        startPtsSec: 300,
        endPtsSec: 600
      },
      effectiveLimitSec: 1800,
      paramsHash: 'v2_60_140_medium',
      perceptionParams: {
        enableVideoVisualAnalysis: true,
        perceiveTimeoutSec: 40
      },
      deps: {
        db: createMockDb(),
        existsSync: () => true,
        degradedRetrySleep: async () => {},
        omniClient: { deleteVectors: vi.fn() },
        anydocService: { perceive },
        databaseService: {
          markVideoSegmentProcessing: vi.fn(() => true),
          markVideoSegmentCompleted,
          markVideoSegmentFailedOrPending,
          markVideoSegmentTerminalFailed,
          rollbackVideoSegmentProcessing: vi.fn(),
          replaceVideoChunksInRange: vi.fn(),
          insertVideoChunks: vi.fn(),
          upsertFileVectorToOmni: vi.fn(),
          upsertFileVectorsToOmni: vi.fn()
        }
      }
    })

    expect(res.outcome).toBe('degraded')
    expect(res.degradedMetadata).toMatchObject({
      status: 'analysis_degraded',
      perceive_timeout_sec: 40,
      asr_est_sec: 0,
      degraded_reason: 'budget_structural'
    })
    expect(markVideoSegmentCompleted).not.toHaveBeenCalled()
    expect(markVideoSegmentFailedOrPending).not.toHaveBeenCalled()
    expect(markVideoSegmentTerminalFailed).toHaveBeenCalledTimes(1)
    const persistedJson = JSON.parse(markVideoSegmentTerminalFailed.mock.calls[0][2])
    expect(persistedJson).toMatchObject({
      status: 'analysis_degraded',
      perceive_timeout_sec: 40,
      asr_est_sec: 0,
      degraded_reason: 'budget_structural'
    })
  })
})
