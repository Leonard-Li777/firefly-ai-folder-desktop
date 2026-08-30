import { t } from '@app/languages'
/**
 * AI服务状态管理Store
 * 基于设计文档实现完整的AI服务状态管理和通知系统
 */

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { ErrorNormalizer, LogCategory, logger } from '@firefly/shared'
import {
  AICapabilities,
  AIErrorType,
  AIServiceError,
  AIServiceStatus,
  ExtendedAIServiceConfig,
  StartupPhase
} from '@firefly/types'

/**
 * 模块级模型切换标志，完全独立于 zustand 状态管理。
 * 在模型切换开始时设置为 true，在切换完成（收到 IDLE/ERROR）后设置为 false。
 * 用于 onModelStatusChanged 监听器中过滤切换过程中的过渡性 STOPPED 状态，
 * 避免 zustand get() 的时序问题（如 set 批处理、React 严格模式等）导致守卫失效。
 */
let __isModelSwitching = false

/**
 * 返回当前是否正在切换模型（基于模块级标志，不受 zustand 时序影响）
 */
export const isModelSwitchingActive = (): boolean => __isModelSwitching

/**
 * AI服务状态接口（基于设计文档）
 */
export interface IAIServiceState {
  /** AI服务状态 */
  status: AIServiceStatus
  /** 当前配置 */
  currentConfig: ExtendedAIServiceConfig | null
  /** AI能力信息 */
  capabilities: AICapabilities | null
  /** 错误信息 */
  error: AIServiceError | null
  /** 当前启动阶段 */
  currentPhase: StartupPhase
  /** 当前选中的模型ID */
  selectedModelId?: string
  /** 模型切换状态 */
  isModelSwitching: boolean
  /** 是否正在切换 GPU 驱动模式（兼容模式/高性能模式） */
  isGpuSwitching: boolean
  /** 错误详情对话框是否显示（由用户手动点击错误提示打开） */
  isErrorDialogOpen: boolean
  /** 最后的模型切换错误 */
  lastModelSwitchError?: string
  /** 初始化尝试次数 */
  initializationAttempts: number
  /** 最后活动时间 */
  lastActivity: Date | null
}

/**
 * AI服务操作接口（基于设计文档）
 */
export interface IAIServiceActions {
  /** 初始化AI服务 */
  initializeAIService: (options?: { forceDeploy?: boolean; onlyDeploy?: boolean }) => Promise<void>
  /** 以 CPU 模式初始化AI服务 */
  initializeAIServiceWithCpu: () => Promise<void>
  /** 以兼容模式（Vulkan）初始化AI服务 */
  initializeAIServiceWithVulkan: () => Promise<void>
  /** 通知模型切换 */
  notifyModelChanged: (modelId: string) => Promise<void>
  /** 更新状态 */
  updateStatus: (status: AIServiceStatus) => void
  /** 设置错误 */
  setError: (error: AIServiceError) => void
  /** 清除错误 */
  clearError: () => void
  /** 打开错误详情弹窗 */
  openErrorDialog: () => void
  /** 关闭错误详情弹窗 */
  closeErrorDialog: () => void
  /** 设置阶段 */
  setPhase: (phase: StartupPhase) => void
  /** 设置配置 */
  setConfig: (config: ExtendedAIServiceConfig | null) => void
  /** 设置能力 */
  setCapabilities: (capabilities: AICapabilities | null) => void
  /** 三阶段启动流程控制 */
  enterConfigurationPhase: () => void
  /** 进入初始化阶段 */
  enterInitializationPhase: () => Promise<void>
  /** 进入运行时阶段 */
  enterRuntimePhase: () => void
  /** 重置所有状态 */
  resetState: () => void
  /** 更新最后活动时间 */
  updateLastActivity: () => void
  /** 设置 GPU 驱动切换状态 */
  setIsGpuSwitching: (switching: boolean) => void
}

/**
 * AI服务Store类型
 */
export type TAIServiceStore = IAIServiceState & IAIServiceActions

/**
 * 运行时信息接口
 */
interface IRuntimeInfo {
  status: AIServiceStatus
  currentPhase: StartupPhase
  lastActivity: Date | null
  initializationAttempts: number
  hasError: boolean
  isRunning: boolean
}

/**
 * 运行时状态接口
 */
interface IRuntimeState {
  status: AIServiceStatus
  currentPhase: StartupPhase
  lastActivity: Date | null
  initializationAttempts: number
}

/**
 * AI服务Store（基于设计文档实现）
 */
export const useAIServiceStore = create<TAIServiceStore>()(
  subscribeWithSelector((set, get) => ({
    // 初始状态
    status: AIServiceStatus.UNINITIALIZED,
    currentConfig: null,
    capabilities: null,
    error: null,
    currentPhase: StartupPhase.CONFIGURATION,
    selectedModelId: undefined,
    isModelSwitching: false,
    isGpuSwitching: false,
    isErrorDialogOpen: false,
    lastModelSwitchError: undefined,
    initializationAttempts: 0,
    lastActivity: null,

    // 操作方法
    initializeAIService: async (options?: { forceDeploy?: boolean; onlyDeploy?: boolean }) => {
      const state = get()

      // 如果已经在运行或正在初始化，跳过
      if (
        state.status === AIServiceStatus.IDLE ||
        state.status === AIServiceStatus.PROCESSING ||
        state.status === AIServiceStatus.INITIALIZING
      ) {
        logger.debug(LogCategory.AI_SERVICE, '[AIServiceStore] AI服务已运行或正在初始化，跳过')
        return
      }

      const api = window.electronAPI?.aiService
      if (!api?.initialize) {
        const errorMessage = t('electronAPI.aiService.initialize 不可用')
        logger.error(LogCategory.AI_SERVICE, '[AIServiceStore] 初始化AI服务失败:', errorMessage)
        set({
          status: AIServiceStatus.ERROR,
          error: ErrorNormalizer.normalize(
            errorMessage,
            AIErrorType.SERVER_START_FAILED,
            'AIServiceStore'
          ),
          lastActivity: new Date()
        })
        return
      }

      const toAIServiceStatus = (raw: unknown): AIServiceStatus => {
        if (
          typeof raw === 'string' &&
          (Object.values(AIServiceStatus) as unknown[]).includes(raw)
        ) {
          return raw as AIServiceStatus
        }
        return AIServiceStatus.IDLE
      }

      const toStartupPhase = (raw: unknown): StartupPhase => {
        if (typeof raw === 'string' && (Object.values(StartupPhase) as unknown[]).includes(raw)) {
          return raw as StartupPhase
        }
        return StartupPhase.CONFIGURATION
      }

      try {
        set(s => ({
          status: AIServiceStatus.INITIALIZING,
          initializationAttempts: s.initializationAttempts + 1,
          error: null,
          lastActivity: new Date()
        }))

        logger.info(LogCategory.AI_SERVICE, '[AIServiceStore] 开始初始化AI服务...')

        const initResult = await api.initialize(options as any)
        if (!initResult?.success) {
          throw new Error(initResult?.message || t('AI服务初始化失败'))
        }

        const [statusRaw, phaseRaw, capabilitiesRaw] = await Promise.all([
          (api as any).getStatus?.(),
          (api as any).getCurrentPhase?.(),
          (api as any).getCapabilities?.()
        ])

        const status = toAIServiceStatus(statusRaw)
        const currentPhase = toStartupPhase(phaseRaw)
        const capabilities = (capabilitiesRaw as AICapabilities | null) ?? null

        set({
          status,
          currentPhase,
          capabilities,
          lastActivity: new Date()
        })

        logger.info(LogCategory.AI_SERVICE, '[AIServiceStore] AI服务初始化成功', {
          status,
          currentPhase,
          modelName: capabilities?.modelName
        })
      } catch (error) {
        const errorMessage = t('未知错误')
        logger.error(LogCategory.AI_SERVICE, '[AIServiceStore] AI服务初始化失败:', errorMessage)

        set({
          status: AIServiceStatus.ERROR,
          error: ErrorNormalizer.normalize(
            error,
            undefined,
            'AIServiceStore'
          ),
          lastActivity: new Date()
        })

        throw error
      }
    },
    initializeAIServiceWithVulkan: async () => {
      const state = get()

      // 如果正在初始化，跳过（允许从错误状态重试）
      if (state.status === AIServiceStatus.INITIALIZING) {
        logger.debug(
          LogCategory.AI_SERVICE,
          '[AIServiceStore] AI服务正在初始化，跳过兼容模式初始化请求'
        )
        return
      }

      const api = window.electronAPI?.aiService
      if (!api?.initialize) {
        const errorMessage = t('electronAPI.aiService.initialize 不可用')
        logger.error(LogCategory.AI_SERVICE, '[AIServiceStore] 兼容模式初始化失败:', errorMessage)
        set({
          status: AIServiceStatus.ERROR,
          error: ErrorNormalizer.normalize(
            errorMessage,
            AIErrorType.SERVER_START_FAILED,
            'AIServiceStore'
          ),
          lastActivity: new Date()
        })
        return
      }

      const toAIServiceStatus = (raw: unknown): AIServiceStatus => {
        if (
          typeof raw === 'string' &&
          (Object.values(AIServiceStatus) as unknown[]).includes(raw)
        ) {
          return raw as AIServiceStatus
        }
        return AIServiceStatus.IDLE
      }

      const toStartupPhase = (raw: unknown): StartupPhase => {
        if (typeof raw === 'string' && (Object.values(StartupPhase) as unknown[]).includes(raw)) {
          return raw as StartupPhase
        }
        return StartupPhase.CONFIGURATION
      }

      try {
        set(s => ({
          status: AIServiceStatus.INITIALIZING,
          initializationAttempts: s.initializationAttempts + 1,
          error: null,
          lastActivity: new Date()
        }))

        logger.info(
          LogCategory.AI_SERVICE,
          '[AIServiceStore] 开始以兼容模式（Vulkan）初始化AI服务...'
        )

        // 保存驱动兼容模式到配置
        try {
          await window.electronAPI?.updateConfigValue('AI_ENGINE_DRIVER_COMPATIBLE_MODE', true)
          await window.electronAPI?.updateConfigValue('AI_ENGINE_FORCE_CPU_MODE', false)
        } catch (e) {
          logger.warn(LogCategory.AI_SERVICE, '[AIServiceStore] 保存兼容模式配置失败:', e)
        }

        const initResult = await api.initialize()
        if (!initResult?.success) {
          throw new Error(initResult?.message || t('AI服务初始化失败'))
        }

        const [statusRaw, phaseRaw, capabilitiesRaw] = await Promise.all([
          (api as any).getStatus?.(),
          (api as any).getCurrentPhase?.(),
          (api as any).getCapabilities?.()
        ])

        const status = toAIServiceStatus(statusRaw)
        const currentPhase = toStartupPhase(phaseRaw)
        const capabilities = (capabilitiesRaw as AICapabilities | null) ?? null

        set({
          status,
          currentPhase,
          capabilities,
          lastActivity: new Date()
        })

        logger.info(LogCategory.AI_SERVICE, '[AIServiceStore] 兼容模式 AI 服务初始化成功', {
          status,
          currentPhase,
          modelName: capabilities?.modelName
        })
      } catch (error) {
        const errorMessage = t('未知错误')
        logger.error(
          LogCategory.AI_SERVICE,
          '[AIServiceStore] 兼容模式 AI 服务初始化失败:',
          errorMessage
        )

        set({
          status: AIServiceStatus.ERROR,
          error: ErrorNormalizer.normalize(
            error,
            undefined,
            'AIServiceStore'
          ),
          lastActivity: new Date()
        })

        throw error
      }
    },
    initializeAIServiceWithCpu: async () => {
      const state = get()

      // 如果正在初始化，跳过（允许从错误状态重试）
      if (state.status === AIServiceStatus.INITIALIZING) {
        logger.debug(
          LogCategory.AI_SERVICE,
          '[AIServiceStore] AI服务正在初始化，跳过 CPU 模式初始化请求'
        )
        return
      }

      const api = window.electronAPI?.aiService
      if (!api?.initialize) {
        const errorMessage = t('electronAPI.aiService.initialize 不可用')
        logger.error(LogCategory.AI_SERVICE, '[AIServiceStore] CPU 模式初始化失败:', errorMessage)
        set({
          status: AIServiceStatus.ERROR,
          error: ErrorNormalizer.normalize(
            errorMessage,
            AIErrorType.SERVER_START_FAILED,
            'AIServiceStore'
          ),
          lastActivity: new Date()
        })
        return
      }

      const toAIServiceStatus = (raw: unknown): AIServiceStatus => {
        if (
          typeof raw === 'string' &&
          (Object.values(AIServiceStatus) as unknown[]).includes(raw)
        ) {
          return raw as AIServiceStatus
        }
        return AIServiceStatus.IDLE
      }

      const toStartupPhase = (raw: unknown): StartupPhase => {
        if (typeof raw === 'string' && (Object.values(StartupPhase) as unknown[]).includes(raw)) {
          return raw as StartupPhase
        }
        return StartupPhase.CONFIGURATION
      }

      try {
        set(s => ({
          status: AIServiceStatus.INITIALIZING,
          initializationAttempts: s.initializationAttempts + 1,
          error: null,
          lastActivity: new Date()
        }))

        logger.info(LogCategory.AI_SERVICE, '[AIServiceStore] 开始以 CPU 模式初始化AI服务...')

        // 保存强制CPU模式到配置（后端适配器会直接从 ConfigOrchestrator 读取）
        try {
          await window.electronAPI?.updateConfigValue('AI_ENGINE_FORCE_CPU_MODE', true)
          // 自动切换到内置模型（CPU 模式较慢，需要小模型）
          const builtinId = await window.electronAPI?.getBuiltinModelId?.()
          if (builtinId) {
            await window.electronAPI?.updateConfigValue('SELECTED_MODEL_ID', builtinId)
          }
        } catch (e) {
          logger.warn(LogCategory.AI_SERVICE, '[AIServiceStore] 保存 CPU 模式配置失败:', e)
        }

        const initResult = await api.initialize()
        if (!initResult?.success) {
          throw new Error(initResult?.message || t('AI服务初始化失败'))
        }

        const [statusRaw, phaseRaw, capabilitiesRaw] = await Promise.all([
          (api as any).getStatus?.(),
          (api as any).getCurrentPhase?.(),
          (api as any).getCapabilities?.()
        ])

        const status = toAIServiceStatus(statusRaw)
        const currentPhase = toStartupPhase(phaseRaw)
        const capabilities = (capabilitiesRaw as AICapabilities | null) ?? null

        set({
          status,
          currentPhase,
          capabilities,
          lastActivity: new Date()
        })

        logger.info(LogCategory.AI_SERVICE, '[AIServiceStore] CPU 模式 AI 服务初始化成功', {
          status,
          currentPhase,
          modelName: capabilities?.modelName
        })
      } catch (error) {
        const errorMessage = t('未知错误')
        logger.error(
          LogCategory.AI_SERVICE,
          '[AIServiceStore] CPU 模式 AI 服务初始化失败:',
          errorMessage
        )

        set({
          status: AIServiceStatus.ERROR,
          error: ErrorNormalizer.normalize(
            error,
            undefined,
            'AIServiceStore'
          ),
          lastActivity: new Date()
        })

        throw error
      }
    },

    notifyModelChanged: async (modelId: string) => {
      const state = get()

      if (state.isModelSwitching) {
        logger.warn(LogCategory.AI_SERVICE, '[AIServiceStore] 模型切换正在进行中，跳过新的切换请求')
        return
      }

      const api = window.electronAPI?.aiService
      if (!api?.onModelChanged) {
        const errorMessage = t('electronAPI.aiService.onModelChanged 不可用')
        logger.error(LogCategory.AI_SERVICE, '[AIServiceStore] 模型切换失败:', errorMessage)
        set({
          status: AIServiceStatus.ERROR,
          error: ErrorNormalizer.normalize(
            errorMessage,
            AIErrorType.MODEL_SWITCH_FAILED,
            'AIServiceStore'
          ),
          lastActivity: new Date()
        })
        return
      }

      const toAIServiceStatus = (raw: unknown): AIServiceStatus => {
        if (
          typeof raw === 'string' &&
          (Object.values(AIServiceStatus) as unknown[]).includes(raw)
        ) {
          return raw as AIServiceStatus
        }
        return AIServiceStatus.IDLE
      }

      const toStartupPhase = (raw: unknown): StartupPhase => {
        if (typeof raw === 'string' && (Object.values(StartupPhase) as unknown[]).includes(raw)) {
          return raw as StartupPhase
        }
        return StartupPhase.CONFIGURATION
      }

      try {
        __isModelSwitching = true
        set({
          isModelSwitching: true,
          selectedModelId: modelId,
          lastModelSwitchError: undefined,
          status: AIServiceStatus.RESTARTING,
          lastActivity: new Date()
        })

        // 安全超时：30秒后若 __isModelSwitching 仍为 true 则强制清除，防止卡死
        const safetyTimer = setTimeout(() => {
          if (__isModelSwitching) {
            logger.warn(
              LogCategory.AI_SERVICE,
              '[AIServiceStore] 模型切换超时(30s)，强制清除切换标志'
            )
            __isModelSwitching = false
            set({ isModelSwitching: false })
          }
        }, 30_000)

        logger.info(LogCategory.AI_SERVICE, `[AIServiceStore] 通知模型切换: ${modelId}`)

        const result = await api.onModelChanged(modelId)
        if (!result?.success) {
          throw new Error(result?.message || t('模型切换失败'))
        }

        const [statusRaw, phaseRaw, capabilitiesRaw] = await Promise.all([
          (api as any).getStatus?.(),
          (api as any).getCurrentPhase?.(),
          (api as any).getCapabilities?.()
        ])

        const status = toAIServiceStatus(statusRaw)
        const currentPhase = toStartupPhase(phaseRaw)
        const capabilities = (capabilitiesRaw as AICapabilities | null) ?? null

        set({
          status,
          currentPhase,
          capabilities,
          lastActivity: new Date()
        })

        logger.info(LogCategory.AI_SERVICE, `[AIServiceStore] 模型切换成功: ${modelId}`, {
          status,
          currentPhase,
          modelName: capabilities?.modelName
        })

        clearTimeout(safetyTimer)
      } catch (error) {
        const errorMessage = t('未知错误')
        logger.error(LogCategory.AI_SERVICE, '[AIServiceStore] 模型切换失败:', errorMessage)

        __isModelSwitching = false
        set({
          lastModelSwitchError: errorMessage,
          isModelSwitching: false,
          status: AIServiceStatus.ERROR,
          error: ErrorNormalizer.normalize(
            error,
            AIErrorType.MODEL_SWITCH_FAILED,
            'AIServiceStore'
          ),
          lastActivity: new Date()
        })

        throw error
      }
      // 注意：isModelSwitching 不在 finally 中统一清除，而是由 onModelStatusChanged 监听器在收到 IDLE 后自然清除。
      // 这样可以防止后端因 1s 延迟+防抖时序导致的 STOPPED 延迟广播在 isModelSwitching 被提前清除后进入 store。
      // 当切换失败时（catch 分支），会立即清除 isModelSwitching 避免阻塞后续重试。
    },

    updateStatus: (status: AIServiceStatus) => {
      set({
        status,
        lastActivity: new Date()
      })
      logger.debug(LogCategory.AI_SERVICE, `[AIServiceStore] 状态更新: ${status}`)
    },

    setError: (error: AIServiceError) => {
      set({
        error,
        status: AIServiceStatus.ERROR,
        lastActivity: new Date()
      })
      logger.error(
        LogCategory.AI_SERVICE,
        `[AIServiceStore] 设置错误: ${error.type} - ${error.message}`
      )
    },

    clearError: () => {
      set({
        error: null,
        isErrorDialogOpen: false,
        lastActivity: new Date()
      })
      logger.debug(LogCategory.AI_SERVICE, '[AIServiceStore] 清除错误')
    },

    openErrorDialog: () => {
      set({ isErrorDialogOpen: true })
    },

    closeErrorDialog: () => {
      set({ isErrorDialogOpen: false })
    },

    setPhase: (phase: StartupPhase) => {
      set({
        currentPhase: phase,
        lastActivity: new Date()
      })
      logger.debug(LogCategory.AI_SERVICE, `[AIServiceStore] 阶段切换: ${phase}`)
    },

    setConfig: (config: ExtendedAIServiceConfig | null) => {
      set({
        currentConfig: config,
        lastActivity: new Date()
      })
      logger.debug(LogCategory.AI_SERVICE, '[AIServiceStore] 配置更新')
    },

    setCapabilities: (capabilities: AICapabilities | null) => {
      set({
        capabilities,
        lastActivity: new Date()
      })
      logger.debug(LogCategory.AI_SERVICE, '[AIServiceStore] 能力信息更新')
    },

    enterConfigurationPhase: () => {
      set({
        currentPhase: StartupPhase.CONFIGURATION,
        status: AIServiceStatus.CONFIGURING,
        lastActivity: new Date()
      })
      logger.info(LogCategory.AI_SERVICE, '[AIServiceStore] 进入配置阶段')
    },

    enterInitializationPhase: async () => {
      set({
        currentPhase: StartupPhase.INITIALIZATION,
        status: AIServiceStatus.INITIALIZING,
        lastActivity: new Date()
      })
      logger.info(LogCategory.AI_SERVICE, '[AIServiceStore] 进入初始化阶段')

      try {
        await get().initializeAIService()
      } catch (error) {
        logger.error(LogCategory.AI_SERVICE, '[AIServiceStore] 初始化阶段失败:', error)
        throw error
      }
    },

    enterRuntimePhase: () => {
      set({
        currentPhase: StartupPhase.RUNTIME,
        status: AIServiceStatus.IDLE,
        lastActivity: new Date()
      })
      logger.info(LogCategory.AI_SERVICE, '[AIServiceStore] 进入运行时阶段')
    },

    resetState: () => {
      set({
        status: AIServiceStatus.UNINITIALIZED,
        currentConfig: null,
        capabilities: null,
        error: null,
        isErrorDialogOpen: false,
        currentPhase: StartupPhase.CONFIGURATION,
        selectedModelId: undefined,
        isModelSwitching: false,
        lastModelSwitchError: undefined,
        initializationAttempts: 0,
        lastActivity: null
      })
      logger.info(LogCategory.AI_SERVICE, '[AIServiceStore] 状态重置')
    },

    updateLastActivity: () => {
      set({
        lastActivity: new Date()
      })
    },

    setIsGpuSwitching: (switching: boolean) => {
      set({ isGpuSwitching: switching })
      if (switching) {
        set({ error: null })
      }
    }
  }))
)

/**
 * AI服务状态选择器（基于设计文档）
 * 使用缓存的选择器函数避免无限循环
 */
export const aiServiceSelectors = {
  /** 获取服务状态 */
  getStatus: (state: TAIServiceStore) => state.status,

  /** 获取当前配置 */
  getCurrentConfig: (state: TAIServiceStore) => state.currentConfig,

  /** 获取能力信息 */
  getCapabilities: (state: TAIServiceStore) => state.capabilities,

  /** 获取错误信息 */
  getError: (state: TAIServiceStore) => state.error,

  /** 获取当前阶段 */
  getCurrentPhase: (state: TAIServiceStore) => state.currentPhase,

  /** 获取是否已初始化 */
  getIsInitialized: (state: TAIServiceStore) =>
    state.status === AIServiceStatus.IDLE || state.status === AIServiceStatus.PROCESSING,

  /** 获取是否正在初始化 */
  getIsInitializing: (state: TAIServiceStore) => state.status === AIServiceStatus.INITIALIZING,

  /** 获取是否有错误 */
  getHasError: (state: TAIServiceStore) => state.status === AIServiceStatus.ERROR,

  /** 获取模型切换状态 */
  getModelSwitchingState: (state: TAIServiceStore) => state.isModelSwitching,

  /** 获取选中的模型ID */
  getSelectedModelId: (state: TAIServiceStore) => state.selectedModelId,

  /** 获取最后的模型切换错误 */
  getLastModelSwitchError: (state: TAIServiceStore) => state.lastModelSwitchError,

  /** 获取服务运行时信息 - 使用缓存避免无限循环 */
  getRuntimeInfo: (() => {
    let cachedResult: IRuntimeInfo | null = null
    let lastState: IRuntimeState | null = null

    return (state: TAIServiceStore) => {
      // 检查相关状态是否发生变化
      const currentState = {
        status: state.status,
        currentPhase: state.currentPhase,
        lastActivity: state.lastActivity,
        initializationAttempts: state.initializationAttempts
      }

      // 如果状态没有变化，返回缓存的结果
      if (
        lastState &&
        lastState.status === currentState.status &&
        lastState.currentPhase === currentState.currentPhase &&
        lastState.lastActivity === currentState.lastActivity &&
        lastState.initializationAttempts === currentState.initializationAttempts
      ) {
        return cachedResult
      }

      // 状态发生变化，重新计算并缓存结果
      lastState = currentState
      cachedResult = {
        status: state.status,
        currentPhase: state.currentPhase,
        lastActivity: state.lastActivity,
        initializationAttempts: state.initializationAttempts,
        hasError: state.status === AIServiceStatus.ERROR,
        isRunning:
          state.status === AIServiceStatus.IDLE || state.status === AIServiceStatus.PROCESSING
      }

      return cachedResult
    }
  })()
}

/**
 * AI服务状态Hook（基于设计文档）
 */
export const useAIServiceStatus = () => {
  const status = useAIServiceStore(aiServiceSelectors.getStatus)
  const error = useAIServiceStore(aiServiceSelectors.getError)
  const currentPhase = useAIServiceStore(aiServiceSelectors.getCurrentPhase)
  const capabilities = useAIServiceStore(aiServiceSelectors.getCapabilities)

  const {
    initializeAIService,
    initializeAIServiceWithCpu,
    initializeAIServiceWithVulkan,
    updateStatus,
    setError,
    clearError,
    setPhase,
    enterConfigurationPhase,
    enterInitializationPhase,
    enterRuntimePhase
  } = useAIServiceStore()

  return {
    status,
    error,
    currentPhase,
    capabilities,
    initializeAIService,
    initializeAIServiceWithCpu,
    initializeAIServiceWithVulkan,
    updateStatus,
    setError,
    clearError,
    setPhase,
    enterConfigurationPhase,
    enterInitializationPhase,
    enterRuntimePhase
  }
}

/**
 * 模型切换状态Hook
 */
export const useModelSwitching = () => {
  const isModelSwitching = useAIServiceStore(aiServiceSelectors.getModelSwitchingState)
  const selectedModelId = useAIServiceStore(aiServiceSelectors.getSelectedModelId)
  const lastError = useAIServiceStore(aiServiceSelectors.getLastModelSwitchError)
  const notifyModelChanged = useAIServiceStore(state => state.notifyModelChanged)
  const clearError = useAIServiceStore(state => state.clearError)

  return {
    isModelSwitching,
    selectedModelId,
    lastError,
    notifyModelChanged,
    clearError
  }
}

/**
 * AI服务错误处理Hook
 */
export const useAIServiceError = () => {
  const error = useAIServiceStore(aiServiceSelectors.getError)
  const hasError = useAIServiceStore(aiServiceSelectors.getHasError)
  const isErrorDialogOpen = useAIServiceStore(state => state.isErrorDialogOpen)
  const setError = useAIServiceStore(state => state.setError)
  const clearError = useAIServiceStore(state => state.clearError)
  const openErrorDialog = useAIServiceStore(state => state.openErrorDialog)
  const closeErrorDialog = useAIServiceStore(state => state.closeErrorDialog)

  return {
    error,
    hasError,
    isErrorDialogOpen,
    setError,
    clearError,
    openErrorDialog,
    closeErrorDialog
  }
}

/**
 * 三阶段启动流程Hook
 */
export const useStartupPhases = () => {
  const currentPhase = useAIServiceStore(aiServiceSelectors.getCurrentPhase)
  const status = useAIServiceStore(aiServiceSelectors.getStatus)

  const { enterConfigurationPhase, enterInitializationPhase, enterRuntimePhase, setPhase } =
    useAIServiceStore()

  return {
    currentPhase,
    status,
    enterConfigurationPhase,
    enterInitializationPhase,
    enterRuntimePhase,
    setPhase,
    isInConfigurationPhase: currentPhase === StartupPhase.CONFIGURATION,
    isInInitializationPhase: currentPhase === StartupPhase.INITIALIZATION,
    isInRuntimePhase: currentPhase === StartupPhase.RUNTIME
  }
}

/**
 * AI服务初始化Hook（兼容性导出）
 * 为了保持与现有代码的兼容性，提供这个Hook
 */
export const useAIServiceInitialization = () => {
  const status = useAIServiceStore(aiServiceSelectors.getStatus)
  const error = useAIServiceStore(aiServiceSelectors.getError)
  const isInitialized = useAIServiceStore(aiServiceSelectors.getIsInitialized)
  const isInitializing = useAIServiceStore(aiServiceSelectors.getIsInitializing)
  const hasError = useAIServiceStore(aiServiceSelectors.getHasError)

  const { initializeAIService, clearError, resetState } = useAIServiceStore()

  return {
    initializeAIService,
    clearError,
    resetState,
    status,
    error,
    isInitialized,
    isInitializing,
    hasError
  }
}

// 错误优先级表（与主进程 isMoreSpecificError 保持一致；数值越小优先级越高）
const ERROR_PRIORITY_MAP: Record<string, number> = {
  GPU_DRIVER_OUTDATED: 1,
  INSUFFICIENT_VRAM: 1,
  MODEL_OUT_OF_MEMORY: 1,
  INSUFFICIENT_BALANCE: 1,
  API_KEY_INVALID: 1,
  API_KEY_MISSING: 1,
  INSUFFICIENT_MEMORY: 2,
  GPU_NOT_AVAILABLE: 2,
  MODEL_LOAD_FAILED: 3,
  MODEL_NOT_FOUND: 3,
  MODEL_CORRUPTED: 3,
  FREQUENT_CRASH: 3,
  SERVER_START_FAILED: 4,
  SERVICE_SWITCH_FAILED: 4,
  MODEL_SWITCH_FAILED: 4,
  CONFIG_INVALID: 5,
  CONNECTION_FAILED: 5,
  NETWORK_ERROR: 5,
  SERVER_CRASHED: 5
}

/**
 * 判断 incoming 错误是否应该覆盖 existing 错误。
 * 只有当 incoming 优先级 <= existing 优先级时（更具体或同等），才允许覆盖。
 * 在同优先级下，绝对保护包含 details/originalError 详细信息的错误不被无 details 的通用错误覆盖。
 */
function shouldReplaceError(existing: AIServiceError | null, incoming: AIServiceError): boolean {
  if (!existing) return true
  const existingCode = (existing as any).code || (existing as any).type || ''
  const incomingCode = (incoming as any).code || (incoming as any).type || ''
  const existingP = ERROR_PRIORITY_MAP[existingCode] ?? 99
  const incomingP = ERROR_PRIORITY_MAP[incomingCode] ?? 99

  if (incomingP < existingP) return true
  if (incomingP > existingP) return false

  // 同优先级场景：若已存在的错误含有详细信息 (details)，而新错误缺少 details，拒绝覆盖
  const existingHasDetails = Boolean(existing.details || (existing.context as any)?.originalError)
  const incomingHasDetails = Boolean(incoming.details || (incoming.context as any)?.originalError)
  if (existingHasDetails && !incomingHasDetails) return false

  return true
}

// 监听来自主进程的模型状态更新
if (typeof window !== 'undefined' && window.electronAPI) {
  window.electronAPI.onModelStatusChanged((payload: any) => {
    logger.debug(LogCategory.AI_SERVICE, '[AIServiceStore] 收到模型状态更新:', payload)

    if (!payload) {
      logger.warn(LogCategory.AI_SERVICE, '[AIServiceStore] 收到空的模型状态更新，忽略')
      return
    }

    // 映射后端状态到前端 store 状态
    const statusStr = payload.status
    const capabilities = {
      supportsText: true, // 默认支持文本
      supportsImage:
        payload.provider !== 'local' ||
        (payload.modelName &&
          (payload.modelName.includes('omni') || payload.modelName.includes('gemma'))), // 简单推断
      supportsAudio: false,
      supportsVideo: false,
      maxContextSize: 4096,
      modelName: payload.modelName,
      provider: payload.provider
    } as AICapabilities

    // 如果payload包含capabilities，直接使用
    const finalCapabilities = payload.capabilities || capabilities

    const toAIServiceStatus = (raw: unknown): AIServiceStatus => {
      if (typeof raw === 'string' && (Object.values(AIServiceStatus) as unknown[]).includes(raw)) {
        return raw as AIServiceStatus
      }
      return AIServiceStatus.IDLE
    }

    useAIServiceStore.setState(state => {
      // 正在切换 GPU 驱动模式（兼容模式/高性能模式）时，静默并不记录任何致命错误
      if (state.isGpuSwitching) {
        return {
          status: toAIServiceStatus(payload.status),
          capabilities: finalCapabilities,
          error: null,
          lastActivity: new Date()
        }
      }

      // 正在切换模型时，忽略 STOPPED 等过渡状态，避免覆盖 RESTARTING 状态
      // 使用模块级 __isModelSwitching 而非 state.isModelSwitching，
      // 避免 zustand set 批处理或 React 严格模式下的时序问题。
      if (__isModelSwitching) {
        const newStatus = toAIServiceStatus(payload.status)
        // 只接受成功或正向进展的状态；STOPPED/ERROR 等状态在切换过程中是过渡性的
        if (
          newStatus !== AIServiceStatus.IDLE &&
          newStatus !== AIServiceStatus.PROCESSING &&
          newStatus !== AIServiceStatus.RESTARTING &&
          newStatus !== AIServiceStatus.LOADING &&
          newStatus !== AIServiceStatus.CONNECTING &&
          newStatus !== AIServiceStatus.INITIALIZING &&
          newStatus !== AIServiceStatus.PENDING
        ) {
          // 打印到 info 级别方便排查
          logger.info(
            LogCategory.AI_SERVICE,
            `[AIServiceStore:onModelStatusChanged] 模块级标志 __isModelSwitching=true，忽略状态: ${newStatus}`
          )
          return {}
        }
      }

      // 计算新的错误状态：
      //   - 如果 payload.error 为空但 store 已经存有高优先级错误，则保留 store 中的错误
      //     （防止进程退出产生的 null error 覆盖模型加载失败等根因错误）
      //   - 如果 payload.error 非空，仅在其优先级 ≤ 已存错误优先级时才覆盖
      let nextError: AIServiceError | null = state.error
      if (payload.error) {
        const incoming = ErrorNormalizer.normalize(
          payload.error,
          payload.error?.code, // 移除泛化回退，利用规范化器的关键词推断能力
          'AIServiceStore:onModelStatusChanged'
        )
        if (shouldReplaceError(state.error, incoming)) {
          nextError = incoming
        } else {
          logger.debug(
            LogCategory.AI_SERVICE,
            `[AIServiceStore:onModelStatusChanged] 忽略低优先级错误 [${(incoming as any).code}]，保留 [${(state.error as any)?.code}]`
          )
        }
      } else if (state.error) {
        // payload.error 为 null —— 仅当状态成功切换为 IDLE 时才清除错误，
        // 避免进程退出或短暂 stopped 状态把根因错误清掉。
        const newStatus = toAIServiceStatus(statusStr)
        if (newStatus === AIServiceStatus.IDLE || newStatus === AIServiceStatus.PROCESSING) {
          nextError = null
          logger.debug(
            LogCategory.AI_SERVICE,
            '[AIServiceStore:onModelStatusChanged] 服务恢复正常，清除错误状态'
          )
        }
        // 其他状态（ERROR / STOPPED / LOADING 等）保留已有错误
      }

      return {
        status: toAIServiceStatus(statusStr),
        capabilities: finalCapabilities,
        error: nextError,
        lastActivity: new Date(),
        // 如果正在切换且状态变为运行或错误，重置切换标志
        isModelSwitching:
          state.isModelSwitching &&
          (statusStr === AIServiceStatus.IDLE ||
            statusStr === AIServiceStatus.PROCESSING ||
            statusStr === AIServiceStatus.ERROR)
            ? false
            : state.isModelSwitching
      }
    })

    // __isModelSwitching 同步清除：当收到 IDLE/ERROR 时模块级标志也要清掉
    if (
      __isModelSwitching &&
      (payload.status === AIServiceStatus.IDLE ||
        payload.status === AIServiceStatus.PROCESSING ||
        payload.status === AIServiceStatus.ERROR)
    ) {
      logger.info(
        LogCategory.AI_SERVICE,
        `[AIServiceStore:onModelStatusChanged] 收到 ${payload.status}，清除模块级 __isModelSwitching`
      )
      __isModelSwitching = false
    }
  })

  // 监听来自主进程的 AI 服务错误推送
  window.electronAPI.onAIServiceError((error: any) => {
    logger.debug(LogCategory.AI_SERVICE, '[AIServiceStore] 收到 AI 服务错误:', error)

    // 强制进行规范化
    const normalizedError = ErrorNormalizer.normalize(
      error,
      error?.code || error?.aiErrorType || 'SERVER_ERROR',
      'AIServiceStore:onAIServiceError'
    )

    useAIServiceStore.setState(state => {
      // 仅在新错误优先级 ≤ 已存错误时才更新（防止笼统错误覆盖具体根因）
      if (!shouldReplaceError(state.error, normalizedError)) {
        logger.debug(
          LogCategory.AI_SERVICE,
          `[AIServiceStore:onAIServiceError] 忽略低优先级错误 [${(normalizedError as any).code}]，保留 [${(state.error as any)?.code}]`
        )
        return {}
      }
      return {
        error: normalizedError,
        lastActivity: new Date(),
        // 如果是严重错误或高优先级错误，更新状态为错误
        status:
          normalizedError.severity === 'critical' || normalizedError.severity === 'high'
            ? AIServiceStatus.ERROR
            : state.status
      }
    })
  })
}
