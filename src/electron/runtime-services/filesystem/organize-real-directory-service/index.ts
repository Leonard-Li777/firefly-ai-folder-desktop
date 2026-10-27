import {
  AIDirectoryStructure,
  ConflictResolutionOptions,
  DirectoryNode,
  FileOperation,
  OrganizeStatistics
} from '@firefly/types/organize-types'
import { FileInfoForAI, SavedVirtualDirectory } from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import { platformAdapter } from '@firefly/electron-llamaIndex-service'

import { t } from '@app/languages'
import Database from 'better-sqlite3'
import path from 'node:path'

import { ConfigOrchestrator } from '@app/electron/config/config-orchestrator'
import { ConflictResolver } from './ConflictResolver'
import { DatabaseHelper, LightweightFileItem } from './DatabaseHelper'
export type { LightweightFileItem }
import { FileOperationManager } from './FileOperationManager'

export class OrganizeRealDirectoryService {
  private fileOperationManager: FileOperationManager
  private conflictResolver: ConflictResolver
  private databaseHelper: DatabaseHelper

  constructor(private db: Database.Database) {
    this.fileOperationManager = new FileOperationManager(db)
    this.conflictResolver = new ConflictResolver()
    this.databaseHelper = new DatabaseHelper(db)
  }

  async exportVirtualDirectoryById(
    virtualDirectoryId: number,
    workspaceDirectoryPath: string
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

    const files = this.db
      .prepare(
        `
      SELECT
        vdf.file_id as fileId,
        vdf.relative_path as relativePath,
        wf.path as originalPath,
        wf.name as fileName,
        f.smart_name as smartName
      FROM virtual_directory_files vdf
      JOIN workspace_files wf ON vdf.file_id = wf.id
      JOIN files f ON vdf.file_fingerprint = f.file_fingerprint
      WHERE vdf.virtual_directory_id = ?
    `
      )
      .all(virtualDirectoryId) as any[]

    if (files.length === 0) {
      logger.warn(LogCategory.FILE_ORGANIZATION, '虚拟目录无文件可导出', { virtualDirectoryId })
      statistics.elapsedTime = Date.now() - startTime
      return statistics
    }

    statistics.totalFiles = files.length

    console.log(`[A流程-导出真实目录] 开始导出真实目录, 文件总数=${files.length}`)
    logger.info(
      LogCategory.FILE_ORGANIZATION,
      `[A流程-导出真实目录] 开始导出真实目录, 文件总数=${files.length}`
    )

    // 物理整理落盘多归属保护：同一文件若在多个虚拟目录分支下出现，仅对 Top-1 目标路径物理移动
    const seenFileIds = new Set<number>()
    const uniqueFiles: any[] = []
    for (const f of files) {
      if (seenFileIds.has(f.fileId)) {
        logger.info(
          LogCategory.FILE_ORGANIZATION,
          `[exportVirtualDirectoryById] 物理整理多归属保护：文件已存在首选移动目标，跳过重复移动: fileId=${f.fileId}, relativePath=${f.relativePath}`
        )
        continue
      }
      seenFileIds.add(f.fileId)
      uniqueFiles.push(f)
    }

    const fileOperations: FileOperation[] = uniqueFiles.map((file: any) => {
      const swapFileName =
        ConfigOrchestrator.getInstance().getValue<boolean>('SWAP_FILE_NAME_DISPLAY') ?? false

      const originalBasename = file.originalPath ? path.basename(file.originalPath) : undefined
      const realFileName = originalBasename || file.fileName || file.name || `file_${file.fileId}`
      const smartName = file.smartName || realFileName
      const targetFileName = swapFileName ? realFileName : smartName

      let relativePath = file.relativePath
      if (relativePath) {
        const dirName = path.dirname(relativePath)
        relativePath =
          dirName && dirName !== '.' ? path.join(dirName, targetFileName) : targetFileName
      }

      const newPath = relativePath
        ? path.join(workspaceDirectoryPath, relativePath)
        : path.join(workspaceDirectoryPath, targetFileName)

      const diagInfo = {
        fileId: file.fileId,
        swapFileName,
        dbFileName: file.fileName,
        dbSmartName: file.smartName,
        originalBasename,
        targetFileName,
        oldPath: file.originalPath,
        newPath
      }
      console.log(`[A流程-导出真实目录] 处理文件:`, diagInfo)
      logger.info(LogCategory.FILE_ORGANIZATION, `[A流程-导出真实目录] 处理文件:`, diagInfo)

      return {
        fileId: file.fileId,
        oldPath: file.originalPath,
        newPath,
        smartName: targetFileName
      }
    })

    const targetDirs = new Set(fileOperations.map(op => path.dirname(op.newPath)))
    for (const dir of targetDirs) {
      this.fileOperationManager.ensureDirectoryExists(dir)
      statistics.createdDirectories++
    }

    const conflicts = this.conflictResolver.detectConflicts(fileOperations)
    for (const conflict of conflicts) {
      const op = fileOperations.find(o => o.newPath === conflict.targetPath)
      if (op) op.newPath = this.conflictResolver.generateNewPath(op.newPath, 'number')
    }

    for (const op of fileOperations) {
      try {
        const res = await this.fileOperationManager.organizeFileWithHardlinks(op)
        if (res.success) {
          statistics.movedFiles++
        } else {
          statistics.failedFiles++
          statistics.errors.push({ filePath: op.oldPath, error: res.error || '未知错误' })
        }
      } catch (e: any) {
        statistics.failedFiles++
        statistics.errors.push({ filePath: op.oldPath, error: e.message })
      }
    }

    statistics.elapsedTime = Date.now() - startTime
    return statistics
  }

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
      errors: []
    }

    const batchedFilesMap = await this.databaseHelper.getBatchedVirtualDirectoryFiles(
      workspaceDirectoryPath,
      savedDirectories
    )

    for (const virtualDir of savedDirectories) {
      const singleDirStats = { total: 0, success: 0, failed: 0 }
      const files = batchedFilesMap.get(virtualDir.id) || []

      if (files.length === 0) {
        logger.info(LogCategory.FILE_ORGANIZATION, '虚拟目录无文件，跳过导出', {
          virtualDirectoryId: virtualDir.id,
          name: virtualDir.name
        })
        continue
      }

      singleDirStats.total = files.length
      overallStatistics.totalFiles += files.length
      const targetDirPath = this.buildVirtualDirectoryPath(workspaceDirectoryPath, virtualDir)
      this.fileOperationManager.ensureDirectoryExists(targetDirPath)
      overallStatistics.createdDirectories++

      const swapFileName =
        ConfigOrchestrator.getInstance().getValue<boolean>('SWAP_FILE_NAME_DISPLAY') ?? false
      const fileOperations: FileOperation[] = files.map(file => {
        const targetFileName =
          (swapFileName ? file.name || file.smartName : file.smartName || file.name) ||
          `file_${file.id}`
        return {
          fileId: file.id,
          oldPath: file.path,
          newPath: path.join(targetDirPath, targetFileName),
          smartName: targetFileName
        }
      })

      const conflicts = this.conflictResolver.detectConflicts(fileOperations)
      for (const conflict of conflicts) {
        const op = fileOperations.find(o => o.newPath === conflict.targetPath)
        if (op) op.newPath = this.conflictResolver.generateNewPath(op.newPath, 'number')
      }

      for (const op of fileOperations) {
        try {
          const res = await this.fileOperationManager.organizeFileWithHardlinks(op)
          if (res.success) singleDirStats.success++
          else {
            singleDirStats.failed++
            overallStatistics.errors.push({ filePath: op.oldPath, error: res.error || '未知错误' })
          }
        } catch (e: any) {
          singleDirStats.failed++
          overallStatistics.errors.push({ filePath: op.oldPath, error: e.message })
        }
      }

      overallStatistics.movedFiles += singleDirStats.success
      overallStatistics.failedFiles += singleDirStats.failed
    }
    overallStatistics.elapsedTime = Date.now() - startTime
    return overallStatistics
  }

  private buildVirtualDirectoryPath(
    workspaceDirectoryPath: string,
    virtualDir: SavedVirtualDirectory
  ): string {
    const tags = virtualDir.filter?.selectedTags || []
    if (tags.length > 0) {
      return path.join(workspaceDirectoryPath, ...tags.map(t => t.tagValue))
    }
    return path.join(workspaceDirectoryPath, virtualDir.name)
  }

  /**
   * 轻量构建整理提示词模板（供外部 API / Skill 查询）
   */
  async buildOrganizePrompts(
    _workspaceDirectoryPath: string,
    userInstruction: string = ''
  ): Promise<{ systemPrompt: string; userPrompt: string }> {
    return {
      systemPrompt: 'You are an AI file organizer.',
      userPrompt: userInstruction || '请根据文件信息进行目录归类整理'
    }
  }

  /**
   * 极速轻量查询工作区已分析文件
   */
  async getLightweightWorkspaceFiles(
    workspaceDirectoryPathOrId: string | number,
    selectedFileIds?: number[],
    limit?: number
  ): Promise<LightweightFileItem[]> {
    return this.databaseHelper.getLightweightWorkspaceFiles(workspaceDirectoryPathOrId, selectedFileIds, limit)
  }

  /**
   * 极速统计工作区已分析文件总数
   */
  getWorkspaceAnalyzedFileCount(workspaceDirectoryPathOrId: string | number): number {
    return this.databaseHelper.getWorkspaceAnalyzedFileCount(workspaceDirectoryPathOrId)
  }

  async resolveConflicts(
    ops: FileOperation[],
    conflicts: any[],
    res: ConflictResolutionOptions
  ): Promise<FileOperation[]> {
    return this.conflictResolver.resolveConflicts(ops, conflicts, res, p =>
      this.fileOperationManager.createBackup(p)
    )
  }

  async openOrganizedDirectory(p: string): Promise<void> {
    await platformAdapter.openPath(p)
  }

  async exportErrorLog(s: OrganizeStatistics, out: string): Promise<void> {
    const { writeFileSync } = await import('node:fs')
    writeFileSync(out, JSON.stringify(s, null, 2))
  }

  async getSavedVirtualDirectories(p: string): Promise<SavedVirtualDirectory[]> {
    return this.databaseHelper.getSavedVirtualDirectories(p)
  }

  async deleteAllVirtualDirectories(p: string): Promise<void> {
    const virtualDirRoot = path.join(p, '.VirtualDirectory')
    const { existsSync, rmSync } = await import('node:fs')
    if (existsSync(virtualDirRoot)) rmSync(virtualDirRoot, { recursive: true, force: true })
    this.db
      .prepare(
        'DELETE FROM analyzed_directories WHERE workspace_id = (SELECT workspace_id FROM workspaces WHERE path = ?)'
      )
      .run(p)
  }

  async getOrganizePreview(
    p: string,
    dirs: SavedVirtualDirectory[]
  ): Promise<{ fileCount: number; directoryStructure: DirectoryNode[] }> {
    const batched = await this.databaseHelper.getBatchedVirtualDirectoryFiles(p, dirs)
    let count = 0
    const structure: DirectoryNode[] = []
    for (const d of dirs) {
      const files = batched.get(d.id) || []
      structure.push({
        name: d.name,
        parent: '',
        files: files.map(f => f.smartName || f.name),
        fileCount: files.length
      })
      count += files.length
    }
    return { fileCount: count, directoryStructure: structure }
  }
}
