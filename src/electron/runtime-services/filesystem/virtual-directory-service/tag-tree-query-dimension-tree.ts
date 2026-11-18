/**
 * TagTreeQuery · 维度组聚合查询器（partial-class 混入）
 *
 * 拆分自原 TagTreeQuery.ts（只搬不改，逐字节保真）。承载职责：
 * 1. 维度组导航树聚合（getDimensionGroups：SQLite Recursive CTE 下推 + Omni 受控树合并 +
 *    内容标签多级层级链推导 + 预置词表回填）——本方法为单一内聚职责块，内部闭包共享大量
 *    局部状态，强行再拆会改逻辑，故整方法保留；
 * 2. Omni 快速通道响应装配（buildResponseFromOmniTree）；
 * 3. 本地统一配置管理器（ConfigDbManager）受控维度权威表读取（resolveAuthorityDimensions*）。
 *
 * 运行时经 Object.assign(TagTreeQuery.prototype, tagTreeQueryDimensionTreeMixin) 挂回主类；
 * 类型通过 TagTreeQueryDimensionTree 接口并入 TagTreeQuery，外部导入路径与调用签名零变化。
 */
import {
  DimensionFlags,
  DimensionGroup,
  DimensionGroupsResponse,
  DimensionMetadata,
  DimensionTag,
  GetDimensionGroupsOptions
} from '@firefly/types'
import {
  LogCategory,
  logger,
  normalizeForCache,
  getCanonicalConceptName,
  CANONICAL_NAMES,
  concept,
  resolveSubdimensionRoot,
  classifyDimensionMutexScope,
  getParentDimensionCodeOfTag,
  ROOT_DIMENSION_META,
  isControlledConcept,
  CONTROLLED_CODE_TO_CANONICAL_NAME
} from '@firefly/shared'
import path from 'path'
import { DeterministicCodeGenerator } from '@firefly/core-engine'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'
import { ConfigDbManager } from '../../config/config-db-manager'
import { omniClient } from '../../../services/omni-client'
import type { OmniTaxonomyNode } from '../../../services/omni-client'
import { omniService } from '../../system/omni-service'
import {
  CONTENT_TAGS_CODE,
  CONTENT_TAGS_TAIL_ORDER,
  ROOT_DIMENSION_CODES,
  deriveTagMultiSelect
} from './tag-tree-query-shared'
import { escapeLikePrefixWindows, normalizeCodePath } from './tag-tree-query-path-utils'
import type { TagTreeQuery } from './TagTreeQuery'

export interface TagTreeQueryDimensionTree {
  buildResponseFromOmniTree(
    rootNodes: OmniTaxonomyNode[],
    totalNodes: number,
    opts: GetDimensionGroupsOptions,
    locale: string,
    startTime: number
  ): DimensionGroupsResponse

  getDimensionGroups(
    options?: GetDimensionGroupsOptions | string,
    language?: string
  ): Promise<DimensionGroupsResponse>

  resolveAuthorityDimensions(): {
    byCode: Map<
      string,
      { id?: number; flag?: DimensionFlags; tags?: string[]; name?: string; dim?: any }
    >
    byId: Map<
      number,
      { id?: number; flag?: DimensionFlags; tags?: string[]; name?: string; dim?: any }
    >
    all: any[]
  }

  resolveAuthorityDimensionsByCode(): Map<string, { id?: number; flag?: DimensionFlags }>
}

export const tagTreeQueryDimensionTreeMixin = {
  buildResponseFromOmniTree(
    rootNodes: OmniTaxonomyNode[],
    totalNodes: number,
    opts: GetDimensionGroupsOptions,
    locale: string,
    startTime: number
  ): DimensionGroupsResponse {
    const pathCountMap: Record<string, number> = {}

    // 1. 递归提取全量物化路径的去重文件计数
    const extractPathCounts = (node: OmniTaxonomyNode) => {
      if (node.codePath) {
        const norm = normalizeCodePath(node.codePath)
        if (norm) {
          pathCountMap[norm] = node.fileCount ?? 0
        }
      }
      for (const child of node.children || []) {
        extractPathCounts(child)
      }
    }
    for (const root of rootNodes) {
      extractPathCounts(root)
    }

    // 2. 本地权威配置管理器（解析 flag，如 isPanDimension, isFileTypeDimension 等）
    const authorityDimsData = this.resolveAuthorityDimensions()
    const authorityDimByCode = authorityDimsData.byCode
    const authorityDimById = authorityDimsData.byId

    const usedNumericIds = new Set<number>()
    const groups: DimensionGroup[] = []

    for (let rootIdx = 0; rootIdx < rootNodes.length; rootIdx++) {
      const root = rootNodes[rootIdx]
      const authority =
        authorityDimByCode.get(root.code) ||
        (ROOT_DIMENSION_META[root.code]?.id !== undefined
          ? authorityDimById.get(ROOT_DIMENSION_META[root.code].id)
          : undefined)
      const canonicalId = authority?.id ?? ROOT_DIMENSION_META[root.code]?.id
      const id =
        canonicalId !== undefined && !usedNumericIds.has(canonicalId)
          ? canonicalId
          : 10000 + rootIdx
      usedNumericIds.add(id)

      const tags: DimensionTag[] = []

      const collectTags = (
        node: OmniTaxonomyNode,
        parentCode: string,
        level: number,
        parentCodePath: string,
        parentNamePath: string
      ) => {
        for (const child of node.children || []) {
          const currentCodePath = child.codePath || `${parentCodePath}/${child.code}`
          const currentNamePath = child.namePath || `${parentNamePath}/${child.name}`
          const normOmniPath = normalizeCodePath(currentCodePath)
          const count =
            normOmniPath && pathCountMap[normOmniPath] !== undefined
              ? pathCountMap[normOmniPath]
              : (child.fileCount ?? 0)

          if (opts.removeEmptyTags && !opts.includeAllPresetTags && count === 0) {
            collectTags(child, child.code, level + 1, currentCodePath, currentNamePath)
            continue
          }

          tags.push({
            dimensionId: id,
            dimensionCode: root.code,
            dimensionName: root.name,
            tagValue: child.name,
            fileCount: count,
            level,
            code: child.code,
            codePath: currentCodePath,
            namePath: currentNamePath,
            viaParentCode: parentCode || root.code,
            isMultiSelect: false,
            order: child.sortOrder,
            meta: { sort_order: child.sortOrder, order: child.sortOrder, fromControlledTree: true }
          })

          collectTags(child, child.code, level + 1, currentCodePath, currentNamePath)
        }
      }

      collectTags(root, root.code, 1, `/${root.code}`, `/${root.name}`)

      const dimFlag = authority?.flag
      const isMulti = dimFlag?.isMultiSelect ?? false

      groups.push({
        id,
        name: root.name,
        level: 1,
        tags,
        code: root.code,
        order: root.sortOrder || rootIdx + 1,
        isMultiSelect: isMulti,
        metadata: {
          source: root.source || 'builtin',
          order: root.sortOrder || rootIdx + 1,
          isMultiSelect: isMulti,
          ...(dimFlag ? { flag: dimFlag } : {})
        },
        meta: {
          source: root.source || 'builtin',
          order: root.sortOrder || rootIdx + 1,
          isMultiSelect: isMulti,
          ...(dimFlag ? { flag: dimFlag } : {})
        }
      })
    }

    const CODE_SENSITIVE = concept('敏感内容')
    const CODE_EROTIC = concept('色情分级')
    const CODE_CONTENT_RATING = concept('内容分级')
    const isSensitiveDimension = (g: any): boolean => {
      const code = g.code || ''
      const id = Number(g.id)
      if (
        code === CODE_SENSITIVE ||
        code === CODE_EROTIC ||
        code === CODE_CONTENT_RATING ||
        (code &&
          (resolveSubdimensionRoot(code) === CODE_CONTENT_RATING ||
            resolveSubdimensionRoot(code) === CODE_SENSITIVE))
      ) {
        return true
      }
      if (id === 130 || id === 123 || id === 162) return true
      if (id >= 131 && id <= 134) return true
      if (id >= 150 && id <= 161) return true
      return false
    }

    const validGroups = groups.filter(g => {
      if (isSensitiveDimension(g)) {
        const hasFileHit = Array.isArray(g.tags) && g.tags.some(t => (t.fileCount || 0) > 0)
        if (!hasFileHit) return false
      }
      if (g.tags && g.tags.length > 0) return true
      const isPan =
        (typeof g.metadata === 'object' && g.metadata !== null
          ? (g.metadata as any).flag?.isPanDimension
          : false) === true || (g.metadata as any)?.isPanDimension === true
      if (opts.includeAllPresetTags && isPan) return true
      return false
    })

    return {
      groups: validGroups,
      pathCountMap,
      performance: {
        dbQueryTime: 0,
        totalTime: Math.round((performance.now() - startTime) * 100) / 100
      }
    }
  },

  async getDimensionGroups(
    options?: GetDimensionGroupsOptions | string,
    language?: string
  ): Promise<DimensionGroupsResponse> {
    const startTime = performance.now()
    let dbQueryTime = 0

    const opts: GetDimensionGroupsOptions =
      typeof options === 'string' ? { workspaceDirectoryPath: options, language } : options || {}

    const {
      workspaceDirectoryPath,
      excludeExtensionDimension = false,
      removeEmptyTags = false,
      selectedTags = [],
      unionMode = 'intersection',
      includeAllPresetTags = false
    } = opts

    // includeAllPresetTags 的契约是「回填全部受控预置维度与标签，含文件计数为 0 的标签」，
    // 目前仅由下方 SQLite CTE 主路径的第 8 步（本地权威配置词表回填）实现。
    // Omni 快速通道的 buildResponseFromOmniTree 只回传当前作用域内已命中的树节点，
    // 不带预置词表，若在此提前返回，批量标签 / 维度管理页的 0 计数标签会整体消失。
    // 故此类请求统一落回主路径，严禁为了性能绕过全量预置标签补全。
    const useOmniFastPath =
      !includeAllPresetTags &&
      opts.virtualDirectoryId === undefined &&
      (!selectedTags || selectedTags.length === 0) &&
      typeof omniService?.isReady === 'function' &&
      omniService.isReady()

    if (useOmniFastPath) {
      try {
        const dbPath = (this.db as any).name || (this.db as any).filename
        const treeRes = await omniClient.getTaxonomyTree(
          opts.language || language || 'zh-CN',
          undefined,
          dbPath,
          {
            workspaceId: opts.workspaceId,
            directoryPrefix: workspaceDirectoryPath
          }
        )
        if (treeRes?.rootNodes && treeRes.rootNodes.length > 0) {
          return this.buildResponseFromOmniTree(
            treeRes.rootNodes,
            treeRes.totalNodes,
            opts,
            opts.language || language || 'zh-CN',
            startTime
          )
        }
      } catch (err) {
        logger.warn(
          LogCategory.VIRTUAL_DIRECTORY,
          '[TagTreeQuery] Omni 快速通道失败，平滑降级至 SQLite CTE:',
          err
        )
      }
    }

    try {
      const locale = opts.language || language || 'zh-CN'
      // 多语言别名已落库分表，展示名直接查 DB，无需内存总线 TaxonomyAliasCache
      // 如需确保当前语言分表存在，可在此调用 createTagAliasesLangTable(db, locale)

      if ((opts as any).forceRefresh || (opts as any).refresh) {
        omniClient.clearTaxonomyTreeCache()
      }

      // 构建本地父→子邻接图（同步，无 HTTP；Omni 边在获取 treeRes 后追加）
      this.ensureLocalChildrenMap()

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

      // 1. 获取所有维度根节点（本地动态标签：expanded/user；受控根节点来自 Omni 树）
      // PRD-0060 v2.2/v2.3：原 `json_extract(meta,'$.isDimension')=1` 与 `source='dimension'`
      // 两个条件已废除 ——「用户自定义维度」功能在代码中不存在（无创建入口 / 无写入者），
      // 且 `file_tags_private.source` CHECK 已收紧为 ('expanded','user')。维度根判据只剩「无父」。
      const dbStart = performance.now()
      let dimensionRoots = this.db
        .prepare(
          `
          SELECT code, name, file_groups, meta
          FROM file_tags_private
          WHERE parent_codes = '[]' OR parent_codes IS NULL
          ORDER BY code ASC
        `
        )
        .all() as Array<{
        code: string
        name: string
        file_groups: string | null
        meta: string
      }>
      dbQueryTime += performance.now() - dbStart

      // 方案 A 让渡点 1：维度根节点查询后，让事件循环处理 IPC，防连续重查询堵死 API
      await this.yieldToEventLoop()

      if (excludeExtensionDimension) {
        dimensionRoots = dimensionRoots.filter(d => {
          return !/扩展名|Extension/i.test(d.name) && !/扩展名|Extension/i.test(d.code)
        })
      }

      // 2. 获取所有标签节点（#625：透出 code/parent_codes/meta 供前端纯树形状态机消费）
      // 原 `isDimension IS NULL OR = 0` 过滤条件已废除（该标志位无写入者，条件恒真）。
      const tagRows = this.db
        .prepare(
          `
          SELECT code, name, parent_codes, file_groups, meta
          FROM file_tags_private
          ORDER BY code ASC
        `
        )
        .all() as Array<{
        code: string
        name: string
        parent_codes: string
        file_groups: string | null
        meta: string
      }>

      // 方案 A 让渡点 2：标签全量查询（最重之一）后让渡
      await this.yieldToEventLoop()

      // 3. 构建当前工作区/选区内的有效文件指纹集
      let baseWhere = 'WHERE wf.is_analyzed = 1'
      const baseParams: any[] = []
      if (!showMissing) {
        baseWhere += ' AND wf.status = 1'
      }
      if (opts.workspaceId !== undefined && opts.workspaceId !== null) {
        baseWhere += ' AND wf.workspace_id = ?'
        baseParams.push(opts.workspaceId)
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
        const escapedPrefix = escapeLikePrefixWindows(prefix)
        baseWhere += " AND (wf.path = ? OR wf.path LIKE ? || '%' ESCAPE '|')"
        baseParams.push(workspaceDirectoryPath, escapedPrefix)
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
        // 与 buildFilterQuery 共用同一排他性穿透子句构造器（单一事实源，保障 AC-4 徽标/列表口径一致）
        if (unionMode === 'union') {
          const clauses: string[] = []
          for (const st of selectedTags) {
            const clause = this.buildTagFilterSubClause(st, filteredFingerprintsParams)
            if (clause) clauses.push(clause)
          }
          if (clauses.length > 0) {
            filteredFingerprintsSql += `
              AND ${this.buildUnionFingerprintsCondition(clauses)}
            `
          }
        } else {
          // intersection
          for (const st of selectedTags) {
            const clause = this.buildTagFilterSubClause(st, filteredFingerprintsParams)
            if (clause) {
              filteredFingerprintsSql += `
                AND wf.file_fingerprint IN (
                  SELECT ftr.file_fingerprint
                  FROM file_tag_relations ftr
                  WHERE ${clause}
                )
              `
            }
          }
        }
      }

      // 4. 高性能单向流递归 CTE (Spec §3.1.3: 有界深度熔断与内存聚合，占位符严格同源)
      try {
        this.db.pragma('temp_store = MEMORY')
        this.db.pragma('cache_size = -65536')
      } catch {}

      const countStartTime = performance.now()

      // A. 聚合前缀路径计数 (直出 pathCountMap，中间行永不入 Node.js 内存)
      const prefixCountSql = `
        WITH RECURSIVE
        target_pairs AS (
          SELECT DISTINCT wf.id AS file_id, ftr.code_path
          FROM workspace_files wf
          JOIN file_tag_relations ftr ON ftr.file_fingerprint = wf.file_fingerprint
          WHERE wf.file_fingerprint IN (${filteredFingerprintsSql})
            AND ftr.code_path IS NOT NULL
            AND ftr.code_path LIKE '/%'
        ),
        split_prefixes(file_id, prefix_code_path, rest_path, curr_depth) AS (
          SELECT
            file_id,
            '/' || substr(code_path, 2, instr(substr(code_path, 2) || '/', '/') - 1) AS prefix_code_path,
            CASE
              WHEN instr(substr(code_path, 2), '/') > 0
              THEN substr(code_path, instr(substr(code_path, 2), '/') + 2)
              ELSE ''
            END AS rest_path,
            1 AS curr_depth
          FROM target_pairs

          UNION ALL

          SELECT
            file_id,
            prefix_code_path || '/' || substr(rest_path, 1, instr(rest_path || '/', '/') - 1),
            CASE
              WHEN instr(rest_path, '/') > 0
              THEN substr(rest_path, instr(rest_path, '/') + 1)
              ELSE ''
            END,
            curr_depth + 1
          FROM split_prefixes
          WHERE rest_path != ''
            AND rest_path IS NOT NULL
            AND curr_depth < 12
        )
        SELECT prefix_code_path, COUNT(DISTINCT file_id) AS file_count
        FROM split_prefixes
        GROUP BY prefix_code_path
      `
      const prefixRows = this.db
        .prepare(prefixCountSql)
        .all(...filteredFingerprintsParams) as Array<{
        prefix_code_path: string
        file_count: number
      }>

      // 方案 A 让渡点 3：递归 CTE 前缀计数（最重的树聚合查询）后让渡
      await this.yieldToEventLoop()

      // B. 聚合标签本身命中计数
      const tagCountSql = `
        SELECT ftr.tag_code, COUNT(DISTINCT wf.id) AS file_count
        FROM file_tag_relations ftr
        JOIN workspace_files wf ON wf.file_fingerprint = ftr.file_fingerprint
        WHERE ftr.file_fingerprint IN (${filteredFingerprintsSql})
        GROUP BY ftr.tag_code
      `
      const tagCountRows = this.db
        .prepare(tagCountSql)
        .all(...filteredFingerprintsParams) as Array<{
        tag_code: string
        file_count: number
      }>

      // 方案 A 让渡点 4：标签命中计数查询后让渡
      await this.yieldToEventLoop()

      // C. 聚合 tag::via_parent 命中计数
      const tagParentCountSql = `
        SELECT ftr.tag_code, ftr.via_parent_code, COUNT(DISTINCT wf.id) AS file_count
        FROM file_tag_relations ftr
        JOIN workspace_files wf ON wf.file_fingerprint = ftr.file_fingerprint
        WHERE ftr.file_fingerprint IN (${filteredFingerprintsSql})
          AND ftr.via_parent_code IS NOT NULL
        GROUP BY ftr.tag_code, ftr.via_parent_code
      `
      const tagParentRows = this.db
        .prepare(tagParentCountSql)
        .all(...filteredFingerprintsParams) as Array<{
        tag_code: string
        via_parent_code: string
        file_count: number
      }>

      // 方案 A 让渡点 5：tag::via_parent 计数查询后让渡
      await this.yieldToEventLoop()

      // D. 提取去重后的标签物化路径对照 (几十到几百行，轻量传输)
      const tagChainsSql = `
        SELECT DISTINCT ftr.tag_code, ftr.code_path, ftr.name_path
        FROM file_tag_relations ftr
        WHERE ftr.file_fingerprint IN (${filteredFingerprintsSql})
          AND ((ftr.code_path IS NOT NULL AND ftr.code_path != '') OR (ftr.name_path IS NOT NULL AND ftr.name_path != ''))
      `
      const chainRows = this.db.prepare(tagChainsSql).all(...filteredFingerprintsParams) as Array<{
        tag_code: string
        code_path: string
        name_path: string
      }>

      dbQueryTime += performance.now() - countStartTime

      const tagCountMap = new Map<string, number>()
      const tagParentCountMap = new Map<string, number>()
      const tagFilesMap = new Map<string, Set<string>>()
      const tagChainsMap = new Map<string, Array<{ name_path: string; code_path: string }>>()
      const pathCountMap: Record<string, number> = {}

      for (const r of prefixRows) {
        const norm = normalizeCodePath(r.prefix_code_path)
        if (norm) {
          pathCountMap[norm] = r.file_count
        }
      }

      for (const r of tagCountRows) {
        tagCountMap.set(r.tag_code, r.file_count)
      }

      for (const r of tagParentRows) {
        tagParentCountMap.set(`${r.tag_code}::${r.via_parent_code}`, r.file_count)
      }

      for (const r of chainRows) {
        if (!tagChainsMap.has(r.tag_code)) {
          tagChainsMap.set(r.tag_code, [])
        }
        tagChainsMap.get(r.tag_code)!.push({
          name_path: r.name_path || '',
          code_path: r.code_path || ''
        })
      }
      const hasPathIndex = Object.keys(pathCountMap).length > 0

      // 5. 按照维度归类本地动态标签并组织树形结构
      const groups: DimensionGroup[] = []
      const seenDimCodes = new Set<string>()
      const assignedCodes = new Set<string>()
      // 别名解析（Fix-06）：收集本次请求全部标签 code 后一次性批量解析展示名，
      // 消除逐节点 await 的 N+1；locale 在本请求作用域只读一次（与本方法开头的 locale 同源）。
      // 解析失败属可容忍降级（回退 file_tags.name / code），记 warn 暴露缺陷。
      const aliasMap: Record<string, string> = {}
      const aliasCodes = new Set<string>()
      for (const root of dimensionRoots) aliasCodes.add(root.code)
      for (const t of tagRows) aliasCodes.add(t.code)
      if (aliasCodes.size > 0) {
        try {
          const { databaseService } = await import('@runtime/database/database-service')
          Object.assign(
            aliasMap,
            databaseService.resolveTagDisplayNames(Array.from(aliasCodes), locale, this.db)
          )
        } catch (err) {
          logger.warn(
            LogCategory.VIRTUAL_DIRECTORY,
            '[TagTreeQuery] 批量标签展示名解析失败，回退 file_tags.name:',
            err
          )
        }
      }
      const aliasResolver = (code: string, fallbackName?: string): string => {
        const resolved = aliasMap[code]
        if (resolved && resolved !== code) return resolved
        if (code.startsWith('builtin.') || code.startsWith('omw.') || code.startsWith('hownet.')) {
          const canonical = getCanonicalConceptName(code)
          if (canonical) return canonical
        }
        return fallbackName || code
      }

      // 建立动态子标签映射：parentCode -> Array<{ code, name, meta, count }>
      const dynamicTagsByParent = new Map<
        string,
        Array<{
          code: string
          name: string
          meta: any
          count: number
        }>
      >()

      for (const t of tagRows) {
        const count = tagCountMap.get(t.code) || 0
        const resolvedName = aliasResolver(t.code, t.name)
        let parents: string[] = []
        try {
          parents = JSON.parse(t.parent_codes || '[]')
        } catch {
          parents = []
        }
        // parent_codes 为空数组或仅含 CONTENT_TAGS_CODE 的标签，若本身为受控标签，自愈为真实受控父维度
        let effectiveParents = parents.filter(p => p && p !== CONTENT_TAGS_CODE)
        if (effectiveParents.length === 0) {
          const directParentDim = getParentDimensionCodeOfTag(t.code)
          if (directParentDim && directParentDim !== CONTENT_TAGS_CODE) {
            effectiveParents = [directParentDim]
          } else {
            effectiveParents = [CONTENT_TAGS_CODE]
          }
        }
        for (const p of effectiveParents) {
          if (!dynamicTagsByParent.has(p)) {
            dynamicTagsByParent.set(p, [])
          }
          let parsedMeta = {}
          try {
            parsedMeta = JSON.parse(t.meta || '{}')
          } catch {}
          dynamicTagsByParent.get(p)!.push({
            code: t.code,
            name: resolvedName,
            meta: parsedMeta,
            count
          })
        }
      }

      // 本地统一配置管理器权威维度表（code/id -> 规范 id + metadata.flag）：
      // omni 树自身不带策略元数据，前端的 flag 判定（isPanDimension / isFileTypeDimension …）
      // 必须由本地配置管理器按 code/id 补齐，严禁改向 Omni 索取。
      const authorityDimsData = this.resolveAuthorityDimensions()
      const authorityDimByCode = authorityDimsData.byCode
      const authorityDimById = authorityDimsData.byId
      const allAuthorityDims = authorityDimsData.all

      for (const root of dimensionRoots) {
        const dimCode = root.code
        seenDimCodes.add(dimCode)
        let dimMeta: DimensionMetadata = {}
        try {
          dimMeta = JSON.parse(root.meta || '{}')
        } catch (err) {
          // meta 脏数据属可容忍降级：按空元数据处理
          logger.debug(
            LogCategory.VIRTUAL_DIRECTORY,
            `[TagTreeQuery] 解析维度根节点 meta 失败（${root.code}），按空对象处理:`,
            err
          )
        }

        // 匹配该维度下的直属子标签
        const directChildren = tagRows.filter(t => {
          let parentCodes: string[] = []
          try {
            parentCodes = JSON.parse(t.parent_codes || '[]')
          } catch (err) {
            // parent_codes 脏数据属可容忍降级：视为无父，仅按 code 前缀匹配归属
            logger.debug(
              LogCategory.VIRTUAL_DIRECTORY,
              `[TagTreeQuery] 解析 parent_codes 失败（${t.code}），按空数组处理:`,
              err
            )
          }
          return parentCodes.includes(dimCode) || t.code.startsWith(`${dimCode}.`)
        })

        const dimensionTags: DimensionTag[] = []

        // 提取数值型 ID 用于向前兼容并优先采用受控权威规范 ID（如作者为 4，内容标签为 28）
        const numIdMatch = dimCode.match(/^dim\.(\d+)$/)
        const authority =
          authorityDimByCode.get(dimCode) ||
          (ROOT_DIMENSION_META[dimCode]?.id !== undefined
            ? authorityDimById.get(ROOT_DIMENSION_META[dimCode].id)
            : undefined)
        const canonicalId =
          authority?.id ??
          ROOT_DIMENSION_META[dimCode]?.id ??
          (numIdMatch ? parseInt(numIdMatch[1], 10) : groups.length + 1)
        const dimFlag = authority?.flag

        for (const child of directChildren) {
          // #625：解析子标签的 meta 与 parent_codes，透出给前端纯树形状态机
          let childMeta: DimensionMetadata = {}
          try {
            childMeta = JSON.parse(child.meta || '{}')
          } catch (err) {
            // meta 脏数据属可容忍降级：按空元数据处理
            logger.debug(
              LogCategory.VIRTUAL_DIRECTORY,
              `[TagTreeQuery] 解析子标签 meta 失败（${child.code}），按空对象处理:`,
              err
            )
          }
          let childParentCodes: string[] = []
          try {
            childParentCodes = JSON.parse(child.parent_codes || '[]')
          } catch (err) {
            // parent_codes 脏数据属可容忍降级：回退当前维度根作为父级
            logger.debug(
              LogCategory.VIRTUAL_DIRECTORY,
              `[TagTreeQuery] 解析子标签 parent_codes 失败（${child.code}），回退当前维度根:`,
              err
            )
          }
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

          const branchPrefix = `/${dimCode}/${child.code}`
          const matchedChain = tagChainsMap
            .get(child.code)
            ?.find(c => c.code_path.startsWith(`/${dimCode}/`))
          const childCodePath = matchedChain?.code_path || branchPrefix
          const childNamePath =
            matchedChain?.name_path ||
            `/${aliasResolver(root.code, root.name)}/${aliasResolver(child.code, child.name)}`

          let childCount = aggregatedCount
          const normChildPath = normalizeCodePath(childCodePath)
          if (normChildPath && pathCountMap[normChildPath] !== undefined) {
            childCount = pathCountMap[normChildPath]
          } else if (hasPathIndex) {
            childCount = 0
          }

          if (removeEmptyTags && !includeAllPresetTags && childCount === 0) {
            continue
          }

          assignedCodes.add(child.code)
          dimensionTags.push({
            dimensionId: canonicalId,
            dimensionCode: dimCode,
            dimensionName: aliasResolver(root.code, root.name),
            tagValue: aliasResolver(child.code, child.name),
            fileCount: childCount,
            level: 1,
            code: child.code,
            codePath: childCodePath,
            namePath: childNamePath,
            viaParentCode: childParentCodes[0] || dimCode,
            isMultiSelect: childMeta?.isMultiSelect === true
          })
        }

        // 递归收集该维度下直属子标签的深层动态后代
        const collectDynInDim = (parentCodeKey: string, curLevel: number) => {
          const children = dynamicTagsByParent.get(parentCodeKey) || []
          for (const sub of children) {
            if (dimensionTags.some(t => t.code === sub.code || t.tagValue === sub.name)) continue
            const branchPrefix = `/${dimCode}/${parentCodeKey}/${sub.code}`
            const matchedChain = tagChainsMap
              .get(sub.code)
              ?.find(c => c.code_path.startsWith(`/${dimCode}/`))
            const subCodePath = matchedChain?.code_path || branchPrefix
            const subNamePath =
              matchedChain?.name_path || `/${aliasResolver(root.code, root.name)}/${sub.name}`

            let subCount = sub.count
            const normSubPath = normalizeCodePath(subCodePath)
            if (normSubPath && pathCountMap[normSubPath] !== undefined) {
              subCount = pathCountMap[normSubPath]
            } else if (hasPathIndex) {
              subCount = 0
            }

            if (removeEmptyTags && !includeAllPresetTags && subCount === 0) {
              continue
            }

            assignedCodes.add(sub.code)
            dimensionTags.push({
              dimensionId: canonicalId,
              dimensionCode: dimCode,
              dimensionName: aliasResolver(root.code, root.name),
              tagValue: sub.name,
              fileCount: subCount,
              level: curLevel,
              code: sub.code,
              codePath: subCodePath,
              namePath: subNamePath,
              viaParentCode: parentCodeKey,
              isMultiSelect: sub.meta?.isMultiSelect === true
            })
            collectDynInDim(sub.code, curLevel + 1)
          }
        }
        for (const child of directChildren) {
          collectDynInDim(child.code, 2)
        }

        // 对于根级，如果其下没有子标签，则根级数据不应输出，也不应展示
        if (dimensionTags.length === 0) {
          continue
        }

        // 多选策略唯一权威源 = 本地配置管理器（dimFlag，来自 dimension-policies.json）；
        // DB 维度根 meta 仅在无权威策略时兜底，严禁用 || 合并。
        // 历史事故：database-adapter 写根 meta 时硬编码 isMultiSelect:true，旧逻辑 `dimMeta || dimFlag`
        // 会让硬编码恒短路权威策略 ⇒ 全部维度在前端恒多选、单选互斥永不生效。
        const flagMultiSelect = dimFlag?.isMultiSelect
        const metaMultiSelect = dimMeta?.isMultiSelect
        const resolvedMultiSelect =
          typeof flagMultiSelect === 'boolean'
            ? flagMultiSelect
            : typeof metaMultiSelect === 'boolean'
              ? metaMultiSelect
              : false
        const mergedDimMeta = {
          ...(dimMeta || {}),
          isMultiSelect: resolvedMultiSelect,
          ...(dimFlag ? { flag: dimFlag } : {})
        }

        groups.push({
          id: canonicalId,
          name: aliasResolver(root.code, root.name),
          level: 1,
          tags: dimensionTags,
          code: dimCode,
          isMultiSelect: resolvedMultiSelect,
          metadata: { ...mergedDimMeta },
          meta: { ...mergedDimMeta }
        })
      }

      // 6. 合并 Omni 受控分类树（builtin / omw 不再入库主库，走 HTTP API 拉取树结构）
      const dbPath = (this.db as any).name
      let treeRes: Awaited<ReturnType<typeof omniClient.getTaxonomyTree>> | null = null
      try {
        treeRes = await omniClient.getTaxonomyTree(locale, undefined, dbPath, {
          workspaceId: opts.workspaceId,
          directoryPrefix: workspaceDirectoryPath
        })
      } catch (omniErr) {
        logger.warn(
          LogCategory.VIRTUAL_DIRECTORY,
          '[TagTreeQuery] omniClient.getTaxonomyTree 失败，降级使用本地预设维度:',
          omniErr
        )
      }
      // 将 Omni 受控树父→子边注入邻接图（复用本次 HTTP 结果，无需再次请求）
      if (treeRes?.rootNodes) {
        this.buildOmniEdgesFromTree(treeRes.rootNodes)
      }

      // 构建全量 Omni 受控多级节点（含别名/名称）到顶层 Root Code 的映射，支持深层标签精准归位
      const omniCodeToRootCodeMap = new Map<string, string>()
      if (treeRes?.rootNodes) {
        const mapOmniSubtree = (node: OmniTaxonomyNode, rootCode: string) => {
          if (node.code) omniCodeToRootCodeMap.set(node.code, rootCode)
          if (node.name) omniCodeToRootCodeMap.set(node.name, rootCode)
          for (const child of node.children || []) {
            mapOmniSubtree(child, rootCode)
          }
        }
        for (const root of treeRes.rootNodes) {
          mapOmniSubtree(root, root.code)
        }
      }

      // 已占用的数值 ID（本地维度组 canonicalId）集合，避免与受控根维度规范 ID 冲突
      const usedNumericIds = new Set<number>(groups.map(g => g.id))

      const omniGroups: Array<Omit<DimensionGroup, 'tags'> & { tags: DimensionTag[] }> =
        treeRes?.rootNodes
          ? treeRes.rootNodes.map((root, rootIdx) => {
              // 受控根维度采用本地权威规范 ID（builtin.file_type=1 / content_tags=28 / content_rating=162 …），
              // 使前端的 ID 兜底判定（如 isFileTypeDimension 的 `id === 1`）在 omni 组上同样成立；
              // 仅当权威表缺失或该 ID 已被本地维度组占用时，才退回 10000 + 序号 的隔离区间。
              const authority =
                authorityDimByCode.get(root.code) ||
                (ROOT_DIMENSION_META[root.code]?.id !== undefined
                  ? authorityDimById.get(ROOT_DIMENSION_META[root.code].id)
                  : undefined)
              const canonicalId = authority?.id ?? ROOT_DIMENSION_META[root.code]?.id
              const id =
                canonicalId !== undefined && !usedNumericIds.has(canonicalId)
                  ? canonicalId
                  : 10000 + rootIdx
              usedNumericIds.add(id)
              const tags: DimensionTag[] = []

              // 后序递归汇聚整棵子树的唯一下属文件集合（保证祖先节点包含全部子孙命中，避免父级 count=0 被误裁剪）
              const nodeFilesMap = new Map<string, Set<string>>()
              const computeNodeSubtreeFiles = (node: OmniTaxonomyNode): Set<string> => {
                const fileSet = new Set<string>()

                // 1. 本节点自身命中文件（基于当前工作区与目录作用域的 tagFilesMap，100% 遵从受控 Code）
                const directFiles = tagFilesMap.get(node.code)
                if (directFiles) {
                  for (const f of directFiles) fileSet.add(f)
                }

                // 2. 本地数据库中归属于当前 node.code 的动态扩展标签（含多级递归）
                const collectDynFiles = (pCode: string) => {
                  const dynList = dynamicTagsByParent.get(pCode) || []
                  for (const dyn of dynList) {
                    const dynFiles = tagFilesMap.get(dyn.code)
                    if (dynFiles) {
                      for (const f of dynFiles) fileSet.add(f)
                    }
                    collectDynFiles(dyn.code)
                  }
                }
                collectDynFiles(node.code)

                // 3. 递归汇聚全部子节点的下属文件集合
                for (const child of node.children || []) {
                  const childSet = computeNodeSubtreeFiles(child)
                  for (const f of childSet) fileSet.add(f)
                }

                nodeFilesMap.set(node.code, fileSet)
                return fileSet
              }

              computeNodeSubtreeFiles(root)

              const collect = (
                node: OmniTaxonomyNode,
                parentCode: string,
                level: number,
                parentCodePath = `/${node.code}`,
                parentNamePath = `/${node.name}`
              ) => {
                // A. Omni 受控树定义的子节点
                for (const child of node.children || []) {
                  const code = child.code
                  assignedCodes.add(code)
                  const subtreeFiles = nodeFilesMap.get(code)
                  let count =
                    subtreeFiles !== undefined
                      ? subtreeFiles.size
                      : (child.fileCount ??
                        tagParentCountMap.get(`${code}::${parentCode}`) ??
                        tagCountMap.get(code) ??
                        0)

                  // 直通透传：优先采用 Omni 已物化的 codePath / namePath（spec §3.4.1），
                  // 仅在 Omni 未回填时按父链兜底拼接，杜绝「组装后打平再递归拼树」的双重损耗。
                  const currentCodePath = child.codePath || `${parentCodePath}/${child.code}`
                  const currentNamePath = child.namePath || `${parentNamePath}/${child.name}`
                  const normOmniPath = normalizeCodePath(currentCodePath)
                  if (normOmniPath) {
                    if (pathCountMap[normOmniPath] !== undefined) {
                      count = pathCountMap[normOmniPath]
                    } else if (hasPathIndex) {
                      // 路径前缀索引池已建立，未命中说明此物理路径下 0 文件命中 (杜绝跨分支/跨介质虚假计数继承)
                      count = 0
                    }
                  }
                  tags.push({
                    dimensionId: id,
                    dimensionCode: root.code,
                    dimensionName: aliasResolver(root.code, root.name),
                    tagValue: aliasResolver(child.code, child.name),
                    fileCount: count,
                    level,
                    code,
                    codePath: currentCodePath,
                    namePath: currentNamePath,
                    viaParentCode: parentCode || root.code,
                    isMultiSelect: false,
                    order: child.sortOrder,
                    // fromControlledTree：Omni 受控树节点来源标记（铁闸门禁跨域撞名豁免的判定锚，
                    // 见下方铁闸注释；动态扩展/预设补全/本地孤儿标签不得携带）
                    meta: {
                      sort_order: child.sortOrder,
                      order: child.sortOrder,
                      fromControlledTree: true
                    }
                  })
                  collect(child, code, level + 1, currentCodePath, currentNamePath)
                }
                // B. 本地数据库中归属于当前 node.code 的动态扩展标签（支持深层多级后代递归）
                const collectDynamic = (
                  parentCodeKey: string,
                  curLevel: number,
                  curCodePath: string,
                  curNamePath: string
                ) => {
                  const dynChildren = dynamicTagsByParent.get(parentCodeKey) || []
                  for (const dyn of dynChildren) {
                    if (tags.some(t => t.code === dyn.code || t.tagValue === dyn.name)) {
                      assignedCodes.add(dyn.code) // 同名已认领，避免落入孤儿池
                      continue
                    }
                    const branchPrefix = `${curCodePath}/${dyn.code}`
                    const matchedChain = tagChainsMap
                      .get(dyn.code)
                      ?.find(c => c.code_path.startsWith(curCodePath))
                    const dynCodePath = matchedChain?.code_path || branchPrefix
                    const dynNamePath = matchedChain?.name_path || `${curNamePath}/${dyn.name}`

                    let dynCount = dyn.count
                    const normDynPath = normalizeCodePath(dynCodePath)
                    if (normDynPath && pathCountMap[normDynPath] !== undefined) {
                      dynCount = pathCountMap[normDynPath]
                    } else if (hasPathIndex) {
                      dynCount = 0
                    }

                    if (removeEmptyTags && !includeAllPresetTags && dynCount === 0) {
                      continue
                    }

                    assignedCodes.add(dyn.code)
                    tags.push({
                      dimensionId: id,
                      dimensionCode: root.code,
                      dimensionName: aliasResolver(root.code, root.name),
                      tagValue: dyn.name,
                      fileCount: dynCount,
                      level: curLevel,
                      code: dyn.code,
                      codePath: dynCodePath,
                      namePath: dynNamePath,
                      viaParentCode: parentCodeKey,
                      isMultiSelect: dyn.meta?.isMultiSelect === true,
                      order: 9999,
                      meta: dyn.meta
                    })
                    collectDynamic(dyn.code, curLevel + 1, dynCodePath, dynNamePath)
                  }
                }
                collectDynamic(node.code, level, parentCodePath, parentNamePath)
              }
              const resolvedRootName = aliasResolver(root.code, root.name)
              collect(
                root,
                root.code,
                1,
                root.codePath || `/${root.code}`,
                root.namePath || `/${resolvedRootName}`
              )
              return {
                id,
                name: resolvedRootName,
                level: 0,
                tags,
                code: root.code,
                order: root.sortOrder,
                sort_order: root.sortOrder,
                isMultiSelect: false,
                // metadata.flag 来自本地统一配置管理器（ConfigDbManager）按 code 的权威策略，
                // 缺失时保持原有无 flag 形态（前端退化为 ID 兜底判定）
                meta: {
                  source: root.source || 'builtin',
                  order: root.sortOrder,
                  sort_order: root.sortOrder,
                  ...(authority?.flag ? { flag: authority.flag } : {})
                },
                metadata: {
                  source: root.source || 'builtin',
                  order: root.sortOrder,
                  sort_order: root.sortOrder,
                  ...(authority?.flag ? { flag: authority.flag } : {})
                }
              }
            })
          : []
      const seenDimNames = new Set<string>()
      for (const g of groups) {
        if (g.name) seenDimNames.add(g.name)
      }

      for (const og of omniGroups) {
        const code = og.code
        if (!code || seenDimCodes.has(code)) continue
        // 根级名称去重：杜绝出现同名重复的根级维度（以先入的受控/主库主干为准）
        if (og.name && seenDimNames.has(og.name)) continue

        let tags = og.tags || []
        if (excludeExtensionDimension) {
          tags = tags.filter(
            t => !/扩展名|Extension/i.test(t.tagValue) && !/扩展名|Extension/i.test(t.code || '')
          )
        }
        if (removeEmptyTags && !includeAllPresetTags) {
          tags = tags.filter(t => t.fileCount > 0)
        }
        const isPan =
          (typeof og.metadata === 'object' && og.metadata !== null
            ? (og.metadata as any).flag?.isPanDimension
            : false) === true || (og.metadata as any)?.isPanDimension === true
        // 对于根级，如果其下没有子标签，且非批量预设模式下的泛维度，则根级数据不应输出，也不应展示
        if (tags.length === 0 && !(includeAllPresetTags && isPan)) continue

        seenDimCodes.add(code)
        if (og.name) seenDimNames.add(og.name)

        // 子标签按 order / sort_order 升序优先排序
        tags.sort((a, b) => {
          const orderA = a.order !== undefined && a.order > 0 ? a.order : 999999
          const orderB = b.order !== undefined && b.order > 0 ? b.order : 999999
          return orderA - orderB
        })

        groups.push({ ...og, tags })
      }

      // 顶层主干根节点按 sort_order 升序排序
      groups.sort((a, b) => {
        // builtin.content_tags 恒定垫底（无条件，优先于 order 档，与前端比较层口径统一）
        const isTailA = a.code === CONTENT_TAGS_CODE
        const isTailB = b.code === CONTENT_TAGS_CODE
        if (isTailA !== isTailB) return isTailA ? 1 : -1
        const orderA = a.order !== undefined && a.order > 0 ? a.order : 999999
        const orderB = b.order !== undefined && b.order > 0 ? b.order : 999999
        return orderA - orderB
      })

      // 彻底消除任何根级重复（按 code 与 name 去重，且严格剔除 tags 为空的非泛维度根级）
      const finalGroups: DimensionGroup[] = []
      const dedupeCodes = new Set<string>()
      const dedupeNames = new Set<string>()
      for (const g of groups) {
        if (g.code && dedupeCodes.has(g.code)) continue
        if (g.name && dedupeNames.has(g.name)) continue
        const isPan =
          (typeof g.metadata === 'object' && g.metadata !== null
            ? (g.metadata as any).flag?.isPanDimension
            : false) === true || (g.metadata as any)?.isPanDimension === true
        if ((!g.tags || g.tags.length === 0) && !(includeAllPresetTags && isPan)) continue
        if (g.code) dedupeCodes.add(g.code)
        if (g.name) dedupeNames.add(g.name)
        finalGroups.push(g)
      }

      // 注入与合并"内容标签"（builtin.content_tags）虚拟维度组及本地受控扩展标签：
      // 收纳未被受控/本地已知维度根节点覆盖的所有动态标签，并建立内部多级树形层级结构与穿透提升支持。
      const contentTagsDimId = 28 // 系统规范约定的 ID（ADR-0037）
      const contentTagDisplayName = aliasResolver(CONTENT_TAGS_CODE, '内容标签')
      const contentDimTags: DimensionTag[] = []

      // 建立已入组的 code -> DimensionGroup 映射，确保孤儿识别时优先回归所属原有维度
      const tagToGroupMap = new Map<string, DimensionGroup>()
      const tagLevelMap = new Map<string, number>()
      for (const g of finalGroups) {
        if (g.code) tagToGroupMap.set(g.code, g)
        for (const t of g.tags || []) {
          if (t.code) {
            tagToGroupMap.set(t.code, g)
            tagLevelMap.set(t.code, t.level)
          }
        }
      }

      const ensureRootDimensionGroup = (rootCode: string): DimensionGroup | undefined => {
        if (!ROOT_DIMENSION_CODES.has(rootCode)) return undefined
        let group = finalGroups.find(g => g.code === rootCode)
        if (!group) {
          const meta = ROOT_DIMENSION_META[rootCode]
          const displayName = aliasResolver(rootCode, meta?.name || rootCode)
          const authority =
            authorityDimByCode.get(rootCode) ||
            (meta?.id !== undefined ? authorityDimById.get(meta.id) : undefined)
          const flag = authority?.flag
          const newGroup: DimensionGroup = {
            id: meta?.id || 10000 + finalGroups.length,
            name: displayName,
            level: 0,
            tags: [],
            code: rootCode,
            order: meta?.id || 9999,
            isMultiSelect:
              flag?.isMultiSelect ??
              (rootCode === concept('文件用途') ||
                rootCode === concept('内容标签') ||
                rootCode === concept('地理位置')),
            meta: {
              source: 'builtin',
              order: meta?.id || 9999,
              sort_order: meta?.id || 9999,
              ...(flag ? { flag } : {})
            },
            metadata: {
              source: 'builtin',
              order: meta?.id || 9999,
              sort_order: meta?.id || 9999,
              ...(flag ? { flag } : {})
            }
          }
          finalGroups.push(newGroup)
          tagToGroupMap.set(rootCode, newGroup)
          dedupeCodes.add(rootCode)
          group = newGroup
        }
        return group
      }

      // 祖先追溯辅助：向上递归寻找第一个属于受控/本地已知维度的祖先与对应组
      const traceAncestorGroup = (
        parents: string[],
        visited = new Set<string>()
      ): { targetGroup: DimensionGroup; parentCode: string; level: number } | undefined => {
        for (const p of parents) {
          if (!p || visited.has(p)) continue
          visited.add(p)

          // 直接命中已有维度组或组内标签
          if (tagToGroupMap.has(p)) {
            const group = tagToGroupMap.get(p)!
            const isRootGroup = group.code === p
            const pLvl = isRootGroup ? 0 : (tagLevelMap.get(p) ?? 1)
            return { targetGroup: group, parentCode: p, level: pLvl + 1 }
          }

          // 命中受控根维度，按需动态唤醒根维度组
          if (ROOT_DIMENSION_CODES.has(p)) {
            const group = ensureRootDimensionGroup(p)
            if (group) {
              return { targetGroup: group, parentCode: p, level: 1 }
            }
          }

          // 命中泛维度（如地理位置），优先认领为独立卡片维度组，绝不向上回溯至文件类型
          const authDim = authorityDimByCode.get(p)
          const dimFlag =
            authDim?.flag || (authDim?.dim?.metadata?.flag as DimensionFlags | undefined)
          if (dimFlag?.isPanDimension === true) {
            let group = finalGroups.find(g => g.code === p)
            if (!group) {
              const displayName = aliasResolver(p, authDim?.name || p)
              const newGroup: DimensionGroup = {
                id: authDim?.id || 10000 + finalGroups.length,
                name: displayName,
                level: 0,
                tags: [],
                code: p,
                order: authDim?.id || 9999,
                sort_order: authDim?.id || 9999,
                isMultiSelect: dimFlag.isMultiSelect ?? true,
                meta: {
                  source: 'builtin',
                  order: authDim?.id || 9999,
                  sort_order: authDim?.id || 9999,
                  ...(dimFlag ? { flag: dimFlag } : {})
                },
                metadata: {
                  source: 'builtin',
                  order: authDim?.id || 9999,
                  sort_order: authDim?.id || 9999,
                  ...(dimFlag ? { flag: dimFlag } : {})
                }
              }
              finalGroups.push(newGroup)
              tagToGroupMap.set(p, newGroup)
              dedupeCodes.add(p)
              group = newGroup
            }
            return { targetGroup: group, parentCode: p, level: 1 }
          }

          // 命中已知受控细分映射
          const mappedRoot = resolveSubdimensionRoot(p)
          if (mappedRoot) {
            const group =
              finalGroups.find(g => g.code === mappedRoot) || ensureRootDimensionGroup(mappedRoot)
            if (group) {
              return { targetGroup: group, parentCode: p, level: 2 }
            }
          }

          // 命中 Omni 全量节点到根的映射
          if (omniCodeToRootCodeMap.has(p)) {
            const rootCode = omniCodeToRootCodeMap.get(p)!
            const group =
              finalGroups.find(g => g.code === rootCode) || ensureRootDimensionGroup(rootCode)
            if (group) {
              return { targetGroup: group, parentCode: p, level: 2 }
            }
          }

          // 递归在 tagRows 中查找 p 的父级链
          const pRow = tagRows.find(r => r.code === p)
          if (pRow) {
            let pParents: string[] = []
            try {
              pParents = JSON.parse(pRow.parent_codes || '[]')
            } catch {}
            const traced = traceAncestorGroup(pParents, visited)
            if (traced) {
              return { targetGroup: traced.targetGroup, parentCode: p, level: traced.level + 1 }
            }
          }
        }
        return undefined
      }

      // 收集受控维度内可被动态标签特化认领的代表性标签（如截图、照片、水印、摄影等）
      const controlledStemMap: Array<{
        stem: string
        targetGroup: DimensionGroup
        parentTag: DimensionTag
      }> = []
      for (const g of finalGroups) {
        if (g.code === CONTENT_TAGS_CODE) continue
        for (const t of g.tags || []) {
          if (t.tagValue && t.tagValue.length >= 2) {
            controlledStemMap.push({ stem: t.tagValue, targetGroup: g, parentTag: t })
          }
        }
      }
      // 按词长降序排列，优先长词匹配
      controlledStemMap.sort((a, b) => b.stem.length - a.stem.length)

      // ─── 阶段 1：受控维度优先认领（杜绝受控扩展深层标签误掉入内容标签）───
      for (const t of tagRows) {
        if (assignedCodes.has(t.code)) continue
        const resolvedName = aliasResolver(t.code, t.name)
        const selfFiles = tagFilesMap.get(t.code) || new Set<string>()
        const count = selfFiles.size > 0 ? selfFiles.size : tagCountMap.get(t.code) || 0
        if (removeEmptyTags && !includeAllPresetTags && count === 0) continue

        let parents: string[] = []
        try {
          parents = JSON.parse(t.parent_codes || '[]')
        } catch {
          parents = []
        }

        // 1. 同名直接认领合并
        let matchedSameName: { group: DimensionGroup; tag: DimensionTag } | null = null
        for (const g of finalGroups) {
          if (g.code === CONTENT_TAGS_CODE) continue
          const foundTag = g.tags.find(tg => tg.code === t.code || tg.tagValue === resolvedName)
          if (foundTag) {
            matchedSameName = { group: g, tag: foundTag }
            break
          }
        }
        if (matchedSameName) {
          const { group, tag } = matchedSameName
          assignedCodes.add(t.code)
          tagToGroupMap.set(t.code, group)
          if (tag.codePath && pathCountMap[tag.codePath] !== undefined) {
            tag.fileCount = pathCountMap[tag.codePath]
          } else if (hasPathIndex) {
            tag.fileCount = 0
          } else {
            tag.fileCount = Math.max(tag.fileCount, count)
          }
          continue
        }

        // 2. 祖先追溯认领
        let candidateParents = parents.filter(p => p && p !== CONTENT_TAGS_CODE)
        if (candidateParents.length === 0) {
          const directParentDim = getParentDimensionCodeOfTag(t.code)
          if (directParentDim && directParentDim !== CONTENT_TAGS_CODE) {
            candidateParents = [directParentDim]
          }
        }
        const traced = traceAncestorGroup(candidateParents)
        if (traced) {
          const { targetGroup, parentCode: effectiveParent, level: effectiveLevel } = traced

          // 路径判定：在 tagChainsMap 中查找真正以 targetGroup 与 effectiveParent 为前缀的匹配路径
          // 严禁盲借 [0]，杜绝将音频等异类物理路径借给其他维度分支
          const chains = tagChainsMap.get(t.code) || []
          const targetGroupPrefix = `/${targetGroup.code}/`
          const matchedChain = chains.find(c => {
            if (!c.code_path.startsWith(targetGroupPrefix)) return false
            if (
              effectiveParent !== targetGroup.code &&
              !c.code_path.includes(`/${effectiveParent}/`)
            )
              return false
            return true
          })

          const geoCode = concept('地理位置')
          const geoName = targetGroup.name
          let tCodePath = ''
          let tNamePath = ''

          if (matchedChain) {
            tCodePath =
              targetGroup.code === geoCode && matchedChain.code_path.includes(`/${geoCode}/`)
                ? matchedChain.code_path.substring(matchedChain.code_path.indexOf(`/${geoCode}/`))
                : matchedChain.code_path
            tNamePath =
              targetGroup.code === geoCode && matchedChain.name_path.includes(`/${geoName}/`)
                ? matchedChain.name_path.substring(matchedChain.name_path.indexOf(`/${geoName}/`))
                : matchedChain.name_path
          } else {
            tCodePath = `/${targetGroup.code}/${effectiveParent === targetGroup.code ? t.code : `${effectiveParent}/${t.code}`}`
            tNamePath = `/${targetGroup.name}/${effectiveParent === targetGroup.code ? resolvedName : `${aliasResolver(effectiveParent, effectiveParent)}/${resolvedName}`}`
          }

          const normTPath = normalizeCodePath(tCodePath)
          let branchCount = count
          if (normTPath && pathCountMap[normTPath] !== undefined) {
            branchCount = pathCountMap[normTPath]
          } else if (hasPathIndex) {
            branchCount =
              tagParentCountMap.get(`${t.code}::${effectiveParent}`) || tagCountMap.get(t.code) || 0
          }

          if (removeEmptyTags && !includeAllPresetTags && branchCount === 0) {
            continue
          }

          assignedCodes.add(t.code)
          tagToGroupMap.set(t.code, targetGroup)
          tagLevelMap.set(t.code, effectiveLevel)

          targetGroup.tags.push({
            dimensionId: targetGroup.id,
            dimensionCode: targetGroup.code || '',
            dimensionName: targetGroup.name,
            tagValue: resolvedName,
            fileCount: branchCount,
            level: effectiveLevel,
            code: t.code,
            codePath: tCodePath,
            namePath: tNamePath,
            viaParentCode: effectiveParent,
            isMultiSelect: deriveTagMultiSelect(targetGroup.code),
            order: 9999
          })
          continue
        }

        // 3. 受控词根认领：若标签以受控标签名结尾（如 macOS截图 以 截图 结尾），认领至该受控标签下
        let claimedByStem: { targetGroup: DimensionGroup; parentTag: DimensionTag } | null = null
        for (const item of controlledStemMap) {
          if (resolvedName.length > item.stem.length && resolvedName.endsWith(item.stem)) {
            claimedByStem = item
            break
          }
        }
        if (claimedByStem) {
          const { targetGroup, parentTag } = claimedByStem
          const nextLvl = (parentTag.level || 1) + 1

          const parentCodePath =
            parentTag.codePath || `/${targetGroup.code}/${parentTag.code || parentTag.tagValue}`
          const parentNamePath = parentTag.namePath || `/${targetGroup.name}/${parentTag.tagValue}`
          const branchPrefix = `${parentCodePath}/${t.code}`
          const matchedChain = tagChainsMap
            .get(t.code)
            ?.find(c => c.code_path.startsWith(parentCodePath))
          const tCodePath = matchedChain?.code_path || branchPrefix
          const tNamePath = matchedChain?.name_path || `${parentNamePath}/${resolvedName}`

          const normTPath = normalizeCodePath(tCodePath)
          let stemCount = count
          if (normTPath && pathCountMap[normTPath] !== undefined) {
            stemCount = pathCountMap[normTPath]
          } else if (hasPathIndex) {
            stemCount = 0
          }

          if (removeEmptyTags && !includeAllPresetTags && stemCount === 0) {
            continue
          }

          assignedCodes.add(t.code)
          tagToGroupMap.set(t.code, targetGroup)
          tagLevelMap.set(t.code, nextLvl)

          targetGroup.tags.push({
            dimensionId: targetGroup.id,
            dimensionCode: targetGroup.code || '',
            dimensionName: targetGroup.name,
            tagValue: resolvedName,
            fileCount: stemCount,
            level: nextLvl,
            code: t.code,
            codePath: tCodePath,
            namePath: tNamePath,
            viaParentCode: parentTag.code || parentTag.tagValue,
            isMultiSelect: deriveTagMultiSelect(targetGroup.code),
            order: 9999
          })
          continue
        }
      }

      // ─── 阶段 2：内容标签多级层级链推导与祖先树化（对齐内建标签级联逻辑）───
      interface ContentCandidate {
        code: string
        name: string
        files: Set<string>
        parents: string[]
        pathChains: Array<{ code_path: string; name_path: string }>
      }

      // 收集所有已知预置维度代码，严禁已知非内容标签维度的标签被误作为内容标签候选
      const knownPresetCodesSet = new Set<string>()
      if (allAuthorityDims) {
        for (const ad of allAuthorityDims) {
          if (ad.code === CONTENT_TAGS_CODE) continue
          if (ad.code) knownPresetCodesSet.add(ad.code)
        }
      }

      const contentCandidates: ContentCandidate[] = []
      for (const t of tagRows) {
        if (assignedCodes.has(t.code)) continue

        // 核心门禁 1：反查受控标签所属父维度，凡属于已知非内容标签受控维度的标签，严禁作为内容标签候选
        const directParentDim = getParentDimensionCodeOfTag(t.code)
        if (directParentDim && directParentDim !== CONTENT_TAGS_CODE) {
          continue
        }

        // 核心门禁 2：若 tag code 本身是已知受控维度或根维度（非内容标签），严禁作为内容标签候选
        if (
          (ROOT_DIMENSION_CODES.has(t.code) && t.code !== CONTENT_TAGS_CODE) ||
          knownPresetCodesSet.has(t.code) ||
          (Boolean(resolveSubdimensionRoot(t.code)) &&
            resolveSubdimensionRoot(t.code) !== CONTENT_TAGS_CODE)
        ) {
          continue
        }

        let parents: string[] = []
        try {
          parents = JSON.parse(t.parent_codes || '[]')
        } catch {}

        // 核心门禁 3：如果 parents 明确指向非内容标签的已知维度，严禁作为内容标签候选
        const hasKnownNonContentParent = parents.some(
          p =>
            p &&
            p !== CONTENT_TAGS_CODE &&
            (knownPresetCodesSet.has(p) ||
              ROOT_DIMENSION_CODES.has(p) ||
              Boolean(resolveSubdimensionRoot(p)))
        )
        if (hasKnownNonContentParent) {
          continue
        }

        const selfFiles = tagFilesMap.get(t.code) || new Set<string>()
        const count = selfFiles.size > 0 ? selfFiles.size : tagCountMap.get(t.code) || 0
        if (removeEmptyTags && !includeAllPresetTags && count === 0) continue

        const mPaths = [...(tagChainsMap.get(t.code) || [])]

        contentCandidates.push({
          code: t.code,
          name: aliasResolver(t.code, t.name),
          files: new Set(selfFiles),
          parents,
          pathChains: mPaths
        })
      }

      // 内部树节点网络
      interface ContentTreeNode {
        code: string
        name: string
        parentKey: string // 父节点标识 (code 或 name)，顶层为 CONTENT_TAGS_CODE
        level: number
        files: Set<string>
        childrenKeys: Set<string>
      }

      const contentNodeMap = new Map<string, ContentTreeNode>()
      const ensureContentNode = (
        code: string,
        name: string,
        parentKey: string,
        level: number
      ): ContentTreeNode => {
        const key = code || name
        if (contentNodeMap.has(key)) {
          const existing = contentNodeMap.get(key)!
          if (
            parentKey &&
            parentKey !== CONTENT_TAGS_CODE &&
            existing.parentKey === CONTENT_TAGS_CODE
          ) {
            existing.parentKey = parentKey
            existing.level = level
          }
          return existing
        }
        const node: ContentTreeNode = {
          code: code || `builtin.cat.${name}`,
          name,
          parentKey: parentKey || CONTENT_TAGS_CODE,
          level,
          files: new Set(),
          childrenKeys: new Set()
        }
        contentNodeMap.set(key, node)
        return node
      }

      // 挂载候选标签至树结构
      for (const cand of contentCandidates) {
        let assigned = false

        // 1. 优先：物化路径解析（支持 /建筑空间/文化场馆/博物馆 等明确层级链）
        if (cand.pathChains.length > 0) {
          for (const mp of cand.pathChains) {
            const rawPath = mp.name_path || mp.code_path
            if (rawPath) {
              const segments = rawPath
                .split('/')
                .map(s => s.trim())
                .filter(s => s && s !== CANONICAL_NAMES.CONTENT_TAGS && s !== CONTENT_TAGS_CODE)
              if (segments.length >= 2) {
                // 防击穿护栏：若路径首段命中受控根维度或受控子维度，严禁挂入内容标签！
                const firstSeg = segments[0]
                let matchedRootCode = Array.from(ROOT_DIMENSION_CODES).find(
                  rc =>
                    rc === firstSeg ||
                    aliasResolver(rc, rc) === firstSeg ||
                    ROOT_DIMENSION_META[rc]?.name === firstSeg
                )
                if (!matchedRootCode) {
                  // 若首段为受控子维度（如摄影照片细分、图片细分、文字密度等），溯源其一级受控根维度
                  const mappedRoot =
                    resolveSubdimensionRoot(firstSeg) || omniCodeToRootCodeMap.get(firstSeg)
                  if (mappedRoot && ROOT_DIMENSION_CODES.has(mappedRoot)) {
                    matchedRootCode = mappedRoot
                  }
                }
                if (matchedRootCode && matchedRootCode !== CONTENT_TAGS_CODE) {
                  const rootGroup = ensureRootDimensionGroup(matchedRootCode)
                  if (rootGroup) {
                    let prevParent = matchedRootCode
                    for (let i = 1; i < segments.length; i++) {
                      const seg = segments[i]
                      const isLast = i === segments.length - 1
                      const segCode = isLast ? cand.code : `builtin.cat.${seg}`
                      const segName = aliasResolver(segCode, seg)
                      let existingTag = rootGroup.tags.find(
                        t => t.code === segCode || t.tagValue === segName
                      )
                      if (!existingTag) {
                        existingTag = {
                          dimensionId: rootGroup.id,
                          dimensionCode: rootGroup.code || '',
                          dimensionName: rootGroup.name,
                          tagValue: segName,
                          fileCount: 0,
                          level: i,
                          code: segCode,
                          codePath: `/${rootGroup.code}/${segCode}`,
                          namePath: `/${rootGroup.name}/${segName}`,
                          viaParentCode: prevParent,
                          isMultiSelect: deriveTagMultiSelect(rootGroup.code),
                          order: 9999
                        }
                        rootGroup.tags.push(existingTag)
                      }
                      if (isLast) {
                        existingTag.fileCount = Math.max(existingTag.fileCount, cand.files.size)
                      }
                      prevParent = segCode
                    }
                    assigned = true
                    break
                  }
                }

                let prevParentKey = CONTENT_TAGS_CODE
                for (let i = 0; i < segments.length; i++) {
                  const segName = segments[i]
                  const isLast = i === segments.length - 1
                  const segCode = isLast ? cand.code : `builtin.cat.${segName}`
                  const node = ensureContentNode(segCode, segName, prevParentKey, i + 1)
                  if (isLast) {
                    for (const f of cand.files) node.files.add(f)
                  }
                  prevParentKey = node.code || node.name
                }
                assigned = true
                break
              }
            }
          }
        }

        // 2. 次优：存在父节点声明时，挂载在对应父维度下
        if (!assigned && cand.parents.length > 0) {
          const pCode = cand.parents[0]
          if (pCode && pCode !== cand.code) {
            const rootDimCode =
              resolveSubdimensionRoot(pCode) ||
              (ROOT_DIMENSION_CODES.has(pCode) ? pCode : undefined)

            if (rootDimCode && rootDimCode !== CONTENT_TAGS_CODE) {
              const rootGroup = ensureRootDimensionGroup(rootDimCode)
              if (rootGroup) {
                let existingTag = rootGroup.tags.find(
                  t => t.code === cand.code || t.tagValue === cand.name
                )
                const isDirectRootChild = pCode === rootDimCode
                if (!existingTag) {
                  rootGroup.tags.push({
                    dimensionId: rootGroup.id,
                    dimensionCode: rootGroup.code || '',
                    dimensionName: rootGroup.name,
                    tagValue: cand.name,
                    fileCount: cand.files.size,
                    level: isDirectRootChild ? 1 : 2,
                    code: cand.code,
                    codePath: isDirectRootChild
                      ? `/${rootGroup.code}/${cand.code}`
                      : `/${rootGroup.code}/${pCode}/${cand.code}`,
                    namePath: isDirectRootChild
                      ? `/${rootGroup.name}/${cand.name}`
                      : `/${rootGroup.name}/${aliasResolver(pCode, pCode)}/${cand.name}`,
                    viaParentCode: pCode,
                    isMultiSelect: deriveTagMultiSelect(rootGroup.code),
                    order: 9999
                  })
                } else {
                  existingTag.fileCount = Math.max(existingTag.fileCount, cand.files.size)
                }
                assigned = true
              }
            } else {
              const pNode = ensureContentNode(
                pCode,
                aliasResolver(pCode, pCode),
                CONTENT_TAGS_CODE,
                1
              )
              const leafNode = ensureContentNode(cand.code, cand.name, pNode.code, 2)
              for (const f of cand.files) leafNode.files.add(f)
              assigned = true
            }
          }
        }

        // 3. 兜底：未匹配到特定分类的独立标签，挂载在内容标签顶层
        if (!assigned) {
          const rootNode = ensureContentNode(cand.code, cand.name, CONTENT_TAGS_CODE, 1)
          for (const f of cand.files) rootNode.files.add(f)
        }
      }

      // 4. 复合词包含拓扑优化（短词自动作为长词的父级，如"海报" ➔ "海报设计" ➔ "海报设计大师"）
      const allNodesList = Array.from(contentNodeMap.values()).sort(
        (a, b) => a.name.length - b.name.length
      )
      for (let i = 0; i < allNodesList.length; i++) {
        const shortNode = allNodesList[i]
        if (shortNode.name.length < 2) continue
        for (let j = i + 1; j < allNodesList.length; j++) {
          const longNode = allNodesList[j]
          // 若长词以短词为词根且同属同级或待归属状态，建立直属父子链
          if (
            longNode.name.length > shortNode.name.length &&
            (longNode.name.startsWith(shortNode.name) || longNode.name.endsWith(shortNode.name)) &&
            longNode.parentKey === shortNode.parentKey
          ) {
            longNode.parentKey = shortNode.code || shortNode.name
            longNode.level = shortNode.level + 1
          }
        }
      }

      // 5. 建立双向父子关系
      for (const [key, node] of contentNodeMap.entries()) {
        if (node.parentKey && node.parentKey !== CONTENT_TAGS_CODE) {
          const parent = contentNodeMap.get(node.parentKey)
          if (parent && parent !== node) {
            parent.childrenKeys.add(key)
          }
        }
      }

      // 6. 后序遍历自底向上汇聚文件集合（保证祖先节点包含所有子孙命中，绝不因直接文件数为 0 被误剪）
      const aggregateContentSubtreeFiles = (
        key: string,
        visited = new Set<string>()
      ): Set<string> => {
        const files = new Set<string>()
        if (visited.has(key)) return files
        visited.add(key)

        const node = contentNodeMap.get(key)
        if (!node) return files

        for (const f of node.files) files.add(f)
        for (const childKey of node.childrenKeys) {
          const childFiles = aggregateContentSubtreeFiles(childKey, visited)
          for (const f of childFiles) files.add(f)
        }

        for (const f of files) node.files.add(f)
        return files
      }

      for (const [key, node] of contentNodeMap.entries()) {
        if (node.parentKey === CONTENT_TAGS_CODE) {
          aggregateContentSubtreeFiles(key)
        }
      }

      // 7. 输出 DimensionTag 数组
      // S0-c（规格 §5.1）：内容标签维度属多选维度，单选策略不得硬编码。
      // 标签级 / 组级 / meta / metadata 四处统一由分类器派生（DEC-02 三处 metadata 同源）。
      // 未知/规则自有维度保守取单选（false），与 §5.2 的 unknown 保守分支对齐。
      const contentTagsIsMultiSelect = classifyDimensionMutexScope(CONTENT_TAGS_CODE) === 'multi'
      for (const [key, node] of contentNodeMap.entries()) {
        const count = node.files.size
        if (removeEmptyTags && !includeAllPresetTags && count === 0) continue

        const branchPrefix = `/builtin.content_tags/${node.code}`
        const matchedChain = tagChainsMap
          .get(node.code)
          ?.find(c => c.code_path.startsWith('/builtin.content_tags/'))
        const cCodePath = matchedChain?.code_path || branchPrefix
        const cNamePath = matchedChain?.name_path || `/${contentTagDisplayName}/${node.name}`
        contentDimTags.push({
          dimensionId: contentTagsDimId,
          dimensionCode: CONTENT_TAGS_CODE,
          dimensionName: contentTagDisplayName,
          tagValue: node.name,
          fileCount: count,
          level: node.level,
          code: node.code,
          codePath: cCodePath,
          namePath: cNamePath,
          viaParentCode: node.parentKey,
          isMultiSelect: contentTagsIsMultiSelect,
          order: 9999
        })
      }

      const existingContentGroup = finalGroups.find(g => g.code === CONTENT_TAGS_CODE)
      if (existingContentGroup) {
        if (!existingContentGroup.tags) existingContentGroup.tags = []
        const existingTagCodes = new Set(existingContentGroup.tags.map(t => t.code || t.tagValue))
        for (const cTag of contentDimTags) {
          const codeKey = cTag.code || cTag.tagValue
          if (codeKey && !existingTagCodes.has(codeKey)) {
            existingContentGroup.tags.push(cTag)
            if (cTag.code) existingTagCodes.add(cTag.code)
            if (cTag.tagValue) existingTagCodes.add(cTag.tagValue)
          }
        }
        logger.debug(
          LogCategory.VIRTUAL_DIRECTORY,
          `[TagTreeQuery] 向既有内容标签维度组追加合并 ${contentDimTags.length} 个多级节点`
        )
      } else if (contentDimTags.length > 0 || (includeAllPresetTags && true)) {
        finalGroups.push({
          id: contentTagsDimId,
          name: contentTagDisplayName,
          level: 0,
          tags: contentDimTags,
          code: CONTENT_TAGS_CODE,
          // 恒定垫底：与 omni fast path / 回退路径的 9999 特例口径统一（缺省时前端 id 回退会得到 28 误排前排）
          order: CONTENT_TAGS_TAIL_ORDER,
          isMultiSelect: contentTagsIsMultiSelect,
          meta: {
            source: 'builtin',
            order: CONTENT_TAGS_TAIL_ORDER,
            isMultiSelect: contentTagsIsMultiSelect
          },
          metadata: {
            isPanDimension: true,
            source: 'builtin',
            order: CONTENT_TAGS_TAIL_ORDER,
            isMultiSelect: contentTagsIsMultiSelect
          }
        })
        dedupeCodes.add(CONTENT_TAGS_CODE)
        logger.debug(
          LogCategory.VIRTUAL_DIRECTORY,
          `[TagTreeQuery] 注入多级树化内容标签维度组，共 ${contentDimTags.length} 个多级节点`
        )
      }

      // 8. 当 includeAllPresetTags 为 true 时（批量标签、维度管理等视图），
      // 从本地权威配置管理器（ConfigDbManager）回填全部受控预置维度与标签（未命中文件时记为 0）
      if (includeAllPresetTags && allAuthorityDims && allAuthorityDims.length > 0) {
        const groupById = new Map<number, DimensionGroup>()
        const groupByCode = new Map<string, DimensionGroup>()

        for (const g of finalGroups) {
          if (typeof g.id === 'number') groupById.set(g.id, g)
          if (g.code) groupByCode.set(g.code, g)
        }

        for (const authDim of allAuthorityDims) {
          const dimCode = authDim.code
          const dimId = authDim.id
          const dimName = authDim.name
          const dimFlag = authDim.metadata?.flag || authDim.flag

          // 排除扩展名维度
          if (
            excludeExtensionDimension &&
            (dimFlag?.isExtensionDimension ||
              /扩展名|Extension/i.test(dimCode || '') ||
              /扩展名|Extension/i.test(dimName || ''))
          ) {
            continue
          }

          // 寻找对应已存在的维度组（严格按 code 或 id 精准匹配，杜绝按 name 模糊匹配避免同名子维度与根维度串扰）
          type ExtendedDimensionGroup = DimensionGroup & {
            parentCodes?: string[]
            rootCode?: string
          }

          let targetGroup: ExtendedDimensionGroup | undefined =
            (dimCode
              ? (groupByCode.get(dimCode) as ExtendedDimensionGroup | undefined)
              : undefined) ||
            (dimId !== undefined
              ? (groupById.get(dimId) as ExtendedDimensionGroup | undefined)
              : undefined)

          if (!targetGroup) {
            // 如果该维度尚未在 finalGroups 中，则创建该维度组
            const resolvedName = aliasResolver(dimCode, dimName || dimCode)
            const canonicalId =
              dimId ?? (dimCode && ROOT_DIMENSION_META[dimCode]?.id) ?? 10000 + finalGroups.length
            const rootDimCode = dimCode ? resolveSubdimensionRoot(dimCode) : undefined
            const newGroup: ExtendedDimensionGroup = {
              id: canonicalId,
              name: resolvedName,
              level:
                authDim.depth || authDim.level || (rootDimCode && rootDimCode !== dimCode ? 2 : 1),
              tags: [],
              code: dimCode,
              order: canonicalId || 9999,
              sort_order: canonicalId || 9999,
              isMultiSelect: dimFlag?.isMultiSelect ?? false,
              parentCodes: authDim.parentCodes || [],
              rootCode: rootDimCode || dimCode,
              triggerConditions: authDim.triggerConditions || [],
              meta: {
                source: 'builtin',
                order: canonicalId || 9999,
                sort_order: canonicalId || 9999,
                parentCodes: authDim.parentCodes || [],
                rootCode: rootDimCode || dimCode,
                triggerConditions: authDim.triggerConditions || [],
                ...(dimFlag ? { flag: dimFlag } : {})
              },
              metadata: {
                source: 'builtin',
                order: canonicalId || 9999,
                sort_order: canonicalId || 9999,
                parentCodes: authDim.parentCodes || [],
                rootCode: rootDimCode || dimCode,
                triggerConditions: authDim.triggerConditions || [],
                ...(dimFlag ? { flag: dimFlag } : {})
              }
            }
            targetGroup = newGroup
            finalGroups.push(newGroup)
            if (newGroup.code) groupByCode.set(newGroup.code, newGroup)
            if (typeof newGroup.id === 'number') groupById.set(newGroup.id, newGroup)
          } else {
            // 确保既有维度组上的 metadata.flag 包含权威配置中的 flag（如 isPanDimension）以及父级关联
            const rootDimCode = dimCode ? resolveSubdimensionRoot(dimCode) : undefined
            if (
              authDim.parentCodes &&
              (!targetGroup.parentCodes || targetGroup.parentCodes.length === 0)
            ) {
              targetGroup.parentCodes = authDim.parentCodes
            }
            if (authDim.triggerConditions && !(targetGroup as any).triggerConditions) {
              ;(targetGroup as any).triggerConditions = authDim.triggerConditions
            }
            if (rootDimCode && !targetGroup.rootCode) {
              targetGroup.rootCode = rootDimCode
            }
            if (dimFlag) {
              // 权威策略覆盖既有维度组：多选策略同样以 flag 为准（修复根 meta 硬编码 true 的历史短路）
              if (dimFlag.isMultiSelect !== undefined) {
                targetGroup.isMultiSelect = dimFlag.isMultiSelect === true
              }
              const prevMeta =
                typeof targetGroup.metadata === 'object' && targetGroup.metadata !== null
                  ? targetGroup.metadata
                  : {}
              const prevMetaFlag =
                typeof targetGroup.metadata === 'object' && targetGroup.metadata !== null
                  ? (targetGroup.metadata as any).flag
                  : undefined
              targetGroup.metadata = {
                ...prevMeta,
                ...(dimFlag.isMultiSelect !== undefined
                  ? { isMultiSelect: dimFlag.isMultiSelect === true }
                  : {}),
                flag: {
                  ...prevMetaFlag,
                  ...dimFlag
                }
              }
              const prevMetaObj =
                typeof targetGroup.meta === 'object' && targetGroup.meta !== null
                  ? targetGroup.meta
                  : {}
              const prevMetaObjFlag =
                typeof targetGroup.meta === 'object' && targetGroup.meta !== null
                  ? (targetGroup.meta as any).flag
                  : undefined
              targetGroup.meta = {
                ...prevMetaObj,
                ...(dimFlag.isMultiSelect !== undefined
                  ? { isMultiSelect: dimFlag.isMultiSelect === true }
                  : {}),
                flag: {
                  ...prevMetaObjFlag,
                  ...dimFlag
                }
              }
            }
          }

          if (!targetGroup) continue

          // 如果该预置维度含有预置标签词表（dim.tags），补全未命中的预设标签（fileCount: 0）
          if (Array.isArray(authDim.tags) && authDim.tags.length > 0) {
            // 1. 补全子维度自身独立卡片维度组中的预置标签
            if (!targetGroup.tags) targetGroup.tags = []
            const existingValues = new Set<string>()
            for (const t of targetGroup.tags) {
              if (t.tagValue) existingValues.add(t.tagValue.toLowerCase())
              if ((t as any).name) existingValues.add(String((t as any).name).toLowerCase())
            }

            for (let tagIdx = 0; tagIdx < authDim.tags.length; tagIdx++) {
              const presetTagName = authDim.tags[tagIdx]
              if (!presetTagName || typeof presetTagName !== 'string') continue
              const trimmed = presetTagName.trim()
              if (!trimmed || existingValues.has(trimmed.toLowerCase())) continue
              if (trimmed === targetGroup.name.trim()) continue

              // 权威受控码优先：若预置标签收录于受控词典，直接使用权威受控码；若未收录，走标准扩展派生码，严禁私造伪代码
              let tagCode: string | undefined
              if (isControlledConcept(trimmed)) {
                tagCode = concept(trimmed)
              } else {
                for (const [c, canon] of Object.entries(CONTROLLED_CODE_TO_CANONICAL_NAME)) {
                  if (canon.toLowerCase() === trimmed.toLowerCase()) {
                    tagCode = c
                    break
                  }
                }
                if (!tagCode) {
                  for (const [c, disp] of Object.entries(aliasMap)) {
                    if (disp.toLowerCase() === trimmed.toLowerCase()) {
                      tagCode = c
                      break
                    }
                  }
                }
                if (!tagCode) {
                  tagCode = DeterministicCodeGenerator.generate(trimmed, locale || 'zh-CN')
                }
              }
              const resolvedTagName = aliasResolver(tagCode, trimmed)
              targetGroup.tags.push({
                dimensionId: targetGroup.id,
                dimensionCode: targetGroup.code || '',
                dimensionName: targetGroup.name,
                tagValue: resolvedTagName,
                fileCount: 0,
                level: 1,
                code: tagCode,
                codePath: `/${targetGroup.code || `dim.${targetGroup.id}`}/${tagCode}`,
                namePath: `/${targetGroup.name}/${resolvedTagName}`,
                viaParentCode: targetGroup.code || '',
                isMultiSelect: targetGroup.isMultiSelect ?? false,
                order: tagIdx + 1,
                meta: { order: tagIdx + 1, sort_order: tagIdx + 1 }
              })
              existingValues.add(trimmed.toLowerCase())
            }

            // 2. 注意：受控子维度的预置标签仅保留在子维度自身，严禁平铺 push 到所属一级受控根维度中（避免文件用途等卡片混入处理状态、安全等级等子标签）
          }
        }
      }

      // 同步将所有维度组（含受控树、动态扩展标签与内容标签组）内的多级父子关系注入邻接图，
      // 确保点击任意父标签时右侧 FileList 均能递归穿透展开
      if (this._omniChildrenMap) {
        const codeToName = new Map<string, string>()
        for (const g of finalGroups) {
          for (const t of g.tags || []) {
            if (t.code && t.tagValue) codeToName.set(t.code, t.tagValue)
          }
        }
        for (const g of finalGroups) {
          for (const t of g.tags || []) {
            if (t.viaParentCode && t.code && t.viaParentCode !== t.code) {
              const pCode = t.viaParentCode
              const pName = codeToName.get(pCode)
              const parentKeys = [pCode, pName].filter(Boolean) as string[]
              for (const pk of parentKeys) {
                if (!this._omniChildrenMap.has(pk)) {
                  this._omniChildrenMap.set(pk, new Set())
                }
                this._omniChildrenMap.get(pk)!.add(t.code)
                if (t.tagValue) this._omniChildrenMap.get(pk)!.add(t.tagValue)
              }
            }
          }
        }
      }

      // 铁闸门禁：严格执行「维度名不能作为标签，维度名只用于区块名，只有其下的标签才能作为用户的可选择标签」铁律
      // 1. 维度名本身绝对不能作为其自身区块下的标签（如作者卡片不能有作者标签、安全等级卡片不能有安全等级标签）
      // 2. 顶层元分类根名（如文件类型、文件用途）与受控子维度名不能混入「内容标签」动态池（动态标签与维度名撞名属污染）
      //
      // 【跨域撞名豁免（2026-10-18 修复 depth=6 只显示 2 层回归）】
      // 受控分类树（file_type 等 Omni 组）的中间层节点名与其它域的受控维度名合法撞名
      // （如 file_type 树的「语言细分」「图片细分」「水印程度」「背景」「画幅」既是树上节点又是受控子维度名，
      //  code 完全不同）。历史实现把全部维度名收进单一 bannedDimensionNames 后跨组全局过滤，
      //  误杀树上 32 个中间层节点 ⇒ viaParentCode 链断裂 ⇒ 前端 nestGroupTags 重建塌缩 ⇒ 树只剩 2 层。
      //  修复：组自身名维持逐组封禁（铁律 1）；全局名单仅对「内容标签」动态池生效（铁律 2 的真实靶子），
      //  受控树组（source=omni/builtin 的树形组）豁免跨域名单，保住 viaParentCode 链完整性。
      const globalBannedNames = new Set<string>()
      for (const [code, meta] of Object.entries(ROOT_DIMENSION_META)) {
        if (meta.name) globalBannedNames.add(meta.name.trim())
        globalBannedNames.add(aliasResolver(code, meta.name).trim())
      }
      if (allAuthorityDims) {
        for (const ad of allAuthorityDims) {
          if (ad.name) globalBannedNames.add(ad.name.trim())
          if (ad.code) globalBannedNames.add(aliasResolver(ad.code, ad.name || ad.code).trim())
        }
      }
      for (const g of finalGroups) {
        if (g.name) globalBannedNames.add(g.name.trim())
      }

      for (const g of finalGroups) {
        if (Array.isArray(g.tags)) {
          const groupNameTrimmed = g.name.trim()
          g.tags = g.tags.filter(t => {
            const val = t.tagValue?.trim()
            if (!val) return false
            // 维度名本身不能作为其下的标签（铁律 1：组自身名逐组封禁，对所有来源生效）
            if (val === groupNameTrimmed) return false
            // 顶层根名/受控维度名不得混入动态标签池（铁律 2）。
            // 豁免仅限 Omni 受控树来源节点（meta.fromControlledTree）：受控树中间层节点名
            // 与其它域受控维度名合法撞名（code 完全不同），跨组封禁会误杀树节点断链。
            // 动态扩展/预设补全/本地孤儿标签一律不豁免，维持全局封禁（防脏数据污染）。
            const fromControlledTree = (t as any)?.meta?.fromControlledTree === true
            if (!fromControlledTree && globalBannedNames.has(val)) return false
            return true
          })
        }
      }

      // 保证 6 大根维度按官方标准顺序优先排列，并过滤 tags 为空的组
      finalGroups.sort((a, b) => {
        // builtin.content_tags 恒定垫底（无条件，优先于 order 档，与前端比较层口径统一）
        const isTailA = a.code === CONTENT_TAGS_CODE
        const isTailB = b.code === CONTENT_TAGS_CODE
        if (isTailA !== isTailB) return isTailA ? 1 : -1
        const orderA = a.order !== undefined && a.order > 0 ? a.order : 999999
        const orderB = b.order !== undefined && b.order > 0 ? b.order : 999999
        return orderA - orderB
      })
      // 判断是否属于敏感内容层级（敏感内容及下属所有细分、色情分级、内容分级等）
      const CODE_SENSITIVE = concept('敏感内容')
      const CODE_EROTIC = concept('色情分级')
      const CODE_CONTENT_RATING = concept('内容分级')
      const isSensitiveDimension = (g: any): boolean => {
        const code = g.code || ''
        const id = Number(g.id)
        if (
          code === CODE_SENSITIVE ||
          code === CODE_EROTIC ||
          code === CODE_CONTENT_RATING ||
          (code &&
            (resolveSubdimensionRoot(code) === CODE_CONTENT_RATING ||
              resolveSubdimensionRoot(code) === CODE_SENSITIVE))
        ) {
          return true
        }
        if (id === 130 || id === 123 || id === 162) return true
        if (id >= 131 && id <= 134) return true
        if (id >= 150 && id <= 161) return true
        return false
      }

      const validGroups = finalGroups.filter(g => {
        // 敏感内容维度的所有层级及标签隐蔽门禁：除非同维度的标签有一个及以上文件计数，否则全量隐藏不展示
        if (isSensitiveDimension(g)) {
          const hasFileHit = Array.isArray(g.tags) && g.tags.some(t => (t.fileCount || 0) > 0)
          if (!hasFileHit) return false
        }

        if (g.tags && g.tags.length > 0) return true
        // 当 includeAllPresetTags 为 true 时，泛维度即使 tags 为空也必须输出
        const isPan =
          (typeof g.metadata === 'object' && g.metadata !== null
            ? (g.metadata as any).flag?.isPanDimension
            : false) === true || (g.metadata as any)?.isPanDimension === true
        if (includeAllPresetTags && isPan) return true
        return false
      })

      return {
        groups: validGroups,
        pathCountMap,
        performance: {
          dbQueryTime: Math.round(dbQueryTime * 100) / 100,
          totalTime: Math.round((performance.now() - startTime) * 100) / 100
        }
      }
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '[TagTreeQuery] 获取维度组失败:', error)
      return { groups: [] }
    }
  },

  resolveAuthorityDimensions(): {
    byCode: Map<
      string,
      { id?: number; flag?: DimensionFlags; tags?: string[]; name?: string; dim?: any }
    >
    byId: Map<
      number,
      { id?: number; flag?: DimensionFlags; tags?: string[]; name?: string; dim?: any }
    >
    all: any[]
  } {
    const byCode = new Map<string, any>()
    const byId = new Map<number, any>()
    let all: any[] = []
    try {
      const dims = ConfigDbManager.getInstance().getFileDimensions()
      all = dims || []
      for (const dim of all) {
        const item = {
          id: typeof dim.id === 'number' ? dim.id : undefined,
          code: dim.code,
          name: dim.name,
          tags: dim.tags || [],
          flag: dim.metadata?.flag,
          metadata: dim.metadata,
          dim
        }
        if (dim?.code) {
          byCode.set(dim.code, item)
        }
        if (typeof dim?.id === 'number') {
          byId.set(dim.id, item)
        }
      }
    } catch (err) {
      logger.debug(
        LogCategory.VIRTUAL_DIRECTORY,
        '[TagTreeQuery] 读取本地维度策略（ConfigDbManager）失败，omni 组按无 flag 降级:',
        err
      )
    }
    return { byCode, byId, all }
  },

  resolveAuthorityDimensionsByCode(): Map<string, { id?: number; flag?: DimensionFlags }> {
    const { byCode } = this.resolveAuthorityDimensions()
    return byCode
  }
} satisfies ThisType<TagTreeQuery> & TagTreeQueryDimensionTree
