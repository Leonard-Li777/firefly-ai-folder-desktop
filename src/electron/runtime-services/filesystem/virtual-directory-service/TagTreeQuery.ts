/**
 * TagTreeQuery · 桶出口（barrel）
 *
 * 原 TagTreeQuery.ts（4132 行）按职责边界拆分为多个内聚查询器（只搬不改，逐字节保真）：
 *   - tag-tree-query-shared.ts          模块级共享常量与内部辅助（internal）
 *   - tag-tree-query-path-utils.ts      路径归一化与 LIKE 转义工具（原顶层导出）
 *   - tag-tree-query-adjacency.ts       子树/邻接图查询器
 *   - tag-tree-query-subtree.ts         子树标签 code 解析器
 *   - tag-tree-query-dimension-tree.ts  维度组聚合查询器
 *   - tag-tree-query-filter.ts          文件筛选查询器
 *   - tag-tree-query-search-enrich.ts   混合检索编排与行映射器
 *
 * 本文件保留为聚合出口：承载类实例状态（字段）、构造函数与静态成员，并经
 * Object.assign(TagTreeQuery.prototype, *Mixin) 将各查询器方法挂回主类原型；
 * 类型经同名 TagTreeQuery 接口合并（extends 各 TagTreeQuery* 职责接口）补全，
 * 使静态类型与 Object.assign 运行时挂载一致。外部导入路径与 `new TagTreeQuery(db)`
 * 调用签名零变化（Spec §2.3「移动不改逻辑」第 3 条 barrel 保导出兼容）。
 */
import { FileDao } from '../../database/dao/file-dao'
import Database from 'better-sqlite3'
import { FilteredFilesResponse, SelectedTag, VirtualDirectoryFilter } from '@firefly/types'
import { HybridSearchArbiter } from './HybridSearchArbiter'
import { HybridSearchSession } from './hybrid-search-session'
import { escapeLikePrefixWindows, normalizeCodePath } from './tag-tree-query-path-utils'
import { OMNI_MAP_TTL } from './tag-tree-query-shared'
import { tagTreeQueryAdjacencyMixin } from './tag-tree-query-adjacency'
import { tagTreeQuerySubtreeMixin } from './tag-tree-query-subtree'
import { tagTreeQueryDimensionTreeMixin } from './tag-tree-query-dimension-tree'
import { tagTreeQueryFilterMixin } from './tag-tree-query-filter'
import { tagTreeQuerySearchEnrichMixin } from './tag-tree-query-search-enrich'
import type { TagTreeQueryAdjacency } from './tag-tree-query-adjacency'
import type { TagTreeQuerySubtree } from './tag-tree-query-subtree'
import type { TagTreeQueryDimensionTree } from './tag-tree-query-dimension-tree'
import type { TagTreeQueryFilter } from './tag-tree-query-filter'
import type { TagTreeQuerySearchEnrich } from './tag-tree-query-search-enrich'

// 原顶层导出函数改为 re-export（外部导入契约零变化）
export { escapeLikePrefixWindows, normalizeCodePath }

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
  /** 用户可调语义匹配度阈值（0.25 ~ 0.60，默认 0.35） */
  similarityThreshold?: number
  /** 外部 Skill API 精确等值下推开关（开启后跳过分通道偏移与 [0.25, 0.60] 钳制） */
  exactMinScore?: boolean
  /**
   * 流式检索进度回调。
   *
   * 工单 13：新增 `phase3` —— 冷态 CLIP 第 5 路结果在 phase2 之后异步追加，
   * 语义是「往已渲染列表尾部补新项」，不是又一次全量置换。
   * `clipPending` 仅在 phase2 出现，表示冷态视觉模型正在首次加载（UI 据此展示轻量提示）。
   */
  onProgress?: (
    phase: 'phase1' | 'phase2' | 'phase3',
    response: FilteredFilesResponse & { clipPending?: boolean }
  ) => void
  signal?: AbortSignal
}

/** 混合检索分页引用：已分析候选 / 未分析 FS 命中 */
export type HybridPageRef =
  | { kind: 'analyzed'; fileFingerprint: string; hasLiteral: boolean }
  | { kind: 'unanalyzed'; path: string; name: string; fileFingerprint?: string }

/**
 * TagTreeQuery 深模块
 *
 * 核心职责：
 * 1. 利用 SQLite 递归公共表表达式（Recursive CTE）实现标签树、后代节点与祖先链的瞬时检索；
 * 2. 高效下推文件与复合标签的筛选计算，杜绝在 Node.js 内存中递归拼装扩展名映射；
 * 3. 彻底消除魔法数字区间（102..117），全量依托 file_tags_private 树与 file_tag_relations 自然主键关联。
 */
// ─── 接口合并：将各职责接口并入 TagTreeQuery 类型面，补全跨 mixin 的 this 访问可见性 ───
export interface TagTreeQuery
  extends
    TagTreeQueryAdjacency,
    TagTreeQuerySubtree,
    TagTreeQueryDimensionTree,
    TagTreeQueryFilter,
    TagTreeQuerySearchEnrich {}

export class TagTreeQuery implements TagTreeQuery {
  protected hybridArbiter: HybridSearchArbiter
  protected hybridSession: HybridSearchSession
  /**
   * Omni 受控树的父->子邻接图缓存（跨源 BFS 子孙解析所需）
   * key: parentCode, value: Set<childCode>
   * 懒加载，首次调用 ensureLocalChildrenMap() 时填充本地 file_tags 部分；
   * Omni 受控树边由 buildOmniEdgesFromTree 在获取 treeRes 后追加。
   */
  protected _omniChildrenMap: Map<string, Set<string>> | null = null
  /** _omniChildrenMap 最后一次刷新时间戳（ms），TTL=60s 避免长会话数据陈旧 */
  protected _omniMapLoadedAt = 0
  /** Omni 邻接图缓存 TTL：原为类私有静态字段，拆分后同源引用 shared 单一事实源（数值 60_000 逐字节一致） */
  static readonly OMNI_MAP_TTL = OMNI_MAP_TTL
  /** Omni 受控树边是否已注入当前 _omniChildrenMap（获取 treeRes 后置 true，TTL 过期时随 map 重置为 false） */
  protected _omniEdgesInjected = false
  protected fileDao: FileDao
  /** FTS 正排索引可用性探针缓存（见 isFtsAvailable，adjacency 查询器） */
  protected _ftsAvailable: boolean | null = null
  /** 拼音正排索引可用性探针缓存（见 isPinyinAvailable，adjacency 查询器） */
  protected _pinyinAvailable: boolean | null = null

  constructor(
    protected db: Database.Database,
    hybridArbiter?: HybridSearchArbiter
  ) {
    this.fileDao = new FileDao(db)
    this.ensureSqlFunctions()
    this.hybridArbiter = hybridArbiter ?? new HybridSearchArbiter(db)
    // 混合检索编排（ADR-0039）公开收口：Session 负责编排与回退策略，本类作为数据访问协作者注入
    this.hybridSession = new HybridSearchSession({
      searchHybrid: this.hybridArbiter.searchHybrid.bind(this.hybridArbiter),
      fetchFieldCoverageRefs: params => this.fetchFieldCoverageRefs(params),
      fetchRowsByFingerprints: fps => this.fetchRowsByFingerprints(fps),
      mapFilesToItems: (rows, ws, showMissing) =>
        this.mapFilesToItems(rows, ws, showMissing ?? true),
      fetchContentsForSearch: fps => this.fetchContentsForSearch(fps),
      enrichSearchPage: (kw, refs, cand, contents, descs) =>
        this.enrichSearchPage(kw, refs, cand, contents, descs),
      synthesizeUnanalyzedItem: (ref, ws) => this.synthesizeUnanalyzedItem(ref, ws),
      fallbackPaged: params => this.getFilteredFilesPaged(params),
      fetchVideoCoverageBatch: fps => this.fileDao.getVideoCoverageStatsBatch(fps)
    })
  }
}

// ─── partial-class 原型挂载：将各职责查询器方法挂回 TagTreeQuery.prototype ───
Object.assign(TagTreeQuery.prototype, tagTreeQueryAdjacencyMixin)
Object.assign(TagTreeQuery.prototype, tagTreeQuerySubtreeMixin)
Object.assign(TagTreeQuery.prototype, tagTreeQueryDimensionTreeMixin)
Object.assign(TagTreeQuery.prototype, tagTreeQueryFilterMixin)
Object.assign(TagTreeQuery.prototype, tagTreeQuerySearchEnrichMixin)
