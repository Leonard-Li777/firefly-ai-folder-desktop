import path from 'node:path'
import {
  LogCategory,
  logger,
  FileCategory,
  getFileCategory,
  computeVideoVisualParamsHash,
  isVideoSegmentReusable,
  INFINITY
} from '@firefly/shared'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'
import { omniClient } from '../../../services/omni-client'
import { decompressText } from '../../../utils/text-compressor'
import type { EffectiveWorkspaceAIConfigResult } from '../../system/workspace-analysis-context'
import { StageReusePlanner } from './stage-reuse-planner'

export interface WorkspaceVideoDurationLimits {
  /** 是否处于免费版或权益未就绪受限态（以 videoMaxAnalyzeSec 是否定义为准，与 shared 同源） */
  isFreeTier: boolean
  /** 权益允许的最大时长上限（秒），无上限时为 INFINITY (999999999) */
  entitlementLimitSec: number
  /** 工作区设定的目标分析上限（秒，范围 300~10800，按 300 秒对齐） */
  configuredLimitSec: number
  /** 实际允许后台执行器运行的生效上限（秒；尊重纯 CPU 1800s 硬件降级与引擎冻结态 0s） */
  effectiveLimitSec: number
}

function normalizeSnappedDurationSec(raw: unknown, fallbackSec: number): number {
  const safe = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallbackSec
  if (safe <= 0) return 0
  return Math.min(10800, Math.max(300, Math.round(safe / 300) * 300))
}

/**
 * 解析工作区长视频分析的「配置目标上限」与「实际生效上限」：
 * - configuredLimitSec 优先读取未被免费钳位覆盖的 desiredValue，保证待补列表展示与升级漏斗始终反映工作区配置；
 * - entitlementLimitSec 取 videoMaxAnalyzeSec 与合法 computedLimits 的更严上限，杜绝冷启动 tierReady=false 窗口期被缓存 Pro 权益击穿；
 * - effectiveLimitSec 受限于 entitlementLimitSec 与 effectiveParams.videoAnalyzeDurationSec，严守纯 CPU 降级与引擎冻结边界。
 */
export function resolveWorkspaceVideoDurationLimits(
  effectiveConfig: {
    capabilities: Pick<EffectiveWorkspaceAIConfigResult['capabilities'], 'videoMaxAnalyzeSec'> &
      Partial<Pick<EffectiveWorkspaceAIConfigResult['capabilities'], 'videoVisualAnalysisEnabled'>>
    effectiveParams: Pick<
      EffectiveWorkspaceAIConfigResult['effectiveParams'],
      'videoAnalyzeDurationSec'
    >
    fields?: {
      videoAnalyzeDurationSec?: Pick<
        EffectiveWorkspaceAIConfigResult['fields']['videoAnalyzeDurationSec'],
        'desiredValue'
      >
    }
  },
  computedLimits?: { video_max_duration_seconds?: number | null } | null
): WorkspaceVideoDurationLimits {
  const rawCapMax = effectiveConfig.capabilities.videoMaxAnalyzeSec
  const safeCapMax =
    typeof rawCapMax === 'number' && Number.isFinite(rawCapMax) ? Math.max(0, rawCapMax) : undefined
  const isFreeTier = safeCapMax !== undefined

  const rawEntitlement = computedLimits?.video_max_duration_seconds
  const safeRawEntitlement =
    typeof rawEntitlement === 'number' && Number.isFinite(rawEntitlement) && rawEntitlement >= 0
      ? rawEntitlement
      : undefined

  // 两者同时存在时取较严者，防止 tierReady=false (safeCapMax=300) 被本地缓存 Pro 权益覆盖越权
  const entitlementLimitSec =
    safeCapMax !== undefined && safeRawEntitlement !== undefined
      ? Math.min(safeCapMax, safeRawEntitlement)
      : (safeRawEntitlement ?? safeCapMax ?? INFINITY)

  const desiredRaw =
    effectiveConfig.fields?.videoAnalyzeDurationSec?.desiredValue ??
    effectiveConfig.effectiveParams.videoAnalyzeDurationSec
  const desiredLimitSec = normalizeSnappedDurationSec(desiredRaw, 300)
  const configuredLimitSec = desiredLimitSec === 0 ? 300 : desiredLimitSec

  if (effectiveConfig.capabilities.videoVisualAnalysisEnabled === false) {
    return {
      isFreeTier,
      entitlementLimitSec,
      configuredLimitSec,
      effectiveLimitSec: 0
    }
  }

  const effectiveRaw = effectiveConfig.effectiveParams.videoAnalyzeDurationSec ?? configuredLimitSec
  const effectiveConfiguredLimitSec =
    effectiveRaw === 0 ? 0 : normalizeSnappedDurationSec(effectiveRaw, configuredLimitSec)
  const effectiveLimitSec = Math.min(entitlementLimitSec, effectiveConfiguredLimitSec)

  return {
    isFreeTier,
    entitlementLimitSec,
    configuredLimitSec,
    effectiveLimitSec
  }
}

export function getFileStageFromDB(db: any, workspaceId: number, filePath: string): number {
  try {
    const row = db
      .prepare(
        `
        SELECT fc.analysis_stats
        FROM workspace_files wf
        JOIN files f ON wf.file_fingerprint = f.file_fingerprint
        LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
        WHERE wf.workspace_id = ? AND wf.path = ?
      `
      )
      .get(workspaceId, filePath) as { analysis_stats?: string } | undefined

    if (row?.analysis_stats) {
      const stats = JSON.parse(row.analysis_stats)
      if (stats && typeof stats === 'object' && stats.analysis_stage !== undefined) {
        return Number(stats.analysis_stage)
      }
    }
  } catch (e) {
    logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] 获取 file stage 失败:', e)
  }
  return 0
}

/**
 * 获取文件的分析阶段 stage 以及是否已完成过分析（is_analyzed）
 * 用于判断重新分析时是否真正复用已有提取数据：
 * - is_analyzed = true：文件之前已完成分析，复用关闭时须重新提取
 * - is_analyzed = false：文件尚未分析完成（如刚做完 stage1/2 后暂停），已有数据有效，可复用
 */
export function getFileAnalysisStateFromDB(
  db: any,
  workspaceId: number,
  filePath: string
): { stage: number; isAnalyzed: boolean } {
  try {
    const row = db
      .prepare(
        `
        SELECT wf.is_analyzed, fc.analysis_stats
        FROM workspace_files wf
        JOIN files f ON wf.file_fingerprint = f.file_fingerprint
        LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
        WHERE wf.workspace_id = ? AND wf.path = ?
      `
      )
      .get(workspaceId, filePath) as { is_analyzed?: number; analysis_stats?: string } | undefined

    let stage = 0
    if (row?.analysis_stats) {
      try {
        const stats = JSON.parse(row.analysis_stats)
        if (stats && typeof stats === 'object' && stats.analysis_stage !== undefined) {
          stage = Number(stats.analysis_stage)
        }
      } catch {
        // 忽略解析错误，stage 保持 0
      }
    }
    return { stage, isAnalyzed: row?.is_analyzed === 1 }
  } catch (e) {
    logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] 获取文件分析状态失败:', e)
  }
  return { stage: 0, isAnalyzed: false }
}

/**
 * 基础数据完整性校验结果
 */
export interface BasicDataCompletenessResult {
  isComplete: boolean
  missingReasons: string[]
}

/**
 * 检查文件核心基础数据与向量数据的健全性（用于决定重新分析时是否安全复用并跳过 CPU 阶段）
 * 涵盖：全量/切片向量探活、文本内容/摘要、图片/文档 OCR、音频 ASR/LRC 等
 */
export async function checkBasicDataCompleteness(
  db: any,
  workspaceId: number,
  filePath: string,
  effectiveConfig: EffectiveWorkspaceAIConfigResult,
  fingerprint?: string
): Promise<BasicDataCompletenessResult> {
  return StageReusePlanner.checkSingleCompleteness(
    db,
    workspaceId,
    filePath,
    effectiveConfig,
    fingerprint
  )
}

/**
 * 统计待增量补齐的可恢复文件数（contextEpoch 提升时轻量扫描）。
 * Free -> Pro 长视频续跑直接复用既有 file_video_segments 外键同源事实：
 * `file_video_segments.file_id TEXT NOT NULL` 直指 `files(file_fingerprint)`（database.ts:481/495），
 * 零新表零新索引、零 ALTER TABLE。
 */
export function countRecoverableFiles(db: any, workspaceId: number): number {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM workspace_files wf
         WHERE wf.workspace_id = ?
           AND EXISTS (
             SELECT 1 FROM file_video_segments fvs
             WHERE fvs.file_id = wf.file_fingerprint AND fvs.status = 'pending'
           )`
      )
      .get(workspaceId) as { n?: number } | undefined
    return Number(row?.n ?? 0)
  } catch (error) {
    logger.warn(LogCategory.ANALYSIS_QUEUE, '[分析队列] 可恢复文件统计失败:', error)
    return 0
  }
}
