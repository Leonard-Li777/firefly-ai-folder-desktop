import { rt } from './runtime'
import { ttsStore } from './store-ref'
import type { AudioProgressInfo } from './types'

/**
 * 实时获取当前播放器的完整声学进度信息
 * 严格适配【整文件秒播模式】与【分句流式排程模式】，消除整文件下 active.index === 0 导致的进度归零陷阱
 */
export function getCurrentAudioProgress(): AudioProgressInfo {
  const store = ttsStore().getState()
  const maxIdx = Math.max(0, rt.currentCleanedChunks.length - 1)
  const fallbackIndex = Math.max(0, Math.min(store.currentSentenceIndex, maxIdx))

  if (!rt.audioContext || rt.scheduledSources.length === 0) {
    return {
      sentenceIndex: fallbackIndex,
      elapsedInSentence: 0,
      sentenceDuration: 0,
      remainingInSentence: 0,
      elapsedTotalTime: 0,
      totalDuration: 0
    }
  }

  const now = rt.audioContext.currentTime

  // 模式 1：整文件全量母带播放模式（仅当单节点且明确标记为整文件母带 isFullAudio: true 时才进入）
  if (
    rt.scheduledSources.length === 1 &&
    rt.scheduledSources[0].isFullAudio === true &&
    rt.currentCleanedChunks.length > 1
  ) {
    const single = rt.scheduledSources[0]
    const nodeDuration = Math.max(0.01, single.endTime - single.startTime)
    const elapsedInNode = Math.max(0, Math.min(nodeDuration, now - single.startTime))
    const offset = single.offsetInAudio || 0
    const audioElapsed = Math.max(0, elapsedInNode + offset)

    // 优先使用路线 A 内嵌的精确分句时间戳索引表 (TTSChunkCue[])
    if (rt.currentMasterCues && rt.currentMasterCues.length > 0) {
      let sentenceIndex = 0
      let sentenceStartTime = 0
      let sentenceDuration = nodeDuration

      for (let i = 0; i < rt.currentMasterCues.length; i++) {
        const cue = rt.currentMasterCues[i]
        const cueEnd = cue.startTime + cue.duration
        if (audioElapsed >= cue.startTime && audioElapsed < cueEnd) {
          sentenceIndex = cue.index
          sentenceStartTime = cue.startTime
          sentenceDuration = cue.duration
          break
        } else if (audioElapsed < cue.startTime && i > 0) {
          sentenceIndex = rt.currentMasterCues[i - 1].index
          sentenceStartTime = rt.currentMasterCues[i - 1].startTime
          sentenceDuration = rt.currentMasterCues[i - 1].duration
          break
        } else if (i === rt.currentMasterCues.length - 1 && audioElapsed >= cue.startTime) {
          sentenceIndex = cue.index
          sentenceStartTime = cue.startTime
          sentenceDuration = cue.duration
          break
        }
      }

      const elapsedInSentence = Math.max(
        0,
        Math.min(sentenceDuration, audioElapsed - sentenceStartTime)
      )
      const remainingInSentence = Math.max(0, sentenceDuration - elapsedInSentence)
      const fullTotalDuration = rt.currentMasterTotalDuration || single.endTime - single.startTime

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
    for (const c of rt.currentCleanedChunks) {
      totalChars += Math.max(1, c.length)
    }

    const fullTotalDuration = rt.currentMasterTotalDuration || single.endTime - single.startTime
    const ratio = Math.min(1.0, audioElapsed / Math.max(0.01, fullTotalDuration))
    let sentenceIndex = 0
    let accumulatedChars = 0
    let sentenceStartTime = 0
    let sentenceEndTime = fullTotalDuration

    for (let i = 0; i < rt.currentCleanedChunks.length; i++) {
      const chunkLen = Math.max(1, rt.currentCleanedChunks[i].length)
      const prevRatio = accumulatedChars / totalChars
      accumulatedChars += chunkLen
      const nextRatio = accumulatedChars / totalChars

      if (ratio <= nextRatio || i === rt.currentCleanedChunks.length - 1) {
        sentenceIndex = i
        sentenceStartTime = prevRatio * fullTotalDuration
        sentenceEndTime = nextRatio * fullTotalDuration
        break
      }
    }

    const sentenceDuration = Math.max(0.01, sentenceEndTime - sentenceStartTime)
    const elapsedInSentence = Math.max(
      0,
      Math.min(sentenceDuration, audioElapsed - sentenceStartTime)
    )
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
  for (const s of rt.scheduledSources) {
    totalDuration += s.endTime - s.startTime
  }

  // 1. 若当前硬件时钟尚未到达首个排程节点的起播时间（启动微缓冲期，如前 0.05s），精准定位在首个排程节点的 index
  if (now < rt.scheduledSources[0].startTime) {
    const first = rt.scheduledSources[0]
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
  const active = rt.scheduledSources.find(s => now >= s.startTime && now < s.endTime)
  if (active) {
    let elapsedTotalTime = 0
    for (const s of rt.scheduledSources) {
      if (s.index < active.index) {
        elapsedTotalTime += s.endTime - s.startTime
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
  const nextNode = rt.scheduledSources.find(s => s.startTime > now)
  if (nextNode) {
    const nextIdx = rt.scheduledSources.indexOf(nextNode)
    const prevNode = nextIdx > 0 ? rt.scheduledSources[nextIdx - 1] : nextNode
    let elapsedTotalTime = 0
    for (const s of rt.scheduledSources) {
      if (s.index <= prevNode.index) {
        elapsedTotalTime += s.endTime - s.startTime
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
  const lastSource = rt.scheduledSources[rt.scheduledSources.length - 1]
  const lastIndex = lastSource ? lastSource.index : fallbackIndex

  return {
    sentenceIndex: lastIndex,
    elapsedInSentence: lastSource ? lastSource.endTime - lastSource.startTime : 0,
    sentenceDuration: lastSource ? lastSource.endTime - lastSource.startTime : 0,
    remainingInSentence: 0,
    elapsedTotalTime: totalDuration,
    totalDuration
  }
}

/**
 * 确保播放进度轮询监测器处于活跃运行状态
 */
export function ensureProgressMonitor(): void {
  if (rt.progressTimer) return
  rt.progressTimer = setInterval(() => {
    if (!rt.audioContext) return
    const prog = getCurrentAudioProgress()
    if (prog.sentenceIndex !== ttsStore().getState().currentSentenceIndex) {
      ttsStore().setState({ currentSentenceIndex: prog.sentenceIndex })
    }
    // 全部播放完毕检测：必须所有分句均已合成入队，当前无热切进行中，且播放时钟越过末尾！
    if (
      rt.isAllChunksScheduled &&
      !rt.isHotSwitchInProgress &&
      rt.scheduledSources.length > 0 &&
      rt.audioContext.currentTime >= rt.nextStartTime &&
      ttsStore().getState().status === 'playing'
    ) {
      ttsStore().getState().stop()
    }
  }, 80)
}

