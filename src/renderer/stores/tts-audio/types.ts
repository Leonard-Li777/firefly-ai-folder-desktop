/**
 * TTS 音频 Store 类型定义
 * 仅承载类型声明，无运行时代码，避免 store / 音频引擎 / slice 之间产生值级循环依赖
 */

import type { VoiceMeta } from '../../constants/tts-voices'

export type TTSPlayStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error' | 'exporting'

/** 单个已排程的音频播放节点 */
export interface ScheduledAudioSource {
  source: AudioBufferSourceNode
  startTime: number
  endTime: number
  index: number
  /** 是否为全量母带播放节点（仅整音频秒播时为 true，分句流式排程恒为 false） */
  isFullAudio?: boolean
  /** 播放起点在全量母带内部的时间偏移量（秒） */
  offsetInAudio?: number
}

/** 单个分句时间戳条目（供整音频 0 误差秒切任意分句） */
export interface TTSChunkCue {
  index: number
  startTime: number
  duration: number
}

/** 预缓冲就绪节点结构（存储已完成 WSOLA 派生且已 decodeAudioData 的纯内存 AudioBuffer） */
export interface PrebufferedChunkItem {
  index: number
  buffer: AudioBuffer
  baseBuffer: ArrayBuffer
}

/**
 * 声学进度信息结构
 */
export interface AudioProgressInfo {
  /** 当前正在播放的分句索引（0-indexed） */
  sentenceIndex: number
  /** 当前分句已播放时长（秒） */
  elapsedInSentence: number
  /** 当前分句总时长（秒） */
  sentenceDuration: number
  /** 当前分句剩余时长（秒） */
  remainingInSentence: number
  /** 全文已播放总时长（秒，在旧语速下） */
  elapsedTotalTime: number
  /** 全文总时长（秒，在旧语速下） */
  totalDuration: number
}

/** 当前播放请求的原始入参快照 */
export interface TTSPlayOptions {
  textId?: string
  filePath?: string
  fileFingerprint?: string
  fieldName?: string
  displayName?: string
  sid?: number
  voiceId?: string
  speed?: number
  isLrc?: boolean
}

export interface TTSAudioState {
  /** 当前正在播放的原始文本 */
  playingText: string
  /** 文本唯一标识符（文件路径/DOM ID/文本哈希等，用于多按钮互斥匹配） */
  playingTextId: string
  /** 播放器状态 */
  status: TTSPlayStatus
  /** 当前正在播放的句子索引 (0-based) */
  currentSentenceIndex: number
  /** 当前文本切分的总句子数 */
  totalSentences: number
  /** 当前发音人 Speaker ID (向后兼容) */
  currentSid: number
  /** 当前音色 ID (MOSS-TTS 规范字符串) */
  currentVoiceId: string
  /** 当前播放语速 */
  speed: number
  /** 当前音频落盘缓存的绝对路径 */
  currentCachePath: string | null
  /** 当前正在播放关联的物理文件绝对路径（若有，原生路径无损记录） */
  currentFilePath: string | null
  /** 当前播放上下文的显示标题/文件名原文本（若有 filePath 提取 basename，否则记录 raw text） */
  currentTitle: string | null
  /** 当前播放关联文件的真实文件名（workspace_files.name，非 smart_name，用于 hover 二级信息展示） */
  currentRealName: string | null
  /** 错误信息 */
  errorMessage: string | null
  /** 全量可用音色列表（包含预置与用户克隆音色） */
  allVoices: VoiceMeta[]
  /** 当前已预缓冲的音频时长（秒，用于向 UI 实时反馈蓄水池水线进度） */
  bufferedDuration: number
  /** 当前目标安全蓄水时长（秒，默认 15.0） */
  targetBufferDuration: number
  /** 当前是否有语音合成底层推理/分句合成正在进行中 */
  isSynthesizing: boolean
  /** 刷新并拉取全量音色库（含自定义音色） */
  refreshVoices: () => Promise<VoiceMeta[]>

  /** 播放/暂停切换 */
  play: (
    text: string,
    options?: {
      textId?: string
      filePath?: string
      fileFingerprint?: string
      fieldName?: string
      displayName?: string
      title?: string
      sid?: number
      voiceId?: string
      speed?: number
      isLrc?: boolean
    }
  ) => Promise<void>
  /** 暂停播放 */
  pause: () => Promise<void>
  /** 恢复播放 */
  resume: () => Promise<void>
  /** 停止播放并释放资源 */
  stop: () => Promise<void>
  /** 切换发音人 (兼容数字) */
  setSid: (sid: number) => void
  /** 切换音色 (字符串 ID) */
  setVoiceId: (voiceId: string) => void
  /** 切换语速 */
  setSpeed: (speed: number) => void
  /** 在系统文件管理器中定位音频文件 */
  locateAudio: (options?: {
    filePath?: string
    fileFingerprint?: string
    fieldName?: string
    displayName?: string
    sid?: number
    voiceId?: string
    speed?: number
  }) => Promise<boolean>
  /** 导出整段音频为本地 WAV 文件（向后兼容保留） */
  exportAudio: (defaultFileName?: string) => Promise<string | null>
  /** 跳转至指定分句片段播放（支持优先合成插队） */
  seekSentence: (targetIndex: number) => Promise<void>
}

/** slice 工厂函数可用的 set 形态（兼容对象补丁与函数式补丁） */
export type TTSStoreSet = (
  partial: Partial<TTSAudioState> | ((state: TTSAudioState) => Partial<TTSAudioState>)
) => void
/** slice 工厂函数可用的 get 形态 */
export type TTSStoreGet = () => TTSAudioState
