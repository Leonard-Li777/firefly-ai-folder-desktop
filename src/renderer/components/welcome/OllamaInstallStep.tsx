import React, { useEffect, useState, useCallback, useRef, useMemo } from 'react'
import { useVoerkaI18n } from '@voerkai18n/react'
import { Button } from '@components/ui/button'
import { Card, CardContent } from '@components/ui/card'
import { Badge } from '@components/ui/badge'
import { WelcomeProgress } from './WelcomeProgress'
import { openExternalLink } from '../../lib/external-link'
import i18nScope from '@src/languages'
import { LogCategory, logger } from '@yonuc/shared'
import { MaterialIcon } from '../../lib/utils'
import { toast } from '../../components/common/Toast'
import { captureEvent } from '../../lib/posthog'
import { ProgressBar } from '@components/ui/ProgressBar'
import { Download, Info, RefreshCw, Star, Cpu, Loader2, Globe, Zap } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@components/ui/alert-dialog'

interface OllamaInstallStepProps {
  onComplete: () => void
  onBack?: () => void
  onSwitchToCloud?: () => void
}

interface DownloadInfo {
  percent: number
  speed: number
  receivedMB: string
  totalMB: string
  eta: string
}

export function OllamaInstallStep({ onComplete, onBack, onSwitchToCloud }: OllamaInstallStepProps) {
  const { t } = useVoerkaI18n(i18nScope)
  const [installStatus, setInstallStatus] = useState<
    'checking' | 'ready' | 'installing' | 'success' | 'error'
  >('checking')
  const [progressMessage, setProgressMessage] = useState<string>('')
  const [installLogs, setInstallLogs] = useState<string[]>([])
  const [downloadInfo, setDownloadInfo] = useState<DownloadInfo | null>(null)
  const [errorMessage, setErrorMessage] = useState<string>('')
  const [showSuccessDialog, setShowSuccessDialog] = useState(false)

  const cleanupFnsRef = useRef<Array<() => void>>([])
  const hasStartedRef = useRef(false)
  const logsEndRef = useRef<HTMLDivElement>(null)

  const [platform, setPlatform] = useState<'win32' | 'darwin' | 'linux'>('win32')
  const [mirror, setMirror] = useState<'cn' | 'global'>('cn')

  /**
   * 动态计算下载链接 - 严格绑定 mirror 状态
   */
  const downloadLinks = useMemo(() => {
    const isCN = mirror === 'cn';
    return {
      darwin: isCN 
        ? 'https://cnb.cool/hex/ollama/-/releases/latest/download/Ollama.dmg' 
        : 'https://ollama.com/download/Ollama.dmg',
      win32: isCN 
        ? 'https://cnb.cool/hex/ollama/-/releases/latest/download/OllamaSetup.exe' 
        : 'https://ollama.com/download/OllamaSetup.exe',
      linux: isCN 
        ? 'https://cnb.cool/hex/ollama/-/git/raw/main/install.sh' 
        : 'https://ollama.com/install.sh'
    };
  }, [mirror]);

  /**
   * 动态计算安装指令
   */
  const commands = useMemo(() => {
    return {
      darwin: `# 下载并安装 Ollama\ncurl -fsSL ${downloadLinks.darwin} -o Ollama.dmg\nopen Ollama.dmg`,
      win32: `# 使用 PowerShell 下载并运行安装程序\nInvoke-WebRequest -Uri "${downloadLinks.win32}" -OutFile "OllamaSetup.exe"\nStart-Process "OllamaSetup.exe"`,
      linux: `# 自动安装脚本\ncurl -fsSL ${downloadLinks.linux} | sh`
    };
  }, [downloadLinks]);

  const platformNames = {
    darwin: 'macOS',
    win32: 'Windows',
    linux: 'Linux'
  }

  const formatSpeed = (bytesPerSecond: number) => {
    if (bytesPerSecond > 1024 * 1024) return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`
    return `${(bytesPerSecond / 1024).toFixed(1)} KB/s`
  }

  const formatETA = (seconds: number) => {
    if (!isFinite(seconds) || seconds < 0) return '--:--'
    const mins = Math.floor(seconds / 60)
    const secs = Math.floor(seconds % 60)
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
  }

  const stripAnsi = (str: string) => {
    return str.replace(
      /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
      ''
    )
  }

  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [installLogs])

  const restartApp = useCallback(() => {
    if (typeof window.electronAPI?.ollama?.relaunch === "function") {
      window.electronAPI!.ollama.relaunch()
    } else {
      window.location.reload()
    }
  }, [])

  const exitApp = useCallback(() => {
    if (typeof window.electronAPI?.ollama?.exit === "function") {
      window.electronAPI!.ollama.exit()
    } else {
      window.close()
    }
  }, [])

  const performCleanup = useCallback(() => {
    cleanupFnsRef.current.forEach(fn => {
      try {
        fn()
      } catch (e) {
        /* ignore */
      }
    })
    cleanupFnsRef.current = []
  }, [])

  /**
   * 核心：直接获取当前下载源配置
   * 采用专用的 getDownloadMirror 接口以获得最高优先级
   */
  const refreshMirrorState = useCallback(async () => {
    try {
      const getMirror = window.electronAPI?.ollama?.getDownloadMirror;
      logger.debug(LogCategory.RENDERER, `[MirrorDebug] 尝试获取镜像源状态... getMirror接口是否存在: ${!!getMirror}`)
      if (getMirror) {
        const val = await getMirror();
        setMirror(val);
        logger.info(LogCategory.RENDERER, `[MirrorDebug] 已通过专用接口同步下载镜像源状态: ${val}`)
        return val;
      } else {
        logger.warn(LogCategory.RENDERER, `[MirrorDebug] getDownloadMirror 接口缺失，使用默认 'cn'`)
      }
    } catch (e) {
      logger.error(LogCategory.RENDERER, '[MirrorDebug] Failed to sync mirror state via dedicated API:', e)
    }
    return 'cn'
  }, [])

  const handleInstall = useCallback(async () => {
    // 强制先切换 UI 状态
    setInstallStatus('installing')
    setProgressMessage(t('正在启动下载任务...'))
    setInstallLogs([])
    setDownloadInfo(null)
    setErrorMessage('')

    performCleanup()
    
    // 启动前最后确认一次镜像状态
    const currentMirror = await refreshMirrorState()
    logger.info(LogCategory.RENDERER, `[MirrorDebug] handleInstall 启动，当前使用的镜像源: ${currentMirror}`)
    captureEvent('Ollama安装开始', { mirror: currentMirror })

    try {
      const progressHandler = (data: any) => {
        if (data.percent !== undefined) {
          const etaSeconds =
            data.speed > 0 ? (data.totalBytes - data.receivedBytes) / data.speed : 0
          setDownloadInfo({
            percent: data.percent,
            speed: data.speed,
            receivedMB: (data.receivedBytes / 1024 / 1024).toFixed(1),
            totalMB: (data.totalBytes / 1024 / 1024).toFixed(1),
            eta: formatETA(etaSeconds)
          })
          setProgressMessage(data.message)
          
          // 仅在进度开始时记录一次 URL 相关信息
          if (data.percent < 1 && data.message) {
             logger.debug(LogCategory.RENDERER, `[MirrorDebug] 收到下载进度，消息: ${data.message}`)
          }
        } else {
          const msg = data.message || ''
          setProgressMessage(msg)
          setInstallLogs(prev => [...prev, stripAnsi(msg)])
          logger.debug(LogCategory.RENDERER, `[MirrorDebug] 收到安装日志消息: ${msg}`)
        }
      }

      const completeHandler = async () => {
        logger.info(LogCategory.RENDERER, `[MirrorDebug] Ollama 安装/下载完成通知`)
        setInstallStatus('success')
        setProgressMessage(t('安装准备就绪'))
        setShowSuccessDialog(true)
        captureEvent('Ollama安装步骤完成')
      }

      const errorHandler = (data: any) => {
        logger.error(LogCategory.RENDERER, `[MirrorDebug] Ollama 安装出错通知`, data)
        const errorMsg = data.error || t('安装失败')
        setInstallStatus('error')
        setErrorMessage(errorMsg)
        
        const displayMessage = errorMsg.replace(/^Error invoking remote method.*?: Error: /, '')
        toast.error(t('安装失败: {message}', { message: displayMessage }))
        captureEvent('Ollama安装失败', { error: data.error })
      }

      if (typeof window.electronAPI?.onOllamaInstallProgress === "function") {
        cleanupFnsRef.current.push(window.electronAPI!.onOllamaInstallProgress(progressHandler))
      }
      if (typeof window.electronAPI?.onOllamaInstallComplete === "function") {
        cleanupFnsRef.current.push(window.electronAPI!.onOllamaInstallComplete(completeHandler))
      }
      if (typeof window.electronAPI?.onOllamaInstallError === "function") {
        cleanupFnsRef.current.push(window.electronAPI!.onOllamaInstallError(errorHandler))
      }

      logger.info(LogCategory.RENDERER, `[MirrorDebug] 调用后端 ollama:install...`)
      const result = await window.electronAPI?.ollama?.install?.()
      logger.info(LogCategory.RENDERER, `[MirrorDebug] 后端 ollama:install 调用结果:`, result)
      if (!result?.success && installStatus !== 'success') {
        setInstallStatus('error')
      }
    } catch (error: any) {
      logger.error(LogCategory.RENDERER, '[MirrorDebug] 安装 Ollama 失败:', error)
      setInstallStatus('error')
      const errorMsg = error instanceof Error ? error.message : String(error)
      setErrorMessage(errorMsg)
      const displayMessage = errorMsg.replace(/^Error invoking remote method.*?: Error: /, '')
      toast.error(t('启动安装失败: {message}', { message: displayMessage }))
    }
  }, [t, performCleanup, refreshMirrorState, installStatus])

  const handleCancelAndBack = async () => {
    try {
      logger.info(LogCategory.RENDERER, `[MirrorDebug] 取消安装...`)
      await window.electronAPI?.ollama?.cancelInstall?.()
      performCleanup()
      if (onBack) onBack()
    } catch (error) {
      logger.error(LogCategory.RENDERER, '取消安装操作失败:', error)
      performCleanup()
      if (onBack) onBack()
    }
  }

  // 1. 初始化基础配置与暴力变更监听
  useEffect(() => {
    const platformStr = window.electronAPI?.utils?.getPlatform?.() || 'win32'
    setPlatform(platformStr as any)
    logger.info(LogCategory.RENDERER, `[MirrorDebug] 组件挂载，检测平台: ${platformStr}`)
    refreshMirrorState()

    // 核心改进：同时监听通用配置变更和专用的镜像源强刷事件
    const unsubscribeGeneral = window.electronAPI?.onConfigChange?.((config) => {
      logger.debug(LogCategory.RENDERER, `[MirrorDebug] 监听到通用配置变更，DOWNLOAD_MIRROR: ${config.DOWNLOAD_MIRROR}`)
      refreshMirrorState()
    })

    const unsubscribeMirrorSync = window.electronAPI?.ollama?.onMirrorSync?.((newMirror) => {
      logger.info(LogCategory.RENDERER, `[MirrorDebug] 收到主进程暴力同步镜像源通知: ${newMirror}`)
      setMirror(newMirror)
    })

    return () => {
      if (unsubscribeGeneral) unsubscribeGeneral()
      if (unsubscribeMirrorSync) unsubscribeMirrorSync()
    }
  }, [refreshMirrorState])

  // 2. 主初始化流程：增加探测等待与状态切换
  useEffect(() => {
    if (hasStartedRef.current) return
    hasStartedRef.current = true

    const init = async () => {
      try {
        logger.info(LogCategory.RENDERER, `[MirrorDebug] 启动初始化流程...`)
        // Step 1: 积极等待地域探测结果 (RegionDetectionService 在应用启动后约 1-3 秒完成)
        let currentMirror = await refreshMirrorState()
        
        if (currentMirror === 'global') {
          logger.debug(LogCategory.RENDERER, '[MirrorDebug] 初始镜像为 global，尝试等待探测完成...')
          for (let i = 0; i < 10; i++) { // 延长至 5 秒
            await new Promise(r => setTimeout(r, 500))
            currentMirror = await refreshMirrorState()
            if (currentMirror === 'cn') {
              logger.info(LogCategory.RENDERER, '[MirrorDebug] 初始化：成功检测到镜像源自动切换为 CN')
              break
            }
          }
        }

        logger.info(LogCategory.RENDERER, `[MirrorDebug] 探测周期结束，最终使用镜像: ${currentMirror}`)

        // Step 2: 切换到 ready 状态，显示卡片
        setInstallStatus('ready')

        // Step 3: 检测安装状态
        logger.info(LogCategory.RENDERER, `[MirrorDebug] 检查 Ollama 是否已安装...`)
        const result = await window.electronAPI?.ollama?.checkInstallation?.()
        logger.info(LogCategory.RENDERER, `[MirrorDebug] 检查结果:`, result)
        
        if (result?.installed) {
          logger.info(LogCategory.RENDERER, `[MirrorDebug] Ollama 已安装，跳过下载`)
          onComplete()
        } else {
          // Step 4: 启动安装流程
          logger.info(LogCategory.RENDERER, `[MirrorDebug] Ollama 未安装，准备自动启动下载...`)
          handleInstall()
        }
      } catch (error) {
        logger.error(LogCategory.RENDERER, '[MirrorDebug] 初始化 Ollama 安装步骤失败:', error)
        setInstallStatus('ready')
        handleInstall()
      }
    }

    init()
    return () => performCleanup()
  }, [onComplete, handleInstall, refreshMirrorState, performCleanup])

  const handleOpenWebsite = async () => {
    await openExternalLink('https://ollama.com/download');
  }

  const copyToClipboard = (text: string) => {
    if (window.navigator?.clipboard) {
      window.navigator.clipboard.writeText(text)
    }
  }

  const handleDownload = async (url: string) => {
    await openExternalLink(url, { errorTitle: t('无法打开下载链接') });
  }

  // 正在检测状态
  if (installStatus === 'checking') {
    return (
      <div className="h-full min-h-full bg-white text-slate-900 flex flex-col">
        <WelcomeProgress currentStep={3} />
        <div className="flex-grow flex items-center justify-center">
          <div className="text-center">
            <div className="inline-block animate-spin rounded-full h-10 w-10 border-t-4 border-b-4 border-sky-500 mb-6"></div>
            <p className="font-bold text-xl text-slate-700">{t('正在配置最佳下载环境')}</p>
            <p className="text-sm text-slate-400 mt-2 animate-pulse">{t('正在检测地域并优化镜像源...')}</p>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full min-h-full bg-white text-slate-900 flex flex-col">
      <WelcomeProgress currentStep={3} />

      <div className="flex-grow overflow-auto">
        <div className="w-full max-w-5xl px-4 sm:px-6 lg:px-8 py-10 mx-auto">
          <section className="mx-auto max-w-3xl">
            <header className="text-center mb-10">
              <h1 className="text-3xl font-black tracking-tight text-slate-900 sm:text-4xl">
                {t('安装 AI 引擎')}
              </h1>
              <p className="mt-3 text-slate-500 text-lg">
                {t('本应用需要知名社区开源 AI 引擎 Ollama 处理分析任务')}
              </p>
            </header>

            {(installStatus === 'installing' || installStatus === 'ready') && (
              <Card className="rounded-3xl bg-white shadow-xl shadow-slate-200/50 border-slate-200/60 p-6 sm:p-10 mb-8 overflow-hidden relative">
                <CardContent className="p-0">
                  <div className="flex flex-col gap-8">
                    <div className="flex items-center gap-6">
                      <div className="relative">
                        <div className="w-12 h-12 rounded-2xl bg-sky-50 flex items-center justify-center">
                          <RefreshCw className="w-6 h-6 animate-spin text-sky-500" />
                        </div>
                      </div>
                      <div className="flex-grow flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                        <div>
                          <h2 className="font-black text-xl text-slate-900 tracking-tight">
                            {t('正在进行自动下载和安装')}
                          </h2>
                          <p className="text-sm text-slate-500 font-medium mt-1">
                            {t('如果自动流程缓慢，请参考下方的备选方案手动操作。')}
                          </p>
                        </div>
                        <Badge 
                          className={`self-start sm:self-center px-4 py-1.5 rounded-xl border-2 font-black text-xs uppercase tracking-wider transition-all duration-500 ${mirror === 'cn' ? 'bg-emerald-50 text-green-700 border-emerald-200' : 'bg-slate-50 text-slate-600 border-slate-200'}`}
                        >
                          {mirror === 'cn' ? (
                            <div className="flex items-center gap-2">
                              <Zap className="w-3.5 h-3.5 fill-current animate-pulse" />
                              {t('国内镜像源 (极速)')}
                            </div>
                          ) : (
                            <div className="flex items-center gap-2">
                              <Globe className="w-3.5 h-3.5" />
                              {t('官方下载源')}
                            </div>
                          )}
                        </Badge>
                      </div>
                    </div>

                    {platform === 'linux' ? (
                      <div className="h-64 overflow-y-auto rounded-2xl bg-slate-900 p-6 text-[13px] font-mono text-slate-50 shadow-2xl ring-1 ring-white/10">
                        {installLogs.length === 0 && (
                          <div className="text-slate-500 italic animate-pulse">{t('等待脚本输出...')}</div>
                        )}
                        {installLogs.map((log, index) => (
                          <div key={index} className="break-words whitespace-pre-wrap py-1 border-b border-slate-800/30 last:border-0 opacity-90">
                            <span className="text-sky-400 mr-2">$</span> {log}
                          </div>
                        ))}
                        <div ref={logsEndRef} />
                      </div>
                    ) : (
                      <div className="space-y-6">
                        {downloadInfo ? (
                          <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
                            <div className="flex justify-between items-end mb-3">
                              <div className="flex items-baseline gap-2">
                                <span className="text-sky-600 font-black text-4xl tabular-nums tracking-tighter">
                                  {downloadInfo.percent}%
                                </span>
                                {mirror === 'cn' && (
                                  <span className="text-[10px] font-black text-emerald-600 bg-emerald-100 px-2 py-0.5 rounded-full uppercase tracking-widest animate-bounce">
                                    {t('Boosted')}
                                  </span>
                                )}
                              </div>
                              <span className="text-slate-400 font-black text-[10px] uppercase tracking-widest pb-1.5">
                                {mirror === 'cn' ? t('正在通过国内节点下载') : t('正在通过官方节点下载')}
                              </span>
                            </div>
                            <ProgressBar
                              value={downloadInfo.percent}
                              className="h-3 bg-slate-100 rounded-full overflow-hidden border-none"
                            />
                            <div className="grid grid-cols-3 gap-3 mt-6">
                              <div className="bg-slate-50/80 p-4 rounded-2xl border border-slate-100/80 flex flex-col gap-1">
                                <span className="text-[10px] text-slate-400 font-black uppercase tracking-wider">{t('速率')}</span>
                                <span className="font-black text-slate-700 text-sm tracking-tight">{formatSpeed(downloadInfo.speed)}</span>
                              </div>
                              <div className="bg-slate-50/80 p-4 rounded-2xl border border-slate-100/80 flex flex-col gap-1">
                                <span className="text-[10px] text-slate-400 font-black uppercase tracking-wider">{t('已完成')}</span>
                                <span className="font-black text-slate-700 text-sm tabular-nums tracking-tight">{downloadInfo.receivedMB} / {downloadInfo.totalMB} MB</span>
                              </div>
                              <div className="bg-slate-50/80 p-4 rounded-2xl border border-slate-100/80 flex flex-col gap-1">
                                <span className="text-[10px] text-slate-400 font-black uppercase tracking-wider">{t('估计剩余')}</span>
                                <span className="font-black text-sky-600 text-sm tabular-nums tracking-tight">{downloadInfo.eta}</span>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-col items-center justify-center py-16 text-slate-400 border-2 border-dashed border-slate-100 rounded-3xl bg-slate-50/30 group transition-all hover:bg-slate-50/50">
                            <Loader2 className="w-8 h-8 animate-spin text-sky-400 mb-4" />
                            <p className="font-black text-sm tracking-wide animate-pulse">
                              {progressMessage || t('正在初始化下载管道...')}
                            </p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            )}

            <Card className="rounded-3xl bg-slate-50/50 shadow-sm border-slate-200/50 p-6 sm:p-10 mb-8 overflow-hidden">
              <CardContent className="p-0">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-3">
                    <h3 className="text-xl font-black text-slate-900 tracking-tight">{t('手动下载与安装')}</h3>
                    <Badge variant="secondary" className="bg-sky-100 text-sky-700 text-[9px] font-black uppercase tracking-widest px-2 py-0.5 border-none">
                      {t('备选方案')}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1.5 opacity-60">
                    <div className={`w-2 h-2 rounded-full ${mirror === 'cn' ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                    <span className="text-[10px] font-black text-slate-500 uppercase tracking-wider">
                      {mirror === 'cn' ? t('Region: CN') : t('Region: Global')}
                    </span>
                  </div>
                </div>
                
                {platform !== 'linux' ? (
                  <div className="space-y-8">
                    <div className="space-y-4">
                      <p className="text-[15px] text-slate-600 leading-relaxed font-medium">
                        {t('如果自动下载失败，您可以直接获取安装包。')}
                      </p>
                      <div className="p-5 bg-amber-50/50 rounded-2xl border-2 border-amber-100/50 flex gap-4 items-start shadow-inner">
                        <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center shrink-0">
                          <Zap className="w-5 h-5 text-amber-600" />
                        </div>
                        <div>
                          <p className="text-sm font-black text-amber-900 mb-1">{t('极速下载建议')}</p>
                          <p className="text-[13px] text-amber-800/80 leading-snug font-medium">
                            {t('复制链接并使用')} <strong className="text-amber-950 underline decoration-amber-500/40 font-black">迅雷、IDM 或 Motrix</strong> {t('等专业工具，下载速度可提升至 10 倍以上！')}
                          </p>
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-col items-stretch gap-4 bg-white p-6 rounded-3xl border-2 border-slate-100 shadow-sm transition-all hover:border-sky-300/50 hover:shadow-lg group">
                      <div className="flex-grow">
                        <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-1.5 flex items-center gap-1.5">
                          <Cpu className="w-3 h-3" />
                          Ollama for {platformNames[platform]}
                        </p>
                        <div className="bg-slate-50 p-3 rounded-xl border border-slate-100 break-all font-mono text-xs text-slate-600 select-all mb-2">
                          {downloadLinks[platform]}
                        </div>
                        <p className="text-[13px] font-black text-slate-800">
                          {t('文件名: {name}', { name: downloadLinks[platform].split('/').pop() })}
                        </p>
                      </div>
                      <div className="flex justify-end">
                        <Button
                          variant="outline"
                          className="h-12 px-8 rounded-2xl text-xs font-black text-primary border-2 border-primary/20 hover:bg-primary/5 hover:border-primary transition-all active:scale-95 flex items-center gap-2"
                          onClick={() => {
                            copyToClipboard(downloadLinks[platform]);
                            captureEvent('Ollama链接复制', { platform, mirror });
                            toast.success(t('链接已复制到剪贴板'));
                          }}
                        >
                          <MaterialIcon icon="content_copy" className="w-4 h-4" />
                          {t('复制下载链接')}
                        </Button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <p className="text-sm font-medium text-slate-600 mb-6 leading-relaxed">
                      {t('系统正优先尝试自动安装。若失败，请复制下方指令在终端执行。')}
                    </p>
                    <div className="relative group">
                      <div className="rounded-2xl bg-slate-900 p-6 font-mono text-[13px] text-slate-300 overflow-x-auto shadow-2xl ring-1 ring-white/10">
                        <div className="text-[10px] text-slate-500 font-black mb-4 uppercase tracking-widest border-b border-white/5 pb-2">
                          {platformNames[platform]} Shell Script
                        </div>
                        <pre className="whitespace-pre-wrap text-sky-300"><span className="text-slate-500 mr-2">#</span>{commands[platform]}</pre>
                      </div>
                      <Button
                        variant="secondary"
                        className="absolute top-14 right-4 h-9 px-4 rounded-xl text-[11px] font-black bg-white/10 text-white hover:bg-white/20 transition-all"
                        onClick={() => copyToClipboard(commands[platform])}
                      >
                        {t('复制指令')}
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            {installStatus === 'success' && (
              <Card className="rounded-3xl bg-emerald-50 shadow-xl shadow-emerald-100/50 border-emerald-200/60 p-8 text-center animate-in fade-in zoom-in duration-500">
                <CardContent className="p-0">
                  <div className="w-16 h-16 rounded-3xl bg-emerald-500 flex items-center justify-center mx-auto mb-6 shadow-lg shadow-emerald-200">
                    <span className="text-white text-3xl font-bold">✓</span>
                  </div>
                  <h2 className="text-2xl font-black text-slate-900 mb-2 tracking-tight">{t('安装程序已就绪')}</h2>
                  <div className="space-y-4 mt-8 text-left bg-white/60 backdrop-blur p-6 rounded-2xl border-2 border-emerald-100">
                    <p className="text-xs font-black text-slate-400 uppercase tracking-widest flex items-center gap-2 mb-2">
                      <Info className="w-3.5 h-3.5 text-emerald-500" />
                      {t('后续步骤提示')}
                    </p>
                    <p className="text-[15px] text-slate-700 leading-relaxed font-semibold">
                      {t('系统已为您拉起安装程序。请在弹出的官方窗口中点击“Install”。')}
                      <span className="block mt-3 text-emerald-600 font-black">
                        {t('安装完成后，点击下方按钮关闭并手动重启应用即可。')}
                      </span>
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}

            {installStatus === 'error' && (
              <Card className="rounded-3xl bg-rose-50 shadow-sm border-rose-100 p-8 text-slate-900 animate-in shake-1 duration-500">
                <div className="flex items-center gap-5">
                  <div className="w-14 h-14 rounded-2xl bg-rose-500 flex items-center justify-center text-white text-2xl font-black shrink-0 shadow-lg shadow-rose-200">
                    !
                  </div>
                  <div>
                    <p className="font-black text-xl text-slate-900 tracking-tight">{t('自动安装遇到阻碍')}</p>
                    <p className="text-sm text-rose-600 font-bold mt-1 opacity-80">{errorMessage}</p>
                  </div>
                </div>
                <div className="flex gap-3 mt-8">
                  <Button
                    variant="outline"
                    className="h-11 px-6 rounded-2xl font-black text-xs border-2 border-rose-100 text-rose-700 hover:bg-rose-100 transition-all active:scale-95"
                    onClick={handleOpenWebsite}
                  >
                    {t('前往官网手动下载')}
                  </Button>
                  <Button
                    className="h-11 px-6 rounded-2xl font-black text-xs bg-rose-600 text-white hover:bg-rose-700 transition-all shadow-lg shadow-rose-200 active:scale-95"
                    onClick={handleInstall}
                  >
                    {t('尝试重新启动安装')}
                  </Button>
                </div>
              </Card>
            )}
          </section>
        </div>
      </div>

      <footer className="border-t border-slate-200 bg-white/80 backdrop-blur-md p-6">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div>
            {(installStatus === 'installing' || installStatus === 'ready') && (
              <Button
                variant="ghost"
                onClick={handleCancelAndBack}
                className="h-12 rounded-2xl px-6 text-sm font-black text-slate-500 hover:text-rose-600 hover:bg-rose-50 transition-all"
              >
                {t('取消安装并返回')}
              </Button>
            )}
            {installStatus === 'error' && (
              <Button
                variant="ghost"
                onClick={onBack}
                className="h-12 rounded-2xl px-8 text-sm font-black text-slate-500 hover:bg-slate-100 transition-all"
              >
                {t('返回')}
              </Button>
            )}
          </div>

          <div className="flex items-center gap-4">
            <Button
              variant="outline"
              onClick={handleOpenWebsite}
              className="hidden sm:flex h-12 rounded-2xl px-6 text-sm font-black border-2 border-slate-100 text-slate-600 hover:bg-slate-50 hover:border-slate-200 transition-all"
            >
              {t('Ollama 官方网站')}
            </Button>

            {installStatus === 'success' && (
              <Button
                onClick={exitApp}
                className="h-14 rounded-2xl bg-slate-900 px-10 text-md font-black text-white hover:bg-black transition-all shadow-xl shadow-slate-200 active:scale-95 hover:ring-8 hover:ring-slate-900/5"
              >
                {t('关闭并手动重启')}
              </Button>
            )}
          </div>
        </div>
      </footer>

      {/* 准备就绪弹窗提示 */}
      <AlertDialog open={showSuccessDialog} onOpenChange={setShowSuccessDialog}>
        <AlertDialogContent className="max-w-md rounded-[40px] p-0 overflow-hidden border-none shadow-[0_32px_80px_rgba(0,0,0,0.15)] bg-white">
          <div className="relative h-2 w-full bg-gradient-to-r from-sky-400 via-blue-500 to-indigo-500" />
          <div className="p-10">
            <AlertDialogHeader className="flex flex-col items-center text-center">
              <div className="w-24 h-24 rounded-[32px] bg-gradient-to-tr from-sky-50 to-blue-50 flex items-center justify-center mb-8 shadow-inner ring-8 ring-sky-50/30">
                <span className="text-5xl animate-bounce">🚀</span>
              </div>
              <AlertDialogTitle className="text-3xl font-black text-slate-900 mb-3 tracking-tighter">
                {t('安装就绪')}
              </AlertDialogTitle>
              <AlertDialogDescription className="text-[16px] text-slate-500 leading-relaxed font-medium px-4">
                {t(
                  '下载已顺利完成！请点击刚刚弹出的Ollama官方安装程序窗口完成安装。'
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="mt-10 space-y-4">
              <div className="bg-sky-50/50 rounded-3xl p-6 border-2 border-sky-100/50 transition-all hover:bg-sky-50">
                <div className="flex items-start gap-5">
                  <div className="w-10 h-10 rounded-2xl bg-sky-500 text-white flex items-center justify-center flex-shrink-0 font-black shadow-lg shadow-sky-200 text-lg">
                    !
                  </div>
                  <div>
                    <p className="font-black text-slate-900 mb-1 text-[17px] leading-tight">
                      {t('最后一步')}
                    </p>
                    <p className="text-sky-700 font-bold text-sm leading-relaxed">
                      {t(
                        '安装完成后，点击下方按钮关闭应用。请手动重新启动应用以进行下一步。'
                      )}
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <AlertDialogFooter className="mt-12">
              <AlertDialogAction
                onClick={exitApp}
                className="w-full h-16 rounded-[24px] bg-slate-900 hover:bg-black text-white font-black text-xl shadow-2xl shadow-slate-300 transition-all active:scale-95 hover:ring-8 hover:ring-slate-900/5"
              >
                {t('立即关闭应用')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
