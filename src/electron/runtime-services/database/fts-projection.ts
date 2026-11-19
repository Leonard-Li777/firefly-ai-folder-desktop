import { buildPinyinIndexRow } from '../utils/pinyin-text'
import { LogCategory, logger, getCanonicalConceptName } from '@firefly/shared'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { resolveTagAliasesLangTable } from './database'

/**
 * 从受控标签 code 提取可读 slug 作为展示名兜底（builtin.* / omw.* / dim.xxx）
 * 对齐 file-dao/shared.ts 的同名实现，避免在索引中暴露技术代码。
 * （本服务不在 FileDaoSharedBase 继承链内，无法复用其受保护方法，故就地落一份。）
 */
function readableCode(code: string): string {
  if (!code) return code
  const parts = code.split('.')
  const slug = parts[parts.length - 1] || code
  return slug.replace(/_/g, ' ')
}

/**
 * FTS Projection Service (Ticket 10 · 全文检索与拼音正排联合投影).
 *
 * 统一承载：
 * 1. 拼音索引正排投影（write-through/reconciler 唯一归属）。
 * 2. 标签变更触发的 `files_fts` 倒排重建（contentless FTS：DELETE+INSERT，含 tags 列与拼音 write-through）。
 */
export class FtsProjectionService {
  constructor(private db: any) {}

  /**
   * 构建并写入拼音索引行（原 file-pinyin-fts-sync.ts 逻辑）。
   */
  projectPinyin(
    fingerprint: string,
    rid: number,
    fields: { name: string; smartName: string; description: string; tagsText: string }
  ): void {
    const row = buildPinyinIndexRow({
      name: fields.name,
      smartName: fields.smartName,
      description: fields.description,
      tags: fields.tagsText
    })

    if (!row) {
      this.db.prepare(`DELETE FROM files_pinyin_fts WHERE rowid = ?`).run(rid)
      return
    }

    this.db
      .prepare(
        `INSERT OR REPLACE INTO files_pinyin_fts(rowid, file_fingerprint, name_py, smart_name_py, description_py, tags_py, src_hash)
         VALUES (?,?,?,?,?,?,?)`
      )
      .run(
        rid,
        fingerprint,
        row.namePy,
        row.smartNamePy,
        row.descriptionPy,
        row.tagsPy,
        row.srcHash
      )
  }

  /**
   * 受控标签展示名解析（与 file-dao/shared.ts resolveDisplayName 同口径）：
   * 1. 中文环境下命中 AOT 受控权威概念字典（Canonical Concept）的受控代码 → 规范中文展示名；
   * 2. 本地 file_tags_private.name（动态/扩展标签）其次；
   * 3. 主库当前语言分表 tag_aliases_{lang} 直查再次；
   * 4. 仍未命中时以受控词表规范名或 code 可读 slug 兜底，绝不暴露技术代码。
   * @param code 标签 code（受控 builtin.* / omw.* / dim.xxx 或本地动态标签）
   * @param ftName 已从 file_tags_private 取到的本地展示名（无则传 null）
   */
  private resolveDisplayName(code: string, ftName: string | null): string {
    if (!code) return ftName || ''
    const locale = ConfigOrchestrator.getInstance().getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN'
    const isZh = locale.toLowerCase().startsWith('zh')

    // 1. 中文环境下，凡命中 AOT 受控权威概念字典的受控代码，强制采用规范中文展示名
    if (isZh) {
      const canonical = getCanonicalConceptName(code)
      if (canonical) return canonical
    }

    // 2. 本地 file_tags_private.name（自定义标签、动态扩展标签）
    if (ftName) {
      return ftName
    }

    // 3. 主库当前语言分表 tag_aliases_{lang} 直查
    try {
      const langTable = resolveTagAliasesLangTable(locale)
      const row = this.db
        .prepare(
          `SELECT lemma FROM ${langTable}
           WHERE tag_code = ? ORDER BY is_canonical DESC LIMIT 1`
        )
        .get(code) as { lemma?: string } | undefined
      if (row?.lemma) return row.lemma
    } catch (error) {
      // 分表不可用时降级，记录告警并走下方 canonical / slug 兜底，严禁静默吞错
      logger.warn(
        LogCategory.DATABASE_SERVICE,
        `[FtsProjection] 查询语言分表解析标签名失败 (code=${code}):`,
        error
      )
    }

    // 4. 非中文环境或分表未收录时的 AOT 规范名兜底
    const canonicalFallback = getCanonicalConceptName(code)
    if (canonicalFallback) return canonicalFallback

    return readableCode(code)
  }

  /**
   * 聚合某文件指纹的标签展示名文本（files_fts.tags 列与 files_pinyin_fts.tags_py 列共用）。
   * 受控标签展示名经主库语言分表 resolveDisplayName 解析（SQL 层无法访问该动态分表），故在 JS 侧聚合。
   */
  collectTagsText(fingerprint: string): string {
    try {
      const relationRows = this.db
        .prepare(
          `
          SELECT ftr.tag_code as id, ft.name as ft_name
          FROM file_tag_relations ftr
          LEFT JOIN file_tags_private ft ON ft.code = ftr.tag_code
          WHERE ftr.file_fingerprint = ?
        `
        )
        .all(fingerprint) as Array<{ id: string; ft_name: string | null }>
      return relationRows.map(r => this.resolveDisplayName(r.id, r.ft_name)).join(' ')
    } catch (error) {
      logger.warn(LogCategory.DATABASE_SERVICE, '聚合文件标签展示名失败', { error, fingerprint })
      return ''
    }
  }

  /**
   * 批量版 collectTagsText（reconciler 一次窗口一次 SQL）。
   * 返回 null 表示批量失败：调用方必须回退逐行 collectTagsText，绝不把失败当空串处理。
   */
  collectTagsTextBatch(fingerprints: string[]): Map<string, string> | null {
    if (fingerprints.length === 0) return new Map()
    const CHUNK = 400
    const grouped = new Map<string, string[]>()
    try {
      for (let i = 0; i < fingerprints.length; i += CHUNK) {
        const chunk = fingerprints.slice(i, i + CHUNK)
        const placeholders = chunk.map(() => '?').join(',')
        const rows = this.db
          .prepare(
            `
            SELECT ftr.file_fingerprint AS fp, ftr.tag_code AS id, ft.name AS ft_name
            FROM file_tag_relations ftr
            LEFT JOIN file_tags_private ft ON ft.code = ftr.tag_code
            WHERE ftr.file_fingerprint IN (${placeholders})
          `
          )
          .all(...chunk) as Array<{ fp: string; id: string; ft_name: string | null }>
        for (const r of rows) {
          const display = this.resolveDisplayName(r.id, r.ft_name)
          const arr = grouped.get(r.fp)
          if (arr) arr.push(display)
          else grouped.set(r.fp, [display])
        }
      }
      const out = new Map<string, string>()
      for (const [fp, arr] of grouped) out.set(fp, arr.join(' '))
      return out
    } catch (error) {
      logger.warn(LogCategory.DATABASE_SERVICE, '批量聚合文件标签展示名失败，回退逐行查询', {
        error,
        count: fingerprints.length
      })
      return null
    }
  }

  /**
   * 写入/刷新一行拼音正排索引（委托 projectPinyin，保证拼音投影唯一归属本服务）。
   * 与 files_fts 同源四字段（name/smart_name/description/tags），由调用方保证同事务。
   * rowid 对齐 files.id（R1 盲审 A-H1），寻址/删除 O(log n)。
   */
  private writePinyinIndexRow(
    fingerprint: string,
    rid: number,
    fields: { name: string; smartName: string; description: string; tagsText: string }
  ): void {
    this.projectPinyin(fingerprint, rid, fields)
  }

  /**
   * 标签变更后按业务表重建 FTS 倒排（含 tags 列）+ 拼音 write-through。
   *
   * Issue #661 contentless FTS：不能 UPDATE FTS 列，需按业务表 DELETE+INSERT 重建倒排。
   * 原体自 file-pinyin-fts-sync.ts 迁入，逻辑零改动；mixin 侧保留薄委托防双轨。
   *
   * 四源字段（name/smart_name/description + tagsText）与拼音列严格同源；
   * 拼音行与 files_fts 同事务写入、rowid 对齐（设计文档 §4.3）。
   */
  syncFTSTags(fingerprint: string): void {
    if (!fingerprint) return
    try {
      const row = this.db
        .prepare(
          `
          SELECT f.id AS rid, f.file_fingerprint,
            COALESCE((SELECT wf.name FROM workspace_files wf WHERE wf.file_fingerprint = f.file_fingerprint LIMIT 1), '') AS name,
            COALESCE(f.smart_name, '') AS smart_name,
            COALESCE(f.description, '') AS description,
            COALESCE(decompress_text(fc.content), '') AS content,
            COALESCE(decompress_text(fc.multimodal_content), '') AS multimodal_content,
            COALESCE(decompress_text(fc.ocr), '') AS ocr,
            COALESCE(decompress_text(fc.lrc), '') AS lrc,
            COALESCE(decompress_text(fc.asr), '') AS asr
          FROM files f
          LEFT JOIN file_contents fc ON fc.file_fingerprint = f.file_fingerprint
          WHERE f.file_fingerprint = ?
        `
        )
        .get(fingerprint) as any
      if (!row) return

      // FTS 倒排的 tags 列：受控标签展示名经主库语言分表 resolveDisplayName 解析
      //（SQL 层无法访问该动态分表），故在 JS 侧聚合，保证"设计稿/如云西点"等感知标签
      // 展示名可被全文搜索命中。
      const tagsText = this.collectTagsText(fingerprint)

      this.db.transaction(() => {
        this.db.prepare(`DELETE FROM files_fts WHERE rowid = ?`).run(row.rid)
        this.db
          .prepare(
            `INSERT INTO files_fts(rowid, file_fingerprint, name, smart_name, description, content, multimodal_content, ocr, lrc, asr, tags)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`
          )
          .run(
            row.rid,
            row.file_fingerprint,
            row.name,
            row.smart_name,
            row.description,
            row.content,
            row.multimodal_content,
            row.ocr,
            row.lrc,
            row.asr,
            tagsText
          )
        // 拼音正排索引 write-through（设计文档 §4.3）：与 files_fts 同事务，两端字段严格同源；
        // rowid 与 files.id 对齐（A-H1），寻址/删除 O(log n)
        this.writePinyinIndexRow(fingerprint, row.rid, {
          name: row.name,
          smartName: row.smart_name,
          description: row.description,
          tagsText
        })
      })()
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '同步FTS标签失败', { error, fingerprint })
    }
  }
}
