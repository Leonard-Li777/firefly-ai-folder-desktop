/**
 * @file fs-journal-recovery.ts
 * @description 文件系统两阶段事务日志与崩溃自愈恢复服务 (Spec §3.2 / Matrix 2b / Ticket 06)
 * 包含纯函数 decideRecovery (24 态完备封闭律)、快速探测、指数退避补偿与内存路径锁。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { LogCategory, logger } from '@firefly/shared'
import { FaultInjectorService } from '../e2e/fault-injector'

export type JournalActiveStatus = 'intent' | 'manual_recovery'
export type JournalTerminalStatus = 'committed' | 'compensated' | 'undone' | 'skipped_by_user'
export type JournalStatus = JournalActiveStatus | JournalTerminalStatus

export interface JournalEntry {
  id: string
  batch_id: string
  seq: number
  op: 'rename' | 'move' | 'trash'
  from_path: string
  to_path: string
  status: JournalStatus
  file_identity: string
  attempt: number
  error_code?: string | null
  created_at?: string
  updated_at?: string
}

export interface FsObservation {
  fromExists: boolean
  toExists: boolean
  sameIdentity: boolean // 优先基于 SHA-256 内容指纹对比 file_identity；同卷内可辅以 (dev, ino/fileIndex, size)
}

export interface DbObservation {
  recordedPath: 'from' | 'to' | 'missing'
}

export type RecoveryAction = 'mark-aborted' | 'roll-back-fs' | 'mark-committed' | 'mark-stuck'

export type StuckReason =
  | 'both_exist'
  | 'both_missing'
  | 'identity_mismatch'
  | 'ebusy_exhausted'
  | 'state_inversion'

export interface DecideRecoveryResult {
  action: RecoveryAction
  reason?: StuckReason
}

export interface ManualRecoveryItem {
  batchId: string
  seq: number
  operationId: string
  fromPath: string
  toPath: string
  reason: StuckReason
  attempt: number
  lastErrorCode?: string
  blocksPaths: string[] // 该条目未决期间禁止同路径后续操作
}

/**
 * 启动恢复决策纯函数 (Spec §3.2)
 * 仅以当前物理磁盘事实与 SQLite 实际落库事实为输入。
 * 完备封闭律：输入空间共 2 × 2 × 2 × 3 = 24 种状态，仅 3 种安全路径自动推进或回退，
 * 其余 21 种一律封闭收敛至 mark-stuck 并精确归因。
 */
export function decideRecovery(
  entry: Pick<JournalEntry, 'from_path' | 'to_path' | 'file_identity'>,
  fsObs: FsObservation,
  dbObs: DbObservation
): DecideRecoveryResult {
  // 1. 物理未动即崩溃，取消意图
  if (fsObs.fromExists && !fsObs.toExists && dbObs.recordedPath === 'from') {
    return { action: 'mark-aborted' }
  }

  // 2. 物理已动但 DB 未提交，逆向移动回原处并置 compensated
  if (!fsObs.fromExists && fsObs.toExists && fsObs.sameIdentity && dbObs.recordedPath === 'from') {
    return { action: 'roll-back-fs' }
  }

  // 3. 物理已动且 DB 事务已提交（仅 committed 日志未写入），补写 committed，绝对严禁逆向回滚
  if (!fsObs.fromExists && fsObs.toExists && fsObs.sameIdentity && dbObs.recordedPath === 'to') {
    return { action: 'mark-committed' }
  }

  // 其余 21 种所有异常分支，100% 封闭收敛至 mark-stuck
  if (fsObs.fromExists && fsObs.toExists) {
    return { action: 'mark-stuck', reason: 'both_exist' }
  }

  if (!fsObs.fromExists && !fsObs.toExists) {
    return { action: 'mark-stuck', reason: 'both_missing' }
  }

  if (!fsObs.fromExists && fsObs.toExists && !fsObs.sameIdentity) {
    return { action: 'mark-stuck', reason: 'identity_mismatch' }
  }

  return { action: 'mark-stuck', reason: 'state_inversion' }
}

/**
 * 内存路径锁定管理器 (Spec §3.2)
 * 进入 manual_recovery 的条目将其涉及路径登记，未决期间禁止同路径后续操作。
 */
export class PathLockManager {
  private static readonly blockedPaths = new Set<string>()

  private static normalizeKey(filePath: string): string {
    return process.platform === 'win32' ? filePath.toLowerCase() : filePath
  }

  static acquireLocks(paths: string[]): void {
    for (const p of paths) {
      if (p) this.blockedPaths.add(this.normalizeKey(p))
    }
  }

  static releaseLocks(paths: string[]): void {
    for (const p of paths) {
      if (p) this.blockedPaths.delete(this.normalizeKey(p))
    }
  }

  static isPathBlocked(filePath: string): boolean {
    return this.blockedPaths.has(this.normalizeKey(filePath))
  }

  static getAllBlockedPaths(): string[] {
    return Array.from(this.blockedPaths)
  }

  static clear(): void {
    this.blockedPaths.clear()
  }
}

/** 5 次指数退避阶梯 (毫秒): 50ms, 100ms, 200ms, 400ms, 800ms */
export const BACKOFF_DELAYS_MS = [50, 100, 200, 400, 800] as const

/** 观察文件系统的实际状态 */
export function observeFs(
  fromPath: string,
  toPath: string,
  expectedIdentity: string
): FsObservation {
  const fromExists = fs.existsSync(fromPath)
  const toExists = fs.existsSync(toPath)
  let sameIdentity = false

  if (toExists) {
    try {
      // 简单高保真计算 SHA256 前缀或整体 hash 作为指纹
      const buf = fs.readFileSync(toPath)
      const hash = crypto.createHash('sha256').update(buf).digest('hex')
      sameIdentity =
        expectedIdentity.startsWith(hash.slice(0, 8)) ||
        hash.startsWith(expectedIdentity.slice(0, 8))
    } catch {
      sameIdentity = false
    }
  }

  return { fromExists, toExists, sameIdentity }
}

/** 观察数据库的记录状态 */
export function observeDb(db: Database, fromPath: string, toPath: string): DbObservation {
  const row = db
    .prepare('SELECT path FROM workspace_files WHERE path IN (?, ?) LIMIT 1')
    .get(fromPath, toPath) as { path: string } | undefined

  if (!row) {
    return { recordedPath: 'missing' }
  }
  if (row.path === toPath) {
    return { recordedPath: 'to' }
  }
  return { recordedPath: 'from' }
}

/**
 * 启动快速探测未完成日志 (Spec §3.2, 耗时 <50ms)
 */
export function probePendingIntents(db: Database): JournalEntry[] {
  try {
    return db
      .prepare(
        `SELECT id, batch_id, seq, op, from_path, to_path, status, file_identity, attempt, error_code
         FROM fs_operation_journal
         WHERE status = 'intent'
         ORDER BY batch_id ASC, seq ASC`
      )
      .all() as JournalEntry[]
  } catch (err) {
    logger.error(LogCategory.DATABASE, '读取 fs_operation_journal 挂起意图失败:', err)
    return []
  }
}

/**
 * 执行单条自愈决策操作
 */
export async function executeRecoveryForEntry(
  db: Database,
  entry: JournalEntry,
  sleepFn: (ms: number) => Promise<void> = ms => new Promise(res => setTimeout(res, ms))
): Promise<DecideRecoveryResult> {
  const fsObs = observeFs(entry.from_path, entry.to_path, entry.file_identity)
  const dbObs = observeDb(db, entry.from_path, entry.to_path)
  const decision = decideRecovery(entry, fsObs, dbObs)

  if (decision.action === 'mark-aborted') {
    db.prepare(
      `UPDATE fs_operation_journal SET status = 'undone', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(entry.id)
    return decision
  }

  if (decision.action === 'mark-committed') {
    db.prepare(
      `UPDATE fs_operation_journal SET status = 'committed', updated_at = CURRENT_TIMESTAMP WHERE id = ?`
    ).run(entry.id)
    return decision
  }

  if (decision.action === 'roll-back-fs') {
    let success = false
    let lastError: any = null

    // 5 次指数退避 (50, 100, 200, 400, 800ms)
    for (let i = 0; i < BACKOFF_DELAYS_MS.length; i++) {
      try {
        const targetDir = path.dirname(entry.from_path)
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true })
        }
        fs.renameSync(entry.to_path, entry.from_path)
        success = true
        break
      } catch (err: any) {
        lastError = err
        const delay = BACKOFF_DELAYS_MS[i]
        await sleepFn(delay)
      }
    }

    if (success) {
      db.prepare(
        `UPDATE fs_operation_journal SET status = 'compensated', attempt = attempt + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(entry.id)
      return { action: 'roll-back-fs' }
    } else {
      // 退避耗尽，进入 manual_recovery
      PathLockManager.acquireLocks([entry.from_path, entry.to_path])
      db.prepare(
        `UPDATE fs_operation_journal
         SET status = 'manual_recovery', attempt = attempt + 5, error_code = 'ebusy_exhausted', updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).run(entry.id)
      return { action: 'mark-stuck', reason: 'ebusy_exhausted' }
    }
  }

  // mark-stuck
  PathLockManager.acquireLocks([entry.from_path, entry.to_path])
  db.prepare(
    `UPDATE fs_operation_journal
     SET status = 'manual_recovery', error_code = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(decision.reason || 'unknown', entry.id)

  return decision
}

/**
 * 批量操作项接口
 */
export interface BatchOperationItem {
  id: string
  fromPath: string
  toPath: string
  fileIdentity: string
  op?: 'rename' | 'move' | 'trash'
}

/**
 * 两阶段批量操作协调器 (Spec §3.2 / Matrix 2b)
 * 严格两阶段提交：
 * 1. 意图短事务写入 fs_operation_journal；
 * 2. 物理执行文件移动；
 * 3. 业务表与日志 committed 单事务原子提交；若失败则触发不可变补偿回滚。
 */
export class TwoPhaseBatchCoordinator {
  constructor(private readonly db: Database) {}

  /**
   * 执行严格两阶段批量操作
   */
  async executeTwoPhaseBatch(
    batchId: string,
    items: BatchOperationItem[],
    options?: {
      onIntentCommitted?: () => void
      onFsMoved?: () => void
      onBeforeDbCommit?: () => void
    }
  ): Promise<{ success: boolean; committedCount: number; compensatedCount: number; error?: any }> {
    if (items.length === 0) {
      return { success: true, committedCount: 0, compensatedCount: 0 }
    }

    // 阶段 1：写入 intent 短事务
    const insertIntentStmt = this.db.prepare(`
      INSERT INTO fs_operation_journal (
        id, batch_id, seq, op, from_path, to_path, status, file_identity, attempt, error_code
      ) VALUES (?, ?, ?, ?, ?, ?, 'intent', ?, 0, NULL)
    `)

    this.db.transaction(() => {
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        insertIntentStmt.run(
          item.id,
          batchId,
          i + 1,
          item.op || 'move',
          item.fromPath,
          item.toPath,
          item.fileIdentity
        )
      }
    })()

    options?.onIntentCommitted?.()

    // 阶段 2：执行物理文件系统操作
    const movedItems: BatchOperationItem[] = []
    try {
      for (const item of items) {
        if (item.fromPath !== item.toPath) {
          const targetDir = path.dirname(item.toPath)
          if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true })
          }
          fs.renameSync(item.fromPath, item.toPath)
          movedItems.push(item)
        }
      }
    } catch (fsErr) {
      // 物理阶段失败，逆向恢复已移动项并标记 undone
      logger.error(LogCategory.FILE_ORGANIZATION, '物理移动阶段异常，执行中止:', fsErr)
      for (const item of movedItems.reverse()) {
        try {
          fs.renameSync(item.toPath, item.fromPath)
        } catch {}
      }
      this.db
        .prepare(`UPDATE fs_operation_journal SET status = 'undone' WHERE batch_id = ?`)
        .run(batchId)
      return {
        success: false,
        committedCount: 0,
        compensatedCount: movedItems.length,
        error: fsErr
      }
    }

    options?.onFsMoved?.()
    options?.onBeforeDbCommit?.()

    // 阶段 3：业务事务与 committed 状态原子提交
    try {
      const updateWsFileStmt = this.db.prepare(`
        UPDATE workspace_files
        SET path = ?, name = ?, modified_at = CURRENT_TIMESTAMP
        WHERE path = ?
      `)

      const commitJournalStmt = this.db.prepare(`
        UPDATE fs_operation_journal
        SET status = 'committed', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `)

      this.db.transaction(() => {
        let rowsProcessed = 0
        for (const item of items) {
          rowsProcessed++
          // 故障注入切槽检查 (Spec §3.2 / TEST-L2A-BATCH-05)
          const fault = FaultInjectorService.triggerIfArmed(
            'sqlite-fail-at',
            f =>
              (f.table === 'files' || f.table === 'workspace_files') && rowsProcessed >= f.afterRows
          )
          if (fault) {
            const err: any = new Error(`Injected SQLite error: ${fault.sqlState}`)
            err.code = fault.sqlState
            throw err
          }

          const newName = path.basename(item.toPath)
          updateWsFileStmt.run(item.toPath, newName, item.fromPath)
          commitJournalStmt.run(item.id)
        }
      })()

      return { success: true, committedCount: items.length, compensatedCount: 0 }
    } catch (dbErr: any) {
      logger.warn(LogCategory.FILE_ORGANIZATION, '业务事务提交失败，开始执行逆向补偿:', dbErr)

      // 事务回滚后，物理逆向移动并落盘 compensated 状态
      for (const item of movedItems.reverse()) {
        try {
          fs.renameSync(item.toPath, item.fromPath)
        } catch (rollbackFsErr) {
          logger.error(LogCategory.FILE_ORGANIZATION, '逆向移动补偿失败:', rollbackFsErr)
        }
      }

      this.db
        .prepare(
          `
        UPDATE fs_operation_journal
        SET status = 'compensated', attempt = attempt + 1, error_code = ?, updated_at = CURRENT_TIMESTAMP
        WHERE batch_id = ?
      `
        )
        .run(dbErr?.code || 'SQLITE_ERROR', batchId)

      return {
        success: false,
        committedCount: 0,
        compensatedCount: movedItems.length,
        error: dbErr
      }
    }
  }

  /**
   * 撤销已提交批次 (Spec §3.2)
   * 以全新 batchId 的补偿批次落盘 fs_operation_journal，严禁改写旧已提交记录破坏不可变审计
   */
  async undoBatch(
    originalBatchId: string
  ): Promise<{ success: boolean; undoneCount: number; compensationBatchId: string }> {
    const committedEntries = this.db
      .prepare(
        `
      SELECT id, batch_id, seq, op, from_path, to_path, file_identity
      FROM fs_operation_journal
      WHERE batch_id = ? AND status = 'committed'
      ORDER BY seq DESC
    `
      )
      .all(originalBatchId) as JournalEntry[]

    if (committedEntries.length === 0) {
      return { success: true, undoneCount: 0, compensationBatchId: '' }
    }

    const compensationBatchId = `undo_${crypto.randomUUID().slice(0, 8)}`
    const insertCompensateStmt = this.db.prepare(`
      INSERT INTO fs_operation_journal (
        id, batch_id, seq, op, from_path, to_path, status, file_identity, attempt, error_code
      ) VALUES (?, ?, ?, ?, ?, ?, 'committed', ?, 0, NULL)
    `)

    const updateWsFileStmt = this.db.prepare(`
      UPDATE workspace_files
      SET path = ?, name = ?, modified_at = CURRENT_TIMESTAMP
      WHERE path = ?
    `)

    // 阶段 1：事务外执行物理逆向移动（零磁盘 I/O 进事务）
    const movedItems: JournalEntry[] = []
    try {
      for (const entry of committedEntries) {
        if (fs.existsSync(entry.to_path)) {
          const targetDir = path.dirname(entry.from_path)
          if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true })
          }
          fs.renameSync(entry.to_path, entry.from_path)
          movedItems.push(entry)
        }
      }
    } catch (fsErr) {
      // 物理回退失败时，将已移动的部分重新还原
      logger.error(LogCategory.FILE_ORGANIZATION, '撤销物理移动阶段异常，执行中止:', fsErr)
      for (const item of movedItems.reverse()) {
        try {
          fs.renameSync(item.from_path, item.to_path)
        } catch {}
      }
      return { success: false, undoneCount: 0, compensationBatchId: '' }
    }

    // 阶段 2：在单一 SQLite 事务中完成业务表还原与补偿批次写入
    let undoneCount = 0
    this.db.transaction(() => {
      for (let i = 0; i < movedItems.length; i++) {
        const entry = movedItems[i]
        // 业务表还原
        const origName = path.basename(entry.from_path)
        updateWsFileStmt.run(entry.from_path, origName, entry.to_path)

        // 写入新的补偿记录 (不可变审计原则)
        const compId = `comp_${crypto.randomUUID().slice(0, 8)}`
        insertCompensateStmt.run(
          compId,
          compensationBatchId,
          i + 1,
          entry.op,
          entry.to_path,
          entry.from_path,
          entry.file_identity
        )
        undoneCount++
      }
    })()

    return { success: true, undoneCount, compensationBatchId }
  }
}
