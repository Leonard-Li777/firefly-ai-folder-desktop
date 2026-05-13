import './material-icons.css'
import './styles.css'

import { AIServiceErrorDialog, useAIServiceErrorDialog } from './components/ai/AIServiceErrorDialog'
import { LogCategory, logger } from '@yonuc/shared'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Route, Routes, useLocation } from 'react-router-dom'
import { cn } from './lib/utils'
import { ToastContainer, toast } from './components/common/Toast'

import { AIClassificationHandler } from './components/ai/AIClassificationHandler'
import { AnalysisQueueModal } from './components/analysis/AnalysisQueueModal'
import { ErrorBoundary } from './components/common/ErrorBoundary'
import { FileInfo, SettingsCategory } from '@yonuc/types'
import { Footer } from './components/common/Footer'
import { RealDirectory } from './components/file-explorer/RealDirectory'
import { SettingsDialog } from './components/settings'
import { VirtualDirectory } from './components/file-explorer/VirtualDirectory'
import { WelcomeWizard } from './components/welcome/WelcomeWizard'
import { LicenseGateway } from './components/license/LicenseGateway'
import { Loader2 } from 'lucide-react'
import { Card } from './components/ui/card'
import { t } from '@app/languages'
import { useAIModelStore } from './stores/app-store'
import { useAIServiceInitialization } from './stores/ai-service-store'
import { useSettingsStore } from './stores/settings-store'
import { useTheme } from './components/ui/theme-provider'
import { useConfigStore, useWelcomeStore } from './stores/config-store'
import { useInvitation } from './hooks/useInvitation'

type StartupPhase = 'determining' | 'config' | 'licensing' | 'initializing' | 'ready'

const App: React.FC = () => {
  // Initialize invitation system
  useInvitation()

  const location = useLocation()
  const currentPath = location.pathname

  // Keep-Alive 状态：记录组件是否已经挂载过
  const [hasMountedReal, setHasMountedReal] = useState(false)
  const [hasMountedVirtual, setHasMountedVirtual] = useState(false)

  useEffect(() => {
    if (currentPath === '/' || currentPath === '/real-directory') {
      setHasMountedReal(true)
    } else if (currentPath === '/virtual-directory') {
      setHasMountedVirtual(true)
    }
  }, [currentPath])

  const { setTheme } = useTheme()
  const [, setFiles] = useState<FileInfo[]>([])
  const [startupPhase, setStartupPhase] = useState<StartupPhase>('determining')
  const [startupMessage, setStartupMessage] = useState<string>(t('正在准备启动应用...'))
  const [licenseInfo, setLicenseInfo] = useState<{ status: string; error?: string } | null>(null)
  const forceConfigFlagConsumedRef = useRef(false)

  // AI服务状态管理
  const { initializeAIService } = useAIServiceInitialization()
  const { isOpen: isErrorDialogOpen, closeDialog: closeErrorDialog } = useAIServiceErrorDialog()
  const { isMigrating, setMigrating, migrationProgress } = useSettingsStore()

  // 监听模型迁移进度
  useEffect(() => {
    if (!window.electronAPI?.onModelMigrationProgress) return

    const unsubscribe = window.electronAPI.onModelMigrationProgress((message: string) => {
      logger.info(LogCategory.RENDERER, '模型迁移进度:', message)
      
      if (message === 'preparing') {
        setMigrating(true, t('正在准备迁移模型...'))
      } else if (message === 'migrating-builtin-dir' || message.startsWith('migrating-builtin-file:')) {
        setMigrating(true, t('正在迁移系统内置模型...'))
      } else if (message.startsWith('migrating-selected-model:')) {
        setMigrating(true, t('正在优先迁移当前选中的模型...'))
      } else if (message.startsWith('builtin-completed:')) {
        const countStr = message.split(':')[1] || '0'
        const count = parseInt(countStr)
        // 内置模型迁移完成，可以解除蒙版
        setMigrating(false)
        if (count > 0) {
          toast.success(t('核心模型迁移成功！还有 {count} 个模型将在后台继续迁移，你可以随时点击“刷新模型列表”查看状态。', { count }), 10000)
        } else {
          toast.success(t('核心模型迁移成功！'), 3000)
        }
      } else if (message === 'migration-finished') {
        setMigrating(false)
        toast.success(t('所有模型迁移任务已完成'))
      } else if (message === 'migration-error') {
        setMigrating(false)
        toast.error(t('模型迁移过程中发生错误，请检查磁盘空间或权限'))
      } else if (message.startsWith('background-migration:')) {
        const remaining = message.split(':')[1]
        logger.info(LogCategory.RENDERER, `后台正在迁移剩余模型，还剩 ${remaining} 个`)
      } else if (message.startsWith('background-migration-success:')) {
        const parts = message.split(':')
        const count = parts[1]
        const remaining = parts[2]
        toast.info(t('模型迁移进度：已完成 {count} 个，剩余 {remaining} 个', { count, remaining }), 3000)
      }
    })

    return unsubscribe
  }, [setMigrating])

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
          const aiEngine = config.aiEngine || 'llama.cpp'
          
          if (aiEngine === 'ollama') {
            // Ollama 平台检查
            const result = await window.electronAPI!.ollama.checkModel(selectedModelId)
            hasDownloadedModel = result.installed
          } else {
            // llama.cpp 平台检查
            const status = await window.electronAPI!.modelDownload.checkDownloadStatus(selectedModelId)
            hasDownloadedModel = status.isDownloaded
          }
          
          logger.info(LogCategory.RENDERER, `检查本地模型下载状态 (${aiEngine}):`, {
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

        // 核心逻辑：判断是否需要进入配置阶段（欢迎向导）
        // 1. 如果是首次运行，或者语言未确认，必须进入配置阶段
        if (config.isFirstRun || !languageConfirmed) {
          logger.info(LogCategory.RENDERER, '-> 进入配置阶段（首次运行或语言未确认）', {
            isFirstRun: config.isFirstRun,
            languageConfirmed
          })
          setStartupPhase('config')
          return
        }

        // 2. 检查模型是否就绪
        if (!hasDownloadedModel) {
          // 如果是从欢迎向导点击完成（ignoreForceFlag为true），即使检测还没就绪也允许继续
          // 这样可以避免因为状态同步延迟导致的重定向循环
          if (options?.ignoreForceFlag) {
            logger.info(LogCategory.RENDERER, '-> 检测到欢迎向导完成触发，虽然模型未就绪，但允许进入初始化阶段进行深度检查')
            setStartupPhase('initializing')
            return
          }

          // 如果不是首次运行，即使模型未就绪（例如手动删除了模型），也不再强制将用户拉回欢迎向导
          // 而是允许进入主程序，让用户在设置页面处理，或者由后续的 AI 初始化逻辑尝试恢复
          if (!config.isFirstRun) {
            logger.warn(LogCategory.RENDERER, '-> 模型尚未就绪（本地未下载或云端未配置），但由于已完成初始配置，继续进入初始化阶段')
            setStartupPhase('initializing')
            return
          }

          // 只有在确定是首次运行流程（逻辑上被上方拦截，这里作为双重保险）且模型未就绪时，才重定向到向导的模型选择步骤
          logger.warn(LogCategory.RENDERER, '★★★ 首次运行检测：模型尚未就绪，重定向到配置页面 ★★★')
          useWelcomeStore.getState().setModelMode(aiServiceMode as 'local' | 'cloud')
          useWelcomeStore.getState().goToModelSelection()
          setStartupPhase('config')
          return
        }

        // 3. 授权检查
        setStartupMessage(t('正在验证授权状态...'))
        const licenseResult = await window.electronAPI!.license.getStatus()
        setLicenseInfo(licenseResult)

        if (licenseResult.status !== 'AUTHORIZED') {
           logger.warn(LogCategory.RENDERER, '-> 进入授权阶段:', licenseResult.status)
           setStartupPhase('licensing')
           return
        }

        logger.info(LogCategory.RENDERER, '-> 直接进入初始化阶段')
        setStartupPhase('initializing')

      } catch (error) {
        logger.error(LogCategory.RENDERER, '判定启动阶段失败:', error)
        // 报错时默认进入配置阶段（最安全）
        setStartupPhase('config')
      }
    },
    [forceConfigFlagConsumedRef]
  )

  // 监听云端配置同步更新
  useEffect(() => {
    if (typeof window.electronAPI?.onConfigChange === "function") {
      const unsubscribe = window.electronAPI!.onConfigChange(async (config: Record<string, any>) => {
        useSettingsStore.getState().updateConfig(config, { internal: true })
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

    // 记录最后一次迁移完成的时间，用于解决 IPC 事件滞后导致的竞态条件
    // 使用 ref 避免在闭包中捕获旧值
    const lastMigrationEndTimeRef = { current: 0 }
    const MIGRATION_COOLDOWN = 3000 // 3秒冷却时间

    logger.info(LogCategory.RENDERER, '设置模型未下载事件监听器')
    const unsubscribe = window.electronAPI.onModelNotDownloaded((payload: any) => {
      const state = useSettingsStore.getState()
      
      // 1. 如果当前正在迁移中，忽略此事件以防止跳转
      if (state.isMigrating) {
        logger.info(LogCategory.RENDERER, '正在迁移模型中，忽略模型未下载事件')
        return
      }

      // 2. 如果刚结束迁移（在冷却时间内），也忽略此事件
      // 这是为了解决：主进程在迁移中途或刚结束时触发了 reloadConfig 并由于文件尚未完全就绪发送了事件，
      // 而该 IPC 事件到达渲染进程时，蒙版可能已经消失。
      const now = Date.now()
      if (now - lastMigrationEndTimeRef.current < MIGRATION_COOLDOWN) {
        logger.info(LogCategory.RENDERER, '处于迁移冷却期内，忽略可能滞后的模型未下载事件')
        return
      }

      // 关键修正：如果当前已经是云端模式，忽略本地模型的未下载事件
      // 否则由于 LlamaServer 还在后台尝试启动，会错误触发跳转
      const currentMode = state.getConfigValue<string>('AI_SERVICE_MODE')
      if (currentMode === 'cloud') {
        logger.info(LogCategory.RENDERER, '当前处于云端模式，忽略本地模型未下载事件', payload)
        return
      }

      // 关键修正：如果正在进行下载或已下载完成（步骤5或6），忽略未下载事件
      // 避免下载过程中主进程后台检测导致的竞态重定向
      const welcomeStore = useWelcomeStore.getState()
      if (startupPhase === 'config' && (welcomeStore.currentStep === 5 || welcomeStore.currentStep === 6)) {
        logger.info(LogCategory.RENDERER, `当前处于欢迎向导步骤 ${welcomeStore.currentStep}，忽略未下载事件以避免重定向循环`)
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

    // 监听迁移状态变更，更新冷却时间
    const unsubMigrate = useSettingsStore.subscribe(
      (state) => state.isMigrating,
      (isMigrating, prevIsMigrating) => {
        if (prevIsMigrating === true && isMigrating === false) {
          lastMigrationEndTimeRef.current = Date.now()
          logger.info(LogCategory.RENDERER, '模型迁移结束，进入事件冷却期')
        }
      }
    )

    return () => {
      logger.info(LogCategory.RENDERER, '清理模型未下载事件监听器')
      if (unsubscribe) unsubscribe()
      if (unsubMigrate) unsubMigrate()
    }
  }, [startupPhase])

  // 监听系统通知 (来自主进程)
  useEffect(() => {
    if (window.electronAPI?.onSystemNotification) {
      const unsubscribe = window.electronAPI.onSystemNotification((data: any) => {
        const { type, message, sticky, id, autoClose, action } = data
        
        // 转换通知参数
        const duration = sticky ? 0 : (autoClose || 3000)

        // 处理 Action
        let toastAction: any = undefined
        if (action) {
          toastAction = {
            label: action.label,
            onClick: () => {
              if (action.category === 'AI_MODEL') {
                useSettingsStore.getState().openSettings(SettingsCategory.AI_MODEL)
              } else if (action.category === 'GENERAL') {
                useSettingsStore.getState().openSettings(SettingsCategory.GENERAL)
              } else {
                useSettingsStore.getState().openSettings()
              }
            }
          }
        }

        switch (type) {
          case 'success':
            toast.success(message, duration, id, toastAction)
            break
          case 'error':
            toast.error(message, duration, id, toastAction)
            break
          case 'warning':
            toast.warning(message, duration, id, toastAction)
            break
          case 'info':
          default:
            toast.info(message, duration, id, toastAction)
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
    // 关键修正：如果正处于配置阶段（如欢迎向导），绝不执行应用级初始化，防止提前启动服务器
    if (startupPhase === 'config') {
      logger.info(LogCategory.RENDERER, '处于配置阶段，跳过应用级初始化程序')
      return
    }

    try {
      setStartupMessage(t('正在初始化应用环境...'))
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
      // 如果初始化过程中发现授权丢失，由 determineStartupPhase 或 onUnauthorized 监听器处理
      // 此处不再强制设为 ready，而是保留当前状态
    }
  }, [checkAIStatus, loadFiles])



  // 监听授权失效通知 (Security Enforcement)
  useEffect(() => {
    if (window.electronAPI?.license?.onUnauthorized) {
      const unsubscribe = window.electronAPI.license.onUnauthorized((result) => {
        logger.warn(LogCategory.RENDERER, '收到授权失效通知，准备刷新页面:', result.status);
        // 如果当前不在 licensing 阶段，强制刷新整个页面以清理环境
        // 这也避免了在启动检测阶段的重复刷新循环
        if (startupPhase !== 'licensing') {
          window.location.reload();
          return;
        }
        setLicenseInfo(result);
        setStartupPhase('licensing');
      });
      return unsubscribe;
    }
    return undefined;
  }, [startupPhase]);

  useEffect(() => {
    determineStartupPhase()
  }, [determineStartupPhase])

  useEffect(() => {
    if (startupPhase === 'initializing') {
      initializeApplication()
    }
  }, [initializeApplication, startupPhase])

  // 监听手动触发的授权检查失败事件 (用于弹窗交互中的验证)
  useEffect(() => {
    const handleManualUnauthorized = (event: any) => {
      const result = event.detail
      logger.warn(LogCategory.RENDERER, '收到手动触发的授权失效事件:', result.status)
      if (startupPhase !== 'licensing') {
        window.location.reload();
        return;
      }
      setLicenseInfo(result)
      setStartupPhase('licensing')
    }

    window.addEventListener('app:unauthorized', handleManualUnauthorized as EventListener)
    return () =>
      window.removeEventListener('app:unauthorized', handleManualUnauthorized as EventListener)
  }, [startupPhase])

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
    return (
      <>
        {renderStartupScreen(t('正在初始化应用'), t('检测配置阶段...'))}
        <ToastContainer />
      </>
    )
  }

  // 移除 initializing 阶段的阻塞遮罩，允许直接进入应用


  if (startupPhase === 'config') {
    return (
      <ErrorBoundary>
        <div className="h-screen w-screen">
          <WelcomeWizard onComplete={() => determineStartupPhase({ ignoreForceFlag: true })} />
        </div>
        <ToastContainer />
      </ErrorBoundary>
    )
  }

  if (startupPhase === 'licensing' && !hasMountedReal && !hasMountedVirtual) {
    return (
      <ErrorBoundary>
        <LicenseGateway
          status={licenseInfo?.status as any}
          error={licenseInfo?.error}
          onActivated={() => {
            logger.info(LogCategory.RENDERER, '授权成功，正在刷新页面...');
            window.location.reload();
          }}
        />
        <ToastContainer />
      </ErrorBoundary>
    )
  }

  return (
    <ErrorBoundary>
      <div className="app h-screen flex flex-col overflow-hidden">
        {startupPhase === 'licensing' && (
          <LicenseGateway
            status={licenseInfo?.status as any}
            error={licenseInfo?.error}
            onActivated={() => {
              logger.info(LogCategory.RENDERER, '授权成功，正在刷新页面...');
              window.location.reload();
            }}
          />
        )}
        <AIClassificationHandler />
        <div className="flex-1 flex flex-col overflow-hidden relative">
          {/* 真实目录视图 - KeepAlive */}
          {hasMountedReal && (
            <div 
              className={cn(
                "absolute inset-0 flex flex-col overflow-hidden transition-opacity duration-200",
                (currentPath === '/' || currentPath === '/real-directory') ? "opacity-100 z-10" : "opacity-0 pointer-events-none z-0"
              )}
            >
              <RealDirectory />
            </div>
          )}

          {/* 虚拟目录视图 - KeepAlive */}
          {hasMountedVirtual && (
            <div 
              className={cn(
                "absolute inset-0 flex flex-col overflow-hidden transition-opacity duration-200",
                currentPath === '/virtual-directory' ? "opacity-100 z-10" : "opacity-0 pointer-events-none z-0"
              )}
            >
              <VirtualDirectory />
            </div>
          )}

          {/* 基础路由占位，确保路由系统正常工作 */}
          <Routes>
            <Route path="/" element={null} />
            <Route path="/real-directory" element={null} />
            <Route path="/virtual-directory" element={null} />
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
            useSettingsStore.getState().openSettings(SettingsCategory.AI_MODEL)
            closeErrorDialog()
          }}
        />

        {/* 模型迁移蒙版 - 仅在非配置阶段显示，欢迎向导有自己的内部蒙版处理 */}
        {isMigrating && startupPhase !== 'config' && (
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-background/80 backdrop-blur-md">
            <Card className="p-8 max-w-md w-full border-2 border-primary/20 shadow-2xl rounded-3xl bg-card animate-in fade-in zoom-in duration-300">
              <div className="flex flex-col items-center text-center space-y-6">
                <div className="relative">
                  <div className="absolute inset-0 bg-primary/20 blur-xl rounded-full animate-pulse"></div>
                  <div className="relative bg-primary/10 p-4 rounded-full">
                    <Loader2 className="h-10 w-10 text-primary animate-spin" />
                  </div>
                </div>
                <div className="space-y-2">
                  <h3 className="text-xl font-black tracking-tight text-foreground">
                    {t('正在迁移模型')}
                  </h3>
                  <p className="text-sm text-muted-foreground font-medium px-4">
                    {migrationProgress || t('正在准备迁移，请稍候...')}
                  </p>
                </div>
                <div className="w-full bg-muted/30 rounded-full h-1.5 overflow-hidden">
                  <div className="bg-primary h-full w-1/3 animate-[loading_2s_ease-in-out_infinite] rounded-full"></div>
                </div>
                <p className="text-[10px] text-muted-foreground/60 font-bold uppercase tracking-widest">
                  {t('请勿关闭应用')}
                </p>
              </div>
            </Card>
          </div>
        )}
      </div>
    </ErrorBoundary>
  )
}

export default App
