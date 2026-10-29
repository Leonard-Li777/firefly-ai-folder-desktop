/**
 * 4段式紧凑 TTS 操作胶囊按钮组
 * apps/desktop/src/renderer/components/common/TTSActionGroup.tsx
 *
 * 按钮结构：
 * [ 播放/暂停 (含进度微标) | 收藏音色 ▾ | 语速 ▾ | 查看音频文件 ]
 */

import React, { useState, useRef, useEffect, useMemo } from 'react'
import { MaterialIcon, cn } from '../../lib/utils'
import { t } from '@app/languages'
import { useTTSAudioStore, getCurrentTTSChunks } from '../../stores/tts-audio-store'
import { useConfigStore } from '../../stores/config-store'
import { useSettingsStore } from '../../stores/settings-store'
import { SettingsCategory } from '@firefly/types'
import {
  getVoiceById,
  getVoiceBySid,
  PRESET_VOICES,
  type VoiceMeta,
  DEFAULT_VOICE_ID,
  DEFAULT_FAVORITE_VOICE_IDS
} from '../../constants/tts-voices'

export interface TTSActionGroupProps {
  /** 待朗读文本内容 */
  text: string
  /** 文本唯一标识符（用于互斥匹配与会话追踪） */
  textId: string
  /** 关联文件物理路径（用于工作区定位与默认磁盘缓存） */
  filePath?: string
  /** 关联文件内容指纹（用于跨工作区内容隔离） */
  fileFingerprint?: string
  /** 关联字段标识（如 summary, ocr, lrc, asr, multimodalContent 等） */
  fieldName?: string
  /** 导出时的默认文件名 */
  defaultFileName?: string
  /** 是否为 LRC 歌词格式（自动剥离时间戳） */
  isLrc?: boolean
  /** 容器额外样式类 */
  className?: string
  /** 是否使用微型紧凑模式 */
  compact?: boolean
}

const SPEED_OPTIONS = [0.75, 1.0, 1.25, 1.5, 2.0]

export const TTSActionGroup: React.FC<TTSActionGroupProps> = ({
  text,
  textId,
  filePath,
  fileFingerprint,
  fieldName,
  defaultFileName,
  isLrc = false,
  className,
  compact = false
}) => {
  // 从设置中心统一订阅配置，确保与设置面板收藏列表修改实时同步
  const config = useSettingsStore(s => s.config)
  const ttsEnabled = (config as any)?.ttsEnabled ?? true

  const {
    playingTextId,
    status,
    currentSentenceIndex,
    totalSentences,
    currentSid,
    currentVoiceId,
    speed,
    allVoices,
    refreshVoices,
    play,
    pause,
    resume,
    setSid,
    setVoiceId,
    setSpeed,
    locateAudio,
    exportAudio,
    seekSentence,
    bufferedDuration,
    targetBufferDuration
  } = useTTSAudioStore()

  // 挂载时拉取最新音色库（包含自定义克隆音色）
  useEffect(() => {
    refreshVoices().catch(() => {})
  }, [refreshVoices])

  // 下拉菜单显隐控制
  const [showVoiceMenu, setShowVoiceMenu] = useState(false)
  const [showSpeedMenu, setShowSpeedMenu] = useState(false)
  const [toastMessage, setToastMessage] = useState<string | null>(null)

  // 片段刻度进度条交互状态
  const [isHoveringSlider, setIsHoveringSlider] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)

  const voiceRef = useRef<HTMLDivElement>(null)
  const speedRef = useRef<HTMLDivElement>(null)

  // 点击外部自动收起下拉
  useEffect(() => {
    const handleOutsideClick = (e: MouseEvent) => {
      if (voiceRef.current && !voiceRef.current.contains(e.target as Node)) {
        setShowVoiceMenu(false)
      }
      if (speedRef.current && !speedRef.current.contains(e.target as Node)) {
        setShowSpeedMenu(false)
      }
    }
    document.addEventListener('mousedown', handleOutsideClick)
    return () => document.removeEventListener('mousedown', handleOutsideClick)
  }, [])

  // Toast 自动消退
  useEffect(() => {
    if (toastMessage) {
      const timer = setTimeout(() => setToastMessage(null), 3000)
      return () => clearTimeout(timer)
    }
  }, [toastMessage])

  // 当前按钮组是否正在播放当前文本
  const isThisActive = playingTextId === textId
  const isPlaying = isThisActive && status === 'playing'
  const isLoading = isThisActive && status === 'loading'
  const isPaused = isThisActive && status === 'paused'
  const isExporting = isThisActive && status === 'exporting'

  // 当前刻度预览索引（拖动优先于悬浮，悬浮优先于当前播放句）
  const previewIndex = isDragging && dragIndex !== null
    ? dragIndex
    : hoverIndex !== null
      ? hoverIndex
      : currentSentenceIndex

  // 实时分句数据源供 Tooltip 气泡预览分句文本
  const currentChunks = useMemo(() => {
    if (isThisActive) {
      return getCurrentTTSChunks()
    }
    return []
  }, [isThisActive, status, currentSentenceIndex])

  // 解析收藏音色列表（以用户配置的收藏音色为准，严格清洗历史纯数字旧配置并去重防御）
  const favoriteVoices = useMemo(() => {
    const fromConfig = (config as any)?.ttsFavoriteVoices
    let ids: string[] = DEFAULT_FAVORITE_VOICE_IDS
    if (Array.isArray(fromConfig) && fromConfig.length > 0) {
      const hasLegacyNumbers = fromConfig.some(
        (v: any) => typeof v === 'number' || (!isNaN(Number(v)) && !allVoices.some(p => p.id === String(v)))
      )
      if (!hasLegacyNumbers) {
        ids = fromConfig.map(String)
      }
    }
    const seen = new Set<string>()
    const result: VoiceMeta[] = []
    for (const id of ids) {
      const v = getVoiceById(id, allVoices)
      if (v && !seen.has(v.id)) {
        seen.add(v.id)
        result.push(v)
      }
    }
    return result.length > 0 ? result : [allVoices[0] || PRESET_VOICES[0]]
  }, [(config as any)?.ttsFavoriteVoices, allVoices])

  const activeVoice = useMemo(() => {
    return getVoiceById(currentVoiceId || DEFAULT_VOICE_ID, allVoices)
  }, [currentVoiceId, allVoices])

  // 若功能在设置中全局关闭，不渲染
  if (!ttsEnabled) {
    return null
  }

  // 播放/暂停主逻辑
  const handleTogglePlay = async (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!text || !text.trim()) return

    if (isPlaying) {
      await pause()
    } else if (isPaused) {
      await resume()
    } else {
      await play(text, {
        textId,
        filePath,
        fileFingerprint,
        fieldName,
        displayName: activeVoice.displayName,
        isLrc,
        voiceId: activeVoice.id,
        sid: activeVoice.sid,
        speed
      })
    }
  }

  // 在文件夹中定位音频文件
  const handleLocate = async (e: React.MouseEvent) => {
    e.stopPropagation()
    const success = await locateAudio({
      filePath,
      fileFingerprint,
      fieldName,
      displayName: activeVoice.displayName,
      voiceId: currentVoiceId,
      sid: currentSid,
      speed
    })
    if (success) {
      setToastMessage(t('已在文件夹中定位音频文件'))
    } else {
      setToastMessage(t('音频文件尚未生成，播放后将自动缓存'))
    }
  }

  // 直达设置页
  const handleOpenSettings = (e: React.MouseEvent) => {
    e.stopPropagation()
    setShowVoiceMenu(false)
    useSettingsStore.getState().openSettings(SettingsCategory.TTS)
  }

  return (
    <div className={cn('relative inline-flex items-center select-none', className)}>
      {/* 5段式操作胶囊 */}
      <div className="inline-flex items-center rounded-md border border-border/80 bg-background/90 shadow-2xs backdrop-blur-xs text-xs divide-x divide-border/60 hover:border-border transition-colors">
        {/* 1. 播放/暂停控制按钮 */}
        <button
          type="button"
          onClick={handleTogglePlay}
          disabled={!text || !text.trim() || isLoading}
          title={
            isLoading
              ? bufferedDuration >= 1.0
                ? t('正在缓冲语音，已就绪 {current}s / {target}s...', {
                    current: Math.min(Math.round(bufferedDuration), Math.round(targetBufferDuration)),
                    target: Math.round(targetBufferDuration)
                  })
                : t('正在准备语音，请稍候...')
              : isPlaying
                ? t('暂停朗读')
                : isPaused
                  ? t('继续朗读')
                  : t('语音朗读')
          }
          className={cn(
            'flex items-center gap-1 px-2 py-1 text-foreground hover:bg-muted/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer',
            isPlaying && 'text-primary font-medium'
          )}
        >
          {isLoading ? (
            <MaterialIcon icon="refresh" className="text-[14px] animate-spin text-primary" />
          ) : isPlaying ? (
            <MaterialIcon icon="pause" className="text-[14px] text-primary" />
          ) : (
            <MaterialIcon icon="play_arrow" className="text-[14px]" />
          )}

          {!compact && (
            <span className="text-[11px] whitespace-nowrap">
              {isLoading
                ? bufferedDuration >= 1.0
                  ? `${Math.min(Math.round(bufferedDuration), Math.round(targetBufferDuration))}s/${Math.round(targetBufferDuration)}s`
                  : t('准备中...')
                : (isPlaying || isPaused) && totalSentences > 0
                  ? `${currentSentenceIndex + 1}/${totalSentences}`
                  : isPlaying
                    ? t('播放中')
                    : isPaused
                      ? t('暂停')
                      : t('朗读')}
            </span>
          )}
        </button>

        {/* 1.5 片段刻度进度条 (当分句数大于1且处于播放/暂停时展示) */}
        {isThisActive && (isPlaying || isPaused) && totalSentences > 1 && (
          <div
            className="relative flex items-center px-2 py-1 group/slider"
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
              className="w-16 sm:w-24 md:w-32 h-1.5 bg-muted/80 rounded-lg appearance-none cursor-pointer accent-primary focus:outline-none"
            />

            {/* 刻度悬浮/拖动预览 Tooltip 浮层 */}
            {(isHoveringSlider || isDragging) && (
              <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 min-w-[200px] max-w-[280px] p-2.5 bg-popover/95 border border-border text-popover-foreground text-xs rounded-md shadow-xl pointer-events-none backdrop-blur-xs animate-in fade-in zoom-in-95 duration-150">
                <div className="flex items-center justify-between font-medium text-[11px] text-primary pb-1 mb-1.5 border-b border-border/50">
                  <span>{t('片段')} {previewIndex + 1} / {totalSentences}</span>
                  <span className="text-[10px] text-muted-foreground font-normal">{t('拖动即播')}</span>
                </div>
                <div className="text-[11px] text-muted-foreground line-clamp-3 leading-relaxed break-all">
                  {currentChunks[previewIndex] || t('正在准备分句...')}
                </div>
              </div>
            )}
          </div>
        )}

        {/* 2. 收藏音色下拉菜单 */}
        <div className="relative" ref={voiceRef}>
          <button
            type="button"
            onClick={e => {
              e.stopPropagation()
              const nextShow = !showVoiceMenu
              setShowVoiceMenu(nextShow)
              setShowSpeedMenu(false)
              if (nextShow) {
                refreshVoices().catch(() => {})
              }
            }}
            title={t('切换朗读发音人')}
            className="flex items-center gap-0.5 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors cursor-pointer"
          >
            <span className="truncate max-w-[64px]">{activeVoice.displayName}</span>
            <MaterialIcon icon="arrow_drop_down" className="text-[12px] opacity-70" />
          </button>

          {showVoiceMenu && (
            <div className="absolute left-0 top-full mt-1.5 z-50 min-w-[150px] rounded-md border border-border bg-popover p-1 shadow-md text-xs">
              <div className="px-2 py-1 text-[10px] text-muted-foreground font-medium border-b border-border/40">
                {t('收藏音色')}
              </div>
              <div className="py-1 max-h-48 overflow-y-auto">
                {favoriteVoices.map(voice => (
                  <button
                    key={voice.id}
                    type="button"
                    onClick={e => {
                      e.stopPropagation()
                      setVoiceId(voice.id)
                      setShowVoiceMenu(false)
                    }}
                    className={cn(
                      'w-full flex items-center justify-between px-2 py-1 text-left rounded-sm hover:bg-accent hover:text-accent-foreground cursor-pointer text-xs',
                      currentVoiceId === voice.id && 'font-medium text-primary bg-primary/10'
                    )}
                  >
                    <span className="truncate max-w-[96px]">{voice.displayName}</span>
                    <span className="text-[10px] text-muted-foreground ml-2 shrink-0">
                      {voice.isCustom ? t('自定义') : voice.lang === 'zh' ? '中文' : voice.lang === 'ja' ? '日文' : 'EN'}
                    </span>
                  </button>
                ))}
              </div>
              <div className="border-t border-border/40 pt-1 mt-1">
                <button
                  type="button"
                  onClick={handleOpenSettings}
                  className="w-full flex items-center gap-1 px-2 py-1 text-left rounded-sm hover:bg-accent text-[11px] text-muted-foreground hover:text-foreground cursor-pointer"
                >
                  <MaterialIcon icon="settings" className="text-[12px]" />
                  <span>{t('管理音色与设置...')}</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 3. 语速倍率下拉菜单 */}
        <div className="relative" ref={speedRef}>
          <button
            type="button"
            onClick={e => {
              e.stopPropagation()
              setShowSpeedMenu(!showSpeedMenu)
              setShowVoiceMenu(false)
            }}
            title={t('调节朗读语速')}
            className="flex items-center gap-0.5 px-1.5 py-1 text-[11px] font-mono text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors cursor-pointer"
          >
            <span>{speed.toFixed(2).replace(/\.?0+$/, '')}x</span>
            <MaterialIcon icon="arrow_drop_down" className="text-[12px] opacity-70" />
          </button>

          {showSpeedMenu && (
            <div className="absolute left-0 top-full mt-1.5 z-50 min-w-[70px] rounded-md border border-border bg-popover p-1 shadow-md text-xs">
              {SPEED_OPTIONS.map(val => (
                <button
                  key={val}
                  type="button"
                  onClick={e => {
                    e.stopPropagation()
                    setSpeed(val)
                    setShowSpeedMenu(false)
                  }}
                  className={cn(
                    'w-full px-2 py-1 text-center font-mono rounded-sm hover:bg-accent cursor-pointer',
                    speed === val && 'text-primary font-bold bg-primary/10'
                  )}
                >
                  {val}x
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 4. 在文件夹中定位音频文件 */}
        <button
          type="button"
          onClick={handleLocate}
          disabled={!text || !text.trim()}
          title={t('在文件夹中定位音频文件')}
          className="flex items-center justify-center p-1 text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors disabled:opacity-40 cursor-pointer"
        >
          <MaterialIcon icon="folder_open" className="text-[14px]" />
        </button>
      </div>

      {/* 轻量 Toast 浮层 */}
      {toastMessage && (
        <div className="absolute right-0 top-full mt-2 z-50 px-3 py-1.5 bg-foreground text-background text-xs rounded-md shadow-lg whitespace-nowrap animate-in fade-in slide-in-from-top-1 duration-200">
          {toastMessage}
        </div>
      )}
    </div>
  )
}
