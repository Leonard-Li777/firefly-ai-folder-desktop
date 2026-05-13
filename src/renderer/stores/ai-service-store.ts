import { t } from '@app/languages'
/**
 * AI服务状态管理Store
 * 基于设计文档实现完整的AI服务状态管理和通知系统
 */

import { create } from 'zustand'
import { subscribeWithSelector } from 'zustand/middleware'
import { ErrorNormalizer, LogCategory, logger } from '@yonuc/shared'
import { 
  AICapabilities, 
  AIErrorType,
  AIServiceError, 
  AIServiceStatus, 
  ExtendedAIServiceConfig,
  StartupPhase 
} from '@yonuc/types'

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
  initializeAIService: () => Promise<void>
  /** 以 CPU 模式初始化AI服务 */
  initializeAIServiceWithCpu: () => Promise<void>
  /** 通知模型切换 */
  notifyModelChanged: (modelId: string) => Promise<void>
  /** 更新状态 */
  updateStatus: (status: AIServiceStatus) => void
  /** 设置错误 */
  setError: (error: AIServiceError) => void
  /** 清除错误 */
  clearError: () => void
  /** 设置阶段 */
  setPhase: (phase: StartupPhase) => void
  /** 设置配置 */
  setConfig: (config: ExtendedAIServiceConfig | null) => void
  /** 设置能力 */
  setCapabilities: (capabilities: AICapabilities | null) => void
  /** 三阶段启动流程控制 */
  enterConfigurationPhase: () => void
  enterInitializationPhase: () => Promise<void>
  enterRuntimePhase: () => void
  /** 重置所有状态 */
  resetState: () => void
  /** 更新最后活动时间 */
  updateLastActivity: () => void
}

/**
 * AI服务Store类型
 */
export type TAIServiceStore = IAIServiceState & IAIServiceActions

/**
 * 运行时信息接口
 */
interface IRuntimeInfo {
  status: AIServiceStatus;
  currentPhase: StartupPhase;
  lastActivity: Date | null;
  initializationAttempts: number;
  hasError: boolean;
  isRunning: boolean;
}

/**
 * 运行时状态接口
 */
interface IRuntimeState {
  status: AIServiceStatus;
  currentPhase: StartupPhase;
  lastActivity: Date | null;
  initializationAttempts: number;
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
    lastModelSwitchError: undefined,
    initializationAttempts: 0,
    lastActivity: null,

    // 操作方法
    initializeAIService: async () => {
      const state = get()

      // 如果已经在运行或正在初始化，跳过
      if (state.status === AIServiceStatus.IDLE || state.status === AIServiceStatus.PROCESSING || state.status === AIServiceStatus.INITIALIZING) {
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
          lastActivity: new Date(),
        })
        return
      }

      const toAIServiceStatus = (raw: unknown): AIServiceStatus => {
        if (typeof raw === 'string' && (Object.values(AIServiceStatus) as unknown[]).includes(raw)) {
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
          lastActivity: new Date(),
        }))

        logger.info(LogCategory.AI_SERVICE, '[AIServiceStore] 开始初始化AI服务...')

        const initResult = await api.initialize()
        if (!initResult?.success) {
          throw new Error(initResult?.message || t('AI服务初始化失败'))
        }

        const [statusRaw, phaseRaw, capabilitiesRaw] = await Promise.all([
          (api as any).getStatus?.(),
          (api as any).getCurrentPhase?.(),
          (api as any).getCapabilities?.(),
        ])

        const status = toAIServiceStatus(statusRaw)
        const currentPhase = toStartupPhase(phaseRaw)
        const capabilities = (capabilitiesRaw as AICapabilities | null) ?? null

        set({
          status,
          currentPhase,
          capabilities,
          lastActivity: new Date(),
        })

        logger.info(LogCategory.AI_SERVICE, '[AIServiceStore] AI服务初始化成功', {
          status,
          currentPhase,
          modelName: capabilities?.modelName,
        })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        logger.error(LogCategory.AI_SERVICE, '[AIServiceStore] AI服务初始化失败:', errorMessage)

        set({
          status: AIServiceStatus.ERROR,
          error: ErrorNormalizer.normalize(
            error,
            AIErrorType.SERVER_START_FAILED,
            'AIServiceStore'
          ),
          lastActivity: new Date(),
        })

        throw error
      }
    },
    initializeAIServiceWithCpu: async () => {
      const state = get()

      // 如果正在初始化，跳过（允许从错误状态重试）
      if (state.status === AIServiceStatus.INITIALIZING) {
        logger.debug(LogCategory.AI_SERVICE, '[AIServiceStore] AI服务正在初始化，跳过 CPU 模式初始化请求')
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
          lastActivity: new Date(),
        })
        return
      }

      const toAIServiceStatus = (raw: unknown): AIServiceStatus => {
        if (typeof raw === 'string' && (Object.values(AIServiceStatus) as unknown[]).includes(raw)) {
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
          lastActivity: new Date(),
        }))

        logger.info(LogCategory.AI_SERVICE, '[AIServiceStore] 开始以 CPU 模式初始化AI服务...')

        // 核心差异：传递 forceCpu: true
        const initResult = await api.initialize({ forceCpu: true })
        if (!initResult?.success) {
          throw new Error(initResult?.message || t('AI服务初始化失败'))
        }

        const [statusRaw, phaseRaw, capabilitiesRaw] = await Promise.all([
          (api as any).getStatus?.(),
          (api as any).getCurrentPhase?.(),
          (api as any).getCapabilities?.(),
        ])

        const status = toAIServiceStatus(statusRaw)
        const currentPhase = toStartupPhase(phaseRaw)
        const capabilities = (capabilitiesRaw as AICapabilities | null) ?? null

        set({
          status,
          currentPhase,
          capabilities,
          lastActivity: new Date(),
        })

        logger.info(LogCategory.AI_SERVICE, '[AIServiceStore] CPU 模式 AI 服务初始化成功', {
          status,
          currentPhase,
          modelName: capabilities?.modelName,
        })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        logger.error(LogCategory.AI_SERVICE, '[AIServiceStore] CPU 模式 AI 服务初始化失败:', errorMessage)

        set({
          status: AIServiceStatus.ERROR,
          error: ErrorNormalizer.normalize(
            error,
            AIErrorType.SERVER_START_FAILED,
            'AIServiceStore'
          ),
          lastActivity: new Date(),
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
        const errorMessage = 'electronAPI.aiService.onModelChanged 不可用'
        logger.error(LogCategory.AI_SERVICE, '[AIServiceStore] 模型切换失败:', errorMessage)
        set({
          status: AIServiceStatus.ERROR,
          error: ErrorNormalizer.normalize(
            errorMessage,
            AIErrorType.MODEL_SWITCH_FAILED,
            'AIServiceStore'
          ),
          lastActivity: new Date(),
        })
        return
      }

    const toAIServiceStatus = (raw: unknown): AIServiceStatus => {
      if (typeof raw === 'string' && (Object.values(AIServiceStatus) as unknown[]).includes(raw)) {
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
        set({
          isModelSwitching: true,
          selectedModelId: modelId,
          lastModelSwitchError: undefined,
          status: AIServiceStatus.RESTARTING,
          lastActivity: new Date(),
        })

        logger.info(LogCategory.AI_SERVICE, `[AIServiceStore] 通知模型切换: ${modelId}`)

        const result = await api.onModelChanged(modelId)
        if (!result?.success) {
          throw new Error(result?.message || t('模型切换失败'))
        }

        const [statusRaw, phaseRaw, capabilitiesRaw] = await Promise.all([
          (api as any).getStatus?.(),
          (api as any).getCurrentPhase?.(),
          (api as any).getCapabilities?.(),
        ])

        const status = toAIServiceStatus(statusRaw)
        const currentPhase = toStartupPhase(phaseRaw)
        const capabilities = (capabilitiesRaw as AICapabilities | null) ?? null

        set({
          status,
          currentPhase,
          capabilities,
          lastActivity: new Date(),
        })

        logger.info(LogCategory.AI_SERVICE, `[AIServiceStore] 模型切换成功: ${modelId}`, {
          status,
          currentPhase,
          modelName: capabilities?.modelName,
        })
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        logger.error(LogCategory.AI_SERVICE, '[AIServiceStore] 模型切换失败:', errorMessage)

        set({
          lastModelSwitchError: errorMessage,
          status: AIServiceStatus.ERROR,
          error: ErrorNormalizer.normalize(
            error,
            AIErrorType.MODEL_SWITCH_FAILED,
            'AIServiceStore'
          ),
          lastActivity: new Date(),
        })

        throw error
      } finally {
        set({
          isModelSwitching: false,
        })
      }
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
      logger.error(LogCategory.AI_SERVICE, `[AIServiceStore] 设置错误: ${error.type} - ${error.message}`)
    },

    clearError: () => {
      set({
        error: null,
        lastActivity: new Date()
      })
      logger.debug(LogCategory.AI_SERVICE, '[AIServiceStore] 清除错误')
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
  getIsInitialized: (state: TAIServiceStore) => state.status === AIServiceStatus.IDLE || state.status === AIServiceStatus.PROCESSING,
  
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
    let cachedResult: IRuntimeInfo | null = null;
    let lastState: IRuntimeState | null = null;
    
    return (state: TAIServiceStore) => {
      // 检查相关状态是否发生变化
      const currentState = {
        status: state.status,
        currentPhase: state.currentPhase,
        lastActivity: state.lastActivity,
        initializationAttempts: state.initializationAttempts
      };
      
      // 如果状态没有变化，返回缓存的结果
      if (lastState && 
          lastState.status === currentState.status &&
          lastState.currentPhase === currentState.currentPhase &&
          lastState.lastActivity === currentState.lastActivity &&
          lastState.initializationAttempts === currentState.initializationAttempts) {
        return cachedResult;
      }
      
      // 状态发生变化，重新计算并缓存结果
      lastState = currentState;
      cachedResult = {
        status: state.status,
        currentPhase: state.currentPhase,
        lastActivity: state.lastActivity,
        initializationAttempts: state.initializationAttempts,
        hasError: state.status === AIServiceStatus.ERROR,
        isRunning: state.status === AIServiceStatus.IDLE || state.status === AIServiceStatus.PROCESSING
      };
      
      return cachedResult;
    };
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
  const notifyModelChanged = useAIServiceStore((state) => state.notifyModelChanged)
  const clearError = useAIServiceStore((state) => state.clearError)
  
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
  const setError = useAIServiceStore((state) => state.setError)
  const clearError = useAIServiceStore((state) => state.clearError)
  
  return {
    error,
    hasError,
    setError,
    clearError
  }
}

/**
 * 三阶段启动流程Hook
 */
export const useStartupPhases = () => {
  const currentPhase = useAIServiceStore(aiServiceSelectors.getCurrentPhase)
  const status = useAIServiceStore(aiServiceSelectors.getStatus)
  
  const {
    enterConfigurationPhase,
    enterInitializationPhase,
    enterRuntimePhase,
    setPhase
  } = useAIServiceStore()
  
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
  
  const {
    initializeAIService,
    clearError,
    resetState
  } = useAIServiceStore()
  
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

// 监听来自主进程的模型状态更新
if (typeof window !== 'undefined' && window.electronAPI) {
  window.electronAPI.onModelStatusChanged((payload: any) => {
    logger.debug(LogCategory.AI_SERVICE, '[AIServiceStore] 收到模型状态更新:', payload);
    
    // 映射后端状态到前端 store 状态
    const statusStr = payload.status;
    const capabilities = {
      supportsText: true, // 默认支持文本
      supportsImage: payload.provider !== 'local' || (payload.modelName && (payload.modelName.includes('omni') || payload.modelName.includes('gemma'))), // 简单推断
      supportsAudio: false,
      supportsVideo: false,
      maxContextSize: 4096,
      modelName: payload.modelName,
      provider: payload.provider
    } as AICapabilities;
    
    // 如果payload包含capabilities，直接使用
    const finalCapabilities = payload.capabilities || capabilities;

    const toAIServiceStatus = (raw: unknown): AIServiceStatus => {
      if (typeof raw === 'string' && (Object.values(AIServiceStatus) as unknown[]).includes(raw)) {
        return raw as AIServiceStatus
      }
      return AIServiceStatus.IDLE
    }

    useAIServiceStore.setState(state => ({
      status: toAIServiceStatus(statusStr),
      capabilities: finalCapabilities,
      error: payload.error ? ErrorNormalizer.normalize(
        payload.error,
        payload.error?.code, // 移除泛化回退，利用规范化器的关键词推断能力
        'AIServiceStore:onModelStatusChanged'
      ) : null,
      lastActivity: new Date(),
      // 如果正在切换且状态变为运行或错误，重置切换标志
      isModelSwitching: (state.isModelSwitching && (statusStr === AIServiceStatus.IDLE || statusStr === AIServiceStatus.PROCESSING || statusStr === AIServiceStatus.ERROR)) ? false : state.isModelSwitching
    }));
  });

  // 监听来自主进程的 AI 服务错误推送
  window.electronAPI.onAIServiceError((error: any) => {
    logger.debug(LogCategory.AI_SERVICE, '[AIServiceStore] 收到 AI 服务错误:', error);
    
    // 强制进行规范化
    const normalizedError = ErrorNormalizer.normalize(
      error, 
      (error?.code || error?.aiErrorType || 'SERVER_ERROR'), 
      'AIServiceStore:onAIServiceError'
    );

    useAIServiceStore.setState(state => ({
      error: normalizedError,
      lastActivity: new Date(),
      // 如果是严重错误或高优先级错误，更新状态为错误
      status: (normalizedError.severity === 'critical' || normalizedError.severity === 'high') ? AIServiceStatus.ERROR : state.status
    }));
  });
}

