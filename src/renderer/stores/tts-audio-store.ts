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
  /** 当前发音人 Speaker ID */
  currentSid: number
  /** 当前播放语速 */
  speed: number
  /** 当前音频落盘缓存的绝对路径 */
  currentCachePath: string | null
  /** 错误信息 */
  errorMessage: string | null

  /** 播放/暂停切换 */
  play: (
    text: string,
    options?: {
      textId?: string
      filePath?: string
      fileFingerprint?: string
      fieldName?: string
      sid?: number
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
  /** 切换发音人 */
  setSid: (sid: number) => void
  /** 切换语速 */
  setSpeed: (speed: number) => void
  /** 在系统文件管理器中定位音频文件 */
  locateAudio: (options?: {
    filePath?: string
    fileFingerprint?: string
    fieldName?: string
    sid?: number
    speed?: number
  }) => Promise<boolean>
  /** 导出整段音频为本地 WAV 文件（向后兼容保留） */
  exportAudio: (defaultFileName?: string) => Promise<string | null>
}

// 内部闭包全局运行时实例
let audioContext: AudioContext | null = null
let sessionCounter = 0
let activeSessionId = 0
let nextStartTime = 0
let scheduledSources: Array<{ source: AudioBufferSourceNode; startTime: number; endTime: number; index: number }> = []
let cachedChunksMap = new Map<number, Uint8Array>() // chunkIndex -> Uint8Array
let currentCleanedChunks: string[] = []
let progressTimer: ReturnType<typeof setInterval> | null = null

function getOrCreateAudioContext(): AudioContext {
  if (!audioContext || audioContext.state === 'closed') {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
    audioContext = new AudioCtx({ sampleRate: 24000 })
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
}

function stopProgressMonitor(): void {
  if (progressTimer) {
    clearInterval(progressTimer)
    progressTimer = null
  }
}

export const useTTSAudioStore = create<TTSAudioState>()((set, get) => ({
  playingText: '',
  playingTextId: '',
  status: 'idle',
  currentSentenceIndex: 0,
  totalSentences: 0,
  currentSid: 44, // 默认小贝
  speed: 1.0,
  currentCachePath: null,
  errorMessage: null,

  setSid: (sid: number) => {
    set({ currentSid: sid })
    useConfigStore.getState().updateConfigValue('TTS_DEFAULT_VOICE_SID', sid).catch(() => {})
  },

  setSpeed: (speed: number) => {
    set({ speed })
    useConfigStore.getState().updateConfigValue('TTS_SPEED', speed).catch(() => {})

    // 若当前正在播放，以用户选定的新语速重新合成与播放，确保由神经网络声学模型原生调速，杜绝变调童音
    const state = get()
    if (state.status === 'playing' || state.status === 'loading') {
      const currentText = state.playingText
      const currentTextId = state.playingTextId
      const currentSid = state.currentSid
      if (currentText) {
        get().play(currentText, {
          textId: currentTextId,
          sid: currentSid,
          speed: speed
        })
      }
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
      progressTimer = setInterval(() => {
        if (!audioContext) return
        const now = audioContext.currentTime
        const active = scheduledSources.find(s => now >= s.startTime && now < s.endTime)
        if (active && active.index !== get().currentSentenceIndex) {
          set({ currentSentenceIndex: active.index })
        }
        if (scheduledSources.length > 0 && now >= nextStartTime) {
          get().stop()
        }
      }, 100)
    }
  },

  stop: async () => {
    stopProgressMonitor()
    clearScheduledSources()
    const sidToAbort = activeSessionId
    activeSessionId = ++sessionCounter
    nextStartTime = 0

    if (window.electronAPI?.tts?.abortSession) {
      window.electronAPI.tts.abortSession(sidToAbort).catch(() => {})
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

    // 1. 同文本ID且同一朗读内容、正在播放 -> 暂停
    if (state.status === 'playing' && state.playingTextId === targetTextId && state.playingText === text) {
      await state.pause()
      return
    }

    // 2. 同文本ID且同一朗读内容、已暂停 -> 恢复
    if (state.status === 'paused' && state.playingTextId === targetTextId && state.playingText === text) {
      await state.resume()
      return
    }

    // 3. 全新文本播放或切播：彻底中止前序任务
    await state.stop()

    const thisSessionId = ++sessionCounter
    activeSessionId = thisSessionId

    // 获取配置默认音色与语速
    const config = useConfigStore.getState().config
    const chosenSid = options?.sid !== undefined ? options.sid : (config?.ttsDefaultVoiceSid ?? 44)
    const chosenSpeed = options?.speed !== undefined ? options.speed : (config?.ttsSpeed ?? 1.0)

    // 文本清洗与分句切片
    const cleaned = cleanTextForTTS(text, { isLrc: options?.isLrc })
    const chunks = splitTextIntoChunks(cleaned)

    if (chunks.length === 0) {
      set({ status: 'idle', errorMessage: '没有可朗读的有效文本内容' })
      return
    }

    currentCleanedChunks = chunks
    cachedChunksMap.clear()

    // 计算本地磁盘缓存目标路径（传入 text，纯文本/试听例句变化时指纹实时变化）
    let targetCachePath: string | null = null
    if (window.electronAPI?.tts?.getCachePath) {
      try {
        targetCachePath = await window.electronAPI.tts.getCachePath({
          filePath: options?.filePath,
          fileFingerprint: options?.fileFingerprint,
          fieldName: options?.fieldName,
          text: text,
          sid: chosenSid,
          speed: chosenSpeed
        })
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
    progressTimer = setInterval(() => {
      if (!audioContext) return
      const now = audioContext.currentTime
      const active = scheduledSources.find(s => now >= s.startTime && now < s.endTime)
      if (active && active.index !== get().currentSentenceIndex) {
        set({ currentSentenceIndex: active.index })
      }
      // 全部播放完毕检测
      if (
        scheduledSources.length > 0 &&
        now >= nextStartTime &&
        get().status === 'playing'
      ) {
        get().stop()
      }
    }, 80)

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
              index: 0
            })

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

      // 检查是否存在断点
      if (targetCachePath && window.electronAPI?.tts?.readWavMetadata) {
        try {
          const meta = await window.electronAPI.tts.readWavMetadata(targetCachePath)
          if (meta && !meta.completed && meta.done > 0 && meta.done < chunks.length) {
            const partialBuf = await window.electronAPI.tts.readWavFile(targetCachePath)
            if (partialBuf && partialBuf.byteLength > 44) {
              const partialAudio = await ctx.decodeAudioData(partialBuf.slice(0))
              if (activeSessionId === thisSessionId) {
                const source = ctx.createBufferSource()
                source.buffer = partialAudio
                source.playbackRate.value = chosenSpeed
                source.connect(ctx.destination)

                const startAt = Math.max(ctx.currentTime + 0.05, nextStartTime)
                source.start(startAt)
                const effectiveDuration = partialAudio.duration / chosenSpeed
                nextStartTime = startAt + effectiveDuration
                scheduledSources.push({
                  source,
                  startTime: startAt,
                  endTime: nextStartTime,
                  index: 0
                })
                set({ status: 'playing' })
                startIndex = meta.done
              }
            }
          }
        } catch (e) {
          console.warn('[TTS] 断点恢复异常，从首句合成:', e)
        }
      }

      for (let i = startIndex; i < chunks.length; i++) {
        if (activeSessionId !== thisSessionId) {
          // 会话已被中止
          return
        }

        const chunkText = chunks[i]
        // 关键声学设计：由 Kokoro 神经网络声学模型在生成阶段原生调速（变速不变调），
        // 彻底杜绝播放端倍率重采样导致的音调上扬（变调童音/花栗鼠效应）
        const buffer = await window.electronAPI.tts.synthesizeChunk(
          chunkText,
          chosenSid,
          chosenSpeed,
          thisSessionId
        )

        if (activeSessionId !== thisSessionId) {
          return
        }

        if (!buffer || buffer.byteLength === 0) {
          console.warn(`[TTS] 第 ${i + 1} 句合成失败或为空，跳过`)
          continue
        }

        const chunkUint8 = new Uint8Array(buffer)
        // 缓存 WAV 原始块
        cachedChunksMap.set(i, chunkUint8)

        // 异步流式追加写入本地 WAV 缓存并原子刷新 meta Chunk（标记对应倍率）
        if (targetCachePath && window.electronAPI?.tts?.appendWavChunk) {
          window.electronAPI.tts.appendWavChunk({
            wavPath: targetCachePath,
            chunkData: chunkUint8,
            chunkIndex: i,
            totalChunks: chunks.length,
            sid: chosenSid,
            speed: chosenSpeed,
            fileFingerprint: options?.fileFingerprint,
            fieldName: options?.fieldName
          }).catch(err => {
            console.warn('[TTS] 追加写入本地音频失败:', err)
          })
        }

        // Web Audio 解码（复制 ArrayBuffer 防 detach）
        const audioBuffer = await ctx.decodeAudioData(buffer.slice(0))

        if (activeSessionId !== thisSessionId) {
          return
        }

        // 时间戳预排程播放（由于模型已原生变速且音调正常，此处 playbackRate 恒定为 1.0 忠实原音输出）
        const source = ctx.createBufferSource()
        source.buffer = audioBuffer
        source.playbackRate.value = 1.0
        source.connect(ctx.destination)

        const startAt = Math.max(ctx.currentTime + 0.05, nextStartTime)
        source.start(startAt)

        const effectiveDuration = audioBuffer.duration
        const endAt = startAt + effectiveDuration
        scheduledSources.push({
          source,
          startTime: startAt,
          endTime: endAt,
          index: i
        })
        nextStartTime = endAt

        // 首句成功排程后立即进入 playing 状态
        if (get().status === 'loading') {
          set({ status: 'playing' })
        }
      }
    } catch (err: unknown) {
      if (activeSessionId === thisSessionId) {
        console.error('[TTS] 播放调度异常:', err)
        set({
          status: 'error',
          errorMessage: err instanceof Error ? err.message : '语音合成失败'
        })
        stopProgressMonitor()
      }
    }
  },

  locateAudio: async (options) => {
    let wavPath = get().currentCachePath
    if (!wavPath && window.electronAPI?.tts?.getCachePath) {
      wavPath = await window.electronAPI.tts.getCachePath({
        filePath: options?.filePath,
        fileFingerprint: options?.fileFingerprint,
        fieldName: options?.fieldName,
        sid: options?.sid ?? get().currentSid,
        speed: options?.speed ?? get().speed
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
      const sid = state.currentSid
      const speed = state.speed

      // 若部分分句尚未合成完成，在后台补齐合成
      for (let i = 0; i < currentCleanedChunks.length; i++) {
        let chunkData = cachedChunksMap.get(i)
        if (!chunkData) {
          const buf = await window.electronAPI.tts.synthesizeChunk(
            currentCleanedChunks[i],
            sid,
            1.0
          )
          if (buf) {
            chunkData = new Uint8Array(buf)
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
  }
}))

