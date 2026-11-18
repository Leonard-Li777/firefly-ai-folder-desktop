import { toast } from '../../../components/common/Toast'
import { rt } from '../runtime'
import { safeSynthesizeChunk } from '../synthesize'
import type { TTSAudioState, TTSStoreSet, TTSStoreGet } from '../types'
import { t } from '@app/languages'

export function createExportSlice(set: TTSStoreSet, get: TTSStoreGet): Partial<TTSAudioState> {
  return {
    exportAudio: async (defaultFileName?: string) => {
      const state = get()
      if (!rt.currentCleanedChunks.length && !rt.cachedChunksMap.size) {
        return null
      }

      const previousStatus = state.status
      set({ status: 'exporting' })

      try {
        const chunksToExport: Uint8Array[] = []
        const voiceId = state.currentVoiceId || String(state.currentSid)

        // 若部分分句尚未合成完成，在后台补齐合成
        for (let i = 0; i < rt.currentCleanedChunks.length; i++) {
          let chunkData = rt.cachedChunksMap.get(i)
          if (!chunkData) {
            const synthRes = await safeSynthesizeChunk(rt.currentCleanedChunks[i], voiceId, 1.0)
            if (synthRes) {
              if (synthRes.hitCap) {
                toast.warning(t('音频片段过长已自动截断'))
              }
              chunkData = new Uint8Array(synthRes.buffer)
              rt.cachedChunksMap.set(i, chunkData)
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
        set({ status: previousStatus, errorMessage: t('导出音频失败') })
        return null
      }
    },
  }
}
