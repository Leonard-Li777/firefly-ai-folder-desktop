/**
 * 云端模型配置相关的IPC处理器
 */

import { ipcMain } from 'electron'
import { logger, LogCategory } from '@yonuc/shared'
import type { CloudModelConfig, ProviderModel } from '@yonuc/types'
import { cloudModelConfigService } from '../ai/cloud-model-config-service'
import { ModelConfigService } from '../analysis/model-config-service'

/**
 * 注册云端模型配置相关的IPC处理器
 */
export function registerCloudModelConfigIPCHandlers(): void {
  logger.info(LogCategory.IPC, '注册云端模型配置IPC处理器...')

  // 获取所有云端配置
  ipcMain.handle('cloud-model-config:get-configs', async () => {
    try {
      logger.debug(LogCategory.IPC, '处理IPC请求: 获取所有云端配置')
      const configs = await cloudModelConfigService.getConfigs()
      return { success: true, data: configs }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(LogCategory.IPC, '获取云端配置失败:', error)
      return { success: false, error: message }
    }
  })

  // 获取指定索引的配置
  ipcMain.handle('cloud-model-config:get-config', async (_, index: number) => {
    try {
      logger.debug(LogCategory.IPC, `处理IPC请求: 获取云端配置 index=${index}`)
      const config = await cloudModelConfigService.getConfig(index)
      return { success: true, data: config }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(LogCategory.IPC, `获取云端配置失败 index=${index}:`, error)
      return { success: false, error: message }
    }
  })

  // 添加新配置
  ipcMain.handle('cloud-model-config:add-config', async (_, config: CloudModelConfig) => {
    try {
      logger.info(LogCategory.IPC, `处理IPC请求: 添加云端配置 provider=${config.provider}`)
      await cloudModelConfigService.addConfig(config)
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(LogCategory.IPC, '添加云端配置失败:', error)
      return { success: false, error: message }
    }
  })

  // 更新配置
  ipcMain.handle('cloud-model-config:update-config', async (_, index: number, config: CloudModelConfig) => {
    try {
      logger.info(LogCategory.IPC, `处理IPC请求: 更新云端配置 index=${index} provider=${config.provider}`)
      await cloudModelConfigService.updateConfig(index, config)
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(LogCategory.IPC, `更新云端配置失败 index=${index}:`, error)
      return { success: false, error: message }
    }
  })

  // 删除配置
  ipcMain.handle('cloud-model-config:delete-config', async (_, index: number) => {
    try {
      logger.info(LogCategory.IPC, `处理IPC请求: 删除云端配置 index=${index}`)
      await cloudModelConfigService.deleteConfig(index)
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(LogCategory.IPC, `删除云端配置失败 index=${index}:`, error)
      return { success: false, error: message }
    }
  })

  // 获取当前选中的配置索引
  ipcMain.handle('cloud-model-config:get-selected-index', async () => {
    try {
      logger.debug(LogCategory.IPC, '处理IPC请求: 获取选中的云端配置索引')
      const index = await cloudModelConfigService.getSelectedIndex()
      return { success: true, data: index }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(LogCategory.IPC, '获取选中配置索引失败:', error)
      return { success: false, error: message }
    }
  })

  // 设置当前选中的配置索引
  ipcMain.handle('cloud-model-config:set-selected-index', async (_, index: number) => {
    try {
      logger.info(LogCategory.IPC, `处理IPC请求: 设置选中的云端配置索引 ${index}`)
      await cloudModelConfigService.setSelectedIndex(index)
      return { success: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(LogCategory.IPC, '设置选中配置索引失败:', error)
      return { success: false, error: message }
    }
  })

  // 测试配置有效性
  ipcMain.handle('cloud-model-config:test-config', async (_, config: CloudModelConfig) => {
    try {
      logger.info(LogCategory.IPC, `处理IPC请求: 测试云端配置 provider=${config.provider}`)
      const result = await cloudModelConfigService.testConfig(config)
      return { success: true, data: result }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(LogCategory.IPC, '测试云端配置失败:', error)
      return { success: false, error: message }
    }
  })

  // 获取指定服务商的模型列表
  ipcMain.handle(
    'cloud-model-config:get-provider-models',
    async (_, provider: string, apiKey: string, baseUrl?: string) => {
      try {
        logger.info(LogCategory.IPC, `处理IPC请求: 获取${provider}的模型列表`)
        const models = await cloudModelConfigService.getProviderModels(provider, apiKey, baseUrl)
        return { success: true, data: models }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        logger.error(LogCategory.IPC, `获取${provider}的模型列表失败:`, error)
        return { success: false, error: message }
      }
    }
  )

  // 获取云端提供商配置路径
  ipcMain.handle('cloud-model-config:get-cloud-providers-config', async (_, language: string) => {
    try {
      logger.debug(LogCategory.IPC, `处理IPC请求: 获取云端提供商配置路径 language=${language}`)
      const configPath = ModelConfigService.getInstance().loadCloudProvidersConfig(language)
      return { success: true, data: configPath }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error(LogCategory.IPC, `获取云端提供商配置路径失败 language=${language}:`, error)
      return { success: false, error: message }
    }
  })

  logger.info(LogCategory.IPC, '云端模型配置IPC处理器注册完成')
}
