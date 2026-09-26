import type { Database } from 'better-sqlite3'

/** 队列任务类型（单一队列表复用，见 ADR-0046 与 CONTEXT.md「抢占式单队列调度」） */
export type AnalysisTaskType = 'analysis' | 'high_dim_correction'

/**
 * 抢占式硬优先级排序片段（Issue 0046；依据 ADR-0046 与 CONTEXT.md「抢占式单队列调度」）：
 * 普通文件分析（`analysis`）恒排在高维修正（`high_dim_correction`）之前，
 * 保证「只要存在任何普通分析待办，高维修正任务自然挂起不执行」。
 * 在 ASCII 字典序下 'analysis' < 'high_dim_correction' 严格等价于 CASE 表达式，
 * 且可直接利用覆盖索引 (status, task_type, priority DESC, id ASC) 实现 0 排序扫描。
 */
const PREEMPTIVE_ORDER_BY = `q.task_type ASC, q.priority DESC, q.id ASC`

export class QueueDao {
  constructor(private db: Database) {}

  getAnalysisQueue(): any[] {
    try {
      // V2.2: 根据 item_type 关联不同的表
      // is_hit 和 last_hit_at 在 files 表中（内容级），不在 workspace_files 表中（路径级）
      // analysis_stats 在 file_contents 表中
      // 【修复】V4 已将 files.type 改名 extension，此处取 f.extension as file_type，确保获取正确的文件扩展名（如 '.jpg'）
      return this.db
        .prepare(
          `
        SELECT q.*,
               wf.name as file_name, wf.path as file_path,
               COALESCE(wf.workspace_id, wd.workspace_id, wd.id) as workspace_id,
               wd.name as dir_name, wd.path as dir_path,
               f.extension as file_type,
               f.is_hit, f.last_hit_at,
               fc.analysis_stats
        FROM analysis_queue q
        LEFT JOIN workspace_files wf ON (q.item_type = 'file' AND q.item_id = wf.id)
        LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
        LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
        LEFT JOIN workspace_directories wd ON (q.item_type = 'directory' AND q.item_id = wd.id)
        WHERE q.status IN ('pending','analyzing','failed')
        ORDER BY ${PREEMPTIVE_ORDER_BY}
      `
        )
        .all() as any[]
    } catch (error: any) {
      console.error('[QueueDao] 获取分析队列失败:', error)
      throw error
    }
  }

  /**
   * 抢占式提取队头待办任务（Issue 0046 §4 / ADR-0046 / CONTEXT.md 抢占式单队列调度）。
   *
   * 排序严格遵循硬优先级：普通分析恒优先于高维修正。
   * 可选 `taskType` 过滤用于「只取某一类任务」的定向调度场景。
   */
  fetchNextQueueItem(taskType?: AnalysisTaskType): any | undefined {
    try {
      const params: any[] = []
      let where = `q.status = 'pending'`
      if (taskType) {
        where += ` AND q.task_type = ?`
        params.push(taskType)
      }
      return this.db
        .prepare(
          `
        SELECT q.*,
               wf.name as file_name, wf.path as file_path,
               COALESCE(wf.workspace_id, wd.workspace_id, wd.id) as workspace_id,
               f.extension as file_type
        FROM analysis_queue q
        LEFT JOIN workspace_files wf ON (q.item_type = 'file' AND q.item_id = wf.id)
        LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
        LEFT JOIN workspace_directories wd ON (q.item_type = 'directory' AND q.item_id = wd.id)
        WHERE ${where}
        ORDER BY ${PREEMPTIVE_ORDER_BY}
        LIMIT 1
      `
        )
        .get(...params)
    } catch (error: any) {
      console.error('[QueueDao] 提取队头任务失败:', error)
      throw error
    }
  }

  enqueueAnalysis(item: {
    item_id: number | null
    item_type?: 'file' | 'directory'
    task_type?: AnalysisTaskType
    status: string
    progress?: number
  }): number {
    const itemType = item.item_type ?? 'file'
    const itemId = item.item_id ?? null
    const taskType: AnalysisTaskType = item.task_type ?? 'analysis'

    const result = this.db
      .prepare(
        `INSERT INTO analysis_queue (item_id, item_type, task_type, status, progress, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        itemId,
        itemType,
        taskType,
        item.status,
        item.progress ?? 0,
        new Date().toISOString(),
        new Date().toISOString()
      )

    // 确保返回普通 number 类型，BigInt 无法被 Electron IPC 序列化
    return Number(result.lastInsertRowid)
  }

  updateAnalysisQueue(item: {
    id: number
    status?: string
    progress?: number
    error?: string | null
    result?: string | null
    /** 可选任务类型过滤：仅当记录属于该类型时才更新（防止跨类型误改） */
    taskType?: AnalysisTaskType
  }): void {
    try {
      // 首先检测表结构：检查是否有 item_id 列（V2.2 架构）
      const columns = this.db.prepare('PRAGMA table_info(analysis_queue)').all() as any[]
      const hasItemIdColumn = columns.some((col: any) => col.name === 'item_id')

      if (hasItemIdColumn) {
        // V2.2 架构：analysis_queue 有 id (自增) 和 item_id (关联ID) 两列
        // 传入的 item.id 应该是队列的自增 ID，直接使用
        const row = this.db
          .prepare('SELECT id, item_id FROM analysis_queue WHERE id = ?')
          .get(item.id) as any
        if (!row) {
          // 找不到记录，直接返回
          return
        }

        const typeFilter = item.taskType ? ` AND task_type = ?` : ''
        const tailParams = item.taskType ? [item.taskType] : []

        this.db
          .prepare(
            `UPDATE analysis_queue SET
          status = COALESCE(?, status),
          progress = COALESCE(?, progress),
          error = COALESCE(?, error),
          result = COALESCE(?, result),
          updated_at = ?
          WHERE id = ?${typeFilter}`
          )
          .run(
            item.status,
            item.progress,
            item.error,
            item.result,
            new Date().toISOString(),
            item.id,
            ...tailParams
          )
      } else {
        // V1 架构：只有 id 列（TEXT 类型）
        const row = this.db
          .prepare('SELECT id FROM analysis_queue WHERE id = ?')
          .get(item.id) as any
        if (!row) return

        this.db
          .prepare(
            `UPDATE analysis_queue SET
          status = COALESCE(?, status),
          progress = COALESCE(?, progress),
          error = COALESCE(?, error),
          result = COALESCE(?, result),
          updated_at = ?
          WHERE id = ?`
          )
          .run(
            item.status,
            item.progress,
            item.error,
            item.result,
            new Date().toISOString(),
            item.id
          )
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
      // 【清空队列】物理清空两类任务（analysis 与 high_dim_correction）
      this.db.prepare(`DELETE FROM analysis_queue WHERE status NOT IN ('completed')`).run()
    } catch (e: any) {
      // 如果表不存在，忽略错误（可能是全新安装还未创建表）
      if (!e.message?.includes('no such table')) {
        throw e
      }
    }
  }

  clearPendingAnalysis(taskType?: AnalysisTaskType): void {
    if (taskType) {
      this.db.prepare(`DELETE FROM analysis_queue WHERE status = 'pending' AND task_type = ?`).run(taskType)
      return
    }
    this.db.prepare(`DELETE FROM analysis_queue WHERE status = 'pending'`).run()
  }

  /**
   * 重置失败任务为 pending。
   * 【重试全部失败】优先重置普通分析失败项（`analysis`），高维修正失败项一并重置，
   * 由抢占式排序自然保证普通分析先被消费。
   */
  /**
   * 把失败项重置为 `pending`（可选限定任务类型）。
   *
   * **无需按任务类型拆成多条 UPDATE**：抢占优先序由 `getAnalysisQueue` / `fetchNextQueueItem`
   * 的 `ORDER BY (CASE WHEN task_type = 'analysis' THEN 0 ELSE 1 END), priority DESC, id ASC`
   * 统一保证，与重置语句的先后无关（CONTEXT.md 抢占式单队列调度：硬优先序只有一处定义）。
   */
  retryFailedAnalysis(taskType?: AnalysisTaskType): void {
    const now = new Date().toISOString()
    if (taskType) {
      this.db
        .prepare(
          `UPDATE analysis_queue SET status = 'pending', retry_count = retry_count + 1, updated_at = ? WHERE status = 'failed' AND task_type = ?`
        )
        .run(now, taskType)
      return
    }
    this.db
      .prepare(
        `UPDATE analysis_queue SET status = 'pending', retry_count = retry_count + 1, updated_at = ? WHERE status = 'failed'`
      )
      .run(now)
  }

  deleteAnalysis(id: number): void {
    this.db.prepare(`DELETE FROM analysis_queue WHERE id = ?`).run(id)
  }

  /**
   * 扫描工作区中「已分析但尚未进入 Stage 5 高维修正」的文件（Issue 0046 §4 工作区缓冲灌库）。
   *
   * 判定口径：
   * - 路径级已完成分析（`workspace_files.is_analyzed = 1`）；
   * - 内容级尚未高维修正（`files.high_dim_corrected = 0`，即尚未落库 zvec 向量）；
   * - 该路径尚无任何 `high_dim_correction` 队列记录（pending/analyzing/failed/completed 一律排除，
   *   避免失败项被重复灌库产生重复任务）。
   *
   * 返回按 `workspace_files.id` 升序的前 `limit` 条，供调用方分批（100~200/批）安全灌入队列表。
   */
  listHighDimCandidates(
    workspaceId: number,
    limit: number
  ): Array<{ item_id: number; path: string; name: string; size: number; file_fingerprint: string }> {
    try {
      return this.db
        .prepare(
          `
        SELECT wf.id AS item_id, wf.path AS path, wf.name AS name,
               COALESCE(f.size, 0) AS size, wf.file_fingerprint AS file_fingerprint
        FROM workspace_files wf
        JOIN files f ON f.file_fingerprint = wf.file_fingerprint
        WHERE wf.workspace_id = ?
          AND wf.is_analyzed = 1
          AND wf.file_fingerprint IS NOT NULL
          AND COALESCE(f.high_dim_corrected, 0) = 0
          AND wf.id NOT IN (
            SELECT item_id FROM analysis_queue
            WHERE task_type = 'high_dim_correction' AND item_type = 'file' AND item_id IS NOT NULL
          )
        ORDER BY wf.id ASC
        LIMIT ?
      `
        )
        .all(workspaceId, limit) as Array<{
        item_id: number
        path: string
        name: string
        size: number
        file_fingerprint: string
      }>
    } catch (error: any) {
      console.error('[QueueDao] 扫描高维修正候选文件失败:', error)
      return []
    }
  }
}
