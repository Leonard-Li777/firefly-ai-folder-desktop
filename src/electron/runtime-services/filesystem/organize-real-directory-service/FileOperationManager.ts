import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import Database from 'better-sqlite3'
import { FileOperation, FileOrganizeResult } from '@firefly/types/organize-types'
import { LogCategory, logger, isPathEqual, assertPathWithinRoot } from '@firefly/shared'
import { TwoPhaseBatchCoordinator, sampleFileIdentity } from '../fs-journal-recovery'
import { FileSystemMutationDao } from '../../database/dao/file-system-mutation-dao'

const VIRTUAL_DIRECTORY_FOLDER = '.VirtualDirectory'

export class FileOperationManager {
  private readonly coordinator: TwoPhaseBatchCoordinator
  private readonly fsMutationDao: FileSystemMutationDao

  constructor(private db: Database.Database) {
    this.coordinator = new TwoPhaseBatchCoordinator(db)
    this.fsMutationDao = new FileSystemMutationDao(db)
  }

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

      const { databaseService } = await import('../../database/database-service')

      // 路径比较统一走 shared 原生工具（win32 忽略大小写，尾斜杠由 stripTrailingSlash 单独处理），禁止裸 !==
      if (!isPathEqual(actualOldPath, operation.newPath)) {
        const rootDir = await databaseService.findRootWorkspaceDirectory(actualOldPath)
        if (rootDir?.path) {
          await assertPathWithinRoot(rootDir.path, actualOldPath)
          await assertPathWithinRoot(rootDir.path, operation.newPath)
        } else {
          logger.warn(
            LogCategory.FILE_ORGANIZATION,
            `[一键整理] 未能解析到根工作区，无法执行网关断言: ${actualOldPath}`
          )
        }

        const targetDir = path.dirname(operation.newPath)
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true })
        }
      } else {
        logger.debug(LogCategory.FILE_ORGANIZATION, '源路径与目标路径相同，跳过移动', {
          path: actualOldPath
        })
      }

      // 移动前幂等补齐原路径记录：FileSystemMutationDao 依赖 workspace_files 旧路径行存在
      // 才能在同一事务内完成路径改写；源文件此刻仍在，statSync 可拿到真实大小与指纹。
      await databaseService.addFileFromPath(actualOldPath, '', undefined, true)

      const needsMove = !isPathEqual(actualOldPath, operation.newPath)
      // 采样身份是 journal 崩溃恢复的唯一判据：拿不到必须失败关闭，否则空串会让
      // observeFs 的 sampledHash.startsWith('') 恒真，把已变更文件误判为同身份。
      const fileIdentity = needsMove ? await sampleFileIdentity(actualOldPath) : null
      if (needsMove && !fileIdentity) {
        const errorMessage = `[一键整理] 无法采样文件身份，拒绝写入不可恢复的 journal: ${actualOldPath}`
        logger.warn(LogCategory.FILE_ORGANIZATION, errorMessage, { operation })
        return {
          fileId: operation.fileId,
          oldPath: operation.oldPath,
          newPath: operation.newPath,
          inode: 0,
          success: false,
          error: errorMessage
        }
      }

      // [Issue 04 收尾] 物理移动 + journal intent 由两阶段协调器统一接管：
      // 阶段一记 pending intent 并 rename；阶段二在单事务内由 FileSystemMutationDao
      // 原子更新 workspace_files(path/name/directory_id/mtime_ms) + FTS，并同步 journal committed。
      // 任一阶段失败由协调器逆向补偿，崩溃后可在重启时从 fs_operation_journal 重放/回滚。
      let movedMtimeMs: number | undefined
      const batchId = `organize_${crypto.randomUUID().slice(0, 8)}`
      const coordinatorResult = needsMove
        ? await this.coordinator.executeTwoPhaseBatch(
            batchId,
            [
              {
                // journal.id 为全局主键，必须用批次前缀隔离，禁止用稳定 fileId 导致二次整理撞 UNIQUE
                id: `${batchId}-${operation.fileId}`,
                fromPath: actualOldPath,
                toPath: operation.newPath,
                fileIdentity: fileIdentity!,
                op: 'move'
              }
            ],
            {
              onFsMoved: () => {
                // [Issue 04 Step 2] 移动后重新 stat 取 mtime_ms，供 FileGuard 增量围栏精准比对
                try {
                  movedMtimeMs = Math.trunc(fs.statSync(operation.newPath).mtimeMs)
                } catch (statErr: any) {
                  logger.warn(
                    LogCategory.FILE_ORGANIZATION,
                    '[一键整理] 移动后 stat 取 mtime_ms 失败，退回 0 触发 FileGuard 下轮全量校验',
                    { newPath: operation.newPath, error: statErr?.message }
                  )
                  movedMtimeMs = undefined
                }
              },
              commitDb: item => {
                // 权威写入必须校验结果：DAO 在旧路径行缺失时仅 warn 并返回 updated:0，
                // 此处必须抛错让协调器走物理逆向补偿，杜绝 journal 假 committed。
                const mutation = this.fsMutationDao.updateFilePathAtomic(
                  item.fromPath,
                  item.toPath,
                  movedMtimeMs
                )
                if (mutation.updated === 0) {
                  throw new Error(
                    `[一键整理] 权威路径改写未落库，拒绝提交 journal: ${item.fromPath} -> ${item.toPath}`
                  )
                }
              }
            }
          )
        : { success: true, committedCount: 0, compensatedCount: 0 }

      if (!coordinatorResult.success) {
        const errorMessage = `[一键整理] 两阶段提交失败，已走 journal 补偿: ${coordinatorResult.error?.message || 'unknown'}`
        logger.error(LogCategory.FILE_ORGANIZATION, errorMessage, { operation, batchId })
        return {
          fileId: operation.fileId,
          oldPath: operation.oldPath,
          newPath: operation.newPath,
          inode: 0,
          success: false,
          error: errorMessage
        }
      }

      // 既有幂等补齐：刷新新路径记录的文件大小/忽略标记并确保 files 记录存在（原流程语义保留）。
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
}
