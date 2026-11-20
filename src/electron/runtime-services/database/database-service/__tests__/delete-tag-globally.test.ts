import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '', isPackaged: false },
  ipcMain: { handle: vi.fn(), on: vi.fn() }
}))
vi.mock('electron-conf', () => ({
  Conf: class {
    get() {
      return undefined
    }
    set() {}
  }
}))

import Database from 'better-sqlite3'
import { DatabaseService } from '@/electron/runtime-services/database/database-service'
import { omniClient } from '@/electron/services/omni-client'

describe('deleteTagGlobally 模型 B 受控标签与精准分支删除测试', () => {
  let db: Database.Database
  let clearCacheSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_fingerprint TEXT NOT NULL UNIQUE,
        pinyin_state INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE file_tags_private (
        code TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        parent_codes TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL DEFAULT 'user'
      );
      CREATE TABLE tag_paths (
        path_id INTEGER PRIMARY KEY AUTOINCREMENT,
        leaf_code TEXT NOT NULL,
        via_parent_code TEXT NOT NULL DEFAULT '',
        code_path TEXT NOT NULL UNIQUE,
        depth INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE tag_path_ancestors (
        ancestor_code TEXT NOT NULL,
        path_id INTEGER NOT NULL REFERENCES tag_paths(path_id) ON DELETE CASCADE,
        PRIMARY KEY (ancestor_code, path_id)
      ) WITHOUT ROWID;
      CREATE TABLE file_tag_relations (
        file_fingerprint TEXT NOT NULL,
        tag_code TEXT NOT NULL,
        via_parent_code TEXT NOT NULL DEFAULT '',
        path_id INTEGER NOT NULL,
        PRIMARY KEY (file_fingerprint, tag_code, via_parent_code)
      ) WITHOUT ROWID;
    `)
    clearCacheSpy = vi.spyOn(omniClient, 'clearTaxonomyTreeCache').mockImplementation(() => {})
  })

  afterEach(() => {
    clearCacheSpy.mockRestore()
    db.close()
  })

  function createProxy() {
    const proxy = Object.create(DatabaseService.prototype) as any
    proxy._db = db
    proxy.clearDimensionsCache = vi.fn()
    proxy.resolveDimensionCode = (id: number | string) =>
      id === 1 ? 'builtin.file_type' : String(id)
    return proxy as DatabaseService & { clearDimensionsCache: ReturnType<typeof vi.fn> }
  }

  it('删除受控分支 文档>小说>题材>美食 时，精准删除该分支关联且不误杀内容标签下的同名美食', async () => {
    db.exec(`
      INSERT INTO files (file_fingerprint, pinyin_state) VALUES ('fp_novel', 1), ('fp_photo', 1);
      INSERT INTO tag_paths (path_id, leaf_code, via_parent_code, code_path, depth) VALUES
        (1, 'omw.food.n', 'builtin.genre', '/builtin.file_type/omw.doc.n/omw.novel.n/builtin.genre/omw.food.n', 5),
        (2, 'omw.food.n', 'builtin.content_tags', '/builtin.content_tags/omw.food.n', 2);
      INSERT INTO file_tag_relations (file_fingerprint, tag_code, via_parent_code, path_id) VALUES
        ('fp_novel', 'omw.food.n', 'builtin.genre', 1),
        ('fp_photo', 'omw.food.n', 'builtin.content_tags', 2);
    `)

    const proxy = createProxy()
    const ok = await proxy.deleteTagGlobally(1, '美食', {
      code: 'omw.food.n',
      codePath: '/builtin.file_type/omw.doc.n/omw.novel.n/builtin.genre/omw.food.n',
      viaParentCode: 'builtin.genre'
    })

    expect(ok).toBe(true)
    expect(clearCacheSpy).toHaveBeenCalledTimes(1)
    expect(proxy.clearDimensionsCache).toHaveBeenCalledTimes(1)

    const remainingRels = db
      .prepare('SELECT file_fingerprint, path_id FROM file_tag_relations')
      .all() as Array<{ file_fingerprint: string; path_id: number }>
    expect(remainingRels).toEqual([{ file_fingerprint: 'fp_photo', path_id: 2 }])

    // 孤儿 tag_paths(path_id=1) 已被回收，path_id=2 保留
    const remainingPaths = db.prepare('SELECT path_id FROM tag_paths').all()
    expect(remainingPaths).toEqual([{ path_id: 2 }])

    // 受影响文件 pinyin_state 置 0，未受影响文件保持 1
    const states = db
      .prepare('SELECT file_fingerprint, pinyin_state FROM files ORDER BY file_fingerprint')
      .all()
    expect(states).toEqual([
      { file_fingerprint: 'fp_novel', pinyin_state: 0 },
      { file_fingerprint: 'fp_photo', pinyin_state: 1 }
    ])
  })

  it('目标标签不存在（0 行受影响）时必须诚实返回 false，严禁伪造成功', async () => {
    const proxy = createProxy()
    const ok = await proxy.deleteTagGlobally(1, '不存在的标签', {
      code: 'omw.nonexistent.n',
      codePath: '/builtin.file_type/omw.nonexistent.n'
    })
    expect(ok).toBe(false)
  })
})
