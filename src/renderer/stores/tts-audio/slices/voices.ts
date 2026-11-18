import { getVoiceById, DEFAULT_VOICE_ID, PRESET_VOICES } from '../../../constants/tts-voices'
import type { VoiceMeta } from '../../../constants/tts-voices'
import { useConfigStore } from '../../config-store'
import { useSettingsStore } from '../../settings-store'
import { triggerHotSwitch } from '../hot-switch'
import { hasActiveTTSPlugin } from '../plugin'
import type { TTSAudioState, TTSStoreSet, TTSStoreGet } from '../types'
import { t } from '@app/languages'

export function createVoiceSlice(set: TTSStoreSet, get: TTSStoreGet): Partial<TTSAudioState> {
  return {
    currentSid: 63,
    currentVoiceId: DEFAULT_VOICE_ID,
    speed: 1.0,

    allVoices: PRESET_VOICES,

    refreshVoices: async () => {
      // 若未安装或未激活 TTS 插件，安全跳过 IPC 调用，返回空列表，绝不使用伪数据兜底
      if (!hasActiveTTSPlugin()) {
        set({ allVoices: [] })
        return []
      }
      try {
        if (typeof window !== 'undefined' && window.electronAPI?.tts?.listVoices) {
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
            const seen = new Set<string>()
            const uniqueList: VoiceMeta[] = []
            for (const item of mapped) {
              if (!seen.has(item.id)) {
                seen.add(item.id)
                uniqueList.push(item)
              }
            }
            set({ allVoices: uniqueList })
            return uniqueList
          }
        }
      } catch (err) {
        console.warn('[useTTSAudioStore] 加载自定义音色失败，回退预置音色库:', err)
      }
      set({ allVoices: PRESET_VOICES })
      return PRESET_VOICES
    },

    setSid: (sid: number) => {
      const state = get()
      const matched = getVoiceById(sid, state.allVoices)
      const voiceId = matched?.id || String(sid)
      set({ currentSid: sid, currentVoiceId: voiceId })
      useSettingsStore
        .getState()
        .updateConfigValue('TTS_DEFAULT_VOICE_SID', voiceId)
        .catch(() => {})
      useConfigStore
        .getState()
        .updateConfigValue('TTS_DEFAULT_VOICE_SID', voiceId)
        .catch(() => {})
    },

    setVoiceId: (voiceId: string) => {
      const state = get()
      if (state.currentVoiceId === voiceId) return

      const matched = getVoiceById(voiceId, state.allVoices)
      const sid = matched?.sid ?? 63
      set({ currentVoiceId: voiceId, currentSid: sid })
      useSettingsStore
        .getState()
        .updateConfigValue('TTS_DEFAULT_VOICE_SID', voiceId)
        .catch(() => {})
      useConfigStore
        .getState()
        .updateConfigValue('TTS_DEFAULT_VOICE_SID', voiceId)
        .catch(() => {})

      // 若当前正在播放或暂停，平滑热切新音色（不断音，合成好后自动无缝切入，接续当前进度）
      if (state.status === 'playing' || state.status === 'loading' || state.status === 'paused') {
        triggerHotSwitch({ voiceId, sid })
      }
    },

    setSpeed: (speed: number) => {
      const state = get()
      if (Math.abs(state.speed - speed) < 0.01) return

      const oldSpeed = state.speed
      set({ speed })
      useSettingsStore
        .getState()
        .updateConfigValue('TTS_SPEED', speed)
        .catch(() => {})
      useConfigStore
        .getState()
        .updateConfigValue('TTS_SPEED', speed)
        .catch(() => {})

      // 若当前正在播放或暂停，平滑热切新倍速（不断音，通过纯 Rust WSOLA 极速派生并在合成后自动切换，接续当前进度）
      if (state.status === 'playing' || state.status === 'loading' || state.status === 'paused') {
        triggerHotSwitch({ speed, oldSpeed })
      }
    },
  }
}
