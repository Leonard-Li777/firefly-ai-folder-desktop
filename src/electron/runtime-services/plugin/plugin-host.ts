/**
 * 单插件独占宿主生命周期管理器 (PluginHost)
 *
 * 遵循规格：plugin-runtime-sandbox-and-omni-seams-spec.md §2 与 §4.2
 */

import {
  ExitClassification,
  ExitDetails,
  ExitFacts,
  InFlightTask,
  IPluginUtilityProcess,
  NATIVE_CRASH_CODES,
  PayloadTooLargeError,
  PluginManifest,
  TaskState,
  UtilityProcessFactory,
  FileTooLargeError,
  MemoryLimitExceededError,
  WatchdogReason
} from './plugin-types'
import { PluginCircuitBreaker } from './plugin-circuit-breaker'
import { PluginHostStateMachine } from './plugin-host-state-machine'
import {
  MAX_RPC_ENVELOPE_BYTES,
  PluginReverseProxyGateway,
  validateRpcEnvelope
} from './plugin-ipc-guard'
import {
  calculateTaskTimeoutSec,
  isFileSizeTooLarge,
  PluginWatchdogGuard,
  pluginWatchdogGuard
} from './plugin-watchdog-guard'

export interface PluginHostOptions {
  manifest: PluginManifest
  utilityProcessFactory?: UtilityProcessFactory
  circuitBreaker?: PluginCircuitBreaker
  reverseProxyGateway?: PluginReverseProxyGateway
  watchdogGuard?: PluginWatchdogGuard
  /** 握手超时时间（毫秒），默认 20,000 (20s) */
  handshakeTimeoutMs?: number
  /** 自定义日志记录器 */
  logger?: {
    info: (...args: any[]) => void
    warn: (...args: any[]) => void
    error: (...args: any[]) => void
  }
}

/**
 * 依据进程退出码、信号及预期标志，推导客观退出事实 (Spec §3.4 / deriveExitFacts)
 */
export function deriveExitFacts(
  code: number | null,
  signal: string | null,
  expected = false
): ExitFacts {
  if (expected) {
    return { exitCode: code, signal, reason: 'clean-exit', expected: true, isAbnormalExit: false }
  }
  if (code === 0 && !signal) {
    return {
      exitCode: 0,
      signal: null,
      reason: 'clean-exit',
      expected: false,
      isAbnormalExit: false
    }
  }
  const isWindowsCrash =
    typeof code === 'number' &&
    (code >>> 0 === 0xc0000005 || code === -1073741819 || code === 3221225477 || code < 0)
  const isUnixCrash = signal === 'SIGSEGV' || signal === 'SIGABRT' || signal === 'SIGBUS'
  const isOom = code === 134 || code === 137 || signal === 'SIGKILL_OOM'
  if (isOom) {
    return { exitCode: code, signal, reason: 'oom', expected: false, isAbnormalExit: true }
  }
  if (isWindowsCrash || isUnixCrash || (typeof code === 'number' && code !== 0 && !signal)) {
    return { exitCode: code, signal, reason: 'crash', expected: false, isAbnormalExit: true }
  }
  return { exitCode: code, signal, reason: 'killed', expected: false, isAbnormalExit: true }
}

export class PluginHost {
  public readonly manifest: PluginManifest
  public readonly stateMachine: PluginHostStateMachine
  public readonly circuitBreaker: PluginCircuitBreaker
  public readonly reverseProxyGateway: PluginReverseProxyGateway
  public readonly watchdogGuard?: PluginWatchdogGuard

  private readonly utilityProcessFactory?: UtilityProcessFactory
  private readonly handshakeTimeoutMs: number
  private readonly logger: {
    info: (...args: any[]) => void
    warn: (...args: any[]) => void
    error: (...args: any[]) => void
  }

  private currentProcess: IPluginUtilityProcess | null = null
  private spawnPromise: Promise<void> | null = null
  private handshakeTimer: any = null

  /** 收集的 stderr 最近前 2KB 字符 */
  private stderrBuffer: string = ''
  private readonly MAX_STDERR_BYTES = 2048

  /** 是否被看门狗主动终止 */
  private watchdogKilled: boolean = false
  private watchdogReason: WatchdogReason | null = null
  private memGuardError: MemoryLimitExceededError | null = null

  /** 显式回收意图标记，防止异步退出时被竞态误判 */
  private isRetiring: boolean = false
  private retirePromise: Promise<void> | null = null
  /** 任务执行完毕后触发平滑回收标记 (2GB 正常内存阈值触发) */
  private retireAfterCurrentTask: boolean = false

  /** 累计处理任务数（用于周期回收） */
  private taskCount: number = 0

  constructor(options: PluginHostOptions) {
    this.manifest = options.manifest
    this.utilityProcessFactory = options.utilityProcessFactory
    this.circuitBreaker = options.circuitBreaker ?? new PluginCircuitBreaker()
    this.reverseProxyGateway = options.reverseProxyGateway ?? new PluginReverseProxyGateway()
    this.stateMachine = new PluginHostStateMachine()
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 20_000
    this.logger = options.logger ?? console
    this.watchdogGuard = options.watchdogGuard ?? pluginWatchdogGuard

    // 自动接入看门狗与内存监控守护
    this.watchdogGuard?.registerHost(this)
  }

  public get state() {
    return this.stateMachine.state
  }

  public get processGeneration() {
    return this.stateMachine.processGeneration
  }

  public get completedTaskCount() {
    return this.taskCount
  }

  public get pid(): number | undefined {
    return this.currentProcess?.pid
  }

  /**
   * 单飞拉起宿主进程 (Single-Flight Spawn)
   * 并发调用共享同一单例 Promise，仅 spawn 一次
   */
  public async ensureHost(): Promise<void> {
    const currentState = this.stateMachine.state

    if (currentState === 'READY' || currentState === 'BUSY') {
      return
    }

    if (currentState === 'STARTING' && this.spawnPromise) {
      return this.spawnPromise
    }

    if (currentState !== 'STOPPED') {
      throw new Error(`Cannot ensureHost from state: ${currentState}`)
    }

    this.stateMachine.transitionTo('STARTING')
    this.stderrBuffer = ''
    this.watchdogKilled = false
    this.watchdogReason = null
    this.memGuardError = null
    this.isRetiring = false
    this.retirePromise = null
    this.retireAfterCurrentTask = false

    this.spawnPromise = new Promise<void>((resolve, reject) => {
      let spawnReject: ((err: any) => void) | null = reject

      try {
        const generation = this.stateMachine.bumpGeneration()
        this.logger.info(`[PluginHost:${this.manifest.id}] Spawning generation ${generation}...`)

        let proc: IPluginUtilityProcess
        if (this.utilityProcessFactory) {
          proc = this.utilityProcessFactory(this.manifest.entry, [], {
            stdio: 'pipe',
            env: {
              ...process.env,
              PLUGIN_HOST_ID: this.manifest.id,
              PLUGIN_HOST_GENERATION: String(generation)
            }
          })
        } else {
          // Electron 生产环境原生适配
          const { utilityProcess } = require('electron')
          proc = utilityProcess.fork(this.manifest.entry, [], {
            stdio: 'pipe',
            env: {
              ...process.env,
              PLUGIN_HOST_ID: this.manifest.id,
              PLUGIN_HOST_GENERATION: String(generation)
            }
          })
        }

        this.currentProcess = proc

        // 绑定 stderr 日志采样
        if (proc.stderr) {
          proc.stderr.on('data', (chunk: Buffer | string) => {
            const str = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
            if (this.stderrBuffer.length < this.MAX_STDERR_BYTES) {
              this.stderrBuffer += str
              if (this.stderrBuffer.length > this.MAX_STDERR_BYTES) {
                this.stderrBuffer = this.stderrBuffer.slice(0, this.MAX_STDERR_BYTES)
              }
            }
          })
        }

        // 监听进程退出
        proc.on('exit', (code: number) => {
          const wasStarting = this.stateMachine.state === 'STARTING'
          const details = this.handleProcessExit(code, null)
          if (wasStarting && spawnReject) {
            spawnReject(
              new Error(
                `Process crashed during startup with code ${code} (${details.classification})`
              )
            )
            spawnReject = null
          }
        })

        // 监听进程启动错误
        proc.on('error', (err: Error) => {
          this.logger.error(`[PluginHost:${this.manifest.id}] Process error:`, err)
          if (this.stateMachine.state === 'STARTING') {
            this.clearHandshakeTimer()
            this.handleProcessExit(-1, 'SPAWN_ERROR')
            if (spawnReject) {
              spawnReject(err)
              spawnReject = null
            }
          }
        })

        // 监听子进程回传的 IPC 控制总线消息
        proc.on('message', (msg: any) => {
          this.handleChildMessage(msg)
        })

        // 握手看门狗定时器 (20s)
        this.handshakeTimer = setTimeout(() => {
          if (this.stateMachine.state === 'STARTING') {
            this.logger.error(
              `[PluginHost:${this.manifest.id}] Handshake timed out after ${this.handshakeTimeoutMs}ms`
            )
            this.clearHandshakeTimer()
            this.watchdogKilled = true
            this.watchdogReason = 'timeout'
            try {
              proc.kill()
            } catch (_) {}
            const err = new Error(`Plugin handshake timeout (${this.handshakeTimeoutMs}ms)`)
            if (spawnReject) {
              spawnReject(err)
              spawnReject = null
            }
          }
        }, this.handshakeTimeoutMs)

        // 进程就绪回调
        const onReady = () => {
          this.clearHandshakeTimer()
          if (this.stateMachine.state === 'STARTING') {
            this.stateMachine.transitionTo('READY')
            this.logger.info(`[PluginHost:${this.manifest.id}] Ready at generation ${generation}`)
            resolve()
            spawnReject = null
          }
        }

        if (typeof proc.on === 'function') {
          proc.on('spawn', onReady)
        }
      } catch (err) {
        this.clearHandshakeTimer()
        this.stateMachine.transitionTo('STOPPED', 'Spawn failure')
        if (spawnReject) {
          spawnReject(err)
          spawnReject = null
        }
      }
    }).finally(() => {
      this.spawnPromise = null
    })

    return this.spawnPromise
  }

  /**
   * 处理进程退出事件（退出清理屏障 Exit Barrier 的唯一事实源）
   */
  public handleProcessExit(code: number | null, signal: string | null): ExitDetails {
    this.clearHandshakeTimer()

    const rawCode = code ?? -1
    const unsignedCode = rawCode >>> 0
    const currentState = this.stateMachine.state
    const isStarting = currentState === 'STARTING'

    // 1. 分类退出四态（严格按优先级判别）
    let classification: ExitClassification
    let isDegraded = false
    let shouldRetry = false

    if (this.isRetiring) {
      // 1. 正常回收：只要标记了 isRetiring，无论退出码是否为 0 均归类 RETIRING (Spec §3.4 / §7.1.1 #5)
      classification = 'RETIRING'
      shouldRetry = false
      isDegraded = false
    } else if (isStarting) {
      // 2. 握手前失败（启动超20s或动态库载入直接崩溃，直接触发插件级熔断）
      classification = 'PRE_HANDSHAKE'
      shouldRetry = false
      isDegraded = false
    } else if (this.watchdogKilled) {
      // 3. 看门狗终止 (超时 或 内存守卫 mem_guard)
      classification = 'WATCHDOG'
      if (this.watchdogReason === 'mem_guard') {
        shouldRetry = false
        isDegraded = true
      } else {
        // timeout 场景：若是重试任务则不可再重试，直接降级
        const isRetryTask = !!this.stateMachine.currentTask?.isRetry
        shouldRetry = !isRetryTask
        isDegraded = isRetryTask
      }
    } else if (
      unsignedCode === NATIVE_CRASH_CODES.STATUS_ACCESS_VIOLATION ||
      unsignedCode === NATIVE_CRASH_CODES.STATUS_STACK_OVERFLOW ||
      unsignedCode === NATIVE_CRASH_CODES.STATUS_STACK_BUFFER_OVERRUN ||
      unsignedCode >= 0xc0000000
    ) {
      // 4. 原生确定性崩溃：0 次重试，直接 degraded
      classification = 'NATIVE_CRASH'
      shouldRetry = false
      isDegraded = true
    } else {
      // 其它未知非正常退出默认按崩溃处理
      classification = 'NATIVE_CRASH'
      shouldRetry = false
      isDegraded = true
    }

    // 计算客观退出事实 (Spec §3.4)
    const exitFacts = deriveExitFacts(rawCode, signal, this.isRetiring)

    const currentTask = this.stateMachine.currentTask

    // 2. 执行退出清理屏障原子三件事：
    // (1) 幂等 settleTask 拒绝在途任务
    if (currentTask) {
      this.reverseProxyGateway.unregisterTask(currentTask.taskId)

      const exitOutcome: TaskState = isDegraded ? 'degraded' : 'crashed'
      let err: Error
      if (this.watchdogReason === 'mem_guard' && this.memGuardError) {
        err = this.memGuardError
      } else {
        err = new Error(
          `Process exited unexpectedly with code ${rawCode} (${classification}). ${this.stderrBuffer ? `Stderr: ${this.stderrBuffer}` : ''}`
        )
      }
      if (classification !== 'RETIRING') {
        ;(err as any).code = 'E_PLUGIN_PROCESS_CRASHED'
      }
      ;(err as any).exitCode = rawCode
      ;(err as any).unsignedCode = unsignedCode
      ;(err as any).classification = classification
      ;(err as any).watchdogReason = this.watchdogReason
      ;(err as any).stderr = this.stderrBuffer
      ;(err as any).isDegraded = isDegraded
      ;(err as any).taskOutcome = exitOutcome
      ;(err as any).exitFacts = exitFacts

      this.stateMachine.settleTask(exitOutcome, err)

      // 更新文件级熔断
      if (isDegraded && currentTask.fileFingerprint) {
        this.circuitBreaker.markFileDegraded(
          currentTask.fileFingerprint,
          this.manifest.id,
          this.manifest.version
        )
      }
    }

    // (2) 更新插件级熔断账本
    if (classification === 'PRE_HANDSHAKE') {
      this.circuitBreaker.recordCrash(true)
    } else if (classification !== 'RETIRING') {
      this.circuitBreaker.recordCrash(false)
    }

    // (2.1) 广播插件崩溃事件 (Spec §3.4 / onPluginCrash)
    if (
      classification !== 'RETIRING' &&
      (exitFacts.isAbnormalExit ||
        classification === 'NATIVE_CRASH' ||
        classification === 'PRE_HANDSHAKE')
    ) {
      try {
        const { BrowserWindow } = require('electron')
        const payload = {
          pluginId: this.manifest.id,
          generation: this.stateMachine.processGeneration,
          exitFacts,
          classification,
          timestamp: Date.now()
        }
        BrowserWindow.getAllWindows().forEach((win: any) => {
          if (!win.isDestroyed()) {
            win.webContents.send('plugin:crashed', payload)
          }
        })
      } catch (_) {}

      try {
        const { ProbeBridgeService } = require('../e2e/probe-bridge')
        ProbeBridgeService.recordEvent('plugin', 'crashed', {
          pluginId: this.manifest.id,
          generation: this.stateMachine.processGeneration,
          exitFacts,
          classification
        })
      } catch (_) {}
    }

    // (3) 清理进程引用与通信通道
    this.currentProcess = null

    // (4) 显式经由 CLEANING 状态平滑收敛至 STOPPED（绝不自动重拉）
    try {
      if (this.stateMachine.state !== 'STOPPED') {
        if (this.stateMachine.canTransitionTo('CLEANING')) {
          this.stateMachine.transitionTo('CLEANING', `Process exit cleaning (${classification})`)
        }
        this.stateMachine.transitionTo('STOPPED', `Process exit (${classification})`)
      }
    } catch (_) {
      this.stateMachine.forceReset()
    }

    const details: ExitDetails = {
      code: rawCode,
      signal,
      classification,
      stderrExcerpt: this.stderrBuffer,
      isDegraded,
      shouldRetry
    }

    this.logger.warn(`[PluginHost:${this.manifest.id}] Barrier executed:`, details)
    return details
  }

  /**
   * 派发并执行单个分析任务
   */
  public async executeTask<TResult = any>(input: {
    taskId: string
    filePath: string
    fileSize: number
    fileFingerprint: string
    payload?: any
    isRetry?: boolean
    attempt?: number
  }): Promise<TResult> {
    // 0. 大文件拦截 (>1GB 直接跳过深度解析，回退 Omni 基线，绝不判死) (AC 4)
    if (isFileSizeTooLarge(input.fileSize)) {
      this.logger.info(
        `[PluginHost:${this.manifest.id}] File size ${input.fileSize}B > 1GB, skipping plugin analysis (too_large)`
      )
      const tooLargeErr = new FileTooLargeError(input.fileSize)
      ;(tooLargeErr as any).taskOutcome = 'too_large'
      throw tooLargeErr
    }

    // 1. 检查文件级熔断
    if (
      this.circuitBreaker.isFileDegraded(
        input.fileFingerprint,
        this.manifest.id,
        this.manifest.version
      )
    ) {
      const err = new Error(
        `File ${input.filePath} is already degraded for plugin ${this.manifest.id}`
      )
      ;(err as any).code = 'FILE_DEGRADED'
      ;(err as any).taskOutcome = 'degraded'
      throw err
    }

    // 2. 检查插件级熔断
    const circuit = this.circuitBreaker.canExecute()
    if (!circuit.allowed) {
      const err = new Error(circuit.reason ?? `Plugin ${this.manifest.id} circuit is open`)
      ;(err as any).code = 'CIRCUIT_OPEN'
      throw err
    }

    // 3. 保证宿主拉起 (单飞)
    if (this.stateMachine.state !== 'READY') {
      try {
        await this.ensureHost()
      } catch (ensureErr) {
        this.circuitBreaker.releaseHalfOpenProbe()
        throw ensureErr
      }
    }

    if (this.stateMachine.state !== 'READY') {
      this.circuitBreaker.releaseHalfOpenProbe()
      throw new Error(`Cannot execute task: host is in state ${this.stateMachine.state}`)
    }

    // 4. 任务级重置 stderr 缓冲，保证采样纯净
    this.stderrBuffer = ''

    // 5. 跃迁至 BUSY
    this.stateMachine.transitionTo('BUSY', `Assigning task ${input.taskId}`)

    const isRetry = Boolean(input.isRetry || (input.attempt && input.attempt > 1))
    let effectivePayload = input.payload
    if (isRetry) {
      effectivePayload = {
        ...effectivePayload,
        options: {
          ...(effectivePayload?.options || {}),
          skipRendering: true
        }
      }
    }

    return new Promise<TResult>((resolve, reject) => {
      const currentGen = this.stateMachine.processGeneration

      // 动态计算超时时间（若为重试任务，超时预算自动放宽 1.5 倍）
      const timeoutSec = calculateTaskTimeoutSec(
        input.fileSize,
        this.manifest.timeoutProfile,
        isRetry
      )
      const timeoutMs = timeoutSec * 1000

      let remainingDeadlineMs = timeoutMs
      let lastStartedAt = Date.now()
      let deadlineTimer: any = null

      const startWatchdogTimer = (durationMs: number) => {
        deadlineTimer = setTimeout(() => {
          this.logger.error(
            `[PluginHost:${this.manifest.id}] Task ${input.taskId} exceeded deadline ${timeoutMs}ms`
          )
          this.watchdogKilled = true
          this.watchdogReason = 'timeout'
          try {
            if (this.stateMachine.canTransitionTo('TERMINATING')) {
              this.stateMachine.transitionTo('TERMINATING', 'Watchdog timeout kill')
            }
            this.currentProcess?.kill()
          } catch (_) {}
        }, durationMs)
      }

      const pauseDeadline = () => {
        if (deadlineTimer) {
          clearTimeout(deadlineTimer)
          deadlineTimer = null
          const elapsed = Date.now() - lastStartedAt
          remainingDeadlineMs = Math.max(0, remainingDeadlineMs - elapsed)
          this.logger.info(
            `[PluginHost:${this.manifest.id}] Paused deadline for task ${input.taskId}, remaining: ${remainingDeadlineMs}ms`
          )
        }
      }

      const resumeDeadline = () => {
        if (!deadlineTimer && remainingDeadlineMs > 0) {
          lastStartedAt = Date.now()
          startWatchdogTimer(remainingDeadlineMs)
          this.logger.info(
            `[PluginHost:${this.manifest.id}] Resumed deadline for task ${input.taskId}, duration: ${remainingDeadlineMs}ms`
          )
        }
      }

      const extendDeadline = (bonusMs: number) => {
        if (deadlineTimer) {
          clearTimeout(deadlineTimer)
          deadlineTimer = null
        }
        const elapsed = Date.now() - lastStartedAt
        remainingDeadlineMs = Math.max(0, remainingDeadlineMs - elapsed) + bonusMs
        lastStartedAt = Date.now()
        startWatchdogTimer(remainingDeadlineMs)
        if (task) {
          task.remainingDeadlineMs = remainingDeadlineMs
          task.deadlineTimer = deadlineTimer
        }
        this.logger.info(
          `[PluginHost:${this.manifest.id}] Extended deadline for task ${input.taskId} by ${bonusMs}ms (new total remaining: ${remainingDeadlineMs}ms)`
        )
      }

      const checkRetireAfterTask = () => {
        if (this.retireAfterCurrentTask) {
          this.retireAfterCurrentTask = false
          this.retire().catch(err => {
            this.logger.error(
              `[PluginHost:${this.manifest.id}] Auto-retire after task failed:`,
              err
            )
          })
        }
      }

      const task: InFlightTask<TResult> = {
        taskId: input.taskId,
        processGeneration: currentGen,
        filePath: input.filePath,
        fileSize: input.fileSize,
        fileFingerprint: input.fileFingerprint,
        isRetry,
        resolve: val => {
          if (deadlineTimer) {
            clearTimeout(deadlineTimer)
            deadlineTimer = null
          }
          this.reverseProxyGateway.unregisterTask(input.taskId)
          this.taskCount += 1
          this.circuitBreaker.recordSuccess()
          if (this.stateMachine.state === 'BUSY') {
            this.stateMachine.transitionTo('READY')
          }
          resolve(val)
          checkRetireAfterTask()
        },
        reject: reason => {
          if (deadlineTimer) {
            clearTimeout(deadlineTimer)
            deadlineTimer = null
          }
          this.reverseProxyGateway.unregisterTask(input.taskId)
          if (this.stateMachine.state === 'BUSY') {
            this.stateMachine.transitionTo('READY')
          }
          reject(reason)
          checkRetireAfterTask()
        },
        startedAt: lastStartedAt,
        deadlineMs: timeoutMs,
        remainingDeadlineMs,
        pauseDeadline,
        resumeDeadline,
        extendDeadline,
        payload: effectivePayload
      }

      startWatchdogTimer(timeoutMs)
      task.deadlineTimer = deadlineTimer

      this.reverseProxyGateway.registerTask({
        taskId: input.taskId,
        authorizedFilePath: input.filePath,
        pauseDeadline,
        resumeDeadline
      })

      this.stateMachine.assignTask(task)

      // 发送任务到子进程
      const envelope = {
        processGeneration: currentGen,
        taskId: input.taskId,
        filePath: input.filePath,
        fileSize: input.fileSize,
        payload: effectivePayload
      }

      try {
        if (!this.currentProcess) {
          throw new Error('Process is not running')
        }
        this.currentProcess.postMessage(envelope)
        if (input.taskId === '__e2e_crash' || input.payload?.__e2e_crash) {
          setTimeout(() => {
            this.triggerE2ECrash(input.payload?.exitCode ?? 0xc0000005)
          }, 20)
        }
      } catch (postErr) {
        if (deadlineTimer) {
          clearTimeout(deadlineTimer)
          deadlineTimer = null
        }
        this.circuitBreaker.releaseHalfOpenProbe()
        this.reverseProxyGateway.unregisterTask(input.taskId)
        this.stateMachine.settleTask('failed', postErr)
      }
    })
  }

  /**
   * 接收来自子进程的消息（用于代际校验与结果结算）
   */
  public handleChildMessage(message: {
    processGeneration: number
    taskId: string
    success: boolean
    result?: any
    error?: any
    resultArtifactPath?: string
  }): boolean {
    if (!message || typeof message !== 'object') {
      return false
    }

    // 代际校验：严格丢弃迟到的旧代消息
    if (!this.stateMachine.isCurrentGeneration(message.processGeneration)) {
      this.logger.warn(
        `[PluginHost:${this.manifest.id}] Dropping stale message from generation ${message.processGeneration} (current: ${this.stateMachine.processGeneration})`
      )
      return false
    }

    const currentTask = this.stateMachine.currentTask
    if (!currentTask || currentTask.taskId !== message.taskId) {
      this.logger.warn(
        `[PluginHost:${this.manifest.id}] Dropping unmatched task response: ${message.taskId}`
      )
      return false
    }

    // 50KB UTF-8 字节硬门禁核验
    const envelopeCheck = validateRpcEnvelope(message)
    if (!envelopeCheck.valid) {
      this.logger.error(
        `[PluginHost:${this.manifest.id}] Response payload too large: ${envelopeCheck.byteLength}B > ${MAX_RPC_ENVELOPE_BYTES}B`
      )
      const largeErr = new PayloadTooLargeError(envelopeCheck.byteLength, MAX_RPC_ENVELOPE_BYTES)
      this.stateMachine.settleTask('failed', largeErr)
      return false
    }

    if (message.success) {
      this.stateMachine.settleTask('completed', undefined, message.result ?? message)
    } else {
      // 业务错误时进程依旧健康，通信探活成功解除半开
      this.circuitBreaker.recordSuccess()
      this.stateMachine.settleTask('failed', new Error(message.error ?? 'Plugin task failed'))
    }

    return true
  }

  /**
   * 周期安全回收 (Retiring GC)
   * 返回 Promise，安全等待真实退出事件
   */
  public async retire(): Promise<void> {
    if (this.stateMachine.state === 'STOPPED') return
    if (this.retirePromise) return this.retirePromise

    this.logger.info(`[PluginHost:${this.manifest.id}] Retiring process...`)
    this.isRetiring = true

    if (this.stateMachine.state === 'READY') {
      this.stateMachine.transitionTo('RETIRING')
    }

    this.retirePromise = new Promise<void>(resolve => {
      const proc = this.currentProcess
      if (!proc) {
        resolve()
        return
      }

      const onExit = () => {
        resolve()
      }

      proc.on('exit', onExit)
      try {
        proc.kill()
      } catch (_) {
        resolve()
      }
    })

    return this.retirePromise
  }

  /**
   * 紧急内存硬杀 (AC 3: min(4GB, 25% RAM))
   */
  public terminateForMemoryGuard(workingSetBytes: number, limitBytes: number): void {
    this.logger.error(
      `[PluginHost:${this.manifest.id}] Terminating process due to mem_guard limit (${workingSetBytes}B >= ${limitBytes}B)`
    )
    this.watchdogKilled = true
    this.watchdogReason = 'mem_guard'
    this.memGuardError = new MemoryLimitExceededError(workingSetBytes, limitBytes)
    try {
      if (this.stateMachine.canTransitionTo('TERMINATING')) {
        this.stateMachine.transitionTo('TERMINATING', 'mem_guard kill')
      }
      this.currentProcess?.kill()
    } catch (_) {}
  }

  /**
   * 正常内存平滑回收 (2GB 阈值)
   */
  public markRetiringDueToMemory(workingSetBytes: number): void {
    this.logger.warn(
      `[PluginHost:${this.manifest.id}] WorkingSet reached ${workingSetBytes}B >= 2GB, marking for retiring`
    )
    this.isRetiring = true
    if (this.stateMachine.state === 'READY') {
      this.retire().catch(err => {
        this.logger.error(`[PluginHost:${this.manifest.id}] Retire error:`, err)
      })
    } else if (this.stateMachine.state === 'BUSY') {
      this.retireAfterCurrentTask = true
    }
  }

  /**
   * 系统休眠唤醒补偿 (AC 2)
   */
  public compensateSystemResume(bonusCompensationMs = 15000): void {
    const currentTask = this.stateMachine.currentTask
    if (!currentTask || this.stateMachine.state !== 'BUSY') return

    this.logger.info(
      `[PluginHost:${this.manifest.id}] Compensating task ${currentTask.taskId} after sleep resume (+${bonusCompensationMs}ms)`
    )
    if (typeof currentTask.extendDeadline === 'function') {
      currentTask.extendDeadline(bonusCompensationMs)
    }
  }

  /**
   * E2E 模式受控故障注入：向当前插件子进程注入崩溃 (Spec §3.4 / §4.7)
   */
  public triggerE2ECrash(exitCode: number = 0xc0000005): void {
    this.logger.warn(
      `[PluginHost:${this.manifest.id}] Triggering E2E crash with exit code 0x${(exitCode >>> 0).toString(16)}...`
    )
    const proc = this.currentProcess
    if (proc) {
      try {
        proc.postMessage({ type: '__e2e_crash', exitCode })
      } catch (_) {}
      setTimeout(() => {
        try {
          proc.kill()
        } catch (_) {}
        if (this.currentProcess === proc) {
          this.handleProcessExit(exitCode, null)
        }
      }, 30)
    } else {
      this.handleProcessExit(exitCode, null)
    }
  }

  /**
   * 强制销毁
   */
  public dispose(): void {
    this.watchdogGuard?.unregisterHost(this)
    this.clearHandshakeTimer()
    try {
      this.currentProcess?.kill()
    } catch (_) {}
    this.stateMachine.forceReset()
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
  }
}
