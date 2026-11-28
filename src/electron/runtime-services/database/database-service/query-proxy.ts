import { DatabaseInitMixin } from './init'

import {
  type FileInfo,
  type LanguageCode,
  type WorkspaceDirectory,
  type Unit,
  type UnitCreationData,
  type VideoChunkRecord,
  type WorkspaceConfig,
  type LocalWorkflowRecord,
  parseWorkspaceConfig
} from '@firefly/types'
import {
  LogCategory,
  logger,
  isTestEnvironment,
  getCanonicalConceptName,
  isTagAdmissible,
  resolveRuntimeMaterializedPath,
  ensureTagPath,
  CONTROLLED_CONCEPTS,
  CONTROLLED_DIMENSION_ROOT_CODES,
  concept,
  isControlledConcept,
  isControlledDimensionApplicableInDomain,
  getParentDimensionCodeOfTag,
  CONTROLLED_CONCEPT_DETAILS,
  classifyDimensionMutexScope,
  resolveMediaDomain,
  getFileCategory,
  CONTROLLED_CODE_TO_CANONICAL_NAME,
  DIMENSION_CODES,
  type TagProvenanceGroup
} from '@firefly/shared'
import {
  findTagCodeTwoStage,
  getDatabaseConfig,
  migrations,
  normalizeSupportedLocale,
  rebuildDebugTagViews,
  registerDatabaseFunctions,
  seedTagAliasesSingleTable
} from '.././database'
import { omniClient } from '../../../services/omni-client'

import Database from 'better-sqlite3'
import { calculateFileFingerprint, normalizeFileExtension } from '@firefly/shared'
import * as fs from 'fs'
import * as path from 'path'
import { t } from '@app/languages'

import { WorkspaceDao, FileDao, TagUnitDao, QueueDao, LocalWorkflowDao } from '.././dao'
import type { AnalysisTaskType } from '.././dao'
import {
  DeterministicCodeGenerator,
  preResolveControlledCandidates,
  isUnresolvedControlledLemma
} from '@firefly/core-engine'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'
import { AccessTimeBatchUpdater } from '.././access-time-batch-updater'
import { loadIgnoreRules, shouldIgnoreFile } from '../../analysis/analysis-ignore-service'
import type { IIgnoreRule } from '@firefly/types/settings-types'
import { ConfigDbManager } from '../../config/config-db-manager'
import { getWriterLeaseHandshake } from './writer-lease-seam'
import { getCachedStatement } from '@pro/perf/statement-cache'

/* ==================== W4/J-13 批量入库两段式契约 ==================== */

/** J-13 异步准备阶段最小输入（路径为原生分隔符，BINARY 精确匹配，严禁归一化） */
export interface PreparedFileUpsertInput {
  filePath: string
  /** 调用方已算好的指纹（watcher/目录处理器复用，避免重复哈希 I/O） */
  fileFingerprint?: string | null
  /**
   * true = 复用既有指纹，事务内传 null 由 SQL COALESCE 保留旧值。
   * 严禁把 skipHash 的 null 直接写库抹掉已分析指纹（会触发 trg_wf_update_orphan_gc 误删资产）。
   */
  skipHash?: boolean
}

/** J-13 落库选项 */
export interface UpsertPreparedFilesBatchOptions {
  workspaceId: number
  /** 遇错即停（directory-processor 语义）默认 true；逐行容错（watcher/入队补录）传 false */
  stopOnError?: boolean
  /** 单批上限，默认 200（J-13 短事务），硬封顶 200 */
  batchSize?: number
  /** 批间复检：返回 true 则丢弃剩余批次（取消信号） */
  isCancelled?: () => boolean
  /** 工作区代际读取：批间复检，与进入时不一致则丢弃剩余批次 */
  getWorkspaceGeneration?: () => number
  /** 单批落库持有写锁耗时回调（实测 p99/Max 采样点） */
  onBatchHoldMs?: (ms: number, batchSize: number) => void
}

/** J-13 落库结果（与输入等长，失败项 null） */
export interface UpsertPreparedFilesBatchResult {
  ids: (number | null)[]
  /** 每次 .immediate() 获取写锁等待耗时（ms） */
  writeLockWaitMs: number[]
  /** 本轮单事务最大持锁时长（ms） */
  maxTransactionHoldMs: number
  /** 因取消/工作区代际失效丢弃的条目数 */
  droppedCount: number
}

/** 模块级：按 workspaceId 的 FIFO 串行调度链（防幽灵行约束 1） */
const j13IngestChains = new Map<number, Promise<unknown>>()
/** 模块级：每路径单调序号（准备期间被覆盖的旧条目进入短事务前一律丢弃） */
const j13PathSequences = new Map<string, number>()
/** 模块级：工作区代际（删目录/工作区/unlink 时推进，批间复检） */
const j13WorkspaceGenerations = new Map<number, number>()

/**
 * 推进工作区代际（防幽灵行）：删除文件/目录/工作区或 reset 分析后必须调用，
 * 使准备期间产出但尚未落库的旧条目在批间复检时被丢弃，严禁复活已删除路径。
 */
export function bumpJ13WorkspaceGeneration(workspaceId: number): void {
  j13WorkspaceGenerations.set(workspaceId, (j13WorkspaceGenerations.get(workspaceId) ?? 0) + 1)
}

/** 读取工作区当前代际（供外部在 options.getWorkspaceGeneration 注入） */
export function getJ13WorkspaceGeneration(workspaceId: number): number {
  return j13WorkspaceGenerations.get(workspaceId) ?? 0
}

/** J-13 准备阶段产物（异步准备 → 同步短事务消费，携带路径序号防幽灵行） */
interface J13PreparedRow {
  index: number
  filePath: string
  fingerprint: string | null
  directoryId: number
  size: number
  mtimeMs: number
  mtimeIso: string
  birthtimeIso: string
  atimeIso: string
  isIgnored: number
  isAnalyzed: number
  sequence: number
}

/** J-13 单批硬上限（§5.1 第一段：每批 ≤200 行短事务） */
const J13_MAX_BATCH_SIZE = 200
/** 写锁瞬态竞争退避重试次数（§4.2：仅在事务外指数退避） */
const J13_MAX_RETRIES = 2

/**
 * DatabaseService 查询代理 mixin（Ticket 07）。
 * 承载 DAO 转发、批量标签、标签展示名、向量代理与视频片段代理。
 * 全部代码自 database-service.ts 原样搬移，未改动查询语义。
 */
export class DatabaseQueryProxyMixin extends DatabaseInitMixin {
  // --- DAO Forwarding Methods ---

  async addFileFromPath(
    filePath: string,
    rootPath: string,
    existingWorkspaceId?: number,
    skipHash = false
  ): Promise<number | null> {
    try {
      const stats = fs.statSync(filePath)
      if (!stats.isFile()) {
        return null
      }
    } catch (error) {
      return null
    }

    const dirPath = path.dirname(filePath)
    const directoryId = await this.addDirectory(dirPath, existingWorkspaceId)

    let workspaceId = existingWorkspaceId
    if (!workspaceId) {
      const dirRecord = this._db!.prepare(
        'SELECT workspace_id FROM workspace_directories WHERE id = ?'
      ).get(Number(directoryId)) as any
      workspaceId = dirRecord?.workspace_id
    }

    if (!workspaceId) {
      return null
    }

    let fileFingerprint: string | null = null
    const existing = this._db!.prepare(
      `SELECT id, file_fingerprint, is_analyzed FROM workspace_files WHERE workspace_id = ? AND path = ?`
    ).get(workspaceId, filePath) as any

    if (skipHash) {
      fileFingerprint = existing?.file_fingerprint || null
    } else {
      fileFingerprint = await calculateFileFingerprint(filePath)
    }

    // SC-1：提前取物理 stats，供 workspace_files 维护 file_size/mtime_ms 预计算列（免 LEFT JOIN files）
    // 安全守卫：skipHash 且文件不存在时 statSync 会抛错，回退 0 值（与 DDL DEFAULT 0 一致）
    let stats: fs.Stats | null = null
    try {
      stats = fs.statSync(filePath)
    } catch {
      stats = null
    }
    const physicalSize = stats?.size ?? 0
    const physicalMtimeMs = Math.trunc(stats?.mtimeMs ?? Date.now())
    const physicalIsIgnored = shouldIgnoreFile(filePath, path.basename(filePath), loadIgnoreRules())
      ? 1
      : 0

    if (fileFingerprint && stats) {
      this._db!.prepare(
        `INSERT OR IGNORE INTO files (file_fingerprint, smart_name, size, extension, file_group, created_at, modified_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        fileFingerprint,
        path.basename(filePath),
        stats.size,
        normalizeFileExtension(filePath),
        JSON.stringify({ mime_type: 'application/octet-stream' }),
        stats.birthtime.toISOString(),
        stats.mtime.toISOString(),
        stats.atime.toISOString()
      )
      this._db!.prepare(`INSERT OR IGNORE INTO file_contents (file_fingerprint) VALUES (?)`).run(
        fileFingerprint
      )
    }

    this._db!.prepare(
      `
      INSERT INTO workspace_files (file_fingerprint, workspace_id, directory_id, path, name, created_at, modified_at, accessed_at, is_analyzed, file_size, mtime_ms, is_ignored)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, path) DO UPDATE SET
        file_fingerprint = excluded.file_fingerprint,
        modified_at = excluded.modified_at,
        file_size = excluded.file_size,
        mtime_ms = excluded.mtime_ms,
        is_ignored = excluded.is_ignored
    `
    ).run(
      fileFingerprint,
      workspaceId,
      directoryId,
      filePath,
      path.basename(filePath),
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
      existing?.is_analyzed || 0,
      physicalSize,
      physicalMtimeMs,
      physicalIsIgnored
    )

    const wf = this._db!.prepare(
      `SELECT id FROM workspace_files WHERE workspace_id = ? AND path = ?`
    ).get(workspaceId, filePath) as any
    return wf?.id || null
  }

  /**
   * [Issue 04 Step 2] 物理文件移动后的数据库更新：改走 FileSystemMutationDao，
   * 单事务原子更新 workspace_files(path/name/directory_id/mtime_ms/modified_at)，
   * name 变更由 FileSystemMutationDao 在同一事务内显式调用 syncFTSTags 重建 files_meta_fts / files_pinyin_fts
   * （创世基线已废除 trg_workspace_files_fts_update 内联写触发器）。
   * @param oldPath 原绝对路径
   * @param newPath 新绝对路径
   * @param statMtimeMs 移动后文件 mtime_ms（Math.trunc(stats.mtimeMs)，FileGuard 围栏锚点）
   */
  async updateFilePath(oldPath: string, newPath: string, statMtimeMs?: number): Promise<void> {
    await this.addDirectory(path.dirname(newPath))
    this.fsMutationDao.updateFilePathAtomic(oldPath, newPath, statMtimeMs)
  }

  async addDirectory(dirPath: string, existingWorkspaceId?: number): Promise<number> {
    const exists = this._db!.prepare(
      'SELECT id, workspace_id FROM workspace_directories WHERE path = ?'
    ).get(dirPath) as any
    if (exists) return exists.id

    let workspaceId = existingWorkspaceId
    if (!workspaceId) {
      const rootWorkspace = await this.findRootWorkspaceDirectory(dirPath)
      if (rootWorkspace && rootWorkspace.id) {
        workspaceId = rootWorkspace.id
      }
    }

    if (!workspaceId) {
      throw new Error(`目录不属于任何已注册工作空间: ${dirPath}`)
    }

    const now = new Date().toISOString()
    const stmt = this._db!.prepare(
      `INSERT INTO workspace_directories (workspace_id, path, name, created_at, modified_at) VALUES (?, ?, ?, ?, ?)`
    )
    const result = stmt.run(workspaceId, dirPath, path.basename(dirPath), now, now)
    return Number(result.lastInsertRowid)
  }

  async resetWorkspaceDirectoryAnalysis(directoryPath: string): Promise<string[]> {
    if (!this._db) throw new Error('数据库未初始化')

    const sep = path.sep
    const likePattern = directoryPath.endsWith(sep)
      ? `${directoryPath}%`
      : `${directoryPath}${sep}%`

    // 1. 先一次性提取受影响的目录 ID 列表
    const dirRows = this._db
      .prepare(`SELECT id FROM workspace_directories WHERE path = ? OR path LIKE ?`)
      .all(directoryPath, likePattern) as { id: number }[]
    const dirIds = dirRows.map(r => r.id)

    if (dirIds.length === 0) return []

    const batchSize = 500

    // 1.1 提取当前重置目录集内的全量文件指纹
    const allFingerprintsSet = new Set<string>()
    for (let i = 0; i < dirIds.length; i += batchSize) {
      const batch = dirIds.slice(i, i + batchSize)
      const placeholders = batch.map(() => '?').join(',')
      const fpRows = this._db
        .prepare(
          `SELECT DISTINCT file_fingerprint FROM workspace_files WHERE directory_id IN (${placeholders}) AND file_fingerprint IS NOT NULL`
        )
        .all(...batch) as { file_fingerprint: string }[]
      for (const r of fpRows) {
        allFingerprintsSet.add(r.file_fingerprint)
      }
    }
    const allFingerprints = Array.from(allFingerprintsSet)

    // 1.2 [RV-03] 跨工作区孤儿文件过滤
    // 独占孤儿指纹 = 仅被当前重置目录集引用，未被其他工作区目录共享的指纹。
    // 共享文件（被其他工作区引用）只重置 workspace_files.is_analyzed，不清除全局摘要与向量。
    // 使用子查询匹配目录集，杜绝在 IN 子句中重复解构大量 dirIds 突破 SQLite 变量上限
    const orphanFingerprintsSet = new Set<string>()
    for (let i = 0; i < allFingerprints.length; i += batchSize) {
      const batch = allFingerprints.slice(i, i + batchSize)
      const fpPlaceholders = batch.map(() => '?').join(',')
      const orphanRows = this._db
        .prepare(
          `SELECT DISTINCT wf1.file_fingerprint
           FROM workspace_files wf1
           WHERE wf1.file_fingerprint IN (${fpPlaceholders})
             AND NOT EXISTS (
               SELECT 1 FROM workspace_files wf2
               WHERE wf2.file_fingerprint = wf1.file_fingerprint
                 AND wf2.directory_id NOT IN (
                   SELECT id FROM workspace_directories WHERE path = ? OR path LIKE ?
                 )
             )`
        )
        .all(...batch, directoryPath, likePattern) as { file_fingerprint: string }[]
      for (const r of orphanRows) {
        orphanFingerprintsSet.add(r.file_fingerprint)
      }
    }
    const orphanFingerprints = Array.from(orphanFingerprintsSet)

    // 1.3 收集独占孤儿切片指纹（Omni 向量库中以 ${fp}:c${chunkIndex} 存储）
    const orphanFingerprintsToDelete: string[] = [...orphanFingerprints]
    if (orphanFingerprints.length > 0) {
      for (let i = 0; i < orphanFingerprints.length; i += batchSize) {
        const batch = orphanFingerprints.slice(i, i + batchSize)
        const placeholders = batch.map(() => '?').join(',')
        try {
          const chunkRows = this._db
            .prepare(
              `SELECT file_fingerprint, chunk_index FROM file_video_chunks WHERE file_fingerprint IN (${placeholders})`
            )
            .all(...batch) as Array<{ file_fingerprint: string; chunk_index: number }>
          for (const row of chunkRows) {
            orphanFingerprintsToDelete.push(`${row.file_fingerprint}:c${row.chunk_index}`)
          }
        } catch (chunkErr) {
          logger.warn(LogCategory.DATABASE_SERVICE, '重置目录查询孤儿切片指纹失败:', chunkErr)
        }
      }
    }

    // 2. 事务内批量重置
    this._db.transaction(() => {
      // 2.1 全量重置：目录与文件的分析状态（含共享文件，只重置 workspace 层标记）
      for (let i = 0; i < dirIds.length; i += batchSize) {
        const batch = dirIds.slice(i, i + batchSize)
        const placeholders = batch.map(() => '?').join(',')

        this._db!.prepare(
          `UPDATE workspace_directories SET is_analyzed = 0, context_analysis = NULL, last_analyzed_at = NULL WHERE id IN (${placeholders})`
        ).run(...batch)

        this._db!.prepare(
          `UPDATE workspace_files SET is_analyzed = 0, last_analyzed_at = NULL, analysis_error = NULL WHERE directory_id IN (${placeholders})`
        ).run(...batch)
      }

      // 2.2 仅对独占孤儿文件：清除全局摘要与索引数据，防止跨工作区误伤
      if (orphanFingerprints.length > 0) {
        for (let i = 0; i < orphanFingerprints.length; i += batchSize) {
          const batch = orphanFingerprints.slice(i, i + batchSize)
          const placeholders = batch.map(() => '?').join(',')

          this._db!.prepare(
            `UPDATE files
              SET description = NULL,
                  author = NULL,
                  language = NULL,
                  is_hit = 0,
                  last_hit_at = NULL,
                  canonical_vector_state = NULL,
                  canonical_text_hash = NULL,
                  smart_name_source = NULL,
                  smart_name_template_source = NULL,
                  smart_name = (SELECT name FROM workspace_files wf WHERE wf.file_fingerprint = files.file_fingerprint LIMIT 1)
              WHERE file_fingerprint IN (${placeholders})`
          ).run(...batch)

          this._db!.prepare(
            `UPDATE file_contents
              SET content = NULL,
                  multimodal_content = NULL,
                  lrc = NULL,
                  exif = NULL,
                  analysis_stats = NULL,
                  quality_score = NULL,
                  quality_confidence = NULL,
                  quality_criteria = NULL,
                  quality_reasoning = NULL,
                  grouping_reason = NULL,
                  grouping_confidence = NULL
              WHERE file_fingerprint IN (${placeholders})`
          ).run(...batch)

          this._db!.prepare(
            `DELETE FROM file_tag_relations WHERE file_fingerprint IN (${placeholders})`
          ).run(...batch)

          // [RV-03] 清理 file_video_segments：防止切片 completed 状态残留导致重置后调度器跳过重新分析
          // 注：file_video_segments 创世 DDL 外键列名为 file_id (REFERENCES files(file_fingerprint))
          this._db!.prepare(
            `DELETE FROM file_video_segments WHERE file_id IN (${placeholders})`
          ).run(...batch)

          // 清理视频分块记录，确保再次分析时切片重新计算
          this._db!.prepare(
            `DELETE FROM file_video_chunks WHERE file_fingerprint IN (${placeholders})`
          ).run(...batch)

          try {
            this._db!.prepare(
              `DELETE FROM file_tags_private WHERE file_fingerprint IN (${placeholders})`
            ).run(...batch)
          } catch {
            // 忽略非必选私有标签表异常
          }
        }
      }

      // 2.3 清理分析队列中属于当前重置目录的条目
      for (let i = 0; i < dirIds.length; i += batchSize) {
        const batch = dirIds.slice(i, i + batchSize)
        const placeholders = batch.map(() => '?').join(',')
        this._db!.prepare(
          `DELETE FROM analysis_queue 
            WHERE (item_type = 'directory' AND item_id IN (${placeholders}))
               OR (item_type = 'file' AND item_id IN (SELECT id FROM workspace_files WHERE directory_id IN (${placeholders})))`
        ).run(...batch, ...batch)
      }
    })()

    // 仅返回独占孤儿指纹供 Phase 2 删除 Omni 向量（共享文件向量不得删除）
    return orphanFingerprintsToDelete
  }

  // --- DAO Methods ---
  async getFileAnalysisResult(p: string) {
    return this.fileDao.getFileAnalysisResult(p)
  }
  async getDirectoryAnalysisResult(p: string) {
    return this.fileDao.getDirectoryAnalysisResult(p)
  }
  async updateFileAnalysisResult(id: string, r: any) {
    return this.fileDao.updateFileAnalysisResult(id, r)
  }
  async resolveUniqueSmartName(
    smartName: string,
    excludeFingerprint: string,
    workspaceId: number
  ): Promise<string> {
    return this.fileDao.resolveUniqueSmartName(smartName, excludeFingerprint, workspaceId)
  }
  async updateAnalysisStage(fileFingerprint: string, stage: number): Promise<void> {
    return this.fileDao.updateAnalysisStage(fileFingerprint, stage)
  }
  /**
   * 补齐单个文件的「已分析完成」标记（幂等）。
   * 供分析管道在提前结束的路径上回写状态，避免队列已完成但 is_analyzed 仍为 0。
   */
  async markFileAnalyzed(workspaceId: number, filePath: string): Promise<number> {
    return this.fileDao.markFileAnalyzed(workspaceId, filePath)
  }
  async updateAnalysisStageAndQuality(
    fileFingerprint: string,
    stage: number,
    qualityData?: {
      qualityScore?: number | null
      qualityConfidence?: number | null
      qualityReasoning?: string | null
      qualityCriteria?: any | null
    }
  ): Promise<void> {
    return this.fileDao.updateAnalysisStageAndQuality(fileFingerprint, stage, qualityData)
  }
  syncFTSTags(fingerprint: string): void {
    if (this.fileDao) {
      this.fileDao.syncFTSTags(fingerprint)
    }
  }

  /** P1-D 方案 B：分批刷新 pinyin_state=0 的脏文件（后台调用，非冷启动全库同步） */
  syncPinyinPendingBatch(limit = 200): number {
    return this.fileDao ? this.fileDao.syncPinyinPendingBatch(limit) : 0
  }

  syncFTSTagsBatch(fingerprints: string[]): void {
    if (this.fileDao) {
      this.fileDao.syncFTSTagsBatch(fingerprints)
    }
  }

  clearDimensionsCache(): void {
    if (this.fileDao) {
      this.fileDao.clearDimensionsCache()
    }
  }
  async getAllFiles(limit?: number, offset?: number) {
    return this.fileDao.getAllFiles(limit, offset)
  }
  async searchFilesFTS(q: string, wsId?: number) {
    return this.fileDao.searchFilesFTS(q, wsId)
  }
  async searchVirtualDirectoryFiles(keyword: string, virtualDirectoryId?: number): Promise<any[]> {
    return this.fileDao.searchVirtualDirectoryFTS(keyword, virtualDirectoryId)
  }
  async countAnalyzedFilesByWorkspace(wsId: number): Promise<number> {
    return this.fileDao.countAnalyzedFilesByWorkspace(wsId)
  }
  async getAnalyzedFilesByWorkspace(wsId: number, limit?: number) {
    return this.fileDao.getAnalyzedFilesByWorkspace(wsId, limit)
  }
  async getAnalyzedFileByContentHash(h: string) {
    return this.fileDao.getAnalyzedFileByContentHash(h)
  }
  async getFileByPath(p: string) {
    return this.fileDao.getFileByPath(p)
  }
  /**
   * 按文件 ID 或路径获取文件分析数据（供外部 API 与技能调用）
   */
  async getFileAnalysisData(fileIdOrPath: number | string, _fields?: string[]) {
    if (
      typeof fileIdOrPath === 'string' &&
      (fileIdOrPath.includes('/') || fileIdOrPath.includes('\\'))
    ) {
      return this.fileDao.getFileByPath(fileIdOrPath)
    }
    const id = Number(fileIdOrPath)
    if (!id || isNaN(id)) return null
    const path = this.fileDao.getFilePathById(id)
    if (!path) return null
    return this.fileDao.getFileByPath(path)
  }
  /**
   * 分页获取文件分析数据（供外部 API 与技能调用）
   */
  async getPagedFileAnalysisData(limit = 20, offset = 0, _fields?: string[]) {
    return this.fileDao.getAllFiles(limit, offset)
  }
  /**
   * 按工作区路径取文件指纹（轻量查询，不加载 contents）。
   *
   * 供只有路径、需要指纹的场景使用（如 Stage 5 高维修正解析队列项指纹）。
   * 服务层不应自行拼 SQL——指纹所在表与列名属 DAO 的领域知识。
   */
  getFileFingerprintByPath(filePath: string): string | null {
    return this.fileDao.getFileFingerprintByPath(filePath)
  }
  async getFilesByParentPath(p: string, wsId: number) {
    return this.fileDao.getFilesByParentPath(p, wsId)
  }
  /**
   * SC-2：目录增量扫描专用存量读取（零 LEFT JOIN files，直击 idx_wf_diff_cover 覆盖索引）。
   * 仅返回增量 diff 所需字段，根治「未分析文件 files.size 为 NULL → LEFT JOIN 后恒失配重扫」Bug。
   * file_size/mtime_ms 为切片A 预计算列，未分析文件（file_fingerprint IS NULL）亦有物理值可比对。
   */
  async getWorkspaceFilesForDiffScan(wsId: number, dirId: number) {
    if (!this._db) throw new Error('数据库未初始化')
    return this._db
      .prepare(
        `
      SELECT id, path, name, file_fingerprint, file_size, mtime_ms, is_ignored, is_analyzed, status, modified_at
      FROM workspace_files
      WHERE workspace_id = ? AND directory_id = ? AND status = 1
    `
      )
      .all(wsId, dirId) as any[]
  }
  /**
   * SC-4：排除规则变更后异步分批重算 workspace_files.is_ignored 预计算列。
   * 每批 2000 行分事务更新，严禁长事务锁死主库阻塞并发读写（实施铁律 4）。
   * @returns { totalChecked, updatedToIgnored, updatedToActive } 统计（无翻转则 0 写盘）
   */
  async refreshWorkspaceFilesIgnoredState(rules?: IIgnoreRule[]): Promise<{
    totalChecked: number
    updatedToIgnored: number
    updatedToActive: number
  }> {
    if (!this._db) throw new Error('数据库未初始化')
    const activeRules = rules && rules.length > 0 ? rules : loadIgnoreRules()

    const rows = this._db
      .prepare(`SELECT id, path, name, is_ignored FROM workspace_files`)
      .all() as Array<{ id: number; path: string; name: string; is_ignored: number }>

    const BATCH_SIZE = 2000
    let updatedToIgnored = 0
    let updatedToActive = 0
    let totalChecked = 0

    const toIgnoreIds: number[] = []
    const toActiveIds: number[] = []
    for (const row of rows) {
      totalChecked++
      const newIgnored = shouldIgnoreFile(row.path, row.name, activeRules) ? 1 : 0
      if (newIgnored !== row.is_ignored) {
        if (newIgnored === 1) toIgnoreIds.push(row.id)
        else toActiveIds.push(row.id)
      }
    }

    const now = new Date().toISOString()
    const updateStmt = this._db.prepare(
      `UPDATE workspace_files SET is_ignored = ?, modified_at = ? WHERE id = ?`
    )
    const runBatch = (ids: number[], target: number) => {
      for (let i = 0; i < ids.length; i += BATCH_SIZE) {
        const batch = ids.slice(i, i + BATCH_SIZE)
        this._db!.transaction(() => {
          for (const id of batch) updateStmt.run(target, now, id)
        })()
      }
    }

    runBatch(toIgnoreIds, 1)
    runBatch(toActiveIds, 0)
    updatedToIgnored = toIgnoreIds.length
    updatedToActive = toActiveIds.length

    logger.info(
      LogCategory.DATABASE_SERVICE,
      `[SC-4] 排除规则变更刷新 is_ignored: 检查 ${totalChecked} 行, 标记忽略 ${updatedToIgnored}, 恢复活跃 ${updatedToActive}`
    )
    return { totalChecked, updatedToIgnored, updatedToActive }
  }
  async getFilesByWorkspaceId(workspaceId: number) {
    if (!this._db) throw new Error('数据库未初始化')
    return this._db
      .prepare(
        `
      SELECT wf.id, wf.path, wf.name, wf.is_analyzed, wf.status, wf.file_fingerprint, f.smart_name
      FROM workspace_files wf
      LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
      WHERE wf.workspace_id = ?
    `
      )
      .all(workspaceId) as any[]
  }
  async updateFileMetadata(p: string, s: fs.Stats) {
    return this.fileDao.updateFileMetadata(p, s)
  }
  async updateFileHitStatus(h: string, h2: boolean) {
    return this.fileDao.updateFileHitStatus(h, h2)
  }
  async updateFileThumbnail(p: string, t: string | null) {
    return this.fileDao.updateFileThumbnail(p, t)
  }
  async resetFileAnalysis(p: string) {
    return this.fileDao.resetFileAnalysis(p)
  }
  async updateFileModifiedTime(p: string, m: Date) {
    return this.updateFileMetadata(p, fs.statSync(p))
  }

  // --- Workspace Methods ---
  async addWorkspaceDirectory(d: WorkspaceDirectory) {
    await this.ensureInitialized()
    if (!this.workspaceDao) return null
    const wsId = await this.workspaceDao.add(d)
    await this.addDirectory(d.path, wsId)
    return wsId
  }
  async getAllWorkspaceDirectories() {
    await this.ensureInitialized()
    if (!this.workspaceDao) return []
    return this.workspaceDao.getAll()
  }
  async getWorkspaceDirectoriesWithStats() {
    await this.ensureInitialized()
    if (!this.workspaceDao) return []
    return this.workspaceDao.getAllWithStats()
  }
  async getCurrentWorkspaceDirectory() {
    await this.ensureInitialized()
    if (!this.workspaceDao) return null
    return this.workspaceDao.getCurrent()
  }
  async setCurrentWorkspaceDirectory(p: string) {
    await this.ensureInitialized()
    if (!this.workspaceDao) return
    return this.workspaceDao.setCurrent(p)
  }
  async deleteWorkspaceDirectory(p: string) {
    await this.ensureInitialized()
    if (!this.workspaceDao) return
    const wsId = await this.getWorkspaceIdByPath(p)
    const deleted = await this.workspaceDao.delete(p)
    if (typeof wsId === 'number' && wsId > 0) {
      bumpJ13WorkspaceGeneration(wsId)
    }
    return deleted
  }
  async updateWorkspaceDirectoryAutoWatch(id: number, a: boolean) {
    if (!this.workspaceDao) return
    return this.workspaceDao.updateAutoWatch(id, a)
  }
  async updateAutoWatch(id: number, a: boolean) {
    return this.updateWorkspaceDirectoryAutoWatch(id, a)
  }
  async updateWorkspaceDirectoryLastScan(id: number) {
    if (!this.workspaceDao) return
    return this.workspaceDao.updateLastScan(id)
  }
  async updateWorkspaceWhitelistPatterns(
    workspaceId: number,
    patterns: string[]
  ): Promise<boolean> {
    await this.ensureInitialized()
    if (!this.workspaceDao) return false
    return this.workspaceDao.updateWhitelistPatterns(workspaceId, patterns)
  }
  async calculateWhitelistImpact(workspaceId: number, patterns: string[]) {
    await this.ensureInitialized()
    if (!this.workspaceDao) return { totalFiles: 0, includedFiles: 0, excludedFiles: 0 }
    return this.workspaceDao.calculateWhitelistImpact(workspaceId, patterns)
  }
  async updateWorkspaceBoundWorkflow(
    workspaceId: number,
    workflowId: string | null
  ): Promise<boolean> {
    await this.ensureInitialized()
    if (!this.workspaceDao) return false
    return this.workspaceDao.updateBoundWorkflow(workspaceId, workflowId)
  }
  deleteAnalysisQueueItems(ids: number[]): void {
    if (!this._db || ids.length === 0) return
    const CHUNK_SIZE = 500
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE)
      const placeholders = chunk.map(() => '?').join(',')
      this._db.prepare(`DELETE FROM analysis_queue WHERE id IN (${placeholders})`).run(...chunk)
    }
  }
  async getWorkspaceDirectoryById(id: number) {
    if (!this.workspaceDao) return null
    return this.workspaceDao.getById(id)
  }
  async getWorkspaceDirectoryByPath(p: string) {
    if (!this.workspaceDao) return null
    return this.workspaceDao.getByPath(p)
  }
  async findRootWorkspaceDirectory(p: string) {
    if (!this.workspaceDao) return null
    return this.workspaceDao.findRoot(p)
  }
  async getWorkspaceIdByPath(p: string) {
    if (!this.workspaceDao) return null
    return (await this.workspaceDao.findRoot(p))?.id || null
  }

  /**
   * 获取工作区专有配置 (已就绪强类型或待配置对象)
   */
  async getWorkspaceConfig(workspaceId: number): Promise<WorkspaceConfig> {
    await this.ensureInitialized()
    if (!this.workspaceDao) return parseWorkspaceConfig(null)
    return this.workspaceDao.getConfig(workspaceId)
  }

  /**
   * 更新工作区专有配置
   */
  async updateWorkspaceConfig(workspaceId: number, config: WorkspaceConfig): Promise<boolean> {
    await this.ensureInitialized()
    if (!this.workspaceDao) return false
    return this.workspaceDao.updateConfig(workspaceId, config)
  }

  /**
   * 检查工作区是否已配置就绪 (调度前置门闩硬校验)
   */
  async isWorkspaceConfigReady(workspaceId: number): Promise<boolean> {
    await this.ensureInitialized()
    if (!this.workspaceDao) return false
    return this.workspaceDao.isConfigReady(workspaceId)
  }

  /**
   * 确保工作区配置处于就绪状态 (若为 pending，自适应赋予默认未绑定工作流的就绪策略)
   */
  async ensureWorkspaceConfigReady(workspaceId: number): Promise<boolean> {
    await this.ensureInitialized()
    if (!this.workspaceDao) return false
    return this.workspaceDao.ensureConfigReady(workspaceId)
  }

  // --- Local Workflow Methods ---
  async getLocalWorkflowById(id: string): Promise<LocalWorkflowRecord | undefined> {
    await this.ensureInitialized()
    if (!this.localWorkflowDao) return undefined
    return this.localWorkflowDao.getById(id)
  }

  async getAllLocalWorkflows(): Promise<LocalWorkflowRecord[]> {
    await this.ensureInitialized()
    if (!this.localWorkflowDao) return []
    return this.localWorkflowDao.getAll()
  }

  async saveLocalWorkflow(
    record: Omit<LocalWorkflowRecord, 'created_at' | 'modified_at'>
  ): Promise<boolean> {
    await this.ensureInitialized()
    if (!this.localWorkflowDao) return false
    return this.localWorkflowDao.upsert(record)
  }

  async deleteLocalWorkflow(id: string): Promise<boolean> {
    await this.ensureInitialized()
    if (!this.localWorkflowDao) return false
    return this.localWorkflowDao.delete(id)
  }

  // --- Tag & Unit Methods ---
  async createUnit(d: UnitCreationData) {
    return this.tagUnitDao.createUnit(d)
  }
  async getUnit(id: number) {
    return this.tagUnitDao.getUnit(id)
  }
  async updateUnit(id: number, p: Partial<Unit>) {
    return this.tagUnitDao.updateUnit(id, p)
  }
  async deleteUnit(id: number) {
    return this.tagUnitDao.deleteUnit(id)
  }
  async getUnitsForFile(id: number) {
    return this.tagUnitDao.getUnitsForFile(id)
  }
  async createFileUnitRelation(id: number, uid: number) {
    return this.tagUnitDao.createFileUnitRelation(id, uid)
  }
  async getUnitsForPath(p: string) {
    return this.tagUnitDao.getUnitsForPath(p)
  }
  async getFileTagsByFileId(f: string) {
    return this.tagUnitDao.getFileTagsByFileId(f)
  }

  // --- Queue Methods ---
  getAnalysisQueue() {
    return this.queueDao.getAnalysisQueue()
  }
  /** 抢占式提取队头待办任务（普通分析恒优先于高维修正，ADR-0046 / CONTEXT.md 抢占式单队列调度） */
  fetchNextQueueItem(taskType?: AnalysisTaskType) {
    return this.queueDao.fetchNextQueueItem(taskType)
  }
  async enqueueAnalysis(item: {
    item_id: number | null
    item_type?: 'file' | 'directory'
    task_type?: AnalysisTaskType
    status: string
    progress?: number
    force_reanalyze?: boolean
    meta?: Record<string, any>
  }): Promise<number> {
    return this.queueDao.enqueueAnalysis(item)
  }
  enqueueAnalysisSync(item: {
    item_id: number | null
    item_type?: 'file' | 'directory'
    task_type?: AnalysisTaskType
    status: string
    progress?: number
    force_reanalyze?: boolean
    meta?: Record<string, any>
  }): number {
    return this.queueDao.enqueueAnalysis(item)
  }
  updateAnalysisQueue(item: {
    id: number
    status?: string
    progress?: number
    error?: string | null
    result?: string | null
    taskType?: AnalysisTaskType
    task_type?: AnalysisTaskType
    filterTaskType?: AnalysisTaskType
  }) {
    return this.queueDao.updateAnalysisQueue(item)
  }
  clearNonCompletedAnalysis() {
    return this.queueDao.clearNonCompletedAnalysis()
  }
  clearPendingAnalysis(taskType?: AnalysisTaskType) {
    return this.queueDao.clearPendingAnalysis(taskType)
  }
  retryFailedAnalysis(taskType?: AnalysisTaskType) {
    return this.queueDao.retryFailedAnalysis(taskType)
  }
  deleteAnalysis(id: number) {
    return this.queueDao.deleteAnalysis(id)
  }

  async addFilesFromPathsBatch(
    fileInfos: { filePath: string; stats: fs.Stats }[],
    workspaceId: number
  ): Promise<void> {
    if (!this._db) throw new Error('数据库未初始化')
    const now = new Date().toISOString()

    const getExistingStmt = this._db.prepare(`
      SELECT id, file_fingerprint, is_analyzed 
      FROM workspace_files 
      WHERE workspace_id = ? AND path = ?
    `)

    const insertDirectoryStmt = this._db.prepare(`
      INSERT OR IGNORE INTO workspace_directories (workspace_id, path, name, created_at, modified_at)
      VALUES (?, ?, ?, ?, ?)
    `)

    const getDirectoryIdStmt = this._db.prepare(`
      SELECT id FROM workspace_directories WHERE path = ?
    `)

    const insertFileStmt = this._db.prepare(`
      INSERT OR IGNORE INTO files (file_fingerprint, smart_name, size, extension, file_group, created_at, modified_at, accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const insertFileContentStmt = this._db.prepare(`
      INSERT OR IGNORE INTO file_contents (file_fingerprint)
      VALUES (?)
    `)

    const insertWorkspaceFileStmt = this._db.prepare(`
      INSERT INTO workspace_files (file_fingerprint, workspace_id, directory_id, path, name, created_at, modified_at, accessed_at, is_analyzed, file_size, mtime_ms, is_ignored)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, path) DO UPDATE SET
        file_fingerprint = excluded.file_fingerprint,
        modified_at = excluded.modified_at,
        file_size = excluded.file_size,
        mtime_ms = excluded.mtime_ms,
        is_ignored = excluded.is_ignored
    `)

    // SC-1：一次性预取排除规则，供批量入库计算 is_ignored 预计算列
    const activeIgnoreRules = loadIgnoreRules()

    const dirIdCache = new Map<string, number>()

    this._db.transaction(() => {
      for (const info of fileInfos) {
        const { filePath, stats } = info
        const dirPath = path.dirname(filePath)

        // 1. 确保目录存在并获取 directoryId
        let dirId = dirIdCache.get(dirPath)
        if (dirId === undefined) {
          const row = getDirectoryIdStmt.get(dirPath) as { id: number } | undefined
          if (row) {
            dirId = row.id
          } else {
            const res = insertDirectoryStmt.run(
              workspaceId,
              dirPath,
              path.basename(dirPath),
              now,
              now
            )
            dirId = Number(res.lastInsertRowid)
          }
          dirIdCache.set(dirPath, dirId)
        }

        // 2. 检查已有的工作区文件
        const existing = getExistingStmt.get(workspaceId, filePath) as
          | { file_fingerprint: string | null; is_analyzed: number }
          | undefined

        const fileFingerprint = existing?.file_fingerprint || null

        if (fileFingerprint) {
          insertFileStmt.run(
            fileFingerprint,
            path.basename(filePath),
            stats.size,
            normalizeFileExtension(filePath),
            JSON.stringify({ mime_type: 'application/octet-stream' }),
            stats.birthtime.toISOString(),
            stats.mtime.toISOString(),
            stats.atime.toISOString()
          )
          insertFileContentStmt.run(fileFingerprint)
        }

        insertWorkspaceFileStmt.run(
          fileFingerprint,
          workspaceId,
          dirId,
          filePath,
          path.basename(filePath),
          new Date().toISOString(),
          stats.mtime.toISOString(),
          new Date().toISOString(),
          existing?.is_analyzed || 0,
          stats?.size ?? 0,
          Math.trunc(stats?.mtimeMs ?? Date.now()),
          shouldIgnoreFile(filePath, path.basename(filePath), activeIgnoreRules) ? 1 : 0
        )
      }
    })()
  }

  // --- Misc Methods ---
  async addFile(file: FileInfo) {
    return this.addFileFromPath(file.path, '')
  }
  async isConnected() {
    return this._db !== null
  }
  async close() {
    try {
      AccessTimeBatchUpdater.getInstance().flush()
    } catch (e) {
      logger.error(LogCategory.DATABASE_SERVICE, '关闭数据库前刷新 accessed_at 失败:', e)
    }
    if (this._db) {
      ;(this._db as any).close()
      this._db = null
      this.initPromise = null
    }
  }

  /**
   * [Issue 04 Step 5 / R2-8] 退出时序：应用关闭前对主库执行安全 checkpoint。
   * 须在 Omni 子进程已停止（释放只读连接池）之后调用；用 busy_timeout=1500 包裹，
   * 并发只读游标未清空时 PASSIVE 立即安全放行，杜绝退出卡死。
   */
  async checkpointBeforeClose(): Promise<void> {
    if (!this._db) return
    try {
      this._db.pragma('busy_timeout = 1500')
      this._db.pragma('optimize')
      this._db.pragma('wal_checkpoint(PASSIVE)')
      logger.debug(LogCategory.DATABASE_SERVICE, '退出前 WAL checkpoint 完成 (PASSIVE)')
    } catch (e) {
      logger.warn(LogCategory.DATABASE_SERVICE, '退出前 WAL checkpoint 失败(非致命，安全放行):', e)
    }
  }

  async resetAllAnalysisData(): Promise<void> {
    if (!this._db) throw new Error('数据库未初始化')
    try {
      this.clearDimensionsCache()
      this._db.transaction(() => {
        this._db!.prepare(
          `UPDATE workspace_files SET is_analyzed = 0, last_analyzed_at = NULL, analysis_error = NULL`
        ).run()
        // 创世 Baseline V1：files 表无 category 列（V4 规范化后由 extension/file_group 承载）
        this._db!.prepare(
          `UPDATE files SET description = NULL, file_group = NULL, author = NULL, language = NULL, is_hit = 0, last_hit_at = NULL, smart_name_source = NULL, smart_name_template_source = NULL, smart_name = (SELECT name FROM workspace_files wf WHERE wf.file_fingerprint = files.file_fingerprint LIMIT 1)`
        ).run()
        this._db!.prepare('DELETE FROM file_contents').run()
        this._db!.prepare('DELETE FROM file_tag_relations').run()
        this._db!.prepare('DELETE FROM file_tags_private').run()
        this._db!.prepare('DELETE FROM analysis_queue').run()
        // Spec §3.3 铁律：清空分析数据仅重置文件业务状态，坚决不删除 file_video_chunks，保护切片时序与向量资产
      })()
      logger.info(LogCategory.DATABASE_SERVICE, t('所有AI分析数据已重置'))
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, t('重置所有AI分析数据失败'), { error })
      throw error
    }
  }

  /**
   * 根据 ID 更新 workspace_files 的 status 状态
   */
  async updateFileStatus(fileId: number, status: number): Promise<void> {
    if (!this._db) return
    try {
      this._db
        .prepare('UPDATE workspace_files SET status = ?, modified_at = ? WHERE id = ?')
        .run(status, new Date().toISOString(), fileId)
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '更新文件状态失败', { error, fileId, status })
    }
  }

  /**
   * 根据路径更新 workspace_files 的 status 状态
   */
  async updateFileStatusByPath(filePath: string, status: number): Promise<void> {
    if (!this._db) return
    try {
      this._db
        .prepare('UPDATE workspace_files SET status = ?, modified_at = ? WHERE path = ?')
        .run(status, new Date().toISOString(), filePath)
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '根据路径更新文件状态失败', {
        error,
        filePath,
        status
      })
    }
  }

  /**
   * 全局直接删除指定维度标签（同时兼容模型 B 受控标签 `omw.*`/`hownet.*`/`builtin.*` 与私有标签 `file_tags_private`）。
   *
   * 精确分支优先：
   * - 若传入 `options.codePath` / `options.codePaths`，仅删除对应物化路径及其子树下的 `file_tag_relations`
   *   （防删除 `文档 > 小说 > 题材 > 美食` 时误杀其他分支同名标签），并回收孤儿 `tag_paths` 与无引用的私有标签；
   * - 否则按 `options.code` / `file_tags_private` / 受控概念字典 / `tag_aliases` 反查目标 `tag_code` 删除关联。
   *
   * 严禁 0 命中时伪造 `true`：仅当实际删除了至少 1 条关联或私有标签记录时才返回 `true`。
   */
  async deleteTagGlobally(
    dimensionId: number | string,
    tagName: string,
    options?: {
      code?: string
      codePath?: string
      codePaths?: string[]
      viaParentCode?: string
    }
  ): Promise<boolean> {
    if (!this._db) return false
    try {
      const dimCode = this.resolveDimensionCode(dimensionId) || String(dimensionId)
      const normalizeCodePath = (raw?: string): string => {
        if (!raw) return ''
        const segs = raw.trim().replace(/\\/g, '/').split('/').filter(Boolean)
        return segs.length > 0 ? `/${segs.join('/')}` : ''
      }
      const escapeLike = (s: string) =>
        s.replace(/\|/g, '||').replace(/%/g, '|%').replace(/_/g, '|_')

      const targetCodePaths = Array.from(
        new Set(
          [
            ...(Array.isArray(options?.codePaths) ? options.codePaths : []),
            ...(options?.codePath ? [options.codePath] : [])
          ]
            .map(normalizeCodePath)
            .filter(Boolean)
        )
      )

      let deletedRelations = 0
      let deletedPrivateTags = 0
      const dirtyFingerprints = new Set<string>()

      this._db.transaction(() => {
        const db = this._db!
        const candidatePrivateCodesToPrune = new Set<string>()

        // 1. 优先按精准物化路径（模型 B `tag_paths.code_path`）删除该节点及其子树关联
        if (targetCodePaths.length > 0) {
          const matchedPathIds = new Set<number>()
          const findPathsStmt = db.prepare(
            `SELECT path_id, leaf_code FROM tag_paths WHERE code_path = ? OR code_path LIKE ? ESCAPE '|'`
          )
          for (const cp of targetCodePaths) {
            const prefixPattern = `${escapeLike(cp)}/%`
            const rows = findPathsStmt.all(cp, prefixPattern) as Array<{
              path_id: number
              leaf_code: string
            }>
            for (const r of rows) {
              matchedPathIds.add(r.path_id)
              if (r.leaf_code) candidatePrivateCodesToPrune.add(r.leaf_code)
            }
          }

          if (matchedPathIds.size > 0) {
            const pathIdList = Array.from(matchedPathIds)
            const placeholders = pathIdList.map(() => '?').join(',')

            const affectedFps = db
              .prepare(
                `SELECT DISTINCT file_fingerprint FROM file_tag_relations WHERE path_id IN (${placeholders})`
              )
              .all(...pathIdList) as Array<{ file_fingerprint: string }>
            for (const row of affectedFps) {
              if (row.file_fingerprint) dirtyFingerprints.add(row.file_fingerprint)
            }

            const delRelRes = db
              .prepare(`DELETE FROM file_tag_relations WHERE path_id IN (${placeholders})`)
              .run(...pathIdList)
            deletedRelations += delRelRes.changes

            // 回收已无任何文件关联引用的孤儿 tag_paths（tag_path_ancestors 自动 ON DELETE CASCADE）
            db.prepare(
              `DELETE FROM tag_paths
               WHERE path_id IN (${placeholders})
                 AND NOT EXISTS (
                   SELECT 1 FROM file_tag_relations ftr WHERE ftr.path_id = tag_paths.path_id
                 )`
            ).run(...pathIdList)
          }
        }

        // 2. 若未传 codePath，或 codePath 未匹配到任何 path_id，回退按 tag_code 删除
        if (targetCodePaths.length === 0 || deletedRelations === 0) {
          const targetCodes = new Set<string>()
          if (options?.code && options.code.trim()) {
            targetCodes.add(options.code.trim())
          }

          // 2.1 查询私有标签表（先按维度收敛，无命中再按名称兜底）
          const privateScoped = db
            .prepare(
              `SELECT code FROM file_tags_private
               WHERE (code LIKE ? || '.%' OR json_extract(parent_codes, '$[0]') = ?)
                 AND LOWER(TRIM(name)) = LOWER(TRIM(?))`
            )
            .all(dimCode, dimCode, tagName) as Array<{ code: string }>
          for (const row of privateScoped) targetCodes.add(row.code)

          if (targetCodes.size === 0 && tagName?.trim()) {
            const privateByName = db
              .prepare(
                `SELECT code FROM file_tags_private WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))`
              )
              .all(tagName) as Array<{ code: string }>
            for (const row of privateByName) targetCodes.add(row.code)
          }

          // 2.2 受控标签（omw.* / hownet.* / builtin.*）不在 file_tags_private 中，按受控字典与 tag_aliases 反查
          if (targetCodes.size === 0 && tagName?.trim()) {
            const trimmedName = tagName.trim()
            if (isControlledConcept(trimmedName)) {
              const c = concept(trimmedName as any)
              if (c) targetCodes.add(c)
            }
            try {
              const aliasRows = db
                .prepare(
                  `SELECT DISTINCT tag_code FROM tag_aliases WHERE LOWER(TRIM(lemma)) = LOWER(TRIM(?))`
                )
                .all(trimmedName) as Array<{ tag_code: string }>
              for (const row of aliasRows) {
                if (row.tag_code) targetCodes.add(row.tag_code)
              }
            } catch {}
          }

          for (const code of targetCodes) {
            candidatePrivateCodesToPrune.add(code)
            const hasViaParent = Boolean(options?.viaParentCode && options.viaParentCode.trim())
            const affectedFps = hasViaParent
              ? (db
                  .prepare(
                    `SELECT DISTINCT file_fingerprint FROM file_tag_relations WHERE tag_code = ? AND via_parent_code = ?`
                  )
                  .all(code, options!.viaParentCode!.trim()) as Array<{ file_fingerprint: string }>)
              : (db
                  .prepare(
                    `SELECT DISTINCT file_fingerprint FROM file_tag_relations WHERE tag_code = ?`
                  )
                  .all(code) as Array<{ file_fingerprint: string }>)
            for (const row of affectedFps) {
              if (row.file_fingerprint) dirtyFingerprints.add(row.file_fingerprint)
            }

            const delRelRes = hasViaParent
              ? db
                  .prepare(
                    `DELETE FROM file_tag_relations WHERE tag_code = ? AND via_parent_code = ?`
                  )
                  .run(code, options!.viaParentCode!.trim())
              : db.prepare(`DELETE FROM file_tag_relations WHERE tag_code = ?`).run(code)
            deletedRelations += delRelRes.changes
          }
        }

        // 3. 清理已无任何文件关联引用的私有标签记录（受控标签不在 file_tags_private 中，此句安全无副作用）
        for (const code of candidatePrivateCodesToPrune) {
          const stillReferenced = db
            .prepare(`SELECT 1 FROM file_tag_relations WHERE tag_code = ? LIMIT 1`)
            .get(code)
          if (!stillReferenced) {
            const delPrivRes = db.prepare(`DELETE FROM file_tags_private WHERE code = ?`).run(code)
            deletedPrivateTags += delPrivRes.changes
          }
        }

        // 4. 标记受影响文件拼音/检索脏位
        if (dirtyFingerprints.size > 0) {
          const fpList = Array.from(dirtyFingerprints)
          const updatePinyinStmt = db.prepare(
            `UPDATE files SET pinyin_state = 0 WHERE file_fingerprint = ?`
          )
          for (const fp of fpList) {
            try {
              updatePinyinStmt.run(fp)
            } catch {}
          }
        }
      })()

      this.clearDimensionsCache()
      omniClient.clearTaxonomyTreeCache()

      const actuallyDeleted = deletedRelations > 0 || deletedPrivateTags > 0
      logger.info(
        LogCategory.DATABASE_SERVICE,
        `全局删除标签完成: dimId=${dimensionId}, tagName=${tagName}, code=${options?.code || ''}, codePaths=${targetCodePaths.join(',')}, deletedRelations=${deletedRelations}, deletedPrivateTags=${deletedPrivateTags}`
      )
      return actuallyDeleted
    } catch (error) {
      logger.error(
        LogCategory.DATABASE_SERVICE,
        `全局删除标签失败: dimId=${dimensionId}, tagName=${tagName}`,
        {
          error
        }
      )
      return false
    }
  }

  /**
   * 批量应用/解除维度标签
   */
  async batchApplyTags(
    operation: import('@firefly/types').BatchTagOperation
  ): Promise<import('@firefly/types').BatchTagResult> {
    if (!this._db || !operation.fileIds || operation.fileIds.length === 0) {
      return { successCount: 0, failedCount: 0, updatedFileIds: [], overriddenCount: 0 }
    }

    let successCount = 0
    let failedCount = 0
    const updatedFileIds: number[] = []
    // 标签集合有增删变更的文件指纹（供事务末尾置 files.pinyin_state=0 脏标记）
    const dirtyFingerprints = new Set<string>()

    // ──────── Phase 1: 事务外异步预裁决 (Pre-transaction Async Arbitration) ────────
    // 收集所有待添加标签，若未携带显式受控 tagCode 则批量请求 Omni 鉴别受控与祖先继承链
    interface ResolvedAddTagItem {
      tagName: string
      dimCode: string
      tagCode?: string
      isControlled: boolean
      matchedParent: boolean
    }

    const resolvedAddTagItems: ResolvedAddTagItem[] = []
    const combinedAddTags = [...(operation.addTags || []), ...(operation.newTags || [])]
    const uninspectedItems: Array<{
      tagName: string
      targetParentCode: string
      originalIndex: number
    }> = []

    for (let i = 0; i < combinedAddTags.length; i++) {
      const item = combinedAddTags[i]
      let dimCode =
        item.viaParentCode ||
        item.dimensionCode ||
        this.resolveDimensionCode((item as any).dimensionId, item.dimensionName)

      // 只有显式传入已完成鉴别且匹配父级的受控 code，或显式传入的私有 code 时，才跳过 Omni 预检
      const explicitTagCode = (item as any).tagCode

      // 优先从受控本体反查规范父维度，阻断受控标签私自跌落内容标签伪分支
      if (!dimCode || dimCode === concept('内容标签')) {
        const autoParent =
          (isControlledConcept(item.tagName)
            ? CONTROLLED_CONCEPT_DETAILS[item.tagName]?.parentName
              ? concept(CONTROLLED_CONCEPT_DETAILS[item.tagName].parentName as any)
              : undefined
            : undefined) ||
          (explicitTagCode ? getParentDimensionCodeOfTag(explicitTagCode) : undefined)
        dimCode = autoParent || dimCode || concept('内容标签')
      }
      const safeDimCode: string = dimCode || concept('内容标签')

      // 权威受控反查与伪代码净化：凡是以 builtin. 或 dim. 开头但不在权威受控字典中，或包含非 ASCII 字符的，一律判定为非法拼接伪码
      let safeExplicitTagCode = explicitTagCode
      const isBogusControlledCode =
        Boolean(safeExplicitTagCode) &&
        (safeExplicitTagCode.startsWith('builtin.') ||
          safeExplicitTagCode.startsWith('dim.') ||
          /[^\u0020-\u007E]/.test(safeExplicitTagCode)) &&
        !CONTROLLED_CODE_TO_CANONICAL_NAME[safeExplicitTagCode]

      if (isBogusControlledCode) {
        // 提取尾段真实词面（如从 "builtin.security_level.内部" 提取 "内部"）
        const tailLemma = safeExplicitTagCode.split('.').pop() || ''
        const candidateName = item.tagName || tailLemma
        if (isControlledConcept(candidateName)) {
          safeExplicitTagCode = concept(candidateName)
        } else {
          // 查找规范展示名别名反查
          let foundControlledCode: string | undefined
          for (const [code, canonName] of Object.entries(CONTROLLED_CODE_TO_CANONICAL_NAME)) {
            if (canonName.toLowerCase() === candidateName.toLowerCase()) {
              foundControlledCode = code
              break
            }
          }
          safeExplicitTagCode = foundControlledCode
        }
      }

      if (safeExplicitTagCode) {
        // 已有受控或私有 tagCode
        const isControlled =
          !safeExplicitTagCode.startsWith('_ext.') &&
          !safeExplicitTagCode.startsWith('custom.') &&
          (safeExplicitTagCode.startsWith('omw.') ||
            safeExplicitTagCode.startsWith('hownet.') ||
            safeExplicitTagCode.startsWith('builtin.') ||
            Boolean(CONTROLLED_CODE_TO_CANONICAL_NAME[safeExplicitTagCode]))
        const matchedParent = (item as any).matchedParent !== false
        resolvedAddTagItems.push({
          tagName: item.tagName,
          dimCode: safeDimCode,
          tagCode: safeExplicitTagCode,
          isControlled,
          matchedParent
        })
      } else {
        uninspectedItems.push({
          tagName: item.tagName,
          targetParentCode: safeDimCode,
          originalIndex: resolvedAddTagItems.length
        })
        resolvedAddTagItems.push({
          tagName: item.tagName,
          dimCode: safeDimCode,
          isControlled: false,
          matchedParent: false
        })
      }
    }

    if (uninspectedItems.length > 0) {
      // Issue 02 Fix-14：手动/批量打标与 AI saver 共用统一预解析闸口
      // （本地覆盖索引 → 10k LRU 负缓存 → Omni inspectTags 回源 → unresolved 暂存）
      await preResolveControlledCandidates(
        uninspectedItems.map(u => u.tagName),
        this.currentLanguage
      )
      try {
        const { omniService } = await import('../../system/omni-service')
        const isTestEnv = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST)
        const shouldInspect = !isTestEnv || (await omniService.checkHealth().catch(() => false))

        if (shouldInspect) {
          const inspectResp = await omniService.inspectControlledTags(
            uninspectedItems.map(u => ({
              tagName: u.tagName,
              targetParentCode: u.targetParentCode
            })),
            this.currentLanguage,
            1500
          )
          if (inspectResp && inspectResp.success && Array.isArray(inspectResp.results)) {
            for (let k = 0; k < uninspectedItems.length; k++) {
              const u = uninspectedItems[k]
              const res = inspectResp.results[k]
              if (res) {
                const target = resolvedAddTagItems[u.originalIndex]
                target.isControlled = res.isControlled
                target.matchedParent = res.matchedParent
                if (res.isControlled && res.matchedParent && res.code) {
                  target.tagCode = res.code
                  if (res.ancestryMatchedCode) {
                    target.dimCode = res.ancestryMatchedCode
                  }
                }
              }
            }
          }
        }
      } catch (err: any) {
        // 测试环境下若未部署常驻 Omni 微服务，降级为私有标签以便单元测试验证离线/派生逻辑
        if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
          logger.debug(
            LogCategory.DATABASE_SERVICE,
            `[batchApplyTags] 测试环境 Omni 未连通，降级为私有标签处理: ${err.message}`
          )
        } else {
          logger.warn(
            LogCategory.DATABASE_SERVICE,
            `[batchApplyTags] Omni 受控鉴别预裁决异常:`,
            err.message
          )
          // 按照悲观熔断铁律：生产环境中严禁静默吞掉假装成功，抛出异常阻断保存
          throw err
        }
      }
    }

    // S2 裁决明细（规格 §4.6）：收录所有发生过裁决的作用域（含「仅跳过、未删除」），最多 100 条。
    // 声明必须在事务回调之外——返回点在回调外读取，放里面会 TS18004。
    const overrides: Array<{
      fileId: number | string
      parentCode: string
      keptTagCode: string
      deletedTagCodes: string[]
      skippedTagCodes: string[]
    }> = []
    let overriddenCount = 0

    // ──────── Phase 2: 同步事务原子落库 (Atomic Synchronous Transaction) ────────
    try {
      this._db.transaction(() => {
        // 1. 处理结构化 addTags 与 newTags
        const createdTagMap = new Map<string, string>()

        for (const item of resolvedAddTagItems) {
          const dimCode = item.dimCode
          if (item.isControlled && item.matchedParent && item.tagCode) {
            // ✅ 受控标签：复用受控 code，绝对不写 file_tags_private
            createdTagMap.set(`${dimCode}:${item.tagName}`, item.tagCode)
          } else if (isUnresolvedControlledLemma(item.tagName, this.currentLanguage)) {
            // P0-K：Omni 未决候选禁止派生 _ext.* 伪受控码，留待下一批预解析重试
            logger.warn(
              LogCategory.DATABASE_SERVICE,
              `[Fix-14] 手动打标跳过未决受控候选：lemma="${item.tagName}", locale=${this.currentLanguage}`
            )
            continue
          } else {
            // ⚠️ 私有自定义标签：在 file_tags_private 中注册或复用
            let code: string | undefined
            const existingRow = this._db!.prepare(
              'SELECT code, parent_codes FROM file_tags_private WHERE name = ?'
            ).get(item.tagName) as { code: string; parent_codes?: string } | undefined

            if (existingRow?.code) {
              code = existingRow.code
              let parents: string[] = []
              try {
                parents = JSON.parse(existingRow.parent_codes || '[]')
              } catch {
                parents = []
              }
              if (!parents.includes(dimCode)) {
                parents.push(dimCode)
                this._db!.prepare(
                  'UPDATE file_tags_private SET parent_codes = ? WHERE code = ?'
                ).run(JSON.stringify(parents), code)
              }
            } else {
              code = DeterministicCodeGenerator.generateUnique(item.tagName, this.currentLanguage, {
                lookupExistingName: DeterministicCodeGenerator.createDbLookup(this._db!)
              })
              this._db!.prepare(
                `INSERT INTO file_tags_private (code, name, parent_codes, file_groups, source, meta)
                 VALUES (?, ?, ?, '[]', 'user', ?)
                 ON CONFLICT(code) DO UPDATE SET
                   parent_codes = CASE
                     WHEN parent_codes IS NULL OR parent_codes = '' OR parent_codes = '[]'
                       THEN excluded.parent_codes
                     WHEN instr(parent_codes, json_extract(excluded.parent_codes, '$[0]')) > 0
                       THEN parent_codes
                     ELSE json_insert(parent_codes, '$[#]', json_extract(excluded.parent_codes, '$[0]'))
                   END,
                   name = excluded.name`
              ).run(
                code,
                item.tagName,
                JSON.stringify([dimCode]),
                JSON.stringify({
                  isLeaf: true,
                  isSystem: false,
                  isMultiSelect: true,
                  syncStatus: 0
                })
              )
            }
            createdTagMap.set(`${dimCode}:${item.tagName}`, code)
          }
        }

        // 2. 处理待移除标签 removeTags 与 removeTagCodes（精准受控与动态私有分流）
        // 区分「维度限定精准点删 (via_parent_code)」与「全量全局点删」
        const globalDeleteCodes = new Set<string>(operation.removeTagCodes || [])
        const dimDeletePlansMap = new Map<string, Set<string>>()
        const removeItemPlans: Array<{ tagCodes: string[]; dimCode?: string }> = []

        if (operation.removeTags && operation.removeTags.length > 0) {
          for (const item of operation.removeTags) {
            const dimCode =
              item.viaParentCode ||
              item.dimensionCode ||
              this.resolveDimensionCode((item as any).dimensionId, item.dimensionName) ||
              undefined

            const itemCodes: string[] = []
            if (item.tagCode) {
              itemCodes.push(item.tagCode)
            }
            if (item.tagName) {
              const tagName = String(item.tagName).trim()
              if (tagName) {
                // 1. 受控概念字典优先解析
                let controlled: string | undefined
                try {
                  controlled = (CONTROLLED_CONCEPTS as Record<string, string>)[tagName]
                } catch {}
                if (!controlled && isControlledConcept(tagName)) {
                  controlled = concept(tagName)
                }

                if (controlled) {
                  itemCodes.push(controlled)
                }

                // 2. 反查所有具有相同规范展示名的历史/异名受控码（如 omw.01704761.a 对应 公开）
                for (const [code, canonName] of Object.entries(CONTROLLED_CODE_TO_CANONICAL_NAME)) {
                  if (canonName === tagName) {
                    itemCodes.push(code)
                  }
                }

                // 3. 别名表与私有表解析 (统一委托给 resolveTagCode)
                const resolved = this.resolveTagCode(tagName, dimCode)
                if (resolved) {
                  itemCodes.push(resolved)
                }

                // 3. 开放动态私有标签：防范多维度同名多代码遗漏
                try {
                  const rows = this._db!.prepare(
                    'SELECT code FROM file_tags_private WHERE name = ?'
                  ).all(tagName) as Array<{ code: string }>
                  for (const r of rows) {
                    if (r.code) {
                      itemCodes.push(r.code)
                    }
                  }
                } catch {}

                // 4. 清理可能存在的历史同名伪受控码（如 builtin.security_level.内部）
                if (dimCode) {
                  itemCodes.push(`${dimCode}.${tagName}`)
                }

                itemCodes.push(tagName)
              }
            }

            if (dimCode && itemCodes.length > 0) {
              let dimSet = dimDeletePlansMap.get(dimCode)
              if (!dimSet) {
                dimSet = new Set<string>()
                dimDeletePlansMap.set(dimCode, dimSet)
              }
              for (const c of itemCodes) {
                dimSet.add(c)
              }
              removeItemPlans.push({ tagCodes: itemCodes, dimCode })
            } else {
              for (const c of itemCodes) {
                globalDeleteCodes.add(c)
              }
            }
          }
        }

        // 3. 遍历文件应用或解绑
        const allAddTagItems: Array<{
          tagCode: string
          viaParentCode: string
          tagName?: string
          tagGroup: TagProvenanceGroup
        }> = []
        for (const [key, code] of createdTagMap.entries()) {
          const parts = key.split(':')
          const dimCode = parts[0] || ''
          const tagName = parts.slice(1).join(':')
          const resolvedItem = resolvedAddTagItems.find(
            r => r.dimCode === dimCode && r.tagName === tagName
          )
          const isControlled =
            resolvedItem?.isControlled ??
            (!code.startsWith('_ext.') &&
              !code.startsWith('custom.') &&
              (isControlledConcept(tagName) || Boolean(CONTROLLED_CODE_TO_CANONICAL_NAME[code])))
          const tagGroup = this.resolveBatchTagProvenanceGroup(code, dimCode, isControlled)
          allAddTagItems.push({ tagCode: code, viaParentCode: dimCode, tagName, tagGroup })
        }
        for (const code of operation.addTagCodes || []) {
          const found = this._db!.prepare(
            'SELECT code, name, parent_codes FROM file_tags_private WHERE code = ?'
          ).get(code) as { code: string; name?: string; parent_codes?: string } | undefined
          let viaParentCode = ''
          if (found?.parent_codes) {
            try {
              const parents = JSON.parse(found.parent_codes)
              if (Array.isArray(parents) && parents.length > 0) {
                viaParentCode = parents[0]
              }
            } catch {}
          }
          const tagName = found?.name || getCanonicalConceptName(code) || code
          const isControlled =
            !code.startsWith('_ext.') &&
            !code.startsWith('custom.') &&
            (Boolean(CONTROLLED_CODE_TO_CANONICAL_NAME[code]) ||
              Boolean(tagName && isControlledConcept(tagName)))
          const tagGroup = this.resolveBatchTagProvenanceGroup(code, viaParentCode, isControlled)
          allAddTagItems.push({
            tagCode: code,
            viaParentCode,
            tagName,
            tagGroup
          })
        }

        // 全媒体领域排他门控铁律：非适格介质严禁挂载专有维度与标签
        const isDimensionApplicableForFile = (
          dimCode: string,
          tagCode: string,
          ctx: any
        ): boolean => {
          const effectiveDim = dimCode || getParentDimensionCodeOfTag(tagCode)
          if (effectiveDim && !isControlledDimensionApplicableInDomain(effectiveDim, ctx)) {
            return false
          }
          if (tagCode && !isControlledDimensionApplicableInDomain(tagCode, ctx)) {
            return false
          }
          return true
        }

        // 按领域分片缓存当前批次物化路径三元组 (O(M*Domains) 缓存，杜绝热循环内部重复计算与跨领域串色)
        const materializedMap = new Map<
          string,
          { codePath: string; namePath: string; depth: number }
        >()

        // 模型 B：路径三元组迁至 tag_paths，本表只存 path_id 外键；
        // created_at / updated_at 为 INTEGER NOT NULL（Unix ms），必须显式 Date.now()
        const insertStmt = this._db!.prepare(
          `INSERT OR REPLACE INTO file_tag_relations (
             file_fingerprint, tag_code, via_parent_code, path_id, tag_group, source, confidence, sync_status, created_at, updated_at, meta
           ) VALUES (?, ?, ?, ?, ?, 'user', 1.0, 0, ?, ?, '{}')`
        )

        // 预编译指纹与路径查询语句（杜绝循环内重复 prepare）
        // 铁律（S0-b）：只能引用 GENESIS_V1_SCHEMA 中真实存在的列。
        // files 表主键只有 file_fingerprint，既无 id 也无 path（database.ts:90-109）；
        // id / path 仅存在于 workspace_files（database.ts:133-153）。better-sqlite3 的 prepare
        // 是即时编译，引用不存在的列会在此处（逐文件 try/catch 之外）抛错并让整批事务回滚。
        const selectWfByIdStmt = this._db!.prepare(
          'SELECT file_fingerprint, path FROM workspace_files WHERE id = ?'
        )
        const selectFilesByFpStmt = this._db!.prepare(
          'SELECT file_fingerprint, extension, file_group FROM files WHERE file_fingerprint = ?'
        )
        const selectWfByPathStmt = this._db!.prepare(
          'SELECT file_fingerprint, path FROM workspace_files WHERE path = ?'
        )

        // 预编译精准删除语句（杜绝循环内重复 prepare，对齐 Spec §3.6 性能铁律）
        const dimDeleteStmts: Array<{ stmt: any; dimCode: string; params: string[] }> = []
        for (const [dimCode, codeSet] of dimDeletePlansMap.entries()) {
          if (codeSet.size > 0) {
            const codes = Array.from(codeSet)
            const placeholders = codes.map(() => '?').join(',')
            const stmt = this._db!.prepare(
              `DELETE FROM file_tag_relations WHERE file_fingerprint = ? AND via_parent_code = ? AND tag_code IN (${placeholders})`
            )
            dimDeleteStmts.push({ stmt, dimCode, params: codes })
          }
        }

        let globalDeleteStmt: { stmt: any; params: string[] } | null = null
        if (globalDeleteCodes.size > 0) {
          const codes = Array.from(globalDeleteCodes)
          const placeholders = codes.map(() => '?').join(',')
          globalDeleteStmt = {
            stmt: this._db!.prepare(
              `DELETE FROM file_tag_relations WHERE file_fingerprint = ? AND tag_code IN (${placeholders})`
            ),
            params: codes
          }
        }

        // S2 互斥收拢语句（规格 §4.1 阶段 B / §4.3）：与 insertStmt 一同在事务开头预编译，循环内只 run/get。
        // 覆盖删除必须写成「tag_code <> winner」而不是「清空该作用域」——否则 INSERT winner 失败时维度已被清空（P0-A）。
        const selectSiblingsStmt = this._db!.prepare(
          `SELECT ftr.tag_code FROM file_tag_relations ftr
           WHERE ftr.file_fingerprint = ?
             AND (ftr.via_parent_code = ?
               OR ftr.path_id IN (SELECT tpa.path_id FROM tag_path_ancestors tpa WHERE tpa.ancestor_code = ?)
               OR ftr.tag_code LIKE (? || '.%'))
             AND ftr.tag_code <> ?`
        )
        const overrideDeleteStmt = this._db!.prepare(
          `DELETE FROM file_tag_relations
           WHERE file_fingerprint = ?
             AND (via_parent_code = ?
               OR path_id IN (SELECT tpa.path_id FROM tag_path_ancestors tpa WHERE tpa.ancestor_code = ?)
               OR tag_code LIKE (? || '.%'))
             AND tag_code <> ?`
        )

        // S2 显式移除集合（覆盖删除豁免判定用，规格 §4.4 第三行）：
        // removeTags 解析出的维度限定码 ∪ removeTagCodes 全局码。winner 落在本集合 ⇒ 跳过覆盖删除，
        // 否则「既有兄弟被清空 + winner 随后又被点删 ⇒ 维度变空」，比「保留兄弟」更糟。
        const explicitRemoveCodes = new Set<string>(globalDeleteCodes)
        for (const codeSet of dimDeletePlansMap.values()) {
          for (const c of codeSet) explicitRemoveCodes.add(c)
        }

        // S2 作用域判定批级缓存：父行 meta 在本事务前已注册，批内不变
        const scopeModeCache = new Map<string, 'single' | 'multi' | 'skip'>()

        for (const fileId of operation.fileIds) {
          try {
            let fp: string | undefined
            let filePath: string | undefined

            // 1. 优先从 workspace_files 按 id 查询指纹与路径（前端文件列表的主标识通常为 workspace_files.id）
            const wfRow = selectWfByIdStmt.get(fileId) as
              | { file_fingerprint: string; path?: string }
              | undefined

            if (wfRow?.file_fingerprint) {
              fp = wfRow.file_fingerprint
              filePath = wfRow.path
            } else {
              // 2. 尝试作为 file_fingerprint 字符串本身查询（files 表无 path，只能取指纹）
              const fpRow = selectFilesByFpStmt.get(fileId) as
                | { file_fingerprint: string }
                | undefined
              if (fpRow?.file_fingerprint) {
                fp = fpRow.file_fingerprint
              } else {
                // 3. 尝试作为 workspace_files 路径查询（UI 侧 fileIds 可能退化为 f.path）
                const pathRow = selectWfByPathStmt.get(fileId) as
                  | { file_fingerprint: string; path?: string }
                  | undefined
                if (pathRow?.file_fingerprint) {
                  fp = pathRow.file_fingerprint
                  filePath = pathRow.path
                }
              }
            }

            if (!fp) {
              failedCount++
              continue
            }

            // ────────── S2 阶段 A：候选过滤 / 去重 / 分组 / 裁决（规格 §4.1 步骤 2-6） ──────────
            // 门禁依赖 filePath，故过滤与分组必须逐文件进行（时效性：filePath 是本文件解析结果）。
            // ADR-0045：本路径为用户手动批量打标，来源分组固定落 'user'，source 固定落 'user'。
            let fileCategory: string | undefined = filePath ? getFileCategory(filePath) : undefined
            let fileExtension: string | undefined = filePath ? path.extname(filePath) : undefined
            if (!fileCategory && fp) {
              try {
                const fRow = selectFilesByFpStmt.get(fp) as
                  | { extension?: string; file_group?: string }
                  | undefined
                if (fRow) {
                  fileCategory = fRow.file_group
                  fileExtension = fRow.extension
                }
              } catch {}
            }
            const fileCtx = {
              filePath,
              category: fileCategory,
              fileCategory,
              extension: fileExtension
            }
            const fileDomain = resolveMediaDomain(fileCtx)

            const materializeOf = (tagCode: string, viaParentCode: string, tagName: string) => {
              const cacheKey = `${fileDomain}:${viaParentCode}:${tagCode}`
              let materialized = materializedMap.get(cacheKey)
              if (!materialized) {
                materialized = resolveRuntimeMaterializedPath({
                  db: this._db!,
                  tagCode,
                  viaParentCode,
                  tagName,
                  context: fileCtx
                })
                materializedMap.set(cacheKey, materialized)
              }
              return materialized
            }

            const insertItem = (
              tagCode: string,
              viaParentCode: string,
              tagName?: string,
              tagGroup?: TagProvenanceGroup
            ) => {
              const name = tagName || getCanonicalConceptName(tagCode) || tagCode
              const materialized = materializeOf(tagCode, viaParentCode, name)
              if (!materialized.codePath) {
                logger.warn(
                  LogCategory.DATABASE_SERVICE,
                  `[batchApplyTags] 标签不符合媒体领域门控，跳过写入: ${tagCode} (${viaParentCode})`
                )
                return
              }
              // 模型 B：先经唯一收口 ensureTagPath 取 path_id；非法 code_path 按契约 warn + 记 CONSTRAINT 后跳过
              let pathId: number
              try {
                pathId = ensureTagPath(this._db!, materialized.codePath)
              } catch (err) {
                logger.warn(
                  LogCategory.DATABASE_SERVICE,
                  `[batchApplyTags][CONSTRAINT] 非法 code_path，跳过写入: ${tagCode} (${materialized.codePath}), error=${err instanceof Error ? err.message : String(err)}`
                )
                return
              }
              const effectiveGroup =
                tagGroup || this.resolveBatchTagProvenanceGroup(tagCode, viaParentCode)
              const now = Date.now()
              insertStmt.run(fp, tagCode, viaParentCode, pathId, effectiveGroup, now, now)
              if (fp) dirtyFingerprints.add(fp)
            }

            // 步骤 2：过滤（全媒体排他门禁 + 准入闸）。被拦者不参与胜出裁决，也就不会造成覆盖删除。
            const survivors: Array<{
              tagCode: string
              viaParentCode: string
              tagName?: string
              tagGroup: TagProvenanceGroup
            }> = []
            for (const item of allAddTagItems) {
              // 全媒体领域排他门控铁律：非适格介质严禁挂载专有维度与标签
              if (!isDimensionApplicableForFile(item.viaParentCode, item.tagCode, fileCtx)) {
                logger.debug(
                  LogCategory.DATABASE_SERVICE,
                  `[batchApplyTags] 全媒体排他门禁拦截: 跳过向非适格介质挂载专有标签 (${filePath || fp} -> ${item.tagCode})`
                )
                continue
              }

              // (PRD-0057 S4 / GH #714) 用户手动批量打标旁路闸门：
              // 来源为 user，走豁免短路（isTagAdmissible 永不拒，断言全部放行）。
              // dimensionNames 仍按契约传入：当前 user 组在闸门①步即豁免短路，但若未来
              // tagGroup 语义变化或非 user 路径复用本裁决，维度名按名拒绝（R-G2-07）即刻生效。
              const tagName = item.tagName || getCanonicalConceptName(item.tagCode) || item.tagCode
              const verdict = isTagAdmissible({
                name: tagName,
                tagGroup: item.tagGroup,
                dimensionNames: ConfigDbManager.getInstance().getDimensionNameBlacklist()
              })
              if (verdict.outcome === 'rejected') {
                logger.debug(
                  LogCategory.DATABASE_SERVICE,
                  `[tag-admissibility] ${verdict.rule} 拒绝用户打标入库: "${tagName}" (${verdict.reason})`
                )
                continue
              }

              survivors.push(item)
            }

            // 步骤 3+4：按 (effectiveParent, tagCode) 去重（保留末位）后按父级分组。
            // 去重是必需的（规格 §4.2）：createdTagMap 以 `${dim}:${tagName}` 为键，不同别名可映射到
            // 同一 code；addTagCodes 也会与 addTags 重复。不去重会出现「同一 code 既 kept 又 skipped」。
            const candidateGroups = new Map<
              string,
              Array<{ tagCode: string; tagName?: string; tagGroup: TagProvenanceGroup }>
            >()
            for (const item of survivors) {
              let group = candidateGroups.get(item.viaParentCode)
              if (!group) {
                group = []
                candidateGroups.set(item.viaParentCode, group)
              }
              // 先移除同 code 旧位次再压入，保证组内顺序即「末位胜出」顺序
              const dupIdx = group.findIndex(c => c.tagCode === item.tagCode)
              if (dupIdx >= 0) group.splice(dupIdx, 1)
              group.push({
                tagCode: item.tagCode,
                tagName: item.tagName,
                tagGroup: item.tagGroup
              })
            }

            // ────────── S2 阶段 B：落库（规格 §4.1 步骤 7-8；铁律：先 INSERT winner，后 DELETE 兄弟） ──────────
            for (const [parentCode, candidates] of candidateGroups) {
              const mode = this.resolveBatchTagScopeMode(parentCode, scopeModeCache, this._db!)

              if (mode !== 'single' || candidates.length === 0) {
                // 8. multi / rule / unknown(显式多选) / 无父级：按原逻辑逐条 INSERT，绝不做覆盖删除
                for (const c of candidates) insertItem(c.tagCode, parentCode, c.tagName, c.tagGroup)
                continue
              }

              // 5. 裁决：数组末位胜出（D-06 已裁定不做点击顺序，末位仅作确定性兜底）
              const winner = candidates[candidates.length - 1]
              let skippedTagCodes = candidates.slice(0, -1).map(c => c.tagCode)

              // 6. winner 被同批显式移除 ⇒ 用户意图是「删它」，跳过覆盖删除（否则维度被清空）
              const skipOverrideDelete = explicitRemoveCodes.has(winner.tagCode)

              // 7a. 先 INSERT winner：失败即抛（本文件记 failedCount），此刻未发生任何删除 ⇒ 维度未被修改
              insertItem(winner.tagCode, parentCode, winner.tagName, winner.tagGroup)

              let deletedTagCodes: string[] = []
              if (!skipOverrideDelete) {
                // 7b. 覆盖前 SELECT 既有兄弟（不含 winner 自身）
                const siblingRows = selectSiblingsStmt.all(
                  fp,
                  parentCode,
                  parentCode,
                  parentCode,
                  winner.tagCode
                ) as Array<{
                  tag_code: string
                }>
                deletedTagCodes = siblingRows.map(r => r.tag_code).filter(Boolean)

                if (deletedTagCodes.length > 0) {
                  // 7c. 删除既有兄弟；`tag_code <> winner` 保证刚写入的 winner 不被自己删掉
                  overrideDeleteStmt.run(fp, parentCode, parentCode, parentCode, winner.tagCode)
                  if (fp) dirtyFingerprints.add(fp)
                  // 7d. 只有真实删除过既有兄弟才计入 overriddenCount（回答「有没有覆盖旧值」）
                  overriddenCount++
                }

                // 规格 §4.2 末段：同一 code 只按「被删」记一次，从 skipped 中剔除
                if (deletedTagCodes.length > 0 && skippedTagCodes.length > 0) {
                  skippedTagCodes = skippedTagCodes.filter(c => !deletedTagCodes.includes(c))
                }
              }

              // 明细：收录所有发生过裁决的作用域（含「仅跳过」），这样 skippedTagCodes 才有承载对象
              if (
                overrides.length < 100 &&
                (skippedTagCodes.length > 0 || deletedTagCodes.length > 0)
              ) {
                overrides.push({
                  fileId,
                  parentCode,
                  keptTagCode: winner.tagCode,
                  deletedTagCodes,
                  skippedTagCodes
                })
              }
            }

            // 移除标签关联（精准索引点删：有维度限定走带 via_parent_code，无维度限定走全局点删）
            for (const { stmt, dimCode, params } of dimDeleteStmts) {
              stmt.run(fp, dimCode, ...params)
              if (fp) dirtyFingerprints.add(fp)
            }

            if (globalDeleteStmt) {
              globalDeleteStmt.stmt.run(fp, ...globalDeleteStmt.params)
              if (fp) dirtyFingerprints.add(fp)
            }

            successCount++
            updatedFileIds.push(fileId)
          } catch (err: any) {
            logger.warn(
              LogCategory.DATABASE_SERVICE,
              `[batchApplyTags] 单个文件(${fileId})打标落库失败:`,
              err?.message || err
            )
            failedCount++
          }
        }

        // 同步清理 file_tags_private 中针对已移除维度的 parent_codes 关联
        // 铁律：仅当全库中已无任何文件在此维度下引用该标签时，才从全局词库解绑该维度的 parent_codes，绝不误杀多文件共享词库！
        for (const plan of removeItemPlans) {
          if (plan.dimCode && plan.tagCodes.length > 0) {
            for (const code of plan.tagCodes) {
              try {
                const refRow = this._db!.prepare(
                  'SELECT COUNT(*) as c FROM file_tag_relations WHERE tag_code = ? AND via_parent_code = ?'
                ).get(code, plan.dimCode) as { c: number } | undefined
                const remainingCount = refRow?.c || 0
                if (remainingCount > 0) {
                  // 数据库中仍有其他文件在当前维度下关联此标签，绝不破坏全局词库关系！
                  continue
                }

                const row = this._db!.prepare(
                  'SELECT parent_codes FROM file_tags_private WHERE code = ?'
                ).get(code) as { parent_codes?: string } | undefined
                if (row?.parent_codes) {
                  let parents: string[] = []
                  try {
                    parents = JSON.parse(row.parent_codes)
                  } catch {
                    parents = []
                  }
                  if (parents.includes(plan.dimCode)) {
                    parents = parents.filter(p => p !== plan.dimCode)
                    this._db!.prepare(
                      'UPDATE file_tags_private SET parent_codes = ? WHERE code = ?'
                    ).run(JSON.stringify(parents), code)
                  }
                }
              } catch (cleanErr: any) {
                logger.warn(
                  LogCategory.DATABASE_SERVICE,
                  `[batchApplyTags] 清理私有标签(${code})父级关联失败:`,
                  cleanErr?.message || cleanErr
                )
              }
            }
          }
        }

        // 标签集合有增删变更时置脏，供后台拼音回填刷新 files_pinyin_fts.tags_py（Spec §2.4.2 R2-7 & §3.1.B L304）
        if (dirtyFingerprints.size > 0) {
          const pinyinDirtyStmt = this._db!.prepare(
            'UPDATE files SET pinyin_state = 0 WHERE file_fingerprint = ?'
          )
          for (const fp of dirtyFingerprints) pinyinDirtyStmt.run(fp)
        }
      })()

      this.clearDimensionsCache()
    } catch (err) {
      logger.error(LogCategory.DATABASE_SERVICE, '批量打标签事务失败:', err)
      throw err
    }

    return {
      successCount,
      failedCount,
      updatedFileIds,
      // S2：互斥收拢统计（规格 §4.6）。overriddenCount 只统计真实删除过既有兄弟的「文件-作用域」次数；
      // overrides 收录所有发生过裁决的作用域（含「仅跳过」），供 UI 做 toast 回显与排障。
      overriddenCount,
      overrides
    }
  }

  /**
   * S2 互斥收拢的作用域判定（规格 §3.2 `resolveScopeMode`，是 `classifyDimensionMutexScope` 的写库侧包装）
   *
   * 判定顺序（`rule` 必须优先：规则自有维度本身就在 RAW_SINGLE / RAW_MULTI 里）：
   *   1. 无父级            → 'skip'（无作用域可定义，绝不删）
   *   2. 'rule'（规则自有） → 'skip'（程序写入的事实标签，误删会破坏扩展名/文件类型等识别结果）
   *   3. 'multi'           → 'multi'（全放行）
   *   4. 'single'          → 'single'（互斥收拢 + 覆盖删除）
   *   5. 'unknown'         → 读父行 `file_tags_private.meta.isMultiSelect`：
   *                         显式 true ⇒ 'multi'，否则 'single'（ADR-0034 默认单选）
   *
   * 第 5 条的逃生口恰好覆盖「叶标签当父级」：`batchApplyTags` 给私有叶标签写的 meta 恒为
   * `{ isLeaf: true, isMultiSelect: true }`（本函数下方私有标签注册处），其语义是「子节点可多选」，
   * 读到这里正好导向非破坏性的 'multi'。`unknown` 取 'single' 而非 'skip' 的理由见规格 §3.2：
   * UI 互斥不删已入库标签（`BatchTagView.tsx` 仅把兄弟置回 `initial`），'skip' 会放任冲突累积。
   *
   * @param parentCode 作用域 = 维度根 code（写入键与删除键同源，均为 `via_parent_code`）
   * @param cache 批级缓存：父行 meta 在事务前已注册，批内不变，同一父级只解析一次
   */
  protected resolveBatchTagScopeMode(
    parentCode: string,
    cache: Map<string, 'single' | 'multi' | 'skip'>,
    db: Database.Database
  ): 'single' | 'multi' | 'skip' {
    const cached = cache.get(parentCode)
    if (cached) return cached

    let mode: 'single' | 'multi' | 'skip'
    if (!parentCode) {
      mode = 'skip'
    } else {
      switch (classifyDimensionMutexScope(parentCode)) {
        case 'rule':
          mode = 'skip'
          break
        case 'multi':
          mode = 'multi'
          break
        case 'single':
          mode = 'single'
          break
        default: {
          let isMulti = false
          try {
            const row = db
              .prepare('SELECT meta FROM file_tags_private WHERE code = ?')
              .get(parentCode) as { meta?: string } | undefined
            if (row?.meta) {
              const meta = JSON.parse(row.meta) as { isMultiSelect?: boolean } | null
              isMulti = meta?.isMultiSelect === true
            }
          } catch {
            // meta 缺失/解析失败：按单选兜底（保守方向，宁可收拢也不放任冲突）
          }
          mode = isMulti ? 'multi' : 'single'
        }
      }
    }

    cache.set(parentCode, mode)
    return mode
  }

  /**
   * 多语言展示层标签名解析器 (Tag Display Resolver)
   * ADR-0038 / Issue #682 / tag-aliases-lang-tables：
   * 1. 受控 + 动态标签展示名统一查主库当前语言分表 tag_aliases（本地持久化镜像，零网络）；
   * 2. 用户/扩展标签兜底读取本地 file_tags_private.name；
   * 3. 彻底废除对 omw_lexical_entries 等只读语义表的裸 SQL 查询与 TaxonomyAliasCache 内存总线。
   *
   * @param tagCodes 需要解析显示名称的标签 code 数组
   * @param locale 当前目标语言代码 (如 'zh-CN', 'en-US')，缺省为当前系统语言
   */
  public getCurrentLanguage(): string {
    return this.currentLanguage
  }

  public resolveTagDisplayNames(
    tagCodes: string[],
    locale?: string,
    dbInstance?: Database.Database
  ): Record<string, string> {
    const result: Record<string, string> = {}
    if (!tagCodes || tagCodes.length === 0) return result
    for (const code of tagCodes) {
      result[code] = code // 默认兜底为 code 本身
    }

    const distinctCodes = Array.from(new Set(tagCodes.filter(Boolean)))
    if (distinctCodes.length === 0) return result

    try {
      const activeDb = dbInstance || this._db
      const targetLocale = normalizeSupportedLocale(locale || this.currentLanguage || 'zh-CN')
      const isZh = targetLocale.toLowerCase().startsWith('zh')

      // 0) 中文环境下优先 AOT 受控权威词条（仅针对受控代码：omw.*, hownet.*, builtin.*）
      if (isZh) {
        for (const code of distinctCodes) {
          if (
            code.startsWith('builtin.') ||
            code.startsWith('omw.') ||
            code.startsWith('hownet.')
          ) {
            const canonical = getCanonicalConceptName(code)
            if (canonical) {
              result[code] = canonical
            }
          }
        }
      }

      // 1) 受控 + 动态标签统一查当前语言分表（替换内存总线优先）
      if (activeDb && distinctCodes.length > 0) {
        try {
          const aliasPlaceholders = distinctCodes.map(() => '?').join(',')
          // 优先规范名（is_canonical=1），其次首个词形
          const aliasRows = activeDb
            .prepare(
              `SELECT tag_code, lemma FROM tag_aliases
               WHERE locale = ? AND tag_code IN (${aliasPlaceholders})
               ORDER BY is_canonical DESC, count DESC`
            )
            .all(targetLocale, ...distinctCodes) as { tag_code: string; lemma: string }[]
          for (const r of aliasRows) {
            if (r.lemma && result[r.tag_code] === r.tag_code) {
              result[r.tag_code] = r.lemma
            }
          }
        } catch {
          // 若当前分表在 mock DB 中不存在，平滑降级到 private 表或原名
        }
      }

      // 2) 未命中分表时，以本地 file_tags_private.name（默认名）兜底
      const stillMissing = distinctCodes.filter(c => result[c] === c)
      if (activeDb && stillMissing.length > 0) {
        try {
          const tagPlaceholders = stillMissing.map(() => '?').join(',')
          const tagRows = activeDb
            .prepare(`SELECT code, name FROM file_tags_private WHERE code IN (${tagPlaceholders})`)
            .all(...stillMissing) as { code: string; name: string }[]
          for (const row of tagRows) {
            if (row.name) {
              const isControlled =
                row.code.startsWith('builtin.') ||
                row.code.startsWith('omw.') ||
                row.code.startsWith('hownet.')
              const canonical = isZh && isControlled ? getCanonicalConceptName(row.code) : undefined
              result[row.code] = canonical || row.name
            }
          }
        } catch {}
      }

      // 3) 仍未命中的受控标签，优先 AOT 概念字典兜底，再提取可读 slug
      for (const code of distinctCodes) {
        if (
          result[code] === code &&
          (code.startsWith('builtin.') || code.startsWith('omw.') || code.startsWith('hownet.'))
        ) {
          const canonical = getCanonicalConceptName(code)
          if (canonical) {
            result[code] = canonical
          } else {
            const parts = code.split('.')
            const readable = parts[parts.length - 1]
            if (readable) {
              result[code] = readable
            }
          }
        }
      }
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, 'resolveTagDisplayNames 解析失败:', error)
    }

    return result
  }

  /**
   * 按 lemma 快速查询受控标签 tag_code (反查，走当前语言分表 lemma 索引)
   * 优先级：omw.* > builtin.*（与旧 TaxonomyAliasCache 反查映射规则一致）
   *
   * ADR-0048 两阶段跨语言反查：当前语言分表未命中时走 Unicode LID 异语分表反查，
   * 异语命中后反查当前语言 is_canonical = 1 规范名就地本地化（与 Rust 侧
   * resolve_controlled_tag_two_stage 对齐，Q2 选项 A）。
   *
   * @returns 命中的受控 code；`localized` 为异语命中时的当前语言规范展示名（同语种命中时为 undefined）
   */
  public findTagCodeByLemma(
    lemma: string,
    locale?: string
  ): { tagCode: string; localized?: string } | undefined {
    if (!lemma || !this._db) return undefined
    try {
      return findTagCodeTwoStage(this._db, lemma, locale, this.currentLanguage)
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, 'findTagCodeByLemma 反查失败:', error)
      return undefined
    }
  }

  /**
   * 运行时「首见回源」：把从 Omni inspectTags 回源命中的受控词补写进 tag_aliases 单表镜像。
   *
   * 防污染闸（Issue 02 Step 3 / Spec §B L326-344）：只放行受控前缀 omw.* / hownet.* / builtin.*，
   * 非受控码（_ext.* / user.* / custom.*）一律 logger.warn 后过滤，绝不入表（撞 CHECK 物理免疫）。
   *
   * R2-4 成对规范名三步 Upsert（单事务）：
   *   ① 写 is_canonical=1 前先降级同 (locale,tag_code) 下不同的旧规范名（防撞 uq_tag_aliases_one_canonical）；
   *   ② 规范名 ON CONFLICT DO UPDATE 且 count=MAX(不回退)；
   *   ③ 同义词 is_canonical=0 绝不清空既有 is_canonical=1。
   *
   * @param rows 回源命中的别名行（tagCode + lemma + isCanonical；同义词对由调用方成对传入）
   * @param locale 目标语言，如 zh-CN
   * @returns 实际写入行数（过滤非受控后）
   */
  public seedTagAliasRows(
    rows: Array<{
      tagCode: string
      lemma: string
      isCanonical?: boolean
      n?: number
      count?: number
    }>,
    locale?: string
  ): number {
    if (!this._db) return 0
    try {
      return seedTagAliasesSingleTable(this._db, locale || this.currentLanguage || 'zh-CN', rows)
    } catch (error) {
      logger.warn(LogCategory.DATABASE_SERVICE, 'seedTagAliasRows 补写单表失败:', error)
      return 0
    }
  }

  /**
   * 按 tag_code 快速查询当前语言规范展示名（单表 tag_aliases，优先规范名）
   */
  public findLemmaByTagCode(tagCode: string, locale?: string): string | undefined {
    if (!tagCode || !this._db) return undefined
    const safeLocale = normalizeSupportedLocale(locale || this.currentLanguage || 'zh-CN')
    try {
      const rows = this._db
        .prepare(
          `SELECT lemma FROM tag_aliases
           WHERE locale = ? AND tag_code = ? AND is_canonical = 1
           ORDER BY count DESC
           LIMIT 1`
        )
        .all(safeLocale, tagCode) as { lemma: string }[]
      return rows[0]?.lemma
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, 'findLemmaByTagCode 查询失败:', error)
      return undefined
    }
  }

  /**
   * AI 分析完成后将 dense 向量写入 Omni zvec（替代旧 file_vectors BLOB 堆表）
   * `encoderId` 必填：向量真实编码器出处（zvec v3 encoder_id），由调用方从 perceive 响应原样透传，
   * 禁止本层按档位或语言补默认值。
   */
  public async upsertFileVectorToOmni(
    fileFingerprint: string,
    embedding: number[] | Float32Array | null | undefined,
    encoderId: number
  ): Promise<boolean> {
    if (!fileFingerprint || !embedding) return false
    const vector = embedding instanceof Float32Array ? Array.from(embedding) : embedding
    if (!Array.isArray(vector) || vector.length === 0) return false
    const res = await omniClient.upsertVector(fileFingerprint, vector, encoderId)
    return !!res?.success
  }

  /**
   * 批量将切片或文件 dense 向量写入 Omni zvec
   * 每个条目必须携带自己的 `encoderId`（视频切片与主向量可能不同源），禁止本层统一猜测。
   */
  public async upsertFileVectorsToOmni(
    items: Array<{ fileFingerprint: string; vector: number[] | Float32Array; encoderId: number }>
  ): Promise<boolean> {
    if (!items || items.length === 0) return true
    const validItems: Array<{ fileFingerprint: string; vector: number[]; encoderId: number }> = []
    for (const item of items) {
      if (!item.fileFingerprint || !item.vector) continue
      const v = item.vector instanceof Float32Array ? Array.from(item.vector) : item.vector
      if (Array.isArray(v) && v.length > 0) {
        validItems.push({
          fileFingerprint: item.fileFingerprint,
          vector: v,
          encoderId: item.encoderId
        })
      }
    }
    if (validItems.length === 0) return true
    const res = await omniClient.upsertVectors(validItems)
    return !!res?.success
  }

  /**
   * 批量写入视频时序切片记录
   */
  insertVideoChunks(chunks: VideoChunkRecord[]): void {
    this.ensureInitialized()
    this.fileDao!.insertVideoChunks(chunks)
  }

  /**
   * [Issue 04 Step 3 / FIN-12] 每完成一段，单事务内按 [startSec, endSec) 区间替换 chunks。
   * 分段续跑只重算未完成段，已完成段 chunks 在 DB 中稳定留存。
   */
  replaceVideoChunksInRange(
    fileFingerprint: string,
    chunks: VideoChunkRecord[],
    startSec: number,
    endSec: number
  ): void {
    this.ensureInitialized()
    this.fileDao!.replaceVideoChunksInRange(fileFingerprint, chunks, startSec, endSec)
  }

  /**
   * 按指纹获取视频时序切片记录
   */
  getVideoChunks(fileFingerprint: string): Array<{
    id?: number
    fileFingerprint: string
    chunkIndex: number
    startSec: number
    endSec: number
    repPtsSec: number
    meta: Record<string, any>
    samplingIntervalSeconds: number
    createdAt?: string
  }> {
    this.ensureInitialized()
    return this.fileDao!.getVideoChunks(fileFingerprint)
  }

  /**
   * 按指纹删除视频时序切片记录
   */
  deleteVideoChunks(fileFingerprint: string): void {
    this.ensureInitialized()
    this.fileDao!.deleteVideoChunks(fileFingerprint)
  }

  /**
   * 启动时清理残留的 processing 状态，保护崩溃后任务安全恢复 (ISS-25 / ISS-37)
   */
  getVideoSegments(fileId: string) {
    return this.fileDao.getVideoSegments(fileId)
  }

  getIncompleteVideoFiles() {
    return this.fileDao.getIncompleteVideoFiles()
  }

  getWorkspaceIdsWithPendingVideoSegments(): number[] {
    return this.fileDao?.getWorkspaceIdsWithPendingVideoSegments() ?? []
  }

  getPendingVideoSegmentsForWorkspace(workspaceId: number, maxStartPtsSec: number) {
    return this.fileDao?.getPendingVideoSegmentsForWorkspace(workspaceId, maxStartPtsSec) ?? []
  }

  getWorkspacePendingBackfillVideos(workspaceId: number, effectiveLimitSec: number) {
    return this.fileDao?.getWorkspacePendingBackfillVideos(workspaceId, effectiveLimitSec) ?? []
  }

  resetFailedVideoSegmentsForWorkspace(workspaceId: number, effectiveLimitSec: number): number {
    return this.fileDao?.resetFailedVideoSegmentsForWorkspace(workspaceId, effectiveLimitSec) ?? 0
  }

  resetUpgradedVideoSegmentsForWorkspace(
    workspaceId: number,
    effectiveLimitSec: number,
    expectedParamsHash: string,
    isReusableFn: (seg: { status?: string; params_hash?: string }, expectedHash: string) => boolean
  ): number {
    return (
      this.fileDao?.resetUpgradedVideoSegmentsForWorkspace(
        workspaceId,
        effectiveLimitSec,
        expectedParamsHash,
        isReusableFn
      ) ?? 0
    )
  }

  unlockVideoSegments(): number {
    return this.fileDao?.unlockVideoSegments() ?? 0
  }

  lockPendingVideoSegments(fileId?: string): number {
    return this.fileDao?.lockPendingVideoSegments(fileId) ?? 0
  }

  resetDanglingVideoSegmentsOnStartup(): void {
    if (this.fileDao) {
      this.fileDao.resetDanglingVideoSegmentsOnStartup()
    }
  }

  upsertVideoSegment(segment: Parameters<FileDao['upsertVideoSegment']>[0]): void {
    this.fileDao?.upsertVideoSegment(segment)
  }

  markVideoSegmentProcessing(fileId: string, segmentIndex: number): boolean {
    return this.fileDao?.markVideoSegmentProcessing(fileId, segmentIndex) ?? false
  }

  markVideoSegmentFailedOrPending(fileId: string, segmentIndex: number, errorMsg: string): void {
    this.fileDao?.markVideoSegmentFailedOrPending(fileId, segmentIndex, errorMsg)
  }

  markVideoSegmentTerminalFailed(fileId: string, segmentIndex: number, errorMsg: string): void {
    this.fileDao?.markVideoSegmentTerminalFailed(fileId, segmentIndex, errorMsg)
  }

  rollbackVideoSegmentProcessing(fileId: string, segmentIndex: number): void {
    this.fileDao?.rollbackVideoSegmentProcessing(fileId, segmentIndex)
  }

  resetEmptyCompletedVideoSegment(fileId: string, segmentIndex: number): boolean {
    return this.fileDao?.resetEmptyCompletedVideoSegment(fileId, segmentIndex) ?? false
  }

  getVideoCoverageStatsBatch(fileIds: string[]) {
    return this.fileDao?.getVideoCoverageStatsBatch(fileIds) ?? new Map()
  }

  markVideoSegmentCompleted(
    fileId: string,
    segmentIndex: number,
    stats: {
      frameCount: number
      visualEmbeddedCount: number
      asrTranscriptChars: number
      paramsHash?: string
    }
  ): void {
    this.fileDao?.markVideoSegmentCompleted(fileId, segmentIndex, stats)
  }

  /**
   * 视觉打标器状态代际 DAO 代理 (Spec v2.12 §3.3 / Ticket 09)
   */
  getVisualTaggerState(encoderId: number) {
    return this.visualTaggerStateDao?.getState(encoderId) ?? null
  }

  getVisualTaggerGeneration(encoderId: number): number {
    return this.visualTaggerStateDao?.getCurrentGeneration(encoderId) ?? 0
  }

  recordQueueVisualFailureTx(params: {
    queueId: number
    errorMessage: string
    failureCode: string
    encoderId: number
    expectedFingerprint?: string | null
    markStateNonOk?: boolean
  }): { failureGeneration: number } {
    if (!this.visualTaggerStateDao) {
      return { failureGeneration: 0 }
    }
    return this.visualTaggerStateDao.recordQueueVisualFailureTx(params)
  }

  recordVideoSegmentVisualFailureTx(params: {
    fileId: string
    segmentIndex: number
    errorMessage: string
    failureCode: string
    encoderId: number
    expectedFingerprint?: string | null
    markStateNonOk?: boolean
  }): { failureGeneration: number } {
    if (!this.visualTaggerStateDao) {
      return { failureGeneration: 0 }
    }
    return this.visualTaggerStateDao.recordVideoSegmentVisualFailureTx(params)
  }

  observeTaggerHealthyOrFingerprintChangedTx(
    encoderId: number,
    expectedFingerprint?: string | null,
    currentAppVersion?: string | null
  ): {
    bumped: boolean
    appVersionChanged: boolean
    previousGeneration: number
    currentGeneration: number
  } {
    if (!this.visualTaggerStateDao) {
      return {
        bumped: false,
        appVersionChanged: false,
        previousGeneration: 0,
        currentGeneration: 0
      }
    }
    return this.visualTaggerStateDao.observeTaggerHealthyOrFingerprintChangedTx(
      encoderId,
      expectedFingerprint,
      currentAppVersion
    )
  }

  incrementQueueRetryCount(id: number): number {
    return this.queueDao?.incrementRetryCountSync(id) ?? 1
  }

  requeueEligibleFailedItemsTx(params: {
    activeEncoderId: number
    currentGeneration: number
    limit?: number
    includeNeedsAppUpdate?: boolean
  }): { requeuedQueueCount: number; requeuedSegmentCount: number } {
    if (!this.visualTaggerStateDao) {
      return { requeuedQueueCount: 0, requeuedSegmentCount: 0 }
    }
    return this.visualTaggerStateDao.requeueEligibleFailedItemsTx(params)
  }

  /**
   * 切换语言时重建只读调试视图的展示路径（模型 B 下 name_path 物化已退役，零数据行写入）
   */
  public rebuildDebugTagViewsForLanguage(locale: string): void {
    rebuildDebugTagViews(this._db!, locale)
  }

  /* ==================== W4/J-13 批量入库（两段式） ==================== */

  /**
   * [J-13 / DB-02] 批量预写入库：异步准备（stat / 指纹 / 同路径去重）与同步短事务分离。
   *
   * 三段硬约束（§4.2 防幽灵行）：
   * 1. 同工作区 FIFO 串行 + 每路径单调序号：准备期被覆盖的旧条目进入事务前一律丢弃；
   * 2. 每批事务首句存在性守卫：workspace / 目标目录已在批间删除则中止剩余批次；
   * 3. 批间 setImmediate 复检取消信号与工作区代际，禁止复活准备期已被删除的文件。
   *
   * 写锁协议（§5.1）：每批前在事务外 `await sendYieldAndWaitAck(leaseId, 200)`（50ms ACK 超时
   * 尽力而为继续 + warn 留痕），`finally` 必发同 leaseId RESUME；短事务一律 `.immediate()`，
   * 严禁默认 deferred BEGIN 触发 SQLITE_BUSY_SNAPSHOT。SQL 采用
   * `ON CONFLICT(workspace_id, path) DO UPDATE SET ... COALESCE(...) RETURNING id`，
   * skipHash 的 null 指纹绝不抹掉既有值，且幂等返回真实数字 id。
   */
  async upsertPreparedFilesBatch(
    inputs: PreparedFileUpsertInput[],
    options: UpsertPreparedFilesBatchOptions
  ): Promise<UpsertPreparedFilesBatchResult> {
    const db = this._db
    if (!db) throw new Error('数据库未初始化')
    const { workspaceId } = options
    const stopOnError = options.stopOnError ?? true
    const batchSize = Math.min(
      J13_MAX_BATCH_SIZE,
      Math.max(1, options.batchSize ?? J13_MAX_BATCH_SIZE)
    )

    const result: UpsertPreparedFilesBatchResult = {
      ids: new Array(inputs.length).fill(null),
      writeLockWaitMs: [],
      maxTransactionHoldMs: 0,
      droppedCount: 0
    }
    if (inputs.length === 0) return result

    const entryGeneration =
      options.getWorkspaceGeneration?.() ?? getJ13WorkspaceGeneration(workspaceId)
    const handshake = getWriterLeaseHandshake()
    const needHandshake = handshake?.isWriterProcessActive() ?? false
    const leaseId = `main-ingest:${workspaceId}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`

    // ---------- 阶段 1：异步准备（stat / 指纹 / 同路径去重），零 WAL 锁 ----------
    const latestByPath = new Map<string, number>()
    for (let i = 0; i < inputs.length; i++) {
      const key = `${workspaceId}\u0000${inputs[i].filePath}`
      latestByPath.set(key, i)
    }
    const prepared: J13PreparedRow[] = []
    const activeIgnoreRules = loadIgnoreRules()

    for (let i = 0; i < inputs.length; i++) {
      const key = `${workspaceId}\u0000${inputs[i].filePath}`
      if (latestByPath.get(key) !== i) {
        // 同路径准备去重：仅保留最新一项，旧项丢弃（防双算哈希 + 防覆盖）
        result.droppedCount++
        continue
      }
      const input = inputs[i]
      let stats: fs.Stats
      try {
        stats = await fs.promises.stat(input.filePath)
        if (!stats.isFile()) throw new Error('not a regular file')
      } catch (error) {
        logger.warn(
          LogCategory.DATABASE_SERVICE,
          `[J-13] stat 失败，跳过 (${input.filePath}):`,
          error
        )
        result.droppedCount++
        continue
      }

      let directoryId: number
      try {
        directoryId = await this.addDirectory(path.dirname(input.filePath), workspaceId)
      } catch (error) {
        logger.warn(
          LogCategory.DATABASE_SERVICE,
          `[J-13] addDirectory 失败，跳过 (${input.filePath}):`,
          error
        )
        result.droppedCount++
        continue
      }

      let fingerprint: string | null = input.fileFingerprint ?? null
      if (!input.skipHash && !fingerprint) {
        try {
          fingerprint = await calculateFileFingerprint(input.filePath)
        } catch (error) {
          logger.warn(
            LogCategory.DATABASE_SERVICE,
            `[J-13] 指纹计算失败，按 null 落库 (${input.filePath}):`,
            error
          )
          fingerprint = null
        }
      }

      const existing = getCachedStatement<any>(
        db,
        `SELECT id, file_fingerprint, is_analyzed FROM workspace_files WHERE workspace_id = ? AND path = ?`
      ).get(workspaceId, input.filePath) as
        | { id: number; file_fingerprint: string | null; is_analyzed: number }
        | undefined

      // skipHash：复用既有有效指纹，绝不传 null 抹掉
      if (input.skipHash) fingerprint = existing?.file_fingerprint ?? null

      const pathKey = `${workspaceId}\u0000${input.filePath}`
      const sequence = (j13PathSequences.get(pathKey) ?? 0) + 1
      j13PathSequences.set(pathKey, sequence)
      prepared.push({
        index: i,
        filePath: input.filePath,
        sequence,
        fingerprint,
        directoryId,
        size: stats.size,
        mtimeMs: Math.trunc(stats.mtimeMs),
        mtimeIso: stats.mtime.toISOString(),
        birthtimeIso: stats.birthtime.toISOString(),
        atimeIso: stats.atime.toISOString(),
        isIgnored: shouldIgnoreFile(
          input.filePath,
          path.basename(input.filePath),
          activeIgnoreRules
        )
          ? 1
          : 0,
        isAnalyzed: existing?.is_analyzed || 0
      })
    }

    // ---------- 阶段 2：按 workspaceId FIFO 串行落库 ----------
    const previous = j13IngestChains.get(workspaceId) ?? Promise.resolve()
    let releaseChain!: () => void
    const currentChain = new Promise<void>(resolve => {
      releaseChain = resolve
    })
    const chained = previous.then(() => currentChain)
    j13IngestChains.set(workspaceId, chained)

    try {
      await previous
      for (let offset = 0; offset < prepared.length; offset += batchSize) {
        // 批间让出事件循环 + 取消/代际复检（§4.2 约束 3）
        if (offset > 0) {
          await new Promise<void>(resolve => setImmediate(resolve))
        }
        if (options.isCancelled?.()) {
          logger.warn(
            LogCategory.DATABASE_SERVICE,
            `[J-13] workspace=${workspaceId} 收到取消信号，丢弃剩余 ${prepared.length - offset} 项`
          )
          result.droppedCount += prepared.length - offset
          break
        }
        if (
          (options.getWorkspaceGeneration?.() ?? getJ13WorkspaceGeneration(workspaceId)) !==
          entryGeneration
        ) {
          logger.warn(
            LogCategory.DATABASE_SERVICE,
            `[J-13] workspace=${workspaceId} 代际变化，丢弃剩余 ${prepared.length - offset} 项（防幽灵行）`
          )
          result.droppedCount += prepared.length - offset
          break
        }

        const batch = prepared.slice(offset, offset + batchSize)
        let acked = true
        if (needHandshake && handshake) {
          try {
            acked = await handshake.sendYieldAndWaitAck(leaseId, 200)
          } catch (error) {
            acked = false
            logger.warn(
              LogCategory.DATABASE_SERVICE,
              `[J-13] lease=${leaseId} YIELD_FOR_UI 握手异常，尽力而为继续:`,
              error
            )
          }
          if (!acked) {
            logger.warn(
              LogCategory.DATABASE_SERVICE,
              `[J-13] lease=${leaseId} 未收到 YIELD_ACK（尽力而为继续，写锁等待 p99 兜底）`
            )
          }
        }

        try {
          await this.executeJ13Batch(
            db,
            batch,
            workspaceId,
            result,
            stopOnError,
            options.onBatchHoldMs
          )
        } finally {
          if (needHandshake && handshake) {
            try {
              handshake.resumeLease(leaseId)
            } catch (error) {
              logger.warn(
                LogCategory.DATABASE_SERVICE,
                `[J-13] lease=${leaseId} RESUME 失败:`,
                error
              )
            }
          }
        }
      }
    } finally {
      releaseChain()
      if (j13IngestChains.get(workspaceId) === chained) j13IngestChains.delete(workspaceId)
    }

    return result
  }

  /**
   * J-13 单批同步短事务：事务首句存在性守卫 + 父表插入 + 幂等 UPSERT RETURNING id。
   * 瞬态锁竞争在事务外指数退避重试（最多 2 次），失败显式 logger.error 留痕。
   */
  private async executeJ13Batch(
    db: Database.Database,
    batch: J13PreparedRow[],
    workspaceId: number,
    result: UpsertPreparedFilesBatchResult,
    stopOnError: boolean,
    onBatchHoldMs?: (ms: number, batchSize: number) => void
  ): Promise<void> {
    const now = new Date().toISOString()
    let activeBatch = batch
    let lastError: unknown

    for (let attempt = 0; attempt <= J13_MAX_RETRIES; attempt++) {
      // 防幽灵行约束 3：在获取 SQLite 写锁之前并发异步复检物理文件存在性，
      // 严禁在 BEGIN IMMEDIATE 事务持锁期内同步 fs.statSync 阻塞磁盘 I/O（既守住棘轮基线也保 <20ms 持锁上限）。
      const statChecks = await Promise.all(
        activeBatch.map(async row => {
          try {
            const physicalStat = await fs.promises.stat(row.filePath)
            return physicalStat.isFile()
          } catch {
            return false
          }
        })
      )
      const survivors: J13PreparedRow[] = []
      for (let i = 0; i < activeBatch.length; i++) {
        const row = activeBatch[i]
        if (statChecks[i]) {
          survivors.push(row)
        } else {
          logger.warn(
            LogCategory.DATABASE_SERVICE,
            `[J-13] 物理文件已在准备后消失，丢弃幽灵行 (${row.filePath})`
          )
          result.ids[row.index] = null
          result.droppedCount++
        }
      }
      activeBatch = survivors
      if (activeBatch.length === 0) return

      let transactionStarted = false
      const waitStart = performance.now()
      let lockAcquiredAt = waitStart
      try {
        const tx = db.transaction(() => {
          // better-sqlite3 的 .immediate() 在事务体首句执行前已获得写锁；
          // 此处打点即为「写锁获取完成」时刻，与事务体 SQL 执行时长分离采样。
          lockAcquiredAt = performance.now()
          // ---- 事务首句：workspace 存在性守卫（防批间删除造孤儿 / 23503） ----
          const ws = getCachedStatement<any>(
            db,
            `SELECT 1 FROM workspaces WHERE workspace_id = ?`
          ).get(workspaceId)
          if (!ws) throw new Error(`workspace=${workspaceId} 已在批间删除，丢弃整批`)

          const insertFileStmt = getCachedStatement<any>(
            db,
            `INSERT OR IGNORE INTO files (file_fingerprint, smart_name, size, extension, file_group, created_at, modified_at, accessed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          const insertContentStmt = getCachedStatement<any>(
            db,
            `INSERT OR IGNORE INTO file_contents (file_fingerprint) VALUES (?)`
          )
          const upsertStmt = getCachedStatement<any>(
            db,
            `INSERT INTO workspace_files
               (file_fingerprint, workspace_id, directory_id, path, name, created_at, modified_at, accessed_at,
                is_analyzed, file_size, mtime_ms, is_ignored)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(workspace_id, path) DO UPDATE SET
               file_fingerprint = COALESCE(excluded.file_fingerprint, workspace_files.file_fingerprint),
               modified_at = excluded.modified_at,
               file_size = excluded.file_size,
               mtime_ms = excluded.mtime_ms,
               is_ignored = excluded.is_ignored
             RETURNING id`
          )
          const dirGuardStmt = getCachedStatement<any>(
            db,
            `SELECT 1 FROM workspace_directories WHERE id = ? AND workspace_id = ?`
          )

          for (const row of activeBatch) {
            // 防幽灵行约束 1：每路径单调序号复检——准备期后同路径已被更新的旧条目一律跳过
            const pathKey = `${workspaceId}\u0000${row.filePath}`
            if (j13PathSequences.get(pathKey) !== row.sequence) {
              result.ids[row.index] = null
              result.droppedCount++
              continue
            }
            // 目录存在性守卫：父目录已在批间删除则整批中止（外键 CASCADE 防孤儿）
            const dir = dirGuardStmt.get(row.directoryId, workspaceId)
            if (!dir) throw new Error(`directory=${row.directoryId} 已在批间删除，丢弃整批`)

            // 父子写入顺序：workspace_directories → files → file_contents → workspace_files
            if (row.fingerprint) {
              insertFileStmt.run(
                row.fingerprint,
                path.basename(row.filePath),
                row.size,
                normalizeFileExtension(row.filePath),
                JSON.stringify({ mime_type: 'application/octet-stream' }),
                row.birthtimeIso,
                row.mtimeIso,
                row.atimeIso
              )
              insertContentStmt.run(row.fingerprint)
            }

            try {
              const upserted = upsertStmt.get(
                row.fingerprint,
                workspaceId,
                row.directoryId,
                row.filePath,
                path.basename(row.filePath),
                now,
                now,
                now,
                row.isAnalyzed,
                row.size,
                row.mtimeMs,
                row.isIgnored
              ) as { id: number } | undefined
              result.ids[row.index] = upserted?.id ?? null
            } catch (rowError) {
              // SQLite 默认语句约束失败为 ABORT：仅回滚本语句，不回滚外层事务；严禁 OR ROLLBACK
              logger.warn(
                LogCategory.DATABASE_SERVICE,
                `[J-13] 单行 UPSERT 失败 (${row.filePath}):`,
                rowError
              )
              result.ids[row.index] = null
              if (stopOnError) throw rowError
            }
          }
        })
        transactionStarted = true
        tx.immediate()
        const lockWait = lockAcquiredAt - waitStart
        result.writeLockWaitMs.push(lockWait)
        getWriterLeaseHandshake()?.observeWriteLockWaitMs(lockWait)
        const holdMs = performance.now() - lockAcquiredAt
        result.maxTransactionHoldMs = Math.max(result.maxTransactionHoldMs, holdMs)
        onBatchHoldMs?.(holdMs, batch.length)
        return
      } catch (error) {
        if (transactionStarted && db.inTransaction) {
          try {
            db.exec('ROLLBACK')
          } catch (rbErr) {
            logger.warn(LogCategory.DATABASE_SERVICE, '[J-13] 批事务回滚失败:', rbErr)
          }
        }
        lastError = error
        const message = error instanceof Error ? error.message : String(error)
        const retryable = /BUSY|LOCKED/i.test(message)
        if (!retryable || attempt === J13_MAX_RETRIES) {
          // 回滚后恢复该批所有 id 为 null（此前提交批次保留，与原遇错即停语义一致）
          for (const row of batch) result.ids[row.index] = null
          logger.error(
            LogCategory.DATABASE_SERVICE,
            `[J-13] 批事务失败已回滚 (workspace=${workspaceId}, attempt=${attempt + 1}):`,
            error
          )
          if (stopOnError) throw error
          return
        }
        logger.warn(
          LogCategory.DATABASE_SERVICE,
          `[J-13] 瞬态锁竞争，事务外退避重试 (${attempt + 1}/${J13_MAX_RETRIES}):`,
          message
        )
        await new Promise<void>(resolve => setTimeout(resolve, 5 * (attempt + 1)))
      } finally {
        // 防御：任何异常路径都不允许遗留打开的事务
        if (db.inTransaction && !transactionStarted) {
          try {
            db.exec('ROLLBACK')
          } catch (rbErr) {
            logger.warn(LogCategory.DATABASE_SERVICE, '[J-13] 兜底回滚失败:', rbErr)
          }
        }
      }
    }
    if (lastError) {
      for (const row of batch) result.ids[row.index] = null
      if (stopOnError) throw lastError
    }
  }
}
