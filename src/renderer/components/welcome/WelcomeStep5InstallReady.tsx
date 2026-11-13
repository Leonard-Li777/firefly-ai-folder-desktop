import React, { useEffect, useRef, useState } from 'react'
import { useVoerkaI18n } from '@voerkai18n/react'
import i18nScope from '@src/languages'
import { WelcomeStepLayout } from './WelcomeStepLayout'
import { Card, CardContent } from '@components/ui/card'
import { Button } from '@components/ui/button'
import { ProgressBar } from '@components/ui/ProgressBar'
import {
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  ArrowLeft,
  Sparkles,
  HardDrive,
  PackageOpen,
  FolderOpen,
  Wifi
} from 'lucide-react'
import type { HardwareProbeResult, WelcomeSelection } from './welcome-types'
import { formatPluginErrorMessage, usePluginCenterStore } from '@stores/plugin-center-store'

/**
 * 安装页的两类展示态由 installMethod 决定：
 * - 在线：进入即 installing，展示下载进度条；
 * - 离线：进入即 select_package，先展示「选择离线安装包」按钮，
 *   用户点了才由主进程弹出文件选择框，选完才进入 importing 进度态。
 */
type InstallPhase =
  | 'select_package'
  | 'installing'
  | 'importing'
  | 'smoke_testing'
  | 'ready'
  | 'error'

interface WelcomeStep5InstallReadyProps {
  selection: WelcomeSelection
  hardware: HardwareProbeResult
  pluginDir: string | null
  /** 从 Step 4 返回再进来时恢复已就绪态，避免重复执行下载 / 导入 */
  initialReady?: boolean
  onReady?: () => void
  onBack: () => void
  onFinish: () => void
}

function getModularApi(): any {
  if (typeof window === 'undefined') return null
  const w = window as any
  return w.electronAPI?.modularResource ?? w.modularResource ?? null
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const val = (bytes / Math.pow(1024, i)).toFixed(1)
  return `${val} ${units[i]}`
}

/**
 * 欢迎向导 Step 5：安装与就绪
 *
 * 前 4 步只做选择，本页进入时才真正开始下载 / 导入。
 * 本页有两种 UI 展示态：在线直接进入下载进度界面；离线先给「选择离线安装包」
 * 按钮（不提前弹系统文件框），选中安装包后才切到导入进度界面。
 * 放行规则：主检索引擎安装 / 导入 + 冒烟自检通过就立刻解锁「开启智能文件管理之旅」，
 * 其余选配插件以 fire-and-forget 方式继续后台下载，不阻塞用户进入主界面。
 */
export function WelcomeStep5InstallReady({
  selection,
  hardware,
  pluginDir,
  initialReady = false,
  onReady,
  onBack,
  onFinish
}: WelcomeStep5InstallReadyProps) {
  const { t } = useVoerkaI18n(i18nScope)
  const storePluginDir = usePluginCenterStore(s => s.dirInfo?.currentPath || s.dirInfo?.currentDir)
  const effectivePluginDir = pluginDir || storePluginDir
  const { installMethod, selectedEngine, selectedOptionals, generativeEngineMode } = selection
  const optionalIds = Object.keys(selectedOptionals).filter(k => selectedOptionals[k])

  const isOffline = installMethod === 'offline'
  // 在线直接进入进度态；离线先停在「待选包」态，等用户点按钮才弹文件选择框
  const [phase, setPhase] = useState<InstallPhase>(
    initialReady ? 'ready' : isOffline ? 'select_package' : 'installing'
  )
  const [percentage, setPercentage] = useState(initialReady ? 100 : isOffline ? 0 : 5)
  const [downloadStats, setDownloadStats] = useState<{
    speedBytesPerSec: number
    downloadedBytes: number
    expectedBytes: number
    state?: string
  }>({
    speedBytesPerSec: 0,
    downloadedBytes: 0,
    expectedBytes: 0
  })
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  // 离线总包是一次性带齐全部插件，没有「后台继续下载」的概念
  const [backgroundCount, setBackgroundCount] = useState(
    initialReady && !isOffline ? optionalIds.length : 0
  )
  const [runToken, setRunToken] = useState(0)
  const [packageRequestToken, setPackageRequestToken] = useState(0)
  const startedRef = useRef(false)
  const lastNonZeroSpeedRef = useRef(0)

  const isBusy = phase === 'installing' || phase === 'importing' || phase === 'smoke_testing'

  // 监听主引擎下载进度（只认当前选中的引擎，避免选配插件进度污染主进度条）
  useEffect(() => {
    const modular = getModularApi()
    if (!modular?.onProgress) return
    const unsub = modular.onProgress((payload: any) => {
      if (payload?.moduleId === selectedEngine) {
        if (typeof payload.percentage === 'number') {
          setPercentage(prev => Math.max(prev, Math.min(95, Math.round(payload.percentage))))
        }
        const incomingSpeed =
          typeof payload.speedBytesPerSec === 'number' ? payload.speedBytesPerSec : 0
        if (incomingSpeed > 0) {
          lastNonZeroSpeedRef.current = incomingSpeed
        }
        setDownloadStats({
          speedBytesPerSec: incomingSpeed,
          downloadedBytes:
            typeof payload.downloadedBytes === 'number' ? payload.downloadedBytes : 0,
          expectedBytes: typeof payload.expectedBytes === 'number' ? payload.expectedBytes : 0,
          state: payload.state
        })
      } else if (
        payload?.moduleId &&
        (payload.state === 'completed' || payload.state === 'failed')
      ) {
        setBackgroundCount(prev => Math.max(0, prev - 1))
      }
    })
    return () => {
      unsub?.()
    }
  }, [selectedEngine])

  useEffect(() => {
    // React StrictMode / 从 Step 4 返回再进来时避免重复触发同一轮安装
    if (startedRef.current || initialReady) return
    // 离线态不能一进页面就调用 importOfflinePackage()——该调用会立刻弹出系统文件框。
    // 必须由用户点击「选择离线安装包」把 packageRequestToken 从 0 变成 >0 才启动。
    if (isOffline && packageRequestToken === 0) return
    startedRef.current = true

    const modular = getModularApi()
    const electron = typeof window !== 'undefined' ? (window as any).electronAPI : null

    const syncGenerativeMode = async () => {
      try {
        if (electron?.llmGateway?.setDesiredMode) {
          await electron.llmGateway.setDesiredMode(generativeEngineMode)
        }
      } catch (err) {
        console.warn('[Welcome] 同步智能起名与总结底座失败:', err)
      }
    }

    const isBaseEngineRecord = (rec: any) =>
      Boolean(
        rec &&
        (rec.capability_slot === 'base_embedding' ||
          rec.capability_slot === 'base_ai_engine' ||
          rec.id === 'engine_classic_light' ||
          rec.id === 'engine_gemma_unified')
      )

    const runOnline = async () => {
      setPhase('installing')
      setPercentage(5)
      // 1. 主检索引擎下载与解压
      if (modular?.install) {
        await modular.install(selectedEngine)
      }
      setPercentage(prev => Math.max(prev, 75))

      // 2. 显式参数探活冒烟自检
      setPhase('smoke_testing')
      const profile = selectedEngine.includes('classic') ? 'classic_light' : 'gemma_unified'
      if (modular?.smokeTest) {
        const smokeRes = await modular.smokeTest({ profile })
        if (!smokeRes?.success) {
          // 携带 errorCode，供 catch 里的 formatPluginErrorMessage 按码表转译大白话；
          // FAST_READY_TIMEOUT 等已知码走统一文案，未知则回退到 error 文本。
          const smokeErr: any = new Error(
            smokeRes?.error || t('引擎启动遇到问题，请尝试重试或切换为极速轻巧引擎')
          )
          if (smokeRes?.errorCode) smokeErr.code = smokeRes.errorCode
          throw smokeErr
        }
      }

      // 3. 激活主库 active 状态与 Epoch
      if (modular?.updateState) {
        await modular.updateState(selectedEngine, { active: true })
      }

      await syncGenerativeMode()

      // 4. 核心主引擎与自检通过，立刻放行解锁「开启智能文件管理之旅」，绝不阻塞用户进入
      setPercentage(100)
      setPhase('ready')
      onReady?.()

      // 5. 其余选配扩展插件在后台以非阻塞方式交由主进程任务队列接管（进入主界面不中断、不丢状态）
      const totalOptionals = optionalIds.length
      if (totalOptionals > 0) {
        setBackgroundCount(totalOptionals)
        if (typeof modular?.enqueueBackgroundInstalls === 'function') {
          modular.enqueueBackgroundInstalls(optionalIds).catch((err: any) => {
            console.warn('[OnlineInstall] 排队后台选配插件安装异常:', err)
          })
        } else {
          ;(async () => {
            for (const optId of optionalIds) {
              try {
                await modular?.install?.(optId)
              } catch (err: any) {
                console.warn(`[OnlineInstall] 选配插件后台安装异常: ${optId}`, err)
              } finally {
                setBackgroundCount(prev => Math.max(0, prev - 1))
              }
            }
          })()
        }
      } else {
        setBackgroundCount(0)
      }
    }

    const runOffline = async () => {
      setPhase('importing')
      setPercentage(40)

      if (modular?.abortAll) {
        await modular.abortAll()
      }
      if (!modular?.importOfflinePackage) {
        throw new Error(t('当前版本暂不支持导入离线总包'))
      }

      const imported = await modular.importOfflinePackage({
        preferredEngineId: selectedEngine
      })
      if (!imported) {
        // 用户在系统文件框里点了取消：不强判为失败，退回「待选包」态即可再点一次。
        // packageRequestToken 保持 >0 且依赖不变，effect 不会自动重跑、不会连弹文件框。
        startedRef.current = false
        setPhase('select_package')
        setPercentage(0)
        setErrorMessage(t('还没有挑选安装包，点下面的按钮再选一次就好'))
        return
      }

      let importedEngine = isBaseEngineRecord(imported) ? imported : null
      if (!importedEngine && modular?.list) {
        const installedList = await modular.list({ scope: 'installed' })
        if (Array.isArray(installedList)) {
          importedEngine =
            installedList.find(
              (m: any) =>
                isBaseEngineRecord(m) &&
                (m.install_state === 'active' || m.state === 'active' || m.id === selectedEngine)
            ) ||
            installedList.find(isBaseEngineRecord) ||
            null
        }
      }

      if (!importedEngine) {
        throw new Error(t('所选离线总包中未包含核心检索引擎，请确认文件为完整的 Firefly 离线总包'))
      }

      const activeEngineId =
        importedEngine.id === 'engine_classic_light'
          ? 'engine_classic_light'
          : 'engine_gemma_unified'

      const isAlreadyActive =
        importedEngine.install_state === 'active' || importedEngine.state === 'active'
      if (modular?.updateState && !isAlreadyActive) {
        await modular.updateState(activeEngineId, { active: true })
      }

      setPhase('smoke_testing')
      setPercentage(85)
      const profile = activeEngineId.includes('classic') ? 'classic_light' : 'gemma_unified'
      if (modular?.smokeTest) {
        const smokeRes = await modular.smokeTest({ profile })
        if (!smokeRes?.success) {
          throw new Error(smokeRes?.error || t('离线引擎自检未通过，请确认离线总包文件完整无损'))
        }
      }

      await syncGenerativeMode()
      setBackgroundCount(0)
      setPercentage(100)
      setPhase('ready')
      onReady?.()
    }

    const run = async () => {
      setErrorMessage(null)
      try {
        if (installMethod === 'offline') {
          await runOffline()
        } else {
          await runOnline()
        }
      } catch (err: any) {
        setPhase('error')
        // 统一走大白话翻译层：
        // - 技术串（fetch failed / /api/v1/engine/status）→ 转成用户能看懂的提示
        // - 带 code 的错误（如引擎就绪超时 FAST_READY_TIMEOUT）→ 按码表转译
        // - 已经是白话的错误（离线导入 / 自检）→ 原样放行
        // 传整个 err（而非 err.message），以保留 .code 供码表匹配；翻译层对 Error
        // 实例会兜底读 .message，不会因此丢文本。
        setErrorMessage(formatPluginErrorMessage(err) || t('安装遇到问题，请重试'))
      }
    }

    run()
    // runToken 用于在线「重试」，packageRequestToken 用于离线「选包」启动；
    // 其余依赖由 startedRef 保证只读取首次进入页面时的选择快照，故不纳入依赖数组。
  }, [runToken, packageRequestToken])

  /** 离线态：用户点按钮后才真正触发主进程的文件选择对话框 */
  const handleSelectPackage = () => {
    setErrorMessage(null)
    setPhase('importing')
    setPercentage(40)
    setPackageRequestToken(token => token + 1)
  }

  const handleRetry = () => {
    startedRef.current = false
    setErrorMessage(null)
    if (isOffline) {
      // 离线失败时退回选包态，让用户重新挑一个完整的安装包，不自动再弹文件框
      setPhase('select_package')
      setPercentage(0)
      return
    }
    setPercentage(5)
    setRunToken(token => token + 1)
  }

  const phaseTitle = (() => {
    if (phase === 'select_package') return t('等待挑选离线安装包')
    if (phase === 'installing') {
      if (downloadStats.state === 'extracting') {
        return t('安装包下载完成，正在安全解压...')
      }
      if (downloadStats.state === 'verifying') {
        return t('安装包下载完成，正在校验完整性...')
      }
      return t('正在装好主检索引擎，请稍候...')
    }
    if (phase === 'importing') return t('正在校验并导入离线安装包，请稍候...')
    if (phase === 'smoke_testing') return t('主检索引擎已下载完成，正在进行首次启动检验...')
    if (phase === 'ready') return t('主检索引擎安装完成，可以开始使用了！')
    return t('安装遇到问题')
  })()

  // 两种展示态共用一行摘要：让用户随时看清「怎么拿插件 / 装到哪」
  const summaryRow = (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        {isOffline ? (
          <PackageOpen className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <Wifi className="w-4 h-4 text-primary" />
        )}
        {isOffline ? t('导入离线安装包') : t('联网在线安装')}
      </span>
      <span className="inline-flex items-center gap-1.5">
        <HardDrive className="w-4 h-4 text-muted-foreground" />
        {t('安装到')}:{' '}
        <b className="font-mono font-semibold text-foreground break-all">
          {effectivePluginDir || t('默认文件夹')}
        </b>
      </span>
    </div>
  )

  return (
    <WelcomeStepLayout
      testId="welcome-step5-container"
      maxWidthClass="max-w-2xl"
      title={t('正在为你装好智能文件管理')}
      subtitle={
        isOffline
          ? t('把你准备好的安装包交给软件，剩下的事它会自动做完')
          : t('先装好最核心的搜索大脑，剩下的插件会在后台接着装，不用一直等')
      }
      footer={
        <>
          <Button
            data-testid="welcome-step5-back-btn"
            variant="ghost"
            size="sm"
            onClick={onBack}
            disabled={isBusy}
            className="text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="w-4 h-4 mr-1" />
            {t('返回')}
          </Button>
          <Button
            data-testid="welcome-enter-app-btn"
            onClick={onFinish}
            disabled={phase !== 'ready'}
            className={`${
              phase === 'ready'
                ? 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-lg'
                : 'bg-muted text-muted-foreground cursor-not-allowed'
            } font-medium px-5`}
          >
            {t('开启智能文件管理之旅')}
            <Sparkles className="w-4 h-4 ml-1.5" />
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {phase === 'select_package' && (
          /* 离线展示态：一进页面只给按钮，绝不提前弹系统文件框 */
          <Card
            data-testid="welcome-step5-select-package-card"
            className="p-5 rounded-xl bg-card border border-border shadow-sm"
          >
            <CardContent className="p-0 space-y-4">
              {summaryRow}

              <div className="flex items-start gap-3 p-4 rounded-lg bg-emerald-500/10 border border-emerald-500/30">
                <span className="w-10 h-10 shrink-0 rounded-lg bg-emerald-500/15 inline-flex items-center justify-center">
                  <PackageOpen className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
                </span>
                <div>
                  <div className="text-sm font-semibold text-foreground">
                    {t('请挑选离线安装包')}
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                    {t(
                      '选中你事先下载好的完整安装包，软件会自动把它装到上一步选好的文件夹里；全程不联网，也不会上传任何文件。'
                    )}
                  </p>
                </div>
              </div>

              {errorMessage && (
                <div
                  data-testid="welcome-step5-select-package-error"
                  className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-300 text-xs"
                >
                  {errorMessage}
                </div>
              )}

              <div className="flex flex-wrap items-center gap-3">
                <Button
                  data-testid="welcome-step5-select-package-btn"
                  onClick={handleSelectPackage}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white font-medium px-5"
                >
                  <FolderOpen className="w-4 h-4 mr-1.5" />
                  {t('选择离线安装包')}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {t('也可以返回上一步改成在线安装，让软件联网自动下载')}
                </span>
              </div>
            </CardContent>
          </Card>
        )}

        {phase !== 'select_package' && (
          <Card className="p-5 rounded-xl bg-card border border-border shadow-sm">
            <CardContent className="p-0 space-y-4">
              {/* 本轮安装的两个关键选择，让用户知道进度对应什么 */}
              {summaryRow}

              <div className="flex items-center justify-between text-xs">
                <div className="flex items-center gap-2 font-medium text-foreground">
                  {isBusy ? (
                    <RefreshCw className="w-4 h-4 text-primary animate-spin" />
                  ) : phase === 'ready' ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />
                  ) : (
                    <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400" />
                  )}
                  <span
                    className={
                      phase === 'ready'
                        ? 'text-emerald-700 dark:text-emerald-300 font-semibold'
                        : ''
                    }
                  >
                    {phaseTitle}
                  </span>
                </div>
                <span className="font-mono font-medium text-foreground">
                  {phase === 'ready'
                    ? '100%'
                    : phase === 'smoke_testing'
                      ? `${percentage}% (${t('自检中')})`
                      : `${percentage}%`}
                </span>
              </div>

              <ProgressBar
                value={phase === 'ready' ? 100 : percentage}
                max={100}
                colorClass="bg-primary"
              />

              {/* 在线下载过程中的速率与已下载/总大小指示器 */}
              {phase === 'installing' &&
                (() => {
                  const effectiveSpeed =
                    downloadStats.speedBytesPerSec > 0
                      ? downloadStats.speedBytesPerSec
                      : lastNonZeroSpeedRef.current
                  const hasDownloaded = downloadStats.downloadedBytes > 0

                  return (
                    <div
                      data-testid="welcome-step5-download-speed-bar"
                      className="flex items-center justify-between text-xs text-muted-foreground pt-0.5"
                    >
                      <span className="inline-flex items-center gap-1.5 font-mono">
                        {downloadStats.state === 'extracting' ? (
                          <span className="text-primary font-sans">
                            {t('正在校验并安全解压安装包...')}
                          </span>
                        ) : downloadStats.state === 'verifying' ? (
                          <span className="text-primary font-sans">
                            {t('正在校验文件完整性...')}
                          </span>
                        ) : effectiveSpeed > 0 ? (
                          <>
                            <span className="text-primary font-semibold">
                              ⚡ {formatBytes(effectiveSpeed)}/s
                            </span>
                            {downloadStats.expectedBytes > 0 && (
                              <span>
                                ({formatBytes(downloadStats.downloadedBytes)} /{' '}
                                {formatBytes(downloadStats.expectedBytes)})
                              </span>
                            )}
                          </>
                        ) : hasDownloaded ? (
                          <>
                            <span className="text-primary font-sans">{t('正在下载...')}</span>
                            {downloadStats.expectedBytes > 0 && (
                              <span>
                                ({formatBytes(downloadStats.downloadedBytes)} /{' '}
                                {formatBytes(downloadStats.expectedBytes)})
                              </span>
                            )}
                          </>
                        ) : (
                          <span>{t('正在连接高速下载节点...')}</span>
                        )}
                      </span>
                      {downloadStats.expectedBytes > 0 &&
                        downloadStats.state === 'downloading' &&
                        effectiveSpeed > 0 && (
                          <span className="text-muted-foreground">
                            {t('预计还需')}{' '}
                            {Math.max(
                              1,
                              Math.ceil(
                                (downloadStats.expectedBytes - downloadStats.downloadedBytes) /
                                  effectiveSpeed
                              )
                            )}{' '}
                            {t('秒')}
                          </span>
                        )}
                    </div>
                  )
                })()}

              {/* 首次启动自检阶段：明确提示下载已 100% 完成，打消用户误以为卡住的疑虑 */}
              {phase === 'smoke_testing' && (
                <div
                  data-testid="welcome-step5-smoke-testing-hint"
                  className="flex items-start gap-2.5 p-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-xs text-emerald-800 dark:text-emerald-300"
                >
                  <Sparkles className="w-4 h-4 shrink-0 mt-0.5 text-emerald-600 dark:text-emerald-400" />
                  <div className="space-y-0.5">
                    <div className="font-semibold text-foreground">
                      {t('核心组件已全部下载完成！')}
                    </div>
                    <p className="text-muted-foreground leading-relaxed">
                      {t('正在首次启动检索引擎并测试检索功能，通常需要 5~15 秒，请稍候...')}
                    </p>
                  </div>
                </div>
              )}

              {/* 主引擎完成即放行，其余插件继续后台下载 */}
              {phase === 'ready' && backgroundCount > 0 && (
                <div
                  data-testid="welcome-step5-background-hint"
                  className="flex items-start gap-2 p-3 rounded-lg bg-primary/10 border border-primary/30 text-primary text-xs"
                >
                  <Sparkles className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                  <span>{t('主检索引擎安装完成，其它插件继续后台下载，不影响你现在就开始用')}</span>
                </div>
              )}

              {phase === 'error' && (
                <div className="p-3 bg-red-500/10 text-red-700 dark:text-red-300 rounded-lg text-xs flex flex-col gap-2">
                  <div>{errorMessage}</div>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <Button
                      data-testid="welcome-step5-retry-btn"
                      size="sm"
                      variant="outline"
                      onClick={handleRetry}
                    >
                      <RefreshCw className="w-3.5 h-3.5 mr-1" />
                      {t('重试')}
                    </Button>
                    <span className="text-red-600 dark:text-red-400">
                      {t('也可以返回上一步，换一种安装方式再试')}
                    </span>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {hardware.storageFreeGB < 2.0 && (
          <div className="p-3 bg-red-500/10 border border-red-500/30 rounded-lg text-red-700 dark:text-red-300 text-xs">
            {t('磁盘剩余空间不足，请至少预留 2GB 空间以供下载与安装')}
          </div>
        )}
      </div>
    </WelcomeStepLayout>
  )
}
