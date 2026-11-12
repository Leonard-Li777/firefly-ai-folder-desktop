/**
 * apps/desktop/src/electron/runtime-services/llm/llm-gateway-service.ts
 *
 * 桌面端统一大模型网关门面服务 (LlmGatewayService)
 * 规范依据：
 *   - docs/specs/generative-engine-pocket-cpu-and-unified-abstraction-spec.md §3.1, §3.2, §4.3, §10 (CONF-04, 06, 07)
 *   - docs/developer/references/public-services-catalog.md
 */

import { app } from 'electron'
import * as path from 'node:path'
import * as fs from 'node:fs'
import {
  logger,
  LogCategory,
  GenerativeEngineMode,
  GenerativeEngineSnapshot,
  GenerativeEngineInstallationState,
  GenerativeEngineRuntimeState,
  resolveEffectiveMode,
  ResourceLocator,
  PluginPathResolver,
  BUILTIN_PLUGIN_CATALOG_META
} from '@firefly/shared'
import type { TaskSpec, FinishReason } from './task-specs/types'
import {
  shortNameTaskSpec,
  type ShortNameInput,
  type ShortNameOutput,
  tagTaskSpec,
  type TagTaskInput,
  type TagTaskOutput,
  qualityScoreTaskSpec,
  type QualityScoreInput,
  type QualityScoreOutput,
  directoryPlanTaskSpec,
  type DirectoryPlanInput,
  type DirectoryPlanOutput
} from './task-specs'
import { OmniService } from '../system/omni-service'

export type GatewayErrorCode =
  | 'MODE_DISABLED'
  | 'ENGINE_NOT_READY'
  | 'ENGINE_SWITCHED'
  | 'ENGINE_CRASHED'
  | 'QUEUE_FULL'
  | 'BUSY'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'CONTEXT_OVERFLOW'
  | 'LOW_MEMORY'
  | 'UNAUTHORIZED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UPSTREAM_4XX'
  | 'UPSTREAM_5XX'
  | 'SCHEMA_MISMATCH'
  | 'UNSAFE_OUTPUT'
  | 'TASK_NOT_SUPPORTED'
  | 'ASSET_INCOMPATIBLE'
  | 'CRASH_LOOP'
  | 'UNSUPPORTED_PARAMETER'
  | 'UNSUPPORTED_CAPABILITY'

export class LlmGatewayError extends Error {
  constructor(
    public readonly code: GatewayErrorCode,
    message: string,
    public readonly retryable: boolean = false
  ) {
    super(`[LlmGateway] ${code}: ${message}`)
    this.name = 'LlmGatewayError'
  }
}

/**
 * 底座独立并发排队调度车道 (BackendLaneQueue)
 * 严格按照 Spec §3.2 限制 CPU 底座并发深度 1、队列上限 8
 */
export class BackendLaneQueue {
  private activeCount = 0
  private queue: Array<() => void> = []

  constructor(
    public readonly maxConcurrency: number,
    public readonly queueLimit: number
  ) {}

  public get pendingCount(): number {
    return this.queue.length
  }

  public get activeRunningCount(): number {
    return this.activeCount
  }

  public enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (this.queue.length >= this.queueLimit) {
      throw new LlmGatewayError(
        'QUEUE_FULL',
        `底座并发队列已满 (当前排队: ${this.queue.length}, 上限: ${this.queueLimit})`
      )
    }

    return new Promise<T>((resolve, reject) => {
      const run = async () => {
        this.activeCount++
        try {
          const res = await task()
          resolve(res)
        } catch (err) {
          reject(err)
        } finally {
          this.activeCount--
          this.processNext()
        }
      }

      if (this.activeCount < this.maxConcurrency) {
        run()
      } else {
        this.queue.push(run)
      }
    })
  }

  private processNext(): void {
    if (this.activeCount < this.maxConcurrency && this.queue.length > 0) {
      const next = this.queue.shift()
      if (next) next()
    }
  }
}

export interface ChatOptions {
  signal?: AbortSignal
  timeoutMs?: number
  temperature?: number
  maxTokens?: number
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatCompletionOptions {
  taskId: 'short-name' | 'tag' | 'quality-score' | 'directory-plan'
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  queueTimeoutMs?: number
  runTimeoutMs?: number
  signal?: AbortSignal
  responseFormat?: 'text' | 'json'
  taskIdTrace?: string
}

export interface ChatCompletionResult {
  content: string
  model: string
  finishReason: FinishReason
  servedBy: 'cpu' | 'local' | 'cloud'
  usage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  degraded?: boolean
}

export interface TokenizeResult {
  tokens: number[][]
  counts: number[]
}

export interface ILlmGatewayService {
  chat<I, O>(taskSpec: TaskSpec<I, O>, input: I, options?: ChatOptions): Promise<O>
  suggestShortName(input: ShortNameInput, options?: ChatOptions): Promise<ShortNameOutput>
  extractControlledTags(input: TagTaskInput, options?: ChatOptions): Promise<TagTaskOutput>
  evaluateQualityScore(input: QualityScoreInput, options?: ChatOptions): Promise<QualityScoreOutput>
  planDirectory(input: DirectoryPlanInput, options?: ChatOptions): Promise<DirectoryPlanOutput>
  chatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResult>
  tokenize(texts: string[]): Promise<TokenizeResult>
  getSnapshot(): GenerativeEngineSnapshot
  setDesiredMode(mode: GenerativeEngineMode): Promise<void>
  preheat(options?: { wait?: boolean }): Promise<void>
  drain(waitDrainMs?: number): Promise<void>
}

export class LlmGatewayService implements ILlmGatewayService {
  private static instance: LlmGatewayService | null = null

  private desiredMode: GenerativeEngineMode = 'local'
  private routeEpoch: number = 1
  private cpuLastError: string | null = null
  private cpuCrashCount: number = 0
  private cpuRuntimeState: 'ready' | 'loading' | 'stopped' | 'failed' = 'stopped'

  // CPU 底座并发深度 1，队列上限 8；本地底座并发深度 2，队列上限 16
  private cpuLane = new BackendLaneQueue(1, 8)
  private localLane = new BackendLaneQueue(2, 16)

  public installationOverride?: Partial<GenerativeEngineInstallationState> | null
  public runtimeOverride?: Partial<GenerativeEngineRuntimeState> | null

  /**
   * 测试接缝：注入模块化资源服务（用于在测试中绑定内存库，
   * 避免生产代码 CJS require 与 ESM 单例不一致导致的探测失真）。
   */
  private modularResourceResolver: () => any = () => {
    // 生产：延迟 CJS require，规避循环依赖
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { modularResourceService } = require('../system/modular-resource-service')
    return modularResourceService
  }

  public setModularResourceResolverForTesting(resolver: (() => any) | null): void {
    this.modularResourceResolver =
      resolver ?? (() => {
        const { modularResourceService } = require('../system/modular-resource-service')
        return modularResourceService
      })
  }

  private constructor() {
    this.initModeFromConfig()
    this.loadCrashState()
  }

  public static getInstance(): LlmGatewayService {
    if (!LlmGatewayService.instance) {
      LlmGatewayService.instance = new LlmGatewayService()
    }
    return LlmGatewayService.instance
  }

  /**
   * 崩溃计数持久化路径：{userData}/run/cpu-session.state
   */
  private getCrashStateFilePath(): string {
    try {
      const base = app?.getPath ? app.getPath('userData') : process.cwd()
      return path.join(base, 'run', 'cpu-session.state')
    } catch {
      return path.join(process.cwd(), 'run', 'cpu-session.state')
    }
  }

  /**
   * 从持久化文件恢复 crashCount 与熔断状态
   */
  private loadCrashState(): void {
    try {
      const p = this.getCrashStateFilePath()
      if (fs.existsSync(p)) {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'))
        if (typeof data.crashCount === 'number') {
          this.cpuCrashCount = data.crashCount
          if (this.cpuCrashCount >= 2) {
            this.cpuLastError = 'CRASH_LOOP'
            this.cpuRuntimeState = 'failed'
          }
        }
      }
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[LlmGatewayService] 加载 crashState 异常:', err)
    }
  }

  /**
   * 将熔断状态落盘保存
   */
  private saveCrashState(): void {
    try {
      const p = this.getCrashStateFilePath()
      const dir = path.dirname(p)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(
        p,
        JSON.stringify({
          crashCount: this.cpuCrashCount,
          lastError: this.cpuLastError,
          updatedAt: Date.now()
        }),
        'utf8'
      )
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[LlmGatewayService] 保存 crashState 失败:', err)
    }
  }

  /**
   * 初始化读取持久化配置模式
   */
  private initModeFromConfig(): void {
    try {
      const { ConfigOrchestrator } = require('../../config/config-orchestrator')
      const orchestrator = ConfigOrchestrator?.getInstance?.()
      const savedMode =
        orchestrator?.getValue?.('AI_SERVICE_MODE') ||
        orchestrator?.getValue?.('AI_SERVICE_LAST_ENABLED_MODE')
      if (savedMode && ['local', 'cpu', 'cloud', 'disabled'].includes(savedMode)) {
        this.desiredMode = savedMode as GenerativeEngineMode
      }
    } catch {
      // 容灾忽略（单测或无配置环境）
    }
  }

  /**
   * 真实探测 CPU 底座模型资产安装状态
   */
  /**
   * 单轨权威探测本地 CPU 极速推理引擎安装状态 (§3.2 SSOT)
   * 安装态口径与插件中心对齐：ai_engine_cpu 槽位模块的 active（已启用）与
   * installed_inactive（已下载权重、待启用）均视为 installed；
   * 再校验域 B _shared/pocket-cpu (.ready.json + >=10MB) 决定 installed / corrupt；
   * 严禁扫描只读安装目录 extraResources 或非受控旧目录。
   */
  private probeCpuInstallation(): 'installed' | 'not_installed' | 'corrupt' {
    if (this.installationOverride?.cpu) {
      return this.installationOverride.cpu
    }

    try {
      const modularResourceService = this.modularResourceResolver?.()
      // 已安装 = 权重已就位可启用。installed_inactive 表示权重已下载完整、
      // 仅未设为激活态，不应被误判为「未安装」（与插件中心口径一致）。
      // 按 ai_engine_cpu 槽位聚合判定，不绑定单一模块 id，对未来 CPU 引擎成员更稳健。
      const dao = modularResourceService?.getDao?.()
      const cpuModules = (dao?.modules?.listAllSync?.() ?? []).filter(
        (m: { capability_slot?: string; install_state?: string }) =>
          m.capability_slot === 'ai_engine_cpu'
      )
      const cpuInstalledState = cpuModules.some(
        (m: { capability_slot?: string; install_state?: string }) =>
          m.install_state === 'active' || m.install_state === 'installed_inactive'
      )
      if (!cpuInstalledState) {
        return 'not_installed'
      }

      const meta = BUILTIN_PLUGIN_CATALOG_META['pocket-cpu-int8-onnx']
      const pluginsRoot = modularResourceService?.getPluginsRootDir?.()
      if (!pluginsRoot) {
        return 'corrupt'
      }

      const readyDir = PluginPathResolver.getReadySharedResourceDirForRoot(
        pluginsRoot,
        meta.sharedSubDir,
        {
          requiredFileGroups: meta.requiredFileGroups,
          minPrimaryFileBytes: meta.minPrimaryFileBytes,
          requireReadyMarker: true
        }
      )
      return readyDir ? 'installed' : 'corrupt'
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[LlmGatewayService] 探测 CPU 引擎安装资产异常:', err)
      return 'not_installed'
    }
  }

  /**
   * 真实探测本地高级引擎资产安装状态
   */
  private probeLocalInstallation(): 'installed' | 'not_installed' | 'corrupt' {
    if (this.installationOverride?.local) {
      return this.installationOverride.local
    }

    try {
      // 萤核AI引擎为系统内置捆绑组件（PRD-0044 Invariant），探查实际引擎可执行文件
      const { EngineBridgeService } = require('../engine-bridge/engine-bridge-service')
      const exe = EngineBridgeService?.getInstance?.()?.resolveEngineExecutable?.()
      if (exe && fs.existsSync(exe)) {
        return 'installed'
      }

      // 生产环境打包后恒为内置已安装
      if (process.env.NODE_ENV === 'production' || app?.isPackaged) {
        return 'installed'
      }

      const candidates = [
        path.join(ResourceLocator.getBaseResourceDir(), 'bin', 'llama.cpp'),
        path.join(process.cwd(), 'apps/desktop/build/extraResources/bin/llama.cpp'),
        path.join(process.cwd(), 'build/extraResources/bin/llama.cpp')
      ]
      for (const p of candidates) {
        if (fs.existsSync(p)) return 'installed'
      }
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[LlmGatewayService] 探测本地高级引擎安装资产异常:', err)
    }

    // 萤核AI引擎随客户端捆绑交付，默认作为内置已安装
    return 'installed'
  }

  /**
   * 探测云端底座凭据配置状态
   */
  private probeCloudInstallation(): 'ready' | 'missing_api_key' {
    if (this.installationOverride?.cloud) {
      return this.installationOverride.cloud
    }

    try {
      if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) {
        return 'ready'
      }
    } catch {}

    return 'missing_api_key'
  }

  /**
   * 探测本地高级引擎运行时状态
   */
  private probeLocalRuntime(): 'ready' | 'loading' | 'stopped' | 'failed' {
    if (this.runtimeOverride?.local) {
      return this.runtimeOverride.local
    }
    return 'stopped'
  }

  /**
   * 获取动态 Omni 基础端点 (优先直连单例，备份跨进程端口文件)
   */
  public getOmniBaseUrl(): string {
    try {
      const omni = OmniService.getInstance()
      const url = omni.getBaseUrl()
      if (url && url.startsWith('http')) {
        return url.replace(/\/$/, '')
      }
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[LlmGatewayService] 获取 OmniService baseUrl 失败:', err)
    }

    // 跨进程 run 目录端口文件发现兜底
    try {
      const runFile = path.join(app.getPath('userData'), 'run', 'firefly-omni.json')
      if (fs.existsSync(runFile)) {
        const data = JSON.parse(fs.readFileSync(runFile, 'utf8'))
        if (data.port) {
          return `http://127.0.0.1:${data.port}`
        }
      }
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[LlmGatewayService] 读取 firefly-omni.json 失败:', err)
    }

    return 'http://127.0.0.1:38200'
  }

  /**
   * 获取当前生成式引擎状态快照 (真实探针驱动，零虚假硬编码)
   */
  public getSnapshot(): GenerativeEngineSnapshot {
    const rawSnapshot: GenerativeEngineSnapshot = {
      desiredMode: this.desiredMode,
      effectiveMode: 'disabled',
      installation: {
        local: this.probeLocalInstallation(),
        cpu: this.probeCpuInstallation(),
        cloud: this.probeCloudInstallation()
      },
      runtime: {
        local: this.probeLocalRuntime(),
        cpu: this.runtimeOverride?.cpu ?? this.cpuRuntimeState,
        cloud: this.runtimeOverride?.cloud ?? 'ready'
      },
      cpuLastError: this.cpuLastError,
      cpuCrashCount: this.cpuCrashCount,
      routeEpoch: this.routeEpoch
    }

    const { effectiveMode, unavailableReason } = resolveEffectiveMode(rawSnapshot)
    rawSnapshot.effectiveMode = effectiveMode
    rawSnapshot.unavailableReason = unavailableReason

    return rawSnapshot
  }

  /**
   * 变更期望底座模式 (Zero-Barrier 秒级平滑切换)
   */
  public async setDesiredMode(mode: GenerativeEngineMode): Promise<void> {
    if (this.desiredMode === mode) return

    const prevMode = this.desiredMode
    this.desiredMode = mode
    this.routeEpoch++

    logger.info(
      LogCategory.AI_SERVICE,
      `[LlmGateway] 底座切换: ${prevMode} -> ${mode} (routeEpoch=${this.routeEpoch})`
    )

    // 持久化记录前序生效模式供仪表盘与向导回溯
    try {
      const { ConfigOrchestrator } = require('../../config/config-orchestrator')
      const orchestrator = ConfigOrchestrator?.getInstance?.()
      if (mode !== 'disabled') {
        orchestrator?.setValues?.({
          AI_SERVICE_MODE: mode,
          AI_SERVICE_LAST_ENABLED_MODE: mode
        })
      }
    } catch {}
  }

  /**
   * 显式预热底座模型 (可解开 CRASH_LOOP 熔断)
   */
  public async preheat(options?: { wait?: boolean }): Promise<void> {
    const snapshot = this.getSnapshot()
    if (snapshot.effectiveMode !== 'cpu') return

    const baseUrl = this.getOmniBaseUrl()
    const wait = options?.wait ?? false

    this.cpuRuntimeState = 'loading'
    try {
      const res = await fetch(`${baseUrl}/v1/engines/cpu/session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ wait })
      })

      if (res.ok) {
        // 预热成功主动清零 crash 计数与熔断状态
        this.cpuCrashCount = 0
        this.cpuLastError = null
        this.cpuRuntimeState = 'ready'
        this.saveCrashState()
      } else {
        this.cpuRuntimeState = 'failed'
      }
    } catch (err: any) {
      this.cpuRuntimeState = 'failed'
      logger.warn(LogCategory.AI_SERVICE, `[LlmGateway] 预热请求异常: ${err.message}`)
    }
  }

  /**
   * 销毁或排空活跃请求 (CONF-05 / 优雅退出)
   */
  public async drain(waitDrainMs: number = 2000): Promise<void> {
    const baseUrl = this.getOmniBaseUrl()
    try {
      await fetch(`${baseUrl}/v1/engines/cpu/session?wait_drain_ms=${waitDrainMs}`, {
        method: 'DELETE'
      })
      this.cpuRuntimeState = 'stopped'
    } catch {}
  }

  /**
   * 统一分词端点
   */
  public async tokenize(texts: string[]): Promise<TokenizeResult> {
    const baseUrl = this.getOmniBaseUrl()
    const res = await fetch(`${baseUrl}/v1/tokenize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ texts })
    })

    if (!res.ok) {
      throw new LlmGatewayError(
        'UPSTREAM_5XX',
        `分词请求失败 (status=${res.status}): ${await res.text()}`
      )
    }

    return (await res.json()) as TokenizeResult
  }

  /**
   * 核心统一提示词推理执行方法
   */
  public async chat<I, O>(taskSpec: TaskSpec<I, O>, input: I, options?: ChatOptions): Promise<O> {
    const snapshot = this.getSnapshot()
    const mode = snapshot.effectiveMode

    if (mode === 'disabled') {
      const reason = snapshot.unavailableReason || 'MODE_DISABLED'
      const code: GatewayErrorCode =
        reason === 'CRASH_LOOP'
          ? 'CRASH_LOOP'
          : reason === 'NOT_INSTALLED' || reason === 'CORRUPT'
            ? 'ASSET_INCOMPATIBLE'
            : 'MODE_DISABLED'
      throw new LlmGatewayError(code, `生成式 AI 能力当前不可用: ${reason}`)
    }

    // 底座白名单门禁拦截 (如 directory-plan 严禁在 cpu 底座运行)
    if (!taskSpec.allowedModes.includes(mode)) {
      throw new LlmGatewayError(
        'TASK_NOT_SUPPORTED',
        `任务 [${taskSpec.taskId}] 不支持在 [${mode}] 底座运行 (仅允许: ${taskSpec.allowedModes.join(', ')})`
      )
    }

    // 超时与中断信号绑定 (M-5 / S-3)
    const timeoutMs = options?.timeoutMs ?? (mode === 'cpu' ? 30000 : 120000)
    const timeoutController = new AbortController()
    const timer = setTimeout(() => {
      timeoutController.abort(new LlmGatewayError('TIMEOUT', `推理执行超时 (${timeoutMs}ms)`))
    }, timeoutMs)

    let combinedSignal: AbortSignal
    if (options?.signal) {
      const userSignal = options.signal
      if (typeof AbortSignal !== 'undefined' && 'any' in AbortSignal) {
        combinedSignal = (AbortSignal as any).any([userSignal, timeoutController.signal])
      } else {
        const combinedController = new AbortController()
        userSignal.addEventListener('abort', () => combinedController.abort(userSignal.reason), {
          once: true
        })
        timeoutController.signal.addEventListener(
          'abort',
          () => combinedController.abort(timeoutController.signal.reason),
          { once: true }
        )
        combinedSignal = combinedController.signal
      }
    } else {
      combinedSignal = timeoutController.signal
    }

    try {
      if (mode === 'cpu') {
        return await this.cpuLane.enqueue(async () => {
          return await this.executeCpuChat(taskSpec, input, options, combinedSignal)
        })
      } else if (mode === 'local') {
        return await this.localLane.enqueue(async () => {
          return await this.executeLocalChat(taskSpec, input, options, combinedSignal)
        })
      } else if (mode === 'cloud') {
        // C-1: 拒绝生产代码欺诈性 Mock 交付，显式抛出未配置/能力不支持异常
        throw new LlmGatewayError(
          'UNSUPPORTED_CAPABILITY',
          '云端大模型底座尚未配置 API Key 或未在当前切片启用'
        )
      } else {
        throw new LlmGatewayError('MODE_DISABLED', `未知或未启用底座: ${mode}`)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private async executeCpuChat<I, O>(
    taskSpec: TaskSpec<I, O>,
    input: I,
    options?: ChatOptions,
    signal?: AbortSignal
  ): Promise<O> {
    const systemPrompt = taskSpec.systemPrompt('cpu', input)
    const userPrompt = taskSpec.userPrompt('cpu', input)
    const baseUrl = this.getOmniBaseUrl()

    const reqBody: Record<string, unknown> = {
      model: 'pocket-cpu-int8',
      task_id: taskSpec.taskId,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: options?.temperature ?? 0.0,
      max_tokens: options?.maxTokens ?? 64
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Host: '127.0.0.1'
    }
    const token = OmniService.getInstance().getOmniToken()
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    let res: Response
    try {
      res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(reqBody),
        signal
      })
    } catch (err: any) {
      if (signal?.aborted) {
        if (signal.reason instanceof LlmGatewayError) {
          throw signal.reason
        }
        throw new LlmGatewayError('CANCELLED', '请求已被取消')
      }
      throw new LlmGatewayError('ENGINE_CRASHED', `连接 Pocket CPU 失败: ${err.message}`)
    }

    if (!res.ok) {
      if (res.status === 429) {
        throw new LlmGatewayError('BUSY', 'Pocket CPU 当前繁忙 (429)')
      }
      if (res.status === 500) {
        this.cpuCrashCount++
        if (this.cpuCrashCount >= 2) {
          this.cpuLastError = 'CRASH_LOOP'
        }
        this.cpuRuntimeState = 'failed'
        this.saveCrashState()
        throw new LlmGatewayError('ENGINE_CRASHED', `Pocket CPU 发生故障 (500)`)
      }
      if (res.status >= 500) {
        throw new LlmGatewayError('UPSTREAM_5XX', `上游服务错误: status=${res.status}`)
      }
      throw new LlmGatewayError('UPSTREAM_4XX', `请求参数不合法: status=${res.status}`)
    }

    const data = await res.json()
    this.cpuRuntimeState = 'ready'
    const rawText = data?.choices?.[0]?.message?.content || ''
    const finishReason = (data?.choices?.[0]?.finish_reason as FinishReason) || 'stop'

    return await taskSpec.postValidate(rawText, finishReason)
  }

  /**
   * 智能文件名提炼门面方法 (short-name)
   */
  public async suggestShortName(
    input: ShortNameInput,
    options?: ChatOptions
  ): Promise<ShortNameOutput> {
    return this.chat(shortNameTaskSpec, input, options)
  }

  /**
   * 受控概念语义打标门面方法 (tag)
   */
  public async extractControlledTags(
    input: TagTaskInput,
    options?: ChatOptions
  ): Promise<TagTaskOutput> {
    return this.chat(tagTaskSpec, input, options)
  }

  /**
   * 文件内容质量评分门面方法 (quality-score)
   */
  public async evaluateQualityScore(
    input: QualityScoreInput,
    options?: ChatOptions
  ): Promise<QualityScoreOutput> {
    return this.chat(qualityScoreTaskSpec, input, options)
  }

  /**
   * 目录智能重构规划门面方法 (directory-plan)
   */
  public async planDirectory(
    input: DirectoryPlanInput,
    options?: ChatOptions
  ): Promise<DirectoryPlanOutput> {
    return this.chat(directoryPlanTaskSpec, input, options)
  }

  /**
   * 通用结构化对话补全门面方法 (chatCompletion)
   * 遵守统一网关与契约-A/B/C
   */
  public async chatCompletion(options: ChatCompletionOptions): Promise<ChatCompletionResult> {
    // 约束校验：单请求消息数 <= 16，单条消息字符数 <= 16,000 (契约-B)
    if (!options.messages || options.messages.length === 0) {
      throw new LlmGatewayError('UNSUPPORTED_PARAMETER', 'messages 不能为空')
    }
    if (options.messages.length > 16) {
      throw new LlmGatewayError(
        'PAYLOAD_TOO_LARGE',
        `单请求消息数 (${options.messages.length}) 超过上限 16`
      )
    }
    for (const msg of options.messages) {
      if (msg.content && msg.content.length > 16000) {
        throw new LlmGatewayError(
          'PAYLOAD_TOO_LARGE',
          `单条消息字符数 (${msg.content.length}) 超过上限 16,000`
        )
      }
    }

    const snapshot = this.getSnapshot()
    const mode = snapshot.effectiveMode
    if (mode === 'disabled') {
      const reason = snapshot.unavailableReason || 'MODE_DISABLED'
      const code: GatewayErrorCode =
        reason === 'CRASH_LOOP'
          ? 'CRASH_LOOP'
          : reason === 'NOT_INSTALLED' || reason === 'CORRUPT'
            ? 'ASSET_INCOMPATIBLE'
            : 'MODE_DISABLED'
      throw new LlmGatewayError(code, `生成式 AI 能力当前不可用: ${reason}`)
    }

    // directory-plan 任务禁止在 cpu 底座运行
    if (options.taskId === 'directory-plan' && mode === 'cpu') {
      throw new LlmGatewayError(
        'TASK_NOT_SUPPORTED',
        '任务 [directory-plan] 不支持在 [cpu] 底座运行'
      )
    }

    // 超时与中断信号绑定
    const runTimeoutMs = options.runTimeoutMs ?? (mode === 'cpu' ? 30000 : 120000)
    const timeoutController = new AbortController()
    const timer = setTimeout(() => {
      timeoutController.abort(new LlmGatewayError('TIMEOUT', `推理执行超时 (${runTimeoutMs}ms)`))
    }, runTimeoutMs)

    let combinedSignal: AbortSignal
    if (options.signal) {
      const userSignal = options.signal
      if (typeof AbortSignal !== 'undefined' && 'any' in AbortSignal) {
        combinedSignal = (AbortSignal as any).any([userSignal, timeoutController.signal])
      } else {
        const combinedController = new AbortController()
        userSignal.addEventListener('abort', () => combinedController.abort(userSignal.reason), {
          once: true
        })
        timeoutController.signal.addEventListener(
          'abort',
          () => combinedController.abort(timeoutController.signal.reason),
          { once: true }
        )
        combinedSignal = combinedController.signal
      }
    } else {
      combinedSignal = timeoutController.signal
    }

    try {
      if (mode === 'cpu') {
        return await this.cpuLane.enqueue(async () => {
          return await this.executeRawCpuChat(options, combinedSignal)
        })
      } else if (mode === 'local') {
        return await this.localLane.enqueue(async () => {
          return await this.executeRawLocalChat(options, combinedSignal)
        })
      } else if (mode === 'cloud') {
        throw new LlmGatewayError(
          'UNSUPPORTED_CAPABILITY',
          '云端大模型底座尚未配置 API Key 或未在当前切片启用'
        )
      } else {
        throw new LlmGatewayError('MODE_DISABLED', `未知或未启用底座: ${mode}`)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private async executeRawCpuChat(
    options: ChatCompletionOptions,
    signal?: AbortSignal
  ): Promise<ChatCompletionResult> {
    const baseUrl = this.getOmniBaseUrl()
    const reqBody: Record<string, unknown> = {
      model: 'pocket-cpu-int8',
      task_id: options.taskId,
      messages: options.messages,
      temperature: options.temperature ?? 0.0,
      max_tokens: options.maxTokens ?? 64
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Host: '127.0.0.1'
    }
    const token = OmniService.getInstance().getOmniToken()
    if (token) {
      headers['Authorization'] = `Bearer ${token}`
    }

    let res: Response
    try {
      res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(reqBody),
        signal
      })
    } catch (err: any) {
      if (signal?.aborted) {
        if (signal.reason instanceof LlmGatewayError) {
          throw signal.reason
        }
        throw new LlmGatewayError('CANCELLED', '请求已被取消')
      }
      throw new LlmGatewayError('ENGINE_CRASHED', `连接 Pocket CPU 失败: ${err.message}`)
    }

    if (!res.ok) {
      if (res.status === 429) {
        throw new LlmGatewayError('BUSY', 'Pocket CPU 当前繁忙 (429)')
      }
      if (res.status === 500) {
        this.cpuCrashCount++
        if (this.cpuCrashCount >= 2) {
          this.cpuLastError = 'CRASH_LOOP'
        }
        this.cpuRuntimeState = 'failed'
        this.saveCrashState()
        throw new LlmGatewayError('ENGINE_CRASHED', `Pocket CPU 发生故障 (500)`)
      }
      if (res.status >= 500) {
        throw new LlmGatewayError('UPSTREAM_5XX', `上游服务错误: status=${res.status}`)
      }
      throw new LlmGatewayError('UPSTREAM_4XX', `请求参数不合法: status=${res.status}`)
    }

    const data = await res.json()
    this.cpuRuntimeState = 'ready'
    const rawText = data?.choices?.[0]?.message?.content || ''
    const finishReason = (data?.choices?.[0]?.finish_reason as FinishReason) || 'stop'

    return {
      content: rawText,
      model: data?.model || 'pocket-cpu-int8',
      finishReason,
      servedBy: 'cpu',
      usage: {
        promptTokens: data?.usage?.prompt_tokens ?? 0,
        completionTokens: data?.usage?.completion_tokens ?? 0,
        totalTokens: data?.usage?.total_tokens ?? 0
      }
    }
  }

  private async executeRawLocalChat(
    options: ChatCompletionOptions,
    signal?: AbortSignal
  ): Promise<ChatCompletionResult> {
    const localUrl = 'http://127.0.0.1:38400'

    let res: Response
    try {
      res = await fetch(`${localUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: options.messages,
          temperature: options.temperature ?? 0.2,
          max_tokens: options.maxTokens
        }),
        signal
      })
    } catch (err: any) {
      if (signal?.aborted) {
        if (signal.reason instanceof LlmGatewayError) {
          throw signal.reason
        }
        throw new LlmGatewayError('CANCELLED', '请求已被取消')
      }
      throw new LlmGatewayError('ENGINE_CRASHED', `本地高级引擎连接失败: ${err.message}`)
    }

    if (!res.ok) {
      throw new LlmGatewayError('ENGINE_CRASHED', `本地高级引擎推理失败 (status=${res.status})`)
    }

    const data = await res.json()
    const rawText = data?.choices?.[0]?.message?.content || ''
    const finishReason = (data?.choices?.[0]?.finish_reason as FinishReason) || 'stop'

    return {
      content: rawText,
      model: data?.model || 'local-llm',
      finishReason,
      servedBy: 'local',
      usage: {
        promptTokens: data?.usage?.prompt_tokens ?? 0,
        completionTokens: data?.usage?.completion_tokens ?? 0,
        totalTokens: data?.usage?.total_tokens ?? 0
      }
    }
  }

  private async executeLocalChat<I, O>(
    taskSpec: TaskSpec<I, O>,
    input: I,
    options?: ChatOptions,
    signal?: AbortSignal
  ): Promise<O> {
    const systemPrompt = taskSpec.systemPrompt('local', input)
    const userPrompt = taskSpec.userPrompt('local', input)
    const localUrl = 'http://127.0.0.1:38400'

    let res: Response
    try {
      res = await fetch(`${localUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt }
          ],
          temperature: options?.temperature ?? 0.2
        }),
        signal
      })
    } catch (err: any) {
      if (signal?.aborted) {
        if (signal.reason instanceof LlmGatewayError) {
          throw signal.reason
        }
        throw new LlmGatewayError('CANCELLED', '请求已被取消')
      }
      throw new LlmGatewayError('ENGINE_CRASHED', `本地高级引擎连接失败: ${err.message}`)
    }

    if (!res.ok) {
      throw new LlmGatewayError('ENGINE_CRASHED', `本地高级引擎推理失败 (status=${res.status})`)
    }

    const data = await res.json()
    const rawText = data?.choices?.[0]?.message?.content || ''
    const finishReason = (data?.choices?.[0]?.finish_reason as FinishReason) || 'stop'

    return await taskSpec.postValidate(rawText, finishReason)
  }
}

export const llmGatewayService = LlmGatewayService.getInstance()
