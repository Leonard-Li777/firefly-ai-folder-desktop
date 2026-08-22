import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import {
  LogCategory,
  logger,
  getSharedSchemaName,
  getLanguageSchemaName,
  isTestEnvironment,
  ResourceLocator
} from '@firefly/shared'
import { createSupabaseClient } from '../system/supabase-client-factory'
import { WORKSPACE_CONSTANTS } from '@firefly/server'
import { SystemIdentityService } from '../system/system-identity-service'
import { databaseService } from '../database/database-service'
import { userTierService } from '../user-tier/user-tier-service'
import { BrowserWindow } from 'electron'
import type Database from 'better-sqlite3'

export class ConfigDbManager {
  private static instance: ConfigDbManager | null = null

  private appConfigMap = new Map<string, any>()
  private systemConfigMap = new Map<string, any>()
  private fileDimensionsCache: Array<any> = []
  private initialized = false
  private currentLanguage = 'zh-CN'

  private constructor() {}

  static getInstance(): ConfigDbManager {
    if (!ConfigDbManager.instance) {
      ConfigDbManager.instance = new ConfigDbManager()
    }
    return ConfigDbManager.instance
  }

  /**
   * 初始化：从 SQLite 读取配置到内存并广播
   * 注意：JSON 加载已移至 loadFromJson()，由 databaseService 的 post-migration 回调调用
   */
  async initialize(language: string = 'zh-CN', force: boolean = false): Promise<void> {
    if (this.initialized && this.currentLanguage === language && !force) {
      return
    }

    this.currentLanguage = language
    const db = databaseService.db
    if (!db) {
      logger.error(LogCategory.CONFIG, 'ConfigDbManager: 数据库未就绪，无法初始化配置')
      return
    }

    try {
      this.loadFromJson(db, language)

      this.initialized = true
      logger.info(LogCategory.CONFIG, `ConfigDbManager: 配置初始化成功 (语言: ${language})`)

      // 广播更新通知给渲染进程
      this.broadcastConfigUpdate()
    } catch (error) {
      logger.error(LogCategory.CONFIG, 'ConfigDbManager: 初始化失败:', error)
    }
  }

  /**
   * 迁移后回调：从本地 JSON 文件加载初始配置到数据库
   * 由 databaseService 的 post-migration 机制调用，确保在数据库迁移完成后执行
   * 直接清空再导入，覆盖旧表迁移过来的数据
   */
  loadFromJson = (db: Database.Database, language?: string): void => {
    try {
      const resolvedLanguage = language || this.currentLanguage || 'zh-CN'
      this.currentLanguage = resolvedLanguage

      // 1. 清空并导入 app_config
      this.loadInitialAppConfigToDb(db)

      // 2. 清空并导入 system_config（含模型配置）
      this.loadInitialSystemConfigToDb(db, resolvedLanguage)

      // 3. 清空并导入 file_dimensions
      this.loadInitialFileDimensionsToDb(db, resolvedLanguage)

      // 4. 将所有配置加载到内存中
      this.loadAllConfigsFromDb(db)

      logger.info(
        LogCategory.CONFIG,
        `ConfigDbManager: 从本地 JSON 加载初始配置完成 (语言: ${resolvedLanguage})`
      )
    } catch (error) {
      logger.error(LogCategory.CONFIG, 'ConfigDbManager: 从本地 JSON 加载配置失败:', error)
    }
  }

  /**
   * 从 app-config.[region].json 读取初始配置写入 DB（先清空再导入）
   */
  private loadInitialAppConfigToDb(db: Database.Database): void {
    try {
      const region = __BUILD_REGION__.toLowerCase()
      const configPath = this.getConfigFilePath(`app-config.${region}.json`)

      if (!fs.existsSync(configPath)) {
        logger.warn(
          LogCategory.CONFIG,
          `ConfigDbManager: 初始 app-config 配置文件不存在: ${configPath}`
        )
        return
      }

      const raw = fs.readFileSync(configPath, 'utf-8')
      const parsed = JSON.parse(raw)

      const insertStmt = db.prepare(
        `INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES (?, ?, ?)`
      )

      db.transaction(() => {
        db.prepare('DELETE FROM app_config').run()
        Object.entries(parsed).forEach(([key, value]) => {
          insertStmt.run(key.toUpperCase(), JSON.stringify(value), new Date().toISOString())
        })
      })()

      logger.info(LogCategory.CONFIG, `ConfigDbManager: 成功导入初始 app_config 数据`)
    } catch (error) {
      logger.error(LogCategory.CONFIG, 'ConfigDbManager: 导入初始 app_config 失败:', error)
    }
  }

  /**
   * 从 system-config_[lang].json 和 model_[lang].json 读取初始配置写入 system_config 表（先清空再导入）
   */
  private loadInitialSystemConfigToDb(db: Database.Database, language: string): void {
    try {
      const insertStmt = db.prepare(
        `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`
      )

      // 先清空表
      db.prepare('DELETE FROM system_config').run()

      // 1. 加载 system-config_[lang].json
      const systemConfigPath = this.getConfigFilePath(`system-config_${language}.json`)
      if (fs.existsSync(systemConfigPath)) {
        try {
          const raw = fs.readFileSync(systemConfigPath, 'utf-8')
          const parsed = JSON.parse(raw)

          // 映射为全大写字段
          const mappings: Record<string, string> = {
            nextVersion: 'NEXT_VERSION',
            panDimensionIds: 'PAN_DIMENSION_IDS',
            latestNews: 'LATEST_NEWS'
          }

          db.transaction(() => {
            Object.entries(parsed).forEach(([key, value]) => {
              const upperKey = mappings[key] || key.toUpperCase()
              insertStmt.run(upperKey, JSON.stringify(value), new Date().toISOString())
            })
          })()

          logger.info(LogCategory.CONFIG, `ConfigDbManager: 成功导入初始 system_config 数据`)
        } catch (err) {
          logger.error(
            LogCategory.CONFIG,
            `ConfigDbManager: 导入 system-config_${language}.json 失败:`,
            err
          )
        }
      } else {
        logger.warn(
          LogCategory.CONFIG,
          `ConfigDbManager: 初始 system-config 配置文件不存在: ${systemConfigPath}`
        )
      }

      // 2. 加载 model_[lang].json、ollama_[lang].json、providers_[lang].json
      const modelConfigDir = this.getExtraResourcesDir('model')
      const now = new Date().toISOString()

      // 加载 model_[lang].json
      const localPresetPath = path.join(modelConfigDir, `model_${language}.json`)
      if (fs.existsSync(localPresetPath)) {
        try {
          const content = fs.readFileSync(localPresetPath, 'utf-8')
          if (content && content.trim() !== '') {
            const config = JSON.parse(content)
            insertStmt.run('LOCAL_MODEL_CONFIGS', JSON.stringify(config), now)
            logger.info(
              LogCategory.CONFIG,
              `ConfigDbManager: 成功导入初始 LOCAL_MODEL_CONFIGS 数据`
            )
          }
        } catch (err) {
          logger.error(
            LogCategory.CONFIG,
            `ConfigDbManager: 导入 model_${language}.json 失败:`,
            err
          )
        }
      } else {
        logger.warn(LogCategory.CONFIG, `ConfigDbManager: 模型配置文件不存在: ${localPresetPath}`)
      }

      // 加载 ollama_[lang].json
      const ollamaPresetPath = path.join(modelConfigDir, `ollama_${language}.json`)
      if (fs.existsSync(ollamaPresetPath)) {
        try {
          const content = fs.readFileSync(ollamaPresetPath, 'utf-8')
          if (content && content.trim() !== '') {
            const config = JSON.parse(content)
            insertStmt.run('LOCAL_MODEL_CONFIGS_OLLAMA', JSON.stringify(config), now)
            logger.info(
              LogCategory.CONFIG,
              `ConfigDbManager: 成功导入初始 LOCAL_MODEL_CONFIGS_OLLAMA 数据`
            )
          }
        } catch (err) {
          logger.error(
            LogCategory.CONFIG,
            `ConfigDbManager: 导入 ollama_${language}.json 失败:`,
            err
          )
        }
      } else {
        logger.warn(
          LogCategory.CONFIG,
          `ConfigDbManager: Ollama 模型配置文件不存在: ${ollamaPresetPath}`
        )
      }

      // 加载 providers_[lang].json 到 CLOUD_MODEL_CONFIGS
      const providersPresetPath = path.join(modelConfigDir, `providers_${language}.json`)
      if (fs.existsSync(providersPresetPath)) {
        try {
          const content = fs.readFileSync(providersPresetPath, 'utf-8')
          if (content && content.trim() !== '') {
            const localPresets = JSON.parse(content)
            if (Array.isArray(localPresets)) {
              // 映射预设确保包含 provider 字段
              const mappedPresets = localPresets.map((p: any) => ({ ...p, provider: p.id }))
              insertStmt.run('CLOUD_MODEL_CONFIGS', JSON.stringify(mappedPresets), now)
              logger.info(
                LogCategory.CONFIG,
                `ConfigDbManager: 成功导入初始 CLOUD_MODEL_CONFIGS 数据 (${mappedPresets.length} 个服务商)`
              )
            }
          }
        } catch (err) {
          logger.error(
            LogCategory.CONFIG,
            `ConfigDbManager: 导入 providers_${language}.json 失败:`,
            err
          )
        }
      } else {
        logger.warn(
          LogCategory.CONFIG,
          `ConfigDbManager: 云端模型配置文件不存在: ${providersPresetPath}`
        )
      }
    } catch (error) {
      logger.error(LogCategory.CONFIG, 'ConfigDbManager: 导入初始 system_config 失败:', error)
    }
  }

  /**
   * 从 fileDimension_[lang].json 加载文件维度到 file_dimensions 表（先清空再导入）
   */
  private loadInitialFileDimensionsToDb(db: Database.Database, language: string): void {
    try {
      const fileDimensionDir = this.getExtraResourcesDir('fileDimension')

      const filePath = path.join(fileDimensionDir, `fileDimension_${language}.json`)
      if (!fs.existsSync(filePath)) {
        logger.warn(
          LogCategory.CONFIG,
          `ConfigDbManager: fileDimension 配置文件不存在: ${filePath}`
        )
        return
      }

      const content = fs.readFileSync(filePath, 'utf-8')
      if (!content || content.trim() === '') {
        return
      }

      const parsed = JSON.parse(content)
      const dimensions = parsed.file_dimensions || []

      if (!Array.isArray(dimensions) || dimensions.length === 0) {
        logger.warn(LogCategory.CONFIG, `ConfigDbManager: fileDimension 配置文件为空或格式错误`)
        return
      }

      // 先清空表
      db.prepare('DELETE FROM file_dimensions').run()

      const insertStmt = db.prepare(`
        INSERT INTO file_dimensions (
          id, name, level, tags, trigger_conditions, is_ai_generated, description,
          applicable_file_types, context_hints, sync_status, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?)
      `)

      db.transaction(() => {
        for (const dim of dimensions) {
          const tags = typeof dim.tags === 'string' ? dim.tags : JSON.stringify(dim.tags || [])
          // JSON 源文件用驼峰键名，数据库用下划线，需兼容
          const rawTC = dim.triggerConditions ?? dim.trigger_conditions
          const triggerConditions = rawTC
            ? typeof rawTC === 'string'
              ? rawTC
              : JSON.stringify(rawTC)
            : null
          const rawAFT = dim.applicableFileTypes ?? dim.applicable_file_types
          const applicableFileTypes = rawAFT
            ? typeof rawAFT === 'string'
              ? rawAFT
              : JSON.stringify(rawAFT)
            : null
          const rawCH = dim.contextHints ?? dim.context_hints
          const contextHints = rawCH
            ? typeof rawCH === 'string'
              ? rawCH
              : JSON.stringify(rawCH)
            : null

          insertStmt.run(
            dim.id,
            dim.name,
            dim.level,
            tags,
            triggerConditions,
            dim.is_ai_generated ? 1 : 0,
            dim.description || null,
            applicableFileTypes,
            contextHints,
            dim.created_at || new Date().toISOString()
          )
        }
      })()

      databaseService.clearDimensionsCache()

      // 重新读取存入 fileDimensionsCache，确保内存缓存同步最新物理预设数据
      try {
        this.fileDimensionsCache = db
          .prepare('SELECT * FROM file_dimensions ORDER BY level ASC')
          .all() as Array<any>
      } catch {
        this.fileDimensionsCache = []
      }

      logger.info(
        LogCategory.CONFIG,
        `ConfigDbManager: 成功导入 ${dimensions.length} 个 file_dimensions 数据`
      )
    } catch (error) {
      logger.error(LogCategory.CONFIG, 'ConfigDbManager: 导入 fileDimension 失败:', error)
    }
  }

  /**
   * 从本地 SQLite 读取全部数据到内存中
   */
  private loadAllConfigsFromDb(db: any): void {
    this.appConfigMap.clear()
    this.systemConfigMap.clear()

    const appConfigs = db.prepare('SELECT key, value FROM app_config').all() as Array<{
      key: string
      value: string
    }>
    appConfigs.forEach(row => {
      try {
        this.appConfigMap.set(row.key.toUpperCase(), JSON.parse(row.value))
      } catch (err) {
        this.appConfigMap.set(row.key.toUpperCase(), row.value)
      }
    })

    const systemConfigs = db.prepare('SELECT key, value FROM system_config').all() as Array<{
      key: string
      value: string
    }>
    systemConfigs.forEach(row => {
      try {
        this.systemConfigMap.set(row.key.toUpperCase(), JSON.parse(row.value))
      } catch (err) {
        this.systemConfigMap.set(row.key.toUpperCase(), row.value)
      }
    })

    try {
      const dimensions = db
        .prepare('SELECT * FROM file_dimensions ORDER BY level ASC')
        .all() as Array<any>
      this.fileDimensionsCache = dimensions || []
    } catch {
      this.fileDimensionsCache = []
    }
  }

  /**
   * 获取缓存的 file_dimensions 数据（内存缓存加速，未命中则查 SQLite）
   */
  getFileDimensions(): Array<any> {
    if (this.fileDimensionsCache.length > 0) {
      return this.fileDimensionsCache
    }
    const db = databaseService.db
    if (!db) return []
    try {
      const rows = db
        .prepare('SELECT * FROM file_dimensions ORDER BY level ASC')
        .all() as Array<any>
      this.fileDimensionsCache = rows || []
      return this.fileDimensionsCache
    } catch (err) {
      logger.error(LogCategory.CONFIG, 'ConfigDbManager: 获取 file_dimensions 失败:', err)
      return []
    }
  }

  private getExtraResourcesDir(subdir: string): string {
    return path.join(ResourceLocator.getBaseResourceDir(), subdir)
  }

  private getConfigFilePath(filename: string): string {
    return (
      ResourceLocator.resolveConfig(filename) ||
      path.join(ResourceLocator.getBaseResourceDir(), 'configs', filename)
    )
  }

  /**
   * 异步从云端同步配置（启动时仅同步一次，非阻塞）
   */
  async syncFromCloud(): Promise<void> {
    // 集成测试环境下禁止远程配置同步，避免干扰测试结果
    if (isTestEnvironment()) {
      logger.info(LogCategory.CONFIG, 'ConfigDbManager: 检测到测试环境，跳过同步')
      return
    }

    // 企业版禁止远程配置同步（通过 can_offline 门控判断）
    try {
      const tierData = userTierService.getCachedData()
      if (tierData?.computed_limits?.can_offline === true) {
        logger.info(LogCategory.CONFIG, 'ConfigDbManager: 检测到企业版离线授权，跳过云端配置同步')
        return
      }
    } catch {
      // userTierService 尚未就绪，继续执行同步
    }

    const machineId = SystemIdentityService.getInstance().getMachineId()
    const signature = SystemIdentityService.getInstance().getSignature()

    if (!machineId || !signature) {
      logger.warn(LogCategory.CONFIG, 'ConfigDbManager: 机器身份未就绪，跳过云端配置同步')
      return
    }

    const supabase = createSupabaseClient(
      WORKSPACE_CONSTANTS.SUPABASE_URL,
      WORKSPACE_CONSTANTS.SUPABASE_ANON_KEY,
      machineId,
      signature,
      this.currentLanguage
    )

    const db = databaseService.db
    if (!db) return

    const appSchema = getSharedSchemaName()
    const systemSchema = getLanguageSchemaName(this.currentLanguage)

    logger.info(LogCategory.CONFIG, 'ConfigDbManager: 开始从云端拉取配置...')

    const maxRetries = 3
    let lastError: any = null

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // 1. 从云端拉取 app_config
        let appData: Array<{ key: string; value: any }> = []
        try {
          const { data: freshAppData, error: fetchError } = await supabase
            .schema(appSchema)
            .from('app_config')
            .select('key, value')
            .not('key', 'is', null)

          if (!fetchError && freshAppData) {
            appData = freshAppData
          }
        } catch (err: any) {
          logger.warn(LogCategory.CONFIG, `ConfigDbManager: 拉取 app_config 失败: ${err.message}`)
        }

        // 2. 从云端拉取 system_config
        let systemData: Array<{ key: string; value: any }> = []
        try {
          const { data: freshSystemData, error: fetchError } = await supabase
            .schema(systemSchema)
            .from('system_config')
            .select('key, value')
            .not('key', 'is', null)

          if (!fetchError && freshSystemData) {
            systemData = freshSystemData
          }
        } catch (err: any) {
          logger.warn(
            LogCategory.CONFIG,
            `ConfigDbManager: 拉取 system_config 失败: ${err.message}`
          )
        }

        // 3. 从云端拉取 file_dimensions
        let dimensionData: Array<any> = []
        try {
          const { data: freshDimData, error: fetchError } = await supabase
            .schema(systemSchema)
            .from('file_dimensions')
            .select('*')
            .order('level', { ascending: true })

          if (!fetchError && freshDimData) {
            dimensionData = freshDimData
          }
        } catch (err: any) {
          logger.warn(
            LogCategory.CONFIG,
            `ConfigDbManager: 拉取 file_dimensions 失败: ${err.message}`
          )
        }

        // 4. 在事务中一次性写入（失败则回滚）
        db.transaction(() => {
          // 合并导入 app_config（云端数据覆盖本地，保留本地独有 key）
          if (appData.length > 0) {
            const appInsert = db.prepare(
              `INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES (?, ?, ?)`
            )
            const now = new Date().toISOString()
            appData.forEach(row => {
              appInsert.run(row.key.toUpperCase(), JSON.stringify(row.value), now)
            })
          }

          // 合并导入 system_config（云端数据覆盖本地，保留本地独有 key）
          if (systemData.length > 0) {
            const systemInsert = db.prepare(
              `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`
            )
            const now = new Date().toISOString()
            systemData.forEach(row => {
              let finalValue = row.value
              if (row.key.toUpperCase() === 'NEXT_VERSION' && finalValue) {
                finalValue = { ...finalValue, language: this.currentLanguage }
              }
              systemInsert.run(row.key.toUpperCase(), JSON.stringify(finalValue), now)
            })
          }

          // 合并导入 file_dimensions（如果非中文且包含中文文本，增加保护逻辑防止脏数据覆盖）
          if (dimensionData.length > 0) {
            if (this.currentLanguage !== 'zh-CN') {
              const hasChinese = dimensionData.some(
                d => typeof d.name === 'string' && /[\u4e00-\u9fa5]/.test(d.name)
              )
              if (hasChinese) {
                logger.warn(
                  LogCategory.CONFIG,
                  `ConfigDbManager: 云端拉取的维度包含中文，与当前语言 (${this.currentLanguage}) 不符，跳过覆盖`
                )
                return
              }
            }

            db.prepare('DELETE FROM file_dimensions').run()
            const dimInsert = db.prepare(`
              INSERT INTO file_dimensions (
                id, name, level, tags, trigger_conditions, is_ai_generated, description,
                applicable_file_types, context_hints, sync_status, created_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 2, ?)
            `)
            const now = new Date().toISOString()
            dimensionData.forEach(dim => {
              const tags = typeof dim.tags === 'string' ? dim.tags : JSON.stringify(dim.tags || [])
              const trigger_conditions =
                typeof dim.trigger_conditions === 'string'
                  ? dim.trigger_conditions
                  : dim.trigger_conditions
                    ? JSON.stringify(dim.trigger_conditions)
                    : null
              const applicable_file_types =
                typeof dim.applicable_file_types === 'string'
                  ? dim.applicable_file_types
                  : dim.applicable_file_types
                    ? JSON.stringify(dim.applicable_file_types)
                    : null
              const context_hints =
                typeof dim.context_hints === 'string'
                  ? dim.context_hints
                  : dim.context_hints
                    ? JSON.stringify(dim.context_hints)
                    : null

              dimInsert.run(
                dim.id,
                dim.name,
                dim.level,
                tags,
                trigger_conditions,
                dim.is_ai_generated ? 1 : 0,
                dim.description || null,
                applicable_file_types,
                context_hints,
                dim.created_at || now
              )
            })
          }
        })()

        // 4. 重新加载至内存并广播
        this.loadAllConfigsFromDb(db)
        logger.info(LogCategory.CONFIG, 'ConfigDbManager: 云端配置拉取与覆盖写入本地成功')
        this.broadcastConfigUpdate()
        return
      } catch (error: any) {
        lastError = error
        logger.warn(
          LogCategory.CONFIG,
          `ConfigDbManager: 云端同步失败 (尝试 ${attempt}/${maxRetries}): ${error.message}`
        )
        if (attempt < maxRetries) {
          await new Promise(resolve => setTimeout(resolve, 2000 * attempt))
        }
      }
    }

    logger.error(LogCategory.CONFIG, 'ConfigDbManager: 云端同步最终失败:', lastError)
  }

  /**
   * 泛型获取方法
   */
  getAppValue<T = any>(key: string): T | undefined {
    const cached = this.appConfigMap.get(key.toUpperCase()) as T
    if (cached !== undefined) return cached
    // 如果内存缓存未命中，尝试直接从数据库读取（兼容 appConfigMap 尚未加载的场景）
    try {
      const db = databaseService.db
      if (db) {
        const row = db
          .prepare('SELECT value FROM app_config WHERE key = ?')
          .get(key.toUpperCase()) as { value: string } | undefined
        if (row) {
          const parsed = JSON.parse(row.value) as T
          this.appConfigMap.set(key.toUpperCase(), parsed)
          return parsed
        }
      }
    } catch {
      // ignore
    }
    return undefined
  }

  getSystemValue<T = any>(key: string): T | undefined {
    return this.systemConfigMap.get(key.toUpperCase()) as T
  }

  getAllAppConfig(): Record<string, any> {
    return Object.fromEntries(this.appConfigMap)
  }

  getAllSystemConfig(): Record<string, any> {
    return Object.fromEntries(this.systemConfigMap)
  }

  getAllConfigsCombined(): Record<string, any> {
    return {
      ...this.getAllAppConfig(),
      ...this.getAllSystemConfig()
    }
  }

  /**
   * 泛型设置方法 (会同时更新 SQLite 并同步内存)
   */
  setAppValue(key: string, value: any): void {
    const db = databaseService.db
    if (!db) return

    const keyUpper = key.toUpperCase()
    this.appConfigMap.set(keyUpper, value)

    try {
      db.prepare(`INSERT OR REPLACE INTO app_config (key, value, updated_at) VALUES (?, ?, ?)`).run(
        keyUpper,
        JSON.stringify(value),
        new Date().toISOString()
      )

      this.broadcastConfigUpdate()
    } catch (err) {
      logger.error(LogCategory.CONFIG, `ConfigDbManager: 保存 app_config.${key} 失败:`, err)
    }
  }

  setSystemValue(key: string, value: any): void {
    const db = databaseService.db
    if (!db) return

    const keyUpper = key.toUpperCase()
    this.systemConfigMap.set(keyUpper, value)

    try {
      db.prepare(
        `INSERT OR REPLACE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`
      ).run(keyUpper, JSON.stringify(value), new Date().toISOString())

      this.broadcastConfigUpdate()
    } catch (err) {
      logger.error(LogCategory.CONFIG, `ConfigDbManager: 保存 system_config.${key} 失败:`, err)
    }
  }

  getTierConstants(): any {
    return this.getAppValue('TIER_CONSTANTS')
  }

  getOperationPrices(): any {
    return this.getAppValue('OPERATION_PRICES')
  }

  getPaymentInfo(): any {
    return this.getAppValue('PAYMENT_INFO')
  }

  private broadcastConfigUpdate(): void {
    const allWindows = BrowserWindow.getAllWindows()
    const fullConfig = this.getAllConfigsCombined()
    allWindows.forEach(win => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send('configDb:change', fullConfig)
      }
    })

    // 同时通过常规 config:change 通道广播，确保 useConfigStore 缓存刷新
    try {
      const { ConfigOrchestrator } = require('../../config/config-orchestrator')
      const flattened = ConfigOrchestrator.getInstance().getFlattenedConfig()
      allWindows.forEach(win => {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
          win.webContents.send('config:change', flattened)
        }
      })
    } catch {
      // ConfigOrchestrator 未就绪时静默失败
    }
  }
}
