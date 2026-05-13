import { CATEGORY_EXT_MAP, LogCategory, logger } from '@yonuc/shared'
import { DimensionGroup, DimensionTag, SavedVirtualDirectory, SelectedTag, VirtualDirectoryFilter, DimensionGroupsResponse, FilteredFilesResponse } from '@yonuc/types'

import Database from 'better-sqlite3'
import { FileItem } from '@yonuc/types'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { databaseService } from '../database/database-service'
import fs from 'node:fs'
import path from 'node:path'
import { platformAdapter } from '@yonuc/electron-llamaIndex-service'
import { t } from '@app/languages'

// config-service 保留在 apps/desktop,通过 platformAdapter 访问配置

// 虚拟目录文件夹名称常量
const VIRTUAL_DIRECTORY_FOLDER = '.VirtualDirectory'
const THUMBNAIL_FOLDER = '.thumbnail'

export class VirtualDirectoryService {
  private _db: Database.Database | null = null

  constructor(db?: Database.Database) {
    if (db) {
      this._db = db
    }
  }

  private get db(): Database.Database {
    if (this._db) return this._db
    const db = databaseService.db
    if (!db) {
      throw new Error('[VirtualDirectoryService] Database not initialized')
    }
    return db
  }

  /**
   * 根据标签名称推导允许的物理后缀名
   * 用于确保侧边栏计数与物理文件类型一致
   */
  private getExtensionsForTag(tagValue: string): string[] {
    const normalized = tagValue.trim().toLowerCase()
    
    // 视频类
    if (
      normalized === t('视频').toLowerCase() || 
      normalized === t('影视').toLowerCase() || 
      normalized.includes('video') || 
      normalized.includes('movie')
    ) {
      return CATEGORY_EXT_MAP['video'] || []
    }
    
    // 图片类
    if (
      normalized === t('图片').toLowerCase() || 
      normalized === t('摄影照片').toLowerCase() || 
      normalized === t('照片').toLowerCase() || 
      normalized.includes('image') || 
      normalized.includes('picture')
    ) {
      return CATEGORY_EXT_MAP['image'] || []
    }
    
    // 电子书/小说类
    if (
      normalized === t('电子书').toLowerCase() || 
      normalized === t('小说').toLowerCase() || 
      normalized.includes('ebook') || 
      normalized.includes('novel')
    ) {
      return CATEGORY_EXT_MAP['ebook'] || []
    }
    
    // 文档类
    if (
      normalized === t('文档').toLowerCase() || 
      normalized.includes('document')
    ) {
      return CATEGORY_EXT_MAP['document'] || []
    }
    
    // 音频类
    if (
      normalized === t('音频').toLowerCase() || 
      normalized.includes('audio') || 
      normalized.includes('music')
    ) {
      return CATEGORY_EXT_MAP['audio'] || []
    }
    
    // 脚本/源代码类
    if (
      normalized === t('脚本').toLowerCase() || 
      normalized.includes('script') ||
      normalized.includes('source')
    ) {
      return CATEGORY_EXT_MAP['source'] || []
    }
    
    return []
  }

  /**
   * Get all dimensions grouped by parent with file counts for each tag
   * 支持新版 Schema (fd.id 作为唯一标识，移除 language 字段)
   */
  async getDimensionGroups(workspaceDirectoryPath?: string, _language = 'zh-CN'): Promise<DimensionGroupsResponse> {
    const startTime = performance.now()
    let dbQueryTime = 0
    try {
      // 1. 获取所有原始维度数据
      const dbStartTime = performance.now()
      const rawDimensions = this.db
        .prepare('SELECT id, name, tags, trigger_conditions, level FROM file_dimensions ORDER BY level ASC')
        .all() as any[]
      dbQueryTime += performance.now() - dbStartTime

      // 创建名称到 ID 的映射
      const nameToIdMap = new Map<string, number>()
      rawDimensions.forEach(d => {
        if (d.name) {
          nameToIdMap.set(d.name.trim(), d.id)
        }
      })

      // --- 性能优化：一次性获取所有标签的全局计数 ---
      // 修改：按工作区中的真实文件记录 (wf.id) 进行计数。
      let globalCountQuery = `
        SELECT ft.dimension_id, ft.name as tag_name, f.type as file_type, COUNT(DISTINCT wf.id) as count
        FROM file_tags ft
        JOIN file_tag_relations ftr ON ftr.tag_id = ft.id
        JOIN files f ON f.file_fingerprint = ftr.file_fingerprint
        JOIN workspace_files wf ON f.file_fingerprint = wf.file_fingerprint AND wf.is_analyzed = 1
      `
      const globalCountParams: any[] = []

      if (workspaceDirectoryPath) {
        const sep = path.sep;
        const prefix = workspaceDirectoryPath.endsWith(sep) ? workspaceDirectoryPath : workspaceDirectoryPath + sep;
        globalCountQuery += ` WHERE (wf.path LIKE ? OR wf.path = ?)`;
        globalCountParams.push(`${prefix}%`, workspaceDirectoryPath);
      }

      globalCountQuery += ` GROUP BY ft.dimension_id, ft.name, f.type`
      
      const allCounts = this.db.prepare(globalCountQuery).all(...globalCountParams) as Array<{
        dimension_id: number;
        tag_name: string;
        file_type: string;
        count: number;
      }>;

      // 按 dimension_id -> tag_name organization 计数
      const countsMap = new Map<number, Map<string, number>>();
      allCounts.forEach(r => {
        if (!countsMap.has(r.dimension_id)) {
          countsMap.set(r.dimension_id, new Map());
        }
        const dimMap = countsMap.get(r.dimension_id)!;
        
        const allowedExts = this.getExtensionsForTag(r.tag_name);
        if (allowedExts.length > 0) {
          const fileExt = r.file_type?.toLowerCase() || '';
          if (!allowedExts.includes(fileExt)) return;
        }
        
        const current = dimMap.get(r.tag_name) || 0;
        dimMap.set(r.tag_name, current + r.count);
      });

      const groups: DimensionGroup[] = []

      // 2. 处理每个维度并构建结果
      for (const dim of rawDimensions) {
        // --- 标签处理逻辑 ---
        const configShowEmptyTags = ConfigOrchestrator.getInstance().getValue<boolean>('SHOW_EMPTY_TAGS') ?? false
        
        // 从 file_tags 表中获取实际存在的文件标签
        const existingTags = this.db.prepare('SELECT name FROM file_tags WHERE dimension_id = ?').all(dim.id) as { name: string }[]
        const existingTagNames = existingTags.map(t => t.name)
        
        // 合并标签：如果开启了显示空标签，则包含定义中的所有标签；否则只显示已有标签
        const tagSet = new Set<string>(existingTagNames)
        if (configShowEmptyTags) {
          const definedTags = JSON.parse(dim.tags || '[]')
          definedTags.forEach((t: string) => tagSet.add(t))
        }
        
        const tagStrings = Array.from(tagSet)
        const triggerConditions = dim.trigger_conditions ? JSON.parse(dim.trigger_conditions) : null

        // --- 父维度解析逻辑 ---
        const parentDimensionIds: number[] = []
        if (triggerConditions && Array.isArray(triggerConditions)) {
          triggerConditions.forEach((tc: any) => {
            const searchName = tc.parentDimension?.trim()
            const parentId = nameToIdMap.get(searchName)
            if (parentId) {
              parentDimensionIds.push(parentId)
            }
          })
        }

        // --- 恢复上下文标签计数逻辑 ---
        const contextualTags: Record<string, DimensionTag[]> = {}
        if (triggerConditions && Array.isArray(triggerConditions)) {
          for (const tc of triggerConditions) {
            const parentDimId = nameToIdMap.get(tc.parentDimension?.trim())
            if (!parentDimId) continue

            for (const parentTagValue of tc.triggerTags) {
              const extensions: string[] = []
              
              const isVideoTag = parentTagValue === t('视频') || parentTagValue === t('影视') || parentTagValue.toLowerCase().includes('video')
              const isImageTag = parentTagValue === t('图片') || parentTagValue === t('摄影照片') || parentTagValue.toLowerCase().includes('image') || parentTagValue.toLowerCase().includes('picture')
              const isEbookTag = parentTagValue === t('电子书') || parentTagValue === t('小说') || parentTagValue.toLowerCase().includes('ebook') || parentTagValue.toLowerCase().includes('novel')
              const isDocTag = parentTagValue === t('文档') || parentTagValue.toLowerCase().includes('document')
              const isScriptTag = parentTagValue === t('脚本') || parentTagValue.toLowerCase().includes('script')

              if (isVideoTag) extensions.push(...(CATEGORY_EXT_MAP['video'] || []))
              else if (isImageTag) extensions.push(...(CATEGORY_EXT_MAP['image'] || []))
              else if (isEbookTag) extensions.push(...(CATEGORY_EXT_MAP['ebook'] || []))
              else if (isDocTag) extensions.push(...(CATEGORY_EXT_MAP['document'] || []))
              else if (isScriptTag) extensions.push(...(CATEGORY_EXT_MAP['source'] || []))

              const contextualParams: any[] = [dim.id] 
              let parentTagCondition = `
                EXISTS (
                  SELECT 1 FROM file_tag_relations pftr
                  JOIN file_tags pft ON pft.id = pftr.tag_id
                  WHERE pftr.file_fingerprint = f.file_fingerprint AND pft.dimension_id = ? AND pft.name = ?
                )
              `
              contextualParams.push(parentDimId, parentTagValue)

              if (extensions.length > 0) {
                const extPhs = extensions.map(() => '?').join(',')
                parentTagCondition = `(${parentTagCondition} OR f.type IN (${extPhs}))`
                contextualParams.push(...extensions) 
              }

              let contextualCountQuery = `
                SELECT ft.name as tag_name, f.type as file_type, COUNT(DISTINCT wf.id) as count
                FROM file_tags ft
                JOIN file_tag_relations ftr ON ftr.tag_id = ft.id
                JOIN files f ON f.file_fingerprint = ftr.file_fingerprint
                JOIN workspace_files wf ON f.file_fingerprint = wf.file_fingerprint AND wf.is_analyzed = 1
                WHERE ft.dimension_id = ? AND ${parentTagCondition}
              `
              
              if (workspaceDirectoryPath) {
                const pathSep = path.sep;
                const prefix = workspaceDirectoryPath.endsWith(pathSep) ? workspaceDirectoryPath : workspaceDirectoryPath + pathSep;
                contextualCountQuery += ` AND (wf.path LIKE ? OR wf.path = ?)`;
                contextualParams.push(`${prefix}%`, workspaceDirectoryPath);
              }

              contextualCountQuery += ` GROUP BY ft.name, f.type`
              
              const cTagCounts = new Map<string, number>()
              try {
                const dbContextualStartTime = performance.now()
                const cCountResults = this.db.prepare(contextualCountQuery).all(...contextualParams) as { tag_name: string, file_type: string, count: number }[]
                dbQueryTime += performance.now() - dbContextualStartTime
                
                cCountResults.forEach(r => {
                  const allowedExts = this.getExtensionsForTag(r.tag_name)
                  if (allowedExts.length > 0) {
                    const fileExt = r.file_type?.toLowerCase() || ''
                    if (!allowedExts.includes(fileExt)) return 
                  }
                  const current = cTagCounts.get(r.tag_name) || 0
                  cTagCounts.set(r.tag_name, current + r.count)
                })
              } catch (e) {
                logger.error(LogCategory.VIRTUAL_DIRECTORY, `获取维度 ${dim.name} 在父标签 ${parentTagValue} 下的上下文计数失败:`, e)
              }

              contextualTags[parentTagValue] = tagStrings.map(tag => ({
                dimensionId: dim.id,
                dimensionName: dim.name,
                tagValue: tag,
                fileCount: cTagCounts.get(tag) || 0,
                level: dim.level,
              }))
            }
          }
        }

        const tagCounts = countsMap.get(dim.id) || new Map<string, number>();

        // --- 构建结果对象 ---
        const dimensionTags: DimensionTag[] = tagStrings.map(tag => ({
          dimensionId: dim.id,
          dimensionName: dim.name,
          tagValue: tag,
          fileCount: tagCounts.get(tag) || 0,
          level: dim.level,
        }))

        groups.push({
          id: dim.id,
          name: dim.name,
          level: dim.level,
          tags: dimensionTags,
          contextualTags: Object.keys(contextualTags).length > 0 ? contextualTags : undefined,
          parentDimensionIds: parentDimensionIds.length > 0 ? parentDimensionIds : undefined,
          triggerConditions: triggerConditions || undefined,
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
      logger.error(LogCategory.VIRTUAL_DIRECTORY, 'Failed to get dimension groups:', error)
      return { groups: [] }
    }
  }

  /**
   * 获取已分析文件的数量
   */
  async getAnalyzedFilesCount(workspaceDirectoryPath?: string): Promise<number> {
    try {
      let query = ''
      const params: any[] = []

      if (workspaceDirectoryPath) {
        query = 'SELECT COUNT(DISTINCT id) as count FROM workspace_files WHERE is_analyzed = 1'
        const sep = path.sep;
        const prefix = workspaceDirectoryPath.endsWith(sep) ? workspaceDirectoryPath : workspaceDirectoryPath + sep;
        query += ` AND (path LIKE ? OR path = ?)`;
        params.push(`${prefix}%`, workspaceDirectoryPath);
      } else {
        query = `
          SELECT COUNT(DISTINCT id) as count 
          FROM workspace_files 
          WHERE is_analyzed = 1 
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
   * 获取所有私有工作区
   */
  async getPrivateWorkspaces(): Promise<{ path: string }[]> {
    try {
      return this.db.prepare("SELECT path FROM workspaces WHERE type = 'PRIVATE'").all() as { path: string }[]
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, 'Failed to get private workspaces:', error)
      return []
    }
  }

  /**
   * Get files filtered by selected tags with pagination
   */
  async getFilteredFilesPaged(params: {
    selectedTags: SelectedTag[]
    sortBy: VirtualDirectoryFilter['sortBy']
    sortOrder: 'asc' | 'desc'
    workspaceDirectoryPath?: string
    searchKeyword?: string
    limit: number
    offset: number
  }): Promise<FilteredFilesResponse> {
    const startTime = performance.now()
    let dbQueryTime = 0
    try {
      const { selectedTags, sortBy, sortOrder, workspaceDirectoryPath, searchKeyword, limit, offset } = params

      let baseQuery = `
        FROM workspace_files wf
        JOIN files f ON wf.file_fingerprint = f.file_fingerprint
        LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
      `
      
      const whereClauses: string[] = ['wf.is_analyzed = 1']
      const queryParams: any[] = []
      let joinClauses = ''

      if (workspaceDirectoryPath) {
        const sep = path.sep;
        const prefix = workspaceDirectoryPath.endsWith(sep) ? workspaceDirectoryPath : workspaceDirectoryPath + sep;
        whereClauses.push(`(wf.path LIKE ? OR wf.path = ?)`)
        queryParams.push(`${prefix}%`, workspaceDirectoryPath)
      }

      if (selectedTags.length > 0) {
        joinClauses += `
          JOIN file_tag_relations ftr ON ftr.file_fingerprint = f.file_fingerprint
          JOIN file_tags ft ON ft.id = ftr.tag_id
        `
        const tagConditions: string[] = []
        for (const tag of selectedTags) {
          const allowedExts = this.getExtensionsForTag(tag.tagValue)
          if (allowedExts.length > 0) {
            const extList = allowedExts.map(() => '?').join(',')
            tagConditions.push(`(ft.dimension_id = ? AND ft.name = ? AND f.type IN (${extList}))`)
            queryParams.push(tag.dimensionId, tag.tagValue, ...allowedExts)
          } else {
            tagConditions.push(`(ft.dimension_id = ? AND ft.name = ?)`)
            queryParams.push(tag.dimensionId, tag.tagValue)
          }
        }
        whereClauses.push(`(${tagConditions.join(' OR ')})`)
      }

      if (searchKeyword && searchKeyword.trim()) {
        const keyword = searchKeyword.trim()
        const sanitizedQuery = `"${keyword.replace(/["]/g, '""')}"*`
        const likePattern = `%${keyword}%`
        whereClauses.push(`(
          f.file_fingerprint IN (SELECT file_fingerprint FROM files_fts WHERE files_fts MATCH ?)
          OR wf.name LIKE ?
          OR f.smart_name LIKE ?
          OR f.description LIKE ?
          OR f.file_fingerprint IN (
            SELECT ftr.file_fingerprint 
            FROM file_tag_relations ftr 
            JOIN file_tags ft ON ft.id = ftr.tag_id 
            WHERE ft.name LIKE ?
          )
        )`)
        queryParams.push(sanitizedQuery, likePattern, likePattern, likePattern, likePattern)
      }

      // Count query
      const dbCountStartTime = performance.now()
      const countQuery = `SELECT COUNT(DISTINCT wf.id) as total ${baseQuery} ${joinClauses} WHERE ${whereClauses.join(' AND ')}`
      const totalResult = this.db.prepare(countQuery).get(...queryParams) as { total: number }
      dbQueryTime += performance.now() - dbCountStartTime
      const total = totalResult?.total || 0

      // Select query
      let selectQuery = `
        SELECT DISTINCT
          f.file_fingerprint,
          wf.id as id,
          wf.path,
          wf.name,
          f.smart_name,
          f.size,
          f.type,
          f.mime_type,
          f.created_at,
          f.modified_at,
          wf.is_analyzed,
          f.description,
          wf.thumbnail_path,
          f.author,
          f.language,
          fc.quality_score,
          (
            SELECT json_group_array(ft.name)
            FROM file_tag_relations ftr
            JOIN file_tags ft ON ft.id = ftr.tag_id
            WHERE ftr.file_fingerprint = f.file_fingerprint
          ) as dimension_tags
        ${baseQuery}
        ${joinClauses}
        WHERE ${whereClauses.join(' AND ')}
      `

      const sortColumn =
        sortBy === 'name' ? 'wf.name' :
        sortBy === 'date' ? 'f.modified_at' :
        sortBy === 'size' ? 'f.size' :
        sortBy === 'type' ? 'f.type' :
        sortBy === 'smartName' ? 'f.smart_name' :
        sortBy === 'qualityScore' ? 'fc.quality_score' :
        sortBy === 'author' ? 'f.author' :
        sortBy === 'language' ? 'f.language' :
        sortBy === 'analysisStatus' ? 'wf.is_analyzed' : 'wf.name'
      
      selectQuery += ` ORDER BY ${sortColumn} ${sortOrder.toUpperCase()} LIMIT ? OFFSET ?`
      
      const dbSelectStartTime = performance.now()
      const files = this.db.prepare(selectQuery).all(...queryParams, limit, offset) as any[]
      dbQueryTime += performance.now() - dbSelectStartTime

      const items = files.map((file) => {
        let relativePathPrefix = '';
        if (workspaceDirectoryPath) {
          const sep = path.sep;
          const prefix = workspaceDirectoryPath.endsWith(sep) ? workspaceDirectoryPath : workspaceDirectoryPath + sep;
          const fileDir = path.dirname(file.path);
          
          if (fileDir.startsWith(prefix)) {
            const relativePath = path.relative(workspaceDirectoryPath, fileDir)
            if (relativePath && relativePath !== '.') {
              relativePathPrefix = relativePath;
            }
          }
        }

        return {
          id: file.id.toString(),
          fileFingerprint: file.file_fingerprint,
          path: file.path,
          parentPath: path.dirname(file.path),
          name: file.name,
          smartName: file.smart_name || undefined,
          size: file.size,
          extension: file.type,
          mimeType: file.mime_type,
          createdAt: new Date(file.created_at),
          modifiedAt: new Date(file.modified_at),
          isDirectory: false,
          isAnalyzed: !!file.is_analyzed,
          qualityScore: file.quality_score || undefined,
          description: file.description || undefined,
          thumbnailPath: file.thumbnail_path || undefined,
          multimodalContent: undefined,
          relativePathPrefix: relativePathPrefix || undefined,
          author: file.author || undefined,
          language: file.language || undefined,
          tags: file.dimension_tags ? JSON.parse(file.dimension_tags) : []
        };
      })

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

  /**
   * Get files filtered by selected tags
   */
  async getFilteredFiles(params: {
    selectedTags: SelectedTag[]
    sortBy: VirtualDirectoryFilter['sortBy']
    sortOrder: 'asc' | 'desc'
    workspaceDirectoryPath?: string
    searchKeyword?: string
  }): Promise<FileItem[]> {
    try {
      const { selectedTags, sortBy, sortOrder, workspaceDirectoryPath, searchKeyword } = params

      const baseQuery = `
        FROM workspace_files wf
        JOIN files f ON wf.file_fingerprint = f.file_fingerprint
        LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
      `

      const whereClauses: string[] = ['wf.is_analyzed = 1']
      const queryParams: any[] = []

      if (workspaceDirectoryPath) {
        const sep = path.sep;
        const prefix = workspaceDirectoryPath.endsWith(sep) ? workspaceDirectoryPath : workspaceDirectoryPath + sep;
        whereClauses.push(`(wf.path LIKE ? OR wf.path = ?)`)
        queryParams.push(`${prefix}%`, workspaceDirectoryPath)
      }

      let joinClauses = ''
      if (selectedTags.length > 0) {
        joinClauses += `
          JOIN file_tag_relations ftr ON ftr.file_fingerprint = f.file_fingerprint
          JOIN file_tags ft ON ft.id = ftr.tag_id
        `
        const tagConditions: string[] = []
        for (const tag of selectedTags) {
          const allowedExts = this.getExtensionsForTag(tag.tagValue)
          if (allowedExts.length > 0) {
            const extList = allowedExts.map(() => '?').join(',')
            tagConditions.push(`(ft.dimension_id = ? AND ft.name = ? AND f.type IN (${extList}))`)
            queryParams.push(tag.dimensionId, tag.tagValue, ...allowedExts)
          } else {
            tagConditions.push(`(ft.dimension_id = ? AND ft.name = ?)`)
            queryParams.push(tag.dimensionId, tag.tagValue)
          }
        }
        whereClauses.push(`(${tagConditions.join(' OR ')})`)
      }

      if (searchKeyword && searchKeyword.trim()) {
        const keyword = searchKeyword.trim()
        const sanitizedQuery = `"${keyword.replace(/["]/g, '""')}"*`
        const likePattern = `%${keyword}%`
        
        whereClauses.push(`(
          f.file_fingerprint IN (SELECT file_fingerprint FROM files_fts WHERE files_fts MATCH ?)
          OR wf.name LIKE ?
          OR f.smart_name LIKE ?
          OR f.description LIKE ?
          OR f.file_fingerprint IN (
            SELECT ftr.file_fingerprint 
            FROM file_tag_relations ftr 
            JOIN file_tags ft ON ft.id = ftr.tag_id 
            WHERE ft.name LIKE ?
          )
        )`)
        queryParams.push(sanitizedQuery, likePattern, likePattern, likePattern, likePattern)
      }

      let selectQuery = `
        SELECT DISTINCT
          wf.id as id,
          f.file_fingerprint,
          wf.path,
          wf.name,
          f.smart_name,
          f.size,
          f.type,
          f.mime_type,
          f.created_at,
          f.modified_at,
          wf.is_analyzed,
          f.description,
          wf.thumbnail_path,
          f.author,
          f.language,
          fc.quality_score,
          (
            SELECT json_group_array(ft.name)
            FROM file_tag_relations ftr
            JOIN file_tags ft ON ft.id = ftr.tag_id
            WHERE ftr.file_fingerprint = f.file_fingerprint
          ) as dimension_tags
        ${baseQuery}
        ${joinClauses}
        WHERE ${whereClauses.join(' AND ')}
      `

      const sortColumn =
        sortBy === 'name' ? 'wf.name' :
        sortBy === 'date' ? 'f.modified_at' :
        sortBy === 'size' ? 'f.size' :
        sortBy === 'type' ? 'f.type' :
        sortBy === 'smartName' ? 'f.smart_name' :
        sortBy === 'qualityScore' ? 'fc.quality_score' :
        sortBy === 'author' ? 'f.author' :
        sortBy === 'language' ? 'f.language' :
        sortBy === 'analysisStatus' ? 'wf.is_analyzed' : 'wf.name'
      
      selectQuery += ` ORDER BY ${sortColumn} ${sortOrder.toUpperCase()}`

      const files = this.db.prepare(selectQuery).all(...queryParams) as any[]
      
      const { loadIgnoreRules, shouldIgnoreFile } = await import('../analysis/analysis-ignore-service')
      const ignoreRules = loadIgnoreRules()

      const filteredFiles = files.filter(file => {
        const safePath = file.path || '';
        const safeName = file.name || path.basename(safePath) || 'unknown';
        return !shouldIgnoreFile(safePath, safeName, ignoreRules);
      });

      return filteredFiles.map((file) => {
        let relativePathPrefix = '';
        if (workspaceDirectoryPath) {
          const sep = path.sep;
          const prefix = workspaceDirectoryPath.endsWith(sep) ? workspaceDirectoryPath : workspaceDirectoryPath + sep;
          const fileDir = path.dirname(file.path);

          if (fileDir === workspaceDirectoryPath || fileDir.startsWith(prefix)) {
            const relativePath = path.relative(workspaceDirectoryPath, fileDir)
            if (relativePath && relativePath !== '.') {
              relativePathPrefix = relativePath;
            }
          }
        }

        let allTags: string[] = []
        if (file.dimension_tags) {
          try {
            const dimTags = JSON.parse(file.dimension_tags)
            if (Array.isArray(dimTags)) allTags.push(...dimTags)
          } catch (e) { }
        }

        return {
          id: file.id.toString(),
          fileFingerprint: file.file_fingerprint,
          path: file.path,
          parentPath: path.dirname(file.path),
          name: file.name,
          smartName: file.smart_name || undefined,
          size: file.size,
          extension: file.type,
          mimeType: file.mime_type,
          createdAt: new Date(file.created_at),
          modifiedAt: new Date(file.modified_at),
          isDirectory: false,
          isAnalyzed: !!file.is_analyzed,
          qualityScore: file.quality_score || undefined,
          tags: allTags.length > 0 ? [...new Set(allTags)] : undefined,
          description: file.description || undefined,
          thumbnailPath: file.thumbnail_path || undefined,
          multimodalContent: undefined,
          relativePathPrefix: relativePathPrefix || undefined,
          author: file.author || undefined,
          language: file.language || undefined
        };
      })
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, 'Failed to get filtered files:', error)
      throw error
    }
  }

  /**
   * 检查虚拟目录tag链冲突
   */
  checkTagChainConflict(tagChain: string[], excludeId?: string, workspaceDirectoryPath?: string): { type: 'longer' | 'shorter', conflictName: string } | null {
    try {
      let query = 'SELECT id, name, filters FROM virtual_directories WHERE id != ?'
      const params: any[] = [excludeId || '']

      if (workspaceDirectoryPath) {
        query += ' AND workspace_id = (SELECT id FROM workspace_directories WHERE path = ?)'
        params.push(workspaceDirectoryPath)
      }

      const allDirectories = this.db.prepare(query).all(...params) as any[]

      for (const dir of allDirectories) {
        const filters = JSON.parse(dir.filters)
        const otherTagChain = filters.selectedTags.map((tag: any) => tag.tagValue)

        if (otherTagChain.length > tagChain.length) {
          const isPrefix = tagChain.every((tag, index) => tag === otherTagChain[index])
          if (isPrefix) {
            return { type: 'longer', conflictName: dir.name }
          }
        }
      }

      return null
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, 'Failed to check tag chain conflict:', error)
      return null
    }
  }

  /**
   * Save a virtual directory configuration
   */
  async saveDirectory(directory: SavedVirtualDirectory, workspaceDirectoryPath?: string): Promise<string | { error: string, conflictName: string } | undefined> {
    try {
      const tagChain = directory.filter.selectedTags.map((tag: any) => tag.tagValue)
      const conflict = this.checkTagChainConflict(tagChain, directory.id, workspaceDirectoryPath)

      if (conflict && conflict.type === 'longer') {
        return { error: 'conflict', conflictName: conflict.conflictName }
      }

      if (!workspaceDirectoryPath) throw new Error('工作目录路径不能为空')

      const directoryResult = this.db.prepare('SELECT id FROM workspace_directories WHERE path = ?').get(workspaceDirectoryPath) as any
      if (!directoryResult) throw new Error(`工作目录不存在: ${workspaceDirectoryPath}`)

      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO virtual_directories (id, name, description, filters, parent_id, workspace_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)

      stmt.run(
        directory.id,
        directory.name,
        directory.description || null,
        JSON.stringify(directory.filter),
        directory.parentId || null,
        directoryResult.id,
        directory.createdAt.toISOString(),
        directory.updatedAt.toISOString()
      )

      await this.createVirtualDirectoryStructure(workspaceDirectoryPath, directory)
      return path.join(workspaceDirectoryPath, VIRTUAL_DIRECTORY_FOLDER)
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, 'Failed to save virtual directory:', error)
      throw error
    }
  }

  /**
   * 批量保存虚拟目录
   */
  async batchSaveDirectories(
    directories: Array<{ name: string, filter: any, path: string[] }>,
    workspaceDirectoryPath: string
  ): Promise<Array<{ name: string, path: string }>> {
    try {
      const directoryResult = this.db.prepare('SELECT id FROM workspace_directories WHERE path = ?').get(workspaceDirectoryPath) as any
      if (!directoryResult) throw new Error(`工作目录不存在: ${workspaceDirectoryPath}`)
      const workspaceId = directoryResult.id

      const results: Array<{ name: string, path: string }> = []
      for (const dir of directories) {
        try {
          const savedDir: SavedVirtualDirectory = {
            id: `vdir-${Date.now()}-${Math.random().toString(36).substring(7)}`,
            name: dir.name,
            filter: dir.filter,
            workspaceId: workspaceId,
            parentId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }

          const result = await this.saveDirectory(savedDir, workspaceDirectoryPath)
          if (typeof result === 'object' && 'error' in result) continue

          results.push({
            name: dir.name,
            path: path.join(workspaceDirectoryPath, VIRTUAL_DIRECTORY_FOLDER, ...dir.path),
          })
        } catch (error) {
          logger.error(LogCategory.VIRTUAL_DIRECTORY, `导出虚拟目录失败: ${dir.name}`, error)
        }
      }
      return results
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, 'Failed to batch save directories:', error)
      throw error
    }
  }

  /**
   * Get all saved virtual directories
   */
  async getSavedDirectories(workspaceDirectoryPath?: string): Promise<SavedVirtualDirectory[]> {
    try {
      let query = `SELECT id, name, description, filters, parent_id, workspace_id, created_at, updated_at FROM virtual_directories`
      const params: any[] = []

      if (workspaceDirectoryPath) {
        query += ' WHERE workspace_id = (SELECT id FROM workspace_directories WHERE path = ?)'
        params.push(workspaceDirectoryPath)
      }

      query += ' ORDER BY created_at DESC'
      const directories = this.db.prepare(query).all(...params) as any[]

      return directories.map((dir) => ({
        id: dir.id,
        name: dir.name,
        description: dir.description || undefined,
        filter: JSON.parse(dir.filters),
        parentId: dir.parent_id || null,
        workspaceId: dir.workspace_id,
        createdAt: new Date(dir.created_at),
        updatedAt: new Date(dir.updated_at),
      }))
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, 'Failed to get saved directories:', error)
      throw error
    }
  }

  /**
   * 检查是否是第一个虚拟目录
   */
  async isFirstVirtualDirectory(workspaceDirectoryPath?: string): Promise<boolean> {
    try {
      let query = 'SELECT COUNT(*) as count FROM virtual_directories'
      const params: any[] = []
      if (workspaceDirectoryPath) {
        query += ' WHERE workspace_id = (SELECT id FROM workspace_directories WHERE path = ?)'
        params.push(workspaceDirectoryPath)
      }
      const count = this.db.prepare(query).get(...params) as any
      return count.count === 1
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, 'Failed to check first virtual directory:', error)
      return false
    }
  }

  /**
   * 重命名虚拟目录
   */
  async renameDirectory(id: string, newName: string): Promise<void> {
    try {
      this.db.prepare('UPDATE virtual_directories SET name = ?, updated_at = ? WHERE id = ?').run(newName, new Date().toISOString(), id)
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, 'Failed to rename virtual directory:', error)
      throw error
    }
  }

  /**
   * Delete a saved virtual directory
   */
  async deleteDirectory(id: string, workspaceDirectoryPath?: string): Promise<void> {
    try {
      const dirInfo = this.db.prepare('SELECT filters FROM virtual_directories WHERE id = ?').get(id) as any
      this.db.prepare('DELETE FROM virtual_directories WHERE id = ?').run(id)
      if (workspaceDirectoryPath && dirInfo) {
        const filters = JSON.parse(dirInfo.filters)
        await this.deleteTopLevelTagDirectory(workspaceDirectoryPath, filters.selectedTags)
      }
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, 'Failed to delete virtual directory:', error)
      throw error
    }
  }

  private async deleteTopLevelTagDirectory(workspaceDirectoryPath: string, selectedTags: any[]): Promise<void> {
    try {
      const virtualDirPath = path.join(workspaceDirectoryPath, VIRTUAL_DIRECTORY_FOLDER)
      if (!fs.existsSync(virtualDirPath) || !selectedTags || selectedTags.length === 0) return

      const allVirtualDirectories = this.db.prepare('SELECT filters FROM virtual_directories WHERE workspace_id = (SELECT id FROM workspace_directories WHERE path = ?)').all(workspaceDirectoryPath) as any[]
      const otherTagChains: string[][] = allVirtualDirectories.map(dir => JSON.parse(dir.filters).selectedTags.map((tag: any) => tag.tagValue))
      const tagChain = selectedTags.map(tag => tag.tagValue)
      await this.deleteTagChainRecursively(virtualDirPath, tagChain, otherTagChains)
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '删除tag目录链失败:', error)
    }
  }

  private async deleteTagChainRecursively(virtualDirPath: string, tagChain: string[], otherTagChains: string[][]): Promise<void> {
    if (tagChain.length === 0) return
    const currentPath = path.join(virtualDirPath, ...tagChain)
    if (!fs.existsSync(currentPath)) return

    const isUsedByOthers = otherTagChains.some(otherChain => otherChain.length >= tagChain.length && tagChain.every((tag, index) => tag === otherChain[index]))
    if (isUsedByOthers) return

    fs.rmSync(currentPath, { recursive: true, force: true })
    const parentTagChain = tagChain.slice(0, -1)
    if (parentTagChain.length > 0) await this.deleteTagChainRecursively(virtualDirPath, parentTagChain, otherTagChains)
  }

  async createVirtualDirectoryStructure(workspaceDirectoryPath: string, directory: SavedVirtualDirectory): Promise<void> {
    try {
      const virtualDirPath = path.join(workspaceDirectoryPath, VIRTUAL_DIRECTORY_FOLDER)
      if (!fs.existsSync(virtualDirPath)) fs.mkdirSync(virtualDirPath, { recursive: true })
      if (!fs.readdirSync(virtualDirPath).some(file => file.startsWith('ReadMe_'))) await this.copyReadmeFile(virtualDirPath)

      const tagChain = directory.filter.selectedTags.map((tag: any) => tag.tagValue)
      const allDirectories = this.db.prepare('SELECT id, filters FROM virtual_directories WHERE id != ?').all(directory.id) as any[]

      for (const dir of allDirectories) {
        const otherTagChain = JSON.parse(dir.filters).selectedTags.map((tag: any) => tag.tagValue)
        if (otherTagChain.length < tagChain.length && otherTagChain.every((tag: string, index: number) => tag === tagChain[index])) {
          this.db.prepare('DELETE FROM virtual_directories WHERE id = ?').run(dir.id)
        }
      }

      if (directory.filter.selectedTags.length > 0) {
        const tagPath = path.join(virtualDirPath, ...tagChain)
        if (fs.existsSync(tagPath)) fs.rmSync(tagPath, { recursive: true, force: true })
      }

      await this.createHierarchicalHardLinks(virtualDirPath, directory.filter.selectedTags, directory.filter.sortBy, directory.filter.sortOrder, workspaceDirectoryPath)
      const currentFiles = await this.getFilteredFiles({ selectedTags: directory.filter.selectedTags, sortBy: directory.filter.sortBy, sortOrder: directory.filter.sortOrder, workspaceDirectoryPath })
      await this.cleanupFilesInOtherVirtualDirectories(virtualDirPath, currentFiles, tagChain, workspaceDirectoryPath)
      await this.cleanupEmptyDirectories(virtualDirPath)
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '导出虚拟目录结构失败:', error)
      throw error
    }
  }

  private async createHierarchicalHardLinks(virtualDirPath: string, selectedTags: SelectedTag[], sortBy: any, sortOrder: 'asc' | 'desc', workspaceDirectoryPath?: string): Promise<void> {
    try {
      for (let level = 1; level <= selectedTags.length; level++) {
        const levelTags = selectedTags.slice(0, level)
        const files = await this.getFilteredFiles({ selectedTags: levelTags, sortBy, sortOrder, workspaceDirectoryPath })
        for (const file of files) await this.createHardLinkAtLevel(virtualDirPath, file, levelTags)
      }
      await this.deduplicateHardLinksFromBottom(virtualDirPath, selectedTags)
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '创建分层硬链接失败:', error)
      throw error
    }
  }

  private createLink(sourcePath: string, targetPath: string): void {
    try {
      if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath)
      fs.linkSync(sourcePath, targetPath)
    } catch (error: any) {
      if (error.code === 'EXDEV' || error.code === 'EPERM' || error.code === 'EACCES') {
        try {
          const type = process.platform === 'win32' ? 'file' : undefined
          fs.symlinkSync(sourcePath, targetPath, type)
        } catch (symlinkError: any) {
          throw symlinkError
        }
      } else throw error
    }
  }

  private async createHardLinkAtLevel(virtualDirPath: string, file: FileItem, levelTags: SelectedTag[]): Promise<void> {
    try {
      const tagPath = levelTags.map(t => t.tagValue).join(path.sep)
      const fullDirPath = path.join(virtualDirPath, tagPath)
      if (!fs.existsSync(fullDirPath)) fs.mkdirSync(fullDirPath, { recursive: true })

      let fileName: string
      if (file.smartName) {
        const originalExt = path.extname(file.name)
        const smartNameExt = path.extname(file.smartName)
        fileName = (!smartNameExt || smartNameExt !== originalExt) ? (smartNameExt ? file.smartName.slice(0, -smartNameExt.length) : file.smartName) + originalExt : file.smartName
      } else fileName = file.name

      this.createLink(file.path, path.join(fullDirPath, fileName))
    } catch (error) {}
  }

  private async deduplicateHardLinksFromBottom(virtualDirPath: string, selectedTags: SelectedTag[]): Promise<void> {
    try {
      for (let deepLevel = selectedTags.length; deepLevel > 1; deepLevel--) {
        const deepPath = path.join(virtualDirPath, ...selectedTags.slice(0, deepLevel).map(t => t.tagValue))
        if (!fs.existsSync(deepPath)) continue
        const deepFiles = this.getAllFilesInDirectory(deepPath)
        for (const deepFilePath of deepFiles) {
          const fileName = path.basename(deepFilePath)
          const deepStat = fs.statSync(deepFilePath)
          for (let parentLevel = 1; parentLevel < deepLevel; parentLevel++) {
            const parentPath = path.join(virtualDirPath, ...selectedTags.slice(0, parentLevel).map(t => t.tagValue))
            const parentFilePath = path.join(parentPath, fileName)
            if (fs.existsSync(parentFilePath)) {
              try {
                if (fs.statSync(parentFilePath).ino === deepStat.ino) fs.unlinkSync(parentFilePath)
              } catch (error) {}
            }
          }
        }
      }
    } catch (error) {}
  }

  private getAllFilesInDirectory(dirPath: string): string[] {
    const files: string[] = []
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)
        if (entry.isDirectory()) files.push(...this.getAllFilesInDirectory(fullPath))
        else if (entry.isFile() && !/^ReadMe_[a-zA-Z\-]{5}\.txt$/.test(entry.name)) files.push(fullPath)
      }
    } catch (error) {}
    return files
  }

  private async cleanupFilesInOtherVirtualDirectories(virtualDirPath: string, currentFiles: FileItem[], currentTagChain: string[], workspaceDirectoryPath?: string): Promise<void> {
    try {
      const allDirectories = this.db.prepare('SELECT filters FROM virtual_directories WHERE workspace_id = (SELECT id FROM workspace_directories WHERE path = ?)').all(workspaceDirectoryPath || '') as any[]
      const otherTagChains: string[][] = allDirectories.map(dir => JSON.parse(dir.filters).selectedTags.map((tag: any) => tag.tagValue)).filter(chain => JSON.stringify(chain) !== JSON.stringify(currentTagChain))
      if (otherTagChains.length === 0) return

      for (const file of currentFiles) {
        const fileName = this.getFileNameWithsmartName(file)
        const fileStat = fs.statSync(file.path)
        for (const otherTagChain of otherTagChains) {
          for (let level = 1; level <= otherTagChain.length; level++) {
            const otherFilePath = path.join(virtualDirPath, otherTagChain.slice(0, level).join(path.sep), fileName)
            if (fs.existsSync(otherFilePath)) {
              try {
                if (fs.statSync(otherFilePath).ino === fileStat.ino) fs.unlinkSync(otherFilePath)
              } catch (error) {}
            }
          }
        }
      }
    } catch (error) {}
  }

  private getFileNameWithsmartName(file: FileItem): string {
    if (file.smartName) {
      const originalExt = path.extname(file.name)
      const smartNameExt = path.extname(file.smartName)
      return (!smartNameExt || smartNameExt !== originalExt) ? (smartNameExt ? file.smartName.slice(0, -smartNameExt.length) : file.smartName) + originalExt : file.smartName
    } else return file.name
  }

  private async cleanupEmptyDirectories(dirPath: string): Promise<boolean> {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== THUMBNAIL_FOLDER) await this.cleanupEmptyDirectories(path.join(dirPath, entry.name))
      }
      if (fs.readdirSync(dirPath).length === 0 && !dirPath.endsWith(VIRTUAL_DIRECTORY_FOLDER)) {
        fs.rmdirSync(dirPath)
        return true
      }
      return false
    } catch (error) { return false }
  }

  private async copyReadmeFile(virtualDirPath: string): Promise<void> {
    try {
      const userLanguage = ConfigOrchestrator.getInstance().getValue('DEFAULT_LANGUAGE') || 'zh-CN'
      const readmeFileName = `ReadMe_${userLanguage}.txt`
      const sourceReadmePath = path.join(platformAdapter.getExtraResourcesPath(), '.VirtualDirectory', readmeFileName)
      const targetReadmePath = path.join(virtualDirPath, readmeFileName)
      if (fs.existsSync(sourceReadmePath)) fs.copyFileSync(sourceReadmePath, targetReadmePath)
    } catch (error) {}
  }

  private async createHardLinkForFile(virtualDirPath: string, file: FileItem, selectedTags: SelectedTag[]): Promise<void> {
    try {
      const fileTags = this.getFileTagsWithDimensions(file.id)
      if (fileTags.length === 0) return
      const tagPath = this.buildTagHierarchyPath(fileTags, selectedTags)
      if (!tagPath) return

      const fullDirPath = path.join(virtualDirPath, tagPath)
      if (!fs.existsSync(fullDirPath)) fs.mkdirSync(fullDirPath, { recursive: true })

      let fileName: string
      if (file.smartName) {
        const originalExt = path.extname(file.name)
        const smartNameExt = path.extname(file.smartName)
        fileName = (!smartNameExt || smartNameExt !== originalExt) ? (smartNameExt ? file.smartName.slice(0, -smartNameExt.length) : file.smartName) + originalExt : file.smartName
      } else fileName = file.name

      const linkPath = path.join(fullDirPath, fileName)
      const tagPathParts = tagPath.split(path.sep)
      for (let i = tagPathParts.length - 1; i > 0; i--) {
        const parentLinkPath = path.join(virtualDirPath, tagPathParts.slice(0, i).join(path.sep), fileName)
        if (fs.existsSync(parentLinkPath)) {
          try {
            if (fs.statSync(parentLinkPath).ino === fs.statSync(file.path).ino) fs.unlinkSync(parentLinkPath)
          } catch (error) {}
        }
      }
      this.createLink(file.path, linkPath)
    } catch (error) {}
  }

  private getFileTagsWithDimensions(fileId: string): Array<{ dimensionId: number, dimensionName: string, tagValue: string, level: number }> {
    try {
      const query = `
        SELECT fd.id as dimensionId, fd.name as dimensionName, ft.name as tagValue, fd.level as level
        FROM file_tag_relations ftr
        INNER JOIN file_tags ft ON ft.id = ftr.tag_id
        INNER JOIN file_dimensions fd ON fd.id = ft.dimension_id
        WHERE ftr.file_fingerprint = ?
        ORDER BY fd.level ASC
      `
      return this.db.prepare(query).all(fileId) as any[]
    } catch (error) { return [] }
  }

  private buildTagHierarchyPath(fileTags: Array<{ dimensionId: number; dimensionName: string; tagValue: string; level: number }>, selectedTags: SelectedTag[]): string | null {
    try {
      const selectedDimensionIds = new Set(selectedTags.map(t => t.dimensionId))
      const matchingTags = fileTags.filter(ft => selectedDimensionIds.has(ft.dimensionId))
      if (matchingTags.length === 0) return null
      matchingTags.sort((a, b) => a.level - b.level)
      return matchingTags.map(t => t.tagValue).join(path.sep)
    } catch (error) { return null }
  }

  async updateAllVirtualDirectories(workspaceDirectoryPath: string): Promise<void> {
    try {
      const savedDirectories = await this.getSavedDirectories(workspaceDirectoryPath)
      for (const directory of savedDirectories) {
        try { await this.createVirtualDirectoryStructure(workspaceDirectoryPath, directory) } catch (error) {}
      }
    } catch (error) {}
  }

  async cleanupVirtualDirectory(workspaceDirectoryPath: string): Promise<void> {
    try {
      const virtualDirPath = path.join(workspaceDirectoryPath, VIRTUAL_DIRECTORY_FOLDER)
      if (!fs.existsSync(virtualDirPath)) return
      const directory = this.db.prepare('SELECT workspace_id FROM workspaces WHERE path = ?').get(workspaceDirectoryPath) as any
      if (!directory) return

      const analyzedFiles = this.db.prepare('SELECT wf.name, wf.path FROM workspace_files wf WHERE wf.workspace_id = ? AND wf.is_analyzed = 1').all(directory.workspace_id) as Array<{ name: string; path: string }>
      const analyzedFileNames = new Set(analyzedFiles.map(f => f.name))
      const analyzedFilePaths = new Set(analyzedFiles.map(f => f.path))

      await this.cleanupDirectoryRecursive(virtualDirPath, analyzedFileNames, analyzedFilePaths)
    } catch (error) {}
  }

  private async cleanupDirectoryRecursive(dirPath: string, analyzedFileNames: Set<string>, analyzedFilePaths: Set<string>): Promise<void> {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === THUMBNAIL_FOLDER) continue
          await this.cleanupDirectoryRecursive(fullPath, analyzedFileNames, analyzedFilePaths)
          try { if (fs.readdirSync(fullPath).length === 0) fs.rmdirSync(fullPath) } catch (error) {}
        } else if (entry.isFile()) {
          if (/^ReadMe_[a-zA-Z\-]{5}\.txt$/.test(entry.name)) continue
          if (!analyzedFileNames.has(entry.name)) {
            try { fs.unlinkSync(fullPath) } catch (error) {}
          }
        }
      }
    } catch (error) {}
  }

  async generateFromPreviewTree(
    workspaceDirectoryPath: string,
    directoryTree: Array<{ 
      name: string
      parent: string
      description?: string
      files?: Array<{ name: string; smartName?: string; path?: string }>
      id?: string
      dimensionId?: number
      dimensionName?: string
      tagValue?: string
    }>,
    tagFileMap: Map<string, Array<{ name: string; smartName?: string; path?: string }>>,
    options: { flattenToRoot: boolean; skipEmptyDirectories: boolean; enableNestedClassification: boolean }
  ): Promise<{ success: boolean; fileCount: number; message: string }> {
    try {
      const workspaceResult = this.db.prepare('SELECT id FROM workspace_directories WHERE path = ?').get(workspaceDirectoryPath) as any
      if (!workspaceResult) throw new Error('Workspace directory not found')
      const workspaceId = workspaceResult.id

      const idToTagsMap = new Map<string, SelectedTag[]>()
      const idToRealIdMap = new Map<string, string>()

      for (const node of directoryTree) {
        const nodePreviewId = node.id || node.name
        let currentTags: SelectedTag[] = []
        if (node.dimensionId !== undefined && node.dimensionName && node.tagValue) {
          const selfTag: SelectedTag = { dimensionId: node.dimensionId, dimensionName: node.dimensionName, tagValue: node.tagValue, level: 0 }
          currentTags = (node.parent && idToTagsMap.has(node.parent)) ? [...idToTagsMap.get(node.parent)!, selfTag] : [selfTag]
        }
        idToTagsMap.set(nodePreviewId, currentTags)

        const parentDbId = node.parent ? idToRealIdMap.get(node.parent) : null
        const existing = this.db.prepare('SELECT id FROM virtual_directories WHERE name = ? AND workspace_id = ? AND (parent_id = ? OR (parent_id IS NULL AND ? IS NULL))').get(node.name, workspaceId, parentDbId, parentDbId) as any
        const dbId = existing ? existing.id : `vdir-${Date.now()}-${Math.random().toString(36).substring(7)}`
        idToRealIdMap.set(nodePreviewId, dbId)

        this.db.prepare('INSERT OR REPLACE INTO virtual_directories (id, name, description, filters, parent_id, workspace_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)').run(
          dbId, node.name, node.description || null, JSON.stringify({ selectedTags: currentTags, sortBy: 'name', sortOrder: 'asc', viewMode: 'list' }), parentDbId || null, workspaceId
        )
      }

      const virtualDirPath = path.join(workspaceDirectoryPath, VIRTUAL_DIRECTORY_FOLDER)
      let totalFileCount = 0

      if (fs.existsSync(virtualDirPath)) {
        for (const item of fs.readdirSync(virtualDirPath)) {
          if (item === 'ReadMe.md' || /^ReadMe_[a-zA-Z\-]{2,10}\.txt$/.test(item) || item === THUMBNAIL_FOLDER) continue
          const fullPath = path.join(virtualDirPath, item)
          try { if (fs.statSync(fullPath).isDirectory()) fs.rmSync(fullPath, { recursive: true, force: true }); else fs.unlinkSync(fullPath) } catch (e) {}
        }
      } else fs.mkdirSync(virtualDirPath, { recursive: true })

      if (!fs.readdirSync(virtualDirPath).some(file => file.startsWith('ReadMe_'))) await this.copyReadmeFile(virtualDirPath)

      if (options.flattenToRoot) {
        const allFiles = new Map<string, { path: string; name: string; smartName?: string }>()
        for (const node of directoryTree) node.files?.forEach(f => { if (f.path) allFiles.set(f.path, f as any) })
        for (const file of allFiles.values()) {
          try { this.createLink(file.path!, path.join(virtualDirPath, this.getFileNameWithsmartNameFromFileObj(file))); totalFileCount++ } catch (e) {}
        }
      } else {
        const createNodeStructure = (node: any, parentPath: string) => {
          const currentPath = path.join(parentPath, node.name)
          if (!fs.existsSync(currentPath)) fs.mkdirSync(currentPath, { recursive: true })
          node.files?.forEach((f: any) => {
            try { this.createLink(f.path!, path.join(currentPath, this.getFileNameWithsmartNameFromFileObj(f))); totalFileCount++ } catch (e) {}
          })
          const nodeIdentifier = node.id || node.name
          directoryTree.filter(n => n !== node && n.parent === nodeIdentifier).forEach(child => createNodeStructure(child, currentPath))
        }
        directoryTree.filter(node => !node.parent || node.parent === '').forEach(node => createNodeStructure(node, virtualDirPath))
      }

      if (options.skipEmptyDirectories) await this.cleanupEmptyDirectories(virtualDirPath)
      return { success: true, fileCount: totalFileCount, message: `成功导出虚拟目录，包含 ${totalFileCount} 个文件` }
    } catch (error) { throw error }
  }

  private getFileNameWithsmartNameFromFileObj(file: { name: string; smartName?: string; path?: string }): string {
    if (file.smartName) {
      const originalExt = path.extname(file.name)
      const smartNameExt = path.extname(file.smartName)
      return (!smartNameExt || smartNameExt !== originalExt) ? (smartNameExt ? file.smartName.slice(0, -smartNameExt.length) : file.smartName) + originalExt : file.smartName
    } else return file.name
  }
}

export const virtualDirectoryService = new VirtualDirectoryService()
