import './material-icons.css'
import './styles.css'

import { AIServiceErrorDialog, useAIServiceErrorDialog } from './components/ai/AIServiceErrorDialog'
import { LogCategory, logger } from '@yonuc/shared'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Route, Routes } from 'react-router-dom'
import { ToastContainer, toast } from './components/common/Toast'

import { AIClassificationHandler } from './components/ai/AIClassificationHandler'
import { AnalysisQueueModal } from './components/analysis/AnalysisQueueModal'
import { ErrorBoundary } from './components/common/ErrorBoundary'
import { FileInfo } from '@yonuc/types'
import { Footer } from './components/common/Footer'
import { RealDirectory } from './components/file-explorer/RealDirectory'
import { SettingsDialog } from './components/settings'
import { VirtualDirectory } from './components/file-explorer/VirtualDirectory'
import { WelcomeWizard } from './components/welcome/WelcomeWizard'
import { t } from '@app/languages'
import { useAIModelStore } from './stores/app-store'
import { useAIServiceInitialization } from './stores/ai-service-store'
import { useSettingsStore } from './stores/settings-store'
import { useTheme } from './components/ui/theme-provider'
import { useConfigStore, useWelcomeStore } from './stores/config-store'
import { useInvitation } from './hooks/useInvitation'

type StartupPhase = 'determining' | 'config' | 'initializing' | 'ready'

const App: React.FC = () => {
  // Initialize invitation system
  useInvitation()

  const { setTheme } = useTheme()
  const [, setFiles] = useState<FileInfo[]>([])
  const [startupPhase, setStartupPhase] = useState<StartupPhase>('determining')
  const [startupMessage, setStartupMessage] = useState<string>(t('正在准备启动应用...'))
  const forceConfigFlagConsumedRef = useRef(false)

  // AI服务状态管理
  const { initializeAIService } = useAIServiceInitialization()
  const { isOpen: isErrorDialogOpen, closeDialog: closeErrorDialog } = useAIServiceErrorDialog()

  const determineStartupPhase = useCallback(
    async (options?: { ignoreForceFlag?: boolean }) => {
      if (!window.electronAPI) {
        setStartupPhase('config')
        return
      }

      setStartupPhase('determining')
      setStartupMessage(t('正在检测应用配置...'))

      try {
        const [config, startupFlags] = await Promise.all([
          window.electronAPI!.getConfig(),
          typeof window.electronAPI!.getStartupFlags === 'function'
            ? window.electronAPI!.getStartupFlags()
            : Promise.resolve({ forceConfigStage: false })
        ])

        // 立即更新设置 Store，确保 UI 组件能获取到最新的配置值
        // 解决 WelcomeWizard 中获取默认值为空的问题
        useSettingsStore.getState().updateConfig(config)

        const shouldForceConfig =
          !options?.ignoreForceFlag &&
          !forceConfigFlagConsumedRef.current &&
          (startupFlags?.forceConfigStage ?? false)

        if (shouldForceConfig) {
          forceConfigFlagConsumedRef.current = true
          setStartupPhase('config')
          return
        }

        const languageConfirmed = config.languageConfirmed ?? false
        let hasDownloadedModel = false
        const selectedModelId = config.selectedModelId
        const aiServiceMode = config.aiServiceMode || 'local'

        logger.info(LogCategory.RENDERER, '=== 启动阶段判断开始 ===')
        logger.info(LogCategory.RENDERER, '当前 AI 模式:', aiServiceMode)
        logger.info(
          LogCategory.RENDERER,
          '语言已确认 (config.languageConfirmed):',
          languageConfirmed
        )

        // 只有在本地模式下才检查模型下载状态
        if (aiServiceMode === 'local' && selectedModelId) {
          const aiPlatform = config.aiPlatform || 'llama.cpp'
          
          if (aiPlatform === 'ollama') {
            // Ollama 平台检查
            const result = await window.electronAPI!.ollama.checkModel(selectedModelId)
            hasDownloadedModel = result.installed
          } else {
            // llama.cpp 平台检查
            const status = await window.electronAPI!.modelDownload.checkDownloadStatus(selectedModelId)
            hasDownloadedModel = status.isDownloaded
          }
          
          logger.info(LogCategory.RENDERER, `检查本地模型下载状态 (${aiPlatform}):`, {
            modelId: selectedModelId,
            isDownloaded: hasDownloadedModel
          })
        } else if (aiServiceMode === 'cloud') {
          // 云端模式下，只要有选中的模型ID，就认为“已就绪”
          const cloudModelId = config.aiCloudSelectedModelId
          const hasCloudConfig = !!(config.aiCloudProvider && config.aiCloudApiKey && cloudModelId)
          hasDownloadedModel = hasCloudConfig
          logger.info(LogCategory.RENDERER, '检查云端配置状态:', { 
            hasCloudConfig, 
            cloudModelId 
          })
        }

        if (!languageConfirmed && config.isFirstRun) {
          logger.info(LogCategory.RENDERER, '-> 进入配置阶段（语言未确认且为首次运行）')
          setStartupPhase('config')
          return
        }

        if (!hasDownloadedModel) {
          // 模型未配置或未下载，跳转到欢迎向导的模型选择步骤
          logger.warn(LogCategory.RENDERER, '★★★ 模型尚未就绪（本地未下载或云端未配置），重定向到配置页面 ★★★')
          // 设置 store 模式以匹配配置
          useWelcomeStore.getState().setModelMode(aiServiceMode as 'local' | 'cloud')
          useWelcomeStore.getState().goToModelSelection()
          setStartupPhase('config')
          return
        }

        logger.info(LogCategory.RENDERER, '-> 进入初始化阶段')
        setStartupPhase('initializing')
      } catch (error) {
        logger.error(LogCategory.RENDERER, '判定启动阶段失败:', error)
        setStartupPhase('config')
      }
    },
    [forceConfigFlagConsumedRef]
  )

  // 监听云端配置同步更新
  useEffect(() => {
    if (window.electronAPI?.onConfigSynced) {
      const unsubscribe = window.electronAPI!.onConfigSynced(async (config: Record<string, any>) => {
        logger.info(LogCategory.RENDERER, '收到云端配置同步更新', config)
        useSettingsStore.getState().updateConfig(config)
        // 如果同步的配置包含语言变更，应用语言设置
        if (config.language) {
          await VoerkaI18n.change(config.language)
        }
      })
      return unsubscribe
    }
  }, [])

  useEffect(() => {
    const initTheme = async () => {
      try {
        if (window.electronAPI?.getConfig) {
          const config = await window.electronAPI.getConfig()
          VoerkaI18n.change(config.language)
          if (config.theme) {
            setTheme(config.theme)
          }
        }
      } catch (error) {
        logger.error(LogCategory.RENDERER, '初始化主题失败:', error)
      }
    }
    initTheme()
  }, [setTheme])

  // 监听模型未下载事件
  useEffect(() => {
    if (!window.electronAPI?.onModelNotDownloaded) {
      logger.warn(LogCategory.RENDERER, 'onModelNotDownloaded API 不可用')
      return
    }

    logger.info(LogCategory.RENDERER, '设置模型未下载事件监听器')
    const unsubscribe = window.electronAPI.onModelNotDownloaded((payload: any) => {
      // 关键修正：如果当前已经是云端模式，忽略本地模型的未下载事件
      // 否则由于 LlamaServer 还在后台尝试启动，会错误触发跳转
      const currentMode = useSettingsStore.getState().getConfigValue<string>('AI_SERVICE_MODE')
      if (currentMode === 'cloud') {
        logger.info(LogCategory.RENDERER, '当前处于云端模式，忽略本地模型未下载事件', payload)
        return
      }

      logger.warn(LogCategory.RENDERER, '★★★ 收到模型未下载事件，跳转到模型选择页面 ★★★', payload)
      logger.warn(LogCategory.RENDERER, '当前启动阶段:', startupPhase)

      // 强制跳转到配置阶段，不管当前处于什么状态
      if (startupPhase !== 'config') {
        logger.warn(LogCategory.RENDERER, '强制跳转到配置阶段')
        useWelcomeStore.getState().setModelMode('local')
        useWelcomeStore.getState().goToModelSelection()
        setStartupPhase('config')
        logger.warn(LogCategory.RENDERER, '已执行强制跳转，新的启动阶段: config')
      } else {
        logger.warn(LogCategory.RENDERER, '当前已在配置阶段，只调整欢迎向导步骤')
        useWelcomeStore.getState().setModelMode('local')
        useWelcomeStore.getState().goToModelSelection()
      }
    })

    return () => {
      logger.info(LogCategory.RENDERER, '清理模型未下载事件监听器')
      if (unsubscribe) unsubscribe()
    }
  }, [startupPhase])

  // 监听系统通知 (来自主进程)
  useEffect(() => {
    if (window.electronAPI?.onSystemNotification) {
      const unsubscribe = window.electronAPI.onSystemNotification((data: any) => {
        const { type, message, sticky, id, autoClose } = data
        
        // 调用通用 Toast 组件
        const toastOptions = {
          autoClose: sticky ? false : (autoClose || 5000),
          toastId: id
        }

        switch (type) {
          case 'success':
            toast.success(message, 3000)
            break
          case 'error':
            toast.error(message, 5000)
            break
          case 'warning':
            toast.warning(message, 5000)
            break
          case 'info':
          default:
            toast.info(message, 5000)
            break
        }
      })
      return () => {
        if (unsubscribe) unsubscribe()
      }
    }
    return undefined
  }, [])

  const loadFiles = useCallback(async () => {
    try {
      if (window.electronAPI) {
        const fileList = await window.electronAPI.getAllFiles()
        setFiles(fileList)
      }
    } catch (error) {
      logger.error(LogCategory.RENDERER, '加载文件失败:', error)
    }
  }, [])

  const checkAIStatus = useCallback(async () => {
    try {
      if (window.electronAPI) {
        const aiStatus: any = await window.electronAPI.getAIStatus()
        const isRunning = aiStatus?.status === 'running'
        useAIModelStore.getState().setModelStatus(isRunning ? 'loaded' : 'idle', isRunning)
      }
    } catch (error) {
      logger.error(LogCategory.RENDERER, '检查AI状态失败:', error)
    }
  }, [])

  const initializeApplication = useCallback(async () => {
    try {
      if (window.electronAPI?.initializeAppPhase) {
        await window.electronAPI.initializeAppPhase()
      }

      setStartupMessage(t('正在初始化AI服务...'))
      // 使用AI服务Store进行初始化
      try {
        await initializeAIService()
        logger.info(LogCategory.RENDERER, 'AI服务初始化成功')
      } catch (error) {
        logger.warn(LogCategory.RENDERER, 'AI服务初始化失败，将在后续使用时重试:', error)
      }

      setStartupMessage(t('正在加载应用配置...'))
      await loadFiles()
      setStartupMessage(t('正在检查 AI 状态...'))
      await checkAIStatus()
      setStartupPhase('ready')
    } catch (error) {
      logger.error(LogCategory.RENDERER, '应用初始化失败:', error)
      setStartupPhase('ready')
    }
  }, [checkAIStatus, loadFiles])



  useEffect(() => {
    determineStartupPhase()
  }, [determineStartupPhase])

  useEffect(() => {
    if (startupPhase === 'initializing') {
      initializeApplication()
    }
  }, [initializeApplication, startupPhase])

  const renderStartupScreen = (title: string, description?: string) => (
    <div className="h-screen w-screen flex items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100">
      <div className="text-center p-8 bg-white rounded-lg shadow-lg">
        <div className="inline-block animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-sky-500 mb-6"></div>
        <h2 className="text-xl font-semibold text-gray-800 mb-2">{title}</h2>
        <p className="text-gray-600">{description}</p>
        <p className="text-sm text-gray-500 mt-2">{startupMessage}</p>
      </div>
    </div>
  )

  if (startupPhase === 'determining') {
    return renderStartupScreen(t('正在初始化应用'), t('检测配置阶段...'))
  }

  if (startupPhase === 'initializing') {
    return renderStartupScreen(t('正在初始化应用'), t('准备加载文件与 AI 服务...'))
  }

  if (startupPhase === 'config') {
    return (
      <ErrorBoundary>
        <div className="h-screen w-screen">
          <WelcomeWizard onComplete={() => determineStartupPhase({ ignoreForceFlag: true })} />
        </div>
      </ErrorBoundary>
    )
  }

  return (
    <ErrorBoundary>
      <div className="app h-screen flex flex-col overflow-hidden">
        <AIClassificationHandler />
        <div className="flex-1 flex flex-col overflow-hidden">
          <Routes>
            <Route path="/" element={<RealDirectory />} />
            <Route path="/real-directory" element={<RealDirectory />} />
            <Route path="/virtual-directory" element={<VirtualDirectory />} />
          </Routes>
        </div>
        <Footer />
        <AnalysisQueueModal />
        <ToastContainer />
        <SettingsDialog />

        {/* AI服务错误对话框 */}
        <AIServiceErrorDialog
          open={isErrorDialogOpen}
          onClose={closeErrorDialog}
          onOpenSettings={() => {
            // 这里可以添加打开设置页面的逻辑
            logger.info(LogCategory.RENDERER, '打开设置页面')
          }}
        />
      </div>
    </ErrorBoundary>
  )
}

export default App
