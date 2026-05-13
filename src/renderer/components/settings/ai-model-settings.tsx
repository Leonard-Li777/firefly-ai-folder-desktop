import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { t } from '@app/languages'
import { Card } from '../ui/card'
import { Label } from '../ui/label'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { useSettingsStore } from '../../stores/settings-store'
import { useModelStore } from '../../stores/model-store'
import { useModelDownload } from '../../hooks/use-model-download'
import { ModelDownloadProgress } from '../download/ModelDownloadProgress'
import { HardwareInfo, IModelSummary, TModelSource, TModelCapabilityType } from '@yonuc/types'
import { LogCategory, logger, validateModelPath } from '@yonuc/shared'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { Badge } from '../ui/badge'
import {
  Download,
  Trash2,
  RefreshCw,
  HardDrive,
  Cpu,
  Zap,
  CheckCircle,
  AlertCircle,
  Loader2,
  Check,
  Cloud,
  Server,
  ChevronDown,
  ChevronRight,
  Globe,
  Star,
  Info
} from 'lucide-react'
import { toast } from '../common/Toast'
import { CloudModelConfigSettings } from './cloud-model-config-settings'
import { MODEL_SOURCES } from '@app/shared/utils/model-constants'

/**
 * AI模型设置组件 - 支持明暗双色主题适配，优化硬件显示与列表布局
 */
export const AIModelSettings: React.FC = () => {
  const {
    config,
    getConfigValue,
    updateConfigValue,
    isLoading: isConfigLoading,
    isMigrating,
    setMigrating,
    migrationProgress
  } = useSettingsStore()
  const { setModelName } = useModelStore()

  const [models, setModels] = useState<any[]>([])
  const [allModels, setAllModels] = useState<IModelSummary[]>([])
  const [hardwareInfo, setHardwareInfo] = useState<HardwareInfo | null>(null)
  const [recommendedModelIds, setRecommendedModelIds] = useState<string[]>([])
  const [modelDownloadStatus, setModelDownloadStatus] = useState<Record<string, boolean>>({})
  const { activeDownloadId, setActiveDownloadId } = useModelStore()
  const [loading, setLoading] = useState<boolean>(false)
  const [activeTab, setActiveTab] = useState<string>('')
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

  const {
    state: downloadState,
    startDownload,
    cancelDownload,
    retryDownload
  } = useModelDownload(activeDownloadId || '', {
    onDownloadComplete: () => {
      if (activeDownloadId) {
        setModelDownloadStatus(prev => ({ ...prev, [activeDownloadId]: true }))
      }
      loadModelsAndHardware()
      setActiveDownloadId(null)
    },
    onDownloadError: () => setActiveDownloadId(null),
    onDownloadCancel: () => setActiveDownloadId(null)
  })

  const [modelStoragePath, setModelStoragePath] = useState(
    getConfigValue<string>('MODEL_STORAGE_PATH') || ''
  )

  const handlePathChange = async (newPath: string) => {
    const oldPath = getConfigValue<string>('MODEL_STORAGE_PATH') || ''
    if (!newPath || newPath === oldPath) return

    const validation = validateModelPath(newPath)
    if (!validation.isValid) {
      toast.error(validation.error || t('路径不合法'))
      setModelStoragePath(oldPath) // 恢复旧路径
      return
    }

    setModelStoragePath(newPath)

    try {
      // 关键优化：迁移前先切换到内置模型，确保 Phase 1 完成后服务能立即就绪
      let builtinId = builtinModelId
      if (!builtinId && window.electronAPI?.getBuiltinModelId) {
        builtinId = await window.electronAPI.getBuiltinModelId()
      }

      const currentModelId = getConfigValue<string>('SELECTED_MODEL_ID')

      if (builtinId && currentModelId !== builtinId) {
        logger.info(LogCategory.RENDERER, '迁移前自动切换到内置模型以确保稳定性')
        await updateConfigValue('SELECTED_MODEL_ID', builtinId)
        // 注意：这里不需要调用 onModelChanged，因为随后的路径变更会触发全量 reloadConfig
      }

      // 开启迁移状态，显示蒙版
      setMigrating(true, t('正在准备迁移模型...'))
      
      const result = await window.electronAPI!.migrateFromOldPath(oldPath, newPath)
      
      if (!result.success) {
        setMigrating(false)
        toast.error(t('模型迁移失败: {error}', { error: result.error }))
        return
      }

      // 迁移核心模型成功后，后台会继续迁移其他模型，前端此时可以更新配置路径
      // 更新配置会触发主进程 reloadConfig，由于核心模型已迁移，reloadConfig 将成功
      await updateConfigValue('MODEL_STORAGE_PATH', newPath)
      
      // 自动刷新模型列表以显示最新的下载状态
      await loadModelsAndHardware(false)

      // 注意：setMigrating(false) 现在由 App.tsx 的 builtin-completed 监听器处理
      // 这样可以确保蒙版在后端服务完全稳定后才消失
    } catch (error) {
      setMigrating(false)
      toast.error(t('操作失败: {error}', { error: String(error) }))
    }
  }

  const isCloudMode = getConfigValue<string>('AI_SERVICE_MODE') === 'cloud'
  const aiEngine = getConfigValue<string>('AI_ENGINE')
  const isOllama = aiEngine === 'ollama'

  const loadModelsAndHardware = useCallback(async (forceRedetect = false) => {
    try {
      setLoading(true)

      // 如果当前没有活跃下载 ID，尝试从后台获取正在运行的任务
      if (!activeDownloadId) {
        try {
          const tasks = await window.electronAPI!.modelDownload.getAllTasks()
          if (tasks && tasks.length > 0) {
            // 找到第一个正在下载或等待的任务
            const activeTask = tasks.find(t => 
              ['downloading', 'pending', 'retrying'].includes(t.status)
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
      let llamaModels: any[] = []
      let ollamaModels: any[] = []

      if (isOllama) {
        // Ollama 模式：仅获取 Ollama 模型
        const ollamaResult = await window.electronAPI!.ollama.getRecommendedModels()
        ollamaModels = ollamaResult?.models || []
      } else {
        // llama.cpp 模式：获取通用模型列表（ModelScope/HuggingFace）
        llamaModels = await window.electronAPI!.listModels()
      }

      const combinedModelsMap = new Map()

      // 将获取到的模型放入 Map
      ollamaModels.forEach((m: any) => {
        combinedModelsMap.set(m.id, { ...m, source: m.source || 'ollama' })
      })

      llamaModels.forEach((m: any) => {
        if (!combinedModelsMap.has(m.id)) {
          // 如果是来自 listModels 的模型，默认 source 处理
          combinedModelsMap.set(m.id, { ...m, source: m.source || (isOllama ? 'ollama' : 'modelscope') })
        }
      })

      const combinedModels = Array.from(combinedModelsMap.values())
      setModels(combinedModels)
      setAllModels(combinedModels)

      const statusMap: Record<string, boolean> = {}
      combinedModels.forEach((m: any) => {
        statusMap[m.id] = !!m.isDownloaded
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

      const recommendation = await window.electronAPI!.recommendModelsByHardware(
        hw.totalMemGB || 0,
        hw.hasGPU,
        hw.vramGB
      )
      if (recommendation?.recommendedModels) {
        setRecommendedModelIds(recommendation.recommendedModels)
      }
    } catch (error) {
      console.error('加载模型列表失败:', error)
    } finally {
      setLoading(false)
    }
  }, [getConfigValue])

  useEffect(() => {
    if (!isCloudMode) loadModelsAndHardware()
  }, [isCloudMode, loadModelsAndHardware])

  useEffect(() => {
    if (!window.electronAPI) return

    // 监听下载完成事件，自动刷新状态
    const unsubscribe = window.electronAPI.onModelDownloadComplete(() => {
      console.log('收到模型下载完成事件，正在刷新模型列表...')
      loadModelsAndHardware()
    })

    return (() => { if (unsubscribe) (unsubscribe as any)(); }) as any
  }, [loadModelsAndHardware])

  useEffect(() => {
    setModelStoragePath(getConfigValue<string>('MODEL_STORAGE_PATH') || '')
  }, [getConfigValue])

  const handleActivateModel = async (modelId: string) => {
    const model = models.find(m => m.id === modelId)
    if (!model) return
    try {
      updateConfigValue('SELECTED_MODEL_ID', modelId)
      setModelName(model.name)
      if (window.electronAPI?.aiService) await window.electronAPI!.aiService.onModelChanged(modelId)
    } catch (error) {
      console.error('激活模型失败:', error)
    }
  }

  const handleDownloadModel = async (modelId: string) => {
    setActiveDownloadId(modelId)
    await startDownload(modelId, { autoRetry: true })
  }

  const handleDeleteModel = async (modelId: string) => {
    const model = models.find(m => m.id === modelId)
    if (!model) return
    try {
      const confirmed = await window.electronAPI?.utils?.showMessageBox({
        type: 'warning',
        title: t('确认删除'),
        message: t('确认删除模型 "{model}"?', { model: model.name }),
        buttons: [t('删除'), t('取消')],
        defaultId: 1,
        cancelId: 1
      })
      if (confirmed && confirmed.response === 0) {
        await window.electronAPI!.deleteModel(modelId)
        setModelDownloadStatus(prev => {
          const n = { ...prev }
          delete n[modelId]
          return n
        })
      }
    } catch (e) {
      console.error('删除失败', e)
    }
  }

  const formatModelSize = (model: any): string => {
    if (model.totalSize) return model.totalSize
    if (model.totalSizeBytes) {
      const sizeGB = model.totalSizeBytes / 1024 ** 3
      return `${sizeGB.toFixed(2)}GB`
    }
    return t('未知')
  }

  const isModelExceedsHardware = useCallback(
    (m: any) => {
      if (!hardwareInfo) return false
      const vramReq = m.vramRequiredGB || 0
      const userVramGB = hardwareInfo.vramGB ?? 0

      // 显存判定逻辑更新：
      // 1. 如果模型显存需求 <= 2GB，视为 CPU 兼容，永远不判定为“显存不足”
      if (vramReq <= 2.0) return false

      // 2. 如果显存需求 > 2GB：
      //    - 如果用户显存 <= 1GB (包含 CPU 模式)，则视为显存不足（因为超出了 2GB 阈值）
      //    - 如果用户显存 > 1GB，则允许需求在可用显存 1.2 倍以内的模型
      if (userVramGB <= 1) return true
      return vramReq > userVramGB * 1.2
    },
    [hardwareInfo]
  )

  const groupedModels = useMemo(() => {
    const groups: Record<string, any[]> = {}
    models.forEach(m => {
      const s = m.source || 'ollama'
      if (!groups[s]) groups[s] = []
      groups[s].push(m)
    })

    Object.keys(groups).forEach(source => {
      const group = groups[source]
      const fitting = group.filter(m => !isModelExceedsHardware(m))
      let bestId: string | null = null
      if (fitting.length > 0) {
        bestId = fitting.sort((a, b) => {
          const aRec = recommendedModelIds.includes(a.id) || a.isRecommended,
            bRec = recommendedModelIds.includes(b.id) || b.isRecommended
          if (aRec !== bRec) return aRec ? -1 : 1
          return (b.vramRequiredGB || 0) - (a.vramRequiredGB || 0)
        })[0].id
      }
      groups[source] = group
        .map(m => ({ ...m, isBest: m.id === bestId }))
        .sort((a, b) => {
          if (a.isBest !== b.isBest) return a.isBest ? -1 : 1
          return (a.vramRequiredGB || 0) - (b.vramRequiredGB || 0)
        })
    })
    return groups
  }, [models, isModelExceedsHardware, recommendedModelIds])

  const sourceList = useMemo(() => {
    return (Object.keys(MODEL_SOURCES) as TModelSource[]).filter(
      s => (groupedModels[s]?.length ?? 0) > 0
    )
  }, [groupedModels])

  // 当 sourceList 变化且当前 activeTab 不在 sourceList 中时，默认选中第一个
  useEffect(() => {
    if (sourceList.length > 0) {
      if (!activeTab || !sourceList.includes(activeTab as TModelSource)) {
        setActiveTab(sourceList[0])
      }
    }
  }, [sourceList, activeTab])

  return (
    <div className="p-6 space-y-6 text-foreground">
      <div className="flex justify-between items-start">
        <div>
          <h3 className="text-xl font-black tracking-tight">{t('AI 模型管理')}</h3>
          <p className="text-xs text-muted-foreground font-medium mt-1">
            {t('模型就像AI大脑，它们决定了文件分析准确率与响应速度')}
          </p>
          <p className="text-xs text-muted-foreground font-medium mt-1">
            {t('本地模型相当于：小学（内置）、初中、高中；云端模型：高中、大学水平')}
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
            {t('本地')}
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

      {!isCloudMode && hardwareInfo && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className="flex items-center col-span-3 gap-3 px-4 py-3 bg-muted/20 border border-border/40 rounded-2xl">
            <Cpu className="h-4 w-4 text-muted-foreground/60" />
            <div className="flex flex-col">
              <span className="text-[10px] font-black text-muted-foreground/50 uppercase leading-none mb-1">
                {t('显卡 / 显存')}
              </span>
              <span className="text-xs font-bold text-muted-foreground/80 truncate">
                {hardwareInfo.gpuModel || t('核显')}
                {hardwareInfo.vramGB !== undefined && (
                  <span className="ml-1.5 text-primary/70 text-xl">{hardwareInfo.vramGB}GB</span>
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
                {hardwareInfo.storageFreeGB ? `${hardwareInfo.storageFreeGB}GB` : t('未知')} <span className="text-[8px]">{t('参考')}</span>
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
            {/* <TabsList className="flex w-full justify-start h-14 bg-muted/40 p-0 border-b border-border rounded-none overflow-x-auto no-scrollbar">
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
            </TabsList> */}

            {sourceList.map(s => (
              <TabsContent key={s} value={s} className="p-6 focus-visible:ring-0 m-0">
                {/* <div className="flex items-start gap-3 p-4 bg-primary/5 rounded-2xl border border-primary/10 italic text-xs text-primary font-medium">
                  <Info className="h-4 w-4 text-primary shrink-0" />
                  {MODEL_SOURCES[s].description}
                </div> */}

                <div className="space-y-3">
                  {!groupedModels[s] || groupedModels[s].length === 0 ? (
                    <div className="text-center py-16 text-muted-foreground/30 font-black text-xs uppercase tracking-widest">
                      {t('该来源暂无可用模型')}
                    </div>
                  ) : (
                    groupedModels[s].map(model => {
                      const isDownloaded = modelDownloadStatus[model.id]
                      const isActive = getConfigValue<string>('SELECTED_MODEL_ID') === model.id
                      const isEx = isModelExceedsHardware(model)
                      const isDownloading =
                        downloadState.isDownloading && downloadState.modelId === model.id

                      return (
                        <div
                          key={model.id}
                          className={`group relative flex flex-col p-5 rounded-2xl border-2 transition-all ${isEx ? 'opacity-40 grayscale-[0.6] border-border bg-muted/10' : isActive ? 'bg-primary/5 border-primary shadow-xl ring-4 ring-primary/5' : 'bg-card border-border hover:border-primary/40'}`}
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
                                  {model.isBest && (
                                    <Badge className="text-[10px] font-black h-5 px-2 bg-gradient-to-r from-amber-500 to-orange-600 text-white border-none shadow-md flex items-center gap-1 animate-pulse">
                                      <Star className="h-3.5 w-3.5 fill-current text-white" />{' '}
                                      {t('最佳推荐')}
                                    </Badge>
                                  )}
                                  <Badge
                                    variant="outline"
                                    className="text-[9px] font-black h-4 px-1.5 bg-muted/50 text-muted-foreground border-border uppercase tracking-tighter"
                                  >
                                    {model.parameterSize}
                                  </Badge>
                                  {/* {model.company && (
                                    <Badge
                                      variant="secondary"
                                      className="text-[9px] font-black h-4 px-1.5 bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-200/30 uppercase tracking-tighter"
                                    >
                                      {model.company}
                                    </Badge>
                                  )} */}
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
                                {model.company && `${t('来自')}：${model.company}，`}{model.description}
                              </p>
                              <div className="flex items-center gap-6 text-[10px] font-black text-muted-foreground uppercase tracking-tight">
                                <div className="flex items-center gap-1.5">
                                  <HardDrive className="h-3.5 w-3.5 opacity-50" />
                                  {formatModelSize(model)}
                                </div>

                                <div className="flex items-center gap-1.5 px-2 py-0.5 bg-muted/40 rounded-lg border border-border/50">
                                  <Zap
                                    className={`h-3.5 w-3.5 ${isEx ? 'text-destructive' : 'text-amber-500'}`}
                                  />
                                  <span
                                    className={isEx ? 'text-destructive' : 'text-foreground/70'}
                                  >
                                    {(typeof model.vramRequiredGB === 'number') ? Math.ceil(model.vramRequiredGB) : 'N/A'}
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

                            <div className="flex items-center gap-3 shrink-0 ml-4">
                              {isDownloaded ? (
                                <>
                                  {!isActive && (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() => handleActivateModel(model.id)}
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
                                      onClick={() => handleDeleteModel(model.id)}
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
                                    onClick={() => handleDownloadModel(model.id)}
                                    disabled={
                                      downloadState.isDownloading &&
                                      downloadState.modelId === model.id
                                    }
                                  >
                                    {downloadState.isDownloading &&
                                    downloadState.modelId === model.id ? (
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
                        </div>
                      )
                    })
                  )}
                </div>
              </TabsContent>
            ))}
          </Tabs>
        </Card>
      )}

      {!isCloudMode && !isOllama && (
        <Card className="p-6 border-border shadow-sm rounded-3xl bg-card">
          <div className="space-y-4">
            <div>
              <Label className="text-sm font-black">{t('存储配置')}</Label>
              <p className="text-[11px] text-muted-foreground font-bold mt-1 uppercase tracking-tight">
                {t('模型将保存在以下路径，建议选择非系统盘')}
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
    </div>
  )
}
