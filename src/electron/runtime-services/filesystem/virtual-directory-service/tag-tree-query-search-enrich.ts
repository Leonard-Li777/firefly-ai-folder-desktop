/**
 * TagTreeQuery · 混合检索编排与行映射器（partial-class 混入）
 *
 * 拆分自原 TagTreeQuery.ts（只搬不改，逐字节保真）。承载职责：
 * 1. 检索结果页丰富（enrichSearchPage：字面高亮 + 段落级语义对齐）；
 * 2. 指纹行加载 / 正文解压 / FS 未分析命中合成（fetchRowsByFingerprints /
 *    fetchContentsForSearch / synthesizeUnanalyzedItem / fetchFieldCoverageRefs）；
 * 3. 文件筛选非分页入口与已分析计数（getFilteredFiles / getAnalyzedFilesCount /
 *    getPrivateAnalyzedFilesCount）；
 * 4. DB 行 -> 统一 FileItem 映射（mapFilesToItems）。
 *
 * 运行时经 Object.assign(TagTreeQuery.prototype, tagTreeQuerySearchEnrichMixin) 挂回主类；
 * 类型通过 TagTreeQuerySearchEnrich 接口并入 TagTreeQuery，外部导入路径与调用签名零变化。
 */
import path from 'node:path'
import fs from 'node:fs'
import { FileItem } from '@firefly/types'
import { LogCategory, logger, extractSnippet, getCanonicalConceptName } from '@firefly/shared'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'
import { normalizeSupportedLocale } from '@runtime/database/database'
import { decompressText } from '../../../utils/text-compressor'
import { splitPassages, HYBRID_SEARCH_POOL_SIZE } from './HybridSearchArbiter'
import type { HybridRankedCandidate } from './HybridSearchArbiter'
import type { TagTreeQuery, FilterFilesParams, HybridPageRef } from './TagTreeQuery'

/**
 * 【模型 B】按 code_path 拆段实时译名的轻量解析器。
 * 模型 B 无物化 name_path 列：展示名统一经单表 tag_aliases(locale) ∪ file_tags_private 词表反查，
 * 严禁在业务层重建物化 name_path。单条查询带记忆化，避免逐段重复打库。
 */
function buildCodePathNameResolver(db: any, locale: string): (code: string) => string {
  const memo = new Map<string, string>()
  const safeLocale = normalizeSupportedLocale(locale)
  const isZh = safeLocale.toLowerCase().startsWith('zh')
  return (code: string): string => {
    if (!code) return code
    const cached = memo.get(code)
    if (cached !== undefined) return cached
    let name = ''
    // 受控码在中文环境优先 AOT 权威词条
    if (isZh) name = getCanonicalConceptName(code) || ''
    if (!name && db) {
      try {
        const row = db
          .prepare(
            `SELECT COALESCE(
               (SELECT a.lemma FROM tag_aliases a
                WHERE a.locale = ? AND a.tag_code = ? AND a.is_canonical = 1 LIMIT 1),
               (SELECT p.name FROM file_tags_private p WHERE p.code = ? LIMIT 1)
             ) AS display_name`
          )
          .get(safeLocale, code, code) as { display_name: string | null } | undefined
        if (row?.display_name) name = row.display_name
      } catch (err) {
        // 单表缺失（旧库/局部 schema）属可容忍降级，记录后继续走下方兜底
        logger.debug(
          LogCategory.VIRTUAL_DIRECTORY,
          '[TagTreeQuery] 单表 tag_aliases 展示名解析失败，降级 code:',
          err
        )
      }
    }
    if (!name) name = code
    memo.set(code, name)
    return name
  }
}

export interface TagTreeQuerySearchEnrich {
  enrichSearchPage(
    keyword: string,
    analyzedRefs: Array<Extract<HybridPageRef, { kind: 'analyzed' }>>,
    candidateByFp: Map<string, HybridRankedCandidate>,
    contentsByFp: Map<string, string>,
    descriptionsByFp?: Map<string, string>
  ): Promise<
    Map<
      string,
      {
        snippet?: string
        matchType: 'exact' | 'fuzzy' | 'semantic'
        similarity?: number
        matchedPinyinCandidate?: string
      }
    >
  >

  fetchRowsByFingerprints(fileFingerprints: string[]): any[]

  fetchContentsForSearch(fileFingerprints: string[]): Map<string, string>

  synthesizeUnanalyzedItem(
    ref: Extract<HybridPageRef, { kind: 'unanalyzed' }>,
    workspaceDirectoryPath?: string
  ): FileItem

  fetchFieldCoverageRefs(params: FilterFilesParams): {
    analyzed: Array<Extract<HybridPageRef, { kind: 'analyzed' }>>
    unanalyzed: Array<Extract<HybridPageRef, { kind: 'unanalyzed' }>>
    /** 非空 = 本次补充候选查询失败（已降级为空补充集），值为失败原因 */
    failure?: string
  }

  getFilteredFiles(params: FilterFilesParams): Promise<FileItem[]>

  getAnalyzedFilesCount(workspaceDirectoryPath?: string): Promise<number>

  getPrivateAnalyzedFilesCount(workspaceDirectoryPath?: string): Promise<number>

  mapFilesToItems(
    files: any[],
    workspaceDirectoryPath: string | undefined,
    showMissing: boolean
  ): FileItem[]
}

export const tagTreeQuerySearchEnrichMixin = {
  async enrichSearchPage(
    keyword: string,
    analyzedRefs: Array<Extract<HybridPageRef, { kind: 'analyzed' }>>,
    candidateByFp: Map<string, HybridRankedCandidate>,
    contentsByFp: Map<string, string>,
    descriptionsByFp?: Map<string, string>
  ): Promise<
    Map<
      string,
      {
        snippet?: string
        matchType: 'exact' | 'fuzzy' | 'semantic'
        similarity?: number
        matchedPinyinCandidate?: string
      }
    >
  > {
    const result = new Map<
      string,
      {
        snippet?: string
        matchType: 'exact' | 'fuzzy' | 'semantic'
        similarity?: number
        matchedPinyinCandidate?: string
      }
    >()

    // 正排索引架构：中文高亮词与 matchedPinyinCandidate 来自 arbiter 的拼音校验回填
    // （candidate.matchedPinyinText，音节边界对齐；假阳性已在回填阶段丢弃）。
    // 逐候选取词——不同候选可能命中不同中文词（缩写歧义场景）。

    // 字面候选直接高亮
    const semanticBatch: Array<{ fileFingerprint: string; text: string }> = []
    for (const ref of analyzedRefs) {
      const cand = candidateByFp.get(ref.fileFingerprint)
      const text = contentsByFp.get(ref.fileFingerprint) ?? ''
      const desc = descriptionsByFp?.get(ref.fileFingerprint) ?? ''
      const pinyinCandidate = cand?.matchedPinyinText
      const extraHighlightTokens = pinyinCandidate ? [pinyinCandidate] : undefined
      if (cand?.hasLiteral) {
        // 优先在正文中提取高亮
        const highlight = extractSnippet(text, keyword, {
          escapeHtml: false,
          extraHighlightTokens
        })
        if (highlight.hitCount > 0) {
          const hitExpanded =
            Boolean(pinyinCandidate) &&
            highlight.matchedTokens.some(
              t =>
                pinyinCandidate &&
                (t.toLowerCase() === pinyinCandidate.toLowerCase() ||
                  (t.length >= 2 && pinyinCandidate.toLowerCase().includes(t.toLowerCase())))
            )
          result.set(ref.fileFingerprint, {
            snippet: highlight.snippet,
            matchType: highlight.matchType,
            similarity:
              cand?.vecScore !== undefined ? Math.round(cand.vecScore * 100) / 100 : undefined,
            matchedPinyinCandidate: hitExpanded ? pinyinCandidate : undefined
          })
          continue
        }
        // 若正文无字面命中但文件描述存在字面命中，提取描述的高亮切片
        if (desc) {
          const descHighlight = extractSnippet(desc, keyword, {
            escapeHtml: false,
            extraHighlightTokens
          })
          if (descHighlight.hitCount > 0) {
            const hitExpanded =
              Boolean(pinyinCandidate) &&
              descHighlight.matchedTokens.some(
                t =>
                  pinyinCandidate &&
                  (t.toLowerCase() === pinyinCandidate.toLowerCase() ||
                    (t.length >= 2 && pinyinCandidate.toLowerCase().includes(t.toLowerCase())))
              )
            result.set(ref.fileFingerprint, {
              snippet: descHighlight.snippet,
              matchType: descHighlight.matchType,
              similarity:
                cand?.vecScore !== undefined ? Math.round(cand.vecScore * 100) / 100 : undefined,
              matchedPinyinCandidate: hitExpanded ? pinyinCandidate : undefined
            })
            continue
          }
        }
      }
      // 若正文为空但描述非空，语义对齐可使用描述文本作为语义输入；
      // 两者皆空的文件（如未分析或无文本产出的视频）严禁进入语义批次——
      // 空文本对齐必然无命中，会被兜底盖上无相似度的 'semantic'，产生假「语义召回」徽标
      const semanticText = text.trim() ? text : desc
      if (semanticText.trim()) {
        semanticBatch.push({ fileFingerprint: ref.fileFingerprint, text: semanticText })
      }
    }

    // 无字面命中 → 段落级语义对齐
    if (semanticBatch.length > 0) {
      const alignItems: Array<{ fileFingerprint: string; passages: string[] }> = []
      for (const b of semanticBatch) {
        alignItems.push({ fileFingerprint: b.fileFingerprint, passages: splitPassages(b.text) })
      }
      // 语义对齐查询：优先用拼音校验回填的中文词（如 khxs → 科幻小说）——
      // 纯拼音串本身无语义，直接送对齐会被分词器切成碎片 token
      const firstPinyinText = semanticBatch
        .map(b => candidateByFp.get(b.fileFingerprint)?.matchedPinyinText)
        .find((v): v is string => !!v)
      const alignQuery = firstPinyinText ?? keyword
      const alignMap = await this.hybridArbiter.alignPassages(
        alignQuery,
        alignItems.map(a => ({ fileFingerprint: a.fileFingerprint, passages: a.passages }))
      )
      for (const b of semanticBatch) {
        const cand = candidateByFp.get(b.fileFingerprint)
        const match = alignMap[b.fileFingerprint]
        if (match && match.bestPassage) {
          result.set(b.fileFingerprint, {
            snippet: match.bestPassage,
            matchType: 'semantic',
            similarity: Math.round(match.similarity * 100) / 100,
            matchedPinyinCandidate: cand?.matchedPinyinText
          })
        } else {
          // 语义对齐缺失/失败 → 语义首段摘要 + 向量相似度
          const highlight = extractSnippet(b.text, keyword, {
            escapeHtml: false,
            extraHighlightTokens: cand?.matchedPinyinText ? [cand.matchedPinyinText] : undefined
          })
          result.set(b.fileFingerprint, {
            snippet: highlight.snippet || undefined,
            matchType: 'semantic',
            similarity: cand?.vecScore,
            matchedPinyinCandidate: cand?.matchedPinyinText
          })
        }
      }
    }

    return result
  },

  fetchRowsByFingerprints(fileFingerprints: string[]): any[] {
    if (fileFingerprints.length === 0) return []
    const placeholders = fileFingerprints.map(() => '?').join(',')
    const sql = `
      SELECT
        wf.id,
        wf.status,
        wf.file_fingerprint,
        wf.path,
        wf.name,
        wf.is_analyzed,
        wf.last_analyzed_at,
        wf.thumbnail_path,
        f.smart_name,
        f.size,
        f.extension,
        f.file_group,
        f.author,
        f.language,
        f.created_at,
        f.modified_at,
        fc.quality_score,
        f.description as description,
        fc.multimodal_content,
        (
            SELECT json_group_array(
              json_object(
                'code', ftr.tag_code,
                'name', ft.name,
                'code_path', tp.code_path
              )
            )
            FROM file_tag_relations ftr
            LEFT JOIN file_tags_private ft ON ft.code = ftr.tag_code
            JOIN tag_paths tp ON tp.path_id = ftr.path_id
            WHERE ftr.file_fingerprint = wf.file_fingerprint
          ) as dimension_tags,
          (
            SELECT json_group_array(
              json_object(
                'code', ftr.tag_code,
                'name', ft.name,
                'code_path', tp.code_path
              )
            )
            FROM file_tag_relations ftr
            LEFT JOIN file_tags_private ft ON ft.code = ftr.tag_code
            JOIN tag_paths tp ON tp.path_id = ftr.path_id
            WHERE ftr.file_fingerprint = wf.file_fingerprint AND ftr.tag_group = 'fused'
          ) as fused_tags
      FROM workspace_files wf
      LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
      LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
      WHERE wf.file_fingerprint IN (${placeholders})
    `
    return this.db.prepare(sql).all(...fileFingerprints) as any[]
  },

  fetchContentsForSearch(fileFingerprints: string[]): Map<string, string> {
    const map = new Map<string, string>()
    if (fileFingerprints.length === 0) return map
    const placeholders = fileFingerprints.map(() => '?').join(',')
    try {
      const rows = this.db
        .prepare(
          `
          SELECT file_fingerprint, content, multimodal_content, ocr, lrc, asr
          FROM file_contents
          WHERE file_fingerprint IN (${placeholders})
        `
        )
        .all(...fileFingerprints) as Array<{
        file_fingerprint: string
        content: string | Buffer | null
        multimodal_content: string | Buffer | null
        ocr: string | Buffer | null
        lrc: string | Buffer | null
        asr: string | Buffer | null
      }>
      for (const r of rows) {
        const parts: string[] = []
        for (const col of [r.content, r.multimodal_content, r.ocr, r.lrc, r.asr]) {
          if (col === null || col === undefined) continue
          try {
            const text = decompressText(col)
            if (text && text.trim().length > 0) parts.push(text)
          } catch {
            // 单列解压失败不影响其它列
          }
        }
        if (parts.length > 0) map.set(r.file_fingerprint, parts.join('\n'))
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(LogCategory.VIRTUAL_DIRECTORY, '[TagTreeQuery] 加载检索正文失败: ', msg)
    }
    return map
  },

  synthesizeUnanalyzedItem(
    ref: Extract<HybridPageRef, { kind: 'unanalyzed' }>,
    workspaceDirectoryPath?: string
  ): FileItem {
    let relativePathPrefix = ''
    if (workspaceDirectoryPath) {
      const sep = path.sep
      const prefix = workspaceDirectoryPath.endsWith(sep)
        ? workspaceDirectoryPath
        : workspaceDirectoryPath + sep
      const fileDir = path.dirname(ref.path)
      // 比较层纪律：仅忽略大小写与末尾斜杠，不做分隔符转换（win32 下路径大小写不敏感）
      if (fileDir.toLowerCase().startsWith(prefix.toLowerCase())) {
        const rel = path.relative(workspaceDirectoryPath, fileDir)
        if (rel && rel !== '.') relativePathPrefix = rel
      }
    }
    return {
      id: `unanalyzed:${ref.path}`,
      status: 1,
      fileFingerprint: ref.fileFingerprint,
      path: ref.path,
      parentPath: path.dirname(ref.path),
      name: ref.name,
      size: 0,
      extension: path.extname(ref.name).replace(/^\./, '').toLowerCase(),
      modifiedAt: new Date(),
      isDirectory: false,
      isAnalyzed: false,
      matchType: 'unanalyzed',
      isUnanalyzed: true,
      relativePathPrefix: relativePathPrefix || undefined
    }
  },

  fetchFieldCoverageRefs(params: FilterFilesParams): {
    analyzed: Array<Extract<HybridPageRef, { kind: 'analyzed' }>>
    unanalyzed: Array<Extract<HybridPageRef, { kind: 'unanalyzed' }>>
    /** 非空 = 本次补充候选查询失败（已降级为空补充集），值为失败原因 */
    failure?: string
  } {
    const analyzed: Array<Extract<HybridPageRef, { kind: 'analyzed' }>> = []
    const unanalyzed: Array<Extract<HybridPageRef, { kind: 'unanalyzed' }>> = []
    try {
      const { sortBy = 'name', sortOrder = 'asc' } = params
      const { whereClauses, queryParams } = this.buildFilterQuery(params)
      // 与常规分页一致的排序规则
      const sortMap: Record<string, string> = {
        name: 'wf.name',
        date: 'COALESCE(f.modified_at, wf.modified_at)',
        size: 'COALESCE(f.size, 0)',
        type: 'COALESCE(f.extension, "")',
        smartName: 'COALESCE(f.smart_name, wf.name)',
        analysisStatus: 'wf.is_analyzed',
        qualityScore: 'COALESCE(fc.quality_score, 0)',
        author: 'COALESCE(f.author, "")',
        language: 'COALESCE(f.language, "")'
      }
      const sortColumn = sortMap[sortBy] || 'wf.name'
      const safeSortOrder = sortOrder.toLowerCase() === 'desc' ? 'DESC' : 'ASC'

      const sql = `
        SELECT
          wf.file_fingerprint AS file_fingerprint,
          wf.name AS name,
          wf.path AS path,
          wf.is_analyzed AS is_analyzed
        FROM workspace_files wf
        LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
        LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
        WHERE ${whereClauses.join(' AND ')}
        ORDER BY ${sortColumn} ${safeSortOrder}
        LIMIT ?
      `
      const rows = this.db.prepare(sql).all(...queryParams, HYBRID_SEARCH_POOL_SIZE) as Array<{
        file_fingerprint: string | null
        name: string
        path: string
        is_analyzed: number
      }>
      for (const r of rows) {
        if (!r.path) continue
        if (r.is_analyzed) {
          if (r.file_fingerprint) {
            analyzed.push({
              kind: 'analyzed',
              fileFingerprint: r.file_fingerprint,
              hasLiteral: true
            })
          }
        } else {
          unanalyzed.push({
            kind: 'unanalyzed',
            path: r.path,
            name: r.name,
            fileFingerprint: r.file_fingerprint ?? undefined
          })
        }
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      // 失败原因随返回值上抛，由 HybridSearchSession 统一按「检索降级」上报（单一日志点）
      return { analyzed, unanalyzed, failure: msg }
    }
    return { analyzed, unanalyzed }
  },

  async getFilteredFiles(params: FilterFilesParams): Promise<FileItem[]> {
    try {
      const { sortBy = 'name', sortOrder = 'asc', workspaceDirectoryPath } = params
      const { whereClauses, queryParams, showMissing } = this.buildFilterQuery(params)

      const sortMap: Record<string, string> = {
        name: 'wf.name',
        date: 'COALESCE(f.modified_at, wf.modified_at)',
        size: 'COALESCE(f.size, 0)',
        type: 'COALESCE(f.extension, "")',
        smartName: 'COALESCE(f.smart_name, wf.name)',
        analysisStatus: 'wf.is_analyzed',
        qualityScore: 'COALESCE(fc.quality_score, 0)',
        author: 'COALESCE(f.author, "")',
        language: 'COALESCE(f.language, "")'
      }

      const sortColumn = sortMap[sortBy] || 'wf.name'
      const safeSortOrder = sortOrder.toLowerCase() === 'desc' ? 'DESC' : 'ASC'

      const selectQuery = `
        SELECT 
          wf.id,
          wf.status,
          wf.file_fingerprint,
          wf.path,
          wf.name,
          wf.is_analyzed,
          wf.last_analyzed_at,
          wf.thumbnail_path,
          f.smart_name,
          f.size,
          f.extension,
          f.file_group,
          f.author,
          f.language,
          f.created_at,
          f.modified_at,
          fc.quality_score,
          f.description as description,
          fc.multimodal_content,
          (
            SELECT json_group_array(
              json_object(
                'code', ftr.tag_code,
                'name', ft.name,
                'code_path', tp.code_path
              )
            )
            FROM file_tag_relations ftr
            LEFT JOIN file_tags_private ft ON ft.code = ftr.tag_code
            JOIN tag_paths tp ON tp.path_id = ftr.path_id
            WHERE ftr.file_fingerprint = wf.file_fingerprint
          ) as dimension_tags,
          (
            SELECT json_group_array(
              json_object(
                'code', ftr.tag_code,
                'name', ft.name,
                'code_path', tp.code_path
              )
            )
            FROM file_tag_relations ftr
            LEFT JOIN file_tags_private ft ON ft.code = ftr.tag_code
            JOIN tag_paths tp ON tp.path_id = ftr.path_id
            WHERE ftr.file_fingerprint = wf.file_fingerprint AND ftr.tag_group = 'fused'
          ) as fused_tags
        FROM workspace_files wf
        LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
        LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
        WHERE ${whereClauses.join(' AND ')}
        ORDER BY ${sortColumn} ${safeSortOrder}
      `

      const files = this.db.prepare(selectQuery).all(...queryParams) as any[]
      return this.mapFilesToItems(files, workspaceDirectoryPath, showMissing)
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '[TagTreeQuery] 全量过滤文件失败:', error)
      return []
    }
  },

  async getAnalyzedFilesCount(workspaceDirectoryPath?: string): Promise<number> {
    try {
      let showMissing = true
      try {
        showMissing =
          ConfigOrchestrator.getInstance().getValue<boolean>('SHOW_MISSING_FILES') ?? true
      } catch (err) {
        // 配置中心未就绪属可容忍降级：按默认值显示缺失文件
        logger.debug(
          LogCategory.VIRTUAL_DIRECTORY,
          '[TagTreeQuery] 读取 SHOW_MISSING_FILES 失败，按默认 true 处理:',
          err
        )
      }

      let query =
        'SELECT COUNT(DISTINCT wf.id) as count FROM workspace_files wf WHERE wf.is_analyzed = 1'
      const params: any[] = []

      if (!showMissing) {
        query += ' AND wf.status = 1'
      }

      if (workspaceDirectoryPath) {
        const sep = path.sep
        const prefix = workspaceDirectoryPath.endsWith(sep)
          ? workspaceDirectoryPath
          : workspaceDirectoryPath + sep
        query += ' AND (wf.path LIKE ? OR wf.path = ?)'
        params.push(`${prefix}%`, workspaceDirectoryPath)
      } else {
        query +=
          " AND wf.workspace_id IN (SELECT workspace_id FROM workspaces WHERE type = 'PRIVATE')"
      }

      const result = this.db.prepare(query).get(...params) as any
      return result?.count || 0
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '[TagTreeQuery] 获取已分析文件数失败:', error)
      return 0
    }
  },

  async getPrivateAnalyzedFilesCount(workspaceDirectoryPath?: string): Promise<number> {
    return this.getAnalyzedFilesCount(workspaceDirectoryPath)
  },

  mapFilesToItems(
    files: any[],
    workspaceDirectoryPath: string | undefined,
    showMissing: boolean
  ): FileItem[] {
    // 【模型 B】标签名 JSON 仅含 code_path：初始化按段译名解析器（locale 取自配置中心，缺省 zh-CN）
    let tagNameLocale = 'zh-CN'
    try {
      tagNameLocale =
        ConfigOrchestrator.getInstance().getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN'
    } catch {
      // 配置中心未就绪按默认中文，normalizeSupportedLocale 内含白名单校验杜绝注入
    }
    const resolveName = buildCodePathNameResolver(this.db, tagNameLocale)
    return files
      .map(file => {
        const currentStatus = file.status ?? 1
        if (!showMissing && currentStatus === 0) {
          return null
        }

        let relativePathPrefix = ''
        if (workspaceDirectoryPath) {
          const sep = path.sep
          const prefix = workspaceDirectoryPath.endsWith(sep)
            ? workspaceDirectoryPath
            : workspaceDirectoryPath + sep
          const fileDir = path.dirname(file.path)
          if (fileDir.startsWith(prefix)) {
            const relativePath = path.relative(workspaceDirectoryPath, fileDir)
            if (relativePath && relativePath !== '.') {
              relativePathPrefix = relativePath
            }
          }
        }

        let tags: string[] = []
        let tagCodes: string[] = []
        if (file.dimension_tags) {
          try {
            const rawList =
              typeof file.dimension_tags === 'string'
                ? JSON.parse(file.dimension_tags)
                : file.dimension_tags
            if (Array.isArray(rawList)) {
              for (const item of rawList) {
                if (!item) continue
                if (typeof item === 'string') {
                  tagCodes.push(item)
                  const canon = getCanonicalConceptName(item)
                  tags.push(canon || item)
                } else {
                  if (item.code) tagCodes.push(item.code)
                  // 模型 B：按 code_path 拆段译名回填 name_path，保持下游消费字段契约不变
                  if (item.code_path && !item.name_path) {
                    const segs = item.code_path.split('/').filter(Boolean)
                    item.name_path = segs.length ? '/' + segs.map((s: string) => resolveName(s)).join('/') : ''
                  }
                  let displayName = item.name
                  // 【模型 B】无物化 name_path：解析 code_path 末段经词表反查展示名
                  if (!displayName && item.code_path) {
                    const parts = item.code_path.split('/').filter(Boolean)
                    const leafCode = parts.length > 0 ? parts[parts.length - 1] : ''
                    displayName = leafCode ? resolveName(leafCode) : ''
                  }
                  if (!displayName && item.code) {
                    displayName = getCanonicalConceptName(item.code) || item.code
                  }
                  if (displayName) tags.push(displayName)
                  // 沿物化路径注入全链路祖先层级名（如 "/文件类型/图片/摄影照片" 注入 "图片"），
                  // 确保按父维度筛选时文件能够精准命中预览树节点
                  // 【模型 B】改为按 code_path 拆段经词表实时译名，禁止取物化 name_path
                  if (item.code_path) {
                    const parts = item.code_path.split('/').filter(Boolean)
                    for (const seg of parts) {
                      const ancestorName = resolveName(seg)
                      if (ancestorName && !tags.includes(ancestorName)) {
                        tags.push(ancestorName)
                      }
                    }
                  }
                }
              }
            }
          } catch (err) {
            // 标签 JSON 脏数据属可容忍降级：该文件按无标签展示
            logger.debug(
              LogCategory.VIRTUAL_DIRECTORY,
              `[TagTreeQuery] 解析 dimension_tags 失败（${file.name}），按空标签处理:`,
              err
            )
          }
        }

        let fusedTags: string[] = []
        if (file.fused_tags) {
          try {
            const rawFused =
              typeof file.fused_tags === 'string' ? JSON.parse(file.fused_tags) : file.fused_tags
            if (Array.isArray(rawFused)) {
              for (const item of rawFused) {
                if (!item) continue
                if (typeof item === 'string') {
                  const canon = getCanonicalConceptName(item)
                  fusedTags.push(canon || item)
                } else {
                  // 模型 B：按 code_path 拆段译名回填 name_path，保持下游消费字段契约不变
                  if (item.code_path && !item.name_path) {
                    const segs = item.code_path.split('/').filter(Boolean)
                    item.name_path = segs.length ? '/' + segs.map((s: string) => resolveName(s)).join('/') : ''
                  }
                  let displayName = item.name
                  // 【模型 B】解析 code_path 末段经词表反查展示名
                  if (!displayName && item.code_path) {
                    const parts = item.code_path.split('/').filter(Boolean)
                    const leafCode = parts.length > 0 ? parts[parts.length - 1] : ''
                    displayName = leafCode ? resolveName(leafCode) : ''
                  }
                  if (!displayName && item.code) {
                    displayName = getCanonicalConceptName(item.code) || item.code
                  }
                  if (displayName) fusedTags.push(displayName)
                }
              }
            }
          } catch {
            fusedTags = []
          }
        }

        return {
          id: file.id.toString(),
          status: currentStatus,
          fileFingerprint: file.file_fingerprint,
          path: file.path,
          parentPath: path.dirname(file.path),
          name: file.name,
          smartName: file.smart_name || undefined,
          size: file.size ?? 0,
          extension: file.extension
            ? file.extension.replace(/^\./, '')
            : file.name
              ? path.extname(file.name).replace(/^\./, '').toLowerCase()
              : '',
          mimeType: file.file_group,
          category: file.file_group,
          createdAt: file.created_at ? new Date(file.created_at) : new Date(),
          modifiedAt: file.modified_at ? new Date(file.modified_at) : new Date(),
          isDirectory: false,
          isAnalyzed: !!file.is_analyzed,
          lastAnalyzedAt: file.last_analyzed_at
            ? new Date(file.last_analyzed_at as string)
            : undefined,
          qualityScore: file.quality_score || undefined,
          description: file.description || undefined,
          thumbnailPath: (() => {
            let resolved = file.thumbnail_path || undefined
            if (resolved && !path.isAbsolute(resolved)) {
              if (workspaceDirectoryPath) {
                resolved = path.join(workspaceDirectoryPath, resolved)
              } else if (file.path) {
                let curDir = path.dirname(file.path)
                while (curDir && curDir !== path.dirname(curDir)) {
                  const testThumb = path.join(curDir, resolved)
                  if (fs.existsSync(testThumb)) {
                    resolved = testThumb
                    break
                  }
                  curDir = path.dirname(curDir)
                }
              }
            }
            return resolved
          })(),
          multimodalContent: file.multimodal_content
            ? decompressText(file.multimodal_content) || undefined
            : undefined,
          relativePathPrefix: relativePathPrefix || undefined,
          author: file.author || undefined,
          language: file.language || undefined,
          tags: Array.isArray(tags) ? tags : [],
          tagCodes: Array.isArray(tagCodes) ? tagCodes : [],
          fusedTags: Array.isArray(fusedTags) ? fusedTags : []
        }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
  }
} satisfies ThisType<TagTreeQuery> & TagTreeQuerySearchEnrich
