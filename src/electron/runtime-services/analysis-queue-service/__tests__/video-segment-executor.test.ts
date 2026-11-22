import { describe, it, expect, vi } from 'vitest'
import { executeSingleVideoSegment } from '../file-processor/video-segment-executor'

function createMockDb(oldChunkIndices: number[]) {
  return {
    prepare: vi.fn((sql: string) => ({
      all: vi.fn(() => oldChunkIndices.map(chunk_index => ({ chunk_index }))),
      run: vi.fn()
    }))
  }
}

describe('executeSingleVideoSegment (Ticket 01)', () => {
  it('U-08: 态 1 (vector_saved=true) 下仅差集删除 old \\ new 孤儿向量，绝不删刚写入的新向量，且同步回写 paramsHash', async () => {
    const deleteVectors = vi.fn().mockResolvedValue(undefined)
    const replaceVideoChunksInRange = vi.fn()
    const insertVideoChunks = vi.fn()
    const upsertFileVectorsToOmni = vi.fn().mockResolvedValue(undefined)
    const markVideoSegmentCompleted = vi.fn()
    const markVideoSegmentFailedOrPending = vi.fn()
    const callOrder: string[] = []

    deleteVectors.mockImplementation(async () => {
      callOrder.push('deleteVectors')
    })
    replaceVideoChunksInRange.mockImplementation(() => {
      callOrder.push('replaceVideoChunksInRange')
    })
    markVideoSegmentCompleted.mockImplementation(() => {
      callOrder.push('markVideoSegmentCompleted')
    })

    const res = await executeSingleVideoSegment({
      segment: {
        fileFingerprint: 'fp_vid_1',
        filePath: 'D:\\videos\\demo.mp4',
        segmentIndex: 1,
        startPtsSec: 300,
        endPtsSec: 600
      },
      effectiveLimitSec: 1800,
      paramsHash: 'v2_60_140_medium',
      perceptionParams: {
        enableVideoVisualAnalysis: true,
        videoFrameQuotaMax: 60
      },
      deps: {
        db: createMockDb([10, 11, 12]),
        existsSync: () => true,
        omniClient: { deleteVectors },
        anydocService: {
          perceive: vi.fn().mockResolvedValue({
            perception: {
              vector_saved: true,
              video_sampling_interval_seconds: 5.0,
              video_chunks: [
                { chunk_index: 10, start_sec: 300, end_sec: 305 },
                { chunk_index: 11, start_sec: 305, end_sec: 310 }
              ]
            }
          })
        },
        databaseService: {
          markVideoSegmentProcessing: vi.fn(() => true),
          markVideoSegmentCompleted,
          markVideoSegmentFailedOrPending,
          rollbackVideoSegmentProcessing: vi.fn(),
          replaceVideoChunksInRange,
          insertVideoChunks,
          upsertFileVectorToOmni: vi.fn(),
          upsertFileVectorsToOmni
        }
      }
    })

    expect(res).toEqual({ outcome: 'completed', frameCount: 2 })
    // 差集清理仅删 c12，绝不删 c10/c11
    expect(deleteVectors).toHaveBeenCalledTimes(1)
    expect(deleteVectors).toHaveBeenCalledWith(['fp_vid_1:c12'])
    // 严格先差集清理，再写 SQLite，再标 completed
    expect(callOrder).toEqual([
      'deleteVectors',
      'replaceVideoChunksInRange',
      'markVideoSegmentCompleted'
    ])
    // 态 1 不回传向量
    expect(upsertFileVectorsToOmni).not.toHaveBeenCalled()
    // 同步回写 paramsHash
    expect(markVideoSegmentCompleted).toHaveBeenCalledWith('fp_vid_1', 1, {
      frameCount: 2,
      visualEmbeddedCount: 2,
      asrTranscriptChars: 0,
      paramsHash: 'v2_60_140_medium'
    })
    expect(markVideoSegmentFailedOrPending).not.toHaveBeenCalled()
  })

  it('U-08b: 态 3 切片向量回传失败时必抛错，阻断写假 completed 并回写 failed/pending', async () => {
    const markVideoSegmentCompleted = vi.fn()
    const markVideoSegmentFailedOrPending = vi.fn()

    const res = await executeSingleVideoSegment({
      segment: {
        fileFingerprint: 'fp_vid_2',
        filePath: 'D:\\videos\\demo2.mp4',
        segmentIndex: 1,
        startPtsSec: 300,
        endPtsSec: 600
      },
      effectiveLimitSec: 1800,
      paramsHash: 'v2_60_140_medium',
      perceptionParams: { enableVideoVisualAnalysis: true },
      deps: {
        db: createMockDb([]),
        existsSync: () => true,
        omniClient: { deleteVectors: vi.fn() },
        anydocService: {
          perceive: vi.fn().mockResolvedValue({
            perception: {
              vector_saved: undefined,
              video_chunks: [
                { chunk_index: 10, start_sec: 300, end_sec: 305, vector: [0.1, 0.2], encoder_id: 7 }
              ]
            }
          })
        },
        databaseService: {
          markVideoSegmentProcessing: vi.fn(() => true),
          markVideoSegmentCompleted,
          markVideoSegmentFailedOrPending,
          rollbackVideoSegmentProcessing: vi.fn(),
          replaceVideoChunksInRange: vi.fn(),
          insertVideoChunks: vi.fn(),
          upsertFileVectorToOmni: vi.fn(),
          upsertFileVectorsToOmni: vi.fn().mockRejectedValue(new Error('omni write boom'))
        }
      }
    })

    expect(res.outcome).toBe('failed')
    expect(markVideoSegmentCompleted).not.toHaveBeenCalled()
    expect(markVideoSegmentFailedOrPending).toHaveBeenCalledWith(
      'fp_vid_2',
      1,
      expect.stringContaining('omni write boom')
    )
  })

  it('尾片 30s 容差越界时强制截断 videoMaxAnalyzeSec 至 effectiveLimitSec，且支持 AbortSignal 优雅回滚不扣重试配额', async () => {
    const perceive = vi.fn().mockImplementation(async (_fp, opts) => {
      expect(opts.videoMaxAnalyzeSec).toBe(1800)
      const err = new Error('aborted')
      err.name = 'AbortError'
      throw err
    })
    const rollbackVideoSegmentProcessing = vi.fn()
    const markVideoSegmentFailedOrPending = vi.fn()
    const controller = new AbortController()

    const res = await executeSingleVideoSegment({
      segment: {
        fileFingerprint: 'fp_vid_3',
        filePath: 'D:\\videos\\tail.mp4',
        segmentIndex: 5,
        startPtsSec: 1500,
        endPtsSec: 1825 // 尾片 30s 容差超出 1800s 上限
      },
      effectiveLimitSec: 1800,
      paramsHash: 'v2_60_140_medium',
      perceptionParams: { enableVideoVisualAnalysis: true },
      signal: controller.signal,
      deps: {
        db: createMockDb([]),
        existsSync: () => true,
        omniClient: { deleteVectors: vi.fn() },
        anydocService: { perceive },
        databaseService: {
          markVideoSegmentProcessing: vi.fn(() => true),
          markVideoSegmentCompleted: vi.fn(),
          markVideoSegmentFailedOrPending,
          rollbackVideoSegmentProcessing,
          replaceVideoChunksInRange: vi.fn(),
          insertVideoChunks: vi.fn(),
          upsertFileVectorToOmni: vi.fn(),
          upsertFileVectorsToOmni: vi.fn()
        }
      }
    })

    expect(res.outcome).toBe('aborted')
    expect(rollbackVideoSegmentProcessing).toHaveBeenCalledWith('fp_vid_3', 5)
    expect(markVideoSegmentFailedOrPending).not.toHaveBeenCalled()
  })
})
