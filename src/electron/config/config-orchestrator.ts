import { EventEmitter } from 'node:events'
import { Conf } from 'electron-conf'
import fixPath from 'fix-path'

// 在 macOS 和 Linux 上修复 PATH 环境变量
if (process.platform !== 'win32') {
  try {
    const fixPathFunc = typeof fixPath === 'function' ? fixPath : (fixPath as any).default;
    if (typeof fixPathFunc === 'function') {
      fixPathFunc();
    }
  } catch (e) {
    console.error('Failed to fix PATH in ConfigOrchestrator:', e);
  }
}
import { 
  logger, 
  LogCategory, 
  defaultRendererConfig, 
  CONFIG_METADATA,
  CONFIG_KEY_TO_RENDERER_FIELD_MAP
} from '@yonuc/shared'
import type { AppConfig } from '@yonuc/types'
import type {
  ConfigChangeHandler,
  ConfigChangeSource,
  ConfigKey,
  UnifiedAppConfig,
  UnifiedConfigUpdate,
} from '@yonuc/types/config-types'
import { defaultUnifiedConfig } from './config.default'
import { AIServiceConfigManager } from '@yonuc/electron-llamaIndex-service'
import type { AIServiceConfig } from '@yonuc/types/ai-config-types'
import { app } from 'electron'
import * as path from 'node:path'

interface UpdateOptions {
  source?: ConfigChangeSource
  preventAutoReload?: boolean
}

function deepMerge<T>(...sources: Array<Record<string, any> | undefined>): T {
  const result: Record<string, any> = {}

  for (const source of sources) {
    if (!source) continue
    Object.entries(source).forEach(([key, value]) => {
      if (Array.isArray(value)) {
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
    this.rendererStore = new Conf<AppConfig>({
      name: 'yonuc-ai-folder-config',
      defaults: defaultRendererConfig,
    })
    this.unifiedStore = new Conf<Record<string, unknown>>({
      name: 'yonuc-unified-config',
      defaults: {},
    })
    this.rendererCache = this.rendererStore.store
    
    // 强制应用构建时指定的 AI 引擎，确保 package.json 中的设置优先于用户本地保存的配置
    const buildTimeEngine = defaultUnifiedConfig.ai?.AI_ENGINE;
    if (buildTimeEngine) {
      this.runtimeOverrides = {
        ai: {
          AI_ENGINE: buildTimeEngine as any
        }
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
        const { llamaModelManager } = await import('../runtime-services/llama/llama-model-manager')
        const { modelDownloadManager } = await import('../runtime-services/ai/model-download-manager')

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
        if (!aiConfig.local.modelPath || aiConfig.local.modelPath.endsWith(`${selectedModelId}.gguf`)) {
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
      }
    }
  }

  /**
   * 获取扁平化的配置对象
   */
  getFlattenedConfig(): Record<string, unknown> {
    const flatConfig: Record<string, unknown> = {}
    this.cachedFlatValues.forEach((value, key) => {
      // 优先使用渲染进程对应的字段名
      const rendererField = CONFIG_KEY_TO_RENDERER_FIELD_MAP[key]
      if (rendererField) {
        flatConfig[rendererField] = value
      }
      // 同时保留 ConfigKey 作为键，以支持 getConfigValue('KEY') 的直接访问
      flatConfig[key] = value
    })
    return flatConfig
  }

  getConfigSnapshot(): UnifiedAppConfig {
    return { ...this.cachedConfig }
  }

  getValue<T = unknown>(key: ConfigKey): T {
    return this.cachedFlatValues.get(key) as T
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
      if (CONFIG_METADATA[key as ConfigKey]) {
        unifiedUpdates[key as ConfigKey] = value
      } else {
        // 尝试寻找映射 (简单的启发式搜索)
        const configKey = (Object.keys(CONFIG_METADATA) as ConfigKey[]).find(k => {
          const meta = CONFIG_METADATA[k]
          return meta.path.endsWith(`.${key}`) || meta.key === key
        })
        if (configKey) {
          unifiedUpdates[configKey] = value
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
    void this.flushAndEmitChanges(source)
  }

  async updateValue(key: ConfigKey, value: unknown, options?: UpdateOptions): Promise<void> {
    await this.updateValues({ [key]: value }, options)
  }

  /**
   * 批量更新多个配置项
   */
  async updateValues(updates: Partial<Record<ConfigKey, unknown>>, options?: UpdateOptions): Promise<void> {
    const changedKeys: ConfigKey[] = []

    Object.entries(updates).forEach(([k, value]) => {
      const key = k as ConfigKey
      const metadata = CONFIG_METADATA[key]
      if (!metadata) return

      const normalized = this.normalizeValue(metadata.path, metadata.dataType, value, metadata.min, metadata.max, metadata.enum)
      const current = this.cachedFlatValues.get(key)

      if (!areValuesEqual(current, normalized)) {
        this.unifiedStore.set(metadata.path, normalized as unknown)
        
        // 同时更新旧存储以保持兼容性和持久性
        const rendererField = CONFIG_KEY_TO_RENDERER_FIELD_MAP[key]
        if (rendererField) {
          this.rendererStore.set(rendererField as any, normalized as any)
          this.rendererCache = { ...this.rendererCache, [rendererField]: normalized }
        }
        
        changedKeys.push(key)
      }
    })

    if (changedKeys.length > 0) {
      await this.flushAndEmitChanges(options?.source ?? 'user', changedKeys, options?.preventAutoReload)
    }
  }

  onRendererConfigChange(callback: (newConfig: AppConfig, previous: AppConfig) => void): () => void {
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

  private async flushAndEmitChanges(source: ConfigChangeSource, changedKeys: ConfigKey[], preventAutoReload?: boolean): Promise<void> {
    const previousConfig = this.cachedConfig
    const previousFlat = new Map(this.cachedFlatValues)

    this.rebuildCache()

    const changes: Partial<Record<ConfigKey, unknown>> = {}
    
    // 我们必须按照顺序处理每个变更的 key 并等待其 handler
    for (const key of changedKeys) {
      const previousValue = previousFlat.get(key)
      const nextValue = this.cachedFlatValues.get(key)
      
      if (areValuesEqual(previousValue, nextValue)) {
        continue
      }
      
      changes[key] = nextValue
      
      // 1. 发射 legacy 事件 (EventEmitter 是同步的)
      this.emitValueChange(key, nextValue, previousValue, source, preventAutoReload)
      
      // 2. 调用并等待专用 handler (核心修复：支持并等待异步操作)
      const handlers = this.valueChangeHandlers.get(key)
      if (handlers) {
        for (const handler of handlers) {
          try {
            await handler(nextValue, previousValue as any)
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
    const merged = deepMerge<UnifiedAppConfig>(defaultUnifiedConfig, this.unifiedStore.store, this.runtimeOverrides)
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
    allowed?: readonly unknown[],
  ): unknown {
    const fallback = getValueByPath(defaultUnifiedConfig as unknown as Record<string, unknown>, path)

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
        logger.warn(LogCategory.CONFIG, `配置项 ${path} 的值 ${stringValue} 不在允许集合中，回退默认值`)
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
