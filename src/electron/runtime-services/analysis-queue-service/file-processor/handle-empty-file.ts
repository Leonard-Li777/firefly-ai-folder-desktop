import { AnalysisQueueItem } from '@firefly/types'
import { databaseService } from '../../database/database-service'
import { LogCategory, logger, insertTagToDb } from '@firefly/shared'
import { t } from '@app/languages'
import { DeterministicCodeGenerator } from '@firefly/core-engine'
import { getTagCodeByName, SYSTEM_TAG_NAMES } from '../../../adapters/tag-tree-view-adapter'
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
      // ADR-0035 修订：dim.* 编码已废除，系统兜底父码经 TagTreeViewAdapter 常量表
      // 以「标签名」锚定（按名查 code，最浅者优先生效）。
      const basicAttrCode =
        getTagCodeByName(db, SYSTEM_TAG_NAMES.basicAttr) ??
        getTagCodeByName(db, SYSTEM_TAG_NAMES.emptyFile) ??
        // 双查皆未命中时的最终兜底：不再使用已废除的 dim.basic_attr 字面量
        null

      try {
        // 父码查无可循时不打系统父码（跳过主路径），走下方确定性编码兜底
        if (basicAttrCode !== null) {
          insertTagToDb(db, emptyHash, emptyTagLabel, basicAttrCode, 2)
        } else {
          throw new Error('系统兜底父码未命中（基础属性/空文件标签缺失）')
        }
      } catch {
        try {
          // 兜底：以离线确定性编码派生合法 code，并与文件建立自然主键关联
          const tagCode = DeterministicCodeGenerator.generateUnique(emptyTagLabel, 'zh-CN', {
            lookupExistingName: DeterministicCodeGenerator.createDbLookup(db)
          })
          db.prepare(
            `INSERT OR IGNORE INTO file_tags (code, name, parent_codes, materialized_paths, depth, file_groups, source, meta)
             VALUES (?, ?, ?, '[]', 2, '[]', 'expanded', ?)`
          ).run(
            tagCode,
            emptyTagLabel,
            JSON.stringify([basicAttrCode]),
            JSON.stringify({ isLeaf: true, isSystem: false, isMultiSelect: true, syncStatus: 2 })
          )
          db.prepare(
            `INSERT OR IGNORE INTO file_tag_relations (file_fingerprint, tag_code, parent_tag_code, confidence, source, meta)
             VALUES (?, ?, ?, 1.0, 'rule', ?)`
          ).run(emptyHash, tagCode, basicAttrCode, JSON.stringify({ syncStatus: 2 }))
        } catch (fallbackError) {
          logger.warn(
            LogCategory.FILE_ANALYSIS,
            '[空文件处理] 兜底写入默认标签失败:',
            fallbackError
          )
        }
      }
    })()
    databaseService.syncFTSTags(emptyHash)
  } catch (e) {
    logger.warn(LogCategory.FILE_ANALYSIS, '[空文件处理] 添加默认标签失败:', e)
  }
}
