import type { Database } from 'better-sqlite3'
import { LogCategory, logger, getCanonicalConceptName } from '@firefly/shared'
import type { Unit, UnitCreationData } from '@firefly/types'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'
import { databaseService } from '../database-service'
import * as path from 'path'

export class TagUnitDao {
  constructor(private db: Database) {}

  async createUnit(data: UnitCreationData): Promise<Unit> {
    const now = new Date().toISOString()
    const stmt = this.db.prepare(`INSERT INTO file_units (
      name, description, type, path, grouping_reason, grouping_confidence, author, title, tags, quality_score, parent_unit_id, workspace_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    const result = stmt.run(
      data.name,
      data.description ?? null,
      data.type,
      data.path ?? null,
      data.groupingReason ?? null,
      data.groupingConfidence ?? null,
      data.author ?? null,
      data.title ?? null,
      data.tags ? JSON.stringify(data.tags) : null,
      data.qualityScore ?? null,
      data.parentUnitId ?? null,
      data.workspaceId,
      now,
      now
    )
    return this.getUnit(Number(result.lastInsertRowid))
  }

  async getUnit(id: number): Promise<Unit> {
    const row = this.db.prepare('SELECT * FROM file_units WHERE id = ?').get(id) as any
    if (!row) throw new Error('Unit not found')
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      type: row.type,
      path: row.path ?? undefined,
      groupingReason: row.grouping_reason ?? undefined,
      groupingConfidence: row.grouping_confidence ?? undefined,
      author: row.author ?? undefined,
      title: row.title ?? undefined,
      tags: row.tags ? JSON.parse(row.tags) : undefined,
      qualityScore: row.quality_score ?? undefined,
      parentUnitId: row.parent_unit_id ?? undefined,
      isAnalyzed: Boolean(row.is_analyzed),
      analyzedAt: row.analyzed_at ?? undefined,
      analysisError: row.analysis_error ?? undefined,
      workspaceId: row.workspace_id,
      createdAt: row.created_at ?? undefined,
      updatedAt: row.updated_at ?? undefined
    }
  }

  async updateUnit(id: number, partial: Partial<Unit>): Promise<Unit> {
    const row = this.db.prepare('SELECT * FROM file_units WHERE id = ?').get(id) as any
    if (!row) throw new Error('Unit not found')

    const updated = {
      name: partial.name ?? row.name,
      description: partial.description ?? row.description,
      type: partial.type ?? row.type,
      path: partial.path ?? row.path,
      grouping_reason: partial.groupingReason ?? row.grouping_reason,
      grouping_confidence: partial.groupingConfidence ?? row.grouping_confidence,
      author: partial.author ?? row.author,
      title: partial.title ?? row.title,
      tags: partial.tags ? JSON.stringify(partial.tags) : row.tags,
      quality_score: partial.qualityScore ?? row.quality_score,
      parent_unit_id: partial.parentUnitId ?? row.parent_unit_id,
      is_analyzed:
        partial.isAnalyzed !== undefined ? (partial.isAnalyzed ? 1 : 0) : row.is_analyzed,
      analyzed_at: partial.analyzedAt ?? row.analyzed_at,
      analysis_error: partial.analysisError ?? row.analysis_error
    }

    this.db
      .prepare(
        `UPDATE file_units SET
      name = ?, description = ?, type = ?, path = ?, grouping_reason = ?, grouping_confidence = ?, author = ?, title = ?, tags = ?, quality_score = ?, parent_unit_id = ?, is_analyzed = ?, analyzed_at = ?, analysis_error = ?, updated_at = ?
      WHERE id = ?`
      )
      .run(
        updated.name,
        updated.description,
        updated.type,
        updated.path,
        updated.grouping_reason,
        updated.grouping_confidence,
        updated.author,
        updated.title,
        updated.tags,
        updated.quality_score,
        updated.parent_unit_id,
        updated.is_analyzed,
        updated.analyzed_at,
        updated.analysis_error,
        new Date().toISOString(),
        id
      )

    return this.getUnit(id)
  }

  async deleteUnit(id: number): Promise<void> {
    this.db.prepare('DELETE FROM file_units WHERE id = ?').run(id)
  }

  async getUnitsForFile(fileDbId: number): Promise<Unit[]> {
    const rows = this.db
      .prepare(
        `
      SELECT u.* FROM file_units u
      JOIN file_unit_relations r ON r.file_id = u.id
      WHERE r.file_id = ?
    `
      )
      .all(fileDbId) as any[]
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      type: row.type,
      path: row.path ?? undefined,
      groupingReason: row.grouping_reason ?? undefined,
      groupingConfidence: row.grouping_confidence ?? undefined,
      author: row.author ?? undefined,
      title: row.title ?? undefined,
      tags: row.tags ? JSON.parse(row.tags) : undefined,
      qualityScore: row.quality_score ?? undefined,
      parentUnitId: row.parent_unit_id ?? undefined,
      isAnalyzed: Boolean(row.is_analyzed),
      analyzedAt: row.analyzed_at ?? undefined,
      analysisError: row.analysis_error ?? undefined,
      workspaceId: row.workspace_id,
      createdAt: row.created_at ?? undefined,
      updatedAt: row.updated_at ?? undefined
    }))
  }

  async createFileUnitRelation(fileDbId: number, unitId: number): Promise<void> {
    this.db
      .prepare('INSERT OR IGNORE INTO file_unit_relations (file_id, unit_id) VALUES (?, ?)')
      .run(fileDbId, unitId)
  }

  async getUnitsForPath(filePath: string): Promise<Unit[]> {
    const wf = this.db.prepare('SELECT id FROM workspace_files WHERE path = ?').get(filePath) as any
    if (wf) {
      return this.getUnitsForFile(wf.id)
    }
    const parentDirPath = path.dirname(filePath)
    const rows = this.db
      .prepare('SELECT * FROM file_units WHERE path = ?')
      .all(parentDirPath) as any[]
    return rows.map(row => ({
      id: row.id,
      name: row.name,
      description: row.description ?? undefined,
      type: row.type,
      path: row.path ?? undefined,
      groupingReason: row.grouping_reason ?? undefined,
      groupingConfidence: row.grouping_confidence ?? undefined,
      author: row.author ?? undefined,
      title: row.title ?? undefined,
      tags: row.tags ? JSON.parse(row.tags) : undefined,
      qualityScore: row.quality_score ?? undefined,
      parentUnitId: row.parent_unit_id ?? undefined,
      isAnalyzed: Boolean(row.is_analyzed),
      analyzedAt: row.analyzed_at ?? undefined,
      analysisError: row.analysis_error ?? undefined,
      workspaceId: row.workspace_id,
      createdAt: row.created_at ?? undefined,
      updatedAt: row.updated_at ?? undefined
    }))
  }

  async getFileTagsByFileId(fileFingerprint: string): Promise<any[]> {
    try {
      // 创世 Baseline V1 / PRD-0060 v2.3：本地缓存回灌路径必须与云端 RPC
      // `rpc_get_file_by_id`（scripts/cloud-config-sync/sql/02_rpc/023_file_sync_rpc.sql:33-49）
      // 返回**同形**的 tags 行 —— 否则 saveCloudResult 必须同时兼容两种 shape。
      // 维度归属槽只认经由父 `ftr.via_parent_code`（票 02 终稿口径：为空即真根/无父）；
      // 严禁退读 `parent_codes[0]` 二次猜测，严禁再产出 `dimension_id`。
      const rows = this.db
        .prepare(
          `
        SELECT
          ftr.tag_code        AS code,
          ft.name             AS name,
          ftr.via_parent_code AS via_parent_code,
          ftr.tag_group       AS tag_group,
          ft.parent_codes     AS parent_codes,
          ftr.code_path       AS code_path,
          ftr.name_path       AS name_path,
          ftr.depth           AS depth,
          ftr.confidence      AS confidence
        FROM file_tag_relations ftr
        LEFT JOIN file_tags_private ft ON ft.code = ftr.tag_code
        WHERE ftr.file_fingerprint = ?
      `
        )
        .all(fileFingerprint) as Array<{ name: string | null; code: string; parent_codes: string | null } & Record<string, unknown>>
      // 云端 `file_tags_private.parent_codes` 为 JSONB（数组），本地列是 TEXT（JSON 字符串）。
      // 为兑现「与云端 RPC 同形」契约，此处统一解析为数组；解析失败退回 `[]`（与列默认值一致）。
      return rows.map(row => {
        let parentCodes: unknown = []
        try {
          const parsed = JSON.parse(row.parent_codes ?? '[]')
          parentCodes = Array.isArray(parsed) ? parsed : []
        } catch {
          parentCodes = []
        }

        let displayName = typeof row.name === 'string' && row.name ? row.name : ''
        const code = String(row.code || '')
        if (!displayName && code) {
          const targetLocale =
            ConfigOrchestrator.getInstance().getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN'
          const isZh = targetLocale.toLowerCase().startsWith('zh')
          if (isZh) {
            displayName = getCanonicalConceptName(code) || ''
          }
          if (!displayName) {
            const displayMap = databaseService.resolveTagDisplayNames([code], targetLocale)
            displayName = displayMap[code] || ''
          }
          if (!displayName || displayName === code) {
            const parts = code.split('.')
            displayName = parts[parts.length - 1] || code
          }
        }

        return { ...row, name: displayName, parent_codes: parentCodes }
      })
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '获取文件标签失败', { error, fileFingerprint })
      return []
    }
  }
}
