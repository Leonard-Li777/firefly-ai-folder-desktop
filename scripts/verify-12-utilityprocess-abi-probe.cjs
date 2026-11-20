/**
 * [VERIFY-12] utilityProcess + better-sqlite3 ABI 冒烟探针（工单 05 / Spec §16 Phase B 前置）
 *
 * 运行方式（真实 Electron 主进程，严禁 ELECTRON_RUN_AS_NODE）：
 *   cd apps/desktop && node_modules/.bin/electron.cmd scripts/verify-12-utilityprocess-abi-probe.cjs
 *
 * 阶段 1（Spec §16 [VERIFY-12] 原文口径）：utilityProcess 子进程
 *         （scripts/verify12-stage1-child.cjs，独立 PID）内 better-sqlite3
 *         open → prepare → run → close ×100（临时主库文件）。
 * 阶段 2（工单 05 真实入口冒烟）：若存在编译产物 out_build/main/analysis-db-writer-process.js，
 *         以真实写进程入口执行 INIT → READY → WRITE_SET → WRITE_ACK 全链路（含 8 步写集落库）。
 *
 * 退出码：0=全部通过；非 0=失败（失败项打印到 stderr，严禁伪装成功）。
 * 产出：VERIFY12_REPORT_JSON 打印 stdout（供证据文档 docs/evidence/stage2-sb-writer-process.md 引用）。
 */

const { app, utilityProcess } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const N_ABI_CYCLES = 100

function findBetterSqlite3() {
  const candidates = [
    path.resolve(__dirname, '..', 'node_modules', 'better-sqlite3'),
    path.resolve(process.cwd(), 'node_modules', 'better-sqlite3')
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  throw new Error('better-sqlite3 模块目录未找到（请在 apps/desktop 下运行探针）')
}

function waitFor(messages, predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const found = messages.find(predicate)
      if (found) {
        clearInterval(timer)
        resolve(found)
      } else if (Date.now() > deadline) {
        clearInterval(timer)
        reject(new Error(`等待 ${what} 超时 (${timeoutMs}ms)`))
      }
    }, 20)
  })
}

async function stage1(tmpDir) {
  const bs3Path = findBetterSqlite3()
  const dbPath = path.join(tmpDir, 'verify12-stage1.db')
  const entryPath = path.resolve(__dirname, 'verify12-stage1-child.cjs')

  // 预建 probe_rows 表（子进程只做 open/insert/read/close 循环）
  {
    const Database = require(bs3Path)
    const seed = new Database(dbPath)
    seed.exec('CREATE TABLE IF NOT EXISTS probe_rows (cycle INTEGER PRIMARY KEY, payload TEXT)')
    seed.close()
  }

  const child = utilityProcess.fork(entryPath, [], {
    env: {
      ...process.env,
      FF_BS3_PATH: bs3Path,
      FF_DB_PATH: dbPath,
      FF_CYCLES: String(N_ABI_CYCLES),
      FF_BOOT_LOG: path.join(tmpDir, 'stage1-boot.log')
    },
    serviceName: 'verify12-stage1',
    stdio: 'pipe'
  })
  const messages = []
  child.on('message', m => messages.push(m))
  child.on('exit', code => {
    process.stderr.write(`[stage1] 子进程 exit code=${code}\n`)
    try {
      process.stderr.write(
        `[stage1-boot-log]\n${fs.readFileSync(path.join(tmpDir, 'stage1-boot.log'), 'utf8')}`
      )
    } catch {
      process.stderr.write('[stage1-boot-log] 不存在（子模块未执行）\n')
    }
  })
  if (child.stderr) child.stderr.on('data', c => process.stderr.write(`[stage1-child-stderr] ${c}`))
  // 触发 ABI 冒烟循环
  child.postMessage({ type: 'RUN_ABI' })

  const result = await waitFor(
    messages,
    m => m.type === 'ABI_RESULT' || m.type === 'ABI_STARTED',
    30000,
    'ABI_RESULT/ABI_STARTED'
  )
  if (result.type === 'ABI_STARTED') {
    // 收到启动回执：继续等待结果（更短窗口）
    const final = await waitFor(messages, m => m.type === 'ABI_RESULT', 20000, 'ABI_RESULT')
    if (!final.ok) {
      throw new Error(`阶段 1 ABI 冒烟失败: ${final.error}`)
    }
    result.ok = final.ok
    result.cycles = final.cycles
    result.lastElapsedMs = final.lastElapsedMs
  }
  if (!result.ok) {
    throw new Error(`阶段 1 ABI 冒烟失败: ${result.error}`)
  }
  const bs3Pkg = require(path.join(bs3Path, 'package.json'))
  return { cycles: result.cycles, lastElapsedMs: result.lastElapsedMs, pid: result.pid, betterSqlite3: bs3Pkg.version }
}

function sqlSafe(p) {
  return p.replace(/\\/g, '\\\\').replace(/'/g, "''")
}

function loadGenesisSchemaSql() {
  // 权威夹具：由 pro/tests/unit/verify12-dump-genesis-schema.test.ts 从 GENESIS_V1_SCHEMA 导出
  const sqlPath = path.resolve(__dirname, 'verify12-genesis-schema.sql')
  if (fs.existsSync(sqlPath)) {
    return fs.readFileSync(sqlPath, 'utf8')
  }
  throw new Error(
    `探针夹具缺失: ${sqlPath}（先运行 node ../../scripts/test-electron.js run pro/tests/unit/verify12-dump-genesis-schema.test.ts 生成）`
  )
}

async function stage2(tmpDir) {
  const entryPath = path.resolve(__dirname, '..', 'out_build', 'main', 'analysis-db-writer-process.js')
  if (!fs.existsSync(entryPath)) {
    return { skipped: true, reason: `编译产物不存在: ${entryPath}（先构建 desktop main 后重跑可覆盖阶段 2）` }
  }

  const dbPath = path.join(tmpDir, 'verify12-stage2.db')
  const Database = require(findBetterSqlite3())
  const seed = new Database(dbPath)
  seed.exec(loadGenesisSchemaSql())
  seed.exec(
    `INSERT INTO workspaces (name, path, is_active) VALUES ('probe-ws', '${sqlSafe(tmpDir)}', 1)`
  )
  const wsRow = seed.prepare('SELECT workspace_id FROM workspaces LIMIT 1').get()
  seed.exec(
    `INSERT INTO workspace_directories (workspace_id, path, name) VALUES (${wsRow.workspace_id}, '${sqlSafe(tmpDir)}', 'root')`
  )
  const dirRow = seed.prepare('SELECT id FROM workspace_directories LIMIT 1').get()
  const probeFile = path.join(tmpDir, 'stage2-body.txt')
  fs.writeFileSync(probeFile, 'stage2 写进程 ABI 冒烟正文', 'utf8')
  const st = fs.statSync(probeFile)
  const wf = seed
    .prepare(
      `INSERT INTO workspace_files (workspace_id, directory_id, path, name, file_size, mtime_ms)
       VALUES (?, ?, ?, 'stage2-body.txt', ?, ?)`
    )
    .run(wsRow.workspace_id, dirRow.id, probeFile, st.size, st.mtimeMs)
  const workspaceFileId = Number(wf.lastInsertRowid)
  const q = seed
    .prepare(
      `INSERT INTO analysis_queue (item_id, task_type, status, claimed_at) VALUES (?, 'analysis', 'analyzing', CURRENT_TIMESTAMP)`
    )
    .run(workspaceFileId)
  const queueId = Number(q.lastInsertRowid)
  seed.close()

  const child = utilityProcess.fork(entryPath, [], { serviceName: 'verify12-stage2', stdio: 'pipe' })
  const messages = []
  child.on('message', m => messages.push(m))
  child.on('exit', code => {
    process.stderr.write(`[stage2] 子进程 exit code=${code}\n`)
  })
  if (child.stderr) child.stderr.on('data', c => process.stderr.write(`[stage2-child-stderr] ${c}`))

  child.postMessage({ type: 'INIT', dbPath, displayLocale: 'zh-CN' })
  await waitFor(messages, m => m.type === 'READY', 15000, 'READY')

  child.postMessage({
    type: 'WRITE_SET',
    payload: {
      queueId,
      guard: { workspaceFileId, workspaceId: wsRow.workspace_id, size: st.size, mtimeMs: st.mtimeMs },
      fileFingerprint: 'fp-verify12-stage2',
      workspaceFileId,
      physicalPath: probeFile,
      fileName: 'stage2-body.txt',
      filesUpdate: { extension: '.txt', description: 'verify12 阶段2描述' },
      fileContents: { plainContent: 'stage2 写进程 ABI 冒烟正文' },
      queueUpdate: { status: 'completed', endTime: new Date().toISOString(), progress: 100 },
      canonicalVectorWakeup: false
    }
  })
  const ack = await waitFor(
    messages,
    m => m.type === 'WRITE_ACK' && m.ack.queueId === queueId,
    15000,
    'WRITE_ACK'
  )
  if (ack.ack.result !== 'ok') {
    throw new Error(`阶段 2 写进程写集回执非 ok: ${JSON.stringify(ack.ack)}`)
  }

  // 独立连接复核落库真值
  const verify = new Database(dbPath, { readonly: true })
  const queueRow = verify.prepare('SELECT status FROM analysis_queue WHERE id = ?').get(queueId)
  const fileRow = verify
    .prepare('SELECT description FROM files WHERE file_fingerprint = ?')
    .get('fp-verify12-stage2')
  verify.close()

  if (!queueRow || queueRow.status !== 'completed') {
    throw new Error(`阶段 2 队列终态异常: ${JSON.stringify(queueRow)}`)
  }
  if (!fileRow || fileRow.description !== 'verify12 阶段2描述') {
    throw new Error(`阶段 2 files UPSERT 异常: ${JSON.stringify(fileRow)}`)
  }

  return { ok: true, queueId, entryPath, ackResult: ack.ack.result }
}

app.whenReady().then(async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify12-abi-'))
  const report = { verify: 'VERIFY-12', electron: process.versions.electron, node: process.versions.node, stages: {} }
  let exitCode = 0
  try {
    report.stages.stage1 = await stage1(tmpDir)
  } catch (err) {
    report.stages.stage1 = { ok: false, error: String((err && err.message) || err) }
    exitCode = 1
  }
  try {
    report.stages.stage2 = await stage2(tmpDir)
  } catch (err) {
    report.stages.stage2 = { ok: false, error: String((err && err.message) || err) }
    exitCode = 1
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // 清理失败不影响结论
  }
  process.stdout.write('\n===== VERIFY12_REPORT_JSON =====\n' + JSON.stringify(report, null, 2) + '\n================================\n')
  app.exit(exitCode)
})
