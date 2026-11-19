/**
 * 文件系统变更 DAO (Issue 04 Step 2)
 *
 * 取代 `FileDao.updateFilePath`：把「单文件/目录前缀移动、重命名」的数据库落地收敛到
 * **单一 SQLite 事务**，原子更新 `workspace_files(directory_id, path, name, mtime_ms, modified_at)`。
 * `name` 变更由本 DAO 在同一事务内显式调用 `FtsProjectionService.syncFTSTags` 重建
 * files_meta_fts / files_pinyin_fts（创世基线已废除内联 FTS 写触发器，绝不留陈旧热字段）。
 *
 * 路径纪律（AGENTS.md 铁律）：
 *  - 严禁比较层分隔符归一化，统一复用 `@firefly/shared` 原生工具 `isSubPath` / `stripTrailingSlash`；
 *  - 前缀移动按原生 `isSubPath` 判定子路径归属，禁止 `path.sep` 转换后比对。
 */
import Database from 'better-sqlite3'
import path from 'node:path'
import { LogCategory, logger, isSubPath, stripTrailingSlash, isPathEqual } from '@firefly/shared'
import { FtsProjectionService } from '../fts-projection'

/** 单文件移动/重命名结果 */
export interface PathMutationResult {
  updated: number // 实际更新的 workspace_files 行数（0 = 原路径记录不存在）
  newDirectoryId: number | null // 新目录记录 ID（null = 目录缺失未更新）
}

export class FileSystemMutationDao {
  private readonly ftsProjection: FtsProjectionService

  constructor(private db: Database.Database) {
    this.ftsProjection = new FtsProjectionService(db)
  }

  /**
   * 解析（必要时创建）新路径所属目录记录 ID。
   * @param newDir 新路径的父目录绝对路径
   * @param workspaceId 工作区 ID（创建目录时归属）
   */
  resolveOrCreateDirectory(newDir: string, workspaceId: number): number | null {
    const existing = this.db
      .prepare('SELECT id FROM workspace_directories WHERE path = ?')
      .get(newDir) as { id: number } | undefined
    if (existing) return existing.id

    // 目录记录不存在：创建（与 addDirectory 语义一致，幂等复用）
    const info = this.db
      .prepare(
        `INSERT INTO workspace_directories (workspace_id, path, name)
         VALUES (?, ?, ?)`
      )
      .run(workspaceId, newDir, path.basename(newDir) || newDir)
    return Number(info.lastInsertRowid)
  }

  /**
   * 单文件移动/重命名：单事务原子更新 workspace_files。
   * @param oldPath 原绝对路径
   * @param newPath 新绝对路径
   * @param statMtimeMs 移动后文件的 mtime_ms（Math.trunc(stats.mtimeMs)，用于 FileGuard 围栏）
   * @returns 更新结果（updated=0 表示原路径记录不存在或目录缺失，未落库）
   */
  updateFilePathAtomic(oldPath: string, newPath: string, statMtimeMs?: number): PathMutationResult {
    if (isPathEqual(oldPath, newPath)) {
      return { updated: 0, newDirectoryId: null }
    }

    const wf = this.db
      .prepare('SELECT id, workspace_id, file_fingerprint FROM workspace_files WHERE path = ?')
      .get(oldPath) as { id: number; workspace_id: number; file_fingerprint: string } | undefined
    if (!wf) {
      logger.warn(LogCategory.DATABASE_SERVICE, '[FSMutation] 原路径记录不存在，跳过', { oldPath })
      return { updated: 0, newDirectoryId: null }
    }

    const newDir = path.dirname(newPath)
    const newDirId = this.resolveOrCreateDirectory(newDir, wf.workspace_id)
    if (newDirId === null) {
      logger.warn(LogCategory.DATABASE_SERVICE, '[FSMutation] 新目录记录创建失败', { newDir })
      return { updated: 0, newDirectoryId: null }
    }

    const now = new Date().toISOString()
    // mtime_ms：优先用移动后 stat；未提供时退回 0（触发 FileGuard 下轮全量校验，安全兜底）
    const mtimeMs = typeof statMtimeMs === 'number' ? Math.trunc(statMtimeMs) : 0

    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE workspace_files
              SET path = ?, name = ?, directory_id = ?, mtime_ms = ?, modified_at = ?
            WHERE id = ?`
        )
        .run(newPath, path.basename(newPath), newDirId, mtimeMs, now, wf.id)
      // 同一事务内重建热字段 FTS 与拼音名（原 trg_workspace_files_fts_update 已废除）
      this.ftsProjection.syncFTSTags(wf.file_fingerprint)
    })()

    return { updated: 1, newDirectoryId: newDirId }
  }

  /**
   * 目录前缀批量移动/重命名：单事务原子把所有位于 oldDirPrefix 下的文件迁到 newDirPrefix。
   * 用原生 isSubPath 判定归属（禁分隔符归一化），逐行按前缀映射改写路径。
   *
   * @param oldDirPrefix 原目录绝对路径
   * @param newDirPrefix 新目录绝对路径
   * @param statMtimeById 可选 { workspace_files.id → mtime_ms } 映射（批量移动后无法逐个 stat 时用）
   * @returns 实际更新行数
   */
  updateDirectoryPrefixAtomic(
    oldDirPrefix: string,
    newDirPrefix: string,
    statMtimeById?: Map<number, number>
  ): number {
    const from = stripTrailingSlash(oldDirPrefix)
    const to = stripTrailingSlash(newDirPrefix)
    if (isPathEqual(from, to)) return 0

    const now = new Date().toISOString()
    let updated = 0

    this.db.transaction(() => {
      // 前缀预筛：path = from 或 以 from + 分隔符开头（LIKE 转义通配符），再在 JS 用原生
      // isSubPath 精筛；严禁在 SQL 层引入不存在的路径函数，也不做分隔符归一化。
      const likePrefix = escapeLike(from) + path.sep + '%'
      const rows = this.db
        .prepare(
          `SELECT id, path, workspace_id, file_fingerprint FROM workspace_files
            WHERE path = ? OR path LIKE ? ESCAPE '\\`
        )
        .all(from, likePrefix) as Array<{
        id: number
        path: string
        workspace_id: number
        file_fingerprint: string
      }>

      for (const row of rows) {
        if (!isSubPath(from, row.path)) continue
        const relative = row.path.slice(from.length) // 含前导分隔符
        const newPath = to + relative
        if (isPathEqual(row.path, newPath)) continue

        const newDir = path.dirname(newPath)
        const newDirId = this.resolveOrCreateDirectory(newDir, row.workspace_id)
        if (newDirId === null) continue

        const mtimeMs = statMtimeById?.get(row.id) ?? 0
        this.db
          .prepare(
            `UPDATE workspace_files
                SET path = ?, name = ?, directory_id = ?, mtime_ms = ?, modified_at = ?
              WHERE id = ?`
          )
          .run(newPath, path.basename(newPath), newDirId, Math.trunc(mtimeMs), now, row.id)
        this.ftsProjection.syncFTSTags(row.file_fingerprint)
        updated++
      }
    })()

    logger.info(LogCategory.DATABASE_SERVICE, '[FSMutation] 目录前缀批量移动完成', {
      from,
      to,
      updated
    })
    return updated
  }
}

/** LIKE 通配符转义（% _ \），配合 ESCAPE '\' 使用 */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&')
}
