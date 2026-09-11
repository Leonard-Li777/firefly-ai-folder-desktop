import Database from 'better-sqlite3'
import { TagTreeQuery, FilterFilesParams } from '../virtual-directory-service/TagTreeQuery'
import type {
  FileItem,
  FilteredFilesResponse,
  SelectedTag,
  VirtualDirectoryFilter
} from '@firefly/types'

/**
 * FileFilter 薄封装服务
 * 
 * 架构重构演进：
 * 1. 彻底消除双轨过滤实现，统一委托至 TagTreeQuery 单一事实源；
 * 2. 依托 SQLite Recursive CTE 下推与高效的索引结构完成多维标签过滤；
 * 3. 保持原有方法签名与返回契约完全一致。
 */
export class FileFilter {
  private _tagTreeQuery: TagTreeQuery

  constructor(
    private db: Database.Database,
    _getExtensionsForTag?: (tag: string) => string[]
  ) {
    this._tagTreeQuery = new TagTreeQuery(db)
  }

  /**
   * 获得已分析文件总数
   */
  async getAnalyzedFilesCount(workspaceDirectoryPath?: string): Promise<number> {
    return this._tagTreeQuery.getAnalyzedFilesCount(workspaceDirectoryPath)
  }

  /**
   * 获得 PRIVATE 工作区的已分析文件总数
   */
  async getPrivateAnalyzedFilesCount(workspaceDirectoryPath?: string): Promise<number> {
    return this._tagTreeQuery.getPrivateAnalyzedFilesCount(workspaceDirectoryPath)
  }

  /**
   * 分页获取过滤后的文件列表
   */
  async getFilteredFilesPaged(params: {
    selectedTags: SelectedTag[]
    sortBy: VirtualDirectoryFilter['sortBy']
    sortOrder: 'asc' | 'desc'
    page: number
    pageSize: number
    workspaceDirectoryPath?: string
    searchKeyword?: string
    virtualDirectoryId?: number
    unionMode?: 'union' | 'intersection'
    includeUnanalyzed?: boolean
  }): Promise<FilteredFilesResponse> {
    return this._tagTreeQuery.getFilteredFilesPaged(params)
  }

  /**
   * 全量获取过滤后的文件列表
   */
  async getFilteredFiles(params: {
    selectedTags: SelectedTag[]
    sortBy: VirtualDirectoryFilter['sortBy']
    sortOrder: 'asc' | 'desc'
    workspaceDirectoryPath?: string
    searchKeyword?: string
    virtualDirectoryId?: number
    unionMode?: 'union' | 'intersection'
    includeUnanalyzed?: boolean
  }): Promise<FileItem[]> {
    return this._tagTreeQuery.getFilteredFiles(params)
  }
}
