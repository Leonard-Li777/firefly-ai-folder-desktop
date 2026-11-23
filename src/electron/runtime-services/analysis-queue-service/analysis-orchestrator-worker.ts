/**
 * 分析队列流水线调度 Worker：承载并行 CPU/GPU 双通道与串行单项分发。
 *
 * @doc-anchor: docs/specs/ai-inference-proactive-readiness-gating-spec.md#35-analysisorchestratorworker-统一收口-runaiphasewithfallback
 *
 * 通过 Getter 延迟读取 QueueManager，避免服务构造阶段未 initialize 导致绑定 `undefined`。
 */

import { AnalysisQueueItem } from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import { StageNotifier, Stage2TimeoutError } from './stage-notifier'
import { AIServiceManager, type Stage3CapabilityLease } from './ai-service-manager'
import { QueueManager } from './queue-manager'
import { DirectoryProcessor } from './directory-processor'
import {
  FileProcessor,
  getFileStageFromDB,
  getFileAnalysisStateFromDB,
  checkBasicDataCompleteness,
  type CpuPhaseOutcome
} from './file-processor'
import { databaseService } from '../database/database-service'
import { resolveWorkspaceEffectiveConfig } from '../system/workspace-analysis-context'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { resolveEffectiveAnalysisMode, type AnalysisMode } from '../../config/analysis-mode'
import { engineBridgeService } from '../engine-bridge'
import { runWithEngineGateContext } from '../engine-bridge/engine-swapping-coordinator'
import { isTimeoutError, isTransientInfraError } from './file-processor/analysis-error-classifier'
import { cloudSyncWorker } from '../ai/cloud-sync-worker'
import { moduleHibernationCoordinator } from '../hibernation/module-hibernation-coordinator'
import { queueFtsSync } from './fts-sync-hooks'
import type { OmniHttpAdapter } from './omni-http-adapter'
import type { AnalysisItemStatusExtra } from './analysis-write-dispatcher'

/** 判定异常或信号是否为中止取消（兼容跨包鸭子类型） */
function isAbortErrorLike(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string; message?: string }
  return e.name === 'AbortError' || e.message === 'Aborted'
}

/** 唯一事实源：仅信 hasInstalledEngines，杜绝冷启 stopped 误降 simple */
function resolveHasInstalledAiEngine(): boolean {
  const aiServiceMode =
    ConfigOrchestrator.getInstance().getValue<string>('AI_SERVICE_MODE') ?? 'local'
  return aiServiceMode === 'local' ? engineBridgeService?.hasInstalledEngines !== false : true
}

export class AnalysisOrchestratorWorker {
  /** 并行模式双通道正在处理的队列项引用计数（防 OrphanWatchdog 误杀长耗时在跑项） */
  private activeItemCounts = new Map<number, number>()
  /** CPU 提取开始至 GPU 消费者完结（含交接排队窗口）的受保护队列 ID（防 10m+ 长队列交接期误杀） */
  private handoverPendingIds = new Set<number>()
  /** 当前并行批次项的路径索引（供 abortAndDeleteItemsByDirectory 精确匹配目录） */
  private parallelItemPaths = new Map<number, string>()
  /** 当前并行批次所属工作空间 ID（供 pause() 精确中止并行双通道） */
  private activeParallelWorkspaceId: number | null = null

  constructor(
    private getQueueManager: () => QueueManager | undefined,
    private aiServiceManager: AIServiceManager,
    private directoryProcessor: DirectoryProcessor,
    private fileProcessor: FileProcessor,
    private updateItemStatus: (
      itemId: number,
      status: 'pending' | 'analyzing' | 'completed' | 'failed',
      progress: number,
      error?: string,
      extra?: AnalysisItemStatusExtra
    ) => void
  ) {}

  /** 判断指定队列项是否处于并行双通道执行中或 CPU→GPU 交接等待窗口 */
  isItemActive(itemId: number): boolean {
    return (this.activeItemCounts.get(itemId) ?? 0) > 0 || this.handoverPendingIds.has(itemId)
  }

  /** 判断并行双通道活跃/交接项中是否存在路径匹配谓词的任务 */
  hasActiveItemMatching(predicate: (filePath: string) => boolean): boolean {
    for (const itemId of this.activeItemCounts.keys()) {
      const p = this.parallelItemPaths.get(itemId)
      if (p && predicate(p)) return true
    }
    for (const itemId of this.handoverPendingIds) {
      const p = this.parallelItemPaths.get(itemId)
      if (p && predicate(p)) return true
    }
    return false
  }

  /** 判断并行双通道是否有活跃任务（可选按 workspaceId 过滤） */
  hasActiveItems(workspaceId?: number): boolean {
    if (this.activeItemCounts.size === 0 && this.handoverPendingIds.size === 0) return false
    if (workspaceId === undefined) return true
    return this.activeParallelWorkspaceId === workspaceId
  }

  private markActive(itemId: number): void {
    this.activeItemCounts.set(itemId, (this.activeItemCounts.get(itemId) ?? 0) + 1)
  }

  private unmarkActive(itemId: number): void {
    const next = (this.activeItemCounts.get(itemId) ?? 0) - 1
    if (next <= 0) {
      this.activeItemCounts.delete(itemId)
    } else {
      this.activeItemCounts.set(itemId, next)
    }
  }

  /**
   * 统一包装助手：首次 GPU 推理与 Catch 瞬态重试共用，
   * 确保所有批处理 GPU 推理 100% 运行在 `intent: 'batch'` ALS 门控上下文中。
   */
  private executeGpuPhaseInBatchContext(
    item: AnalysisQueueItem,
    signal: AbortSignal,
    cpuSkipped: boolean
  ): Promise<void> {
    return runWithEngineGateContext({ intent: 'batch', signal }, () =>
      this.fileProcessor.processFile(item, signal, 'gpu', cpuSkipped)
    )
  }

  /**
   * 统一执行单文件的 Stage 3~4 能力租约获取、GPU 推理与优雅降级。
   * 并行通道（runGPUConsumer）、串行通道（runSerialItem）与瞬态 Catch 全通道复用。
   *
   * @returns 'done'（继续处理下一文件）| 'aborted'（安全退出循环，已回滚 pending）
   */
  private async runAiPhaseWithFallback(
    item: AnalysisQueueItem,
    signal: AbortSignal,
    ctx: { effectiveMode: AnalysisMode; cpuSkipped: boolean; fingerprint?: string }
  ): Promise<'done' | 'aborted'> {
    if (signal.aborted) {
      this.updateItemStatus(item.id, 'pending', 0)
      return 'aborted'
    }

    // 等待期 UI 进度活跃提示（注：OrphanWatchdog 阈值为 10 分钟且过滤 !isItemActive(id)，
    // 本项受 markActive 保护不会被看门狗误回收；写入 50% 可防前端进度条停滞）
    this.updateItemStatus(item.id, 'analyzing', 50, undefined, { analysisStage: 2 })

    let lease: Stage3CapabilityLease
    try {
      lease = await this.aiServiceManager.acquireStage3Capability(ctx.effectiveMode, signal)
    } catch (err) {
      if (isAbortErrorLike(err, signal)) {
        this.updateItemStatus(item.id, 'pending', 0)
        return 'aborted'
      }
      throw err
    }

    if (!lease.granted) {
      const res = await this.fileProcessor.completeAsCpuOnly(
        item,
        lease.reason,
        lease.terminalKind,
        signal,
        ctx.fingerprint
      )
      return res === 'aborted' ? 'aborted' : 'done'
    }

    // CAS 非终态守卫：仅当前项仍为非终态时才置 Stage 3，防止覆盖 cache_hit/failed 终态
    if (item.status === 'completed' || item.status === 'failed') {
      return 'done'
    }

    // 能力已授出：置 Stage 3 并经 ALS 显式标记 batch 意图后执行 GPU 推理
    // （注：FileProcessor Stage 3~4 写库均为 ON CONFLICT upsert 幂等，瞬态 503 在 HTTP 阶段即中断尚未落库）
    this.updateItemStatus(item.id, 'analyzing', 51, undefined, { analysisStage: 3 })
    try {
      await this.executeGpuPhaseInBatchContext(item, signal, ctx.cpuSkipped)
      // 收口 FTS 同步至防抖 Hook，避免绕过窗口聚合高频写盘
      const fp = ctx.fingerprint || databaseService.getFileFingerprintByPath(item.path)
      if (fp) queueFtsSync(fp)
      cloudSyncWorker.triggerSync(2000)
      return 'done'
    } catch (err: unknown) {
      if (isAbortErrorLike(err, signal)) {
        this.updateItemStatus(item.id, 'pending', 0)
        return 'aborted'
      }
      if (isTransientInfraError(err)) {
        // 严禁先置 pending(0) 防止与调度主循环竞态双跑：保持 analyzing 原地重仲裁
        let retryLease: Stage3CapabilityLease
        try {
          retryLease = await this.aiServiceManager.acquireStage3Capability(ctx.effectiveMode, signal)
        } catch (abortErr) {
          if (isAbortErrorLike(abortErr, signal)) {
            this.updateItemStatus(item.id, 'pending', 0)
            return 'aborted'
          }
          throw abortErr
        }
        if (!retryLease.granted) {
          const res = await this.fileProcessor.completeAsCpuOnly(
            item,
            retryLease.reason,
            retryLease.terminalKind,
            signal,
            ctx.fingerprint
          )
          return res === 'aborted' ? 'aborted' : 'done'
        }
        if (signal.aborted) {
          this.updateItemStatus(item.id, 'pending', 0)
          return 'aborted'
        }
        try {
          this.updateItemStatus(item.id, 'analyzing', 51, undefined, { analysisStage: 3 })
          await this.executeGpuPhaseInBatchContext(item, signal, ctx.cpuSkipped)
          const fp = ctx.fingerprint || databaseService.getFileFingerprintByPath(item.path)
          if (fp) queueFtsSync(fp)
          cloudSyncWorker.triggerSync(2000)
        } catch (retryErr: unknown) {
          if (isAbortErrorLike(retryErr, signal)) {
            this.updateItemStatus(item.id, 'pending', 0)
            return 'aborted'
          }
          logger.warn(
            LogCategory.ANALYSIS_QUEUE,
            `[分析队列] 瞬态重试失败，降级 CPU 完工: ${item.name}`,
            retryErr
          )
          const res = await this.fileProcessor.completeAsCpuOnly(
            item,
            'retry_inference_failed',
            'tier1_fallback',
            signal,
            ctx.fingerprint
          )
          return res === 'aborted' ? 'aborted' : 'done'
        }
        return 'done'
      }
      throw err
    }
  }

  async runSerialItem(
    next: AnalysisQueueItem,
    signal: AbortSignal,
    _aiStageEnabled?: boolean,
    _omniAdapter?: OmniHttpAdapter,
    _logWarning?: (message: string, error?: unknown) => void
  ): Promise<void> {
    this.updateItemStatus(next.id, 'analyzing', 0)

    if (next.itemType === 'directory') {
      await this.directoryProcessor.processDirectory(next)
      return
    }

    try {
      const cpuRes = await this.fileProcessor.processFile(next, signal, 'cpu')
      if (cpuRes.outcome === 'terminal') {
        if (cpuRes.terminalKind !== 'failed' && cpuRes.terminalKind !== 'skipped') {
          cloudSyncWorker.triggerSync(2000)
        }
        return
      }

      let effectiveMode: AnalysisMode
      try {
        const wsConfig = await resolveWorkspaceEffectiveConfig(
          next.workspaceId ?? null,
          resolveHasInstalledAiEngine()
        )
        effectiveMode = wsConfig.effectiveParams.analysisMode
      } catch (cfgErr) {
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          `[串行队列] 解析工作区有效模式失败，回退全局有效模式: ${next.name}`,
          cfgErr
        )
        effectiveMode = resolveEffectiveAnalysisMode(resolveHasInstalledAiEngine())
      }

      await this.runAiPhaseWithFallback(next, signal, {
        effectiveMode,
        cpuSkipped: cpuRes.cpuSkipped,
        fingerprint: cpuRes.fingerprint
      })
    } catch (err: unknown) {
      if (isAbortErrorLike(err, signal)) {
        this.updateItemStatus(next.id, 'pending', 0)
        return
      }
      this.updateItemStatus(
        next.id,
        'failed',
        100,
        err instanceof Error ? err.message : String(err),
        { isTimeout: isTimeoutError(err) }
      )
    }
  }

  async runParallel(
    pendingItems: AnalysisQueueItem[],
    signal: AbortSignal,
    stage2WaitTimeoutMs: number
  ) {
    const notifier = new StageNotifier()
    const cpuSkippedOutcomes = new Map<number, CpuPhaseOutcome>()
    // 记录已被 GPU 消费者跳过/超时/完结的项，防止异步预检让出后滞后 CPU 再次将其加入 handoverPendingIds 造成批次内滞留
    const gpuSkippedOrDoneIds = new Set<number>()
    // 按 (batchId, workspaceId) 批次局部缓存 resolveWorkspaceEffectiveConfig，避免逐文件重复读库
    const hasInstalledAiEngine = resolveHasInstalledAiEngine()
    const workspaceConfigCache = new Map<
      number | null,
      ReturnType<typeof resolveWorkspaceEffectiveConfig>
    >()
    const getCachedWorkspaceConfig = (workspaceId?: number | null) => {
      const key = workspaceId ?? null
      let cached = workspaceConfigCache.get(key)
      if (!cached) {
        cached = resolveWorkspaceEffectiveConfig(key, hasInstalledAiEngine)
        workspaceConfigCache.set(key, cached)
      }
      return cached
    }

    this.parallelItemPaths.clear()
    for (const item of pendingItems) {
      if (item.path) this.parallelItemPaths.set(item.id, item.path)
    }

    const isAlreadyStage2 = (item: AnalysisQueueItem): boolean => {
      const db = databaseService.db
      if (!db || !item.workspaceId) return false
      const stage = getFileStageFromDB(db, item.workspaceId, item.path)
      return stage >= 2
    }

    const runCPUProducer = async () => {
      for (const item of pendingItems) {
        if (signal.aborted) break
        if (!this.getQueueManager()?.hasItem(item.id)) {
          notifier.notify(item.id, { outcome: 'terminal', terminalKind: 'skipped' })
          continue
        }

        if (item.itemType === 'directory') {
          notifier.notify(item.id, { outcome: 'terminal', terminalKind: 'skipped' })
          continue
        }

        let shouldSkipCpu = false
        let skippedFingerprint = ''
        try {
          // [OBS-02] 基于队列项所属工作区解析有效配置（批次内缓存），完整性判定与 file-processor 同源
          const workspaceEffectiveConfig = await getCachedWorkspaceConfig(item.workspaceId ?? null)
          const reuseBasicAnalysisData =
            workspaceEffectiveConfig.effectiveParams.reuseBasicAnalysisData

          if (isAlreadyStage2(item)) {
            if (!reuseBasicAnalysisData) {
              shouldSkipCpu =
                item.forceReanalyze !== true &&
                !getFileAnalysisStateFromDB(databaseService.db!, item.workspaceId!, item.path)
                  .isAnalyzed
              if (shouldSkipCpu) {
                skippedFingerprint = databaseService.getFileFingerprintByPath(item.path) ?? ''
              }
            } else {
              const fileFingerprint =
                databaseService.getFileFingerprintByPath(item.path) ?? undefined
              const completeness = await checkBasicDataCompleteness(
                databaseService.db!,
                item.workspaceId!,
                item.path,
                workspaceEffectiveConfig,
                fileFingerprint
              )
              if (completeness.isComplete) {
                shouldSkipCpu = true
                skippedFingerprint = fileFingerprint ?? ''
              }
            }
          }
        } catch (preErr) {
          logger.error(
            LogCategory.ANALYSIS_QUEUE,
            `[并行队列:CPU通道] 阶段判定异常: ${item.name}`,
            preErr
          )
        }

        if (shouldSkipCpu) {
          const skipOutcome: CpuPhaseOutcome = {
            outcome: 'proceed',
            fingerprint: skippedFingerprint,
            cpuSkipped: true
          }
          cpuSkippedOutcomes.set(item.id, skipOutcome)
          this.updateItemStatus(item.id, 'pending', 50, undefined, { analysisStage: 2 })
          notifier.notify(item.id, skipOutcome)
          continue
        }

        // 异步预检（checkBasicDataCompleteness）可能让出事件循环：
        // 若期间批次已中止、任务已被删除或 GPU 已超时跳过，严禁再加入 handoverPendingIds 导致批次内滞留误判
        if (
          signal.aborted ||
          !this.getQueueManager()?.hasItem(item.id) ||
          gpuSkippedOrDoneIds.has(item.id)
        ) {
          notifier.notify(item.id, { outcome: 'terminal', terminalKind: 'skipped' })
          continue
        }

        this.markActive(item.id)
        this.handoverPendingIds.add(item.id)
        try {
          this.updateItemStatus(item.id, 'analyzing', 10, undefined, { analysisStage: 2 })
          const cpuOutcome = await this.fileProcessor.processFile(item, signal, 'cpu')
          if (cpuOutcome.outcome === 'terminal') {
            this.handoverPendingIds.delete(item.id)
          }
          notifier.notify(item.id, cpuOutcome)
        } catch (err: unknown) {
          this.handoverPendingIds.delete(item.id)
          if (isAbortErrorLike(err, signal)) {
            this.updateItemStatus(item.id, 'pending', 0)
            notifier.notify(item.id, { outcome: 'terminal', terminalKind: 'skipped' })
          } else {
            this.updateItemStatus(
              item.id,
              'failed',
              100,
              err instanceof Error ? err.message : String(err),
              { isTimeout: isTimeoutError(err) }
            )
            notifier.notify(item.id, { outcome: 'terminal', terminalKind: 'failed' })
          }
        } finally {
          this.unmarkActive(item.id)
        }
      }
    }

    const runGPUConsumer = async () => {
      for (const item of pendingItems) {
        if (signal.aborted) break
        if (!this.getQueueManager()?.hasItem(item.id)) {
          // 已被删除的项不得滞留交接保护集合，否则 isItemActive / 目录中止判定会持续误判
          gpuSkippedOrDoneIds.add(item.id)
          this.handoverPendingIds.delete(item.id)
          continue
        }

        if (item.itemType === 'directory') {
          this.markActive(item.id)
          try {
            this.updateItemStatus(item.id, 'analyzing', 0)
            await this.directoryProcessor.processDirectory(item)
          } finally {
            gpuSkippedOrDoneIds.add(item.id)
            this.unmarkActive(item.id)
          }
          continue
        }

        this.markActive(item.id)
        let shouldBreak = false
        try {
          const cpuOutcome = await notifier.waitForStage2(
            item.id,
            () => cpuSkippedOutcomes.get(item.id) ?? false,
            signal,
            stage2WaitTimeoutMs
          )

          if (!this.getQueueManager()?.hasItem(item.id)) continue
          // 仅当 CPU 阶段明确返回 proceed 时才推进至 AI 阶段；terminal 终态（cache_hit/空文件/simple/failed/skipped）直接跳过
          if (cpuOutcome.outcome === 'terminal') continue
          if (item.status === 'failed' || item.status === 'completed') continue

          let effectiveMode: AnalysisMode
          try {
            const wsConfig = await getCachedWorkspaceConfig(item.workspaceId ?? null)
            effectiveMode = wsConfig.effectiveParams.analysisMode
          } catch (cfgErr) {
            logger.warn(
              LogCategory.ANALYSIS_QUEUE,
              `[并行队列:GPU通道] 解析工作区有效模式失败，回退全局有效模式: ${item.name}`,
              cfgErr
            )
            effectiveMode = resolveEffectiveAnalysisMode(hasInstalledAiEngine)
          }

          const aiResult = await this.runAiPhaseWithFallback(item, signal, {
            effectiveMode,
            cpuSkipped: cpuOutcome.cpuSkipped,
            fingerprint: cpuOutcome.fingerprint
          })
          if (aiResult === 'aborted') {
            shouldBreak = true
          }
          // 'done' 严格 continue（严禁 return 导致后续文件漏处理）
        } catch (err: unknown) {
          const errObj = err as { name?: string; message?: string } | null
          const isAbort = isAbortErrorLike(err, signal)
          const isStage2Timeout =
            err instanceof Stage2TimeoutError || errObj?.name === 'Stage2TimeoutError'

          if (isAbort) {
            this.updateItemStatus(item.id, 'pending', 0)
            shouldBreak = true
          } else if (isStage2Timeout) {
            this.updateItemStatus(item.id, 'pending', 0)
          } else {
            this.updateItemStatus(
              item.id,
              'failed',
              100,
              err instanceof Error ? err.message : String(err),
              { isTimeout: isTimeoutError(err) }
            )
          }
        } finally {
          gpuSkippedOrDoneIds.add(item.id)
          this.unmarkActive(item.id)
          this.handoverPendingIds.delete(item.id)
        }

        if (shouldBreak) break
      }
    }

    moduleHibernationCoordinator.notifyModuleResident('firefly-ai-engine')
    this.activeParallelWorkspaceId = pendingItems[0]?.workspaceId ?? null
    try {
      await Promise.all([runCPUProducer(), runGPUConsumer()])
    } finally {
      // 中止退出时，将所有尚未经 GPU 消费者收口且处于非终态的已提取项统一回滚 pending(0)
      if (signal.aborted) {
        for (const item of pendingItems) {
          if (item.itemType === 'directory') continue
          if (gpuSkippedOrDoneIds.has(item.id)) continue
          if (!this.getQueueManager()?.hasItem(item.id)) continue
          if (item.status !== 'completed' && item.status !== 'failed') {
            this.updateItemStatus(item.id, 'pending', 0)
          }
        }
      }
      this.activeParallelWorkspaceId = null
      this.handoverPendingIds.clear()
      this.parallelItemPaths.clear()
    }
  }
}
