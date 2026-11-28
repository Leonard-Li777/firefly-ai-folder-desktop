import { FileItem, SavedVirtualDirectory, SelectedTag } from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import { getPlatform } from '@firefly/shared/utils/path'
import {
  statOrNull,
  statOrThrow,
  readdirTyped,
  mkdirp,
  safeUnlink,
  mapLimit
} from '../../../infra/fs'

import Database from 'better-sqlite3'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

const VIRTUAL_DIRECTORY_FOLDER = '.VirtualDirectory'
const THUMBNAIL_FOLDER = '.thumbnail'

/**
 * W4/IO-8：同层并发上限（保守值，避免一次导出压满句柄）。
 * 层级之间仍严格串行（外层 for level + await），与 deduplicateHardLinksFromBottom 自底向上顺序一致。
 */
const LINK_LEVEL_CONCURRENCY = 8

export class LinkManager {
  constructor(
    private db: Database.Database,
    private getFilteredFiles: (params: any) => Promise<FileItem[]>,
    private copyReadmeFile: (virtualDirPath: string) => Promise<void>
  ) {}

  /**
   * 同目录 basename 大小写折叠键（INV-7）：
   * Windows/macOS 下 `A.TXT` 与 `a.txt` 判为同名；Linux 下保留原样判为不同名。
   * 仅用于「同目录是否已有同名链接」的内存集合判定，绝不进入 isPathEqual / SQL WHERE path。
   */
  private basenameCaseKey(name: string): string {
    const platform = getPlatform()
    return platform === 'win32' || platform === 'darwin' ? name.toLowerCase() : name
  }

  /**
   * 创建/更新虚拟目录的物理结构（硬链接）
   */
  async createVirtualDirectoryStructure(
    workspaceDirectoryPath: string,
    directory: SavedVirtualDirectory
  ): Promise<void> {
    try {
      const virtualDirPath = path.join(workspaceDirectoryPath, VIRTUAL_DIRECTORY_FOLDER)
      // 原「先 existsSync 再 mkdirSync」→ 一次 recursive mkdir
      await mkdirp(virtualDirPath)

      // 复制 ReadMe 说明文件（如果目录中没有）：读一次目录后用集合判定替换 readdirSync().some()
      const rootEntries = await readdirTyped(virtualDirPath)
      if (!rootEntries.some(entry => entry.name.startsWith('ReadMe_'))) {
        await this.copyReadmeFile(virtualDirPath)
      }

      const tagChain = directory.filter.selectedTags.map((tag: any) => tag.tagValue)

      // 清理冗余的父目录条目（更短的 tagChain 被当前 tagChain 包含时）
      const allDirectories = this.db
        .prepare('SELECT id, filters FROM virtual_directories WHERE id != ?')
        .all(directory.id) as any[]
      for (const dir of allDirectories) {
        const otherTagChain = JSON.parse(dir.filters).selectedTags.map((tag: any) => tag.tagValue)
        if (
          otherTagChain.length < tagChain.length &&
          otherTagChain.every((tag: string, index: number) => tag === tagChain[index])
        ) {
          this.db.prepare('DELETE FROM virtual_directories WHERE id = ?').run(dir.id)
        }
      }

      // 清理当前标签路径（如果已存在）
      if (directory.filter.selectedTags.length > 0) {
        const tagPath = path.join(virtualDirPath, ...tagChain)
        if (await statOrNull(tagPath)) await fsp.rm(tagPath, { recursive: true, force: true })
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
   *
   * IO-8 层级串行：外层 for level 逐层 await（与自底向上去重顺序一致），
   * 同一层内用 mapLimit 受限并发，结果按原索引回填，防止同时为同一目标 link。
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
        // IO-8/INV-7：同层按「目标 basename」折叠去重（Windows/macOS 大小写不敏感），
        // 保留最后出现的项——与原串行覆盖语义一致，避免并发下两任务同时 link 同一目标。
        // 折叠键仅用于内存去重，绝不进入 isPathEqual 或 SQL WHERE path。
        const byTargetName = new Map<string, FileItem>()
        const targetOf = new Map<FileItem, string>()
        for (const file of files) {
          const targetName = this.getFileNameWithSmartName(file)
          targetOf.set(file, targetName)
          byTargetName.set(this.basenameCaseKey(targetName), file)
        }
        const dedupedFiles = Array.from(byTargetName.values())
        await mapLimit(dedupedFiles, LINK_LEVEL_CONCURRENCY, file =>
          this.createHardLinkAtLevel(virtualDirPath, file, levelTags, targetOf.get(file)!)
        )
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
    levelTags: SelectedTag[],
    fileName: string
  ): Promise<void> {
    try {
      const tagPath = levelTags.map(t => t.tagValue).join(path.sep)
      const fullDirPath = path.join(virtualDirPath, tagPath)
      await mkdirp(fullDirPath)

      await this.createLink(file.path, path.join(fullDirPath, fileName))
    } catch (error) {
      logger.warn(LogCategory.FILE_ORGANIZATION, '[虚拟目录] 添加链接文件失败:', error)
    }
  }

  /**
   * 创建硬链接，失败时降级为符号链接（IO-8 异步版）。
   * 目标已存在先删除（safeUnlink 吞 ENOENT），并发下同目标已由调用方集合去重；
   * 重复 EEXIST 仍按旧语义吞掉并告警，不视为失败。
   */
  private async createLink(sourcePath: string, targetPath: string): Promise<void> {
    try {
      await safeUnlink(targetPath)
      await fsp.link(sourcePath, targetPath)
    } catch (error: any) {
      if (error.code === 'EEXIST') {
        logger.warn(
          LogCategory.FILE_ORGANIZATION,
          `[虚拟目录] 目标已存在，跳过重复链接: ${targetPath}`
        )
        return
      }
      if (error.code === 'EXDEV' || error.code === 'EPERM' || error.code === 'EACCES') {
        const type = getPlatform() === 'win32' ? 'file' : undefined
        try {
          await fsp.symlink(sourcePath, targetPath, type)
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
        if (!(await statOrNull(deepPath))) continue
        const deepFiles = await this.getAllFilesInDirectory(deepPath)
        for (const deepFilePath of deepFiles) {
          const fileName = path.basename(deepFilePath)
          const deepStat = await statOrNull(deepFilePath)
          if (!deepStat) continue
          for (let parentLevel = 1; parentLevel < deepLevel; parentLevel++) {
            const parentPath = path.join(
              virtualDirPath,
              ...selectedTags.slice(0, parentLevel).map(t => t.tagValue)
            )
            const parentFilePath = path.join(parentPath, fileName)
            if (!(await statOrNull(parentFilePath))) continue
            try {
              const parentStat = await statOrThrow(parentFilePath)
              if (parentStat.ino === deepStat.ino) await safeUnlink(parentFilePath)
            } catch (error) {
              logger.warn(
                LogCategory.FILE_ORGANIZATION,
                '[虚拟目录] 清理父级目录重复链接失败:',
                error
              )
            }
          }
        }
      }
    } catch (error) {
      logger.warn(LogCategory.FILE_ORGANIZATION, '[虚拟目录] 清理冗余链接异常:', error)
    }
  }

  /**
   * 递归获取目录下所有文件（IO-8 异步版）
   */
  private async getAllFilesInDirectory(dirPath: string): Promise<string[]> {
    const files: string[] = []
    try {
      const entries = await readdirTyped(dirPath)
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)
        if (entry.isDirectory()) files.push(...(await this.getAllFilesInDirectory(fullPath)))
        else if (entry.isFile() && !/^ReadMe_[a-zA-Z\-]{5}\.txt$/.test(entry.name))
          files.push(fullPath)
      }
    } catch (error) {
      logger.warn(LogCategory.FILE_ORGANIZATION, '[虚拟目录] 获取目录下所有文件失败:', error)
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
          'SELECT filters FROM virtual_directories WHERE workspace_id = (SELECT id FROM workspace_directories WHERE path = ?)'
        )
        .all(workspaceDirectoryPath || '') as any[]

      const otherTagChains: string[][] = allDirectories
        .map(dir => JSON.parse(dir.filters).selectedTags.map((tag: any) => tag.tagValue))
        .filter(chain => JSON.stringify(chain) !== JSON.stringify(currentTagChain))

      if (otherTagChains.length === 0) return

      for (const file of currentFiles) {
        const fileName = this.getFileNameWithSmartName(file)
        // 原「exists 为真后 stat 抛错走 catch」分支用 statOrThrow 保留语义
        const fileStat = await statOrThrow(file.path)
        for (const otherTagChain of otherTagChains) {
          for (let level = 1; level <= otherTagChain.length; level++) {
            const otherFilePath = path.join(
              virtualDirPath,
              otherTagChain.slice(0, level).join(path.sep),
              fileName
            )
            if (!(await statOrNull(otherFilePath))) continue
            try {
              const otherStat = await statOrThrow(otherFilePath)
              if (otherStat.ino === fileStat.ino) await safeUnlink(otherFilePath)
            } catch (error) {
              logger.warn(
                LogCategory.FILE_ORGANIZATION,
                '[虚拟目录] 清理其他虚拟目录重复链接失败:',
                error
              )
            }
          }
        }
      }
    } catch (error) {
      logger.warn(LogCategory.FILE_ORGANIZATION, '[虚拟目录] 清理其他虚拟目录失败:', error)
    }
  }

  /**
   * 递归清理空目录（IO-8 异步版）
   */
  async cleanupEmptyDirectories(dirPath: string): Promise<boolean> {
    try {
      const entries = await readdirTyped(dirPath)
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== THUMBNAIL_FOLDER) {
          await this.cleanupEmptyDirectories(path.join(dirPath, entry.name))
        }
      }
      if ((await readdirTyped(dirPath)).length === 0 && !dirPath.endsWith(VIRTUAL_DIRECTORY_FOLDER)) {
        await fsp.rmdir(dirPath)
        return true
      }
      return false
    } catch (error) {
      // 原实现吞掉异常返回 false；补 logger.warn 留痕（禁止静默降级）
      logger.warn(LogCategory.FILE_ORGANIZATION, '[虚拟目录] 清理空目录失败:', dirPath, error)
      return false
    }
  }

  /**
   * 清理虚拟目录（移除已不存在于数据库中的文件）
   */
  async cleanupVirtualDirectory(workspaceDirectoryPath: string): Promise<void> {
    try {
      const virtualDirPath = path.join(workspaceDirectoryPath, VIRTUAL_DIRECTORY_FOLDER)
      if (!(await statOrNull(virtualDirPath))) return

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
      logger.warn(LogCategory.FILE_ORGANIZATION, '[虚拟目录] 清理虚拟目录失败:', error)
    }
  }

  private async cleanupDirectoryRecursive(
    dirPath: string,
    analyzedFileNames: Set<string>,
    analyzedFilePaths: Set<string>
  ): Promise<void> {
    try {
      const entries = await readdirTyped(dirPath)
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === THUMBNAIL_FOLDER || entry.name === '.tts') continue
          await this.cleanupDirectoryRecursive(fullPath, analyzedFileNames, analyzedFilePaths)
          try {
            if ((await readdirTyped(fullPath)).length === 0) await fsp.rmdir(fullPath)
          } catch (error) {
            logger.warn(LogCategory.FILE_ORGANIZATION, '[虚拟目录] 递归清理空目录失败:', error)
          }
        } else if (entry.isFile()) {
          if (/^ReadMe_[a-zA-Z\-]{5}\.txt$/.test(entry.name)) continue
          if (!analyzedFileNames.has(entry.name)) {
            try {
              await safeUnlink(fullPath)
            } catch (error) {
              logger.warn(
                LogCategory.FILE_ORGANIZATION,
                '[虚拟目录] 递归清理未分析文件失败:',
                error
              )
            }
          }
        }
      }
    } catch (error) {
      logger.warn(LogCategory.FILE_ORGANIZATION, '[虚拟目录] 递归清理目录异常:', dirPath, error)
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
      if (!(await statOrNull(virtualDirPath)) || !selectedTags || selectedTags.length === 0) return

      const allVirtualDirectories = this.db
        .prepare(
          'SELECT filters FROM virtual_directories WHERE workspace_id = (SELECT id FROM workspace_directories WHERE path = ?)'
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
    if (!(await statOrNull(currentPath))) return

    const isUsedByOthers = otherTagChains.some(
      otherChain =>
        otherChain.length >= tagChain.length &&
        tagChain.every((tag, index) => tag === otherChain[index])
    )
    if (isUsedByOthers) return

    await fsp.rm(currentPath, { recursive: true, force: true })
    const parentTagChain = tagChain.slice(0, -1)
    if (parentTagChain.length > 0)
      await this.deleteTagChainRecursively(virtualDirPath, parentTagChain, otherTagChains)
  }

  /**
   * 查找第一个匹配的硬链接
   */
  async findFirstHardlink(filePath: string, workspacePath: string): Promise<string | null> {
    try {
      if (!(await statOrNull(filePath))) return null
      const sourceStat = await statOrThrow(filePath)
      const virtualDirPath = path.join(workspacePath, VIRTUAL_DIRECTORY_FOLDER)
      if (!(await statOrNull(virtualDirPath))) return null
      return await this.findHardlinkRecursive(virtualDirPath, sourceStat.ino)
    } catch (error) {
      logger.error(LogCategory.VIRTUAL_DIRECTORY, '查找硬链接失败:', error)
      return null
    }
  }

  /**
   * 递归查找硬链接（跳过缩略图目录和 ReadMe 文件）
   */
  private async findHardlinkRecursive(dirPath: string, targetIno: number): Promise<string | null> {
    try {
      const entries = await readdirTyped(dirPath)
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name)
        if (entry.isDirectory()) {
          // 跳过缩略图目录
          if (entry.name === THUMBNAIL_FOLDER) continue
          const found = await this.findHardlinkRecursive(fullPath, targetIno)
          if (found) return found
        } else if (entry.isFile()) {
          // 跳过 ReadMe 文件
          if (/^ReadMe_[a-zA-Z\-]{2,10}\.txt$/.test(entry.name)) continue
          try {
            const fileStat = await statOrThrow(fullPath)
            if (fileStat.ino === targetIno) return fullPath
          } catch (e) {
            logger.warn(LogCategory.FILE_ORGANIZATION, '[虚拟目录] 查找硬链接 stat 失败:', e)
          }
        }
      }
    } catch (error) {
      logger.warn(LogCategory.FILE_ORGANIZATION, '[虚拟目录] 查找硬链接目录遍历失败:', error)
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
