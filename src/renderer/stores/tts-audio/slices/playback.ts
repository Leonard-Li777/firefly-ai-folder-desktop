import { toast } from '../../../components/common/Toast'
import { getVoiceById, DEFAULT_VOICE_ID } from '../../../constants/tts-voices'
import { cleanTextForTTS, splitTextIntoChunks } from '../../../lib/text-chunker'
import { useConfigStore } from '../../config-store'
import { useSettingsStore } from '../../settings-store'
import {
  createCrossfadedSource,
  flushPrebufferedChunks,
  getOrCreateAudioContext,
  clearScheduledSources,
  stopProgressMonitor
} from '../audio-engine'
import { TTS_BUFFER_WATERMARK } from '../constants'
import { triggerHotSwitch } from '../hot-switch'
import { hasActiveTTSPlugin, getActiveTTSPluginId } from '../plugin'
import { ensureProgressMonitor } from '../progress'
import { rt } from '../runtime'
import { launchStreamingSession } from '../streaming'
import { safeSynthesizeChunk } from '../synthesize'
import type { TTSAudioState, PrebufferedChunkItem, TTSStoreSet, TTSStoreGet } from '../types'
import { t } from '@app/languages'

export function createPlaybackSlice(set: TTSStoreSet, get: TTSStoreGet): Partial<TTSAudioState> {
  return {
    playingText: '',
    playingTextId: '',
    status: 'idle',
    currentSentenceIndex: 0,
    totalSentences: 0,

    currentCachePath: null,
    // 播放源信息：状态接口已声明为必填（string | null），初始态二者尚未指向任何文件
    currentFilePath: null,
    currentTitle: null,
    currentRealName: null,
    errorMessage: null,

    bufferedDuration: 0,
    targetBufferDuration: TTS_BUFFER_WATERMARK.MIN_BUFFERED_DURATION_SEC,
    isSynthesizing: false,

    pause: async () => {
      if (rt.currentStreamingPlayer) {
        rt.currentStreamingPlayer.pause()
        stopProgressMonitor()
        set({ status: 'paused' })
        return
      }
      if (rt.audioContext && rt.audioContext.state === 'running') {
        await rt.audioContext.suspend()
        stopProgressMonitor()
        set({ status: 'paused' })
      }
    },

    resume: async () => {
      if (rt.currentStreamingPlayer) {
        await rt.currentStreamingPlayer.resume()
        set({ status: 'playing' })
        ensureProgressMonitor()
        return
      }
      if (rt.audioContext && rt.audioContext.state === 'suspended') {
        await rt.audioContext.resume()
        set({ status: 'playing' })

        // 重启进度监控
        ensureProgressMonitor()
      }
    },

    stop: async () => {
      if (rt.currentStreamingPlayer) {
        rt.currentStreamingPlayer.stop()
        rt.currentStreamingPlayer = null
      }
      rt.activeStreamCleanups.forEach(fn => fn())
      rt.activeStreamCleanups = []

      rt.isHotSwitchInProgress = false
      stopProgressMonitor()
      clearScheduledSources()
      rt.isAllChunksScheduled = false
      rt.activeSynthesizingCount = 0
      rt.hotSwitchCounter++
      rt.currentPlayOptions = undefined
      const sidToAbort = rt.activeSessionId
      rt.activeSessionId = ++rt.sessionCounter
      rt.nextStartTime = 0

      if (window.electronAPI?.tts?.abortSession) {
        window.electronAPI.tts.abortSession(sidToAbort).catch(err => {
          console.warn('[TTS Stop] 中止会话异常:', err)
        })
      }

      set({
        status: 'idle',
        playingText: '',
        playingTextId: '',
        currentFilePath: null,
        currentTitle: null,
        currentRealName: null,
        currentSentenceIndex: 0,
        totalSentences: 0,
        errorMessage: null,
        bufferedDuration: 0,
        isSynthesizing: false
      })
    },

    play: async (text: string, options) => {
      // 0. 前置安全门禁：未安装或未激活任何 TTS 插件时，系统能正确跳过业务逻辑，绝不阻断，杜绝错误
      if (!hasActiveTTSPlugin()) {
        console.warn('[useTTSAudioStore] 当前未安装或未激活任何 TTS 插件，安全跳过播放')
        return
      }

      const state = get()
      const targetTextId = options?.textId || text

      // 1. 同文本ID且同一朗读内容、且音色与语速均未改变时：
      //    - 正在播放 -> 暂停
      //    - 已暂停 -> 恢复
      const isVoiceChanged =
        options?.voiceId !== undefined && options.voiceId !== state.currentVoiceId
      const isSpeedChanged =
        options?.speed !== undefined && Math.abs(options.speed - state.speed) >= 0.01

      const isAuditionMode =
        targetTextId.startsWith('audition-') ||
        options?.fieldName === 'audition' ||
        options?.fileFingerprint === 'preview'

      if (!isVoiceChanged && !isSpeedChanged) {
        if (
          state.status === 'playing' &&
          state.playingTextId === targetTextId &&
          state.playingText === text
        ) {
          await state.pause()
          return
        }

        if (
          state.status === 'paused' &&
          state.playingTextId === targetTextId &&
          state.playingText === text
        ) {
          await state.resume()
          return
        }
      } else if (
        !isAuditionMode &&
        (state.status === 'playing' || state.status === 'loading' || state.status === 'paused')
      ) {
        // 若当前正在播放长文章但改变了音色或倍速，走平滑热切无缝接续当前阅读进度（试听场景除外，试听必须从头独立完整发音）
        const oldSpeed = state.speed
        if (options?.voiceId !== undefined) {
          const matched = getVoiceById(options.voiceId, get().allVoices)
          set({ currentVoiceId: options.voiceId, currentSid: matched?.sid ?? 63 })
        }
        if (options?.speed !== undefined) {
          set({ speed: options.speed })
        }
        rt.currentPlayOptions = options
        triggerHotSwitch({
          voiceId: options?.voiceId,
          sid: options?.sid,
          speed: options?.speed,
          oldSpeed
        })
        return
      }

      // 2. 全新文本播放或切播：彻底中止前序任务
      await state.stop()
      rt.currentPlayOptions = options

      const thisSessionId = ++rt.sessionCounter
      rt.activeSessionId = thisSessionId

      // 获取配置默认音色与语速
      const config = useSettingsStore.getState().config || useConfigStore.getState().config
      const chosenVoiceId =
        options?.voiceId !== undefined
          ? String(options.voiceId)
          : options?.sid !== undefined
            ? String(options.sid)
            : String(
                (config as any)?.ttsDefaultVoiceId ||
                  (config as any)?.ttsDefaultVoiceSid ||
                  DEFAULT_VOICE_ID
              )
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
      const chosenSpeed =
        options?.speed !== undefined ? options.speed : ((config as any)?.ttsSpeed ?? 1.0)

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
        set({
          status: 'idle',
          currentFilePath: null,
          currentTitle: null,
          currentRealName: null,
          errorMessage: t('没有可朗读的有效文本内容')
        })
        return
      }

      rt.currentCleanedChunks = chunks
      rt.cachedChunksMap.clear()

      // 派生当前播放标题与路径（优先 options.title，若有 filePath 并行预取 smart_name，降级取 basename）
      const activeFilePath = options?.filePath || null
      let activeTitle = options?.title ? options.title.trim() : ''
      let activeRealName: string | null = null
      let smartNamePromise: Promise<{ title: string; realName: string | null }> | null = null
      if (!activeTitle) {
        if (activeFilePath) {
          // 先以物理文件名兜底
          activeTitle = activeFilePath.split(/[\\/]/).pop() || ''
          // 并行预取智能文件名（与下方 getCachePath IPC 并行发起，set() 前汇合原子上屏，
          // 杜绝 fire-and-forget 回查在 set() 前 resolve 时被 currentFilePath 尚为 null 的守卫静默丢弃，
          // 导致播放条永久显示物理 basename 的竞态缺陷）
          if (window.electronAPI?.getFileAnalysisResult) {
            smartNamePromise = window.electronAPI
              .getFileAnalysisResult(activeFilePath)
              .then(res => ({
                // smart_name 优先作为展示名，未收录时降级物理文件名
                title: res?.smartName?.trim() || activeTitle,
                realName: res?.name || null
              }))
              .catch(err => {
                // 显式上报降级原因，严禁静默吞异常（§2.9 禁止静默降级）
                console.warn('[TTS] 预取智能文件名失败，降级物理文件名:', err)
                return { title: activeTitle, realName: null }
              })
          }
        } else if (text && text.trim()) {
          activeTitle = text.trim().replace(/\s+/g, ' ')
        }
      }

      // 解析发音人显示名称与本地磁盘缓存目标路径（传入 text，纯文本/试听例句变化时指纹实时变化）
      const isAudition =
        options?.textId?.startsWith('audition-') || options?.fieldName === 'audition'
      const targetFingerprint = isAudition ? 'preview' : options?.fileFingerprint
      const targetFieldName = isAudition ? 'audition' : options?.fieldName
      const chosenDisplayName =
        options?.displayName || matchedVoice?.displayName || String(chosenVoiceId)
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

      // 汇合智能文件名预取结果（与 getCachePath 并行发起，此处原子上屏）：
      // 会话守卫防止 await 期间切歌/停止后，本旧会话结果覆盖新会话标题
      if (smartNamePromise) {
        const smartResult = await smartNamePromise
        if (rt.activeSessionId !== thisSessionId) return
        activeTitle = smartResult.title
        activeRealName = smartResult.realName
      }

      set({
        playingText: text,
        playingTextId: targetTextId,
        currentFilePath: activeFilePath,
        currentTitle: activeTitle || null,
        currentRealName: activeRealName,
        status: 'loading',
        currentSentenceIndex: 0,
        totalSentences: chunks.length,
        currentSid: chosenSid,
        currentVoiceId: chosenVoiceId,
        speed: chosenSpeed,
        currentCachePath: targetCachePath,
        errorMessage: null,
        bufferedDuration: 0,
        targetBufferDuration: TTS_BUFFER_WATERMARK.MIN_BUFFERED_DURATION_SEC
      })

      const ctx = getOrCreateAudioContext()
      if (ctx.state === 'suspended') {
        await ctx.resume()
      }
      rt.nextStartTime = ctx.currentTime

      // 启动进度轮询监测
      ensureProgressMonitor()

      // 4. 检查本地磁盘缓存：若已全部完成，直接读取完整本地 WAV 秒播；若未完成，提取断点支持断点续录续播
      let resumeCharStart = 0
      let prefillWavBuffer: ArrayBuffer | null = null

      if (targetCachePath && window.electronAPI?.tts?.readWavMetadata) {
        try {
          const metadata = await window.electronAPI.tts.readWavMetadata(targetCachePath)
          const isSpeedMatched =
            metadata?.speed === undefined || Math.abs(metadata.speed - chosenSpeed) < 0.01

          const hasValidSamples =
            typeof metadata?.totalSamples === 'number' ? metadata.totalSamples > 0 : true

          // 判定全量已完成：metadata 显式标记 completed，或者已合成字符覆盖全文，或分句数完全匹配（严禁单凭 total === 1 盲判）
          const isFullCompleted = Boolean(
            metadata &&
            isSpeedMatched &&
            hasValidSamples &&
            (metadata.completed === true ||
              (typeof metadata.doneCharEnd === 'number' && metadata.doneCharEnd >= text.length) ||
              (metadata.total > 1 &&
                metadata.total === chunks.length &&
                metadata.done === chunks.length))
          )

          // (1) 完整秒播：已全量完成且语速匹配，直接读取完整本地 WAV 秒播
          if (isFullCompleted) {
            const fullWavBuffer = await window.electronAPI.tts.readWavFile(targetCachePath)
            if (fullWavBuffer && fullWavBuffer.byteLength > 44) {
              if (rt.activeSessionId !== thisSessionId) return

              const audioBuffer = await ctx.decodeAudioData(fullWavBuffer.slice(0))
              if (rt.activeSessionId !== thisSessionId) return

              // 严密防线：若解码后的时长大于 0.2 秒，才作为合法母带立即秒播，否则平滑降级断点/流式通道
              if (audioBuffer.duration > 0.2) {
                clearScheduledSources()
                if (rt.currentStreamingPlayer) {
                  rt.currentStreamingPlayer.stop()
                  rt.currentStreamingPlayer = null
                }
                rt.currentMasterCues = metadata.chunks || null
                rt.currentMasterTotalDuration = audioBuffer.duration

                const source = ctx.createBufferSource()
                source.buffer = audioBuffer
                source.playbackRate.value = 1.0
                source.connect(ctx.destination)

                const startAt = Math.max(ctx.currentTime + 0.05, rt.nextStartTime)
                source.start(startAt)
                const effectiveDuration = audioBuffer.duration
                rt.nextStartTime = startAt + effectiveDuration
                rt.scheduledSources.push({
                  source,
                  startTime: startAt,
                  endTime: rt.nextStartTime,
                  index: 0,
                  isFullAudio: true,
                  offsetInAudio: 0
                })

                rt.isAllChunksScheduled = true
                set({ status: 'playing' })
                return
              }
            }
          }

          // (2) 断点续录与断点续播：未完成合成，但本地已存在部分合法音频且记录了断点进度
          if (
            metadata &&
            !isFullCompleted &&
            isSpeedMatched &&
            ((typeof metadata.doneCharEnd === 'number' && metadata.doneCharEnd > 0) ||
              (typeof metadata.totalSamples === 'number' && metadata.totalSamples > 0))
          ) {
            try {
              const partialBuffer = await window.electronAPI.tts.readWavFile(targetCachePath)
              if (partialBuffer && partialBuffer.byteLength > 44) {
                prefillWavBuffer = partialBuffer
                if (typeof metadata.doneCharEnd === 'number' && metadata.doneCharEnd > 0) {
                  resumeCharStart = Math.min(metadata.doneCharEnd, text.length)
                } else if (metadata.chunks && metadata.chunks.length > 0) {
                  const lastChunkIdx = metadata.chunks[metadata.chunks.length - 1].index
                  let accChars = 0
                  for (let i = 0; i <= Math.min(lastChunkIdx, chunks.length - 1); i++) {
                    accChars += chunks[i].length
                  }
                  resumeCharStart = Math.min(accChars, text.length)
                }
                console.info(
                  `[TTS] 🎯 命中本地未完成音频断点: resumeCharStart=${resumeCharStart}/${text.length}, 已有音频=${((partialBuffer.byteLength - 44) / 48000).toFixed(2)}s, 启动前缀秒播与后台断点续录`
                )
              }
            } catch (pErr) {
              console.warn('[TTS] 读取断点前置音频异常:', pErr)
            }
          }
        } catch (cacheErr) {
          console.warn('[TTS] 读取本地缓存异常，回退流式合成:', cacheErr)
        }
      }

      // 5. 纯流式通道优先尝试 (Scheme B - M5 Pure Streaming: 首包 ~120ms 发声，TTFS 降至 0.8s)
      // 只要系统暴露了 startStream 且发音人属于 M5/预置音色或 M5 为激活引擎，一律优先流式建连
      const isM5Voice =
        !chosenVoiceId ||
        String(chosenVoiceId).includes('m5') ||
        String(chosenVoiceId).startsWith('preset_') ||
        String(chosenVoiceId).includes('azure_') ||
        getActiveTTSPluginId() === 'tts_m5_onnx'

      if (isM5Voice && typeof (window.electronAPI as any)?.tts?.startStream === 'function') {
        console.info(
          `[TTS] 命中极速语音合成与朗读纯流式会话通道 (voiceId=${chosenVoiceId})，发起 stream-start...`
        )
        const launched = await launchStreamingSession({
          sessionId: thisSessionId,
          text,
          voiceId: String(chosenVoiceId),
          speed: chosenSpeed,
          resumeCharStart,
          initialSentenceIndex: 0,
          chunks,
          targetCachePath: targetCachePath || undefined,
          filePath: options?.filePath,
          fileFingerprint: targetFingerprint,
          fieldName: targetFieldName,
          displayName: chosenDisplayName,
          prefillWavBuffer,
          prefillCharStart: 0,
          prefillCharEnd: resumeCharStart
        })
        if (launched) {
          return
        }
        console.warn('[TTS] 启动纯流式通道失败，平滑降级至分片合成模式')
      }

      // 6. 流式合成调度循环 (Scheme A 传统分片降级路线)
      try {
        const startIndex = 0

        // 预缓冲安全水线蓄水池
        const readyBufferList: PrebufferedChunkItem[] = []
        let totalBufferedDuration = 0
        const remainingChunksCount = Math.max(1, chunks.length - startIndex)
        let isWatermarkSatisfied = false

        for (let i = startIndex; i < chunks.length; i++) {
          if (rt.activeSessionId !== thisSessionId) {
            // 会话已被中止
            return
          }

          const chunkText = chunks[i]
          let baseBuffer: ArrayBuffer | null = null

          // 优先检查内存缓存与磁盘分片缓存（传递 chunkText 确保防错位校验）
          const cachedMem = rt.cachedChunksMap.get(i)
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
            const synthRes = await safeSynthesizeChunk(
              chunkText,
              chosenVoiceId,
              1.0,
              thisSessionId,
              chosenSid
            )
            if (synthRes) {
              if (synthRes.hitCap) {
                toast.warning(t('音频片段过长已自动截断'))
              }
              baseBuffer = synthRes.buffer
            }
          }

          if (rt.activeSessionId !== thisSessionId) {
            return
          }

          if (!baseBuffer || baseBuffer.byteLength === 0) {
            console.warn(`[TTS] 第 ${i + 1} 句合成失败或为空，跳过`)
            if (rt.scheduledSources.length === 0 && readyBufferList.length === 0) {
              // 首句合成失败，说明底层服务不可用或网络异常，立即终止并提示用户
              set({
                status: 'error',
                currentFilePath: null,
                currentTitle: null,
                currentRealName: null,
                errorMessage: t('语音合成失败，请检查服务连接状态')
              })
              stopProgressMonitor()
              toast.error(t('语音合成失败，请检查服务连接状态'), 4000, 'tts-error')
              return
            }
            continue
          }

          const chunkUint8 = new Uint8Array(baseBuffer)
          rt.cachedChunksMap.set(i, chunkUint8)

          // 异步独立分片落盘（传入 chunkText 确保 manifest 记录 sha256 文本指纹）
          if (window.electronAPI?.tts?.saveChunk) {
            window.electronAPI.tts
              .saveChunk({
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
              })
              .catch(err => {
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

          if (rt.activeSessionId !== thisSessionId) {
            return
          }

          // Web Audio 解码（复制 ArrayBuffer 防 detach）
          const audioBuffer = await ctx.decodeAudioData(playbackBuffer.slice(0))

          if (rt.activeSessionId !== thisSessionId) {
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
            set({ bufferedDuration: totalBufferedDuration })

            // 水线判定：
            // 1. 首句极速起播（Fast First Playback）：首句只要就绪且时长 >= 1.0s，立即起播！绝不死等后续分句！
            // 2. 末尾自愈：所有剩余分句已蓄满，短文本 1 句直接放行
            // 3. 多句安全水线：蓄满 >= 2 句且总时长达标
            const isFirstChunkReady =
              readyBufferList.length >= 1 &&
              readyBufferList[0].index === startIndex &&
              readyBufferList[0].buffer.duration >= 1.0
            const isLastRemaining = readyBufferList.length >= remainingChunksCount
            const satisfiesSafetyWatermark =
              readyBufferList.length >=
                Math.min(TTS_BUFFER_WATERMARK.MIN_BUFFERED_CHUNKS, remainingChunksCount) &&
              totalBufferedDuration >= TTS_BUFFER_WATERMARK.MIN_BUFFERED_DURATION_SEC

            if (isFirstChunkReady || isLastRemaining || satisfiesSafetyWatermark) {
              isWatermarkSatisfied = true
              flushPrebufferedChunks(readyBufferList, ctx)
              readyBufferList.length = 0
              totalBufferedDuration = 0
              set({ bufferedDuration: 0 })
            }
          } else {
            // 已放行起播状态：就绪即链式排程追加到硬件时间轴（挂载交叉淡化）
            const startAt = Math.max(ctx.currentTime + 0.05, rt.nextStartTime)
            const { source } = createCrossfadedSource(ctx, audioBuffer, startAt)
            source.start(startAt)

            const effectiveDuration = audioBuffer.duration
            const endAt = startAt + effectiveDuration
            rt.scheduledSources.push({
              source,
              startTime: startAt,
              endTime: endAt,
              index: i,
              isFullAudio: false
            })
            rt.nextStartTime = endAt
          }
        }

        // 兜底放行：若循环结束仍有未起播的缓冲分句，立即原子压入声卡
        if (readyBufferList.length > 0 && rt.activeSessionId === thisSessionId) {
          flushPrebufferedChunks(readyBufferList, ctx)
          readyBufferList.length = 0
        }

        // 标记当前文本所有分句已全部排程入队
        rt.isAllChunksScheduled = true

        // 若所有分句均未成功合成有效音频，给出错误提示
        if (rt.scheduledSources.length === 0 && rt.activeSessionId === thisSessionId) {
          set({
            status: 'error',
            currentFilePath: null,
            currentTitle: null,
            currentRealName: null,
            errorMessage: t('语音合成未能生成有效音频')
          })
          stopProgressMonitor()
          toast.error(t('语音合成未能生成有效音频，请稍后重试'), 4000, 'tts-error')
        }
      } catch (err: unknown) {
        if (rt.activeSessionId === thisSessionId) {
          console.error('[TTS] 播放调度异常:', err)
          set({
            status: 'error',
            currentFilePath: null,
            currentTitle: null,
            currentRealName: null,
            errorMessage: err instanceof Error ? err.message : t('语音合成失败')
          })
          stopProgressMonitor()
          toast.error(t('语音合成服务异常，请稍后重试'), 4000, 'tts-error')
        }
      }
    },

    locateAudio: async options => {
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

    seekSentence: async (targetIndex: number) => {
      const state = get()
      if (!state.playingText || !rt.currentCleanedChunks.length) return
      const clampedIndex = Math.max(0, Math.min(targetIndex, rt.currentCleanedChunks.length - 1))

      const ctx = getOrCreateAudioContext()
      if (ctx.state === 'suspended') {
        await ctx.resume()
      }

      const options = rt.currentPlayOptions
      const voiceId = state.currentVoiceId || DEFAULT_VOICE_ID
      const matchedVoice = getVoiceById(voiceId, state.allVoices)
      const displayName = matchedVoice?.displayName || String(voiceId)
      const sid = state.currentSid ?? 63
      const speed = state.speed

      // 计算目标分句在全文中的字符偏移量区间
      let targetCharStart = 0
      for (let i = 0; i < clampedIndex; i++) {
        targetCharStart += rt.currentCleanedChunks[i].length
      }

      // 检查本地是否有已录制/正在录制的缓存文件
      const cachePath = state.currentCachePath
      let localWavBuffer: ArrayBuffer | null = null
      let localMetadata: any = null

      if (
        cachePath &&
        window.electronAPI?.tts?.readWavMetadata &&
        window.electronAPI?.tts?.readWavFile
      ) {
        try {
          localMetadata = await window.electronAPI.tts.readWavMetadata(cachePath)
          if (localMetadata) {
            localWavBuffer = await window.electronAPI.tts.readWavFile(cachePath)
          }
        } catch (err) {
          console.warn('[TTS Seek] 读取本地音频文件异常:', err)
        }
      }

      // 1. 若当前文本已具备整段全量缓存文件 (completed === true)，直接按时间毫秒级定位起播
      if (
        localMetadata &&
        localMetadata.completed &&
        localWavBuffer &&
        localWavBuffer.byteLength > 44
      ) {
        try {
          const audioBuffer = await ctx.decodeAudioData(localWavBuffer.slice(0))
          const totalDuration = audioBuffer.duration

          if (totalDuration > 0.2) {
            // 优先读取精准内嵌时间戳索引表 (Cue Table)，实现 0.0000s 误差级绝对精准定位！
            let offset = 0
            if (
              localMetadata.chunks &&
              localMetadata.chunks[clampedIndex] &&
              typeof localMetadata.chunks[clampedIndex].startTime === 'number'
            ) {
              offset = localMetadata.chunks[clampedIndex].startTime
            } else {
              // 容错降级：按字符累积比例估算时间偏移量
              let totalChars = 0
              for (const c of rt.currentCleanedChunks) {
                totalChars += Math.max(1, c.length)
              }
              let accumulatedChars = 0
              for (let i = 0; i < clampedIndex; i++) {
                accumulatedChars += Math.max(1, rt.currentCleanedChunks[i].length)
              }
              offset = (accumulatedChars / totalChars) * totalDuration
            }
            const clampedOffset = Math.max(0, Math.min(Math.max(0, totalDuration - 0.05), offset))

            clearScheduledSources()
            if (rt.currentStreamingPlayer) {
              rt.currentStreamingPlayer.stop()
              rt.currentStreamingPlayer = null
            }
            rt.currentMasterCues = localMetadata.chunks || null
            rt.currentMasterTotalDuration = totalDuration

            const startAt = ctx.currentTime + 0.02
            const source = ctx.createBufferSource()
            source.buffer = audioBuffer
            source.playbackRate.value = 1.0
            source.connect(ctx.destination)
            source.start(startAt, clampedOffset)

            const remaining = totalDuration - clampedOffset
            rt.scheduledSources.push({
              source,
              startTime: startAt,
              endTime: startAt + remaining,
              index: clampedIndex,
              isFullAudio: true,
              offsetInAudio: clampedOffset
            })
            rt.nextStartTime = startAt + remaining
            rt.isAllChunksScheduled = true

            set({ status: 'playing', currentSentenceIndex: clampedIndex })
            ensureProgressMonitor()
            return
          }
        } catch (err) {
          console.warn('[TTS Seek] 全量音频跳转异常，回退流式通道:', err)
        }
      }

      // 2. 纯流式边播边录状态下的片段跳转：
      // 核心心智：既然已经落了本地文件，若拖动目标句已在本地已录入范围内，则切出本地音频立即秒播，同时向后断点继续合成
      const isM5Voice =
        !state.currentVoiceId ||
        String(state.currentVoiceId).includes('m5') ||
        String(state.currentVoiceId).startsWith('preset_') ||
        String(state.currentVoiceId).includes('azure_') ||
        getActiveTTSPluginId() === 'tts_m5_onnx'

      if (isM5Voice && typeof (window.electronAPI as any)?.tts?.startStream === 'function') {
        const thisSeekSession = ++rt.sessionCounter
        rt.activeSessionId = thisSeekSession

        const doneCharEnd = localMetadata?.doneCharEnd || 0
        const hasLocalAudioForTarget =
          Boolean(localWavBuffer && localWavBuffer.byteLength > 44) &&
          (doneCharEnd > targetCharStart ||
            Boolean(
              localMetadata?.chunks &&
              localMetadata.chunks.some((c: any) => c.index === clampedIndex)
            ))

        if (hasLocalAudioForTarget && localWavBuffer && localWavBuffer.byteLength > 44) {
          // 从本地文件中切出从 targetCharStart 开始到已录制末尾的全部纯 24kHz PCM
          let startSample = 0
          if (
            localMetadata?.chunks &&
            localMetadata.chunks[clampedIndex] &&
            typeof localMetadata.chunks[clampedIndex].startTime === 'number'
          ) {
            startSample = Math.floor(localMetadata.chunks[clampedIndex].startTime * 24000)
          } else {
            const ratio = Math.max(0, Math.min(1, targetCharStart / Math.max(1, doneCharEnd)))
            const totalSamples = Math.floor((localWavBuffer.byteLength - 44) / 2)
            startSample = Math.floor(totalSamples * ratio)
          }

          const startByteOffset = 44 + startSample * 2
          const pcmSlice = localWavBuffer.slice(
            Math.min(startByteOffset, localWavBuffer.byteLength)
          )

          console.info(
            `[TTS Seek] 🎯 命中本地已落盘文件秒播通道: 目标分句=${clampedIndex + 1}, 起始字符=${targetCharStart}, 本地已有字符=${doneCharEnd}, 切片PCM=${pcmSlice.byteLength}字节 (${(pcmSlice.byteLength / 48000).toFixed(2)}s)`
          )

          clearScheduledSources()
          set({
            status: 'playing',
            currentSentenceIndex: clampedIndex,
            bufferedDuration: pcmSlice.byteLength / 48000
          })

          // 启动纯流式会话：注入本地切片实现 0 毫秒秒播，同时从 doneCharEnd 断点向后继续合成！
          const ok = await launchStreamingSession({
            sessionId: thisSeekSession,
            text: state.playingText,
            voiceId: String(state.currentVoiceId || DEFAULT_VOICE_ID),
            speed: state.speed,
            resumeCharStart: doneCharEnd, // 断点继续合成：从本地已录制末尾继续
            initialSentenceIndex: clampedIndex,
            chunks: rt.currentCleanedChunks,
            targetCachePath: cachePath || undefined,
            filePath: state.currentFilePath || undefined,
            displayName: state.currentTitle || undefined,
            prefillPcmBuffer: pcmSlice, // 本地已有 PCM 秒播注入！
            prefillCharStart: targetCharStart,
            prefillCharEnd: doneCharEnd
          })

          if (ok) {
            return
          }
        } else {
          // 目标句尚未录入本地文件（拖动到了未合成的远端）：
          // 直接从 targetCharStart 发起断点续合成，首句到达后立即起播
          toast.info(t('跳转至目标片段并重新流式合成...'), 2000, 'tts-seek-loading')
          clearScheduledSources()
          set({
            status: 'loading',
            currentSentenceIndex: clampedIndex,
            bufferedDuration: 0
          })

          const ok = await launchStreamingSession({
            sessionId: thisSeekSession,
            text: state.playingText,
            voiceId: String(state.currentVoiceId || DEFAULT_VOICE_ID),
            speed: state.speed,
            resumeCharStart: targetCharStart, // 从目标分句开始合成
            initialSentenceIndex: clampedIndex,
            chunks: rt.currentCleanedChunks,
            targetCachePath: cachePath || undefined,
            filePath: state.currentFilePath || undefined,
            displayName: state.currentTitle || undefined
          })

          if (ok) {
            return
          }
        }
      }

      // 3. 分句流式合成模式下的片段跳转与插队优先合成 (Scheme A 降级通道)
      const thisSeekSession = ++rt.sessionCounter
      rt.activeSessionId = thisSeekSession
      if (window.electronAPI?.tts?.abortSession) {
        window.electronAPI.tts.abortSession(thisSeekSession - 1).catch(err => {
          console.warn('[TTS Seek] 中止前序会话异常:', err)
        })
      }

      clearScheduledSources()
      rt.nextStartTime = 0
      rt.isAllChunksScheduled = false
      toast.info(t('该片段正在合成中，请稍候...'), 3000, 'tts-seek-loading')
      set({
        currentSentenceIndex: clampedIndex,
        status: 'loading',
        bufferedDuration: 0,
        targetBufferDuration: TTS_BUFFER_WATERMARK.MIN_BUFFERED_DURATION_SEC
      })

      const readyBufferList: PrebufferedChunkItem[] = []
      let totalBufferedDuration = 0
      const remainingChunksCount = Math.max(1, rt.currentCleanedChunks.length - clampedIndex)
      let isWatermarkSatisfied = false

      ;(async () => {
        for (let i = clampedIndex; i < rt.currentCleanedChunks.length; i++) {
          if (rt.activeSessionId !== thisSeekSession) return
          const chunkText = rt.currentCleanedChunks[i]
          let baseBuffer: ArrayBuffer | null = null

          // 优先检查内存缓存与磁盘分片缓存（传递 chunkText 确保防错位）
          const cached = rt.cachedChunksMap.get(i)
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
            const synthRes = await safeSynthesizeChunk(
              chunkText,
              voiceId,
              1.0,
              thisSeekSession,
              sid
            )
            if (synthRes) {
              if (synthRes.hitCap) {
                toast.warning(t('音频片段过长已自动截断'))
              }
              baseBuffer = synthRes.buffer
            }
          }

          if (rt.activeSessionId !== thisSeekSession) return
          if (!baseBuffer || baseBuffer.byteLength === 0) {
            if (rt.scheduledSources.length === 0 && readyBufferList.length === 0) {
              toast.error(t('该片段合成失败，请稍后重试'), 3500, 'tts-seek-loading')
              set({ status: 'idle', bufferedDuration: 0 })
              return
            }
            continue
          }

          const chunkUint8 = new Uint8Array(baseBuffer)
          rt.cachedChunksMap.set(i, chunkUint8)

          // 异步分片独立落盘（传入 chunkText 确保防错位）
          if (window.electronAPI?.tts?.saveChunk) {
            window.electronAPI.tts
              .saveChunk({
                filePath: options?.filePath,
                fileFingerprint: options?.fileFingerprint,
                fieldName: options?.fieldName,
                displayName,
                voiceId,
                sid,
                speed,
                chunkIndex: i,
                totalChunks: rt.currentCleanedChunks.length,
                chunkData: chunkUint8,
                chunkText
              })
              .catch(err => {
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

          if (rt.activeSessionId !== thisSeekSession) return
          const audioBuffer = await ctx.decodeAudioData(playbackBuffer.slice(0))
          if (rt.activeSessionId !== thisSeekSession) return

          if (!isWatermarkSatisfied) {
            readyBufferList.push({
              index: i,
              buffer: audioBuffer,
              baseBuffer
            })
            totalBufferedDuration += audioBuffer.duration
            set({ bufferedDuration: totalBufferedDuration })

            // 水线判定：
            // 1. 首句极速起播（Fast First Playback）：首句只要就绪且时长 >= 1.0s，立即起播！绝不死等后续分句！
            // 2. 末尾自愈：所有剩余分句已蓄满，短文本 1 句直接放行
            // 3. 多句安全水线：蓄满 >= 2 句且总时长达标
            const isFirstChunkReady =
              readyBufferList.length >= 1 &&
              readyBufferList[0].index === clampedIndex &&
              readyBufferList[0].buffer.duration >= 1.0
            const isLastRemaining = readyBufferList.length >= remainingChunksCount
            const satisfiesSafetyWatermark =
              readyBufferList.length >=
                Math.min(TTS_BUFFER_WATERMARK.MIN_BUFFERED_CHUNKS, remainingChunksCount) &&
              totalBufferedDuration >= TTS_BUFFER_WATERMARK.MIN_BUFFERED_DURATION_SEC

            if (isFirstChunkReady || isLastRemaining || satisfiesSafetyWatermark) {
              isWatermarkSatisfied = true
              flushPrebufferedChunks(readyBufferList, ctx)
              readyBufferList.length = 0
              totalBufferedDuration = 0
              set({ bufferedDuration: 0 })
            }
          } else {
            // 已起播：就绪即链式排程追加（挂载交叉淡化）
            const nextStartAt = Math.max(ctx.currentTime + 0.05, rt.nextStartTime)
            const { source: nextSource } = createCrossfadedSource(ctx, audioBuffer, nextStartAt)
            nextSource.start(nextStartAt)

            const nextEndAt = nextStartAt + audioBuffer.duration
            rt.scheduledSources.push({
              source: nextSource,
              startTime: nextStartAt,
              endTime: nextEndAt,
              index: i,
              isFullAudio: false
            })
            rt.nextStartTime = nextEndAt
          }
        }

        if (readyBufferList.length > 0 && rt.activeSessionId === thisSeekSession) {
          flushPrebufferedChunks(readyBufferList, ctx)
          readyBufferList.length = 0
        }
        rt.isAllChunksScheduled = true
      })().catch(err => {
        console.warn('[TTS Seek] 后续分句流式排程异常:', err)
      })
    }
  }
}
