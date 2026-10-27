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
  extension: string | null
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
   * 仅查询 id, path, name, smartName, extension，单条 SQL 毫秒级返回
   */
  async getLightweightWorkspaceFiles(
    workspaceDirectoryPathOrId: string | number,
    selectedFileIds?: number[]
  ): Promise<LightweightFileItem[]> {
    let workspaceId: number | undefined
    let workspacePath = ''

    if (typeof workspaceDirectoryPathOrId === 'number') {
      workspaceId = workspaceDirectoryPathOrId
    } else {
      workspacePath = workspaceDirectoryPathOrId
      const row = this.db
        .prepare('SELECT workspace_id FROM workspaces WHERE path = ?')
        .get(workspacePath) as { workspace_id: number } | undefined
      workspaceId = row?.workspace_id
    }

    if (selectedFileIds && selectedFileIds.length > 0) {
      if (workspaceId !== undefined) {
        return this.db
          .prepare(
            `
          SELECT 
            wf.id,
            wf.path,
            wf.name,
            NULLIF(f.smart_name, wf.name) as smartName,
            f.extension
          FROM workspace_files wf
          LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
          WHERE wf.workspace_id = ?
            AND wf.is_analyzed = 1
            AND (wf.status IS NULL OR wf.status = 1)
            AND wf.id IN (SELECT value FROM json_each(?))
          ORDER BY wf.path ASC
        `
          )
          .all(workspaceId, JSON.stringify(selectedFileIds)) as LightweightFileItem[]
      } else {
        const sep = path.sep
        const prefix = workspacePath.endsWith(sep) ? workspacePath : workspacePath + sep
        return this.db
          .prepare(
            `
          SELECT 
            wf.id,
            wf.path,
            wf.name,
            NULLIF(f.smart_name, wf.name) as smartName,
            f.extension
          FROM workspace_files wf
          LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
          WHERE (wf.path LIKE ? OR wf.path = ?)
            AND wf.is_analyzed = 1
            AND (wf.status IS NULL OR wf.status = 1)
            AND wf.id IN (SELECT value FROM json_each(?))
          ORDER BY wf.path ASC
        `
          )
          .all(`${prefix}%`, workspacePath, JSON.stringify(selectedFileIds)) as LightweightFileItem[]
      }
    }

    if (workspaceId !== undefined) {
      return this.db
        .prepare(
          `
        SELECT 
          wf.id,
          wf.path,
          wf.name,
          NULLIF(f.smart_name, wf.name) as smartName,
          f.extension
        FROM workspace_files wf
        LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
        WHERE wf.workspace_id = ?
          AND wf.is_analyzed = 1
          AND (wf.status IS NULL OR wf.status = 1)
        ORDER BY wf.path ASC
      `
        )
        .all(workspaceId) as LightweightFileItem[]
    } else {
      const sep = path.sep
      const prefix = workspacePath.endsWith(sep) ? workspacePath : workspacePath + sep
      return this.db
        .prepare(
          `
        SELECT 
          wf.id,
          wf.path,
          wf.name,
          NULLIF(f.smart_name, wf.name) as smartName,
          f.extension
        FROM workspace_files wf
        LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
        WHERE (wf.path LIKE ? OR wf.path = ?)
          AND wf.is_analyzed = 1
          AND (wf.status IS NULL OR wf.status = 1)
        ORDER BY wf.path ASC
      `
        )
        .all(`${prefix}%`, workspacePath) as LightweightFileItem[]
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
      workspacePath = workspaceDirectoryPathOrId
      const row = this.db
        .prepare('SELECT workspace_id FROM workspaces WHERE path = ?')
        .get(workspacePath) as { workspace_id: number } | undefined
      workspaceId = row?.workspace_id
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
