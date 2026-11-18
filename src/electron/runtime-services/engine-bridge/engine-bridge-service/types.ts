import type { Tier2CircuitState } from '../tier2-circuit-breaker'
import type { EngineMetricsSnapshot } from '../engine-swapping-coordinator'

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
  /**
   * 引擎进程状态（EngineStatus.status，见 firefly-ai-engine `engine/mod.rs`）。
   *
   * 与 `running` 布尔字段的区别：`running` 只表示「宿主进程活着」，
   * 而 `status` 区分「推理服务是否真的可用」。宿主进程重启后 HTTP 立刻可响应，
   * 但推理服务仍是 `stopped` —— 这正是 2026-10-30 事故中 87 分钟 503 的根因，
   * 故必须显式声明为联合类型，禁止用 `any` 兜底（拼错字面量会静默失效）。
   */
  status?: 'starting' | 'ready' | 'processing' | 'error' | 'stopped'
  error?: string
  /**
   * 引擎实际生效的运行时参数（来自 EngineStatus.runtime_params）。
   * `ctx_size` 为 llama-server 真实 `--ctx-size`，是上下文预算的唯一上限来源。
   */
  runtime_params?: {
    n_gpu_layers?: number
    threads?: number
    ctx_size?: number
    batch_size?: number
    ubatch_size?: number
    [key: string]: any
  } | null
  [key: string]: any
}

/**
 * 桥接监控面板使用的外部状态结构
 */
export interface EngineBridgeSnapshot {
  /** 引擎是否在线（端口可探活） */
  connected: boolean
  /**
   * 宿主进程是否由本服务托管（`this.process !== null`）。
   *
   * 与 `connected` 的区别：外部手动启动的引擎同样 `connected === true`，但它没有
   * exit 处理器，被杀后既无崩溃自愈也无重新拉起。验收脚本用它排除该场景。
   */
  managed: boolean
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
  /** 统一引擎运行时指标快照（/v1/engine/metrics 归一化） */
  metrics?: EngineMetricsSnapshot | null
  /** 运行时指标快照更新时间戳 */
  metricsUpdatedAt?: number | null
  /** 当前激活模型友好展示名称 */
  activeModel?: string | null
  /** 当前激活多模态/视觉模型文件或标识符（未连接时为 null） */
  activeMmproj?: string | null
  /** 是否激活 D-Spark 双模型协同加速 */
  isDSparkActive?: boolean
}
