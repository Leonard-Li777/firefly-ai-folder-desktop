import { ensureProgressMonitor } from './progress'
import { rt } from './runtime'
import { ttsStore } from './store-ref'
import type { PrebufferedChunkItem } from './types'

export function updateSynthesizingCounter(delta: number) {
  rt.activeSynthesizingCount = Math.max(0, rt.activeSynthesizingCount + delta)
  const isSyn = rt.activeSynthesizingCount > 0
  if (ttsStore().getState().isSynthesizing !== isSyn) {
    ttsStore().setState({ isSynthesizing: isSyn })
  }
}

/**
 * 为 BufferSource 挂载 GainNode 并施加 15ms 首尾平滑等功率交叉淡化，杜绝直流爆音与声学断气
 */
export function createCrossfadedSource(
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
export function flushPrebufferedChunks(list: PrebufferedChunkItem[], ctx: AudioContext): void {
  if (list.length === 0) return
  let chainTime = Math.max(ctx.currentTime + 0.05, rt.nextStartTime)

  for (const item of list) {
    const { source } = createCrossfadedSource(ctx, item.buffer, chainTime)
    source.start(chainTime)

    const duration = item.buffer.duration
    const endAt = chainTime + duration
    rt.scheduledSources.push({
      source,
      startTime: chainTime,
      endTime: endAt,
      index: item.index,
      isFullAudio: false
    })
    chainTime = endAt
  }

  rt.nextStartTime = chainTime
  ttsStore().setState({ status: 'playing', bufferedDuration: 0 })
  ensureProgressMonitor()
}

/** 获取当前正在播放文本的切片分句文本数组（供 UI 刻度预览 Tooltip 使用） */
export function getCurrentTTSChunks(): string[] {
  return rt.currentCleanedChunks
}

export function getOrCreateAudioContext(): AudioContext {
  if (!rt.audioContext || rt.audioContext.state === 'closed') {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext
    rt.audioContext = new AudioCtx({ sampleRate: 48000 })
  }
  return rt.audioContext
}

export function clearScheduledSources(): void {
  for (const item of rt.scheduledSources) {
    try {
      item.source.stop()
      item.source.disconnect()
    } catch {
      // 忽略已停止的节点异常
    }
  }
  rt.scheduledSources = []
  rt.currentMasterCues = null
  rt.currentMasterTotalDuration = 0
}

export function stopProgressMonitor(): void {
  if (rt.progressTimer) {
    clearInterval(rt.progressTimer)
    rt.progressTimer = null
  }
}
