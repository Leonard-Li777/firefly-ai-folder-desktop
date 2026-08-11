import { AnalysisQueueItem } from '@firefly/types'
import {
  LogCategory,
  logger,
  FileCategory,
  isCategory,
  sanitizeFilename,
  cleanSmartName
} from '@firefly/shared'
import { t } from '@app/languages'
import { databaseService } from '../../database/database-service'
import { magikaService } from '../../system/magika-service'
import { thumbnailService } from '../../filesystem/thumbnail-service'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 保存云端分析结果到数据库
 */
export async function saveCloudResult(
  item: AnalysisQueueItem,
  fileFingerprint: string,
  data: any,
  isCloudCache: boolean,
  workspaceId: number,
  getModelName: (modelId: string, mode: string) => string
): Promise<void> {
  const db = databaseService.db
  if (!db) throw new Error(t('数据库未初始化'))

  try {
    const filePath = (item as any).file_path || item.path
    let fileType = item.type || path.extname(filePath).toLowerCase() || ''
    const stats = fs.statSync(filePath)

    // 使用 Magika 检测文件类型
    const magikaCategory = await magikaService.identifyFile(filePath)
    if (magikaCategory && typeof magikaCategory !== 'string') {
      const magikaExt = magikaCategory.extensions?.[0] || magikaCategory.label
      if (magikaExt && magikaExt.trim() !== '' && magikaExt !== 'empty') {
        fileType = magikaExt.startsWith('.') ? magikaExt : `.${magikaExt}`
      }
    }

    let thumbnailRelativePath = null
    if (
      fileType &&
      ['jpg', 'jpeg', 'png', 'webp', 'mp4', 'mov', 'avi', 'mkv', 'webm', 'pdf', 'pdfx'].includes(
        fileType.toLowerCase()
      )
    ) {
      try {
        const rootDir = await databaseService.findRootWorkspaceDirectory(filePath)
        if (rootDir && rootDir.path) {
          const thumbnailResult = await thumbnailService.generateThumbnail({
            fileId: fileFingerprint,
            filePath: filePath,
            smartName: item.name,
            workspaceDirectoryPath: rootDir.path
          })
          if (thumbnailResult && thumbnailResult.success)
            thumbnailRelativePath = thumbnailResult.relativePath

          // 检查是否是非浏览器原生支持的特殊图片格式，若是则提前转码原尺寸 WebP
          if (isCategory(filePath, FileCategory.IMAGE)) {
            const ext = path.extname(filePath).toLowerCase()
            const nativeImageExtensions = [
              '.jpg',
              '.jpeg',
              '.png',
              '.gif',
              '.webp',
              '.svg',
              '.ico',
              '.bmp',
              '.avif'
            ]
            if (!nativeImageExtensions.includes(ext)) {
              await thumbnailService.getOrGenerateOriginalTranscodedImage(
                filePath,
                fileFingerprint,
                item.name || path.basename(filePath),
                rootDir.path
              )
            }
          }
        }
      } catch (e) {
        logger.debug(
          LogCategory.ANALYSIS_QUEUE,
          '[分析队列] 保存云端结果时生成缩略图或预转码大图失败',
          e
        )
      }
    }

    const isHit = isCloudCache ? 1 : 0
    const lastHitAt = isHit ? new Date().toISOString() : null

    // 智能文件名落盘前进行重名检测：同工作区内重名时自动追加编号后缀，并清洗无意义前缀
    const rawSmartName = cleanSmartName(data.smart_name || data.smartName || item.name, item.name)
    const smartName = await databaseService.resolveUniqueSmartName(
      rawSmartName,
      fileFingerprint,
      workspaceId
    )
    const description = data.description || data.summary || null
    const content = data.content || data.textContent || null
    const multimodalContent = data.multimodal_content || data.multimodalContent || null
    const qualityScore = data.quality_score || data.qualityScore || null
    let analysisStats = data.analysis_stats || data.analysisStats || null

    if (analysisStats) {
      try {
        const statsObj =
          typeof analysisStats === 'string' ? JSON.parse(analysisStats) : analysisStats
        if (
          statsObj &&
          statsObj.model?.id &&
          (!statsObj.model.name || statsObj.model.name === statsObj.model.id)
        ) {
          const mode = statsObj.model.provider || 'local'
          statsObj.model.name = getModelName(statsObj.model.id, mode)
          analysisStats = statsObj
        }
      } catch (e) {
        logger.warn(LogCategory.FILE_ANALYSIS, '[云端结果] 解析云端分析统计 JSON 失败:', e)
      }
    }

    const fileData = {
      contentHash: fileFingerprint,
      smartName: smartName,
      size: stats.size,
      description: description,
      content: content,
      multimodalContent: multimodalContent,
      lrc: data.lrc || null,
      qualityScore: qualityScore,
      qualityConfidence: data.quality_confidence || data.qualityConfidence || null,
      qualityReasoning: data.quality_reasoning || data.qualityReasoning || null,
      qualityCriteria:
        typeof (data.quality_criteria || data.qualityCriteria) === 'string'
          ? data.quality_criteria || data.qualityCriteria
          : JSON.stringify(data.quality_criteria || data.qualityCriteria || {}),
      groupingReason: data.grouping_reason || data.groupingReason || null,
      groupingConfidence: data.grouping_confidence || data.groupingConfidence || null,
      author: data.author || null,
      language: data.language || null,
      analysisStats:
        typeof analysisStats === 'string' ? analysisStats : JSON.stringify(analysisStats || null),
      metadata:
        typeof data.metadata === 'string' ? data.metadata : JSON.stringify(data.metadata || {}),
      thumbnailPath: thumbnailRelativePath || null,
      isHit: isHit === 1,
      syncStatus: 2
    }

    const dirPath = path.dirname(filePath)
    const directoryId = await databaseService.addDirectory(dirPath, workspaceId)

    const runTransaction = db.transaction(() => {
      db.prepare(
        `
        INSERT INTO files (
          file_fingerprint, smart_name, description, size, type, category,
          author, language, is_hit, last_hit_at, sync_status,
          created_at, modified_at, accessed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_fingerprint) DO UPDATE SET
          smart_name = excluded.smart_name,
          description = excluded.description,
          category = excluded.category,
          author = excluded.author,
          language = excluded.language,
          is_hit = excluded.is_hit,
          last_hit_at = excluded.last_hit_at,
          sync_status = excluded.sync_status,
          modified_at = excluded.modified_at
      `
      ).run(
        fileFingerprint,
        smartName,
        description,
        stats.size,
        fileType,
        data.category ? JSON.stringify(data.category) : null,
        data.author || null,
        data.language || null,
        isHit,
        lastHitAt,
        fileData.syncStatus,
        new Date(stats.birthtime).toISOString(),
        new Date(stats.mtime).toISOString(),
        new Date(stats.atime).toISOString()
      )

      db.prepare(
        `
        INSERT INTO file_contents (
          file_fingerprint, content, multimodal_content, lrc, metadata, analysis_stats,
          quality_score, quality_confidence, quality_reasoning, quality_criteria,
          grouping_reason, grouping_confidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_fingerprint) DO UPDATE SET
          content = excluded.content,
          multimodal_content = excluded.multimodal_content,
          metadata = excluded.metadata,
          quality_score = excluded.quality_score,
          quality_confidence = excluded.quality_confidence,
          quality_reasoning = excluded.quality_reasoning,
          quality_criteria = excluded.quality_criteria,
          grouping_reason = excluded.grouping_reason,
          grouping_confidence = excluded.grouping_confidence
      `
      ).run(
        fileFingerprint,
        content,
        multimodalContent,
        data.lrc || null,
        fileData.metadata,
        fileData.analysisStats,
        qualityScore,
        fileData.qualityConfidence,
        fileData.qualityReasoning,
        fileData.qualityCriteria,
        fileData.groupingReason,
        fileData.groupingConfidence
      )

      db.prepare(
        `
        INSERT INTO workspace_files (
          file_fingerprint, workspace_id, directory_id,
          path, name, is_analyzed, last_analyzed_at,
          created_at, modified_at, accessed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(workspace_id, path) DO UPDATE SET
          file_fingerprint = excluded.file_fingerprint,
          is_analyzed = 1,
          last_analyzed_at = ?
      `
      ).run(
        fileFingerprint,
        workspaceId,
        directoryId,
        filePath,
        path.basename(filePath),
        1,
        new Date().toISOString(),
        new Date(stats.birthtime).toISOString(),
        new Date(stats.mtime).toISOString(),
        new Date(stats.atime).toISOString(),
        new Date().toISOString()
      )

      if (data.tags && Array.isArray(data.tags)) {
        for (const tag of data.tags) {
          if (tag.name) {
            try {
              const cloudDimId = tag.dimension_id
              let localDimId = 0
              const dimRow = db
                .prepare('SELECT id FROM file_dimensions WHERE id = ?')
                .get(cloudDimId) as { id: number } | undefined
              if (dimRow) {
                localDimId = dimRow.id
              } else {
                // 云端维度本地不存在时，一律使用 dimension_id = 28（内容标签）
                localDimId = 28
              }
              let tagRow = db
                .prepare('SELECT id FROM file_tags WHERE name = ? AND dimension_id = ?')
                .get(tag.name, localDimId) as { id: number } | undefined
              if (!tagRow) {
                db.prepare(
                  `INSERT INTO file_tags (name, dimension_id, sync_status, created_at) VALUES (?, ?, 0, ?)`
                ).run(tag.name, localDimId, new Date().toISOString())
                tagRow = db
                  .prepare('SELECT id FROM file_tags WHERE name = ? AND dimension_id = ?')
                  .get(tag.name, localDimId) as { id: number } | undefined
              }
              if (tagRow) {
                db.prepare(
                  `INSERT OR IGNORE INTO file_tag_relations (file_fingerprint, tag_id, sync_status) VALUES (?, ?, 0)`
                ).run(fileFingerprint, tagRow.id)
              }
            } catch (tagError) {
              logger.warn(LogCategory.FILE_ANALYSIS, '[云端结果] 写入文件标签关系失败:', tagError)
            }
          }
        }
      }
    })

    runTransaction()
    databaseService.syncFTSTags(fileFingerprint)
  } catch (error) {
    logger.error(LogCategory.ANALYSIS_QUEUE, '[AI分析] 保存云端结果失败:', error)
    throw error
  }
}
