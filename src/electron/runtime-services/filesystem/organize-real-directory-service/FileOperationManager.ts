import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { FileOperation, FileOrganizeResult } from '@firefly/types/organize-types'
import { LogCategory, logger, isPathEqual } from '@firefly/shared'

const VIRTUAL_DIRECTORY_FOLDER = '.VirtualDirectory'

export class FileOperationManager {
  constructor(private db: Database.Database) {}

  async organizeFileWithHardlinks(operation: FileOperation): Promise<FileOrganizeResult> {
    try {
      const actualOldPath = operation.oldPath

      if (!fs.existsSync(actualOldPath)) {
        if (fs.existsSync(operation.newPath)) {
          logger.info(
            LogCategory.FILE_ORGANIZATION,
            `[一键整理] 文件已在目标路径存在（可能被其他虚拟目录移动），跳过: ${operation.oldPath}`,
            {
              newPath: operation.newPath
            }
          )
          return {
            fileId: operation.fileId,
            oldPath: operation.oldPath,
            newPath: operation.newPath,
            inode: 0,
            success: true,
            error: undefined
          }
        }

        const currentPathResult = this.db
          .prepare('SELECT path FROM workspace_files WHERE id = ?')
          .get(operation.fileId) as { path: string } | undefined

        if (currentPathResult && !isPathEqual(currentPathResult.path, operation.oldPath)) {
          logger.info(
            LogCategory.FILE_ORGANIZATION,
            `[一键整理] 文件已被移动，跳过: ${operation.fileId}`,
            {
              oldPath: operation.oldPath,
              currentPath: currentPathResult.path
            }
          )
          return {
            fileId: operation.fileId,
            oldPath: operation.oldPath,
            newPath: operation.newPath,
            inode: 0,
            success: true,
            error: undefined
          }
        }

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

      const oldStats = fs.statSync(actualOldPath)
      const inode = oldStats.ino

      if (actualOldPath !== operation.newPath) {
        const targetDir = path.dirname(operation.newPath)
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true })
        }

        fs.renameSync(actualOldPath, operation.newPath)
      } else {
        logger.debug(LogCategory.FILE_ORGANIZATION, '源路径与目标路径相同，跳过移动', {
          path: actualOldPath
        })
      }

      const { databaseService } = await import('../../database/database-service')
      await databaseService.addFileFromPath(actualOldPath, '', undefined, true)
      await databaseService.updateFilePath(actualOldPath, operation.newPath)
      const newFileId = await databaseService.addFileFromPath(
        operation.newPath,
        '',
        undefined,
        true
      )

      await this.verifyAndFixHardlinks(newFileId as any, operation.newPath, inode)

      logger.debug(LogCategory.FILE_ORGANIZATION, '文件移动及数据库同步成功', {
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

  createLink(sourcePath: string, targetPath: string): void {
    try {
      if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath)
      }
      fs.linkSync(sourcePath, targetPath)
      logger.debug(LogCategory.FILE_ORGANIZATION, '[Organize] 创建硬链接成功:', targetPath)
    } catch (error: any) {
      if (error.code === 'EXDEV' || error.code === 'EPERM' || error.code === 'EACCES') {
        try {
          const type = process.platform === 'win32' ? 'file' : undefined
          fs.symlinkSync(sourcePath, targetPath, type)
          logger.info(
            LogCategory.FILE_ORGANIZATION,
            '[Organize] 硬链接失败(可能跨分区)，已改用符号链接:',
            {
              source: sourcePath,
              target: targetPath,
              reason: error.code
            }
          )
        } catch (symlinkError: any) {
          logger.error(
            LogCategory.FILE_ORGANIZATION,
            '[Organize] 创建链接失败 (硬链接与符号链接均失败):',
            {
              target: targetPath,
              error: symlinkError.message
            }
          )
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

  async verifyAndFixHardlinks(
    fileId: number,
    newPath: string,
    expectedInode: number
  ): Promise<void> {
    try {
      const virtualLinks = this.getVirtualDirectoryLinks(fileId)

      for (const linkPath of virtualLinks) {
        try {
          if (fs.existsSync(linkPath)) {
            const linkStats = fs.statSync(linkPath)
            if (linkStats.ino !== expectedInode) {
              logger.warn(LogCategory.FILE_ORGANIZATION, '硬链接失效，重新创建', {
                linkPath,
                fileId
              })
              this.createLink(newPath, linkPath)
            }
          } else {
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

  getVirtualDirectoryLinks(fileId: number): string[] {
    try {
      const file = this.db
        .prepare('SELECT path, workspace_id FROM workspace_files WHERE id = ?')
        .get(fileId) as any

      if (!file) return []

      const directory = this.db
        .prepare('SELECT path FROM workspaces WHERE workspace_id = ?')
        .get(file.workspace_id) as any

      if (!directory) return []

      const virtualDirRoot = path.join(directory.path, VIRTUAL_DIRECTORY_FOLDER)
      if (!fs.existsSync(virtualDirRoot)) return []

      const fileStats = fs.statSync(file.path)
      const targetInode = fileStats.ino
      const links: string[] = []

      const searchDirectory = (dirPath: string) => {
        try {
          const entries = fs.readdirSync(dirPath, { withFileTypes: true })
          for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name)
            if (entry.isDirectory()) {
              if (!entry.name.match(/^ReadMe_[a-zA-Z\\-]{5}\\.txt$/)) {
                searchDirectory(fullPath)
              }
            } else if (entry.isFile()) {
              try {
                const stats = fs.statSync(fullPath)
                if (stats.ino === targetInode) {
                  links.push(fullPath)
                }
              } catch (error) {
                logger.warn(LogCategory.FILE_ORGANIZATION, '统计文件 inode 失败:', fullPath, error)
              }
            }
          }
        } catch (error) {
          logger.warn(LogCategory.FILE_ORGANIZATION, '搜索目录中查找链接失败:', error)
        }
      }

      searchDirectory(virtualDirRoot)
      return links
    } catch (error: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, '获取虚拟目录链接失败', {
        fileId,
        error: error.message
      })
      return []
    }
  }

  createBackup(filePath: string): string {
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

  ensureDirectoryExists(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true })
      logger.debug(LogCategory.FILE_ORGANIZATION, '创建目录', { dirPath })
    }
  }

  async _deleteVirtualDirectory(id: string, workspaceDirectoryPath: string): Promise<void> {
    try {
      const dirInfo = this.db
        .prepare('SELECT filters FROM analyzed_directories WHERE id = ?')
        .get(id) as any

      this.db.prepare('DELETE FROM analyzed_directories WHERE id = ?').run(id)

      if (dirInfo) {
        const filters = JSON.parse(dirInfo.filters)
        await this._deleteTopLevelTagDirectory(workspaceDirectoryPath, filters.selectedTags)
      }
      logger.info(LogCategory.FILE_ORGANIZATION, '虚拟目录已删除', { id })
    } catch (error: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, '删除虚拟目录失败', { id, error: error.message })
    }
  }

  async _deleteTopLevelTagDirectory(
    workspaceDirectoryPath: string,
    selectedTags: any[]
  ): Promise<void> {
    try {
      const virtualDirPath = path.join(workspaceDirectoryPath, VIRTUAL_DIRECTORY_FOLDER)

      if (!fs.existsSync(virtualDirPath)) return
      if (!selectedTags || selectedTags.length === 0) return

      const allVirtualDirectories = this.db
        .prepare(
          `SELECT filters FROM analyzed_directories WHERE workspace_id = (SELECT workspace_id FROM workspaces WHERE path = ?)`
        )
        .all(workspaceDirectoryPath) as any[]

      const otherTagChains: string[][] = allVirtualDirectories.map((dir: any) => {
        const filters = JSON.parse(dir.filters)
        return filters.selectedTags.map((tag: any) => tag.tagValue)
      })

      const tagChain = (selectedTags as any[]).map((tag: any) => tag.tagValue)
      await this._deleteTagChainRecursively(virtualDirPath, tagChain, otherTagChains)
    } catch (error: any) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '[VirtualDirectory] 删除tag目录链失败:', error)
    }
  }

  private async _deleteTagChainRecursively(
    virtualDirPath: string,
    tagChain: string[],
    otherTagChains: string[][]
  ): Promise<void> {
    if (tagChain.length === 0) return

    const currentPath = path.join(virtualDirPath, ...tagChain)
    if (!fs.existsSync(currentPath)) return

    const isUsedByOthers = otherTagChains.some(otherChain => {
      if (otherChain.length < tagChain.length) return false
      return tagChain.every((tag, index) => tag === otherChain[index])
    })

    if (isUsedByOthers) return

    fs.rmSync(currentPath, { recursive: true, force: true })
    const parentTagChain = tagChain.slice(0, -1)
    if (parentTagChain.length > 0) {
      await this._deleteTagChainRecursively(virtualDirPath, parentTagChain, otherTagChains)
    }
  }
}
