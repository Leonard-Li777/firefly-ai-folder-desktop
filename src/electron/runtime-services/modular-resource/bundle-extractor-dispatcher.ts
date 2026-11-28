/**
 * 离线总包解包工作线程调度器 (Bundle Extractor Dispatcher)
 *
 * 核心职责：
 * 1. 控制面中继：主进程主线程负责任务调度、生命周期看护与进度推流，主事件循环 CPU 占用趋零；
 * 2. 线程隔离派发：将 IO/CPU 密集的流式解包与 SHA-256 校验任务委托给独立的 worker_threads；
 * 3. 稳健取消与资源释放协议：监听 AbortSignal，向 Worker 发送 ABORT 并等待 RELEASED 确认；
 * 4. 异常收尾与暂存区清理：捕获 Worker 异常、OOM 或非零退出，立即清空 _staging 暂存区并抛出结构化错误。
 */

import * as fs from 'fs'
import * as path from 'path'
import { Worker } from 'worker_threads'
import { logger, LogCategory } from '@firefly/shared'
import { existsAsync } from '../../infra/fs'
import {
  BundleExtractorError,
  type BundleExtractorWorkerOptions,
  type BundleExtractorResult,
  type ExtractorWorkerInMessage,
  type ExtractorWorkerOutMessage,
  type ResourceIoOp,
  type ResourceIoOpResult,
  inProcessExecuteResourceIoOp
} from './workers/bundle-extractor-worker'

export interface DispatchOptions {
  /** 任务入参 */
  workerOptions: BundleExtractorWorkerOptions
  /** 用户取消信号 */
  signal?: AbortSignal
  /** 进度回调 */
  onProgress?: (processedBytes: number, totalBytes: number, currentEntry?: string) => void
  /** 自定义 Worker 脚本路径（可选，主要用于测试或特殊打包环境） */
  customWorkerScriptPath?: string
  /** 500ms 释放超时后的硬终止宽限时间 (毫秒, 默认 2000ms) */
  cancellationTimeoutMs?: number
}

/**
 * 解析 Worker 执行脚本路径
 */
export function resolveExtractorWorkerPath(customPath?: string): string {
  if (customPath && fs.existsSync(customPath)) {
    return customPath
  }

  // 1. 同目录打包产物 (out_build/main/bundle-extractor-worker.js)
  const candidate1 = path.join(__dirname, 'bundle-extractor-worker.js')
  if (fs.existsSync(candidate1)) return candidate1

  // 2. 子目录打包产物
  const candidate2 = path.join(__dirname, 'workers', 'bundle-extractor-worker.js')
  if (fs.existsSync(candidate2)) return candidate2

  // 3. 单元测试环境：由 tsx 直接加载源码 TS（仅测试可走此路径）
  const candidate3 = path.join(__dirname, 'workers', 'bundle-extractor-worker.ts')
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    if (fs.existsSync(candidate3)) return candidate3
  }

  // 未命中任何候选：返回最后候选路径，由 extract() 显式抛出 WORKER_SCRIPT_MISSING，
  // 严禁在此静默兜底（打包态回落到 .ts 只会导致 mock 式假跑通）
  return path.join(__dirname, 'workers', 'bundle-extractor-worker.ts')
}

/**
 * 离线总包解包主线程调度器
 */
export class BundleExtractorDispatcher {
  /**
   * 启动 Worker 线程执行流式解包与双向核验
   */
  static async extract(options: DispatchOptions): Promise<BundleExtractorResult> {
    const {
      workerOptions,
      signal,
      onProgress,
      customWorkerScriptPath,
      cancellationTimeoutMs = 2000
    } = options

    const workerScript = resolveExtractorWorkerPath(customWorkerScriptPath)
    const isTsFile = workerScript.endsWith('.ts')

    // 打包态硬校验：worker 脚本必须真实存在，否则显式失败（该路径此前静默回落到源码 .ts，必然找不到）
    if (!fs.existsSync(workerScript)) {
      throw new BundleExtractorError(
        'WORKER_SCRIPT_MISSING',
        `解包 Worker 脚本不存在：${workerScript}（请确认 electron.vite 已编译 bundle-extractor-worker 入口）`
      )
    }

    // 暂存目录清理辅助闭包
    const cleanStagingDir = (): void => {
      try {
        if (workerOptions.stagingDir && fs.existsSync(workerOptions.stagingDir)) {
          fs.rmSync(workerOptions.stagingDir, { recursive: true, force: true })
        }
      } catch (rmErr) {
        logger.warn(LogCategory.SYSTEM, '[BundleExtractor] 清理暂存目录失败:', rmErr)
      }
    }

    if (signal?.aborted) {
      cleanStagingDir()
      throw new BundleExtractorError('CANCELLED', '用户在解包启动前已取消')
    }

    return new Promise<BundleExtractorResult>((resolve, reject) => {
      let intentionalCancellation = false
      let isSettled = false
      let worker: Worker | null = null

      // 安全收敛结果，防止重复 resolve / reject
      const settleReject = (err: Error): void => {
        if (isSettled) return
        isSettled = true
        cleanStagingDir()
        if (worker) {
          try {
            worker.terminate()
          } catch {
            // 忽略 Worker 已终止异常
          }
          worker = null
        }
        reject(err)
      }

      const settleResolve = (res: BundleExtractorResult): void => {
        if (isSettled) return
        isSettled = true
        if (worker) {
          try {
            worker.terminate()
          } catch {
            // 忽略 Worker 已终止异常
          }
          worker = null
        }
        resolve(res)
      }

      try {
        // 创建独立工作线程
        worker = new Worker(workerScript, {
          execArgv: isTsFile ? ['--import', 'tsx'] : []
        })
      } catch (workerSpawnErr) {
        settleReject(
          new BundleExtractorError(
            'IO_FAILURE',
            `无法派发解包工作线程: ${(workerSpawnErr as Error)?.message}`
          )
        )
        return
      }

      // 监听用户中止信号
      let abortTimeoutTimer: NodeJS.Timeout | null = null
      if (signal) {
        signal.addEventListener('abort', () => {
          intentionalCancellation = true
          if (worker) {
            try {
              worker.postMessage({ type: 'ABORT' } satisfies ExtractorWorkerInMessage)
            } catch {
              // 忽略向已销毁 Worker 发送消息异常
            }

            // 启动硬终止有界等待计时器 (防止杀软锁定等导致 Worker 无法退出)
            abortTimeoutTimer = setTimeout(() => {
              if (!isSettled && worker) {
                logger.warn(LogCategory.SYSTEM, '[BundleExtractor] 取消等待超时，执行硬终止')
                try {
                  worker.terminate()
                } catch {
                  // 忽略终止失败异常
                }
                settleReject(new BundleExtractorError('CANCELLED', '用户取消解包 (等待超时终止)'))
              }
            }, cancellationTimeoutMs)
          }
        })
      }

      // 监听 Worker 输出消息
      worker.on('message', (msg: ExtractorWorkerOutMessage) => {
        if (!msg || typeof msg !== 'object') return

        if (msg.type === 'PROGRESS') {
          onProgress?.(msg.processedBytes, msg.totalBytes, msg.currentEntry)
        } else if (msg.type === 'RELEASED' || msg.type === 'RELEASE_TIMEOUT') {
          if (abortTimeoutTimer) {
            clearTimeout(abortTimeoutTimer)
            abortTimeoutTimer = null
          }
          settleReject(new BundleExtractorError('CANCELLED', '用户已主动取消解包流程'))
        } else if (msg.type === 'SUCCESS') {
          settleResolve(msg.result)
        } else if (msg.type === 'ERROR') {
          settleReject(
            new BundleExtractorError(msg.error.code, msg.error.message, msg.error.details)
          )
        }
      })

      // 监听 Worker 异常与异常退出
      worker.on('error', (err: Error) => {
        if (intentionalCancellation) {
          settleReject(new BundleExtractorError('CANCELLED', '用户取消解包'))
        } else {
          settleReject(
            new BundleExtractorError(
              'IO_FAILURE',
              `Worker 工作线程内部致命异常: ${err.message}`,
              err.stack
            )
          )
        }
      })

      worker.on('exit', (exitCode: number) => {
        if (abortTimeoutTimer) {
          clearTimeout(abortTimeoutTimer)
          abortTimeoutTimer = null
        }

        if (isSettled) return

        if (intentionalCancellation || exitCode === 0) {
          settleReject(new BundleExtractorError('CANCELLED', 'Worker 正常结束或用户主动中止'))
        } else {
          settleReject(
            new BundleExtractorError(
              'IO_FAILURE',
              `解包工作线程异常退出 (exitCode=${exitCode})，已清理暂存区`
            )
          )
        }
      })

      // 向 Worker 发送 START 启动消息
      worker.postMessage({
        type: 'START',
        options: workerOptions
      } satisfies ExtractorWorkerInMessage)
    })
  }
}

/**
 * 资源目录 I/O 下沉调度器（P2-3：复用既有 bundle-extractor-worker，禁新建第二个 worker 进程模型）
 *
 * 失败回退契约：Worker 脚本缺失、启动失败或执行崩溃时，显式记录 `logger.warn` 并递增 `fallbackCount`，
 * 再回退至主进程异步实现 `inProcessExecuteResourceIoOp`（严禁静默降级）。
 */
export class ResourceIoDispatcher {
  private static fallbackCount = 0
  private static workerDispatchCount = 0

  public static getStats(): { workerDispatchCount: number; fallbackCount: number } {
    return {
      workerDispatchCount: this.workerDispatchCount,
      fallbackCount: this.fallbackCount
    }
  }

  public static resetStatsForTesting(): void {
    this.fallbackCount = 0
    this.workerDispatchCount = 0
  }

  public static async run(
    op: ResourceIoOp,
    options?: { customWorkerScriptPath?: string; forceWorkerFailureForTest?: boolean }
  ): Promise<ResourceIoOpResult> {
    try {
      if (options?.forceWorkerFailureForTest) {
        throw new Error('simulated resource io worker failure')
      }
      const workerScript = resolveExtractorWorkerPath(options?.customWorkerScriptPath)
      if (!(await existsAsync(workerScript))) {
        throw new Error(`worker 脚本不存在: ${workerScript}`)
      }
      const isTsFile = workerScript.endsWith('.ts')
      this.workerDispatchCount += 1

      return await new Promise<ResourceIoOpResult>((resolve, reject) => {
        let settled = false
        let worker: Worker | null = null
        const settle = (fn: () => void): void => {
          if (settled) return
          settled = true
          if (worker) {
            try {
              void worker.terminate()
            } catch {
              // ignore
            }
            worker = null
          }
          fn()
        }

        try {
          worker = new Worker(workerScript, {
            execArgv: isTsFile ? ['--import', 'tsx'] : []
          })
        } catch (err) {
          settle(() => reject(err))
          return
        }

        worker.on('message', (msg: ExtractorWorkerOutMessage) => {
          if (msg?.type === 'FS_OP_RESULT') {
            settle(() => resolve(msg.result))
          } else if (msg?.type === 'ERROR') {
            settle(() =>
              reject(new BundleExtractorError(msg.error.code, msg.error.message, msg.error.details))
            )
          }
        })
        worker.on('error', err => settle(() => reject(err)))
        worker.on('exit', code => {
          if (!settled && code !== 0) {
            settle(() => reject(new Error(`bundle-extractor-worker 异常退出 (exitCode=${code})`)))
          }
        })
        worker.postMessage({ type: 'FS_OP', op } satisfies ExtractorWorkerInMessage)
      })
    } catch (err) {
      // 仅对 Worker 基础设施错误（缺失/启动失败/崩溃）回退；业务错误（如 ENOENT/EPERM）也显式记录并回退验证
      this.fallbackCount += 1
      logger.warn(
        LogCategory.SYSTEM,
        `[ResourceIoDispatcher] Worker 执行 ${op.type} 失败，回退主进程异步 inProcessExecuteResourceIoOp (fallbackCount=${this.fallbackCount}): ${err instanceof Error ? err.message : String(err)}`
      )
      return await inProcessExecuteResourceIoOp(op)
    }
  }
}
