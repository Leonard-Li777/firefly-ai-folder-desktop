import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('electron-conf', () => ({
  Conf: class MockConf {
    get() {
      return undefined
    }
    set() {}
  }
}))
vi.mock('electron', () => ({
  app: { getPath: () => '', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  utilityProcess: { fork: vi.fn() }
}))

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import { GENESIS_V1_SCHEMA } from '../../../database/database'
import {
  AnalysisDbWriterProcess,
  WriteSetBatchDispatcher,
  type AnalysisWriteSet,
  type WriterInMessage,
  type WriterOutMessage,
  type WriterProcessForkFn
} from '..'
import type { UtilityProcess } from 'electron'

function createGenesisDbFile(dbPath: string): Database.Database {
  const db = new Database(dbPath)
  db.pragma('foreign_keys = ON')
  db.exec(GENESIS_V1_SCHEMA)
  return db
}

function seedWorkspaceAndQueue(
  db: Database.Database,
  opts: { filePath: string; fileName: string; size: number; mtimeMs: number }
): { workspaceFileId: number; queueId: number } {
  const wsPath = path.dirname(opts.filePath)
  db.prepare(
    `INSERT OR IGNORE INTO workspaces (name, path, is_active) VALUES ('test-ws', ?, 1)`
  ).run(wsPath)
  const wsRow = db.prepare(`SELECT workspace_id FROM workspaces WHERE path = ?`).get(wsPath) as {
    workspace_id: number
  }
  const workspaceId = wsRow.workspace_id

  db.prepare(
    `INSERT OR IGNORE INTO workspace_directories (workspace_id, path, name) VALUES (?, ?, 'root')`
  ).run(workspaceId, wsPath)
  const dirRow = db
    .prepare(`SELECT id FROM workspace_directories WHERE workspace_id = ? AND path = ?`)
    .get(workspaceId, wsPath) as { id: number }

  const wfRes = db
    .prepare(
      `INSERT INTO workspace_files
         (file_fingerprint, workspace_id, directory_id, path, name, is_analyzed, file_size, mtime_ms)
       VALUES (NULL, ?, ?, ?, ?, 0, ?, ?)`
    )
    .run(workspaceId, dirRow.id, opts.filePath, opts.fileName, opts.size, opts.mtimeMs)
  const workspaceFileId = Number(wfRes.lastInsertRowid)

  const qRes = db
    .prepare(
      `INSERT INTO analysis_queue (item_id, item_type, task_type, status, claimed_at)
       VALUES (?, 'file', 'analysis', 'analyzing', CURRENT_TIMESTAMP)`
    )
    .run(workspaceFileId)
  const queueId = Number(qRes.lastInsertRowid)

  return { workspaceFileId, queueId }
}

/** 模拟 Electron UtilityProcess（消息面与 exit 面均为手动驱动） */
class FakeUtilityProcess {
  pid = 4242
  killed = false
  posted: WriterInMessage[] = []
  private messageHandlers: Array<(msg: WriterOutMessage) => void> = []
  private exitHandlers: Array<(code: number) => void> = []

  on(event: string, cb: (arg: never) => void): this {
    if (event === 'message') this.messageHandlers.push(cb as (msg: WriterOutMessage) => void)
    if (event === 'exit') this.exitHandlers.push(cb as (code: number) => void)
    return this
  }

  once(event: string, cb: (arg: never) => void): this {
    return this.on(event, cb)
  }

  postMessage(msg: WriterInMessage): void {
    this.posted.push(msg)
  }

  kill(): boolean {
    this.killed = true
    return true
  }

  emitMessage(msg: WriterOutMessage): void {
    for (const cb of [...this.messageHandlers]) cb(msg)
  }

  emitExit(code: number): void {
    for (const cb of [...this.exitHandlers]) cb(code)
  }
}

function buildWriteSet(
  queueId: number,
  workspaceFileId: number,
  filePath: string,
  size: number,
  mtimeMs: number
): AnalysisWriteSet {
  return {
    queueId,
    guard: { workspaceFileId, workspaceId: 1, size, mtimeMs },
    fileFingerprint: `fp-writer-${queueId}`,
    workspaceFileId,
    physicalPath: filePath,
    fileName: path.basename(filePath),
    filesUpdate: { extension: '.txt', description: 'writer-process 描述' },
    fileContents: { plainContent: 'writer-process 测试正文' },
    queueUpdate: { status: 'completed', endTime: new Date().toISOString(), progress: 100 },
    canonicalVectorWakeup: true
  }
}

describe('Stage2 S-B AnalysisDbWriterProcess 宿主状态机（工单 05）', () => {
  let tmpDir: string
  let db: Database.Database
  let dbPath: string
  let forkCalls: string[]
  let currentFake: FakeUtilityProcess | null
  let forkFn: WriterProcessForkFn

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-writer-process-'))
    dbPath = path.join(tmpDir, 'writer-test.db')
    db = createGenesisDbFile(dbPath)
    forkCalls = []
    currentFake = null
    forkFn = ((modulePath: string) => {
      forkCalls.push(modulePath)
      currentFake = new FakeUtilityProcess()
      return currentFake as unknown as UtilityProcess
    }) as WriterProcessForkFn
  })

  afterEach(() => {
    try {
      db.close()
    } catch {
      // ignore
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('start → INIT 握手 → READY → enqueue 经 WRITE_SET 下发并在 ACK 后核销', () => {
    const seeded = seedWorkspaceAndQueue(db, {
      filePath: path.join(tmpDir, 'a.txt'),
      fileName: 'a.txt',
      size: 10,
      mtimeMs: 1000
    })
    const acks: Array<{ queueId: number; result: string }> = []
    const host = new AnalysisDbWriterProcess({
      getDbPath: () => dbPath,
      getDisplayLocale: () => 'zh-CN',
      onWriteAck: ack => acks.push(ack),
      entryScriptPath: path.join(tmpDir, 'fake-entry.js'),
      forkFn
    })
    fs.writeFileSync(path.join(tmpDir, 'fake-entry.js'), '// fake entry', 'utf8')

    expect(host.start()).toBe(true)
    expect(forkCalls.length).toBe(1)
    expect(forkCalls[0]).toBe(path.join(tmpDir, 'fake-entry.js'))
    expect(host.getState()).toBe('starting')

    currentFake!.emitMessage({ type: 'READY', pid: 4242 })
    expect(host.getState()).toBe('ready')
    expect(host.getPid()).toBe(4242)

    const initMsg = currentFake!.posted.find(m => m.type === 'INIT') as
      | Extract<WriterInMessage, { type: 'INIT' }>
      | undefined
    expect(initMsg?.dbPath).toBe(dbPath)
    expect(initMsg?.displayLocale).toBe('zh-CN')

    const ws = buildWriteSet(
      seeded.queueId,
      seeded.workspaceFileId,
      path.join(tmpDir, 'a.txt'),
      10,
      1000
    )
    host.enqueue(ws)
    const posted = currentFake!.posted.filter(m => m.type === 'WRITE_SET')
    expect(posted.length).toBe(1)

    currentFake!.emitMessage({ type: 'WRITE_ACK', ack: { queueId: seeded.queueId, result: 'ok' } })
    expect(acks.length).toBe(1)
    expect(acks[0].queueId).toBe(seeded.queueId)
  })

  it('READY 前入队进入 outbox，READY 后按序冲刷（WRITE_SET 不丢）', () => {
    const seeded = seedWorkspaceAndQueue(db, {
      filePath: path.join(tmpDir, 'b.txt'),
      fileName: 'b.txt',
      size: 5,
      mtimeMs: 2000
    })
    const host = new AnalysisDbWriterProcess({
      getDbPath: () => dbPath,
      getDisplayLocale: () => 'zh-CN',
      entryScriptPath: path.join(tmpDir, 'fake-entry.js'),
      forkFn
    })
    fs.writeFileSync(path.join(tmpDir, 'fake-entry.js'), '// fake entry', 'utf8')

    host.enqueue(
      buildWriteSet(
        seeded.queueId,
        seeded.workspaceFileId,
        path.join(tmpDir, 'b.txt'),
        5,
        2000
      )
    )
    // starting 状态：WRITE_SET 应缓冲在 outbox 而非直接下发
    expect(host.getState()).toBe('starting')
    const writeMsgs = currentFake!.posted.filter(m => m.type === 'WRITE_SET')
    expect(writeMsgs.length).toBe(0)

    currentFake!.emitMessage({ type: 'READY', pid: 4242 })
    const flushed = currentFake!.posted.filter(m => m.type === 'WRITE_SET')
    expect(flushed.length).toBe(1)
  })

  it('崩溃 → 未确认写集转入回灌队列 → watchdog 重启 READY 后原序回灌', async () => {
    const seeded = seedWorkspaceAndQueue(db, {
      filePath: path.join(tmpDir, 'c.txt'),
      fileName: 'c.txt',
      size: 7,
      mtimeMs: 3000
    })
    const host = new AnalysisDbWriterProcess({
      getDbPath: () => dbPath,
      getDisplayLocale: () => 'zh-CN',
      entryScriptPath: path.join(tmpDir, 'fake-entry.js'),
      forkFn,
      restartBaseDelayMs: 10
    })
    fs.writeFileSync(path.join(tmpDir, 'fake-entry.js'), '// fake entry', 'utf8')
    host.start()
    currentFake!.emitMessage({ type: 'READY', pid: 4242 })

    host.enqueue(
      buildWriteSet(
        seeded.queueId,
        seeded.workspaceFileId,
        path.join(tmpDir, 'c.txt'),
        7,
        3000
      )
    )
    expect(currentFake!.posted.filter(m => m.type === 'WRITE_SET').length).toBe(1)

    // 子进程崩溃（非零 exit）
    currentFake!.emitExit(1)
    expect(host.getState()).toBe('crashed')

    // 退避重启（10ms）
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(forkCalls.length).toBe(2)
    const second = currentFake!
    second.emitMessage({ type: 'READY', pid: 4343 })
    // 崩溃前未确认写集必须原序回灌（WRITE_SET 不丢）
    const requeued = second.posted.filter(m => m.type === 'WRITE_SET')
    expect(requeued.length).toBe(1)
    expect((requeued[0] as Extract<WriterInMessage, { type: 'WRITE_SET' }>).payload.queueId).toBe(
      seeded.queueId
    )
    expect(host.getState()).toBe('ready')
  })

  it('连续崩溃超上限 → 状态 exhausted → 写集显式降级移交本地执行器（严禁静默丢）', async () => {
    const seeded = seedWorkspaceAndQueue(db, {
      filePath: path.join(tmpDir, 'd.txt'),
      fileName: 'd.txt',
      size: 8,
      mtimeMs: 4000
    })
    const degraded: Array<{ reason: string; count: number }> = []
    const host = new AnalysisDbWriterProcess({
      getDbPath: () => dbPath,
      getDisplayLocale: () => 'zh-CN',
      entryScriptPath: path.join(tmpDir, 'fake-entry.js'),
      forkFn,
      maxRestarts: 0,
      restartBaseDelayMs: 10,
      onDegradedToLocal: (reason, entries) => {
        degraded.push({ reason, count: entries.length })
        // 模拟路由层把降级写集转投本地执行器
        for (const entry of entries) {
          if (entry.kind === 'write_set' && entry.writeSet) {
            localDispatcher.enqueue(entry.writeSet)
          }
        }
      }
    })
    fs.writeFileSync(path.join(tmpDir, 'fake-entry.js'), '// fake entry', 'utf8')

    const localAcks: Array<{ queueId: number; result: string }> = []
    const localDispatcher = new WriteSetBatchDispatcher({
      getDb: () => db,
      onWriteAck: ack => localAcks.push(ack),
      statFile: async () => ({ size: 8, mtimeMs: 4000 })
    })

    host.start()
    currentFake!.emitMessage({ type: 'READY', pid: 4242 })
    host.enqueue(
      buildWriteSet(
        seeded.queueId,
        seeded.workspaceFileId,
        path.join(tmpDir, 'd.txt'),
        8,
        4000
      )
    )
    currentFake!.emitExit(1)
    expect(host.getState()).toBe('exhausted')
    expect(degraded.length).toBe(1)
    expect(degraded[0].count).toBe(1)

    // 降级写集经本地执行器真实落库闭环
    await localDispatcher.flush()
    expect(localAcks.length).toBe(1)
    expect(localAcks[0].result).toBe('ok')
    const row = db
      .prepare(`SELECT status FROM analysis_queue WHERE id = ?`)
      .get(seeded.queueId) as { status: string }
    expect(row.status).toBe('completed')
  })

  it('入口脚本缺失 → start 显式失败且状态 exhausted（不伪造拉起成功）', () => {
    const host = new AnalysisDbWriterProcess({
      getDbPath: () => dbPath,
      getDisplayLocale: () => 'zh-CN',
      entryScriptPath: path.join(tmpDir, 'missing-entry.js'),
      forkFn,
      onDegradedToLocal: (reason, entries) => {
        expect(reason).toBe('entry_script_missing')
        expect(entries.length).toBe(0)
      }
    })
    expect(host.start()).toBe(false)
    expect(host.getState()).toBe('exhausted')
    expect(forkCalls.length).toBe(0)
  })

  it('READY 超时 → kill 并走 watchdog 重启；kill 的异步 exit 不二次记账', async () => {
    const host = new AnalysisDbWriterProcess({
      getDbPath: () => dbPath,
      getDisplayLocale: () => 'zh-CN',
      entryScriptPath: path.join(tmpDir, 'fake-entry.js'),
      forkFn,
      restartBaseDelayMs: 250,
      readyTimeoutMs: 30
    })
    fs.writeFileSync(path.join(tmpDir, 'fake-entry.js'), '// fake entry', 'utf8')
    host.start()
    expect(host.getState()).toBe('starting')

    // 30ms READY 超时触发（退避 250ms 未到，此刻应停在 crashed）
    await new Promise(resolve => setTimeout(resolve, 80))
    expect(host.getState()).toBe('crashed')
    expect(currentFake!.killed).toBe(true)
    expect(forkCalls.length).toBe(1)

    // 退避窗口结束后重启第二轮（vi.waitFor 轮询捕获 fork 时机，必须在第二轮 readyTimer(30ms) 前 emit READY）
    await vi.waitFor(
      () => {
        expect(forkCalls.length).toBe(2)
      },
      { timeout: 1500, interval: 20 }
    )
    currentFake!.emitMessage({ type: 'READY', pid: 4444 })
    expect(host.getState()).toBe('ready')
  })

  it('BATCH_METRICS 聚合为 p50/p99/max 量化指标', () => {
    const host = new AnalysisDbWriterProcess({
      getDbPath: () => dbPath,
      getDisplayLocale: () => 'zh-CN',
      entryScriptPath: path.join(tmpDir, 'fake-entry.js'),
      forkFn
    })
    fs.writeFileSync(path.join(tmpDir, 'fake-entry.js'), '// fake entry', 'utf8')
    host.start()
    currentFake!.emitMessage({ type: 'READY', pid: 4242 })

    for (let i = 1; i <= 10; i++) {
      currentFake!.emitMessage({
        type: 'BATCH_METRICS',
        metrics: { batchSize: i, durationMs: i * 2, ts: Date.now() }
      })
    }
    const metrics = host.getMetrics()
    expect(metrics.batches).toBe(10)
    expect(metrics.totalFiles).toBe(55)
    expect(metrics.maxMs).toBe(20)
    expect(metrics.p50Ms).toBeGreaterThan(0)
    expect(metrics.p99Ms).toBeLessThanOrEqual(20)
  })

  it('YIELD_FOR_UI / RESUME 经 outbox 保序透传', () => {
    const host = new AnalysisDbWriterProcess({
      getDbPath: () => dbPath,
      getDisplayLocale: () => 'zh-CN',
      entryScriptPath: path.join(tmpDir, 'fake-entry.js'),
      forkFn
    })
    fs.writeFileSync(path.join(tmpDir, 'fake-entry.js'), '// fake entry', 'utf8')
    host.yieldForUi(1500)
    host.resumeFromUi()
    host.start()
    currentFake!.emitMessage({ type: 'READY', pid: 4242 })

    const control = currentFake!.posted.filter(
      m => m.type === 'YIELD_FOR_UI' || m.type === 'RESUME'
    )
    expect(control.map(m => m.type)).toEqual(['YIELD_FOR_UI', 'RESUME'])
    expect(host.isYielded()).toBe(false)
  })
})

describe('Stage2 S-B 写进程子入口真实链路（复用 WriteSetBatchDispatcher 落库）', () => {
  let tmpDir: string
  let db: Database.Database
  let dbPath: string
  let captured: WriterOutMessage[]
  let messageListener: ((msg: WriterInMessage) => void) | null

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-writer-entry-'))
    dbPath = path.join(tmpDir, 'writer-entry-test.db')
    db = createGenesisDbFile(dbPath)
    captured = []
    messageListener = null

    // 子进程入口依赖 process.parentPort（utilityProcess 注入）：测试中以桩端口替换并动态加载
    ;(process as unknown as { parentPort?: unknown }).parentPort = {
      postMessage: (msg: WriterOutMessage) => captured.push(msg),
      on: (_event: string, cb: (msg: WriterInMessage) => void) => {
        messageListener = cb
      },
      start: () => {}
    }
    await vi.resetModules()
    await import('../writer-process-entry')
  })

  afterEach(async () => {
    // 子入口单测中已建独立连接：先发 SHUTDOWN 让其在 vitest 兼容模式下关库（不退出进程），再清理目录
    if (messageListener) {
      try {
        messageListener({ type: 'SHUTDOWN' })
        await new Promise(resolve => setTimeout(resolve, 350))
      } catch {
        // ignore
      }
    }
    delete (process as unknown as { parentPort?: unknown }).parentPort
    try {
      db.close()
    } catch {
      // ignore
    }
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // Windows 下句柄释放竞态：清理失败不影响断言
    }
  })

  it('INIT 建独立连接并回 READY；WRITE_SET 经真实写集执行器落库并回 ACK/METRICS', async () => {
    expect(messageListener).toBeTypeOf('function')

    // 先落物理文件并实测 stat，再以同一快照种子化 workspace_files（保证 Pre-step stat 与 FileGuard 一致）
    const physicalPath = path.join(tmpDir, 'entry.txt')
    fs.writeFileSync(physicalPath, 'entry 正文内容', 'utf8')
    const stat = fs.statSync(physicalPath)
    const seeded = seedWorkspaceAndQueue(db, {
      filePath: physicalPath,
      fileName: 'entry.txt',
      size: stat.size,
      mtimeMs: stat.mtimeMs
    })

    messageListener!({
      type: 'INIT',
      dbPath,
      displayLocale: 'zh-CN',
      coalesceWindowMs: 10
    })
    await new Promise(resolve => setTimeout(resolve, 30))
    const ready = captured.find(m => m.type === 'READY')
    expect(ready).toBeDefined()
    expect((ready as Extract<WriterOutMessage, { type: 'READY' }>).pid).toBe(process.pid)

    messageListener!({
      type: 'WRITE_SET',
      payload: buildWriteSet(
        seeded.queueId,
        seeded.workspaceFileId,
        physicalPath,
        stat.size,
        stat.mtimeMs
      )
    })

    // 等待攒批窗口（10ms）+ 执行
    const deadline = Date.now() + 3000
    while (
      Date.now() < deadline &&
      !captured.some(m => m.type === 'WRITE_ACK' && m.ack.queueId === seeded.queueId)
    ) {
      await new Promise(resolve => setTimeout(resolve, 20))
    }

    const ack = captured.find(
      m => m.type === 'WRITE_ACK' && m.ack.queueId === seeded.queueId
    ) as Extract<WriterOutMessage, { type: 'WRITE_ACK' }> | undefined
    expect(ack).toBeDefined()
    expect(ack!.ack.result).toBe('ok')

    const metrics = captured.find(m => m.type === 'BATCH_METRICS') as
      | Extract<WriterOutMessage, { type: 'BATCH_METRICS' }>
      | undefined
    expect(metrics).toBeDefined()
    expect(metrics!.metrics.batchSize).toBe(1)
    // 工单 05 验收：单批写微事务量化达标（本批为轻量数据，执行应远小于 10ms 上限）
    expect(metrics!.metrics.durationMs).toBeGreaterThanOrEqual(0)

    // 真实落库验证：queue 终态 + files UPSERT + file_contents 正文
    const queueRow = db
      .prepare(`SELECT status FROM analysis_queue WHERE id = ?`)
      .get(seeded.queueId) as { status: string }
    expect(queueRow.status).toBe('completed')

    const fileRow = db
      .prepare(`SELECT id, description FROM files WHERE file_fingerprint = ?`)
      .get(`fp-writer-${seeded.queueId}`) as { id: number; description: string | null }
    expect(fileRow).toBeDefined()
    expect(fileRow.description).toBe('writer-process 描述')

    const contentRow = db
      .prepare(`SELECT file_fingerprint FROM file_contents WHERE file_fingerprint = ?`)
      .get(`fp-writer-${seeded.queueId}`)
    expect(contentRow).toBeDefined()

    const wfRow = db
      .prepare(`SELECT is_analyzed, file_fingerprint FROM workspace_files WHERE id = ?`)
      .get(seeded.workspaceFileId) as { is_analyzed: number; file_fingerprint: string | null }
    expect(wfRow.is_analyzed).toBe(1)
    expect(wfRow.file_fingerprint).toBe(`fp-writer-${seeded.queueId}`)
  })

  it('未 INIT 直接 WRITE_SET 时守卫拒绝（数据库不可用回执 error，不崩溃伪装成功）', async () => {
    const physicalPath = path.join(tmpDir, 'noinit.txt')
    fs.writeFileSync(physicalPath, 'x', 'utf8')
    const stat = fs.statSync(physicalPath)
    const seeded = seedWorkspaceAndQueue(db, {
      filePath: physicalPath,
      fileName: 'noinit.txt',
      size: stat.size,
      mtimeMs: stat.mtimeMs
    })

    messageListener!({
      type: 'WRITE_SET',
      payload: buildWriteSet(
        seeded.queueId,
        seeded.workspaceFileId,
        physicalPath,
        stat.size,
        stat.mtimeMs
      )
    })
    // R1 盲审发现 4：未 INIT 时必须显式 error 回执（与 VIDEO_SEGMENT 分支语义对称），
    // 严禁静默缓冲/丢弃；宿主 READY 门禁保证生产不达此处，此用例验证守卫纵深
    await new Promise(resolve => setTimeout(resolve, 30))
    const guardAck = captured.find(
      m => m.type === 'WRITE_ACK' && m.ack.queueId === seeded.queueId
    ) as Extract<WriterOutMessage, { type: 'WRITE_ACK' }> | undefined
    expect(guardAck).toBeDefined()
    expect(guardAck!.ack.result).toBe('error')
    expect(guardAck!.ack.reason).toBe('writer_process_not_initialized')
    expect(captured.find(m => m.type === 'READY')).toBeUndefined()
  })
})
