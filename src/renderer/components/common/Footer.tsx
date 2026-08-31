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
import { useAIServiceError, useAIServiceStatus } from '@/renderer/stores/ai-service-store'
import { useAnalysisQueueStore } from '@/renderer/stores/analysis-queue-store'
import { useConfigStore } from '@/renderer/stores/config-store'
import { useShallow } from 'zustand/react/shallow'
import { useModelStore } from '@/renderer/stores/model-store'
import { useSettingsStore } from '@/renderer/stores/settings-store'
import { useVirtualDirectoryStore } from '@/renderer/stores/virtual-directory-store'
import { useAnalyzedDirectoryStore } from '@/renderer/stores/analyzed-directory-store'
import { compareVersions, LogCategory, logger, ErrorNormalizer } from '@firefly/shared'
import { getAccelerationTier, extractAccelerationFromBackendDisplay } from '@firefly/shared'
import { PersistentTooltip } from '@/renderer/components/common/PersistentTooltip'

import { getStageLabel } from '@/renderer/components/analysis/AnalysisQueueContent'

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
    backend
  } = useModelStore()
  const { error, openErrorDialog } = useAIServiceError()
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

  const showAiError = serviceStatus === AIServiceStatus.ERROR || !!error
  const errorMessageDisplay = useMemo(() => {
    if (!showAiError) return ''
    const candidate = error || lastError
    if (candidate) {
      if (typeof candidate === 'object') {
        const normalized = ErrorNormalizer.normalize(
          candidate,
          (candidate.code || (candidate as any).type) as any,
          'Footer'
        )
        const completeInfo = ErrorNormalizer.getCompleteErrorInfo(
          normalized.code || (normalized as any).type
        )
        const msg = normalized.details || completeInfo.userMessage || normalized.message
        if (typeof msg === 'string' && msg.trim()) return msg.trim()
        if (msg && typeof msg === 'object') {
          return (msg as any).message || (msg as any).details || t('AI服务异常')
        }
      } else if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim()
      }
    }
    return t('AI服务异常')
  }, [showAiError, error, lastError])

  const workspaceDirectories = useVirtualDirectoryStore(s => s.workspaceDirectories)
  const currentWorkspaceDirectory = useVirtualDirectoryStore(s => s.currentWorkspaceDirectory)
  const setCurrentWorkspaceDirectory = useVirtualDirectoryStore(s => s.setCurrentWorkspaceDirectory)

  const runningWorkspace = useMemo(() => {
    if (!analyzing?.workspaceId) return null
    return workspaceDirectories.find(w => w.id === analyzing.workspaceId) || null
  }, [workspaceDirectories, analyzing?.workspaceId])

  const [displayedProgress, setDisplayedProgress] = useState(0)
  const [animScale, setAnimScale] = useState(0)
  const [enableTransition, setEnableTransition] = useState(true)
  const [displayItem, setDisplayItem] = useState<{
    id: number
    name: string
    workspaceName?: string
    workspaceId?: number
    stage?: number
  } | null>(null)

  const lastIdRef = useRef<number | null>(null)

  useEffect(() => {
    if (analyzing) {
      const progress = analyzing.progress || 0
      const isNewItem = analyzing.id !== lastIdRef.current
      setDisplayedProgress(progress)

      if (isNewItem) {
        lastIdRef.current = analyzing.id
        setDisplayItem({
          id: analyzing.id,
          name: analyzing.name,
          workspaceName: runningWorkspace?.name,
          workspaceId: analyzing.workspaceId,
          stage: analyzing.stage
        })

        // 新文件进入：先瞬时设置该阶段的物理起始点（禁用过渡，消除上个文件的100%残影）
        const mode = config?.analysisMode
        const isSimpleMode = mode === 'simple' || mode === 'sample'
        const isQuickMode = mode === 'quick_name'

        const initialScale =
          analyzing.stage === 4
            ? isQuickMode
              ? 0.25
              : 0.55
            : analyzing.stage === 3
              ? isQuickMode
                ? 0.25
                : 0.2
              : analyzing.stage === 2
                ? 0.01
                : 0
        setEnableTransition(false)
        setAnimScale(initialScale)

        // 下一微任务开启缓动，向阶段目标平滑逼近
        const rAF = requestAnimationFrame(() => {
          setEnableTransition(true)
          const target =
            analyzing.stage === 4
              ? 0.94
              : analyzing.stage === 3
                ? isQuickMode
                  ? 0.94
                  : 0.55
                : analyzing.stage === 2
                  ? isSimpleMode
                    ? 0.98
                    : 0.25
                  : 0.01
          setAnimScale(target)
        })
        return () => cancelAnimationFrame(rAF)
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

        // 同一文件的阶段推进
        setEnableTransition(true)
        const mode = config?.analysisMode
        const isSimpleMode = mode === 'simple' || mode === 'sample'
        const isQuickMode = mode === 'quick_name'

        if (analyzing.stage === 4) {
          setAnimScale(0.94)
        } else if (analyzing.stage === 3) {
          setAnimScale(isQuickMode ? 0.94 : 0.55)
        } else if (analyzing.stage === 2) {
          setAnimScale(isSimpleMode ? 0.98 : 0.25)
        } else {
          setAnimScale(0.01)
        }
      }
    } else if (lastIdRef.current !== null) {
      // 任务在后端已结束，显示 100% 并在短暂展示后彻底清空
      setDisplayedProgress(100)
      setEnableTransition(true)
      setAnimScale(1)
      const timer = setTimeout(() => {
        const currentSnap = useAnalysisQueueStore.getState().snapshot
        if (
          !currentSnap.currentAnalyzingItem &&
          !currentSnap.items.find(i => i.status === 'analyzing')
        ) {
          setDisplayItem(null)
          lastIdRef.current = null
          setDisplayedProgress(0)
          setAnimScale(0)
        }
      }, 800)
      return () => clearTimeout(timer)
    }
  }, [
    analyzing?.progress,
    analyzing?.id,
    analyzing?.stage,
    analyzing === null,
    runningWorkspace?.name
  ])

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
        const safeErrorStr =
          typeof lastError === 'string'
            ? lastError
            : (lastError as any)?.message ||
              (lastError as any)?.details ||
              (error ? ErrorNormalizer.normalize(error, (error.code || (error as any).type) as any, 'Footer').message : '') ||
              t('未知错误')
        return {
          text: t('{modelInfo} 服务异常: {error}', {
            modelInfo,
            error: safeErrorStr
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

  // 最佳可用引擎警告：仅根据记忆的最佳引擎（BEST_ACCELERATION，成功验证过）判断
  // 未记忆（auto 或空）时不显示警告；当当前引擎低于记忆的最佳引擎时提示切换
  const bestAcceleration =
    (config as any)?.bestAcceleration ?? (config as any)?.BEST_ACCELERATION ?? ''
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
                {showAiError && (
                  <div className="mt-0.5">
                    <PersistentTooltip
                      id={`ai_footer_error_${error?.code || (error as any)?.type || 'general'}`}
                      content={t('AI服务出现异常，点击查看详情与修复方案')}
                      position="top"
                      visible={true}
                    >
                      <button
                        className="text-xs leading-tight text-red-500 font-medium transition-all duration-200 hover:underline cursor-pointer flex items-center gap-1 text-left"
                        onClick={openErrorDialog}
                        title={t('点击查看AI服务错误详情')}
                      >
                        <MaterialIcon icon="error_outline" className="text-xs shrink-0 animate-pulse" />
                        <span className="truncate max-w-[320px]">
                          {errorMessageDisplay}，{t('点击查看原因')}
                        </span>
                      </button>
                    </PersistentTooltip>
                  </div>
                )}
                {showRecommendation && (
                  <button
                    className="text-xs leading-tight text-red-500/90 font-medium transition-all duration-200  hover:underline cursor-pointer block"
                    onClick={() => openSettings(SettingsCategory.AI_MODEL)}
                  >
                    {t('检测到您有高性能显卡，请切换更聪明的AI模型，立即设置')}
                  </button>
                )}
                {accelerationBelowBest && (
                  <button
                    onClick={() => openSettings(SettingsCategory.AI_ENGINE_CONFIG)}
                    className="text-yellow-500 text-xs hover:underline cursor-pointer block"
                    title={t('点击前往引擎管理设置最佳可用加速引擎')}
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

      <div className="flex items-center">
        <button
          className="relative overflow-hidden rounded-lg px-2.5 py-1 text-xs font-medium cursor-pointer transition-all border border-border/60 bg-muted/30 hover:bg-muted/60 hover:border-primary/40 dark:border-border/40 dark:bg-card/40 dark:hover:bg-muted/40 shadow-xs flex items-center group"
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
          {/* 背景进度条层：自适应时间与动态阻尼自平衡算法 (Self-Balancing Adaptive Progress) + 思考流光 */}
          {displayItem && (
            <div
              className="absolute inset-0 rounded-lg pointer-events-none overflow-hidden"
              style={{
                transform: `scaleX(${animScale})`,
                transformOrigin: 'left',
                transition: !enableTransition
                  ? 'none'
                  : displayedProgress >= 100
                    ? 'transform 0.35s cubic-bezier(0.2, 0.8, 0.2, 1)'
                    : displayItem.stage === 1
                      ? 'transform 0.15s ease-out'
                      : displayItem.stage === 2
                        ? config?.analysisMode === 'simple' || config?.analysisMode === 'sample'
                          ? 'transform 3.5s cubic-bezier(0.08, 0.82, 0.17, 1)'
                          : 'transform 5.0s cubic-bezier(0.05, 0.7, 0.15, 1)'
                        : displayItem.stage === 3
                          ? 'transform 3.5s cubic-bezier(0.08, 0.82, 0.17, 1)'
                          : 'transform 5.5s cubic-bezier(0.08, 0.82, 0.17, 1)'
              }}
            >
              {/* 进度底色：自适应明暗的双色渐变 */}
              <div className="absolute inset-0 bg-gradient-to-r from-blue-500/15 via-sky-500/20 to-blue-600/20 dark:from-blue-600/25 dark:via-indigo-500/30 dark:to-sky-400/30" />

              {/* AI 思考中流光扫描动效 */}
              <div
                className="absolute inset-0 pointer-events-none opacity-70 dark:opacity-80"
                style={{
                  background:
                    'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.2) 35%, rgba(186,230,253,0.3) 50%, rgba(255,255,255,0.2) 65%, transparent 100%)',
                  backgroundSize: '800px 100%',
                  animation: 'shimmer 2.4s infinite ease-in-out'
                }}
              />

              {/* 头部先导光标线 */}
              <div className="absolute top-0 right-0 bottom-0 w-[2px] bg-gradient-to-b from-sky-400/50 via-sky-400/90 to-sky-400/50 dark:from-sky-300/60 dark:via-white/90 dark:to-sky-300/60 shadow-[0_0_6px_rgba(56,189,248,0.5)]" />
            </div>
          )}

          {/* 前景文字内容 */}
          <span className="relative z-10 text-foreground dark:text-foreground flex items-center gap-1.5">
            {/* 状态指示小圆点 */}
            <span
              className={`inline-block w-1.5 h-1.5 rounded-full transition-colors ${
                displayItem
                  ? 'bg-blue-500 dark:bg-sky-400 animate-pulse shadow-[0_0_6px_rgba(59,130,246,0.6)]'
                  : 'bg-muted-foreground/40'
              }`}
            />

            {displayItem ? (
              <>
                <span className="text-blue-600 dark:text-sky-400 font-semibold tracking-tight">
                  {getStageLabel('analyzing', displayItem.stage)}:
                </span>
                <span className="max-w-[220px] truncate text-foreground/90 font-medium">
                  {displayItem.workspaceName ? `【${displayItem.workspaceName}】` : ''}
                  {displayItem.name}
                </span>
                <span className="text-muted-foreground/40">·</span>
                <span className="text-muted-foreground font-normal">
                  {t('等待: {count}', { count: waiting })}
                </span>
              </>
            ) : isPaused ? (
              <span className="text-yellow-500 font-medium">{t('队列暂停')}</span>
            ) : (
              <>
                <span className="text-muted-foreground font-medium">{t('空闲')}</span>
                <span className="text-muted-foreground/40">·</span>
                <span className="text-muted-foreground font-normal">
                  {t('等待: {count}', { count: waiting })}
                </span>
              </>
            )}
          </span>
        </button>
        <span className="text-xs text-muted-foreground/30 mx-1.5">|</span>
        <button
          onClick={() => openSettings(SettingsCategory.ANALYSIS)}
          className="text-xs text-muted-foreground opacity-60 hover:opacity-100 cursor-pointer transition-opacity"
          title={t('点击打开分析设置')}
        >
          <span
            className={`font-bold px-1.5 py-0.5 rounded ${
              config?.analysisMode === 'simple'
                ? 'text-orange-500 bg-orange-500/10'
                : config?.analysisMode === 'quick_name'
                  ? 'text-blue-500 bg-blue-500/10'
                  : 'text-green-500 bg-green-500/10'
            }`}
          >
            {config?.analysisMode === 'simple'
              ? t('简单分类')
              : config?.analysisMode === 'quick_name'
                ? t('快速命名')
                : t('全面分析')}
          </span>
        </button>
        <span className="text-xs text-muted-foreground/30 mx-1.5">|</span>
        <button
          onClick={() => openSettings(SettingsCategory.AI_ENGINE_CONFIG)}
          className="text-xs text-muted-foreground opacity-60 hover:opacity-100 cursor-pointer transition-opacity"
          title={t('点击打开AI引擎配置')}
        >
          <span className="opacity-50">{t('思考')}:</span>{' '}
          <span
            className={`font-bold px-1.5 py-0.5 rounded ${config?.enableThinkingMode ? 'text-green-500 bg-green-500/10' : 'text-orange-500 bg-orange-500/10'}`}
          >
            {config?.enableThinkingMode ? 'ON' : 'OFF'}
          </span>
        </button>
        <span className="text-xs text-muted-foreground/30 mx-1.5">|</span>
        <span className="text-xs text-muted-foreground opacity-50 pr-2">v{__APP_VERSION__}</span>
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
