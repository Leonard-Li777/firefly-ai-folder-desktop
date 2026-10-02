import Database from 'better-sqlite3'
import path from 'node:path'
import {
  DimensionGroup,
  DimensionGroupsResponse,
  DimensionMetadata,
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
import { decompressText } from '../../../utils/text-compressor'
import { omniClient } from '../../../services/omni-client'
import type { OmniTaxonomyNode } from '../../../services/omni-client'
import {
  HybridRankedCandidate,
  HybridSearchArbiter,
  HYBRID_SEARCH_POOL_SIZE,
  splitPassages
} from './HybridSearchArbiter'
import { HybridSearchSession } from './hybrid-search-session'

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
/** builtin.content_tags: parent_codes 为空数组的标签的逻辑父级 code */
const CONTENT_TAGS_CODE = 'builtin.content_tags'

export class TagTreeQuery {
  private dagMaterializer: DAGMaterializer
  private hybridArbiter: HybridSearchArbiter
  private hybridSession: HybridSearchSession
  /**
   * Omni 受控树的父->子邻接图缓存（跨源 BFS 子孙解析所需）
   * key: parentCode, value: Set<childCode>
   * 懒加载，首次调用 ensureLocalChildrenMap() 时填充本地 file_tags 部分；
   * Omni 受控树边由 buildOmniEdgesFromTree 在获取 treeRes 后追加。
   */
  private _omniChildrenMap: Map<string, Set<string>> | null = null
  /** _omniChildrenMap 最后一次刷新时间戳（ms），TTL=60s 避免长会话数据陈旧 */
  private _omniMapLoadedAt = 0
  private static readonly OMNI_MAP_TTL = 60_000
  /** Omni 受控树边是否已注入当前 _omniChildrenMap（获取 treeRes 后置 true，TTL 过期时随 map 重置为 false） */
  private _omniEdgesInjected = false

  constructor(private db: Database.Database, hybridArbiter?: HybridSearchArbiter) {
    this.ensureSqlFunctions()
    this.dagMaterializer = new DAGMaterializer(db)
    this.hybridArbiter = hybridArbiter ?? new HybridSearchArbiter(db)
    // 混合检索编排（ADR-0039）公开收口：Session 负责编排与回退策略，本类作为数据访问协作者注入
    this.hybridSession = new HybridSearchSession({
      searchHybrid: this.hybridArbiter.searchHybrid.bind(this.hybridArbiter),
      fetchLegacySearchRefs: params => this.fetchLegacySearchRefs(params),
      fetchRowsByFingerprints: fps => this.fetchRowsByFingerprints(fps),
      mapFilesToItems: (rows, ws, showMissing) => this.mapFilesToItems(rows, ws, showMissing ?? true),
      fetchContentsForSearch: fps => this.fetchContentsForSearch(fps),
      enrichSearchPage: (kw, refs, cand, contents) => this.enrichSearchPage(kw, refs, cand, contents),
      synthesizeUnanalyzedItem: (ref, ws) => this.synthesizeUnanalyzedItem(ref, ws),
      fallbackPaged: params => this.getFilteredFilesPaged(params)
    })
  }

  /**
   * 异步确保全量父→子邻接图（含本地 file_tags 与 Omni 受控分类树）已构建完成。
   * 支持跨源多级子孙展开（如点击"图片"能穿透召回"截图"及其全部下级）。
   * 结果缓存 60 秒后自动过期。
   */
  public async ensureFullChildrenMap(locale = 'zh-CN'): Promise<Map<string, Set<string>>> {
    const now = Date.now()
    if (this._omniChildrenMap && this._omniEdgesInjected && now - this._omniMapLoadedAt < TagTreeQuery.OMNI_MAP_TTL) {
      return this._omniChildrenMap
    }

    const map = new Map<string, Set<string>>()
    const addEdge = (parent: string, child: string) => {
      if (!parent || !child || parent === child) return
      if (!map.has(parent)) map.set(parent, new Set())
      map.get(parent)!.add(child)
    }

    // 1. 本地 file_tags 的 parent_codes 关系
    try {
      const rows = this.db
        .prepare('SELECT code, parent_codes FROM file_tags WHERE depth > 0')
        .all() as Array<{ code: string; parent_codes: string }>
      for (const row of rows) {
        let parents: string[] = []
        try { parents = JSON.parse(row.parent_codes || '[]') } catch { parents = [] }
        if (parents.length === 0) {
          addEdge(CONTENT_TAGS_CODE, row.code)
        } else {
          for (const p of parents) {
            addEdge(p, row.code)
          }
        }
      }
    } catch (err) {
      logger.warn(LogCategory.VIRTUAL_DIRECTORY, '[TagTreeQuery] ensureFullChildrenMap: file_tags parent_codes 加载失败:', err)
    }

    // 2. Omni 受控树父子边（异步 HTTP，内置缓存保护）
    try {
      const treeRes = await omniClient.getTaxonomyTree(locale)
      if (treeRes?.rootNodes) {
        const visitNode = (node: OmniTaxonomyNode) => {
          for (const child of node.children || []) {
            addEdge(node.code, child.code)
            if (node.name) addEdge(node.name, child.code)
            visitNode(child)
          }
        }
        for (const root of treeRes.rootNodes) {
          visitNode(root)
        }
        this._omniEdgesInjected = true
      }
    } catch (err) {
      logger.warn(LogCategory.VIRTUAL_DIRECTORY, '[TagTreeQuery] ensureFullChildrenMap: Omni 树边加载失败:', err)
    }

    this._omniChildrenMap = map
    this._omniMapLoadedAt = now
    return map
  }

  /**
   * 同步快速获取邻接图（若尚未异步加载全量，至少确保本地边就绪，不盲目清除已有 Omni 边）
   */
  private ensureLocalChildrenMap(): Map<string, Set<string>> {
    const now = Date.now()
    if (this._omniChildrenMap && now - this._omniMapLoadedAt < TagTreeQuery.OMNI_MAP_TTL) {
      return this._omniChildrenMap
    }

    const map = new Map<string, Set<string>>()
    const addEdge = (parent: string, child: string) => {
      if (!parent || !child || parent === child) return
      if (!map.has(parent)) map.set(parent, new Set())
      map.get(parent)!.add(child)
    }

    try {
      const rows = this.db
        .prepare('SELECT code, parent_codes FROM file_tags WHERE depth > 0')
        .all() as Array<{ code: string; parent_codes: string }>
      for (const row of rows) {
        let parents: string[] = []
        try { parents = JSON.parse(row.parent_codes || '[]') } catch { parents = [] }
        if (parents.length === 0) {
          addEdge(CONTENT_TAGS_CODE, row.code)
        } else {
          for (const p of parents) {
            addEdge(p, row.code)
          }
        }
      }
    } catch (err) {
      logger.warn(LogCategory.VIRTUAL_DIRECTORY, '[TagTreeQuery] ensureLocalChildrenMap: file_tags parent_codes 加载失败:', err)
    }

    this._omniChildrenMap = map
    this._omniMapLoadedAt = now
    this._omniEdgesInjected = false
    return map
  }

  /**
   * 将已获取的 Omni 受控树节点注入邻接图（追加模式，不覆盖已有边）。
   * 在 getDimensionGroups 已拿到 treeRes 后调用，复用同一次 HTTP 结果，
   * 避免重复请求导致的竞争与超时。
   */
  private buildOmniEdgesFromTree(rootNodes: OmniTaxonomyNode[]): void {
    if (!this._omniChildrenMap) return
    const map = this._omniChildrenMap
    const addEdge = (parent: string, child: string) => {
      if (!parent || !child || parent === child) return
      if (!map.has(parent)) map.set(parent, new Set())
      map.get(parent)!.add(child)
    }
    const visitNode = (node: OmniTaxonomyNode) => {
      for (const child of node.children || []) {
        addEdge(node.code, child.code)
        // 名称别名也建立映射，兼容 tagValue 以中文名传入的场景
        if (node.name) addEdge(node.name, child.code)
        visitNode(child)
      }
    }
    for (const root of rootNodes) {
      visitNode(root)
    }
    this._omniEdgesInjected = true
  }

  /**
   * 在跨源邻接图上做 BFS，收集指定 code/name 及其全部子孙的 code 集合（供未来扩展使用）。
   */
  private collectOmniDescendantsSync(
    codeOrName: string,
    map: Map<string, Set<string>>
  ): Set<string> {
    const result = new Set<string>()
    const queue: string[] = [codeOrName]
    const visited = new Set<string>()
    while (queue.length > 0) {
      const cur = queue.shift()!
      if (visited.has(cur)) continue
      visited.add(cur)
      result.add(cur)
      const children = map.get(cur)
      if (children) {
        for (const c of children) {
          if (!visited.has(c)) queue.push(c)
        }
      }
    }
    return result
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
        } catch (err) {
          // 忽略规则加载失败属可容忍降级：该文件按「不忽略」处理
          logger.debug(LogCategory.VIRTUAL_DIRECTORY, `[TagTreeQuery] should_ignore_file 判定失败（${fileName}），按不忽略处理:`, err)
          return 0
        }
      })
    } catch (err) {
      // 忽略已注册或 Mock 数据库环境中的错误（注册冲突属可容忍降级：SQL 函数缺省，查询回退不过滤）
      logger.debug(LogCategory.VIRTUAL_DIRECTORY, '[TagTreeQuery] 注册 should_ignore_file SQL 函数失败，忽略:', err)
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
    } catch (err) {
      // FTS 探针失败属可容忍降级：回退 LIKE 检索路径
      logger.debug(LogCategory.VIRTUAL_DIRECTORY, '[TagTreeQuery] files_fts 探针失败，按 FTS 不可用处理:', err)
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
   * 将选中的标签（无论传的是受控 code、展示名 tagValue 还是动态扩展 code）
   * 全面解析为所有可能匹配的底层 tag_code 列表（支持双轨动态扩展与物化子树召回）。
   *
   * 同时利用已缓存的 _omniChildrenMap（由 ensureOmniChildrenMap 预热）对
   * Omni 受控树骨干节点（如"图片"、"文档"等未落本地 file_tags 物化路径的节点）
   * 做跨源 BFS 子孙展开，保障父级标签点击可穿透召回全量后代文件。
   */
  public resolveFilterTagCodes(tag: { code?: string; tagValue?: string; viaParentCode?: string }): string[] {
    const codeSet = new Set<string>()
    if (tag.code) codeSet.add(tag.code)

    // 1. 通过 getDescendantTagCodes 获取子孙节点 codes（本地 file_tags 物化路径）
    if (tag.code) {
      for (const c of this.getDescendantTagCodes(tag.code)) {
        codeSet.add(c)
      }
    }
    if (tag.tagValue && tag.tagValue !== tag.code) {
      for (const c of this.getDescendantTagCodes(tag.tagValue)) {
        codeSet.add(c)
      }
    }

    // 2. 双轨动态映射：在 file_tags 中查找与该标签关联的所有动态扩展 code
    try {
      const candidates: Array<{ code: string }> = []
      if (tag.tagValue && tag.code) {
        const rows = this.db.prepare(
          `SELECT DISTINCT code FROM file_tags
           WHERE name = ? OR code = ? OR parent_codes LIKE ? OR name LIKE ?`
        ).all(tag.tagValue, tag.code, `%${tag.code}%`, `%${tag.tagValue}%`) as Array<{ code: string }>
        candidates.push(...rows)
      } else if (tag.tagValue) {
        const rows = this.db.prepare(
          `SELECT DISTINCT code FROM file_tags
           WHERE name = ? OR code = ? OR name LIKE ?`
        ).all(tag.tagValue, tag.tagValue, `%${tag.tagValue}%`) as Array<{ code: string }>
        candidates.push(...rows)
      } else if (tag.code) {
        const rows = this.db.prepare(
          `SELECT DISTINCT code FROM file_tags
           WHERE code = ? OR parent_codes LIKE ?`
        ).all(tag.code, `%${tag.code}%`) as Array<{ code: string }>
        candidates.push(...rows)
      }

      for (const row of candidates) {
        if (row.code) {
          codeSet.add(row.code)
          // 连带召回该扩展节点的子孙 codes
          for (const c of this.getDescendantTagCodes(row.code)) {
            codeSet.add(c)
          }
        }
      }
    } catch (err) {
      logger.warn(LogCategory.VIRTUAL_DIRECTORY, `[TagTreeQuery] resolveFilterTagCodes 查询动态扩展标签失败:`, err)
    }

    // 3. 跨源 BFS：利用已预热的 Omni 邻接图展开子孙（含 builtin.* / omw.* / hownet.* 骨干节点）
    if (this._omniChildrenMap) {
      const map = this._omniChildrenMap
      const bfsQueue: string[] = []
      const bfsVisited = new Set<string>()
      // 从所有已收集的 code 出发做 BFS
      for (const startCode of Array.from(codeSet)) {
        bfsQueue.push(startCode)
      }
      // 也从 tagValue（中文展示名）出发，以兼容 Omni 节点以中文名作为 key 的情况
      if (tag.tagValue) bfsQueue.push(tag.tagValue)

      while (bfsQueue.length > 0) {
        const cur = bfsQueue.shift()!
        if (bfsVisited.has(cur)) continue
        bfsVisited.add(cur)
        codeSet.add(cur)
        const children = map.get(cur)
        if (children) {
          for (const c of children) {
            if (!bfsVisited.has(c)) bfsQueue.push(c)
          }
        }
      }
    }

    if (codeSet.size === 0) {
      if (tag.code) codeSet.add(tag.code)
      if (tag.tagValue) codeSet.add(tag.tagValue)
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
      // 多语言别名已落库分表，展示名直接查 DB，无需内存总线 TaxonomyAliasCache
      // 如需确保当前语言分表存在，可在此调用 createTagAliasesLangTable(db, locale)

      if ((opts as any).forceRefresh || (opts as any).refresh) {
        omniClient.clearTaxonomyTreeCache()
      }

      // 构建本地父→子邻接图（同步，无 HTTP；Omni 边在获取 treeRes 后追加）
      this.ensureLocalChildrenMap()

      let showMissing = true
      try {
        showMissing = ConfigOrchestrator.getInstance().getValue<boolean>('SHOW_MISSING_FILES') ?? true
      } catch (err) {
        // 配置中心未就绪属可容忍降级：按默认值显示缺失文件
        logger.debug(LogCategory.VIRTUAL_DIRECTORY, '[TagTreeQuery] 读取 SHOW_MISSING_FILES 失败，按默认 true 处理:', err)
      }

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
          return !/扩展名|Extension/i.test(d.name) && !/扩展名|Extension/i.test(d.code)
        })
      }

      // 2. 获取所有非根标签节点（#625：透出 code/parent_codes/meta 供前端纯树形状态机消费）
      // 2. 获取所有非根标签节点（#625：透出 code/parent_codes/meta 供前端纯树形状态机消费）
      const tagRows = this.db
        .prepare(`
          SELECT code, name, parent_codes, materialized_paths, depth, file_groups, meta
          FROM file_tags
          WHERE (json_extract(meta, '$.isDimension') IS NULL OR json_extract(meta, '$.isDimension') = 0)
          ORDER BY depth ASC, code ASC
        `)
        .all() as Array<{
          code: string
          name: string
          parent_codes: string
          materialized_paths?: string
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
        const escapeLike = (s: string) => s.replace(/([%_\\])/g, '\\$1')
        if (unionMode === 'union') {
          const clauses: string[] = []
          for (const st of selectedTags) {
            const codes = this.resolveFilterTagCodes(st)
            const tagSubClauses: string[] = []
            if (codes.length > 0) {
              const placeholders = codes.map(() => '?').join(',')
              tagSubClauses.push(`ftr.tag_code IN (${placeholders})`)
              filteredFingerprintsParams.push(...codes)
            }
            const rawCodePath = ((st as any).codePath || (st as any).code_path || '').trim()
            if (rawCodePath) {
              tagSubClauses.push(`(ftr.code_path = ? OR ftr.code_path LIKE (? || '/%') ESCAPE '\\')`)
              const escPath = escapeLike(rawCodePath)
              filteredFingerprintsParams.push(rawCodePath, escPath)
            } else if (st.code) {
              const targetPath = st.code.startsWith('/') ? st.code : `/${st.code}`
              tagSubClauses.push(`(ftr.code_path = ? OR ftr.code_path LIKE (? || '/%') ESCAPE '\\')`)
              const escTarget = escapeLike(targetPath)
              filteredFingerprintsParams.push(targetPath, escTarget)
            }
            if (tagSubClauses.length > 0) {
              clauses.push(`(${tagSubClauses.join(' OR ')})`)
            }
          }
          if (clauses.length > 0) {
            filteredFingerprintsSql += `
              AND wf.file_fingerprint IN (
                SELECT ftr.file_fingerprint
                FROM file_tag_relations ftr
                WHERE ${clauses.join(' OR ')}
              )
            `
          }
        } else {
          // intersection
          for (const st of selectedTags) {
            const codes = this.resolveFilterTagCodes(st)
            const tagSubClauses: string[] = []
            if (codes.length > 0) {
              const placeholders = codes.map(() => '?').join(',')
              tagSubClauses.push(`ftr.tag_code IN (${placeholders})`)
              filteredFingerprintsParams.push(...codes)
            }
            const rawCodePath = ((st as any).codePath || (st as any).code_path || '').trim()
            if (rawCodePath) {
              tagSubClauses.push(`(ftr.code_path = ? OR ftr.code_path LIKE (? || '/%') ESCAPE '\\')`)
              const escPath = escapeLike(rawCodePath)
              filteredFingerprintsParams.push(rawCodePath, escPath)
            } else if (st.code) {
              const targetPath = st.code.startsWith('/') ? st.code : `/${st.code}`
              tagSubClauses.push(`(ftr.code_path = ? OR ftr.code_path LIKE (? || '/%') ESCAPE '\\')`)
              const escTarget = escapeLike(targetPath)
              filteredFingerprintsParams.push(targetPath, escTarget)
            }
            if (tagSubClauses.length > 0) {
              filteredFingerprintsSql += `
                AND wf.file_fingerprint IN (
                  SELECT ftr.file_fingerprint
                  FROM file_tag_relations ftr
                  WHERE ${tagSubClauses.join(' OR ')}
                )
              `
            }
          }
        }
      }

      // 4. 统计在有效文件集合下，每个 (tag_code, via_parent_code) 的文件命中集（V4 联合统计）
      const countQuery = `
        SELECT ftr.tag_code, ftr.via_parent_code, ftr.file_fingerprint, ftr.code_path, ftr.name_path, ftr.depth
        FROM file_tag_relations ftr
        WHERE ftr.file_fingerprint IN (${filteredFingerprintsSql})
      `
      const countStartTime = performance.now()
      const relationRows = this.db.prepare(countQuery).all(...filteredFingerprintsParams) as Array<{
        tag_code: string
        via_parent_code: string
        file_fingerprint: string
        code_path?: string
        name_path?: string
        depth?: number
      }>
      dbQueryTime += performance.now() - countStartTime

      const tagFilesMap = new Map<string, Set<string>>()
      const tagParentFilesMap = new Map<string, Set<string>>()
      const tagCountMap = new Map<string, number>()
      const tagParentCountMap = new Map<string, number>()
      const tagChainsMap = new Map<string, Array<{ name_path: string; code_path: string }>>()

      for (const row of relationRows) {
        if (!tagFilesMap.has(row.tag_code)) {
          tagFilesMap.set(row.tag_code, new Set())
        }
        tagFilesMap.get(row.tag_code)!.add(row.file_fingerprint)

        const parentKey = `${row.tag_code}::${row.via_parent_code}`
        if (!tagParentFilesMap.has(parentKey)) {
          tagParentFilesMap.set(parentKey, new Set())
        }
        tagParentFilesMap.get(parentKey)!.add(row.file_fingerprint)

        const rowCodePath = row.code_path || ''
        const rowNamePath = row.name_path || ''
        if (rowCodePath || rowNamePath) {
          if (!tagChainsMap.has(row.tag_code)) {
            tagChainsMap.set(row.tag_code, [])
          }
          tagChainsMap.get(row.tag_code)!.push({
            name_path: rowNamePath,
            code_path: rowCodePath
          })
        }
      }

      for (const [code, fSet] of tagFilesMap.entries()) {
        tagCountMap.set(code, fSet.size)
      }
      for (const [key, fSet] of tagParentFilesMap.entries()) {
        tagParentCountMap.set(key, fSet.size)
      }

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
          Object.assign(aliasMap, databaseService.resolveTagDisplayNames(Array.from(aliasCodes), locale))
        } catch (err) {
          logger.warn(LogCategory.VIRTUAL_DIRECTORY, '[TagTreeQuery] 批量标签展示名解析失败，回退 file_tags.name:', err)
        }
      }
      const aliasResolver = (code: string, fallbackName?: string): string =>
        aliasMap[code] || fallbackName || code

      // 建立 tagNameCountMap 与 tagNameFilesMap，用于名称层面的关联兜底
      const tagNameCountMap = new Map<string, number>()
      const tagNameFilesMap = new Map<string, Set<string>>()
      // 建立动态子标签映射：parentCode -> Array<{ code, name, depth, meta, count }>
      const dynamicTagsByParent = new Map<string, Array<{
        code: string
        name: string
        depth: number
        meta: any
        count: number
      }>>()

      for (const t of tagRows) {
        const count = tagCountMap.get(t.code) || 0
        const files = tagFilesMap.get(t.code)
        const resolvedName = aliasResolver(t.code, t.name)
        if (files) {
          if (resolvedName) {
            if (!tagNameFilesMap.has(resolvedName)) tagNameFilesMap.set(resolvedName, new Set())
            for (const f of files) tagNameFilesMap.get(resolvedName)!.add(f)
          }
          if (t.name && t.name !== resolvedName) {
            if (!tagNameFilesMap.has(t.name)) tagNameFilesMap.set(t.name, new Set())
            for (const f of files) tagNameFilesMap.get(t.name)!.add(f)
          }
        }
        if (resolvedName) {
          tagNameCountMap.set(resolvedName, tagNameFilesMap.get(resolvedName)?.size || count)
        }
        if (t.name && t.name !== resolvedName) {
          tagNameCountMap.set(t.name, tagNameFilesMap.get(t.name)?.size || count)
        }
        let parents: string[] = []
        try {
          parents = JSON.parse(t.parent_codes || '[]')
        } catch {
          parents = []
        }
        // parent_codes 为空数组的标签，逻辑父级回退为 CONTENT_TAGS_CODE（内容标签）
        const effectiveParents = parents.length > 0 ? parents : [CONTENT_TAGS_CODE]
        for (const p of effectiveParents) {
          if (!dynamicTagsByParent.has(p)) {
            dynamicTagsByParent.set(p, [])
          }
          let parsedMeta = {}
          try { parsedMeta = JSON.parse(t.meta || '{}') } catch {}
          dynamicTagsByParent.get(p)!.push({
            code: t.code,
            name: resolvedName,
            depth: t.depth,
            meta: parsedMeta,
            count
          })
        }
      }


      for (const root of dimensionRoots) {
        const dimCode = root.code
        seenDimCodes.add(dimCode)
        let dimMeta: DimensionMetadata = {}
        try {
          dimMeta = JSON.parse(root.meta || '{}')
        } catch (err) {
          // meta 脏数据属可容忍降级：按空元数据处理
          logger.debug(LogCategory.VIRTUAL_DIRECTORY, `[TagTreeQuery] 解析维度根节点 meta 失败（${root.code}），按空对象处理:`, err)
        }

        // 匹配该维度下的直属子标签
        const directChildren = tagRows.filter(t => {
          let parentCodes: string[] = []
          try {
            parentCodes = JSON.parse(t.parent_codes || '[]')
          } catch (err) {
            // parent_codes 脏数据属可容忍降级：视为无父，仅按 code 前缀匹配归属
            logger.debug(LogCategory.VIRTUAL_DIRECTORY, `[TagTreeQuery] 解析 parent_codes 失败（${t.code}），按空数组处理:`, err)
          }
          return parentCodes.includes(dimCode) || t.code.startsWith(`${dimCode}.`)
        })

        const dimensionTags: DimensionTag[] = []

        // 提取数值型 ID 用于向前兼容（Fix-06：dimensionId 恢复为声明的 number 类型，
        // 标签归属改用 dimensionCode/code 承载，不再把字符串 code 强塞进数字字段）
        const numIdMatch = dimCode.match(/^dim\.(\d+)$/)
        const legacyNumericId = numIdMatch ? parseInt(numIdMatch[1], 10) : groups.length + 1

        for (const child of directChildren) {
          // #625：解析子标签的 meta 与 parent_codes，透出给前端纯树形状态机
          let childMeta: DimensionMetadata = {}
          try {
            childMeta = JSON.parse(child.meta || '{}')
          } catch (err) {
            // meta 脏数据属可容忍降级：按空元数据处理
            logger.debug(LogCategory.VIRTUAL_DIRECTORY, `[TagTreeQuery] 解析子标签 meta 失败（${child.code}），按空对象处理:`, err)
          }
          let childParentCodes: string[] = []
          try {
            childParentCodes = JSON.parse(child.parent_codes || '[]')
          } catch (err) {
            // parent_codes 脏数据属可容忍降级：回退当前维度根作为父级
            logger.debug(LogCategory.VIRTUAL_DIRECTORY, `[TagTreeQuery] 解析子标签 parent_codes 失败（${child.code}），回退当前维度根:`, err)
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

          assignedCodes.add(child.code)
          const childCodePath = tagChainsMap.get(child.code)?.[0]?.code_path || `/${dimCode}/${child.code}`
          const childNamePath = tagChainsMap.get(child.code)?.[0]?.name_path || `/${aliasResolver(root.code, root.name)}/${aliasResolver(child.code, child.name)}`
          dimensionTags.push({
            dimensionId: legacyNumericId,
            dimensionCode: dimCode,
            dimensionName: aliasResolver(root.code, root.name),
            tagValue: aliasResolver(child.code, child.name),
            fileCount: aggregatedCount,
            level: child.depth || 1,
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
            assignedCodes.add(sub.code)
            const subCodePath = tagChainsMap.get(sub.code)?.[0]?.code_path || `/${dimCode}/${parentCodeKey}/${sub.code}`
            const subNamePath = tagChainsMap.get(sub.code)?.[0]?.name_path || `/${aliasResolver(root.code, root.name)}/${sub.name}`
            dimensionTags.push({
              dimensionId: legacyNumericId,
              dimensionCode: dimCode,
              dimensionName: aliasResolver(root.code, root.name),
              tagValue: sub.name,
              fileCount: sub.count,
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

        groups.push({
          id: legacyNumericId,
          name: aliasResolver(root.code, root.name),
          level: root.depth,
          tags: dimensionTags,
          code: dimCode,
          isMultiSelect: dimMeta?.isMultiSelect === true,
          metadata: dimMeta
        })
      }

      // 6. 合并 Omni 受控分类树（builtin / omw 不再入库主库，走 HTTP API 拉取树结构）
      const dbPath = (this.db as any).name
      const treeRes = await omniClient.getTaxonomyTree(locale, undefined, dbPath, {
        workspaceId: opts.workspaceId,
        directoryPrefix: workspaceDirectoryPath
      })
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

      const omniGroups: Array<Omit<DimensionGroup, 'tags'> & { tags: DimensionTag[] }> = treeRes?.rootNodes
        ? treeRes.rootNodes.map((root, rootIdx) => {
            const id = 10000 + rootIdx
            const tags: DimensionTag[] = []


            // 后序递归汇聚整棵子树的唯一下属文件集合（保证祖先节点包含全部子孙命中，避免父级 count=0 被误裁剪）
            const nodeFilesMap = new Map<string, Set<string>>()
            const computeNodeSubtreeFiles = (node: OmniTaxonomyNode): Set<string> => {
              const fileSet = new Set<string>()

              // 1. 本节点自身命中文件（基于当前工作区与目录作用域的 tagFilesMap）
              const directFiles = tagFilesMap.get(node.code)
              if (directFiles) {
                for (const f of directFiles) fileSet.add(f)
              }
              if (node.name) {
                const byName = tagNameFilesMap.get(node.name)
                if (byName) {
                  for (const f of byName) fileSet.add(f)
                }
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
                let count = subtreeFiles && subtreeFiles.size > 0
                  ? subtreeFiles.size
                  : (child.fileCount ?? tagParentCountMap.get(`${code}::${parentCode}`) ?? tagCountMap.get(code) ?? 0)
                if (count === 0 && child.name && tagNameCountMap.has(child.name)) {
                  count = tagNameCountMap.get(child.name)!
                }
                const currentCodePath = `${parentCodePath}/${child.code}`
                const currentNamePath = `${parentNamePath}/${child.name}`
                tags.push({
                  dimensionId: id,
                  dimensionCode: root.code,
                  dimensionName: root.name,
                  tagValue: child.name,
                  fileCount: count,
                  level,
                  code,
                  codePath: currentCodePath,
                  namePath: currentNamePath,
                  viaParentCode: parentCode || root.code,
                  isMultiSelect: false,
                  order: child.sortOrder,
                  meta: { sort_order: child.sortOrder, order: child.sortOrder }
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
                  assignedCodes.add(dyn.code)
                  const dynCodePath = tagChainsMap.get(dyn.code)?.[0]?.code_path || `${curCodePath}/${dyn.code}`
                  const dynNamePath = tagChainsMap.get(dyn.code)?.[0]?.name_path || `${curNamePath}/${dyn.name}`
                  tags.push({
                    dimensionId: id,
                    dimensionCode: root.code,
                    dimensionName: root.name,
                    tagValue: dyn.name,
                    fileCount: dyn.count,
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
            collect(root, root.code, 1, `/${root.code}`, `/${root.name}`)
            return {
              id,
              name: root.name,
              level: 0,
              tags,
              code: root.code,
              order: root.sortOrder,
              sort_order: root.sortOrder,
              isMultiSelect: false,
              meta: { source: root.source || 'builtin', order: root.sortOrder, sort_order: root.sortOrder },
              metadata: { source: root.source || 'builtin', order: root.sortOrder, sort_order: root.sortOrder }
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
          tags = tags.filter(t => !/扩展名|Extension/i.test(t.tagValue) && !/扩展名|Extension/i.test(t.code || ''))
        }
        if (removeEmptyTags && !includeAllPresetTags) {
          tags = tags.filter(t => t.fileCount > 0)
        }
        // 对于根级，如果其下没有子标签，则根级数据不应输出，也不应展示
        if (tags.length === 0) continue

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
        const orderA = a.order !== undefined && a.order > 0 ? a.order : 999999
        const orderB = b.order !== undefined && b.order > 0 ? b.order : 999999
        return orderA - orderB
      })

      // 彻底消除任何根级重复（按 code 与 name 去重，且严格剔除 tags 为空的根级）
      const finalGroups: DimensionGroup[] = []
      const dedupeCodes = new Set<string>()
      const dedupeNames = new Set<string>()
      for (const g of groups) {
        if (g.code && dedupeCodes.has(g.code)) continue
        if (g.name && dedupeNames.has(g.name)) continue
        if (!g.tags || g.tags.length === 0) continue
        if (g.code) dedupeCodes.add(g.code)
        if (g.name) dedupeNames.add(g.name)
        finalGroups.push(g)
      }

      // 注入"内容标签"（builtin.content_tags）虚拟维度组：
      // 收纳未被受控/本地已知维度根节点覆盖的所有动态标签，并建立内部多级树形层级结构与穿透提升支持。
      // 若 finalGroups 中已包含该 code（来自 Omni 树原生输出），则跳过注入以避免重复。
      if (!dedupeCodes.has(CONTENT_TAGS_CODE)) {
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

        const WELL_KNOWN_PARENT_TO_ROOT: Record<string, string> = {
          'builtin.image_subdivision': 'builtin.file_type',
          'builtin.image_segmentation': 'builtin.file_type',
          'builtin.photo_subdivision': 'builtin.file_type',
          'builtin.photography_categories': 'builtin.file_type',
          'builtin.screenshot_breakdown': 'builtin.file_type',
          'builtin.screenshot_subdivision': 'builtin.file_type',
          'builtin.manga_subdivision': 'builtin.file_type',
          'builtin.comic_segmentation': 'builtin.file_type',
          'builtin.porn_subdivision': 'builtin.file_type',
          'builtin.watermark_level': 'builtin.file_type',
          'builtin.mosaic_level': 'builtin.file_type',
          'builtin.theme': 'builtin.file_type',
          'builtin.author': 'builtin.file_type'
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
              const pLvl = tagLevelMap.get(p) ?? 1
              return { targetGroup: group, parentCode: p, level: pLvl + 1 }
            }

            // 命中已知受控细分映射
            const mappedRoot = WELL_KNOWN_PARENT_TO_ROOT[p]
            if (mappedRoot) {
              const group = finalGroups.find(g => g.code === mappedRoot)
              if (group) {
                return { targetGroup: group, parentCode: p, level: 2 }
              }
            }

            // 命中 Omni 全量节点到根的映射
            if (omniCodeToRootCodeMap.has(p)) {
              const rootCode = omniCodeToRootCodeMap.get(p)!
              const group = finalGroups.find(g => g.code === rootCode)
              if (group) {
                return { targetGroup: group, parentCode: p, level: 2 }
              }
            }

            // 递归在 tagRows 中查找 p 的父级链
            const pRow = tagRows.find(r => r.code === p)
            if (pRow) {
              let pParents: string[] = []
              try { pParents = JSON.parse(pRow.parent_codes || '[]') } catch {}
              const traced = traceAncestorGroup(pParents, visited)
              if (traced) return traced
            }
          }
          return undefined
        }

        // 收集受控维度内可被动态标签特化认领的代表性标签（如截图、照片、水印、摄影等）
        const controlledStemMap: Array<{ stem: string; targetGroup: DimensionGroup; parentTag: DimensionTag }> = []
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
          const count = selfFiles.size > 0 ? selfFiles.size : (tagCountMap.get(t.code) || 0)
          if (removeEmptyTags && !includeAllPresetTags && count === 0) continue

          let parents: string[] = []
          try { parents = JSON.parse(t.parent_codes || '[]') } catch { parents = [] }

          // 1. 同名直接认领合并
          let matchedSameName: { group: DimensionGroup; tag: DimensionTag } | null = null
          for (const g of finalGroups) {
            if (g.code === CONTENT_TAGS_CODE) continue
            const foundTag = g.tags.find(tg => tg.tagValue === resolvedName)
            if (foundTag) {
              matchedSameName = { group: g, tag: foundTag }
              break
            }
          }
          if (matchedSameName) {
            const { group, tag } = matchedSameName
            assignedCodes.add(t.code)
            tagToGroupMap.set(t.code, group)
            tag.fileCount = Math.max(tag.fileCount, count)
            continue
          }

          // 2. 祖先追溯认领
          const traced = traceAncestorGroup(parents)
          if (traced) {
            const { targetGroup, parentCode: effectiveParent, level: effectiveLevel } = traced
            assignedCodes.add(t.code)
            tagToGroupMap.set(t.code, targetGroup)
            tagLevelMap.set(t.code, effectiveLevel)
            targetGroup.tags.push({
              dimensionId: targetGroup.id,
              dimensionCode: targetGroup.code || '',
              dimensionName: targetGroup.name,
              tagValue: resolvedName,
              fileCount: count,
              level: effectiveLevel,
              code: t.code,
              viaParentCode: effectiveParent,
              isMultiSelect: false,
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
            assignedCodes.add(t.code)
            tagToGroupMap.set(t.code, targetGroup)
            tagLevelMap.set(t.code, nextLvl)
            targetGroup.tags.push({
              dimensionId: targetGroup.id,
              dimensionCode: targetGroup.code || '',
              dimensionName: targetGroup.name,
              tagValue: resolvedName,
              fileCount: count,
              level: nextLvl,
              code: t.code,
              viaParentCode: parentTag.code || parentTag.tagValue,
              isMultiSelect: false,
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
          materializedPaths: Array<{ code_path: string; name_path: string }>
        }

        const contentCandidates: ContentCandidate[] = []
        for (const t of tagRows) {
          if (assignedCodes.has(t.code)) continue
          const resolvedName = aliasResolver(t.code, t.name)
          const selfFiles = tagFilesMap.get(t.code) || new Set<string>()
          const count = selfFiles.size > 0 ? selfFiles.size : (tagCountMap.get(t.code) || 0)
          if (removeEmptyTags && !includeAllPresetTags && count === 0) continue

          let parents: string[] = []
          try { parents = JSON.parse(t.parent_codes || '[]') } catch {}
          const mPaths = [
            ...DAGMaterializer.parsePaths((t as any).materialized_paths),
            ...(tagChainsMap.get(t.code) || [])
          ]

          contentCandidates.push({
            code: t.code,
            name: resolvedName,
            files: new Set(selfFiles),
            parents,
            materializedPaths: mPaths
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
            if (parentKey && parentKey !== CONTENT_TAGS_CODE && existing.parentKey === CONTENT_TAGS_CODE) {
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
          if (cand.materializedPaths.length > 0) {
            for (const mp of cand.materializedPaths) {
              const rawPath = mp.name_path || mp.code_path
              if (rawPath) {
                const segments = rawPath
                  .split('/')
                  .map(s => s.trim())
                  .filter(s => s && s !== '内容标签' && s !== CONTENT_TAGS_CODE)
                if (segments.length >= 2) {
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

          // 2. 次优：存在父节点声明时，挂载在父节点下
          if (!assigned && cand.parents.length > 0) {
            const pCode = cand.parents[0]
            if (pCode && pCode !== cand.code) {
              const pNode = ensureContentNode(pCode, aliasResolver(pCode, pCode), CONTENT_TAGS_CODE, 1)
              const leafNode = ensureContentNode(cand.code, cand.name, pNode.code, 2)
              for (const f of cand.files) leafNode.files.add(f)
              assigned = true
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
        const aggregateContentSubtreeFiles = (key: string, visited = new Set<string>()): Set<string> => {
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
        for (const [key, node] of contentNodeMap.entries()) {
          const count = node.files.size
          if (removeEmptyTags && !includeAllPresetTags && count === 0) continue

          const cCodePath = tagChainsMap.get(node.code)?.[0]?.code_path || `/builtin.content_tags/${node.code}`
          const cNamePath = tagChainsMap.get(node.code)?.[0]?.name_path || `/${contentTagDisplayName}/${node.name}`
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
            isMultiSelect: false,
            order: 9999
          })
        }

        if (contentDimTags.length > 0) {
          finalGroups.push({
            id: contentTagsDimId,
            name: contentTagDisplayName,
            level: 0,
            tags: contentDimTags,
            code: CONTENT_TAGS_CODE,
            isMultiSelect: false,
            metadata: { isPanDimension: true, source: 'builtin' }
          })
          logger.debug(
            LogCategory.VIRTUAL_DIRECTORY,
            `[TagTreeQuery] 注入多级树化内容标签维度组，共 ${contentDimTags.length} 个多级节点`
          )
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


      return {
        groups: finalGroups,
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
    } catch (err) {
      // 配置中心未就绪属可容忍降级：按默认值显示缺失文件
      logger.debug(LogCategory.VIRTUAL_DIRECTORY, '[TagTreeQuery] 读取 SHOW_MISSING_FILES 失败，按默认 true 处理:', err)
    }

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
      const escapeLike = (s: string) => s.replace(/([%_\\])/g, '\\$1')
      if (unionMode === 'union') {
        const clauses: string[] = []
        for (const tag of selectedTags) {
          const codes = this.resolveFilterTagCodes(tag)
          const tagSubClauses: string[] = []
          if (codes.length > 0) {
            const placeholders = codes.map(() => '?').join(',')
            tagSubClauses.push(`ftr.tag_code IN (${placeholders})`)
            queryParams.push(...codes)
          }
          const rawCodePath = ((tag as any).codePath || (tag as any).code_path || '').trim()
          if (rawCodePath) {
            tagSubClauses.push(`(ftr.code_path = ? OR ftr.code_path LIKE (? || '/%') ESCAPE '\\')`)
            const escPath = escapeLike(rawCodePath)
            queryParams.push(rawCodePath, escPath)
          } else if (tag.code) {
            const targetPath = tag.code.startsWith('/') ? tag.code : `/${tag.code}`
            tagSubClauses.push(`(ftr.code_path = ? OR ftr.code_path LIKE (? || '/%') ESCAPE '\\')`)
            const escTarget = escapeLike(targetPath)
            queryParams.push(targetPath, escTarget)
          }
          if (tagSubClauses.length > 0) {
            clauses.push(`(${tagSubClauses.join(' OR ')})`)
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
          const codes = this.resolveFilterTagCodes(tag)
          const tagSubClauses: string[] = []
          if (codes.length > 0) {
            const placeholders = codes.map(() => '?').join(',')
            tagSubClauses.push(`ftr.tag_code IN (${placeholders})`)
            queryParams.push(...codes)
          }
          const rawCodePath = ((tag as any).codePath || (tag as any).code_path || '').trim()
          if (rawCodePath) {
            tagSubClauses.push(`(ftr.code_path = ? OR ftr.code_path LIKE (? || '/%') ESCAPE '\\')`)
            const escPath = escapeLike(rawCodePath)
            queryParams.push(rawCodePath, escPath)
          } else if (tag.code) {
            const targetPath = tag.code.startsWith('/') ? tag.code : `/${tag.code}`
            tagSubClauses.push(`(ftr.code_path = ? OR ftr.code_path LIKE (? || '/%') ESCAPE '\\')`)
            const escTarget = escapeLike(targetPath)
            queryParams.push(targetPath, escTarget)
          }
          if (tagSubClauses.length > 0) {
            whereClauses.push(`wf.file_fingerprint IN (
              SELECT ftr.file_fingerprint
              FROM file_tag_relations ftr
              WHERE ${tagSubClauses.join(' OR ')}
            )`)
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
      // 确保全量父→子邻接图（含本地 file_tags 与 Omni 受控分类树）已构建
      await this.ensureFullChildrenMap()

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
    } catch (err: unknown) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '[TagTreeQuery] 分页过滤文件失败:', err)
      return { items: [], total: 0 }
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
        f.description as description,
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
          f.description as description,
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
      } catch (err) {
        // 配置中心未就绪属可容忍降级：按默认值显示缺失文件
        logger.debug(LogCategory.VIRTUAL_DIRECTORY, '[TagTreeQuery] 读取 SHOW_MISSING_FILES 失败，按默认 true 处理:', err)
      }

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
          } catch (err) {
            // 标签 JSON 脏数据属可容忍降级：该文件按无标签展示
            logger.debug(LogCategory.VIRTUAL_DIRECTORY, `[TagTreeQuery] 解析 dimension_tags 失败（${file.name}），按空标签处理:`, err)
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
          thumbnailPath: file.thumbnail_path || undefined,
          multimodalContent: file.multimodal_content ? decompressText(file.multimodal_content) || undefined : undefined,
          relativePathPrefix: relativePathPrefix || undefined,
          author: file.author || undefined,
          language: file.language || undefined,
          tags: Array.isArray(tags) ? tags : []
        }
      })
      .filter((item): item is NonNullable<typeof item> => item !== null)
  }
}
