import { describe, it, expect, beforeEach } from 'vitest'
import '../../../../../../pro/tests/mocks/electron-mock'
import Database from 'better-sqlite3'
import path from 'path'
import { TagTreeQuery } from '../TagTreeQuery'
import { GENESIS_V1_SCHEMA } from '../../../database/database'

/** 模型 B 夹具助手：把 code_path 拆段写入 tag_paths + tag_path_ancestors，返回 path_id。 */
function seedPath(db: Database.Database, codePath: string, viaParentCode = ''): number {
  const segs = codePath.split('/').filter(Boolean)
  db.prepare('INSERT OR IGNORE INTO tag_paths (leaf_code, via_parent_code, code_path, depth) VALUES (?, ?, ?, ?)')
    .run(segs[segs.length - 1] || '', viaParentCode, codePath, segs.length)
  const row = db.prepare('SELECT path_id FROM tag_paths WHERE code_path = ?').get(codePath) as { path_id: number }
  const ins = db.prepare('INSERT OR IGNORE INTO tag_path_ancestors (ancestor_code, path_id) VALUES (?, ?)')
  for (const seg of segs) ins.run(seg, row.path_id)
  return row.path_id
}

describe('TagTreeQuery Union Capacity & AST Depth Guard', () => {
  let db: Database.Database
  let query: TagTreeQuery
  const testDir = path.join('D:', 'test')

  beforeEach(() => {
    db = new Database(':memory:')
    db.function('decompress_text', val => val)
    db.function('compress_text', val => val)
    db.function('should_ignore_file', () => 0)
    db.exec(GENESIS_V1_SCHEMA)
    query = new TagTreeQuery(db)

    db.prepare("INSERT INTO workspaces (workspace_id, name, path) VALUES (1, 'TestWS', ?)").run(testDir)
    db.prepare("INSERT INTO workspace_directories (id, workspace_id, name, path) VALUES (1, 1, 'test', ?)").run(testDir)

    const now = new Date().toISOString()
    const fp = 'fp_1'
    const filePath = path.join(testDir, '文件_1.txt')
    db.prepare(
      'INSERT INTO files (file_fingerprint, smart_name, extension, size, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(fp, '文件_1.txt', 'txt', 1024, now, now)

    db.prepare(
      'INSERT INTO workspace_files (id, workspace_id, directory_id, file_fingerprint, name, path, is_analyzed, created_at, modified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(101, 1, 1, fp, '文件_1.txt', filePath, 1, now, now)

    const cpTag1 = '/builtin.content_tags/tag_1'
    const pathId = seedPath(db, cpTag1, 'builtin.content_tags')
    db.prepare(
      'INSERT INTO file_tag_relations (file_fingerprint, tag_code, via_parent_code, path_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(fp, 'tag_1', 'builtin.content_tags', pathId, Date.now(), Date.now())
  })

  it('500 个标签在 union 模式下通过分块 UNION 成功返回文件，彻底修复 Expression tree is too large 崩溃', async () => {
    const selectedTags: any[] = []
    selectedTags.push({
      dimensionId: 28,
      dimensionName: '内容标签',
      tagValue: '标签_1',
      code: 'tag_1',
      codePath: '/builtin.content_tags/tag_1',
      viaParentCode: 'builtin.content_tags',
      level: 2
    })
    for (let i = 2; i <= 500; i++) {
      selectedTags.push({
        dimensionId: 28,
        dimensionName: '内容标签',
        tagValue: `标签_${i}`,
        code: `tag_${i}`,
        codePath: `/builtin.file_type/builtin.image/tag_${i}`,
        viaParentCode: 'builtin.image',
        level: 3
      })
    }

    // 1. 测试分页列表查询
    const pagedResult = await query.getFilteredFilesPaged({
      selectedTags,
      unionMode: 'union',
      workspaceDirectoryPath: testDir,
      sortBy: 'name',
      sortOrder: 'asc',
      limit: 100,
      offset: 0
    })
    expect(pagedResult.total).toBe(1)
    expect(pagedResult.items.length).toBe(1)
    expect(pagedResult.items[0].name).toBe('文件_1.txt')

    // 2. 测试全量列表查询
    const fullResult = await query.getFilteredFiles({
      selectedTags,
      unionMode: 'union',
      workspaceDirectoryPath: testDir,
      sortBy: 'name',
      sortOrder: 'asc'
    })
    expect(fullResult.length).toBe(1)
    expect(fullResult[0].name).toBe('文件_1.txt')
  })

  it('测试分块 UNION 在 1000 个标签下的执行性能与稳定性', () => {
    const clauses: string[] = []
    const params: any[] = []
    for (let i = 1; i <= 1000; i++) {
      clauses.push(`(tp.code_path = ? OR tp.code_path LIKE (? || '/%') ESCAPE '\\')`)
      params.push(`/builtin.file_type/builtin.image/tag_${i}`, `/builtin.file_type/builtin.image/tag_${i}`)
    }

    const CHUNK_SIZE = 30
    const subSelects: string[] = []
    for (let i = 0; i < clauses.length; i += CHUNK_SIZE) {
      const chunk = clauses.slice(i, i + CHUNK_SIZE)
      subSelects.push(`SELECT ftr.file_fingerprint FROM file_tag_relations ftr JOIN tag_paths tp ON tp.path_id = ftr.path_id WHERE ${chunk.join(' OR ')}`)
    }
    const unionSql = subSelects.join(' UNION ')

    const sql = `
      SELECT COUNT(*) as cnt
      FROM workspace_files wf
      WHERE wf.file_fingerprint IN (${unionSql})
    `

    const t0 = performance.now()
    const stmt = db.prepare(sql)
    const res = stmt.get(...params) as { cnt: number }
    const cost = performance.now() - t0
    expect(cost).toBeLessThan(200) // 必须在 200ms 内完成，实测约 10ms
    expect(res.cnt).toBe(0)
  })
})
