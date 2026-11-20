import { buildPinyinIndexRow } from '../utils/pinyin-text'
import { LogCategory, logger, getCanonicalConceptName } from '@firefly/shared'
// Stage2 S-B：展示 locale 经纯缝读取（主进程由 ConfigOrchestrator 注册读取器，
// 写进程子入口由 INIT 握手注入），严禁在本文件静态引入 electron-conf 依赖链
import { readDisplayLocale } from './database-service/display-locale-seam'
import { normalizeSupportedLocale } from './database-service/locale-whitelist'
import * as path from 'node:path'

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
 * 2. 冷热双 FTS5 投影：热元数据 syncMetaFts / 冷正文 syncBodyFts 同事务直写，拼音 write-through。
 */
export class FtsProjectionService {
  constructor(private db: any) {}

  /**
   * 构建并写入拼音索引行（原 file-pinyin-fts-sync.ts 逻辑）。
   * 返回 true 表示写入了中文拼音行，false 表示无中文并已清理旧行；
   * 支持透传 prebuiltRow 避免调用方判空与写入重复计算。
   */
  projectPinyin(
    fingerprint: string,
    rid: number,
    fields: { name: string; smartName: string; description: string; tagsText: string },
    prebuiltRow?: ReturnType<typeof buildPinyinIndexRow>
  ): boolean {
    const row =
      prebuiltRow !== undefined
        ? prebuiltRow
        : buildPinyinIndexRow({
            name: fields.name,
            smartName: fields.smartName,
            description: fields.description,
            tags: fields.tagsText
          })

    if (!row) {
      this.db.prepare(`DELETE FROM files_pinyin_fts WHERE rowid = ?`).run(rid)
      return false
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
    return true
  }

  /**
   * 受控标签展示名解析（与 file-dao/shared.ts resolveDisplayName 同口径）：
   * 1. 中文环境下命中 AOT 受控权威概念字典（Canonical Concept）的受控代码 → 规范中文展示名；
   * 2. 本地 file_tags_private.name（动态/扩展标签）其次；
   * 3. 主库当前语言分表 tag_aliases 直查再次；
   * 4. 仍未命中时以受控词表规范名或 code 可读 slug 兜底，绝不暴露技术代码。
   * @param code 标签 code（受控 builtin.* / omw.* / dim.xxx 或本地动态标签）
   * @param ftName 已从 file_tags_private 取到的本地展示名（无则传 null）
   */
  private resolveDisplayName(code: string, ftName: string | null): string {
    if (!code) return ftName || ''
    // Stage2 S-B：经纯缝读取展示 locale（主进程=ConfigOrchestrator 注册；子进程=INIT 握手注入）
    const locale = readDisplayLocale()
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

    // 3. 主库当前语言别名单表 tag_aliases 直查（Issue 02：locale 普通列，参数化零拼表）
    try {
      const safeLocale = normalizeSupportedLocale(locale)
      const row = this.db
        .prepare(
          `SELECT lemma FROM tag_aliases
           WHERE locale = ? AND tag_code = ? AND is_canonical = 1 LIMIT 1`
        )
        .get(safeLocale, code) as { lemma?: string } | undefined
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
   * 聚合某文件指纹的标签展示名文本（files_pinyin_fts.tags_py 列，热元数据 FTS 不再存 tags 裸码列）。
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
   * Issue 03 Step 2：热元数据同事务直写（零 BLOB 解压、零 tags 裸码列）。
   * rowid 显式锚定 files.id（VACUUM 免疫），标签变更时置 pinyin_state=0 供 P1-D 回填。
   */
  syncMetaFts(
    fileId: number,
    meta: {
      fileFingerprint: string
      name: string
      smartName?: string
      description?: string
      author?: string
    }
  ): void {
    if (!fileId) return
    this.db.prepare(`DELETE FROM files_meta_fts WHERE rowid = ?`).run(fileId)
    this.db
      .prepare(
        `INSERT INTO files_meta_fts(rowid, file_fingerprint, name, smart_name, description, author)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        fileId,
        meta.fileFingerprint,
        meta.name ?? '',
        meta.smartName ?? '',
        meta.description ?? '',
        meta.author ?? ''
      )
    // 元数据文本变化 → 拼音投影陈旧；纯 ASCII（state=2）永久免重扫
    this.db
      .prepare(`UPDATE files SET pinyin_state = 0 WHERE id = ? AND pinyin_state <> 2`)
      .run(fileId)
  }

  /** Issue 03 Step 2：冷正文同事务直写明文，禁止从 file_contents 反读解压 */
  syncBodyFts(
    fileId: number,
    body: {
      fileFingerprint: string
      content?: string
      multimodalContent?: string
      ocr?: string
      lrc?: string
      asr?: string
    }
  ): void {
    if (!fileId) return
    this.db.prepare(`DELETE FROM files_body_fts WHERE rowid = ?`).run(fileId)
    this.db
      .prepare(
        `INSERT INTO files_body_fts(rowid, file_fingerprint, content, multimodal_content, ocr, lrc, asr)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        fileId,
        body.fileFingerprint,
        body.content ?? '',
        body.multimodalContent ?? '',
        body.ocr ?? '',
        body.lrc ?? '',
        body.asr ?? ''
      )
  }

  /**
   * 按指纹解析 files.id 后投影冷正文（写入方只有 fingerprint 时的薄适配）。
   * rowid 依旧显式锚定 files.id；查不到文件时告警返回，绝不构造错位 FTS 行。
   */
  syncBodyFtsByFingerprint(
    fingerprint: string,
    body: {
      content?: string
      multimodalContent?: string
      ocr?: string
      lrc?: string
      asr?: string
    }
  ): void {
    if (!fingerprint) return
    const row = this.db
      .prepare('SELECT id FROM files WHERE file_fingerprint = ?')
      .get(fingerprint) as { id: number } | undefined
    if (!row) {
      logger.warn(LogCategory.DATABASE_SERVICE, '[FtsProjection] 冷正文投影跳过：文件不存在', {
        fingerprint
      })
      return
    }
    this.syncBodyFts(row.id, { fileFingerprint: fingerprint, ...body })
  }

  /**
   * 兼容入口（标签变更 / 手动改标）：仅重建热元数据 + 拼音行。
   * 冷正文由持有明文的写入方调 syncBodyFts，严禁在此解压 BLOB。
   */
  syncFTSTags(fingerprint: string): void {
    if (!fingerprint) return
    try {
      const row = this.db
        .prepare(
          `SELECT f.id AS rid, f.file_fingerprint,
            COALESCE((SELECT wf.name FROM workspace_files wf WHERE wf.file_fingerprint = f.file_fingerprint LIMIT 1), '') AS name,
            COALESCE(f.smart_name, '') AS smart_name,
            COALESCE(f.description, '') AS description,
            COALESCE(f.author, '') AS author
          FROM files f WHERE f.file_fingerprint = ?`
        )
        .get(fingerprint) as any
      if (!row) return
      const tagsText = this.collectTagsText(fingerprint)
      this.db.transaction(() => {
        this.syncMetaFts(row.rid, {
          fileFingerprint: row.file_fingerprint,
          // Spec §Step2：热元数据 name 存去后缀基名（扩展名另有独立列，避免双写放大）
          name: path.basename(row.name, path.extname(row.name)),
          smartName: row.smart_name,
          description: row.description,
          author: row.author
        })
        this.projectPinyin(row.rid ? row.file_fingerprint : fingerprint, row.rid, {
          name: row.name,
          smartName: row.smart_name,
          description: row.description,
          tagsText
        })
      })()
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '同步冷热 FTS 热路失败', { error, fingerprint })
    }
  }
}
