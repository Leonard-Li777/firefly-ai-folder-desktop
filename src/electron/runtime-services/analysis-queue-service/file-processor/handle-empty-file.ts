import { AnalysisQueueItem } from '@firefly/types'
import { databaseService } from '../../database/database-service'
import { LogCategory, logger, insertTagToDb } from '@firefly/shared'
import { t } from '@app/languages'
import { SYSTEM_TAG_NAMES } from '../../../adapters/tag-tree-view-adapter'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 处理空文件
 */
export async function handleEmptyFile(item: AnalysisQueueItem, workspaceId: number): Promise<void> {
  const db = databaseService.db
  if (!db) throw new Error(t('数据库未初始化'))

  const filePath = (item as any).file_path || item.path
  const fileType = item.type || path.extname(filePath).toLowerCase() || ''
  const fileName = item.name || path.basename(filePath) || t('未知文件')
  // 空文件智能名：原文件名前添加 "[空文件]" 前缀，便于直观区分空文件。
  // 前缀使用 t() 包裹，与 "空文件" 默认标签保持一致（smart_name 为持久化数据，生成后不随语言切换重算）。
  // 落盘时 updateFileAnalysisResult 内部会经 resolveUniqueSmartName 重名去重（冲突时追加序号）。
  const emptySmartName = `[${t('空文件')}] ${fileName}`
  const stats = fs.statSync(filePath)
  const emptyHash = '0'.repeat(32)

  const dirPath = path.dirname(filePath)
  const directoryId = await databaseService.addDirectory(dirPath, workspaceId)

  db.prepare(
    `INSERT OR IGNORE INTO files (file_fingerprint, smart_name, size, extension, file_group, created_at, modified_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    emptyHash,
    emptySmartName,
    0,
    fileType,
    JSON.stringify({
      description: 'empty',
      extensions: [fileType.replace('.', '')],
      group: 'text',
      is_text: true,
      label: 'empty',
      mime_type: 'text/plain',
      score: 1
    }),
    new Date(stats.birthtime).toISOString(),
    new Date(stats.mtime).toISOString(),
    new Date(stats.atime).toISOString()
  )
  db.prepare(
    `INSERT OR IGNORE INTO workspace_files (file_fingerprint, workspace_id, directory_id, path, name, created_at, modified_at, accessed_at, is_analyzed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    emptyHash,
    workspaceId,
    directoryId,
    filePath,
    fileName,
    new Date(stats.birthtime).toISOString(),
    new Date(stats.mtime).toISOString(),
    new Date(stats.atime).toISOString(),
    0
  )

  const wf = db
    .prepare(`SELECT id FROM workspace_files WHERE workspace_id = ? AND path = ?`)
    .get(workspaceId, filePath) as any
  await databaseService.updateFileAnalysisResult(wf?.id || 0, {
    contentHash: emptyHash,
    size: 0,
    modifiedAt: stats.mtime.toISOString(),
    accessedAt: stats.atime.toISOString(),
    smartName: emptySmartName,
    type: path.extname(filePath).toLowerCase() || 'unknown',
    description: t('空文件'),
    content: '',
    multimodalContent: null,
    lrc: null,
    qualityScore: 1,
    qualityConfidence: 1,
    qualityReasoning: t('文件大小为0'),
    qualityCriteria: {},
    groupingReason: null,
    groupingConfidence: null,
    author: null,
    language: null,
    metadata: {},
    thumbnailPath: null,
    // 空文件无需执行 AI 分析，直接标记完成全部阶段（stage = 4）
    analysisStats: {
      analysis_stage: 4,
      performance: {
        fresh: {
          accelerator: 'cpu',
          durationMs: 0,
          phases: {}
        }
      }
    },
    isHit: false,
    syncStatus: 0
  })

  const emptyTagLabel = t('空文件')
  try {
    db.transaction(() => {
      // Fix-08（ADR-0035 code 治理）：系统兜底标签按稳定 code 定位 —— 中文规范词形经
      // zh-CN 分表反查 code（omw > builtin，与 Omni 识别动态轨同一 lemma→code 规则，用户裁决③），
      // 不再对本地 file_tags 表做 name→code 名称反查，避免切换界面语言后失配。
      // 收尾评审修正：SYSTEM_TAG_NAMES 恒为中文规范词形，必须显式锚定 'zh-CN' 分表检索，
      // 否则非中文界面语言下 findTagCodeByLemma 默认查当前语言分表（英文 lemma）必然落空。
      const basicAttrCode =
        databaseService.findTagCodeByLemma(SYSTEM_TAG_NAMES.basicAttr, 'zh-CN') ??
        databaseService.findTagCodeByLemma(SYSTEM_TAG_NAMES.emptyFile, 'zh-CN') ??
        null

      if (basicAttrCode === null) {
        // Fix-08：无可循父码时跳过本次系统标签挂载，绝不写 parent_codes=[null] 脏数据；
        // Fix-07：兜底分支不再静默，warn 说明后果（该空文件暂无系统标签，仅保留 [空文件] 智能名）
        logger.warn(
          LogCategory.FILE_ANALYSIS,
          `[空文件处理] 语义包未检索到系统兜底父码（${SYSTEM_TAG_NAMES.basicAttr}/${SYSTEM_TAG_NAMES.emptyFile}），跳过标签挂载: ${filePath}`
        )
        return
      }
      insertTagToDb(db, emptyHash, emptyTagLabel, basicAttrCode, 2)
    })()
    databaseService.syncFTSTags(emptyHash)
  } catch (e) {
    logger.warn(LogCategory.FILE_ANALYSIS, '[空文件处理] 添加默认标签失败:', e)
  }
}
