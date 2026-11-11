/**
 * M5-TTS 极速语音合成设置页面 (M5TTSSettings)
 * apps/desktop/src/renderer/components/settings/m5-tts-settings.tsx
 *
 * 核心功能：
 * 1. 默认朗读倍率配置 (0.5x ~ 2.0x)
 * 2. 收藏音色管理（设为默认发音人、移除收藏、例句即时试听）
 * 3. 51+ 预置发音人音色库检索、分类与一键收藏
 * 4. 纯净设计：不包含声音克隆模块，专精极速省电与超轻量开箱即用
 */

import React, { useState, useMemo, useCallback, useEffect } from 'react'
import { Loader2, Volume2, Pause, Play, BookmarkPlus, Zap } from 'lucide-react'
import { Card } from '../ui/card'
import { Label } from '../ui/label'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { useSettingsStore } from '../../stores/settings-store'
import { useTTSAudioStore } from '../../stores/tts-audio-store'
import { cn } from '../../lib/utils'
import { t } from '@app/languages'
import {
  PRESET_VOICES,
  RECOMMENDED_VOICE_SIDS,
  getVoiceById,
  VoiceMeta,
  AUDITION_LANGUAGE_OPTIONS,
  DEFAULT_AUDITION_TEXT,
  DEFAULT_VOICE_ID,
  DEFAULT_FAVORITE_VOICE_IDS
} from '../../constants/tts-voices'

const SPEED_CHOICES = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]

export const M5TTSSettings: React.FC = () => {
  const config = useSettingsStore(s => s.config)
  const updateConfigValue = useSettingsStore(s => s.updateConfigValue)
  const ttsAudioStore = useTTSAudioStore()

  // 1. 读取配置
  const ttsSpeed = config.ttsSpeed ?? 1.0
  const defaultVoiceId = useMemo(() => {
    const raw = config.ttsDefaultVoiceSid
    if (raw !== undefined && raw !== null) {
      if (isNaN(Number(raw))) {
        return String(raw)
      }
      const matched = getVoiceById(Number(raw))
      if (matched?.id) return matched.id
    }
    return DEFAULT_VOICE_ID
  }, [config.ttsDefaultVoiceSid])

  const favoriteVoiceIds: string[] = useMemo(() => {
    if (Array.isArray(config.ttsFavoriteVoices) && config.ttsFavoriteVoices.length > 0) {
      const hasOldNumbers = config.ttsFavoriteVoices.some(v => !isNaN(Number(v)))
      if (hasOldNumbers) {
        return DEFAULT_FAVORITE_VOICE_IDS
      }
      return Array.from(new Set(config.ttsFavoriteVoices.map(String)))
    }
    return DEFAULT_FAVORITE_VOICE_IDS
  }, [config.ttsFavoriteVoices])

  // 2. 音色库数据源 (M5 动态拉取 51 款预置高保真音色)
  const allVoicesFromStore = useTTSAudioStore(s => s.allVoices)
  const allVoices = allVoicesFromStore && allVoicesFromStore.length > 0 ? allVoicesFromStore : []

  useEffect(() => {
    ttsAudioStore.refreshVoices()
  }, [ttsAudioStore])

  // 3. 本地搜索与过滤状态
  const [searchQuery, setSearchQuery] = useState('')
  const [groupFilter, setGroupFilter] = useState<string>('all')

  // 获取语言显示名称
  const getLanguageLabel = useCallback((lang?: string): string => {
    if (!lang) return t('中文')
    const match = AUDITION_LANGUAGE_OPTIONS.find(opt => opt.code === lang)
    if (match) return match.label
    if (lang === 'zh') return t('中文')
    if (lang === 'en') return t('英文')
    if (lang === 'ja') return t('日语')
    if (lang === 'ko') return t('韩语')
    if (lang === 'de') return t('德语')
    if (lang === 'fr') return t('法语')
    if (lang === 'es') return t('西班牙语')
    if (lang === 'ru') return t('俄语')
    if (lang === 'multi') return t('多语言')
    return lang.toUpperCase()
  }, [])

  // 试听语言与例句文本
  const [auditionLangCode, setAuditionLangCode] = useState<string>('zh')
  const [auditionText, setAuditionText] = useState<string>(DEFAULT_AUDITION_TEXT)
  const [auditionVoiceId, setAuditionVoiceId] = useState<string | null>(null)

  const handleAuditionLangChange = useCallback((code: string) => {
    setAuditionLangCode(code)
    const target = AUDITION_LANGUAGE_OPTIONS.find(opt => opt.code === code)
    if (target) {
      setAuditionText(target.defaultText)
    }
  }, [])

  // 收藏音色列表对象
  const favoriteVoices = useMemo(() => {
    const seen = new Set<string>()
    const result: VoiceMeta[] = []
    for (const id of favoriteVoiceIds) {
      const v = getVoiceById(id, allVoices)
      if (v && !seen.has(v.id)) {
        seen.add(v.id)
        result.push(v)
      }
    }
    return result
  }, [favoriteVoiceIds, allVoices])

  // 过滤后的全量音色列表
  const filteredVoices = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const list = allVoices.filter(v => {
      if (groupFilter === 'female' && v.gender !== 'female') return false
      if (groupFilter === 'male' && v.gender !== 'male') return false
      if (groupFilter === 'child' && v.gender !== 'child') return false
      if (
        groupFilter !== 'all' &&
        groupFilter !== 'female' &&
        groupFilter !== 'male' &&
        groupFilter !== 'child'
      ) {
        if (v.lang !== groupFilter) return false
      }

      if (!q) return true
      return (
        v.displayName.toLowerCase().includes(q) ||
        v.id.toLowerCase().includes(q) ||
        v.desc.toLowerCase().includes(q) ||
        (v.emotion && v.emotion.toLowerCase().includes(q))
      )
    })

    return [...list].sort((a, b) => {
      const aRec = a.recommended || RECOMMENDED_VOICE_SIDS.has(a.id) ? 1 : 0
      const bRec = b.recommended || RECOMMENDED_VOICE_SIDS.has(b.id) ? 1 : 0
      return bRec - aRec
    })
  }, [allVoices, searchQuery, groupFilter])

  // 切换默认语速
  const handleSelectSpeed = useCallback(
    async (speed: number) => {
      await updateConfigValue('TTS_SPEED', speed)
      ttsAudioStore.setSpeed(speed)
    },
    [updateConfigValue, ttsAudioStore]
  )

  // 设置默认音色
  const handleSetDefaultVoice = useCallback(
    async (voiceId: string) => {
      await updateConfigValue('TTS_DEFAULT_VOICE_SID', voiceId)
      ttsAudioStore.setVoiceId(voiceId)
    },
    [updateConfigValue, ttsAudioStore]
  )

  // 移除收藏音色
  const handleRemoveFavorite = useCallback(
    async (voiceId: string) => {
      if (voiceId === defaultVoiceId) return
      const nextFavorites = favoriteVoiceIds.filter(s => s !== voiceId)
      await updateConfigValue('TTS_FAVORITE_VOICES', nextFavorites)
    },
    [favoriteVoiceIds, defaultVoiceId, updateConfigValue]
  )

  // 加入收藏
  const handleAddFavorite = useCallback(
    async (voiceId: string) => {
      if (favoriteVoiceIds.includes(voiceId)) return
      const nextFavorites = [...favoriteVoiceIds, voiceId]
      await updateConfigValue('TTS_FAVORITE_VOICES', nextFavorites)
    },
    [favoriteVoiceIds, updateConfigValue]
  )

  // 试听播放/暂停/恢复切换
  const handleToggleAudition = useCallback(
    async (voice: VoiceMeta) => {
      const textToSpeak = auditionText.trim() || DEFAULT_AUDITION_TEXT
      const isTarget =
        auditionVoiceId === voice.id &&
        ttsAudioStore.playingTextId === `audition-${voice.id}` &&
        ttsAudioStore.playingText === textToSpeak

      if (isTarget) {
        if (ttsAudioStore.status === 'playing') {
          await ttsAudioStore.pause()
        } else if (ttsAudioStore.status === 'paused') {
          await ttsAudioStore.resume()
        } else if (ttsAudioStore.status === 'loading') {
          await ttsAudioStore.stop()
          setAuditionVoiceId(null)
        }
      } else {
        setAuditionVoiceId(voice.id)
        try {
          await ttsAudioStore.play(textToSpeak, {
            textId: `audition-${voice.id}`,
            voiceId: voice.id,
            displayName: voice.displayName,
            fieldName: 'audition',
            fileFingerprint: 'preview',
            sid: voice.sid,
            speed: ttsSpeed
          })
        } catch (err) {
          console.error('[M5TTSSettings] 试听失败:', err)
          setAuditionVoiceId(null)
        }
      }
    },
    [auditionVoiceId, auditionText, ttsAudioStore, ttsSpeed]
  )

  return (
    <div className="p-6 max-w-4xl space-y-6">
      {/* 顶部标题与轻量引擎特性横幅 */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-border/60 pb-4">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2">
            <Zap className="w-5 h-5 text-amber-500" />
            <span>{t('极速语音朗读 (M5-TTS)')}</span>
          </h2>
          <p className="text-xs text-muted-foreground mt-1">
            {t('【超轻量极速发音】首字毫秒级发音，内存仅需 ~350MB，普通轻薄本丝滑流畅。')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 px-2.5 py-1 rounded-full font-medium">
            {t('51 款精选好声音 · 开箱即用')}
          </span>
        </div>
      </div>

      {/* 1. 默认语速配置 */}
      <Card className="p-4 border border-border/80 bg-card space-y-3">
        <div className="space-y-0.5">
          <Label className="text-sm font-semibold">{t('默认朗读倍率')}</Label>
          <p className="text-xs text-muted-foreground">
            {t('全局默认播放速度，可在朗读时通过按钮组快捷档位随时调整。')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 pt-1">
          {SPEED_CHOICES.map(val => (
            <button
              key={val}
              type="button"
              onClick={() => handleSelectSpeed(val)}
              className={cn(
                'px-3 py-1.5 rounded-md border text-xs font-mono font-medium transition-colors cursor-pointer',
                ttsSpeed === val
                  ? 'bg-primary text-primary-foreground border-primary shadow-xs'
                  : 'border-border/60 hover:bg-muted text-foreground'
              )}
            >
              {val}x
            </button>
          ))}
        </div>
      </Card>

      {/* 2. 收藏音色管理卡片 */}
      <Card className="p-4 border border-border/80 bg-card space-y-3">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label className="text-sm font-semibold">{t('我的收藏音色')}</Label>
            <p className="text-xs text-muted-foreground">
              {t('朗读胶囊下拉菜单中仅呈现收藏音色。默认朗读音色必须从收藏中选定。')}
            </p>
          </div>
          <span className="text-xs text-muted-foreground font-mono">
            {favoriteVoices.length} {t('个音色')}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
          {favoriteVoices.map(voice => {
            const isDefault = voice.id === defaultVoiceId
            const isCurrentTarget =
              auditionVoiceId === voice.id && ttsAudioStore.playingTextId === `audition-${voice.id}`
            const isLoading = isCurrentTarget && ttsAudioStore.status === 'loading'
            const isPlaying = isCurrentTarget && ttsAudioStore.status === 'playing'
            const isPaused = isCurrentTarget && ttsAudioStore.status === 'paused'

            return (
              <div
                key={voice.id}
                className={cn(
                  'p-3 rounded-lg border flex flex-col justify-between transition-colors bg-background/60',
                  isDefault
                    ? 'border-primary/80 bg-primary/5 shadow-2xs'
                    : 'border-border/60 hover:border-border'
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-medium text-sm text-foreground truncate">
                        {voice.displayName}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.2 rounded-full border border-border/60 text-muted-foreground">
                        {getLanguageLabel(voice.lang)}
                      </span>
                      {voice.emotion && (
                        <span className="text-[10px] px-1.5 py-0.2 rounded-full font-medium bg-blue-500/15 text-blue-600 dark:text-blue-400 border border-blue-500/30">
                          {voice.emotion}
                        </span>
                      )}
                      {(voice.recommended || RECOMMENDED_VOICE_SIDS.has(voice.id)) && (
                        <span className="text-[10px] px-1.5 py-0.2 rounded-full font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30">
                          {t('推荐')}
                        </span>
                      )}
                      {isDefault && (
                        <span className="text-[10px] bg-primary text-primary-foreground px-1.5 py-0.2 rounded-full font-medium">
                          {t('默认')}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-1">{voice.desc}</p>
                  </div>

                  {/* 试听例句按钮 */}
                  <button
                    type="button"
                    onClick={() => handleToggleAudition(voice)}
                    title={
                      isLoading
                        ? t('正在生成音频...')
                        : isPlaying
                          ? t('暂停试听')
                          : isPaused
                            ? t('恢复播放')
                            : t('试听例句')
                    }
                    className={cn(
                      'w-7 h-7 flex items-center justify-center rounded-full border transition-colors cursor-pointer shrink-0',
                      isPlaying || isLoading
                        ? 'bg-primary text-primary-foreground border-primary'
                        : isPaused
                          ? 'bg-primary/20 text-primary border-primary/50'
                          : 'border-border/60 hover:bg-muted text-muted-foreground'
                    )}
                  >
                    {isLoading ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : isPlaying ? (
                      <Pause className="w-3.5 h-3.5 fill-current" />
                    ) : isPaused ? (
                      <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
                    ) : (
                      <Volume2 className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>

                <div className="flex items-center justify-between pt-3 border-t border-border/40 mt-3 text-xs">
                  {!isDefault ? (
                    <button
                      type="button"
                      onClick={() => handleSetDefaultVoice(voice.id)}
                      className="text-primary hover:underline font-medium cursor-pointer"
                    >
                      {t('设为默认音色')}
                    </button>
                  ) : (
                    <span className="text-muted-foreground text-[11px]">
                      {t('当前默认朗读音色')}
                    </span>
                  )}

                  {!isDefault && (
                    <button
                      type="button"
                      onClick={() => handleRemoveFavorite(voice.id)}
                      className="text-muted-foreground hover:text-destructive transition-colors cursor-pointer text-[11px]"
                    >
                      {t('移除收藏')}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </Card>

      {/* 3. 全量音色库检索与分类 */}
      <Card className="p-4 border border-border/80 bg-card space-y-3">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label className="text-sm font-semibold">{t('发音人音色库')}</Label>
            <p className="text-xs text-muted-foreground">
              {t('浏览 51 个精选音色，试听并将喜欢的音色加入快捷收藏。')}
            </p>
          </div>
          <span className="text-xs text-muted-foreground font-mono">
            {filteredVoices.length} / {allVoices.length} {t('个音色')}
          </span>
        </div>

        {/* 试听内容与多语言快捷切换 */}
        <div className="p-3 rounded-lg border border-border/60 bg-muted/20 space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs font-medium text-foreground">{t('试听例句内容')}</Label>
            <span className="text-[11px] text-muted-foreground">
              {t('所有发音人试听均以此为准')}
            </span>
          </div>

          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <Input
                value={auditionText}
                onChange={e => setAuditionText(e.target.value)}
                placeholder={DEFAULT_AUDITION_TEXT}
                className="text-xs pr-8 h-9"
              />
              {auditionText && (
                <button
                  type="button"
                  onClick={() => setAuditionText('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs"
                >
                  ×
                </button>
              )}
            </div>

            <div className="shrink-0">
              <Select value={auditionLangCode} onValueChange={handleAuditionLangChange}>
                <SelectTrigger className="w-full h-9 text-xs">
                  <SelectValue placeholder={t('选择语言')} />
                </SelectTrigger>
                <SelectContent>
                  {AUDITION_LANGUAGE_OPTIONS.map(opt => (
                    <SelectItem key={opt.code} value={opt.code} className="text-xs">
                      <div className="flex items-center justify-between w-full gap-2">
                        <span className="flex items-center gap-1.5">
                          <span>{opt.flag}</span>
                          <span>{opt.label}</span>
                        </span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* 搜索与多维分类栏 */}
        <div className="flex flex-col sm:flex-row gap-2 pt-1">
          <div className="relative flex-1">
            <Input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder={t('搜索发音人姓名、语言、特征风格或情感 (如: 朱美, 云希, 沉稳)...')}
              className="text-xs pr-8"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs"
              >
                ×
              </button>
            )}
          </div>

          <div className="flex gap-1 shrink-0 flex-wrap">
            <Button
              type="button"
              variant={groupFilter === 'all' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setGroupFilter('all')}
              className="text-xs h-9 px-2.5"
            >
              {t('全部')}
            </Button>
            <Button
              type="button"
              variant={groupFilter === 'female' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setGroupFilter('female')}
              className="text-xs h-9 px-2.5"
            >
              {t('女声')}
            </Button>
            <Button
              type="button"
              variant={groupFilter === 'male' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setGroupFilter('male')}
              className="text-xs h-9 px-2.5"
            >
              {t('男声')}
            </Button>
            <Button
              type="button"
              variant={groupFilter === 'child' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setGroupFilter('child')}
              className="text-xs h-9 px-2.5"
            >
              {t('童声')}
            </Button>
            <Button
              type="button"
              variant={groupFilter === 'zh' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setGroupFilter('zh')}
              className="text-xs h-9 px-2.5"
            >
              {t('中文')}
            </Button>
            <Button
              type="button"
              variant={groupFilter === 'en' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setGroupFilter('en')}
              className="text-xs h-9 px-2.5"
            >
              {t('英文')}
            </Button>
          </div>
        </div>

        {/* 音色卡片网格 */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
          {filteredVoices.map(voice => {
            const isFav = favoriteVoiceIds.includes(voice.id)
            const isDefault = voice.id === defaultVoiceId
            const isCurrentTarget =
              auditionVoiceId === voice.id && ttsAudioStore.playingTextId === `audition-${voice.id}`
            const isLoading = isCurrentTarget && ttsAudioStore.status === 'loading'
            const isPlaying = isCurrentTarget && ttsAudioStore.status === 'playing'
            const isPaused = isCurrentTarget && ttsAudioStore.status === 'paused'

            return (
              <div
                key={voice.id}
                className={cn(
                  'p-3 rounded-lg border flex flex-col justify-between transition-colors',
                  isDefault
                    ? 'border-primary/80 bg-primary/5'
                    : isFav
                      ? 'border-border bg-card shadow-2xs'
                      : 'border-border/60 hover:border-border bg-background/50'
                )}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-medium text-sm text-foreground truncate">
                        {voice.displayName}
                      </span>
                      <span className="text-[10px] px-1.5 py-0.2 rounded-full border border-border/60 text-muted-foreground">
                        {getLanguageLabel(voice.lang)}
                      </span>
                      {voice.emotion && (
                        <span className="text-[10px] px-1.5 py-0.2 rounded-full font-medium bg-blue-500/15 text-blue-600 dark:text-blue-400 border border-blue-500/30">
                          {voice.emotion}
                        </span>
                      )}
                      {(voice.recommended || RECOMMENDED_VOICE_SIDS.has(voice.id)) && (
                        <span className="text-[10px] px-1.5 py-0.2 rounded-full font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30">
                          {t('推荐')}
                        </span>
                      )}
                      {isDefault && (
                        <span className="text-[10px] bg-primary text-primary-foreground px-1.5 py-0.2 rounded-full font-medium">
                          {t('默认')}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{voice.desc}</p>
                  </div>

                  {/* 试听按钮 */}
                  <button
                    type="button"
                    onClick={() => handleToggleAudition(voice)}
                    title={
                      isLoading
                        ? t('正在生成音频...')
                        : isPlaying
                          ? t('暂停试听')
                          : isPaused
                            ? t('恢复播放')
                            : t('试听例句')
                    }
                    className={cn(
                      'w-7 h-7 flex items-center justify-center rounded-full border transition-colors cursor-pointer shrink-0',
                      isPlaying || isLoading
                        ? 'bg-primary text-primary-foreground border-primary'
                        : isPaused
                          ? 'bg-primary/20 text-primary border-primary/50'
                          : 'border-border/60 hover:bg-muted text-muted-foreground'
                    )}
                  >
                    {isLoading ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : isPlaying ? (
                      <Pause className="w-3.5 h-3.5 fill-current" />
                    ) : isPaused ? (
                      <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
                    ) : (
                      <Volume2 className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>

                <div className="flex items-center justify-between pt-3 border-t border-border/40 mt-3 text-xs">
                  {isFav ? (
                    <span className="text-muted-foreground text-[11px] flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 inline-block" />
                      {t('已收藏')}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleAddFavorite(voice.id)}
                      className="text-primary hover:underline font-medium cursor-pointer flex items-center gap-1"
                    >
                      <BookmarkPlus className="w-3.5 h-3.5" />
                      <span>{t('加入收藏')}</span>
                    </button>
                  )}

                  {!isDefault && isFav && (
                    <button
                      type="button"
                      onClick={() => handleSetDefaultVoice(voice.id)}
                      className="text-primary hover:underline font-medium cursor-pointer"
                    >
                      {t('设为默认')}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </Card>
    </div>
  )
}
