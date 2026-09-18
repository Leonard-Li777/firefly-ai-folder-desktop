import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
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
import { userTierService } from '../user-tier/user-tier-service'
import { BrowserWindow } from 'electron'
import type Database from 'better-sqlite3'
import * as coreEngineIdentityApi from '@firefly/core-engine'
import * as sharedIdentityStub from '@app/shared/builtin-tag-identity-stub'
import type {
  FileDimensionDocument,
  BuiltinTagIdentity
} from '@app/shared/builtin-tag-identity-stub'
/**
 * 身份构建 API：优先 Pro @firefly/core-engine；开源/无 pro 时降级 shared stub
 * 使用静态 ESM 导入，确保 electron-vite 打包时能重写别名并内联模块
 * （运行时 require 相对路径在 out_build/main 下无法解析）
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const identityApi: any =
  typeof (coreEngineIdentityApi as { buildBuiltinTagIdentity?: unknown })
    .buildBuiltinTagIdentity === 'function'
    ? coreEngineIdentityApi
    : sharedIdentityStub

const { buildBuiltinTagIdentity, buildBuiltinImportPlan } = identityApi

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

      // 2. 清空并导入 file_constants
      this.loadInitialFileConstantsToDb(db)

      // 3. 清空并导入 system_config（含模型配置）
      this.loadInitialSystemConfigToDb(db, resolvedLanguage)

      // 4. 清空并导入 file_tags 统一标签树
      this.loadInitialFileTagsToDb(db, resolvedLanguage)

      // 5. 导入 OMW 多语言词网预置数据 (支柱 2)
      this.loadInitialOmwToDb(db, resolvedLanguage)

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

  /**
   * 从 fileDimension_[lang].json 加载初始标签维度树到 file_tags 表
   * Spec issue-omni-i18n-tag-identity-spec：
   * - 优先 en 源 identity code（builtin.{en_slug}.{hash}）+ tag_aliases
   * - identity 构建失败时降级为历史本地化 code 路径（生产 en 文件待清洗）
   * - 语言切换场景：已有 code 时仅 UPDATE name，不 DELETE+INSERT 换 code
   */
  private loadInitialFileTagsToDb(db: Database.Database, language: string): void {
    try {
      const filePath = ResourceLocator.resolveDimension(`fileDimension_${language}.json`)
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

      // 切换语言：若 builtin 概念 code 已存在，只刷新 name（D10）
      const existingBuiltin = db
        .prepare(
          `SELECT COUNT(*) as cnt FROM file_tags WHERE source = 'builtin' AND code LIKE 'builtin.%'`
        )
        .get() as { cnt: number } | undefined
      if ((existingBuiltin?.cnt ?? 0) > 0) {
        this.refreshBuiltinDisplayNames(db, language, dimensions)
        databaseService.clearDimensionsCache()
        logger.info(
          LogCategory.CONFIG,
          `ConfigDbManager: 检测到既有 builtin code，仅刷新 ${language} 显示名`
        )
        return
      }

      const identityLoaded = this.tryLoadBuiltinIdentityToDb(db, language)
      if (identityLoaded) {
        databaseService.clearDimensionsCache()
        logger.info(
          LogCategory.CONFIG,
          `ConfigDbManager: 已按 en 源 identity 导入 file_tags + tag_aliases (${language})`
        )
        return
      }

      // 降级：历史路径（本地化 code）—— 待 en 源清洗后由 identity 路径取代
      db.prepare(`DELETE FROM file_tags WHERE source = 'builtin'`).run()

      const insertStmt = db.prepare(`
        INSERT OR REPLACE INTO file_tags (
          code, name, parent_codes, materialized_paths, depth, source,
          file_groups, context_hints, description, meta
        ) VALUES (?, ?, ?, ?, ?, 'builtin', ?, ?, ?, ?)
      `)

      db.transaction(() => {
        for (const dim of dimensions) {
          const dimSlug = `dim.${dim.id}`
          const dimName = dim.name
          const dimDepth = 0
          const dimPaths = [{ code_path: `/${dimSlug}`, name_path: `/${dimName}` }]
          const rawAFT = dim.applicableFileTypes ?? dim.applicable_file_types ?? dim.file_groups ?? ['*']
          const fileGroupsStr = typeof rawAFT === 'string' ? rawAFT : JSON.stringify(rawAFT)
          const rawCH = dim.contextHints ?? dim.context_hints
          const contextHintsStr = rawCH ? (typeof rawCH === 'string' ? rawCH : JSON.stringify(rawCH)) : null

          const isMultiSelect = dim.name === '文件用途' || !!dim.metadata?.flag?.isPanDimension
          const metaObj = {
            isDimension: true,
            isMultiSelect,
            ...(dim.metadata || {})
          }

          // 插入维度根节点
          insertStmt.run(
            dimSlug,
            dimName,
            '[]',
            JSON.stringify(dimPaths),
            dimDepth,
            fileGroupsStr,
            contextHintsStr,
            dim.description || null,
            JSON.stringify(metaObj)
          )

          // 插入维度下的子标签
          const tags = Array.isArray(dim.tags) ? dim.tags : (typeof dim.tags === 'string' ? JSON.parse(dim.tags || '[]') : [])
          tags.forEach((tag: string, tagIdx: number) => {
            const tagCode = `${dimSlug}.${tag}`
            const tagPaths = [{ code_path: `/${dimSlug}/${tag}`, name_path: `/${dimName}/${tag}` }]
            const tagMeta = {
              isDimension: false,
              sortOrder: tagIdx,
              isMultiSelect: false
            }

            insertStmt.run(
              tagCode,
              tag,
              JSON.stringify([dimSlug]),
              JSON.stringify(tagPaths),
              1,
              fileGroupsStr,
              contextHintsStr,
              null,
              JSON.stringify(tagMeta)
            )
          })
        }
      })()

      databaseService.clearDimensionsCache()

      logger.info(
        LogCategory.CONFIG,
        `ConfigDbManager: 成功导入 ${dimensions.length} 个初始 file_tags 体系`
      )
    } catch (error) {
      logger.error(LogCategory.CONFIG, 'ConfigDbManager: 导入 file_tags 失败:', error)
    }
  }

  /**
   * 尝试以 en 源 Identity 导入 file_tags + tag_aliases
   * 优先读取 taxonomy:build step0 产物 builtin-tag-identity.json；
   * 产物不存在时再从 fileDimension 运行时构建（开发兜底）。
   * @returns 是否成功走 identity 路径
   */
  private tryLoadBuiltinIdentityToDb(db: Database.Database, language: string): boolean {
    try {
      const enPath = ResourceLocator.resolveDimension('fileDimension_en-US.json')
      if (!fs.existsSync(enPath)) return false
      const enDoc = JSON.parse(fs.readFileSync(enPath, 'utf-8')) as FileDimensionDocument
      const localeDoc =
        language === 'en-US'
          ? null
          : (() => {
              const p = ResourceLocator.resolveDimension(`fileDimension_${language}.json`)
              return fs.existsSync(p)
                ? (JSON.parse(fs.readFileSync(p, 'utf-8')) as FileDimensionDocument)
                : null
            })()

      const localeDocs: Record<string, FileDimensionDocument> = {}
      if (localeDoc) localeDocs[language] = localeDoc

      // 1) 构建期产物（taxonomy:build --only step0）
      let items: BuiltinTagIdentity[] | null = null
      const dimDir = path.dirname(enPath)
      const identityArtifact = path.join(
        dimDir,
        '..',
        '..',
        'presetResources',
        'taxonomy',
        'builtin-tag-identity.json'
      )
      if (fs.existsSync(identityArtifact)) {
        try {
          const artifact = JSON.parse(fs.readFileSync(identityArtifact, 'utf-8')) as {
            tags?: BuiltinTagIdentity[]
          }
          if (Array.isArray(artifact.tags) && artifact.tags.length > 0) {
            items = artifact.tags
            logger.info(
              LogCategory.CONFIG,
              `ConfigDbManager: 使用 taxonomy step0 产物 identity (${items.length} tags)`
            )
          }
        } catch (e: any) {
          logger.warn(
            LogCategory.CONFIG,
            `ConfigDbManager: 解析 builtin-tag-identity.json 失败，回退运行时构建: ${e?.message}`
          )
        }
      }

      // 2) 运行时构建兜底（en 文件仍可能含 CJK，构建门禁失败则整体降级）
      if (!items) {
        items = buildBuiltinTagIdentity({ enDoc, localeDocs })
      }

      const dimensionNames: Record<number, string> = {}
      const nameSource = localeDoc?.file_dimensions || enDoc.file_dimensions || []
      for (const d of nameSource) dimensionNames[d.id] = d.name

      const plan = buildBuiltinImportPlan({
        items,
        displayLocale: language,
        dimensionNames
      })

      const insertStmt = db.prepare(`
        INSERT OR REPLACE INTO file_tags (
          code, name, parent_codes, materialized_paths, depth, source,
          file_groups, context_hints, description, meta
        ) VALUES (?, ?, ?, ?, ?, 'builtin', ?, ?, ?, ?)
      `)
      const aliasStmt = db.prepare(`
        INSERT OR REPLACE INTO tag_aliases (tag_code, locale, lemma, is_canonical, meta)
        VALUES (?, ?, ?, ?, '{}')
      `)

      db.transaction(() => {
        db.prepare(`DELETE FROM file_tags WHERE source = 'builtin'`).run()
        db.prepare(`DELETE FROM tag_aliases`).run()

        for (const root of plan.dimensionRoots) {
          const paths = [{ code_path: `/${root.code}`, name_path: `/${root.name}` }]
          insertStmt.run(
            root.code,
            root.name,
            '[]',
            JSON.stringify(paths),
            0,
            JSON.stringify(['*']),
            null,
            null,
            JSON.stringify({ isDimension: true, isMultiSelect: false })
          )
        }

        for (const tag of plan.tags) {
          const paths = [
            {
              code_path: `/dim.${tag.dimId}/${tag.code}`,
              name_path: `/dim.${tag.dimId}/${tag.name}`
            }
          ]
          insertStmt.run(
            tag.code,
            tag.name,
            JSON.stringify(tag.parent_codes),
            JSON.stringify(paths),
            tag.depth,
            JSON.stringify(['*']),
            null,
            null,
            JSON.stringify(tag.meta)
          )
        }

        for (const alias of plan.aliases) {
          aliasStmt.run(alias.tag_code, alias.locale, alias.lemma, alias.is_canonical)
        }
      })()

      // Spec 验收 10：历史 code（dim.*/拼音 builtin.*）→ en 源 code 迁移
      this.applyHistoricalTagCodeMap(db, path.join(path.dirname(identityArtifact), 'historical-tag-code-map.json'))

      return true
    } catch (err: any) {
      logger.warn(
        LogCategory.CONFIG,
        `ConfigDbManager: builtin identity 导入不可用，降级历史路径: ${err?.message || err}`
      )
      return false
    }
  }

  /**
   * 读取 step0 历史映射产物，将 file_tag_relations 中的旧 tag_code 迁移到 en 源 identity code
   * 并把映射表写入 file_constants，供查询侧解析旧 code。
   */
  private applyHistoricalTagCodeMap(db: Database.Database, mapPath: string): void {
    if (!fs.existsSync(mapPath)) {
      logger.warn(LogCategory.CONFIG, `ConfigDbManager: 历史 code 映射不存在: ${mapPath}`)
      return
    }
    try {
      const map = JSON.parse(fs.readFileSync(mapPath, 'utf-8')) as Record<string, string>
      const entries = Object.entries(map)
      if (entries.length === 0) return

      const updateRel = db.prepare(`UPDATE file_tag_relations SET tag_code = ? WHERE tag_code = ?`)
      let relUpdated = 0
      db.transaction(() => {
        for (const [legacy, modern] of entries) {
          if (!legacy || !modern || legacy === modern) continue
          const info = updateRel.run(modern, legacy)
          relUpdated += info.changes || 0
        }
        // 查询侧缓存：file_constants 存完整历史映射
        db.prepare(
          `INSERT OR REPLACE INTO file_constants (key, value, updated_at)
           VALUES ('historical_tag_code_map', ?, CURRENT_TIMESTAMP)`
        ).run(JSON.stringify(map))
      })()

      logger.info(
        LogCategory.CONFIG,
        `ConfigDbManager: 历史 tag_code 映射完成 entries=${entries.length}, relations_updated=${relUpdated}`
      )
    } catch (err: any) {
      logger.warn(LogCategory.CONFIG, `ConfigDbManager: 历史 code 映射失败: ${err?.message || err}`)
    }
  }

  /**
   * 语言切换：按 displayLocale 仅更新 name（D10 不改 code）
   */
  private refreshBuiltinDisplayNames(
    db: Database.Database,
    language: string,
    dimensions: any[]
  ): void {
    try {
      const update = db.prepare(`UPDATE file_tags SET name = ? WHERE code = ?`)
      // 优先用 tag_aliases 精确刷新
      const aliasRows = db
        .prepare(`SELECT tag_code, lemma FROM tag_aliases WHERE locale = ?`)
        .all(language) as Array<{ tag_code: string; lemma: string }>
      if (aliasRows.length > 0) {
        db.transaction(() => {
          for (const row of aliasRows) update.run(row.lemma, row.tag_code)
          for (const dim of dimensions) {
            update.run(dim.name, `dim.${dim.id}`)
          }
        })()
        return
      }
      // 无别名表时：按 dim 结构名刷新根节点
      db.transaction(() => {
        for (const dim of dimensions) {
          update.run(dim.name, `dim.${dim.id}`)
        }
      })()
    } catch (err: any) {
      logger.warn(LogCategory.CONFIG, `ConfigDbManager: 刷新显示名失败: ${err?.message || err}`)
    }
  }

  /**
   * 兼容性保留
   */
  private loadInitialFileDimensionsToDb(db: Database.Database, language: string): void {
    this.loadInitialFileTagsToDb(db, language)
  }

  /**
   * 从 preset CSV 解析并导入 OMW 多语言词网预置数据到 SQLite (支柱 2)
   * 按语言分库: 仅导入当前语言 + 英文兜底的词条, 其余语言不入库
   */
  private loadInitialOmwToDb(db: Database.Database, language: string): void {
    // 1. 检查 omw_languages 表是否已存在且已有数据
    try {
      const check = db.prepare('SELECT count(*) as cnt FROM omw_languages').get() as
        | { cnt: number }
        | undefined
      if (check && check.cnt > 0) {
        logger.info(
          LogCategory.CONFIG,
          `ConfigDbManager: omw_languages 已存在 ${check.cnt} 条数据，跳过重复导入`
        )
        return
      }
    } catch {
      // 表若尚未创建则安全返回
      return
    }

    const taxonomyDir = this.findTaxonomyDir()
    if (!taxonomyDir) {
      logger.warn(LogCategory.CONFIG, 'ConfigDbManager: 未找到 preset taxonomy 资源目录，跳过 OMW 导入')
      return
    }

    const isTest = isTestEnvironment()
    const rowLimit = isTest ? 200 : 0 // 测试环境仅取前 200 条以加速

    // 关键：大批量流式导入期间临时关闭外键约束检查，并在 finally 中严格恢复，防止由于跨表依赖时序或未就绪的种子数据触发外键约束报错
    db.pragma('foreign_keys = OFF')

    try {
        // 1) 导入 omw_languages.csv (顶层基础表，无外键依赖)
      const langPath = path.join(taxonomyDir, 'omw_languages.csv')
      if (fs.existsSync(langPath)) {
        const lines = fs.readFileSync(langPath, 'utf-8').split(/\r?\n/).filter(Boolean)
        const insertLang = db.prepare(`
          INSERT OR REPLACE INTO omw_languages (code, label, has_hierarchy, has_definitions, has_examples, meta)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        db.transaction(() => {
          for (let i = 1; i < lines.length; i++) {
            const cols = this.parseCsvLine(lines[i])
            if (cols.length >= 6) {
              insertLang.run(
                cols[0],
                cols[1],
                parseInt(cols[2]) || 0,
                parseInt(cols[3]) || 0,
                parseInt(cols[4]) || 0,
                cols[5] || '{}'
              )
            }
          }
        })()
      }

      // 2) 导入 omw_synsets.csv (概念表，被 entries 与 relations 依赖)
      const synsetPath = path.join(taxonomyDir, 'omw_synsets.csv')
      if (fs.existsSync(synsetPath)) {
        this.streamImportCsv(
          db,
          synsetPath,
          `INSERT OR REPLACE INTO omw_synsets (id, ili, pos, lexfile, definition, dc_identifier, meta) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          rowLimit,
          7
        )
      }

      // 3) 导入 omw_lexical_entries (按语言独立文件, 依赖 omw_synsets 与 omw_languages)
      // 入库语言集合: 当前语言 + 英文兜底 (英文是层级骨架, 必须保留)
      const importLocales = [language === 'en-US' ? 'en-US' : 'en-US', language]
        .filter((v, i, a) => a.indexOf(v) === i) // 去重
      logger.info(
        LogCategory.CONFIG,
        `ConfigDbManager: OMW 导入语言: ${importLocales.join(', ')} (系统语言: ${language})`
      )

      for (const loc of importLocales) {
        const entryPath = path.join(taxonomyDir, `omw_lexical_entries_${loc}.csv`)
        if (fs.existsSync(entryPath)) {
          this.streamImportCsv(
            db,
            entryPath,
            `INSERT OR REPLACE INTO omw_lexical_entries (id, synset_id, language, lemma, pos, meta) VALUES (?, ?, ?, ?, ?, ?)`,
            rowLimit,
            5,
            (cols) => [
              cols[0],
              cols[1],
              cols[2],
              cols[3],
              cols[4],
              cols.length >= 7 ? cols[6] : (cols[5] || '{}')
            ]
          )
        }
      }

      // 4) 导入 omw_relations.csv (语言无关骨架)
      const relPath = path.join(taxonomyDir, 'omw_relations.csv')
      if (fs.existsSync(relPath)) {
        this.streamImportCsv(
          db,
          relPath,
          `INSERT OR REPLACE INTO omw_relations (source_id, target_id, rel_type, meta) VALUES (?, ?, ?, ?)`,
          rowLimit,
          3,
          (cols) => [cols[0], cols[1], cols[2], '{}']
        )
      }

      // 5) 导入 omw_sense_relations.csv
      const senseRelPath = path.join(taxonomyDir, 'omw_sense_relations.csv')
      if (fs.existsSync(senseRelPath)) {
        this.streamImportCsv(
          db,
          senseRelPath,
          `INSERT OR REPLACE INTO omw_sense_relations (source_entry_id, target_entry_id, rel_type, meta) VALUES (?, ?, ?, ?)`,
          rowLimit,
          3,
          (cols) => [cols[0], cols[1], cols[2], '{}']
        )
      }

      // 6) omw_examples 已依据规范彻底移除（0 占用，无需导入）

      // 7-9) 导入 HowNet 中文增强数据 (仅 zh-CN 语言库)
      if (language === 'zh-CN') {
        // 7) 导入 hownet_words.csv
        const hownetWordsPath = path.join(taxonomyDir, 'hownet_words.csv')
        if (fs.existsSync(hownetWordsPath)) {
          this.streamImportCsv(
            db,
            hownetWordsPath,
            `INSERT OR REPLACE INTO hownet_words (word, pos, language, definition) VALUES (?, ?, ?, ?)`,
            rowLimit,
            4
          )
        }

        // 8) 导入 hownet_concepts.csv
        const hownetConceptsPath = path.join(taxonomyDir, 'hownet_concepts.csv')
        if (fs.existsSync(hownetConceptsPath)) {
          this.streamImportCsv(
            db,
            hownetConceptsPath,
            `INSERT OR REPLACE INTO hownet_concepts (id, name, parent_id) VALUES (?, ?, ?)`,
            rowLimit,
            3
          )
        }

        // 9) 导入 hownet_word_concepts.csv
        const hownetWordConceptsPath = path.join(taxonomyDir, 'hownet_word_concepts.csv')
        if (fs.existsSync(hownetWordConceptsPath)) {
          this.streamImportCsv(
            db,
            hownetWordConceptsPath,
            `INSERT OR REPLACE INTO hownet_word_concepts (word, concept_id) VALUES (?, ?)`,
            rowLimit,
            2
          )
        }
      }

      // 10) 导入 antonym_pairs.csv (反义词多来源合并)
      const antonymPath = path.join(taxonomyDir, 'antonym_pairs.csv')
      if (fs.existsSync(antonymPath)) {
        this.streamImportCsv(
          db,
          antonymPath,
          `INSERT OR REPLACE INTO antonym_pairs (word_a, word_b, source) VALUES (?, ?, ?)`,
          rowLimit,
          3
        )
      }

      // 11) 导入 tag_omw_mapping.csv (标签-OMW 映射, Step 5 产出)
      const mappingPath = path.join(taxonomyDir, 'tag_omw_mapping.csv')
      if (fs.existsSync(mappingPath)) {
        this.streamImportCsv(
          db,
          mappingPath,
          `INSERT OR REPLACE INTO tag_omw_mapping (tag_code, synset_id, match_level, confidence, meta) VALUES (?, ?, ?, ?, ?)`,
          rowLimit,
          5
        )
      }

      logger.info(LogCategory.CONFIG, `ConfigDbManager: 成功导入 OMW 词网数据`)
    } catch (error) {
      logger.error(LogCategory.CONFIG, 'ConfigDbManager: 导入 OMW 词网数据失败:', error)
    } finally {
      try {
        db.pragma('foreign_keys = ON')
      } catch (e) {
        logger.warn(LogCategory.CONFIG, 'ConfigDbManager: 恢复 foreign_keys 失败:', e)
      }
    }
  }

  private findTaxonomyDir(): string | null {
    const candidates = [
      ResourceLocator.resolveResourcePath('taxonomy'),
      path.resolve(process.cwd(), 'apps/desktop/build/presetResources/taxonomy'),
      path.resolve(process.cwd(), 'build/presetResources/taxonomy')
    ]
    for (const c of candidates) {
      if (fs.existsSync(c) && fs.existsSync(path.join(c, 'omw_languages.csv'))) {
        return c
      }
    }
    let cur = process.cwd()
    for (let i = 0; i < 4; i++) {
      const probe = path.join(cur, 'apps', 'desktop', 'build', 'presetResources', 'taxonomy')
      if (fs.existsSync(probe) && fs.existsSync(path.join(probe, 'omw_languages.csv'))) {
        return probe
      }
      const parent = path.dirname(cur)
      if (parent === cur) break
      cur = parent
    }
    return null
  }

  private parseCsvLine(line: string): string[] {
    const result: string[] = []
    let current = ''
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"'
          i++
        } else {
          inQuotes = !inQuotes
        }
      } else if (ch === ',' && !inQuotes) {
        result.push(current)
        current = ''
      } else {
        current += ch
      }
    }
    result.push(current)
    return result
  }

  private streamImportCsv(
    db: Database.Database,
    filePath: string,
    insertSql: string,
    rowLimit: number,
    expectedMinCols: number,
    transformRow?: (cols: string[]) => any[] | null
  ): void {
    const insertStmt = db.prepare(insertSql)
    // 计算 SQL 中的占位符数量，作为防御性上限
    const placeholderCount = (insertSql.match(/\?/g) || []).length
    const content = fs.readFileSync(filePath, 'utf-8')
    const lines = content.split(/\r?\n/)
    const max = rowLimit > 0 ? Math.min(rowLimit + 1, lines.length) : lines.length

    db.transaction(() => {
      for (let i = 1; i < max; i++) {
        const line = lines[i]
        if (!line || !line.trim()) continue
        const cols = this.parseCsvLine(line)
        if (cols.length >= expectedMinCols) {
          const params = transformRow ? transformRow(cols) : cols
          // transformRow 返回 null 表示跳过该行 (如语言过滤)
          if (params === null) continue
          // 防御性处理：若参数数量多于占位符数量，截断至占位符数量避免 better-sqlite3 抛出 RangeError
          const finalParams =
            placeholderCount > 0 && params.length > placeholderCount
              ? params.slice(0, placeholderCount)
              : params
          insertStmt.run(...finalParams)
        }
      }
    })()
  }

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
   * 获取维度数据（由 file_tags 标签树的维度根节点动态映射）
   *
   * 创世 Baseline V1：维度不再存储于 file_dimensions 表，而是以 file_tags 中
   * parent_codes 为空（depth = 0）的根节点表达，其直属子节点即该维度的标签集。
   */
  getFileDimensions(): Array<any> {
    if (this.fileDimensionsCache.length > 0) {
      return this.fileDimensionsCache
    }
    const db = databaseService.db
    if (!db) return []
    try {
      const rows = db
        .prepare(`
          SELECT code, name, depth, description, file_groups, context_hints, meta
          FROM file_tags
          WHERE depth = 0
          ORDER BY code ASC
        `)
        .all() as Array<any>

      if (rows && rows.length > 0) {
        const getChildStmt = db.prepare(
          `SELECT name FROM file_tags WHERE depth = 1 AND json_extract(parent_codes, '$[0]') = ?`
        )
        this.fileDimensionsCache = rows.map((r, idx) => {
          let metaObj: any = {}
          try {
            metaObj = JSON.parse(r.meta)
          } catch {}
          let childTags: string[] = []
          try {
            childTags = (getChildStmt.all(r.code) as any[]).map(c => c.name)
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
            tags: childTags,
            description: r.description,
            applicable_file_types: aft,
            context_hints: ch,
            metadata: metaObj
          }
        })
        return this.fileDimensionsCache
      }

      return []
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
