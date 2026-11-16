/**
 * 模块休眠状态与快照类型定义 (Module Hibernation & Snapshot Types)
 * 遵循 L3 规格书: docs/specs/unified-module-hibernation-and-energy-transparency-spec.md
 */

export type ModuleHibernationState =
  | 'resident' // 正在内存运行 (Active / Loaded)
  | 'loading' // 正在从磁盘冷启动加载模型
  | 'hibernated' // 已休眠回收 (Unloaded, 内存已释放)
  | 'draining' // 正在排空在途任务准备释放
  | 'error' // 加载或释放异常

export type HibernationTargetType = 'omni_module' | 'engine_service'

export interface HibernatableTargetMeta {
  readonly id: string
  readonly type: HibernationTargetType
  readonly clusterId: 'analysis_suite' | 'tts_media'
  readonly defaultMemoryKind: 'ram' | 'vram'
  readonly i18nNameKey: string
  readonly i18nDescKey: string
  readonly estimatedMemoryBytes: number
}

/** 纳管模块元数据字典 (SSOT) */
export const HIBERNATABLE_TARGET_CATALOG: Record<string, HibernatableTargetMeta> = {
  // 群组 A: 文件分析引擎组 (统一生命周期)
  'pocket-cpu-int8-onnx': {
    id: 'pocket-cpu-int8-onnx',
    type: 'omni_module',
    clusterId: 'analysis_suite',
    defaultMemoryKind: 'ram',
    i18nNameKey: '轻量CPU引擎',
    i18nDescKey: '智能润色文件名与生成文件摘要',
    estimatedMemoryBytes: 380 * 1024 * 1024
  },
  'firefly-ai-engine': {
    id: 'firefly-ai-engine',
    type: 'engine_service',
    clusterId: 'analysis_suite',
    defaultMemoryKind: 'vram',
    i18nNameKey: '本地大模型引擎',
    i18nDescKey: '深度理解文档、复杂问答与多模态分析',
    estimatedMemoryBytes: 1800 * 1024 * 1024
  },
  'asr-sensevoice-onnx': {
    id: 'asr-sensevoice-onnx',
    type: 'omni_module',
    clusterId: 'analysis_suite',
    defaultMemoryKind: 'ram',
    i18nNameKey: '语音识别与字幕提取',
    i18nDescKey: '识别音频与视频中的说话内容并转写为文字',
    estimatedMemoryBytes: 250 * 1024 * 1024
  },
  // 群组 B: 语音朗读引擎 (独立按需单元)
  'tts-m5-onnx': {
    id: 'tts-m5-onnx',
    type: 'omni_module',
    clusterId: 'tts_media',
    defaultMemoryKind: 'ram',
    i18nNameKey: '极速语音朗读',
    i18nDescKey: '超快发音速度，顺畅听书与朗读文档',
    estimatedMemoryBytes: 315 * 1024 * 1024
  },
  'tts-moss-onnx': {
    id: 'tts-moss-onnx',
    type: 'omni_module',
    clusterId: 'tts_media',
    defaultMemoryKind: 'ram',
    i18nNameKey: '个性化声音克隆',
    i18nDescKey: '高度还原音色，更具表现力的高品质语音',
    estimatedMemoryBytes: 450 * 1024 * 1024
  }
}

/** 操作系统进程树身份凭据 */
export interface ProcessTreeIdentity {
  readonly pid: number
  readonly startTimeMs: number // 进程创建时间戳
  readonly generation: number // 所属模型代次
  readonly treeHandle?: string // Windows JobObject 名称或 POSIX PGID
}

/** 物理驻留实测固化采样 */
export interface ResidentMemorySample {
  readonly bytes: number
  readonly sampleSeq: number
  readonly sampledAt: number
  readonly modelGeneration: number
  readonly kind: 'ram' | 'vram'
}

/** 历史释放事实快照 */
export interface ReleasedMemorySnapshot {
  readonly bytes: number
  readonly releasedAt: number
  readonly modelGeneration: number
  readonly kind: 'ram' | 'vram'
  readonly state: 'available' | 'reserved'
}

/** 单个模块的运行时物理状态 */
export interface ModuleRuntimeState {
  id: string
  clusterId: 'analysis_suite' | 'tts_media'
  modelGeneration: number
  defaultMemoryKind: 'ram' | 'vram'
  effectiveMemoryKind: 'ram' | 'vram'
  i18nNameKey: string
  state: ModuleHibernationState
  residentBytes: number
  residentSample?: ResidentMemorySample
  lastReleasedBytes?: number
  lastReleased?: ReleasedMemorySnapshot
  lastActiveTimestamp: number
  crashStreak: number
  unloadFailStreak: number
  lastFailureKind?: 'load' | 'unload'
  errorPhase?: 'load' | 'unload'
  errorMessage?: string
  lastErrorI18nKey?: string
  blockedUnloadNoHandle: 0 | 1
  blockedUnloadIdentity: ProcessTreeIdentity | null
}

/** 派生指标视图 (只读) */
export interface ModuleRuntimeMetric extends ModuleRuntimeState {
  /** 只读派生兼容字段：严格由 leaseRegistry.countActiveByTarget 实时计算 */
  readonly activeTasks: number
}

/** 全局快照契约 */
export interface HibernationSnapshot {
  enabled: boolean
  isEnergySaving: boolean
  totalResidentRamBytes: number
  totalResidentVramBytes: number
  totalSavedRamBytes: number
  totalSavedVramBytes: number
  availableMemoryBytes: number
  readonly hasUncertainVramModules: boolean
  readonly hasUncertainMemoryModules: boolean
  readonly uncertainKinds: readonly ('ram' | 'vram')[]
  modules: ModuleRuntimeMetric[]
}

/** SQLite module_runtime_snapshots 行记录结构 */
export interface ModuleRuntimeSnapshotRecord {
  target_id: string
  state: string
  model_generation: number
  resident_bytes: number
  last_released_bytes: number | null
  crash_streak: number
  unload_fail_streak: number
  blocked_unload_no_handle: number
  blocked_unload_identity: string | null
  updated_at: string
}

// ==========================================
// 引用租约中心 (LeaseRegistry) 类型与常量
// ==========================================

export const LEASE_TTL_MS = 90_000 // 90 秒租约单轮心跳有效期
export const LEASE_HEARTBEAT_MS = 30_000 // 30 秒心跳上报推荐周期
export const LEASE_ABSOLUTE_MAX_MS = 1_200_000 // 20 分钟单次租约绝对硬截止

export type WorkflowAbortReason =
  | 'DEADLINE_EXCEEDED'
  | 'IDLE_TIMEOUT'
  | 'MANUAL_STOP'
  | 'TASK_TIMEOUT'
  | 'LEASE_EXPIRED'
  | 'LEASE_REAP_ESCALATED'
  | 'SERVICE_STOPPED'
  | 'APP_TERMINATING'

export interface LivenessSnapshot {
  readonly lastSignalAt: number
  readonly sourceKey: 'task_progress' | 'player_state'
  readonly lastPlaybackState?: 'playing' | 'paused' | 'stopped'
}

export interface LivenessSourceRegistry {
  snapshot(leaseId: string): LivenessSnapshot
  recordSignal(leaseId: string, at: number): void
  recordPlayback(leaseId: string, state: 'playing' | 'paused' | 'stopped', at: number): void
  evict(leaseId: string): void
}

export interface HibernationLeaseHandle {
  readonly leaseId: string
  readonly targetId: string
  readonly clusterId: 'analysis_suite' | 'tts_media'
  release(): void
}

export interface LeaseRegistryEntry {
  leaseId: string
  targetId: string
  clusterId: 'analysis_suite' | 'tts_media'
  grantedAt: number
  expiresAt: number
  absoluteDeadlineAt: number
  rotationCount: number
  abortController: AbortController
  livenessSourceKey: 'task_progress' | 'player_state'
  reaping: boolean
  released: boolean
  terminalized?: boolean
  reapRetryStreak?: number
  reapRetryTimer?: ReturnType<typeof setTimeout>
  expiryTimer?: ReturnType<typeof setTimeout>
}

export interface AcquireLeaseOptions {
  targetId: string
  clusterId?: 'analysis_suite' | 'tts_media'
  livenessSourceKey?: 'task_progress' | 'player_state'
}

// ==========================================
// 动态内存判定与协调器核心调度常量与类型 (Ticket 04)
// ==========================================

export const IDLE_MULTIPLIER_BUCKETS = [
  { maxMs: 2 * 60_000, multiplier: 1.0 }, // < 2 min: 活跃操作期，严守基准线，减少打扰
  { maxMs: 10 * 60_000, multiplier: 1.5 }, // 2 ~ 10 min: 短暂离开，适度放宽回收阈值
  { maxMs: Infinity, multiplier: 2.0 } // > 10 min: 长期无操作，激进回收释放，最大化省电
] as const

export const MEMORY_THRESHOLD_BASE_DIVISOR = 16 // 1/16 物理总内存比例基准线 (6.25%)
export const MIN_MEMORY_THRESHOLD_BYTES = 128 * 1024 * 1024 // 128 MB 下限保护
export const MAX_MEMORY_THRESHOLD_BYTES = 4 * 1024 * 1024 * 1024 // 4 GB 上限钳制
export const MEMORY_HYSTERESIS_RATIO = 1.08 // 8% 滞回抗抖释放比率
export const ANALYSIS_SUITE_IDLE_TIMEOUT_MS = 300_000 // 5 分钟空闲阈值
export const TTS_IDLE_TIMEOUT_MS = 300_000 // 5 分钟空闲阈值
export const MAX_GRACE_PERIOD_MS = 1_200_000 // 20 分钟宽限上限
export const DRAIN_CANCELABLE_WINDOW_MS = 500 // 阶段 1 可撤销窗口
export const CRASH_BREAKER_THRESHOLD = 2 // 连续崩溃熔断阈值
export const UNLOAD_FAIL_ESCALATION = 3 // 卸载失败升级阈值
export const MACOS_FREEMEM_BIAS_MB = 2048 // macOS 经验校准补偿值 (2GB)

export type LifecycleOperation =
  | 'idle_hibernation'
  | 'crash_recovery'
  | 'model_swap'
  | 'unload_retry'
  | 'single_flight_load'

export interface LifecycleToken {
  readonly tokenId: string
  readonly targetId: string
  readonly epoch: number
  readonly modelGeneration: number
  readonly operation: LifecycleOperation
  readonly grantedAt: number
}

export type AdmissionToken = LifecycleToken

// ==========================================
// 看门狗、对账器与崩溃熔断常量与契约 (Ticket 05)
// ==========================================

export const LIFECYCLE_OWNER_MAX_TTL_MS = 60_000 // 60s 属主最大生存周期
export const IN_FLIGHT_OP_STALL_TIMEOUT_MS = 60_000 // 60s 有进度算子停滞判定
export const IN_FLIGHT_OP_NO_PROGRESS_HARD_TIMEOUT_MS = 120_000 // 120s 无进度算子硬超时
export const CANCEL_INTENT_MIN_TTL_MS = 5_000 // 5s 取消意图最小防抖
export const CANCEL_INTENT_HARD_TTL_MS = 60_000 // 60s 取消意图硬超时
export const CRASH_WINDOW_MS = 300_000 // 5分钟 崩溃统计滑动窗口
export const STABLE_RESIDENT_RESET_MS = 60_000 // 1分钟 稳定驻留拉式单调重置门限

/** 在途物理操作条目契约 (InFlightPhysicalOp) */
export interface InFlightPhysicalOp {
  readonly opId: string
  readonly targetId: string
  readonly generation: number
  readonly createdAt: number
  lastProgressAt?: number
  status: 'running' | 'settled' | 'failed_unknown'
  spawnState?: 'spawning' | 'spawned'
  supportsProgress: boolean // 严格必填布尔，无隐式兜底
  extendedTimeoutGranted?: boolean
  abortController?: AbortController
  jobHandle?: string
  identity?: ProcessTreeIdentity
  resolveCompletion?: () => void
}

/** 抑制退出条目契约 (SuppressedStoppingIdentityEntry) */
export interface SuppressedStoppingIdentityEntry {
  readonly targetId: string
  readonly identity: ProcessTreeIdentity
  readonly suppressedAt: number
  unknownRetryCount?: number
  lastRetryAt?: number
  escalatedToPersistentLock?: boolean
}

/** 取消意图条目契约 (TargetCancelIntentEntry) */
export interface TargetCancelIntentEntry {
  readonly targetId: string
  readonly registeredAt: number
}

/** EngineBridgeService 最小能力抽象（供休眠调度器解耦与单测） */
export interface IEngineBridgeService {
  isProcessTreeExited(identity: ProcessTreeIdentity): boolean | 'unknown'
  stopProcessTree(identity: ProcessTreeIdentity): Promise<void>
  forceKillOldGeneration(
    targetId: string,
    generation: number,
    jobHandle?: string
  ): Promise<'killed' | 'no_handle' | 'unknown'>
  awaitProcessTreeExit(
    identity: ProcessTreeIdentity,
    timeoutMs: number
  ): Promise<'exited' | 'timeout' | 'unknown'>
}
