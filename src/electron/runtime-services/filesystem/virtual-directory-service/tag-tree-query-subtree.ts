/**
 * TagTreeQuery · 子树标签 code 解析器（partial-class 混入）
 *
 * 拆分自原 TagTreeQuery.ts（只搬不改，逐字节保真）。承载职责：
 * 1. 基于 file_tag_relations.code_path 前缀/路径段收集子树全部 codes；
 * 2. 将选中的标签（受控 code / 展示名 tagValue / 动态扩展 code）全面解析为底层 tag_code 列表，
 *    并借缓存的 _omniChildrenMap 做跨源 BFS 子孙展开（保障父级标签点击可穿透召回全量后代）。
 *
 * 运行时经 Object.assign(TagTreeQuery.prototype, tagTreeQuerySubtreeMixin) 挂回主类；
 * 类型通过 TagTreeQuerySubtree 接口并入 TagTreeQuery，外部导入路径与调用签名零变化。
 */
import { escapeLike } from './tag-tree-query-shared'
import { LogCategory, logger } from '@firefly/shared'
import type { TagTreeQuery } from './TagTreeQuery'

export interface TagTreeQuerySubtree {
  collectSubtreeCodes(tagCode: string): string[]

  resolveFilterTagCodes(tag: { code?: string; tagValue?: string; viaParentCode?: string }): string[]
}

export const tagTreeQuerySubtreeMixin = {
  collectSubtreeCodes(tagCode: string): string[] {
    const codeSet = new Set<string>()
    codeSet.add(tagCode)

    try {
      // Step 1：查 file_tag_relations 中以该 tagCode 为路径段的所有后代 tag_code
      // 场景覆盖：
      // a) 根维度作为第一段：code_path = '/tagCode' OR code_path LIKE '/tagCode/%'
      // b) 中间节点作为中间段：code_path LIKE '%/tagCode/%'
      // c) 自身作为末尾段：code_path LIKE '%/tagCode'
      // 【模型 B】以上 4 路 ftr 全表 LIKE 扫已退役：改查微型字典 tag_paths + 祖先闭包，零触碰 file_tag_relations。
      // 闭包表 tag_path_ancestors 含自身，ancestor_code = tagCode 一次命中所有「以该 code 为路径段」的路径，
      // 其 leaf_code 即为子树内全部后代 tag_code。
      const pathRows = this.db
        .prepare(
          `SELECT DISTINCT tp.code_path, tp.leaf_code
           FROM tag_path_ancestors tpa
           JOIN tag_paths tp ON tp.path_id = tpa.path_id
           WHERE tpa.ancestor_code = ? AND tp.leaf_code != ''`
        )
        .all(tagCode) as Array<{ code_path: string; leaf_code: string }>

      for (const { leaf_code, code_path } of pathRows) {
        const leaf =
          leaf_code || (code_path ? code_path.split('/').filter(Boolean).pop() : '') || ''
        if (leaf) codeSet.add(leaf)
      }

      // Step 2：若当前 tagCode 自身在 tag_paths 中有字典记录（如叶子或非纯维度节点），
      // 【模型 B】改为从 tag_paths（WHERE leaf_code = ?）读取其所有已落库的完整 code_path，
      // 并以这些完整 code_path 为前缀在微型字典 tag_paths 上做确定性前缀扫描（彻底移除对 ftr.code_path 的读取）。
      const selfRows = this.db
        .prepare(
          `SELECT DISTINCT code_path FROM tag_paths
           WHERE leaf_code = ? AND code_path != ''`
        )
        .all(tagCode) as Array<{ code_path: string }>

      for (const { code_path: selfPath } of selfRows) {
        const escSelfPath = escapeLike(selfPath)
        const descendantRows = this.db
          .prepare(
            `SELECT DISTINCT leaf_code AS tag_code FROM tag_paths
             WHERE (code_path = ? OR code_path LIKE (? || '/%') ESCAPE '\\')
               AND leaf_code != ''`
          )
          .all(selfPath, escSelfPath) as Array<{ tag_code: string }>

        for (const { tag_code } of descendantRows) {
          codeSet.add(tag_code)
        }
      }

      // Step 3：从 file_tags_private 本地表查询 DAG 的所有直属及递归子标签（如果存在拓扑登记）
      // 保证尚未打标的新建子标签或空子分类也能被收集，维护树结构的完整拓扑
      try {
        const stmtChildTags = this.db.prepare(
          `SELECT code, parent_codes FROM file_tags_private WHERE parent_codes != '[]' AND parent_codes != ''`
        )
        const allParentRows = stmtChildTags.all() as Array<{ code: string; parent_codes: string }>
        const parentToChildren = new Map<string, string[]>()
        for (const row of allParentRows) {
          try {
            const parents = JSON.parse(row.parent_codes) as string[]
            if (Array.isArray(parents)) {
              for (const p of parents) {
                if (!parentToChildren.has(p)) parentToChildren.set(p, [])
                parentToChildren.get(p)!.push(row.code)
              }
            }
          } catch (err) {
            logger.warn(
              LogCategory.VIRTUAL_DIRECTORY,
              `[TagTreeQuery] 解析标签 parent_codes 失败: code=${row.code}`,
              err
            )
          }
        }

        const queue = [tagCode]
        const visited = new Set<string>([tagCode])
        while (queue.length > 0) {
          const curr = queue.shift()!
          const children = parentToChildren.get(curr)
          if (children) {
            for (const ch of children) {
              if (!visited.has(ch)) {
                visited.add(ch)
                codeSet.add(ch)
                queue.push(ch)
              }
            }
          }
        }
      } catch (err) {
        logger.warn(
          LogCategory.VIRTUAL_DIRECTORY,
          `[TagTreeQuery] 读取标签 DAG 邻接失败: ${tagCode}`,
          err
        )
      }
    } catch (err) {
      logger.warn(
        LogCategory.VIRTUAL_DIRECTORY,
        `[TagTreeQuery] collectSubtreeCodes 失败: ${tagCode}`,
        err
      )
    }

    return [...codeSet]
  },

  resolveFilterTagCodes(tag: {
    code?: string
    tagValue?: string
    viaParentCode?: string
  }): string[] {
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

    // 2. 双轨动态映射：在 file_tags_private 中查找与该标签关联的所有动态扩展 code
    try {
      const candidates: Array<{ code: string }> = []
      if (tag.tagValue && tag.code) {
        const rows = this.db
          .prepare(
            `SELECT DISTINCT code FROM file_tags_private
           WHERE name = ? OR code = ? OR parent_codes LIKE ? OR name LIKE ?`
          )
          .all(tag.tagValue, tag.code, `%${tag.code}%`, `%${tag.tagValue}%`) as Array<{
          code: string
        }>
        candidates.push(...rows)
      } else if (tag.tagValue) {
        const rows = this.db
          .prepare(
            `SELECT DISTINCT code FROM file_tags_private
           WHERE name = ? OR code = ? OR name LIKE ?`
          )
          .all(tag.tagValue, tag.tagValue, `%${tag.tagValue}%`) as Array<{ code: string }>
        candidates.push(...rows)
      } else if (tag.code) {
        const rows = this.db
          .prepare(
            `SELECT DISTINCT code FROM file_tags_private
           WHERE code = ? OR parent_codes LIKE ?`
          )
          .all(tag.code, `%${tag.code}%`) as Array<{ code: string }>
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
      logger.warn(
        LogCategory.VIRTUAL_DIRECTORY,
        `[TagTreeQuery] resolveFilterTagCodes 查询动态扩展标签失败:`,
        err
      )
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
} satisfies ThisType<TagTreeQuery> & TagTreeQuerySubtree
