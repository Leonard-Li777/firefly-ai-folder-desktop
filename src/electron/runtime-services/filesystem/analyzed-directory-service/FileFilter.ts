import { LogCategory, logger } from '@firefly/shared'
import {
  FileItem,
  FilteredFilesResponse,
  SelectedTag,
  VirtualDirectoryFilter
} from '@firefly/types'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'
import fs from 'node:fs'

import Database from 'better-sqlite3'
import path from 'node:path'

import { loadIgnoreRules, shouldIgnoreFile } from '../../analysis/analysis-ignore-service'

export class FileFilter {
  constructor(
    private db: Database.Database,
    private getExtensionsForTag: (tag: string) => string[]
  ) {
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
        } catch (err) {
          return 0
        }
      })
    } catch (err) {
      // Ignore if already defined or fails
    }
  }

  async getAnalyzedFilesCount(workspaceDirectoryPath?: string): Promise<number> {
    try {
      let query = ''
      const params: any[] = []

      let showMissing = true
      try {
        showMissing =
          ConfigOrchestrator.getInstance().getValue<boolean>('SHOW_MISSING_FILES') ?? true
      } catch {
        // default true
      }

      if (workspaceDirectoryPath) {
        query = `SELECT COUNT(DISTINCT id) as count FROM workspace_files WHERE is_analyzed = 1 ${!showMissing ? 'AND status = 1' : ''}`
        const sep = path.sep
        const prefix = workspaceDirectoryPath.endsWith(sep)
          ? workspaceDirectoryPath
          : workspaceDirectoryPath + sep
        query += ` AND (path LIKE ? OR path = ?)`
        params.push(`${prefix}%`, workspaceDirectoryPath)
      } else {
        query = `
          SELECT COUNT(DISTINCT id) as count
          FROM workspace_files
          WHERE is_analyzed = 1
          ${!showMissing ? 'AND status = 1' : ''}
          AND workspace_id IN (SELECT workspace_id FROM workspaces WHERE type = 'PRIVATE')
        `
      }

      const result = this.db.prepare(query).get(...params) as any
      return result?.count || 0
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, 'Failed to get analyzed files count:', error)
      return 0
    }
  }

  /**
   * 应用标签过滤条件
   * @param unionMode 'union' 表示并集（OR），'intersection' 表示交集（AND）
   */
  private applyTagFilters(
    selectedTags: SelectedTag[],
    whereClauses: string[],
    queryParams: any[],
    unionMode: 'union' | 'intersection' = 'union'
  ): void {
    if (selectedTags.length === 0) return

    // 优化：当选择较多标签且为并集模式 (OR) 时，合并为单条 JOIN 关系判定子查询，提升 SQLite 执行计划性能
    if (unionMode === 'union' && selectedTags.length > 15) {
      const tagPairs = selectedTags.map(() => '(?, ?)').join(',')
      selectedTags.forEach(t =>
        queryParams.push(t.dimensionId, t.tagValue.replace(/^\./, '').toLowerCase().trim())
      )
      whereClauses.push(`f.file_fingerprint IN (
        SELECT ftr_sub.file_fingerprint
        FROM file_tag_relations ftr_sub
        JOIN file_tags ft_sub ON ft_sub.id = ftr_sub.tag_id
        WHERE (ft_sub.dimension_id, LOWER(TRIM(REPLACE(ft_sub.name, '.', '')))) IN (VALUES ${tagPairs})
      )`)
      return
    }

    const tagClauses: string[] = []
    for (const tag of selectedTags) {
      let subquery = `f.file_fingerprint IN (
        SELECT ftr_sub.file_fingerprint
        FROM file_tag_relations ftr_sub
        JOIN file_tags ft_sub ON ft_sub.id = ftr_sub.tag_id
        WHERE ft_sub.dimension_id = ? AND (
          LOWER(TRIM(ft_sub.name)) = LOWER(TRIM(?))
          OR LOWER(TRIM(REPLACE(ft_sub.name, '.', ''))) = LOWER(TRIM(REPLACE(?, '.', '')))
        )`

      queryParams.push(tag.dimensionId, tag.tagValue, tag.tagValue)

      // 如果标签本身来自于扩展名维度（如 Level 3 或名称包含扩展名/Extension），则标签本身已定位到扩展名，无需追加 f.type 约束
      const isExtensionTag =
        tag.level === 3 ||
        /扩展名|Extension/i.test(tag.dimensionName || '') ||
        (tag.dimensionId >= 102 && tag.dimensionId <= 117)

      if (!isExtensionTag) {
        // 1. 优先尝试按当前标签自身查找关联扩展名（例如图片/文档）
        let allowedExts = this.getExtensionsForTag(tag.tagValue)
        // 2. 若标签自身未命中扩展名，再尝试父标签及祖先链
        if (allowedExts.length === 0 && tag.parentTagValue) {
          allowedExts = this.getExtensionsForTag(tag.parentTagValue)
        }
        if (allowedExts.length === 0 && tag.ancestorChain && tag.ancestorChain.length > 1) {
          for (let i = tag.ancestorChain.length - 2; i >= 0; i--) {
            allowedExts = this.getExtensionsForTag(tag.ancestorChain[i])
            if (allowedExts.length > 0) break
          }
        }
        if (allowedExts.length > 0) {
          const normalizedExts = new Set<string>()
          for (const ext of allowedExts) {
            const clean = ext.toLowerCase().replace(/^\./, '')
            if (clean) {
              normalizedExts.add(clean)
              normalizedExts.add(`.${clean}`)
            }
          }
          const extArray = Array.from(normalizedExts)
          if (extArray.length > 0) {
            const extList = extArray.map(() => '?').join(',')
            subquery += ` AND LOWER(f.type) IN (${extList})`
            queryParams.push(...extArray)
          }
        }
      }

      subquery += ')'
      tagClauses.push(subquery)
    }

    if (tagClauses.length > 0) {
      const joinOperator = unionMode === 'intersection' ? ' AND ' : ' OR '
      whereClauses.push(`(${tagClauses.join(joinOperator)})`)
    }
  }

  /**
   * 获取排序列名
   */
  private getSortColumn(sortBy: VirtualDirectoryFilter['sortBy']): string {
    return sortBy === 'name'
      ? 'wf.name'
      : sortBy === 'date'
        ? 'f.modified_at'
        : sortBy === 'size'
          ? 'f.size'
          : sortBy === 'type'
            ? 'f.type'
            : sortBy === 'smartName'
              ? 'f.smart_name'
              : sortBy === 'qualityScore'
                ? 'fc.quality_score'
                : sortBy === 'author'
                  ? 'f.author'
                  : sortBy === 'language'
                    ? 'f.language'
                    : sortBy === 'analysisStatus'
                      ? 'wf.is_analyzed'
                      : 'wf.name'
  }

  /**
   * 构建统一的"文件全信息搜索"条件（SQL 片段 + 参数）
   *
   * 匹配范围覆盖文件全信息字段：
   * 1. FTS5 全文索引：物理文件名/智能名/描述/正文内容/多模态描述/歌词字幕/聚合标签
   * 2. LIKE 兜底（未索引或未分析的兼容）：物理路径、扩展名、作者、语言、AI 分类
   * 3. 标签名 LIKE：按标签名反查文件
   *
   * 说明：files_fts 由触发器同步所有文件（含未分析文件的基础字段），
   * 因此未分析文件仍可通过 name/smart_name/description/path/type 等命中。
   *
   * @param keyword 搜索关键词
   * @returns { sql, params }，keyword 为空时返回空条件
   */
  private buildSearchClause(keyword: string): { sql: string; params: string[] } {
    const trimmed = keyword?.trim()
    if (!trimmed) return { sql: '', params: [] }
    const likePattern = `%${trimmed}%`
    // files_fts 可能缺失（例如未启用 FTS5 的测试环境），此时跳过全文索引匹配并降级为纯 LIKE 搜索
    const ftsAvailable = this.isFtsAvailable()
    const ftsClause = ftsAvailable
      ? `(wf.file_fingerprint IS NOT NULL AND wf.file_fingerprint IN (SELECT file_fingerprint FROM files_fts WHERE files_fts MATCH ?))\n        OR `
      : ''
    const sanitizedQuery = `"${trimmed.replace(/["]/g, '""')}"`
    return {
      sql: `(
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
          JOIN file_tags ft ON ft.id = ftr.tag_id
          WHERE ft.name LIKE ?
        )
      )`,
      params: ftsAvailable
        ? [
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
          ]
        : [
            likePattern,
            likePattern,
            likePattern,
            likePattern,
            likePattern,
            likePattern,
            likePattern,
            likePattern,
            likePattern
          ]
    }
  }

  /** files_fts 是否存在（带缓存，仅检测一次） */
  private _ftsAvailable: boolean | null = null
  private isFtsAvailable(): boolean {
    if (this._ftsAvailable === null) {
      try {
        const row = this.db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='files_fts'`)
          .get() as { name?: string } | undefined
        this._ftsAvailable = !!row
      } catch {
        this._ftsAvailable = false
      }
    }
    return this._ftsAvailable
  }

  async getFilteredFilesPaged(params: {
    selectedTags: SelectedTag[]
    sortBy: VirtualDirectoryFilter['sortBy']
    sortOrder: 'asc' | 'desc'
    workspaceDirectoryPath?: string
    searchKeyword?: string
    limit: number
    offset: number
    virtualDirectoryId?: number
    unionMode?: 'union' | 'intersection'
    includeUnanalyzed?: boolean
  }): Promise<FilteredFilesResponse> {
    const startTime = performance.now()
    let dbQueryTime = 0
    try {
      const {
        selectedTags,
        sortBy,
        sortOrder,
        workspaceDirectoryPath,
        searchKeyword,
        limit,
        offset,
        virtualDirectoryId,
        unionMode,
        includeUnanalyzed
      } = params

      let baseQuery = `
        FROM workspace_files wf
        LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
        LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
      `

      const whereClauses: string[] = ['should_ignore_file(wf.path, wf.name) = 0']
      // 默认仅搜索已分析文件；真实目录全信息搜索（includeUnanalyzed=true）时包含未分析文件
      if (!includeUnanalyzed) {
        whereClauses.unshift('wf.is_analyzed = 1')
      }

      let showMissing = true
      try {
        showMissing =
          ConfigOrchestrator.getInstance().getValue<boolean>('SHOW_MISSING_FILES') ?? true
      } catch {
        // default true if uninitialized
      }
      if (!showMissing) {
        whereClauses.push('wf.status = 1')
      }

      const queryParams: any[] = []
      let joinClauses = ''

      if (virtualDirectoryId !== undefined) {
        baseQuery += `
          JOIN virtual_directory_files vdf ON vdf.file_id = wf.id
        `
        whereClauses.push('vdf.virtual_directory_id = ?')
        queryParams.push(virtualDirectoryId)
      } else if (workspaceDirectoryPath) {
        const sep = path.sep
        const prefix = workspaceDirectoryPath.endsWith(sep)
          ? workspaceDirectoryPath
          : workspaceDirectoryPath + sep
        whereClauses.push(`(wf.path LIKE ? OR wf.path = ?)`)
        queryParams.push(`${prefix}%`, workspaceDirectoryPath)
      }

      if (selectedTags.length > 0) {
        this.applyTagFilters(selectedTags, whereClauses, queryParams, unionMode)
      }

      // 搜索条件（文件全信息搜索：FTS 全字段 + path/type/author/language/category + 标签名）
      if (searchKeyword && searchKeyword.trim()) {
        const clause = this.buildSearchClause(searchKeyword)
        whereClauses.push(clause.sql)
        queryParams.push(...clause.params)
      }

      // 计数查询
      const dbCountStartTime = performance.now()
      const countQuery = `SELECT COUNT(DISTINCT wf.id) as total ${baseQuery} ${joinClauses} WHERE ${whereClauses.join(' AND ')}`
      const totalResult = this.db.prepare(countQuery).get(...queryParams) as { total: number }
      dbQueryTime += performance.now() - dbCountStartTime
      const total = totalResult?.total || 0

      // 数据查询
      const sortColumn = this.getSortColumn(sortBy || 'modifiedAt')
      const safeSortOrder = (sortOrder || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC'
      const selectQuery = `
        SELECT DISTINCT
          COALESCE(f.file_fingerprint, wf.file_fingerprint) as file_fingerprint,
          wf.id as id,
          wf.path,
          wf.name,
          f.smart_name,
          COALESCE(f.size, 0) as size,
          COALESCE(f.type, '') as type,
          COALESCE(f.category, '') as category,
          f.created_at,
          f.modified_at,
          wf.is_analyzed,
          wf.status as status,
          wf.last_analyzed_at,
          f.description,
          wf.thumbnail_path,
          f.author,
          f.language,
          fc.quality_score,
          (
            SELECT json_group_array(ft.name)
            FROM file_tag_relations ftr
            JOIN file_tags ft ON ft.id = ftr.tag_id
            WHERE ftr.file_fingerprint = wf.file_fingerprint
          ) as dimension_tags
        ${baseQuery}
        ${joinClauses}
        WHERE ${whereClauses.join(' AND ')}
        ORDER BY ${sortColumn} ${safeSortOrder}
        LIMIT ? OFFSET ?
      `

      const dbSelectStartTime = performance.now()
      const files = this.db.prepare(selectQuery).all(...queryParams, limit, offset) as any[]
      dbQueryTime += performance.now() - dbSelectStartTime

      const items = files
        .map(file => {
          const currentStatus = file.status ?? 1

          if (!showMissing && currentStatus === 0) {
            return null
          }

          // 计算相对路径前缀
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

          return {
            id: file.id.toString(),
            status: currentStatus,
            fileFingerprint: file.file_fingerprint,
            path: file.path,
            parentPath: path.dirname(file.path),
            name: file.name,
            smartName: file.smart_name || undefined,
            size: file.size,
            extension: file.type
              ? file.type.startsWith('.')
                ? file.type
                : `.${file.type}`
              : file.name
                ? path.extname(file.name).toLowerCase()
                : '',
            mimeType: file.category,
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
            multimodalContent: undefined,
            relativePathPrefix: relativePathPrefix || undefined,
            author: file.author || undefined,
            language: file.language || undefined,
            tags: file.dimension_tags ? JSON.parse(file.dimension_tags) : []
          }
        })
        .filter((item): item is NonNullable<typeof item> => item !== null)

      return {
        items,
        total,
        performance: {
          dbQueryTime: Math.round(dbQueryTime * 100) / 100,
          totalTime: Math.round((performance.now() - startTime) * 100) / 100
        }
      }
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, 'Failed to get filtered files paged:', error)
      return { items: [], total: 0 }
    }
  }

  async getFilteredFiles(params: {
    selectedTags: SelectedTag[]
    sortBy: VirtualDirectoryFilter['sortBy']
    sortOrder: 'asc' | 'desc'
    workspaceDirectoryPath?: string
    searchKeyword?: string
    virtualDirectoryId?: number
    unionMode?: 'union' | 'intersection'
    includeUnanalyzed?: boolean
  }): Promise<FileItem[]> {
    try {
      const {
        selectedTags,
        sortBy,
        sortOrder,
        workspaceDirectoryPath,
        searchKeyword,
        virtualDirectoryId,
        unionMode,
        includeUnanalyzed
      } = params

      let baseQuery = `
        FROM workspace_files wf
        LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
        LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
      `

      const whereClauses: string[] = ['should_ignore_file(wf.path, wf.name) = 0']
      // 默认仅搜索已分析文件；真实目录全信息搜索（includeUnanalyzed=true）时包含未分析文件
      if (!includeUnanalyzed) {
        whereClauses.unshift('wf.is_analyzed = 1')
      }

      let showMissing = true
      try {
        showMissing =
          ConfigOrchestrator.getInstance().getValue<boolean>('SHOW_MISSING_FILES') ?? true
      } catch {
        // default true if uninitialized
      }
      if (!showMissing) {
        whereClauses.push('wf.status = 1')
      }

      const queryParams: any[] = []

      if (virtualDirectoryId !== undefined) {
        baseQuery += `
          JOIN virtual_directory_files vdf ON vdf.file_id = wf.id
        `
        whereClauses.push('vdf.virtual_directory_id = ?')
        queryParams.push(virtualDirectoryId)
      } else if (workspaceDirectoryPath) {
        const sep = path.sep
        const prefix = workspaceDirectoryPath.endsWith(sep)
          ? workspaceDirectoryPath
          : workspaceDirectoryPath + sep
        whereClauses.push(`(wf.path LIKE ? OR wf.path = ?)`)
        queryParams.push(`${prefix}%`, workspaceDirectoryPath)
      }

      let joinClauses = ''
      if (selectedTags.length > 0) {
        this.applyTagFilters(selectedTags, whereClauses, queryParams, unionMode)
      }

      // 搜索条件（文件全信息搜索：FTS 全字段 + path/type/author/language/category + 标签名）
      if (searchKeyword && searchKeyword.trim()) {
        const clause = this.buildSearchClause(searchKeyword)
        whereClauses.push(clause.sql)
        queryParams.push(...clause.params)
      }

      const sortColumn = this.getSortColumn(sortBy || 'modifiedAt')
      const safeSortOrder = (sortOrder || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC'
      const selectQuery = `
        SELECT DISTINCT
          wf.id as id,
          COALESCE(f.file_fingerprint, wf.file_fingerprint) as file_fingerprint,
          wf.path,
          wf.name,
          f.smart_name,
          COALESCE(f.size, 0) as size,
          COALESCE(f.type, '') as type,
          COALESCE(f.category, '') as category,
          f.created_at,
          f.modified_at,
          wf.is_analyzed,
          wf.status as status,
          wf.last_analyzed_at as last_analyzed_at,
          f.description,
          wf.thumbnail_path,
          f.author,
          f.language,
          fc.quality_score,
          (
            SELECT json_group_array(ft.name)
            FROM file_tag_relations ftr
            JOIN file_tags ft ON ft.id = ftr.tag_id
            WHERE ftr.file_fingerprint = wf.file_fingerprint
          ) as dimension_tags
        ${baseQuery}
        ${joinClauses}
        WHERE ${whereClauses.join(' AND ')}
        ORDER BY ${sortColumn} ${safeSortOrder}
      `

      const files = this.db.prepare(selectQuery).all(...queryParams) as any[]

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
            if (fileDir === workspaceDirectoryPath || fileDir.startsWith(prefix)) {
              const relativePath = path.relative(workspaceDirectoryPath, fileDir)
              if (relativePath && relativePath !== '.') {
                relativePathPrefix = relativePath
              }
            }
          }

          const allTags: string[] = []
          if (file.dimension_tags) {
            try {
              const dimTags = JSON.parse(file.dimension_tags)
              if (Array.isArray(dimTags)) allTags.push(...dimTags)
            } catch (_e) {
              /* 解析失败则跳过 */
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
            size: file.size,
            extension: file.type
              ? file.type.startsWith('.')
                ? file.type
                : `.${file.type}`
              : file.name
                ? path.extname(file.name).toLowerCase()
                : '',
            mimeType: file.category,
            createdAt: file.created_at ? new Date(file.created_at) : new Date(),
            modifiedAt: file.modified_at ? new Date(file.modified_at) : new Date(),
            isDirectory: false,
            isAnalyzed: !!file.is_analyzed,
            lastAnalyzedAt: file.last_analyzed_at ? new Date(file.last_analyzed_at) : undefined,
            analyzedAt: file.last_analyzed_at ? new Date(file.last_analyzed_at) : undefined,
            qualityScore: file.quality_score || undefined,
            tags: allTags.length > 0 ? [...new Set(allTags)] : undefined,
            description: file.description || undefined,
            thumbnailPath: file.thumbnail_path || undefined,
            multimodalContent: undefined,
            relativePathPrefix: relativePathPrefix || undefined,
            author: file.author || undefined,
            language: file.language || undefined
          }
        })
        .filter((file): file is NonNullable<typeof file> => file !== null)
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, 'Failed to get filtered files:', error)
      throw error
    }
  }
}
