import React, { useEffect, useState } from 'react'
import { Button } from '../ui/button'
import { MaterialIcon } from '../../lib/utils'
import { openExternalLink } from '../../lib/external-link'
import { getOfficialSiteDomain } from '../../lib/marketing-link'
import { t } from '@app/languages'

export interface UpdateStatePayload {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'installing' | 'error'
  currentVersion: string
  latestVersion: string | null
  minVersion: string | null
  isMandatory: boolean
  progress: {
    percent: number
    transferred: number
    total: number
    bytesPerSecond: number
  } | null
  error: string | null
  currentTrack: 'r2' | 'github'
  downloadedFilePath: string | null
  releaseNotes: string | null
  releaseDate: string | null
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

export const UpdateNotification: React.FC = () => {
  const [updateState, setUpdateState] = useState<UpdateStatePayload | null>(null)
  const [isDismissed, setIsDismissed] = useState(false)
  const [isRetrying, setIsRetrying] = useState(false)

  useEffect(() => {
    if (!window.electronAPI?.update) {
      return
    }

    // 初始化获取主进程当前更新状态
    window.electronAPI.update
      .getState()
      .then(state => {
        if (state) setUpdateState(state)
      })
      .catch(() => {})

    // 订阅主进程更新状态变更广播
    const unsubscribe = window.electronAPI.update.onStatusChanged(state => {
      setUpdateState(state)
      // 若出现新的重要状态，重置主动关闭标志
      if (state.status === 'downloaded' || state.isMandatory) {
        setIsDismissed(false)
      }
    })

    return () => {
      unsubscribe?.()
    }
  }, [])

  if (!updateState) {
    return null
  }

  const { status, isMandatory, latestVersion, progress, error, releaseNotes } = updateState

  // --------------------------------------------------------------------------
  // 1. 强制更新场景：全屏不可关闭阻断遮罩 (含逃生通道)
  // --------------------------------------------------------------------------
  if (isMandatory && status !== 'not-available') {
    const isDownloaded = status === 'downloaded'
    const isDownloading = status === 'downloading'
    const isInstalling = status === 'installing'
    const isError = status === 'error'

    return (
      <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-background/95 backdrop-blur-md p-6 select-none">
        <div className="w-full max-w-lg rounded-2xl border border-destructive/30 bg-card p-8 shadow-2xl space-y-6">
          <div className="flex items-center space-x-3 text-destructive">
            <MaterialIcon icon="warning" className="text-3xl text-destructive" />
            <h2 className="text-2xl font-bold tracking-tight">{t('重要版本更新提示')}</h2>
          </div>

          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              {t('检测到应用存在重大架构或协议演进，当前版本已无法继续提供基础服务，必须升级至 v{version} 即可恢复使用。', {
                version: latestVersion || '最新版本'
              })}
            </p>
            {releaseNotes && (
              <div className="mt-3 max-h-32 overflow-y-auto rounded-lg bg-muted/40 p-3 text-xs text-foreground/80 font-mono whitespace-pre-wrap">
                {releaseNotes}
              </div>
            )}
          </div>

          {/* 进度条展示 */}
          {isDownloading && progress && (
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>{t('正在差分增量下载...')}</span>
                <span>
                  {progress.percent}% ({formatBytes(progress.transferred)} / {formatBytes(progress.total)})
                </span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full bg-primary transition-all duration-300 ease-out"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
              <div className="text-right text-[11px] text-muted-foreground/70">
                {t('速度: {speed}/s', { speed: formatBytes(progress.bytesPerSecond) })}
              </div>
            </div>
          )}

          {/* 错误提示 */}
          {isError && (
            <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-xs text-destructive flex items-start space-x-2">
              <MaterialIcon icon="error" className="text-base shrink-0 mt-0.5" />
              <div className="flex-1">
                <p className="font-medium">{t('更新包下载遇到网络障碍')}</p>
                <p className="opacity-80 mt-0.5">{error || t('网络连接超时或不可达')}</p>
              </div>
            </div>
          )}

          {/* 交互按钮与逃生通道 */}
          <div className="flex flex-col sm:flex-row items-center gap-3 pt-2">
            {isDownloaded ? (
              <Button
                className="w-full sm:flex-1 bg-primary text-primary-foreground font-semibold"
                size="lg"
                disabled={isInstalling}
                onClick={() => {
                  window.electronAPI?.update?.quitAndInstall()
                }}
              >
                <MaterialIcon icon="restart_alt" className="mr-2" />
                {isInstalling ? t('正在准备覆盖安装...') : t('立即重启并生效')}
              </Button>
            ) : isError ? (
              <Button
                className="w-full sm:flex-1"
                variant="default"
                disabled={isRetrying}
                onClick={async () => {
                  setIsRetrying(true)
                  try {
                    await window.electronAPI?.update?.check(true)
                  } finally {
                    setIsRetrying(false)
                  }
                }}
              >
                <MaterialIcon icon="refresh" className="mr-2" />
                {isRetrying ? t('正在重新探测...') : t('重试连接')}
              </Button>
            ) : (
              <Button className="w-full sm:flex-1" disabled variant="secondary">
                <MaterialIcon icon="downloading" className="mr-2 animate-pulse" />
                {t('正在高速下载更新包...')}
              </Button>
            )}

            {/* 官网手动下载逃生通道 */}
            <Button
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => openExternalLink(getOfficialSiteDomain())}
            >
              <MaterialIcon icon="open_in_new" className="mr-2" />
              {t('官网手动下载')}
            </Button>

            {/* 退出应用 */}
            <Button
              variant="ghost"
              className="w-full sm:w-auto text-muted-foreground hover:text-destructive"
              onClick={async () => {
                try {
                  if (window.electronAPI?.update?.exitApp) {
                    await window.electronAPI.update.exitApp()
                  } else {
                    window.close()
                  }
                } catch {
                  window.close()
                }
              }}
            >
              <MaterialIcon icon="power_settings_new" className="mr-1" />
              {t('退出应用')}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  // --------------------------------------------------------------------------
  // 2. 常规更新场景：右下角轻量浮窗
  // --------------------------------------------------------------------------
  if (isDismissed) {
    return null
  }

  // 仅在下载中或已下载完成时向用户展示右下角浮窗
  if (status !== 'downloading' && status !== 'downloaded') {
    return null
  }

  return (
    <div className="fixed bottom-6 right-6 z-50 w-84 rounded-xl border border-border/80 bg-card/95 backdrop-blur-md p-4 shadow-xl transition-all duration-300 animate-in fade-in slide-in-from-bottom-4">
      <div className="flex items-start justify-between space-x-3">
        <div className="flex items-center space-x-2 text-primary font-semibold text-sm">
          <MaterialIcon
            icon={status === 'downloaded' ? 'system_update' : 'downloading'}
            className={status === 'downloading' ? 'animate-pulse' : ''}
          />
          <span>{status === 'downloaded' ? t('新版本已就绪') : t('正在后台下载新版本')}</span>
        </div>
        <button
          onClick={() => setIsDismissed(true)}
          className="text-muted-foreground hover:text-foreground text-sm p-1 rounded-md transition-colors"
          title={t('关闭')}
        >
          <MaterialIcon icon="close" className="text-base" />
        </button>
      </div>

      <div className="mt-2 text-xs text-muted-foreground">
        {status === 'downloaded' ? (
          <p>
            {t('萤核智能文件夹 v{version} 已下载完成，可立即重启更新或在下次启动时自动应用。', {
              version: latestVersion || ''
            })}
          </p>
        ) : (
          <p>
            {t('正在为您拉取最新版本 v{version} 增量差分更新包...', {
              version: latestVersion || ''
            })}
          </p>
        )}
      </div>

      {/* 下载进度条 */}
      {status === 'downloading' && progress && (
        <div className="mt-3 space-y-1">
          <div className="flex justify-between text-[11px] text-muted-foreground">
            <span>{progress.percent}%</span>
            <span>{formatBytes(progress.bytesPerSecond)}/s</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full bg-primary transition-all duration-200 ease-out"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
        </div>
      )}

      {/* 按钮操作 */}
      {status === 'downloaded' && (
        <div className="mt-4 flex items-center justify-end space-x-2">
          <Button
            size="sm"
            variant="outline"
            className="text-xs h-7 px-2.5"
            onClick={() => setIsDismissed(true)}
          >
            {t('下次启动生效')}
          </Button>
          <Button
            size="sm"
            variant="default"
            className="text-xs h-7 px-2.5"
            onClick={() => {
              window.electronAPI?.update?.quitAndInstall()
            }}
          >
            <MaterialIcon icon="restart_alt" className="mr-1 text-sm" />
            {t('立即重启更新')}
          </Button>
        </div>
      )}
    </div>
  )
}
