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

import { FileDaoSharedBase } from './shared'
import { readableCode, dimensionForCode } from './shared'

/**
 * FileDao 基础 CRUD mixin（Ticket 10 · 大文件模块化拆分）。
 *
 * 承载文件基础 CRUD / 分析结果读写：getFileAnalysisResult、getDirectoryAnalysisResult、
 * updateFilePath、resolveUniqueSmartName、updateFileAnalysisResult。
 *
 * 全部代码自 `file-dao.ts` 原样搬移，未改动任何逻辑、命名或注释措辞。
 */
export class FileCrudMixin extends FileDaoSharedBase {
  async getFileAnalysisResult(idOrPath: string | number): Promise<any> {
    // 入参非空守卫：空 ID/路径（如渲染进程在路径就绪前发起查询）直接返回 null，
    // 避免触发无效数据库查询与 "未找到文件分析结果" 告警
    if (idOrPath === undefined || idOrPath === null || idOrPath === '') {
      logger.debug(LogCategory.DATABASE_SERVICE, '文件分析结果查询入参为空，直接返回 null')
      return null
    }

    // 优先通过原生路径或 ID 查询
    const isId = typeof idOrPath === 'number' || /^\d+$/.test(String(idOrPath))
    let workspaceFile: any = null

    if (isId) {
      workspaceFile = this.db
        .prepare(
          `
        SELECT
          wf.id, wf.file_fingerprint, wf.path, wf.name, wf.is_analyzed, wf.last_analyzed_at, wf.thumbnail_path,
          wf.created_at, wf.modified_at, wf.accessed_at
        FROM workspace_files wf
        WHERE wf.id = ?`
        )
        .get(Number(idOrPath)) as any
    } else {
      const p = String(idOrPath)
      const pSlash = p.replace(/\\/g, '/')
      const pBackslash = p.replace(/\//g, '\\')
      workspaceFile = this.db
        .prepare(
          `
        SELECT
          wf.id, wf.file_fingerprint, wf.path, wf.name, wf.is_analyzed, wf.last_analyzed_at, wf.thumbnail_path,
          wf.created_at, wf.modified_at, wf.accessed_at
        FROM workspace_files wf
        WHERE wf.path = ? OR wf.path = ?`
        )
        .get(pSlash, pBackslash) as any
    }

    if (!workspaceFile) {
      logger.warn(LogCategory.DATABASE_SERVICE, '未找到文件分析结果', { idOrPath })
      return null
    }

    AccessTimeBatchUpdater.getInstance().queueUpdate(workspaceFile.id, new Date().toISOString())

    let fileData: any = {}
    let fingerprint = workspaceFile.file_fingerprint

    // 指纹自愈补齐：若物理记录存在但缺少 file_fingerprint，自动根据物理文件计算真实内容哈希并关联
    if (!fingerprint && workspaceFile.path && fs.existsSync(workspaceFile.path)) {
      try {
        const { calculateFileFingerprint } = await import('@firefly/shared')
        fingerprint = await calculateFileFingerprint(workspaceFile.path)
        if (fingerprint) {
          const stats = fs.statSync(workspaceFile.path)
          const ext = normalizeFileExtension(workspaceFile.path)
          // 先确保父表 files 与 file_contents 记录存在，防止触发 SQLite 外键约束异常
          this.db
            .prepare(
              `INSERT OR IGNORE INTO files (file_fingerprint, smart_name, size, extension, created_at, modified_at, accessed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              fingerprint,
              workspaceFile.name,
              stats.size,
              ext,
              stats.birthtime.toISOString(),
              stats.mtime.toISOString(),
              stats.atime.toISOString()
            )
          this.db
            .prepare(`INSERT OR IGNORE INTO file_contents (file_fingerprint) VALUES (?)`)
            .run(fingerprint)

          this.db
            .prepare('UPDATE workspace_files SET file_fingerprint = ? WHERE id = ?')
            .run(fingerprint, workspaceFile.id)
        }
      } catch (e) {
        logger.warn(LogCategory.DATABASE_SERVICE, '自愈计算文件指纹失败:', e)
      }
    }

    if (fingerprint && !fingerprint.startsWith('temp_')) {
      const fileStmt = this.db.prepare(`
        SELECT
          f.smart_name, f.raw_smart_name, f.size, f.extension, f.file_group, f.author, f.language,
          f.is_hit, f.last_hit_at, f.description,
          fc.content, fc.multimodal_content, fc.ocr, fc.lrc, fc.asr, fc.quality_score, fc.quality_confidence, 
          fc.quality_reasoning, fc.quality_criteria, fc.grouping_reason, fc.grouping_confidence,
          fc.exif, fc.analysis_stats
        FROM files f
        LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
        WHERE f.file_fingerprint = ?`)
      const fData = fileStmt.get(fingerprint) as any
      if (fData) {
        fileData = fData
      }
    }

    // 创世 Baseline V1：以 code 自然主键 LEFT JOIN file_tags_private，彻底移除自增 id / dimension_id / tag_id 兼容分支。
    // 维度归属由单次标注关系经由的 via_parent_code 决定，无维度则为空（真根），严禁回退 parent_codes 首父。
    // 受控标签（builtin.* / omw.* / dim.xxx）不落 file_tags_private 表（file_tags_private.source CHECK 仅 expanded/user），
    // 其展示名与维度归属经主库语言分表 tag_aliases 直查解析（原 TaxonomyAliasCache 内存总线已按主设计废除），故不可使用内连接过滤。
    let tags: any[] = []
    if (fingerprint) {
      try {
        tags = this.db
          .prepare(
            `
          SELECT
            ftr.tag_code as id,
            ft.name as ft_name,
            ftr.via_parent_code,
            ftr.tag_group,
            ftr.confidence
          FROM file_tag_relations ftr
          LEFT JOIN file_tags_private ft ON ft.code = ftr.tag_code
          WHERE ftr.file_fingerprint = ?
        `
          )
          .all(fingerprint) as any[]
      } catch {
        tags = []
      }
    }

    // 受控标签展示名解析与维度归属统一走工具函数（resolveDisplayName / dimensionForCode），
    // 与 getAnalyzedFilesByWorkspace、syncFTSTags 保持同一套解析语义
    const dimensionTags: { [dimensionId: string]: any[] } = {}
    tags.forEach(tag => {
      const dimId = dimensionForCode(tag.id, tag.via_parent_code || '')
      if (!dimensionTags[dimId]) dimensionTags[dimId] = []
      dimensionTags[dimId].push({
        id: tag.id,
        name: this.resolveDisplayName(tag.id, tag.ft_name)
      })
    })

    // 创世 Baseline V1 起，维度层级不再来自 file_dimensions 表（已废弃）。
    // 此处读取全部标签树节点用于对命中维度进行稳定排序。
    if (!this.dimensionsCache) {
      try {
        this.dimensionsCache = this.db
          .prepare(
            `SELECT code AS id, description
             FROM file_tags_private
             ORDER BY code ASC`
          )
          .all() as any[]
      } catch {
        // 标签树表缺失时安全降级为空集合，仅影响排序，不影响标签返回
        this.dimensionsCache = []
      }
    }
    const dimensions = this.dimensionsCache
    const sortedDimensionTags: Array<{ dimension: string; level: number; tags: any[] }> = []

    // 维度根节点按稳定顺序优先输出
    dimensions.forEach(dim => {
      if (dimensionTags[dim.id]) {
        sortedDimensionTags.push({
          dimension: dim.id,
          level: 1,
          tags: dimensionTags[dim.id]
        })
        delete dimensionTags[dim.id]
      }
    })

    // 未在标签树中登记归拢的剩余标签（如动态扩展标签）统一以 level=3 兜底输出
    Object.entries(dimensionTags).forEach(([dimId, remainingTags]) => {
      sortedDimensionTags.push({ dimension: dimId, level: 3, tags: remainingTags as any[] })
    })

    // ADR-0045：平行新增「标签来源分组」视图，**不改动** dimensionTags 的既有维度语义
    // （FileDetailsPanel 依赖 dimension === 1/2 生成虚拟路径，ai-skill-api-service 将其作为对外契约透传）。
    // 跨组与组内双重去重（以物理事实绝对覆盖律保证：user > fact > fused > visual > ai）
    // 保证同一名称或同一 code 在全局视图中唯一呈现，且事实标签绝对优先于视觉/融合/AI标签
    const groupTagRawMap = new Map<
      string,
      Array<{ id: string; name: string; confidence: number }>
    >()
    for (const tag of tags) {
      const group = typeof tag.tag_group === 'string' ? tag.tag_group : ''
      if (!isTagProvenanceGroup(group)) {
        if (group) {
          logger.debug(LogCategory.DATABASE_SERVICE, `标签来源分组非法，已跳过分组视图: ${group}`)
        }
        continue
      }
      if (!groupTagRawMap.has(group)) groupTagRawMap.set(group, [])
      groupTagRawMap.get(group)!.push({
        id: tag.id,
        name: this.resolveDisplayName(tag.id, tag.ft_name),
        confidence: typeof tag.confidence === 'number' ? tag.confidence : 1.0
      })
    }

    const SEEN_PRIORITY_ORDER: TagProvenanceGroup[] = ['user', 'fact', 'fused', 'visual', 'ai']
    const seenGlobalTagNames = new Set<string>()
    const seenGlobalTagCodes = new Set<string>()
    const deduplicatedGroupTagMap = new Map<
      string,
      Array<{ id: string; name: string; confidence: number }>
    >()

    for (const group of SEEN_PRIORITY_ORDER) {
      const rawTags = groupTagRawMap.get(group) || []
      const sorted = [...rawTags].sort((a, b) => b.confidence - a.confidence)
      const deduped: Array<{ id: string; name: string; confidence: number }> = []

      for (const t of sorted) {
        const normName = t.name.trim().toLowerCase()
        if (!normName) continue
        if (seenGlobalTagNames.has(normName) || seenGlobalTagCodes.has(String(t.id))) {
          continue
        }
        seenGlobalTagNames.add(normName)
        seenGlobalTagCodes.add(String(t.id))
        deduped.push(t)
      }

      if (deduped.length > 0) {
        deduplicatedGroupTagMap.set(group, deduped)
      }
    }

    const tagGroups = TAG_PROVENANCE_GROUPS.filter(
      group => (deduplicatedGroupTagMap.get(group)?.length ?? 0) > 0
    ).map(group => ({
      group,
      // 只聚合不排序：组顺序（按组平均置信度降序）与组内顺序均属展示规则，由属性面板决定
      tags: deduplicatedGroupTagMap.get(group) || []
    }))

    const parsedFileGroup = fileData.file_group
      ? (() => {
          try {
            return typeof fileData.file_group === 'string' &&
              (fileData.file_group.startsWith('{') || fileData.file_group.startsWith('['))
              ? JSON.parse(fileData.file_group)
              : fileData.file_group
          } catch {
            return fileData.file_group
          }
        })()
      : null
    const parsedStats = (() => {
      if (!fileData.analysis_stats) return undefined
      try {
        const stats = JSON.parse(fileData.analysis_stats)
        if (stats && typeof stats === 'object') {
          if (stats.analysis_stage === undefined) {
            stats.analysis_stage = 0
          }
          return stats
        }
      } catch (e) {
        logger.warn(LogCategory.DATABASE_SERVICE, '解析 analysis_stats 失败:', e)
      }
      return undefined
    })()

    return {
      id: workspaceFile.id,
      path: workspaceFile.path,
      name: workspaceFile.name,
      fileFingerprint: fingerprint,
      smartName: fileData.smart_name,
      rawSmartName: fileData.raw_smart_name ?? undefined,
      size: fileData.size,
      extension: fileData.extension,
      fileGroup:
        typeof parsedFileGroup === 'object' && parsedFileGroup
          ? parsedFileGroup.group
          : parsedFileGroup,
      mimeType: parsedFileGroup?.mime_type ?? 'application/octet-stream',
      createdAt: workspaceFile.created_at,
      modifiedAt: workspaceFile.modified_at,
      accessedAt: workspaceFile.accessed_at,
      description: fileData.description,
      content: decompressText(fileData.content),
      multimodalContent: decompressText(fileData.multimodal_content),
      ocr: decompressText(fileData.ocr),
      lrc: decompressText(fileData.lrc),
      asr: decompressText(fileData.asr),
      qualityScore: fileData.quality_score,
      qualityConfidence: fileData.quality_confidence,
      qualityReasoning: fileData.quality_reasoning,
      qualityCriteria: fileData.quality_criteria
        ? JSON.parse(fileData.quality_criteria)
        : undefined,
      author: fileData.author,
      isAnalyzed: Boolean(workspaceFile.is_analyzed),
      lastAnalyzedAt: workspaceFile.last_analyzed_at,
      isHit: Boolean(fileData.is_hit),
      lastHitAt: fileData.last_hit_at ? new Date(fileData.last_hit_at) : undefined,
      analysisStats: parsedStats,
      dimensionTags: sortedDimensionTags,
      tagGroups,
      groupingReason: fileData.grouping_reason,
      groupingConfidence: fileData.grouping_confidence,
      thumbnailPath: workspaceFile.thumbnail_path,
      metadata: decompressJson(fileData.exif)
    }
  }

  async getDirectoryAnalysisResult(dirPath: string): Promise<any> {
    const dir = this.db
      .prepare(
        `
      SELECT
        id, workspace_id, path, name, context_analysis, is_analyzed, last_analyzed_at, created_at, modified_at
      FROM workspace_directories
      WHERE path = ?
    `
      )
      .get(dirPath) as any

    if (!dir) {
      logger.warn(LogCategory.DATABASE_SERVICE, `目录分析结果未找到: ${dirPath}`)
      return null
    }

    const countResult = this.db
      .prepare('SELECT COUNT(*) as count FROM workspace_files WHERE directory_id = ?')
      .get(dir.id) as { count: number }
    const analyzedCountResult = this.db
      .prepare(
        'SELECT COUNT(*) as count FROM workspace_files WHERE directory_id = ? AND is_analyzed = 1'
      )
      .get(dir.id) as { count: number }

    let parsedContext = dir.context_analysis ? JSON.parse(dir.context_analysis) : null
    try {
      const { directoryContextService } = await import('../../../../main/state')
      if (directoryContextService) {
        const effective = await directoryContextService.getEffectiveDirectoryConfig(dirPath)
        if (effective) {
          parsedContext = effective
        }
      }
    } catch (err) {
      logger.warn(LogCategory.DATABASE_SERVICE, `解析有效目录画像失败: ${dirPath}`, err)
    }

    const result = {
      id: dir.id,
      path: dir.path,
      name: dir.name,
      contextAnalysis: parsedContext,
      isAnalyzed: dir.is_analyzed === 1,
      lastAnalyzedAt: dir.last_analyzed_at,
      createdAt: dir.created_at,
      updatedAt: dir.modified_at,
      fileCount: countResult.count,
      analyzedFileCount: analyzedCountResult.count
    }

    logger.debug(
      LogCategory.DATABASE_SERVICE,
      `目录分析结果已加载: ${dirPath}, contextAnalysis: ${result.contextAnalysis ? '存在' : 'null'}, isAnalyzed: ${result.isAnalyzed}`
    )

    return result
  }

  /**
   * 处理物理文件移动后的数据库更新
   * 保持内容指纹关联，仅迁移路径实体
   */
  async updateFilePath(oldPath: string, newPath: string): Promise<void> {
    const newDir = path.dirname(newPath)

    // 查找原记录
    const wf = this.db.prepare('SELECT * FROM workspace_files WHERE path = ?').get(oldPath) as any
    if (!wf) {
      logger.warn(LogCategory.DATABASE_SERVICE, '移动文件失败：原路径记录不存在', { oldPath })
      return
    }

    // 确保新目录记录存在
    let newDirId = this.db
      .prepare('SELECT id FROM workspace_directories WHERE path = ?')
      .get(newDir) as any
    if (!newDirId) {
      // 需要在 Service 层创建目录记录，这里只记录警告
      logger.warn(LogCategory.DATABASE_SERVICE, '新路径所属目录记录不存在', { newDir })
      return
    }
    newDirId = newDirId.id

    this.db.transaction(() => {
      // 使用 UPDATE 直接修改路径，保留原记录的主键 ID 及其所有的外键依赖关系
      this.db
        .prepare(
          `
        UPDATE workspace_files 
        SET path = ?, name = ?, directory_id = ?, modified_at = ?
        WHERE path = ?
      `
        )
        .run(newPath, path.basename(newPath), newDirId, new Date().toISOString(), oldPath)
    })()
  }

  /**
   * 在指定工作区内为智能文件名解析唯一名称：
   * 查询同工作区其它文件是否已占用该 smart_name（忽略大小写），
   * 若已被占用，则在扩展名之前自动追加 " (1)"、" (2)" 等编号后缀
   * @param smartName 期望的智能文件名
   * @param excludeFingerprint 需要排除的当前文件指纹（自身不参与冲突判定）
   * @param workspaceId 工作区 ID
   */
  resolveUniqueSmartName(
    smartName: string,
    excludeFingerprint: string,
    workspaceId: number
  ): string {
    const cleaned = cleanSmartName(smartName || '')
    const trimmed = cleaned.trim()
    if (!trimmed) return smartName

    // 提取扩展名与基准名（若已携带 " (n)" 尾缀则剥离，避免编号叠加，如 "文档 (1).pdf" 再冲突时不再追加 " (1) (1)"）
    // 支持连续编号尾缀（如 "金地天府城 (1)(3).dwg" 剥离为根名 "金地天府城"）
    const ext = path.extname(trimmed)
    const baseName = path.basename(trimmed, ext)
    const baseMatch = baseName.match(/^(.*?)(?:\s*\(\d+\))+$/)
    const rootName = (baseMatch && baseMatch[1] ? baseMatch[1].trim() : baseName) || baseName

    // 单次查询同工作区内同根名（含已编号变体）的所有智能名，排除自身
    const escapeLike = (s: string) => s.replace(/[\\%_]/g, '\\$&')
    const pattern = `${escapeLike(rootName)}%${escapeLike(ext)}`
    const rows = this.db
      .prepare(
        `SELECT f.smart_name FROM files f
         JOIN workspace_files wf ON f.file_fingerprint = wf.file_fingerprint
         WHERE wf.workspace_id = ? AND f.smart_name IS NOT NULL AND f.smart_name != ''
           AND f.file_fingerprint != ? AND f.smart_name LIKE ? ESCAPE '\\'`
      )
      .all(workspaceId, excludeFingerprint, pattern) as Array<{ smart_name: string }>

    const existingSet = new Set(
      rows
        .map(r => r.smart_name?.trim()?.toLowerCase())
        .filter((n): n is string => typeof n === 'string' && n.length > 0)
    )
    // 无精确同名时直接返回原名
    if (!existingSet.has(trimmed.toLowerCase())) return trimmed

    // 收集已占用的编号，从 1 开始查找最小未占用的编号后缀
    const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const variantRe = new RegExp(
      `^${escapeRegExp(rootName)} \\((\\d+)\\)${escapeRegExp(ext)}$`,
      'i'
    )
    const usedNumbers = new Set<number>()
    for (const name of existingSet) {
      const m = name.match(variantRe)
      if (m) usedNumbers.add(Number(m[1]))
    }
    const maxAttempts = 100
    for (let counter = 1; counter <= maxAttempts; counter++) {
      if (!usedNumbers.has(counter)) return `${rootName} (${counter})${ext}`
    }
    return `${rootName} (${maxAttempts + 1})${ext}`
  }

  async updateFileAnalysisResult(pathId: string, result: any): Promise<void> {
    const wf = this.db
      .prepare('SELECT file_fingerprint, workspace_id FROM workspace_files WHERE id = ?')
      .get(pathId) as any
    if (!wf) throw new Error(t('文件路径记录不存在'))

    const fileFingerprint = result.contentHash || wf.file_fingerprint

    // 智能文件名落盘前进行重名检测：同工作区内重名时自动追加编号后缀
    const finalSmartName =
      result.smartName && wf.workspace_id
        ? this.resolveUniqueSmartName(result.smartName, fileFingerprint, wf.workspace_id)
        : result.smartName

    // 两个来源字段（核心名来源 / 模板套用来源）的刷新与「本次是否写入核心名」严格耦合：
    // - 写入新核心名时：一并刷新 smart_name_source 与 smart_name_template_source（未提供即置 NULL，
    //   因为新名重新决定了它的来源与是否被套模板，旧值已失效）；
    // - 未写入核心名时（如仅更新 metadata / description）：保留库中既有来源，避免误清空。
    const writeNameFlag = finalSmartName ? 1 : 0
    const smartNameSourceValue = finalSmartName ? (result.smartNameSource ?? null) : null
    const smartNameTemplateSourceValue = finalSmartName
      ? (result.smartNameTemplateSource ?? null)
      : null

    this.db.transaction(() => {
      const now = new Date().toISOString()
      this.db
        .prepare(
          `
        INSERT INTO files (
          file_fingerprint, smart_name, raw_smart_name, smart_name_source, smart_name_template_source,
          size, extension, file_group,
          author, language, is_hit, last_hit_at, description, sync_status, created_at, modified_at, accessed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_fingerprint) DO UPDATE SET
          smart_name = COALESCE(?, smart_name),
          raw_smart_name = COALESCE(?, raw_smart_name),
          smart_name_source = CASE WHEN ? = 1 THEN ? ELSE smart_name_source END,
          smart_name_template_source = CASE WHEN ? = 1 THEN ? ELSE smart_name_template_source END,
          size = COALESCE(?, size),
          extension = COALESCE(?, extension),
          file_group = COALESCE(?, file_group),
          author = COALESCE(?, author),
          language = COALESCE(?, language),
          sync_status = COALESCE(?, sync_status),
          modified_at = COALESCE(?, modified_at),
          accessed_at = COALESCE(?, accessed_at),
          is_hit = COALESCE(?, is_hit),
          description = COALESCE(?, description),
          last_hit_at = CASE WHEN ? = 1 THEN ? ELSE last_hit_at END
      `
        )
        .run(
          fileFingerprint,
          finalSmartName || null,
          result.rawSmartName || null,
          smartNameSourceValue,
          smartNameTemplateSourceValue,
          result.size || 0,
          normalizeFileExtension(result.extension || (wf ? wf.path : '')),
          result.fileGroup || null,
          result.author || null,
          result.language || null,
          result.isHit ? 1 : 0,
          result.isHit ? result.lastHitAt || now : null,
          result.description || null,
          result.syncStatus ?? 0,
          now,
          now,
          now,
          finalSmartName || null,
          result.rawSmartName || null,
          writeNameFlag,
          smartNameSourceValue,
          writeNameFlag,
          smartNameTemplateSourceValue,
          result.size || null,
          result.extension !== undefined ? normalizeFileExtension(result.extension) : null,
          result.fileGroup || null,
          result.author || null,
          result.language || null,
          result.syncStatus ?? 0,
          result.modifiedAt || null,
          result.accessedAt || null,
          result.isHit !== undefined ? (result.isHit ? 1 : 0) : null,
          result.description || null,
          result.isHit !== undefined ? (result.isHit ? 1 : 0) : null,
          result.isHit ? result.lastHitAt || now : null
        )

      // 安全深度合并 metadata：保留数据库中已提取的 Exif/媒体全量元数据，防止被后续阶段的局部 metadata 冲掉
      let finalMetadata = result.metadata
      if (finalMetadata !== undefined) {
        const oldContentRow = this.db
          .prepare('SELECT exif FROM file_contents WHERE file_fingerprint = ?')
          .get(fileFingerprint) as { exif?: string } | undefined
        if (oldContentRow?.exif) {
          try {
            // exif 列是 BLOB（compressText 压缩），需先解压再 JSON.parse
            const oldMeta = JSON.parse(
              decompressText(oldContentRow.exif as unknown as Buffer | string)
            )
            if (oldMeta && typeof oldMeta === 'object' && Object.keys(oldMeta).length > 0) {
              finalMetadata = {
                ...oldMeta,
                ...(result.metadata || {})
              }
            }
          } catch {}
        }
        if (finalMetadata && typeof finalMetadata === 'object') {
          // 如果包含由 Omni 服务返回的命名空间嵌套容器，将其内部字段展开提升至顶层
          const flattened: Record<string, any> = {
            ...(finalMetadata.exiftool && typeof finalMetadata.exiftool === 'object'
              ? finalMetadata.exiftool
              : {}),
            ...(finalMetadata.document && typeof finalMetadata.document === 'object'
              ? finalMetadata.document
              : {}),
            ...(finalMetadata.image && typeof finalMetadata.image === 'object'
              ? finalMetadata.image
              : {}),
            ...(finalMetadata.image?.exif && typeof finalMetadata.image.exif === 'object'
              ? finalMetadata.image.exif
              : {}),
            ...(finalMetadata.audio && typeof finalMetadata.audio === 'object'
              ? finalMetadata.audio
              : {}),
            ...(finalMetadata.video && typeof finalMetadata.video === 'object'
              ? finalMetadata.video
              : {}),
            ...(finalMetadata.font && typeof finalMetadata.font === 'object'
              ? finalMetadata.font
              : {}),
            ...(finalMetadata.archive && typeof finalMetadata.archive === 'object'
              ? finalMetadata.archive
              : {}),
            ...(finalMetadata.database && typeof finalMetadata.database === 'object'
              ? finalMetadata.database
              : {}),
            ...(finalMetadata.model && typeof finalMetadata.model === 'object'
              ? finalMetadata.model
              : {}),
            ...finalMetadata
          }
          finalMetadata = flattened
          delete finalMetadata.basic
          delete finalMetadata.text
          delete finalMetadata.category
          delete finalMetadata.magika
          delete finalMetadata.errors
          delete finalMetadata.exiftool
          delete finalMetadata.document
          delete finalMetadata.image
          delete finalMetadata.audio
          delete finalMetadata.video
          delete finalMetadata.font
          delete finalMetadata.archive
          delete finalMetadata.database
          delete finalMetadata.model
          // ADR-0054：本地 SQLite 零向量原则，严禁向 file_contents.exif 写入任何向量数组（统一由 Omni zvec 托管）
          delete finalMetadata.embedding_dense
          delete finalMetadata.embeddingDense
          delete finalMetadata.embedding_wemm
          delete finalMetadata.embeddingWemm
        }
      }

      // 如果传入了新的 analysisStats，进行 fresh 与 archive 的深度合并与保存
      let newStatsJson: string | null = null
      if (result.analysisStats) {
        const oldRow = this.db
          .prepare('SELECT analysis_stats FROM file_contents WHERE file_fingerprint = ?')
          .get(fileFingerprint) as { analysis_stats?: string } | undefined

        let existingStats: any = {}
        if (oldRow?.analysis_stats) {
          try {
            existingStats = JSON.parse(oldRow.analysis_stats) || {}
          } catch {
            existingStats = {}
          }
        }

        const incomingStats = result.analysisStats
        const hardware = incomingStats.hardware ||
          existingStats.hardware || { platform: process.platform }
        const analysisStage = incomingStats.analysis_stage ?? existingStats.analysis_stage ?? 0

        // 「本次分析实际采用的模式」必须与 analysis_stage 一同落库。
        //
        // 存在的必要性：quick_name 与 full 的终态 stage 都是 4，仅凭 stage 无法区分。
        // 若此前用 quick_name 分析过（跳过质量评分），切到 full 后必须重跑以补上质量评分；
        // 反之 full 的产物对 quick_name / simple 向下兼容，无需重跑。
        //
        // 注意：下方 finalStatsObj 是白名单重建，未列入此处的字段会被静默丢弃。
        const completedMode = normalizeAnalysisMode(
          incomingStats.completed_mode ?? existingStats.completed_mode
        )

        const existingPerf = existingStats.performance || {}
        const incomingPerf = incomingStats.performance || {}
        const incomingFresh =
          incomingPerf.fresh ||
          (incomingStats.phases
            ? {
                accelerator: incomingStats.accelerator || 'cpu',
                durationMs: incomingStats.durationMs || 0,
                phases: incomingStats.phases || {},
                stage1Breakdown: incomingStats.stage1Breakdown,
                contentExtractionBreakdown: incomingStats.contentExtractionBreakdown,
                model: incomingStats.model
              }
            : undefined)

        let finalFresh =
          existingPerf.fresh ||
          (existingStats.phases
            ? {
                accelerator: existingStats.accelerator || 'cpu',
                durationMs: existingStats.durationMs || 0,
                phases: existingStats.phases || {},
                stage1Breakdown: existingStats.stage1Breakdown,
                contentExtractionBreakdown: existingStats.contentExtractionBreakdown,
                model: existingStats.model
              }
            : undefined)
        let finalArchive =
          existingPerf.archive ||
          (existingStats.phases
            ? {
                durationMs: existingStats.durationMs || 0,
                phases: existingStats.phases || {},
                stage1Breakdown: existingStats.stage1Breakdown,
                contentExtractionBreakdown: existingStats.contentExtractionBreakdown,
                model: existingStats.model
              }
            : undefined)

        // 规则判定：是否包含 CPU 阶段指标 (MarkitdownServer 或 哈希与类型识别)
        const hasCpuPhases = (item?: any) => {
          if (!item?.phases) return false
          const keys = Object.keys(item.phases)
          return keys.some(
            k =>
              k === 'hashAndTypeIdentification' ||
              k === 'markitdownServerExtraction' ||
              k === 'textAndThumbnailExtractionSimple' ||
              k === 'contentExtraction' ||
              k.includes('Markitdown') ||
              k.includes('内容提取') ||
              k.includes('哈希') ||
              k.includes('指纹')
          )
        }

        const isCpuTask = incomingFresh ? hasCpuPhases(incomingFresh) : false

        // 安全合并 breakdown，过滤 undefined/null，以防将 archive 的有效值覆盖为 undefined
        const mergeBreakdown = (base: any, incoming: any) => {
          const res = { ...(base || {}) }
          if (incoming) {
            for (const [k, v] of Object.entries(incoming)) {
              if (v !== undefined && v !== null) {
                res[k] = v
              }
            }
          }
          return res
        }

        if (isCpuTask) {
          // 1 & 2: CPU 阶段开始/执行
          if (finalFresh) {
            // 如果已有 fresh，先将 fresh 归档 merge 到 archive
            const mergedArchivePhases = {
              ...(finalArchive?.phases || {}),
              ...(finalFresh.phases || {})
            }
            const mergedBreakdown = mergeBreakdown(
              finalArchive?.contentExtractionBreakdown,
              finalFresh.contentExtractionBreakdown
            )
            const mergedStage1 = mergeBreakdown(
              finalArchive?.stage1Breakdown,
              finalFresh.stage1Breakdown
            )
            finalArchive = {
              accelerator: finalFresh.accelerator || finalArchive?.accelerator,
              durationMs: (finalArchive?.durationMs || 0) + (finalFresh.durationMs || 0),
              phases: mergedArchivePhases,
              stage1Breakdown: Object.keys(mergedStage1).length > 0 ? mergedStage1 : undefined,
              contentExtractionBreakdown:
                Object.keys(mergedBreakdown).length > 0 ? mergedBreakdown : undefined,
              model: finalFresh.model || finalArchive?.model
            }
          }
          // 新建 fresh
          finalFresh = incomingFresh
        } else {
          // 3: GPU 阶段（本次未执行 CPU，CPU 提取被复用跳过）：按 cpuSkipped 判定 fresh 重建
          if (incomingFresh) {
            if (finalFresh) {
              if (incomingFresh.cpuSkipped) {
                // CPU 被复用跳过：历史 fresh 归档 merge 至 archive，避免历史 CPU 指标残留在"本次分析耗时"中
                const mergedArchivePhases = {
                  ...(finalArchive?.phases || {}),
                  ...(finalFresh.phases || {})
                }
                const mergedBreakdown = mergeBreakdown(
                  finalArchive?.contentExtractionBreakdown,
                  finalFresh.contentExtractionBreakdown
                )
                const mergedStage1 = mergeBreakdown(
                  finalArchive?.stage1Breakdown,
                  finalFresh.stage1Breakdown
                )
                finalArchive = {
                  accelerator: finalFresh.accelerator || finalArchive?.accelerator,
                  durationMs: (finalArchive?.durationMs || 0) + (finalFresh.durationMs || 0),
                  phases: mergedArchivePhases,
                  stage1Breakdown: Object.keys(mergedStage1).length > 0 ? mergedStage1 : undefined,
                  contentExtractionBreakdown:
                    Object.keys(mergedBreakdown).length > 0 ? mergedBreakdown : undefined,
                  model: finalFresh.model || finalArchive?.model
                }
                // 用本次 GPU-only 指标重建 fresh，历史 CPU 指标已全部归档
                finalFresh = incomingFresh
              } else {
                // 并行流水线 GPU 阶段：直接追加到本次 CPU 已写入的 fresh
                const mergedFreshPhases = {
                  ...(finalFresh.phases || {}),
                  ...(incomingFresh.phases || {})
                }
                const mergedBreakdown = mergeBreakdown(
                  finalFresh.contentExtractionBreakdown,
                  incomingFresh.contentExtractionBreakdown
                )
                const mergedStage1 = mergeBreakdown(
                  finalFresh.stage1Breakdown,
                  incomingFresh.stage1Breakdown
                )
                // 物理耗时修正：如果 incoming 属于重复或覆盖分析，fresh.durationMs 应该精准等于更新后的 fresh.phases 各阶段之和
                const freshSumMs = Object.values(mergedFreshPhases).reduce(
                  (sum: number, v: any) => sum + (Number(v) || 0),
                  0
                )
                finalFresh = {
                  accelerator: incomingFresh.accelerator || finalFresh.accelerator,
                  durationMs: freshSumMs,
                  phases: mergedFreshPhases,
                  stage1Breakdown: Object.keys(mergedStage1).length > 0 ? mergedStage1 : undefined,
                  contentExtractionBreakdown:
                    Object.keys(mergedBreakdown).length > 0 ? mergedBreakdown : undefined,
                  model: incomingFresh.model || finalFresh.model
                }
              }
            } else {
              finalFresh = incomingFresh
            }
          }
        }

        // 实时同步 archive
        if (finalFresh) {
          const mergedArchivePhases = {
            ...(finalArchive?.phases || {}),
            ...(finalFresh.phases || {})
          }
          const mergedBreakdown = mergeBreakdown(
            finalArchive?.contentExtractionBreakdown,
            finalFresh.contentExtractionBreakdown
          )
          const mergedStage1 = mergeBreakdown(
            finalArchive?.stage1Breakdown,
            finalFresh.stage1Breakdown
          )
          finalArchive = {
            accelerator: finalFresh.accelerator || finalArchive?.accelerator,
            durationMs: Math.max(finalArchive?.durationMs || 0, finalFresh.durationMs || 0),
            phases: mergedArchivePhases,
            stage1Breakdown: Object.keys(mergedStage1).length > 0 ? mergedStage1 : undefined,
            contentExtractionBreakdown:
              Object.keys(mergedBreakdown).length > 0 ? mergedBreakdown : undefined,
            model: finalFresh.model || finalArchive?.model
          }
        }

        // cpuSkipped 仅为 fresh 重建的临时批次信号，不持久化
        if (finalFresh) delete finalFresh.cpuSkipped

        // 历史遗留根级字段（durationMs/phases/contentExtractionBreakdown/model）只读不写，
        // 新数据仅写入 analysis_stage、completed_mode、hardware、performance，
        // 根级读取由各消费方 fallback 兼容旧数据。
        //
        // ⚠️ 这是白名单重建：任何未在此列出的字段都不会落库。
        // 新增分析状态字段时必须同步补充，否则会像 completed_mode 一样被静默丢弃。
        const finalStatsObj: Record<string, any> = {
          hardware,
          analysis_stage: analysisStage,
          performance: {
            fresh: finalFresh,
            archive: finalArchive
          }
        }
        if (completedMode) {
          finalStatsObj.completed_mode = completedMode
        }

        newStatsJson = JSON.stringify(finalStatsObj)
      }

      // 5 大文本字段透明单行无损压缩存为 BLOB（Task #683）
      const compressedContent = compressText(result.content ?? null)
      const compressedMultimodal = compressText(result.multimodalContent ?? null)
      const compressedOcr = compressText((result as any).ocr ?? null)
      const compressedLrc = compressText(result.lrc ?? null)
      const compressedAsr = compressText((result as any).asr ?? null)
      const compressedExif = compressJson(finalMetadata ?? null)

      this.db
        .prepare(
          `
        INSERT INTO file_contents (
          file_fingerprint, content, multimodal_content, ocr, lrc, asr, exif, analysis_stats,
          quality_score, quality_confidence, quality_criteria, quality_reasoning,
          grouping_reason, grouping_confidence, meta
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_fingerprint) DO UPDATE SET
          content = COALESCE(?, content),
          multimodal_content = COALESCE(?, multimodal_content),
          ocr = COALESCE(?, ocr),
          lrc = COALESCE(?, lrc),
          asr = COALESCE(?, asr),
          exif = COALESCE(?, exif),
          quality_score = COALESCE(?, quality_score),
          quality_confidence = COALESCE(?, quality_confidence),
          quality_reasoning = COALESCE(?, quality_reasoning),
          quality_criteria = COALESCE(?, quality_criteria),
          grouping_reason = COALESCE(?, grouping_reason),
          grouping_confidence = COALESCE(?, grouping_confidence),
          meta = COALESCE(?, meta),
          analysis_stats = COALESCE(?, analysis_stats)
      `
        )
        .run(
          fileFingerprint,
          compressedContent,
          compressedMultimodal,
          compressedOcr,
          compressedLrc,
          compressedAsr,
          compressedExif,
          newStatsJson || (result.analysisStats ? JSON.stringify(result.analysisStats) : null),
          result.qualityScore ?? null,
          result.qualityConfidence ?? null,
          result.qualityCriteria ? JSON.stringify(result.qualityCriteria) : null,
          result.qualityReasoning ?? null,
          result.groupingReason ?? null,
          result.groupingConfidence ?? null,
          // meta 列恢复纯弹性数据，不再混入扩展元数据
          (result as any).meta ? JSON.stringify((result as any).meta) : '{}',
          compressedContent,
          compressedMultimodal,
          compressedOcr,
          compressedLrc,
          compressedAsr,
          compressedExif,
          result.qualityScore ?? null,
          result.qualityConfidence ?? null,
          result.qualityReasoning ?? null,
          result.qualityCriteria ? JSON.stringify(result.qualityCriteria) : null,
          result.groupingReason ?? null,
          result.groupingConfidence ?? null,
          (result as any).meta ? JSON.stringify((result as any).meta) : null,
          newStatsJson || (result.analysisStats ? JSON.stringify(result.analysisStats) : null)
        )

      // 获取当前最新的 analysis_stage 与 completed_mode，判断是否达到目标阶段
      let currentStage = 0
      let currentCompletedMode: AnalysisMode | undefined
      try {
        const row = this.db
          .prepare('SELECT analysis_stats FROM file_contents WHERE file_fingerprint = ?')
          .get(fileFingerprint) as { analysis_stats?: string } | undefined
        if (row?.analysis_stats) {
          const stats = JSON.parse(row.analysis_stats)
          currentStage = Number(stats?.analysis_stage ?? 0)
          currentCompletedMode = normalizeAnalysisMode(stats?.completed_mode)
        }
      } catch {
        currentStage = 0
        currentCompletedMode = undefined
      }

      // 统一通过「分析模式单一事实来源」判定，避免与 save-local-cache-result 口径漂移。
      // 必须同时校验 completed_mode：quick_name 与 full 的终态 stage 都是 4，
      // 但 quick_name 跳过质量评分，仅凭 stage 无法区分。
      // 采用等级覆盖口径：高级模式的产物对低级模式依然有效（无需重跑）。
      const isTargetStageReached = isAnalyzedForMode({
        stage: currentStage,
        completedMode: currentCompletedMode
      })

      this.db
        .prepare(
          `
        UPDATE workspace_files SET 
          file_fingerprint = ?,
          is_analyzed = CASE WHEN ? = 1 THEN 1 ELSE is_analyzed END,
          last_analyzed_at = ?,
          thumbnail_path = COALESCE(?, thumbnail_path),
          modified_at = COALESCE(?, modified_at),
          accessed_at = COALESCE(?, accessed_at)
        WHERE id = ?
      `
        )
        .run(
          fileFingerprint,
          isTargetStageReached ? 1 : 0,
          new Date().toISOString(),
          result.thumbnailPath || null,
          result.modifiedAt || null,
          result.accessedAt || null,
          pathId
        )
    })()
  }

}
