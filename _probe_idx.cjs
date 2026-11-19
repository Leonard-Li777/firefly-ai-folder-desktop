const Database = require('better-sqlite3')
const db = new Database(':memory:')
db.exec(`
CREATE TABLE workspace_files (
  id INTEGER PRIMARY KEY,
  workspace_id INTEGER NOT NULL,
  directory_id INTEGER,
  path TEXT, name TEXT,
  file_fingerprint TEXT,
  file_size INTEGER NOT NULL DEFAULT 0,
  mtime_ms INTEGER NOT NULL DEFAULT 0,
  is_ignored INTEGER NOT NULL DEFAULT 0,
  is_analyzed INTEGER NOT NULL DEFAULT 0,
  status INTEGER NOT NULL DEFAULT 1,
  modified_at TEXT
);
CREATE INDEX idx_workspace_files_status ON workspace_files(status);
CREATE INDEX idx_wf_diff_cover ON workspace_files(workspace_id, directory_id, is_ignored, path, file_size, mtime_ms);
`)
// 插入一批数据让优化器有统计基础
const ins = db.prepare(
  `INSERT INTO workspace_files (id,workspace_id,directory_id,path,name,status) VALUES (?,?,?,?,?,1)`
)
for (let i = 0; i < 500; i++) ins.run(i, 1, 10, 'C:/root/dir/f' + i + '.txt', 'f' + i + '.txt')

const sql = `SELECT id, path, name, file_fingerprint, file_size, mtime_ms, is_ignored, is_analyzed, status, modified_at
FROM workspace_files WHERE workspace_id = ? AND directory_id = ? AND status = 1`
console.log('A current (no status in cover):')
console.log(
  db
    .prepare('EXPLAIN QUERY PLAN ' + sql)
    .all(1, 10)
    .map(p => p.detail)
    .join(' | ')
)

// 加 status 到覆盖索引
db.exec(`DROP INDEX idx_wf_diff_cover;
CREATE INDEX idx_wf_diff_cover ON workspace_files(workspace_id, directory_id, status, is_ignored, path, file_size, mtime_ms);`)
console.log('B cover with status after ws_id,dir_id:')
console.log(
  db
    .prepare('EXPLAIN QUERY PLAN ' + sql)
    .all(1, 10)
    .map(p => p.detail)
    .join(' | ')
)

// status 放最前
db.exec(`DROP INDEX idx_wf_diff_cover;
CREATE INDEX idx_wf_diff_cover ON workspace_files(workspace_id, directory_id, is_ignored, status, path, file_size, mtime_ms);`)
console.log('C cover with status after is_ignored:')
console.log(
  db
    .prepare('EXPLAIN QUERY PLAN ' + sql)
    .all(1, 10)
    .map(p => p.detail)
    .join(' | ')
)
