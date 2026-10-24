import type { Database } from 'better-sqlite3'
import type { SemanticTagInput } from '@firefly/shared'
import { decompressText } from '../../../utils/text-compressor'

/**
 * canonical 固化状态机状态取值（vector-semantic-text-unified-scheme §3.3 状态表）
 * - pending     文本已固化、向量未完成（崩溃可恢复，立即重试）
 * - ready       canonical 向量已写入（幂等跳过）
 * - visual_only 仅 gemma 无字图片：保留阶段一视觉向量，不写 canonical 向量
 * - skipped     文本过短/仅机器名，无有效语义（不重试）
 * - failed      嵌入或 upsert 失败（下次分析/回填重试）
 */
export type CanonicalVectorState = 'pending' | 'ready' | 'visual_only' | 'skipped' | 'failed'

/** files 表 canonical 四列读出的单行记录 */
export interface CanonicalRecord {
  canonicalText: string | null
  canonicalTextVer: number
  canonicalTextHash: string | null
  canonicalVectorState: CanonicalVectorState | null
}

/** 参与语义文本组装的源数据（按文件内容指纹取最终分析产物） */
export interface CanonicalSourceData {
  /** files 行是否存在（指纹未登记时无需固化） */
  exists: boolean
  /** 最终智能命名（files.smart_name） */
  smartName: string | null
  /** 本次分析路径的文件名（workspace_files.name，取最近一条已分析物理引用） */
  rawName: string | null
  /** AI 描述（files.description） */
  description: string | null
  /** 文件分组（files.file_group，已兼容 JSON 容器形态） */
  fileGroup: string | null
  /** 标签集合（结构化，tagGroup 原样透传，由 shared 构建器 fail-closed 过滤） */
  tags: SemanticTagInput[]
  /** 正文候选（content/ocr/asr/lrc 已解压为明文） */
  contents: { content: string; ocr: string; asr: string; lrc: string }
}

/** 按 canonical_vector_state 批量查询的入参（供回填 / 切换失效使用） */
export interface CanonicalStateQuery {
  /** 目标状态集合；null 表示同时匹配 canonical_vector_state IS NULL */
  states: ReadonlyArray<CanonicalVectorState | null>
  /** 批量大小（方案 §3.10 回填按批 32） */
  batchSize: number
  /** 续跑游标：只返回 file_fingerprint 大于该值的行（按指纹字典序断点续跑） */
  afterFingerprint?: string | null
  /** 是否只统计已分析文件（workspace_files.is_analyzed = 1） */
  analyzedOnly?: boolean
}

/**
 * canonical 语义文本四列 DAO（工单 04）。
 *
 * 职责边界：只做 SQL 读写与压缩 BLOB 解压，不感知档位/哈希/嵌入；
 * 状态机流转与 single-flight 由 canonical-text-service 负责。
 */
export class CanonicalDao {
  constructor(private db: Database) {}

  /** 读取 canonical 四列；files 行不存在时返回 null */
  getCanonicalRecord(fileFingerprint: string): CanonicalRecord | null {
    if (!fileFingerprint) return null
    const row = this.db
      .prepare(
        `SELECT canonical_text, canonical_text_ver, canonical_text_hash, canonical_vector_state
         FROM files WHERE file_fingerprint = ?`
      )
      .get(fileFingerprint) as
      | {
          canonical_text: string | null
          canonical_text_ver: number
          canonical_text_hash: string | null
          canonical_vector_state: string | null
        }
      | undefined
    if (!row) return null
    return {
      canonicalText: row.canonical_text,
      canonicalTextVer: row.canonical_text_ver,
      canonicalTextHash: row.canonical_text_hash,
      canonicalVectorState: (row.canonical_vector_state as CanonicalVectorState | null) ?? null
    }
  }

  /**
   * 写入 canonical 四列（pending / skipped 等整行固化均走此入口）。
   * 使用 COALESCE 语义外的直接赋值：调用方给 null 即如实置 NULL（如 skipped 的 hash）。
   */
  writeCanonicalRecord(
    fileFingerprint: string,
    record: { text: string | null; ver: number; hash: string | null; state: CanonicalVectorState }
  ): void {
    this.db
      .prepare(
        `UPDATE files
         SET canonical_text = ?, canonical_text_ver = ?, canonical_text_hash = ?, canonical_vector_state = ?
         WHERE file_fingerprint = ?`
      )
      .run(record.text, record.ver, record.hash, record.state, fileFingerprint)
  }

  /** 只推进状态位（ready / visual_only / failed），不动已固化的文本与哈希 */
  updateCanonicalVectorState(fileFingerprint: string, state: CanonicalVectorState): void {
    this.db
      .prepare(`UPDATE files SET canonical_vector_state = ? WHERE file_fingerprint = ?`)
      .run(state, fileFingerprint)
  }

  /* ---------------- 工单 06：档位切换维护 ---------------- */

  /**
   * 状态失效（方案 §3.10「切换第一步」）：
   * 把 `is_analyzed=1 AND canonical_text IS NOT NULL AND state IN ('ready','visual_only')`
   * 的行按批置 `pending`。
   *
   * 硬约束：
   * - `skipped` 保持跳过（文本本身无有效语义，切档不该复活它）；
   * - `canonical_text` / `canonical_text_hash` 原样保留（文本未变，只是向量维度/空间失效）；
   * - 按批 32、按指纹升序，可重复调用直到返回 0（与视觉探活同批推进）。
   */
  invalidateStaleCanonicalStates(batchSize = 32): number {
    const size = Math.max(1, Math.floor(batchSize))
    const result = this.db
      .prepare(
        `UPDATE files SET canonical_vector_state = 'pending'
         WHERE file_fingerprint IN (
           SELECT files.file_fingerprint FROM files
           WHERE files.canonical_text IS NOT NULL
             AND files.canonical_vector_state IN ('ready','visual_only')
             AND EXISTS (SELECT 1 FROM workspace_files wf
                         WHERE wf.file_fingerprint = files.file_fingerprint AND wf.is_analyzed = 1)
           ORDER BY files.file_fingerprint ASC
           LIMIT ?
         )`
      )
      .run(size)
    return result.changes
  }

  /**
   * 统计各 canonical 状态的已分析文件数（供设置页重建计数，方案 §3.10「禁止静默空召回」）。
   * 返回的 Map 一定包含全部五个状态键，缺省为 0。
   */
  countCanonicalByState(analyzedOnly = true): Record<CanonicalVectorState, number> {
    const counts: Record<CanonicalVectorState, number> = {
      pending: 0,
      ready: 0,
      visual_only: 0,
      skipped: 0,
      failed: 0
    }
    const analyzedClause = analyzedOnly
      ? `AND EXISTS (SELECT 1 FROM workspace_files wf
                     WHERE wf.file_fingerprint = files.file_fingerprint AND wf.is_analyzed = 1)`
      : ''
    const rows = this.db
      .prepare(
        `SELECT files.canonical_vector_state AS state, COUNT(*) AS n
         FROM files
         WHERE files.canonical_vector_state IS NOT NULL ${analyzedClause}
         GROUP BY files.canonical_vector_state`
      )
      .all() as Array<{ state: string; n: number }>
    for (const row of rows) {
      const state = row.state as CanonicalVectorState
      if (state in counts) counts[state] = row.n
    }
    return counts
  }

  /** 统计 `canonical_vector_state IS NULL`（从未计算）的已分析文件数 */
  countCanonicalNullState(analyzedOnly = true): number {
    const analyzedClause = analyzedOnly
      ? `AND EXISTS (SELECT 1 FROM workspace_files wf
                     WHERE wf.file_fingerprint = files.file_fingerprint AND wf.is_analyzed = 1)`
      : ''
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM files
         WHERE files.canonical_vector_state IS NULL ${analyzedClause}`
      )
      .get() as { n: number }
    return row.n
  }

  /**
   * 按 file_group 批量查询已分析文件的指纹（游标分页）。
   * 供物理向量探活使用：视觉槽探活只需图片分组（CLIP / gemma 视觉向量只对图片产出）。
   */
  listAnalyzedFingerprintsByFileGroup(query: {
    fileGroups: ReadonlyArray<string>
    batchSize: number
    afterFingerprint?: string | null
  }): string[] {
    if (query.fileGroups.length === 0) return []
    const size = Math.max(1, Math.floor(query.batchSize))
    const placeholders = query.fileGroups.map(() => '?').join(',')
    const params: any[] = [...query.fileGroups]
    let cursorClause = ''
    if (query.afterFingerprint) {
      cursorClause = 'AND files.file_fingerprint > ?'
      params.push(query.afterFingerprint)
    }
    params.push(size)
    const rows = this.db
      .prepare(
        `SELECT files.file_fingerprint
         FROM files
         WHERE files.file_group IN (${placeholders}) ${cursorClause}
           AND EXISTS (SELECT 1 FROM workspace_files wf
                       WHERE wf.file_fingerprint = files.file_fingerprint AND wf.is_analyzed = 1)
         ORDER BY files.file_fingerprint ASC
         LIMIT ?`
      )
      .all(...params) as Array<{ file_fingerprint: string }>
    return rows.map(r => r.file_fingerprint)
  }

  /**
   * 批量把指定指纹的 canonical 状态置 `pending`（不触碰 canonical_text）。
   * 供「向量被删除但 state 仍为 ready」的探空回填写入重嵌队列使用。
   */
  markCanonicalPending(fileFingerprints: ReadonlyArray<string>): number {
    if (fileFingerprints.length === 0) return 0
    const placeholders = fileFingerprints.map(() => '?').join(',')
    const result = this.db
      .prepare(
        `UPDATE files SET canonical_vector_state = 'pending'
         WHERE file_fingerprint IN (${placeholders})
           AND files.canonical_text IS NOT NULL`
      )
      .run(...fileFingerprints)
    return result.changes
  }

  /**
   * 批量查询已分析文件指纹（游标分页，与视觉槽探活共用同一推进方式）。
   * 供「当前档位全部活跃槽位」探活使用：文本槽（classic 384 / gemma activeDim）的候选全集。
   */
  listAnalyzedFingerprints(query: {
    batchSize: number
    afterFingerprint?: string | null
  }): string[] {
    const size = Math.max(1, Math.floor(query.batchSize))
    const params: any[] = []
    let cursorClause = ''
    if (query.afterFingerprint) {
      cursorClause = 'AND files.file_fingerprint > ?'
      params.push(query.afterFingerprint)
    }
    params.push(size)
    const rows = this.db
      .prepare(
        `SELECT files.file_fingerprint
         FROM files
         WHERE EXISTS (SELECT 1 FROM workspace_files wf
                       WHERE wf.file_fingerprint = files.file_fingerprint AND wf.is_analyzed = 1)
         ${cursorClause}
         ORDER BY files.file_fingerprint ASC
         LIMIT ?`
      )
      .all(...params) as Array<{ file_fingerprint: string }>
    return rows.map(r => r.file_fingerprint)
  }

  /**
   * 把指纹解析为可入队重析的物理引用（path/name/size/type）。
   * 一个指纹可能对应多条物理路径，取最近分析过的一条作为代表。
   */
  listReanalysisInputs(
    fileFingerprints: ReadonlyArray<string>
  ): Array<{ fileFingerprint: string; path: string; name: string; size: number; type: string }> {
    if (fileFingerprints.length === 0) return []
    const out: Array<{
      fileFingerprint: string
      path: string
      name: string
      size: number
      type: string
    }> = []
    for (const fp of fileFingerprints) {
      const row = this.db
        .prepare(
          `SELECT wf.path AS path, wf.name AS name,
                  COALESCE(f.size, 0) AS size, COALESCE(f.extension, '') AS type
           FROM workspace_files wf
           JOIN files f ON wf.file_fingerprint = f.file_fingerprint
           WHERE wf.file_fingerprint = ?
           ORDER BY wf.is_analyzed DESC, wf.last_analyzed_at DESC, wf.id DESC
           LIMIT 1`
        )
        .get(fp) as { path: string; name: string; size: number; type: string } | undefined
      if (!row) continue
      out.push({
        fileFingerprint: fp,
        path: row.path,
        name: row.name,
        size: row.size ?? 0,
        type: row.type ?? ''
      })
    }
    return out
  }

  /**
   * 按 canonical_vector_state 批量查询指纹（游标分页，可断点续跑）。
   * states 含 null 时同时匹配 IS NULL（未计算的旧数据/新扫描行）。
   */
  listCanonicalFingerprintsByState(query: CanonicalStateQuery): string[] {
    const conditions: string[] = []
    const params: any[] = []

    const stateCondition = this.buildStateCondition(query.states)
    if (stateCondition.sql) {
      conditions.push(stateCondition.sql)
      params.push(...stateCondition.params)
    }

    if (query.analyzedOnly) {
      conditions.push(
        `EXISTS (SELECT 1 FROM workspace_files wf
                 WHERE wf.file_fingerprint = files.file_fingerprint AND wf.is_analyzed = 1)`
      )
    }

    if (query.afterFingerprint) {
      conditions.push(`files.file_fingerprint > ?`)
      params.push(query.afterFingerprint)
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    params.push(query.batchSize)

    const rows = this.db
      .prepare(
        `SELECT files.file_fingerprint
         FROM files
         ${whereClause}
         ORDER BY files.file_fingerprint ASC
         LIMIT ?`
      )
      .all(...params) as Array<{ file_fingerprint: string }>
    return rows.map(r => r.file_fingerprint)
  }

  /** 组装 state IN (...) / IS NULL 条件（null 入参表示匹配未计算行） */
  private buildStateCondition(states: ReadonlyArray<CanonicalVectorState | null>): {
    sql: string
    params: string[]
  } {
    const nonNull = states.filter((s): s is CanonicalVectorState => s !== null)
    const includeNull = states.some(s => s === null)
    const parts: string[] = []
    if (nonNull.length > 0) {
      parts.push(`files.canonical_vector_state IN (${nonNull.map(() => '?').join(',')})`)
    }
    if (includeNull) {
      parts.push(`files.canonical_vector_state IS NULL`)
    }
    if (parts.length === 0) return { sql: '', params: [] }
    return { sql: `(${parts.join(' OR ')})`, params: [...nonNull] }
  }

  /**
   * 加载 canonical 固化所需的源数据：
   * files.smart_name / description / file_group + 最近一条物理引用的文件名 + 标签 + 解压后的正文候选。
   */
  loadCanonicalSourceData(fileFingerprint: string): CanonicalSourceData {
    const empty: CanonicalSourceData = {
      exists: false,
      smartName: null,
      rawName: null,
      description: null,
      fileGroup: null,
      tags: [],
      contents: { content: '', ocr: '', asr: '', lrc: '' }
    }
    if (!fileFingerprint) return empty

    const row = this.db
      .prepare(
        `SELECT f.smart_name, f.description, f.file_group,
                (SELECT wf.name FROM workspace_files wf
                 WHERE wf.file_fingerprint = f.file_fingerprint
                 ORDER BY wf.is_analyzed DESC, wf.last_analyzed_at DESC, wf.id DESC
                 LIMIT 1) AS raw_name
         FROM files f
         WHERE f.file_fingerprint = ?`
      )
      .get(fileFingerprint) as
      | {
          smart_name: string | null
          description: string | null
          file_group: string | null
          raw_name: string | null
        }
      | undefined
    if (!row) return empty

    const contentsRow = this.db
      .prepare(
        `SELECT content, ocr, asr, lrc FROM file_contents WHERE file_fingerprint = ?`
      )
      .get(fileFingerprint) as
      | { content: Buffer | string | null; ocr: Buffer | string | null; asr: Buffer | string | null; lrc: Buffer | string | null }
      | undefined

    let tags: SemanticTagInput[] = []
    try {
      const tagRows = this.db
        .prepare(
          `SELECT ftr.tag_code AS code, ft.name AS name, ftr.name_path AS name_path, ftr.tag_group AS tag_group
           FROM file_tag_relations ftr
           LEFT JOIN file_tags_private ft ON ft.code = ftr.tag_code
           WHERE ftr.file_fingerprint = ?
           ORDER BY COALESCE(ftr.confidence, 0) DESC, ftr.tag_code ASC, ftr.via_parent_code ASC`
        )
        .all(fileFingerprint) as Array<{
        code: string
        name: string | null
        name_path: string | null
        tag_group: string | null
      }>
      tags = tagRows.map(t => ({
        name: t.name ?? undefined,
        code: t.code,
        namePath: t.name_path ?? undefined,
        // 缺省分组一律原样回传为空串，由 shared 构建器 fail-closed 剔除
        tagGroup: (t.tag_group ?? '') as SemanticTagInput['tagGroup']
      }))
    } catch {
      tags = []
    }

    return {
      exists: true,
      smartName: row.smart_name,
      rawName: row.raw_name,
      description: row.description,
      fileGroup: parseFileGroup(row.file_group),
      tags,
      contents: {
        content: decompressText(contentsRow?.content ?? null),
        ocr: decompressText(contentsRow?.ocr ?? null),
        asr: decompressText(contentsRow?.asr ?? null),
        lrc: decompressText(contentsRow?.lrc ?? null)
      }
    }
  }
}

/**
 * files.file_group 兼容两种形态：纯字符串枚举值（'image'）与 JSON 容器
 * （`{"group":"image","mime_type":...}`，与 getFileAnalysisResult 的解析口径一致）。
 */
function parseFileGroup(fileGroup: string | null): string | null {
  if (!fileGroup) return null
  if (fileGroup.startsWith('{') || fileGroup.startsWith('[')) {
    try {
      const parsed = JSON.parse(fileGroup)
      return typeof parsed?.group === 'string' ? parsed.group : null
    } catch {
      return null
    }
  }
  return fileGroup
}
