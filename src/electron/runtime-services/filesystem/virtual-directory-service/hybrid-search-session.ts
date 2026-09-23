import {
  FileItem,
  FilteredFilesResponse
} from '@firefly/types'
import { LogCategory, logger, normalizeForCache } from '@firefly/shared'
import {
  HybridRankedCandidate,
  HybridSearchArbiter,
  HYBRID_SEARCH_POOL_SIZE,
  slicePage
} from './HybridSearchArbiter'
import type { FilterFilesParams } from './TagTreeQuery'

/** 混合检索分页引用：已分析候选 / 未分析 FS 命中 */
export type HybridPageRef =
  | { kind: 'analyzed'; fileFingerprint: string; hasLiteral: boolean }
  | { kind: 'unanalyzed'; path: string; name: string; fileFingerprint?: string }

/**
 * 混合检索协作接口：Session 负责编排与回退策略，
 * 数据访问（SQL 组装、行加载、正文解压、摘要丰富）由宿主（TagTreeQuery）注入。
 * 该 seam 使编排逻辑（合并顺序、去重、分页、回退）可脱离 SQLite 单独测试。
 */
export interface HybridSearchCollaborators {
  /** 仲裁融合：FTS5 BM25 + Omni 向量 + 文件名提升（+FS 未分析命中） */
  searchHybrid: HybridSearchArbiter['searchHybrid']
  /** 旧版 LIKE 全字段语义补充候选源（Hybrid Search Everything 兼容层） */
  fetchLegacySearchRefs(params: FilterFilesParams): {
    analyzed: Array<Extract<HybridPageRef, { kind: 'analyzed' }>>
    unanalyzed: Array<Extract<HybridPageRef, { kind: 'unanalyzed' }>>
  }
  /** 按指纹批量加载已分析文件明细行 */
  fetchRowsByFingerprints(fileFingerprints: string[]): any[]
  /** 明细行 → FileItem 映射 */
  mapFilesToItems(rows: any[], workspaceDirectoryPath?: string, showMissing?: boolean): FileItem[]
  /** 批量加载正文（解压拼接），供摘要提取 */
  fetchContentsForSearch(fileFingerprints: string[]): Map<string, string>
  /** 为当前页已分析候选生成富正文摘要（字面高亮 / 段落级语义对齐） */
  enrichSearchPage(
    keyword: string,
    analyzedRefs: Array<Extract<HybridPageRef, { kind: 'analyzed' }>>,
    candidateByFp: Map<string, HybridRankedCandidate>,
    contentsByFp: Map<string, string>
  ): Promise<Map<string, { snippet?: string; matchType: 'exact' | 'fuzzy' | 'semantic'; similarity?: number }>>
  /** 由 FS 未分析命中合成 FileItem */
  synthesizeUnanalyzedItem(ref: Extract<HybridPageRef, { kind: 'unanalyzed' }>, workspaceDirectoryPath?: string): FileItem
  /** 回退路径：去除搜索词的常规分页查询 */
  fallbackPaged(params: FilterFilesParams): Promise<FilteredFilesResponse>
}

/**
 * HybridSearchSession 深模块（ADR-0039 / Ticket-2 检索编排公开收口）：
 * 混合检索的分页编排策略在此单点定义 ——
 * 1. 委托仲裁器融合 FTS5 BM25 + Omni 向量 + 文件名提升，真实目录模式追加 FS 未分析命中；
 * 2. 统一有序候选池（仲裁候选 → LIKE 兼容补充 → FS 未分析 → LIKE 未分析），指纹/路径去重；
 * 3. 按融合顺序分页；当前页已分析候选补充富正文摘要；
 * 4. 任一步骤异常回退为去除搜索词的常规分页，保证搜索功能可用。
 * 回退策略是本模块公开接口上的显式行为，可注入 fake 协作者直接测试。
 */
export class HybridSearchSession {
  constructor(private collaborators: HybridSearchCollaborators) {}

  /**
   * 混合检索分页：按融合候选的统一顺序返回当前页文件与总数。
   * whereClauses/queryParams 由宿主经第 2 参注入（不含 searchKeyword 自身 LIKE 条件）。
   */
  async runPaged(
    params: FilterFilesParams,
    keyword: string,
    where: { whereClauses: string[]; queryParams: unknown[] }
  ): Promise<FilteredFilesResponse> {
    const startTime = performance.now()
    let dbQueryTime = 0
    try {
      const workspaceDirectoryPath = params.workspaceDirectoryPath

      const limit = params.limit !== undefined ? Math.max(0, params.limit) : Math.max(1, params.pageSize ?? 100)
      const offset = params.offset !== undefined ? Math.max(0, params.offset) : Math.max(0, ((params.page ?? 1) - 1) * limit)

      // 1. 仲裁融合（FTS + 向量 + 文件名）；过滤条件由宿主预先组装注入
      const pool = await this.collaborators.searchHybrid({
        keyword,
        whereClauses: where.whereClauses,
        queryParams: where.queryParams,
        workspaceDirectoryPath,
        poolSize: HYBRID_SEARCH_POOL_SIZE
      })

      if (pool.failures.fts || pool.failures.vector || pool.failures.fs) {
        logger.debug(
          LogCategory.VIRTUAL_DIRECTORY,
          `[HybridSearchSession] 混合检索部分降级: fts=${pool.failures.fts}, vector=${pool.failures.vector}, fs=${pool.failures.fs}`
        )
      }

      // 2. 统一有序引用（已分析候选在前，未分析命中追加尾部）：
      //    - 先取仲裁融合的高精度候选；
      //    - 再用旧版 LIKE 全字段查询作为补充候选源，
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
      // 2.2 旧 LIKE 全字段语义补充候选（已分析）
      const legacyRefs = this.collaborators.fetchLegacySearchRefs(params)
      for (const ref of legacyRefs.analyzed) {
        if (!ref.fileFingerprint || seenFp.has(ref.fileFingerprint)) continue
        seenFp.add(ref.fileFingerprint)
        fullPool.push(ref)
      }
      // 2.3 FS 实时未分析命中（真实目录模式，最新磁盘状态优先）
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
      // 2.4 旧 LIKE 未分析行（includeUnanalyzed 语义兜底，路径去重避免与 FS 命中重复）
      for (const ref of legacyRefs.unanalyzed) {
        if (ref.fileFingerprint && seenFp.has(ref.fileFingerprint)) continue
        const key = normalizeForCache(ref.path)
        if (seenUnanalyzedPath.has(key)) continue
        seenUnanalyzedPath.add(key)
        fullPool.push(ref)
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
      const rows = analyzedFps.length ? this.collaborators.fetchRowsByFingerprints(analyzedFps) : []
      dbQueryTime += performance.now() - rowStart

      const baseItems = new Map<string, FileItem>()
      for (const item of this.collaborators.mapFilesToItems(rows, workspaceDirectoryPath)) {
        if (item.fileFingerprint) baseItems.set(item.fileFingerprint, item)
      }

      const contentStart = performance.now()
      const contentsByFp = analyzedFps.length
        ? this.collaborators.fetchContentsForSearch(analyzedFps)
        : new Map<string, string>()
      dbQueryTime += performance.now() - contentStart

      const enrichment = await this.collaborators.enrichSearchPage(keyword, analyzedRefs, candidateByFp, contentsByFp)

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
          items.push(this.collaborators.synthesizeUnanalyzedItem(ref, workspaceDirectoryPath))
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
    } catch (err: unknown) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '[HybridSearchSession] 混合检索分页失败，回退常规检索:', err)
      // 回退：去除搜索词走常规分页，保证搜索异常时功能可用
      return this.collaborators.fallbackPaged({ ...params, searchKeyword: undefined })
    }
  }
}
