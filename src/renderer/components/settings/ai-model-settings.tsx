import {
  AlertCircle,
  Cloud,
  Cpu,
  Download,
  Globe,
  HardDrive,
  Info,
  Loader2,
  RefreshCw,
  Server,
  Sparkles,
  Star,
  Trash2,
  Zap
} from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../ui/alert-dialog'
import { Button, buttonVariants } from '../ui/button'
import { HardwareInfo, IModelSummary, TModelSource } from '@firefly/types'
import {
  LogCategory,
  MODEL_SOURCES,
  formatFileSize,
  groupAndSortModels,
  logger,
  validateModelPath
} from '@firefly/shared'
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'

import { Badge } from '../ui/badge'
import { Card } from '../ui/card'
import { CloudModelConfigSettings } from './cloud-model-config-settings'
import { InitialSetupOverlay } from '../welcome/InitialSetupOverlay'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { ModelDownloadProgress } from '../download/ModelDownloadProgress'
import { cn } from '../../lib/utils'
import { openExternalLink } from '../../lib/external-link'
import { t } from '@app/languages'
import { useVoerkaI18n } from '@voerkai18n/react'
import i18nScope from '@src/languages'
import { toast } from '../common/Toast'
import { useAIServiceStore } from '../../stores/ai-service-store'
import { useModelDownload } from '../../hooks/use-model-download'
import { useModelStore } from '../../stores/model-store'
import { useSettingsStore } from '../../stores/settings-store'

/**
 * 计算当前"激活的模型"的 (id, source) 组合 key
 * 多源配置下同 id 不同 source 的多个模型同时存在时，
 * 返回第一个匹配的 (id, source) 组合，用 (id, source) 组合 key 精确比对。
 *
 * @param models 渲染进程拿到的模型列表（来自 listModels / ollama getRecommendedModels）
 * @param selectedId 当前 SELECTED_MODEL_ID 配置值
 * @returns 形如 "id@source" 的字符串；若 selectedId 为空或未找到匹配则返回 null
 */
export function resolveActiveModelKey(
  models: ReadonlyArray<{ id: string; source?: string }>,
  selectedId: string | undefined,
  selectedSource?: string | null
): string | null {
  if (!selectedId) return null
  // 优先使用配置中心保存的 SELECTED_MODEL_SOURCE 精确匹配，
  // 避免同 id 多 source 模型（如 HuggingFace 与 ModelScope 双版本）时误标激活态
  let model = models.find(
    m => m.id === selectedId && (!selectedSource || m.source === selectedSource)
  )
  if (!model) model = models.find(m => m.id === selectedId)
  if (!model) return null
  return `${model.id}@${model.source || 'default'}`
}

interface ModelCardItemProps {
  model: any
  isDownloaded: boolean
  isDsparkDownloaded?: boolean
  isActive: boolean
  isEx: boolean
  isCpuTier?: boolean
  onActivate: (modelId: string, source?: string) => Promise<void>
  onDelete: (modelId: string, source?: string) => Promise<void>
  onDownloadComplete: (modelId: string, source?: string) => void
}

/**
 * 单个模型卡片组件 - 用于独立管理每个模型的下载状态与 UI，支持多模型并发下载与进度展示
 */
const ModelCardItem: React.FC<ModelCardItemProps> = React.memo(
  ({
    model,
    isDownloaded,
    isDsparkDownloaded: isDsparkDownloadedProp = false,
    isActive,
    isEx,
    isCpuTier = false,
    onActivate,
    onDelete,
    onDownloadComplete
  }) => {
    const { activeDownloadId, setActiveDownloadId } = useModelStore()
    const compositeId = `${model.id}@${model.source}`
    const dsparkModelId = model.dspark as string | undefined
    const [isDsparkDownloaded, setIsDsparkDownloaded] = useState<boolean>(isDsparkDownloadedProp)

    useEffect(() => {
      if (isDsparkDownloadedProp) {
        setIsDsparkDownloaded(true)
      }
    }, [isDsparkDownloadedProp])

    // 为主模型独立初始化下载 Hook
    const {
      state: downloadState,
      startDownload,
      cancelDownload,
      retryDownload
    } = useModelDownload(model.id, {
      source: model.source,
      onDownloadComplete: () => {
        onDownloadComplete(model.id, model.source)
        if (activeDownloadId === compositeId) {
          setActiveDownloadId(null)
        }
      },
      onDownloadError: () => {
        if (activeDownloadId === compositeId) {
          setActiveDownloadId(null)
        }
      },
      onDownloadCancel: () => {
        if (activeDownloadId === compositeId) {
          setActiveDownloadId(null)
        }
      }
    })

    // 为 DSpark 加速模型独立初始化下载 Hook
    const dsparkCompositeId = dsparkModelId ? `${dsparkModelId}@${model.source}` : ''
    const {
      state: dsparkDownloadState,
      startDownload: startDsparkDownload,
      cancelDownload: cancelDsparkDownload,
      retryDownload: retryDsparkDownload
    } = useModelDownload(dsparkModelId || '', {
      source: model.source,
      onDownloadComplete: () => {
        setIsDsparkDownloaded(true)
        onDownloadComplete(dsparkModelId || '', model.source)
        if (activeDownloadId === dsparkCompositeId) {
          setActiveDownloadId(null)
        }
      },
      onDownloadError: () => {
        if (activeDownloadId === dsparkCompositeId) {
          setActiveDownloadId(null)
        }
      },
      onDownloadCancel: () => {
        if (activeDownloadId === dsparkCompositeId) {
          setActiveDownloadId(null)
        }
      }
    })

    // 检查本地 DSpark 是否已经下载就绪
    useEffect(() => {
      if (!dsparkModelId || !window.electronAPI?.checkModelsStatus) return
      window.electronAPI.checkModelsStatus().then((statusMap: any) => {
        const dsparkKey = `${dsparkModelId}@${model.source}`
        const status = statusMap[dsparkKey] || statusMap[dsparkModelId]
        if (status?.isDownloaded) {
          setIsDsparkDownloaded(true)
        }
      }).catch(() => {})
    }, [dsparkModelId, model.source])

    const isDownloading = downloadState.isDownloading
    const isDsparkDownloading = dsparkDownloadState.isDownloading

    const handleDownloadModel = async () => {
      setActiveDownloadId(compositeId)
      await startDownload(model.id, { autoRetry: true, source: model.source })
    }

    const handleDownloadDspark = async () => {
      if (!dsparkModelId) return
      setActiveDownloadId(dsparkCompositeId)
      await startDsparkDownload(dsparkModelId, { autoRetry: true, source: model.source })
    }

    return (
      <div
        className={`group relative flex flex-col p-5 rounded-2xl border-2 transition-all ${
          isEx
            ? 'opacity-40 grayscale-[0.6] border-border bg-muted/10'
            : isActive
              ? 'bg-primary/5 border-primary shadow-xl ring-4 ring-primary/5'
              : 'bg-card border-border hover:border-primary/40'
        }`}
      >
        {isActive && (
          <Badge className="absolute -top-3 -right-3 h-6 px-3 bg-primary text-primary-foreground shadow-sm rounded-full text-xs font-bold pointer-events-none z-10">
            {t('已激活')}
          </Badge>
        )}
        {isEx && (
          <Badge className="absolute -top-3 -right-3 h-6 px-3 bg-destructive text-destructive-foreground shadow-sm rounded-full text-xs font-bold pointer-events-none z-10 flex items-center gap-1">
            <AlertCircle className="w-3 h-3" />
            {t('显存不足')}
          </Badge>
        )}
        <div className="flex items-center justify-between">
          <div className="flex-grow pr-4">
            <div className="flex items-center gap-2 mb-2 flex-wrap">
              <h4 className="font-black text-lg">{model.name}</h4>
              <div className="flex gap-1.5 flex-wrap">
                {model.recommended && (
                  <Badge className="text-[10px] font-black h-5 px-2 bg-gradient-to-r from-amber-500 to-orange-600 text-white border-none shadow-md flex items-center gap-1">
                    <Star className="h-3.5 w-3.5 fill-current text-white" /> {t('推荐')}
                  </Badge>
                )}
                {model.isBest && (
                  <Badge className="text-[10px] font-black h-5 px-2 bg-gradient-to-r from-blue-500 to-indigo-600 text-white border-none shadow-md flex items-center gap-1">
                    <Sparkles className="h-3.5 w-3.5 fill-current text-white" /> {t('显存最适配')}
                  </Badge>
                )}
                <Badge
                  variant="outline"
                  className="text-[9px] font-black h-4 px-1.5 bg-muted/50 text-muted-foreground border-border uppercase tracking-tighter"
                >
                  {model.parameterSize}
                </Badge>
                {dsparkModelId && isDsparkDownloaded && (
                  <Badge className="text-[9px] font-black h-4 px-1.5 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 uppercase tracking-tighter flex items-center gap-1">
                    <Zap className="h-2.5 w-2.5 fill-current" />
                    {t('已就绪 (CPU加速已启用)')}
                  </Badge>
                )}
                {(model.tags || []).map((tag: string) => (
                  <Badge
                    key={tag}
                    variant="outline"
                    className="text-[9px] font-black h-4 px-1.5 bg-muted/50 text-muted-foreground border-border uppercase tracking-tighter"
                  >
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
            <p className="text-xs text-muted-foreground line-clamp-1 mb-3 font-medium italic opacity-70">
              {model.company && `${t('来自')}：${model.company}，`}
              {model.description}
            </p>
            <div className="flex items-center gap-6 text-[10px] font-black text-muted-foreground uppercase tracking-tight">
              <div className="flex items-center gap-1.5">
                <HardDrive className="h-3.5 w-3.5 opacity-50" />
                {model.totalSize ||
                  (model.totalSizeBytes ? formatFileSize(model.totalSizeBytes) : t('未知'))}
              </div>

              <div className="flex items-center gap-1.5 px-2 py-0.5 bg-muted/40 rounded-lg border border-border/50">
                <Zap className={`h-3.5 w-3.5 ${isEx ? 'text-destructive' : 'text-amber-500'}`} />
                <span className={isEx ? 'text-destructive' : 'text-foreground/70'}>
                  {typeof model.vramRequiredGB === 'number'
                    ? Math.ceil(model.vramRequiredGB)
                    : 'N/A'}
                  GB {t('建议显存')}
                </span>
              </div>

              {model.capabilities && (
                <div className="flex items-center gap-1.5 text-muted-foreground/60">
                  <span className="opacity-60">{t('支持：')}</span>
                  <div className="flex gap-1 flex-wrap">
                    {(model.capabilities || []).map((c: any, i: number) => (
                      <span key={i} className="text-[9px] font-black uppercase">
                        {typeof c === 'string' ? c : c.type || 'TEXT'}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-col items-end gap-2 shrink-0 ml-4">
            {/* 当为 CPU 模式、配置了 DSpark、主模型已就绪但 DSpark 未下载时，在激活按钮上方展示下载加速模型按钮 */}
            {isCpuTier && dsparkModelId && isDownloaded && !isDsparkDownloaded && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleDownloadDspark}
                disabled={isDsparkDownloading}
                title={t('CPU模式可加速30%')}
                className="h-7 text-xs px-2.5 border-emerald-500/40 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-700 dark:hover:text-emerald-300 transition-colors flex items-center gap-1"
              >
                {isDsparkDownloading ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Zap className="h-3 w-3 fill-current text-emerald-500" />
                )}
                <span>{t('下载加速模型')}</span>
              </Button>
            )}

            <div className="flex items-center gap-3">
              {isDownloaded ? (
                <>
                  {!isActive && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onActivate(model.id, model.source)}
                    >
                      {t('激活')}
                    </Button>
                  )}
                  {model.isBuiltin ? (
                    <Badge className="text-[10px] font-black h-6 px-3 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-700">
                      {t('内置')}
                    </Badge>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onDelete(model.id, model.source)}
                      className="h-9 w-9 p-0 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  )}
                </>
              ) : (
                !isEx && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleDownloadModel}
                    disabled={isDownloading}
                  >
                    {isDownloading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <Download className="h-4 w-4 mr-2" />
                        {t('下载')}
                      </>
                    )}
                  </Button>
                )
              )}
            </div>
          </div>
        </div>

        {/* 主模型下载进度 */}
        {(isDownloading || downloadState.status === 'error') && (
          <div className="mt-4 pt-4 border-t border-border">
            <ModelDownloadProgress
              progress={downloadState.downloadProgress ?? null}
              isDownloading={downloadState.isDownloading}
              isPaused={downloadState.isPaused}
              status={downloadState.status}
              error={downloadState.error}
              onCancel={cancelDownload}
              onRetry={retryDownload}
              className="border-none bg-transparent p-0 shadow-none"
            />
          </div>
        )}

        {/* DSpark 加速模型下载进度 */}
        {(isDsparkDownloading || dsparkDownloadState.status === 'error') && (
          <div className="mt-4 pt-4 border-t border-border">
            <div className="text-[11px] font-bold text-emerald-600 dark:text-emerald-400 mb-1 flex items-center gap-1">
              <Zap className="h-3 w-3 fill-current" />
              {t('DSpark 加速模型下载中...')}
            </div>
            <ModelDownloadProgress
              progress={dsparkDownloadState.downloadProgress ?? null}
              isDownloading={dsparkDownloadState.isDownloading}
              isPaused={dsparkDownloadState.isPaused}
              status={dsparkDownloadState.status}
              error={dsparkDownloadState.error}
              onCancel={cancelDsparkDownload}
              onRetry={retryDsparkDownload}
              className="border-none bg-transparent p-0 shadow-none"
            />
          </div>
        )}
      </div>
    )
  }
)

/**
 * AI模型设置组件 - 支持明暗双色主题适配，优化硬件显示与列表布局
 */
export const AIModelSettings: React.FC = () => {
  const { config, getConfigValue, updateConfigValue, isMigrating, setMigrating } =
    useSettingsStore()
  const { activeLanguage } = useVoerkaI18n(i18nScope)
  const { setModelName } = useModelStore()

  const [models, setModels] = useState<any[]>([])
  const [hardwareInfo, setHardwareInfo] = useState<HardwareInfo | null>(null)
  const [recommendedModelIds, setRecommendedModelIds] = useState<string[]>([])
  const [integrityFailedPackages, setIntegrityFailedPackages] = useState<string[]>([])
  const [modelDownloadStatus, setModelDownloadStatus] = useState<Record<string, boolean>>({})
  const { activeDownloadId, setActiveDownloadId } = useModelStore()
  const [loading, setLoading] = useState<boolean>(false)
  const isGpuSwitching = useAIServiceStore(state => state.isGpuSwitching)
  const setIsGpuSwitching = useAIServiceStore(state => state.setIsGpuSwitching)
  const [activeTab, setActiveTab] = useState<string>('')
  const [deleteConfirm, setDeleteConfirm] = useState<{
    modelId: string
    displayName: string
    source?: string
  } | null>(null)

  const [modelStoragePath, setModelStoragePath] = useState(config?.modelPath || '')
  const [builtinModelId, setBuiltinModelId] = useState<string>('')

  useEffect(() => {
    const fetchBuiltinId = async () => {
      if (window.electronAPI?.getBuiltinModelId) {
        try {
          const id = await window.electronAPI.getBuiltinModelId()
          setBuiltinModelId(id)
        } catch (error) {
          console.error('获取内置模型ID失败:', error)
        }
      }
    }
    fetchBuiltinId()
  }, [])

  const currentStoragePath = config?.modelPath || ''
  useEffect(() => {
    setModelStoragePath(currentStoragePath)
  }, [currentStoragePath])

  const handlePathChange = async (newPath: string) => {
    const oldPath = config?.modelPath || ''
    if (!newPath || newPath === oldPath) return

    const validation = validateModelPath(newPath)
    if (!validation.isValid) {
      toast.error(validation.error || t('路径不合法'))
      setModelStoragePath(oldPath)
      return
    }

    // 校验目录写权限，无权限时提示用户更换为有权限的目录
    try {
      const writableResult = await window.electronAPI!.utils.checkDirectoryWritable(newPath)
      if (!writableResult.writable) {
        toast.error(t('所选目录没有写入权限，请选择其他有权限的目录。'))
        setModelStoragePath(oldPath)
        return
      }
    } catch (error) {
      console.error('校验目录写权限失败:', error)
      toast.error(t('无法校验目录写权限，请检查目录是否可访问。'))
      setModelStoragePath(oldPath)
      return
    }

    setModelStoragePath(newPath)

    try {
      let builtinId = builtinModelId
      if (!builtinId && window.electronAPI?.getBuiltinModelId) {
        builtinId = await window.electronAPI.getBuiltinModelId()
      }

      const currentModelId = config?.selectedModelId

      if (builtinId && currentModelId !== builtinId) {
        logger.info(LogCategory.RENDERER, '迁移前自动切换到内置模型以确保稳定性')
        await updateConfigValue('SELECTED_MODEL_ID', builtinId)
      }

      setMigrating(true, t('正在准备迁移模型...'))

      const result = await window.electronAPI!.migrateFromOldPath(oldPath, newPath)

      if (!result.success) {
        setMigrating(false)
        toast.error(t('模型迁移失败: {error}', { error: result.error }))
        return
      }

      await updateConfigValue('MODEL_STORAGE_PATH', newPath)

      await loadModelsAndHardware(false)
    } catch (error) {
      setMigrating(false)
      toast.error(t('操作失败: {error}', { error: String(error) }))
    }
  }

  const handleHighPerformanceMode = async () => {
    setIsGpuSwitching(true)
    try {
      await window.electronAPI.aiService.switchToHighPerformanceMode()
      await loadModelsAndHardware(true)
    } catch (e) {
      console.error(e)
    } finally {
      setIsGpuSwitching(false)
    }
  }

  const isCloudMode = config?.aiServiceMode === 'cloud'
  const aiEngine = config?.aiEngine
  const isOllama = aiEngine === 'ollama'

  const loadModelsAndHardware = useCallback(
    async (forceRedetect = false) => {
      try {
        setLoading(true)

        // 如果当前没有活跃下载 ID，尝试从后台获取正在运行的任务
        if (!activeDownloadId) {
          try {
            const tasks = await window.electronAPI!.modelDownload.getAllTasks()
            if (tasks && tasks.length > 0) {
              // 找到第一个正在下载或等待的任务
              const activeTask = tasks.find((task: any) =>
                ['downloading', 'pending', 'retrying'].includes(task.status)
              )
              if (activeTask) {
                console.log('[AIModelSettings] 自动检测到活跃任务:', activeTask.modelId)
                setActiveDownloadId(activeTask.modelId)
              }
            }
          } catch (e) {
            console.error('[AIModelSettings] 获取后台任务失败:', e)
          }
        }

        // 如果需要强制重新检测硬件（针对 llama.cpp 引擎热替换）
        if (forceRedetect && !isOllama && !isCloudMode) {
          // 调用初始化接口会触发主进程执行 3-Tier 硬件探测并重新部署 Bundle
          await window.electronAPI!.aiService.initialize()
        }

        const hw = await window.electronAPI!.getHardwareInfo()
        setHardwareInfo(hw)

        // 根据平台条件性获取模型列表
        // 恢复引擎过滤逻辑：llama.cpp/llamafile 模式显示本地模型，Ollama 模式显示 Ollama 模型
        let llamaModels: any[] = []
        let ollamaModels: any[] = []

        if (isOllama) {
          // Ollama 模式：获取 Ollama 推荐模型列表
          const ollamaResult = await window.electronAPI!.ollama.getRecommendedModels()
          ollamaModels = ollamaResult?.models || []
        } else {
          // llama.cpp / llamafile 模式：快速获取本地模型列表（跳过存在性检测）
          llamaModels = await window.electronAPI!.listModelsFast()
        }

        const combinedModelsMap = new Map()

        // 处理 Ollama 模型
        ollamaModels.forEach((m: any) => {
          // 优先使用已有的 source，如果没有则根据 ID 特征判断，最后默认为 ollama
          const source = m.source || (m.id.includes('modelscope') ? 'modelscope' : 'ollama')
          combinedModelsMap.set(`${m.id}@${source}`, { ...m, source })
        })

        // 处理 Llama 模型
        llamaModels.forEach((m: any) => {
          // 如果没有 source，在非 Ollama 模式下默认为 modelscope
          const source = m.source || (isOllama ? 'ollama' : 'modelscope')
          const key = `${m.id}@${source}`
          if (!combinedModelsMap.has(key)) {
            combinedModelsMap.set(key, { ...m, source })
          }
        })

        const combinedModels = Array.from(combinedModelsMap.values())
        setModels(combinedModels)

        const statusMap: Record<string, boolean> = {}
        combinedModels.forEach((m: any) => {
          statusMap[`${m.id}@${m.source}`] = !!m.isDownloaded
        })
        setModelDownloadStatus(statusMap)

        if (typeof window.electronAPI?.checkModelsStatus === 'function') {
          window
            .electronAPI!.checkModelsStatus()
            .then((realStatus: any) => {
              const nextStatus: Record<string, boolean> = {}
              let activeId: string | null = null

              Object.keys(realStatus).forEach(id => {
                const status = realStatus[id]
                if (status) {
                  nextStatus[id] = !!status.isDownloaded
                  // 如果模型正在下载（有进度且未完成）或下载出错，设置为活动下载 ID
                  const isDownloading =
                    status.status === 'downloading' ||
                    status.status === 'pending' ||
                    status.status === 'retrying'
                  const isError = status.status === 'error'

                  if (
                    !status.isDownloaded &&
                    (status.downloadProgress !== undefined || isError) &&
                    !activeId
                  ) {
                    activeId = id
                  }
                }
              })

              // 统一更新状态，不再在 updater 中包含副作用
              setModelDownloadStatus(prev => ({ ...prev, ...nextStatus }))
              if (activeId && !activeDownloadId) {
                console.log('[AIModelSettings] 全量检查发现活动下载任务:', activeId)
                setActiveDownloadId(activeId)
              }
            })
            .catch((err: Error) => console.error('全量状态检查失败:', err))
        }

        const [recommendation] = await Promise.all([
          window.electronAPI!.recommendModelsByHardware(hw.totalMemGB || 0, hw.hasGPU, hw.vramGB)
        ])

        // 查询完整性校验状态
        try {
          const failedPackages = await window.electronAPI!.aiService.checkPackageIntegrity()
          setIntegrityFailedPackages(failedPackages)
        } catch (e) {
          console.error('查询完整性校验状态失败:', e)
        }

        if (recommendation?.recommendedModels) {
          setRecommendedModelIds(recommendation.recommendedModels)
        }
      } catch (error) {
        console.error('加载模型列表失败:', error)
      } finally {
        setLoading(false)
      }
    },
    [isCloudMode, isOllama]
  )

  useEffect(() => {
    if (!isCloudMode) loadModelsAndHardware()
  }, [isCloudMode, loadModelsAndHardware])

  useEffect(() => {
    const handleMigrationFinished = () => {
      console.log('收到模型迁移完成事件，正在刷新模型列表...')
      loadModelsAndHardware()
    }
    window.addEventListener('app:model-migration-finished', handleMigrationFinished)
    return () => {
      window.removeEventListener('app:model-migration-finished', handleMigrationFinished)
    }
  }, [loadModelsAndHardware])

  useEffect(() => {
    // 其他入口（如下载完成确认弹窗的"立即激活"）激活模型成功后也会广播此事件，触发列表刷新
    const handleModelActivated = () => {
      console.log('收到模型激活完成事件，正在刷新模型列表...')
      loadModelsAndHardware()
    }
    window.addEventListener('app:model-activated', handleModelActivated)
    return () => {
      window.removeEventListener('app:model-activated', handleModelActivated)
    }
  }, [loadModelsAndHardware])

  useEffect(() => {
    if (!window.electronAPI) return

    // 监听下载完成事件，自动刷新状态
    const unsubscribe = window.electronAPI.onModelDownloadComplete(() => {
      console.log('收到模型下载完成事件，正在刷新模型列表...')
      loadModelsAndHardware()
    })

    return (() => {
      if (unsubscribe) (unsubscribe as any)()
    }) as any
  }, [loadModelsAndHardware])

  const handleActivateModel = async (modelId: string, source?: string) => {
    const model = models.find(m => m.id === modelId)
    if (!model) return
    try {
      // 显式传入 preventAutoReload: true，防止配置写入导致冗余的服务重载，
      // 因为下方会接着调用 onModelChanged 进行受控的模型重载
      await updateConfigValue('SELECTED_MODEL_ID', modelId, { preventAutoReload: true })
      // 同时保存模型来源（huggingface / modelscope / ollama），以便后端精确查询模型配置
      await updateConfigValue('SELECTED_MODEL_SOURCE', source, { preventAutoReload: true })
      setModelName(model.name)
      const { notifyModelChanged } = useAIServiceStore.getState()
      await notifyModelChanged(modelId)
      // 激活成功后主动刷新模型列表，确保下载状态立即以真实状态展示，
      // 避免"已激活"徽章已点亮但下载状态仍是旧值（未刷新）导致按钮错乱
      await loadModelsAndHardware()
    } catch (error) {
      console.error('激活模型失败:', error)
    }
  }

  const handleDeleteModel = async (modelId: string, source?: string) => {
    const model = models.find(m => m.id === modelId && (!source || m.source === source))
    if (!model) return
    setDeleteConfirm({
      modelId,
      displayName: model.name,
      source
    })
  }

  const confirmDeleteModel = async () => {
    if (!deleteConfirm) return
    const { modelId, source } = deleteConfirm
    try {
      await window.electronAPI!.deleteModel(modelId)
      setModelDownloadStatus(prev => {
        const n = { ...prev }
        const key = source ? `${modelId}@${source}` : modelId
        delete n[key]
        delete n[modelId]
        return n
      })
      toast.success(t('模型已成功删除'))
    } catch (e) {
      console.error('删除失败', e)
      toast.error(t('删除模型失败'))
    } finally {
      setDeleteConfirm(null)
    }
  }

  const groupedModels = useMemo(() => {
    return groupAndSortModels(models, hardwareInfo, recommendedModelIds)
  }, [models, hardwareInfo, recommendedModelIds])

  /**
   * 计算当前"激活的模型"的 (id, source) 组合 key
   * 用 (id, source) 组合 key 精确比对，避免多个同 id 模型都显示激活态。
   */
  const activeModelKey = useMemo(
    () =>
      resolveActiveModelKey(models as any, config?.selectedModelId, config?.selectedModelSource),
    [models, config?.selectedModelId, config?.selectedModelSource]
  )

  const sourceList = useMemo(() => {
    return (Object.keys(MODEL_SOURCES) as TModelSource[]).filter(
      s => (groupedModels[s]?.length ?? 0) > 0
    )
  }, [groupedModels])

  // 当 sourceList 变化且当前 activeTab 不在 sourceList 中时，默认选中合适来源
  // 非中文环境默认优先 HuggingFace 源，中文环境保持默认首个可用来源（通常为 ModelScope）
  useEffect(() => {
    if (sourceList.length > 0) {
      if (!activeTab || !sourceList.includes(activeTab as TModelSource)) {
        const isZh = activeLanguage === 'zh-CN'
        const preferred = isZh ? sourceList[0] : 'huggingface'
        setActiveTab(sourceList.includes(preferred as TModelSource) ? preferred : sourceList[0])
      }
    }
  }, [sourceList, activeTab, activeLanguage])

  if (isGpuSwitching) {
    return (
      <InitialSetupOverlay
        status="installing_engine"
        message={t('正在配置高性能模式运行环境，请稍候...')}
      />
    )
  }

  return (
    <div className="p-6 space-y-6 text-foreground">
      <div className="flex justify-between items-start">
        <div className="w-[300px]">
          <h3 className="text-xl font-black tracking-tight">{t('模型管理')}</h3>
          <p className="text-xs text-muted-foreground font-medium mt-1">
            {t('模型就像AI大脑，它们决定了文件分析准确率与响应速度')}
          </p>
          <p className="text-xs text-muted-foreground font-medium mt-1">
            {t('本地模型相当于：小学（内置）、初中、高中；云端模型：高中、大学')}
          </p>
        </div>
        <div className="flex items-center p-0.5 bg-muted/50 dark:bg-muted/20 rounded-xl border border-border shadow-sm">
          <button
            onClick={() => updateConfigValue('AI_SERVICE_MODE', 'local')}
            className={`flex items-center gap-2 px-6 py-2 rounded-l-[9px] rounded-r-none text-sm font-bold transition-all border
              ${
                !isCloudMode
                  ? 'bg-green-600 text-white border-green-700/30 z-10'
                  : 'text-muted-foreground border-transparent hover:text-foreground hover:bg-background/50'
              }`}
          >
            <Server className="w-4 h-4" />
            {t('本地AI引擎')}
          </button>
          <button
            onClick={() => updateConfigValue('AI_SERVICE_MODE', 'cloud')}
            className={`flex items-center gap-2 px-6 py-2 rounded-r-[9px] rounded-l-none text-sm font-bold transition-all border -ml-[1px]
              ${
                isCloudMode
                  ? 'bg-blue-600 text-white border-blue-700/30 z-10'
                  : 'text-muted-foreground border-transparent hover:text-foreground hover:bg-background/50'
              }`}
          >
            <Cloud className="w-4 h-4" />
            {t('云端')}
          </button>
        </div>
      </div>

      {!isCloudMode && integrityFailedPackages.length > 0 && (
        <div className="bg-red-500/10 border border-red-500/20 p-4 rounded-2xl flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <AlertCircle className="text-red-500 h-5 w-5" />
            <span className="text-sm font-medium text-red-800 dark:text-red-500">
              {t('安装过程出错，AI引擎缺失必要文件，造成兼容模式运行，严重可能造成 AI 服务崩溃。')}
            </span>
          </div>
          <div className="pl-8">
            <span className="text-xs text-red-700 dark:text-red-400">
              {t(
                '建议检查安装目录是否有写入权限。确认没问题后，重新安装应用，将不再看到此提示，并自动恢复加载全速AI引擎。'
              )}
            </span>
          </div>
        </div>
      )}

      {!isCloudMode && hardwareInfo && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="flex items-center col-span-3 gap-3 px-4 py-3 bg-muted/20 border border-border/40 rounded-2xl">
            <Cpu className="h-4 w-4 text-muted-foreground/60" />
            <div className="flex flex-col">
              <span className="text-[10px] font-black text-muted-foreground/50 uppercase leading-none mb-1">
                {t('显卡 / 独立显存')}
              </span>
              <span className="text-xs font-bold text-muted-foreground/80 truncate">
                {hardwareInfo.gpuModel || t('核显')}
                {hardwareInfo.vramGB !== undefined && (
                  <span className="ml-1.5 text-primary/70 text-xl">
                    {hardwareInfo.rawVramMB && hardwareInfo.rawVramMB < 1024
                      ? `${hardwareInfo.rawVramMB} MB`
                      : `${hardwareInfo.vramGB} GB`}
                  </span>
                )}
                {hardwareInfo.supportsSycl && (
                  <Badge
                    variant="outline"
                    className="ml-2 bg-blue-500/10 text-blue-600 border-blue-200/50 text-[9px] h-4 px-1.5 py-0 font-bold whitespace-nowrap"
                  >
                    SYCL (Intel XMX)
                  </Badge>
                )}
              </span>
            </div>
          </div>
          <div className="flex items-center col-span-1 gap-3 px-4 py-3 bg-muted/20 border border-border/40 rounded-2xl">
            <HardDrive className="h-4 w-4 text-muted-foreground/60" />
            <div className="flex flex-col">
              <span className="text-[10px] font-black text-muted-foreground/50 uppercase leading-none mb-1">
                {t('硬盘可用空间')}
              </span>
              <span className="text-xs font-bold text-muted-foreground/80">
                {hardwareInfo.storageFreeGB ? `${hardwareInfo.storageFreeGB}GB` : t('未知')}{' '}
                <span className="text-[8px]">{t('参考')}</span>
              </span>
            </div>
          </div>
        </div>
      )}
      {isCloudMode ? (
        <CloudModelConfigSettings />
      ) : (
        <Card className="p-0 overflow-hidden border-border shadow-sm rounded-3xl bg-card">
          {/* <div className="p-6 border-b border-border flex items-center justify-between">
            <div>
              <Label className="text-base font-black">{t('推理引擎库')}</Label>
              <p className="text-[11px] text-muted-foreground font-bold uppercase tracking-wider mt-0.5">
                {t('管理您的本地 AI 核心能力')}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => loadModelsAndHardware(true)}
              disabled={loading}
              className="rounded-xl hover:bg-muted text-muted-foreground h-10 w-10 p-0 transition-all"
            >
              {loading ? (
                <Loader2 className="h-5 w-5 animate-spin" />
              ) : (
                <RefreshCw className="h-5 w-5" />
              )}
            </Button>
          </div> */}

          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className="flex w-full justify-start h-14 bg-muted/40 p-0 border-b border-border rounded-none overflow-x-auto no-scrollbar">
              {sourceList.map(s => (
                <TabsTrigger
                  key={s}
                  value={s}
                  className="flex-shrink-0 px-4 h-full rounded-none font-black text-xs data-[state=active]:border-primary data-[state=active]:bg-background data-[state=active]:text-primary transition-all border-b-2 border-transparent relative"
                >
                  <Globe className="w-4 h-4 mr-2" />
                  {MODEL_SOURCES[s].name}
                  <span className="ml-2 text-[10px] bg-muted px-2 py-0.5 rounded-full text-muted-foreground">
                    {(groupedModels[s] || []).length}
                  </span>
                </TabsTrigger>
              ))}
            </TabsList>

            {sourceList.map(s => (
              <TabsContent key={s} value={s} className="p-6 focus-visible:ring-0 m-0">
                <div className="flex items-start gap-3 p-4 mb-6 bg-primary/5 rounded-2xl border border-primary/10 italic text-xs text-primary font-medium">
                  <Info className="h-4 w-4 text-primary shrink-0" />
                  {MODEL_SOURCES[s].description}
                </div>

                <div className="space-y-3">
                  {!groupedModels[s] || groupedModels[s].length === 0 ? (
                    <div className="text-center py-16 text-muted-foreground/30 font-black text-xs uppercase tracking-widest">
                      {t('该来源暂无可用模型')}
                    </div>
                  ) : (
                    groupedModels[s].map(model => {
                      const downloadKey = `${model.id}@${model.source}`
                      const isActive = activeModelKey === `${model.id}@${model.source || 'default'}`
                      const bestAcc = String(
                        (config as any)?.bestAcceleration ??
                          (config as any)?.BEST_ACCELERATION ??
                          getConfigValue<string>('BEST_ACCELERATION') ??
                          ''
                      ).toLowerCase()
                      //临时测试 cpu模式
                      const isCpuTier = bestAcc === 'cpu'
                      const dsparkKey = model.dspark ? `${model.dspark}@${model.source}` : ''
                      const isDsparkDownloaded = !!(
                        model.dspark &&
                        (modelDownloadStatus[dsparkKey] || modelDownloadStatus[model.dspark as string])
                      )
                      return (
                        <ModelCardItem
                          key={downloadKey}
                          model={model}
                          // 已激活的模型必然已下载，强制视为已下载，
                          // 避免磁盘探测失败时同一张卡片同时显示"已激活"徽章与"下载"按钮
                          isDownloaded={isActive ? true : modelDownloadStatus[downloadKey]}
                          isDsparkDownloaded={isDsparkDownloaded}
                          isActive={isActive}
                          isEx={model.isEx || false}
                          isCpuTier={isCpuTier}
                          onActivate={handleActivateModel}
                          onDelete={handleDeleteModel}
                          onDownloadComplete={modelId => {
                            setModelDownloadStatus(prev => ({
                              ...prev,
                              [`${modelId}@${model.source}`]: true
                            }))
                            loadModelsAndHardware()
                          }}
                        />
                      )
                    })
                  )}
                </div>
              </TabsContent>
            ))}
          </Tabs>
        </Card>
      )}

      {/* 存储配置 */}
      {!isCloudMode && !isOllama && (
        <Card className="p-6 border-border shadow-sm rounded-3xl bg-card">
          <div className="space-y-4">
            <div>
              <Label className="text-sm font-black">{t('存储配置')}</Label>
              <p className="text-[11px] text-muted-foreground font-bold mt-1 uppercase tracking-tight">
                {t('模型将保存在以下路径，建议选择充足空间的高速存储盘')}
              </p>
            </div>
            <div className="flex gap-2">
              <Input
                value={modelStoragePath}
                onChange={e => setModelStoragePath(e.target.value)}
                onBlur={e => handlePathChange(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handlePathChange((e.target as HTMLInputElement).value)
                }}
                className="h-11 rounded-xl border-border bg-muted/20 font-medium text-xs focus:ring-primary transition-all"
              />
              <Button
                variant="outline"
                onClick={() => {
                  window.electronAPI?.utils
                    ?.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
                    .then((res: { canceled: boolean; filePaths: string[] }) => {
                      if (!res.canceled && res.filePaths[0]) {
                        handlePathChange(res.filePaths[0])
                      }
                    })
                }}
                className="h-11 px-5 rounded-xl font-black text-xs border-border hover:bg-muted transition-all"
              >
                {t('浏览')}
              </Button>
              <Button
                onClick={() => loadModelsAndHardware(true)}
                disabled={loading || isMigrating}
                className="h-11 px-8 rounded-xl bg-primary text-primary-foreground font-black text-xs shadow-md hover:bg-primary/90 transition-all flex items-center gap-2"
              >
                {loading ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {t('刷新模型列表')}
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* 删除确认对话框 */}
      <AlertDialog open={!!deleteConfirm} onOpenChange={open => !open && setDeleteConfirm(null)}>
        <AlertDialogContent className="max-w-md rounded-2xl p-6 border bg-background/95 backdrop-blur-xl shadow-2xl">
          <AlertDialogHeader className="space-y-3">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <span className="material-icons text-2xl">warning</span>
            </div>
            <AlertDialogTitle className="text-xl font-bold text-center text-foreground">
              {t('确认删除')}
            </AlertDialogTitle>
            <AlertDialogDescription className="text-sm text-muted-foreground text-center font-medium">
              {deleteConfirm && t('确认删除模型 "{model}"?', { model: deleteConfirm.displayName })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-6 flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2">
            <AlertDialogCancel
              onClick={() => setDeleteConfirm(null)}
              className={cn(buttonVariants({ variant: 'secondary' }), 'w-full sm:w-auto')}
            >
              {t('取消')}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDeleteModel}
              className={cn(
                buttonVariants({ variant: 'destructive' }),
                'w-full sm:w-auto bg-destructive hover:bg-destructive/90 text-white'
              )}
            >
              {t('删除')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
