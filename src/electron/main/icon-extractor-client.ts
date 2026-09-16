/**
 * icon-extractor-client.ts
 *
 * 图标提取子进程的宿主端（主进程侧）客户端。
 *
 * 背景：`extract-file-icon` 调用 Windows Shell COM API，必须在独立进程中执行，
 * 否则在主进程非 Chrome_UIThread 线程中调用会触发：
 *   Check failed: checker.CalledOnValidBrowserThread(thread_identifier).
 *   Must be called on Chrome_UIThread; actually called on Unknown Thread.
 * 同时 COM 调用是同步阻塞的，放在主进程会卡住事件循环。
 *
 * 因此本模块通过 child_process.fork() 拉起 `icon-extractor-worker.js`，
 * 将同步 COM 调用移出主进程，并以异步 Promise 形式暴露给调用方。
 *
 * 设计要点：
 * - 懒加载：首次请求时才 fork，避免拖慢主进程启动
 * - 单飞（in-flight 复用）：并发请求共享同一个子进程与同一份待响应队列
 * - 超时保护：单次请求超时后仅拒绝该请求，并重启子进程以丢弃可能已损坏的状态
 * - 崩溃自愈：子进程退出时拒绝所有挂起请求，下次请求按需重启
 */

import * as path from 'node:path'
import { fork, type ChildProcess } from 'node:child_process'
import { logger, LogCategory } from '@firefly/shared'

/** 单个图标提取请求的超时时间（毫秒） */
const REQUEST_TIMEOUT_MS = 10_000

/** 子进程 IPC 消息体（与 icon-extractor-worker.ts 的协议保持一致） */
interface IconWorkerResponse {
  id: number
  ready?: boolean
  base64?: string | null
  error?: string
}

/** 挂起中的请求：id → 结算回调 */
interface PendingRequest {
  resolve: (value: Buffer | null) => void
  reject: (reason?: unknown) => void
  timer: NodeJS.Timeout
}

class IconExtractorClient {
  private child: ChildProcess | null = null
  /** 子进程是否已完成启动握手（收到 id=-1 ready 消息） */
  private ready = false
  /** 启动握手的等待 Promise（并发请求共享，避免互相饿死） */
  private readyPromise: Promise<void> | null = null
  /** 握手成功时的 resolve 回调，由 spawnChild 收到的 ready 消息触发 */
  private readyResolve: (() => void) | null = null
  /** 已发出但未收到响应的请求 */
  private pending = new Map<number, PendingRequest>()
  private nextId = 1
  /** 子进程不可用（如模块加载失败）时置为 true，避免反复 fork */
  private disabled = false

  /**
   * 当前平台是否支持高清图标提取子进程。
   * extract-file-icon 为 Windows 专属 N-API 模块，非 Windows 直接返回 false。
   */
  isSupported(): boolean {
    return process.platform === 'win32' && !this.disabled
  }

  /**
   * 异步提取 256x256 高清图标。
   *
   * @param filePath 目标文件绝对路径（调用方需保证非空且已解析 .lnk 快捷方式）
   * @returns PNG Buffer；无法提取时返回 null（调用方降级到 app.getFileIcon）
   */
  async extractIcon(filePath: string): Promise<Buffer | null> {
    if (!this.isSupported()) return null

    try {
      await this.ensureChildReady()
    } catch (error) {
      logger.warn(LogCategory.MAIN, '[icon-client] 子进程启动失败，降级原生图标', error)
      return null
    }

    const child = this.child
    if (!child || !child.connected) return null

    const id = this.nextId++

    return await new Promise<Buffer | null>((resolve, reject) => {
      // 超时保护：原生 COM 调用可能因文件损坏等原因长时间不返回，
      // 超时后拒绝该请求并重启子进程，避免后续请求被一并拖死
      const timer = setTimeout(() => {
        this.pending.delete(id)
        logger.warn(
          LogCategory.MAIN,
          `[icon-client] 图标提取超时(${REQUEST_TIMEOUT_MS}ms)，重启子进程: ${filePath}`
        )
        this.restartChild()
        resolve(null)
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(id, { resolve, reject, timer })

      try {
        child.send({ id, filePath })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        logger.warn(LogCategory.MAIN, '[icon-client] 向子进程发送请求失败', error)
        resolve(null)
      }
    })
  }

  /**
   * 确保子进程已拉起并完成启动握手。
   * 首次调用时 fork，后续调用复用同一进程。
   *
   * 并发安全：多个请求可能同时进入此方法，若各自注册独立的等待者，
   * 则子进程只会触发一次握手，导致其余等待者直到超时才被拒绝。
   * 因此这里共享同一个"启动中"Promise。
   */
  private async ensureChildReady(): Promise<void> {
    if (this.child && this.ready && this.child.connected) return

    if (!this.child) this.spawnChild()

    // 复用正在进行的启动等待，避免并发请求各自注册等待者而互相饿死
    if (!this.readyPromise) {
      const child = this.child
      this.readyPromise = new Promise<void>((resolve, reject) => {
        const failTimer = setTimeout(() => {
          reject(new Error('icon-extractor 子进程启动握手超时'))
        }, REQUEST_TIMEOUT_MS)

        const onReady = (): void => {
          clearTimeout(failTimer)
          resolve()
        }

        // 子进程启动失败时兜底
        const onFail = (): void => {
          clearTimeout(failTimer)
          reject(new Error('icon-extractor 子进程不可用'))
        }

        this.readyResolve = onReady
        child?.once('error', onFail)
        child?.once('exit', onFail)
      }).finally(() => {
        // 握手结束后清除缓存，使后续重启能重新建立等待
        this.readyPromise = null
      })
    }

    await this.readyPromise
  }

  /**
   * fork 图标提取子进程并绑定 IPC 监听。
   * 入口文件固定为 main 构建产物目录下的 icon-extractor-worker.js，
   * 与主进程 main.js 同目录（dev 为 out_build/main，打包后位于 asar 内）。
   */
  private spawnChild(): void {
    const workerPath = path.join(__dirname, 'icon-extractor-worker.js')

    logger.info(LogCategory.MAIN, `[icon-client] 拉起图标提取子进程: ${workerPath}`)

    const child = fork(workerPath, [], {
      // 静默子进程的标准输出/错误，避免污染主进程控制台；
      // 子进程内部的诊断信息通过 IPC error 字段回传
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    })

    this.child = child
    this.ready = false

    child.on('message', (rawMsg: unknown) => {
      const msg = (rawMsg || {}) as IconWorkerResponse

      // 启动握手消息
      if (msg.id === -1 && msg.ready) {
        this.ready = true
        const resolveReady = this.readyResolve
        this.readyResolve = null
        resolveReady?.()
        return
      }

      const entry = this.pending.get(msg.id)
      if (!entry) return

      clearTimeout(entry.timer)
      this.pending.delete(msg.id)

      if (msg.error) {
        logger.debug(LogCategory.MAIN, `[icon-client] 子进程提取失败: ${msg.error}`)
      }

      if (msg.base64) {
        entry.resolve(Buffer.from(msg.base64, 'base64'))
      } else {
        // 提取失败或模块不可用，返回 null 由调用方降级
        entry.resolve(null)
      }
    })

    child.on('error', (error) => {
      logger.warn(LogCategory.MAIN, '[icon-client] 子进程发生错误', error)
      this.handleChildGone()
    })

    child.on('exit', (code, signal) => {
      // 正常退出（主进程关停）不告警，异常退出记录日志
      if (code !== 0 && code !== null) {
        logger.warn(
          LogCategory.MAIN,
          `[icon-client] 图标提取子进程异常退出 code=${code} signal=${signal}`
        )
      }
      this.handleChildGone()
    })
  }

  /**
   * 子进程失联时的统一清理：拒绝所有挂起请求，重置状态。
   * 下次 extractIcon 调用会按需重新 fork。
   */
  private handleChildGone(): void {
    this.child = null
    this.ready = false
    // 唤醒可能仍在等待握手的调用方，避免其一直挂到超时
    const resolveReady = this.readyResolve
    this.readyResolve = null
    resolveReady?.()
    this.readyPromise = null

    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer)
      // 子进程消失时不抛错，交由调用方降级到 app.getFileIcon
      entry.resolve(null)
    }
    this.pending.clear()
  }

  /**
   * 主动重启子进程（超时等异常场景），用于丢弃可能已损坏的子进程状态。
   */
  private restartChild(): void {
    const child = this.child
    this.handleChildGone()
    if (child && child.connected) {
      try {
        child.kill()
      } catch {
        // 忽略 kill 失败
      }
    }
  }

  /**
   * 应用退出时清理子进程，避免遗留僵尸进程。
   */
  dispose(): void {
    const child = this.child
    this.handleChildGone()
    if (child && child.connected) {
      try {
        child.kill()
      } catch {
        // 忽略 kill 失败
      }
    }
  }
}

/** 全局单例：整个主进程生命周期内复用一个图标提取子进程 */
export const iconExtractorClient = new IconExtractorClient()
