import React, { useState, useMemo } from 'react'
import { MaterialIcon, cn } from '../../lib/utils'
import { t } from '@app/languages'
import { useTTSAudioStore, getCurrentTTSChunks } from '../../stores/tts-audio-store'

export interface GlobalTTSPlaybackBarProps {
  className?: string
}

/**
 * DirectoryHeader 全局 TTS 播放控制条胶囊组件
 * 紧邻用户头像 (UserAvatarMenu) 左侧
 * 
 * 仅在 status === 'playing' | 'paused' | 'loading' 时渲染
 * 支持播放/暂停切换、片段刻度拖动进度条、悬浮气泡预览与彻底关闭
 */
export const GlobalTTSPlaybackBar: React.FC<GlobalTTSPlaybackBarProps> = ({ className }) => {
  const {
    status,
    currentTitle,
    currentFilePath,
    currentRealName,
    currentSentenceIndex,
    totalSentences,
    pause,
    resume,
    stop,
    seekSentence
  } = useTTSAudioStore()

  // 片段刻度进度条交互状态（始终保持在组件最顶层，严格遵循 React Hooks 规则）
  const [isHoveringSlider, setIsHoveringSlider] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  // 标题区 hover 状态（自定义 tooltip 浮层，多行信息展示）
  const [isHoveringTitle, setIsHoveringTitle] = useState(false)

  const isVisible = status === 'playing' || status === 'paused' || status === 'loading'
  const isPlaying = status === 'playing'
  const isLoading = status === 'loading'
  const isPaused = status === 'paused'

  // Egress 呈现层派生展示文本（优先 smart_name，降级真实文件名，再降级默认文案）
  const displayTitle = currentTitle && currentTitle.trim() ? currentTitle.trim() : t('文本朗读')

  // 真实文件名：优先 currentRealName（DB 字段 name），降级从路径提取 basename
  const realFileName = currentRealName
    || (currentFilePath ? currentFilePath.replace(/^.*[\\/]/, '') : null)

  // 当前刻度预览索引（拖动优先于悬浮，悬浮优先于当前播放句）
  const previewIndex = isDragging && dragIndex !== null
    ? dragIndex
    : hoverIndex !== null
      ? hoverIndex
      : currentSentenceIndex

  // 实时分句数据源供 Tooltip 气泡预览分句文本（Hooks 必须在所有 early return 之前调用）
  const currentChunks = useMemo(() => {
    if (isVisible) {
      return getCurrentTTSChunks()
    }
    return []
  }, [isVisible, status, currentSentenceIndex])

  // 严格状态门禁：无活跃朗读或处于错误/空闲/导出时，不占任何空间
  if (!isVisible) {
    return null
  }

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
        'no-drag flex items-center gap-1.5 h-7 px-2.5 rounded-full bg-accent/60 hover:bg-accent border border-border/60 shadow-xs transition-all duration-200 select-none max-w-[340px] flex-shrink-0',
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

      {/* 文件名/标题展示区（hover 时显示多行完整信息自定义浮层） */}
      <div
        className="relative flex-shrink-0"
        onMouseEnter={() => setIsHoveringTitle(true)}
        onMouseLeave={() => setIsHoveringTitle(false)}
      >
        <span
          className="text-xs font-medium text-foreground truncate max-w-[70px] sm:max-w-[90px] lg:max-w-[110px] block cursor-default"
        >
          {displayTitle}
        </span>
        {isHoveringTitle && (
          <div className="absolute top-full left-0 mt-1.5 z-50 min-w-[200px] max-w-[320px] p-2.5 bg-popover border border-border text-popover-foreground text-xs rounded-md shadow-xl pointer-events-none backdrop-blur-xs animate-in fade-in zoom-in-95 duration-150">
            {/* 第一行：完整智能文件名 */}
            <div className="font-medium text-foreground break-all whitespace-normal leading-relaxed">{displayTitle}</div>
            {/* 第二行：真实文件名（与 displayTitle 不同时才显示） */}
            {realFileName && realFileName !== displayTitle && (
              <div className="text-muted-foreground mt-1 break-all whitespace-normal leading-relaxed">
                {t('文件名')}: {realFileName}
              </div>
            )}
            {/* 第三行：完整路径 */}
            {currentFilePath && (
              <div className="text-muted-foreground mt-0.5 break-all whitespace-normal text-[10px] leading-relaxed">
                {t('路径')}: {currentFilePath}
              </div>
            )}
          </div>
        )}
      </div>

      {/* 片段刻度进度条 (当分句数大于 1 时展示) */}
      {totalSentences > 1 && (
        <div
          data-testid="global-tts-progress-container"
          className="relative flex items-center px-1 group/slider flex-shrink-0"
          onMouseEnter={() => setIsHoveringSlider(true)}
          onMouseLeave={() => {
            if (!isDragging) {
              setIsHoveringSlider(false)
              setHoverIndex(null)
            }
          }}
        >
          <input
            type="range"
            data-testid="global-tts-progress-slider"
            min={0}
            max={totalSentences - 1}
            step={1}
            value={isDragging && dragIndex !== null ? dragIndex : currentSentenceIndex}
            onMouseDown={() => setIsDragging(true)}
            onTouchStart={() => setIsDragging(true)}
            onInput={(e) => {
              const val = Number((e.target as HTMLInputElement).value)
              setDragIndex(val)
              setHoverIndex(val)
            }}
            onChange={(e) => {
              const val = Number((e.target as HTMLInputElement).value)
              setDragIndex(val)
              setIsDragging(false)
              setIsHoveringSlider(false)
              seekSentence(val).catch(() => {})
            }}
            onMouseUp={() => {
              if (isDragging && dragIndex !== null) {
                setIsDragging(false)
                setIsHoveringSlider(false)
                seekSentence(dragIndex).catch(() => {})
              }
            }}
            onTouchEnd={() => {
              if (isDragging && dragIndex !== null) {
                setIsDragging(false)
                setIsHoveringSlider(false)
                seekSentence(dragIndex).catch(() => {})
              }
            }}
            title={t('拖动切换朗读片段')}
            className="w-16 sm:w-20 md:w-24 h-1.5 bg-muted/80 rounded-lg appearance-none cursor-pointer accent-primary focus:outline-none"
          />

          {/* 刻度悬浮/拖动预览 Tooltip 浮层 */}
          {(isHoveringSlider || isDragging) && (
            <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 z-50 min-w-[180px] max-w-[260px] p-2 bg-popover/95 border border-border text-popover-foreground text-xs rounded-md shadow-xl pointer-events-none backdrop-blur-xs animate-in fade-in zoom-in-95 duration-150">
              <div className="flex items-center justify-between font-medium text-[11px] text-primary pb-1 mb-1 border-b border-border/50">
                <span>{t('片段')} {previewIndex + 1} / {totalSentences}</span>
                <span className="text-[10px] text-muted-foreground font-normal">{t('拖动即播')}</span>
              </div>
              <div className="text-[11px] text-muted-foreground line-clamp-2 leading-relaxed break-all">
                {currentChunks[previewIndex] || t('正在准备分句...')}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 句子计数进度 (例如 1/4) */}
      {totalSentences > 0 && (
        <span
          data-testid="global-tts-sentence-count"
          className="text-[10px] font-mono text-muted-foreground whitespace-nowrap flex-shrink-0"
        >
          {currentSentenceIndex + 1}/{totalSentences}
        </span>
      )}

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
