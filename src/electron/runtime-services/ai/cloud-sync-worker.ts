import {
  LogCategory,
  logger,
  safeTruncateUtf8Bytes,
  sanitizeObject,
  toUTCString
} from '@firefly/shared'
import { net, powerMonitor } from 'electron'

import { cloudAnalysisService } from '@firefly/server'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { decompressJson, decompressText } from '../../utils/text-compressor'
import { databaseService } from '../database/database-service'
import { userTierService } from '../user-tier/user-tier-service'

/**
 * 云端同步 Worker
 * 负责在系统空闲且网络连通时，将本地未同步的数据批量上传至云端
 */
export class CloudSyncWorker {
  private static instance: CloudSyncWorker
  private isSyncing = false
  private checkInterval: NodeJS.Timeout | null = null
  /** 标记当前 runCycle 循环是否仍有效，防止 stop() 后旧循环继续调度新定时器 */
  private cycleValid = false
  private readonly BATCH_SIZE = 50

  /**
   * 【V4 自然主键直通架构】
   * 端云已完全以 `code` / `tag_code` 自然主键 1:1 对齐，
   * 因此彻底移除了 cloudDimMap / cloudTagMap / cloudTagNameMap 等自增 ID 映射字典。
   * 同步器不再需要任何 ID 反查与映射刷新流程。
   */
  private initialized = false
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
   * 初始化同步器
   *
   * 【V4 自然主键直通架构】无需再拉取并缓存云端自增 ID 映射字典，
   * 本方法仅做一次幂等的就绪标记，保持对外契约兼容。
   */
  public async refreshCloudMaps(): Promise<void> {
    if (!this.shouldSyncToCloud()) {
      logger.debug(
        LogCategory.SUPABASE,
        'CloudSyncWorker: sync_analysis_to_cloud is disabled, skipping initialization'
      )
      return
    }

    this.initialized = true
    logger.info(
      LogCategory.SUPABASE,
      'CloudSyncWorker: 已就绪（V4 自然主键直通模式，无需云端 ID 映射字典）'
    )
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
    if (this.isSyncing) return false

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

      // ==================================================================================
      // 【V4 自然主键直通架构】
      // Phase 0（维度/标签扩展提案同步）已彻底删除：
      // 本地已无 dimension_expansions / tag_expansions 表，且不再依赖云端自增 ID 回传覆盖。
      // 扩展标签定义统一通过 Phase 2 的 file_tags_private (code 自然主键) 直接推送。
      // ==================================================================================

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
            created_at: new Date(c.created_at_ms).toISOString()
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

        // Issue 05 Step 4：memory_cache 7 天 TTL 清理（同步失败残留的过期缓存）
        const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
        const ttlResult = db
          .prepare('DELETE FROM memory_cache WHERE created_at_ms < ? AND sync_status != 1')
          .run(sevenDaysAgo)
        if (ttlResult.changes > 0) {
          logger.info(
            LogCategory.SUPABASE,
            `CloudSyncWorker: 已清理 ${ttlResult.changes} 条 7 天过期微调缓存（TTL）`
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
        return hasActualWork
      }

      hasActualWork = true
      const fileIds = pendingFiles.map(f => f.file_fingerprint)

      // 锁定状态：更新为同步中 (1)
      db.prepare(
        `UPDATE files SET sync_status = 1 WHERE file_fingerprint IN (${fileIds.map(() => '?').join(',')})`
      ).run(...fileIds)

      // 2.2 准备同步标签定义（V4 自然主键直通：以完整对象推送 code/name/parent_codes/depth 等）
      const relatedTags = db
        .prepare(
          `
        SELECT DISTINCT ft.* FROM file_tag_relations ftr
        JOIN file_tags_private ft ON ftr.tag_code = ft.code
        WHERE ftr.file_fingerprint IN (${fileIds.map(() => '?').join(',')})
      `
        )
        .all(...fileIds) as any[]

      const tagsPayload =
        relatedTags.length > 0
          ? relatedTags.map(t => ({
              code: t.code,
              locale: language,
              name: t.name,
              parent_codes: this.safeJsonParse(t.parent_codes, []),
              file_groups: this.safeJsonParse(t.file_groups, []),
              source: t.source || 'expanded',
              meta: this.safeJsonParse(t.meta, {})
            }))
          : []

      // 2.3 构建文件 Payload - 云端 ID 使用本地 file_fingerprint
      // 💡 端云字段设计说明：
      //    - 本地 files 表使用 is_hit (布尔值)：仅需标识文件是否命中云端标准库
      //    - 云端 files 表使用 hit_count (计数器)：由端侧 60s 节流 rpc_report_cache_hits 异步汇总
      // MAX_TEXT_LENGTH 以 UTF-8 「字节」为口径，对 content/ocr/asr/lrc/multimodal_content 统一安全截断
      const maxTextBytes =
        ConfigOrchestrator.getInstance().getValue<number>('MAX_TEXT_LENGTH') ?? 30000

      const cloudFiles = pendingFiles.map(f => {
        const plainContent = decompressText(f.content)
        const cloudContent = safeTruncateUtf8Bytes(plainContent, maxTextBytes)
        const cloudOcr = safeTruncateUtf8Bytes(decompressText(f.ocr), maxTextBytes) || null
        const cloudAsr = safeTruncateUtf8Bytes(decompressText(f.asr), maxTextBytes) || null
        const cloudLrc = safeTruncateUtf8Bytes(decompressText(f.lrc), maxTextBytes) || null
        const cloudMultimodal =
          safeTruncateUtf8Bytes(decompressText(f.multimodal_content), maxTextBytes) || null

        // ADR-0054：本地 SQLite 与云端双端零向量对齐（向量仅驻留端侧 zvec），
        // 上行云端时防御性剥离可能残留的任何向量字段
        const rawMeta = decompressJson(f.exif) ?? {}
        if (rawMeta && typeof rawMeta === 'object') {
          delete (rawMeta as any).embedding_dense
          delete (rawMeta as any).embeddingDense
          delete (rawMeta as any).embedding_wemm
          delete (rawMeta as any).embeddingWemm
        }

        return {
          file_fingerprint: f.file_fingerprint,
          smart_name: f.smart_name,
          raw_smart_name: f.raw_smart_name || null,
          smart_name_source: f.smart_name_source ?? null,
          smart_name_template_source: f.smart_name_template_source ?? null,
          size: f.size,
          extension: f.extension,
          file_group: f.file_group,
          author: f.author,
          description: f.description,
          content: cloudContent,
          ocr: cloudOcr,
          asr: cloudAsr,
          lrc: cloudLrc,
          language: f.language,
          // [R2-5 ②] 本地未评估时严禁伪造 0 / 0.5 覆盖云端已有高分评分，必须原样透传 null
          quality_score: f.quality_score != null ? this.ensureReal(f.quality_score, 0) : null,
          quality_confidence:
            f.quality_confidence != null ? this.ensureReal(f.quality_confidence, 0.5) : null,
          quality_criteria: this.safeJsonParse(f.quality_criteria, null),
          quality_reasoning: f.quality_reasoning,
          grouping_reason: f.grouping_reason,
          grouping_confidence:
            f.grouping_confidence != null ? this.ensureReal(f.grouping_confidence, 0.5) : null,
          exif: rawMeta,
          analysis_stats: this.safeJsonParse(f.analysis_stats, null),
          multimodal_content: cloudMultimodal,
          last_analyzed_at: toUTCString(f.last_analyzed_at)
        }
      })

      // 2.4 建立关系 Payload（V4 模型 B：JOIN tag_paths 获取规范 code_path 与 depth）
      const relationsPayload = db
        .prepare(
          `
        SELECT ftr.file_fingerprint, ftr.tag_code, ftr.via_parent_code,
               tp.code_path, tp.depth,
               ftr.tag_group, ftr.confidence, ftr.source, ftr.meta
        FROM file_tag_relations ftr
        LEFT JOIN tag_paths tp ON tp.path_id = ftr.path_id
        WHERE ftr.file_fingerprint IN (${fileIds.map(() => '?').join(',')})
      `
        )
        .all(...fileIds)
        .map((link: any) => ({
          file_fingerprint: link.file_fingerprint,
          tag_code: link.tag_code,
          via_parent_code: link.via_parent_code || '',
          code_path:
            link.code_path ||
            (link.via_parent_code
              ? `/${link.via_parent_code}/${link.tag_code}`
              : `/${link.tag_code}`),
          depth: link.depth ?? 1,
          tag_group: link.tag_group || '',
          confidence: this.ensureReal(link.confidence, 1.0),
          source: link.source || 'rule',
          meta: this.safeJsonParse(link.meta, {})
        }))

      // 2.5 V4 单 RTT 原子合并提交（files + file_contents + file_localizations + file_tags_private + file_tag_relations）
      await cloudAnalysisService.batchSync(
        {
          files: sanitizeObject(cloudFiles),
          tags: sanitizeObject(tagsPayload),
          tag_relations: sanitizeObject(relationsPayload)
        },
        language
      )

      // 2.6 更新本地同步状态（按 file_fingerprint 与 code 原子更新）
      if (relatedTags.length > 0) {
        const allTagCodes = relatedTags.map(t => t.code)
        db.prepare(
          `UPDATE file_tags_private SET sync_status = 2 WHERE code IN (${allTagCodes.map(() => '?').join(',')})`
        ).run(...allTagCodes)
      }
      db.prepare(
        `UPDATE files SET sync_status = 2 WHERE file_fingerprint IN (${fileIds.map(() => '?').join(',')})`
      ).run(...fileIds)
      db.prepare(
        `UPDATE file_tag_relations SET sync_status = 2 WHERE file_fingerprint IN (${fileIds.map(() => '?').join(',')})`
      ).run(...fileIds)

      logger.info(
        LogCategory.SUPABASE,
        `CloudSyncWorker: 已同步 ${pendingFiles.length} 个文件及 ${relationsPayload.length} 个标签关联（自然主键直通）`
      )

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

  // 【V4 自然主键直通架构】cleanupProcessedExpansions 已彻底删除。
  // 本地已不存在 dimension_expansions / tag_expansions 提案表，
  // 扩展标签定义通过 file_tags_private(code 自然主键) 与云端 1:1 直通，无需任何提案清理流程。
}

export const cloudSyncWorker = CloudSyncWorker.getInstance()
