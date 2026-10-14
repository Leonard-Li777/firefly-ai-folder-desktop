/**
 * TTS 语音合成设置页面
 * apps/desktop/src/renderer/components/settings/tts-settings.tsx
 *
 * 核心功能：
 * 1. 默认朗读倍率配置 (0.5x ~ 2.0x)
 * 2. 收藏音色管理（设为默认发音人、移除收藏、例句即时试听）
 * 3. 51+ 预置与自定义发音人音色库检索、分类与一键收藏
 * 4. 零样本音色克隆（SenseVoice 自动解析语言与情感、性别单选确认、自包含容器化保存与热注册）
 * 5. 自定义音色安全删除与回退机制
 */

import React, { useState, useMemo, useCallback, useEffect } from 'react'
import {
  Loader2,
  Volume2,
  Pause,
  Play,
  BookmarkPlus,
  Plus,
  Trash2,
  UploadCloud,
  Sparkles,
  FileAudio,
  CheckCircle2
} from 'lucide-react'
import { Card } from '../ui/card'
import { Label } from '../ui/label'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '../ui/dialog'
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

export const TTSSettings: React.FC = () => {
  const config = useSettingsStore(s => s.config)
  const updateConfigValue = useSettingsStore(s => s.updateConfigValue)
  const ttsAudioStore = useTTSAudioStore()

  // 1. 读取配置（保持高容错并自动迁移历史旧数字配置）
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

  // 历史旧数字静默自愈清洗写回
  useEffect(() => {
    const rawFav = config.ttsFavoriteVoices
    if (Array.isArray(rawFav) && rawFav.some(v => !isNaN(Number(v)))) {
      updateConfigValue('TTS_FAVORITE_VOICES', DEFAULT_FAVORITE_VOICE_IDS).catch(() => {})
    }
    const rawDef = config.ttsDefaultVoiceSid
    if (rawDef !== undefined && rawDef !== null && !isNaN(Number(rawDef))) {
      const matched = getVoiceById(Number(rawDef))
      const safeId = matched?.id || DEFAULT_VOICE_ID
      updateConfigValue('TTS_DEFAULT_VOICE_SID', safeId).catch(() => {})
    }
  }, [config.ttsFavoriteVoices, config.ttsDefaultVoiceSid, updateConfigValue])

  // 2. 音色库数据源（结合预置音色与自定义音色）
  const [allVoices, setAllVoices] = useState<VoiceMeta[]>(PRESET_VOICES)

  // 刷新拉取音色库
  const refreshVoices = useCallback(async () => {
    try {
      if (window.electronAPI?.tts?.listVoices) {
        const list = await window.electronAPI.tts.listVoices()
        if (Array.isArray(list) && list.length > 0) {
          const mapped: VoiceMeta[] = list.map((item: any) => ({
            id: String(item.id),
            displayName: item.displayName || item.name || item.id,
            gender: item.gender === 'male' || item.gender === 'child' ? item.gender : 'female',
            lang: item.lang === 'en' || item.lang === 'ja' ? item.lang : 'zh',
            desc: item.desc || (item.isCustom ? t('用户自定义克隆音色') : ''),
            emotion: item.emotion,
            isCustom: Boolean(item.isCustom),
            recommended: Boolean(item.recommended)
          }))
          // 严格按 ID 去重，杜绝 React Key 重复冲突
          const seen = new Set<string>()
          const uniqueList: VoiceMeta[] = []
          for (const item of mapped) {
            if (!seen.has(item.id)) {
              seen.add(item.id)
              uniqueList.push(item)
            }
          }
          setAllVoices(uniqueList)
          return
        }
      }
    } catch (err) {
      console.warn('[TTSSettings] 加载自定义音色失败，回退预置音色库:', err)
    }
    setAllVoices(PRESET_VOICES)
  }, [])

  useEffect(() => {
    refreshVoices()
  }, [refreshVoices])

  // 3. 本地搜索与过滤状态（支持：全部、自定义、10 种语言、女、男、童声）
  const [searchQuery, setSearchQuery] = useState('')
  const [groupFilter, setGroupFilter] = useState<string>('all')

  // 获取语言显示名称（带国旗与地道名称）
  const getLanguageLabel = useCallback((lang?: string): string => {
    if (!lang) return t('中文')
    const matched = AUDITION_LANGUAGE_OPTIONS.find(
      opt => opt.langKey === lang || opt.code.toLowerCase().startsWith(lang.toLowerCase())
    )
    if (matched) return `${matched.flag} ${matched.label}`
    return lang
  }, [])

  // 试听语言与自定义试听文本
  const [auditionLangCode, setAuditionLangCode] = useState<string>('zh-CN')
  const [auditionText, setAuditionText] = useState<string>(DEFAULT_AUDITION_TEXT)

  // 当前正在试听的音色 ID
  const [auditionVoiceId, setAuditionVoiceId] = useState<string | null>(null)

  // 切换试听语言时，自动重置试听文本为该语言对应的翻译
  const handleAuditionLangChange = useCallback((code: string) => {
    setAuditionLangCode(code)
    const target = AUDITION_LANGUAGE_OPTIONS.find(opt => opt.code === code)
    if (target) {
      setAuditionText(target.defaultText)
    }
  }, [])

  // 收藏音色列表对象（严格去重防御，避免旧配置或重复项引发 React Key 冲突）
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

  // 过滤后的全量音色列表（支持 8 组分类与关键词联合筛选，且推荐音色和自定义音色置前）
  const filteredVoices = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    const list = allVoices.filter(v => {
      // 分类过滤
      if (groupFilter === 'custom' && !v.isCustom) return false
      if (groupFilter === 'female' && v.gender !== 'female') return false
      if (groupFilter === 'male' && v.gender !== 'male') return false
      if (groupFilter === 'child' && v.gender !== 'child') return false
      if (
        groupFilter !== 'all' &&
        groupFilter !== 'custom' &&
        groupFilter !== 'female' &&
        groupFilter !== 'male' &&
        groupFilter !== 'child'
      ) {
        if (v.lang !== groupFilter) return false
      }

      // 关键词过滤
      if (!q) return true
      return (
        v.displayName.toLowerCase().includes(q) ||
        v.id.toLowerCase().includes(q) ||
        v.desc.toLowerCase().includes(q) ||
        (v.emotion && v.emotion.toLowerCase().includes(q))
      )
    })

    // 排序：自定义音色排最前，其次推荐音色，其余保持相对顺序
    return [...list].sort((a, b) => {
      const aCustom = a.isCustom ? 2 : 0
      const bCustom = b.isCustom ? 2 : 0
      const aRec = a.recommended || RECOMMENDED_VOICE_SIDS.has(a.id) ? 1 : 0
      const bRec = b.recommended || RECOMMENDED_VOICE_SIDS.has(b.id) ? 1 : 0
      return (bCustom + bRec) - (aCustom + aRec)
    })
  }, [allVoices, searchQuery, groupFilter])

  // 4. 音色克隆模态框状态
  const [isCloneDialogOpen, setIsCloneDialogOpen] = useState(false)
  const [cloneFilePath, setCloneFilePath] = useState('')
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [analysisError, setAnalysisError] = useState<string | null>(null)
  const [tempVoiceId, setTempVoiceId] = useState<string | null>(null)
  const [cloneDisplayName, setCloneDisplayName] = useState('')
  const [cloneGender, setCloneGender] = useState<'female' | 'male' | 'child'>('female')
  const [cloneLang, setCloneLang] = useState<string>('zh')
  const [cloneEmotion, setCloneEmotion] = useState<string | null>(null)
  const [cloneDurationSec, setCloneDurationSec] = useState<number | null>(null)
  const [cloneDesc, setCloneDesc] = useState('')
  const [isSavingClone, setIsSavingClone] = useState(false)

  // 打开克隆模态框
  const handleOpenCloneDialog = useCallback(() => {
    setCloneFilePath('')
    setIsAnalyzing(false)
    setAnalysisError(null)
    setTempVoiceId(null)
    setCloneDisplayName('')
    setCloneGender('female')
    setCloneLang('zh')
    setCloneEmotion(null)
    setCloneDurationSec(null)
    setCloneDesc('')
    setIsSavingClone(false)
    setIsCloneDialogOpen(true)
  }, [])

  // 触发选择音频并自动分析
  const handleSelectAudioFile = useCallback(async () => {
    try {
      if (!window.electronAPI?.utils?.showOpenDialog) {
        setAnalysisError(t('当前环境不支持本地文件选择对话框'))
        return
      }

      const res = await window.electronAPI.utils.showOpenDialog({
        properties: ['openFile'],
        filters: [
          {
            name: t('音频文件'),
            extensions: ['wav', 'mp3', 'm4a', 'flac', 'ogg']
          }
        ]
      })

      if (!res || res.canceled || !res.filePaths || res.filePaths.length === 0) {
        return
      }

      const filePath = res.filePaths[0]
      setCloneFilePath(filePath)
      setIsAnalyzing(true)
      setAnalysisError(null)
      setTempVoiceId(null)

      // 调用后端 SenseVoice 自动分析提取特征、语言和情绪
      const analysisResult = await window.electronAPI.tts.analyzeVoiceFile(filePath)

      setTempVoiceId(analysisResult.tempVoiceId)
      setCloneDisplayName(analysisResult.suggestedName || '')
      setCloneLang(analysisResult.lang || 'zh')
      setCloneEmotion(analysisResult.emotion || null)
      setCloneDurationSec(analysisResult.durationSec || 0)
      setCloneDesc(
        analysisResult.emotion
          ? `${analysisResult.emotion} · ${t('克隆音色')}`
          : t('用户自定义克隆音色')
      )
    } catch (err: any) {
      console.error('[TTSSettings] 音频分析失败:', err)
      setAnalysisError(err?.message || t('音频分析失败，请检查音频格式是否有效'))
    } finally {
      setIsAnalyzing(false)
    }
  }, [])

  // 保存克隆音色并加入收藏
  const handleSaveCloneVoice = useCallback(async () => {
    if (!tempVoiceId) {
      setAnalysisError(t('尚未提取有效音频特征，请先选择有效音频文件'))
      return
    }
    if (!cloneDisplayName.trim()) {
      setAnalysisError(t('请输入音色显示名称'))
      return
    }

    try {
      setIsSavingClone(true)
      setAnalysisError(null)

      const result = await window.electronAPI.tts.saveCustomVoice({
        tempVoiceId,
        displayName: cloneDisplayName.trim(),
        gender: cloneGender,
        lang: cloneLang,
        desc: cloneDesc.trim() || t('用户自定义克隆音色')
      })

      if (!result.success || !result.voice) {
        throw new Error(result.error || t('保存自定义音色失败'))
      }

      const newVoiceId = String(result.voice.id)

      // 刷新音色列表
      await refreshVoices()

      // 自动加入收藏列表
      if (!favoriteVoiceIds.includes(newVoiceId)) {
        const nextFavorites = [...favoriteVoiceIds, newVoiceId]
        await updateConfigValue('TTS_FAVORITE_VOICES', nextFavorites)
      }

      setIsCloneDialogOpen(false)
    } catch (err: any) {
      console.error('[TTSSettings] 保存音色失败:', err)
      setAnalysisError(err?.message || t('保存音色失败，请重试'))
    } finally {
      setIsSavingClone(false)
    }
  }, [
    tempVoiceId,
    cloneDisplayName,
    cloneGender,
    cloneLang,
    cloneDesc,
    refreshVoices,
    favoriteVoiceIds,
    updateConfigValue
  ])

  // 删除自定义音色
  const handleDeleteCustomVoice = useCallback(
    async (voice: VoiceMeta) => {
      if (!voice.isCustom) return

      const confirmed = window.confirm(
        t('确定要删除自定义音色“{name}”吗？此操作无法撤销。', { name: voice.displayName })
      )
      if (!confirmed) return

      try {
        await window.electronAPI.tts.removeCustomVoice(voice.id)

        // 若被删除的音色刚好是默认音色，安全回退到默认音色
        if (voice.id === defaultVoiceId) {
          await updateConfigValue('TTS_DEFAULT_VOICE_SID', DEFAULT_VOICE_ID)
          ttsAudioStore.setVoiceId(DEFAULT_VOICE_ID)
        }

        // 若在收藏列表中，级联移除
        if (favoriteVoiceIds.includes(voice.id)) {
          const nextFavorites = favoriteVoiceIds.filter(id => id !== voice.id)
          await updateConfigValue('TTS_FAVORITE_VOICES', nextFavorites)
        }

        // 刷新列表
        await refreshVoices()
      } catch (err) {
        console.error('[TTSSettings] 删除自定义音色失败:', err)
      }
    },
    [defaultVoiceId, favoriteVoiceIds, updateConfigValue, ttsAudioStore, refreshVoices]
  )

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

  // 试听播放/暂停/恢复切换（支持 loading、paused、playing 三态）
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
        // 播放新音色或文本发生变化：以最新例句重新合成播放
        setAuditionVoiceId(voice.id)
        await ttsAudioStore.play(textToSpeak, {
          textId: `audition-${voice.id}`,
          voiceId: voice.id,
          sid: voice.sid,
          speed: ttsSpeed
        })
      }
    },
    [auditionVoiceId, auditionText, ttsSpeed, ttsAudioStore]
  )

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold mb-1 text-foreground">{t('离线语音合成 (TTS)')}</h3>
          <p className="text-sm text-muted-foreground">
            {t('基于 MOSS-TTS 48kHz 高保真离线模型，支持多语言发音与零样本声音克隆')}
          </p>
        </div>
        <Button
          type="button"
          onClick={handleOpenCloneDialog}
          className="gap-1.5 shadow-xs cursor-pointer"
        >
          <Sparkles className="w-4 h-4" />
          <span>{t('克隆新音色')}</span>
        </Button>
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
              auditionVoiceId === voice.id &&
              ttsAudioStore.playingTextId === `audition-${voice.id}`
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
                      {voice.isCustom ? (
                        <span className="text-[10px] px-1.5 py-0.2 rounded-full font-medium bg-purple-500/15 text-purple-600 dark:text-purple-400 border border-purple-500/30">
                          {t('自定义')}
                        </span>
                      ) : (
                        <span className="text-[10px] px-1.5 py-0.2 rounded-full border border-border/60 text-muted-foreground">
                          {getLanguageLabel(voice.lang)}
                        </span>
                      )}
                      {voice.emotion && (
                        <span className="text-[10px] px-1.5 py-0.2 rounded-full font-medium bg-blue-500/15 text-blue-600 dark:text-blue-400 border border-blue-500/30">
                          {voice.emotion}
                        </span>
                      )}
                      {(voice.recommended || RECOMMENDED_VOICE_SIDS.has(voice.id)) && !voice.isCustom && (
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
                    <span className="text-muted-foreground text-[11px]">{t('当前默认朗读音色')}</span>
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
              {t('浏览 51 个精选音色及自定义克隆音色，试听并将喜欢的音色加入快捷收藏。')}
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

            <div className="w-full sm:w-64 shrink-0">
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
                        <span className="text-[10px] px-1 py-0.2 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-medium">
                          48kHz
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
              placeholder={t('搜索发音人姓名、语言、特征风格或情感 (如: 云希, Trump, 喜悦)...')}
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
              variant={groupFilter === 'custom' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setGroupFilter('custom')}
              className="text-xs h-9 px-2.5"
            >
              {t('自定义')}
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
              {t('英语')}
            </Button>
            <Button
              type="button"
              variant={groupFilter === 'ja' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setGroupFilter('ja')}
              className="text-xs h-9 px-2.5"
            >
              {t('日语')}
            </Button>
            <Select
              value={
                ['all', 'custom', 'zh', 'en', 'ja', 'female', 'male', 'child'].includes(groupFilter)
                  ? 'all_langs'
                  : groupFilter
              }
              onValueChange={val => {
                if (val && val !== 'all_langs') setGroupFilter(val)
              }}
            >
              <SelectTrigger className="h-9 text-xs w-[110px]">
                <SelectValue placeholder={t('更多语言')} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all_langs" disabled className="text-xs text-muted-foreground">
                  {t('更多语言筛选...')}
                </SelectItem>
                {AUDITION_LANGUAGE_OPTIONS.filter(opt => !['zh', 'en', 'ja'].includes(opt.langKey)).map(opt => (
                  <SelectItem key={opt.langKey} value={opt.langKey} className="text-xs">
                    <span className="flex items-center gap-1.5">
                      <span>{opt.flag}</span>
                      <span>{opt.label}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
          </div>
        </div>

        {/* 音色检索列表 */}
        <div className="divide-y divide-border/40 rounded-md border border-border/60 bg-background/50">
          {filteredVoices.map(voice => {
            const isFavorite = favoriteVoiceIds.includes(voice.id)
            const isCurrentTarget =
              auditionVoiceId === voice.id &&
              ttsAudioStore.playingTextId === `audition-${voice.id}`
            const isLoading = isCurrentTarget && ttsAudioStore.status === 'loading'
            const isPlaying = isCurrentTarget && ttsAudioStore.status === 'playing'
            const isPaused = isCurrentTarget && ttsAudioStore.status === 'paused'

            return (
              <div
                key={voice.id}
                className="p-3 flex items-center justify-between hover:bg-muted/40 transition-colors gap-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-xs text-foreground">
                      {voice.displayName}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      ({voice.id})
                    </span>
                    {voice.isCustom && (
                      <span className="text-[10px] px-1.5 py-0.2 rounded-full font-medium bg-purple-500/15 text-purple-600 dark:text-purple-400 border border-purple-500/30">
                        {t('自定义')}
                      </span>
                    )}
                    {voice.emotion && (
                      <span className="text-[10px] px-1.5 py-0.2 rounded-full font-medium bg-blue-500/15 text-blue-600 dark:text-blue-400 border border-blue-500/30">
                        {voice.emotion}
                      </span>
                    )}
                    {(voice.recommended || RECOMMENDED_VOICE_SIDS.has(voice.id)) && !voice.isCustom && (
                      <span className="text-[10px] px-1.5 py-0.2 rounded-full font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/30">
                        {t('推荐')}
                      </span>
                    )}
                    <span className="text-[10px] px-1 py-0.2 rounded bg-muted text-muted-foreground">
                      {getLanguageLabel(voice.lang)}
                    </span>
                    <span className="text-[10px] px-1 py-0.2 rounded bg-muted text-muted-foreground">
                      {voice.gender === 'female' ? t('女声') : voice.gender === 'male' ? t('男声') : t('童声')}
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-1">
                    {voice.desc}
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {/* 试听按钮 */}
                  <Button
                    type="button"
                    variant={isPlaying || isPaused || isLoading ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => handleToggleAudition(voice)}
                    className={cn(
                      'h-7 min-w-[68px] px-2 text-xs transition-colors justify-center cursor-pointer',
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

                  {/* 加入/已在收藏 */}
                  {isFavorite ? (
                    <span className="text-[11px] text-muted-foreground px-2 py-1 rounded bg-muted/60 border border-border/40">
                      {t('已在收藏')}
                    </span>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleAddFavorite(voice.id)}
                      className="h-7 px-2 text-xs cursor-pointer"
                    >
                      <BookmarkPlus className="w-3.5 h-3.5 mr-1 shrink-0" />
                      <span>{t('加入收藏')}</span>
                    </Button>
                  )}

                  {/* 自定义音色支持删除 */}
                  {voice.isCustom && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteCustomVoice(voice)}
                      title={t('删除自定义音色')}
                      className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive hover:bg-destructive/10 cursor-pointer"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
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

      {/* 4. 克隆新音色模态对话框 */}
      <Dialog open={isCloneDialogOpen} onOpenChange={setIsCloneDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Sparkles className="w-4 h-4 text-primary" />
              <span>{t('零样本克隆新音色')}</span>
            </DialogTitle>
            <DialogDescription className="text-xs">
              {t('上传一段 3~10 秒清晰的人声参考音频，系统将自动识别语言与情感并提取高保真声学特征。')}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2 text-xs">
            {/* 文件选择区 */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{t('参考音频文件')}</Label>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={handleSelectAudioFile}
                  disabled={isAnalyzing || isSavingClone}
                  className="gap-1.5 h-9 text-xs flex-1 cursor-pointer"
                >
                  <FileAudio className="w-4 h-4 shrink-0" />
                  <span className="truncate">
                    {cloneFilePath ? cloneFilePath : t('选择音频文件 (WAV, MP3, M4A, FLAC)...')}
                  </span>
                </Button>
              </div>
            </div>

            {/* 分析中动画 */}
            {isAnalyzing && (
              <div className="p-3 rounded-md bg-primary/5 border border-primary/20 flex items-center gap-2.5 text-primary">
                <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                <span>{t('SenseVoice 正在解析音频声学特征、语种与情感标签...')}</span>
              </div>
            )}

            {/* 错误提示 */}
            {analysisError && (
              <div className="p-2.5 rounded-md bg-destructive/10 border border-destructive/20 text-destructive text-xs">
                {analysisError}
              </div>
            )}

            {/* 特征提取成功后的回填配置区 */}
            {tempVoiceId && !isAnalyzing && (
              <div className="space-y-3 p-3 rounded-lg border border-border/80 bg-muted/20">
                <div className="flex items-center justify-between text-emerald-600 dark:text-emerald-400 font-medium">
                  <div className="flex items-center gap-1.5">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>{t('音频特征提取成功')}</span>
                  </div>
                  {cloneDurationSec !== null && cloneDurationSec > 0 && (
                    <span className="text-[11px] font-mono text-muted-foreground">
                      {cloneDurationSec.toFixed(1)}s
                    </span>
                  )}
                </div>

                {/* 音色名称 */}
                <div className="space-y-1">
                  <Label className="text-xs">{t('音色名称')}</Label>
                  <Input
                    value={cloneDisplayName}
                    onChange={e => setCloneDisplayName(e.target.value)}
                    placeholder={t('例如：我的旁白音色')}
                    className="h-8 text-xs"
                  />
                </div>

                {/* 语言与情感（自动带出并标注 AI 识别） */}
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">{t('语言')}</Label>
                      <span className="text-[10px] text-emerald-600 dark:text-emerald-400">
                        {t('AI 识别')}
                      </span>
                    </div>
                    <Select
                      value={cloneLang}
                      onValueChange={(val: any) => setCloneLang(val)}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {AUDITION_LANGUAGE_OPTIONS.map(opt => (
                          <SelectItem key={opt.langKey} value={opt.langKey} className="text-xs">
                            <span className="flex items-center gap-1.5">
                              <span>{opt.flag}</span>
                              <span>{opt.label}</span>
                            </span>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">{t('性别')}</Label>
                      <span className="text-[10px] text-muted-foreground">{t('人工确认')}</span>
                    </div>
                    <Select
                      value={cloneGender}
                      onValueChange={(val: any) => setCloneGender(val)}
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="female" className="text-xs">{t('女声')}</SelectItem>
                        <SelectItem value="male" className="text-xs">{t('男声')}</SelectItem>
                        <SelectItem value="child" className="text-xs">{t('萌娃/童声')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                {/* 识别出的情绪展示 */}
                {cloneEmotion && (
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">{t('识别情感:')}</span>
                    <span className="px-2 py-0.5 rounded-full font-medium bg-blue-500/15 text-blue-600 dark:text-blue-400 border border-blue-500/30">
                      {cloneEmotion}
                    </span>
                  </div>
                )}

                {/* 描述与备注 */}
                <div className="space-y-1">
                  <Label className="text-xs">{t('音色描述 (选填)')}</Label>
                  <Input
                    value={cloneDesc}
                    onChange={e => setCloneDesc(e.target.value)}
                    placeholder={t('例如：沉稳青年男声、欢快活泼...')}
                    className="h-8 text-xs"
                  />
                </div>
              </div>
            )}
          </div>

          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsCloneDialogOpen(false)}
              disabled={isSavingClone}
              className="text-xs cursor-pointer"
            >
              {t('取消')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={handleSaveCloneVoice}
              disabled={!tempVoiceId || isAnalyzing || isSavingClone || !cloneDisplayName.trim()}
              className="text-xs gap-1.5 cursor-pointer"
            >
              {isSavingClone ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>{t('保存中...')}</span>
                </>
              ) : (
                <span>{t('确认保存音色')}</span>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
