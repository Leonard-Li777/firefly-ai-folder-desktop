import * as fs from 'fs'
import * as path from 'path'
import { ipcMain, BrowserWindow } from 'electron'
import { databaseService } from '../../runtime-services/database/database-service'
import { fileWatcherService } from '../../runtime-services/filesystem/file-watcher-service'
import {
  loadIgnoreRules,
  shouldIgnoreFile
} from '../../runtime-services/analysis/analysis-ignore-service'
import { logger, LogCategory, getMimeTypeByExtension, normalizeForCache } from '@firefly/shared'
import { t } from '@app/languages'
import type { FileInfo, FileItem, DirectoryItem, WorkspaceDirectory } from '@firefly/types'
import { analyzedDirectoryService, syncedDirectories } from '../state'
import { trayService } from '../../runtime-services/system/tray-service'
import { ConfigOrchestrator } from '../../config/config-orchestrator'

export function registerFileIPCHandlers() {
  // 文件操作相关

  // 校验目录是否可写：通过实际创建并删除临时文件检测（比 fs.access 更可靠，尤其 Windows 上对目录的 W_OK 检查不准确）
  ipcMain.handle('check-directory-writable', async (_event, dirPath: string) => {
    try {
      // 目录不存在时先尝试创建（对应对话框中 createDirectory 选项）
      await fs.promises.mkdir(dirPath, { recursive: true })
      const probeFile = path.join(
        dirPath,
        `.write-test-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
      )
      await fs.promises.writeFile(probeFile, '')
      await fs.promises.unlink(probeFile)
      return { writable: true }
    } catch (error) {
      logger.warn(LogCategory.MAIN, `目录无写权限: ${dirPath}`, error)
      return { writable: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  ipcMain.handle('get-all-files', async () => {
    return await databaseService.getAllFiles()
  })

  ipcMain.handle('add-file', async (event, file: FileInfo) => {
    await databaseService.addFile(file)
  })

  ipcMain.handle(
    'search-workspace-files',
    async (event, keyword: string, workspacePath: string) => {
      // 真实目录搜索统一走数据库"文件全信息搜索"：
      // FTS 全字段（文件名/智能名/描述/内容/标签等）+ path/type/author/language/category LIKE，
      // 并包含未分析文件（通过基础字段兼容命中）
      try {
        const result = await analyzedDirectoryService.getFilteredFilesPaged({
          selectedTags: [],
          sortBy: 'name',
          sortOrder: 'asc',
          workspaceDirectoryPath: workspacePath,
          searchKeyword: keyword,
          includeUnanalyzed: true,
          limit: 500,
          offset: 0
        })
        // 保持与原有文件系统搜索返回格式一致：id 使用文件路径
        return result.items.map(item => ({
          ...item,
          id: item.path,
          isSelected: item.isSelected ?? false
        }))
      } catch (error) {
        logger.error(LogCategory.MAIN, '全信息搜索工作区文件失败:', error)
        return []
      }
    }
  )

  ipcMain.handle('read-file-base64', async (event, filePath: string) => {
    try {
      const buffer = await fs.promises.readFile(filePath)
      const mimeType = getMimeTypeByExtension(filePath)
      return `data:${mimeType};base64,${buffer.toString('base64')}`
    } catch (error) {
      logger.error(LogCategory.MAIN, `[IPC] 读取文件转base64失败: ${filePath}`, error)
      throw error
    }
  })

  ipcMain.handle('read-file-buffer', async (event, filePath: string) => {
    try {
      const buffer = await fs.promises.readFile(filePath)
      return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    } catch (error) {
      logger.error(LogCategory.MAIN, `[IPC] 读取文件Buffer失败: ${filePath}`, error)
      throw error
    }
  })

  ipcMain.handle('write-file', async (event, filePath: string, content: string) => {
    try {
      await fs.promises.writeFile(filePath, content, 'utf-8')
      return { success: true }
    } catch (error) {
      logger.error(LogCategory.MAIN, `写入文件失败: ${filePath}`, error)
      throw error
    }
  })

  ipcMain.handle('add-workspace-directory', async (event, directory: WorkspaceDirectory) => {
    const wsId = await databaseService.addWorkspaceDirectory(directory)
    trayService
      .updateContextMenu()
      .catch(err => logger.warn(LogCategory.MAIN, '[IPC] 刷新托盘菜单失败:', err))
    return wsId
  })
  ipcMain.handle('get-all-workspace-directories', async () => {
    try {
      return await databaseService.getAllWorkspaceDirectories()
    } catch (e) {
      return []
    }
  })
  ipcMain.handle('get-current-workspace-directory', async () =>
    databaseService.getCurrentWorkspaceDirectory()
  )
  ipcMain.handle('set-current-workspace-directory', async (event, path: string) => {
    await databaseService.setCurrentWorkspaceDirectory(path)
    trayService
      .updateContextMenu()
      .catch(err => logger.warn(LogCategory.MAIN, '[IPC] 刷新托盘菜单失败:', err))
    BrowserWindow.getAllWindows().forEach((win: any) => {
      if (!win.isDestroyed()) win.webContents.send('workspace-directories-updated')
    })
  })

  ipcMain.handle('read-directory', async (event, dirPath: string) => {
    try {
      if (!syncedDirectories.has(dirPath)) {
        logger.info(LogCategory.MAIN, `[Main] 首次访问目录，触发同步: ${dirPath}`)
        syncedDirectories.add(dirPath)
        fileWatcherService.syncDirectory(dirPath).catch(err => {
          logger.error(LogCategory.MAIN, '[Main] 异步同步目录失败:', { dirPath, error: err })
        })
      }
      const files: FileItem[] = []
      const directories: DirectoryItem[] = []
      const ignoreRules = loadIgnoreRules()

      const isReadingVirtualDirectory = dirPath.split(/[\\\/]/).includes('.VirtualDirectory')
      const effectiveIgnoreRules = isReadingVirtualDirectory
        ? ignoreRules.filter(r => r.value !== '.VirtualDirectory')
        : ignoreRules

      const [entries, workspace] = await Promise.all([
        fs.promises.readdir(dirPath, { withFileTypes: true }),
        databaseService.findRootWorkspaceDirectory(dirPath),
        analyzedDirectoryService
          ? analyzedDirectoryService.cleanupVirtualDirectory(dirPath).catch(e => {
              logger.warn(LogCategory.MAIN, '[IPC] 清理虚拟目录失败:', dirPath, e)
            })
          : Promise.resolve()
      ])

      const loadedFilePaths = new Set<string>()

      if (workspace && workspace.id) {
        const dbFiles = await databaseService.getFilesByParentPath(dirPath, workspace.id)

        await Promise.all(
          dbFiles.map(async file => {
            const safePath = file.path || ''
            const safeName = file.name || path.basename(safePath) || 'unknown'

            if (shouldIgnoreFile(safePath, safeName, effectiveIgnoreRules)) {
              logger.debug(LogCategory.MAIN, `[Main] 过滤掉数据库中被忽略的文件: ${safePath}`)
              return
            }

            let fileStatus = file.status ?? 1
            const exists = fs.existsSync(safePath)
            if (fileStatus === 1 && !exists) {
              fileStatus = 0
              databaseService.updateFileStatus(file.id, 0).catch(() => {})
            } else if (fileStatus === 0 && exists) {
              fileStatus = 1
              databaseService.updateFileStatus(file.id, 1).catch(() => {})
            }

            const showMissing =
              ConfigOrchestrator.getInstance().getValue<boolean>('SHOW_MISSING_FILES') ?? true
            if (!showMissing && fileStatus === 0) {
              return
            }

            loadedFilePaths.add(safePath)

            let fileSize = file.size
            if (fileSize === null || fileSize === undefined) {
              try {
                const stats = await fs.promises.stat(file.path)
                fileSize = stats.size
              } catch (e) {
                fileSize = 0
              }
            }

            files.push({
              id: file.id,
              status: fileStatus,
              name: safeName,
              smartName: file.smartName || undefined,
              path: safePath,
              parentPath: dirPath,
              size: fileSize,
              extension: file.extension || path.extname(safePath).toLowerCase(),
              modifiedAt: file.modifiedAt ? new Date(file.modifiedAt) : new Date(),
              isSelected: false,
              isAnalyzed: !!file.isAnalyzed,
              lastAnalyzedAt: file.lastAnalyzedAt ? new Date(file.lastAnalyzedAt) : undefined,
              thumbnailPath: file.thumbnailPath || undefined,
              qualityScore: file.qualityScore || undefined
            })
          })
        )
      }

      await Promise.all(
        entries.map(async entry => {
          const fullPath = path.join(dirPath, entry.name)
          if (entry.isDirectory()) {
            if (
              entry.name === '.VirtualDirectory' ||
              shouldIgnoreFile(fullPath, entry.name, effectiveIgnoreRules)
            )
              return
            try {
              const stats = await fs.promises.stat(fullPath)
              directories.push({
                id: `${fullPath}:${stats.mtime.getTime()}`,
                name: entry.name,
                path: fullPath,
                parentPath: dirPath,
                isDirectory: true,
                modifiedAt: stats.mtime
              })
            } catch (e) {
              logger.warn(LogCategory.MAIN, '[IPC] 读取目录状态失败:', fullPath, e)
            }
          } else if (entry.isFile()) {
            if (
              loadedFilePaths.has(fullPath) ||
              shouldIgnoreFile(fullPath, entry.name, effectiveIgnoreRules)
            )
              return
            try {
              const stats = await fs.promises.stat(fullPath)
              files.push({
                id: `disk-${fullPath}:${stats.mtime.getTime()}`,
                name: entry.name,
                path: fullPath,
                parentPath: dirPath,
                size: stats.size,
                extension: path.extname(entry.name).toLowerCase(),
                modifiedAt: stats.mtime,
                isSelected: false,
                isAnalyzed: false
              })
            } catch (e) {
              logger.warn(LogCategory.MAIN, '[IPC] 读取文件状态失败:', fullPath, e)
            }
          }
        })
      )

      files.sort((a, b) => a.name.localeCompare(b.name))
      directories.sort((a, b) => a.name.localeCompare(b.name))

      // 从 file_units 表查询目录的单元标记
      if (directories.length > 0) {
        const dirPaths = directories.map(d => d.path)
        const placeholders = dirPaths.map(() => '?').join(',')
        const unitRows = databaseService.db
          ?.prepare(
            `SELECT path, type, grouping_reason, grouping_confidence FROM file_units WHERE path IN (${placeholders})`
          )
          .all(...dirPaths) as
          | Array<{
              path: string
              type: string
              grouping_reason: string
              grouping_confidence: number
            }>
          | undefined
        if (unitRows && unitRows.length > 0) {
          const unitMap = new Map(unitRows.map(r => [r.path, r]))
          for (const dir of directories) {
            const unit = unitMap.get(dir.path)
            if (unit) {
              ;(dir as any).isUnit = true
              ;(dir as any).unitType = unit.type
              ;(dir as any).unitReason = unit.grouping_reason
              ;(dir as any).unitConfidence = unit.grouping_confidence
            }
          }
        }
      }

      return { files, directories }
    } catch (error) {
      logger.error(LogCategory.MAIN, '读取目录失败:', error)
      const errorMessage = error instanceof Error ? error : new Error(String(error))
      const errorCode = (errorMessage as any).code
      if (errorCode === 'EPERM' || errorCode === 'EACCES')
        throw new Error(t('权限不足，无法访问目录: {dirPath}', { dirPath }))
      else if (errorCode === 'ENOENT') throw new Error(t('目录不存在: {dirPath}', { dirPath }))
      else
        throw new Error(
          t('无法读取目录: {dirPath} ({errorDetail})', {
            dirPath,
            errorDetail: errorCode || errorMessage.message
          })
        )
    }
  })
}
