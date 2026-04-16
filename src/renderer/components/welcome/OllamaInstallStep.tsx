import React, { useEffect, useState, useCallback, useRef } from 'react'
import { useVoerkaI18n } from '@voerkai18n/react'
import { Button } from '@components/ui/button'
import { Card } from '@components/ui/card'
import { WelcomeProgress } from './WelcomeProgress'
import i18nScope from '@src/languages'
import { LogCategory, logger } from '@yonuc/shared'
import { captureEvent } from '../../lib/posthog'

interface OllamaInstallStepProps {
  onComplete: () => void
  onBack?: () => void
}

export function OllamaInstallStep({ onComplete, onBack }: OllamaInstallStepProps) {
  const { t } = useVoerkaI18n(i18nScope)
  const [installStatus, setInstallStatus] = useState<'checking' | 'ready' | 'installing' | 'success' | 'error'>('checking')
  const [progressMessage, setProgressMessage] = useState<string>('')
  const [installLogs, setInstallLogs] = useState<string[]>([])
  const [errorMessage, setErrorMessage] = useState<string>('')
  const [cleanupFns, setCleanupFns] = useState<Array<() => void>>([])
  const logsEndRef = useRef<HTMLDivElement>(null)

  // 简单的 ANSI 去除正则
  const stripAnsi = (str: string) => {
    return str.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
  }

  // 自动滚动到底部
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [installLogs])

  // 重启应用
  const restartApp = useCallback(() => {
    if (window.electronAPI?.ollama?.relaunch) {
      window.electronAPI!.ollama.relaunch()
    } else {
      window.location.reload()
    }
  }, [])

  // 清理监听器
  const cleanup = useCallback(() => {
    cleanupFns.forEach(fn => fn())
    setCleanupFns([])
  }, [cleanupFns])

  // 检查 Ollama 安装状态
  useEffect(() => {
    const checkOllama = async () => {
      try {
        const result = await window.electronAPI?.ollama?.checkInstallation?.()
        if (result?.installed) {
          onComplete()
        } else {
          setInstallStatus('ready')
        }
      } catch (error) {
        logger.error(LogCategory.RENDERER, '检查 Ollama 安装状态失败:', error)
        setInstallStatus('ready')
      }
    }

    checkOllama()

    return () => {
      cleanup()
    }
  }, [])

  // 安装 Ollama
  const handleInstall = async () => {
    setInstallStatus('installing')
    setProgressMessage(t('正在安装 Ollama...'))
    setInstallLogs([])
    setErrorMessage('')
    captureEvent('Ollama安装开始')

    try {
      // 设置进度监听
      const progressHandler = (data: any) => {
        const msg = data.message || t('正在安装...')
        setProgressMessage(msg)
        setInstallLogs(prev => [...prev, stripAnsi(msg)])
      }
      
      const completeHandler = async () => {
        setInstallStatus('success')
        setProgressMessage(t('安装完成，重启应用后即可使用'))
        captureEvent('Ollama安装成功')
        
        setTimeout(() => {
          restartApp()
        }, 2000)
      }
      
      const errorHandler = (data: any) => {
        setInstallStatus('error')
        setErrorMessage(data.error || t('安装失败'))
        captureEvent('Ollama安装失败', { error: data.error })
      }
      
      const statusHandler = (data: any) => {
        if (data.status === 'installed') {
          setInstallStatus('ready')
        }
      }

      // 注册事件监听
      if (window.electronAPI?.onOllamaInstallProgress) {
        const unsubscribe = window.electronAPI!.onOllamaInstallProgress(progressHandler)
        setCleanupFns(prev => [...prev, unsubscribe])
      }

      if (window.electronAPI?.onOllamaInstallComplete) {
        const unsubscribe = window.electronAPI!.onOllamaInstallComplete(completeHandler)
        setCleanupFns(prev => [...prev, unsubscribe])
      }

      if (window.electronAPI?.onOllamaInstallError) {
        const unsubscribe = window.electronAPI!.onOllamaInstallError(errorHandler)
        setCleanupFns(prev => [...prev, unsubscribe])
      }

      if (window.electronAPI?.onOllamaStatusChanged) {
        const unsubscribe = window.electronAPI!.onOllamaStatusChanged(statusHandler)
        setCleanupFns(prev => [...prev, unsubscribe])
      }

      const result = await window.electronAPI?.ollama?.install?.()
      if (!result?.success) {
        setInstallStatus('error')
        setErrorMessage(t('安装失败'))
      }
    } catch (error) {
      logger.error(LogCategory.RENDERER, '安装 Ollama 失败:', error)
      setInstallStatus('error')
      setErrorMessage(error instanceof Error ? error.message : String(error))
    }
  }

  // 打开官网
  const handleOpenWebsite = async () => {
    await window.electronAPI?.utils?.openExternal?.('https://ollama.com/')
  }

  if (installStatus === 'checking') {
    return (
      <div className="h-full min-h-full bg-white text-slate-900 flex flex-col">
        <WelcomeProgress currentStep={3} />
        <div className="flex-grow flex items-center justify-center">
          <div className="text-center">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-sky-500 mb-4"></div>
            <p>{t('正在检测 Ollama 安装状态...')}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full min-h-full bg-white text-slate-900 flex flex-col">
      <WelcomeProgress currentStep={3} />

      <div className="flex-grow flex flex-col">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-6 w-full">
          <header className="mb-6">
            <h1 className="text-2xl font-bold tracking-tight">{t('安装 AI 引擎')}</h1>
            <p className="mt-2 text-slate-600">
              {t('本应用需要社区知名开源AI引擎 Ollama 作为本地服务来处理文件分析任务')}
            </p>
          </header>

          {/* Ollama 特性介绍 */}
          <Card className="rounded-xl bg-white text-slate-900 shadow-sm  p-6 mb-6">
            <h2 className="text-lg font-semibold mb-4">{t('关于 Ollama')}</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
              <div className="flex items-start gap-2">
                <div className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
                  <span className="text-green-600">✓</span>
                </div>
                <div>
                  <p className="font-medium">{t('本地运行保护隐私')}</p>
                  <p className="text-slate-500">{t('所有数据在本地处理，不会上传到云端')}</p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <div className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
                  <span className="text-green-600">✓</span>
                </div>
                <div>
                  <p className="font-medium">{t('多模态支持')}</p>
                  <p className="text-slate-500">{t('支持文本和图像理解，可分析漫画、图片等')}</p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <div className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
                  <span className="text-green-600">✓</span>
                </div>
                <div>
                  <p className="font-medium">{t('轻量高效')}</p>
                  <p className="text-slate-500">{t('优化的模型运行效率，低配置也能流畅运行')}</p>
                </div>
              </div>
              <div className="flex items-start gap-2">
                <div className="w-6 h-6 rounded-full bg-green-100 flex items-center justify-center flex-shrink-0">
                  <span className="text-green-600">✓</span>
                </div>
                <div>
                  <p className="font-medium">{t('国内外AI模型安装自动加速')}</p>
                  <p className="text-slate-500">{t('支持国内外主流AI模型，安装自动加速，无需手动配置')}</p>
                </div>
              </div>
            </div>
          </Card>

          {/* 安装状态显示 */}
          {installStatus === 'installing' && (
            <Card className="rounded-xl bg-blue-50 border border-blue-200  text-slate-900  p-6 mb-6">
              <div className="flex flex-col gap-3">
                <div className="flex items-center gap-3">
                  <div className="inline-block animate-spin rounded-full h-6 w-6 border-t-2 border-b-2 border-blue-500"></div>
                  <div>
                    <p className="font-medium">{t('正在安装 Ollama...')}</p>
                    <p className="text-sm text-slate-600">{progressMessage}</p>
                  </div>
                </div>

                {/* 终端风格的日志窗口 */}
                <div className="mt-2 h-48 overflow-y-auto rounded-md bg-slate-900 p-3 text-xs font-mono text-slate-50 shadow-inner">
                  {installLogs.length === 0 && <div className="text-slate-400 italic">{t('等待日志输出...')}</div>}
                  {installLogs.map((log, index) => (
                    <div key={index} className="break-words whitespace-pre-wrap">{log}</div>
                  ))}
                  <div ref={logsEndRef} />
                </div>
              </div>
            </Card>
          )}

          {installStatus === 'success' && (
            <Card className="rounded-xl bg-green-50 border border-green-200 text-slate-900 p-6 mb-6">
              <div className="flex items-center gap-3">
                <div className="w-6 h-6 rounded-full bg-green-500 flex items-center justify-center">
                  <span className="text-white">✓</span>
                </div>
                <div>
                  <p className="font-medium">{t('安装成功！')}</p>
                  <p className="text-sm text-slate-600">{progressMessage}</p>
                </div>
              </div>
            </Card>
          )}

          {installStatus === 'error' && (
            <Card className="rounded-xl bg-red-50 border border-red-200 text-slate-900 p-6 mb-6">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-6 h-6 rounded-full bg-red-500 flex items-center justify-center">
                  <span className="text-white">✕</span>
                </div>
                <div>
                  <p className="font-medium">{t('安装失败')}</p>
                  <p className="text-sm text-slate-600">{errorMessage}</p>
                </div>
              </div>
              <Button variant="outline" onClick={handleOpenWebsite} className="mr-3">
                {t('手动下载')}
              </Button>
              <Button variant="default" onClick={handleInstall}>
                {t('重试')}
              </Button>
            </Card>
          )}
        </div>

        {/* 固定在底部的操作按钮 */}
        <div className="sticky bottom-0 bg-white py-4 mt-auto border-t border-slate-200 z-10 w-full">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8">
            <div className="flex justify-between">
              {onBack && (
                <Button
                  variant="outline"
                  onClick={onBack}
                  className="h-11 rounded-xl px-6 font-semibold"
                >
                  {t('返回')}
                </Button>
              )}
              <div className="flex gap-3 ml-auto">
                {installStatus === 'ready' && (
                  <>
                    <Button
                      variant="outline"
                      onClick={handleOpenWebsite}
                      className="h-11 rounded-xl px-6 font-semibold"
                    >
                      {t('了解更多')}
                    </Button>
                    <Button
                      variant="default"
                      onClick={handleInstall}
                      className="h-11 rounded-xl bg-slate-900 px-10 font-semibold text-white hover:bg-slate-800"
                    >
                      {t('开始安装')}
                    </Button>
                  </>
                )}
                {installStatus === 'success' && (
                  <Button
                    variant="default"
                    onClick={onComplete}
                    className="h-11 rounded-xl bg-green-600 px-10 font-semibold text-white hover:bg-green-700"
                  >
                    {t('继续')}
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
