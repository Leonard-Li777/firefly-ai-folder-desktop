import Database from 'better-sqlite3'
import {
  DimensionGroup,
  DimensionGroupsResponse,
  GetDimensionGroupsOptions
} from '@firefly/types'
import { getCanonicalConceptName } from '@firefly/shared'
import { TagTreeQuery } from '../virtual-directory-service/TagTreeQuery'

/**
 * DimensionManager 薄封装服务
 * 
 * 架构重构演进：
 * 1. 彻底移除 102..117 魔法区间硬编码与 ram_pan_projection.json 离线投影文件磁盘扫描；
 * 2. 标签树聚合与文件计数已统一委托至 TagTreeQuery（基于 SQLite Recursive CTE 下推）；
 * 3. 保持原有方法签名兼容，杜绝上层业务与测试断裂。
 */
export class DimensionManager {
  private _tagTreeQuery: TagTreeQuery

  constructor(private db: Database.Database) {
    this._tagTreeQuery = new TagTreeQuery(db)
  }

  /**
   * 获取维度组（包含树形标签结构与文件命中计数）
   */
  async getDimensionGroups(
    workspaceDirectoryPath?: string | GetDimensionGroupsOptions,
    virtualDirectoryId?: number
  ): Promise<DimensionGroup[]> {
    const opts: GetDimensionGroupsOptions =
      typeof workspaceDirectoryPath === 'string'
        ? { workspaceDirectoryPath, virtualDirectoryId }
        : workspaceDirectoryPath || {}
    const res = await this._tagTreeQuery.getDimensionGroups(opts)
    return res.groups
  }

  /**
   * 分页获取维度组
   */
  async getDimensionGroupsPaged(options: GetDimensionGroupsOptions): Promise<DimensionGroupsResponse> {
    return this._tagTreeQuery.getDimensionGroups(options)
  }

  /**
   * 获取指定标签关联的扩展名列表（树形模型下由 TagTreeQuery 自然管理，默认返回空列表）
   */
  getExtensionsForTag(_tag: string): string[] {
    return []
  }

  /**
   * 获取文件关联的标签与维度信息（供兼容使用）
   */
  getFileTagsWithDimensions(
    fileId: string
  ): Array<{ dimensionId: string; dimensionName: string; tagValue: string; level: number }> {
    try {
      const rows = this.db
        .prepare(
          `
        SELECT 
          ftr.tag_code as code, 
          COALESCE(ftr.via_parent_code, ft.parent_codes, 'default') as dimensionName, 
          ft.name as tagValue, 
          0 as level
        FROM file_tag_relations ftr
        LEFT JOIN file_tags_private ft ON ft.code = ftr.tag_code
        WHERE ftr.file_fingerprint = ?
      `
        )
        .all(fileId) as Array<{ code: string; dimensionName: string; tagValue: string | null; level: number }>

      return rows.map(r => {
        let tagValue = r.tagValue
        if (!tagValue && r.code) {
          tagValue = getCanonicalConceptName(r.code) || ''
          if (!tagValue) {
            const parts = r.code.split('.')
            tagValue = parts[parts.length - 1] || r.code
          }
        }
        return {
          dimensionId: r.code,
          dimensionName: r.dimensionName,
          tagValue: tagValue || r.code,
          level: r.level
        }
      })
    } catch {
      return []
    }
  }
}
