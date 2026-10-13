import type Database from 'better-sqlite3'
import { logger, LogCategory, getCanonicalConceptName } from '@firefly/shared'
import { resolveTagAliasesLangTable } from './database'

function readableCode(code: string): string {
  if (!code) return code
  const parts = code.split('.')
  const slug = parts[parts.length - 1] || code
  return slug.replace(/_/g, ' ')
}

export interface RebuildNamePathsResult {
  distinctPathsCount: number
  updatedCount: number
}

/**
 * 按指定语言全量重建 file_tag_relations 中的 name_path 物化路径
 * 
 * 核心原理：
 * 1. code_path 是机器受控码路径（语言无关，如 /builtin.file_type/builtin.document/builtin.chinese）；
 * 2. 当用户切换系统语言时，不能直接复用旧语言的 name_path（如 /文件类型/文档/中文）；
 * 3. 本函数读取 distinct code_path，直接根据 code 批量查主库目标语言分表 tag_aliases_{lang}（SSOT 事实源）；
 * 4. 在单个事务中批量更新 file_tag_relations.name_path，耗时通常 < 5ms，确保新语言下可直接复用物化路径。
 */
export function rebuildNamePaths(
  db: Database.Database,
  targetLocale: string
): RebuildNamePathsResult {
  if (!db || !targetLocale) {
    return { distinctPathsCount: 0, updatedCount: 0 }
  }

  // 1. 检查 file_tag_relations 表是否存在
  const hasFtr = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'file_tag_relations'"
  ).get()
  if (!hasFtr) {
    return { distinctPathsCount: 0, updatedCount: 0 }
  }

  // 2. 查出所有不同的非空 code_path
  const distinctRows = db.prepare(
    `SELECT DISTINCT code_path FROM file_tag_relations WHERE code_path IS NOT NULL AND code_path != ''`
  ).all() as Array<{ code_path: string }>

  if (distinctRows.length === 0) {
    return { distinctPathsCount: 0, updatedCount: 0 }
  }

  const isZh = targetLocale.toLowerCase().startsWith('zh')

  // 3. 收集所有路径中出现的所有 tag code segment
  const allCodesSet = new Set<string>()
  for (const row of distinctRows) {
    const segs = row.code_path.split('/').map(s => s.trim()).filter(Boolean)
    for (const seg of segs) {
      allCodesSet.add(seg)
    }
  }

  const allCodes = Array.from(allCodesSet)
  const codeToNameMap = new Map<string, string>()

  // 4. 解析目标语言展示名（SSOT：直接查目标语言分表 tag_aliases_{lang}）
  const langTable = resolveTagAliasesLangTable(targetLocale)
  const hasLangTable = db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(langTable)

  if (hasLangTable && allCodes.length > 0) {
    for (let i = 0; i < allCodes.length; i += 200) {
      const chunk = allCodes.slice(i, i + 200)
      const placeholders = chunk.map(() => '?').join(',')
      try {
        const rows = db.prepare(
          `SELECT tag_code, lemma FROM ${langTable} WHERE tag_code IN (${placeholders}) ORDER BY is_canonical DESC, n DESC`
        ).all(...chunk) as Array<{ tag_code: string; lemma: string }>

        for (const r of rows) {
          if (!codeToNameMap.has(r.tag_code) && r.lemma) {
            codeToNameMap.set(r.tag_code, r.lemma)
          }
        }
      } catch (err) {
        logger.warn(LogCategory.DATABASE, `[rebuildNamePaths] 查询分表 ${langTable} 异常:`, err)
      }
    }
  }

  // 4.1 若目标语言为中文，且分表未收录，查 AOT 受控概念字典兜底
  if (isZh) {
    for (const code of allCodes) {
      if (!codeToNameMap.has(code)) {
        const canonical = getCanonicalConceptName(code)
        if (canonical) {
          codeToNameMap.set(code, canonical)
        }
      }
    }
  }

  // 4.2 本地私有标签表 file_tags_private（用于用户自定义标签、动态扩展标签）
  const unmappedCodes = allCodes.filter(c => !codeToNameMap.has(c))
  if (unmappedCodes.length > 0) {
    const hasFtp = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'file_tags_private'"
    ).get()
    if (hasFtp) {
      for (let i = 0; i < unmappedCodes.length; i += 200) {
        const chunk = unmappedCodes.slice(i, i + 200)
        const placeholders = chunk.map(() => '?').join(',')
        try {
          const rows = db.prepare(
            `SELECT code, name FROM file_tags_private WHERE code IN (${placeholders})`
          ).all(...chunk) as Array<{ code: string; name: string }>
          for (const r of rows) {
            if (r.name && !codeToNameMap.has(r.code)) {
              codeToNameMap.set(r.code, r.name)
            }
          }
        } catch {}
      }
    }
  }

  // 4.3 最终可读性兜底（code 本身或 slug）
  for (const code of allCodes) {
    if (!codeToNameMap.has(code)) {
      const canonical = getCanonicalConceptName(code)
      codeToNameMap.set(code, canonical || readableCode(code))
    }
  }

  // 5. 构造每个 distinct code_path 对应的 newNamePath
  const updates: Array<{ codePath: string; newNamePath: string }> = []
  for (const { code_path } of distinctRows) {
    const segs = code_path.split('/').map(s => s.trim()).filter(Boolean)
    const nameSegs = segs.map(code => codeToNameMap.get(code) || code)
    const newNamePath = `/${nameSegs.join('/')}`
    updates.push({ codePath: code_path, newNamePath })
  }

  // 6. 事务批量更新
  const updateStmt = db.prepare(
    `UPDATE file_tag_relations SET name_path = ? WHERE code_path = ? AND name_path != ?`
  )

  const runTx = db.transaction((items: Array<{ codePath: string; newNamePath: string }>) => {
    let totalUpdated = 0
    for (const item of items) {
      const info = updateStmt.run(item.newNamePath, item.codePath, item.newNamePath)
      totalUpdated += info.changes
    }
    return totalUpdated
  })

  const totalUpdated = runTx(updates)

  return {
    distinctPathsCount: distinctRows.length,
    updatedCount: totalUpdated
  }
}
