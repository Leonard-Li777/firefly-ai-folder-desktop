import * as fs from 'fs'
import * as path from 'path'

import { LogCategory, logger } from '@yonuc/shared'

import type { ILlamaModelConfig } from '@yonuc/types/model-manager'
import type { LocalModelConfigFile } from '@yonuc/types/config-types'
import { app } from 'electron'
import { configService } from '../config'
import { createConfigAdapter } from '../../adapters'
import { t } from '@app/languages'

/**
 * 模型配置服务
 * 负责加载、缓存和管理模型配置
 */
export class ModelConfigService {
  private static instance: ModelConfigService
  private cloudProvidersCache: Map<string, any> = new Map() // 云端提供商配置缓存
  private logger = logger.createLogger(LogCategory.MODEL_CONFIG)
  private config = createConfigAdapter()

  private constructor() {
    // 监听语言配置变化,自动清除缓存
    this.setupLanguageChangeListener()
  }

  /**
   * 设置语言变化监听器
   * 当语言改变时,清除模型配置缓存以确保加载正确语言的配置
   */
  private setupLanguageChangeListener(): void {
    try {
      configService.onValueChange<string>('DEFAULT_LANGUAGE', (newLanguage: string, oldLanguage: string | undefined) => {
        if (newLanguage !== oldLanguage) {
          this.logger.info(`语言从 ${oldLanguage || '未设置'} 切换到 ${newLanguage},清除所有配置缓存`)
          this.clearCache()
        }
      })
    } catch (error) {
      this.logger.warn(`设置语言变化监听器失败: ${error}`)
    }
  }

  static getInstance(): ModelConfigService {
    if (!ModelConfigService.instance) {
      ModelConfigService.instance = new ModelConfigService()
    }
    return ModelConfigService.instance
  }

  /**
   * 获取本地模型配置文件路径
   */
  private getLocalConfigPath(language: string): string {
    const resourcesPath = this.config.getResourcesPath()
    return path.join(resourcesPath, 'model', `model_${language}.json`)
  }

  /**
   * 获取本地 Ollama 模型配置文件路径
   */
  private getOllamaConfigPath(language: string): string {
    const resourcesPath = this.config.getResourcesPath()
    return path.join(resourcesPath, 'model', `ollama_${language}.json`)
  }

  private getPersistedLocalModelConfig(language: string): LocalModelConfigFile | undefined {
    try {
      // 系统基于语言隔离，直接读取当前语言的配置
      const config = configService.getValue<LocalModelConfigFile>('LOCAL_MODEL_CONFIGS')
      return config
    } catch (error) {
      this.logger.warn(`读取 LOCAL_MODEL_CONFIGS 失败，将返回 undefined: ${error}`)
      return undefined
    }
  }

  private getPersistedOllamaModelConfig(language: string): LocalModelConfigFile | undefined {
    try {
      // 系统基于语言隔离，直接读取当前语言的配置
      const config = configService.getValue<LocalModelConfigFile>('LOCAL_MODEL_CONFIGS_OLLAMA')
      return config
    } catch (error) {
      this.logger.warn(`读取 LOCAL_MODEL_CONFIGS_OLLAMA 失败，将返回 undefined: ${error}`)
      return undefined
    }
  }

  private persistLocalModelConfig(language: string, configFile: LocalModelConfigFile): void {
    // 系统基于语言隔离，直接存储当前语言的配置
    configService.updateValue('LOCAL_MODEL_CONFIGS', configFile)
  }

  private persistOllamaModelConfig(language: string, configFile: LocalModelConfigFile): void {
    // 系统基于语言隔离，直接存储当前语言的配置
    configService.updateValue('LOCAL_MODEL_CONFIGS_OLLAMA', configFile)
  }

  /**
   * 获取云端模型配置文件路径
   */
  private getCloudProvidersConfigPath(language: string): string {
    const resourcesPath = this.config.getResourcesPath()
    return path.join(resourcesPath, 'model', `providers_${language}.json`)
  }

  /**
   * 加载本地模型配置
   * - 首次启动：从 build/extraResources/model/model_{language}.json 读取并写入 unified-config
   * - 后续启动：仅从 unified-config 读取，不再读取 build 内置文件
   */
  /**
   * Normalize model capability types to uppercase
   */
  private normalizeModelCapabilities(models: ILlamaModelConfig[]): void {
    models.forEach(model => {
      model.capabilities?.forEach(cap => {
        if (cap.type) {
          // @ts-ignore
          cap.type = cap.type.toUpperCase()
        }
      })
    })
  }

  /**
   * 加载本地模型配置
   * - 首次启动：从 build/extraResources/model/model_{language}.json 读取并写入 unified-config
   * - 后续启动：仅从 unified-config 读取，不再读取 build 内置文件
   */
  private loadLocalConfig(language: string): LocalModelConfigFile {
    const persisted = this.getPersistedLocalModelConfig(language)
    if (persisted) {
      const models = persisted.models ?? []
      this.normalizeModelCapabilities(models)

      // 检查是否存在过时的能力类型（中文类型），如果存在则强制重新加载
      const hasLegacyTypes = models.some((m) =>
        m.capabilities?.some((c) => /[\u4e00-\u9fa5]/.test(c.type))
      )

      if (!hasLegacyTypes) {
        return {
          ...persisted,
          models,
        }
      }
      this.logger.warn(`检测到旧版配置（包含翻译的能力类型），将忽略缓存并重新加载配置文件`)
    }

    try {
      const configPath = this.getLocalConfigPath(language)
      this.logger.info(`首次加载本地模型配置文件: ${configPath}`)

      if (!fs.existsSync(configPath)) {
        this.logger.warn(`本地配置文件不存在: ${configPath}`)
        this.logger.info(`当前工作目录: ${process.cwd()}`)
        this.logger.info(`资源路径: ${this.config.getResourcesPath()}`)
        this.logger.info(`是否打包: ${app.isPackaged}`)

        const emptyConfig: LocalModelConfigFile = { models: [] }
        this.persistLocalModelConfig(language, emptyConfig)
        return emptyConfig
      }

      const content = fs.readFileSync(configPath, 'utf-8')
      const parsed = JSON.parse(content)

      const normalized: LocalModelConfigFile = {
        ...parsed,
        models: parsed.models ?? [],
      }

      this.normalizeModelCapabilities(normalized.models)

      this.logger.info(`已加载本地模型配置: ${language}, 模型数量: ${normalized.models.length}`)

      this.persistLocalModelConfig(language, normalized)
      return normalized
    } catch (error) {
      this.logger.error(`加载本地配置失败: ${error}`)
      this.logger.error(`错误堆栈: ${error instanceof Error ? error.stack : String(error)}`)

      const emptyConfig: LocalModelConfigFile = { models: [] }
      this.persistLocalModelConfig(language, emptyConfig)
      return emptyConfig
    }
  }

  /**
   * 加载本地 Ollama 模型配置
   */
  private loadOllamaConfig(language: string): LocalModelConfigFile {
    const persisted = this.getPersistedOllamaModelConfig(language)
    if (persisted) {
      const models = persisted.models ?? []
      this.normalizeModelCapabilities(models)
      return {
        ...persisted,
        models,
      }
    }

    try {
      const configPath = this.getOllamaConfigPath(language)
      this.logger.info(`首次加载本地 Ollama 模型配置文件: ${configPath}`)

      if (!fs.existsSync(configPath)) {
        this.logger.warn(`本地 Ollama 配置文件不存在: ${configPath}`)
        const emptyConfig: LocalModelConfigFile = { models: [] }
        this.persistOllamaModelConfig(language, emptyConfig)
        return emptyConfig
      }

      const content = fs.readFileSync(configPath, 'utf-8')
      const parsed = JSON.parse(content)

      const normalized: LocalModelConfigFile = {
        ...parsed,
        models: parsed.models ?? [],
      }

      this.normalizeModelCapabilities(normalized.models)
      this.logger.info(`已加载本地 Ollama 模型配置: ${language}, 模型数量: ${normalized.models.length}`)

      this.persistOllamaModelConfig(language, normalized)
      return normalized
    } catch (error) {
      this.logger.error(`加载本地 Ollama 配置失败: ${error}`)
      const emptyConfig: LocalModelConfigFile = { models: [] }
      this.persistOllamaModelConfig(language, emptyConfig)
      return emptyConfig
    }
  }

  /**
   * 从本地文件加载云端模型配置（带缓存）
   */
  loadCloudProvidersConfig(language: string = this.config.getLanguage()): any {
    const cacheKey = `providers_${language}`

    // 检查缓存
    if (this.cloudProvidersCache.has(cacheKey)) {
      this.logger.debug(`使用缓存的云端提供商配置: ${cacheKey}`)
      return this.cloudProvidersCache.get(cacheKey)
    }

    try {
      const configPath = this.getCloudProvidersConfigPath(language)
      this.logger.info(`首次加载云端模型配置文件: ${configPath}`)

      if (!fs.existsSync(configPath)) {
        this.logger.warn(`云端模型配置文件不存在: ${configPath}`)
        const emptyConfig: any[] = []
        this.cloudProvidersCache.set(cacheKey, emptyConfig)
        return emptyConfig
      }

      const content = fs.readFileSync(configPath, 'utf-8')
      const config = JSON.parse(content)
      this.logger.info(`已加载云端模型配置: ${language}, 服务商数量: ${config.length || 0}`)

      // 缓存配置
      this.cloudProvidersCache.set(cacheKey, config)
      return config
    } catch (error) {
      this.logger.error(`加载云端模型配置失败: ${error}`)
      this.logger.error(`错误堆栈: ${error instanceof Error ? error.stack : String(error)}`)
      const emptyConfig: any[] = []
      this.cloudProvidersCache.set(cacheKey, emptyConfig)
      return emptyConfig
    }
  }

  private buildRemoteConfigUrl(configUrl: string, language: string): string {
    const trimmed = configUrl.trim()
    if (!trimmed) {
      return ''
    }

    if (trimmed.includes('{language}')) {
      return trimmed.replaceAll('{language}', language)
    }

    const normalized = trimmed.replace(/\/+$/, '')
    const fileName = `model_${language}.json`

    if (normalized.endsWith(fileName)) {
      return normalized
    }

    if (normalized.endsWith('.json')) {
      return normalized
    }

    return `${normalized}/${fileName}`
  }


  /**
   * 加载本地模型配置 (公开接口)
   * @param language 语言代码
   */
  public loadLocalModelConfig(language: string = this.config.getLanguage()): ILlamaModelConfig[] {
    const config = this.loadLocalConfig(language)
    return config.models || []
  }

  /**
   * 加载 Ollama 模型配置 (公开接口)
   * @param language 语言代码
   */
  public loadOllamaModelConfig(language: string = this.config.getLanguage()): ILlamaModelConfig[] {
    const config = this.loadOllamaConfig(language)
    return config.models || []
  }

  /**
   * 加载当前平台的模型配置
   * @param language 语言代码
   * @returns 合并后的模型配置
   */
  loadModelConfig(language: string = this.config.getLanguage()): ILlamaModelConfig[] {
    const platform = configService.getValue<'llama.cpp' | 'ollama'>('AI_PLATFORM') || 'llama.cpp'

    this.logger.debug(`加载模型配置，平台: ${platform}, 语言: ${language}`)

    let models: ILlamaModelConfig[] = []
    if (platform === 'ollama') {
      const ollamaConfig = this.loadOllamaConfig(language)
      models = ollamaConfig.models || []
    } else {
      const localConfig = this.loadLocalConfig(language)
      models = localConfig.models || []
    }

    return models
  }

  /**
   * 清除所有缓存
   */
  clearCache(): void {
    this.cloudProvidersCache.clear()
    this.logger.info('已清除云端提供商配置缓存')
  }

  /**
   * 获取模型的能力类型列表
   */
  getModelCapabilityTypes(model: any): string[] {
    if (!model.capabilities || !Array.isArray(model.capabilities)) {
      return []
    }
    return model.capabilities.map((cap: any) => cap.type)
  }

  /**
   * 获取模型支持的文件格式
   */
  getModelSupportedFormats(model: any): string[] {
    if (!model.capabilities || !Array.isArray(model.capabilities)) {
      return []
    }

    const formats = new Set<string>()
    model.capabilities.forEach((cap: any) => {
      if (Array.isArray(cap.supportedFormats)) {
        cap.supportedFormats.forEach((fmt: string) => {
          formats.add(fmt.toLowerCase())
        })
      }
    })

    return Array.from(formats)
  }

  /**
   * 检查模型是否支持多模态
   */
  isMultiModalModel(model: any): boolean {
    if (!model.capabilities || !Array.isArray(model.capabilities)) {
      return false
    }
    return model.capabilities.length > 1 || model.capabilities.some((cap: any) => cap.type !== 'TEXT')
  }

  /**
   * 根据文件类型选择合适的分析模式
   * @param model 模型配置
   * @param fileType 文件扩展名 (e.g., 'jpg', 'pdf')
   * @returns 分析模式: 'multimodal' | 'text-only'
   */
  selectAnalysisMode(model: any, fileType: string): 'multimodal' | 'text-only' {
    const cleanFileType = fileType.toLowerCase().replace(/^\./, '')
    const supportedFormats = this.getModelSupportedFormats(model)

    // 检查模型是否支持该文件类型的多模态分析
    const hasMultimodalCapability = model.capabilities?.some((cap: any) => {
      return cap.type !== 'TEXT' &&
        cap.supportedFormats?.includes(cleanFileType) ||
        cap.supportedFormats?.some((fmt: string) => fmt.toLowerCase() === cleanFileType)
    })

    if (hasMultimodalCapability) {
      return 'multimodal'
    }

    // 检查是否至少支持文本模式
    const hasTextCapability = supportedFormats.includes(cleanFileType)
    if (hasTextCapability) {
      return 'text-only'
    }

    // 默认降级为文本模式
    return 'text-only'
  }
}

