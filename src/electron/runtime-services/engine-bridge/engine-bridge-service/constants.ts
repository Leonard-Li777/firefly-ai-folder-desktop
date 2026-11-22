import { APP_PORTS } from '@firefly/shared'

/** Tier 2 引擎基准端口（与本地 AI 服务端口收敛一致：38400） */
export const TIER2_ENGINE_PORT = APP_PORTS.LLAMA_LOCAL_SERVER

/** 引擎对外协议端点 */
export const ENGINE_STATUS_PATH = '/api/engine/status'
export const ENGINE_OPEN_UI_PATH = '/api/engine/open-ui'
export const ENGINE_SHUTDOWN_PATH = '/api/engine/shutdown'
/** 引擎模型列表端点（PRD-0044：状态卡「已安装模型计数」数据源） */
export const ENGINE_MODELS_PATH = '/api/models'
/** 引擎模型元数据目录端点（model_*.json 权威落点在 engine，desktop 一律经此查询） */
export const ENGINE_MODEL_META_PATH = '/api/models/meta'
/** 引擎包列表端点（含 matchType/matchText，Footer「兼容模式」标记的权威来源） */
export const ENGINE_LIST_PATH = '/api/engine/list'
/** 引擎 AI 服务启停端点（启停 llama.cpp 推理子进程，非退出引擎应用） */
export const ENGINE_SERVICE_START_PATH = '/api/engine/start'
export const ENGINE_SERVICE_STOP_PATH = '/api/engine/stop'
/** 引擎计算后端切换端点（写入 preferred_backend，重启服务后生效） */
export const ENGINE_SWITCH_PATH = '/api/engine/switch'
/** 引擎全局思考模式端点（GET 读取 / POST 写入 config.json enable_thinking） */
export const ENGINE_THINKING_PATH = '/api/engine/thinking'
/** 统一引擎运行时与 Worker 显存指标端点 (Ticket 3) */
export const ENGINE_METRICS_PATH = '/v1/engine/metrics'

/** 桥接请求超时（毫秒） */
export const STATUS_TIMEOUT_MS = 1500
export const OPEN_UI_TIMEOUT_MS = 3000
export const SHUTDOWN_TIMEOUT_MS = 3000
/**
 * 引擎模型列表端点（`/api/models`）超时（毫秒）。
 *
 * 必须与 `STATUS_TIMEOUT_MS` 拆开：`/api/engine/status` 是纯内存读取（实测 4ms），
 * 而 `/api/models` 是**磁盘扫描型**端点 —— 引擎侧 `list_models` 每次请求都要递归
 * `read_dir` 整个模型目录并逐 gguf `metadata`（36 个模型实测约 140ms，是探活的 30+ 倍），
 * 且同步跑在 async handler 里、还持有与 `/api/engine/status` 共用的 config 锁。
 * 沿用 1500ms 会让「视频分析 / ORT DML Session 构建 / warmup 定标」等 CPU 尖峰期的
 * 请求必然假超时（实测单日 24 次），故单独给 5s 预算。
 */
export const MODELS_TIMEOUT_MS = 5_000
/**
 * 模型计数成功刷新后的缓存有效期（毫秒）。
 *
 * `/api/models` 的结果只在模型下载 / 删除 / 外部拷入时变化，属典型「读多写极少」，
 * 无需跟随 5s 探活心跳每次全盘扫描；60s 内复用上次结果可把扫描频率压掉 90% 以上。
 * 失败时改走 `MODELS_RETRY_MS` 短重试，避免「唯一一次失败即长期缺省」。
 */
export const MODELS_REFRESH_TTL_MS = 60_000
/** 模型计数刷新失败后的重试间隔（毫秒）；短于 TTL 以保留自愈能力，长于探活间隔避免每拍重试 */
export const MODELS_RETRY_MS = 15_000
/**
 * AI 服务启停动作超时（毫秒）。
 *
 * 必须**大于引擎侧的冷启动就绪预算**（firefly-ai-engine `engine/mod.rs` 的
 * `LLAMA_READY_TIMEOUT_SECS = 120`），否则客户端会在引擎给出结论之前就 abort 掉请求。
 * 实测 MiniCPM-V-4.6-Q4_K_M + mmproj、ctx=131072 在 RTX 3060 上冷载约 21.3s；
 * 原 15s 会在模型就绪前中止请求，使 Desktop 误报「启动失败」——虽然引擎侧已改为
 * 取消安全（断连只 detach 不取消，启动仍会跑完），但前端拿到的是假失败结论。
 */
export const SERVICE_ACTION_TIMEOUT_MS = 130_000
/**
 * 引擎端口滑动探测区间长度。
 * 引擎侧在 38400 被占用时会顺延绑定（38400~38419 首个可用端口，见 firefly-ai-engine `config/store.rs`），
 * desktop 协议端点固定在基准端口，故必须在基准端口不可达时扫描该区间并采纳实际端口。
 */
export const PORT_SCAN_RANGE = 20
/** 滑动区间内的单端口探测超时（回环地址被拒绝是即时的，无需长超时） */
export const PORT_PROBE_TIMEOUT_MS = 400
/** 重启前等待旧实例释放端口的时长上限（毫秒） */
export const PORT_RELEASE_WAIT_MS = 8_000

/** 引擎拉起后的就绪等待上限（毫秒）；冷启动含硬件探测，放宽到 40s 避免假超时 */
export const READY_WAIT_LIMIT_MS = 40_000

/**
 * 引擎连续稳定运行该时长后，归还崩溃自愈配额。
 *
 * 与「治愈一次」配合，防止「崩 → 自愈 → 10 秒后又崩」被无限循环拉起来：
 * 只有真正稳定存活满 1 分钟，才算这次自愈成功、下次崩溃仍有 1 次机会。
 */
export const STABLE_RUN_RESET_MS = 60_000
/**
 * 轮询判定离线所需的连续失败次数（迟滞阈值）。
 * 单次探活超时（STATUS_TIMEOUT_MS=1.5s）在引擎忙时（/api/models 持有共享 config 锁、
 * 模型加载、系统卡顿）会瞬时发生，若一次失败立即清 lastRawStatus，Footer 会在
 * 「AI 服务就绪」与「高级AI引擎未运行」之间交替闪烁。连续 3 次失败（约 15~20s）
 * 才判定真离线；期间任一次成功即复位。
 */
export const OFFLINE_CONFIRM_FAILURES = 3

/**
 * 引擎在 desktop 集成目录中的相对目录名（ADR-0033 1:1 镜像）
 * 集成目录 = `<extraResources>/bin/firefly-ai-engine/`，由 `pnpm engine:deploy:watch` 部署
 */
export const ENGINE_BIN_DIR_NAME = 'firefly-ai-engine'

/**
 * 开发态二进制热更新轮询间隔（毫秒）
 * 用于感知 `engine:deploy:watch` 重编译后覆盖集成目录中的 exe
 */
export const DEV_BINARY_WATCH_INTERVAL_MS = 3_000
