/**
 * 渲染进程配置存储
 * 通过 IPC 与主进程的 ConfigOrchestrator 同步
 */

import { create } from 'zustand'
import { AppConfig } from '@yonuc/types'
import type { ConfigKey } from '@yonuc/types/config-types'
import { t } from '@app/languages'

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
  updateConfigValue: (key: ConfigKey, value: unknown, options?: { preventAutoReload?: boolean }) => Promise<void>
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
  modelPath: undefined,
  isFirstRun: true,
  isPrivateDirectoryUnlocked: false,
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
  
  updateConfigValue: async (key: ConfigKey, value: unknown, options?: { preventAutoReload?: boolean }) => {
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
  
  reset: () => set({ config: null, loading: false, error: null }),
}))

// 初始化配置监听
if (typeof window !== 'undefined' && window.electronAPI) {
  // 监听来自主进程的配置变更
  window.electronAPI.onConfigChange((config) => {
    console.log('[ConfigStore] 收到配置变更:', config)
    useConfigStore.getState().setConfig(config)
  })
  
  // 初始化时获取配置
  useConfigStore.getState().getConfig().catch(console.error)
}

/**
 * 欢迎向导状态接口
 */
interface IWelcomeState {
  /** 当前步骤 */
  currentStep: number
  /** 是否为首次运行 */
  isFirstRun: boolean
  /** 是否正在加载 */
  loading: boolean
  /** 模型模式: 本地或云端 */
  modelMode: 'local' | 'cloud'
  
  /** 下一步 */
  nextStep: () => void
  /** 上一步 */
  previousStep: () => void
  /** 跳转到指定步骤 */
  goToStep: (step: number) => void
  /** 设置模型模式 */
  setModelMode: (mode: 'local' | 'cloud') => void
  /** 完成设置 */
  completeSetup: () => void
  /** 设置首次运行状态 */
  setIsFirstRun: (isFirstRun: boolean) => void
  /** 直接进入模型选择步骤（跳过语言选择） */
  goToModelSelection: () => void
  /** 重置向导 */
  reset: () => void
}

/**
 * 欢迎向导状态管理store
 */
export const useWelcomeStore = create<IWelcomeState>()((set, get) => ({
  currentStep: 1,
  isFirstRun: true,
  loading: false,
  modelMode: 'local',
  
  nextStep: () => {
    const { currentStep, modelMode } = get()
    
    // 如果是云端模式，在第三步（配置完成）后直接跳转到最后一步（第6步）
    if (modelMode === 'cloud' && currentStep === 3) {
      set({ currentStep: 6 })
      return
    }
    
    if (currentStep < 6) {
      set({ currentStep: currentStep + 1 })
    }
  },
  
  previousStep: () => {
    const { currentStep, modelMode } = get()
    
    // 如果是云端模式，从最后一步返回时跳转到第三步
    if (modelMode === 'cloud' && currentStep === 6) {
      set({ currentStep: 3 })
      return
    }
    
    if (currentStep > 1) {
      set({ currentStep: currentStep - 1 })
    }
  },
  
  goToStep: (step: number) => {
    if (step >= 1 && step <= 6) {
      set({ currentStep: step })
    }
  },

  setModelMode: (mode: 'local' | 'cloud') => {
    set({ modelMode: mode })
  },
  
  completeSetup: async () => {
    try {
      set({ loading: true })
      
      // 更新配置，标记为非首次运行，并确保语言已确认
      // 使用 preventAutoReload: true 防止在设置过程中触发 AI 服务的自动加载
      if (typeof window !== 'undefined' && window.electronAPI) {
        await window.electronAPI.updateConfigValue('LANGUAGE_CONFIRMED', true, { preventAutoReload: true })
        await window.electronAPI.updateConfigValue('IS_FIRST_RUN', false, { preventAutoReload: true })
      }
      
      set({ 
        isFirstRun: false
        // 不在这里重置 currentStep，由 App.tsx 判定阶段并跳转
      })
      
      console.log('[WelcomeStore] 设置完成，标记为非首次运行')
    } catch (error) {
      console.error('[WelcomeStore] 完成设置失败:', error)
    } finally {
      set({ loading: false })
    }
  },
  
  setIsFirstRun: (isFirstRun: boolean) => {
    set({ isFirstRun })
  },
  
  goToModelSelection: () => {
    set({ currentStep: 2 })
  },
  
  reset: () => {
    set({ 
      currentStep: 1, 
      isFirstRun: true, 
      loading: false,
      modelMode: 'local'
    })
  },
}))

// 导出便捷的 getter 函数
export const getCurrentConfig = () => useConfigStore.getState().config
export const isConfigLoading = () => useConfigStore.getState().loading
export const getConfigError = () => useConfigStore.getState().error
