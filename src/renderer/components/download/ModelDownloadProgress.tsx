import React from 'react'
import { useVoerkaI18n } from '@voerkai18n/react'
import { openExternalLink } from '@/renderer/lib/external-link'
import { Button } from '@components/ui/button'
import { Card } from '@components/ui/card'
import { DownloadProgressEvent } from '@firefly/types/types'
import i18nScope from '@src/languages'
import { useSettingsStore } from '@stores/settings-store'
import { formatFileSize, calculateRemainingTime } from '@firefly/shared'

interface ModelDownloadProgressProps {
  progress: DownloadProgressEvent | null
  isDownloading: boolean
  isPaused?: boolean
  status?: string
  error?: string
  onCancel: () => void
  onPause?: () => void
  onResume?: () => void
  onRetry?: () => void
  showManualDownloadInfo?: boolean
  manualDownloadInfo?: {
    files: Array<{ type?: string; url: string }>
    storagePath?: string
  }
  className?: string
}

/**
 * 通用模型下载进度组件
 * 支持断点续传、暂停/恢复、取消等功能
 */
export function ModelDownloadProgress({
  progress,
  isDownloading,
  isPaused = false,
  status,
  error,
  onCancel,
  onPause,
  onResume,
  onRetry,
  showManualDownloadInfo = false,
  manualDownloadInfo,
  className = ''
}: ModelDownloadProgressProps) {
  const { t } = useVoerkaI18n(i18nScope)
  // 读取镜像配置，仅在国内镜像加速时显示标签
  const downloadMirror = useSettingsStore(state => state.getConfigValue<string>('DOWNLOAD_MIRROR'))
  const isMirrorCN = downloadMirror === 'cn'
  const [smoothedTime, setSmoothedTime] = React.useState<string>('')
  const lastUpdateRef = React.useRef<number>(0)
  const lastSecondsRef = React.useRef<number>(0)

  // 格式化速度
  const formatSpeed = (bps: number): string => {
    return formatFileSize(bps) + '/s'
  }

  const getRemainingTimeText = (received: number, total: number, speed: number): string => {
    const result = calculateRemainingTime(received, total, speed)

    switch (result.kind) {
      case 'calculating':
        return t('计算中')
      case 'waiting':
        return t('请稍候...') // 接近结束显示“请稍候”
      case 'seconds':
        return `${result.value}${t('秒')}`
      case 'minutes':
        if (result.seconds !== undefined) {
          return `${result.value}${t('分钟')} ${result.seconds}${t('秒')}`
        }
        return `${result.value}${t('分钟')}`
      case 'hours':
        if (result.minutes !== undefined) {
          return `${result.value}${t('小时')} ${result.minutes}${t('分钟')}`
        }
        return `${result.value}${t('小时')}`
      default:
        return t('计算中')
    }
  }

  // 平滑逻辑：每 5 秒更新一次预估时间，除非数值发生巨大波动
  React.useEffect(() => {
    const received = progress?.receivedBytes || 0
    const total = progress?.totalBytes || 0
    const speed = progress?.speedBps || 0
    const fi = progress?.fileIndex
    const tf = progress?.totalFiles
    const now = Date.now()

    if (!isDownloading || isPaused || error) {
      setSmoothedTime('')
      lastUpdateRef.current = 0
      lastSecondsRef.current = 0
      return
    }

    // 多文件下载时，估算整体剩余时间
    let adjustedReceived = received
    let adjustedTotal = total
    if (typeof fi === 'number' && typeof tf === 'number' && tf > 1 && total > 0) {
      adjustedTotal = total * tf // 估算总体大小
      adjustedReceived = total * fi + received // 累积已下载
      if (adjustedReceived > adjustedTotal) adjustedReceived = adjustedTotal
    }

    const currentSeconds = speed > 0 ? (adjustedTotal - adjustedReceived) / speed : 0
    const timeSinceLastUpdate = now - lastUpdateRef.current
    const secondsDiff = Math.abs(currentSeconds - lastSecondsRef.current)

    // 更新条件：
    // 1. 之前没有记录过（第一次）
    // 2. 距离上次更新已过去 5000ms
    // 3. 或者剩余秒数变化超过了 50% (应对网络突变)
    // 4. 并且，秒数变化大于5秒 (防止在最后几秒频繁更新)
    // 5. 或者速率刚从 0 变为有效值（第一次计算出速率时立即显示）
    const isSignificantChange =
      lastSecondsRef.current > 0 && secondsDiff / lastSecondsRef.current > 0.5
    const hadNoSpeed = !lastSecondsRef.current && currentSeconds > 0

    if (
      lastUpdateRef.current === 0 ||
      timeSinceLastUpdate > 5000 ||
      (isSignificantChange && secondsDiff > 5) ||
      hadNoSpeed
    ) {
      const text = getRemainingTimeText(adjustedReceived, adjustedTotal, speed)
      setSmoothedTime(text)
      lastUpdateRef.current = now
      lastSecondsRef.current = currentSeconds
    }
  }, [
    progress?.receivedBytes,
    progress?.totalBytes,
    progress?.speedBps,
    progress?.fileIndex,
    progress?.totalFiles,
    isDownloading,
    isPaused,
    error
  ])

  // 获取状态显示文本
  const getStatusText = () => {
    if (error) return t('下载出错')
    if (status === 'retrying') return t('正在尝试恢复...')
    if (isPaused) return t('已暂停')
    if (isDownloading) return t('正在下载...')
    if (progress?.status === 'completed') return t('下载完成')
    return t('等待开始')
  }

  const currentPercent = progress?.percent || 0
  const receivedBytes = progress?.receivedBytes || 0
  const totalBytes = progress?.totalBytes || 0
  const speedBps = progress?.speedBps || 0
  const currentFileName = progress?.fileName
  const fileIndex = progress?.fileIndex
  const totalFiles = progress?.totalFiles

  return (
    <Card className={`bg-card text-card-foreground shadow-sm  p-2 ${className}`}>
      <div className="flex items-start ring-input justify-between gap-2">
        <div className="flex-1">
          {/* 文件名和状态 */}
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              {currentFileName && (
                <p className="text-sm text-foreground font-medium">{currentFileName}</p>
              )}
              {/* 文件进度指示：显示当前下载文件序号/总数，如 1/2 */}
              {typeof totalFiles === 'number' &&
                totalFiles > 1 &&
                typeof fileIndex === 'number' && (
                  <span className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                    {t('文件')} {Math.min(fileIndex + 1, totalFiles)}/{totalFiles}
                  </span>
                )}
              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-600">
                {isMirrorCN ? (
                  <>
                    <svg className="h-3 w-3 fill-current" viewBox="0 0 20 20">
                      <path
                        fillRule="evenodd"
                        d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10A1 1 0 018 18v-5H4a1 1 0 01-.82-1.573l7-10a1 1 0 011.12-.38z"
                        clipRule="evenodd"
                      />
                    </svg>
                    {t('镜像加速')}
                  </>
                ) : (
                  t('Hugginface官方源')
                )}
              </span>
            </div>
            <p className="text-sm text-foreground font-mono font-medium" aria-live="polite">
              {currentPercent.toFixed(1)}%
            </p>
          </div>

          {/* 进度条 */}
          <div
            className="h-2 rounded bg-muted mb-3"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={currentPercent}
            aria-labelledby="percent"
          >
            <div
              className={`h-2 rounded transition-all duration-300 ${
                error ? 'bg-destructive' : status === 'retrying' ? 'bg-orange-500' : 'bg-primary'
              }`}
              style={{ width: `${currentPercent}%` }}
            />
          </div>

          {/* 下载信息 */}
          <div className="grid grid-cols-1 sm:grid-cols-8 gap-2 text-xs text-muted-foreground mb-3">
            {totalBytes > 0 && (
              <div className="inline-flex col-span-4 items-center rounded-md border border-border bg-muted px-2.5 py-1 text-xs font-mono font-medium text-muted-foreground">
                {formatFileSize(receivedBytes)} / {formatFileSize(totalBytes)}
              </div>
            )}
            {speedBps > 0 && (
              <div className="inline-flex col-span-2 items-center rounded-md border border-border bg-muted px-2.5 py-1 text-xs font-mono font-medium text-muted-foreground">
                {formatSpeed(speedBps)}
              </div>
            )}
            {smoothedTime && smoothedTime !== t('计算中') && (
              <div className="inline-flex col-span-2 items-center rounded-md border border-border bg-muted px-2.5 py-1 text-xs font-mono font-medium text-muted-foreground">
                {smoothedTime}
              </div>
            )}
          </div>

          {/* 错误信息 */}
          {error && (
            <div className="mt-3 p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive-foreground text-sm">
              <div className="flex items-start gap-2">
                <svg
                  className="h-4 w-4 text-destructive mt-0.5 flex-shrink-0"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z"
                    clipRule="evenodd"
                  />
                </svg>
                <div>
                  <p className="font-medium">{t('下载出错')}</p>
                  <p className="mt-1 text-destructive/80">
                    {t('{error}，请稍后再试或选择其它模型下载', { error })}
                  </p>
                  {onRetry && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={onRetry}
                      className="mt-2 h-7 px-3 text-xs font-medium text-destructive hover:bg-destructive/20 border-destructive/40"
                    >
                      {t('重试')}
                    </Button>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* 手动下载提示 */}
          {showManualDownloadInfo && error && manualDownloadInfo && (
            <div className="mt-4 p-3 rounded-lg bg-accent/10 border border-accent/20 text-accent-foreground text-sm">
              <div className="flex items-start gap-2">
                <svg
                  className="h-4 w-4 text-accent-foreground mt-0.5 flex-shrink-0"
                  fill="currentColor"
                  viewBox="0 0 20 20"
                >
                  <path
                    fillRule="evenodd"
                    d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9.293 11.293a1 1 0 001.414 1.414L10 10.414l-1.707 1.707a1 1 0 00-1.414-1.414L8.586 9l-1.707-1.707a1 1 0 011.414-1.414L10 8.586l1.707-1.707a1 1 0 011.414 1.414L11.414 10l1.707 1.707a1 1 0 01-1.414 1.414L10 11.414z"
                    clipRule="evenodd"
                  />
                </svg>
                <div>
                  <p className="font-medium mb-2">{t('手动下载提示')}</p>
                  <p className="mb-2">{t('如果下载不成功，请手动下载以下文件到模型存储目录：')}</p>

                  {manualDownloadInfo.files?.map((file, index) => (
                    <p key={index} className="mb-1">
                      <strong>{file.type || t('下载地址')}:</strong>{' '}
                      <a
                        href={file.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={e => {
                          e.preventDefault()
                          openExternalLink(file.url)
                        }}
                        className="text-primary hover:underline break-all"
                      >
                        {file.url}
                      </a>
                    </p>
                  ))}

                  {manualDownloadInfo.storagePath && (
                    <p className="mt-2">
                      <strong>{t('模型存储目录')}:</strong>{' '}
                      <span className="font-mono bg-accent/20 px-1 py-0.5 rounded text-accent-foreground break-all">
                        {manualDownloadInfo.storagePath}
                      </span>
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 操作按钮 */}
        <div className="flex flex-col gap-2 shrink-0">
          {/* 暂停/恢复按钮 */}
          {isDownloading && onPause && (
            <Button
              variant="ghost"
              onClick={onPause}
              disabled={!isDownloading}
              className="h-10 rounded-lg px-4 text-sm font-semibold text-foreground hover:text-foreground/80 disabled:opacity-50"
            >
              {t('暂停')}
            </Button>
          )}

          {isPaused && onResume && (
            <Button
              variant="ghost"
              onClick={onResume}
              className="h-10 rounded-lg px-4 text-sm font-semibold text-primary hover:text-primary/80 disabled:opacity-50"
            >
              {t('继续')}
            </Button>
          )}

          {/* 取消按钮 */}
          {(isDownloading || isPaused || error) && onCancel && (
            <Button
              variant="ghost"
              onClick={onCancel}
              className="h-10 rounded-lg px-4 text-sm font-semibold text-destructive hover:text-destructive/80 disabled:opacity-50"
            >
              {t('取消')}
            </Button>
          )}
          {/* 状态信息 */}
          <div className="flex items-center gap-2 text-xs">
            <div
              className={`inline-flex items-center rounded-md px-2.5 py-1 text-xs font-medium ${
                error
                  ? 'bg-destructive/10 text-destructive'
                  : status === 'retrying'
                    ? 'bg-orange-500/10 text-orange-500'
                    : isPaused
                      ? 'bg-primary/10 text-primary'
                      : 'bg-emerald-500/10 text-emerald-500'
              }`}
            >
              {getStatusText()}
            </div>
          </div>
        </div>
      </div>
    </Card>
  )
}
