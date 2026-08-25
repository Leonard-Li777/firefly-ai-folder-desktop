import './material-icons.css'
import './styles.css'

import { AIServiceErrorDialog, useAIServiceErrorDialog } from './components/ai/AIServiceErrorDialog'
import { LogCategory, logger } from '@firefly/shared'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { cn } from './lib/utils'
import { ToastContainer, toast } from './components/common/Toast'

import { AIClassificationHandler } from './components/ai/AIClassificationHandler'
import { AnalysisQueueModal } from './components/analysis/AnalysisQueueModal'
import { QueueSplitPanel } from './components/analysis/QueueSplitPanel'
import { QueueWindowPage } from './components/analysis/QueueWindowPage'
import { ExtensionReconciliationDialog } from './components/analysis/ExtensionReconciliationDialog'
import { AnalysisConfirmModal } from './components/analysis/AnalysisConfirmModal'
import { ErrorBoundary } from './components/common/ErrorBoundary'
import { FileInfo, SettingsCategory } from '@firefly/types'
import { Footer } from './components/common/Footer'
import { RealDirectory } from './components/file-explorer/RealDirectory'
import { SettingsDialog } from './components/settings'
import { AnalyzedDirectory } from './components/file-explorer/AnalyzedDirectory/index'
import { VirtualDirectory } from './components/file-explorer/VirtualDirectory/index'
import { PreviewOverlay } from './components/file-explorer/PreviewOverlay'
import { SplitPreviewPanel } from './components/file-explorer/SplitPreviewPanel'
import { Organize } from './components/file-explorer/Organize/index'
import { WelcomeWizard } from './components/welcome/WelcomeWizard'
import { InitialSetupOverlay } from './components/welcome/InitialSetupOverlay'
import { LicenseGateway } from './components/license/LicenseGateway'
import { ProActivationPage } from './components/tier/ProActivationPage'
import { EnterpriseActivationPage } from './components/tier/EnterpriseActivationPage'
import { Loader2 } from 'lucide-react'
import { Card } from './components/ui/card'
import { t, i18nScope } from '@app/languages'
import { useAIModelStore } from './stores/app-store'
import { useModelStore } from './stores/model-store'
import { useAIServiceInitialization, useAIServiceStore } from './stores/ai-service-store'
import { useSettingsStore } from './stores/settings-store'
import { useTheme } from './components/ui/theme-provider'
import { useConfigStore, useWelcomeStore } from './stores/config-store'
import { usePreviewOverlayStore } from './stores/preview-overlay-store'
import { useInvitation } from './hooks/useInvitation'
import { useAnalyzedDirectoryStore } from './stores/analyzed-directory-store'
import { useVirtualDirectoryStore } from './stores/virtual-directory-store'
import { useTierStore } from './stores/tier-store'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from './components/ui/alert-dialog'
import { buttonVariants } from './components/ui/button'

type StartupPhase = 'determining' | 'setup' | 'config' | 'licensing' | 'initializing' | 'ready'

const App: React.FC = () => {
  // Initialize invitation system
  useInvitation()

  const location = useLocation()
  const currentPath = location.pathname
  const navigate = useNavigate()

  // Keep-Alive 状态：记录组件是否已经挂载过
  const [hasMountedReal, setHasMountedReal] = useState(false)
  const [hasMountedAnalyzed, setHasMountedAnalyzed] = useState(false)
  const [hasMountedOrganize, setHasMountedOrganize] = useState(false)
  const [hasMountedVirtual, setHasMountedVirtual] = useState(false)
  const [hasMountedProActivation, setHasMountedProActivation] = useState(false)
  const [hasMountedEnterpriseActivation, setHasMountedEnterpriseActivation] = useState(false)

  useEffect(() => {
    if (currentPath === '/' || currentPath === '/real-directory') {
      setHasMountedReal(true)
    } else if (currentPath === '/analyzed-directory') {
      setHasMountedAnalyzed(true)
    } else if (currentPath === '/organize') {
      setHasMountedOrganize(true)
    } else if (currentPath.startsWith('/virtual-directory')) {
      setHasMountedVirtual(true)
    } else if (currentPath === '/pro-activation') {
      setHasMountedProActivation(true)
    } else if (currentPath === '/enterprise-activation') {
      setHasMountedEnterpriseActivation(true)
    }
  }, [currentPath])

  // 监听托盘等触发的打开设置事件，自动调起设置弹窗并切至界面设置
  useEffect(() => {
    const cleanup = window.electronAPI?.onOpenSettings?.(() => {
      useSettingsStore.getState().openSettings(SettingsCategory.INTERFACE)
    })
    return () => {
      cleanup?.()
    }
  }, [])

  // 监听托盘菜单跳转页面路由事件
  useEffect(() => {
    const cleanup = window.electronAPI?.onNavigateRoute?.((route: string) => {
      navigate(route)
    })
    return () => {
      cleanup?.()
    }
  }, [navigate])

  // 同步两个 store 中的 currentWorkspaceDirectory 和 workspaceDirectories，确保所有页面数据一致
  useEffect(() => {
    const isPathEqual = (a?: string, b?: string) => {
      if (!a && !b) return true
      if (!a || !b) return false
      return (window.electronAPI?.utils?.isPathEqual || ((x: string, y: string) => x === y))(a, b)
    }

    const unsubVirtual = useVirtualDirectoryStore.subscribe((state, prevState) => {
      if (
        !isPathEqual(
          state.currentWorkspaceDirectory?.path,
          prevState.currentWorkspaceDirectory?.path
        )
      ) {
        useAnalyzedDirectoryStore
          .getState()
          .setCurrentWorkspaceDirectory(state.currentWorkspaceDirectory)
      }
      if (state.workspaceDirectories !== prevState.workspaceDirectories) {
        useAnalyzedDirectoryStore.getState().setWorkspaceDirectories(state.workspaceDirectories)
      }
    })
    const unsubAnalyzed = useAnalyzedDirectoryStore.subscribe((state, prevState) => {
      if (
        !isPathEqual(
          state.currentWorkspaceDirectory?.path,
          prevState.currentWorkspaceDirectory?.path
        )
      ) {
        useVirtualDirectoryStore
          .getState()
          .setCurrentWorkspaceDirectory(state.currentWorkspaceDirectory)
      }
      if (state.workspaceDirectories !== prevState.workspaceDirectories) {
        useVirtualDirectoryStore.getState().setWorkspaceDirectories(state.workspaceDirectories)
      }
    })

    // 全局初始化和更新工作目录列表监听
    const loadDirectories = async () => {
      try {
        if (typeof window.electronAPI?.getAllWorkspaceDirectories === 'function') {
          const dirs = await window.electronAPI.getAllWorkspaceDirectories()
          useVirtualDirectoryStore.getState().setWorkspaceDirectories(dirs || [])
        }
        if (typeof window.electronAPI?.getCurrentWorkspaceDirectory === 'function') {
          const current = await window.electronAPI.getCurrentWorkspaceDirectory()
          useVirtualDirectoryStore.getState().setCurrentWorkspaceDirectory(current)
        }
      } catch (err) {
        logger.error(LogCategory.RENDERER, '全局初始化加载工作目录列表失败:', err)
      }
    }

    loadDirectories()

    const unsubscribe = window.electronAPI?.onWorkspaceDirectoriesUpdated?.(() => {
      logger.info(LogCategory.RENDERER, '收到工作目录更新事件，全局更新列表并广播 DOM 事件...')
      loadDirectories().then(() => {
        window.dispatchEvent(new CustomEvent('workspace-directories-updated'))
      })
    })

    return () => {
      unsubVirtual()
      unsubAnalyzed()
      if (unsubscribe) unsubscribe()
    }
  }, [])

  const { setTheme } = useTheme()
  const [, setFiles] = useState<FileInfo[]>([])
  const [startupPhase, setStartupPhase] = useState<StartupPhase>(() => {
    if (currentPath === '/preview-window') return 'ready'
    if (typeof window !== 'undefined') {
      const confirmed = localStorage.getItem('languageConfirmed') === 'true'
      return confirmed ? 'initializing' : 'config'
    }
    return 'config'
  })
  const [startupMessage, setStartupMessage] = useState<string>(t('正在准备启动应用...'))
  const [licenseInfo, setLicenseInfo] = useState<{
    status: string
    error?: string
    canOffline?: boolean
  } | null>(null)
  const forceConfigFlagConsumedRef = useRef(false)
  const isWelcomeCompletedRef = useRef(false)
  const [activationConfirm, setActivationConfirm] = useState<{
    modelId: string
    displayName: string
    source?: string
  } | null>(null)

  // AI服务状态管理
  const { initializeAIService } = useAIServiceInitialization()
  const { isOpen: isErrorDialogOpen, closeDialog: closeErrorDialog } = useAIServiceErrorDialog()
  const { isMigrating, setMigrating, migrationProgress, updateConfigValue } = useSettingsStore()
  const { setModelName } = useModelStore()
  const { filePath: previewFilePath } = usePreviewOverlayStore()

  const handleActivateModel = useCallback(async () => {
    if (!activationConfirm) return
    const { modelId, displayName, source } = activationConfirm
    try {
      // 激活模型
      await updateConfigValue('SELECTED_MODEL_ID', modelId, { preventAutoReload: true })
      // 同时保存模型来源（huggingface / modelscope / ollama），以便后端精确查询模型配置
      await updateConfigValue('SELECTED_MODEL_SOURCE', source, { preventAutoReload: true })
      // 获取新激活模型的信息（以便设置正确名字）
      const models = await window.electronAPI.listModels()
      const model = models.find((m: any) => m.id === modelId)
      if (model?.name) {
        setModelName(model.name)
      }
      const { notifyModelChanged } = useAIServiceStore.getState()
      await notifyModelChanged(modelId)
      toast.success(t('已成功激活 {model}', { model: displayName }))
      // 广播激活完成事件，让模型设置页面刷新列表并同步最新下载状态
      window.dispatchEvent(new CustomEvent('app:model-activated', { detail: { modelId } }))
    } catch (error) {
      logger.error(LogCategory.RENDERER, '激活模型失败:', error)
      toast.error(t('激活模型失败'))
    } finally {
      setActivationConfirm(null)
    }
  }, [activationConfirm, updateConfigValue, setModelName])

  // 处理模型下载完成后的激活提示
  const handleDownloadComplete = useCallback(
    async (payload: { modelId: string; source?: string }) => {
      // 仅在就绪阶段才弹出提示，避免干扰欢迎向导
      if (startupPhase !== 'ready') return

      try {
        // 获取模型列表以获取模型名称
        const models = await window.electronAPI.listModels()
        const model = models.find(
          (m: any) => m.id === payload.modelId && (!payload.source || m.source === payload.source)
        )
        const displayName = model?.name || payload.modelId

        setActivationConfirm({
          modelId: payload.modelId,
          displayName,
          source: payload.source
        })
      } catch (error) {
        logger.error(LogCategory.RENDERER, '处理下载完成激活提示失败:', error)
      }
    },
    [startupPhase]
  )

  // 监听模型迁移进度
  useEffect(() => {
    if (!window.electronAPI?.onModelMigrationProgress) return

    const unsubscribe = window.electronAPI.onModelMigrationProgress((message: string) => {
      logger.info(LogCategory.RENDERER, '模型迁移进度:', message)

      if (message === 'preparing') {
        setMigrating(true, t('正在准备迁移模型...'))
      } else if (
        message === 'migrating-builtin-dir' ||
        message.startsWith('migrating-builtin-file:')
      ) {
        setMigrating(true, t('正在迁移系统内置模型...'))
      } else if (message.startsWith('migrating-selected-model:')) {
        setMigrating(true, t('正在优先迁移当前选中的模型...'))
      } else if (message.startsWith('builtin-completed:')) {
        const countStr = message.split(':')[1] || '0'
        const count = parseInt(countStr)
        // 内置模型迁移完成，可以解除蒙版
        setMigrating(false)
        if (count > 0) {
          toast.success(
            t(
              '核心模型迁移成功！还有 {count} 个模型将在后台继续迁移，你可以随时点击“刷新模型列表”查看状态。',
              { count }
            ),
            10000
          )
        } else {
          toast.success(t('核心模型迁移成功！'), 3000)
        }
      } else if (message === 'migration-finished') {
        setMigrating(false)
        toast.success(t('所有模型迁移任务已完成'))
        window.dispatchEvent(new CustomEvent('app:model-migration-finished'))
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
        toast.info(
          t('模型迁移进度：已完成 {count} 个，剩余 {remaining} 个', { count, remaining }),
          3000
        )
      }
    })

    return () => {
      if (unsubscribe) unsubscribe()
    }
  }, [setMigrating])

  // 模型迁移蒙版超时兜底
  // 兜底场景：理论上 builtin-completed / migration-finished / migration-error 三个事件之一必会到达，
  // 但在极端情况下（如主进程文件操作被 Windows 文件锁永久挂起、IPC 事件丢失等），
  // 蒙版可能永远不会消失。这里在 isMigrating 变为 true 时启动一个最长超时定时器，
  // 超时后强制 setMigrating(false) 并提示用户，以避免界面永久卡死。
  // 阈值选择 10 分钟：覆盖大模型文件（10GB+）在普通机械硬盘上跨盘复制的极端情况。
  useEffect(() => {
    if (!isMigrating) return

    const MIGRATION_TIMEOUT_MS = 10 * 60 * 1000
    const startedAt = Date.now()

    logger.info(
      LogCategory.RENDERER,
      `[MigrationMask] 启动 ${MIGRATION_TIMEOUT_MS / 1000}s 超时兜底定时器`
    )

    const timeoutId = window.setTimeout(() => {
      const stillMigrating = useSettingsStore.getState().isMigrating
      if (!stillMigrating) return

      const elapsedSec = Math.floor((Date.now() - startedAt) / 1000)
      logger.warn(
        LogCategory.RENDERER,
        `[MigrationMask] 已等待 ${elapsedSec}s 未收到迁移结束事件，强制关闭蒙版`
      )

      setMigrating(false)
      toast.error(
        t(
          '模型迁移耗时过长（已等待 {seconds} 秒），已自动关闭蒙版。请前往日志查看详情，或检查目标目录文件是否完整。',
          {
            seconds: elapsedSec
          }
        ),
        10000
      )
    }, MIGRATION_TIMEOUT_MS)

    return () => {
      window.clearTimeout(timeoutId)
    }
  }, [isMigrating, setMigrating])

  // 监听模型下载完成事件
  useEffect(() => {
    if (!window.electronAPI) return
    if (startupPhase !== 'ready') return

    const unsubscribeComplete = window.electronAPI.onModelDownloadComplete((payload: any) => {
      logger.info(LogCategory.RENDERER, '收到模型下载完成事件(llama.cpp):', payload)
      handleDownloadComplete({ modelId: payload.modelId, source: payload.source })
    })

    const unsubscribeOllamaStatus = window.electronAPI.onOllamaModelStatusChanged((data: any) => {
      if (data.status === 'downloaded') {
        logger.info(LogCategory.RENDERER, '收到模型下载完成事件(Ollama):', data)
        handleDownloadComplete({ modelId: data.modelId, source: 'ollama' })
      }
    })

    return () => {
      unsubscribeComplete()
      unsubscribeOllamaStatus()
    }
  }, [startupPhase, handleDownloadComplete])

  const determineStartupPhase = useCallback(
    async (options?: { ignoreForceFlag?: boolean }) => {
      if (!window.electronAPI) {
        setStartupPhase('config')
        return
      }

      // 预览窗口不初始化 AI 服务（/preview 和 /preview-window 两个路由都是预览窗口）
      if (currentPath === '/preview' || currentPath === '/preview-window') {
        setStartupPhase('ready')
        return
      }

      // 不再设置 determining 阶段，避免阻塞初始界面或显示主界面占位
      // setStartupPhase('determining')
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
            const status =
              await window.electronAPI!.modelDownload.checkDownloadStatus(selectedModelId)
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
        if (!languageConfirmed) {
          logger.info(LogCategory.RENDERER, '-> 进入配置阶段（语言未确认）')
          setStartupPhase('config')
          return
        } else if (config.isFirstRun) {
          logger.info(LogCategory.RENDERER, '-> 语言已确认但后端认为是首次运行，自动设为非首次运行')
          updateConfigValue('IS_FIRST_RUN', false, { preventAutoReload: true })
        }

        // 3. 授权检查（在模型检查之前执行，确保授权是硬门控）
        setStartupMessage(t('正在验证授权状态...'))
        const licenseResult = await window.electronAPI!.license.getStatus()

        // 获取 tier 数据中的 can_offline 门控
        let canOffline = false
        try {
          const tierStore = useTierStore.getState()
          // 确保 tier 数据已加载
          if (!tierStore.tier || tierStore.isLoading) {
            await tierStore.fetchProfile()
          }
          const { computed_limits } = useTierStore.getState()
          canOffline = computed_limits?.can_offline === true
        } catch (e) {
          logger.warn(LogCategory.RENDERER, '获取 tier 数据失败', e)
        }

        setLicenseInfo({ ...licenseResult, canOffline })

        if (licenseResult.status !== 'AUTHORIZED') {
          logger.warn(
            LogCategory.RENDERER,
            '授权未通过，进入主界面后弹层提示:',
            licenseResult.status
          )
        }

        // 4. 检查模型是否就绪
        if (!hasDownloadedModel) {
          // 如果是从欢迎向导点击完成（ignoreForceFlag为true），即使检测还没就绪也允许继续
          // 这样可以避免因为状态同步延迟导致的重定向循环
          if (options?.ignoreForceFlag) {
            logger.info(
              LogCategory.RENDERER,
              '-> 检测到欢迎向导完成触发，虽然模型未就绪，但允许进入初始化阶段进行深度检查'
            )
            setStartupPhase('initializing')
            return
          }

          // 不再强制用户必须下载模型才能进入主程序，
          // 允许进入主程序，让用户在设置页面处理，或者由后续的 AI 初始化逻辑尝试恢复
          logger.warn(
            LogCategory.RENDERER,
            '-> 模型尚未就绪（本地未下载或云端未配置），但允许继续进入初始化阶段'
          )
          setStartupPhase('initializing')
          return
        }

        localStorage.setItem('languageConfirmed', 'true')
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
    if (typeof window.electronAPI?.onConfigChange === 'function') {
      const unsubscribe = window.electronAPI!.onConfigChange(
        async (config: Record<string, any>) => {
          useSettingsStore.getState().updateConfig(config, { internal: true })
          // 如果同步的配置包含语言变更，应用语言设置
          if (config.language) {
            await i18nScope.change(config.language)
            document.documentElement.lang = config.language
          }
        }
      )
      return () => {
        if (unsubscribe) unsubscribe()
      }
    }
  }, [])

  useEffect(() => {
    const initTheme = async () => {
      try {
        if (window.electronAPI?.getConfig) {
          const config = await window.electronAPI.getConfig()
          await i18nScope.change(config.language)
          document.documentElement.lang = config.language
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
    const unsubscribe = window.electronAPI.onModelNotDownloaded((payload: { modelId?: string }) => {
      const state = useSettingsStore.getState()

      // 0. 如果在当前生命周期内已经完成了欢迎向导，直接忽略可能滞后的未下载事件，防止强制重定向
      if (isWelcomeCompletedRef.current) {
        logger.warn(
          LogCategory.RENDERER,
          '欢迎向导已在当前生命周期内完成，忽略可能滞后的模型未下载事件，防止强制重定向',
          payload
        )
        return
      }

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
      if (startupPhase === 'config' && welcomeStore.currentStep === 4) {
        logger.info(
          LogCategory.RENDERER,
          `当前处于欢迎向导步骤 ${welcomeStore.currentStep}，忽略未下载事件以避免重定向循环`
        )
        return
      }

      logger.warn(LogCategory.RENDERER, '★★★ 收到模型未下载事件，跳转到模型选择页面 ★★★', payload)
      logger.warn(LogCategory.RENDERER, '当前启动阶段:', startupPhase)

      // 核心修复：如果不是首次运行且已经进入应用（ready 或 initializing 阶段），不进行强制跳转到欢迎向导
      // 而是显示提示信息，让用户在设置中处理。这能有效避免切换模型失败时被意外“踢回”欢迎向导的问题。
      const isFirstRun = state.getConfigValue<boolean>('IS_FIRST_RUN')
      if (!isFirstRun && startupPhase !== 'config') {
        logger.warn(LogCategory.RENDERER, '模型未下载/加载失败，但由于不是首次运行，不进行强制跳转')
        // 发送一个全局错误通知，引导用户去设置页面
        toast.warning(
          t('选中的模型文件不存在或加载失败，请在设置中重新配置。'),
          10000,
          'model-load-error',
          {
            label: t('去设置'),
            onClick: () => useSettingsStore.getState().openSettings(SettingsCategory.AI_MODEL)
          }
        )
        return
      }

      // 强制跳转到配置阶段，不管当前处于什么状态
      if (startupPhase !== 'config') {
        logger.warn(LogCategory.RENDERER, '强制跳转到配置阶段')
        useWelcomeStore.getState().setModelMode('local')
        useWelcomeStore.getState().goToStep(1)
        setStartupPhase('config')
        logger.warn(LogCategory.RENDERER, '已执行强制跳转，新的启动阶段: config')
      } else {
        logger.warn(LogCategory.RENDERER, '当前已在配置阶段，忽略未下载事件以保持当前步骤')
      }
    })

    // 监听迁移状态变更，更新冷却时间
    let prevIsMigrating = useSettingsStore.getState().isMigrating
    const unsubMigrate = useSettingsStore.subscribe(state => {
      const isMigrating = state.isMigrating
      if (prevIsMigrating === true && isMigrating === false) {
        lastMigrationEndTimeRef.current = Date.now()
        logger.info(LogCategory.RENDERER, '模型迁移结束，进入事件冷却期')
      }
      prevIsMigrating = isMigrating
    })

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
        const duration = sticky ? 0 : autoClose || 3000

        // 处理 Action
        let toastAction: any = undefined
        if (action) {
          toastAction = {
            label: action.label,
            onClick: () => {
              if (action.category === 'AI_MODEL') {
                useSettingsStore.getState().openSettings(SettingsCategory.AI_MODEL)
              } else if (action.category === 'GENERAL') {
                useSettingsStore.getState().openSettings((SettingsCategory as any).GENERAL)
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

  // AI Skill API — 整理方案应用：监听后端转发的整理方案数据，导航到整理页面
  useEffect(() => {
    if (typeof window.electronAPI?.onApplyOrganizePlan !== 'function') return
    const unsubscribe = window.electronAPI.onApplyOrganizePlan(payload => {
      navigate('/organize', { state: { pendingOrganizePlan: payload } })
    })
    return () => {
      unsubscribe?.()
    }
  }, [navigate])

  // 全局鼠标悬浮事件委托：在普通 truncate/line-clamp 文本实际发生溢出折断时，动态赋予原生 title 提示，零侵入解决省略提示需求
  useEffect(() => {
    const handleMouseOver = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target) return

      // 1. 匹配具有省略特性的常规元素
      const isEllipsisElement =
        target.classList.contains('truncate') ||
        [...target.classList].some(c => c.startsWith('line-clamp-')) ||
        target.hasAttribute('data-overflow-tip')

      if (isEllipsisElement) {
        // 2. 区分单行和多行省略的溢出判断
        const isLineClamp = [...target.classList].some(c => c.startsWith('line-clamp-'))

        const isOverflowing = isLineClamp
          ? target.scrollHeight > target.clientHeight
          : target.scrollWidth > target.clientWidth

        // 3. 动态赋予/移出 title 属性
        const currentText = target.textContent?.trim() || ''
        if (isOverflowing) {
          if (target.getAttribute('title') !== currentText) {
            target.setAttribute('title', currentText)
          }
        } else {
          if (target.hasAttribute('title')) {
            target.removeAttribute('title')
          }
        }
      }
    }

    document.addEventListener('mouseover', handleMouseOver, { passive: true })
    return () => {
      document.removeEventListener('mouseover', handleMouseOver)
    }
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

        // 关键修复：同时更新 useModelStore，Footer 是从 useModelStore 读取服务状态的
        if (aiStatus?.status) {
          useModelStore.getState().setServiceStatus(aiStatus.status)
          useModelStore.getState().setModelMode(aiStatus.modelMode || null)
          useModelStore.getState().setModelName(aiStatus.modelName || null)
          useModelStore.getState().setProvider(aiStatus.provider || null)
          // 关键修复：将 AI 状态的模型显存需求与体积写回 ModelStore，
          // 否则切换模型后 Footer 的"高性能显卡"推荐提示会沿用旧模型信息，
          // 只有收到 ai-model-status-changed 事件才会更新，轮询无法纠正
          useModelStore.getState().setVramRequiredGB(aiStatus.vramRequiredGB)
          useModelStore.getState().setTotalSizeBytes(aiStatus.totalSizeBytes)
        }
      }
    } catch (error) {
      logger.error(LogCategory.RENDERER, '检查AI状态失败:', error)
    }
  }, [])

  const initializeApplication = useCallback(async () => {
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
      // 关键修复：只有当前阶段仍是 initializing 时才设为 ready，
      // 防止 determineStartupPhase 已将阶段改为 licensing 后被覆盖
      setStartupPhase(prev => (prev === 'initializing' ? 'ready' : prev))
    } catch (error) {
      logger.error(LogCategory.RENDERER, '应用初始化失败:', error)
      // 如果初始化过程中发现授权丢失，由 determineStartupPhase 或 onUnauthorized 监听器处理
      // 此处不再强制设为 ready，而是保留当前状态
    }
  }, [checkAIStatus, loadFiles])

  // 监听授权失效通知 (Security Enforcement)
  useEffect(() => {
    if (window.electronAPI?.license?.onUnauthorized) {
      const unsubscribe = window.electronAPI.license.onUnauthorized(result => {
        logger.warn(LogCategory.RENDERER, '收到授权失效通知，准备刷新页面:', result.status)
        // 如果当前不在 licensing 阶段，强制刷新整个页面以清理环境
        // 这也避免了在启动阶段的重复刷新循环
        if (startupPhase !== 'licensing') {
          window.location.reload()
          return
        }
        setLicenseInfo(result)
        setStartupPhase('licensing')
      })
      return () => {
        if (unsubscribe) unsubscribe()
      }
    }
    return undefined
  }, [startupPhase])

  useEffect(() => {
    determineStartupPhase()
  }, [determineStartupPhase])

  useEffect(() => {
    if (startupPhase === 'initializing') {
      initializeApplication()
    }
  }, [initializeApplication, startupPhase])

  // 定期轮询 AI 状态，作为 onModelStatusChanged IPC 事件的回退机制
  // 确保 Footer 始终能正确显示 AI 服务状态
  useEffect(() => {
    if (startupPhase !== 'ready') return

    const pollInterval = setInterval(() => {
      checkAIStatus()
    }, 15000) // 每15秒轮询一次

    return () => clearInterval(pollInterval)
  }, [startupPhase, checkAIStatus])

  // 注册后台萤火变更通知监听
  useEffect(() => {
    if (startupPhase !== 'ready') return
    useTierStore.getState().registerProfileListener()
  }, [startupPhase])

  // 监听手动触发的授权检查失败事件 (用于弹窗交互中的验证)
  useEffect(() => {
    const handleManualUnauthorized = (event: any) => {
      const result = event.detail
      logger.warn(LogCategory.RENDERER, '收到手动触发的授权失效事件:', result.status)
      if (startupPhase !== 'licensing') {
        window.location.reload()
        return
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

  // 移除 initializing 阶段的阻塞遮罩，允许直接进入应用
  // 并移除 licensing 阶段的阻塞全屏，改为进入主界面后弹层提示

  // 仅在 config 阶段显示欢迎向导进行语言选择
  if (startupPhase === 'config') {
    return (
      <ErrorBoundary>
        <div className="h-screen w-screen relative">
          <WelcomeWizard
            onComplete={() => {
              isWelcomeCompletedRef.current = true
              localStorage.setItem('languageConfirmed', 'true')
              // 立即进入初始化阶段，隐藏欢迎向导；后台异步执行授权/模型检查
              setStartupPhase('initializing')
              determineStartupPhase({ ignoreForceFlag: true })
            }}
          />
        </div>
        <ToastContainer />
      </ErrorBoundary>
    )
  }

  // 进入主界面后，如果授权未通过则显示弹层
  const showLicenseOverlay = licenseInfo?.status != null && licenseInfo.status !== 'AUTHORIZED'

  return (
    <ErrorBoundary>
      <div className="app h-screen flex flex-col overflow-hidden">
        {showLicenseOverlay && (
          <LicenseGateway
            status={licenseInfo?.status as any}
            error={licenseInfo?.error}
            canOffline={licenseInfo?.canOffline}
            onActivated={() => {
              logger.info(LogCategory.RENDERER, '授权成功，正在刷新页面...')
              window.location.reload()
            }}
          />
        )}
        <AIClassificationHandler />
        <div className="flex-1 flex flex-col overflow-hidden relative">
          {/* 整理视图 - KeepAlive */}
          {hasMountedOrganize && (
            <div
              className={cn(
                'absolute inset-0 flex flex-col overflow-hidden transition-opacity duration-200',
                currentPath === '/organize'
                  ? 'opacity-100 z-10'
                  : 'opacity-0 pointer-events-none z-0'
              )}
            >
              <Organize />
            </div>
          )}

          {/* 真实目录视图 - KeepAlive */}
          {hasMountedReal && (
            <div
              className={cn(
                'absolute inset-0 flex flex-col overflow-hidden transition-opacity duration-200',
                currentPath === '/' || currentPath === '/real-directory'
                  ? 'opacity-100 z-10'
                  : 'opacity-0 pointer-events-none z-0'
              )}
            >
              <RealDirectory />
            </div>
          )}

          {/* 已分析视图 - KeepAlive */}
          {hasMountedAnalyzed && (
            <div
              className={cn(
                'absolute inset-0 flex flex-col overflow-hidden transition-opacity duration-200',
                currentPath === '/analyzed-directory'
                  ? 'opacity-100 z-10'
                  : 'opacity-0 pointer-events-none z-0'
              )}
            >
              <AnalyzedDirectory />
            </div>
          )}

          {/* 虚拟目录视图 - KeepAlive */}
          {hasMountedVirtual && (
            <div
              className={cn(
                'absolute inset-0 flex flex-col overflow-hidden transition-opacity duration-200',
                currentPath.startsWith('/virtual-directory')
                  ? 'opacity-100 z-10'
                  : 'opacity-0 pointer-events-none z-0'
              )}
            >
              <VirtualDirectory />
            </div>
          )}



          {/* Pro 开通页面 - KeepAlive */}
          {hasMountedProActivation && (
            <div
              className={cn(
                'absolute inset-0 flex flex-col overflow-hidden transition-opacity duration-200',
                currentPath === '/pro-activation'
                  ? 'opacity-100 z-[60]'
                  : 'opacity-0 pointer-events-none z-0'
              )}
            >
              <ProActivationPage />
            </div>
          )}

          {/* 企业版开通页面 - KeepAlive */}
          {hasMountedEnterpriseActivation && (
            <div
              className={cn(
                'absolute inset-0 flex flex-col overflow-hidden transition-opacity duration-200',
                currentPath === '/enterprise-activation'
                  ? 'opacity-100 z-[60]'
                  : 'opacity-0 pointer-events-none z-0'
              )}
            >
              <EnterpriseActivationPage />
            </div>
          )}

          {/* 基础路由占位，确保路由系统正常工作 */}
          <Routes>
            <Route path="/" element={null} />
            <Route path="/real-directory" element={null} />
            <Route path="/analyzed-directory" element={null} />
            <Route path="/organize" element={null} />
            <Route path="/virtual-directory" element={null} />
            <Route path="/virtual-directory/export" element={null} />
            <Route path="/preview-window" element={null} />
            <Route path="/pro-activation" element={null} />
            <Route path="/enterprise-activation" element={null} />
            <Route path="/queue-window" element={<QueueWindowPage />} />
          </Routes>
        </div>
        <QueueSplitPanel />
        <Footer />
        <AnalysisQueueModal />
        <ExtensionReconciliationDialog />
        <AnalysisConfirmModal />
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
          onSwitchToCloud={() => {
            useSettingsStore.getState().openSettings(SettingsCategory.AI_MODEL)
            useSettingsStore
              .getState()
              .updateConfigValue('AI_SERVICE_MODE', 'cloud', { preventAutoReload: true })
            closeErrorDialog()
          }}
        />

        {/* 模型激活确认对话框 */}
        <AlertDialog
          open={!!activationConfirm}
          onOpenChange={open => !open && setActivationConfirm(null)}
        >
          <AlertDialogContent className="max-w-md rounded-2xl p-6 border bg-background/95 backdrop-blur-xl shadow-2xl">
            <AlertDialogHeader className="space-y-3">
              <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
                <span className="material-icons text-2xl">download_done</span>
              </div>
              <AlertDialogTitle className="text-xl font-bold text-center text-foreground">
                {t('下载完成')}
              </AlertDialogTitle>
              <AlertDialogDescription className="text-sm text-muted-foreground text-center font-medium">
                {activationConfirm &&
                  t('{model} 模型已下载完成，是否立即激活？', {
                    model: activationConfirm.displayName
                  })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter className="mt-6 flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2">
              <AlertDialogCancel
                onClick={() => setActivationConfirm(null)}
                className={cn(buttonVariants({ variant: 'secondary' }), 'w-full sm:w-auto')}
              >
                {t('稍后再说')}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={handleActivateModel}
                className={cn(buttonVariants({ variant: 'default' }), 'w-full sm:w-auto')}
              >
                {t('立即激活')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {/* 模型迁移蒙版 -仅在非配置阶段显示，欢迎向导有自己的内部蒙版处理 */}
        {isMigrating && (startupPhase as string) !== 'config' && (
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
      <PreviewOverlay />
    </ErrorBoundary>
  )
}

export default App
