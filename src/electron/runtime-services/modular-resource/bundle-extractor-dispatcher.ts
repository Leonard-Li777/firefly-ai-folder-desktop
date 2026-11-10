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
import {
  BundleExtractorError,
  type BundleExtractorWorkerOptions,
  type BundleExtractorResult,
  type ExtractorWorkerInMessage,
  type ExtractorWorkerOutMessage
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

  // 3. 源码环境 TS 脚本
  const candidate3 = path.join(__dirname, 'workers', 'bundle-extractor-worker.ts')
  if (fs.existsSync(candidate3)) return candidate3

  // 兜底返回源码路径
  return path.resolve(__dirname, 'workers', 'bundle-extractor-worker.ts')
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
