import { toast } from '../../components/common/Toast'
import { getVoiceById } from '../../constants/tts-voices'
import { getOrCreateAudioContext, clearScheduledSources } from './audio-engine'
import { getCurrentAudioProgress, ensureProgressMonitor } from './progress'
import { rt } from './runtime'
import { ttsStore } from './store-ref'
import { safeSynthesizeChunk } from './synthesize'
import { t } from '@app/languages'

/**
 * 核心特性：播放中平滑热切换（Hot Handover）
 * 保持当前音频在扬声器中连贯朗读的同时，在后台异步预合成新音色/新倍率切入点，完成后无缝自动接管播放
 */
export function triggerHotSwitch(changed: {
  voiceId?: string
  sid?: number
  speed?: number
  oldSpeed?: number
}) {
  const store = ttsStore().getState()
  const text = store.playingText
  if (!text || !rt.currentCleanedChunks.length) return

  // 1. 给出 Toast 提示词，明确告知正在合成且合成后会自动切换
  toast.info(t('正在合成音频，合成后会自动切换'), 3500, 'tts-switching-voice')

  // 2. 递增热切版本号，并激活热切互斥标记，防止旧音轨结束误杀播放状态
  const switchId = ++rt.hotSwitchCounter
  rt.isHotSwitchInProgress = true

  // 3. 立即精准捕获切换前在旧音轨中的声学进度（分句索引与全文已播时长）
  const wasPaused = store.status === 'paused'
  const initialProgress = getCurrentAudioProgress()
  const oldSpeed = changed.oldSpeed !== undefined ? changed.oldSpeed : store.speed
  const isVoiceChanged = changed.voiceId !== undefined

  // 4. 异步后台执行合成、派生与平滑切入
  ;(async () => {
    try {
      const targetVoiceId = ttsStore().getState().currentVoiceId
      const targetSid = ttsStore().getState().currentSid
      const targetSpeed = ttsStore().getState().speed
      const matchedVoice = getVoiceById(targetVoiceId, ttsStore().getState().allVoices)
      const targetDisplayName = matchedVoice?.displayName || String(targetVoiceId)
      const options = rt.currentPlayOptions

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
      if (switchId !== rt.hotSwitchCounter) {
        return
      }

      // 【通道 A：整音频极速无缝接管通道】
      // 若目标音频已全量落盘（如 WSOLA 毫秒级派生完成或历史完整缓存命中），直接读取并按精确时间偏移无缝接管
      if (
        targetCachePath &&
        window.electronAPI?.tts?.readWavMetadata &&
        window.electronAPI?.tts?.readWavFile
      ) {
        try {
          const metadata = await window.electronAPI.tts.readWavMetadata(targetCachePath)
          const isSpeedMatch =
            metadata?.speed === undefined || Math.abs(metadata.speed - targetSpeed) < 0.01
          if (metadata && metadata.completed && isSpeedMatch) {
            const fullWavBuffer = await window.electronAPI.tts.readWavFile(targetCachePath)
            if (fullWavBuffer && fullWavBuffer.byteLength > 44) {
              if (switchId !== rt.hotSwitchCounter) return

              const ctx = getOrCreateAudioContext()
              if (ctx.state === 'suspended') {
                await ctx.resume()
              }
              const audioBuffer = await ctx.decodeAudioData(fullWavBuffer.slice(0))
              if (switchId !== rt.hotSwitchCounter) return

              // 在切断旧音轨的前一刻，再次获取最新已播放时长与分句索引，消除异步 I/O 期间的微小时钟漂移
              const currentProgress = getCurrentAudioProgress()
              let newOffset = 0
              if (oldSpeed > 0 && targetSpeed > 0) {
                newOffset = (currentProgress.elapsedTotalTime * oldSpeed) / targetSpeed
              }
              newOffset = Math.max(0, Math.min(Math.max(0, audioBuffer.duration - 0.05), newOffset))

              // 终止旧会话与旧音轨排程
              const oldSession = rt.activeSessionId
              const newSessionId = ++rt.sessionCounter
              rt.activeSessionId = newSessionId

              if (window.electronAPI?.tts?.abortSession) {
                window.electronAPI.tts.abortSession(oldSession).catch(err => {
                  console.warn('[TTS HotSwitch] 中止旧会话异常 (通道 A):', err)
                })
              }

              clearScheduledSources()
              rt.currentMasterCues = metadata.chunks || null
              rt.currentMasterTotalDuration = audioBuffer.duration

              // 新音频从当前硬件时钟 + 0.02s 起播，指定偏移量 newOffset
              const startAt = ctx.currentTime + 0.02
              const source = ctx.createBufferSource()
              source.buffer = audioBuffer
              source.playbackRate.value = 1.0
              source.connect(ctx.destination)
              source.start(startAt, newOffset)

              const remainingDuration = audioBuffer.duration - newOffset
              const endAt = startAt + remainingDuration
              rt.scheduledSources.push({
                source,
                startTime: startAt,
                endTime: endAt,
                index: currentProgress.sentenceIndex,
                isFullAudio: true,
                offsetInAudio: newOffset
              })
              rt.nextStartTime = endAt
              rt.isAllChunksScheduled = true

              // 更新 Store 状态
              ttsStore().setState({
                status: 'playing',
                currentSentenceIndex: currentProgress.sentenceIndex,
                currentCachePath: targetCachePath,
                speed: targetSpeed,
                currentVoiceId: targetVoiceId,
                currentSid: targetSid,
                bufferedDuration: 0
              })

              ensureProgressMonitor()
              toast.success(t('已自动切换播放'), 2000, 'tts-switching-voice')
              return
            }
          }
        } catch (fastSwitchErr) {
          console.warn(
            '[TTS HotSwitch] 全量整音频极速接管失败，平滑回退分句流式通道:',
            fastSwitchErr
          )
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
        initialProgress.sentenceIndex + 1 < rt.currentCleanedChunks.length

      if (shouldHandoverAtNext) {
        targetSentenceIdx = initialProgress.sentenceIndex + 1
      }

      const chunkText = rt.currentCleanedChunks[targetSentenceIdx]
      let baseBuffer: ArrayBuffer | null = null

      // 若发音人未变（仅变语速），且内存中已有当前句 1.0x 母本，直接毫秒级复用
      const cachedChunk = rt.cachedChunksMap.get(targetSentenceIdx)
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
        const synthRes = await safeSynthesizeChunk(
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
      if (switchId !== rt.hotSwitchCounter) {
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

      if (switchId !== rt.hotSwitchCounter) {
        return
      }

      // 解码 AudioBuffer
      const ctx = getOrCreateAudioContext()
      if (ctx.state === 'suspended') {
        await ctx.resume()
      }
      const audioBuffer = await ctx.decodeAudioData(playbackBuffer.slice(0))

      if (switchId !== rt.hotSwitchCounter) {
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
      const oldSession = rt.activeSessionId
      const newSessionId = ++rt.sessionCounter
      rt.activeSessionId = newSessionId

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
      rt.scheduledSources.push({
        source,
        startTime: startAt,
        endTime: endAt,
        index: actualStartSentenceIdx
      })
      rt.nextStartTime = endAt

      // 更新 Store 状态
      ttsStore().setState({
        status: 'playing',
        currentSentenceIndex: actualStartSentenceIdx,
        currentCachePath: targetCachePath,
        speed: targetSpeed,
        currentVoiceId: targetVoiceId,
        currentSid: targetSid,
        bufferedDuration: 0
      })

      ensureProgressMonitor()

      // 弹出已自动切换提示
      toast.success(t('已自动切换播放'), 2000, 'tts-switching-voice')

      // 若发音人发生变更，清空旧音色缓存池
      if (isVoiceChanged) {
        rt.cachedChunksMap.clear()
      }
      rt.cachedChunksMap.set(actualStartSentenceIdx, new Uint8Array(baseBuffer))

      // 异步分片独立落盘（路线 A：即合成即写盘，零内存驻留压力）
      if (baseBuffer && baseBuffer.byteLength > 0 && window.electronAPI?.tts?.saveChunk) {
        window.electronAPI.tts
          .saveChunk({
            filePath: options?.filePath,
            fileFingerprint: options?.fileFingerprint,
            fieldName: options?.fieldName,
            displayName: targetDisplayName,
            voiceId: targetVoiceId,
            sid: targetSid,
            speed: targetSpeed,
            chunkIndex: targetSentenceIdx,
            totalChunks: rt.currentCleanedChunks.length,
            chunkData: new Uint8Array(baseBuffer),
            chunkText: rt.currentCleanedChunks[targetSentenceIdx]
          })
          .catch(err => {
            console.warn('[TTS HotSwitch] 异步保存切入句分片异常:', err)
          })
      }

      // 紧接着在后台流式合成后续句子（targetSentenceIdx + 1 到全文结束）
      for (let i = targetSentenceIdx + 1; i < rt.currentCleanedChunks.length; i++) {
        if (rt.activeSessionId !== newSessionId) return

        const nextChunkText = rt.currentCleanedChunks[i]
        let nextBaseBuffer: ArrayBuffer | null = null

        const cachedNext = rt.cachedChunksMap.get(i)
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
          const synthRes = await safeSynthesizeChunk(
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

        if (rt.activeSessionId !== newSessionId) return
        if (!nextBaseBuffer || nextBaseBuffer.byteLength === 0) continue

        const nextChunkUint8 = new Uint8Array(nextBaseBuffer)
        rt.cachedChunksMap.set(i, nextChunkUint8)

        // 异步分片独立落盘（路线 A：即合成即写盘，集齐后自动无损流式合并并派生目标倍速）
        if (window.electronAPI?.tts?.saveChunk) {
          window.electronAPI.tts
            .saveChunk({
              filePath: options?.filePath,
              fileFingerprint: options?.fileFingerprint,
              fieldName: options?.fieldName,
              displayName: targetDisplayName,
              voiceId: targetVoiceId,
              sid: targetSid,
              speed: targetSpeed,
              chunkIndex: i,
              totalChunks: rt.currentCleanedChunks.length,
              chunkData: nextChunkUint8,
              chunkText: nextChunkText
            })
            .catch(err => {
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

        if (rt.activeSessionId !== newSessionId) return

        const nextAudioBuffer = await ctx.decodeAudioData(nextPlaybackBuffer.slice(0))
        if (rt.activeSessionId !== newSessionId) return

        const nextSource = ctx.createBufferSource()
        nextSource.buffer = nextAudioBuffer
        nextSource.playbackRate.value = 1.0
        nextSource.connect(ctx.destination)

        const nextStartAt = Math.max(ctx.currentTime + 0.05, rt.nextStartTime)
        nextSource.start(nextStartAt)
        const nextDuration = nextAudioBuffer.duration
        const nextEndAt = nextStartAt + nextDuration
        rt.scheduledSources.push({
          source: nextSource,
          startTime: nextStartAt,
          endTime: nextEndAt,
          index: i
        })
        rt.nextStartTime = nextEndAt
      }

      rt.isAllChunksScheduled = true
    } catch (err) {
      console.error('[TTS HotSwitch] 热切调度失败:', err)
      toast.error(t('切换音色失败，语音合成服务不可用'), 3500, 'tts-switching-voice')
    } finally {
      if (switchId === rt.hotSwitchCounter) {
        rt.isHotSwitchInProgress = false
      }
    }
  })()
}
