/**
 * Omni 服务化客户端 SDK（ADR-0038 / PRD #679 / Issue #682）
 * apps/desktop/src/electron/services/omni-client.ts
 *
 * 职责：
 * 1. 消费 Omni 暴露的高阶业务 HTTP API（taxonomy / vector）
 * 2. 屏蔽 Desktop 对 OMW 底层 SQLite 与 file_vectors 堆表的直接依赖
 * 3. 供主库语言分表 tag_aliases_{lang} 初值补录、虚拟目录渲染与分析向量链路统一调用
 *    （TaxonomyAliasCache 内存总线已按主设计废除，展示别名一律分表直查）
 */

import { LogCategory, logger } from '@firefly/shared'
import { omniService } from '../runtime-services/system/omni-service'

/** 分类树多叉树节点（对齐 Omni taxonomy.rs TaxonomyNode） */
export interface OmniTaxonomyNode {
  code: string
  name: string
  parentCode?: string | null
  parentCodes: string[]
  source: string
  sortOrder: number
  fileCount?: number
  files?: string[]
  codePath?: string
  namePath?: string
  depth?: number
  children: OmniTaxonomyNode[]
}

/** 分类树响应 */
export interface OmniTaxonomyTreeResponse {
  locale: string
  rootNodes: OmniTaxonomyNode[]
  totalNodes: number
}

/** 多语言别名单行（对齐 Rust TagAliasRow：snake_case；is_canonical 为 INTEGER 0/1） */
export interface OmniTagAliasRow {
  tag_code: string
  lemma: string
  is_canonical: number
  n: number
  count: number
}

/** 多语言别名响应：Vec<TagAliasRow>（对齐 Rust Vec<TagAliasRow>，Slice 7） */
export type OmniTaxonomyAliasesResponse = OmniTagAliasRow[]

/** 向量写入条目 */
export interface OmniVectorUpsertItem {
  fileFingerprint: string
  vector: number[]
}

export interface OmniVectorUpsertResponse {
  success: boolean
  count: number
  error?: string
}

export interface OmniVectorMatchItem {
  fileFingerprint: string
  score: number
  rank: number
}

export interface OmniVectorSearchResponse {
  matches: OmniVectorMatchItem[]
  durationUs: number
  count: number
  error?: string
}

export interface OmniVectorDeleteResponse {
  success: boolean
  deletedCount: number
  error?: string
}

/** 真实目录快速文件名检索命中项 */
export interface OmniSearchFsItem {
  path: string
  name: string
  fileFingerprint?: string | null
  isAnalyzed?: boolean
}

/** 真实目录快速文件名检索响应 */
export interface OmniSearchFsResponse {
  items: OmniSearchFsItem[]
  count: number
  durationMs: number
}

/** 段落级语义对齐请求项 */
export interface OmniMatchPassagesItem {
  fileFingerprint: string
  passages: string[]
}

/** 段落级语义对齐匹配结果 */
export interface OmniPassageMatch {
  fileFingerprint: string
  bestPassageIndex: number
  bestPassage: string
  similarity: number
}

/** 段落级语义对齐响应 */
export interface OmniMatchPassagesResponse {
  matches: OmniPassageMatch[]
  durationMs: number
}

const DEFAULT_TIMEOUT_MS = 8000

/**
 * OmniClient：Desktop 侧对 Omni 语义/向量 HTTP 契约的唯一入口
 */
export class OmniClient {
  private static instance: OmniClient

  static getInstance(): OmniClient {
    if (!OmniClient.instance) {
      OmniClient.instance = new OmniClient()
    }
    return OmniClient.instance
  }

  /** 解析当前 Omni 服务基址（随 omni-service 端口探测同步） */
  getBaseUrl(): string {
    return omniService.getBaseUrl()
  }

  private static readonly TAXONOMY_CACHE_TTL = 10_000 // 10秒TTL（防组件多重挂载并发重复请求，同时保证文件分析入库后敏捷刷新）
  private _taxonomyTreeCache = new Map<string, { data: OmniTaxonomyTreeResponse; time: number }>()

  private async request<T>(
    path: string,
    init?: RequestInit,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
    retries: number = 2
  ): Promise<T | null> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await omniService.ensureRunning()
        const res = await fetch(`${this.getBaseUrl()}${path}`, {
          ...init,
          headers: {
            'Content-Type': 'application/json',
            ...(init?.headers ?? {})
          },
          signal: AbortSignal.timeout(timeoutMs)
        })
        if (!res.ok) {
          logger.warn(LogCategory.DIMENSION_SERVICE, `[OmniClient] HTTP ${res.status} ${path} (第 ${attempt + 1}/${retries + 1} 次尝试)`)
          if (attempt < retries) {
            await new Promise(r => setTimeout(r, 400 * (attempt + 1)))
            continue
          }
          return null
        }
        return (await res.json()) as T
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        logger.debug(LogCategory.DIMENSION_SERVICE, `[OmniClient] 请求失败 ${path} (第 ${attempt + 1}/${retries + 1} 次尝试):`, msg)
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 400 * (attempt + 1)))
          continue
        }
        return null
      }
    }
    return null
  }

  /** 清除分类树内存缓存（文件分析入库后或强制刷新时调用） */
  clearTaxonomyTreeCache(): void {
    this._taxonomyTreeCache.clear()
  }

  /**
   * 拉取分类树：GET /api/v1/taxonomy/tree?locale={lang}&db_path={dbPath}
   * 供虚拟目录标签树渲染消费（内置 5 分钟轻量内存缓存与网络抖动过期降级兜底）
   * @param locale 语言代码，如 zh-CN
   * @param root 可选限定子树根 code
   * @param dbPath 主数据库路径，供 Omni 挂载只读关联
   * @param options 可选作用域过滤参数（workspaceId / directoryPrefix / includeFiles）
   */
  async getTaxonomyTree(
    locale = 'zh-CN',
    root?: string,
    dbPath?: string,
    options?: { workspaceId?: number | string; directoryPrefix?: string; includeFiles?: boolean }
  ): Promise<OmniTaxonomyTreeResponse | null> {
    const wsPart = options?.workspaceId !== undefined && options?.workspaceId !== null ? String(options.workspaceId) : ''
    const dirPart = options?.directoryPrefix || ''
    const incPart = options?.includeFiles ? '1' : '0'
    const cacheKey = `${locale}::${root || ''}::${dbPath || ''}::${wsPart}::${dirPart}::${incPart}`
    const cached = this._taxonomyTreeCache.get(cacheKey)
    if (cached && Date.now() - cached.time < OmniClient.TAXONOMY_CACHE_TTL) {
      return cached.data
    }
    const params = new URLSearchParams({ locale })
    if (root) params.set('root', root)
    if (dbPath) {
      params.set('dbPath', dbPath)
      params.set('db_path', dbPath)
    }
    if (wsPart) {
      params.set('workspace_id', wsPart)
    }
    if (dirPart) {
      params.set('directory_prefix', dirPart)
    }
    if (options?.includeFiles) {
      params.set('include_files', 'true')
    }
    const res = await this.request<OmniTaxonomyTreeResponse>(`/api/v1/taxonomy/tree?${params.toString()}`)
    if (res && res.rootNodes && res.rootNodes.length > 0) {
      this._taxonomyTreeCache.set(cacheKey, { data: res, time: Date.now() })
      return res
    }
    // 降级兜底：若网络请求偶发失败但存在历史缓存，优先使用历史缓存，杜绝受控维度根坍塌
    if (cached) {
      logger.warn(LogCategory.DIMENSION_SERVICE, `[OmniClient] getTaxonomyTree 请求失败，降级使用历史缓存数据`)
      return cached.data
    }
    return res
  }

  /**
   * 拉取多语言别名行：GET /api/v1/taxonomy/aliases?locale={lang}&source={source}&codes={codes}
   * 供主库语言分表初值写入（Fix-01 首建拉全集 / Fix-02 切语言 codes= 补漏）。
   * @param locale 语言区域代码，如 zh-CN
   * @param options.source 受控 source 列表（逗号分隔，如 'tag,dimension'），仅返回 file_tags.source 命中的行
   * @param options.codes 精确 tag_code 列表（内部自动逗号拼接），未命中 code 不出行
   * @param options.prefix 兼容保留的旧前缀过滤（builtin / omw）
   */
  async getTaxonomyAliases(
    locale = 'zh-CN',
    options?: { source?: string; codes?: string[]; prefix?: string }
  ): Promise<OmniTagAliasRow[] | null> {
    const params = new URLSearchParams({ locale })
    if (options?.source) params.set('source', options.source)
    if (options?.codes?.length) params.set('codes', options.codes.join(','))
    if (options?.prefix) params.set('prefix', options.prefix)
    return this.request<OmniTagAliasRow[]>(`/api/v1/taxonomy/aliases?${params.toString()}`)
  }

  /**
   * 向量批量写入/更新：POST /api/v1/vector/upsert
   * AI 分析提取 dense embedding 后由 Desktop 调用，向量由 Omni zvec 托管
   */
  async upsertVectors(
    items: OmniVectorUpsertItem[],
    timeoutMs = 15000
  ): Promise<OmniVectorUpsertResponse | null> {
    if (!items.length) return { success: true, count: 0 }
    const payload = {
      items: items.map(item => ({
        fileFingerprint: item.fileFingerprint,
        vector: item.vector
      }))
    }
    return this.request<OmniVectorUpsertResponse>('/api/v1/vector/upsert', {
      method: 'POST',
      body: JSON.stringify(payload)
    }, timeoutMs)
  }

  /** 便捷写入单文件向量 */
  async upsertVector(fileFingerprint: string, vector: number[]): Promise<OmniVectorUpsertResponse | null> {
    return this.upsertVectors([{ fileFingerprint, vector }])
  }

  /**
   * 以向量搜文件：POST /api/v1/vector/search
   * 以文搜图、搜文档、相似文件推荐统一入口
   */
  async searchVectors(
    vector: number[],
    topK = 10,
    threshold?: number
  ): Promise<OmniVectorSearchResponse | null> {
    return this.request<OmniVectorSearchResponse>('/api/v1/vector/search', {
      method: 'POST',
      body: JSON.stringify({
        vector,
        topK,
        threshold
      })
    })
  }

  /** 批量删除向量：DELETE /api/v1/vector/delete */
  async deleteVectors(fileFingerprints: string[]): Promise<OmniVectorDeleteResponse | null> {
    if (!fileFingerprints.length) return { success: true, deletedCount: 0 }
    return this.request<OmniVectorDeleteResponse>('/api/v1/vector/delete', {
      method: 'DELETE',
      body: JSON.stringify({ fileFingerprints })
    })
  }

  /**
   * 真实目录快速文件名检索：GET /api/v1/search/fs?dir={dir}&q={q}&limit={limit}
   * 由 Omni 内在 walker 直接扫描磁盘目录返回实时命中（含未 AI 分析文件），
   * 结果中带 fileFingerprint 的项即为已分析文件，可与向量/FTS 候选去重
   */
  async searchFastFs(
    dir: string,
    query: string,
    limit = 100
  ): Promise<OmniSearchFsResponse | null> {
    const params = new URLSearchParams({ dir: dir, q: query, limit: String(limit) })
    return this.request<OmniSearchFsResponse>(`/api/v1/search/fs?${params.toString()}`)
  }

  /**
   * 段落级语义对齐：POST /api/v1/vector/match-passages
   * 将查询向量与候选文件的前置分段列表对齐，返回每文件最契合段落与相似度，
   * 用于对无字面命中候选生成语义召回摘要
   */
  async matchPassages(
    query: string,
    items: OmniMatchPassagesItem[]
  ): Promise<OmniMatchPassagesResponse | null> {
    if (!items.length) return { matches: [], durationMs: 0 }
    return this.request<OmniMatchPassagesResponse>('/api/v1/vector/match-passages', {
      method: 'POST',
      body: JSON.stringify({ query, items })
    })
  }
}

export const omniClient = OmniClient.getInstance()
