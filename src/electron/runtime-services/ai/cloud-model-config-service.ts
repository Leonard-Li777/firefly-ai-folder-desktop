import { logger, LogCategory } from '@yonuc/shared'
import type { CloudModelConfig, CloudModelConfigService, ProviderModel } from '@yonuc/types'
import { t } from '@app/languages'
import { ConfigOrchestrator } from '../../config/config-orchestrator'
import { nativeApi, nativeFetch } from '../utils/native-network'

/**
 * 云端模型配置服务
 * 管理云端模型的配置存储和操作
 */
export class CloudModelConfigServiceImpl implements CloudModelConfigService {
  private static instance: CloudModelConfigServiceImpl | null = null
  private configOrchestrator: ConfigOrchestrator

  private constructor() {
    this.configOrchestrator = ConfigOrchestrator.getInstance()
    if (logger) {
      logger.info(LogCategory.AI_CONFIG, '云端模型配置服务已初始化')
    }
  }

  static getInstance(): CloudModelConfigServiceImpl {
    if (!CloudModelConfigServiceImpl.instance) {
      CloudModelConfigServiceImpl.instance = new CloudModelConfigServiceImpl()
    }
    return CloudModelConfigServiceImpl.instance
  }

  async getConfigs(): Promise<CloudModelConfig[]> {
    try {
      const configs = this.configOrchestrator.getValue<CloudModelConfig[]>('CLOUD_MODEL_CONFIGS')
      // 强制确保返回数组，修复可能的数据损坏
      return Array.isArray(configs) ? configs : []
    } catch (error) {
      logger.error(LogCategory.AI_CONFIG, '获取云端配置失败:', error)
      return []
    }
  }

  async getConfig(index: number): Promise<CloudModelConfig | null> {
    try {
      const configs = await this.getConfigs()
      if (index >= 0 && index < configs.length) {
        return configs[index]
      }
      return null
    } catch (error) {
      logger.error(LogCategory.AI_CONFIG, `获取索引${index}的配置失败:`, error)
      return null
    }
  }

  async addConfig(config: CloudModelConfig): Promise<void> {
    try {
      this.validateConfigPartial(config)
      // Clone array to ensure reference change for ConfigOrchestrator
      const configs = [...await this.getConfigs()]
      
      // Check if config for this provider already exists -> Update it
      const existingIndex = configs.findIndex(c => c.provider === config.provider)
      
      if (existingIndex >= 0) {
        configs[existingIndex] = config
        logger.info(LogCategory.AI_CONFIG, `Upserting cloud config (Update): provider=${config.provider} at index ${existingIndex}`)
      } else {
        configs.push(config)
        logger.info(LogCategory.AI_CONFIG, `Upserting cloud config (Add): provider=${config.provider}`)
      }
      
      this.configOrchestrator.updateValue('CLOUD_MODEL_CONFIGS', configs)
    } catch (error) {
      logger.error(LogCategory.AI_CONFIG, '添加/更新云端配置失败:', error)
      throw error
    }
  }

  async updateConfig(index: number, config: CloudModelConfig): Promise<void> {
    try {
      this.validateConfigPartial(config)
      // Clone array to ensure reference change for ConfigOrchestrator
      const configs = [...await this.getConfigs()]
      if (index < 0 || index >= configs.length) {
        throw new Error(t('配置索引 {index} 超出范围', { index }))
      }
      configs[index] = config
      this.configOrchestrator.updateValue('CLOUD_MODEL_CONFIGS', configs)
      logger.info(LogCategory.AI_CONFIG, `更新云端配置: index=${index}, provider=${config.provider}`)
    } catch (error) {
      logger.error(LogCategory.AI_CONFIG, `更新云端配置失败: index=${index}`, error)
      throw error
    }
  }

  async deleteConfig(index: number): Promise<void> {
    try {
      // Clone array to ensure reference change for ConfigOrchestrator
      const configs = [...await this.getConfigs()]
      if (index < 0 || index >= configs.length) {
        throw new Error(t('配置索引 {index} 超出范围', { index }))
      }

      const deletedConfig = configs[index]
      configs.splice(index, 1)
      
      this.configOrchestrator.updateValue('CLOUD_MODEL_CONFIGS', configs)
      
      // 如果删除的是选中的配置，重置选中索引
      const selectedIndex = this.configOrchestrator.getValue<number>('SELECTED_CLOUD_CONFIG_INDEX')
      if (selectedIndex === index) {
        const newIndex = configs.length > 0 ? 0 : -1
        await this.setSelectedIndex(newIndex)
      }
      
      logger.info(LogCategory.AI_CONFIG, `删除云端配置: index=${index}, provider=${deletedConfig.provider}`)
    } catch (error) {
      logger.error(LogCategory.AI_CONFIG, `删除云端配置失败: index=${index}`, error)
      throw error
    }
  }

  async getSelectedIndex(): Promise<number> {
    try {
      const index = this.configOrchestrator.getValue<number>('SELECTED_CLOUD_CONFIG_INDEX')
      return index ?? -1
    } catch (error) {
      logger.error(LogCategory.AI_CONFIG, '获取选中配置索引失败:', error)
      return -1
    }
  }

  async setSelectedIndex(index: number): Promise<void> {
    try {
      const configs = await this.getConfigs()
      if (index !== -1 && (index < 0 || index >= configs.length)) {
        throw new Error(t('配置索引 {index} 超出范围', { index }))
      }
      
      this.configOrchestrator.updateValue('SELECTED_CLOUD_CONFIG_INDEX', index)
      
      // Sync detailed configuration to global keys if a valid index is selected
      if (index !== -1) {
        const selectedConfig = configs[index]
        if (selectedConfig) {
          logger.info(LogCategory.AI_CONFIG, `Syncing cloud config to global settings: ${selectedConfig.provider}`)
          
          if (!selectedConfig.apiKey) {
             logger.warn(LogCategory.AI_CONFIG, `Warning: Selected cloud config has empty API Key! Provider: ${selectedConfig.provider}`);
          } else {
             logger.info(LogCategory.AI_CONFIG, `Setting AI_CLOUD_API_KEY (length: ${selectedConfig.apiKey.length})`);
          }

          this.configOrchestrator.updateValue('AI_CLOUD_PROVIDER', selectedConfig.provider)
          this.configOrchestrator.updateValue('AI_CLOUD_API_KEY', selectedConfig.apiKey)
          this.configOrchestrator.updateValue('AI_CLOUD_BASE_URL', selectedConfig.baseUrl)
          
          // Only update model if present, otherwise keep existing
          if (selectedConfig.model) {
            this.configOrchestrator.updateValue('AI_CLOUD_SELECTED_MODEL_ID', selectedConfig.model)
          }
          
          // Force switch to cloud mode when activating a cloud config
          this.configOrchestrator.updateValue('AI_SERVICE_MODE', 'cloud')
        }
      }
      
      logger.info(LogCategory.AI_CONFIG, `设置选中的云端配置索引: ${index}`)
    } catch (error) {
      logger.error(LogCategory.AI_CONFIG, '设置选中配置索引失败:', error)
      throw error
    }
  }

  /**
   * 测试云端配置连接
   * 策略：
   * 1. 优先尝试获取模型列表（开销小，验证全面）
   * 2. 如果获取列表失败（部分服务商不支持），则尝试发送一个极简的Chat请求进行验证
   */
  async testConfig(config: CloudModelConfig): Promise<boolean> {
    // 测试连接时不需要验证model字段，只需要验证必要的连接参数
    this.validateConfigForTest(config)
    logger.info(LogCategory.AI_CONFIG, `开始测试云端配置: provider=${config.provider}`)

    // 1. 尝试获取模型列表
    try {
      // 在测试模式下，如果获取模型列表失败，我们希望看到具体错误
      const models = await this.getProviderModels(
        config.provider,
        config.apiKey,
        config.baseUrl,
        true // throwOnError
      )
      if (models.length > 0) {
        logger.info(LogCategory.AI_CONFIG, '配置测试成功: 成功获取模型列表')
        return true
      }
    } catch (e) {
      logger.warn(LogCategory.AI_CONFIG, '测试配置时获取模型列表失败，尝试进行对话测试...', e)
      // 如果是因为 404 导致的，且 provider 是特定的，可能就是不支持模型列表接口，继续进行对话测试
      // 但如果是 API Key 错误等，应该在这里就抛出
      if (e instanceof Error && (e.message.includes('401') || e.message.includes('403'))) {
        throw e
      }
    }

    // 2. 回退策略：尝试发送一个极小的对话请求
    if (!config.baseUrl || !config.baseUrl.trim()) {
      logger.error(LogCategory.AI_CONFIG, '测试配置失败: baseUrl不能为空')
      throw new Error(t('baseUrl不能为空'))
    }

    const baseUrl = this.normalizeBaseUrl(config.baseUrl)
    const apiKey = this.normalizeApiKey(config.apiKey)
    let chatUrl = ''
    let headers: Record<string, string> = {
      'Content-Type': 'application/json'
    }
    let body: any = {}

    if (config.provider === 'ollama') {
      chatUrl = `${baseUrl}/api/chat`
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`
      }
      body = {
        model: config.model || 'llama3', // Ollama 测试需要一个模型名
        messages: [{ role: 'user', content: 'Hi' }],
        stream: false
      }
    } else if (config.provider === 'gemini') {
      // Gemini generateContent API
      const model = config.model || 'gemini-1.5-flash'
      chatUrl = `${baseUrl}/models/${model}:generateContent?key=${apiKey}`
      body = {
        contents: [{ parts: [{ text: 'Hi' }] }],
        generationConfig: {
          maxOutputTokens: 1
        }
      }
    } else {
      // OpenAI Compatible
      chatUrl = `${baseUrl}/chat/completions`
      headers['Authorization'] = `Bearer ${apiKey}`
      body = {
        model: config.model || 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 1,
        stream: false
      }
    }

    try {
      const response = await nativeFetch(chatUrl, {
        method: 'POST',
        headers,
        body
      })

      if (!response.ok) {
        const displayError = (typeof response.data === 'string' ? response.data.trim() : JSON.stringify(response.data)) || response.statusText || String(response.status)
        throw new Error(
          t('API响应错误: {status} - {errorText}', { status: response.status, errorText: displayError })
        )
      }

      logger.info(LogCategory.AI_CONFIG, '配置测试成功: 对话接口连通')
      return true
    } catch (error) {
      if (error instanceof Error) throw error
      throw new Error(String(error))
    }
  }

  async getProviderModels(
    provider: string,
    apiKey: string,
    baseUrl?: string,
    throwOnError = false
  ): Promise<ProviderModel[]> {
    try {
      logger.info(LogCategory.AI_CONFIG, `获取${provider}的模型列表, baseUrl=${baseUrl}`)

      if (!baseUrl || !baseUrl.trim()) {
        logger.error(LogCategory.AI_CONFIG, `获取模型列表失败: baseUrl不能为空`)
        if (throwOnError) throw new Error(t('baseUrl不能为空'))
        return []
      }

      const normalizedUrl = this.normalizeBaseUrl(baseUrl)
      const safeApiKey = this.normalizeApiKey(apiKey)
      let models: ProviderModel[] = []

      if (provider === 'ollama') {
        // Ollama 格式
        const response = await nativeFetch(`${normalizedUrl}/api/tags`)
        if (!response.ok) {
          const errText = (typeof response.data === 'string' ? response.data : JSON.stringify(response.data)) || response.statusText
          throw new Error(`Ollama API error: ${response.status} - ${errText}`)
        }
        const data = response.data
        models = (data.models || []).map((m: any) => ({
          id: m.name,
          name: m.name,
          capabilities: { text: true } // Ollama 模型至少支持文本
        }))
      } else if (provider === 'gemini') {
        // Gemini 格式
        // Google API 结构: https://generativelanguage.googleapis.com/v1beta/models?key=YOUR_API_KEY
        const targetUrl = `${normalizedUrl}/models?key=${safeApiKey}`

        logger.debug(LogCategory.AI_CONFIG, `请求 Gemini 模型列表: ${targetUrl.replace(safeApiKey, '***')}`)

        const response = await nativeFetch(targetUrl)
        if (!response.ok) {
          const errText = (typeof response.data === 'string' ? response.data : JSON.stringify(response.data)) || response.statusText
          throw new Error(`Gemini API error: ${response.status} - ${errText}`)
        }

        const data = response.data
        models = (data.models || []).map((m: any) => {
          // Gemini 返回的模型名称通常是 "models/gemini-1.5-pro"
          const id = m.name.includes('/') ? m.name.split('/').pop() : m.name
          return {
            id: id,
            name: m.displayName || id,
            capabilities: {
              text: true,
              image: m.supportedGenerationMethods?.includes('generateContent') || false
            }
          }
        })
      } else {
        // OpenAI 兼容格式 (OpenAI, DeepSeek, Moonshot, etc.)
        // 大多数国内大模型服务商都兼容 /v1/models 接口
        const targetUrl = normalizedUrl.endsWith('/v1')
          ? `${normalizedUrl}/models`
          : `${normalizedUrl}/v1/models`

        logger.debug(LogCategory.AI_CONFIG, `请求模型列表: ${targetUrl}`)

        const response = await nativeFetch(targetUrl, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${safeApiKey}`,
            'Content-Type': 'application/json'
          }
        })

        if (!response.ok) {
          const errText = (typeof response.data === 'string' ? response.data : JSON.stringify(response.data)) || response.statusText
          throw new Error(`API request failed: ${response.status} - ${errText}`)
        }

        const data = response.data

        // 兼容不同的返回结构 { data: [] } 或 { list: [] }
        const list = Array.isArray(data) ? data : data.data || data.list || []

        models = list.map((m: any) => ({
          id: m.id,
          name: m.name || m.id, // 如果没有name字段，则使用id作为name
          capabilities: m.capabilities // 保留capabilities字段（如果存在）
        }))
      }

      logger.info(LogCategory.AI_CONFIG, `成功获取 ${models.length} 个模型`)
      return models
    } catch (error) {
      logger.error(LogCategory.AI_CONFIG, `获取${provider}的模型列表失败:`, error)
      if (throwOnError) throw error
      // 不抛出错误，而是返回空数组，避免阻塞UI
      return []
    }
  }

  /**
   * 验证配置的部分字段（用于保存时的基本验证）
   * 允许保存不完整的配置，但至少需要provider
   */
  private validateConfigPartial(config: CloudModelConfig): void {
    if (!config.provider) {
      throw new Error(t('provider 是必填项'))
    }

    if (config.baseUrl) {
      try {
        new URL(config.baseUrl)
      } catch {
        throw new Error(t('baseUrl 格式不正确: {baseUrl}', { baseUrl: config.baseUrl }))
      }
    }
  }

  /**
   * 验证完整配置（用于激活配置时的严格验证）
   */
  private validateConfig(config: CloudModelConfig): void {
    if (!config.provider) {
      throw new Error(t('provider 是必填项'))
    }
    // Ollama 本地部署可能不需要 apiKey，但通常云端服务需要
    if (!config.apiKey && config.provider !== 'ollama') {
      throw new Error(t('apiKey 是必填项'))
    }
    if (!config.model) {
      throw new Error(t('model 是必填项'))
    }

    if (config.baseUrl) {
      try {
        new URL(config.baseUrl)
      } catch {
        throw new Error(t('baseUrl 格式不正确: {baseUrl}', { baseUrl: config.baseUrl }))
      }
    }
  }

  /**
   * 验证用于测试连接的配置
   * 测试连接时不需要验证model字段，只需要验证必要的连接参数
   */
  private validateConfigForTest(config: CloudModelConfig): void {
    if (!config.provider) {
      throw new Error(t('provider 是必填项'))
    }
    // Ollama 本地部署可能不需要 apiKey，但通常云端服务需要
    if (!config.apiKey && config.provider !== 'ollama') {
      throw new Error(t('apiKey 是必填项'))
    }
    // 测试连接时不需要验证model字段

    if (config.baseUrl) {
      try {
        new URL(config.baseUrl)
      } catch {
        throw new Error(t('baseUrl 格式不正确: {baseUrl}', { baseUrl: config.baseUrl }))
      }
    }
  }

  /**
   * 辅助方法：处理 BaseURL 格式，去除末尾斜杠
   */
  private normalizeBaseUrl(url?: string): string {
    if (!url || !url.trim()) {
      throw new Error(t('baseUrl不能为空'))
    }
    let cleanUrl = url.trim()
    while (cleanUrl.endsWith('/')) {
      cleanUrl = cleanUrl.slice(0, -1)
    }
    return cleanUrl
  }

  /**
   * 辅助方法：处理 API Key 格式，过滤非 ASCII 字符，防止 fetch 抛出 ByteString 错误
   */
  private normalizeApiKey(key?: string): string {
    if (!key || !key.trim()) {
      return ''
    }
    // 过滤掉所有非 ASCII 字符 (0-255 以外的字符)
    // fetch 的 headers 仅支持 Latin1 字符
    return key.trim().replace(/[^\x00-\xff]/g, '')
  }
}

export const cloudModelConfigService = CloudModelConfigServiceImpl.getInstance()
