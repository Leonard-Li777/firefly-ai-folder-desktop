import { promises as fsp } from 'node:fs'
import * as path from 'path'
import { shell } from 'electron'
import { DuplicateFixAction, DuplicateFixResult } from '@firefly/types'
import { LogCategory, logger, normalizeFileExtension, isPathEqual } from '@firefly/shared'
import { getCachedStatement } from '@pro/perf/statement-cache'
import { DEFAULT_CONCURRENCY, existsAsync, mapLimit, mkdirp, statOrThrow } from '../../../infra/fs'
import { databaseService } from '../../database'
import { isRenameProtectedExtension } from '../../../utils/extension-rename-whitelist'
import { getTrashPort } from '../trash-port'
import {
  cleanExifForFile,
  detectExtensionFromMagicBytes,
  optimizeVideoForFile
} from './duplicate-magic-and-media'

const DELETE_WORKSPACE_FILE_SQL = 'DELETE FROM workspace_files WHERE path = ?'
const SELECT_FINGERPRINT_BY_PATH_SQL =
  'SELECT file_fingerprint FROM workspace_files WHERE path = ? OR path = ?'
const UPDATE_WORKSPACE_FILE_PATH_SQL =
  'UPDATE workspace_files SET path = ?, name = ?, modified_at = CURRENT_TIMESTAMP WHERE path = ? OR path = ?'
const UPDATE_FILE_EXTENSION_SQL =
  'UPDATE files SET extension = ?, modified_at = CURRENT_TIMESTAMP WHERE file_fingerprint = ?'
const SELECT_SMART_NAME_SQL = 'SELECT smart_name FROM files WHERE file_fingerprint = ?'
const UPDATE_FILE_EXT_AND_SMART_NAME_SQL =
  'UPDATE files SET extension = ?, smart_name = ?, modified_at = CURRENT_TIMESTAMP WHERE file_fingerprint = ?'

/**
 * 执行专属指标修复动作 (优化视频、清理Exif、更名异常文件名、修正扩展名)
 */
export async function executeStrategyFix(
  action: DuplicateFixAction,
  fileTargets: Array<string | { path: string; newName?: string }>,
  omniApiUrl: string,
  workspaceDirectoryPath?: string
): Promise<DuplicateFixResult> {
  logger.debug(LogCategory.FILE_ORGANIZATION, `开始执行专属修复动作: ${action}`, {
    count: fileTargets.length,
    workspaceDirectoryPath
  })
  const processedPaths: string[] = []
  const details: Array<{ oldPath: string; newPath?: string; message?: string }> = []
  const errors: Array<{ path: string; error: string }> = []
  let successCount = 0
  let failedCount = 0
  let targetOutputDirectory: string | undefined = undefined
  let hasOpenedFirstItem = false

  // 格式化当前日期为 YYYYMMDD
  const now = new Date()
  const yyyymmdd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`

  await databaseService.ensureInitialized()
  const db = databaseService.db

  // 关键优化：针对耗时较长的处理任务（如视频转码 optimize、Exif 清理 clean_exif），
  // 采用最短作业优先（SJF）策略，将体积较小、处理较快的文件排在最前优先处理，最慢的大文件排在最后；
  // 从而保证首个文件能够在极短时间内迅速完成并立即唤起文件管理器定位，消除等待焦虑。
  // P0-5：仅 optimize / clean_exif 并发预取一次 size；其他 action 不发起任何 stat，保持原顺序。
  let sortedFileTargets: Array<string | { path: string; newName?: string }>
  if (action === 'optimize' || action === 'clean_exif') {
    const sizes = await mapLimit(fileTargets, DEFAULT_CONCURRENCY, async item => {
      const targetPath = typeof item === 'string' ? item : item.path
      try {
        const st = await statOrThrow(targetPath)
        return st.size
      } catch (err) {
        logger.warn(
          LogCategory.FILE_ORGANIZATION,
          `[SJF排序] 预取文件体积失败 [${targetPath}]:`,
          err
        )
        return 0
      }
    })
    sortedFileTargets = fileTargets
      .map((item, idx) => ({ item, size: sizes[idx] }))
      .sort((a, b) => a.size - b.size)
      .map(entry => entry.item)
  } else {
    sortedFileTargets = [...fileTargets]
  }

  for (const item of sortedFileTargets) {
    const filePath = typeof item === 'string' ? item : item.path
    const suggestedNewName = typeof item === 'object' ? item.newName : undefined

    if (!(await existsAsync(filePath))) {
      failedCount++
      errors.push({ path: filePath, error: '文件不存在' })
      continue
    }

    try {
      if (action === 'trash') {
        await getTrashPort().trash(filePath)
        if (db) {
          getCachedStatement(db, DELETE_WORKSPACE_FILE_SQL).run(filePath)
        }
        processedPaths.push(filePath)
        successCount++
        details.push({ oldPath: filePath, message: '已安全移入回收站' })
      } else if (action === 'rename_bad_name') {
        // 1. 异常文件名更名：严格优先采用 Omni 计算并返回的推荐名 (suggestedNewName)
        const dir = path.dirname(filePath)
        let newPath = ''

        if (
          suggestedNewName &&
          suggestedNewName.trim() &&
          suggestedNewName.trim() !== path.basename(filePath)
        ) {
          newPath = path.join(dir, suggestedNewName.trim())
        } else {
          // 兜底方案：清洗去除首尾空格、emoji、特殊符号、重复下划线
          const ext = path.extname(filePath)
          const nameWithoutExt = path.basename(filePath, ext)
          let cleaned = nameWithoutExt
            .replace(
              /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu,
              ''
            )
            .replace(/[\s\-_]+/g, '_')
            .replace(/^[\s\-_.]+|[\s\-_.]+$/g, '')
            .trim()
          if (!cleaned) cleaned = 'renamed_file'
          newPath = path.join(dir, `${cleaned}${ext}`)
        }

        if (newPath && newPath !== filePath) {
          // 在 Windows NTFS 文件系统下，同名大小写变更必须通过临时中转名进行两步重命名
          if (process.platform === 'win32' && isPathEqual(newPath, filePath)) {
            const tempPath = path.join(
              dir,
              `__temp_rename_${Date.now()}_${path.basename(filePath)}`
            )
            await fsp.rename(filePath, tempPath)
            await fsp.rename(tempPath, newPath)
          } else {
            await fsp.rename(filePath, newPath)
          }

          if (db) {
            const newName = path.basename(newPath)
            const newExt = normalizeFileExtension(newPath)
            const pathSlash = filePath.replace(/\\/g, '/')
            const pathBackslash = filePath.replace(/\//g, '\\')

            // 1. 更新 workspace_files 中的物理路径与真实文件名 (同时兼容正反斜杠匹配)
            const wfRow = getCachedStatement<any>(db, SELECT_FINGERPRINT_BY_PATH_SQL).get(
              pathSlash,
              pathBackslash
            ) as any
            getCachedStatement<any>(db, UPDATE_WORKSPACE_FILE_PATH_SQL).run(
              newPath,
              newName,
              pathSlash,
              pathBackslash
            )
            // 2. 如果存在关联的文件指纹，同步更新 files 表的基础元数据
            if (wfRow?.file_fingerprint) {
              getCachedStatement<any>(db, UPDATE_FILE_EXTENSION_SQL).run(
                newExt,
                wfRow.file_fingerprint
              )
            }
          }
        }
        processedPaths.push(filePath)
        successCount++
        details.push({ oldPath: filePath, newPath, message: '已按推荐名更名' })
      } else if (action === 'fix_extension') {
        // 2. 错误扩展名修正 (通过文件头嗅探真实格式，并在数据库中同步更新真实文件名与智能文件名的扩展名)
        // 白名单门禁（ADR-0008）：macOS 文档软件专有格式（Keynote/Numbers/Pages 等）虽被
        // PK 魔数嗅探为 zip，但扩展名绝不可改名，命中白名单直接跳过
        if (isRenameProtectedExtension(path.extname(filePath))) {
          processedPaths.push(filePath)
          successCount++
          details.push({
            oldPath: filePath,
            message: '扩展名受 macOS 文档格式白名单保护，跳过改名'
          })
          continue
        }

        const dir = path.dirname(filePath)
        const nameWithoutExt = path.basename(filePath, path.extname(filePath))
        const properExt = await detectExtensionFromMagicBytes(filePath)

        if (properExt) {
          const newPath = path.join(dir, `${nameWithoutExt}${properExt}`)
          if (newPath !== filePath) {
            if (process.platform === 'win32' && isPathEqual(newPath, filePath)) {
              const tempPath = path.join(
                dir,
                `__temp_fixext_${Date.now()}_${path.basename(filePath)}`
              )
              await fsp.rename(filePath, tempPath)
              await fsp.rename(tempPath, newPath)
            } else {
              await fsp.rename(filePath, newPath)
            }
            if (db) {
              const newName = path.basename(newPath)
              const cleanExt = normalizeFileExtension(properExt)
              const pathSlash = filePath.replace(/\\/g, '/')
              const pathBackslash = filePath.replace(/\//g, '\\')

              // 1. 更新 workspace_files 表中的物理路径与真实文件名 (同时兼容正反斜杠匹配)
              const wfRow = getCachedStatement<any>(db, SELECT_FINGERPRINT_BY_PATH_SQL).get(
                pathSlash,
                pathBackslash
              ) as any
              getCachedStatement<any>(db, UPDATE_WORKSPACE_FILE_PATH_SQL).run(
                newPath,
                newName,
                pathSlash,
                pathBackslash
              )
              // 2. 同步更新 files 表中记录的文件类型与后缀，并顺带更新智能文件名 (smart_name) 的扩展名
              if (wfRow?.file_fingerprint) {
                const fileRow = getCachedStatement<any>(db, SELECT_SMART_NAME_SQL).get(
                  wfRow.file_fingerprint
                ) as any
                let updatedSmartName = fileRow?.smart_name
                if (updatedSmartName && typeof updatedSmartName === 'string') {
                  const oldSmartExt = path.extname(updatedSmartName)
                  if (oldSmartExt) {
                    const smartBase = path.basename(updatedSmartName, oldSmartExt)
                    updatedSmartName = `${smartBase}${properExt}`
                  } else {
                    updatedSmartName = `${updatedSmartName}${properExt}`
                  }
                }
                getCachedStatement<any>(db, UPDATE_FILE_EXT_AND_SMART_NAME_SQL).run(
                  cleanExt,
                  updatedSmartName || null,
                  wfRow.file_fingerprint
                )
              }
            }
          }
          processedPaths.push(filePath)
          successCount++
          details.push({ oldPath: filePath, newPath, message: `已修正扩展名为 ${properExt}` })
        } else {
          processedPaths.push(filePath)
          successCount++
          details.push({ oldPath: filePath, message: '扩展名格式正常' })
        }
      } else if (action === 'clean_exif') {
        // 3. Exif 隐私信息擦除 (保存为无损副本到 .VirtualDirectory\.cleaned_exif\{YYYYMMDD}，保持原文件名，绝不修改原文件)
        const baseWorkspace = workspaceDirectoryPath || path.dirname(filePath)
        const outDir = path.join(baseWorkspace, '.VirtualDirectory', '.cleaned_exif', yyyymmdd)
        targetOutputDirectory = outDir
        await mkdirp(outDir)

        const originalFileName = path.basename(filePath)
        const outFilePath = path.join(outDir, originalFileName)

        const cleanExifSucceeded = await cleanExifForFile(filePath, outFilePath, omniApiUrl)

        if (cleanExifSucceeded && (await existsAsync(outFilePath))) {
          processedPaths.push(filePath)
          successCount++
          details.push({
            oldPath: filePath,
            newPath: outFilePath,
            message: `已成功生成去 Exif 副本至: ${outFilePath}`
          })

          // 核心体验优化：首个文件生成后立即打开文件管理器并精准定位高亮该文件
          if (!hasOpenedFirstItem) {
            hasOpenedFirstItem = true
            try {
              shell.showItemInFolder(outFilePath)
              logger.debug(
                LogCategory.FILE_ORGANIZATION,
                `[Exif清理] 首个文件处理完成，已立即打开文件管理器并定位: ${outFilePath}`
              )
            } catch (showErr: any) {
              logger.warn(
                LogCategory.FILE_ORGANIZATION,
                `[Exif清理] 首个文件定位失败，尝试打开目录:`,
                showErr
              )
              if (targetOutputDirectory && (await existsAsync(targetOutputDirectory))) {
                try {
                  await shell.openPath(targetOutputDirectory)
                } catch {}
              }
            }
          }
        } else {
          failedCount++
          errors.push({ path: filePath, error: '生成去 Exif 副本失败' })
        }
      } else if (action === 'optimize') {
        // 4. 视频优化与转码 (保存优化后的视频到 .VirtualDirectory\.video_optimizer\{YYYYMMDD}，保持原文件名，不修改原文件)
        const baseWorkspace = workspaceDirectoryPath || path.dirname(filePath)
        const outDir = path.join(baseWorkspace, '.VirtualDirectory', '.video_optimizer', yyyymmdd)
        targetOutputDirectory = outDir
        await mkdirp(outDir)

        const { omniTranscoded, finalTranscodedPath, failMessage } = await optimizeVideoForFile(
          filePath,
          outDir,
          omniApiUrl
        )

        if (omniTranscoded && finalTranscodedPath && (await existsAsync(finalTranscodedPath))) {
          processedPaths.push(filePath)
          successCount++
          details.push({
            oldPath: filePath,
            newPath: finalTranscodedPath,
            message: `已完成视频高效能转码优化并导出至: ${finalTranscodedPath}`
          })

          // 核心体验优化：首个文件优化完成后立即打开文件管理器并精准高亮定位该文件，避免用户等待焦虑
          if (!hasOpenedFirstItem) {
            hasOpenedFirstItem = true
            try {
              shell.showItemInFolder(finalTranscodedPath)
              logger.debug(
                LogCategory.FILE_ORGANIZATION,
                `[视频优化] 首个文件优化完成，已立即打开文件管理器并定位: ${finalTranscodedPath}`
              )
            } catch (showErr: any) {
              logger.warn(
                LogCategory.FILE_ORGANIZATION,
                `[视频优化] 首个文件定位失败，尝试打开输出目录:`,
                showErr
              )
              if (targetOutputDirectory && (await existsAsync(targetOutputDirectory))) {
                try {
                  await shell.openPath(targetOutputDirectory)
                } catch {}
              }
            }
          }
        } else {
          failedCount++
          errors.push({ path: filePath, error: failMessage || 'Czkawka 视频转码未产出物理文件' })
        }
      }
    } catch (err: any) {
      logger.error(
        LogCategory.FILE_ORGANIZATION,
        `执行修复动作失败 [${action}] -> ${filePath}:`,
        err
      )
      failedCount++
      errors.push({ path: filePath, error: err?.message || '修复执行失败' })
    }
  }

  // 执行成功且存在输出目录时，若在循环中尚未成功打开（例如异常兜底），自动使用系统文件管理器打开对应目标目录
  if (
    !hasOpenedFirstItem &&
    successCount > 0 &&
    targetOutputDirectory &&
    (await existsAsync(targetOutputDirectory))
  ) {
    try {
      await shell.openPath(targetOutputDirectory)
      logger.debug(
        LogCategory.FILE_ORGANIZATION,
        `已使用系统文件管理器打开生成目录: ${targetOutputDirectory}`
      )
    } catch (openErr: any) {
      logger.warn(LogCategory.FILE_ORGANIZATION, `自动打开输出目录失败:`, openErr)
    }
  }

  return {
    action,
    successCount,
    failedCount,
    processedPaths,
    outputDirectory: targetOutputDirectory,
    details,
    errors: errors.length > 0 ? errors : undefined
  }
}
