import { LogCategory, logger } from '@firefly/shared'
import { buildPinyinIndexRow, computePinyinSrcHash } from '../../../utils/pinyin-text'
import { FileCrudMixin } from './file-crud'
import { FtsProjectionService } from '../../fts-projection'

/**
 * FileDao 拼音正排索引同步 mixin（P1' 重构落新模块 · 融合方案 §3.1）。
 *
 * 承载写入侧唯一入口（设计文档 §4.3）：write-through（同事务写拼音行、rowid 对齐）、
 * reconciler（漏同步补写 + 陈旧 hash 刷新）、启动回填、标签文本聚合。
 *
 * 全部代码自 `file-query.ts` 原样搬移，未改动任何逻辑、命名或注释措辞。
 * FileQueryMixin extends FilePinyinFtsSyncMixin，门面方法签名不变，调用方零改动。
 */
export class FilePinyinFtsSyncMixin extends FileCrudMixin {
  private ftsProjection: FtsProjectionService

  constructor(db: any) {
    super(db)
    this.ftsProjection = new FtsProjectionService(db)
  }

  /**
   * 聚合某文件指纹的标签展示名文本（唯一实现收口于 FtsProjectionService）。
   */
  private collectTagsText(fingerprint: string): string {
    return this.ftsProjection.collectTagsText(fingerprint)
  }

  /**
   * 批量版 collectTagsText（唯一实现收口于 FtsProjectionService；返回 null 时回退逐行）。
   */
  private collectTagsTextBatch(fingerprints: string[]): Map<string, string> | null {
    return this.ftsProjection.collectTagsTextBatch(fingerprints)
  }

  /**
   * 收集拼音索引四源字段（name/smart_name/description/tagsText）。
   *
   * **写入侧与查询侧校验回填共用同一实现**（设计文档 §5.3）：索引里存的是这四个字段的拼音，
   * 回填校验必须用同一口径重建原文，否则会出现「召回得到、校验失败」的静默不一致。
   * 文件不存在时返回 null。
   */
  getPinyinSourceFields(fingerprint: string): {
    name: string
    smartName: string
    description: string
    tagsText: string
  } | null {
    if (!fingerprint) return null
    try {
      const row = this.db
        .prepare(
          `
          SELECT
            COALESCE((SELECT wf.name FROM workspace_files wf WHERE wf.file_fingerprint = f.file_fingerprint LIMIT 1), '') AS name,
            COALESCE(f.smart_name, '') AS smart_name,
            COALESCE(f.description, '') AS description
          FROM files f
          WHERE f.file_fingerprint = ?
        `
        )
        .get(fingerprint) as { name: string; smart_name: string; description: string } | undefined
      if (!row) return null
      return {
        name: row.name,
        smartName: row.smart_name,
        description: row.description,
        tagsText: this.collectTagsText(fingerprint)
      }
    } catch (error) {
      logger.warn(LogCategory.DATABASE_SERVICE, '[PinyinIndex] 读取文件拼音源字段失败:', error)
      return null
    }
  }

  /**
   * 写入/刷新一行拼音正排索引（files_pinyin_fts，设计文档 §4.3）。
   * 与 files_fts 同源四字段（name/smart_name/description/tags），由调用方保证同事务。
   *
   * **rowid 对齐**（R1 盲审 A-H1）：拼音行 rowid = files.id（与 files_fts 完全同构），
   * 寻址/删除走 rowid（O(log n)）；早期按 file_fingerprint（UNINDEXED 列）寻址对 FTS5
   * 是全表扫描，批量写入 N 个文件累计 O(N²)，万级库上写入热路径不可用。
   * 单语句 `INSERT OR REPLACE`（FTS5 支持显式 rowid 的冲突替换，实测验证）替代 DELETE+INSERT。
   * 四列均无中文时删除既有拼音行（防陈旧残留，如文件改名为纯 ASCII）。
   */
  private writePinyinIndexRow(
    fingerprint: string,
    rid: number,
    fields: { name: string; smartName: string; description: string; tagsText: string }
  ): void {
    // 薄委托：拼音行构建与写入唯一归属 FtsProjectionService.projectPinyin（工单 08 §8.2），
    // 消除本 mixin 内联 SQL 与投影服务的双轨。rowid 对齐 / 纯 ASCII 删行等语义均在投影侧实现。
    this.ftsProjection.projectPinyin(fingerprint, rid, fields)
  }

  syncFTSTags(fingerprint: string): void {
    // 薄委托：FTS 倒排重建（含 tags 列）+ 拼音 write-through 统一归属 FtsProjectionService，
    // 防止本 mixin 与投影服务出现两份实现（工单 08 §8.1）。逻辑已整体迁入 fts-projection.ts。
    this.ftsProjection.syncFTSTags(fingerprint)
  }

  syncFTSTagsBatch(fingerprints: string[]): void {
    if (!fingerprints || fingerprints.length === 0) return
    const uniqueFingerprints = Array.from(new Set(fingerprints.filter(Boolean)))
    if (uniqueFingerprints.length === 0) return

    try {
      this.db.transaction(() => {
        for (const fp of uniqueFingerprints) {
          this.syncFTSTags(fp)
        }
      })()
      logger.debug(
        LogCategory.DATABASE_SERVICE,
        `[FileDao] 批量同步 FTS 标签完成，共 ${uniqueFingerprints.length} 项`
      )
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '批量同步FTS标签失败', error)
    }
  }

  /** 拼音索引当前行数（启动回填判定用：行数 < files 行数即存在缺口） */
  countPinyinIndexRows(): number {
    try {
      const r = this.db.prepare(`SELECT COUNT(*) AS n FROM files_pinyin_fts`).get() as
        | { n: number }
        | undefined
      return r?.n ?? 0
    } catch (error) {
      logger.warn(
        LogCategory.DATABASE_SERVICE,
        '[PinyinIndex] 读取 files_pinyin_fts 行数失败:',
        error
      )
      return 0
    }
  }

  /**
   * 拼音索引 reconciler（设计文档 §4.3）：按 rowid 窗口扫描 files，
   * 对拼音行缺失或 src_hash 陈旧的指纹重算写入；hash 命中跳过（不重算拼音，热路径近零成本）。
   * 覆盖不走 syncFTSTags 的变更路径（如触发器维护的 smart_name/description 更新）。
   * 窗口游标内存推进、越界绕回表头；每次调用处理最多 limit 个文件。返回实际刷新行数。
   */
  syncPinyinIndexDirty(limit = 300): number {
    if (limit <= 0) return 0
    let rewritten = 0
    try {
      this.db.transaction(() => {
        const rows = this.db
          .prepare(
            `
            SELECT f.id AS rid, f.file_fingerprint,
              COALESCE((SELECT wf.name FROM workspace_files wf WHERE wf.file_fingerprint = f.file_fingerprint LIMIT 1), '') AS name,
              COALESCE(f.smart_name, '') AS smart_name,
              COALESCE(f.description, '') AS description
            FROM files f
            WHERE f.id > ?
            ORDER BY f.id
            LIMIT ?
          `
          )
          .all(this.pinyinScanCursor, limit) as Array<{
          rid: number
          file_fingerprint: string
          name: string
          smart_name: string
          description: string
        }>
        if (rows.length === 0) {
          // 越界：绕回表头（覆盖窗口推进期间新插入的文件）
          this.pinyinScanCursor = 0
          return
        }
        this.pinyinScanCursor = rows[rows.length - 1].rid

        const hashStmt = this.db.prepare(`SELECT src_hash FROM files_pinyin_fts WHERE rowid = ?`)
        // 人工裁定项①：标签文本一次窗口一次 SQL 批量预取；批量失败回退逐行（绝不静默按空串处理）
        const tagsBatch = this.collectTagsTextBatch(rows.map(r => r.file_fingerprint))
        for (const r of rows) {
          const tagsText = tagsBatch
            ? (tagsBatch.get(r.file_fingerprint) ?? '')
            : this.collectTagsText(r.file_fingerprint)
          const hash = computePinyinSrcHash({
            name: r.name,
            smartName: r.smart_name,
            description: r.description,
            tags: tagsText
          })
          const existing = hashStmt.get(r.rid) as { src_hash: string } | undefined
          if (existing && existing.src_hash === hash) continue // 陈旧检测未命中：跳过
          const row = buildPinyinIndexRow({
            name: r.name,
            smartName: r.smart_name,
            description: r.description,
            tags: tagsText
          })
          if (!row && !existing) continue // 无中文且无既有行：无需操作
          this.writePinyinIndexRow(r.file_fingerprint, r.rid, {
            name: r.name,
            smartName: r.smart_name,
            description: r.description,
            tagsText
          })
          rewritten++
        }
      })()
      if (rewritten > 0) {
        logger.debug(
          LogCategory.DATABASE_SERVICE,
          `[FileDao] 拼音索引 reconciler 刷新 ${rewritten} 行`
        )
      }
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '拼音索引 reconciler 失败', error)
      return -1 // 失败信号：调用方（启动回填）据此提前退出，防 busy_timeout 逐次击穿预算
    }
    return rewritten
  }

  /**
   * 启动回填：循环推进窗口直到绕回表头（一圈完成）或超出时间预算。
   * 返回刷新行数；供数据库初始化完成后调用（应用未上线，无迁移兼容负担）。
   *
   * 行数缺口闸（设计文档 §4.4）：拼音行数 >= files 行数即无缺口直接跳过；
   * 无中文文件会造成恒定小缺口，此时 hash 闸以近零成本逐行跳过（rowid 寻址，A-H1）。
   */
  syncPinyinIndexBackfill(timeBudgetMs = 10_000): number {
    const start = Date.now()
    let total = 0
    try {
      const filesCount =
        (this.db.prepare(`SELECT COUNT(*) AS n FROM files`).get() as { n: number } | undefined)
          ?.n ?? 0
      if (this.countPinyinIndexRows() >= filesCount) return 0

      let consecutiveFailures = 0
      while (Date.now() - start < timeBudgetMs) {
        const n = this.syncPinyinIndexDirty(500)
        if (n < 0) {
          if (++consecutiveFailures >= 2) break
          continue
        }
        consecutiveFailures = 0
        total += n
        // cursor 绕回 0 = 完整一圈扫描完成（含越界重置与空库直返）
        if (this.pinyinScanCursor === 0) break
      }
      if (total > 0) {
        logger.debug(LogCategory.DATABASE_SERVICE, `[FileDao] 拼音索引启动回填完成：${total} 行`)
      }
      if (this.pinyinScanCursor !== 0) {
        logger.warn(
          LogCategory.DATABASE_SERVICE,
          '拼音索引启动回填未完成（预算耗尽或连续失败），余量交由进程内 reconciler 续扫',
          { elapsedMs: Date.now() - start, cursor: this.pinyinScanCursor }
        )
      }
      // trigram 表 DELETE 不回收段结构：**确有写入或未完成时**才 optimize——
      // healthy 库（缺口闸直接跳过）不必在启动路径付全表段合并成本（R2 盲审 M1）
      if (total > 0 || this.pinyinScanCursor !== 0) this.optimizePinyinIndex()
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '拼音索引启动回填失败', error)
    }
    return total
  }

  /**
   * FTS5 optimize：合并段结构。trigram 表 DELETE 后不回收段，长期增删会膨胀，
   * 启动回填后执行一次（R1 盲审超纲建议，低挂果实：一行 SQL）。
   */
  optimizePinyinIndex(): void {
    try {
      this.db.prepare(`INSERT INTO files_pinyin_fts(files_pinyin_fts) VALUES('optimize')`).run()
    } catch (error) {
      logger.warn(LogCategory.DATABASE_SERVICE, '拼音索引 optimize 失败（不影响功能）', { error })
    }
  }
}
