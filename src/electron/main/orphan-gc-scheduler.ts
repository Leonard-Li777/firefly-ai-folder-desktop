/**
 * 孤儿指纹 GC 调度器 (Issue 04 Step 1)
 *
 * 收编 `FileCleanupService.reconcileOrphanFingerprints()` 的两阶段对账触发时机：
 *  - 启动自愈：应用就绪后延迟触发一次，清理上次退出遗留的 orphan_gc_queue / vector_delete_outbox；
 *  - 删后防抖：删文件/删目录/删工作区后防抖触发（批量删除只合并为一次对账，防抖动）；
 *  - 定时兜底：低频兜底扫描，覆盖极端漏网（如阶段二 Omni 长时间离线后的自愈重试）。
 *
 * 设计约束：
 *  - 阶段一在途分析保护（R2-2a）与 SQL 守卫由 reconcileOrphanFingerprints 内部保证；
 *  - 单飞（single-flight）：上一轮未跑完不叠加新调度，仅置 pending 标志在收尾时再跑一轮；
 *  - 严禁静默吞异常：所有调度路径的异常均 logger.warn 上报，保证可观测性。
 */
import { logger, LogCategory } from '@firefly/shared'
import type { FileCleanupService } from '../runtime-services/filesystem/file-cleanup-service'

/** 启动延迟（ms）：等 analysis-queue、file-watcher 等初始化稳定后再对账 */
const STARTUP_DELAY_MS = 8_000
/** 删后防抖窗口（ms）：批量删除期间合并多次触发为一次 */
const DELETE_DEBOUNCE_MS = 3_000
/** 定时兜底间隔（ms）：10 分钟一次低频兜底 */
const PERIODIC_INTERVAL_MS = 10 * 60_000

export class OrphanGcScheduler {
  private cleanup: FileCleanupService
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private periodicTimer: ReturnType<typeof setInterval> | null = null
  private running = false
  private pendingAfterRun = false

  constructor(cleanup: FileCleanupService) {
    this.cleanup = cleanup
  }

  /** 启动自愈 + 开启定时兜底 */
  start(): void {
    setTimeout(() => {
      void this.scheduleRun('startup')
    }, STARTUP_DELAY_MS)

    if (!this.periodicTimer) {
      this.periodicTimer = setInterval(() => {
        void this.scheduleRun('periodic')
      }, PERIODIC_INTERVAL_MS)
      // 不阻塞进程退出
      this.periodicTimer.unref?.()
    }
    logger.info(LogCategory.DATABASE_SERVICE, '[GC] 孤儿指纹调度器已启动')
  }

  /** 删后防抖触发（批量删除多次调用只合并为一次对账） */
  scheduleAfterDelete(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      void this.scheduleRun('after-delete')
    }, DELETE_DEBOUNCE_MS)
    this.debounceTimer.unref?.()
  }

  /** 单飞调度：运行中只置标志，收尾时再补一轮，防并发叠加 */
  private async scheduleRun(reason: string): Promise<void> {
    if (this.running) {
      this.pendingAfterRun = true
      return
    }
    this.running = true
    try {
      await this.cleanup.reconcileOrphanFingerprints({ runVectorPhase: true })
    } catch (err) {
      logger.warn(LogCategory.DATABASE_SERVICE, `[GC] 对账异常（reason=${reason}）:`, err)
    } finally {
      this.running = false
      if (this.pendingAfterRun) {
        this.pendingAfterRun = false
        void this.scheduleRun(`${reason}-pending`)
      }
    }
  }

  /** 停止定时器（应用退出时调用） */
  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
    if (this.periodicTimer) {
      clearInterval(this.periodicTimer)
      this.periodicTimer = null
    }
  }
}
