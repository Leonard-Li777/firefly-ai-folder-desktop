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
import { buildPinyinIndexRow, computePinyinSrcHash } from '../../../utils/pinyin-text'

import { FileCrudMixin } from './file-crud'
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
export class FileQueryMixin extends FileCrudMixin {
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

  /**
   * 聚合某文件指纹的标签展示名文本（files_fts.tags 列与 files_pinyin_fts.tags_py 列共用）。
   * 受控标签展示名经主库语言分表 resolveDisplayName 解析（SQL 层无法访问该动态分表），故在 JS 侧聚合。
   */
  private collectTagsText(fingerprint: string): string {
    try {
      const relationRows = this.db
        .prepare(
          `
          SELECT ftr.tag_code as id, ft.name as ft_name
          FROM file_tag_relations ftr
          LEFT JOIN file_tags_private ft ON ft.code = ftr.tag_code
          WHERE ftr.file_fingerprint = ?
        `
        )
        .all(fingerprint) as Array<{ id: string; ft_name: string | null }>
      return relationRows.map(r => this.resolveDisplayName(r.id, r.ft_name)).join(' ')
    } catch {
      return ''
    }
  }

  /**
   * 批量版 collectTagsText（人工裁定项①：reconciler 逐行 2 次 SQL → 一次窗口一次 SQL）。
   *
   * 与逐行版同口径：受控标签展示名在主库语言分表 resolveDisplayName 解析（SQL 层无法访问
   * 该动态分表），故只把 `(file_fingerprint, tag_code, file_tags_private.name)` 原始对
   * 一次性预取，JS 侧按指纹分组后解析展示名。每个指纹的标签顺序与逐行版一致
   * （同一 rowid 扫描序），故 src_hash 与逐行写入逐位相同。
   *
   * 返回 **null 表示批量失败**：调用方必须回退逐行 collectTagsText。若把失败当空串使用，
   * 标签会从拼音列静默消失、src_hash 恒不命中 ⇒ reconciler 每窗口重写全表（正确性事故）。
   */
  private collectTagsTextBatch(fingerprints: string[]): Map<string, string> | null {
    if (fingerprints.length === 0) return new Map()
    // 分片防 SQLite 变量数上限（旧构建默认 999；现代构建 32766）
    const CHUNK = 400
    const grouped = new Map<string, string[]>()
    try {
      for (let i = 0; i < fingerprints.length; i += CHUNK) {
        const chunk = fingerprints.slice(i, i + CHUNK)
        const placeholders = chunk.map(() => '?').join(',')
        const rows = this.db
          .prepare(
            `
            SELECT ftr.file_fingerprint AS fp, ftr.tag_code AS id, ft.name AS ft_name
            FROM file_tag_relations ftr
            LEFT JOIN file_tags_private ft ON ft.code = ftr.tag_code
            WHERE ftr.file_fingerprint IN (${placeholders})
          `
          )
          .all(...chunk) as Array<{ fp: string; id: string; ft_name: string | null }>
        for (const r of rows) {
          const display = this.resolveDisplayName(r.id, r.ft_name)
          const arr = grouped.get(r.fp)
          if (arr) arr.push(display)
          else grouped.set(r.fp, [display])
        }
      }
      const out = new Map<string, string>()
      for (const [fp, arr] of grouped) out.set(fp, arr.join(' '))
      return out
    } catch {
      return null
    }
  }

  /**
   * 收集拼音索引四源字段（name/smart_name/description/tagsText）。
   *
   * **写入侧与查询侧校验回填共用同一实现**（设计文档 §5.3）：索引里存的是这四个字段的拼音，
   * 回填校验必须用同一口径重建原文，否则会出现「召回得到、校验失败」的静默不一致。
   * 文件不存在时返回 null。
   */
  getPinyinSourceFields(fingerprint: string): {
    name: string
    smartName: string
    description: string
    tagsText: string
  } | null {
    if (!fingerprint) return null
    try {
      const row = this.db
        .prepare(
          `
          SELECT
            COALESCE((SELECT wf.name FROM workspace_files wf WHERE wf.file_fingerprint = f.file_fingerprint LIMIT 1), '') AS name,
            COALESCE(f.smart_name, '') AS smart_name,
            COALESCE(f.description, '') AS description
          FROM files f
          WHERE f.file_fingerprint = ?
        `
        )
        .get(fingerprint) as { name: string; smart_name: string; description: string } | undefined
      if (!row) return null
      return {
        name: row.name,
        smartName: row.smart_name,
        description: row.description,
        tagsText: this.collectTagsText(fingerprint)
      }
    } catch {
      return null
    }
  }

  /**
   * 写入/刷新一行拼音正排索引（files_pinyin_fts，设计文档 §4.3）。
   * 与 files_fts 同源四字段（name/smart_name/description/tags），由调用方保证同事务。
   *
   * **rowid 对齐**（R1 盲审 A-H1）：拼音行 rowid = files.rowid（与 files_fts 完全同构），
   * 寻址/删除走 rowid（O(log n)）；早期按 file_fingerprint（UNINDEXED 列）寻址对 FTS5
   * 是全表扫描，批量写入 N 个文件累计 O(N²)，万级库上写入热路径不可用。
   * 单语句 `INSERT OR REPLACE`（FTS5 支持显式 rowid 的冲突替换，实测验证）替代 DELETE+INSERT。
   * 四列均无中文时删除既有拼音行（防陈旧残留，如文件改名为纯 ASCII）。
   */
  private writePinyinIndexRow(
    fingerprint: string,
    rid: number,
    fields: { name: string; smartName: string; description: string; tagsText: string }
  ): void {
    const row = buildPinyinIndexRow({
      name: fields.name,
      smartName: fields.smartName,
      description: fields.description,
      tags: fields.tagsText
    })
    if (!row) {
      this.db.prepare(`DELETE FROM files_pinyin_fts WHERE rowid = ?`).run(rid)
      return
    }
    this.db
      .prepare(
        `INSERT OR REPLACE INTO files_pinyin_fts(rowid, file_fingerprint, name_py, smart_name_py, description_py, tags_py, src_hash)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        rid,
        fingerprint,
        row.namePy,
        row.smartNamePy,
        row.descriptionPy,
        row.tagsPy,
        row.srcHash
      )
  }

  syncFTSTags(fingerprint: string): void {
    if (!fingerprint) return
    try {
      // Issue #661 contentless：不能 UPDATE FTS 列，需按业务表重建倒排（含 tags）
      const row = this.db
        .prepare(
          `
          SELECT f.rowid AS rid, f.file_fingerprint,
            COALESCE((SELECT wf.name FROM workspace_files wf WHERE wf.file_fingerprint = f.file_fingerprint LIMIT 1), '') AS name,
            COALESCE(f.smart_name, '') AS smart_name,
            COALESCE(f.description, '') AS description,
            COALESCE(decompress_text(fc.content), '') AS content,
            COALESCE(decompress_text(fc.multimodal_content), '') AS multimodal_content,
            COALESCE(decompress_text(fc.ocr), '') AS ocr,
            COALESCE(decompress_text(fc.lrc), '') AS lrc,
            COALESCE(decompress_text(fc.asr), '') AS asr
          FROM files f
          LEFT JOIN file_contents fc ON fc.file_fingerprint = f.file_fingerprint
          WHERE f.file_fingerprint = ?
        `
        )
        .get(fingerprint) as any
      if (!row) return

      // FTS 倒排的 tags 列：受控标签展示名经主库语言分表 resolveDisplayName 解析（SQL 层无法访问该动态分表），
      // 故在 JS 侧聚合：LEFT JOIN file_tags_private 取本地名，缺失时走 resolveDisplayName（语言分表 lemma → 可读 slug），
      // 保证"设计稿/如云西点"等感知标签展示名可被全文搜索命中。
      const tagsText = this.collectTagsText(fingerprint)

      this.db.transaction(() => {
        this.db.prepare(`DELETE FROM files_fts WHERE rowid = ?`).run(row.rid)
        this.db
          .prepare(
            `INSERT INTO files_fts(rowid, file_fingerprint, name, smart_name, description, content, multimodal_content, ocr, lrc, asr, tags)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
          )
          .run(
            row.rid,
            row.file_fingerprint,
            row.name,
            row.smart_name,
            row.description,
            row.content,
            row.multimodal_content,
            row.ocr,
            row.lrc,
            row.asr,
            tagsText
          )
        // 拼音正排索引 write-through（设计文档 §4.3）：与 files_fts 同事务，两端字段严格同源；
        // rowid 与 files.rowid 对齐（A-H1），寻址/删除 O(log n)
        this.writePinyinIndexRow(fingerprint, row.rid, {
          name: row.name,
          smartName: row.smart_name,
          description: row.description,
          tagsText
        })
      })()
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '同步FTS标签失败', { error, fingerprint })
    }
  }

  syncFTSTagsBatch(fingerprints: string[]): void {
    if (!fingerprints || fingerprints.length === 0) return
    const uniqueFingerprints = Array.from(new Set(fingerprints.filter(Boolean)))
    if (uniqueFingerprints.length === 0) return

    try {
      this.db.transaction(() => {
        for (const fp of uniqueFingerprints) {
          this.syncFTSTags(fp)
        }
      })()
      logger.debug(
        LogCategory.DATABASE_SERVICE,
        `[FileDao] 批量同步 FTS 标签完成，共 ${uniqueFingerprints.length} 项`
      )
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '批量同步FTS标签失败', error)
    }
  }

  /** 拼音索引当前行数（启动回填判定用：行数 < files 行数即存在缺口） */
  countPinyinIndexRows(): number {
    try {
      const r = this.db.prepare(`SELECT COUNT(*) AS n FROM files_pinyin_fts`).get() as
        | { n: number }
        | undefined
      return r?.n ?? 0
    } catch {
      return 0
    }
  }

  /**
   * 拼音索引 reconciler（设计文档 §4.3）：按 rowid 窗口扫描 files，
   * 对拼音行缺失或 src_hash 陈旧的指纹重算写入；hash 命中跳过（不重算拼音，热路径近零成本）。
   * 覆盖不走 syncFTSTags 的变更路径（如触发器维护的 smart_name/description 更新）。
   * 窗口游标内存推进、越界绕回表头；每次调用处理最多 limit 个文件。返回实际刷新行数。
   */
  syncPinyinIndexDirty(limit = 300): number {
    if (limit <= 0) return 0
    let rewritten = 0
    try {
      this.db.transaction(() => {
        const rows = this.db
          .prepare(
            `
            SELECT f.rowid AS rid, f.file_fingerprint,
              COALESCE((SELECT wf.name FROM workspace_files wf WHERE wf.file_fingerprint = f.file_fingerprint LIMIT 1), '') AS name,
              COALESCE(f.smart_name, '') AS smart_name,
              COALESCE(f.description, '') AS description
            FROM files f
            WHERE f.rowid > ?
            ORDER BY f.rowid
            LIMIT ?
          `
          )
          .all(this.pinyinScanCursor, limit) as Array<{
          rid: number
          file_fingerprint: string
          name: string
          smart_name: string
          description: string
        }>
        if (rows.length === 0) {
          // 越界：绕回表头（覆盖窗口推进期间新插入的文件）
          this.pinyinScanCursor = 0
          return
        }
        this.pinyinScanCursor = rows[rows.length - 1].rid

        const hashStmt = this.db.prepare(`SELECT src_hash FROM files_pinyin_fts WHERE rowid = ?`)
        // 人工裁定项①：标签文本一次窗口一次 SQL 批量预取；批量失败回退逐行（绝不静默按空串处理）
        const tagsBatch = this.collectTagsTextBatch(rows.map(r => r.file_fingerprint))
        for (const r of rows) {
          const tagsText = tagsBatch
            ? (tagsBatch.get(r.file_fingerprint) ?? '')
            : this.collectTagsText(r.file_fingerprint)
          const hash = computePinyinSrcHash({
            name: r.name,
            smartName: r.smart_name,
            description: r.description,
            tags: tagsText
          })
          const existing = hashStmt.get(r.rid) as { src_hash: string } | undefined
          if (existing && existing.src_hash === hash) continue // 陈旧检测未命中：跳过
          const row = buildPinyinIndexRow({
            name: r.name,
            smartName: r.smart_name,
            description: r.description,
            tags: tagsText
          })
          if (!row && !existing) continue // 无中文且无既有行：无需操作
          this.writePinyinIndexRow(r.file_fingerprint, r.rid, {
            name: r.name,
            smartName: r.smart_name,
            description: r.description,
            tagsText
          })
          rewritten++
        }
      })()
      if (rewritten > 0) {
        logger.debug(
          LogCategory.DATABASE_SERVICE,
          `[FileDao] 拼音索引 reconciler 刷新 ${rewritten} 行`
        )
      }
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '拼音索引 reconciler 失败', error)
      return -1 // 失败信号：调用方（启动回填）据此提前退出，防 busy_timeout 逐次击穿预算
    }
    return rewritten
  }

  /**
   * 启动回填：循环推进窗口直到绕回表头（一圈完成）或超出时间预算。
   * 返回刷新行数；供数据库初始化完成后调用（应用未上线，无迁移兼容负担）。
   *
   * 行数缺口闸（设计文档 §4.4）：拼音行数 >= files 行数即无缺口直接跳过；
   * 无中文文件会造成恒定小缺口，此时 hash 闸以近零成本逐行跳过（rowid 寻址，A-H1）。
   */
  syncPinyinIndexBackfill(timeBudgetMs = 10_000): number {
    const start = Date.now()
    let total = 0
    try {
      const filesCount =
        (this.db.prepare(`SELECT COUNT(*) AS n FROM files`).get() as { n: number } | undefined)
          ?.n ?? 0
      if (this.countPinyinIndexRows() >= filesCount) return 0

      let consecutiveFailures = 0
      while (Date.now() - start < timeBudgetMs) {
        const n = this.syncPinyinIndexDirty(500)
        if (n < 0) {
          if (++consecutiveFailures >= 2) break
          continue
        }
        consecutiveFailures = 0
        total += n
        // cursor 绕回 0 = 完整一圈扫描完成（含越界重置与空库直返）
        if (this.pinyinScanCursor === 0) break
      }
      if (total > 0) {
        logger.debug(LogCategory.DATABASE_SERVICE, `[FileDao] 拼音索引启动回填完成：${total} 行`)
      }
      if (this.pinyinScanCursor !== 0) {
        logger.warn(
          LogCategory.DATABASE_SERVICE,
          '拼音索引启动回填未完成（预算耗尽或连续失败），余量交由进程内 reconciler 续扫',
          { elapsedMs: Date.now() - start, cursor: this.pinyinScanCursor }
        )
      }
      // trigram 表 DELETE 不回收段结构：**确有写入或未完成时**才 optimize——
      // healthy 库（缺口闸直接跳过）不必在启动路径付全表段合并成本（R2 盲审 M1）
      if (total > 0 || this.pinyinScanCursor !== 0) this.optimizePinyinIndex()
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '拼音索引启动回填失败', error)
    }
    return total
  }

  /**
   * FTS5 optimize：合并段结构。trigram 表 DELETE 后不回收段，长期增删会膨胀，
   * 启动回填后执行一次（R1 盲审超纲建议，低挂果实：一行 SQL）。
   */
  optimizePinyinIndex(): void {
    try {
      this.db.prepare(`INSERT INTO files_pinyin_fts(files_pinyin_fts) VALUES('optimize')`).run()
    } catch (error) {
      logger.warn(LogCategory.DATABASE_SERVICE, '拼音索引 optimize 失败（不影响功能）', { error })
    }
  }

  /**
   * 批量写入视频时序切片记录（原子替换，防重分析切片缩容残留孤立脏数据）
   */
}
