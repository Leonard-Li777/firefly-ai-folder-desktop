/**
 * 云端模型配置状态管理Store
 * 管理云端模型配置的状态和操作
 */

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { logger, LogCategory } from '@yonuc/shared'
import type { CloudModelConfig, ProviderModel } from '@yonuc/types'

/**
 * 云端模型配置状态接口
 */
export interface ICloudModelConfigState {
  // 配置列表
  configs: CloudModelConfig[]
  // 当前选中的配置索引
  selectedIndex: number
  // 加载状态
  isLoading: boolean
  // 错误信息
  error: string | null
  // 当前正在测试连接的配置
  testingConfigIndex: number | null
  // 当前正在获取模型列表的provider
  fetchingModelsProvider: string | null
  // 缓存的模型列表
  cachedModels: Map<string, ProviderModel[]>
}

/**
 * 云端模型配置操作接口
 */
export interface ICloudModelConfigActions {
  // 设置配置列表
  setConfigs: (configs: CloudModelConfig[]) => void
  // 添加配置
  addConfig: (config: CloudModelConfig) => void
  // 更新配置
  updateConfig: (index: number, config: CloudModelConfig) => void
  // 删除配置
  deleteConfig: (index: number) => void
  // 设置选中的配置
  setSelectedIndex: (index: number) => void
  // 获取当前选中的配置
  getSelectedConfig: () => CloudModelConfig | null
  // 设置错误
  setError: (error: string | null) => void
  // 清除错误
  clearError: () => void
  // 设置测试状态
  setTestingIndex: (index: number | null) => void
  // 设置获取模型列表状态
  setFetchingModelsProvider: (provider: string | null) => void
  // 更新缓存的模型列表
  setCachedModels: (provider: string, models: ProviderModel[]) => void
  // 获取缓存的模型列表
  getCachedModels: (provider: string) => ProviderModel[]
  // 重置状态
  reset: () => void
}

/**
 * 云端模型配置Store类型
 */
export type TCloudModelConfigStore = ICloudModelConfigState & ICloudModelConfigActions

/**
 * 创建云端模型配置Store
 */
export const useCloudModelConfigStore = create<TCloudModelConfigStore>()(
  subscribeWithSelector((set, get) => ({
    // 初始状态
    configs: [],
    selectedIndex: -1,
    isLoading: false,
    error: null,
    testingConfigIndex: null,
    fetchingModelsProvider: null,
    cachedModels: new Map(),

    // 操作
    setConfigs: (configs: CloudModelConfig[]) => {
      logger.debug(LogCategory.RENDERER, `设置云端配置列表: ${configs.length}个配置`)
      set({ configs })
    },

    addConfig: (config: CloudModelConfig) => {
      const state = get()
      const newConfigs = [...state.configs, config]
      logger.info(LogCategory.RENDERER, `添加云端配置: provider=${config.provider}`)
      set({ configs: newConfigs })
    },

    updateConfig: (index: number, config: CloudModelConfig) => {
      const state = get()
      if (index < 0 || index >= state.configs.length) {
        logger.warn(LogCategory.RENDERER, `更新配置失败: 索引${index}超出范围`)
        return
      }
      const newConfigs = [...state.configs]
      newConfigs[index] = config
      logger.info(LogCategory.RENDERER, `更新云端配置: index=${index}, provider=${config.provider}`)
      set({ configs: newConfigs })
    },

    deleteConfig: (index: number) => {
      const state = get()
      if (index < 0 || index >= state.configs.length) {
        logger.warn(LogCategory.RENDERER, `删除配置失败: 索引${index}超出范围`)
        return
      }
      const newConfigs = [...state.configs]
      const deletedProvider = newConfigs[index].provider
      newConfigs.splice(index, 1)
      
      logger.info(LogCategory.RENDERER, `删除云端配置: index=${index}, provider=${deletedProvider}`)
      
      // 如果删除的是选中的配置，重置选中索引
      let newSelectedIndex = state.selectedIndex
      if (state.selectedIndex === index) {
        newSelectedIndex = newConfigs.length > 0 ? 0 : -1
      } else if (state.selectedIndex > index) {
        newSelectedIndex = state.selectedIndex - 1
      }
      
      set({ configs: newConfigs, selectedIndex: newSelectedIndex })
    },

    setSelectedIndex: (index: number) => {
      const state = get()
      if (index !== -1 && (index < 0 || index >= state.configs.length)) {
        logger.warn(LogCategory.RENDERER, `设置选中配置失败: 索引${index}超出范围`)
        return
      }
      logger.debug(LogCategory.RENDERER, `设置选中的云端配置: ${index}`)
      set({ selectedIndex: index })
    },

    getSelectedConfig: () => {
      const state = get()
      if (state.selectedIndex >= 0 && state.selectedIndex < state.configs.length) {
        return state.configs[state.selectedIndex]
      }
      return null
    },

    setError: (error: string | null) => {
      if (error) {
        logger.warn(LogCategory.RENDERER, `云端配置错误: ${error}`)
      }
      set({ error })
    },

    clearError: () => {
      set({ error: null })
    },

    setTestingIndex: (index: number | null) => {
      logger.debug(LogCategory.RENDERER, `设置测试配置: ${index}`)
      set({ testingConfigIndex: index })
    },

    setFetchingModelsProvider: (provider: string | null) => {
      if (provider) {
        logger.debug(LogCategory.RENDERER, `正在获取${provider}的模型列表`)
      }
      set({ fetchingModelsProvider: provider })
    },

    setCachedModels: (provider: string, models: ProviderModel[]) => {
      const state = get()
      const newCachedModels = new Map(state.cachedModels)
      newCachedModels.set(provider, models)
      logger.debug(LogCategory.RENDERER, `缓存${provider}的模型列表: ${models.length}个模型`)
      set({ cachedModels: newCachedModels })
    },

    getCachedModels: (provider: string) => {
      const state = get()
      return state.cachedModels.get(provider) || []
    },

    reset: () => {
      logger.info(LogCategory.RENDERER, '重置云端模型配置状态')
      set({
        configs: [],
        selectedIndex: -1,
        isLoading: false,
        error: null,
        testingConfigIndex: null,
        fetchingModelsProvider: null,
        cachedModels: new Map(),
      })
    },
  }))
)
