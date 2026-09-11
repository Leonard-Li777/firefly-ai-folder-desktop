/**
 * DAG 物化路径维护器 (DAG Materializer)
 *
 * 核心职责：
 * 1. 为新建/更新标签派生双存物化路径 (code_path + name_path)；
 * 2. 支持多父 DAG：每个直接父节点各派生一条可达路径；
 * 3. 供 TagTreeQuery 两步前缀查询直接消费，零运行时递归 CTE。
 */

import { LogCategory, logger } from '@firefly/shared'

export interface MaterializedPath {
  code_path: string
  name_path: string
}

export interface TagNodeRow {
  code: string
  name: string
  parent_codes: string
  materialized_paths: string
  depth: number
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
   * 解析 materialized_paths JSON 字符串为数组
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
   * 为指定标签节点计算并回写物化路径
   * @returns 计算得到的路径数组（失败返回空数组）
   */
  materializeTag(tagCode: string): MaterializedPath[] {
    try {
      const row = this.db
        .prepare('SELECT code, name, parent_codes, materialized_paths, depth FROM file_tags WHERE code = ?')
        .get(tagCode) as TagNodeRow | undefined

      if (!row) {
        logger.warn(LogCategory.VIRTUAL_DIRECTORY, `[DAGMaterializer] 标签不存在: ${tagCode}`)
        return []
      }

      const parentCodes = DAGMaterializer.parseParentCodes(row.parent_codes)

      // 无父节点：根节点，路径为自身
      if (parentCodes.length === 0) {
        const paths: MaterializedPath[] = [
          { code_path: `/${row.code}`, name_path: `/${row.name}` }
        ]
        this.writePaths(row.code, paths)
        return paths
      }

      // 有父节点：从每个父节点的物化路径派生
      const allPaths: MaterializedPath[] = []
      const seen = new Set<string>()

      for (const parentCode of parentCodes) {
        const parentRow = this.db
          .prepare('SELECT code, name, materialized_paths FROM file_tags WHERE code = ?')
          .get(parentCode) as { code: string; name: string; materialized_paths: string } | undefined

        if (!parentRow) {
          logger.warn(
            LogCategory.VIRTUAL_DIRECTORY,
            `[DAGMaterializer] 父节点缺失: ${parentCode} (子: ${tagCode})`
          )
          continue
        }

        const parentPaths = DAGMaterializer.parsePaths(parentRow.materialized_paths)
        const effectiveParentPaths =
          parentPaths.length > 0
            ? parentPaths
            : [{ code_path: `/${parentRow.code}`, name_path: `/${parentRow.name}` }]

        for (const p of DAGMaterializer.deriveChildPaths(effectiveParentPaths, row.code, row.name)) {
          const key = p.code_path
          if (!seen.has(key)) {
            seen.add(key)
            allPaths.push(p)
          }
        }
      }

      // 父节点全部缺失时兜底为根路径
      if (allPaths.length === 0) {
        allPaths.push({ code_path: `/${row.code}`, name_path: `/${row.name}` })
      }

      this.writePaths(row.code, allPaths)
      return allPaths
    } catch (err) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, `[DAGMaterializer] 物化失败: ${tagCode}`, err)
      return []
    }
  }

  /**
   * 批量物化：对所有 materialized_paths 为空且有父引用的节点执行修复
   * @returns 修复的节点数
   */
  repairIncompletePaths(): number {
    try {
      const incomplete = this.db
        .prepare(
          `SELECT code FROM file_tags
           WHERE parent_codes IS NOT NULL
             AND parent_codes != '[]'
             AND (materialized_paths IS NULL OR materialized_paths = '[]')`
        )
        .all() as Array<{ code: string }>

      let repaired = 0
      for (const row of incomplete) {
        const paths = this.materializeTag(row.code)
        if (paths.length > 0) repaired++
      }

      if (repaired > 0) {
        logger.info(
          LogCategory.VIRTUAL_DIRECTORY,
          `[DAGMaterializer] 修复了 ${repaired} 个物化路径不完整的标签`
        )
      }
      return repaired
    } catch (err) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '[DAGMaterializer] 批量修复失败', err)
      return 0
    }
  }

  /**
   * 用前缀查询获取子树内所有 tag codes（两步查询 Step 1）
   * 仅扫描 file_tags 小表（几千行），json_each 耗时 < 1ms
   */
  getSubtreeCodesByPrefix(namePathPrefix: string): string[] {
    try {
      const normalized = namePathPrefix.endsWith('/')
        ? namePathPrefix.slice(0, -1)
        : namePathPrefix

      const rows = this.db
        .prepare(
          `SELECT code FROM file_tags
           WHERE EXISTS (
             SELECT 1 FROM json_each(materialized_paths)
             WHERE json_extract(value, '$.name_path') = ?
                OR json_extract(value, '$.name_path') LIKE ?
           )`
        )
        .pluck()
        .all(normalized, `${normalized}/%`) as string[]

      return rows
    } catch (err) {
      logger.error(
        LogCategory.VIRTUAL_DIRECTORY,
        `[DAGMaterializer] 前缀查询失败: ${namePathPrefix}`,
        err
      )
      return []
    }
  }

  /**
   * 用 code_path 前缀查询获取子树内所有 tag codes
   */
  getSubtreeCodesByCodePrefix(codePathPrefix: string): string[] {
    try {
      const normalized = codePathPrefix.endsWith('/')
        ? codePathPrefix.slice(0, -1)
        : codePathPrefix

      const rows = this.db
        .prepare(
          `SELECT code FROM file_tags
           WHERE EXISTS (
             SELECT 1 FROM json_each(materialized_paths)
             WHERE json_extract(value, '$.code_path') = ?
                OR json_extract(value, '$.code_path') LIKE ?
           )`
        )
        .pluck()
        .all(normalized, `${normalized}/%`) as string[]

      return rows
    } catch (err) {
      logger.error(
        LogCategory.VIRTUAL_DIRECTORY,
        `[DAGMaterializer] code 前缀查询失败: ${codePathPrefix}`,
        err
      )
      return []
    }
  }

  private writePaths(code: string, paths: MaterializedPath[]): void {
    try {
      this.db
        .prepare('UPDATE file_tags SET materialized_paths = ? WHERE code = ?')
        .run(JSON.stringify(paths), code)
    } catch (err) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, `[DAGMaterializer] 写入路径失败: ${code}`, err)
    }
  }
}
