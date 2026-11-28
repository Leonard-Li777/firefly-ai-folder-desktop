import { DuplicateDetectionOptions } from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import { databaseService } from '../../database'
import { decompressJson, decompressText } from '../../../utils/text-compressor'

/**
 * 从数据库查询待查重文件的元数据与已提取文本
 */
export async function getTargetFilesFromDb(options: DuplicateDetectionOptions): Promise<any[]> {
  await databaseService.ensureInitialized()
  const db = databaseService.db
  if (!db) return []

  try {
    let query = `
        SELECT wf.id, wf.path, wf.name, f.size as size, wf.file_fingerprint as fingerprint,
               wf.modified_at as modifiedAt, fc.content as contentText, fc.exif,
               fc.quality_score as qualityScore, wf.thumbnail_path as thumbnailPath
        FROM workspace_files wf
        LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
        LEFT JOIN file_contents fc ON wf.file_fingerprint = fc.file_fingerprint
      `
    let rows: any[] = []

    if (options.fileIds && options.fileIds.length > 0) {
      const placeholders = options.fileIds.map(() => '?').join(',')
      query += ` WHERE wf.id IN (${placeholders})`
      rows = db.prepare(query).all(...options.fileIds)
    } else if (options.workspaceDirectoryPath) {
      query += ` WHERE wf.path LIKE ?`
      rows = db.prepare(query).all(`${options.workspaceDirectoryPath}%`)
    } else {
      rows = db.prepare(query).all()
    }

    return rows.map(r => {
      const meta = decompressJson<any>(r.exif) || {}
      return {
        ...r,
        contentText: decompressText(r.contentText),
        resolution: meta.resolution || meta.dimensions,
        duration: meta.duration
      }
    })
  } catch (err) {
    logger.error(LogCategory.DATABASE_SERVICE, '查询查重目标文件数据库元数据失败:', err)
    return []
  }
}
