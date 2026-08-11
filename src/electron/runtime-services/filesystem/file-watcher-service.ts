import chokidar from 'chokidar'
import path from 'node:path'
import fs from 'node:fs'
import { logger, LogCategory, isSubPath } from '@firefly/shared'
import { databaseService } from '../database/database-service'
import { analysisQueueService } from '../analysis-queue-service'
import { loadIgnoreRules, shouldIgnoreFile } from '../analysis/analysis-ignore-service'
import type { IIgnoreRule } from '@firefly/types'
import { calculateFileFingerprint } from '@firefly/core-engine'

/**
 * 文件监听服务类
 */
class FileWatcherService {
  private watchers: Map<number, ReturnType<typeof chokidar.watch>> = new Map()
  private ignoreRules: IIgnoreRule[] = []
  private isInitialized = false
  private syncingPaths: Set<string> = new Set()
  private notificationTimers: Map<string, NodeJS.Timeout> = new Map()
  private processingFiles: Set<string> = new Set() // 防止同一文件重复处理
  private lastSyncTime: Map<string, number> = new Map() // 记录每个目录的最后同步时间，防止频繁重复同步

  private fileEventLogTimers: Map<string, NodeJS.Timeout> = new Map()
  private fileEventLogCounts: Map<string, number> = new Map()
  private fileEventLogOmitted: Map<string, number> = new Map()

  private logFileEvent(eventType: '修改' | '新增' | '删除', filePath: string): void {
    if (!this.fileEventLogTimers.has(eventType)) {
      this.fileEventLogCounts.set(eventType, 0)
      this.fileEventLogOmitted.set(eventType, 0)

      const timer = setTimeout(() => {
        const omitted = this.fileEventLogOmitted.get(eventType) || 0
        if (omitted > 0) {
          logger.info(LogCategory.FILE_WATCHER, `检测到文件${eventType}日志，已省略${omitted}个`)
        }
        this.fileEventLogTimers.delete(eventType)
      }, 1000)

      this.fileEventLogTimers.set(eventType, timer)
    }

    const count = this.fileEventLogCounts.get(eventType) || 0
    if (count < 5) {
      const actionText = eventType === '新增' ? '新文件' : `文件${eventType}`
      logger.info(LogCategory.FILE_WATCHER, `检测到${actionText}: ${filePath}`)
      this.fileEventLogCounts.set(eventType, count + 1)
    } else {
      this.fileEventLogOmitted.set(eventType, (this.fileEventLogOmitted.get(eventType) || 0) + 1)
    }
  }

  /**
   * 通知前端更新文件列表（带节流）
   * @param directoryPath 目录路径
   */
  private notifyDirectoryUpdate(directoryPath: string): void {
    if (this.notificationTimers.has(directoryPath)) {
      return
    }

    // 设置 300ms 的节流
    const timer = setTimeout(async () => {
      try {
        const { BrowserWindow } = await import('electron')
        const windows = BrowserWindow.getAllWindows()
        if (windows.length > 0) {
          logger.debug(LogCategory.FILE_WATCHER, `发送目录更新通知: ${directoryPath}`)
          windows.forEach(win => {
            if (!win.isDestroyed()) {
              win.webContents.send('directory-files-updated', directoryPath)
            }
          })
        }
      } catch (error) {
        logger.error(LogCategory.FILE_WATCHER, '发送目录更新通知失败:', error)
      } finally {
        this.notificationTimers.delete(directoryPath)
      }
    }, 300)

    this.notificationTimers.set(directoryPath, timer)
  }

  /**
   * 初始化文件监听服务
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      logger.warn(LogCategory.FILE_WATCHER, '文件监听服务已经初始化')
      return
    }

    try {
      logger.info(LogCategory.FILE_WATCHER, '初始化文件监听服务...')

      // 加载忽略规则
      this.ignoreRules = loadIgnoreRules()
      logger.info(LogCategory.FILE_WATCHER, `已加载 ${this.ignoreRules.length} 条忽略规则`)

      // 启动所有启用了 autoWatch 的工作目录的监听
      await this.startAllAutoWatchers()

      this.isInitialized = true
      logger.info(LogCategory.FILE_WATCHER, '文件监听服务初始化成功')
    } catch (error) {
      logger.error(LogCategory.FILE_WATCHER, '文件监听服务初始化失败:', error)
      throw error
    }
  }

  /**
   * 启动所有启用了 autoWatch 的工作目录的监听
   */
  async startAllAutoWatchers(): Promise<void> {
    try {
      const directories = await databaseService.getAllWorkspaceDirectories()
      const autoWatchDirs = directories.filter(dir => dir.autoWatch && dir.isActive)

      logger.info(LogCategory.FILE_WATCHER, `找到 ${autoWatchDirs.length} 个启用自动监听的目录`)

      for (const directory of autoWatchDirs) {
        if (directory.id) {
          await this.startWatching(directory.id, directory.path)
        }
      }
    } catch (error) {
      logger.error(LogCategory.FILE_WATCHER, '启动自动监听失败:', error)
      throw error
    }
  }

  /**
   * 开始监听指定目录
   * @param workspaceId 工作目录ID
   * @param directoryPath 目录路径
   */
  async startWatching(workspaceId: number, directoryPath: string): Promise<void> {
    try {
      // 如果已经在监听，先停止
      if (this.watchers.has(workspaceId)) {
        logger.info(LogCategory.FILE_WATCHER, `目录 ${directoryPath} 已在监听中，先停止旧的监听器`)
        await this.stopWatching(workspaceId)
      }

      logger.info(LogCategory.FILE_WATCHER, `开始监听目录: ${directoryPath}`)

      // 创建监听器
      const watcher = chokidar.watch(directoryPath, {
        persistent: true,
        ignoreInitial: true, // 不触发初始文件的事件
        depth: 1, // 监听根层级及其直接子目录，检测新子目录创建；文件变更由 addDir→syncDirectory 惰性扫描
        awaitWriteFinish: {
          stabilityThreshold: 2000, // 文件稳定2秒后才触发事件（等待文件写入完成）
          pollInterval: 100
        },
        ignored: (filePath: string) => {
          // 检查是否应该忽略此文件
          const fileName = path.basename(filePath)
          return shouldIgnoreFile(filePath, fileName, this.ignoreRules)
        }
      })

      // 监听新增文件事件
      watcher.on('add', async (filePath: string) => {
        await this.handleFileAdded(workspaceId, directoryPath, filePath, true)
      })

      // 监听新增子目录事件——自动扫描新子目录中的文件（惰性加载）
      watcher.on('addDir', async (dirPath: string) => {
        // 忽略根目录本身的 addDir 事件
        if (dirPath === directoryPath) return
        // 忽略 .VirtualDirectory 及其内部的目录
        if (
          dirPath.includes(`${path.sep}.VirtualDirectory${path.sep}`) ||
          dirPath.endsWith(`${path.sep}.VirtualDirectory`)
        )
          return
        // 异步同步该子目录的文件到数据库（不阻塞监听器）
        this.syncDirectory(dirPath, true).catch(err => {
          logger.error(LogCategory.FILE_WATCHER, `同步新子目录失败: ${dirPath}`, err)
        })
      })

      // 监听文件修改事件
      watcher.on('change', async (filePath: string) => {
        await this.handleFileChanged(workspaceId, directoryPath, filePath, true)
      })

      // 监听文件删除事件
      watcher.on('unlink', async (filePath: string) => {
        await this.handleFileDeleted(workspaceId, directoryPath, filePath)
      })

      // 监听错误事件
      watcher.on('error', (error: unknown) => {
        const errorMessage = error instanceof Error ? error.message : String(error)
        logger.error(
          LogCategory.FILE_WATCHER,
          `监听目录 ${directoryPath} 时发生错误:`,
          errorMessage
        )
      })

      // 监听就绪事件
      watcher.on('ready', () => {
        logger.info(LogCategory.FILE_WATCHER, `目录 ${directoryPath} 监听就绪`)
      })

      this.watchers.set(workspaceId, watcher)
      logger.info(LogCategory.FILE_WATCHER, `成功启动对目录 ${directoryPath} 的监听`)
    } catch (error) {
      logger.error(LogCategory.FILE_WATCHER, `启动目录监听失败: ${directoryPath}`, error)
      throw error
    }
  }

  /**
   * 停止监听指定目录
   * @param workspaceId 工作目录ID
   */
  async stopWatching(workspaceId: number): Promise<void> {
    try {
      const watcher = this.watchers.get(workspaceId)
      if (watcher) {
        await watcher.close()
        this.watchers.delete(workspaceId)
        logger.info(LogCategory.FILE_WATCHER, `已停止监听目录 ID: ${workspaceId}`)
      }
    } catch (error) {
      logger.error(LogCategory.FILE_WATCHER, `停止目录监听失败 ID: ${workspaceId}`, error)
      throw error
    }
  }

  /**
   * 同步指定目录中的文件差异（即时对齐）
   * @param dirPath 目录路径
   * @param triggerAnalysis 是否触发新文件的分析
   */
  async syncDirectory(dirPath: string, triggerAnalysis = false): Promise<void> {
    if (!this.isInitialized) {
      this.ignoreRules = loadIgnoreRules()
    }

    if (this.syncingPaths.has(dirPath)) {
      logger.debug(LogCategory.FILE_WATCHER, `目录正在同步中，跳过: ${dirPath}`)
      return
    }

    const now = Date.now()
    const lastSync = this.lastSyncTime.get(dirPath) || 0
    if (now - lastSync < 10000) {
      // 缩短到 5 秒以提高响应性
      logger.warn(LogCategory.FILE_WATCHER, `目录同步过于频繁，跳过: ${dirPath}`)
      return
    }
    this.lastSyncTime.set(dirPath, now)

    this.syncingPaths.add(dirPath)

    try {
      logger.info(LogCategory.FILE_WATCHER, `开始全量同步目录: ${dirPath}`)

      // 1. 获取工作空间
      const workspace = await databaseService.findRootWorkspaceDirectory(dirPath)
      if (!workspace || !workspace.id) return

      // 2. 单层级扫描磁盘文件与子目录（不递归子目录——子目录延迟到用户进入时同步）
      const diskFileMap = new Map<string, fs.Stats>()
      const diskDirSet = new Set<string>()

      if (!fs.existsSync(dirPath)) return
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)
        if (shouldIgnoreFile(fullPath, entry.name, this.ignoreRules)) continue

        if (entry.isFile()) {
          try {
            diskFileMap.set(fullPath, fs.statSync(fullPath))
          } catch (e) {
            logger.warn(LogCategory.FILE_WATCHER, '同步目录时 stat 文件失败:', fullPath, e)
          }
        } else if (entry.isDirectory()) {
          diskDirSet.add(fullPath)
        }
      }
      logger.info(
        LogCategory.FILE_WATCHER,
        `单层级扫描完成，找到 ${diskFileMap.size} 个文件, ${diskDirSet.size} 个子目录: ${dirPath}`
      )

      // 3. 读取数据库记录（仅当前层级，不获取子目录文件）
      const dbFiles = await databaseService.getFilesByParentPath(dirPath, workspace.id)
      const dbFileMap = new Map<string, any>()
      for (const file of dbFiles) {
        dbFileMap.set(file.path, file)
      }

      // 4. 对比并处理
      let added = 0,
        updated = 0,
        deleted = 0
      const filesToAdd: { filePath: string; stats: fs.Stats }[] = []

      // 处理新增和修改
      for (const [filePath, stats] of diskFileMap.entries()) {
        const dbFile = dbFileMap.get(filePath)

        if (!dbFile) {
          filesToAdd.push({ filePath, stats })
          added++
        } else {
          // 检查修改
          const timeDiff = Math.abs(
            new Date(dbFile.modifiedAt || 0).getTime() - stats.mtime.getTime()
          )
          if (timeDiff > 1000 || dbFile.size !== stats.size) {
            await this.handleFileChanged(
              workspace.id,
              dirPath,
              filePath,
              triggerAnalysis || workspace.autoWatch,
              true
            )
            updated++
          }
        }
      }

      // 批量将新增文件写入数据库
      if (filesToAdd.length > 0) {
        logger.info(LogCategory.FILE_WATCHER, `开始批量将 ${filesToAdd.length} 个文件写入数据库...`)
        await databaseService.addFilesFromPathsBatch(filesToAdd, workspace.id)
        logger.info(LogCategory.FILE_WATCHER, `批量写入数据库完成`)
      }

      // 处理删除（仅处理当前目录下已不存在的文件）
      for (const [pathInDb, dbFile] of dbFileMap.entries()) {
        if (isSubPath(dirPath, pathInDb)) {
          if (!diskFileMap.has(pathInDb)) {
            await this.handleFileDeleted(workspace.id, dirPath, pathInDb, true)
            deleted++
          }
        }
      }

      // 5. 记录子目录到 workspace_directories 表（确保后续导航进入时能正确查询）
      let dirsAdded = 0
      for (const dirFullPath of diskDirSet) {
        try {
          await databaseService.addDirectory(dirFullPath, workspace.id)
          dirsAdded++
        } catch (e) {
          logger.warn(LogCategory.FILE_WATCHER, `记录子目录失败: ${dirFullPath}`, e)
        }
      }

      // 更新日志信息包含目录数量
      logger.info(
        LogCategory.FILE_WATCHER,
        `目录同步完成: ${dirPath} (新增:${added}, 更新:${updated}, 删除:${deleted}, 子目录:${dirsAdded})`
      )

      // 如果有新增文件，且开启了自动分析，则批量添加到队列
      const isAutoWatchActive = triggerAnalysis || workspace.autoWatch
      if (isAutoWatchActive && filesToAdd.length > 0) {
        logger.info(
          LogCategory.FILE_WATCHER,
          `开始批量将 ${filesToAdd.length} 个文件加入分析队列...`
        )
        const queueItems = filesToAdd.map(f => ({
          path: f.filePath,
          name: path.basename(f.filePath),
          size: f.stats.size,
          type: path.extname(f.filePath).toLowerCase() || 'unknown'
        }))
        await analysisQueueService.addItems(queueItems, false)
        logger.info(LogCategory.FILE_WATCHER, `批量加入队列完成`)
      }

      this.notifyDirectoryUpdate(dirPath)
    } catch (error) {
      logger.error(LogCategory.FILE_WATCHER, `同步目录失败: ${dirPath}`, error)
    } finally {
      this.syncingPaths.delete(dirPath)
    }
  }
  /**
   * 处理文件新增事件
   * @param workspaceId 工作目录ID
   * @param directoryPath 目录路径
   * @param filePath 文件完整路径
   * @param autoWatchEnabled 是否开启了自动监听（可选，若不传则从数据库查询或默认为true）
   */
  private async handleFileAdded(
    workspaceId: number,
    directoryPath: string,
    filePath: string,
    autoWatchEnabled?: boolean,
    skipNotify?: boolean
  ): Promise<void> {
    // 【防护1】检查是否正在处理此文件
    if (this.processingFiles.has(filePath)) {
      logger.debug(LogCategory.FILE_WATCHER, `文件正在处理中，跳过添加: ${filePath}`)
      return
    }

    try {
      // 【防护2】检查文件是否已经在数据库中，避免重复添加
      let existingFile = null
      try {
        existingFile = await databaseService.getFileByPath(filePath)
      } catch (dbError) {
        logger.debug(LogCategory.FILE_WATCHER, `查询文件是否存在时出错: ${filePath}`, dbError)
      }

      if (existingFile) {
        logger.debug(LogCategory.FILE_WATCHER, `文件已存在于数据库，跳过添加: ${filePath}`)
        return
      }

      // 【防护3】标记为正在处理
      this.processingFiles.add(filePath)

      this.logFileEvent('新增', filePath)

      if (!fs.existsSync(filePath)) {
        logger.warn(LogCategory.FILE_WATCHER, `文件不存在: ${filePath}`)
        return
      }

      const stats = fs.statSync(filePath)
      if (!stats.isFile()) {
        logger.debug(LogCategory.FILE_WATCHER, `跳过非文件: ${filePath}`)
        return
      }

      const fileId = await databaseService.addFileFromPath(
        filePath,
        directoryPath,
        workspaceId,
        true
      )
      logger.info(
        LogCategory.FILE_WATCHER,
        `文件已添加到数据库: ${filePath}, Fingerprint: ${fileId}`
      )

      const isAutoWatchActive = autoWatchEnabled ?? true

      if (isAutoWatchActive) {
        // 检查文件是否已经被分析过（例如文件重命名或移动后触发的 add 事件）
        const fileRecord = await databaseService.getFileByPath(filePath)
        if (fileRecord && fileRecord.isAnalyzed) {
          logger.info(LogCategory.FILE_WATCHER, `文件已被分析过，跳过加入分析队列: ${filePath}`)
        } else {
          const fileName = path.basename(filePath)
          const fileExt = path.extname(filePath).toLowerCase()

          await analysisQueueService.addItems(
            [
              {
                path: filePath,
                name: fileName,
                size: stats.size,
                type: fileExt || 'unknown'
              }
            ],
            false
          )

          logger.info(LogCategory.FILE_WATCHER, `文件已加入分析队列: ${filePath}`)
        }
      }

      if (!skipNotify) {
        this.notifyDirectoryUpdate(directoryPath)
      }
    } catch (error) {
      logger.error(LogCategory.FILE_WATCHER, `处理新增文件失败: ${filePath}`, error)
    } finally {
      this.processingFiles.delete(filePath)
    }
  }

  private async handleFileChanged(
    workspaceId: number,
    directoryPath: string,
    filePath: string,
    autoWatchEnabled?: boolean,
    skipNotify?: boolean
  ): Promise<void> {
    if (this.processingFiles.has(filePath)) {
      logger.debug(LogCategory.FILE_WATCHER, `文件正在处理中，跳过修改处理: ${filePath}`)
      return
    }
    this.processingFiles.add(filePath)

    try {
      this.logFileEvent('修改', filePath)

      if (!fs.existsSync(filePath)) {
        logger.warn(LogCategory.FILE_WATCHER, `文件不存在: ${filePath}`)
        return
      }

      const stats = fs.statSync(filePath)
      if (!stats.isFile()) {
        logger.debug(LogCategory.FILE_WATCHER, `跳过非文件: ${filePath}`)
        return
      }

      await databaseService.updateFileModifiedTime(filePath, stats.mtime)

      const file = await databaseService.getFileByPath(filePath)
      if (!file) {
        logger.warn(LogCategory.FILE_WATCHER, `数据库中未找到文件记录: ${filePath}`)
        return
      }

      const isAutoWatchActive = autoWatchEnabled ?? true

      if (isAutoWatchActive) {
        const contentHash = await calculateFileFingerprint(filePath)

        if (file.contentHash === contentHash && file.isAnalyzed) {
          logger.info(LogCategory.FILE_WATCHER, `文件内容无变化，跳过队列分析: ${filePath}`)
          return
        }

        const fileName = path.basename(filePath)
        const fileExt = path.extname(filePath).toLowerCase()

        await analysisQueueService.addItems(
          [
            {
              path: filePath,
              name: fileName,
              size: stats.size,
              type: fileExt || 'unknown'
            }
          ],
          true
        )

        logger.info(LogCategory.FILE_WATCHER, `修改的文件已重新加入分析队列: ${filePath}`)
      }

      if (!skipNotify) {
        this.notifyDirectoryUpdate(directoryPath)
      }
    } catch (error) {
      logger.error(LogCategory.FILE_WATCHER, `处理文件修改失败: ${filePath}`, error)
    } finally {
      this.processingFiles.delete(filePath)
    }
  }

  private async handleFileDeleted(
    workspaceId: number,
    directoryPath: string,
    filePath: string,
    skipNotify?: boolean
  ): Promise<void> {
    if (this.processingFiles.has(filePath)) {
      logger.debug(LogCategory.FILE_WATCHER, `文件正在处理中，跳过删除处理: ${filePath}`)
      return
    }
    this.processingFiles.add(filePath)

    try {
      this.logFileEvent('删除', filePath)

      const file = await databaseService.getFileByPath(filePath)
      if (file) {
        await databaseService.updateFileStatus(file.fileId || file.id, 0)
        logger.info(LogCategory.FILE_WATCHER, `文件不存在，已更新数据库状态 status=0: ${filePath}`)
      }

      if (!skipNotify) {
        this.notifyDirectoryUpdate(directoryPath)
      }
    } catch (error) {
      logger.error(LogCategory.FILE_WATCHER, `处理文件删除失败: ${filePath}`, error)
    } finally {
      this.processingFiles.delete(filePath)
    }
  }

  /**
   * 重新加载忽略规则
   */
  async reloadIgnoreRules(): Promise<void> {
    try {
      this.ignoreRules = loadIgnoreRules()
      logger.info(
        LogCategory.FILE_WATCHER,
        `[文件监听] 已重新加载 ${this.ignoreRules.length} 条忽略规则`
      )
    } catch (error) {
      logger.error(LogCategory.FILE_WATCHER, '[文件监听] 重新加载忽略规则失败:', error)
    }
  }

  async cleanup(): Promise<void> {
    try {
      logger.info(LogCategory.FILE_WATCHER, '清理文件监听服务...')

      for (const [workspaceId, watcher] of this.watchers.entries()) {
        await watcher.close()
        logger.debug(LogCategory.FILE_WATCHER, `已关闭监听器: ${workspaceId}`)
      }

      this.watchers.clear()
      this.isInitialized = false

      logger.info(LogCategory.FILE_WATCHER, '文件监听服务已清理')
    } catch (error) {
      logger.error(LogCategory.FILE_WATCHER, '清理文件监听服务失败:', error)
      throw error
    }
  }

  getWatcherCount(): number {
    return this.watchers.size
  }

  isWatching(workspaceId: number): boolean {
    return this.watchers.has(workspaceId)
  }
}

export const fileWatcherService = new FileWatcherService()
