import Database from 'better-sqlite3'
import path from 'node:path'
import {
  DimensionGroup,
  DimensionGroupsResponse,
  DimensionTag,
  FileItem,
  FilteredFilesResponse,
  GetDimensionGroupsOptions,
  SelectedTag,
  VirtualDirectoryFilter
} from '@firefly/types'
import { LogCategory, logger, extractSnippet, normalizeForCache } from '@firefly/shared'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'
import { loadIgnoreRules, shouldIgnoreFile } from '../../analysis/analysis-ignore-service'
import { DAGMaterializer } from './DAGMaterializer'
import { taxonomyAliasCache } from '../../../services/taxonomy-alias-cache'
import { decompressText } from '../../../utils/text-compressor'
import {
  HybridRankedCandidate,
  HybridSearchArbiter,
  HYBRID_SEARCH_POOL_SIZE,
  slicePage,
  splitPassages
} from './HybridSearchArbiter'

export interface FilterFilesParams {
  selectedTags?: SelectedTag[]
  sortBy?: VirtualDirectoryFilter['sortBy']
  sortOrder?: 'asc' | 'desc'
  page?: number
  pageSize?: number
  limit?: number
  offset?: number
  workspaceDirectoryPath?: string
  searchKeyword?: string
  virtualDirectoryId?: number
  unionMode?: 'union' | 'intersection'
  includeUnanalyzed?: boolean
}

/** 混合检索分页引用：已分析候选 / 未分析 FS 命中 */
type HybridPageRef =
  | { kind: 'analyzed'; fileFingerprint: string; hasLiteral: boolean }
  | { kind: 'unanalyzed'; path: string; name: string; fileFingerprint?: string }

/**
 * TagTreeQuery 深模块
 * 
 * 核心职责：
 * 1. 利用 SQLite 递归公共表表达式（Recursive CTE）实现标签树、后代节点与祖先链的瞬时检索；
 * 2. 高效下推文件与复合标签的筛选计算，杜绝在 Node.js 内存中递归拼装扩展名映射；
 * 3. 彻底消除魔法数字区间（102..117），全量依托 file_tags 树与 file_tag_relations 自然主键关联。
 */
export class TagTreeQuery {
  private dagMaterializer: DAGMaterializer
  private hybridArbiter: HybridSearchArbiter

  constructor(private db: Database.Database, hybridArbiter?: HybridSearchArbiter) {
    this.ensureSqlFunctions()
    this.dagMaterializer = new DAGMaterializer(db)
    this.hybridArbiter = hybridArbiter ?? new HybridSearchArbiter(db)
  }

  private ensureSqlFunctions(): void {
    try {
      let ignoreRulesCache: any[] | null = null
      let lastFetched = 0
      const CACHE_TTL = 5000 // 5 seconds TTL

      this.db.function('should_ignore_file', (filePath: string, fileName: string) => {
        try {
          const now = Date.now()
          if (!ignoreRulesCache || now - lastFetched > CACHE_TTL) {
            ignoreRulesCache = loadIgnoreRules() || []
            lastFetched = now
          }
          return shouldIgnoreFile(filePath, fileName, ignoreRulesCache) ? 1 : 0
        } catch {
          return 0
        }
      })
    } catch {
      // 忽略已注册或 Mock 数据库环境中的错误
    }
  }

  private _ftsAvailable: boolean | null = null
  private isFtsAvailable(): boolean {
    if (this._ftsAvailable !== null) return this._ftsAvailable
    try {
      const row = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='files_fts'")
        .get()
      this._ftsAvailable = !!row
    } catch {
      this._ftsAvailable = false
    }
    return this._ftsAvailable
  }

  /**
   * 查找指定标签值（或代码）自身及其所有后代标签的 code 集合
   *
   * 两步查询范式（#622）：
   * Step 1: 在 file_tags 小表用 materialized_paths 前缀过滤得到 codes（json_each 仅扫几千行）
   * Step 2: 调用方用 codes 走 idx_file_tag_relations_tag 索引查大表
   *
   * 彻底根除对百万级 file_tag_relations 执行 json_each / 递归 CTE LIKE 全扫的性能灾难。
   */
  public getDescendantTagCodes(tagValueOrCode: string): string[] {
    try {
      // 优先：直接命中 code 或 name，取其物化路径前缀做子树召回
      const anchor = this.db
        .prepare(
          `SELECT code, name, materialized_paths FROM file_tags
           WHERE code = ? OR name = ?
           LIMIT 1`
        )
        .get(tagValueOrCode, tagValueOrCode) as
        | { code: string; name: string; materialized_paths: string }
        | undefined

      if (!anchor) {
        // 未命中标签树节点：原样返回，交由调用方当字面量 code 使用
        return [tagValueOrCode]
      }

      const paths = DAGMaterializer.parsePaths(anchor.materialized_paths)

      // 物化路径缺失时，尝试现场修复一次再查
      if (paths.length === 0) {
        this.dagMaterializer.materializeTag(anchor.code)
        const repaired = this.db
          .prepare('SELECT materialized_paths FROM file_tags WHERE code = ?')
          .pluck()
          .get(anchor.code) as string | undefined
        const repairedPaths = DAGMaterializer.parsePaths(repaired)
        if (repairedPaths.length > 0) {
          return this.collectSubtreeCodes(repairedPaths)
        }
      } else {
        return this.collectSubtreeCodes(paths)
      }

      // 兜底：无物化路径时返回节点自身
      return [anchor.code]
    } catch (err) {
      logger.warn(LogCategory.VIRTUAL_DIRECTORY, `[TagTreeQuery] 子树召回失败: ${tagValueOrCode}`, err)
      return [tagValueOrCode]
    }
  }

  /**
   * 对给定物化路径集合执行前缀扫描，收集子树全部 codes
   */
  private collectSubtreeCodes(
    paths: Array<{ code_path: string; name_path: string }>
  ): string[] {
    const codeSet = new Set<string>()

    for (const p of paths) {
      // Step 1：file_tags 小表 json_each 前缀过滤（< 1ms）
      const rows = this.db
        .prepare(
          `SELECT code FROM file_tags
           WHERE EXISTS (
             SELECT 1 FROM json_each(materialized_paths)
             WHERE json_extract(value, '$.code_path') = ?
                OR json_extract(value, '$.code_path') LIKE ?
           )`
        )
        .pluck()
        .all(p.code_path, `${p.code_path}/%`) as string[]

      for (const c of rows) {
        codeSet.add(c)
      }
    }

    return Array.from(codeSet)
  }

  /**
   * 获取维度组导航树（含命中文件计数）
   * ADR-0038 / Issue #682：受控分类树由 Omni taxonomy/tree 提供，本地仅保留 expanded/user 动态标签
   */
  async getDimensionGroups(
    options?: GetDimensionGroupsOptions | string,
    language?: string
  ): Promise<DimensionGroupsResponse> {
    const startTime = performance.now()
    let dbQueryTime = 0

    const opts: GetDimensionGroupsOptions =
      typeof options === 'string'
        ? { workspaceDirectoryPath: options, language }
        : options || {}

    const {
      workspaceDirectoryPath,
      excludeExtensionDimension = false,
      removeEmptyTags = false,
      selectedTags = [],
      unionMode = 'intersection',
      includeAllPresetTags = false
    } = opts

    try {
      const locale = opts.language || language || 'zh-CN'
      // 启动/切换语言时装载 Omni 别名与分类树内存总线
      if (!taxonomyAliasCache.isLoaded() || taxonomyAliasCache.getLocale() !== locale) {
        await taxonomyAliasCache.load(locale)
      }

      let showMissing = true
      try {
        showMissing = ConfigOrchestrator.getInstance().getValue<boolean>('SHOW_MISSING_FILES') ?? true
      } catch {}

      // 1. 获取所有维度根节点（本地动态标签：expanded/user；受控根节点来自 Omni 树）
      const dbStart = performance.now()
      let dimensionRoots = this.db
        .prepare(`
          SELECT code, name, depth, file_groups, meta
          FROM file_tags
          WHERE depth = 0 OR json_extract(meta, '$.isDimension') = 1
          ORDER BY code ASC
        `)
        .all() as Array<{
          code: string
          name: string
          depth: number
          file_groups: string | null
          meta: string
        }>
      dbQueryTime += performance.now() - dbStart

      if (excludeExtensionDimension) {
        dimensionRoots = dimensionRoots.filter(d => {
          return d.code !== 'dim.17' && !/扩展名|Extension/i.test(d.name)
        })
      }

      // 2. 获取所有非根标签节点（#625：透出 code/parent_codes/meta 供前端纯树形状态机消费）
      const tagRows = this.db
        .prepare(`
          SELECT code, name, parent_codes, depth, file_groups, meta
          FROM file_tags
          WHERE depth > 0 AND (json_extract(meta, '$.isDimension') IS NULL OR json_extract(meta, '$.isDimension') = 0)
          ORDER BY depth ASC, code ASC
        `)
        .all() as Array<{
          code: string
          name: string
          parent_codes: string
          depth: number
          file_groups: string | null
          meta: string
        }>

      // 3. 构建当前工作区/选区内的有效文件指纹集
      let baseWhere = 'WHERE wf.is_analyzed = 1'
      const baseParams: any[] = []
      if (!showMissing) {
        baseWhere += ' AND wf.status = 1'
      }

      let joinVirtualDir = ''
      if (opts.virtualDirectoryId !== undefined) {
        joinVirtualDir = 'JOIN virtual_directory_files vdf ON vdf.file_id = wf.id'
        baseWhere += ' AND vdf.virtual_directory_id = ?'
        baseParams.push(opts.virtualDirectoryId)
      } else if (workspaceDirectoryPath) {
        const sep = path.sep
        const prefix = workspaceDirectoryPath.endsWith(sep)
          ? workspaceDirectoryPath
          : workspaceDirectoryPath + sep
        baseWhere += ' AND (wf.path LIKE ? OR wf.path = ?)'
        baseParams.push(`${prefix}%`, workspaceDirectoryPath)
      }

      // 如果有 selectedTags，筛选出在当前标签过滤下仍有效的文件指纹
      let filteredFingerprintsSql = `
        SELECT DISTINCT wf.file_fingerprint
        FROM workspace_files wf
        ${joinVirtualDir}
        ${baseWhere}
      `
      const filteredFingerprintsParams = [...baseParams]

      if (selectedTags.length > 0) {
        if (unionMode === 'union') {
          const allCodes = new Set<string>()
          for (const st of selectedTags) {
            const codes = this.getDescendantTagCodes(st.tagValue)
            codes.forEach(c => allCodes.add(c))
          }
          const codeList = Array.from(allCodes)
          if (codeList.length > 0) {
            const placeholders = codeList.map(() => '?').join(',')
            filteredFingerprintsSql += `
              AND wf.file_fingerprint IN (
                SELECT ftr.file_fingerprint
                FROM file_tag_relations ftr
                WHERE ftr.tag_code IN (${placeholders})
              )
            `
            filteredFingerprintsParams.push(...codeList)
          }
        } else {
          // intersection
          for (const st of selectedTags) {
            const codes = this.getDescendantTagCodes(st.tagValue)
            if (codes.length > 0) {
              const placeholders = codes.map(() => '?').join(',')
              filteredFingerprintsSql += `
                AND wf.file_fingerprint IN (
                  SELECT ftr.file_fingerprint
                  FROM file_tag_relations ftr
                  WHERE ftr.tag_code IN (${placeholders})
                )
              `
              filteredFingerprintsParams.push(...codes)
            }
          }
        }
      }

      // 4. 统计在有效文件集合下，每个 (tag_code, parent_tag_code) 的文件命中数（V4 联合统计）
      const countQuery = `
        SELECT ftr.tag_code, ftr.parent_tag_code, COUNT(DISTINCT ftr.file_fingerprint) as count
        FROM file_tag_relations ftr
        WHERE ftr.file_fingerprint IN (${filteredFingerprintsSql})
        GROUP BY ftr.tag_code, ftr.parent_tag_code
      `
      const countStartTime = performance.now()
      const countRows = this.db.prepare(countQuery).all(...filteredFingerprintsParams) as Array<{
        tag_code: string
        parent_tag_code: string
        count: number
      }>
      dbQueryTime += performance.now() - countStartTime

      const tagCountMap = new Map<string, number>()
      const tagParentCountMap = new Map<string, number>()
      for (const row of countRows) {
        tagCountMap.set(row.tag_code, (tagCountMap.get(row.tag_code) || 0) + row.count)
        tagParentCountMap.set(`${row.tag_code}::${row.parent_tag_code}`, row.count)
      }

      // 5. 按照维度归类本地动态标签并组织树形结构
      const groups: DimensionGroup[] = []
      const seenDimCodes = new Set<string>()
      const aliasResolver = (code: string, fallbackName?: string) =>
        taxonomyAliasCache.resolve(code) || fallbackName || code

      for (const root of dimensionRoots) {
        const dimCode = root.code
        seenDimCodes.add(dimCode)
        let dimMeta: any = {}
        try {
          dimMeta = JSON.parse(root.meta || '{}')
        } catch {}

        // 匹配该维度下的直属子标签
        const directChildren = tagRows.filter(t => {
          let parentCodes: string[] = []
          try {
            parentCodes = JSON.parse(t.parent_codes || '[]')
          } catch {}
          return parentCodes.includes(dimCode) || t.code.startsWith(`${dimCode}.`)
        })

        const dimensionTags: DimensionTag[] = []

        for (const child of directChildren) {
          // #625：解析子标签的 meta 与 parent_codes，透出给前端纯树形状态机
          let childMeta: any = {}
          try {
            childMeta = JSON.parse(child.meta || '{}')
          } catch {}
          let childParentCodes: string[] = []
          try {
            childParentCodes = JSON.parse(child.parent_codes || '[]')
          } catch {}
          const immediateParentCode = childParentCodes[0] || dimCode

          // 汇总该标签自身及后代标签的代码（优先匹配当前父级上下文）
          const familyCodes = this.getDescendantTagCodes(child.code)
          let aggregatedCount = 0
          for (const fc of familyCodes) {
            // 优先检查精确父级绑定的计数
            const parentSpecific = tagParentCountMap.get(`${fc}::${immediateParentCode}`)
            if (parentSpecific !== undefined) {
              aggregatedCount += parentSpecific
            } else {
              aggregatedCount += tagCountMap.get(fc) || 0
            }
          }

          if (removeEmptyTags && !includeAllPresetTags && aggregatedCount === 0) {
            continue
          }

          dimensionTags.push({
            dimensionId: dimCode as any,
            dimensionName: aliasResolver(root.code, root.name),
            tagValue: aliasResolver(child.code, child.name),
            fileCount: aggregatedCount,
            level: child.depth || 1,
            code: child.code,
            parentCode: childParentCodes[0] || dimCode,
            isMultiSelect: childMeta?.isMultiSelect === true
          })
        }

        // 提取数值型 ID 用于向前兼容
        const numIdMatch = dimCode.match(/^dim\.(\d+)$/)
        const legacyNumericId = numIdMatch ? parseInt(numIdMatch[1], 10) : groups.length + 1

        groups.push({
          id: legacyNumericId as any,
          name: aliasResolver(root.code, root.name),
          level: root.depth,
          tags: dimensionTags,
          code: dimCode,
          isMultiSelect: dimMeta?.isMultiSelect === true,
          metadata: dimMeta
        })
      }

      // 6. 合并 Omni 受控分类树（builtin / omw 不再入库主库）
      const omniGroups = taxonomyAliasCache.toDimensionGroups(tagCountMap)
      for (const og of omniGroups) {
        const code = og.code
        if (!code || seenDimCodes.has(code)) continue
        seenDimCodes.add(code)
        let tags = og.tags || []
        if (excludeExtensionDimension) {
          tags = tags.filter(t => !/扩展名|Extension/i.test(t.tagValue) && t.code !== 'dim.17')
        }
        if (removeEmptyTags && !includeAllPresetTags) {
          tags = tags.filter(t => t.fileCount > 0)
        }
        groups.push({ ...og, tags })
      }

      return {
        groups,
        performance: {
          dbQueryTime: Math.round(dbQueryTime * 100) / 100,
          totalTime: Math.round((performance.now() - startTime) * 100) / 100
        }
      }
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '[TagTreeQuery] 获取维度组失败:', error)
      return { groups: [] }
    }
  }

  /**
   * 构建文件过滤 SQL 查询条件与参数
   */
  private buildFilterQuery(params: FilterFilesParams): {
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
    } catch {}

    const whereClauses: string[] = ['should_ignore_file(wf.path, wf.name) = 0']
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
      const likePattern = `%${trimmed}%`
      const ftsAvailable = this.isFtsAvailable()
      const ftsClause = ftsAvailable
        ? `(wf.file_fingerprint IS NOT NULL AND wf.file_fingerprint IN (
             SELECT f.file_fingerprint
             FROM files_fts
             JOIN files f ON f.rowid = files_fts.rowid
             WHERE files_fts MATCH ?
           )) OR `
        : ''
      const sanitizedQuery = trimmed.replace(/["*^()]/g, ' ').trim() || trimmed

      whereClauses.push(`(
        ${ftsClause}wf.name LIKE ?
        OR f.smart_name LIKE ?
        OR f.description LIKE ?
        OR wf.path LIKE ?
        OR f.extension LIKE ?
        OR f.author LIKE ?
        OR f.language LIKE ?
        OR f.file_group LIKE ?
        OR wf.file_fingerprint IN (
          SELECT ftr.file_fingerprint
          FROM file_tag_relations ftr
          JOIN file_tags ft ON ft.code = ftr.tag_code
          WHERE ft.name LIKE ?
        )
      )`)

      if (ftsAvailable) {
        queryParams.push(
          sanitizedQuery,
          likePattern,
          likePattern,
          likePattern,
          likePattern,
          likePattern,
          likePattern,
          likePattern,
          likePattern,
          likePattern
        )
      } else {
        queryParams.push(
          likePattern,
          likePattern,
          likePattern,
          likePattern,
          likePattern,
          likePattern,
          likePattern,
          likePattern,
          likePattern
        )
      }
    }

    if (selectedTags.length > 0) {
      if (unionMode === 'union') {
        const clauses: string[] = []
        for (const tag of selectedTags) {
          const codes = this.getDescendantTagCodes(tag.code || tag.tagValue)
          if (codes.length > 0) {
            const placeholders = codes.map(() => '?').join(',')
            if (tag.parentTagCode) {
              clauses.push(`(ftr.tag_code IN (${placeholders}) AND ftr.parent_tag_code = ?)`)
              queryParams.push(...codes, tag.parentTagCode)
            } else {
              clauses.push(`ftr.tag_code IN (${placeholders})`)
              queryParams.push(...codes)
            }
          }
        }
        if (clauses.length > 0) {
          whereClauses.push(`wf.file_fingerprint IN (
            SELECT ftr.file_fingerprint
            FROM file_tag_relations ftr
            WHERE ${clauses.join(' OR ')}
          )`)
        }
      } else {
        // intersection
        for (const tag of selectedTags) {
          const codes = this.getDescendantTagCodes(tag.code || tag.tagValue)
          if (codes.length > 0) {
            const placeholders = codes.map(() => '?').join(',')
            if (tag.parentTagCode) {
              whereClauses.push(`wf.file_fingerprint IN (
                SELECT ftr.file_fingerprint
                FROM file_tag_relations ftr
                WHERE ftr.tag_code IN (${placeholders}) AND ftr.parent_tag_code = ?
              )`)
              queryParams.push(...codes, tag.parentTagCode)
            } else {
              whereClauses.push(`wf.file_fingerprint IN (
                SELECT ftr.file_fingerprint
                FROM file_tag_relations ftr
                WHERE ftr.tag_code IN (${placeholders})
              )`)
              queryParams.push(...codes)
            }
          }
        }
      }
    }

    return { whereClauses, queryParams, showMissing }
  }

  /**
   * 分页获取过滤后的文件列表
   */
  async getFilteredFilesPaged(params: FilterFilesParams): Promise<FilteredFilesResponse> {
    const startTime = performance.now()
    let dbQueryTime = 0

    try {
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
      const offset = params.offset !== undefined ? Math.max(0, params.offset) : Math.max(0, (page - 1) * limit)

      // 混合检索分支：存在非空搜索词时启用（ADR-0039 Hybrid Search Everything）
      // 本地 FTS5 BM25 + Omni 向量语义 + 文件名提升加权 RRF 融合，真实目录模式追加 FS 未分析命中
      const searchKeyword = (params.searchKeyword || '').trim()
      if (searchKeyword) {
        return this.getFilteredFilesPagedHybrid({ ...params, limit, offset }, searchKeyword)
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
          COALESCE(f.description, fc.description) as description,
          fc.multimodal_content,
          (
            SELECT json_group_array(ft.name)
            FROM file_tag_relations ftr
            JOIN file_tags ft ON ft.code = ftr.tag_code
            WHERE ftr.file_fingerprint = wf.file_fingerprint
          ) as dimension_tags
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
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '[TagTreeQuery] 分页过滤文件失败:', error)
      return { items: [], total: 0 }
    }
  }

  /**
   * 混合检索分页（ADR-0039 / Ticket-2）：
   * 1. 委托 HybridSearchArbiter 融合 FTS5 BM25 + Omni 向量 + 文件名提升，
   *    真实目录模式下追加 FS 实时未分析命中；
   * 2. 按融合候选的统一顺序分页；当前页已分析候选补充富正文摘要（字面高亮 / 段落级语义对齐）；
   * 3. 未分析命中由 FS 返回属性直接合成 FileItem（matchType = 'unanalyzed'）。
   * 任一步骤异常均回退为去除搜索词的常规分页，避免搜索功能受损。
   */
  private async getFilteredFilesPagedHybrid(
    params: FilterFilesParams,
    keyword: string
  ): Promise<FilteredFilesResponse> {
    const startTime = performance.now()
    let dbQueryTime = 0
    try {
      const workspaceDirectoryPath = params.workspaceDirectoryPath
      // 基础过滤条件（不含 searchKeyword 自身的 LIKE 条件，交由仲裁器在各检索模型上叠加）
      const { whereClauses, queryParams, showMissing } = this.buildFilterQuery({
        ...params,
        searchKeyword: undefined
      })

      const limit = params.limit !== undefined ? Math.max(0, params.limit) : Math.max(1, params.pageSize ?? 100)
      const offset = params.offset !== undefined ? Math.max(0, params.offset) : Math.max(0, ((params.page ?? 1) - 1) * limit)

      // 1. 仲裁融合（FTS + 向量 + 文件名）
      const pool = await this.hybridArbiter.searchHybrid({
        keyword,
        whereClauses,
        queryParams,
        workspaceDirectoryPath,
        poolSize: HYBRID_SEARCH_POOL_SIZE
      })

      if (pool.failures.fts || pool.failures.vector || pool.failures.fs) {
        logger.debug(
          LogCategory.VIRTUAL_DIRECTORY,
          `[TagTreeQuery] 混合检索部分降级: fts=${pool.failures.fts}, vector=${pool.failures.vector}, fs=${pool.failures.fs}`
        )
      }

      // 2. 统一有序引用（已分析候选在前，未分析命中追加尾部）：
      //    - 先取仲裁融合的高精度候选；
      //    - 再用旧版 LIKE 全字段查询（buildFilterQuery 含 searchKeyword）作为补充候选源，
      //      保留路径/作者/语言/描述/标签等基础字段命中与 includeUnanalyzed 未分析行（Hybrid Search Everything 兼容层）；
      //    - FS 实时未分析命中追加最后。
      const seenFp = new Set<string>()
      const seenUnanalyzedPath = new Set<string>()
      const fullPool: HybridPageRef[] = []
      // 2.1 仲裁候选（已分析）
      for (const c of pool.candidates) {
        if (!c.fileFingerprint) continue
        if (seenFp.has(c.fileFingerprint)) continue
        seenFp.add(c.fileFingerprint)
        fullPool.push({
          kind: 'analyzed',
          fileFingerprint: c.fileFingerprint,
          hasLiteral: c.hasLiteral
        })
      }
      // 2.2 旧 LIKE 全字段语义补充候选（已分析 + includeUnanalyzed 未分析行）
      const legacyRefs = this.fetchLegacySearchRefs(params)
      for (const ref of legacyRefs.analyzed) {
        if (!ref.fileFingerprint || seenFp.has(ref.fileFingerprint)) continue
        seenFp.add(ref.fileFingerprint)
        fullPool.push(ref)
      }
      for (const ref of legacyRefs.unanalyzed) {
        if (ref.fileFingerprint && seenFp.has(ref.fileFingerprint)) continue
        const key = normalizeForCache(ref.path)
        if (seenUnanalyzedPath.has(key)) continue
        seenUnanalyzedPath.add(key)
        fullPool.push(ref)
      }
      // 2.3 FS 实时未分析命中（真实目录模式）
      for (const h of pool.unanalyzedHits) {
        if (h.fileFingerprint && seenFp.has(h.fileFingerprint)) continue
        const key = normalizeForCache(h.path)
        if (seenUnanalyzedPath.has(key)) continue
        seenUnanalyzedPath.add(key)
        fullPool.push({
          kind: 'unanalyzed',
          path: h.path,
          name: h.name,
          fileFingerprint: h.fileFingerprint
        })
      }
      const { items: pageRefs, total } = slicePage(fullPool, limit, offset)

      if (pageRefs.length === 0) {
        return {
          items: [],
          total,
          performance: {
            dbQueryTime: Math.round(dbQueryTime * 100) / 100,
            totalTime: Math.round((performance.now() - startTime) * 100) / 100
          }
        }
      }

      // 3. 已分析候选：加载数据库行与正文，供摘要丰富
      const candidateByFp = new Map<string, HybridRankedCandidate>(
        pool.candidates.map(c => [c.fileFingerprint, c])
      )
      const analyzedRefs = pageRefs.filter(
        (r): r is Extract<HybridPageRef, { kind: 'analyzed' }> => r.kind === 'analyzed'
      )
      const analyzedFps = analyzedRefs.map(r => r.fileFingerprint)

      const rowStart = performance.now()
      const rows = analyzedFps.length ? this.fetchRowsByFingerprints(analyzedFps) : []
      dbQueryTime += performance.now() - rowStart

      const baseItems = new Map<string, FileItem>()
      for (const item of this.mapFilesToItems(rows, workspaceDirectoryPath, showMissing)) {
        if (item.fileFingerprint) baseItems.set(item.fileFingerprint, item)
      }

      const contentStart = performance.now()
      const contentsByFp = analyzedFps.length
        ? this.fetchContentsForSearch(analyzedFps)
        : new Map<string, string>()
      dbQueryTime += performance.now() - contentStart

      const enrichment = await this.enrichSearchPage(keyword, analyzedRefs, candidateByFp, contentsByFp)

      // 4. 保持融合顺序组装最终条目
      const items: FileItem[] = []
      for (const ref of pageRefs) {
        if (ref.kind === 'analyzed') {
          const base = baseItems.get(ref.fileFingerprint)
          if (!base) continue
          const e = enrichment.get(ref.fileFingerprint)
          items.push({
            ...base,
            snippet: e?.snippet,
            matchType: e?.matchType ?? (ref.hasLiteral ? 'fuzzy' : 'semantic'),
            similarity: e?.similarity
          })
        } else {
          items.push(this.synthesizeUnanalyzedItem(ref, workspaceDirectoryPath))
        }
      }

      return {
        items,
        total,
        performance: {
          dbQueryTime: Math.round(dbQueryTime * 100) / 100,
          totalTime: Math.round((performance.now() - startTime) * 100) / 100
        }
      }
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '[TagTreeQuery] 混合检索分页失败，回退常规检索:', error)
      // 回退：去除搜索词走常规分页，保证搜索异常时功能可用
      return this.getFilteredFilesPaged({ ...params, searchKeyword: undefined })
    }
  }

  /**
   * 为当前页已分析候选批量生成富正文摘要：
   * - 字面候选（FTS 命中或文件名全子串）优先走 extractSnippet 高亮；
   * - 无字面命中的候选走段落级语义对齐（matchPassages）；
   * - 语义对齐缺失/失败时降级为语义首段摘要。
   */
  private async enrichSearchPage(
    keyword: string,
    analyzedRefs: Array<Extract<HybridPageRef, { kind: 'analyzed' }>>,
    candidateByFp: Map<string, HybridRankedCandidate>,
    contentsByFp: Map<string, string>
  ): Promise<
    Map<string, { snippet?: string; matchType: 'exact' | 'fuzzy' | 'semantic'; similarity?: number }>
  > {
    const result = new Map<
      string,
      { snippet?: string; matchType: 'exact' | 'fuzzy' | 'semantic'; similarity?: number }
    >()

    // 字面候选直接高亮
    const semanticBatch: Array<{ fileFingerprint: string; text: string }> = []
    for (const ref of analyzedRefs) {
      const cand = candidateByFp.get(ref.fileFingerprint)
      const text = contentsByFp.get(ref.fileFingerprint) ?? ''
      if (cand?.hasLiteral) {
        const highlight = extractSnippet(text, keyword, { escapeHtml: false })
        if (highlight.hitCount > 0) {
          result.set(ref.fileFingerprint, {
            snippet: highlight.snippet,
            matchType: highlight.matchType
          })
          continue
        }
      }
      semanticBatch.push({ fileFingerprint: ref.fileFingerprint, text })
    }

    // 无字面命中 → 段落级语义对齐
    if (semanticBatch.length > 0) {
      const alignItems: Array<{ fileFingerprint: string; passages: string[] }> = []
      for (const b of semanticBatch) {
        alignItems.push({ fileFingerprint: b.fileFingerprint, passages: splitPassages(b.text) })
      }
      const alignMap = await this.hybridArbiter.alignPassages(
        keyword,
        alignItems.map(a => ({ fileFingerprint: a.fileFingerprint, passages: a.passages }))
      )
      for (const b of semanticBatch) {
        const cand = candidateByFp.get(b.fileFingerprint)
        const match = alignMap[b.fileFingerprint]
        if (match && match.bestPassage) {
          result.set(b.fileFingerprint, {
            snippet: match.bestPassage,
            matchType: 'semantic',
            similarity: Math.round(match.similarity * 100) / 100
          })
        } else {
          // 语义对齐缺失/失败 → 语义首段摘要 + 向量相似度
          const highlight = extractSnippet(b.text, keyword, { escapeHtml: false })
          result.set(b.fileFingerprint, {
            snippet: highlight.snippet || undefined,
            matchType: 'semantic',
            similarity: cand?.vecScore
          })
        }
      }
    }

    return result
  }

  /**
   * 按指纹批量加载文件明细行（用于混合检索当前页已分析候选）
   */
  private fetchRowsByFingerprints(fileFingerprints: string[]): any[] {
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
        COALESCE(f.description, fc.description) as description,
        fc.multimodal_content,
        (
          SELECT json_group_array(ft.name)
          FROM file_tag_relations ftr
          JOIN file_tags ft ON ft.code = ftr.tag_code
          WHERE ftr.file_fingerprint = wf.file_fingerprint
        ) as dimension_tags
      FROM workspace_files wf
      LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
      LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
      WHERE wf.file_fingerprint IN (${placeholders})
    `
    return this.db.prepare(sql).all(...fileFingerprints) as any[]
  }

  /**
   * 批量加载 file_contents 四类正文列并解压拼接，供摘要提取使用
   */
  private fetchContentsForSearch(fileFingerprints: string[]): Map<string, string> {
    const map = new Map<string, string>()
    if (fileFingerprints.length === 0) return map
    const placeholders = fileFingerprints.map(() => '?').join(',')
    try {
      const rows = this.db
        .prepare(`
          SELECT file_fingerprint, content, multimodal_content, ocr, lrc
          FROM file_contents
          WHERE file_fingerprint IN (${placeholders})
        `)
        .all(...fileFingerprints) as Array<{
        file_fingerprint: string
        content: string | Buffer | null
        multimodal_content: string | Buffer | null
        ocr: string | Buffer | null
        lrc: string | Buffer | null
      }>
      for (const r of rows) {
        const parts: string[] = []
        for (const col of [r.content, r.multimodal_content, r.ocr, r.lrc]) {
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
  }

  /**
   * 由 FS 未分析命中合成 FileItem（仅含目录名、路径等基础属性）
   */
  private synthesizeUnanalyzedItem(
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
      if (fileDir.startsWith(prefix)) {
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
  }

  /**
   * 旧版 LIKE 全字段语义补充候选源（Hybrid Search Everything 兼容层）：
   * 仲裁融合只覆盖 FTS5 BM25 / 向量 / 文件名提升，为保留路径、作者、语言、
   * 描述、扩展名（f.extension）、分类（f.file_group）等基础字段以及标签名的
   * LIKE 命中（含 includeUnanalyzed 未分析行），此处复用 buildFilterQuery
   * （保留 searchKeyword 自身的 LIKE 条件）作为补充候选源，
   * 按 sortBy 排序、单源容量封顶 HYBRID_SEARCH_POOL_SIZE。
   * 任一步骤异常（如短关键词触发了 trigram FTS 语法错误）仅降级为空补充集，
   * 融合池仍保留仲裁结果，不影响搜索可用性。
   */
  private fetchLegacySearchRefs(
    params: FilterFilesParams
  ): {
    analyzed: Array<Extract<HybridPageRef, { kind: 'analyzed' }>>
    unanalyzed: Array<Extract<HybridPageRef, { kind: 'unanalyzed' }>>
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
            analyzed.push({ kind: 'analyzed', fileFingerprint: r.file_fingerprint, hasLiteral: true })
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
      logger.warn(
        LogCategory.VIRTUAL_DIRECTORY,
        '[TagTreeQuery] 旧 LIKE 全字段补充候选查询失败，仅保留仲裁融合结果:',
        msg
      )
    }
    return { analyzed, unanalyzed }
  }

  /**
   * 全量获取过滤后的文件列表
   */
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
          COALESCE(f.description, fc.description) as description,
          fc.multimodal_content,
          (
            SELECT json_group_array(ft.name)
            FROM file_tag_relations ftr
            JOIN file_tags ft ON ft.code = ftr.tag_code
            WHERE ftr.file_fingerprint = wf.file_fingerprint
          ) as dimension_tags
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
  }

  /**
   * 获取已分析文件总数
   *
   * 注意：本方法统计的是「已 AI 分析」的文件总数（is_analyzed = 1）。
   * 真实目录页面显示的文件数还包含磁盘上尚未被分析的文件（isAnalyzed = false），
   * 两者口径不同属于预期行为，不应强行对齐。
   */
  async getAnalyzedFilesCount(workspaceDirectoryPath?: string): Promise<number> {
    try {
      let showMissing = true
      try {
        showMissing = ConfigOrchestrator.getInstance().getValue<boolean>('SHOW_MISSING_FILES') ?? true
      } catch {}

      let query = 'SELECT COUNT(DISTINCT wf.id) as count FROM workspace_files wf WHERE wf.is_analyzed = 1'
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
        query += " AND wf.workspace_id IN (SELECT workspace_id FROM workspaces WHERE type = 'PRIVATE')"
      }

      const result = this.db.prepare(query).get(...params) as any
      return result?.count || 0
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '[TagTreeQuery] 获取已分析文件数失败:', error)
      return 0
    }
  }

  /**
   * 获取 PRIVATE 工作区的已分析文件总数
   */
  async getPrivateAnalyzedFilesCount(workspaceDirectoryPath?: string): Promise<number> {
    return this.getAnalyzedFilesCount(workspaceDirectoryPath)
  }

  /**
   * 将数据库查询结果转换为统一 FileItem 数组
   */
  private mapFilesToItems(
    files: any[],
    workspaceDirectoryPath: string | undefined,
    showMissing: boolean
  ): FileItem[] {
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
        if (file.dimension_tags) {
          try {
            tags = typeof file.dimension_tags === 'string' ? JSON.parse(file.dimension_tags) : file.dimension_tags
          } catch {}
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
          extension: file.type
            ? file.type.replace(/^\./, '')
            : file.name
              ? path.extname(file.name).replace(/^\./, '').toLowerCase()
              : '',
          mimeType: file.category,
          category: file.category,
          createdAt: file.created_at ? new Date(file.created_at) : new Date(),
          modifiedAt: file.modified_at ? new Date(file.modified_at) : new Date(),
          isDirectory: false,
          isAnalyzed: !!file.is_analyzed,
          lastAnalyzedAt: file.last_analyzed_at
            ? new Date(file.last_analyzed_at as string)
            : undefined,
          qualityScore: file.quality_score || undefined,
          description: file.description || undefined,
          thumbnailPath: file.thumbnail_path || undefined,
          multimodalContent: file.multimodal_content || undefined,
          relativePathPrefix: relativePathPrefix || undefined,
          author: file.author || undefined,
          language: file.language || undefined,
          tags: Array.isArray(tags) ? tags : []
        }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
  }
}
