import Database from 'better-sqlite3'
import { SavedVirtualDirectory, FileInfoForAI } from '@firefly/types'
import {
  LogCategory,
  logger,
  isDimensionApplicableToFile,
  getCanonicalConceptName,
  getControlledDimensionRootCode,
  CONTROLLED_CONCEPTS,
  ROOT_DIMENSION_META
} from '@firefly/shared'
import { databaseService } from '../../database/database-service'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'
import { t } from '@app/languages'
import path from 'node:path'
import { decompressJson } from '../../../utils/text-compressor'

export interface LightweightFileItem {
  id: number
  path: string
  name: string
  smartName: string | null
  rawSmartName?: string | null
  extension: string | null
  size?: number
  author?: string | null
  qualityScore?: number | null
  isAnalyzed?: boolean
  is_analyzed?: number
  /** 文件已拥有的标签维度列表（用于批量标签页 tagFileCounts 统计） */
  dimensionTags?: Array<{
    dimensionId: number | null
    dimensionCode: string | null
    rootDimensionCode?: string | null
    pathCodes?: string[]
    dimensionName?: string
    tagValue: string
    tag?: string
    tagName?: string
  }>
}

export class DatabaseHelper {
  constructor(private db: Database.Database) {}

  private resolveTagName(code: string, fallbackName?: string | null): string {
    if (fallbackName && typeof fallbackName === 'string') return fallbackName
    if (!code) return ''
    const targetLocale =
      ConfigOrchestrator.getInstance().getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN'
    const isZh = targetLocale.toLowerCase().startsWith('zh')
    if (isZh) {
      const canonical = getCanonicalConceptName(code)
      if (canonical) return canonical
    }
    const map = databaseService.resolveTagDisplayNames([code], targetLocale)
    if (map[code] && map[code] !== code) return map[code]
    const parts = code.split('.')
    return parts[parts.length - 1] || code
  }

  async getBatchedVirtualDirectoryFiles(
    workspaceDirectoryPath: string,
    virtualDirs: SavedVirtualDirectory[]
  ): Promise<Map<string, Array<{ id: number; path: string; name: string; smartName?: string }>>> {
    const resultMap = new Map<
      string,
      Array<{ id: number; path: string; name: string; smartName?: string }>
    >()

    for (const dir of virtualDirs) {
      resultMap.set(dir.id, [])
    }

    const hasAnyTags = virtualDirs.some(
      dir => dir.filter?.selectedTags && dir.filter.selectedTags.length > 0
    )
    if (!hasAnyTags) {
      return resultMap
    }

    const workspaceRow = this.db
      .prepare('SELECT workspace_id FROM workspaces WHERE path = ?')
      .get(workspaceDirectoryPath) as { workspace_id: number } | undefined
    if (!workspaceRow) {
      return resultMap
    }
    const workspaceId = workspaceRow.workspace_id

    const query = `
      SELECT
        wf.id,
        wf.path,
        wf.name,
        f.smart_name as smartName,
        ftr.tag_code,
        COALESCE(NULLIF(ftr.via_parent_code, ''), ftr.tag_code) as dimension_code,
        ft.name as tagName
      FROM workspace_files wf
      INNER JOIN files f ON wf.file_fingerprint = f.file_fingerprint
      INNER JOIN file_tag_relations ftr ON ftr.file_fingerprint = f.file_fingerprint
      LEFT JOIN file_tags_private ft ON ft.code = ftr.tag_code
      WHERE wf.is_analyzed = 1
        AND wf.workspace_id = ?
    `
    const rows = this.db.prepare(query).all(workspaceId) as any[]

    const filesById = new Map<
      number,
      { id: number; path: string; name: string; smartName?: string; tags: Set<string> }
    >()
    for (const row of rows) {
      if (!filesById.has(row.id)) {
        filesById.set(row.id, {
          id: row.id,
          path: row.path,
          name: row.name,
          smartName: row.smartName,
          tags: new Set<string>()
        })
      }
      const tagName = this.resolveTagName(row.tag_code, row.tagName)
      filesById.get(row.id)!.tags.add(`${row.dimension_code}:${tagName}`)
    }

    for (const dir of virtualDirs) {
      const selectedTags = dir.filter?.selectedTags
      if (!selectedTags || selectedTags.length === 0) continue

      const matchedFiles: Array<{ id: number; path: string; name: string; smartName?: string }> = []

      for (const file of filesById.values()) {
        let matched = true
        for (const tag of selectedTags) {
          const dimCode =
            (tag as any).dimensionCode ||
            (tag as any).viaParentCode ||
            getControlledDimensionRootCode(tag.dimensionId)
          const key = `${dimCode}:${tag.tagValue}`
          if (!file.tags.has(key)) {
            matched = false
            break
          }
        }
        if (matched) {
          matchedFiles.push({
            id: file.id,
            path: file.path,
            name: file.name,
            smartName: file.smartName
          })
        }
      }
      resultMap.set(dir.id, matchedFiles)
    }

    return resultMap
  }

  async getVirtualDirectoryFiles(
    workspaceDirectoryPath: string,
    virtualDir: SavedVirtualDirectory
  ): Promise<Array<{ id: number; path: string; name: string; smartName?: string }>> {
    const selectedTags = virtualDir.filter?.selectedTags
    if (!selectedTags || selectedTags.length === 0) {
      return []
    }

    let query = `
      SELECT DISTINCT
        wf.id,
        wf.path,
        wf.name,
        f.smart_name as smartName
      FROM workspace_files wf
      INNER JOIN files f ON wf.file_fingerprint = f.file_fingerprint
      WHERE wf.is_analyzed = 1
        AND wf.workspace_id = (
          SELECT workspace_id FROM workspaces WHERE path = ?
        )
    `

    const params: any[] = [workspaceDirectoryPath]

    for (let i = 0; i < selectedTags.length; i++) {
      const tag = selectedTags[i]
      const conceptCode = (CONTROLLED_CONCEPTS as Record<string, string>)[tag.tagValue] || tag.tagValue
      // 维度归属统一走经由父 code（票 02 终稿口径，与上方 getBatchedVirtualDirectoryFiles 同源）：
      // 只认 ftr.via_parent_code，为空即真根/无父退自身 ftr.tag_code；严禁退读 parent_codes[0]。
      const targetDimCode =
        (tag as any).dimensionCode ||
        (tag as any).viaParentCode ||
        getControlledDimensionRootCode(tag.dimensionId)
      query += `
        AND EXISTS (
          SELECT 1 FROM file_tag_relations ftr${i}
          LEFT JOIN file_tags_private ft${i} ON ft${i}.code = ftr${i}.tag_code
          WHERE ftr${i}.file_fingerprint = f.file_fingerprint
            AND COALESCE(NULLIF(ftr${i}.via_parent_code, ''), ftr${i}.tag_code) = ?
            AND (
              ftr${i}.tag_code = ?
              OR LOWER(TRIM(ft${i}.name)) = LOWER(TRIM(?))
              OR LOWER(TRIM(REPLACE(ft${i}.name, '.', ''))) = LOWER(TRIM(REPLACE(?, '.', '')))
            )
        )
      `
      params.push(targetDimCode, conceptCode, tag.tagValue, tag.tagValue)
    }

    const files = this.db.prepare(query).all(...params) as any[]
    return files
  }

  /**
   * 极速轻量查询工作区已分析文件（入场投影）
   * 查询 id, path, name, smartName, extension, is_analyzed，并附加 dimensionTags（标签列表）
   * dimensionTags 用于批量标签页 tagFileCounts 计数，不含此字段则所有计数均为 0
   */
  async getLightweightWorkspaceFiles(
    workspaceDirectoryPathOrId: string | number,
    selectedFileIds?: number[],
    limit?: number
  ): Promise<LightweightFileItem[]> {
    let workspaceId: number | undefined
    let workspacePath = ''

    if (typeof workspaceDirectoryPathOrId === 'number') {
      workspaceId = workspaceDirectoryPathOrId
    } else {
      workspacePath = workspaceDirectoryPathOrId || ''
      const row = this.db
        .prepare('SELECT workspace_id FROM workspaces WHERE path = ?')
        .get(workspacePath) as { workspace_id: number } | undefined
      workspaceId = row?.workspace_id

      if (workspaceId === undefined && workspacePath) {
        const dirRow = this.db
          .prepare('SELECT workspace_id FROM workspace_directories WHERE path = ?')
          .get(workspacePath) as { workspace_id: number } | undefined
        workspaceId = dirRow?.workspace_id
      }
    }

    let files: LightweightFileItem[] = []

    if (selectedFileIds && selectedFileIds.length > 0) {
      const cleanIds = selectedFileIds
        .map(id => Number(id))
        .filter(id => !Number.isNaN(id))

      if (cleanIds.length > 0) {
        if (workspaceId !== undefined) {
          files = this.db
            .prepare(
              `
            SELECT 
              wf.id,
              wf.path,
              wf.name,
              NULLIF(f.smart_name, wf.name) as smartName,
              f.raw_smart_name as rawSmartName,
              f.extension,
              f.size,
              f.author,
              wf.is_analyzed as isAnalyzed,
              wf.is_analyzed
            FROM workspace_files wf
            LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
            WHERE wf.workspace_id = ?
              AND wf.is_analyzed = 1
              AND (wf.status IS NULL OR wf.status = 1)
              AND wf.id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
            ORDER BY wf.path ASC${limit && limit > 0 ? ' LIMIT ?' : ''}
          `
            )
            .all(...(limit && limit > 0 ? [workspaceId, JSON.stringify(cleanIds), limit] : [workspaceId, JSON.stringify(cleanIds)])) as LightweightFileItem[]
        } else {
          // workspaceId 无法从路径匹配时，直接基于全局唯一主键 cleanIds 查询，避免反斜杠 LIKE 导致查空
          files = this.db
            .prepare(
              `
            SELECT 
              wf.id,
              wf.path,
              wf.name,
              NULLIF(f.smart_name, wf.name) as smartName,
              f.raw_smart_name as rawSmartName,
              f.extension,
              f.size,
              f.author,
              wf.is_analyzed as isAnalyzed,
              wf.is_analyzed
            FROM workspace_files wf
            LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
            WHERE wf.is_analyzed = 1
              AND (wf.status IS NULL OR wf.status = 1)
              AND wf.id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
            ORDER BY wf.path ASC${limit && limit > 0 ? ' LIMIT ?' : ''}
          `
            )
            .all(...(limit && limit > 0 ? [JSON.stringify(cleanIds), limit] : [JSON.stringify(cleanIds)])) as LightweightFileItem[]
        }
      }
    } else if (workspaceId !== undefined) {
      files = this.db
        .prepare(
          `
        SELECT 
          wf.id,
          wf.path,
          wf.name,
          NULLIF(f.smart_name, wf.name) as smartName,
          f.raw_smart_name as rawSmartName,
          f.extension,
          f.size,
          f.author,
          wf.is_analyzed as isAnalyzed,
          wf.is_analyzed
        FROM workspace_files wf
        LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
        WHERE wf.workspace_id = ?
          AND wf.is_analyzed = 1
          AND (wf.status IS NULL OR wf.status = 1)
        ORDER BY wf.path ASC${limit && limit > 0 ? ' LIMIT ?' : ''}
      `
        )
        .all(...(limit && limit > 0 ? [workspaceId, limit] : [workspaceId])) as LightweightFileItem[]
    } else {
      const sep = path.sep
      const prefix = workspacePath.endsWith(sep) ? workspacePath : workspacePath + sep
      files = this.db
        .prepare(
          `
        SELECT 
          wf.id,
          wf.path,
          wf.name,
          NULLIF(f.smart_name, wf.name) as smartName,
          f.raw_smart_name as rawSmartName,
          f.extension,
          f.size,
          f.author,
          wf.is_analyzed as isAnalyzed,
          wf.is_analyzed
        FROM workspace_files wf
        LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
        WHERE (wf.path LIKE ? OR wf.path = ?)
          AND wf.is_analyzed = 1
          AND (wf.status IS NULL OR wf.status = 1)
        ORDER BY wf.path ASC${limit && limit > 0 ? ' LIMIT ?' : ''}
      `
        )
        .all(...(limit && limit > 0 ? [`${prefix}%`, workspacePath, limit] : [`${prefix}%`, workspacePath])) as LightweightFileItem[]
    }

    // 附加 dimensionTags：批量读取这批文件的标签，用于批量标签页 tagFileCounts 计数
    // 不含此字段则前端 tagFileCounts 全为 0，所有标签计数徽章无法正常显示
    if (files.length > 0) {
      this.appendDimensionTagsToFiles(files)
    }

    return files
  }

  /**
   * 批量附加 dimensionTags 到轻量文件列表（一次 SQL，避免 N+1）
   * 通过 file_tag_relations JOIN workspace_files 关联 file.id → file_fingerprint → 标签
   */
  private appendDimensionTagsToFiles(files: LightweightFileItem[]): void {
    const fileIds = files.map(f => f.id)
    if (fileIds.length === 0) return

    try {
      // 一次性批量查：file id → (tag_code, via_parent_code, code_path, tag_name)
      // via_parent_code 即维度归属 code（空字符串表示根节点自身即父），tag_name 为本地展示名
      const tagRows = this.db
        .prepare(
          `
          SELECT
            wf.id AS file_id,
            ftr.tag_code,
            ftr.via_parent_code,
            ftr.code_path,
            ft.name AS tag_name
          FROM workspace_files wf
          INNER JOIN files f ON wf.file_fingerprint = f.file_fingerprint
          INNER JOIN file_tag_relations ftr ON ftr.file_fingerprint = f.file_fingerprint
          LEFT JOIN file_tags_private ft ON ft.code = ftr.tag_code
          WHERE wf.id IN (SELECT CAST(value AS INTEGER) FROM json_each(?))
          ORDER BY ftr.depth ASC, ftr.created_at ASC
        `
        )
        .all(JSON.stringify(fileIds)) as Array<{
          file_id: number
          tag_code: string
          via_parent_code: string
          code_path: string
          tag_name: string | null
        }>

      // 按 file_id 分组，构建 dimensionTags
      const tagsByFileId = new Map<number, Array<{
        dimensionId: number | null
        dimensionCode: string | null
        rootDimensionCode?: string | null
        pathCodes?: string[]
        dimensionName?: string
        tagValue: string
        tag: string
        tagName: string
      }>>()
      for (const row of tagRows) {
        if (!tagsByFileId.has(row.file_id)) {
          tagsByFileId.set(row.file_id, [])
        }
        const displayName = row.tag_name || this.resolveTagName(row.tag_code)
        if (displayName) {
          const pathCodes = row.code_path ? row.code_path.split('/').filter(Boolean) : []
          const rootDimCode = pathCodes[0] || row.via_parent_code || row.tag_code || null
          // 标签直属维度必须优先取 via_parent_code，严禁将视觉等细分维度全部错误回溯到首段根维度（文件类型）
          // [ISS-01] 坚决剔除 row.tag_code 与 tagDimName，严禁让标签值自身反客为主充当维度名与维度码
          const viaParentDimName = row.via_parent_code ? getCanonicalConceptName(row.via_parent_code) : ''
          const rootDimName = rootDimCode ? getCanonicalConceptName(rootDimCode) : ''
          const canonicalDimName = viaParentDimName || rootDimName || ''
          tagsByFileId.get(row.file_id)!.push({
            dimensionId: null,
            dimensionCode: row.via_parent_code || rootDimCode || null,
            rootDimensionCode: rootDimCode,
            pathCodes,
            dimensionName: canonicalDimName,
            tagValue: displayName,
            tag: displayName,
            tagName: displayName
          })
        }
      }

      // 将 dimensionTags 附加到对应的文件对象
      for (const file of files) {
        file.dimensionTags = tagsByFileId.get(file.id) || []
      }
    } catch (err) {
      logger.warn(
        LogCategory.FILE_ORGANIZATION,
        '[DatabaseHelper] 批量附加 dimensionTags 失败，fileCount 将回退为 0:',
        err
      )
      // 降级：确保字段存在但为空数组，不影响主流程
      for (const file of files) {
        if (!file.dimensionTags) file.dimensionTags = []
      }
    }
  }

  /**
   * 极速统计工作区已分析文件总数（入场轻量计数器）
   */
  getWorkspaceAnalyzedFileCount(workspaceDirectoryPathOrId: string | number): number {
    let workspaceId: number | undefined
    let workspacePath = ''

    if (typeof workspaceDirectoryPathOrId === 'number') {
      workspaceId = workspaceDirectoryPathOrId
    } else {
      workspacePath = workspaceDirectoryPathOrId || ''
      const row = this.db
        .prepare('SELECT workspace_id FROM workspaces WHERE path = ?')
        .get(workspacePath) as { workspace_id: number } | undefined
      workspaceId = row?.workspace_id

      if (workspaceId === undefined && workspacePath) {
        const dirRow = this.db
          .prepare('SELECT workspace_id FROM workspace_directories WHERE path = ?')
          .get(workspacePath) as { workspace_id: number } | undefined
        workspaceId = dirRow?.workspace_id
      }
    }

    if (workspaceId !== undefined) {
      const row = this.db
        .prepare(
          `SELECT COUNT(*) as count FROM workspace_files WHERE workspace_id = ? AND is_analyzed = 1 AND (status IS NULL OR status = 1)`
        )
        .get(workspaceId) as { count: number } | undefined
      return row?.count ?? 0
    }

    const sep = path.sep
    const prefix = workspacePath.endsWith(sep) ? workspacePath : workspacePath + sep
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM workspace_files WHERE (path LIKE ? OR path = ?) AND is_analyzed = 1 AND (status IS NULL OR status = 1)`
      )
      .get(`${prefix}%`, workspacePath) as { count: number } | undefined
    return row?.count ?? 0
  }

  async getSavedVirtualDirectories(
    workspaceDirectoryPath: string
  ): Promise<SavedVirtualDirectory[]> {
    try {
      const directories = this.db
        .prepare(
          `
        SELECT id, name, description, filters, parent_id, workspace_id, created_at, updated_at
        FROM analyzed_directories
        WHERE workspace_id = (SELECT workspace_id FROM workspaces WHERE path = ?)
        ORDER BY created_at DESC
      `
        )
        .all(workspaceDirectoryPath) as any[]

      return directories.map(dir => ({
        id: dir.id,
        name: dir.name,
        description: dir.description || undefined,
        filter: JSON.parse(dir.filters),
        parentId: dir.parent_id || null,
        workspaceId: dir.workspace_id,
        createdAt: new Date(dir.created_at),
        updatedAt: new Date(dir.updated_at)
      }))
    } catch (error: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, '获取已保存的虚拟目录失败', {
        workspaceDirectoryPath,
        error: error.message
      })
      return []
    }
  }
}
