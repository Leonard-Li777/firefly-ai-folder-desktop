import { CATEGORY_EXT_MAP, LogCategory, logger } from '@yonuc/shared'
import { DimensionGroup, DimensionTag, SavedVirtualDirectory, SelectedTag, VirtualDirectoryFilter } from '@yonuc/types'

import Database from 'better-sqlite3'
import { FileItem } from '@yonuc/types'
import { configService } from '../config'
import { databaseService } from '../database/database-service'
import fs from 'node:fs'
import path from 'node:path'
import { platformAdapter } from '../system/platform-adapter'
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
  async getDimensionGroups(workspaceDirectoryPath?: string, language: string = 'zh-CN'): Promise<DimensionGroup[]> {
    try {
      // 1. 获取所有原始维度数据
      const rawDimensions = this.db
        .prepare('SELECT id, name, tags, trigger_conditions, level FROM file_dimensions ORDER BY level ASC')
        .all() as any[]

      // 创建名称到 ID 的映射
      const nameToIdMap = new Map<string, number>()
      rawDimensions.forEach(d => {
        if (d.name) {
          nameToIdMap.set(d.name.trim(), d.id)
        }
      })

      const groups: DimensionGroup[] = []

      // 2. 处理每个维度并统计标签计数
      for (const dim of rawDimensions) {
        // --- 标签处理逻辑 ---
        const configShowEmptyTags = configService.getValue<boolean>('SHOW_EMPTY_TAGS') ?? false
        
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

        // --- 标签计数查询逻辑 (增加后缀分组以支持物理类型校验) ---
        let countQuery = `
          SELECT ft.name as tag_name, f.type as file_type, COUNT(DISTINCT f.file_fingerprint) as count
          FROM file_tags ft
          LEFT JOIN file_tag_relations ftr ON ftr.tag_id = ft.id
          LEFT JOIN files f ON f.file_fingerprint = ftr.file_fingerprint
          JOIN workspace_files wf ON f.file_fingerprint = wf.file_fingerprint AND wf.is_analyzed = 1
          WHERE ft.dimension_id = ?
        `
        const countParams: any[] = [dim.id]

        if (workspaceDirectoryPath) {
          const normalizedPath = path.normalize(workspaceDirectoryPath);
          const pathSep = path.sep;
          countQuery += ` AND (wf.path LIKE ? OR wf.path = ?)`;
          countParams.push(`${normalizedPath}${pathSep}%`, normalizedPath);
        }

        countQuery += ` GROUP BY ft.name, f.type`
        
        const tagCounts = new Map<string, number>()
        const countResults = this.db.prepare(countQuery).all(...countParams) as { tag_name: string, file_type: string, count: number }[]
        
        countResults.forEach(r => {
          const allowedExts = this.getExtensionsForTag(r.tag_name)
          // 核心校验：如果该标签有明确的物理类型限制（如“视频”），但文件后缀不符，则不予计数
          if (allowedExts.length > 0) {
            const fileExt = r.file_type?.toLowerCase() || ''
            if (!allowedExts.includes(fileExt)) return 
          }
          const current = tagCounts.get(r.tag_name) || 0
          tagCounts.set(r.tag_name, current + r.count)
        })

        // --- 上下文标签计数逻辑 (处理父子关联过滤，如：只统计“影视”下的“题材”) ---
        const contextualTags: Record<string, DimensionTag[]> = {}
        if (triggerConditions && Array.isArray(triggerConditions)) {
          for (const tc of triggerConditions) {
            const parentDimId = nameToIdMap.get(tc.parentDimension?.trim())
            if (!parentDimId) continue

            for (const parentTagValue of tc.triggerTags) {
              // --- 物理类型硬过滤逻辑 (基于翻译和统一常量) ---
              let typeFilterSql = ''
              const extensions: string[] = []
              
              // 获取当前语言下的分类标签名称，用于匹配
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

              if (extensions.length > 0) {
                typeFilterSql = ` AND f.type IN (${extensions.map(() => '?').join(',')})`
              }

              let parentTagCondition = `
                EXISTS (
                  SELECT 1 FROM file_tag_relations pftr
                  JOIN file_tags pft ON pft.id = pftr.tag_id
                  WHERE pftr.file_fingerprint = f.file_fingerprint AND pft.dimension_id = ? AND pft.name = ?
                )
              `
              const contextualParams: any[] = [dim.id, parentDimId, parentTagValue]

              if (extensions.length > 0) {
                const extPhs = extensions.map(() => '?').join(',')
                parentTagCondition = `(${parentTagCondition} OR f.type IN (${extPhs}))`
                contextualParams.push(...extensions)
              }

              let contextualCountQuery = `
                SELECT ft.name as tag_name, f.type as file_type, COUNT(DISTINCT f.file_fingerprint) as count
                FROM file_tags ft
                JOIN file_tag_relations ftr ON ftr.tag_id = ft.id
                JOIN files f ON f.file_fingerprint = ftr.file_fingerprint
                JOIN workspace_files wf ON f.file_fingerprint = wf.file_fingerprint AND wf.is_analyzed = 1
                WHERE ft.dimension_id = ? AND ${parentTagCondition}
              `
              
              if (workspaceDirectoryPath) {
                const normalizedPath = path.normalize(workspaceDirectoryPath);
                const pathSep = path.sep;
                contextualCountQuery += ` AND (wf.path LIKE ? OR wf.path = ?)`;
                contextualParams.push(`${normalizedPath}${pathSep}%`, normalizedPath);
              }

              contextualCountQuery += ` GROUP BY ft.name, f.type`
              
              const cTagCounts = new Map<string, number>()
              try {
                const cCountResults = this.db.prepare(contextualCountQuery).all(...contextualParams) as { tag_name: string, file_type: string, count: number }[]
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

      return groups
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, 'Failed to get dimension groups:', error)
      throw error
    }
  }

  /**
   * 获取已分析文件的数量
   * @param workspaceDirectoryPath 工作目录路径（可选）。如果为空，则统计所有私有工作区的文件
   * @returns 已分析文件的数量
   */
  async getAnalyzedFilesCount(workspaceDirectoryPath?: string): Promise<number> {
    try {
      let query = ''
      const params: any[] = []

      if (workspaceDirectoryPath) {
        // 统计特定目录及其子目录下的唯一文件
        query = 'SELECT COUNT(DISTINCT file_fingerprint) as count FROM workspace_files WHERE is_analyzed = 1'
        const normalizedPath = path.normalize(workspaceDirectoryPath);
        const pathSep = path.sep;
        query += ` AND (path LIKE ? OR path = ?)`;
        params.push(`${normalizedPath}${pathSep}%`, normalizedPath);
        
        logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 查询特定目录已分析文件计数', { 
          workspaceDirectoryPath,
          normalizedPath,
          pathSep,
          params
        });
      } else {
        // 全局统计：所有 PRIVATE 类型工作区下的唯一文件指纹数
        query = `
          SELECT COUNT(DISTINCT file_fingerprint) as count 
          FROM workspace_files 
          WHERE is_analyzed = 1 
          AND workspace_id IN (SELECT workspace_id FROM workspaces WHERE type = 'PRIVATE')
        `
        logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 全局统计私有工作区已分析文件计数')
      }

      const result = this.db.prepare(query).get(...params) as any
      const count = result?.count || 0
      
      // 增加调试日志：随机查出 5 个匹配的文件路径
      if (workspaceDirectoryPath && count > 0) {
        try {
          const sampleFiles = this.db.prepare(`SELECT path FROM workspace_files WHERE is_analyzed = 1 AND (path LIKE ? OR path = ?) LIMIT 5`).all(...params) as { path: string }[]
          logger.info(LogCategory.VIRTUAL_DIRECTORY, `[配额调试] 目录: ${workspaceDirectoryPath}, 样本文件: ${JSON.stringify(sampleFiles.map(f => f.path))}`)
        } catch (e) {
          logger.error(LogCategory.VIRTUAL_DIRECTORY, '[配额调试] 获取样本文件失败', e)
        }
      }
      
      logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 已分析文件计数结果:', count)
      return count
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
   * 获取所有私有工作目录下的已分析文件总数
   * 用于"全部文件"虚拟目录的计数
   */
  async getPrivateAnalyzedFilesCount(): Promise<number> {
    // 直接调用 getAnalyzedFilesCount 的全局统计逻辑
    return this.getAnalyzedFilesCount()
  }

  /**
   * Get files filtered by selected tags
   */
  async getFilteredFiles(params: {
    selectedTags: SelectedTag[]
    sortBy: VirtualDirectoryFilter['sortBy']
    sortOrder: 'asc' | 'desc'
    workspaceDirectoryPath?: string
    searchKeyword?: string // 新增搜索关键词参数
  }): Promise<FileItem[]> {
    try {
      const { selectedTags, sortBy, sortOrder, workspaceDirectoryPath, searchKeyword } = params

      let query = `
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
          fc.quality_score,
          f.description,
          wf.thumbnail_path,
          fc.multimodal_content,
          f.author,
          f.language,
          (
            SELECT json_group_array(ft.name)
            FROM file_tag_relations ftr
            JOIN file_tags ft ON ft.id = ftr.tag_id
            WHERE ftr.file_fingerprint = f.file_fingerprint
          ) as dimension_tags
        FROM workspace_files wf
        JOIN files f ON wf.file_fingerprint = f.file_fingerprint
        LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
      `

      const whereClauses: string[] = []
      const queryParams: any[] = []

      // Add filter for analyzed files only
      whereClauses.push('wf.is_analyzed = 1')

      // Filter by workspace directory if provided (包括所有子目录)
      // 使用 path 模块原生处理路径，不进行归一化
      if (workspaceDirectoryPath) {
        const normalizedPath = path.normalize(workspaceDirectoryPath);
        // 使用原生路径分隔符进行 LIKE 匹配
        const pathSep = path.sep;
        whereClauses.push(`(wf.path LIKE ? OR wf.path = ?)`)
        queryParams.push(`${normalizedPath}${pathSep}%`, normalizedPath)
      }

      // If tags are selected, add tag filters
      if (selectedTags.length > 0) {
        for (let i = 0;i < selectedTags.length;i++) {
          const tag = selectedTags[i]
          query += `
            INNER JOIN file_tag_relations ftr${i} ON ftr${i}.file_fingerprint = f.file_fingerprint
            INNER JOIN file_tags ft${i} ON ft${i}.id = ftr${i}.tag_id
          `
          // 修正：ft.dimension_id 替换 ft.dimension
          whereClauses.push(`ft${i}.dimension_id = ? AND ft${i}.name = ?`)
          queryParams.push(tag.dimensionId, tag.tagValue)

          // --- 核心修复：物理类型硬过滤校验 ---
          // 当选中某个具有物理类型暗示的标签（如“视频”）时，强制过滤文件后缀
          const allowedExts = this.getExtensionsForTag(tag.tagValue)
          if (allowedExts.length > 0) {
            whereClauses.push(`f.type IN (${allowedExts.map(() => '?').join(',')})`)
            queryParams.push(...allowedExts)
          }
        }
      }

      // Add search keyword filter (使用高性能 FTS5 全文搜索 + LIKE 兜底)
      if (searchKeyword && searchKeyword.trim()) {
        const keyword = searchKeyword.trim()
        const sanitizedQuery = `"${keyword.replace(/["]/g, '""')}"*`
        const likePattern = `%${keyword}%`
        
        // 修正：将 MATCH 放入子查询以避免在复杂的 OR 逻辑中出现上下文错误
        whereClauses.push(`(
          f.file_fingerprint IN (SELECT file_fingerprint FROM files_fts WHERE files_fts MATCH ?)
          OR wf.name LIKE ?
          OR f.smart_name LIKE ?
          OR f.description LIKE ?
        )`)
        queryParams.push(sanitizedQuery, likePattern, likePattern, likePattern)
      }

      if (whereClauses.length > 0) {
        query += ` WHERE ${whereClauses.join(' AND ')}`
      }

      // Add sorting
      const sortColumn =
        sortBy === 'name'
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
      query += ` ORDER BY ${sortColumn} ${sortOrder.toUpperCase()}`

      const files = this.db.prepare(query).all(...queryParams) as any[]
      
      // 加载忽略规则
      const { loadIgnoreRules, shouldIgnoreFile } = await import('../analysis/analysis-ignore-service')
      const ignoreRules = loadIgnoreRules()

      // 调试：检查是否包含未分析文件
      const unanalyzedCount = files.filter(f => f.is_analyzed !== 1 && f.is_analyzed !== true).length;
      if (unanalyzedCount > 0) {
        logger.warn(LogCategory.VIRTUAL_DIRECTORY, `[VirtualDirectory] getFilteredFiles 发现 ${unanalyzedCount} 条未分析记录（不应该出现）`);
      }
      
      // 应用忽略规则过滤
      const filteredFiles = files.filter(file => {
        const safePath = file.path || '';
        const safeName = file.name || path.basename(safePath) || 'unknown';
        return !shouldIgnoreFile(safePath, safeName, ignoreRules);
      });

      logger.debug(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] getFilteredFiles 查询结果数量:', { 
        total: files.length, 
        afterIgnore: filteredFiles.length 
      })

      return filteredFiles.map((file) => {
        // 计算相对于工作目录的路径前缀
        let relativePathPrefix = '';
        if (workspaceDirectoryPath) {
          const normalizedFilePath = path.normalize(file.path);
          const normalizedMonitorPath = path.normalize(workspaceDirectoryPath);

          // 获取文件所在目录
          const fileDir = path.dirname(normalizedFilePath);

          // 如果文件在工作目录或其子目录中
          if (fileDir.startsWith(normalizedMonitorPath)) {
            // 计算相对路径
            const relativePath = path.relative(normalizedMonitorPath, fileDir)
            if (relativePath && relativePath !== '.') {
              relativePathPrefix = relativePath;
            }
          }
        }

        // 合并维度标签
        let allTags: string[] = []
        if (file.dimension_tags) {
          try {
            const dimTags = JSON.parse(file.dimension_tags)
            if (Array.isArray(dimTags)) {
              allTags.push(...dimTags)
            }
          } catch (e) { }
        }

        // 去重
        allTags = [...new Set(allTags)]

        return {
          id: file.id.toString(), // file_id
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
          tags: allTags.length > 0 ? allTags : undefined,
          description: file.description || undefined,
          thumbnailPath: file.thumbnail_path || undefined,
          multimodalContent: file.multimodal_content || undefined,
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
   * @param tagChain 要保存的tag链
   * @param excludeId 要排除的虚拟目录ID（用于更新现有目录时）
   * @param workspaceDirectoryPath 工作目录路径（用于限制冲突检查范围）
   * @returns 冲突信息，如果没有冲突返回null
   */
  checkTagChainConflict(tagChain: string[], excludeId?: string, workspaceDirectoryPath?: string): { type: 'longer' | 'shorter', conflictName: string } | null {
    try {
      // 获取当前工作目录的所有虚拟目录（仅在同一工作目录内检查冲突）
      let query = 'SELECT id, name, filters FROM virtual_directories WHERE id != ?'
      const params: any[] = [excludeId || '']

      if (workspaceDirectoryPath) {
        query += ' AND workspace_id = (SELECT id FROM workspace_directories WHERE path = ?)'
        params.push(workspaceDirectoryPath)
      }

      const allDirectories = this.db
        .prepare(query)
        .all(...params) as any[]

      for (const dir of allDirectories) {
        const filters = JSON.parse(dir.filters)
        const otherTagChain = filters.selectedTags.map((tag: any) => tag.tagValue)

        // 检查当前tag链是否是其他tag链的前部分（不允许保存更短的）
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
   * @returns 虚拟目录的物理路径（如果创建成功）或错误信息对象
   */
  async saveDirectory(directory: SavedVirtualDirectory, workspaceDirectoryPath?: string): Promise<string | { error: string, conflictName: string } | undefined> {
    try {
      // 检查tag链冲突（仅在同一工作目录内检查）
      const tagChain = directory.filter.selectedTags.map((tag: any) => tag.tagValue)
      const conflict = this.checkTagChainConflict(tagChain, directory.id, workspaceDirectoryPath)

      if (conflict && conflict.type === 'longer') {
        // 不允许保存更短的tag链
        return {
          error: 'conflict',
          conflictName: conflict.conflictName
        }
      }

      // 获取工作目录ID
      if (!workspaceDirectoryPath) {
        throw new Error('工作目录路径不能为空')
      }

      const directoryResult = this.db
        .prepare('SELECT id FROM workspace_directories WHERE path = ?')
        .get(workspaceDirectoryPath) as any

      if (!directoryResult) {
        throw new Error(`工作目录不存在: ${workspaceDirectoryPath}`)
      }

      // 保存到数据库（包含workspace_id）
      const stmt = this.db.prepare (`
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

      // 创建物理虚拟目录结构
      await this.createVirtualDirectoryStructure(workspaceDirectoryPath, directory)
      // 返回虚拟目录路径
      return path.join(workspaceDirectoryPath, VIRTUAL_DIRECTORY_FOLDER)
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, 'Failed to save virtual directory:', error)
      throw error
    }
  }

  /**
   * 批量保存虚拟目录（用于生成多个虚拟目录）
   * @param directories 要创建的虚拟目录列表
   * @param workspaceDirectoryPath 工作目录路径
   * @returns 创建成功的虚拟目录列表
   */
  async batchSaveDirectories(
    directories: Array<{ 
      name: string
      filter: any
      path: string[]
    }>,
    workspaceDirectoryPath: string
  ): Promise<Array<{ name: string, path: string }>> {
    try {
      logger.info(
        LogCategory.VIRTUAL_DIRECTORY,
        `[VirtualDirectory] 批量创建虚拟目录，数量: ${directories.length}`
      )

      // 获取工作目录ID
      const directoryResult = this.db
        .prepare('SELECT id FROM workspace_directories WHERE path = ?')
        .get(workspaceDirectoryPath) as any

      if (!directoryResult) {
        throw new Error(`工作目录不存在: ${workspaceDirectoryPath}`)
      }
      const workspaceId = directoryResult.id

      const results: Array<{ name: string, path: string }> = []

      for (const dir of directories) {
        try {
          // 构建SavedVirtualDirectory对象
          const savedDir: SavedVirtualDirectory = {
            id: `vdir-${Date.now()}-${Math.random().toString(36).substring(7)}`,
            name: dir.name,
            filter: dir.filter,
            workspaceId: workspaceId,
            parentId: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          }

          // 保存虚拟目录
          const result = await this.saveDirectory(savedDir, workspaceDirectoryPath)

          // 检查是否有冲突错误
          if (typeof result === 'object' && 'error' in result) {
            logger.warn(
              LogCategory.VIRTUAL_DIRECTORY,
              `[VirtualDirectory] 虚拟目录创建失败（冲突）: ${dir.name}`
            )
            continue
          }

          // 构建虚拟目录的完整路径
          const virtualDirPath = path.join(
            workspaceDirectoryPath,
            VIRTUAL_DIRECTORY_FOLDER,
            ...dir.path
          )

          results.push({
            name: dir.name,
            path: virtualDirPath,
          })

          logger.info(
            LogCategory.VIRTUAL_DIRECTORY,
            `[VirtualDirectory] 虚拟目录创建成功: ${dir.name}`
          )
        } catch (error) {
          logger.error(
            LogCategory.VIRTUAL_DIRECTORY,
            `[VirtualDirectory] 创建虚拟目录失败: ${dir.name}`,
            error
          )
          // 继续处理下一个虚拟目录
        }
      }

      logger.info(
        LogCategory.VIRTUAL_DIRECTORY,
        `[VirtualDirectory] 批量创建完成，成功: ${results.length}/${directories.length}`
      )

      return results
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, 'Failed to batch save directories:', error)
      throw error
    }
  }

  /**
   * Get all saved virtual directories
   * @param workspaceDirectoryPath 工作目录路径（可选，如果提供则只返回该目录的虚拟目录）
   */
  async getSavedDirectories(workspaceDirectoryPath?: string): Promise<SavedVirtualDirectory[]> {
    try {
      let query = `
        SELECT id, name, description, filters, parent_id, workspace_id, created_at, updated_at
        FROM virtual_directories
      `
      const params: any[] = []

      if (workspaceDirectoryPath) {
        query += ' WHERE workspace_id = (SELECT id FROM workspace_directories WHERE path = ?)'
        params.push(workspaceDirectoryPath)
      }

      query += ' ORDER BY created_at DESC'

      const directories = this.db
        .prepare(query)
        .all(...params) as any[]

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
   * 检查是否是当前工作目录的第一个虚拟目录
   * @param workspaceDirectoryPath 工作目录路径
   */
  async isFirstVirtualDirectory(workspaceDirectoryPath?: string): Promise<boolean> {
    try {
      let query = 'SELECT COUNT(*) as count FROM virtual_directories'
      const params: any[] = []

      if (workspaceDirectoryPath) {
        query += ' WHERE workspace_id = (SELECT id FROM workspace_directories WHERE path = ?)'
        params.push(workspaceDirectoryPath)
      }

      const count = this.db
        .prepare(query)
        .get(...params) as any
      return count.count === 1
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, 'Failed to check first virtual directory:', error)
      return false
    }
  }

  /**
   * 重命名虚拟目录
   * @param id 虚拟目录ID
   * @param newName 新名称
   */
  async renameDirectory(id: string, newName: string): Promise<void> {
    try {
      const stmt = this.db.prepare (`
        UPDATE virtual_directories 
        SET name = ?, updated_at = ? 
        WHERE id = ?
      `)
      stmt.run(newName, new Date().toISOString(), id)
      logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 虚拟目录已重命名:', id, newName)
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, 'Failed to rename virtual directory:', error)
      throw error
    }
  }

  /**
   * Delete a saved virtual directory
   * @param id 虚拟目录ID
   * @param workspaceDirectoryPath 工作目录路径（可选，如果提供则删除对应的顶级tag目录）
   */
  async deleteDirectory(id: string, workspaceDirectoryPath?: string): Promise<void> {
    try {
      // 先获取虚拟目录的filter信息，用于确定要删除的顶级tag
      const dirInfo = this.db
        .prepare('SELECT filters FROM virtual_directories WHERE id = ?')
        .get(id) as any

      // 从数据库中删除记录
      this.db.prepare('DELETE FROM virtual_directories WHERE id = ?').run(id)

      // 如果提供了工作目录路径，删除对应的顶级tag目录
      if (workspaceDirectoryPath && dirInfo) {
        const filters = JSON.parse(dirInfo.filters)
        await this.deleteTopLevelTagDirectory(workspaceDirectoryPath, filters.selectedTags)
      }
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, 'Failed to delete virtual directory:', error)
      throw error
    }
  }

  /**
   * 删除虚拟目录对应的tag目录链
   * 从底层向上递归删除，检查每层是否被其他虚拟目录使用
   * @param workspaceDirectoryPath 工作目录路径
   * @param selectedTags 选中的标签列表
   */
  private async deleteTopLevelTagDirectory(
    workspaceDirectoryPath: string,
    selectedTags: any[]
  ): Promise<void> {
    try {
      const virtualDirPath = path.join(workspaceDirectoryPath, VIRTUAL_DIRECTORY_FOLDER)

      // 检查虚拟目录是否存在
      if (!fs.existsSync(virtualDirPath)) {
        logger.info(
          LogCategory.VIRTUAL_DIRECTORY,
          '[VirtualDirectory] 虚拟目录不存在，无需删除:',
          virtualDirPath
        )
        return
      }

      if (!selectedTags || selectedTags.length === 0) {
        return
      }

      // 获取当前工作目录的所有其他虚拟目录的tag链
      const allVirtualDirectories = this.db
        .prepare(`
          SELECT filters FROM virtual_directories
          WHERE workspace_id = (SELECT id FROM workspace_directories WHERE path = ?)
        `)
        .all(workspaceDirectoryPath) as any[]

      const otherTagChains: string[][] = allVirtualDirectories.map(dir => {
        const filters = JSON.parse(dir.filters)
        return filters.selectedTags.map((tag: any) => tag.tagValue)
      })

      // 构建要删除的tag链（按priority排序的tag值）
      const tagChain = selectedTags.map(tag => tag.tagValue)

      // 从最底层开始向上删除
      await this.deleteTagChainRecursively(virtualDirPath, tagChain, otherTagChains)
    } catch (error) {
      logger.error(
        LogCategory.VIRTUAL_DIRECTORY,
        '[VirtualDirectory] 删除tag目录链失败:',
        error
      )
      // 不抛出错误，避免影响数据库删除
    }
  }

  /**
   * 递归删除tag目录链
   * @param virtualDirPath .VirtualDirectory目录路径
   * @param tagChain 要删除的tag链
   * @param otherTagChains 其他虚拟目录的tag链列表
   */
  private async deleteTagChainRecursively(
    virtualDirPath: string,
    tagChain: string[],
    otherTagChains: string[][]
  ): Promise<void> {
    if (tagChain.length === 0) {
      return
    }

    // 构建当前层级的完整路径
    const currentPath = path.join(virtualDirPath, ...tagChain)

    // 检查目录是否存在
    if (!fs.existsSync(currentPath)) {
      logger.info(
        LogCategory.VIRTUAL_DIRECTORY,
        '[VirtualDirectory] 目录不存在，跳过:',
        currentPath
      )
      return
    }

    // 检查当前tag链是否被其他虚拟目录使用
    const isUsedByOthers = otherTagChains.some(otherChain => {
      // 检查otherChain是否以当前tagChain开头
      if (otherChain.length < tagChain.length) {
        return false
      }
      return tagChain.every((tag, index) => tag === otherChain[index])
    })

    if (isUsedByOthers) {
      logger.info(
        LogCategory.VIRTUAL_DIRECTORY,
        '[VirtualDirectory] 目录被其他虚拟目录使用，停止删除:',
        currentPath
      )
      return
    }

    // 删除当前目录
    fs.rmSync(currentPath, { recursive: true, force: true })
    logger.info(
      LogCategory.VIRTUAL_DIRECTORY,
      '[VirtualDirectory] 已删除目录:',
      currentPath
    )

    // 向上递归删除父目录（移除最后一个tag）
    const parentTagChain = tagChain.slice(0, -1)
    if (parentTagChain.length > 0) {
      await this.deleteTagChainRecursively(virtualDirPath, parentTagChain, otherTagChains)
    }
  }

  /**
   * 创建虚拟目录物理结构
   * 1. 创建 .VirtualDirectory 文件夹（如果不存在）
   * 2. 复制对应语言的ReadMe文件
   * 3. 检查并删除被覆盖的更短tag链的虚拟目录
   * 4. 删除该虚拟目录对应的tag目录链（如果存在）
   * 5. 为文件在所有匹配的层级创建硬链接（分层创建）
   * 6. 清理文件在其他虚拟目录中的旧硬链接（互斥性）
   */
  async createVirtualDirectoryStructure(
    workspaceDirectoryPath: string,
    directory: SavedVirtualDirectory
  ): Promise<void> {
    try {
      logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 开始创建虚拟目录结构:', workspaceDirectoryPath)

      // 1. 创建 .VirtualDirectory 文件夹
      const virtualDirPath = path.join(workspaceDirectoryPath, VIRTUAL_DIRECTORY_FOLDER)
      if (!fs.existsSync(virtualDirPath)) {
        fs.mkdirSync(virtualDirPath, { recursive: true })
        logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 创建虚拟目录文件夹:', virtualDirPath)
      }

      // 2. 复制ReadMe文件（只在首次创建.VirtualDirectory时复制）
      const readmeExists = fs.readdirSync(virtualDirPath).some(file => file.startsWith('ReadMe_'))
      if (!readmeExists) {
        await this.copyReadmeFile(virtualDirPath)
      }

      // 3. 检查并删除被覆盖的更短tag链的虚拟目录
      // 查找所有tag链是当前tag链前缀的虚拟目录
      const tagChain = directory.filter.selectedTags.map((tag: any) => tag.tagValue)
      const allDirectories = this.db
        .prepare('SELECT id, name, filters FROM virtual_directories WHERE id != ?')
        .all(directory.id) as any[]

      for (const dir of allDirectories) {
        const filters = JSON.parse(dir.filters)
        const otherTagChain = filters.selectedTags.map((tag: any) => tag.tagValue)

        // 如果其他tag链是当前tag链的前缀（更短），则删除该虚拟目录
        if (otherTagChain.length < tagChain.length) {
          const isPrefix = otherTagChain.every((tag: string, index: number) => tag === tagChain[index])
          if (isPrefix) {
            logger.info(
              LogCategory.VIRTUAL_DIRECTORY,
              '[VirtualDirectory] 检测到更短的tag链虚拟目录，自动删除:',
              dir.name
            )
            // 从数据库中删除
            this.db.prepare('DELETE FROM virtual_directories WHERE id = ?').run(dir.id)
          }
        }
      }

      // 4. 删除该虚拟目录对应的tag目录链（如果存在）
      // 这会删除旧的文件链接，为新的腾出空间
      if (directory.filter.selectedTags.length > 0) {
        const tagPath = path.join(virtualDirPath, ...tagChain)
        if (fs.existsSync(tagPath)) {
          fs.rmSync(tagPath, { recursive: true, force: true })
          logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 已删除旧的tag目录链:', tagPath)
        }
      }

      // 5. 为文件在所有匹配的层级创建硬链接（分层创建）
      // 对于每个selectedTags的前缀层级，获取对应的文件并创建硬链接
      await this.createHierarchicalHardLinks(
        virtualDirPath,
        directory.filter.selectedTags,
        directory.filter.sortBy,
        directory.filter.sortOrder,
        workspaceDirectoryPath
      )

      // 6. 清理文件在其他虚拟目录中的旧硬链接（互斥性）
      // 获取当前虚拟目录的所有文件
      const currentFiles = await this.getFilteredFiles({
        selectedTags: directory.filter.selectedTags,
        sortBy: directory.filter.sortBy,
        sortOrder: directory.filter.sortOrder,
        workspaceDirectoryPath,
      })

      await this.cleanupFilesInOtherVirtualDirectories(
        virtualDirPath,
        currentFiles,
        tagChain,
        workspaceDirectoryPath
      )

      // 7. 清理空目录
      await this.cleanupEmptyDirectories(virtualDirPath)

      logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 虚拟目录结构创建完成')
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 创建虚拟目录结构失败:', error)
      throw error
    }
  }

  /**
   * 为文件在所有匹配的层级创建分层硬链接
   * 例如：selectedTags = ["脚本", "PowerShell"]
   * - 层级1：["脚本"] -> 获取所有有"脚本"tag的文件 -> 在"脚本/"创建硬链接
   * - 层级2：["脚本", "PowerShell"] -> 获取所有有"脚本"和"PowerShell"tags的文件 -> 在"脚本/PowerShell/"创建硬链接
   * - 去重：如果文件同时在两个层级，删除层级1的硬链接（从底到上去重）
   */
  private async createHierarchicalHardLinks(
    virtualDirPath: string,
    selectedTags: SelectedTag[],
    sortBy: 'name' | 'date' | 'size' | 'type' | 'smartName' | 'analysisStatus' | 'language' | 'author' | 'qualityScore',
    sortOrder: 'asc' | 'desc',
    workspaceDirectoryPath?: string
  ): Promise<void> {
    try {
      logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 开始创建分层硬链接，层级数:', selectedTags.length)

      // 从顶层到底层，逐层创建硬链接
      for (let level = 1;level <= selectedTags.length;level++) {
        const levelTags = selectedTags.slice(0, level)
        const levelTagChain = levelTags.map(t => t.tagValue)

        logger.info(
          LogCategory.VIRTUAL_DIRECTORY,
          `[VirtualDirectory] 处理层级 ${level}/${selectedTags.length}:`,
          levelTagChain.join(' -> ')
        )

        // 获取该层级的文件
        const files = await this.getFilteredFiles({
          selectedTags: levelTags,
          sortBy,
          sortOrder,
          workspaceDirectoryPath,
        })

        logger.info(
          LogCategory.VIRTUAL_DIRECTORY,
          `[VirtualDirectory] 层级 ${level} 获取到文件数:`,
          files.length
        )

        // 为每个文件在该层级创建硬链接
        for (const file of files) {
          await this.createHardLinkAtLevel(virtualDirPath, file, levelTags)
        }
      }

      // 从底到上去重：删除父级层级的重复硬链接
      await this.deduplicateHardLinksFromBottom(virtualDirPath, selectedTags)

      logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 分层硬链接创建完成')
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 创建分层硬链接失败:', error)
      throw error
    }
  }

  /**
   * 创建文件链接，优先使用硬链接，失败时回退到符号链接
   * 用于处理跨分区/跨设备无法创建硬链接的情况（尤其在 WSL2 中常见）
   */
  private createLink(sourcePath: string, targetPath: string): void {
    try {
      // 1. 如果目标路径已存在，先删除
      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath)
      }

      // 2. 优先尝试硬链接 (性能最好，且对用户透明)
      fs.linkSync(sourcePath, targetPath)
      logger.debug(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 创建硬链接成功:', targetPath)
    } catch (error: any) {
      // 3. 如果硬链接失败（例如 EXDEV: cross-device link），尝试符号链接
      if (error.code === 'EXDEV' || error.code === 'EPERM' || error.code === 'EACCES') {
        try {
          // 在 Windows 上，非管理员创建文件符号链接通常受限，但 Junction 仅支持目录
          // 在 Linux/WSL2 上，符号链接可以跨分区且无特殊权限限制
          const type = process.platform === 'win32' ? 'file' : undefined
          fs.symlinkSync(sourcePath, targetPath, type)
          logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 硬链接失败(可能跨分区)，已改用符号链接:', {
            source: sourcePath,
            target: targetPath,
            reason: error.code
          })
        } catch (symlinkError: any) {
          logger.error(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 创建链接失败 (硬链接与符号链接均失败):', {
            target: targetPath,
            error: symlinkError.message
          })
          // 仍然抛出错误，以便上层逻辑记录
          throw symlinkError
        }
      } else {
        logger.error(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 创建硬链接发生未知错误:', {
          target: targetPath,
          error: error.message
        })
        throw error
      }
    }
  }

  /**
   * 为单个文件在指定层级创建硬链接
   * @param virtualDirPath 虚拟目录根路径
   * @param file 文件信息
   * @param levelTags 该层级的tags
   */
  private async createHardLinkAtLevel(
    virtualDirPath: string,
    file: FileItem,
    levelTags: SelectedTag[]
  ): Promise<void> {
    try {
      const levelTagChain = levelTags.map(t => t.tagValue)
      const tagPath = levelTagChain.join(path.sep)

      // 创建完整目录路径
      const fullDirPath = path.join(virtualDirPath, tagPath)
      if (!fs.existsSync(fullDirPath)) {
        fs.mkdirSync(fullDirPath, { recursive: true })
      }

      // 使用智能文件名（smart_name）或原始文件名，并保持原始文件扩展名
      let fileName: string
      if (file.smartName) {
        const originalExt = path.extname(file.name)
        const smartNameExt = path.extname(file.smartName)

        if (!smartNameExt || smartNameExt !== originalExt) {
          const smartNameWithoutExt = smartNameExt
            ? file.smartName.slice(0, -smartNameExt.length)
            : file.smartName
          fileName = smartNameWithoutExt + originalExt
        } else {
          fileName = file.smartName
        }
      } else {
        fileName = file.name
      }

      const linkPath = path.join(fullDirPath, fileName)

      // 创建链接
      this.createLink(file.path, linkPath)
      logger.info(
        LogCategory.VIRTUAL_DIRECTORY,
        '[VirtualDirectory] 创建链接:',
        linkPath
      )
    } catch (error) {
      logger.error(
        LogCategory.VIRTUAL_DIRECTORY,
        '[VirtualDirectory] 创建硬链接失败:',
        file.path,
        error
      )
      // 不抛出错误，继续处理其他文件
    }
  }

  /**
   * 从底层到顶层去重：删除父级层级的重复硬链接
   * 如果文件在更深层级存在，则删除上层的硬链接
   */
  private async deduplicateHardLinksFromBottom(
    virtualDirPath: string,
    selectedTags: SelectedTag[]
  ): Promise<void> {
    try {
      logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 开始从底到上去重')

      // 从最深层开始向上检查
      for (let deepLevel = selectedTags.length;deepLevel > 1;deepLevel--) {
        const deepTagChain = selectedTags.slice(0, deepLevel).map(t => t.tagValue)
        const deepPath = path.join(virtualDirPath, ...deepTagChain)

        if (!fs.existsSync(deepPath)) {
          continue
        }

        // 获取深层路径中的所有文件
        const deepFiles = this.getAllFilesInDirectory(deepPath)

        // 对于每个深层文件，检查并删除所有上层的重复硬链接
        for (const deepFilePath of deepFiles) {
          const fileName = path.basename(deepFilePath)
          const deepStat = fs.statSync(deepFilePath)

          // 检查所有上层路径
          for (let parentLevel = 1;parentLevel < deepLevel;parentLevel++) {
            const parentTagChain = selectedTags.slice(0, parentLevel).map(t => t.tagValue)
            const parentPath = path.join(virtualDirPath, ...parentTagChain)
            const parentFilePath = path.join(parentPath, fileName)

            // 如果上层存在同名文件
            if (fs.existsSync(parentFilePath)) {
              try {
                const parentStat = fs.statSync(parentFilePath)

                // 如果inode相同，说明是同一文件的硬链接，删除上层的
                if (parentStat.ino === deepStat.ino) {
                  fs.unlinkSync(parentFilePath)
                  logger.info(
                    LogCategory.VIRTUAL_DIRECTORY,
                    '[VirtualDirectory] 删除上层重复硬链接:',
                    parentFilePath
                  )
                }
              } catch (error) {
                logger.warn(
                  LogCategory.VIRTUAL_DIRECTORY,
                  '[VirtualDirectory] 检查上层硬链接失败:',
                  parentFilePath,
                  error
                )
              }
            }
          }
        }
      }

      logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 从底到上去重完成')
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 从底到上去重失败:', error)
      // 不抛出错误，继续执行
    }
  }

  /**
   * 递归获取目录中的所有文件（不包括子目录）
   */
  private getAllFilesInDirectory(dirPath: string): string[] {
    const files: string[] = []

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)

        if (entry.isDirectory()) {
          // 递归处理子目录
          files.push(...this.getAllFilesInDirectory(fullPath))
        } else if (entry.isFile()) {
          // 跳过ReadMe特殊文件
          if (!/^ReadMe_[a-zA-Z\-]{5}\.txt$/.test(entry.name)) {
            files.push(fullPath)
          }
        }
      }
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 获取目录文件失败:', dirPath, error)
    }

    return files
  }

  /**
   * 清理文件在其他虚拟目录中的旧硬链接（虚拟目录互斥性）
   * 当创建新虚拟目录时，如果文件已经在其他虚拟目录中，删除旧的硬链接
   */
  private async cleanupFilesInOtherVirtualDirectories(
    virtualDirPath: string,
    currentFiles: FileItem[],
    currentTagChain: string[],
    workspaceDirectoryPath?: string
  ): Promise<void> {
    try {
      logger.info(
        LogCategory.VIRTUAL_DIRECTORY,
        '[VirtualDirectory] 开始清理文件在其他虚拟目录中的旧硬链接，文件数:',
        currentFiles.length
      )

      // 获取当前工作目录的所有其他虚拟目录
      let query = `
        SELECT filters FROM virtual_directories
        WHERE workspace_id = (SELECT id FROM workspace_directories WHERE path = ?)
      `
      const allDirectories = this.db
        .prepare(query)
        .all(workspaceDirectoryPath || '') as any[]

      // 提取所有其他虚拟目录的tag链
      const otherTagChains: string[][] = []
      for (const dir of allDirectories) {
        const filters = JSON.parse(dir.filters)
        const tagChain = filters.selectedTags.map((tag: any) => tag.tagValue)

        // 排除当前虚拟目录
        if (JSON.stringify(tagChain) !== JSON.stringify(currentTagChain)) {
          otherTagChains.push(tagChain)
        }
      }

      if (otherTagChains.length === 0) {
        logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 没有其他虚拟目录，跳过清理')
        return
      }

      logger.info(
        LogCategory.VIRTUAL_DIRECTORY,
        '[VirtualDirectory] 找到其他虚拟目录数:',
        otherTagChains.length
      )

      // 对于每个文件，检查并删除其在其他虚拟目录中的硬链接
      for (const file of currentFiles) {
        const fileName = this.getFileNameWithsmartName(file)
        const fileStat = fs.statSync(file.path)

        for (const otherTagChain of otherTagChains) {
          // 检查该文件在其他虚拟目录的所有层级中是否存在
          for (let level = 1;level <= otherTagChain.length;level++) {
            const levelPath = otherTagChain.slice(0, level).join(path.sep)
            const otherFilePath = path.join(virtualDirPath, levelPath, fileName)

            if (fs.existsSync(otherFilePath)) {
              try {
                const otherStat = fs.statSync(otherFilePath)

                // 如果inode相同，说明是同一文件的硬链接，删除
                if (otherStat.ino === fileStat.ino) {
                  fs.unlinkSync(otherFilePath)
                  logger.info(
                    LogCategory.VIRTUAL_DIRECTORY,
                    '[VirtualDirectory] 删除其他虚拟目录中的旧硬链接:',
                    otherFilePath
                  )
                }
              } catch (error) {
                logger.warn(
                  LogCategory.VIRTUAL_DIRECTORY,
                  '[VirtualDirectory] 检查其他虚拟目录硬链接失败:',
                  otherFilePath,
                  error
                )
              }
            }
          }
        }
      }

      logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 清理其他虚拟目录旧硬链接完成')
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 清理其他虚拟目录旧硬链接失败:', error)
      // 不抛出错误，继续执行
    }
  }

  /**
   * 获取文件名（考虑智能文件名）
   */
  private getFileNameWithsmartName(file: FileItem): string {
    if (file.smartName) {
      const originalExt = path.extname(file.name)
      const smartNameExt = path.extname(file.smartName)

      if (!smartNameExt || smartNameExt !== originalExt) {
        const smartNameWithoutExt = smartNameExt
          ? file.smartName.slice(0, -smartNameExt.length)
          : file.smartName
        return smartNameWithoutExt + originalExt
      } else {
        return file.smartName
      }
    } else {
      return file.name
    }
  }

  /**
   * 递归清理空目录（不包括根虚拟目录）
   * @param dirPath 要清理的目录路径
   * @returns 如果目录被删除返回true，否则返回false
   */
  private async cleanupEmptyDirectories(dirPath: string): Promise<boolean> {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })

      // 递归处理所有子目录
      for (const entry of entries) {
        if (entry.isDirectory()) {
          // 跳过缩略图目录
          if (entry.name === THUMBNAIL_FOLDER) {
            continue
          }

          const subDirPath = path.join(dirPath, entry.name)
          await this.cleanupEmptyDirectories(subDirPath)
        }
      }

      // 重新检查当前目录是否为空（子目录可能已被删除）
      const currentEntries = fs.readdirSync(dirPath)

      // 如果目录为空且不是根虚拟目录，则删除
      if (currentEntries.length === 0 && !dirPath.endsWith(VIRTUAL_DIRECTORY_FOLDER)) {
        fs.rmdirSync(dirPath)
        logger.info(
          LogCategory.VIRTUAL_DIRECTORY,
          '[VirtualDirectory] 删除空目录:',
          dirPath
        )
        return true
      }

      return false
    } catch (error) {
      logger.error(
        LogCategory.VIRTUAL_DIRECTORY,
        '[VirtualDirectory] 清理空目录失败:',
        dirPath,
        error
      )
      return false
    }
  }

  /**
   * 复制ReadMe文件到虚拟目录
   * 根据用户语言设置选择对应的ReadMe文件
   */
  private async copyReadmeFile(virtualDirPath: string): Promise<void> {
    try {
      // 获取用户语言设置
      const userLanguage = configService.getValue('DEFAULT_LANGUAGE') || 'zh-CN'
      const readmeFileName = `ReadMe_${userLanguage}.txt`

      // 获取ReadMe文件源路径
      // 获取ReadMe文件源路径
      const extraResourcesPath = platformAdapter.getExtraResourcesPath()
      const sourceReadmePath = path.join(
        extraResourcesPath,
        '.VirtualDirectory',
        readmeFileName
      )

      // 目标路径
      const targetReadmePath = path.join(virtualDirPath, readmeFileName)

      // 检查源文件是否存在
      if (!fs.existsSync(sourceReadmePath)) {
        logger.warn(
          LogCategory.VIRTUAL_DIRECTORY,
          `[VirtualDirectory] ReadMe文件不存在: ${sourceReadmePath}，跳过复制`
        )
        return
      }

      // 复制文件（如果目标文件已存在，则覆盖）
      fs.copyFileSync(sourceReadmePath, targetReadmePath)
      logger.info(
        LogCategory.VIRTUAL_DIRECTORY,
        `[VirtualDirectory] ReadMe文件已复制: ${readmeFileName}`
      )
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 复制ReadMe文件失败:', error)
      // 不抛出错误，避免影响虚拟目录的创建
    }
  }

  /**
   * 为单个文件创建硬链接
   * 根据文件的tags构建目录层级，并在最深层创建硬链接
   * 从底层向上检查，删除上层可能存在的重复硬链接
   */
  private async createHardLinkForFile(
    virtualDirPath: string,
    file: FileItem,
    selectedTags: SelectedTag[]
  ): Promise<void> {
    try {
      // 获取文件的所有tags（带维度信息）
      const fileTags = this.getFileTagsWithDimensions(file.id) // Hash ID string
      if (fileTags.length === 0) {
        logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 文件没有tags，跳过:', file.name)
        return
      }

      // 根据selectedTags构建目录路径
      const tagPath = this.buildTagHierarchyPath(fileTags, selectedTags)
      if (!tagPath) {
        logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 无法构建tag路径，跳过:', file.name)
        return
      }

      // 创建完整目录路径
      const fullDirPath = path.join(virtualDirPath, tagPath)
      if (!fs.existsSync(fullDirPath)) {
        fs.mkdirSync(fullDirPath, { recursive: true })
        logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 创建tag目录:', fullDirPath)
      }

      // 使用智能文件名（smart_name）或原始文件名，并保持原始文件扩展名
      let fileName: string
      if (file.smartName) {
        // 获取原始文件的扩展名
        const originalExt = path.extname(file.name)
        const smartNameExt = path.extname(file.smartName)

        // 如果智能文件名没有扩展名，或者扩展名不同，则添加原始扩展名
        if (!smartNameExt || smartNameExt !== originalExt) {
          const smartNameWithoutExt = smartNameExt
            ? file.smartName.slice(0, -smartNameExt.length)
            : file.smartName
          fileName = smartNameWithoutExt + originalExt
        } else {
          fileName = file.smartName
        }
      } else {
        fileName = file.name
      }

      const linkPath = path.join(fullDirPath, fileName)

      // 从底层向上检查并删除上层的重复硬链接
      // tagPath 例如: "图片/截图/高清"，需要检查 "图片/截图" 和 "图片" 等上层路径
      const tagPathParts = tagPath.split(path.sep)
      for (let i = tagPathParts.length - 1;i > 0;i--) {
        const parentPath = tagPathParts.slice(0, i).join(path.sep)
        const parentLinkPath = path.join(virtualDirPath, parentPath, fileName)

        // 如果上层存在同名硬链接，检查是否是同一个文件（通过inode）
        if (fs.existsSync(parentLinkPath)) {
          try {
            const parentStat = fs.statSync(parentLinkPath)
            const sourceStat = fs.statSync(file.path)

            // 如果inode相同，说明是同一文件的硬链接，删除上层的
            if (parentStat.ino === sourceStat.ino) {
              fs.unlinkSync(parentLinkPath)
              logger.info(
                LogCategory.VIRTUAL_DIRECTORY,
                '[VirtualDirectory] 删除上层重复硬链接:',
                parentLinkPath
              )
            }
          } catch (error) {
            // 忽略检查错误，继续处理
            logger.warn(
              LogCategory.VIRTUAL_DIRECTORY,
              '[VirtualDirectory] 检查上层硬链接失败:',
              parentLinkPath,
              error
            )
          }
        }
      }

      // 创建链接
      this.createLink(file.path, linkPath)
      logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 创建链接:', linkPath)
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 创建硬链接失败:', file.path, error)
      // 不抛出错误，继续处理其他文件
    }
  }

  /**
   * 获取文件的所有tags及其维度信息
   */
  private getFileTagsWithDimensions(fileId: string): Array<{ 
    dimensionId: number
    dimensionName: string
    tagValue: string
    level: number
  }> {
    try {
      // 修正：使用 dimension_id, fd.id 即名称
      const query = `
        SELECT
          fd.id as dimensionId,
          fd.name as dimensionName,
          ft.name as tagValue,
          fd.level as level
        FROM file_tag_relations ftr
        INNER JOIN file_tags ft ON ft.id = ftr.tag_id
        INNER JOIN file_dimensions fd ON fd.id = ft.dimension_id
        WHERE ftr.file_fingerprint = ?
        ORDER BY fd.level ASC
      `

      const tags = this.db.prepare(query).all(fileId) as any[]
      return tags
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 获取文件tags失败:', fileId, error)
      return []
    }
  }

  /**
   * 根据文件tags和选中的tags构建目录层级路径
   * 只包含selectedTags中的维度，按priority排序
   * 返回路径字符串，如: "图片/截图"
   */
  private buildTagHierarchyPath(
    fileTags: Array<{ dimensionId: number; dimensionName: string; tagValue: string; level: number }>, 
    selectedTags: SelectedTag[]
  ): string | null {
    try {
      // 创建selectedTags的维度ID集合，用于快速查找
      const selectedDimensionIds = new Set(selectedTags.map(t => t.dimensionId))

      // 筛选出文件中匹配selectedTags维度的tags
      const matchingTags = fileTags.filter(ft => selectedDimensionIds.has(ft.dimensionId))

      if (matchingTags.length === 0) {
        return null
      }

      // 按priority排序（priority越小越靠前，即越是父级）
      matchingTags.sort((a, b) => a.level - b.level)

      // 构建路径
      const pathParts = matchingTags.map(t => t.tagValue)
      return pathParts.join(path.sep)
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 构建tag路径失败:', error)
      return null
    }
  }

  /**
   * 更新所有保存的虚拟目录
   * 在队列分析完成后调用，重新生成所有虚拟目录的硬链接
   * @param workspaceDirectoryPath 工作目录路径
   */
  async updateAllVirtualDirectories(workspaceDirectoryPath: string): Promise<void> {
    try {
      logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 开始更新所有虚拟目录:', workspaceDirectoryPath)

      // 只获取当前工作目录的虚拟目录（传入workspaceDirectoryPath参数）
      const savedDirectories = await this.getSavedDirectories(workspaceDirectoryPath)

      if (savedDirectories.length === 0) {
        logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 没有保存的虚拟目录，跳过更新')
        return
      }

      logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 找到', savedDirectories.length, '个虚拟目录需要更新')

      // 逐个更新虚拟目录
      for (const directory of savedDirectories) {
        try {
          logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 更新虚拟目录:', directory.name)
          await this.createVirtualDirectoryStructure(workspaceDirectoryPath, directory)
        } catch (error) {
          logger.error(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 更新虚拟目录失败:', directory.name, error)
          // 继续更新其他虚拟目录
        }
      }

      logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 所有虚拟目录更新完成')
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 更新所有虚拟目录失败:', error)
      // 不抛出错误，避免影响队列处理流程
    }
  }

  /**
   * 清理虚拟目录中不存在的文件硬链接
   * 在每次加载工作目录时调用
   */
  async cleanupVirtualDirectory(workspaceDirectoryPath: string): Promise<void> {
    try {
      const virtualDirPath = path.join(workspaceDirectoryPath, VIRTUAL_DIRECTORY_FOLDER)

      // 如果虚拟目录不存在，无需清理
      if (!fs.existsSync(virtualDirPath)) {
        return
      }

      logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 开始清理虚拟目录:', virtualDirPath)

      // 获取工作目录ID
      const directory = this.db
        .prepare('SELECT workspace_id FROM workspaces WHERE path = ?')
        .get(workspaceDirectoryPath) as any

      if (!directory) {
        logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 工作目录不存在于数据库中，跳过清理')
        return
      }

      // 获取该工作目录下所有已分析文件的文件名集合
      const analyzedFiles = this.db
        .prepare('SELECT wf.name, wf.path FROM workspace_files wf WHERE wf.workspace_id = ? AND wf.is_analyzed = 1')
        .all(directory.workspace_id) as Array<{ name: string; path: string }>

      const analyzedFileNames = new Set(analyzedFiles.map(f => f.name))
      const analyzedFilePaths = new Set(analyzedFiles.map(f => f.path))

      logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 数据库中已分析文件数:', analyzedFileNames.size)

      // 递归遍历虚拟目录，检查所有硬链接
      await this.cleanupDirectoryRecursive(virtualDirPath, analyzedFileNames, analyzedFilePaths)

      logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 虚拟目录清理完成')
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 清理虚拟目录失败:', error)
      // 不抛出错误，避免影响正常流程
    }
  }

  /**
   * 递归清理目录中的无效硬链接
   */
  private async cleanupDirectoryRecursive(
    dirPath: string,
    analyzedFileNames: Set<string>,
    analyzedFilePaths: Set<string>
  ): Promise<void> {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)

        if (entry.isDirectory()) {
          // 跳过缩略图目录
          if (entry.name === THUMBNAIL_FOLDER) {
            continue
          }

          // 递归处理子目录
          await this.cleanupDirectoryRecursive(fullPath, analyzedFileNames, analyzedFilePaths)

          // 如果子目录为空，删除它
          try {
            const subEntries = fs.readdirSync(fullPath)
            if (subEntries.length === 0) {
              fs.rmdirSync(fullPath)
              logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 删除空目录:', fullPath)
            }
          } catch (error) {
            // 忽略删除空目录的错误
          }
        } else if (entry.isFile()) {
          // 检查是否是 ReadMe 特殊文件（ReadMe_*.txt），如果是则跳过
          if (/^ReadMe_[a-zA-Z\-]{5}\.txt$/.test(entry.name)) {
            logger.info(
              LogCategory.VIRTUAL_DIRECTORY,
              '[VirtualDirectory] 跳过 ReadMe 特殊文件:',
              fullPath
            )
            continue
          }

          // 检查文件是否存在于数据库的已分析文件中
          // 方法1: 检查文件名是否存在
          if (!analyzedFileNames.has(entry.name)) {
            // 文件不在数据库中，删除硬链接
            try {
              fs.unlinkSync(fullPath)
              logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 删除无效硬链接（文件不在数据库）:', fullPath)
            } catch (error) {
              logger.error(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 删除硬链接失败:', fullPath, error)
            }
            continue
          }

          // 方法2: 检查原始文件是否还存在
          // 由于硬链接指向的是inode，即使原文件被删除，硬链接仍然有效
          // 但我们需要确保原文件路径在数据库中且is_analyzed=1
          // 这个检查已经通过analyzedFileNames完成了
        }
      }
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 清理目录失败:', dirPath, error)
    }
  }

  /**
   * 直接根据预览树结构生成虚拟目录
   * @param workspaceDirectoryPath 工作目录路径
   * @param directoryTree 预览生成的目录树结构
   * @param tagFileMap 标签到文件的映射表
   * @param options 生成选项
   */
  async generateFromPreviewTree(
    workspaceDirectoryPath: string,
    directoryTree: Array<{ 
      name: string
      parent: string
      description?: string
      files?: Array<{ name: string; smartName?: string; path?: string }>
      fileCount?: number
      dimensionId?: number
      dimensionName?: string
      tagValue?: string
    }>,
    tagFileMap: Map<string, Array<{ name: string; smartName?: string; path?: string }>>,
    options: {
      flattenToRoot: boolean
      skipEmptyDirectories: boolean
      enableNestedClassification: boolean
    }
  ): Promise<{ success: boolean; fileCount: number; message: string }> {
    try {
      logger.info(
        LogCategory.VIRTUAL_DIRECTORY,
        '[VirtualDirectory] 开始根据预览树结构生成虚拟目录'
      )

      // 1. 获取工作目录ID（从 workspace_directories 表，而不是 workspaces 表）
      const workspaceResult = this.db
        .prepare('SELECT id FROM workspace_directories WHERE path = ?')
        .get(workspaceDirectoryPath) as any
      if (!workspaceResult) throw new Error('Workspace directory not found')
      const workspaceId = workspaceResult.id

      // 2. 保存虚拟目录配置到数据库 (串起业务逻辑)
      const nameToIdMap = new Map<string, string>()
      const nameToTagsMap = new Map<string, SelectedTag[]>()

      // 按顺序处理以确保父级 ID 已存在
      for (const node of directoryTree) {
        // 构建当前节点的选中标签列表 (累加父级标签以实现串联逻辑)
        let currentTags: SelectedTag[] = []
        if (node.dimensionId !== undefined && node.dimensionName && node.tagValue) {
          const selfTag: SelectedTag = {
            dimensionId: node.dimensionId,
            dimensionName: node.dimensionName,
            tagValue: node.tagValue,
            level: 0
          }
          
          if (node.parent && nameToTagsMap.has(node.parent)) {
            currentTags = [...nameToTagsMap.get(node.parent)!, selfTag]
          } else {
            currentTags = [selfTag]
          }
        }
        nameToTagsMap.set(node.name, currentTags)

        // 查找是否已存在相同名称和层级的目录
        const parentId = node.parent ? nameToIdMap.get(node.parent) : null
        const existing = this.db.prepare(`
          SELECT id FROM virtual_directories 
          WHERE name = ? AND workspace_id = ? AND (parent_id = ? OR (parent_id IS NULL AND ? IS NULL))
        `).get(node.name, workspaceId, parentId, parentId) as any
        
        const id = existing ? existing.id : `vdir-${Date.now()}-${Math.random().toString(36).substring(7)}`
        nameToIdMap.set(node.name, id)

        const filters: VirtualDirectoryFilter = {
          selectedTags: currentTags,
          sortBy: 'name',
          sortOrder: 'asc',
          viewMode: 'list'
        }

        this.db.prepare(`
          INSERT OR REPLACE INTO virtual_directories (id, name, description, filters, parent_id, workspace_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `).run(
          id,
          node.name,
          node.description || null,
          JSON.stringify(filters),
          parentId || null,
          workspaceId
        )
      }

      const virtualDirPath = path.join(workspaceDirectoryPath, VIRTUAL_DIRECTORY_FOLDER)

      // 1. 创建 .VirtualDirectory 文件夹
      if (!fs.existsSync(virtualDirPath)) {
        fs.mkdirSync(virtualDirPath, { recursive: true })
        logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 创建虚拟目录文件夹:', virtualDirPath)
      }

      // 2. 复制ReadMe文件（如果还没有）
      const readmeExists = fs.readdirSync(virtualDirPath).some(file => file.startsWith('ReadMe_'))
      if (!readmeExists) {
        await this.copyReadmeFile(virtualDirPath)
      }

      // 3. 清空现有的虚拟目录内容（保留ReadMe文件和.thumbnail目录）
      const entries = fs.readdirSync(virtualDirPath)
      for (const entry of entries) {
        if (entry === THUMBNAIL_FOLDER) {
          continue
        }
        if (!/^ReadMe_[a-zA-Z\-]{5}\.txt$/.test(entry)) {
          const entryPath = path.join(virtualDirPath, entry)
          fs.rmSync(entryPath, { recursive: true, force: true })
        }
      }

      let totalFileCount = 0

      // 4. 根据directoryTree生成目录结构
      if (options.flattenToRoot) {
        // 平铺模式：所有文件直接放在根目录
        logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 使用平铺模式生成')
        const rootNode = directoryTree[0]
        logger.info(
          LogCategory.VIRTUAL_DIRECTORY,
          '[VirtualDirectory] 根节点:',
          rootNode ? `${rootNode.name}, 文件数: ${rootNode.files?.length || 0}` : 'null'
        )
        if (rootNode && rootNode.files) {
          logger.info(
            LogCategory.VIRTUAL_DIRECTORY,
            '[VirtualDirectory] 根节点文件列表前3个:',
            rootNode.files.slice(0, 3).map(f => ({ name: f.name, hasPath: !!f.path }))
          )
          for (const file of rootNode.files) {
            if (file.path) {
              const fileName = this.getFileNameWithsmartNameFromFileObj(file)
              const linkPath = path.join(virtualDirPath, fileName)

              // 创建链接
              try {
                this.createLink(file.path, linkPath)
                totalFileCount++
                logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 创建链接:', linkPath)
              } catch (error) {
                logger.error(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 创建链接失败:', file.path, error)
              }
            } else {
              logger.warn(
                LogCategory.VIRTUAL_DIRECTORY,
                '[VirtualDirectory] 文件缺少path信息，跳过:',
                file.name
              )
            }
          }
        } else {
          logger.warn(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 根节点或文件列表为空')
        }
      } else {
        // 树状模式：根据目录树创建层级结构
        logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 使用树状模式生成')
        logger.info(
          LogCategory.VIRTUAL_DIRECTORY,
          '[VirtualDirectory] 目录树详情:',
          directoryTree.map(n => ({
            name: n.name,
            parent: n.parent,
            fileCount: n.files?.length || 0,
            hasPath: n.files?.some(f => !!f.path)
          }))
        )

        // 构建父子关系映射
        const nodesByName = new Map<string, typeof directoryTree[0]>()
        directoryTree.forEach(node => nodesByName.set(node.name, node))

        // 递归创建目录和文件
        const createNodeStructure = (node: typeof directoryTree[0], parentPath: string) => {
          const currentPath = path.join(parentPath, node.name)

          logger.info(
            LogCategory.VIRTUAL_DIRECTORY,
            `[VirtualDirectory] 创建目录: ${currentPath}, 文件数: ${node.files?.length || 0}`
          )

          // 创建目录
          if (!fs.existsSync(currentPath)) {
            fs.mkdirSync(currentPath, { recursive: true })
          }

          // 创建文件硬链接
          if (node.files && node.files.length > 0) {
            for (const file of node.files) {
              if (file.path) {
                const fileName = this.getFileNameWithsmartNameFromFileObj(file)
                const linkPath = path.join(currentPath, fileName)

                // 创建链接
                try {
                  this.createLink(file.path, linkPath)
                  totalFileCount++
                  logger.info(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 创建链接:', linkPath)
                } catch (error) {
                  logger.error(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 创建链接失败:', file.path, error)
                }
              } else {
                logger.warn(
                  LogCategory.VIRTUAL_DIRECTORY,
                  '[VirtualDirectory] 文件缺少path信息，跳过:',
                  file.name
                )
              }
            }
          }

          // 递归创建子节点
          const children = directoryTree.filter(n => n.parent === node.name)
          for (const child of children) {
            createNodeStructure(child, currentPath)
          }
        }

        // 从顶层节点开始创建
        const topLevelNodes = directoryTree.filter(node => !node.parent || node.parent === '')
        logger.info(
          LogCategory.VIRTUAL_DIRECTORY,
          '[VirtualDirectory] 顶层节点数:',
          topLevelNodes.length
        )
        for (const node of topLevelNodes) {
          createNodeStructure(node, virtualDirPath)
        }
      }

      // 5. 清理空目录（如果需要）
      if (options.skipEmptyDirectories) {
        await this.cleanupEmptyDirectories(virtualDirPath)
      }

      logger.info(
        LogCategory.VIRTUAL_DIRECTORY,
        `[VirtualDirectory] 虚拟目录生成完成，共创建 ${totalFileCount} 个文件`
      )

      return {
        success: true,
        fileCount: totalFileCount,
        message: `成功创建虚拟目录，包含 ${totalFileCount} 个文件`
      }
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 生成虚拟目录失败:', error)
      throw error
    }
  }

  /**
   * 从文件对象获取文件名（考虑智能文件名）
   */
  private getFileNameWithsmartNameFromFileObj(file: { name: string; smartName?: string; path?: string }): string {
    if (file.smartName) {
      const originalExt = path.extname(file.name)
      const smartNameExt = path.extname(file.smartName)

      if (!smartNameExt || smartNameExt !== originalExt) {
        const smartNameWithoutExt = smartNameExt
          ? file.smartName.slice(0, -smartNameExt.length)
          : file.smartName
        return smartNameWithoutExt + originalExt
      } else {
        return file.smartName
      }
    } else {
      return file.name
    }
  }
}

export const virtualDirectoryService = new VirtualDirectoryService()
