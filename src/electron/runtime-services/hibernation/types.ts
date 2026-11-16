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
