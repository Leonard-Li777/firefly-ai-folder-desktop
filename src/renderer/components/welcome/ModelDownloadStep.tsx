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
  const [isDownloading, setIsDownloading] = useState(false)

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

  // 获取所有模型列表
  useEffect(() => {
    const fetchModels = async () => {
      try {
        if (typeof window.electronAPI?.listModels === 'function') {
          const models = await window.electronAPI!.listModels()
          setAllModels(models)
        }
      } catch (err) {
        console.error('获取模型列表失败:', err)
      }
    }
    fetchModels()
  }, [])

  // 检查模型是否已下载
  useEffect(() => {
    const checkModelDownloaded = async () => {
      logger.debug(LogCategory.RENDERER, `[ModelDownloadStep] 检查模型 ID: "${selectedModelId}"`)

      if (selectedModelId) {
        try {
          const status = await checkDownloadStatus()
          if (status.isDownloaded) {
            // 如果模型已下载，直接跳转到下载完成页面
            logger.info(
              LogCategory.RENDERER,
              `[ModelDownloadStep] 模型已下载，跳过下载页: ${selectedModelId}`
            )
            setIsDownloading(false)
            setTimeout(() => {
              onNext()
            }, 1000)
            return
          }
        } catch (err) {
          logger.error(
            LogCategory.RENDERER,
            `[ModelDownloadStep] 检查模型下载状态失败: ${selectedModelId}`,
            err
          )
        }
      } else {
        logger.warn(LogCategory.RENDERER, '[ModelDownloadStep] 选中模型 ID 为空，无法检查状态')
        return // 如果 ID 为空，不应触发 startDownload
      }

      // 如果模型未下载，开始下载
      if (downloadState.status === 'canceled') {
        logger.info(
          LogCategory.RENDERER,
          `[ModelDownloadStep] 下载已取消，不再自动重启: ${selectedModelId}`
        )
        return
      }

      logger.info(
        LogCategory.RENDERER,
        `[ModelDownloadStep] 模型未下载，触发自动下载: ${selectedModelId}`
      )
      startDownload()
    }

    checkModelDownloaded()
  }, [selectedModelId, onNext, checkDownloadStatus, startDownload, downloadState.status])

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
                <h1 className="text-2xl font-bold tracking-tight">{t('下载AI模型')}</h1>
                <p className="mt-2 text-sm text-slate-500">
                  {modelStoragePath
                    ? t('模型将保存至：{path}', { path: modelStoragePath })
                    : t('尚未设置存储目录')}
                </p>
              </header>

              {/* 使用新的通用下载进度组件 */}
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
