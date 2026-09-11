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
import { LogCategory, logger } from '@firefly/shared'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'
import { loadIgnoreRules, shouldIgnoreFile } from '../../analysis/analysis-ignore-service'

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

/**
 * TagTreeQuery 深模块
 * 
 * 核心职责：
 * 1. 利用 SQLite 递归公共表表达式（Recursive CTE）实现标签树、后代节点与祖先链的瞬时检索；
 * 2. 高效下推文件与复合标签的筛选计算，杜绝在 Node.js 内存中递归拼装扩展名映射；
 * 3. 彻底消除魔法数字区间（102..117），全量依托 file_tags 树与 file_tag_relations 自然主键关联。
 */
export class TagTreeQuery {
  constructor(private db: Database.Database) {
    this.ensureSqlFunctions()
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
   * 递归查找指定标签值（或代码）自身及其所有后代标签的 code 集合
   */
  public getDescendantTagCodes(tagValueOrCode: string): string[] {
    try {
      const query = `
        WITH RECURSIVE descendants(code) AS (
          SELECT code FROM file_tags 
          WHERE name = ? OR code = ?
          UNION ALL
          SELECT ft.code FROM file_tags ft
          JOIN descendants d ON (
            ft.parent_codes LIKE '%"' || d.code || '"%'
            OR ft.code LIKE d.code || '.%'
          )
        )
        SELECT DISTINCT code FROM descendants
      `
      const rows = this.db.prepare(query).all(tagValueOrCode, tagValueOrCode) as Array<{ code: string }>
      if (rows.length > 0) {
        return rows.map(r => r.code)
      }
      return [tagValueOrCode]
    } catch (err) {
      logger.warn(LogCategory.VIRTUAL_DIRECTORY, `[TagTreeQuery] 递归查询子标签失败: ${tagValueOrCode}`, err)
      return [tagValueOrCode]
    }
  }

  /**
   * 获取维度组导航树（含命中文件计数）
   */
  async getDimensionGroups(
    options?: GetDimensionGroupsOptions | string,
    _language?: string
  ): Promise<DimensionGroupsResponse> {
    const startTime = performance.now()
    let dbQueryTime = 0

    const opts: GetDimensionGroupsOptions =
      typeof options === 'string'
        ? { workspaceDirectoryPath: options, language: _language }
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
      let showMissing = true
      try {
        showMissing = ConfigOrchestrator.getInstance().getValue<boolean>('SHOW_MISSING_FILES') ?? true
      } catch {}

      // 1. 获取所有维度根节点 (depth = 0 或 meta.isDimension = 1)
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

      // 2. 获取所有非根标签节点
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

      // 4. 统计在有效文件集合下，每个 tag_code 的文件命中数
      const countQuery = `
        SELECT ftr.tag_code, COUNT(DISTINCT ftr.file_fingerprint) as count
        FROM file_tag_relations ftr
        WHERE ftr.file_fingerprint IN (${filteredFingerprintsSql})
        GROUP BY ftr.tag_code
      `
      const countStartTime = performance.now()
      const countRows = this.db.prepare(countQuery).all(...filteredFingerprintsParams) as Array<{
        tag_code: string
        count: number
      }>
      dbQueryTime += performance.now() - countStartTime

      const tagCountMap = new Map<string, number>()
      for (const row of countRows) {
        tagCountMap.set(row.tag_code, row.count)
      }

      // 5. 按照维度归类标签并组织树形结构
      const groups: DimensionGroup[] = []

      for (const root of dimensionRoots) {
        const dimCode = root.code
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
          // 汇总该标签自身及后代标签的代码
          const familyCodes = this.getDescendantTagCodes(child.code)
          let aggregatedCount = 0
          for (const fc of familyCodes) {
            aggregatedCount += tagCountMap.get(fc) || 0
          }

          if (removeEmptyTags && !includeAllPresetTags && aggregatedCount === 0) {
            continue
          }

          dimensionTags.push({
            dimensionId: dimCode as any,
            dimensionName: root.name,
            tagValue: child.name,
            fileCount: aggregatedCount,
            level: child.depth || 1
          })
        }

        // 提取数值型 ID 用于向前兼容
        const numIdMatch = dimCode.match(/^dim\.(\d+)$/)
        const legacyNumericId = numIdMatch ? parseInt(numIdMatch[1], 10) : groups.length + 1

        groups.push({
          id: legacyNumericId as any,
          name: root.name,
          level: root.depth,
          tags: dimensionTags,
          metadata: dimMeta
        })
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
        ? `(wf.file_fingerprint IS NOT NULL AND wf.file_fingerprint IN (SELECT file_fingerprint FROM files_fts WHERE files_fts MATCH ?)) OR `
        : ''
      const sanitizedQuery = trimmed.replace(/["*^()]/g, ' ').trim() || trimmed

      whereClauses.push(`(
        ${ftsClause}wf.name LIKE ?
        OR f.smart_name LIKE ?
        OR f.description LIKE ?
        OR wf.path LIKE ?
        OR f.type LIKE ?
        OR f.author LIKE ?
        OR f.language LIKE ?
        OR f.category LIKE ?
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
        const allCodes = new Set<string>()
        for (const tag of selectedTags) {
          const codes = this.getDescendantTagCodes(tag.tagValue)
          codes.forEach(c => allCodes.add(c))
        }
        const codeArray = Array.from(allCodes)
        if (codeArray.length > 0) {
          const placeholders = codeArray.map(() => '?').join(',')
          whereClauses.push(`wf.file_fingerprint IN (
            SELECT ftr.file_fingerprint
            FROM file_tag_relations ftr
            WHERE ftr.tag_code IN (${placeholders})
          )`)
          queryParams.push(...codeArray)
        }
      } else {
        // intersection
        for (const tag of selectedTags) {
          const codes = this.getDescendantTagCodes(tag.tagValue)
          if (codes.length > 0) {
            const placeholders = codes.map(() => '?').join(',')
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
        type: 'COALESCE(f.type, "")',
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
          f.type,
          f.category,
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
        type: 'COALESCE(f.type, "")',
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
          f.type,
          f.category,
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
