/**
 * Omni 服务化客户端 SDK（ADR-0038 / PRD #679 / Issue #682）
 * apps/desktop/src/electron/services/omni-client.ts
 *
 * 职责：
 * 1. 消费 Omni 暴露的高阶业务 HTTP API（taxonomy / vector）
 * 2. 屏蔽 Desktop 对 OMW 底层 SQLite 与 file_vectors 堆表的直接依赖
 * 3. 供 TaxonomyAliasCache、虚拟目录渲染与分析向量链路统一调用
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
  children: OmniTaxonomyNode[]
}

/** 分类树响应 */
export interface OmniTaxonomyTreeResponse {
  locale: string
  rootNodes: OmniTaxonomyNode[]
  totalNodes: number
}

/** 多语言别名响应 */
export interface OmniTaxonomyAliasesResponse {
  locale: string
  aliases: Record<string, string[]>
  canonicalNames: Record<string, string>
  totalTags: number
}

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

  private async request<T>(
    path: string,
    init?: RequestInit,
    timeoutMs: number = DEFAULT_TIMEOUT_MS
  ): Promise<T | null> {
    try {
      await omniService.ensureRunning()
      const res = await fetch(`${this.getBaseUrl()}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(init?.headers || {})
        },
        signal: AbortSignal.timeout(timeoutMs)
      })
      if (!res.ok) {
        logger.warn(LogCategory.SYSTEM, `[OmniClient] HTTP ${res.status} ${path}`)
        return null
      }
      return (await res.json()) as T
    } catch (err: any) {
      logger.debug(LogCategory.SYSTEM, `[OmniClient] 请求失败 ${path}:`, err?.message)
      return null
    }
  }

  /**
   * 拉取分类树：GET /api/v1/taxonomy/tree?locale={lang}
   * 供虚拟目录标签树渲染消费
   */
  async getTaxonomyTree(locale = 'zh-CN', root?: string): Promise<OmniTaxonomyTreeResponse | null> {
    const params = new URLSearchParams({ locale })
    if (root) params.set('root', root)
    return this.request<OmniTaxonomyTreeResponse>(`/api/v1/taxonomy/tree?${params.toString()}`)
  }

  /**
   * 拉取多语言别名字典：GET /api/v1/taxonomy/aliases?locale={lang}
   * 供 TaxonomyAliasCache 进程内存总线装载
   */
  async getTaxonomyAliases(locale = 'zh-CN'): Promise<OmniTaxonomyAliasesResponse | null> {
    return this.request<OmniTaxonomyAliasesResponse>(
      `/api/v1/taxonomy/aliases?locale=${encodeURIComponent(locale)}`
    )
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
}

export const omniClient = OmniClient.getInstance()
