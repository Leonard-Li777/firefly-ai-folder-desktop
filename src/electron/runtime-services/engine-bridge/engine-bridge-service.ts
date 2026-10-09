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
import { ConfigOrchestrator } from '@app/electron/config/config-orchestrator'
import { Tier2CircuitBreaker, Tier2CircuitState } from './tier2-circuit-breaker'

/** Tier 2 引擎基准端口（与本地 AI 服务端口收敛一致：38400） */
export const TIER2_ENGINE_PORT = APP_PORTS.LLAMA_LOCAL_SERVER

/** 引擎对外协议端点 */
const ENGINE_STATUS_PATH = '/api/engine/status'
const ENGINE_OPEN_UI_PATH = '/api/engine/open-ui'
const ENGINE_SHUTDOWN_PATH = '/api/engine/shutdown'
/** 引擎模型列表端点（PRD-0044：状态卡「已安装模型计数」数据源） */
const ENGINE_MODELS_PATH = '/api/models'
/** 引擎模型元数据目录端点（model_*.json 权威落点在 engine，desktop 一律经此查询） */
const ENGINE_MODEL_META_PATH = '/api/models/meta'
/** 引擎包列表端点（含 matchType/matchText，Footer「兼容模式」标记的权威来源） */
const ENGINE_LIST_PATH = '/api/engine/list'
/** 引擎 AI 服务启停端点（启停 llama.cpp 推理子进程，非退出引擎应用） */
const ENGINE_SERVICE_START_PATH = '/api/engine/start'
const ENGINE_SERVICE_STOP_PATH = '/api/engine/stop'
/** 引擎计算后端切换端点（写入 preferred_backend，重启服务后生效） */
const ENGINE_SWITCH_PATH = '/api/engine/switch'
/** 引擎全局思考模式端点（GET 读取 / POST 写入 config.json enable_thinking） */
const ENGINE_THINKING_PATH = '/api/engine/thinking'

/** 桥接请求超时（毫秒） */
const STATUS_TIMEOUT_MS = 1500
const OPEN_UI_TIMEOUT_MS = 3000
const SHUTDOWN_TIMEOUT_MS = 3000
/** AI 服务启停动作超时（服务启动可能耗时较长） */
const SERVICE_ACTION_TIMEOUT_MS = 15_000
/**
 * 引擎端口滑动探测区间长度。
 * 引擎侧在 38400 被占用时会顺延绑定（38400~38419 首个可用端口，见 firefly-ai-engine `config/store.rs`），
 * desktop 协议端点固定在基准端口，故必须在基准端口不可达时扫描该区间并采纳实际端口。
 */
const PORT_SCAN_RANGE = 20
/** 滑动区间内的单端口探测超时（回环地址被拒绝是即时的，无需长超时） */
const PORT_PROBE_TIMEOUT_MS = 400
/** 重启前等待旧实例释放端口的时长上限（毫秒） */
const PORT_RELEASE_WAIT_MS = 8_000

/** 引擎拉起后的就绪等待上限（毫秒）；冷启动含硬件探测，放宽到 40s 避免假超时 */
const READY_WAIT_LIMIT_MS = 40_000
/** 状态轮询间隔（毫秒） */
const POLL_INTERVAL_MS = 5_000

/**
 * 引擎在 desktop 集成目录中的相对目录名（ADR-0033 1:1 镜像）
 * 集成目录 = `<extraResources>/bin/firefly-ai-engine/`，由 `pnpm engine:deploy:watch` 部署
 */
const ENGINE_BIN_DIR_NAME = 'firefly-ai-engine'

/**
 * 开发态二进制热更新轮询间隔（毫秒）
 * 用于感知 `engine:deploy:watch` 重编译后覆盖集成目录中的 exe
 */
const DEV_BINARY_WATCH_INTERVAL_MS = 3_000

/**
 * 引擎状态快照（来自 /api/engine/status，字段以引擎契约为准，宽容解析）
 */
export interface Tier2EngineStatus {
  running?: boolean
  version?: string
  backend?: string
  active_backend?: string
  model?: string
  /** 引擎契约字段名（EngineStatus.current_model，见 firefly-ai-engine engine/mod.rs） */
  current_model?: string
  current_model_name?: string
  /** 激活主语言模型槽位（{model_id}@{source} 或自动绑定时的本地物理路径，未激活为 null） */
  active_language_model?: string | null
  /** 激活嵌入向量模型槽位（{model_id}@{source} 或本地物理路径，未激活为 null） */
  active_embedding_model?: string | null
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
  /** 是否为开发模式（集成目录热更新监听在该模式下生效） */
  devMode: boolean
  /** 通信端口 */
  port: number
  /** 引擎版本（未就绪时为 null） */
  version: string | null
  /** 当前激活后端（cuda/vulkan/cpu/metal/...） */
  backend: string | null
  /**
   * 当前激活引擎在引擎列表（/api/engine/list）中的适配类型：
   * - 'best'：最佳/正确/最新适配（不应显示「兼容模式」）
   * - 'compatible'：兼容模式（Footer 应显示「兼容模式」）
   * - 'fallback'：保底
   * 未获取到引擎列表时为 null
   */
  backendMatchType: 'best' | 'compatible' | 'fallback' | null
  /** 当前激活模型（四级优先级推导，见 resolveDisplayModelPair：可能为引擎 current_model 原始路径/id，或内置目录条目 id 含量化后缀） */
  model: string | null
  /** 当前加载模型的展示名称（来自 /api/models 列表的 name 字段；未匹配时为 null） */
  modelName: string | null
  /** 显存占用（MB） */
  vramMb: number | null
  /** 引擎已安装模型数量（PRD-0044 状态卡增项；未连接或引擎未返回时为 null） */
  modelCount: number | null
  /** 支持的可用模型总数（默认 33，合计语言模型与 embedding 模型，来自内置可用模型库） */
  totalModelCount: number | null
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
  /** 当前实际通信端口（初始为基准端口；引擎滑动时经探测采纳实际端口） */
  private activePort: number = TIER2_ENGINE_PORT
  private isStarting = false
  private startPromise: Promise<boolean> | null = null
  private pollTimer: NodeJS.Timeout | null = null
  /** 轮询探活单飞标志，避免全端口探测耗时超过轮询间隔时发生并发重入 */
  private pollInFlight = false
  /** 服务停止代际计数，每次 stop() 递增以拦截在途异步探活回写已停止状态 */
  private stopEpoch = 0
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
  /** 引擎思考模式同步 in-flight Promise（并发调用共享同一次同步，均可 await 到完成） */
  private thinkingSyncPromise: Promise<void> | null = null
  /** 最近一次与引擎对齐的思考模式值（防止「引擎→桌面」回写再触发「桌面→引擎」死循环） */
  private lastSyncedThinking: boolean | null = null
  /** ENABLE_THINKING_MODE 变更订阅取消函数 */
  private thinkingConfigUnsubscribe: (() => void) | null = null
  /** 内置模型元数据缓存（包含所有语言模型与 embedding 模型；权威来源 = engine /api/models/meta） */
  private builtinModelCatalog: Array<{ id: string; name: string; isEmbedding?: boolean }> | null = null
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
  /** 模型计数刷新进行中的 Promise（并发调用共享同一刷新，await 可等待真正完成） */
  private modelCountPromise: Promise<void> | null = null
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
  private eventStreamAbortController: AbortController | null = null
  private listeners = new Set<(snapshot: EngineBridgeSnapshot) => void>()
  readonly circuitBreaker = new Tier2CircuitBreaker()

  /** 当前是否正处于拉起启动流程中 */
  public isStartingNow(): boolean {
    return this.isStarting
  }

  private constructor() {
    this.setupLifecycleHooks()
    this.setupThinkingConfigSync()
    // 启动常驻状态轮询（3秒探活），自动同步外部引擎上线/下线及在引擎内切换模型
    this.startPolling(3000)
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
   * 订阅桌面端 ENABLE_THINKING_MODE 变更，双向对齐引擎思考模式：
   * - 桌面设置/云端思考开关变更 → 推送到引擎 config.json（下次启动 llama-server 注入思考参数）
   * - 引擎 UI 变更 → 由探活路径 pull 回写桌面（见 syncThinkingModeFromEngine）
   */
  private setupThinkingConfigSync(): void {
    try {
      this.thinkingConfigUnsubscribe = ConfigOrchestrator.getInstance().onValueChange<boolean>(
        'ENABLE_THINKING_MODE',
        value => {
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
        path.join(root, 'apps', 'desktop', 'build', 'extraResources', 'bin', ENGINE_BIN_DIR_NAME, exeName),
        path.join(root, 'apps', 'desktop', 'pro', 'build', 'extraResources', 'bin', ENGINE_BIN_DIR_NAME, exeName),
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
    return !app?.isPackaged || process.env.NODE_ENV !== 'production'
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
      logger.debug(LogCategory.SYSTEM, '[EngineBridge] 从本地 model_zh-CN.json 加载 catalog 失败:', err)
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

    // 防护：mmproj 是多模态投影器辅助文件，不是可直接启动的主模型，不应展示为当前模型名称
    const fileBasename = identifier.replace(/.*[/\\]/, '').toLowerCase()
    if (fileBasename.startsWith('mmproj')) {
      logger.warn(LogCategory.SYSTEM, `[EngineBridge] current_model 指向投影器文件，忽略展示: ${identifier}`)
      return null
    }

    // 0. 如果 identifier 本身已经是规范展示名称（包含中文、全角括号、或者非文件名且包含空格），直接返回
    if (
      /[\u4e00-\u9fa5（）]/.test(identifier) ||
      (identifier.includes(' ') && !/[/\\]/.test(identifier) && !identifier.toLowerCase().endsWith('.gguf'))
    ) {
      return identifier
    }

    // 1. 优先从内置模型目录进行语义与归一化匹配（获取 Qwen 3.5 0.8B (中文更佳) 等中文规范名称）
    const catalog = this.loadBuiltinModelCatalog()
    if (catalog.length > 0) {
      // 1.1 直接精确匹配 id 或 name
      const direct = catalog.find(m => m.id === identifier || m.name === identifier)
      if (direct?.name) return direct.name

      // 1.2 如果 identifier 是完整物理路径，匹配其包含的 repo 仓库标识
      // 例如路径包含 'zensignGG/MiniCPM5-1B-Claude-Opus-Fable5-V2-Thinking-heretic-GGUF'
      const normalizedPath = identifier.replace(/\\/g, '/').toLowerCase()
      const pathHit = catalog.find(m => {
        if (!m.id) return false
        const repoId = m.id.split(':')[0].toLowerCase()
        if (!repoId) return false
        const repoSlug = repoId.replace('/', '--')
        return normalizedPath.includes(repoId) || normalizedPath.includes(repoSlug)
      })
      if (pathHit?.name) return pathHit.name

      // 1.3 规范化匹配（去掉扩展名、路径前缀）
      const clean = identifier.replace(/\.[^.]+$/, '').replace(/.*[\\/]/, '')
      const cleanNorm = clean.toLowerCase().replace(/[-_:\/]|gguf/gi, '')
      const hit = catalog.find(m => {
        if (!m.id) return false
        if (m.id === clean || m.name === clean) return true
        const idNorm = m.id.toLowerCase().replace(/[-_:\/]|gguf/gi, '')
        if (idNorm.includes(cleanNorm) || cleanNorm.includes(idNorm)) return true

        // 针对模型家族关键词与尺寸进行深度匹配（如 minicpm5 + 1b）
        const cLower = clean.toLowerCase()
        const idLower = m.id.toLowerCase()
        if (cLower.includes('minicpm5') && idLower.includes('minicpm5')) {
          if (cLower.includes('1b') && idLower.includes('1b')) return true
          if (cLower.includes('2b') && idLower.includes('2b')) return true
        }
        if (cLower.includes('qwen') && idLower.includes('qwen')) {
          if (cLower.includes('0.8b') && idLower.includes('0.8b')) return true
        }
        return false
      })
      if (hit && hit.name) {
        return hit.name
      }
    }

    // 2. 次选从 /api/models 映射表中反查（若名称与原始 ID 不同则采用）
    if (this.lastModelNameMap.size > 0) {
      const mapped = this.lastModelNameMap.get(identifier)
      if (mapped && mapped !== identifier) {
        return mapped
      }
    }

    // 3. 兜底语义映射（绝不能将冰冷的文件名原样暴露为模型名称）
    const cleanStem = identifier.replace(/.*[\\/]/, '').replace(/\.[^.]+$/, '')
    if (/minicpm5[-_]1b/i.test(cleanStem)) {
      return 'MiniCPM5 1B（较好•越狱）'
    }
    if (/minicpm5[-_]2b/i.test(cleanStem)) {
      return 'MiniCPM5 2B（高质量•高速）'
    }
    if (/qwen3\.?5[-_]0\.8b/i.test(cleanStem)) {
      return 'Qwen 3.5 0.8B (中文更佳)'
    }
    if (/lfm2\.?5[-_]1\.2b/i.test(cleanStem)) {
      return 'LFM2.5 1.2B Instruct（英文更佳•高速）'
    }

    return cleanStem
  }

  /**
   * 推导展示模型及其友好名称（对齐 firefly-ai-engine resolveDisplayModel 的权威优先级）：
   *   P1 运行模型 —— 仅 ready/starting 态（停止态严禁使用残留 current_model）
   *   P2 激活主语言模型槽位（active_language_model）
   *   P3 激活嵌入向量模型槽位（active_embedding_model）
   *   P4 兜底 —— 上次已知运行模型 → 本地首个已下载就绪模型
   *
   * 修复「引擎 UI 与 desktop Footer 模型状态不同步」：引擎切换到嵌入模型（如 WeMM）时
   * current_model 可能为空而嵌入槽位已激活，旧逻辑 current_model → lastKnownModel →
   * firstDownloadedModel 单链会滞留陈旧的语言模型名称。
   */
  private resolveDisplayModelPair(): { model: string | null; modelName: string | null } {
    const raw = this.lastRawStatus
    const isRunningOrStarting = raw?.status === 'ready' || raw?.status === 'starting'
    const running =
      raw?.current_model ||
      raw?.model ||
      (raw?.loaded_models && raw.loaded_models.length > 0 ? raw.loaded_models[0] : null) ||
      null
    const runningName = raw?.current_model_name || raw?.model_name || null

    // P1：运行模型（仅实际运行态；停止态跳过，严禁使用残留 current_model）
    if (isRunningOrStarting && running) {
      return { model: running, modelName: runningName || this.resolveFriendlyModelName(running) }
    }

    // P2：激活主语言模型槽位
    const langHit = raw?.active_language_model
      ? this.matchSlotToCatalog(raw.active_language_model, 'language')
      : null
    if (langHit) {
      return { model: langHit.id, modelName: langHit.name }
    }

    // P3：激活嵌入向量模型槽位
    const embHit = raw?.active_embedding_model
      ? this.matchSlotToCatalog(raw.active_embedding_model, 'embedding')
      : null
    if (embHit) {
      return { model: embHit.id, modelName: embHit.name }
    }

    // P4：兜底 —— 上次已知运行模型 → 本地首个已下载就绪模型（引擎未启动服务时展示当前激活模型）
    const fallback = this.lastKnownModel || this.firstDownloadedModel || null
    return { model: fallback, modelName: this.resolveFriendlyModelName(fallback) }
  }

  /**
   * 将引擎激活槽位值匹配到内置模型目录或已下载/自定义模型列表条目。
   * 槽位值格式（firefly-ai-engine api.rs）：
   * - 手动切换：`{model_id}@{source}`（source ∈ modelscope | huggingface）
   * - 自动绑定：本地物理路径（如启动时自动检测绑定）
   * 匹配优先级（Two-Pass，先精确、后模糊，各阶段内按第一层内置目录 -> 第二层 /api/models 列表）：
   * - Pass 1：ID / 名称精确匹配（防止第一层模糊基名截胡同底座或同仓库不同量化的自定义模型）
   * - Pass 2：路径、localPath/fileName 与基名归一化模糊匹配（含显式量化标签冲突守卫与双向 >3 长度门禁）
   * 槽位语义过滤对两层匹配源同等生效（语言槽位只匹配非 embedding、嵌入槽位只匹配 embedding 模型）。
   */
  private matchSlotToCatalog(
    slot: string,
    prefer: 'language' | 'embedding'
  ): { id: string; name: string } | null {
    if (!slot) return null

    const slotLower = slot.toLowerCase().replace(/\\/g, '/')
    // {model_id}@{source} → model_id（model_id 本身不含 '@'）
    const slotId = slotLower.split('@')[0]
    const slotFileName = slotId.replace(/.*\//, '')
    // 防护：mmproj 多模态投影器辅助文件严禁命中主语言模型或嵌入模型槽位
    if (slotFileName.startsWith('mmproj')) return null

    const layers: Array<
      Array<{
        id: string
        name: string
        localPath?: string
        fileName?: string
        isEmbedding?: boolean
      }>
    > = [this.loadBuiltinModelCatalog(), this.downloadedModelCatalog]

    if (layers[0].length === 0 && layers[1].length === 0) return null

    const matchesSlotType = (entry: {
      id: string
      name: string
      fileName?: string
      isEmbedding?: boolean
    }): boolean => {
      const entryIsEmbedding =
        entry.isEmbedding === true ||
        /wemm|embedding/i.test(entry.id) ||
        /wemm|embedding/i.test(entry.name) ||
        Boolean(entry.fileName && /wemm|embedding/i.test(entry.fileName))
      return prefer === 'embedding' ? entryIsEmbedding : !entryIsEmbedding
    }

    // Pass 1：ID / 名称精确匹配（Layer 1 内置推荐目录 -> Layer 2 引擎 /api/models 列表）
    for (const layer of layers) {
      for (const entry of layer) {
        if (!entry.id || !entry.name) continue
        if (!matchesSlotType(entry)) continue
        const idLower = entry.id.toLowerCase()
        if (slotId === idLower || slotLower === entry.name.toLowerCase()) {
          return { id: entry.id, name: entry.name }
        }
      }
    }

    // Pass 2：路径与基名归一化模糊匹配（Layer 1 内置推荐目录 -> Layer 2 引擎 /api/models 列表）
    const slotBase = slotId.replace(/.*\//, '').split(':')[0]
    const norm = (s: string): string => s.replace(/[-_:./\\]|gguf/gi, '').toLowerCase()
    const slotIdNorm = norm(slotBase)
    const slotStemNorm = norm(slotFileName.replace(/\.[^.]+$/, ''))
    const looksLikePath = slotLower.includes('.gguf') || slotLower.split('/').length >= 3

    // 对称双向长度守卫：仅当双侧长度均 > 3 时才允许子串包含匹配，杜绝空串/短串 .includes("") 恒真
    const fuzzyMatch = (a: string, b: string): boolean =>
      a.length > 0 &&
      b.length > 0 &&
      (a === b || (a.length > 3 && b.length > 3 && (a.includes(b) || b.includes(a))))

    // 提取显式量化标签（剔除 Windows 盘符前缀、路径与 .gguf 文件名后缀，统一去除 ud- 前缀）
    const extractQuantTag = (rawId: string): string | null => {
      const withoutDrive = rawId.replace(/^[a-z]:/i, '')
      const colonIdx = withoutDrive.indexOf(':')
      if (colonIdx < 0) return null
      const tag = withoutDrive.slice(colonIdx + 1).trim().toLowerCase()
      if (!tag || tag.endsWith('.gguf') || tag.includes('/')) return null
      return tag.replace(/^ud[-_]/, '').replace(/_/g, '-')
    }
    const slotQuant = extractQuantTag(slotId)

    for (const layer of layers) {
      for (const entry of layer) {
        if (!entry.id || !entry.name) continue
        if (!matchesSlotType(entry)) continue

        const idLower = entry.id.toLowerCase()
        const entryQuant = extractQuantTag(idLower)
        if (slotQuant && entryQuant && slotQuant !== entryQuant) continue

        const entryBase = idLower.replace(/.*\//, '').split(':')[0]
        const entryBaseNorm = norm(entryBase)

        const lpLower = entry.localPath ? entry.localPath.toLowerCase().replace(/\\/g, '/') : ''
        const fnLower = entry.fileName
          ? entry.fileName.toLowerCase().replace(/\\/g, '/')
          : lpLower
            ? lpLower.replace(/.*\//, '')
            : ''
        const fnStem = fnLower ? fnLower.replace(/\.[^.]+$/, '') : ''
        const fnStemNorm = fnStem ? norm(fnStem) : ''

        const hit =
          fuzzyMatch(slotBase, entryBase) ||
          fuzzyMatch(slotIdNorm, entryBaseNorm) ||
          fuzzyMatch(slotStemNorm, entryBaseNorm) ||
          (looksLikePath &&
            (() => {
              const repoId = idLower.split(':')[0]
              if (!repoId || repoId.length <= 3) return false
              const repoSlug = repoId.replace(/\//g, '--')
              return slotLower.includes(repoId) || (repoSlug !== repoId && slotLower.includes(repoSlug))
            })()) ||
          (lpLower.length > 0 &&
            (slotLower === lpLower ||
              (looksLikePath &&
                lpLower.length > 3 &&
                slotLower.length > 3 &&
                (lpLower.includes(slotLower) || slotLower.includes(lpLower))))) ||
          (fnLower.length > 0 && (slotLower === fnLower || slotFileName === fnLower)) ||
          fuzzyMatch(slotBase, fnStem) ||
          fuzzyMatch(slotIdNorm, fnStemNorm) ||
          fuzzyMatch(slotStemNorm, fnStemNorm)

        if (hit) {
          return { id: entry.id, name: entry.name }
        }
      }
    }
    return null
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
      return mode !== 'cloud' && mode !== 'disabled'
    } catch (err) {
      logger.debug(LogCategory.SYSTEM, '[EngineBridge] 读取 AI_SERVICE_MODE 失败，跳过自动拉起:', err)
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
    logger.info(
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
    // 启动冷静期（15秒）：引擎刚启动不久，给其足够的稳定初始化时间，避免启动期抖动
    if (this.lastSpawnedAt > 0 && Date.now() - this.lastSpawnedAt < 15_000) {
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

    const previous = this.spawnedBinarySignature
    this.spawnedBinarySignature = signature
    this.pendingUpdateSignature = null
    this.pendingUpdateSince = 0

    if (previous === null) {
      // 本服务未托管过引擎：可能是外部实例，不越权处理
      if (this.lastRawStatus) {
        logger.warn(
          LogCategory.SYSTEM,
          '[EngineBridge] 检测到引擎二进制已更新，但当前实例非本服务拉起，需重启该实例后新版本才会生效'
        )
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
   * 探活：向 /api/engine/status 发起一次状态查询
   * 默认每次失败都将计入熔断器（Tier 2 静默熔断）；后台轮询与启动等待可传入 `{ recordFailure: false }` 走裸探活。
   *
   * 基准端口不可达时会扫描 38400~38419，采纳引擎实际绑定的滑动端口，
   * 避免引擎顺延后 desktop 永久显示「未连接」。
   */
  public async healthCheck(options?: { recordFailure?: boolean }): Promise<Tier2EngineStatus | null> {
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
      return (await res.json()) as Tier2EngineStatus
    } catch (err) {
      return null
    }
  }

  /** 采纳探活结果：刷新版本缓存与原始状态，并异步刷新模型计数 */
  public applyStatus(data: Tier2EngineStatus): void {
    if (typeof data.version === 'string' && data.version) {
      this.versionCache = data.version
    }
    const prevModel = this.lastRawStatus?.current_model || this.lastRawStatus?.model || this.lastKnownModel
    const currentModel = data.current_model || data.model || (data.loaded_models?.[0]) || null
    const modelChanged = currentModel !== null && currentModel !== prevModel
    // 槽位变更检测：引擎 UI 切换嵌入/语言模型时 current_model 可能不变或置空，
    // 若只检测 current_model 会漏播广播，渲染层只能等下个轮询 tick —— Footer 模型状态「不同步」的延迟根因
    const langSlotChanged = (data.active_language_model || null) !== (this.lastRawStatus?.active_language_model || null)
    const embSlotChanged = (data.active_embedding_model || null) !== (this.lastRawStatus?.active_embedding_model || null)
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
    if (hadError || modelChanged || langSlotChanged || embSlotChanged || statusChanged || wasOffline) {
      this.broadcastStatus()
    }
    // PRD-0044：探活成功后异步刷新已安装模型计数，不阻塞探活关键路径
    void this.refreshModelCount()
    // 异步刷新当前引擎适配类型（Footer「兼容模式」标记依据），不阻塞探活关键路径
    void this.refreshBackendMatchType()
    // 异步对齐思考模式（引擎 UI 变更后 desktop 请求级/Footer 需感知），不阻塞探活关键路径
    void this.syncThinkingModeFromEngine()
    // 确保已连接 SSE 实时状态流（用于毫秒级捕获引擎 API 开始/完成状态）
    this.ensureEventStream()
  }

  /**
   * 采纳离线状态：清空原始状态缓存，中断 SSE 事件流，并在状态发生变化时按需广播离线
   */
  public applyOffline(): void {
    if (this.eventStreamAbortController) {
      this.eventStreamAbortController.abort()
      this.eventStreamAbortController = null
    }
    const wasOnline = this.lastRawStatus !== null
    this.lastRawStatus = null
    if (wasOnline) {
      this.broadcastStatus()
    }
  }

  /**
   * 建立与引擎 /api/engine/events 的 SSE 实时长连接，
   * 使得引擎 API 开始/结束工作时的状态切换能够毫秒级推送到 desktop
   */
  private ensureEventStream(): void {
    if (this.eventStreamAbortController) {
      return
    }
    const ac = new AbortController()
    this.eventStreamAbortController = ac
    const url = `${this.baseUrl}/api/engine/events`

    ;(async () => {
      try {
        const res = await fetch(url, { signal: ac.signal })
        if (!res.ok || !res.body) {
          this.eventStreamAbortController = null
          return
        }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (!ac.signal.aborted) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            const trimmed = line.trim()
            if (trimmed.startsWith('data:')) {
              const jsonStr = trimmed.slice(5).trim()
              if (jsonStr) {
                try {
                  const statusData = JSON.parse(jsonStr)
                  this.applyStatus(statusData)
                } catch {}
              }
            }
          }
        }
      } catch (err: any) {
        // 连接断开或异常重置 controller，等待后续探活自动重试
      } finally {
        if (this.eventStreamAbortController === ac) {
          this.eventStreamAbortController = null
        }
      }
    })().catch(() => {})
  }

  /**
   * 在 38400~38419 区间扫描已运行的引擎并采纳其端口。
   * 引擎侧端口滑动（`config/store.rs`）对 desktop 不可见，不采纳就会一直「未连接」。
   * @returns 是否发现并采纳了可用端口
   */
  private async adoptRunningEnginePort(epoch: number = this.stopEpoch): Promise<boolean> {
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
   * 从引擎 /api/models 汇总已安装模型数量与可用模型总数并更新缓存（PRD-0044 状态卡增项）。
   * 分子：已安装模型数（合计所有已下载就绪的语言模型、Embedding 向量模型及本地自定义模型）
   * 分母：总可用模型数（合计所有官方推荐语言模型 31 个 + Embedding 向量模型 2 个 = 33 个，加上本地未在推荐库中的自定义模型）
   * 并发去重；数量变化时补播一次状态，让渲染层无需等下个轮询周期。
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
    try {
      const prevPair = this.resolveDisplayModelPair()
      // 预热引擎模型元数据目录（model_*.json 权威落点在 engine，desktop 一律经引擎查询）
      await this.fetchModelMeta()

      const res = await fetch(`${this.baseUrl}${ENGINE_MODELS_PATH}`, {
        method: 'GET',
        signal: AbortSignal.timeout(STATUS_TIMEOUT_MS)
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
              if (m.localPath && b.id && m.localPath.toLowerCase().includes(b.id.split(':')[0].toLowerCase())) return true
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
      }
    } catch (err) {
      // 计数为展示增项，失败不影响桥接主链路；记 debug 便于排查
      logger.debug(LogCategory.SYSTEM, '[EngineBridge] 拉取引擎模型列表失败（模型计数缺省）:', err)
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
          matchType?: 'best' | 'compatible' | 'fallback'
        }>
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
   * 确保引擎在线：在线则直接复用；离线则尝试静默拉起（受熔断器保护）
   * @param options.force 显式启动（用户点击）时跳过熔断冷却，避免「点了没反应」
   */
  public async ensureRunning(options?: { force?: boolean; mode?: 'language' | 'embedding' }): Promise<boolean> {
    if (options?.force) {
      // 显式启动视为用户意图，复位熔断器重新放行
      this.circuitBreaker.reset()
    } else {
      if (this.circuitBreaker.getState() === 'open') {
        logger.warn(
          LogCategory.SYSTEM,
          '[EngineBridge] Tier 2 引擎处于熔断冷却期，跳过静默拉起（分析将降级到 Tier 1）'
        )
        return false
      }
      if (!(await this.shouldEngineRun())) {
        logger.info(
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
        this.isStarting = false
        this.broadcastStatus()
        return true
      }

      logger.info(LogCategory.SYSTEM, `[EngineBridge] 静默拉起 Tier 2 引擎: ${exePath}`)
      // ENGINE_PORT 仅作前向兼容提示：引擎当前从自身 %APPDATA%/com.firefly.ai-engine/config.json
      // 的 base_port 取基准端口，并在被占用时于 38400~38419 内顺延；
      // desktop 侧由 healthCheck 的滑动区间探测兜底，不依赖该环境变量。
      const env = {
        ...process.env,
        ENGINE_PORT: String(TIER2_ENGINE_PORT)
      }
      // windowsHide: 抑制 Windows 控制台窗口闪烁（debug 构建的引擎为控制台子系统）
      const child = spawn(exePath, ['--silent', '--tray'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env
      })
      this.process = child
      child.unref()

      // 登记进全局精准进程回收器
      try {
        const { processReaper } = require('../../main/process-reaper')
        processReaper.registerChild(child.pid, 'firefly-ai-engine')
      } catch {}

      // 记录本次拉起的二进制签名，并开启热更新监听：
      // engine:deploy:watch 覆盖集成目录产物后据此自动重启引擎
      this.spawnedBinarySignature = this.binarySignature(exePath)
      this.lastSpawnedAt = Date.now()
      this.pendingUpdateSignature = null
      this.pendingUpdateSince = 0
      this.startDevBinaryWatch()

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
        try {
          const { processReaper } = require('../../main/process-reaper')
          processReaper.unregisterChild(child.pid)
        } catch {}
        this.process = null
        this.applyOffline()
      })

      // 等待引擎就绪（轮询 /api/engine/status）
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
   * 等待引擎 HTTP 就绪。
   *
   * **不得将启动期失败计入熔断器**：拉起后的启动窗口内探活失败是预期现象（引擎仍在初始化），
   * 若记入熔断器，3 次失败即 open，后续 canExecute()=false 会直接跳过探测，
   * 表现为「引擎明明已就绪，desktop 仍报启动超时」。这里统一走 `healthCheck({ recordFailure: false })` 裸探活。
   */
  private async waitForReady(limitMs: number): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < limitMs) {
      // 裸探活：失败不记入熔断器，成功复位熔断器并兼容基准端口与 38400~38419 滑动端口
      const status = await this.healthCheck({ recordFailure: false })
      if (status) {
        return true
      }
      await new Promise(resolve => setTimeout(resolve, 1200))
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
        logger.info(LogCategory.SYSTEM, '[EngineBridge] 打开面板前检测到引擎未运行，主动平稳拉起')
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
    // Windows 环境下保底确保 firefly-ai-engine.exe 进程完全清理
    if (process.platform === 'win32') {
      try {
        const { spawnSync } = require('node:child_process')
        spawnSync('taskkill', ['/F', '/T', '/IM', 'firefly-ai-engine.exe'], {
          windowsHide: true,
          stdio: 'ignore'
        })
      } catch {}
    }
    // 引擎已请求退出，端口复位到基准值，下次拉起按默认端口协商
    this.activePort = TIER2_ENGINE_PORT
    this.applyOffline()
    return { ok: true }
  }

  /**
   * 读取引擎全局思考模式（GET /api/engine/thinking）
   */
  public async getThinkingMode(): Promise<{ ok: boolean; enableThinking?: boolean; error?: string }> {
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
      const body = (await res.json().catch(() => ({}))) as { success?: boolean; enableThinking?: boolean; error?: string }
      const ok = res.ok && body.success !== false
      if (ok) {
        this.lastSyncedThinking = enableThinking
        logger.info(LogCategory.SYSTEM, `[EngineBridge] 已同步思考模式至引擎: enable_thinking=${enableThinking}`)
      } else {
        logger.warn(LogCategory.SYSTEM, `[EngineBridge] 同步思考模式至引擎失败: ${body.error || res.status}`)
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
        logger.info(
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
   */
  public async startService(options?: { mode?: 'language' | 'embedding'; modelId?: string }): Promise<{ ok: boolean; error?: string }> {
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
      const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string }
      const ok = res.ok && body.success !== false
      if (!ok) {
        logger.warn(LogCategory.SYSTEM, `[EngineBridge] 启动 AI 服务失败: ${body.error || res.status}`)
      }
      return { ok, error: ok ? undefined : body.error || `引擎返回 ${res.status}` }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      logger.warn(LogCategory.SYSTEM, `[EngineBridge] 启动 AI 服务请求失败: ${error}`)
      return { ok: false, error }
    }
  }

  /**
   * 确保引擎以指定的意图模式运行（'language' | 'embedding'）
   * - 'language'：主语言模型模式（用于文件分析、文本分类）
   * - 'embedding'：多模态嵌入模式（用于 Stage 5 高维修正 WeMM 向量嵌入）
   * 若当前未运行或运行的模型与目标意图不符，则按意图重新激活并启动
   */
  public async ensureMode(
    mode: 'language' | 'embedding',
    options?: { force?: boolean }
  ): Promise<{ ok: boolean; error?: string }> {
    const running = await this.ensureRunning({ mode, force: options?.force })
    if (!running) {
      return { ok: false, error: 'AI引擎未运行且拉起失败' }
    }
    const status = await this.healthCheck()
    const currentModel = (status?.current_model || status?.model || '').toLowerCase()
    const isCurrentlyEmbedding = currentModel.includes('wemm') || currentModel.includes('embedding')
    const matchesTarget = mode === 'embedding' ? isCurrentlyEmbedding : !isCurrentlyEmbedding

    if (status?.status === 'ready' && matchesTarget) {
      return { ok: true }
    }

    const startRes = await this.startService({ mode })
    if (!startRes.ok) {
      return startRes
    }

    return this.waitForServiceReady(mode, 45000)
  }

  /**
   * 等待引擎推理子进程 (llama-server) 真正就绪且运行符合目标意图的模型
   * 避免启动后反向代理处于 503 拒绝状态导致前台或高维修正报错
   */
  private async waitForServiceReady(
    mode: 'language' | 'embedding',
    limitMs: number = 45000
  ): Promise<{ ok: boolean; error?: string }> {
    const start = Date.now()
    while (Date.now() - start < limitMs) {
      const status = await this.healthCheck()
      if (status) {
        const currentModel = (status.current_model || status.model || '').toLowerCase()
        const isCurrentlyEmbedding = currentModel.includes('wemm') || currentModel.includes('embedding')
        const matchesTarget = mode === 'embedding' ? isCurrentlyEmbedding : !isCurrentlyEmbedding

        if (status.status === 'ready' && matchesTarget) {
          logger.info(
            LogCategory.SYSTEM,
            `[EngineBridge] 引擎推理服务已就绪（模式: ${mode}, 模型: ${status.current_model}）`
          )
          return { ok: true }
        }

        if (status.status === 'error' || status.status === 'failed') {
          const errMsg = status.last_error || status.error || '引擎服务运行报错'
          logger.warn(LogCategory.SYSTEM, `[EngineBridge] 引擎服务报告错误: ${errMsg}`)
          return { ok: false, error: errMsg }
        }
      }
      await new Promise(resolve => setTimeout(resolve, 800))
    }

    const timeoutMsg = `等待引擎切换至 ${mode === 'embedding' ? 'WeMM 嵌入' : '主语言'} 模型就绪超时（${Math.round(limitMs / 1000)}s）`
    logger.warn(LogCategory.SYSTEM, `[EngineBridge] ${timeoutMsg}`)
    return { ok: false, error: timeoutMsg }
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
        logger.warn(LogCategory.SYSTEM, `[EngineBridge] 停止 AI 服务失败: ${body.error || res.status}`)
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
      const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: string; message?: string }
      const ok = res.ok && body.success !== false
      if (!ok) {
        logger.warn(LogCategory.SYSTEM, `[EngineBridge] 切换后端 ${backend} 失败: ${body.error || res.status}`)
      } else {
        logger.info(LogCategory.SYSTEM, `[EngineBridge] 已请求切换后端至 ${backend}（重启服务后生效）`)
      }
      return { ok, error: ok ? undefined : body.error || `引擎返回 ${res.status}` }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      logger.warn(LogCategory.SYSTEM, `[EngineBridge] 切换后端请求失败: ${error}`)
      return { ok: false, error }
    }
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
   * 启动周期性状态轮询（设置页打开后生效）
   */
  public startPolling(intervalMs: number = POLL_INTERVAL_MS): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
    }
    this.pollInFlight = false
    const timer = setInterval(async () => {
      if (this.pollInFlight || this.isStarting) {
        return
      }
      this.pollInFlight = true
      try {
        // 轮询走裸探活（脱离 canExecute 门控）：熔断 open 期仍探测基准端口与滑动端口以消除端口漂移自锁，
        // 探活失败不记入熔断器（避免冲垮 half-open 重试窗口），探活成功在 healthCheck 内自动 recordSuccess()
        const status = await this.healthCheck({ recordFailure: false })
        if (this.pollTimer !== timer) {
          return
        }
        if (!status && !this.isStarting) {
          this.lastRawStatus = null
        }
        this.broadcastStatus()
      } catch (err) {
        logger.debug(LogCategory.SYSTEM, '[EngineBridge] 轮询 tick 异常:', err)
      } finally {
        if (this.pollTimer === timer) {
          this.pollInFlight = false
        }
      }
    }, intervalMs)
    this.pollTimer = timer
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
    this.pollInFlight = false
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
      vramMb: typeof raw?.vram_usage_mb === 'number' ? raw.vram_usage_mb : typeof raw?.vram_mb === 'number' ? raw.vram_mb : typeof raw?.gpu_mem_mb === 'number' ? raw.gpu_mem_mb : null,
      modelCount: raw ? this.lastModelCount : null,
      totalModelCount: raw ? this.lastTotalModelCount : null,
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
    try {
      if (typeof BrowserWindow !== 'undefined' && typeof BrowserWindow?.getAllWindows === 'function') {
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
   * 停止服务：停轮询、清理子进程、复位熔断器
   */
  public stop(): void {
    this.stopEpoch++
    if (this.eventStreamAbortController) {
      this.eventStreamAbortController.abort()
      this.eventStreamAbortController = null
    }
    this.stopPolling()
    this.stopDevBinaryWatch()
    // 思考模式配置订阅保持进程级存活（stop 亦被单例测试复用，退订后无法恢复）
    this.killOwnProcess()
    this.activePort = TIER2_ENGINE_PORT
    this.spawnedBinarySignature = null
    this.lastRawStatus = null
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
    this.circuitBreaker.reset()
  }
}

/** 全局单例 */
export const engineBridgeService = EngineBridgeService.getInstance()