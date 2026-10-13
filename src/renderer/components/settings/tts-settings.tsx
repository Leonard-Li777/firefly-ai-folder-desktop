/**
 * TTS 语音合成设置页面
 * apps/desktop/src/renderer/components/settings/tts-settings.tsx
 *
 * 核心功能：
 * 1. TTS 语音功能总开关控制
 * 2. 默认朗读语速配置
 * 3. 收藏音色管理（设为默认发音人、移除收藏、例句即时试听）
 * 4. 全量 Kokoro 音色库检索与一键收藏
 */

import React, { useState, useMemo, useCallback } from 'react'
import { Loader2, Volume2, Pause, Play, BookmarkPlus } from 'lucide-react'
import { Card } from '../ui/card'
import { Label } from '../ui/label'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { useSettingsStore } from '../../stores/settings-store'
import { useTTSAudioStore } from '../../stores/tts-audio-store'
import { MaterialIcon, cn } from '../../lib/utils'
import { t } from '@app/languages'
import {
  ALL_KOKORO_VOICES,
  PRESET_VOICES,
  RECOMMENDED_VOICE_SIDS,
  getVoiceBySid,
  VoiceMeta,
  AUDITION_LANGUAGE_OPTIONS,
  DEFAULT_AUDITION_TEXT
} from '../../constants/tts-voices'

const SPEED_CHOICES = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]

export const TTSSettings: React.FC = () => {
  const config = useSettingsStore(s => s.config)
  const updateConfigValue = useSettingsStore(s => s.updateConfigValue)

  const ttsAudioStore = useTTSAudioStore()

  // 读取配置 (TTS 始终保持开启)
  const ttsSpeed = config.ttsSpeed ?? 1.0
  const defaultVoiceSid = config.ttsDefaultVoiceSid ?? 44
  const favoriteSids: number[] = Array.isArray(config.ttsFavoriteVoices) && config.ttsFavoriteVoices.length > 0
    ? config.ttsFavoriteVoices
    : [44, 58, 0, 2]

  // 本地搜索与过滤状态（5组：全部、中、英、女、男）
  const [searchQuery, setSearchQuery] = useState('')
  const [groupFilter, setGroupFilter] = useState<'all' | 'zh' | 'en' | 'female' | 'male'>('all')

  // 试听语言与自定义试听文本（默认：欢迎使用萤核智能文件夹）
  const [auditionLangCode, setAuditionLangCode] = useState<string>('zh-CN')
  const [auditionText, setAuditionText] = useState<string>(DEFAULT_AUDITION_TEXT)

  // 当前正在试听的 SID
  const [auditionSid, setAuditionSid] = useState<number | null>(null)

  // 切换试听语言时，自动重置试听文本为该语言对应的翻译
  const handleAuditionLangChange = useCallback((code: string) => {
    setAuditionLangCode(code)
    const target = AUDITION_LANGUAGE_OPTIONS.find(opt => opt.code === code)
    if (target) {
      setAuditionText(target.defaultText)
    }
  }, [])

  // 收藏音色列表对象
  const favoriteVoices = useMemo(() => {
    return favoriteSids.map(sid => getVoiceBySid(sid))
  }, [favoriteSids])

  // 过滤后的全量音色列表（支持 5 组分类与关键词联合筛选，且推荐音色始终排在最前面）
  const filteredVoices = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const list = ALL_KOKORO_VOICES.filter(v => {
      // 5 组分类过滤
      if (groupFilter === 'zh' && v.lang !== 'zh') return false
      if (groupFilter === 'en' && v.lang !== 'en') return false
      if (groupFilter === 'female' && v.gender !== 'female') return false
      if (groupFilter === 'male' && v.gender !== 'male') return false

      // 关键词过滤
      if (!q) return true
      return (
        v.displayName.toLowerCase().includes(q) ||
        v.name.toLowerCase().includes(q) ||
        v.desc.toLowerCase().includes(q) ||
        String(v.sid) === q
      )
    })

    // 推荐音色排前面：属于推荐集合的排在前面，同组内保持原有相对顺序
    return [...list].sort((a, b) => {
      const aRec = RECOMMENDED_VOICE_SIDS.has(a.sid) ? 1 : 0
      const bRec = RECOMMENDED_VOICE_SIDS.has(b.sid) ? 1 : 0
      return bRec - aRec
    })
  }, [searchQuery, groupFilter])

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
    async (sid: number) => {
      await updateConfigValue('TTS_DEFAULT_VOICE_SID', sid)
      ttsAudioStore.setSid(sid)
    },
    [updateConfigValue, ttsAudioStore]
  )

  // 移除收藏音色
  const handleRemoveFavorite = useCallback(
    async (sid: number) => {
      if (sid === defaultVoiceSid) return
      const nextFavorites = favoriteSids.filter(s => s !== sid)
      await updateConfigValue('TTS_FAVORITE_VOICES', nextFavorites)
    },
    [favoriteSids, defaultVoiceSid, updateConfigValue]
  )

  // 加入收藏
  const handleAddFavorite = useCallback(
    async (sid: number) => {
      if (favoriteSids.includes(sid)) return
      const nextFavorites = [...favoriteSids, sid]
      await updateConfigValue('TTS_FAVORITE_VOICES', nextFavorites)
    },
    [favoriteSids, updateConfigValue]
  )

  // 试听播放/暂停/恢复切换（支持 loading、paused、playing 三态）
  const handleToggleAudition = useCallback(
    async (voice: VoiceMeta) => {
      const textToSpeak = auditionText.trim() || voice.sampleText
      const isTarget =
        auditionSid === voice.sid &&
        ttsAudioStore.playingTextId === `audition-${voice.sid}` &&
        ttsAudioStore.playingText === textToSpeak

      if (isTarget) {
        if (ttsAudioStore.status === 'playing') {
          await ttsAudioStore.pause()
        } else if (ttsAudioStore.status === 'paused') {
          await ttsAudioStore.resume()
        } else if (ttsAudioStore.status === 'loading') {
          await ttsAudioStore.stop()
          setAuditionSid(null)
        }
      } else {
        // 播放新音色或文本发生变化：以最新例句重新合成播放
        setAuditionSid(voice.sid)
        await ttsAudioStore.play(textToSpeak, {
          textId: `audition-${voice.sid}`,
          sid: voice.sid,
          speed: ttsSpeed
        })
      }
    },
    [auditionSid, auditionText, ttsSpeed, ttsAudioStore]
  )

  return (
    <div className="p-6 space-y-6">
      <div>
        <h3 className="text-lg font-semibold mb-2 text-foreground">{t('语音合成设置')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('配置基于端侧离线模型的语音合成朗读倍率、默认发音人与音色库')}
        </p>
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

          {/* 3. 收藏音色管理卡片 */}
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
                const isDefault = voice.sid === defaultVoiceSid
                const isCurrentTarget = auditionSid === voice.sid && ttsAudioStore.playingTextId === `audition-${voice.sid}`
                const isLoading = isCurrentTarget && ttsAudioStore.status === 'loading'
                const isPlaying = isCurrentTarget && ttsAudioStore.status === 'playing'
                const isPaused = isCurrentTarget && ttsAudioStore.status === 'paused'

                return (
                  <div
                    key={voice.sid}
                    className={cn(
                      'p-3 rounded-lg border flex flex-col justify-between transition-colors bg-background/60',
                      isDefault
                        ? 'border-primary/80 bg-primary/5 shadow-2xs'
                        : 'border-border/60 hover:border-border'
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium text-sm text-foreground truncate">
                            {voice.displayName}
                          </span>
                          <span className="text-[10px] px-1.5 py-0.2 rounded-full border border-border/60 text-muted-foreground">
                            {voice.lang === 'zh' ? t('中文普通话') : t('英语')}
                          </span>
                          {RECOMMENDED_VOICE_SIDS.has(voice.sid) && (
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
                        <p className="text-xs text-muted-foreground mt-1 line-clamp-1">
                          {voice.desc}
                        </p>
                      </div>

                      {/* 试听例句按钮：loading、暂停、播放三种状态 */}
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
                          onClick={() => handleSetDefaultVoice(voice.sid)}
                          className="text-primary hover:underline font-medium cursor-pointer"
                        >
                          {t('设为默认音色')}
                        </button>
                      ) : (
                        <span className="text-muted-foreground text-[11px]">{t('当前默认朗读音色')}</span>
                      )}

                      {!isDefault && (
                        <button
                          type="button"
                          onClick={() => handleRemoveFavorite(voice.sid)}
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

      {/* 3. 全量 103 音色库 */}
      <Card className="p-4 border border-border/80 bg-card space-y-3">
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label className="text-sm font-semibold">{t('全部发音人音色库')}</Label>
            <p className="text-xs text-muted-foreground">
              {t('Kokoro 内置多语言发音人列表。搜索并试听，将喜欢的音色加入收藏。')}
            </p>
          </div>
          <span className="text-xs text-muted-foreground font-mono">
            {filteredVoices.length} / {ALL_KOKORO_VOICES.length} {t('个音色')}
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
            {/* 试听例句输入框 */}
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

            {/* 10种语言下拉菜单（标注原生适配与待优化状态） */}
            <div className="w-full sm:w-64 shrink-0">
              <Select value={auditionLangCode} onValueChange={handleAuditionLangChange}>
                <SelectTrigger className="w-full h-9 text-xs">
                  <SelectValue placeholder={t('选择语言')} />
                </SelectTrigger>
                <SelectContent>
                  {AUDITION_LANGUAGE_OPTIONS.map(opt => (
                    <SelectItem key={opt.code} value={opt.code} className="text-xs">
                      <div className="flex items-center justify-between w-full gap-2">
                        <div className="flex items-center gap-1.5">
                          <span>{opt.flag}</span>
                          <span>{opt.name}</span>
                        </div>
                        {opt.status === 'native' ? (
                          <span className="text-[10px] px-1 py-0.2 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-medium">
                            {t('原生适配')}
                          </span>
                        ) : (
                          <span className="text-[10px] px-1 py-0.2 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 font-medium">
                            {t('待优化')}
                          </span>
                        )}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* 搜索与语种过滤栏 */}
        <div className="flex flex-col sm:flex-row gap-2 pt-1">
          <div className="relative flex-1">
            <Input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder={t('搜索发音人姓名、语言或风格 (如: 小贝, heart, 男声)...')}
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
              variant={groupFilter === 'zh' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setGroupFilter('zh')}
              className="text-xs h-9 px-2.5"
            >
              {t('中')}
            </Button>
            <Button
              type="button"
              variant={groupFilter === 'en' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setGroupFilter('en')}
              className="text-xs h-9 px-2.5"
            >
              {t('英')}
            </Button>
            <Button
              type="button"
              variant={groupFilter === 'male' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setGroupFilter('male')}
              className="text-xs h-9 px-2.5"
            >
              {t('男')}
            </Button>
            <Button
              type="button"
              variant={groupFilter === 'female' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setGroupFilter('female')}
              className="text-xs h-9 px-2.5"
            >
              {t('女')}
            </Button>
          </div>
        </div>

        {/* 音色检索列表（直接平铺展开，依托外层整体滚动条） */}
        <div className="divide-y divide-border/40 rounded-md border border-border/60 bg-background/50">
          {filteredVoices.map(voice => {
            const isFavorite = favoriteSids.includes(voice.sid)
            const isCurrentTarget = auditionSid === voice.sid && ttsAudioStore.playingTextId === `audition-${voice.sid}`
            const isLoading = isCurrentTarget && ttsAudioStore.status === 'loading'
            const isPlaying = isCurrentTarget && ttsAudioStore.status === 'playing'
            const isPaused = isCurrentTarget && ttsAudioStore.status === 'paused'

            return (
              <div
                key={voice.sid}
                className="p-3 flex items-center justify-between hover:bg-muted/40 transition-colors gap-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-xs text-foreground">
                      {voice.displayName}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      ({voice.name})
                    </span>
                    {RECOMMENDED_VOICE_SIDS.has(voice.sid) && (
                      <span className="text-[10px] px-1.5 py-0.2 rounded-full font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30">
                        {t('推荐')}
                      </span>
                    )}
                    <span className="text-[10px] px-1 py-0.2 rounded bg-muted text-muted-foreground">
                      {voice.lang === 'zh' ? t('普通话') : t('英语')}
                    </span>
                    <span className="text-[10px] px-1 py-0.2 rounded bg-muted text-muted-foreground">
                      {voice.gender === 'female' ? t('女声') : t('男声')}
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1">
                    {voice.desc}
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {/* 试听按钮：loading、暂停、播放三种状态（定宽保持紧凑一致，避免拉长变形） */}
                  <Button
                    type="button"
                    variant={isPlaying || isPaused || isLoading ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => handleToggleAudition(voice)}
                    className={cn(
                      'h-7 min-w-[68px] px-2 text-xs transition-colors justify-center',
                      isPaused && 'bg-primary/20 text-primary hover:bg-primary/30 border border-primary/40'
                    )}
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin shrink-0" />
                        <span>{t('合成中')}</span>
                      </>
                    ) : isPlaying ? (
                      <>
                        <Pause className="w-3.5 h-3.5 mr-1 fill-current shrink-0" />
                        <span>{t('暂停')}</span>
                      </>
                    ) : isPaused ? (
                      <>
                        <Play className="w-3.5 h-3.5 mr-1 fill-current shrink-0" />
                        <span>{t('继续')}</span>
                      </>
                    ) : (
                      <>
                        <Volume2 className="w-3.5 h-3.5 mr-1 shrink-0" />
                        <span>{t('试听')}</span>
                      </>
                    )}
                  </Button>

                  {/* 加入/已收藏按钮 */}
                  {isFavorite ? (
                    <span className="text-[11px] text-muted-foreground px-2 py-1 rounded bg-muted/60 border border-border/40">
                      {t('已在收藏')}
                    </span>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleAddFavorite(voice.sid)}
                      className="h-7 px-2 text-xs"
                    >
                      <BookmarkPlus className="w-3.5 h-3.5 mr-1 shrink-0" />
                      <span>{t('加入收藏')}</span>
                    </Button>
                  )}
                </div>
              </div>
            )
          })}

          {filteredVoices.length === 0 && (
            <div className="p-8 text-center text-xs text-muted-foreground">
              {t('未找到匹配的发音人音色')}
            </div>
          )}
        </div>
      </Card>
    </div>
  )
}
