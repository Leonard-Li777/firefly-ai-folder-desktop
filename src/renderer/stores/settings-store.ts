import { create } from 'zustand'
import { AppConfig } from '@yonuc/types'
import type { ConfigKey } from '@yonuc/types/config-types'
import {
  SettingsCategory,
  ISettingsCategoryInfo,
  IIgnoreRule,
  ISettingsValidationResult
} from '@yonuc/types'
import { t } from '@app/languages'
import { SUPPORTED_LANGUAGES_KEY } from '@yonuc/shared'
import { captureEvent } from '../lib/posthog'

/**
 * 外部定义防抖器，确保跨重绘和重置的持久性
 */
function debounce<F extends (...args: any[]) => any>(func: F, waitFor: number) {
  let timeout: NodeJS.Timeout
  return (...args: Parameters<F>): Promise<ReturnType<F>> =>
    new Promise(resolve => {
      if (timeout) clearTimeout(timeout)
      timeout = setTimeout(() => resolve(func(...args)), waitFor)
    })
}

// 单例防抖保存器
const debouncedUpdate = debounce(async (newConfig: AppConfig) => {
  try {
    if (window.electronAPI?.updateConfig) {
      await window.electronAPI.updateConfig(newConfig)
      console.log('✅ [Config] 配置已保存到后端')
    }
  } catch (error) {
    console.warn('防抖保存配置失败:', error)
  }
}, 500)

const debouncedIgnoreRulesSave = debounce(async (rules: IIgnoreRule[]) => {
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
 * ConfigKey 到 AppConfig 字段的映射
 */
const configKeyToRendererFieldMap: Record<ConfigKey, keyof AppConfig | null> = {
  APP_NAME: null,
  VERSION: null,
  MACHINE_ID: null,
  DEFAULT_LANGUAGE: 'language',
  LANGUAGE_CONFIRMED: 'languageConfirmed',
  THEME_MODE: 'theme',
  COLOR_SCHEME: null,
  WINDOW_WIDTH: null,
  WINDOW_HEIGHT: null,
  IS_MAXIMIZED: null,
  DEFAULT_VIEW: 'defaultView',
  SHOW_EMPTY_TAGS: 'showEmptyTags',
  FILE_LIST_EXTRA_FIELDS: 'fileListExtraFields',
  SELECTED_MODEL_ID: 'selectedModelId',
  MODEL_CONFIG_URL: 'modelConfigUrl',
  AI_CLOUD_SELECTED_MODEL_ID: 'aiCloudSelectedModelId',
  LOCAL_MODEL_CONFIGS: null,
  UNIT_RECOGNITION_PROMPT: 'unitRecognitionPrompt',
  QUALITY_SCORE_PROMPT: 'qualityScorePrompt',
  TAG_GENERATION_PROMPT: 'tagGenerationPrompt',
  SUPPLEMENTAL_PROMPT: 'supplementalPrompt',
  LATEST_NEWS: 'LATEST_NEWS',
  PAN_DIMENSION_IDS: 'PAN_DIMENSION_IDS',
  HARDWARE_CPU_INFO: null,
  HARDWARE_MEMORY_INFO: null,
  HARDWARE_GPU_INFO: null,
  HARDWARE_STORAGE_INFO: null,
  ENABLE_HARDWARE_MONITORING: null,
  CPU_USAGE_THRESHOLD: null,
  MEMORY_USAGE_THRESHOLD: null,
  GPU_USAGE_THRESHOLD: null,
  HARDWARE_CHECK_INTERVAL: null,
  BATCH_PROCESS_SIZE: null,
  ENABLE_MONITOR: null,
  MAX_FILE_SIZE: null,
  ENABLE_AUTO_ANALYSIS: null,
  AUTO_ANALYSIS_DELAY: null,
  DATABASE_PATH: 'databasePath',
  MODEL_STORAGE_PATH: 'modelPath',
  LOG_PATH: null,
  TEMP_PATH: null,
  LIBREOFFICE_PATH: 'libreOfficePath',
  AI_SERVICE_MODE: 'aiServiceMode',
  AI_CLOUD_PROVIDER: 'aiCloudProvider',
  AI_CLOUD_API_KEY: 'aiCloudApiKey',
  AI_CLOUD_BASE_URL: 'aiCloudBaseUrl',
  AI_CLOUD_API_VERSION: 'aiCloudApiVersion',
  CLOUD_MODEL_CONFIGS: null,
  SELECTED_CLOUD_CONFIG_INDEX: null,
  CONTEXT_SIZE: null,
  MODEL_TEMPERATURE: null,
  MODEL_MAX_TOKENS: null,
  CPU_WARNING_THRESHOLD: null,
  CPU_CRITICAL_THRESHOLD: null,
  MEMORY_WARNING_THRESHOLD: null,
  MEMORY_CRITICAL_THRESHOLD: null,
  FILE_HANDLE_WARNING_THRESHOLD: null,
  FILE_HANDLE_CRITICAL_THRESHOLD: null,
  AI_REQUEST_TIMEOUT: null,
  AI_MAX_RETRIES: null,
  HEALTH_CHECK_INTERVAL: null,
  CONNECTION_IDLE_TIMEOUT: null,
  ERROR_MAX_RETRIES: null,
  ERROR_RETRY_DELAY: null,
  MAX_CONCURRENT_OPERATIONS: null,
  MEMORY_CHECK_INTERVAL: null,
  MEMORY_THRESHOLD: null,
  CHUNK_SIZE: null,
  QUEUE_MAX_CONCURRENCY: null,
  QUEUE_BATCH_SIZE: null,
  IS_FIRST_RUN: 'isFirstRun',
  MIGRATION_COMPLETED: null,
  MIGRATION_COMPLETED_AT: null,
  MIGRATION_VERSION: null,
  MACHINE_REGISTERED: null,
  AI_LOCAL_PORT: null,
  MODEL_LOAD_MAX_RETRIES: null,
  MODEL_LOAD_TIMEOUT: null,
  HEALTH_CHECK_MAX_FAILURES: null,
  SUPPORTED_LANGUAGES: null,
  IGNORE_RULES: null,
  AUDIO_ANALYSIS_DURATION: 'audioAnalysisDuration',
  AI_PLATFORM: 'aiPlatform',
  NEXT_VERSION: null,
  LOCAL_MODEL_CONFIGS_OLLAMA: null,
  IS_PRIVATE_DIRECTORY_UNLOCKED: null,
  INVITATION_CACHE_DATA: null
}

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
  deleteWorkspaceDirectory: (workspaceId: number) => Promise<void>
  resetWorkspaceDirectory: (workspaceId: number) => Promise<void>
  validateSettings: () => ISettingsValidationResult
  getConfigValue: <T = unknown>(key: ConfigKey) => T | undefined
  updateConfigValue: (key: ConfigKey, value: unknown) => Promise<void>
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
}

/**
 * 获取设置分类列表
 */
export const settingsCategories = (): ISettingsCategoryInfo[] => [
  {
    id: SettingsCategory.INTERFACE,
    name: t('界面设置'),
    icon: 'palette',
    description: t('外观、语言和主题')
  },
  {
    id: SettingsCategory.FILE_DISPLAY,
    name: t('显示设置'),
    icon: 'view_list',
    description: t('文件列表显示项')
  },
  {
    id: SettingsCategory.AI_MODEL,
    name: t('AI 模型'),
    icon: 'psychology',
    description: t('本地/云端模型配置')
  },
  {
    id: SettingsCategory.ANALYSIS,
    name: t('分析设置'),
    icon: 'analytics',
    description: t('忽略规则和分析参数')
  },
  {
    id: SettingsCategory.MONITORING,
    name: t('工作区'),
    icon: 'folder_open',
    description: t('目录管理和自动监听')
  }
]

/**
 * 设置管理状态store
 */
export const useSettingsStore = create<ISettingsState>((set, get) => {
  return {
    isOpen: false,
    currentCategory: SettingsCategory.INTERFACE,
    isLoading: false,
    error: null,
    config: {} as AppConfig,
    hasUnsavedChanges: false,
    originalConfig: null,
    ignoreRules: [],
    validationResult: null,

    openSettings: async (category = SettingsCategory.INTERFACE) => {
      try {
        if (window.electronAPI?.getConfig) {
          const latestConfig = await window.electronAPI.getConfig()
          set({
            config: latestConfig,
            originalConfig: { ...latestConfig },
            hasUnsavedChanges: false
          })
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

    closeSettings: () => {
      set({
        isOpen: false,
        error: null,
        validationResult: null
      })
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
        isSystem: false,
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
          const rules = await window.electronAPI.database.getAnalysisIgnoreRules() as unknown as IIgnoreRule[]
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
      try {
        if (window.electronAPI?.saveAnalysisIgnoreRules) {
          await window.electronAPI.saveAnalysisIgnoreRules(state.ignoreRules as any)
        }
      } catch (error) {
        throw error
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
      return rendererField ? (state.config as any)[rendererField] : undefined
    },

    updateConfigValue: async (key, value) => {
      const rendererField = configKeyToRendererFieldMap[key]
      if (rendererField) {
        get().updateConfig({ [rendererField]: value } as Partial<AppConfig>, { internal: true })
      } else {
        set({ config: { ...get().config }, lastConfigUpdate: Date.now() })
      }

      if (window.electronAPI?.updateConfigValue) {
        await window.electronAPI.updateConfigValue(key, value)
      }
    },

    setLoading: loading => set({ isLoading: loading }),
    setError: error => set({ error })
  }
})

if (typeof window !== 'undefined' && window.electronAPI) {
  window.electronAPI.getConfig().then(config => useSettingsStore.getState().updateConfig(config))
  if (window.electronAPI.onConfigChange) {
    window.electronAPI.onConfigChange((newConfig: AppConfig) => {
      const state = useSettingsStore.getState()
      if (JSON.stringify(state.config) !== JSON.stringify(newConfig)) {
        state.updateConfig(newConfig, { internal: true })
      }
    })
  }
  useSettingsStore.getState().loadIgnoreRules()
}
