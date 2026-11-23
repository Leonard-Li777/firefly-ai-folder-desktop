// @doc-anchor: docs/specs/video-fast-first-slice-and-idle-backfill-spec.md#23-独立单切片后台回填器-videosegmentbackfillworker
import {
  LogCategory,
  logger,
  isPathEqual,
  isSubPath,
  computeVideoVisualParamsHash,
  isVideoSegmentReusable
} from '@firefly/shared'
import type {
  VideoBackfillCurrentTask,
  VideoBackfillSnapshot,
  WorkspaceBackfillListResult
} from '@firefly/types'
import {
  executeSingleVideoSegment,
  type ExecuteSingleVideoSegmentInput,
  type ExecuteSingleVideoSegmentResult,
  type VideoSegmentExecutorDeps
} from './file-processor/video-segment-executor'

const CREEP_TIME_CONSTANT_MS = (4 * 60 * 1000) / 3
const CREEP_INTERVAL_MS = 3000
const SLICE_YIELD_DELAY_MS = 50

/**
 * 后台视频补全单调进度公式（对齐 analysis-queue-slice-progress-visualization-spec.md §3.2）：
 * - 同文件内绝不回退；
 * - targetSlices <= 0 防除零/NaN 回退 1；
 * - 片内渐近上限占当前片宽 85%，单调钳制在 [1, 98]，全部完成后由调用方推 100。
 */
export function computeVideoBackfillProgressPct(
  completedSlices: number,
  targetSlices: number,
  elapsedMs: number,
  lastReportedPct: number
): number {
  if (!Number.isFinite(targetSlices) || targetSlices <= 0) {
    return Math.max(lastReportedPct, 1)
  }
  const safeCompleted = Math.max(0, Math.min(completedSlices, targetSlices))
  const basePct = (safeCompleted / targetSlices) * 100
  const sliceWidth = 100 / targetSlices
  const ratio = elapsedMs > 0 ? 1 - Math.exp(-elapsedMs / CREEP_TIME_CONSTANT_MS) : 0
  const rawPct = basePct + sliceWidth * 0.85 * ratio
  return Math.max(lastReportedPct, Math.min(98, Math.max(1, Math.round(rawPct))))
}

export interface VideoBackfillWorkspaceContext {
  effectiveLimitSec: number
  /** 用户在工作区配置中设定的目标分析上限（从 workspace.config.videoAnalyzeDurationSec 读取，如 1800 秒） */
  configuredLimitSec: number
  videoVisualAnalysisEnabled: boolean
  workspaceName?: string
  paramsHash: string
  perceptionParams: ExecuteSingleVideoSegmentInput['perceptionParams']
}

export interface VideoSegmentBackfillWorkerDeps {
  hasMainQueuePendingOrRunning: () => boolean
  emitSnapshotUpdate: () => void
  onHibernationChange?: (active: boolean) => void
  resolveWorkspaceContext: (workspaceId: number) => Promise<VideoBackfillWorkspaceContext | null>
  getWorkspaceIdsWithPendingVideoSegments: () => number[]
  getPendingVideoSegmentsForWorkspace: (
    workspaceId: number,
    maxStartPtsSec: number
  ) => Array<{
    fileFingerprint: string
    segmentIndex: number
    startPtsSec: number
    endPtsSec: number
    paramsHash: string
    workspaceId: number
    path: string
    name: string
  }>
  getWorkspacePendingBackfillVideos: (
    workspaceId: number,
    displayLimitSec: number
  ) => Array<{
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
  }>
  resetFailedVideoSegmentsForWorkspace: (workspaceId: number, effectiveLimitSec: number) => number
  resetUpgradedVideoSegmentsForWorkspace?: (
    workspaceId: number,
    effectiveLimitSec: number,
    expectedParamsHash: string,
    isReusableFn: typeof isVideoSegmentReusable
  ) => number
  getVideoSegments: (fileId: string) => Array<{
    segment_index: number
    start_pts_sec: number
    end_pts_sec: number
    status: string
  }>
  executeSegment?: (
    input: ExecuteSingleVideoSegmentInput
  ) => Promise<ExecuteSingleVideoSegmentResult>
  executorDeps?: VideoSegmentExecutorDeps
  sliceYieldDelayMs?: number
  creepIntervalMs?: number
}

/**
 * 独立单切片视频后台回填器 (Spec §2.3)
 *
 * 职责边界：
 * 1. 仅在主分析队列自然排空且未暂停时运行，每次仅认领 1 个 k >= 1 切片；
 * 2. 纯 Stage 2 视觉补全，不回灌主队列、0 次多余 LLM 调用；
 * 3. 主队列新文件入队时，当前切片结束后立即让路；
 * 4. 逐工作区按有效上限过滤 pending 切片，物理免疫超限尾巴与免费用户死循环。
 */
export class VideoSegmentBackfillWorker {
  private running = false
  private userPaused = false
  private yieldRequested = false
  private priorityTarget?: { workspaceId: number; fileFingerprint: string }
  private current?: VideoBackfillCurrentTask
  private currentAbortController: AbortController | null = null
  private activeLoopPromise: Promise<void> | null = null
  private pendingVideoCount = 0
  private pendingSliceCount = 0
  private lastReportedPctByFile = new Map<string, number>()
  /** 本轮回填中跨设备缺失的原文件跳过集，防止 missing_file 不改 DB 状态导致 50ms 热循环死锁 */
  private sessionMissingFiles = new Set<string>()

  constructor(private readonly deps: VideoSegmentBackfillWorkerDeps) {}

  public getSnapshot(): VideoBackfillSnapshot {
    return {
      running: this.running,
      userPaused: this.userPaused,
      current: this.current ? { ...this.current } : undefined,
      pendingVideoCount: this.pendingVideoCount,
      pendingSliceCount: this.pendingSliceCount
    }
  }

  /**
   * 尝试启动后台单切片补全（幂等、防重入）
   */
  public scheduleStart(reason: string): boolean {
    if (this.running || this.userPaused) {
      return false
    }
    if (this.deps.hasMainQueuePendingOrRunning()) {
      return false
    }
    this.yieldRequested = false
    this.running = true
    const loop = this.runLoop(reason).finally(() => {
      if (this.activeLoopPromise === loop) {
        this.activeLoopPromise = null
      }
    })
    this.activeLoopPromise = loop
    return true
  }

  /**
   * 主队列出现新任务时调用：请求在当前正在执行的 1 个切片完成后立即让路
   */
  public requestYield(): void {
    if (this.running) {
      this.yieldRequested = true
    }
  }

  /**
   * 用户在「待补分析文件」页手动暂停后台补全
   */
  public async pauseByUser(): Promise<void> {
    this.userPaused = true
    await this.abortAndWaitCurrent()
    await this.refreshPendingCounts()
    this.deps.emitSnapshotUpdate()
  }

  /**
   * 用户在「待补分析文件」页手动恢复/立即开始补全
   */
  public resumeByUser(): boolean {
    this.userPaused = false
    const started = this.scheduleStart('user_resume')
    if (!started) {
      this.deps.emitSnapshotUpdate()
    }
    return started
  }

  /**
   * 将指定视频设为最高优先补全目标并尝试立即启动
   */
  public prioritizeFile(workspaceId: number, fileFingerprint: string): boolean {
    this.priorityTarget = { workspaceId, fileFingerprint }
    this.userPaused = false
    const started = this.scheduleStart('user_prioritize')
    if (!started) {
      this.deps.emitSnapshotUpdate()
    }
    return true
  }

  /**
   * 复位指定工作区失败的 k >= 1 切片并尝试唤醒补全
   */
  public async retryFailedForWorkspace(workspaceId: number): Promise<number> {
    const ctx = await this.deps.resolveWorkspaceContext(workspaceId)
    if (!ctx || ctx.effectiveLimitSec <= 300) return 0
    const resetCount = this.deps.resetFailedVideoSegmentsForWorkspace(
      workspaceId,
      ctx.effectiveLimitSec
    )
    await this.refreshPendingCounts()
    if (resetCount > 0) {
      this.userPaused = false
      this.scheduleStart('retry_failed')
    } else {
      this.deps.emitSnapshotUpdate()
    }
    return resetCount
  }

  /**
   * 工作区配置变更钩子：抽帧升档时重置失效切片；调大时长上限时按需唤醒补全
   */
  public async onWorkspaceConfigChanged(workspaceId: number): Promise<void> {
    const ctx = await this.deps.resolveWorkspaceContext(workspaceId)
    if (!ctx) return
    if (
      ctx.videoVisualAnalysisEnabled &&
      ctx.effectiveLimitSec > 300 &&
      this.deps.resetUpgradedVideoSegmentsForWorkspace
    ) {
      this.deps.resetUpgradedVideoSegmentsForWorkspace(
        workspaceId,
        ctx.effectiveLimitSec,
        ctx.paramsHash,
        isVideoSegmentReusable
      )
    }
    await this.refreshPendingCounts()
    if (ctx.videoVisualAnalysisEnabled && ctx.effectiveLimitSec > 300 && !this.userPaused) {
      this.scheduleStart('workspace_config_changed')
    } else {
      this.deps.emitSnapshotUpdate()
    }
  }

  /**
   * 查询指定工作区待补视频列表（供「待补分析文件」Tab 展示）
   */
  public async listWorkspacePendingVideos(
    workspaceId: number
  ): Promise<WorkspaceBackfillListResult> {
    try {
      const ctx = await this.deps.resolveWorkspaceContext(workspaceId)
      const effectiveLimitSec = ctx?.effectiveLimitSec ?? 300
      const displayLimitSec = ctx?.configuredLimitSec ?? effectiveLimitSec
      const items =
        ctx && ctx.videoVisualAnalysisEnabled && displayLimitSec > 300
          ? this.deps.getWorkspacePendingBackfillVideos(workspaceId, displayLimitSec)
          : []
      await this.refreshPendingCounts()
      return {
        success: true,
        workspaceId,
        effectiveLimitSec,
        configuredLimitSec: displayLimitSec,
        items,
        snapshot: this.getSnapshot()
      }
    } catch (err: any) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[视频补全] 查询工作区待补列表失败:', err)
      return {
        success: false,
        workspaceId,
        effectiveLimitSec: 300,
        items: [],
        snapshot: this.getSnapshot(),
        error: err?.message || String(err)
      }
    }
  }

  /**
   * 中止在途切片并等待退出（删除目录/文件或暂停时防 Windows EBUSY）
   */
  public async abortAndWaitCurrent(targetPath?: string): Promise<void> {
    if (!this.running && !this.activeLoopPromise) return
    if (targetPath && this.current?.filePath) {
      const hit =
        isPathEqual(this.current.filePath, targetPath) ||
        isSubPath(targetPath, this.current.filePath)
      if (!hit) return
    }
    this.yieldRequested = true
    if (this.currentAbortController) {
      this.currentAbortController.abort()
      this.currentAbortController = null
    }
    if (this.activeLoopPromise) {
      await this.activeLoopPromise.catch(() => {})
    }
  }

  /**
   * 仅发中止信号不等待（同步 pause() 快捷入口）
   */
  public abortCurrent(): void {
    this.yieldRequested = true
    if (this.currentAbortController) {
      this.currentAbortController.abort()
      this.currentAbortController = null
    }
  }

  /**
   * 挑选下一个满足工作区有效上限的待补单切片（物理免疫死循环与超限尾巴）
   */
  public async pickNextEligibleSegment(): Promise<{
    segment: {
      fileFingerprint: string
      segmentIndex: number
      startPtsSec: number
      endPtsSec: number
      paramsHash: string
      workspaceId: number
      path: string
      name: string
    }
    ctx: VideoBackfillWorkspaceContext
    pendingVideoCount: number
    pendingSliceCount: number
  } | null> {
    const workspaceIds = this.deps.getWorkspaceIdsWithPendingVideoSegments()
    if (workspaceIds.length === 0) {
      this.pendingVideoCount = 0
      this.pendingSliceCount = 0
      return null
    }

    // 优先把 priorityTarget 所属工作区排在最前
    const orderedWsIds = this.priorityTarget
      ? [
          this.priorityTarget.workspaceId,
          ...workspaceIds.filter(id => id !== this.priorityTarget!.workspaceId)
        ]
      : workspaceIds

    let totalVideos = 0
    let totalSlices = 0
    let chosen: {
      segment: ReturnType<VideoSegmentBackfillWorkerDeps['getPendingVideoSegmentsForWorkspace']>[0]
      ctx: VideoBackfillWorkspaceContext
    } | null = null

    for (const wsId of orderedWsIds) {
      const ctx = await this.deps.resolveWorkspaceContext(wsId)
      if (!ctx || !ctx.videoVisualAnalysisEnabled || ctx.effectiveLimitSec <= 300) {
        continue
      }
      const pendingSegs = this.deps
        .getPendingVideoSegmentsForWorkspace(wsId, ctx.effectiveLimitSec)
        .filter(s => !this.sessionMissingFiles.has(s.fileFingerprint))
      if (pendingSegs.length === 0) continue

      const uniqueFiles = new Set(pendingSegs.map(s => s.fileFingerprint))
      totalVideos += uniqueFiles.size
      totalSlices += pendingSegs.length

      if (!chosen) {
        if (this.priorityTarget && this.priorityTarget.workspaceId === wsId) {
          const prioSeg = pendingSegs.find(
            s => s.fileFingerprint === this.priorityTarget!.fileFingerprint
          )
          if (prioSeg) {
            chosen = { segment: prioSeg, ctx }
            continue
          }
          // 优先目标已无 pending 切片，清理优先标记
          this.priorityTarget = undefined
        }
        chosen = { segment: pendingSegs[0], ctx }
      }
    }

    this.pendingVideoCount = totalVideos
    this.pendingSliceCount = totalSlices

    if (!chosen) return null
    return {
      segment: chosen.segment,
      ctx: chosen.ctx,
      pendingVideoCount: totalVideos,
      pendingSliceCount: totalSlices
    }
  }

  private async refreshPendingCounts(): Promise<void> {
    try {
      await this.pickNextEligibleSegment()
    } catch (err) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[视频补全] 刷新待补计数失败:', err)
    }
  }

  private async runLoop(reason: string): Promise<void> {
    logger.debug(LogCategory.ANALYSIS_QUEUE, `[视频补全] 后台回填器启动 (reason=${reason})`)
    this.sessionMissingFiles.clear()
    this.deps.onHibernationChange?.(true)
    const yieldDelayMs = this.deps.sliceYieldDelayMs ?? SLICE_YIELD_DELAY_MS
    const creepIntervalMs = this.deps.creepIntervalMs ?? CREEP_INTERVAL_MS

    try {
      while (!this.yieldRequested && !this.userPaused) {
        // 1. 抢占让路检查：主队列忙碌或有待办则立即退出让位
        if (this.deps.hasMainQueuePendingOrRunning()) {
          logger.debug(LogCategory.ANALYSIS_QUEUE, '[视频补全] 主队列有新任务，后台回填暂停让路')
          break
        }

        // 2. 挑选 1 个满足有效上限的待补切片
        const next = await this.pickNextEligibleSegment()
        if (!next) {
          break
        }

        const { segment, ctx } = next
        const allSegs = this.deps.getVideoSegments(segment.fileFingerprint)
        const targetSegs = allSegs.filter(s => s.start_pts_sec < ctx.effectiveLimitSec)
        const completedSlices = targetSegs.filter(s => s.status === 'completed').length
        const targetSlices = Math.max(1, targetSegs.length)
        const totalSlices = Math.max(targetSlices, allSegs.length)

        const prevPct = this.lastReportedPctByFile.get(segment.fileFingerprint) ?? 0
        const initPct = computeVideoBackfillProgressPct(completedSlices, targetSlices, 0, prevPct)
        this.lastReportedPctByFile.set(segment.fileFingerprint, initPct)

        this.current = {
          fileFingerprint: segment.fileFingerprint,
          workspaceId: segment.workspaceId,
          workspaceName: ctx.workspaceName,
          fileName: segment.name,
          filePath: segment.path,
          completedSlices,
          targetSlices,
          totalSlices,
          currentSliceIndex: segment.segmentIndex,
          progressPct: initPct
        }
        this.deps.emitSnapshotUpdate()

        // 3. 启动片内渐近爬升定时器
        const sliceStartAt = Date.now()
        let creepTimer: ReturnType<typeof setInterval> | null = null
        if (creepIntervalMs > 0) {
          creepTimer = setInterval(() => {
            if (!this.current || this.current.fileFingerprint !== segment.fileFingerprint) return
            const last = this.lastReportedPctByFile.get(segment.fileFingerprint) ?? 0
            const nextPct = computeVideoBackfillProgressPct(
              completedSlices,
              targetSlices,
              Date.now() - sliceStartAt,
              last
            )
            if (nextPct !== last) {
              this.lastReportedPctByFile.set(segment.fileFingerprint, nextPct)
              this.current = { ...this.current, progressPct: nextPct }
              this.deps.emitSnapshotUpdate()
            }
          }, creepIntervalMs)
        }

        // 4. 执行这 1 个切片（纯 Stage 2）
        const controller = new AbortController()
        this.currentAbortController = controller
        let result: ExecuteSingleVideoSegmentResult
        try {
          const execFn = this.deps.executeSegment ?? executeSingleVideoSegment
          if (!this.deps.executeSegment && !this.deps.executorDeps) {
            throw new Error('VideoSegmentBackfillWorker missing executorDeps')
          }
          result = await execFn({
            segment: {
              fileFingerprint: segment.fileFingerprint,
              filePath: segment.path,
              segmentIndex: segment.segmentIndex,
              startPtsSec: segment.startPtsSec,
              endPtsSec: segment.endPtsSec
            },
            effectiveLimitSec: ctx.effectiveLimitSec,
            paramsHash: ctx.paramsHash,
            perceptionParams: ctx.perceptionParams,
            signal: controller.signal,
            deps: this.deps.executorDeps!
          })
        } finally {
          if (creepTimer) {
            clearInterval(creepTimer)
            creepTimer = null
          }
          if (this.currentAbortController === controller) {
            this.currentAbortController = null
          }
        }

        // 5. 更新切片完成进度
        if (result.outcome === 'completed') {
          const nextDone = completedSlices + 1
          const donePct =
            nextDone >= targetSlices
              ? 100
              : computeVideoBackfillProgressPct(
                  nextDone,
                  targetSlices,
                  0,
                  this.lastReportedPctByFile.get(segment.fileFingerprint) ?? 0
                )
          this.lastReportedPctByFile.set(segment.fileFingerprint, donePct)
          if (nextDone >= targetSlices) {
            this.lastReportedPctByFile.delete(segment.fileFingerprint)
          }
          if (this.current) {
            this.current = {
              ...this.current,
              completedSlices: nextDone,
              progressPct: donePct
            }
          }
          this.deps.emitSnapshotUpdate()
        } else if (result.outcome === 'aborted') {
          break
        } else if (result.outcome === 'missing_file') {
          // 跨设备原文件缺失不改 DB 状态，本轮加入跳过集避免 50ms 无限热循环饿死后续视频
          this.sessionMissingFiles.add(segment.fileFingerprint)
        }

        // 6. 协程让出，给主队列与事件循环喘息窗口 (FIN-10)
        if (yieldDelayMs > 0 && !this.yieldRequested && !this.userPaused) {
          await new Promise(resolve => setTimeout(resolve, yieldDelayMs))
        }
      }
    } catch (err) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[视频补全] 后台回填循环异常退出:', err)
    } finally {
      this.running = false
      this.current = undefined
      this.currentAbortController = null
      await this.refreshPendingCounts()
      if (!this.deps.hasMainQueuePendingOrRunning()) {
        this.deps.onHibernationChange?.(false)
      }
      this.deps.emitSnapshotUpdate()
    }
  }
}

export { computeVideoVisualParamsHash }
