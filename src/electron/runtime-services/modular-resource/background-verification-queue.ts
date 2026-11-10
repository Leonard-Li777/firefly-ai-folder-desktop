/**
 * 离线总包后台延迟 Dry-Run 校验队列 (Background Verification Queue)
 *
 * 核心设计与不变量 (System Invariants):
 * 1. 控制面中继与单飞串行 (Concurrency = 1):
 *    全系统同一时刻仅允许一个 Worker 执行校验，主事件循环 CPU 占用归零；
 * 2. 两段式淘汰 (TTL 7天 + FIFO 50条):
 *    每次调度前执行淘汰，超期/超额任务统一置为 FAILED，磁盘上的 .ffp 永久保留绝对不删；
 * 3. 结果三向分流与精准熔断:
 *    - 自包含通过: 现场覆写同级旁路 <targetPath>.sha256，重置连续崩溃计数，更新 job 为 FINISHED；
 *    - 确定性损坏: 移入 Tombstone 隔离，更新 job 为 FAILED；
 *    - 暂时性 IO 锁 (Defender): 保留 .ffp 原文件，job 保持 CLEANUP_PENDING，重置崩溃计数；
 *    - 连续 3 次异常崩溃 (OOM/非零退出): 触发熔断置 FAILED，磁盘 .ffp 永久保留不删；
 * 4. 正常取消豁免:
 *    主动取消时向 Worker 发送 ABORT，code === 0 正常退出，重置崩溃计数，严禁误触发熔断。
 */

import * as fs from 'fs'
import * as path from 'path'
import { Worker } from 'worker_threads'
import { logger, LogCategory } from '@firefly/shared'
import type { OfflinePackageDao, OfflinePackageJobRecord } from './offline-package-dao'
import type { BackgroundVerificationLockState } from './offline-bundle-exporter'
import {
  BundleVerifierWorkerLogic,
  type VerifierWorkerOptions,
  type VerifierWorkerOutMessage
} from './workers/bundle-verifier-worker'

export interface BackgroundQueueOptions {
  dao: OfflinePackageDao
  customWorkerScriptPath?: string
  /** 调度延迟 (毫秒, 默认 5000ms) */
  initialDelayMs?: number
  /** 自定义公钥 (测试用) */
  customPublicKey?: string
  /** 单元测试直接内联执行 Worker 逻辑，不跨线程 (测试用) */
  inlineForTest?: boolean
}

/**
 * 解析 Verifier Worker 脚本路径
 */
export function resolveVerifierWorkerPath(customPath?: string): string {
  if (customPath && fs.existsSync(customPath)) {
    return customPath
  }

  const candidate1 = path.join(__dirname, 'bundle-verifier-worker.js')
  if (fs.existsSync(candidate1)) return candidate1

  const candidate2 = path.join(__dirname, 'workers', 'bundle-verifier-worker.js')
  if (fs.existsSync(candidate2)) return candidate2

  const candidate3 = path.join(__dirname, 'workers', 'bundle-verifier-worker.ts')
  if (fs.existsSync(candidate3)) return candidate3

  return path.resolve(__dirname, 'workers', 'bundle-verifier-worker.ts')
}

export class BackgroundVerificationQueue {
  private dao: OfflinePackageDao
  private customWorkerScriptPath?: string
  private customPublicKey?: string
  private inlineForTest: boolean

  private isRunning = false
  private isProcessing = false
  private activeJobId: string | null = null
  private activeWorker: Worker | null = null
  private startTimer: NodeJS.Timeout | null = null
  private currentAbortController: AbortController | null = null
  private lockState: BackgroundVerificationLockState = { active: false, isLocked: false }

  constructor(options: BackgroundQueueOptions) {
    this.dao = options.dao
    this.customWorkerScriptPath = options.customWorkerScriptPath
    this.customPublicKey = options.customPublicKey
    this.inlineForTest = options.inlineForTest ?? false
  }

  /**
   * 获取与导出管线协同的互斥锁状态
   */
  public getLockState(): BackgroundVerificationLockState {
    return this.lockState
  }

  /**
   * 启动后台延迟校验队列 (首屏后唤醒)
   */
  public start(delayMs = 5000): void {
    if (this.isRunning) return
    this.isRunning = true

    this.startTimer = setTimeout(() => {
      this.processNext().catch(err => {
        logger.error(LogCategory.SYSTEM, '[BackgroundVerificationQueue] 队列处理循环异常:', err)
      })
    }, delayMs)
  }

  /**
   * 立即触发一次处理 (供测试或手动调用)
   */
  public async triggerNow(): Promise<void> {
    if (this.startTimer) {
      clearTimeout(this.startTimer)
      this.startTimer = null
    }
    this.isRunning = true
    await this.processNext()
  }

  /**
   * 优雅停止队列
   */
  public async stop(): Promise<void> {
    this.isRunning = false
    if (this.startTimer) {
      clearTimeout(this.startTimer)
      this.startTimer = null
    }

    if (this.activeWorker) {
      try {
        this.activeWorker.postMessage({ type: 'ABORT' })
      } catch {
        // ignore
      }
      this.activeWorker = null
    }
    this.activeJobId = null
    this.isProcessing = false
  }

  /**
   * 单飞串行核心调度循环
   */
  private async processNext(): Promise<void> {
    if (!this.isRunning || this.isProcessing) return
    this.isProcessing = true

    try {
      const nowMs = Date.now()

      // 1. 获取待处理的 CLEANUP_PENDING 任务
      const pendingJobs = this.dao.getCleanupPendingJobs()
      if (pendingJobs.length === 0) {
        return
      }

      // 2. 锁定即将处理的候选任务，并在淘汰时予以豁免保护 (防 FIFO 误杀即将执行的首个任务)
      const candidateJob = pendingJobs[0]
      this.activeJobId = candidateJob.job_id

      // 3. 两段式淘汰 (TTL 7天 + FIFO 50条)，豁免保护 activeJobId
      const evictedIds = this.dao.evictExpiredOrOverflownJobs(nowMs, 7, 50, this.activeJobId)
      if (evictedIds.includes(candidateJob.job_id)) {
        // 若候选任务本身已因 TTL 超时淘汰，跳过执行
        return
      }

      const job = candidateJob
      this.currentAbortController = new AbortController()
      this.lockState = {
        active: true,
        isLocked: true,
        jobId: job.job_id,
        archivePath: job.archive_path,
        abortController: this.currentAbortController
      }

      // 4. 调度前递增总尝试计数 (审计统计用)
      this.dao.incrementVerificationAttempts(job.job_id, nowMs)

      // 5. 执行自包含物理核验
      await this.verifySingleJob(job)
    } finally {
      this.activeJobId = null
      this.lockState = { active: false, isLocked: false }
      this.currentAbortController = null
      this.isProcessing = false

      // 若队列中仍有待处理任务且处于运行态，自动继续调度下一条
      if (this.isRunning) {
        const remaining = this.dao.getCleanupPendingJobs()
        if (remaining.length > 0) {
          setImmediate(() => {
            this.processNext().catch(err => {
              logger.error(LogCategory.SYSTEM, '[BackgroundVerificationQueue] 连续调度异常:', err)
            })
          })
        }
      }
    }
  }

  /**
   * 校验单个任务
   */
  private async verifySingleJob(job: OfflinePackageJobRecord): Promise<void> {
    const ffpPath = job.archive_path
    const nowMs = Date.now()

    // 若磁盘文件根本不存在，确定性失败置为 FAILED
    if (!fs.existsSync(ffpPath)) {
      logger.warn(LogCategory.SYSTEM, `[BackgroundVerificationQueue] 物理包文件不存在: ${ffpPath}`)
      this.dao.updateJobStatus(job.job_id, 'FAILED', { nowMs })
      return
    }

    const workerOptions: VerifierWorkerOptions = {
      archivePath: ffpPath,
      customPublicKey: this.customPublicKey
    }

    if (this.inlineForTest) {
      // 单元测试内联执行通道
      const logic = new BundleVerifierWorkerLogic()
      try {
        const res = await logic.verify(workerOptions)
        // 校验通过：覆写旁路 <targetPath>.sha256
        this.writeBypassSha256(ffpPath, res.computedFileSha256)
        this.dao.resetWorkerCrash(job.job_id, nowMs)
        this.dao.updateJobStatus(job.job_id, 'FINISHED', { nowMs })
      } catch (err: unknown) {
        const errType = (err as { errorType?: string })?.errorType
        if (errType === 'TRANSIENT_IO_ERROR') {
          // 暂时性 IO 锁：保留 .ffp 原文件，保留 CLEANUP_PENDING，重置崩溃计数
          this.dao.resetWorkerCrash(job.job_id, nowMs)
          this.dao.updateJobStatus(job.job_id, 'CLEANUP_PENDING', { nowMs })
        } else if (errType === 'CANCELLED') {
          this.dao.resetWorkerCrash(job.job_id, nowMs)
        } else {
          // 确定性损坏：置为 FAILED，移入 Tombstone 隔离
          this.moveCorruptedToTombstone(ffpPath)
          this.dao.updateJobStatus(job.job_id, 'FAILED', { nowMs })
        }
      }
      return
    }

    // 独立工作线程执行通道
    await new Promise<void>(resolve => {
      const scriptPath = resolveVerifierWorkerPath(this.customWorkerScriptPath)
      const isTs = scriptPath.endsWith('.ts')

      const worker = new Worker(scriptPath, {
        execArgv: isTs ? ['-r', 'ts-node/register'] : undefined
      })
      this.activeWorker = worker

      let isFinished = false

      worker.on('message', (msg: VerifierWorkerOutMessage) => {
        if (msg.type === 'DONE') {
          isFinished = true
          // 1. 现场重新覆写旁路 <targetPath>.sha256 文本文件
          this.writeBypassSha256(ffpPath, msg.result.computedFileSha256)
          // 2. 重置连续崩溃计数
          this.dao.resetWorkerCrash(job.job_id, Date.now())
          // 3. 更新为 FINISHED 终态
          this.dao.updateJobStatus(job.job_id, 'FINISHED', { nowMs: Date.now() })
        } else if (msg.type === 'ERROR') {
          isFinished = true
          if (msg.errorType === 'TRANSIENT_IO_ERROR') {
            // 暂时性 IO 锁退出：保留原文件，重置崩溃计数，保持 CLEANUP_PENDING
            this.dao.resetWorkerCrash(job.job_id, Date.now())
            this.dao.updateJobStatus(job.job_id, 'CLEANUP_PENDING', { nowMs: Date.now() })
          } else if (msg.errorType === 'CANCELLED') {
            this.dao.resetWorkerCrash(job.job_id, Date.now())
          } else {
            // 确定性损坏：移入 Tombstone，更新为 FAILED
            this.moveCorruptedToTombstone(ffpPath)
            this.dao.updateJobStatus(job.job_id, 'FAILED', { nowMs: Date.now() })
          }
        }
      })

      worker.on('exit', code => {
        this.activeWorker = null

        if (!isFinished) {
          // Worker 遭遇异常崩溃 (如 OOM、未捕获异常或非零退出)
          if (code !== 0) {
            const { shouldTrip } = this.dao.recordWorkerCrash(job.job_id, Date.now())
            if (shouldTrip) {
              logger.error(
                LogCategory.SYSTEM,
                `[BackgroundVerificationQueue] 连续 3 次 Worker 崩溃，触发熔断: ${job.job_id}`
              )
              // 触发熔断置为 FAILED，但磁盘上的 .ffp 永久保留不删！
              this.dao.tripCircuitBreaker(job.job_id, Date.now())
            }
          } else {
            // 正常退出重置崩溃计数
            this.dao.resetWorkerCrash(job.job_id, Date.now())
          }
        }
        resolve()
      })

      worker.on('error', err => {
        logger.error(LogCategory.SYSTEM, '[BackgroundVerificationQueue] Worker 运行错误:', err)
      })

      // 启动核验
      worker.postMessage({
        type: 'START',
        options: workerOptions
      })
    })
  }

  /**
   * 旁路覆盖写入 <targetPath>.sha256 (1ms 文本写入，绝不因旁路文件不一致误删有效 .ffp)
   */
  private writeBypassSha256(ffpPath: string, sha256Hex: string): void {
    const bypassPath = `${ffpPath}.sha256`
    try {
      fs.writeFileSync(bypassPath, sha256Hex, 'utf-8')
    } catch (err) {
      logger.warn(
        LogCategory.SYSTEM,
        `[BackgroundVerificationQueue] 写入旁路 sha256 文件失败: ${bypassPath}`,
        err
      )
    }
  }

  /**
   * 确定性损坏文件的 Tombstone 隔离
   */
  private moveCorruptedToTombstone(ffpPath: string): void {
    try {
      if (fs.existsSync(ffpPath)) {
        const dir = path.dirname(ffpPath)
        const base = path.basename(ffpPath)
        const tombstonePath = path.join(dir, `${base}.corrupted-${Date.now()}`)
        fs.renameSync(ffpPath, tombstonePath)
      }
    } catch (err) {
      logger.warn(
        LogCategory.SYSTEM,
        `[BackgroundVerificationQueue] 隔离损坏包文件失败: ${ffpPath}`,
        err
      )
    }
  }
}
