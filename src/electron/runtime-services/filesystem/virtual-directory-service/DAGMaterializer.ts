/**
 * DAG 物化路径工具（精简版）
 *
 * 历史职责（已迁移）：
 * - file_tags.materialized_paths 的写入与修复 → 该列已从 file_tags 删除
 * - 子树前缀扫描 → 已迁移至 TagTreeQuery 基于 file_tag_relations.code_path 的纯前缀索引查询
 *
 * 当前职责（仅剩静态工具）：
 * - MaterializedPath 类型导出（供 TagTreeQuery/omni-service 引用）
 * - parsePaths：从任意 JSON 字符串解析路径数组（兼容存量 tagChainsMap 数据）
 * - parseParentCodes：解析 parent_codes JSON 数组
 * - deriveChildPaths：从父路径派生子路径（供外部逻辑复用）
 */

export interface MaterializedPath {
  code_path: string
  name_path: string
}

/** @deprecated 已移除 materialized_paths/depth 列，此接口仅供历史引用兼容 */
export interface TagNodeRow {
  code: string
  name: string
  parent_codes: string
}

export class DAGMaterializer {
  constructor(private db: any) {}

  /**
   * 解析 parent_codes JSON 字符串为数组
   */
  static parseParentCodes(raw: string | null | undefined): string[] {
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter((c: any) => typeof c === 'string' && c) : []
    } catch {
      return []
    }
  }

  /**
   * 解析物化路径 JSON 字符串为数组
   * （兼容旧 file_tags.materialized_paths 列数据格式，现主要用于 tagChainsMap 解析）
   */
  static parsePaths(raw: string | null | undefined): MaterializedPath[] {
    if (!raw) return []
    try {
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed.filter(
        (p: any) => p && typeof p.code_path === 'string' && typeof p.name_path === 'string'
      )
    } catch {
      return []
    }
  }

  /**
   * 由父节点的物化路径派生子节点路径
   * 子路径 = 父 code_path + '/' + childCode
   */
  static deriveChildPaths(
    parentPaths: MaterializedPath[],
    childCode: string,
    childName: string
  ): MaterializedPath[] {
    if (parentPaths.length === 0) {
      return [{ code_path: `/${childCode}`, name_path: `/${childName}` }]
    }
    return parentPaths.map(p => ({
      code_path: `${p.code_path}/${childCode}`,
      name_path: `${p.name_path}/${childName}`
    }))
  }

  /**
   * @deprecated file_tags.materialized_paths 已删除，此方法为空操作兼容存根
   * 子树查询请改用 TagTreeQuery.getDescendantTagCodes()
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  materializeTag(_tagCode: string): MaterializedPath[] {
    return []
  }

  /**
   * @deprecated file_tags.materialized_paths 已删除，此方法为空操作兼容存根
   */
  repairIncompletePaths(): number {
    return 0
  }

  /**
   * @deprecated 改用 TagTreeQuery.getDescendantTagCodes() 基于 file_tag_relations.code_path 查询
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getSubtreeCodesByPrefix(_namePathPrefix: string): string[] {
    return []
  }

  /**
   * @deprecated 改用 TagTreeQuery.getDescendantTagCodes() 基于 file_tag_relations.code_path 查询
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  getSubtreeCodesByCodePrefix(_codePathPrefix: string): string[] {
    return []
  }
}
