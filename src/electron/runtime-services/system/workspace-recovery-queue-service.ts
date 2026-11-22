import { LogCategory, logger, getFileCategory, FileCategory } from '@firefly/shared'
import { databaseService } from '../database/database-service'
import { resolveWorkspaceEffectiveConfig } from './workspace-analysis-context'
import { checkBasicDataCompleteness } from '../analysis-queue-service/file-processor/db-analysis-state'

/**
 * 待补全文件恢复服务 (Recovery Queue Service)
 *
 * 业务背景：
 * 环境受限（缺模型/缺排版组件/降级档位）期间被跳过的分析阶段，在环境恢复后
 * 需要「可发现、可补全、可清除」的闭环。本服务为主进程唯一事实源，提供：
 *   1. 两类待补计数（横幅展示）：非视频缺口(OCR/封面/缩略图/内容) + 待续跑长视频切片
 *   2. 设置页待补文件清单（含每个文件的具体待补项 missingReasons）
 *   3. 永久清除（写 workspace_files.meta，清除后不再计数、不再被「立即补全」捞回）
 *   4. 横幅 24h 静默（写 virtual_directories.meta，关闭后 24 小时内即使有新文件也不再弹）
 *
 * 落库纪律（严格遵循创世基线零兼容原则）：
 * - 清除标记存 workspace_files.meta（弹性 JSON，行级），横幅静默时间戳存
 *   virtual_directories.meta，均零 ALTER TABLE、零新表、零迁移脚本。
 * - 严禁写入 app_config（该表为云端 SSOT，会被 syncFromCloud 下行覆盖）。
 *
 * 性能取舍：
 * - 横幅计数走轻量 SQL（每次快照都要算，须快），为保守近似。
 * - 设置页清单逐文件走 checkBasicDataCompleteness 精确判定（用户主动打开，可接受较慢），
 *   含向量探活等重 IO，二者数量可能略有出入，以清单为权威。
 */

/** 横幅关闭静默时长：24 小时。关闭后 24h 内即使有新文件进入待补也不再弹。 */
export const RECOVERY_BANNER_SILENCE_MS = 24 * 60 * 60 * 1000

/** 单个待补文件（设置页清单项） */
export interface RecoverableFileItem {
  /** workspace_files.id（行级稳定标识） */
  workspaceFileId: number
  fileFingerprint: string | null
  path: string
  name: string
  fileSize: number
  /** 具体待补项缺口码（missingReasons）；pending_video 表示待续跑长视频切片 */
  missingReasons: string[]
  /** 是否为待续跑长视频 */
  isPendingVideo: boolean
}

/** 设置页待补清单整体结构 */
export interface RecoveryQueueResult {
  success: boolean
  items: RecoverableFileItem[]
  error?: string
}

/** 将缺口码映射为用户能理解的大白话类别（用于横幅文案与设置页徽章） */
export function classifyMissingReason(
  reason: string
): 'ocr' | 'cover' | 'thumbnail' | 'content' | 'vector' | 'asr' | 'video' | 'other' {
  if (
    reason === 'pending_video' ||
    reason.startsWith('missing_video_chunks') ||
    reason.startsWith('video_chunk_span_outdated') ||
    reason.startsWith('missing_video_chunk_vectors') ||
    reason === 'video_vector_probe_error' ||
    reason === 'incomplete_video_segments'
  ) {
    return 'video'
  }
  if (reason === 'missing_image_ocr') return 'ocr'
  if (reason === 'missing_office_cover') return 'cover'
  if (reason === 'missing_thumbnail') return 'thumbnail'
  if (reason === 'missing_document_content') return 'content'
  if (reason === 'missing_file_vector' || reason === 'file_vector_probe_error') return 'vector'
  if (reason === 'missing_audio_transcript') return 'asr'
  return 'other'
}

/** 轻量扫描单行（一次 SQL 取齐判定所需列，避免逐文件查询） */
interface ScanRow {
  id: number
  file_fingerprint: string | null
  path: string
  name: string
  file_size: number
  thumbnail_path: string | null
  meta: string
  content: Buffer | string | null
  ocr: Buffer | string | null
  lrc: Buffer | string | null
  asr: Buffer | string | null
  analysis_stats: string | null
}

/** 读取文件的 attempted_empty 空尝试履历（用于横幅近似时排除「已确认内容为空」） */
function readAttemptedEmpty(
  statsRaw: string | null,
  fingerprint: string | null
): {
  ocrEmpty?: boolean
  asrEmpty?: boolean
  ocrModelSize?: 'tiny' | 'small'
  asrDurationSec?: number
  fileFingerprint?: string
} {
  if (!statsRaw) return {}
  try {
    const stats = JSON.parse(statsRaw)
    if (stats && typeof stats.attempted_empty === 'object' && stats.attempted_empty) {
      return stats.attempted_empty
    }
  } catch {
    // 解析失败视为无履历，保守重报
  }
  return {}
}

/** 判断某文件当前是否被标记为「已清除」（不再补全） */
function isCleared(metaRaw: string | null): boolean {
  if (!metaRaw) return false
  try {
    const meta = JSON.parse(metaRaw)
    return meta?.recovery_cleared === true
  } catch {
    return false
  }
}

/** 轻量扫描：横幅计数用，纯 DB 判定、跳过向量探活、忽略能力开关，性能优先 */
export function scanRecoverableFilesLight(db: any, workspaceId: number): RecoverableFileItem[] {
  const rows = db
    .prepare(
      `SELECT wf.id, wf.file_fingerprint, wf.path, wf.name, wf.file_size, wf.thumbnail_path, wf.meta,
              fc.content, fc.ocr, fc.lrc, fc.asr, fc.analysis_stats
       FROM workspace_files wf
       LEFT JOIN file_contents fc ON wf.file_fingerprint = fc.file_fingerprint
       WHERE wf.workspace_id = ?`
    )
    .all(workspaceId) as ScanRow[]

  // 一次查出该工作区所有待续跑长视频切片的 file_id 集合（限定 k >= 1 且 seg_0 已完成，Spec §2.2）
  const pendingVideoIds = new Set<string>(
    (
      db
        .prepare(
          `SELECT DISTINCT fvs.file_id
           FROM file_video_segments fvs
           INNER JOIN workspace_files wf ON wf.file_fingerprint = fvs.file_id
           WHERE wf.workspace_id = ?
             AND fvs.segment_index >= 1
             AND fvs.status = 'pending'
             AND EXISTS (
               SELECT 1 FROM file_video_segments s0
               WHERE s0.file_id = fvs.file_id AND s0.segment_index = 0 AND s0.status = 'completed'
             )`
        )
        .all(workspaceId) as Array<{ file_id: string }>
    ).map(r => r.file_id)
  )

  const items: RecoverableFileItem[] = []
  for (const row of rows) {
    if (isCleared(row.meta)) continue

    const missingReasons: string[] = []
    const category = getFileCategory(row.path)
    const isPendingVideo = row.file_fingerprint != null && pendingVideoIds.has(row.file_fingerprint)
    if (isPendingVideo) {
      missingReasons.push('pending_video')
    }

    const attempted = readAttemptedEmpty(row.analysis_stats, row.file_fingerprint)
    const hasText = (v: Buffer | string | null): boolean => v != null && String(v).length > 0

    if (category === FileCategory.IMAGE) {
      if (!row.thumbnail_path) missingReasons.push('missing_thumbnail')
      if (!hasText(row.ocr) && attempted.ocrEmpty !== true) missingReasons.push('missing_image_ocr')
    } else if (category === FileCategory.AUDIO) {
      if (
        !hasText(row.lrc) &&
        !hasText(row.asr) &&
        !hasText(row.content) &&
        attempted.asrEmpty !== true
      ) {
        missingReasons.push('missing_audio_transcript')
      }
    } else if (category !== FileCategory.VIDEO) {
      // 文档 / 文本 / 代码：缺正文内容
      if (!hasText(row.content)) missingReasons.push('missing_document_content')
      // Office 封面（按扩展名判定）
      const ext = row.path.slice(row.path.lastIndexOf('.')).toLowerCase()
      const OFFICE = new Set([
        '.doc',
        '.docx',
        '.xls',
        '.xlsx',
        '.ppt',
        '.pptx',
        '.odt',
        '.ods',
        '.odp',
        '.wps',
        '.et',
        '.dps'
      ])
      if (OFFICE.has(ext) && !row.thumbnail_path) missingReasons.push('missing_office_cover')
    }

    if (missingReasons.length > 0) {
      items.push({
        workspaceFileId: row.id,
        fileFingerprint: row.file_fingerprint,
        path: row.path,
        name: row.name,
        fileSize: Number(row.file_size ?? 0),
        missingReasons,
        isPendingVideo
      })
    }
  }
  return items
}

/** 两类横幅计数（非视频缺口数 + 待续跑长视频数） */
export interface RecoveryCounts {
  nonVideoCount: number
  pendingVideoCount: number
  totalCount: number
}

export function countRecoverableByCategory(db: any, workspaceId: number): RecoveryCounts {
  const items = scanRecoverableFilesLight(db, workspaceId)
  let nonVideo = 0
  let pendingVideo = 0
  for (const it of items) {
    if (it.isPendingVideo) pendingVideo += 1
    else nonVideo += 1
  }
  return { nonVideoCount: nonVideo, pendingVideoCount: pendingVideo, totalCount: items.length }
}

/**
 * 精确扫描（设置页清单用）：逐文件调用 checkBasicDataCompleteness，含向量探活与能力开关判定。
 * 性能：含 Omni zvec 探活等重 IO，仅在用户主动打开设置页时调用，不用于每次快照的横幅计数。
 * 返回已过滤掉 cleared 文件的清单（清除的文件不再列出，符合「清除后不再补全」）。
 */
export async function listRecoverableFilesPrecise(
  workspaceId: number
): Promise<RecoveryQueueResult> {
  const db = databaseService.db
  if (!db || !Number.isFinite(workspaceId)) {
    return { success: false, items: [], error: 'INVALID_WORKSPACE_OR_DB' }
  }
  try {
    const effectiveConfig = await resolveWorkspaceEffectiveConfig(workspaceId)
    const rows = db
      .prepare(
        `SELECT id, file_fingerprint, path, name, file_size, meta
         FROM workspace_files WHERE workspace_id = ?`
      )
      .all(workspaceId) as Array<{
      id: number
      file_fingerprint: string | null
      path: string
      name: string
      file_size: number
      meta: string
    }>

    const items: RecoverableFileItem[] = []
    for (const row of rows) {
      if (isCleared(row.meta)) continue
      const missingReasons: string[] = []

      // 待续跑长视频（严格限定 k >= 1、在有效上限内且 seg_0 已完成，Spec §2.2）
      if (row.file_fingerprint != null) {
        const configuredRaw = effectiveConfig.effectiveParams.videoAnalyzeDurationSec ?? 300
        const configuredLimit = Math.min(
          10800,
          Math.max(300, Math.round(configuredRaw / 300) * 300)
        )
        const isFreeTier = Boolean((effectiveConfig.capabilities as any)?.isFreeTier)
        const effectiveLimitSec = isFreeTier ? 300 : configuredLimit
        const pendingSeg = db
          .prepare(
            `SELECT 1 FROM file_video_segments s
             WHERE s.file_id = ?
               AND s.segment_index >= 1
               AND s.status = 'pending'
               AND s.start_pts_sec < ?
               AND EXISTS (
                 SELECT 1 FROM file_video_segments s0
                 WHERE s0.file_id = s.file_id AND s0.segment_index = 0 AND s0.status = 'completed'
               )
             LIMIT 1`
          )
          .get(row.file_fingerprint, effectiveLimitSec)
        if (pendingSeg) missingReasons.push('pending_video')
      }

      // 复用权威完整性判定（含向量探活、attempted_empty 短路、能力开关）
      const completeness = await checkBasicDataCompleteness(
        db,
        workspaceId,
        row.path,
        effectiveConfig,
        row.file_fingerprint ?? undefined
      )
      if (!completeness.isComplete) {
        for (const r of completeness.missingReasons) {
          if (!missingReasons.includes(r)) missingReasons.push(r)
        }
      }

      if (missingReasons.length > 0) {
        items.push({
          workspaceFileId: row.id,
          fileFingerprint: row.file_fingerprint,
          path: row.path,
          name: row.name,
          fileSize: Number(row.file_size ?? 0),
          missingReasons,
          isPendingVideo: missingReasons.includes('pending_video')
        })
      }
    }
    return { success: true, items }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(LogCategory.SYSTEM, '[RecoveryQueue] 精确清单扫描失败:', error)
    return { success: false, items: [], error: message }
  }
}

/** 永久清除：写 workspace_files.meta.recovery_cleared，清除后不再计数、不再被「立即补全」捞回 */
export function clearRecoverableFiles(
  workspaceId: number,
  workspaceFileIds: number[]
): { success: boolean; cleared?: number; error?: string } {
  const db = databaseService.db
  if (!db || !Number.isFinite(workspaceId)) {
    return { success: false, error: 'INVALID_WORKSPACE_OR_DB' }
  }
  if (!Array.isArray(workspaceFileIds) || workspaceFileIds.length === 0) {
    return { success: true, cleared: 0 }
  }
  try {
    const getIdStmt = db.prepare(
      `SELECT id, meta FROM workspace_files WHERE id = ? AND workspace_id = ?`
    )
    const updStmt = db.prepare(`UPDATE workspace_files SET meta = ? WHERE id = ?`)
    let cleared = 0
    const tx = db.transaction((ids: number[]) => {
      for (const id of ids) {
        const row = getIdStmt.get(id, workspaceId) as { id: number; meta: string } | undefined
        if (!row) continue
        let meta: Record<string, unknown> = {}
        try {
          meta = row.meta ? JSON.parse(row.meta) : {}
        } catch {
          meta = {}
        }
        meta.recovery_cleared = true
        meta.recovery_cleared_at = new Date().toISOString()
        updStmt.run(JSON.stringify(meta), row.id)
        cleared += 1
      }
    })
    tx(workspaceFileIds)
    return { success: true, cleared }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(LogCategory.SYSTEM, '[RecoveryQueue] 清除待补文件失败:', error)
    return { success: false, error: message }
  }
}

/** 读取横幅静默时间戳；null = 未静默或已过 24h */
function readBannerSilencedAt(db: any, workspaceId: number): number | null {
  const row = db.prepare(`SELECT meta FROM workspaces WHERE workspace_id = ?`).get(workspaceId) as
    | { meta: string }
    | undefined
  if (!row?.meta) return null
  try {
    const meta = JSON.parse(row.meta)
    const ts = meta?.recovery_banner_dismissed_at
    return typeof ts === 'number' ? ts : null
  } catch {
    return null
  }
}

/** 横幅是否处于 24h 静默期（关闭后 24h 内即使有新文件也不再弹） */
export function isRecoveryBannerSilenced(db: any, workspaceId: number): boolean {
  const silencedAt = readBannerSilencedAt(db, workspaceId)
  if (silencedAt == null) return false
  return Date.now() - silencedAt < RECOVERY_BANNER_SILENCE_MS
}

/** 记录横幅关闭：写 workspaces.meta.recovery_banner_dismissed_at = now，启动 24h 静默 */
export function dismissRecoveryBanner(workspaceId: number): { success: boolean; error?: string } {
  const db = databaseService.db
  if (!db || !Number.isFinite(workspaceId)) {
    return { success: false, error: 'INVALID_WORKSPACE_OR_DB' }
  }
  try {
    const row = db
      .prepare(`SELECT meta FROM workspaces WHERE workspace_id = ?`)
      .get(workspaceId) as { meta: string } | undefined
    let meta: Record<string, unknown> = {}
    try {
      meta = row?.meta ? JSON.parse(row.meta) : {}
    } catch {
      meta = {}
    }
    meta.recovery_banner_dismissed_at = Date.now()
    db.prepare(`UPDATE workspaces SET meta = ? WHERE workspace_id = ?`).run(
      JSON.stringify(meta),
      workspaceId
    )
    return { success: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(LogCategory.SYSTEM, '[RecoveryQueue] 记录横幅关闭失败:', error)
    return { success: false, error: message }
  }
}

/**
 * 触发补全入队：把指定文件的「待续跑长视频」与非视频缺口一并交还分析队列。
 * - 复用既有 addItems（队列内部按需重新跑 checkBasicDataCompleteness 决定补哪些阶段）。
 * - 仅入队未被清除的文件；清除的文件即使传入也被忽略。
 */
export async function enqueueRecovery(
  workspaceId: number,
  workspaceFileIds?: number[]
): Promise<{ success: boolean; queued?: number; error?: string }> {
  const db = databaseService.db
  if (!db || !Number.isFinite(workspaceId)) {
    return { success: false, error: 'INVALID_WORKSPACE_OR_DB' }
  }
  try {
    let items = scanRecoverableFilesLight(db, workspaceId)
    if (workspaceFileIds && workspaceFileIds.length > 0) {
      const idSet = new Set(workspaceFileIds)
      items = items.filter(it => idSet.has(it.workspaceFileId))
    }
    if (items.length === 0) return { success: true, queued: 0 }
    const { analysisQueueService } = await import('../analysis-queue-service')
    // Spec §2.2：含非视频缺口（OCR/封面/转录）的文件入主队列重跑标签与 Stage 3/4；
    // 纯长视频待补切片禁止入主队列 addItems，统一唤醒独立单切片后台回填器。
    const nonVideoItems = items.filter(it => it.missingReasons.some(r => r !== 'pending_video'))
    const videoItems = items.filter(it => it.isPendingVideo)
    if (nonVideoItems.length > 0) {
      await analysisQueueService.addItems(
        nonVideoItems.map(it => ({
          path: it.path,
          name: it.name,
          size: Number(it.fileSize ?? 0),
          type: 'file' as const,
          workspaceId
        }))
      )
    }
    if (videoItems.length > 0) {
      analysisQueueService.startVideoBackfill('manual_recovery')
    }
    return { success: true, queued: items.length }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    logger.warn(LogCategory.SYSTEM, '[RecoveryQueue] 触发补全入队失败:', error)
    return { success: false, error: message }
  }
}
