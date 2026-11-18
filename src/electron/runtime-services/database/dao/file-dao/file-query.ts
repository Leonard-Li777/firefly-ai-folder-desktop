import type { Database, Statement } from 'better-sqlite3'
import type { VideoChunkRecord } from '@firefly/types'
import {
  LogCategory,
  logger,
  cleanSmartName,
  isTagProvenanceGroup,
  TAG_PROVENANCE_GROUPS,
  getCanonicalConceptName,
  isTagAdmissible,
  normalizeFileExtension,
  type TagProvenanceGroup
} from '@firefly/shared'
import { t } from '@app/languages'
import * as path from 'path'
import * as fs from 'fs'
import { AccessTimeBatchUpdater } from '../../access-time-batch-updater'
import { resolveTagAliasesLangTable } from '../../database'
import { ConfigOrchestrator } from '../../../../config/config-orchestrator'
import {
  isAnalyzedForMode,
  normalizeAnalysisMode,
  type AnalysisMode
} from '../../../../config/analysis-mode'
import {
  compressText,
  decompressText,
  compressJson,
  decompressJson
} from '../../../../utils/text-compressor'

import { FilePinyinFtsSyncMixin } from './file-pinyin-fts-sync'
import { dimensionForCode } from './shared'

/**
 * FileDao 查询/索引 mixin（Ticket 10 · 大文件模块化拆分）。
 *
 * 承载查询过滤与拼音索引 / FTS 标签同步：getAllFiles、searchFilesFTS、
 * searchVirtualDirectoryFTS、getAnalyzedFileByContentHash、getFileByPath、
 * updateFileMetadata、resetFileAnalysis、各 workspace 统计/列表、分析阶段推进、
 * 拼音正排索引 reconciler（syncPinyinIndex* / optimizePinyinIndex）、
 * 以及 FTS tags 同步（syncFTSTags / syncFTSTagsBatch）。
 *
 * 全部代码自 `file-dao.ts` 原样搬移，未改动任何逻辑、命名或注释措辞。
 */
export class FileQueryMixin extends FilePinyinFtsSyncMixin {
  async getAllFiles(limit?: number, offset?: number): Promise<any[]> {
    let sql = `
      SELECT f.*, wf.path, wf.name, wf.modified_at as wf_mod, wf.id, fc.*
      FROM workspace_files wf
      LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
      LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
      ORDER BY wf.modified_at DESC
    `
    const params: any[] = []
    if (limit !== undefined) {
      sql += ` LIMIT ?`
      params.push(limit)
      if (offset !== undefined) {
        sql += ` OFFSET ?`
        params.push(offset)
      }
    }
    const rows = this.db.prepare(sql).all(...params) as any[]

    return rows.map(row => {
      const normalizedExt = normalizeFileExtension(row.extension || row.path || '')
      return {
        id: row.id,
        name: row.name,
        path: row.path,
        smartName: row.smart_name,
        size: row.size || 0,
        extension: normalizedExt,
        fileGroup: row.file_group ?? undefined,
        createdAt: new Date(row.created_at || Date.now()),
        modifiedAt: new Date(row.wf_mod),
        description: row.description,
        content: row.content,
        qualityScore: row.quality_score,
        metadata: row.metadata ? JSON.parse(row.metadata) : undefined
      }
    })
  }

  async searchFilesFTS(query: string, workspaceId?: number): Promise<any[]> {
    if (!query || query.trim().length === 0) return []

    const trimmedQuery = query.trim()

    if (trimmedQuery.length < 3) {
      let sql = `
        SELECT f.*, wf.id, wf.path, wf.name, wf.is_analyzed, wf.modified_at as wf_mod, fc.quality_score
        FROM workspace_files wf
        LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
        LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
        WHERE (wf.name LIKE ? OR f.smart_name LIKE ? OR f.description LIKE ? OR decompress_text(fc.content) LIKE ? OR decompress_text(fc.multimodal_content) LIKE ? OR decompress_text(fc.lrc) LIKE ? OR decompress_text(fc.asr) LIKE ?)
      `
      const likeQuery = `%${trimmedQuery}%`
      const params: any[] = [
        likeQuery,
        likeQuery,
        likeQuery,
        likeQuery,
        likeQuery,
        likeQuery,
        likeQuery
      ]

      if (workspaceId) {
        sql += ` AND wf.workspace_id = ?`
        params.push(workspaceId)
      }
      sql += ` ORDER BY wf.modified_at DESC LIMIT 100`

      const rows = this.db.prepare(sql).all(...params) as any[]
      return rows.map(row => ({
        ...row,
        id: row.id,
        modifiedAt: new Date(row.wf_mod),
        isAnalyzed: row.is_analyzed === 1,
        isHit: row.is_hit === 1,
        qualityScore: row.quality_score,
        rank: 0
      }))
    }

    const sanitizedQuery = `"${trimmedQuery.replace(/["]/g, '""')}"`
    const { stmt, extraParams } = this.getFtsSearchStmt(workspaceId)
    const rows = stmt.all(sanitizedQuery, ...extraParams) as any[]
    return rows.map(row => ({
      ...row,
      id: row.id,
      modifiedAt: new Date(row.wf_mod),
      isAnalyzed: row.is_analyzed === 1,
      isHit: row.is_hit === 1,
      qualityScore: row.quality_score
    }))
  }

  async searchVirtualDirectoryFTS(query: string, virtualDirectoryId?: number): Promise<any[]> {
    if (!query || query.trim().length === 0) return []

    const trimmedQuery = query.trim()

    if (trimmedQuery.length < 3) {
      let sql = `
        SELECT
          f.*, wf.id, wf.path, wf.name, wf.is_analyzed, wf.modified_at as wf_mod,
          fc.quality_score, vdf.relative_path, vdf.virtual_directory_id
        FROM virtual_directory_files vdf
        JOIN workspace_files wf ON vdf.file_id = wf.id
        LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
        LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
        WHERE (wf.name LIKE ? OR f.smart_name LIKE ? OR f.description LIKE ? OR decompress_text(fc.content) LIKE ? OR decompress_text(fc.multimodal_content) LIKE ? OR decompress_text(fc.lrc) LIKE ? OR decompress_text(fc.asr) LIKE ?)
      `
      const likeQuery = `%${trimmedQuery}%`
      const params: any[] = [
        likeQuery,
        likeQuery,
        likeQuery,
        likeQuery,
        likeQuery,
        likeQuery,
        likeQuery
      ]

      if (virtualDirectoryId) {
        sql += ` AND vdf.virtual_directory_id = ?`
        params.push(virtualDirectoryId)
      }
      sql += ` ORDER BY wf.modified_at DESC LIMIT 100`

      const rows = this.db.prepare(sql).all(...params) as any[]
      return rows.map(row => ({
        ...row,
        id: row.id,
        modifiedAt: new Date(row.wf_mod),
        isAnalyzed: row.is_analyzed === 1,
        isHit: row.is_hit === 1,
        qualityScore: row.quality_score,
        rank: 0
      }))
    }

    const sanitizedQuery = `"${trimmedQuery.replace(/["]/g, '""')}"`
    const stmt = this.getFtsVirtualSearchStmt()
    const rows = stmt.all(
      sanitizedQuery,
      virtualDirectoryId ?? null,
      virtualDirectoryId ?? null
    ) as any[]
    return rows.map(row => ({
      ...row,
      id: row.id,
      modifiedAt: new Date(row.wf_mod),
      isAnalyzed: row.is_analyzed === 1,
      isHit: row.is_hit === 1,
      qualityScore: row.quality_score
    }))
  }

  async getAnalyzedFileByContentHash(contentHash: string): Promise<any> {
    try {
      const row = this.db
        .prepare(
          `
        SELECT f.*, fc.*, (SELECT 1 FROM workspace_files wf WHERE wf.file_fingerprint = ? AND wf.is_analyzed = 1 LIMIT 1) as is_analyzed
        FROM files f
        LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
        WHERE f.file_fingerprint = ? 
      `
        )
        .get(contentHash, contentHash) as any

      if (!row || !row.is_analyzed) return null

      const normalizedExt = row.extension
        ? row.extension.startsWith('.')
          ? row.extension
          : `.${row.extension}`
        : ''
      return {
        id: row.file_fingerprint,
        name: row.name,
        smartName: row.smart_name,
        contentHash: row.file_fingerprint,
        size: row.size,
        extension: normalizedExt,
        fileGroup: row.file_group ?? undefined,
        isAnalyzed: true,
        qualityScore: row.quality_score,
        qualityConfidence: row.quality_confidence,
        qualityReasoning: row.quality_reasoning,
        qualityCriteria: row.quality_criteria ? JSON.parse(row.quality_criteria) : undefined,
        description: row.description,
        content: decompressText(row.content),
        multimodalContent: decompressText(row.multimodal_content),
        ocr: decompressText(row.ocr),
        lrc: decompressText(row.lrc),
        asr: decompressText(row.asr),
        groupingReason: row.grouping_reason,
        groupingConfidence: row.grouping_confidence,
        author: row.author,
        language: row.language,
        metadata: decompressJson(row.exif) ?? row.metadata
      }
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '根据内容哈希获取分析文件失败', {
        error,
        contentHash
      })
      return null
    }
  }

  /**
   * 按工作区路径取文件指纹（轻量查询，不联表加载 contents）。
   *
   * 队列项只带 `path` 时需要指纹来寻址 `files` / `file_contents`，此方法提供该跳转。
   */
  getFileFingerprintByPath(filePath: string): string | null {
    if (!filePath) return null
    try {
      const row = this.db
        .prepare(`SELECT file_fingerprint FROM workspace_files WHERE path = ?`)
        .get(filePath) as { file_fingerprint?: string | null } | undefined
      return row?.file_fingerprint ?? null
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '按路径查询文件指纹失败', { error, filePath })
      return null
    }
  }

  async getFileByPath(filePath: string): Promise<any> {
    try {
      const wf = this.db
        .prepare(
          `
        SELECT * FROM workspace_files 
        WHERE path = ?`
        )
        .get(filePath) as any

      if (!wf) return null

      let fileData: any = {}
      if (wf.file_fingerprint) {
        const fileStmt = this.db.prepare(
          'SELECT * FROM files LEFT JOIN file_contents USING(file_fingerprint) WHERE file_fingerprint = ?'
        )
        const f = fileStmt.get(wf.file_fingerprint) as any
        if (f) fileData = f
      }

      const normalizedExt = fileData.extension
        ? fileData.extension.startsWith('.')
          ? fileData.extension
          : `.${fileData.extension}`
        : wf.path
          ? path.extname(wf.path).toLowerCase()
          : ''

      return {
        id: wf.id,
        name: wf.name,
        path: wf.path,
        contentHash: wf.file_fingerprint,
        parentPath: path.dirname(wf.path),
        size: fileData.size || 0,
        extension: normalizedExt,
        fileGroup: fileData.file_group ?? undefined,
        createdAt: new Date(wf.created_at),
        modifiedAt: new Date(wf.modified_at),
        isSelected: false,
        isAnalyzed: wf.is_analyzed === 1,
        lastAnalyzedAt: wf.last_analyzed_at ? new Date(wf.last_analyzed_at) : undefined,
        qualityScore: fileData.quality_score,
        description: fileData.description,
        content: decompressText(fileData.content),
        multimodalContent: decompressText(fileData.multimodal_content),
        ocr: decompressText(fileData.ocr),
        lrc: decompressText(fileData.lrc),
        asr: decompressText(fileData.asr)
      }
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '根据路径获取文件失败', { error, filePath })
      throw error
    }
  }

  async updateFileMetadata(filePath: string, stats: fs.Stats): Promise<void> {
    this.db.transaction(() => {
      this.db
        .prepare(`UPDATE workspace_files SET modified_at = ? WHERE path = ?`)
        .run(stats.mtime.toISOString(), filePath)

      this.db
        .prepare(
          `
        UPDATE files SET modified_at = ?, size = ? 
        WHERE file_fingerprint = (SELECT file_fingerprint FROM workspace_files WHERE path = ?)
      `
        )
        .run(stats.mtime.toISOString(), stats.size, filePath)
    })()
  }

  async updateFileHitStatus(fileFingerprint: string, isHit: boolean): Promise<void> {
    try {
      this.db
        .prepare(
          `
        UPDATE files 
        SET is_hit = ?, last_hit_at = ?, modified_at = ? 
        WHERE file_fingerprint = ?
      `
        )
        .run(
          isHit ? 1 : 0,
          isHit ? new Date().toISOString() : null,
          new Date().toISOString(),
          fileFingerprint
        )
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '更新缓存命中状态失败', { error, fileFingerprint })
    }
  }

  async updateFileThumbnail(filePath: string, thumbnailPath: string | null): Promise<void> {
    this.db
      .prepare('UPDATE workspace_files SET thumbnail_path = ?, modified_at = ? WHERE path = ?')
      .run(thumbnailPath, new Date().toISOString(), filePath)
  }

  async resetFileAnalysis(filePath: string): Promise<void> {
    try {
      const fileRecord = this.db
        .prepare(
          `
        SELECT wf.id, wf.file_fingerprint, wf.path, wf.is_analyzed
        FROM workspace_files wf
        WHERE wf.path = ?
      `
        )
        .get(filePath) as
        | { id: number; file_fingerprint: string; path: string; is_analyzed: number }
        | undefined

      if (!fileRecord) {
        logger.warn(LogCategory.DATABASE_SERVICE, '重置文件分析状态失败：数据库中未找到匹配路径', {
          inputPath: filePath
        })
        return
      }

      const actualId = fileRecord.id
      const actualPath = fileRecord.path
      const fileFingerprint = fileRecord.file_fingerprint

      logger.debug(LogCategory.DATABASE_SERVICE, '找到匹配记录，准备清空数据', {
        actualPath,
        id: actualId,
        isAnalyzed: fileRecord.is_analyzed
      })

      this.db.transaction(() => {
        // 1. 重置 workspace_files 表
        const res1 = this.db
          .prepare(
            `
          UPDATE workspace_files
          SET is_analyzed = 0,
              last_analyzed_at = NULL,
              analysis_error = NULL
          WHERE id = ?
        `
          )
          .run(actualId)

        // 2. 清空 files 表中的分析数据 (创世 Baseline V1：files 表无 category 列，magika 类型识别由标签树承载)
        this.db
          .prepare(
            `
          UPDATE files
          SET smart_name = (SELECT name FROM workspace_files WHERE id = ?),
              smart_name_source = NULL,
              smart_name_template_source = NULL,
              description = NULL,
              author = NULL,
              language = NULL,
              is_hit = 0,
              last_hit_at = NULL
          WHERE file_fingerprint = ?
        `
          )
          .run(actualId, fileFingerprint)

        // 3. 清空 file_contents 表中的分析数据
        this.db
          .prepare(
            `
          UPDATE file_contents
          SET content = NULL,
              multimodal_content = NULL,
              lrc = NULL,
              asr = NULL,
              exif = NULL,
              analysis_stats = NULL,
              quality_score = NULL,
              quality_confidence = NULL,
              quality_criteria = NULL,
              quality_reasoning = NULL,
              grouping_reason = NULL,
              grouping_confidence = NULL
          WHERE file_fingerprint = ?
        `
          )
          .run(fileFingerprint)

        // 4. 清除文件的标签关联
        this.db
          .prepare(
            `
          DELETE FROM file_tag_relations
          WHERE file_fingerprint = ?
        `
          )
          .run(fileFingerprint)

        // 5. 从分析队列中移除该项目，确保下次添加时是全新状态
        const res4 = this.db
          .prepare(
            `
          DELETE FROM analysis_queue 
          WHERE item_id = ? AND item_type = 'file'
        `
          )
          .run(actualId)

        logger.debug(
          LogCategory.DATABASE_SERVICE,
          `事务内部操作完成: workspace_files更新=${res1.changes}, analysis_queue删除=${res4.changes}`
        )
      })()

      logger.debug(LogCategory.DATABASE_SERVICE, '文件分析数据已完全清空', { filePath: actualPath })
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '重置文件分析数据失败', { error, filePath })
      throw error
    }
  }

  async countAnalyzedFilesByWorkspace(workspaceId: number): Promise<number> {
    const result = this.db
      .prepare(
        'SELECT COUNT(*) as count FROM workspace_files WHERE workspace_id = ? AND is_analyzed = 1'
      )
      .get(workspaceId) as { count: number }
    return result.count
  }

  async getAnalyzedFilesByWorkspace(workspaceId: number, limit: number = 100): Promise<any[]> {
    const rows = this.db
      .prepare(
        `
      SELECT
        wf.id, wf.path, wf.name, f.smart_name, f.extension, f.description, fc.quality_score
      FROM workspace_files wf
      JOIN files f ON wf.file_fingerprint = f.file_fingerprint
      LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
      WHERE wf.workspace_id = ? AND wf.is_analyzed = 1
      LIMIT ?
    `
      )
      .all(workspaceId, limit) as any[]

    return rows.map(row => {
      // 以 tag_code 自然主键 LEFT JOIN file_tags_private 获取维度标签（创世 Baseline V1）。
      // 受控标签（builtin.* / omw.* / dim.xxx）不落 file_tags_private 表，其展示名与维度归属
      // 与属性面板同源：统一走 resolveDisplayName / dimensionForCode（主库语言分表直查）。
      let tags: any[] = []
      try {
        tags = this.db
          .prepare(
            `
          SELECT
            ftr.tag_code as id,
            ft.name as ft_name,
            ftr.via_parent_code
          FROM file_tag_relations ftr
          LEFT JOIN file_tags_private ft ON ft.code = ftr.tag_code
          WHERE ftr.file_fingerprint = (SELECT file_fingerprint FROM workspace_files WHERE id = ?)
        `
          )
          .all(row.id) as any[]
      } catch {
        tags = []
      }
      const dimensionTags = tags.map(t => ({
        tag: this.resolveDisplayName(t.id, t.ft_name),
        dimension: dimensionForCode(t.id, t.via_parent_code || '')
      }))

      return {
        id: String(row.id),
        path: row.path,
        name: row.name,
        smartName: row.smart_name,
        extension: row.extension,
        tags: dimensionTags.map(t => t.tag),
        description: row.description,
        qualityScore: row.quality_score,
        dimensionTags
      }
    })
  }

  /**
   * 获取指定目录下的所有文件记录
   * @param dirPath 目录路径
   * @param workspaceId 工作区 ID
   * @returns 文件记录列表
   */
  async getFilesByParentPath(dirPath: string, workspaceId: number): Promise<any[]> {
    // 1. 先查找目录 ID，且必须属于该工作区
    const dirRecord = this.db
      .prepare('SELECT id FROM workspace_directories WHERE path = ? AND workspace_id = ?')
      .get(dirPath, workspaceId) as { id: number } | undefined

    if (!dirRecord) {
      return []
    }

    // 2. 直接通过 directory_id 查询，利用 idx_workspace_files_dir_id 索引
    const rows = this.db
      .prepare(
        `
      SELECT
        wf.id,
        wf.path,
        wf.name,
        wf.is_analyzed,
        wf.status,
        wf.last_analyzed_at,
        wf.thumbnail_path,
        wf.modified_at,
        wf.accessed_at,
        f.smart_name,
        f.size,
        f.extension,
        f.file_group,
        f.description,
        f.is_hit,
        f.last_hit_at,
        fc.quality_score,
        fc.quality_confidence
      FROM workspace_files wf
      LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
      LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
      WHERE wf.directory_id = ? AND wf.workspace_id = ?
      ORDER BY wf.name ASC
    `
      )
      .all(dirRecord.id, workspaceId) as any[]

    return rows.map(row => {
      const normalizedExt = normalizeFileExtension(row.extension || row.path || '')
      return {
        id: row.id,
        status: row.status ?? 1,
        path: row.path,
        name: row.name,
        smartName: row.smart_name,
        size: row.size,
        extension: normalizedExt,
        fileGroup: row.file_group ?? undefined,
        isAnalyzed: row.is_analyzed === 1,
        lastAnalyzedAt: row.last_analyzed_at ? new Date(row.last_analyzed_at) : undefined,
        thumbnailPath: row.thumbnail_path,
        modifiedAt: new Date(row.modified_at),
        accessedAt: row.accessed_at ? new Date(row.accessed_at) : undefined,
        qualityScore: row.quality_score,
        qualityConfidence: row.quality_confidence,
        description: row.description,
        isHit: row.is_hit === 1,
        lastHitAt: row.last_hit_at ? new Date(row.last_hit_at) : undefined
      }
    })
  }

  /**
   * 将指定文件标记为「已分析完成」。
   *
   * 使用场景：分析管道在某个阶段提前结束（例如并行流水线运行中把分析模式切换为
   * simple，GPU 消费者不再执行 AI 阶段），但文件其实已满足当前模式的完成条件。
   * 此前这类路径只更新了分析队列状态，未落库 is_analyzed，
   * 导致「队列显示已完成、已分析页面却不统计该文件」的状态错位。
   *
   * 幂等：重复调用不会产生副作用。
   *
   * @param workspaceId 工作区 ID
   * @param filePath    文件的绝对路径
   * @returns 实际被更新的记录数（0 表示文件不存在或本就已标记）
   */
  async markFileAnalyzed(workspaceId: number, filePath: string): Promise<number> {
    try {
      const result = this.db
        .prepare(
          `
          UPDATE workspace_files
          SET is_analyzed = 1,
              last_analyzed_at = COALESCE(last_analyzed_at, ?)
          WHERE workspace_id = ? AND path = ? AND (is_analyzed IS NULL OR is_analyzed = 0)
        `
        )
        .run(new Date().toISOString(), workspaceId, filePath)

      if (result.changes > 0) {
        logger.debug(
          LogCategory.ANALYSIS_QUEUE,
          `[FileDao] 补齐已分析标记: ${filePath}（受影响 ${result.changes} 行）`
        )
      }
      return result.changes
    } catch (error) {
      logger.error(LogCategory.ANALYSIS_QUEUE, `[FileDao] 补齐已分析标记失败: ${filePath}`, error)
      return 0
    }
  }

  async updateAnalysisStage(fileFingerprint: string, stage: number): Promise<void> {
    try {
      this.db.transaction(() => {
        const row = this.db
          .prepare('SELECT analysis_stats FROM file_contents WHERE file_fingerprint = ?')
          .get(fileFingerprint) as { analysis_stats?: string } | undefined

        let stats: any = {}
        if (row?.analysis_stats) {
          try {
            stats = JSON.parse(row.analysis_stats) || {}
          } catch (e) {
            stats = {}
          }
        }
        stats.analysis_stage = stage

        if (row !== undefined) {
          this.db
            .prepare('UPDATE file_contents SET analysis_stats = ? WHERE file_fingerprint = ?')
            .run(JSON.stringify(stats), fileFingerprint)
        } else {
          this.db
            .prepare('INSERT INTO file_contents (file_fingerprint, analysis_stats) VALUES (?, ?)')
            .run(fileFingerprint, JSON.stringify(stats))
        }
      })()
      logger.debug(
        LogCategory.DATABASE_SERVICE,
        `已更新 file_contents.analysis_stats.analysis_stage 为 ${stage}: ${fileFingerprint}`
      )
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '更新 analysis_stage 失败', {
        error,
        fileFingerprint,
        stage
      })
    }
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
    try {
      this.db.transaction(() => {
        const row = this.db
          .prepare('SELECT analysis_stats FROM file_contents WHERE file_fingerprint = ?')
          .get(fileFingerprint) as { analysis_stats?: string } | undefined

        let stats: any = {}
        if (row?.analysis_stats) {
          try {
            stats = JSON.parse(row.analysis_stats) || {}
          } catch (e) {
            stats = {}
          }
        }
        stats.analysis_stage = stage

        if (row !== undefined) {
          const setClauses: string[] = []
          const bindParams: any[] = []

          if (qualityData?.qualityScore !== undefined && qualityData?.qualityScore !== null) {
            setClauses.push('quality_score = ?')
            bindParams.push(qualityData.qualityScore)
          }
          if (
            qualityData?.qualityConfidence !== undefined &&
            qualityData?.qualityConfidence !== null
          ) {
            setClauses.push('quality_confidence = ?')
            bindParams.push(qualityData.qualityConfidence)
          }
          if (
            qualityData?.qualityReasoning !== undefined &&
            qualityData?.qualityReasoning !== null
          ) {
            setClauses.push('quality_reasoning = ?')
            bindParams.push(qualityData.qualityReasoning)
          }
          if (qualityData?.qualityCriteria !== undefined && qualityData?.qualityCriteria !== null) {
            setClauses.push('quality_criteria = ?')
            bindParams.push(JSON.stringify(qualityData.qualityCriteria))
          }
          setClauses.push('analysis_stats = ?')
          bindParams.push(JSON.stringify(stats))

          bindParams.push(fileFingerprint)

          this.db
            .prepare(`UPDATE file_contents SET ${setClauses.join(', ')} WHERE file_fingerprint = ?`)
            .run(...bindParams)
        } else {
          this.db
            .prepare(
              `
              INSERT INTO file_contents (
                file_fingerprint, quality_score, quality_confidence, quality_reasoning, quality_criteria, analysis_stats
              ) VALUES (?, ?, ?, ?, ?, ?)
            `
            )
            .run(
              fileFingerprint,
              qualityData?.qualityScore ?? null,
              qualityData?.qualityConfidence ?? null,
              qualityData?.qualityReasoning ?? null,
              qualityData?.qualityCriteria ? JSON.stringify(qualityData.qualityCriteria) : null,
              JSON.stringify(stats)
            )
        }
      })()
      logger.debug(
        LogCategory.DATABASE_SERVICE,
        `已更新 file_contents.analysis_stats.analysis_stage 为 ${stage}: ${fileFingerprint}`
      )
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '更新 analysis_stage 失败', {
        error,
        fileFingerprint,
        stage
      })
    }
  }
}
