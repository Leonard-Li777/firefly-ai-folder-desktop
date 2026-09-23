import { app } from 'electron'
import * as fs from 'fs'
import {
  LogCategory,
  logger,
  getSharedSchemaName,
  isTestEnvironment,
  ResourceLocator,
  updateRuntimeFileConstants
} from '@firefly/shared'
import { createSupabaseClient } from '../system/supabase-client-factory'
import { WORKSPACE_CONSTANTS } from '@firefly/server'
import { SystemIdentityService } from '../system/system-identity-service'
import { databaseService } from '../database/database-service'
import { createTagAliasesLangTable, resolveTagAliasesLangTable } from '../database/database'
import { omniClient, OmniTagAliasRow } from '../../services/omni-client'

import { userTierService } from '../user-tier/user-tier-service'
import { BrowserWindow } from 'electron'
import type Database from 'better-sqlite3'
// ADR-0038 / Issue #682 与主设计 §7/§8（Fix-03）：
// 原 builtin identity / fileDimension 灌库链路（buildBuiltinTagIdentity / buildBuiltinImportPlan
// / tag_aliases 单表 / file_tags source='builtin' 行）已随单体 tag_aliases 表一并废弃删除，
// 受控别名初值统一走下方 seedTagAliasesLangTable 的分表补录。

export class ConfigDbManager {
  private static instance: ConfigDbManager | null = null

  private appConfigMap = new Map<string, any>()
  private systemConfigMap = new Map<string, any>()
  private fileConstantsMap = new Map<string, any>()
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

    // Slice 6 / R3.2：语言初始化/切换时创建 tag_aliases_{lang} 分表
    createTagAliasesLangTable(db, language)
    // 主设计 §2/§7（Fix-01/02）：初始化期异步补录分表初值（首建拉全集 / 切语言 codes= 补漏）。
    // 不阻塞启动；失败仅告警——R3.3 分析同事务「首见补录」仍是兜底写路径。
    void this.seedTagAliasesLangTable(db, language).catch(err => {
      logger.warn(LogCategory.CONFIG, 'ConfigDbManager: 分表初值补录异常:', err)
    })

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
   * 分表初值补录（主设计 §2，C1=(b) 定稿，Fix-01/Fix-02）
   * - 目标语言分表已有行 → 计算差集（其它分表有、目标表缺的 code）：差集为空则幂等跳过
   *   （避免每次启动都请求 Omni）；差集非空仅为缺失 code 走 `codes=` 补录（只补缺、不触碰已有行）；
   * - 若库内其它语言分表已有行（目标表为空）→ 取其全部 tag_code 经 Omni `codes=` 批量补录目标语言（切语言场景）；
   * - 否则（首次初始化该语言，无旧语言表）→ 以 `source=dimension,tag` 拉受控全集建表（首建场景）。
   * 动态/自定义标签不在分表建语言行（走 file_tags expanded/user）。补录行经 INSERT OR REPLACE
   * 写入，保持镜像与语义包一致。
   * @param db 主库连接
   * @param language 目标 locale，如 zh-CN
   */
  async seedTagAliasesLangTable(db: Database.Database, language: string): Promise<void> {
    const table = resolveTagAliasesLangTable(language)
    const existingCnt =
      (
        db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as
          | { cnt: number }
          | undefined
      )?.cnt ?? 0

    // 收集其它语言分表的 code 集（SQLite GLOB；不用 LIKE——其 '_' 是单字符通配会误匹配）
    const otherTables = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'tag_aliases_*'`)
        .all() as Array<{ name: string }>
    )
      .map(r => r.name)
      .filter(n => n !== table)

    const sourceCodes = new Set<string>()
    for (const t of otherTables) {
      try {
        const rows = db
          .prepare(`SELECT DISTINCT tag_code FROM ${t}`)
          .all() as Array<{ tag_code: string }>
        rows.forEach(r => sourceCodes.add(r.tag_code))
      } catch (err) {
        logger.warn(LogCategory.CONFIG, `ConfigDbManager: 读取历史分表 ${t} code 集失败:`, err)
      }
    }

    // Fix-02 差集补录：目标表非空时仅补「其它分表已有、目标表缺失」的 code；
    // 差集为空即维持原幂等跳过语义，不请求 Omni
    let codes: string[] = []
    if (existingCnt > 0) {
      const targetCodes = new Set(
        (
          db.prepare(`SELECT DISTINCT tag_code FROM ${table}`).all() as Array<{ tag_code: string }>
        ).map(r => r.tag_code)
      )
      codes = [...sourceCodes].filter(c => !targetCodes.has(c))
      if (codes.length === 0) {
        logger.debug(
          LogCategory.CONFIG,
          `ConfigDbManager: 分表 ${table} 已有 ${existingCnt} 行且无差集，跳过初值补录`
        )
        return
      }
    } else {
      codes = [...sourceCodes]
    }

    let rows: OmniTagAliasRow[] = []
    if (codes.length > 0) {
      // 切语言补漏：codes= 精确批量点查，未命中 code 不出行；分批防 URL 超长
      const CODE_BATCH = 400
      for (let i = 0; i < codes.length; i += CODE_BATCH) {
        const batch = await omniClient.getTaxonomyAliases(language, {
          codes: codes.slice(i, i + CODE_BATCH)
        })
        if (batch) rows.push(...batch)
      }
    } else {
      // 首建全集：source=dimension,tag 受控全集（与语义包 file_tags.source 治理一致）
      rows = (await omniClient.getTaxonomyAliases(language, { source: 'dimension,tag' })) ?? []
    }

    if (rows.length === 0) {
      logger.warn(
        LogCategory.CONFIG,
        `ConfigDbManager: Omni 未返回 ${language} 别名（服务未就绪或语义包缺失），分表暂空，展示走 code slug 兜底、后续分析首见补录`
      )
      return
    }

    const t0 = Date.now()
    const insert = db.prepare(
      `INSERT OR REPLACE INTO ${table} (tag_code, lemma, is_canonical, n, count) VALUES (?, ?, ?, ?, ?)`
    )
    db.transaction(() => {
      for (const r of rows) {
        insert.run(r.tag_code, r.lemma, r.is_canonical ? 1 : 0, r.n ?? 1, r.count ?? 0)
      }
    })()
    logger.info(
      LogCategory.CONFIG,
      `ConfigDbManager: 分表 ${table} 初值补录完成 rows=${rows.length}, 来源=${codes.length > 0 ? 'codes补漏' : '受控全集'}, 耗时=${Date.now() - t0}ms`
    )
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

      // 2. 清空并导入 file_constants
      this.loadInitialFileConstantsToDb(db)

      // 3. 清空并导入 system_config（含模型配置）
      this.loadInitialSystemConfigToDb(db, resolvedLanguage)

      // 4. ADR-0038 / Issue #682：创世主库不再灌入 builtin 与 omw 受控标签
      //    受控分类树与多语言别名改由 Omni semantic.pack + taxonomy HTTP API 托管
      // 5. 不再向主库导入 OMW 词网预置数据

      // 6. 将所有配置加载到内存中
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
      const now = new Date().toISOString()

      // 加载 model_[lang].json
      const localPresetPath = ResourceLocator.resolveModelConfig(`model_${language}.json`)
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
      const ollamaPresetPath = ResourceLocator.resolveModelConfig(`ollama_${language}.json`)
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
      const providersPresetPath = ResourceLocator.resolveModelConfig(`providers_${language}.json`)
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
   * 从 file-constants.json 读取全局文件常量配置写入 file_constants 表（先清空再导入）
   */
  private loadInitialFileConstantsToDb(db: Database.Database): void {
    try {
      const configPath = this.getConfigFilePath('file-constants.json')

      if (!fs.existsSync(configPath)) {
        logger.warn(
          LogCategory.CONFIG,
          `ConfigDbManager: 初始 file-constants 配置文件不存在: ${configPath}`
        )
        return
      }

      const raw = fs.readFileSync(configPath, 'utf-8')
      const parsed = JSON.parse(raw)

      const insertStmt = db.prepare(
        `INSERT OR REPLACE INTO file_constants (key, value, updated_at) VALUES (?, ?, ?)`
      )

      db.transaction(() => {
        db.prepare('DELETE FROM file_constants').run()
        Object.entries(parsed).forEach(([key, value]) => {
          insertStmt.run(key, JSON.stringify(value), new Date().toISOString())
        })
      })()

      // 同步更新 @firefly/shared 运行时常量缓存
      updateRuntimeFileConstants(parsed)

      logger.info(LogCategory.CONFIG, `ConfigDbManager: 成功导入初始 file_constants 数据`)
    } catch (error) {
      logger.error(LogCategory.CONFIG, 'ConfigDbManager: 导入初始 file_constants 失败:', error)
    }
  }


  // 依据 ADR-0038 / PRD Issue #686：创世主库彻底废除 omw_* 与 hownet_* 导入，静态语义数据全量由只读语义包 semantic.pack 托管


  /**
   * 从本地 SQLite 读取全部数据到内存中
   */
  private loadAllConfigsFromDb(db: any): void {
    this.appConfigMap.clear()
    this.systemConfigMap.clear()
    this.fileConstantsMap.clear()

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
      const constantRows = db.prepare('SELECT key, value FROM file_constants').all() as Array<{
        key: string
        value: string
      }>
      const constantsObj: Record<string, any> = {}
      constantRows.forEach(row => {
        try {
          const val = JSON.parse(row.value)
          this.fileConstantsMap.set(row.key, val)
          constantsObj[row.key] = val
        } catch (err) {
          this.fileConstantsMap.set(row.key, row.value)
          constantsObj[row.key] = row.value
        }
      })
      updateRuntimeFileConstants(constantsObj)
    } catch (err) {
      logger.warn(LogCategory.CONFIG, 'ConfigDbManager: 读取 file_constants 失败:', err)
    }

    this.fileDimensionsCache = []
  }

  /**
   * 获取维度数据
   *
   * ADR-0038 / Issue #682：
   * 从 file_tags 表直接查询维度（depth=0），不再依赖 TaxonomyAliasCache 内存总线。
   * 受控/感知标签的展示名由数据库分表查询；动态维度直接读 file_tags。
   */
  getFileDimensions(): Array<any> {
    if (this.fileDimensionsCache.length > 0) {
      return this.fileDimensionsCache
    }

    const db = databaseService.db
    if (!db) {
      return []
    }

    try {
      const rows = db
        .prepare(`
          SELECT code, name, depth, description, file_groups, context_hints, meta
          FROM file_tags
          WHERE depth = 0
          ORDER BY code ASC
        `)
        .all() as Array<any>

      const localDims = (rows || []).map((r, idx) => {
        let metaObj: any = {}
        try {
          metaObj = JSON.parse(r.meta)
        } catch {}
        let aft: string[] = []
        try {
          aft = JSON.parse(r.file_groups || '[]')
        } catch {}
        let ch: string[] = []
        try {
          ch = JSON.parse(r.context_hints || '[]')
        } catch {}
        return {
          id: idx + 1,
          code: r.code,
          name: r.name,
          level: 1,
          tags: [] as string[],
          description: r.description,
          applicable_file_types: aft,
          context_hints: ch,
          metadata: metaObj
        }
      });

      // 本地动态维度补充子标签名
      if (localDims.length > 0) {
        const getChildStmt = db.prepare(
          `SELECT name FROM file_tags WHERE depth = 1 AND json_extract(parent_codes, '$[0]') = ?`
        )
        for (const dim of localDims) {
          try {
            dim.tags = (getChildStmt.all(dim.code) as any[]).map(c => c.name)
          } catch {}
        }
      }

      this.fileDimensionsCache = localDims
      return this.fileDimensionsCache
    } catch (err) {
      logger.error(LogCategory.CONFIG, 'ConfigDbManager: 获取维度数据失败:', err)
      return []
    }
  }

  getFileConstant<T = any>(key: string): T | undefined {
    return this.fileConstantsMap.get(key) as T
  }

  getAllFileConstants(): Record<string, any> {
    return Object.fromEntries(this.fileConstantsMap)
  }

  private getExtraResourcesDir(subdir: string): string {
    return ResourceLocator.resolveResourcePath(subdir)
  }

  private getConfigFilePath(filename: string): string {
    return ResourceLocator.resolveConfig(filename)
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

    // ADR-0037 / #659：app_config 与 system_config 均落全局 Schema，不得按语言选 Schema
    const appSchema = getSharedSchemaName()
    const systemSchema = getSharedSchemaName()

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

        // 3. 在事务中一次性写入（失败则回滚）
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
