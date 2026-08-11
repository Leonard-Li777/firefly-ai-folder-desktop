import { VirtualDirectory, VirtualDirectoryFileRow, PhysicalExportResult } from '@firefly/types'
import { LogCategory, logger } from '@firefly/shared'
import { databaseService } from '../../database/database-service'
import fs from 'fs-extra'
import path from 'node:path'
import { VIRTUAL_DIRECTORY_ROOT } from './utils'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'

export interface ExporterProvider {
  get(id: number): Promise<VirtualDirectory | null>
  listFiles(virtualDirectoryId: number): Promise<VirtualDirectoryFileRow[]>
}

export class Exporter {
  constructor(private provider: ExporterProvider) {}

  async exportToPhysical(
    virtualDirectoryId: number,
    options?: { onProgress?: (progress: number) => void }
  ): Promise<PhysicalExportResult> {
    const vd = await this.provider.get(virtualDirectoryId)
    if (!vd) throw new Error('Virtual directory not found')

    const workspace = await databaseService.getWorkspaceDirectoryById(vd.workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const files = await this.provider.listFiles(virtualDirectoryId)
    const vdRoot = path.join(workspace.path, VIRTUAL_DIRECTORY_ROOT, vd.name)

    await fs.ensureDir(vdRoot)

    let exportedCount = 0
    let failedCount = 0
    const failedFiles: string[] = []
    const failedOperations: Array<{ source: string; target: string }> = []

    const swapFileName =
      ConfigOrchestrator.getInstance().getValue<boolean>('SWAP_FILE_NAME_DISPLAY') ?? false

    console.log(
      `[A流程-物理导出] 开始物理导出, swapFileName=${swapFileName}, 文件总数=${files.length}`
    )
    logger.info(
      LogCategory.VIRTUAL_DIRECTORY,
      `[A流程-物理导出] 开始物理导出, swapFileName=${swapFileName}, 文件总数=${files.length}`
    )

    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      let relativePath = file.relativePath
      if (
        relativePath &&
        (relativePath.endsWith('.keep') ||
          relativePath.endsWith('/.keep') ||
          relativePath.endsWith('\\.keep'))
      ) {
        const targetDir = path.join(vdRoot, path.dirname(relativePath))
        await fs.ensureDir(targetDir)
        continue
      }

      if (relativePath) {
        // 从磁盘绝对路径 originalPath 提取最高优先级的真实原始文件名
        const originalBasename = file.originalPath ? path.basename(file.originalPath) : undefined
        const realFileName =
          originalBasename || file.name || (file as any).fileName || path.basename(relativePath)
        const smartName = file.smartName || realFileName
        const targetFileName = swapFileName ? realFileName : smartName
        const dirName = path.dirname(relativePath)
        relativePath =
          dirName && dirName !== '.' ? path.join(dirName, targetFileName) : targetFileName

        const diagInfo = {
          fileId: file.fileId,
          swapFileName,
          originalBasename,
          dbName: file.name,
          dbSmartName: file.smartName,
          realFileName,
          targetFileName,
          finalRelativePath: relativePath
        }
        console.log(`[A流程-物理导出] 文件 #${i + 1}`, diagInfo)
        logger.info(LogCategory.VIRTUAL_DIRECTORY, `[A流程-物理导出] 文件 #${i + 1}`, diagInfo)
      }

      const targetPath = path.join(vdRoot, relativePath)

      try {
        const targetDir = path.dirname(targetPath)
        await fs.ensureDir(targetDir)
        if (!file.originalPath || !(await fs.pathExists(file.originalPath))) {
          throw new Error('Original file not found')
        }

        // 清理历史同文件可能存在的旧名称链接（比如之前导出的智能名或 relativePath 中的原文件名）
        const oldRelativeBasename = path.basename(file.relativePath)
        const oldSmartPath = path.join(targetDir, file.smartName || '')
        const oldRelPath = path.join(targetDir, oldRelativeBasename)
        const oldRawPath = path.join(targetDir, (file as any).fileName || file.name || '')

        for (const p of [oldSmartPath, oldRelPath, oldRawPath, targetPath]) {
          if (await fs.pathExists(p)) {
            await fs.remove(p).catch(() => {})
          }
        }

        // 必须使用硬链接 (Hard Link)，失败时回退到软链接 (Symlink)，绝不进行物理复制
        try {
          await fs.link(file.originalPath, targetPath)
        } catch (e) {
          await fs.symlink(file.originalPath, targetPath)
        }
        exportedCount++
      } catch (err: any) {
        console.error(`[A流程-物理导出] 导出文件异常: ${file.originalPath} -> ${targetPath}`, err)
        logger.warn(
          LogCategory.VIRTUAL_DIRECTORY,
          `Failed to export file: ${file.originalPath}`,
          err
        )
        failedCount++
        failedFiles.push(file.originalPath || 'Unknown')
        failedOperations.push({ source: file.originalPath || '', target: targetPath })
      }

      if (options?.onProgress) {
        options.onProgress(Math.round(((i + 1) / files.length) * 100))
      }
    }

    return {
      success: failedCount === 0,
      exportedCount,
      failedCount,
      failedFiles,
      failedOperations,
      exportPath: vdRoot
    }
  }
}
