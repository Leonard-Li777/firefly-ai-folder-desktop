/**
 * Engine Bridge Service - 桌面端与 Tier 2 上层 AI 引擎的桥接服务
 * （class 主体按职责职责块原样搬移；types/constants 已抽至同目录子文件）
 */
import { ChildProcess, spawn, execSync } from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'
import * as os from 'node:os'
import { app, BrowserWindow } from 'electron'
import { subscribePowerEvent } from '../../../main/power-hub'
import {
  ResourceLocator,
  logger,
  LogCategory,
  APP_PORTS,
  ServiceDiscoveryFile,
  type ServiceDiscoveryFileV1,
  SSE_CONNECT_TIMEOUT_MS,
  SSE_READ_WATCHDOG_MS,
  DORMANT_MAX_ATTEMPTS,
  SseWatchdogTimeoutError,
  type ConnectedTargetIdentity,
  readWithWatchdog,
  sleepCancellable,
  isPathEqual,
  isTestEnvironment
} from '@firefly/shared'
import { Tier2CircuitBreaker, Tier2CircuitState } from '../tier2-circuit-breaker'
import { CRASH_HEAL_MAX_ATTEMPTS, decideCrashHeal } from '../crash-heal-policy'
import { isServiceUsableStatus, shouldTriggerServiceStartAt } from '../service-start-policy'
import {
  createAbortError,
  DEFAULT_ENSURE_MODE_TIMEOUT_MS,
  matchesEngineTargetMode,
  SHARED_STARTUP_HARD_TIMEOUT_MS,
  waitForEngineStatusReactive,
  type EngineTargetMode,
  type EnsureReadyOptions,
  type EnsureReadyResult
} from '../engine-readiness-barrier'
import {
  EngineCapability,
  EngineMetricsSnapshot,
  type EngineReadinessStatus,
  engineSwappingCoordinator,
  normalizeEngineMetricsPayload,
  parseRetryAfter,
  registerEngineReadinessChecker
} from '../engine-swapping-coordinator'
import { EngineLifecycleStateMachine } from '../engine-lifecycle-state-machine'
import { EngineModelCatalogResolver } from '../engine-model-catalog-resolver'
import { isLocalDevRuntime } from '../../../main/worktree-env'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'
import {
  OmniModuleDrainResult,
  OmniModuleLoadResult,
  OmniModuleStatusResult,
  ProcessTreeIdentity
} from '../../hibernation/types'
import { classifyOmniModuleLoadHttpResponse } from '../../hibernation/target-adapter'
import { moduleHibernationCoordinator } from '../../hibernation/module-hibernation-coordinator'
import { omniService } from '../../system/omni-service'
import { processTreeManager, ProcessTreeManager } from '../process-tree-manager'
import {
  TIER2_ENGINE_PORT,
  ENGINE_STATUS_PATH,
  ENGINE_OPEN_UI_PATH,
  ENGINE_SHUTDOWN_PATH,
  ENGINE_MODELS_PATH,
  ENGINE_MODEL_META_PATH,
  ENGINE_LIST_PATH,
  ENGINE_SERVICE_START_PATH,
  ENGINE_SERVICE_STOP_PATH,
  ENGINE_SWITCH_PATH,
  ENGINE_THINKING_PATH,
  ENGINE_METRICS_PATH,
  STATUS_TIMEOUT_MS,
  OPEN_UI_TIMEOUT_MS,
  SHUTDOWN_TIMEOUT_MS,
  MODELS_TIMEOUT_MS,
  MODELS_REFRESH_TTL_MS,
  MODELS_RETRY_MS,
  SERVICE_ACTION_TIMEOUT_MS,
  PORT_SCAN_RANGE,
  PORT_PROBE_TIMEOUT_MS,
  PORT_RELEASE_WAIT_MS,
  READY_WAIT_LIMIT_MS,
  STABLE_RUN_RESET_MS,
  OFFLINE_CONFIRM_FAILURES,
  ENGINE_BIN_DIR_NAME,
  DEV_BINARY_WATCH_INTERVAL_MS
} from './constants'
import type { Tier2EngineStatus, EngineBridgeSnapshot, EngineBridgeServiceOptions } from './types'

/** 有界指数退避基础延迟序列（1s, 2s, 4s, 8s, 16s；附加 0~500ms 随机微抖动） */
const STREAM_RECONNECT_BACKOFFS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const
/** 受管子进程 stdout 行缓冲上限，防止异常长输出引发内存堆积 */
const STDOUT_BUFFER_MAX_BYTES = 64 * 1024
/** 受管子进程优雅退出等待上限（超时后强杀） */
const STOP_CHILD_EXIT_WAIT_MS = 1_500
/** stdout 快路径前缀（与 firefly-ai-engine server/mod.rs READY_STDOUT_PREFIX 严格对齐） */
const FIREFLY_READY_PREFIX = 'FIREFLY_READY:'

export class EngineBridgeService {
  private static instance: EngineBridgeService
  private lifecycle = new EngineLifecycleStateMachine()
  private process: ChildProcess | null = null
  /** 当前实际通信端口（初始为基准端口；引擎滑动时经探测采纳实际端口） */
  private activePort: number = TIER2_ENGINE_PORT
  private isStarting = false
  private startPromise: Promise<boolean> | null = null
  /**
   * 推理服务启动请求的在途表（key = `mode|modelId`）。
   *
   * 同一意图的并发调用共享同一个 Promise；**不同意图不得合并** —— 隐式触发是
   * `startService()`（无 mode，引擎侧回退到语言模型），若与
   * `ensureMode('embedding')` 的 `startService({mode:'embedding'})` 合并，
   * `mode` 会被静默丢弃（静默降级），随后 `waitForServiceReady('embedding')` 必然超时。
   */
  private startServiceInFlight = new Map<
    string,
    Promise<{ ok: boolean; code?: string; canDegrade?: boolean; error?: string }>
  >()
  /**
   * 推理服务启动的串行链：不同意图**排队执行**，绝不并发下发。
   *
   * 并发下发会让引擎侧 `start_engine_service` 在 `Starting` 态直接覆写 `active_model`
   * 后调用 `start_service`，而后者因 `Starting` 早返回成功 ⇒ 返回「启动成功」但
   * 实际加载的仍是上一个模型（`active_model` 与 `running_model` 从此不一致）。
   *
   * 链上必须吞掉前序 Reject（`then(undefined, undefined)`），否则一次启动失败会毒化
   * 整条链，后续所有启动请求永久拒绝。
   */
  private startServiceChain: Promise<unknown> = Promise.resolve()
  /** 宿主是否已安装可用的 llama-server 引擎（null=未知/初始状态，false=明确未安装，true=已安装就绪） */
  public hasInstalledEngines: boolean | null = null
  /** 最近一次「隐式触发」启动的时刻（0 = 从未触发）；见 `service-start-policy.ts` */
  private lastImplicitStartAt = 0
  /** 服务停止代际计数，每次 stop() 递增以拦截在途异步探活与 SSE 流回写已停止状态 */
  private stopEpoch = 0
  /** SSE 连接代际计数，每次新循环或抢占重连递增，8 切面严格双代际门控 */
  private connectionEpoch = 0
  /** 当前活跃单循环 `runStreamLoop` 所属连接代际（null 表示处于 Dormant 静默挂起态） */
  private activeLoopEpoch: number | null = null
  /** 停机中止控制器：`stop()` 时 abort，`doStart()` 重入时重建 */
  private stopController: AbortController = new AbortController()
  /** 是否正处于 `stop()` 执行窗口（期间抑制 `applyOffline` 重复广播闪烁） */
  private isStopping = false
  /** 在途 `stop()` Promise，供并发 `stop()` 合并及 `doStart()` 串行等待 */
  private stopPromise: Promise<void> | null = null
  /** 当前已建连（或正在建连）目标三元组，用于同端口重启身份变化识别 */
  private connectedTarget: ConnectedTargetIdentity | null = null
  /** 连续连接失败计数（达 OFFLINE_CONFIRM_FAILURES=3 判离线，达 DORMANT_MAX_ATTEMPTS=5 转 Dormant） */
  private consecutiveFailures = 0
  /** 最近一次已采纳的引擎状态单调版本号（用于丢弃乱序旧快照） */
  private lastAppliedRevision = 0
  /** 最近一次已采纳的引擎实例 ID（切换新实例时重置 lastAppliedRevision = 0） */
  private lastAppliedInstanceId: string | null = null
  /** 当前桌面实例的 userData 目录路径（用于 isPathEqual 同源校验与发现文件定位） */
  private readonly userDataPath: string
  /** 跨模块服务发现文件（userData/run/engine-config.json） */
  private readonly discoveryFile: ServiceDiscoveryFile
  /** DirWatcher 订阅取消函数 */
  private discoveryWatchUnsubscribe: (() => void) | null = null
  /** 退避 sleep 阶段的中止控制器（被 kickEventStreamReconnect / stop 立即打断） */
  private reconnectAbortController: AbortController | null = null
  /** 启动期 stdout FIREFLY_READY 快路径回调集合（用于即时唤醒 waitForReady） */
  private readySignalResolvers = new Set<() => void>()
  private lastRawStatus: Tier2EngineStatus | null = null
  private versionCache: string | null = null
  private lastError: string | null = null
  /** 引擎已安装模型计数缓存（经 /api/models 异步汇总，包含语言模型与 embedding 模型，见 refreshModelCount） */
  private lastModelCount: number | null = null
  /** 支持的可用模型总数缓存（默认 33，合计语言模型与 embedding 模型） */
  private lastTotalModelCount: number = 33
  /** model id / fileName → 展示名称映射（随 refreshModelCount 一并更新） */
  private lastModelNameMap: Map<string, string> = new Map()
  /** 最近一次有效的 current_model（服务停止后保留，用于 UI 持续展示上次激活模型） */
  private lastKnownModel: string | null = null
  /** 引擎本地已下载的默认激活模型（服务未启动时兜底展示激活模型） */
  private firstDownloadedModel: string | null = null
  /** 当前激活引擎在引擎列表中的适配类型缓存（Footer「兼容模式」标记依据） */
  private lastBackendMatchType: 'best' | 'compatible' | 'fallback' | null = null
  /** 引擎列表拉取防抖标志（与模型计数同策略，避免并发重复拉取） */
  private engineListFetching = false
  /** 操作系统原生进程树与 JobObject 管理中心 (Ticket 02) */
  private readonly processTreeManager: ProcessTreeManager = processTreeManager
  /** 引擎思考模式同步 in-flight Promise（并发调用共享同一次同步，均可 await 到完成） */
  private thinkingSyncPromise: Promise<void> | null = null
  /** 最近一次与引擎对齐的思考模式值（防止「引擎→桌面」回写再触发「桌面→引擎」死循环） */
  private lastSyncedThinking: boolean | null = null
  /** ENABLE_THINKING_MODE 变更订阅取消函数 */
  private thinkingConfigUnsubscribe: (() => void) | null = null
  /** 内置模型元数据缓存（包含所有语言模型与 embedding 模型；权威来源 = engine /api/models/meta） */
  private builtinModelCatalog: Array<{ id: string; name: string; isEmbedding?: boolean }> | null =
    null
  /** 引擎 /api/models 模型列表缓存（随 refreshModelCount 更新，作为 matchSlotToCatalog 第二层匹配源） */
  private downloadedModelCatalog: Array<{
    id: string
    name: string
    localPath?: string
    fileName?: string
    isEmbedding?: boolean
  }> = []
  /** 引擎模型元数据全量缓存（含 totalSize / vramRequiredGB / recommendedConfig 等，供 enrichAIStatus 匹配） */
  private modelMetaCache: { lang: string; models: any[]; fetchedAt: number } | null = null
  /** 统一引擎最新运行时指标快照与更新时间戳缓存 */
  private latestMetrics: EngineMetricsSnapshot | null = null
  private latestMetricsUpdatedAt: number | null = null
  /** 模型计数刷新进行中的 Promise（并发调用共享同一刷新，await 可等待真正完成） */
  private modelCountPromise: Promise<void> | null = null
  /** 最近一次模型计数刷新尝试的完成时刻（0 = 从未尝试；心跳节流判据，见 shouldRefreshModelCount） */
  private lastModelCountFetchAt = 0
  /** 最近一次模型计数刷新是否成功（决定下一轮用 TTL 还是短重试间隔） */
  private lastModelCountFetchOk = false
  /**
   * 本服务已拉起二进制的签名（mtimeMs:size）。
   * 非 null 表示「本服务托管过引擎」，用于开发态感知 `engine:deploy:watch` 的重编译覆盖。
   */
  private spawnedBinarySignature: string | null = null
  /** 最近一次成功拉起子进程的时间戳，用于启动冷静期保护 */
  private lastSpawnedAt = 0
  /** 热更新待确认的候选签名 */
  private pendingUpdateSignature: string | null = null
  /** 候选签名首次被发现的时间戳（用于防抖稳定期判断） */
  private pendingUpdateSince = 0
  /** 开发态二进制热更新轮询定时器 */
  private devBinaryWatchTimer: NodeJS.Timeout | null = null
  /**
   * 已确认有新二进制、但因引擎正在处理分析请求而推迟的重启。
   * 待引擎回到 ready 后由 applyStatus 触发一次补检，避免在分析中途强杀引擎。
   */
  private deferredBinaryRestart = false
  /**
   * 最近一次「我方主动 kill 子进程」的时间戳。
   * 用户停止服务 / 切换引擎 / 退出应用 / 二进制热部署都会走 `killOwnProcess()`，
   * 这些退出不得触发崩溃自愈（否则表现为「点了停止又自己起来」）。
   * 用时间戳而非布尔标志：exit 事件异步到达，布尔标志容易残留并吞掉下一次真崩溃。
   */
  private lastSelfKillAt = 0
  /** 本崩溃窗口内已消耗的自愈次数（稳定运行满 STABLE_RUN_RESET_MS 后清零） */
  private autoHealAttempts = 0
  /** 崩溃自愈定时器 */
  private autoHealTimer: NodeJS.Timeout | null = null
  /** 是否正在执行 runCrashHeal 异步自愈流程 */
  private isRunningCrashHeal = false
  /** 稳定运行重置计时器：到点归还自愈配额 */
  private stableResetTimer: NodeJS.Timeout | null = null
  private eventStreamAbortController: AbortController | null = null
  private listeners = new Set<(snapshot: EngineBridgeSnapshot) => void>()
  /** 按 mode 键控的 Single-Flight 共享启动在途表（与调用方预算解耦） */
  private inFlightEnsureByMode = new Map<
    EngineTargetMode,
    { promise: Promise<EnsureReadyResult>; force: boolean }
  >()
  /** 共享体自身失败终态单向事件订阅者（供 AIServiceManager 记账冷却） */
  private ensureFailedListeners = new Set<
    (mode: EngineTargetMode, res: EnsureReadyResult) => void
  >()
  readonly circuitBreaker = new Tier2CircuitBreaker()

  /** 当前是否正处于拉起启动流程中 */
  public isStartingNow(): boolean {
    return this.isStarting
  }

  /** 当前是否处于崩溃自愈排期或自愈执行中 */
  public isAutoHealing(): boolean {
    return this.autoHealTimer !== null || this.isRunningCrashHeal
  }

  /**
   * 崩溃自愈配额已耗尽、且引擎仍未恢复（无进程、无状态快照）。
   *
   * 供分析队列做「快速失败」短路：引擎已判定救不回来时，后续文件不应再逐个
   * 空等 `waitForAIServiceReady` 的 120s 预算（166 个文件会累计成数小时），
   * 直接按既有 failed 路径处理即可 —— CPU 阶段（stage 1/2）产物早已落库，不受影响。
   *
   * 一旦引擎被任何路径拉起（`lastRawStatus` 恢复非空），本判定自动失效。
   */
  public isCrashHealExhaustedAndOffline(): boolean {
    return this.autoHealAttempts >= CRASH_HEAL_MAX_ATTEMPTS && !this.process && !this.lastRawStatus
  }

  /** 跨包 DIP 传输层就绪检查器注销函数 */
  private readinessCheckerDisposer: (() => void) | null = null

  private constructor(options?: EngineBridgeServiceOptions) {
    this.userDataPath = this.resolveUserDataPath(options?.userDataPath)
    this.discoveryFile = new ServiceDiscoveryFile({
      fileName: 'engine-config.json',
      serviceId: 'firefly-engine-bridge',
      userDataPath: this.userDataPath
    })
    // 构造期同步注入跨包传输门闩就绪检查器（零 Electron 依赖 DIP 桥接，使 Pro 包 HttpClient 感知宿主实态）
    this.readinessCheckerDisposer = registerEngineReadinessChecker({
      getStatus: (): EngineReadinessStatus => {
        const snap = this.getSnapshot()
        if (!snap.connected) return 'unknown'
        const status = snap.raw?.status
        if (status === 'ready' || status === 'processing') return 'ready'
        if (status === 'starting') return 'starting'
        if (status === 'stopped' || status === 'stopping') return 'stopped'
        if (status === 'error') return 'error'
        return 'unknown'
      },
      isSwapping: () =>
        engineSwappingCoordinator.isInSwapping() ||
        Boolean(this.latestMetrics?.swapping?.isSwapping),
      getPort: () => {
        const snap = this.getSnapshot()
        return snap.connected && snap.port > 0 ? snap.port : null
      },
      ensureReady: (signal?: AbortSignal) =>
        this.ensureReady({
          mode: 'language',
          timeoutMs: SHARED_STARTUP_HARD_TIMEOUT_MS,
          signal
        })
    })
    if (!options?.disableLifecycleHooks) {
      this.setupLifecycleHooks()
    }
    this.setupThinkingConfigSync()
    if (!options?.disableAutoBootstrap) {
      // 启动期清理孤儿发现文件与陈旧 *.tmp.*（保留同源存活的外部引擎实例）
      this.discoveryFile.cleanupOrphanOnStartup({ preserveAliveExternalPid: true })
      // 启动 userData/run/engine-config.json 单例 DirWatcher 监听（纯事件驱动，0 周期定时器）
      this.armDiscoveryWatcher()
      // 条件式自引导：仅当同源发现文件存在且 PID 存活时建连；否则保持 Dormant 静默态（0 定时器、0 请求）
      this.bootstrapFromDiscoveryFile()
    }
    // 开发模式下开机常驻监听引擎二进制热更新（感知 engine:deploy:watch 重编译与部署）
    if (!options?.disableDevBinaryWatch && this.isDevMode()) {
      this.startDevBinaryWatch()
    }
  }

  public static getInstance(): EngineBridgeService {
    if (!EngineBridgeService.instance) {
      EngineBridgeService.instance = new EngineBridgeService()
    }
    return EngineBridgeService.instance
  }

  /**
   * 仅供单元测试构造隔离实例（注入自定义 userDataPath，避免污染全局单例）
   */
  public static createForTest(options?: EngineBridgeServiceOptions): EngineBridgeService {
    return new EngineBridgeService({
      disableDevBinaryWatch: true,
      disableLifecycleHooks: true,
      ...options
    })
  }

  private resolveUserDataPath(override?: string): string {
    if (override && override.trim()) {
      return override
    }
    try {
      const resolved = app && typeof app.getPath === 'function' ? app.getPath('userData') : ''
      if (resolved && resolved.trim()) {
        return resolved
      }
    } catch {
      // 无 Electron 上下文（如独立单测环境）时回退临时目录
    }
    return path.join(os.tmpdir(), 'firefly-ai-folder-engine-bridge')
  }

  private setupLifecycleHooks(): void {
    try {
      if (app && typeof app.on === 'function') {
        app.on('will-quit', () => {
          void this.stop()
        })
        app.on('before-quit', () => {
          void this.stop()
        })
        // 唤醒源 6：主窗口获焦时单次重读发现文件（作为 fs.watch 极端丢事件的最终自愈网）
        app.on('browser-window-focus', () => {
          this.handleWindowFocusRefresh()
        })
      }
      // 唤醒源 5：通过 PowerEventHub 订阅系统休眠唤醒（0ms 首顺位错峰，无闪烁重建 SSE 连接）
      subscribePowerEvent(
        'resume',
        () => {
          this.handleSystemResume()
        },
        { id: 'engine-bridge', resumeOffsetMs: 0 }
      )
      const cleanExitSync = () => this.stopSyncForSignal()
      process.once('exit', cleanExitSync)
      process.once('SIGINT', cleanExitSync)
      process.once('SIGTERM', cleanExitSync)
    } catch (err) {
      // 生命周期钩子注册失败仅意味着退出回收依赖 Electron 默认行为，记日志便于排查残留进程
      logger.warn(LogCategory.SYSTEM, '[EngineBridge] 注册退出清理钩子失败:', err)
    }
  }

  /**
   * 订阅桌面端 ENABLE_THINKING_MODE 变更，双向对齐引擎思考模式：
   * - 桌面设置/云端思考开关变更 → 推送到引擎 config.json（下次启动 llama-server 注入思考参数）
   * - 引擎 UI 变更 → 由探活路径 pull 回写桌面（见 syncThinkingModeFromEngine）
   */
  private setupThinkingConfigSync(): void {
    try {
      this.thinkingConfigUnsubscribe = ConfigOrchestrator.getInstance().onValueChange<boolean>(
        'ENABLE_THINKING_MODE',
        (value: boolean) => {
          const next = Boolean(value)
          // 引擎→桌面回写触发的变更不再回推，避免死循环
          if (this.lastSyncedThinking === next) {
            return
          }
          void this.setThinkingMode(next)
        }
      )
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[EngineBridge] 订阅思考模式配置失败:', err)
    }
  }

  /**
   * 定位 firefly-ai-engine 可执行文件
   *
   * **唯一来源 = desktop 集成目录** `<extraResources>/bin/firefly-ai-engine/`（ADR-0033 1:1 镜像）：
   * - 开发态：`apps/desktop/build/extraResources/bin/firefly-ai-engine/`（由 `pnpm engine:deploy:watch` 部署）
   * - 生产态：`process.resourcesPath/extraResources/bin/firefly-ai-engine/`
   *
   * 引擎工程自身的 `src-tauri/target/{release,debug}` 产物**不再作为加载来源**：
   * 它既不是最终发布形态，也会让引擎的资源锚点落在引擎工程目录内，
   * 从而无法验证「只读自身安装目录 + 自身用户数据目录」这一发布约束。
   */
  public resolveEngineExecutable(): string | null {
    const exeName = process.platform === 'win32' ? 'firefly-ai-engine.exe' : 'firefly-ai-engine'

    // 1. 首选 ResourceLocator：开发态解析到 apps/desktop/build/extraResources，
    //    生产态解析到 process.resourcesPath/extraResources。
    //    关闭 8.3 短路径转换与递归检索，保证路径可读且唯一确定。
    const bin = ResourceLocator.resolveBin(`${ENGINE_BIN_DIR_NAME}/${exeName}`, {
      useShortPath: false,
      recursive: false
    })
    if (bin && fs.existsSync(bin)) {
      return bin
    }

    // 2. monorepo 相对路径兜底（cwd 可能是仓库根，也可能是 apps/desktop）
    for (const root of this.collectMonorepoRoots()) {
      const candidates = [
        path.join(
          root,
          'apps',
          'desktop',
          'build',
          'extraResources',
          'bin',
          ENGINE_BIN_DIR_NAME,
          exeName
        ),
        path.join(
          root,
          'apps',
          'desktop',
          'pro',
          'build',
          'extraResources',
          'bin',
          ENGINE_BIN_DIR_NAME,
          exeName
        ),
        path.join(root, 'build', 'extraResources', 'bin', ENGINE_BIN_DIR_NAME, exeName)
      ]
      for (const cand of candidates) {
        if (fs.existsSync(cand)) {
          return cand
        }
      }
    }

    return null
  }

  /**
   * 收集候选 monorepo 根：process.cwd() 及其祖先目录。
   * 用于在 ResourceLocator 未命中时，以「仓库根 / apps/desktop」两种 cwd 起点
   * 拼出 desktop 集成目录的候选路径。
   */
  private collectMonorepoRoots(): string[] {
    const roots: string[] = []
    const push = (p: string) => {
      if (p && !roots.includes(p)) roots.push(p)
    }
    push(process.cwd())
    let probe = process.cwd()
    for (let i = 0; i < 6; i++) {
      const parent = path.dirname(probe)
      if (parent === probe) break
      probe = parent
      push(probe)
    }
    return roots
  }

  /**
   * 获取引擎二进制部署信息，供监控面板展示与降级提示
   */
  public getExeInfo(): { available: boolean; path: string | null; devMode: boolean } {
    const exePath = this.resolveEngineExecutable()
    return { available: exePath !== null, path: exePath, devMode: this.isDevMode() }
  }

  /** 是否开发态（未打包或非 production） */
  private isDevMode(): boolean {
    return isLocalDevRuntime()
  }

  /**
   * 从引擎 /api/models/meta 拉取推荐模型元数据（model_*.json 权威落点在 engine build/extraResources/model）。
   * desktop 一律经引擎查询模型信息，不再读取 desktop 侧 model_*.json。
   * @param lang 语言代码（默认 zh-CN；引擎侧缺省会回退 zh-CN）
   * @param force 强制刷新缓存
   */
  public async fetchModelMeta(lang = 'zh-CN', force = false): Promise<any[]> {
    const now = Date.now()
    // 仅命中非空缓存：空结果视为未命中，允许下次重试（探活早期误匹配或引擎未就绪时会写入空值）
    if (
      !force &&
      this.modelMetaCache &&
      this.modelMetaCache.lang === lang &&
      this.modelMetaCache.models.length > 0 &&
      now - this.modelMetaCache.fetchedAt < 60_000
    ) {
      return this.modelMetaCache.models
    }

    try {
      const res = await fetch(
        `${this.baseUrl}${ENGINE_MODEL_META_PATH}?lang=${encodeURIComponent(lang)}`,
        { method: 'GET', signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) }
      )
      if (res.ok) {
        const payload = (await res.json()) as { models?: any[] }
        const models = Array.isArray(payload?.models) ? payload.models : []
        if (models.length > 0) {
          this.modelMetaCache = { lang, models, fetchedAt: now }
          // 同步刷新目录缓存（id/name/isEmbedding）
          this.builtinModelCatalog = models.map((m: any) => ({
            id: String(m.id || ''),
            name: String(m.name || ''),
            isEmbedding: Boolean(m.isEmbedding)
          }))
        }
        return models
      }
      logger.debug(LogCategory.SYSTEM, `[EngineBridge] /api/models/meta 响应非 OK: ${res.status}`)
    } catch (err) {
      logger.debug(LogCategory.SYSTEM, '[EngineBridge] 拉取引擎模型元数据失败:', err)
    }
    return this.modelMetaCache?.lang === lang ? this.modelMetaCache.models : []
  }

  /**
   * 获取引擎模型元数据目录（id/name/isEmbedding），供友好名映射与总模型数计算。
   * 优先使用内存缓存；未命中时返回空数组（由调用方决定是否触发 fetchModelMeta）。
   */
  private loadBuiltinModelCatalog(): Array<{ id: string; name: string; isEmbedding?: boolean }> {
    if (this.builtinModelCatalog && this.builtinModelCatalog.length > 0) {
      return this.builtinModelCatalog
    }
    try {
      const configPath = ResourceLocator.resolveModelConfig('model_zh-CN.json')
      if (fs.existsSync(configPath)) {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'))
        const models = Array.isArray(raw?.models) ? raw.models : []
        if (models.length > 0) {
          this.builtinModelCatalog = models.map((m: any) => ({
            id: String(m.id || ''),
            name: String(m.name || ''),
            isEmbedding: Boolean(m.isEmbedding)
          }))
          return this.builtinModelCatalog || []
        }
      }
    } catch (err) {
      logger.debug(
        LogCategory.SYSTEM,
        '[EngineBridge] 从本地 model_zh-CN.json 加载 catalog 失败:',
        err
      )
    }
    return []
  }

  /**
   * 同步获取已缓存的模型元数据全量条目（含 totalSize / vramRequiredGB 等）。
   * 未缓存时返回空数组；调用方可用 fetchModelMeta 异步预热。
   */
  public getCachedModelMeta(): any[] {
    return this.modelMetaCache?.models || []
  }

  /**
   * 将当前加载的原始模型标识（路径、文件名、简写 ID）解析为规范的模型展示名称
   */
  public resolveFriendlyModelName(identifier: string | null): string | null {
    if (!identifier) return null
    return (
      EngineModelCatalogResolver.resolveFriendlyModelName(identifier, {
        catalog: this.loadBuiltinModelCatalog(),
        modelNameMap: this.lastModelNameMap
      }) || null
    )
  }

  /**
   * 推导展示模型及其友好名称（对齐 firefly-ai-engine resolveDisplayModel 的权威优先级）
   */
  private resolveDisplayModelPair(): { model: string | null; modelName: string | null } {
    const res = EngineModelCatalogResolver.resolveDisplayModelPair(this.lastRawStatus, {
      builtinCatalog: this.loadBuiltinModelCatalog(),
      downloadedCatalog: this.downloadedModelCatalog,
      modelNameMap: this.lastModelNameMap,
      lastKnownModel: this.lastKnownModel,
      firstDownloadedModel: this.firstDownloadedModel
    })
    return { model: res.model, modelName: res.modelName }
  }

  /**
   * 将引擎激活槽位值匹配到内置模型目录或已下载/自定义模型列表条目
   */
  private matchSlotToCatalog(
    slot: string,
    prefer: 'language' | 'embedding'
  ): { id: string; name: string } | null {
    return EngineModelCatalogResolver.matchSlotToCatalog(slot, prefer, [
      this.loadBuiltinModelCatalog(),
      this.downloadedModelCatalog
    ])
  }

  /**
   * 计算二进制签名（mtimeMs + size）。
   * 集成目录被 `engine:deploy:watch` 覆盖后签名必然变化，用于判断是否需要重启引擎。
   */
  private binarySignature(exePath: string): string | null {
    try {
      const st = fs.statSync(exePath)
      return `${st.mtimeMs}:${st.size}`
    } catch (err) {
      logger.debug(LogCategory.SYSTEM, `[EngineBridge] 读取引擎二进制签名失败: ${exePath}`, err)
      return null
    }
  }

  /**
   * 当前配置是否要求引擎常驻运行（高级AI引擎 = 萤核AI引擎，即 local）
   * 读取失败时保守返回 false，避免误拉起。
   */
  private async shouldEngineRun(): Promise<boolean> {
    try {
      const mode = ConfigOrchestrator.getInstance().getValue<string>('AI_SERVICE_MODE') || 'local'
      return mode === 'local'
    } catch (err) {
      logger.debug(
        LogCategory.SYSTEM,
        '[EngineBridge] 读取 AI_SERVICE_MODE 失败，跳过自动拉起:',
        err
      )
      return false
    }
  }

  /**
   * 启动开发态二进制热更新监听。
   *
   * `pnpm engine:deploy:watch` 会在重编译后覆盖集成目录中的 exe（覆盖前先 taskkill 占锁进程），
   * 若 desktop 不做任何处理，用户会一直跑在旧二进制上。这里周期比对签名，
   * 发现变化即回收本服务拉起的旧进程，并在「高级AI引擎 = 萤核AI引擎」时重新拉起新二进制。
   *
   * 生产环境不启动该监听（打包产物不会被就地覆盖）。
   */
  public startDevBinaryWatch(intervalMs: number = DEV_BINARY_WATCH_INTERVAL_MS): void {
    if (this.devBinaryWatchTimer || !this.isDevMode()) {
      return
    }
    this.devBinaryWatchTimer = setInterval(() => {
      void this.checkBinaryUpdated()
    }, intervalMs)
    this.devBinaryWatchTimer.unref?.()
    logger.debug(
      LogCategory.SYSTEM,
      `[EngineBridge] 已开启引擎二进制热更新监听（每 ${intervalMs}ms 比对集成目录产物）`
    )
  }

  /** 停止开发态二进制热更新监听 */
  public stopDevBinaryWatch(): void {
    if (this.devBinaryWatchTimer) {
      clearInterval(this.devBinaryWatchTimer)
      this.devBinaryWatchTimer = null
    }
  }

  /**
   * 比对当前二进制签名与本服务拉起时的签名；变化则重启引擎。
   * - 本服务托管过引擎：回收旧进程 → 按当前模式决定是否重新拉起
   * - 从未托管（引擎由外部启动）：不越权结束进程，仅提示需重启后生效
   */
  private async checkBinaryUpdated(): Promise<void> {
    if (this.isStarting) {
      return
    }
    // 启动冷静期（15秒）：若子进程存在且刚启动不久，给其足够的稳定初始化时间，避免启动期抖动
    if (this.process && this.lastSpawnedAt > 0 && Date.now() - this.lastSpawnedAt < 15_000) {
      return
    }
    const exePath = this.resolveEngineExecutable()
    if (!exePath) {
      return
    }
    const signature = this.binarySignature(exePath)
    if (!signature || signature === this.spawnedBinarySignature) {
      this.pendingUpdateSignature = null
      this.pendingUpdateSince = 0
      return
    }

    // 首次检测到签名变更：进入待定状态，不立即杀死进程
    if (this.pendingUpdateSignature !== signature) {
      this.pendingUpdateSignature = signature
      this.pendingUpdateSince = Date.now()
      return
    }

    // 连续两次检测到相同新签名，且持续稳定至少 3 秒（确保外部文件复制落盘完全完毕）
    if (Date.now() - this.pendingUpdateSince < 3_000) {
      return
    }

    // 分析进行中不得重启：此刻回收进程会让正在分析的文件整批失败，
    // 且会被上层错误处理误判为「引擎异常」再次重启（放大成连环重启）。
    // 保留 pending 状态，等引擎回到 ready 后由 applyStatus 触发补检。
    if (this.lastRawStatus?.status === 'processing') {
      if (!this.deferredBinaryRestart) {
        logger.debug(
          LogCategory.SYSTEM,
          '[EngineBridge] 检测到引擎二进制更新，但引擎正在处理分析请求，推迟到空闲后重启'
        )
      }
      this.deferredBinaryRestart = true
      return
    }

    const previous = this.spawnedBinarySignature
    this.spawnedBinarySignature = signature
    this.pendingUpdateSignature = null
    this.pendingUpdateSince = 0

    if (previous === null) {
      // 本服务未托管过引擎：若当前有外部实例在跑，不越权处理
      if (this.lastRawStatus) {
        logger.warn(
          LogCategory.SYSTEM,
          '[EngineBridge] 检测到引擎二进制已更新，但当前实例非本服务拉起，需重启该实例后新版本才会生效'
        )
      } else if (await this.shouldEngineRun()) {
        logger.info(
          LogCategory.SYSTEM,
          `[EngineBridge] 检测到新部署的引擎二进制（${signature}），主动拉起`
        )
        await this.ensureRunning().catch(() => false)
        this.broadcastStatus()
      }
      return
    }

    logger.info(
      LogCategory.SYSTEM,
      `[EngineBridge] 检测到引擎二进制更新（${previous} → ${signature}），回收旧进程并重新拉起`
    )
    this.killOwnProcess()
    // 先等旧实例（可能绑定在滑动端口上）真正释放端口，再复位到基准端口，
    // 否则新实例会顺延绑定，desktop 将连不上刚拉起的引擎
    await this.waitForPortReleased()
    this.activePort = TIER2_ENGINE_PORT
    this.lastRawStatus = null
    this.lastModelCount = null
    this.circuitBreaker.reset()

    if (await this.shouldEngineRun()) {
      const ok = await this.ensureRunning().catch(() => false)
      logger.info(
        LogCategory.SYSTEM,
        `[EngineBridge] 引擎二进制更新后重启${ok ? '成功' : '未就绪（将由 Tier 1 兜底）'}`
      )
    }
    this.broadcastStatus()
  }

  /** 当前生效的引擎端点基址 */
  private get baseUrl(): string {
    return `http://127.0.0.1:${this.activePort}`
  }

  /**
   * 拉取统一引擎运行时指标与显存/Worker快照 (/v1/engine/metrics) (Ticket 3)
   * 归一化为标准 EngineMetricsSnapshot，在超时或瞬态失败时保留上一次有效缓存且不累加探活失败计数
   */
  public async fetchMetrics(): Promise<EngineMetricsSnapshot | null> {
    try {
      const res = await fetch(`${this.baseUrl}${ENGINE_METRICS_PATH}`, {
        method: 'GET',
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS)
      })
      if (!res.ok) {
        return this.latestMetrics
      }
      const rawData = (await res.json()) as any
      const data = normalizeEngineMetricsPayload(rawData)
      if (data) {
        this.latestMetrics = data
        this.latestMetricsUpdatedAt = Date.now()
      }
      return this.latestMetrics
    } catch {
      // 超时或瞬态失败保留上一次有效 metrics，且不累加 probeFailureCount
      return this.latestMetrics
    }
  }

  /**
   * 获取当前引擎能力快照 (严守 AGENTS.md §2.12：五态 starting / ready / processing / error / stopped) (Ticket 3)
   */
  public async getEngineCapability(): Promise<EngineCapability> {
    const raw = this.lastRawStatus
    const metrics = await this.fetchMetrics()

    let state: 'starting' | 'ready' | 'processing' | 'error' | 'stopped' = 'stopped'
    let reasonCode: string | undefined

    if (raw?.status === 'ready') {
      state = 'ready'
      if (metrics?.swapping?.isSwapping) {
        reasonCode = 'engine_swapping'
      }
    } else if (raw?.status === 'processing') {
      state = 'processing'
    } else if (raw?.status === 'starting' || this.isStarting) {
      state = 'starting'
    } else if (raw?.status === 'error') {
      state = 'error'
    } else {
      state = 'stopped'
    }

    return {
      state,
      reasonCode,
      metrics: metrics || undefined,
      supportedChannels: ['chat', 'embeddings']
    }
  }

  /**
   * 探活：向 /api/engine/status 发起一次状态查询
   * 默认每次失败都将计入熔断器（Tier 2 静默熔断）；后台轮询与启动等待可传入 `{ recordFailure: false }` 走裸探活。
   *
   * 基准端口不可达时会扫描 38400~38419，采纳引擎实际绑定的滑动端口，
   * 避免引擎顺延后 desktop 永久显示「未连接」。
   */
  public async healthCheck(options?: {
    recordFailure?: boolean
  }): Promise<Tier2EngineStatus | null> {
    const epoch = this.stopEpoch
    const data = await this.probeStatus(this.activePort, STATUS_TIMEOUT_MS)
    if (epoch !== this.stopEpoch) {
      return null
    }
    if (data) {
      this.circuitBreaker.recordSuccess()
      this.applyStatus(data)
      return data
    }

    // 基准端口不可达：引擎可能因端口占用顺延绑定，扫描区间并采纳实际端口
    if (await this.adoptRunningEnginePort(epoch)) {
      this.circuitBreaker.recordSuccess()
      return this.lastRawStatus
    }
    if (epoch !== this.stopEpoch) {
      return null
    }

    if (options?.recordFailure !== false) {
      this.circuitBreaker.recordFailure()
    }
    return null
  }

  /** 单端口探活（不触碰熔断器与状态缓存，供探活主路径与滑动探测复用） */
  private async probeStatus(port: number, timeoutMs: number): Promise<Tier2EngineStatus | null> {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${ENGINE_STATUS_PATH}`, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) {
        return null
      }
      const data = (await res.json()) as Tier2EngineStatus
      if (!this.isSameOriginUserDataDir(data?.user_data_dir)) {
        logger.warn(
          LogCategory.SYSTEM,
          `[EngineBridge] 探测端口 ${port} 命中跨 Worktree 引擎实例 (user_data_dir=${data?.user_data_dir} !== ${this.userDataPath})，拒绝采纳`
        )
        return null
      }
      return data
    } catch (err) {
      return null
    }
  }

  /**
   * 核验发现文件或引擎状态上报的 userDataDir 是否与当前桌面实例同源（isPathEqual）
   * - 若字段非空且路径不等，视为其他 Worktree 实例，严禁采纳
   */
  private isSameOriginUserDataDir(candidate?: string | null): boolean {
    if (typeof candidate !== 'string' || !candidate.trim()) {
      return true
    }
    return isPathEqual(candidate, this.userDataPath)
  }

  /**
   * 读取并校验同源发现文件（userData/run/engine-config.json）
   */
  private readSameOriginDiscovery(): ServiceDiscoveryFileV1 | null {
    const info = this.discoveryFile.read({ verifyPid: true })
    if (!info) {
      return null
    }
    if (!this.isSameOriginUserDataDir(info.userDataDir)) {
      logger.warn(
        LogCategory.SYSTEM,
        `[EngineBridge] 发现文件 userDataDir 不同源 (${info.userDataDir} !== ${this.userDataPath})，拒绝采纳`
      )
      return null
    }
    return info
  }

  /**
   * 挂载 userData/run/engine-config.json 目录监听器（纯事件驱动，支持 stop -> doStart 重臂）
   */
  private armDiscoveryWatcher(): void {
    if (this.discoveryWatchUnsubscribe) {
      return
    }
    try {
      this.discoveryWatchUnsubscribe = this.discoveryFile.watch(info => {
        this.handleDiscoveryFileChange(info)
      })
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[EngineBridge] 挂载 engine-config.json 目录监听失败:', err)
    }
  }

  /**
   * 卸载 DirWatcher 订阅（stop 同步段调用）
   */
  private disarmDiscoveryWatcher(): void {
    if (this.discoveryWatchUnsubscribe) {
      try {
        this.discoveryWatchUnsubscribe()
      } catch {
        // 忽略退订异常
      }
      this.discoveryWatchUnsubscribe = null
    }
  }

  /**
   * 构造期条件式自引导：仅当同源发现文件存在且 PID 存活时启动单循环建连；
   * 否则保持 Dormant 静默态（0 定时器、0 网络请求）。
   */
  private bootstrapFromDiscoveryFile(): void {
    const info = this.readSameOriginDiscovery()
    if (!info) {
      return
    }
    this.activePort = info.port
    this.kickEventStreamReconnect({
      expectedTarget: {
        baseUrl: info.baseUrl,
        pid: info.pid,
        instanceId: info.instanceId
      },
      resetFailures: true
    })
  }

  /**
   * 唤醒源 3：处理 userData/run/engine-config.json 变更事件（绕过熔断器 canExecute 门控）
   */
  public handleDiscoveryFileChange(info: ServiceDiscoveryFileV1 | null): void {
    if (this.stopController.signal.aborted) {
      return
    }
    if (!info) {
      return
    }
    if (!this.isSameOriginUserDataDir(info.userDataDir)) {
      logger.warn(
        LogCategory.SYSTEM,
        `[EngineBridge] 忽略跨 Worktree 发现文件变更 (${info.userDataDir} !== ${this.userDataPath})`
      )
      return
    }
    this.activePort = info.port
    this.kickEventStreamReconnect({
      expectedTarget: {
        baseUrl: info.baseUrl,
        pid: info.pid,
        instanceId: info.instanceId
      },
      resetFailures: true
    })
  }

  /**
   * 唤醒源 5：系统休眠唤醒（powerMonitor.on('resume')）无闪烁重建 SSE 连接
   */
  public handleSystemResume(): void {
    if (this.stopController.signal.aborted) {
      return
    }
    this.discoveryFile.rearmWatcher()
    const info = this.readSameOriginDiscovery()
    if (info) {
      this.activePort = info.port
      // 系统唤醒后底层 TCP 可能已半开：先强制清空旧 connectedTarget 再抢占重建，期间不调用 applyOffline 避免 UI 闪烁
      this.connectedTarget = null
      this.kickEventStreamReconnect({
        expectedTarget: {
          baseUrl: info.baseUrl,
          pid: info.pid,
          instanceId: info.instanceId
        },
        resetFailures: true
      })
      return
    }
    if (this.lastRawStatus !== null || this.process !== null || this.connectedTarget !== null) {
      this.connectedTarget = null
      this.kickEventStreamReconnect({ resetFailures: true })
    }
  }

  /**
   * 唤醒源 6：主窗口获焦（browser-window-focus）或显式刷新时单次重读发现文件
   * 仅当 instanceId / revision / port 变化或当前离线而文件显示存活时触发重连
   */
  public handleWindowFocusRefresh(): void {
    if (this.stopController.signal.aborted) {
      return
    }
    this.discoveryFile.rearmWatcher()
    const info = this.readSameOriginDiscovery()
    if (!info) {
      return
    }
    const needsKick =
      this.lastRawStatus === null ||
      !this.isCurrentTargetHealthy() ||
      info.port !== this.activePort ||
      (Boolean(info.instanceId) && info.instanceId !== this.connectedTarget?.instanceId) ||
      info.revision > this.lastAppliedRevision
    if (!needsKick) {
      return
    }
    this.activePort = info.port
    this.kickEventStreamReconnect({
      expectedTarget: {
        baseUrl: info.baseUrl,
        pid: info.pid,
        instanceId: info.instanceId
      },
      resetFailures: true
    })
  }

  /** 获取当前 SSE 状态机所处阶段（供可观测性日志与单元测试断言） */
  public getStreamState(): 'dormant' | 'streaming' | 'reconnecting' {
    if (this.isCurrentTargetHealthy()) {
      return 'streaming'
    }
    if (this.activeLoopEpoch !== null) {
      return 'reconnecting'
    }
    return 'dormant'
  }

  /** 获取当前连接的引擎目标身份三元组（供测试与诊断） */
  public getConnectedTarget(): ConnectedTargetIdentity | null {
    return this.connectedTarget ? { ...this.connectedTarget } : null
  }

  /** 获取本实例关联的 ServiceDiscoveryFile（供测试断言与诊断） */
  public getDiscoveryFile(): ServiceDiscoveryFile {
    return this.discoveryFile
  }

  /** 采纳探活结果：刷新版本缓存与原始状态，并异步刷新模型计数 */
  public applyStatus(data: Tier2EngineStatus): void {
    // 1. 同源身份核验：若携带 user_data_dir 且与当前实例不一致，严禁采纳
    if (!this.isSameOriginUserDataDir(data.user_data_dir)) {
      logger.warn(
        LogCategory.SYSTEM,
        `[EngineBridge] 拒绝采纳异源引擎状态 (user_data_dir=${data.user_data_dir} !== ${this.userDataPath})`
      )
      return
    }

    // 2. instance_id 切换时重置 lastAppliedRevision = 0，随后执行 revision 单调保序
    if (typeof data.instance_id === 'string' && data.instance_id.length > 0) {
      if (this.lastAppliedInstanceId !== null && this.lastAppliedInstanceId !== data.instance_id) {
        this.lastAppliedRevision = 0
      }
      this.lastAppliedInstanceId = data.instance_id
    }
    if (typeof data.revision === 'number' && Number.isFinite(data.revision) && data.revision > 0) {
      if (data.revision <= this.lastAppliedRevision) {
        return
      }
      this.lastAppliedRevision = data.revision
    }

    if (typeof data.version === 'string' && data.version) {
      this.versionCache = data.version
    }
    const prevModel =
      this.lastRawStatus?.current_model || this.lastRawStatus?.model || this.lastKnownModel
    const currentModel = data.current_model || data.model || data.loaded_models?.[0] || null
    const modelChanged = currentModel !== null && currentModel !== prevModel
    // 槽位变更检测：引擎 UI 切换嵌入/语言模型时 current_model 可能不变或置空，
    // 若只检测 current_model 会漏播广播，渲染层只能等下个状态刷新 —— Footer 模型状态「不同步」的延迟根因
    const langSlotChanged =
      (data.active_language_model || null) !== (this.lastRawStatus?.active_language_model || null)
    const embSlotChanged =
      (data.active_embedding_model || null) !== (this.lastRawStatus?.active_embedding_model || null)
    const statusChanged = data.status !== this.lastRawStatus?.status
    const wasOffline = this.lastRawStatus === null

    this.lastRawStatus = data
    // current_model 有值时更新缓存，服务停止后保留上次值供 UI 展示
    if (currentModel) {
      this.lastKnownModel = currentModel
    }
    // 探活成功即代表引擎在线：清掉历史启动超时等陈旧错误，避免「已就绪却仍显示超时」
    const hadError = this.lastError !== null
    this.lastError = null
    // 状态变化（错误清除、模型切换、激活槽位切换、运行状态 ready/processing 切换、从离线恢复）时立即广播，无需等待后续异步操作
    if (
      hadError ||
      modelChanged ||
      langSlotChanged ||
      embSlotChanged ||
      statusChanged ||
      wasOffline
    ) {
      this.broadcastStatus()
    }
    // PRD-0044：探活成功后异步刷新已安装模型计数，不阻塞探活关键路径。
    // 该端点每次请求都要引擎侧全盘扫描，故按 TTL 节流，不跟随高频事件无脑重扫（见 shouldRefreshModelCount）
    if (data.status !== 'stopping' && this.shouldRefreshModelCount()) {
      void this.refreshModelCount()
    }
    // 异步刷新当前引擎适配类型（Footer「兼容模式」标记依据），不阻塞探活关键路径
    if (data.status !== 'stopping') {
      void this.refreshBackendMatchType()
      // 异步对齐思考模式（引擎 UI 变更后 desktop 请求级/Footer 需感知），不阻塞探活关键路径
      void this.syncThinkingModeFromEngine()
      // 确保已连接 SSE 实时状态流（用于毫秒级捕获引擎 API 开始/完成状态）
      this.ensureEventStream()
    }

    // 联动模型置换门闩：若引擎处于 Failed 状态则永久中止，若 stopped/stopping 则可重试中止
    if (data.status === 'error' || (data as any).reason === 'ProcessStatus::Failed') {
      engineSwappingCoordinator.abortSwapping({
        kind: 'permanent',
        code: 'engine_failed',
        message: 'AI engine failed to start (ProcessStatus::Failed)'
      })
    } else if (data.status === 'stopped' || data.status === 'stopping') {
      engineSwappingCoordinator.abortSwapping({
        kind: 'retryable',
        code: 'engine_stopped',
        message: 'AI engine service is not started'
      })
    }

    // 因分析进行中被推迟的二进制热更新：引擎回到空闲（ready）后补一次检测并重启
    if (this.deferredBinaryRestart && data.status === 'ready') {
      this.deferredBinaryRestart = false
      logger.info(
        LogCategory.SYSTEM,
        '[EngineBridge] 引擎已空闲，开始应用推迟的二进制更新（重启加载新版本）'
      )
      setTimeout(() => {
        void this.checkBinaryUpdated()
      }, 800)
    }

    // 同步引擎运行状态至休眠协调器（消除「引擎实际运行但 UI 显示已释放」的状态撒谎）
    // 懒加载避免 engine-bridge ↔ hibernation 的循环依赖（coordinator 注入了 engineBridgeService）
    this.syncEngineStateToCoordinator(data.status)
  }

  /**
   * 将引擎探活状态同步至休眠协调器的 runtimeStore
   * 懒加载 coordinator 单例，避免模块初始化时形成循环依赖
   *
   * ⚠️ 核心契约：探活可响应 ≠ 引擎在用
   * - ready/processing/starting **不再调用** notifyModuleResident：
   *   引擎宿主能应答 status 只证明进程活着，不代表有活跃请求。
   *   若在此谎报 resident，会把协调器已判定"无请求→可休眠"的引擎
   *   重新标回常驻，架空 idle_hibernation 倒计时（scheduleIdleHibernation）。
   *   引擎是否真的"在用"（有活跃租约 / 队列任务）由协调器的
   *   reconcileLiveStates（读真实进程态 + connected/ready/processing + 队列忙碌态）
   *   与 lease-registry 的活跃租约计数权威判定，bridge 不越权代劳。
   * - stopped/error/stopping 仍需 notifyModuleHibernated：引擎真下线要如实通知，
   *   避免协调器 runtimeStore 残留 resident 状态（UI 显示"已释放"的状态撒谎）。
   */
  private syncEngineStateToCoordinator(
    status: 'starting' | 'ready' | 'processing' | 'error' | 'stopped' | 'stopping' | undefined
  ): void {
    try {
      // 仅在下线时通知协调器；在线状态交还租约 + reconcileLiveStates 判定
      if (status === 'stopped' || status === 'error' || status === 'stopping') {
        moduleHibernationCoordinator.notifyModuleHibernated('firefly-ai-engine')
      }
    } catch {
      // coordinator 尚未初始化或模块加载失败时静默跳过，不影响探活主路径
    }
  }

  /**
   * 采纳离线状态：清空原始状态缓存，中断 SSE 事件流，并在状态发生变化时按需广播离线
   */
  public applyOffline(): void {
    engineSwappingCoordinator.abortSwapping({
      kind: 'retryable',
      code: 'engine_stopped',
      message: 'AI engine service is not started'
    })
    if (this.eventStreamAbortController) {
      this.eventStreamAbortController.abort()
      this.eventStreamAbortController = null
    }
    this.connectedTarget = null
    const wasOnline = this.lastRawStatus !== null
    this.lastRawStatus = null
    if (wasOnline && !this.isStopping) {
      this.broadcastStatus()
    }
    // 引擎离线时同步通知协调器（确保 UI 显示已释放而非常驻）
    this.syncEngineStateToCoordinator('stopped')
  }

  /** 8 切面严格双代际所有权门控 */
  private isCurrentOwner(myEpoch: number, myStopEpoch: number): boolean {
    return (
      myEpoch === this.connectionEpoch &&
      myStopEpoch === this.stopEpoch &&
      !this.stopController.signal.aborted
    )
  }

  /** 判断当前 SSE 连接是否已健康绑定在目标身份上 */
  private isCurrentTargetHealthy(expectedTarget?: ConnectedTargetIdentity): boolean {
    if (
      this.eventStreamAbortController === null ||
      this.eventStreamAbortController.signal.aborted
    ) {
      return false
    }
    if (this.connectedTarget === null || this.connectedTarget.baseUrl !== this.baseUrl) {
      return false
    }
    if (expectedTarget) {
      if (expectedTarget.baseUrl !== this.connectedTarget.baseUrl) {
        return false
      }
      if (expectedTarget.pid !== undefined && expectedTarget.pid !== this.connectedTarget.pid) {
        return false
      }
      if (
        expectedTarget.instanceId !== undefined &&
        expectedTarget.instanceId !== this.connectedTarget.instanceId
      ) {
        return false
      }
    }
    return true
  }

  /**
   * 确保单一 SSE 状态流循环处于运行态（Spec §3.3）：
   * 1. stopController 已 abort → 早返
   * 2. 当前目标已健康 STREAMING → 早返复用
   * 3. 已有单循环在跑 → 早返让路
   * 4. 启动单循环 runStreamLoop(myEpoch, stopEpoch)
   */
  public ensureEventStream(): void {
    if (this.stopController.signal.aborted) {
      return
    }
    if (this.isCurrentTargetHealthy()) {
      return
    }
    if (this.activeLoopEpoch !== null) {
      return
    }
    const myEpoch = ++this.connectionEpoch
    this.activeLoopEpoch = myEpoch
    void this.runStreamLoop(myEpoch, this.stopEpoch)
  }

  /**
   * 抢占式重连入口（Spec §3.3）：
   * - 若未传新 expectedTarget（或三元组全等）且当前连接已健康 STREAMING → no-op
   * - 同端口重启（pid / instanceId 变化）绝不误入 no-op，立即中断旧连接并启动新代际单循环
   * - 绕过 circuitBreaker.canExecute() 门控（open-circuit 豁免语义）
   */
  public kickEventStreamReconnect(options?: {
    expectedTarget?: ConnectedTargetIdentity
    resetFailures?: boolean
  }): void {
    if (this.stopController.signal.aborted) {
      return
    }
    if (options?.expectedTarget?.baseUrl) {
      try {
        const parsed = new URL(options.expectedTarget.baseUrl)
        const parsedPort = Number(parsed.port)
        if (Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
          this.activePort = parsedPort
        }
      } catch {
        // 非法 URL 忽略，沿用当前 activePort
      }
    }
    if (this.isCurrentTargetHealthy(options?.expectedTarget)) {
      return
    }
    if (options?.resetFailures) {
      this.consecutiveFailures = 0
    }
    // 同 tick 抢占重建：先中断旧连接与旧退避 sleep，再递增 connectionEpoch 启动新循环
    this.eventStreamAbortController?.abort()
    this.reconnectAbortController?.abort()
    this.connectedTarget = null
    const myEpoch = ++this.connectionEpoch
    this.activeLoopEpoch = myEpoch
    void this.runStreamLoop(myEpoch, this.stopEpoch, options?.expectedTarget)
  }

  /**
   * 单一 SSE 流循环驱动器（Spec §2.1 机制 1/2/3）：
   * - 8 个异步切面强制校验 isCurrentOwner(myEpoch, myStopEpoch)
   * - 主动 abort 不计入失败
   * - 连续 DORMANT_MAX_ATTEMPTS = 5 次失败后强制退出循环进入 Dormant 静默态（0 定时器、0 请求）
   */
  private async runStreamLoop(
    myEpoch: number,
    myStopEpoch: number,
    initialExpectedTarget?: ConnectedTargetIdentity
  ): Promise<void> {
    let pendingTarget = initialExpectedTarget
    let hasAttemptedFallbackScan = false

    try {
      while (this.isCurrentOwner(myEpoch, myStopEpoch)) {
        const discBeforeConnect = this.readSameOriginDiscovery()
        if (discBeforeConnect) {
          this.activePort = discBeforeConnect.port
        }
        const target: ConnectedTargetIdentity = {
          baseUrl: this.baseUrl,
          pid: pendingTarget?.pid ?? discBeforeConnect?.pid,
          instanceId: pendingTarget?.instanceId ?? discBeforeConnect?.instanceId
        }
        pendingTarget = undefined

        const outcome = await this.connectOnce(myEpoch, myStopEpoch, target)

        // 主动 abort 或已失权：绝不计入失败，绝不覆盖新连接状态
        if (outcome === 'aborted' || !this.isCurrentOwner(myEpoch, myStopEpoch)) {
          break
        }

        // 引擎已发送 stopping 终帧后优雅闭合：不盲目无限重连，直接判定离线转 Dormant
        if (outcome === 'stopping') {
          if (this.isCurrentOwner(myEpoch, myStopEpoch) && !this.isStopping) {
            this.applyOffline()
          }
          break
        }

        this.consecutiveFailures++

        // Dormant 快速准入：无受管子进程且发现文件缺失或 PID 已死 → 仅做 1 次单轮降级扫描
        const discAfterFailure = this.readSameOriginDiscovery()
        if (this.process === null && discAfterFailure === null) {
          if (!hasAttemptedFallbackScan) {
            hasAttemptedFallbackScan = true
            const adopted = await this.adoptRunningEnginePort(myStopEpoch)
            if (!this.isCurrentOwner(myEpoch, myStopEpoch)) {
              break
            }
            if (adopted) {
              this.consecutiveFailures = 0
              continue
            }
          }
          // 切面 4：确认仍是当前代际所有权后判离线并立即转 Dormant（0 定时器、0 请求）
          if (this.isCurrentOwner(myEpoch, myStopEpoch) && !this.isStopping) {
            this.applyOffline()
          }
          break
        }

        // 连续 OFFLINE_CONFIRM_FAILURES (3) 次失败确认离线
        if (this.consecutiveFailures >= OFFLINE_CONFIRM_FAILURES) {
          if (this.isCurrentOwner(myEpoch, myStopEpoch) && !this.isStopping) {
            this.applyOffline()
          }
        }

        // 连续 DORMANT_MAX_ATTEMPTS (5) 次失败：强制退出循环进入 Dormant 静默态，绝不无限退避轮询
        if (this.consecutiveFailures >= DORMANT_MAX_ATTEMPTS) {
          logger.warn(
            LogCategory.SYSTEM,
            `[EngineBridge] SSE 连续 ${this.consecutiveFailures} 次连接失败，转入 Dormant 静默挂起态（等待事件唤醒）`
          )
          if (this.isCurrentOwner(myEpoch, myStopEpoch) && !this.isStopping) {
            this.applyOffline()
          }
          break
        }

        // 有界指数退避（1s, 2s, 4s, 8s, 16s + 0~500ms 抖动）
        const baseDelay =
          STREAM_RECONNECT_BACKOFFS_MS[
            Math.min(this.consecutiveFailures - 1, STREAM_RECONNECT_BACKOFFS_MS.length - 1)
          ]
        const jitterMs = Math.floor(Math.random() * 500)
        const sleepAc = new AbortController()
        this.reconnectAbortController = sleepAc
        const sleepSignal = AbortSignal.any([sleepAc.signal, this.stopController.signal])
        const completed = await sleepCancellable(baseDelay + jitterMs, sleepSignal)
        if (this.reconnectAbortController === sleepAc) {
          this.reconnectAbortController = null
        }

        // 切面 5：退避 sleep 唤醒后再次校验双代际所有权
        if (!completed || !this.isCurrentOwner(myEpoch, myStopEpoch)) {
          break
        }
      }
    } finally {
      // 切面 6：仅当自身仍为 activeLoopEpoch 时复位，绝不误清已抢占的新循环
      if (this.activeLoopEpoch === myEpoch) {
        this.activeLoopEpoch = null
      }
    }
  }

  /**
   * 单次 SSE 建连与读流（含 10s 建连看门狗 + 35s 读流看门狗 + 锁死释放顺序）
   */
  private async connectOnce(
    myEpoch: number,
    myStopEpoch: number,
    target: ConnectedTargetIdentity
  ): Promise<'aborted' | 'eof' | 'failed' | 'stopping'> {
    if (!this.isCurrentOwner(myEpoch, myStopEpoch)) {
      return 'aborted'
    }

    const myAc = new AbortController()
    this.eventStreamAbortController = myAc
    const url = `${target.baseUrl}/api/engine/events`
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
    let receivedStoppingFrame = false

    // 阶段一：建连 10s 看门狗（使用可显式 clearTimeout 的 controller，确保进入 STREAMING 态后活跃 Timer 严格为 1）
    const connectTimeoutAc = new AbortController()
    let connectTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      connectTimer = null
      connectTimeoutAc.abort(new SseWatchdogTimeoutError('connect', SSE_CONNECT_TIMEOUT_MS))
    }, SSE_CONNECT_TIMEOUT_MS)

    try {
      const fetchSignal = AbortSignal.any([myAc.signal, connectTimeoutAc.signal])
      let res: Response
      try {
        res = await fetch(url, { signal: fetchSignal })
      } finally {
        if (connectTimer !== null) {
          clearTimeout(connectTimer)
          connectTimer = null
        }
      }

      // 切面 1：建连返回后立即校验双代际所有权
      if (!this.isCurrentOwner(myEpoch, myStopEpoch) || myAc.signal.aborted) {
        if (res.body) {
          void res.body.cancel().catch(() => {})
        }
        return 'aborted'
      }

      if (!res.ok || !res.body) {
        return 'failed'
      }

      reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let firstFrameValidated = false

      // 阶段二：流内每次 reader.read() 独立 35s 读超时看门狗
      while (this.isCurrentOwner(myEpoch, myStopEpoch) && !myAc.signal.aborted) {
        const { done, value } = await readWithWatchdog(reader, SSE_READ_WATCHDOG_MS, myAc.signal)
        if (done) {
          break
        }
        if (!value || value.byteLength === 0) {
          continue
        }

        // 切面 3 前置门控：收到字节后校验所有权
        if (!this.isCurrentOwner(myEpoch, myStopEpoch) || myAc.signal.aborted) {
          return 'aborted'
        }

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() || ''

        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) {
            continue
          }
          const jsonStr = trimmed.slice(5).trim()
          if (!jsonStr) {
            continue
          }

          let statusData: Tier2EngineStatus
          try {
            statusData = JSON.parse(jsonStr) as Tier2EngineStatus
          } catch {
            continue
          }

          // 切面 2：首帧与后续帧强制同源身份核验
          if (!this.isSameOriginUserDataDir(statusData.user_data_dir)) {
            logger.warn(
              LogCategory.SYSTEM,
              `[EngineBridge] SSE 状态帧 user_data_dir 不同源 (${statusData.user_data_dir} !== ${this.userDataPath})，断开连接`
            )
            return 'failed'
          }

          // 切面 3：applyStatus 前严格校验双代际所有权
          if (!this.isCurrentOwner(myEpoch, myStopEpoch) || myAc.signal.aborted) {
            return 'aborted'
          }

          if (!firstFrameValidated) {
            firstFrameValidated = true
            this.connectedTarget = {
              baseUrl: target.baseUrl,
              pid: typeof statusData.pid === 'number' ? statusData.pid : target.pid,
              instanceId:
                typeof statusData.instance_id === 'string' && statusData.instance_id
                  ? statusData.instance_id
                  : target.instanceId
            }
            this.consecutiveFailures = 0
            // 保留熔断器 open-circuit 豁免语义：首帧通过同源校验后复位熔断器
            this.circuitBreaker.recordSuccess()
          }

          this.applyStatus(statusData)
          if (statusData.status === 'stopping') {
            receivedStoppingFrame = true
          }
        }

        if (receivedStoppingFrame) {
          break
        }
      }

      if (!this.isCurrentOwner(myEpoch, myStopEpoch) || myAc.signal.aborted) {
        return 'aborted'
      }
      return receivedStoppingFrame ? 'stopping' : 'eof'
    } catch (err: any) {
      if (connectTimer !== null) {
        clearTimeout(connectTimer)
        connectTimer = null
      }
      // 主动 abort（非建连超时）不计入失败
      if (myAc.signal.aborted || !this.isCurrentOwner(myEpoch, myStopEpoch)) {
        return 'aborted'
      }
      if (err instanceof SseWatchdogTimeoutError) {
        logger.warn(LogCategory.SYSTEM, `[EngineBridge] ${err.message} (${url})`)
      } else {
        logger.debug(LogCategory.SYSTEM, `[EngineBridge] SSE 连接异常 (${url}):`, err)
      }
      return 'failed'
    } finally {
      if (connectTimer !== null) {
        clearTimeout(connectTimer)
        connectTimer = null
      }
      // 锁死释放顺序：myAc.abort() -> await reader.cancel().catch(() => {}) -> try { reader.releaseLock() } catch {}
      if (!myAc.signal.aborted) {
        myAc.abort()
      }
      if (reader) {
        await reader.cancel().catch(() => {})
        try {
          reader.releaseLock()
        } catch {
          // 忽略已释放或流已关闭导致的异常
        }
      }
      // 切面 7：仅当自身仍持有 eventStreamAbortController 时清理 connectedTarget
      if (this.eventStreamAbortController === myAc) {
        if (this.isCurrentOwner(myEpoch, myStopEpoch)) {
          this.connectedTarget = null
        }
        // 切面 8：仅当引用相等时清理 eventStreamAbortController
        this.eventStreamAbortController = null
      }
    }
  }

  /**
   * 在 38400~38419 区间扫描已运行的引擎并采纳其端口。
   * 引擎侧端口滑动（`config/store.rs`）对 desktop 不可见，不采纳就会一直「未连接」。
   * @returns 是否发现并采纳了可用端口
   */
  private async adoptRunningEnginePort(epoch: number = this.stopEpoch): Promise<boolean> {
    const { gate, isStartupGatesInitialized } = await import('../../../main/startup-gates')
    if (!isTestEnvironment() || isStartupGatesInitialized()) {
      await gate('reaperDone')
    }
    const { processReaper } = await import('../../../main/process-reaper')
    if (epoch !== this.stopEpoch || processReaper.isQuittingState()) {
      return false
    }
    for (let port = TIER2_ENGINE_PORT; port < TIER2_ENGINE_PORT + PORT_SCAN_RANGE; port++) {
      if (epoch !== this.stopEpoch) {
        return false
      }
      if (port === this.activePort) {
        continue
      }
      const status = await this.probeStatus(port, PORT_PROBE_TIMEOUT_MS)
      if (epoch !== this.stopEpoch) {
        return false
      }
      if (status) {
        logger.info(
          LogCategory.SYSTEM,
          `[EngineBridge] 基准端口不可达，已在 ${port} 发现运行中的 Tier 2 引擎，采纳该端口`
        )
        this.activePort = port
        this.applyStatus(status)
        return true
      }
    }
    return false
  }

  /**
   * 等待当前端口上的引擎完全退出（最多 limitMs）。
   * 重启前必须确认旧实例已释放端口，否则新实例会顺延绑定到 38401，
   * 表现为 desktop 连不上刚拉起的引擎。
   */
  private async waitForPortReleased(limitMs: number = PORT_RELEASE_WAIT_MS): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < limitMs) {
      if (!(await this.probeStatus(this.activePort, STATUS_TIMEOUT_MS))) {
        return
      }
      await new Promise(resolve => setTimeout(resolve, 300))
    }
    logger.warn(
      LogCategory.SYSTEM,
      `[EngineBridge] 等待端口 ${this.activePort} 释放超时（${limitMs}ms），继续尝试拉起引擎`
    )
  }

  /**
   * 心跳节流判定：本次探活后是否真的需要刷新模型计数。
   *
   * `/api/models` 是磁盘扫描端点（引擎侧每次请求递归扫全目录），而模型集合只在
   * 下载完成 / 删除 / 外部拷入时变化 —— 跟随 5s 心跳无脑重扫既浪费 I/O，又会在
   * CPU 尖峰期与 `/api/engine/status` 抢引擎侧 config 锁，把探活一起拖慢。
   * 成功走 TTL（60s）、失败走短重试（15s）：既砍掉绝大部分扫描，又保留
   * 「引擎刚就绪那次失败」的自愈能力（若只在状态跳变时拉一次，首拉失败即长期缺省）。
   */
  private shouldRefreshModelCount(): boolean {
    if (this.modelCountPromise) return false
    const elapsed = Date.now() - this.lastModelCountFetchAt
    return elapsed >= (this.lastModelCountFetchOk ? MODELS_REFRESH_TTL_MS : MODELS_RETRY_MS)
  }

  /**
   * 从引擎 /api/models 汇总已安装模型数量与可用模型总数并更新缓存（PRD-0044 状态卡增项）。
   * 分子：已安装模型数（合计所有已下载就绪的语言模型、Embedding 向量模型及本地自定义模型）
   * 分母：总可用模型数（合计所有官方推荐语言模型 31 个 + Embedding 向量模型 2 个 = 33 个，加上本地未在推荐库中的自定义模型）
   * 并发去重；数量变化时补播一次状态，让渲染层无需等下个轮询周期。
   * 本方法自身不做节流（显式调用即视为强制刷新），节流只在探活心跳入口 `applyStatus` 处判定。
   */
  private async refreshModelCount(): Promise<void> {
    // 并发去重：进行中的刷新被共享，await 可等待真正完成（避免 applyStatus 触发的刷新与显式 await 竞态）
    if (this.modelCountPromise) {
      return this.modelCountPromise
    }
    this.modelCountPromise = this.doRefreshModelCount().finally(() => {
      this.modelCountPromise = null
    })
    return this.modelCountPromise
  }

  private async doRefreshModelCount(): Promise<void> {
    const startedAt = Date.now()
    // 本轮是否真正拿到了引擎的模型列表（决定下一轮心跳走 TTL 还是短重试）
    let ok = false
    try {
      const prevPair = this.resolveDisplayModelPair()
      // 预热引擎模型元数据目录（model_*.json 权威落点在 engine，desktop 一律经引擎查询）
      await this.fetchModelMeta()

      const res = await fetch(`${this.baseUrl}${ENGINE_MODELS_PATH}`, {
        method: 'GET',
        signal: AbortSignal.timeout(MODELS_TIMEOUT_MS)
      })
      if (res.ok) {
        const list = (await res.json()) as Array<{
          isDownloaded?: boolean
          name?: string
          id?: string
          localPath?: string
          fileName?: string
          isEmbedding?: boolean
        }>
        const prev = this.lastModelCount
        const prevTotal = this.lastTotalModelCount
        const prevFirst = this.firstDownloadedModel

        // 1. 已安装模型数量：合计所有已下载的模型（包含语言模型、embedding 模型和自定义模型）
        this.lastModelCount = Array.isArray(list)
          ? list.filter(m => m?.isDownloaded === true).length
          : null

        // 2. 总可用模型数量：合计所有官方推荐模型（经 /api/models/meta 引擎元数据目录），
        //    并加上扫描到的未在内置推荐列表中的外部自定义模型
        const catalog = this.loadBuiltinModelCatalog()
        const builtinCount = catalog.length > 0 ? catalog.length : 33
        let customCount = 0
        if (Array.isArray(list)) {
          for (const m of list) {
            if (!m) continue
            // 判断是否已被内置推荐目录包含（按 id、name 或文件名模糊匹配）
            const isBuiltin = catalog.some(b => {
              if (b.id && (b.id === m.id || b.name === m.name)) return true
              if (
                m.localPath &&
                b.id &&
                m.localPath.toLowerCase().includes(b.id.split(':')[0].toLowerCase())
              )
                return true
              return false
            })
            if (!isBuiltin) {
              customCount++
            }
          }
        }
        this.lastTotalModelCount = builtinCount + customCount

        // 3. 构建 id / localPath / fileName → name 映射及结构化缓存，供快照与槽位匹配使用
        if (Array.isArray(list)) {
          const map = new Map<string, string>()
          const downloadedCatalog: Array<{
            id: string
            name: string
            localPath?: string
            fileName?: string
            isEmbedding?: boolean
          }> = []
          let firstDl: string | null = null
          for (const m of list) {
            if (!m) continue
            if (m.isDownloaded === true && !firstDl) {
              firstDl = m.localPath || m.id || m.fileName || m.name || null
            }
            if (!m.name || !String(m.name).trim()) continue
            const name = String(m.name).trim()
            const localPath =
              typeof m.localPath === 'string' && m.localPath.trim() ? m.localPath.trim() : undefined
            const rawId = typeof m.id === 'string' && m.id.trim() ? m.id.trim() : undefined
            const idColonTail =
              rawId && rawId.includes(':') ? rawId.split(':').slice(1).join(':').trim() : undefined
            const fileName =
              typeof m.fileName === 'string' && m.fileName.trim()
                ? m.fileName.trim()
                : localPath
                  ? localPath.replace(/.*[/\\]/, '')
                  : idColonTail && idColonTail.toLowerCase().endsWith('.gguf')
                    ? idColonTail
                    : undefined
            const id = rawId || localPath || fileName || name

            if (m.id) map.set(m.id, name)
            if (localPath) map.set(localPath, name)
            if (fileName) map.set(fileName, name)

            // 排除 mmproj 多模态投影器辅助文件，避免误绑为主语言模型或嵌入模型
            const lpBase = localPath ? localPath.replace(/.*[/\\]/, '') : ''
            const isMmproj = [id, name, fileName || '', lpBase].some(
              s => Boolean(s) && /mmproj/i.test(s)
            )
            if (!isMmproj) {
              const isEmbedding =
                m.isEmbedding === true ||
                [id, name, fileName || ''].some(s => Boolean(s) && /wemm|embedding/i.test(s))
              downloadedCatalog.push({
                id,
                name,
                localPath,
                fileName,
                isEmbedding
              })
            }
          }
          this.lastModelNameMap = map
          this.firstDownloadedModel = firstDl
          this.downloadedModelCatalog = downloadedCatalog
        }
        const nextPair = this.resolveDisplayModelPair()
        if (
          prev !== this.lastModelCount ||
          prevTotal !== this.lastTotalModelCount ||
          prevFirst !== this.firstDownloadedModel ||
          prevPair.model !== nextPair.model ||
          prevPair.modelName !== nextPair.modelName
        ) {
          this.broadcastStatus()
        }
        ok = true
      } else {
        // 非 2xx 同属降级（引擎契约变更/路由缺失），显式上报，不静默保留旧值
        logger.warn(
          LogCategory.SYSTEM,
          `[EngineBridge] 拉取引擎模型列表失败 endpoint=${ENGINE_MODELS_PATH} status=${res.status} elapsedMs=${Date.now() - startedAt} timeoutBudgetMs=${MODELS_TIMEOUT_MS} fallback=retained_cached_count cached=${this.lastModelCount ?? 'null'}`
        )
      }
    } catch (err) {
      // 计数为展示增项，失败不影响桥接主链路；但必须显式上报失败原因与保留的兜底值
      // （AGENTS.md §2.9 禁止静默降级：原实现只记 debug，导致该端点长期超时无人察觉）
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
      logger.warn(
        LogCategory.SYSTEM,
        `[EngineBridge] 拉取引擎模型列表失败 endpoint=${ENGINE_MODELS_PATH} elapsedMs=${Date.now() - startedAt} timeoutBudgetMs=${MODELS_TIMEOUT_MS} fallback=retained_cached_count cached=${this.lastModelCount ?? 'null'} error=${reason}`
      )
    } finally {
      // 记录本轮结果供心跳节流判定：成功走长 TTL，失败走短重试（保留自愈能力）
      this.lastModelCountFetchAt = Date.now()
      this.lastModelCountFetchOk = ok
    }
  }

  /**
   * 异步刷新当前激活引擎的适配类型（/api/engine/list 的 matchType）。
   * Footer 仅在 matchType === 'compatible' 时展示「兼容模式」，与引擎管理列表标记保持一致。
   */
  private async refreshBackendMatchType(): Promise<void> {
    if (!this.lastRawStatus || this.engineListFetching) return
    this.engineListFetching = true
    try {
      const res = await fetch(`${this.baseUrl}${ENGINE_LIST_PATH}`, {
        method: 'GET',
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS)
      })
      if (res.ok) {
        const list = (await res.json()) as Array<{
          backend?: string
          isInstalled?: boolean
          installed?: boolean
          matchType?: 'best' | 'compatible' | 'fallback'
        }>
        if (Array.isArray(list) && list.length > 0) {
          const hasAnyInstalled = list.some(e => e?.isInstalled === true || e?.installed === true)
          this.hasInstalledEngines = hasAnyInstalled
        }
        const activeBackend = this.lastRawStatus.active_backend || this.lastRawStatus.backend
        if (Array.isArray(list) && activeBackend) {
          // 归一化比较：cuda134/cuda 等具体变体与列表 backend 字段对齐（忽略大小写）
          const norm = (s: string) => s.toLowerCase()
          const item = list.find(e => e?.backend && norm(e.backend) === norm(activeBackend))
          const next = item?.matchType ?? null
          if (next !== this.lastBackendMatchType) {
            this.lastBackendMatchType = next
            this.broadcastStatus()
          }
        }
      }
    } catch (err) {
      // 适配类型为展示增项，失败不影响桥接主链路；记 debug 便于排查
      logger.debug(LogCategory.SYSTEM, '[EngineBridge] 拉取引擎列表失败（适配类型缺省）:', err)
    } finally {
      this.engineListFetching = false
    }
  }

  /**
   * 获取引擎当前状态（快速路径，不做探活网络请求）
   */
  public getEngineStatus(): Tier2EngineStatus | null {
    return this.lastRawStatus
  }

  /**
   * 推理服务是否可用（`ready` / `processing` / `starting`）。
   *
   * **严禁**用「`/api/engine/status` 可响应」替代本判定：宿主进程重启后 HTTP 立刻
   * 可响应，但推理服务仍是 `stopped`（`target_port` 为 `None`），此时所有 `/v1/*`
   * 请求都会被反代拒绝为 503 —— 这正是 2026-10-30 持续 87 分钟的事故形态。
   */
  private isServiceUsable(status: Tier2EngineStatus | null): boolean {
    return isServiceUsableStatus(status?.status)
  }

  /**
   * 是否应隐式触发一次 `startService()`。
   *
   * 判定逻辑见模块级纯函数 `shouldTriggerServiceStartAt`（单测直接覆盖该纯函数）。
   */
  private shouldTriggerServiceStart(
    status: Tier2EngineStatus | null,
    options?: { explicit?: boolean }
  ): boolean {
    return shouldTriggerServiceStartAt({
      status: status?.status,
      now: Date.now(),
      lastImplicitStartAt: this.lastImplicitStartAt,
      explicit: options?.explicit === true,
      hasInstalledEngines: this.hasInstalledEngines ?? undefined
    })
  }

  /**
   * 收口：宿主在线但推理服务未启动时，触发一次启动（不等待就绪）。
   *
   * 三处调用点（`ensureRunning` 命中分支、`doStart` 的探活命中与 spawn 之后）必须
   * 共用本方法，避免「清单与实际可达路径不一致」。
   *
   * **必须把调用方刚探到的 `status` 传进来**，不得只读 `this.lastRawStatus`：
   * `lastRawStatus` 可能被 `applyOffline()` 置空（宿主在探活与收口之间退出），
   * 此时按 `undefined` 判定会静默放弃触发 —— 与事故同源的「拿不到真实状态就当作没事」。
   *
   * 不 `await`：引擎侧启动最长持锁 `LLAMA_READY_TIMEOUT_SECS`（120s），同步等待会让
   * `engine-bridge/start` IPC 与启动流程阻塞。就绪状态由轮询广播。
   *
   * **已知行为变更（2026-10-30 裁定，非缺陷）**：用户在单次会话内手动「停止服务」后，
   * 只要 desktop 重启（宿主重新拉起）或后续 `ensureRunning()` 再次命中 `stopped`，
   * 推理服务会被重新启动 —— 即「stop 不跨会话持久」。刻意取舍：会话内 Stop 通常是
   * 为临时释放显存，而整个客户端重启后恢复 AI 可用符合多数用户直觉预期；为此引入
   * 持久化 `user_stopped` 状态机会显著增加状态机复杂度（见 Spec Out of Scope §6）。
   */
  private triggerServiceStartIfNeeded(explicit: boolean, status?: Tier2EngineStatus | null): void {
    const effective = status ?? this.lastRawStatus
    if (!this.shouldTriggerServiceStart(effective, { explicit })) {
      return
    }
    this.lastImplicitStartAt = Date.now()
    const detail = effective?.status ?? 'unknown'
    logger.warn(
      LogCategory.SYSTEM,
      `[EngineBridge] 宿主在线但推理服务未就绪（status=${detail}），触发启动推理服务`
    )
    void this.startService().catch((err: unknown) => {
      logger.warn(LogCategory.SYSTEM, '[EngineBridge] 触发启动推理服务失败:', err)
    })
  }

  /**
   * 确保引擎在线：在线则直接复用；离线则尝试静默拉起（受熔断器保护）
   * @param options.force 显式启动（用户点击）时跳过熔断冷却，避免「点了没反应」
   */
  public async ensureRunning(options?: {
    force?: boolean
    mode?: 'language' | 'embedding'
  }): Promise<boolean> {
    if (options?.force) {
      // 显式启动视为用户意图，复位熔断器重新放行
      this.circuitBreaker.reset()
      // 同时清零隐式启动节流窗口：否则隐式启动失败后 30s 内用户点「启动」会被节流挡住，
      // 且因返回 true 而表现为「点了没反应」
      this.lastImplicitStartAt = 0
    } else {
      if (this.circuitBreaker.getState() === 'open') {
        logger.warn(
          LogCategory.SYSTEM,
          '[EngineBridge] Tier 2 引擎处于熔断冷却期，跳过静默拉起（分析将降级到 Tier 1）'
        )
        return false
      }
      if (!(await this.shouldEngineRun())) {
        logger.debug(
          LogCategory.SYSTEM,
          '[EngineBridge] 当前高级AI引擎已禁用或处于云端模式，跳过拉起'
        )
        return false
      }
    }

    // 先探活复用（熔断器允许时）
    if (this.circuitBreaker.canExecute()) {
      const status = await this.healthCheck()
      if (status) {
        if (this.isDevMode()) {
          this.startDevBinaryWatch()
        }
        // 「HTTP 可响应」≠「推理服务可用」：必须按 status 分层判定
        if (this.isServiceUsable(status)) {
          logger.debug(
            LogCategory.SYSTEM,
            `[EngineBridge] 复用已运行的 Tier 2 引擎 (${this.baseUrl})`
          )
          this.broadcastStatus()
          return true
        }
        const explicit = options?.force === true
        if (this.shouldTriggerServiceStart(status, { explicit })) {
          this.triggerServiceStartIfNeeded(explicit, status)
          this.broadcastStatus()
          return true
        }
        if (status.status === 'error') {
          // 启动失败已落库：返回 false 让上层诚实降级到 Tier 1，严禁谎报「引擎在线」
          const detail = status.last_error || status.error || ''
          logger.warn(
            LogCategory.SYSTEM,
            `[EngineBridge] 引擎宿主在线但推理服务启动失败（status=error），交由 Tier 1 兜底${
              detail ? `：${detail}` : ''
            }`
          )
          this.broadcastStatus()
          return false
        }
        logger.warn(
          LogCategory.SYSTEM,
          `[EngineBridge] 引擎宿主在线但推理服务未就绪（status=${status.status ?? 'unknown'}），节流窗口内不重复触发`
        )
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
        // 宿主在线 ≠ 推理服务可用：此处不得直接 return true，否则「有进程但模型没起」
        // 会被当作启动成功，调用方继续发请求即撞 503（2026-10-30 事故形态）
        if (!this.isServiceUsable(status)) {
          this.triggerServiceStartIfNeeded(true, status)
        }
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
    // 1. 重入保护：若 stop() 尚在途，先串行等待停机闭环彻底完成
    if (this.stopPromise) {
      await this.stopPromise
    }
    // 2. 重入重置：重建已中止的 stopController、重臂 DirWatcher、清零失败与版本状态
    if (this.stopController.signal.aborted) {
      this.stopController = new AbortController()
    }
    this.armDiscoveryWatcher()
    this.consecutiveFailures = 0
    this.lastAppliedRevision = 0
    this.lastAppliedInstanceId = null

    this.isStarting = true
    const exePath = this.resolveEngineExecutable()
    if (!exePath) {
      const msg = '未找到萤核AI引擎可执行文件，跳过自动拉起（由基础AI引擎全程保底）'
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
        // 复用的是「已存在但推理服务未启动」的宿主时，同样必须收口
        if (!this.isServiceUsable(alive)) {
          this.triggerServiceStartIfNeeded(true, alive)
        }
        this.isStarting = false
        this.broadcastStatus()
        return true
      }

      // J-06 / B5：spawn 前必须等待 reaperDone 门闸落地，并复检退出态
      const { gate, isStartupGatesInitialized } = await import('../../../main/startup-gates')
      if (!isTestEnvironment() || isStartupGatesInitialized()) {
        await gate('reaperDone')
      }
      const { processReaper: reaperForCheck } = await import('../../../main/process-reaper')
      if (reaperForCheck.isQuittingState() || this.stopController.signal.aborted) {
        logger.info(LogCategory.SYSTEM, '[EngineBridge] 进程正在退出，取消拉起 Tier 2 引擎')
        this.isStarting = false
        return false
      }

      // 即将拉起新宿主：清零隐式启动节流窗口（新进程 ⇒ 新窗口）
      this.lastImplicitStartAt = 0
      logger.info(LogCategory.SYSTEM, `[EngineBridge] 静默拉起 Tier 2 引擎: ${exePath}`)
      // ENGINE_PORT 仅作前向兼容提示：引擎当前从自身 %APPDATA%/com.firefly.ai-engine/config.json
      // 的 base_port 取基准端口，并在被占用时于 38400~38419 内顺延；
      // FIREFLY_USER_DATA_DIR 显式传递当前 Desktop userData 目录，供引擎写入 userData/run/engine-config.json 并做同源校验。
      const env = {
        ...process.env,
        ENGINE_PORT: String(TIER2_ENGINE_PORT),
        FIREFLY_USER_DATA_DIR: this.userDataPath,
        // 宿主生命周期守护：以管道方式提供 stdin（见下方 stdio），桌面端进程一旦消失
        // （正常退出 / 崩溃 / 任务管理器强杀），管道写端由内核关闭，引擎读到 EOF 后
        // 主动退出并带走 llama-server。与 firefly-omni 的 OMNI_WATCH_STDIN 同一约定。
        ENGINE_WATCH_STDIN: '1'
      }
      // windowsHide: 抑制 Windows 控制台窗口闪烁（debug 构建的引擎为控制台子系统）
      // stdio[0] 必须保留 'pipe'：'ignore' 会让引擎拿到 NUL 设备句柄而永远读不到 EOF；
      // stdio[1] 改为 'pipe'：用于 <1ms 解析引擎 stdout FIREFLY_READY 快路径（必须持续消费以防缓冲区阻塞）。
      const child = spawn(exePath, ['--silent', '--tray'], {
        detached: true,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        env
      })
      this.process = child
      this.attachStdoutReadyListener(child)
      child.unref()

      // 登记进全局精准进程回收器
      try {
        const { processReaper } = require('../../../main/process-reaper')
        processReaper.registerChild(child.pid, 'firefly-ai-engine', path.basename(exePath), exePath)
      } catch {}

      // 记录本次拉起的二进制签名，并开启热更新监听：
      // engine:deploy:watch 覆盖集成目录产物后据此自动重启引擎
      this.spawnedBinarySignature = this.binarySignature(exePath)
      this.lastSpawnedAt = Date.now()
      this.pendingUpdateSignature = null
      this.pendingUpdateSince = 0
      this.startDevBinaryWatch()

      child.once('error', err => {
        if (this.process !== child) {
          return
        }
        this.lastError = `引擎子进程异常: ${err.message}`
        logger.error(LogCategory.SYSTEM, '[EngineBridge] 引擎子进程异常:', err)
        this.broadcastStatus()
      })
      child.once('exit', (code, signal) => {
        // 严格身份绑定：旧子进程延迟到达的 exit 绝不允许清空新拉起的 this.process 或覆盖新状态
        if (this.process !== child) {
          return
        }
        // 区分「开发态二进制热部署的预期内退出」与真正的崩溃：
        // 部署脚本替换 exe 前会先强杀进程（退出码 -1），若按崩溃记录会让用户看到「引擎异常」，
        // 并在分析中途触发上层错误恢复（再次重启），放大成连环重启。
        const exePathNow = this.resolveEngineExecutable()
        const sigNow = exePathNow ? this.binarySignature(exePathNow) : null
        const deploying =
          this.deferredBinaryRestart ||
          this.pendingUpdateSignature !== null ||
          (sigNow !== null &&
            this.spawnedBinarySignature !== null &&
            sigNow !== this.spawnedBinarySignature)
        if (deploying) {
          logger.info(
            LogCategory.SYSTEM,
            `[EngineBridge] 引擎因二进制更新退出 (code=${code})，随后自动加载新版本`
          )
        } else {
          logger.warn(
            LogCategory.SYSTEM,
            `[EngineBridge] 引擎子进程已退出 (code=${code}, signal=${signal})`
          )
        }
        try {
          const { processReaper } = require('../../../main/process-reaper')
          processReaper.unregisterChild(child.pid)
        } catch {}
        if (child.pid) {
          const currentIdent = this.processTreeManager.currentIdentity('firefly-ai-engine')
          if (currentIdent && currentIdent.pid === child.pid) {
            this.processTreeManager.notifyProcessTreeExit(currentIdent)
            this.processTreeManager.clearIdentity('firefly-ai-engine')
          }
        }
        this.process = null
        this.applyOffline()
        // 宿主已死：在途的启动请求必然失败（连接被拒 / abort），清空在途表避免残留
        // 最长 130s（SERVICE_ACTION_TIMEOUT_MS）挡住新进程拉起后的下一次启动。
        // 串行链本身无需重置：旧请求会快速 settle 后自然排空。
        this.startServiceInFlight.clear()
        // 非预期退出（非主动停止 / 非热部署）时自愈一次。
        // 2026-10-22 事故：引擎以 0xC0000005 崩溃后无人拉起，分析队列 166 个文件
        // 全部连接被拒，直到用户手动点开引擎面板才恢复。
        void this.scheduleCrashHeal(deploying, code)
      })

      // 等待引擎就绪（支持 stdout FIREFLY_READY 即时唤醒 + /api/engine/status 兜底）
      const ready = await this.waitForReady(READY_WAIT_LIMIT_MS)
      this.isStarting = false
      // 就绪窗口结束后再做一次终确认：引擎可能在临界点刚起来，
      // 否则会出现「界面已显示状态良好 / 已连接，日志却打启动超时」
      const finalAlive = ready ? true : !!(await this.healthCheck())
      // 并发探活可能已把 lastRawStatus 置好：此时不得再回写「启动超时」污染状态
      const alreadyUp = !!this.lastRawStatus
      if (!finalAlive && !alreadyUp) {
        const msg = '萤核AI引擎启动超时，未能在规定时间内完成就绪'
        this.lastError = msg
        logger.warn(LogCategory.SYSTEM, `[EngineBridge] ${msg}`)
      } else {
        this.lastError = null
      }
      this.broadcastStatus()
      if (finalAlive || alreadyUp) {
        // 引擎已真正起来：稳定运行满 STABLE_RUN_RESET_MS 后归还崩溃自愈配额
        this.armStableReset()
        // 【核心收口】waitForReady 只保证 `/api/engine/status` 可响应，新宿主的推理服务
        // 仍是 `stopped`（target_port 为 None）。此处必须显式触发一次启动，否则
        // 「宿主起来了但模型从未启动」，所有 /v1/* 请求恒被反代拒绝为 503
        // —— 2026-10-30 事故即为此形态，持续 87 分钟直到用户手动打开引擎面板。
        this.triggerServiceStartIfNeeded(true)
      }
      return finalAlive || alreadyUp
    } catch (err) {
      this.isStarting = false
      const msg = err instanceof Error ? err.message : String(err)
      this.lastError = msg
      logger.error(LogCategory.SYSTEM, '[EngineBridge] 引擎启动失败:', err)
      this.broadcastStatus()
      return false
    }
  }

  /**
   * 唤醒源 2：监听受管子进程 stdout 输出 `FIREFLY_READY:{"port":...,"pid":...,"instanceId":"..."}`
   * 实现 <1ms 零延迟唤醒与端口切换（绕过熔断器 canExecute 门控）
   */
  private attachStdoutReadyListener(child: ChildProcess): void {
    const stdout = child.stdout
    if (!stdout) {
      return
    }
    let lineBuffer = ''
    stdout.on('data', (chunk: Buffer | string) => {
      if (this.process !== child || this.stopController.signal.aborted) {
        return
      }
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8')
      lineBuffer += text
      if (lineBuffer.length > STDOUT_BUFFER_MAX_BYTES) {
        lineBuffer = lineBuffer.slice(-STDOUT_BUFFER_MAX_BYTES)
      }
      const lines = lineBuffer.split(/\r?\n/)
      lineBuffer = lines.pop() ?? ''
      for (const line of lines) {
        const idx = line.indexOf(FIREFLY_READY_PREFIX)
        if (idx === -1) {
          continue
        }
        const jsonPart = line.slice(idx + FIREFLY_READY_PREFIX.length).trim()
        if (!jsonPart) {
          continue
        }
        try {
          const payload = JSON.parse(jsonPart) as {
            port?: unknown
            pid?: unknown
            instanceId?: unknown
            userDataDir?: unknown
          }
          const port = payload.port
          if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
            continue
          }
          if (
            typeof payload.userDataDir === 'string' &&
            !this.isSameOriginUserDataDir(payload.userDataDir)
          ) {
            logger.warn(
              LogCategory.SYSTEM,
              `[EngineBridge] 忽略跨 Worktree stdout FIREFLY_READY 帧 (${payload.userDataDir})`
            )
            continue
          }
          const pid =
            typeof payload.pid === 'number' && Number.isInteger(payload.pid) && payload.pid > 0
              ? payload.pid
              : child.pid
          const instanceId =
            typeof payload.instanceId === 'string' && payload.instanceId
              ? payload.instanceId
              : undefined
          logger.info(
            LogCategory.SYSTEM,
            `[EngineBridge] 通过 stdout FIREFLY_READY 快路径感知引擎就绪: port=${port}, pid=${pid ?? 'unknown'}`
          )
          this.activePort = port
          this.kickEventStreamReconnect({
            expectedTarget: {
              baseUrl: `http://127.0.0.1:${port}`,
              pid,
              instanceId
            },
            resetFailures: true
          })
          // 立即唤醒所有等待中的 waitForReady
          for (const resolve of this.readySignalResolvers) {
            resolve()
          }
          this.readySignalResolvers.clear()
        } catch {
          // 忽略非 JSON 格式行
        }
      }
    })
  }

  /**
   * 等待引擎 HTTP 就绪。
   *
   * **不得将启动期失败计入熔断器**：拉起后的启动窗口内探活失败是预期现象（引擎仍在初始化），
   * 若记入熔断器，3 次失败即 open，后续 canExecute()=false 会直接跳过探测，
   * 表现为「引擎明明已就绪，desktop 仍报启动超时」。这里统一走 `healthCheck({ recordFailure: false })` 裸探活。
   */
  private async waitForReady(limitMs: number): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < limitMs) {
      if (this.stopController.signal.aborted) {
        return false
      }
      // 裸探活：失败不记入熔断器，成功复位熔断器并兼容基准端口与 38400~38419 滑动端口
      const status = await this.healthCheck({ recordFailure: false })
      if (status) {
        return true
      }
      await new Promise<void>(resolve => {
        let settled = false
        const done = () => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          this.readySignalResolvers.delete(done)
          resolve()
        }
        const timer = setTimeout(done, 1200)
        this.readySignalResolvers.add(done)
      })
    }
    return false
  }

  /**
   * 打开引擎管理面板
   * @param options.panel 目标面板：error=错误分析侧边栏，logs=运行日志，models=模型列表页（下载引导流深链，见 PRD-0043），default=仅显示主窗口
   * @param options.focusModel 目标模型关键词（Issue 0046 §3）：引擎前端据此滚动聚焦并呼吸高亮对应模型行
   * @param options.source 推荐模型源（modelscope / huggingface）：引擎前端据此预选可顺畅下载的源
   */
  public async openUI(options?: {
    panel?: 'error' | 'logs' | 'models' | 'default'
    focusModel?: string
    source?: string
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      // 引擎未运行或正处于离线状态时，先平稳拉起并等待就绪，避免 fetch 直接抛错
      if (!this.lastRawStatus) {
        logger.debug(LogCategory.SYSTEM, '[EngineBridge] 打开面板前检测到引擎未运行，主动平稳拉起')
        const ok = await this.ensureRunning({ force: true })
        if (!ok) {
          return { ok: false, error: '未能成功拉起引擎服务' }
        }
      }

      // 请求 /api/engine/open-ui，增加轻量重试（最多3次，每次间隔600ms），吸收刚启动时的瞬态连接拒绝
      let lastErr: Error | null = null
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(`${this.baseUrl}${ENGINE_OPEN_UI_PATH}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              panel: options?.panel || 'default',
              ...(options?.focusModel ? { focus_model: options.focusModel } : {}),
              ...(options?.source ? { source: options.source } : {})
            }),
            signal: AbortSignal.timeout(OPEN_UI_TIMEOUT_MS)
          })
          if (res.ok) {
            return { ok: true }
          }
          lastErr = new Error(`引擎返回 ${res.status}`)
        } catch (e) {
          lastErr = e instanceof Error ? e : new Error(String(e))
        }
        await new Promise(r => setTimeout(r, 600))
      }
      const errorMsg = lastErr ? lastErr.message : '打开管理面板重试失败'
      logger.warn(LogCategory.SYSTEM, `[EngineBridge] 打开引擎管理面板失败: ${errorMsg}`)
      return { ok: false, error: errorMsg }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      logger.warn(LogCategory.SYSTEM, `[EngineBridge] 打开引擎管理面板失败: ${error}`)
      return { ok: false, error }
    }
  }

  /**
   * 探测引擎侧是否已安装指定模型（Issue 0046 §3：高维修正开关的未安装预警）。
   *
   * 引擎 `/api/models` 只返回磁盘实际扫描到的模型（`isDownloaded: true`），
   * 其 `id` 为 GGUF 文件名主干或自定义模型 id。因此以「关键词包含」做宽松匹配：
   * 任一已下载条目的 id / name / localPath / fileName 命中任一关键词即视为已安装。
   *
   * @returns reachable 表示引擎是否在线可达；未连接或请求失败时 installed 恒为 false
   */
  public async checkModelsInstalled(keywords: string[]): Promise<{
    reachable: boolean
    installed: boolean
    matched: string[]
  }> {
    const normalized = keywords.map(k => k.trim().toLowerCase()).filter(Boolean)
    if (normalized.length === 0) {
      return { reachable: false, installed: false, matched: [] }
    }

    // 第一步：通过 healthCheck 探活（内置基准端口探活 + 38400~38419 滑动端口扫描与自动绑定）
    // 确保引擎即便因端口冲突顺延绑定，也能被正确识别为在线并校准 this.activePort
    let reachable = false
    try {
      const status = await this.healthCheck()
      if (status !== null) {
        reachable = true
      } else if (this.getSnapshot().connected === true) {
        reachable = true
      } else {
        // 兜底再次扫描滑动区间
        reachable = await this.adoptRunningEnginePort()
      }
    } catch {
      reachable = this.getSnapshot().connected === true
    }

    if (!reachable) {
      return { reachable: false, installed: false, matched: [] }
    }

    // 第二步：引擎已确认在线，拉取模型列表并匹配关键词
    try {
      const res = await fetch(`${this.baseUrl}${ENGINE_MODELS_PATH}`, {
        method: 'GET',
        signal: AbortSignal.timeout(8000)
      })
      if (!res.ok) {
        // 引擎可达但端点返回非 2xx（如 500/404），判定为「引擎已运行，但模型未安装/不可用」
        return { reachable: true, installed: false, matched: [] }
      }
      const list = (await res.json()) as Array<Record<string, unknown>>
      if (!Array.isArray(list)) {
        return { reachable: true, installed: false, matched: [] }
      }
      const matched: string[] = []
      for (const item of list) {
        if (item?.isDownloaded !== true) continue
        const haystack = [
          item.id,
          item.name,
          item.localPath,
          item.fileName,
          item.author,
          item.downloadId
        ]
          .filter(v => typeof v === 'string')
          .join(' ')
          .toLowerCase()
        if (!haystack) continue
        const hit = normalized.find(k => haystack.includes(k))
        if (hit && !matched.includes(hit)) {
          matched.push(hit)
        }
      }
      return { reachable: true, installed: matched.length > 0, matched }
    } catch (err) {
      // /api/models 超时或失败，但引擎已确认在线，判定为「引擎已运行，但尚未安装该模型」
      logger.debug(LogCategory.SYSTEM, '[EngineBridge] 拉取 /api/models 失败（引擎已在线）:', err)
      return { reachable: true, installed: false, matched: [] }
    }
  }

  /**
   * 请求引擎优雅退出（不影响引擎管理面板自启），随后清理自己拉起的进程
   */
  public async shutdown(): Promise<{ ok: boolean }> {
    // 用户显式停用引擎：撤销待执行的崩溃自愈，避免 8s 后被自己重新拉起
    if (this.autoHealTimer) {
      clearTimeout(this.autoHealTimer)
      this.autoHealTimer = null
    }
    if (this.stableResetTimer) {
      clearTimeout(this.stableResetTimer)
      this.stableResetTimer = null
    }
    this.autoHealAttempts = 0
    const tryPorts = [this.activePort]
    if (this.activePort !== TIER2_ENGINE_PORT) {
      tryPorts.push(TIER2_ENGINE_PORT)
    }
    for (const port of tryPorts) {
      try {
        await fetch(`http://127.0.0.1:${port}${ENGINE_SHUTDOWN_PATH}`, {
          method: 'POST',
          signal: AbortSignal.timeout(SHUTDOWN_TIMEOUT_MS)
        })
      } catch (err) {
        // 引擎可能已下线或未运行，属可容忍降级；仍记 debug 便于排查优雅退出是否真正送达
        logger.debug(LogCategory.SYSTEM, `[EngineBridge] shutdown 请求未送达端口 ${port}:`, err)
      }
    }
    this.killOwnProcess()
    // 注意：这里曾经有一段 `taskkill /F /T /IM firefly-ai-engine.exe` 的兜底。
    // 它按镜像名击杀本机**所有**同名引擎，包括其他 worktree 实例正在使用的，
    // 与「杜绝跨 worktree 误杀」直接冲突，且绕过了 ProcessReaper 的 PID 身份校验。
    // killOwnProcess() 已经按本实例持有的 pid 做 /T /F，足够覆盖自拉起场景；
    // 若引擎是外部复用（非本实例拉起），本就不该由这里强杀。
    // 引擎已请求退出，端口复位到基准值，下次拉起按默认端口协商
    this.activePort = TIER2_ENGINE_PORT
    this.applyOffline()
    return { ok: true }
  }

  /**
   * 读取引擎全局思考模式（GET /api/engine/thinking）
   */
  public async getThinkingMode(): Promise<{
    ok: boolean
    enableThinking?: boolean
    error?: string
  }> {
    try {
      const res = await fetch(`${this.baseUrl}${ENGINE_THINKING_PATH}`, {
        method: 'GET',
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS)
      })
      const body = (await res.json().catch(() => ({}))) as { enableThinking?: boolean }
      if (!res.ok) {
        return { ok: false, error: `引擎返回 ${res.status}` }
      }
      return { ok: true, enableThinking: Boolean(body.enableThinking) }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      return { ok: false, error }
    }
  }

  /**
   * 写入引擎全局思考模式（POST /api/engine/thinking，持久化至引擎 config.json）
   * 下次 startService 拉起 llama-server 时按该值注入思考/抑制参数
   */
  public async setThinkingMode(enableThinking: boolean): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}${ENGINE_THINKING_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enableThinking }),
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS)
      })
      const body = (await res.json().catch(() => ({}))) as {
        success?: boolean
        enableThinking?: boolean
        error?: string
      }
      const ok = res.ok && body.success !== false
      if (ok) {
        this.lastSyncedThinking = enableThinking
        logger.debug(
          LogCategory.SYSTEM,
          `[EngineBridge] 已同步思考模式至引擎: enable_thinking=${enableThinking}`
        )
      } else {
        logger.warn(
          LogCategory.SYSTEM,
          `[EngineBridge] 同步思考模式至引擎失败: ${body.error || res.status}`
        )
      }
      return { ok, error: ok ? undefined : body.error || `引擎返回 ${res.status}` }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      logger.warn(LogCategory.SYSTEM, `[EngineBridge] 同步思考模式请求失败: ${error}`)
      return { ok: false, error }
    }
  }

  /**
   * 从引擎拉取思考模式并回写桌面 ENABLE_THINKING_MODE（引擎 UI 变更感知）
   *
   * 请求级思考开关（http-client）与 Footer 展示均读 ENABLE_THINKING_MODE，
   * 本地分析要真正吃到引擎思考能力，必须与引擎 config.json 的 enable_thinking 对齐。
   */
  public async syncThinkingModeFromEngine(): Promise<void> {
    if (this.thinkingSyncPromise) {
      return this.thinkingSyncPromise
    }
    this.thinkingSyncPromise = this.doSyncThinkingModeFromEngine().finally(() => {
      this.thinkingSyncPromise = null
    })
    return this.thinkingSyncPromise
  }

  private async doSyncThinkingModeFromEngine(): Promise<void> {
    try {
      const orchestrator = ConfigOrchestrator.getInstance()
      // 云端/禁用模式不覆盖桌面思考开关（该键同时是云端请求级开关；本地才以引擎 CLI 为权威）
      const mode = orchestrator.getValue<string>('AI_SERVICE_MODE') || 'local'
      if (mode !== 'local') {
        return
      }

      const result = await this.getThinkingMode()
      if (!result.ok || typeof result.enableThinking !== 'boolean') {
        return
      }
      const engineValue = result.enableThinking
      this.lastSyncedThinking = engineValue

      const desktopValue = Boolean(orchestrator.getValue<boolean>('ENABLE_THINKING_MODE'))
      if (desktopValue !== engineValue) {
        // preventAutoReload: false —— 需触发 AIService 重载，使 http-client 请求级思考参数即时生效
        await orchestrator.updateValue('ENABLE_THINKING_MODE', engineValue, {
          source: 'runtime',
          preventAutoReload: false
        })
        logger.debug(
          LogCategory.SYSTEM,
          `[EngineBridge] 已从引擎同步思考模式至桌面: ENABLE_THINKING_MODE=${engineValue}（原值 ${desktopValue}）`
        )
        this.broadcastStatus()
      }
    } catch (err) {
      logger.debug(LogCategory.SYSTEM, '[EngineBridge] 同步引擎思考模式失败（可容忍）:', err)
    }
  }

  /**
   * 启动引擎侧 AI 推理服务（llama.cpp 子进程），不退出引擎应用本身
   * 对应引擎端 POST /api/engine/start
   *
   * 并发语义（两层，缺一不可）：
   * - **同意图合并**：同一 `mode|modelId` 的并发调用共享同一个 Promise，避免重复下发；
   * - **跨意图串行**：不同意图排队执行，绝不并发。并发会让引擎侧 `start_engine_service`
   *   在 `Starting` 态直接覆写 `active_model` 后调用 `start_service`，而后者因 `Starting`
   *   早返回成功 ⇒ 返回「启动成功」但实际加载的仍是上一个模型，随后
   *   `waitForServiceReady` 必然超时。
   */
  public async startService(options?: {
    mode?: 'language' | 'embedding'
    modelId?: string
  }): Promise<{ ok: boolean; code?: string; canDegrade?: boolean; error?: string }> {
    const key = `${options?.mode ?? 'auto'}|${options?.modelId ?? ''}`

    const existing = this.startServiceInFlight.get(key)
    if (existing) {
      return existing
    }

    const task = this.startServiceChain.then(() => this.doStartService(options))
    // 链上吞掉 Reject：否则一次启动失败会毒化整条串行链，后续请求永久拒绝
    this.startServiceChain = task.then(
      () => undefined,
      () => undefined
    )
    this.startServiceInFlight.set(key, task)
    void task
      .finally(() => {
        // 身份校验：旧 Promise settle 晚于 clear 时不得误删新条目
        if (this.startServiceInFlight.get(key) === task) {
          this.startServiceInFlight.delete(key)
        }
      })
      .catch(() => {})
    return task
  }

  /** `startService` 的实际实现；错误由调用方统一处理 */
  private async doStartService(options?: {
    mode?: 'language' | 'embedding'
    modelId?: string
  }): Promise<{ ok: boolean; code?: string; canDegrade?: boolean; error?: string }> {
    // 启动前对齐思考模式：CLI 启动参数以引擎 config.json 为准，先拉回桌面保证请求级一致；
    // 若桌面配置与引擎不一致且桌面是用户刚改过的，setThinkingMode 路径会在配置变更时已推送。
    await this.syncThinkingModeFromEngine()
    try {
      const res = await fetch(`${this.baseUrl}${ENGINE_SERVICE_START_PATH}`, {
        method: 'POST',
        headers: options ? { 'Content-Type': 'application/json' } : undefined,
        body: options ? JSON.stringify(options) : undefined,
        signal: AbortSignal.timeout(SERVICE_ACTION_TIMEOUT_MS)
      })
      const body = (await res.json().catch(() => ({}))) as {
        success?: boolean
        code?: string
        error?: string
      }
      const ok = res.ok && body.success !== false
      if (!ok) {
        if (res.status === 422 || body.code === 'no_engine_installed') {
          this.hasInstalledEngines = false
          logger.info(
            LogCategory.SYSTEM,
            `[EngineBridge] 引擎未安装或无兼容硬件引擎包，切换至未安装降级待命态: ${body.error || 'no_engine_installed'}`
          )
          return {
            ok: false,
            code: 'no_engine_installed',
            canDegrade: true,
            error: body.error || '未安装本地推理引擎，将由基础引擎保底'
          }
        }
        logger.warn(
          LogCategory.SYSTEM,
          `[EngineBridge] 启动 AI 服务失败: ${body.error || res.status}`
        )
      } else {
        this.hasInstalledEngines = true
      }
      return { ok, error: ok ? undefined : body.error || `引擎返回 ${res.status}` }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      logger.warn(LogCategory.SYSTEM, `[EngineBridge] 启动 AI 服务请求失败: ${error}`)
      return { ok: false, error }
    }
  }

  /**
   * 订阅 Single-Flight 共享体自身的启动失败终态事件（单向依赖，供上层如 AIServiceManager 记账冷却）。
   * 仅在共享体自身以失败终态结束时触发一次（含孤儿共享体终态）；
   * 单个调用方自身的短超时或 Abort 绝不触发本事件。
   */
  public onEnsureFailed(fn: (mode: EngineTargetMode, res: EnsureReadyResult) => void): () => void {
    this.ensureFailedListeners.add(fn)
    return () => {
      this.ensureFailedListeners.delete(fn)
    }
  }

  /** 广播共享体失败终态给所有订阅者 */
  private emitEnsureFailed(mode: EngineTargetMode, res: EnsureReadyResult): void {
    for (const listener of this.ensureFailedListeners) {
      try {
        listener(mode, res)
      } catch (err) {
        logger.warn(LogCategory.SYSTEM, '[EngineBridge] onEnsureFailed 订阅回调异常:', err)
      }
    }
  }

  /**
   * Single-Flight 统一拉起并等待引擎进入目标意图模式就绪（零轮询 SSE 反应式屏障）。
   *
   * - 按 `mode` 复用共享在途 Promise（共享体自带 120s 硬上限，不绑定任何单个调用方的 AbortSignal 或短预算）；
   * - `force: true` 不合并进在途非 force 调用，待在途结束后重发；
   * - 每个调用方独立竞争自身 `timeoutMs` 与 `signal`，超时/取消绝不中止共享体，也绝不触发 `onEnsureFailed`；
   * - 仅共享体自身失败终态（含孤儿共享体终态）触发一次 `onEnsureFailed` 与共享体级 warn。
   */
  public async ensureReady(options: EnsureReadyOptions): Promise<EnsureReadyResult> {
    const {
      mode,
      timeoutMs: callerTimeoutMs = SHARED_STARTUP_HARD_TIMEOUT_MS,
      signal,
      force = false
    } = options

    if (signal?.aborted) {
      throw createAbortError()
    }

    const deadline = Date.now() + Math.max(0, callerTimeoutMs)

    // force: true 不合并进在途非 force 调用：等待在途结束后再重发，防止强制重启/换模型被吞
    while (force) {
      const existing = this.inFlightEnsureByMode.get(mode)
      if (!existing || existing.force) {
        break
      }
      const waitRemaining = deadline - Date.now()
      if (waitRemaining <= 0) {
        return {
          ok: false,
          code: 'caller_timeout',
          error: `等待引擎切换至 ${
            mode === 'embedding' ? 'WeMM 嵌入' : '主语言'
          } 模型就绪超时（${Math.round(callerTimeoutMs / 1000)}s）`
        }
      }
      const waitRes = await this.raceCallerWithShared(existing.promise, mode, waitRemaining, signal)
      if (waitRes.code === 'caller_timeout') {
        return waitRes
      }
    }

    if (signal?.aborted) {
      throw createAbortError()
    }

    let entry = this.inFlightEnsureByMode.get(mode)
    if (!entry) {
      const sharedPromise = this.runSharedEnsureReady(mode, force)
      entry = { promise: sharedPromise, force }
      this.inFlightEnsureByMode.set(mode, entry)
      void sharedPromise
        .finally(() => {
          // 身份校验：仅删除与自身一致的在途条目
          if (this.inFlightEnsureByMode.get(mode)?.promise === sharedPromise) {
            this.inFlightEnsureByMode.delete(mode)
          }
        })
        .catch(() => {})
    }

    const remainingMs = Math.max(0, deadline - Date.now())
    return this.raceCallerWithShared(entry.promise, mode, remainingMs, signal)
  }

  /**
   * 共享启动体实现：自带 `SHARED_STARTUP_HARD_TIMEOUT_MS`（120s）硬上限，与调用方预算完全解耦。
   * 仅在本方法产出失败终态时输出共享体级 warn 并触发一次 `emitEnsureFailed`。
   */
  private async runSharedEnsureReady(
    mode: EngineTargetMode,
    force: boolean
  ): Promise<EnsureReadyResult> {
    const running = await this.ensureRunning({ mode, force })
    if (!running) {
      const res: EnsureReadyResult = {
        ok: false,
        code: 'host_start_failed',
        error: 'AI引擎未运行且拉起失败'
      }
      logger.warn(
        LogCategory.SYSTEM,
        `[EngineBridge] 引擎推理服务拉起失败（模式: ${mode}, code=${res.code}）: ${res.error}`
      )
      this.emitEnsureFailed(mode, res)
      return res
    }

    let snap = this.getSnapshot()
    if (
      !force &&
      snap.connected &&
      (snap.raw?.status === 'ready' || snap.raw?.status === 'processing') &&
      matchesEngineTargetMode(snap.raw, mode)
    ) {
      return { ok: true }
    }

    if (!snap.connected || !snap.raw) {
      await this.healthCheck()
      snap = this.getSnapshot()
      if (
        !force &&
        snap.connected &&
        (snap.raw?.status === 'ready' || snap.raw?.status === 'processing') &&
        matchesEngineTargetMode(snap.raw, mode)
      ) {
        return { ok: true }
      }
    }

    const baselineRevision = snap.raw?.revision ?? 0
    const baselineInstanceId = snap.raw?.instance_id

    const needKick =
      force || snap.raw?.status !== 'starting' || !matchesEngineTargetMode(snap.raw, mode)
    if (needKick) {
      const startRes = await this.startService({ mode })
      if (!startRes.ok) {
        logger.warn(
          LogCategory.SYSTEM,
          `[EngineBridge] 启动推理服务指令失败（模式: ${mode}, code=${startRes.code ?? 'start_failed'}）: ${startRes.error ?? ''}`
        )
        this.emitEnsureFailed(mode, startRes)
        return startRes
      }
    }

    const res = await waitForEngineStatusReactive({
      subscribe: fn => this.subscribe(fn),
      getSnapshot: () => this.getSnapshot(),
      isAutoHealing: () => this.isAutoHealing(),
      isCrashHealExhausted: () => this.isCrashHealExhaustedAndOffline(),
      mode,
      baselineRevision,
      baselineInstanceId,
      timeoutMs: SHARED_STARTUP_HARD_TIMEOUT_MS
    })

    if (res.ok) {
      logger.info(LogCategory.SYSTEM, `[EngineBridge] 引擎推理服务已就绪（模式: ${mode}）`)
      return res
    }

    logger.warn(
      LogCategory.SYSTEM,
      `[EngineBridge] 引擎推理服务拉起失败（模式: ${mode}, code=${res.code ?? 'unknown'}）: ${res.error ?? ''}`
    )
    this.emitEnsureFailed(mode, res)
    return res
  }

  /**
   * 调用方独立竞争：在共享体、自身超时、自身 AbortSignal 之间取最快结束项，
   * 并在任一路径结束后立刻清理调用方自身定时器与 abort 监听（绝不中止共享体）。
   */
  private raceCallerWithShared(
    sharedPromise: Promise<EnsureReadyResult>,
    mode: EngineTargetMode,
    callerTimeoutMs: number,
    signal?: AbortSignal
  ): Promise<EnsureReadyResult> {
    if (signal?.aborted) {
      return Promise.reject(createAbortError())
    }

    return new Promise<EnsureReadyResult>((resolve, reject) => {
      let settled = false
      let ownTimer: ReturnType<typeof setTimeout> | null = null

      const cleanup = () => {
        if (ownTimer !== null) {
          clearTimeout(ownTimer)
          ownTimer = null
        }
        if (signal) {
          signal.removeEventListener('abort', onAbort)
        }
      }

      const onAbort = () => {
        if (settled) return
        settled = true
        cleanup()
        reject(createAbortError())
      }

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true })
      }

      if (callerTimeoutMs < SHARED_STARTUP_HARD_TIMEOUT_MS) {
        const safeMs = Math.max(0, callerTimeoutMs)
        ownTimer = setTimeout(() => {
          ownTimer = null
          if (settled) return
          settled = true
          cleanup()
          resolve({
            ok: false,
            code: 'caller_timeout',
            error: `等待引擎切换至 ${
              mode === 'embedding' ? 'WeMM 嵌入' : '主语言'
            } 模型就绪超时（${Math.round(safeMs / 1000)}s）`
          })
        }, safeMs)
      }

      sharedPromise.then(
        res => {
          if (settled) return
          settled = true
          cleanup()
          resolve(res)
        },
        err => {
          if (settled) return
          settled = true
          cleanup()
          reject(err)
        }
      )
    })
  }

  /**
   * 确保引擎以指定的意图模式运行（'language' | 'embedding'）
   * - 'language'：主语言模型模式（用于文件分析、文本分类）
   * - 'embedding'：多模态嵌入模式（用于 Stage 5 高维修正 WeMM 向量嵌入）
   * 向下兼容壳（默认 timeoutMs = 45_000），内部统一委托零轮询 Single-Flight `ensureReady`。
   */
  public async ensureMode(
    mode: 'language' | 'embedding',
    options?: { force?: boolean; timeoutMs?: number; signal?: AbortSignal }
  ): Promise<EnsureReadyResult> {
    return this.ensureReady({
      mode,
      force: options?.force,
      timeoutMs: options?.timeoutMs ?? DEFAULT_ENSURE_MODE_TIMEOUT_MS,
      signal: options?.signal
    })
  }

  /**
   * 停止引擎侧 AI 推理服务（llama.cpp 子进程），不退出引擎应用本身
   * 对应引擎端 POST /api/engine/stop
   */
  public async stopService(): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}${ENGINE_SERVICE_STOP_PATH}`, {
        method: 'POST',
        signal: AbortSignal.timeout(SERVICE_ACTION_TIMEOUT_MS)
      })
      const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string }
      const ok = res.ok && body.success !== false
      if (!ok) {
        logger.warn(
          LogCategory.SYSTEM,
          `[EngineBridge] 停止 AI 服务失败: ${body.error || res.status}`
        )
      }
      return { ok, error: ok ? undefined : body.error || `引擎返回 ${res.status}` }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      logger.warn(LogCategory.SYSTEM, `[EngineBridge] 停止 AI 服务请求失败: ${error}`)
      return { ok: false, error }
    }
  }

  /**
   * 切换引擎计算后端（PRD-0049：引擎激活单一化）。
   * 对应引擎端 POST /api/engine/switch：写入 preferred_backend 并清除 active_engine，
   * 需随后调用 startService/stopService 重启推理服务后生效。
   * @param backend 目标后端（cuda / cuda134 / vulkan / cpu 等，与引擎列表 id/backend 一致）
   */
  public async switchBackend(backend: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const res = await fetch(`${this.baseUrl}${ENGINE_SWITCH_PATH}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backend }),
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS)
      })
      const body = (await res.json().catch(() => ({}))) as {
        success?: boolean
        error?: string
        message?: string
      }
      const ok = res.ok && body.success !== false
      if (!ok) {
        logger.warn(
          LogCategory.SYSTEM,
          `[EngineBridge] 切换后端 ${backend} 失败: ${body.error || res.status}`
        )
      } else {
        logger.debug(
          LogCategory.SYSTEM,
          `[EngineBridge] 已请求切换后端至 ${backend}（重启服务后生效）`
        )
      }
      return { ok, error: ok ? undefined : body.error || `引擎返回 ${res.status}` }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      logger.warn(LogCategory.SYSTEM, `[EngineBridge] 切换后端请求失败: ${error}`)
      return { ok: false, error }
    }
  }

  /**
   * 引擎非预期退出后的自愈调度（2026-10-22 事故修复）
   *
   * 策略见 `crash-heal-policy.ts`：只治愈一次、留出间隔让崩溃残留条件（显存/端口/句柄）
   * 释放，主动 kill / 热部署 / 引擎已禁用一律不自愈。
   * **自愈失败不重试** —— 队列按既有 failed 路径处理，CPU 阶段（stage 1/2）产物不受影响。
   */
  private async scheduleCrashHeal(deploying: boolean, exitCode: number | null): Promise<void> {
    // 已有待执行的自愈：同一次崩溃的重复 exit 事件不重复安排
    if (this.autoHealTimer) {
      return
    }

    let shouldRun = false
    try {
      shouldRun = await this.shouldEngineRun()
    } catch {
      // 配置读取失败按「不应运行」处理：宁可不起，也不要在云端/禁用模式下擅自拉起本地引擎
      shouldRun = false
    }

    const decision = decideCrashHeal({
      msSinceSelfKill: this.lastSelfKillAt > 0 ? Date.now() - this.lastSelfKillAt : null,
      deploying,
      attempts: this.autoHealAttempts,
      shouldRun
    })

    if (!decision.heal) {
      logger.debug(
        LogCategory.SYSTEM,
        `[EngineBridge] 引擎退出后不自愈（${decision.reason}，code=${exitCode}）`
      )
      return
    }

    this.autoHealAttempts = decision.nextAttempts
    logger.warn(
      LogCategory.SYSTEM,
      `[EngineBridge] 引擎非预期退出 (code=${exitCode})，${decision.delayMs}ms 后自动治愈一次`
    )

    this.autoHealTimer = setTimeout(() => {
      this.autoHealTimer = null
      void this.runCrashHeal()
    }, decision.delayMs)
    // 不因自愈定时器阻止应用退出
    this.autoHealTimer.unref?.()
  }

  /** 执行一次崩溃自愈（force 拉起会复位熔断器，避免冷却期把恢复路径拦住） */
  private async runCrashHeal(): Promise<void> {
    this.isRunningCrashHeal = true
    try {
      // 延迟窗口内用户可能已停用高级引擎或切到云端：执行前必须重新确认意图。
      // ensureRunning({force:true}) 会跳过 shouldEngineRun 检查，故这里必须自己拦一道。
      if (!(await this.shouldEngineRun())) {
        logger.debug(
          LogCategory.SYSTEM,
          '[EngineBridge] 崩溃自愈取消：当前已停用高级AI引擎或切至云端模式'
        )
        return
      }
      const ok = await this.ensureRunning({ force: true })
      if (ok) {
        logger.info(LogCategory.SYSTEM, '[EngineBridge] 崩溃自愈成功，引擎已重新拉起')
      } else {
        logger.warn(
          LogCategory.SYSTEM,
          '[EngineBridge] 崩溃自愈失败，本次不再重试；分析队列按既有失败路径处理（CPU 阶段产物不受影响）'
        )
      }
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[EngineBridge] 崩溃自愈异常，本次不再重试:', err)
    } finally {
      this.isRunningCrashHeal = false
      this.broadcastStatus()
    }
  }

  /**
   * 引擎稳定运行满 STABLE_RUN_RESET_MS 后归还自愈配额。
   * 只有真正存活满 1 分钟才算这次自愈成功，防止「崩→重启→再崩」被无限循环拉起。
   */
  private armStableReset(): void {
    if (this.stableResetTimer) {
      clearTimeout(this.stableResetTimer)
    }
    this.stableResetTimer = setTimeout(() => {
      this.stableResetTimer = null
      this.autoHealAttempts = 0
    }, STABLE_RUN_RESET_MS)
    this.stableResetTimer.unref?.()
  }

  /**
   * 强制清理由本服务拉起的子进程（taskkill 兜底，Unix 走 SIGKILL）
   */
  private killOwnProcess(): void {
    const proc = this.process
    this.process = null
    // 主动 kill 标记：抑制窗口内到达的 exit 事件不得触发崩溃自愈。
    // 覆盖「用户停止服务 / 切换引擎 / 退出应用 / 二进制热部署」四类主动退出。
    this.lastSelfKillAt = Date.now()
    // 宿主即将消失：清空在途启动表，避免旧请求残留挡住新进程拉起后的下一次启动。
    // 串行链本身不重置——旧请求会因连接被拒快速 settle 后自然排空。
    this.startServiceInFlight.clear()
    if (!proc || proc.killed) {
      return
    }
    try {
      if (process.platform === 'win32' && proc.pid) {
        // windowsHide: 抑制 taskkill 控制台窗口闪烁
        execSync(`taskkill /pid ${proc.pid} /T /F`, { stdio: 'ignore', windowsHide: true })
      } else {
        proc.kill('SIGKILL')
      }
    } catch (err) {
      // kill 失败常见于进程已自行退出；仍记日志以便发现残留进程
      logger.debug(LogCategory.SYSTEM, '[EngineBridge] 回收自拉起引擎进程失败（可能已退出）:', err)
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
   * 组装统一引擎运行时指标段
   */
  private buildRuntimeMetricsSnapshotSection(): {
    metrics: EngineMetricsSnapshot | null
    metricsUpdatedAt: number | null
  } {
    return {
      metrics: this.latestMetrics,
      metricsUpdatedAt: this.latestMetricsUpdatedAt
    }
  }

  /**
   * 组装生命周期与模型状态扩展段
   */
  private buildLifecycleAndModelSnapshotSection(): {
    activeModel: string | null
    activeMmproj: string | null
    isDSparkActive: boolean
  } {
    const raw = this.lastRawStatus
    const pair = this.resolveDisplayModelPair()
    return {
      activeModel: pair.modelName || pair.model,
      activeMmproj: (raw as any)?.active_mmproj || null,
      isDSparkActive: this.isDSparkActive()
    }
  }

  /**
   * 组装对外状态快照
   */
  public getSnapshot(): EngineBridgeSnapshot {
    const raw = this.lastRawStatus
    const exePath = this.resolveEngineExecutable()
    return {
      connected: !!raw,
      // 托管标记：外部手动启动的引擎同样 connected，但它没有 exit 处理器，
      // 被杀后既无崩溃自愈也无重新拉起，验收脚本需据此排除该场景
      managed: this.process !== null,
      circuitState: this.circuitBreaker.getState(),
      available: exePath !== null,
      exePath,
      devMode: this.isDevMode(),
      port: this.activePort,
      version: raw?.version || this.versionCache || null,
      backend: raw?.active_backend || raw?.backend || null,
      backendMatchType: raw ? this.lastBackendMatchType : null,
      // 激活模型推导（对齐引擎 resolveDisplayModel 权威优先级：
      // 运行模型（仅 ready/starting）-> 激活语言槽位 -> 激活嵌入槽位 -> 兜底），
      // 避免引擎切换到嵌入模型（WeMM）时 desktop Footer 滞留陈旧语言模型名称
      ...this.resolveDisplayModelPair(),
      // 引擎契约字段为 vram_usage_mb（兼容旧 vram_mb / gpu_mem_mb）
      vramMb:
        typeof raw?.vram_usage_mb === 'number'
          ? raw.vram_usage_mb
          : typeof raw?.vram_mb === 'number'
            ? raw.vram_mb
            : typeof raw?.gpu_mem_mb === 'number'
              ? raw.gpu_mem_mb
              : null,
      modelCount: raw ? this.lastModelCount : null,
      totalModelCount: raw ? this.lastTotalModelCount : null,
      lastError: this.lastError,
      updatedAt: raw ? Date.now() : null,
      raw,
      ...this.buildRuntimeMetricsSnapshotSection(),
      ...this.buildLifecycleAndModelSnapshotSection()
    }
  }

  /**
   * 引擎实际加载的上下文窗口（tokens），即 llama-server 真正的 `--ctx-size`
   *
   * 这是**唯一可信的上下文预算上限**：模型目录里的 `recommendedConfig.numCtx`
   * 只是静态推荐值，引擎侧 `ParamBuilder` 会按显存/内存预算把它夹到实际可加载的值
   * （事故：推荐 8192，实际 2048，桌面端按 8192 规划提示词 → 引擎 400
   *  `request (2469 tokens) exceeds the available context size (2048 tokens)`）。
   *
   * 引擎未启动、未加载模型或旧版本未上报 `runtime_params` 时返回 null，
   * 调用方应保持既有兜底行为（不得凭空放大预算）。
   */
  public getRuntimeContextSize(): number | null {
    const runtimeParams = this.lastRawStatus?.runtime_params as { ctx_size?: unknown } | undefined
    const ctxSize = runtimeParams?.ctx_size
    if (typeof ctxSize !== 'number' || !Number.isFinite(ctxSize) || ctxSize <= 0) {
      return null
    }
    return Math.floor(ctxSize)
  }

  /**
   * 判断当前引擎或主模型是否激活了 DSpark / 草稿投机采样加速
   */
  public isDSparkActive(): boolean {
    return EngineModelCatalogResolver.isDSparkActive(this.lastRawStatus)
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
    try {
      if (
        typeof BrowserWindow !== 'undefined' &&
        typeof BrowserWindow?.getAllWindows === 'function'
      ) {
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.send('tier2:status-changed', snapshot)
          }
        }
      }
    } catch (err) {
      logger.warn(LogCategory.SYSTEM, '[EngineBridge] 向渲染窗口广播状态失败:', err)
    }
  }

  /**
   * 停止服务同步前置段（供 stop() 与 SIGINT/SIGTERM stopSyncForSignal() 共同复用）：
   * ① 首步局部捕获 childPid 与 lastInstanceId（严禁清空 connectedTarget 后再读）
   * ② 置 isStopping = true
   * ③ 递增 ++stopEpoch 且 ++connectionEpoch
   * ④ abort stopController
   * ⑤ 关闭 DirWatcher 订阅
   * ⑥ 中断客户端 SSE 流（先于关子进程，配合服务端 CancellationToken 双重防挂死）
   * ⑦ 中断退避 sleep
   * ⑧ 清空 activeLoopEpoch 与 connectedTarget
   */
  private beginStopSync(): {
    childPid: number | undefined
    lastInstanceId: string | undefined
    proc: ChildProcess | null
  } {
    const proc = this.process
    const childPid = proc?.pid
    const lastInstanceId = this.connectedTarget?.instanceId

    this.isStopping = true
    this.stopEpoch++
    this.connectionEpoch++
    if (!this.stopController.signal.aborted) {
      this.stopController.abort()
    }
    this.disarmDiscoveryWatcher()
    if (this.eventStreamAbortController) {
      this.eventStreamAbortController.abort()
      this.eventStreamAbortController = null
    }
    if (this.reconnectAbortController) {
      this.reconnectAbortController.abort()
      this.reconnectAbortController = null
    }
    this.activeLoopEpoch = null
    this.connectedTarget = null
    for (const resolve of this.readySignalResolvers) {
      resolve()
    }
    this.readySignalResolvers.clear()

    // 联动模型置换门闩：主动停止时取消所有等待中的置换请求
    engineSwappingCoordinator.abortSwapping({
      kind: 'cancelled',
      code: 'engine_cancelled',
      message: 'AI engine intentionally stopped by user'
    })
    // 主动停止：撤销待执行的崩溃自愈与配额重置，避免「停用后又被自己拉起来」
    if (this.autoHealTimer) {
      clearTimeout(this.autoHealTimer)
      this.autoHealTimer = null
    }
    if (this.stableResetTimer) {
      clearTimeout(this.stableResetTimer)
      this.stableResetTimer = null
    }
    this.autoHealAttempts = 0
    this.stopDevBinaryWatch()
    return { childPid, lastInstanceId, proc }
  }

  private resetStateAfterStop(): void {
    this.activePort = TIER2_ENGINE_PORT
    this.spawnedBinarySignature = null
    this.lastRawStatus = null
    this.latestMetrics = null
    this.latestMetricsUpdatedAt = null
    this.lastModelCount = null
    this.lastBackendMatchType = null
    this.lastSyncedThinking = null
    // 清空模型元数据缓存，避免跨会话/测试复用陈旧目录
    this.modelMetaCache = null
    this.builtinModelCatalog = null
    this.downloadedModelCatalog = []
    this.lastModelNameMap.clear()
    this.firstDownloadedModel = null
    this.lastKnownModel = null
    this.modelCountPromise = null
    // 重置节流状态：下次拉起引擎后必须立即重扫，不能沿用停止前的 TTL 窗口
    this.lastModelCountFetchAt = 0
    this.lastModelCountFetchOk = false
    this.consecutiveFailures = 0
    this.lastAppliedRevision = 0
    this.lastAppliedInstanceId = null
    this.circuitBreaker.reset()
  }

  /**
   * 进程收到 SIGINT/SIGTERM/exit 时的同步退场路径（复用 stop 同步段 + 同步撤销发现文件）
   */
  public stopSyncForSignal(): void {
    const { childPid, lastInstanceId } = this.beginStopSync()
    this.killOwnProcess()
    if (childPid) {
      this.discoveryFile.revokeSync({ pid: childPid, instanceId: lastInstanceId })
    }
    this.resetStateAfterStop()
    this.isStopping = false
  }

  /**
   * 停止服务（异步可重入闭环，Spec §2.1 机制 5）：
   * 同步段切断所有 SSE / watcher / 定时器并捕获 childPid + lastInstanceId；
   * 异步段等待受管子进程退出（带 bounded 超时强杀）并安全撤销发现文件，随后复位 isStopping。
   */
  public async stop(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise
    }

    const { childPid, lastInstanceId, proc } = this.beginStopSync()
    // 显式保留在 stop() 主体内，便于静态契约护栏验证（实际清理由 beginStopSync 已执行）
    if (this.autoHealTimer) {
      clearTimeout(this.autoHealTimer)
      this.autoHealTimer = null
    }
    this.autoHealAttempts = 0

    const runAsyncStop = async () => {
      try {
        if (proc && !proc.killed && proc.exitCode === null) {
          // 先关闭 stdin 管道触发引擎优雅退出，等待有界超时后强杀
          try {
            proc.stdin?.end()
          } catch {
            // 忽略 stdin 已关闭
          }
          const exitedGracefully = await new Promise<boolean>(resolve => {
            let settled = false
            const done = (ok: boolean) => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              proc.off('exit', onExit)
              resolve(ok)
            }
            const onExit = () => done(true)
            const timer = setTimeout(() => done(false), STOP_CHILD_EXIT_WAIT_MS)
            proc.once('exit', onExit)
          })
          if (!exitedGracefully) {
            this.killOwnProcess()
          } else {
            // 进程已优雅退出，仍需更新主动 kill 标记与清理在途表
            if (this.process === proc) {
              this.process = null
            }
            this.lastSelfKillAt = Date.now()
            this.startServiceInFlight.clear()
          }
        } else {
          this.killOwnProcess()
        }

        if (childPid) {
          await this.discoveryFile.revoke({ pid: childPid, instanceId: lastInstanceId })
        }
        this.resetStateAfterStop()
      } finally {
        this.isStopping = false
        this.stopPromise = null
      }
    }

    this.stopPromise = runAsyncStop()
    return this.stopPromise
  }

  // ==========================================
  // 操作系统进程树管理与代际控制原语 (Ticket 02)
  // ==========================================

  /** 采样当前子进程树身份（pid + 创建时间 + 平台 JobObject/PGID 句柄），无进程时返回 undefined */
  public currentIdentity(targetId: string = 'firefly-ai-engine'): ProcessTreeIdentity | undefined {
    let identity = this.processTreeManager.currentIdentity(targetId)
    if (!identity && targetId === 'firefly-ai-engine' && this.process?.pid) {
      identity = {
        pid: this.process.pid,
        startTimeMs: this.lastSpawnedAt || Date.now(),
        generation: 1
      }
    }
    return identity
  }

  /**
   * 检查指定目标模块底层物理进程是否在操作系统中运行
   */
  public isServiceRunning(targetId: string = 'firefly-ai-engine'): boolean {
    if (targetId === 'firefly-ai-engine') {
      if (this.process !== null && !this.process.killed && typeof this.process.pid === 'number') {
        const res = this.processTreeManager.isProcessTreeExited({
          pid: this.process.pid,
          startTimeMs: this.lastSpawnedAt || 0,
          generation: 1
        })
        return res === false
      }
    }
    const identity = this.processTreeManager.currentIdentity(targetId)
    if (!identity) return false
    return this.processTreeManager.isProcessTreeExited(identity) === false
  }

  /**
   * 核验指定身份的整棵进程树在操作系统中是否已确认退出
   */
  public isProcessTreeExited(identity: ProcessTreeIdentity): boolean {
    const res = this.processTreeManager.isProcessTreeExited(identity)
    return res === true
  }

  /** 订阅整棵进程树完全退出事件 */
  public onProcessTreeExit(identity: ProcessTreeIdentity, callback: () => void): () => void {
    return this.processTreeManager.onProcessTreeExit(identity, callback)
  }

  /** 终止整棵进程树 */
  public async stopProcessTree(identity: ProcessTreeIdentity): Promise<void> {
    await this.processTreeManager.stopProcessTree(identity)
  }

  /** 有界确认进程树退出（三态签名） */
  public async awaitProcessTreeExit(
    identity: ProcessTreeIdentity,
    timeoutMs: number
  ): Promise<'exited' | 'timeout' | 'unknown'> {
    return this.processTreeManager.awaitProcessTreeExit(identity, timeoutMs)
  }

  /**
   * 平台级代际精准强杀
   */
  public forceKillOldGeneration(
    targetId: string,
    generation: number,
    jobHandle?: string
  ): Promise<'killed' | 'no_handle' | 'unknown'> {
    return this.processTreeManager.forceKillOldGeneration(targetId, generation, jobHandle)
  }

  /** 加载大模型并返回生成的整棵进程树物理身份 */
  public async loadModel(
    targetId: string,
    modelId?: string,
    _opts?: { signal?: AbortSignal; onProgress?: (progress: number) => void }
  ): Promise<{ identity: ProcessTreeIdentity }> {
    const startRes = await this.startService({ modelId })
    if (!startRes.ok) {
      throw new Error(startRes.error || `Failed to load model for ${targetId}`)
    }
    const current = this.currentIdentity(targetId)
    if (current) {
      return { identity: current }
    }
    const pid = this.process?.pid
    if (typeof pid !== 'number' || pid <= 0) {
      throw new Error(`Engine process not available for target ${targetId}`)
    }
    const identity: ProcessTreeIdentity = {
      pid,
      startTimeMs: this.lastSpawnedAt || Date.now(),
      generation: 1
    }
    this.processTreeManager.setIdentity(targetId, identity)
    return { identity }
  }

  /**
   * 按需加载并激活 Omni 端侧模型 Session (POST /v1/modules/:module_id/session)
   * 走 omniService.omniFetch(kind: 'long') 并按契约映射 HTTP 状态码：
   * - 200 -> ok
   * - 503 MODULE_NOT_INSTALLED -> not_installed
   * - 409 LOAD_SUPERSEDED -> aborted
   * - 404 / 405 / 连接错 / 超时 -> unreachable（记 warn）
   * - 其余可达 5xx -> failed（供上层计入 crashStreak）
   */
  public async loadOmniModule(
    targetId: string,
    options?: { signal?: AbortSignal; timeoutMs?: number }
  ): Promise<OmniModuleLoadResult> {
    const baseUrl = omniService.getBaseUrl()
    const url = `${baseUrl}/v1/modules/${encodeURIComponent(targetId)}/session`
    const timeoutMs = options?.timeoutMs ?? 90_000
    try {
      const res = await omniService.omniFetch(url, {
        kind: 'long',
        timeoutMs,
        method: 'POST',
        signal: options?.signal
      })
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
      if (res.status === 404 || res.status === 405) {
        logger.warn(
          LogCategory.SYSTEM,
          `[EngineBridge] loadOmniModule 端点不可达 HTTP ${res.status}: targetId=${targetId}`
        )
      }
      return classifyOmniModuleLoadHttpResponse(targetId, res.status, body)
    } catch (err: any) {
      if (options?.signal?.aborted || err?.name === 'AbortError') {
        return {
          outcome: 'aborted',
          residentBytes: 0,
          error: typeof options?.signal?.reason === 'string' ? options.signal.reason : 'ABORTED'
        }
      }
      logger.warn(
        LogCategory.SYSTEM,
        `[EngineBridge] loadOmniModule 请求异常 (unreachable): targetId=${targetId}`,
        err
      )
      return {
        outcome: 'unreachable',
        residentBytes: 0,
        error: err?.message || String(err)
      }
    }
  }

  /**
   * 触发 Omni 端侧模型 Session 动态排空与内存释放 (spec §3.4.2)
   */
  public async drainOmniModule(
    targetId: string,
    options?: { waitDrainMs?: number; signal?: AbortSignal }
  ): Promise<OmniModuleDrainResult> {
    const baseUrl = omniService.getBaseUrl()
    const waitMs = options?.waitDrainMs ?? 3000
    const url = `${baseUrl}/v1/modules/${encodeURIComponent(targetId)}/session?wait_drain_ms=${waitMs}`

    const res = await omniService.omniFetch(url, {
      kind: 'long',
      timeoutMs: waitMs + 3000,
      method: 'DELETE',
      signal: options?.signal
    })
    if (!res.ok) {
      const errJson = (await res.json().catch(() => ({}))) as any
      throw new Error(
        errJson.error || `Failed to drain omni module ${targetId}: HTTP ${res.status}`
      )
    }
    return (await res.json()) as OmniModuleDrainResult
  }

  /**
   * 探测 Omni 端侧模型 Session 驻留状态 (spec §3.4.2)
   */
  public async getOmniModuleStatus(
    targetId: string,
    options?: { signal?: AbortSignal }
  ): Promise<OmniModuleStatusResult> {
    try {
      const baseUrl = omniService.getBaseUrl()
      const url = `${baseUrl}/v1/modules/${encodeURIComponent(targetId)}/session/status`

      const res = await omniService.omniFetch(url, {
        kind: 'probe',
        timeoutMs: 3000,
        internal: true,
        method: 'GET',
        signal: options?.signal
      })
      if (!res.ok) {
        return {
          loaded: false,
          residentBytes: 0,
          serviceReachable: false,
          probeStatus: 'unreachable'
        }
      }
      const data = (await res.json()) as OmniModuleStatusResult
      return {
        ...data,
        probeStatus: 'ok'
      }
    } catch (err: any) {
      const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError'
      return {
        loaded: false,
        residentBytes: 0,
        serviceReachable: false,
        probeStatus: isTimeout ? 'timeout' : 'unreachable'
      }
    }
  }
}

/** 全局单例 */
export const engineBridgeService = EngineBridgeService.getInstance()
