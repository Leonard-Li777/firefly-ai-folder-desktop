import i18nScope, { t } from '@app/languages'
import React, { useState, useEffect } from 'react'
import { useVoerkaI18n } from '@voerkai18n/react'
import { Card } from '@components/ui/card'
import { Button } from '@components/ui/button'
import { WelcomeProgress } from './WelcomeProgress'
import { useSettingsStore } from '@stores/settings-store'
import { logger, LogCategory } from '@firefly/shared'

interface OllamaModelDownloadStepProps {
  onNext: () => void
  onBack: () => void
}

export function OllamaModelDownloadStep({ onNext, onBack }: OllamaModelDownloadStepProps) {
  const { t } = useVoerkaI18n(i18nScope)
  const { getConfigValue } = useSettingsStore()
  const selectedModelId = getConfigValue<string>('SELECTED_MODEL_ID') || 'qwen3-vl:4b'

  const [status, setStatus] = useState<'idle' | 'downloading' | 'success' | 'error'>('idle')
  const [progressMessage, setProgressMessage] = useState<string>('')
  const [errorMessage, setErrorMessage] = useState<string>('')

  useEffect(() => {
    // 自动开始下载
    if (status === 'idle' && selectedModelId) {
      startDownload()
    }
  }, [selectedModelId])

  const startDownload = async () => {
    setStatus('downloading')
    setErrorMessage('')
    setProgressMessage(t('正在连接 Ollama 服务...'))

    try {
      // 注册进度监听器
      let unsubscribe: (() => void) | undefined
      if (typeof window.electronAPI?.onOllamaModelProgress === 'function') {
        unsubscribe = window.electronAPI!.onOllamaModelProgress((data: any) => {
          if (data.modelId === selectedModelId) {
            setProgressMessage(data.message)
          }
        })
      }

      // 检查是否已安装
      const checkResult = await window.electronAPI?.ollama?.checkModel?.(selectedModelId)
      if (checkResult?.installed) {
        if (unsubscribe) unsubscribe()
        setStatus('success')
        // 自动跳转
        setTimeout(() => {
          onNext()
        }, 1500)
        return
      }

      // 开始拉取
      const result = await window.electronAPI?.ollama?.pullModel?.(selectedModelId)

      if (unsubscribe) unsubscribe()

      if (result?.success) {
        setStatus('success')
        setTimeout(() => {
          onNext()
        }, 1500)
      } else {
        setStatus('error')
        setErrorMessage(result?.error || t('下载失败，请检查网络连接'))
      }
    } catch (error) {
      logger.error(LogCategory.RENDERER, '拉取模型失败:', error)
      setStatus('error')
      setErrorMessage(t('未知错误'))
    }
  }

  return (
    <div className="h-full min-h-full bg-white text-slate-900 flex flex-col">
      <WelcomeProgress currentStep={5} />

      <div className="flex-grow flex flex-col items-center justify-center p-6">
        <div className="max-w-xl w-full">
          <header className="text-center mb-8">
            <h1 className="text-2xl font-bold tracking-tight mb-2">{t('下载模型')}</h1>
            <p className="text-slate-600">
              {t('正在为您准备 AI 模型：{modelId}', { modelId: selectedModelId })}
            </p>
          </header>

          <Card className="p-8">
            {status === 'downloading' && (
              <div className="text-center">
                <div className="inline-block animate-spin rounded-full h-12 w-12 border-4 border-slate-200 border-t-sky-500 mb-6"></div>
                <h3 className="text-lg font-medium mb-2">{t('正在下载中...')}</h3>
                <p className="text-sm text-slate-500 mb-2">
                  {t('如果下载慢，开启VPN或游戏加速器可以显著改善下载速度')}
                </p>
                <div className="rounded-lg p-3 text-xs font-mono text-left max-h-32 overflow-y-auto whitespace-pre-wrap">
                  {progressMessage || t('准备中...')}
                </div>
              </div>
            )}

            {status === 'success' && (
              <div className="text-center">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-green-100 text-green-600 mb-6">
                  <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M5 13l4 4L19 7"
                    />
                  </svg>
                </div>
                <h3 className="text-lg font-medium mb-2">{t('下载完成！')}</h3>
                <p className="text-sm text-slate-500">{t('模型已准备就绪')}</p>
              </div>
            )}

            {status === 'error' && (
              <div className="text-center">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-red-100 text-red-600 mb-6">
                  <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </div>
                <h3 className="text-lg font-medium mb-2">{t('下载失败')}</h3>
                <p className="text-sm text-slate-500 mb-6">
                  {t('{errorMessage}，请稍后再试或选择其它模型下载', { errorMessage })}
                </p>
                <Button onClick={startDownload} variant="default">
                  {t('重试')}
                </Button>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}
