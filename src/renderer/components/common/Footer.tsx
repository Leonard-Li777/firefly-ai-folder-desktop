import { AIServiceStatus, HardwareInfo, SettingsCategory } from '@firefly/types'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/renderer/components/ui/dialog'
import React, { useEffect, useMemo, useState, useRef } from 'react'

import { Button } from '@/renderer/components/ui/button'
import { MaterialIcon } from '@/renderer/lib/utils'
import { t } from '@app/languages'
import { openExternalLink } from '@/renderer/lib/external-link'
import { useAIServiceStatus } from '@/renderer/stores/ai-service-store'
import { useAnalysisQueueStore } from '@/renderer/stores/analysis-queue-store'
import { useConfigStore } from '@/renderer/stores/config-store'
import { useShallow } from 'zustand/react/shallow'
import { useModelStore } from '@/renderer/stores/model-store'
import { useSettingsStore } from '@/renderer/stores/settings-store'
import { useVirtualDirectoryStore } from '@/renderer/stores/virtual-directory-store'
import { useAnalyzedDirectoryStore } from '@/renderer/stores/analyzed-directory-store'
import { compareVersions, LogCategory, logger } from '@firefly/shared'
import { getAccelerationTier, extractAccelerationFromBackendDisplay } from '@firefly/shared'

import { getStageLabel } from '@/renderer/components/analysis/AnalysisQueueContent'
import { link } from 'fs'

/**
 * 应用底部状态栏组件
 */
export function Footer() {
  const {
    modelName,
    serviceStatus,
    modelMode,
    lastError,
    provider,
    vramRequiredGB,
    totalSizeBytes,
    backend,
    bestAcceleration: bestAccelerationRef
  } = useModelStore()
  const toggleQueue = useAnalysisQueueStore(s => s.toggleQueue)
  const isPaused = useAnalysisQueueStore(s => s.snapshot?.status === 'paused')
  const analyzing = useAnalysisQueueStore(
    useShallow(s => {
      const item =
        s.snapshot?.currentAnalyzingItem || s.snapshot?.items?.find(i => i.status === 'analyzing')
      if (!item) return null
      return {
        id: item.id,
        progress: item.progress,
        name: item.name,
        workspaceId: item.workspaceId,
        stage: item.analysisStage ?? (item.analysisStats as any)?.analysis_stage ?? 0
      }
    })
  )
  const waiting = useAnalysisQueueStore(
    s => s.snapshot?.items?.filter(i => i.status === 'pending').length || 0
  )
  const { config } = useConfigStore()
  const { openSettings } = useSettingsStore()
  const [showUpdateModal, setShowUpdateModal] = useState(false)
  const { capabilities } = useAIServiceStatus()
  const [hardwareInfo, setHardwareInfo] = useState<HardwareInfo | null>(null)
  const [licenseType, setLicenseType] = useState<string | null>(null)

  const workspaceDirectories = useVirtualDirectoryStore(s => s.workspaceDirectories)
  const currentWorkspaceDirectory = useVirtualDirectoryStore(s => s.currentWorkspaceDirectory)
  const setCurrentWorkspaceDirectory = useVirtualDirectoryStore(s => s.setCurrentWorkspaceDirectory)

  const runningWorkspace = useMemo(() => {
    if (!analyzing?.workspaceId) return null
    return workspaceDirectories.find(w => w.id === analyzing.workspaceId) || null
  }, [workspaceDirectories, analyzing?.workspaceId])

  const [displayedProgress, setDisplayedProgress] = useState(0)
  const [displayItem, setDisplayItem] = useState<{
    id: number
    name: string
    workspaceName?: string
    workspaceId?: number
    stage?: number
  } | null>(null)

  const lastIdRef = useRef<number | null>(null)
  const targetRef = useRef(0)

  // 预测速率估算器
  const rateRef = useRef(0.03) // 默认初始速率调高，增加响应感
  const lastUpdateRef = useRef({ time: Date.now(), progress: 0 })

  useEffect(() => {
    if (analyzing) {
      const now = Date.now()
      const target = analyzing.progress || 0

      if (analyzing.id !== lastIdRef.current) {
        setDisplayedProgress(0)
        lastIdRef.current = analyzing.id
        setDisplayItem({
          id: analyzing.id,
          name: analyzing.name,
          workspaceName: runningWorkspace?.name,
          workspaceId: analyzing.workspaceId,
          stage: analyzing.stage
        })
        rateRef.current = 0.03
        lastUpdateRef.current = { time: now, progress: 0 }
      } else {
        if (
          displayItem &&
          (displayItem.stage !== analyzing.stage ||
            (runningWorkspace?.name && !displayItem.workspaceName))
        ) {
          setDisplayItem(prev =>
            prev
              ? {
                  ...prev,
                  stage: analyzing.stage,
                  workspaceName: runningWorkspace?.name || prev.workspaceName
                }
              : null
          )
        }
        if (target > lastUpdateRef.current.progress) {
          const timeDiff = now - lastUpdateRef.current.time
          const progressDiff = target - lastUpdateRef.current.progress

          if (timeDiff > 300) {
            // 缩短采样窗口到 300ms，快速响应性能变化
            const measuredRatePerFrame = (progressDiff / timeDiff) * (1000 / 60)
            rateRef.current = Math.min(0.25, Math.max(0.01, measuredRatePerFrame * 0.75))
          }
          lastUpdateRef.current = { time: now, progress: target }
        }
      }

      targetRef.current = target
    } else if (lastIdRef.current !== null) {
      // 【完赛算法】任务在后端已结束，但前端必须跑完 100%
      targetRef.current = 100

      // 动画真正跑完 100 后，短暂展示结果然后彻底清空
      if (displayedProgress >= 99.9) {
        const timer = setTimeout(() => {
          // 确保延迟期间没有新任务开始
          const currentSnap = useAnalysisQueueStore.getState().snapshot
          if (
            !currentSnap.currentAnalyzingItem &&
            !currentSnap.items.find(i => i.status === 'analyzing')
          ) {
            setDisplayItem(null)
            lastIdRef.current = null
            setDisplayedProgress(0)
            targetRef.current = 0
          }
        }, 800)
        return () => clearTimeout(timer)
      }
    }
  }, [
    analyzing?.progress,
    analyzing?.id,
    analyzing === null,
    displayedProgress >= 99.9,
    runningWorkspace?.name
  ])

  useEffect(() => {
    let animationFrame: number
    const animate = () => {
      setDisplayedProgress(prev => {
        if (isPaused && targetRef.current < 100) {
          return prev
        }

        const target = targetRef.current

        if (target === 100) {
          if (prev < 100) {
            const diff = 100 - prev
            const step = Math.max(0.1, diff * 0.1)
            const next = prev + step
            return next >= 100 ? 100 : next
          }
          return 100
        }

        if (prev < target) {
          // 正常的插值追赶目标
          const diff = target - prev
          // 动态追赶速度：提升系数 (0.03 -> 0.05) 以匹配 0.3s 左右的响应感
          const catchUpFactor = target === 100 ? 0.08 : 0.05
          const step = Math.max(0.1, diff * catchUpFactor)
          const next = prev + step
          return next >= target ? target : next
        } else if (target > 0 && target < 100) {
          // 核心优化：使用预测速率模拟增长，使 67% 到 98% 之间有真实速率的动态反馈
          const crawlRate = rateRef.current
          const next = prev + crawlRate
          // 限制爬行上限，避免在后端真正完成前跑太快
          const limit = Math.min(99.8, target + 30)
          return next >= limit ? limit : next
        }

        return prev
      })
      animationFrame = requestAnimationFrame(animate)
    }
    animationFrame = requestAnimationFrame(animate)
    return () => cancelAnimationFrame(animationFrame)
  }, [])

  useEffect(() => {
    if (window.electronAPI) {
      window.electronAPI.getHardwareInfo().then(setHardwareInfo)

      if (window.electronAPI.license?.getStatus) {
        window.electronAPI.license.getStatus().then((result: any) => {
          setLicenseType(result.type || null)
        })
      }
    }
  }, [])

  // 服务切换/初始化等过渡状态：此期间模型信息可能仍是旧模型，不应展示推荐提示
  const isModelTransitioning =
    serviceStatus === AIServiceStatus.RESTARTING ||
    serviceStatus === AIServiceStatus.INITIALIZING ||
    serviceStatus === AIServiceStatus.LOADING ||
    serviceStatus === AIServiceStatus.CONNECTING ||
    serviceStatus === AIServiceStatus.STOPPED ||
    serviceStatus === AIServiceStatus.PENDING ||
    serviceStatus === AIServiceStatus.CONFIGURING

  const shouldShowRecommendation = useMemo(() => {
    if (!hardwareInfo || modelMode !== 'local' || vramRequiredGB === undefined) return false

    // 服务切换/初始化期间不展示推荐，避免沿用旧模型信息造成误导
    if (isModelTransitioning) return false

    // 如果用户切换到 totalSize >= 1G 的模型，就不再显示推荐
    // 1GB = 1024 * 1024 * 1024 bytes
    if (totalSizeBytes && totalSizeBytes >= 1073741824) {
      return false
    }

    // 如果 VRAM >= 4G 且当前选择的模型显存需求 <= 2G，显示推荐
    const totalVram = hardwareInfo.vramGB || 0
    return totalVram >= 4 && vramRequiredGB <= 2
  }, [hardwareInfo, modelMode, vramRequiredGB, totalSizeBytes, isModelTransitioning])

  // 控制推荐提示的显示，每次启动时显示，超过1分钟自动隐藏
  const [showRecommendation, setShowRecommendation] = useState(false)

  useEffect(() => {
    if (shouldShowRecommendation) {
      setShowRecommendation(true)
      // 1分钟后自动隐藏
      const timer = setTimeout(
        () => {
          setShowRecommendation(false)
        },
        20 * 60 * 1000
      )
      return () => clearTimeout(timer)
    } else {
      setShowRecommendation(false)
    }
  }, [shouldShowRecommendation])

  const currentVersion = __APP_VERSION__
  // 同时检查小写和大写，以防同步映射逻辑由于某种原因没能正确应用
  const nextVersion = config?.nextVersion || (config as any)?.NEXT_VERSION

  // 检查是否有新版本 (nextVersion > currentVersion)
  const hasUpdate = !!(
    nextVersion &&
    nextVersion.version &&
    compareVersions(nextVersion.version, currentVersion) === 1
  )

  function getFooterDisplay(status: AIServiceStatus) {
    const isCompatible =
      modelMode === 'local' &&
      (!!(
        config?.aiEngineDriverCompatibleMode || (config as any)?.AI_ENGINE_DRIVER_COMPATIBLE_MODE
      ) ||
        (typeof backend === 'string' && backend.toLowerCase().includes('vulkan')))
    const isForceCpu =
      modelMode === 'local' &&
      !!(config?.aiEngineForceCpuMode || (config as any)?.AI_ENGINE_FORCE_CPU_MODE)
    const modeName = modelMode === 'local' ? t('本地') : t('云端')
    const compatibleLabel = isCompatible ? t('兼容模式') + '-' : ''
    const cpuLabel = isForceCpu ? t('兼容模式') + '-' : ''
    const backendLabel = modelMode === 'local' && backend ? ` ${backend}` : ''
    const header = `[${modeName}]${cpuLabel}${compatibleLabel && !isForceCpu ? compatibleLabel : ''}${backendLabel}`
    let modelInfo = header

    if (modelMode === 'cloud') {
      const displayProvider = provider || ''

      if (displayProvider && modelName) {
        modelInfo = `${header} ${displayProvider} - ${modelName}`
      } else if (modelName) {
        modelInfo = `${header} ${modelName}`
      }
    } else if (modelMode === 'local' && modelName) {
      // 优化：在本地模式下，如果提供商不是 'local' 或 'unknown'，则也显示提供商名称（如 Ollama）
      const displayProvider =
        provider && provider !== 'local' && provider !== 'unknown' ? provider : ''
      if (displayProvider) {
        modelInfo = `${header} ${displayProvider} - ${modelName}`
      } else {
        modelInfo = `${header} ${modelName}`
      }
    }

    if (capabilities) {
      const supportedTypes = []
      if (capabilities.supportsImage) supportedTypes.push(t('图片'))
      if (capabilities.supportsAudio) supportedTypes.push(t('音频'))
      if (capabilities.supportsVideo) supportedTypes.push(t('视频'))
      if (supportedTypes.length > 0) {
        modelInfo += `[${t('支持')}: ${supportedTypes.join('、')}]`
      }
    }

    switch (status) {
      case AIServiceStatus.UNINITIALIZED:
        return {
          text: t('AI 服务未就绪'),
          icon: 'radio_button_unchecked',
          color: 'text-gray-400'
        }
      case AIServiceStatus.CONFIGURING:
        return {
          text: t('正在配置 AI 服务...'),
          icon: 'settings',
          color: 'text-blue-400',
          animate: 'animate-spin'
        }
      case AIServiceStatus.INITIALIZING:
        return {
          text: t('正在初始化 AI 引擎...'),
          icon: 'sync',
          color: 'text-blue-500',
          animate: 'animate-spin'
        }
      case AIServiceStatus.RESTARTING:
        return {
          text: t('正在重启 AI 服务...'),
          icon: 'restart_alt',
          color: 'text-orange-400',
          animate: 'animate-spin'
        }
      case AIServiceStatus.STOPPED:
        return {
          text: t('AI 服务已停止'),
          icon: 'stop_circle',
          color: 'text-gray-500'
        }
      case AIServiceStatus.PENDING:
        return {
          text:
            modelMode === 'local'
              ? t('{modelInfo} 模型已就绪，等待加载', { modelInfo })
              : t('{modelInfo} 配置已加载，等待连接', { modelInfo }),
          icon: 'pause_circle_outline',
          color: 'text-blue-500'
        }
      case AIServiceStatus.LOADING:
        return {
          text: t('{modelInfo} 模型资源加载中...', { modelInfo }),
          icon: 'downloading',
          color: 'text-yellow-500',
          animate: 'animate-pulse'
        }
      case AIServiceStatus.CONNECTING:
        return {
          text: t('{modelInfo} 正在测试服务连接...', { modelInfo }),
          icon: 'swap_calls',
          color: 'text-orange-500',
          animate: 'animate-bounce'
        }
      case AIServiceStatus.IDLE:
        return {
          text: t('{modelInfo} AI 服务就绪', { modelInfo }),
          icon: 'check_circle',
          color: 'text-green-500'
        }
      case AIServiceStatus.PROCESSING:
        return {
          text: t('{modelInfo} AI 分析进行中...', { modelInfo }),
          icon: 'auto_awesome',
          color: 'text-purple-500',
          animate: 'animate-pulse'
        }

      case AIServiceStatus.ERROR:
        return {
          text: t('{modelInfo} 服务异常: {error}', {
            modelInfo,
            error: lastError || t('未知错误')
          }),
          icon: 'error_outline',
          color: 'text-red-500'
        }
      default:
        return {
          text: t('状态未知'),
          icon: 'help',
          color: 'text-gray-500'
        }
    }
  }

  const aiServiceInfo = getFooterDisplay(serviceStatus)

  // 最佳可用引擎警告：应用启动后检测当前加速引擎是否低于"最佳可用引擎"参考值
  // 参考值 = 较优者（主进程计算并广播的融合值 bestAccelerationRef，记忆的 BEST_ACCELERATION）
  // 当 SELECTED_ACCELERATION 非最佳时，对厂商引擎文案（如 NVIDIA(cpu)）标红并提示一键切换
  const memoryBest = (config as any)?.bestAcceleration ?? (config as any)?.BEST_ACCELERATION ?? ''
  const bestAcceleration =
    getAccelerationTier(bestAccelerationRef) >= getAccelerationTier(memoryBest)
      ? bestAccelerationRef || ''
      : memoryBest
  const currentAcceleration = extractAccelerationFromBackendDisplay(backend)
  const accelerationBelowBest = useMemo(() => {
    if (
      modelMode !== 'local' ||
      !currentAcceleration ||
      !bestAcceleration ||
      bestAcceleration === 'auto'
    ) {
      return false
    }
    return getAccelerationTier(currentAcceleration) < getAccelerationTier(bestAcceleration)
  }, [modelMode, currentAcceleration, bestAcceleration])

  const handleSwitchToBestAcceleration = async () => {
    if (!bestAcceleration || bestAcceleration === 'auto') return
    try {
      if (typeof window.electronAPI?.aiService?.switchAccelerationBackend === 'function') {
        await window.electronAPI.aiService.switchAccelerationBackend(bestAcceleration)
      }
    } catch (e) {
      logger.error(LogCategory.RENDERER, '切换最佳可用引擎失败', e)
    }
  }

  const handleQueueButtonClick = async () => {
    try {
      if (
        displayItem?.workspaceId &&
        runningWorkspace &&
        currentWorkspaceDirectory?.id !== displayItem.workspaceId
      ) {
        if (typeof window.electronAPI?.setCurrentWorkspaceDirectory === 'function') {
          await window.electronAPI.setCurrentWorkspaceDirectory(runningWorkspace.path)
        }
        useVirtualDirectoryStore.getState().setCurrentWorkspaceDirectory(runningWorkspace)
        useAnalyzedDirectoryStore.getState().setCurrentWorkspaceDirectory(runningWorkspace)
        window.dispatchEvent(new CustomEvent('workspace-directories-updated'))
      }
    } catch (e) {
      logger.error(LogCategory.RENDERER, '分析队列按钮：切换工作区失败', e)
    }
    toggleQueue()
  }

  return (
    <footer className="bg-card border-t border-border px-6 py-3 flex justify-between items-center text-sm text-foreground">
      <div className="flex items-center gap-4">
        <div className="flex items-center space-x-6">
          <div className="flex items-center space-x-2 group">
            <MaterialIcon
              icon={aiServiceInfo.icon}
              className={`${aiServiceInfo.color} ${aiServiceInfo.animate || ''} text-sm`}
            />
            <div>
              <button
                className={`${
                  aiServiceInfo.color
                } transition-all duration-200 hover:underline cursor-pointer`}
                onClick={() => openSettings(SettingsCategory.AI_MODEL)}
              >
                {' '}
                {aiServiceInfo.text}
              </button>
              <div>
                {showRecommendation && (
                  <button
                    className="text-xs leading-tight text-red-500/90 font-medium transition-all duration-200  hover:underline cursor-pointer"
                    onClick={() => openSettings(SettingsCategory.AI_MODEL)}
                  >
                    {t('检测到您有高性能显卡，请切换更聪明的AI模型，立即设置')}
                  </button>
                )}
                {accelerationBelowBest && (
                  <button
                    onClick={handleSwitchToBestAcceleration}
                    className="text-yellow-500 text-xs hover:underline cursor-pointer"
                    title={t('点击切换最佳可用加速引擎')}
                  >
                    {t('警告：{current}非最佳可用引擎，请点击切换{best}！', {
                      current: currentAcceleration,
                      best: bestAcceleration
                    })}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
      <Dialog open={showUpdateModal} onOpenChange={setShowUpdateModal}>
        <DialogContent className="max-w-[650px] w-full">
          <DialogHeader className="text-foreground/80">
            <DialogTitle className="flex items-center gap-2">
              <MaterialIcon icon="update" className="text-blue-500" />
              {t('萤核智能文件夹 - 更新日志')}
            </DialogTitle>
          </DialogHeader>

          <div className="py-4">
            <div className="text-sm font-medium mb-3 text-muted-foreground">
              {t('最新版本: v{version}', { version: nextVersion?.version })}
            </div>
            <div className="rounded-md border p-4 bg-muted/30 text-sm">
              <ul className="space-y-2 list-disc pl-4 text-foreground/80">
                {nextVersion?.releaseNotes?.map((note: string, index: number) => (
                  <li key={index} className="leading-relaxed">
                    {note}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <DialogFooter className="flex gap-2 sm:justify-end">
            <Button
              variant="ghost"
              onClick={() => setShowUpdateModal(false)}
              className="text-foreground/80"
            >
              {t('稍后再说')}
            </Button>
            <Button
              className="bg-blue-600 hover:bg-blue-700 text-white"
              onClick={() => {
                openExternalLink('https://aifolder.iocn.cn/download', {
                  errorTitle: t('无法打开下载页面')
                })
                setShowUpdateModal(false)
              }}
            >
              <MaterialIcon icon="download" className="mr-2 h-4 w-4" />
              {t('去官网下载新版')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex items-center gap-2">
        <button
          className="text-foreground dark:text-foreground hover:underline cursor-pointer transition-colors"
          onClick={handleQueueButtonClick}
          title={
            displayItem
              ? t('查看分析队列 - 当前: {ws}{name}', {
                  ws: displayItem.workspaceName ? `【${displayItem.workspaceName}】` : '',
                  name: displayItem.name
                })
              : t('查看分析队列 - {count} 个文件等待中', { count: waiting })
          }
        >
          {displayItem
            ? t('{stageText}: {ws}{name} · 进度: {progress}%', {
                stageText: getStageLabel('analyzing', displayItem.stage),
                ws: displayItem.workspaceName ? `【${displayItem.workspaceName}】` : '',
                name: displayItem.name,
                progress: Math.floor(displayedProgress)
              })
            : t('空闲')}{' '}
          · {t('等待: {count}', { count: waiting })}
        </button>
        <span className="text-xs text-muted-foreground/30 mx-1.5">|</span>
        <button
          onClick={() => openSettings(SettingsCategory.ANALYSIS)}
          className="text-xs text-muted-foreground opacity-60 hover:opacity-100 cursor-pointer transition-opacity border-r border-muted-foreground/20 pr-2"
          title={t('点击打开分析设置')}
        >
          <span className="opacity-50">{t('分析模式')}:</span>{' '}
          <span
            className={`font-bold px-1.5 py-0.5 rounded ${
              config?.analysisMode === 'simple'
                ? 'text-orange-500 bg-orange-500/10'
                : 'text-green-500 bg-green-500/10'
            }`}
          >
            {config?.analysisMode === 'simple' ? t('简单分类') : t('AI分析')}
          </span>
        </button>
        <span className="text-xs text-muted-foreground/30 mx-1.5">|</span>
        <button
          onClick={() => openSettings(SettingsCategory.AI_ENGINE_CONFIG)}
          className="text-xs text-muted-foreground opacity-60 hover:opacity-100 cursor-pointer transition-opacity border-r border-muted-foreground/20 pr-2"
          title={t('点击打开AI引擎配置')}
        >
          <span className="opacity-50">{t('思考')}:</span>{' '}
          <span
            className={`font-bold px-1.5 py-0.5 rounded ${config?.enableThinkingMode ? 'text-green-500 bg-green-500/10' : 'text-orange-500 bg-orange-500/10'}`}
          >
            {config?.enableThinkingMode ? 'ON' : 'OFF'}
          </span>
        </button>
        <span className="text-xs text-muted-foreground opacity-50 ml-2">v{__APP_VERSION__}</span>
        {hasUpdate && (
          <button
            onClick={() => setShowUpdateModal(true)}
            className="flex items-center gap-1.5 px-3 py-1 bg-blue-500/10 hover:bg-blue-500/20 text-blue-500 rounded-full transition-all duration-300 animate-pulse border border-blue-500/20 group cursor-pointer"
          >
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
            </span>
            <span className="font-medium">
              ⚡️ {t('发现新版本 v{version}', { version: nextVersion.version })}
            </span>
          </button>
        )}
      </div>
    </footer>
  )
}
