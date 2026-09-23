import { LogCategory, logger } from '@firefly/shared'
import type Database from 'better-sqlite3'

/**
 * 标签树 → 浏览视图（原维度视图）唯一 adapter（ADR-0035 落地修订）：
 *
 * 领域语义（经产品澄清确认）：
 * 1. 「维度」已废除为独立实体，降级为标签树的一层节点 —— 视图根节点 = parent_codes 为空的节点；
 *    logicPanDimension 不再是独立键，仅对应 file_tags.source = 'dimension' 的锚点标签，收敛于 parent_codes 链；
 * 2. 标签的每个父级完全平等，不存在「首父」概念 —— 子节点归属视图分组时必须挂载到其
 *    parent_codes 中的**每一个**父级之下（多父全挂），禁止使用 parent_codes[0] 取首父的伪维度推导；
 * 3. 系统兜底标签的父码集中在本常量表管理，禁止在业务代码中散落硬编码。
 */

/**
 * 系统级兜底标签的语义包规范词形常量表（集中管理，替代散落的 dim.* 硬编码）。
 * Fix-08 修订：值为 Omni 语义包的**中文规范词形（lemma）**，经
 * databaseService.findTagCodeByLemma 走语言分表 lemma→code 动态轨反查稳定 code
 * （omw > builtin，用户裁决③），不再对本地 file_tags 做名称反查；
 * 常量本身是身份查询输入，与界面语言无关，展示名一律经分表级联解析。
 */
export const SYSTEM_TAG_NAMES = {
  /** 空文件兜底标签（handle-empty-file 使用） */
  emptyFile: '空文件',
  /** 基础属性分组（空文件标签挂载的父级锚点） */
  basicAttr: '基础属性'
} as const

export interface TagRootGroup {
  /** 根节点 code（标签树自然主键） */
  code: string
  name: string
  depth: number
  description: string | null
  meta: string | null
  /** 直属子节点（多父全挂：parent_codes 包含本根 code 的所有子节点） */
  children: TagChildNode[]
}

export interface TagChildNode {
  code: string
  name: string
}

/**
 * 直属子节点匹配 SQL 片段（多父全挂语义）：
 * child.parent_codes 中任意元素等于 root.code 即为直属子节点。
 * 禁止改回 json_extract(parent_codes, '$[0]') 首父匹配 —— 多父 DAG 下会丢挂载。
 */
export const CHILD_OF_ROOT_CLAUSE = `
  EXISTS (
    SELECT 1 FROM json_each(child.parent_codes)
    WHERE json_each.value = root.code
  )
`

/**
 * 查询标签树根分组及其全部直属子节点（视图分组的唯一收口）。
 * 替代各业务处复制的「根节点 + parent_codes[0] 子节点」伪维度推导 SQL。
 */
export function getRootGroupsWithChildren(db: Database.Database): TagRootGroup[] {
  try {
    const roots = db
      .prepare(
        `
        SELECT code, name, depth, description, meta
        FROM file_tags root
        WHERE root.parent_codes IS NULL OR root.parent_codes = '[]'
        ORDER BY root.depth ASC, root.code ASC
      `
      )
      .all() as Array<{ code: string; name: string; depth: number; description: string | null; meta: string | null }>

    if (roots.length === 0) return []

    // 一次取全量父子边（父码数组展开），内存中按根分组 —— 避免每根一次 EXISTS 子查询
    const edges = db
      .prepare(
        `
        SELECT child.code AS child_code, child.name AS child_name, parent.value AS parent_code
        FROM file_tags child, json_each(child.parent_codes) parent
        WHERE child.parent_codes IS NOT NULL AND child.parent_codes != '[]'
      `
      )
      .all() as Array<{ child_code: string; child_name: string; parent_code: string }>

    const childrenByRoot = new Map<string, TagChildNode[]>()
    const seen = new Set<string>()
    for (const e of edges) {
      const key = `${e.parent_code}\u0000${e.child_code}`
      if (seen.has(key)) continue
      seen.add(key)
      const list = childrenByRoot.get(e.parent_code)
      if (list) {
        list.push({ code: e.child_code, name: e.child_name })
      } else {
        childrenByRoot.set(e.parent_code, [{ code: e.child_code, name: e.child_name }])
      }
    }

    return roots.map(r => ({
      code: r.code,
      name: r.name,
      depth: r.depth,
      description: r.description,
      meta: r.meta,
      children: childrenByRoot.get(r.code) ?? []
    }))
  } catch (err: unknown) {
    logger.error(LogCategory.DATABASE, '[TagTreeViewAdapter] 根分组查询失败:', err)
    return []
  }
}
