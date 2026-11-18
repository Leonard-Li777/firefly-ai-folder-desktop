/**
 * TTS 运行时可变状态单例
 * 原 tts-audio-store.ts 内的模块级闭包变量统一收敛于此，
 * 供音频调度引擎各子模块与 store slice 共享读写，保持原「单例闭包」语义不变
 */

import type { StreamingPCMPlayer } from '../../utils/streaming-pcm-player'
import type { ScheduledAudioSource, TTSChunkCue, TTSPlayOptions } from './types'

// 内部闭包全局运行时实例
export const rt = {
  audioContext: null as AudioContext | null,
  sessionCounter: 0,
  activeSessionId: 0,
  hotSwitchCounter: 0,
  scheduledSources: [] as ScheduledAudioSource[],
  nextStartTime: 0,
  currentMasterCues: null as TTSChunkCue[] | null,
  currentMasterTotalDuration: 0,
  // chunkIndex -> Uint8Array
  cachedChunksMap: new Map<number, Uint8Array>(),
  currentCleanedChunks: [] as string[],
  progressTimer: null as ReturnType<typeof setInterval> | null,
  isAllChunksScheduled: false,
  isHotSwitchInProgress: false,
  currentStreamingPlayer: null as StreamingPCMPlayer | null,
  activeStreamCleanups: [] as (() => void)[],
  activeSynthesizingCount: 0,
  currentPlayOptions: undefined as TTSPlayOptions | undefined
}
