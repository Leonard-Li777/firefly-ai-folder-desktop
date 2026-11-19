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
  ipcMain: { handle: vi.fn(), on: vi.fn() }
}))

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as zlib from 'node:zlib'
import Database from 'better-sqlite3'
import { GENESIS_V1_SCHEMA } from '../../../database/database'
import { classifyWorkerErrorKind } from '../../file-processor/analysis-error-classifier'
import {
  prepareWriteSetTransfer,
  TRANSFERABLE_THRESHOLD_BYTES,
  WriteSetBatchDispatcher,
  Stage2OrchestratorRuntime,
  WorkerOrchestratorBridge,
  compressFieldSync,
  SerialGate,
  type AnalysisWriteSet,
  type WorkerOutMessage
} from '..'

function createGenesisDb(): Database.Database {
  const db = new Database(':memory:')
  db.pragma('foreign_keys = ON')
  db.exec(GENESIS_V1_SCHEMA)
  return db
}

function seedWorkspaceAndQueue(
  db: Database.Database,
  opts: {
    filePath: string
    fileName: string
    size: number
    mtimeMs: number
    fingerprint?: string | null
  }
): { workspaceId: number; directoryId: number; workspaceFileId: number; queueId: number } {
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
  const directoryId = dirRow.id

  if (opts.fingerprint) {
    db.prepare(
      `INSERT INTO files (file_fingerprint, size, extension, smart_name, rating_user_override, sync_status)
       VALUES (?, ?, '.txt', 'existing_smart_name', 'r15', 2)`
    ).run(opts.fingerprint, opts.size)
  }

  const wfRes = db
    .prepare(
      `INSERT INTO workspace_files
         (file_fingerprint, workspace_id, directory_id, path, name, is_analyzed, file_size, mtime_ms)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
    )
    .run(
      opts.fingerprint ?? null,
      workspaceId,
      directoryId,
      opts.filePath,
      opts.fileName,
      opts.size,
      opts.mtimeMs
    )
  const workspaceFileId = Number(wfRes.lastInsertRowid)

  const qRes = db
    .prepare(
      `INSERT INTO analysis_queue (item_id, item_type, task_type, status, claimed_at)
       VALUES (?, 'file', 'analysis', 'analyzing', CURRENT_TIMESTAMP)`
    )
    .run(workspaceFileId)
  const queueId = Number(qRes.lastInsertRowid)

  return { workspaceId, directoryId, workspaceFileId, queueId }
}

describe('Stage 2 Worker Orchestrator (B1~B8 闭环契约)', () => {
  let tmpDir: string
  let db: Database.Database

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-stage2-worker-'))
    db = createGenesisDb()
  })

  afterEach(() => {
    try {
      db.close()
    } catch {
      // ignore
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('B1/§7.2: Transferable 安全阈值（<16KB 走克隆，>=16KB 独立切片转移且不投毒 Slab）', () => {
    const smallBuf = Buffer.from('small-payload')
    const bigBuf = Buffer.alloc(TRANSFERABLE_THRESHOLD_BYTES + 128, 0x61)

    const ws: AnalysisWriteSet = {
      queueId: 1,
      guard: { workspaceFileId: 1, workspaceId: 1, size: 100, mtimeMs: 1000 },
      fileFingerprint: 'fp-transfer-test',
      workspaceFileId: 1,
      physicalPath: '/tmp/a.txt',
      fileName: 'a.txt',
      filesUpdate: { extension: '.txt' },
      fileContents: {
        contentBlob: new Uint8Array(smallBuf.buffer, smallBuf.byteOffset, smallBuf.byteLength),
        ocrBlob: new Uint8Array(bigBuf.buffer, bigBuf.byteOffset, bigBuf.byteLength)
      }
    }

    const { payload, transferList } = prepareWriteSetTransfer(ws)
    expect(transferList.length).toBe(1)
    expect(transferList[0].byteLength).toBe(bigBuf.byteLength)
    expect(payload.fileContents?.contentBlob?.byteLength).toBe(smallBuf.byteLength)
    expect(payload.fileContents?.ocrBlob?.buffer).toBe(transferList[0])
    // 原始 bigBuf 未与 transferList 共享引用，不会导致 Slab detach
    expect(transferList[0]).not.toBe(bigBuf.buffer)
  })

  it('B1/B7/§9.1: Stage2OrchestratorRuntime 真实计算 SHA-256、deflateSync 压缩并遵守 YIELD_FOR_UI 与 Omni 串行闸', async () => {
    const filePath = path.join(tmpDir, 'note.txt')
    const textBody = 'Firefly AI Folder Stage 2 Worker 测试正文内容'
    fs.writeFileSync(filePath, textBody, 'utf8')
    const stat = fs.statSync(filePath)

    const outMessages: WorkerOutMessage[] = []
    let omniMaxConcurrencyObserved = 0
    let omniActive = 0
    const mockFetch = (async () => {
      omniActive++
      omniMaxConcurrencyObserved = Math.max(omniMaxConcurrencyObserved, omniActive)
      await new Promise(r => setTimeout(r, 20))
      omniActive--
      return new Response(
        JSON.stringify({
          description: '测试描述',
          tagRelations: [
            {
              tagCode: 'builtin.document',
              viaParentCode: 'builtin.file_type',
              codePath: '/builtin.file_type/builtin.document',
              tagGroup: 'fact',
              confidence: 0.95,
              source: 'ai'
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }) as unknown as typeof fetch

    const runtime = new Stage2OrchestratorRuntime({
      initialConfig: { omniBaseUrl: 'http://127.0.0.1:19999', maxConcurrent: 2 },
      fetchFn: mockFetch,
      postMessage: msg => outMessages.push(msg)
    })

    // 先进入 YIELD_FOR_UI：入队任务不应立即执行
    runtime.handleMessage({ type: 'YIELD_FOR_UI', timeoutMs: 2000 })
    runtime.handleMessage({
      type: 'ENQUEUE',
      items: [
        {
          queueId: 101,
          workspaceId: 1,
          workspaceFileId: 10,
          physicalPath: filePath,
          fileName: 'note.txt',
          extension: '.txt',
          priority: 1,
          guard: { workspaceFileId: 10, workspaceId: 1, size: stat.size, mtimeMs: stat.mtimeMs }
        }
      ]
    })
    expect(runtime.getState().yielded).toBe(true)
    expect(runtime.getState().activeCount).toBe(0)

    // RESUME 恢复执行
    runtime.handleMessage({ type: 'RESUME' })
    await vi.waitFor(() => {
      expect(outMessages.some(m => m.type === 'WRITE_SET')).toBe(true)
    })

    const wsMsg = outMessages.find(m => m.type === 'WRITE_SET') as Extract<
      WorkerOutMessage,
      { type: 'WRITE_SET' }
    >
    expect(wsMsg.payload.fileFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(wsMsg.payload.filesUpdate.description).toBe('测试描述')
    expect(wsMsg.payload.fileContents?.contentBlob).toBeTruthy()
    // 验证 deflateSync 与 inflateSync 同源无损解压（无 incorrect header check）
    const inflated = zlib
      .inflateSync(Buffer.from(wsMsg.payload.fileContents!.contentBlob!))
      .toString('utf8')
    expect(inflated).toBe(textBody)
    expect(omniMaxConcurrencyObserved).toBeLessThanOrEqual(1)

    // 验证 SerialGate 硬串行并发 = 1
    const gate = new SerialGate(1)
    let peak = 0
    let cur = 0
    await Promise.all(
      [1, 2, 3].map(() =>
        gate.run(async () => {
          cur++
          peak = Math.max(peak, cur)
          await new Promise(r => setTimeout(r, 10))
          cur--
        })
      )
    )
    expect(peak).toBe(1)

    runtime.shutdown()
  })

  it('B2/B3/B4/B5: 事务外 Pre-step stat + 事务内 8 步 SAVEPOINT + FileGuard 保护白名单 + 尾钩子', async () => {
    const fileOk = path.join(tmpDir, 'ok.txt')
    const fileStaleLogic = path.join(tmpDir, 'stale-logic.txt')
    const fileMissing = path.join(tmpDir, 'missing.txt')
    fs.writeFileSync(fileOk, 'hello world body', 'utf8')
    fs.writeFileSync(fileStaleLogic, 'stale content', 'utf8')
    const statOk = fs.statSync(fileOk)
    const statStale = fs.statSync(fileStaleLogic)

    const fpOk = 'fp-ok-001'
    const fpStale = 'fp-stale-002'
    const seededOk = seedWorkspaceAndQueue(db, {
      filePath: fileOk,
      fileName: 'ok.txt',
      size: statOk.size,
      mtimeMs: statOk.mtimeMs,
      fingerprint: fpOk
    })
    const seededStale = seedWorkspaceAndQueue(db, {
      filePath: fileStaleLogic,
      fileName: 'stale-logic.txt',
      size: statStale.size,
      mtimeMs: statStale.mtimeMs,
      fingerprint: fpStale
    })
    // 模拟扫描器在入队后更新了 workspace_files 的 mtime_ms → 触发逻辑层 FileGuard
    db.prepare(`UPDATE workspace_files SET mtime_ms = ? WHERE id = ?`).run(
      statStale.mtimeMs + 9999,
      seededStale.workspaceFileId
    )
    const seededMissing = seedWorkspaceAndQueue(db, {
      filePath: fileMissing,
      fileName: 'missing.txt',
      size: 10,
      mtimeMs: 1000
    })

    const wakeups: string[][] = []
    let cloudSyncCount = 0
    const dispatcher = new WriteSetBatchDispatcher({
      getDb: () => db,
      onWakeCanonicalMaintenance: fps => wakeups.push(fps),
      onTriggerCloudSync: () => {
        cloudSyncCount++
      },
      tailHookDebounceMs: 10
    })

    const acks = await dispatcher.executeBatch([
      // 1. 缺失文件（Pre-step stat ENOENT → stale，但不连坐同批其他文件）
      {
        queueId: seededMissing.queueId,
        guard: {
          workspaceFileId: seededMissing.workspaceFileId,
          workspaceId: seededMissing.workspaceId,
          size: 10,
          mtimeMs: 1000
        },
        fileFingerprint: 'fp-missing',
        workspaceFileId: seededMissing.workspaceFileId,
        physicalPath: fileMissing,
        fileName: 'missing.txt',
        filesUpdate: { extension: '.txt' }
      },
      // 2. 逻辑层过期文件（Step 2 changes==0 → ROLLBACK TO SAVEPOINT + 重置 pending + CONTINUE）
      {
        queueId: seededStale.queueId,
        guard: {
          workspaceFileId: seededStale.workspaceFileId,
          workspaceId: seededStale.workspaceId,
          size: statStale.size,
          mtimeMs: statStale.mtimeMs
        },
        fileFingerprint: fpStale,
        workspaceFileId: seededStale.workspaceFileId,
        physicalPath: fileStaleLogic,
        fileName: 'stale-logic.txt',
        filesUpdate: { extension: '.txt', description: 'should_not_commit' }
      },
      // 3. 正常文件（完整 8 步落库 + 保护白名单 + FTS + canonical_vector_state='pending'）
      {
        queueId: seededOk.queueId,
        guard: {
          workspaceFileId: seededOk.workspaceFileId,
          workspaceId: seededOk.workspaceId,
          size: statOk.size,
          // 模拟 FAT32 1000ms 微漂移：Pre-step 容差放行，Step 2 比对入队 guard 命中
          mtimeMs: statOk.mtimeMs
        },
        fileFingerprint: fpOk,
        workspaceFileId: seededOk.workspaceFileId,
        physicalPath: fileOk,
        fileName: 'ok.txt',
        filesUpdate: { extension: '.txt', description: 'new_desc', author: 'alice' },
        fileContents: {
          contentBlob: compressFieldSync('hello world body'),
          plainContent: 'hello world body'
        },
        tagRelations: [
          {
            tagCode: 'builtin.document',
            viaParentCode: 'builtin.file_type',
            codePath: '/builtin.file_type/builtin.document',
            tagGroup: 'fact',
            confidence: 0.98,
            source: 'ai'
          }
        ],
        queueUpdate: { status: 'completed', endTime: new Date().toISOString(), progress: 100 },
        canonicalVectorWakeup: true
      }
    ])

    expect(acks.find(a => a.queueId === seededMissing.queueId)).toMatchObject({
      result: 'stale',
      reason: 'file_stat_failed'
    })
    expect(acks.find(a => a.queueId === seededStale.queueId)).toMatchObject({
      result: 'stale',
      reason: 'workspace_row_changed'
    })
    expect(acks.find(a => a.queueId === seededOk.queueId)).toMatchObject({ result: 'ok' })

    // 校验逻辑层过期文件已重置 pending（未卡在 analyzing）且 description 未被写入
    const staleQueue = db
      .prepare(`SELECT status, claimed_at FROM analysis_queue WHERE id = ?`)
      .get(seededStale.queueId) as { status: string; claimed_at: string | null }
    expect(staleQueue.status).toBe('pending')
    expect(staleQueue.claimed_at).toBeNull()

    // 校验正常文件：白名单保护 rating_user_override / smart_name / sync_status 不被覆盖
    const fileRow = db
      .prepare(
        `SELECT id, description, smart_name, rating_user_override, sync_status, canonical_vector_state, pinyin_state
         FROM files WHERE file_fingerprint = ?`
      )
      .get(fpOk) as any
    expect(fileRow.description).toBe('new_desc')
    expect(fileRow.smart_name).toBe('existing_smart_name')
    expect(fileRow.rating_user_override).toBe('r15')
    expect(fileRow.sync_status).toBe(2)
    expect(fileRow.canonical_vector_state).toBe('pending')
    expect(fileRow.pinyin_state).toBe(0)

    // 校验 Step 1 + Step 5b：tag_paths 物化 + file_tag_relations.path_id 非 NULL
    const relRow = db
      .prepare(`SELECT tag_code, path_id FROM file_tag_relations WHERE file_fingerprint = ?`)
      .get(fpOk) as { tag_code: string; path_id: number }
    expect(relRow.tag_code).toBe('builtin.document')
    expect(relRow.path_id).toBeGreaterThan(0)

    // 校验 Step 6：热元数据 + 冷正文 FTS5 同步成功
    const bodyHit = db
      .prepare(`SELECT rowid FROM files_body_fts WHERE files_body_fts MATCH 'hello'`)
      .get() as { rowid: number } | undefined
    expect(bodyHit?.rowid).toBe(fileRow.id)

    // 校验 Step 8：队列 completed + claimed_at 清空
    const okQueue = db
      .prepare(`SELECT status, claimed_at FROM analysis_queue WHERE id = ?`)
      .get(seededOk.queueId) as { status: string; claimed_at: string | null }
    expect(okQueue.status).toBe('completed')
    expect(okQueue.claimed_at).toBeNull()

    // 校验 B5 COMMIT 尾钩子防抖唤醒
    dispatcher.flushTailHooks()
    await new Promise<void>(r => setImmediate(r))
    expect(wakeups.length).toBe(1)
    expect(wakeups[0]).toContain(fpOk)
    expect(cloudSyncCount).toBe(1)

    dispatcher.dispose()
  })

  it('B6/B8: 真实 worker_threads 崩溃自动回滚在途行 + canceled_by_user + 500/503/EBUSY 分类', async () => {
    const filePath = path.join(tmpDir, 'crash.txt')
    fs.writeFileSync(filePath, 'crash test', 'utf8')
    const stat = fs.statSync(filePath)
    const seeded = seedWorkspaceAndQueue(db, {
      filePath,
      fileName: 'crash.txt',
      size: stat.size,
      mtimeMs: stat.mtimeMs
    })

    // 写一个会在收到 ENQUEUE 时异常退出的真实 worker_threads 脚本
    const crashScript = path.join(tmpDir, 'crash-worker.cjs')
    fs.writeFileSync(
      crashScript,
      `const { workerData } = require('node:worker_threads');
       const port = workerData.port;
       port.postMessage({ type: 'READY' });
       port.on('message', (msg) => {
         if (msg.type === 'ENQUEUE') {
           process.exit(2);
         }
       });`,
      'utf8'
    )

    const dispatcher = new WriteSetBatchDispatcher({ getDb: () => db })
    const bridge = new WorkerOrchestratorBridge({
      getDb: () => db,
      writeDispatcher: dispatcher,
      workerScriptPath: crashScript
    })

    expect(bridge.start()).toBe(true)
    await vi.waitFor(() => expect(bridge.isReady()).toBe(true))

    bridge.enqueue([
      {
        queueId: seeded.queueId,
        workspaceId: seeded.workspaceId,
        workspaceFileId: seeded.workspaceFileId,
        physicalPath: filePath,
        fileName: 'crash.txt',
        extension: '.txt',
        priority: 1,
        guard: {
          workspaceFileId: seeded.workspaceFileId,
          workspaceId: seeded.workspaceId,
          size: stat.size,
          mtimeMs: stat.mtimeMs
        }
      }
    ])

    // 验证 Worker 崩溃后在途队列行自动回滚为 pending + claimed_at=NULL
    await vi.waitFor(() => {
      const row = db
        .prepare(`SELECT status, claimed_at, retry_count FROM analysis_queue WHERE id = ?`)
        .get(seeded.queueId) as { status: string; claimed_at: string | null; retry_count: number }
      expect(row.status).toBe('pending')
      expect(row.claimed_at).toBeNull()
      expect(row.retry_count).toBeGreaterThanOrEqual(1)
    })

    // 验证用户取消写入 failed + error='canceled_by_user'
    bridge.cancelItem(seeded.queueId, true)
    const canceledRow = db
      .prepare(`SELECT status, error FROM analysis_queue WHERE id = ?`)
      .get(seeded.queueId) as { status: string; error: string }
    expect(canceledRow.status).toBe('failed')
    expect(canceledRow.error).toBe('canceled_by_user')

    await bridge.dispose()
    dispatcher.dispose()

    // B8 结构化错误分类器验证
    expect(classifyWorkerErrorKind({ status: 500, message: 'ProcessStatus::Failed' })).toEqual({
      kind: 'ENGINE_FAILED',
      retryable: false
    })
    expect(classifyWorkerErrorKind({ status: 503, message: 'engine_swapping' })).toEqual({
      kind: 'ENGINE_503',
      retryable: true
    })
    expect(classifyWorkerErrorKind({ code: 'EBUSY', message: 'resource busy' })).toEqual({
      kind: 'FILE_LOCKED',
      retryable: true
    })
    expect(
      classifyWorkerErrorKind({ code: 'SQLITE_FULL', message: 'database or disk is full' })
    ).toEqual({
      kind: 'DISK_FULL',
      retryable: false
    })
    expect(
      classifyWorkerErrorKind({
        code: 'SQLITE_CORRUPT',
        message: 'database disk image is malformed'
      })
    ).toEqual({
      kind: 'SQLITE_CORRUPT',
      retryable: false
    })
  })
})
