import { describe, it, expect, vi } from 'vitest'
import {
  VideoSegmentBackfillWorker,
  computeVideoBackfillProgressPct
} from '../video-segment-backfill-worker'

interface SegRow {
  fileFingerprint: string
  segmentIndex: number
  startPtsSec: number
  endPtsSec: number
  paramsHash: string
  workspaceId: number
  path: string
  name: string
  status: 'pending' | 'completed' | 'failed'
}

function createHarness(options: {
  segments: SegRow[]
  effectiveLimitSec: number
  configuredLimitSec?: number
  videoVisualAnalysisEnabled?: boolean
  mainQueueBusy?: () => boolean
  executeImpl?: (segIndex: number) => Promise<'completed' | 'failed' | 'aborted'>
}) {
  const segs = options.segments
  const executedSegments: Array<{ fp: string; segIndex: number }> = []
  const emitSnapshotUpdate = vi.fn()
  const onHibernationChange = vi.fn()

  const worker = new VideoSegmentBackfillWorker({
    hasMainQueuePendingOrRunning: options.mainQueueBusy ?? (() => false),
    emitSnapshotUpdate,
    onHibernationChange,
    sliceYieldDelayMs: 0,
    creepIntervalMs: 0,
    resolveWorkspaceContext: async wsId => ({
      effectiveLimitSec: options.effectiveLimitSec,
      configuredLimitSec: options.configuredLimitSec ?? options.effectiveLimitSec,
      videoVisualAnalysisEnabled: options.videoVisualAnalysisEnabled ?? true,
      workspaceName: `WS-${wsId}`,
      paramsHash: 'v2_60_140_medium',
      perceptionParams: { enableVideoVisualAnalysis: true }
    }),
    getWorkspaceIdsWithPendingVideoSegments: () => {
      const ids = new Set<number>()
      for (const s of segs) {
        const hasSeg0Completed = segs.some(
          x =>
            x.fileFingerprint === s.fileFingerprint &&
            x.segmentIndex === 0 &&
            x.status === 'completed'
        )
        if (s.segmentIndex >= 1 && s.status === 'pending' && hasSeg0Completed) {
          ids.add(s.workspaceId)
        }
      }
      return Array.from(ids)
    },
    getPendingVideoSegmentsForWorkspace: (wsId, maxStartPtsSec) => {
      return segs
        .filter(s => {
          const hasSeg0Completed = segs.some(
            x =>
              x.fileFingerprint === s.fileFingerprint &&
              x.segmentIndex === 0 &&
              x.status === 'completed'
          )
          return (
            s.workspaceId === wsId &&
            s.segmentIndex >= 1 &&
            s.status === 'pending' &&
            s.startPtsSec < maxStartPtsSec &&
            hasSeg0Completed
          )
        })
        .sort((a, b) => a.segmentIndex - b.segmentIndex)
    },
    getWorkspacePendingBackfillVideos: (wsId, displayLimitSec) => {
      const grouped = new Map<string, { path: string; name: string; rows: SegRow[] }>()
      for (const s of segs) {
        if (s.workspaceId !== wsId) continue
        const bucket = grouped.get(s.fileFingerprint) ?? {
          path: s.path,
          name: s.name,
          rows: []
        }
        bucket.rows.push(s)
        grouped.set(s.fileFingerprint, bucket)
      }
      const list: Array<{
        workspaceFileId?: number
        fileFingerprint: string
        path: string
        name: string
        completedSlices: number
        targetSlices: number
        totalSlices: number
        completedDurationSec: number
        targetDurationSec: number
        totalDurationSec: number
        failedSlices: number
      }> = []
      for (const [fp, entry] of grouped.entries()) {
        const hasSeg0Completed = entry.rows.some(
          r => r.segmentIndex === 0 && r.status === 'completed'
        )
        const targetRows = entry.rows.filter(r => r.startPtsSec < displayLimitSec)
        const actionable = targetRows.filter(
          r => r.segmentIndex >= 1 && (r.status === 'pending' || r.status === 'failed')
        )
        if (!hasSeg0Completed || actionable.length === 0) continue
        list.push({
          fileFingerprint: fp,
          path: entry.path,
          name: entry.name,
          completedSlices: targetRows.filter(r => r.status === 'completed').length,
          targetSlices: targetRows.length,
          totalSlices: entry.rows.length,
          completedDurationSec: targetRows
            .filter(r => r.status === 'completed')
            .reduce((sum, r) => sum + (Math.min(r.endPtsSec, displayLimitSec) - r.startPtsSec), 0),
          targetDurationSec: targetRows.reduce(
            (sum, r) => sum + (Math.min(r.endPtsSec, displayLimitSec) - r.startPtsSec),
            0
          ),
          totalDurationSec: Math.max(...entry.rows.map(r => r.endPtsSec)),
          failedSlices: actionable.filter(r => r.status === 'failed').length
        })
      }
      return list
    },
    resetFailedVideoSegmentsForWorkspace: (wsId, limit) => {
      let count = 0
      for (const s of segs) {
        if (
          s.workspaceId === wsId &&
          s.segmentIndex >= 1 &&
          s.status === 'failed' &&
          s.startPtsSec < limit
        ) {
          s.status = 'pending'
          count++
        }
      }
      return count
    },
    getVideoSegments: fp =>
      segs
        .filter(s => s.fileFingerprint === fp)
        .map(s => ({
          segment_index: s.segmentIndex,
          start_pts_sec: s.startPtsSec,
          end_pts_sec: s.endPtsSec,
          status: s.status
        })),
    executeSegment: async input => {
      executedSegments.push({
        fp: input.segment.fileFingerprint,
        segIndex: input.segment.segmentIndex
      })
      const target = segs.find(
        s =>
          s.fileFingerprint === input.segment.fileFingerprint &&
          s.segmentIndex === input.segment.segmentIndex
      )
      const outcome = options.executeImpl
        ? await options.executeImpl(input.segment.segmentIndex)
        : 'completed'
      if (target) {
        if (outcome === 'completed') target.status = 'completed'
        else if (outcome === 'failed') target.status = 'failed'
      }
      return { outcome, frameCount: outcome === 'completed' ? 5 : 0 }
    }
  })

  return { worker, executedSegments, emitSnapshotUpdate, onHibernationChange }
}

describe('VideoSegmentBackfillWorker (Ticket 02)', () => {
  it('computeVideoBackfillProgressPct: 单调递增、防除零/NaN、钳制在 [1, 98]', () => {
    expect(computeVideoBackfillProgressPct(0, 0, 1000, 0)).toBe(1)
    expect(computeVideoBackfillProgressPct(1, 6, 0, 0)).toBe(17)
    const mid = computeVideoBackfillProgressPct(1, 6, 40000, 17)
    expect(mid).toBeGreaterThan(17)
    expect(mid).toBeLessThanOrEqual(98)
    // 单调不回退
    expect(computeVideoBackfillProgressPct(1, 6, 0, mid)).toBe(mid)
  })

  it('U-02: 视频时长 > 配置上限（60m 视频配 30m 上限），超出切片永久 pending 也不触发死循环', async () => {
    const segs: SegRow[] = [
      {
        fileFingerprint: 'fp1',
        segmentIndex: 0,
        startPtsSec: 0,
        endPtsSec: 300,
        paramsHash: 'h',
        workspaceId: 1,
        path: 'a.mp4',
        name: 'a.mp4',
        status: 'completed'
      },
      {
        fileFingerprint: 'fp1',
        segmentIndex: 6,
        startPtsSec: 1800,
        endPtsSec: 2100,
        paramsHash: 'h',
        workspaceId: 1,
        path: 'a.mp4',
        name: 'a.mp4',
        status: 'pending'
      },
      {
        fileFingerprint: 'fp1',
        segmentIndex: 7,
        startPtsSec: 2100,
        endPtsSec: 2400,
        paramsHash: 'h',
        workspaceId: 1,
        path: 'a.mp4',
        name: 'a.mp4',
        status: 'pending'
      }
    ]
    const { worker, executedSegments } = createHarness({ segments: segs, effectiveLimitSec: 1800 })
    const next = await worker.pickNextEligibleSegment()
    expect(next).toBeNull()
    worker.scheduleStart('queue_drained')
    await new Promise(r => setTimeout(r, 20))
    expect(executedSegments).toHaveLength(0)
    expect(worker.getSnapshot().running).toBe(false)
  })

  it('U-03: 免费/降级用户 (effectiveLimitSec=300) 跳过所有 k >= 1 pending 切片', async () => {
    const segs: SegRow[] = [
      {
        fileFingerprint: 'fp1',
        segmentIndex: 0,
        startPtsSec: 0,
        endPtsSec: 300,
        paramsHash: 'h',
        workspaceId: 1,
        path: 'a.mp4',
        name: 'a.mp4',
        status: 'completed'
      },
      {
        fileFingerprint: 'fp1',
        segmentIndex: 1,
        startPtsSec: 300,
        endPtsSec: 600,
        paramsHash: 'h',
        workspaceId: 1,
        path: 'a.mp4',
        name: 'a.mp4',
        status: 'pending'
      }
    ]
    const { worker } = createHarness({ segments: segs, effectiveLimitSec: 300 })
    expect(await worker.pickNextEligibleSegment()).toBeNull()
  })

  it('U-04 & U-05: 逐片补全且新文件入队时在本片完成后立即抢占让路，空闲后无缝续跑', async () => {
    let busy = false
    const segs: SegRow[] = [
      {
        fileFingerprint: 'fp1',
        segmentIndex: 0,
        startPtsSec: 0,
        endPtsSec: 300,
        paramsHash: 'h',
        workspaceId: 1,
        path: 'a.mp4',
        name: 'a.mp4',
        status: 'completed'
      },
      {
        fileFingerprint: 'fp1',
        segmentIndex: 1,
        startPtsSec: 300,
        endPtsSec: 600,
        paramsHash: 'h',
        workspaceId: 1,
        path: 'a.mp4',
        name: 'a.mp4',
        status: 'pending'
      },
      {
        fileFingerprint: 'fp1',
        segmentIndex: 2,
        startPtsSec: 600,
        endPtsSec: 900,
        paramsHash: 'h',
        workspaceId: 1,
        path: 'a.mp4',
        name: 'a.mp4',
        status: 'pending'
      }
    ]
    const { worker, executedSegments } = createHarness({
      segments: segs,
      effectiveLimitSec: 1800,
      mainQueueBusy: () => busy,
      executeImpl: async segIdx => {
        if (segIdx === 1) {
          // 模拟新文件在 seg_1 执行中途入队
          busy = true
          worker.requestYield()
        }
        return 'completed'
      }
    })

    worker.scheduleStart('queue_drained')
    await new Promise(r => setTimeout(r, 30))
    // 跑完 seg_1 后立即让路，绝不启动 seg_2
    expect(executedSegments).toEqual([{ fp: 'fp1', segIndex: 1 }])
    expect(worker.getSnapshot().running).toBe(false)

    // 主队列处理完新文件后再次排空，无缝续跑 seg_2
    busy = false
    worker.scheduleStart('queue_drained')
    await new Promise(r => setTimeout(r, 30))
    expect(executedSegments).toEqual([
      { fp: 'fp1', segIndex: 1 },
      { fp: 'fp1', segIndex: 2 }
    ])
  })

  it('U-07 & U-09: 毒药切片跳过不卡死 + seg_0 未完成视频绝不被捞出补全', async () => {
    const segs: SegRow[] = [
      // seg_0 未完成，seg_1 绝不能被捞出
      {
        fileFingerprint: 'fp_bad0',
        segmentIndex: 0,
        startPtsSec: 0,
        endPtsSec: 300,
        paramsHash: 'h',
        workspaceId: 1,
        path: 'bad0.mp4',
        name: 'bad0.mp4',
        status: 'pending'
      },
      {
        fileFingerprint: 'fp_bad0',
        segmentIndex: 1,
        startPtsSec: 300,
        endPtsSec: 600,
        paramsHash: 'h',
        workspaceId: 1,
        path: 'bad0.mp4',
        name: 'bad0.mp4',
        status: 'pending'
      },
      // 正常视频：seg_1 失败，seg_2 应继续完成
      {
        fileFingerprint: 'fp_ok',
        segmentIndex: 0,
        startPtsSec: 0,
        endPtsSec: 300,
        paramsHash: 'h',
        workspaceId: 1,
        path: 'ok.mp4',
        name: 'ok.mp4',
        status: 'completed'
      },
      {
        fileFingerprint: 'fp_ok',
        segmentIndex: 1,
        startPtsSec: 300,
        endPtsSec: 600,
        paramsHash: 'h',
        workspaceId: 1,
        path: 'ok.mp4',
        name: 'ok.mp4',
        status: 'pending'
      },
      {
        fileFingerprint: 'fp_ok',
        segmentIndex: 2,
        startPtsSec: 600,
        endPtsSec: 900,
        paramsHash: 'h',
        workspaceId: 1,
        path: 'ok.mp4',
        name: 'ok.mp4',
        status: 'pending'
      }
    ]
    const { worker, executedSegments } = createHarness({
      segments: segs,
      effectiveLimitSec: 1800,
      executeImpl: async segIdx => (segIdx === 1 ? 'failed' : 'completed')
    })

    worker.scheduleStart('queue_drained')
    await new Promise(r => setTimeout(r, 30))
    expect(executedSegments).toEqual([
      { fp: 'fp_ok', segIndex: 1 },
      { fp: 'fp_ok', segIndex: 2 }
    ])
    // 点击重试失败片段后，seg_1 复位 pending 可重跑
    const resetCount = await worker.retryFailedForWorkspace(1)
    expect(resetCount).toBe(1)
  })

  it('U-10: 免费或等级未就绪 (effectiveLimitSec=300) 但工作区设定 configuredLimitSec=10800 时，待补列表仍返回视频且后台不越权执行', async () => {
    const segs: SegRow[] = [
      {
        fileFingerprint: 'fp_long',
        segmentIndex: 0,
        startPtsSec: 0,
        endPtsSec: 300,
        paramsHash: 'h',
        workspaceId: 1,
        path: 'long.avi',
        name: 'long.avi',
        status: 'completed'
      },
      {
        fileFingerprint: 'fp_long',
        segmentIndex: 1,
        startPtsSec: 300,
        endPtsSec: 600,
        paramsHash: 'h',
        workspaceId: 1,
        path: 'long.avi',
        name: 'long.avi',
        status: 'pending'
      },
      {
        fileFingerprint: 'fp_long',
        segmentIndex: 2,
        startPtsSec: 600,
        endPtsSec: 737,
        paramsHash: 'h',
        workspaceId: 1,
        path: 'long.avi',
        name: 'long.avi',
        status: 'pending'
      }
    ]
    const { worker, executedSegments } = createHarness({
      segments: segs,
      effectiveLimitSec: 300,
      configuredLimitSec: 10800
    })

    const res = await worker.listWorkspacePendingVideos(1)
    expect(res.success).toBe(true)
    expect(res.effectiveLimitSec).toBe(300)
    expect(res.configuredLimitSec).toBe(10800)
    expect(res.items).toHaveLength(1)
    expect(res.items[0].fileFingerprint).toBe('fp_long')
    expect(res.items[0].targetSlices).toBe(3)

    // 后台执行器仍严格受 effectiveLimitSec=300 封顶，不会越权跑 seg_1/seg_2
    expect(await worker.pickNextEligibleSegment()).toBeNull()
    worker.scheduleStart('queue_drained')
    await new Promise(r => setTimeout(r, 20))
    expect(executedSegments).toHaveLength(0)
  })
})
