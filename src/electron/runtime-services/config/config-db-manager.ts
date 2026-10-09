import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import {
  LogCategory,
  logger,
  getSharedSchemaName,
  isTestEnvironment,
  ResourceLocator,
  updateRuntimeFileConstants,
  CONTROLLED_DIMENSION_ROOT_CODES
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

    if (this.currentLanguage !== language) {
      this.fileDimensionsCache = []
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

      // PRD-0059: 启动期异步预载维度数据源并物化到内存缓存
      await this.preloadFileDimensions(language)

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
      (db.prepare(`SELECT COUNT(*) AS cnt FROM ${table}`).get() as { cnt: number } | undefined)
        ?.cnt ?? 0

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
        const rows = db.prepare(`SELECT DISTINCT tag_code FROM ${t}`).all() as Array<{
          tag_code: string
        }>
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
   * 从 system-config_[lang].json 和 model_[lang].json 读取初始配置写入 system_config 表（增量合并，DEC-03）
   * 绝对禁止执行 DELETE FROM system_config，确保离线启动不丢失云端同步策略
   */
  private loadInitialSystemConfigToDb(db: Database.Database, language: string): void {
    try {
      const insertStmt = db.prepare(
        `INSERT OR IGNORE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)`
      )

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

          logger.info(LogCategory.CONFIG, `ConfigDbManager: 成功增量导入初始 system_config 数据`)
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

      // 加载 model_[lang].json（desktop 本地 extraResources，由 generate:dims 双写至 engine）
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

      // 3. 构建并写入初始 DIMENSION_POLICIES 策略项（DEC-03 & PRD-0059）
      try {
        const presetPolicyPath = this.resolvePresetPolicyPath()
        if (presetPolicyPath && fs.existsSync(presetPolicyPath)) {
          const raw = fs.readFileSync(presetPolicyPath, 'utf-8')
          insertStmt.run('DIMENSION_POLICIES', raw, now)
          logger.info(
            LogCategory.CONFIG,
            'ConfigDbManager: 成功从 preset 增量导入初始 DIMENSION_POLICIES 数据'
          )
        }
      } catch (policyErr) {
        logger.warn(
          LogCategory.CONFIG,
          'ConfigDbManager: 写入初始 DIMENSION_POLICIES 失败:',
          policyErr
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
   * 显式清空维度缓存，迫使下一次 getFileDimensions 从磁盘和数据库动态策略重新加载
   */
  invalidateDimensionCache(): void {
    this.fileDimensionsCache = []
  }

  /**
   * 5 个受控 OMW 根维度（当 identity 中尚未包含时补齐，达到权威全集 96 个受控维度）
   */
  private static readonly OMW_CONTROLLED_DIMENSIONS = [
    { id: 201, code: 'omw.00202784.v', en: 'Action', zh: '动作', parentCodes: [] },
    { id: 202, code: 'omw.00001740.a', en: 'State', zh: '状态', parentCodes: [] },
    { id: 203, code: 'omw.03234306.n', en: 'Entity', zh: '实体', parentCodes: [] },
    { id: 204, code: 'omw.13841863.n', en: 'Time', zh: '时间', parentCodes: [] },
    { id: 205, code: 'omw.00001740.a.en', en: 'Description', zh: '描述', parentCodes: [] }
  ]

  /**
   * 定位预置受控身份字典路径 (builtin-tag-identity.json)
   */
  private resolveBuiltinIdentityPath(): string | null {
    const candidates = [
      ResourceLocator.resolveResourcePath('presetResources/taxonomy/builtin-tag-identity.json'),
      ResourceLocator.resolveResourcePath('taxonomy/builtin-tag-identity.json'),
      path.resolve(
        process.cwd(),
        'apps/desktop/build/presetResources/taxonomy/builtin-tag-identity.json'
      ),
      path.resolve(process.cwd(), 'build/presetResources/taxonomy/builtin-tag-identity.json'),
      path.resolve(
        __dirname,
        '../../../../build/presetResources/taxonomy/builtin-tag-identity.json'
      ),
      path.resolve(
        __dirname,
        '../../../../../apps/desktop/build/presetResources/taxonomy/builtin-tag-identity.json'
      )
    ]
    for (const p of candidates) {
      if (fs.existsSync(p)) return p
    }
    return null
  }

  /**
   * 定位预置维度策略文件路径 (dimension-policies.json)
   */
  private resolvePresetPolicyPath(): string | null {
    const candidates = [
      this.getConfigFilePath('dimension-policies.json'),
      ResourceLocator.resolveResourcePath('configs/dimension-policies.json'),
      path.resolve(
        process.cwd(),
        'apps/desktop/build/extraResources/configs/dimension-policies.json'
      ),
      path.resolve(process.cwd(), 'build/extraResources/configs/dimension-policies.json')
    ]
    for (const p of candidates) {
      if (fs.existsSync(p)) return p
    }
    return null
  }

  /**
   * 从权威数据源构建受控维度列表（PRD-0059 核心架构重构）
   *
   * 【已裁定目标态（PRD-0059 v1.1 §1）】主源 = **本地 AOT 受控事实源**，不经 Omni HTTP 拉取：
   *   · 桌面主进程严禁直接解密/挂载 `semantic.pack`（AGENTS.md 硬性契约）；
   *   · Omni 侧亦未提供 `/api/v1/taxonomy/dimensions` 端点（全仓 0 命中，仅 `taxonomy/aliases`）；
   *   · 故读取侧以随包分发的 `builtin-tag-identity.json`（+ OMW 根维度常量）为权威源，
   *     展示名经 `tag_aliases_{lang}` 分表按 locale 还原 —— 即原设计中的「三级降级第 3 级」，
   *     经裁定**升格为确定性主路径**（随包分发、无网络依赖、单测可复现）。
   *
   * 1. 主源：内置受控事实源 (builtin-tag-identity.json + OMW 受控根维度)，以稳定 code 为唯一主键
   * 2. 展示名：优先从当前语言 tag_aliases_{lang} 分表还原，回退别名表与 en/slug
   * 3. 增量策略：从 system_config.DIMENSION_POLICIES 或 dimension-policies.json 合并门限与 flag
   * （原第 4 段「用户维度 source='dimension'」已删除 —— 该功能不存在，见函数尾部说明）
   */
  loadDimensionsFromAuthority(language: string, db?: Database.Database): Array<any> {
    const dimensions: Array<any> = []
    const dimCodeSet = new Set<string>()

    // 1. 尝试从当前语言分表加载规范展示名 (tag_code -> lemma WHERE is_canonical = 1)
    const aliasMap = new Map<string, string>()
    if (db) {
      const table = resolveTagAliasesLangTable(language)
      try {
        const hasTable = db
          .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?`)
          .get(table)
        if (hasTable) {
          const rows = db
            .prepare(`SELECT tag_code, lemma FROM ${table} WHERE is_canonical = 1`)
            .all() as Array<{ tag_code: string; lemma: string }>
          for (const r of rows) {
            aliasMap.set(r.tag_code, r.lemma)
          }
        }
      } catch (err) {
        logger.debug(
          LogCategory.CONFIG,
          `ConfigDbManager: 读取分表 ${table} 别名失败，降级本地别名:`,
          err
        )
      }
    }

    // 2. 加载 DIMENSION_POLICIES 增量策略 (门限、适用格式、上下文线索、flags)
    let policies: Record<string, any> = {}
    if (db) {
      try {
        const row = db
          .prepare(`SELECT value FROM system_config WHERE key = 'DIMENSION_POLICIES' LIMIT 1`)
          .get() as { value: string } | undefined
        if (row?.value) {
          policies = JSON.parse(row.value)
        }
      } catch (policyErr) {
        logger.warn(LogCategory.CONFIG, 'ConfigDbManager: 读取 DIMENSION_POLICIES 失败:', policyErr)
      }
    }
    if (Object.keys(policies).length === 0) {
      const presetPolicyPath = this.resolvePresetPolicyPath()
      if (presetPolicyPath && fs.existsSync(presetPolicyPath)) {
        try {
          policies = JSON.parse(fs.readFileSync(presetPolicyPath, 'utf-8'))
        } catch {}
      }
    }

    // 辅助策略查找：优先按 code，其次按 id 查找策略项
    const getPolicy = (code: string, id?: number) => {
      if (policies[code]) return policies[code]
      if (id !== undefined) {
        for (const p of Object.values(policies)) {
          if (p && typeof p === 'object' && p.id === id) return p
        }
      }
      return undefined
    }

    // 3. 加载预置权威事实源 builtin-tag-identity.json
    const identityPath = this.resolveBuiltinIdentityPath()
    let identityData: any = null
    if (identityPath && fs.existsSync(identityPath)) {
      try {
        identityData = JSON.parse(fs.readFileSync(identityPath, 'utf-8'))
      } catch (err) {
        logger.warn(LogCategory.CONFIG, `ConfigDbManager: 读取 builtin-tag-identity 失败:`, err)
      }
    }

    if (identityData && Array.isArray(identityData.dimensions)) {
      // 3.1 聚合子标签词表：按 dimId 或 parentCodes 聚合成 tags 数组
      const dimTagsMap = new Map<number, string[]>()
      const codeTagsMap = new Map<string, string[]>()
      if (Array.isArray(identityData.tags)) {
        for (const t of identityData.tags) {
          const tagDisplay =
            aliasMap.get(t.code) || t.aliases?.[language] || t.aliases?.['zh-CN'] || t.en || t.code
          if (t.dimId !== undefined) {
            const list = dimTagsMap.get(t.dimId) || []
            list.push(tagDisplay)
            dimTagsMap.set(t.dimId, list)
          }
          if (Array.isArray(t.parentCodes)) {
            for (const p of t.parentCodes) {
              const list = codeTagsMap.get(p) || []
              list.push(tagDisplay)
              codeTagsMap.set(p, list)
            }
          }
        }
      }

      // 3.2 遍历构建受控维度
      for (const d of identityData.dimensions) {
        const code = d.code
        if (!code || dimCodeSet.has(code)) continue
        dimCodeSet.add(code)

        const policy = getPolicy(code, d.dimId)
        const dimName =
          aliasMap.get(code) || d.aliases?.[language] || d.aliases?.['zh-CN'] || d.en || code

        const aft = policy?.applicableFileTypes || policy?.applicable_file_types || ['*']
        const ch = policy?.contextHints || policy?.context_hints || []
        const threshold = policy?.threshold !== undefined ? policy.threshold : 0.6
        const parentCodes = Array.isArray(d.parentCodes) ? [...d.parentCodes] : []
        const depth = d.depth !== undefined ? d.depth : parentCodes.length > 0 ? 2 : 1
        const childTags = codeTagsMap.get(code) || dimTagsMap.get(d.dimId) || []

        const isExtensionDim =
          policy?.metadata?.flag?.isExtensionDimension !== undefined
            ? Boolean(policy.metadata.flag.isExtensionDimension)
            : Boolean(code.endsWith('_extensions') || code.endsWith('.extensions'))

        const metaObj: any = {
          flag: {
            isPanDimension: Boolean(policy?.metadata?.flag?.isPanDimension),
            isRequiresAI: Boolean(policy?.metadata?.flag?.isRequiresAI),
            isMultiSelect: Boolean(policy?.metadata?.flag?.isMultiSelect),
            isExtensionDimension: isExtensionDim
          }
        }

        dimensions.push({
          id: policy?.id ?? d.dimId,
          code,
          name: dimName,
          level: depth,
          depth,
          tags: childTags,
          description: '', // PRD-0059 AC-4: 维度元数据描述退役
          applicableFileTypes: aft,
          applicable_file_types: aft,
          contextHints: ch,
          context_hints: ch,
          triggerConditions: d.triggerConditions || [],
          parentCodes,
          threshold,
          metadata: metaObj
        })
      }
    }

    // 4. 补充受控 OMW 根维度（若尚未包含）以补齐权威全集 96 个受控维度
    for (const omw of ConfigDbManager.OMW_CONTROLLED_DIMENSIONS) {
      if (dimCodeSet.has(omw.code)) continue
      dimCodeSet.add(omw.code)
      const policy = getPolicy(omw.code, omw.id)
      const dimName = aliasMap.get(omw.code) || (language.startsWith('zh') ? omw.zh : omw.en)
      const aft = policy?.applicableFileTypes || policy?.applicable_file_types || ['*']
      const ch = policy?.contextHints || policy?.context_hints || []
      const threshold = policy?.threshold !== undefined ? policy.threshold : 0.6
      const metaObj: any = {
        flag: {
          isPanDimension: Boolean(policy?.metadata?.flag?.isPanDimension),
          isRequiresAI: Boolean(policy?.metadata?.flag?.isRequiresAI),
          isMultiSelect: Boolean(policy?.metadata?.flag?.isMultiSelect),
          isExtensionDimension: Boolean(policy?.metadata?.flag?.isExtensionDimension)
        }
      }

      dimensions.push({
        id: policy?.id ?? omw.id,
        code: omw.code,
        name: dimName,
        level: 1,
        depth: 1,
        tags: [],
        description: '',
        applicableFileTypes: aft,
        applicable_file_types: aft,
        contextHints: ch,
        context_hints: ch,
        triggerConditions: [],
        parentCodes: omw.parentCodes,
        threshold,
        metadata: metaObj
      })
    }

    // 【已删除】原「5. 补充数据库中动态创建的用户维度（source='dimension'）」整段。
    // 依据：PRD-0060 v2.2（'dimension' 移出 file_tags.source CHECK）与 PRD-0060 v2.3。
    // 经全仓取证，「用户自定义维度」功能**在代码中不存在** ——
    //   · 无创建入口：database-adapter.ts 的 dimensions.create 全仓零调用方；
    //   · 无写入者：全仓 6 个 INSERT INTO file_tags 点，source 仅取 'builtin'/'expanded'/'user'；
    //   · 无读取者：`file_tags.source` 已收紧为 ('expanded','user')。
    // 该段恒返回空集，属纯死代码，故整段删除。loadDimensionsFromAuthority 收敛为三段式：
    //   ① 内置受控事实源 builtin-tag-identity.json  ② 受控 OMW 根维度常量  ③ DIMENSION_POLICIES 策略覆盖

    return dimensions
  }

  /**
   * 启动期异步预载维度数据源并缓存 (PRD-0059)
   */
  async preloadFileDimensions(language: string): Promise<void> {
    try {
      const db = databaseService.db
      const dims = this.loadDimensionsFromAuthority(language, db || undefined)
      this.fileDimensionsCache = dims
      logger.info(
        LogCategory.CONFIG,
        `ConfigDbManager: 维度数据源预载完成，共 ${dims.length} 个维度 (语言: ${language})`
      )
    } catch (err) {
      logger.warn(LogCategory.CONFIG, 'ConfigDbManager: 预载维度数据源异常:', err)
    }
  }

  /**
   * 获取维度数据 (PRD-0059 权威维度数据源重构)
   * 1. 优先微秒级返回已预载并物化的内存缓存 fileDimensionsCache
   * 2. 若未缓存 (离线/单测)，执行三级降级状态机从权威事实源同步组装并回填缓存
   */
  getFileDimensions(): Array<any> {
    if (this.fileDimensionsCache.length > 0) {
      return this.fileDimensionsCache
    }

    try {
      const language = this.currentLanguage || 'zh-CN'
      const db = databaseService.db
      const dims = this.loadDimensionsFromAuthority(language, db || undefined)
      this.fileDimensionsCache = dims
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

        // 5. 触发 Omni 维度执行策略热重载 (DEC-04)
        void omniClient.reloadDimensionPolicies().catch(err => {
          logger.debug(
            LogCategory.CONFIG,
            'ConfigDbManager: 触发 Omni 策略热重载失败(非致命):',
            err
          )
        })
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
