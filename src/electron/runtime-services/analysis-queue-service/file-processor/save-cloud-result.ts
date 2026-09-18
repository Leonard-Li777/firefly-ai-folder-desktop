import { AnalysisQueueItem } from '@firefly/types'
import type { DimensionMetadata } from '@firefly/types'
import {
  LogCategory,
  logger,
  FileCategory,
  isCategory,
  sanitizeFilename,
  cleanSmartName,
  sanitizeAITagValue,
  isValidAITag,
  isPanDimension,
  insertTagToDb
} from '@firefly/shared'
import { t } from '@app/languages'
import { DeterministicCodeGenerator } from '@firefly/core-engine'
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
    const filePath = item.path
    const rawType = item.type || path.extname(filePath).toLowerCase() || ''
    let fileType = rawType ? (rawType.startsWith('.') ? rawType : `.${rawType}`) : ''
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

    // 智能文件名落盘前进行重名检测：同工作区内重名时自动追加编号后缀，并清洗无意义前缀（rawSmartName 不需要带扩展名）
    const itemExt = path.extname(item.name || '').replace(/^\./, '')
    let rawSmartName = cleanSmartName(data.smart_name || data.smartName || item.name, item.name)
    if (itemExt) {
      rawSmartName = rawSmartName.replace(new RegExp(`\\.${itemExt}$`, 'i'), '')
    }
    rawSmartName = rawSmartName.replace(/\.[a-zA-Z0-9]{1,10}$/i, '').trim()
    if (!rawSmartName) {
      rawSmartName = path.basename(item.name || '', path.extname(item.name || ''))
    }
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
          file_fingerprint, smart_name, description, size, extension, file_group,
          author, language, is_hit, last_hit_at, sync_status,
          created_at, modified_at, accessed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_fingerprint) DO UPDATE SET
          smart_name = excluded.smart_name,
          description = excluded.description,
          extension = excluded.extension,
          file_group = excluded.file_group,
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
        data.file_group || null,
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
          file_fingerprint, content, multimodal_content, ocr, lrc, metadata, analysis_stats,
          quality_score, quality_confidence, quality_reasoning, quality_criteria,
          grouping_reason, grouping_confidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(file_fingerprint) DO UPDATE SET
          content = excluded.content,
          multimodal_content = excluded.multimodal_content,
          ocr = excluded.ocr,
          lrc = excluded.lrc,
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
        data.ocr || null,
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
        // 创世 Baseline V1：维度与预设标签统一由 file_tags 标签树推导，不再查询 file_dimensions。
        // 维度根节点（parent_codes 为空）为维度容器，其直属子节点即该维度的预设标签集。
        const allDimRows = db
          .prepare(
            `
            SELECT
              root.code AS id,
              root.name AS name,
              (
                SELECT json_group_array(child.name)
                FROM file_tags child
                WHERE json_extract(child.parent_codes, '$[0]') = root.code
              ) AS tags,
              root.meta AS metadata
            FROM file_tags root
            WHERE root.parent_codes IS NULL OR root.parent_codes = '[]'
          `
          )
          .all() as Array<{
          id: string
          name: string
          tags: string
          metadata?: DimensionMetadata | string | null
        }>
        const officialDimNames = new Set(allDimRows.map(d => d.name))
        const dimMap = new Map<
          string,
          { name: string; tags: Set<string>; metadata?: DimensionMetadata | string | null }
        >()
        for (const row of allDimRows) {
          let tagList: string[] = []
          try {
            tagList = JSON.parse(row.tags || '[]')
          } catch {
            tagList = []
          }
          dimMap.set(String(row.id), {
            name: row.name,
            tags: new Set(tagList.map(t => (typeof t === 'string' ? t.toLowerCase().trim() : ''))),
            metadata: row.metadata ?? undefined
          })
        }
        // 内容标签维度作为兜底路由目标
        const CONTENT_DIM_CODE = 'dim.28'

        for (const tag of data.tags) {
          if (typeof tag?.name !== 'string') continue
          // 清洗顺序不能错：必须先清洗（去引号 "“”" 等非法字符），再校验维度名——
          // "“应用数据细分”" 清洗后为 "应用数据细分"，实为已有维度名，应被过滤而非入库
          const cleanName = sanitizeAITagValue(tag.name).trim()
          if (!cleanName || !isValidAITag(cleanName, officialDimNames)) continue
          try {
            // 云端回传的 dimension_id 既可能是自然主键 code，也可能为数字 ID
            const rawDim = tag.dimension_id
            const cloudDimCode =
              rawDim === undefined || rawDim === null || rawDim === ''
                ? CONTENT_DIM_CODE
                : /^\d+$/.test(String(rawDim))
                  ? `dim.${rawDim}`
                  : String(rawDim)

            let localDimCode = CONTENT_DIM_CODE
            const dimInfo = dimMap.get(cloudDimCode)
            const lowerCleanName = cleanName.toLowerCase()
            const isDimPan = (info?: { name: string; metadata?: DimensionMetadata | string | null }) =>
              info
                ? isPanDimension({ id: 0, metadata: info.metadata }) ||
                  info.name === t('作者') ||
                  info.name === t('内容标签')
                : false

            if (dimInfo) {
              if (isDimPan(dimInfo)) {
                localDimCode = cloudDimCode
              } else if (dimInfo.tags.has(lowerCleanName)) {
                localDimCode = cloudDimCode
              } else {
                // 检查是否命中其他非泛维度的预设标签
                let foundOtherDimCode: string | null = null
                for (const [otherCode, otherInfo] of dimMap) {
                  if (isDimPan(otherInfo)) continue
                  if (otherInfo.tags.has(lowerCleanName)) {
                    foundOtherDimCode = otherCode
                    break
                  }
                }
                // 未命中任何非泛维度预设标签，一律路由至内容标签维度
                localDimCode = foundOtherDimCode ?? CONTENT_DIM_CODE
              }
            }

            try {
              insertTagToDb(db, fileFingerprint, cleanName, localDimCode)
            } catch {
              // 兜底：按离线确定性编码派生合法 code 并建立自然主键关联
              const tagCode = DeterministicCodeGenerator.generateUnique(cleanName, 'zh-CN', {
                lookupExistingName: DeterministicCodeGenerator.createDbLookup(db)
              })
              db.prepare(
                `INSERT OR IGNORE INTO file_tags (code, name, parent_codes, materialized_paths, depth, file_groups, source, meta)
                 VALUES (?, ?, ?, '[]', 2, '[]', 'expanded', ?)`
              ).run(
                tagCode,
                cleanName,
                JSON.stringify([localDimCode]),
                JSON.stringify({ isLeaf: true, isSystem: false, isMultiSelect: true, syncStatus: 0 })
              )
              db.prepare(
                `INSERT OR IGNORE INTO file_tag_relations (file_fingerprint, tag_code, parent_tag_code, confidence, source, meta)
                 VALUES (?, ?, ?, 1.0, 'rule', ?)`
              ).run(fileFingerprint, tagCode, localDimCode, JSON.stringify({ syncStatus: 0 }))
            }
          } catch (tagError) {
            logger.warn(LogCategory.FILE_ANALYSIS, '[云端结果] 写入文件标签关系失败:', tagError)
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
