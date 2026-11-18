/**
 * TTS 音频状态管理与排程调度 Store
 * apps/desktop/src/renderer/stores/tts-audio-store.ts
 *
 * 核心特性：
 * 1. Web Audio API 硬件时钟时间戳预排程（Timeline Scheduled Playback），零断层爆音
 * 2. 边播边合成：第 1 句合成完成即刻发声，首字延迟 < 300ms；后续分句后台预合成
 * 3. 会话级 sessionId 隔离：切歌或停止即刻 abort 主进程在途网络请求与释放音源
 * 4. 内存分句 WAV 缓存：边播边存，下载导出时秒级复用
 *
 * 结构说明：音频调度引擎（audio-engine / progress / hot-switch / streaming / synthesize）、
 * 运行时可变状态（runtime）、Store 引用中转（store-ref）与状态域 slice（slices/*）已按职责拆分，
 * 本文件仅作为组合入口与对外公共导出 barrel，导出路径保持与拆分前完全一致。
 */

import { create } from 'zustand'
import { getVoiceById, DEFAULT_VOICE_ID } from '../constants/tts-voices'
import { useSettingsStore } from './settings-store'
import { toast } from '../components/common/Toast'
import { t } from '@app/languages'
import type { TTSAudioState } from './tts-audio/types'
import { bindTTSStore } from './tts-audio/store-ref'
import { createVoiceSlice } from './tts-audio/slices/voices'
import { createPlaybackSlice } from './tts-audio/slices/playback'
import { createExportSlice } from './tts-audio/slices/export'

export type { TTSPlayStatus, TTSAudioState, PrebufferedChunkItem } from './tts-audio/types'
export { TTS_BUFFER_WATERMARK } from './tts-audio/constants'
export {
  hasActiveTTSPlugin,
  getActiveTTSPluginId,
  isVoiceCloningSupported
} from './tts-audio/plugin'
export { getCurrentTTSChunks } from './tts-audio/audio-engine'

// 注册 Scheme A 遭遇流式占用被拒绝时的全局广播提示
if (typeof window !== 'undefined' && window.electronAPI?.tts?.onBusyRejected) {
  window.electronAPI.tts.onBusyRejected(() => {
    toast.warning(t('语音引擎正处于沉浸式流式朗读中，分块请求已排队'), 3000, 'tts-busy-rejected')
  })
}

// 各 slice 仅提供自身状态域片段，此处组合为完整 store
export const useTTSAudioStore = create<TTSAudioState>()((set, get) => ({
  ...createVoiceSlice(set, get),
  ...createPlaybackSlice(set, get),
  ...createExportSlice(set, get)
} as TTSAudioState))

// 音频引擎子模块与各 slice 均为模块级函数，创建后立即注入 store 引用（store-ref）
bindTTSStore(useTTSAudioStore)

// 渲染进程启动时自动异步预热拉取全量音色（含自定义音色）与同步设置配置默认值
if (typeof window !== 'undefined') {
  setTimeout(() => {
    useTTSAudioStore
      .getState()
      .refreshVoices()
      .catch(() => {})
  }, 0)

  // 监听并同步设置中心（SettingsStore）中的默认音色与倍率配置
  // 当应用初始化、配置首次载入或在设置页面修改时，若 TTS 当前处于 idle 闲置状态，自动对齐
  const syncFromConfig = (config: any) => {
    if (!config) return
    const state = useTTSAudioStore.getState()
    if (state.status === 'idle') {
      const targetSpeed = typeof config.ttsSpeed === 'number' ? config.ttsSpeed : 1.0
      const rawVoice = config.ttsDefaultVoiceSid || config.ttsDefaultVoiceId
      let targetVoiceId = DEFAULT_VOICE_ID
      if (rawVoice !== undefined && rawVoice !== null) {
        if (isNaN(Number(rawVoice))) {
          targetVoiceId = String(rawVoice)
        } else {
          const matched = getVoiceById(Number(rawVoice), state.allVoices)
          if (matched?.id) targetVoiceId = matched.id
        }
      }
      const matched = getVoiceById(targetVoiceId, state.allVoices)
      const targetSid = matched?.sid ?? 63

      const needsSpeedUpdate = Math.abs(state.speed - targetSpeed) >= 0.01
      const needsVoiceUpdate =
        state.currentVoiceId !== targetVoiceId || state.currentSid !== targetSid

      if (needsSpeedUpdate || needsVoiceUpdate) {
        useTTSAudioStore.setState({
          speed: targetSpeed,
          currentVoiceId: targetVoiceId,
          currentSid: targetSid
        })
      }
    }
  }

  // 1. 尝试使用当前已有快照同步
  try {
    syncFromConfig(useSettingsStore.getState().config)
  } catch {}

  // 2. 订阅 settings-store 的 config 变化
  try {
    useSettingsStore.subscribe(state => {
      syncFromConfig(state.config)
    })
  } catch {}
}
