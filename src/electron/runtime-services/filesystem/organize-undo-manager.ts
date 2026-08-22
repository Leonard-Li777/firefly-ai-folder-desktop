import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { logger, LogCategory } from '@firefly/shared'
import { OrganizeBackupManager, BackupRecord } from './organize-backup-manager'

/**
 * 文件移动操作记录
 */
export interface FileMove {
  fileId: number
  oldPath: string
  newPath: string
  timestamp: string
}

/**
 * 整理会话记录
 */
export interface OrganizeSession {
  sessionId: string
  timestamp: string
  workspaceDirectoryPath: string
  fileMoves: FileMove[]
  hasBackup: boolean
  backupDir?: string
}

/**
 * 撤销管理器
 * 负责记录整理操作并提供撤销功能
 */
export class OrganizeUndoManager {
  private session: OrganizeSession
  private backupManager?: OrganizeBackupManager

  constructor(
    workspaceDirectoryPath: string,
    private db: Database.Database,
    backupManager?: OrganizeBackupManager
  ) {
    this.session = {
      sessionId: new Date().toISOString().replace(/[:.]/g, '-'),
      timestamp: new Date().toISOString(),
      workspaceDirectoryPath,
      fileMoves: [],
      hasBackup: !!backupManager,
      backupDir: backupManager?.getStatistics().backupDir
    }
    this.backupManager = backupManager
  }

  /**
   * 记录文件移动操作
   */
  recordFileMove(fileId: number, oldPath: string, newPath: string): void {
    this.session.fileMoves.push({
      fileId,
      oldPath,
      newPath,
      timestamp: new Date().toISOString()
    })

    logger.debug(LogCategory.FILE_ORGANIZATION, '记录文件移动', {
      fileId,
      oldPath,
      newPath
    })
  }

  /**
   * 撤销所有文件移动操作
   */
  async undoAll(): Promise<{ success: number; failed: number }> {
    let success = 0
    let failed = 0

    logger.info(LogCategory.FILE_ORGANIZATION, '开始撤销整理操作', {
      sessionId: this.session.sessionId,
      totalMoves: this.session.fileMoves.length
    })

    // 按时间倒序撤销（最后移动的先撤销）
    const reversedMoves = [...this.session.fileMoves].reverse()

    for (const move of reversedMoves) {
      try {
        // 检查新位置的文件是否存在
        if (!fs.existsSync(move.newPath)) {
          logger.warn(LogCategory.FILE_ORGANIZATION, '新位置文件不存在，跳过', {
            newPath: move.newPath
          })
          failed++
          continue
        }

        // 检查旧位置是否已存在文件
        if (fs.existsSync(move.oldPath)) {
          // 如果有备份，可以选择恢复
          if (this.backupManager) {
            await this.backupManager.restoreFile(move.oldPath)
          } else {
            logger.warn(LogCategory.FILE_ORGANIZATION, '旧位置已存在文件，无法撤销', {
              oldPath: move.oldPath
            })
            failed++
            continue
          }
        }

        // 确保目标目录存在
        const oldDir = path.dirname(move.oldPath)
        if (!fs.existsSync(oldDir)) {
          fs.mkdirSync(oldDir, { recursive: true })
        }

        // 移动文件回原位置
        fs.renameSync(move.newPath, move.oldPath)

        // 更新数据库（V2.2 架构：路径存储在 workspace_files 表中）
        this.db
          .prepare('UPDATE workspace_files SET path = ?, modified_at = ? WHERE id = ?')
          .run(move.oldPath, new Date().toISOString(), move.fileId)

        success++

        logger.debug(LogCategory.FILE_ORGANIZATION, '文件撤销成功', {
          fileId: move.fileId,
          restoredPath: move.oldPath
        })
      } catch (error: any) {
        failed++
        logger.error(LogCategory.FILE_ORGANIZATION, '文件撤销失败', {
          fileId: move.fileId,
          oldPath: move.oldPath,
          newPath: move.newPath,
          error: error.message
        })
      }
    }

    logger.info(LogCategory.FILE_ORGANIZATION, '撤销操作完成', { success, failed })

    return { success, failed }
  }

  /**
   * 保存会话记录到文件
   */
  async saveSession(): Promise<void> {
    try {
      const sessionDir = path.join(this.session.workspaceDirectoryPath, '.organize-sessions')

      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true })
      }

      const sessionPath = path.join(sessionDir, `${this.session.sessionId}.json`)
      fs.writeFileSync(sessionPath, JSON.stringify(this.session, null, 2), 'utf-8')

      logger.info(LogCategory.FILE_ORGANIZATION, '保存整理会话', {
        sessionId: this.session.sessionId,
        sessionPath
      })
    } catch (error: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, '保存会话失败', {
        error: error.message
      })
    }
  }

  /**
   * 加载会话记录
   */
  static async loadSession(
    workspaceDirectoryPath: string,
    sessionId: string,
    db: Database.Database
  ): Promise<OrganizeUndoManager | null> {
    try {
      const sessionPath = path.join(
        workspaceDirectoryPath,
        '.organize-sessions',
        `${sessionId}.json`
      )

      if (!fs.existsSync(sessionPath)) {
        logger.warn(LogCategory.FILE_ORGANIZATION, '会话文件不存在', { sessionPath })
        return null
      }

      const sessionContent = fs.readFileSync(sessionPath, 'utf-8')
      const session: OrganizeSession = JSON.parse(sessionContent)

      // 加载备份管理器（如果有）
      let backupManager: OrganizeBackupManager | null = null
      if (session.hasBackup && session.backupDir) {
        backupManager = await OrganizeBackupManager.loadFromManifest(
          workspaceDirectoryPath,
          sessionId
        )
      }

      const manager = new OrganizeUndoManager(
        workspaceDirectoryPath,
        db,
        backupManager || undefined
      )
      manager.session = session

      logger.info(LogCategory.FILE_ORGANIZATION, '加载整理会话', {
        sessionId,
        moveCount: session.fileMoves.length
      })

      return manager
    } catch (error: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, '加载会话失败', {
        sessionId,
        error: error.message
      })
      return null
    }
  }

  /**
   * 列出所有可用的会话
   */
  static async listSessions(workspaceDirectoryPath: string): Promise<OrganizeSession[]> {
    try {
      const sessionDir = path.join(workspaceDirectoryPath, '.organize-sessions')

      if (!fs.existsSync(sessionDir)) {
        return []
      }

      const files = fs.readdirSync(sessionDir)
      const sessions: OrganizeSession[] = []

      for (const file of files) {
        if (file.toLowerCase().endsWith('.json')) {
          try {
            const sessionPath = path.join(sessionDir, file)
            const sessionContent = fs.readFileSync(sessionPath, 'utf-8')
            const session: OrganizeSession = JSON.parse(sessionContent)
            sessions.push(session)
          } catch (error) {
            // 跳过损坏的会话文件
          }
        }
      }

      // 按时间倒序排序
      sessions.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

      return sessions
    } catch (error: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, '列出会话失败', {
        error: error.message
      })
      return []
    }
  }

  /**
   * 删除会话记录
   */
  static async deleteSession(workspaceDirectoryPath: string, sessionId: string): Promise<void> {
    try {
      const sessionPath = path.join(
        workspaceDirectoryPath,
        '.organize-sessions',
        `${sessionId}.json`
      )

      if (fs.existsSync(sessionPath)) {
        fs.unlinkSync(sessionPath)
        logger.info(LogCategory.FILE_ORGANIZATION, '删除会话记录', { sessionId })
      }
    } catch (error: any) {
      logger.error(LogCategory.FILE_ORGANIZATION, '删除会话失败', {
        sessionId,
        error: error.message
      })
    }
  }

  /**
   * 获取会话信息
   */
  getSession(): OrganizeSession {
    return { ...this.session }
  }

  /**
   * 获取会话统计
   */
  getStatistics(): {
    totalMoves: number
    hasBackup: boolean
    backupFiles: number
    sessionId: string
  } {
    return {
      totalMoves: this.session.fileMoves.length,
      hasBackup: this.session.hasBackup,
      backupFiles: this.backupManager?.getStatistics().totalFiles || 0,
      sessionId: this.session.sessionId
    }
  }
}
