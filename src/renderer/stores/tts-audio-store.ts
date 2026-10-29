/**
 * TTS 音频状态管理与排程调度 Store
 * apps/desktop/src/renderer/stores/tts-audio-store.ts
 *
 * 核心特性：
 * 1. Web Audio API 硬件时钟时间戳预排程（Timeline Scheduled Playback），零断层爆音
 * 2. 边播边合成：第 1 句合成完成即刻发声，首字延迟 < 300ms；后续分句后台预合成
 * 3. 会话级 sessionId 隔离：切歌或停止即刻 abort 主进程在途网络请求与释放音源
 * 4. 内存分句 WAV 缓存：边播边存，下载导出时秒级复用
 */

import { create } from 'zustand'
import { cleanTextForTTS, splitTextIntoChunks } from '../lib/text-chunker'
import { useConfigStore } from './config-store'
import { useSettingsStore } from './settings-store'
import {
  getVoiceById,
  DEFAULT_VOICE_ID,
  PRESET_VOICES,
  type VoiceMeta
} from '../constants/tts-voices'
import { toast } from '../components/common/Toast'
import { t } from '@app/languages'

export type TTSPlayStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error' | 'exporting'

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
  /** 错误信息 */
  errorMessage: string | null
  /** 全量可用音色列表（包含预置与用户克隆音色） */
  allVoices: VoiceMeta[]
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

// 内部闭包全局运行时实例
let audioContext: AudioContext | null = null
let sessionCounter = 0
let activeSessionId = 0
let hotSwitchCounter = 0
/** 单个已排程的音频播放节点 */
interface ScheduledAudioSource {
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
interface TTSChunkCue {
  index: number
  startTime: number
  duration: number
}

let scheduledSources: ScheduledAudioSource[] = []
let nextStartTime = 0
let currentMasterCues: TTSChunkCue[] | null = null
let currentMasterTotalDuration = 0
let cachedChunksMap = new Map<number, Uint8Array>() // chunkIndex -> Uint8Array
let currentCleanedChunks: string[] = []
let progressTimer: ReturnType<typeof setInterval> | null = null
let isAllChunksScheduled = false
let isHotSwitchInProgress = false

/** 预缓冲水线配置常数 (P1: 自适应蓄水池门禁以消除 RTF>1 欠载断流) */
export const TTS_BUFFER_WATERMARK = {
  /** 最小就绪分句数（长文本预蓄 2 句） */
  MIN_BUFFERED_CHUNKS: 2,
  /** 最小声学安全时长（秒，累积音频时长达到 10.0 秒即可放行，足以覆盖下一句 15s 生成） */
  MIN_BUFFERED_DURATION_SEC: 10.0,
  /** 单句合成超时熔断时间（毫秒，适配当前 15~25s 真实生成耗时，防止提前泄流） */
  CHUNK_SYNTHESIZE_TIMEOUT_MS: 30000
}

/** 预缓冲就绪节点结构（存储已完成 WSOLA 派生且已 decodeAudioData 的纯内存 AudioBuffer） */
export interface PrebufferedChunkItem {
  index: number
  buffer: AudioBuffer
  baseBuffer: ArrayBuffer
}

/**
 * 为 BufferSource 挂载 GainNode 并施加 15ms 首尾平滑等功率交叉淡化，杜绝直流爆音与声学断气
 */
function createCrossfadedSource(
  ctx: AudioContext,
  audioBuffer: AudioBuffer,
  startAt: number
): { source: AudioBufferSourceNode; gainNode: GainNode } {
  const source = ctx.createBufferSource()
  source.buffer = audioBuffer
  source.playbackRate.value = 1.0

  const gainNode = ctx.createGain()
  const duration = audioBuffer.duration
  const FADE_DUR = Math.min(0.015, duration * 0.1)

  // 头部淡入 (0.001 -> 1.0)
  gainNode.gain.setValueAtTime(0.001, startAt)
  gainNode.gain.exponentialRampToValueAtTime(1.0, startAt + FADE_DUR)

  // 尾部淡出 (1.0 -> 0.001)
  const fadeOutStart = Math.max(startAt + FADE_DUR, startAt + duration - FADE_DUR)
  gainNode.gain.setValueAtTime(1.0, fadeOutStart)
  gainNode.gain.exponentialRampToValueAtTime(0.001, startAt + duration)

  source.connect(gainNode)
  gainNode.connect(ctx.destination)
  return { source, gainNode }
}

/**
 * 将蓄水池中的预缓冲分句原子批量压入 Web Audio 硬件时间轴
 */
function flushPrebufferedChunks(list: PrebufferedChunkItem[], ctx: AudioContext): void {
  if (list.length === 0) return
  let chainTime = Math.max(ctx.currentTime + 0.05, nextStartTime)

  for (const item of list) {
    const { source } = createCrossfadedSource(ctx, item.buffer, chainTime)
    source.start(chainTime)

    const duration = item.buffer.duration
    const endAt = chainTime + duration
    scheduledSources.push({
      source,
      startTime: chainTime,
      endTime: endAt,
      index: item.index,
      isFullAudio: false
    })
    chainTime = endAt
  }

  nextStartTime = chainTime
  useTTSAudioStore.setState({ status: 'playing' })
  ensureProgressMonitor()
}

/** 获取当前正在播放文本的切片分句文本数组（供 UI 刻度预览 Tooltip 使用） */
export function getCurrentTTSChunks(): string[] {
  return currentCleanedChunks
}
let currentPlayOptions: {
  textId?: string
  filePath?: string
  fileFingerprint?: string
  fieldName?: string
  displayName?: string
  sid?: number
  voiceId?: string
  speed?: number
  isLrc?: boolean
} | undefined = undefined

function getOrCreateAudioContext(): AudioContext {
  if (!audioContext || audioContext.state === 'closed') {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
    audioContext = new AudioCtx({ sampleRate: 48000 })
  }
  return audioContext
}

function clearScheduledSources(): void {
  for (const item of scheduledSources) {
    try {
      item.source.stop()
      item.source.disconnect()
    } catch {
      // 忽略已停止的节点异常
    }
  }
  scheduledSources = []
  currentMasterCues = null
  currentMasterTotalDuration = 0
}

function stopProgressMonitor(): void {
  if (progressTimer) {
    clearInterval(progressTimer)
    progressTimer = null
  }
}

/**
 * 声学进度信息结构
 */
interface AudioProgressInfo {
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

/**
 * 实时获取当前播放器的完整声学进度信息
 * 严格适配【整文件秒播模式】与【分句流式排程模式】，消除整文件下 active.index === 0 导致的进度归零陷阱
 */
function getCurrentAudioProgress(): AudioProgressInfo {
  const store = useTTSAudioStore.getState()
  const maxIdx = Math.max(0, currentCleanedChunks.length - 1)
  const fallbackIndex = Math.max(0, Math.min(store.currentSentenceIndex, maxIdx))

  if (!audioContext || scheduledSources.length === 0) {
    return {
      sentenceIndex: fallbackIndex,
      elapsedInSentence: 0,
      sentenceDuration: 0,
      remainingInSentence: 0,
      elapsedTotalTime: 0,
      totalDuration: 0
    }
  }

  const now = audioContext.currentTime

  // 模式 1：整文件全量母带播放模式（仅当单节点且明确标记为整文件母带 isFullAudio: true 时才进入）
  if (
    scheduledSources.length === 1 &&
    scheduledSources[0].isFullAudio === true &&
    currentCleanedChunks.length > 1
  ) {
    const single = scheduledSources[0]
    const nodeDuration = Math.max(0.01, single.endTime - single.startTime)
    const elapsedInNode = Math.max(0, Math.min(nodeDuration, now - single.startTime))
    const offset = single.offsetInAudio || 0
    const audioElapsed = Math.max(0, elapsedInNode + offset)

    // 优先使用路线 A 内嵌的精确分句时间戳索引表 (TTSChunkCue[])
    if (currentMasterCues && currentMasterCues.length > 0) {
      let sentenceIndex = 0
      let sentenceStartTime = 0
      let sentenceDuration = nodeDuration

      for (let i = 0; i < currentMasterCues.length; i++) {
        const cue = currentMasterCues[i]
        const cueEnd = cue.startTime + cue.duration
        if (audioElapsed >= cue.startTime && audioElapsed < cueEnd) {
          sentenceIndex = cue.index
          sentenceStartTime = cue.startTime
          sentenceDuration = cue.duration
          break
        } else if (audioElapsed < cue.startTime && i > 0) {
          sentenceIndex = currentMasterCues[i - 1].index
          sentenceStartTime = currentMasterCues[i - 1].startTime
          sentenceDuration = currentMasterCues[i - 1].duration
          break
        } else if (i === currentMasterCues.length - 1 && audioElapsed >= cue.startTime) {
          sentenceIndex = cue.index
          sentenceStartTime = cue.startTime
          sentenceDuration = cue.duration
          break
        }
      }

      const elapsedInSentence = Math.max(0, Math.min(sentenceDuration, audioElapsed - sentenceStartTime))
      const remainingInSentence = Math.max(0, sentenceDuration - elapsedInSentence)
      const fullTotalDuration = currentMasterTotalDuration || (single.endTime - single.startTime)

      return {
        sentenceIndex,
        elapsedInSentence,
        sentenceDuration: Math.max(0.01, sentenceDuration),
        remainingInSentence,
        elapsedTotalTime: audioElapsed,
        totalDuration: fullTotalDuration
      }
    }

    // 容错兜底（极少数旧缓存未带时间戳表）：基于字数比例进行线性估算
    let totalChars = 0
    for (const c of currentCleanedChunks) {
      totalChars += Math.max(1, c.length)
    }

    const fullTotalDuration = currentMasterTotalDuration || (single.endTime - single.startTime)
    const ratio = Math.min(1.0, audioElapsed / Math.max(0.01, fullTotalDuration))
    let sentenceIndex = 0
    let accumulatedChars = 0
    let sentenceStartTime = 0
    let sentenceEndTime = fullTotalDuration

    for (let i = 0; i < currentCleanedChunks.length; i++) {
      const chunkLen = Math.max(1, currentCleanedChunks[i].length)
      const prevRatio = accumulatedChars / totalChars
      accumulatedChars += chunkLen
      const nextRatio = accumulatedChars / totalChars

      if (ratio <= nextRatio || i === currentCleanedChunks.length - 1) {
        sentenceIndex = i
        sentenceStartTime = prevRatio * fullTotalDuration
        sentenceEndTime = nextRatio * fullTotalDuration
        break
      }
    }

    const sentenceDuration = Math.max(0.01, sentenceEndTime - sentenceStartTime)
    const elapsedInSentence = Math.max(0, Math.min(sentenceDuration, audioElapsed - sentenceStartTime))
    const remainingInSentence = Math.max(0, sentenceDuration - elapsedInSentence)

    return {
      sentenceIndex,
      elapsedInSentence,
      sentenceDuration,
      remainingInSentence,
      elapsedTotalTime: audioElapsed,
      totalDuration: fullTotalDuration
    }
  }

  // 模式 2：分句流式排程模式（包含 1 个或多个分句节点）
  let totalDuration = 0
  for (const s of scheduledSources) {
    totalDuration += (s.endTime - s.startTime)
  }

  // 1. 若当前硬件时钟尚未到达首个排程节点的起播时间（启动微缓冲期，如前 0.05s），精准定位在首个排程节点的 index
  if (now < scheduledSources[0].startTime) {
    const first = scheduledSources[0]
    return {
      sentenceIndex: first.index,
      elapsedInSentence: 0,
      sentenceDuration: Math.max(0.01, first.endTime - first.startTime),
      remainingInSentence: Math.max(0.01, first.endTime - first.startTime),
      elapsedTotalTime: 0,
      totalDuration
    }
  }

  // 2. 查找当前正在发声的节点
  const active = scheduledSources.find(s => now >= s.startTime && now < s.endTime)
  if (active) {
    let elapsedTotalTime = 0
    for (const s of scheduledSources) {
      if (s.index < active.index) {
        elapsedTotalTime += (s.endTime - s.startTime)
      } else if (s.index === active.index) {
        elapsedTotalTime += Math.max(0, now - s.startTime)
        break
      }
    }

    const sentenceDuration = Math.max(0.01, active.endTime - active.startTime)
    const elapsedInSentence = Math.max(0, Math.min(sentenceDuration, now - active.startTime))
    const remainingInSentence = Math.max(0, active.endTime - now)

    return {
      sentenceIndex: active.index,
      elapsedInSentence,
      sentenceDuration,
      remainingInSentence,
      elapsedTotalTime,
      totalDuration
    }
  }

  // 3. 若落在两个相邻排程节点的微小缝隙（gap），锁定紧接着起播的下一个节点的前一个节点，绝不跳至末尾
  const nextNode = scheduledSources.find(s => s.startTime > now)
  if (nextNode) {
    const nextIdx = scheduledSources.indexOf(nextNode)
    const prevNode = nextIdx > 0 ? scheduledSources[nextIdx - 1] : nextNode
    let elapsedTotalTime = 0
    for (const s of scheduledSources) {
      if (s.index <= prevNode.index) {
        elapsedTotalTime += (s.endTime - s.startTime)
      }
    }
    return {
      sentenceIndex: prevNode.index,
      elapsedInSentence: prevNode.endTime - prevNode.startTime,
      sentenceDuration: prevNode.endTime - prevNode.startTime,
      remainingInSentence: 0,
      elapsedTotalTime,
      totalDuration
    }
  }

  // 4. 容错：仅当时钟真正越过所有排程末尾时，才定位至末尾节点
  const lastSource = scheduledSources[scheduledSources.length - 1]
  const lastIndex = lastSource ? lastSource.index : fallbackIndex

  return {
    sentenceIndex: lastIndex,
    elapsedInSentence: lastSource ? (lastSource.endTime - lastSource.startTime) : 0,
    sentenceDuration: lastSource ? (lastSource.endTime - lastSource.startTime) : 0,
    remainingInSentence: 0,
    elapsedTotalTime: totalDuration,
    totalDuration
  }
}

/**
 * 确保播放进度轮询监测器处于活跃运行状态
 */
function ensureProgressMonitor(): void {
  if (progressTimer) return
  progressTimer = setInterval(() => {
    if (!audioContext) return
    const prog = getCurrentAudioProgress()
    if (prog.sentenceIndex !== useTTSAudioStore.getState().currentSentenceIndex) {
      useTTSAudioStore.setState({ currentSentenceIndex: prog.sentenceIndex })
    }
    // 全部播放完毕检测：必须所有分句均已合成入队，当前无热切进行中，且播放时钟越过末尾！
    if (
      isAllChunksScheduled &&
      !isHotSwitchInProgress &&
      scheduledSources.length > 0 &&
      audioContext.currentTime >= nextStartTime &&
      useTTSAudioStore.getState().status === 'playing'
    ) {
      useTTSAudioStore.getState().stop()
    }
  }, 80)
}

/**
 * 核心特性：播放中平滑热切换（Hot Handover）
 * 保持当前音频在扬声器中连贯朗读的同时，在后台异步预合成新音色/新倍率切入点，完成后无缝自动接管播放
 */
function triggerHotSwitch(changed: { voiceId?: string; sid?: number; speed?: number; oldSpeed?: number }) {
  const store = useTTSAudioStore.getState()
  const text = store.playingText
  if (!text || !currentCleanedChunks.length) return

  // 1. 给出 Toast 提示词，明确告知正在合成且合成后会自动切换
  toast.info(t('正在合成音频，合成后会自动切换'), 3500, 'tts-switching-voice')

  // 2. 递增热切版本号，并激活热切互斥标记，防止旧音轨结束误杀播放状态
  const switchId = ++hotSwitchCounter
  isHotSwitchInProgress = true

  // 3. 立即精准捕获切换前在旧音轨中的声学进度（分句索引与全文已播时长）
  const wasPaused = store.status === 'paused'
  const initialProgress = getCurrentAudioProgress()
  const oldSpeed = changed.oldSpeed !== undefined ? changed.oldSpeed : store.speed
  const isVoiceChanged = changed.voiceId !== undefined

  // 4. 异步后台执行合成、派生与平滑切入
  ;(async () => {
    try {
      const targetVoiceId = useTTSAudioStore.getState().currentVoiceId
      const targetSid = useTTSAudioStore.getState().currentSid
      const targetSpeed = useTTSAudioStore.getState().speed
      const matchedVoice = getVoiceById(targetVoiceId, useTTSAudioStore.getState().allVoices)
      const targetDisplayName = matchedVoice?.displayName || String(targetVoiceId)
      const options = currentPlayOptions

      // 解析新配置对应的目标落盘路径（若 1.0x 基准已就绪，getCachePath 将毫秒级派生目标倍率文件）
      let targetCachePath: string | null = null
      let base1xCachePath: string | null = null
      if (window.electronAPI?.tts?.getCachePath) {
        try {
          targetCachePath = await window.electronAPI.tts.getCachePath({
            filePath: options?.filePath,
            fileFingerprint: options?.fileFingerprint,
            fieldName: options?.fieldName,
            displayName: targetDisplayName,
            text,
            voiceId: targetVoiceId,
            sid: targetSid,
            speed: targetSpeed
          })
          if (Math.abs(targetSpeed - 1.0) >= 0.01) {
            base1xCachePath = await window.electronAPI.tts.getCachePath({
              filePath: options?.filePath,
              fileFingerprint: options?.fileFingerprint,
              fieldName: options?.fieldName,
              displayName: targetDisplayName,
              text,
              voiceId: targetVoiceId,
              sid: targetSid,
              speed: 1.0
            })
          } else {
            base1xCachePath = targetCachePath
          }
        } catch (e) {
          console.warn('[TTS HotSwitch] 解析目标缓存路径失败:', e)
        }
      }

      // 检查任务版本号：若已被覆盖，安全退出
      if (switchId !== hotSwitchCounter) {
        return
      }

      // 【通道 A：整音频极速无缝接管通道】
      // 若目标音频已全量落盘（如 WSOLA 毫秒级派生完成或历史完整缓存命中），直接读取并按精确时间偏移无缝接管
      if (targetCachePath && window.electronAPI?.tts?.readWavMetadata && window.electronAPI?.tts?.readWavFile) {
        try {
          const metadata = await window.electronAPI.tts.readWavMetadata(targetCachePath)
          const isSpeedMatch = metadata?.speed === undefined || Math.abs(metadata.speed - targetSpeed) < 0.01
          if (metadata && metadata.completed && isSpeedMatch) {
            const fullWavBuffer = await window.electronAPI.tts.readWavFile(targetCachePath)
            if (fullWavBuffer && fullWavBuffer.byteLength > 44) {
              if (switchId !== hotSwitchCounter) return

              const ctx = getOrCreateAudioContext()
              if (ctx.state === 'suspended') {
                await ctx.resume()
              }
              const audioBuffer = await ctx.decodeAudioData(fullWavBuffer.slice(0))
              if (switchId !== hotSwitchCounter) return

              // 在切断旧音轨的前一刻，再次获取最新已播放时长与分句索引，消除异步 I/O 期间的微小时钟漂移
              const currentProgress = getCurrentAudioProgress()
              let newOffset = 0
              if (oldSpeed > 0 && targetSpeed > 0) {
                newOffset = (currentProgress.elapsedTotalTime * oldSpeed) / targetSpeed
              }
              newOffset = Math.max(0, Math.min(Math.max(0, audioBuffer.duration - 0.05), newOffset))

              // 终止旧会话与旧音轨排程
              const oldSession = activeSessionId
              const newSessionId = ++sessionCounter
              activeSessionId = newSessionId

              if (window.electronAPI?.tts?.abortSession) {
                window.electronAPI.tts.abortSession(oldSession).catch(err => {
                  console.warn('[TTS HotSwitch] 中止旧会话异常 (通道 A):', err)
                })
              }

              clearScheduledSources()
              currentMasterCues = metadata.chunks || null
              currentMasterTotalDuration = audioBuffer.duration

              // 新音频从当前硬件时钟 + 0.02s 起播，指定偏移量 newOffset
              const startAt = ctx.currentTime + 0.02
              const source = ctx.createBufferSource()
              source.buffer = audioBuffer
              source.playbackRate.value = 1.0
              source.connect(ctx.destination)
              source.start(startAt, newOffset)

              const remainingDuration = audioBuffer.duration - newOffset
              const endAt = startAt + remainingDuration
              scheduledSources.push({
                source,
                startTime: startAt,
                endTime: endAt,
                index: currentProgress.sentenceIndex,
                isFullAudio: true,
                offsetInAudio: newOffset
              })
              nextStartTime = endAt
              isAllChunksScheduled = true

              // 更新 Store 状态
              useTTSAudioStore.setState({
                status: 'playing',
                currentSentenceIndex: currentProgress.sentenceIndex,
                currentCachePath: targetCachePath,
                speed: targetSpeed,
                currentVoiceId: targetVoiceId,
                currentSid: targetSid
              })

              ensureProgressMonitor()
              toast.success(t('已自动切换播放'), 2000, 'tts-switching-voice')
              return
            }
          }
        } catch (fastSwitchErr) {
          console.warn('[TTS HotSwitch] 全量整音频极速接管失败，平滑回退分句流式通道:', fastSwitchErr)
        }
      }

      // 【通道 B：分句流式合成与平滑接力通道】
      // 1. 确定切入分句的目标索引：
      //    - 若当前处于暂停状态，精准锁定当前停留的分句索引，绝不向后跳跃；
      //    - 若处于播放中且当前句剩余时长较短（< 1.0 秒）且存在下一句，则让旧音轨自然读完当前句，直接预合成下一句作为切入点；
      //    - 否则以当前句作为切入点。
      let targetSentenceIdx = initialProgress.sentenceIndex
      const shouldHandoverAtNext =
        !wasPaused &&
        initialProgress.remainingInSentence < 1.0 &&
        initialProgress.sentenceIndex + 1 < currentCleanedChunks.length

      if (shouldHandoverAtNext) {
        targetSentenceIdx = initialProgress.sentenceIndex + 1
      }

      const chunkText = currentCleanedChunks[targetSentenceIdx]
      let baseBuffer: ArrayBuffer | null = null

      // 若发音人未变（仅变语速），且内存中已有当前句 1.0x 母本，直接毫秒级复用
      const cachedChunk = cachedChunksMap.get(targetSentenceIdx)
      if (!isVoiceChanged && cachedChunk) {
        baseBuffer = cachedChunk.buffer.slice(
          cachedChunk.byteOffset,
          cachedChunk.byteOffset + cachedChunk.byteLength
        ) as ArrayBuffer
      } else if (window.electronAPI?.tts?.readChunk) {
        const diskChunk = await window.electronAPI.tts.readChunk({
          filePath: options?.filePath,
          fileFingerprint: options?.fileFingerprint,
          fieldName: options?.fieldName,
          displayName: targetDisplayName,
          voiceId: targetVoiceId,
          chunkIndex: targetSentenceIdx,
          chunkText
        })
        if (diskChunk && diskChunk.byteLength > 44) {
          baseBuffer = diskChunk
        }
      }
      if (!baseBuffer) {
        const synthRes = await window.electronAPI.tts.synthesizeChunk(
          chunkText,
          targetVoiceId,
          1.0,
          switchId,
          targetSid
        )
        if (synthRes) {
          if (synthRes.hitCap) {
            toast.warning(t('音频片段过长已自动截断'))
          }
          baseBuffer = synthRes.buffer
        }
      }

      // 检查任务版本号：若已被覆盖，直接丢弃
      if (switchId !== hotSwitchCounter) {
        return
      }

      if (!baseBuffer || baseBuffer.byteLength === 0) {
        console.warn('[TTS HotSwitch] 切入句合成失败')
        toast.error(t('切换音色失败，语音合成服务不可用'), 3500, 'tts-switching-voice')
        return
      }

      // WSOLA 语速派生
      let playbackBuffer: ArrayBuffer = baseBuffer
      if (Math.abs(targetSpeed - 1.0) >= 0.01 && window.electronAPI?.tts?.scaleWav) {
        const scaled = await window.electronAPI.tts.scaleWav(baseBuffer, targetSpeed)
        if (scaled && scaled.byteLength > 44) {
          playbackBuffer = scaled
        }
      }

      if (switchId !== hotSwitchCounter) {
        return
      }

      // 解码 AudioBuffer
      const ctx = getOrCreateAudioContext()
      if (ctx.state === 'suspended') {
        await ctx.resume()
      }
      const audioBuffer = await ctx.decodeAudioData(playbackBuffer.slice(0))

      if (switchId !== hotSwitchCounter) {
        return
      }

      // 在准备接管前，再次获取当前最新播放进度
      const latestProgress = getCurrentAudioProgress()

      // 若在后台异步合成期间，旧音轨已经自然播放到了切入句之后，则顺延 targetSentenceIdx 防止时空倒流（若原为暂停则严格固定在当前分句）
      let actualStartSentenceIdx = targetSentenceIdx
      if (!wasPaused && latestProgress.sentenceIndex > targetSentenceIdx) {
        actualStartSentenceIdx = latestProgress.sentenceIndex
      }

      // 【执行切入】：停止旧会话
      const oldSession = activeSessionId
      const newSessionId = ++sessionCounter
      activeSessionId = newSessionId

      if (window.electronAPI?.tts?.abortSession) {
        window.electronAPI.tts.abortSession(oldSession).catch(err => {
          console.warn('[TTS HotSwitch] 中止旧会话异常:', err)
        })
      }

      // 停止所有旧排程节点
      clearScheduledSources()

      // 新音频从当前时钟 + 0.02s 立即起播切入句
      const startAt = ctx.currentTime + 0.02
      const source = ctx.createBufferSource()
      source.buffer = audioBuffer
      source.playbackRate.value = 1.0
      source.connect(ctx.destination)
      source.start(startAt)

      const endAt = startAt + audioBuffer.duration
      scheduledSources.push({
        source,
        startTime: startAt,
        endTime: endAt,
        index: actualStartSentenceIdx
      })
      nextStartTime = endAt

      // 更新 Store 状态
      useTTSAudioStore.setState({
        status: 'playing',
        currentSentenceIndex: actualStartSentenceIdx,
        currentCachePath: targetCachePath,
        speed: targetSpeed,
        currentVoiceId: targetVoiceId,
        currentSid: targetSid
      })

      ensureProgressMonitor()

      // 弹出已自动切换提示
      toast.success(t('已自动切换播放'), 2000, 'tts-switching-voice')

      // 若发音人发生变更，清空旧音色缓存池
      if (isVoiceChanged) {
        cachedChunksMap.clear()
      }
      cachedChunksMap.set(actualStartSentenceIdx, new Uint8Array(baseBuffer))

      // 异步分片独立落盘（路线 A：即合成即写盘，零内存驻留压力）
      if (baseBuffer && baseBuffer.byteLength > 0 && window.electronAPI?.tts?.saveChunk) {
        window.electronAPI.tts.saveChunk({
          filePath: options?.filePath,
          fileFingerprint: options?.fileFingerprint,
          fieldName: options?.fieldName,
          displayName: targetDisplayName,
          voiceId: targetVoiceId,
          sid: targetSid,
          speed: targetSpeed,
          chunkIndex: targetSentenceIdx,
          totalChunks: currentCleanedChunks.length,
          chunkData: new Uint8Array(baseBuffer),
          chunkText: currentCleanedChunks[targetSentenceIdx]
        }).catch(err => {
          console.warn('[TTS HotSwitch] 异步保存切入句分片异常:', err)
        })
      }

      // 紧接着在后台流式合成后续句子（targetSentenceIdx + 1 到全文结束）
      for (let i = targetSentenceIdx + 1; i < currentCleanedChunks.length; i++) {
        if (activeSessionId !== newSessionId) return

        const nextChunkText = currentCleanedChunks[i]
        let nextBaseBuffer: ArrayBuffer | null = null

        const cachedNext = cachedChunksMap.get(i)
        if (changed.voiceId === undefined && cachedNext) {
          nextBaseBuffer = cachedNext.buffer.slice(
            cachedNext.byteOffset,
            cachedNext.byteOffset + cachedNext.byteLength
          ) as ArrayBuffer
        } else if (window.electronAPI?.tts?.readChunk) {
          const diskBuf = await window.electronAPI.tts.readChunk({
            filePath: options?.filePath,
            fileFingerprint: options?.fileFingerprint,
            fieldName: options?.fieldName,
            displayName: targetDisplayName,
            voiceId: targetVoiceId,
            chunkIndex: i,
            chunkText: nextChunkText
          })
          if (diskBuf && diskBuf.byteLength > 44) {
            nextBaseBuffer = diskBuf
          }
        }
        if (!nextBaseBuffer) {
          const synthRes = await window.electronAPI.tts.synthesizeChunk(
            nextChunkText,
            targetVoiceId,
            1.0,
            newSessionId,
            targetSid
          )
          if (synthRes) {
            if (synthRes.hitCap) {
              toast.warning(t('音频片段过长已自动截断'))
            }
            nextBaseBuffer = synthRes.buffer
          }
        }

        if (activeSessionId !== newSessionId) return
        if (!nextBaseBuffer || nextBaseBuffer.byteLength === 0) continue

        const nextChunkUint8 = new Uint8Array(nextBaseBuffer)
        cachedChunksMap.set(i, nextChunkUint8)

        // 异步分片独立落盘（路线 A：即合成即写盘，集齐后自动无损流式合并并派生目标倍速）
        if (window.electronAPI?.tts?.saveChunk) {
          window.electronAPI.tts.saveChunk({
            filePath: options?.filePath,
            fileFingerprint: options?.fileFingerprint,
            fieldName: options?.fieldName,
            displayName: targetDisplayName,
            voiceId: targetVoiceId,
            sid: targetSid,
            speed: targetSpeed,
            chunkIndex: i,
            totalChunks: currentCleanedChunks.length,
            chunkData: nextChunkUint8,
            chunkText: nextChunkText
          }).catch(err => {
            console.warn('[TTS HotSwitch] 异步保存后续分片异常:', err)
          })
        }

        // 目标倍率 WSOLA
        let nextPlaybackBuffer: ArrayBuffer = nextBaseBuffer
        if (Math.abs(targetSpeed - 1.0) >= 0.01 && window.electronAPI?.tts?.scaleWav) {
          const scaled = await window.electronAPI.tts.scaleWav(nextBaseBuffer, targetSpeed)
          if (scaled && scaled.byteLength > 44) {
            nextPlaybackBuffer = scaled
          }
        }

        if (activeSessionId !== newSessionId) return

        const nextAudioBuffer = await ctx.decodeAudioData(nextPlaybackBuffer.slice(0))
        if (activeSessionId !== newSessionId) return

        const nextSource = ctx.createBufferSource()
        nextSource.buffer = nextAudioBuffer
        nextSource.playbackRate.value = 1.0
        nextSource.connect(ctx.destination)

        const nextStartAt = Math.max(ctx.currentTime + 0.05, nextStartTime)
        nextSource.start(nextStartAt)
        const nextDuration = nextAudioBuffer.duration
        const nextEndAt = nextStartAt + nextDuration
        scheduledSources.push({
          source: nextSource,
          startTime: nextStartAt,
          endTime: nextEndAt,
          index: i
        })
        nextStartTime = nextEndAt
      }

      isAllChunksScheduled = true
    } catch (err) {
      console.error('[TTS HotSwitch] 热切调度失败:', err)
      toast.error(t('切换音色失败，语音合成服务不可用'), 3500, 'tts-switching-voice')
    } finally {
      if (switchId === hotSwitchCounter) {
        isHotSwitchInProgress = false
      }
    }
  })()
}

export const useTTSAudioStore = create<TTSAudioState>()((set, get) => ({
  playingText: '',
  playingTextId: '',
  status: 'idle',
  currentSentenceIndex: 0,
  totalSentences: 0,
  currentSid: 63,
  currentVoiceId: DEFAULT_VOICE_ID,
  speed: 1.0,
  currentCachePath: null,
  errorMessage: null,
  allVoices: PRESET_VOICES,

  refreshVoices: async () => {
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
    useSettingsStore.getState().updateConfigValue('TTS_DEFAULT_VOICE_SID', voiceId).catch(() => {})
    useConfigStore.getState().updateConfigValue('TTS_DEFAULT_VOICE_SID', voiceId).catch(() => {})
  },

  setVoiceId: (voiceId: string) => {
    const state = get()
    if (state.currentVoiceId === voiceId) return

    const matched = getVoiceById(voiceId, state.allVoices)
    const sid = matched?.sid ?? 63
    set({ currentVoiceId: voiceId, currentSid: sid })
    useSettingsStore.getState().updateConfigValue('TTS_DEFAULT_VOICE_SID', voiceId).catch(() => {})
    useConfigStore.getState().updateConfigValue('TTS_DEFAULT_VOICE_SID', voiceId).catch(() => {})

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
    useSettingsStore.getState().updateConfigValue('TTS_SPEED', speed).catch(() => {})
    useConfigStore.getState().updateConfigValue('TTS_SPEED', speed).catch(() => {})

    // 若当前正在播放或暂停，平滑热切新倍速（不断音，通过纯 Rust WSOLA 极速派生并在合成后自动切换，接续当前进度）
    if (state.status === 'playing' || state.status === 'loading' || state.status === 'paused') {
      triggerHotSwitch({ speed, oldSpeed })
    }
  },

  pause: async () => {
    if (audioContext && audioContext.state === 'running') {
      await audioContext.suspend()
      stopProgressMonitor()
      set({ status: 'paused' })
    }
  },

  resume: async () => {
    if (audioContext && audioContext.state === 'suspended') {
      await audioContext.resume()
      set({ status: 'playing' })

      // 重启进度监控
      ensureProgressMonitor()
    }
  },

  stop: async () => {
    isHotSwitchInProgress = false
    stopProgressMonitor()
    clearScheduledSources()
    isAllChunksScheduled = false
    hotSwitchCounter++
    currentPlayOptions = undefined
    const sidToAbort = activeSessionId
    activeSessionId = ++sessionCounter
    nextStartTime = 0

    if (window.electronAPI?.tts?.abortSession) {
      window.electronAPI.tts.abortSession(sidToAbort).catch(err => {
        console.warn('[TTS Stop] 中止会话异常:', err)
      })
    }

    set({
      status: 'idle',
      playingText: '',
      playingTextId: '',
      currentSentenceIndex: 0,
      totalSentences: 0,
      errorMessage: null
    })
  },

  play: async (text: string, options) => {
    const state = get()
    const targetTextId = options?.textId || text

    // 1. 同文本ID且同一朗读内容、且音色与语速均未改变时：
    //    - 正在播放 -> 暂停
    //    - 已暂停 -> 恢复
    const isVoiceChanged = options?.voiceId !== undefined && options.voiceId !== state.currentVoiceId
    const isSpeedChanged = options?.speed !== undefined && Math.abs(options.speed - state.speed) >= 0.01

    if (!isVoiceChanged && !isSpeedChanged) {
      if (state.status === 'playing' && state.playingTextId === targetTextId && state.playingText === text) {
        await state.pause()
        return
      }

      if (state.status === 'paused' && state.playingTextId === targetTextId && state.playingText === text) {
        await state.resume()
        return
      }
    } else if (state.status === 'playing' || state.status === 'loading' || state.status === 'paused') {
      // 若当前正在播放或暂停同段文本但改变了音色或倍速，直接走平滑热切，接续当前进度
      const oldSpeed = state.speed
      if (options?.voiceId !== undefined) {
        const matched = getVoiceById(options.voiceId, get().allVoices)
        set({ currentVoiceId: options.voiceId, currentSid: matched?.sid ?? 63 })
      }
      if (options?.speed !== undefined) {
        set({ speed: options.speed })
      }
      currentPlayOptions = options
      triggerHotSwitch({ voiceId: options?.voiceId, sid: options?.sid, speed: options?.speed, oldSpeed })
      return
    }

    // 2. 全新文本播放或切播：彻底中止前序任务
    await state.stop()
    currentPlayOptions = options

    const thisSessionId = ++sessionCounter
    activeSessionId = thisSessionId

    // 获取配置默认音色与语速
    const config = useSettingsStore.getState().config || useConfigStore.getState().config
    const chosenVoiceId =
      options?.voiceId !== undefined
        ? String(options.voiceId)
        : options?.sid !== undefined
          ? String(options.sid)
          : String((config as any)?.ttsDefaultVoiceId || (config as any)?.ttsDefaultVoiceSid || DEFAULT_VOICE_ID)
    const matchedVoice = getVoiceById(chosenVoiceId, get().allVoices)
    // 关键修复：优先采用解析出的音色真实专属 sid，彻底杜绝调用方传入 stale sid 污染导致不同音色发音恒同！
    const chosenSid =
      typeof matchedVoice?.sid === 'number'
        ? matchedVoice.sid
        : typeof options?.sid === 'number'
          ? options.sid
          : !isNaN(Number(chosenVoiceId))
            ? Number(chosenVoiceId)
            : (matchedVoice?.sid ?? 63)
    const chosenSpeed = options?.speed !== undefined ? options.speed : ((config as any)?.ttsSpeed ?? 1.0)

    // 文本清洗与分句切片：优先调用 Omni 原生词性与自然换气智能分句，异常时平滑回退本地纯标点分句
    const cleaned = cleanTextForTTS(text, { isLrc: options?.isLrc })
    let chunks: string[] = []
    if (window.electronAPI?.tts?.splitTextChunks) {
      try {
        chunks = await window.electronAPI.tts.splitTextChunks(cleaned)
      } catch (e) {
        chunks = splitTextIntoChunks(cleaned)
      }
    }
    if (!chunks || chunks.length === 0) {
      chunks = splitTextIntoChunks(cleaned)
    }

    if (chunks.length === 0) {
      set({ status: 'idle', errorMessage: '没有可朗读的有效文本内容' })
      return
    }

    currentCleanedChunks = chunks
    cachedChunksMap.clear()

    // 解析发音人显示名称与本地磁盘缓存目标路径（传入 text，纯文本/试听例句变化时指纹实时变化）
    const isAudition = options?.textId?.startsWith('audition-') || options?.fieldName === 'audition'
    const targetFingerprint = isAudition ? 'preview' : options?.fileFingerprint
    const targetFieldName = isAudition ? 'audition' : options?.fieldName
    const chosenDisplayName = options?.displayName || matchedVoice?.displayName || String(chosenVoiceId)
    let targetCachePath: string | null = null
    let base1xCachePath: string | null = null

    if (window.electronAPI?.tts?.getCachePath) {
      try {
        targetCachePath = await window.electronAPI.tts.getCachePath({
          filePath: options?.filePath,
          fileFingerprint: targetFingerprint,
          fieldName: targetFieldName,
          displayName: chosenDisplayName,
          text: text,
          voiceId: chosenVoiceId,
          sid: chosenSid,
          speed: chosenSpeed
        })

        // 同时解析 1.0x 黄金母本基准缓存路径
        if (Math.abs(chosenSpeed - 1.0) >= 0.01) {
          base1xCachePath = await window.electronAPI.tts.getCachePath({
            filePath: options?.filePath,
            fileFingerprint: targetFingerprint,
            fieldName: targetFieldName,
            displayName: chosenDisplayName,
            text: text,
            voiceId: chosenVoiceId,
            sid: chosenSid,
            speed: 1.0
          })
        } else {
          base1xCachePath = targetCachePath
        }
      } catch (e) {
        console.warn('[TTS] 解析缓存路径失败:', e)
      }
    }

    set({
      playingText: text,
      playingTextId: targetTextId,
      status: 'loading',
      currentSentenceIndex: 0,
      totalSentences: chunks.length,
      currentSid: chosenSid,
      currentVoiceId: chosenVoiceId,
      speed: chosenSpeed,
      currentCachePath: targetCachePath,
      errorMessage: null
    })

    const ctx = getOrCreateAudioContext()
    if (ctx.state === 'suspended') {
      await ctx.resume()
    }
    nextStartTime = ctx.currentTime

    // 启动进度轮询监测
    ensureProgressMonitor()

    // 4. 检查本地磁盘缓存：若已全部完成，直接读取完整本地 WAV 秒播
    if (targetCachePath && window.electronAPI?.tts?.readWavMetadata) {
      try {
        const metadata = await window.electronAPI.tts.readWavMetadata(targetCachePath)
        // 语速严格一致才命中，确保不同倍率拥有独立的纯正原音，杜绝变调
        if (metadata && metadata.completed && (metadata.speed === undefined || Math.abs(metadata.speed - chosenSpeed) < 0.01)) {
          const fullWavBuffer = await window.electronAPI.tts.readWavFile(targetCachePath)
          if (fullWavBuffer && fullWavBuffer.byteLength > 44) {
            if (activeSessionId !== thisSessionId) return

            const audioBuffer = await ctx.decodeAudioData(fullWavBuffer.slice(0))
            if (activeSessionId !== thisSessionId) return

            clearScheduledSources()
            currentMasterCues = metadata.chunks || null
            currentMasterTotalDuration = audioBuffer.duration

            const source = ctx.createBufferSource()
            source.buffer = audioBuffer
            source.playbackRate.value = 1.0
            source.connect(ctx.destination)

            const startAt = Math.max(ctx.currentTime + 0.05, nextStartTime)
            source.start(startAt)
            const effectiveDuration = audioBuffer.duration
            nextStartTime = startAt + effectiveDuration
            scheduledSources.push({
              source,
              startTime: startAt,
              endTime: nextStartTime,
              index: 0,
              isFullAudio: true,
              offsetInAudio: 0
            })

            isAllChunksScheduled = true
            set({ status: 'playing' })
            return
          }
        }
      } catch (cacheErr) {
        console.warn('[TTS] 读取全量本地缓存异常，回退流式合成:', cacheErr)
      }
    }

    // 5. 流式合成调度循环（支持断点续播与边播边落盘）
    try {
      let startIndex = 0

      // 检查是否存在断点（优先自 1.0x 基准母本或当前目标文件恢复）
      const resumeCandidatePath = base1xCachePath || targetCachePath
      if (resumeCandidatePath && window.electronAPI?.tts?.readWavMetadata) {
        try {
          const meta = await window.electronAPI.tts.readWavMetadata(resumeCandidatePath)
          if (
            meta &&
            !meta.completed &&
            meta.done > 0 &&
            meta.done < chunks.length &&
            (meta.voiceId === undefined || meta.voiceId === chosenVoiceId)
          ) {
            const partialBuf = await window.electronAPI.tts.readWavFile(resumeCandidatePath)
            if (partialBuf && partialBuf.byteLength > 44) {
              let playBuf = partialBuf
              if (Math.abs(chosenSpeed - 1.0) >= 0.01 && window.electronAPI?.tts?.scaleWav) {
                const scaled = await window.electronAPI.tts.scaleWav(partialBuf, chosenSpeed)
                if (scaled && scaled.byteLength > 44) {
                  playBuf = scaled
                }
              }

              const partialAudio = await ctx.decodeAudioData(playBuf.slice(0))
              if (activeSessionId === thisSessionId) {
                const source = ctx.createBufferSource()
                source.buffer = partialAudio
                source.playbackRate.value = 1.0
                source.connect(ctx.destination)

                const startAt = Math.max(ctx.currentTime + 0.05, nextStartTime)
                source.start(startAt)
                const effectiveDuration = partialAudio.duration
                nextStartTime = startAt + effectiveDuration
                scheduledSources.push({
                  source,
                  startTime: startAt,
                  endTime: nextStartTime,
                  index: meta.done - 1
                })
                set({ status: 'playing', currentSentenceIndex: meta.done - 1 })
                startIndex = meta.done
              }
            }
          }
        } catch (e) {
          console.warn('[TTS] 断点恢复异常，从首句合成:', e)
        }
      }

      // 预缓冲安全水线蓄水池
      const readyBufferList: PrebufferedChunkItem[] = []
      let totalBufferedDuration = 0
      const remainingChunksCount = Math.max(1, chunks.length - startIndex)
      let isWatermarkSatisfied = false

      for (let i = startIndex; i < chunks.length; i++) {
        if (activeSessionId !== thisSessionId) {
          // 会话已被中止
          return
        }

        const chunkText = chunks[i]
        let baseBuffer: ArrayBuffer | null = null

        // 优先检查内存缓存与磁盘分片缓存（传递 chunkText 确保防错位校验）
        const cachedMem = cachedChunksMap.get(i)
        if (cachedMem) {
          baseBuffer = cachedMem.buffer.slice(
            cachedMem.byteOffset,
            cachedMem.byteOffset + cachedMem.byteLength
          ) as ArrayBuffer
        } else if (window.electronAPI?.tts?.readChunk) {
          const diskBuf = await window.electronAPI.tts.readChunk({
            filePath: options?.filePath,
            fileFingerprint: options?.fileFingerprint,
            fieldName: options?.fieldName,
            displayName: chosenDisplayName,
            voiceId: chosenVoiceId,
            chunkIndex: i,
            chunkText
          })
          if (diskBuf && diskBuf.byteLength > 44) {
            baseBuffer = diskBuf
          }
        }

        if (!baseBuffer) {
          // 核心声学架构：底层请求 1.0x 基准母本合成，并通过纯 Rust WSOLA 极速算法派生任意目标倍速
          const synthPromise = window.electronAPI.tts.synthesizeChunk(
            chunkText,
            chosenVoiceId,
            1.0,
            thisSessionId,
            chosenSid
          )

          let synthRes: { buffer: ArrayBuffer; hitCap: boolean; steps: number } | null = null
          // 若起播门禁尚未放行且蓄水池已具备首句，在等待后续分句时注入 8000ms 超时门禁探测
          if (!isWatermarkSatisfied && readyBufferList.length > 0) {
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
              const timeoutPromise = new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), TTS_BUFFER_WATERMARK.CHUNK_SYNTHESIZE_TIMEOUT_MS)
              })
              const raceResult = await Promise.race([synthPromise, timeoutPromise])

              if (raceResult === null) {
                console.warn('[TTS] 预缓冲后续分句等待超时(>8000ms)，降级以首句立即放行起播')
                // 放行起播门禁，原子压入已就绪首句
                isWatermarkSatisfied = true
                flushPrebufferedChunks(readyBufferList, ctx)
                readyBufferList.length = 0
                totalBufferedDuration = 0
                // 后台继续等待该分句真实合成完毕，绝不跳过该句
                synthRes = await synthPromise
              } else {
                synthRes = raceResult
              }
            } finally {
              if (timer) clearTimeout(timer)
            }
          } else {
            synthRes = await synthPromise
          }
          if (synthRes) {
            if (synthRes.hitCap) {
              toast.warning(t('音频片段过长已自动截断'))
            }
            baseBuffer = synthRes.buffer
          }
        }

        if (activeSessionId !== thisSessionId) {
          return
        }

        if (!baseBuffer || baseBuffer.byteLength === 0) {
          console.warn(`[TTS] 第 ${i + 1} 句合成失败或为空，跳过`)
          if (scheduledSources.length === 0 && readyBufferList.length === 0) {
            // 首句合成失败，说明底层服务不可用或网络异常，立即终止并提示用户
            set({
              status: 'error',
              errorMessage: '语音合成失败，请检查服务连接状态'
            })
            stopProgressMonitor()
            toast.error(t('语音合成失败，请检查服务连接状态'), 4000, 'tts-error')
            return
          }
          continue
        }

        const chunkUint8 = new Uint8Array(baseBuffer)
        cachedChunksMap.set(i, chunkUint8)

        // 异步独立分片落盘（传入 chunkText 确保 manifest 记录 sha256 文本指纹）
        if (window.electronAPI?.tts?.saveChunk) {
          window.electronAPI.tts.saveChunk({
            filePath: options?.filePath,
            fileFingerprint: options?.fileFingerprint,
            fieldName: options?.fieldName,
            displayName: chosenDisplayName,
            voiceId: chosenVoiceId,
            sid: chosenSid,
            speed: chosenSpeed,
            chunkIndex: i,
            totalChunks: chunks.length,
            chunkData: chunkUint8,
            chunkText
          }).catch(err => {
            console.warn('[TTS] 保存独立分片异常:', err)
          })
        }

        // 若当前播放倍率非 1.0x，调用纯 Rust WSOLA 极速算法在内存中（< 2ms）派生目标倍率单句音频
        let playbackBuffer: ArrayBuffer = baseBuffer
        if (Math.abs(chosenSpeed - 1.0) >= 0.01 && window.electronAPI?.tts?.scaleWav) {
          const scaled = await window.electronAPI.tts.scaleWav(baseBuffer, chosenSpeed)
          if (scaled && scaled.byteLength > 44) {
            playbackBuffer = scaled
          }
        }

        if (activeSessionId !== thisSessionId) {
          return
        }

        // Web Audio 解码（复制 ArrayBuffer 防 detach）
        const audioBuffer = await ctx.decodeAudioData(playbackBuffer.slice(0))

        if (activeSessionId !== thisSessionId) {
          return
        }

        if (!isWatermarkSatisfied) {
          // 预缓冲蓄水池入库
          readyBufferList.push({
            index: i,
            buffer: audioBuffer,
            baseBuffer
          })
          totalBufferedDuration += audioBuffer.duration

          // 水线判定：条件 A（达标 2 句）或 条件 B（单句超长 >= 4.0s）或 条件 C（末尾自愈：所有剩余分句已蓄满）
          const satisfiesCount = readyBufferList.length >= Math.min(TTS_BUFFER_WATERMARK.MIN_BUFFERED_CHUNKS, remainingChunksCount)
          const satisfiesDuration = totalBufferedDuration >= TTS_BUFFER_WATERMARK.MIN_BUFFERED_DURATION_SEC
          const satisfiesAllRemaining = readyBufferList.length >= remainingChunksCount

          if (satisfiesCount || satisfiesDuration || satisfiesAllRemaining) {
            isWatermarkSatisfied = true
            flushPrebufferedChunks(readyBufferList, ctx)
            readyBufferList.length = 0
            totalBufferedDuration = 0
          }
        } else {
          // 已放行起播状态：就绪即链式排程追加到硬件时间轴（挂载交叉淡化）
          const startAt = Math.max(ctx.currentTime + 0.05, nextStartTime)
          const { source } = createCrossfadedSource(ctx, audioBuffer, startAt)
          source.start(startAt)

          const effectiveDuration = audioBuffer.duration
          const endAt = startAt + effectiveDuration
          scheduledSources.push({
            source,
            startTime: startAt,
            endTime: endAt,
            index: i,
            isFullAudio: false
          })
          nextStartTime = endAt
        }
      }

      // 兜底放行：若循环结束仍有未起播的缓冲分句，立即原子压入声卡
      if (readyBufferList.length > 0 && activeSessionId === thisSessionId) {
        flushPrebufferedChunks(readyBufferList, ctx)
        readyBufferList.length = 0
      }

      // 标记当前文本所有分句已全部排程入队
      isAllChunksScheduled = true

      // 若所有分句均未成功合成有效音频，给出错误提示
      if (scheduledSources.length === 0 && activeSessionId === thisSessionId) {
        set({
          status: 'error',
          errorMessage: '语音合成未能生成有效音频'
        })
        stopProgressMonitor()
        toast.error(t('语音合成未能生成有效音频，请稍后重试'), 4000, 'tts-error')
      }
    } catch (err: unknown) {
      if (activeSessionId === thisSessionId) {
        console.error('[TTS] 播放调度异常:', err)
        set({
          status: 'error',
          errorMessage: err instanceof Error ? err.message : '语音合成失败'
        })
        stopProgressMonitor()
        toast.error(t('语音合成服务异常，请稍后重试'), 4000, 'tts-error')
      }
    }
  },

  locateAudio: async (options) => {
    let wavPath = get().currentCachePath
    if (!wavPath && window.electronAPI?.tts?.getCachePath) {
      const state = get()
      const targetVoiceId = options?.voiceId ?? state.currentVoiceId
      const matched = getVoiceById(targetVoiceId, state.allVoices)
      wavPath = await window.electronAPI.tts.getCachePath({
        filePath: options?.filePath,
        fileFingerprint: options?.fileFingerprint,
        fieldName: options?.fieldName,
        displayName: matched?.displayName || String(targetVoiceId),
        voiceId: targetVoiceId,
        sid: options?.sid ?? state.currentSid,
        speed: options?.speed ?? state.speed
      })
    }

    if (!wavPath || !window.electronAPI?.tts?.locateWavFile) {
      return false
    }

    return await window.electronAPI.tts.locateWavFile(wavPath)
  },

  exportAudio: async (defaultFileName?: string) => {
    const state = get()
    if (!currentCleanedChunks.length && !cachedChunksMap.size) {
      return null
    }

    const previousStatus = state.status
    set({ status: 'exporting' })

    try {
      const chunksToExport: Uint8Array[] = []
      const voiceId = state.currentVoiceId || String(state.currentSid)

      // 若部分分句尚未合成完成，在后台补齐合成
      for (let i = 0; i < currentCleanedChunks.length; i++) {
        let chunkData = cachedChunksMap.get(i)
        if (!chunkData) {
          const synthRes = await window.electronAPI.tts.synthesizeChunk(
            currentCleanedChunks[i],
            voiceId,
            1.0
          )
          if (synthRes) {
            if (synthRes.hitCap) {
              toast.warning(t('音频片段过长已自动截断'))
            }
            chunkData = new Uint8Array(synthRes.buffer)
            cachedChunksMap.set(i, chunkData)
          }
        }
        if (chunkData) {
          chunksToExport.push(chunkData)
        }
      }

      if (chunksToExport.length === 0) {
        set({ status: previousStatus })
        return null
      }

      const fileName = defaultFileName || `tts-${Date.now()}.wav`
      const savedPath = await window.electronAPI.tts.saveWavFile(fileName, chunksToExport)

      set({ status: previousStatus })
      return savedPath
    } catch (err) {
      console.error('[TTS] 导出音频失败:', err)
      set({ status: previousStatus, errorMessage: '导出音频失败' })
      return null
    }
  },

  seekSentence: async (targetIndex: number) => {
    const state = get()
    if (!state.playingText || !currentCleanedChunks.length) return
    const clampedIndex = Math.max(0, Math.min(targetIndex, currentCleanedChunks.length - 1))

    const ctx = getOrCreateAudioContext()
    if (ctx.state === 'suspended') {
      await ctx.resume()
    }

    const options = currentPlayOptions
    const voiceId = state.currentVoiceId || DEFAULT_VOICE_ID
    const matchedVoice = getVoiceById(voiceId, state.allVoices)
    const displayName = matchedVoice?.displayName || String(voiceId)
    const sid = state.currentSid ?? 63
    const speed = state.speed

    // 1. 若当前文本已具备整段全量缓存文件，直接按字符比例换算时间毫秒级定位起播
    if (state.currentCachePath && window.electronAPI?.tts?.readWavMetadata && window.electronAPI?.tts?.readWavFile) {
      try {
        const metadata = await window.electronAPI.tts.readWavMetadata(state.currentCachePath)
        if (metadata && metadata.completed) {
          const fullWavBuffer = await window.electronAPI.tts.readWavFile(state.currentCachePath)
          if (fullWavBuffer && fullWavBuffer.byteLength > 44) {
            const audioBuffer = await ctx.decodeAudioData(fullWavBuffer.slice(0))
            const totalDuration = audioBuffer.duration

            // 优先读取精准内嵌时间戳索引表 (Cue Table)，实现 0.0000s 误差级绝对精准定位！
            let offset = 0
            if (metadata.chunks && metadata.chunks[clampedIndex] && typeof metadata.chunks[clampedIndex].startTime === 'number') {
              offset = metadata.chunks[clampedIndex].startTime
            } else {
              // 容错降级：按字符累积比例估算时间偏移量
              let totalChars = 0
              for (const c of currentCleanedChunks) {
                totalChars += Math.max(1, c.length)
              }
              let accumulatedChars = 0
              for (let i = 0; i < clampedIndex; i++) {
                accumulatedChars += Math.max(1, currentCleanedChunks[i].length)
              }
              offset = (accumulatedChars / totalChars) * totalDuration
            }
            const clampedOffset = Math.max(0, Math.min(Math.max(0, totalDuration - 0.05), offset))

            clearScheduledSources()
            currentMasterCues = metadata.chunks || null
            currentMasterTotalDuration = totalDuration

            const startAt = ctx.currentTime + 0.02
            const source = ctx.createBufferSource()
            source.buffer = audioBuffer
            source.playbackRate.value = 1.0
            source.connect(ctx.destination)
            source.start(startAt, clampedOffset)

            const remaining = totalDuration - clampedOffset
            scheduledSources.push({
              source,
              startTime: startAt,
              endTime: startAt + remaining,
              index: clampedIndex,
              isFullAudio: true,
              offsetInAudio: clampedOffset
            })
            nextStartTime = startAt + remaining
            isAllChunksScheduled = true

            set({ status: 'playing', currentSentenceIndex: clampedIndex })
            ensureProgressMonitor()
            return
          }
        }
      } catch (err) {
        console.warn('[TTS Seek] 全量音频跳转异常，回退分句流式通道:', err)
      }
    }

    // 2. 分句流式合成模式下的片段跳转与插队优先合成
    const thisSeekSession = ++sessionCounter
    activeSessionId = thisSeekSession
    if (window.electronAPI?.tts?.abortSession) {
      window.electronAPI.tts.abortSession(thisSeekSession - 1).catch(err => {
        console.warn('[TTS Seek] 中止前序会话异常:', err)
      })
    }

    clearScheduledSources()
    nextStartTime = 0
    isAllChunksScheduled = false
    toast.info(t('该片段正在合成中，请稍候...'), 3000, 'tts-seek-loading')
    set({ currentSentenceIndex: clampedIndex, status: 'loading' })

    const readyBufferList: PrebufferedChunkItem[] = []
    let totalBufferedDuration = 0
    const remainingChunksCount = Math.max(1, currentCleanedChunks.length - clampedIndex)
    let isWatermarkSatisfied = false

    ;(async () => {
      for (let i = clampedIndex; i < currentCleanedChunks.length; i++) {
        if (activeSessionId !== thisSeekSession) return
        const chunkText = currentCleanedChunks[i]
        let baseBuffer: ArrayBuffer | null = null

        // 优先检查内存缓存与磁盘分片缓存（传递 chunkText 确保防错位）
        const cached = cachedChunksMap.get(i)
        if (cached) {
          baseBuffer = cached.buffer.slice(
            cached.byteOffset,
            cached.byteOffset + cached.byteLength
          ) as ArrayBuffer
        } else if (window.electronAPI?.tts?.readChunk) {
          const diskChunk = await window.electronAPI.tts.readChunk({
            filePath: options?.filePath,
            fileFingerprint: options?.fileFingerprint,
            fieldName: options?.fieldName,
            displayName,
            voiceId,
            chunkIndex: i,
            chunkText
          })
          if (diskChunk && diskChunk.byteLength > 44) {
            baseBuffer = diskChunk
          }
        }

        if (!baseBuffer) {
          const synthPromise = window.electronAPI.tts.synthesizeChunk(
            chunkText,
            voiceId,
            1.0,
            thisSeekSession,
            sid
          )

          let synthRes: { buffer: ArrayBuffer; hitCap: boolean; steps: number } | null = null
          // 若起播门禁尚未放行且蓄水池已具备首句，注入 8000ms 超时门禁探测
          if (!isWatermarkSatisfied && readyBufferList.length > 0) {
            let timer: ReturnType<typeof setTimeout> | undefined
            try {
              const timeoutPromise = new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), TTS_BUFFER_WATERMARK.CHUNK_SYNTHESIZE_TIMEOUT_MS)
              })
              const raceResult = await Promise.race([synthPromise, timeoutPromise])

              if (raceResult === null) {
                console.warn('[TTS Seek] 预缓冲后续分句等待超时(>8000ms)，降级以首句立即放行起播')
                isWatermarkSatisfied = true
                flushPrebufferedChunks(readyBufferList, ctx)
                readyBufferList.length = 0
                totalBufferedDuration = 0
                synthRes = await synthPromise
              } else {
                synthRes = raceResult
              }
            } finally {
              if (timer) clearTimeout(timer)
            }
          } else {
            synthRes = await synthPromise
          }
          if (synthRes) {
            if (synthRes.hitCap) {
              toast.warning(t('音频片段过长已自动截断'))
            }
            baseBuffer = synthRes.buffer
          }
        }

        if (activeSessionId !== thisSeekSession) return
        if (!baseBuffer || baseBuffer.byteLength === 0) {
          if (scheduledSources.length === 0 && readyBufferList.length === 0) {
            toast.error(t('该片段合成失败，请稍后重试'), 3500, 'tts-seek-loading')
            set({ status: 'idle' })
            return
          }
          continue
        }

        const chunkUint8 = new Uint8Array(baseBuffer)
        cachedChunksMap.set(i, chunkUint8)

        // 异步分片独立落盘（传入 chunkText 确保防错位）
        if (window.electronAPI?.tts?.saveChunk) {
          window.electronAPI.tts.saveChunk({
            filePath: options?.filePath,
            fileFingerprint: options?.fileFingerprint,
            fieldName: options?.fieldName,
            displayName,
            voiceId,
            sid,
            speed,
            chunkIndex: i,
            totalChunks: currentCleanedChunks.length,
            chunkData: chunkUint8,
            chunkText
          }).catch(err => {
            console.warn('[TTS Seek] 异步保存分片异常:', err)
          })
        }

        // 目标倍率 WSOLA 派生
        let playbackBuffer: ArrayBuffer = baseBuffer
        if (Math.abs(speed - 1.0) >= 0.01 && window.electronAPI?.tts?.scaleWav) {
          const scaled = await window.electronAPI.tts.scaleWav(baseBuffer, speed)
          if (scaled && scaled.byteLength > 44) {
            playbackBuffer = scaled
          }
        }

        if (activeSessionId !== thisSeekSession) return
        const audioBuffer = await ctx.decodeAudioData(playbackBuffer.slice(0))
        if (activeSessionId !== thisSeekSession) return

        if (!isWatermarkSatisfied) {
          readyBufferList.push({
            index: i,
            buffer: audioBuffer,
            baseBuffer
          })
          totalBufferedDuration += audioBuffer.duration

          // 水线判定：条件 A（达标 2 句）或 条件 B（单句超长 >= 4.0s）或 条件 C（末尾自愈：所有剩余分句已蓄满）
          const satisfiesCount = readyBufferList.length >= Math.min(TTS_BUFFER_WATERMARK.MIN_BUFFERED_CHUNKS, remainingChunksCount)
          const satisfiesDuration = totalBufferedDuration >= TTS_BUFFER_WATERMARK.MIN_BUFFERED_DURATION_SEC
          const satisfiesAllRemaining = readyBufferList.length >= remainingChunksCount

          if (satisfiesCount || satisfiesDuration || satisfiesAllRemaining) {
            isWatermarkSatisfied = true
            flushPrebufferedChunks(readyBufferList, ctx)
            readyBufferList.length = 0
            totalBufferedDuration = 0
          }
        } else {
          // 已起播：就绪即链式排程追加（挂载交叉淡化）
          const nextStartAt = Math.max(ctx.currentTime + 0.05, nextStartTime)
          const { source: nextSource } = createCrossfadedSource(ctx, audioBuffer, nextStartAt)
          nextSource.start(nextStartAt)

          const nextEndAt = nextStartAt + audioBuffer.duration
          scheduledSources.push({
            source: nextSource,
            startTime: nextStartAt,
            endTime: nextEndAt,
            index: i,
            isFullAudio: false
          })
          nextStartTime = nextEndAt
        }
      }

      if (readyBufferList.length > 0 && activeSessionId === thisSeekSession) {
        flushPrebufferedChunks(readyBufferList, ctx)
        readyBufferList.length = 0
      }
      isAllChunksScheduled = true
    })().catch(err => {
      console.warn('[TTS Seek] 后续分句流式排程异常:', err)
    })
  }
}))

// 渲染进程启动时自动异步预热拉取全量音色（含自定义音色）
if (typeof window !== 'undefined') {
  setTimeout(() => {
    useTTSAudioStore.getState().refreshVoices().catch(() => {})
  }, 0)
}

