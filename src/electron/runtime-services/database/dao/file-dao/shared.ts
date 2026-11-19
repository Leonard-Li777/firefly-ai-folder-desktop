import type { Database, Statement } from 'better-sqlite3'
import type { VideoChunkRecord } from '@firefly/types'
import {
  LogCategory,
  logger,
  cleanSmartName,
  isTagProvenanceGroup,
  TAG_PROVENANCE_GROUPS,
  getCanonicalConceptName,
  isTagAdmissible,
  normalizeFileExtension,
  type TagProvenanceGroup
} from '@firefly/shared'
import { t } from '@app/languages'
import * as path from 'path'
import * as fs from 'fs'
import { AccessTimeBatchUpdater } from '../../access-time-batch-updater'
import { normalizeSupportedLocale } from '../../database'
import { ConfigOrchestrator } from '../../../../config/config-orchestrator'
import {
  isAnalyzedForMode,
  normalizeAnalysisMode,
  type AnalysisMode
} from '../../../../config/analysis-mode'
import {
  compressText,
  decompressText,
  compressJson,
  decompressJson
} from '../../../../utils/text-compressor'
import { buildPinyinIndexRow, computePinyinSrcHash } from '../../../utils/pinyin-text'

/**
 * 从受控标签 code 提取可读 slug 作为展示名兜底（builtin.* / omw.* / dim.xxx）
 * 对齐 databaseService.resolveTagDisplayNames 的 slug 兜底策略，避免在界面暴露技术代码
 */
export function readableCode(code: string): string {
  if (!code) return code
  const parts = code.split('.')
  const slug = parts[parts.length - 1] || code
  return slug.replace(/_/g, ' ')
}

/**
 * 受控标签展示名解析：本地 file_tags_private.name 优先，
 * 其次主库当前语言分表 tag_aliases（DAO 层直查 SQL，替换 TaxonomyAliasCache 内存总线），最后 code 可读 slug 兜底。
 * 受控标签（builtin.* / omw.* / dim.xxx）不落 file_tags_private 表（file_tags_private.source CHECK 仅 expanded/user），
 * 其展示名须经语言分表 / Omni 语义包 tag_aliases 镜像解析。
 */
export function dimensionForCode(code: string, viaParentCode?: string | null): string {
  // 票 02 终稿口径：维度归属槽只认经由父 B（via_parent_code）；
  // 为空即真根/无父，退自身 code，严禁再构造 dim.{n} 或退读 parent_codes[0] 二次猜测。
  if (viaParentCode) return viaParentCode
  return code
}

export const MAX_SEGMENT_ATTEMPTS = 3

/** 视频全量分析切片覆盖度统计指标 (FIN-05 / FIN-06) */
export interface VideoCoverageStats {
  file_id: string
  total_duration_sec: number
  completed_duration_sec: number
  has_failed_segments: boolean
  is_fully_covered: boolean
  fileId?: string
  coveredDurationSec: number
  totalDurationSec: number
  isFullyCovered: boolean
  hasFailedSegments: boolean
}

/**
 * FileDao 共享基类（Ticket 10 · 大文件模块化拆分）。
 *
 * 承载原单文件 FileDao 的：构造器 + `db` 字段、维度/FTS 语句缓存字段、拼音游标、
 * 展示名解析（resolveDisplayName）、维度缓存清理（clearDimensionsCache）、
 * 以及 FTS 语句获取（getFtsSearchStmt / getFtsVirtualSearchStmt）。
 * 这些成员被拆分后的各 mixin 子类共享，故声明为 protected（跨子类可见）。
 *
 * 全部代码自 `file-dao.ts` 原样搬移，未改动任何逻辑、命名或注释措辞。
 * 拆分架构：FileDaoSharedBase -> FileCrudMixin -> FileQueryMixin -> FileVideoMixin -> FileDao，
 * 线性继承链保证 `this` 类型完整、运行时方法齐全、外部导入路径零变化。
 */
export abstract class FileDaoSharedBase {
  protected dimensionsCache: any[] | null = null
  protected ftsSearchStmtWithWorkspace: Statement | null = null
  protected ftsSearchStmtGlobal: Statement | null = null
  protected ftsVirtualSearchStmt: Statement | null = null
  /** 拼音索引 reconciler 行id 扫描游标（内存推进，越界绕回表头；进程重启后从 0 开始） */
  protected pinyinScanCursor = 0

  constructor(protected db: Database) {}

  /**
   * 受控标签展示名解析（DAO 层直查主库当前语言分表 tag_aliases）
   * 受控标签展示名解析（AOT 概念字典与主库当前语言分表 tag_aliases 联合解析）
   * 1. 中文环境下，凡命中 AOT 受控权威词条（Canonical Concept）的受控代码，强制采用规范中文展示名；
   * 2. 本地语言分表 tag_aliases 规范名（is_canonical=1）其次；
   * 3. 本地 file_tags_private.name 再次（动态标签/扩展标签，中文环境下拦截过滤常见英文机器码）；
   * 4. 仍未命中时以受控词表或 code 的可读 slug 兜底，绝不暴露未处理的技术代码。
   * @param code 标签 code（受控 builtin.* / omw.* / dim.xxx 或本地动态标签）
   * @param ftName 已从 file_tags_private 取到的本地展示名（无则传 null）
   */
  protected resolveDisplayName(code: string, ftName: string | null): string {
    if (!code) return ftName || ''
    const locale = ConfigOrchestrator.getInstance().getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN'
    const isZh = locale.toLowerCase().startsWith('zh')

    // 1. 中文环境下，凡命中 AOT 受控权威概念字典 (Canonical Concept) 的受控代码，
    // 强制采用规范中文展示名（由 concepts.generated 单一事实源统一解析，零硬编码）
    if (isZh) {
      const canonical = getCanonicalConceptName(code)
      if (canonical) return canonical
    }

    // 2. 本地 file_tags_private.name（用于自定义标签、动态扩展标签）
    if (ftName) {
      return ftName
    }

    // 3. 本地主库别名单表 tag_aliases 直查（Issue 02：locale 普通列，参数化零拼表）
    let safeLocale = locale
    try {
      safeLocale = normalizeSupportedLocale(locale)
      const row = this.db
        .prepare(
          `SELECT lemma FROM tag_aliases
           WHERE locale = ? AND tag_code = ? AND is_canonical = 1 LIMIT 1`
        )
        .get(safeLocale, code) as { lemma?: string } | undefined
      if (row?.lemma) return row.lemma
    } catch (error) {
      // 别名表不可用时降级到 AOT 规范名 / slug，但必须留痕，严禁静默吞异常
      logger.warn(
        LogCategory.DATABASE_SERVICE,
        `[FileDao] tag_aliases 展示名解析失败 (locale=${safeLocale}, code=${code}):`,
        error
      )
    }

    // 4. 非中文环境或分表未收录时的 AOT 规范名兜底
    const canonicalFallback = getCanonicalConceptName(code)
    if (canonicalFallback) return canonicalFallback

    return readableCode(code)
  }

  clearDimensionsCache(): void {
    this.dimensionsCache = null
  }

  /** Issue 03：冷热双 FTS 分层归一分（1/(1+|bm25|) × 层权），禁止跨表裸比原始 bm25 */
  private static readonly FTS_HITS_CTE = `
    WITH fts_hits(rid, score) AS (
      SELECT rowid, ${1.0} / (1 + ABS(bm25(files_meta_fts, 0.0, 10.0, 8.0, 3.0, 4.0)))
      FROM files_meta_fts WHERE files_meta_fts MATCH ?
      UNION ALL
      SELECT rowid, 0.6 / (1 + ABS(bm25(files_body_fts, 0.0, 1.0, 1.5, 1.2, 1.0, 1.2)))
      FROM files_body_fts WHERE files_body_fts MATCH ?
    )
  `

  protected getFtsSearchStmt(workspaceId?: number): { stmt: Statement; extraParams: any[] } {
    if (workspaceId) {
      if (!this.ftsSearchStmtWithWorkspace) {
        this.ftsSearchStmtWithWorkspace = this.db.prepare(`
          ${FileDaoSharedBase.FTS_HITS_CTE}
          SELECT
            COALESCE(f.file_fingerprint, wf.file_fingerprint) as file_fingerprint,
            COALESCE(f.smart_name, wf.name) as smart_name,
            f.size, f.extension, f.file_group, f.author, f.language, f.is_hit, f.last_hit_at, f.description,
            wf.id, wf.path, wf.name, wf.is_analyzed, wf.modified_at as wf_mod,
            fc.quality_score,
            MAX(fts_hits.score) as rank
          FROM fts_hits
          JOIN files f ON f.id = fts_hits.rid
          JOIN workspace_files wf ON wf.file_fingerprint = f.file_fingerprint
          LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
          WHERE wf.workspace_id = ?
          GROUP BY wf.id
          ORDER BY rank DESC LIMIT 100
        `)
      }
      return { stmt: this.ftsSearchStmtWithWorkspace, extraParams: [workspaceId] }
    } else {
      if (!this.ftsSearchStmtGlobal) {
        this.ftsSearchStmtGlobal = this.db.prepare(`
          ${FileDaoSharedBase.FTS_HITS_CTE}
          SELECT
            COALESCE(f.file_fingerprint, wf.file_fingerprint) as file_fingerprint,
            COALESCE(f.smart_name, wf.name) as smart_name,
            f.size, f.extension, f.file_group, f.author, f.language, f.is_hit, f.last_hit_at, f.description,
            wf.id, wf.path, wf.name, wf.is_analyzed, wf.modified_at as wf_mod,
            fc.quality_score,
            MAX(fts_hits.score) as rank
          FROM fts_hits
          JOIN files f ON f.id = fts_hits.rid
          JOIN workspace_files wf ON wf.file_fingerprint = f.file_fingerprint
          LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
          GROUP BY wf.id
          ORDER BY rank DESC LIMIT 100
        `)
      }
      return { stmt: this.ftsSearchStmtGlobal, extraParams: [] }
    }
  }

  protected getFtsVirtualSearchStmt(): Statement {
    if (!this.ftsVirtualSearchStmt) {
      this.ftsVirtualSearchStmt = this.db.prepare(`
        ${FileDaoSharedBase.FTS_HITS_CTE}
        SELECT
          COALESCE(f.file_fingerprint, wf.file_fingerprint) as file_fingerprint,
          COALESCE(f.smart_name, wf.name) as smart_name,
          f.size, f.extension, f.file_group, f.author, f.language, f.is_hit, f.last_hit_at, f.description,
          wf.id, wf.path, wf.name, wf.is_analyzed, wf.modified_at as wf_mod,
          fc.quality_score, vdf.relative_path, vdf.virtual_directory_id,
          MAX(fts_hits.score) as rank
        FROM fts_hits
        JOIN files f ON f.id = fts_hits.rid
        JOIN workspace_files wf ON wf.file_fingerprint = f.file_fingerprint
        JOIN virtual_directory_files vdf ON vdf.file_id = wf.id
        LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
        WHERE (? IS NULL OR vdf.virtual_directory_id = ?)
        GROUP BY wf.id, vdf.file_id
        ORDER BY rank DESC LIMIT 100
      `)
    }
    return this.ftsVirtualSearchStmt
  }
}
