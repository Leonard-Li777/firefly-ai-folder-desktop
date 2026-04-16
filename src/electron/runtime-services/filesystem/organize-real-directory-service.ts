import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

import {
  FileOperation,
  FileOrganizeResult,
  DirectoryNode,
  OrganizeStatistics,
  FileConflict,
  ConflictResolutionOptions,
  FileInfoForAI,
  AIDirectoryStructure
} from '@yonuc/types/organize-types'
import { encode } from '@toon-format/toon'
import { logger, LogCategory } from '@yonuc/shared'
import { SavedVirtualDirectory } from '@yonuc/types'
import { platformAdapter } from '../system/platform-adapter'
import { QuickOrganizeService, type QuickOrganizeOptions, AIHelper } from '@yonuc/core-engine'
import { AIServiceAdapter } from '../ai/ai-service-adapter'
import { configService } from '../config'
import { t } from '@app/languages'

const VIRTUAL_DIRECTORY_FOLDER = '.VirtualDirectory'

/**
 * 整理真实目录服务
 */
export class OrganizeRealDirectoryService {
  private quickOrganizeService!: QuickOrganizeService
  private aiServiceAdapter?: AIServiceAdapter

  constructor(private db: Database.Database) {
    // AI服务适配器将在需要时创建
  }

  /**
   * 获取或创建AI服务适配器
   */
  private async getAIServiceAdapter(): Promise<AIServiceAdapter> {
    if (!this.aiServiceAdapter) {
      const { createCoreEngineAdapters } = await import('../../adapters')
      const adapters = await createCoreEngineAdapters()
      this.aiServiceAdapter = new AIServiceAdapter()

    }
    return this.aiServiceAdapter
  }

  /**
   * 获取或创建快速整理服务
   */
  private async getQuickOrganizeService(): Promise<QuickOrganizeService> {
    if (!this.quickOrganizeService) {
      const { createCoreEngineAdapters } = await import('../../adapters')
      const adapters = await createCoreEngineAdapters()
      // llamaRuntime 实现了 IAIService 接口
      this.quickOrganizeService = new QuickOrganizeService(adapters.llamaRuntime as any, adapters.aiHelper)
    }
    return this.quickOrganizeService
  }

  /**
   * 按虚拟目录整理真实目录
   */
  async organizeByVirtualDirectory(
    workspaceDirectoryPath: string,
    savedDirectories: SavedVirtualDirectory[]
  ): Promise<OrganizeStatistics> {
    const startTime = Date.now()
    const overallStatistics: OrganizeStatistics = {
      totalFiles: 0,
      movedFiles: 0,
      failedFiles: 0,
      createdDirectories: 0,
      elapsedTime: 0,
      errors: [],
      deletedVirtualDirectoryIds: [] // Initialized
    }

    try {
      logger.info(LogCategory.FILE_ORGANIZATION, '开始按虚拟目录整理真实目录', {
        workspaceDirectoryPath,
        virtualDirectoryCount: savedDirectories.length
      })

      for (const virtualDir of savedDirectories) {
        const singleDirStats = {
          total: 0,
          success: 0,
          failed: 0
        }

        // 1. Get files for this virtual directory
        const files = await this.getVirtualDirectoryFiles(workspaceDirectoryPath, virtualDir)
        if (files.length === 0) {
          // If no files, still delete the virtual directory as it's "processed"
          await this._deleteVirtualDirectory(virtualDir.id, workspaceDirectoryPath)
          overallStatistics.deletedVirtualDirectoryIds?.push(virtualDir.id) // Add ID
          continue
        }
        singleDirStats.total = files.length
        overallStatistics.totalFiles += files.length

        // 2. Generate file operations for this virtual directory
        const targetDirPath = this.buildVirtualDirectoryPath(workspaceDirectoryPath, virtualDir)
        this.ensureDirectoryExists(targetDirPath)
        overallStatistics.createdDirectories++

        const fileOperations: FileOperation[] = files.map((file) => {
          const smartName = file.smartName || file.name
          const newPath = path.join(targetDirPath, smartName)
          return { fileId: file.id, oldPath: file.path, newPath, smartName }
        })

        // 3. Detect and resolve conflicts for this batch
        const conflicts = this.detectConflicts(fileOperations)
        if (conflicts.length > 0) {
          // Simple rename strategy
          for (const conflict of conflicts) {
            const operation = fileOperations.find((op) => op.newPath === conflict.targetPath)
            if (operation) {
              operation.newPath = this.generateNewPath(operation.newPath, 'number')
            }
          }
        }

        // 4. Execute file moves for this batch
        for (const operation of fileOperations) {
          try {
            const result = await this.organizeFileWithHardlinks(operation)
            if (result.success) {
              singleDirStats.success++
            } else {
              singleDirStats.failed++
              overallStatistics.errors.push({
                filePath: operation.oldPath,
                error: result.error || '未知错误'
              })
            }
          } catch (error: any) {
            singleDirStats.failed++
            overallStatistics.errors.push({
              filePath: operation.oldPath,
              error: error.message
            })
          }
        }

        overallStatistics.movedFiles += singleDirStats.success
        overallStatistics.failedFiles += singleDirStats.failed

        // 5. If all files in this virtual directory were moved successfully, delete it.
        if (singleDirStats.failed === 0) {
          await this._deleteVirtualDirectory(virtualDir.id, workspaceDirectoryPath)
          overallStatistics.deletedVirtualDirectoryIds?.push(virtualDir.id) // Add ID
        }
      }

      overallStatistics.elapsedTime = Date.now() - startTime
      logger.info(LogCategory.FILE_ORGANIZATION, '整理完成', overallStatistics)
      return overallStatistics
    } catch (error: any) {
      overallStatistics.elapsedTime = Date.now() - startTime
      logger.error(LogCategory.FILE_ORGANIZATION, '整理过程出错', {
        error: error.message,
        statistics: overallStatistics
      })
      throw error
    }
  }

  /**
   * 获取虚拟目录中的文件
   */
  private async getVirtualDirectoryFiles(
    workspaceDirectoryPath: string,
    virtualDir: SavedVirtualDirectory
  ): Promise<Array<{ id: number; path: string; name: string; smartName?: string }>> {
    // 构建查询条件
    const selectedTags = virtualDir.filter?.selectedTags
    if (!selectedTags || selectedTags.length === 0) {
      return []
    }

    // 构建SQL查询
    let query = `
      SELECT DISTINCT
        wf.id,
        wf.path,
        wf.name,
        f.smart_name as smartName
      FROM workspace_files wf
      INNER JOIN files f ON wf.file_fingerprint = f.file_fingerprint
      INNER JOIN file_tag_relations ftr ON ftr.file_fingerprint = f.file_fingerprint
      INNER JOIN file_tags ft ON ft.id = ftr.tag_id
      WHERE wf.is_analyzed = 1
        AND wf.workspace_id = (
          SELECT workspace_id FROM workspaces WHERE path = ?
        )
    `

    const params: any[] = [workspaceDirectoryPath]

    // 添加维度标签过滤
    for (let i = 0; i < selectedTags.length; i++) {
      const tag = selectedTags[i]
      query += `
        AND EXISTS (
          SELECT 1 FROM file_tag_relations ftr${i}
          INNER JOIN file_tags ft${i} ON ft${i}.id = ftr${i}.tag_id
          WHERE ftr${i}.file_fingerprint = f.file_fingerprint
            AND ft${i}.dimension_id = ?
            AND ft${i}.name = ?
        )
      `
      params.push(tag.dimensionId, tag.tagValue)
    }

    const files = this.db.prepare(query).all(...params) as any[]
    return files
  }

  /**
   * 从标签信息构建层级目录路径
   */
  private buildTagBasedDirectoryPath(
    workspaceDirectoryPath: string,
    fileTags: Array<{ dimension: string; tag: string }>
  ): string {
    // The order of tags in fileTags is the desired directory hierarchy,
    // as it's derived directly from the virtual directory's filters.
    const dirParts = fileTags.map((tagInfo) => tagInfo.tag)

    // 如果dirParts为空，使用默认目录名
    if (dirParts.length === 0) {
      dirParts.push('其他')
    }

    return path.join(workspaceDirectoryPath, ...dirParts)
  }

  /**
   * 构建虚拟目录路径
   */
  private buildVirtualDirectoryPath(
    workspaceDirectoryPath: string,
    virtualDir: SavedVirtualDirectory
  ): string {
    const dimensionTags = (virtualDir.filter?.selectedTags || []).map((tag) => ({
      dimension: tag.dimensionName,
      tag: tag.tagValue
    }))

    // 如果有维度标签，使用基于标签的路径
    if (dimensionTags.length > 0) {
      const targetPath = this.buildTagBasedDirectoryPath(workspaceDirectoryPath, dimensionTags)
      return targetPath
    } else {
      // 如果没有维度标签，使用默认的虚拟目录名
      const dirName = virtualDir.name
      return path.join(workspaceDirectoryPath, dirName)
    }
  }

  /**
   * 确保目录存在
   */
  private ensureDirectoryExists(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true })
      logger.debug(LogCategory.FILE_ORGANIZATION, '创建目录', { dirPath })
    }
  }

  /**
   * 检测文件冲突
   */
  private detectConflicts(fileOperations: FileOperation[]): FileConflict[] {
    const conflicts: FileConflict[] = []

    for (const op of fileOperations) {
      if (fs.existsSync(op.newPath)) {
        try {
          if (!fs.existsSync(op.oldPath)) {
            logger.warn(
              LogCategory.FILE_ORGANIZATION,
              '检测冲突时发现源文件不存在，无法比较',
              { operation: op }
            )
            continue
          }
          const existingStats = fs.statSync(op.newPath)
          const newStats = fs.statSync(op.oldPath)

          // 如果源文件和目标文件是同一个文件（通过inode和device判断），则不是冲突
          if (existingStats.ino === newStats.ino && existingStats.dev === newStats.dev) {
            continue
          }

          conflicts.push({
            targetPath: op.newPath,
            existingFile: {
              path: op.newPath,
              size: existingStats.size,
              modifiedAt: existingStats.mtime
            },
            newFile: {
              path: op.oldPath,
              size: newStats.size,
              modifiedAt: newStats.mtime
            },
            conflictType: 'name'
          })
        } catch (error: any) {
          logger.error(LogCategory.FILE_ORGANIZATION, '检测冲突时出错', {
            operation: op,
            error: error.message
          })
        }
      }
    }

    return conflicts
  }

  /**
   * 生成新的文件路径（处理冲突）
   */
  private generateNewPath(
    originalPath: string,
    pattern: 'number' | 'timestamp' | 'source'
  ): string {
    const dir = path.dirname(originalPath)
    const ext = path.extname(originalPath)
    const basename = path.basename(originalPath, ext)

    switch (pattern) {
      case 'number': {
        let counter = 1
        let newPath = originalPath
        while (fs.existsSync(newPath)) {
          newPath = path.join(dir, `${basename} (${counter})${ext}`)
          counter++
        }
        return newPath
      }
      case 'timestamp': {
        const timestamp =
          new Date().toISOString().replace(/[:.]/g, '-').split('T')[0] +
          '_' +
          new Date().toISOString().split('T')[1].split('.')[0].replace(/:/g, '')
        return path.join(dir, `${basename}_${timestamp}${ext}`)
      }
      case 'source': {
        const sourceDir = path.basename(path.dirname(originalPath))
        return path.join(dir, `${basename}_${sourceDir}${ext}`)
      }
      default:
        return originalPath
    }
  }

  /**
   * 整理文件并维护硬链接关系
   */
  private async organizeFileWithHardlinks(operation: FileOperation): Promise<FileOrganizeResult> {
    try {
      let actualOldPath = operation.oldPath

      // 1. 鲁棒性检查：如果原始路径不存在，尝试规范化路径后再检查
      if (!fs.existsSync(actualOldPath)) {
        const normalized = path.normalize(actualOldPath)
        if (fs.existsSync(normalized)) {
          actualOldPath = normalized
        } else {
          // 再次尝试：如果数据库存的是 Posix 路径，在 Windows 上可能需要 resolve
          const resolved = path.resolve(actualOldPath)
          if (fs.existsSync(resolved)) {
            actualOldPath = resolved
          }
        }
      }

      // 2. 如果文件仍然不存在，可能是时序问题（文件已被当前整理流程中的其他虚拟目录移动）
      //    检查文件是否已经被移动到目标路径
      if (!fs.existsSync(actualOldPath)) {
        // 检查目标路径是否已经存在该文件（可能已被其他虚拟目录移动过来）
        if (fs.existsSync(operation.newPath)) {
          logger.info(LogCategory.FILE_ORGANIZATION, `[一键整理] 文件已在目标路径存在（可能被其他虚拟目录移动），跳过: ${operation.oldPath}`, {
            newPath: operation.newPath
          })
          return {
            fileId: operation.fileId,
            oldPath: operation.oldPath,
            newPath: operation.newPath,
            inode: 0,
            success: true, // 视为成功，因为目标已存在
            error: undefined
          }
        }

        // 通过 fileId 查询数据库获取最新路径
        const currentPathResult = this.db.prepare(
          'SELECT path FROM workspace_files WHERE id = ?'
        ).get(operation.fileId) as { path: string } | undefined

        if (currentPathResult && currentPathResult.path !== operation.oldPath) {
          logger.info(LogCategory.FILE_ORGANIZATION, `[一键整理] 文件已被移动，跳过: ${operation.fileId}`, {
            oldPath: operation.oldPath,
            currentPath: currentPathResult.path
          })
          // 文件已被移动，跳过此操作
          return {
            fileId: operation.fileId,
            oldPath: operation.oldPath,
            newPath: operation.newPath,
            inode: 0,
            success: true, // 视为成功
            error: undefined
          }
        }

        // 文件确实不存在
        const errorMessage = `源文件不存在，可能已被删除: ${actualOldPath}`
        logger.warn(LogCategory.FILE_ORGANIZATION, errorMessage, {
          operation,
          dbPath: operation.oldPath
        })
        return {
          fileId: operation.fileId,
          oldPath: operation.oldPath,
          newPath: operation.newPath,
          inode: 0,
          success: false,
          error: errorMessage
        }
      }

      // 3. 获取原始文件的inode
      const oldStats = fs.statSync(actualOldPath)
      const inode = oldStats.ino

      // 3. 移动文件 (如果路径不同)
      if (path.resolve(actualOldPath) !== path.resolve(operation.newPath)) {
        // 确保目标目录存在
        const targetDir = path.dirname(operation.newPath)
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true })
        }
        
        // 执行物理移动
        fs.renameSync(actualOldPath, operation.newPath)
      } else {
        logger.debug(LogCategory.FILE_ORGANIZATION, '源路径与目标路径相同，跳过移动', {
          path: actualOldPath
        })
      }

      // 4. 核心修复：更新数据库中的文件路径记录
      // 调用 databaseService.updateFilePath 会自动处理：
      // - 确保新目录记录存在 (ensureDirectoryRecord)
      // - 迁移路径记录并保持内容指纹关联 (FileDao.updateFilePath)
      // - 迁移 Unit 关联
      const { databaseService } = await import('../database/database-service')
      const oldFileId = await databaseService.addFileFromPath(actualOldPath, '', undefined, true);
      await databaseService.updateFilePath(actualOldPath, operation.newPath)

      const newFileId = await databaseService.addFileFromPath(operation.newPath, '', undefined, true);

      // 5. 验证虚拟目录中的硬链接
      await this.verifyAndFixHardlinks(newFileId as any, operation.newPath, inode)

      logger.debug(LogCategory.FILE_ORGANIZATION, '文件移动及数据库同步成功', {
        oldFileId,
        newFileId,
        oldPath: actualOldPath,
        newPath: operation.newPath
      })

      return {
        fileId: newFileId as any,
        oldPath: actualOldPath,
        newPath: operation.newPath,
        inode,
        success: true
      }
    } catch (error: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, '文件移动失败', {
        operation,
        error: error.message
      })
      return {
        fileId: operation.fileId,
        oldPath: operation.oldPath,
        newPath: operation.newPath,
        inode: 0,
        success: false,
        error: error.message
      }
    }
  }

  /**
   * 创建文件链接，优先使用硬链接，失败时回退到符号链接
   * 用于处理跨分区/跨设备无法创建硬链接的情况（尤其在 WSL2 中常见）
   */
  private createLink(sourcePath: string, targetPath: string): void {
    try {
      // 1. 如果目标路径已存在，先删除
      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath)
      }

      // 2. 优先尝试硬链接
      fs.linkSync(sourcePath, targetPath)
      logger.debug(LogCategory.FILE_ORGANIZATION, '[Organize] 创建硬链接成功:', targetPath)
    } catch (error: any) {
      // 3. 如果硬链接失败（例如 EXDEV: cross-device link），尝试符号链接
      if (error.code === 'EXDEV' || error.code === 'EPERM' || error.code === 'EACCES') {
        try {
          const type = process.platform === 'win32' ? 'file' : undefined
          fs.symlinkSync(sourcePath, targetPath, type)
          logger.info(LogCategory.FILE_ORGANIZATION, '[Organize] 硬链接失败(可能跨分区)，已改用符号链接:', {
            source: sourcePath,
            target: targetPath,
            reason: error.code
          })
        } catch (symlinkError: any) {
          logger.error(LogCategory.FILE_ORGANIZATION, '[Organize] 创建链接失败 (硬链接与符号链接均失败):', {
            target: targetPath,
            error: symlinkError.message
          })
          throw symlinkError
        }
      } else {
        logger.error(LogCategory.FILE_ORGANIZATION, '[Organize] 创建硬链接发生未知错误:', {
          target: targetPath,
          error: error.message
        })
        throw error
      }
    }
  }

  /**
   * 验证并修复虚拟目录中的硬链接
   */
  private async verifyAndFixHardlinks(
    fileId: number,
    newPath: string,
    expectedInode: number
  ): Promise<void> {
    try {
      // 获取该文件在虚拟目录中的所有硬链接
      const virtualLinks = this.getVirtualDirectoryLinks(fileId)

      for (const linkPath of virtualLinks) {
        try {
          if (fs.existsSync(linkPath)) {
            const linkStats = fs.statSync(linkPath)
            if (linkStats.ino !== expectedInode) {
              // 硬链接失效，重新创建
              logger.warn(LogCategory.FILE_ORGANIZATION, '硬链接失效，重新创建', {
                linkPath,
                fileId
              })
              this.createLink(newPath, linkPath)
            }
          } else {
            // 链接不存在，创建
            this.createLink(newPath, linkPath)
          }
        } catch (error: any) {
          logger.error(LogCategory.FILE_ORGANIZATION, '修复硬链接失败', {
            linkPath,
            error: error.message
          })
        }
      }
    } catch (error: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, '验证硬链接时出错', {
        fileId,
        error: error.message
      })
    }
  }

  /**
   * 获取文件在虚拟目录中的硬链接路径
   */
  private getVirtualDirectoryLinks(fileId: number): string[] {
    try {
      // 获取文件的路径
      const file = this.db.prepare('SELECT path, workspace_id FROM workspace_files WHERE id = ?').get(fileId) as any

      if (!file) {
        return []
      }

      // 获取工作目录路径
      const directory = this.db
        .prepare('SELECT path FROM workspaces WHERE workspace_id = ?')
        .get(file.workspace_id) as any

      if (!directory) {
        return []
      }

      const virtualDirRoot = path.join(directory.path, VIRTUAL_DIRECTORY_FOLDER)

      if (!fs.existsSync(virtualDirRoot)) {
        return []
      }

      // 获取文件的inode
      const fileStats = fs.statSync(file.path)
      const targetInode = fileStats.ino

      // 递归搜索虚拟目录中的所有硬链接
      const links: string[] = []

      const searchDirectory = (dirPath: string) => {
        try {
          const entries = fs.readdirSync(dirPath, { withFileTypes: true })

          for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name)

            if (entry.isDirectory()) {
              // 跳过ReadMe文件所在目录，递归搜索子目录
              if (!entry.name.match(/^ReadMe_[a-zA-Z\-]{5}\.txt$/)) {
                searchDirectory(fullPath)
              }
            } else if (entry.isFile()) {
              try {
                const stats = fs.statSync(fullPath)
                // 比较inode，如果相同则是硬链接
                if (stats.ino === targetInode) {
                  links.push(fullPath)
                }
              } catch (error) {
                // 忽略无法访问的文件
              }
            }
          }
        } catch (error) {
          // 忽略无法访问的目录
        }
      }

      searchDirectory(virtualDirRoot)

      logger.debug(LogCategory.FILE_ORGANIZATION, `找到 ${links.length} 个虚拟目录硬链接`, {
        fileId,
        links
      })

      return links
    } catch (error: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, '获取虚拟目录链接失败', {
        fileId,
        error: error.message
      })
      return []
    }
  }

  /**
   * 应用冲突解决方案
   */
  async resolveConflicts(
    fileOperations: FileOperation[],
    conflicts: FileConflict[],
    resolution: ConflictResolutionOptions
  ): Promise<FileOperation[]> {
    try {
      logger.info(LogCategory.FILE_ORGANIZATION, '应用冲突解决方案', {
        conflictCount: conflicts.length,
        action: resolution.action,
        applyToAll: resolution.applyToAll
      })

      const resolvedOperations = [...fileOperations]

      if (resolution.applyToAll) {
        // 应用于所有冲突
        for (const conflict of conflicts) {
          const operation = resolvedOperations.find((op) => op.newPath === conflict.targetPath)
          if (operation) {
            switch (resolution.action) {
              case 'rename':
                operation.newPath = this.generateNewPath(
                  operation.newPath,
                  resolution.renamePattern || 'number'
                )
                break
              case 'skip':
                // 标记为跳过（从列表中移除）
                const index = resolvedOperations.indexOf(operation)
                resolvedOperations.splice(index, 1)
                break
              case 'overwrite':
                // 覆盖：先备份现有文件
                const backupPath = this.createBackup(conflict.existingFile.path)
                logger.info(LogCategory.FILE_ORGANIZATION, '备份现有文件', {
                  original: conflict.existingFile.path,
                  backup: backupPath
                })
                break
            }
          }
        }
      } else {
        // TODO: 逐个处理冲突（需要UI支持）
        // 目前仅支持应用于所有
      }

      return resolvedOperations
    } catch (error: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, '应用冲突解决方案失败', {
        error: error.message
      })
      throw error
    }
  }

  /**
   * 创建文件备份
   */
  private createBackup(filePath: string): string {
    try {
      const dir = path.dirname(filePath)
      const ext = path.extname(filePath)
      const basename = path.basename(filePath, ext)
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').split('T').join('_')
      const backupPath = path.join(dir, `.backup_${basename}_${timestamp}${ext}`)

      fs.copyFileSync(filePath, backupPath)
      return backupPath
    } catch (error: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, '创建备份失败', {
        filePath,
        error: error.message
      })
      throw error
    }
  }

  /**
   * 打开整理后的目录
   */
  async openOrganizedDirectory(directoryPath: string): Promise<void> {
    try {
      await platformAdapter.openPath(directoryPath)
      logger.info(LogCategory.FILE_ORGANIZATION, '打开目录', { directoryPath })
    } catch (error: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, '打开目录失败', {
        directoryPath,
        error: error.message
      })
      throw error
    }
  }

  /**
   * 导出错误日志到文件
   */
  async exportErrorLog(statistics: OrganizeStatistics, outputPath: string): Promise<void> {
    try {
      const log = {
        timestamp: new Date().toISOString(),
        summary: {
          totalFiles: statistics.totalFiles,
          movedFiles: statistics.movedFiles,
          failedFiles: statistics.failedFiles,
          createdDirectories: statistics.createdDirectories,
          elapsedTime: statistics.elapsedTime,
          successRate:
            statistics.totalFiles > 0
              ? ((statistics.movedFiles / statistics.totalFiles) * 100).toFixed(2) + '%'
              : '0%'
        },
        errors: statistics.errors.map((error, index) => ({
          index: index + 1,
          filePath: error.filePath,
          error: error.error
        }))
      }

      const logContent = JSON.stringify(log, null, 2)
      fs.writeFileSync(outputPath, logContent, 'utf-8')

      logger.info(LogCategory.FILE_ORGANIZATION, '导出错误日志成功', { outputPath })
    } catch (error: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, '导出错误日志失败', {
        error: error.message
      })
      throw error
    }
  }

  /**
   * 获取已保存的虚拟目录列表
   */
  async getSavedVirtualDirectories(
    workspaceDirectoryPath: string
  ): Promise<SavedVirtualDirectory[]> {
    try {
      // 使用与 VirtualDirectoryService 相同的查询逻辑
      const directories = this.db
        .prepare(
          `
        SELECT id, name, description, filters, parent_id, workspace_id, created_at, updated_at
        FROM virtual_directories
        WHERE workspace_id = (SELECT workspace_id FROM workspaces WHERE path = ?)
        ORDER BY created_at DESC
      `
        )
        .all(workspaceDirectoryPath) as any[]

      return directories.map((dir) => ({
        id: dir.id,
        name: dir.name,
        description: dir.description || undefined,
        filter: JSON.parse(dir.filters),
        parentId: dir.parent_id || null,
        workspaceId: dir.workspace_id,
        createdAt: new Date(dir.created_at),
        updatedAt: new Date(dir.updated_at)
      }))
    } catch (error: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, '获取已保存的虚拟目录失败', {
        workspaceDirectoryPath,
        error: error.message
      })
      return []
    }
  }

  /**
   * 删除所有虚拟目录及其硬链接
   */
  async deleteAllVirtualDirectories(workspaceDirectoryPath: string): Promise<void> {
    try {
      logger.info(LogCategory.FILE_ORGANIZATION, '开始删除所有虚拟目录', {
        workspaceDirectoryPath
      })

      // 获取虚拟目录根路径
      const virtualDirRoot = path.join(workspaceDirectoryPath, VIRTUAL_DIRECTORY_FOLDER)

      if (fs.existsSync(virtualDirRoot)) {
        // 递归删除虚拟目录文件夹
        fs.rmSync(virtualDirRoot, { recursive: true, force: true })
        logger.info(LogCategory.FILE_ORGANIZATION, '删除虚拟目录文件夹', { virtualDirRoot })
      }

      // 删除数据库中的虚拟目录记录
      this.db
        .prepare('DELETE FROM virtual_directories WHERE directory_path = ?')
        .run(workspaceDirectoryPath)

      logger.info(LogCategory.FILE_ORGANIZATION, '删除虚拟目录记录完成')
    } catch (error: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, '删除虚拟目录失败', {
        error: error.message
      })
      throw error
    }
  }

  /**
   * 获取整理预览信息
   */
  async getOrganizePreview(
    workspaceDirectoryPath: string,
    savedDirectories: SavedVirtualDirectory[]
  ): Promise<{ fileCount: number; directoryStructure: DirectoryNode[] }> {
    try {
      // 参数验证
      if (!savedDirectories || !Array.isArray(savedDirectories)) {
        logger.warn(LogCategory.FILE_ORGANIZATION, '保存的虚拟目录参数无效', {
          savedDirectories
        })
        return {
          fileCount: 0,
          directoryStructure: []
        }
      }

      let totalFileCount = 0
      const directoryStructure: DirectoryNode[] = []

      for (const virtualDir of savedDirectories) {
        const files = await this.getVirtualDirectoryFiles(workspaceDirectoryPath, virtualDir)
        const fileNames = files.map((f) => f.smartName || f.name)

        directoryStructure.push({
          name: virtualDir.name,
          parent: '', // 虚拟目录整理时都是顶级目录
          files: fileNames,
          fileCount: fileNames.length,
        })

        totalFileCount += fileNames.length
      }

      return {
        fileCount: totalFileCount,
        directoryStructure
      }
    } catch (error: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, '获取整理预览失败', {
        error: error.message
      })
      throw error
    }
  }

  /**
   * 获取已分析的文件列表（用于一键整理）
   */
  async getAnalyzedFiles(workspaceDirectoryPath: string): Promise<FileInfoForAI[]> {
    try {
      // 使用原生路径格式查询
      const normalizedPath = path.normalize(workspaceDirectoryPath);
      const pathSep = path.sep;
      
      // 使用路径匹配查询所有已分析的文件（包括子目录）
      // 因为 workspace_id 指向的是文件所在的具体目录，不是工作目录
      const files = this.db
        .prepare(
          `
        SELECT
          wf.id,
          wf.name,
          f.smart_name as smartName,
          wf.path,
          f.type,
          f.description
        FROM workspace_files wf
        INNER JOIN files f ON wf.file_fingerprint = f.file_fingerprint
        WHERE wf.is_analyzed = 1
          AND (wf.path LIKE ? OR wf.path = ?)
      `
        )
        .all(`${normalizedPath}${pathSep}%`, normalizedPath) as any[]

      logger.info(LogCategory.FILE_ORGANIZATION, `[一键整理] 查询到 ${files.length} 个已分析文件（包含所有子目录）`, {
        workspaceDirectoryPath,
        normalizedPath
      })

      // 统计文件分布
      if (files.length > 0) {
        // 按目录层级统计
        const pathDepths = files.map(f => {
          const relativePath = f.path.replace(workspaceDirectoryPath, '').replace(normalizedPath, '')
          const depth = relativePath.split(/[/\\]/).filter(Boolean).length - 1
          return depth
        })
        
        const maxDepth = Math.max(...pathDepths)
        const minDepth = Math.min(...pathDepths)
        
        logger.info(LogCategory.FILE_ORGANIZATION, '[一键整理] 文件分布统计:', {
          totalFiles: files.length,
          maxDepth,
          minDepth,
          samples: files.slice(0, 5).map(f => ({ 
            name: f.name, 
            smartName: f.smartName,
            path: f.path 
          }))
        })
      } else {
        logger.warn(LogCategory.FILE_ORGANIZATION, '[一键整理] 警告：没有找到任何已分析的文件！')
        
        // 调试：查询该路径下所有文件（不管是否已分析）
        const allFiles = this.db
          .prepare(
            `
          SELECT
            wf.id,
            wf.name,
            wf.path,
            wf.is_analyzed
          FROM workspace_files wf
          WHERE wf.path LIKE ? || '%'
             OR REPLACE(wf.path, '\\', '/') LIKE ? || '%'
          LIMIT 20
        `
          )
          .all(workspaceDirectoryPath + '\\', normalizedPath + '/') as any[]
        
        logger.info(LogCategory.FILE_ORGANIZATION, '[一键整理] 该路径下的所有文件（前20个）:', {
          total: allFiles.length,
          files: allFiles.map(f => ({
            name: f.name,
            path: f.path,
            isAnalyzed: f.is_analyzed
          }))
        })
      }

      const filesWithTags: FileInfoForAI[] = []

      for (const file of files) {
        // 获取维度标签
        const dimensionTagsArray = this.db
          .prepare(
            `
          SELECT
            ft.dimension_id as dimension,
            ft.name as tag
          FROM file_tag_relations ftr
          INNER JOIN file_tags ft ON ft.id = ftr.tag_id
          WHERE ftr.file_fingerprint = (SELECT file_fingerprint FROM workspace_files WHERE id = ?)
            AND ft.dimension_id IS NOT NULL
        `
          )
          .all(file.id) as any[]

        // 获取内容标签
        const contentTags = this.db
          .prepare(
            `
          SELECT ft.name
          FROM file_tag_relations ftr
          INNER JOIN file_tags ft ON ft.id = ftr.tag_id
          WHERE ftr.file_fingerprint = (SELECT file_fingerprint FROM workspace_files WHERE id = ?)
            AND ft.dimension_id IS NULL
        `
          )
          .all(file.id) as any[]

        filesWithTags.push({
          id: file.id,
          name: file.name,
          smartName: file.smartName,
          path: file.path,
          type: file.type || '',
          tags: contentTags.map((t) => t.name),
          dimensionTags: dimensionTagsArray.map((t) => ({
            dimension: t.dimension,
            tag: t.tag
          })),
          description: file.description
        })
      }

      logger.info(LogCategory.FILE_ORGANIZATION, `[一键整理] 准备传递给AI的文件数: ${filesWithTags.length}`)

      return filesWithTags
    } catch (error: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, '获取已分析文件失败', {
        error: error.message
      })
      throw error
    }
  }

  /**
   * 生成一键整理方案
   */
  async generateOrganizePlan(
    workspaceDirectoryPath: string,
    options?: QuickOrganizeOptions
  ): Promise<AIDirectoryStructure> {
    try {
      logger.info(LogCategory.FILE_ORGANIZATION, '开始生成一键整理方案', {
        workspaceDirectoryPath,
        options: { ...options, onProgress: undefined } // 避免日志打印函数
      })

      // 获取已分析的文件
      let analyzedFiles = await this.getAnalyzedFiles(workspaceDirectoryPath)

      // 如果提供了特定的文件路径，则只处理这些文件
      if (options?.filePaths && options.filePaths.length > 0) {
        const selectedPaths = new Set(options.filePaths.map(p => path.normalize(p)))
        analyzedFiles = analyzedFiles.filter(f => selectedPaths.has(path.normalize(f.path)))
        logger.info(LogCategory.FILE_ORGANIZATION, `[一键整理] 仅处理选中的 ${analyzedFiles.length} 个文件`)
      }

      if (analyzedFiles.length === 0) {
        throw new Error(options?.filePaths && options.filePaths.length > 0 
          ? t('选中的文件中没有AI分析过的文件，请先进行AI分析')
          : t('当前没有AI分析过的文件，请先在真实目录中勾选文件进行AI分析'))
      }

      logger.info(LogCategory.FILE_ORGANIZATION, `[一键整理] 将处理 ${analyzedFiles.length} 个文件`, {
        fileNames: analyzedFiles.map(f => f.smartName || f.name)
      })

      // 1. 准备维度信息 (如果options未提供)
      let dimensionInfo = options?.dimensionInfo
      if (!dimensionInfo) {
        try {
          // 获取所有维度
          const dimensions = this.db.prepare('SELECT id, name, level, tags, trigger_conditions FROM file_dimensions ORDER BY level ASC').all() as any[]
          
          // 获取泛维度配置
          const panDimensionIds = (configService.getValue<number[]>('PAN_DIMENSION_IDS') || [])
          const panIdSet = new Set(panDimensionIds)

          // 提取特殊维度（如“题材”）进行共享定义，避免重复展开
          const specialDimensions = ['题材']
          let sharedDefinitions = ''
          const extractedDimNames = new Set<string>()

          for (const dimName of specialDimensions) {
             const dim = dimensions.find(d => d.name === dimName)
             if (dim) {
                const tags = dim.tags ? JSON.parse(dim.tags) : []
                if (tags.length > 0) {
                   sharedDefinitions += `${dimName}目录集合 = [${tags.join(',')}]`
                   extractedDimNames.add(dimName)
                }
             }
          }

          // 格式化维度信息 (改为树状结构)
          // 顶级维度入口：Level 为 1
          const baseDimensions = dimensions.filter(d => d.level === 1)
          const potentialSubDimensions = dimensions.filter(d => d.level > 1)

          // 辅助函数：获取被特定父维度标签触发的子维度
          const getTriggeredDimensions = (parentDimName: string, tagName: string) => {
             return potentialSubDimensions.filter(d => {
                try {
                    // 1. 优先尝试数据库中的触发条件
                    const triggers = d.trigger_conditions ? JSON.parse(d.trigger_conditions) : []
                    if (Array.isArray(triggers) && triggers.length > 0) {
                        return triggers.some((t: any) => t.parentDimension === parentDimName && t.triggerTags.includes(tagName))
                    }
                } catch (e) { /* ignore */ }

                // 2. 启发式回退：如果维度名称包含标签名称 (如 "视频细分" 包含 "视频") 
                // 且该维度是针对其父类的细分
                if (d.name.includes(tagName) && d.level > 1) {
                    return true
                }
                return false
             })
          }

          const allDirectoryGroups: { name: string[], parent: string }[] = []
          const dimensionMap: Record<string, string> = {}
          const topLevelDirs: string[] = []

          // 递归收集目录结构
          const collectDirectories = (dim: any, parentTag: string = '', depth: number = 0) => {
             if (depth > 5) return 

             const isPan = panIdSet.has(dim.id)
             const safeParent = parentTag || ""

             // 1. 如果是已提取的共享维度
             if (extractedDimNames.has(dim.name)) {
                allDirectoryGroups.push({
                    name: [`{${dim.name}目录集合}`],
                    parent: safeParent
                })
                
                const tags = dim.tags ? JSON.parse(dim.tags) : []
                tags.forEach((tag: string) => {
                    if (safeParent) {
                        dimensionMap[tag] = safeParent
                    } else {
                        topLevelDirs.push(tag)
                    }
                })
                return
             }

             // 2. 如果是泛维度
             if (isPan) {
                allDirectoryGroups.push({
                    name: [`<${dim.name}>`],
                    parent: safeParent
                })
                return
             }

             // 3. 处理标准维度
             const tags = dim.tags ? JSON.parse(dim.tags) : []
             const tagsToShow = tags.slice(0, 20)
             const displayTags = [...tagsToShow]
             
             if (tags.length > 20) {
                displayTags.push(`... (共${tags.length}个标签)`)
             }

             if (displayTags.length > 0) {
                 allDirectoryGroups.push({
                     name: displayTags,
                     parent: safeParent
                 })
                 
                 tags.forEach((tag: string) => {
                     if (safeParent) {
                         dimensionMap[tag] = safeParent
                     } else {
                         topLevelDirs.push(tag)
                     }
                 })
             }

             // 4. 递归处理由当前维度标签触发的子维度
             for (const tag of tagsToShow) {
                const subDims = getTriggeredDimensions(dim.name, tag)
                for (const subDim of subDims) {
                    collectDirectories(subDim, tag, depth + 1)
                }
             }
          }

          // 从基础维度 (Level 1) 开始收集
          for (const dim of baseDimensions) {
              collectDirectories(dim, "")
          }

          const treeDesc = encode({ directories: allDirectoryGroups })

          dimensionInfo = `
#### 共享目录定义
${sharedDefinitions}

#### 参考目录和层级结构
可以从中选取个别name作为目录，所择name必须匹配文件名，否则不能选择。
${treeDesc}
`
          logger.info(LogCategory.FILE_ORGANIZATION, '[一键整理] 自动注入维度信息', { length: dimensionInfo.length })
          
          // 将生成的映射表保存到 options 中以便传递给 QuickOrganizeService
          if (!options) options = {}
          options.dimensionMap = dimensionMap
          options.topLevelDirs = topLevelDirs
        } catch (error: any) {
          logger.warn(LogCategory.FILE_ORGANIZATION, '[一键整理] 自动获取维度信息失败', { error: error.message })
        }
      }

      // 2. 准备目录分析信息 (如果options未提供)
      let directoryAnalysis = options?.directoryAnalysis
      if (!directoryAnalysis) {
        try {
           const dirResult = this.db.prepare(`
             SELECT context_analysis FROM workspace_directories 
             WHERE path = ? OR REPLACE(path, '\\', '/') = REPLACE(?, '\\', '/')
           `).get(workspaceDirectoryPath, workspaceDirectoryPath) as any
           if (dirResult && dirResult.context_analysis) {
             const analysis = JSON.parse(dirResult.context_analysis)

             // 转换为 QuickOrganizeOptions 需要的格式
             // 注意: 数据库里的字段可能和 Options 定义的不完全一致，需要适配
             if (analysis.directoryType) {
               directoryAnalysis = {
                 directoryType: analysis.directoryType,
                 recommendedDimensions: analysis.recommendedDimensions || [],
                 recommendedTags: analysis.recommendedTags || {},
                 analysisStrategy: analysis.analysisStrategy || '标准策略',
                 namingPattern: analysis.namingPattern || '序号_内容描述',
                 confidence: analysis.confidence || 0.5
               }
               logger.info(LogCategory.FILE_ORGANIZATION, '[一键整理] 自动注入目录分析信息', { type: directoryAnalysis.directoryType })
             }
           }
        } catch (error: any) {
           logger.warn(LogCategory.FILE_ORGANIZATION, '[一键整理] 自动获取目录分析信息失败', { error: error.message })
        }
      }

      // 3. 获取模型上下文长度（用于动态计算批次大小）
      const { createCoreEngineAdapters } = await import('../../adapters')
      const adapters = await createCoreEngineAdapters()

      const aiServiceMode = configService.getValue<string>('AI_SERVICE_MODE') || 'local'
      const contextLength = await adapters.aiHelper.getMaxContentLength()
      let historyWindowSize = 10 // 默认为本地模型的小窗口
      if (aiServiceMode === 'cloud') {
        historyWindowSize = 100
      }

      logger.info(LogCategory.FILE_ORGANIZATION, `[一键整理] 使用 AIHelper 计算出的可用字符长度: ${contextLength} (模式: ${aiServiceMode})`)

      // 获取配置中的 AI 参数
      const batchSize = configService.getValue<number>('QUEUE_BATCH_SIZE') || 10
      const temperature = configService.getValue<number>('MODEL_TEMPERATURE') || 0.3


      // 调用一键整理服务生成方案
      const quickOrganizeService = await this.getQuickOrganizeService()
      const structure = await quickOrganizeService.generateOrganizePlan(
        analyzedFiles,
        { 
          batchSize,
          temperature,
          maxTokens: 4096, // 触发 HttpClient 实时动态计算
          contextLength,
          historyWindowSize, // 注入滑动窗口大小
          dimensionInfo,     // 注入
          directoryAnalysis, // 注入
          ...options 
        }
      )

      // 统计最终结构中的文件数
      const totalFilesInStructure = structure.directories.reduce(
        (sum, dir) => sum + (dir.files?.length || 0),
        0
      )

      logger.info(LogCategory.FILE_ORGANIZATION, '一键整理方案生成完成', {
        inputFileCount: analyzedFiles.length,
        outputFileCount: totalFilesInStructure,
        directoryCount: structure.directories.length
      })

      if (totalFilesInStructure !== analyzedFiles.length) {
        logger.warn(LogCategory.FILE_ORGANIZATION, `[一键整理] 警告: 输入文件数(${analyzedFiles.length})与输出文件数(${totalFilesInStructure})不匹配！`)
      }

      return structure
    } catch (error: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, '生成一键整理方案失败', {
        error: error.message
      })
      throw error
    }
  }

  /**
   * 快速整理真实目录（AI驱动）
   * @deprecated 使用 generateOrganizePlan + quickOrganize 组合
   */
  async quickOrganize(
    workspaceDirectoryPath: string,
    aiGeneratedStructure: AIDirectoryStructure
  ): Promise<OrganizeStatistics> {
    const startTime = Date.now()
    const statistics: OrganizeStatistics = {
      totalFiles: 0,
      movedFiles: 0,
      failedFiles: 0,
      createdDirectories: 0,
      elapsedTime: 0,
      errors: []
    }

    try {
      logger.info(LogCategory.FILE_ORGANIZATION, '开始快速整理真实目录', {
        workspaceDirectoryPath,
        directoryCount: aiGeneratedStructure.directories.length
      })

      const processedFileIds = new Set<number>()

      // 构建目录路径映射（从目录名到完整路径）
      const buildDirectoryPaths = (directories: DirectoryNode[]): Map<string, string> => {
        const pathMap = new Map<string, string>()

        // 先处理所有顶级目录（parent为空）
        for (const dir of directories) {
          if (!dir.parent || dir.parent === '') {
            pathMap.set(dir.name, dir.name)
          }
        }

        // 迭代处理子目录，直到所有目录都有路径
        let maxIterations = 10 // 最多3层，10次迭代足够
        let lastProcessedCount = 0

        while (maxIterations > 0 && pathMap.size < directories.length) {
          for (const dir of directories) {
            // 跳过已处理的目录
            if (pathMap.has(dir.name)) {
              continue
            }

            // 如果父目录已有路径，构建当前目录路径
            if (dir.parent && pathMap.has(dir.parent)) {
              const parentPath = pathMap.get(dir.parent)!
              pathMap.set(dir.name, path.join(parentPath, dir.name))
            }
          }

          // 如果没有新的目录被处理，避免死循环
          if (pathMap.size === lastProcessedCount) {
            break
          }
          lastProcessedCount = pathMap.size
          maxIterations--
        }

        return pathMap
      }

      const directoryPaths = buildDirectoryPaths(aiGeneratedStructure.directories)

      // 构建文件名到目标路径的映射（不查询源路径，只记录目标路径）
      const fileNameToTargetPath = new Map<string, string>()
      const fileOperations: { fileId: number, fileName: string, targetPath: string, smartName: string }[] = []

      // 遍历所有目录，创建目录并记录文件目标路径
      for (const dir of aiGeneratedStructure.directories) {
        const relativePath = directoryPaths.get(dir.name)
        if (!relativePath) {
          logger.warn(LogCategory.FILE_ORGANIZATION, '无法构建目录路径', {
            dirName: dir.name,
            parent: dir.parent
          })
          continue
        }

        const targetDirPath = path.join(workspaceDirectoryPath, relativePath)

        // 创建目录
        this.ensureDirectoryExists(targetDirPath)
        statistics.createdDirectories++

        // 记录文件目标路径（只记录文件名和目标路径，不查询源路径）
        if (dir.files) {
          for (const fileItem of dir.files) {
            const fileName = typeof fileItem === 'string' ? fileItem : fileItem.name
            
            // 跳过重复文件
            const existingFile = this.db.prepare(
              'SELECT wf.id, f.smart_name as smartName FROM workspace_files wf INNER JOIN files f ON wf.file_fingerprint = f.file_fingerprint WHERE wf.name = ? AND wf.is_analyzed = 1 AND wf.workspace_id = (SELECT workspace_id FROM workspaces WHERE path = ?) LIMIT 1'
            ).get(fileName, workspaceDirectoryPath) as { id: number, smartName: string } | undefined

            if (!existingFile) {
              logger.warn(LogCategory.FILE_ORGANIZATION, '找不到文件信息', { fileName })
              continue
            }

            if (processedFileIds.has(existingFile.id)) {
              logger.warn(LogCategory.FILE_ORGANIZATION, '文件重复，跳过', {
                fileId: existingFile.id,
                fileName
              })
              continue
            }
            processedFileIds.add(existingFile.id)

            const targetPath = path.join(targetDirPath, existingFile.smartName)
            
            fileOperations.push({
              fileId: existingFile.id,
              fileName,
              targetPath,
              smartName: existingFile.smartName
            })
          }
        }
      }
      statistics.totalFiles = fileOperations.length

      // 检测文件冲突
      const conflicts = this.detectConflicts(fileOperations.map(op => ({
        fileId: op.fileId,
        oldPath: '', // 执行时才会填充
        newPath: op.targetPath,
        smartName: op.smartName
      })))
      if (conflicts.length > 0) {
        logger.warn(LogCategory.FILE_ORGANIZATION, `检测到 ${conflicts.length} 个文件冲突`)
        // 使用默认的重命名策略
        for (const conflict of conflicts) {
          const operation = fileOperations.find((op) => op.targetPath === conflict.targetPath)
          if (operation) {
            operation.targetPath = this.generateNewPath(operation.targetPath, 'number')
          }
        }
      }

      // 执行文件移动（对每个文件，执行时才查询数据库获取当前最新路径）
      for (const op of fileOperations) {
          // 执行时从数据库获取文件的当前最新路径
          const currentFileInfo = this.db.prepare(
            'SELECT wf.path, f.smart_name as smartName FROM workspace_files wf INNER JOIN files f ON wf.file_fingerprint = f.file_fingerprint WHERE wf.id = ?'
          ).get(op.fileId) as { path: string, smartName: string } | undefined

          if (!currentFileInfo) {
            logger.warn(LogCategory.FILE_ORGANIZATION, `[一键整理] 文件已被删除或不属于当前工作空间: ${op.fileId}`)
            statistics.failedFiles++
            statistics.errors.push({
              filePath: op.fileName,
              error: `文件已被删除或不属于当前工作空间`
            })
            continue
          }

          // 构建文件操作对象
          let operation: FileOperation | null = null;
          try {
            operation = {
              fileId: op.fileId,
              oldPath: currentFileInfo.path,
              newPath: op.targetPath,
              smartName: currentFileInfo.smartName
            }

            const result = await this.organizeFileWithHardlinks(operation)
            if (result.success) {
              statistics.movedFiles++
            } else {
              statistics.failedFiles++
              statistics.errors.push({
                filePath: operation.oldPath,
                error: result.error || '未知错误'
              })
            }
          } catch (error: any) {
            statistics.failedFiles++
            statistics.errors.push({
              filePath: operation?.oldPath || op.fileName,
              error: error.message
            })
            logger.error(LogCategory.FILE_ORGANIZATION, '文件移动失败', {
              operation,
              error: error.message
            })
          }
        }

      statistics.elapsedTime = Date.now() - startTime

      logger.info(LogCategory.FILE_ORGANIZATION, '快速整理完成', statistics)

      return statistics
    } catch (error: any) {
      statistics.elapsedTime = Date.now() - startTime
      logger.error(LogCategory.FILE_ORGANIZATION, '快速整理过程出错', {
        error: error.message,
        statistics
      })
      throw error
    }
  }

  private async _deleteVirtualDirectory(id: string, workspaceDirectoryPath: string): Promise<void> {
    try {
      const dirInfo = this.db
        .prepare('SELECT filters FROM virtual_directories WHERE id = ?')
        .get(id) as any

      this.db.prepare('DELETE FROM virtual_directories WHERE id = ?').run(id)

      if (dirInfo) {
        const filters = JSON.parse(dirInfo.filters)
        await this._deleteTopLevelTagDirectory(workspaceDirectoryPath, filters.selectedTags)
      }
      logger.info(LogCategory.FILE_ORGANIZATION, '虚拟目录已删除', { id })
    } catch (error: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, '删除虚拟目录失败', { id, error: error.message })
      // Do not re-throw, as the main operation (file moving) was successful.
    }
  }

  private async _deleteTopLevelTagDirectory(
    workspaceDirectoryPath: string,
    selectedTags: unknown[]
  ): Promise<void> {
    try {
      const virtualDirPath = path.join(workspaceDirectoryPath, VIRTUAL_DIRECTORY_FOLDER)

      if (!fs.existsSync(virtualDirPath)) {
        return
      }

      if (!selectedTags || selectedTags.length === 0) {
        return
      }

      const allVirtualDirectories = this.db
        .prepare(
          `
          SELECT filters FROM virtual_directories
          WHERE workspace_id = (SELECT workspace_id FROM workspaces WHERE path = ?)
        `
        )
        .all(workspaceDirectoryPath) as unknown[]

      const otherTagChains: string[][] = allVirtualDirectories.map((dir: any) => {
        const filters = JSON.parse(dir.filters)
        return filters.selectedTags.map((tag: any) => tag.tagValue)
      })

      const tagChain = (selectedTags as any[]).map((tag: any) => tag.tagValue)

      await this._deleteTagChainRecursively(virtualDirPath, tagChain, otherTagChains)
    } catch (error: unknown) {
      logger.error(
        LogCategory.VIRTUAL_DIRECTORY,
        '[VirtualDirectory] 删除tag目录链失败:',
        error
      )
    }
  }

  private async _deleteTagChainRecursively(
    virtualDirPath: string,
    tagChain: string[],
    otherTagChains: string[][]
  ): Promise<void> {
    if (tagChain.length === 0) {
      return
    }

    const currentPath = path.join(virtualDirPath, ...tagChain)

    if (!fs.existsSync(currentPath)) {
      return
    }

    const isUsedByOthers = otherTagChains.some((otherChain) => {
      if (otherChain.length < tagChain.length) {
        return false
      }
      return tagChain.every((tag, index) => tag === otherChain[index])
    })

    if (isUsedByOthers) {
      return
    }

    fs.rmSync(currentPath, { recursive: true, force: true })

    const parentTagChain = tagChain.slice(0, -1)
    if (parentTagChain.length > 0) {
      await this._deleteTagChainRecursively(virtualDirPath, parentTagChain, otherTagChains)
    }
  }
}
