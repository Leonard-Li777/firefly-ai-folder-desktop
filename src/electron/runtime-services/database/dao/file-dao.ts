import type { Database, Statement } from 'better-sqlite3'
import { LogCategory, logger, cleanSmartName } from '@firefly/shared'
import { t } from '@app/languages'
import * as path from 'path'
import * as fs from 'fs'
import { AccessTimeBatchUpdater } from '../access-time-batch-updater'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'

export class FileDao {
  private dimensionsCache: any[] | null = null
  private ftsSearchStmtWithWorkspace: Statement | null = null
  private ftsSearchStmtGlobal: Statement | null = null
  private ftsVirtualSearchStmt: Statement | null = null

  constructor(private db: Database) {}

  clearDimensionsCache(): void {
    this.dimensionsCache = null
  }

  private getFtsSearchStmt(workspaceId?: number): { stmt: Statement; extraParams: any[] } {
    if (workspaceId) {
      if (!this.ftsSearchStmtWithWorkspace) {
        this.ftsSearchStmtWithWorkspace = this.db.prepare(`
          SELECT
            COALESCE(f.file_fingerprint, wf.file_fingerprint) as file_fingerprint,
            COALESCE(f.smart_name, wf.name) as smart_name,
            f.size, f.type, f.category, f.author, f.language, f.is_hit, f.last_hit_at, f.description,
            wf.id, wf.path, wf.name, wf.is_analyzed, wf.modified_at as wf_mod,
            fc.quality_score,
            bm25(files_fts, 10.0, 5.0, 1.0, 2.0) as rank
          FROM files_fts
          JOIN workspace_files wf ON files_fts.file_fingerprint = wf.file_fingerprint
          LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
          LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
          WHERE files_fts MATCH ? AND wf.workspace_id = ?
          ORDER BY rank ASC LIMIT 100
        `)
      }
      return { stmt: this.ftsSearchStmtWithWorkspace, extraParams: [workspaceId] }
    } else {
      if (!this.ftsSearchStmtGlobal) {
        this.ftsSearchStmtGlobal = this.db.prepare(`
          SELECT
            COALESCE(f.file_fingerprint, wf.file_fingerprint) as file_fingerprint,
            COALESCE(f.smart_name, wf.name) as smart_name,
            f.size, f.type, f.category, f.author, f.language, f.is_hit, f.last_hit_at, f.description,
            wf.id, wf.path, wf.name, wf.is_analyzed, wf.modified_at as wf_mod,
            fc.quality_score,
            bm25(files_fts, 10.0, 5.0, 1.0, 2.0) as rank
          FROM files_fts
          JOIN workspace_files wf ON files_fts.file_fingerprint = wf.file_fingerprint
          LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
          LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
          WHERE files_fts MATCH ?
          ORDER BY rank ASC LIMIT 100
        `)
      }
      return { stmt: this.ftsSearchStmtGlobal, extraParams: [] }
    }
  }

  private getFtsVirtualSearchStmt(): Statement {
    if (!this.ftsVirtualSearchStmt) {
      this.ftsVirtualSearchStmt = this.db.prepare(`
        SELECT
          COALESCE(f.file_fingerprint, wf.file_fingerprint) as file_fingerprint,
          COALESCE(f.smart_name, wf.name) as smart_name,
          f.size, f.type, f.category, f.author, f.language, f.is_hit, f.last_hit_at, f.description,
          wf.id, wf.path, wf.name, wf.is_analyzed, wf.modified_at as wf_mod,
          fc.quality_score, vdf.relative_path, vdf.virtual_directory_id,
          bm25(files_fts, 10.0, 5.0, 1.0, 2.0) as rank
        FROM files_fts
        JOIN workspace_files wf ON files_fts.file_fingerprint = wf.file_fingerprint
        JOIN virtual_directory_files vdf ON vdf.file_id = wf.id
        LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
        LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
        WHERE files_fts MATCH ?
          AND (? IS NULL OR vdf.virtual_directory_id = ?)
        ORDER BY rank ASC LIMIT 100
      `)
    }
    return this.ftsVirtualSearchStmt
  }

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
          const ext = path.extname(workspaceFile.path).toLowerCase().replace(/^\./, '')
          // 先确保父表 files 与 file_contents 记录存在，防止触发 SQLite 外键约束异常
          this.db
            .prepare(
              `INSERT OR IGNORE INTO files (file_fingerprint, smart_name, size, type, created_at, modified_at, accessed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              fingerprint,
              workspaceFile.name,
              stats.size,
              ext || 'unknown',
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
          f.smart_name, f.size, f.type, f.category, f.author, f.language,
          f.is_hit, f.last_hit_at, f.description,
          fc.content, fc.multimodal_content, fc.lrc, fc.quality_score, fc.quality_confidence, 
          fc.quality_reasoning, fc.quality_criteria, fc.grouping_reason, fc.grouping_confidence,
          fc.metadata, fc.analysis_stats
        FROM files f
        LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
        WHERE f.file_fingerprint = ?`)
      const fData = fileStmt.get(fingerprint) as any
      if (fData) {
        fileData = fData
      }
    }

    let tags: any[] = []
    if (fingerprint) {
      const tagsStmt = this.db.prepare(`
        SELECT 
          ft.id, ft.name, ft.dimension_id
        FROM file_tag_relations ftr
        JOIN file_tags ft ON ft.id = ftr.tag_id
        WHERE ftr.file_fingerprint = ? 
      `)
      tags = tagsStmt.all(fingerprint) as any[]
    }

    const dimensionTags: { [dimensionId: string]: any[] } = {}
    tags.forEach(tag => {
      const dimId = tag.dimension_id
      if (!dimensionTags[dimId]) dimensionTags[dimId] = []
      dimensionTags[dimId].push({ id: tag.id, name: tag.name })
    })

    if (!this.dimensionsCache) {
      this.dimensionsCache = this.db
        .prepare('SELECT id, level, description FROM file_dimensions ORDER BY level ASC')
        .all() as any[]
    }
    const dimensions = this.dimensionsCache
    const sortedDimensionTags: Array<{ dimension: string; level: number; tags: any[] }> = []

    dimensions.forEach(dim => {
      if (dimensionTags[dim.id]) {
        sortedDimensionTags.push({
          dimension: dim.id,
          level: dim.level,
          tags: dimensionTags[dim.id]
        })
        delete dimensionTags[dim.id]
      }
    })

    Object.entries(dimensionTags).forEach(([dimId, remainingTags]) => {
      sortedDimensionTags.push({ dimension: dimId, level: 3, tags: remainingTags as any[] })
    })

    const parsedCategory = fileData.category ? JSON.parse(fileData.category) : null
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
      size: fileData.size,
      type: fileData.type,
      category: parsedCategory ?? undefined,
      mimeType: parsedCategory?.mime_type ?? 'application/octet-stream',
      createdAt: workspaceFile.created_at,
      modifiedAt: workspaceFile.modified_at,
      accessedAt: workspaceFile.accessed_at,
      description: fileData.description,
      content: fileData.content,
      multimodalContent: fileData.multimodal_content,
      lrc: fileData.lrc,
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
      groupingReason: fileData.grouping_reason,
      groupingConfidence: fileData.grouping_confidence,
      thumbnailPath: workspaceFile.thumbnail_path,
      metadata: fileData.metadata ? JSON.parse(fileData.metadata) : undefined
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
      const { directoryContextService } = await import('../../../main/state')
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

    logger.info(
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

    const existingSet = new Set(rows.map(r => r.smart_name.trim().toLowerCase()))
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

    this.db.transaction(() => {
      const now = new Date().toISOString()
      this.db
        .prepare(
          `
        INSERT INTO files (
          file_fingerprint, smart_name, size, type, category,
          author, language, is_hit, last_hit_at, description, sync_status, created_at, modified_at, accessed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_fingerprint) DO UPDATE SET 
          smart_name = COALESCE(?, smart_name),
          size = COALESCE(?, size),
          type = COALESCE(?, type),
          category = COALESCE(?, category),
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
          result.size || 0,
          result.type || 'file',
          result.category ? JSON.stringify(result.category) : null,
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
          result.size || null,
          result.type || null,
          result.category ? JSON.stringify(result.category) : null,
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
          .prepare('SELECT metadata FROM file_contents WHERE file_fingerprint = ?')
          .get(fileFingerprint) as { metadata?: string } | undefined
        if (oldContentRow?.metadata) {
          try {
            const oldMeta = JSON.parse(oldContentRow.metadata)
            if (oldMeta && typeof oldMeta === 'object' && Object.keys(oldMeta).length > 0) {
              finalMetadata = {
                ...oldMeta,
                ...(result.metadata || {})
              }
            }
          } catch {}
        }
        if (finalMetadata && typeof finalMetadata === 'object') {
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
              stage1Breakdown:
                Object.keys(mergedStage1).length > 0 ? mergedStage1 : undefined,
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
                  stage1Breakdown:
                    Object.keys(mergedStage1).length > 0 ? mergedStage1 : undefined,
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
                  stage1Breakdown:
                    Object.keys(mergedStage1).length > 0 ? mergedStage1 : undefined,
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
            stage1Breakdown:
              Object.keys(mergedStage1).length > 0 ? mergedStage1 : undefined,
            contentExtractionBreakdown:
              Object.keys(mergedBreakdown).length > 0 ? mergedBreakdown : undefined,
            model: finalFresh.model || finalArchive?.model
          }
        }

        // cpuSkipped 仅为 fresh 重建的临时批次信号，不持久化
        if (finalFresh) delete finalFresh.cpuSkipped

        // 历史遗留根级字段（durationMs/phases/contentExtractionBreakdown/model）只读不写，
        // 新数据仅写入 analysis_stage、hardware、performance，根级读取由各消费方 fallback 兼容旧数据
        const finalStatsObj = {
          hardware,
          analysis_stage: analysisStage,
          performance: {
            fresh: finalFresh,
            archive: finalArchive
          }
        }

        newStatsJson = JSON.stringify(finalStatsObj)
      }

      this.db
        .prepare(
          `
        INSERT INTO file_contents (
          file_fingerprint, content, multimodal_content, lrc, metadata, analysis_stats, 
          quality_score, quality_confidence, quality_criteria, quality_reasoning,
          grouping_reason, grouping_confidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_fingerprint) DO UPDATE SET
          content = COALESCE(?, content),
          multimodal_content = COALESCE(?, multimodal_content),
          lrc = COALESCE(?, lrc),
          quality_score = COALESCE(?, quality_score),
          quality_confidence = COALESCE(?, quality_confidence),
          quality_reasoning = COALESCE(?, quality_reasoning),
          quality_criteria = COALESCE(?, quality_criteria),
          grouping_reason = COALESCE(?, grouping_reason),
          grouping_confidence = COALESCE(?, grouping_confidence),
          metadata = COALESCE(?, metadata),
          analysis_stats = COALESCE(?, analysis_stats)
      `
        )
        .run(
          fileFingerprint,
          result.content ?? null,
          result.multimodalContent ?? null,
          result.lrc ?? null,
          finalMetadata ? JSON.stringify(finalMetadata) : null,
          newStatsJson || (result.analysisStats ? JSON.stringify(result.analysisStats) : null),
          result.qualityScore ?? null,
          result.qualityConfidence ?? null,
          result.qualityCriteria ? JSON.stringify(result.qualityCriteria) : null,
          result.qualityReasoning ?? null,
          result.groupingReason ?? null,
          result.groupingConfidence ?? null,
          result.content ?? null,
          result.multimodalContent ?? null,
          result.lrc ?? null,
          result.qualityScore ?? null,
          result.qualityConfidence ?? null,
          result.qualityReasoning ?? null,
          result.qualityCriteria ? JSON.stringify(result.qualityCriteria) : null,
          result.groupingReason ?? null,
          result.groupingConfidence ?? null,
          finalMetadata ? JSON.stringify(finalMetadata) : null,
          newStatsJson || (result.analysisStats ? JSON.stringify(result.analysisStats) : null)
        )

      // 获取当前最新的 analysis_stage 判断是否达到目标阶段
      let currentStage = 0
      try {
        const row = this.db
          .prepare('SELECT analysis_stats FROM file_contents WHERE file_fingerprint = ?')
          .get(fileFingerprint) as { analysis_stats?: string } | undefined
        if (row?.analysis_stats) {
          const stats = JSON.parse(row.analysis_stats)
          currentStage = Number(stats?.analysis_stage ?? 0)
        }
      } catch {
        currentStage = 0
      }

      const analysisMode =
        ConfigOrchestrator.getInstance().getValue<string>('ANALYSIS_MODE') ?? 'quick_name'
      const isTargetStageReached =
        (analysisMode === 'simple' && currentStage >= 1) ||
        (analysisMode === 'quick_name' && currentStage >= 3) ||
        (analysisMode === 'full' && currentStage >= 4)

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
      const parsedCategory = row.category ? JSON.parse(row.category) : null
      const normalizedExt = row.type
        ? row.type.startsWith('.')
          ? row.type
          : `.${row.type}`
        : row.path
          ? path.extname(row.path).toLowerCase()
          : ''
      return {
        id: row.id,
        name: row.name,
        path: row.path,
        smartName: row.smart_name,
        size: row.size || 0,
        type: normalizedExt,
        extension: normalizedExt,
        category: parsedCategory ?? undefined,
        mimeType: parsedCategory?.mime_type ?? 'application/octet-stream',
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
        WHERE (wf.name LIKE ? OR f.smart_name LIKE ? OR f.description LIKE ? OR fc.content LIKE ? OR fc.multimodal_content LIKE ? OR fc.lrc LIKE ?)
      `
      const likeQuery = `%${trimmedQuery}%`
      const params: any[] = [likeQuery, likeQuery, likeQuery, likeQuery, likeQuery, likeQuery]

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
        WHERE (wf.name LIKE ? OR f.smart_name LIKE ? OR f.description LIKE ? OR fc.content LIKE ? OR fc.multimodal_content LIKE ? OR fc.lrc LIKE ?)
      `
      const likeQuery = `%${trimmedQuery}%`
      const params: any[] = [likeQuery, likeQuery, likeQuery, likeQuery, likeQuery, likeQuery]

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

      const parsedCategory = row.category ? JSON.parse(row.category) : null
      const normalizedExt = row.type
        ? row.type.startsWith('.')
          ? row.type
          : `.${row.type}`
        : ''
      return {
        id: row.file_fingerprint,
        name: row.name,
        smartName: row.smart_name,
        contentHash: row.file_fingerprint,
        size: row.size,
        extension: normalizedExt,
        category: parsedCategory ?? undefined,
        mimeType: parsedCategory?.mime_type ?? 'application/octet-stream',
        isAnalyzed: true,
        qualityScore: row.quality_score,
        qualityConfidence: row.quality_confidence,
        qualityReasoning: row.quality_reasoning,
        qualityCriteria: row.quality_criteria ? JSON.parse(row.quality_criteria) : undefined,
        description: row.description,
        content: row.content,
        multimodalContent: row.multimodal_content,
        lrc: row.lrc,
        groupingReason: row.grouping_reason,
        groupingConfidence: row.grouping_confidence,
        author: row.author,
        language: row.language,
        metadata: row.metadata
      }
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '根据内容哈希获取分析文件失败', {
        error,
        contentHash
      })
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

      const parsedCategory = fileData.category ? JSON.parse(fileData.category) : null

      const normalizedExt = fileData.type
        ? fileData.type.startsWith('.')
          ? fileData.type
          : `.${fileData.type}`
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
        category: parsedCategory ?? undefined,
        mimeType: parsedCategory?.mime_type ?? 'application/octet-stream',
        createdAt: new Date(wf.created_at),
        modifiedAt: new Date(wf.modified_at),
        isSelected: false,
        isAnalyzed: wf.is_analyzed === 1,
        lastAnalyzedAt: wf.last_analyzed_at ? new Date(wf.last_analyzed_at) : undefined,
        qualityScore: fileData.quality_score,
        description: fileData.description,
        content: fileData.content,
        multimodalContent: fileData.multimodal_content,
        lrc: fileData.lrc
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

      logger.info(LogCategory.DATABASE_SERVICE, '找到匹配记录，准备清空数据', {
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

        // 2. 清空 files 表中的分析数据（含 category 字段的 magika 类型识别信息）
        this.db
          .prepare(
            `
          UPDATE files
          SET smart_name = (SELECT name FROM workspace_files WHERE id = ?),
              description = NULL,
              category = NULL,
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
              metadata = NULL,
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

      logger.info(LogCategory.DATABASE_SERVICE, '文件分析数据已完全清空', { filePath: actualPath })
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
        wf.id, wf.path, wf.name, f.smart_name, f.type, f.description, fc.quality_score
      FROM workspace_files wf
      JOIN files f ON wf.file_fingerprint = f.file_fingerprint
      LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
      WHERE wf.workspace_id = ? AND wf.is_analyzed = 1
      LIMIT ?
    `
      )
      .all(workspaceId, limit) as any[]

    return rows.map(row => {
      // Fetch dimension tags separately for each file to match FileInfoForAI structure
      const tagsStmt = this.db.prepare(`
        SELECT
          ft.id, ft.name, ft.dimension_id
        FROM file_tag_relations ftr
        JOIN file_tags ft ON ft.id = ftr.tag_id
        WHERE ftr.file_fingerprint = (SELECT file_fingerprint FROM workspace_files WHERE id = ?)
      `)
      const tags = tagsStmt.all(row.id) as any[]
      const dimensionTags = tags.map(t => ({ tag: t.name, dimension: t.dimension_id }))

      return {
        id: String(row.id),
        path: row.path,
        name: row.name,
        smartName: row.smart_name,
        type: row.type,
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
        f.type,
        f.category,
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
      const parsedCategory = row.category ? JSON.parse(row.category) : null
      const normalizedExt = row.type
        ? row.type.startsWith('.')
          ? row.type
          : `.${row.type}`
        : row.path
          ? path.extname(row.path).toLowerCase()
          : ''
      return {
        id: row.id,
        status: row.status ?? 1,
        path: row.path,
        name: row.name,
        smartName: row.smart_name,
        size: row.size,
        type: normalizedExt,
        extension: normalizedExt,
        category: parsedCategory ?? undefined,
        mimeType: parsedCategory?.mime_type ?? 'application/octet-stream',
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
      logger.info(
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
      logger.info(
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

  syncFTSTags(fingerprint: string): void {
    if (!fingerprint) return
    try {
      this.db
        .prepare(
          `
          UPDATE files_fts
          SET tags = (
            SELECT GROUP_CONCAT(ft.name, ' ')
            FROM file_tag_relations ftr
            JOIN file_tags ft ON ftr.tag_id = ft.id
            WHERE ftr.file_fingerprint = ?
          )
          WHERE file_fingerprint = ?
        `
        )
        .run(fingerprint, fingerprint)
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
        const stmt = this.db.prepare(
          `
          UPDATE files_fts
          SET tags = (
            SELECT GROUP_CONCAT(ft.name, ' ')
            FROM file_tag_relations ftr
            JOIN file_tags ft ON ftr.tag_id = ft.id
            WHERE ftr.file_fingerprint = ?
          )
          WHERE file_fingerprint = ?
          `
        )
        for (const fp of uniqueFingerprints) {
          stmt.run(fp, fp)
        }
      })()
      logger.info(
        LogCategory.DATABASE_SERVICE,
        `[FileDao] 批量同步 FTS 标签完成，共 ${uniqueFingerprints.length} 项`
      )
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '批量同步FTS标签失败', error)
    }
  }
}
