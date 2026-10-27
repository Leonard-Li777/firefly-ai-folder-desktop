import type {
  FileInfo,
  LanguageCode,
  WorkspaceDirectory,
  Unit,
  UnitCreationData,
  VideoChunkRecord
} from '@firefly/types'
import {
  LogCategory,
  logger,
  isTestEnvironment,
  getCanonicalConceptName,
  isTagAdmissible,
  resolveRuntimeMaterializedPath,
  CONTROLLED_CONCEPTS,
  CONTROLLED_DIMENSION_ROOT_CODES,
  concept,
  isControlledConcept,
  isControlledDimensionApplicableInDomain,
  getParentDimensionCodeOfTag,
  CONTROLLED_CONCEPT_DETAILS,
  classifyDimensionMutexScope
} from '@firefly/shared'
import {
  findTagCodeTwoStage,
  getDatabaseConfig,
  migrations,
  registerDatabaseFunctions,
  resolveTagAliasesLangTable
} from './database'
import { rebuildNamePaths, type RebuildNamePathsResult } from './name-path-rebuilder'
import { omniClient } from '../../services/omni-client'

import Database from 'better-sqlite3'
import { calculateFileFingerprint } from '@firefly/shared'
import * as fs from 'fs'
import * as path from 'path'
import { t } from '@app/languages'

import { WorkspaceDao, FileDao, TagUnitDao, QueueDao } from './dao'
import type { AnalysisTaskType } from './dao'
import { DeterministicCodeGenerator } from '@firefly/core-engine'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { AccessTimeBatchUpdater } from './access-time-batch-updater'
import { loadIgnoreRules, shouldIgnoreFile } from '../analysis/analysis-ignore-service'
import { ConfigDbManager } from '../config/config-db-manager'

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

  /** 当前应用语言，用于扩展标签的离线确定性编码（默认 zh-CN） */
  private currentLanguage = 'zh-CN'

  /**
   * 解析维度的自然主键 code
   *
   * 优先使用调用方显式传入的维度 code（非纯数字）；
   * 仅在显式 code 缺失或为纯数字 ID 时才按权威字典及维度显示名反查，避免降级为 content_tags。
   */
  private resolveDimensionCode(
    dimensionId?: number | string,
    dimensionName?: string
  ): string | null {
    if (dimensionId !== undefined && dimensionId !== null && dimensionId !== '') {
      const raw = String(dimensionId)
      // 若已是自然主键 code 则直接采用
      if (/^[a-z]/.test(raw) && !/^\d+$/.test(raw)) return raw

      // 权威数字 ID 映射（对齐 file-dimension-source.ts / controlled-concepts）
      const numId = Number(dimensionId)
      if (!isNaN(numId)) {
        if (CONTROLLED_DIMENSION_ROOT_CODES[numId]) {
          return CONTROLLED_DIMENSION_ROOT_CODES[numId]
        }

        try {
          const dims = ConfigDbManager.getInstance().getFileDimensions()
          const matched = dims.find(d => d.id === numId)
          if (matched?.code) return matched.code
        } catch {}
      }
    }

    if (dimensionName) {
      const trimmedName = String(dimensionName).trim()
      // 1. 优先使用系统唯一权威受控字典解析（覆盖全部 929+ 个受控概念与维度自然主键）
      if (isControlledConcept(trimmedName)) {
        return concept(trimmedName)
      }

      for (const [id, code] of Object.entries(CONTROLLED_DIMENSION_ROOT_CODES)) {
        const canonical = getCanonicalConceptName(code)
        if (canonical === trimmedName) return code
      }

      try {
        const dims = ConfigDbManager.getInstance().getFileDimensions()
        const matched = dims.find(d => d.name === trimmedName)
        if (matched?.code) return matched.code
      } catch {}

      if (this._db) {
        try {
          const row = this._db
            .prepare(
              `SELECT code FROM file_tags_private
               WHERE name = ? AND (parent_codes IS NULL OR parent_codes = '[]')
               LIMIT 1`
            )
            .get(trimmedName) as { code: string } | undefined
          if (row?.code) return row.code
        } catch {
          // 查询容错：标签树不可用时返回 null，由调用方兜底
        }
      }
    }
    return null
  }

  /**
   * 权威反查标签的自然主键 code
   * 1. 优先查 tag_aliases_{lang} 当前语言别名表（受控 + 动态标签本地镜像）
   * 2. 查 AOT 受控词表 CONTROLLED_CONCEPTS 字典
   * 3. 查 file_tags_private 本地私有表
   */
  private resolveTagCode(tagName: string, viaParentCode?: string): string | null {
    if (!tagName) return null
    const trimmed = String(tagName).trim()
    if (!trimmed) return null

    // 1. 查询当前语言别名分表
    if (this._db) {
      try {
        const targetLocale = this.currentLanguage || 'zh-CN'
        const langTable = resolveTagAliasesLangTable(targetLocale)
        const row = this._db
          .prepare(
            `SELECT tag_code FROM ${langTable}
             WHERE lemma = ?
             ORDER BY is_canonical DESC
             LIMIT 1`
          )
          .get(trimmed) as { tag_code: string } | undefined
        if (row?.tag_code) return row.tag_code
      } catch {}

      // 2. 查询 file_tags_private 本地私有表
      try {
        const row = this._db
          .prepare('SELECT code FROM file_tags_private WHERE name = ? LIMIT 1')
          .get(trimmed) as { code: string } | undefined
        if (row?.code) return row.code
      } catch {}
    }

    // 3. AOT 受控词表字典兜底
    try {
      const code = (CONTROLLED_CONCEPTS as Record<string, string>)[trimmed]
      if (code) return code
    } catch {}

    return null
  }

  /** 迁移完成后执行的回调列表 */
  private postMigrationCallbacks: Array<(db: Database.Database, language: LanguageCode) => void> =
    []

  get db(): Database.Database | null {
    return this._db
  }

  getDbPath(): string {
    return this.dbPath
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
  registerPostMigrationCallback(cb: (db: Database.Database, language: LanguageCode) => void): void {
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

    this.currentLanguage = language

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
        registerDatabaseFunctions(this._db)
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
        this._db.pragma(`busy_timeout = ${config.pragma.busy_timeout ?? 5000}`)

        if (config.migrations) {
          await this.createTables()
          await this.runMigrationsWithBackup(language)
        }

        // 确保过渡期兼容表存在 (兼容已有老库不用强制删库自愈)
        this.ensureCompatibilityTables()

        this.cleanupOrphanQueueItems()

        // 拼音正排索引启动回填（设计文档 §4.4）：幂等 hash 闸门扫描，新鲜行零成本跳过；
        // 未完成部分由行内游标续扫（周期 reconciler 接入后从断点继续）；
        // optimize 由回填内部按需触发（确有写入或未完成时才付段合并成本）
        try {
          this.fileDao.syncPinyinIndexBackfill(3_000)
        } catch (pinyinError) {
          logger.warn(LogCategory.DATABASE_SERVICE, '拼音索引启动回填失败（不影响启动）', {
            error: pinyinError
          })
        }

        // 执行迁移后回调（如：从本地 JSON 加载初始配置）
        for (const cb of this.postMigrationCallbacks) {
          try {
            cb(this._db!, language)
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
        logger.info(LogCategory.DATABASE_SERVICE, t('全新安装，准备执行架构初始化 (Genesis Baseline V1)...'))
      }
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, t('创建数据表失败'), { error })
      throw error
    }
  }

  /**
   * 确保表结构自愈（ADR-0038 创世卫生：剔除只读语义表与向量堆表）
   */
  private ensureCompatibilityTables(): void {
    if (!this._db) return
    try {
      // 创世期卫生：即便历史库残留只读/堆表，也在此彻底剔除（语义与向量改由 Omni 托管）
      this._db.exec(`
        DROP TABLE IF EXISTS file_vectors;
        DROP TABLE IF EXISTS antonym_pairs;
        DROP TABLE IF EXISTS hownet_word_concepts;
        DROP TABLE IF EXISTS hownet_concepts;
        DROP TABLE IF EXISTS hownet_words;
        DROP TABLE IF EXISTS omw_sense_relations;
        DROP TABLE IF EXISTS omw_relations;
        DROP TABLE IF EXISTS omw_lexical_entries;
        DROP TABLE IF EXISTS omw_synsets;
        DROP TABLE IF EXISTS omw_languages;

        -- 历史存量语言字段归一化为 BCP 47 规范格式（如 zh-CN, en-US）
        UPDATE files SET language = 'zh-CN' WHERE language IN ('zh', 'zh_CN', 'zh-cn');
        UPDATE files SET language = 'en-US' WHERE language IN ('en', 'en_US', 'en-us');
        UPDATE files SET language = 'ja-JP' WHERE language IN ('ja', 'ja_JP', 'ja-jp');
        UPDATE files SET language = 'ko-KR' WHERE language IN ('ko', 'ko_KR', 'ko-kr');
      `)

    } catch (error) {
      logger.warn(LogCategory.DATABASE_SERVICE, '确保兼容表结构自愈失败:', error)
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
        `INSERT OR IGNORE INTO files (file_fingerprint, smart_name, size, extension, file_group, created_at, modified_at, accessed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
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

      // 创世 Baseline V1：files 表无 category 列（V4 规范化后由 extension/file_group 承载，
      // magika 类型识别改由标签树表达），故此处仅清空 AI 分析产物字段。
      this._db!.prepare(
        `
        UPDATE files
        SET description = NULL,
            author = NULL,
            language = NULL,
            is_hit = 0,
            last_hit_at = NULL,
            smart_name_source = NULL,
            smart_name_template_source = NULL,
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
            exif = NULL,
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
  /**
   * 补齐单个文件的「已分析完成」标记（幂等）。
   * 供分析管道在提前结束的路径上回写状态，避免队列已完成但 is_analyzed 仍为 0。
   */
  async markFileAnalyzed(workspaceId: number, filePath: string): Promise<number> {
    return this.fileDao.markFileAnalyzed(workspaceId, filePath)
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
  /**
   * 按工作区路径取文件指纹（轻量查询，不加载 contents）。
   *
   * 供只有路径、需要指纹的场景使用（如 Stage 5 高维修正解析队列项指纹）。
   * 服务层不应自行拼 SQL——指纹所在表与列名属 DAO 的领域知识。
   */
  getFileFingerprintByPath(filePath: string): string | null {
    return this.fileDao.getFileFingerprintByPath(filePath)
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
  /** 抢占式提取队头待办任务（普通分析恒优先于高维修正，ADR-0046 / CONTEXT.md 抢占式单队列调度） */
  fetchNextQueueItem(taskType?: AnalysisTaskType) {
    return this.queueDao.fetchNextQueueItem(taskType)
  }
  async enqueueAnalysis(item: {
    item_id: number | null
    item_type?: 'file' | 'directory'
    task_type?: AnalysisTaskType
    status: string
    progress?: number
    force_reanalyze?: boolean
    meta?: Record<string, any>
  }): Promise<number> {
    return this.queueDao.enqueueAnalysis(item)
  }
  enqueueAnalysisSync(item: {
    item_id: number | null
    item_type?: 'file' | 'directory'
    task_type?: AnalysisTaskType
    status: string
    progress?: number
    force_reanalyze?: boolean
    meta?: Record<string, any>
  }): number {
    return this.queueDao.enqueueAnalysis(item)
  }
  updateAnalysisQueue(item: {
    id: number
    status?: string
    progress?: number
    error?: string | null
    result?: string | null
    taskType?: AnalysisTaskType
    task_type?: AnalysisTaskType
    filterTaskType?: AnalysisTaskType
  }) {
    return this.queueDao.updateAnalysisQueue(item)
  }
  clearNonCompletedAnalysis() {
    return this.queueDao.clearNonCompletedAnalysis()
  }
  clearPendingAnalysis(taskType?: AnalysisTaskType) {
    return this.queueDao.clearPendingAnalysis(taskType)
  }
  retryFailedAnalysis(taskType?: AnalysisTaskType) {
    return this.queueDao.retryFailedAnalysis(taskType)
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
      INSERT OR IGNORE INTO files (file_fingerprint, smart_name, size, extension, file_group, created_at, modified_at, accessed_at)
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
        // 创世 Baseline V1：files 表无 category 列（V4 规范化后由 extension/file_group 承载）
        this._db!.prepare(
          `UPDATE files SET description = NULL, file_group = NULL, author = NULL, language = NULL, is_hit = 0, last_hit_at = NULL, smart_name_source = NULL, smart_name_template_source = NULL, smart_name = (SELECT name FROM workspace_files wf WHERE wf.file_fingerprint = files.file_fingerprint LIMIT 1)`
        ).run()
        this._db!.prepare('DELETE FROM file_contents').run()
        this._db!.prepare('DELETE FROM file_tag_relations').run()
        this._db!.prepare('DELETE FROM file_tags_private').run()
        this._db!.prepare('DELETE FROM analysis_queue').run()
        // Spec §3.3 铁律：清空分析数据仅重置文件业务状态，坚决不删除 file_video_chunks，保护切片时序与向量资产
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

  /**
   * 全局直接删除指定维度标签（清理关联关系与标签记录）
   */
  async deleteTagGlobally(dimensionId: number | string, tagName: string): Promise<boolean> {
    if (!this._db) return false
    try {
      // 创世 Baseline V1：标签以 code 自然主键存储，维度由其父级 code 表达。
      const dimCode = this.resolveDimensionCode(dimensionId) || String(dimensionId)

      this._db.transaction(() => {
        const tagRows = this._db!.prepare(
          `
          SELECT code FROM file_tags_private
          WHERE (code LIKE ? || '.%' OR json_extract(parent_codes, '$[0]') = ?)
            AND LOWER(TRIM(name)) = LOWER(TRIM(?))
        `
        ).all(dimCode, dimCode, tagName) as Array<{
          code: string
        }>

        for (const tag of tagRows) {
          this._db!.prepare('DELETE FROM file_tag_relations WHERE tag_code = ?').run(tag.code)
          this._db!.prepare('DELETE FROM file_tags_private WHERE code = ?').run(tag.code)
        }
      })()

      this.clearDimensionsCache()
      logger.info(
        LogCategory.DATABASE_SERVICE,
        `全局删除标签成功: dimId=${dimensionId}, tagName=${tagName}`
      )
      return true
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, `全局删除标签失败: dimId=${dimensionId}, tagName=${tagName}`, {
        error
      })
      return false
    }
  }

  /**
   * 批量应用/解除维度标签
   */
  async batchApplyTags(operation: import('@firefly/types').BatchTagOperation): Promise<import('@firefly/types').BatchTagResult> {
    if (!this._db || !operation.fileIds || operation.fileIds.length === 0) {
      return { successCount: 0, failedCount: 0, updatedFileIds: [], overriddenCount: 0 }
    }

    let successCount = 0
    let failedCount = 0
    const updatedFileIds: number[] = []

    // ──────── Phase 1: 事务外异步预裁决 (Pre-transaction Async Arbitration) ────────
    // 收集所有待添加标签，若未携带显式受控 tagCode 则批量请求 Omni 鉴别受控与祖先继承链
    interface ResolvedAddTagItem {
      tagName: string
      dimCode: string
      tagCode?: string
      isControlled: boolean
      matchedParent: boolean
    }

    const resolvedAddTagItems: ResolvedAddTagItem[] = []
    const combinedAddTags = [...(operation.addTags || []), ...(operation.newTags || [])]
    const uninspectedItems: Array<{ tagName: string; targetParentCode: string; originalIndex: number }> = []

    for (let i = 0; i < combinedAddTags.length; i++) {
      const item = combinedAddTags[i]
      let dimCode =
        item.viaParentCode ||
        item.dimensionCode ||
        this.resolveDimensionCode((item as any).dimensionId, item.dimensionName)

      // 只有显式传入已完成鉴别且匹配父级的受控 code，或显式传入的私有 code 时，才跳过 Omni 预检
      const explicitTagCode = (item as any).tagCode

      // 优先从受控本体反查规范父维度，阻断受控标签私自跌落内容标签伪分支
      if (!dimCode || dimCode === concept('内容标签')) {
        const autoParent =
          (isControlledConcept(item.tagName)
            ? (CONTROLLED_CONCEPT_DETAILS[item.tagName]?.parentName
                ? concept(CONTROLLED_CONCEPT_DETAILS[item.tagName].parentName as any)
                : undefined)
            : undefined) ||
          (explicitTagCode ? getParentDimensionCodeOfTag(explicitTagCode) : undefined)
        dimCode = autoParent || dimCode || concept('内容标签')
      }
      const safeDimCode: string = dimCode || concept('内容标签')

      if (explicitTagCode) {
        // 已有受控或私有 tagCode
        const isControlled =
          !explicitTagCode.startsWith('_ext.') &&
          !explicitTagCode.startsWith('custom.') &&
          (explicitTagCode.startsWith('omw.') ||
            explicitTagCode.startsWith('hownet.') ||
            explicitTagCode.startsWith('builtin.'))
        const matchedParent = (item as any).matchedParent !== false
        resolvedAddTagItems.push({
          tagName: item.tagName,
          dimCode: safeDimCode,
          tagCode: explicitTagCode,
          isControlled,
          matchedParent
        })
      } else {
        uninspectedItems.push({
          tagName: item.tagName,
          targetParentCode: safeDimCode,
          originalIndex: resolvedAddTagItems.length
        })
        resolvedAddTagItems.push({
          tagName: item.tagName,
          dimCode: safeDimCode,
          isControlled: false,
          matchedParent: false
        })
      }
    }

    if (uninspectedItems.length > 0) {
      try {
        const { omniService } = await import('../system/omni-service')
        const isTestEnv = process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST)
        const shouldInspect = !isTestEnv || (await omniService.checkHealth().catch(() => false))

        if (shouldInspect) {
          const inspectResp = await omniService.inspectControlledTags(
            uninspectedItems.map(u => ({ tagName: u.tagName, targetParentCode: u.targetParentCode })),
            this.currentLanguage,
            1500
          )
          if (inspectResp && inspectResp.success && Array.isArray(inspectResp.results)) {
            for (let k = 0; k < uninspectedItems.length; k++) {
              const u = uninspectedItems[k]
              const res = inspectResp.results[k]
              if (res) {
                const target = resolvedAddTagItems[u.originalIndex]
                target.isControlled = res.isControlled
                target.matchedParent = res.matchedParent
                if (res.isControlled && res.matchedParent && res.code) {
                  target.tagCode = res.code
                  if (res.ancestryMatchedCode) {
                    target.dimCode = res.ancestryMatchedCode
                  }
                }
              }
            }
          }
        }
      } catch (err: any) {
        // 测试环境下若未部署常驻 Omni 微服务，降级为私有标签以便单元测试验证离线/派生逻辑
        if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
          logger.debug(
            LogCategory.DATABASE_SERVICE,
            `[batchApplyTags] 测试环境 Omni 未连通，降级为私有标签处理: ${err.message}`
          )
        } else {
          logger.warn(
            LogCategory.DATABASE_SERVICE,
            `[batchApplyTags] Omni 受控鉴别预裁决异常:`,
            err.message
          )
          // 按照悲观熔断铁律：生产环境中严禁静默吞掉假装成功，抛出异常阻断保存
          throw err
        }
      }
    }

    // S2 裁决明细（规格 §4.6）：收录所有发生过裁决的作用域（含「仅跳过、未删除」），最多 100 条。
    // 声明必须在事务回调之外——返回点在回调外读取，放里面会 TS18004。
    const overrides: Array<{
      fileId: number | string
      parentCode: string
      keptTagCode: string
      deletedTagCodes: string[]
      skippedTagCodes: string[]
    }> = []
    let overriddenCount = 0

    // ──────── Phase 2: 同步事务原子落库 (Atomic Synchronous Transaction) ────────
    try {
      this._db.transaction(() => {
        // 1. 处理结构化 addTags 与 newTags
        const createdTagMap = new Map<string, string>()

        for (const item of resolvedAddTagItems) {
          const dimCode = item.dimCode
          if (item.isControlled && item.matchedParent && item.tagCode) {
            // ✅ 受控标签：复用受控 code，绝对不写 file_tags_private
            createdTagMap.set(`${dimCode}:${item.tagName}`, item.tagCode)
          } else {
            // ⚠️ 私有自定义标签：在 file_tags_private 中注册或复用
            let code: string | undefined
            const existingRow = this._db!.prepare(
              'SELECT code, parent_codes FROM file_tags_private WHERE name = ?'
            ).get(item.tagName) as { code: string; parent_codes?: string } | undefined

            if (existingRow?.code) {
              code = existingRow.code
              let parents: string[] = []
              try {
                parents = JSON.parse(existingRow.parent_codes || '[]')
              } catch {
                parents = []
              }
              if (!parents.includes(dimCode)) {
                parents.push(dimCode)
                this._db!.prepare(
                  'UPDATE file_tags_private SET parent_codes = ? WHERE code = ?'
                ).run(JSON.stringify(parents), code)
              }
            } else {
              code = DeterministicCodeGenerator.generateUnique(item.tagName, this.currentLanguage, {
                lookupExistingName: DeterministicCodeGenerator.createDbLookup(this._db!)
              })
              this._db!.prepare(
                `INSERT INTO file_tags_private (code, name, parent_codes, file_groups, source, meta)
                 VALUES (?, ?, ?, '[]', 'user', ?)
                 ON CONFLICT(code) DO UPDATE SET
                   parent_codes = CASE
                     WHEN parent_codes IS NULL OR parent_codes = '' OR parent_codes = '[]'
                       THEN excluded.parent_codes
                     WHEN instr(parent_codes, json_extract(excluded.parent_codes, '$[0]')) > 0
                       THEN parent_codes
                     ELSE json_insert(parent_codes, '$[#]', json_extract(excluded.parent_codes, '$[0]'))
                   END,
                   name = excluded.name`
              ).run(
                code,
                item.tagName,
                JSON.stringify([dimCode]),
                JSON.stringify({ isLeaf: true, isSystem: false, isMultiSelect: true, syncStatus: 0 })
              )
            }
            createdTagMap.set(`${dimCode}:${item.tagName}`, code)
          }
        }

        // 2. 处理待移除标签 removeTags 与 removeTagCodes（精准受控与动态私有分流）
        // 区分「维度限定精准点删 (via_parent_code)」与「全量全局点删」
        const globalDeleteCodes = new Set<string>(operation.removeTagCodes || [])
        const dimDeletePlansMap = new Map<string, Set<string>>()
        const removeItemPlans: Array<{ tagCodes: string[]; dimCode?: string }> = []

        if (operation.removeTags && operation.removeTags.length > 0) {
          for (const item of operation.removeTags) {
            const dimCode =
              item.viaParentCode ||
              item.dimensionCode ||
              this.resolveDimensionCode((item as any).dimensionId, item.dimensionName) ||
              undefined

            const itemCodes: string[] = []
            if (item.tagCode) {
              itemCodes.push(item.tagCode)
            } else if (item.tagName) {
              const tagName = String(item.tagName).trim()
              if (tagName) {
                // 1. 受控概念字典优先解析
                let controlled: string | undefined
                try {
                  controlled = (CONTROLLED_CONCEPTS as Record<string, string>)[tagName]
                } catch {}
                if (!controlled && isControlledConcept(tagName)) {
                  controlled = concept(tagName)
                }

                if (controlled) {
                  itemCodes.push(controlled)
                }

                // 2. 别名表与私有表解析 (统一委托给 resolveTagCode)
                const resolved = this.resolveTagCode(tagName, dimCode)
                if (resolved) {
                  itemCodes.push(resolved)
                }

                // 3. 开放动态私有标签：防范多维度同名多代码遗漏
                try {
                  const rows = this._db!.prepare(
                    'SELECT code FROM file_tags_private WHERE name = ?'
                  ).all(tagName) as Array<{ code: string }>
                  for (const r of rows) {
                    if (r.code) {
                      itemCodes.push(r.code)
                    }
                  }
                } catch {}

                itemCodes.push(tagName)
              }
            }

            if (dimCode && itemCodes.length > 0) {
              let dimSet = dimDeletePlansMap.get(dimCode)
              if (!dimSet) {
                dimSet = new Set<string>()
                dimDeletePlansMap.set(dimCode, dimSet)
              }
              for (const c of itemCodes) {
                dimSet.add(c)
              }
              removeItemPlans.push({ tagCodes: itemCodes, dimCode })
            } else {
              for (const c of itemCodes) {
                globalDeleteCodes.add(c)
              }
            }
          }
        }

        // 3. 遍历文件应用或解绑
        const allAddTagItems: Array<{ tagCode: string; viaParentCode: string; tagName?: string }> = []
        for (const [key, code] of createdTagMap.entries()) {
          const parts = key.split(':')
          const dimCode = parts[0] || ''
          const tagName = parts.slice(1).join(':')
          allAddTagItems.push({ tagCode: code, viaParentCode: dimCode, tagName })
        }
        for (const code of operation.addTagCodes || []) {
          const found = this._db!.prepare('SELECT code, name, parent_codes FROM file_tags_private WHERE code = ?').get(code) as { code: string; name?: string; parent_codes?: string } | undefined
          let viaParentCode = ''
          if (found?.parent_codes) {
            try {
              const parents = JSON.parse(found.parent_codes)
              if (Array.isArray(parents) && parents.length > 0) {
                viaParentCode = parents[0]
              }
            } catch {}
          }
          allAddTagItems.push({
            tagCode: code,
            viaParentCode,
            tagName: found?.name || getCanonicalConceptName(code) || code
          })
        }

        // 全媒体领域排他门控铁律：非视觉介质（音频/文档/代码/压缩包）严禁挂载视觉专有维度与标签
        const isVisualExclusiveDimension = (dimCode: string, tagCode: string, targetPath: string): boolean => {
          const ctx = { filePath: targetPath }
          const effectiveDim = dimCode || getParentDimensionCodeOfTag(tagCode)
          if (effectiveDim && !isControlledDimensionApplicableInDomain(effectiveDim, ctx)) {
            return true
          }
          return false
        }

        // 提前预计算当前批次待添加标签的物化路径三元组 (O(M) 缓存，杜绝热循环内部 O(N*M) 重复 SQL 查询)
        const materializedMap = new Map<string, { codePath: string; namePath: string; depth: number }>()
        for (const item of allAddTagItems) {
          const tagName = item.tagName || getCanonicalConceptName(item.tagCode) || item.tagCode
          const key = `${item.viaParentCode}:${item.tagCode}`
          if (!materializedMap.has(key)) {
            materializedMap.set(
              key,
              resolveRuntimeMaterializedPath({
                db: this._db!,
                tagCode: item.tagCode,
                viaParentCode: item.viaParentCode,
                tagName
              })
            )
          }
        }

        const insertStmt = this._db!.prepare(
          "INSERT OR REPLACE INTO file_tag_relations (file_fingerprint, tag_code, via_parent_code, code_path, name_path, depth, tag_group, source, confidence, sync_status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'user', 'user', 1.0, 0, CURRENT_TIMESTAMP)"
        )

        // 预编译指纹与路径查询语句（杜绝循环内重复 prepare）
        // 铁律（S0-b）：只能引用 GENESIS_V1_SCHEMA 中真实存在的列。
        // files 表主键只有 file_fingerprint，既无 id 也无 path（database.ts:90-109）；
        // id / path 仅存在于 workspace_files（database.ts:133-153）。better-sqlite3 的 prepare
        // 是即时编译，引用不存在的列会在此处（逐文件 try/catch 之外）抛错并让整批事务回滚。
        const selectWfByIdStmt = this._db!.prepare('SELECT file_fingerprint, path FROM workspace_files WHERE id = ?')
        const selectFilesByFpStmt = this._db!.prepare('SELECT file_fingerprint FROM files WHERE file_fingerprint = ?')
        const selectWfByPathStmt = this._db!.prepare('SELECT file_fingerprint, path FROM workspace_files WHERE path = ?')

        // 预编译精准删除语句（杜绝循环内重复 prepare，对齐 Spec §3.6 性能铁律）
        const dimDeleteStmts: Array<{ stmt: any; dimCode: string; params: string[] }> = []
        for (const [dimCode, codeSet] of dimDeletePlansMap.entries()) {
          if (codeSet.size > 0) {
            const codes = Array.from(codeSet)
            const placeholders = codes.map(() => '?').join(',')
            const stmt = this._db!.prepare(
              `DELETE FROM file_tag_relations WHERE file_fingerprint = ? AND via_parent_code = ? AND tag_code IN (${placeholders})`
            )
            dimDeleteStmts.push({ stmt, dimCode, params: codes })
          }
        }

        let globalDeleteStmt: { stmt: any; params: string[] } | null = null
        if (globalDeleteCodes.size > 0) {
          const codes = Array.from(globalDeleteCodes)
          const placeholders = codes.map(() => '?').join(',')
          globalDeleteStmt = {
            stmt: this._db!.prepare(
              `DELETE FROM file_tag_relations WHERE file_fingerprint = ? AND tag_code IN (${placeholders})`
            ),
            params: codes
          }
        }

        // S2 互斥收拢语句（规格 §4.1 阶段 B / §4.3）：与 insertStmt 一同在事务开头预编译，循环内只 run/get。
        // 覆盖删除必须写成「tag_code <> winner」而不是「清空该作用域」——否则 INSERT winner 失败时维度已被清空（P0-A）。
        const selectSiblingsStmt = this._db!.prepare(
          'SELECT tag_code FROM file_tag_relations WHERE file_fingerprint = ? AND via_parent_code = ? AND tag_code <> ?'
        )
        const overrideDeleteStmt = this._db!.prepare(
          'DELETE FROM file_tag_relations WHERE file_fingerprint = ? AND via_parent_code = ? AND tag_code <> ?'
        )

        // S2 显式移除集合（覆盖删除豁免判定用，规格 §4.4 第三行）：
        // removeTags 解析出的维度限定码 ∪ removeTagCodes 全局码。winner 落在本集合 ⇒ 跳过覆盖删除，
        // 否则「既有兄弟被清空 + winner 随后又被点删 ⇒ 维度变空」，比「保留兄弟」更糟。
        const explicitRemoveCodes = new Set<string>(globalDeleteCodes)
        for (const codeSet of dimDeletePlansMap.values()) {
          for (const c of codeSet) explicitRemoveCodes.add(c)
        }

        // S2 作用域判定批级缓存：父行 meta 在本事务前已注册，批内不变
        const scopeModeCache = new Map<string, 'single' | 'multi' | 'skip'>()

        for (const fileId of operation.fileIds) {
          try {
            let fp: string | undefined
            let filePath: string | undefined

            // 1. 优先从 workspace_files 按 id 查询指纹与路径（前端文件列表的主标识通常为 workspace_files.id）
            const wfRow = selectWfByIdStmt.get(fileId) as { file_fingerprint: string; path?: string } | undefined

            if (wfRow?.file_fingerprint) {
              fp = wfRow.file_fingerprint
              filePath = wfRow.path
            } else {
              // 2. 尝试作为 file_fingerprint 字符串本身查询（files 表无 path，只能取指纹）
              const fpRow = selectFilesByFpStmt.get(fileId) as { file_fingerprint: string } | undefined
              if (fpRow?.file_fingerprint) {
                fp = fpRow.file_fingerprint
              } else {
                // 3. 尝试作为 workspace_files 路径查询（UI 侧 fileIds 可能退化为 f.path）
                const pathRow = selectWfByPathStmt.get(fileId) as { file_fingerprint: string; path?: string } | undefined
                if (pathRow?.file_fingerprint) {
                  fp = pathRow.file_fingerprint
                  filePath = pathRow.path
                }
              }
            }

            if (!fp) {
              failedCount++
              continue
            }

            // ────────── S2 阶段 A：候选过滤 / 去重 / 分组 / 裁决（规格 §4.1 步骤 2-6） ──────────
            // 门禁依赖 filePath，故过滤与分组必须逐文件进行（时效性：filePath 是本文件解析结果）。
            // ADR-0045：本路径为用户手动批量打标，来源分组固定落 'user'，source 固定落 'user'。
            const materializeOf = (tagCode: string, viaParentCode: string, tagName: string) =>
              materializedMap.get(`${viaParentCode}:${tagCode}`) || {
                codePath: `/${viaParentCode || 'content_tags'}/${tagCode}`,
                namePath: `/${viaParentCode || '内容标签'}/${tagName}`,
                depth: viaParentCode ? 2 : 1
              }

            const insertItem = (tagCode: string, viaParentCode: string, tagName?: string) => {
              const name = tagName || getCanonicalConceptName(tagCode) || tagCode
              const materialized = materializeOf(tagCode, viaParentCode, name)
              insertStmt.run(fp, tagCode, viaParentCode, materialized.codePath, materialized.namePath, materialized.depth)
            }

            // 步骤 2：过滤（全媒体排他门禁 + 准入闸）。被拦者不参与胜出裁决，也就不会造成覆盖删除。
            const survivors: Array<{ tagCode: string; viaParentCode: string; tagName?: string }> = []
            for (const item of allAddTagItems) {
              // 全媒体领域排他门控铁律：非视觉介质（音频/文档/代码/压缩包）严禁挂载视觉专有维度与标签
              if (filePath && isVisualExclusiveDimension(item.viaParentCode, item.tagCode, filePath)) {
                logger.debug(
                  LogCategory.DATABASE_SERVICE,
                  `[batchApplyTags] 全媒体排他门禁拦截: 跳过向非视觉介质挂载视觉专有标签 (${filePath} -> ${item.tagCode})`
                )
                continue
              }

              // (PRD-0057 S4 / GH #714) 用户手动批量打标旁路闸门：
              // 来源为 user，走豁免短路（isTagAdmissible 永不拒，断言全部放行）
              const tagName = item.tagName || getCanonicalConceptName(item.tagCode) || item.tagCode
              const verdict = isTagAdmissible({
                name: tagName,
                tagGroup: 'user'
              })
              if (verdict.outcome === 'rejected') {
                logger.debug(
                  LogCategory.DATABASE_SERVICE,
                  `[tag-admissibility] ${verdict.rule} 拒绝用户打标入库: "${tagName}" (${verdict.reason})`
                )
                continue
              }

              survivors.push(item)
            }

            // 步骤 3+4：按 (effectiveParent, tagCode) 去重（保留末位）后按父级分组。
            // 去重是必需的（规格 §4.2）：createdTagMap 以 `${dim}:${tagName}` 为键，不同别名可映射到
            // 同一 code；addTagCodes 也会与 addTags 重复。不去重会出现「同一 code 既 kept 又 skipped」。
            const candidateGroups = new Map<string, Array<{ tagCode: string; tagName?: string }>>()
            for (const item of survivors) {
              let group = candidateGroups.get(item.viaParentCode)
              if (!group) {
                group = []
                candidateGroups.set(item.viaParentCode, group)
              }
              // 先移除同 code 旧位次再压入，保证组内顺序即「末位胜出」顺序
              const dupIdx = group.findIndex(c => c.tagCode === item.tagCode)
              if (dupIdx >= 0) group.splice(dupIdx, 1)
              group.push({ tagCode: item.tagCode, tagName: item.tagName })
            }

            // ────────── S2 阶段 B：落库（规格 §4.1 步骤 7-8；铁律：先 INSERT winner，后 DELETE 兄弟） ──────────
            for (const [parentCode, candidates] of candidateGroups) {
              const mode = this.resolveBatchTagScopeMode(parentCode, scopeModeCache, this._db!)

              if (mode !== 'single' || candidates.length === 0) {
                // 8. multi / rule / unknown(显式多选) / 无父级：按原逻辑逐条 INSERT，绝不做覆盖删除
                for (const c of candidates) insertItem(c.tagCode, parentCode, c.tagName)
                continue
              }

              // 5. 裁决：数组末位胜出（D-06 已裁定不做点击顺序，末位仅作确定性兜底）
              const winner = candidates[candidates.length - 1]
              let skippedTagCodes = candidates.slice(0, -1).map(c => c.tagCode)

              // 6. winner 被同批显式移除 ⇒ 用户意图是「删它」，跳过覆盖删除（否则维度被清空）
              const skipOverrideDelete = explicitRemoveCodes.has(winner.tagCode)

              // 7a. 先 INSERT winner：失败即抛（本文件记 failedCount），此刻未发生任何删除 ⇒ 维度未被修改
              insertItem(winner.tagCode, parentCode, winner.tagName)

              let deletedTagCodes: string[] = []
              if (!skipOverrideDelete) {
                // 7b. 覆盖前 SELECT 既有兄弟（不含 winner 自身）
                const siblingRows = selectSiblingsStmt.all(fp, parentCode, winner.tagCode) as Array<{
                  tag_code: string
                }>
                deletedTagCodes = siblingRows.map(r => r.tag_code).filter(Boolean)

                if (deletedTagCodes.length > 0) {
                  // 7c. 删除既有兄弟；`tag_code <> winner` 保证刚写入的 winner 不被自己删掉
                  overrideDeleteStmt.run(fp, parentCode, winner.tagCode)
                  // 7d. 只有真实删除过既有兄弟才计入 overriddenCount（回答「有没有覆盖旧值」）
                  overriddenCount++
                }

                // 规格 §4.2 末段：同一 code 只按「被删」记一次，从 skipped 中剔除
                if (deletedTagCodes.length > 0 && skippedTagCodes.length > 0) {
                  skippedTagCodes = skippedTagCodes.filter(c => !deletedTagCodes.includes(c))
                }
              }

              // 明细：收录所有发生过裁决的作用域（含「仅跳过」），这样 skippedTagCodes 才有承载对象
              if (overrides.length < 100 && (skippedTagCodes.length > 0 || deletedTagCodes.length > 0)) {
                overrides.push({
                  fileId,
                  parentCode,
                  keptTagCode: winner.tagCode,
                  deletedTagCodes,
                  skippedTagCodes
                })
              }
            }

            // 移除标签关联（精准索引点删：有维度限定走带 via_parent_code，无维度限定走全局点删）
            for (const { stmt, dimCode, params } of dimDeleteStmts) {
              stmt.run(fp, dimCode, ...params)
            }

            if (globalDeleteStmt) {
              globalDeleteStmt.stmt.run(fp, ...globalDeleteStmt.params)
            }

            successCount++
            updatedFileIds.push(fileId)
          } catch (err: any) {
            logger.warn(
              LogCategory.DATABASE_SERVICE,
              `[batchApplyTags] 单个文件(${fileId})打标落库失败:`,
              err?.message || err
            )
            failedCount++
          }
        }

        // 同步清理 file_tags_private 中针对已移除维度的 parent_codes 关联
        // 铁律：仅当全库中已无任何文件在此维度下引用该标签时，才从全局词库解绑该维度的 parent_codes，绝不误杀多文件共享词库！
        for (const plan of removeItemPlans) {
          if (plan.dimCode && plan.tagCodes.length > 0) {
            for (const code of plan.tagCodes) {
              try {
                const refRow = this._db!.prepare(
                  'SELECT COUNT(*) as c FROM file_tag_relations WHERE tag_code = ? AND via_parent_code = ?'
                ).get(code, plan.dimCode) as { c: number } | undefined
                const remainingCount = refRow?.c || 0
                if (remainingCount > 0) {
                  // 数据库中仍有其他文件在当前维度下关联此标签，绝不破坏全局词库关系！
                  continue
                }

                const row = this._db!.prepare(
                  'SELECT parent_codes FROM file_tags_private WHERE code = ?'
                ).get(code) as { parent_codes?: string } | undefined
                if (row?.parent_codes) {
                  let parents: string[] = []
                  try {
                    parents = JSON.parse(row.parent_codes)
                  } catch {
                    parents = []
                  }
                  if (parents.includes(plan.dimCode)) {
                    parents = parents.filter(p => p !== plan.dimCode)
                    this._db!.prepare(
                      'UPDATE file_tags_private SET parent_codes = ? WHERE code = ?'
                    ).run(JSON.stringify(parents), code)
                  }
                }
              } catch (cleanErr: any) {
                logger.warn(
                  LogCategory.DATABASE_SERVICE,
                  `[batchApplyTags] 清理私有标签(${code})父级关联失败:`,
                  cleanErr?.message || cleanErr
                )
              }
            }
          }
        }
      })()

      this.clearDimensionsCache()
    } catch (err) {
      logger.error(LogCategory.DATABASE_SERVICE, '批量打标签事务失败:', err)
      throw err
    }

    return {
      successCount,
      failedCount,
      updatedFileIds,
      // S2：互斥收拢统计（规格 §4.6）。overriddenCount 只统计真实删除过既有兄弟的「文件-作用域」次数；
      // overrides 收录所有发生过裁决的作用域（含「仅跳过」），供 UI 做 toast 回显与排障。
      overriddenCount,
      overrides
    }
  }

  /**
   * S2 互斥收拢的作用域判定（规格 §3.2 `resolveScopeMode`，是 `classifyDimensionMutexScope` 的写库侧包装）
   *
   * 判定顺序（`rule` 必须优先：规则自有维度本身就在 RAW_SINGLE / RAW_MULTI 里）：
   *   1. 无父级            → 'skip'（无作用域可定义，绝不删）
   *   2. 'rule'（规则自有） → 'skip'（程序写入的事实标签，误删会破坏扩展名/文件类型等识别结果）
   *   3. 'multi'           → 'multi'（全放行）
   *   4. 'single'          → 'single'（互斥收拢 + 覆盖删除）
   *   5. 'unknown'         → 读父行 `file_tags_private.meta.isMultiSelect`：
   *                         显式 true ⇒ 'multi'，否则 'single'（ADR-0034 默认单选）
   *
   * 第 5 条的逃生口恰好覆盖「叶标签当父级」：`batchApplyTags` 给私有叶标签写的 meta 恒为
   * `{ isLeaf: true, isMultiSelect: true }`（本函数下方私有标签注册处），其语义是「子节点可多选」，
   * 读到这里正好导向非破坏性的 'multi'。`unknown` 取 'single' 而非 'skip' 的理由见规格 §3.2：
   * UI 互斥不删已入库标签（`BatchTagView.tsx` 仅把兄弟置回 `initial`），'skip' 会放任冲突累积。
   *
   * @param parentCode 作用域 = 维度根 code（写入键与删除键同源，均为 `via_parent_code`）
   * @param cache 批级缓存：父行 meta 在事务前已注册，批内不变，同一父级只解析一次
   */
  private resolveBatchTagScopeMode(
    parentCode: string,
    cache: Map<string, 'single' | 'multi' | 'skip'>,
    db: Database.Database
  ): 'single' | 'multi' | 'skip' {
    const cached = cache.get(parentCode)
    if (cached) return cached

    let mode: 'single' | 'multi' | 'skip'
    if (!parentCode) {
      mode = 'skip'
    } else {
      switch (classifyDimensionMutexScope(parentCode)) {
        case 'rule':
          mode = 'skip'
          break
        case 'multi':
          mode = 'multi'
          break
        case 'single':
          mode = 'single'
          break
        default: {
          let isMulti = false
          try {
            const row = db
              .prepare('SELECT meta FROM file_tags_private WHERE code = ?')
              .get(parentCode) as { meta?: string } | undefined
            if (row?.meta) {
              const meta = JSON.parse(row.meta) as { isMultiSelect?: boolean } | null
              isMulti = meta?.isMultiSelect === true
            }
          } catch {
            // meta 缺失/解析失败：按单选兜底（保守方向，宁可收拢也不放任冲突）
          }
          mode = isMulti ? 'multi' : 'single'
        }
      }
    }

    cache.set(parentCode, mode)
    return mode
  }

  /**
   * 多语言展示层标签名解析器 (Tag Display Resolver)
   * ADR-0038 / Issue #682 / tag-aliases-lang-tables：
   * 1. 受控 + 动态标签展示名统一查主库当前语言分表 tag_aliases_{lang}（本地持久化镜像，零网络）；
   * 2. 用户/扩展标签兜底读取本地 file_tags_private.name；
   * 3. 彻底废除对 omw_lexical_entries 等只读语义表的裸 SQL 查询与 TaxonomyAliasCache 内存总线。
   *
   * @param tagCodes 需要解析显示名称的标签 code 数组
   * @param locale 当前目标语言代码 (如 'zh-CN', 'en-US')，缺省为当前系统语言
   */
  public getCurrentLanguage(): string {
    return this.currentLanguage
  }

  public resolveTagDisplayNames(
    tagCodes: string[],
    locale?: string,
    dbInstance?: Database.Database
  ): Record<string, string> {
    const result: Record<string, string> = {}
    if (!tagCodes || tagCodes.length === 0) return result
    for (const code of tagCodes) {
      result[code] = code // 默认兜底为 code 本身
    }

    const distinctCodes = Array.from(new Set(tagCodes.filter(Boolean)))
    if (distinctCodes.length === 0) return result

    try {
      const activeDb = dbInstance || this._db
      const targetLocale = locale || this.currentLanguage || 'zh-CN'
      const langTable = resolveTagAliasesLangTable(targetLocale)
      const isZh = targetLocale.toLowerCase().startsWith('zh')

      // 0) 中文环境下优先 AOT 受控权威词条（仅针对受控代码：omw.*, hownet.*, builtin.*）
      if (isZh) {
        for (const code of distinctCodes) {
          if (code.startsWith('builtin.') || code.startsWith('omw.') || code.startsWith('hownet.')) {
            const canonical = getCanonicalConceptName(code)
            if (canonical) {
              result[code] = canonical
            }
          }
        }
      }

      // 1) 受控 + 动态标签统一查当前语言分表（替换内存总线优先）
      if (activeDb && distinctCodes.length > 0) {
        try {
          const aliasPlaceholders = distinctCodes.map(() => '?').join(',')
          // 优先规范名（is_canonical=1），其次首个词形
          const aliasRows = activeDb
            .prepare(
              `SELECT tag_code, lemma FROM ${langTable}
               WHERE tag_code IN (${aliasPlaceholders})
               ORDER BY is_canonical DESC`
            )
            .all(...distinctCodes) as { tag_code: string; lemma: string }[]
          for (const r of aliasRows) {
            if (r.lemma && result[r.tag_code] === r.tag_code) {
              result[r.tag_code] = r.lemma
            }
          }
        } catch {
          // 若当前分表在 mock DB 中不存在，平滑降级到 private 表或原名
        }
      }

      // 2) 未命中分表时，以本地 file_tags_private.name（默认名）兜底
      const stillMissing = distinctCodes.filter(c => result[c] === c)
      if (activeDb && stillMissing.length > 0) {
        try {
          const tagPlaceholders = stillMissing.map(() => '?').join(',')
          const tagRows = activeDb
            .prepare(`SELECT code, name FROM file_tags_private WHERE code IN (${tagPlaceholders})`)
            .all(...stillMissing) as { code: string; name: string }[]
          for (const row of tagRows) {
            if (row.name) {
              const isControlled =
                row.code.startsWith('builtin.') ||
                row.code.startsWith('omw.') ||
                row.code.startsWith('hownet.')
              const canonical = isZh && isControlled ? getCanonicalConceptName(row.code) : undefined
              result[row.code] = canonical || row.name
            }
          }
        } catch {}
      }

      // 3) 仍未命中的受控标签，优先 AOT 概念字典兜底，再提取可读 slug
      for (const code of distinctCodes) {
        if (result[code] === code && (code.startsWith('builtin.') || code.startsWith('omw.') || code.startsWith('hownet.'))) {
          const canonical = getCanonicalConceptName(code)
          if (canonical) {
            result[code] = canonical
          } else {
            const parts = code.split('.')
            const readable = parts[parts.length - 1]
            if (readable) {
              result[code] = readable
            }
          }
        }
      }
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, 'resolveTagDisplayNames 解析失败:', error)
    }

    return result
  }

  /**
   * 按 lemma 快速查询受控标签 tag_code (反查，走当前语言分表 lemma 索引)
   * 优先级：omw.* > builtin.*（与旧 TaxonomyAliasCache 反查映射规则一致）
   *
   * ADR-0048 两阶段跨语言反查：当前语言分表未命中时走 Unicode LID 异语分表反查，
   * 异语命中后反查当前语言 is_canonical = 1 规范名就地本地化（与 Rust 侧
   * resolve_controlled_tag_two_stage 对齐，Q2 选项 A）。
   *
   * @returns 命中的受控 code；`localized` 为异语命中时的当前语言规范展示名（同语种命中时为 undefined）
   */
  public findTagCodeByLemma(
    lemma: string,
    locale?: string
  ): { tagCode: string; localized?: string } | undefined {
    if (!lemma || !this._db) return undefined
    try {
      return findTagCodeTwoStage(this._db, lemma, locale, this.currentLanguage)
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, 'findTagCodeByLemma 反查失败:', error)
      return undefined
    }
  }

  /**
   * 按 tag_code 快速查询当前语言规范展示名 (读当前语言分表，优先规范名)
   */
  public findLemmaByTagCode(tagCode: string, locale?: string): string | undefined {
    if (!tagCode || !this._db) return undefined
    const targetLocale = locale || this.currentLanguage || 'zh-CN'
    const langTable = resolveTagAliasesLangTable(targetLocale)
    try {
      const rows = this._db
        .prepare(
          `SELECT lemma FROM ${langTable}
           WHERE tag_code = ?
           ORDER BY is_canonical DESC
           LIMIT 1`
        )
        .all(tagCode) as { lemma: string }[]
      return rows[0]?.lemma
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, 'findLemmaByTagCode 查询失败:', error)
      return undefined
    }
  }


  /**
   * AI 分析完成后将 dense 向量写入 Omni zvec（替代旧 file_vectors BLOB 堆表）
   * `encoderId` 必填：向量真实编码器出处（zvec v3 encoder_id），由调用方从 perceive 响应原样透传，
   * 禁止本层按档位或语言补默认值。
   */
  public async upsertFileVectorToOmni(
    fileFingerprint: string,
    embedding: number[] | Float32Array | null | undefined,
    encoderId: number
  ): Promise<boolean> {
    if (!fileFingerprint || !embedding) return false
    const vector = embedding instanceof Float32Array ? Array.from(embedding) : embedding
    if (!Array.isArray(vector) || vector.length === 0) return false
    const res = await omniClient.upsertVector(fileFingerprint, vector, encoderId)
    return !!res?.success
  }

  /**
   * 批量将切片或文件 dense 向量写入 Omni zvec
   * 每个条目必须携带自己的 `encoderId`（视频切片与主向量可能不同源），禁止本层统一猜测。
   */
  public async upsertFileVectorsToOmni(
    items: Array<{ fileFingerprint: string; vector: number[] | Float32Array; encoderId: number }>
  ): Promise<boolean> {
    if (!items || items.length === 0) return true
    const validItems: Array<{ fileFingerprint: string; vector: number[]; encoderId: number }> = []
    for (const item of items) {
      if (!item.fileFingerprint || !item.vector) continue
      const v = item.vector instanceof Float32Array ? Array.from(item.vector) : item.vector
      if (Array.isArray(v) && v.length > 0) {
        validItems.push({ fileFingerprint: item.fileFingerprint, vector: v, encoderId: item.encoderId })
      }
    }
    if (validItems.length === 0) return true
    const res = await omniClient.upsertVectors(validItems)
    return !!res?.success
  }

  /**
   * 批量写入视频时序切片记录
   */
  insertVideoChunks(chunks: VideoChunkRecord[]): void {
    this.ensureInitialized()
    this.fileDao!.insertVideoChunks(chunks)
  }

  /**
   * 按指纹获取视频时序切片记录
   */
  getVideoChunks(
    fileFingerprint: string
  ): Array<{ id?: number; fileFingerprint: string; chunkIndex: number; startSec: number; endSec: number; repPtsSec: number; meta: Record<string, any>; samplingIntervalSeconds: number; createdAt?: string }> {
    this.ensureInitialized()
    return this.fileDao!.getVideoChunks(fileFingerprint)
  }

  /**
   * 按指纹删除视频时序切片记录
   */
  deleteVideoChunks(fileFingerprint: string): void {
    this.ensureInitialized()
    this.fileDao!.deleteVideoChunks(fileFingerprint)
  }

  /**
   * 切换语言时，按指定目标语言重建存量 file_tag_relations 中的 name_path 物化路径
   */
  public async rebuildNamePathsForLanguage(targetLocale: string): Promise<RebuildNamePathsResult> {
    if (!this._db) {
      return { distinctPathsCount: 0, updatedCount: 0 }
    }
    return rebuildNamePaths(this._db, targetLocale)
  }
}


/** @deprecated 向量已由 Omni zvec 托管，类型保留仅为兼容外部引用 */
export interface FileVectorRecord {
  fileFingerprint: string
  textEmbedding: Float32Array | null
  imageEmbedding: Float32Array | null
  multimodalEmbedding: Float32Array | null
  status: number
  modelVersion: string | null
  meta: Record<string, any>
  updatedAt?: string
}

/** @deprecated 向量写入请调用 Omni /api/v1/vector/upsert */
export interface SaveFileVectorInput {
  fileFingerprint: string
  textEmbedding?: Float32Array | null
  imageEmbedding?: Float32Array | null
  multimodalEmbedding?: Float32Array | null
  status?: number
  modelVersion?: string | null
  meta?: Record<string, any>
}

export const databaseService = new DatabaseService()
