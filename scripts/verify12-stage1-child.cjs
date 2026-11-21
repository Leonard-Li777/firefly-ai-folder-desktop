/**
 * [VERIFY-12] 阶段 1 子进程入口（由 verify-12-utilityprocess-abi-probe.cjs 经 utilityProcess 拉起）
 *
 * 职责：在独立 PID 的 utilityProcess 内完成 better-sqlite3
 * open → prepare → run → 读取回核 → close ×N（环境变量 FF_CYCLES）。
 * 结果经 process.parentPort 回传 ABI_RESULT，配置经 FF_* 环境变量注入。
 */

const parentPort = process.parentPort
if (!parentPort) {
  process.stderr.write('[verify12-stage1] process.parentPort 缺失：必须由 utilityProcess 拉起\n')
  process.exit(1)
}

// 引导跟踪（写入 FF_BOOT_LOG，便于探针超时诊断）
const fsBoot = require('node:fs')
function bootLog(line) {
  if (!process.env.FF_BOOT_LOG) return
  try {
    fsBoot.appendFileSync(process.env.FF_BOOT_LOG, `${Date.now()} ${line}\n`)
  } catch (_) {
    // 日志失败不影响冒烟
  }
}
bootLog('module-load pid=' + process.pid)

let Database = null
let loadError = null
try {
  Database = require(process.env.FF_BS3_PATH)
  bootLog('bs3-loaded')
} catch (err) {
  loadError = String((err && err.stack) || err)
  bootLog('bs3-load-error')
}

// Electron utilityProcess 语义：parentPort 'message' 事件为 MessageEvent 包装（载荷在 e.data），
// 而 parentPort.postMessage 与主进程 child.on('message') 之间为裸载荷。此处兼容两种形态。
parentPort.on('message', event => {
  const msg = event && typeof event === 'object' && 'data' in event ? event.data : event
  bootLog('msg:' + (msg && msg.type))
  if (!msg || msg.type !== 'RUN_ABI') return
  parentPort.postMessage({ type: 'ABI_STARTED', pid: process.pid })
  if (loadError) {
    parentPort.postMessage({
      type: 'ABI_RESULT',
      ok: false,
      error: 'better-sqlite3 加载失败: ' + loadError
    })
    process.exit(2)
  }

  const dbPath = process.env.FF_DB_PATH
  const cycles = Number(process.env.FF_CYCLES || 100)
  let db = null
  try {
    let lastElapsedMs = 0
    for (let i = 0; i < cycles; i++) {
      const t0 = Date.now()
      db = new Database(dbPath)
      db.pragma('journal_mode = WAL')
      db.pragma('busy_timeout = 5000')
      const stmt = db.prepare('INSERT INTO probe_rows (cycle, payload) VALUES (?, ?)')
      stmt.run(i, 'payload-' + i)
      const row = db.prepare('SELECT COUNT(*) AS n FROM probe_rows').get()
      if (!row || row.n < 1) throw new Error('probe readback failed at cycle ' + i)
      db.close()
      db = null
      lastElapsedMs = Date.now() - t0
    }
    bootLog('cycles-done')
    parentPort.postMessage({
      type: 'ABI_RESULT',
      ok: true,
      cycles,
      lastElapsedMs,
      pid: process.pid
    })
    process.exit(0)
  } catch (err) {
    try {
      if (db) db.close()
    } catch (_) {
      // 已关闭时忽略
    }
    parentPort.postMessage({
      type: 'ABI_RESULT',
      ok: false,
      error: String((err && err.stack) || err)
    })
    process.exit(2)
  }
})
parentPort.start()
bootLog('listener-attached')
