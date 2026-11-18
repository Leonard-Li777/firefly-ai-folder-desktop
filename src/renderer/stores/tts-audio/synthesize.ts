import { updateSynthesizingCounter } from './audio-engine'

export async function safeSynthesizeChunk(
  text: string,
  voiceId: string | number,
  speed: number,
  sessionId?: number,
  sid?: number
): Promise<{ buffer: ArrayBuffer; hitCap: boolean; steps: number } | null> {
  if (!window.electronAPI?.tts?.synthesizeChunk) {
    return null
  }
  updateSynthesizingCounter(1)
  try {
    // 对齐规格书 §4.3: 遇到忙碌冲突等瞬态失败执行有界指数退避重试 (最多 3 次，间隔 500ms、1000ms、2000ms)
    let retryDelay = 500
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await window.electronAPI.tts.synthesizeChunk(text, voiceId, speed, sessionId, sid)
      if (res && res.buffer && res.buffer.byteLength > 0) {
        return res
      }
      if (attempt < 2) {
        await new Promise(resolve => setTimeout(resolve, retryDelay))
        retryDelay *= 2
      }
    }
    return null
  } finally {
    updateSynthesizingCounter(-1)
  }
}
