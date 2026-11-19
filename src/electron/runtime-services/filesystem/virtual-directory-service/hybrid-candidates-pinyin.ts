import type { Database } from 'better-sqlite3'
import { LogCategory, logger } from '@firefly/shared'
import type { FileDao } from '../../database/dao/file-dao'
import { verifyTextPinyin, type PinyinMatchType } from '../../utils/pinyin-text'
import type { PinyinQueryPlan } from './pinyin-query-expander'
import type { PinyinVerifyHit } from './HybridSearchArbiter'

/**
 * 拼音候选源模块（P2' 重构落新模块 · 融合方案 §3.1 / §3.2）。
 *
 * 读取/复核唯一入口：从 HybridSearchArbiter 抽出拼音 FTS 召回（query）与
 * 音节边界校验回填（verify）两路逻辑。构造器只接收 db 连接与 FileDao 工厂，
 * 藏住 SQL 询项构造、列/类型加权排序表与四源字段回填细节（深模块：小接口、多实现）。
 *
 * 全部代码自 `HybridSearchArbiter.ts` 原样搬移，仅将 `this.db` / `this.getFileDao()`
 * 改为注入参数，未改动任何 SQL、加权、排序或注释措辞。
 */

/**
 * 拼音正排索引第 6 路候选（files_pinyin_fts，设计文档 §5.2）。
 *
 * 纯字母查询直接 MATCH 拼音索引——不经过任何「拼音→中文」封闭词表：
 * - len >= 3 token → trigram 子串匹配（全拼与首字母缩写通用）；
 * - len == 2 token → 独立双字词精确匹配（索引侧同词 run 存为首尾补空格的 token，
 *   故 " cw " 只命中独立成词的「财务」；句子内部缩写仍受 >=3 约束——已裁决边界）。
 *
 * bm25 权重按虚拟表物理声明列顺序赋值（file_fingerprint/name_py/smart_name_py/
 * description_py/tags_py/src_hash），UNINDEXED 两列必须赋 0.0 占位防错位。
 */
export function queryPinyinCandidates(
  db: Database,
  plan: PinyinQueryPlan,
  whereClauses: string[],
  queryParams: any[],
  poolSize: number
): string[] {
  if (!plan.isPinyin || plan.pinyinTokens.length === 0) return []
  try {
    const tableExists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='files_pinyin_fts'`)
      .get()
    if (!tableExists) return []

    // token → FTS5 MATCH 询项（2 字符加首尾空格做独立词精确匹配）
    const orTerms = plan.pinyinTokens.map(t => (t.length >= 3 ? `"${t}"` : `" ${t} "`))
    const matchExpr = orTerms.join(' OR ')
    const extraWhere = whereClauses.length > 0 ? `AND ${whereClauses.join(' AND ')}` : ''

    // 同一文件在 workspace_files 多行（多工作区/多路径）会重复占用 LIMIT 名额并扭曲 rank 分布：
    // 子查询按 fp 去重（MIN(rowid) 定代表行）后回连做 bm25 排序（R1 盲审 B-M3）。
    // 约束：SQLite 禁止 bm25 辅助函数进入聚合上下文——MIN(bm25(...)) 与 GROUP BY + ORDER BY bm25
    // 均实测报 "unable to use function bm25 in the requested context"，故采用两段式。
    // files 按 id 连接（拼音行 rowid = files.id，A-H1 对齐，与冷热双 FTS 路径同构）。
    const rows = db
      .prepare(
        `
        SELECT fp AS file_fingerprint FROM (
          SELECT f.file_fingerprint AS fp, MIN(files_pinyin_fts.rowid) AS rid
          FROM files_pinyin_fts
          JOIN files f ON f.id = files_pinyin_fts.rowid
          JOIN workspace_files wf ON wf.file_fingerprint = f.file_fingerprint
          WHERE files_pinyin_fts MATCH ?
            ${extraWhere}
          GROUP BY f.file_fingerprint
        )
        JOIN files_pinyin_fts ON files_pinyin_fts.rowid = rid
        ORDER BY bm25(files_pinyin_fts, 0.0, 4.0, 4.0, 3.0, 3.5, 0.0) ASC
        LIMIT ?
      `
      )
      .all(matchExpr, ...queryParams, poolSize) as Array<{ file_fingerprint: string }>
    return rows.map(r => r.file_fingerprint)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn(
      LogCategory.VIRTUAL_DIRECTORY,
      '[HybridSearchArbiter] 拼音索引检索失败，降级: ',
      msg
    )
    return []
  }
}

/**
 * 拼音路候选校验回填（设计文档 §5.3；二轮 review 红线：Top-30 限量）。
 *
 * 对召回候选读回四源字段（与索引写入严格同源），复用 pinyin-text.ts 构造器现算拼音：
 * - 音节边界对齐硬约束：跨音节截断（anxiao 对 kehuanxiaoshuo）判假阳性丢弃，
 *   绝不生成 <mark> 高亮（从机制上杜绝错误高亮）；
 * - 命中分级：全拼精确 > 全拼音节切片 > 首字母缩写；列间 name/smart_name/tags > description；
 * - token 越长越优先（更具体的查询项胜出）。
 *
 * 返回 fingerprint → 最优命中；无命中（假阳性被滤光）的指纹不出现在 map 中。
 */
export function verifyPinyinCandidates(
  getFileDao: () => FileDao,
  plan: PinyinQueryPlan,
  fingerprints: string[],
  limit = 30
): Map<string, PinyinVerifyHit> {
  const out = new Map<string, PinyinVerifyHit>()
  if (!plan.isPinyin || plan.pinyinTokens.length === 0) return out
  const dao = getFileDao()
  const columnRank: Record<PinyinVerifyHit['column'], number> = {
    name: 0,
    smart_name: 0,
    tags: 0,
    description: 1
  }
  const typeRank: Record<PinyinMatchType, number> = {
    full: 3,
    'full-slice': 2,
    initials: 1
  }

  for (const fp of fingerprints.slice(0, limit)) {
    const fields = dao.getPinyinSourceFields(fp)
    if (!fields) continue
    let best: PinyinVerifyHit | null = null
    for (const token of plan.pinyinTokens) {
      const columns: Array<[PinyinVerifyHit['column'], string]> = [
        ['name', fields.name],
        ['smart_name', fields.smartName],
        ['tags', fields.tagsText],
        ['description', fields.description]
      ]
      for (const [column, text] of columns) {
        const hit = verifyTextPinyin(text, token)
        if (!hit) continue
        const candidate: PinyinVerifyHit = {
          matchedText: hit.matchedText,
          type: hit.type,
          column,
          token
        }
        if (
          !best ||
          typeRank[candidate.type] > typeRank[best.type] ||
          (typeRank[candidate.type] === typeRank[best.type] &&
            (columnRank[candidate.column] < columnRank[best.column] ||
              (columnRank[candidate.column] === columnRank[best.column] &&
                candidate.token.length > best.token.length)))
        ) {
          best = candidate
        }
      }
    }
    if (best) out.set(fp, best)
  }
  return out
}
