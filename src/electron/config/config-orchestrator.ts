import { EventEmitter } from 'node:events'
import { Conf } from 'electron-conf'
import fixPath from 'fix-path'

// 在 macOS 和 Linux 上修复 PATH 环境变量
if (process.platform !== 'win32') {
  try {
    const fixPathFunc = typeof fixPath === 'function' ? fixPath : (fixPath as any).default
    if (typeof fixPathFunc === 'function') {
      fixPathFunc()
    }
  } catch (e) {
    console.error('Failed to fix PATH in ConfigOrchestrator:', e)
  }
}
import {
  logger,
  LogCategory,
  defaultRendererConfig,
  CONFIG_METADATA,
  CONFIG_KEY_TO_RENDERER_FIELD_MAP,
  APP_CONFIG_KEYS,
  DB_MANAGED_KEYS
} from '@firefly/shared'
import type { AppConfig, TierConstants } from '@firefly/types'
import type {
  ConfigChangeHandler,
  ConfigChangeSource,
  ConfigKey,
  UnifiedAppConfig,
  UnifiedConfigUpdate
} from '@firefly/types/config-types'
import type { ConfigDbManager } from '../runtime-services/config/config-db-manager'
import { defaultUnifiedConfig } from './config.default'
import {
  AIServiceConfigManager,
  llamaModelManager,
  modelDownloadManager
} from '@firefly/electron-llamaIndex-service'
import type { AIServiceConfig } from '@firefly/types/ai-config-types'

interface UpdateOptions {
  source?: ConfigChangeSource
  preventAutoReload?: boolean
}

/**
 * 云同步的整体替换配置项 —— 这些 key 的值应整体替换，不与默认值递归合并。
 * 例如 OPERATION_PRICES.purchase_firecores 是 Record<string, number>，
 * 云端新增/删除购买档位后，旧档位不应从默认值中"复活"。
 */

function deepMerge<T>(...sources: Array<Record<string, any> | undefined>): T {
  const result: Record<string, any> = {}

  for (const source of sources) {
    if (!source) continue
    Object.entries(source).forEach(([key, value]) => {
      if (DB_MANAGED_KEYS.has(key)) {
        if (value !== undefined) {
          result[key] = value
        }
      } else if (Array.isArray(value)) {
        result[key] = value.slice()
      } else if (value && typeof value === 'object') {
        result[key] = deepMerge(result[key] || {}, value)
      } else if (value !== undefined) {
        result[key] = value
      }
    })
  }

  return result as T
}

function getValueByPath(target: Record<string, any>, path: string): unknown {
  const segments = path.split('.')
  let current: any = target

  for (const segment of segments) {
    if (current == null) {
      return undefined
    }
    current = current[segment]
  }

  return current
}

function areValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true

  // null 和 undefined 视为相等
  if ((a === null || a === undefined) && (b === null || b === undefined)) {
    return true
  }

  if (typeof a === 'number' && typeof b === 'number') {
    return Math.abs(a - b) < Number.EPSILON
  }

  // 处理数组和对象的深度对比（简单实现，适用于配置项）
  if (
    (Array.isArray(a) && Array.isArray(b)) ||
    (a && b && typeof a === 'object' && typeof b === 'object')
  ) {
    try {
      return JSON.stringify(a) === JSON.stringify(b)
    } catch (e) {
      return false
    }
  }

  return false
}

export class ConfigOrchestrator extends EventEmitter {
  private static instance: ConfigOrchestrator | null = null
  private static configDbManager: ConfigDbManager | null = null

  /** 注册 ConfigDbManager 实例，替代动态 require */
  static registerConfigDbManager(mgr: ConfigDbManager): void {
    ConfigOrchestrator.configDbManager = mgr
  }

  private rendererStore: Conf<AppConfig>
  private unifiedStore: Conf<Record<string, unknown>>
  private rendererCache: AppConfig
  private cachedConfig: UnifiedAppConfig
  private cachedFlatValues: Map<ConfigKey, unknown> = new Map()
  private runtimeOverrides: Partial<UnifiedAppConfig> = {}
  private aiConfigManager: AIServiceConfigManager
  private valueChangeHandlers = new Map<ConfigKey, Set<ConfigChangeHandler<any>>>()

  private constructor() {
    super()
    const { app } = require('electron')
    const userDataPath =
      app && typeof app.getPath === 'function' ? app.getPath('userData') : undefined
    this.rendererStore = new Conf<AppConfig>({
      name: 'firefly-ai-folder-config',
      defaults: defaultRendererConfig,
      ...(userDataPath ? { cwd: userDataPath } : {})
    })
    this.unifiedStore = new Conf<Record<string, unknown>>({
      name: 'firefly-unified-config',
      defaults: {},
      ...(userDataPath ? { cwd: userDataPath } : {})
    })
    this.rendererCache = this.rendererStore.store

    // 强制应用构建时指定的 AI 引擎，确保 package.json 中的设置优先于用户本地保存的配置
    const buildTimeEngine = defaultUnifiedConfig.ai?.AI_ENGINE
    if (buildTimeEngine) {
      this.runtimeOverrides = {
        ai: {
          AI_ENGINE: buildTimeEngine as any
        } as any
      }
    }

    this.cachedConfig = this.rebuildCache()
    this.aiConfigManager = new AIServiceConfigManager(this)
  }

  static getInstance(): ConfigOrchestrator {
    if (!ConfigOrchestrator.instance) {
      ConfigOrchestrator.instance = new ConfigOrchestrator()
    }
    return ConfigOrchestrator.instance
  }

  static __dangerouslyResetForTests(): void {
    if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
      ConfigOrchestrator.instance = null
    }
  }

  /**
   * 获取兼容旧渲染进程的完整配置对象
   */
  getConfig(): AppConfig {
    const config = this.getRendererConfig()

    // 注入 unified-config 中的关键配置项到 AppConfig 顶层（用于兼容）
    const selectedModelId = this.getValue('SELECTED_MODEL_ID') as string | undefined
    const modelPath = this.getValue('MODEL_STORAGE_PATH') as string
    const language = this.getValue('DEFAULT_LANGUAGE') as any
    const theme = this.getValue('THEME_MODE') as any
    const showEmptyTags = this.getValue('SHOW_EMPTY_TAGS') as boolean
    const nextVersion = this.getValue('NEXT_VERSION') as any
    const latestNews = this.getValue('LATEST_NEWS') as any
    const panDimensionIds = this.getValue('PAN_DIMENSION_IDS') as any

    return {
      ...config,
      language,
      theme,
      showEmptyTags,
      selectedModelId,
      modelPath,
      nextVersion,
      LATEST_NEWS: latestNews,
      PAN_DIMENSION_IDS: panDimensionIds,
      ui: {
        ...(config.ui || {}),
        showEmptyTags
      }
    }
  }

  getRendererConfig(): AppConfig {
    // 返回扁平化的配置，以保持与旧渲染进程代码的兼容性
    return this.getFlattenedConfig() as unknown as AppConfig
  }

  /**
   * 获取AI服务配置（带增强逻辑）
   */
  async getAIConfig(): Promise<AIServiceConfig> {
    const aiConfig = await this.aiConfigManager.getAIServiceConfig()

    if (aiConfig.mode === 'local' && aiConfig.local.modelId) {
      const selectedModelId = aiConfig.local.modelId

      try {
        // 增强下载状态
        const status = await modelDownloadManager.checkModelDownloadStatus(selectedModelId)
        ;(aiConfig.local as any).isModelDownloaded = status.isDownloaded

        // 增强多模态路径
        if (!aiConfig.local.mmprojPath) {
          const multiModalConfig = await llamaModelManager.getMultiModalModelConfig(selectedModelId)
          if (multiModalConfig?.mmprojPath) {
            aiConfig.local.mmprojPath = multiModalConfig.mmprojPath
          }
        }

        // 增强模型路径对齐
        if (
          !aiConfig.local.modelPath ||
          aiConfig.local.modelPath.endsWith(`${selectedModelId}.gguf`)
        ) {
          const modelFilePath = await llamaModelManager.getModelPath(selectedModelId)
          if (modelFilePath) {
            aiConfig.local.modelPath = modelFilePath
          }
        }
      } catch (e) {
        logger.warn(LogCategory.CONFIG, 'Orchestrator: 增强AI配置失败', e)
      }
    }

    return aiConfig
  }

  /**
   * 获取指定模型的配置
   */
  getModelConfig(modelId: string): any | null {
    return this.aiConfigManager.getModelConfig(modelId)
  }

  /**
   * 更新配置（兼容旧版 Partial<AppConfig> 格式）
   */
  async updateConfig(updates: Partial<AppConfig>): Promise<void> {
    const entries = Object.entries(updates)

    for (const [field, value] of entries) {
      // 1. 尝试通过映射表寻找 ConfigKey
      const configKey = Object.keys(CONFIG_KEY_TO_RENDERER_FIELD_MAP).find(
        key => CONFIG_KEY_TO_RENDERER_FIELD_MAP[key as ConfigKey] === field
      ) as ConfigKey | undefined

      if (configKey) {
        await this.updateValue(configKey, value)
        continue
      }

      // 2. 特殊处理未映射的顶层字段
      if (field === 'selectedModelId') {
        await this.updateValue('SELECTED_MODEL_ID', value)
      } else if (field === 'modelPath') {
        await this.updateValue('MODEL_STORAGE_PATH', value)
      } else if (field === 'language') {
        await this.updateValue('DEFAULT_LANGUAGE', value)
      } else if (field === 'theme') {
        await this.updateValue('THEME_MODE', value)
      } else if (field === 'showEmptyTags') {
        await this.updateValue('SHOW_EMPTY_TAGS', value)
      } else if (field === 'showMissingFiles') {
        await this.updateValue('SHOW_MISSING_FILES', value)
      }
    }
  }

  /**
   * 获取扁平化的配置对象 (过滤掉秘密字段)
   */
  getFlattenedConfig(): Record<string, unknown> {
    const flatConfig: Record<string, unknown> = {}
    this.cachedFlatValues.forEach((_value, key) => {
      // 过滤秘密字段
      const metadata = CONFIG_METADATA[key]
      if (metadata && (metadata as any).secret) {
        return
      }

      // 对 DB_MANAGED_KEYS，通过 getValue() 获取，确保拦截器生效（从 ConfigDbManager 读取）
      // 其余 key 直接取缓存值，避免不必要的开销
      const effectiveValue = DB_MANAGED_KEYS.has(key) ? this.getValue(key) : _value

      // 优先使用渲染进程对应的字段名
      const rendererField = CONFIG_KEY_TO_RENDERER_FIELD_MAP[key]
      if (rendererField) {
        flatConfig[rendererField] = effectiveValue
      }
      // 同时保留 ConfigKey 作为键，以支持 getConfigValue('KEY') 的直接访问
      flatConfig[key] = effectiveValue
    })
    return flatConfig
  }

  getConfigSnapshot(): UnifiedAppConfig {
    return { ...this.cachedConfig }
  }

  getValue<T = unknown>(key: ConfigKey): T {
    // 拦截：DB_MANAGED_KEYS 的值由 ConfigDbManager 统一管理，不走 electron-conf
    if (DB_MANAGED_KEYS.has(key)) {
      const mgr = ConfigOrchestrator.configDbManager
      if (mgr) {
        const val = APP_CONFIG_KEYS.has(key)
          ? (mgr.getAppValue(key) as T)
          : (mgr.getSystemValue(key) as T)
        if (val !== undefined) return val
      }
    }
    const rawVal = this.cachedFlatValues.get(key) as T
    if (key === 'ANALYSIS_MODE' && (rawVal as any) === 'document') {
      return 'simple' as T
    }
    return rawVal
  }

  /**
   * 获取 TIER_CONSTANTS 配置（带类型安全）
   */
  getTierConstants(): TierConstants {
    return this.getValue<TierConstants>('TIER_CONSTANTS')
  }

  updateRendererConfig(updates: Partial<AppConfig>): void {
    if (!updates || Object.keys(updates).length === 0) {
      return
    }

    const previous = this.rendererCache
    this.rendererCache = { ...previous, ...updates }

    // 同步到统一配置系统 (反向同步)
    const unifiedUpdates: Partial<Record<ConfigKey, unknown>> = {}

    // 映射回 ConfigKey (根据 path 或 key 匹配)
    Object.entries(updates).forEach(([key, value]) => {
      // 检查 key 是否直接是 ConfigKey
      if ((CONFIG_METADATA as Record<string, unknown>)[key as string]) {
        unifiedUpdates[key as ConfigKey] = value
      } else {
        // 尝试反向查找 CONFIG_KEY_TO_RENDERER_FIELD_MAP
        const rendererFieldMap = CONFIG_KEY_TO_RENDERER_FIELD_MAP as Record<string, string | null>
        const reverseConfigKey = (Object.keys(rendererFieldMap) as ConfigKey[]).find(
          k => rendererFieldMap[k as string] === key
        )
        if (reverseConfigKey) {
          unifiedUpdates[reverseConfigKey] = value
        } else {
          // 尝试寻找映射 (简单的启发式搜索)
          const configMetadata = CONFIG_METADATA as Record<
            string,
            { path: string; key: string } | undefined
          >
          const configKey = (Object.keys(configMetadata) as ConfigKey[]).find(k => {
            const meta = configMetadata[k as string]
            return meta && (meta.path.endsWith(`.${key}`) || meta.key === key)
          })
          if (configKey) {
            unifiedUpdates[configKey] = value
          }
        }
      }

      // 同时也更新旧存储以保持持久性
      if (value === undefined) {
        this.rendererStore.delete(key as keyof AppConfig)
      } else {
        this.rendererStore.set(key as keyof AppConfig, value)
      }
    })

    if (Object.keys(unifiedUpdates).length > 0) {
      // 注意：这里由于是 UI 同步回来的，不触发 autoReload 循环
      void this.updateValues(unifiedUpdates, { source: 'renderer', preventAutoReload: true })
    }

    this.emit('renderer-change', this.rendererCache, previous)
  }

  updateUnifiedConfig(partial: UnifiedConfigUpdate, source: ConfigChangeSource = 'user'): void {
    if (!partial || Object.keys(partial).length === 0) {
      return
    }

    this.writeUnifiedPartial(partial)
    void this.flushAndEmitChanges(source, [])
  }

  async updateValue(key: ConfigKey, value: unknown, options?: UpdateOptions): Promise<void> {
    await this.updateValues({ [key]: value }, options)
  }

  /**
   * 批量更新多个配置项
   */
  async updateValues(
    updates: Partial<Record<ConfigKey, unknown>>,
    options?: UpdateOptions
  ): Promise<void> {
    const changedKeys: ConfigKey[] = []
    // 在更新前保存旧值快照，供 flushAndEmitChanges 计算 previousValue
    const previousFlat = new Map(this.cachedFlatValues)

    Object.entries(updates).forEach(([k, value]) => {
      const key = k as ConfigKey

      // DB_MANAGED_KEYS 为只读，跳过写入（数据由 ConfigDbManager 管理）
      if (DB_MANAGED_KEYS.has(key)) {
        logger.debug(
          LogCategory.CONFIG,
          `ConfigOrchestrator: 跳过对只读 DB 管理 key 的写入: ${key}`
        )
        return
      }

      const metadata = CONFIG_METADATA[key]
      if (!metadata) return

      const normalized = this.normalizeValue(
        metadata.path,
        metadata.dataType,
        value,
        metadata.min,
        metadata.max,
        metadata.enum
      )
      const current = this.cachedFlatValues.get(key)

      if (!areValuesEqual(current, normalized)) {
        if (normalized === undefined) {
          this.unifiedStore.delete(metadata.path)
        } else {
          this.unifiedStore.set(metadata.path, normalized as unknown)
          // 立即覆盖 cachedFlatValues，确保 flushAndEmitChanges 发送的是正确的值
          // （不能放 flush 后面，因为 flush 内的 rebuildCache 已用 merged 数据发 IPC）
          this.cachedFlatValues.set(key, normalized as unknown)
        }

        // 同时更新旧存储以保持兼容性和持久性
        const rendererField = CONFIG_KEY_TO_RENDERER_FIELD_MAP[key]
        if (rendererField) {
          if (normalized === undefined) {
            this.rendererStore.delete(rendererField as any)
          } else {
            this.rendererStore.set(rendererField as any, normalized as any)
          }
          this.rendererCache = { ...this.rendererCache, [rendererField]: normalized }
        }

        changedKeys.push(key)
      }
    })

    if (changedKeys.length > 0) {
      await this.flushAndEmitChanges(
        options?.source ?? 'user',
        changedKeys,
        options?.preventAutoReload,
        previousFlat
      )
      // flushAndEmitChanges 重建 cachedFlatValues 后，覆盖 runtime 级别的值为正确的值
      // 因为 unifiedStore.set 写入后，deepMerge 会叠加旧 leaf 条目
      Object.entries(updates).forEach(([k, value]) => {
        if (value !== undefined) {
          const key = k as ConfigKey
          this.cachedFlatValues.set(key, value as unknown)
        }
      })
    }
  }

  onRendererConfigChange(
    callback: (newConfig: AppConfig, previous: AppConfig) => void
  ): () => void {
    this.on('renderer-change', callback)
    return () => this.off('renderer-change', callback)
  }

  /**
   * 注册配置项变更监听器 (支持异步)
   */
  onValueChange<T = unknown>(key: ConfigKey, handler: ConfigChangeHandler<T>): () => void {
    if (!this.valueChangeHandlers.has(key)) {
      this.valueChangeHandlers.set(key, new Set())
    }
    this.valueChangeHandlers.get(key)!.add(handler)
    return () => {
      this.valueChangeHandlers.get(key)?.delete(handler)
    }
  }

  /**
   * 监听所有配置变更（批量）
   */
  onConfigChange(handler: (changes: Partial<Record<ConfigKey, unknown>>) => void): () => void {
    this.on('config-batch-change', handler)
    return () => this.off('config-batch-change', handler)
  }

  private async flushAndEmitChanges(
    source: ConfigChangeSource,
    changedKeys: ConfigKey[],
    preventAutoReload?: boolean,
    previousFlatOverride?: Map<ConfigKey, unknown>
  ): Promise<void> {
    const previousConfig = this.cachedConfig
    const previousFlat = previousFlatOverride ?? new Map(this.cachedFlatValues)

    // 在 rebuildCache 前保存 changedKeys 的当前正确值（rebuildCache 的 deepMerge 可能叠加旧数据）
    const savedOverrides = new Map<ConfigKey, unknown>()
    for (const key of changedKeys) {
      const val = this.cachedFlatValues.get(key)
      savedOverrides.set(key, val)
    }

    this.rebuildCache()

    // 恢复 changedKeys 的正确值，确保后续 IPC 发送的数据是准确的
    for (const [key, val] of savedOverrides) {
      if (val !== undefined) {
        this.cachedFlatValues.set(key, val)
      }
    }

    logger.info(
      LogCategory.CONFIG,
      `[ConfigOrchestrator] flushAndEmitChanges source=${source} changedKeys=${JSON.stringify(changedKeys)}`
    )

    const changes: Partial<Record<ConfigKey, unknown>> = {}

    // 我们必须按照顺序处理每个变更的 key 并等待其 handler
    for (const key of changedKeys) {
      const previousValue = previousFlat.get(key)
      const nextValue = this.cachedFlatValues.get(key)

      if (areValuesEqual(previousValue, nextValue)) {
        continue
      }

      // 如果是秘密字段，不通过 IPC 发送到渲染进程
      const metadata = CONFIG_METADATA[key]
      if (metadata && (metadata as any).secret) {
        // Skip adding to 'changes' for IPC emission
      } else {
        changes[key] = nextValue
      }

      // 1. 发射 legacy 事件 (EventEmitter 是同步的)
      this.emitValueChange(key, nextValue, previousValue, source, preventAutoReload)

      // 2. 调用并等待专用 handler (核心修复：支持并等待异步操作)
      const handlers = this.valueChangeHandlers.get(key)
      if (handlers) {
        for (const handler of handlers) {
          try {
            await handler(nextValue, previousValue as any, { preventAutoReload, source })
          } catch (err) {
            logger.error(LogCategory.CONFIG, `ConfigOrchestrator: Handler for ${key} failed`, err)
          }
        }
      }
    }

    if (Object.keys(changes).length > 0) {
      this.emit('config-batch-change', changes)
    }

    // 向渲染进程发送全量扁平化版本以供同步
    this.emit('unified-change', this.getFlattenedConfig(), previousConfig)
  }

  private emitValueChange(
    key: ConfigKey,
    value: unknown,
    previousValue: unknown,
    source: ConfigChangeSource,
    preventAutoReload?: boolean
  ): void {
    this.emit('value-change', { key, value, previousValue, source, preventAutoReload })
    this.emit(`value-change:${key}`, value, previousValue, { source, preventAutoReload })
  }

  private rebuildCache(): UnifiedAppConfig {
    const merged = deepMerge<UnifiedAppConfig>(
      defaultUnifiedConfig,
      this.unifiedStore.store,
      this.runtimeOverrides
    )

    // 兼容性逻辑：若 EXTRACT_PAGES 未设置，回退到 PDF_EXTRACT_PAGES
    const extractPagesPath = CONFIG_METADATA['EXTRACT_PAGES']?.path
    const legacyPath = 'analysis.PDF_EXTRACT_PAGES'

    if (extractPagesPath && this.unifiedStore.get(extractPagesPath) === undefined) {
      const legacyValue = this.unifiedStore.get(legacyPath)
      if (legacyValue !== undefined) {
        // 更新合并后的配置对象，以便后续 buildFlatMap 能拿到正确的值
        if (merged.analysis) {
          merged.analysis.EXTRACT_PAGES = legacyValue as number
        }
      }
    }

    this.cachedConfig = merged
    this.cachedFlatValues = this.buildFlatMap(merged)
    return merged
  }

  private buildFlatMap(config: UnifiedAppConfig): Map<ConfigKey, unknown> {
    const map = new Map<ConfigKey, unknown>()
    Object.entries(CONFIG_METADATA).forEach(([key, metadata]) => {
      const value = getValueByPath(config, metadata.path)
      map.set(key as ConfigKey, value)
    })
    return map
  }

  private normalizeValue(
    path: string,
    dataType: 'string' | 'number' | 'boolean' | 'array' | 'object',
    value: unknown,
    min?: number,
    max?: number,
    allowed?: readonly unknown[]
  ): unknown {
    const fallback = getValueByPath(
      defaultUnifiedConfig as unknown as Record<string, unknown>,
      path
    )

    if (value === undefined || value === null) {
      return fallback
    }

    if (dataType === 'array') {
      if (Array.isArray(value)) {
        return value
      }
      // 如果值是 JSON 字符串，尝试解析
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value)
          if (Array.isArray(parsed)) return parsed
        } catch {
          // ignore
        }
      }
      logger.warn(LogCategory.CONFIG, `配置项 ${path} 的值类型不正确(应为array)，回退到默认值`)
      return fallback
    }

    if (dataType === 'object') {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value
      }
      if (typeof value === 'string') {
        try {
          const parsed = JSON.parse(value)
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
        } catch {
          // ignore
        }
      }
      logger.warn(LogCategory.CONFIG, `配置项 ${path} 的值类型不正确(应为object)，回退到默认值`)
      return fallback
    }

    if (dataType === 'number') {
      const numeric = Number(value)
      if (Number.isNaN(numeric)) {
        logger.warn(LogCategory.CONFIG, `配置项 ${path} 的值 ${value} 无法解析为数字，回退到默认值`)
        return fallback
      }
      if (typeof min === 'number' && numeric < min) {
        return min
      }
      if (typeof max === 'number' && numeric > max) {
        return max
      }
      return numeric
    }

    if (dataType === 'boolean') {
      if (typeof value === 'boolean') {
        return value
      }
      return value === 'true'
    }

    if (dataType === 'string') {
      const stringValue = String(value)
      if (allowed && allowed.length > 0 && !allowed.includes(stringValue)) {
        logger.warn(
          LogCategory.CONFIG,
          `配置项 ${path} 的值 ${stringValue} 不在允许集合中，回退默认值`
        )
        return fallback
      }
      return stringValue
    }

    return value
  }

  private writeUnifiedPartial(partial: UnifiedConfigUpdate, prefix?: string): void {
    Object.entries(partial).forEach(([key, value]) => {
      const currentPath = prefix ? `${prefix}.${key}` : key
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        this.writeUnifiedPartial(value as UnifiedConfigUpdate, currentPath)
      } else if (value !== undefined) {
        this.unifiedStore.set(currentPath, value as unknown)
      }
    })
  }
}
