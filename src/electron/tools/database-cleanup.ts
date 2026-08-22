import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'

/**
 * 数据库清理工具
 * 用于检查和清理数据库中的错误记录
 */
export class DatabaseCleanupTool {
  private userDataPath: string

  constructor() {
    this.userDataPath = app.getPath('userData')
  }

  /**
   * 获取所有数据库文件路径（支持多语言后缀）
   */
  private getDatabasePaths(): string[] {
    const files = fs.readdirSync(this.userDataPath)
    return files
      .filter(
        f =>
          f.startsWith('firefly-ai-folder') &&
          f.endsWith('.db') &&
          !f.endsWith('-shm') &&
          !f.endsWith('-wal')
      )
      .map(f => path.join(this.userDataPath, f))
  }

  /**
   * 检查数据库中的工作目录记录
   */
  async checkWorkspaceDirectories(): Promise<any[]> {
    const dbPaths = this.getDatabasePaths()
    if (dbPaths.length === 0) {
      console.log('未找到数据库文件')
      return []
    }

    const results: any[] = []
    for (const dbPath of dbPaths) {
      const db = new Database(dbPath)
      try {
        const rows = db.prepare('SELECT * FROM workspaces ORDER BY created_at DESC').all() as any[]
        for (const row of rows) {
          results.push({
            id: row.workspace_id,
            path: row.path,
            name: row.name,
            exists: fs.existsSync(row.path),
            isActive: Boolean(row.is_active),
            createdAt: row.created_at,
            updatedAt: row.created_at,
            database: path.basename(dbPath)
          })
        }
      } finally {
        db.close()
      }
    }

    return results
  }

  /**
   * 清理不存在的工作目录记录
   */
  async cleanupInvalidDirectories(): Promise<number> {
    const dbPaths = this.getDatabasePaths()
    if (dbPaths.length === 0) {
      console.log('未找到数据库文件')
      return 0
    }

    let deletedCount = 0
    for (const dbPath of dbPaths) {
      const db = new Database(dbPath)
      try {
        const rows = db.prepare('SELECT * FROM workspaces').all() as any[]
        for (const row of rows) {
          if (!fs.existsSync(row.path)) {
            console.log('删除不存在的工作目录:', row.path)
            db.prepare('DELETE FROM workspaces WHERE workspace_id = ?').run(row.workspace_id)
            deletedCount++
          }
        }
      } finally {
        db.close()
      }
    }

    return deletedCount
  }

  /**
   * 获取数据库文件信息
   */
  async getDatabaseInfo(): Promise<any> {
    const dbPaths = this.getDatabasePaths()
    if (dbPaths.length === 0) {
      return { exists: false, paths: [] }
    }

    const dbInfos = dbPaths.map(dbPath => {
      const stats = fs.statSync(dbPath)
      const db = new Database(dbPath)

      try {
        const workspaceCount = db.prepare('SELECT COUNT(*) as count FROM workspaces').get() as {
          count: number
        }
        const filesCount = db.prepare('SELECT COUNT(*) as count FROM files').get() as {
          count: number
        }
        const workspaceFilesCount = db
          .prepare('SELECT COUNT(*) as count FROM workspace_files')
          .get() as { count: number }

        return {
          path: dbPath,
          fileName: path.basename(dbPath),
          size: stats.size,
          workspaceDirectories: workspaceCount.count,
          files: filesCount.count,
          workspaceFiles: workspaceFilesCount.count,
          lastModified: stats.mtime
        }
      } finally {
        db.close()
      }
    })

    return {
      exists: true,
      databases: dbInfos
    }
  }
}

// 如果直接运行此文件，执行清理操作
if (require.main === module) {
  const tool = new DatabaseCleanupTool()

  tool.getDatabaseInfo().then(info => {
    console.log('数据库信息:', info)

    if (info.exists) {
      tool.checkWorkspaceDirectories().then(directories => {
        console.log('工作目录检查结果:')
        directories.forEach(dir => {
          console.log(`  ${dir.path} - 存在: ${dir.exists} - 激活: ${dir.isActive}`)
        })

        tool.cleanupInvalidDirectories().then(count => {
          console.log(`清理了 ${count} 个无效的工作目录记录`)
        })
      })
    }
  })
}
