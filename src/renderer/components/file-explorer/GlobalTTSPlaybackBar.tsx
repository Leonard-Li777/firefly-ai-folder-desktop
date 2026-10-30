import React from 'react'
import { MaterialIcon, cn } from '../../lib/utils'
import { t } from '@app/languages'
import { useTTSAudioStore } from '../../stores/tts-audio-store'

export interface GlobalTTSPlaybackBarProps {
  className?: string
}

/**
 * DirectoryHeader 全局 TTS 播放控制条胶囊组件
 * 紧邻用户头像 (UserAvatarMenu) 左侧
 * 
 * 仅在 status === 'playing' | 'paused' | 'loading' 时渲染
 * 支持播放/暂停切换与彻底关闭
 */
export const GlobalTTSPlaybackBar: React.FC<GlobalTTSPlaybackBarProps> = ({ className }) => {
  const {
    status,
    currentTitle,
    pause,
    resume,
    stop
  } = useTTSAudioStore()

  // 严格状态门禁：无活跃朗读或处于错误/空闲/导出时，不占任何空间
  const isVisible = status === 'playing' || status === 'paused' || status === 'loading'
  if (!isVisible) {
    return null
  }

  const isPlaying = status === 'playing'
  const isLoading = status === 'loading'
  const isPaused = status === 'paused'

  // Egress 呈现层派生展示文本
  const displayTitle = currentTitle && currentTitle.trim() ? currentTitle.trim() : t('文本朗读')

  const handleTogglePlay = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (isPlaying) {
      await pause()
    } else {
      await resume()
    }
  }

  const handleStop = async (e: React.MouseEvent) => {
    e.stopPropagation()
    await stop()
  }

  return (
    <div
      data-testid="global-tts-playback-bar"
      data-no-drag
      className={cn(
        'no-drag flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-accent/60 hover:bg-accent border border-border/60 shadow-xs transition-all duration-200 select-none max-w-[220px] flex-shrink-0',
        className
      )}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {/* 状态图标 */}
      <div className="flex items-center justify-center text-primary flex-shrink-0" title={isPlaying ? t('正在朗读') : isPaused ? t('朗读已暂停') : t('正在加载语音')}>
        {isLoading ? (
          <MaterialIcon icon="refresh" className="text-[14px] animate-spin" />
        ) : (
          <MaterialIcon icon="volume_up" className="text-[14px]" />
        )}
      </div>

      {/* 文件名/标题展示区 */}
      <span
        className="text-xs font-medium text-foreground truncate max-w-[80px] lg:max-w-[130px]"
        title={displayTitle}
      >
        {displayTitle}
      </span>

      {/* 播放/暂停控制按钮 */}
      <button
        type="button"
        data-no-drag
        data-testid="global-tts-toggle-btn"
        onClick={handleTogglePlay}
        onKeyDown={e => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.stopPropagation()
          }
        }}
        className="no-drag w-5 h-5 flex items-center justify-center rounded-full hover:bg-muted text-foreground/80 hover:text-foreground transition-colors cursor-pointer flex-shrink-0"
        title={isPlaying ? t('暂停') : t('继续播放')}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <MaterialIcon
          icon={isPlaying ? 'pause' : 'play_arrow'}
          className="text-[15px]"
        />
      </button>

      {/* 关闭按钮 */}
      <button
        type="button"
        data-no-drag
        data-testid="global-tts-close-btn"
        onClick={handleStop}
        onKeyDown={e => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.stopPropagation()
          }
        }}
        className="no-drag w-4 h-4 flex items-center justify-center rounded-full hover:bg-muted text-muted-foreground hover:text-foreground transition-colors cursor-pointer flex-shrink-0"
        title={t('关闭朗读')}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      >
        <MaterialIcon icon="close" className="text-[12px]" />
      </button>
    </div>
  )
}
