import React from 'react'

import { MaterialIcon, cn } from '../../lib/utils'
import { formatVideoTimestamp, computeHighlightPercent } from '../../lib/video-preview-utils'
import { t } from '@app/languages'

interface StreamVideoControlsProps {
  currentSec: number
  durationSec: number | null
  playing: boolean
  muted: boolean
  volume: number
  highlightRange?: [number, number]
  onTogglePlay: () => void
  onSeek: (targetSec: number) => void
  onToggleMute: () => void
  onVolumeChange: (volume: number) => void
  onOpenExternal: () => void
}

/** 兼容模式下的受控播放条：只展示大白话文案，不暴露任何编码/封装术语 */
export const StreamVideoControls: React.FC<StreamVideoControlsProps> = ({
  currentSec,
  durationSec,
  playing,
  muted,
  volume,
  highlightRange,
  onTogglePlay,
  onSeek,
  onToggleMute,
  onVolumeChange,
  onOpenExternal
}) => {
  const canSeek = typeof durationSec === 'number' && durationSec > 0
  const total = canSeek ? (durationSec as number) : 0
  const percent = canSeek ? Math.min(100, Math.max(0, (currentSec / total) * 100)) : 0
  const highlightStyle = (() => {
    if (!canSeek || !highlightRange) return null
    const { left, width } = computeHighlightPercent(highlightRange[0], highlightRange[1], total)
    return { left: `${left}%`, width: `${width}%` }
  })()

  return (
    <div className="w-full max-w-2xl flex flex-col gap-1.5 px-1 py-2 bg-muted/50 rounded-lg border border-border/60">
      <div className="relative flex items-center h-4">
        {highlightStyle && (
          <div
            className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-1.5 bg-primary/25 rounded-full pointer-events-none"
            style={highlightStyle}
          />
        )}
        <input
          type="range"
          aria-label={t('播放进度')}
          min={0}
          max={canSeek ? total : 0}
          step={0.1}
          value={canSeek ? Math.min(currentSec, total) : 0}
          disabled={!canSeek}
          onChange={e => onSeek(Number(e.target.value))}
          className={cn(
            'relative z-10 w-full h-1.5 accent-primary cursor-pointer',
            !canSeek && 'cursor-not-allowed opacity-50'
          )}
        />
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <button
          type="button"
          aria-label={playing ? t('暂停') : t('播放')}
          onClick={onTogglePlay}
          className="p-1 rounded hover:text-primary"
        >
          <MaterialIcon icon={playing ? 'pause' : 'play_arrow'} className="text-base" />
        </button>
        <span className="font-mono tabular-nums">{formatVideoTimestamp(currentSec)}</span>
        <span>/</span>
        <span className="font-mono tabular-nums">
          {canSeek ? formatVideoTimestamp(total) : '--:--'}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          aria-label={muted ? t('取消静音') : t('静音')}
          onClick={onToggleMute}
          className="p-1 rounded hover:text-primary"
        >
          <MaterialIcon icon={muted ? 'volume_off' : 'volume_up'} className="text-base" />
        </button>
        <input
          type="range"
          aria-label={t('音量')}
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          onChange={e => onVolumeChange(Number(e.target.value))}
          className="w-16 h-1 accent-primary"
        />
        <button
          type="button"
          onClick={onOpenExternal}
          className="p-1 rounded hover:text-primary"
          title={t('在外部播放器打开')}
        >
          <MaterialIcon icon="open_in_new" className="text-base" />
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground">{t('兼容模式播放中')}</p>
      <span className="sr-only">{percent.toFixed(1)}%</span>
    </div>
  )
}
