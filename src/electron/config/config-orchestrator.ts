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
import { logger, LogCategory, defaultRendererConfig, CONFIG_METADATA } from '@yonuc/shared'
import type { AppConfig } from '@yonuc/types'
import type {
  ConfigChangeHandler,
  ConfigChangeSource,
  ConfigKey,
  UnifiedAppConfig,
  UnifiedConfigUpdate,
} from '@yonuc/types/config-types'
import { defaultUnifiedConfig } from './config.default'

interface UpdateOptions {
  source?: ConfigChangeSource
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
    this.cachedConfig = this.rebuildCache()
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

  getRendererConfig(): AppConfig {
    return { ...this.rendererCache }
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
    // 使用正确的类型进行设置
    Object.entries(updates).forEach(([key, value]) => {
      if (value === undefined) {
        this.rendererStore.delete(key as keyof AppConfig)
      } else {
        this.rendererStore.set(key as keyof AppConfig, value)
      }
    })

    this.emit('renderer-change', this.rendererCache, previous)
  }

  updateUnifiedConfig(partial: UnifiedConfigUpdate, source: ConfigChangeSource = 'user'): void {
    if (!partial || Object.keys(partial).length === 0) {
      return
    }

    this.writeUnifiedPartial(partial)
    this.flushAndEmitChanges(source)
  }

  updateValue(key: ConfigKey, value: unknown, options?: UpdateOptions): void {
    this.updateValues({ [key]: value }, options)
  }

  /**
   * 批量更新多个配置项
   */
  updateValues(updates: Partial<Record<ConfigKey, unknown>>, options?: UpdateOptions): void {
    const changedKeys: ConfigKey[] = []

    Object.entries(updates).forEach(([k, value]) => {
      const key = k as ConfigKey
      const metadata = CONFIG_METADATA[key]
      if (!metadata) return

      const normalized = this.normalizeValue(metadata.path, metadata.dataType, value, metadata.min, metadata.max, metadata.enum)
      const current = this.cachedFlatValues.get(key)

      if (!areValuesEqual(current, normalized)) {
        logger.info(LogCategory.CONFIG, `Orchestrator: Batch preparing [${key}]`)
        this.unifiedStore.set(metadata.path, normalized as unknown)
        changedKeys.push(key)
      }
    })

    if (changedKeys.length > 0) {
      this.flushAndEmitChanges(options?.source ?? 'user', changedKeys)
    } else {
      logger.debug(LogCategory.CONFIG, 'Orchestrator: Batch update skipped, no values changed')
    }
  }

  onRendererConfigChange(callback: (newConfig: AppConfig, previous: AppConfig) => void): () => void {
    this.on('renderer-change', callback)
    return () => this.off('renderer-change', callback)
  }

  onValueChange<T = unknown>(key: ConfigKey, handler: ConfigChangeHandler<T>): () => void {
    const eventName = `value-change:${key}`
    const wrapped = (newValue: T, previousValue: T | undefined) => handler(newValue, previousValue)
    this.on(eventName, wrapped)
    return () => this.off(eventName, wrapped)
  }

  private flushAndEmitChanges(source: ConfigChangeSource, restrictedKeys?: ConfigKey[]): void {
    const previousConfig = this.cachedConfig
    const previousFlat = new Map(this.cachedFlatValues)

    this.rebuildCache()

    const keysToCheck = restrictedKeys ?? (Object.keys(CONFIG_METADATA) as ConfigKey[])

    keysToCheck.forEach(key => {
      const previousValue = previousFlat.get(key)
      const nextValue = this.cachedFlatValues.get(key)
      if (areValuesEqual(previousValue, nextValue)) {
        return
      }
      this.emitValueChange(key, nextValue, previousValue, source)
    })

    if (!restrictedKeys) {
      this.emit('unified-change', this.cachedConfig, previousConfig)
    }
  }

  private emitValueChange(
    key: ConfigKey,
    value: unknown,
    previousValue: unknown,
    source: ConfigChangeSource,
  ): void {
    this.emit('value-change', { key, value, previousValue, source })
    this.emit(`value-change:${key}`, value, previousValue)
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
