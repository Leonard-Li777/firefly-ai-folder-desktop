import { FileItem, SavedVirtualDirectory, SelectedTag } from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'

import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

const VIRTUAL_DIRECTORY_FOLDER = '.VirtualDirectory'
const THUMBNAIL_FOLDER = '.thumbnail'

export class LinkManager {
  constructor(
    private db: Database.Database,
    private getFilteredFiles: (params: any) => Promise<FileItem[]>,
    private copyReadmeFile: (virtualDirPath: string) => Promise<void>
  ) {}

  /**
   * 创建/更新虚拟目录的物理结构（硬链接）
   */
  async createVirtualDirectoryStructure(
    workspaceDirectoryPath: string,
    directory: SavedVirtualDirectory
  ): Promise<void> {
    try {
      const virtualDirPath = path.join(workspaceDirectoryPath, VIRTUAL_DIRECTORY_FOLDER)
      if (!fs.existsSync(virtualDirPath)) fs.mkdirSync(virtualDirPath, { recursive: true })

      // 复制 ReadMe 说明文件（如果目录中没有）
      if (!fs.readdirSync(virtualDirPath).some(file => file.startsWith('ReadMe_'))) {
        await this.copyReadmeFile(virtualDirPath)
      }

      const tagChain = directory.filter.selectedTags.map((tag: any) => tag.tagValue)

      // 清理冗余的父目录条目（更短的 tagChain 被当前 tagChain 包含时）
      const allDirectories = this.db
        .prepare('SELECT id, filters FROM analyzed_directories WHERE id != ?')
        .all(directory.id) as any[]
      for (const dir of allDirectories) {
        const otherTagChain = JSON.parse(dir.filters).selectedTags.map((tag: any) => tag.tagValue)
        if (
          otherTagChain.length < tagChain.length &&
          otherTagChain.every((tag: string, index: number) => tag === tagChain[index])
        ) {
          this.db.prepare('DELETE FROM analyzed_directories WHERE id = ?').run(dir.id)
        }
      }

      // 清理当前标签路径（如果已存在）
      if (directory.filter.selectedTags.length > 0) {
        const tagPath = path.join(virtualDirPath, ...tagChain)
        if (fs.existsSync(tagPath)) fs.rmSync(tagPath, { recursive: true, force: true })
      }

      // 创建分层硬链接
      await this.createHierarchicalHardLinks(
        virtualDirPath,
        directory.filter.selectedTags,
        directory.filter.sortBy,
        directory.filter.sortOrder,
        workspaceDirectoryPath
      )

      // 清理其他虚拟目录中的重复文件
      const currentFiles = await this.getFilteredFiles({
        selectedTags: directory.filter.selectedTags,
        sortBy: directory.filter.sortBy,
        sortOrder: directory.filter.sortOrder,
        workspaceDirectoryPath
      })
      await this.cleanupFilesInOtherVirtualDirectories(
        virtualDirPath,
        currentFiles,
        tagChain,
        workspaceDirectoryPath
      )

      // 清理空目录
      await this.cleanupEmptyDirectories(virtualDirPath)
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '导出虚拟目录结构失败:', error)
      throw error
    }
  }

  /**
   * 创建分层硬链接（含去重）
   */
  private async createHierarchicalHardLinks(
    virtualDirPath: string,
    selectedTags: SelectedTag[],
    sortBy: any,
    sortOrder: 'asc' | 'desc',
    workspaceDirectoryPath?: string
  ): Promise<void> {
    try {
      for (let level = 1; level <= selectedTags.length; level++) {
        const levelTags = selectedTags.slice(0, level)
        const files = await this.getFilteredFiles({
          selectedTags: levelTags,
          sortBy,
          sortOrder,
          workspaceDirectoryPath
        })
        for (const file of files) {
          await this.createHardLinkAtLevel(virtualDirPath, file, levelTags)
        }
      }
      // 从底部向上去除重复硬链接（深层目录中的文件在父目录中也存在时，删除父目录中的重复项）
      await this.deduplicateHardLinksFromBottom(virtualDirPath, selectedTags)
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '创建分层硬链接失败:', error)
      throw error
    }
  }

  /**
   * 在指定层级创建单个文件的硬链接
   */
  private async createHardLinkAtLevel(
    virtualDirPath: string,
    file: FileItem,
    levelTags: SelectedTag[]
  ): Promise<void> {
    try {
      const tagPath = levelTags.map(t => t.tagValue).join(path.sep)
      const fullDirPath = path.join(virtualDirPath, tagPath)
      if (!fs.existsSync(fullDirPath)) fs.mkdirSync(fullDirPath, { recursive: true })

      const fileName = this.getFileNameWithSmartName(file)
      this.createLink(file.path, path.join(fullDirPath, fileName))
    } catch (error) {
      logger.warn(LogCategory.FILE_ORGANIZATION, '添加链接文件到虚拟目录失败:', error)
    }
  }

  /**
   * 创建硬链接，失败时降级为符号链接
   */
  createLink(sourcePath: string, targetPath: string): void {
    try {
      if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath)
      fs.linkSync(sourcePath, targetPath)
    } catch (error: any) {
      if (error.code === 'EXDEV' || error.code === 'EPERM' || error.code === 'EACCES') {
        try {
          const type = process.platform === 'win32' ? 'file' : undefined
          fs.symlinkSync(sourcePath, targetPath, type)
        } catch (symlinkError: any) {
          throw symlinkError
        }
      } else throw error
    }
  }

  /**
   * 从底部向上去除重复硬链接
   */
  private async deduplicateHardLinksFromBottom(
    virtualDirPath: string,
    selectedTags: SelectedTag[]
  ): Promise<void> {
    try {
      for (let deepLevel = selectedTags.length; deepLevel > 1; deepLevel--) {
        const deepPath = path.join(
          virtualDirPath,
          ...selectedTags.slice(0, deepLevel).map(t => t.tagValue)
        )
        if (!fs.existsSync(deepPath)) continue
        const deepFiles = this.getAllFilesInDirectory(deepPath)
        for (const deepFilePath of deepFiles) {
          const fileName = path.basename(deepFilePath)
          const deepStat = fs.statSync(deepFilePath)
          for (let parentLevel = 1; parentLevel < deepLevel; parentLevel++) {
            const parentPath = path.join(
              virtualDirPath,
              ...selectedTags.slice(0, parentLevel).map(t => t.tagValue)
            )
            const parentFilePath = path.join(parentPath, fileName)
            if (fs.existsSync(parentFilePath)) {
              try {
                if (fs.statSync(parentFilePath).ino === deepStat.ino) fs.unlinkSync(parentFilePath)
              } catch (error) {
                logger.warn(LogCategory.FILE_ORGANIZATION, '清理父级目录中重复链接失败:', error)
              }
            }
          }
        }
      }
    } catch (error) {
      logger.warn(LogCategory.FILE_ORGANIZATION, '清理冗余链接过程中发生异常:', error)
    }
  }

  /**
   * 递归获取目录下所有文件
   */
  private getAllFilesInDirectory(dirPath: string): string[] {
    const files: string[] = []
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)
        if (entry.isDirectory()) files.push(...this.getAllFilesInDirectory(fullPath))
        else if (entry.isFile() && !/^ReadMe_[a-zA-Z\-]{5}\.txt$/.test(entry.name))
          files.push(fullPath)
      }
    } catch (error) {
      logger.warn(LogCategory.FILE_ORGANIZATION, '获取目录下所有文件失败:', error)
    }
    return files
  }

  /**
   * 清理其他虚拟目录中重复的硬链接文件
   */
  private async cleanupFilesInOtherVirtualDirectories(
    virtualDirPath: string,
    currentFiles: FileItem[],
    currentTagChain: string[],
    workspaceDirectoryPath?: string
  ): Promise<void> {
    try {
      const allDirectories = this.db
        .prepare(
          'SELECT filters FROM analyzed_directories WHERE workspace_id = (SELECT id FROM workspace_directories WHERE path = ?)'
        )
        .all(workspaceDirectoryPath || '') as any[]

      const otherTagChains: string[][] = allDirectories
        .map(dir => JSON.parse(dir.filters).selectedTags.map((tag: any) => tag.tagValue))
        .filter(chain => JSON.stringify(chain) !== JSON.stringify(currentTagChain))

      if (otherTagChains.length === 0) return

      for (const file of currentFiles) {
        const fileName = this.getFileNameWithSmartName(file)
        const fileStat = fs.statSync(file.path)
        for (const otherTagChain of otherTagChains) {
          for (let level = 1; level <= otherTagChain.length; level++) {
            const otherFilePath = path.join(
              virtualDirPath,
              otherTagChain.slice(0, level).join(path.sep),
              fileName
            )
            if (fs.existsSync(otherFilePath)) {
              try {
                if (fs.statSync(otherFilePath).ino === fileStat.ino) fs.unlinkSync(otherFilePath)
              } catch (error) {
                logger.warn(
                  LogCategory.FILE_ORGANIZATION,
                  '清理其他虚拟目录中重复硬链接失败:',
                  error
                )
              }
            }
          }
        }
      }
    } catch (error) {
      logger.warn(LogCategory.FILE_ORGANIZATION, '清理其他虚拟目录失败:', error)
    }
  }

  /**
   * 递归清理空目录
   */
  async cleanupEmptyDirectories(dirPath: string): Promise<boolean> {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== THUMBNAIL_FOLDER) {
          await this.cleanupEmptyDirectories(path.join(dirPath, entry.name))
        }
      }
      if (fs.readdirSync(dirPath).length === 0 && !dirPath.endsWith(VIRTUAL_DIRECTORY_FOLDER)) {
        fs.rmdirSync(dirPath)
        return true
      }
      return false
    } catch (error) {
      return false
    }
  }

  /**
   * 清理虚拟目录（移除已不存在于数据库中的文件）
   */
  async cleanupVirtualDirectory(workspaceDirectoryPath: string): Promise<void> {
    try {
      const virtualDirPath = path.join(workspaceDirectoryPath, VIRTUAL_DIRECTORY_FOLDER)
      if (!fs.existsSync(virtualDirPath)) return

      const directory = this.db
        .prepare('SELECT workspace_id FROM workspaces WHERE path = ?')
        .get(workspaceDirectoryPath) as any
      if (!directory) return

      const analyzedFiles = this.db
        .prepare(
          'SELECT wf.name, wf.path FROM workspace_files wf WHERE wf.workspace_id = ? AND wf.is_analyzed = 1'
        )
        .all(directory.workspace_id) as Array<{ name: string; path: string }>

      const analyzedFileNames = new Set(analyzedFiles.map(f => f.name))
      const analyzedFilePaths = new Set(analyzedFiles.map(f => f.path))

      await this.cleanupDirectoryRecursive(virtualDirPath, analyzedFileNames, analyzedFilePaths)
    } catch (error) {
      logger.warn(LogCategory.FILE_ORGANIZATION, '更新虚拟目录后清理失败:', error)
    }
  }

  private async cleanupDirectoryRecursive(
    dirPath: string,
    analyzedFileNames: Set<string>,
    analyzedFilePaths: Set<string>
  ): Promise<void> {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === THUMBNAIL_FOLDER) continue
          await this.cleanupDirectoryRecursive(fullPath, analyzedFileNames, analyzedFilePaths)
          try {
            if (fs.readdirSync(fullPath).length === 0) fs.rmdirSync(fullPath)
          } catch (error) {
            logger.warn(LogCategory.FILE_ORGANIZATION, '递归清理空目录失败:', fullPath, error)
          }
        } else if (entry.isFile()) {
          if (/^ReadMe_[a-zA-Z\-]{5}\.txt$/.test(entry.name)) continue
          if (!analyzedFileNames.has(entry.name)) {
            try {
              fs.unlinkSync(fullPath)
            } catch (error) {
              logger.warn(LogCategory.FILE_ORGANIZATION, '递归清理未分析文件失败:', fullPath, error)
            }
          }
        }
      }
    } catch (error) {
      logger.warn(LogCategory.FILE_ORGANIZATION, '递归清理目录失败:', dirPath, error)
    }
  }

  /**
   * 删除虚拟目录对应的物理 tag 目录链
   */
  async deleteTopLevelTagDirectory(
    workspaceDirectoryPath: string,
    selectedTags: any[]
  ): Promise<void> {
    try {
      const virtualDirPath = path.join(workspaceDirectoryPath, VIRTUAL_DIRECTORY_FOLDER)
      if (!fs.existsSync(virtualDirPath) || !selectedTags || selectedTags.length === 0) return

      const allVirtualDirectories = this.db
        .prepare(
          'SELECT filters FROM analyzed_directories WHERE workspace_id = (SELECT id FROM workspace_directories WHERE path = ?)'
        )
        .all(workspaceDirectoryPath) as any[]
      const otherTagChains: string[][] = allVirtualDirectories.map(dir =>
        JSON.parse(dir.filters).selectedTags.map((tag: any) => tag.tagValue)
      )
      const tagChain = selectedTags.map((tag: any) => tag.tagValue)
      await this.deleteTagChainRecursively(virtualDirPath, tagChain, otherTagChains)
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '删除tag目录链失败:', error)
    }
  }

  private async deleteTagChainRecursively(
    virtualDirPath: string,
    tagChain: string[],
    otherTagChains: string[][]
  ): Promise<void> {
    if (tagChain.length === 0) return
    const currentPath = path.join(virtualDirPath, ...tagChain)
    if (!fs.existsSync(currentPath)) return

    const isUsedByOthers = otherTagChains.some(
      otherChain =>
        otherChain.length >= tagChain.length &&
        tagChain.every((tag, index) => tag === otherChain[index])
    )
    if (isUsedByOthers) return

    fs.rmSync(currentPath, { recursive: true, force: true })
    const parentTagChain = tagChain.slice(0, -1)
    if (parentTagChain.length > 0)
      await this.deleteTagChainRecursively(virtualDirPath, parentTagChain, otherTagChains)
  }

  /**
   * 查找第一个匹配的硬链接
   */
  async findFirstHardlink(filePath: string, workspacePath: string): Promise<string | null> {
    try {
      if (!fs.existsSync(filePath)) return null
      const sourceStat = fs.statSync(filePath)
      const virtualDirPath = path.join(workspacePath, VIRTUAL_DIRECTORY_FOLDER)
      if (!fs.existsSync(virtualDirPath)) return null
      return this.findHardlinkRecursive(virtualDirPath, sourceStat.ino)
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '查找硬链接失败:', error)
      return null
    }
  }

  /**
   * 递归查找硬链接（跳过缩略图目录和 ReadMe 文件）
   */
  private findHardlinkRecursive(dirPath: string, targetIno: number): string | null {
    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)
        if (entry.isDirectory()) {
          // 跳过缩略图目录
          if (entry.name === THUMBNAIL_FOLDER) continue
          const found = this.findHardlinkRecursive(fullPath, targetIno)
          if (found) return found
        } else if (entry.isFile()) {
          // 跳过 ReadMe 文件
          if (/^ReadMe_[a-zA-Z\-]{2,10}\.txt$/.test(entry.name)) continue
          try {
            const fileStat = fs.statSync(fullPath)
            if (fileStat.ino === targetIno) return fullPath
          } catch (e) {
            logger.warn(LogCategory.FILE_ORGANIZATION, '查找硬链接时 stat 文件失败:', fullPath, e)
          }
        }
      }
    } catch (error) {
      logger.warn(LogCategory.FILE_ORGANIZATION, '查找硬链接递归遍历失败:', dirPath, error)
    }
    return null
  }

  /**
   * 根据 smartName 获取文件名（保留原始扩展名）
   */
  private getFileNameWithSmartName(file: FileItem): string {
    if (file.smartName) {
      const originalExt = path.extname(file.name)
      const smartNameExt = path.extname(file.smartName)
      return !smartNameExt || smartNameExt.toLowerCase() !== originalExt.toLowerCase()
        ? (smartNameExt ? file.smartName.slice(0, -smartNameExt.length) : file.smartName) +
            originalExt
        : file.smartName
    } else return file.name
  }
}
