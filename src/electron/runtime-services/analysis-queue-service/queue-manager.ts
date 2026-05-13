/**
 * 队列管理模块
 * 负责分析队列的增删改查、状态管理和数据库同步
 */

import type { AnalysisQueueItem, AnalysisQueueSnapshot } from '@yonuc/types'
import { LogCategory, logger } from '@yonuc/shared'

import type { EnqueueInput } from './types'
import type { IIgnoreRule } from '@yonuc/types'
import { databaseService } from '../database/database-service'
import { shouldIgnoreFile } from '../analysis/analysis-ignore-service'
import path from 'node:path'
import fs from 'node:fs'

export class QueueManager {
  private queue: AnalysisQueueItem[] = []
  private isInitialized = false
  private ignoreRules: IIgnoreRule[] = []
  
  // 回调函数
  private onUpdate?: () => void
  private onPersist?: () => void
  private onWakeUp?: () => void

  constructor(
    ignoreRules: IIgnoreRule[] = [],
    callbacks?: {
      onUpdate?: () => void
      onPersist?: () => void
      onWakeUp?: () => void
    }
  ) {
    this.ignoreRules = ignoreRules
    this.onUpdate = callbacks?.onUpdate
    this.onPersist = callbacks?.onPersist
    this.onWakeUp = callbacks?.onWakeUp
  }

  /**
   * 设置忽略规则
   */
  setIgnoreRules(rules: IIgnoreRule[]): void {
    this.ignoreRules = rules
  }

  /**
   * 从数据库加载队列
   */
  async loadFromDB(): Promise<void> {
    try {
      logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 从数据库加载队列状态...')
      const rows = databaseService.getAnalysisQueue()
      logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 从数据库加载到', rows.length, '个项目')

      let skippedCount = 0

      // 将 DB 行恢复为队列项，只恢复非 completed 状态的项目
      this.queue = rows
        .filter(r => r.status !== 'completed')
        .map(r => {
          // 根据 item_type 决定从哪个字段获取路径和名称
          const isDir = r.item_type === 'directory';
          const itemType: 'file' | 'directory' = r.item_type || 'file';
          let filePath = isDir ? r.dir_path : r.file_path;

          // 如果没有路径，跳过
          if (!filePath) {
            skippedCount++;
            logger.warn(LogCategory.ANALYSIS_QUEUE, `[分析队列] 跳过路径为空的队列项: ${r.id} (类型: ${r.item_type})`);
            return null;
          }

          // 简化逻辑：使用原生路径，不进行归一化
          const fileExtension = isDir 
            ? '' 
            : (r.file_type || path.extname(filePath).toLowerCase() || '');

          return {
            id: r.id,
            workspaceId: r.workspace_id,
            path: filePath,
            name: r.file_name,
            size: r.size ?? 0,
            type: fileExtension,  // 文件扩展名，目录时为空
            itemType: itemType,   // 'file' 或 'directory'
            status: r.status as 'pending' | 'analyzing' | 'completed' | 'failed',
            error: r.error ?? undefined,
            addedAt: r.created_at ? new Date(r.created_at).getTime() : Date.now(),
            updatedAt: r.updated_at ? new Date(r.updated_at).getTime() : Date.now(),
            progress: r.progress ?? 0,
            fromCache: !!r.is_hit,
            analysisStats: (() => {
              if (!r.analysis_stats) return undefined
              try {
                return typeof r.analysis_stats === 'string' ? JSON.parse(r.analysis_stats) : r.analysis_stats
              } catch (e) {
                return undefined
              }
            })()
          } as AnalysisQueueItem
        })
        .filter(item => item !== null) as AnalysisQueueItem[];

      if (skippedCount > 0) {
        logger.warn(LogCategory.ANALYSIS_QUEUE, `[分析队列] 共跳过 ${skippedCount} 个路径为空的队列项`)
        // 从数据库中删除这些无效项（item_id 不在对应表中的记录）
        try {
          // 删除文件类型但 item_id 不在 workspace_files 中的记录
          databaseService.db?.prepare(`DELETE FROM analysis_queue WHERE item_type = 'file' AND item_id NOT IN (SELECT id FROM workspace_files)`).run();
          // 删除目录类型但 item_id 不在 workspace_directories 中的记录
          databaseService.db?.prepare(`DELETE FROM analysis_queue WHERE item_type = 'directory' AND item_id NOT IN (SELECT id FROM workspace_directories)`).run();
        } catch (e) {
          logger.debug(LogCategory.ANALYSIS_QUEUE, '[分析队列] 清理无效队列项失败', e)
        }
      }

      // 重置所有 analyzing 状态的项目为 pending
      const analyzingItems = this.queue.filter(item => item.status === 'analyzing')
      if (analyzingItems.length > 0) {
        logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 重置', analyzingItems.length, '个 analyzing 状态的项目为 pending')

        const transaction = databaseService.db?.transaction(() => {
          for (const item of analyzingItems) {
            item.status = 'pending'
            item.progress = 0
            item.error = undefined
            item.updatedAt = Date.now()

            databaseService.updateAnalysisQueue({
              id: item.id,
              status: 'pending',
              progress: 0,
              error: null
            })
          }
        })

        try {
          transaction?.()
        } catch (e) {
          logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 批量重置状态失败:', e)
        }
      }

      this.isInitialized = true
      this.emitUpdate()
    } catch (e) {
      logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 从数据库加载失败:', e)
      this.queue = []
      this.isInitialized = true
      this.emitUpdate()
    }
  }

  /**
   * 添加项目到队列
   * 流程：先确保目录/文件记录存在于数据库，再插入队列表
   */
  async addItems(inputs: EnqueueInput[], forceReanalyze = false): Promise<void> {
    if (!this.isInitialized) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] 服务未初始化，无法添加项目')
      return
    }

    logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 添加项目到队列，输入数量:', inputs.length, 'forceReanalyze:', forceReanalyze)
    const now = Date.now()
    // 使用 路径 + workspaceId 作为 Map 的键，确保唯一性，不进行归一化
    const existingByPathAndWorkspace = new Map(
      this.queue
        .filter(i => i.path && i.workspaceId)
        .map(i => [`${i.path}|${i.workspaceId}`, i as any])
    )
    let addedCount = 0
    let updatedCount = 0

    // 第一步：确保所有目录/文件记录存在于数据库中（异步）并确定 workspaceId
    const resolvedInputs = []
    for (const file of inputs) {
      if (!file.path) continue
      // 统一使用原生路径
      const nativePath = file.path
      const itemType = file.type === 'folder' ? 'directory' : 'file';

      let resolvedWorkspaceId: number | undefined = undefined;

      if (itemType === 'directory') {
        // 尝试直接通过路径查找目录所属的工作区
        const dir = databaseService.db?.prepare(`SELECT id, workspace_id FROM workspace_directories WHERE path = ?`).get(nativePath) as any;
        if (dir) {
          resolvedWorkspaceId = dir.workspace_id;
        } else {
          // 查找所属根工作区
          const ws = await databaseService.findRootWorkspaceDirectory(nativePath);
          if (ws && ws.id) {
            resolvedWorkspaceId = ws.id;
            await databaseService.addDirectory(nativePath, ws.id)
          }
        }
      } else {
        // 尝试直接通过路径查找文件所属的工作区
        const wf = databaseService.db?.prepare(`SELECT id, workspace_id FROM workspace_files WHERE path = ?`).get(nativePath) as any;
        if (wf) {
          resolvedWorkspaceId = wf.workspace_id;
        } else {
          // 查找所属根工作区
          const dirPath = path.dirname(nativePath)
          const ws = await databaseService.findRootWorkspaceDirectory(dirPath);
          if (ws && ws.id) {
            resolvedWorkspaceId = ws.id;
            await databaseService.addFileFromPath(nativePath, '', ws.id)
          }
        }
      }

      if (!resolvedWorkspaceId) {
        logger.warn(LogCategory.ANALYSIS_QUEUE, `[分析队列] 项目 ${nativePath} 不属于任何已知工作区，跳过`)
        continue;
      }

      resolvedInputs.push({
        ...file,
        nativePath,
        workspaceId: resolvedWorkspaceId
      });
    }

    // 第二步：在事务中插入队列记录
    const transaction = databaseService.db?.transaction(() => {
      for (const file of resolvedInputs) {
        if (shouldIgnoreFile(file.nativePath, file.name, this.ignoreRules)) continue

        const key = `${file.nativePath}|${file.workspaceId}`
        const exists = existingByPathAndWorkspace.get(key)
        if (exists) {
          // 关键逻辑：如果文件已在队列中且分析成功，则强制重新分析
          const shouldForceReanalyze = forceReanalyze || exists.status === 'completed'
          
          if (shouldForceReanalyze) {
            const oldStatus = exists.status
            exists.status = 'pending'
            exists.error = undefined
            exists.updatedAt = now
            exists.progress = 0
            exists.forceReanalyze = true
            updatedCount++
            
            const reason = forceReanalyze ? '用户强制重新分析' : '文件已分析成功';
            logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 文件已在队列中 (原状态: ${oldStatus})，${reason}，重置为 pending: ${file.nativePath}`)
            
            databaseService.updateAnalysisQueue({
              id: exists.id,
              status: 'pending',
              progress: 0,
              error: null
            })
          }
          continue
        }

        // 根据类型查找对应的 ID（此时记录一定存在）
        const itemType = file.type === 'folder' ? 'directory' : 'file';
        let itemId: number | null = null;
        let isAlreadyAnalyzed = false;

        if (itemType === 'directory') {
          const dir = databaseService.db?.prepare(`SELECT id, is_analyzed FROM workspace_directories WHERE path = ? AND workspace_id = ?`).get(file.nativePath, file.workspaceId) as any;
          itemId = dir?.id;
          isAlreadyAnalyzed = dir?.is_analyzed === 1;
        } else {
          const wf = databaseService.db?.prepare(`SELECT id, is_analyzed FROM workspace_files WHERE path = ? AND workspace_id = ?`).get(file.nativePath, file.workspaceId) as any;
          itemId = wf?.id;
          isAlreadyAnalyzed = wf?.is_analyzed === 1;
        }

        if (!itemId) {
          logger.error(LogCategory.ANALYSIS_QUEUE, `[分析队列] 无法在工作区 ${file.workspaceId} 中找到路径 ${file.nativePath} 的数据库记录，跳过`)
          continue
        }

        const shouldForceReanalyze = forceReanalyze || file.forceReanalyze || isAlreadyAnalyzed
        if (isAlreadyAnalyzed && !forceReanalyze) {
          logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 文件已被分析过，自动设置强制重新分析: ${file.nativePath}`)
        }

        const fileExtension = itemType === 'file' 
          ? (file.type && file.type.startsWith('.') ? file.type : path.extname(file.nativePath).toLowerCase() || '')
          : ''

        const item: AnalysisQueueItem = {
          id: 0, // 占位，稍后用 dbId 填充
          workspaceId: file.workspaceId,
          path: file.nativePath,
          name: file.name,
          size: file.size,
          type: fileExtension,
          itemType: itemType,
          status: 'pending',
          addedAt: now,
          updatedAt: now,
          progress: 0,
          forceReanalyze: shouldForceReanalyze
        }

        const dbId = databaseService.enqueueAnalysisSync({
          item_id: itemId,
          item_type: itemType,
          status: item.status,
          progress: 0
        })

        item.id = Number(dbId)
        this.queue.push(item)
        addedCount++
      }
    })

    try {
      transaction?.()
      logger.info(LogCategory.ANALYSIS_QUEUE, '[分析队列] 批量操作完成，新增:', addedCount, '更新:', updatedCount)
    } catch (e) {
      logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 批量操作失败:', e)
      this.loadFromDB()
      return
    }

    this.persist()
    this.emitUpdate()

    if ((addedCount > 0 || updatedCount > 0)) {
      this.wakeUp()
    }
  }

  async addItemsResolved(inputs: EnqueueInput[], forceReanalyze = false): Promise<void> {
    const flat: EnqueueInput[] = []
    for (const it of inputs) {
      if (it.type === 'folder') {
        flat.push({ ...it, type: 'folder', size: 0 })
      } else {
        flat.push(it)
      }
    }
    this.addItems(flat as EnqueueInput[], forceReanalyze)
  }

  retryFailed(): void {
    if (!this.isInitialized) return
    const now = Date.now()
    const failedItems = this.queue.filter(item => item.status === 'failed')
    if (failedItems.length === 0) return

    try {
      this.dbTransaction(() => {
        for (const item of failedItems) {
          item.status = 'pending'
          item.error = undefined
          item.updatedAt = now
          item.progress = 0
          databaseService.updateAnalysisQueue({ id: item.id, status: 'pending', progress: 0, error: null })
        }
      })
      this.wakeUp()
    } catch (e) {
      logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 重试失败:', e)
    }
    this.emitUpdate()
  }

  private dbTransaction(fn: () => void): void {
    if (!databaseService.db) {
      logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 数据库未连接，无法执行事务')
      throw new Error('数据库未连接，无法清空待处理项目')
    }
    try {
      const tx = databaseService.db.transaction(fn)
      tx()
    } catch (e) {
      logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 数据库事务执行失败:', e)
      throw e
    }
  }

  clearPending(): void {
    if (!this.isInitialized) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] 队列未初始化，无法清空待处理项目')
      return
    }

    const pendingCount = this.queue.filter(i => i.status !== 'completed').length
    logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 清空待处理项目，当前待处理数量: ${pendingCount}`)

    // 先清空内存队列，确保 UI 立即更新
    this.queue = this.queue.filter(i => i.status === 'completed')
    this.emitUpdate()

    // 清理数据库，不阻塞 UI
    try {
      databaseService.clearNonCompletedAnalysis()
    } catch (e: any) {
      // 如果表不存在或其他数据库错误，记录但不影响用户体验
      if (e.message?.includes('no such table')) {
        logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] analysis_queue 表不存在，跳过数据库清理')
      } else {
        logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 数据库清空失败:', e)
      }
    }
  }

  clearAll(): void {
    if (!this.isInitialized) {
      logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] 队列未初始化，无法清空所有项目')
      return
    }

    const totalCount = this.queue.length
    logger.info(LogCategory.ANALYSIS_QUEUE, `[分析队列] 清空所有队列项目，当前总数量: ${totalCount}`)

    // 清空内存队列，确保 UI 立即更新
    this.queue = []
    this.emitUpdate()

    // 清理数据库，不阻塞 UI
    try {
      databaseService.clearNonCompletedAnalysis()
    } catch (e: any) {
      // 如果表不存在或其他数据库错误，记录但不影响用户体验
      if (e.message?.includes('no such table')) {
        logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] analysis_queue 表不存在，跳过数据库清理')
      } else {
        logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 数据库清空失败:', e)
      }
    }
  }

  deleteItem(id: number): void {
    if (!this.isInitialized) return
    const itemIndex = this.queue.findIndex(i => i.id === id)
    if (itemIndex === -1) return
    try {
      this.dbTransaction(() => {
        databaseService.deleteAnalysis(id)
        this.queue.splice(itemIndex, 1)
      })
    } catch (e) {
      logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 删除失败:', e)
    }
    this.emitUpdate()
  }

  deleteItemsByDirectory(directoryPath: string): void {
    if (!this.isInitialized) return
    const sep = path.sep
    const prefix = directoryPath.endsWith(sep) ? directoryPath : directoryPath + sep

    const itemsToDelete = this.queue.filter(item => {
      if (!item.path) return false
      // 完全匹配或者是子项（采用补齐分隔符的原生匹配，不归一化）
      return item.path === directoryPath || item.path.startsWith(prefix)
    })

    if (itemsToDelete.length === 0) return
    const ids = itemsToDelete.map(i => i.id)

    try {
      this.dbTransaction(() => {
        for (const id of ids) databaseService.deleteAnalysis(id)
      })
      this.queue = this.queue.filter(item => !ids.includes(item.id))
    } catch (e) {
      logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 按目录删除失败:', e)
    }
    this.emitUpdate()
  }

  getSnapshot(currentItemId?: number): AnalysisQueueSnapshot {
    return { items: this.queue.slice(), running: false, currentItemId }
  }

  async validateQueueConsistency(): Promise<void> {
    try {
      const dbItems = databaseService.getAnalysisQueue()
      const dbItemsMap = new Map(dbItems.map(item => [item.id, item]))

      this.queue = this.queue.filter(memoryItem => {
        const dbItem = dbItemsMap.get(memoryItem.id)
        if (!dbItem) return false
        if (dbItem.status !== memoryItem.status) {
          memoryItem.status = dbItem.status as any
          memoryItem.progress = dbItem.progress || 0
        }
        return true
      })

      const memoryIds = new Set(this.queue.map(i => i.id))
      for (const dbItem of dbItems) {
        if (!memoryIds.has(dbItem.id) && dbItem.status !== 'completed') {
          this.queue.push({
            id: dbItem.id,
            path: dbItem.file_path || dbItem.dir_path,
            name: dbItem.file_name || dbItem.dir_name,
            size: dbItem.size ?? 0,
            type: dbItem.file_type || '',
            itemType: dbItem.item_type as 'file' | 'directory',
            status: dbItem.status as any,
            error: dbItem.error || undefined,
            addedAt: dbItem.created_at ? new Date(dbItem.created_at).getTime() : Date.now(),
            updatedAt: dbItem.updated_at ? new Date(dbItem.updated_at).getTime() : Date.now(),
            progress: dbItem.progress || 0,
          })
        }
      }
    } catch (e) { }
  }

  getQueue(): AnalysisQueueItem[] { return this.queue }
  getIsInitialized(): boolean { return this.isInitialized }
  private emitUpdate(): void { this.onUpdate?.() }
  private persist(): void { this.onPersist?.() }
  private wakeUp(): void { this.onWakeUp?.() }
}
