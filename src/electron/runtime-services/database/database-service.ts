import type {
  FileInfo,
  LanguageCode,
  WorkspaceDirectory,
  Unit,
  UnitCreationData
} from '@firefly/types'
import { LogCategory, logger, isTestEnvironment } from '@firefly/shared'
import { getDatabaseConfig, migrations } from './database'

import Database from 'better-sqlite3'
import { calculateFileFingerprint } from '@firefly/shared'
import * as fs from 'fs'
import * as path from 'path'
import { t } from '@app/languages'

import { WorkspaceDao, FileDao, TagUnitDao, QueueDao } from './dao'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { AccessTimeBatchUpdater } from './access-time-batch-updater'
import { loadIgnoreRules, shouldIgnoreFile } from '../analysis/analysis-ignore-service'

/**
 * 数据库服务 Facade
 * 负责 SQLite 数据库的初始化、迁移框架以及将 CRUD 操作转发给各个 DAO
 */
export class DatabaseService {
  private _db: Database.Database | null = null
  private dbPath: string

  private workspaceDao!: WorkspaceDao
  private fileDao!: FileDao
  private tagUnitDao!: TagUnitDao
  private queueDao!: QueueDao

  private initPromise: Promise<void> | null = null

  /** 迁移完成后执行的回调列表 */
  private postMigrationCallbacks: Array<(db: Database.Database) => void> = []

  get db(): Database.Database | null {
    return this._db
  }

  constructor(dbPath: string = '') {
    this.dbPath = dbPath
  }

  async ensureInitialized(): Promise<void> {
    if (this._db) return
    if (this.initPromise) {
      await this.initPromise
      return
    }
    const isLanguageConfirmed =
      ConfigOrchestrator.getInstance().getValue<boolean>('LANGUAGE_CONFIRMED')
    if (!isLanguageConfirmed) {
      logger.info(
        LogCategory.DATABASE_SERVICE,
        '语言尚未确认 (LANGUAGE_CONFIRMED = false)，跳过 ensureInitialized 数据库自动创建'
      )
      return
    }
    const currentLang = ConfigOrchestrator.getInstance().getValue<LanguageCode>('DEFAULT_LANGUAGE')
    if (!currentLang) {
      throw new Error(t('无法自动初始化数据库：尚未指定语言'))
    }
    await this.initialize(currentLang)
  }

  /**
   * 注册迁移完成后的回调（在所有迁移执行完毕后、initialize 返回前执行）
   */
  registerPostMigrationCallback(cb: (db: Database.Database) => void): void {
    this.postMigrationCallbacks.push(cb)
  }

  /**
   * 清理所有迁移后回调（用于语言切换等需要重新初始化的场景）
   */
  clearPostMigrationCallbacks(): void {
    this.postMigrationCallbacks = []
  }

  async initialize(language: LanguageCode): Promise<void> {
    if (!language) {
      throw new Error(t('数据库初始化必须指定语言代码'))
    }

    if (this.initPromise) return this.initPromise

    this.initPromise = (async () => {
      try {
        if (this._db) return

        const config = getDatabaseConfig(language)
        this.dbPath = config.path

        const dir = path.dirname(this.dbPath)
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

        // 检查是否存在迁移失败的备份文件，如果是则先恢复
        const backupPath = this.getBackupPath()
        if (fs.existsSync(backupPath)) {
          logger.info(LogCategory.DATABASE_SERVICE, t('检测到迁移备份文件，正在恢复...'))
          try {
            if (this._db) {
              ;(this._db as any).close()
              this._db = null
            }
            fs.copyFileSync(backupPath, this.dbPath)
            if (fs.existsSync(backupPath + '-wal'))
              fs.copyFileSync(backupPath + '-wal', this.dbPath + '-wal')
            if (fs.existsSync(backupPath + '-shm'))
              fs.copyFileSync(backupPath + '-shm', this.dbPath + '-shm')
            this.deleteBackupFiles()
            logger.info(LogCategory.DATABASE_SERVICE, t('数据库已从备份恢复'))
          } catch (restoreError) {
            logger.error(LogCategory.DATABASE_SERVICE, t('恢复备份失败'), { error: restoreError })
          }
        }

        this._db = new Database(this.dbPath)
        AccessTimeBatchUpdater.getInstance().setDbProvider(() => this._db)
        this.registerIgnoreFunction()

        this.workspaceDao = new WorkspaceDao(this._db)
        this.fileDao = new FileDao(this._db)
        this.tagUnitDao = new TagUnitDao(this._db)
        this.queueDao = new QueueDao(this._db)

        this._db.pragma(`journal_mode = ${config.pragma.journal_mode}`)
        this._db.pragma(`synchronous = ${config.pragma.synchronous}`)
        this._db.pragma(`cache_size = ${config.pragma.cache_size}`)
        this._db.pragma(`mmap_size = ${config.pragma.mmap_size}`)
        this._db.pragma(`temp_store = ${config.pragma.temp_store}`)
        this._db.pragma(`foreign_keys = ${config.pragma.foreign_keys ? 'ON' : 'OFF'}`)

        if (config.migrations) {
          await this.createTables()
          await this.runMigrationsWithBackup(language)
        }

        this.cleanupOrphanQueueItems()

        // 执行迁移后回调（如：从本地 JSON 加载初始配置）
        for (const cb of this.postMigrationCallbacks) {
          try {
            cb(this._db!)
          } catch (cbError) {
            logger.error(LogCategory.DATABASE_SERVICE, '迁移后回调执行失败:', cbError)
          }
        }
      } catch (error) {
        logger.error(LogCategory.DATABASE_SERVICE, t('数据库初始化失败'), {
          error,
          dbPath: this.dbPath
        })
        if (this._db) {
          try {
            ;(this._db as any).close()
          } catch {
            // ignore
          }
          this._db = null
        }
        this.initPromise = null
        throw error
      }
    })()

    return this.initPromise
  }

  /**
   * 获取备份文件路径
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
      logger.warn(LogCategory.DATABASE_SERVICE, t('删除备份文件失败'), { error })
    }
  }

  /**
   * 创建数据库备份
   */
  private createBackup(): string {
    const backupPath = this.getBackupPath()
    try {
      this._db!.pragma('wal_checkpoint(TRUNCATE)')
      fs.copyFileSync(this.dbPath, backupPath)
      if (fs.existsSync(this.dbPath + '-wal'))
        fs.copyFileSync(this.dbPath + '-wal', backupPath + '-wal')
      if (fs.existsSync(this.dbPath + '-shm'))
        fs.copyFileSync(this.dbPath + '-shm', backupPath + '-shm')
      logger.info(LogCategory.DATABASE_SERVICE, t('数据库备份已创建: {path}', { path: backupPath }))
      return backupPath
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, t('创建数据库备份失败'), { error })
      throw error
    }
  }

  /**
   * 带备份的迁移流程
   */
  private async runMigrationsWithBackup(language?: LanguageCode): Promise<void> {
    const userVersion = this._db!.pragma('user_version', { simple: true }) as number
    const needsMigration = migrations.some(m => m.version > userVersion)

    if (!needsMigration) {
      await this.runMigrations()
      return
    }

    logger.info(LogCategory.DATABASE_SERVICE, t('需要数据库迁移，正在创建备份...'))
    this.createBackup()

    try {
      await this.runMigrations()
      this.deleteBackupFiles()
      logger.info(LogCategory.DATABASE_SERVICE, t('迁移成功，已删除备份'))
    } catch (migrationError) {
      logger.error(LogCategory.DATABASE_SERVICE, t('数据库迁移失败'), { error: migrationError })

      if (this._db) {
        ;(this._db as any).close()
        this._db = null
      }

      await this.showMigrationErrorDialog(migrationError)
      throw migrationError
    }
  }

  private async runMigrations(): Promise<void> {
    if (!this._db) throw new Error('数据库未初始化')
    try {
      const userVersion = this._db.pragma('user_version', { simple: true }) as number
      for (const migration of migrations) {
        if (migration.version > userVersion) {
          logger.info(
            LogCategory.DATABASE_SERVICE,
            t('正在执行迁移版本 {version}: {name}', {
              version: migration.version,
              name: migration.name
            })
          )

          // 关键修正：在执行 migration 前，在事务外将 foreign_keys 关闭以防级联修改外键表名！
          this._db.pragma('foreign_keys = OFF')

          try {
            // 单条执行迁移 SQL，便于定位具体出错语句
            this.executeMigrationSql(migration.up, migration.version)
          } finally {
            // 无论迁移执行是否成功，都必须在事务外重新开启外键约束
            this._db.pragma('foreign_keys = ON')
          }

          this._db.pragma(`user_version = ${migration.version}`)
          logger.info(
            LogCategory.DATABASE_SERVICE,
            t('迁移版本 {version} 完成', { version: migration.version })
          )
        }
      }
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, t('执行数据库迁移失败'), { error })
      throw error
    }
  }

  /**
   * 单条执行迁移 SQL，便于定位具体出错语句
   * 注意：CREATE TRIGGER 语句中的 END; 不应被拆分
   */ private executeMigrationSql(sql: string, migrationVersion: number): void {
    if (!this._db) throw new Error('数据库未初始化')

    // 默认行为：直接通过大事务批量执行（在老数据迁移时外键行为与原版完全一致）
    if (process.env.DEBUG_MIGRATIONS !== 'true') {
      try {
        this._db.transaction(() => {
          this._db!.exec(sql)
        })()
        logger.info(LogCategory.DATABASE_SERVICE, `迁移版本 ${migrationVersion} 批量执行成功`)
        return
      } catch (err: any) {
        if (err.message && err.message.includes('duplicate column name')) {
          logger.warn(
            LogCategory.DATABASE_SERVICE,
            `迁移版本 ${migrationVersion} 列已存在，跳过重复添加: ${err.message}`
          )
          return
        }
        logger.error(
          LogCategory.DATABASE_SERVICE,
          `迁移版本 ${migrationVersion} 批量执行失败，若要获取详细出错 SQL 行，请通过 pnpm start:debug-migrations 启动排错模式。`,
          { error: err.message }
        )
        throw err
      }
    }

    // 调试模式 (DEBUG_MIGRATIONS=true)：逐条拆分并顺序执行，定位具体出错语句
    logger.info(
      LogCategory.DATABASE_SERVICE,
      `[DEBUG_MIGRATIONS] 启用单条 SQL 排错模式，正在执行迁移版本 ${migrationVersion}...`
    )

    const statements: string[] = []
    let current = ''
    let inTrigger = false

    for (const line of sql.split('\n')) {
      const trimmed = line.trim()
      // 跳过纯注释行（以 -- 开头）
      if (trimmed.startsWith('--')) continue

      const upperTrimmed = trimmed.toUpperCase()
      if (/^CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER/i.test(trimmed)) {
        inTrigger = true
      }

      current += line + '\n'
      // 如果当前行以 ; 结尾，说明一条语句可能结束
      if (trimmed.endsWith(';')) {
        if (inTrigger) {
          // 触发器必须以 END; 结束
          if (upperTrimmed === 'END;' || upperTrimmed.startsWith('END;')) {
            inTrigger = false
          } else {
            continue
          }
        }

        const s = current.trim()
        if (s.length > 0) {
          statements.push(s)
        }
        current = ''
      }
    }
    // 处理末尾可能没有 ; 的语句
    if (current.trim().length > 0) {
      statements.push(current.trim())
    }

    for (let i = 0; i < statements.length; i++) {
      const stmt = statements[i]
      const stmtPreview = stmt.substring(0, 150).replace(/\n/g, ' ')
      try {
        this._db.exec(stmt)
        logger.debug(
          LogCategory.DATABASE_SERVICE,
          `[DEBUG_MIGRATIONS] 语句 ${i + 1}/${statements.length} 执行成功: ${stmtPreview}`
        )
      } catch (error: any) {
        const errorMsg = `[DEBUG_MIGRATIONS] 迁移版本 ${migrationVersion} 第 ${i + 1}/${statements.length} 条语句执行失败:\n${stmtPreview}\n错误: ${error.message}`
        logger.error(LogCategory.DATABASE_SERVICE, errorMsg)
        throw new Error(errorMsg)
      }
    }
  }

  /**
   * 显示迁移错误对话框
   */
  private async showMigrationErrorDialog(error: any): Promise<void> {
    // 测试环境下不弹对话框，直接输出错误日志并退出
    if (isTestEnvironment()) {
      const errorMessage = error instanceof Error ? error.message : String(error)
      logger.error(LogCategory.DATABASE_SERVICE, `[DB_MIGRATION_ERROR] ${errorMessage}`)
      logger.error(
        LogCategory.DATABASE_SERVICE,
        `[DB_MIGRATION_STACK] ${error instanceof Error ? error.stack : ''}`
      )
      const { app } = await import('electron')
      app.exit(1)
      return
    }

    try {
      const { dialog, BrowserWindow, app } = await import('electron')
      const errorMessage = error instanceof Error ? error.message : String(error)
      const backupPath = this.getBackupPath()

      const detail = t(
        '数据库升级失败\n\n错误原因: {error}\n\n您的原始数据已安全备份到:\n{path}\n\n请尝试重新启动，系统将自动从备份恢复并重新升级。',
        { error: errorMessage, path: backupPath }
      )

      let attempts = 0
      while (BrowserWindow.getAllWindows().length === 0 && attempts < 50) {
        await new Promise(resolve => setTimeout(resolve, 100))
        attempts++
      }

      const parent = BrowserWindow.getAllWindows()[0]
      const result = await dialog.showMessageBox(parent, {
        type: 'error',
        title: t('数据库升级失败'),
        message: t('数据库升级失败'),
        detail: detail,
        buttons: [t('重新启动'), t('退出应用')],
        defaultId: 0,
        cancelId: 1
      })

      if (result.response === 0) {
        app.relaunch()
        app.exit(0)
      } else {
        app.exit(1)
      }
    } catch (dialogError) {
      const { app } = await import('electron')
      logger.error(LogCategory.DATABASE_SERVICE, `[DB_MIGRATION_DIALOG_ERROR]`, dialogError)
      app.exit(1)
    }
  }

  /**
   * 显示旧版本错误对话框
   */
  private async showLegacyVersionError(): Promise<void> {
    // 测试环境下不弹对话框，直接输出错误日志并退出
    if (isTestEnvironment()) {
      logger.error(LogCategory.DATABASE_SERVICE, '[DB_LEGACY_VERSION_ERROR] 检测到旧版数据库')
      const { app } = await import('electron')
      app.exit(1)
      return
    }

    try {
      const { dialog, BrowserWindow, app } = await import('electron')
      const message = t(
        '检测到旧版数据库 (1.x.x)\n\n本应用 2.0 版本不再支持直接从旧版本升级数据库。\n\n请执行以下操作之一：\n1. 先安装并运行 1.3.2 版本完成过渡升级，然后再安装 2.0 版本。\n2. 手动删除旧的数据库文件（firefly-ai-folder.db），重新启动应用以创建全新的 2.2 架构。\n\n应用现在将关闭。'
      )

      let attempts = 0
      while (BrowserWindow.getAllWindows().length === 0 && attempts < 50) {
        await new Promise(resolve => setTimeout(resolve, 100))
        attempts++
      }

      const parent = BrowserWindow.getAllWindows()[0]
      await dialog.showMessageBox(parent, {
        type: 'error',
        title: t('数据库版本不兼容'),
        message: t('数据库版本过旧'),
        detail: message,
        buttons: [t('退出应用')],
        defaultId: 0
      })

      app.exit(1)
    } catch (dialogError) {
      const { app } = await import('electron')
      app.exit(1)
    }
  }

  /**
   * 清理分析队列中的孤儿项
   */
  public cleanupOrphanQueueItems(): void {
    if (!this._db) return
    try {
      this._db.transaction(() => {
        this._db!.prepare(
          `
          DELETE FROM analysis_queue 
          WHERE item_type = 'file' 
          AND item_id NOT IN (SELECT id FROM workspace_files)
        `
        ).run()

        this._db!.prepare(
          `
          DELETE FROM analysis_queue 
          WHERE item_type = 'directory' 
          AND item_id NOT IN (SELECT id FROM workspace_directories)
        `
        ).run()
      })()
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, t('清理分析队列孤儿项失败'), { error })
    }
  }

  private async createTables(): Promise<void> {
    if (!this._db) throw new Error('数据库未初始化')
    try {
      this._db.pragma('foreign_keys = ON')
      const userVersion = this._db.pragma('user_version', { simple: true }) as number

      if (userVersion === 0) {
        const v1TablesExist = this._db
          .prepare(
            `
          SELECT count(*) as count FROM sqlite_master 
          WHERE type='table' AND name IN ('files', 'workspace_directories', 'file_tags')
        `
          )
          .get() as any

        if (v1TablesExist.count >= 3) {
          logger.warn(LogCategory.DATABASE_SERVICE, t('检测到 1.x 版本数据库，拒绝启动'))
          await this.showLegacyVersionError()
          return
        }
        logger.info(LogCategory.DATABASE_SERVICE, t('全新安装，准备执行架构初始化...'))
      } else if (userVersion === 1) {
        logger.warn(LogCategory.DATABASE_SERVICE, t('检测到版本 1 数据库，拒绝启动'))
        await this.showLegacyVersionError()
      }
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, t('创建数据表失败'), { error })
      throw error
    }
  }

  /**
   * 通用的前端通知方法
   */
  private async notifyFrontend(
    type: 'info' | 'success' | 'warning' | 'error',
    message: string,
    sticky = false,
    id?: string,
    autoClose?: number
  ): Promise<void> {
    try {
      const { BrowserWindow } = await import('electron')
      const windows = BrowserWindow.getAllWindows()
      if (windows && windows.length > 0) {
        windows.forEach(win => {
          if (!win.isDestroyed())
            win.webContents.send('system:notification', { type, message, sticky, id, autoClose })
        })
      }
    } catch (e) {
      logger.warn(LogCategory.DATABASE_SERVICE, t('发送前端通知失败'), { error: e, message })
    }
  }

  // --- DAO Forwarding Methods ---

  async addFileFromPath(
    filePath: string,
    rootPath: string,
    existingWorkspaceId?: number,
    skipHash = false
  ): Promise<number | null> {
    try {
      const stats = fs.statSync(filePath)
      if (!stats.isFile()) {
        return null
      }
    } catch (error) {
      return null
    }

    const dirPath = path.dirname(filePath)
    const directoryId = await this.addDirectory(dirPath, existingWorkspaceId)

    let workspaceId = existingWorkspaceId
    if (!workspaceId) {
      const dirRecord = this._db!.prepare(
        'SELECT workspace_id FROM workspace_directories WHERE id = ?'
      ).get(Number(directoryId)) as any
      workspaceId = dirRecord?.workspace_id
    }

    if (!workspaceId) {
      return null
    }

    let fileFingerprint: string | null = null
    const existing = this._db!.prepare(
      `SELECT id, file_fingerprint, is_analyzed FROM workspace_files WHERE workspace_id = ? AND path = ?`
    ).get(workspaceId, filePath) as any

    if (skipHash) {
      fileFingerprint = existing?.file_fingerprint || null
    } else {
      fileFingerprint = await calculateFileFingerprint(filePath)
    }

    if (fileFingerprint) {
      const stats = fs.statSync(filePath)
      this._db!.prepare(
        `INSERT OR IGNORE INTO files (file_fingerprint, smart_name, size, type, category, created_at, modified_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        fileFingerprint,
        path.basename(filePath),
        stats.size,
        path.extname(filePath).toLowerCase(),
        JSON.stringify({ mime_type: 'application/octet-stream' }),
        stats.birthtime.toISOString(),
        stats.mtime.toISOString(),
        stats.atime.toISOString()
      )
      this._db!.prepare(`INSERT OR IGNORE INTO file_contents (file_fingerprint) VALUES (?)`).run(
        fileFingerprint
      )
    }

    this._db!.prepare(
      `
      INSERT INTO workspace_files (file_fingerprint, workspace_id, directory_id, path, name, created_at, modified_at, accessed_at, is_analyzed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, path) DO UPDATE SET
        file_fingerprint = excluded.file_fingerprint,
        modified_at = excluded.modified_at
    `
    ).run(
      fileFingerprint,
      workspaceId,
      directoryId,
      filePath,
      path.basename(filePath),
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
      existing?.is_analyzed || 0
    )

    const wf = this._db!.prepare(
      `SELECT id FROM workspace_files WHERE workspace_id = ? AND path = ?`
    ).get(workspaceId, filePath) as any
    return wf?.id || null
  }

  async updateFilePath(oldPath: string, newPath: string): Promise<void> {
    await this.addDirectory(path.dirname(newPath))
    return this.fileDao.updateFilePath(oldPath, newPath)
  }

  async addDirectory(dirPath: string, existingWorkspaceId?: number): Promise<number> {
    const exists = this._db!.prepare(
      'SELECT id, workspace_id FROM workspace_directories WHERE path = ?'
    ).get(dirPath) as any
    if (exists) return exists.id

    let workspaceId = existingWorkspaceId
    if (!workspaceId) {
      const rootWorkspace = await this.findRootWorkspaceDirectory(dirPath)
      if (rootWorkspace && rootWorkspace.id) {
        workspaceId = rootWorkspace.id
      }
    }

    if (!workspaceId) {
      throw new Error(`目录不属于任何已注册工作空间: ${dirPath}`)
    }

    const now = new Date().toISOString()
    const stmt = this._db!.prepare(
      `INSERT INTO workspace_directories (workspace_id, path, name, created_at, modified_at) VALUES (?, ?, ?, ?, ?)`
    )
    const result = stmt.run(workspaceId, dirPath, path.basename(dirPath), now, now)
    return Number(result.lastInsertRowid)
  }

  async resetWorkspaceDirectoryAnalysis(directoryPath: string): Promise<void> {
    if (!this._db) throw new Error('数据库未初始化')

    const sep = path.sep
    const likePattern = directoryPath.endsWith(sep)
      ? `${directoryPath}%`
      : `${directoryPath}${sep}%`

    this._db.transaction(() => {
      this._db!.prepare(
        `UPDATE workspace_directories SET is_analyzed = 0, context_analysis = NULL, last_analyzed_at = NULL WHERE path = ? OR path LIKE ?`
      ).run(directoryPath, likePattern)
      this._db!.prepare(
        `UPDATE workspace_files SET is_analyzed = 0, last_analyzed_at = NULL, analysis_error = NULL WHERE directory_id IN (SELECT id FROM workspace_directories WHERE path = ? OR path LIKE ?)`
      ).run(directoryPath, likePattern)

      this._db!.prepare(
        `
        UPDATE files
        SET description = NULL,
            author = NULL,
            language = NULL,
            is_hit = 0,
            last_hit_at = NULL,
            smart_name = (SELECT name FROM workspace_files wf WHERE wf.file_fingerprint = files.file_fingerprint LIMIT 1)
        WHERE file_fingerprint IN (
          SELECT file_fingerprint
          FROM workspace_files
          WHERE directory_id IN (SELECT id FROM workspace_directories WHERE path = ? OR path LIKE ?)
        )
      `
      ).run(directoryPath, likePattern)

      this._db!.prepare(
        `
        UPDATE file_contents
        SET content = NULL,
            multimodal_content = NULL,
            lrc = NULL,
            metadata = NULL,
            analysis_stats = NULL,
            quality_score = NULL,
            quality_confidence = NULL,
            quality_criteria = NULL,
            quality_reasoning = NULL,
            grouping_reason = NULL,
            grouping_confidence = NULL
        WHERE file_fingerprint IN (
          SELECT file_fingerprint
          FROM workspace_files
          WHERE directory_id IN (SELECT id FROM workspace_directories WHERE path = ? OR path LIKE ?)
        )
      `
      ).run(directoryPath, likePattern)

      this._db!.prepare(
        `
        DELETE FROM file_tag_relations
        WHERE file_fingerprint IN (
          SELECT file_fingerprint
          FROM workspace_files
          WHERE directory_id IN (SELECT id FROM workspace_directories WHERE path = ? OR path LIKE ?)
        )
      `
      ).run(directoryPath, likePattern)

      this._db!.prepare(
        `
        DELETE FROM analysis_queue 
        WHERE (item_type = 'directory' AND item_id IN (SELECT id FROM workspace_directories WHERE path = ? OR path LIKE ?))
           OR (item_type = 'file' AND item_id IN (SELECT id FROM workspace_files WHERE directory_id IN (SELECT id FROM workspace_directories WHERE path = ? OR path LIKE ?)))
      `
      ).run(directoryPath, likePattern, directoryPath, likePattern)
    })()
  }

  // --- DAO Methods ---
  async getFileAnalysisResult(p: string) {
    return this.fileDao.getFileAnalysisResult(p)
  }
  async getDirectoryAnalysisResult(p: string) {
    return this.fileDao.getDirectoryAnalysisResult(p)
  }
  async updateFileAnalysisResult(id: string, r: any) {
    return this.fileDao.updateFileAnalysisResult(id, r)
  }
  async resolveUniqueSmartName(
    smartName: string,
    excludeFingerprint: string,
    workspaceId: number
  ): Promise<string> {
    return this.fileDao.resolveUniqueSmartName(smartName, excludeFingerprint, workspaceId)
  }
  async updateAnalysisStage(fileFingerprint: string, stage: number): Promise<void> {
    return this.fileDao.updateAnalysisStage(fileFingerprint, stage)
  }
  async updateAnalysisStageAndQuality(
    fileFingerprint: string,
    stage: number,
    qualityData?: {
      qualityScore?: number | null
      qualityConfidence?: number | null
      qualityReasoning?: string | null
      qualityCriteria?: any | null
    }
  ): Promise<void> {
    return this.fileDao.updateAnalysisStageAndQuality(fileFingerprint, stage, qualityData)
  }
  syncFTSTags(fingerprint: string): void {
    if (this.fileDao) {
      this.fileDao.syncFTSTags(fingerprint)
    }
  }

  syncFTSTagsBatch(fingerprints: string[]): void {
    if (this.fileDao) {
      this.fileDao.syncFTSTagsBatch(fingerprints)
    }
  }
  clearDimensionsCache(): void {
    if (this.fileDao) {
      this.fileDao.clearDimensionsCache()
    }
  }
  async getAllFiles(limit?: number, offset?: number) {
    return this.fileDao.getAllFiles(limit, offset)
  }
  async searchFilesFTS(q: string, wsId?: number) {
    return this.fileDao.searchFilesFTS(q, wsId)
  }
  async searchVirtualDirectoryFiles(keyword: string, virtualDirectoryId?: number): Promise<any[]> {
    return this.fileDao.searchVirtualDirectoryFTS(keyword, virtualDirectoryId)
  }
  async countAnalyzedFilesByWorkspace(wsId: number): Promise<number> {
    return this.fileDao.countAnalyzedFilesByWorkspace(wsId)
  }
  async getAnalyzedFilesByWorkspace(wsId: number, limit?: number) {
    return this.fileDao.getAnalyzedFilesByWorkspace(wsId, limit)
  }
  async getAnalyzedFileByContentHash(h: string) {
    return this.fileDao.getAnalyzedFileByContentHash(h)
  }
  async getFileByPath(p: string) {
    return this.fileDao.getFileByPath(p)
  }
  async getFilesByParentPath(p: string, wsId: number) {
    return this.fileDao.getFilesByParentPath(p, wsId)
  }
  async getFilesByWorkspaceId(workspaceId: number) {
    if (!this._db) throw new Error('数据库未初始化')
    return this._db
      .prepare(
        `
      SELECT wf.id, wf.path, wf.name, wf.is_analyzed, wf.status, wf.file_fingerprint, f.smart_name
      FROM workspace_files wf
      LEFT JOIN files f ON wf.file_fingerprint = f.file_fingerprint
      WHERE wf.workspace_id = ?
    `
      )
      .all(workspaceId) as any[]
  }
  async updateFileMetadata(p: string, s: fs.Stats) {
    return this.fileDao.updateFileMetadata(p, s)
  }
  async updateFileHitStatus(h: string, h2: boolean) {
    return this.fileDao.updateFileHitStatus(h, h2)
  }
  async updateFileThumbnail(p: string, t: string | null) {
    return this.fileDao.updateFileThumbnail(p, t)
  }
  async resetFileAnalysis(p: string) {
    return this.fileDao.resetFileAnalysis(p)
  }
  async updateFileModifiedTime(p: string, m: Date) {
    return this.updateFileMetadata(p, fs.statSync(p))
  }

  // --- Workspace Methods ---
  async addWorkspaceDirectory(d: WorkspaceDirectory) {
    await this.ensureInitialized()
    if (!this.workspaceDao) return null
    const wsId = await this.workspaceDao.add(d)
    await this.addDirectory(d.path, wsId)
    return wsId
  }
  async getAllWorkspaceDirectories() {
    await this.ensureInitialized()
    if (!this.workspaceDao) return []
    return this.workspaceDao.getAll()
  }
  async getWorkspaceDirectoriesWithStats() {
    await this.ensureInitialized()
    if (!this.workspaceDao) return []
    return this.workspaceDao.getAllWithStats()
  }
  async getCurrentWorkspaceDirectory() {
    await this.ensureInitialized()
    if (!this.workspaceDao) return null
    return this.workspaceDao.getCurrent()
  }
  async setCurrentWorkspaceDirectory(p: string) {
    await this.ensureInitialized()
    if (!this.workspaceDao) return
    return this.workspaceDao.setCurrent(p)
  }
  async deleteWorkspaceDirectory(p: string) {
    await this.ensureInitialized()
    if (!this.workspaceDao) return
    return this.workspaceDao.delete(p)
  }
  async updateWorkspaceDirectoryAutoWatch(id: number, a: boolean) {
    if (!this.workspaceDao) return
    return this.workspaceDao.updateAutoWatch(id, a)
  }
  async updateAutoWatch(id: number, a: boolean) {
    return this.updateWorkspaceDirectoryAutoWatch(id, a)
  }
  async updateWorkspaceDirectoryLastScan(id: number) {
    if (!this.workspaceDao) return
    return this.workspaceDao.updateLastScan(id)
  }
  async getWorkspaceDirectoryById(id: number) {
    if (!this.workspaceDao) return null
    return this.workspaceDao.getById(id)
  }
  async getWorkspaceDirectoryByPath(p: string) {
    if (!this.workspaceDao) return null
    return this.workspaceDao.getByPath(p)
  }
  async findRootWorkspaceDirectory(p: string) {
    if (!this.workspaceDao) return null
    return this.workspaceDao.findRoot(p)
  }
  async getWorkspaceIdByPath(p: string) {
    if (!this.workspaceDao) return null
    return (await this.workspaceDao.findRoot(p))?.id || null
  }

  // --- Tag & Unit Methods ---
  async createUnit(d: UnitCreationData) {
    return this.tagUnitDao.createUnit(d)
  }
  async getUnit(id: number) {
    return this.tagUnitDao.getUnit(id)
  }
  async updateUnit(id: number, p: Partial<Unit>) {
    return this.tagUnitDao.updateUnit(id, p)
  }
  async deleteUnit(id: number) {
    return this.tagUnitDao.deleteUnit(id)
  }
  async getUnitsForFile(id: number) {
    return this.tagUnitDao.getUnitsForFile(id)
  }
  async createFileUnitRelation(id: number, uid: number) {
    return this.tagUnitDao.createFileUnitRelation(id, uid)
  }
  async getUnitsForPath(p: string) {
    return this.tagUnitDao.getUnitsForPath(p)
  }
  async getFileTagsByFileId(f: string) {
    return this.tagUnitDao.getFileTagsByFileId(f)
  }

  // --- Queue Methods ---
  getAnalysisQueue() {
    return this.queueDao.getAnalysisQueue()
  }
  async enqueueAnalysis(item: {
    item_id: number | null
    item_type?: 'file' | 'directory'
    status: string
    progress?: number
  }): Promise<number> {
    return this.queueDao.enqueueAnalysis(item)
  }
  enqueueAnalysisSync(item: {
    item_id: number | null
    item_type?: 'file' | 'directory'
    status: string
    progress?: number
  }): number {
    return this.queueDao.enqueueAnalysis(item)
  }
  updateAnalysisQueue(item: {
    id: number
    status?: string
    progress?: number
    error?: string | null
    result?: string | null
  }) {
    return this.queueDao.updateAnalysisQueue(item)
  }
  clearNonCompletedAnalysis() {
    return this.queueDao.clearNonCompletedAnalysis()
  }
  clearPendingAnalysis() {
    return this.queueDao.clearPendingAnalysis()
  }
  retryFailedAnalysis() {
    return this.queueDao.retryFailedAnalysis()
  }
  deleteAnalysis(id: number) {
    return this.queueDao.deleteAnalysis(id)
  }

  async addFilesFromPathsBatch(
    fileInfos: { filePath: string; stats: fs.Stats }[],
    workspaceId: number
  ): Promise<void> {
    if (!this._db) throw new Error('数据库未初始化')
    const now = new Date().toISOString()

    const getExistingStmt = this._db.prepare(`
      SELECT id, file_fingerprint, is_analyzed 
      FROM workspace_files 
      WHERE workspace_id = ? AND path = ?
    `)

    const insertDirectoryStmt = this._db.prepare(`
      INSERT OR IGNORE INTO workspace_directories (workspace_id, path, name, created_at, modified_at)
      VALUES (?, ?, ?, ?, ?)
    `)

    const getDirectoryIdStmt = this._db.prepare(`
      SELECT id FROM workspace_directories WHERE path = ?
    `)

    const insertFileStmt = this._db.prepare(`
      INSERT OR IGNORE INTO files (file_fingerprint, smart_name, size, type, category, created_at, modified_at, accessed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)

    const insertFileContentStmt = this._db.prepare(`
      INSERT OR IGNORE INTO file_contents (file_fingerprint)
      VALUES (?)
    `)

    const insertWorkspaceFileStmt = this._db.prepare(`
      INSERT INTO workspace_files (file_fingerprint, workspace_id, directory_id, path, name, created_at, modified_at, accessed_at, is_analyzed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(workspace_id, path) DO UPDATE SET
        file_fingerprint = excluded.file_fingerprint,
        modified_at = excluded.modified_at
    `)

    const dirIdCache = new Map<string, number>()

    this._db.transaction(() => {
      for (const info of fileInfos) {
        const { filePath, stats } = info
        const dirPath = path.dirname(filePath)

        // 1. 确保目录存在并获取 directoryId
        let dirId = dirIdCache.get(dirPath)
        if (dirId === undefined) {
          const row = getDirectoryIdStmt.get(dirPath) as { id: number } | undefined
          if (row) {
            dirId = row.id
          } else {
            const res = insertDirectoryStmt.run(
              workspaceId,
              dirPath,
              path.basename(dirPath),
              now,
              now
            )
            dirId = Number(res.lastInsertRowid)
          }
          dirIdCache.set(dirPath, dirId)
        }

        // 2. 检查已有的工作区文件
        const existing = getExistingStmt.get(workspaceId, filePath) as
          | { file_fingerprint: string | null; is_analyzed: number }
          | undefined

        const fileFingerprint = existing?.file_fingerprint || null

        if (fileFingerprint) {
          insertFileStmt.run(
            fileFingerprint,
            path.basename(filePath),
            stats.size,
            path.extname(filePath).toLowerCase(),
            JSON.stringify({ mime_type: 'application/octet-stream' }),
            stats.birthtime.toISOString(),
            stats.mtime.toISOString(),
            stats.atime.toISOString()
          )
          insertFileContentStmt.run(fileFingerprint)
        }

        insertWorkspaceFileStmt.run(
          fileFingerprint,
          workspaceId,
          dirId,
          filePath,
          path.basename(filePath),
          new Date().toISOString(),
          stats.mtime.toISOString(),
          new Date().toISOString(),
          existing?.is_analyzed || 0
        )
      }
    })()
  }

  // --- Misc Methods ---
  async addFile(file: FileInfo) {
    return this.addFileFromPath(file.path, '')
  }
  async isConnected() {
    return this._db !== null
  }
  async close() {
    try {
      AccessTimeBatchUpdater.getInstance().flush()
    } catch (e) {
      logger.error(LogCategory.DATABASE_SERVICE, '关闭数据库前刷新 accessed_at 失败:', e)
    }
    if (this._db) {
      ;(this._db as any).close()
      this._db = null
      this.initPromise = null
    }
  }

  private registerIgnoreFunction(): void {
    if (!this._db) return

    let ignoreRulesCache: any[] | null = null
    let lastFetched = 0
    const CACHE_TTL = 5000 // 5 seconds TTL

    this._db.function('should_ignore_file', (filePath: string, fileName: string) => {
      try {
        const now = Date.now()
        if (!ignoreRulesCache || now - lastFetched > CACHE_TTL) {
          ignoreRulesCache = loadIgnoreRules() || []
          lastFetched = now
        }

        return shouldIgnoreFile(filePath, fileName, ignoreRulesCache) ? 1 : 0
      } catch (err) {
        return 0
      }
    })
  }

  async resetAllAnalysisData(): Promise<void> {
    if (!this._db) throw new Error('数据库未初始化')
    try {
      this.clearDimensionsCache()
      this._db.transaction(() => {
        this._db!.prepare(
          `UPDATE workspace_files SET is_analyzed = 0, last_analyzed_at = NULL, analysis_error = NULL`
        ).run()
        this._db!.prepare(
          `UPDATE files SET description = NULL, author = NULL, language = NULL, is_hit = 0, last_hit_at = NULL, smart_name = (SELECT name FROM workspace_files wf WHERE wf.file_fingerprint = files.file_fingerprint LIMIT 1)`
        ).run()
        this._db!.prepare('DELETE FROM file_contents').run()
        this._db!.prepare('DELETE FROM file_tag_relations').run()
        this._db!.prepare('DELETE FROM file_tags').run()
        this._db!.prepare('DELETE FROM tag_expansions').run()
        this._db!.prepare('DELETE FROM dimension_expansions').run()
        this._db!.prepare('DELETE FROM analysis_queue').run()
      })()
      logger.info(LogCategory.DATABASE_SERVICE, t('所有AI分析数据已重置'))
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, t('重置所有AI分析数据失败'), { error })
      throw error
    }
  }

  /**
   * 根据 ID 更新 workspace_files 的 status 状态
   */
  async updateFileStatus(fileId: number, status: number): Promise<void> {
    if (!this._db) return
    try {
      this._db
        .prepare('UPDATE workspace_files SET status = ?, modified_at = ? WHERE id = ?')
        .run(status, new Date().toISOString(), fileId)
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '更新文件状态失败', { error, fileId, status })
    }
  }

  /**
   * 根据路径更新 workspace_files 的 status 状态
   */
  async updateFileStatusByPath(filePath: string, status: number): Promise<void> {
    if (!this._db) return
    try {
      this._db
        .prepare('UPDATE workspace_files SET status = ?, modified_at = ? WHERE path = ?')
        .run(status, new Date().toISOString(), filePath)
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, '根据路径更新文件状态失败', {
        error,
        filePath,
        status
      })
    }
  }
}

export const databaseService = new DatabaseService()
