import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import Database from 'better-sqlite3'

/**
 * 数据库清理工具
 * 用于检查和清理数据库中的错误记录
 */
export class DatabaseCleanupTool {
  private dbPath: string

  constructor() {
    this.dbPath = path.join(app.getPath('userData'), 'yonuc-ai-folder.db')
  }

  /**
   * 检查数据库中的工作目录记录
   */
  async checkWorkspaceDirectories(): Promise<any[]> {
    if (!fs.existsSync(this.dbPath)) {
      console.log('数据库文件不存在:', this.dbPath)
      return []
    }

    const db = new Database(this.dbPath)
    try {
      const rows = db.prepare('SELECT * FROM workspaces ORDER BY created_at DESC').all()

      const results = rows.map(row => {
        const dirPath = row.path
        const exists = fs.existsSync(dirPath)

        return {
          id: row.workspace_id,
          path: dirPath,
          name: row.name,
          exists: exists,
          isActive: Boolean(row.is_active),
          createdAt: row.created_at,
          updatedAt: row.created_at
        }
      })

      return results
    } finally {
      db.close()
    }
  }

  /**
   * 清理不存在的工作目录记录
   */
  async cleanupInvalidDirectories(): Promise<number> {
    if (!fs.existsSync(this.dbPath)) {
      console.log('数据库文件不存在:', this.dbPath)
      return 0
    }

    const db = new Database(this.dbPath)
    try {
      const rows = db.prepare('SELECT * FROM workspaces').all()
      let deletedCount = 0

      for (const row of rows) {
        const dirPath = row.path
        if (!fs.existsSync(dirPath)) {
          console.log('删除不存在的工作目录:', dirPath)
          db.prepare('DELETE FROM workspaces WHERE workspace_id = ?').run(row.workspace_id)
          deletedCount++
        }
      }

      return deletedCount
    } finally {
      db.close()
    }
  }

  /**
   * 获取数据库文件信息
   */
  async getDatabaseInfo(): Promise<any> {
    if (!fs.existsSync(this.dbPath)) {
      return { exists: false, path: this.dbPath }
    }

    const stats = fs.statSync(this.dbPath)
    const db = new Database(this.dbPath)

    try {
      const workspaceCount = db.prepare('SELECT COUNT(*) as count FROM workspaces').get()
      const filesCount = db.prepare('SELECT COUNT(*) as count FROM files').get()
      const workspaceFilesCount = db.prepare('SELECT COUNT(*) as count FROM workspace_files').get()

      return {
        exists: true,
        path: this.dbPath,
        size: stats.size,
        workspaceDirectories: workspaceCount.count,
        files: filesCount.count,
        workspaceFiles: workspaceFilesCount.count,
        lastModified: stats.mtime
      }
    } finally {
      db.close()
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