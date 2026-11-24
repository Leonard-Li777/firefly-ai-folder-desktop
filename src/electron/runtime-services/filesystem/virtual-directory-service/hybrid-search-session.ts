import { FileItem, FilteredFilesResponse } from '@firefly/types'
import { LogCategory, logger, normalizeForCache, tokenize, isUsefulToken } from '@firefly/shared'
import { omniClient } from '../../../services/omni-client'
import {
  HybridRankedCandidate,
  HybridRankPool,
  HybridSearchArbiter,
  HybridSearchFailures,
  HYBRID_SEARCH_POOL_SIZE,
  HYBRID_SEARCH_WEIGHTS_WITH_CLIP,
  slicePage,
  weightedRrfScore
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
  /**
   * 字段覆盖补充候选源（LIKE 兜底，非历史遗留）：覆盖 file_contents 压缩 BLOB 与三张 FTS 虚表未索引字段
   * （路径 / 扩展名 / 作者 / 语言 / 文件分类 / 标签物化路径）、trigram 短查询
   * （<3 字符，如中文双字）以及主库未分析行。
   * `failure` 非空表示本次补充查询失败（已降级为空补充集），由本模块按「检索降级」上报。
   */
  fetchFieldCoverageRefs(params: FilterFilesParams): {
    analyzed: Array<Extract<HybridPageRef, { kind: 'analyzed' }>>
    unanalyzed: Array<Extract<HybridPageRef, { kind: 'unanalyzed' }>>
    failure?: string
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
    contentsByFp: Map<string, string>,
    descriptionsByFp?: Map<string, string>
  ): Promise<
    Map<
      string,
      {
        snippet?: string
        matchType: 'exact' | 'fuzzy' | 'semantic'
        similarity?: number
        matchedPinyinCandidate?: string
      }
    >
  >
  /** 由 FS 未分析命中合成 FileItem */
  synthesizeUnanalyzedItem(
    ref: Extract<HybridPageRef, { kind: 'unanalyzed' }>,
    workspaceDirectoryPath?: string
  ): FileItem
  /** 回退路径：去除搜索词的常规分页查询 */
  fallbackPaged(params: FilterFilesParams): Promise<FilteredFilesResponse>
  /** 批量查询视频覆盖度统计 (FIN-05 / FIN-06) */
  fetchVideoCoverageBatch?(
    fileFingerprints: string[]
  ): Map<string, import('@firefly/types').VideoCoverageStats>
}

/**
 * HybridSearchSession 深模块（ADR-0039 / Ticket-2 检索编排公开收口）：
 * 混合检索的分页编排策略在此单点定义 ——
 * 1. 委托仲裁器融合 FTS5 BM25 + Omni 向量 + 文件名提升，真实目录模式追加 FS 未分析命中；
 * 2. 统一有序候选池（仲裁候选 → 字段覆盖补充 → FS 未分析 → 字段覆盖未分析），指纹/路径去重；
 * 3. 按融合顺序分页；当前页已分析候选补充富正文摘要；
 * 4. 任一步骤异常回退为去除搜索词的常规分页，保证搜索功能可用。
 * 字段覆盖补充源的失败按「检索降级」显式上报（warn），不得静默降级。
 * 回退策略是本模块公开接口上的显式行为，可注入 fake 协作者直接测试。
 */
/** 工单 13：phase3 追加的调度器（默认 fire-and-forget；测试注入可等待版本） */
export interface HybridSearchSessionOptions {
  /**
   * phase3 任务调度器。
   *
   * 默认 `void task()` —— phase2 返回后立刻把控制权交还调用方，phase3 结果稍后经 `onProgress` 推流，
   * 保证冷态 CLIP 的 6000ms 等待**绝不**计入 phase2 的 invoke 响应时间。
   * 测试注入捕获版即可确定性等待 phase3 完成，无需 sleep。
   */
  schedulePhase3?: (task: () => Promise<void>) => void
}

export class HybridSearchSession {
  private readonly schedulePhase3: (task: () => Promise<void>) => void

  constructor(
    private collaborators: HybridSearchCollaborators,
    options?: HybridSearchSessionOptions
  ) {
    this.schedulePhase3 = options?.schedulePhase3 ?? (task => void task())
  }

  /**
   * 混合检索分页：按融合候选的统一顺序返回当前页文件与总数。
   * whereClauses/queryParams 由宿主经第 2 参注入（不含 searchKeyword 自身 LIKE 条件）。
   */
  /**
   * 按候选池和字段覆盖补充源生成一页 FileItem
   */
  private async assemblePage(
    params: FilterFilesParams,
    pool: HybridRankPool,
    fieldCoverageRefs: ReturnType<HybridSearchCollaborators['fetchFieldCoverageRefs']>,
    keyword: string,
    limit: number,
    offset: number,
    shouldEnrich: boolean
  ): Promise<{ items: FileItem[]; total: number; dbQueryTime: number }> {
    const workspaceDirectoryPath = params.workspaceDirectoryPath
    let dbQueryTime = 0

    const seenFp = new Set<string>()
    const seenUnanalyzedPath = new Set<string>()
    const fullPool: HybridPageRef[] = []

    // 1. 仲裁候选（已分析）
    // 外部 Skill API 精确等值下推模式：按物理通道判定 eligibility，彻底避免 RRF 融合分切余弦量纲导致的误杀与缺页
    let filterByEligibility = false
    let minScore = 0.55
    let videoMinScore = 0.45
    let effectiveChunkThreshold = 0.45

    if (params.exactMinScore) {
      filterByEligibility = true
      minScore =
        typeof params.similarityThreshold === 'number' && Number.isFinite(params.similarityThreshold)
          ? params.similarityThreshold
          : 0.55
      videoMinScore =
        typeof params.videoMinScore === 'number' && Number.isFinite(params.videoMinScore)
          ? params.videoMinScore
          : 0.45

      // 跨召回源全局上下文锚定判定 (Cross-source Context Anchoring)：
      // 1. 全局或单文件命中字面 (hasLiteral || exactRank > 0 || ftsRank > 0 || pinyinRank > 0)
      // 2. 或工作区存在达到 minScore 的正文文本命中 (topTextVecScore >= minScore)
      // 3. 或纯视频工作区下视频切片具备显著性波峰 (topVideoChunkScore >= 0.50)
      const globalHasLiteral =
        pool.candidates.some(
          c => c.hasLiteral || (c.exactRank && c.exactRank > 0) || (c.ftsRank && c.ftsRank > 0)
        ) ||
        pool.unanalyzedHits.length > 0 ||
        fieldCoverageRefs.analyzed.length > 0 ||
        fieldCoverageRefs.unanalyzed.length > 0

      const textCandidates = pool.candidates.filter(
        c => !c.matchedChunk && !c.matchedChunks?.length && typeof c.vecScore === 'number'
      )
      const topTextVecScore =
        textCandidates.length > 0 ? Math.max(...textCandidates.map(c => c.vecScore!)) : undefined

      const videoCandidatesWithChunks = pool.candidates.filter(
        c => c.matchedChunk?.similarity !== undefined || c.matchedChunks?.[0]?.similarity !== undefined
      )
      const topVideoChunkScore =
        videoCandidatesWithChunks.length > 0
          ? Math.max(
              ...videoCandidatesWithChunks.map(
                c => c.matchedChunk?.similarity ?? c.matchedChunks?.[0]?.similarity ?? 0
              )
            )
          : 0

      const isGloballyAnchored =
        globalHasLiteral ||
        (topTextVecScore !== undefined && topTextVecScore >= minScore) ||
        topVideoChunkScore >= 0.5

      effectiveChunkThreshold = isGloballyAnchored
        ? videoMinScore
        : Math.max(videoMinScore, minScore)
    }

    for (const c of pool.candidates) {
      if (!c.fileFingerprint) continue
      if (seenFp.has(c.fileFingerprint)) continue

      if (filterByEligibility) {
        // 通道 1: exact / fuzzy 直接放行（与 validators bypass 一致）
        const hasLiteralOrFts = Boolean(
          c.hasLiteral ||
          (c.exactRank && c.exactRank > 0) ||
          (c.ftsRank && c.ftsRank > 0) ||
          (c.pinyinRank && c.pinyinRank > 0)
        )
        // 通道 2: clip 视觉通道物理余弦分 >= minScore
        const hasClipMatch = typeof c.clipScore === 'number' && c.clipScore >= minScore
        // 通道 3: semantic 正文文本物理余弦分 >= minScore
        const hasSemanticMatch = typeof c.vecScore === 'number' && c.vecScore >= minScore
        // 通道 4: video_chunk 视频切片物理余弦分 >= effectiveChunkThreshold
        const chunkSim = c.matchedChunk?.similarity ?? c.matchedChunks?.[0]?.similarity
        const hasVideoChunkMatch = typeof chunkSim === 'number' && chunkSim >= effectiveChunkThreshold

        if (!hasLiteralOrFts && !hasClipMatch && !hasSemanticMatch && !hasVideoChunkMatch) {
          continue
        }
      }

      seenFp.add(c.fileFingerprint)
      fullPool.push({
        kind: 'analyzed',
        fileFingerprint: c.fileFingerprint,
        hasLiteral: c.hasLiteral
      })
    }

    // 2. 字段覆盖补充候选（已分析）
    for (const ref of fieldCoverageRefs.analyzed) {
      if (!ref.fileFingerprint || seenFp.has(ref.fileFingerprint)) continue
      seenFp.add(ref.fileFingerprint)
      fullPool.push(ref)
    }

    // 3. FS 实时未分析命中
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

    // 4. 字段覆盖补充源未分析行
    for (const ref of fieldCoverageRefs.unanalyzed) {
      if (ref.fileFingerprint && seenFp.has(ref.fileFingerprint)) continue
      const key = normalizeForCache(ref.path)
      if (seenUnanalyzedPath.has(key)) continue
      seenUnanalyzedPath.add(key)
      fullPool.push(ref)
    }

    const { items: pageRefs, total } = slicePage(fullPool, limit, offset)
    if (pageRefs.length === 0) {
      return { items: [], total, dbQueryTime }
    }

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

    let enrichment = new Map<
      string,
      {
        snippet?: string
        matchType: 'exact' | 'fuzzy' | 'semantic'
        similarity?: number
        matchedPinyinCandidate?: string
      }
    >()
    if (shouldEnrich && analyzedFps.length > 0) {
      const contentStart = performance.now()
      const contentsByFp = this.collaborators.fetchContentsForSearch(analyzedFps)
      const descriptionsByFp = new Map<string, string>()
      for (const [fp, item] of baseItems) {
        if (item.description) descriptionsByFp.set(fp, item.description)
      }
      enrichment = await this.collaborators.enrichSearchPage(
        keyword,
        analyzedRefs,
        candidateByFp,
        contentsByFp,
        descriptionsByFp
      )
      dbQueryTime += performance.now() - contentStart
    }

    // 批量预查当前页视频覆盖度统计 (FIN-05 / FIN-06)
    const videoFingerprints = analyzedRefs
      .filter(ref => {
        const base = baseItems.get(ref.fileFingerprint)
        if (!base) return false
        const ext = (base.extension || '').toLowerCase()
        return (
          ['mp4', 'mkv', 'mov', 'avi', 'flv', 'webm', 'wmv'].includes(ext) ||
          (base as any).category === 'video'
        )
      })
      .map(ref => ref.fileFingerprint)
    const coverageMap = this.collaborators.fetchVideoCoverageBatch
      ? this.collaborators.fetchVideoCoverageBatch(videoFingerprints)
      : new Map<string, import('@firefly/types').VideoCoverageStats>()

    const items: FileItem[] = []
    for (const ref of pageRefs) {
      if (ref.kind === 'analyzed') {
        const base = baseItems.get(ref.fileFingerprint)
        if (!base) continue
        // 未分析行（is_analyzed=0）虽以指纹命中 FTS/补充候选源，仍须按未分析口径展示：
        // 若放行进入语义 enrichment，正文为空会被兜底盖上 'semantic'（且无相似度），
        // 导致未分析视频错误显示「语义召回」徽标并丢失「尚未进行 AI 深度分析」提示
        if (!base.isAnalyzed) {
          items.push({
            ...base,
            isUnanalyzed: true,
            matchType: 'unanalyzed',
            snippet: undefined,
            similarity: undefined,
            matchedChunk: undefined,
            matchedChunks: undefined,
            matchedPinyinCandidate: undefined
          })
          continue
        }
        const e = enrichment.get(ref.fileFingerprint)
        const cand = candidateByFp.get(ref.fileFingerprint)
        const matchedChunk = cand?.matchedChunk
          ? {
              chunkIndex: cand.matchedChunk.chunkIndex,
              startSec: cand.matchedChunk.startSec,
              endSec: cand.matchedChunk.endSec,
              repPtsSec: cand.matchedChunk.repPtsSec,
              seekSec: cand.matchedChunk.seekSec,
              similarity: cand.matchedChunk.similarity
            }
          : undefined
        const matchedChunks =
          cand?.matchedChunks && cand.matchedChunks.length > 0
            ? cand.matchedChunks.map(c => ({
                chunkIndex: c.chunkIndex,
                startSec: c.startSec,
                endSec: c.endSec,
                repPtsSec: c.repPtsSec,
                seekSec: c.seekSec,
                similarity: c.similarity
              }))
            : undefined
        items.push({
          ...base,
          snippet: e?.snippet,
          matchType: matchedChunk
            ? 'semantic'
            : (e?.matchType ?? (ref.hasLiteral ? 'fuzzy' : 'semantic')),
          similarity: matchedChunk?.similarity ?? e?.similarity ?? cand?.vecScore,
          matchedChunk,
          matchedChunks,
          matchedPinyinCandidate: e?.matchedPinyinCandidate
        })
      } else {
        items.push(this.collaborators.synthesizeUnanalyzedItem(ref, workspaceDirectoryPath))
      }
    }

    return { items, total, dbQueryTime }
  }

  /**
   * 混合检索分页：按融合候选的统一顺序返回当前页文件与总数。
   * whereClauses/queryParams 由宿主经第 2 参注入（不含 searchKeyword 自身 LIKE 条件）。
   */
  async runPaged(
    params: FilterFilesParams,
    keyword: string,
    where: { whereClauses: string[]; queryParams: unknown[] }
  ): Promise<FilteredFilesResponse & { clipPending?: boolean }> {
    const startTime = performance.now()
    let dbQueryTime = 0
    try {
      const workspaceDirectoryPath = params.workspaceDirectoryPath

      const limit =
        params.limit !== undefined ? Math.max(0, params.limit) : Math.max(1, params.pageSize ?? 100)
      const offset =
        params.offset !== undefined
          ? Math.max(0, params.offset)
          : Math.max(0, ((params.page ?? 1) - 1) * limit)

      // 字段覆盖补充候选源（LIKE 兜底）提前查询
      if (params.signal?.aborted) {
        return { total: 0, items: [] }
      }
      const fieldCoverageRefs = this.collaborators.fetchFieldCoverageRefs(params)
      if (fieldCoverageRefs.failure) {
        logger.warn(
          LogCategory.VIRTUAL_DIRECTORY,
          '[HybridSearchSession] 字段覆盖补充候选源降级（FTS 未索引字段与短查询可能漏召回）:',
          fieldCoverageRefs.failure
        )
      }

      // Phase 1 流式快速回调：字面三路就绪时立即推送首屏（<= 100 项，不执行耗时段落对齐）
      let phase2Dispatched = false
      const onPhase1 = params.onProgress
        ? async (p1Pool: HybridRankPool) => {
            if (phase2Dispatched) return
            try {
              const p1 = await this.assemblePage(
                params,
                p1Pool,
                fieldCoverageRefs,
                keyword,
                Math.min(100, limit),
                0,
                false
              )
              if (phase2Dispatched) return
              params.onProgress!('phase1', {
                items: p1.items,
                total: p1.total,
                performance: {
                  dbQueryTime: Math.round(p1.dbQueryTime * 100) / 100,
                  totalTime: Math.round((performance.now() - startTime) * 100) / 100
                }
              })
            } catch (p1Err) {
              logger.warn(
                LogCategory.VIRTUAL_DIRECTORY,
                '[HybridSearchSession] Phase 1 推流异常:',
                p1Err
              )
            }
          }
        : undefined

      // 1. 仲裁融合（FTS + 向量 + 文件名；传入 onPhase1 支持双阶段）
      const pool = await this.collaborators.searchHybrid(
        {
          keyword,
          whereClauses: where.whereClauses,
          queryParams: where.queryParams,
          workspaceDirectoryPath,
          poolSize: HYBRID_SEARCH_POOL_SIZE,
          similarityThreshold: params.similarityThreshold,
          exactMinScore: params.exactMinScore,
          videoMinScore: params.videoMinScore
        },
        onPhase1
      )

      if (pool.failures.fts || pool.failures.vector || pool.failures.fs || pool.failures.clip) {
        logger.debug(
          LogCategory.VIRTUAL_DIRECTORY,
          `[HybridSearchSession] 混合检索部分降级: fts=${pool.failures.fts}, vector=${pool.failures.vector}, ` +
            `fs=${pool.failures.fs}, clip=${pool.failures.clip}`
        )
      }

      if (params.signal?.aborted) {
        return { total: 0, items: [] }
      }

      // Phase 2: 全量加权 RRF 页面构建与富摘要丰富
      const p2 = await this.assemblePage(
        params,
        pool,
        fieldCoverageRefs,
        keyword,
        limit,
        offset,
        true
      )
      dbQueryTime += p2.dbQueryTime

      let searchTokens: string[] = []
      try {
        const omniTokens = await omniClient.tokenizeText(keyword)
        const localTokens = tokenize(keyword).filter(isUsefulToken)
        searchTokens = Array.from(new Set([keyword, ...omniTokens, ...localTokens]))
      } catch {
        searchTokens = Array.from(new Set([keyword, ...tokenize(keyword)])).filter(isUsefulToken)
      }

      const finalResponse: FilteredFilesResponse = {
        items: p2.items,
        total: p2.total,
        tokens: searchTokens,
        performance: {
          dbQueryTime: Math.round(dbQueryTime * 100) / 100,
          totalTime: Math.round((performance.now() - startTime) * 100) / 100
        }
      }

      if (params.onProgress) {
        phase2Dispatched = true
        // 工单 13：冷态第 5 路尚未并入 phase2 ⇒ 打上 clipPending 标记，UI 据此展示「视觉模型首次加载中」提示。
        // 热态（pendingClip 不存在）不带该字段，UI 不会闪一次多余提示。
        params.onProgress(
          'phase2',
          pool.pendingClip ? { ...finalResponse, clipPending: true } : finalResponse
        )
      }

      // 工单 13：冷态 CLIP 结果作为 phase3 追加。
      // 关键点：**不 await** —— phase2 的 invoke 响应必须立刻返回，6000ms 的模型加载只影响稍后的追加。
      if (params.onProgress && pool.pendingClip) {
        this.schedulePhase3(() =>
          this.dispatchPhase3({
            params,
            pending: pool.pendingClip!,
            keyword,
            limit,
            baseTotal: finalResponse.total,
            failures: pool.failures
          })
        )
      }

      return pool.pendingClip ? { ...finalResponse, clipPending: true } : finalResponse
    } catch (err: unknown) {
      logger.error(
        LogCategory.VIRTUAL_DIRECTORY,
        '[HybridSearchSession] 混合检索分页失败，回退常规检索:',
        err
      )
      return this.collaborators.fallbackPaged({ ...params, searchKeyword: undefined })
    }
  }

  /**
   * 工单 13：把冷态 CLIP 第 5 路的结果作为 **phase3 追加** 推流。
   *
   * 语义边界（不可越界）：
   * - **只追加**：不重排、不清空、不改 searchPhase；调用方按 `path` 去重，已在列表里的项不会重复出现；
   * - **不新增排序逻辑**：仍然复用 `assemblePage` + 既有加权 RRF（第 5 路 rank 已在仲裁器内算好），
   *   本方法只是把「CLIP 命中指纹」重新走一遍既有的分页装配；
   * - **不带字段覆盖补充源**：那批候选在 phase1/phase2 已全量参与过，再带一次会把同一批条目重复追加；
   * - 失败/熔断/空命中一律静默结束（本路是可选增强，不得让 UI 报错）。
   */
  private async dispatchPhase3(opts: {
    params: FilterFilesParams
    pending: NonNullable<HybridRankPool['pendingClip']>
    keyword: string
    limit: number
    baseTotal: number
    failures: HybridSearchFailures
  }): Promise<void> {
    const { params, pending, keyword, limit, baseTotal, failures } = opts
    // phase3 独立计时：`totalTime` 是延迟埋点字段，写死 0 等同于伪造度量值。
    // 语义 = **本次 phase3 自身的耗时**（含等待 `pending` 的 CLIP 等待），不是整条检索的累计耗时；
    // phase1/phase2 各有自己的 `totalTime`，下游不得跨 phase 相加或相减。
    const phase3StartedAt = Date.now()
    try {
      const hits = await pending
      if (!hits || hits.length === 0) return

      // 仅以 CLIP 命中构建迷你池：候选顺序即 CLIP 相似度顺序（已由仲裁器排好并重编号）
      const miniPool: HybridRankPool = {
        candidates: hits.map(h => ({
          fileFingerprint: h.fileFingerprint,
          clipRank: h.rank,
          clipScore: h.score,
          nameBoost: 0,
          score: weightedRrfScore({ clipRank: h.rank }, HYBRID_SEARCH_WEIGHTS_WITH_CLIP),
          hasLiteral: false
        })),
        unanalyzedHits: [],
        failures,
        total: hits.length
      }

      const page = await this.assemblePage(
        params,
        miniPool,
        { analyzed: [], unanalyzed: [] },
        keyword,
        Math.max(0, limit),
        0,
        true
      )
      if (page.items.length === 0) return

      params.onProgress!('phase3', {
        items: page.items,
        total: baseTotal + page.items.length,
        performance: {
          dbQueryTime: Math.round(page.dbQueryTime * 100) / 100,
          totalTime: Date.now() - phase3StartedAt
        }
      })
    } catch (err: unknown) {
      logger.warn(
        LogCategory.VIRTUAL_DIRECTORY,
        '[HybridSearchSession] phase3 追加失败（忽略，不影响已渲染列表）:',
        err
      )
    }
  }
}
