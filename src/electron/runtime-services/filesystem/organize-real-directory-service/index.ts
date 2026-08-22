import {
  AIDirectoryStructure,
  ConflictResolutionOptions,
  DirectoryNode,
  FileOperation,
  OrganizeStatistics
} from '@firefly/types/organize-types'
import { FileInfoForAI, SavedVirtualDirectory } from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import { QuickOrganizeOptions, QuickOrganizeService } from '@firefly/core-engine'
import { platformAdapter } from '@firefly/electron-llamaIndex-service'

import { t } from '@app/languages'
import Database from 'better-sqlite3'
import path from 'node:path'

import { ConfigOrchestrator } from '@app/electron/config/config-orchestrator'
import { ConflictResolver } from './ConflictResolver'
import { DatabaseHelper } from './DatabaseHelper'
import { FileOperationManager } from './FileOperationManager'
import { PlanGenerator } from './PlanGenerator'
import { createCoreEngineAdapters } from '../../../adapters'

export class OrganizeRealDirectoryService {
  private quickOrganizeService!: QuickOrganizeService
  private fileOperationManager: FileOperationManager
  private conflictResolver: ConflictResolver
  private planGenerator: PlanGenerator
  private databaseHelper: DatabaseHelper

  constructor(private db: Database.Database) {
    this.fileOperationManager = new FileOperationManager(db)
    this.conflictResolver = new ConflictResolver()
    this.planGenerator = new PlanGenerator(db, () => this.getQuickOrganizeService())
    this.databaseHelper = new DatabaseHelper(db)
  }

  private async getQuickOrganizeService(): Promise<QuickOrganizeService> {
    if (!this.quickOrganizeService) {
      const adapters = await createCoreEngineAdapters()
      this.quickOrganizeService = new QuickOrganizeService(
        adapters.llamaRuntime as any,
        adapters.aiHelper
      )
    }
    return this.quickOrganizeService
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

    const fileOperations: FileOperation[] = files.map((file: any) => {
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

  async buildOrganizePrompts(
    workspaceDirectoryPath: string,
    userInstruction: string = '',
    analyzedFiles?: FileInfoForAI[]
  ): Promise<{ systemPrompt: string; userPrompt: string }> {
    return this.planGenerator.buildOrganizePrompts(
      workspaceDirectoryPath,
      userInstruction,
      analyzedFiles
    )
  }

  async generateOrganizePlan(
    workspaceDirectoryPath: string,
    options?: QuickOrganizeOptions
  ): Promise<AIDirectoryStructure> {
    let analyzedFiles = await this.databaseHelper.getAnalyzedFiles(workspaceDirectoryPath)
    if (options?.filePaths?.length) {
      const selected = new Set(options.filePaths)
      analyzedFiles = analyzedFiles.filter(f => selected.has(f.path))
    }
    return this.planGenerator.generateOrganizePlan(workspaceDirectoryPath, analyzedFiles, options)
  }

  async getAnalyzedFiles(workspaceDirectoryPath: string): Promise<FileInfoForAI[]> {
    return this.databaseHelper.getAnalyzedFiles(workspaceDirectoryPath)
  }

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

      // 构建目录路径映射（从标识符到完整路径）
      const buildDirectoryPaths = (directories: DirectoryNode[]): Map<string, string> => {
        const pathMap = new Map<string, string>()

        // 先处理所有顶级目录（parent为空）
        for (const dir of directories) {
          if (!dir.parent || dir.parent === '') {
            const nodeIdentifier = dir.id || dir.name
            pathMap.set(nodeIdentifier, dir.name)
          }
        }

        // 迭代处理子目录，直到所有目录都有路径
        let maxIterations = 10
        let lastProcessedCount = 0

        while (maxIterations > 0 && pathMap.size < directories.length) {
          for (const dir of directories) {
            const nodeIdentifier = dir.id || dir.name
            if (pathMap.has(nodeIdentifier)) continue
            if (dir.parent && pathMap.has(dir.parent)) {
              pathMap.set(nodeIdentifier, path.join(pathMap.get(dir.parent)!, dir.name))
            }
          }
          if (pathMap.size === lastProcessedCount) break
          lastProcessedCount = pathMap.size
          maxIterations--
        }

        return pathMap
      }

      const directoryPaths = buildDirectoryPaths(aiGeneratedStructure.directories)

      const fileOperations: {
        fileId: number
        fileName: string
        sourcePath: string
        targetPath: string
        smartName: string
      }[] = []

      // 获取 workspace_id
      const normalizedPath = workspaceDirectoryPath.replace(/[\\/]$/, '')
      const workspace = this.db
        .prepare('SELECT workspace_id, path FROM workspaces WHERE path = ? OR path = ?')
        .get(normalizedPath, normalizedPath + path.sep) as
        | { workspace_id: number; path: string }
        | undefined

      if (!workspace) {
        const allWorkspaces = this.db.prepare('SELECT workspace_id, path FROM workspaces').all()
        logger.error(LogCategory.FILE_ORGANIZATION, '[一键整理] 找不到工作空间', {
          workspaceDirectoryPath,
          normalizedPath,
          availableWorkspaces: allWorkspaces
        })
        throw new Error(t('找不到对应的工作空间: {path}', { path: workspaceDirectoryPath }))
      }

      logger.info(LogCategory.FILE_ORGANIZATION, '[一键整理] 找到工作空间', {
        workspaceId: workspace.workspace_id,
        dbPath: workspace.path,
        providedPath: workspaceDirectoryPath
      })

      // 遍历所有目录，创建目录并记录文件目标路径
      for (const dir of aiGeneratedStructure.directories) {
        const nodeIdentifier = dir.id || dir.name
        const relativePath = directoryPaths.get(nodeIdentifier)
        if (!relativePath) {
          logger.warn(LogCategory.FILE_ORGANIZATION, '[一键整理] 无法构建目录路径', {
            dirName: dir.name,
            parent: dir.parent
          })
          continue
        }

        const targetDirPath = path.join(workspaceDirectoryPath, relativePath)
        this.fileOperationManager.ensureDirectoryExists(targetDirPath)
        statistics.createdDirectories++

        if (dir.files) {
          for (const fileItem of dir.files) {
            const fileName = typeof fileItem === 'string' ? fileItem : fileItem.name
            let existingFile:
              | { id: number; name: string; sourcePath: string; smartName: string }
              | undefined

            const fileId = typeof fileItem === 'object' ? (fileItem as any).id : undefined
            if (fileId) {
              existingFile = this.db
                .prepare(
                  'SELECT wf.id, wf.name, wf.path as sourcePath, f.smart_name as smartName FROM workspace_files wf LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint WHERE wf.id = ? LIMIT 1'
                )
                .get(Number(fileId)) as any
            }

            if (!existingFile) {
              const sep = path.sep
              const prefix = workspaceDirectoryPath.endsWith(sep)
                ? workspaceDirectoryPath
                : workspaceDirectoryPath + sep
              existingFile = this.db
                .prepare(
                  'SELECT wf.id, wf.name, wf.path as sourcePath, f.smart_name as smartName FROM workspace_files wf LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint WHERE (wf.name = ? OR f.smart_name = ?) AND (wf.path LIKE ? OR wf.path = ?) LIMIT 1'
                )
                .get(fileName, fileName, `${prefix}%`, workspaceDirectoryPath) as any
            }

            if (!existingFile) {
              logger.warn(LogCategory.FILE_ORGANIZATION, '[一键整理] 找不到文件信息', { fileName })
              continue
            }

            if (processedFileIds.has(existingFile.id)) continue
            processedFileIds.add(existingFile.id)

            const swapFileName =
              ConfigOrchestrator.getInstance().getValue<boolean>('SWAP_FILE_NAME_DISPLAY') ?? false
            const targetFileName =
              (swapFileName
                ? existingFile.name || existingFile.smartName
                : existingFile.smartName || existingFile.name) || `file_${existingFile.id}`
            fileOperations.push({
              fileId: existingFile.id,
              fileName,
              sourcePath: existingFile.sourcePath,
              targetPath: path.join(targetDirPath, targetFileName),
              smartName: targetFileName
            })
          }
        }
      }
      statistics.totalFiles = fileOperations.length

      // 检测文件冲突
      const conflicts = this.conflictResolver.detectConflicts(
        fileOperations.map(op => ({
          fileId: op.fileId,
          oldPath: '',
          newPath: op.targetPath,
          smartName: op.smartName
        }))
      )
      if (conflicts.length > 0) {
        for (const conflict of conflicts) {
          const operation = fileOperations.find(op => op.targetPath === conflict.targetPath)
          if (operation)
            operation.targetPath = this.conflictResolver.generateNewPath(
              operation.targetPath,
              'number'
            )
        }
      }

      // 执行文件移动
      for (const op of fileOperations) {
        const currentFileInfo = this.db
          .prepare(
            'SELECT wf.path, wf.name, f.smart_name as smartName FROM workspace_files wf LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint WHERE wf.id = ?'
          )
          .get(op.fileId) as { path: string; name: string; smartName: string } | undefined

        if (!currentFileInfo) {
          statistics.failedFiles++
          statistics.errors.push({
            filePath: op.fileName,
            error: '文件已被删除或不属于当前工作空间'
          })
          continue
        }

        try {
          const operation: FileOperation = {
            fileId: op.fileId,
            oldPath: currentFileInfo.path,
            newPath: op.targetPath,
            smartName: currentFileInfo.smartName || currentFileInfo.name
          }
          const result = await this.fileOperationManager.organizeFileWithHardlinks(operation)
          if (result.success) statistics.movedFiles++
          else {
            statistics.failedFiles++
            statistics.errors.push({
              filePath: operation.oldPath,
              error: result.error || '未知错误'
            })
          }
        } catch (error: any) {
          statistics.failedFiles++
          statistics.errors.push({ filePath: op.fileName, error: error.message })
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
