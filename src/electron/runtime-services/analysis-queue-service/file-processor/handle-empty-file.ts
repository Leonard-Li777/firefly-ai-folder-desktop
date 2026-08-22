import { AnalysisQueueItem } from '@firefly/types'
import { databaseService } from '../../database/database-service'
import { LogCategory, logger } from '@firefly/shared'
import { t } from '@app/languages'
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
    `INSERT OR IGNORE INTO files (file_fingerprint, smart_name, size, type, category, created_at, modified_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
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
      let localDimId = 0
      const dimRow = db
        .prepare("SELECT id FROM file_dimensions WHERE name = '基础属性' OR id = 1")
        .get() as any
      if (dimRow) localDimId = dimRow.id
      if (localDimId) {
        db.prepare(
          `INSERT OR IGNORE INTO file_tags (name, dimension_id, sync_status, created_at) VALUES (?, ?, 2, ?)`
        ).run(emptyTagLabel, localDimId, new Date().toISOString())
        const tagRow = db
          .prepare('SELECT id FROM file_tags WHERE name = ? AND dimension_id = ?')
          .get(emptyTagLabel, localDimId) as any
        if (tagRow) {
          db.prepare(
            `INSERT OR IGNORE INTO file_tag_relations (file_fingerprint, tag_id, sync_status) VALUES (?, ?, 2)`
          ).run(emptyHash, tagRow.id)
        }
      }
    })()
    databaseService.syncFTSTags(emptyHash)
  } catch (e) {
    logger.warn(LogCategory.FILE_ANALYSIS, '[空文件处理] 添加默认标签失败:', e)
  }
}
