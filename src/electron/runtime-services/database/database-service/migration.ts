import { DatabaseSharedBase } from './shared'

import {
  type FileInfo,
  type LanguageCode,
  type WorkspaceDirectory,
  type Unit,
  type UnitCreationData,
  type VideoChunkRecord,
  type WorkspaceConfig,
  type LocalWorkflowRecord,
  parseWorkspaceConfig
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
  classifyDimensionMutexScope,
  resolveMediaDomain,
  getFileCategory,
  CONTROLLED_CODE_TO_CANONICAL_NAME,
  DIMENSION_CODES,
  type TagProvenanceGroup
} from '@firefly/shared'
import {
  findTagCodeTwoStage,
  getDatabaseConfig,
  migrations,
  registerDatabaseFunctions,
  resolveTagAliasesLangTable
} from '.././database'
import { omniClient } from '../../../services/omni-client'

import Database from 'better-sqlite3'
import { calculateFileFingerprint, normalizeFileExtension } from '@firefly/shared'
import * as fs from 'fs'
import * as path from 'path'
import { t } from '@app/languages'

import { WorkspaceDao, FileDao, TagUnitDao, QueueDao, LocalWorkflowDao } from '.././dao'
import type { AnalysisTaskType } from '.././dao'
import { DeterministicCodeGenerator } from '@firefly/core-engine'
import { ConfigOrchestrator } from '../../../config/config-orchestrator'
import { AccessTimeBatchUpdater } from '.././access-time-batch-updater'
import { loadIgnoreRules, shouldIgnoreFile } from '../../analysis/analysis-ignore-service'
import { ConfigDbManager } from '../../config/config-db-manager'


/**
 * DatabaseService 迁移执行 mixin（Ticket 07）。
 * 承载 runMigrationsWithBackup / runMigrations / 迁移错误 UI。
 * migrations 数组仍来自 ../database，保持创世基线仅 version: 1，未新增 ALTER TABLE。
 */
export class DatabaseMigrationMixin extends DatabaseSharedBase {
  /**
   * 获取备份文件路径
   */
  protected getBackupPath(): string {
    return this.dbPath.replace(/\.db$/, '_v1_backup.db')
  }

  /**
   * 删除备份文件
   */
  protected deleteBackupFiles(): void {
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
  protected createBackup(): string {
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
  protected async runMigrationsWithBackup(language?: LanguageCode): Promise<void> {
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

  protected async runMigrations(): Promise<void> {
    if (!this._db) throw new Error('数据库未初始化')
    try {
      const userVersion = this._db.pragma('user_version', { simple: true }) as number
      for (const migration of migrations) {
        if (migration.version > userVersion) {
          logger.debug(
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
    logger.debug(
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
  protected async showMigrationErrorDialog(error: any): Promise<void> {
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
  protected async showLegacyVersionError(): Promise<void> {
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

}
