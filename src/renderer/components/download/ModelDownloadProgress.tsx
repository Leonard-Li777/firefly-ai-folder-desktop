import React from 'react'
import { useVoerkaI18n } from '@voerkai18n/react'
import { Button } from '@components/ui/button'
import { Card } from '@components/ui/card'
import { DownloadProgressEvent } from '@yonuc/types/types'
import i18nScope from '@src/languages'

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
  const [smoothedTime, setSmoothedTime] = React.useState<string>('')
  const lastUpdateRef = React.useRef<number>(0)
  const lastSecondsRef = React.useRef<number>(0)

  // 格式化字节数
  const formatBytes = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes'
    const k = 1024
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`
  }

  // 格式化速度
  const formatSpeed = (bps: number): string => {
    return formatBytes(bps) + '/s'
  }

  const getRemainingTimeText = (received: number, total: number, speed: number): string => {
    if (!total || total <= 0) {
      return t('计算中')
    }

    if (received < 0 || received > total) {
      return t('请稍候...')
    }

    const percent = (received / total) * 100
    if (percent >= 99.5) return t('请稍候...') // 接近结束显示“请稍候”

    if (!speed || speed <= 0 || !isFinite(speed)) {
      return t('计算中')
    }

    const remaining = total - received
    const seconds = remaining / speed

    if (seconds < 2 || !isFinite(seconds) || seconds > 31536000) {
      return t('请稍候...')
    }

    const roundedSeconds = Math.max(1, Math.round(seconds))

    if (roundedSeconds < 60) {
      return `${roundedSeconds}${t('秒')}`
    }

    const minutes = Math.floor(roundedSeconds / 60)
    const remainingSeconds = Math.floor(roundedSeconds % 60)

    if (minutes < 60) {
      if (remainingSeconds > 0 && minutes < 5) { // 只有在5分钟以内才显示秒
        return `${minutes}${t('分钟')} ${remainingSeconds}${t('秒')}`
      }
      return `${minutes}${t('分钟')}`
    }

    const hours = Math.floor(minutes / 60)
    const remainingMinutes = Math.floor(minutes % 60)

    if (remainingMinutes > 0) {
      return `${hours}${t('小时')} ${remainingMinutes}${t('分钟')}`
    }

    return `${hours}${t('小时')}`
  }

  // 平滑逻辑：每 5 秒更新一次预估时间，除非数值发生巨大波动
  React.useEffect(() => {
    const received = progress?.receivedBytes || 0
    const total = progress?.totalBytes || 0
    const speed = progress?.speedBps || 0
    const now = Date.now()

    if (!isDownloading || isPaused || error) {
      setSmoothedTime('')
      lastUpdateRef.current = 0
      lastSecondsRef.current = 0
      return
    }

    const currentSeconds = speed > 0 ? (total - received) / speed : 0
    const timeSinceLastUpdate = now - lastUpdateRef.current
    const secondsDiff = Math.abs(currentSeconds - lastSecondsRef.current)

    // 更新条件：
    // 1. 之前没有记录过（第一次）
    // 2. 距离上次更新已过去 5000ms
    // 3. 或者剩余秒数变化超过了 50% (应对网络突变)
    // 4. 并且，秒数变化大于5秒 (防止在最后几秒频繁更新)
    const isSignificantChange = lastSecondsRef.current > 0 && secondsDiff / lastSecondsRef.current > 0.5

    if (lastUpdateRef.current === 0 || timeSinceLastUpdate > 5000 || (isSignificantChange && secondsDiff > 5)) {
      const text = getRemainingTimeText(received, total, speed)
      setSmoothedTime(text)
      lastUpdateRef.current = now
      lastSecondsRef.current = currentSeconds
    }
  }, [progress?.receivedBytes, progress?.totalBytes, progress?.speedBps, isDownloading, isPaused, error])

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

  return (
    <Card className={`rounded-xl bg-card text-card-foreground shadow-sm ring-1 ring-border p-2 ${className}`}>
      <div className="flex items-start ring-input justify-between gap-2">
        <div className="flex-1">
          {/* 文件名和状态 */}
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm text-foreground font-medium">
              {currentFileName || t('AI模型')}
            </p>
            <p className="text-sm text-foreground font-medium" aria-live="polite">
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
              className={`h-2 rounded transition-all duration-300 ${error ? 'bg-destructive' :
                  status === 'retrying' ? 'bg-orange-500' :
                    'bg-primary'
                }`}
              style={{ width: `${currentPercent}%` }}
            />
          </div>

          {/* 下载信息 */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs text-muted-foreground mb-3">
            {totalBytes > 0 && (
              <div className="inline-flex items-center rounded-md border border-border bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                {formatBytes(receivedBytes)} / {formatBytes(totalBytes)}
              </div>
            )}
            {speedBps > 0 && (
              <div className="inline-flex items-center rounded-md border border-border bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                {formatSpeed(speedBps)}
              </div>
            )}
            {(smoothedTime && smoothedTime !== t('计算中')) && (
              <div className="inline-flex items-center rounded-md border border-border bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
                {smoothedTime}
              </div>
            )}
          </div>



          {/* 错误信息 */}
          {error && (
            <div className="mt-3 p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive-foreground text-sm">
              <div className="flex items-start gap-2">
                <svg className="h-4 w-4 text-destructive mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                </svg>
                <div>
                  <p className="font-medium">{t('下载出错')}</p>
                  <p className="mt-1 text-destructive/80">{error}</p>
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
                <svg className="h-4 w-4 text-accent-foreground mt-0.5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9.293 11.293a1 1 0 001.414 1.414L10 10.414l-1.707 1.707a1 1 0 00-1.414-1.414L8.586 9l-1.707-1.707a1 1 0 011.414-1.414L10 8.586l1.707-1.707a1 1 0 011.414 1.414L11.414 10l1.707 1.707a1 1 0 01-1.414 1.414L10 11.414z" clipRule="evenodd" />
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
            <div className={`inline-flex items-center rounded-md px-2.5 py-1 text-xs font-medium ${error ? 'bg-destructive/10 text-destructive' :
                status === 'retrying' ? 'bg-orange-500/10 text-orange-500' :
                  isPaused ? 'bg-primary/10 text-primary' :
                    'bg-emerald-500/10 text-emerald-500'
              }`}>
              {getStatusText()}
            </div>
          </div>
        </div>
      </div>
    </Card>
  )
}