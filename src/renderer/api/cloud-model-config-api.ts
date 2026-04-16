/**
 * 云端模型配置前端API层
 * 与Electron主进程的IPC通信
 */

import type { CloudModelConfig, ProviderModel } from '@yonuc/types'
import { logger, LogCategory } from '@yonuc/shared'

const electronAPI = window.electronAPI as any

/**
 * 解包IPC响应结果
 * 兼容处理直接返回数据和 {success, data} 格式
 */
function unwrapResponse<T>(result: any): T {
  if (result && typeof result === 'object' && 'success' in result && 'data' in result) {
    if (result.success) {
      return result.data as T
    }
    throw new Error(result.error || 'Unknown error')
  }
  return result as T
}

/**
 * 云端模型配置API接口
 */
export class CloudModelConfigAPI {
  /**
   * 获取所有云端配置
   */
  static async getConfigs(): Promise<CloudModelConfig[]> {
    try {
      logger.debug(LogCategory.RENDERER, '调用API: 获取所有云端配置')
      const result = await electronAPI.cloudModelConfig.getConfigs()
      const configs = unwrapResponse<CloudModelConfig[]>(result)
      // 确保返回的是数组
      return Array.isArray(configs) ? configs : []
    } catch (error) {
      logger.error(LogCategory.RENDERER, '获取云端配置失败:', error)
      // 将错误转发到后端控制台
      logger.error(LogCategory.RENDERER, 'CloudModelConfigAPI.getConfigs error:', error)
      throw error
    }
  }

  /**
   * 获取指定索引的配置
   */
  static async getConfig(index: number): Promise<CloudModelConfig | null> {
    try {
      logger.debug(LogCategory.RENDERER, `调用API: 获取云端配置 index=${index}`)
      const result = await electronAPI.cloudModelConfig.getConfig(index)
      return unwrapResponse<CloudModelConfig | null>(result)
    } catch (error) {
      logger.error(LogCategory.RENDERER, `获取云端配置失败 index=${index}:`, error)
      logger.error(LogCategory.RENDERER, 'CloudModelConfigAPI.getConfig error:', error)
      throw error
    }
  }

  /**
   * 添加新配置
   */
  static async addConfig(config: CloudModelConfig): Promise<void> {
    try {
      logger.info(LogCategory.RENDERER, `调用API: 添加云端配置 provider=${config.provider}`)
      const result = await electronAPI.cloudModelConfig.addConfig(config)
      unwrapResponse<void>(result)
    } catch (error) {
      logger.error(LogCategory.RENDERER, '添加云端配置失败:', error)
      logger.error(LogCategory.RENDERER, 'CloudModelConfigAPI.addConfig error:', error)
      throw error
    }
  }

  /**
   * 更新配置
   */
  static async updateConfig(index: number, config: CloudModelConfig): Promise<void> {
    try {
      logger.info(
        LogCategory.RENDERER,
        `调用API: 更新云端配置 index=${index} provider=${config.provider}`
      )
      const result = await electronAPI.cloudModelConfig.updateConfig(index, config)
      unwrapResponse<void>(result)
    } catch (error) {
      logger.error(LogCategory.RENDERER, `更新云端配置失败 index=${index}:`, error)
      logger.error(LogCategory.RENDERER, 'CloudModelConfigAPI.updateConfig error:', error)
      throw error
    }
  }

  /**
   * 删除配置
   */
  static async deleteConfig(index: number): Promise<void> {
    try {
      logger.info(LogCategory.RENDERER, `调用API: 删除云端配置 index=${index}`)
      const result = await electronAPI.cloudModelConfig.deleteConfig(index)
      unwrapResponse<void>(result)
    } catch (error) {
      logger.error(LogCategory.RENDERER, `删除云端配置失败 index=${index}:`, error)
      logger.error(LogCategory.RENDERER, 'CloudModelConfigAPI.deleteConfig error:', error)
      throw error
    }
  }

  /**
   * 获取当前选中的配置索引
   */
  static async getSelectedIndex(): Promise<number> {
    try {
      logger.debug(LogCategory.RENDERER, '调用API: 获取选中的云端配置索引')
      const result = await electronAPI.cloudModelConfig.getSelectedIndex()
      const index = unwrapResponse<number>(result)
      return index ?? -1
    } catch (error) {
      logger.error(LogCategory.RENDERER, '获取选中配置索引失败:', error)
      logger.error(LogCategory.RENDERER, 'CloudModelConfigAPI.getSelectedIndex error:', error)
      throw error
    }
  }

  /**
   * 设置当前选中的配置索引
   */
  static async setSelectedIndex(index: number): Promise<void> {
    try {
      logger.info(LogCategory.RENDERER, `调用API: 设置选中的云端配置索引 ${index}`)
      const result = await electronAPI.cloudModelConfig.setSelectedIndex(index)
      unwrapResponse<void>(result)
    } catch (error) {
      logger.error(LogCategory.RENDERER, '设置选中配置索引失败:', error)
      logger.error(LogCategory.RENDERER, 'CloudModelConfigAPI.setSelectedIndex error:', error)
      throw error
    }
  }

  /**
   * 测试配置有效性
   */
  static async testConfig(config: CloudModelConfig): Promise<boolean> {
    try {
      logger.info(LogCategory.RENDERER, `调用API: 测试云端配置 provider=${config.provider}`)
      const result = await electronAPI.cloudModelConfig.testConfig(config)
      return unwrapResponse<boolean>(result) ?? false
    } catch (error) {
      logger.error(LogCategory.RENDERER, '测试云端配置失败:', error)
      logger.error(LogCategory.RENDERER, 'CloudModelConfigAPI.testConfig error:', error)
      throw error
    }
  }

  /**
   * 获取指定服务商的模型列表
   */
  static async getProviderModels(
    provider: string,
    apiKey: string,
    baseUrl?: string
  ): Promise<ProviderModel[]> {
    try {
      logger.info(LogCategory.RENDERER, `调用API: 获取${provider}的模型列表`)
      const result = await electronAPI.cloudModelConfig.getProviderModels(provider, apiKey, baseUrl)
      const models = unwrapResponse<ProviderModel[]>(result)
      // 确保返回的是数组
      return Array.isArray(models) ? models : []
    } catch (error) {
      logger.error(LogCategory.RENDERER, `获取${provider}的模型列表失败:`, error)
      logger.error(LogCategory.RENDERER, 'CloudModelConfigAPI.getProviderModels error:', error)
      throw error
    }
  }

  /**
   * 获取云端提供商配置
   */
  static async getCloudProvidersConfig(language: string): Promise<any[]> {
    try {
      logger.info(LogCategory.RENDERER, `调用API: 获取云端提供商配置 language=${language}`)
      const result = await electronAPI.cloudModelConfig.getCloudProvidersConfig(language)
      const presets = unwrapResponse<any[]>(result)
      // 确保返回的是数组
      return Array.isArray(presets) ? presets : []
    } catch (error) {
      logger.error(LogCategory.RENDERER, `获取云端提供商配置失败 language=${language}:`, error)
      logger.error(LogCategory.RENDERER, 'CloudModelConfigAPI.getCloudProvidersConfig error:', error)
      throw error
    }
  }
}

export default CloudModelConfigAPI
