import React, { useState, useEffect, useRef } from 'react'
import { useVoerkaI18n } from '@voerkai18n/react'
import { Card } from '@components/ui/card'
import { Button } from '@components/ui/button'
import { useSettingsStore } from '@stores/settings-store'
import { DownloadProgressEvent } from '@yonuc/types/types'
import { WelcomeProgress } from './WelcomeProgress'
import { ModelDownloadProgress } from '@components/download/ModelDownloadProgress'
import { useModelDownload } from '@hooks/use-model-download'
import type { IModelSummary } from '@yonuc/types/model-manager'
import { logger, LogCategory } from '@yonuc/shared'
import i18nScope from '@src/languages'

interface ModelDownloadStepProps {
  onNext: () => void
  onBack: () => void
}

export function ModelDownloadStep({ onNext, onBack }: ModelDownloadStepProps) {
  const { t } = useVoerkaI18n(i18nScope)
  const selectedModelId = useSettingsStore(state =>
    state.getConfigValue<string>('SELECTED_MODEL_ID')
  )
  const modelStoragePath = useSettingsStore(state =>
    state.getConfigValue<string>('MODEL_STORAGE_PATH')
  )

  const [allModels, setAllModels] = useState<IModelSummary[]>([])
  const [isDeployingEngine, setIsDeployingEngine] = useState(false)
  const [engineError, setEngineError] = useState<string | null>(null)

  const downloadOptions = React.useMemo(
    () => ({
      autoStart: false,
      onDownloadComplete: () => {
        setTimeout(() => {
          onNext()
        }, 1000)
      }
    }),
    [onNext]
  )

  const {
    state: downloadState,
    startDownload,
    cancelDownload,
    checkDownloadStatus,
    retryDownload
  } = useModelDownload(selectedModelId || '', downloadOptions)

  // 检查模型并确保引擎就绪
  useEffect(() => {
    const ensureReadyAndDownload = async () => {
      try {
        // 1. 获取当前引擎
        const config = await window.electronAPI!.getConfig()
        const currentEngine = config.ai?.AI_ENGINE || 'llama.cpp'

        // 2. 如果是 llama.cpp 或 llamafile，先确保引擎已部署（解压 Bundle 等）
        if (currentEngine === 'llama.cpp' || currentEngine === 'llamafile') {
          setIsDeployingEngine(true)
          logger.info(LogCategory.RENDERER, `[ModelDownloadStep] 正在确保 ${currentEngine} 引擎已部署...`)
          // 关键修正：传递 onlyDeploy: true，防止提前启动服务器
          await window.electronAPI!.aiService.initialize({ onlyDeploy: true })
          setIsDeployingEngine(false)

          // 对于 llamafile，部署完引擎即视为“部署了轻量内置模型”，直接跳转到下一步
          if (currentEngine === 'llamafile') {
            logger.info(LogCategory.RENDERER, '[ModelDownloadStep] llamafile 引擎部署完成，自动进入下一步')
            onNext()
            return
          }
        }

        if (!selectedModelId) return

        // 3. 检查模型状态
        const status = await checkDownloadStatus()
        if (status.isDownloaded) {
          onNext()
          return
        }

        // 4. 开始下载
        if (downloadState.status !== 'canceled') {
          startDownload()
        }
      } catch (err: any) {
        logger.error(LogCategory.RENDERER, '[ModelDownloadStep] 准备下载环境失败', err)
        setEngineError(err.message || String(err))
        setIsDeployingEngine(false)
      }
    }

    ensureReadyAndDownload()
  }, [selectedModelId]) // 简化依赖，仅在模型 ID 确定时运行一次

  const handleCancel = async () => {
    await cancelDownload()
    onBack()
  }

  const handleRetry = async () => {
    await retryDownload()
  }

  // 获取手动下载信息
  const getManualDownloadInfo = () => {
    const selectedModel = allModels.find(model => model.id === selectedModelId)
    if (!selectedModel) {
      return { files: [], storagePath: undefined }
    }

    return {
      files: selectedModel.files.map(file => ({ type: file.type, url: file.url })),
      storagePath: (modelStoragePath ? `${modelStoragePath}\\${selectedModelId}` : undefined) as
        | string
        | undefined
    }
  }

  return (
    <div className="xbg-slate-50 text-slate-900 flex flex-col">
      <WelcomeProgress currentStep={5} />

      {/* 主要内容区域 */}
      <div className="flex-grow overflow-hidden">
        <div className="h-full flex flex-col">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-10 flex-grow overflow-auto">
            <section className="mx-auto max-w-3xl">
              <header className="text-center mb-6">
                <h1 className="text-2xl font-bold tracking-tight">
                  {isDeployingEngine ? t('准备 AI 引擎') : t('下载 AI 模型')}
                </h1>
                <p className="mt-2 text-sm text-slate-500">
                  {isDeployingEngine 
                    ? t('正在布署内置 AI 引擎，请稍后...') 
                    : (modelStoragePath ? t('模型将保存至：{path}', { path: modelStoragePath }) : t('尚未设置存储目录'))}
                </p>
              </header>

              {/* 使用新的通用下载进度组件 */}
              {isDeployingEngine ? (
                <div className="flex flex-col items-center justify-center p-12 bg-white rounded-2xl border border-slate-100 shadow-sm mb-6">
                  <div className="w-12 h-12 rounded-full border-4 border-sky-500/20 border-t-sky-500 animate-spin mb-4" />
                  <p className="text-slate-600 font-bold">{t('正在布署内置轻量模型，请稍后...')}</p>
                </div>
              ) : (
                <ModelDownloadProgress
                  progress={downloadState.downloadProgress || null}
                  isDownloading={downloadState.isDownloading}
                  isPaused={downloadState.isPaused}
                  status={downloadState.status}
                  error={downloadState.error}
                  onCancel={handleCancel}
                  onRetry={handleRetry}
                  showManualDownloadInfo={!!downloadState.error}
                  manualDownloadInfo={getManualDownloadInfo()}
                  className="mb-6"
                />
              )}

              <h2 className="mt-8 text-lg font-semibold">{t('关键功能')}</h2>
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Card className="rounded-xl bg-white shadow-sm ring-1 ring-slate-200 p-4">
                  <p className="text-xs uppercase tracking-wide text-slate-500">
                    {t('AI智能分析')}
                  </p>
                  <p className="mt-1 text-sm text-slate-700">
                    {t('利用先进的AI技术分析和理解您的数据')}
                  </p>
                </Card>
                <Card className="rounded-xl bg-white shadow-sm ring-1 ring-slate-200 p-4">
                  <p className="text-xs uppercase tracking-wide text-slate-500">
                    {t('虚拟文件夹')}
                  </p>
                  <p className="mt-1 text-sm text-slate-700">
                    {t('整理文件生成虚拟文件夹，使用文件链接技术，不占存储空间')}
                  </p>
                </Card>
                <Card className="rounded-xl bg-white shadow-sm ring-1 ring-slate-200 p-4">
                  <p className="text-xs uppercase tracking-wide text-slate-500">{t('一键整理')}</p>
                  <p className="mt-1 text-sm text-slate-700">
                    {t('快速精准分类文件和名命简化文件管理')}
                  </p>
                </Card>
                <Card className="rounded-xl bg-white shadow-sm ring-1 ring-slate-200 p-4">
                  <p className="text-xs uppercase tracking-wide text-slate-500">
                    {t('自定义整理')}
                  </p>
                  <p className="mt-1 text-sm text-slate-700">
                    {t('丰富的目录树标签助你自定义组织文件')}
                  </p>
                </Card>
                <Card className="rounded-xl bg-white shadow-sm ring-1 ring-slate-200 p-4">
                  <p className="text-xs uppercase tracking-wide text-slate-500">{t('隐私安全')}</p>
                  <p className="mt-1 text-sm text-slate-700">
                    {t('本地大模型，数据不上云，稳私无忧')}
                  </p>
                </Card>
                <Card className="rounded-xl bg-white shadow-sm ring-1 ring-slate-200 p-4">
                  <p className="text-xs uppercase tracking-wide text-slate-500">{t('质量评分')}</p>
                  <p className="mt-1 text-sm text-slate-700">{t('通过智能分析为文件质量打分')}</p>
                </Card>
              </div>

              <div className="mt-8 flex justify-between">
                <Button variant="outline" onClick={onBack}>
                  {t('返回')}
                </Button>
                <div></div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  )
}
