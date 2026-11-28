import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { logger, LogCategory } from '@firefly/shared'
import { existsAsync, statOrThrow, mkdirp } from '../../infra/fs'

/**
 * 备份记录
 */
export interface BackupRecord {
  originalPath: string
  backupPath: string
  timestamp: string
  fileSize: number
}

/**
 * 备份管理器
 * 负责创建、管理和恢复文件备份
 */
export class OrganizeBackupManager {
  private backupDir: string
  private backupRecords: BackupRecord[] = []
  private sessionId: string

  private constructor(workspaceDirectoryPath: string) {
    this.sessionId = new Date().toISOString().replace(/[:.]/g, '-')
    this.backupDir = path.join(workspaceDirectoryPath, '.organize-backups', this.sessionId)
  }

  /**
   * 异步工厂：原构造函数内的同步目录创建迁移到此处，失败行为与原构造函数一致（直接抛出）。
   */
  static async create(workspaceDirectoryPath: string): Promise<OrganizeBackupManager> {
    const manager = new OrganizeBackupManager(workspaceDirectoryPath)
    await manager.ensureBackupDirectory()
    return manager
  }

  /**
   * 确保备份目录存在
   */
  private async ensureBackupDirectory(): Promise<void> {
    if (!(await existsAsync(this.backupDir))) {
      await mkdirp(this.backupDir)
      logger.debug(LogCategory.FILE_ORGANIZATION, '创建备份目录', { backupDir: this.backupDir })
    }
  }

  /**
   * 创建文件备份
   */
  async createBackup(filePath: string): Promise<string> {
    try {
      const fileName = path.basename(filePath)
      const relativePath = path.relative(path.dirname(this.backupDir), filePath)
      const backupPath = path.join(this.backupDir, relativePath)

      // 确保备份目标目录存在
      await mkdirp(path.dirname(backupPath))

      // 复制文件
      await fsp.copyFile(filePath, backupPath)

      // 获取文件大小
      const stats = await statOrThrow(filePath)

      // 记录备份
      const record: BackupRecord = {
        originalPath: filePath,
        backupPath,
        timestamp: new Date().toISOString(),
        fileSize: stats.size
      }
      this.backupRecords.push(record)

      logger.debug(LogCategory.FILE_ORGANIZATION, '创建文件备份', {
        original: filePath,
        backup: backupPath
      })

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
   * 批量创建备份
   */
  async createBatchBackups(filePaths: string[]): Promise<Map<string, string>> {
    const backupMap = new Map<string, string>()

    for (const filePath of filePaths) {
      try {
        const backupPath = await this.createBackup(filePath)
        backupMap.set(filePath, backupPath)
      } catch (error) {
        // 继续处理其他文件
        logger.warn(LogCategory.FILE_ORGANIZATION, '跳过备份失败的文件', { filePath })
      }
    }

    logger.info(LogCategory.FILE_ORGANIZATION, '批量备份完成', {
      total: filePaths.length,
      success: backupMap.size,
      failed: filePaths.length - backupMap.size
    })

    return backupMap
  }

  /**
   * 恢复单个文件
   */
  async restoreFile(originalPath: string): Promise<boolean> {
    try {
      const record = this.backupRecords.find(r => r.originalPath === originalPath)
      if (!record) {
        logger.warn(LogCategory.FILE_ORGANIZATION, '未找到备份记录', { originalPath })
        return false
      }

      if (!(await existsAsync(record.backupPath))) {
        logger.warn(LogCategory.FILE_ORGANIZATION, '备份文件不存在', {
          backupPath: record.backupPath
        })
        return false
      }

      // 恢复文件
      await fsp.copyFile(record.backupPath, originalPath)

      logger.debug(LogCategory.FILE_ORGANIZATION, '文件恢复成功', {
        original: originalPath,
        backup: record.backupPath
      })

      return true
    } catch (error: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, '文件恢复失败', {
        originalPath,
        error: error.message
      })
      return false
    }
  }

  /**
   * 恢复所有备份
   */
  async restoreAll(): Promise<{ success: number; failed: number }> {
    let success = 0
    let failed = 0

    logger.debug(LogCategory.FILE_ORGANIZATION, '开始恢复所有备份', {
      total: this.backupRecords.length
    })

    for (const record of this.backupRecords) {
      const result = await this.restoreFile(record.originalPath)
      if (result) {
        success++
      } else {
        failed++
      }
    }

    logger.info(LogCategory.FILE_ORGANIZATION, '备份恢复完成', { success, failed })

    return { success, failed }
  }

  /**
   * 清理备份文件
   */
  async cleanup(): Promise<void> {
    try {
      if (await existsAsync(this.backupDir)) {
        await fsp.rm(this.backupDir, { recursive: true, force: true })
        logger.debug(LogCategory.FILE_ORGANIZATION, '清理备份目录', { backupDir: this.backupDir })
      }
    } catch (error: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, '清理备份失败', {
        backupDir: this.backupDir,
        error: error.message
      })
    }
  }

  /**
   * 获取备份记录
   */
  getBackupRecords(): BackupRecord[] {
    return [...this.backupRecords]
  }

  /**
   * 获取备份统计信息
   */
  getStatistics(): {
    totalFiles: number
    totalSize: number
    backupDir: string
    sessionId: string
  } {
    const totalSize = this.backupRecords.reduce((sum, record) => sum + record.fileSize, 0)

    return {
      totalFiles: this.backupRecords.length,
      totalSize,
      backupDir: this.backupDir,
      sessionId: this.sessionId
    }
  }

  /**
   * 保存备份清单到文件
   */
  async saveManifest(): Promise<void> {
    try {
      const manifestPath = path.join(this.backupDir, 'manifest.json')
      const manifest = {
        sessionId: this.sessionId,
        timestamp: new Date().toISOString(),
        records: this.backupRecords,
        statistics: this.getStatistics()
      }

      await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')

      logger.debug(LogCategory.FILE_ORGANIZATION, '保存备份清单', { manifestPath })
    } catch (error: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, '保存备份清单失败', {
        error: error.message
      })
    }
  }

  /**
   * 从清单文件加载备份记录
   */
  static async loadFromManifest(
    workspaceDirectoryPath: string,
    sessionId: string
  ): Promise<OrganizeBackupManager | null> {
    try {
      const backupDir = path.join(workspaceDirectoryPath, '.organize-backups', sessionId)
      const manifestPath = path.join(backupDir, 'manifest.json')

      if (!(await existsAsync(manifestPath))) {
        return null
      }

      const manifestContent = await fsp.readFile(manifestPath, 'utf-8')
      const manifest = JSON.parse(manifestContent)

      // 保持旧语义：备份目录由新建会话确定，随后仅覆盖 sessionId / records。
      const manager = await OrganizeBackupManager.create(workspaceDirectoryPath)
      manager.sessionId = manifest.sessionId
      manager.backupRecords = manifest.records

      logger.debug(LogCategory.FILE_ORGANIZATION, '从清单加载备份', {
        sessionId,
        recordCount: manager.backupRecords.length
      })

      return manager
    } catch (error: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, '加载备份清单失败', {
        sessionId,
        error: error.message
      })
      return null
    }
  }
}
