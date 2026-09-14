import {
  AnalysisQueueItem,
  MagikaFileCategory as MagikaCategory,
  MarkitdownBenchmark,
  Stage1Benchmark
} from '@firefly/types'
import {
  LogCategory,
  logger,
  PerformanceTimer,
  isHumanReadable,
  applyMarkitdownBenchmark
} from '@firefly/shared'
import { t } from '@app/languages'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'
import { isAnalyzedForMode, resolveAnalysisMode } from '../../../config/analysis-mode'
import { databaseService } from '../../database/database-service'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 将本地分析结果持久化到数据库
 */
export async function saveLocalAnalysisResult(
  item: AnalysisQueueItem,
  fileFingerprint: string,
  processResult: any,
  magikaCategory: MagikaCategory | null,
  enhancedSmartName: string,
  enhancedFileType: string,
  thumbnailRelativePath: string | undefined,
  currentWorkspaceId: number,
  timer: PerformanceTimer,
  collectAnalysisStats: (timer: PerformanceTimer) => Promise<any>,
  isBasic: boolean = false,
  groupingReason?: string | null,
  groupingConfidence?: number | null,
  markitdownBenchmark?: MarkitdownBenchmark | null,
  analysisStage?: number,
  cpuSkipped?: boolean,
  stage1Benchmark?: Stage1Benchmark | null
): Promise<any> {
  const db = databaseService.db
  if (!db) throw new Error(t('数据库未初始化'))

  const filePath = (item as any).file_path || item.path
  const fileType = enhancedFileType || path.extname(filePath).toLowerCase() || ''
  const extractedContent = processResult.content ?? null

  // 清理内容中的不可打印控制字符（0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F）
  // 避免 isHumanReadable 因 OCR 残留控制字符返回 false
  const cleanedContent = extractedContent
    ? extractedContent.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    : extractedContent

  const isBinaryNulSkip = !!cleanedContent && cleanedContent.includes('[Binary File] NUL byte detected')
  const isReadable = !isBinaryNulSkip && isHumanReadable(cleanedContent)

  const shouldSaveContent = isReadable

  logger.debug(
    LogCategory.ANALYSIS_QUEUE,
    `[saveLocal] content保存决策: item.name=${item.name} fileType=${fileType} magikaGroup=${magikaCategory ? (typeof magikaCategory === 'string' ? magikaCategory : magikaCategory.group) : 'none'} isReadable=${isReadable} contentLen=${extractedContent?.length ?? 0} cleanedLen=${cleanedContent?.length ?? 0} willSave=${shouldSaveContent}`
  )
  const stats = fs.statSync(filePath)

  // 收集分析统计信息
  const initialStats = await collectAnalysisStats(timer)
  const initialStatsWithBenchmark = applyMarkitdownBenchmark(
    initialStats,
    markitdownBenchmark,
    stage1Benchmark
  )
  if (initialStatsWithBenchmark.performance?.fresh && markitdownBenchmark) {
    initialStatsWithBenchmark.performance.fresh.contentExtractionBreakdown = markitdownBenchmark
  }
  if (initialStatsWithBenchmark.performance?.fresh && stage1Benchmark) {
    initialStatsWithBenchmark.performance.fresh.stage1Breakdown = stage1Benchmark
  }
  // 本次分析跳过 CPU 提取（复用历史数据）：标记 fresh 为全新批次，供 merge 时重建
  if (initialStatsWithBenchmark.performance?.fresh && cpuSkipped) {
    initialStatsWithBenchmark.performance.fresh.cpuSkipped = true
  }

  // 基础分析（简单分类）的完成阶段是 2（CPU 内容提取完成），非 1；
  // 非基础分析（AI 阶段落库）的默认完成阶段是 4。
  const finalStage = analysisStage !== undefined ? analysisStage : isBasic ? 2 : 4
  initialStatsWithBenchmark.analysis_stage = finalStage

  // 记录「本次分析实际采用的模式」。
  //
  // 存在的必要性：quick_name 与 full 的终态 stage 都是 4，
  // 但 quick_name 跳过了质量评分（stage 3），二者能力不同。
  // 仅凭 stage 无法区分，故额外落库 completed_mode，
  // 使后续判定能识别「用 quick_name 分析过的文件在 full 模式下尚未完成」。
  //
  // 注意：isBasic 表示走的是简单分类分支，此时模式可能是 simple。
  const effectiveMode = resolveAnalysisMode()
  initialStatsWithBenchmark.completed_mode = effectiveMode

  // 统一通过「分析模式单一事实来源」判定是否完成。
  // 此处 completedMode 即本次刚写入的模式，等级覆盖判定天然成立：
  // 本次分析已达成当前模式要求，故只需校验 stage 是否达标。
  const isAnalyzed = isAnalyzedForMode({
    stage: finalStage,
    completedMode: effectiveMode,
    mode: effectiveMode
  })

  // 获取或创建 workspace_files 记录
  const dirPath = path.dirname(filePath)
  const directoryId = await databaseService.addDirectory(dirPath, currentWorkspaceId)

  db.prepare(
    `
    INSERT INTO workspace_files (
      file_fingerprint, workspace_id, directory_id, path, name,
      created_at, modified_at, accessed_at, is_analyzed
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id, path) DO UPDATE SET
      file_fingerprint = excluded.file_fingerprint,
      is_analyzed = excluded.is_analyzed,
      modified_at = excluded.modified_at,
      accessed_at = ?
  `
  ).run(
    fileFingerprint,
    currentWorkspaceId,
    directoryId,
    filePath,
    path.basename(filePath),
    new Date(stats.birthtime).toISOString(),
    new Date(stats.mtime).toISOString(),
    new Date(stats.atime).toISOString(),
    isAnalyzed ? 1 : 0,
    new Date().toISOString()
  )

  const workspaceFile = db
    .prepare(`SELECT id FROM workspace_files WHERE workspace_id = ? AND path = ?`)
    .get(currentWorkspaceId, filePath) as any

  if (!workspaceFile) {
    throw new Error(t('无法获取文件路径记录'))
  }

  await databaseService.updateFileAnalysisResult(workspaceFile.id, {
    contentHash: fileFingerprint,
    size: stats.size,
    smartName: enhancedSmartName,
    type: fileType,
    modifiedAt: stats.mtime.toISOString(),
    accessedAt: stats.atime.toISOString(),
    category: magikaCategory,
    content: isReadable ? cleanedContent : null,
    description: processResult.description || null,
    multimodalContent: processResult.multimodalContent || null,
    lrc: processResult.lrc || null,
    qualityScore: processResult.qualityScore || null,
    qualityConfidence: processResult.qualityConfidence || null,
    qualityReasoning: processResult.qualityReasoning || null,
    qualityCriteria: processResult.qualityCriteria || null,
    groupingReason: groupingReason ?? null,
    groupingConfidence: groupingConfidence ?? null,
    thumbnailPath: thumbnailRelativePath || null,
    metadata: processResult.metadata,
    analysisStats: initialStatsWithBenchmark,
    isHit: false,
    syncStatus: isBasic ? 4 : 0
  })

  return { workspaceFile, initialStats }
}
