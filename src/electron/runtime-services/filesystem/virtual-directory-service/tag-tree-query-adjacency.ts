/**
 * TagTreeQuery · 子树/邻接图查询器（partial-class 混入）
 *
 * 拆分自原 TagTreeQuery.ts（只搬不改，逐字节保真）。承载职责：
 * 1. 跨源父->子邻接图构建（本地 file_tags_private + Omni 受控树）；
 * 2. FTS / 拼音正排索引可用性探针；
 * 3. 指定标签节点的子孙 codes 召回（code_path 前缀扫描 / DAG 递归）。
 *
 * 运行时经 Object.assign(TagTreeQuery.prototype, tagTreeQueryAdjacencyMixin) 挂回主类；
 * 类型通过 TagTreeQueryAdjacency 接口并入 TagTreeQuery，外部导入路径与调用签名零变化。
 */
import { LogCategory, logger } from '@firefly/shared'
import { omniClient } from '../../../services/omni-client'
import type { OmniTaxonomyNode } from '../../../services/omni-client'
import { CONTENT_TAGS_CODE, OMNI_MAP_TTL } from './tag-tree-query-shared'
import { loadIgnoreRules, shouldIgnoreFile } from '../../analysis/analysis-ignore-service'
import type { TagTreeQuery } from './TagTreeQuery'

export interface TagTreeQueryAdjacency {
  ensureFullChildrenMap(locale?: string): Promise<Map<string, Set<string>>>

  yieldToEventLoop(): Promise<void>

  ensureLocalChildrenMap(): Map<string, Set<string>>

  buildOmniEdgesFromTree(rootNodes: OmniTaxonomyNode[]): void

  collectOmniDescendantsSync(codeOrName: string, map: Map<string, Set<string>>): Set<string>

  ensureSqlFunctions(): void

  isFtsAvailable(): boolean

  isPinyinAvailable(): boolean

  getDescendantTagCodes(tagValueOrCode: string): string[]
}

export const tagTreeQueryAdjacencyMixin = {
  async ensureFullChildrenMap(locale = 'zh-CN'): Promise<Map<string, Set<string>>> {
    const now = Date.now()
    if (
      this._omniChildrenMap &&
      this._omniEdgesInjected &&
      now - this._omniMapLoadedAt < OMNI_MAP_TTL
    ) {
      return this._omniChildrenMap
    }

    const map = new Map<string, Set<string>>()
    const addEdge = (parent: string, child: string) => {
      if (!parent || !child || parent === child) return
      if (!map.has(parent)) map.set(parent, new Set())
      map.get(parent)!.add(child)
    }

    // 1. 本地 file_tags_private 的 parent_codes 关系
    try {
      const rows = this.db
        .prepare('SELECT code, parent_codes FROM file_tags_private')
        .all() as Array<{
        code: string
        parent_codes: string
      }>
      for (const row of rows) {
        let parents: string[] = []
        try {
          parents = JSON.parse(row.parent_codes || '[]')
        } catch {
          parents = []
        }
        if (parents.length === 0) {
          addEdge(CONTENT_TAGS_CODE, row.code)
        } else {
          for (const p of parents) {
            addEdge(p, row.code)
          }
        }
      }
    } catch (err) {
      logger.warn(
        LogCategory.VIRTUAL_DIRECTORY,
        '[TagTreeQuery] ensureFullChildrenMap: file_tags_private parent_codes 加载失败:',
        err
      )
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
      logger.warn(
        LogCategory.VIRTUAL_DIRECTORY,
        '[TagTreeQuery] ensureFullChildrenMap: Omni 树边加载失败:',
        err
      )
    }

    this._omniChildrenMap = map
    this._omniMapLoadedAt = now
    return map
  },

  yieldToEventLoop(): Promise<void> {
    return new Promise(resolve => setImmediate(resolve))
  },

  ensureLocalChildrenMap(): Map<string, Set<string>> {
    const now = Date.now()
    if (this._omniChildrenMap && now - this._omniMapLoadedAt < OMNI_MAP_TTL) {
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
        .prepare('SELECT code, parent_codes FROM file_tags_private')
        .all() as Array<{
        code: string
        parent_codes: string
      }>
      for (const row of rows) {
        let parents: string[] = []
        try {
          parents = JSON.parse(row.parent_codes || '[]')
        } catch {
          parents = []
        }
        if (parents.length === 0) {
          addEdge(CONTENT_TAGS_CODE, row.code)
        } else {
          for (const p of parents) {
            addEdge(p, row.code)
          }
        }
      }
    } catch (err) {
      logger.warn(
        LogCategory.VIRTUAL_DIRECTORY,
        '[TagTreeQuery] ensureLocalChildrenMap: file_tags_private parent_codes 加载失败:',
        err
      )
    }

    this._omniChildrenMap = map
    this._omniMapLoadedAt = now
    this._omniEdgesInjected = false
    return map
  },

  buildOmniEdgesFromTree(rootNodes: OmniTaxonomyNode[]): void {
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
  },

  collectOmniDescendantsSync(codeOrName: string, map: Map<string, Set<string>>): Set<string> {
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
  },

  ensureSqlFunctions(): void {
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
          logger.debug(
            LogCategory.VIRTUAL_DIRECTORY,
            `[TagTreeQuery] should_ignore_file 判定失败（${fileName}），按不忽略处理:`,
            err
          )
          return 0
        }
      })
    } catch (err) {
      // 忽略已注册或 Mock 数据库环境中的错误（注册冲突属可容忍降级：SQL 函数缺省，查询回退不过滤）
      logger.debug(
        LogCategory.VIRTUAL_DIRECTORY,
        '[TagTreeQuery] 注册 should_ignore_file SQL 函数失败，忽略:',
        err
      )
    }
  },

  isFtsAvailable(): boolean {
    if (this._ftsAvailable !== null) return this._ftsAvailable
    try {
      const row = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='files_fts'")
        .get()
      this._ftsAvailable = !!row
    } catch (err) {
      // FTS 探针失败属可容忍降级：回退 LIKE 检索路径
      logger.debug(
        LogCategory.VIRTUAL_DIRECTORY,
        '[TagTreeQuery] files_fts 探针失败，按 FTS 不可用处理:',
        err
      )
      this._ftsAvailable = false
    }
    return this._ftsAvailable
  },

  isPinyinAvailable(): boolean {
    if (this._pinyinAvailable !== null) return this._pinyinAvailable
    try {
      const row = this.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='files_pinyin_fts'")
        .get()
      this._pinyinAvailable = !!row
    } catch (err) {
      logger.debug(
        LogCategory.VIRTUAL_DIRECTORY,
        '[TagTreeQuery] files_pinyin_fts 探针失败，按拼音索引不可用处理:',
        err
      )
      // 瞬时错误（如 db 锁）不缓存 false：否则拼音子查询会被永久静默跳过（R1 盲审 B-S2）
    }
    return this._pinyinAvailable ?? false
  },

  getDescendantTagCodes(tagValueOrCode: string): string[] {
    try {
      // 先查 file_tags_private 确认节点存在，得到其 code
      const anchor = this.db
        .prepare(
          `SELECT code, name FROM file_tags_private
           WHERE code = ? OR name = ?
           LIMIT 1`
        )
        .get(tagValueOrCode, tagValueOrCode) as { code: string; name: string } | undefined

      const targetCode = anchor?.code || tagValueOrCode
      return this.collectSubtreeCodes(targetCode)
    } catch (err) {
      logger.warn(
        LogCategory.VIRTUAL_DIRECTORY,
        `[TagTreeQuery] 子树召回失败: ${tagValueOrCode}`,
        err
      )
      return [tagValueOrCode]
    }
  }
} satisfies ThisType<TagTreeQuery> & TagTreeQueryAdjacency
