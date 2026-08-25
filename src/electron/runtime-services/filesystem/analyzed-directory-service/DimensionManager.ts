import {
  LogCategory,
  logger,
  isExtensionDimension,
  isPanDimension,
  filterDimensionTags,
  DIMS_CONTAINING_TRAILING_EXTENSION_TAG
} from '@firefly/shared'
import {
  DimensionGroup,
  DimensionGroupsResponse,
  DimensionTag,
  GetDimensionGroupsOptions
} from '@firefly/types'

import { ConfigOrchestrator } from '../../../config/config-orchestrator'
import Database from 'better-sqlite3'
import path from 'node:path'

export class DimensionManager {
  private _extensionMap: Map<string, string[]> | null = null

  constructor(private db: Database.Database) {}

  /**
   * 从 L3 扩展名维度动态构建 tagValue → extensions 映射
   * 通过 triggerConditions 向上追溯，收集触发链上所有标签
   */
  private buildExtensionMap(): Map<string, string[]> {
    if (this._extensionMap) return this._extensionMap

    const rawDimensions = this.db
      .prepare('SELECT id, name, tags, trigger_conditions, level FROM file_dimensions')
      .all() as any[]

    const nameToIdMap = new Map<string, number>()
    const idToDim = new Map<number, any>()
    rawDimensions.forEach(d => {
      nameToIdMap.set(d.name.trim(), d.id)
      idToDim.set(d.id, d)
    })

    const extensionMap = new Map<string, string[]>()

    const l3ExtDims = rawDimensions.filter(
      d => Number(d.level) === 3 && /扩展名|Extension/i.test(d.name)
    )

    for (const dim of l3ExtDims) {
      const tags = this.parseJsonArray(dim.tags)
      const exts: string[] = []
      tags.forEach((t: string) => {
        const clean = t.toLowerCase().replace(/^\./, '')
        if (clean) {
          const pair = [`.${clean}`, clean]
          exts.push(...pair)
          extensionMap.set(t, pair)
          extensionMap.set(clean, pair)
          extensionMap.set(`.${clean}`, pair)
        }
      })
      if (exts.length === 0) continue

      const tcs = this.parseJsonArray(dim.trigger_conditions)
      if (!Array.isArray(tcs) || tcs.length === 0) continue

      for (const tc of tcs) {
        const parentDimName = tc.parentDimension?.trim()
        const parentDimId = nameToIdMap.get(parentDimName)
        if (!parentDimId) continue

        const triggerTags = this.parseJsonArray(tc.triggerTags)
        const parentDim = idToDim.get(parentDimId)
        if (!parentDim) continue

        const parentTCs = this.parseJsonArray(parentDim.trigger_conditions)

        if (!Array.isArray(parentTCs) || parentTCs.length === 0) {
          // 父维度是 L1，triggerTags 就是 L1 标签名
          for (const l1Tag of triggerTags) {
            const existing = extensionMap.get(l1Tag) || []
            extensionMap.set(l1Tag, [...existing, ...exts])
          }
          continue
        }

        // 父维度是 L2+，收集触发链上所有标签（含中间标签如"漫画"）
        const chainTags = this.collectTriggerChainTags(parentDimId, nameToIdMap, idToDim)
        for (const chainTag of chainTags) {
          const existing = extensionMap.get(chainTag) || []
          extensionMap.set(chainTag, [...existing, ...exts])
        }
      }
    }

    // 去重
    for (const [key, exts] of extensionMap) {
      extensionMap.set(key, [...new Set(exts)])
    }

    this._extensionMap = extensionMap
    return extensionMap
  }

  /**
   * 收集从指定维度向上到 L1 的触发链上中间层标签名（不含 L1 根标签）
   * 只收集 L2 及更高层的维度自身 tags 和 triggerTags
   */
  private collectTriggerChainTags(
    dimId: number,
    nameToIdMap: Map<string, number>,
    idToDim: Map<number, any>,
    visited = new Set<number>()
  ): string[] {
    if (visited.has(dimId)) return []
    visited.add(dimId)

    const dim = idToDim.get(dimId)
    if (!dim) return []

    const tcs = this.parseJsonArray(dim.trigger_conditions)
    if (!Array.isArray(tcs) || tcs.length === 0) {
      // L1 维度，不收集其标签（L1 标签由 buildExtensionMap 直接处理）
      return []
    }

    const result: string[] = []

    // 收集当前 L2+ 维度自身的所有标签（如"漫画"、"截图"等）
    const dimTags = this.parseJsonArray(dim.tags)
    result.push(...dimTags)

    for (const tc of tcs) {
      // 收集触发标签（如 L2→L1 的 triggerTag "图片"）
      const triggerTags = this.parseJsonArray(tc.triggerTags)
      result.push(...triggerTags)

      // 递归到父维度（跳过 L1）
      const parentDimId = nameToIdMap.get(tc.parentDimension?.trim())
      if (parentDimId) {
        result.push(...this.collectTriggerChainTags(parentDimId, nameToIdMap, idToDim, visited))
      }
    }
    return [...new Set(result)]
  }

  /**
   * 安全解析 JSON 数组
   */
  private parseJsonArray(value: any): any[] {
    if (Array.isArray(value)) return value
    if (typeof value === 'string') {
      try {
        const parsed = JSON.parse(value)
        return Array.isArray(parsed) ? parsed : []
      } catch {
        return []
      }
    }
    return []
  }

  /**
   * 根据标签值获取允许的文件扩展名
   * 通过 L3 扩展名维度动态构建的映射查找
   */
  getExtensionsForTag(tagValue: string): string[] {
    const map = this.buildExtensionMap()
    return map.get(tagValue) || []
  }

  /**
   * 根据父标签推断扩展名
   * 统一使用 extensionMap 查找
   */
  private getExtsForParentTag(parentTagValue: string): string[] {
    const map = this.buildExtensionMap()
    return map.get(parentTagValue) || []
  }

  async getDimensionGroups(
    options?: GetDimensionGroupsOptions | string,
    _language?: string
  ): Promise<DimensionGroupsResponse> {
    // 兼容旧的 string 参数
    const opts: GetDimensionGroupsOptions =
      typeof options === 'string'
        ? { workspaceDirectoryPath: options, language: _language }
        : options || {}

    const {
      workspaceDirectoryPath,
      excludeExtensionDimension = false,
      removeEmptyTags = false,
      selectedTags = [],
      unionMode = 'union'
    } = opts
    const startTime = performance.now()
    let dbQueryTime = 0
    try {
      // 1. 获取所有原始维度数据
      const dbStartTime = performance.now()
      let rawDimensions = this.db
        .prepare(
          'SELECT id, name, tags, trigger_conditions, level FROM file_dimensions ORDER BY level ASC'
        )
        .all() as any[]
      dbQueryTime += performance.now() - dbStartTime

      // 如果需要排除扩展名维度，使用 isExtensionDimension(d) 纯 ID / 结构层判定 (100% 多语言安全)
      if (excludeExtensionDimension) {
        rawDimensions = rawDimensions.filter((d: any) => !isExtensionDimension(d))
      }

      // 创建名称到 ID 的映射
      const nameToIdMap = new Map<string, number>()
      rawDimensions.forEach(d => {
        if (d.name) nameToIdMap.set(d.name.trim(), d.id)
      })

      // 构建有子维度的维度 ID 集合（通过 triggerConditions 判断）
      const dimsWithChildren = new Set<number>()
      rawDimensions.forEach(d => {
        if (d.trigger_conditions) {
          try {
            const tcs = JSON.parse(d.trigger_conditions) as Array<{ parentDimension: string }>
            if (Array.isArray(tcs)) {
              tcs.forEach(tc => {
                const pid = nameToIdMap.get(tc.parentDimension?.trim())
                if (pid) dimsWithChildren.add(pid)
              })
            }
          } catch {
            /* ignore */
          }
        }
      })

      let showMissing = true
      try {
        showMissing =
          ConfigOrchestrator.getInstance().getValue<boolean>('SHOW_MISSING_FILES') ?? true
      } catch {
        // default true if uninitialized
      }

      // --- 性能优化：一次性获取所有标签的全局计数 ---
      let globalCountQuery = `
        SELECT ft.dimension_id, ft.name as tag_name, f.type as file_type, COUNT(DISTINCT wf.id) as count
        FROM file_tags ft
        JOIN file_tag_relations ftr ON ftr.tag_id = ft.id
        JOIN files f ON f.file_fingerprint = ftr.file_fingerprint
        JOIN workspace_files wf ON f.file_fingerprint = wf.file_fingerprint AND wf.is_analyzed = 1
        ${!showMissing ? 'AND wf.status = 1' : ''}
      `
      const globalCountParams: any[] = []
      if (opts.virtualDirectoryId !== undefined) {
        globalCountQuery += `
          JOIN virtual_directory_files vdf ON vdf.file_id = wf.id
          WHERE vdf.virtual_directory_id = ?
        `
        globalCountParams.push(opts.virtualDirectoryId)
      } else if (workspaceDirectoryPath) {
        const sep = path.sep
        const prefix = workspaceDirectoryPath.endsWith(sep)
          ? workspaceDirectoryPath
          : workspaceDirectoryPath + sep
        globalCountQuery += ` WHERE (wf.path LIKE ? OR wf.path = ?)`
        globalCountParams.push(`${prefix}%`, workspaceDirectoryPath)
        console.log('[DimensionManager] 查询路径过滤:', { workspaceDirectoryPath, prefix })
      } else {
        console.warn('[DimensionManager] 未提供工作目录路径且无虚拟目录ID，将返回所有维度标签!')
      }

      // 如果传入了 selectedTags，按标签筛选文件
      if (selectedTags.length > 0) {
        const tagConditions = selectedTags.map((tag, i) => {
          return `EXISTS (
            SELECT 1 FROM file_tag_relations ftr_tag
            JOIN file_tags ft_tag ON ft_tag.id = ftr_tag.tag_id
            WHERE ftr_tag.file_fingerprint = f.file_fingerprint
            AND ft_tag.dimension_id = ? AND (
              LOWER(TRIM(ft_tag.name)) = LOWER(TRIM(?))
              OR LOWER(TRIM(REPLACE(ft_tag.name, '.', ''))) = LOWER(TRIM(REPLACE(?, '.', '')))
            )
          )`
        })
        const joinOperator = unionMode === 'intersection' ? ' AND ' : ' OR '
        const newWhere = `(${tagConditions.join(joinOperator)})`
        globalCountQuery += ` AND ${newWhere}`
        selectedTags.forEach(tag => {
          globalCountParams.push(tag.dimensionId, tag.tagValue, tag.tagValue)
        })
      }

      globalCountQuery += ` GROUP BY ft.dimension_id, ft.name, f.type`

      const allCounts = this.db.prepare(globalCountQuery).all(...globalCountParams) as Array<{
        dimension_id: number
        tag_name: string
        file_type: string
        count: number
      }>

      // 按 dimension_id -> tag_name 组织计数
      const countsMap = new Map<number, Map<string, number>>()
      allCounts.forEach(r => {
        if (!countsMap.has(r.dimension_id)) countsMap.set(r.dimension_id, new Map())
        const dimMap = countsMap.get(r.dimension_id)!
        const allowedExts = this.getExtensionsForTag(r.tag_name)
        if (allowedExts.length > 0 && !allowedExts.includes(r.file_type?.toLowerCase() || ''))
          return
        dimMap.set(r.tag_name, (dimMap.get(r.tag_name) || 0) + r.count)
      })

      const groups: DimensionGroup[] = []

      let panDimensionIds: number[] = [4, 28]
      try {
        panDimensionIds = ConfigOrchestrator.getInstance().getValue<number[]>(
          'PAN_DIMENSION_IDS'
        ) || [4, 28]
      } catch {
        panDimensionIds = [4, 28]
      }
      const panIdSet = new Set([4, 28, ...panDimensionIds.map(Number)])

      // 2. 处理每个维度并构建结果
      for (const dim of rawDimensions) {
        // 标签处理
        const configShowEmptyTags =
          ConfigOrchestrator.getInstance().getValue<boolean>('SHOW_EMPTY_TAGS') ?? false
        const existingTags = this.db
          .prepare('SELECT name FROM file_tags WHERE dimension_id = ?')
          .all(dim.id) as { name: string }[]
        const existingTagNames = existingTags.map(t => t.name)

        const isPanDim = isPanDimension(dim, Array.from(panIdSet))

        let presetTagsList: string[] = JSON.parse(dim.tags || '[]')
        // 若排除扩展名维度，对于含有末尾扩展名触发标签的 L2 维度自动剔除该预设扩展名标签
        if (excludeExtensionDimension) {
          presetTagsList = filterDimensionTags({ id: dim.id, tags: presetTagsList })
        }

        const presetTagMap = new Map<string, string>()
        presetTagsList.forEach(t => {
          if (typeof t === 'string') {
            presetTagMap.set(t.toLowerCase().trim(), t)
          }
        })

        // 仅对泛维度展示所有动态标签；非泛维度只保留属于预设列表的标签（且映射至预设规范大小写，彻底杜绝 Office/office 等重复）
        const validExistingTagNames = isPanDim
          ? existingTagNames
          : existingTagNames
              .filter(t => presetTagMap.has(t.toLowerCase().trim()))
              .map(t => presetTagMap.get(t.toLowerCase().trim())!)

        const tagSet = new Set<string>(validExistingTagNames)
        // 有子维度的维度（如 L2 "视频细分"），或指定 includeAllPresetTags 时，始终包含其完整预设标签列表
        // 确保批量标签等场景下所有维度（如作品来源、内容尺度等）能显示全部候选标签
        if (configShowEmptyTags || opts.includeAllPresetTags || dimsWithChildren.has(dim.id)) {
          presetTagsList.forEach((t: string) => {
            if (excludeExtensionDimension && t.startsWith('.')) {
              return
            }
            tagSet.add(t)
          })
        }
        if (excludeExtensionDimension) {
          for (const t of Array.from(tagSet)) {
            if (t.startsWith('.')) {
              tagSet.delete(t)
            }
          }
        }
        const tagStrings = Array.from(tagSet)

        const triggerConditions = dim.trigger_conditions ? JSON.parse(dim.trigger_conditions) : null

        // 父维度解析
        const parentDimensionIds: number[] = []
        if (triggerConditions && Array.isArray(triggerConditions)) {
          triggerConditions.forEach((tc: any) => {
            const parentId = nameToIdMap.get(tc.parentDimension?.trim())
            if (parentId) parentDimensionIds.push(parentId)
          })
        }

        // 上下文标签计数（含完整 SQL 查询）
        const contextualTags: Record<string, DimensionTag[]> = {}
        if (triggerConditions && Array.isArray(triggerConditions)) {
          for (const tc of triggerConditions) {
            const parentDimId = nameToIdMap.get(tc.parentDimension?.trim())
            if (!parentDimId) continue

            for (const parentTagValue of tc.triggerTags) {
              const extensions = this.getExtsForParentTag(parentTagValue)

              const contextualParams: any[] = [dim.id]
              let parentTagCondition = `
                EXISTS (
                  SELECT 1 FROM file_tag_relations pftr
                  JOIN file_tags pft ON pft.id = pftr.tag_id
                  WHERE pftr.file_fingerprint = f.file_fingerprint AND pft.dimension_id = ? AND (
                    LOWER(TRIM(pft.name)) = LOWER(TRIM(?))
                    OR LOWER(TRIM(REPLACE(pft.name, '.', ''))) = LOWER(TRIM(REPLACE(?, '.', '')))
                  )
                )
              `
              contextualParams.push(parentDimId, parentTagValue, parentTagValue)

              if (extensions.length > 0) {
                const extPhs = extensions.map(() => '?').join(',')
                // 无论是否为题材维度，均使用 AND 约束：只统计同时具有父标签 AND 符合扩展名的文件
                // 使用 OR 会导致：ebook 格式文件（.epub/.pdf）被纳入 image group 的上下文统计，
                // 从而在 image 文件类型下的"电子书"子树中显示"原创"/"轻松"等 ebook 专属标签
                parentTagCondition = `(${parentTagCondition} AND f.type IN (${extPhs}))`
                contextualParams.push(...extensions)
              }

              let contextualCountQuery = `
                SELECT ft.name as tag_name, f.type as file_type, COUNT(DISTINCT wf.id) as count
                FROM file_tags ft
                JOIN file_tag_relations ftr ON ftr.tag_id = ft.id
                JOIN files f ON f.file_fingerprint = ftr.file_fingerprint
                JOIN workspace_files wf ON f.file_fingerprint = wf.file_fingerprint AND wf.is_analyzed = 1
                ${!showMissing ? 'AND wf.status = 1' : ''}
              `
              if (opts.virtualDirectoryId !== undefined) {
                contextualCountQuery += `
                  JOIN virtual_directory_files vdf ON vdf.file_id = wf.id
                  WHERE ft.dimension_id = ? AND ${parentTagCondition} AND vdf.virtual_directory_id = ?
                `
                contextualParams.push(opts.virtualDirectoryId)
              } else {
                contextualCountQuery += `
                  WHERE ft.dimension_id = ? AND ${parentTagCondition}
                `
                if (workspaceDirectoryPath) {
                  const pathSep = path.sep
                  const prefix = workspaceDirectoryPath.endsWith(pathSep)
                    ? workspaceDirectoryPath
                    : workspaceDirectoryPath + pathSep
                  contextualCountQuery += ` AND (wf.path LIKE ? OR wf.path = ?)`
                  contextualParams.push(`${prefix}%`, workspaceDirectoryPath)
                }
              }

              contextualCountQuery += ` GROUP BY ft.name, f.type`

              const cTagCounts = new Map<string, number>()
              try {
                const dbContextualStartTime = performance.now()
                const cCountResults = this.db
                  .prepare(contextualCountQuery)
                  .all(...contextualParams) as {
                  tag_name: string
                  file_type: string
                  count: number
                }[]
                dbQueryTime += performance.now() - dbContextualStartTime

                cCountResults.forEach(r => {
                  const allowedExts = this.getExtensionsForTag(r.tag_name)
                  if (
                    allowedExts.length > 0 &&
                    !allowedExts.includes(r.file_type?.toLowerCase() || '')
                  )
                    return
                  cTagCounts.set(r.tag_name, (cTagCounts.get(r.tag_name) || 0) + r.count)
                })
              } catch (e) {
                logger.error(
                  LogCategory.VIRTUAL_DIRECTORY,
                  `获取维度 ${dim.name} 在父标签 ${parentTagValue} 下的上下文计数失败:`,
                  e
                )
              }

              contextualTags[parentTagValue] = tagStrings.map(tag => ({
                dimensionId: dim.id,
                dimensionName: dim.name,
                tagValue: tag,
                fileCount: cTagCounts.get(tag) || 0,
                level: dim.level
              }))
            }
          }
        }

        // 题材维度特殊计数逻辑：根据父标签推断文件类型并过滤
        const tagCounts = new Map<string, number>()
        const dimCountsMap = countsMap.get(dim.id)
        if (dimCountsMap) {
          const isCompositeDim =
            Array.isArray(triggerConditions) &&
            triggerConditions.length > 1 &&
            new Set(triggerConditions.map((tc: any) => tc.parentDimension)).size > 1

          if (isCompositeDim) {
            // 多父维度维度（如"题材"），需要根据每个具体文件关联的父标签进行后缀过滤
            const dimCounts = allCounts.filter(r => r.dimension_id === dim.id)
            dimCounts.forEach(r => {
              const fileParentTags = this.db
                .prepare(
                  `
                SELECT pft.name
                FROM file_tag_relations pftr
                JOIN file_tags pft ON pft.id = pftr.tag_id
                JOIN files f ON f.file_fingerprint = pftr.file_fingerprint
                WHERE f.type = ? AND pftr.file_fingerprint IN (
                  SELECT ftr.file_fingerprint FROM file_tag_relations ftr
                  JOIN file_tags ft ON ft.id = ftr.tag_id
                  WHERE ft.dimension_id = ? AND (
                    LOWER(TRIM(ft.name)) = LOWER(TRIM(?))
                    OR LOWER(TRIM(REPLACE(ft.name, '.', ''))) = LOWER(TRIM(REPLACE(?, '.', '')))
                  )
                )
              `
                )
                .all(r.file_type, dim.id, r.tag_name, r.tag_name) as Array<{ name: string }>

              const parentTagNames = fileParentTags.map(t => t.name)
              const allowed =
                parentTagNames.length === 0 ||
                parentTagNames.some(parentTag => {
                  const exts = this.getExtsForParentTag(parentTag)
                  return exts.length > 0 && exts.includes(r.file_type?.toLowerCase() || '')
                })

              if (allowed) {
                tagCounts.set(r.tag_name, (tagCounts.get(r.tag_name) || 0) + r.count)
              }
            })
          } else {
            dimCountsMap.forEach((val, key) => tagCounts.set(key, val))
          }
        }

        groups.push({
          id: dim.id,
          name: dim.name,
          level: dim.level,
          tags: tagStrings.map(tag => {
            let count = tagCounts.get(tag) || 0
            if (count === 0) {
              const lower = tag.toLowerCase()
              for (const [k, v] of tagCounts) {
                if (k.toLowerCase() === lower) {
                  count += v
                }
              }
            }
            return {
              dimensionId: dim.id,
              dimensionName: dim.name,
              tagValue: tag,
              fileCount: count,
              level: dim.level
            }
          }),
          contextualTags: Object.keys(contextualTags).length > 0 ? contextualTags : undefined,
          parentDimensionIds: parentDimensionIds.length > 0 ? parentDimensionIds : undefined,
          triggerConditions: triggerConditions || undefined
        })
      }

      // 递归移除零计数标签
      if (removeEmptyTags) {
        this.removeEmptyTagsRecursive(groups)
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
   * 递归移除 fileCount 为 0 且没有子标签的标签
   * 从叶子节点向上处理，确保父标签在子标签被移除后也能被正确清理
   */
  private removeEmptyTagsRecursive(groups: DimensionGroup[]): void {
    // 构建父维度 ID 到子维度的映射
    const childrenMap = new Map<number, DimensionGroup[]>()
    groups.forEach(group => {
      if (group.parentDimensionIds) {
        group.parentDimensionIds.forEach(parentId => {
          if (!childrenMap.has(parentId)) childrenMap.set(parentId, [])
          childrenMap.get(parentId)!.push(group)
        })
      }
    })

    // 从最高层级向下处理，每轮移除零计数标签
    // 重复执行直到没有变化（处理多层嵌套）
    let changed = true
    while (changed) {
      changed = false
      for (const group of groups) {
        const children = childrenMap.get(group.id)
        const hasChildren = children && children.length > 0

        const originalLength = group.tags.length
        group.tags = group.tags.filter(tag => {
          // fileCount > 0 保留
          if (tag.fileCount > 0) return true
          // 有子维度且该标签在子维度中有数据，保留
          if (hasChildren) {
            const childHasTag = children!.some(child =>
              child.tags.some(t => t.fileCount > 0 && t.dimensionId !== group.id)
            )
            if (childHasTag) return true
          }
          // 否则移除
          return false
        })

        if (group.tags.length !== originalLength) {
          changed = true
        }
      }
    }

    // 移除没有标签的维度组
    for (let i = groups.length - 1; i >= 0; i--) {
      if (groups[i].tags.length === 0) {
        groups.splice(i, 1)
      }
    }
  }

  getFileTagsWithDimensions(
    fileId: string
  ): Array<{ dimensionId: number; dimensionName: string; tagValue: string; level: number }> {
    try {
      return this.db
        .prepare(
          `
        SELECT fd.id as dimensionId, fd.name as dimensionName, ft.name as tagValue, fd.level as level
        FROM file_tag_relations ftr
        INNER JOIN file_tags ft ON ft.id = ftr.tag_id
        INNER JOIN file_dimensions fd ON fd.id = ft.dimension_id
        WHERE ftr.file_fingerprint = ?
        ORDER BY fd.level ASC
      `
        )
        .all(fileId) as any[]
    } catch (error) {
      return []
    }
  }
}
