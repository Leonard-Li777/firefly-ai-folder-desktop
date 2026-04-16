import type { Database } from 'better-sqlite3';

export class QueueDao {
  constructor(private db: Database) {}

  getAnalysisQueue(): any[] {
    try {
      // V2.2: 根据 item_type 关联不同的表
      // is_hit 和 last_hit_at 在 files 表中（内容级），不在 workspace_files 表中（路径级）
      // analysis_stats 在 file_contents 表中
      // 【修复】添加 f.type as file_type，确保获取正确的文件扩展名（如 '.jpg'）
      return this.db.prepare(`
        SELECT q.*,
               wf.name as file_name, wf.path as file_path,
               wd.name as dir_name, wd.path as dir_path,
               f.type as file_type,
               f.is_hit, f.last_hit_at,
               fc.analysis_stats
        FROM analysis_queue q
        LEFT JOIN workspace_files wf ON (q.item_type = 'file' AND q.item_id = wf.id)
        LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
        LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
        LEFT JOIN workspace_directories wd ON (q.item_type = 'directory' AND q.item_id = wd.id)
        WHERE q.status IN ('pending','analyzing','failed')
        ORDER BY q.priority DESC, q.created_at ASC
      `).all() as any[]
    } catch (error: any) {
      console.error('[QueueDao] 获取分析队列失败:', error)
      throw error
    }
  }

  enqueueAnalysis(item: { item_id: number | null; item_type?: 'file' | 'directory'; status: string; progress?: number }): number {
    const itemType = item.item_type ?? 'file';
    const itemId = item.item_id ?? null;

    const result = this.db.prepare(`INSERT INTO analysis_queue (item_id, item_type, status, progress) VALUES (?, ?, ?, ?)`)
      .run(itemId, itemType, item.status, item.progress ?? 0);
    
    // 确保返回普通 number 类型，BigInt 无法被 Electron IPC 序列化
    return Number(result.lastInsertRowid);
  }

  updateAnalysisQueue(item: { id: number; status?: string; progress?: number; error?: string | null; result?: string | null }): void {
    try {
      // 首先检测表结构：检查是否有 item_id 列（V2.2 架构）
      const columns = this.db.prepare('PRAGMA table_info(analysis_queue)').all() as any[]
      const hasItemIdColumn = columns.some((col: any) => col.name === 'item_id')

      if (hasItemIdColumn) {
        // V2.2 架构：analysis_queue 有 id (自增) 和 item_id (关联ID) 两列
        // 传入的 item.id 应该是队列的自增 ID，直接使用
        const row = this.db.prepare('SELECT id, item_id FROM analysis_queue WHERE id = ?').get(item.id) as any
        if (!row) {
          // 找不到记录，直接返回
          return
        }

        this.db.prepare(`UPDATE analysis_queue SET
          status = COALESCE(?, status),
          progress = COALESCE(?, progress),
          error = COALESCE(?, error),
          result = COALESCE(?, result),
          updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`).run(item.status, item.progress, item.error, item.result, item.id)
      } else {
        // V1 架构：只有 id 列（TEXT 类型）
        const row = this.db.prepare('SELECT id FROM analysis_queue WHERE id = ?').get(item.id) as any
        if (!row) return

        this.db.prepare(`UPDATE analysis_queue SET
          status = COALESCE(?, status),
          progress = COALESCE(?, progress),
          error = COALESCE(?, error),
          result = COALESCE(?, result),
          updated_at = CURRENT_TIMESTAMP
          WHERE id = ?`).run(item.status, item.progress, item.error, item.result, item.id)
      }
    } catch (error: any) {
      // 如果仍然出错，记录详细错误信息
      console.error('[QueueDao] 更新分析队列失败:', {
        message: error.message,
        itemId: item.id,
        stack: error.stack
      })
    }
  }

  clearNonCompletedAnalysis(): void {
    try {
      this.db.prepare(`DELETE FROM analysis_queue WHERE status NOT IN ('completed')`).run()
    } catch (e: any) {
      // 如果表不存在，忽略错误（可能是全新安装还未创建表）
      if (!e.message?.includes('no such table')) {
        throw e
      }
    }
  }

  clearPendingAnalysis(): void {
    this.db.prepare(`DELETE FROM analysis_queue WHERE status = 'pending'`).run()
  }

  retryFailedAnalysis(): void {
    this.db.prepare(`UPDATE analysis_queue SET status = 'pending', retry_count = retry_count + 1, updated_at = CURRENT_TIMESTAMP WHERE status = 'failed'`).run()
  }

  deleteAnalysis(id: number): void {
    this.db.prepare(`DELETE FROM analysis_queue WHERE id = ?`).run(id)
  }
}
