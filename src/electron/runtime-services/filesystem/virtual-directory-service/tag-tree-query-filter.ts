/**
 * TagTreeQuery · 文件筛选查询器（partial-class 混入）
 *
 * 拆分自原 TagTreeQuery.ts（只搬不改，逐字节保真）。承载职责：
 * 1. 文件过滤 SQL 条件与参数构建（buildFilterQuery）；
 * 2. 选中标签的物化代码路径归一化（resolveTagCodePaths）与排他性穿透子句构造
 *    （buildTagFilterSubClause / buildUnionFingerprintsCondition，与维度树徽标口径同源）；
 * 3. 分页文件筛选主入口（getFilteredFilesPaged，含拼音/全文检索编排）。
 *
 * 运行时经 Object.assign(TagTreeQuery.prototype, tagTreeQueryFilterMixin) 挂回主类；
 * 类型通过 TagTreeQueryFilter 接口并入 TagTreeQuery，外部导入路径与调用签名零变化。
 */
import path from 'path'
import { FilteredFilesResponse, SelectedTag } from '@firefly/types'
import { LogCategory, logger, isMultiHostDimension } from '@firefly/shared'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'
import { normalizeSupportedLocale } from '@runtime/database/database'
import { PinyinQueryPlanner } from './pinyin-query-expander'
import { escapeLikePrefixWindows, normalizeCodePath } from './tag-tree-query-path-utils'
import { escapeLike } from './tag-tree-query-shared'
import type { TagTreeQuery, FilterFilesParams } from './TagTreeQuery'

export interface TagTreeQueryFilter {
  buildFilterQuery(params: FilterFilesParams): {
    whereClauses: string[]
    queryParams: any[]
    showMissing: boolean
  }

  resolveTagCodePaths(tag: SelectedTag): string[]

  buildTagFilterSubClause(tag: SelectedTag, params: any[]): string | null

  buildUnionFingerprintsCondition(clauses: string[]): string

  getFilteredFilesPaged(params: FilterFilesParams): Promise<FilteredFilesResponse>
}

export const tagTreeQueryFilterMixin = {
  buildFilterQuery(params: FilterFilesParams): {
    whereClauses: string[]
    queryParams: any[]
    showMissing: boolean
  } {
    const {
      selectedTags = [],
      workspaceDirectoryPath,
      searchKeyword,
      virtualDirectoryId,
      unionMode = 'intersection',
      includeUnanalyzed = false
    } = params

    let showMissing = true
    try {
      showMissing = ConfigOrchestrator.getInstance().getValue<boolean>('SHOW_MISSING_FILES') ?? true
    } catch (err) {
      // 配置中心未就绪属可容忍降级：按默认值显示缺失文件
      logger.debug(
        LogCategory.VIRTUAL_DIRECTORY,
        '[TagTreeQuery] 读取 SHOW_MISSING_FILES 失败，按默认 true 处理:',
        err
      )
    }

    // SC-3：改用切片A 预计算列 wf.is_ignored = 0，命中 idx_wf_ws_active_dir / idx_wf_diff_cover，
    //       消除 10 万文件下每次筛选 10 万次 Node↔SQLite UDF 跨界调用。should_ignore_file UDF 仅留作兼容兜底。
    const whereClauses: string[] = ['wf.is_ignored = 0']
    const queryParams: any[] = []

    if (!includeUnanalyzed) {
      whereClauses.unshift('wf.is_analyzed = 1')
    }

    if (!showMissing) {
      whereClauses.push('wf.status = 1')
    }

    if (virtualDirectoryId !== undefined) {
      whereClauses.push(
        'wf.id IN (SELECT file_id FROM virtual_directory_files WHERE virtual_directory_id = ?)'
      )
      queryParams.push(virtualDirectoryId)
    } else if (workspaceDirectoryPath) {
      const sep = path.sep
      const prefix = workspaceDirectoryPath.endsWith(sep)
        ? workspaceDirectoryPath
        : workspaceDirectoryPath + sep
      whereClauses.push('(wf.path LIKE ? OR wf.path = ?)')
      queryParams.push(`${prefix}%`, workspaceDirectoryPath)
    }

    if (searchKeyword && searchKeyword.trim()) {
      const trimmed = searchKeyword.trim()
      // 正排索引架构：查询分类由 PinyinQueryPlanner 承担（删封闭词库逆向展开）
      const plan = PinyinQueryPlanner.getInstance().plan(trimmed)
      // LIKE 通配符转义（人工裁定项②，10-18 既存）：用户查询里的 `%`/`_`/`\` 必须按字面量
      // 匹配，否则 `50%` 会退化成「含 50 的任意后缀」把全库捞回（node:sqlite 实测：无 ESCAPE
      // 时模式 `a%b` 匹配含 `a\b`/`axb`/`a_b`/`a%b` 的全部行）。与 code_path 段同一口径
      // （:88 escapeLike + 子句 ESCAPE '\\'）。
      const patterns = plan.isPinyin
        ? Array.from(new Set([`%${escapeLike(plan.rawKeyword)}%`]))
        : [`%${escapeLike(trimmed)}%`]
      const ftsAvailable = this.isFtsAvailable()

      let ftsClause = ''
      let sanitizedQuery = ''
      if (ftsAvailable) {
        const safeTerms = [trimmed]
          .map(w => {
            const cleaned = w.replace(/[*^()"\\-]/g, ' ').trim()
            return cleaned.length >= 3 ? `"${cleaned}"` : ''
          })
          .filter(Boolean)
        if (safeTerms.length > 0) {
          sanitizedQuery = safeTerms.join(' OR ')
          ftsClause = `(wf.file_fingerprint IS NOT NULL AND wf.file_fingerprint IN (
               SELECT f.file_fingerprint
               FROM files_fts
               JOIN files f ON f.id = files_fts.rowid
               WHERE files_fts MATCH ?
             )) OR `
        }
      }

      // 拼音第 6 路：纯字母查询并入 files_pinyin_fts 子查询（设计文档 §5.2）；
      // 表不可用（旧库/局部 schema）时跳过，与 ftsClause 同样降级到 LIKE 路
      let pinyinClause = ''
      let pinyinMatchExpr = ''
      if (plan.isPinyin && this.isPinyinAvailable()) {
        pinyinMatchExpr = plan.pinyinTokens
          .map(t => (t.length >= 3 ? `"${t}"` : `" ${t} "`))
          .join(' OR ')
        pinyinClause = `(wf.file_fingerprint IS NOT NULL AND wf.file_fingerprint IN (
             SELECT f.file_fingerprint
             FROM files_pinyin_fts
             JOIN files f ON f.id = files_pinyin_fts.rowid
             WHERE files_pinyin_fts MATCH ?
           )) OR `
      }

      // 模型 B 无物化 name_path：标签名模糊搜索改走「单表 tag_aliases(locale) ∪ file_tags_private
      // → 祖先闭包 → 关联表」结构化链路（Issue 02：动态 10 分表已退役）。
      // 先在 tag_aliases 当前 locale 命中展示名对应的 tag_code，再经 tag_path_ancestors
      // （闭包含自身）拿到 path_id 集合，最后用 idx_ftr_path_fp O(log N) 探测命中的 file_fingerprint。
      let safeAliasLocale = 'zh-CN'
      try {
        safeAliasLocale = normalizeSupportedLocale(
          ConfigOrchestrator.getInstance().getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN'
        )
      } catch {
        // 配置中心未就绪按默认中文，normalizeSupportedLocale 内含白名单校验杜绝注入
        safeAliasLocale = normalizeSupportedLocale('zh-CN')
      }
      const patternClauses: string[] = []
      const likeParams: any[] = []
      for (const pattern of patterns) {
        patternClauses.push(`(
          wf.name LIKE ? ESCAPE '\\'
          OR f.smart_name LIKE ? ESCAPE '\\'
          OR f.description LIKE ? ESCAPE '\\'
          OR wf.path LIKE ? ESCAPE '\\'
          OR f.extension LIKE ? ESCAPE '\\'
          OR f.author LIKE ? ESCAPE '\\'
          OR f.language LIKE ? ESCAPE '\\'
          OR f.file_group LIKE ? ESCAPE '\\'
          OR wf.file_fingerprint IN (
            SELECT ftr.file_fingerprint
            FROM file_tag_relations ftr
            JOIN tag_path_ancestors tpa ON tpa.path_id = ftr.path_id
            WHERE tpa.ancestor_code IN (
              SELECT tag_code FROM tag_aliases WHERE locale = ? AND lemma LIKE ? ESCAPE '\\'
              UNION
              SELECT code FROM file_tags_private WHERE name LIKE ? ESCAPE '\\'
            )
          )
        )`)
        // 占位符顺序：8 个外层 LIKE → 1 个 locale → 2 个别名/私有标签 LIKE
        for (let i = 0; i < 8; i++) {
          likeParams.push(pattern)
        }
        likeParams.push(safeAliasLocale, pattern, pattern)
      }

      whereClauses.push(`(${ftsClause}${pinyinClause}${patternClauses.join(' OR ')})`)

      // 占位符顺序必须与 SQL 文本同序：fts MATCH → pinyin MATCH → LIKE 模式们
      if (ftsClause) queryParams.push(sanitizedQuery)
      if (pinyinClause) queryParams.push(pinyinMatchExpr)
      queryParams.push(...likeParams)
    }

    if (selectedTags.length > 0) {
      // 与 getDimensionGroups 共用同一排他性穿透子句构造器（单一事实源，保障 AC-4 徽标/列表口径一致）
      if (unionMode === 'union') {
        const clauses: string[] = []
        for (const tag of selectedTags) {
          const clause = this.buildTagFilterSubClause(tag, queryParams)
          if (clause) clauses.push(clause)
        }
        if (clauses.length > 0) {
          whereClauses.push(this.buildUnionFingerprintsCondition(clauses))
        }
      } else {
        // intersection
        for (const tag of selectedTags) {
          const clause = this.buildTagFilterSubClause(tag, queryParams)
          if (clause) {
            whereClauses.push(`wf.file_fingerprint IN (
              SELECT ftr.file_fingerprint
              FROM file_tag_relations ftr
              WHERE ${clause}
            )`)
          }
        }
      }
    }

    return { whereClauses, queryParams, showMissing }
  },

  resolveTagCodePaths(tag: SelectedTag): string[] {
    const rawPaths = (tag as any).codePaths
    const candidates: unknown[] =
      Array.isArray(rawPaths) && rawPaths.length > 0
        ? rawPaths
        : [(tag as any).codePath ?? (tag as any).code_path ?? '']

    const seen = new Set<string>()
    const paths: string[] = []
    for (const candidate of candidates) {
      if (typeof candidate !== 'string') continue
      const trimmed = candidate.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      paths.push(trimmed)
    }
    return paths
  },

  buildTagFilterSubClause(tag: SelectedTag, params: any[]): string | null {
    const rawPaths = this.resolveTagCodePaths(tag)
    if (rawPaths.length > 0) {
      // 排他性物化路径穿透：严格左前缀排他命中（消除跨介质 tail 后缀误召回与全表扫描）
      const pathClauses = rawPaths
        .map(path => {
          const normPath = normalizeCodePath(path)
          params.push(normPath, escapeLike(normPath))
          // 模型 B：ftr 无 code_path 列，前缀判定下沉到微型字典 tag_paths（数百~数千行），
          // 命中 path_id 后由外层 file_tag_relations 走 idx_ftr_path_fp 探测，消灭 ftr 全表 LIKE 扫。
          return `EXISTS (
            SELECT 1 FROM tag_paths tp
            WHERE tp.path_id = ftr.path_id
              AND (tp.code_path = ? OR tp.code_path LIKE (? || '/%') ESCAPE '\\')
          )`
        })
        .join(' OR ')
      return `(${pathClauses})`
    }

    // Fail-Closed 铁律：跨介质多宿主维度若既无 codePath 又无受控 hostScopeCode，绝对禁止全库泛查！
    // 必须在 params.push 之前拦截并直接返回 '1 = 0'，杜绝 SQL 占位符与绑定参数数量失配 (AGENTS.md §2.9)
    if (!tag.hostScopeCode) {
      const isMultiHostDim = isMultiHostDimension(
        (tag as { dimensionCode?: string }).dimensionCode || tag.dimensionName,
        tag.dimensionId
      )
      if (isMultiHostDim) {
        logger.warn(
          LogCategory.VIRTUAL_DIRECTORY,
          `[TagTreeQuery] 拦截到无路径无宿主的多宿主维度泛查: ${tag.tagValue}`
        )
        return '1 = 0'
      }
    }

    // 降级分支：物化路径缺失时，回退受控 code 精确匹配（含本地/Omni 子孙展开）
    const codes = this.resolveFilterTagCodes(tag)
    if (codes.length === 0) return null
    const placeholders = codes.map(() => '?').join(',')
    params.push(...codes)
    const baseTagClause = `ftr.tag_code IN (${placeholders})`

    // 当标签携带宿主父级受控作用域（如外部细分维度挂载于文档/电子书）时，
    // 追加宿主共现约束，杜绝跨父类同名同Code叶子跨介质误召回（彻底保障 AC-4 树徽标与列表一致性）
    if (tag.hostScopeCode) {
      // 闭包表含自身：单条件 ancestor_code = ? 同时覆盖宿主自身与其任意祖先，
      // 经 ftr_host.path_id 命中 idx_ftr_path_fp，彻底消灭 LIKE '%/x/%' 前导通配全表扫。
      params.push(tag.hostScopeCode)
      return `(${baseTagClause} AND ftr.file_fingerprint IN (
        SELECT ftr_host.file_fingerprint
        FROM file_tag_relations ftr_host
        JOIN tag_path_ancestors tpa_host ON tpa_host.path_id = ftr_host.path_id
        WHERE tpa_host.ancestor_code = ?
      ))`
    }

    return baseTagClause
  },

  buildUnionFingerprintsCondition(clauses: string[]): string {
    const CHUNK_SIZE = 30
    if (clauses.length <= CHUNK_SIZE) {
      return `wf.file_fingerprint IN (
        SELECT ftr.file_fingerprint
        FROM file_tag_relations ftr
        WHERE ${clauses.join(' OR ')}
      )`
    }

    const subSelects: string[] = []
    for (let i = 0; i < clauses.length; i += CHUNK_SIZE) {
      const chunk = clauses.slice(i, i + CHUNK_SIZE)
      subSelects.push(`
        SELECT ftr.file_fingerprint
        FROM file_tag_relations ftr
        WHERE ${chunk.join(' OR ')}
      `)
    }
    return `wf.file_fingerprint IN (
      ${subSelects.join(' UNION ')}
    )`
  },

  async getFilteredFilesPaged(params: FilterFilesParams): Promise<FilteredFilesResponse> {
    const startTime = performance.now()
    let dbQueryTime = 0

    try {
      // 仅当包含已选标签且需要递归展开父子邻接关系时，才异步确保邻接图加载，
      // 避免纯关键词全域搜索或无标签筛选时无脑请求 Omni taxonomy/tree 导致首屏阻塞 2.5s！
      if (params.selectedTags && params.selectedTags.length > 0) {
        await this.ensureFullChildrenMap()
      }

      const {
        sortBy = 'name',
        sortOrder = 'asc',
        page = 1,
        pageSize = 100,
        workspaceDirectoryPath
      } = params

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
      const limit = params.limit !== undefined ? Math.max(0, params.limit) : Math.max(1, pageSize)
      const offset =
        params.offset !== undefined ? Math.max(0, params.offset) : Math.max(0, (page - 1) * limit)

      // 混合检索分支：存在非空搜索词时启用（ADR-0039 Hybrid Search Everything）
      // 编排委托 HybridSearchSession 公开收口：融合排序/去重/分页/回退策略在 Session 单点定义
      const searchKeyword = (params.searchKeyword || '').trim()
      if (searchKeyword) {
        return this.hybridSession.runPaged(
          { ...params, limit, offset },
          searchKeyword,
          this.buildFilterQuery({ ...params, searchKeyword: undefined })
        )
      }

      // 1. 查询符合条件的总数
      const countQuery = `
        SELECT COUNT(DISTINCT wf.id) as total
        FROM workspace_files wf
        LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
        LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
        WHERE ${whereClauses.join(' AND ')}
      `
      const countStart = performance.now()
      const countResult = this.db.prepare(countQuery).get(...queryParams) as any
      dbQueryTime += performance.now() - countStart
      const total = countResult?.total || 0

      if (total === 0) {
        return {
          items: [],
          total: 0,
          performance: {
            dbQueryTime: Math.round(dbQueryTime * 100) / 100,
            totalTime: Math.round((performance.now() - startTime) * 100) / 100
          }
        }
      }

      // 2. 分页查询详细文件记录
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
        LIMIT ? OFFSET ?
      `
      const selectStart = performance.now()
      const files = this.db.prepare(selectQuery).all(...queryParams, limit, offset) as any[]
      dbQueryTime += performance.now() - selectStart

      const items = this.mapFilesToItems(files, workspaceDirectoryPath, showMissing)

      return {
        items,
        total,
        performance: {
          dbQueryTime: Math.round(dbQueryTime * 100) / 100,
          totalTime: Math.round((performance.now() - startTime) * 100) / 100
        }
      }
    } catch (err: unknown) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '[TagTreeQuery] 分页过滤文件失败:', err)
      return { items: [], total: 0 }
    }
  }
} satisfies ThisType<TagTreeQuery> & TagTreeQueryFilter
