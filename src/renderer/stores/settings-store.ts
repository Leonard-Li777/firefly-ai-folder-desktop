import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import {
  AppConfig,
  SettingsCategory,
  ISettingsCategoryInfo,
  IIgnoreRule,
  ISettingsValidationResult
} from '@firefly/types'
import {
  debounce as sharedDebounce,
  SUPPORTED_LANGUAGES_KEY,
  CONFIG_KEY_TO_RENDERER_FIELD_MAP
} from '@firefly/shared'
import type { ConfigKey } from '@firefly/types/config-types'
import { t } from '@app/languages'
import { captureEvent } from '../lib/posthog'

// 单例防抖保存器
const debouncedUpdate = sharedDebounce(async (newConfig: AppConfig) => {
  try {
    if (window.electronAPI?.updateConfig) {
      await window.electronAPI.updateConfig(newConfig)
      console.log('✅ [Config] 配置已保存到后端')
    }
  } catch (error) {
    console.warn('防抖保存配置失败:', error)
  }
}, 500)

const debouncedIgnoreRulesSave = sharedDebounce(async (rules: IIgnoreRule[]) => {
  try {
    if (window.electronAPI?.database?.saveAnalysisIgnoreRules) {
      await window.electronAPI.database.saveAnalysisIgnoreRules(rules as any)
      console.log('✅ [IgnoreRules] 规则已同步到后端:', rules.length)
    }
  } catch (error) {
    console.error('防抖同步忽略规则失败:', error)
  }
}, 500)

/**
 * ConfigKey 到 AppConfig 字段的映射 (使用共享包中的统一定义)
 */
const configKeyToRendererFieldMap = CONFIG_KEY_TO_RENDERER_FIELD_MAP as Record<
  ConfigKey,
  keyof AppConfig | null
>

/**
 * 设置管理状态接口
 */
interface ISettingsState {
  isOpen: boolean
  currentCategory: SettingsCategory
  isLoading: boolean
  error: string | null
  config: AppConfig
  lastConfigUpdate?: number
  hasUnsavedChanges: boolean
  originalConfig: AppConfig | null
  ignoreRules: IIgnoreRule[]
  validationResult: ISettingsValidationResult | null
  openSettings: (category?: SettingsCategory) => Promise<void>
  closeSettings: () => void
  setCurrentCategory: (category: SettingsCategory) => void
  updateConfig: (updates: Partial<AppConfig>, options?: { internal?: boolean }) => void
  saveSettings: () => Promise<void>
  cancelSettings: () => void
  addIgnoreRule: (rule: Omit<IIgnoreRule, 'id'>) => void
  updateIgnoreRule: (id: string, updates: Partial<IIgnoreRule>) => void
  removeIgnoreRule: (id: string) => void
  loadIgnoreRules: () => Promise<void>
  saveIgnoreRules: () => Promise<void>
  updateModelList: () => Promise<void>
  isMigrating: boolean
  migrationProgress: string
  setMigrating: (isMigrating: boolean, progress?: string) => void
  deleteWorkspaceDirectory: (workspaceId: number) => Promise<void>
  resetWorkspaceDirectory: (workspaceId: number) => Promise<void>
  validateSettings: () => ISettingsValidationResult
  getConfigValue: <T = unknown>(key: ConfigKey) => T | undefined
  updateConfigValue: (
    key: ConfigKey,
    value: unknown,
    options?: { preventAutoReload?: boolean }
  ) => Promise<void>
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
}

/**
 * 获取设置分类列表
 */
export const settingsCategories = (): ISettingsCategoryInfo[] => [
  {
    id: SettingsCategory.MONITORING,
    name: t('工作区'),
    icon: 'folder_open',
    description: t('目录管理和自动监听')
  },
  {
    id: SettingsCategory.AI_MODEL,
    name: t('模型管理'),
    icon: 'psychology',
    description: t('本地/云端模型配置')
  },
  {
    id: SettingsCategory.AI_ENGINE_CONFIG,
    name: t('AI引擎配置'),
    icon: 'settings_suggest',
    description: t('引擎切换、思考模式')
  },
  {
    id: SettingsCategory.ANALYSIS,
    name: t('分析设置'),
    icon: 'analytics',
    description: t('忽略规则和分析参数')
  },
  {
    id: SettingsCategory.INTERFACE,
    name: t('风格和语言'),
    icon: 'palette',
    description: t('外观、语言和主题')
  },
  {
    id: SettingsCategory.FILE_DISPLAY,
    name: t('列表设置'),
    icon: 'view_list',
    description: t('文件列表显示项')
  }
]

/**
 * 设置管理状态store
 */
export const useSettingsStore = create<ISettingsState>()(
  subscribeWithSelector((set, get) => {
    return {
      isOpen: false,
      currentCategory: SettingsCategory.MONITORING,
      isLoading: false,
      error: null,
      config: {} as AppConfig,
      hasUnsavedChanges: false,
      originalConfig: null,
      ignoreRules: [],
      validationResult: null,
      isMigrating: false,
      migrationProgress: '',

      setMigrating: (isMigrating, progress = '') => {
        set({ isMigrating, migrationProgress: progress })
      },

      openSettings: async (category = SettingsCategory.MONITORING) => {
        try {
          if (window.electronAPI?.getConfig) {
            const latestConfig = await window.electronAPI.getConfig()
            set({
              config: latestConfig,
              originalConfig: { ...latestConfig },
              hasUnsavedChanges: false
            })
          }

          // 核心修正：打开设置页面时挂起 AI 服务配置自动重载
          if (window.electronAPI?.aiService?.setConfigReloadSuspended) {
            await window.electronAPI.aiService.setConfigReloadSuspended(true)
          }
        } catch (error) {
          console.error('加载最新配置失败:', error)
        }
        set({
          isOpen: true,
          currentCategory: category,
          error: null
        })
      },

      closeSettings: async () => {
        set({
          isOpen: false,
          error: null,
          validationResult: null
        })

        // 核心修正：关闭设置页面时恢复 AI 服务配置自动重载
        if (window.electronAPI?.aiService?.setConfigReloadSuspended) {
          try {
            await window.electronAPI.aiService.setConfigReloadSuspended(false)
          } catch (error) {
            console.error('恢复配置重载失败:', error)
          }
        }
      },

      setCurrentCategory: category => {
        set({
          currentCategory: category,
          error: null
        })
      },

      updateConfig: (updates, options) => {
        const state = get()
        const newConfig = { ...state.config, ...updates }
        const hasChanges = state.originalConfig
          ? JSON.stringify(newConfig) !== JSON.stringify(state.originalConfig)
          : true

        set({
          config: newConfig,
          hasUnsavedChanges: hasChanges
        })

        const validation = state.validateSettings()
        set({ validationResult: validation })

        if (!options?.internal) {
          debouncedUpdate(newConfig)
        }
      },

      saveSettings: async () => {
        const state = get()
        try {
          set({ isLoading: true, error: null })
          if (window.electronAPI?.updateConfig) {
            await window.electronAPI.updateConfig(state.config)
            set({
              hasUnsavedChanges: false,
              originalConfig: { ...state.config }
            })
          }
        } catch (error) {
          set({ error: error instanceof Error ? error.message : t('保存设置失败') })
        } finally {
          set({ isLoading: false })
        }
      },

      cancelSettings: () => {
        const state = get()
        if (state.originalConfig) {
          set({
            config: { ...state.originalConfig },
            hasUnsavedChanges: false,
            error: null,
            validationResult: null
          })
        }
      },

      addIgnoreRule: rule => {
        const state = get()
        const newRule: IIgnoreRule = {
          ...rule,
          id: Date.now().toString(),
          isSystem: false
        }

        const newRules = [...state.ignoreRules, newRule]
        set({ ignoreRules: newRules })
        debouncedIgnoreRulesSave(newRules)
      },

      updateIgnoreRule: (id, updates) => {
        const state = get()
        const target = state.ignoreRules.find(r => r.id === id)
        if (target?.isSystem) return

        const newRules = state.ignoreRules.map(rule =>
          rule.id === id ? { ...rule, ...updates, isSystem: false } : rule
        )

        set({ ignoreRules: newRules })
        debouncedIgnoreRulesSave(newRules)
      },

      removeIgnoreRule: id => {
        const state = get()
        const rule = state.ignoreRules.find(r => r.id === id)
        if (rule?.isSystem) return

        const newRules = state.ignoreRules.filter(rule => rule.id !== id)
        set({ ignoreRules: newRules })
        debouncedIgnoreRulesSave(newRules)
      },

      loadIgnoreRules: async () => {
        try {
          set({ isLoading: true })
          if (window.electronAPI?.database?.getAnalysisIgnoreRules) {
            const rules =
              (await window.electronAPI.database.getAnalysisIgnoreRules()) as unknown as IIgnoreRule[]
            set({ ignoreRules: Array.isArray(rules) ? rules : [] })
            return
          }
          set({ ignoreRules: [] })
        } catch (error) {
          console.error('加载忽略规则失败:', error)
          set({ ignoreRules: [] })
        } finally {
          set({ isLoading: false })
        }
      },

      saveIgnoreRules: async () => {
        const state = get()
        if (window.electronAPI?.database?.saveAnalysisIgnoreRules) {
          await window.electronAPI.database.saveAnalysisIgnoreRules(state.ignoreRules as any)
        }
      },

      updateModelList: async () => {
        try {
          set({ isLoading: true })
          const state = get()
          state.updateConfig({ lastModelConfigUrlUpdate: new Date() })
        } finally {
          set({ isLoading: false })
        }
      },

      deleteWorkspaceDirectory: async workspaceId => {
        set({ isLoading: true })
        try {
          if (window.confirm(t('确认删除此工作目录？'))) {
            captureEvent('workspace_directory_deleted', { workspaceId })
          }
        } finally {
          set({ isLoading: false })
        }
      },

      resetWorkspaceDirectory: async workspaceId => {
        set({ isLoading: true })
        try {
          if (window.confirm(t('确认重置此工作目录？'))) {
            captureEvent('workspace_directory_reset', { workspaceId })
          }
        } finally {
          set({ isLoading: false })
        }
      },

      validateSettings: () => {
        const state = get()
        const errors: Array<{ field: string; message: string }> = []
        if (state.config.language && !SUPPORTED_LANGUAGES_KEY.includes(state.config.language)) {
          errors.push({ field: 'language', message: t('不支持的语言设置') })
        }
        return { isValid: errors.length === 0, errors, warnings: [] }
      },

      getConfigValue: key => {
        const state = get()
        const rendererField = configKeyToRendererFieldMap[key]

        // 优先从映射的渲染进程字段取值
        if (rendererField && (state.config as any)[rendererField] !== undefined) {
          return (state.config as any)[rendererField]
        }

        // 如果没有映射或字段不存在，尝试从原始 ConfigKey 取值
        return (state.config as any)[key]
      },

      updateConfigValue: async (key, value, options) => {
        const rendererField = configKeyToRendererFieldMap[key]
        if (rendererField) {
          get().updateConfig({ [rendererField]: value } as Partial<AppConfig>, { internal: true })
        } else {
          set({ config: { ...get().config }, lastConfigUpdate: Date.now() })
        }

        if (typeof window.electronAPI?.updateConfigValue === 'function') {
          await window.electronAPI.updateConfigValue(key, value, options)
        }
      },

      setLoading: loading => set({ isLoading: loading }),
      setError: error => set({ error })
    }
  })
)

if (typeof window !== 'undefined' && window.electronAPI) {
  window.electronAPI
    .getConfig()
    .then(config => useSettingsStore.getState().updateConfig(config, { internal: true }))
  // 移除这里的冗余监听器，已经在 App.tsx 中统一处理
  useSettingsStore.getState().loadIgnoreRules()
}
