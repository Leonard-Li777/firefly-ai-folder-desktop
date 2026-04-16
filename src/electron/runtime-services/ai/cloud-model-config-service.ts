import { logger, LogCategory } from '@yonuc/shared'
import type { CloudModelConfig, CloudModelConfigService, ProviderModel } from '@yonuc/types'
import { t } from '@app/languages'
import { ConfigOrchestrator } from '../../config/config-orchestrator'

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
        const models = await this.getProviderModels(config.provider, config.apiKey, config.baseUrl)
        if (models.length > 0) {
          logger.info(LogCategory.AI_CONFIG, '配置测试成功: 成功获取模型列表')
          return true
        }
      } catch (e) {
        logger.warn(LogCategory.AI_CONFIG, '测试配置时获取模型列表失败，尝试进行对话测试...', e)
      }

      // 2. 回退策略：尝试发送一个极小的对话请求
      if (!config.baseUrl || !config.baseUrl.trim()) {
        logger.error(LogCategory.AI_CONFIG, '测试配置失败: baseUrl不能为空')
        throw new Error('baseUrl不能为空')
      }

      const baseUrl = this.normalizeBaseUrl(config.baseUrl)
      const chatUrl = config.provider === 'ollama' 
        ? `${baseUrl}/api/chat`
        : `${baseUrl}/chat/completions`

      // 如果没有model，不能进行对话测试
      if (!config.model) {
        logger.warn(LogCategory.AI_CONFIG, '无法进行对话测试: 缺少model字段')
        throw new Error(t('缺少model字段，无法进行对话测试'))
      }

      const payload = {
        model: config.model,
        messages: [{ role: 'user', content: 'Hi' }],
        max_tokens: 1, // 最小化 token 消耗
        stream: false
      }

      const response = await fetch(chatUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.apiKey}`
        },
        body: JSON.stringify(payload)
      })

      if (!response.ok) {
        const errorText = await response.text()
        throw new Error(t('API响应错误: {status} - {errorText}', { status: response.status, errorText }))
      }

      logger.info(LogCategory.AI_CONFIG, '配置测试成功: 对话接口连通')
      return true
  }

  async getProviderModels(provider: string, apiKey: string, baseUrl?: string): Promise<ProviderModel[]> {
    try {
      logger.info(LogCategory.AI_CONFIG, `获取${provider}的模型列表, baseUrl=${baseUrl}`)
      
      if (!baseUrl || !baseUrl.trim()) {
        logger.error(LogCategory.AI_CONFIG, `获取模型列表失败: baseUrl不能为空`)
        return []
      }

      const normalizedUrl = this.normalizeBaseUrl(baseUrl)
      let models: ProviderModel[] = []

      if (provider === 'ollama') {
        // Ollama 格式
        const response = await fetch(`${normalizedUrl}/api/tags`)
        if (!response.ok) throw new Error(`Ollama API error: ${response.statusText}`)
        const data = await response.json()
        models = (data.models || []).map((m: any) => ({
          label: m.name,
          value: m.name,
          group: 'Ollama'
        }))
      } else {
        // OpenAI 兼容格式 (OpenAI, DeepSeek, Moonshot, etc.)
        // 大多数国内大模型服务商都兼容 /v1/models 接口
        const targetUrl = normalizedUrl.endsWith('/v1') 
          ? `${normalizedUrl}/models` 
          : `${normalizedUrl}/v1/models`

        logger.debug(LogCategory.AI_CONFIG, `请求模型列表: ${targetUrl}`)

        const response = await fetch(targetUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          }
        })

        if (!response.ok) {
            const errText = await response.text()
            throw new Error(`API request failed: ${status} - ${errText}`)
        }

        const data = await response.json()
        
        // 兼容不同的返回结构 { data: [] } 或 { list: [] }
        const list = Array.isArray(data) ? data : (data.data || data.list || [])
        
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
}

export const cloudModelConfigService = CloudModelConfigServiceImpl.getInstance()
