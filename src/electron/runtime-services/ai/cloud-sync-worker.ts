import { LogCategory, logger, getIsDebugMode, sanitizeObject, toUTCString } from '@firefly/shared'
import { net, powerMonitor } from 'electron'

import { cloudAnalysisService } from '@firefly/server'
import { ConfigOrchestrator } from '@app/electron/config/config-orchestrator'
import { databaseService } from '../database/database-service'
import { userTierService } from '../user-tier/user-tier-service'

/**
 * 云端同步 Worker
 * 负责在系统空闲且网络连通时，将本地未同步的数据批量上传至云端
 */
export class CloudSyncWorker {
  private static instance: CloudSyncWorker
  private isSyncing = false
  private isRefreshingMaps = false
  private checkInterval: NodeJS.Timeout | null = null
  /** 标记当前 runCycle 循环是否仍有效，防止 stop() 后旧循环继续调度新定时器 */
  private cycleValid = false
  private readonly BATCH_SIZE = 50

  private initialized = false
  private cloudDimMap = new Map<string, number>() // 维度名 -> 云端维度ID
  private cloudTagMap = new Map<string, number>() // 维度ID:标签名 -> 云端标签ID
  private cloudTagNameMap = new Map<string, number>() // 标签名 -> 云端标签ID (用于回退匹配)
  private nextSyncAllowedAt: number | null = null

  private constructor() {
    // 监听系统唤醒事件，唤醒后立即尝试同步
    powerMonitor.on('resume', () => {
      logger.info(LogCategory.SUPABASE, 'CloudSyncWorker: System resumed, triggering sync...')
      this.triggerSync(5000) // 唤醒后等 5 秒待网络稳定
    })
  }

  public static getInstance(): CloudSyncWorker {
    if (!CloudSyncWorker.instance) {
      CloudSyncWorker.instance = new CloudSyncWorker()
    }
    return CloudSyncWorker.instance
  }

  /**
   * 检查是否应跳过同步
   * 依据：userTierData.computed_limits.sync_analysis_to_cloud === false
   */
  private shouldSyncToCloud(): boolean {
    try {
      const data = userTierService.getCachedData()
      if (data?.computed_limits?.sync_analysis_to_cloud === false) {
        return false
      }
    } catch {
      // 未就绪时默认允许同步
    }
    return true
  }

  /**
   * 刷新云端 ID 映射缓存
   * 💡 应用启动时调用一次或在必要时手动触发
   */
  public async refreshCloudMaps(): Promise<void> {
    if (this.isRefreshingMaps) return

    if (!this.shouldSyncToCloud()) {
      logger.debug(
        LogCategory.SUPABASE,
        'CloudSyncWorker: sync_analysis_to_cloud is disabled, skipping cloud maps refresh'
      )
      return
    }

    this.isRefreshingMaps = true

    const language =
      ConfigOrchestrator.getInstance().getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN'
    logger.info(
      LogCategory.SUPABASE,
      `CloudSyncWorker: Refreshing cloud ID maps for [${language}]...`
    )

    try {
      // 1. 获取维度映射 (Name -> CloudID)
      const cloudDimensions = await cloudAnalysisService.fetchDimensions(language)
      this.cloudDimMap = new Map<string, number>(cloudDimensions.map(d => [d.name, Number(d.id)]))

      // 2. 获取标签映射 (DimID + Name -> CloudID)
      const cloudTags = await cloudAnalysisService.fetchTags(language)
      this.cloudTagMap = new Map<string, number>(
        cloudTags.map(t => [`${t.dimension_id}:${t.name}`, Number(t.id)])
      )

      // 3. 构建标签名到云端标签ID的映射 (用于处理本地维度ID回退情况)
      // 当本地维度ID被回退到28时，可以通过标签名直接匹配云端标签
      this.cloudTagNameMap = new Map<string, number>(cloudTags.map(t => [t.name, Number(t.id)]))

      this.initialized = true
      logger.info(
        LogCategory.SUPABASE,
        `CloudSyncWorker: Cloud ID maps refreshed. (Dims: ${this.cloudDimMap.size}, Tags: ${this.cloudTagMap.size}, TagsByName: ${this.cloudTagNameMap.size})`
      )
    } catch (error) {
      logger.warn(
        LogCategory.SUPABASE,
        'CloudSyncWorker: Failed to refresh cloud ID maps (will retry later)',
        error
      )
    } finally {
      this.isRefreshingMaps = false
    }
  }
  /**
   * 仅刷新标签映射（不重取维度）
   * 在同步标签到云端后调用，获取云端生成的 tag_id
   */
  private async refreshTagMaps(): Promise<void> {
    const language =
      ConfigOrchestrator.getInstance().getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN'
    try {
      const cloudTags = await cloudAnalysisService.fetchTags(language)
      this.cloudTagMap = new Map<string, number>(
        cloudTags.map(t => [`${t.dimension_id}:${t.name}`, Number(t.id)])
      )
      this.cloudTagNameMap = new Map<string, number>(cloudTags.map(t => [t.name, Number(t.id)]))
      this.initialized = true
      logger.debug(
        LogCategory.SUPABASE,
        `CloudSyncWorker: Tag maps refreshed. (Tags: ${this.cloudTagMap.size}, TagsByName: ${this.cloudTagNameMap.size})`
      )
    } catch (error) {
      logger.warn(LogCategory.SUPABASE, 'CloudSyncWorker: Failed to refresh tag maps', error)
    }
  }

  /**
   * 同步标签到云端后，需要刷新映射以获取云端生成的 tag_id
   * 使用 refreshTagMaps 轻量刷新，避免每次都重新拉取维度定义
   */
  private async afterSyncTags(): Promise<void> {
    await this.refreshTagMaps()
  }
  private debounceTimer: NodeJS.Timeout | null = null

  /**
   * 触发同步 (带防抖)
   * 💡 当有新分析结果产生时调用
   */
  public triggerSync(delayMs = 3000): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }

    this.debounceTimer = setTimeout(async () => {
      this.debounceTimer = null
      try {
        const hasMore = await this.trySync()
        // 如果 trySync 返回 true，说明还有数据没传完（BATCH_SIZE 限制），继续追击
        if (hasMore) {
          this.triggerSync(1000)
        }
      } catch (error) {
        logger.error(LogCategory.SUPABASE, 'CloudSyncWorker: Triggered sync failed', error)
      }
    }, delayMs)
  }

  public start(): void {
    if (this.checkInterval) return

    // 保底检查：每 10 分钟检查一次是否有遗漏数据
    const interval = 10 * 60 * 1000

    logger.debug(LogCategory.SUPABASE, `CloudSyncWorker: Starting idle monitor (Interval: 10m)...`)

    this.cycleValid = true
    const runCycle = async () => {
      if (!this.cycleValid) return
      try {
        await this.trySync()
      } catch (error) {
        logger.error(LogCategory.SUPABASE, 'CloudSyncWorker: Idle monitor sync failed', error)
      } finally {
        if (this.cycleValid) {
          this.checkInterval = setTimeout(runCycle, interval)
        }
      }
    }
    this.checkInterval = setTimeout(runCycle, interval)

    // 启动时立即尝试一次同步
    void this.triggerSync(1000)
  }

  /**
   * 停止同步 Worker
   */
  public stop(): void {
    this.cycleValid = false
    if (this.checkInterval) {
      clearTimeout(this.checkInterval)
      this.checkInterval = null
    }
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }

  /**
   * 更新同步间隔
   */
  public updateInterval(newInterval: number): void {
    const isRunning = this.checkInterval !== null
    this.stop()
    // 标记旧循环失效，防止 stop() 后旧 runCycle 继续调度新定时器
    this.cycleValid = false
    if (isRunning) {
      // 启动新循环，每次 updateInterval 产生独立的 cycleValid 标记
      this.cycleValid = true
      const runCycle = async () => {
        if (!this.cycleValid) return
        try {
          const hasData = await this.trySync()
          if (!this.cycleValid) return
          const nextInterval = hasData ? newInterval : Math.max(newInterval, 60 * 1000)
          this.checkInterval = setTimeout(runCycle, nextInterval)
        } catch (error) {
          if (!this.cycleValid) return
          this.checkInterval = setTimeout(runCycle, newInterval)
        }
      }
      this.checkInterval = setTimeout(runCycle, newInterval)
    }
  }

  /**
   * 尝试执行同步
   * @returns 是否有数据被同步或处理
   */
  public async trySync(): Promise<boolean> {
    if (this.isSyncing || this.isRefreshingMaps) return false

    if (!this.shouldSyncToCloud()) {
      logger.debug(
        LogCategory.SUPABASE,
        'CloudSyncWorker: sync_analysis_to_cloud is disabled, skipping sync'
      )
      return false
    }

    if (this.nextSyncAllowedAt && Date.now() < this.nextSyncAllowedAt) {
      return false
    }

    // 1. 检查网络状态
    if (process.env.IS_INTEGRATION_TEST !== 'true' && !net.isOnline()) {
      return false
    }

    // 2. 确保云端映射已初始化
    if (!this.initialized) {
      await this.refreshCloudMaps()
      // 如果刷新失败，本次循环结束
      if (!this.initialized) return false
    }

    return await this.performSync()
  }

  private ensureReal(value: any, fallback = 0.5): number {
    if (typeof value === 'number' && !isNaN(value)) return value
    if (typeof value === 'string') {
      const parsed = parseFloat(value)
      if (!isNaN(parsed)) return parsed
    }
    return fallback
  }

  private safeJsonParse(value: any, fallback: any = null): any {
    if (typeof value === 'object' && value !== null) return value
    if (typeof value !== 'string') return fallback
    try {
      return JSON.parse(value)
    } catch {
      return fallback
    }
  }

  /**
   * 执行实际的同步逻辑
   * @returns 是否有数据被处理
   */
  private async performSync(): Promise<boolean> {
    this.isSyncing = true
    let hasActualWork = false
    try {
      const db = databaseService.db
      if (!db) return false

      const language =
        ConfigOrchestrator.getInstance().getValue<string>('DEFAULT_LANGUAGE') || 'zh-CN'
      const panDimensionIds =
        ConfigOrchestrator.getInstance().getValue<number[]>('PAN_DIMENSION_IDS') || []
      const panSet = new Set(panDimensionIds.map(id => Number(id)))

      // ==================================================================================
      // Phase 0: 同步提案数据 (Expansions) - 本地单向推送至云端，ID 不同步
      // ==================================================================================

      // 0.1 维度扩展提案 (维度提案不涉及泛维度过滤，因为它们尚未成为正式维度)
      const pendingDimExp = db
        .prepare(`SELECT * FROM dimension_expansions WHERE sync_status = 0 LIMIT ?`)
        .all(this.BATCH_SIZE) as any[]
      if (pendingDimExp.length > 0) {
        hasActualWork = true

        // 同步前查询云端已存在的同名维度，更新 tag_expansions 中的引用
        const cloudDimMapBefore = await cloudAnalysisService.getExistingExpansionNames(language)
        for (const localExp of pendingDimExp) {
          if (cloudDimMapBefore.has(localExp.name)) {
            const cloudId = cloudDimMapBefore.get(localExp.name)
            db.prepare(
              `
              UPDATE tag_expansions SET dimension_expansions_id = ?
              WHERE dimension_expansions_id = ?
            `
            ).run(cloudId, localExp.id)
          }
        }

        const payload = pendingDimExp.map(d => ({
          name: d.name,
          level: d.level,
          tags: this.safeJsonParse(d.tags, []),
          trigger_conditions: this.safeJsonParse(d.trigger_conditions, []),
          description: d.description,
          applicable_file_types: this.safeJsonParse(d.applicable_file_types, []),
          context_hints: this.safeJsonParse(d.context_hints, []),
          created_at: toUTCString(d.created_at)
        }))
        await cloudAnalysisService.batchSync(
          { dimension_expansions: sanitizeObject(payload) },
          language
        )

        // 同步后查询云端所有维度ID，将云端ID覆盖本地ID，并更新tag_expansions外键
        const cloudDimMapAfter = await cloudAnalysisService.getExistingExpansionNames(language)
        for (const localExp of pendingDimExp) {
          if (cloudDimMapAfter.has(localExp.name)) {
            const cloudId = cloudDimMapAfter.get(localExp.name)
            if (cloudId !== localExp.id) {
              // 用云端ID覆盖本地ID（INSERT OR REPLACE + DELETE旧记录）
              db.prepare(`DELETE FROM dimension_expansions WHERE id = ?`).run(localExp.id)
              db.prepare(
                `
                INSERT OR REPLACE INTO dimension_expansions (id, name, level, tags, trigger_conditions, description, applicable_file_types, context_hints, sync_status, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, ?)
              `
              ).run(
                cloudId,
                localExp.name,
                localExp.level,
                localExp.tags,
                localExp.trigger_conditions,
                localExp.description,
                localExp.applicable_file_types,
                localExp.context_hints,
                localExp.created_at
              )
              // 更新tag_expansions中引用旧ID的记录
              db.prepare(
                `
                UPDATE tag_expansions SET dimension_expansions_id = ?
                WHERE dimension_expansions_id = ?
              `
              ).run(cloudId, localExp.id)
            } else {
              // 如果 ID 已经一致，仅更新同步状态为 2
              db.prepare(`UPDATE dimension_expansions SET sync_status = 2 WHERE id = ?`).run(
                localExp.id
              )
            }
          }
        }
      }

      // 0.2 标签扩展提案 - 处理泛维度过滤
      const pendingTagExp = db
        .prepare(`SELECT * FROM tag_expansions WHERE sync_status = 0 LIMIT ?`)
        .all(this.BATCH_SIZE) as any[]
      if (pendingTagExp.length > 0) {
        // 过滤掉泛维度的标签提案
        const toSync = pendingTagExp.filter(t => !panSet.has(Number(t.dimension_id)))
        const toSkip = pendingTagExp.filter(t => panSet.has(Number(t.dimension_id)))

        if (toSync.length > 0) {
          hasActualWork = true
          const payload = toSync.map(t => ({
            name: t.name,
            dimension_id: t.dimension_id,
            file_dimensions_id: t.file_dimensions_id,
            dimension_expansions_id: t.dimension_expansions_id,
            created_at: toUTCString(t.created_at)
          }))
          await cloudAnalysisService.batchSync(
            { tag_expansions: sanitizeObject(payload) },
            language
          )

          // 同步后查询云端标签ID，回传到本地
          const cloudTagMap = await cloudAnalysisService.getExistingTagExpansionIds(language)
          for (const localTag of toSync) {
            const cloudTagId = cloudTagMap.get(localTag.name)
            if (cloudTagId && cloudTagId !== localTag.id) {
              // 用云端ID覆盖本地ID
              db.prepare(`DELETE FROM tag_expansions WHERE id = ?`).run(localTag.id)
              db.prepare(
                `
                INSERT OR REPLACE INTO tag_expansions (id, name, dimension_id, file_dimensions_id, dimension_expansions_id, sync_status, created_at)
                VALUES (?, ?, ?, ?, ?, 2, ?)
              `
              ).run(
                cloudTagId,
                localTag.name,
                localTag.dimension_id,
                localTag.file_dimensions_id,
                localTag.dimension_expansions_id,
                localTag.created_at
              )
            }
          }
        }

        // 统一更新状态：同步成功的设为 2，被过滤的也设为 2 (防止下次重复扫描)
        const allProcessedIds = pendingTagExp.map(t => t.id)
        if (allProcessedIds.length > 0) {
          db.prepare(
            `UPDATE tag_expansions SET sync_status = 2 WHERE id IN (${allProcessedIds.map(() => '?').join(',')})`
          ).run(...allProcessedIds)
        }

        if (toSkip.length > 0) {
          logger.info(
            LogCategory.SUPABASE,
            `CloudSyncWorker: 已忽略 ${toSkip.length} 个属于泛维度的标签提案`
          )
        }
      }

      // ==================================================================================
      // Phase 1: 同步微调数据集 (memory_cache) - 独立于文件同步，即使无文件也要处理
      // ==================================================================================
      try {
        const pendingMemoryCache = db
          .prepare(`SELECT * FROM memory_cache WHERE sync_status = 0 LIMIT ?`)
          .all(this.BATCH_SIZE) as any[]
        if (pendingMemoryCache.length > 0) {
          hasActualWork = true

          const cacheIds = pendingMemoryCache.map(c => c.id)
          // 锁定状态
          db.prepare(
            `UPDATE memory_cache SET sync_status = 1 WHERE id IN (${cacheIds.map(() => '?').join(',')})`
          ).run(...cacheIds)

          const payload = pendingMemoryCache.map(c => ({
            id: c.id,
            request_data: this.safeJsonParse(c.request_data, []),
            response_data: this.safeJsonParse(c.response_data, {}),
            model: c.model,
            provider: c.provider,
            latency_ms: c.latency_ms,
            file_fingerprint: c.file_fingerprint,
            created_at: toUTCString(c.created_at)
          }))

          await cloudAnalysisService.batchSync({ memory_cache: sanitizeObject(payload) }, language)

          // 成功后删除本地缓存，节省空间
          db.prepare(
            `DELETE FROM memory_cache WHERE id IN (${cacheIds.map(() => '?').join(',')})`
          ).run(...cacheIds)

          logger.info(
            LogCategory.SUPABASE,
            `CloudSyncWorker: 已同步并清理 ${pendingMemoryCache.length} 条微调数据`
          )
        }
      } catch (cacheError) {
        logger.error(LogCategory.SUPABASE, 'CloudSyncWorker: 同步微调数据集失败', {
          error: cacheError
        })
        // 恢复状态为 3 方便重试
        db.prepare(`UPDATE memory_cache SET sync_status = 3 WHERE sync_status = 1`).run()
      }

      // ==================================================================================
      // Phase 2: 同步文件分析数据 (Files & Tags)
      // ==================================================================================

      // 2.1 选取待同步的文件 - 本地同步到云端
      // 规则：选取 sync_status 为 0 (未同步) 或 3 (失败且超过24小时) 的记录
      // 💡 V2 架构修复：需要同时从 files (f) 和 file_contents (fc) 提取数据
      const oneDayAgo = new Date(Date.now() - 86400000).toISOString()
      const pendingFiles = db
        .prepare(
          `
        SELECT f.*, fc.*, wf.workspace_id, wf.id as workspace_file_id
        FROM files f
        JOIN workspace_files wf ON f.file_fingerprint = wf.file_fingerprint
        JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
        JOIN workspaces wd ON wf.workspace_id = wd.workspace_id
        WHERE (f.sync_status = 0 OR (f.sync_status = 3 AND f.modified_at < ?))
          AND f.sync_status != 4
          AND wf.is_analyzed = 1
          AND f.file_fingerprint IS NOT NULL AND f.file_fingerprint NOT LIKE 'temp_%'
          AND wd.type = 'SPEEDY'
        LIMIT ?
      `
        )
        .all(oneDayAgo, this.BATCH_SIZE) as any[]

      if (pendingFiles.length === 0) {
        this.cleanupProcessedExpansions(db)
        return hasActualWork
      }

      hasActualWork = true
      const fileIds = pendingFiles.map(f => f.file_fingerprint)

      // 锁定状态：更新为同步中 (1)
      db.prepare(
        `UPDATE files SET sync_status = 1 WHERE file_fingerprint IN (${fileIds.map(() => '?').join(',')})`
      ).run(...fileIds)

      // 2.2 准备同步标签定义 - 遵循泛维度过滤规则
      const relatedTags = db
        .prepare(
          `
        SELECT DISTINCT ft.* FROM file_tag_relations ftr
        JOIN file_tags ft ON ftr.tag_id = ft.id
        WHERE ftr.file_fingerprint IN (${fileIds.map(() => '?').join(',')})
      `
        )
        .all(...fileIds) as any[]

      if (relatedTags.length > 0) {
        // 推送包含泛维度的所有标签定义
        const tagsToPush = relatedTags

        if (tagsToPush.length > 0) {
          const tagsPayload = tagsToPush.map(t => ({
            name: t.name,
            dimension_id: t.dimension_id,
            created_at: toUTCString(t.created_at)
          }))
          await cloudAnalysisService.batchSync({ tags: sanitizeObject(tagsPayload) }, language)

          // 关键：必须刷新标签映射，以获取云端生成的 tag_id 用于 Phase 2 的关系建立
          // 注意：维度定义不会在会话期间变化，因此只刷新标签，不重新拉取维度定义
          await this.afterSyncTags()
        }

        // 更新所有相关标签的本地同步状态 (包含被过滤的，确保流程推进)
        const allTagIds = relatedTags.map(t => t.id)
        db.prepare(
          `UPDATE file_tags SET sync_status = 2 WHERE id IN (${allTagIds.map(() => '?').join(',')})`
        ).run(...allTagIds)
      }

      // 2.3 构建文件 Payload - 云端 ID 使用本地 file_fingerprint
      // 💡 端云字段设计说明：
      //    - 本地 files 表使用 is_hit (布尔值)：仅需标识文件是否命中云端标准库
      //    - 云端 zh_cn_files 表使用 hit_count (计数器)：需要统计文件被命中的总次数，用于数据分析
      //    - 这是故意的设计差异，不是 Bug。本地只需标识状态，云端需要聚合统计。
      const cloudFiles = pendingFiles.map(f => ({
        file_fingerprint: f.file_fingerprint, // V2 架构：对齐云端 RPC 字段名
        smart_name: f.smart_name,
        size: f.size,
        type: f.type,
        mime_type: f.category,
        author: f.author,
        description: f.description,
        content: f.content,
        language: f.language,
        quality_score: this.ensureReal(f.quality_score, 0),
        quality_confidence: this.ensureReal(f.quality_confidence, 0.5),
        quality_criteria: this.safeJsonParse(f.quality_criteria, null),
        quality_reasoning: f.quality_reasoning,
        grouping_reason: f.grouping_reason,
        grouping_confidence: this.ensureReal(f.grouping_confidence, 0.5),
        metadata: this.safeJsonParse(f.metadata, {}),
        analysis_stats: this.safeJsonParse(f.analysis_stats, null),
        multimodal_content: f.multimodal_content,
        last_analyzed_at: toUTCString(f.last_analyzed_at)
      }))

      // 2.4 建立关系 Payload - 遵循泛维度过滤规则且执行 ID 转换
      const fileTagLinks = db
        .prepare(
          `
        SELECT f.file_fingerprint, ft.name as tag_name, ft.dimension_id
        FROM file_tag_relations ftr
        JOIN files f ON ftr.file_fingerprint = f.file_fingerprint
        JOIN file_tags ft ON ftr.tag_id = ft.id
        WHERE ftr.file_fingerprint IN (${fileIds.map(() => '?').join(',')})
      `
        )
        .all(...fileIds) as any[]

      const relationsPayload = fileTagLinks
        .map(link => {
          // 优先使用维度ID+标签名精确匹配
          let cloudTagId = this.cloudTagMap.get(`${link.dimension_id}:${link.tag_name}`)

          // 如果精确匹配失败，尝试使用标签名回退匹配（处理本地维度ID回退到28的情况）
          if (!cloudTagId) {
            cloudTagId = this.cloudTagNameMap.get(link.tag_name)
            if (cloudTagId) {
              logger.debug(
                LogCategory.SUPABASE,
                `CloudSyncWorker: 标签 "${link.tag_name}" 使用标签名回退匹配 (本地维度ID: ${link.dimension_id})`
              )
            }
          }

          if (!cloudTagId) {
            logger.warn(
              LogCategory.SUPABASE,
              `CloudSyncWorker: 标签 "${link.tag_name}" 未找到云端对应ID，跳过同步`
            )
            return null
          }

          return {
            file_fingerprint: link.file_fingerprint, // V2 架构：对齐云端 RPC 字段名
            tag_id: cloudTagId
          }
        })
        .filter(Boolean)

      // 2.5 执行同步提交
      await cloudAnalysisService.batchSync(
        {
          files: sanitizeObject(cloudFiles),
          tag_relations: sanitizeObject(relationsPayload)
        },
        language
      )

      // 2.6 更新本地同步状态
      db.prepare(
        `UPDATE files SET sync_status = 2 WHERE file_fingerprint IN (${fileIds.map(() => '?').join(',')})`
      ).run(...fileIds)
      db.prepare(
        `UPDATE file_tag_relations SET sync_status = 2 WHERE file_fingerprint IN (${fileIds.map(() => '?').join(',')})`
      ).run(...fileIds)

      logger.info(
        LogCategory.SUPABASE,
        `CloudSyncWorker: 已同步 ${pendingFiles.length} 个文件及 ${relationsPayload.length} 个有效关联 (包含泛维度)`
      )

      this.cleanupProcessedExpansions(db)
      this.nextSyncAllowedAt = null
      return true
    } catch (error) {
      logger.error(LogCategory.SUPABASE, 'CloudSyncWorker: 同步循环异常', { error })

      // 容错：将当前尝试同步的文件状态回退为失败 (3)
      try {
        const db = databaseService.db
        if (db && hasActualWork) {
          // 这里我们无法精确得知哪些成功哪些失败，通常采取保守策略：将本次批次中仍处于 1 (同步中) 的文件设为 3
          // 但为了简单，直接根据 fileIds 回退
          const pendingFiles = db
            .prepare(`SELECT file_fingerprint FROM files WHERE sync_status = 1`)
            .all() as any[]
          if (pendingFiles.length > 0) {
            const ids = pendingFiles.map(f => f.file_fingerprint)
            db.prepare(
              `UPDATE files SET sync_status = 3 WHERE file_fingerprint IN (${ids.map(() => '?').join(',')})`
            ).run(...ids)
          }
        }
      } catch (dbErr) {
        logger.error(LogCategory.SUPABASE, 'CloudSyncWorker: 回退文件同步状态失败:', dbErr)
      }

      const msg = error instanceof Error ? error.message : String(error)
      if (/permission denied/i.test(msg) || /42501/.test(msg)) {
        this.nextSyncAllowedAt = Date.now() + 10 * 60 * 1000
        logger.warn(LogCategory.SUPABASE, 'CloudSyncWorker: 检测到云端权限错误，暂停同步 10 分钟')
      }
      return false
    } finally {
      this.isSyncing = false
    }
  }

  /**
   * 清理本地已审核通过（或已存在于标准库中）的扩展记录
   * 逻辑：如果 dimension_expansions/tag_expansions 中的内容在 file_dimensions/file_tags 中已存在且 sync_status=2，
   * 说明云端已接纳（审核通过）并同步回了本地，此时应删除本地的 expansion 记录以防冗余。
   */
  private cleanupProcessedExpansions(db: any): void {
    try {
      // 1. 清理维度提案
      // 只要 file_dimensions 里有同名且已同步的维度，就删除对应的提案
      const deletedDims = db
        .prepare(
          `
        DELETE FROM dimension_expansions 
        WHERE name IN (
          SELECT name FROM file_dimensions WHERE sync_status = 2
        )
      `
        )
        .run()

      if (deletedDims.changes > 0) {
        logger.info(
          LogCategory.SUPABASE,
          `CloudSyncWorker: Cleaned up ${deletedDims.changes} approved dimension expansions`
        )
      }

      // 2. 清理标签提案
      // 只要 file_tags 里有同名、同维度（通过维度名匹配）且已同步的标签，就删除对应的提案
      // 注意：这里通过维度名关联，因为 ID 可能会变（本地临时 ID vs 云端正式 ID）
      const deletedTags = db
        .prepare(
          `
        DELETE FROM tag_expansions 
        WHERE EXISTS (
          SELECT 1 
          FROM file_tags ft 
          JOIN file_dimensions fd_real ON ft.dimension_id = fd_real.id
          JOIN file_dimensions fd_exp ON tag_expansions.dimension_id = fd_exp.id
          WHERE ft.name = tag_expansions.name 
          AND fd_real.name = fd_exp.name 
          AND ft.sync_status = 2
        )
      `
        )
        .run()

      if (deletedTags.changes > 0) {
        logger.info(
          LogCategory.SUPABASE,
          `CloudSyncWorker: Cleaned up ${deletedTags.changes} approved tag expansions`
        )
      }
    } catch (e) {
      logger.error(LogCategory.SUPABASE, 'Failed to cleanup processed expansions', e)
    }
  }
}

export const cloudSyncWorker = CloudSyncWorker.getInstance()
