/**
 * Stage 2 Analysis Orchestrator Worker 通信协议与安全 Transferable 契约
 *
 * @doc-anchor: docs/specs/stage2-analysis-pipeline-worker-optimization-spec.md#7-通信协议messageport--transferable
 */

import type { AnalysisErrorKind } from './worker-error-classifier'

/** 过期围栏快照（Spec §6.1，无 revision 列，以 workspace_files 物理字段为锚） */
export interface FileGuard {
  workspaceFileId: number
  workspaceId: number
  /** 入队时快照，对应 workspace_files.file_size */
  size: number
  /** 入队时快照，对应 workspace_files.mtime_ms */
  mtimeMs: number
}

/** files 表 UPSERT 白名单字段（Spec §5.3，严禁包含 rating_user_override / sync_status / smart_name* / id） */
export interface FilesWriteWhitelist {
  description?: string | null
  size?: number
  extension: string
  fileGroup?: string | null
  author?: string | null
  language?: string | null
  meta?: string
}

/** 已在 Worker 内经 deflateSync(level:6) 压缩的 file_contents 字段（或明文用于 FTS 投影） */
export interface FileContentsWritePayload {
  /** 已压缩 BLOB（与 text-compressor.ts compressText 同源） */
  contentBlob?: Uint8Array | null
  multimodalContentBlob?: Uint8Array | null
  ocrBlob?: Uint8Array | null
  lrcBlob?: Uint8Array | null
  asrBlob?: Uint8Array | null
  exifBlob?: Uint8Array | null
  /** 明文供 Step 6 syncBodyFts 直写，严禁事务内解压 BLOB */
  plainContent?: string
  plainMultimodalContent?: string
  plainOcr?: string
  plainLrc?: string
  plainAsr?: string
  analysisStats?: string | null
  qualityScore?: number | null
  qualityConfidence?: number | null
  qualityCriteria?: string | null
  qualityReasoning?: string | null
  groupingReason?: string | null
  groupingConfidence?: number | null
  meta?: string
}

/** 单条受控标签关系（Spec §5.1：每项必须携带完整 codePath，供 Step 1 ensureTagPath 回填 path_id） */
export interface TagRelationWriteItem {
  tagCode: string
  viaParentCode: string
  /** 完整物化代码路径（如 "/builtin.file_type/builtin.document"） */
  codePath: string
  tagGroup: 'fact' | 'fused' | 'visual' | 'ai' | 'user' | ''
  confidence: number
  source: 'ai' | 'user' | 'rule'
  meta?: string
}

/** 队列成功状态更新 */
export interface QueueUpdatePayload {
  status: 'completed'
  endTime: string
  result?: string | null
  progress: number
}

/** Worker → 主进程 8 步事务写集（Spec §5.1） */
export interface AnalysisWriteSet {
  /** 对应 analysis_queue.id */
  queueId: number
  /** 入队时快照（Spec §6） */
  guard: FileGuard
  /** 目标文件指纹 */
  fileFingerprint: string
  /** workspace_files.id（逻辑层守卫用） */
  workspaceFileId: number
  /** 物理路径（主进程 Pre-step 异步 stat 用） */
  physicalPath: string
  /** 文件显示名（用于 Step 6 热元数据 FTS 投影） */
  fileName: string
  /** files UPSERT 白名单字段（§5.3） */
  filesUpdate: FilesWriteWhitelist
  /** file_contents UPSERT（可选） */
  fileContents?: FileContentsWritePayload
  /** 分析产出的受控标签关系集合（Step 1 ensureTagPath + Step 5 集合替换） */
  tagRelations?: TagRelationWriteItem[]
  /** 集合替换时按 source 域清除旧标签，默认 'ai' */
  tagReplaceSource?: 'ai' | 'user' | 'rule'
  /** analysis_queue 状态更新（成功路径必填） */
  queueUpdate?: QueueUpdatePayload
  /** 批级尾钩子：内容或标签发生语义变更，需唤醒 canonicalMaintenanceService */
  canonicalVectorWakeup?: boolean
  /** 批级尾钩子：已失效的工作区文件删除记录 */
  workspaceDeletes?: number[]
}

/** 视频分段独立事务写集（Spec §5.6，不参与 8 步文件事务） */
export interface VideoSegmentWriteSet {
  queueId: number
  fileFingerprint: string
  segmentId: string
  chunks: Array<{
    chunkIndex: number
    startSec: number
    endSec: number
    repPtsSec?: number | null
    meta?: string
    samplingIntervalSeconds?: number
  }>
}

/** Worker 可执行的队列任务快照 */
export interface WorkerQueueItem {
  queueId: number
  workspaceId: number
  workspaceFileId: number
  physicalPath: string
  fileName: string
  extension: string
  fileGroup?: string | null
  priority: number
  guard: FileGuard
  /** 若已有指纹可透传，否则 Worker 内流式计算 SHA-256 */
  existingFingerprint?: string | null
  /** 是否提取文本内容（非跳过正文类文件） */
  extractText?: boolean
}

/** Worker 启动与增量更新的只读配置快照（Spec §4） */
export interface WorkerConfigSnapshot {
  omniBaseUrl?: string
  omniToken?: string
  aiEngineBaseUrl?: string
  aiEngineToken?: string
  /** 最大并发（默认 Math.max(1, Math.min(2, os.cpus().length - 2))） */
  maxConcurrent?: number
  /** 文本提取字节上限（默认 256KB） */
  maxTextExtractBytes?: number
  /** HTTP 超时（ms，默认 30000） */
  httpTimeoutMs?: number
}

/** 主进程 → Worker 控制面消息（Spec §7.1） */
export type WorkerInMessage =
  | { type: 'ENQUEUE'; items: WorkerQueueItem[] }
  | { type: 'CANCEL'; queueId: number }
  | { type: 'YIELD_FOR_UI'; timeoutMs: number }
  | { type: 'RESUME' }
  | { type: 'UPDATE_CONFIG'; patch: Partial<WorkerConfigSnapshot> }
  | {
      type: 'WRITE_ACK'
      queueId: number
      result: 'ok' | 'stale' | 'error'
      errorKind?: AnalysisErrorKind
      reason?: string
    }
  | { type: 'SHUTDOWN' }

/** Worker → 主进程 数据面消息（Spec §7.2） */
export type WorkerOutMessage =
  | { type: 'READY' }
  | { type: 'WRITE_SET'; payload: AnalysisWriteSet }
  | { type: 'VIDEO_SEGMENT_WRITE_SET'; payload: VideoSegmentWriteSet }
  | {
      type: 'ANALYSIS_FAILED'
      queueId: number
      errorKind: AnalysisErrorKind
      errorMessage: string
      retryable: boolean
    }
  | { type: 'PROGRESS'; queueId: number; stage: number; pct: number }
  | { type: 'HEARTBEAT'; queueDepth: number; activeCount: number; yielded: boolean; ts: number }
  | { type: 'LOG'; level: 'debug' | 'info' | 'warn' | 'error'; msg: string; ctx?: unknown }

/** Transferable 安全阈值（Spec §7.2 v2.4：16KB 以上才切片转移，严禁转移 8KB Slab 共享池） */
export const TRANSFERABLE_THRESHOLD_BYTES = 16 * 1024

/**
 * 为 AnalysisWriteSet 内的压缩 BLOB 构造安全的 transferList（Spec §7.2 v2.4）。
 *
 * - `>= 16KB`：切片出独立 `ArrayBuffer` 并包装为新 `Uint8Array`，将其底层 buffer 加入 `transferList`；
 * - `< 16KB`：保留在结构化克隆路径，拷贝微秒级且绝不 detach Node.js 8KB Slab 池。
 */
export function prepareWriteSetTransfer(writeSet: AnalysisWriteSet): {
  payload: AnalysisWriteSet
  transferList: ArrayBuffer[]
} {
  const transferList: ArrayBuffer[] = []
  const fc = writeSet.fileContents
  if (!fc) {
    return { payload: writeSet, transferList }
  }

  const cloneField = (buf: Uint8Array | null | undefined): Uint8Array | null | undefined => {
    if (!buf) return buf
    if (buf.byteLength >= TRANSFERABLE_THRESHOLD_BYTES) {
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
      transferList.push(ab)
      return new Uint8Array(ab)
    }
    return buf
  }

  const nextFc: FileContentsWritePayload = {
    ...fc,
    contentBlob: cloneField(fc.contentBlob),
    multimodalContentBlob: cloneField(fc.multimodalContentBlob),
    ocrBlob: cloneField(fc.ocrBlob),
    lrcBlob: cloneField(fc.lrcBlob),
    asrBlob: cloneField(fc.asrBlob),
    exifBlob: cloneField(fc.exifBlob)
  }

  return {
    payload: {
      ...writeSet,
      fileContents: nextFc
    },
    transferList
  }
}
