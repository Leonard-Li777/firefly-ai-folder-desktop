import path from 'node:path'
import { LogCategory, logger } from '@firefly/shared'
import type { EnqueueInput } from './types'
import {
  resolveAnalysisMode,
  isAnalyzedForMode,
  getRequiredStage,
  normalizeAnalysisMode,
  type AnalysisMode
} from '@app/electron/config/analysis-mode'
import { databaseService } from '../database/database-service'
import { isRenameProtectedExtension } from '../../utils/extension-rename-whitelist'

export interface ExtensionMismatchItem {
  fileFingerprint: string
  path: string
  name: string
  smartName: string
  extension: string
  extensions: string[]
  workspaceRootPath: string
}

/**
 * 检查扩展名不匹配的文件：查询工作区中 `file_group.extensions` 不包含 `files.extension` 的文件列表。
 */
export async function checkExtensionMismatchFiles(
  workspaceId: number
): Promise<ExtensionMismatchItem[]> {
  const db = databaseService.db
  if (!db) return []

  try {
    const workspaceDir = db
      .prepare('SELECT path FROM workspace_directories WHERE id = ?')
      .get(workspaceId) as { path: string } | undefined
    const workspaceRootPath = workspaceDir?.path || ''

    // 查询有分组 (file_group) 的文件及其物理路径信息（V4: category→file_group, type→extension）
    const rows = db
      .prepare(
        `
        SELECT f.file_fingerprint, wf.path, wf.name, f.extension, f.file_group, f.smart_name
        FROM files f
        JOIN workspace_files wf ON f.file_fingerprint = wf.file_fingerprint
        WHERE f.file_group IS NOT NULL AND wf.workspace_id = ?
        ORDER BY wf.path ASC
      `
      )
      .all(workspaceId) as Array<{
      file_fingerprint: string
      path: string
      name: string
      extension: string
      file_group: string
      smart_name: string | null
    }>

    const results: ExtensionMismatchItem[] = []

    for (const row of rows) {
      try {
        const fileGroup = JSON.parse(row.file_group)
        // 低置信度 Magika 结果（score < 0.8）不进入扩展名校准弹窗，避免 BOM 中文 txt 等误判
        const score = fileGroup && typeof fileGroup === 'object' ? (fileGroup.score ?? 1) : 1
        if (score < 0.8) continue

        const extensions = fileGroup?.extensions || []
        if (extensions.length === 0) continue

        // 白名单门禁（ADR-0008）：macOS 文档专有格式物理上是 zip，禁止进入更名列表
        if (isRenameProtectedExtension(row.extension)) continue

        const currentType = row.extension.toLowerCase().replace(/^\./, '')
        const normalizedExtensions = extensions.map((e: string) =>
          e.toLowerCase().replace(/^\./, '')
        )

        if (!normalizedExtensions.includes(currentType)) {
          results.push({
            fileFingerprint: row.file_fingerprint,
            path: row.path,
            name: row.name,
            smartName: row.smart_name || row.name,
            extension: row.extension,
            extensions,
            workspaceRootPath
          })
        }
      } catch (parseError) {
        logger.warn(
          LogCategory.ANALYSIS_QUEUE,
          `[扩展名校准] 解析 file_group JSON 失败: ${row.file_fingerprint}`,
          parseError
        )
      }
    }

    return results
  } catch (error) {
    logger.error(LogCategory.ANALYSIS_QUEUE, '[扩展名校准] 查询扩展名不匹配文件失败:', error)
    return []
  }
}

/**
 * 批量修正扩展名。
 * @param fixes 包含文件指纹和选择的扩展名（null 表示不更名，仅追加扩展名白名单）
 */
export async function batchFixFileExtensions(
  fixes: Array<{ fileFingerprint: string; chosenExtension: string | null }>
): Promise<{ success: boolean; count: number }> {
  const db = databaseService.db
  if (!db) return { success: false, count: 0 }

  let count = 0
  try {
    db.transaction(() => {
      for (const fix of fixes) {
        const { fileFingerprint, chosenExtension } = fix

        if (chosenExtension === null) {
          const row = db
            .prepare('SELECT extension, file_group FROM files WHERE file_fingerprint = ?')
            .get(fileFingerprint) as { extension: string; file_group: string } | undefined

          if (row?.file_group) {
            try {
              const groupObj = JSON.parse(row.file_group)
              const extensions = groupObj.extensions || []
              const currentExt = (row.extension || '').toLowerCase().replace(/^\./, '')

              if (
                !extensions.some((e: string) => e.toLowerCase().replace(/^\./, '') === currentExt)
              ) {
                const hasDot = extensions.length > 0 && extensions[0].startsWith('.')
                extensions.push(hasDot ? `.${currentExt}` : currentExt)
                groupObj.extensions = extensions

                db.prepare('UPDATE files SET file_group = ? WHERE file_fingerprint = ?').run(
                  JSON.stringify(groupObj),
                  fileFingerprint
                )
                count++
              }
            } catch (e) {
              logger.warn(
                LogCategory.ANALYSIS_QUEUE,
                `[扩展名校准] 解析 file_group 失败: ${fix.fileFingerprint}`,
                e
              )
            }
          }
        } else {
          const row = db
            .prepare('SELECT smart_name, extension FROM files WHERE file_fingerprint = ?')
            .get(fileFingerprint) as { smart_name: string; extension: string } | undefined

          // 纵深防护：白名单扩展名即使经前端传入也拒绝改名
          if (row && isRenameProtectedExtension(row.extension)) {
            logger.warn(
              LogCategory.ANALYSIS_QUEUE,
              `[扩展名校准] 拒绝改名：${fileFingerprint} 的扩展名 ${row.extension} 受 macOS 文档格式白名单保护`
            )
            continue
          }

          if (row) {
            const oldSmartName = row.smart_name || ''
            const newExt = chosenExtension.startsWith('.') ? chosenExtension : `.${chosenExtension}`
            const currentExt = path.extname(oldSmartName)
            const newSmartName = currentExt
              ? oldSmartName.slice(0, -currentExt.length) + newExt
              : oldSmartName + newExt

            db.prepare(
              'UPDATE files SET extension = ?, smart_name = ? WHERE file_fingerprint = ?'
            ).run(newExt, newSmartName, fileFingerprint)
            count++
          }
        }
      }
    })()
    return { success: true, count }
  } catch (error) {
    logger.error(LogCategory.ANALYSIS_QUEUE, '[扩展名校准] 批量修正扩展名失败:', error)
    return { success: false, count }
  }
}

/**
 * 检查指定文件的分析状态，按相对当前模式的完成程度返回 `analyzed` | `insufficient` 列表。
 */
export async function checkAlreadyAnalyzedFilesByPaths(filePaths: string[]): Promise<any[]> {
  const db = databaseService.db
  if (!db || !filePaths || filePaths.length === 0) return []

  const analysisMode = resolveAnalysisMode()
  const result: any[] = []
  const chunkSize = 500

  try {
    for (let i = 0; i < filePaths.length; i += chunkSize) {
      const chunk = filePaths.slice(i, i + chunkSize)
      const placeholders = chunk.map(() => '?').join(',')
      const sql = `
        SELECT 
          wf.path, wf.name, wf.is_analyzed,
          fc.quality_score, f.description, f.smart_name, f.author, f.language,
          fc.analysis_stats,
          (
            SELECT GROUP_CONCAT(COALESCE(ft.name, ftr.tag_code), ',')
            FROM file_tag_relations ftr
            LEFT JOIN file_tags_private ft ON ft.code = ftr.tag_code
            WHERE ftr.file_fingerprint = wf.file_fingerprint
          ) as tags_str
        FROM workspace_files wf
        LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
        LEFT JOIN file_contents fc ON wf.file_fingerprint = fc.file_fingerprint
        WHERE wf.path IN (${placeholders})
      `
      const rows = db.prepare(sql).all(...chunk) as Array<{
        path: string
        name: string
        is_analyzed: number
        quality_score: number | null
        description: string | null
        smart_name: string | null
        author: string | null
        language: string | null
        analysis_stats: string | null
        tags_str: string | null
      }>

      const allTagCodesToResolve: string[] = []
      for (const row of rows) {
        if (row.tags_str) {
          for (const item of row.tags_str.split(',')) {
            if (item.includes('.')) {
              allTagCodesToResolve.push(item)
            }
          }
        }
      }
      const resolvedNames =
        allTagCodesToResolve.length > 0
          ? databaseService.resolveTagDisplayNames(allTagCodesToResolve)
          : {}

      for (const row of rows) {
        let stageValue = 0
        let completedMode: AnalysisMode | undefined
        try {
          const stats = row.analysis_stats ? JSON.parse(row.analysis_stats) : null
          stageValue = Number(stats?.analysis_stage ?? 0) || 0
          completedMode = normalizeAnalysisMode(stats?.completed_mode)
        } catch (e) {
          logger.warn(
            LogCategory.ANALYSIS_QUEUE,
            `[分析队列] 解析 analysis_stats 失败 (${row.path}):`,
            e
          )
          stageValue = 0
          completedMode = undefined
        }

        // 口径：stage 达标且 completed_mode 不低于当前模式，防 quick_name 与 full 同为 stage 4 时误跳过评分
        const analyzed =
          row.is_analyzed === 1 &&
          isAnalyzedForMode({ stage: stageValue, completedMode, mode: analysisMode })

        const insufficient = !analyzed && (row.is_analyzed === 1 || stageValue > 0)
        if (!analyzed && !insufficient) continue

        result.push({
          path: row.path,
          name: row.name,
          smartName: row.smart_name || undefined,
          qualityScore: row.quality_score ?? undefined,
          description: row.description || undefined,
          author: row.author || undefined,
          language: row.language || undefined,
          tags: row.tags_str
            ? row.tags_str
                .split(',')
                .map(
                  item =>
                    resolvedNames[item] || (item.includes('.') ? item.split('.').pop()! : item)
                )
            : undefined,
          isAnalyzed: analyzed,
          status: analyzed ? 'analyzed' : 'insufficient',
          analysisStage: stageValue,
          completedMode
        })
      }
    }
  } catch (error) {
    logger.error(LogCategory.ANALYSIS_QUEUE, '[分析队列] 检查已分析文件失败:', error)
  }

  logger.debug(
    LogCategory.ANALYSIS_QUEUE,
    `[分析队列] 检查已分析文件 (模式: ${analysisMode}, 目标Stage: ${getRequiredStage(analysisMode)}): 传入 ${filePaths.length} 个, 已完成 ${result.filter(r => r.status === 'analyzed').length} 个, 分析不完整 ${result.filter(r => r.status === 'insufficient').length} 个`
  )

  return result
}

/**
 * 队列分析完成后，刷新存在虚拟目录的工作区视图。
 */
export async function updateVirtualDirectoriesAfterQueueCompletion(): Promise<void> {
  try {
    const db = databaseService.db
    if (!db) return
    const directoriesWithVirtualDirs = db
      .prepare(
        `SELECT DISTINCT md.path FROM workspaces md INNER JOIN virtual_directories vd ON vd.workspace_id = md.workspace_id`
      )
      .all() as Array<{ path: string }>
    if (!directoriesWithVirtualDirs || directoriesWithVirtualDirs.length === 0) return
    const { VirtualDirectoryService } =
      await import('../filesystem/virtual-directory-service/index')
    for (const directory of directoriesWithVirtualDirs) {
      try {
        await new VirtualDirectoryService(db).updateAllVirtualDirectories(directory.path)
      } catch (error) {
        logger.warn(
          LogCategory.MAIN,
          '[AnalysisQueue] 更新单个虚拟目录失败:',
          directory.path,
          error
        )
      }
    }
  } catch (error) {
    logger.error(LogCategory.MAIN, '[AnalysisQueue] 队列完成后更新虚拟目录失败:', error)
  }
}

/**
 * 复位崩溃残留切片、解锁因免费限制锁定的切片，并收集待断点续作的视频入队项。
 */
export function collectIncompleteVideoEnqueueInputs(): EnqueueInput[] {
  databaseService.resetDanglingVideoSegmentsOnStartup()

  const unlockedCount = databaseService.unlockVideoSegments()
  if (unlockedCount > 0) {
    logger.info(
      LogCategory.ANALYSIS_QUEUE,
      `[分析队列] 会员升级 Pro，成功解锁 ${unlockedCount} 个待续作视频切片`
    )
  }

  const incompleteVideos = databaseService.getIncompleteVideoFiles()
  if (!incompleteVideos || incompleteVideos.length === 0) {
    return []
  }

  // 按 fileFingerprint 去重，防多工作区重复入队
  const uniqueMap = new Map<string, (typeof incompleteVideos)[0]>()
  for (const v of incompleteVideos) {
    if (!uniqueMap.has(v.fileFingerprint)) {
      uniqueMap.set(v.fileFingerprint, v)
    }
  }
  const deduplicated = Array.from(uniqueMap.values())

  logger.info(
    LogCategory.ANALYSIS_QUEUE,
    `[分析队列] 发现 ${deduplicated.length} 个未完成长视频，执行升级后自动断点续作入队`
  )
  return deduplicated.map(v => ({
    path: v.path,
    name: v.name || path.basename(v.path),
    size: v.size || 0,
    type: v.extension || path.extname(v.path).toLowerCase() || 'video',
    workspaceId: Number(v.workspaceId) || undefined
  }))
}
