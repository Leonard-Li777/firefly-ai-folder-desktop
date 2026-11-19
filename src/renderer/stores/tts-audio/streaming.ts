import { StreamingPCMPlayer } from '../../utils/streaming-pcm-player'
import { stopProgressMonitor } from './audio-engine'
import { rt } from './runtime'
import { ttsStore } from './store-ref'
import { t } from '@app/languages'

/**
 * 启动纯流式 PCM 播放会话 (Scheme B - M5 Pure Streaming)
 * 支持指定 resumeCharStart 实现从任意分句/字符偏移量精准秒级恢复与进度条拖拽定位
 */
export async function launchStreamingSession(params: {
  sessionId: number
  text: string
  voiceId: string
  speed: number
  resumeCharStart?: number
  initialSentenceIndex?: number
  chunks: string[]
  targetCachePath?: string
  filePath?: string
  fileFingerprint?: string
  fieldName?: string
  displayName?: string
  prefillWavBuffer?: ArrayBuffer | null
  prefillPcmBuffer?: ArrayBuffer | null
  prefillCharStart?: number
  prefillCharEnd?: number
}): Promise<boolean> {
  if (typeof window.electronAPI?.tts?.startStream !== 'function') return false
  try {
    if (rt.currentStreamingPlayer) {
      rt.currentStreamingPlayer.stop()
      rt.currentStreamingPlayer = null
    }
    rt.activeStreamCleanups.forEach(fn => fn())
    rt.activeStreamCleanups = []

    console.info(
      `[TTS] 发起纯流式会话: voiceId=${params.voiceId}, speed=${params.speed}, resumeCharStart=${params.resumeCharStart || 0}, targetCachePath=${params.targetCachePath || 'auto'}`
    )

    const streamAck = await window.electronAPI.tts.startStream({
      text: params.text,
      voiceId: String(params.voiceId),
      speed: params.speed,
      resumeCharStart: params.resumeCharStart,
      targetCachePath: params.targetCachePath,
      filePath: params.filePath,
      fileFingerprint: params.fileFingerprint,
      fieldName: params.fieldName,
      displayName: params.displayName
    })

    if (!streamAck.ok || !streamAck.sessionId) {
      return false
    }

    if (rt.activeSessionId !== params.sessionId) {
      window.electronAPI.tts.abortStream?.({ sessionId: streamAck.sessionId })
      return false
    }

    // 构造分句字符区间表，用于根据 playedCharEnd 动态定位 currentSentenceIndex 与逐句高亮
    let charOffset = 0
    const chunkRanges = params.chunks.map(chunk => {
      const start = charOffset
      charOffset += chunk.length
      return { start, end: charOffset }
    })

    const player = new StreamingPCMPlayer({
      onProgress: playedCharEnd => {
        if (rt.activeSessionId !== params.sessionId) return
        const foundIdx = chunkRanges.findIndex(
          r => playedCharEnd >= r.start && playedCharEnd <= r.end
        )
        if (foundIdx !== -1 && ttsStore().getState().currentSentenceIndex !== foundIdx) {
          ttsStore().setState({ currentSentenceIndex: foundIdx })
        }
      },
      onEnded: () => {
        if (rt.activeSessionId !== params.sessionId) return
        ttsStore().setState({ status: 'idle', currentSentenceIndex: 0 })
        stopProgressMonitor()
      },
      onError: err => {
        console.error('[TTS Stream Player] 播放器异常:', err)
      }
    })

    rt.currentStreamingPlayer = player
    await player.start(streamAck.sessionId)

    // 断点无缝续播 / 本地文件秒播接驳：若存在本地已有音频片段，直接作为先头帧喂入播放器，实现零秒立即起播
    const prefillPcm = params.prefillPcmBuffer
      ? params.prefillPcmBuffer
      : params.prefillWavBuffer && params.prefillWavBuffer.byteLength > 44
        ? params.prefillWavBuffer.slice(44)
        : null

    if (prefillPcm && prefillPcm.byteLength > 0) {
      const sampleCount = Math.floor(prefillPcm.byteLength / 2)
      const pStart = params.prefillCharStart ?? 0
      const pEnd = params.prefillCharEnd ?? (params.resumeCharStart || 0)
      console.info(
        `[TTS] 注入本地文件已合成音频秒播: ${(sampleCount / 24000).toFixed(2)}s, 字符=[${pStart}..${pEnd}]`
      )
      player.pushChunk({
        sessionId: streamAck.sessionId,
        seq: 0,
        charStart: pStart,
        charEnd: pEnd,
        startSample: 0,
        sampleCount,
        pcm: prefillPcm,
        isFirst: true,
        isLast: false
      })
      ttsStore().setState({ status: 'playing' })
    }

    // 注册下行流数据与结束监听
    const unlistenChunk = window.electronAPI.tts.onStreamChunkData((payload: any) => {
      if (rt.activeSessionId !== params.sessionId || payload.sessionId !== streamAck.sessionId)
        return
      player.pushChunk(payload)
      if (ttsStore().getState().status === 'loading') {
        ttsStore().setState({ status: 'playing' })
      }
    })

    const unlistenEnded = window.electronAPI.tts.onStreamEnded((payload: any) => {
      if (rt.activeSessionId !== params.sessionId || payload.sessionId !== streamAck.sessionId)
        return
      if (payload.reason === 'error' || payload.reason === 'renderer_frozen') {
        ttsStore().setState({
          status: 'error',
          errorMessage: payload.errorCode || t('流式播放中断')
        })
      }
    })

    rt.activeStreamCleanups.push(unlistenChunk, unlistenEnded)
    return true
  } catch (err) {
    console.warn('[TTS] 启动纯流式会话失败:', err)
    return false
  }
}
