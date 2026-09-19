/**
 * TaxonomyAliasCache — 多语言别名与分类树内存总线（ADR-0038 / Issue #682）
 * apps/desktop/src/electron/services/taxonomy-alias-cache.ts
 *
 * 职责：
 * 1. 启动/切换语言时从 Omni GET /api/v1/taxonomy/aliases 拉取全量别名字典
 * 2. 以进程内存 Map 提供微秒级标签展示名解析（零 SQL、零 IPC）
 * 3. 缓存 Omni taxonomy/tree，供虚拟目录与维度映射消费
 */

import { LogCategory, logger } from '@firefly/shared'
import type { DimensionGroup, DimensionTag } from '@firefly/types'
import type { DimensionMetadata } from '@firefly/types'
import {
  omniClient,
  type OmniTaxonomyNode,
  type OmniTaxonomyTreeResponse
} from './omni-client'

/**
 * 多语言别名 + 分类树内存缓存
 */
export class TaxonomyAliasCache {
  private static instance: TaxonomyAliasCache

  /** tag_code -> 当前语言展示名（canonical） */
  private aliasMap = new Map<string, string>()
  /** 当前已装载语言 */
  private locale = ''
  /** 是否已成功装载 */
  private loaded = false
  /** 最近一次拉取的分类树 */
  private tree: OmniTaxonomyTreeResponse | null = null

  static getInstance(): TaxonomyAliasCache {
    if (!TaxonomyAliasCache.instance) {
      TaxonomyAliasCache.instance = new TaxonomyAliasCache()
    }
    return TaxonomyAliasCache.instance
  }

  getLocale(): string {
    return this.locale
  }

  isLoaded(): boolean {
    return this.loaded
  }

  size(): number {
    return this.aliasMap.size
  }

  /**
   * 装载/刷新别名字典与分类树
   * 应用启动与用户切换语言时调用
   */
  async load(locale: string): Promise<void> {
    const target = locale || 'zh-CN'
    try {
      const [aliasesRes, treeRes] = await Promise.all([
        omniClient.getTaxonomyAliases(target),
        omniClient.getTaxonomyTree(target)
      ])

      const next = new Map<string, string>()
      if (aliasesRes?.canonicalNames) {
        for (const [code, lemma] of Object.entries(aliasesRes.canonicalNames)) {
          if (typeof lemma === 'string' && lemma) next.set(code, lemma)
        }
      }
      // aliases 兜底：canonical 缺失时取候选首位
      if (aliasesRes?.aliases) {
        for (const [code, list] of Object.entries(aliasesRes.aliases)) {
          if (!next.has(code) && Array.isArray(list) && list[0]) {
            next.set(code, list[0])
          }
        }
      }

      // 分类树节点名也可作为展示名兜底
      if (treeRes?.rootNodes) {
        this.walkTree(treeRes.rootNodes, node => {
          if (node.name && !next.has(node.code)) next.set(node.code, node.name)
        })
      }

      this.aliasMap = next
      this.tree = treeRes
      this.locale = target
      this.loaded = next.size > 0 || !!treeRes
      logger.info(
        LogCategory.DIMENSION_SERVICE,
        `[TaxonomyAliasCache] 已装载 locale=${target} aliases=${next.size} treeNodes=${treeRes?.totalNodes ?? 0}`
      )
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      logger.warn(LogCategory.DIMENSION_SERVICE, '[TaxonomyAliasCache] 装载失败:', msg)
      // 保留旧映射，避免语言切换过程中展示名闪空
      this.locale = target
    }
  }

  /**
   * 内存直查展示名（微秒级）
   * @returns 命中别名返回别名，未命中返回 undefined
   */
  resolve(code: string): string | undefined {
    if (!code) return undefined
    return this.aliasMap.get(code)
  }

  /**
   * 批量解析；未命中的 code 以 code 本身兜底
   */
  resolveMany(codes: string[], fallback?: (code: string) => string | undefined): Record<string, string> {
    const result: Record<string, string> = {}
    if (!codes?.length) return result
    for (const code of codes) {
      const hit = this.aliasMap.get(code)
      if (hit) {
        result[code] = hit
        continue
      }
      const fb = fallback?.(code)
      result[code] = fb ?? code
    }
    return result
  }

  /** 获取缓存中的分类树 */
  getTree(): OmniTaxonomyTreeResponse | null {
    return this.tree
  }

  /**
   * 将 Omni 分类树转换为前端 DimensionGroup[]
   * 同时合并本地 file_tags 中的动态标签计数
   */
  toDimensionGroups(countByCode?: Map<string, number>): DimensionGroup[] {
    if (!this.tree?.rootNodes?.length) return []
    const groups: DimensionGroup[] = []
    let legacyId = 1
    for (const root of this.tree.rootNodes) {
      const numMatch = root.code.match(/^dim\.(\d+)$/)
      const id = numMatch ? parseInt(numMatch[1], 10) : legacyId
      legacyId = Math.max(legacyId, id + 1)

      const tags: DimensionTag[] = []
      const collect = (node: OmniTaxonomyNode, parentCode: string, level: number) => {
        for (const child of node.children || []) {
          const code = child.code
          const count = countByCode?.get(code) ?? 0
          tags.push({
            // 兼容前端数字 ID 索引，并挂载自然主键 dimensionCode
            dimensionId: id,
            dimensionCode: root.code,
            dimensionName: this.aliasMap.get(root.code) || root.name,
            tagValue: this.aliasMap.get(code) || child.name,
            fileCount: count,
            level,
            code,
            parentCode: parentCode || root.code,
            isMultiSelect: false
          })
          collect(child, code, level + 1)
        }
      }
      collect(root, root.code, 1)

      // DimensionMetadata 的 flag 字段包含 source 等扩展标记与 order
      const orderVal =
        typeof root.sortOrder === 'number' && root.sortOrder > 0 ? root.sortOrder : undefined
      const dimensionMeta: DimensionMetadata = {
        source: root.source || 'builtin',
        ...(orderVal !== undefined ? { order: orderVal } : {})
      }

      groups.push({
        id,
        name: this.aliasMap.get(root.code) || root.name,
        level: 0,
        tags,
        code: root.code,
        order: orderVal,
        isMultiSelect: false,
        meta: dimensionMeta,
        metadata: dimensionMeta
      })
    }
    return groups
  }

  /**
   * 供 ConfigDbManager.getFileDimensions 消费的维度结构（来自 Omni 树）
   */
  toFileDimensions(): Array<{
    id: number
    code: string
    name: string
    level: number
    tags: string[]
    description?: string
    applicable_file_types: string[]
    context_hints: string[]
    meta: DimensionMetadata
  }> {
    if (!this.tree?.rootNodes?.length) return []
    return this.tree.rootNodes.map((root, idx) => {
      const childTags: string[] = []
      const walk = (node: OmniTaxonomyNode) => {
        for (const child of node.children || []) {
          childTags.push(this.aliasMap.get(child.code) || child.name)
        }
      }
      walk(root)
      return {
        id: idx + 1,
        code: root.code,
        name: this.aliasMap.get(root.code) || root.name,
        level: 1,
        tags: childTags,
        description: undefined,
        applicable_file_types: [],
        context_hints: [],
        meta: { source: root.source || 'builtin' } satisfies DimensionMetadata
      }
    })
  }

  /** 清空缓存（测试与重置场景） */
  clear(): void {
    this.aliasMap.clear()
    this.tree = null
    this.locale = ''
    this.loaded = false
  }

  /** 测试注入：直接写入别名映射 */
  primeForTest(locale: string, map: Record<string, string>, tree?: OmniTaxonomyTreeResponse | null): void {
    this.aliasMap = new Map(Object.entries(map))
    this.locale = locale
    this.tree = tree ?? null
    this.loaded = true
  }

  private walkTree(nodes: OmniTaxonomyNode[], visit: (n: OmniTaxonomyNode) => void): void {
    for (const n of nodes || []) {
      visit(n)
      if (n.children?.length) this.walkTree(n.children, visit)
    }
  }
}

export const taxonomyAliasCache = TaxonomyAliasCache.getInstance()
