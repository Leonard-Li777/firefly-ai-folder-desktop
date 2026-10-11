/**
 * 渲染进程配置存储
 * 通过 IPC 与主进程的 ConfigOrchestrator 同步
 */

import { create } from 'zustand'
import { AppConfig } from '@firefly/types'
import type { ConfigKey } from '@firefly/types/config-types'
import { t } from '@app/languages'
import { useModelStore } from './model-store'

/**
 * 配置状态接口
 */
interface IConfigState {
  /** 当前配置 */
  config: AppConfig | null
  /** 是否正在加载 */
  loading: boolean
  /** 错误信息 */
  error: string | null

  /** 设置配置 */
  setConfig: (config: AppConfig) => void
  /** 更新配置 */
  updateConfig: (updates: Partial<AppConfig>) => Promise<void>
  /** 更新单个配置项 */
  updateConfigValue: (
    key: ConfigKey,
    value: unknown,
    options?: { preventAutoReload?: boolean }
  ) => Promise<void>
  /** 获取配置 */
  getConfig: () => Promise<AppConfig>
  /** 设置加载状态 */
  setLoading: (loading: boolean) => void
  /** 设置错误 */
  setError: (error: string | null) => void
  /** 重置状态 */
  reset: () => void
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: AppConfig = {
  theme: 'auto',
  language: 'zh-CN',
  defaultView: 'grid',
  fileListExtraFields: [],
  // PRD-0044：modelPath 桥接字段随 MODEL_STORAGE_PATH 配置键删除
  isFirstRun: false,
  isPrivateDirectoryUnlocked: false
}

/**
 * 配置状态管理store
 */
export const useConfigStore = create<IConfigState>()((set, get) => ({
  config: null,
  loading: false,
  error: null,

  setConfig: (config: AppConfig) => {
    set({ config, error: null })
  },

  updateConfig: async (updates: Partial<AppConfig>) => {
    try {
      set({ loading: true, error: null })

      if (typeof window !== 'undefined' && window.electronAPI) {
        await window.electronAPI.updateConfig(updates)

        // 更新本地状态
        const currentConfig = get().config || DEFAULT_CONFIG
        const newConfig = { ...currentConfig, ...updates }
        set({ config: newConfig })
      }
    } catch (error) {
      console.error('[ConfigStore] 更新配置失败:', error)
      set({ error: error instanceof Error ? error.message : t('更新配置失败') })
    } finally {
      set({ loading: false })
    }
  },

  updateConfigValue: async (
    key: ConfigKey,
    value: unknown,
    options?: { preventAutoReload?: boolean }
  ) => {
    try {
      set({ loading: true, error: null })

      if (typeof window !== 'undefined' && window.electronAPI) {
        await window.electronAPI.updateConfigValue(key, value, options)

        // 更新本地状态
        const currentConfig = get().config || DEFAULT_CONFIG
        const newConfig = { ...currentConfig, [key]: value }
        set({ config: newConfig })
      }
    } catch (error) {
      console.error('[ConfigStore] 更新配置项失败:', error)
      set({ error: error instanceof Error ? error.message : t('更新配置项失败') })
    } finally {
      set({ loading: false })
    }
  },

  getConfig: async () => {
    try {
      set({ loading: true, error: null })

      if (typeof window !== 'undefined' && window.electronAPI) {
        const config = await window.electronAPI.getConfig()
        set({ config })
        return config
      }

      return DEFAULT_CONFIG
    } catch (error) {
      console.error('[ConfigStore] 获取配置失败:', error)
      set({ error: error instanceof Error ? error.message : t('获取配置失败') })
      return DEFAULT_CONFIG
    } finally {
      set({ loading: false })
    }
  },

  setLoading: (loading: boolean) => set({ loading }),

  setError: (error: string | null) => set({ error }),

  reset: () => set({ config: null, loading: false, error: null })
}))

// 初始化配置监听
if (typeof window !== 'undefined' && window.electronAPI) {
  // 监听来自主进程的配置变更
  window.electronAPI.onConfigChange(config => {
    useConfigStore.getState().setConfig(config)

    // 同步 AI_SERVICE_MODE 到 model-store，确保 Footer 能正确显示模式前缀
    // 解决：设置页面挂起重载期间切换模式，model-store 收不到 ai-model-status-changed 广播的问题
    const aiServiceMode = (config as any)?.AI_SERVICE_MODE
    if (aiServiceMode === 'local' || aiServiceMode === 'cloud') {
      useModelStore.getState().setModelMode(aiServiceMode)
    }
  })

  // 初始化时获取配置
  useConfigStore.getState().getConfig().catch(console.error)
}

/**
 * 欢迎向导状态接口
 *
 * PRD-0044：向导已收敛为「语言选择」单步，原模型模式选择与多步跳转能力
 * （modelMode / setModelMode / nextStep / previousStep / goToStep / goToModelSelection）
 * 随「模型目录合法检测」步骤一并清退，此处仅保留完成设置与首次运行标记。
 */
interface IWelcomeState {
  /** 是否为首次运行 */
  isFirstRun: boolean
  /** 是否正在加载 */
  loading: boolean

  /** 完成设置 */
  completeSetup: () => void
  /** 设置首次运行状态 */
  setIsFirstRun: (isFirstRun: boolean) => void
  /** 重置向导 */
  reset: () => void
}

/**
 * 欢迎向导状态管理store
 */
export const useWelcomeStore = create<IWelcomeState>()(set => ({
  isFirstRun: false,
  loading: false,

  completeSetup: async () => {
    try {
      set({ loading: true })

      // 更新配置，标记为非首次运行，并确保语言已确认
      // 使用 preventAutoReload: true 防止在设置过程中触发 AI 服务的自动加载
      if (typeof window !== 'undefined' && window.electronAPI) {
        await window.electronAPI.updateConfigValue('LANGUAGE_CONFIRMED', true, {
          preventAutoReload: true
        })
        await window.electronAPI.updateConfigValue('IS_FIRST_RUN', false, {
          preventAutoReload: true
        })
      }

      set({ isFirstRun: false })

      console.log('[WelcomeStore] 设置完成，标记为非首次运行')
    } catch (error) {
      console.error('[WelcomeStore] 完成设置失败:', error)
    } finally {
      set({ loading: false })
    }
  },

  setIsFirstRun: (isFirstRun: boolean) => {
    console.warn(`[WelcomeStore] setIsFirstRun 被调用, 值: ${isFirstRun}`)
    set({ isFirstRun })
  },

  reset: () => {
    console.warn('[WelcomeStore] reset 被调用')
    set({
      isFirstRun: false,
      loading: false
    })
  }
}))

// 导出便捷的 getter 函数
export const getCurrentConfig = () => useConfigStore.getState().config
export const isConfigLoading = () => useConfigStore.getState().loading
export const getConfigError = () => useConfigStore.getState().error
