/**
 * Issue 03 Step 4：冷热双 FTS5 真实 VACUUM 防错位 + 同事务直写 + P1-D 状态闭环。
 */
import Database from 'better-sqlite3'

vi.mock('electron-conf', () => ({ Conf: class { get() { return undefined } set() {} } }))
vi.mock('fix-path', () => ({ default: () => {} }))

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/firefly-vacuum-test', on: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { on: vi.fn(), handle: vi.fn() },
  shell: { openExternal: vi.fn() }
}))
import { describe, it, expect, vi } from 'vitest'

import {
  GENESIS_V1_SCHEMA,
  ensureTagPath
} from '../database'
import { FtsProjectionService } from '../fts-projection'
import { FileDao } from '../dao/file-dao'

function makeDb(): Database.Database {
  const db = new Database(':memory:')
  // 故意不注册 decompress_text：冷热双 FTS 创世 DDL 已废除全部内联解压触发器
  db.exec(GENESIS_V1_SCHEMA)
  return db
}

describe('冷热双 FTS5 + VACUUM 零错位', () => {
  it('真实 VACUUM 后三张虚表按 files.id 锚定，检索 100% 零错位', () => {
    const db = makeDb()
    try {
      const projection = new FtsProjectionService(db)
      for (let i = 1; i <= 10; i++) {
        const fp = `fp-vacuum-${String(i).padStart(2, '0')}`
        db.prepare('INSERT INTO files (file_fingerprint, extension) VALUES (?, ?)').run(fp, '.txt')
        const id = (db.prepare('SELECT id FROM files WHERE file_fingerprint = ?').get(fp) as any).id
        projection.syncMetaFts(id, {
          fileFingerprint: fp,
          name: `metadata-token-${i}`,
          smartName: `smart-token-${i}`,
          description: `desc-token-${i}`,
          author: ''
        })
        projection.syncBodyFts(id, {
          fileFingerprint: fp,
          content: `body-token-${i}`,
          ocr: `ocr-token-${i}`
        })
        projection.projectPinyin(fp, id, {
          name: '中文文件名',
          smartName: '',
          description: '',
          tagsText: `标签${i}`
        })
      }

      // 删除中间编号制造 id 空洞，再执行真实 VACUUM
      for (const i of [3, 5, 7]) {
        const fp = `fp-vacuum-${String(i).padStart(2, '0')}`
        db.prepare('DELETE FROM files WHERE file_fingerprint = ?').run(fp)
      }
      db.exec('VACUUM')

      const metaRows = db
        .prepare(`SELECT file_fingerprint FROM files_meta_fts WHERE files_meta_fts MATCH '"metadata-token-9"'`)
        .all() as Array<{ file_fingerprint: string }>
      expect(metaRows).toEqual([{ file_fingerprint: 'fp-vacuum-09' }])

      const bodyRows = db
        .prepare(`SELECT file_fingerprint FROM files_body_fts WHERE files_body_fts MATCH '"body-token-4"'`)
        .all() as Array<{ file_fingerprint: string }>
      expect(bodyRows).toEqual([{ file_fingerprint: 'fp-vacuum-04' }])

      const pyRows = db
        .prepare(`SELECT file_fingerprint FROM files_pinyin_fts WHERE files_pinyin_fts MATCH '"zhongwen"'`)
        .all() as Array<{ file_fingerprint: string }>
      expect(pyRows).toHaveLength(7)
      expect(pyRows.every(r => /^fp-vacuum-\d\d$/.test(r.file_fingerprint))).toBe(true)
      expect(pyRows.map(r => r.file_fingerprint)).not.toContain('fp-vacuum-03')
    } finally {
      db.close()
    }
  })

  it('同事务热投影只写各 1 次且不擦除 tags_py；syncMetaFts 置 pinyin_state=0 后 P1-D 回填闭环', () => {
    const db = makeDb()
    try {
      const projection = new FtsProjectionService(db)
      db.prepare('INSERT INTO files (file_fingerprint, extension) VALUES (?, ?)').run('fp-p1d', '.jpg')
      const id = (db.prepare('SELECT id FROM files WHERE file_fingerprint = ?').get('fp-p1d') as any).id

      projection.syncMetaFts(id, {
        fileFingerprint: 'fp-p1d',
        name: '原始名',
        smartName: '',
        description: '',
        author: ''
      })
      projection.syncBodyFts(id, { fileFingerprint: 'fp-p1d', content: '正文' })
      expect(db.prepare('SELECT COUNT(*) AS c FROM files_meta_fts').get()).toMatchObject({ c: 1 })
      expect(db.prepare('SELECT COUNT(*) AS c FROM files_body_fts').get()).toMatchObject({ c: 1 })
      expect(db.prepare('SELECT pinyin_state FROM files WHERE id = ?').get(id)).toMatchObject({
        pinyin_state: 0
      })

      // 挂载受控标签路径 + 规范名，供 P1-D 聚合 tags_py
      const pathId = ensureTagPath(db, '/builtin.file_type/builtin.document')
      db.prepare(
        `INSERT INTO tag_aliases (locale, tag_code, lemma, is_canonical) VALUES ('zh-CN', 'builtin.document', '文档', 1)`
      ).run()
      db.prepare(
        `INSERT INTO file_tag_relations (file_fingerprint, tag_code, via_parent_code, path_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run('fp-p1d', 'builtin.document', 'builtin.file_type', pathId, Date.now(), Date.now())

      const dao = new FileDao(db)
      const refreshed = dao.syncPinyinPendingBatch(200)
      expect(refreshed).toBe(1)
      expect(db.prepare('SELECT pinyin_state FROM files WHERE id = ?').get(id)).toMatchObject({
        pinyin_state: 1
      })
      const py = db
        .prepare('SELECT tags_py FROM files_pinyin_fts WHERE rowid = ?')
        .get(id) as { tags_py: string }
      expect(py.tags_py).toContain('wendang')

      // 后续仅改热字段：tags_py 不因冷正文/元数据更新被擦除
      projection.syncMetaFts(id, {
        fileFingerprint: 'fp-p1d',
        name: '更新后的名字',
        smartName: '',
        description: '',
        author: ''
      })
      const pyAfter = db
        .prepare('SELECT tags_py FROM files_pinyin_fts WHERE rowid = ?')
        .get(id) as { tags_py: string }
      expect(pyAfter.tags_py).toBe(py.tags_py)
    } finally {
      db.close()
    }
  })
})
