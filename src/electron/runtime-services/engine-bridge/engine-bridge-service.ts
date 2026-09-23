/**
 * Engine Bridge Service - 桌面端与 Tier 2 上层 AI 引擎的桥接服务
 * apps/desktop/src/electron/runtime-services/engine-bridge/engine-bridge-service.ts
 *
 * 核心职责（slice-3 桌面解耦）：
 * 1. 负责 firefly-ai-engine 上层 AI 引擎的探活、静默拉起（--silent --tray）、常驻连接
 * 2. 通过 HTTP 对外协议对接上个引擎（契约见 ADR-0033）：
 *    - GET  /api/engine/status      引擎运行状态快照
 *    - POST /api/engine/open-ui     打开引擎管理面板
 *    - POST /api/engine/shutdown    请求引擎优雅退出
 *    - POST /v1/chat/completions    上层 AI 推理（OpenAI 兼容）
 * 3. 内置 Tier2 熔断器：探活/推理持续失败时静默熔断，保护桌面主进程，
 *    分析流水线自动降级到 Tier 1（Omni 端侧）兜底
 * 4. 周期轮询引擎状态并广播给渲染进程（tier2:status-changed），支撑桥接监控面板
 */

import { ChildProcess, spawn, execSync } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import { app, BrowserWindow } from 'electron'
import { ResourceLocator, logger, LogCategory, APP_PORTS } from '@firefly/shared'
import { Tier2CircuitBreaker, Tier2CircuitState } from './tier2-circuit-breaker'

/** Tier 2 引擎基准端口（与本地 AI 服务端口收敛一致：38400） */
export const TIER2_ENGINE_PORT = APP_PORTS.LLAMA_LOCAL_SERVER

/** 引擎对外协议端点 */
const ENGINE_STATUS_PATH = '/api/engine/status'
const ENGINE_OPEN_UI_PATH = '/api/engine/open-ui'
const ENGINE_SHUTDOWN_PATH = '/api/engine/shutdown'

/** 桥接请求超时（毫秒） */
const STATUS_TIMEOUT_MS = 1500
const OPEN_UI_TIMEOUT_MS = 3000
const SHUTDOWN_TIMEOUT_MS = 3000

/** 引擎拉起后的就绪等待上限（毫秒） */
const READY_WAIT_LIMIT_MS = 25_000
/** 状态轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 5_000

/**
 * 引擎状态快照（来自 /api/engine/status，字段以引擎契约为准，宽容解析）
 */
export interface Tier2EngineStatus {
  running?: boolean
  version?: string
  backend?: string
  active_backend?: string
  model?: string
  loaded_models?: string[]
  vram_mb?: number
  gpu_mem_mb?: number
  error?: string
  [key: string]: any
}

/**
 * 桥接监控面板使用的外部状态结构
 */
export interface EngineBridgeSnapshot {
  /** 引擎是否在线（端口可探活） */
  connected: boolean
  /** 熔断状态 */
  circuitState: Tier2CircuitState
  /** 引擎二进制是否可用（本地是否已部署 firefly-ai-engine） */
  available: boolean
  /** 引擎可执行文件绝对路径（未部署时为 null） */
  exePath: string | null
  /** 是否为开发模式（优先 dev 构建产物） */
  devMode: boolean
  /** 通信端口 */
  port: number
  /** 引擎版本（未就绪时为 null） */
  version: string | null
  /** 当前激活后端（cuda/vulkan/cpu/metal/...） */
  backend: string | null
  /** 当前加载模型 */
  model: string | null
  /** 显存占用（MB） */
  vramMb: number | null
  /** 最近一次异常信息（静默记录） */
  lastError: string | null
  /** 最近一次状态快照时间戳 */
  updatedAt: number | null
  /** 原始引擎状态（可能为空） */
  raw: Tier2EngineStatus | null
}

export class EngineBridgeService {
  private static instance: EngineBridgeService
  private process: ChildProcess | null = null
  private readonly baseUrl = `http://127.0.0.1:${TIER2_ENGINE_PORT}`
  private isStarting = false
  private startPromise: Promise<boolean> | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private lastRawStatus: Tier2EngineStatus | null = null
  private versionCache: string | null = null
  private lastError: string | null = null
  private listeners = new Set<(snapshot: EngineBridgeSnapshot) => void>()
  readonly circuitBreaker = new Tier2CircuitBreaker()

  private constructor() {
    this.setupLifecycleHooks()
  }

  public static getInstance(): EngineBridgeService {
    if (!EngineBridgeService.instance) {
      EngineBridgeService.instance = new EngineBridgeService()
    }
    return EngineBridgeService.instance
  }

  private setupLifecycleHooks(): void {
    try {
      if (app && typeof app.on === 'function') {
        app.on('will-quit', () => this.stop())
        app.on('before-quit', () => this.stop())
      }
      const cleanExit = () => this.stop()
      process.once('exit', cleanExit)
      process.once('SIGINT', cleanExit)
      process.once('SIGTERM', cleanExit)
    } catch (err) {
      // 生命周期钩子注册失败仅意味着退出回收依赖 Electron 默认行为，记日志便于排查残留进程
      logger.warn(LogCategory.SYSTEM, '[EngineBridge] 注册退出清理钩子失败:', err)
    }
  }

  /**
   * 定位 firefly-ai-engine 可执行文件
   * - 开发模式：优先 dev 构建产物（apps/firefly-ai-engine/src-tauri/target）
   * - 生产模式：extraResources/bin/firefly-ai-engine/firefly-ai-engine
   */
  public resolveEngineExecutable(): string | null {
    const isWin = process.platform === 'win32'
    const exeName = isWin ? 'firefly-ai-engine.exe' : 'firefly-ai-engine'
    const isDev = !app?.isPackaged || process.env.NODE_ENV !== 'production'
    const root = process.cwd()

    if (isDev) {
      const devCandidates = [
        path.join(root, 'apps', 'firefly-ai-engine', 'src-tauri', 'target', 'release', exeName),
        path.join(root, 'apps', 'firefly-ai-engine', 'src-tauri', 'target', 'debug', exeName)
      ]
      for (const cand of devCandidates) {
        if (fs.existsSync(cand)) {
          return cand
        }
      }
    }

    // 生产 / 已部署环境：优先通过 ResourceLocator 检索
    const bin = ResourceLocator.resolveBin(
      isWin ? 'firefly-ai-engine/firefly-ai-engine.exe' : 'firefly-ai-engine/firefly-ai-engine'
    )
    if (bin && fs.existsSync(bin)) {
      return bin
    }

    // 多候选路径兜底检索
    const candidates = [
      path.join(root, 'apps', 'desktop', 'build', 'extraResources', 'bin', 'firefly-ai-engine', exeName),
      path.join(root, 'build', 'extraResources', 'bin', 'firefly-ai-engine', exeName)
    ]
    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        return cand
      }
    }

    return null
  }

  /**
   * 获取引擎二进制部署信息，供监控面板展示与降级提示
   */
  public getExeInfo(): { available: boolean; path: string | null; devMode: boolean } {
    const exePath = this.resolveEngineExecutable()
    const devMode = !app?.isPackaged || process.env.NODE_ENV !== 'production'
    return { available: exePath !== null, path: exePath, devMode }
  }

  /**
   * 探活：向 /api/engine/status 发起一次状态查询
   * 每次失败都将计入熔断器（Tier 2 静默熔断）
   */
  public async healthCheck(): Promise<Tier2EngineStatus | null> {
    try {
      const res = await fetch(`${this.baseUrl}${ENGINE_STATUS_PATH}`, {
        method: 'GET',
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS)
      })
      if (!res.ok) {
        this.circuitBreaker.recordFailure()
        return null
      }
      const data = (await res.json()) as Tier2EngineStatus
      this.circuitBreaker.recordSuccess()
      if (typeof data.version === 'string' && data.version) {
        this.versionCache = data.version
      }
      this.lastRawStatus = data
      return data
    } catch (err) {
      this.circuitBreaker.recordFailure()
      return null
    }
  }

  /**
   * 获取引擎当前状态（快速路径，不做探活网络请求）
   */
  public getEngineStatus(): Tier2EngineStatus | null {
    return this.lastRawStatus
  }

  /**
   * 确保引擎在线：在线则直接复用；离线则尝试静默拉起（受熔断器保护）
   */
  public async ensureRunning(): Promise<boolean> {
    if (this.circuitBreaker.getState() === 'open') {
      logger.warn(
        LogCategory.SYSTEM,
        '[EngineBridge] Tier 2 引擎处于熔断冷却期，跳过静默拉起（分析将降级到 Tier 1）'
      )
      return false
    }

    // 先探活复用（熔断器允许时）
    if (this.circuitBreaker.canExecute()) {
      const status = await this.healthCheck()
      if (status) {
        logger.info(LogCategory.SYSTEM, `[EngineBridge] 复用已运行的 Tier 2 引擎 (${this.baseUrl})`)
        this.broadcastStatus()
        return true
      }
    }

    return this.start()
  }

  /**
   * 启动并守护 firefly-ai-engine 子进程（支持并发 Promise 合并）
   */
  public async start(): Promise<boolean> {
    if (this.process && !this.process.killed) {
      const status = await this.healthCheck()
      if (status) {
        return true
      }
    }

    if (this.startPromise) {
      return this.startPromise
    }
    this.startPromise = this.doStart()
    try {
      return await this.startPromise
    } finally {
      this.startPromise = null
    }
  }

  private async doStart(): Promise<boolean> {
    this.isStarting = true
    const exePath = this.resolveEngineExecutable()
    if (!exePath) {
      const msg = '未找到 firefly-ai-engine 可执行二进制，跳过子进程托管（Tier 1 全程保底）'
      logger.warn(LogCategory.SYSTEM, `[EngineBridge] ${msg}`)
      this.lastError = msg
      this.broadcastStatus()
      this.isStarting = false
      return false
    }

    try {
      // 拉起前再探活一次，仍存在则直接复用
      const alive = await this.healthCheck()
      if (alive) {
        this.isStarting = false
        this.broadcastStatus()
        return true
      }

      logger.info(LogCategory.SYSTEM, `[EngineBridge] 静默拉起 Tier 2 引擎: ${exePath}`)
      const env = {
        ...process.env,
        ENGINE_PORT: String(TIER2_ENGINE_PORT)
      }
      const child = spawn(exePath, ['--silent', '--tray'], {
        detached: true,
        stdio: 'ignore',
        env
      })
      this.process = child
      child.unref()

      child.once('error', err => {
        this.lastError = `引擎子进程异常: ${err.message}`
        logger.error(LogCategory.SYSTEM, '[EngineBridge] 引擎子进程异常:', err)
        this.broadcastStatus()
      })
      child.once('exit', (code, signal) => {
        logger.warn(
          LogCategory.SYSTEM,
          `[EngineBridge] 引擎子进程已退出 (code=${code}, signal=${signal})`
        )
        this.process = null
        this.lastRawStatus = null
        this.broadcastStatus()
      })

      // 等待引擎就绪（轮询 /api/engine/status）
      const ready = await this.waitForReady(READY_WAIT_LIMIT_MS)
      this.isStarting = false
      if (!ready) {
        const msg = 'Tier 2 引擎启动超时，未能在规定时间内完成就绪'
        this.lastError = msg
        logger.warn(LogCategory.SYSTEM, `[EngineBridge] ${msg}`)
      } else {
        this.lastError = null
      }
      this.broadcastStatus()
      return ready
    } catch (err) {
      this.isStarting = false
      const msg = err instanceof Error ? err.message : String(err)
      this.lastError = msg
      logger.error(LogCategory.SYSTEM, '[EngineBridge] 引擎启动失败:', err)
      this.broadcastStatus()
      return false
    }
  }

  private async waitForReady(limitMs: number): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < limitMs) {
      if (this.circuitBreaker.canExecute()) {
        const status = await this.healthCheck()
        if (status) {
          return true
        }
      }
      await new Promise(resolve => setTimeout(resolve, 1200))
    }
    return false
  }

  /**
   * 打开引擎管理面板
   */
  public async openUI(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}${ENGINE_OPEN_UI_PATH}`, {
        method: 'POST',
        signal: AbortSignal.timeout(OPEN_UI_TIMEOUT_MS)
      })
      return { ok: res.ok, error: res.ok ? undefined : `引擎返回 ${res.status}` }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      logger.warn(LogCategory.SYSTEM, `[EngineBridge] 打开引擎管理面板失败: ${error}`)
      return { ok: false, error }
    }
  }

  /**
   * 请求引擎优雅退出（不影响引擎管理面板自启），随后清理自己拉起的进程
   */
  public async shutdown(): Promise<{ ok: boolean }> {
    try {
      await fetch(`${this.baseUrl}${ENGINE_SHUTDOWN_PATH}`, {
        method: 'POST',
        signal: AbortSignal.timeout(SHUTDOWN_TIMEOUT_MS)
      })
    } catch (err) {
      // 引擎可能已下线或未运行，属可容忍降级；仍记 debug 便于排查优雅退出是否真正送达
      logger.debug(LogCategory.SYSTEM, '[EngineBridge] shutdown 请求未送达（引擎可能未运行）:', err)
    }
    this.killOwnProcess()
    return { ok: true }
  }

  /**
   * 强制清理由本服务拉起的子进程（taskkill 兜底，Unix 走 SIGKILL）
   */
  private killOwnProcess(): void {
    const proc = this.process
    this.process = null
    if (!proc || proc.killed) {
      return
    }
    try {
      if (process.platform === 'win32' && proc.pid) {
        execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore' })
      } else {
        proc.kill('SIGKILL')
      }
    } catch (err) {
      // kill 失败常见于进程已自行退出；仍记日志以便发现残留进程
      logger.debug(LogCategory.SYSTEM, '[EngineBridge] 回收自拉起引擎进程失败（可能已退出）:', err)
    }
  }

  /**
   * 启动周期性状态轮询（设置页打开后生效）
   */
  public startPolling(intervalMs: number = POLL_INTERVAL_MS): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
    }
    this.pollTimer = setInterval(async () => {
      if (this.circuitBreaker.canExecute()) {
        await this.healthCheck()
      }
      this.broadcastStatus()
    }, intervalMs)
    this.pollTimer.unref?.()
  }

  /**
   * 停止周期性状态轮询
   */
  public stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  /**
   * 订阅桥接状态变化
   * @returns 取消订阅函数
   */
  public subscribe(fn: (snapshot: EngineBridgeSnapshot) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /**
   * 组装对外状态快照
   */
  public getSnapshot(): EngineBridgeSnapshot {
    const raw = this.lastRawStatus
    return {
      connected: !!raw,
      circuitState: this.circuitBreaker.getState(),
      available: this.resolveEngineExecutable() !== null,
      exePath: this.resolveEngineExecutable(),
      devMode: !app?.isPackaged || process.env.NODE_ENV !== 'production',
      port: TIER2_ENGINE_PORT,
      version: raw?.version || this.versionCache || null,
      backend: raw?.active_backend || raw?.backend || null,
      model: raw?.model || (raw?.loaded_models && raw.loaded_models.length > 0 ? raw.loaded_models[0] : null) || null,
      vramMb: typeof raw?.vram_mb === 'number' ? raw.vram_mb : typeof raw?.gpu_mem_mb === 'number' ? raw.gpu_mem_mb : null,
      lastError: this.lastError,
      updatedAt: raw ? Date.now() : null,
      raw
    }
  }

  /**
   * 广播状态快照给本进程监听者与所有渲染窗口（tier2:status-changed）
   */
  public broadcastStatus(): void {
    const snapshot = this.getSnapshot()
    this.listeners.forEach(fn => {
      try {
        fn(snapshot)
      } catch (err) {
        // 单个订阅者抛错不得中断其余广播；记日志暴露订阅方缺陷
        logger.warn(LogCategory.SYSTEM, '[EngineBridge] 状态订阅者回调异常:', err)
      }
    })
    if (typeof BrowserWindow !== 'undefined') {
      try {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.send('tier2:status-changed', snapshot)
          }
        }
      } catch (err) {
        logger.warn(LogCategory.SYSTEM, '[EngineBridge] 向渲染窗口广播状态失败:', err)
      }
    }
  }

  /**
   * 停止服务：停轮询、清理子进程、复位熔断器
   */
  public stop(): void {
    this.stopPolling()
    this.killOwnProcess()
    this.lastRawStatus = null
    this.circuitBreaker.reset()
  }
}

/** 全局单例 */
export const engineBridgeService = EngineBridgeService.getInstance()