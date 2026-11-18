import { DatabaseMigrationMixin } from './migration'

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
import { rebuildNamePaths, type RebuildNamePathsResult } from '.././name-path-rebuilder'
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
 * DatabaseService 初始化生命周期 mixin（Ticket 07）。
 * 承载 ensureInitialized / initialize / 备份 / 语言回调 / 建表 / 兼容性表 / 前端通知。
 * 全部代码自 database-service.ts 原样搬移，仅将跨 mixin 可见成员改为 protected。
 */
export class DatabaseInitMixin extends DatabaseMigrationMixin {
  async ensureInitialized(): Promise<void> {
    if (this._db) return
    if (this.initPromise) {
      await this.initPromise
      return
    }
    const isLanguageConfirmed =
      ConfigOrchestrator.getInstance().getValue<boolean>('LANGUAGE_CONFIRMED')
    if (!isLanguageConfirmed) {
      logger.debug(
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
        this.localWorkflowDao = new LocalWorkflowDao(this._db)

        this._db.pragma(`journal_mode = ${config.pragma.journal_mode}`)
        this._db.pragma(`synchronous = ${config.pragma.synchronous}`)
        this._db.pragma(`cache_size = ${config.pragma.cache_size}`)
        this._db.pragma(`mmap_size = ${config.pragma.mmap_size}`)
        this._db.pragma(`temp_store = ${config.pragma.temp_store}`)
        this._db.pragma(`foreign_keys = ${config.pragma.foreign_keys ? 'ON' : 'OFF'}`)
        const fkStatus = this._db.pragma('foreign_keys', { simple: true })
        if (config.pragma.foreign_keys && Number(fkStatus) !== 1) {
          throw new Error(`SQLite 外键约束启用失败: PRAGMA foreign_keys = ${fkStatus}`)
        }
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

  protected async createTables(): Promise<void> {
    if (!this._db) throw new Error('数据库未初始化')
    try {
      this._db.pragma('foreign_keys = ON')
      const userVersion = this._db.pragma('user_version', { simple: true }) as number

      if (userVersion === 0) {
        logger.info(
          LogCategory.DATABASE_SERVICE,
          t('全新安装，准备执行架构初始化 (Genesis Baseline V1)...')
        )
      }
    } catch (error) {
      logger.error(LogCategory.DATABASE_SERVICE, t('创建数据表失败'), { error })
      throw error
    }
  }

  /**
   * 确保表结构自愈（ADR-0038 创世卫生：剔除只读语义表与向量堆表）
   */
  protected ensureCompatibilityTables(): void {
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
  protected async notifyFrontend(
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


  protected registerIgnoreFunction(): void {
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

}
