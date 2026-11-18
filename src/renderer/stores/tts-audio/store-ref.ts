/**
 * TTS Store 引用中转层
 *
 * 音频调度引擎与各 slice 均为模块级函数，运行时需要回调 store，
 * 但 store 由组合入口（tts-audio-store.ts）创建，若直接 import 会形成
 * 「引擎/slice ↔ store」循环依赖。故由主入口在 create() 之后立即注入引用。
 */

import type { StoreApi } from 'zustand'
import type { TTSAudioState } from './types'

type TTSStoreApi = Pick<StoreApi<TTSAudioState>, 'getState' | 'setState' | 'subscribe'>

let storeRef: TTSStoreApi | null = null

export function bindTTSStore(api: TTSStoreApi): void {
  storeRef = api
}

export function ttsStore(): TTSStoreApi {
  if (!storeRef) {
    throw new Error('[TTS] store 引用尚未绑定，bindTTSStore 必须在 useTTSAudioStore 创建后立即调用')
  }
  return storeRef
}
