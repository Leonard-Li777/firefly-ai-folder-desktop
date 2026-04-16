import type { AIClassificationResult, ArchiveFileInfo, FileInfo, LanguageCode, WorkspaceDirectory } from '@yonuc/types'
import { LogCategory, logger } from '@yonuc/shared'
import type { Unit, UnitCreationData } from '@yonuc/types'
import { getDatabaseConfig, migrations } from './database'

import Database from 'better-sqlite3'
import { calculateFileFingerprint, type FileFingerprint } from '@yonuc/core-engine/utils/file-fingerprint'
import * as fs from 'fs'
import * as path from 'path'
import { t } from '@app/languages'

import { WorkspaceDao, FileDao, TagUnitDao, QueueDao } from './dao'
import { configService } from '../config'

/**
 * 数据库服务 Facade
 * 负责 SQLite 数据库 of 初始化、迁移以及将 CRUD 操作转发给各个 DAO
 */
export class DatabaseService {
  private _db: Database.Database | null = null
  private dbPath: string

  private workspaceDao!: WorkspaceDao
  private fileDao!: FileDao
  private tagUnitDao!: TagUnitDao
  private queueDao!: QueueDao

  get db(): Database.Database | null {
    return this._db
  }

  constructor(dbPath: string) {
    this.dbPath = dbPath
  }

  async initialize(language?: LanguageCode): Promise<void> {
    try {
      if (this._db) return

      const config = getDatabaseConfig(language)
      this.dbPath = config.path

      const dir = path.dirname(this.dbPath)
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

      // 检查是否存在迁移失败的备份文件，如果是则先恢复
      const backupPath = this.getBackupPath()
      if (fs.existsSync(backupPath)) {
        logger.info(LogCategory.DATABASE_SERVICE, '检测到迁移备份文件，正在恢复...')
        try {
          // 先关闭任何可能打开的连接
          if (this._db) {
            const dbToClose = this._db;
            (dbToClose as any).close()
            this._db = null
          }
          // 恢复备份
          fs.copyFileSync(backupPath, this.dbPath)
          // 恢复 WAL 和 SHM 文件（如果存在）
          if (fs.existsSync(backupPath + '-wal')) {
            fs.copyFileSync(backupPath + '-wal', this.dbPath + '-wal')
          }
          if (fs.existsSync(backupPath + '-shm')) {
            fs.copyFileSync(backupPath + '-shm', this.dbPath + '-shm')
          }
          // 删除备份（恢复成功后不再需要）
          this.deleteBackupFiles()
          logger.info(LogCategory.DATABASE_SERVICE, '数据库已从备份恢复')
        } catch (restoreError) {
          logger.error(LogCategory.DATABASE_SERVICE, '恢复备份失败', { error: restoreError })
          // 即使恢复失败，也继续尝试打开数据库
        }
      }

      this._db = new Database(this.dbPath)

      this.workspaceDao = new WorkspaceDao(this._db)
      this.fileDao = new FileDao(this._db)
      this.tagUnitDao = new TagUnitDao(this._db)
      this.queueDao = new QueueDao(this._db)

      this._db.pragma(`journal_mode = ${config.pragma.journal_mode}`)
      this._db.pragma(`synchronous = ${config.pragma.synchronous}`)
      this._db.pragma(`cache_size = ${config.pragma.cache_size}`)

      if (config.migrations) {
        await this.createTables()
        await this.runMigrationsWithBackup(language)
        await this.ensureTablesExist()
      }

      this.repairAnalyzedStatus()
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '数据库初始化失败', { error, dbPath: this.dbPath })
      throw error
    }
  }

  /**
   * 获取备份文件路径（语言特定）
   */
  private getBackupPath(): string {
    return this.dbPath.replace(/\.db$/, '_v1_backup.db')
  }

  /**
   * 删除备份文件
   */
  private deleteBackupFiles(): void {
    const backupPath = this.getBackupPath()
    try {
      if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath)
      if (fs.existsSync(backupPath + '-wal')) fs.unlinkSync(backupPath + '-wal')
      if (fs.existsSync(backupPath + '-shm')) fs.unlinkSync(backupPath + '-shm')
    } catch (error) {
      logger.warn(LogCategory.DATABASE_SERVICE, '删除备份文件失败', { error })
    }
  }

  /**
   * 创建数据库备份
   */
  private createBackup(): string {
    const backupPath = this.getBackupPath()
    try {
      // 先确保 WAL 模式已检查点，确保数据完整性
      this._db!.pragma('wal_checkpoint(TRUNCATE)')
      fs.copyFileSync(this.dbPath, backupPath)
      // 同时备份 WAL 和 SHM 文件（如果存在）
      if (fs.existsSync(this.dbPath + '-wal')) {
        fs.copyFileSync(this.dbPath + '-wal', backupPath + '-wal')
      }
      if (fs.existsSync(this.dbPath + '-shm')) {
        fs.copyFileSync(this.dbPath + '-shm', backupPath + '-shm')
      }
      logger.info(LogCategory.DATABASE_SERVICE, `数据库备份已创建: ${backupPath}`)
      return backupPath
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '创建数据库备份失败', { error })
      throw error
    }
  }

  /**
   * 带备份的迁移流程
   */
  private async runMigrationsWithBackup(language?: LanguageCode): Promise<void> {
    const userVersion = this._db!.pragma('user_version', { simple: true }) as number
    
    // 只有需要迁移时才创建备份
    const needsMigration = migrations.some(m => m.version > userVersion)
    
    if (!needsMigration) {
      // 不需要迁移，直接正常执行
      await this.runMigrations()
      return
    }

    // 需要迁移，先创建备份
    logger.info(LogCategory.DATABASE_SERVICE, '需要数据库迁移，正在创建备份...')
    this.createBackup()

    try {
      await this.runMigrations()
      // 迁移成功，删除备份（含 WAL/SHM）
      this.deleteBackupFiles()
      logger.info(LogCategory.DATABASE_SERVICE, '迁移成功，已删除备份')
    } catch (migrationError) {
      logger.error(LogCategory.DATABASE_SERVICE, '数据库迁移失败', { error: migrationError })

      // 关闭数据库连接以便恢复
      if (this._db) {
        this._db.close()
        this._db = null
      }

      // 显示错误对话框（等待用户操作）
      await this.showMigrationErrorDialog(migrationError)

      // 抛出错误让应用知道迁移失败
      throw migrationError
    }
  }

  /**
   * 显示迁移失败错误对话框
   */
  private async showMigrationErrorDialog(error: any): Promise<void> {
    try {
      const { dialog, BrowserWindow, app } = await import('electron')
      const errorMessage = error instanceof Error ? error.message : String(error)
      const backupPath = this.getBackupPath()

      const message = `数据库升级失败

错误原因: ${errorMessage}

您的原始数据已安全备份到:
${backupPath}

请尝试以下操作:
1. 点击「重新启动」按钮，系统将自动从备份恢复并重新升级

2. 如果问题持续存在，请联系开发者协助:
   微信: reloaded1234567`

      // 等待窗口就绪（最多等待 5 秒）
      let attempts = 0
      while (BrowserWindow.getAllWindows().length === 0 && attempts < 50) {
        await new Promise(resolve => setTimeout(resolve, 100))
        attempts++
      }

      if (BrowserWindow.getAllWindows().length > 0) {
        const result = await dialog.showMessageBox(BrowserWindow.getAllWindows()[0], {
          type: 'error',
          title: '数据库升级失败',
          message: '数据库升级失败',
          detail: message,
          buttons: ['重新启动', '退出应用'],
          defaultId: 0,
          cancelId: 1,
        })

        if (result.response === 0) {
          // 用户选择重新启动
          logger.info(LogCategory.DATABASE_SERVICE, '用户选择重新启动应用')
          // 关闭当前窗口
          BrowserWindow.getAllWindows().forEach(win => {
            if (!win.isDestroyed()) win.close()
          })
          // 重启应用
          app.relaunch()
          app.exit(0)
        } else {
          // 用户选择退出
          logger.info(LogCategory.DATABASE_SERVICE, '用户选择退出应用')
          app.exit(1)
        }
      } else {
        // 没有窗口时，使用无父窗口的对话框
        logger.warn(LogCategory.DATABASE_SERVICE, '没有可用窗口，将创建独立对话框')
        const result = await dialog.showMessageBox({
          type: 'error',
          title: '数据库升级失败',
          message: '数据库升级失败',
          detail: message,
          buttons: ['重新启动', '退出应用'],
          defaultId: 0,
          cancelId: 1,
        })

        if (result.response === 0) {
          logger.info(LogCategory.DATABASE_SERVICE, '用户选择重新启动应用')
          app.relaunch()
          app.exit(0)
        } else {
          logger.info(LogCategory.DATABASE_SERVICE, '用户选择退出应用')
          app.exit(1)
        }
      }
    } catch (dialogError) {
      // 对话框本身失败，记录错误并退出
      logger.error(LogCategory.DATABASE_SERVICE, '显示错误对话框失败', { error: dialogError })
      const { app } = await import('electron')
      app.exit(1)
    }
  }

  /**
   * 检查并升级旧版指纹（16位MD5、64位SHA-256等）
   * 同时重置所有已同步数据的同步状态，以便重新同步到云端
   * 
   * 注意：此方法只在 V1->V2.2 升级过程中执行一次
   * 由 runV2_1MigrationDataScript 设置 PENDING_FINGERPRINT_UPGRADE 标记触发
   */
  public async checkAndUpgradeFingerprints(): Promise<void> {
    if (!this._db) {
      logger.error(LogCategory.DATABASE_SERVICE, '维护任务启动失败：数据库无法初始化')
      return
    }
    
    // 【关键】检查是否需要执行指纹升级（仅在V1->V2.2升级时执行一次）
    const pendingUpgrade = configService.getValue<boolean>('PENDING_FINGERPRINT_UPGRADE')
    if (!pendingUpgrade) {
      logger.debug(LogCategory.DATABASE_SERVICE, '跳过指纹升级：未检测到升级标记')
      return
    }
    
    logger.info(LogCategory.DATABASE_SERVICE, '检测到指纹升级标记，开始执行...')
    
    try {
      // 查询所有非标准指纹长度的文件记录（标准为32位Base62）
      // 包括：16位（MD5）、64位（SHA-256）、空值、temp_开头的临时指纹
      const legacyFiles = this._db!.prepare(`
        SELECT DISTINCT wf.file_fingerprint, wf.path
        FROM workspace_files wf
        WHERE wf.file_fingerprint IS NULL
           OR wf.file_fingerprint = ''
           OR wf.file_fingerprint LIKE 'temp_%'
           OR LENGTH(wf.file_fingerprint) != 32
      `).all() as Array<{ file_fingerprint: string, path: string }>

      if (legacyFiles.length > 0) {
        logger.info(LogCategory.DATABASE_SERVICE, `发现 ${legacyFiles.length} 个非标准指纹需要升级`)

        // 发送通知 (支持多语言)
        this.notifyFrontend('info', t('萤核智能文件夹数据正在升级中，请耐心等待...'), true, 'fingerprint-upgrade-task')

        let successCount = 0
        for (const file of legacyFiles) {
          const isSuccess = await this.upgradeSingleFileFingerprint(file.file_fingerprint || '', file.path)
          if (isSuccess) successCount++
        }

        logger.info(LogCategory.DATABASE_SERVICE, `旧版指纹升级完成，成功更新 ${successCount}/${legacyFiles.length} 个`)
        
        // 发送完成通知
        this.notifyFrontend('success', t('数据升级完成！'), false, 'fingerprint-upgrade-task', 3000)
      } else {
        logger.debug(LogCategory.DATABASE_SERVICE, '未发现需要升级的旧版指纹') 
      }

      // 【关键】重置所有已同步数据的同步状态，以便重新同步到云端
      // 这是为了应对云端数据清空或指纹算法升级的场景
      await this.resetSyncStatusForAllData()
      
      // 【关键】清除升级标记，确保只执行一次
      configService.updateValue('PENDING_FINGERPRINT_UPGRADE', false)
      logger.info(LogCategory.DATABASE_SERVICE, '指纹升级任务完成，已清除升级标记')
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '检查或升级旧版指纹失败', { error })
    }
  }

  /**
   * 重置所有已同步数据的同步状态
   * 用于云端数据清空后重新同步的场景
   */
  private async resetSyncStatusForAllData(): Promise<void> {
    if (!this._db) return

    try {
      // 【关键判定】检查是否有已分析的文件 (is_analyzed = 1)
      // 只要文件已分析过，就需要将其状态重置为“待同步”和“待比对”，以应对云端清空
      const analyzedCount = this._db!.prepare(`
        SELECT COUNT(*) as count 
        FROM workspace_files 
        WHERE is_analyzed = 1
      `).get() as { count: number }
      
      if (analyzedCount.count > 0) {
        logger.info(LogCategory.DATABASE_SERVICE, `检测到 ${analyzedCount.count} 条已分析记录，重置所有同步和命中状态...`)

        // 事务性重置
        const resetTx = this._db!.transaction(() => {
          // 1. 重置核心分析数据：sync_status=0 (待同步), is_hit=0 (待比对)
          // 只要指纹对应的文件在任何地方被分析过，就应该重置
          const filesResult = this._db!.prepare(`
            UPDATE files 
            SET sync_status = 0, is_hit = 0, last_hit_at = NULL 
            WHERE file_fingerprint IN (SELECT file_fingerprint FROM workspace_files WHERE is_analyzed = 1)
          `).run()
          
          // 2. 重置标签关联
          const tagRelResult = this._db!.prepare(`
            UPDATE file_tag_relations 
            SET sync_status = 0 
            WHERE file_fingerprint IN (SELECT file_fingerprint FROM workspace_files WHERE is_analyzed = 1)
          `).run()
          
          // 3. 重置标签定义（所有本地标签都标记为待同步）
          const tagsResult = this._db!.prepare(`UPDATE file_tags SET sync_status = 0 WHERE sync_status != 0`).run()
          
          // 4. 重置标签和维度提案
          let tagExpResult = { changes: 0 }
          try { tagExpResult = this._db!.prepare(`UPDATE tag_expansions SET sync_status = 0 WHERE sync_status != 0`).run() } catch (e) {}
          
          let dimExpResult = { changes: 0 }
          try { dimExpResult = this._db!.prepare(`UPDATE dimension_expansions SET sync_status = 0 WHERE sync_status != 0`).run() } catch (e) {}
          
          logger.info(LogCategory.DATABASE_SERVICE, `同步状态重置完成: files=${filesResult.changes}, tag_rels=${tagRelResult.changes}, tags=${tagsResult.changes}, tagExp=${tagExpResult.changes}, dimExp=${dimExpResult.changes}`)
        })

        resetTx()
      } else {
        logger.debug(LogCategory.DATABASE_SERVICE, '没有需要重置的已分析数据')
      }
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '重置同步状态失败', { error })
    }
  }

  /**
   * 升级单个文件的指纹
   */
  private async upgradeSingleFileFingerprint(oldFingerprint: string, filePath: string): Promise<boolean> {
    if (!this._db) return false

    try {
      if (!fs.existsSync(filePath)) {
        logger.warn(LogCategory.DATABASE_SERVICE, `升级指纹跳过：物理文件不存在`, { filePath })
        return false
      }

      const realFingerprint = await this.calculateFileFingerprint(filePath)
      if (realFingerprint === oldFingerprint) return true

      const migrationTx = this._db.transaction(() => {
        const existingFile = this._db!.prepare('SELECT file_fingerprint FROM files WHERE file_fingerprint = ?').get(realFingerprint)

        if (!existingFile) {
          // 迁移 files 表数据，显式设置 sync_status = 0（待同步）
          this._db!.prepare(`
            INSERT INTO files (file_fingerprint, smart_name, description, size, type, mime_type, author, language, is_hit, last_hit_at, sync_status, created_at, modified_at, accessed_at)
            SELECT ?, smart_name, description, size, type, mime_type, author, language, is_hit, last_hit_at, 0, created_at, modified_at, accessed_at
            FROM files WHERE file_fingerprint = ?
          `).run(realFingerprint, oldFingerprint)

          // 迁移 file_contents 表数据
          this._db!.prepare(`
            INSERT INTO file_contents (file_fingerprint, content, multimodal_content, lrc, metadata, analysis_stats, quality_score, quality_confidence, quality_criteria, quality_reasoning, grouping_reason, grouping_confidence)
            SELECT ?, content, multimodal_content, lrc, metadata, analysis_stats, quality_score, quality_confidence, quality_criteria, quality_reasoning, grouping_reason, grouping_confidence
            FROM file_contents WHERE file_fingerprint = ?
          `).run(realFingerprint, oldFingerprint)
        } else {
          // 【关键修复】新指纹已存在时，也需要重置 sync_status 为 0
          // 因为云端数据已清空，需要重新同步
          this._db!.prepare('UPDATE files SET sync_status = 0 WHERE file_fingerprint = ?').run(realFingerprint)
          logger.debug(LogCategory.DATABASE_SERVICE, `新指纹已存在，重置 sync_status: ${realFingerprint.substring(0, 8)}...`)
        }

        // 更新关联表
        this._db!.prepare('UPDATE workspace_files SET file_fingerprint = ? WHERE file_fingerprint = ?').run(realFingerprint, oldFingerprint)
        this._db!.prepare('UPDATE file_tag_relations SET file_fingerprint = ?, sync_status = 0 WHERE file_fingerprint = ?').run(realFingerprint, oldFingerprint)

        // 清理旧记录 (如果没有其他引用)
        const stillReferenced = this._db!.prepare('SELECT 1 FROM workspace_files WHERE file_fingerprint = ? LIMIT 1').get(oldFingerprint)
        if (!stillReferenced) {
          this._db!.prepare('DELETE FROM file_contents WHERE file_fingerprint = ?').run(oldFingerprint)
          this._db!.prepare('DELETE FROM files WHERE file_fingerprint = ?').run(oldFingerprint)
        }
      })

      migrationTx()
      return true
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, `升级单文件指纹失败: ${filePath}`, { error })
      return false
    }
  }

  /**
   * 通用的前端通知方法
   */
  private async notifyFrontend(type: 'info' | 'success' | 'warning' | 'error', message: string, sticky: boolean = false, id?: string, autoClose?: number): Promise<void> {
    try {
      const { BrowserWindow } = await import('electron')
      BrowserWindow.getAllWindows().forEach(win => {
        if (!win.isDestroyed()) win.webContents.send('system:notification', { type, message, sticky, id, autoClose })
      })
    } catch (e) {
      logger.warn(LogCategory.DATABASE_SERVICE, '发送前端通知失败', { error: e, message })
    }
  }

  private repairAnalyzedStatus(): void {
    if (!this._db) return
    try {
      // 检查当前数据库版本
      const userVersion = this._db.pragma('user_version', { simple: true }) as number
      
      if (userVersion < 2) {
        // V1 版本：files 表有 is_analyzed 列
        try {
          const result = this._db.prepare(`
            UPDATE files
            SET is_analyzed = 1, last_analyzed_at = CURRENT_TIMESTAMP
            WHERE is_analyzed = 0 AND (smart_name IS NOT NULL OR description IS NOT NULL)
          `).run()
          if (result.changes > 0) {
            logger.info(LogCategory.DATABASE_SERVICE, `已修复 ${result.changes} 条记录的已分析状态 (V1)`)
          }
        } catch (error: any) {
          // 如果 V1 表结构不存在 is_analyzed 列，忽略错误
          if (!error.message?.includes('no such column')) {
            throw error
          }
        }
      } else {
        // V2.1 版本：workspace_files 表有 is_analyzed 列
        try {
          const result = this._db.prepare(`
            UPDATE workspace_files
            SET is_analyzed = 1, last_analyzed_at = CURRENT_TIMESTAMP
            WHERE is_analyzed = 0 
              AND file_fingerprint IN (
                SELECT file_fingerprint FROM files 
                WHERE smart_name IS NOT NULL OR description IS NOT NULL
              )
          `).run()
          if (result.changes > 0) {
            logger.info(LogCategory.DATABASE_SERVICE, `已修复 ${result.changes} 条记录的已分析状态 (V2.2)`)
          }
        } catch (error: any) {
          // 如果表结构不匹配，记录警告但不抛出错误
          logger.warn(LogCategory.DATABASE_SERVICE, '修复已分析状态失败（可能是迁移未完成）', { error: error.message })
        }
      }
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '修复已分析状态失败:', error) 
    }
  }

  private async createTables(): Promise<void> {
    if (!this._db) throw new Error('数据库未初始化')
    try {
      this._db.pragma('foreign_keys = ON')
      const userVersion = this._db.pragma('user_version', { simple: true }) as number
      
      if (userVersion === 0) {
        // user_version = 0 有两种情况：
        // 1. 全新安装：数据库文件刚创建，没有任何表
        // 2. 老版本用户：已发布的 V1 版本没有设置 user_version，但已经有 V1 表结构和数据
        
        // 通过检查 V1 的核心表是否存在来判断
        const v1TablesExist = this._db.prepare(`
          SELECT count(*) as count FROM sqlite_master 
          WHERE type='table' AND name IN ('files', 'workspace_directories', 'file_tags')
        `).get() as any
        
        const hasV1Tables = v1TablesExist.count >= 3
        
        if (hasV1Tables) {
          // 情况2：老版本用户，已经有 V1 表结构
          logger.info(LogCategory.DATABASE_SERVICE, '检测到老版本数据库（user_version = 0 但存在 V1 表），设置版本号为 1')
          this._db.pragma(`user_version = 1`)
        } else {
          // 情况1：全新安装
          logger.info(LogCategory.DATABASE_SERVICE, '检测到全新安装场景（user_version = 0 且无 V1 表）')
          
          // 全新安装时，只执行 V1 迁移，然后让 runMigrations() 处理后续版本
          const v1Migration = migrations.find(m => m.version === 1)
          if (v1Migration) {
            logger.info(LogCategory.DATABASE_SERVICE, `正在执行迁移版本 ${v1Migration.version}: ${v1Migration.name}`)
            this._db.exec(v1Migration.up)
            this._db.pragma(`user_version = 1`)
            logger.info(LogCategory.DATABASE_SERVICE, `V1 架构初始化完成，数据库版本已设置为 1`)
          }
        }
      } else if (userVersion === 2) {
        // 检查 V2.1 的核心表是否存在
        // 如果 user_version = 2 但表不存在，说明之前的迁移失败了
        const v2TablesExist = this._db.prepare(`
          SELECT count(*) as count FROM sqlite_master 
          WHERE type='table' AND name IN ('workspace_files', 'file_contents', 'workspaces')
        `).get() as any
        
        const hasV2Tables = v2TablesExist.count >= 3
        
        if (!hasV2Tables) {
          // V2.1 表不存在，但 user_version = 2，说明迁移失败
          logger.warn(LogCategory.DATABASE_SERVICE, '检测到数据库版本不一致：user_version = 2 但 V2.1 表不存在，重置版本号为 1')
          
          // 检查是否有 V1 表
          const v1TablesExist = this._db.prepare(`
            SELECT count(*) as count FROM sqlite_master 
            WHERE type='table' AND name IN ('files', 'workspace_directories', 'file_tags')
          `).get() as any
          
          if (v1TablesExist.count >= 3) {
            // 有 V1 表，重置为版本 1，让 runMigrations() 重新执行迁移
            this._db.pragma(`user_version = 1`)
            logger.info(LogCategory.DATABASE_SERVICE, '已重置版本号为 1，将重新执行 V2.1 迁移')
          } else {
            // 既没有 V1 表也没有 V2.1 表，数据库损坏
            logger.error(LogCategory.DATABASE_SERVICE, '数据库损坏：user_version = 2 但没有任何表，重置为版本 0')
            this._db.pragma(`user_version = 0`)
            // 递归调用自己重新初始化
            return this.createTables()
          }
        } else {
          logger.info(LogCategory.DATABASE_SERVICE, `检测到版本升级场景，当前版本: ${userVersion}`)
          }
      } else {
        logger.info(LogCategory.DATABASE_SERVICE, `检测到版本升级场景，当前版本: ${userVersion}`)
      }
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '创建数据表失败', { error })  
      throw error
    }
  }

  /**
   * 确保所有必要的表存在
   * 如果表缺失（例如由于迁移中断），则重新创建
   */
  private async ensureTablesExist(): Promise<void> {
    if (!this._db) return

    try {
      // 只检查 V1 的核心表
      const requiredTables = [
        'workspace_directories',
        'files',
        'file_tags',
        'file_dimensions',
        'file_tag_relations',
        'file_units',
        'file_unit_relations',
        'virtual_directories'
      ]

      const existingTables = this._db.prepare(`
        SELECT name FROM sqlite_master 
        WHERE type='table' AND name NOT LIKE 'sqlite_%'
      `).all() as Array<{ name: string }>

      const existingTableNames = new Set(existingTables.map(t => t.name))
      const missingTables = requiredTables.filter(t => !existingTableNames.has(t))

      if (missingTables.length > 0) {
        logger.warn(LogCategory.DATABASE_SERVICE, `检测到缺失的表: ${missingTables.join(', ')}，正在修复...`)

        // 如果缺失关键表，重新执行迁移
        if (missingTables.some(t => ['workspace_directories', 'files'].includes(t))) {
          logger.info(LogCategory.DATABASE_SERVICE, '检测到关键表缺失，正在重新执行迁移...')

          // 重置 user_version 以强制重新执行迁移
          const currentVersion = this._db.pragma('user_version', { simple: true }) as number
          this._db.pragma('user_version = 0')

          try {
            await this.createTables()
            await this.runMigrations()
          } catch (err) {
            // 恢复原始版本
            this._db.pragma(`user_version = ${currentVersion}`)
            throw err
          }
        } else {
          // 非关键表缺失，直接创建
          for (const tableName of missingTables) {
            if (tableName === 'virtual_directories') {
              logger.info(LogCategory.DATABASE_SERVICE, '重新创建 virtual_directories 表...')
              this._db.exec(`
                CREATE TABLE IF NOT EXISTS virtual_directories (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  description TEXT,
                  filters TEXT NOT NULL,
                  parent_id TEXT,
                  workspace_id INTEGER NOT NULL,
                  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                  FOREIGN KEY (workspace_id) REFERENCES workspace_directories(id) ON DELETE CASCADE,
                  FOREIGN KEY (parent_id) REFERENCES virtual_directories(id) ON DELETE CASCADE
                );
              `)
            }
          }
        }
      }
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '表完整性检查失败', { error })
      // 向外抛出错误，关键表缺失时不应继续运行
      throw error
    }
  }

  async calculateFileFingerprint(filePath: string): Promise<string> {
    try { return await calculateFileFingerprint(path.resolve(filePath)) }
    catch (err: any) {
      if (err.code === 'EISDIR') return 'directory-hash'
      logger.error(LogCategory.DATABASE_SERVICE, '计算文件哈希失败，使用默认值', { filePath, error: err.message })
      return '0'.repeat(32)
    }
  }

  private async runMigrations(): Promise<void> {
    if (!this._db) throw new Error('数据库未初始化')
    try {
      const userVersion = this._db.pragma('user_version', { simple: true }) as number
      logger.info(LogCategory.DATABASE_SERVICE, `当前数据库版本: ${userVersion}`)
      
      for (const migration of migrations) {
        if (migration.version > userVersion) {
          logger.info(LogCategory.DATABASE_SERVICE, `正在执行迁移版本 ${migration.version}: ${migration.name}`)
          
          try {
            // 先执行 SQL 脚本（创建新表），但不设置 user_version
            this._db.transaction(() => {
              this._db!.exec(migration.up)
            })()
            
            logger.info(LogCategory.DATABASE_SERVICE, `迁移版本 ${migration.version} 的表结构创建完成`)
            
            // V2.1 迁移需要额外的数据迁移步骤
            if (migration.version === 2) {
              logger.info(LogCategory.DATABASE_SERVICE, '开始执行 V2.1 数据迁移脚本...')
              await this.runV2_1MigrationDataScript()
              logger.info(LogCategory.DATABASE_SERVICE, 'V2.1 数据迁移脚本执行完成')
            }
            
            // 只有在所有迁移步骤成功后，才设置 user_version
            this._db.pragma(`user_version = ${migration.version}`)
            logger.info(LogCategory.DATABASE_SERVICE, `迁移版本 ${migration.version} 完成，数据库版本已更新为 ${migration.version}`)
          } catch (migrationError) {
            logger.error(LogCategory.DATABASE_SERVICE, `迁移版本 ${migration.version} 失败`, { error: migrationError })
            // 不设置 user_version，让下次启动时重试
            throw migrationError
          }
        }
      }
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '执行数据库迁移失败', { error })
      throw error
    }
  }

  /**
   * V2.1 架构重构数据迁移脚本
   * 负责：目录实体回归、目录-文件 NOT NULL 关联建立、内容指纹重算、FTS初始化
   */
  private async runV2_1MigrationDataScript(): Promise<void> {
    if (!this._db) return
    
    // 1. 场景探测：检查 V1 表是否有数据
    // 注意：不能只检查 user_version，因为老版本的 V1 没有设置 user_version
    const v1TableInfo = this._db.prepare("SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='files'").get() as any;
    let isFreshInstall = true;
    
    if (v1TableInfo && v1TableInfo.count > 0) {
      // V1 的 files 表存在，检查是否有数据
      const rowCount = (this._db.prepare("SELECT count(*) as count FROM files").get() as any).count;
      isFreshInstall = rowCount === 0;
    }

    logger.info(LogCategory.DATABASE_SERVICE, isFreshInstall ? '检测到全新安装场景，正在初始化 V2.1 结构...' : '检测到版本升级场景，开始执行 V2.1 数据迁移...');

    // 禁用外键约束，避免迁移过程中的级联检查问题
    this._db.pragma('foreign_keys = OFF');
    logger.info(LogCategory.DATABASE_SERVICE, '已禁用外键约束进行迁移');

    try {
      if (!isFreshInstall) {
        this.notifyFrontend('info', t('正在升级文件夹架构，请稍候...'), true, 'v2-1-migration')
      }

      const workspaces = this._db.prepare('SELECT workspace_id, path FROM workspaces').all() as Array<{ workspace_id: number, path: string }>

      // 检查 workspaces 表是否为空
      if (workspaces.length === 0 && !isFreshInstall) {
        logger.warn(LogCategory.DATABASE_SERVICE, 'workspaces 表为空，尝试从 workspace_directories 补充数据')

        // 如果 workspaces 表为空，尝试从 workspace_directories 中获取所有目录作为工作区
        const allDirs = this._db.prepare('SELECT * FROM workspace_directories ORDER BY id ASC LIMIT 1').all() as any[]

        if (allDirs.length > 0) {
          // 至少添加第一个目录作为工作区
          const firstDir = allDirs[0]
          this._db.prepare(`
            INSERT OR IGNORE INTO workspaces (workspace_id, path, name, type, is_active, auto_watch, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(firstDir.id, firstDir.path, firstDir.name, firstDir.type || 'SPEEDY', 1, firstDir.auto_watch || 0, firstDir.created_at || new Date().toISOString())

          // 重新查询
          workspaces.push({
            workspace_id: firstDir.id,
            path: firstDir.path
          })

          logger.info(LogCategory.DATABASE_SERVICE, `已添加默认工作区: ${firstDir.path}`)
        } else {
          logger.error(LogCategory.DATABASE_SERVICE, 'workspace_directories 表也为空，无法继续迁移')
          throw new Error('无法迁移：workspace_directories 表为空')
        }
      }

      const dirPathToIdMap = new Map<string, number>()
      // 保存旧 ID 到新表主键的映射，用于后续迁移关联表（需要在 if 块外定义以便在结构转正时访问）
      const idMapping = new Map<string, { dirId: string, fingerprint: string }>()
      // 备份旧关联表数据
      let oldTagRelations: any[] = [];
      let oldUnitRelations: any[] = [];

      if (!isFreshInstall) {
        // A. 迁移目录
        logger.info(LogCategory.DATABASE_SERVICE, '步骤 A: 开始迁移目录数据...')
        const oldDirs = this._db.prepare('SELECT * FROM workspace_directories').all() as any[]
        logger.info(LogCategory.DATABASE_SERVICE, `找到 ${oldDirs.length} 个目录需要迁移`)
        
        this._db.transaction(() => {
          let dirMigratedCount = 0
          for (const oldDir of oldDirs) {
            const dirPath = oldDir.path;

            // 查找匹配的工作区
            let wsId = workspaces.find(ws => dirPath.startsWith(ws.path))?.workspace_id;

            // 如果找不到匹配的工作区，使用第一个工作区（如果存在）
            if (!wsId && workspaces.length > 0) {
              wsId = workspaces[0].workspace_id;
              logger.warn(LogCategory.DATABASE_SERVICE, `目录 ${dirPath} 找不到匹配的工作区，使用默认工作区 ${workspaces[0].path}`);
            }

            // 如果还是没有，跳过这个目录
            if (!wsId) {
              logger.error(LogCategory.DATABASE_SERVICE, `目录 ${dirPath} 无法找到有效的工作区，跳过迁移`);
              continue;
            }

            // 插入目录记录，SQLite 会自动生成自增 ID
            const stmt = this._db!.prepare(`
              INSERT INTO workspace_directories_v2
              (workspace_id, path, name, context_analysis, is_analyzed, last_analyzed_at, created_at, modified_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            const result = stmt.run(wsId, oldDir.path, oldDir.name, oldDir.context_analysis, 0, null, oldDir.created_at, oldDir.updated_at);
            const newDirId = Number(result.lastInsertRowid);
            
            // 保存旧路径到新 ID 的映射（确保是 number 类型）
            dirPathToIdMap.set(dirPath, newDirId);
            dirMigratedCount++
          }
          logger.info(LogCategory.DATABASE_SERVICE, `成功迁移 ${dirMigratedCount} 个目录`)
        })();

        // B. 迁移文件
        logger.info(LogCategory.DATABASE_SERVICE, '步骤 B: 开始迁移文件数据...')
        const oldFiles = this._db.prepare('SELECT * FROM files').all() as any[]
        logger.info(LogCategory.DATABASE_SERVICE, `找到 ${oldFiles.length} 个文件需要迁移`)

        let fileMigratedCount = 0
        let fileSkippedCount = 0

        for (const oldFile of oldFiles) {
          try {
            const filePath = oldFile.path;
            const dirPath = path.dirname(filePath);
            
            // 获取或创建目录记录
            let dirId: number | undefined = dirPathToIdMap.get(dirPath);
            if (!dirId) {
              // 先尝试查询是否已存在
              const existingDir = this._db.prepare(`SELECT id FROM workspace_directories_v2 WHERE path = ?`).get(dirPath) as any;
              if (existingDir) {
                dirId = existingDir.id as number;
                dirPathToIdMap.set(dirPath, dirId);
              } else {
                // 需要创建新的目录记录
                let dirWsId = workspaces.find(ws => dirPath.startsWith(ws.path))?.workspace_id;
                if (!dirWsId && workspaces.length > 0) {
                  dirWsId = workspaces[0].workspace_id;
                  logger.warn(LogCategory.DATABASE_SERVICE, `文件 ${filePath} 的目录 ${dirPath} 找不到匹配的工作区，使用默认工作区`);
                }

                if (dirWsId) {
                  try {
                    const dirStmt = this._db.prepare(`INSERT OR IGNORE INTO workspace_directories_v2 (workspace_id, path, name) VALUES (?, ?, ?)`);
                    dirStmt.run(dirWsId, dirPath, path.basename(dirPath));
                    // 查询获取 ID（无论是新插入还是已存在）
                    const newlyInsertedDir = this._db.prepare(`SELECT id FROM workspace_directories_v2 WHERE path = ?`).get(dirPath) as any;
                    if (newlyInsertedDir) {
                      dirId = newlyInsertedDir.id as number;
                      dirPathToIdMap.set(dirPath, dirId);
                    }
                  } catch (dirInsertError: any) {
                    logger.error(LogCategory.DATABASE_SERVICE, `创建目录记录失败: ${dirPath}`, dirInsertError);
                    throw dirInsertError;
                  }
                }
              }
            }
            
            if (!dirId) {
              logger.error(LogCategory.DATABASE_SERVICE, `文件 ${filePath} 无法确定所属目录，跳过迁移`);
              fileSkippedCount++;
              continue;
            }

            // 计算内容指纹
            // 需要重新计算的情况：
            // 1. 指纹为空或以 'temp_' 开头
            // 2. 指纹长度为16位（V1早期版本的MD5哈希）
            // 3. 指纹长度为64位（V1早期版本的SHA-256哈希）
            // 4. 指纹长度不为32位（当前标准的Base62哈希长度）
            let contentFingerprint = oldFile.content_hash;
            const needsRecalculation = !contentFingerprint || 
                                       contentFingerprint.startsWith('temp_') || 
                                       contentFingerprint.length === 16 || 
                                       contentFingerprint.length === 64 ||
                                       contentFingerprint.length !== 32;
            
            if (needsRecalculation) {
              contentFingerprint = fs.existsSync(oldFile.path) ? await this.calculateFileFingerprint(oldFile.path) : `missing_${oldFile.id}`;
            }

            // 查找文件所属的工作区
            let fileWsId = workspaces.find(ws => oldFile.path.startsWith(ws.path))?.workspace_id;
            if (!fileWsId && workspaces.length > 0) {
              fileWsId = workspaces[0].workspace_id;
            }

            if (!fileWsId) {
              logger.error(LogCategory.DATABASE_SERVICE, `文件 ${oldFile.path} 无法找到有效的工作区，跳过迁移`);
              fileSkippedCount++;
              continue;
            }

            // 插入数据到新表
            this._db.transaction(() => {
              // 确保外键禁用（防御性检查）
              this._db!.pragma('foreign_keys = OFF');

              try {
                // 插入文件内容记录
                // 【关键修复】显式设置 sync_status = 0, is_hit = 0, last_hit_at = NULL
                // 因为升级过程中云端数据已清空，所有存量数据需要重新同步和比对
                this._db!.prepare(`
                  INSERT OR IGNORE INTO files_v2 
                  (file_fingerprint, smart_name, description, size, type, mime_type, author, language, is_hit, last_hit_at, sync_status, created_at, modified_at, accessed_at) 
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, ?, ?, ?)
                `).run(
                  contentFingerprint, oldFile.smart_name, oldFile.description, oldFile.size, 
                  oldFile.type, oldFile.mime_type, oldFile.author, oldFile.language, 
                  oldFile.created_at, oldFile.modified_at, oldFile.accessed_at
                );

                // 插入大字段
                this._db!.prepare(`INSERT OR IGNORE INTO file_contents (file_fingerprint, content, multimodal_content, metadata, quality_score, quality_confidence, quality_criteria, quality_reasoning, grouping_reason, grouping_confidence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(contentFingerprint, oldFile.content, oldFile.multimodal_content, oldFile.metadata, oldFile.quality_score, oldFile.quality_confidence, oldFile.quality_criteria, oldFile.quality_reasoning, oldFile.grouping_reason, oldFile.grouping_confidence);

                // 插入物理路径记录（workspace_files 使用自增 ID 主键）
                this._db!.prepare(`INSERT INTO workspace_files (file_fingerprint, workspace_id, directory_id, path, name, is_analyzed, analysis_error, last_analyzed_at, thumbnail_path, created_at, modified_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(contentFingerprint, fileWsId, dirId, oldFile.path, oldFile.name, oldFile.is_analyzed, oldFile.analysis_error, oldFile.last_analyzed_at, oldFile.thumbnail_path, oldFile.created_at, oldFile.modified_at, oldFile.accessed_at);
              } catch (insertError: any) {
                logger.error(LogCategory.DATABASE_SERVICE, `插入文件记录失败: 内容指纹=${contentFingerprint}, workspace_id=${fileWsId}, directory_id=${dirId}, path=${oldFile.path}`, insertError);
                throw insertError;
              }
            })();

            // 记录映射关系
            idMapping.set(oldFile.id, { dirId: String(dirId), fingerprint: contentFingerprint });

            fileMigratedCount++

            // 每迁移100个文件输出一次进度
            if (fileMigratedCount % 100 === 0) {
              logger.info(LogCategory.DATABASE_SERVICE, `已迁移 ${fileMigratedCount}/${oldFiles.length} 个文件...`)
            }
          } catch (fileErr: any) {
            // 关键错误（如约束违反、类型不匹配）应该直接抛出，而不是静默跳过
            const isCriticalError = fileErr.message?.includes('UNIQUE constraint') ||
                                    fileErr.message?.includes('datatype mismatch') ||
                                    fileErr.message?.includes('FOREIGN KEY constraint') ||
                                    fileErr.message?.includes('NOT NULL constraint');
            
            if (isCriticalError) {
              logger.error(LogCategory.DATABASE_SERVICE, `迁移文件遇到关键错误: ${oldFile.path}`, fileErr);
              throw fileErr;
            }
            
            logger.error(LogCategory.DATABASE_SERVICE, `迁移文件失败: ${oldFile.path}`, fileErr);
            fileSkippedCount++
          }
        }
        logger.info(LogCategory.DATABASE_SERVICE, `文件迁移完成：成功 ${fileMigratedCount} 个，跳过 ${fileSkippedCount} 个`)

        // 如果有文件迁移失败，抛出错误
        if (fileSkippedCount > 0 && fileMigratedCount === 0) {
          throw new Error(`所有文件迁移均失败，共跳过 ${fileSkippedCount} 个文件`)
        }
      }

      // 4. 迁移关联表数据（标签和最小单元）
      // 注意：此时旧表还存在，新表还未重命名。需要在此处备份旧关联表数据
      if (!isFreshInstall) {
        logger.info(LogCategory.DATABASE_SERVICE, '开始备份文件关联关系数据...')

        // 备份 file_tag_relations
        const oldFileTagRelationsExist = this._db!.prepare(`
          SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='file_tag_relations'
        `).get() as any

        if (oldFileTagRelationsExist.count > 0) {
          oldTagRelations = this._db!.prepare('SELECT * FROM file_tag_relations').all() as any[]
          logger.info(LogCategory.DATABASE_SERVICE, `备份了 ${oldTagRelations.length} 条标签关联记录`)
        }

        // 备份 file_unit_relations
        const oldFileUnitRelationsExist = this._db!.prepare(`
          SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='file_unit_relations'
        `).get() as any

        if (oldFileUnitRelationsExist.count > 0) {
          oldUnitRelations = this._db!.prepare('SELECT * FROM file_unit_relations').all() as any[]
          logger.info(LogCategory.DATABASE_SERVICE, `备份了 ${oldUnitRelations.length} 条最小单元关联记录`)
        }
      }

      // 5. 结构转正事务
      logger.info(LogCategory.DATABASE_SERVICE, '开始执行结构转正：删除旧表并重命名新表...')
    this._db.transaction(() => {
        // 暂时禁用外键约束，以便顺利删除和重命名表
      this._db!.pragma('foreign_keys = OFF');

        // 备份 file_contents 数据（V2.1 SQL 脚本创建并填充的）
        let fileContentsData: any[] = [];
        const fileContentsExists = this._db!.prepare(`
          SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='file_contents'
        `).get() as any;
        
        if (fileContentsExists.count > 0) {
          fileContentsData = this._db!.prepare('SELECT * FROM file_contents').all() as any[];
          logger.info(LogCategory.DATABASE_SERVICE, `备份了 ${fileContentsData.length} 条 file_contents 记录`)
        }
        
        // 在删除表之前，先删除所有引用旧表的索引和触发器
        logger.info(LogCategory.DATABASE_SERVICE, '删除 V1 旧索引...')
        this._db!.exec(`
          DROP INDEX IF EXISTS idx_files_workspace_id;
          DROP INDEX IF EXISTS idx_files_path;
          DROP INDEX IF EXISTS idx_files_is_analyzed;
          DROP INDEX IF EXISTS idx_file_units_workspace_id;
          DROP INDEX IF EXISTS idx_file_tags_dimension_id;
          DROP INDEX IF EXISTS idx_file_tags_name;
          DROP INDEX IF EXISTS idx_file_tag_relations_file_id;
          DROP INDEX IF EXISTS idx_file_tag_relations_tag_id;
          DROP INDEX IF EXISTS idx_file_dimensions_level;
        `);
        
        // 检查 files 表是否存在
        const filesTableExists = this._db!.prepare(`
          SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='files'
        `).get() as any;
        
        if (filesTableExists.count === 0) {
          logger.error(LogCategory.DATABASE_SERVICE, 'files 表不存在！可能在之前的操作中被意外删除')
          // 尝试从 V1 备份表恢复（如果存在）
          const filesBackupExists = this._db!.prepare(`
            SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='files_backup'
          `).get() as any;
          
          if (filesBackupExists.count > 0) {
            logger.info(LogCategory.DATABASE_SERVICE, '尝试从 files_backup 恢复')
            this._db!.exec(`ALTER TABLE files_backup RENAME TO files;`)
          } else {
            throw new Error('files 表不存在，无法继续迁移')
          }
        }
        
        logger.info(LogCategory.DATABASE_SERVICE, '删除 V1 旧表...')
        // 按依赖关系倒序删除所有 V1 相关的表
        // 注意：file_tags 和 file_units 等表需要保留，因为它们的数据会在新架构中继续使用
        const tablesToDrop = [
          // 先删除有外键约束的关联表
          'file_tag_relations',   // 引用 files(id) - 需要删除，因为新架构使用 file_fingerprint
          'file_unit_relations',  // 引用 files(id) - 需要删除，因为新架构使用 directory_id
          // 然后删除依赖 workspace_directories 的表
          'virtual_directories',  // 引用 workspace_directories(id) - V1 的虚拟目录表
          // 然后删除主表
          'files',                // 引用 workspace_directories(id) - V1 的文件表
          'analysis_queue',       // V1 的分析队列表
          // 删除被引用的基础表
          'workspace_directories', // V1 的工作区目录表
          // V1 不存在 workspace_files，不需要删除
        ];
        
        for (const tableName of tablesToDrop) {
          const tableExists = this._db!.prepare(`
            SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='${tableName}'
          `).get() as any;
          
          if (tableExists.count > 0) {
            logger.info(LogCategory.DATABASE_SERVICE, `正在删除表: ${tableName}`)
            try {
              this._db!.exec(`DROP TABLE IF EXISTS ${tableName};`);
            } catch (dropError) {
              logger.error(LogCategory.DATABASE_SERVICE, `删除表 ${tableName} 失败`, dropError)
              throw dropError
            }
          } else {
            logger.debug(LogCategory.DATABASE_SERVICE, `表 ${tableName} 不存在，跳过删除`)
          }
        }

        logger.info(LogCategory.DATABASE_SERVICE, '重命名新表: _v2 -> 正式表名')
      this._db!.exec(`
        ALTER TABLE files_v2 RENAME TO files;
        ALTER TABLE workspace_directories_v2 RENAME TO workspace_directories;
        ALTER TABLE analysis_queue_v2 RENAME TO analysis_queue;
      `);

        // 重新创建 virtual_directories 表（V1 表被删除后需要重建）
        logger.info(LogCategory.DATABASE_SERVICE, '重新创建 virtual_directories 表...')
        this._db!.exec(`
          CREATE TABLE IF NOT EXISTS virtual_directories (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            filters TEXT NOT NULL,
            parent_id TEXT,
            workspace_id INTEGER NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (workspace_id) REFERENCES workspace_directories(id) ON DELETE CASCADE,
            FOREIGN KEY (parent_id) REFERENCES virtual_directories(id) ON DELETE CASCADE
          );
        `);

        // 重新创建 file_contents 表，这次引用正确的 files 表
        logger.info(LogCategory.DATABASE_SERVICE, '重新创建 file_contents 表（引用重命名后的 files 表）...')
        this._db!.exec(`
          CREATE TABLE IF NOT EXISTS file_contents (
            file_fingerprint TEXT PRIMARY KEY,
            content TEXT,
            multimodal_content TEXT,
            lrc TEXT,
            metadata TEXT,
            analysis_stats TEXT,
            quality_score REAL,
            quality_confidence REAL,
            quality_criteria TEXT,
            quality_reasoning TEXT,
            grouping_reason TEXT,
            grouping_confidence REAL,
            FOREIGN KEY (file_fingerprint) REFERENCES files(file_fingerprint) ON DELETE CASCADE
          );
        `);
        
        // 恢复 file_contents 数据
        if (fileContentsData.length > 0) {
          logger.info(LogCategory.DATABASE_SERVICE, `恢复 ${fileContentsData.length} 条 file_contents 记录...`)
          const insertStmt = this._db!.prepare(`
            INSERT OR IGNORE INTO file_contents (file_fingerprint, content, multimodal_content, lrc, metadata, analysis_stats, quality_score, quality_confidence, quality_criteria, quality_reasoning, grouping_reason, grouping_confidence)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          
          for (const row of fileContentsData) {
            insertStmt.run(
              row.file_fingerprint, row.content, row.multimodal_content, row.lrc,
              row.metadata, row.analysis_stats, row.quality_score, row.quality_confidence,
              row.quality_criteria, row.quality_reasoning, row.grouping_reason, row.grouping_confidence
            );
          }
        }

        // 重建 file_tag_relations_v2 表（使用 file_fingerprint）
        logger.info(LogCategory.DATABASE_SERVICE, '创建 file_tag_relations_v2 表结构...')
        this._db!.exec(`
          CREATE TABLE IF NOT EXISTS file_tag_relations_v2 (
            file_fingerprint TEXT NOT NULL,
            tag_id INTEGER NOT NULL,
            sync_status INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (file_fingerprint, tag_id),
            FOREIGN KEY (file_fingerprint) REFERENCES files(file_fingerprint) ON DELETE CASCADE,
            FOREIGN KEY (tag_id) REFERENCES file_tags(id) ON DELETE CASCADE
          );
        `);

        // 重建 file_unit_relations_v2 表（使用 workspace_files.id）
        logger.info(LogCategory.DATABASE_SERVICE, '创建 file_unit_relations_v2 表结构...')
        this._db!.exec(`
          CREATE TABLE IF NOT EXISTS file_unit_relations_v2 (
            file_id INTEGER NOT NULL,
            unit_id INTEGER NOT NULL,
            created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (file_id, unit_id),
            FOREIGN KEY (file_id) REFERENCES workspace_files(id) ON DELETE CASCADE,
            FOREIGN KEY (unit_id) REFERENCES file_units(id) ON DELETE CASCADE
          );
        `);

        // 迁移标签关联数据
        if (!isFreshInstall && oldTagRelations.length > 0 && idMapping.size > 0) {
          const insertStmt = this._db!.prepare(`
            INSERT OR IGNORE INTO file_tag_relations_v2 (file_fingerprint, tag_id, sync_status)
            VALUES (?, ?, ?)
          `);

          let migratedCount = 0
          for (const relation of oldTagRelations) {
            const mapping = idMapping.get(relation.file_id);
            if (mapping) {
              insertStmt.run(mapping.fingerprint, relation.tag_id, relation.sync_status || 0);
              migratedCount++;
            }
          }

          logger.info(LogCategory.DATABASE_SERVICE, `file_tag_relations_v2 迁移了 ${migratedCount}/${oldTagRelations.length} 条记录`)
        }

        // 迁移最小单元关联数据
        if (!isFreshInstall && oldUnitRelations.length > 0) {
          // 通过旧 file_id 查找对应的 workspace_files.id
          const insertStmt = this._db!.prepare(`
            INSERT OR IGNORE INTO file_unit_relations_v2 (file_id, unit_id, created_at)
            SELECT wf.id, ?, ?
            FROM workspace_files wf
            WHERE wf.path = (SELECT path FROM files WHERE id = ?)
            LIMIT 1
          `);

          let migratedCount = 0
          for (const relation of oldUnitRelations) {
            insertStmt.run(relation.unit_id, relation.created_at, relation.file_id);
            migratedCount++;
          }

          logger.info(LogCategory.DATABASE_SERVICE, `file_unit_relations_v2 迁移了 ${migratedCount}/${oldUnitRelations.length} 条记录`)
        }

        // 重命名影子表为正式表
        logger.info(LogCategory.DATABASE_SERVICE, '重命名关联表: _v2 -> 正式表名')
        this._db!.exec(`
          DROP TABLE IF EXISTS file_tag_relations;
          ALTER TABLE file_tag_relations_v2 RENAME TO file_tag_relations;
          DROP TABLE IF EXISTS file_unit_relations;
          ALTER TABLE file_unit_relations_v2 RENAME TO file_unit_relations;
        `);

        // 重新启用外键约束
      this._db!.pragma('foreign_keys = ON');
        
        logger.info(LogCategory.DATABASE_SERVICE, '创建触发器和索引...')
        this._db!.exec(`
          DROP TRIGGER IF EXISTS trg_files_fts_update;
          CREATE TRIGGER trg_files_fts_update AFTER UPDATE ON files BEGIN
            UPDATE files_fts SET smart_name = new.smart_name, description = new.description WHERE file_fingerprint = new.file_fingerprint;
          END;

          DROP TRIGGER IF EXISTS trg_file_contents_fts_update;
          CREATE TRIGGER trg_file_contents_fts_update AFTER UPDATE ON file_contents BEGIN
            UPDATE files_fts SET content = new.content, multimodal_content = new.multimodal_content, lrc = new.lrc WHERE file_fingerprint = new.file_fingerprint;
          END;

          DROP TRIGGER IF EXISTS trg_workspace_files_fts_update;
          CREATE TRIGGER trg_workspace_files_fts_update AFTER UPDATE OF name ON workspace_files BEGIN
            UPDATE files_fts SET name = new.name WHERE file_fingerprint = new.file_fingerprint;
          END;

          DROP TRIGGER IF EXISTS trg_file_tags_fts_sync;
          CREATE TRIGGER trg_file_tags_fts_sync AFTER INSERT ON file_tag_relations BEGIN
            UPDATE files_fts SET tags = (SELECT GROUP_CONCAT(ft.name, ' ') FROM file_tag_relations ftr JOIN file_tags ft ON ftr.tag_id = ft.id WHERE ftr.file_fingerprint = new.file_fingerprint) WHERE file_fingerprint = new.file_fingerprint;
          END;

          DROP TRIGGER IF EXISTS trg_file_tags_fts_delete;
          CREATE TRIGGER trg_file_tags_fts_delete AFTER DELETE ON file_tag_relations BEGIN
            UPDATE files_fts SET tags = (SELECT GROUP_CONCAT(ft.name, ' ') FROM file_tag_relations ftr JOIN file_tags ft ON ftr.tag_id = ft.id WHERE ftr.file_fingerprint = old.file_fingerprint) WHERE file_fingerprint = old.file_fingerprint;
          END;

          DROP TRIGGER IF EXISTS trg_file_contents_update_modified_at;
          CREATE TRIGGER trg_file_contents_update_modified_at AFTER UPDATE ON file_contents BEGIN
            UPDATE files SET modified_at = CURRENT_TIMESTAMP WHERE file_fingerprint = new.file_fingerprint;
          END;

          CREATE INDEX IF NOT EXISTS idx_workspace_directories_path ON workspace_directories(path COLLATE NOCASE);
          CREATE INDEX IF NOT EXISTS idx_workspace_files_path_nocase ON workspace_files(path COLLATE NOCASE);
        `);

        logger.info(LogCategory.DATABASE_SERVICE, '初始化 FTS 全文搜索索引...')
        this._db!.exec(`
          INSERT INTO files_fts(file_fingerprint, name, smart_name, description, content, multimodal_content, lrc, tags)
          SELECT f.file_fingerprint, wf.name, f.smart_name, f.description, fc.content, fc.multimodal_content, fc.lrc,
            (SELECT GROUP_CONCAT(ft.name, ' ') FROM file_tag_relations ftr JOIN file_tags ft ON ftr.tag_id = ft.id WHERE ftr.file_fingerprint = f.file_fingerprint)
          FROM files f
          LEFT JOIN workspace_files wf ON f.file_fingerprint = wf.file_fingerprint
          LEFT JOIN file_contents fc ON f.file_fingerprint = fc.file_fingerprint
          WHERE wf.name IS NOT NULL
          GROUP BY f.file_fingerprint;
        `);
        
        logger.info(LogCategory.DATABASE_SERVICE, '结构转正事务执行完成')
    })();

      logger.info(LogCategory.DATABASE_SERVICE, isFreshInstall ? 'V2.1 架构初始化完成' : 'V2.1 架构迁移完成');
      if (!isFreshInstall) {
        // 【关键】设置标记：需要在启动后执行指纹升级和同步状态重置
        // 这是V1->V2.2升级的一次性任务
        configService.updateValue('PENDING_FINGERPRINT_UPGRADE', true)
        logger.info(LogCategory.DATABASE_SERVICE, '已设置指纹升级标记，将在启动后执行')
        this.notifyFrontend('success', t('架构升级完成！'), false, 'v2-1-migration', 3000);
      }
    } catch (error) {
      // 确保外键约束被重新启用，即使迁移失败
      try {
        this._db.pragma('foreign_keys = ON');
      } catch (fkError) {
        logger.warn(LogCategory.DATABASE_SERVICE, '重新启用外键约束失败', { error: fkError })
      }

      logger.error(LogCategory.DATABASE_SERVICE, 'V2.1 数据迁移失败', error);
      if (!isFreshInstall) this.notifyFrontend('error', t('架构升级失败'), false, 'v2-1-migration');
      throw error;
    }
  }

  // --- DAO Forwarding Methods ---
  
  async addFileFromPath(filePath: string, rootPath: string, existingWorkspaceId?: number, skipHash = false): Promise<number | null> {
    // 检查路径是否存在且是文件，拒绝目录
    try {
      const stats = fs.statSync(filePath);
      if (!stats.isFile()) {
        logger.warn(LogCategory.DATABASE_SERVICE, `addFileFromPath: 跳过非文件路径: ${filePath}`);
        return null;
      }
    } catch (error) {
      logger.warn(LogCategory.DATABASE_SERVICE, `addFileFromPath: 路径不存在或无法访问: ${filePath}`);
      return null;
    }

    const dirPath = path.dirname(filePath)

    // 确保目录记录存在并获取 ID
    const directoryId = await this.addDirectory(dirPath, existingWorkspaceId);
    
    // 优先使用传入的 workspaceId，避免数据库查询可能导致的类型不匹配或架构问题
    let workspaceId = existingWorkspaceId;
    if (!workspaceId) {
      const dirRecord = this._db!.prepare('SELECT workspace_id FROM workspace_directories WHERE id = ?').get(Number(directoryId)) as any;
      workspaceId = dirRecord?.workspace_id;
    }

    if (!workspaceId) {
      logger.error(LogCategory.DATABASE_SERVICE, `无法确定文件 ${filePath} 所属工作区 (directoryId: ${directoryId})`)
      return null;
    }

    let fileFingerprint: string | null = null;
    // 使用 workspace_id + path 唯一索引进行查询
    const existing = this._db!.prepare(`SELECT id, file_fingerprint, is_analyzed FROM workspace_files WHERE workspace_id = ? AND path = ?`).get(workspaceId, filePath) as any

    if (skipHash) {
      fileFingerprint = existing?.file_fingerprint || null;
    } else {
      fileFingerprint = await this.calculateFileFingerprint(filePath);
    }

    if (fileFingerprint) {
      const stats = fs.statSync(filePath)
      this._db!.prepare(`INSERT OR IGNORE INTO files (file_fingerprint, smart_name, size, type, mime_type, created_at, modified_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
        fileFingerprint, path.basename(filePath), stats.size, path.extname(filePath).toLowerCase(), 'application/octet-stream',
        stats.birthtime.toISOString(), stats.mtime.toISOString(), stats.atime.toISOString()
      )
      this._db!.prepare(`INSERT OR IGNORE INTO file_contents (file_fingerprint) VALUES (?)`).run(fileFingerprint)
    }

    // 使用 workspace_id + path 复合唯一索引
    this._db!.prepare(`
      INSERT INTO workspace_files (file_fingerprint, workspace_id, directory_id, path, name, created_at, modified_at, accessed_at, is_analyzed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, path) DO UPDATE SET
        file_fingerprint = excluded.file_fingerprint,
        modified_at = excluded.modified_at
    `).run(
      fileFingerprint, workspaceId, directoryId, filePath, path.basename(filePath),
      new Date().toISOString(), new Date().toISOString(), new Date().toISOString(),
      existing?.is_analyzed || 0
    )

    // 返回 workspace_files 的 ID
    const wf = this._db!.prepare(`SELECT id FROM workspace_files WHERE workspace_id = ? AND path = ?`).get(workspaceId, filePath) as any;
    return wf?.id || null;
  }

  async updateFilePath(oldPath: string, newPath: string): Promise<void> {
    await this.addDirectory(path.dirname(newPath));
    return this.fileDao.updateFilePath(oldPath, newPath);
  }

  async addDirectory(dirPath: string, existingWorkspaceId?: number): Promise<number> {
    // 使用 node:path 标准包处理路径，保持系统原生格式
    const resolvedPath = path.resolve(dirPath);

    // 检查是否已存在
    const exists = this._db!.prepare('SELECT id, workspace_id FROM workspace_directories WHERE path = ?').get(resolvedPath) as any;
    if (exists) return exists.id;

    // 【关键修复】查找文件所属的工作区根目录，而不是目录本身的工作区ID
    // 因为子目录可能还没有 workspace_directories 记录
    let workspaceId = existingWorkspaceId;
    if (!workspaceId) {
      // 使用 findRoot 查找文件所属的工作区
      const rootWorkspace = await this.findRootWorkspaceDirectory(resolvedPath);
      if (rootWorkspace && rootWorkspace.id) {
        workspaceId = rootWorkspace.id;
      }
    }
    
    if (!workspaceId) {
      throw new Error(`目录不属于任何已注册工作空间: ${resolvedPath}`);
    }

    // 插入新记录并返回自增 ID
    const stmt = this._db!.prepare(`INSERT INTO workspace_directories (workspace_id, path, name) VALUES (?, ?, ?)`);
    const result = stmt.run(workspaceId, resolvedPath, path.basename(resolvedPath));
    return Number(result.lastInsertRowid);
  }

  async resetWorkspaceDirectoryAnalysis(directoryPath: string): Promise<void> {
    if (!this._db) throw new Error('数据库未初始化')
    const sep = path.sep;
    this._db.transaction(() => {
      // 1. 重置目录状态
      this._db!.prepare(`UPDATE workspace_directories SET is_analyzed = 0, context_analysis = NULL, last_analyzed_at = NULL WHERE path = ? OR path LIKE ? || '${sep}%'`).run(directoryPath, directoryPath)
      
      // 2. 重置文件状态
      this._db!.prepare(`UPDATE workspace_files SET is_analyzed = 0, last_analyzed_at = NULL, analysis_error = NULL WHERE directory_id IN (SELECT id FROM workspace_directories WHERE path = ? OR path LIKE ? || '${sep}%')`).run(directoryPath, directoryPath)
      
      // 3. 清理分析队列，确保可以重新添加
      this._db!.prepare(`
        DELETE FROM analysis_queue 
        WHERE (item_type = 'directory' AND item_id IN (SELECT id FROM workspace_directories WHERE path = ? OR path LIKE ? || '${sep}%'))
           OR (item_type = 'file' AND item_id IN (SELECT id FROM workspace_files WHERE directory_id IN (SELECT id FROM workspace_directories WHERE path = ? OR path LIKE ? || '${sep}%')))
      `).run(directoryPath, directoryPath, directoryPath, directoryPath)
    })()
  }

  // --- DAO Methods ---
  async getFileAnalysisResult(p: string) { return this.fileDao.getFileAnalysisResult(p) }
  async getDirectoryAnalysisResult(p: string) { return this.fileDao.getDirectoryAnalysisResult(p) }
  async updateFileAnalysisResult(id: string, r: any) { return this.fileDao.updateFileAnalysisResult(id, r) }
  async getAllFiles() { return this.fileDao.getAllFiles() }
  async searchFilesFTS(q: string, wsId?: number) { return this.fileDao.searchFilesFTS(q, wsId) }
  async getAnalyzedFileByContentHash(h: string) { return this.fileDao.getAnalyzedFileByContentHash(h) }
  async getFileByPath(p: string) { return this.fileDao.getFileByPath(p) }
  async getFilesByParentPath(p: string, wsId: number) { return this.fileDao.getFilesByParentPath(p, wsId) }
  async getFilesByWorkspaceId(workspaceId: number) {
    if (!this._db) throw new Error('数据库未初始化')
    return this._db.prepare(`
      SELECT wf.id, wf.path, wf.name, wf.is_analyzed, wf.file_fingerprint
      FROM workspace_files wf
      WHERE wf.workspace_id = ?
    `).all(workspaceId) as any[]
  }
  async updateFileMetadata(p: string, s: fs.Stats) { return this.fileDao.updateFileMetadata(p, s) }
  async updateFileHitStatus(h: string, h2: boolean) { return this.fileDao.updateFileHitStatus(h, h2) }
  async updateFileThumbnail(p: string, t: string | null) { return this.fileDao.updateFileThumbnail(p, t) }
  async resetFileAnalysis(p: string) { return this.fileDao.resetFileAnalysis(p) }
  async updateFileModifiedTime(p: string, m: Date) { return this.updateFileMetadata(p, fs.statSync(p)) }

  // --- Workspace Methods ---
  async addWorkspaceDirectory(d: WorkspaceDirectory) {
    const wsId = await this.workspaceDao.add(d)
    await this.addDirectory(d.path, wsId)
    return wsId
  }
  async getAllWorkspaceDirectories() { return this.workspaceDao.getAll() }
  async getCurrentWorkspaceDirectory() { return this.workspaceDao.getCurrent() }
  async setCurrentWorkspaceDirectory(p: string) { return this.workspaceDao.setCurrent(p) }
  async deleteWorkspaceDirectory(p: string) { return this.workspaceDao.delete(p) }
  async updateWorkspaceDirectoryAutoWatch(id: number, a: boolean) { return this.workspaceDao.updateAutoWatch(id, a) }
  async updateAutoWatch(id: number, a: boolean) { return this.updateWorkspaceDirectoryAutoWatch(id, a) }
  async updateWorkspaceDirectoryLastScan(id: number) { return this.workspaceDao.updateLastScan(id) }
  async getWorkspaceDirectoryById(id: number) { return this.workspaceDao.getById(id) }
  async findRootWorkspaceDirectory(p: string) { return this.workspaceDao.findRoot(p) }
  async getWorkspaceIdByPath(p: string) { return (await this.workspaceDao.findRoot(p))?.id || null }

  // --- Tag & Unit Methods ---
  async createUnit(d: UnitCreationData) { return this.tagUnitDao.createUnit(d) }
  async getUnit(id: number) { return this.tagUnitDao.getUnit(id) }
  async updateUnit(id: number, p: Partial<Unit>) { return this.tagUnitDao.updateUnit(id, p) }
  async deleteUnit(id: number) { return this.tagUnitDao.deleteUnit(id) }
  async getUnitsForFile(id: number) { return this.tagUnitDao.getUnitsForFile(id) }
  async createFileUnitRelation(id: number, uid: number) { return this.tagUnitDao.createFileUnitRelation(id, uid) }
  async getUnitsForPath(p: string) { return this.tagUnitDao.getUnitsForPath(p) }
  async getFileTagsByFileId(f: string) { return this.tagUnitDao.getFileTagsByFileId(f) }

  // --- Queue Methods ---
  getAnalysisQueue() { return this.queueDao.getAnalysisQueue() }
  async enqueueAnalysis(item: { item_id: number | null; item_type?: 'file' | 'directory'; status: string; progress?: number }): Promise<number> {
    return this.queueDao.enqueueAnalysis(item)
  }
  // 同步版本：用于 db.transaction() 内部调用
  enqueueAnalysisSync(item: { item_id: number | null; item_type?: 'file' | 'directory'; status: string; progress?: number }): number {
    return this.queueDao.enqueueAnalysis(item)
  }
  updateAnalysisQueue(item: { id: number; status?: string; progress?: number; error?: string | null; result?: string | null }) { return this.queueDao.updateAnalysisQueue(item) }
  clearNonCompletedAnalysis() { return this.queueDao.clearNonCompletedAnalysis() }
  clearPendingAnalysis() { return this.queueDao.clearPendingAnalysis() }
  retryFailedAnalysis() { return this.queueDao.retryFailedAnalysis() }
  deleteAnalysis(id: number) { return this.queueDao.deleteAnalysis(id) }

  // --- Misc Methods ---
  async addFile(file: FileInfo) { return this.addFileFromPath(file.path, '') }
  async isConnected() { return this._db !== null }
  async close() { if (this._db) { this._db.close(); this._db = null } }

  async resetAllAnalysisData(): Promise<void> {
    if (!this._db) throw new Error('数据库未初始化')
    try {
      this._db.transaction(() => {
        this._db!.prepare(`UPDATE workspace_files SET is_analyzed = 0, last_analyzed_at = NULL, analysis_error = NULL`).run()
        this._db!.prepare(`UPDATE files SET description = NULL, author = NULL, language = NULL, is_hit = 0, last_hit_at = NULL, smart_name = (SELECT name FROM workspace_files wf WHERE wf.file_fingerprint = files.file_fingerprint LIMIT 1)`).run()
        this._db!.prepare('DELETE FROM file_contents').run()
        this._db!.prepare('DELETE FROM file_tag_relations').run()
        this._db!.prepare('DELETE FROM file_tags').run()
        this._db!.prepare('DELETE FROM tag_expansions').run()
        this._db!.prepare('DELETE FROM dimension_expansions').run()
        this._db!.prepare('DELETE FROM file_dimensions').run()
        
        // 4. 清空分析队列
        this._db!.prepare('DELETE FROM analysis_queue').run()
      })()
      logger.info(LogCategory.DATABASE_SERVICE, '所有AI分析数据已重置')
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '重置所有AI分析数据失败', { error })
      throw error
    }
  }
}

export const databaseService = new DatabaseService(getDatabaseConfig().path)
