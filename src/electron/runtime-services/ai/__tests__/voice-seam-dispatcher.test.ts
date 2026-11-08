import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock modular-resource-service
const mockActiveModules: Record<string, any> = {}
vi.mock('../../system/modular-resource-service', () => ({
  modularResourceService: {
    getActiveModuleBySlot: vi.fn((slot: string) => mockActiveModules[slot] ?? null)
  }
}))

// Mock omniService
const mockTranscribeAudio = vi.fn()
vi.mock('../../system/omni-service', () => ({
  omniService: {
    transcribeAudio: (...args: any[]) => mockTranscribeAudio(...args)
  }
}))

// Mock omniClient
const mockSynthesizeTTSChunk = vi.fn()
const mockSplitTTSChunks = vi.fn()
vi.mock('../../../services/omni-client', () => ({
  omniClient: {
    synthesizeTTSChunk: (...args: any[]) => mockSynthesizeTTSChunk(...args),
    splitTTSChunks: (...args: any[]) => mockSplitTTSChunks(...args)
  }
}))

import {
  VoiceSeamDispatcher,
  VoiceSeamError,
  stripWavHeader,
  createWavFromPcm,
  splitTextIntoSentences,
  voiceSeamDispatcher
} from '../voice-seam-dispatcher'

describe('VoiceSeamDispatcher (Ticket 04) 语音中继调度与 PCM 流式测试', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete mockActiveModules['voice_asr']
    delete mockActiveModules['voice_tts']
  })

  describe('WAV 编解码与分句辅助函数', () => {
    it('createWavFromPcm 生成合法 44 字节头部且能被 stripWavHeader 完美还原', () => {
      const originalPcm = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
      const wavBuffer = createWavFromPcm(originalPcm, 48000, 1, 16)

      expect(wavBuffer.byteLength).toBe(44 + 8)
      const view = new DataView(wavBuffer)
      // "RIFF"
      expect(view.getUint32(0, false)).toBe(0x52494646)
      // "WAVE"
      expect(view.getUint32(8, false)).toBe(0x57415645)
      // sampleRate 48000
      expect(view.getUint32(24, true)).toBe(48000)
      // numChannels 1
      expect(view.getUint16(22, true)).toBe(1)

      const recoveredPcm = stripWavHeader(wavBuffer)
      expect(recoveredPcm).toEqual(originalPcm)
    })

    it('stripWavHeader 对小于 44 字节或非 WAV 格式原样返回', () => {
      const raw = new Uint8Array([10, 20, 30])
      expect(stripWavHeader(raw.buffer)).toEqual(raw)

      const fakeHeader = new Uint8Array(44)
      expect(stripWavHeader(fakeHeader.buffer)).toEqual(fakeHeader)
    })

    it('splitTextIntoSentences 按标点合理切分句子', () => {
      expect(splitTextIntoSentences('')).toEqual([])
      const parts = splitTextIntoSentences('你好！今天天气真好。我们去散步吧？')
      expect(parts.length).toBe(3)
      expect(parts[0]).toBe('你好！')
      expect(parts[1]).toBe('今天天气真好。')
      expect(parts[2]).toBe('我们去散步吧？')
    })
  })

  describe('transcribe (语音转录)', () => {
    it('未激活 ASR 插件时抛出强类型 VoiceSeamError(NO_ACTIVE_PLUGIN)', async () => {
      await expect(voiceSeamDispatcher.transcribe('C:/dummy/audio.wav')).rejects.toThrow(
        VoiceSeamError
      )

      try {
        await voiceSeamDispatcher.transcribe('C:/dummy/audio.wav')
      } catch (err: any) {
        expect(err.code).toBe('NO_ACTIVE_PLUGIN')
      }
    })

    it('激活 ASR 插件后支持文件路径入参并返回规范化 TranscriptionResult', async () => {
      mockActiveModules['voice_asr'] = {
        id: 'asr_sensevoice_onnx',
        capability_slot: 'voice_asr',
        backend_type: 'omni_onnx'
      }

      mockTranscribeAudio.mockResolvedValueOnce({
        file_path: 'C:/test/sample.wav',
        transcript: '你好世界',
        events: [],
        language: 'zh',
        duration_ms: 1500
      })

      const res = await voiceSeamDispatcher.transcribe('C:/test/sample.wav', {
        language: 'zh'
      })

      expect(res).toEqual({
        text: '你好世界',
        language: 'zh',
        durationSec: 1.5,
        segments: undefined
      })
      expect(mockTranscribeAudio).toHaveBeenCalledWith(
        'C:/test/sample.wav',
        expect.objectContaining({ language: 'zh' })
      )
    })

    it('传入内存 Buffer 时安全创建临时文件、调用转录并在 finally 中删除临时文件', async () => {
      mockActiveModules['voice_asr'] = {
        id: 'asr_sensevoice_onnx',
        capability_slot: 'voice_asr',
        backend_type: 'omni_onnx'
      }

      let capturedTmpPath = ''
      mockTranscribeAudio.mockImplementationOnce(async (tmpPath: string) => {
        capturedTmpPath = tmpPath
        return {
          file_path: tmpPath,
          transcript: '内存转录测试',
          events: [],
          language: 'zh',
          duration_ms: 2000
        }
      })

      const audioBuffer = Buffer.from('RIFF....mock_audio_content')
      const res = await voiceSeamDispatcher.transcribe(audioBuffer)

      expect(res.text).toBe('内存转录测试')
      expect(capturedTmpPath).toContain('ff_asr_')
    })

    it('传入已 aborted 的 AbortSignal 时立即中止并抛出 ABORTED', async () => {
      mockActiveModules['voice_asr'] = {
        id: 'asr_sensevoice_onnx',
        capability_slot: 'voice_asr',
        backend_type: 'omni_onnx'
      }

      const controller = new AbortController()
      controller.abort()

      await expect(
        voiceSeamDispatcher.transcribe('C:/test/sample.wav', { signal: controller.signal })
      ).rejects.toThrow(VoiceSeamError)

      try {
        await voiceSeamDispatcher.transcribe('C:/test/sample.wav', { signal: controller.signal })
      } catch (err: any) {
        expect(err.code).toBe('ABORTED')
      }
    })
  })

  describe('synthesizeStream 与 synthesizeToWav (流式与整段合成)', () => {
    it('未激活 TTS 插件时抛出强类型 VoiceSeamError(NO_ACTIVE_PLUGIN)', async () => {
      const generator = voiceSeamDispatcher.synthesizeStream('测试文本')
      await expect(generator.next()).rejects.toThrow(VoiceSeamError)

      try {
        const gen2 = voiceSeamDispatcher.synthesizeStream('测试文本')
        await gen2.next()
      } catch (err: any) {
        expect(err.code).toBe('NO_ACTIVE_PLUGIN')
      }
    })

    it('激活 TTS 插件后流式输出纯 PCM 且 sampleRate 恒为 48000', async () => {
      mockActiveModules['voice_tts'] = {
        id: 'tts_moss_onnx',
        capability_slot: 'voice_tts',
        backend_type: 'omni_onnx'
      }

      // Mock Omni 分句返回 2 句
      mockSplitTTSChunks.mockResolvedValueOnce({
        chunks: ['第一句。', '第二句！'],
        totalChunks: 2,
        totalChars: 8
      })

      const rawPcm1 = new Uint8Array([1, 2, 3, 4])
      const rawPcm2 = new Uint8Array([5, 6, 7, 8])
      const wav1 = createWavFromPcm(rawPcm1, 48000, 1, 16)
      const wav2 = createWavFromPcm(rawPcm2, 48000, 1, 16)

      mockSynthesizeTTSChunk
        .mockResolvedValueOnce({ buffer: wav1, hitCap: false, steps: 100 })
        .mockResolvedValueOnce({ buffer: wav2, hitCap: false, steps: 120 })

      const chunks: any[] = []
      for await (const chunk of voiceSeamDispatcher.synthesizeStream('第一句。第二句！')) {
        chunks.push(chunk)
      }

      expect(chunks.length).toBe(2)

      expect(chunks[0].format).toBe('pcm_s16le')
      expect(chunks[0].sampleRate).toBe(48000)
      expect(chunks[0].channels).toBe(1)
      expect(chunks[0].data).toEqual(rawPcm1)
      expect(chunks[0].isLastChunk).toBe(false)

      expect(chunks[1].format).toBe('pcm_s16le')
      expect(chunks[1].sampleRate).toBe(48000)
      expect(chunks[1].channels).toBe(1)
      expect(chunks[1].data).toEqual(rawPcm2)
      expect(chunks[1].isLastChunk).toBe(true)
    })

    it('synthesizeToWav 拼合流式 PCM 并产出标准 WAV ArrayBuffer', async () => {
      mockActiveModules['voice_tts'] = {
        id: 'tts_moss_onnx',
        capability_slot: 'voice_tts',
        backend_type: 'omni_onnx'
      }

      mockSplitTTSChunks.mockResolvedValueOnce({
        chunks: ['整句。'],
        totalChunks: 1,
        totalChars: 3
      })

      const rawPcm = new Uint8Array([10, 20, 30, 40])
      const wav = createWavFromPcm(rawPcm, 48000, 1, 16)
      mockSynthesizeTTSChunk.mockResolvedValueOnce({ buffer: wav, hitCap: false, steps: 50 })

      const fullWav = await voiceSeamDispatcher.synthesizeToWav('整句。')
      expect(fullWav.byteLength).toBe(44 + 4)
      const recovered = stripWavHeader(fullWav)
      expect(recovered).toEqual(rawPcm)
    })
  })
})
