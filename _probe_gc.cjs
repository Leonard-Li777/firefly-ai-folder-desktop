import Database from 'better-sqlite3'
import {
  GENESIS_V1_SCHEMA,
  registerDatabaseFunctions
} from '../src/electron/runtime-services/database/database'

const db = new Database(':memory:')
db.exec(GENESIS_V1_SCHEMA)
registerDatabaseFunctions(db)

// 验证 GC 两表 + 三触发器存在
const tables = db
  .prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('orphan_gc_queue','vector_delete_outbox')`
  )
  .all()
console.log('GC tables:', JSON.stringify(tables))
const triggers = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_wf_%'`)
  .all()
console.log('GC triggers:', JSON.stringify(triggers))

// 触发器行为验证：插入 workspace_files(file_fingerprint=NULL) 再删除 → 不入队（NULL 边界）
db.exec(`INSERT INTO workspaces (workspace_id, name, path) VALUES (1, 'ws', 'C:/root')`)
db.exec(
  `INSERT INTO workspace_directories (id, workspace_id, path, name) VALUES (10, 1, 'C:/root/dir', 'dir')`
)
db.exec(
  `INSERT INTO workspace_files (id, workspace_id, directory_id, path, name, status) VALUES (1, 1, 10, 'C:/root/dir/a.txt', 'a.txt', 1)`
)
db.exec(`DELETE FROM workspace_files WHERE id = 1`)
let q = db.prepare(`SELECT COUNT(*) c FROM orphan_gc_queue`).get()
console.log('after NULL-fp delete, orphan_gc_queue count (expect 0):', q.c)

// 指纹非空：需先有 files 行（FK）才能插入 wf.file_fingerprint
db.exec(`INSERT INTO files (file_fingerprint, id) VALUES ('fp1', 100)`)
db.exec(
  `INSERT INTO workspace_files (id, workspace_id, directory_id, path, name, file_fingerprint, status) VALUES (2, 1, 10, 'C:/root/dir/b.txt', 'b.txt', 'fp1', 1)`
)
db.exec(`DELETE FROM workspace_files WHERE id = 2`)
q = db.prepare(`SELECT * FROM orphan_gc_queue`).all()
console.log('after fp1 delete, orphan_gc_queue (expect fp1):', JSON.stringify(q))

// 反向出队：重新插入同指纹 → 撤回 queue + outbox
db.exec(`INSERT INTO vector_delete_outbox (file_fingerprint, enqueued_at) VALUES ('fp1', 1)`)
db.exec(
  `INSERT INTO workspace_files (id, workspace_id, directory_id, path, name, file_fingerprint, status) VALUES (3, 1, 10, 'C:/root/dir/b.txt', 'b.txt', 'fp1', 1)`
)
console.log(
  'after reinsert fp1, queue count (expect 0):',
  db.prepare(`SELECT COUNT(*) c FROM orphan_gc_queue`).get().c
)
console.log(
  'after reinsert fp1, outbox count (expect 0):',
  db.prepare(`SELECT COUNT(*) c FROM vector_delete_outbox`).get().c
)
db.close()
console.log('SCHEMA-OK')
